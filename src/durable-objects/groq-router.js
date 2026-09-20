// ═════════════════════════════════════════════════════════════════════════════
// GroqRouterDO — Durable Object for STRICT concurrency-safe Groq budget
// enforcement across 4 API keys.
// Extracted verbatim from worker-proxy.js (was lines 14222-14426).
//
// Wrangler requires Durable Object classes to be NAMED EXPORTS from the
// Worker entrypoint (worker-proxy.js). worker-proxy.js re-exports this
// class via `export { GroqRouterDO };` so that `class_name: "GroqRouterDO"`
// in wrangler.jsonc resolves correctly at deploy time.
//
// Behavior-preserving extraction: no logic, state, alarm, fetch, storage,
// routing, or response format changes. Only the file ownership has moved.
// ═════════════════════════════════════════════════════════════════════════════

class GroqRouterDO {
  constructor(state, env) {
    this.state = state;
    this.env = env;
    this._cache = new Map(); // in-memory cache (DO is single-threaded)
    this._loaded = false;
  }

  async _getKeyState(keyIndex) {
    if (this._cache.has(keyIndex)) return this._cache.get(keyIndex);
    const raw = await this.state.storage.get(`key${keyIndex}`);
    const defaults = {
      state: 'CLOSED',
      consecutive_failures: 0,
      retry_after: null,
      probe_failures: 0,
      last_failure_reason: null,
      quota_type: null,
      window_requests: [],
    };
    const result = raw ? { ...defaults, ...raw } : defaults;
    // Prune expired window timestamps
    const cutoff = Date.now() - (10 * 60 * 1000);
    if (Array.isArray(result.window_requests)) {
      result.window_requests = result.window_requests.filter(ts => ts > cutoff);
    } else {
      result.window_requests = [];
    }
    this._cache.set(keyIndex, result);
    return result;
  }

  async _setKeyState(keyIndex, stateObj) {
    this._cache.set(keyIndex, stateObj);
    await this.state.storage.put(`key${keyIndex}`, stateObj);
  }

  _selectBestKey(keyStates) {
    const now = Date.now();
    const WINDOW_MS = 10 * 60 * 1000;
    const MAX_PER_WINDOW = 3;
    const PROBE_LOCK_MS = 30 * 1000;

    const candidates = [];
    for (const [keyIndex, state] of keyStates) {
      let eligible = true;
      let reason = 'healthy';

      if (state.state === 'OPEN') {
        if (state.retry_after && now < state.retry_after) {
          eligible = false;
          reason = `cooldown_open (${Math.ceil((state.retry_after - now) / 1000)}s remaining)`;
        } else {
          // Cooldown expired → transition to HALF_OPEN (probe)
          state.state = 'HALF_OPEN';
          state._probe_locked_until = now + PROBE_LOCK_MS;
          candidates.push({ keyIndex, state, reason: 'half_open_probe' });
          continue;
        }
      } else if (state.state === 'HALF_OPEN') {
        if (state._probe_locked_until && now < state._probe_locked_until) {
          eligible = false;
          reason = 'probe_in_progress';
        } else {
          state._probe_locked_until = now + PROBE_LOCK_MS;
          candidates.push({ keyIndex, state, reason: 'half_open' });
          continue;
        }
      }

      if (eligible && state.window_requests.length >= MAX_PER_WINDOW) {
        eligible = false;
        reason = `window_limit (${state.window_requests.length}/${MAX_PER_WINDOW})`;
      }

      if (eligible) {
        candidates.push({ keyIndex, state, reason });
      }
    }

    if (candidates.length === 0) return null;

    // Sort by least-used (fewest window_requests), tie-break by lowest index
    candidates.sort((a, b) => {
      const wa = a.state.window_requests.length;
      const wb = b.state.window_requests.length;
      if (wa !== wb) return wa - wb;
      return a.keyIndex - b.keyIndex;
    });
    return candidates[0];
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action');

    if (action === 'reserve') {
      const body = await request.json();
      const keyIndices = body.keyIndices || [];

      // Load all key states
      const keyStates = new Map();
      for (const idx of keyIndices) {
        keyStates.set(idx, await this._getKeyState(idx));
      }

      // Select best key (STRICT — serialized by DO)
      const selected = this._selectBestKey(keyStates);
      if (!selected) {
        // Return all states for observability
        const states = [];
        for (const [idx, s] of keyStates) {
          states.push({
            index: idx, state: s.state,
            window_requests: s.window_requests.length,
            retry_after: s.retry_after,
            quota_type: s.quota_type,
          });
        }
        return Response.json({ keyIndex: null, reason: 'all_keys_unavailable', circuit_states: states });
      }

      // Record request in window (STRICT — serialized by DO)
      const state = selected.state;
      state.window_requests.push(Date.now());
      if (state.window_requests.length > 50) state.window_requests = state.window_requests.slice(-50);
      await this._setKeyState(selected.keyIndex, state);

      return Response.json({
        keyIndex: selected.keyIndex,
        reason: selected.reason,
        usage: state.window_requests.length,
      });
    }

    if (action === 'record') {
      const body = await request.json();
      const { keyIndex, success, groq_429_info, statusCode } = body;
      const state = await this._getKeyState(keyIndex);
      const now = Date.now();

      // Clear probe lock
      delete state._probe_locked_until;

      if (success) {
        state.state = 'CLOSED';
        state.consecutive_failures = 0;
        state.retry_after = null;
        state.probe_failures = 0;
        state.last_failure_reason = null;
        state.quota_type = null;
      } else if (statusCode === 429 && groq_429_info) {
        // 429 — OPEN circuit with fresh retry_after
        const cooldownMs = (groq_429_info.retry_after_seconds || 600) * 1000;
        state.state = 'OPEN';
        state.consecutive_failures = (state.consecutive_failures || 0) + 1;
        state.retry_after = now + cooldownMs;
        state.probe_failures = (state.probe_failures || 0) + 1;
        state.last_failure_reason = `http_429:${groq_429_info.quota_type}:${groq_429_info.retry_after_seconds}`;
        state.quota_type = groq_429_info.quota_type;
      } else {
        // Non-429 failure (5xx, network, timeout)
        const wasHalfOpen = state.state === 'HALF_OPEN';
        const newFailures = (state.consecutive_failures || 0) + 1;
        if (wasHalfOpen || newFailures >= 3) {
          state.state = 'OPEN';
          state.consecutive_failures = newFailures;
          state.retry_after = now + (10 * 60 * 1000);
          state.probe_failures = wasHalfOpen ? (state.probe_failures || 0) + 1 : 0;
          state.last_failure_reason = `http_${statusCode}`;
          state.quota_type = null;
        } else {
          state.state = 'CLOSED';
          state.consecutive_failures = newFailures;
          state.last_failure_reason = `http_${statusCode}`;
          state.quota_type = null;
        }
      }

      await this._setKeyState(keyIndex, state);
      return Response.json({ ok: true });
    }

    if (action === 'getStates') {
      const body = await request.json();
      const keyIndices = body.keyIndices || [];
      const states = [];
      for (const idx of keyIndices) {
        const s = await this._getKeyState(idx);
        states.push({
          index: idx, state: s.state,
          consecutive_failures: s.consecutive_failures,
          probe_failures: s.probe_failures || 0,
          window_requests: s.window_requests.length,
          retry_after: s.retry_after,
          quota_type: s.quota_type,
          last_failure_reason: s.last_failure_reason,
        });
      }
      return Response.json({ states });
    }

    return new Response('Unknown action', { status: 400 });
  }
}

export { GroqRouterDO };

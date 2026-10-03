/**
 * Session Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, validation,
 * session ID generation, and response building.
 *
 * KV data operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createSessionHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    getNumericEnv,
    normalizeOptionalString,
    sessionRepo,
  } = deps;

  // Per-isolate Worker cache for online count. FALLBACK-ONLY.
  //
  // This cache is WRITTEN on every successful heartbeat/online-count/end DO
  // call, but it is ONLY READ when the PresenceDO itself fails (see the
  // catch block in handleOnline) — it is NEVER used to short-circuit a
  // normal /api/online request. Previously it short-circuited /api/online,
  // but because each Cloudflare Worker isolate keeps its OWN module-level
  // cache, a heartbeat from User B on isolate #2 did not refresh isolate
  // #1's cache — so isolate #1 kept serving a stale count=1 for up to 30s
  // (the cache TTL), causing "online count stuck at 1 when multiple users
  // are online". Always querying the DO fixes this; DO `count` is an
  // in-memory Map.size so the extra subrequests are cheap.
  // MUST be `let` — handlers reassign it on every heartbeat/online/end.
  // (Previous `const` threw TypeError on reassignment → silent fall-through to KV,
  //  defeating the entire PresenceDO migration. See presence-do-verification-test.cjs P7.)
  let _onlineCountCache = { count: null, expiresAt: 0 };
  const ONLINE_COUNT_CACHE_TTL_MS = 30000; // 30s

  // PRESENCE_DO singleton name — all presence requests route to this single DO
  // instance (per worker environment). Using idFromName + get is the standard
  // Durable Object invocation pattern. Previously env.PRESENCE_DO.fetch() was
  // called directly which is INVALID on a DurableObjectNamespace (only stubs
  // returned by .get() have a .fetch method) → silent TypeError → KV fallback
  // ran on every request, defeating PresenceDO + snapshot persistence entirely.
  const PRESENCE_DO_NAME = 'presence-singleton';

  // Helper: call PresenceDO via the standard Durable Object invocation pattern.
  // Returns the parsed JSON body, or null on any failure (binding missing,
  // DO fetch throws, JSON parse fails). Caller must handle null by falling
  // back to the legacy KV path.
  async function _callPresenceDO(env, action, userId, ttl) {
    if (!env.PRESENCE_DO) return null;
    const params = new URLSearchParams({ action });
    if (userId) params.set('userId', userId);
    if (ttl) params.set('ttl', String(ttl));
    try {
      const id = env.PRESENCE_DO.idFromName(PRESENCE_DO_NAME);
      const stub = env.PRESENCE_DO.get(id);
      const doResponse = await stub.fetch(`https://presence-do/internal?${params}`);
      return await doResponse.json();
    } catch (e) {
      console.warn('[SESSIONS] PresenceDO call failed:', e?.message);
      return null;
    }
  }

  /**
   * POST /api/sessions/heartbeat — Register/refresh a user session.
   * Generates a session_id if not provided, updates KV, and returns online count.
   *
   * KV WRITE OPTIMIZATION: Previously did 3 KV writes per call (2 individual
   * session keys + 1 presence_state). Now only writes presence_state (1 write).
   * Individual session keys are not read by any other endpoint, so they're skipped.
   */
  async function handleHeartbeat(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!env.SESSION_CACHE && !env.PRESENCE_DO) {
      return jsonResponse(
        {
          status: 'error',
          message: 'SESSION_CACHE or PRESENCE_DO binding not configured',
        },
        { status: 503 }, env);
    }

    const url = new URL(request.url);
    const providedSessionId = normalizeOptionalString(url.searchParams.get('session_id'));
    const sessionId = providedSessionId || String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
    const userId = String(authState.user.id);
    const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
    const now = new Date();
    const lastSeen = now.toISOString();

    // PRESENCE DO PATH (primary — race-free)
    if (env.PRESENCE_DO) {
      try {
        const _rcaT0 = Date.now();
        const doResult = await _callPresenceDO(env, 'heartbeat', userId, ttlSeconds * 1000);
        // [PRESENCE-RCA] backend: heartbeat DO result
        try { console.log('[PRESENCE-RCA] backend:heartbeat', JSON.stringify({ ts: Date.now(), endpoint: 'heartbeat', do_success: !!(doResult && typeof doResult.online_count === 'number'), online_count: doResult?.online_count, dur_ms: Date.now() - _rcaT0, uid_tail: userId?.slice(-6) })); } catch (_) {}
        if (doResult && typeof doResult.online_count === 'number') {
          // Update Worker count cache
          _onlineCountCache = { count: doResult.online_count, expiresAt: Date.now() + ONLINE_COUNT_CACHE_TTL_MS };
          return jsonResponse({
            status: 'success',
            session_id: sessionId,
            last_seen: lastSeen,
            online_count: doResult.online_count,
          }, {}, env);
        }
      } catch (e) {
        // [PRESENCE-RCA] backend: heartbeat DO failure → KV fallback
        try { console.log('[PRESENCE-RCA] backend:heartbeat_do_fail', JSON.stringify({ ts: Date.now(), endpoint: 'heartbeat', err: String(e?.message || e).slice(0, 100), kv_fallback: true })); } catch (_) {}
        console.warn('[SESSIONS] PresenceDO heartbeat failed, falling back to KV:', e?.message);
      }
    }

    // KV FALLBACK (legacy — has race condition at scale but functional)
    // [PRESENCE-RCA] backend: heartbeat KV fallback executing
    try { console.log('[PRESENCE-RCA] backend:heartbeat_kv', JSON.stringify({ ts: Date.now(), endpoint: 'heartbeat', kv_namespace: 'SESSION_CACHE', op: 'read+write' })); } catch (_) {}
    const state = await sessionRepo.readPresenceState(env);
    sessionRepo.prunePresenceState(state, now.getTime());
    state[userId] = now.getTime() + ttlSeconds * 1000;
    await sessionRepo.persistPresenceState(env, state, ttlSeconds);

    return jsonResponse({
      status: 'success',
      session_id: sessionId,
      last_seen: lastSeen,
      online_count: Object.keys(state).length,
    }, {}, env);
  }

  /**
   * GET /api/sessions/online — Return the current online user count.
   *
   * KV WRITE OPTIMIZATION: Previously wrote presence_state on every GET.
   * Now only reads — no write needed for a count query.
   */
  async function handleOnline(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!env.SESSION_CACHE && !env.PRESENCE_DO) {
      return jsonResponse(
        {
          status: 'error',
          message: 'SESSION_CACHE or PRESENCE_DO binding not configured',
        },
        { status: 503 }, env);
    }

    // PRESENCE DO PATH (primary — race-free)
    if (env.PRESENCE_DO) {
      // ALWAYS query the DO directly for the freshest count.
      //
      // ROOT CAUSE FIX (online-count stuck at 1): the previous per-isolate
      // Worker cache (_onlineCountCache, 30s TTL) short-circuited /api/online
      // and returned a CACHED count without querying the DO. Because each
      // Cloudflare Worker isolate keeps its OWN module-level cache, a
      // heartbeat from User B landing on isolate #2 updated isolate #2's
      // cache but NOT isolate #1's — so isolate #1 kept serving a stale
      // count=1 (from User A's earlier heartbeat) for up to 30s, and the
      // frontend only refreshed the badge every 180s (heartbeat interval).
      // The net effect was "online count stuck at 1 when multiple users
      // are online".
      //
      // The cache is now WRITTEN on every successful DO query (and on
      // heartbeat/end) so a subsequent DO FAILURE on this isolate can fall
      // back to it, but it is NEVER used to short-circuit a normal
      // online-count request. DO `count` is an in-memory Map.size plus a
      // cheap O(n) lazy-prune (n = active sessions, typically <1000), so
      // the extra subrequests are not a performance concern — see the
      // multi-user regression test (tests/online-count-multi-user-test.cjs).
      const now = Date.now();
      let doResult = null;
      try {
        const _rcaT0 = Date.now();
        doResult = await _callPresenceDO(env, 'count');
        // [PRESENCE-RCA] backend: online DO result
        try { console.log('[PRESENCE-RCA] backend:online', JSON.stringify({ ts: Date.now(), endpoint: 'online', do_called: true, do_success: !!(doResult && typeof doResult.count === 'number'), returned_count: doResult?.count, dur_ms: Date.now() - _rcaT0 })); } catch (_) {}
      } catch (e) {
        // _callPresenceDO catches internally and returns null, so this is
        // only reached if an unexpected error escapes it. Log and treat as
        // a DO failure (fall through to the cache/KV fallback below).
        try { console.log('[PRESENCE-RCA] backend:online_do_fail', JSON.stringify({ ts: Date.now(), endpoint: 'online', err: String(e?.message || e).slice(0, 100) })); } catch (_) {}
      }
      if (doResult && typeof doResult.count === 'number') {
        // Refresh the per-isolate cache with the FRESH DO count so a
        // subsequent DO failure on this isolate can fall back to it.
        // count=0 is NOT cached (preserves the existing zero-protection:
        // a transient 0 doesn't lock out the KV fallback or get re-served).
        if (doResult.count > 0) {
          _onlineCountCache = { count: doResult.count, expiresAt: now + ONLINE_COUNT_CACHE_TTL_MS };
        }
        return jsonResponse({
          status: 'success',
          count: doResult.count,
        }, {}, env);
      }
      // DO failed or returned a malformed result → best-effort fallback to
      // the per-isolate cache (last-known-good count from a prior successful
      // heartbeat/online query on THIS isolate) before the legacy KV path.
      // This is the ONLY read path for _onlineCountCache now: per-isolate
      // divergence here is acceptable (no source is authoritative during a
      // DO outage, and a stale last-known-good is better than nothing).
      if (_onlineCountCache.count !== null && _onlineCountCache.count > 0) {
        return jsonResponse({ status: 'success', count: _onlineCountCache.count }, {}, env);
      }
      // No usable cache → fall through to KV fallback below.
      console.warn('[SESSIONS] PresenceDO count failed (or returned no count), falling back to KV');
    }

    // KV FALLBACK (legacy — read-only, no write)
    // [PRESENCE-RCA] backend: online KV fallback executing
    try { console.log('[PRESENCE-RCA] backend:online_kv', JSON.stringify({ ts: Date.now(), endpoint: 'online', kv_namespace: 'SESSION_CACHE', op: 'read' })); } catch (_) {}
    const nowMs = Date.now();
    const state = await sessionRepo.readPresenceState(env);
    sessionRepo.prunePresenceState(state, nowMs);

    return jsonResponse({
      status: 'success',
      count: Object.keys(state).length,
    }, {}, env);
  }

  /**
   * POST /api/sessions/end — End the authenticated user's session.
   * Removes KV entries and updates the online count.
   */
  async function handleEnd(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!env.SESSION_CACHE && !env.PRESENCE_DO) {
      return jsonResponse(
        {
          status: 'error',
          message: 'SESSION_CACHE or PRESENCE_DO binding not configured',
        },
        { status: 503 }, env);
    }

    const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
    const userId = String(authState.user.id);

    // PRESENCE DO PATH (primary — race-free)
    if (env.PRESENCE_DO) {
      try {
        const doResult = await _callPresenceDO(env, 'end', userId);
        if (doResult && typeof doResult.online_count === 'number') {
          // Invalidate Worker count cache
          _onlineCountCache = { count: doResult.online_count, expiresAt: Date.now() + ONLINE_COUNT_CACHE_TTL_MS };
          return jsonResponse({
            status: 'success',
            online_count: doResult.online_count,
          }, {}, env);
        }
      } catch (e) {
        console.warn('[SESSIONS] PresenceDO end failed, falling back to KV:', e?.message);
      }
    }

    // KV FALLBACK (legacy)
    await sessionRepo.deleteSession(env, userId);

    const nowMs = Date.now();
    const state = await sessionRepo.readPresenceState(env);
    sessionRepo.prunePresenceState(state, nowMs);
    delete state[userId];
    await sessionRepo.persistPresenceState(env, state, ttlSeconds);

    return jsonResponse({
      status: 'success',
      online_count: Object.keys(state).length,
    }, {}, env);
  }

  return Object.freeze({ handleHeartbeat, handleOnline, handleEnd });
}
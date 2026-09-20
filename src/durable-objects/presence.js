// ═════════════════════════════════════════════════════════════════════════════
// PresenceDO — Durable Object for online-member presence tracking.
// Extracted verbatim from worker-proxy.js (was lines 14063-14196).
//
// Wrangler requires Durable Object classes to be NAMED EXPORTS from the
// Worker entrypoint (worker-proxy.js). worker-proxy.js re-exports this
// class via `export { PresenceDO };` so that `class_name: "PresenceDO"`
// in wrangler.jsonc resolves correctly at deploy time.
//
// Behavior-preserving extraction: no logic, state, alarm, fetch, storage,
// or response format changes. Only the file ownership has moved.
// ═════════════════════════════════════════════════════════════════════════════

class PresenceDO {
  constructor(state, env) {
    this.state = state;
    this.sessions = new Map(); // userId → expiresAtMs
    this._alarmSet = false;
    // Hydration state for snapshot persistence. On DO eviction/restart the
    // in-memory Map is lost. _ensureHydrated() reads the last snapshot from
    // storage (written by alarm()) so sessions survive eviction and the
    // online count does NOT drop to 0 until sessions actually expire.
    this._hydrated = false;
    this._hydratePromise = null;
  }

  // ── Hydration: restore sessions from storage snapshot ──
  // Uses Promise memoization so concurrent fetch() calls hydrate only once.
  // On storage failure, degrades gracefully to an empty Map (memory-only).
  async _ensureHydrated() {
    if (this._hydrated) return;
    if (!this._hydratePromise) {
      this._hydratePromise = (async () => {
        try {
          const snapshot = await this.state.storage.get('sessions_snapshot');
          if (snapshot && Array.isArray(snapshot)) {
            const now = Date.now();
            let restored = 0;
            for (const [userId, expiresAt] of snapshot) {
              // Filter out already-expired entries during hydration
              if (expiresAt > now) {
                this.sessions.set(userId, expiresAt);
                restored++;
              }
            }
            if (restored > 0) {
              console.log(`[PresenceDO] hydrated ${restored} session(s) from snapshot`);
            }
          }
        } catch {
          // Storage read failure → degrade to memory-only (empty Map)
        }
        this._hydrated = true;
      })();
    }
    await this._hydratePromise;
  }

  async fetch(request) {
    const url = new URL(request.url);
    const action = url.searchParams.get('action') || '';
    const userId = url.searchParams.get('userId') || '';
    const ttl = Number(url.searchParams.get('ttl')) || 240000; // default 240s
    const now = Date.now();

    // Hydrate from storage snapshot before any session access (eviction recovery)
    await this._ensureHydrated();

    // Ensure alarm is set (idempotent)
    if (!this._alarmSet) {
      try {
        const existing = await this.state.storage.getAlarm();
        if (!existing) {
          await this.state.storage.setAlarm(now + 60000);
        }
        this._alarmSet = true;
      } catch {}
    }

    if (action === 'heartbeat') {
      if (!userId) return Response.json({ error: 'userId required' }, { status: 400 });
      const _rcaBefore = this.sessions.size;
      this.sessions.set(userId, now + ttl);
      // [PRESENCE-RCA] DO: heartbeat
      try { console.log('[PRESENCE-RCA] do:heartbeat', JSON.stringify({ ts: now, action: 'heartbeat', uid_tail: userId?.slice(-6), sessions_before: _rcaBefore, sessions_after: this.sessions.size, returned_count: this.sessions.size })); } catch (_) {}
      return Response.json({ online_count: this.sessions.size });
    }

    if (action === 'end') {
      if (!userId) return Response.json({ error: 'userId required' }, { status: 400 });
      this.sessions.delete(userId);
      return Response.json({ online_count: this.sessions.size });
    }

    if (action === 'count') {
      // Lazy prune: remove expired entries (in case alarm didn't fire recently)
      // Only check entries that are definitely expired (cheap O(n) but n is small)
      const _rcaBeforePrune = this.sessions.size;
      let pruned = 0;
      for (const [uid, expiresAt] of this.sessions) {
        if (expiresAt <= now) {
          this.sessions.delete(uid);
          pruned++;
        }
      }
      const count = this.sessions.size;
      // [PRESENCE-RCA] DO: count
      try { console.log('[PRESENCE-RCA] do:count', JSON.stringify({ ts: now, action: 'count', sessions_before_prune: _rcaBeforePrune, expired_sessions: pruned, sessions_after_prune: count, returned_count: count })); } catch (_) {}
      // RCA-ONLINE-COUNT: minimal diagnostic — log only when count is 0 AND
      // we pruned something this call (indicates session-expiry path), so we
      // can correlate with frontend 1→0 reports without logging every request.
      if (count === 0 && pruned > 0) {
        console.log(`[PresenceDO] count=0 after pruning ${pruned} expired session(s)`);
      }
      return Response.json({ count });
    }

    return Response.json({ error: 'unknown action' }, { status: 404 });
  }

  async alarm() {
    const now = Date.now();
    // Hydrate before pruning in case alarm fires before any fetch on a fresh DO
    await this._ensureHydrated();
    const before = this.sessions.size;
    // Full prune: remove all expired entries
    for (const [userId, expiresAt] of this.sessions) {
      if (expiresAt <= now) {
        this.sessions.delete(userId);
      }
    }
    const after = this.sessions.size;
    // Snapshot: persist current sessions to storage for eviction recovery.
    // Always write — the write is cheap (single key, small array) and the
    // "skip if unchanged" optimization added complexity (and a bug) for
    // minimal benefit. The snapshot reflects the post-prune state.
    try {
      await this.state.storage.put('sessions_snapshot', Array.from(this.sessions.entries()));
    } catch {
      // Storage write failure → snapshot not updated, old snapshot used on next eviction
    }
    // Reschedule alarm for 60s
    try {
      await this.state.storage.setAlarm(now + 60000);
    } catch {}
  }
}

export { PresenceDO };

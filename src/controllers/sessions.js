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

  // Worker-level cache for online count (reduces DO requests by ~95%)
  // MUST be `let` — handlers reassign it on every heartbeat/online-cache-miss/end.
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

  // ============================================================================
  // [RCA-INSTRUMENTATION] Temporary diagnostic logging for Online Count 1→0 RCA.
  // PURPOSE: Capture which path produces count=0 (DO real 0 vs KV-empty fallback)
  //   so we can correlate with frontend badge updates during the next 1→0 jump.
  // PRIVACY: userId reduced to 4-char suffix (no raw PII). No tokens, no init data.
  // REMOVAL: Search for "RCA-INSTRUMENTATION" and remove all marked blocks once
  //   root cause is confirmed. These logs only fire on error/zero paths — zero
  //   cost on the normal success path.
  // ============================================================================
  function _redactUid(userId) {
    if (!userId) return null;
    const uid = String(userId);
    return uid.length > 4 ? '…' + uid.slice(-4) : uid;
  }

  function _rcaLog(event, fields) {
    try {
      console.log(JSON.stringify({
        event,
        ts: new Date().toISOString(),
        ...fields,
      }));
    } catch { /* non-fatal — diagnostics must never break request */ }
  }

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
      // RCA-INSTRUMENTATION: capture DO call errors (exception or unparseable)
      _rcaLog('presence_do_call_error', {
        operation: action,
        errorClass: e?.constructor?.name || 'Error',
        errorMessage: String(e?.message || '').slice(0, 120),
        uid: _redactUid(userId),
      });
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
        const doResult = await _callPresenceDO(env, 'heartbeat', userId, ttlSeconds * 1000);
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
        console.warn('[SESSIONS] PresenceDO heartbeat failed, falling back to KV:', e?.message);
      }
    }

    // RCA-INSTRUMENTATION: heartbeat reached KV fallback (DO returned null or threw).
    // This is the path suspected of causing count=0 on subsequent online-count queries
    // when KV is empty (because the DO path normally succeeds and never writes to KV).
    _rcaLog('presence_heartbeat_do_fallback', {
      uid: _redactUid(userId),
      fallback: 'KV',
      reason: 'do_null_or_throw',
    });

    // KV FALLBACK (legacy — has race condition at scale but functional)
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
      // Check Worker cache first (30s TTL — reduces DO requests by ~95%).
      // NOTE: count=0 is NOT cached — a transient 0 (from a stale DO isolate
      // or a race between session-expiry and heartbeat) would otherwise be
      // served for up to 30s, causing the visible 1→0 jump. By invalidating
      // the cache on 0, the next online-count request always re-queries the
      // DO and picks up the freshest value. The cost is one extra DO call
      // only when count is genuinely 0, which is rare (single-user or empty).
      const now = Date.now();
      if (_onlineCountCache.count !== null && _onlineCountCache.count > 0 && now < _onlineCountCache.expiresAt) {
        return jsonResponse({
          status: 'success',
          count: _onlineCountCache.count,
        }, {}, env);
      }
      // Cache miss, expired, or cached-0 (re-verify) → query DO
      try {
        const doResult = await _callPresenceDO(env, 'count');
        if (doResult && typeof doResult.count === 'number') {
          // RCA-INSTRUMENTATION: DO returned count=0 (real zero from DO).
          // This distinguishes "DO genuinely has no sessions" from "KV fallback
          // returned 0 because KV is empty". Only logs on count=0.
          if (doResult.count === 0) {
            _rcaLog('presence_online_do_zero', {
              count: 0,
              source: 'DO',
            });
          }
          // Only cache non-zero counts. A 0 is returned to the caller but
          // NOT stored in the cache, so the next request re-queries the DO.
          if (doResult.count > 0) {
            _onlineCountCache = { count: doResult.count, expiresAt: now + ONLINE_COUNT_CACHE_TTL_MS };
          }
          return jsonResponse({
            status: 'success',
            count: doResult.count,
          }, {}, env);
        }
      } catch (e) {
        // DO failed — return cached value if available and non-zero, else fall through to KV
        if (_onlineCountCache.count !== null && _onlineCountCache.count > 0) {
          return jsonResponse({ status: 'success', count: _onlineCountCache.count }, {}, env);
        }
        console.warn('[SESSIONS] PresenceDO count failed, falling back to KV:', e?.message);
      }
    }

    // RCA-INSTRUMENTATION: handleOnline reached KV fallback (DO returned null or threw,
    // AND no cached non-zero value was available). This is the prime suspect for the
    // 1→0 jump: if KV is empty (because DO path normally succeeds and never writes to
    // KV), the KV state object is {} → count=0.

    // KV FALLBACK (legacy — read-only, no write)
    const nowMs = Date.now();
    const state = await sessionRepo.readPresenceState(env);
    sessionRepo.prunePresenceState(state, nowMs);
    const _kvCount = Object.keys(state).length;

    // RCA-INSTRUMENTATION: log the KV fallback outcome with the actual count
    _rcaLog('presence_online_do_fallback', {
      fallback: 'KV',
      kvCount: _kvCount,
      kvEmpty: _kvCount === 0,
    });

    return jsonResponse({
      status: 'success',
      count: _kvCount,
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
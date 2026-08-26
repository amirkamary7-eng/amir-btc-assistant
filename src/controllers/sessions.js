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

  // Helper: call PresenceDO
  async function _callPresenceDO(env, action, userId, ttl) {
    if (!env.PRESENCE_DO) return null;
    const params = new URLSearchParams({ action });
    if (userId) params.set('userId', userId);
    if (ttl) params.set('ttl', String(ttl));
    try {
      const doResponse = await env.PRESENCE_DO.fetch(`https://presence-do/internal?${params}`);
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
      // Check Worker cache first (30s TTL — reduces DO requests by ~95%)
      const now = Date.now();
      if (_onlineCountCache.count !== null && now < _onlineCountCache.expiresAt) {
        return jsonResponse({
          status: 'success',
          count: _onlineCountCache.count,
        }, {}, env);
      }
      // Cache miss → query DO
      try {
        const doResult = await _callPresenceDO(env, 'count');
        if (doResult && typeof doResult.count === 'number') {
          _onlineCountCache = { count: doResult.count, expiresAt: now + ONLINE_COUNT_CACHE_TTL_MS };
          return jsonResponse({
            status: 'success',
            count: doResult.count,
          }, {}, env);
        }
      } catch (e) {
        // DO failed — return cached value if available, else fall through to KV
        if (_onlineCountCache.count !== null) {
          return jsonResponse({ status: 'success', count: _onlineCountCache.count }, {}, env);
        }
        console.warn('[SESSIONS] PresenceDO count failed, falling back to KV:', e?.message);
      }
    }

    // KV FALLBACK (legacy — read-only, no write)
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
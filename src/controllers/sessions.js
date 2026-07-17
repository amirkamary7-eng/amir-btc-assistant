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

  /**
   * POST /api/sessions/heartbeat — Register/refresh a user session.
   * Generates a session_id if not provided, updates KV, and returns online count.
   */
  async function handleHeartbeat(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!env.SESSION_CACHE) {
      return jsonResponse(
        {
          status: 'error',
          message: 'SESSION_CACHE binding not configured',
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
    const nowMs = now.getTime();

    await sessionRepo.writeHeartbeat(env, userId, sessionId, lastSeen, ttlSeconds);

    const state = await sessionRepo.readPresenceState(env);
    sessionRepo.prunePresenceState(state, nowMs);
    state[userId] = nowMs + ttlSeconds * 1000;
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
   */
  async function handleOnline(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!env.SESSION_CACHE) {
      return jsonResponse(
        {
          status: 'error',
          message: 'SESSION_CACHE binding not configured',
        },
        { status: 503 }, env);
    }

    const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
    const nowMs = Date.now();
    const state = await sessionRepo.readPresenceState(env);
    sessionRepo.prunePresenceState(state, nowMs);
    await sessionRepo.persistPresenceState(env, state, ttlSeconds);

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

    if (!env.SESSION_CACHE) {
      return jsonResponse(
        {
          status: 'error',
          message: 'SESSION_CACHE binding not configured',
        },
        { status: 503 }, env);
    }

    const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
    const nowMs = Date.now();
    const userId = String(authState.user.id);

    await sessionRepo.deleteSession(env, userId);

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
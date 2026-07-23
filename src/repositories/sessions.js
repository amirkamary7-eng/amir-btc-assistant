/**
 * Session Repository — Data Access Layer (KV Cache)
 *
 * Responsible ONLY for KV cache operations related to user sessions
 * and presence tracking. No HTTP concerns, no business logic.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createSessionRepository(deps) {
  const { readSessionCache, writeSessionCache, deleteSessionCache } = deps;

  const PRESENCE_STATE_KEY = 'session:presence_state';
  const KEY_PREFIX = 'session:';

  /**
   * Read the shared presence-state object from KV.
   * Returns a plain object { userId: expiresAtMs, ... } or {}.
   */
  async function readPresenceState(env) {
    const raw = await readSessionCache(env, PRESENCE_STATE_KEY);
    if (!raw) {
      return {};
    }
    try {
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
        return {};
      }
      return parsed;
    } catch {
      return {};
    }
  }

  /**
   * Remove expired entries from the presence-state object (mutates in place).
   */
  function prunePresenceState(state, nowMs) {
    for (const [userId, expiresAt] of Object.entries(state)) {
      if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
        delete state[userId];
      }
    }
  }

  /**
   * Persist the shared presence-state object to KV.
   */
  async function persistPresenceState(env, state, ttlSeconds) {
    await writeSessionCache(env, PRESENCE_STATE_KEY, JSON.stringify(state), ttlSeconds * 2);
  }

  /**
   * Write (or refresh) an individual user's session entry and last-seen timestamp.
   */
  async function writeHeartbeat(env, userId, sessionId, lastSeen, ttlSeconds) {
    await Promise.all([
      writeSessionCache(env, `${KEY_PREFIX}${userId}`, sessionId, ttlSeconds),
      writeSessionCache(env, `${KEY_PREFIX}${userId}:seen`, lastSeen, ttlSeconds),
    ]);
  }

  /**
   * Delete an individual user's session entries.
   */
  async function deleteSession(env, userId) {
    await Promise.all([
      deleteSessionCache(env, `${KEY_PREFIX}${userId}`),
      deleteSessionCache(env, `${KEY_PREFIX}${userId}:seen`),
    ]);
  }

  /**
   * Read an individual user's session ID from KV.
   */
  async function readSessionId(env, userId) {
    return readSessionCache(env, `${KEY_PREFIX}${userId}`);
  }

  return Object.freeze({
    readPresenceState,
    prunePresenceState,
    persistPresenceState,
    writeHeartbeat,
    deleteSession,
    readSessionId,
  });
}
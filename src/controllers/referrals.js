/**
 * Referral Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, validation, and response building.
 * Database operations are fully delegated to the repository.
 * All reward credits go through walletRepo.creditTokens() — never direct SQL.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createReferralHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    referralRepo,
  } = deps;

  /**
   * GET /api/referrals/stats — Aggregated referral stats for the authenticated user.
   */
  async function handleStats(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', total: 0, active: 0, rewarded: 0, pending: 0, flagged: 0, reversed: 0, reward_per_invite: 3 }, {}, env);
    }
    try {
      const stats = await referralRepo.getStats(env, authState.user.id);
      return jsonResponse({ status: 'success', ...stats }, {}, env);
    } catch (error) {
      console.warn(safeError('get-referral-stats', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/referrals/history — Paginated referral history with full details.
   * Query params: offset (default 0), limit (default 20).
   */
  async function handleHistory(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', total: 0, offset: 0, limit: 20, hasMore: false, referrals: [] }, {}, env);
    }
    try {
      const url = new URL(request.url);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const result = await referralRepo.getHistory(env, authState.user.id, offset, limit);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('get-referral-history', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/referrals/leaderboard — Top referrers.
   * Query params: limit (default 50, max 100).
   */
  async function handleLeaderboard(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', leaderboard: [] }, {}, env);
    }
    try {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '50', 10), 100);
      const result = await referralRepo.getLeaderboard(env, limit);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('get-referral-leaderboard', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({
    handleStats,
    handleHistory,
    handleLeaderboard,
  });
}

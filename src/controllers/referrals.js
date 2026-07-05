/**
 * Referral Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, validation, and response building.
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createReferralHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    isDatabaseConfigured,
    referralRepo,
  } = deps;

  /**
   * GET /api/referrals/stats — Return aggregated referral stats for the authenticated user.
   * Returns zeroed defaults when the database is not configured.
   */
  async function handleStats(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', total: 0, active: 0, rewarded: 0, tokens: 0 }, env);
    }
    try {
      const stats = await referralRepo.getStats(env, authState.user.id);
      return jsonResponse({ status: 'success', ...stats }, env);
    } catch (error) {
      console.warn('get referral stats failed:', error);
      return safeDbErrorResponse(error, env);
    }
  }

  /**
   * GET /api/referrals/tokens — Return token balance and transaction history.
   * Returns empty defaults when the database is not configured.
   */
  async function handleTokens(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', balance: 0, history: [] }, env);
    }
    try {
      const tokenState = await referralRepo.getTokens(env, authState.user.id);
      return jsonResponse({ status: 'success', ...tokenState }, env);
    } catch (error) {
      console.warn('get referral tokens failed:', error);
      return safeDbErrorResponse(error, env);
    }
  }

  return Object.freeze({ handleStats, handleTokens });
}
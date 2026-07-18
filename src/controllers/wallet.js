/**
 * Wallet Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, validation, and response building.
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createWalletHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    walletRepo,
  } = deps;

  /**
   * GET /api/wallet — Full wallet state: balance, tier, recent transactions.
   */
  async function handleGetWallet(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'success', balance: 0, tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 }, history: [] },
        {}, env,
      );
    }
    try {
      const walletState = await walletRepo.getWalletState(env, authState.user.id);
      return jsonResponse({ status: 'success', ...walletState }, {}, env);
    } catch (error) {
      console.warn(safeError('get-wallet', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/history — Paginated transaction history.
   * Query params: offset (default 0), limit (default 20).
   */
  async function handleGetHistory(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', total: 0, offset: 0, limit: 20, hasMore: false, transactions: [] }, {}, env);
    }
    try {
      const url = new URL(request.url);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const result = await walletRepo.getTransactionHistory(env, authState.user.id, offset, limit);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('get-wallet-history', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/claim — Get daily claim status.
   */
  async function handleGetClaimStatus(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', claimed_today: false, daily_reward: 10 }, {}, env);
    }
    try {
      const claimed = await walletRepo.getDailyClaimStatus(env, authState.user.id);
      return jsonResponse({ status: 'success', claimed_today: claimed, daily_reward: 10 }, {}, env);
    } catch (error) {
      console.warn(safeError('get-claim-status', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/wallet/claim — Claim daily reward.
   */
  async function handleClaimDaily(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }
    try {
      const DAILY_REWARD = 10;
      const result = await walletRepo.claimDailyReward(env, authState.user.id, DAILY_REWARD);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      if (error.code === 'ALREADY_CLAIMED') {
        return jsonResponse({ status: 'error', message: 'Already claimed today', code: 'ALREADY_CLAIMED' }, { status: 409 }, env);
      }
      console.warn(safeError('claim-daily', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/referral-stats — Referral stats for wallet page.
   */
  async function handleReferralStats(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', invited: 0, active: 0, earned: 0, total_rewards: 0 }, {}, env);
    }
    try {
      const stats = await walletRepo.getReferralStats(env, authState.user.id);
      return jsonResponse({ status: 'success', ...stats }, {}, env);
    } catch (error) {
      console.warn(safeError('wallet-referral-stats', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({
    handleGetWallet,
    handleGetHistory,
    handleGetClaimStatus,
    handleClaimDaily,
    handleReferralStats,
  });
}
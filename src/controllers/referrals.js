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
    // PREMIUM-DISPLAY FIX: MembershipAuthority + EntitlementConfig for tier-based
    // display of reward_per_invite. The ACTUAL crediting logic in
    // worker-proxy.js processPendingReferralReward already uses these same
    // helpers; this wiring only makes the DISPLAYED reward_per_invite match the
    // amount the inviter actually receives (base 3 for Free, 6 for Premium).
    membershipAuthority,
    entitlementConfig,
  } = deps;

  /**
   * PREMIUM-DISPLAY FIX: Safe tier check via MembershipAuthority.
   * Fail-safe: returns false (Normal) on any error — same pattern as the
   * wallet controller. A user is never accidentally shown Premium display on
   * authority lookup failure.
   */
  async function _isPremiumSafe(env, userId) {
    if (!membershipAuthority) return false;
    try {
      return await membershipAuthority.isPremium(env, String(userId));
    } catch (e) {
      return false;
    }
  }

  /**
   * PREMIUM-DISPLAY FIX: Return the EFFECTIVE referral reward-per-invite for
   * display. Uses the SAME canonical helper (getReferralRewardAmount) that
   * processPendingReferralReward in worker-proxy.js uses when actually
   * crediting the reward, so the displayed amount always matches the credited
   * amount.
   *   Free    → 3 AB
   *   Premium → 6 AB
   * (values from entitlement_config.js — single source of truth).
   */
  function _getEffectiveReferralReward(isPremium) {
    if (entitlementConfig && typeof entitlementConfig.getReferralRewardAmount === 'function') {
      return entitlementConfig.getReferralRewardAmount(isPremium);
    }
    return 3; // Legacy fallback (Normal)
  }

  /**
   * GET /api/referrals/stats — Aggregated referral stats for the authenticated user.
   */
  async function handleStats(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    // PREMIUM-DISPLAY FIX: compute the inviter's effective reward-per-invite
    // (base for Free, doubled for Premium) so the frontend displays exactly
    // the amount the inviter receives when an invitee joins. Uses the same
    // canonical helper (getReferralRewardAmount) as the actual crediting path.
    const isPremium = await _isPremiumSafe(env, authState.user.id);
    const rewardPerInvite = _getEffectiveReferralReward(isPremium);
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', total: 0, active: 0, rewarded: 0, pending: 0, flagged: 0, reversed: 0, reward_per_invite: rewardPerInvite }, {}, env);
    }
    try {
      const stats = await referralRepo.getStats(env, authState.user.id);
      // PREMIUM-DISPLAY FIX: override the base DB value (from
      // referral_reward_tiers) with the effective tier-based amount. The base
      // value in the DB is the Normal-tier amount; the effective amount
      // reflects the inviter's actual tier.
      stats.reward_per_invite = rewardPerInvite;
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

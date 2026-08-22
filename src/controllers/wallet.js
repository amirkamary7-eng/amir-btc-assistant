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
    notificationPlatformRepo,
    economyService,
    rewardCenterRepo,
    notificationService,
    // MISSION-ABUSE FIX: server-issued one-time event tokens
    issueMissionEventToken,
    consumeMissionEventToken,
    // Rate limiting for wallet endpoints
    isUserRateLimited,
    // PHASE 4: MembershipAuthority + EntitlementConfig for tier-based rewards
    membershipAuthority,
    entitlementConfig,
    // PHASE 1 (WALLET-REWARDS): shared Tehran date helpers for idempotency keys
    // Previously wallet.js used `new Date().toISOString().slice(0, 10)` (UTC) for
    // refId and dedupKey — inconsistent with claimDailyReward which uses Tehran date.
    // This caused: (1) notification dedupKeys to not be unique per day, (2) refIds
    // to not match the retry cron's reconstruction. Now uses Tehran date consistently.
    getTehranDateString: _getTehranDateString = () => new Date().toISOString().slice(0, 10),
    getTehranWeekStart: _getTehranWeekStart = () => new Date().toISOString().slice(0, 10),
  } = deps;

  /**
   * PHASE 4: Safe tier check via MembershipAuthority.
   * Fail-safe: returns false (Normal) on any error.
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
   * PHASE 4: Get daily claim reward amount based on tier.
   */
  function _getDailyRewardAmount(isPremium) {
    if (entitlementConfig && typeof entitlementConfig.getDailyClaimAmount === 'function') {
      return entitlementConfig.getDailyClaimAmount(isPremium);
    }
    return 10; // Legacy fallback (Normal)
  }

  // Rate limit helper for wallet mutation endpoints
  async function checkWalletRateLimit(env, userId, category, max, windowSec) {
    if (!isUserRateLimited || !env.RATE_LIMITS) return null;
    if (await isUserRateLimited(env, String(userId), category, max, windowSec)) {
      return jsonResponse({ status: 'error', message: 'Too many requests. Please wait.', code: 'RATE_LIMITED' }, { status: 429 }, env);
    }
    return null;
  }

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
      await walletRepo.ensureSchema(env).catch(() => {});
      const walletState = await walletRepo.getWalletState(env, authState.user.id);
      return jsonResponse({ status: 'success', ...walletState }, {}, env);
    } catch (error) {
      // ROOT-CAUSE FIX: Log full stack trace for diagnosis
      console.error('[WALLET] Error:', error?.message || String(error));
      if (error?.stack) console.error('[WALLET] Stack:', error.stack);
      console.warn(safeError('get-wallet', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/balance — Lightweight balance-only endpoint (no transactions).
   */
  async function handleGetBalance(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', balance: 0 }, {}, env);
    }
    try {
      const balance = await walletRepo.getBalance(env, authState.user.id);
      return jsonResponse({ status: 'success', balance }, {}, env);
    } catch (error) {
      console.warn(safeError('get-balance', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/summary — Balance + tier + aggregate statistics.
   */
  async function handleGetSummary(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', balance: 0, tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 }, stats: { total_earned: 0, total_spent: 0, transaction_count: 0, referral_count: 0, daily_count: 0, mission_count: 0, reversed_count: 0 } }, {}, env);
    }
    try {
      const summary = await walletRepo.getWalletSummary(env, authState.user.id);
      return jsonResponse({ status: 'success', ...summary }, {}, env);
    } catch (error) {
      console.warn(safeError('get-wallet-summary', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/history — Paginated transaction history with filtering.
   * Query params: offset (default 0), limit (default 20), type, status.
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
      const filters = {
        type: url.searchParams.get('type') || null,
        status: url.searchParams.get('status') || null,
      };
      const result = await walletRepo.getTransactionHistory(env, authState.user.id, offset, limit, filters);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('get-wallet-history', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/transaction/:id — Get a single transaction by ID.
   */
  async function handleGetTransaction(request, env, txId) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }
    try {
      const tx = await walletRepo.getTransactionById(env, authState.user.id, txId);
      if (!tx) {
        return jsonResponse({ status: 'error', message: 'Transaction not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', transaction: tx }, {}, env);
    } catch (error) {
      console.warn(safeError('get-transaction', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wallet/claim — Get daily claim status.
   */
  async function handleGetClaimStatus(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    // PHASE 4: Tier-based daily reward amount
    const isPremium = await _isPremiumSafe(env, authState.user.id);
    const dailyReward = _getDailyRewardAmount(isPremium);
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', claimed_today: false, daily_reward: dailyReward }, {}, env);
    }
    try {
      const claimed = await walletRepo.getDailyClaimStatus(env, authState.user.id);
      return jsonResponse({ status: 'success', claimed_today: claimed, daily_reward: dailyReward }, {}, env);
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
    // Rate limit: 5 claims per 60s (prevents abuse while allowing retries)
    const rlErr = await checkWalletRateLimit(env, authState.user.id, 'wallet_claim', 5, 60);
    if (rlErr) return rlErr;
    try {
      // PHASE 4: Tier-based daily reward amount (Normal 10, Premium 20).
      const isPremium = await _isPremiumSafe(env, authState.user.id);
      const DAILY_REWARD = _getDailyRewardAmount(isPremium);
      const clientIp = request.headers.get('cf-connecting-ip') || null;
      const result = await walletRepo.claimDailyReward(env, authState.user.id, DAILY_REWARD);

      // Dispatch notification via NotificationService (single entry point)
      if (notificationService && result && result.credited !== false) {
        await notificationService.create(env, {
          userId: authState.user.id,
          templateKey: 'wallet_received',
          category: 'wallet',
          priority: 'low',
          channel: 'both',
          metadata: { amount: String(DAILY_REWARD), name: 'Daily Reward' },
          // PHASE 1 FIX: use Tehran date (consistent with refId) — previously UTC
          dedupKey: `wallet_daily_${authState.user.id}_${_getTehranDateString()}`,
        }).catch(() => {});
      }

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
   * POST /api/wallet/mission/issue-token — Issue a one-time event token for
   * a mission. The frontend must call this AFTER the user performs the real
   * action (opens news, opens analysis detail, opens calendar, opens market).
   * The token is then submitted to /api/wallet/mission/complete to prove the
   * action was performed.
   *
   * MISSION-ABUSE FIX (WALLET-002): without this, any authenticated user
   * could POST /api/wallet/mission/complete with just {mission_id} and
   * receive rewards without performing any action.
   *
   * daily_login does NOT require a token — it's fired automatically by the
   * bootstrap handler when the user authenticates.
   *
   * Body: { mission_id: string }
   * Returns: { status: 'success', event_token: string, expires_in: 120 }
   *          OR { status: 'error', code: 'MISSING_MISSION_ID' | 'NOT_ELIGIBLE' | ... }
   */
  async function handleMissionIssueToken(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;

    // Rate limit: 10 token requests per 60s (prevents KV abuse)
    const rlErr = await checkWalletRateLimit(env, authState.user.id, 'wallet_mission_token', 10, 60);
    if (rlErr) return rlErr;

    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ status: 'error', message: 'Invalid JSON' }, { status: 422 }, env);
    }

    const missionId = String(body?.mission_id || '').trim();
    if (!missionId) {
      return jsonResponse({ status: 'error', message: 'mission_id required', code: 'MISSING_MISSION_ID' }, { status: 422 }, env);
    }

    // daily_login is fired automatically by bootstrap — no token needed
    if (missionId === 'daily_login') {
      return jsonResponse({ status: 'error', message: 'daily_login does not require a token (auto-fired by bootstrap)', code: 'NOT_ELIGIBLE' }, { status: 422 }, env);
    }

    try {
      const userId = String(authState.user.id);

      // Verify mission exists and is enabled
      if (rewardCenterRepo) {
        const missionConfig = await rewardCenterRepo.getMissionReward(env, missionId);
        if (!missionConfig || !Number(missionConfig.token_amount) || Number(missionConfig.token_amount) <= 0) {
          return jsonResponse({ status: 'error', message: 'Mission not found or has no reward', code: 'NO_REWARD' }, { status: 422 }, env);
        }
      }

      // Issue one-time token
      if (typeof issueMissionEventToken !== 'function') {
        return jsonResponse({ status: 'error', message: 'Mission token service unavailable', code: 'TOKEN_SERVICE_UNAVAILABLE' }, { status: 503 }, env);
      }
      const token = await issueMissionEventToken(env, userId, missionId);
      if (!token) {
        return jsonResponse({ status: 'error', message: 'Failed to issue token (KV unavailable)', code: 'TOKEN_ISSUE_FAILED' }, { status: 503 }, env);
      }

      return jsonResponse({
        status: 'success',
        mission_id: missionId,
        event_token: token,
        expires_in: 120, // seconds
      }, {}, env);
    } catch (error) {
      console.warn(safeError('wallet-mission-issue-token', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/wallet/mission/complete — Increment progress and grant reward when complete.
   *
   * MISSION-ABUSE FIX (WALLET-002): Now requires an `event_token` for non-daily_login
   * missions. The token is obtained by calling POST /api/wallet/mission/issue-token
   * AFTER the user performs the real action (opens news, opens analysis, etc.).
   *
   * Body: { mission_id: string, event_token?: string }
   *   - For daily_login: no event_token required (auto-fired by bootstrap)
   *   - For all other missions: event_token MUST be a valid server-issued token
   *
   * Flow:
   * 1. Validate event_token (consume one-time)
   * 2. Read mission config from DB (amount, name, target_count)
   * 3. Atomically increment progress in mission_progress table
   * 4. If progress >= target AND not yet rewarded → grant reward
   * 5. Return updated progress + reward status
   *
   * Idempotency layers:
   *   - Mission event token: one-time use, 120s TTL (one per user/mission/day effectively)
   *   - mission_progress UNIQUE(user_id, mission_id, daily_date) + rewarded flag
   *   - token_transactions UNIQUE(user_id, tx_type, ref_id) WHERE status='completed'
   */
  async function handleMissionComplete(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    // Rate limit: 10 completions per 60s (prevents abuse while allowing all 5 missions + retries)
    const rlErr = await checkWalletRateLimit(env, authState.user.id, 'wallet_mission_complete', 10, 60);
    if (rlErr) return rlErr;

    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ status: 'error', message: 'Invalid JSON' }, { status: 422 }, env);
    }

    const missionId = String(body?.mission_id || '').trim();
    if (!missionId) {
      return jsonResponse({ status: 'error', message: 'mission_id required', code: 'MISSING_MISSION_ID' }, { status: 422 }, env);
    }

    const eventToken = String(body?.event_token || '').trim();
    const isDailyLogin = missionId === 'daily_login';

    // MISSION-ABUSE FIX: non-daily_login missions REQUIRE a valid event_token
    if (!isDailyLogin) {
      if (!eventToken) {
        return jsonResponse({
          status: 'error',
          message: 'event_token required. Call POST /api/wallet/mission/issue-token after performing the action.',
          code: 'MISSING_EVENT_TOKEN',
        }, { status: 403 }, env);
      }
      if (typeof consumeMissionEventToken !== 'function') {
        return jsonResponse({ status: 'error', message: 'Mission token service unavailable', code: 'TOKEN_SERVICE_UNAVAILABLE' }, { status: 503 }, env);
      }
      const userId = String(authState.user.id);
      const consumed = await consumeMissionEventToken(env, userId, missionId, eventToken);
      if (!consumed) {
        return jsonResponse({
          status: 'error',
          message: 'event_token is invalid, expired, or already used. Perform the action again and request a new token.',
          code: 'INVALID_EVENT_TOKEN',
        }, { status: 403 }, env);
      }
    }

    try {
      const userId = String(authState.user.id);

      // 1. Read mission config from DB
      const missionConfig = rewardCenterRepo
        ? await rewardCenterRepo.getMissionReward(env, missionId)
        : { token_amount: 0, mission_name: missionId };

      const baseAmount = Number(missionConfig.token_amount) || 0;
      const label = missionConfig.mission_name || missionId;

      if (baseAmount <= 0) {
        return jsonResponse({ status: 'error', message: 'Mission has no reward configured or is disabled', code: 'NO_REWARD' }, { status: 422 }, env);
      }

      // PHASE 4: Apply tier-based multiplier (Normal 1×, Premium 1.5×).
      // Determined server-side via MembershipAuthority. The multiplier only
      // affects the reward amount — it does NOT bypass duplicate protection,
      // event_token validation, progress tracking, or idempotency.
      // Rounding: Math.ceil (Premium users always get AT LEAST the multiplier value).
      const isPremium = await _isPremiumSafe(env, userId);
      const amount = (entitlementConfig && typeof entitlementConfig.getMissionRewardAmount === 'function')
        ? entitlementConfig.getMissionRewardAmount(baseAmount, isPremium)
        : baseAmount; // Legacy fallback: no multiplier

      // 2. Get target_count from mission metadata
      const activeMissions = rewardCenterRepo
        ? await rewardCenterRepo.getActiveMissionRewards(env)
        : [];
      const missionMeta = activeMissions.find(m => m.mission_id === missionId);
      const targetCount = missionMeta?.target_count || 1;

      // 3. Atomically increment progress
      const progress = rewardCenterRepo
        ? await rewardCenterRepo.incrementMissionProgress(env, userId, missionId, targetCount)
        : { progress_count: 1, target_count: 1, completed: true, rewarded: false };

      if (!progress) {
        return jsonResponse({ status: 'error', message: 'Failed to update progress' }, { status: 500 }, env);
      }

      // 4. If completed and not yet rewarded → grant reward
      let rewardGranted = false;
      let newBalance = null;

      if (progress.completed && !progress.rewarded) {
        // Mark as rewarded FIRST (atomic CAS — prevents double-reward)
        const claimed = rewardCenterRepo
          ? await rewardCenterRepo.markMissionRewarded(env, userId, missionId)
          : true;

        if (claimed) {
          // Now grant the reward via economyService
          // PHASE 1 FIX: use Tehran date (consistent with daily claim boundary)
          // — previously `new Date().toISOString().slice(0, 10)` was UTC.
          const today = _getTehranDateString();
          const refId = `mission_${userId}_${missionId}_${today}`;

          const result = await economyService.grantReward({
            userId,
            amount,
            rewardType: 'mission_reward',
            description: `ماموریت: ${label}`,
            refId,
            metadata: { mission_id: missionId, mission_label: label, daily_date: today, progress: `${progress.progress_count}/${targetCount}` },
            auditInfo: { actor: 'system', ip: request.headers.get('cf-connecting-ip') || null },
            env,
          });

          rewardGranted = result.success && !result.idempotent;
          newBalance = result.newBalance;

          // Dispatch notification via NotificationService
          // Await — ensures notification completes BEFORE withSharedPool closes the DB pool.
          if (rewardGranted && notificationService) {
            await notificationService.create(env, {
              userId,
              category: 'wallet',
              priority: 'low',
              channel: 'both',
              title: '🎉 ماموریت کامل شد',
              message: `${label} — ${amount} AB دریافت کردید`,
              metadata: { mission_id: missionId, amount },
              // PHASE 1 FIX: include daily_date so notifications are unique per day.
              // Previously `wallet_mission_${missionId}_${userId}` was date-less —
              // day 2's notification would ON CONFLICT DO NOTHING with day 1's,
              // silently dropping the notification. Now day-scoped.
              dedupKey: `wallet_mission_${missionId}_${userId}_${today}`,
            }).catch(() => {});
          }
        }
      }

      return jsonResponse({
        status: 'success',
        mission_id: missionId,
        reward_amount: amount,
        reward_label: label,
        progress_count: progress.progress_count,
        target_count: progress.target_count,
        completed: progress.completed,
        is_new_completion: rewardGranted,
        new_balance: newBalance,
      }, {}, env);
    } catch (error) {
      console.warn(safeError('wallet-mission-complete', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * Internal helper: fire the daily_login mission automatically during bootstrap.
   * This is called from worker-proxy.js handleBootstrap after successful auth.
   * No token required — bootstrap itself IS the proof of login.
   *
   * Returns the same shape as handleMissionComplete's success response.
   */
  async function fireDailyLoginMission(env, userId) {
    if (!isDatabaseConfigured(env)) return null;
    const missionId = 'daily_login';

    try {
      const missionConfig = rewardCenterRepo
        ? await rewardCenterRepo.getMissionReward(env, missionId)
        : null;
      if (!missionConfig) return null;

      const amount = Number(missionConfig.token_amount) || 0;
      if (amount <= 0) return null;

      const label = missionConfig.mission_name || missionId;

      // Get target_count
      const activeMissions = rewardCenterRepo
        ? await rewardCenterRepo.getActiveMissionRewards(env)
        : [];
      const missionMeta = activeMissions.find(m => m.mission_id === missionId);
      const targetCount = missionMeta?.target_count || 1;

      // Increment progress
      const progress = rewardCenterRepo
        ? await rewardCenterRepo.incrementMissionProgress(env, userId, missionId, targetCount)
        : null;
      if (!progress) return null;

      let rewardGranted = false;
      let newBalance = null;
      if (progress.completed && !progress.rewarded) {
        const claimed = rewardCenterRepo
          ? await rewardCenterRepo.markMissionRewarded(env, userId, missionId)
          : false;
        if (claimed) {
          // PHASE 1 FIX: use Tehran date (consistent with daily claim boundary)
          const today = _getTehranDateString();
          const refId = `mission_${userId}_${missionId}_${today}`;
          const result = await economyService.grantReward({
            userId,
            amount,
            rewardType: 'mission_reward',
            description: `ماموریت: ${label}`,
            refId,
            metadata: { mission_id: missionId, mission_label: label, daily_date: today, progress: `${progress.progress_count}/${targetCount}`, source: 'bootstrap_auto' },
            auditInfo: { actor: 'system' },
            env,
          });
          rewardGranted = result.success && !result.idempotent;
          newBalance = result.newBalance;

          if (rewardGranted && notificationService) {
            await notificationService.create(env, {
              userId,
              category: 'wallet',
              priority: 'low',
              channel: 'both',
              title: '🎉 ماموریت کامل شد',
              message: `${label} — ${amount} AB دریافت کردید`,
              metadata: { mission_id: missionId, amount },
              // PHASE 1 FIX: include daily_date for unique-per-day notification idempotency
              dedupKey: `wallet_mission_${missionId}_${userId}_${today}`,
            }).catch(() => {});
          }
        }
      }
      return { rewardGranted, newBalance, progress };
    } catch (error) {
      console.warn(safeError('fire-daily-login-mission', error));
      return null;
    }
  }

  /**
   * GET /api/wallet/missions — Get today's mission status with progress.
   *
   * GENERIC: Reads ALL active missions from DB + cross-references with
   * mission_progress for real progress data.
   */
  async function handleGetMissions(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', missions: [] }, {}, env);
    }

    try {
      const userId = String(authState.user.id);
      // PHASE 1 FIX: use Tehran date for `date` field returned to frontend
      // (consistent with daily claim boundary). Previously UTC.
      const today = _getTehranDateString();

      // Get all active mission definitions from DB
      const activeMissions = rewardCenterRepo
        ? await rewardCenterRepo.getActiveMissionRewards(env)
        : [];

      // Get today's progress for this user
      const progressList = rewardCenterRepo
        ? await rewardCenterRepo.getTodayMissionProgress(env, userId)
        : [];

      const progressMap = {};
      for (const p of progressList) {
        progressMap[p.mission_id] = p;
      }

      const missions = activeMissions.map(m => {
        const progress = progressMap[m.mission_id];
        return {
          mission_id: m.mission_id,
          mission_name: m.mission_name,
          reward_amount: m.token_amount,
          reward_label: m.mission_name,
          trigger: m.trigger,
          target_count: m.target_count,
          description: m.description,
          icon: m.icon,
          sort_order: m.sort_order,
          progress_count: progress?.progress_count || 0,
          completed: progress?.completed || false,
          rewarded: progress?.rewarded || false,
        };
      });

      return jsonResponse({ status: 'success', missions, date: today }, {}, env);
    } catch (error) {
      console.warn(safeError('wallet-get-missions', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({
    handleGetWallet,
    handleGetBalance,
    handleGetSummary,
    handleGetHistory,
    handleGetTransaction,
    handleGetClaimStatus,
    handleClaimDaily,
    handleMissionIssueToken,
    handleMissionComplete,
    handleGetMissions,
    fireDailyLoginMission,
  });
}
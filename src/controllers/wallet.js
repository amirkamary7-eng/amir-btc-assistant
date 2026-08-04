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
      const clientIp = request.headers.get('cf-connecting-ip') || null;
      const result = await walletRepo.claimDailyReward(env, authState.user.id, DAILY_REWARD);

      // Dispatch notification via NotificationService (single entry point)
      if (notificationService && result && result.credited !== false) {
        await notificationService.create(env, {
          userId: authState.user.id,
          templateKey: 'wallet_received',
          category: 'wallet',
          priority: 'low',
          channel: 'mini_app',
          metadata: { amount: String(DAILY_REWARD), name: 'Daily Reward' },
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

  /**
   * POST /api/wallet/mission/complete — Increment progress and grant reward when complete.
   *
   * Body: { mission_id: string }
   *
   * GENERIC: Mission definitions (including target_count for multi-step) are read
   * from the `mission_rewards` DB table via metadata.target_count.
   *
   * Flow:
   * 1. Read mission config from DB (amount, name, target_count)
   * 2. Atomically increment progress in mission_progress table
   * 3. If progress >= target AND not yet rewarded → grant reward
   * 4. Return updated progress + reward status
   *
   * Idempotent: UNIQUE(user_id, mission_id, daily_date) + rewarded flag + creditTokens UNIQUE
   */
  async function handleMissionComplete(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    let body;
    try { body = await request.json(); } catch {
      return jsonResponse({ status: 'error', message: 'Invalid JSON' }, { status: 422 }, env);
    }

    const missionId = String(body?.mission_id || '').trim();
    if (!missionId) {
      return jsonResponse({ status: 'error', message: 'mission_id required', code: 'MISSING_MISSION_ID' }, { status: 422 }, env);
    }

    try {
      const userId = String(authState.user.id);

      // 1. Read mission config from DB
      const missionConfig = rewardCenterRepo
        ? await rewardCenterRepo.getMissionReward(env, missionId)
        : { token_amount: 0, mission_name: missionId };

      const amount = Number(missionConfig.token_amount) || 0;
      const label = missionConfig.mission_name || missionId;

      if (amount <= 0) {
        return jsonResponse({ status: 'error', message: 'Mission has no reward configured or is disabled', code: 'NO_REWARD' }, { status: 422 }, env);
      }

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
          const today = new Date().toISOString().slice(0, 10);
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
          if (rewardGranted && notificationService) {
            notificationService.create(env, {
              userId,
              category: 'wallet',
              priority: 'low',
              channel: 'mini_app',
              title: '🎉 ماموریت کامل شد',
              message: `${label} — ${amount} AB دریافت کردید`,
              metadata: { mission_id: missionId, amount },
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
      const today = new Date().toISOString().slice(0, 10);

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
    handleReferralStats,
    handleMissionComplete,
    handleGetMissions,
  });
}
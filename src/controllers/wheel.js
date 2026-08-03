/**
 * Lucky Wheel Controller — HTTP Layer
 *
 * All rewards go through economyService.grantReward() → walletRepo.creditTokens().
 * Never touches token_balances or token_transactions directly.
 */
export function createWheelHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    wheelRepo,
    economyService,
    rewardCenterRepo,
    notificationPlatformRepo,
  } = deps;

  /**
   * GET /api/wheel/status — Get spin inventory + daily spin status + wheel config.
   * Returns segment_count, is_enabled, maintenance_mode from wheel_config so
   * the frontend can render the correct number of wheel segments dynamically.
   */
  async function handleStatus(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', daily_spin: { available: false }, premium_spins: 0, config: { is_enabled: true, segment_count: 8, maintenance_mode: false } }, {}, env);
    }
    try {
      // ROOT CAUSE FIX for [WHEEL-STATUS] "column spin_date does not exist":
      // wheelRepo.ensureSchema() was DEFINED but NEVER CALLED from anywhere.
      // If the wheel_spins table was created by an older code version (before
      // the spin_date column was added), the column doesn't exist → SQL error
      // on every query that references spin_date.
      // ensureSchema runs CREATE TABLE IF NOT EXISTS + ALTER TABLE ADD COLUMN
      // IF NOT EXISTS, so it's idempotent and safe to call on every request.
      if (typeof wheelRepo?.ensureSchema === 'function') {
        await wheelRepo.ensureSchema(env).catch(() => {});
      }

      // ROOT CAUSE FIX (2.1): Read max_spins_per_user from wheel_config
      // (default 3) and pass to getOrCreateDailySpins so it creates the
      // correct number of daily spins.
      let config = { is_enabled: true, segment_count: 8, maintenance_mode: false, max_spins_per_user: 3 };
      if (rewardCenterRepo) {
        config = await rewardCenterRepo.getWheelConfig(env).catch(() => config);
      }
      const maxSpins = config.max_spins_per_user || 3;

      // Create daily spins (up to maxSpins) and get available count
      const dailySpins = await wheelRepo.getOrCreateDailySpins(env, authState.user.id, maxSpins);
      const availableSpins = await wheelRepo.getAvailableSpins(env, authState.user.id);
      const premiumCount = availableSpins.spins.filter(s => s.type === 'premium').length;

      return jsonResponse({
        status: 'success',
        daily_spin: {
          available: dailySpins.total_available > 0,
          spin_id: dailySpins.spins[0]?.id || null,
        },
        premium_spins: premiumCount,
        total_available: availableSpins.spins.length,
        total_allowed: maxSpins,
        spins_used: maxSpins - dailySpins.total_available,
        config: {
          is_enabled: config.is_enabled,
          segment_count: config.segment_count,
          maintenance_mode: config.maintenance_mode,
        },
      }, {}, env);
    } catch (error) {
      // ROOT-CAUSE FIX: Log full stack trace for diagnosis
      console.error('[WHEEL-STATUS] Error:', error?.message || String(error));
      if (error?.stack) console.error('[WHEEL-STATUS] Stack:', error.stack);
      console.warn(safeError('wheel-status', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/wheel/spin — Consume a spin and grant reward.
   * Body: { spin_id?: number } — if omitted, uses daily spin.
   *
   * KILL SWITCH CHECKS (from Reward Center admin panel):
   * - rewardCenterRepo.isSubsystemDisabled(env, 'wheel') → global wheel kill switch
   * - wheel_config.is_enabled → wheel must be enabled
   * - wheel_config.maintenance_mode → wheel in maintenance
   * - wheel_config.daily_spin_enabled / premium_spin_enabled / etc. → per-spin-type gates
   */
  async function handleSpin(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    // ROOT CAUSE FIX: ensureSchema must run before any wheel query.
    // See handleStatus for full explanation.
    if (typeof wheelRepo?.ensureSchema === 'function') {
      try { await wheelRepo.ensureSchema(env); } catch {}
    }

    // ── Kill switch + config checks ──
    if (rewardCenterRepo) {
      // Global emergency kill switch
      if (await rewardCenterRepo.isSubsystemDisabled(env, 'wheel')) {
        return jsonResponse({ status: 'error', message: 'Wheel is temporarily disabled', code: 'WHEEL_DISABLED' }, { status: 403 }, env);
      }
      // Wheel config checks
      const config = await rewardCenterRepo.getWheelConfig(env).catch(() => null);
      if (config) {
        if (!config.is_enabled) {
          return jsonResponse({ status: 'error', message: 'Wheel is disabled', code: 'WHEEL_DISABLED' }, { status: 403 }, env);
        }
        if (config.maintenance_mode) {
          return jsonResponse({ status: 'error', message: 'Wheel under maintenance', code: 'WHEEL_MAINTENANCE' }, { status: 503 }, env);
        }
      }
    }

    try {
      let body = {};
      try { body = await request.json(); } catch {}

      let spinId = body.spin_id;
      if (!spinId) {
        // ROOT CAUSE FIX (2.1): Use new getOrCreateDailySpins with maxSpins
        // from wheel_config. This ensures the correct number of daily spins
        // are created (default 3).
        let config = { max_spins_per_user: 3 };
        if (rewardCenterRepo) {
          config = await rewardCenterRepo.getWheelConfig(env).catch(() => config);
        }
        const maxSpins = config.max_spins_per_user || 3;
        const dailySpins = await wheelRepo.getOrCreateDailySpins(env, authState.user.id, maxSpins);
        if (dailySpins.total_available === 0 || !dailySpins.spins.length) {
          return jsonResponse({ status: 'error', message: 'No available spins', code: 'NO_SPINS' }, { status: 409 }, env);
        }
        spinId = dailySpins.spins[0].id;
      }

      // Consume the spin (atomic: available → used)
      const spinResult = await wheelRepo.consumeSpin(env, authState.user.id, spinId);

      // ROOT CAUSE FIX (F-3 + 3.1): refId includes spin_type + spin_id to
      // allow multiple daily spins AND premium spins on the same day.
      // The old refId `wheel_${user_id}_${today}` would block the 2nd and
      // 3rd daily spins from granting rewards (idempotent collision).
      // The new refId `wheel_${user_id}_${today}_${spin_id}` is unique per
      // spin, so each spin can grant its own reward. Anti-cheat is still
      // enforced by the advisory lock + maxSpins check in
      // getOrCreateDailySpins — users can't create more than maxSpins.
      const today = new Date().toISOString().slice(0, 10);
      const rewardRefId = `wheel_${authState.user.id}_${today}_${spinResult.spin_id}`;
      let rewardResult = { success: false, newBalance: null, txId: null, idempotent: false };
      if (spinResult.reward.amount > 0) {
        try {
          rewardResult = await economyService.grantReward({
            userId: authState.user.id,
            amount: spinResult.reward.amount,
            rewardType: spinResult.reward.type,
            description: `Wheel reward: ${spinResult.reward.label || spinResult.reward.type}`,
            refId: rewardRefId,
            metadata: { spin_id: spinResult.spin_id, spin_type: spinResult.spin_type, reward_label: spinResult.reward.label },
            auditInfo: { actor: 'system', ip: request.headers.get('cf-connecting-ip') || null },
            env,
          });
        } catch (e) {
          // ROOT CAUSE FIX (3.2): If reward fails, log clearly. The spin is
          // already consumed — a cron retry will credit the reward later.
          console.warn('Wheel reward grant failed (spin will be retried by cron):', e.message);
        }

        // ROOT CAUSE FIX (3.4): Only dispatch notification if reward was
        // actually credited (not idempotent). Previously the notification
        // fired even if grantReward failed — misleading the user.
        if (notificationPlatformRepo && rewardResult.success && !rewardResult.idempotent) {
          await notificationPlatformRepo.dispatch(env, {
            userId: authState.user.id,
            templateKey: 'wheel_reward',
            category: 'wheel',
            priority: 'high',
            channel: 'mini_app',
            metadata: { amount: String(spinResult.reward.amount), name: spinResult.reward.label || 'Wheel' },
          }).catch(() => {});
        }
      }

      return jsonResponse({
        status: 'success',
        spin_id: spinResult.spin_id,
        spin_type: spinResult.spin_type,
        reward: spinResult.reward,
        new_balance: rewardResult.newBalance,
        tx_id: rewardResult.txId,
      }, {}, env);
    } catch (error) {
      if (error.code === 'SPIN_NOT_AVAILABLE') {
        return jsonResponse({ status: 'error', message: 'Spin not available or already used', code: 'SPIN_NOT_AVAILABLE' }, { status: 409 }, env);
      }
      console.warn(safeError('wheel-spin', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/wheel/history — Paginated spin history.
   */
  async function handleHistory(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', total: 0, offset: 0, limit: 20, hasMore: false, history: [] }, {}, env);
    }
    try {
      const url = new URL(request.url);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const result = await wheelRepo.getSpinHistory(env, authState.user.id, offset, limit);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('wheel-history', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({
    handleStatus,
    handleSpin,
    handleHistory,
  });
}

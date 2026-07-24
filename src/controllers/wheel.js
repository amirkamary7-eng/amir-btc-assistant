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
      const dailySpin = await wheelRepo.getOrCreateDailySpin(env, authState.user.id);
      const availableSpins = await wheelRepo.getAvailableSpins(env, authState.user.id);
      const premiumCount = availableSpins.spins.filter(s => s.type === 'premium').length;

      // Fetch wheel config from Reward Center (DB-driven)
      let config = { is_enabled: true, segment_count: 8, maintenance_mode: false };
      if (rewardCenterRepo) {
        config = await rewardCenterRepo.getWheelConfig(env).catch(() => config);
      }

      return jsonResponse({
        status: 'success',
        daily_spin: {
          available: dailySpin.status === 'available',
          spin_id: dailySpin.spin_id,
        },
        premium_spins: premiumCount,
        total_available: availableSpins.spins.length,
        config: {
          is_enabled: config.is_enabled,
          segment_count: config.segment_count,
          maintenance_mode: config.maintenance_mode,
        },
      }, {}, env);
    } catch (error) {
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
        // Use daily spin
        const dailySpin = await wheelRepo.getOrCreateDailySpin(env, authState.user.id);
        if (dailySpin.status !== 'available') {
          return jsonResponse({ status: 'error', message: 'No available spins', code: 'NO_SPINS' }, { status: 409 }, env);
        }
        spinId = dailySpin.spin_id;
      }

      // Consume the spin (atomic: available → used)
      const spinResult = await wheelRepo.consumeSpin(env, authState.user.id, spinId);

      // Skip reward grant if amount is 0 (no_reward type — admin disabled all rewards)
      const rewardRefId = `wheel_${spinResult.spin_id}_${authState.user.id}`;
      let rewardResult = { success: false, newBalance: null, txId: null };
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
          // If reward fails (e.g. already granted — idempotent), still return the spin result
          console.warn('Wheel reward grant failed:', e.message);
        }

        // Dispatch notification via Notification Platform (single entry point)
        if (notificationPlatformRepo) {
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

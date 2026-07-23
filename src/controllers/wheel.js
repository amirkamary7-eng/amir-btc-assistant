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
  } = deps;

  /**
   * GET /api/wheel/status — Get spin inventory + daily spin status.
   */
  async function handleStatus(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', daily_spin: { available: false }, premium_spins: 0 }, {}, env);
    }
    try {
      const dailySpin = await wheelRepo.getOrCreateDailySpin(env, authState.user.id);
      const availableSpins = await wheelRepo.getAvailableSpins(env, authState.user.id);
      const premiumCount = availableSpins.spins.filter(s => s.type === 'premium').length;

      return jsonResponse({
        status: 'success',
        daily_spin: {
          available: dailySpin.status === 'available',
          spin_id: dailySpin.spin_id,
        },
        premium_spins: premiumCount,
        total_available: availableSpins.spins.length,
      }, {}, env);
    } catch (error) {
      console.warn(safeError('wheel-status', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/wheel/spin — Consume a spin and grant reward.
   * Body: { spin_id?: number } — if omitted, uses daily spin.
   */
  async function handleSpin(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
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

      // Grant reward via Economy Layer (Reward Engine)
      const rewardRefId = `wheel_${spinResult.spin_id}_${authState.user.id}`;
      let rewardResult;
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
        rewardResult = { success: false, newBalance: null, txId: null };
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

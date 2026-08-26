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
    notificationService,
    // PHASE 3: MembershipAuthority + EntitlementConfig for tier-based daily spins.
    membershipAuthority,
    entitlementConfig,
  } = deps;

  /**
   * PHASE 3: Get the effective max daily spins for a user based on tier.
   * Normal = 3, Premium = 5. Fail-safe: Normal on any error.
   */
  async function _getEffectiveMaxSpins(env, userId) {
    let isPremium = false;
    if (membershipAuthority) {
      try { isPremium = await membershipAuthority.isPremium(env, userId); } catch { isPremium = false; }
    }
    if (entitlementConfig) {
      return isPremium ? entitlementConfig.wheel.premium_daily_spins : entitlementConfig.wheel.normal_daily_spins;
    }
    return 3; // Legacy fallback
  }

  /**
   * GET /api/wheel/status — Get spin inventory + daily spin status + wheel config.
   * Returns segment_count, is_enabled, maintenance_mode from wheel_config so
   * the frontend can render the correct number of wheel segments dynamically.
   *
   * TEMPORARY DIAGNOSTIC: When called with ?diag=1, returns step-by-step
   * diagnostic info instead of the normal response. This is to identify the
   * exact root cause of 503 errors. Remove after diagnosis is complete.
   */
  async function handleStatus(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;

    // Check for diagnostic mode (?diag=1)
    const url = new URL(request.url);
    const isDiag = url.searchParams.get('diag') === '1';

    if (!isDatabaseConfigured(env)) {
      if (isDiag) {
        return jsonResponse({ status: 'diagnostic', steps: [
          { step: 'auth', ok: true, user_id: String(authState.user.id) },
          { step: 'isDatabaseConfigured', ok: false, detail: 'No DATABASE_URL/DIRECT_URL/HYPERDRIVE' },
        ], final_status: 'error', failed_step: 'isDatabaseConfigured' }, {}, env);
      }
      return jsonResponse({ status: 'success', daily_spin: { available: false }, premium_spins: 0, config: { is_enabled: true, segment_count: 8, maintenance_mode: false } }, {}, env);
    }

    if (!isDiag) {
      // ═══ NORMAL PATH (unchanged) ═══
      try {
        if (typeof wheelRepo?.ensureSchema === 'function') {
          await wheelRepo.ensureSchema(env).catch(() => {});
        }

        let config = { is_enabled: true, segment_count: 8, maintenance_mode: false, max_spins_per_user: 3 };
        if (rewardCenterRepo) {
          config = await rewardCenterRepo.getWheelConfig(env).catch(() => config);
        }
        const maxSpins = await _getEffectiveMaxSpins(env, authState.user.id);

        const dailySpins = await wheelRepo.getOrCreateDailySpins(env, authState.user.id, maxSpins);
        const availableSpins = await wheelRepo.getAvailableSpins(env, authState.user.id);
        const premiumCount = availableSpins.spins.filter(s => s.type === 'premium').length;

        let nextResetAt = null;
        if (typeof wheelRepo.getNextTehranMidnightISO === 'function') {
          try { nextResetAt = wheelRepo.getNextTehranMidnightISO(); } catch {}
        }

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
          next_reset_at: nextResetAt,
          config: {
            is_enabled: config.is_enabled,
            segment_count: config.segment_count,
            maintenance_mode: config.maintenance_mode,
          },
        }, {}, env);
      } catch (error) {
        console.error('[WHEEL-STATUS] Error:', error?.message || String(error));
        if (error?.stack) console.error('[WHEEL-STATUS] Stack:', error.stack);
        console.warn(safeError('wheel-status', error));
        return safeDbErrorResponse(error, {}, env);
      }
    }

    // ═══ DIAGNOSTIC PATH (?diag=1) ═══
    // Runs each step individually, catching errors per-step.
    // Returns structured diagnostic info. No sensitive data (no SQL, no tokens,
    // no stack traces). Uses safeError() for error sanitization.
    const steps = [];
    let failedStep = null;

    function _extractPgError(e) {
      // Extract non-sensitive PostgreSQL error metadata
      const info = { error_type: e?.name || 'Error' };
      if (e?.code) info.sql_state = String(e.code);
      if (e?.constraint) info.constraint = String(e.constraint);
      // Sanitize message via safeError (strips connection strings, tokens, etc.)
      try {
        const sanitized = safeError('diag', e);
        if (sanitized?.message) info.message = String(sanitized.message).slice(0, 200);
      } catch {
        info.message = String(e?.message || '').slice(0, 200);
      }
      return info;
    }

    // Step 1: auth (already passed — record it)
    steps.push({ step: 'auth', ok: true, duration_ms: 0, user_id: String(authState.user.id) });

    // Step 2: isDatabaseConfigured (already passed — record it)
    steps.push({ step: 'isDatabaseConfigured', ok: true, duration_ms: 0 });

    // Step 3: wheelRepo.ensureSchema
    {
      const t0 = Date.now();
      try {
        if (typeof wheelRepo?.ensureSchema === 'function') {
          await wheelRepo.ensureSchema(env);
        }
        steps.push({ step: 'wheel_ensureSchema', ok: true, duration_ms: Date.now() - t0 });
      } catch (e) {
        const errInfo = _extractPgError(e);
        steps.push({ step: 'wheel_ensureSchema', ok: false, duration_ms: Date.now() - t0, ...errInfo });
        failedStep = 'wheel_ensureSchema';
      }
    }

    // Step 4: rewardCenterRepo.ensureSchema (via getWheelConfig which calls ensureSchema)
    {
      const t0 = Date.now();
      try {
        if (rewardCenterRepo && typeof rewardCenterRepo.ensureSchema === 'function') {
          await rewardCenterRepo.ensureSchema(env);
        }
        steps.push({ step: 'rewardCenter_ensureSchema', ok: true, duration_ms: Date.now() - t0 });
      } catch (e) {
        const errInfo = _extractPgError(e);
        steps.push({ step: 'rewardCenter_ensureSchema', ok: false, duration_ms: Date.now() - t0, ...errInfo });
        if (!failedStep) failedStep = 'rewardCenter_ensureSchema';
      }
    }

    // Step 5: getWheelConfig
    let diagConfig = { is_enabled: true, segment_count: 8, maintenance_mode: false, max_spins_per_user: 3 };
    {
      const t0 = Date.now();
      try {
        if (rewardCenterRepo) {
          diagConfig = await rewardCenterRepo.getWheelConfig(env);
        }
        steps.push({ step: 'getWheelConfig', ok: true, duration_ms: Date.now() - t0,
          config: { is_enabled: diagConfig.is_enabled, maintenance_mode: diagConfig.maintenance_mode, max_spins_per_user: diagConfig.max_spins_per_user } });
      } catch (e) {
        const errInfo = _extractPgError(e);
        steps.push({ step: 'getWheelConfig', ok: false, duration_ms: Date.now() - t0, ...errInfo });
        if (!failedStep) failedStep = 'getWheelConfig';
      }
    }

    // Step 6: getEffectiveMaxSpins
    let diagMaxSpins = 3;
    {
      const t0 = Date.now();
      try {
        diagMaxSpins = await _getEffectiveMaxSpins(env, authState.user.id);
        steps.push({ step: 'getEffectiveMaxSpins', ok: true, duration_ms: Date.now() - t0, max_spins: diagMaxSpins });
      } catch (e) {
        const errInfo = _extractPgError(e);
        steps.push({ step: 'getEffectiveMaxSpins', ok: false, duration_ms: Date.now() - t0, ...errInfo });
        if (!failedStep) failedStep = 'getEffectiveMaxSpins';
      }
    }

    // Step 7: getOrCreateDailySpins — THE CRITICAL STEP
    // This is where the duplicate key violation occurs.
    // We capture detailed info about what happens inside.
    {
      const t0 = Date.now();
      try {
        if (failedStep) {
          steps.push({ step: 'getOrCreateDailySpins', ok: false, duration_ms: 0, error_type: 'skipped', message: 'skipped — previous step failed' });
        } else {
          // Call getOrCreateDailySpins — this runs the transaction:
          //   1. pg_advisory_xact_lock
          //   2. CTE: count existing + conditional INSERT
          //   3. SELECT available spins
          // If a unique constraint violation occurs on INSERT, it throws here.
          const result = await wheelRepo.getOrCreateDailySpins(env, authState.user.id, diagMaxSpins);
          steps.push({
            step: 'getOrCreateDailySpins',
            ok: true,
            duration_ms: Date.now() - t0,
            total_available: result.total_available,
            total_allowed: result.total_allowed,
            spins_returned: result.spins.length,
          });
        }
      } catch (e) {
        const errInfo = _extractPgError(e);
        // For duplicate key violations, capture the constraint name
        // This helps identify WHICH unique index is causing the conflict
        steps.push({
          step: 'getOrCreateDailySpins',
          ok: false,
          duration_ms: Date.now() - t0,
          ...errInfo,
        });
        if (!failedStep) failedStep = 'getOrCreateDailySpins';
      }
    }

    // Step 8: getAvailableSpins
    {
      const t0 = Date.now();
      try {
        if (failedStep) {
          steps.push({ step: 'getAvailableSpins', ok: false, duration_ms: 0, error_type: 'skipped', message: 'skipped — previous step failed' });
        } else {
          const availResult = await wheelRepo.getAvailableSpins(env, authState.user.id);
          steps.push({
            step: 'getAvailableSpins',
            ok: true,
            duration_ms: Date.now() - t0,
            count: availResult.spins.length,
            types: availResult.spins.map(s => s.type),
          });
        }
      } catch (e) {
        const errInfo = _extractPgError(e);
        steps.push({ step: 'getAvailableSpins', ok: false, duration_ms: Date.now() - t0, ...errInfo });
        if (!failedStep) failedStep = 'getAvailableSpins';
      }
    }

    return jsonResponse({
      status: 'diagnostic',
      steps,
      final_status: failedStep ? 'error' : 'success',
      failed_step: failedStep || null,
    }, {}, env);
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
        // PHASE 3: Override maxSpins with tier-based value (Normal 3, Premium 5)
      const maxSpins = await _getEffectiveMaxSpins(env, authState.user.id);
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
          // WHEEL-003 FIX: Handle 'spin' type rewards by granting an actual
          // extra spin, not calling grantReward (which rejects 'spin' type).
          if (spinResult.reward.type === 'spin') {
            // Grant a premium spin as the "extra spin" reward
            await wheelRepo.grantPremiumSpin(env, authState.user.id, 'wheel_reward');
            rewardResult = { success: true, newBalance: null, txId: null, idempotent: false };
          } else {
            // WHEEL-TYPE-FIX: Map the wheel reward type (from wheel_rewards table:
            // 'token', 'voucher', 'nft', etc.) to the canonical economy reward
            // type 'wheel_reward'. The economy service (grantReward) only accepts
            // canonical types from REWARD_TYPES — it rejects 'token' etc. with
            // INVALID_REWARD_TYPE. Without this mapping, 100% of token rewards
            // fail silently (spin consumed, no credit). The original reward type
            // is preserved in metadata for analytics.
            rewardResult = await economyService.grantReward({
              userId: authState.user.id,
              amount: spinResult.reward.amount,
              rewardType: 'wheel_reward',
              description: `Wheel reward: ${spinResult.reward.label || spinResult.reward.type}`,
              refId: rewardRefId,
              metadata: { spin_id: spinResult.spin_id, spin_type: spinResult.spin_type, reward_label: spinResult.reward.label, reward_type: spinResult.reward.type },
              auditInfo: { actor: 'system', ip: request.headers.get('cf-connecting-ip') || null },
              env,
            });
          }
        } catch (e) {
          // ROOT CAUSE FIX (3.2): If reward fails, log clearly. The spin is
          // already consumed — a cron retry will credit the reward later.
          console.warn('Wheel reward grant failed (spin will be retried by cron):', e.message);
        }

        // ROOT CAUSE FIX (3.4): Only dispatch notification if reward was
        // actually credited (not idempotent). Previously the notification
        // fired even if grantReward failed — misleading the user.
        if (notificationService && rewardResult.success && !rewardResult.idempotent) {
          await notificationService.create(env, {
            userId: authState.user.id,
            templateKey: 'wheel_reward',
            category: 'wheel',
            priority: 'high',
            channel: 'mini_app',
            metadata: { amount: String(spinResult.reward.amount), name: spinResult.reward.label || 'Wheel' },
            dedupKey: `wheel_reward_${authState.user.id}_${spinResult.spin_id}`,
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

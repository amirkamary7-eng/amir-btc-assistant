/**
 * Economy Layer — Central Economic Engine for AMIRBTC Mini App
 *
 * This is the SINGLE entry point for ALL economic operations in the app.
 * No module (Referral, Wallet, Wheel, Missions, Marketplace) should call
 * walletRepo.creditTokens/debitTokens directly. Instead, they call the
 * Reward Engine which validates rules, creates transactions, fires events,
 * and then updates the wallet.
 *
 * Architecture:
 *   Referral/Daily/Mission/Wheel/Event/Campaign/Admin
 *     → Reward Engine (grantReward / debitUser)
 *       → Rule Engine (validate)
 *       → Wallet Service (creditTokens / debitTokens)
 *       → Event System (emit)
 *
 * Dependencies are injected via factory function.
 */
export function createEconomyService(deps) {
  const { walletRepo, queryDb } = deps;

  // ═══════════════════════════════════════════════════════════════════
  // REWARD TYPES — standardized, no ad-hoc values allowed
  // ═══════════════════════════════════════════════════════════════════
  const REWARD_TYPES = Object.freeze({
    REFERRAL: 'referral_reward',
    DAILY: 'daily_claim',
    MISSION: 'mission_reward',
    WHEEL: 'wheel_reward',
    CAMPAIGN: 'campaign_reward',
    EVENT: 'event_reward',
    BATTLE: 'battle_reward',
    MARKETPLACE_REFUND: 'marketplace_refund',
    ADMIN: 'admin_credit',
    BONUS: 'bonus_reward',
  });

  // ═══════════════════════════════════════════════════════════════════
  // RULE ENGINE — validates rewards before granting
  // ═══════════════════════════════════════════════════════════════════
  const _rules = [];

  /**
   * Register a rule that must pass before a reward is granted.
   * @param {string} name - rule name
   * @param {function} check - async (ctx) => { passed: boolean, reason?: string }
   *   ctx = { userId, rewardType, amount, refId, metadata, env }
   */
  function registerRule(name, check) {
    _rules.push({ name, check });
  }

  /**
   * Run all registered rules. Returns { passed, failures }.
   */
  async function validateRules(ctx) {
    const failures = [];
    for (const rule of _rules) {
      try {
        const result = await rule.check(ctx);
        if (!result.passed) {
          failures.push({ rule: rule.name, reason: result.reason || 'rejected' });
        }
      } catch (e) {
        failures.push({ rule: rule.name, reason: 'rule_error: ' + (e.message || e) });
      }
    }
    return { passed: failures.length === 0, failures };
  }

  // ═══════════════════════════════════════════════════════════════════
  // EVENT SYSTEM — all economic operations emit events
  // ═══════════════════════════════════════════════════════════════════
  const _listeners = {};

  /**
   * Subscribe to an economy event.
   * @param {string} eventType - e.g. 'ReferralRewardGranted', 'WalletDebited'
   * @param {function} handler - async (event) => {}
   */
  function on(eventType, handler) {
    if (!_listeners[eventType]) _listeners[eventType] = [];
    _listeners[eventType].push(handler);
  }

  /**
   * Emit an event to all listeners (fire-and-forget, non-blocking).
   */
  function emit(eventType, payload) {
    const event = {
      type: eventType,
      timestamp: new Date().toISOString(),
      ...payload,
    };
    // Log every event for audit trail
    console.log(JSON.stringify({ scope: 'economy-event', ...event }));

    const listeners = _listeners[eventType] || [];
    for (const listener of listeners) {
      try {
        const result = listener(event);
        if (result && typeof result.catch === 'function') {
          result.catch(() => {}); // non-blocking, swallow errors
        }
      } catch { /* swallow */ }
    }
    return event;
  }

  // ═══════════════════════════════════════════════════════════════════
  // REWARD ENGINE — central reward distribution
  // ═══════════════════════════════════════════════════════════════════

  /**
   * Grant a reward to a user. This is the ONLY function that should be called
   * by Referral, Daily, Mission, Wheel, Campaign, Event, Battle, Admin.
   *
   * Flow:
   * 1. Validate reward type is known
   * 2. Run rule engine
   * 3. Call walletRepo.creditTokens (idempotent via refId)
   * 4. Emit event
   * 5. Return result
   *
   * @param {object} params
   * @param {string} params.userId - Telegram user ID
   * @param {number} params.amount - positive number
   * @param {string} params.rewardType - one of REWARD_TYPES
   * @param {string} params.description - human-readable
   * @param {string} params.refId - idempotency key (prevents double-reward)
   * @param {object} params.metadata - additional data
   * @param {object} params.auditInfo - { actor, ip, request_id }
   * @param {object} env - Worker env
   * @returns {Promise<{success, newBalance, txId, idempotent?, event}>}
   */
  async function grantReward({ userId, amount, rewardType, description, refId, metadata = {}, auditInfo = {}, env }) {
    // 1. Validate reward type
    const validTypes = Object.values(REWARD_TYPES);
    if (!validTypes.includes(rewardType)) {
      throw Object.assign(new Error(`Invalid reward type: ${rewardType}`), { code: 'INVALID_REWARD_TYPE' });
    }

    const amt = Math.abs(Number(amount));
    if (amt <= 0) {
      throw Object.assign(new Error('Amount must be positive'), { code: 'INVALID_AMOUNT' });
    }

    // 2. Run rule engine
    const ruleResult = await validateRules({ userId, rewardType, amount: amt, refId, metadata, env });
    if (!ruleResult.passed) {
      throw Object.assign(new Error('Rule validation failed'), {
        code: 'RULE_VIOLATION',
        failures: ruleResult.failures,
      });
    }

    // 3. Credit via wallet service (idempotent via refId)
    const result = await walletRepo.creditTokens(
      env,
      String(userId),
      amt,
      rewardType,
      description || rewardType,
      refId || null,
      metadata,
      auditInfo,
    );

    // 4. Emit event
    const eventType = _getEventForReward(rewardType);
    const event = emit(eventType, {
      user_id: String(userId),
      amount: amt,
      reward_type: rewardType,
      ref_id: refId || null,
      tx_id: result.txId,
      new_balance: result.newBalance,
      idempotent: result.idempotent || false,
      metadata,
    });

    return { ...result, event };
  }

  /**
   * Debit tokens from a user (for purchases, marketplace, etc.).
   * Uses walletRepo.debitTokens with rule validation.
   *
   * @param {object} params - same as grantReward but for debits
   * @returns {Promise<{success, newBalance, txId, event}>}
   */
  async function debitUser({ userId, amount, debitType, description, refId, metadata = {}, auditInfo = {}, env }) {
    const amt = Math.abs(Number(amount));
    if (amt <= 0) {
      throw Object.assign(new Error('Amount must be positive'), { code: 'INVALID_AMOUNT' });
    }

    // Run rule engine
    const ruleResult = await validateRules({ userId, rewardType: debitType, amount: amt, refId, metadata, env });
    if (!ruleResult.passed) {
      throw Object.assign(new Error('Rule validation failed'), {
        code: 'RULE_VIOLATION',
        failures: ruleResult.failures,
      });
    }

    const result = await walletRepo.debitTokens(
      env,
      String(userId),
      amt,
      debitType,
      description || debitType,
      refId || null,
      metadata,
      auditInfo,
    );

    const event = emit('WalletDebited', {
      user_id: String(userId),
      amount: -amt,
      debit_type: debitType,
      ref_id: refId || null,
      tx_id: result.txId,
      new_balance: result.newBalance,
      idempotent: result.idempotent || false,
      metadata,
    });

    return { ...result, event };
  }

  /**
   * Reverse a transaction (admin only).
   */
  async function reverseTransaction({ userId, txId, reason, env }) {
    const result = await walletRepo.reverseTransaction(env, String(userId), Number(txId), reason);

    emit('TransactionReversed', {
      user_id: String(userId),
      tx_id: txId,
      reason,
      new_balance: result.newBalance,
    });

    return result;
  }

  /**
   * Map reward type to event name.
   */
  function _getEventForReward(rewardType) {
    const map = {
      [REWARD_TYPES.REFERRAL]: 'ReferralRewardGranted',
      [REWARD_TYPES.DAILY]: 'DailyRewardGranted',
      [REWARD_TYPES.MISSION]: 'MissionRewardGranted',
      [REWARD_TYPES.WHEEL]: 'WheelRewardGranted',
      [REWARD_TYPES.CAMPAIGN]: 'CampaignRewardGranted',
      [REWARD_TYPES.EVENT]: 'EventRewardGranted',
      [REWARD_TYPES.BATTLE]: 'BattleRewardGranted',
      [REWARD_TYPES.MARKETPLACE_REFUND]: 'MarketplaceRefundGranted',
      [REWARD_TYPES.ADMIN]: 'AdminRewardGranted',
      [REWARD_TYPES.BONUS]: 'BonusRewardGranted',
    };
    return map[rewardType] || 'RewardGranted';
  }

  // ═══════════════════════════════════════════════════════════════════
  // BUILT-IN RULES — registered at creation time
  // ═══════════════════════════════════════════════════════════════════

  // Rule: prevent rewards to guest/pending users
  registerRule('no-guest-users', async (ctx) => {
    const uid = String(ctx.userId || '');
    if (uid.startsWith('guest_') || uid === 'pending_telegram' || !uid) {
      return { passed: false, reason: 'guest_or_pending_user' };
    }
    return { passed: true };
  });

  // Rule: amount must be reasonable (max 100000 per single reward)
  registerRule('max-amount', async (ctx) => {
    if (ctx.amount > 100000) {
      return { passed: false, reason: 'amount_exceeds_max_100000' };
    }
    return { passed: true };
  });

  // ═══════════════════════════════════════════════════════════════════
  // PUBLIC API
  // ═══════════════════════════════════════════════════════════════════
  return Object.freeze({
    REWARD_TYPES,
    grantReward,
    debitUser,
    reverseTransaction,
    registerRule,
    validateRules,
    on,
    emit,
  });
}

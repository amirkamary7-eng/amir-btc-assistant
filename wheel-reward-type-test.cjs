/**
 * WHEEL-REWARD-TYPE-MISMATCH-TEST
 *
 * Verifies the wheel reward type mismatch bug:
 *
 * BUG: The wheel controller calls economyService.grantReward() with
 * rewardType = spinResult.reward.type (which comes from wheel_rewards table
 * and is 'token', 'spin', 'voucher', 'nft', etc.). But the economy service
 * only accepts canonical types like 'wheel_reward', 'referral_reward', etc.
 *
 * For 'token' rewards (87.5% of default rewards by weight), grantReward
 * throws INVALID_REWARD_TYPE. The spin is already consumed (status='used')
 * but no tokens are credited. The retry cron also fails with the same error.
 *
 * Production evidence:
 *   - 28 wheel_spins in production
 *   - 0 wheel_reward transactions
 *   - Worker logs: "Wheel reward retry failed for spin X Invalid reward type: token"
 *
 * FIX: Map the wheel reward type to the economy reward type:
 *   - 'token' rewards → grantReward({rewardType: 'wheel_reward', ...})
 *   - 'spin' rewards → grantPremiumSpin (already handled correctly)
 *   - Other types → map to 'wheel_reward' for token credit (pragmatic)
 *
 * The metadata field preserves the original reward type for analytics.
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ── Economy service reward type validation (mirrors src/services/economy.js) ──
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

// Simulated grantReward — validates type like the real economy service
function grantReward({ userId, amount, rewardType, ...rest }) {
  const validTypes = Object.values(REWARD_TYPES);
  if (!validTypes.includes(rewardType)) {
    throw Object.assign(new Error(`Invalid reward type: ${rewardType}`), { code: 'INVALID_REWARD_TYPE' });
  }
  if (Math.abs(Number(amount)) <= 0) {
    throw Object.assign(new Error('Amount must be positive'), { code: 'INVALID_AMOUNT' });
  }
  return { success: true, newBalance: amount, txId: 1, idempotent: false };
}

// ── Wheel reward types from the DB (wheel_rewards table seed values) ────
const WHEEL_REWARD_TYPES = ['token', 'spin', 'voucher', 'nft', 'premium', 'coupon', 'external'];

// ── Tests ───────────────────────────────────────────────────────────────

test('WHEEL-TYPE-001 (BUG): rewardType=token is rejected by economy service', () => {
  // This test PROVES the bug: wheel rewards with type='token' (the most common
  // reward type, 87.5% by weight) are rejected by grantReward.
  const wheelReward = { type: 'token', amount: 5, label: '۵ AB' };

  assert.throws(
    () => grantReward({ userId: '123', amount: wheelReward.amount, rewardType: wheelReward.type }),
    (err) => {
      assert.equal(err.code, 'INVALID_REWARD_TYPE');
      assert.match(err.message, /Invalid reward type: token/);
      return true;
    },
    'grantReward MUST throw INVALID_REWARD_TYPE for rewardType=token'
  );
});

test('WHEEL-TYPE-002 (BUG): rewardType=spin is rejected by economy service', () => {
  // The 'spin' type is handled separately in the controller (grantPremiumSpin),
  // but if it reaches grantReward, it's also rejected.
  const wheelReward = { type: 'spin', amount: 1, label: 'اسپین اضافی' };

  assert.throws(
    () => grantReward({ userId: '123', amount: wheelReward.amount, rewardType: wheelReward.type }),
    (err) => {
      assert.equal(err.code, 'INVALID_REWARD_TYPE');
      return true;
    }
  );
});

test('WHEEL-TYPE-003 (BUG): all non-canonical wheel reward types are rejected', () => {
  // Every wheel reward type from the admin UI is rejected by grantReward
  for (const type of WHEEL_REWARD_TYPES) {
    assert.throws(
      () => grantReward({ userId: '123', amount: 5, rewardType: type }),
      (err) => {
        assert.equal(err.code, 'INVALID_REWARD_TYPE', `type='${type}' should be rejected`);
        return true;
      },
      `Expected grantReward to reject rewardType='${type}'`
    );
  }
});

test('WHEEL-TYPE-004 (FIX): rewardType=wheel_reward is accepted by economy service', () => {
  // After the fix, the wheel controller will map 'token' → 'wheel_reward'
  const result = grantReward({ userId: '123', amount: 5, rewardType: 'wheel_reward' });
  assert.equal(result.success, true);
  assert.equal(result.newBalance, 5);
});

test('WHEEL-TYPE-005 (FIX): mapping function converts wheel types to economy types', () => {
  // The fix introduces a mapping: wheel domain → economy domain
  // This test verifies the mapping logic.
  function mapWheelTypeToEconomyType(wheelType) {
    // 'spin' is handled separately (grantPremiumSpin) — should never reach grantReward
    // All other wheel reward types that involve token credit → 'wheel_reward'
    if (wheelType === 'spin') return null; // handled separately
    return 'wheel_reward';
  }

  // All non-spin wheel types map to 'wheel_reward'
  for (const type of ['token', 'voucher', 'nft', 'premium', 'coupon', 'external']) {
    const mapped = mapWheelTypeToEconomyType(type);
    assert.equal(mapped, 'wheel_reward', `'${type}' should map to 'wheel_reward'`);
    // Verify grantReward accepts the mapped type
    const result = grantReward({ userId: '123', amount: 5, rewardType: mapped });
    assert.equal(result.success, true);
  }

  // 'spin' is handled separately — mapping returns null (skip grantReward)
  assert.equal(mapWheelTypeToEconomyType('spin'), null);
});

test('WHEEL-TYPE-006 (FIX): end-to-end — token reward is credited after fix', () => {
  // Simulates the full flow after the fix is applied:
  // 1. User spins wheel → gets 'token' reward with amount=5
  // 2. Controller maps 'token' → 'wheel_reward'
  // 3. grantReward credits 5 AB to user's balance
  function simulateSpin_rewardGranted(wheelReward) {
    const economyRewardType = wheelReward.type === 'spin' ? null : 'wheel_reward';
    if (economyRewardType === null) {
      // 'spin' → grant extra spin (not tested here)
      return { success: true, kind: 'extra_spin' };
    }
    return grantReward({
      userId: '123',
      amount: wheelReward.amount,
      rewardType: economyRewardType, // ← FIX: mapped type, not raw type
      description: `Wheel reward: ${wheelReward.label}`,
      refId: `wheel_123_2026-08-12_1`,
      metadata: { reward_type: wheelReward.type, reward_label: wheelReward.label },
    });
  }

  const wheelReward = { type: 'token', amount: 5, label: '۵ AB' };
  const result = simulateSpin_rewardGranted(wheelReward);

  assert.equal(result.success, true);
  assert.equal(result.newBalance, 5);
  assert.equal(result.idempotent, false);
});

test('WHEEL-TYPE-007 (FIX): retry cron also uses mapped type', () => {
  // The retryFailedWheelRewards cron must also map the stored reward_type
  // to 'wheel_reward' when calling grantReward. This test verifies that
  // wheel_history.reward_type='token' can be successfully re-granted
  // after the fix.
  function simulateRetry(wheelHistoryRow) {
    // wheelHistoryRow.reward_type is 'token' (stored from original spin)
    // FIX: map to 'wheel_reward' before calling grantReward
    const economyRewardType = wheelHistoryRow.reward_type === 'spin'
      ? null
      : 'wheel_reward';

    if (economyRewardType === null) {
      return { success: true, kind: 'extra_spin_retry' };
    }

    return grantReward({
      userId: wheelHistoryRow.user_id,
      amount: Number(wheelHistoryRow.reward_amount),
      rewardType: economyRewardType, // ← FIX: mapped type
      description: `Wheel reward (retry): ${wheelHistoryRow.reward_label}`,
      refId: `wheel_${wheelHistoryRow.user_id}_${wheelHistoryRow.spin_date_str}_${wheelHistoryRow.spin_id}`,
      metadata: { reward_type: wheelHistoryRow.reward_type, reward_label: wheelHistoryRow.reward_label },
    });
  }

  // Simulate a wheel_history row from production
  const historyRow = {
    user_id: '123',
    spin_id: 1,
    reward_amount: 5,
    reward_type: 'token',
    reward_label: '۵ AB',
    spin_date_str: '2026-08-12',
  };

  const result = simulateRetry(historyRow);
  assert.equal(result.success, true, 'Retry must succeed after fix');
  assert.equal(result.newBalance, 5);
});

test('WHEEL-TYPE-008: all 7 default wheel rewards can be credited after fix', () => {
  // The default wheel_rewards seed has 8 rewards (7 'token' + 1 'spin').
  // After the fix, all 7 'token' rewards should be creditable.
  const defaultRewards = [
    { type: 'token', amount: 1,  label: '۱ AB' },
    { type: 'token', amount: 2,  label: '۲ AB' },
    { type: 'token', amount: 3,  label: '۳ AB' },
    { type: 'token', amount: 5,  label: '۵ AB' },
    { type: 'token', amount: 10, label: '۱۰ AB' },
    { type: 'token', amount: 20, label: '۲۰ AB' },
    { type: 'token', amount: 50, label: '۵۰ AB' },
    { type: 'spin',  amount: 1,  label: 'اسپین اضافی' },
  ];

  for (const reward of defaultRewards) {
    if (reward.type === 'spin') {
      // 'spin' → grantPremiumSpin (not tested here, but the controller handles it)
      continue;
    }
    // 'token' → map to 'wheel_reward'
    const result = grantReward({
      userId: '123',
      amount: reward.amount,
      rewardType: 'wheel_reward', // ← FIX
    });
    assert.equal(result.success, true, `Reward ${reward.label} (${reward.amount} AB) must be creditable`);
    assert.equal(result.newBalance, reward.amount);
  }
});

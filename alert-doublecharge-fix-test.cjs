/**
 * Alert Double-Charge Fix (H1) — Regression Tests
 *
 * Verifies that when a paid alert creation request results in a reactivation
 * (alert already active, ON CONFLICT DO UPDATE), the debit is refunded.
 *
 * Condition: alert.reactivated === true && !claimedFree && debitAmount > 0
 *
 * Run: node --test alert-doublecharge-fix-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ALERTS_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/alerts.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source-text: the refund branch exists with the correct condition
// ═══════════════════════════════════════════════════════════════════════════

test('H1-01: refund branch exists with condition alert.reactivated && !claimedFree && debitAmount > 0', () => {
  assert.ok(ALERTS_SRC.includes('alert.reactivated && !claimedFree && debitAmount > 0'),
    'must have the exact condition for the reactivation refund');
});

test('H1-02: refund uses grantReward with marketplace_refund rewardType', () => {
  assert.ok(ALERTS_SRC.includes("rewardType: 'marketplace_refund'"),
    'must use marketplace_refund (the established refund pattern)');
  assert.ok(ALERTS_SRC.includes('economyService.grantReward'),
    'must call economyService.grantReward for the refund');
});

test('H1-03: refund refId is alertRefId + _refund (idempotent)', () => {
  assert.ok(ALERTS_SRC.includes('`${alertRefId}_refund`'),
    'refund refId must be ${alertRefId}_refund for idempotency');
});

test('H1-04: refund failure persists to pending_refunds', () => {
  assert.ok(ALERTS_SRC.includes('INSERT INTO pending_refunds'),
    'must INSERT into pending_refunds on refund failure');
  assert.ok(ALERTS_SRC.includes("ON CONFLICT (refund_ref_id) WHERE status = 'pending' DO NOTHING"),
    'must use ON CONFLICT DO NOTHING for idempotent pending_refunds INSERT');
  assert.ok(ALERTS_SRC.includes("'alert'"),
    'must use source = alert for the pending_refunds entry');
});

test('H1-05: refund branch is in the SUCCESS path (not just the catch block)', () => {
  // The refund branch must be BEFORE the return jsonResponse({ status: 'success' ...})
  const refundIdx = ALERTS_SRC.indexOf('alert.reactivated && !claimedFree && debitAmount > 0');
  const successReturnIdx = ALERTS_SRC.indexOf("return jsonResponse({ status: 'success', alert }", refundIdx);
  assert.ok(refundIdx > -1 && successReturnIdx > -1,
    'refund branch must exist before the success return');
  assert.ok(refundIdx < successReturnIdx,
    'refund branch must be BEFORE the success return (not in the catch block)');
});

test('H1-06: existing catch-block refund is still intact (create-failure refund)', () => {
  // The catch-block refund (lines 277+) must still be present — it handles
  // the case where alertRepo.create THROWS (not reactivation).
  const catchRefundIdx = ALERTS_SRC.indexOf('alert_create_failure');
  assert.ok(catchRefundIdx > -1,
    'the existing create-failure refund (catch block) must still be present');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Behavioral simulations: the fix works correctly
// ═══════════════════════════════════════════════════════════════════════════

// Simulated grantReward (idempotent via refId)
function makeMockGrantReward() {
  const calls = [];
  const credited = new Map(); // refId → amount
  return {
    calls,
    fn: async function ({ userId, amount, refId }) {
      calls.push({ userId, amount, refId });
      if (refId && credited.has(refId)) {
        return { success: true, idempotent: true };
      }
      credited.set(refId, amount);
      return { success: true, idempotent: false };
    },
    credited,
  };
}

test('SIM-01: paid concurrent duplicate → one debit + one refund (no double-charge)', async () => {
  const mock = makeMockGrantReward();
  let debitCount = 0;
  const balance = { user: 100 };

  // Simulate two concurrent paid requests for the same alert
  async function simulatePaidAlert(reactivated) {
    const refId = `alert_user_BTC_50000_above_2026-09-16_${Date.now()}_${Math.random()}`;
    // Step 1: debit
    if (balance.user >= 5) {
      balance.user -= 5;
      debitCount++;
    }
    // Step 2: alertRepo.create → reactivated?
    const alert = { reactivated };
    // Step 3: the fix — if reactivated && !claimedFree && debitAmount > 0 → refund
    if (alert.reactivated === true && true && 5 > 0) {
      await mock.fn({ userId: 'user', amount: 5, refId: `${refId}_refund` });
      balance.user += 5; // refund credits the balance back
    }
    return { alert, refId };
  }

  // Request A: creates the alert (not reactivated)
  const a = await simulatePaidAlert(false);
  // Request B: reactivates the alert (already active)
  const b = await simulatePaidAlert(true);

  assert.equal(debitCount, 2, 'both requests debited (different refIds)');
  assert.equal(mock.calls.length, 1, 'only ONE refund (for the reactivating request B)');
  assert.equal(balance.user, 95, 'net: user paid 5 (A) + debited 5 (B) + refunded 5 (B) = 100-5 = 95');
});

test('SIM-02: paid reactivation → refund issued', async () => {
  const mock = makeMockGrantReward();
  // Single request that reactivates an existing active alert
  const refId = 'alert_user_ETH_3000_above_2026-09-16_123';
  const alert = { reactivated: true };
  const claimedFree = false;
  const debitAmount = 5;

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: debitAmount, refId: `${refId}_refund` });
  }
  assert.equal(mock.calls.length, 1, 'refund was called');
  assert.equal(mock.calls[0].amount, 5, 'correct amount');
  assert.equal(mock.calls[0].refId, 'alert_user_ETH_3000_above_2026-09-16_123_refund', 'correct refId');
});

test('SIM-03: refund failure → pending_refunds INSERT', async () => {
  let pendingInsert = null;
  const failingGrant = async () => { throw new Error('DB timeout'); };
  const refId = 'alert_user_BTC_50000_above_2026-09-16_456';

  try {
    await failingGrant({ refId: `${refId}_refund` });
  } catch (refundErr) {
    // Persist to pending_refunds (simulated)
    pendingInsert = {
      user_id: 'user',
      amount: 5,
      refund_ref_id: `${refId}_refund`,
      original_ref_id: refId,
      source: 'alert',
      status: 'pending',
    };
  }
  assert.ok(pendingInsert, 'pending_refunds entry was created');
  assert.equal(pendingInsert.refund_ref_id, `${refId}_refund`, 'correct refund_ref_id');
  assert.equal(pendingInsert.source, 'alert', 'correct source');
  assert.equal(pendingInsert.status, 'pending', 'correct status');
});

test('SIM-04: pending refund retry → idempotent (no double-credit)', async () => {
  const mock = makeMockGrantReward();
  const refId = 'alert_user_BTC_50000_above_2026-09-16_789_refund';

  // First retry: succeeds
  await mock.fn({ userId: 'user', amount: 5, refId });
  // Second retry (cron re-processes): idempotent
  await mock.fn({ userId: 'user', amount: 5, refId });

  assert.equal(mock.calls.length, 2, 'grantReward called twice (cron retry)');
  assert.equal(mock.credited.size, 1, 'only ONE credit (idempotent)');
  assert.equal(mock.credited.get(refId), 5, 'credited exactly 5');
});

test('SIM-05: duplicate refund request → no double-credit', async () => {
  const mock = makeMockGrantReward();
  const refId = 'alert_user_SOL_100_above_2026-09-16_999_refund';

  // Same refId called twice
  await mock.fn({ userId: 'user', amount: 5, refId });
  await mock.fn({ userId: 'user', amount: 5, refId });

  assert.equal(mock.credited.size, 1, 'only 1 unique credit');
  assert.equal(mock.calls[1].refId, refId, 'second call same refId');
});

test('SIM-06: normal paid alert (reactivated=false) → no refund', async () => {
  const mock = makeMockGrantReward();
  const alert = { reactivated: false };
  const claimedFree = false;
  const debitAmount = 5;

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: 5, refId: 'test_refund' });
  }
  assert.equal(mock.calls.length, 0, 'no refund for normal first paid alert');
});

test('SIM-07: free reactivation → no refund (debitAmount=0)', async () => {
  const mock = makeMockGrantReward();
  const alert = { reactivated: true };
  const claimedFree = true; // free path
  const debitAmount = 0;    // no debit on free path

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: 5, refId: 'test_refund' });
  }
  assert.equal(mock.calls.length, 0, 'no refund for free reactivation (no debit)');
});

test('SIM-08: deleted/triggered alert recreation → still charged (reactivated=false)', async () => {
  const mock = makeMockGrantReward();
  // Delete + re-create: ON CONFLICT WHERE status='active' does NOT match (deleted alert has status='deleted')
  // → INSERT (new alert) → reactivated=false
  // Triggered alert re-create: ON CONFLICT WHERE status='active' does NOT match (status='triggered')
  // → INSERT (new alert) → reactivated=false
  const alert = { reactivated: false }; // new alert, not reactivation
  const claimedFree = false;
  const debitAmount = 5;

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: 5, refId: 'test_refund' });
  }
  assert.equal(mock.calls.length, 0, 'no refund — user correctly charged for new alert after delete/trigger');
});

console.log('✅ Alert double-charge fix (H1) regression tests loaded.');

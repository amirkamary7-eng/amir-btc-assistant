/**
 * FIN-001 Regression Test Suite — Atomic VPN Purchase Cancellation, Ledger Verification & Refund/Outbox Safety
 *
 * Verifies:
 *   FIN001-01: queryDbTransaction runs pre-commit validate(res, results) BEFORE COMMIT and rolls back on failure
 *   FIN001-02: Pending VPN purchase cancel -> atomic status='cancelled' + balance refunded + marketplace_refund tx
 *   FIN001-03: Case 1 (Purchase Not Found) -> 404 PURCHASE_NOT_FOUND / 422 INVALID_PURCHASE_ID, zero side effects
 *   FIN001-04: Case 2 (Already Cancelled with completed refund) -> 200 ALREADY_CANCELLED (idempotent, no double refund)
 *   FIN001-05: Case 2b (Legacy cancelled row without refund, valid debit exists) -> REFUND_RECONCILED once, then idempotent
 *   FIN001-06: Case 3 (Already Fulfilled) -> 409 PURCHASE_ALREADY_FULFILLED, no status change, no refund
 *   FIN001-07: Case 4 (Refund already completed while purchase still pending) -> 200 IDEMPOTENT_REFUND, no double credit
 *   FIN001-08: Case 5 (Duplicate / existing Outbox row in pending_refunds) -> reconciled in direct mode, deduplicated in outboxOnly mode, rolled back on amount/user mismatch
 *   FIN001-09: Case 6 (LEDGER_MISMATCH — missing debit row, mismatched debit amount, or mismatched existing refund) -> 409 LEDGER_MISMATCH, rollback before COMMIT, purchase remains pending
 *   FIN001-10: Source verification — worker-proxy.js queryDbTransaction executes validate(res, results) prior to COMMIT
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeRealStack,
  loadFactory,
  balanceOf,
  txCount,
  txRows,
} = require('./wallet-test-harness.cjs');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');

const createRewardPurchaseRepository = loadFactory(
  'src/repositories/reward_purchases.js',
  'createRewardPurchaseRepository',
);
const createRewardPurchaseHandlers = loadFactory(
  'src/controllers/reward_purchases.js',
  'createRewardPurchaseHandlers',
);

const ENV = {};

function makeVpnCancelStack({ premium = true, balance = 500, tehranDate = '2026-01-01' } = {}) {
  const stack = makeRealStack();
  const h = stack.h;
  if (balance > 0) h.insertBalance('u1', balance);

  const repo = createRewardPurchaseRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
    isDatabaseConfigured: () => true,
    getTehranDateString: () => tehranDate,
  });

  const handlers = createRewardPurchaseHandlers({
    jsonResponse: (body, init = {}, _e) => ({ __http: true, status: init.status || 200, body }),
    authenticateTelegramRequest: async () => ({
      error: null,
      user: { id: 'u1', username: 'testuser', first_name: 'Test' },
    }),
    readJsonBody: async (req) => ({ error: null, payload: req.__payload }),
    safeDbErrorResponse: (e) => ({
      __http: true,
      status: 500,
      body: { status: 'error', message: e?.message || 'db_error' },
    }),
    safeError: (_s, e) => e,
    isDatabaseConfigured: () => true,
    economyService: stack.economyService,
    rewardPurchaseRepo: repo,
    membershipAuthority: { isPremium: async () => premium },
    notificationService: { create: async () => ({ success: true }) },
    requireAdmin: async () => ({ error: null, admin: { telegram_id: 'admin_1' } }),
    queryDb: h.queryDb,
    getTehranDateString: () => tehranDate,
  });

  return { h, stack, repo, handlers };
}

async function buyVpn(handlers, planId = 'vpn_4gb') {
  return handlers.handleVpnPurchase(
    { url: 'https://x/api/rewards/vpn/purchase', __payload: { plan_id: planId }, headers: { get: () => null } },
    ENV,
  );
}

async function adminCancel(handlers, purchaseId) {
  return handlers.handleAdminCancel(
    { url: `https://x/api/admin/reward-purchases/${purchaseId}/cancel`, headers: { get: () => null } },
    ENV,
    purchaseId,
  );
}

// ═══════════════════════════════════════════════════════════════════════════

test('FIN001-01: queryDbTransaction runs pre-commit validate(res, results) BEFORE COMMIT and rolls back on failure', async () => {
  const { h } = makeVpnCancelStack({ balance: 500 });
  assert.equal(await balanceOf(h, 'u1'), 500);

  await assert.rejects(
    async () => {
      await h.queryDbTransaction(ENV, [
        {
          sql: 'UPDATE token_balances SET balance = 9999 WHERE user_id = $1',
          params: ['u1'],
        },
        {
          sql: 'SELECT balance FROM token_balances WHERE user_id = $1',
          params: ['u1'],
          validate: async (res) => {
            assert.equal(Number(res.rows[0].balance), 9999, 'inside txn before rollback');
            throw Object.assign(new Error('PRE_COMMIT_ABORT'), { code: 'PRE_COMMIT_ABORT' });
          },
        },
      ]);
    },
    (err) => err && err.code === 'PRE_COMMIT_ABORT',
  );

  // Verify the UPDATE was rolled back and never committed
  assert.equal(await balanceOf(h, 'u1'), 500, 'balance must roll back to 500 when pre-commit validate throws');
});

test('FIN001-02: Pending VPN purchase cancel -> atomic status=cancelled + full AB refund + marketplace_refund ledger row', async () => {
  const { h, repo, handlers } = makeVpnCancelStack({ premium: true, balance: 500 });

  // Buy vpn_4gb (costs 300 AB) -> balance drops to 200 AB
  const purchaseRes = await buyVpn(handlers, 'vpn_4gb');
  assert.equal(purchaseRes.status, 201);
  const purchaseId = purchaseRes.body.purchase.id;
  assert.equal(await balanceOf(h, 'u1'), 200);

  // Admin cancels the pending purchase -> balance restored to 500 AB, status = 'cancelled'
  const cancelRes = await adminCancel(handlers, purchaseId);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.status, 'success');
  assert.equal(cancelRes.body.cancelled, true);
  assert.equal(cancelRes.body.refunded, true);
  assert.equal(cancelRes.body.idempotent, false);
  assert.equal(cancelRes.body.code, 'CANCELLED_AND_REFUNDED');
  assert.equal(cancelRes.body.new_balance, 500);

  assert.equal(await balanceOf(h, 'u1'), 500, 'user balance must be refunded from 200 back to 500');

  const p = await repo.getPurchaseById(ENV, purchaseId);
  assert.equal(p.status, 'cancelled', 'purchase status must be cancelled');

  const refunds = await txRows(h, "WHERE user_id = 'u1' AND tx_type = 'marketplace_refund' AND status = 'completed'");
  assert.equal(refunds.length, 1, 'exactly one completed marketplace_refund row');
  assert.equal(Number(refunds[0].amount), 300);
  assert.equal(refunds[0].ref_id, 'vpn_purchase_u1_vpn_4gb_2026-01-01_refund');
});

test('FIN001-03: Case 1 (Purchase Not Found & Invalid ID) -> 404 / 422 with zero side effects', async () => {
  const { h, handlers } = makeVpnCancelStack({ premium: true, balance: 500 });

  const notFoundRes = await adminCancel(handlers, 99999);
  assert.equal(notFoundRes.status, 404);
  assert.equal(notFoundRes.body.code, 'PURCHASE_NOT_FOUND');

  const invalidRes = await adminCancel(handlers, 'abc');
  assert.equal(invalidRes.status, 422);
  assert.equal(invalidRes.body.code, 'INVALID_PURCHASE_ID');

  assert.equal(await balanceOf(h, 'u1'), 500);
  assert.equal(await txCount(h, ''), 0);
});

test('FIN001-04: Case 2 (Already Cancelled) -> idempotent 200 ALREADY_CANCELLED, no double refund', async () => {
  const { h, handlers } = makeVpnCancelStack({ premium: true, balance: 500 });
  const purchaseRes = await buyVpn(handlers, 'vpn_4gb');
  const purchaseId = purchaseRes.body.purchase.id;

  const firstCancel = await adminCancel(handlers, purchaseId);
  assert.equal(firstCancel.status, 200);
  assert.equal(firstCancel.body.idempotent, false);
  assert.equal(await balanceOf(h, 'u1'), 500);

  // Second cancel on the same purchase -> idempotent, balance must remain 500 (NOT 800!)
  const secondCancel = await adminCancel(handlers, purchaseId);
  assert.equal(secondCancel.status, 200);
  assert.equal(secondCancel.body.cancelled, true);
  assert.equal(secondCancel.body.refunded, true);
  assert.equal(secondCancel.body.idempotent, true);
  assert.equal(secondCancel.body.code, 'ALREADY_CANCELLED');
  assert.equal(await balanceOf(h, 'u1'), 500, 'balance must NOT be double-credited on repeated cancel');
  assert.equal(await txCount(h, "WHERE tx_type = 'marketplace_refund'"), 1, 'still only 1 refund tx');
});

test('FIN001-05: Case 2b (Legacy cancelled purchase lacking refund, with valid debit) -> reconciles refund once', async () => {
  const { h, handlers } = makeVpnCancelStack({ premium: true, balance: 500 });
  const purchaseRes = await buyVpn(handlers, 'vpn_4gb');
  const purchaseId = purchaseRes.body.purchase.id;
  assert.equal(await balanceOf(h, 'u1'), 200);

  // Simulate legacy bug where status was set to 'cancelled' without refunding
  await h.raw("UPDATE reward_purchases SET status = 'cancelled' WHERE id = $1", [purchaseId]);

  const reconcileRes = await adminCancel(handlers, purchaseId);
  assert.equal(reconcileRes.status, 200);
  assert.equal(reconcileRes.body.code, 'REFUND_RECONCILED');
  assert.equal(reconcileRes.body.refunded, true);
  assert.equal(reconcileRes.body.idempotent, false);
  assert.equal(await balanceOf(h, 'u1'), 500, 'missing refund must be reconciled to 500');

  // Calling again is now idempotent
  const repeatRes = await adminCancel(handlers, purchaseId);
  assert.equal(repeatRes.status, 200);
  assert.equal(repeatRes.body.code, 'ALREADY_CANCELLED');
  assert.equal(repeatRes.body.idempotent, true);
  assert.equal(await balanceOf(h, 'u1'), 500);
});

test('FIN001-06: Case 3 (Purchase Already Fulfilled) -> 409 PURCHASE_ALREADY_FULFILLED, no refund or status change', async () => {
  const { h, repo, handlers } = makeVpnCancelStack({ premium: true, balance: 500 });
  const purchaseRes = await buyVpn(handlers, 'vpn_4gb');
  const purchaseId = purchaseRes.body.purchase.id;

  // Fulfill purchase first
  const fulfilled = await repo.fulfillPurchase(ENV, purchaseId, 'admin_1', 'vless://test-link');
  assert.equal(fulfilled.status, 'fulfilled');

  // Attempt to cancel fulfilled purchase -> 409
  const cancelRes = await adminCancel(handlers, purchaseId);
  assert.equal(cancelRes.status, 409);
  assert.equal(cancelRes.body.code, 'PURCHASE_ALREADY_FULFILLED');
  assert.equal(cancelRes.body.current_status, 'fulfilled');

  // Balance remains 200 (no refund), purchase remains fulfilled
  assert.equal(await balanceOf(h, 'u1'), 200);
  const p = await repo.getPurchaseById(ENV, purchaseId);
  assert.equal(p.status, 'fulfilled');
  assert.equal(await txCount(h, "WHERE tx_type = 'marketplace_refund'"), 0);
});

test('FIN001-07: Case 4 (Refund already completed while purchase still pending) -> 200 IDEMPOTENT_REFUND, no double credit', async () => {
  const { h, repo, handlers } = makeVpnCancelStack({ premium: true, balance: 500 });
  const purchaseRes = await buyVpn(handlers, 'vpn_4gb');
  const purchaseId = purchaseRes.body.purchase.id;
  assert.equal(await balanceOf(h, 'u1'), 200);

  // Pre-insert the completed marketplace_refund (e.g., already credited via prior outbox retry)
  await h.raw(
    `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id)
     VALUES ($1, $2, 'marketplace_refund', 'reward', 'completed', 'Prior refund', $3)`,
    ['u1', 300, 'vpn_purchase_u1_vpn_4gb_2026-01-01_refund'],
  );
  await h.raw('UPDATE token_balances SET balance = 500 WHERE user_id = $1', ['u1']);

  const cancelRes = await adminCancel(handlers, purchaseId);
  assert.equal(cancelRes.status, 200);
  assert.equal(cancelRes.body.cancelled, true);
  assert.equal(cancelRes.body.refunded, true);
  assert.equal(cancelRes.body.idempotent, true);
  assert.equal(cancelRes.body.code, 'IDEMPOTENT_REFUND');

  // Purchase transitioned to cancelled, balance stayed 500 (not 800!)
  assert.equal(await balanceOf(h, 'u1'), 500);
  const p = await repo.getPurchaseById(ENV, purchaseId);
  assert.equal(p.status, 'cancelled');
  assert.equal(await txCount(h, "WHERE tx_type = 'marketplace_refund'"), 1);
});

test('FIN001-08: Case 5 (Duplicate / existing Outbox row in pending_refunds) -> reconciled, deduplicated, and validated', async () => {
  const { h, repo, handlers } = makeVpnCancelStack({ premium: true, balance: 1000 });

  // Sub-case A: Direct refund mode when a pending Outbox row already exists -> marks Outbox row 'completed'
  const p1Res = await buyVpn(handlers, 'vpn_4gb'); // -300 AB -> 700 AB
  const p1Id = p1Res.body.purchase.id;
  const p1Ref = 'vpn_purchase_u1_vpn_4gb_2026-01-01';
  await h.raw(
    `INSERT INTO pending_refunds (user_id, amount, refund_ref_id, original_ref_id, source, description, status)
     VALUES ($1, $2, $3, $4, 'vpn', 'Pre-existing outbox row', 'pending')`,
    ['u1', 300, `${p1Ref}_refund`, p1Ref],
  );

  const c1 = await repo.cancelPurchase(ENV, p1Id);
  assert.equal(c1.cancelled, true);
  assert.equal(c1.refunded, true);
  assert.equal(c1.reconciledOutboxCount, 1, 'existing pending Outbox row must be reconciled to completed');
  assert.equal(await balanceOf(h, 'u1'), 1000);

  const outbox1 = await h.raw('SELECT status, refund_ref_id FROM pending_refunds WHERE id = $1', [c1.outboxId]);
  assert.equal(outbox1.rows[0].status, 'completed');

  // Sub-case B: outboxOnly fallback mode with duplicate call -> deduplicates without error
  const p2Res = await buyVpn(handlers, 'vpn_6gb'); // -400 AB -> 600 AB
  const p2Id = p2Res.body.purchase.id;
  const p2Ref = 'vpn_purchase_u1_vpn_6gb_2026-01-01';

  const outboxCancel1 = await repo.cancelPurchase(ENV, p2Id, { outboxOnly: true });
  assert.equal(outboxCancel1.cancelled, true);
  assert.equal(outboxCancel1.outboxQueued, true);
  assert.equal(outboxCancel1.code, 'CANCELLED_OUTBOX_QUEUED');

  // Calling outboxOnly again when the pending Outbox row already exists -> idempotent OUTBOX_ALREADY_QUEUED
  const outboxCancel2 = await repo.cancelPurchase(ENV, p2Id, { outboxOnly: true });
  assert.equal(outboxCancel2.cancelled, true);
  assert.equal(outboxCancel2.outboxQueued, true);
  assert.equal(outboxCancel2.idempotent, true);
  assert.equal(outboxCancel2.code, 'OUTBOX_ALREADY_QUEUED');

  const pendingCount = await h.raw(
    "SELECT COUNT(*)::int AS c FROM pending_refunds WHERE refund_ref_id = $1 AND status = 'pending'",
    [`${p2Ref}_refund`],
  );
  assert.equal(Number(pendingCount.rows[0].c), 1, 'only 1 pending Outbox row exists');

  // Sub-case C: Mismatched pending Outbox row (amount tampered) -> LEDGER_MISMATCH rollback, purchase stays pending
  const p3Res = await buyVpn(handlers, 'vpn_8gb'); // -500 AB -> 100 AB
  const p3Id = p3Res.body.purchase.id;
  const p3Ref = 'vpn_purchase_u1_vpn_8gb_2026-01-01';
  await h.raw(
    `INSERT INTO pending_refunds (user_id, amount, refund_ref_id, original_ref_id, source, description, status)
     VALUES ($1, $2, $3, $4, 'vpn', 'Tampered outbox amount', 'pending')`,
    ['u1', 999, `${p3Ref}_refund`, p3Ref],
  );

  const badOutboxRes = await adminCancel(handlers, p3Id);
  assert.equal(badOutboxRes.status, 409);
  assert.equal(badOutboxRes.body.code, 'LEDGER_MISMATCH');
  assert.equal(badOutboxRes.body.reason, 'mismatched_pending_outbox');

  const p3After = await repo.getPurchaseById(ENV, p3Id);
  assert.equal(p3After.status, 'pending', 'purchase must remain pending when Outbox row is mismatched');
  assert.equal(await balanceOf(h, 'u1'), 100, 'balance untouched on rollback');
});

test('FIN001-09: Case 6 (LEDGER_MISMATCH — missing debit row or mismatched debit/refund amount) -> 409 & full rollback', async () => {
  const { h, repo, handlers } = makeVpnCancelStack({ premium: true, balance: 1000 });

  // Sub-case A: Purchase exists in reward_purchases with NO matching debit row in token_transactions
  const orphanPurchase = await repo.createVpnPurchase(ENV, 'u1', 'vpn_4gb', 300, 'orphan_ref_no_debit');
  assert.equal(orphanPurchase.created, true);
  const orphanId = orphanPurchase.purchase.id;

  const resA = await adminCancel(handlers, orphanId);
  assert.equal(resA.status, 409);
  assert.equal(resA.body.code, 'LEDGER_MISMATCH');
  assert.equal(resA.body.reason, 'missing_or_mismatched_debit');

  const orphanAfter = await repo.getPurchaseById(ENV, orphanId);
  assert.equal(orphanAfter.status, 'pending', 'orphan purchase MUST NOT transition to cancelled without valid debit');
  assert.equal(await balanceOf(h, 'u1'), 1000, 'balance must remain 1000');

  // Sub-case B: Debit row exists in token_transactions but amount (-100) != -cost_ab (-400)
  await h.raw(
    `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id)
     VALUES ('u1', -100, 'vpn_purchase', 'vpn', 'completed', 'Underpaid debit', 'mismatch_debit_ref')`,
  );
  const mismatchPurchase = await repo.createVpnPurchase(ENV, 'u1', 'vpn_6gb', 400, 'mismatch_debit_ref');
  const mismatchId = mismatchPurchase.purchase.id;

  const resB = await adminCancel(handlers, mismatchId);
  assert.equal(resB.status, 409);
  assert.equal(resB.body.code, 'LEDGER_MISMATCH');
  assert.equal(resB.body.reason, 'missing_or_mismatched_debit');

  const mismatchAfter = await repo.getPurchaseById(ENV, mismatchId);
  assert.equal(mismatchAfter.status, 'pending', 'mismatched-debit purchase MUST stay pending');
  assert.equal(await balanceOf(h, 'u1'), 1000);

  // Sub-case C: Valid debit exists (-500), but an existing marketplace_refund row has wrong amount (+100 != +500)
  const validPurchaseRes = await buyVpn(handlers, 'vpn_8gb'); // -500 AB -> 500 AB
  const validId = validPurchaseRes.body.purchase.id;
  await h.raw(
    `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id)
     VALUES ('u1', 100, 'marketplace_refund', 'reward', 'completed', 'Partial wrong refund', 'vpn_purchase_u1_vpn_8gb_2026-01-01_refund')`,
  );

  const resC = await adminCancel(handlers, validId);
  assert.equal(resC.status, 409);
  assert.equal(resC.body.code, 'LEDGER_MISMATCH');
  assert.equal(resC.body.reason, 'mismatched_existing_refund');

  const validAfter = await repo.getPurchaseById(ENV, validId);
  assert.equal(validAfter.status, 'pending', 'purchase must remain pending when existing refund amount mismatches cost_ab');
  assert.equal(await balanceOf(h, 'u1'), 500);
});

test('FIN001-10: Source guard — worker-proxy.js queryDbTransaction runs validate(res, results) before COMMIT', () => {
  const fnStart = WORKER_SRC.indexOf('async function queryDbTransaction(env, queries)');
  assert.ok(fnStart !== -1, 'queryDbTransaction must exist in worker-proxy.js');
  const fnBody = WORKER_SRC.slice(fnStart, fnStart + 2500);
  const validateIdx = fnBody.indexOf('await validate(res, results)');
  const commitIdx = fnBody.indexOf("await _poolQueryWithTimeout(client, 'COMMIT'");
  assert.ok(validateIdx !== -1, 'queryDbTransaction must await validate(res, results)');
  assert.ok(commitIdx !== -1, 'queryDbTransaction must execute COMMIT');
  assert.ok(validateIdx < commitIdx, 'validate(res, results) MUST execute BEFORE COMMIT');
});

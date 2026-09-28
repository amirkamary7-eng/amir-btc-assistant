/**
 * COSMETICS REFUND GUARD TEST — CSM-series
 *
 * FIX C2 regression suite: the race-condition refund in
 * src/controllers/cosmetics.js → handlePurchase.
 *
 * The REAL controller + REAL economyService + REAL walletRepo + REAL
 * cosmeticsRepo run against pg-mem (see wallet-test-harness.cjs). Only the
 * HTTP/auth layer is mocked (jsonResponse, authenticateTelegramRequest, ...).
 *
 * Bug being regression-tested (C2): when two concurrent purchases raced, the
 * loser received a FULL refund even though its debit was idempotent (i.e. the
 * OTHER request had already paid) → net payment zero + cosmetic owned = free
 * purchase. The shipped fix removes the refund from the ownership-conflict
 * path entirely: in EVERY reachable created=false interleaving the cosmetic
 * was paid exactly once and delivered exactly once, so any refund there is
 * economically wrong (CSM7 documents the real-debit-loser hole that the
 * guard-only version misses).
 *
 *   CSM1 successful purchase — debit + ownership, 201
 *   CSM2 failed purchase (insufficient) — 402, NO transaction row (C1+C2)
 *   CSM3 retry after insufficient — 402 again, NOT a free 201
 *   CSM4 duplicate purchase (sequential) — 409, no refund, single debit
 *   CSM5 concurrent purchase race — one debit, ZERO refunds, no free purchase
 *   CSM6 unit: idempotent debit + ownership conflict → refund MUST be skipped
 *   CSM7 unit: REAL debit + ownership conflict → refund MUST also be skipped
 *         (the guard-only fix still allowed a free purchase in this
 *          interleaving — the shipped fix removes the conflict-path refund)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makeRealStack,
  createCosmeticsRepository,
  createCosmeticsHandlers,
  txCount,
  balanceOf,
  txRows,
} = require('./wallet-test-harness.cjs');

const ENV = {};
const USER = '700000001';
const COSMETIC_ID = 9;
const COST = 500;

// ── Mocked HTTP layer (controller deps) ────────────────────────────────────
const jsonResponse = (body, init = {}, _env) => ({ __http: true, status: init.status || 200, body });
const buildBodyFieldValidationError = (errors, _env) => ({ __http: true, status: 422, body: { status: 'error', errors } });
const safeDbErrorResponse = (_e, _ctx, _env) => ({ __http: true, status: 500, body: { status: 'error', message: 'Database error' } });
const safeError = (_scope, e) => e;
const authenticateTelegramRequest = async () => ({ error: null, user: { id: USER }, startParam: null });
const readJsonBody = async () => ({ error: null, payload: {} });
const isDatabaseConfigured = () => true;
const membershipAuthority = { isPremium: async () => true };

/** Build the full real stack with controller handlers. */
async function makeStack() {
  const stack = makeRealStack();
  const { h, walletRepo, economyService } = stack;

  const cosmeticsRepo = createCosmeticsRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
    isDatabaseConfigured,
  });
  const handlers = createCosmeticsHandlers({
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    cosmeticsRepo,
    membershipAuthority,
    economyService,
  });

  await h.insertCosmetic(COSMETIC_ID, COST);
  return { ...stack, cosmeticsRepo, handlers };
}

async function purchase(handlers) {
  return handlers.handlePurchase({ url: 'https://x/api/cosmetics/9/purchase' }, ENV, String(COSMETIC_ID));
}

async function refundCount(h) {
  return txCount(h, "WHERE tx_type = 'bonus_reward' AND amount > 0 AND description LIKE 'Refund:%'");
}

async function debitCount(h) {
  return txCount(h, "WHERE tx_type = 'cosmetic_purchase' AND amount < 0");
}

// ═══════════════════════════════════════════════════════════════════════════
// CSM-SERIES
// ═══════════════════════════════════════════════════════════════════════════

test('CSM1: successful purchase — ownership granted, balance debited, 201', async () => {
  const { h, handlers } = await makeStack();
  await h.insertBalance(USER, 1000);

  const res = await purchase(handlers);
  assert.equal(res.status, 201);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.ownership.cosmetic_id, COSMETIC_ID);

  assert.equal(await debitCount(h), 1);
  assert.equal(await refundCount(h), 0);
  assert.equal(await balanceOf(h, USER), 500);

  const owned = await h.raw('SELECT COUNT(*)::int AS c FROM user_cosmetic_ownership WHERE user_id = $1', [USER]);
  assert.equal(Number(owned.rows[0].c), 1);
});

test('CSM2: failed purchase (insufficient balance) — 402 and NO transaction row', async () => {
  const { h, handlers } = await makeStack();
  await h.insertBalance(USER, 100); // < COST

  const res = await purchase(handlers);
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'PAYMENT_FAILED');

  // C1+C2 phantom assertions (FAIL on unfixed code):
  assert.equal(await txCount(h), 0, 'failed purchase MUST NOT leave a phantom debit row');
  assert.equal(await balanceOf(h, USER), 100);

  const owned = await h.raw('SELECT COUNT(*)::int AS c FROM user_cosmetic_ownership WHERE user_id = $1', [USER]);
  assert.equal(Number(owned.rows[0].c), 0, 'failed purchase MUST NOT grant ownership');
});

test('CSM3: retry after insufficient — 402 again, NOT a free 201', async () => {
  // On unfixed code: attempt 1 left a phantom completed tx with the purchase
  // refId → attempt 2's debit was idempotent (no real payment) → ownership
  // granted → 201 = FREE PURCHASE. This test kills that path.
  const { h, handlers } = await makeStack();
  await h.insertBalance(USER, 100);

  const first = await purchase(handlers);
  assert.equal(first.status, 402);

  const retry = await purchase(handlers);
  assert.equal(retry.status, 402, 'retry with insufficient balance must fail again — not succeed for free');

  assert.equal(await txCount(h), 0);
  assert.equal(await balanceOf(h, USER), 100);
  const owned = await h.raw('SELECT COUNT(*)::int AS c FROM user_cosmetic_ownership WHERE user_id = $1', [USER]);
  assert.equal(Number(owned.rows[0].c), 0);

  // After earning enough tokens the purchase must succeed and pay exactly once
  await h.raw('UPDATE token_balances SET balance = $2 WHERE user_id = $1', [USER, 600]);
  const ok = await purchase(handlers);
  assert.equal(ok.status, 201);
  assert.equal(await debitCount(h), 1);
  assert.equal(await refundCount(h), 0);
  assert.equal(await balanceOf(h, USER), 100);
});

test('CSM4: duplicate purchase (sequential) — 409 ALREADY_OWNED, no refund issued', async () => {
  const { h, handlers } = await makeStack();
  await h.insertBalance(USER, 1000);

  const first = await purchase(handlers);
  assert.equal(first.status, 201);

  const second = await purchase(handlers);
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'ALREADY_OWNED');

  assert.equal(await debitCount(h), 1);
  assert.equal(await refundCount(h), 0, 'sequential duplicate must not trigger the race refund');
  assert.equal(await balanceOf(h, USER), 500);
});

test('CSM5: concurrent purchase race — one debit, ZERO refunds, no free purchase', async () => {
  // Two purchases race: both pass the getOwnership pre-check before either
  // creates ownership (simulated deterministically via a stale-read wrapper —
  // both requests observe "not owned"). Exactly one request debits for real;
  // the other's debit resolves idempotent (the same refId already paid) and its
  // ownership INSERT conflicts. The losing request MUST NOT refund a payment
  // it never made.
  const stack = await makeStack();
  const { h, handlers, cosmeticsRepo } = stack;
  await h.insertBalance(USER, 1000);

  // Stale-read wrapper: first 2 getOwnership calls see "not owned"
  let ownershipReads = 0;
  const staleRepo = {
    ...cosmeticsRepo,
    getOwnership: async (env, userId, cosmeticId) => {
      ownershipReads++;
      if (ownershipReads <= 2) return null;
      return cosmeticsRepo.getOwnership(env, userId, cosmeticId);
    },
  };
  const raceHandlers = createCosmeticsHandlers({
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    cosmeticsRepo: staleRepo,
    membershipAuthority,
    economyService: stack.economyService,
  });

  const [a, b] = await Promise.allSettled([purchase(raceHandlers), purchase(raceHandlers)]);
  assert.equal(a.status, 'fulfilled', 'A rejected: ' + (a.reason && a.reason.message));
  assert.equal(b.status, 'fulfilled', 'B rejected: ' + (b.reason && b.reason.message));

  const statuses = [a.value.status, b.value.status].sort();
  assert.deepEqual(statuses, [201, 409], 'one purchase succeeds, the other reports ALREADY_OWNED');

  // THE C2 assertions (FAIL on unfixed code):
  assert.equal(await debitCount(h), 1, 'exactly ONE real debit');
  assert.equal(await refundCount(h), 0, 'the idempotent loser MUST NOT receive a refund (free purchase bug)');
  assert.equal(await balanceOf(h, USER), 500, 'net payment must be exactly one cosmetic cost');

  const owned = await h.raw('SELECT COUNT(*)::int AS c FROM user_cosmetic_ownership WHERE user_id = $1', [USER]);
  assert.equal(Number(owned.rows[0].c), 1);
});

test('CSM6 (unit): idempotent debit + ownership conflict → refund MUST be skipped', async () => {
  // Most direct test of the C2 guard: economyService.debitUser reports
  // idempotent:true (a concurrent request with the same refId already paid),
  // createOwnership reports created:false. The controller must NOT refund.
  const refundCalls = [];
  const ecoMock = {
    debitUser: async () => ({ success: true, newBalance: null, txId: 42, idempotent: true }),
    grantReward: async (p) => { refundCalls.push(p); return { success: true }; },
  };
  const handlers = createCosmeticsHandlers({
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    cosmeticsRepo: {
      getById: async () => ({ id: COSMETIC_ID, cosmetic_key: 'k', title: 'T', rarity: 'rare', token_cost: COST }),
      getOwnership: async () => null, // race window: not owned yet
      createOwnership: async () => ({
        ownership: { cosmetic_id: COSMETIC_ID, tokens_spent: COST },
        created: false, // concurrent request created it first
      }),
    },
    membershipAuthority,
    economyService: ecoMock,
  });

  const res = await purchase(handlers);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_OWNED');
  assert.equal(refundCalls.length, 0, 'refund MUST NOT be issued for an idempotent (not actually paid) debit');
});

test('CSM7 (unit): REAL debit + ownership conflict → refund MUST also be skipped (concurrent free-item hole)', async () => {
  // The mirror interleaving of CSM6: THIS request performed the real debit,
  // but a concurrent twin (racing with the same deterministic refId) created
  // the ownership first and resolved idempotently on top of this request's
  // payment. The single completed debit for this refId paid for the ownership
  // that now exists — refunding would hand back the tokens while the user
  // keeps the cosmetic (net free purchase). The guard-only version of the C2
  // fix (refund when !idempotent) still allows this hole; the shipped fix
  // removes the refund from the ownership-conflict path entirely.
  const refundCalls = [];
  const ecoMock = {
    debitUser: async () => ({ success: true, newBalance: 500, txId: 77, idempotent: false }),
    grantReward: async (p) => { refundCalls.push(p); return { success: true }; },
  };
  const handlers = createCosmeticsHandlers({
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    cosmeticsRepo: {
      getById: async () => ({ id: COSMETIC_ID, cosmetic_key: 'k', title: 'T', rarity: 'rare', token_cost: COST }),
      getOwnership: async () => null, // race window: not owned yet
      createOwnership: async () => ({
        ownership: { cosmetic_id: COSMETIC_ID, tokens_spent: COST },
        created: false, // concurrent twin created it first
      }),
    },
    membershipAuthority,
    economyService: ecoMock,
  });

  const res = await purchase(handlers);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'ALREADY_OWNED');
  assert.equal(refundCalls.length, 0, 'the real-debit loser of the ownership race MUST NOT refund — the debit paid for the delivered cosmetic');
});

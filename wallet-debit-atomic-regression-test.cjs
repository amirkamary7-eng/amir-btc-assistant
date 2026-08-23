/**
 * WALLET DEBIT ATOMIC REGRESSION TEST — D-series, CR-series, ES-series
 *
 * FIX C1 (phantom debit) + FIX M4 (ensureSchema) regression suite.
 *
 * Runs the REAL src/repositories/wallet.js debitTokens/creditTokens against a
 * real in-memory PostgreSQL engine (pg-mem) with the production
 * queryDb/queryDbTransaction contract (see wallet-test-harness.cjs).
 *
 * ── D-series: debitTokens ──────────────────────────────────────────────────
 *   D1  sufficient balance
 *   D2  insufficient balance — MUST NOT create any token_transaction (C1 core)
 *   D3  exact balance
 *   D4  zero balance + non-positive amount rejection
 *   D5  concurrent debit, same refId — exactly ONE real debit, no double-spend
 *   D6  duplicate debit (sequential, same refId) — idempotent, no second debit
 *   D7  retry after insufficient — MUST throw again, NOT idempotent success
 *       (kills the free-purchase path: phantom tx + retry = idempotent)
 *   D8  missing balance row — insufficient, no tx, no row created
 *   D9  unique violation (23505) mid-flight — statement rollback + idempotent
 *       resolve (the REAL concurrency safety net, deterministically simulated)
 *
 * ── CR-series: creditTokens idempotency (WALLET-001 regression) ────────────
 *   CR1 normal credit (creates balance row via UPSERT)
 *   CR2 duplicate credit — idempotent, balance untouched
 *   CR3 concurrent credit, same refId — exactly ONE credit
 *   CR4 credit on existing balance row increments correctly
 *   CR5 credit CTE unique-conflict mid-flight — idempotent resolve, no double-credit
 *
 * ── ES-series: ensureSchema (FIX M4) ───────────────────────────────────────
 *   ES1 schema failure must reject AND be retried on next invocation
 *   ES2 debitTokens still works when ensureSchema fails (swallowed by caller)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makePgHarness,
  makeRealStack,
  createWalletRepository,
  txCount,
  balanceOf,
  txRows,
} = require('./wallet-test-harness.cjs');

const ENV = {}; // mocks ignore env contents

function freshWallet(userId, initialBalance) {
  const stack = makeRealStack();
  const p = initialBalance === undefined
    ? Promise.resolve()
    : stack.h.insertBalance(userId, initialBalance);
  return p.then(() => stack);
}

const DEBIT = (repo, uid, amount, refId, opts = {}) =>
  repo.debitTokens(ENV, uid, amount, opts.txType || 'cosmetic_purchase', opts.desc || 'Test debit', refId, opts.metadata || {}, {});

const CREDIT = (repo, uid, amount, refId, txType = 'daily_claim') =>
  repo.creditTokens(ENV, uid, amount, txType, 'Test credit', refId, {}, {});

async function assertInsufficient(promise) {
  await assert.rejects(promise, (e) => e.code === 'INSUFFICIENT_BALANCE');
}

// ═══════════════════════════════════════════════════════════════════════════
// D-SERIES — debitTokens
// ═══════════════════════════════════════════════════════════════════════════

test('D1: sufficient balance — debit succeeds atomically', async () => {
  const { h, walletRepo } = await freshWallet('u_d1', 1000);
  const r = await DEBIT(walletRepo, 'u_d1', 200, 'ref_d1');

  assert.equal(r.success, true);
  assert.equal(r.idempotent, undefined);
  assert.equal(r.newBalance, 800);
  assert.ok(Number.isInteger(r.txId) && r.txId > 0);

  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_d1'), 800);
  const rows = await txRows(h);
  assert.equal(rows[0].amount, -200);
  assert.equal(rows[0].status, 'completed');
  assert.equal(rows[0].ref_id, 'ref_d1');
  assert.equal(rows[0].tx_type, 'cosmetic_purchase');
});

test('D2: insufficient balance — NO transaction row may be created (phantom debit)', async () => {
  // THE C1 regression test: balance=100, cost=500.
  // Old bug: UPDATE matched 0 rows but INSERT ran anyway (gated only on
  // EXISTS(balance >= 0)) → COMMIT happened inside queryDbTransaction BEFORE
  // the JS result check → phantom completed tx with amount=-500.
  const { h, walletRepo } = await freshWallet('u_d2', 100);

  await assertInsufficient(DEBIT(walletRepo, 'u_d2', 500, 'ref_d2'));

  // Phantom assertions — these are the assertions that FAIL on the old code:
  assert.equal(await txCount(h), 0, 'insufficient debit MUST NOT create a token_transactions row');
  assert.equal(await balanceOf(h, 'u_d2'), 100);
});

test('D3: exact balance — debit to zero succeeds', async () => {
  const { h, walletRepo } = await freshWallet('u_d3', 100);
  const r = await DEBIT(walletRepo, 'u_d3', 100, 'ref_d3');

  assert.equal(r.success, true);
  assert.equal(r.newBalance, 0);
  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_d3'), 0);
  // A further debit of even 1 must now fail without side effects
  await assertInsufficient(DEBIT(walletRepo, 'u_d3', 1, 'ref_d3b'));
  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_d3'), 0);
});

test('D4: zero balance + non-positive amount rejection', async () => {
  const { h, walletRepo } = await freshWallet('u_d4', 0);
  await assertInsufficient(DEBIT(walletRepo, 'u_d4', 10, 'ref_d4'));
  assert.equal(await txCount(h), 0);
  assert.equal(await balanceOf(h, 'u_d4'), 0);

  // exactly-zero amount is rejected before touching the DB
  await assert.rejects(DEBIT(walletRepo, 'u_d4', 0, 'ref_d4z'), /Amount must be positive/);
  assert.equal(await txCount(h), 0);

  // PRE-EXISTING CONTRACT (unchanged by C1, out of scope): negative amounts
  // are normalized via Math.abs BEFORE the positivity check — debit(-5) is
  // treated as a debit of 5, NOT rejected. Same normalization exists in
  // economyService.debitUser. With balance 0 → INSUFFICIENT_BALANCE.
  const neg = await DEBIT(walletRepo, 'u_d4', -5, 'ref_d4n').then(() => null, (e) => e);
  assert.ok(neg && neg.code === 'INSUFFICIENT_BALANCE',
    'negative amount is normalized to |amount| → debit of 5 with 0 balance → INSUFFICIENT_BALANCE');
  assert.equal(await txCount(h), 0);
});

test('D5: concurrent debit with same refId — exactly ONE real debit, both resolve', async () => {
  const { h, walletRepo } = await freshWallet('u_d5', 1000);

  const [a, b] = await Promise.allSettled([
    DEBIT(walletRepo, 'u_d5', 300, 'ref_d5'),
    DEBIT(walletRepo, 'u_d5', 300, 'ref_d5'),
  ]);

  // Neither call may reject: the loser must resolve as idempotent
  // (via pre-check fast path OR via 23505 catch-and-reread path).
  assert.equal(a.status, 'fulfilled', 'concurrent debit A must not reject: ' + (a.reason && a.reason.message));
  assert.equal(b.status, 'fulfilled', 'concurrent debit B must not reject: ' + (b.reason && b.reason.message));

  const results = [a.value, b.value];
  const realDebits = results.filter((r) => !r.idempotent);
  const idempotents = results.filter((r) => r.idempotent === true);
  assert.equal(realDebits.length, 1, 'exactly one request performs the real debit');
  assert.equal(idempotents.length, 1, 'exactly one request resolves idempotently');
  assert.equal(realDebits[0].newBalance, 700);

  assert.equal(await txCount(h), 1, 'exactly one transaction row');
  assert.equal(await balanceOf(h, 'u_d5'), 700, 'balance debited exactly once (no double-spend)');
});

test('D6: duplicate debit (sequential, same refId) — idempotent, no second debit', async () => {
  const { h, walletRepo } = await freshWallet('u_d6', 1000);

  const first = await DEBIT(walletRepo, 'u_d6', 200, 'ref_d6');
  assert.equal(first.idempotent, undefined);
  assert.equal(first.newBalance, 800);

  const second = await DEBIT(walletRepo, 'u_d6', 200, 'ref_d6');
  assert.equal(second.success, true);
  assert.equal(second.idempotent, true);
  assert.equal(second.txId, first.txId);
  assert.equal(second.newBalance, null);

  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_d6'), 800);
});

test('D7: retry after insufficient balance — MUST fail again, NOT return idempotent success', async () => {
  // C1 free-purchase killer: on the old code the first (failed) attempt left a
  // phantom completed tx with the same refId, so the retry hit the idempotency
  // pre-check and returned {success:true, idempotent:true} WITHOUT debiting →
  // the caller (cosmetics purchase) then granted ownership for free.
  const { h, walletRepo } = await freshWallet('u_d7', 100);

  await assertInsufficient(DEBIT(walletRepo, 'u_d7', 500, 'ref_d7'));

  // The retry must be treated as a NEW attempt — insufficient again:
  await assertInsufficient(DEBIT(walletRepo, 'u_d7', 500, 'ref_d7'));

  assert.equal(await txCount(h), 0, 'no phantom row after retry either');
  assert.equal(await balanceOf(h, 'u_d7'), 100);

  // And after the user earns enough tokens, the SAME refId must finally succeed
  // (this is the "retry after earning tokens" acceptance case):
  await h.raw('UPDATE token_balances SET balance = $2 WHERE user_id = $1', ['u_d7', 600]);
  const ok = await DEBIT(walletRepo, 'u_d7', 500, 'ref_d7');
  assert.equal(ok.success, true);
  assert.equal(ok.idempotent, undefined);
  assert.equal(ok.newBalance, 100);
  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_d7'), 100);
});

test('D8: missing balance row — insufficient, no tx, no balance row created', async () => {
  const { h, walletRepo } = await freshWallet('u_d8_never_funded');
  await assertInsufficient(DEBIT(walletRepo, 'u_d8_never_funded', 5, 'ref_d8'));
  assert.equal(await txCount(h), 0);
  assert.equal(await balanceOf(h, 'u_d8_never_funded'), null, 'no balance row may be created by a failed debit');
});

test('D9: unique violation (23505) mid-flight — statement rolls back, resolves idempotent', async () => {
  // Single-threaded pg-mem cannot naturally interleave two debitTokens calls
  // between the pre-check and the CTE, so the 23505 catch path (the safety
  // net for REAL concurrent requests) is simulated deterministically: a
  // wrapper commits a "twin" transaction + balance debit at the exact moment
  // this request's CTE is about to run (after its pre-check already saw
  // nothing). The CTE's INSERT then violates the partial unique index →
  // 23505 → the WHOLE statement (balance UPDATE included) must roll back →
  // debitTokens catches 23505, re-reads, and resolves idempotent.
  const base = makePgHarness();
  await base.insertBalance('u_d9', 1000);
  let cteSeen = false;
  // The debit CTE runs via queryDbTransaction — wrap THAT path and commit the
  // twin's transaction + balance debit right before the CTE statement runs.
  const wrappedTxn = async (env, queries) => {
    const first = String((queries && queries[0] && queries[0].sql) || '');
    if (!cteSeen && first.includes('WITH debited AS')) {
      cteSeen = true;
      // The concurrent twin commits first: its debit + its transaction row
      await base.raw(
        `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata)
         VALUES ($1, $2, $3, 'cosmetic', 'completed', 'twin debit', $4, '{}')`,
        ['u_d9', -300, 'cosmetic_purchase', 'ref_d9'],
      );
      await base.raw('UPDATE token_balances SET balance = balance - 300 WHERE user_id = $1', ['u_d9']);
    }
    return base.queryDbTransaction(env, queries);
  };
  const repo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: wrappedTxn,
  });

  const r = await DEBIT(repo, 'u_d9', 300, 'ref_d9');

  // The twin's payment is this request's payment (same refId) → idempotent
  assert.equal(r.success, true);
  assert.equal(r.idempotent, true);
  assert.ok(r.txId > 0, 'txId must point at the twin\'s (i.e. the only) transaction');

  // THE critical assertion: the losing statement's UPDATE must have been
  // rolled back with the failed INSERT — no double-spend (1000 − 300, NOT 400).
  assert.equal(await balanceOf(base, 'u_d9'), 700);
  assert.equal(await txCount(base), 1, 'exactly one transaction row (the twin\'s)');
});

// ═══════════════════════════════════════════════════════════════════════════
// CR-SERIES — creditTokens idempotency (WALLET-001 UPSERT regression)
// ═══════════════════════════════════════════════════════════════════════════

test('CR1: normal credit — creates balance row via UPSERT (WALLET-001)', async () => {
  const { h, walletRepo } = await freshWallet('u_cr1');
  const r = await CREDIT(walletRepo, 'u_cr1', 50, 'daily_2026-01-01');

  assert.equal(r.success, true);
  assert.equal(r.idempotent, undefined);
  // NOTE: r.newBalance is NOT asserted — in a data-modifying CTE, PostgreSQL
  // executes the main SELECT on the pre-statement snapshot, so the existing
  // creditTokens return value is stale by design (pre-existing behavior,
  // documented as finding N12). The DB state below is what matters.
  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_cr1'), 50);
  const rows = await txRows(h);
  assert.equal(rows[0].amount, 50);
  assert.equal(rows[0].status, 'completed');
});

test('CR2: duplicate credit (same refId) — idempotent, balance untouched', async () => {
  const { h, walletRepo } = await freshWallet('u_cr2');
  await CREDIT(walletRepo, 'u_cr2', 50, 'daily_2026-01-02');

  const again = await CREDIT(walletRepo, 'u_cr2', 50, 'daily_2026-01-02');
  assert.equal(again.success, true);
  assert.equal(again.idempotent, true);
  assert.equal(again.newBalance, null);

  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_cr2'), 50);
});

test('CR3: concurrent credit with same refId — exactly ONE credit', async () => {
  const { h, walletRepo } = await freshWallet('u_cr3');

  const [a, b] = await Promise.allSettled([
    CREDIT(walletRepo, 'u_cr3', 30, 'daily_2026-01-03'),
    CREDIT(walletRepo, 'u_cr3', 30, 'daily_2026-01-03'),
  ]);
  assert.equal(a.status, 'fulfilled');
  assert.equal(b.status, 'fulfilled');

  const results = [a.value, b.value];
  assert.equal(results.filter((r) => !r.idempotent).length, 1);
  assert.equal(results.filter((r) => r.idempotent === true).length, 1);

  assert.equal(await txCount(h), 1);
  assert.equal(await balanceOf(h, 'u_cr3'), 30);
});

test('CR4: credit on existing balance row increments correctly', async () => {
  const { h, walletRepo } = await freshWallet('u_cr4', 25);
  const r = await CREDIT(walletRepo, 'u_cr4', 5, 'daily_2026-01-04');
  // r.newBalance not asserted — pre-existing stale-return semantics (see CR1)
  assert.equal(r.success, true);
  assert.equal(r.idempotent, undefined);
  assert.equal(await balanceOf(h, 'u_cr4'), 30);
  assert.equal(await txCount(h), 1);
});

test('CR5: credit CTE unique-conflict mid-flight — ON CONFLICT DO NOTHING, idempotent resolve', async () => {
  // Same deterministic seeding technique as D9, for the credit path: the
  // twin's credit commits between this request's pre-check and its CTE. The
  // CTE's INSERT ... ON CONFLICT DO NOTHING silently skips → tx_insert yields
  // no row → balance_upsert is not fed → creditTokens re-reads and resolves
  // idempotent. (Unlike the debit CTE there is no 23505 here — the credit CTE
  // explicitly uses ON CONFLICT DO NOTHING.)
  const base = makePgHarness();
  let cteSeen = false;
  // The credit CTE runs via queryDbTransaction — wrap THAT path and commit
  // the twin's credit right before the CTE statement runs.
  const wrappedTxn = async (env, queries) => {
    const first = String((queries && queries[0] && queries[0].sql) || '');
    if (!cteSeen && first.includes('balance_upsert')) {
      cteSeen = true;
      await base.raw(
        `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata)
         VALUES ($1, 50, 'daily_claim', 'daily', 'completed', 'twin credit', $2, '{}')`,
        ['u_cr5', 'daily_2026-01-05'],
      );
      await base.raw('INSERT INTO token_balances (user_id, balance) VALUES ($1, 50)', ['u_cr5']);
    }
    return base.queryDbTransaction(env, queries);
  };
  const repo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: wrappedTxn,
  });

  const r = await CREDIT(repo, 'u_cr5', 50, 'daily_2026-01-05');

  assert.equal(r.success, true);
  assert.equal(r.idempotent, true, 'conflicting credit must resolve idempotent, not double-credit');
  assert.equal(await balanceOf(base, 'u_cr5'), 50, 'balance credited exactly once (by the twin)');
  assert.equal(await txCount(base), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// ES-SERIES — ensureSchema (FIX M4)
// ═══════════════════════════════════════════════════════════════════════════

/** pg harness whose queryDb FAILS the ensureSchema batch (controllable). */
function makeSchemaFailHarness() {
  const base = makePgHarness();
  let schemaCalls = 0;
  let failSchema = true;
  const queryDb = async (env, sql, params = []) => {
    if (String(sql).includes('idx_token_tx_user_type_ref')) {
      schemaCalls++;
      if (failSchema) {
        throw new Error('simulated: duplicate rows prevent unique index creation');
      }
      return { rows: [], rowCount: 0 };
    }
    return base.queryDb(env, sql, params);
  };
  return {
    base,
    queryDb,
    queryDbTransaction: base.queryDbTransaction,
    raw: base.raw,
    get schemaCalls() { return schemaCalls; },
    allowSchema() { failSchema = false; },
  };
}

test('ES1: ensureSchema failure must reject and be RETRIED on next invocation (M4)', async () => {
  const h = makeSchemaFailHarness();
  const repo = createWalletRepository({ queryDb: h.queryDb, queryDbTransaction: h.queryDbTransaction });

  // 1st call fails → must reject (old code swallowed and set _schemaVerified=true)
  await assert.rejects(repo.ensureSchema(ENV), /simulated/);
  assert.equal(h.schemaCalls, 1);

  // Schema recovers → next invocation must retry verification (old code: cached skip)
  h.allowSchema();
  await repo.ensureSchema(ENV);
  assert.equal(h.schemaCalls, 2, 'schema verification must be retried after a failure');

  // Now verified → subsequent calls must NOT re-run the batch
  await repo.ensureSchema(ENV);
  assert.equal(h.schemaCalls, 2, 'successful verification must be cached');
});

test('ES2: debitTokens still works when ensureSchema fails (failure swallowed by caller contract)', async () => {
  const h = makeSchemaFailHarness();
  const repo = createWalletRepository({ queryDb: h.queryDb, queryDbTransaction: h.queryDbTransaction });

  await h.base.insertBalance('u_es2', 100);

  // debitTokens internally calls ensureSchema().catch(() => {}) — a failing
  // schema migration must NOT block the debit itself (schema pre-exists).
  const r = await DEBIT(repo, 'u_es2', 40, 'ref_es2');
  assert.equal(r.success, true);
  assert.equal(r.newBalance, 60);
  assert.equal(await txCount(h.base), 1);
});

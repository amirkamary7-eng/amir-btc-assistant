/**
 * WALLET-RACE-CONCURRENCY-TEST
 *
 * Verifies creditTokens behavior across 4 critical scenarios:
 *   1. User without balance row → must still get balance increase (not lost)
 *   2. Duplicate refId → must be idempotent (no double credit, no false idempotent)
 *   3. Concurrent credit (5 parallel) with same refId → exactly ONE credit
 *   4. Existing users (with balance row) → unchanged behavior
 *
 * Uses an in-memory PostgreSQL-like simulator with:
 *   - UNIQUE index on (user_id, tx_type, ref_id) WHERE ref_id IS NOT NULL AND status='completed'
 *   - ON CONFLICT DO NOTHING semantics
 *   - Transaction isolation (within a single queryDbTransaction, all queries see the same snapshot)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Load the real wallet repository source ─────────────────────────────
const walletRepoPath = path.join(__dirname, 'src', 'repositories', 'wallet.js');
const walletSrc = fs.readFileSync(walletRepoPath, 'utf8');

// Transform ESM → CJS so we can require it
const cjsSource = walletSrc
  .replace(/^export\s+function\s+createWalletRepository/m, 'function createWalletRepository')
  + '\nmodule.exports = { createWalletRepository };';

const moduleObj = { exports: {} };
const evaluator = new Function('require', 'module', 'exports', cjsSource);
evaluator(require, moduleObj, moduleObj.exports);
const { createWalletRepository } = moduleObj.exports;

// ── In-memory database simulator with UNIQUE constraint semantics ──────
function createDbSimulator() {
  const state = {
    token_balances: new Map(),       // user_id → { balance, updated_at }
    token_transactions: new Map(),   // id → { user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at }
    nextTxId: 1,
  };

  // Simulates a UNIQUE index on (user_id, tx_type, ref_id) WHERE ref_id IS NOT NULL AND status='completed'
  function findExistingTx(uid, txType, refId) {
    if (!refId) return null;
    for (const tx of state.token_transactions.values()) {
      if (tx.user_id === uid && tx.tx_type === txType && tx.ref_id === refId && tx.status === 'completed') {
        return tx;
      }
    }
    return null;
  }

  // queryDb (autocommit single statement)
  async function queryDb(env, sql, params = []) {
    return executeStatement(sql, params);
  }

  // queryDbTransaction (all statements in one BEGIN..COMMIT batch)
  async function queryDbTransaction(env, queries) {
    // For our simulator, just execute each statement sequentially within a "transaction"
    // (no concurrent transaction can interleave since JS is single-threaded and our statements are sync)
    const results = [];
    for (const { sql, params } of queries) {
      results.push(await executeStatement(sql, params));
    }
    return results;
  }

  function executeStatement(sql, params) {
    const sqlLower = (sql || '').trim().toLowerCase();

    // ALTER TABLE / CREATE INDEX / CREATE TABLE — no-op in sim
    if (sqlLower.startsWith('alter table') || sqlLower.startsWith('create index') ||
        sqlLower.startsWith('create table') || sqlLower.startsWith('create unique')) {
      return { rows: [] };
    }

    // SELECT id, amount FROM token_transactions WHERE user_id AND tx_type AND ref_id AND status='completed' LIMIT 1
    // This is the idempotency pre-check
    if (sqlLower.startsWith('select id, amount from token_transactions') &&
        sqlLower.includes('where user_id = $1') && sqlLower.includes('ref_id = $3')) {
      const uid = String(params[0]);
      const txType = params[1];
      const refId = params[2];
      const existing = findExistingTx(uid, txType, refId);
      return Promise.resolve({ rows: existing ? [{ id: existing.id, amount: existing.amount }] : [] });
    }

    // SELECT id, amount FROM token_transactions WHERE user_id AND tx_type AND ref_id ... LIMIT 1
    // (used in the post-INSERT idempotency path)
    if (sqlLower.startsWith('select id, amount from token_transactions') &&
        sqlLower.includes('limit 1')) {
      const uid = String(params[0]);
      const txType = params[1];
      const refId = params[2];
      const existing = findExistingTx(uid, txType, refId);
      return Promise.resolve({ rows: existing ? [{ id: existing.id, amount: existing.amount }] : [] });
    }

    // SELECT balance FROM token_balances WHERE user_id = $1
    if (sqlLower.startsWith('select balance from token_balances')) {
      const uid = String(params[0]);
      const row = state.token_balances.get(uid);
      return Promise.resolve({ rows: row ? [{ balance: row.balance }] : [] });
    }

    // ── CREDIT CTE (FIXED implementation: UPSERT balance) ──
    // WITH tx_insert AS (
    //   INSERT INTO token_transactions (...) VALUES (...) ON CONFLICT DO NOTHING RETURNING id
    // ),
    // balance_upsert AS (
    //   INSERT INTO token_balances (user_id, balance, updated_at)
    //   SELECT $1, $2, NOW() FROM tx_insert
    //   ON CONFLICT (user_id) DO UPDATE SET balance = balance + EXCLUDED.balance, updated_at = NOW()
    // )
    // SELECT (SELECT id FROM tx_insert LIMIT 1) AS tx_id,
    //        (SELECT balance FROM token_balances WHERE user_id = $1) AS balance
    if (sqlLower.startsWith('with tx_insert as') && sqlLower.includes('balance_upsert')) {
      const uid = String(params[0]);
      const amt = Number(params[1]);
      const txType = params[2];
      const source = params[3];
      const description = params[4];
      const refId = params[5] || null;
      const metadataJson = params[6];

      // Step 1: try INSERT tx (with ON CONFLICT DO NOTHING semantics)
      let txInsertedId = null;
      if (refId) {
        const existing = findExistingTx(uid, txType, refId);
        if (existing) {
          txInsertedId = null;
        } else {
          txInsertedId = state.nextTxId++;
          state.token_transactions.set(txInsertedId, {
            id: txInsertedId, user_id: uid, amount: amt, tx_type: txType,
            source, status: 'completed', description, ref_id: refId,
            metadata: metadataJson, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
        }
      } else {
        txInsertedId = state.nextTxId++;
        state.token_transactions.set(txInsertedId, {
          id: txInsertedId, user_id: uid, amount: amt, tx_type: txType,
          source, status: 'completed', description, ref_id: null,
          metadata: metadataJson, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }

      // Step 2: UPSERT token_balances — ONLY if tx was inserted
      if (txInsertedId !== null) {
        const existingBal = state.token_balances.get(uid);
        if (existingBal) {
          // ON CONFLICT DO UPDATE — balance increment
          existingBal.balance += amt;
          existingBal.updated_at = new Date().toISOString();
        } else {
          // INSERT — create balance row
          state.token_balances.set(uid, {
            balance: amt,
            updated_at: new Date().toISOString(),
          });
        }
        const finalBalance = state.token_balances.get(uid).balance;
        return Promise.resolve({ rows: [{ tx_id: txInsertedId, balance: finalBalance }] });
      } else {
        // tx ON CONFLICT — UPSERT skipped (no tx_insert row)
        // Return tx_id = null so creditTokens detects idempotency
        return Promise.resolve({ rows: [{ tx_id: null, balance: null }] });
      }
    }

    // ── LEGACY CREDIT CTE (buggy UPDATE-only — kept for WALLET-001-BUG test) ──
    // This matches the OLD code that the WALLET-001-BUG test expects.
    if (sqlLower.startsWith('with tx_insert as') && sqlLower.includes('update token_balances')) {
      const uid = String(params[0]);
      const amt = Number(params[1]);
      const txType = params[2];
      const source = params[3];
      const description = params[4];
      const refId = params[5] || null;
      const metadataJson = params[6];

      let txInsertedId = null;
      if (refId) {
        const existing = findExistingTx(uid, txType, refId);
        if (existing) {
          txInsertedId = null;
        } else {
          txInsertedId = state.nextTxId++;
          state.token_transactions.set(txInsertedId, {
            id: txInsertedId, user_id: uid, amount: amt, tx_type: txType,
            source, status: 'completed', description, ref_id: refId,
            metadata: metadataJson, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
          });
        }
      } else {
        txInsertedId = state.nextTxId++;
        state.token_transactions.set(txInsertedId, {
          id: txInsertedId, user_id: uid, amount: amt, tx_type: txType,
          source, status: 'completed', description, ref_id: null,
          metadata: metadataJson, created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }

      // BUG: UPDATE-only — if balance row doesn't exist, 0 rows affected
      if (txInsertedId !== null) {
        const existingBal = state.token_balances.get(uid);
        if (existingBal) {
          existingBal.balance += amt;
          existingBal.updated_at = new Date().toISOString();
          return Promise.resolve({ rows: [{ balance: existingBal.balance, tx_id: txInsertedId }] });
        } else {
          // BUG: balance row doesn't exist! UPDATE affects 0 rows.
          return Promise.resolve({ rows: [] });
        }
      } else {
        return Promise.resolve({ rows: [] });
      }
    }

    return Promise.resolve({ rows: [] });
  }

  return {
    queryDb,
    queryDbTransaction,
    _state: state,
    _reset() {
      state.token_balances.clear();
      state.token_transactions.clear();
      state.nextTxId = 1;
    },
  };
}

// ── Tests ──────────────────────────────────────────────────────────────

// NOTE: WALLET-001-BUG test originally documented the bug (balance lost for
// users without balance row). After the fix, this test now PASSES because
// the fix creates the balance row. The "bug" simulation is preserved in the
// DB simulator (legacy CTE branch) for documentation but the production code
// no longer matches it — creditTokens now uses UPSERT.
test('WALLET-001-FIXED-DOC: User without balance row — credit is NOT lost (fix verified)', async () => {
  const db = createDbSimulator();
  const walletRepo = createWalletRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });
  const env = {};
  const userId = '11111111';

  // User has NO balance row
  assert.equal(db._state.token_balances.size, 0, 'Precondition: no balance row');

  // Credit 10 tokens with a fresh refId
  const result = await walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_test_1');

  console.log('  Result:', result);
  console.log('  token_balances size:', db._state.token_balances.size);
  console.log('  token_transactions size:', db._state.token_transactions.size);

  // AFTER FIX: tx IS inserted AND balance row IS created
  assert.equal(db._state.token_transactions.size, 1, 'Transaction IS inserted');
  assert.equal(db._state.token_balances.size, 1, 'FIX: balance row MUST be created');
  assert.equal(result.idempotent, undefined, 'FIX: not idempotent (first credit — undefined is falsy, fine)');
  assert.equal(result.newBalance, 10);
});

test('WALLET-001-FIXED-1: User without balance row → balance created and increased (after fix)', async () => {
  const db = createDbSimulator();
  const walletRepo = createWalletRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });
  const env = {};
  const userId = '22222222';

  // User has NO balance row
  assert.equal(db._state.token_balances.size, 0);

  const result = await walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_fix_1');

  // AFTER FIX: balance row should be created with 10, NOT idempotent
  assert.equal(db._state.token_balances.size, 1, 'FIX: balance row MUST be created');
  const bal = db._state.token_balances.get(userId);
  assert.equal(bal.balance, 10, 'FIX: balance MUST be 10');
  assert.equal(db._state.token_transactions.size, 1, 'Transaction inserted');
  assert.equal(result.idempotent, undefined, 'FIX: not idempotent (undefined is falsy)');
  assert.equal(result.success, true);
  assert.equal(result.newBalance, 10);
  assert.ok(result.txId, 'txId must be set');
});

test('WALLET-001-FIXED-2: Duplicate refId → one transaction, one balance increase, second call idempotent', async () => {
  const db = createDbSimulator();
  const walletRepo = createWalletRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });
  const env = {};
  const userId = '33333333';

  // First credit
  const r1 = await walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_dup_1');
  assert.equal(r1.idempotent, undefined, 'First call: not idempotent (undefined is falsy)');
  assert.equal(r1.newBalance, 10);

  // Second credit with SAME refId
  const r2 = await walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_dup_1');
  assert.equal(r2.idempotent, true, 'Second call: MUST be idempotent');
  assert.equal(r2.newBalance, null, 'Second call: newBalance null (idempotent)');

  // Verify only ONE transaction and balance is exactly 10
  assert.equal(db._state.token_transactions.size, 1, 'Only ONE transaction');
  const bal = db._state.token_balances.get(userId);
  assert.equal(bal.balance, 10, 'Balance MUST be exactly 10 (no double credit)');
});

test('WALLET-001-FIXED-3: 5 concurrent credits with same refId → exactly ONE credit', async () => {
  const db = createDbSimulator();
  const walletRepo = createWalletRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });
  const env = {};
  const userId = '44444444';

  // Fire 5 concurrent credits with same refId
  const results = await Promise.all([
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_1'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_1'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_1'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_1'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_1'),
  ]);

  const idempotentCount = results.filter(r => r.idempotent === true).length;
  // Success path returns no `idempotent` field (undefined is falsy)
  const realCreditCount = results.filter(r => !r.idempotent).length;
  console.log(`  Results: ${realCreditCount} real credit(s), ${idempotentCount} idempotent`);

  // EXACTLY ONE real credit, the rest idempotent
  assert.equal(realCreditCount, 1, 'EXACTLY ONE real credit (race-safe)');
  assert.equal(idempotentCount, 4, '4 idempotent responses');

  assert.equal(db._state.token_transactions.size, 1, 'EXACTLY ONE transaction');
  const bal = db._state.token_balances.get(userId);
  assert.equal(bal.balance, 10, 'Balance MUST be exactly 10');
});

test('WALLET-001-FIXED-4: Existing users (with balance row) → unchanged behavior', async () => {
  const db = createDbSimulator();
  const walletRepo = createWalletRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });
  const env = {};
  const userId = '55555555';

  // Pre-create balance row with 100
  db._state.token_balances.set(userId, { balance: 100, updated_at: new Date().toISOString() });

  const r1 = await walletRepo.creditTokens(env, userId, 5, 'daily_claim', 'test', 'ref_existing_1');
  assert.equal(r1.idempotent, undefined, 'First call: not idempotent (undefined is falsy)');
  assert.equal(r1.newBalance, 105, 'Balance 100 + 5 = 105');

  // Same refId → idempotent
  const r2 = await walletRepo.creditTokens(env, userId, 5, 'daily_claim', 'test', 'ref_existing_1');
  assert.equal(r2.idempotent, true);

  const bal = db._state.token_balances.get(userId);
  assert.equal(bal.balance, 105, 'Balance MUST be 105 (no double)');

  // Different refId → another credit
  const r3 = await walletRepo.creditTokens(env, userId, 5, 'daily_claim', 'test', 'ref_existing_2');
  assert.equal(r3.idempotent, undefined);
  assert.equal(r3.newBalance, 110);

  assert.equal(db._state.token_transactions.size, 2);
});

test('WALLET-001-FIXED-5: User without balance row — 5 concurrent with same refId → balance created exactly once', async () => {
  const db = createDbSimulator();
  const walletRepo = createWalletRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });
  const env = {};
  const userId = '66666666';

  // User has NO balance row. Fire 5 concurrent credits with same refId.
  const results = await Promise.all([
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_no_bal'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_no_bal'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_no_bal'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_no_bal'),
    walletRepo.creditTokens(env, userId, 10, 'mission_reward', 'test', 'ref_concurrent_no_bal'),
  ]);

  const idempotentCount = results.filter(r => r.idempotent === true).length;
  const realCreditCount = results.filter(r => !r.idempotent).length;
  console.log(`  Results: ${realCreditCount} real credit(s), ${idempotentCount} idempotent`);

  // AFTER FIX: balance row created, exactly ONE credit, balance = 10
  assert.equal(realCreditCount, 1, 'EXACTLY ONE real credit even without balance row');
  assert.equal(idempotentCount, 4, '4 idempotent');
  assert.equal(db._state.token_balances.size, 1, 'Balance row created');
  const bal = db._state.token_balances.get(userId);
  assert.equal(bal.balance, 10, 'Balance exactly 10');
  assert.equal(db._state.token_transactions.size, 1, 'EXACTLY ONE transaction');
});

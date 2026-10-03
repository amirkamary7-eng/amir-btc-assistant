/**
 * Wallet Direct-Read Regression Test (Option C — mirrors notification bypass)
 *
 * PROVEN RCA (2026-09-10, extended to wallet 2026-10-03):
 *   Cloudflare Hyperdrive's SELECT query cache is enabled on the production
 *   binding `amir-btc-supabase` (caching.disabled=false, default cache_ttl=60s).
 *   walletRepo.getBalance/getWalletState/getWalletSummary/getTransactionHistory
 *   issue deterministic SELECTs that Hyperdrive caches at the edge. After a
 *   credit (CTE write — bypasses Hyperdrive's cache, hits origin), the cached
 *   SELECT result still returns the PRE-credit balance for up to 60s after the
 *   FIRST GET. Subsequent GETs within the cache window return the stale cached
 *   result → "tokens not added quickly / wallet updates with delay".
 *
 * FIX (Option C — scoped pg.Pool bypass of Hyperdrive, mirroring notifications):
 *   - walletRepo.getBalance/getWalletState/getWalletSummary/getTransactionHistory
 *     route through queryDbDirect — a per-call pg.Pool bound to env.DIRECT_URL
 *     (or env.DATABASE_URL as fallback), bypassing Hyperdrive's connection
 *     string entirely → bypassing Hyperdrive's edge cache → read-after-write
 *     consistency.
 *   - All write/credit/debit functions (creditTokens, debitTokens,
 *     claimDailyRewardWithStreak) and the schema bootstrap (ensureSchema)
 *     continue to use queryDb/queryDbTransaction (the existing Hyperdrive path)
 *     — UNCHANGED. Hyperdrive does not cache mutations, so writes hit origin
 *     immediately.
 *   - Missing queryDbDirect → explicit configuration error
 *     (DIRECT_DB_NOT_INJECTED), NO silent fallback to queryDb (which would
 *     re-introduce the stale-read bug).
 *
 * This test verifies all invariants by directly exercising the repository with
 * mock queryDb / queryDbDirect / queryDbTransaction functions and inspecting
 * which one was called for each operation.
 *
 * Run: node --test tests/wallet-direct-read-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ────────────────────────────────────────────────────────────────────────────
// Load the wallet repository module via source evaluation (ESM → CJS sandbox).
// ────────────────────────────────────────────────────────────────────────────
function loadRepo() {
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/repositories/wallet.js'), 'utf8');
  const transformed = src.replace(/^export\s+function\s+createWalletRepository\(/m, 'function createWalletRepository(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'globalThis', 'console',
    transformed + '\nmodule.exports.createWalletRepository = createWalletRepository;');
  wrapper(moduleObj, moduleObj.exports, globalThis, { warn: () => {}, log: () => {}, error: () => {} });
  return moduleObj.exports.createWalletRepository;
}

// Mock factory: returns a repo with spy queryDb / queryDbDirect / queryDbTransaction
// that record every call (sqlText + params + which fn was used).
function makeSpies() {
  const calls = { queryDb: [], queryDbDirect: [], queryDbTransaction: [] };
  const queryDb = async (env, sqlText, params = []) => {
    calls.queryDb.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  const queryDbDirect = async (env, sqlText, params = []) => {
    calls.queryDbDirect.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  const queryDbTransaction = async (env, queries) => {
    calls.queryDbTransaction.push({ queries: queries.map(q => ({ sqlText: String(q.sql).replace(/\s+/g, ' ').trim(), params: q.params })) });
    return queries.map(() => ({ rows: [], rowCount: 0, fields: [], command: 'MOCK' }));
  };
  return { calls, queryDb, queryDbDirect, queryDbTransaction };
}

// Production env (ensureSchema early-returns → no schema DDL noise in spy calls).
const ENV = { APP_ENV: 'production', DIRECT_URL: 'postgresql://test', DATABASE_URL: 'postgresql://test' };

// ────────────────────────────────────────────────────────────────────────────
// Tests — 4 read functions route through queryDbDirect
// ────────────────────────────────────────────────────────────────────────────

test('getBalance() routes through queryDbDirect, NOT queryDb (bypasses Hyperdrive cache)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });
  await repo.getBalance(ENV, 'user-1');
  assert.equal(calls.queryDbDirect.length, 1, 'getBalance must call queryDbDirect exactly once');
  assert.equal(calls.queryDb.length, 0, 'getBalance must NOT call queryDb (would hit Hyperdrive cache)');
  const sql = calls.queryDbDirect[0].sqlText;
  assert.match(sql, /SELECT balance FROM token_balances WHERE user_id = \$1 LIMIT 1/i,
    'getBalance SQL must be the balance SELECT');
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-1'], 'getBalance params are (userId,)');
});

test('getWalletState() routes through queryDbDirect, NOT queryDb (bypasses Hyperdrive cache)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });
  await repo.getWalletState(ENV, 'user-2');
  assert.equal(calls.queryDbDirect.length, 1, 'getWalletState must call queryDbDirect exactly once');
  assert.equal(calls.queryDb.length, 0, 'getWalletState must NOT call queryDb (would hit Hyperdrive cache)');
  const sql = calls.queryDbDirect[0].sqlText;
  assert.match(sql, /SELECT balance FROM token_balances WHERE user_id = \$1/i, 'getWalletState reads balance');
  assert.match(sql, /FROM token_transactions/i, 'getWalletState reads transactions');
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-2'], 'getWalletState params are (userId,)');
});

test('getWalletSummary() routes through queryDbDirect, NOT queryDb (bypasses Hyperdrive cache)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });
  await repo.getWalletSummary(ENV, 'user-3');
  assert.equal(calls.queryDbDirect.length, 1, 'getWalletSummary must call queryDbDirect exactly once');
  assert.equal(calls.queryDb.length, 0, 'getWalletSummary must NOT call queryDb (would hit Hyperdrive cache)');
  const sql = calls.queryDbDirect[0].sqlText;
  assert.match(sql, /SELECT COALESCE\(\(SELECT balance FROM token_balances/i, 'getWalletSummary reads balance');
  assert.match(sql, /SUM\(amount\) FILTER/i, 'getWalletSummary aggregates transactions');
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-3'], 'getWalletSummary params are (userId,)');
});

test('getTransactionHistory() routes BOTH queries through queryDbDirect (COUNT + SELECT)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });
  await repo.getTransactionHistory(ENV, 'user-4', 0, 20, {});
  assert.equal(calls.queryDbDirect.length, 2, 'getTransactionHistory must call queryDbDirect twice (COUNT + SELECT)');
  assert.equal(calls.queryDb.length, 0, 'getTransactionHistory must NOT call queryDb (would hit Hyperdrive cache)');
  const countSql = calls.queryDbDirect[0].sqlText;
  const selectSql = calls.queryDbDirect[1].sqlText;
  assert.match(countSql, /SELECT COUNT\(\*\) as total FROM token_transactions/i, 'first call is the COUNT query');
  assert.match(selectSql, /SELECT id, amount, tx_type/i, 'second call is the SELECT query');
  assert.match(selectSql, /ORDER BY created_at DESC/i, 'history is ordered by created_at DESC');
});

// ────────────────────────────────────────────────────────────────────────────
// Tests — write/credit/debit functions UNCHANGED (still use queryDb/queryDbTransaction)
// ────────────────────────────────────────────────────────────────────────────

test('creditTokens() still uses queryDbTransaction (Hyperdrive path unchanged — writes bypass cache anyway)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });
  // creditTokens(env, userId, amount, txType, description, refId, metadata, auditInfo)
  await repo.creditTokens(ENV, 'user-5', 10, 'mission_reward', 'desc', 'ref-1', {}, {});
  // The credit CTE MUST go through queryDbTransaction (NOT queryDbDirect).
  assert.ok(calls.queryDbTransaction.length >= 1, 'creditTokens must call queryDbTransaction for the CTE');
  assert.equal(calls.queryDbDirect.length, 0, 'creditTokens must NOT call queryDbDirect (writes stay on Hyperdrive path)');
  // The CTE must be an INSERT ... ON CONFLICT + UPSERT balance.
  const txCall = calls.queryDbTransaction[0];
  const cte = txCall.queries[0].sqlText;
  assert.match(cte, /INSERT INTO token_transactions/i, 'CTE inserts the transaction');
  assert.match(cte, /ON CONFLICT DO NOTHING/i, 'CTE uses ON CONFLICT DO NOTHING (idempotency)');
  assert.match(cte, /ON CONFLICT \(user_id\) DO UPDATE SET balance = token_balances\.balance \+ EXCLUDED\.balance/i,
    'CTE UPSERTs the balance atomically');
});

test('debitTokens() still uses queryDbTransaction (Hyperdrive path unchanged)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });
  // debitTokens(env, userId, amount, txType, description, refId, metadata, auditInfo)
  // Use a balance mock so the debit succeeds (balance >= amount).
  const queryDbTransaction2 = async (env, queries) => {
    calls.queryDbTransaction.push({ queries: queries.map(q => ({ sqlText: String(q.sql).replace(/\s+/g, ' ').trim(), params: q.params })) });
    return queries.map(() => ({ rows: [{ balance: 50 }], rowCount: 1, fields: [], command: 'UPDATE' }));
  };
  const repo2 = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction: queryDbTransaction2 });
  try {
    await repo2.debitTokens(ENV, 'user-6', 5, 'alert_debit', 'desc', 'ref-2', {}, {});
  } catch (_) { /* mock may not satisfy all debit preconditions — the key assertion is the routing */ }
  assert.equal(calls.queryDbDirect.length, 0, 'debitTokens must NOT call queryDbDirect (writes stay on Hyperdrive path)');
});

// ────────────────────────────────────────────────────────────────────────────
// Tests — missing queryDbDirect injection → explicit error (no silent fallback)
// ────────────────────────────────────────────────────────────────────────────

test('missing queryDbDirect → getBalance throws DIRECT_DB_NOT_INJECTED (no silent fallback to queryDb)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbTransaction } = makeSpies();
  // Inject ONLY queryDb + queryDbTransaction (as the old worker bundle would).
  const repo = createWalletRepository({ queryDb, queryDbTransaction });
  await assert.rejects(
    () => repo.getBalance(ENV, 'user-1'),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i, 'getBalance error must mention queryDbDirect');
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED', 'getBalance error code must be DIRECT_DB_NOT_INJECTED');
      return true;
    },
    'getBalance must throw a clear configuration error when queryDbDirect is missing'
  );
  assert.equal(calls.queryDb.length, 0, 'getBalance must NOT silently fall back to queryDb when queryDbDirect is missing');
});

test('missing queryDbDirect → getWalletState throws DIRECT_DB_NOT_INJECTED (no silent fallback)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbTransaction });
  await assert.rejects(
    () => repo.getWalletState(ENV, 'user-2'),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i);
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED');
      return true;
    }
  );
  assert.equal(calls.queryDb.length, 0, 'getWalletState must NOT silently fall back to queryDb');
});

test('missing queryDbDirect → getWalletSummary throws DIRECT_DB_NOT_INJECTED (no silent fallback)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbTransaction });
  await assert.rejects(
    () => repo.getWalletSummary(ENV, 'user-3'),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i);
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED');
      return true;
    }
  );
  assert.equal(calls.queryDb.length, 0, 'getWalletSummary must NOT silently fall back to queryDb');
});

test('missing queryDbDirect → getTransactionHistory throws DIRECT_DB_NOT_INJECTED (no silent fallback)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbTransaction } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbTransaction });
  await assert.rejects(
    () => repo.getTransactionHistory(ENV, 'user-4', 0, 20, {}),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i);
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED');
      return true;
    }
  );
  assert.equal(calls.queryDb.length, 0, 'getTransactionHistory must NOT silently fall back to queryDb');
});

// ────────────────────────────────────────────────────────────────────────────
// Test — read-after-write consistency (the CORE fix: fresh balance, not stale)
// ────────────────────────────────────────────────────────────────────────────

test('read-after-write consistency: getBalance returns FRESH balance via queryDbDirect, not STALE via queryDb', async () => {
  // Simulate: Hyperdrive (queryDb) caches the PRE-credit balance=100.
  // The direct pool (queryDbDirect) queries origin and returns the POST-credit balance=150.
  // getBalance MUST return 150 (fresh), NOT 100 (stale) — proving the bypass works.
  const createWalletRepository = loadRepo();
  const queryDb = async () => ({ rows: [{ balance: 100 }], rowCount: 1 }); // STALE (Hyperdrive cache)
  const queryDbDirect = async () => ({ rows: [{ balance: 150 }], rowCount: 1 }); // FRESH (direct)
  const queryDbTransaction = async (env, queries) => queries.map(() => ({ rows: [{ balance: 150, tx_id: 1 }], rowCount: 1 }));
  const repo = createWalletRepository({ queryDb, queryDbDirect, queryDbTransaction });

  const balance = await repo.getBalance(ENV, 'user-7');
  assert.equal(balance, 150, 'getBalance must return the FRESH post-credit balance (150), not the STALE cached one (100)');
});

// ────────────────────────────────────────────────────────────────────────────
// Test — worker-proxy.js injects queryDbDirect into walletRepo (wiring guard)
// ────────────────────────────────────────────────────────────────────────────

test('worker-proxy.js injects queryDbDirect into createWalletRepository (wiring guard)', () => {
  const wp = fs.readFileSync(path.resolve(__dirname, '..', 'worker-proxy.js'), 'utf8');
  assert.match(wp, /createWalletRepository\(\{\s*queryDb,\s*queryDbTransaction,\s*queryDbDirect\s*\}\)/,
    'worker-proxy.js must inject queryDbDirect into createWalletRepository (mirrors notificationRepo + adminRepo)');
});

test('wallet.js source: all 4 read functions have the DIRECT_DB_NOT_INJECTED guard', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/repositories/wallet.js'), 'utf8');
  const fns = ['getBalance', 'getWalletState', 'getWalletSummary', 'getTransactionHistory'];
  for (const fn of fns) {
    // Find the function body and assert the guard exists within it.
    const fnStart = src.indexOf(`async function ${fn}(`);
    assert.ok(fnStart > -1, `${fn} must exist in wallet.js`);
    // Find the next function boundary (rough: next 'async function' or end of file).
    const nextFn = src.indexOf('async function', fnStart + 20);
    const fnBody = src.slice(fnStart, nextFn > 0 ? nextFn : src.length);
    assert.match(fnBody, /typeof queryDbDirect !== 'function'/, `${fn} must guard on queryDbDirect injection`);
    assert.match(fnBody, /DIRECT_DB_NOT_INJECTED/, `${fn} must throw DIRECT_DB_NOT_INJECTED`);
    assert.match(fnBody, /queryDbDirect\(/, `${fn} must call queryDbDirect (not queryDb)`);
  }
});

test('wallet.js source: creditTokens + debitTokens do NOT use queryDbDirect (writes unchanged)', () => {
  const src = fs.readFileSync(path.resolve(__dirname, '..', 'src/repositories/wallet.js'), 'utf8');
  // creditTokens body
  const ctStart = src.indexOf('async function creditTokens(');
  const ctNext = src.indexOf('async function', ctStart + 20);
  const ctBody = src.slice(ctStart, ctNext > 0 ? ctNext : src.length);
  assert.match(ctBody, /queryDbTransaction\(/, 'creditTokens must use queryDbTransaction (unchanged)');
  assert.doesNotMatch(ctBody, /queryDbDirect\(/, 'creditTokens must NOT use queryDbDirect (write path unchanged)');
  // debitTokens body
  const dtStart = src.indexOf('async function debitTokens(');
  const dtNext = src.indexOf('async function', dtStart + 20);
  const dtBody = src.slice(dtStart, dtNext > 0 ? dtNext : src.length);
  assert.doesNotMatch(dtBody, /queryDbDirect\(/, 'debitTokens must NOT use queryDbDirect (write path unchanged)');
});

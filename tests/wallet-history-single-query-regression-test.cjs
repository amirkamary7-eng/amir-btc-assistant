/**
 * PERF-04A — Wallet History Single-Query Regression Test
 *
 * CHANGE UNDER TEST (Phase 44 / PERF-04A):
 *   walletRepo.getTransactionHistory previously issued TWO sequential
 *   queryDbDirect calls (COUNT + page SELECT) = TWO direct pg.Pool
 *   constructions (two TLS handshakes, additive latency) per request on
 *   GET /api/wallet/history. It now issues ONE combined query:
 *
 *     SELECT
 *       COALESCE(json_agg(p ORDER BY p.created_at DESC)
 *                 FILTER (WHERE p.id IS NOT NULL), '[]') AS items,
 *       (SELECT COUNT(*) FROM token_transactions <where>) AS total
 *     FROM (
 *       SELECT id, amount, tx_type, source, status, description, ref_id,
 *              metadata, created_at, updated_at
 *       FROM token_transactions <where>
 *       ORDER BY created_at DESC
 *       LIMIT $n OFFSET $m
 *     ) p
 *
 *   - Mirrors the getWalletState CTE/aggregate precedent (single query to
 *     avoid multiple Pool creations — CPU limit) in the same repository.
 *   - The total comes from a scalar COUNT subquery over the SAME where
 *     clause, so it is pagination-independent (LIMIT/OFFSET apply only to
 *     the page subquery).
 *   - A bare aggregate always returns exactly ONE row: an empty page still
 *     yields items='[]' plus the TRUE total (the property COUNT(*) OVER()
 *     lacks — zero rows lose the count — which is why the window-function
 *     form was rejected in the Phase 43 audit).
 *   - Read routing is UNCHANGED: still queryDbDirect (bypasses Hyperdrive
 *     cache → read-after-write consistency), still no queryDb fallback.
 *   - API contract UNCHANGED: { total, offset, limit, hasMore,
 *     transactions:[serializeTxRow...] } — verified byte-for-byte below.
 *
 * PROOF STRATEGY:
 *   A. Spy tests — the REAL src/repositories/wallet.js is executed with mock
 *      deps; exactly ONE queryDbDirect call, correct SQL shape, correct
 *      param order, correct output mapping (items as array — real pg parses
 *      the json type; items as string — defensive path; null row).
 *   B. Behavioral equivalence — the OLD implementation (verbatim extracted
 *      copy, pattern documented in stale-pool-concurrency-test.cjs) and the
 *      NEW real implementation are both executed against REAL in-memory
 *      PostgreSQL (pg-mem, same engine as wallet-test-harness.cjs) with
 *      identical fixtures. Outputs must be deep-equal across: pagination
 *      pages, boundary pages (exact-end, partial, beyond-range), empty
 *      users, LIMIT 0, LIMIT > total, type/status filters (incl. no-match),
 *      NULL-heavy rows, ordering, and count-independence.
 *      The OLD copy is kept as the equivalence oracle — do not "fix" it to
 *      match future changes; update the extraction provenance instead.
 *
 * pg-mem notes (probed before writing this test — see Phase 44 worklog):
 *   - json_agg(row ORDER BY ...) + FILTER + COALESCE + scalar subquery in
 *     the select list all execute VERBATIM in pg-mem (json_build_object and
 *     row_to_json do NOT exist — which is why the combined query aggregates
 *     the subquery row directly).
 *   - pg-mem returns scalar-subquery results as arrays ([v] / []); real
 *     PostgreSQL returns scalars. The harness below unwraps ONLY the `total`
 *     column (harness shim #3 precedent from wallet-test-harness.cjs).
 *   - pg-mem's json_agg returns timestampts as ISO strings; the real pg
 *     driver returns top-level timestamptz columns as Date objects. Both
 *     converge in serializeTxRow via new Date(x).toISOString().
 *
 * Run: node --test tests/wallet-history-single-query-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { newDb } = require('pg-mem');

const ROOT = path.join(__dirname, '..');

// Production env — APP_ENV 'production' short-circuits ensureSchema
// (PROD-DDL-SKIP), so no DDL interception is needed in this harness.
const ENV = { APP_ENV: 'production', DIRECT_URL: 'postgresql://test', DATABASE_URL: 'postgresql://test' };

// ────────────────────────────────────────────────────────────────────────────
// Load the REAL repository module (source eval, ESM → CJS sandbox — same
// loader pattern as wallet-direct-read-regression-test.cjs).
// ────────────────────────────────────────────────────────────────────────────
function loadRepo() {
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/wallet.js'), 'utf8');
  const transformed = src.replace(/^export\s+function\s+createWalletRepository\(/m, 'function createWalletRepository(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'globalThis', 'console',
    transformed + '\nmodule.exports.createWalletRepository = createWalletRepository;');
  wrapper(moduleObj, moduleObj.exports, globalThis, { warn: () => {}, log: () => {}, error: () => {} });
  return moduleObj.exports.createWalletRepository;
}

// ────────────────────────────────────────────────────────────────────────────
// OLD IMPLEMENTATION — extracted VERBATIM from src/repositories/wallet.js at
// commit 2860a038 (pre-PERF-04A HEAD), minus the module-scope
// DIRECT_DB_NOT_INJECTED guard and the ensureSchema call (both are
// environment plumbing identical in old/new shapes; the guard is asserted
// separately below and in wallet-direct-read-regression-test.cjs).
// This copy is the EQUIVALENCE ORACLE — keep it frozen.
// ────────────────────────────────────────────────────────────────────────────
function oldSerializeTxRow(row) {
  let metadata = {};
  try {
    if (row.metadata) {
      metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
    }
  } catch {}
  return {
    id: row.id,
    amount: Number(row.amount),
    type: row.tx_type,
    source: row.source || 'system',
    status: row.status || 'completed',
    description: row.description,
    ref_id: row.ref_id,
    metadata,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
  };
}

async function oldGetTransactionHistory(queryDbDirect, env, userId, offset = 0, limit = 20, filters = {}) {
  const params = [String(userId)];
  let whereClause = 'WHERE user_id = $1';
  let paramIdx = 2;

  if (filters.type) {
    whereClause += ` AND tx_type = $${paramIdx++}`;
    params.push(filters.type);
  }
  if (filters.status) {
    whereClause += ` AND status = $${paramIdx++}`;
    params.push(filters.status);
  }

  const countResult = await queryDbDirect(
    env,
    `SELECT COUNT(*) as total FROM token_transactions ${whereClause}`,
    params,
  );
  const total = Number(countResult.rows[0]?.total || 0);

  params.push(Number(limit), Number(offset));
  const historyResult = await queryDbDirect(
    env,
    `
      SELECT id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at
      FROM token_transactions
      ${whereClause}
      ORDER BY created_at DESC
      LIMIT $${paramIdx++} OFFSET $${paramIdx++}
    `,
    params,
  );

  return {
    total,
    offset,
    limit,
    hasMore: offset + limit < total,
    transactions: historyResult.rows.map(oldSerializeTxRow),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// pg-mem mini-harness (subset of wallet-test-harness.cjs — only what
// getTransactionHistory needs; documented divergences in the header).
// ────────────────────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE token_transactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    amount INTEGER NOT NULL,
    tx_type VARCHAR(32) NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'system',
    status VARCHAR(16) NOT NULL DEFAULT 'completed',
    description VARCHAR(256),
    ref_id VARCHAR(64),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  )
`;

// Interpolate $N → SQL literal (pg-mem binds everything as TEXT — harness
// note #1 from wallet-test-harness.cjs; real PG coerces from context).
function interpolate(sql, params = []) {
  let out = sql;
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    let lit;
    if (v === null || v === undefined) lit = 'NULL';
    else if (typeof v === 'number') lit = String(v);
    else if (typeof v === 'boolean') lit = v ? 'TRUE' : 'FALSE';
    else lit = `'${String(v).replace(/'/g, `''`)}'`;
    out = out.split('$' + (i + 1)).join(lit);
  }
  return out;
}

// Deterministic fixture (explicit timestamps everywhere — NOW() would differ
// between the two engines and break deep-equal on updated_at).
const FIXTURE_SQL = `
  INSERT INTO token_transactions
    (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at) VALUES
    ('u1', 10, 'credit', 'system',    'completed', 'd1',  NULL, '{"k":1}',              '2026-01-01T10:00:00Z', '2026-01-01T10:00:01Z'),
    ('u1', 20, 'debit',  'mission',   'completed', 'd2',  'r2', '{}',                   '2026-01-02T10:00:00Z', '2026-01-02T10:00:01Z'),
    ('u1',  5, 'credit', 'system',    'pending',   'd3',  'r3', NULL,                   '2026-01-03T10:00:00Z', '2026-01-03T10:00:01Z'),
    ('u1',  7, 'credit', 'admin',     'completed', NULL,  NULL, NULL,                   '2026-01-04T10:00:00Z', '2026-01-04T10:00:01Z'),
    ('u1',  1, 'debit',  'system',    'pending',   'd5',  'r5', '{}',                   '2026-01-05T10:00:00Z', '2026-01-05T10:00:01Z'),
    ('u1',  3, 'credit', 'mission',   'completed', 'd6',  'r6', '{"nested":{"a":1}}',   '2026-01-06T10:00:00Z', '2026-01-06T10:00:01Z'),
    ('u1',  9, 'reward', 'system',    'completed', 'd7',  NULL, '{}',                   '2026-01-07T10:00:00Z', '2026-01-07T10:00:01Z'),
    ('u2', 99, 'credit', 'system',    'completed', 'other-user', NULL, '{}',            '2026-01-08T10:00:00Z', '2026-01-08T10:00:01Z'),
    ('u4', 50, 'credit', 'system',    'completed', 'x1',  NULL, '{}',                   '2026-02-01T10:00:00Z', '2026-02-01T10:00:01Z'),
    ('u4', 60, 'credit', 'system',    'completed', 'x2',  NULL, '{}',                   '2026-02-02T10:00:00Z', '2026-02-02T10:00:01Z')
  `;

function makeDb() {
  const db = newDb();
  db.public.many(SCHEMA_SQL);
  db.public.many(FIXTURE_SQL);
  const Pool = db.adapters.createPg().Pool;
  const calls = [];
  async function queryDbDirect(env, sqlText, params = []) {
    calls.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params: [...params] });
    const pool = new Pool();
    try {
      const r = await pool.query(interpolate(String(sqlText), params), []);
      // Scalar-subquery unwrap (pg-mem returns [v]/[]; real PG returns v/NULL)
      // — applied ONLY to the `total` column (harness shim #3 precedent);
      // `items` (json_agg) is a legitimate array and must stay untouched.
      const rows = r.rows.map((row) => {
        if (Array.isArray(row.total)) row.total = row.total.length ? row.total[0] : null;
        return row;
      });
      return { rows, rowCount: r.rowCount };
    } finally {
      try { pool.end(); } catch {}
    }
  }
  return { queryDbDirect, calls };
}

function makeRepo(queryDbDirect) {
  const createWalletRepository = loadRepo();
  return createWalletRepository({
    queryDb: async () => { throw new Error('queryDb must NOT be called by getTransactionHistory'); },
    queryDbTransaction: async () => { throw new Error('queryDbTransaction must NOT be called by getTransactionHistory'); },
    queryDbDirect,
  });
}

// Mock factory for pure spy tests (records calls; returns canned results).
function makeSpies() {
  const calls = { queryDb: [], queryDbDirect: [] };
  const queryDb = async (env, sqlText, params = []) => {
    calls.queryDb.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  const queryDbDirect = async (env, sqlText, params = []) => {
    calls.queryDbDirect.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [{ items: [], total: 0 }], rowCount: 1, fields: [], command: 'SELECT' };
  };
  return { calls, queryDb, queryDbDirect };
}

// ────────────────────────────────────────────────────────────────────────────
// A. SPY TESTS — one call, SQL shape, params, output mapping
// ────────────────────────────────────────────────────────────────────────────

test('A1: getTransactionHistory issues EXACTLY ONE queryDbDirect call (and NO queryDb)', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  await repo.getTransactionHistory(ENV, 'user-1', 0, 20, {});
  assert.equal(calls.queryDbDirect.length, 1, 'must call queryDbDirect exactly ONCE (combined page+total query)');
  assert.equal(calls.queryDb.length, 0, 'must NOT call queryDb (would hit Hyperdrive cache)');
});

test('A2: combined SQL shape — json_agg page aggregate + scalar COUNT subquery over the SAME where clause', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  await repo.getTransactionHistory(ENV, 'user-1', 0, 20, {});
  const sql = calls.queryDbDirect[0].sqlText;
  // Page columns are all present in the subquery select list
  assert.match(sql, /SELECT id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at/i,
    'page subquery selects the same 10 columns as before');
  // Ordering preserved
  assert.match(sql, /ORDER BY created_at DESC/i, 'page subquery still orders by created_at DESC');
  assert.match(sql, /json_agg\(p ORDER BY p\.created_at DESC\)/i, 'json_agg preserves DESC order in the aggregated items');
  // Total via scalar COUNT subquery (pagination-independent)
  assert.match(sql, /\(SELECT COUNT\(\*\) FROM token_transactions WHERE user_id = \$1\) AS total/i,
    'total comes from a scalar COUNT subquery over the same where clause');
  // LIMIT/OFFSET live INSIDE the page subquery (not the outer query)
  assert.match(sql, /LIMIT \$2 OFFSET \$3 \) p$/i, 'LIMIT/OFFSET close the page subquery; the outer aggregate query has no LIMIT');
  // Empty-page safety net
  assert.match(sql, /COALESCE\(\s*json_agg/i, 'COALESCE guards the empty-page (zero-row) case');
  assert.match(sql, /'\[\]'\s*\) AS items/i, "COALESCE fallback literal is an empty JSON array '[]'");
});

test('A3: param order is (userId, [type, [status,]] limit, offset) — no filters', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  await repo.getTransactionHistory(ENV, 'user-9', 4, 7, {});
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-9', 7, 4], 'params = (userId, limit, offset)');
});

test('A4: param order with type + status filters', async () => {
  const createWalletRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  await repo.getTransactionHistory(ENV, 'user-9', 0, 20, { type: 'credit', status: 'completed' });
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-9', 'credit', 'completed', 20, 0],
    'params = (userId, type, status, limit, offset)');
  const sql = calls.queryDbDirect[0].sqlText;
  // The SAME $-params are referenced by BOTH where clauses (page + count)
  assert.match(sql, /WHERE user_id = \$1 AND tx_type = \$2 AND status = \$3 ORDER BY/i, 'page where clause');
  assert.match(sql, /\(SELECT COUNT\(\*\) FROM token_transactions WHERE user_id = \$1 AND tx_type = \$2 AND status = \$3\)/i,
    'count subquery reuses the same params');
  assert.match(sql, /LIMIT \$4 OFFSET \$5 \) p$/i, 'LIMIT/OFFSET indices follow the filter params');
});

test('A5: output mapping — items ARRAY (real pg parses json type) with serializeTxRow semantics', async () => {
  const createWalletRepository = loadRepo();
  const calls = { queryDb: [], queryDbDirect: [] };
  const queryDb = async () => ({ rows: [], rowCount: 0 });
  const queryDbDirect = async () => ({
    rows: [{
      items: [
        { id: 7, amount: 9, tx_type: 'reward', source: null, status: null, description: 'd7', ref_id: null, metadata: null, created_at: '2026-01-07T10:00:00.000Z', updated_at: '2026-01-07T10:00:01.000Z' },
        { id: 6, amount: 3, tx_type: 'credit', source: 'mission', status: 'completed', description: 'd6', ref_id: 'r6', metadata: { nested: { a: 1 } }, created_at: '2026-01-06T10:00:00.000Z', updated_at: '2026-01-06T10:00:01.000Z' },
      ],
      total: 7,
    }],
    rowCount: 1,
  });
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  const out = await repo.getTransactionHistory(ENV, 'u1', 0, 2, {});
  assert.deepEqual(out, {
    total: 7,
    offset: 0,
    limit: 2,
    hasMore: true, // 0 + 2 < 7
    transactions: [
      { id: 7, amount: 9, type: 'reward', source: 'system', status: 'completed', description: 'd7', ref_id: null, metadata: {}, created_at: '2026-01-07T10:00:00.000Z', updated_at: '2026-01-07T10:00:01.000Z' },
      { id: 6, amount: 3, type: 'credit', source: 'mission', status: 'completed', description: 'd6', ref_id: 'r6', metadata: { nested: { a: 1 } }, created_at: '2026-01-06T10:00:00.000Z', updated_at: '2026-01-06T10:00:01.000Z' },
    ],
  });
});

test('A6: output mapping — items as JSON STRING (defensive path for string-returning drivers)', async () => {
  const createWalletRepository = loadRepo();
  const queryDb = async () => ({ rows: [], rowCount: 0 });
  const queryDbDirect = async () => ({
    rows: [{
      items: JSON.stringify([{ id: 1, amount: 5, tx_type: 'credit', source: 'system', status: 'pending', description: 'd', ref_id: null, metadata: '{"m":2}', created_at: '2026-01-03T10:00:00.000Z', updated_at: '2026-01-03T10:00:01.000Z' }]),
      total: 1,
    }],
    rowCount: 1,
  });
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  const out = await repo.getTransactionHistory(ENV, 'u1', 0, 20, {});
  assert.equal(out.total, 1);
  assert.equal(out.transactions.length, 1);
  assert.deepEqual(out.transactions[0].metadata, { m: 2 }, 'string metadata inside string items is parsed');
  assert.equal(out.transactions[0].created_at, '2026-01-03T10:00:00.000Z');
});

test('A7: output mapping — missing row / null items → empty transactions, total 0', async () => {
  const createWalletRepository = loadRepo();
  const queryDb = async () => ({ rows: [], rowCount: 0 });
  const queryDbDirect = async () => ({ rows: [], rowCount: 0 });
  const repo = createWalletRepository({ queryDb, queryDbDirect });
  const out = await repo.getTransactionHistory(ENV, 'u1', 0, 20, {});
  assert.deepEqual(out, { total: 0, offset: 0, limit: 20, hasMore: false, transactions: [] });
});

test('A8: hasMore math unchanged (boundary cases)', async () => {
  const createWalletRepository = loadRepo();
  const mk = (total) => async () => ({ rows: [{ items: [], total }], rowCount: 1 });
  const repo = (total) => createWalletRepository({ queryDb: async () => ({}), queryDbDirect: mk(total) });
  assert.equal((await repo(7).getTransactionHistory(ENV, 'u', 4, 3, {})).hasMore, false, '4+3 === 7 → false');
  assert.equal((await repo(7).getTransactionHistory(ENV, 'u', 3, 3, {})).hasMore, true, '3+3 < 7 → true');
  assert.equal((await repo(7).getTransactionHistory(ENV, 'u', 0, 0, {})).hasMore, true, '0+0 < 7 → true (LIMIT 0 keeps count semantics)');
  assert.equal((await repo(0).getTransactionHistory(ENV, 'u', 0, 20, {})).hasMore, false, '0 total → false');
});

test('A9: missing queryDbDirect injection still throws DIRECT_DB_NOT_INJECTED (fail-closed, unchanged)', async () => {
  const createWalletRepository = loadRepo();
  const repo = createWalletRepository({ queryDb: async () => ({ rows: [], rowCount: 0 }) });
  await assert.rejects(
    () => repo.getTransactionHistory(ENV, 'u', 0, 20, {}),
    (err) => err.code === 'DIRECT_DB_NOT_INJECTED',
  );
});

// ────────────────────────────────────────────────────────────────────────────
// B. BEHAVIORAL EQUIVALENCE — OLD (2 queries) vs NEW (1 query) on pg-mem
// ────────────────────────────────────────────────────────────────────────────

async function runEquivalence(label, userId, offset, limit, filters) {
  const oldDb = makeDb();
  const newDb = makeDb();
  const oldOut = await oldGetTransactionHistory(oldDb.queryDbDirect, ENV, userId, offset, limit, filters);
  const repo = makeRepo(newDb.queryDbDirect);
  const newOut = await repo.getTransactionHistory(ENV, userId, offset, limit, filters);

  // Call-count contracts (the actual optimization under test)
  assert.equal(oldDb.calls.length, 2, `${label}: OLD issues 2 direct queries (count + page)`);
  assert.equal(newDb.calls.length, 1, `${label}: NEW issues exactly 1 direct query`);

  // Full output equivalence
  assert.deepEqual(newOut, oldOut, `${label}: NEW output must deep-equal OLD output`);
  return newOut;
}

test('B1: page 1 (offset 0, limit 3) — 3 newest rows, hasMore true', async () => {
  const out = await runEquivalence('page1', 'u1', 0, 3, {});
  assert.equal(out.total, 7);
  assert.equal(out.transactions.length, 3);
  assert.deepEqual(out.transactions.map((t) => t.id), [7, 6, 5], 'DESC order (newest first)');
  assert.equal(out.hasMore, true);
});

test('B2: page 2 (offset 3, limit 3)', async () => {
  const out = await runEquivalence('page2', 'u1', 3, 3, {});
  assert.equal(out.total, 7);
  assert.deepEqual(out.transactions.map((t) => t.id), [4, 3, 2]);
  assert.equal(out.hasMore, true);
});

test('B3: last partial page (offset 6, limit 3) — 1 row, hasMore false', async () => {
  const out = await runEquivalence('lastPartial', 'u1', 6, 3, {});
  assert.equal(out.total, 7);
  assert.deepEqual(out.transactions.map((t) => t.id), [1]);
  assert.equal(out.hasMore, false);
});

test('B4: exact boundary (offset 4, limit 3) — offset+limit === total, hasMore false', async () => {
  const out = await runEquivalence('exactEnd', 'u1', 4, 3, {});
  assert.equal(out.total, 7);
  assert.deepEqual(out.transactions.map((t) => t.id), [3, 2, 1]);
  assert.equal(out.hasMore, false, '4+3 === 7 must be hasMore=false');
});

test('B5: offset beyond total (offset 10) — empty page, count still returned', async () => {
  const out = await runEquivalence('beyond', 'u1', 10, 3, {});
  assert.equal(out.total, 7);
  assert.deepEqual(out.transactions, []);
  assert.equal(out.hasMore, false);
});

test('B6: unknown user — total 0, empty page (single-row aggregate proves itself)', async () => {
  const out = await runEquivalence('unknown', 'nobody', 0, 20, {});
  assert.deepEqual(out, { total: 0, offset: 0, limit: 20, hasMore: false, transactions: [] });
});

test('B7: known user with zero transactions', async () => {
  const out = await runEquivalence('zeroTxUser', 'u3', 0, 20, {});
  assert.deepEqual(out, { total: 0, offset: 0, limit: 20, hasMore: false, transactions: [] });
});

test('B8: LIMIT 0 — empty page, count preserved, hasMore true', async () => {
  const out = await runEquivalence('limit0', 'u1', 0, 0, {});
  assert.equal(out.total, 7);
  assert.deepEqual(out.transactions, []);
  assert.equal(out.hasMore, true, '0+0 < 7 → true (identical to old math)');
});

test('B9: limit > total — all rows in one page', async () => {
  const out = await runEquivalence('bigLimit', 'u1', 0, 50, {});
  assert.equal(out.total, 7);
  assert.deepEqual(out.transactions.map((t) => t.id), [7, 6, 5, 4, 3, 2, 1]);
  assert.equal(out.hasMore, false);
});

test('B10: filter type=credit only (count independent of limit/offset)', async () => {
  const p1 = await runEquivalence('filterType p1', 'u1', 0, 2, { type: 'credit' });
  assert.equal(p1.total, 4, 'credit count = 4 (t1,t3,t4,t6)');
  assert.deepEqual(p1.transactions.map((t) => t.id), [6, 4]);
  const p2 = await runEquivalence('filterType p2', 'u1', 2, 2, { type: 'credit' });
  assert.equal(p2.total, 4, 'count stays 4 on page 2 (pagination-independent)');
  assert.deepEqual(p2.transactions.map((t) => t.id), [3, 1]);
  assert.equal(p2.hasMore, false);
});

test('B11: filter status=pending only', async () => {
  const out = await runEquivalence('filterStatus', 'u1', 0, 20, { status: 'pending' });
  assert.equal(out.total, 2);
  assert.deepEqual(out.transactions.map((t) => t.id), [5, 3]);
});

test('B12: filter type + status combined', async () => {
  const out = await runEquivalence('filterBoth', 'u1', 0, 20, { type: 'credit', status: 'completed' });
  assert.equal(out.total, 3, 'credit+completed = t1,t4,t6');
  assert.deepEqual(out.transactions.map((t) => t.id), [6, 4, 1]);
});

test('B13: filter with zero matches — total 0, empty page', async () => {
  const out = await runEquivalence('filterNoMatch', 'u1', 0, 20, { type: 'nope' });
  assert.deepEqual(out, { total: 0, offset: 0, limit: 20, hasMore: false, transactions: [] });
});

test('B14: filters + pagination + boundary', async () => {
  const out = await runEquivalence('filterPage', 'u1', 1, 2, { type: 'credit' });
  assert.equal(out.total, 4);
  // DESC credit list = [6,4,3,1]; offset 1 + limit 2 → [4,3]
  assert.deepEqual(out.transactions.map((t) => t.id), [4, 3]);
  assert.equal(out.hasMore, true, '1+2 < 4');
});

test('B15: exactly-limit rows (user u4, limit 2) — full page, hasMore false', async () => {
  const out = await runEquivalence('exactLimit', 'u4', 0, 2, {});
  assert.equal(out.total, 2);
  assert.deepEqual(out.transactions.map((t) => t.id), [10, 9]);
  assert.equal(out.hasMore, false);
});

test('B16: NULL-heavy rows serialize identically (NULL desc/ref/metadata, per-user isolation)', async () => {
  const out = await runEquivalence('nullRows', 'u2', 0, 20, {});
  assert.equal(out.total, 1);
  const tx = out.transactions[0];
  assert.equal(tx.id, 8);
  assert.equal(tx.description, 'other-user');
  assert.equal(tx.ref_id, null);
  assert.deepEqual(tx.metadata, {}, 'NULL metadata → {}');
  // Row t4 (u1) exercises NULL description/ref/metadata via page queries:
  const outU1 = await runEquivalence('nullRows u1 page', 'u1', 3, 1, {});
  const t4 = outU1.transactions[0];
  assert.equal(t4.id, 4);
  assert.equal(t4.description, null);
  assert.equal(t4.source, 'admin');
  assert.deepEqual(t4.metadata, {});
});

test('B17: count is independent of LIMIT/OFFSET across all pages of u1', async () => {
  for (const [off, lim] of [[0, 3], [3, 3], [6, 3], [0, 50], [10, 3]]) {
    const out = await runEquivalence(`indep ${off}/${lim}`, 'u1', off, lim, {});
    assert.equal(out.total, 7, `total must stay 7 at offset=${off} limit=${lim}`);
  }
});

test('B18: ordering is created_at DESC everywhere (json_agg ORDER BY matches old page ORDER BY)', async () => {
  const out = await runEquivalence('ordering', 'u1', 0, 7, {});
  const ids = out.transactions.map((t) => t.id);
  assert.deepEqual(ids, [7, 6, 5, 4, 3, 2, 1]);
  for (let i = 1; i < out.transactions.length; i++) {
    assert.ok(out.transactions[i - 1].created_at >= out.transactions[i].created_at, 'created_at non-increasing');
  }
});

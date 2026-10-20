/**
 * PERF-04B — Notification List+Unread Single-Query Regression Test
 *
 * CHANGE UNDER TEST (Phase 45 / PERF-04B):
 *   GET /api/notifications previously issued TWO PARALLEL queryDbDirect
 *   calls (notificationRepo.list + notificationRepo.unreadCount via
 *   Promise.all in controllers/notifications.js handleList) = TWO direct
 *   pg.Pool constructions (two TLS handshakes) per request on the
 *   highest-frequency authenticated route (frontend polls every 60s with
 *   error backoff). The repository now exposes listWithUnread(), which
 *   returns the exact same data with ONE queryDbDirect call:
 *
 *     SELECT
 *       COALESCE(json_agg(n ORDER BY n.created_at DESC)
 *                 FILTER (WHERE n.id IS NOT NULL), '[]') AS items,
 *       (SELECT COUNT(*)::int FROM notifications
 *          WHERE user_id = $1 AND read_status = FALSE
 *            AND deleted_at IS NULL) AS unread_count
 *     FROM (
 *       SELECT id, user_id, type, title, message, metadata, read_status, created_at
 *       FROM notifications
 *       WHERE user_id = $1 AND deleted_at IS NULL
 *       ORDER BY created_at DESC
 *       LIMIT $2
 *     ) n
 *
 *   - Mirrors the PERF-04A getTransactionHistory precedent (wallet.js,
 *     commit ac2d875a) — json_agg single-row aggregate + scalar COUNT
 *     subquery, NOT COUNT(*) OVER() (which loses the count on empty pages;
 *     rejection rationale in the Phase 43 audit).
 *   - The page subquery is EXACTLY the old list() SELECT (same 8 columns,
 *     same WHERE, same ORDER BY, same LIMIT/clamp). The unread count comes
 *     from a scalar subquery with the exact unreadCount() WHERE clause —
 *     INDEPENDENT of LIMIT.
 *   - A bare aggregate always returns exactly ONE row: an empty page still
 *     yields items='[]' plus the TRUE unread count.
 *   - Read routing UNCHANGED: still queryDbDirect (bypasses Hyperdrive
 *     cache → read-after-write consistency), still no queryDb fallback,
 *     still DIRECT_DB_NOT_INJECTED fail-closed.
 *   - list() and unreadCount() remain exported and UNCHANGED (their
 *     contracts are pinned by notif-direct-read-regression-test.cjs).
 *   - API contract UNCHANGED: { status:'success', notifications:[…],
 *     unread_count:<number> } — verified below via the controller.
 *   - One snapshot instead of two parallel ones: list and count can no
 *     longer diverge under concurrent writes (strictly more consistent;
 *     for any fixed DB state outputs are byte-identical — proven below).
 *
 * PROOF STRATEGY:
 *   A. Spy tests — the REAL src/repositories/notifications.js is executed
 *      with mock deps; exactly ONE queryDbDirect call, correct SQL shape,
 *      correct param order, limit clamp matrix, output mapping (items as
 *      array — real pg parses the json type; items as string — defensive
 *      path; empty rows), fail-closed guard, and the scope guard (list /
 *      unreadCount / exports untouched).
 *   C. Controller tests — the REAL src/controllers/notifications.js is
 *      executed with mock deps; handleList calls listWithUnread EXACTLY
 *      ONCE and never list/unreadCount; response contract {status,
 *      notifications, unread_count:number}; limit passthrough; 503 /
 *      error / auth paths unchanged.
 *   B. Behavioral equivalence — the OLD implementation (verbatim extracted
 *      copy, frozen-oracle pattern documented in
 *      wallet-history-single-query-regression-test.cjs) and the NEW real
 *      implementation are both executed against REAL in-memory PostgreSQL
 *      (pg-mem, production notifications schema shape from
 *      scripts/00-migrate.sql:1078-1097) with identical fixtures. Outputs
 *      must be deep-equal across: default/edge limits, clamp inputs,
 *      mixed read/unread, all-read, empty users, unknown users, user
 *      isolation, soft-deleted exclusion, ordering, count-independence,
 *      and read-after-write visibility.
 *
 * pg-mem notes (probed before writing this test — see Phase 45 worklog):
 *   - json_agg(row ORDER BY …) + FILTER + COALESCE + scalar subquery in the
 *     select list all execute VERBATIM in pg-mem.
 *   - pg-mem returns scalar-subquery results as arrays ([v] / []); real
 *     PostgreSQL returns scalars. The harness below unwraps ONLY the
 *     `unread_count` column (harness shim precedent from the PERF-04A
 *     wallet harness `total` column). Number(x || 0) in the implementation
 *     covers both shapes regardless.
 *   - pg-mem's json_agg returns timestamptz as ISO strings; the real pg
 *     driver returns top-level timestamptz columns as Date objects. Both
 *     converge in serializeRow via new Date(x).toISOString().
 *
 * Run: node --test tests/notif-list-unread-single-query-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');
const { newDb } = require('pg-mem');

const ROOT = path.join(__dirname, '..');

// Production env — APP_ENV 'production' short-circuits ensureTable
// (PROD-DDL-SKIP), and list/unreadCount/listWithUnread never call
// ensureTable anyway (matching the old read-path behavior).
const ENV = { APP_ENV: 'production', DIRECT_URL: 'postgresql://test', DATABASE_URL: 'postgresql://test' };

// ────────────────────────────────────────────────────────────────────────────
// Load the REAL repository module (source eval, ESM → CJS sandbox — same
// loader pattern as notif-direct-read-regression-test.cjs).
// ────────────────────────────────────────────────────────────────────────────
function loadRepo() {
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/notifications.js'), 'utf8');
  const transformed = src.replace(/^export\s+function\s+createNotificationRepository\(/m, 'function createNotificationRepository(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'globalThis', 'console',
    transformed + '\nmodule.exports.createNotificationRepository = createNotificationRepository;');
  wrapper(moduleObj, moduleObj.exports, globalThis, { warn: () => {}, log: () => {}, error: () => {} });
  return moduleObj.exports.createNotificationRepository;
}

// ────────────────────────────────────────────────────────────────────────────
// Load the REAL controller module (source eval, ESM → CJS sandbox).
// ────────────────────────────────────────────────────────────────────────────
function loadController() {
  const src = fs.readFileSync(path.join(ROOT, 'src/controllers/notifications.js'), 'utf8');
  const transformed = src.replace(/^export\s+function\s+createNotificationHandlers\(/m, 'function createNotificationHandlers(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'globalThis', 'console',
    transformed + '\nmodule.exports.createNotificationHandlers = createNotificationHandlers;');
  wrapper(moduleObj, moduleObj.exports, globalThis, { warn: () => {}, log: () => {}, error: () => {} });
  return moduleObj.exports.createNotificationHandlers;
}

// ────────────────────────────────────────────────────────────────────────────
// OLD IMPLEMENTATION — extracted VERBATIM from src/repositories/notifications.js
// at commit ac2d875a (pre-PERF-04B HEAD), minus the DIRECT_DB_NOT_INJECTED
// guards (asserted separately below and in notif-direct-read-regression-test.cjs).
// This copy is the EQUIVALENCE ORACLE — keep it frozen.
// ────────────────────────────────────────────────────────────────────────────
function oldSerializeRow(row) {
  return {
    id: String(row.id),
    type: String(row.type),
    title: String(row.title || ''),
    message: String(row.message || ''),
    metadata: row.metadata || null,
    read: Boolean(row.read_status),
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  };
}

async function oldListAndUnread(queryDbDirect, env, userId, limit = 50) {
  const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
  const listResult = await queryDbDirect(
    env,
    `
      SELECT id, user_id, type, title, message, metadata, read_status, created_at
      FROM notifications
      WHERE user_id = $1 AND deleted_at IS NULL
      ORDER BY created_at DESC
      LIMIT $2
    `,
    [String(userId), safeLimit],
  );
  const cntResult = await queryDbDirect(
    env,
    `
      SELECT COUNT(*)::int AS count
      FROM notifications
      WHERE user_id = $1 AND read_status = FALSE AND deleted_at IS NULL
    `,
    [String(userId)],
  );
  return {
    notifications: listResult.rows.map((row) => oldSerializeRow(row)),
    unreadCount: cntResult.rows[0]?.count || 0,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// pg-mem mini-harness — REAL production notifications schema shape
// (scripts/00-migrate.sql:1078-1097; FK omitted — SELECT semantics only).
// ────────────────────────────────────────────────────────────────────────────
const SCHEMA_SQL = `
  CREATE TABLE notifications (
    id          TEXT PRIMARY KEY,
    user_id     TEXT NOT NULL,
    type        TEXT NOT NULL,
    title       TEXT NOT NULL DEFAULT '',
    message     TEXT NOT NULL DEFAULT '',
    metadata    JSONB,
    read_status BOOLEAN NOT NULL DEFAULT FALSE,
    created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    deleted_at  TIMESTAMPTZ,
    priority    VARCHAR(16) NOT NULL DEFAULT 'medium',
    category    VARCHAR(32) NOT NULL DEFAULT 'system',
    channel     VARCHAR(32) NOT NULL DEFAULT 'mini_app',
    status      VARCHAR(16) NOT NULL DEFAULT 'delivered',
    archived    BOOLEAN NOT NULL DEFAULT FALSE,
    action_url  TEXT,
    icon        VARCHAR(64),
    read_at     TIMESTAMPTZ,
    expires_at  TIMESTAMPTZ
  )
`;

// Deterministic fixture (explicit distinct timestamps — tie order is
// nondeterministic in the OLD scheme itself, not a regression class).
// u-main: 6 active (3 unread newest + 3 read older) + 2 soft-deleted
// (one unread, one read — both must vanish from items AND count);
// u-allread: 3 read; u-empty: none; u-other: 1 read + 1 unread.
const FIXTURE_SQL = `
  INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, created_at, deleted_at) VALUES
    ('n06', 'u-main', 'system',  'T6', 'M6', '{"k":6}',   FALSE, '2026-01-06T10:00:00Z', NULL),
    ('n05', 'u-main', 'alert',   'T5', 'M5', NULL,        FALSE, '2026-01-05T10:00:00Z', NULL),
    ('n04', 'u-main', 'reward',  '',   'M4', '{"k":4}',   FALSE, '2026-01-04T10:00:00Z', NULL),
    ('n03', 'u-main', 'system',  'T3', '',   '{}',        TRUE,  '2026-01-03T10:00:00Z', NULL),
    ('n02', 'u-main', 'news',    'T2', 'M2', '{"nested":{"a":1}}', TRUE, '2026-01-02T10:00:00Z', NULL),
    ('n01', 'u-main', 'system',  'T1', 'M1', '{"k":1}',   TRUE,  '2026-01-01T10:00:00Z', NULL),
    ('d02', 'u-main', 'system',  'TD2','MD2','{"k":9}',   FALSE, '2026-01-07T10:00:00Z', '2026-01-08T10:00:00Z'),
    ('d01', 'u-main', 'system',  'TD1','MD1','{}',        TRUE,  '2026-01-08T10:00:00Z', '2026-01-09T10:00:00Z'),
    ('a03', 'u-allread', 'system','TA3','MA3','{}',       TRUE,  '2026-02-03T10:00:00Z', NULL),
    ('a02', 'u-allread', 'system','TA2','MA2','{}',       TRUE,  '2026-02-02T10:00:00Z', NULL),
    ('a01', 'u-allread', 'system','TA1','MA1','{}',       TRUE,  '2026-02-01T10:00:00Z', NULL),
    ('o02', 'u-other',  'system','OO2','MO2','{}',        FALSE, '2026-03-02T10:00:00Z', NULL),
    ('o01', 'u-other',  'system','OO1','MO1','{}',        TRUE,  '2026-03-01T10:00:00Z', NULL)
`;

// Interpolate $N → SQL literal (pg-mem binds everything as TEXT — harness
// note from wallet-test-harness.cjs; real PG coerces from context).
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
      // — applied ONLY to the `unread_count` column (PERF-04A harness shim
      // precedent for `total`); `items` (json_agg) is a legitimate array.
      const rows = r.rows.map((row) => {
        if (Array.isArray(row.unread_count)) {
          row.unread_count = row.unread_count.length ? row.unread_count[0] : null;
        }
        return row;
      });
      return { rows, rowCount: r.rowCount };
    } finally {
      try { pool.end(); } catch {}
    }
  }
  return { db, queryDbDirect, calls };
}

function makeRepo(queryDbDirect) {
  const createNotificationRepository = loadRepo();
  return createNotificationRepository({
    queryDb: async () => { throw new Error('queryDb must NOT be called by listWithUnread'); },
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
    return { rows: [{ items: [], unread_count: 0 }], rowCount: 1, fields: [], command: 'SELECT' };
  };
  return { calls, queryDb, queryDbDirect };
}

// Controller mock deps + request factory.
function makeControllerDeps(repo, opts = {}) {
  const state = { jsonResponse: null, dbError: null, authCalled: 0 };
  const deps = {
    jsonResponse: (body, init, env) => {
      state.jsonResponse = { body, init: init || {}, env };
      return { __jsonResponse: true };
    },
    authenticateTelegramRequest: async () => {
      state.authCalled++;
      return { user: { id: 'auth-fallback-user' }, error: null };
    },
    safeDbErrorResponse: (error, init, env) => {
      state.dbError = { message: error?.message || String(error), init: init || {}, env };
      return { __dbError: true };
    },
    safeError: () => 'safe-error',
    isDatabaseConfigured: () => (opts.dbConfigured !== false),
    notificationRepo: repo,
  };
  return { deps, state };
}

function makeRepoSpy(opts = {}) {
  const calls = { listWithUnread: [], list: [], unreadCount: [] };
  const repo = {
    listWithUnread: async (env, userId, limit) => {
      calls.listWithUnread.push({ env, userId, limit });
      if (opts.throwFrom === 'listWithUnread') throw new Error('repo boom');
      return {
        notifications: [{
          id: 'n1', type: 'system', title: 'T', message: 'M',
          metadata: null, read: false, created_at: '2026-01-06T10:00:00.000Z',
        }],
        unreadCount: 3,
      };
    },
    list: async (...args) => { calls.list.push(args); return []; },
    unreadCount: async (...args) => { calls.unreadCount.push(args); return 0; },
  };
  return { calls, repo };
}

function makeRequest(opts = {}) {
  const url = 'https://app.example.com/api/notifications'
    + (opts.limit !== undefined ? `?limit=${opts.limit}` : '');
  return { url, _protectedUser: opts.noProtectedUser ? null : { id: 'user-1' } };
}

// ────────────────────────────────────────────────────────────────────────────
// A. SPY TESTS — one call, SQL shape, params, clamp, output mapping, guards
// ────────────────────────────────────────────────────────────────────────────

test('A1: listWithUnread issues EXACTLY ONE queryDbDirect call (and NO queryDb)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.listWithUnread(ENV, 'user-1', 50);
  assert.equal(calls.queryDbDirect.length, 1, 'must call queryDbDirect exactly ONCE (combined list+unread query)');
  assert.equal(calls.queryDb.length, 0, 'must NOT call queryDb (would hit Hyperdrive cache)');
});

test('A2: combined SQL shape — json_agg page aggregate + scalar COUNT subquery with the unreadCount() where clause', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.listWithUnread(ENV, 'user-1', 50);
  const sql = calls.queryDbDirect[0].sqlText;
  // Page subquery = the OLD list() SELECT shape (same 8 columns, same WHERE, same ORDER BY)
  assert.match(sql, /SELECT id, user_id, type, title, message, metadata, read_status, created_at FROM notifications/i,
    'page subquery selects the same 8 columns as the old list()');
  assert.match(sql, /ORDER BY created_at DESC/i, 'page subquery still orders by created_at DESC');
  assert.match(sql, /json_agg\(n ORDER BY n\.created_at DESC\)/i, 'json_agg preserves DESC order in the aggregated items');
  // Unread count via scalar COUNT subquery (LIMIT-independent), exact unreadCount() where clause
  assert.match(sql, /\(SELECT COUNT\(\*\)::int FROM notifications WHERE user_id = \$1 AND read_status = FALSE AND deleted_at IS NULL\) AS unread_count/i,
    'unread_count comes from a scalar COUNT subquery with the exact unreadCount() WHERE clause');
  // Page filter excludes soft-deleted rows
  assert.match(sql, /WHERE user_id = \$1 AND deleted_at IS NULL/i,
    'page subquery filters soft-deleted rows');
  // LIMIT lives INSIDE the page subquery (not the outer aggregate query)
  assert.match(sql, /LIMIT \$2 \) n$/i, 'LIMIT closes the page subquery; the outer aggregate query has no LIMIT');
  // Empty-page safety net
  assert.match(sql, /COALESCE\( json_agg/i, 'COALESCE guards the empty-page (zero-row) case');
  assert.match(sql, /'\[\]' \) AS items/i, "COALESCE fallback literal is an empty JSON array '[]'");
});

test('A3: params are (String(userId), safeLimit) — same order/typing as the old list() call', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.listWithUnread(ENV, 12345, 25);
  assert.deepEqual(calls.queryDbDirect[0].params, ['12345', 25], 'params must be [String(userId), numeric safeLimit]');
});

test('A4: limit clamp matrix — identical to the old list() clamp', async () => {
  const createNotificationRepository = loadRepo();
  const clampCases = [
    [undefined, 50], [null, 50], [0, 50], ['abc', 50], [NaN, 50],
    [-5, 1], [-100, 1], [1, 1], [3, 3], [100, 100], [500, 100], [5000, 100],
  ];
  for (const [input, expected] of clampCases) {
    const { calls, queryDb, queryDbDirect } = makeSpies();
    const repo = createNotificationRepository({ queryDb, queryDbDirect });
    await repo.listWithUnread(ENV, 'u', input);
    assert.equal(calls.queryDbDirect.length, 1, `exactly one call for limit=${String(input)}`);
    assert.equal(calls.queryDbDirect[0].params[1], expected,
      `limit ${JSON.stringify(input)} must clamp to ${expected}`);
  }
});

test('A5: output mapping — items array → notifications via serializeRow, unread_count → number', async () => {
  const createNotificationRepository = loadRepo();
  const rawRow = {
    id: 'n1', user_id: 'u1', type: 'system', title: 'T', message: 'M',
    metadata: { k: 1 }, read_status: true, created_at: '2026-01-06T10:00:00.000Z',
  };
  const queryDbDirect = async () => ({ rows: [{ items: [rawRow], unread_count: 7 }], rowCount: 1 });
  const repo = createNotificationRepository({ queryDb: async () => { throw new Error('no'); }, queryDbDirect });
  const out = await repo.listWithUnread(ENV, 'u1', 50);
  assert.deepEqual(out.notifications, [{
    id: 'n1', type: 'system', title: 'T', message: 'M',
    metadata: { k: 1 }, read: true, created_at: '2026-01-06T10:00:00.000Z',
  }], 'rows pass through serializeRow exactly as list() did');
  assert.equal(out.unreadCount, 7);
  assert.equal(typeof out.unreadCount, 'number', 'unreadCount must be a number');
});

test('A6: defensive path — items returned as a JSON STRING is parsed (driver variance)', async () => {
  const createNotificationRepository = loadRepo();
  const rawRow = { id: 'n2', type: 'alert', title: '', message: '', metadata: null, read_status: false, created_at: '2026-01-05T10:00:00.000Z' };
  const queryDbDirect = async () => ({ rows: [{ items: JSON.stringify([rawRow]), unread_count: 0 }], rowCount: 1 });
  const repo = createNotificationRepository({ queryDb: async () => { throw new Error('no'); }, queryDbDirect });
  const out = await repo.listWithUnread(ENV, 'u2', 50);
  assert.equal(out.notifications.length, 1);
  assert.equal(out.notifications[0].id, 'n2');
  assert.equal(out.notifications[0].title, '', 'empty title serialized as empty string (serializeRow contract)');
  assert.equal(out.notifications[0].read, false);
});

test('A7: empty page — items "[]" → notifications [] with unread_count preserved', async () => {
  const createNotificationRepository = loadRepo();
  const queryDbDirect = async () => ({ rows: [{ items: '[]', unread_count: 5 }], rowCount: 1 });
  const repo = createNotificationRepository({ queryDb: async () => { throw new Error('no'); }, queryDbDirect });
  const out = await repo.listWithUnread(ENV, 'u3', 50);
  assert.deepEqual(out.notifications, [], 'empty page yields an empty notifications array');
  assert.equal(out.unreadCount, 5, 'TRUE unread count survives the empty page (bare aggregate single row)');
});

test('A8: no rows at all (defensive) → notifications [] and unreadCount 0', async () => {
  const createNotificationRepository = loadRepo();
  const queryDbDirect = async () => ({ rows: [], rowCount: 0 });
  const repo = createNotificationRepository({ queryDb: async () => { throw new Error('no'); }, queryDbDirect });
  const out = await repo.listWithUnread(ENV, 'u4', 50);
  assert.deepEqual(out, { notifications: [], unreadCount: 0 });
});

test('A9: missing queryDbDirect injection → listWithUnread throws DIRECT_DB_NOT_INJECTED (no silent fallback)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb } = makeSpies();
  const repo = createNotificationRepository({ queryDb });
  await assert.rejects(
    () => repo.listWithUnread(ENV, 'u5', 50),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i, 'error message must mention queryDbDirect');
      assert.match(err.message, /listWithUnread/i, 'error message must identify the function');
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED', 'error code must be DIRECT_DB_NOT_INJECTED');
      return true;
    },
    'listWithUnread must throw a clear configuration error when queryDbDirect is missing'
  );
  assert.equal(calls.queryDb.length, 0, 'must NOT silently fall back to queryDb (would re-introduce the stale-read bug)');
});

test('A10: SCOPE GUARD — list() and unreadCount() remain exported, unchanged, each still exactly ONE queryDbDirect call', async () => {
  const createNotificationRepository = loadRepo();
  // Empty-rows spies shaped for the OLD functions (list maps rows directly;
  // unreadCount reads rows[0].count) — mirrors notif-direct-read-regression
  // test's makeSpies contract.
  const calls = { queryDb: [], queryDbDirect: [] };
  const queryDb = async (env, sqlText, params = []) => {
    calls.queryDb.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
  const queryDbDirect = async (env, sqlText, params = []) => {
    calls.queryDbDirect.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0 };
  };
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  const listOut = await repo.list(ENV, 'user-1', 50);
  const countOut = await repo.unreadCount(ENV, 'user-1');
  assert.deepEqual(listOut, [], 'list() still returns a plain serialized array (old contract)');
  assert.equal(countOut, 0, 'unreadCount() still returns a plain number (old contract)');
  assert.equal(calls.queryDbDirect.length, 2, 'list + unreadCount still issue one direct call each (2 total)');
  assert.equal(calls.queryDb.length, 0, 'neither falls back to queryDb');
  // SQL shapes of the OLD functions are untouched
  assert.match(calls.queryDbDirect[0].sqlText, /SELECT id, user_id, type, title, message, metadata, read_status, created_at FROM notifications/i);
  assert.match(calls.queryDbDirect[0].sqlText, /LIMIT \$2/i, 'list() SQL still has LIMIT $2');
  assert.match(calls.queryDbDirect[1].sqlText, /SELECT COUNT\(\*\)::int AS count/i, 'unreadCount() SQL still COUNT(*)::int AS count');
});

test('A11: exports — listWithUnread added ALONGSIDE every pre-existing export (nothing removed)', () => {
  const createNotificationRepository = loadRepo();
  const { queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  const keys = Object.keys(repo).sort();
  assert.deepEqual(keys, [
    'create', 'createBulk', 'deleteAll', 'deleteNotification', 'ensureTable',
    'getSettings', 'list', 'listWithUnread', 'markAllRead', 'markRead',
    'saveSettings', 'serializeRow', 'unreadCount',
  ], 'exports = 12 pre-existing names + listWithUnread');
});

// ────────────────────────────────────────────────────────────────────────────
// C. CONTROLLER TESTS — the REAL controller, mock deps
// ────────────────────────────────────────────────────────────────────────────

test('C1: handleList calls listWithUnread EXACTLY ONCE and never list/unreadCount (Promise.all pair replaced)', async () => {
  const createNotificationHandlers = loadController();
  const { calls, repo } = makeRepoSpy();
  const { deps, state } = makeControllerDeps(repo);
  const handlers = createNotificationHandlers(deps);
  await handlers.handleList(makeRequest(), ENV);
  assert.equal(calls.listWithUnread.length, 1, 'handleList must call notificationRepo.listWithUnread exactly once');
  assert.equal(calls.list.length, 0, 'handleList must NOT call notificationRepo.list anymore');
  assert.equal(calls.unreadCount.length, 0, 'handleList must NOT call notificationRepo.unreadCount anymore');
  assert.ok(state.jsonResponse, 'handleList must return a jsonResponse on the happy path');
  assert.ok(!state.dbError, 'no error path taken');
});

test('C2: response contract UNCHANGED — { status:"success", notifications:[…], unread_count:<number> }', async () => {
  const createNotificationHandlers = loadController();
  const { repo } = makeRepoSpy();
  const { deps, state } = makeControllerDeps(repo);
  const handlers = createNotificationHandlers(deps);
  await handlers.handleList(makeRequest(), ENV);
  assert.ok(state.jsonResponse, 'success jsonResponse returned');
  const body = state.jsonResponse.body;
  assert.equal(body.status, 'success');
  assert.ok(Array.isArray(body.notifications), 'notifications is an array');
  assert.equal(body.notifications.length, 1);
  assert.equal(body.notifications[0].id, 'n1');
  assert.equal(typeof body.unread_count, 'number', 'unread_count is a number (frontend checks typeof)');
  assert.equal(body.unread_count, 3);
  // Exact key set (no extra/renamed fields)
  assert.deepEqual(Object.keys(body).sort(), ['notifications', 'status', 'unread_count']);
});

test('C3: ?limit=N query param passthrough — parsed limit reaches listWithUnread', async () => {
  const createNotificationHandlers = loadController();
  const { calls, repo } = makeRepoSpy();
  const { deps } = makeControllerDeps(repo);
  const handlers = createNotificationHandlers(deps);
  await handlers.handleList(makeRequest({ limit: '7' }), ENV);
  assert.equal(calls.listWithUnread.length, 1);
  assert.equal(calls.listWithUnread[0].limit, 7, 'limit=7 from the URL is passed through as 7');
  assert.equal(calls.listWithUnread[0].userId, 'user-1', 'userId from _protectedUser');
  // Default (no param) → 50, same as before
  const { calls: calls2, repo: repo2 } = makeRepoSpy();
  const { deps: deps2 } = makeControllerDeps(repo2);
  const handlers2 = createNotificationHandlers(deps2);
  await handlers2.handleList(makeRequest(), ENV);
  assert.equal(calls2.listWithUnread[0].limit, 50, 'no limit param → 50 (old default)');
});

test('C4: DB not configured → 503 error response (path unchanged)', async () => {
  const createNotificationHandlers = loadController();
  const { repo } = makeRepoSpy();
  const { deps, state } = makeControllerDeps(repo, { dbConfigured: false });
  const handlers = createNotificationHandlers(deps);
  await handlers.handleList(makeRequest(), ENV);
  assert.ok(state.jsonResponse, 'jsonResponse returned');
  assert.deepEqual(state.jsonResponse.body, { status: 'error', message: 'Database not configured' });
  assert.equal(state.jsonResponse.init.status, 503);
});

test('C5: repository error → safeDbErrorResponse (catch path unchanged)', async () => {
  const createNotificationHandlers = loadController();
  const { repo } = makeRepoSpy({ throwFrom: 'listWithUnread' });
  const { deps, state } = makeControllerDeps(repo);
  const handlers = createNotificationHandlers(deps);
  await handlers.handleList(makeRequest(), ENV);
  assert.ok(state.dbError, 'safeDbErrorResponse invoked on repository failure');
  assert.equal(state.dbError.message, 'repo boom');
  assert.equal(state.jsonResponse, null, 'no success jsonResponse on the error path');
});

test('C6: _protectedUser short-circuits auth — authenticateTelegramRequest NOT called (unchanged)', async () => {
  const createNotificationHandlers = loadController();
  const { repo } = makeRepoSpy();
  const { deps, state } = makeControllerDeps(repo);
  const handlers = createNotificationHandlers(deps);
  await handlers.handleList(makeRequest(), ENV);
  assert.equal(state.authCalled, 0, 'global-middleware user must be used, no redundant HMAC');
});

// ────────────────────────────────────────────────────────────────────────────
// B. BEHAVIORAL EQUIVALENCE — OLD 2-query oracle vs NEW real implementation,
//    both executed against REAL in-memory PostgreSQL (pg-mem).
// ────────────────────────────────────────────────────────────────────────────

const SCENARIOS = [
  // [label, userId, limit]
  ['default limit 50 (mixed read/unread)',               'u-main', 50],
  ['limit 1 (newest only)',                             'u-main', 1],
  ['limit 2',                                           'u-main', 2],
  ['limit 6 (exact number of active rows)',             'u-main', 6],
  ['limit 7 (> total active rows)',                     'u-main', 7],
  ['limit 100 (clamp maximum)',                         'u-main', 100],
  ['limit 0 (falsy → default 50)',                      'u-main', 0],
  ['limit "abc" (NaN → default 50)',                    'u-main', 'abc'],
  ['limit -5 (clamped to 1)',                           'u-main', -5],
  ['limit 500 (clamped to 100)',                        'u-main', 500],
  ['all-read user (unread_count 0)',                    'u-allread', 50],
  ['user with zero notifications',                      'u-empty', 50],
  ['unknown user (zero rows)',                          'nobody', 50],
  ['other user (isolation: 2 rows, 1 unread)',           'u-other', 50],
  ['other user limit 1',                                'u-other', 1],
];

test('B1: OLD 2-query output vs NEW single-query output — deep-equal across all 15 scenarios', async () => {
  const { queryDbDirect } = makeDb();
  const repo = makeRepo(queryDbDirect);
  for (const [label, userId, limit] of SCENARIOS) {
    const oldOut = await oldListAndUnread(queryDbDirect, ENV, userId, limit);
    const newOut = await repo.listWithUnread(ENV, userId, limit);
    assert.deepEqual(newOut, oldOut, `scenario "${label}" (${userId}, limit=${JSON.stringify(limit)}) must be byte-identical`);
  }
});

test('B2: call-count proof — OLD issues 2 queryDbDirect calls, NEW issues EXACTLY 1 (same DB state)', async () => {
  // OLD path
  const dbOld = makeDb();
  await oldListAndUnread(dbOld.queryDbDirect, ENV, 'u-main', 50);
  assert.equal(dbOld.calls.length, 2, 'old implementation: list + count = 2 direct pool constructions');
  // NEW path
  const dbNew = makeDb();
  const repo = makeRepo(dbNew.queryDbDirect);
  await repo.listWithUnread(ENV, 'u-main', 50);
  assert.equal(dbNew.calls.length, 1, 'new implementation: 1 direct pool construction');
});

test('B3: ordering — newest-first across the page (created_at DESC, same as old list())', async () => {
  const { queryDbDirect } = makeDb();
  const repo = makeRepo(queryDbDirect);
  const out = await repo.listWithUnread(ENV, 'u-main', 50);
  assert.deepEqual(out.notifications.map((n) => n.id), ['n06', 'n05', 'n04', 'n03', 'n02', 'n01'],
    'active rows in strict newest-first order');
  const out2 = await repo.listWithUnread(ENV, 'u-main', 2);
  assert.deepEqual(out2.notifications.map((n) => n.id), ['n06', 'n05'], 'limit=2 returns the two NEWEST rows');
});

test('B4: soft-deleted rows absent from BOTH items and unread_count', async () => {
  const { queryDbDirect } = makeDb();
  const repo = makeRepo(queryDbDirect);
  const out = await repo.listWithUnread(ENV, 'u-main', 50);
  const ids = out.notifications.map((n) => n.id);
  assert.ok(!ids.includes('d01') && !ids.includes('d02'), 'soft-deleted rows never listed');
  // d02 is unread+deleted, d01 is read+deleted → neither counts. Active unread: n04,n05,n06 → 3
  assert.equal(out.unreadCount, 3, 'unread count excludes soft-deleted rows (d02 is unread but deleted)');
});

test('B5: unread_count is INDEPENDENT of LIMIT (scalar subquery, not a window function)', async () => {
  const { queryDbDirect } = makeDb();
  const repo = makeRepo(queryDbDirect);
  for (const limit of [1, 2, 3, 6, 50]) {
    const out = await repo.listWithUnread(ENV, 'u-main', limit);
    assert.equal(out.unreadCount, 3, `unread_count must stay 3 regardless of limit=${limit}`);
  }
});

test('B6: read-after-write — a newly inserted unread notification is visible on the NEXT listWithUnread call (fresh pool per call)', async () => {
  const { db, queryDbDirect } = makeDb();
  const repo = makeRepo(queryDbDirect);
  const before = await repo.listWithUnread(ENV, 'u-main', 50);
  assert.equal(before.unreadCount, 3);
  assert.equal(before.notifications.length, 6);
  // A new notification is committed (cron/create path) AFTER the previous read
  db.public.many(`
    INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, created_at, deleted_at)
    VALUES ('n99', 'u-main', 'system', 'NEW', 'fresh write', '{"k":99}', FALSE, '2026-01-09T10:00:00Z', NULL)
  `);
  const after = await repo.listWithUnread(ENV, 'u-main', 50);
  assert.equal(after.notifications[0].id, 'n99', 'newest committed write appears first immediately (no cache)');
  assert.equal(after.notifications.length, 7);
  assert.equal(after.unreadCount, 4, 'unread count reflects the new unread row immediately');
});

test('B7: unread_count is always an integer NUMBER across every scenario (API contract: typeof number)', async () => {
  const { queryDbDirect } = makeDb();
  const repo = makeRepo(queryDbDirect);
  for (const [label, userId, limit] of SCENARIOS) {
    const out = await repo.listWithUnread(ENV, userId, limit);
    assert.equal(typeof out.unreadCount, 'number', `"${label}": unreadCount must be a number`);
    assert.ok(Number.isInteger(out.unreadCount), `"${label}": unreadCount must be an integer`);
    assert.ok(out.unreadCount >= 0, `"${label}": unreadCount must be non-negative`);
  }
});

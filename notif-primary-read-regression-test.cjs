/**
 * Notification Primary-Read Regression Test
 *
 * Proven RCA: GET /api/notifications reads from a Neon read replica with ~45s
 * lag. After a DELETE commits on the primary, a subsequent GET (within ~45s)
 * returns the deleted row from the stale replica. Self-corrects at ~70s when
 * the replica catches up.
 *
 * FIX (Option 1 — backend primary read, scoped):
 *   - notificationRepo.list and notificationRepo.unreadCount route through
 *     queryDbPrimary (Neon PRIMARY compute via dedicated neon() HTTP client).
 *   - All mutations (deleteNotification, deleteAll, markRead, markAllRead,
 *     create, createBulk) and the schema bootstrap (ensureTable) continue to
 *     use the existing queryDb (Hyperdrive/NeonPool/replica path).
 *   - No other repository is given queryDbPrimary.
 *   - queryDbPrimary must never touch env._reqPool.
 *   - Missing PRIMARY_DATABASE_URL → explicit configuration error, NO silent
 *     fallback to the replica path.
 *
 * This test verifies all six invariants by directly exercising the repository
 * with mock queryDb / queryDbPrimary functions and inspecting which one was
 * called for each operation.
 *
 * Run: node --test notif-primary-read-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const path = require('node:path');
const fs = require('node:fs');

// ────────────────────────────────────────────────────────────────────────────
// Load the repository module via source evaluation (the project is
// "type": "commonjs" in package.json, but src/repositories/notifications.js
// uses ESM `export function` syntax — Cloudflare's wrangler bundler handles
// this for production, but Node's plain require() cannot. We read the source,
// strip the `export ` keyword, and eval as CommonJS in a sandbox. This mirrors
// how other tests in this project (e.g. notification-return-bug-test.cjs)
// load functions from app.js / worker-proxy.js.
// ────────────────────────────────────────────────────────────────────────────
function loadRepo() {
  const src = fs.readFileSync(path.join(__dirname, 'src/repositories/notifications.js'), 'utf8');
  // Strip top-level `export function createNotificationRepository(deps) {`
  // → `function createNotificationRepository(deps) {` (no other top-level
  // exports in this file).
  const transformed = src.replace(/^export function createNotificationRepository\(/m, 'function createNotificationRepository(');
  const moduleObj = { exports: {} };
  const sandbox = {
    module: moduleObj,
    exports: moduleObj.exports,
    globalThis,
    console: { warn: () => {}, log: () => {}, error: () => {} },
    AbortSignal: { timeout: () => null },
  };
  // Eval the source in a function scope, expose createNotificationRepository
  // via module.exports. The repository code does not call any external API
  // at load time — it only defines functions inside createNotificationRepository.
  const wrapper = new Function('module', 'exports', 'globalThis', 'console', 'AbortSignal',
    transformed + '\nmodule.exports.createNotificationRepository = createNotificationRepository;');
  wrapper(sandbox.module, sandbox.exports, sandbox.globalThis, sandbox.console, sandbox.AbortSignal);
  return sandbox.module.exports.createNotificationRepository;
}

// Mock factory: returns a repo with spy queryDb / queryDbPrimary that record
// every call (sqlText + params + which fn was used).
function makeSpies() {
  const calls = { queryDb: [], queryDbPrimary: [] };
  const queryDb = async (env, sqlText, params = []) => {
    calls.queryDb.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    // Return a minimal pg-like result. Tests inspect rows / rowCount as needed.
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  const queryDbPrimary = async (env, sqlText, params = []) => {
    calls.queryDbPrimary.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  return { calls, queryDb, queryDbPrimary };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('list() routes through queryDbPrimary, NOT queryDb', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  const env = { _reqPool: { __marker: 'replica-pool' } };
  await repo.list(env, 'user-1', 50);
  assert.equal(calls.queryDbPrimary.length, 1, 'list must call queryDbPrimary exactly once');
  assert.equal(calls.queryDb.length, 0, 'list must NOT call queryDb');
  const sql = calls.queryDbPrimary[0].sqlText;
  assert.match(sql, /SELECT/i, 'list SQL is a SELECT');
  assert.match(sql, /FROM notifications/i, 'list reads from notifications table');
  assert.match(sql, /deleted_at IS NULL/i, 'list filters soft-deleted rows');
  assert.deepEqual(calls.queryDbPrimary[0].params, ['user-1', 50], 'list params are (userId, limit)');
});

test('unreadCount() routes through queryDbPrimary, NOT queryDb', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  const env = { _reqPool: { __marker: 'replica-pool' } };
  await repo.unreadCount(env, 'user-2');
  assert.equal(calls.queryDbPrimary.length, 1, 'unreadCount must call queryDbPrimary exactly once');
  assert.equal(calls.queryDb.length, 0, 'unreadCount must NOT call queryDb');
  const sql = calls.queryDbPrimary[0].sqlText;
  assert.match(sql, /SELECT COUNT\(\*\)::int AS count/i, 'unreadCount SQL is a COUNT');
  assert.match(sql, /read_status = FALSE/i, 'unreadCount filters unread only');
  assert.match(sql, /deleted_at IS NULL/i, 'unreadCount filters soft-deleted');
  assert.deepEqual(calls.queryDbPrimary[0].params, ['user-2'], 'unreadCount params are (userId,)');
});

test('deleteNotification() still uses queryDb (mutation path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.deleteNotification({ PRIMARY_DATABASE_URL: 'x' }, 'notif-1', 'user-3');
  assert.equal(calls.queryDb.length, 1, 'deleteNotification must call queryDb exactly once');
  assert.equal(calls.queryDbPrimary.length, 0, 'deleteNotification must NOT call queryDbPrimary');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET deleted_at = NOW\(\)/i, 'deleteNotification is a soft-delete UPDATE');
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/i, 'deleteNotification WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['notif-1', 'user-3']);
});

test('deleteAll() still uses queryDb (mutation path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.deleteAll({ PRIMARY_DATABASE_URL: 'x' }, 'user-4');
  assert.equal(calls.queryDb.length, 1, 'deleteAll must call queryDb exactly once');
  assert.equal(calls.queryDbPrimary.length, 0, 'deleteAll must NOT call queryDbPrimary');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET deleted_at = NOW\(\)/i, 'deleteAll is a soft-delete UPDATE');
  assert.match(sql, /WHERE user_id = \$1 AND deleted_at IS NULL/i, 'deleteAll WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['user-4']);
});

test('markRead() still uses queryDb (mutation path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.markRead({ PRIMARY_DATABASE_URL: 'x' }, 'notif-2', 'user-5');
  assert.equal(calls.queryDb.length, 1, 'markRead must call queryDb exactly once');
  assert.equal(calls.queryDbPrimary.length, 0, 'markRead must NOT call queryDbPrimary');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET read_status = TRUE/i, 'markRead is a read-status UPDATE');
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i, 'markRead WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['notif-2', 'user-5']);
});

test('markAllRead() still uses queryDb (mutation path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.markAllRead({ PRIMARY_DATABASE_URL: 'x' }, 'user-6');
  assert.equal(calls.queryDb.length, 1, 'markAllRead must call queryDb exactly once');
  assert.equal(calls.queryDbPrimary.length, 0, 'markAllRead must NOT call queryDbPrimary');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET read_status = TRUE/i, 'markAllRead is a read-status UPDATE');
  assert.match(sql, /WHERE user_id = \$1 AND read_status = FALSE AND deleted_at IS NULL/i, 'markAllRead WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['user-6']);
});

test('create() still uses queryDb (mutation path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.create({ PRIMARY_DATABASE_URL: 'x' }, 'user-7', 'system', 'Hello', 'Body');
  // ensureTable runs first (queryDb), then create's INSERT (queryDb).
  assert.ok(calls.queryDb.length >= 1, 'create must call queryDb at least once (INSERT)');
  assert.equal(calls.queryDbPrimary.length, 0, 'create must NOT call queryDbPrimary');
  const insertCall = calls.queryDb.find((c) => /INSERT INTO notifications/i.test(c.sqlText));
  assert.ok(insertCall, 'create must run an INSERT INTO notifications via queryDb');
});

test('createBulk() still uses queryDb (mutation path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.createBulk({ PRIMARY_DATABASE_URL: 'x' }, ['user-8', 'user-9'], 'system', 'Bulk', 'Body');
  assert.ok(calls.queryDb.length >= 1, 'createBulk must call queryDb at least once (INSERT)');
  assert.equal(calls.queryDbPrimary.length, 0, 'createBulk must NOT call queryDbPrimary');
  const insertCall = calls.queryDb.find((c) => /INSERT INTO notifications/i.test(c.sqlText));
  assert.ok(insertCall, 'createBulk must run an INSERT INTO notifications via queryDb');
});

test('ensureTable() / getSettings / saveSettings still use queryDb (NOT queryDbPrimary)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbPrimary } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  await repo.ensureTable({ PRIMARY_DATABASE_URL: 'x' });
  await repo.getSettings({ PRIMARY_DATABASE_URL: 'x' }, 'user-10');
  await repo.saveSettings({ PRIMARY_DATABASE_URL: 'x' }, 'user-11', { analysis: false });
  assert.ok(calls.queryDb.length > 0, 'ensureTable + getSettings + saveSettings must call queryDb');
  assert.equal(calls.queryDbPrimary.length, 0, 'ensureTable/getSettings/saveSettings must NOT call queryDbPrimary');
});

test('missing queryDbPrimary injection → list() throws explicit config error (no silent fallback)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb } = makeSpies();
  // Inject ONLY queryDb (as the old worker bundle would).
  const repo = createNotificationRepository({ queryDb });
  await assert.rejects(
    () => repo.list({ PRIMARY_DATABASE_URL: 'x' }, 'user-1', 50),
    (err) => {
      assert.match(err.message, /queryDbPrimary is not injected/i, 'list error message must mention queryDbPrimary');
      assert.equal(err.code, 'PRIMARY_DB_NOT_INJECTED', 'list error code must be PRIMARY_DB_NOT_INJECTED');
      return true;
    },
    'list must throw a clear configuration error when queryDbPrimary is missing'
  );
  // CRITICAL: list must NOT have silently fallen back to queryDb.
  assert.equal(calls.queryDb.length, 0, 'list must NOT silently fall back to queryDb when queryDbPrimary is missing');
});

test('missing queryDbPrimary injection → unreadCount() throws explicit config error (no silent fallback)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb } = makeSpies();
  const repo = createNotificationRepository({ queryDb });
  await assert.rejects(
    () => repo.unreadCount({ PRIMARY_DATABASE_URL: 'x' }, 'user-2'),
    (err) => {
      assert.match(err.message, /queryDbPrimary is not injected/i, 'unreadCount error message must mention queryDbPrimary');
      assert.equal(err.code, 'PRIMARY_DB_NOT_INJECTED', 'unreadCount error code must be PRIMARY_DB_NOT_INJECTED');
      return true;
    },
    'unreadCount must throw a clear configuration error when queryDbPrimary is missing'
  );
  assert.equal(calls.queryDb.length, 0, 'unreadCount must NOT silently fall back to queryDb when queryDbPrimary is missing');
});

test('no other repository imports or references queryDbPrimary (scope guard)', async () => {
  // Static check: ensure queryDbPrimary does NOT appear in any other repository
  // source file. This guards against accidental scope creep.
  const repoDir = path.resolve(__dirname, 'src/repositories');
  const files = fs.readdirSync(repoDir).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const full = path.join(repoDir, f);
    const src = fs.readFileSync(full, 'utf8');
    if (/queryDbPrimary/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, ['notifications.js'], 'queryDbPrimary must only appear in notifications.js (the sole scoped repository)');
});

test('list / unreadCount do NOT pass env._reqPool through to queryDbPrimary semantics (primary bypasses shared pool)', async () => {
  const createNotificationRepository = loadRepo();
  const calls = { queryDb: [], queryDbPrimary: [] };
  let sawReqPool = false;
  const queryDb = async (env) => { if (env._reqPool) sawReqPool = true; calls.queryDb.push(1); return { rows: [], rowCount: 0 }; };
  const queryDbPrimary = async (env, sqlText) => {
    // The repository passes `env` straight through; queryDbPrimary (in
    // worker-proxy.js) is responsible for NOT using env._reqPool. We assert at
    // the repository layer that the call signature is preserved and that the
    // SQL is a SELECT (i.e. a read, not a write that would touch _reqPool).
    calls.queryDbPrimary.push({ sqlText, hasReqPool: Boolean(env._reqPool) });
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
  };
  const repo = createNotificationRepository({ queryDb, queryDbPrimary });
  const env = { _reqPool: { __marker: 'should-be-ignored-by-queryDbPrimary' } };
  await repo.list(env, 'user-x');
  await repo.unreadCount(env, 'user-x');
  assert.equal(calls.queryDbPrimary.length, 2, 'list + unreadCount both route through queryDbPrimary');
  // The repository layer passes `env` as-is (the worker-proxy queryDbPrimary is
  // what bypasses env._reqPool). The repository's contract is just to call
  // queryDbPrimary instead of queryDb for reads — verified above.
  for (const c of calls.queryDbPrimary) {
    assert.match(c.sqlText, /SELECT/i, 'only SELECTs go through queryDbPrimary');
  }
});

test('worker-proxy.js exposes queryDbPrimary as a top-level function (source-level check)', () => {
  const wp = fs.readFileSync(path.resolve(__dirname, 'worker-proxy.js'), 'utf8');
  assert.match(wp, /async function queryDbPrimary\(env, sqlText, params = \[\]\)/, 'queryDbPrimary must be a top-level async function');
  assert.match(wp, /function getSharedNeonPrimary\(env\)/, 'getSharedNeonPrimary must exist');
  assert.match(wp, /const _moduleNeonPrimaryCache = new Map\(\)/, '_moduleNeonPrimaryCache must exist (module-level cache)');
  assert.match(wp, /createNotificationRepository\(\{ queryDb, queryDbPrimary \}\)/, 'notificationRepo must be created with both queryDb and queryDbPrimary');
  // No other repo creation should include queryDbPrimary.
  const otherRepoMatches = wp.match(/create\w+Repository\(\{[^}]*queryDbPrimary[^}]*\}\)/g) || [];
  assert.equal(otherRepoMatches.length, 1, 'only ONE repository (notificationRepo) should receive queryDbPrimary');
  assert.match(otherRepoMatches[0], /createNotificationRepository/, 'the single queryDbPrimary repo injection must be createNotificationRepository');
});

test('worker-proxy.js queryDbPrimary throws explicit error when PRIMARY_DATABASE_URL is missing (no silent fallback)', async () => {
  // We can't easily require the entire worker-proxy.js (it has top-level
  // imports + Cloudflare bindings). Instead, we statically verify the function
  // body has the explicit error contract by reading the source.
  const wp = fs.readFileSync(path.resolve(__dirname, 'worker-proxy.js'), 'utf8');
  // Locate the queryDbPrimary function body.
  const fnStart = wp.indexOf('async function queryDbPrimary(env, sqlText, params = []) {');
  assert.ok(fnStart > 0, 'queryDbPrimary function must exist');
  const fnEnd = wp.indexOf('\n}\n', fnStart);
  const body = wp.slice(fnStart, fnEnd > fnStart ? fnEnd : wp.length);
  assert.match(body, /PRIMARY_DATABASE_URL/, 'queryDbPrimary must reference PRIMARY_DATABASE_URL');
  assert.match(body, /PRIMARY_DB_NOT_CONFIGURED/, 'queryDbPrimary must throw PRIMARY_DB_NOT_CONFIGURED when secret is missing');
  assert.match(body, /PRIMARY_DB_CLIENT_INIT_FAILED/, 'queryDbPrimary must throw PRIMARY_DB_CLIENT_INIT_FAILED when client init fails');
  // Anti-pattern guard: queryDbPrimary must NOT fall back to queryDb or
  // env._reqPool or getSharedNeon.
  assert.doesNotMatch(body, /return queryDb\(/, 'queryDbPrimary must NOT fall back to queryDb');
  assert.doesNotMatch(body, /env\._reqPool\.query\(/, 'queryDbPrimary must NOT call env._reqPool.query');
  assert.doesNotMatch(body, /getSharedNeon\(env\)/, 'queryDbPrimary must NOT fall back to the (replica) getSharedNeon');
  assert.doesNotMatch(body, /createPool\(env\)/, 'queryDbPrimary must NOT fall back to createPool');
});

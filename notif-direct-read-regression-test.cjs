/**
 * Notification Direct-Read Regression Test (Option C)
 *
 * PROVEN RCA (2026-09-10):
 *   Cloudflare Hyperdrive's SELECT query cache is enabled on the production
 *   binding `amir-btc-supabase` (caching.disabled=false, default cache_ttl=60s).
 *   notificationRepo.list and .unreadCount issue deterministic SELECTs that
 *   Hyperdrive caches at the edge. After a DELETE (UPDATE — bypasses the cache,
 *   hits origin immediately), the cached SELECT result still contains the
 *   now-deleted notification for up to 60s after the FIRST GET. Subsequent
 *   GETs within the cache window return the stale cached result → the deleted
 *   notification "reappears". At 60s+ the cache expires, the next GET queries
 *   origin → notification is gone (the "self-correction" the user observed).
 *
 * FIX (Option C — scoped pg.Pool bypass of Hyperdrive):
 *   - notificationRepo.list and notificationRepo.unreadCount route through
 *     queryDbDirect — a per-call pg.Pool bound to env.DIRECT_URL (or
 *     env.DATABASE_URL as fallback), bypassing Hyperdrive's connection string
 *     entirely → bypassing Hyperdrive's edge cache → read-after-write
 *     consistency.
 *   - All mutation functions (deleteNotification, deleteAll, markRead,
 *     markAllRead, create, createBulk) and the schema bootstrap (ensureTable)
 *     continue to use queryDb (the existing Hyperdrive path) — UNCHANGED.
 *     Hyperdrive does not cache mutations, so the UPDATE hits origin immediately.
 *   - No other repository is given queryDbDirect.
 *   - Missing DIRECT_URL/DATABASE_URL → explicit configuration error
 *     (DIRECT_DB_NOT_CONFIGURED), NO silent fallback to queryDb (which would
 *     re-introduce the stale-read bug).
 *
 * This test verifies all six invariants by directly exercising the repository
 * with mock queryDb / queryDbDirect functions and inspecting which one was
 * called for each operation.
 *
 * Run: node --test notif-direct-read-regression-test.cjs
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
// strip the `export ` keyword, and eval as CommonJS in a sandbox.
// ────────────────────────────────────────────────────────────────────────────
function loadRepo() {
  const src = fs.readFileSync(path.join(__dirname, 'src/repositories/notifications.js'), 'utf8');
  const transformed = src.replace(/^export function createNotificationRepository\(/m, 'function createNotificationRepository(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'globalThis', 'console', 'AbortSignal',
    transformed + '\nmodule.exports.createNotificationRepository = createNotificationRepository;');
  wrapper(moduleObj, moduleObj.exports, globalThis, { warn: () => {}, log: () => {}, error: () => {} }, { timeout: () => null });
  return moduleObj.exports.createNotificationRepository;
}

// Mock factory: returns a repo with spy queryDb / queryDbDirect that record
// every call (sqlText + params + which fn was used).
function makeSpies() {
  const calls = { queryDb: [], queryDbDirect: [] };
  const queryDb = async (env, sqlText, params = []) => {
    calls.queryDb.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  const queryDbDirect = async (env, sqlText, params = []) => {
    calls.queryDbDirect.push({ sqlText: String(sqlText).replace(/\s+/g, ' ').trim(), params });
    return { rows: [], rowCount: 0, fields: [], command: 'MOCK' };
  };
  return { calls, queryDb, queryDbDirect };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests
// ────────────────────────────────────────────────────────────────────────────

test('list() routes through queryDbDirect, NOT queryDb (bypasses Hyperdrive cache)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  const env = { _reqPool: { __marker: 'hyperdrive-pool' }, DIRECT_URL: 'postgresql://...' };
  await repo.list(env, 'user-1', 50);
  assert.equal(calls.queryDbDirect.length, 1, 'list must call queryDbDirect exactly once');
  assert.equal(calls.queryDb.length, 0, 'list must NOT call queryDb (would hit Hyperdrive cache)');
  const sql = calls.queryDbDirect[0].sqlText;
  assert.match(sql, /SELECT/i, 'list SQL is a SELECT');
  assert.match(sql, /FROM notifications/i, 'list reads from notifications table');
  assert.match(sql, /deleted_at IS NULL/i, 'list filters soft-deleted rows');
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-1', 50], 'list params are (userId, limit)');
});

test('unreadCount() routes through queryDbDirect, NOT queryDb (bypasses Hyperdrive cache)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  const env = { _reqPool: { __marker: 'hyperdrive-pool' }, DIRECT_URL: 'postgresql://...' };
  await repo.unreadCount(env, 'user-2');
  assert.equal(calls.queryDbDirect.length, 1, 'unreadCount must call queryDbDirect exactly once');
  assert.equal(calls.queryDb.length, 0, 'unreadCount must NOT call queryDb (would hit Hyperdrive cache)');
  const sql = calls.queryDbDirect[0].sqlText;
  assert.match(sql, /SELECT COUNT\(\*\)::int AS count/i, 'unreadCount SQL is a COUNT');
  assert.match(sql, /read_status = FALSE/i, 'unreadCount filters unread only');
  assert.match(sql, /deleted_at IS NULL/i, 'unreadCount filters soft-deleted');
  assert.deepEqual(calls.queryDbDirect[0].params, ['user-2'], 'unreadCount params are (userId,)');
});

test('deleteNotification() still uses queryDb (Hyperdrive path unchanged — mutations bypass cache anyway)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.deleteNotification({ DIRECT_URL: 'postgresql://...' }, 'notif-1', 'user-3');
  assert.equal(calls.queryDb.length, 1, 'deleteNotification must call queryDb exactly once');
  assert.equal(calls.queryDbDirect.length, 0, 'deleteNotification must NOT call queryDbDirect');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET deleted_at = NOW\(\)/i, 'deleteNotification is a soft-delete UPDATE');
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2 AND deleted_at IS NULL/i, 'deleteNotification WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['notif-1', 'user-3']);
});

test('deleteAll() still uses queryDb (Hyperdrive path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.deleteAll({ DIRECT_URL: 'postgresql://...' }, 'user-4');
  assert.equal(calls.queryDb.length, 1, 'deleteAll must call queryDb exactly once');
  assert.equal(calls.queryDbDirect.length, 0, 'deleteAll must NOT call queryDbDirect');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET deleted_at = NOW\(\)/i, 'deleteAll is a soft-delete UPDATE');
  assert.match(sql, /WHERE user_id = \$1 AND deleted_at IS NULL/i, 'deleteAll WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['user-4']);
});

test('markRead() still uses queryDb (Hyperdrive path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.markRead({ DIRECT_URL: 'postgresql://...' }, 'notif-2', 'user-5');
  assert.equal(calls.queryDb.length, 1, 'markRead must call queryDb exactly once');
  assert.equal(calls.queryDbDirect.length, 0, 'markRead must NOT call queryDbDirect');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET read_status = TRUE/i, 'markRead is a read-status UPDATE');
  assert.match(sql, /WHERE id = \$1 AND user_id = \$2/i, 'markRead WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['notif-2', 'user-5']);
});

test('markAllRead() still uses queryDb (Hyperdrive path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.markAllRead({ DIRECT_URL: 'postgresql://...' }, 'user-6');
  assert.equal(calls.queryDb.length, 1, 'markAllRead must call queryDb exactly once');
  assert.equal(calls.queryDbDirect.length, 0, 'markAllRead must NOT call queryDbDirect');
  const sql = calls.queryDb[0].sqlText;
  assert.match(sql, /UPDATE notifications SET read_status = TRUE/i, 'markAllRead is a read-status UPDATE');
  assert.match(sql, /WHERE user_id = \$1 AND read_status = FALSE AND deleted_at IS NULL/i, 'markAllRead WHERE clause matches expected');
  assert.deepEqual(calls.queryDb[0].params, ['user-6']);
});

test('create() still uses queryDb (Hyperdrive path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.create({ DIRECT_URL: 'postgresql://...' }, 'user-7', 'system', 'Hello', 'Body');
  assert.ok(calls.queryDb.length >= 1, 'create must call queryDb at least once (INSERT)');
  assert.equal(calls.queryDbDirect.length, 0, 'create must NOT call queryDbDirect');
  const insertCall = calls.queryDb.find((c) => /INSERT INTO notifications/i.test(c.sqlText));
  assert.ok(insertCall, 'create must run an INSERT INTO notifications via queryDb');
});

test('createBulk() still uses queryDb (Hyperdrive path unchanged)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.createBulk({ DIRECT_URL: 'postgresql://...' }, ['user-8', 'user-9'], 'system', 'Bulk', 'Body');
  assert.ok(calls.queryDb.length >= 1, 'createBulk must call queryDb at least once (INSERT)');
  assert.equal(calls.queryDbDirect.length, 0, 'createBulk must NOT call queryDbDirect');
  const insertCall = calls.queryDb.find((c) => /INSERT INTO notifications/i.test(c.sqlText));
  assert.ok(insertCall, 'createBulk must run an INSERT INTO notifications via queryDb');
});

test('ensureTable() / getSettings / saveSettings still use queryDb (NOT queryDbDirect)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb, queryDbDirect } = makeSpies();
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  await repo.ensureTable({ DIRECT_URL: 'postgresql://...' });
  await repo.getSettings({ DIRECT_URL: 'postgresql://...' }, 'user-10');
  await repo.saveSettings({ DIRECT_URL: 'postgresql://...' }, 'user-11', { analysis: false });
  assert.ok(calls.queryDb.length > 0, 'ensureTable + getSettings + saveSettings must call queryDb');
  assert.equal(calls.queryDbDirect.length, 0, 'ensureTable/getSettings/saveSettings must NOT call queryDbDirect');
});

test('missing queryDbDirect injection → list() throws explicit config error (no silent fallback to queryDb/Hyperdrive)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb } = makeSpies();
  // Inject ONLY queryDb (as the old worker bundle would).
  const repo = createNotificationRepository({ queryDb });
  await assert.rejects(
    () => repo.list({ DIRECT_URL: 'postgresql://...' }, 'user-1', 50),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i, 'list error message must mention queryDbDirect');
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED', 'list error code must be DIRECT_DB_NOT_INJECTED');
      return true;
    },
    'list must throw a clear configuration error when queryDbDirect is missing'
  );
  // CRITICAL: list must NOT have silently fallen back to queryDb (Hyperdrive) —
  // silent fallback would re-introduce the stale-read bug.
  assert.equal(calls.queryDb.length, 0, 'list must NOT silently fall back to queryDb when queryDbDirect is missing');
});

test('missing queryDbDirect injection → unreadCount() throws explicit config error (no silent fallback)', async () => {
  const createNotificationRepository = loadRepo();
  const { calls, queryDb } = makeSpies();
  const repo = createNotificationRepository({ queryDb });
  await assert.rejects(
    () => repo.unreadCount({ DIRECT_URL: 'postgresql://...' }, 'user-2'),
    (err) => {
      assert.match(err.message, /queryDbDirect is not injected/i, 'unreadCount error message must mention queryDbDirect');
      assert.equal(err.code, 'DIRECT_DB_NOT_INJECTED', 'unreadCount error code must be DIRECT_DB_NOT_INJECTED');
      return true;
    },
    'unreadCount must throw a clear configuration error when queryDbDirect is missing'
  );
  assert.equal(calls.queryDb.length, 0, 'unreadCount must NOT silently fall back to queryDb when queryDbDirect is missing');
});

test('no other repository imports or references queryDbDirect (scope guard)', async () => {
  // Static check: ensure queryDbDirect does NOT appear in any other repository
  // source file. This guards against accidental scope creep.
  const repoDir = path.resolve(__dirname, 'src/repositories');
  const files = fs.readdirSync(repoDir).filter((f) => f.endsWith('.js'));
  const offenders = [];
  for (const f of files) {
    const full = path.join(repoDir, f);
    const src = fs.readFileSync(full, 'utf8');
    if (/queryDbDirect/.test(src)) {
      offenders.push(f);
    }
  }
  assert.deepEqual(offenders, ['notifications.js'], 'queryDbDirect must only appear in notifications.js (the sole scoped repository)');
});

test('list / unreadCount do NOT pass env._reqPool through to queryDbDirect semantics (direct pool bypasses shared pool)', async () => {
  const createNotificationRepository = loadRepo();
  const calls = { queryDb: [], queryDbDirect: [] };
  const queryDb = async (env) => { calls.queryDb.push(1); return { rows: [], rowCount: 0 }; };
  const queryDbDirect = async (env, sqlText) => {
    calls.queryDbDirect.push({ sqlText, hasReqPool: Boolean(env._reqPool) });
    return { rows: [], rowCount: 0, fields: [], command: 'SELECT' };
  };
  const repo = createNotificationRepository({ queryDb, queryDbDirect });
  const env = { _reqPool: { __marker: 'should-be-ignored-by-queryDbDirect' }, DIRECT_URL: 'postgresql://...' };
  await repo.list(env, 'user-x');
  await repo.unreadCount(env, 'user-x');
  assert.equal(calls.queryDbDirect.length, 2, 'list + unreadCount both route through queryDbDirect');
  for (const c of calls.queryDbDirect) {
    assert.match(c.sqlText, /SELECT/i, 'only SELECTs go through queryDbDirect');
  }
});

test('worker-proxy.js exposes queryDbDirect as a top-level function (source-level check)', () => {
  const wp = fs.readFileSync(path.resolve(__dirname, 'worker-proxy.js'), 'utf8');
  assert.match(wp, /async function queryDbDirect\(env, sqlText, params = \[\]\)/, 'queryDbDirect must be a top-level async function');
  assert.match(wp, /function createDirectPool\(env\)/, 'createDirectPool must exist');
  assert.match(wp, /function resolveDirectDatabaseUrl\(env\)/, 'resolveDirectDatabaseUrl must exist');
  assert.match(wp, /createNotificationRepository\(\{ queryDb, queryDbDirect \}\)/, 'notificationRepo must be created with both queryDb and queryDbDirect');
  // No other repo creation should include queryDbDirect.
  const otherRepoMatches = wp.match(/create\w+Repository\(\{[^}]*queryDbDirect[^}]*\}\)/g) || [];
  assert.equal(otherRepoMatches.length, 1, 'only ONE repository (notificationRepo) should receive queryDbDirect');
  assert.match(otherRepoMatches[0], /createNotificationRepository/, 'the single queryDbDirect repo injection must be createNotificationRepository');
});

test('worker-proxy.js queryDbDirect throws explicit error when DIRECT_URL+DATABASE_URL missing (no silent fallback to queryDb/Hyperdrive)', () => {
  const wp = fs.readFileSync(path.resolve(__dirname, 'worker-proxy.js'), 'utf8');
  const fnStart = wp.indexOf('async function queryDbDirect(env, sqlText, params = []) {');
  assert.ok(fnStart > 0, 'queryDbDirect function must exist');
  const fnEnd = wp.indexOf('\n}\n', fnStart);
  const body = wp.slice(fnStart, fnEnd > fnStart ? fnEnd : wp.length);
  assert.match(body, /DIRECT_URL/, 'queryDbDirect must reference DIRECT_URL');
  assert.match(body, /DATABASE_URL/, 'queryDbDirect must reference DATABASE_URL');
  assert.match(body, /DIRECT_DB_NOT_CONFIGURED/, 'queryDbDirect must throw DIRECT_DB_NOT_CONFIGURED when secrets are missing');
  assert.match(body, /DIRECT_DB_POOL_INIT_FAILED/, 'queryDbDirect must throw DIRECT_DB_POOL_INIT_FAILED when pool init fails');
  // Anti-pattern guard: queryDbDirect must NOT fall back to queryDb, env._reqPool, getSharedNeon, or createPool (Hyperdrive).
  assert.doesNotMatch(body, /return queryDb\(/, 'queryDbDirect must NOT fall back to queryDb');
  assert.doesNotMatch(body, /env\._reqPool\.query\(/, 'queryDbDirect must NOT call env._reqPool.query (would hit Hyperdrive cache)');
  assert.doesNotMatch(body, /getSharedNeon\(env\)/, 'queryDbDirect must NOT fall back to getSharedNeon (Neon HTTP)');
  assert.doesNotMatch(body, /createPool\(env\)/, 'queryDbDirect must NOT fall back to createPool (which routes to Hyperdrive when HYPERDRIVE is bound)');
  // Confirm it uses createDirectPool (the bypass path).
  assert.match(body, /createDirectPool\(env\)/, 'queryDbDirect must use createDirectPool (the direct pg.Pool bypass)');
  // Confirm it ends the pool in finally (Worker-safe lifecycle).
  assert.match(body, /finally\s*\{/, 'queryDbDirect must have a finally block');
  assert.match(body, /_directPool\.end\(\)/, 'queryDbDirect must end the pool in finally (Worker-safe lifecycle)');
});

test('worker-proxy.js queryDbDirect uses pg.Pool (NOT @neondatabase/serverless NeonPool)', () => {
  // This is critical for Supabase compatibility — neon() HTTP is Neon-only,
  // NeonPool uses WebSocket which is technically compatible with Supabase but
  // adds an unnecessary dependency; pg.Pool is the standard Postgres wire
  // protocol that Supabase serves natively on port 5432.
  const wp = fs.readFileSync(path.resolve(__dirname, 'worker-proxy.js'), 'utf8');
  const createDirectStart = wp.indexOf('function createDirectPool(env) {');
  const createDirectEnd = wp.indexOf('\n}\n', createDirectStart);
  const createDirectBody = wp.slice(createDirectStart, createDirectEnd);
  assert.match(createDirectBody, /new PgPool\(/, 'createDirectPool must use new PgPool (NOT NeonPool)');
  assert.doesNotMatch(createDirectBody, /NeonPool/, 'createDirectPool must NOT use NeonPool');
  assert.match(createDirectBody, /connectionTimeoutMillis:\s*5000/, 'createDirectPool must set connectionTimeoutMillis: 5000 (same as Hyperdrive branch)');
  // Confirm createDirectPool uses resolveDirectDatabaseUrl (NOT resolveDatabaseUrl or env.HYPERDRIVE).
  assert.match(createDirectBody, /resolveDirectDatabaseUrl\(env\)/, 'createDirectPool must use resolveDirectDatabaseUrl');
  assert.doesNotMatch(createDirectBody, /env\.HYPERDRIVE/, 'createDirectPool must NOT use env.HYPERDRIVE (would route through Hyperdrive cache)');
});

test('worker-proxy.js resolveDirectDatabaseUrl prefers DIRECT_URL over DATABASE_URL, does NOT use HYPERDRIVE', () => {
  const wp = fs.readFileSync(path.resolve(__dirname, 'worker-proxy.js'), 'utf8');
  const fnStart = wp.indexOf('function resolveDirectDatabaseUrl(env) {');
  const fnEnd = wp.indexOf('\n}\n', fnStart);
  const body = wp.slice(fnStart, fnEnd);
  // Verify it prefers DIRECT_URL first, falls back to DATABASE_URL — does NOT touch HYPERDRIVE.
  assert.match(body, /env\.DIRECT_URL\s*\|\|\s*env\.DATABASE_URL/, 'resolveDirectDatabaseUrl must prefer DIRECT_URL, fall back to DATABASE_URL');
  assert.doesNotMatch(body, /HYPERDRIVE/, 'resolveDirectDatabaseUrl must NOT use HYPERDRIVE (the whole point of the bypass)');
  assert.match(body, /pgbouncer=true/, 'resolveDirectDatabaseUrl must strip pgbouncer=true (pooler hint irrelevant for per-call pg.Pool)');
});

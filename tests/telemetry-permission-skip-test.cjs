/**
 * TELEMETRY-PERM-FIX Phase A+B — Permission-Denied Skip Regression Tests
 *
 * Background:
 *   Production warnings fire on every 15-min cron tick + every 5-min cron
 *   tick + every /api/news-ai-monitor HTTP request:
 *     1. ensureTelemetryTables failed: permission denied for schema public
 *     2. cleanupTickLog failed: permission denied for table news_ai_tick_log
 *     3. cleanupE2ETimingLog failed: permission denied for table news_ai_e2e_log
 *
 *   Root cause: amirbtc_worker has USAGE (not CREATE) on schema public,
 *   and INSERT+SELECT (not DELETE) on the 2 telemetry tables. PostgreSQL
 *   checks privileges BEFORE checking existence, so CREATE TABLE IF NOT
 *   EXISTS fails even when the table already exists.
 *
 *   The _telemetryTablesEnsured module-level flag only skips on SUCCESS,
 *   so every call retries (and fails) every time → wasted subrequests.
 *
 * Fix (Phase A+B):
 *   - Phase A: ensureTelemetryTables gets a new _telemetryCreatePermissionDenied
 *     flag. After the first 'permission denied for schema' error in this
 *     isolate, subsequent calls short-circuit (0 DB subrequests).
 *   - Phase B: cleanupTickLog + cleanupE2ETimingLog each get their own
 *     independent flag (_tickCleanupPermissionDenied, _e2eCleanupPermissionDenied).
 *     Same pattern: after first 'permission denied for table' error,
 *     subsequent calls short-circuit.
 *
 * Critical guarantees:
 *   - Only permission-denied errors set the flags. Transient errors
 *     (timeout, connection failure) do NOT set the flags and still retry.
 *   - Flags reset on isolate cold-start (next isolate retries once).
 *     Cold-start is simulated by creating a NEW createNewsTelemetry instance.
 *   - INSERTs (insertNewsAITickLog, insertNewsAIE2ELog) are UNCHANGED —
 *     they still work, no skip logic added.
 *   - Alert/Price Alarm code path UNCHANGED (separate module).
 *
 * Run: node --test tests/telemetry-permission-skip-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const TELEMETRY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/telemetry.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/cron/scheduler.js'), 'utf8');
const ALERTS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/repositories/alerts.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source inspection: Phase A+B flags + helpers exist
// ═══════════════════════════════════════════════════════════════════════════

test('PERM-01: _telemetryCreatePermissionDenied flag declared (Phase A)', () => {
  assert.ok(TELEMETRY_SRC.includes('let _telemetryCreatePermissionDenied = false'),
    'Phase A flag _telemetryCreatePermissionDenied must be declared with initial value false');
});

test('PERM-02: _tickCleanupPermissionDenied flag declared (Phase B)', () => {
  assert.ok(TELEMETRY_SRC.includes('let _tickCleanupPermissionDenied = false'),
    'Phase B flag _tickCleanupPermissionDenied must be declared with initial value false');
});

test('PERM-03: _e2eCleanupPermissionDenied flag declared (Phase B)', () => {
  assert.ok(TELEMETRY_SRC.includes('let _e2eCleanupPermissionDenied = false'),
    'Phase B flag _e2eCleanupPermissionDenied must be declared with initial value false');
});

test('PERM-04: _isPermissionDeniedSchemaError helper exists', () => {
  assert.ok(TELEMETRY_SRC.includes('function _isPermissionDeniedSchemaError(e)'),
    'Phase A helper _isPermissionDeniedSchemaError must exist');
  assert.ok(TELEMETRY_SRC.includes("permission denied for schema"),
    'Phase A helper must check for "permission denied for schema" pattern');
});

test('PERM-05: _isPermissionDeniedTableError helper exists', () => {
  assert.ok(TELEMETRY_SRC.includes('function _isPermissionDeniedTableError(e)'),
    'Phase B helper _isPermissionDeniedTableError must exist');
  assert.ok(TELEMETRY_SRC.includes("permission denied for table"),
    'Phase B helper must check for "permission denied for table" pattern');
});

test('PERM-06: ensureTelemetryTables has Phase A skip check at top', () => {
  // The skip check must come BEFORE the try block (so it short-circuits
  // without making any DB call).
  const skipCheckIdx = TELEMETRY_SRC.indexOf('if (_telemetryCreatePermissionDenied) return');
  assert.notEqual(skipCheckIdx, -1, 'Phase A skip check must exist in ensureTelemetryTables');
  // Verify it's inside ensureTelemetryTables (between the function start and the try block)
  const fnStart = TELEMETRY_SRC.indexOf('async function ensureTelemetryTables');
  assert.ok(skipCheckIdx > fnStart, 'skip check must be inside ensureTelemetryTables');
  const tryIdx = TELEMETRY_SRC.indexOf('try {', fnStart);
  assert.ok(skipCheckIdx < tryIdx, 'skip check must come BEFORE the try block (short-circuit)');
});

test('PERM-07: cleanupTickLog has Phase B skip check at top', () => {
  const skipCheckIdx = TELEMETRY_SRC.indexOf('if (_tickCleanupPermissionDenied) return 0');
  assert.notEqual(skipCheckIdx, -1, 'Phase B skip check must exist in cleanupTickLog');
  const fnStart = TELEMETRY_SRC.indexOf('async function cleanupTickLog');
  assert.ok(skipCheckIdx > fnStart, 'skip check must be inside cleanupTickLog');
  const tryIdx = TELEMETRY_SRC.indexOf('try {', fnStart);
  assert.ok(skipCheckIdx < tryIdx, 'skip check must come BEFORE the try block');
});

test('PERM-08: cleanupE2ETimingLog has Phase B skip check at top', () => {
  const skipCheckIdx = TELEMETRY_SRC.indexOf('if (_e2eCleanupPermissionDenied) return 0');
  assert.notEqual(skipCheckIdx, -1, 'Phase B skip check must exist in cleanupE2ETimingLog');
  const fnStart = TELEMETRY_SRC.indexOf('async function cleanupE2ETimingLog');
  assert.ok(skipCheckIdx > fnStart, 'skip check must be inside cleanupE2ETimingLog');
  const tryIdx = TELEMETRY_SRC.indexOf('try {', fnStart);
  assert.ok(skipCheckIdx < tryIdx, 'skip check must come BEFORE the try block');
});

test('PERM-09: ensureTelemetryTables sets Phase A flag on permission error', () => {
  // The flag-setting must be in the catch block
  const catchIdx = TELEMETRY_SRC.indexOf('catch (e) {', TELEMETRY_SRC.indexOf('async function ensureTelemetryTables'));
  const fnEnd = TELEMETRY_SRC.indexOf('async function ', catchIdx);
  const catchBlock = TELEMETRY_SRC.slice(catchIdx, fnEnd);
  assert.ok(catchBlock.includes('_isPermissionDeniedSchemaError(e)'),
    'ensureTelemetryTables catch must call _isPermissionDeniedSchemaError(e)');
  assert.ok(catchBlock.includes('_telemetryCreatePermissionDenied = true'),
    'ensureTelemetryTables catch must set _telemetryCreatePermissionDenied = true');
});

test('PERM-10: cleanupTickLog sets Phase B flag on permission error', () => {
  const fnStart = TELEMETRY_SRC.indexOf('async function cleanupTickLog');
  const nextFn = TELEMETRY_SRC.indexOf('async function ', fnStart + 10);
  const fnBody = TELEMETRY_SRC.slice(fnStart, nextFn);
  const catchIdx = fnBody.indexOf('catch (e) {');
  const catchBlock = fnBody.slice(catchIdx);
  assert.ok(catchBlock.includes('_isPermissionDeniedTableError(e)'),
    'cleanupTickLog catch must call _isPermissionDeniedTableError(e)');
  assert.ok(catchBlock.includes('_tickCleanupPermissionDenied = true'),
    'cleanupTickLog catch must set _tickCleanupPermissionDenied = true');
});

test('PERM-11: cleanupE2ETimingLog sets Phase B flag on permission error', () => {
  const fnStart = TELEMETRY_SRC.indexOf('async function cleanupE2ETimingLog');
  const nextFn = TELEMETRY_SRC.indexOf('async function ', fnStart + 10);
  const fnBody = TELEMETRY_SRC.slice(fnStart, nextFn === -1 ? TELEMETRY_SRC.length : nextFn);
  const catchIdx = fnBody.indexOf('catch (e) {');
  const catchBlock = fnBody.slice(catchIdx);
  assert.ok(catchBlock.includes('_isPermissionDeniedTableError(e)'),
    'cleanupE2ETimingLog catch must call _isPermissionDeniedTableError(e)');
  assert.ok(catchBlock.includes('_e2eCleanupPermissionDenied = true'),
    'cleanupE2ETimingLog catch must set _e2eCleanupPermissionDenied = true');
});

test('PERM-12: 3 independent flags (no shared state between functions)', () => {
  // Each function must have its OWN flag. A failure in cleanupTickLog must
  // NOT set the flag for cleanupE2ETimingLog (and vice versa).
  const flags = [
    '_telemetryCreatePermissionDenied',
    '_tickCleanupPermissionDenied',
    '_e2eCleanupPermissionDenied',
  ];
  for (const f of flags) {
    const decls = (TELEMETRY_SRC.match(new RegExp(`let ${f} = false`, 'g')) || []).length;
    assert.equal(decls, 1, `${f} must be declared exactly once (independent flag)`);
  }
});

test('PERM-13: INSERT functions (insertNewsAITickLog, insertNewsAIE2ELog) UNCHANGED — no skip flag', () => {
  // Phase A+B must NOT touch the INSERT path. INSERTs still work even when
  // CREATE/DELETE permission is denied (amirbtc_worker has INSERT privilege).
  const insertTickStart = TELEMETRY_SRC.indexOf('async function insertNewsAITickLog');
  const insertTickEnd = TELEMETRY_SRC.indexOf('async function ', insertTickStart + 10);
  const insertTickBody = TELEMETRY_SRC.slice(insertTickStart, insertTickEnd);
  assert.ok(!insertTickBody.includes('PermissionDenied'),
    'insertNewsAITickLog must NOT have any permission-skip flag (INSERTs must always run)');
  assert.ok(insertTickBody.includes('INSERT INTO news_ai_tick_log'),
    'insertNewsAITickLog must still do INSERT INTO news_ai_tick_log');

  const insertE2EStart = TELEMETRY_SRC.indexOf('async function insertNewsAIE2ELog');
  const insertE2EEnd = TELEMETRY_SRC.indexOf('async function ', insertE2EStart + 10);
  const insertE2EBody = TELEMETRY_SRC.slice(insertE2EStart, insertE2EEnd === -1 ? TELEMETRY_SRC.length : insertE2EEnd);
  assert.ok(!insertE2EBody.includes('PermissionDenied'),
    'insertNewsAIE2ELog must NOT have any permission-skip flag (INSERTs must always run)');
  assert.ok(insertE2EBody.includes('INSERT INTO news_ai_e2e_log'),
    'insertNewsAIE2ELog must still do INSERT INTO news_ai_e2e_log');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Behavioral tests: evaluate telemetry.js source in a sandbox
// with a mock queryDb to verify runtime skip behavior.
//
// Approach: telemetry.js uses `export function` (ES module syntax) but the
// project's package.json has "type": "commonjs". Cloudflare Workers loads
// it as ESM in production; Node.js tests can't import it directly. We work
// around this by reading the source, stripping the `export ` keyword, and
// evaluating the factory function in a `vm` sandbox with a mock queryDb.
// This gives real behavioral testing without needing ESM import support.
// ═══════════════════════════════════════════════════════════════════════════

const vm = require('node:vm');

// Helper: load telemetry.js source, strip `export `, evaluate in sandbox.
// Returns a FRESH createNewsTelemetry factory each call (simulates cold-start).
function loadTelemetryFactory(queryDbImpl) {
  // Read the source fresh (don't cache — each test gets a clean instance).
  const src = fs.readFileSync(path.join(__dirname, '..', 'src/news/telemetry.js'), 'utf8');
  // Strip the `export ` keyword so the source is valid CJS in the sandbox.
  const cjsSrc = src.replace(/^export\s+function\s/m, 'function ');
  // The factory function is now a local declaration. We need to expose it.
  const wrappedSrc = cjsSrc + '\n;this.createNewsTelemetry = createNewsTelemetry;';
  const sandbox = { console, Date, Math, JSON, parseInt, String, Number, Boolean, Array, Object, Error };
  sandbox.globalThis = sandbox;
  vm.runInNewContext(wrappedSrc, sandbox);
  // Now create the telemetry instance with the mock queryDb.
  return sandbox.createNewsTelemetry({
    queryDb: queryDbImpl,
    isNewsAIEnabled: () => true,
    isNewsSummaryEnabled: () => true,
    isNewsBatchAnalysisEnabled: () => true,
    isNewsQueueEnabled: () => true,
    isNewsProviderEnabled: () => true,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD: 3,
    CIRCUIT_BREAKER_OPEN_MS: 600000,
    GROQ_ROUTER_MAX_PER_WINDOW: 3,
    NEWS_AI_CACHE_TTL: 30000,
    NEWS_SUMMARY_BACKOFF_MINUTES: [5, 15, 30],
    NEWS_SUMMARY_MAX_RETRIES: 3,
    OPENAI_MODEL: 'gpt-4o-mini',
    getSummaryQueue: () => [],
    getCircuitState: () => ({ state: 'CLOSED' }),
    _groqRouterGetKeyState: () => ({ state: 'CLOSED' }),
  });
}

// Mock queryDb that throws "permission denied for schema public"
function makePermissionDeniedSchemaQueryDb() {
  const calls = [];
  const impl = async (env, sql, params) => {
    calls.push({ sql: String(sql).slice(0, 60), params });
    const err = new Error('permission denied for schema public');
    err.code = '42501';
    throw err;
  };
  impl._calls = calls;
  return impl;
}

// Mock queryDb that throws "permission denied for table <name>"
function makePermissionDeniedTableQueryDb(tableName) {
  const calls = [];
  const impl = async (env, sql, params) => {
    calls.push({ sql: String(sql).slice(0, 60), params });
    const err = new Error(`permission denied for table ${tableName}`);
    err.code = '42501';
    throw err;
  };
  impl._calls = calls;
  return impl;
}

// Mock queryDb that throws a transient (timeout) error — must NOT set flag
function makeTransientErrorQueryDb() {
  const calls = [];
  const impl = async (env, sql, params) => {
    calls.push({ sql: String(sql).slice(0, 60), params });
    const err = new Error('Connection terminated due to connection timeout');
    err.code = 'XX800';
    throw err;
  };
  impl._calls = calls;
  return impl;
}

// Mock queryDb that succeeds (returns empty result)
function makeSuccessQueryDb() {
  const calls = [];
  const impl = async (env, sql, params) => {
    calls.push({ sql: String(sql).slice(0, 60), params });
    return { rows: [] };
  };
  impl._calls = calls;
  return impl;
}

test('PERM-BEHAVIOR-01: ensureTelemetryTables skips DB call after first permission-denied failure (Phase A)', async () => {
  const queryDb = makePermissionDeniedSchemaQueryDb();
  const telemetry = loadTelemetryFactory(queryDb);

  // First call — should attempt CREATE TABLE and fail
  await telemetry.ensureTelemetryTables({});
  const callsAfterFirst = queryDb._calls.length;
  assert.ok(callsAfterFirst >= 1,
    `First call must make at least 1 DB attempt — got ${callsAfterFirst}`);

  // Second call — must short-circuit (0 new DB calls)
  await telemetry.ensureTelemetryTables({});
  assert.equal(queryDb._calls.length, callsAfterFirst,
    `Second call must NOT make any new DB call (short-circuit) — got ${queryDb._calls.length - callsAfterFirst} extra calls`);

  // Third call — also short-circuits
  await telemetry.ensureTelemetryTables({});
  assert.equal(queryDb._calls.length, callsAfterFirst,
    `Third call must NOT make any new DB call (short-circuit) — got ${queryDb._calls.length - callsAfterFirst} extra calls`);
});

test('PERM-BEHAVIOR-02: cleanupTickLog skips DB call after first permission-denied failure (Phase B)', async () => {
  const queryDb = makePermissionDeniedTableQueryDb('news_ai_tick_log');
  const telemetry = loadTelemetryFactory(queryDb);

  const r1 = await telemetry.cleanupTickLog({}, 4);
  assert.equal(r1, 0, 'cleanupTickLog must return 0 on failure');
  const callsAfterFirst = queryDb._calls.length;
  assert.ok(callsAfterFirst >= 1, `First call must make at least 1 DB attempt — got ${callsAfterFirst}`);

  const r2 = await telemetry.cleanupTickLog({}, 4);
  assert.equal(r2, 0, 'cleanupTickLog must return 0 on skip');
  assert.equal(queryDb._calls.length, callsAfterFirst,
    `Second call must NOT make any new DB call — got ${queryDb._calls.length - callsAfterFirst} extra`);

  await telemetry.cleanupTickLog({}, 4);
  assert.equal(queryDb._calls.length, callsAfterFirst,
    `Third call must NOT make any new DB call`);
});

test('PERM-BEHAVIOR-03: cleanupE2ETimingLog skips DB call after first permission-denied failure (Phase B)', async () => {
  const queryDb = makePermissionDeniedTableQueryDb('news_ai_e2e_log');
  const telemetry = loadTelemetryFactory(queryDb);

  const r1 = await telemetry.cleanupE2ETimingLog({}, 4);
  assert.equal(r1, 0, 'cleanupE2ETimingLog must return 0 on failure');
  const callsAfterFirst = queryDb._calls.length;
  assert.ok(callsAfterFirst >= 1, `First call must make at least 1 DB attempt — got ${callsAfterFirst}`);

  const r2 = await telemetry.cleanupE2ETimingLog({}, 4);
  assert.equal(r2, 0, 'cleanupE2ETimingLog must return 0 on skip');
  assert.equal(queryDb._calls.length, callsAfterFirst,
    `Second call must NOT make any new DB call — got ${queryDb._calls.length - callsAfterFirst} extra`);

  await telemetry.cleanupE2ETimingLog({}, 4);
  assert.equal(queryDb._calls.length, callsAfterFirst, 'Third call must NOT make any new DB call');
});

test('PERM-BEHAVIOR-04: cold-start (new factory instance) retries once — flags do NOT persist across instances', async () => {
  // First instance — fail once, then short-circuit
  const queryDb1 = makePermissionDeniedSchemaQueryDb();
  const telemetry1 = loadTelemetryFactory(queryDb1);
  await telemetry1.ensureTelemetryTables({});
  await telemetry1.ensureTelemetryTables({});
  const callsInstance1 = queryDb1._calls.length;
  assert.ok(callsInstance1 >= 1 && callsInstance1 <= 4,
    `Instance 1 should make 1-4 DB calls (first fails, rest short-circuit) — got ${callsInstance1}`);

  // NEW instance (simulates cold-start) — must retry once
  const queryDb2 = makePermissionDeniedSchemaQueryDb();
  const telemetry2 = loadTelemetryFactory(queryDb2);
  await telemetry2.ensureTelemetryTables({});
  assert.ok(queryDb2._calls.length >= 1,
    `Cold-start instance must retry at least once — got ${queryDb2._calls.length}`);
});

test('PERM-BEHAVIOR-05: transient errors (timeout/connection) do NOT set flag — still retry', async () => {
  const queryDb = makeTransientErrorQueryDb();
  const telemetry = loadTelemetryFactory(queryDb);

  // First call — fails with transient error (NOT permission denied)
  await telemetry.ensureTelemetryTables({});
  const callsAfterFirst = queryDb._calls.length;
  assert.ok(callsAfterFirst >= 1, `First call must make at least 1 DB attempt`);

  // Second call — must STILL RETRY (transient errors don't set the flag)
  await telemetry.ensureTelemetryTables({});
  assert.ok(queryDb._calls.length > callsAfterFirst,
    `Second call must STILL retry (transient error did not set flag) — got ${queryDb._calls.length - callsAfterFirst} extra calls`);

  // Third call — still retries
  await telemetry.ensureTelemetryTables({});
  assert.ok(queryDb._calls.length > callsAfterFirst + 1,
    `Third call must STILL retry (transient error did not set flag)`);
});

test('PERM-BEHAVIOR-06: transient error in cleanupTickLog does NOT set flag — still retries', async () => {
  const queryDb = makeTransientErrorQueryDb();
  const telemetry = loadTelemetryFactory(queryDb);

  await telemetry.cleanupTickLog({}, 4);
  const callsAfterFirst = queryDb._calls.length;

  await telemetry.cleanupTickLog({}, 4);
  assert.ok(queryDb._calls.length > callsAfterFirst,
    `Second cleanupTickLog must STILL retry (transient error did not set flag)`);
});

test('PERM-BEHAVIOR-07: transient error in cleanupE2ETimingLog does NOT set flag — still retries', async () => {
  const queryDb = makeTransientErrorQueryDb();
  const telemetry = loadTelemetryFactory(queryDb);

  await telemetry.cleanupE2ETimingLog({}, 4);
  const callsAfterFirst = queryDb._calls.length;

  await telemetry.cleanupE2ETimingLog({}, 4);
  assert.ok(queryDb._calls.length > callsAfterFirst,
    `Second cleanupE2ETimingLog must STILL retry (transient error did not set flag)`);
});

test('PERM-BEHAVIOR-08: INSERTs still work — no skip logic on INSERT path', async () => {
  // INSERTs use a success queryDb (INSERT privilege is granted in production).
  const insertQueryDb = makeSuccessQueryDb();
  const telemetry = loadTelemetryFactory(insertQueryDb);
  await telemetry.insertNewsAITickLog({}, 'batch', { foo: 'bar' });
  assert.ok(insertQueryDb._calls.length >= 1,
    `insertNewsAITickLog must make at least 1 DB call (INSERTs are NOT skipped) — got ${insertQueryDb._calls.length}`);

  const insertQueryDb2 = makeSuccessQueryDb();
  const telemetry2 = loadTelemetryFactory(insertQueryDb2);
  await telemetry2.insertNewsAIE2ELog({}, 'https://example.com', 'groq', { bar: 'baz' });
  assert.ok(insertQueryDb2._calls.length >= 1,
    `insertNewsAIE2ELog must make at least 1 DB call (INSERTs are NOT skipped) — got ${insertQueryDb2._calls.length}`);
});

test('PERM-BEHAVIOR-09: ensureTelemetryTables success does NOT set permission-denied flag', async () => {
  // When the CREATE TABLE succeeds, the permission-denied flag must NOT be set.
  // Subsequent calls should short-circuit via _telemetryTablesEnsured.
  const queryDb = makeSuccessQueryDb();
  const telemetry = loadTelemetryFactory(queryDb);

  await telemetry.ensureTelemetryTables({});
  const callsAfterFirstSuccess = queryDb._calls.length;
  assert.ok(callsAfterFirstSuccess >= 1, `First (successful) call must make DB calls`);

  // Second call — must short-circuit via _telemetryTablesEnsured (not via
  // permission-denied flag). Either way, 0 new DB calls.
  await telemetry.ensureTelemetryTables({});
  assert.equal(queryDb._calls.length, callsAfterFirstSuccess,
    `Second call must short-circuit (success path) — got ${queryDb._calls.length - callsAfterFirstSuccess} extra`);
});

test('PERM-BEHAVIOR-10: 3 independent flags — cleanupTickLog failure does NOT set cleanupE2ETimingLog flag', async () => {
  // Custom queryDb that fails DELETE on tick_log but succeeds on e2e_log
  const calls = [];
  const queryDb = async (env, sql, params) => {
    calls.push({ sql: String(sql).slice(0, 60), params });
    if (String(sql).includes('DELETE FROM news_ai_tick_log')) {
      const err = new Error('permission denied for table news_ai_tick_log');
      err.code = '42501';
      throw err;
    }
    return { rows: [] };
  };
  queryDb._calls = calls;
  const telemetry = loadTelemetryFactory(queryDb);

  // First cleanupTickLog — fails, sets _tickCleanupPermissionDenied
  const r1 = await telemetry.cleanupTickLog({}, 4);
  assert.equal(r1, 0);
  const callsAfterFirst = calls.length;

  // Second cleanupTickLog — short-circuits (flag set)
  await telemetry.cleanupTickLog({}, 4);
  assert.equal(calls.length, callsAfterFirst,
    `Second cleanupTickLog must short-circuit — got ${calls.length - callsAfterFirst} extra`);

  // cleanupE2ETimingLog — must NOT be short-circuited (independent flag).
  // It should make a DB call (the DELETE on e2e_log).
  await telemetry.cleanupE2ETimingLog({}, 4);
  assert.ok(calls.length > callsAfterFirst,
    `cleanupE2ETimingLog must NOT be short-circuited by cleanupTickLog failure (independent flags) — got ${calls.length - callsAfterFirst} extra calls`);
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Scope verification: Alert/Price Alarm + scheduler UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

test('PERM-SCOPE-01: worker-proxy.js UNCHANGED by telemetry permission-skip fix', () => {
  // The fix only touches src/news/telemetry.js. worker-proxy.js must NOT
  // contain the new flags or helpers (it just consumes the factory).
  assert.ok(!WORKER_SRC.includes('_telemetryCreatePermissionDenied'),
    'worker-proxy.js must NOT contain _telemetryCreatePermissionDenied (fix is local to telemetry.js)');
  assert.ok(!WORKER_SRC.includes('_isPermissionDeniedSchemaError'),
    'worker-proxy.js must NOT contain _isPermissionDeniedSchemaError (fix is local to telemetry.js)');
});

test('PERM-SCOPE-02: scheduler.js UNCHANGED — cron schedule + minute-0 retry block intact', () => {
  // Verify the cron schedule markers are still present
  assert.ok(SCHEDULER_SRC.includes("'* * * * *'"),
    '1-min cron trigger unchanged');
  assert.ok(SCHEDULER_SRC.includes("'*/5 * * * *'"),
    '5-min cron trigger unchanged');
  assert.ok(SCHEDULER_SRC.includes("'*/15 * * * *'"),
    '15-min cron trigger unchanged');
  // Verify minute-0 retry block still present (H5 Layer 2+3 LIMITs)
  assert.ok(SCHEDULER_SRC.includes('retryFailedReferralRewards'),
    'retryFailedReferralRewards still called from 1-min cron');
  assert.ok(SCHEDULER_SRC.includes('retryFailedWheelRewards'),
    'retryFailedWheelRewards still called from 1-min cron');
  assert.ok(SCHEDULER_SRC.includes('retryFailedMissionRewards'),
    'retryFailedMissionRewards still called from 1-min cron');
  assert.ok(SCHEDULER_SRC.includes('retryFailedRefunds'),
    'retryFailedRefunds still called from 1-min cron');
});

test('PERM-SCOPE-03: alerts.js UNCHANGED — Alert/Price Alarm logic intact', () => {
  // Verify listActiveForCron + markTriggeredBulk are unchanged
  assert.ok(ALERTS_SRC.includes('async function listActiveForCron'),
    'listActiveForCron still exists');
  assert.ok(ALERTS_SRC.includes('async function markTriggeredBulk'),
    'markTriggeredBulk still exists');
  assert.ok(ALERTS_SRC.includes("WHERE status = 'active'"),
    'Alert status filter unchanged');
  assert.ok(ALERTS_SRC.includes('ORDER BY created_at DESC'),
    'Alert ordering unchanged (H6 audit reference)');
  // Alerts.js must NOT contain the new telemetry flags
  assert.ok(!ALERTS_SRC.includes('_telemetryCreatePermissionDenied'),
    'alerts.js must NOT be touched by telemetry fix');
});

test('PERM-SCOPE-04: telemetry.js is the ONLY file changed in this fix', () => {
  // This is a source-inspection sanity check. The diff (verified separately
  // via git diff --name-only) should show ONLY src/news/telemetry.js +
  // tests/telemetry-permission-skip-test.cjs.
  // Here we just verify the new flags/helpers are in telemetry.js, not elsewhere.
  const filesToCheck = [
    { name: 'worker-proxy.js', src: WORKER_SRC },
    { name: 'src/cron/scheduler.js', src: SCHEDULER_SRC },
    { name: 'src/repositories/alerts.js', src: ALERTS_SRC },
  ];
  for (const { name, src } of filesToCheck) {
    assert.ok(!src.includes('_telemetryCreatePermissionDenied'),
      `${name} must NOT contain _telemetryCreatePermissionDenied (scope leak)`);
    assert.ok(!src.includes('_tickCleanupPermissionDenied'),
      `${name} must NOT contain _tickCleanupPermissionDenied (scope leak)`);
    assert.ok(!src.includes('_e2eCleanupPermissionDenied'),
      `${name} must NOT contain _e2eCleanupPermissionDenied (scope leak)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — TELEMETRY-PROD-FIX: ensureTelemetryTables skips DDL in production
// ═══════════════════════════════════════════════════════════════════════════

test('PROD-DDL-01: ensureTelemetryTables has production early-return', () => {
  assert.ok(TELEMETRY_SRC.includes("env.APP_ENV") && TELEMETRY_SRC.includes("production"),
    'ensureTelemetryTables must check env.APP_ENV === production for early return');
  assert.ok(TELEMETRY_SRC.includes("_telemetryTablesEnsured = true"),
    'Production early-return must set _telemetryTablesEnsured = true (skip future DDL)');
});

test('PROD-DDL-02: ensureTelemetryTables still runs DDL in non-production', () => {
  // The DDL code (CREATE TABLE) must still be present for staging/development
  assert.ok(TELEMETRY_SRC.includes('CREATE TABLE IF NOT EXISTS news_ai_tick_log'),
    'ensureTelemetryTables must still contain CREATE TABLE for non-production environments');
  assert.ok(TELEMETRY_SRC.includes('CREATE TABLE IF NOT EXISTS news_ai_e2e_log'),
    'ensureTelemetryTables must still contain CREATE TABLE for e2e log in non-production');
});

test('PROD-DDL-03: production check comes BEFORE DDL code', () => {
  const checkIdx = TELEMETRY_SRC.indexOf("=== 'production'");
  const ddlIdx = TELEMETRY_SRC.indexOf('CREATE TABLE IF NOT EXISTS news_ai_tick_log');
  assert.ok(checkIdx > -1 && ddlIdx > -1, 'Both production check and DDL must exist');
  assert.ok(checkIdx < ddlIdx,
    'Production check must come BEFORE DDL code (so DDL is skipped in production)');
});

test('PROD-DDL-04: production check comes AFTER _telemetryTablesEnsured check', () => {
  const ensuredIdx = TELEMETRY_SRC.indexOf('if (_telemetryTablesEnsured) return');
  const checkIdx = TELEMETRY_SRC.indexOf("=== 'production'");
  assert.ok(ensuredIdx < checkIdx,
    '_telemetryTablesEnsured check must come first (fast path for repeated calls)');
});

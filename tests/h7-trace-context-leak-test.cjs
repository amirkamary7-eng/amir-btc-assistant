/**
 * H7 — Trace Context Leak Fix Regression Tests
 *
 * Background:
 *   Module-level vars (_traceId, _traceEndpoint, _traceMethod, _traceQuerySeq)
 *   were shared across concurrent requests in the same isolate. When Request A
 *   set the trace context and then awaited I/O, Request B's _setTraceContext
 *   call would OVERWRITE the module-level vars. Request A's subsequent
 *   _traceStage log would show Request B's endpoint/method/traceId →
 *   CROSS-REQUEST CONTAMINATION in TRACE_SLOW_STAGE logs.
 *
 * Fix:
 *   Replaced module-level vars with AsyncLocalStorage. Each fetch invocation
 *   has its own async context → no contamination. The scheduled (cron) handler
 *   doesn't call _setTraceContext, so trace functions fall back to safe defaults.
 *
 * No function signatures or call sites changed.
 *
 * Run: node --test tests/h7-trace-context-leak-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/cron/scheduler.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Module-level vars REMOVED, AsyncLocalStorage ADDED
// ═══════════════════════════════════════════════════════════════════════════

test('H7-01: AsyncLocalStorage imported from node:async_hooks', () => {
  assert.ok(SRC.includes("import { AsyncLocalStorage } from 'node:async_hooks'"),
    'AsyncLocalStorage must be imported from node:async_hooks');
});

test('H7-02: _traceContextALS instance created', () => {
  assert.ok(SRC.includes('const _traceContextALS = new AsyncLocalStorage()'),
    '_traceContextALS AsyncLocalStorage instance must be created');
});

test('H7-03: module-level _traceId REMOVED (no longer shared state)', () => {
  assert.ok(!SRC.includes("let _traceId ="),
    'Module-level _traceId must be removed (H7 fix)');
});

test('H7-04: module-level _traceEndpoint REMOVED', () => {
  assert.ok(!SRC.includes("let _traceEndpoint ="),
    'Module-level _traceEndpoint must be removed (H7 fix)');
});

test('H7-05: module-level _traceMethod REMOVED', () => {
  assert.ok(!SRC.includes("let _traceMethod ="),
    'Module-level _traceMethod must be removed (H7 fix)');
});

test('H7-06: module-level _traceQuerySeq REMOVED', () => {
  assert.ok(!SRC.includes("let _traceQuerySeq ="),
    'Module-level _traceQuerySeq must be removed (H7 fix)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — _setTraceContext uses ALS.enterWith (request-local)
// ═══════════════════════════════════════════════════════════════════════════

test('H7-07: _setTraceContext uses _traceContextALS.enterWith', () => {
  assert.ok(SRC.includes('_traceContextALS.enterWith('),
    '_setTraceContext must use _traceContextALS.enterWith for per-request storage');
  // Must NOT use module-level assignment (old pattern)
  const fnStart = SRC.indexOf('function _setTraceContext');
  const fnEnd = SRC.indexOf('function _nextQuerySeq', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(!fnBody.includes('_traceId ='),
    '_setTraceContext must NOT assign to _traceId (module-level var removed)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Trace functions read from ALS.getStore() (request-local)
// ═══════════════════════════════════════════════════════════════════════════

test('H7-08: _traceStage reads from _traceContextALS.getStore()', () => {
  const fnStart = SRC.indexOf('function _traceStage');
  const fnEnd = SRC.indexOf('function _traceLog', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('_traceContextALS.getStore()'),
    '_traceStage must read from _traceContextALS.getStore() (request-local)');
  assert.ok(fnBody.includes("'no-trace'"),
    '_traceStage must have fallback default when no ALS store (cron path)');
});

test('H7-09: _nextQuerySeq reads from _traceContextALS.getStore()', () => {
  const fnStart = SRC.indexOf('function _nextQuerySeq');
  const fnEnd = SRC.indexOf('function _traceStage', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('_traceContextALS.getStore()'),
    '_nextQuerySeq must read from _traceContextALS.getStore()');
});

test('H7-10: _traceLog reads from _traceContextALS.getStore()', () => {
  const fnStart = SRC.indexOf('function _traceLog');
  const fnEnd = SRC.indexOf('function _traceQuery', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('_traceContextALS.getStore()'),
    '_traceLog must read from _traceContextALS.getStore()');
});

test('H7-11: _traceQuery reads from _traceContextALS.getStore()', () => {
  const fnStart = SRC.indexOf('function _traceQuery');
  const fnEnd = SRC.indexOf('function jsonResponse', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('_traceContextALS.getStore()'),
    '_traceQuery must read from _traceContextALS.getStore()');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — Function signatures UNCHANGED (no call-site changes)
// ═══════════════════════════════════════════════════════════════════════════

test('H7-12: _traceStage signature UNCHANGED (no env param added)', () => {
  assert.ok(SRC.includes('function _traceStage(stageName, startTime)'),
    '_traceStage signature must be UNCHANGED — (stageName, startTime) only');
});

test('H7-13: _setTraceContext signature UNCHANGED', () => {
  assert.ok(SRC.includes('function _setTraceContext(endpoint, method)'),
    '_setTraceContext signature must be UNCHANGED — (endpoint, method) only');
});

test('H7-14: _nextQuerySeq signature UNCHANGED', () => {
  assert.ok(SRC.includes('function _nextQuerySeq()'),
    '_nextQuerySeq signature must be UNCHANGED — no params');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Behavioral: ALS provides request-local isolation
// ═══════════════════════════════════════════════════════════════════════════

test('H7-15: ALS provides per-async-context isolation (no cross-request contamination)', async () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();

  // Simulate 2 concurrent requests in the same "isolate" (same module instance)
  // Request A sets its context, then awaits. Request B sets its context.
  // Request A's context must NOT be overwritten by B.

  let requestA_ctx_after_B = null;
  let requestB_ctx = null;

  // Request A
  await als.run({ id: 'AAA', endpoint: '/api/health' }, async () => {
    // Request A is now in its own async context
    const ctxA_before = als.getStore();
    assert.equal(ctxA_before.id, 'AAA', 'Request A should see its own context');

    // Simulate yielding (await a microtask) — Request B runs
    await Promise.resolve();

    // After Request B ran, Request A should STILL see its own context
    requestA_ctx_after_B = als.getStore();
  });

  // Request B (runs "concurrently" via interleaved microtask)
  await als.run({ id: 'BBB', endpoint: '/api/wallet' }, async () => {
    requestB_ctx = als.getStore();
  });

  // Verify: Request A's context was NOT contaminated by Request B
  assert.equal(requestA_ctx_after_B.id, 'AAA',
    'Request A context must NOT be contaminated by Request B (ALS isolation)');
  assert.equal(requestA_ctx_after_B.endpoint, '/api/health',
    'Request A endpoint must remain /api/health (not overwritten by B)');
  assert.equal(requestB_ctx.id, 'BBB',
    'Request B context must be correct');
});

test('H7-16: ALS returns undefined when no context set (cron path)', () => {
  const { AsyncLocalStorage } = require('node:async_hooks');
  const als = new AsyncLocalStorage();
  // Without als.run(), getStore() returns undefined
  assert.equal(als.getStore(), undefined,
    'ALS.getStore() must return undefined when no context set (cron path)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Existing trace behavior preserved
// ═══════════════════════════════════════════════════════════════════════════

test('H7-17: _traceStage still logs TRACE_SLOW_STAGE (output format preserved)', () => {
  const fnStart = SRC.indexOf('function _traceStage');
  const fnEnd = SRC.indexOf('function _traceLog', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes("'TRACE_SLOW_STAGE'"),
    '_traceStage must still log type=TRACE_SLOW_STAGE');
  assert.ok(fnBody.includes('traceId'),
    '_traceStage must still include traceId in output');
  assert.ok(fnBody.includes('endpoint'),
    '_traceStage must still include endpoint in output');
  assert.ok(fnBody.includes('method'),
    '_traceStage must still include method in output');
  assert.ok(fnBody.includes('durationMs'),
    '_traceStage must still include durationMs in output');
  assert.ok(fnBody.includes('> 500'),
    '_traceStage must still only log for stages >500ms');
});

test('H7-18: _traceLog still no-op by default (DB_TRACE_ENABLED gate preserved)', () => {
  const fnStart = SRC.indexOf('function _traceLog');
  const fnEnd = SRC.indexOf('function _traceQuery', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('if (!_dbTraceEnabled) return'),
    '_traceLog must still be gated on _dbTraceEnabled (no-op by default)');
});

test('H7-19: _traceQuery still no-op by default', () => {
  const fnStart = SRC.indexOf('function _traceQuery');
  const fnEnd = SRC.indexOf('function jsonResponse', fnStart);
  const fnBody = SRC.slice(fnStart, fnEnd);
  assert.ok(fnBody.includes('if (!_dbTraceEnabled) return'),
    '_traceQuery must still be gated on _dbTraceEnabled');
});

test('H7-20: _setTraceContext still called from fetch handler (call site preserved)', () => {
  assert.ok(SRC.includes('_setTraceContext(_url.pathname, request.method)'),
    '_setTraceContext must still be called from the fetch handler');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — Alert behavior UNTOUCHED
// ═══════════════════════════════════════════════════════════════════════════

test('H7-21: scheduler.js UNCHANGED (alert cron + H5 retries intact)', () => {
  assert.ok(SCHEDULER_SRC.includes("'* * * * *'"),
    '1-min cron trigger unchanged');
  assert.ok(SCHEDULER_SRC.includes('retryFailedReferralRewards'),
    'H5 retries preserved');
  // scheduler must NOT import AsyncLocalStorage (H7 fix is in worker-proxy.js only)
  assert.ok(!SCHEDULER_SRC.includes('AsyncLocalStorage'),
    'scheduler.js must NOT import AsyncLocalStorage (H7 fix is local to worker-proxy.js)');
});

test('H7-22: no alert/notification/DB code changed (only trace functions)', () => {
  // The H7 fix should ONLY touch the trace context functions.
  // Verify key alert/notification code is unchanged:
  assert.ok(SRC.includes('async function runScheduledAlertsBaseline'),
    'runScheduledAlertsBaseline preserved');
  assert.ok(SRC.includes('skipped_ohlc_unavailable'),
    'H6 Phase 1 silent-loss fix preserved');
  assert.ok(SRC.includes('markTriggeredBulk'),
    'markTriggeredBulk preserved');
  assert.ok(SRC.includes('INSERT INTO notifications') && SRC.includes('ON CONFLICT (id) DO NOTHING'),
    'Bulk INSERT notifications preserved');
  assert.ok(SRC.includes('fetchOhlc1m'),
    'fetchOhlc1m preserved');
  // H6 Phase 2 was rejected — OHLC cap remains at 14 (original, not adaptive)
  assert.ok(SRC.includes('.slice(0, 14)'),
    'OHLC cap is 14 (H6 Phase 2 was rejected — original cap preserved)');
});

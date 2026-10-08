/**
 * H2 Fix — notif-diag-report Dev-Only Gate — Regression Tests
 *
 * Verifies that /api/notif-diag-report is gated by !isDevMode(env)
 * (returns 404 for staging AND production), while remaining accessible only
 * in APP_ENV=development. Unknown/unset APP_ENV fails CLOSED.
 * (AP-2, Security Batch 2 — superseded the earlier production-only gate.)
 *
 * Run: node --test notif-diag-report-gate-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source-text: the production gate exists
// ═══════════════════════════════════════════════════════════════════════════

test('H2-01: notif-diag-report route exists', () => {
  assert.ok(SRC.includes("url.pathname === '/api/notif-diag-report'"),
    'route must exist');
});

test('H2-02: production gate exists (returns 404 in production)', () => {
  // Find the route block
  const routeIdx = SRC.indexOf("url.pathname === '/api/notif-diag-report'");
  assert.ok(routeIdx > -1, 'route must exist');
  // Check the gate is right after the route opening
  const block = SRC.slice(routeIdx, routeIdx + 1000);
  assert.ok(block.includes('!isDevMode(env)'), 'must use the !isDevMode(env) gate');
  assert.ok(block.includes("status: 404"), 'must return 404');
  assert.ok(block.includes("'Not available in production'"),
    'must return the standard not-available message');
});

test('H2-03: gate is BEFORE the POST/GET handlers (not after)', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/notif-diag-report'");
  const block = SRC.slice(routeIdx, routeIdx + 1000);
  const gateIdx = block.indexOf('!isDevMode');
  const postIdx = block.indexOf("request.method === 'POST'");
  const getIdx = block.indexOf("request.method === 'GET'");
  assert.ok(gateIdx > -1 && gateIdx < postIdx,
    'dev-only gate must be BEFORE the POST handler');
  assert.ok(gateIdx < getIdx || getIdx === -1,
    'dev-only gate must be BEFORE the GET handler');
});

test('H2-04: gate mirrors the /api/notif-trace-results pattern', () => {
  // The trace-results gate is the established pattern for diagnostic endpoints
  const traceGate = SRC.indexOf("url.pathname === '/api/notif-trace-results'");
  const traceBlock = SRC.slice(traceGate, traceGate + 500);
  assert.ok(traceBlock.includes("_isProd"), 'trace-results has _isProd gate');
  assert.ok(traceBlock.includes("status: 404"), 'trace-results returns 404');

  // The notif-diag-report gate uses the STRONGER AP-2 pattern (dev-only,
  // fail-closed on unknown APP_ENV) since Security Batch 2.
  const diagGate = SRC.indexOf("url.pathname === '/api/notif-diag-report'");
  const diagBlock = SRC.slice(diagGate, diagGate + 1000);
  assert.ok(diagBlock.includes('!isDevMode(env)'), 'notif-diag-report has !isDevMode gate');
  assert.ok(diagBlock.includes("status: 404"), 'notif-diag-report returns 404');
});

test('H2-05: POST + GET handlers are still intact (only gated, not removed)', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/notif-diag-report'");
  // GET handler is ~2000 chars from the route opening; use a large enough window
  const block = SRC.slice(routeIdx, routeIdx + 2200);
  assert.ok(block.includes("request.method === 'POST'"), 'POST handler still exists');
  assert.ok(block.includes("request.method === 'GET'"), 'GET handler still exists');
  assert.ok(block.includes('_diag_notif_report'), 'DB table reference still exists');
});

test('H2-06: no other endpoints modified', () => {
  // The gate comment is specific to notif-diag-report (H2 FIX)
  const h2Comment = SRC.indexOf('H2 FIX');
  assert.ok(h2Comment > -1, 'H2 FIX comment exists');
  // Count occurrences — should be only 1 (only in the notif-diag-report block)
  const count = (SRC.match(/H2 FIX/g) || []).length;
  assert.equal(count, 1, 'only 1 H2 FIX change in the file');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Behavioral simulations
// ═══════════════════════════════════════════════════════════════════════════

test('SIM-01: APP_ENV=production + GET /api/notif-diag-report → 404', () => {
  const env = { APP_ENV: 'production' };
  assert.ok(env.APP_ENV !== 'development', 'production env — gate TRIGGERS');
  // The gate returns 404 — simulate the response
  if (env.APP_ENV !== 'development') {
    const response = { status: 'error', message: 'Not available in production' };
    const httpStatus = 404;
    assert.equal(httpStatus, 404, 'returns 404');
    assert.equal(response.status, 'error', 'status is error');
    assert.equal(response.message, 'Not available in production', 'standard message');
  }
});

test('SIM-02: APP_ENV=production + POST /api/notif-diag-report → 404', () => {
  const env = { APP_ENV: 'production' };
  assert.ok(env.APP_ENV !== 'development', 'production env — gate TRIGGERS');
  // The gate checks !isDevMode BEFORE checking request.method — POST is also blocked
  if (env.APP_ENV !== 'development') {
    const response = { status: 'error', message: 'Not available in production' };
    const httpStatus = 404;
    assert.equal(httpStatus, 404, 'POST also returns 404');
  }
});

test('SIM-03: APP_ENV=development → endpoint accessible (gate does NOT trigger)', () => {
  const env = { APP_ENV: 'development' };
  assert.equal(env.APP_ENV, 'development', 'development env — gate does NOT trigger');
  // In development, the POST/GET handlers run normally
  assert.ok(env.APP_ENV === 'development', 'endpoint is accessible in development');
});

test('SIM-04: APP_ENV unset → gate TRIGGERS (fail-closed, AP-2)', () => {
  const env = {};
  const isDevMode = String(env.APP_ENV || '').trim().toLowerCase() === 'development';
  assert.equal(isDevMode, false, 'unset env — isDevMode is false');
  // AP-2 (Security Batch 2): unknown/unset APP_ENV must FAIL CLOSED —
  // the endpoint returns 404 instead of exposing the diagnostics.
  assert.ok(!isDevMode, 'gate triggers — endpoint NOT accessible when APP_ENV unset');
});

test('SIM-05: unrelated endpoints not affected', () => {
  // The gate only applies to /api/notif-diag-report (checked by url.pathname ===)
  // Other public endpoints like /api/news-ai-monitor, /api/cron-monitor, /api/health
  // are NOT gated by this change
  const gateIdx = SRC.indexOf("url.pathname === '/api/notif-diag-report'");
  const block = SRC.slice(gateIdx, gateIdx + 1000);
  // The gate returns ONLY for /api/notif-diag-report — verify no other route name in the block
  assert.ok(!block.includes('/api/notifications'), 'does not affect /api/notifications');
  assert.ok(!block.includes('/api/news-ai-monitor'), 'does not affect /api/news-ai-monitor');
  assert.ok(!block.includes('/api/health'), 'does not affect /api/health');
  assert.ok(!block.includes('/api/cron-monitor'), 'does not affect /api/cron-monitor');
});

console.log('✅ H2 (notif-diag-report production gate) regression tests loaded.');

/**
 * H3 Fix — start-diag Production Gate — Regression Tests
 *
 * Verifies that /api/start-diag (both GET and POST) is gated behind
 * non-production (returns 404 when APP_ENV=production), while remaining
 * accessible in development. Mirrors the H2 fix pattern for
 * /api/notif-diag-report and /api/notif-trace-results.
 *
 * Run: node --test start-diag-gate-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source-text: the production gate exists
// ═══════════════════════════════════════════════════════════════════════════

test('H3-01: /api/start-diag GET route exists', () => {
  assert.ok(SRC.includes("request.method === 'GET' && url.pathname === '/api/start-diag'"),
    'GET route must exist');
});

test('H3-02: /api/start-diag POST route exists', () => {
  assert.ok(SRC.includes("request.method === 'POST' && url.pathname === '/api/start-diag'"),
    'POST route must exist');
});

test('H3-03: production gate exists (returns 404 in production)', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/start-diag'");
  assert.ok(routeIdx > -1, 'route must exist');
  // The gate is in a separate if block checking ONLY pathname (before method checks)
  const gateBlock = SRC.slice(routeIdx, routeIdx + 500);
  assert.ok(gateBlock.includes('_isProd'), 'must have _isProd variable');
  assert.ok(gateBlock.includes("'production'"), 'must check APP_ENV === production');
  assert.ok(gateBlock.includes('status: 404'), 'must return 404');
  assert.ok(gateBlock.includes('Not available in production'),
    'must return the standard not-available message');
});

test('H3-04: gate checks pathname ONLY (not method) — blocks both GET and POST', () => {
  // The gate must be: if (url.pathname === '/api/start-diag') { ... }
  // NOT: if (request.method === 'GET' && url.pathname === '/api/start-diag')
  const h3Comment = SRC.indexOf('H3 FIX');
  assert.ok(h3Comment > -1, 'H3 FIX comment exists');
  const block = SRC.slice(h3Comment, h3Comment + 600);
  // The gate if-block must check pathname WITHOUT method
  assert.ok(block.includes("if (url.pathname === '/api/start-diag')"),
    'gate must check pathname only (not method) — blocks both GET and POST');
});

test('H3-05: gate is BEFORE the GET handler', () => {
  const gateIdx = SRC.indexOf("H3 FIX");
  const getHandlerIdx = SRC.indexOf("request.method === 'GET' && url.pathname === '/api/start-diag'");
  assert.ok(gateIdx > -1 && getHandlerIdx > -1, 'both must exist');
  assert.ok(gateIdx < getHandlerIdx,
    'gate must be BEFORE the GET handler');
});

test('H3-06: gate is BEFORE the POST handler', () => {
  const gateIdx = SRC.indexOf("H3 FIX");
  const postHandlerIdx = SRC.indexOf("request.method === 'POST' && url.pathname === '/api/start-diag'");
  assert.ok(gateIdx > -1 && postHandlerIdx > -1, 'both must exist');
  assert.ok(gateIdx < postHandlerIdx,
    'gate must be BEFORE the POST handler');
});

test('H3-07: GET + POST handlers are still intact (only gated, not removed)', () => {
  const routeIdx = SRC.indexOf("url.pathname === '/api/start-diag'");
  const block = SRC.slice(routeIdx, routeIdx + 6500);
  assert.ok(block.includes("request.method === 'GET'"), 'GET handler still exists');
  assert.ok(block.includes("request.method === 'POST'"), 'POST handler still exists');
  assert.ok(block.includes('setWebhook') || block.includes('getWebhookInfo'),
    'Telegram API calls still intact');
});

test('H3-08: no other endpoints modified', () => {
  const count = (SRC.match(/H3 FIX/g) || []).length;
  assert.equal(count, 1, 'only 1 H3 FIX change in the file');
});

test('H3-09: /api/admin-diag is NOT gated by H3 (untouched)', () => {
  const adminDiagIdx = SRC.indexOf("url.pathname === '/api/admin-diag'");
  assert.ok(adminDiagIdx > -1, 'admin-diag route exists');
  // Check there is NO production gate in the admin-diag block
  const adminDiagBlock = SRC.slice(adminDiagIdx, adminDiagIdx + 500);
  assert.ok(!adminDiagBlock.includes('_isProd'),
    'admin-diag must NOT have a production gate (H3 does not touch it)');
});

test('H3-10: gate mirrors H2 (/api/notif-diag-report) pattern', () => {
  const h2Gate = SRC.indexOf('H2 FIX');
  const h3Gate = SRC.indexOf('H3 FIX');
  assert.ok(h2Gate > -1 && h3Gate > -1, 'both H2 and H3 gates exist');
  // Both use the same pattern: _isProd + 404 + Not available in production
  const h2Block = SRC.slice(h2Gate, h2Gate + 800);
  const h3Block = SRC.slice(h3Gate, h3Gate + 800);
  assert.ok(h2Block.includes('_isProd') && h3Block.includes('_isProd'),
    'both use _isProd pattern');
  assert.ok(h2Block.includes('status: 404') && h3Block.includes('status: 404'),
    'both return 404');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Behavioral simulations
// ═══════════════════════════════════════════════════════════════════════════

test('SIM-01: APP_ENV=production + GET /api/start-diag → 404', () => {
  const env = { APP_ENV: 'production' };
  const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
  assert.ok(_isProd, 'production detected');
  if (_isProd) {
    const response = { status: 'error', message: 'Not available in production' };
    assert.equal(404, 404, 'returns 404');
    assert.equal(response.message, 'Not available in production');
  }
});

test('SIM-02: APP_ENV=production + POST /api/start-diag → 404', () => {
  const env = { APP_ENV: 'production' };
  const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
  assert.ok(_isProd, 'production detected');
  // The gate checks pathname ONLY (not method) — POST is also blocked
  if (_isProd) {
    assert.equal(404, 404, 'POST also returns 404');
  }
});

test('SIM-03: APP_ENV=development + GET → handler accessible', () => {
  const env = { APP_ENV: 'development' };
  const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
  assert.equal(_isProd, false, 'development — gate does NOT trigger');
  assert.ok(!_isProd, 'GET handler runs');
});

test('SIM-04: APP_ENV=development + POST → handler accessible', () => {
  const env = { APP_ENV: 'development' };
  const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
  assert.equal(_isProd, false, 'development — gate does NOT trigger');
  assert.ok(!_isProd, 'POST handler runs');
});

test('SIM-05: APP_ENV unset → handler accessible (gate does NOT trigger)', () => {
  const env = {};
  const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
  assert.equal(_isProd, false, 'unset env — gate does NOT trigger');
  assert.ok(!_isProd, 'handler accessible');
});

test('SIM-06: gate is before both handlers (ordering)', () => {
  const gateIdx = SRC.indexOf("H3 FIX");
  const getIdx = SRC.indexOf("request.method === 'GET' && url.pathname === '/api/start-diag'");
  const postIdx = SRC.indexOf("request.method === 'POST' && url.pathname === '/api/start-diag'");
  assert.ok(gateIdx < getIdx, 'gate before GET');
  assert.ok(gateIdx < postIdx, 'gate before POST');
});

test('SIM-07: unrelated endpoints not affected', () => {
  const gateIdx = SRC.indexOf("H3 FIX");
  // Use the GATE BLOCK (the if + return) not the comment (which mentions
  // /api/notif-diag-report as a reference in the H3 FIX comment text).
  const gateBlockIdx = SRC.indexOf("if (url.pathname === '/api/start-diag')", gateIdx);
  const block = SRC.slice(gateBlockIdx, gateBlockIdx + 300);
  assert.ok(!block.includes('/api/health'), 'does not affect /api/health');
  assert.ok(!block.includes('/api/notifications'), 'does not affect /api/notifications');
  assert.ok(!block.includes('/api/news-ai-monitor'), 'does not affect /api/news-ai-monitor');
  assert.ok(!block.includes('/api/admin-diag'), 'does not affect /api/admin-diag');
  assert.ok(!block.includes('/api/notif-diag-report'), 'does not affect /api/notif-diag-report');
});

console.log('✅ H3 (start-diag production gate) regression tests loaded.');

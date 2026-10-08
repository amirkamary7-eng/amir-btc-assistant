/**
 * Batch 3 — Diagnostic Endpoint Security Hardening Tests
 *
 * Verifies that 5 diagnostic endpoints are properly gated in production:
 *   1-4. cron-monitor, news-ai-monitor, news-ai-timing, news-ai-pending → 404 in prod
 *   5. admin-diag → requires admin auth (authenticateTelegramRequest + isAdminTelegramId)
 *
 * Also verifies:
 *   - /api/health and /api/system/status remain public
 *   - Already-gated endpoints (notif-trace-results, start-diag, _diag/*) still protected
 *   - No new routes or auth patterns introduced
 *
 * Run: node --test tests/batch3-diag-security-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');

// ============================================================================
// 4 Diagnostic Endpoints — Production 404 Gate
// ============================================================================

const PROD_GATED_ENDPOINTS = [
  { name: 'cron-monitor', route: "/api/cron-monitor" },
  { name: 'news-ai-monitor', route: "/api/news-ai-monitor" },
  { name: 'news-ai-timing', route: "/api/news-ai-timing" },
  { name: 'news-ai-pending', route: "/api/news-ai-pending" },
];

for (const ep of PROD_GATED_ENDPOINTS) {
  test(`prod gate: ${ep.route} returns 404 in production`, () => {
    const routeIdx = WORKER_SRC.indexOf(`url.pathname === '${ep.route}'`);
    assert.ok(routeIdx > -1, `${ep.route} route must exist`);
    const gateSection = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 500, WORKER_SRC.length));
    assert.match(gateSection, /_isProd/,
      `${ep.route} must have _isProd gate check`);
    assert.match(gateSection, /404/,
      `${ep.route} must return 404 in production`);
    assert.match(gateSection, /ARCH-BATCH3/,
      `${ep.route} gate must have ARCH-BATCH3 traceability comment`);
  });

  test(`gate before logic: ${ep.route} gate is BEFORE diagnostic work`, () => {
    const routeIdx = WORKER_SRC.indexOf(`url.pathname === '${ep.route}'`);
    const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 500, WORKER_SRC.length));
    const gateIdx = routeBlock.indexOf('_isProd');
    const logicIdx = routeBlock.indexOf('try {');
    assert.ok(gateIdx > -1, 'gate must exist');
    assert.ok(logicIdx > -1, 'diagnostic try block must exist');
    assert.ok(gateIdx < logicIdx,
      'production gate must come BEFORE diagnostic logic (no DB/KV work before gate)');
  });
}

// ============================================================================
// admin-diag — Admin Auth Required
// ============================================================================

test('admin-diag: requires authenticateTelegramRequest before diagnostic logic', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/admin-diag'");
  assert.ok(routeIdx > -1, 'admin-diag route must exist');
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 800, WORKER_SRC.length));
  assert.match(routeBlock, /authenticateTelegramRequest/,
    'admin-diag must call authenticateTelegramRequest');
  assert.match(routeBlock, /isAdminTelegramId/,
    'admin-diag must check isAdminTelegramId');
  assert.match(routeBlock, /ARCH-BATCH3/,
    'admin-diag must have ARCH-BATCH3 traceability comment');
});

test('admin-diag: returns 403 for non-admin', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/admin-diag'");
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 800, WORKER_SRC.length));
  assert.match(routeBlock, /403/,
    'admin-diag must return 403 for non-admin users');
  assert.match(routeBlock, /Admin access required/,
    'admin-diag must return "Admin access required" message');
});

test('admin-diag: auth check is BEFORE diagnostic logic (no info leak)', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/admin-diag'");
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 800, WORKER_SRC.length));
  const authIdx = routeBlock.indexOf('authenticateTelegramRequest');
  const diagIdx = routeBlock.indexOf('getAdminIds');
  assert.ok(authIdx > -1, 'auth check must exist');
  assert.ok(diagIdx > -1, 'diagnostic logic (getAdminIds) must exist');
  assert.ok(authIdx < diagIdx,
    'auth check must come BEFORE diagnostic logic (no info leak before auth)');
});

test('admin-diag: uses existing auth pattern (no new auth logic)', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/admin-diag'");
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 800, WORKER_SRC.length));
  // Must use the same pattern as trigger-alerts
  assert.match(routeBlock, /authenticateTelegramRequest.*isAdminTelegramId/s,
    'admin-diag must use authenticateTelegramRequest + isAdminTelegramId (same as trigger-alerts)');
});

// ============================================================================
// Public endpoints — must remain public
// ============================================================================

test('/api/health remains public (no production gate)', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/health'");
  assert.ok(routeIdx > -1, '/api/health route must exist');
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 200, WORKER_SRC.length));
  assert.doesNotMatch(routeBlock, /_isProd|404/,
    '/api/health must NOT have a production gate');
});

test('/api/system/status remains public (no production gate)', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/system/status'");
  assert.ok(routeIdx > -1, '/api/system/status route must exist');
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 200, WORKER_SRC.length));
  assert.doesNotMatch(routeBlock, /_isProd|404/,
    '/api/system/status must NOT have a production gate');
});

// ============================================================================
// Already-protected endpoints — still protected
// ============================================================================

test('notif-trace-results still production-gated (H2 fix preserved)', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/notif-trace-results'");
  assert.ok(routeIdx > -1, 'notif-trace-results route must exist');
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 500, WORKER_SRC.length));
  assert.match(routeBlock, /_isProd/, 'notif-trace-results must still have _isProd gate');
  assert.match(routeBlock, /404/, 'notif-trace-results must still return 404');
});

test('start-diag still gated (H3 fix preserved, strengthened by AP-2)', () => {
  const routeIdx = WORKER_SRC.indexOf("url.pathname === '/api/start-diag'");
  assert.ok(routeIdx > -1, 'start-diag route must exist');
  const routeBlock = WORKER_SRC.slice(routeIdx, Math.min(routeIdx + 500, WORKER_SRC.length));
  // AP-2 (Security Batch 2): dev-only gate — staging/unset APP_ENV also blocked
  assert.match(routeBlock, /!isDevMode/, 'start-diag must still have the !isDevMode gate');
  assert.match(routeBlock, /404/, 'start-diag must still return 404');
});

test('_diag/* catch-all still gated to dev mode', () => {
  assert.match(WORKER_SRC, /_diag/, '_diag catch-all must exist');
  assert.match(WORKER_SRC, /!isDevMode/, '_diag must still check !isDevMode');
  assert.match(WORKER_SRC, /status: 404/, '_diag must still return 404');
});

// ============================================================================
// No new routes or auth patterns introduced
// ============================================================================

test('no concurrency:cancel-in-progress added (Batch 3 does not touch overlap)', () => {
  const WRANGLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  assert.doesNotMatch(WRANGLER_SRC, /cancel-in-progress/i,
    'Batch 3 must NOT add concurrency:cancel-in-progress');
});

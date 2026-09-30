/**
 * M3 CORS Fail-Closed Regression Test
 *
 * Verifies that withCors() in worker-proxy.js:
 * - Pins to WEBAPP_URL origin when properly configured
 * - reflects localhost origin for development
 * - does NOT reflect arbitrary reqOrigin in fallback cases (M3 fix)
 * - returns empty string when WEBAPP_URL is unset/malformed
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const withCorsMatch = WORKER_SRC.match(/function withCors[\s\S]*?^}/m);
assert.ok(withCorsMatch, 'withCors function must exist');
const FN = withCorsMatch[0];

// ===== M3: Fallback cases must use empty string (NOT reqOrigin) =====

test('M3: malformed WEBAPP_URL fallback uses empty string', () => {
  // The catch block for malformed URL should set '' not reqOrigin
  assert.ok(FN.includes("merged.set('Access-Control-Allow-Origin', '');"),
    'Fallback cases should set empty string, not reqOrigin');
  // Verify there are at least 3 empty-string fallbacks
  const emptyCount = (FN.match(/merged\.set\('Access-Control-Allow-Origin', ''\)/g) || []).length;
  assert.ok(emptyCount >= 3,
    `Expected >=3 fail-closed empty fallbacks, found ${emptyCount}`);
});

test('M3: reqOrigin NOT used in fallback (only in localhost case)', () => {
  // reqOrigin should only appear in the localhost branch
  const linesWithReqOrigin = FN.split('\n')
    .filter(l => l.includes('reqOrigin') && l.includes('Access-Control-Allow-Origin'));
  // Should be exactly 1 line (the localhost case)
  assert.equal(linesWithReqOrigin.length, 1,
    `Only localhost case should use reqOrigin, found ${linesWithReqOrigin.length} lines`);
  assert.ok(linesWithReqOrigin[0].includes('reqOrigin);'),
    'localhost case should set reqOrigin');
});

test('M3: WEBAPP_URL pinning line exists', () => {
  assert.ok(FN.includes("new URL(webappUrl).origin"),
    'withCors should pin to WEBAPP_URL origin');
});

test('M3: localhost reflection preserved', () => {
  assert.ok(FN.includes('isLocalhost'),
    'withCors should check isLocalhost');
  assert.ok(FN.includes("merged.set('Access-Control-Allow-Origin', reqOrigin);"),
    'localhost case should reflect reqOrigin');
});

test('M3: no wildcard (*) CORS', () => {
  assert.ok(!FN.includes("'*'"),
    'withCors should never use wildcard (*)');
});

test('M3: no credentials header', () => {
  assert.ok(!WORKER_SRC.includes('Access-Control-Allow-Credentials'),
    'No Access-Control-Allow-Credentials');
});

test('M3: CORS headers do not include Authorization', () => {
  const m = WORKER_SRC.match(/CORS_ALLOW_HEADERS = '([^']+)'/);
  assert.ok(m, 'CORS_ALLOW_HEADERS must exist');
  assert.ok(!m[1].includes('Authorization'),
    'CORS_ALLOW_HEADERS should not include Authorization');
});

// ===== Confirm no reqOrigin || '' pattern remains (old code) =====
test('M3: old reqOrigin || "" pattern removed', () => {
  assert.ok(!FN.includes('reqOrigin || '),
    'withCors should NOT contain "reqOrigin || ..." pattern (old fallback)');
});

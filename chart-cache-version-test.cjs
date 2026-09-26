/**
 * Chart Symbol Cache Version Regression Test
 *
 * Verifies that the localStorage cache key for chart symbol resolution
 * uses the correct version (v2). This ensures stale v1 cache entries
 * (from the PR #28-#31 era when /api/charts/resolve returned 500) are
 * NOT read by the frontend — all users get a fresh cache miss on their
 * next chart open, forcing a backend call to the (now-fixed) resolver.
 *
 * Run: node --test chart-cache-version-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

test('CHART-CACHE-01: localStorage key is tv_symbol_cache_v2 (not stale v1)', () => {
  // The constant CHART_SYMBOL_LS_KEY should be assigned 'tv_symbol_cache_v2'
  const match = APP_SRC.match(/const\s+CHART_SYMBOL_LS_KEY\s*=\s*['"]([^'"]+)['"]/);
  assert.ok(match, 'CHART_SYMBOL_LS_KEY constant must exist in app.js');
  const keyValue = match[1];
  assert.equal(keyValue, 'tv_symbol_cache_v2',
    `CHART_SYMBOL_LS_KEY must be 'tv_symbol_cache_v2' (got '${keyValue}'). ` +
    `Using v1 would read stale {found:false} entries from the PR #28-#31 era.`);
});

test('CHART-CACHE-02: old v1 key string does not appear as a literal anywhere', () => {
  // Search for any hardcoded 'tv_symbol_cache_v1' string literal
  // (should only appear in this test file, not in app.js)
  const v1Occurrences = (APP_SRC.match(/tv_symbol_cache_v1/g) || []).length;
  assert.equal(v1Occurrences, 0,
    `app.js should NOT contain 'tv_symbol_cache_v1' literal (found ${v1Occurrences} occurrences). ` +
    `All references should use the CHART_SYMBOL_LS_KEY constant (= 'tv_symbol_cache_v2').`);
});

test('CHART-CACHE-03: CHART_SYMBOL_LS_KEY is used in getLsChartSymbol and setLsChartSymbol', () => {
  // Verify the constant is actually used (not just declared)
  const usageCount = (APP_SRC.match(/localStorage\.(getItem|setItem)\(CHART_SYMBOL_LS_KEY/g) || []).length;
  assert.ok(usageCount >= 4,
    `CHART_SYMBOL_LS_KEY should be used in at least 4 localStorage calls (getItem + setItem in both get/set functions). ` +
    `Found ${usageCount} usages.`);
});

test('CHART-CACHE-04: TTL is still 6 hours (unchanged)', () => {
  const ttlMatch = APP_SRC.match(/const\s+CHART_SYMBOL_LS_TTL\s*=\s*([^;]+);/);
  assert.ok(ttlMatch, 'CHART_SYMBOL_LS_TTL constant must exist');
  const ttlExpr = ttlMatch[1].trim();
  // Evaluate the expression (should be 6 * 60 * 60 * 1000 = 21600000)
  const ttlValue = eval(ttlExpr);
  assert.equal(ttlValue, 21600000,
    `CHART_SYMBOL_LS_TTL should be 21600000 ms (6 hours). Got ${ttlValue} from expression: ${ttlExpr}`);
});

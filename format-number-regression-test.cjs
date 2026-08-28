/**
 * formatNumber Extraction — Regression Test
 * =========================================
 *
 * Verifies that:
 *   1. shared-utils.js defines formatNumber
 *   2. wallet.js and referral.js NO LONGER define it (use shared)
 *   3. cosmetics.js STILL has its OWN implementation (different)
 *   4. formatNumber behavior matches the original wallet/referral implementation
 *   5. All edge cases: 0, integers, decimals, large numbers, NaN, null, undefined, strings
 *   6. wallet.js and referral.js still CALL formatNumber
 *   7. prepare-pages.mjs includes shared-utils.js in hashedFiles
 *
 * Run: node --test format-number-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const sharedSrc = fs.readFileSync(path.join(__dirname, 'shared-utils.js'), 'utf8');
const walletSrc = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
const referralSrc = fs.readFileSync(path.join(__dirname, 'referral.js'), 'utf8');
const cosmeticsSrc = fs.readFileSync(path.join(__dirname, 'cosmetics.js'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// Load shared-utils.js in a sandbox for dynamic tests
const sandbox = {};
vm.createContext(sandbox);
vm.runInContext(sharedSrc, sandbox);
const formatNumber = sandbox.formatNumber;

// ============================================================================
// Static: shared-utils.js defines formatNumber
// ============================================================================

test('SHARED-1: shared-utils.js defines formatNumber', () => {
  assert.match(sharedSrc, /function\s+formatNumber\s*\(/,
    'shared-utils.js must define formatNumber()');
});

// ============================================================================
// Static: wallet.js and referral.js NO LONGER define formatNumber
// ============================================================================

test('WALLET: wallet.js no longer defines formatNumber', () => {
  const codeLines = walletSrc.split('\n').filter(l => !l.trim().startsWith('//'));
  const codeBody = codeLines.join('\n');
  assert.ok(!/function\s+formatNumber\s*\(/.test(codeBody),
    'wallet.js must NOT define formatNumber — it should use the shared version');
});

test('REFERRAL: referral.js no longer defines formatNumber', () => {
  const codeLines = referralSrc.split('\n').filter(l => !l.trim().startsWith('//'));
  const codeBody = codeLines.join('\n');
  assert.ok(!/function\s+formatNumber\s*\(/.test(codeBody),
    'referral.js must NOT define formatNumber — it should use the shared version');
});

// ============================================================================
// Static: cosmetics.js STILL has its OWN formatNumber (different implementation)
// ============================================================================

test('COSMETICS: cosmetics.js STILL defines its own formatNumber', () => {
  assert.match(cosmeticsSrc, /function\s+formatNumber\s*\(/,
    'cosmetics.js must STILL have its own formatNumber — it has a different implementation');
});

test('COSMETICS: cosmetics.js formatNumber is DIFFERENT from shared', () => {
  // cosmetics.js: return Number(n || 0).toLocaleString('en-US');
  // shared-utils.js: if (n == null || isNaN(n)) return '0'; return Number(n).toLocaleString('en-US');
  assert.match(cosmeticsSrc, /Number\s*\(\s*n\s*\|\|\s*0\s*\)/,
    'cosmetics.js uses Number(n || 0) — different from shared isNaN check');
});

// ============================================================================
// Static: wallet.js and referral.js still CALL formatNumber
// ============================================================================

test('WALLET: wallet.js still calls formatNumber', () => {
  assert.ok(walletSrc.includes('formatNumber('),
    'wallet.js must still call formatNumber() — it should resolve from shared-utils.js');
});

test('REFERRAL: referral.js still calls formatNumber', () => {
  assert.ok(referralSrc.includes('formatNumber('),
    'referral.js must still call formatNumber() — it should resolve from shared-utils.js');
});

// ============================================================================
// Dynamic: formatNumber behavior matches original wallet/referral implementation
// ============================================================================

// Original implementation (from wallet.js / referral.js — identical):
// function formatNumber(n) {
//   if (n == null || isNaN(n)) return '0';
//   return Number(n).toLocaleString('en-US');
// }

test('DYN-1: formatNumber(0) returns "0"', () => {
  assert.equal(formatNumber(0), '0');
});

test('DYN-2: formatNumber with integers', () => {
  assert.equal(formatNumber(1), '1');
  assert.equal(formatNumber(42), '42');
  assert.equal(formatNumber(1000), '1,000');
  assert.equal(formatNumber(-5), '-5');
});

test('DYN-3: formatNumber with decimals', () => {
  assert.equal(formatNumber(1.5), '1.5');
  assert.equal(formatNumber(99.99), '99.99');
  assert.equal(formatNumber(0.001), '0.001');
});

test('DYN-4: formatNumber with large numbers', () => {
  assert.equal(formatNumber(1000000), '1,000,000');
  assert.equal(formatNumber(1234567.89), '1,234,567.89');
});

test('DYN-5: formatNumber(NaN) returns "0"', () => {
  assert.equal(formatNumber(NaN), '0');
});

test('DYN-6: formatNumber(null) returns "0"', () => {
  assert.equal(formatNumber(null), '0');
});

test('DYN-7: formatNumber(undefined) returns "0"', () => {
  assert.equal(formatNumber(undefined), '0');
});

test('DYN-8: formatNumber with string numeric', () => {
  assert.equal(formatNumber('1234'), '1,234');
  assert.equal(formatNumber('0'), '0');
  assert.equal(formatNumber(''), '0'); // Number('') === 0, isNaN(0) === false → '0'
  assert.equal(formatNumber('abc'), '0'); // Number('abc') === NaN → '0'
});

test('DYN-9: behavior matches original wallet/referral implementation exactly', () => {
  // Replicate the original implementation for comparison
  function originalFormatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-US');
  }

  const testValues = [0, 1, 42, 1000, -5, 1.5, 99.99, 0.001, 1000000, 1234567.89,
                       NaN, null, undefined, '1234', '0', '', 'abc', Infinity, -Infinity];
  for (const v of testValues) {
    assert.equal(formatNumber(v), originalFormatNumber(v),
      `formatNumber(${JSON.stringify(v)}) must match original implementation`);
  }
});

// ============================================================================
// Build pipeline: shared-utils.js still in prepare-pages.mjs
// ============================================================================

test('BUILD: shared-utils.js is in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'shared-utils\.js'/,
    'prepare-pages.mjs must include shared-utils.js in the hashedFiles array');
});

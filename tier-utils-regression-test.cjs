/**
 * Shared Tier Utilities — Regression Test
 * =========================================
 *
 * Verifies that:
 *   1. shared-utils.js defines TIER_DATA, getTierKey, getTierColor, getTierRgb, applyTierVars
 *   2. wallet.js and referral.js NO LONGER define these (they use shared)
 *   3. All tier values are correct
 *   4. applyTierVars sets CSS variables correctly
 *   5. prepare-pages.mjs includes shared-utils.js in hashedFiles
 *   6. index.html loads shared-utils.js before wallet.js and referral.js
 *
 * Run: node --test tier-utils-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const sharedSrc = fs.readFileSync(path.join(__dirname, 'shared-utils.js'), 'utf8');
const walletSrc = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
const referralSrc = fs.readFileSync(path.join(__dirname, 'referral.js'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// shared-utils.js defines all 5 items
// ============================================================================

test('SHARED-1: shared-utils.js defines TIER_DATA', () => {
  assert.match(sharedSrc, /const\s+TIER_DATA\s*=\s*\{/,
    'shared-utils.js must define TIER_DATA');
});

test('SHARED-2: shared-utils.js defines getTierKey', () => {
  assert.match(sharedSrc, /function\s+getTierKey\s*\(/,
    'shared-utils.js must define getTierKey()');
});

test('SHARED-3: shared-utils.js defines getTierColor', () => {
  assert.match(sharedSrc, /function\s+getTierColor\s*\(/,
    'shared-utils.js must define getTierColor()');
});

test('SHARED-4: shared-utils.js defines getTierRgb', () => {
  assert.match(sharedSrc, /function\s+getTierRgb\s*\(/,
    'shared-utils.js must define getTierRgb()');
});

test('SHARED-5: shared-utils.js defines applyTierVars', () => {
  assert.match(sharedSrc, /function\s+applyTierVars\s*\(/,
    'shared-utils.js must define applyTierVars()');
});

// ============================================================================
// wallet.js and referral.js NO LONGER define these (use shared)
// ============================================================================

const REMOVED_ITEMS = ['TIER_DATA', 'getTierKey', 'getTierColor', 'getTierRgb', 'applyTierVars'];

for (const item of REMOVED_ITEMS) {
  test(`WALLET: wallet.js no longer defines ${item}`, () => {
    // Check for definition patterns (not call sites or comments)
    const defPattern = new RegExp(`(?:const|let|var|function)\\s+${item}\\b`);
    // Filter out comment lines
    const codeLines = walletSrc.split('\n').filter(l => !l.trim().startsWith('//'));
    const codeBody = codeLines.join('\n');
    assert.ok(!defPattern.test(codeBody),
      `wallet.js must NOT define ${item} — it should use the shared version from shared-utils.js`);
  });

  test(`REFERRAL: referral.js no longer defines ${item}`, () => {
    const defPattern = new RegExp(`(?:const|let|var|function)\\s+${item}\\b`);
    const codeLines = referralSrc.split('\n').filter(l => !l.trim().startsWith('//'));
    const codeBody = codeLines.join('\n');
    assert.ok(!defPattern.test(codeBody),
      `referral.js must NOT define ${item} — it should use the shared version from shared-utils.js`);
  });
}

// ============================================================================
// wallet.js and referral.js still CALL these functions (from shared)
// ============================================================================

test('WALLET: wallet.js still calls getTierKey (from shared)', () => {
  assert.ok(walletSrc.includes('getTierKey('),
    'wallet.js must still call getTierKey() — it should resolve from shared-utils.js');
});

test('WALLET: wallet.js still calls applyTierVars (from shared)', () => {
  assert.ok(walletSrc.includes('applyTierVars('),
    'wallet.js must still call applyTierVars() — it should resolve from shared-utils.js');
});

test('REFERRAL: referral.js still calls getTierKey (from shared)', () => {
  assert.ok(referralSrc.includes('getTierKey('),
    'referral.js must still call getTierKey() — it should resolve from shared-utils.js');
});

test('REFERRAL: referral.js still calls applyTierVars (from shared)', () => {
  assert.ok(referralSrc.includes('applyTierVars('),
    'referral.js must still call applyTierVars() — it should resolve from shared-utils.js');
});

// ============================================================================
// displayTier stays in wallet.js and referral.js (uses different translation fn)
// ============================================================================

test('WALLET: displayTier stays in wallet.js (uses WT)', () => {
  assert.match(walletSrc, /function\s+displayTier\s*\([^)]*\)\s*\{[^}]*WT\(/,
    'wallet.js must keep displayTier() — it uses WT() which is wallet-specific');
});

test('REFERRAL: displayTier stays in referral.js (uses RT)', () => {
  assert.match(referralSrc, /displayTier\s*\([^)]*\)\s*\{[^}]*RT\(/,
    'referral.js must keep displayTier() — it uses RT() which is referral-specific');
});

// ============================================================================
// Tier values are correct
// ============================================================================

test('VALUES: all 5 tiers have correct hex and rgb in shared-utils.js', () => {
  assert.match(sharedSrc, /bronze.*?#CD7F32.*?205,\s*127,\s*50/s);
  assert.match(sharedSrc, /silver.*?#C0C0C0.*?192,\s*192,\s*192/s);
  assert.match(sharedSrc, /gold.*?#FFD700.*?255,\s*215,\s*0/s);
  assert.match(sharedSrc, /platinum.*?#6CB4EE.*?108,\s*180,\s*238/s);
  assert.match(sharedSrc, /diamond.*?#00CED1.*?0,\s*206,\s*209/s);
});

// ============================================================================
// Dynamic: load shared-utils.js in a sandbox and verify function behavior
// ============================================================================

test('DYN-1: getTierKey returns correct keys for all tier names', () => {
  // Load shared-utils.js in a sandbox
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox);

  assert.equal(sandbox.getTierKey('diamond'), 'diamond');
  assert.equal(sandbox.getTierKey('DIAMOND'), 'diamond');
  assert.equal(sandbox.getTierKey('Diamond Member'), 'diamond');
  assert.equal(sandbox.getTierKey('platinum'), 'platinum');
  assert.equal(sandbox.getTierKey('gold'), 'gold');
  assert.equal(sandbox.getTierKey('silver'), 'silver');
  assert.equal(sandbox.getTierKey('bronze'), 'bronze');
  assert.equal(sandbox.getTierKey(''), 'bronze');
  assert.equal(sandbox.getTierKey(null), 'bronze');
  assert.equal(sandbox.getTierKey(undefined), 'bronze');
  assert.equal(sandbox.getTierKey('unknown'), 'bronze');
});

test('DYN-2: getTierColor returns correct hex values', () => {
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox);

  assert.equal(sandbox.getTierColor('diamond'), '#00CED1');
  assert.equal(sandbox.getTierColor('platinum'), '#6CB4EE');
  assert.equal(sandbox.getTierColor('gold'), '#FFD700');
  assert.equal(sandbox.getTierColor('silver'), '#C0C0C0');
  assert.equal(sandbox.getTierColor('bronze'), '#CD7F32');
});

test('DYN-3: getTierRgb returns correct rgb values', () => {
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox);

  assert.equal(sandbox.getTierRgb('diamond'), '0, 206, 209');
  assert.equal(sandbox.getTierRgb('platinum'), '108, 180, 238');
  assert.equal(sandbox.getTierRgb('gold'), '255, 215, 0');
  assert.equal(sandbox.getTierRgb('silver'), '192, 192, 192');
  assert.equal(sandbox.getTierRgb('bronze'), '205, 127, 50');
});

test('DYN-4: applyTierVars sets --tier-color and --tier-rgb on element', () => {
  const vm = require('node:vm');
  // Create a mock element with style.setProperty
  const mockEl = {
    style: {
      _props: {},
      setProperty(name, value) { this._props[name] = value; },
      getPropertyValue(name) { return this._props[name] || ''; },
    }
  };
  const sandbox = { mockEl };
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox);

  sandbox.applyTierVars(mockEl, 'gold');
  assert.equal(mockEl.style.getPropertyValue('--tier-color'), '#FFD700');
  assert.equal(mockEl.style.getPropertyValue('--tier-rgb'), '255, 215, 0');
});

test('DYN-5: applyTierVars handles null element gracefully', () => {
  const vm = require('node:vm');
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(sharedSrc, sandbox);

  // Should not throw
  assert.doesNotThrow(() => sandbox.applyTierVars(null, 'gold'));
  assert.doesNotThrow(() => sandbox.applyTierVars(undefined, 'gold'));
});

// ============================================================================
// Build pipeline: shared-utils.js in prepare-pages.mjs hashedFiles
// ============================================================================

test('BUILD: shared-utils.js is in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'shared-utils\.js'/,
    'prepare-pages.mjs must include shared-utils.js in the hashedFiles array');
});

// ============================================================================
// index.html: shared-utils.js loaded before wallet.js and referral.js
// ============================================================================

test('HTML: shared-utils.js script tag exists', () => {
  assert.match(htmlSrc, /<script\s+src="shared-utils\.js"\s+defer>/,
    'index.html must have <script src="shared-utils.js" defer>');
});

test('HTML: shared-utils.js loads BEFORE wallet.js', () => {
  const sharedIdx = htmlSrc.indexOf('shared-utils.js');
  const walletIdx = htmlSrc.indexOf('wallet.js');
  assert.ok(sharedIdx > -1, 'shared-utils.js script tag not found');
  assert.ok(walletIdx > -1, 'wallet.js script tag not found');
  assert.ok(sharedIdx < walletIdx,
    'shared-utils.js must load BEFORE wallet.js in index.html');
});

test('HTML: shared-utils.js loads BEFORE referral.js', () => {
  const sharedIdx = htmlSrc.indexOf('shared-utils.js');
  const referralIdx = htmlSrc.indexOf('referral.js');
  assert.ok(sharedIdx > -1, 'shared-utils.js script tag not found');
  assert.ok(referralIdx > -1, 'referral.js script tag not found');
  assert.ok(sharedIdx < referralIdx,
    'shared-utils.js must load BEFORE referral.js in index.html');
});

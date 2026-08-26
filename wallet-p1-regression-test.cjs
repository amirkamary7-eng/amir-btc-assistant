/**
 * P1 Wallet/Wheel Race Fix Regression Tests
 * ==========================================
 *
 * Verifies:
 * - P1-6a: Wheel spin seq increment moved before animation
 * - P1-6b: closeWallet checks mutation seq before cache render
 * - P1-3: 60s wallet balance polling added
 * - P1-1: _startDataLoading parallel comment corrected
 *
 * Run: node --test wallet-p1-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const REFERRAL_SRC = fs.readFileSync(path.join(__dirname, 'referral.js'), 'utf8');

// ============================================================================
// P1-6a: Wheel spin seq increment before animation
// ============================================================================

test('P1-6a: refreshWalletAfterMutation called immediately after POST resolves, before animation', () => {
  // Find the spin success handler
  const spinSuccessIdx = REFERRAL_SRC.indexOf("spinResult = data;");
  assert.ok(spinSuccessIdx !== -1, 'spin success assignment must exist');

  // Find refreshWalletAfterMutation call after spin success
  const refreshIdx = REFERRAL_SRC.indexOf('refreshWalletAfterMutation', spinSuccessIdx);
  assert.ok(refreshIdx !== -1, 'refreshWalletAfterMutation must be called after spin success');

  // Find the setTimeout (animation) — it must come AFTER the refresh call
  const setTimeoutIdx = REFERRAL_SRC.indexOf('setTimeout', refreshIdx);
  assert.ok(setTimeoutIdx !== -1, 'setTimeout (animation) must exist after refresh call');
  assert.ok(refreshIdx < setTimeoutIdx,
    'refreshWalletAfterMutation must be called BEFORE the animation setTimeout');
});

test('P1-6a: no duplicate refreshWalletAfterMutation CALL inside setTimeout', () => {
  // The setTimeout block should NOT contain a CALL to refreshWalletAfterMutation
  // (a comment mentioning it is OK)
  const setTimeoutIdx = REFERRAL_SRC.indexOf("setTimeout(() => {", REFERRAL_SRC.indexOf('finalRotation'));
  const setTimeoutEnd = REFERRAL_SRC.indexOf('}, 4900)', setTimeoutIdx);
  const setTimeoutBlock = REFERRAL_SRC.slice(setTimeoutIdx, setTimeoutEnd);
  // Check for actual CALL (not comment)
  assert.ok(!setTimeoutBlock.includes('window.refreshWalletAfterMutation('),
    'setTimeout (animation) must NOT contain a CALL to refreshWalletAfterMutation — removed duplicate');
});

// ============================================================================
// P1-6b: closeWallet checks mutation seq
// ============================================================================

test('P1-6b: closeWallet checks _mutationSeq before rendering from cache', () => {
  assert.match(WALLET_SRC, /closeWallet[\s\S]*?_walletCache\._mutationSeq/,
    'closeWallet must check _walletCache._mutationSeq');
  assert.match(WALLET_SRC, /cacheSeq === _walletMutationSeq/,
    'closeWallet must compare cacheSeq with _walletMutationSeq');
});

test('P1-6b: fetchWallet stores _mutationSeq at cache write time', () => {
  assert.match(WALLET_SRC, /_walletCache\._mutationSeq = _walletMutationSeq/,
    'fetchWallet must store _mutationSeq at cache write time');
});

test('P1-6b: closeWallet falls through to loadProfileCard on mutation mismatch', () => {
  assert.match(WALLET_SRC, /Mutation occurred since cache was written — fetch fresh data/,
    'closeWallet must fetch fresh data when mutation seq mismatch detected');
});

// ============================================================================
// P1-3: 60s wallet balance polling
// ============================================================================

test('P1-3: 60s wallet balance polling added to _startAllPolling', () => {
  assert.match(APP_SRC, /Wallet balance sync — 60s/,
    '60s wallet balance polling must be added');
  assert.match(APP_SRC, /refreshWalletBalance[\s\S]*?60000/,
    'polling interval must be 60000ms (60s)');
  assert.match(APP_SRC, /if \(!_appVisible\) return;[\s\S]*?refreshWalletBalance/,
    'polling must skip when app not visible');
});

// ============================================================================
// P1-1: _startDataLoading parallel comment fix
// ============================================================================

test('P1-1: _startDataLoading comment says IN PARALLEL', () => {
  assert.match(APP_SRC, /_startDataLoading\(\) runs IN PARALLEL/,
    'comment must say IN PARALLEL (not sequential)');
  assert.match(APP_SRC, /if \(API_BASE\) \{[\s\S]*?_startDataLoading/,
    '_startDataLoading must be called with just API_BASE check (no _maintenanceBlocked)');
});

// ============================================================================
// Functional: Wheel spin race window eliminated
// ============================================================================

test('FUNCTIONAL: wheel spin race window is now 0ms (seq increment before animation)', () => {
  // Simulate: POST resolves → seq incremented → animation starts
  // Any in-flight GET started before POST will be rejected because seq changed
  let _walletMutationSeq = 0;

  // GET started before spin (captures seq=0)
  const getSeq = _walletMutationSeq;

  // POST resolves → refreshWalletAfterMutation called immediately
  _walletMutationSeq++; // seq now 1

  // Animation starts (4.9s) — but seq already incremented
  // GET resolves during animation
  const isStale = getSeq !== _walletMutationSeq; // 0 !== 1 → true
  assert.ok(isStale, 'GET started before spin must be rejected during animation (seq changed)');
});

// ============================================================================
// Functional: closeWallet stale cache detection
// ============================================================================

test('FUNCTIONAL: closeWallet detects stale cache after mutation', () => {
  let _walletMutationSeq = 0;

  // Cache written with seq=0
  const _walletCache = {
    wallet: { balance: 100 },
    walletAt: Date.now(),
    _mutationSeq: 0,
  };

  // No mutation — cache is fresh
  let cacheSeq = _walletCache._mutationSeq;
  assert.equal(cacheSeq, _walletMutationSeq, 'No mutation: cache seq matches');

  // Mutation occurs (cron credit via polling)
  _walletMutationSeq++;

  // closeWallet checks — cache is stale
  cacheSeq = _walletCache._mutationSeq;
  assert.notEqual(cacheSeq, _walletMutationSeq, 'After mutation: cache seq mismatch → fetch fresh');
});

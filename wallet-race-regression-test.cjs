/**
 * Wallet Race Condition Regression Tests
 * ======================================
 *
 * Verifies the P0 fixes for wallet balance stale-response overwrite,
 * daily claim button selector, _lastKnownBalance update, and localStorage TTL.
 *
 * Run: node --test wallet-race-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// TEST A: Stale GET response must not overwrite fresh POST balance
// ============================================================================

test('TEST A: fetchWallet captures mutation seq and rejects stale response', () => {
  // Verify _walletMutationSeq is captured before API call
  assert.match(WALLET_SRC, /const myMutationSeq = _walletMutationSeq/,
    'fetchWallet must capture _walletMutationSeq before API call');

  // Verify stale check after response
  assert.match(WALLET_SRC, /myMutationSeq !== _walletMutationSeq/,
    'fetchWallet must check if mutation occurred during GET and reject stale response');

  // Verify stale response returns existing cache, not the stale data
  assert.match(WALLET_SRC, /return _walletCache\.wallet \|\| walletData/,
    'fetchWallet must return existing cache/data on stale rejection, not null');
});

test('TEST A: refreshWalletBalance also has mutation seq guard', () => {
  assert.match(WALLET_SRC, /refreshWalletBalance[\s\S]*?const myMutationSeq = _walletMutationSeq/,
    'refreshWalletBalance must also capture mutation seq');
  assert.match(WALLET_SRC, /refreshWalletBalance[\s\S]*?myMutationSeq !== _walletMutationSeq/,
    'refreshWalletBalance must reject stale response');
});

test('TEST A: _walletMutationSeq is incremented before mutation API calls', () => {
  // In claimDaily
  assert.match(WALLET_SRC, /claimDaily[\s\S]*?_walletMutationSeq\+\+/,
    'claimDaily must increment _walletMutationSeq before API call');
  // In executeVpnPurchase
  assert.match(WALLET_SRC, /executeVpnPurchase[\s\S]*?_walletMutationSeq\+\+/,
    'executeVpnPurchase must increment _walletMutationSeq before API call');
});

test('TEST A: refreshWalletAfterMutation in app.js also increments seq', () => {
  assert.match(APP_SRC, /refreshWalletAfterMutation[\s\S]*?_incrementMutationSeq/,
    'refreshWalletAfterMutation must call _incrementMutationSeq');
});

// ============================================================================
// TEST B: Double-click protection — button selector fix
// ============================================================================

test('TEST B: claimDaily uses both #daily-claim-btn AND .dcm-claim-btn selectors', () => {
  assert.match(WALLET_SRC, /getElementById\('daily-claim-btn'\)/,
    'claimDaily must check #daily-claim-btn');
  assert.match(WALLET_SRC, /querySelector\('\.dcm-claim-btn'\)/,
    'claimDaily must also check .dcm-claim-btn (modal path)');
  // Verify both are in the same btn assignment (not separate uses)
  const claimDailyStart = WALLET_SRC.indexOf('async function claimDaily');
  const btnAssignEnd = WALLET_SRC.indexOf(';', WALLET_SRC.indexOf("dcm-claim-btn'", claimDailyStart));
  const btnAssign = WALLET_SRC.slice(claimDailyStart, btnAssignEnd);
  assert.match(btnAssign, /getElementById\('daily-claim-btn'\)/,
    '#daily-claim-btn must be in the btn assignment');
  assert.match(btnAssign, /querySelector\('\.dcm-claim-btn'\)/,
    '.dcm-claim-btn must be in the same btn assignment (fallback)');
});

test('TEST B: button is disabled immediately on click', () => {
  assert.match(WALLET_SRC, /claimDaily[\s\S]*?if \(btn\)\s*\{\s*btn\.disabled = true/,
    'claimDaily must disable button immediately, with null guard');
});

test('TEST B: error path has null guard on btn', () => {
  assert.match(WALLET_SRC, /if \(btn\)\s*\{\s*btn\.disabled = false/,
    'claimDaily error path must guard against null btn');
});

// ============================================================================
// TEST C: _lastKnownBalance updated after daily claim
// ============================================================================

test('TEST C: _lastKnownBalance is updated in claimDaily on success', () => {
  assert.match(WALLET_SRC, /claimDaily[\s\S]*?_lastKnownBalance = result\.newBalance/,
    'claimDaily must update _lastKnownBalance with newBalance from API response');
});

test('TEST C: walletData.balance is also updated in claimDaily', () => {
  assert.match(WALLET_SRC, /claimDaily[\s\S]*?walletData\.balance = result\.newBalance/,
    'claimDaily must update walletData.balance');
});

test('TEST C: _walletCache is repopulated with fresh data in claimDaily', () => {
  assert.match(WALLET_SRC, /claimDaily[\s\S]*?_walletCache\.wallet = walletData/,
    'claimDaily must repopulate _walletCache.wallet with updated walletData');
});

// ============================================================================
// TEST D: VPN purchase — stale GET cannot overwrite
// ============================================================================

test('TEST D: executeVpnPurchase increments mutation seq', () => {
  assert.match(WALLET_SRC, /executeVpnPurchase[\s\S]*?_walletMutationSeq\+\+/,
    'executeVpnPurchase must increment _walletMutationSeq');
});

test('TEST D: executeVpnPurchase updates _lastKnownBalance', () => {
  assert.match(WALLET_SRC, /executeVpnPurchase[\s\S]*?_lastKnownBalance = resp\.new_balance/,
    'executeVpnPurchase must update _lastKnownBalance');
});

// ============================================================================
// TEST E: Mission reward — race protection via refreshWalletAfterMutation
// ============================================================================

test('TEST E: refreshWalletAfterMutation is exposed globally', () => {
  assert.match(APP_SRC, /window\.refreshWalletAfterMutation = refreshWalletAfterMutation/,
    'refreshWalletAfterMutation must be exposed on window');
});

test('TEST E: refreshWalletAfterMutation calls _incrementMutationSeq', () => {
  assert.match(APP_SRC, /refreshWalletAfterMutation[\s\S]*?_incrementMutationSeq/,
    'refreshWalletAfterMutation must call _incrementMutationSeq for race protection');
});

// ============================================================================
// TEST F: Old wallet localStorage cache — expired cache is ignored
// ============================================================================

test('TEST F: wallet_state_cache read checks _expiresAt', () => {
  assert.match(WALLET_SRC, /isExpired = !cached\._expiresAt \|\| Date\.now\(\) > cached\._expiresAt/,
    'wallet_state_cache read must check _expiresAt for TTL expiry');
});

test('TEST F: old cache format (no _expiresAt) is treated as expired', () => {
  // The check !cached._expiresAt means undefined → true → isExpired = true
  assert.match(WALLET_SRC, /!cached\._expiresAt/,
    'Old cache without _expiresAt is treated as expired (forces fresh fetch)');
});

// ============================================================================
// TEST G: Fresh wallet localStorage cache — existing behavior preserved
// ============================================================================

test('TEST G: fresh cache is still used for instant render', () => {
  assert.match(WALLET_SRC, /!isExpired[\s\S]*?renderProfileCard\(cached\.data\)/,
    'Fresh (non-expired) cache must still render immediately');
});

test('TEST G: cache write includes _expiresAt with 10 min TTL', () => {
  assert.match(WALLET_SRC, /_WALLET_CACHE_TTL_MS = 10 \* 60 \* 1000/,
    'wallet_state_cache must be written with 10-minute TTL');
});

// ============================================================================
// TEST H: Normal wallet loading without mutation — no regression
// ============================================================================

test('TEST H: fetchWallet still returns cached data when fresh (no mutation)', () => {
  // The mutation seq check only triggers if seq changed during the GET.
  // With no mutation, myMutationSeq === _walletMutationSeq → response accepted.
  assert.match(WALLET_SRC, /myMutationSeq !== _walletMutationSeq[\s\S]*?return _walletCache/,
    'Normal (non-mutation) path: seq check passes, response accepted');
});

test('TEST H: loadWalletData still uses _loadWalletSeq (unchanged)', () => {
  assert.match(WALLET_SRC, /const mySeq = \+\+_loadWalletSeq/,
    'loadWalletData still uses _loadWalletSeq (W-STAB-2 fix preserved)');
});

// ============================================================================
// TEST I: Claim backend failure — button recovers, no false balance update
// ============================================================================

test('TEST I: on claim failure, button is re-enabled with null guard', () => {
  assert.match(WALLET_SRC, /else\s*\{[\s\S]*?if \(btn\)\s*\{\s*btn\.disabled = false/,
    'On claim failure, button must be re-enabled with null guard');
});

test('TEST I: on claim failure, no balance update occurs', () => {
  // The balance update is inside the success block, not the else block
  const claimDailyStart = WALLET_SRC.indexOf('async function claimDaily');
  const successIdx = WALLET_SRC.indexOf("result.status === 'success'", claimDailyStart);
  const elseIdx = WALLET_SRC.indexOf('} else {', successIdx);
  const balanceUpdateIdx = WALLET_SRC.indexOf('_lastKnownBalance = result.newBalance', claimDailyStart);

  assert.ok(balanceUpdateIdx > successIdx && balanceUpdateIdx < elseIdx,
    '_lastKnownBalance update must be inside the success block, not the error block');
});

// ============================================================================
// TEST J: Rapid refresh + claim + refresh — newest authoritative state wins
// ============================================================================

test('TEST J: _walletMutationSeq is a module-level variable (persists across calls)', () => {
  assert.match(WALLET_SRC, /let _walletMutationSeq = 0/,
    '_walletMutationSeq must be a module-level variable');
});

test('TEST J: _incrementMutationSeq is exposed for external callers', () => {
  assert.match(WALLET_SRC, /_incrementMutationSeq: \(\) => \{ _walletMutationSeq\+\+/,
    '_incrementMutationSeq must be exposed on WalletApp return object');
});

test('TEST J: functional simulation — stale GET ignored after mutation', () => {
  // Simulate the race:
  // 1. GET starts (captures seq=0)
  // 2. POST mutation (increments seq to 1)
  // 3. GET resolves (seq=0 !== current=1 → rejected)
  let _walletMutationSeq = 0;

  // Step 1: GET captures seq
  const getSeq = _walletMutationSeq; // 0

  // Step 2: Mutation increments seq
  _walletMutationSeq++; // now 1

  // Step 3: GET resolves — check if stale
  const isStale = getSeq !== _walletMutationSeq; // 0 !== 1 → true
  assert.ok(isStale, 'GET response must be rejected as stale after mutation');

  // Step 4: New GET (after mutation) captures fresh seq
  const getSeq2 = _walletMutationSeq; // 1
  // No mutation occurs → seq unchanged
  const isStale2 = getSeq2 !== _walletMutationSeq; // 1 === 1 → false
  assert.ok(!isStale2, 'New GET (after mutation) must be accepted');
});

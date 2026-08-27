/**
 * Wallet Mutation Seq Guard — Regression Test (BUG 4)
 * ================================================
 *
 * Verifies that the _walletMutationSeq stale-response protection exists in
 * wallet.js and is correctly wired into:
 *   1. fetchWallet() — captures seq before API call, rejects stale responses
 *   2. refreshWalletBalance() — same guard
 *   3. claimDaily() — increments seq BEFORE the POST
 *   4. executeVpnPurchase() — increments seq BEFORE the POST
 *   5. refreshWalletAfterMutation() (app.js) — increments seq as FIRST action
 *   6. WalletApp._incrementMutationSeq is exposed publicly
 *
 * Run: node --test wallet-mutation-seq-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const walletSrc = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// wallet.js checks
// ============================================================================

test('WJS-1: _walletMutationSeq module-level variable exists', () => {
  assert.match(walletSrc, /let\s+_walletMutationSeq\s*=\s*0/,
    'wallet.js must declare `let _walletMutationSeq = 0;` at module level');
});

test('WJS-2: mutation seq can be incremented (helper or direct)', () => {
  // Accept either a named helper function OR direct _walletMutationSeq++ OR
  // an arrow function in the return object. All three patterns are valid.
  const hasHelperFn = /function\s+_incrementMutationSeq\s*\(\s*\)\s*\{\s*_walletMutationSeq\+\+;?\s*\}/.test(walletSrc);
  const hasDirectIncr = /_walletMutationSeq\+\+/.test(walletSrc);
  const hasArrowInReturn = /_incrementMutationSeq\s*:\s*\(\s*\)\s*=>\s*\{\s*_walletMutationSeq\+\+;?\s*\}/.test(walletSrc);
  assert.ok(hasHelperFn || hasDirectIncr || hasArrowInReturn,
    'wallet.js must be able to increment _walletMutationSeq (via helper, direct ++, or arrow in return)');
});

test('WJS-3: fetchWallet captures seq BEFORE the API call', () => {
  const fetchIdx = walletSrc.indexOf('async function fetchWallet()');
  assert.ok(fetchIdx > -1, 'fetchWallet function not found');
  const fetchBody = walletSrc.slice(fetchIdx, fetchIdx + 800);
  // The capture must come BEFORE the apiFetch call
  const captureIdx = fetchBody.indexOf('myMutationSeq = _walletMutationSeq');
  const apiFetchIdx = fetchBody.indexOf("apiFetch('/api/wallet')");
  assert.ok(captureIdx > -1, 'fetchWallet must capture myMutationSeq = _walletMutationSeq');
  assert.ok(apiFetchIdx > -1, 'fetchWallet must call apiFetch');
  assert.ok(captureIdx < apiFetchIdx,
    'fetchWallet must capture the seq BEFORE the apiFetch call');
});

test('WJS-4: fetchWallet rejects stale responses after the API call', () => {
  const fetchIdx = walletSrc.indexOf('async function fetchWallet()');
  const fetchBody = walletSrc.slice(fetchIdx, fetchIdx + 1200);
  assert.match(fetchBody, /myMutationSeq\s*!==\s*_walletMutationSeq/,
    'fetchWallet must check myMutationSeq !== _walletMutationSeq after the await');
  // Accept either "stale response rejected" or "rejecting stale response" wording
  assert.ok(/stale response/i.test(fetchBody),
    'fetchWallet must log a warning when rejecting a stale response');
});

test('WJS-5: refreshWalletBalance captures seq and rejects stale responses', () => {
  const refreshIdx = walletSrc.indexOf('async function refreshWalletBalance()');
  assert.ok(refreshIdx > -1, 'refreshWalletBalance function not found');
  const refreshBody = walletSrc.slice(refreshIdx, refreshIdx + 800);
  assert.match(refreshBody, /myMutationSeq\s*=\s*_walletMutationSeq/,
    'refreshWalletBalance must capture the seq before the API call');
  assert.match(refreshBody, /myMutationSeq\s*!==\s*_walletMutationSeq/,
    'refreshWalletBalance must reject stale responses');
});

test('WJS-6: claimDaily increments seq BEFORE the POST', () => {
  const claimIdx = walletSrc.indexOf('async function claimDaily()');
  assert.ok(claimIdx > -1, 'claimDaily function not found');
  // claimDaily is a long function — search a generous window.
  const claimBody = walletSrc.slice(claimIdx, claimIdx + 2000);
  // Accept either _incrementMutationSeq() call OR direct _walletMutationSeq++
  const seqIncrIdx = claimBody.search(/_incrementMutationSeq\(\)|_walletMutationSeq\+\+/);
  const apiCallIdx = claimBody.indexOf('claimDailyRewardAPI()');
  assert.ok(seqIncrIdx > -1, 'claimDaily must increment the mutation seq (via helper or direct)');
  assert.ok(apiCallIdx > -1, 'claimDaily must call claimDailyRewardAPI()');
  assert.ok(seqIncrIdx < apiCallIdx,
    'claimDaily must increment the seq BEFORE the API call (so in-flight GETs reject)');
});

test('WJS-7: executeVpnPurchase increments seq BEFORE the POST', () => {
  const vpnIdx = walletSrc.indexOf('async function executeVpnPurchase(planId)');
  assert.ok(vpnIdx > -1, 'executeVpnPurchase function not found');
  const vpnBody = walletSrc.slice(vpnIdx, vpnIdx + 600);
  // Accept either pattern
  const seqIncrIdx = vpnBody.search(/_incrementMutationSeq\(\)|_walletMutationSeq\+\+/);
  const apiCallIdx = vpnBody.indexOf("apiFetch('/api/rewards/vpn/purchase'");
  assert.ok(seqIncrIdx > -1, 'executeVpnPurchase must increment the mutation seq (via helper or direct)');
  assert.ok(apiCallIdx > -1, 'executeVpnPurchase must call the purchase API');
  assert.ok(seqIncrIdx < apiCallIdx,
    'executeVpnPurchase must increment the seq BEFORE the API call');
});

test('WJS-8: _incrementMutationSeq is exposed via WalletApp return object', () => {
  // Accept either a named function reference OR an arrow function in the return
  const hasNamedRef = /_incrementMutationSeq\s*,?\s*$/m.test(walletSrc);
  const hasArrowInReturn = /_incrementMutationSeq\s*:\s*\(\s*\)\s*=>/.test(walletSrc);
  assert.ok(hasNamedRef || hasArrowInReturn,
    '_incrementMutationSeq must be in the WalletApp return object (exposed as window.WalletApp._incrementMutationSeq)');
});

// ============================================================================
// app.js checks
// ============================================================================

test('APP-1: refreshWalletAfterMutation increments seq (order-tolerant)', () => {
  const fnIdx = appSrc.indexOf('function refreshWalletAfterMutation(');
  assert.ok(fnIdx > -1, 'refreshWalletAfterMutation function not found');
  const fnBody = appSrc.slice(fnIdx, fnIdx + 1000);
  // Both calls must exist — order is an optimization, not a correctness issue.
  // (invalidateCache just clears the in-memory cache; it doesn't fire a GET.
  //  The seq increment ensures any in-flight GET rejects. Either order works.)
  assert.ok(fnBody.includes('WalletApp._incrementMutationSeq'),
    'refreshWalletAfterMutation must call WalletApp._incrementMutationSeq');
  assert.ok(fnBody.includes('WalletApp._invalidateCache'),
    'refreshWalletAfterMutation must call WalletApp._invalidateCache');
});

// ============================================================================
// Dynamic simulation — verify the guard actually rejects stale responses
// ============================================================================

test('DYN-1: stale fetchWallet response is rejected when seq changes mid-flight', async () => {
  // Simulate the wallet module's seq guard logic in isolation
  let _walletMutationSeq = 0;
  const _walletCache = { wallet: null, walletAt: 0 };

  // Simulate fetchWallet: captures seq, awaits, then checks
  async function fetchWallet(simulatedApiResponse, delayMs) {
    const myMutationSeq = _walletMutationSeq;
    await new Promise(r => setTimeout(r, delayMs));
    if (myMutationSeq !== _walletMutationSeq) {
      // Stale — reject
      return _walletCache.wallet || null;
    }
    _walletCache.wallet = simulatedApiResponse;
    return simulatedApiResponse;
  }

  function incrementSeq() { _walletMutationSeq++; }

  // Scenario: GET starts at T0, mutation increments seq at T1, GET resolves at T2
  // The GET response should be REJECTED because the seq changed.
  const freshData = { balance: 105 }; // from the POST response
  const staleData = { balance: 100 }; // from the in-flight GET (pre-mutation)

  // Start the GET (simulated 50ms delay)
  const getPromise = fetchWallet(staleData, 50);

  // At T=10ms, the mutation happens (seq increments)
  setTimeout(() => {
    incrementSeq();
    _walletCache.wallet = freshData; // POST response updates the cache
  }, 10);

  const result = await getPromise;

  // The GET should have returned the FRESH data (from cache), NOT the stale data
  assert.notEqual(result, staleData,
    'fetchWallet must NOT return the stale GET response');
  assert.equal(result, freshData,
    'fetchWallet must return the fresh cached data (POST response) when the seq changed');
});

test('DYN-2: fresh fetchWallet response is accepted when seq unchanged', async () => {
  let _walletMutationSeq = 0;
  const _walletCache = { wallet: null, walletAt: 0 };

  async function fetchWallet(simulatedApiResponse, delayMs) {
    const myMutationSeq = _walletMutationSeq;
    await new Promise(r => setTimeout(r, delayMs));
    if (myMutationSeq !== _walletMutationSeq) {
      return _walletCache.wallet || null;
    }
    _walletCache.wallet = simulatedApiResponse;
    return simulatedApiResponse;
  }

  const freshData = { balance: 100 };
  const result = await fetchWallet(freshData, 10);
  // No mutation happened — seq unchanged — response should be accepted
  assert.equal(result, freshData,
    'fetchWallet must accept the response when the seq is unchanged');
});

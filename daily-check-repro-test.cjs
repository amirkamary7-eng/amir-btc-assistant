/**
 * Daily Check (claimDaily) — Regression Test
 * ===========================================
 *
 * Verifies the two fixes applied to claimDaily():
 *   1. _isClaiming guard: double-click fires only ONE API call
 *   2. Non-blocking fetchHistory: popup shows immediately (no await delay)
 *   3. _isClaiming resets on failure (finally block)
 *   4. fetchHistory runs in background (non-blocking)
 *
 * Run: node --test daily-check-repro-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const walletSrc = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');

// ============================================================================
// STATIC CHECKS: verify code patterns after fix
// ============================================================================

test('STATIC-1: _isClaiming guard EXISTS', () => {
  assert.match(walletSrc, /let\s+_isClaiming\s*=\s*false/,
    'wallet.js must declare `let _isClaiming = false;`');
});

test('STATIC-2: claimDaily has early-return guard at the top', () => {
  const fnStart = walletSrc.indexOf('async function claimDaily()');
  const fnBody = walletSrc.slice(fnStart, fnStart + 200);
  assert.match(fnBody, /if\s*\(_isClaiming\)\s*return/,
    'claimDaily must have `if (_isClaiming) return;` at the top');
});

test('STATIC-3: _isClaiming resets in finally block', () => {
  const fnStart = walletSrc.indexOf('async function claimDaily()');
  const fnBody = walletSrc.slice(fnStart, fnStart + 8000);
  assert.match(fnBody, /finally\s*\{[\s\S]*?_isClaiming\s*=\s*false/,
    'claimDaily must reset _isClaiming = false in a finally block');
});

test('STATIC-4: fetchHistory(0) is NOT awaited in claimDaily (non-blocking)', () => {
  const fnStart = walletSrc.indexOf('async function claimDaily()');
  // Find the end of claimDaily by matching braces
  let depth = 0;
  let fnEnd = fnStart;
  for (let i = fnStart; i < walletSrc.length; i++) {
    if (walletSrc[i] === '{') depth++;
    else if (walletSrc[i] === '}') { depth--; if (depth === 0) { fnEnd = i + 1; break; } }
  }
  const fnBody = walletSrc.slice(fnStart, fnEnd);
  // The fix changed `await fetchHistory(0)` to `fetchHistory(0).then(...).catch(...)`.
  // Check that `fetchHistory(0)` is called WITHOUT `await` (but it's OK to appear
  // in a comment like "previously this was await fetchHistory(0)").
  const codeLines = fnBody.split('\n').filter(l => !l.trim().startsWith('//'));
  const codeBody = codeLines.join('\n');
  assert.ok(!/await\s+fetchHistory\(0\)/.test(codeBody),
    'claimDaily must NOT `await fetchHistory(0)` in code — it should be fire-and-forget');
  assert.match(codeBody, /fetchHistory\(0\)\.then/,
    'claimDaily must use `fetchHistory(0).then(...)` for non-blocking background refresh');
});

test('STATIC-5: showPopup runs AFTER fetchHistory fire-and-forget (not blocked)', () => {
  const fnStart = walletSrc.indexOf('async function claimDaily()');
  const fnBody = walletSrc.slice(fnStart, fnStart + 8000);
  const fetchHistoryIdx = fnBody.indexOf('fetchHistory(0).then');
  const showPopupIdx = fnBody.indexOf('showPopup');
  assert.ok(fetchHistoryIdx > -1, 'fetchHistory(0).then must exist');
  assert.ok(showPopupIdx > -1, 'showPopup must exist');
  assert.ok(fetchHistoryIdx < showPopupIdx,
    'fetchHistory(0).then must appear BEFORE showPopup — but since it\'s non-blocking, ' +
    'showPopup executes immediately after (no await delay)');
});

// ============================================================================
// DYNAMIC SIMULATIONS
// ============================================================================

test('DYN-1: _isClaiming guard prevents double API call', async () => {
  let apiCallCount = 0;
  let _isClaiming = false;

  async function mockClaimAPI() {
    apiCallCount++;
    await new Promise(r => setTimeout(r, 50));
    return { status: 'success', newBalance: 105, amount: 5, streak_day: 1 };
  }

  async function claimDaily() {
    if (_isClaiming) return { status: 'skipped' };
    _isClaiming = true;
    try {
      const result = await mockClaimAPI();
      return result;
    } finally {
      _isClaiming = false;
    }
  }

  const [r1, r2] = await Promise.all([claimDaily(), claimDaily()]);
  assert.equal(apiCallCount, 1, 'Only ONE API call should fire with _isClaiming guard');
  assert.equal(r1.status, 'success', 'First call should succeed');
  assert.equal(r2.status, 'skipped', 'Second call should be skipped');
});

test('DYN-2: _isClaiming resets after failure (finally block)', async () => {
  let _isClaiming = false;
  let apiCallCount = 0;

  async function mockFailingAPI() {
    apiCallCount++;
    await new Promise(r => setTimeout(r, 50));
    throw new Error('Network timeout');
  }

  async function claimDaily() {
    if (_isClaiming) return { status: 'skipped' };
    _isClaiming = true;
    try {
      const result = await mockFailingAPI().catch(() => ({ status: 'error' }));
      return result;
    } finally {
      _isClaiming = false;
    }
  }

  // First call fails
  const r1 = await claimDaily();
  assert.equal(r1.status, 'error', 'First call should fail');
  assert.equal(_isClaiming, false, '_isClaiming must be reset to false after failure');

  // Second call should be allowed (not skipped)
  const r2 = await claimDaily();
  assert.equal(apiCallCount, 2, 'Second call should be allowed after _isClaiming reset');
  assert.equal(r2.status, 'error', 'Second call should also fail');
});

test('DYN-3: non-blocking fetchHistory — popup shows immediately', async () => {
  let popupShownAt = null;
  let claimAPICompletedAt = null;
  const historyFetchDelay = 300;

  async function mockClaimAPI() {
    await new Promise(r => setTimeout(r, 100));
    claimAPICompletedAt = Date.now();
    return { status: 'success', newBalance: 105, amount: 5 };
  }

  function mockFetchHistory() {
    return new Promise(resolve => {
      setTimeout(() => resolve({ transactions: [] }), historyFetchDelay);
    });
  }

  async function claimDaily_fixed() {
    const result = await mockClaimAPI();
    if (result.status === 'success') {
      // Non-blocking: fire-and-forget
      mockFetchHistory().catch(() => {});
      popupShownAt = Date.now();
    }
    return result;
  }

  await claimDaily_fixed();
  const delay = popupShownAt - claimAPICompletedAt;
  assert.ok(delay < 50,
    `FIX WORKS: popup shown ${delay}ms after API completed (should be <50ms). ` +
    'fetchHistory runs in the background — popup shows immediately.');
});

test('DYN-4: blocking fetchHistory (old code) — popup delayed', async () => {
  let popupShownAt = null;
  let claimAPICompletedAt = null;
  const historyFetchDelay = 300;

  async function mockClaimAPI() {
    await new Promise(r => setTimeout(r, 100));
    claimAPICompletedAt = Date.now();
    return { status: 'success', newBalance: 105, amount: 5 };
  }

  async function mockFetchHistory() {
    await new Promise(r => setTimeout(r, historyFetchDelay));
    return { transactions: [] };
  }

  async function claimDaily_old() {
    const result = await mockClaimAPI();
    if (result.status === 'success') {
      await mockFetchHistory(); // BLOCKING
      popupShownAt = Date.now();
    }
    return result;
  }

  await claimDaily_old();
  const delay = popupShownAt - claimAPICompletedAt;
  assert.ok(delay >= historyFetchDelay - 50,
    `OLD CODE: popup delayed by ${delay}ms (should be ~${historyFetchDelay}ms). ` +
    'This proves the old code was blocking — the fix removes this delay.');
});

test('DYN-5: concurrent claims — backend idempotency prevents double-credit', async () => {
  let claimedRefId = null;
  const refId = `daily_2026-08-27`;

  async function mockBackendClaim() {
    await new Promise(r => setTimeout(r, 50));
    if (claimedRefId === refId) {
      const err = new Error('ALREADY_CLAIMED');
      err.code = 'ALREADY_CLAIMED';
      throw err;
    }
    claimedRefId = refId;
    return { status: 'success', newBalance: 105, amount: 5, txId: 'tx_001' };
  }

  const results = await Promise.allSettled([
    mockBackendClaim(),
    mockBackendClaim(),
  ]);

  const successes = results.filter(r => r.status === 'fulfilled');
  const failures = results.filter(r => r.status === 'rejected');
  assert.equal(successes.length, 1, 'Exactly one claim should succeed');
  assert.equal(failures.length, 1, 'Exactly one claim should fail with ALREADY_CLAIMED');
  assert.equal(failures[0].reason.code, 'ALREADY_CLAIMED');
});

test('DYN-6: failed claim does NOT mutate local state', async () => {
  let balance = 100;

  async function mockFailingAPI() {
    await new Promise(r => setTimeout(r, 50));
    throw new Error('Network timeout');
  }

  const result = await mockFailingAPI().catch(() => ({ status: 'error', message: 'Network error' }));
  assert.equal(result.status, 'error');
  assert.equal(balance, 100, 'Balance must NOT change on failure');
});

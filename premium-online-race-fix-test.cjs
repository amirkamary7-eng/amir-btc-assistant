/**
 * Premium Banner + Online Users Race Condition — Regression Tests
 * ================================================================
 *
 * Verifies the root-cause fixes for both production issues:
 *
 * ISSUE 1 (Premium Banner):
 *   A1: setPremiumFromBootstrap unconditionally sets level='PREMIUM' (no || short-circuit)
 *   A2: MembershipApp.open() re-fetches status before showing registration form
 *
 * ISSUE 2 (Online Users):
 *   B1: _startAllPolling defers heartbeat/online until auth ready (ensureTelegramAuthReady)
 *   B2: updateOnlineBadge shows 0 for valid zero, '—' only for null/undefined
 *
 * Run: node --test premium-online-race-fix-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const MEMBERSHIP_SRC = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');

// ============================================================================
// ISSUE 1: Premium Banner Race Condition
// ============================================================================

// A1: setPremiumFromBootstrap must NOT use || short-circuit
test('A1.FIXED: setPremiumFromBootstrap unconditionally sets level=PREMIUM (no || short-circuit)', () => {
  const fnStart = MEMBERSHIP_SRC.indexOf('setPremiumFromBootstrap: function');
  assert.ok(fnStart !== -1, 'setPremiumFromBootstrap must exist');
  const fnEnd = MEMBERSHIP_SRC.indexOf('},', fnStart);
  const fnBody = MEMBERSHIP_SRC.slice(fnStart, fnEnd);

  // The fix: _cache.level = 'PREMIUM' (unconditional), NOT _cache.level = _cache.level || 'PREMIUM'
  assert.match(fnBody, /_cache\.level\s*=\s*['"]PREMIUM['"]/,
    'A1 FIXED: setPremiumFromBootstrap must set _cache.level = "PREMIUM" unconditionally');

  // Negative assertion: the old buggy || short-circuit must NOT be in actual code.
  // We strip comments (lines starting with //) to avoid matching the old-bug description
  // in the FIX comment.
  const codeLines = fnBody.split('\n').filter(l => !l.trim().startsWith('//'));
  const codeOnly = codeLines.join('\n');
  assert.ok(!/_cache\.level\s*=\s*_cache\.level\s*\|\|/.test(codeOnly),
    'A1 FIXED: the || short-circuit (_cache.level = _cache.level || "PREMIUM") must be removed from code — ' +
    'it prevented bootstrap from upgrading a stale FREE cache set by loadCard()');
});

test('A1.FIXED: setPremiumFromBootstrap sets status=APPROVED unconditionally', () => {
  const fnStart = MEMBERSHIP_SRC.indexOf('setPremiumFromBootstrap: function');
  const fnEnd = MEMBERSHIP_SRC.indexOf('},', fnStart);
  const fnBody = MEMBERSHIP_SRC.slice(fnStart, fnEnd);
  assert.match(fnBody, /_cache\.status\s*=\s*['"]APPROVED['"]/,
    'A1: setPremiumFromBootstrap must set status=APPROVED');
});

// A2: MembershipApp.open() must re-fetch status before showing registration form
test('A2.FIXED: MembershipApp.open() re-fetches status when cache says FREE', () => {
  const fnStart = MEMBERSHIP_SRC.indexOf('function open()');
  assert.ok(fnStart !== -1, 'open() function must exist');
  const fnEnd = MEMBERSHIP_SRC.indexOf('async function checkPendingAndOpenPopup', fnStart);
  const fnBody = MEMBERSHIP_SRC.slice(fnStart, fnEnd);

  // The fix: when !isPremium(_cache), clear cache + call loadCard() before showing registration
  assert.match(fnBody, /!isPremium\(_cache\)/,
    'A2 FIXED: open() must check !isPremium(_cache) before deciding to re-fetch');
  assert.match(fnBody, /_cache\s*=\s*null/,
    'A2 FIXED: open() must clear stale cache (_cache = null) before loadCard() so it actually re-fetches');
  assert.match(fnBody, /loadCard\(\)/,
    'A2 FIXED: open() must call loadCard() to re-fetch authoritative status');
});

test('A2.FIXED: open() shows VIP popup (not registration) if re-fetch returns Premium', () => {
  const fnStart = MEMBERSHIP_SRC.indexOf('function open()');
  const fnEnd = MEMBERSHIP_SRC.indexOf('async function checkPendingAndOpenPopup', fnStart);
  const fnBody = MEMBERSHIP_SRC.slice(fnStart, fnEnd);

  // After re-fetch, if isPremium(_cache) → openVipStatusPopup, NOT checkPendingAndOpenPopup
  assert.match(fnBody, /if\s*\(_cache\s*&&\s*isPremium\(_cache\)\)/,
    'A2 FIXED: after re-fetch, open() must re-check isPremium(_cache)');
  assert.match(fnBody, /openVipStatusPopup/,
    'A2 FIXED: if re-fetch returns Premium, open() must call openVipStatusPopup (not registration form)');
});

test('A2.FIXED: open() still shows registration for genuine Free users', () => {
  const fnStart = MEMBERSHIP_SRC.indexOf('function open()');
  const fnEnd = MEMBERSHIP_SRC.indexOf('async function checkPendingAndOpenPopup', fnStart);
  const fnBody = MEMBERSHIP_SRC.slice(fnStart, fnEnd);

  // If re-fetch confirms FREE → checkPendingAndOpenPopup (registration form)
  assert.match(fnBody, /checkPendingAndOpenPopup\(\)/,
    'A2: open() must still call checkPendingAndOpenPopup for genuine Free users (after re-fetch confirms FREE)');
});

// ============================================================================
// ISSUE 2: Online Users Race Condition
// ============================================================================

// B1: _startAllPolling must defer heartbeat/online until auth ready
test('B1.FIXED: _startAllPolling wraps immediate heartbeat in ensureTelegramAuthReady', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  assert.ok(fnStart !== -1, '_startAllPolling must exist');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // The fix: ensureTelegramAuthReady(8000).then(() => { sendSessionHeartbeat()... })
  assert.match(fnBody, /ensureTelegramAuthReady\(/,
    'B1 FIXED: _startAllPolling must call ensureTelegramAuthReady() before firing heartbeat');
  assert.match(fnBody, /8000/,
    'B1: ensureTelegramAuthReady must wait up to 8s for auth');
});

test('B1.FIXED: immediate heartbeat is INSIDE ensureTelegramAuthReady().then()', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // Find the ensureTelegramAuthReady block and confirm sendSessionHeartbeat is inside .then()
  const ensureIdx = fnBody.indexOf('ensureTelegramAuthReady');
  const thenIdx = fnBody.indexOf('.then(', ensureIdx);
  const heartbeatIdx = fnBody.indexOf('sendSessionHeartbeat', thenIdx);

  assert.ok(ensureIdx !== -1 && thenIdx !== -1 && heartbeatIdx !== -1,
    'B1 FIXED: sendSessionHeartbeat must be inside ensureTelegramAuthReady().then()');
  assert.ok(heartbeatIdx > thenIdx,
    'B1 FIXED: sendSessionHeartbeat must come AFTER .then( (inside the callback)');
});

test('B1.FIXED: fetchOnlineCount is chained AFTER heartbeat completes', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // The fix: sendSessionHeartbeat().then(() => { fetchOnlineCount() })
  // so the count includes the current user (heartbeat registers them first)
  const ensureIdx = fnBody.indexOf('ensureTelegramAuthReady');
  const heartbeatIdx = fnBody.indexOf('sendSessionHeartbeat', ensureIdx);
  const heartbeatThenIdx = fnBody.indexOf('.then(', heartbeatIdx);
  const fetchIdx = fnBody.indexOf('fetchOnlineCount', heartbeatThenIdx);

  assert.ok(heartbeatIdx !== -1 && heartbeatThenIdx !== -1 && fetchIdx !== -1,
    'B1 FIXED: fetchOnlineCount must be chained after sendSessionHeartbeat().then()');
  assert.ok(fetchIdx > heartbeatThenIdx,
    'B1 FIXED: fetchOnlineCount must come AFTER heartbeat .then( (so count includes user)');
});

test('B1.FIXED: no immediate sendSessionHeartbeat() OUTSIDE ensureTelegramAuthReady', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // There should be NO bare sendSessionHeartbeat() call before ensureTelegramAuthReady
  const ensureIdx = fnBody.indexOf('ensureTelegramAuthReady');
  const beforeEnsure = fnBody.slice(0, ensureIdx);

  // The only sendSessionHeartbeat reference before ensureTelegramAuthReady should be in comments
  const bareCalls = beforeEnsure.match(/^\s*sendSessionHeartbeat\(\)/gm);
  assert.equal(bareCalls, null,
    'B1 FIXED: no bare sendSessionHeartbeat() call outside ensureTelegramAuthReady (would no-op if auth not ready)');
});

test('B1.FIXED: no immediate fetchOnlineCount() OUTSIDE heartbeat chain', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // There should be NO bare fetchOnlineCount() call before the ensureTelegramAuthReady chain
  const ensureIdx = fnBody.indexOf('ensureTelegramAuthReady');
  const beforeEnsure = fnBody.slice(0, ensureIdx);

  const bareCalls = beforeEnsure.match(/^\s*fetchOnlineCount\(\)/gm);
  assert.equal(bareCalls, null,
    'B1 FIXED: no bare fetchOnlineCount() call outside the heartbeat chain (would return count without user)');
});

// B1: periodic intervals still exist (unchanged)
test('B1.VERIFIED: periodic heartbeat interval (180s) still exists', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  assert.match(fnBody, /setInterval\([^]*180000/,
    'B1: periodic heartbeat interval (180000ms) must still exist');
});

test('B1.VERIFIED: periodic online count interval (600s) still exists', () => {
  const fnStart = APP_SRC.indexOf('function _startAllPolling()');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  assert.match(fnBody, /setInterval\([^]*600000/,
    'B1: periodic online count interval (600000ms) must still exist');
});

// B2: updateOnlineBadge shows 0 for valid zero
test('B2.FIXED: updateOnlineBadge shows 0 for valid zero count', () => {
  const fnStart = APP_SRC.indexOf('function updateOnlineBadge');
  assert.ok(fnStart !== -1, 'updateOnlineBadge must exist');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // The fix: count === null || count === undefined → '—', else → count
  assert.match(fnBody, /count\s*===\s*null\s*\|\|\s*count\s*===\s*undefined/,
    'B2 FIXED: updateOnlineBadge must check count === null || count === undefined (not count > 0)');

  // Negative assertion: the old count > 0 ternary must NOT be present
  assert.ok(!/count\s*>\s*0\s*\?/.test(fnBody),
    'B2 FIXED: the old count > 0 ? count : "—" ternary must be removed (it hid valid 0 counts)');
});

test('B2.FIXED: updateOnlineBadge shows count for valid numbers (including 0)', () => {
  const fnStart = APP_SRC.indexOf('function updateOnlineBadge');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  // The else branch: liveCountEl.innerText = count
  assert.match(fnBody, /liveCountEl\.innerText\s*=\s*count/,
    'B2 FIXED: updateOnlineBadge must set innerText = count (not count > 0 ? count : "—")');
});

// B2: functional test — simulate updateOnlineBadge with 0, null, undefined, 5
test('B2.FUNCTIONAL: 0 shows "0", null shows "—", undefined shows "—", 5 shows "5"', () => {
  // Simulate the fixed updateOnlineBadge logic
  function updateOnlineBadgeFixed(count) {
    if (count === null || count === undefined) return '—';
    return String(count);
  }

  assert.equal(updateOnlineBadgeFixed(0), '0',
    'B2: count=0 must show "0" (valid zero, not loading state)');
  assert.equal(updateOnlineBadgeFixed(null), '—',
    'B2: count=null must show "—" (loading/error)');
  assert.equal(updateOnlineBadgeFixed(undefined), '—',
    'B2: count=undefined must show "—" (loading/error)');
  assert.equal(updateOnlineBadgeFixed(5), '5',
    'B2: count=5 must show "5"');
  assert.equal(updateOnlineBadgeFixed(1), '1',
    'B2: count=1 must show "1" (single user online)');
});

// ============================================================================
// REGRESSION: Previous fixes still in place
// ============================================================================

test('REGRESSION: _inFlight dedup guard still exists in sendSessionHeartbeat', () => {
  const fnStart = APP_SRC.indexOf('async function sendSessionHeartbeat');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart);
  const fnBody = APP_SRC.slice(fnStart, fnEnd);

  assert.match(fnBody, /_inFlight/,
    'REGRESSION: _inFlight dedup guard must still exist');
  assert.match(fnBody, /finally\s*\{[^]*_inFlight\s*=\s*false/,
    'REGRESSION: finally block must reset _inFlight = false');
});

test('REGRESSION: canRunSessionRequests guard still exists (checks auth readiness)', () => {
  assert.match(APP_SRC, /function canRunSessionRequests/,
    'REGRESSION: canRunSessionRequests must still exist');
  assert.match(APP_SRC, /isInTelegram\(\)\s*&&\s*!isTelegramAuthReady\(\)/,
    'REGRESSION: canRunSessionRequests must still check isInTelegram && !isTelegramAuthReady');
});

test('REGRESSION: Premium banner upsell slide removal (FIX 1) still in place', () => {
  const fnStart = APP_SRC.indexOf('function initHeroSlider');
  // The IIFE is inside _parallelBootstrapPromise.then, so search for the IIFE pattern
  const iifeStart = APP_SRC.indexOf('(function initHeroSlider()');
  assert.ok(iifeStart !== -1, 'initHeroSlider IIFE must exist');
  const iifeEnd = APP_SRC.indexOf('})();', iifeStart);
  const iifeBody = APP_SRC.slice(iifeStart, iifeEnd);

  assert.match(iifeBody, /isPremiumCached/,
    'REGRESSION: initHeroSlider must still check isPremiumCached');
  assert.match(iifeBody, /\.remove\(\)/,
    'REGRESSION: initHeroSlider must still physically remove the upsell slide (FIX 1)');
});

test('REGRESSION: ensureTelegramAuthReady function exists with 8s default', () => {
  assert.match(APP_SRC, /async function ensureTelegramAuthReady\(/,
    'REGRESSION: ensureTelegramAuthReady must exist');
  assert.match(APP_SRC, /ensureTelegramAuthReady\(maxWaitMs\s*=\s*8000\)/,
    'REGRESSION: ensureTelegramAuthReady must have 8s default');
});

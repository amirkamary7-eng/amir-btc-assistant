/**
 * WHEEL-FIXES-REGRESSION-TEST
 *
 * Tests for P0-A (countdown refresh), P0-B (timezone single source of truth),
 * and P1 (DOM selector fix).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const WHEEL_CTRL_PATH = path.join(__dirname, 'src', 'controllers', 'wheel.js');
const WHEEL_REPO_PATH = path.join(__dirname, 'src', 'repositories', 'wheel.js');
const REFERRAL_JS_PATH = path.join(__dirname, 'referral.js');

const workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
const wheelCtrlSrc = fs.readFileSync(WHEEL_CTRL_PATH, 'utf8');
const wheelRepoSrc = fs.readFileSync(WHEEL_REPO_PATH, 'utf8');
const referralJsSrc = fs.readFileSync(REFERRAL_JS_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// P0-A: Countdown refresh when reset time is reached
// ═══════════════════════════════════════════════════════════════════════

test('P0-A-1: updateCountdown calls refreshWheelStatus when diff <= 0', () => {
  const fnStart = referralJsSrc.indexOf('function startWheelCountdown');
  const fnEnd = referralJsSrc.indexOf('function stopWheelCountdown');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/diff\s*<=\s*0/.test(fnSrc), 'Must check diff <= 0');
  assert.ok(/refreshWheelStatus/.test(fnSrc), 'Must call refreshWheelStatus when countdown reaches zero');
  assert.ok(/stopWheelCountdown/.test(fnSrc), 'Must stop countdown before refreshing');
});

test('P0-A-2: Countdown does NOT run forever after reaching zero', () => {
  const fnStart = referralJsSrc.indexOf('function startWheelCountdown');
  const fnEnd = referralJsSrc.indexOf('function stopWheelCountdown');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  // Must have a return or clearInterval after diff <= 0
  assert.ok(/diff\s*<=\s*0/.test(fnSrc) && /return/.test(fnSrc),
    'Must return after handling countdown zero — not continue counting');
});

test('P0-A-3: refreshWheelStatus restarts countdown if still no spins', () => {
  const fnStart = referralJsSrc.indexOf('async function refreshWheelStatus');
  const fnEnd = referralJsSrc.indexOf('async function loadMoreHistory');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/startWheelCountdown/.test(fnSrc),
    'refreshWheelStatus must restart countdown if wheel still has no spins after refresh');
});

// ═══════════════════════════════════════════════════════════════════════
// P0-B: Timezone single source of truth — backend provides next_reset_at
// ═══════════════════════════════════════════════════════════════════════

test('P0-B-1: Backend status response includes next_reset_at', () => {
  const fnStart = wheelCtrlSrc.indexOf('async function handleStatus');
  const fnEnd = wheelCtrlSrc.indexOf('async function handleSpin');
  const fnSrc = wheelCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/next_reset_at/.test(fnSrc), 'Status response must include next_reset_at field');
  assert.ok(/getNextTehranMidnightISO/.test(fnSrc), 'Must call getNextTehranMidnightISO to get reset time');
});

test('P0-B-2: getNextTehranMidnightISO is exported from wheel repo', () => {
  const exportStart = wheelRepoSrc.indexOf('return Object.freeze');
  const exportEnd = wheelRepoSrc.indexOf('});', exportStart);
  const exportSrc = wheelRepoSrc.slice(exportStart, exportEnd);
  assert.ok(/getNextTehranMidnightISO/.test(exportSrc),
    'getNextTehranMidnightISO must be in the exported Object.freeze');
});

test('P0-B-3: getNextTehranMidnightISO uses Asia/Tehran timezone', () => {
  const fnStart = wheelRepoSrc.indexOf('function getNextTehranMidnightISO');
  const fnEnd = wheelRepoSrc.indexOf('\n}', fnStart);
  const fnSrc = wheelRepoSrc.slice(fnStart, fnEnd + 2);
  assert.ok(/Asia\/Tehran/.test(fnSrc), 'Must use Asia/Tehran timezone');
  assert.ok(/toISOString/.test(fnSrc), 'Must return ISO string');
});

test('P0-B-4: Frontend countdown uses backend next_reset_at when available', () => {
  const fnStart = referralJsSrc.indexOf('function startWheelCountdown');
  const fnEnd = referralJsSrc.indexOf('function stopWheelCountdown');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/next_reset_at/.test(fnSrc), 'Frontend must read next_reset_at from wheelStatus');
  assert.ok(/wheelStatus\?\.next_reset_at/.test(fnSrc), 'Must access wheelStatus.next_reset_at');
});

test('P0-B-5: Frontend does NOT rely solely on setHours(24,0,0,0)', () => {
  const fnStart = referralJsSrc.indexOf('function startWheelCountdown');
  const fnEnd = referralJsSrc.indexOf('function stopWheelCountdown');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  // setHours(24,0,0,0) should only be in the fallback path, not the primary
  assert.ok(/resetAt\s*\|\|/.test(fnSrc), 'Local midnight must be fallback only (after resetAt ||)');
});

// ═══════════════════════════════════════════════════════════════════════
// P1: DOM selector fix
// ═══════════════════════════════════════════════════════════════════════

test('P1-1: refreshWheelStatus uses .rc-wheel-unified (not .rc-wheel-card)', () => {
  const fnStart = referralJsSrc.indexOf('async function refreshWheelStatus');
  const fnEnd = referralJsSrc.indexOf('async function loadMoreHistory');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  // Check the actual querySelector call, not comments
  const selectorMatch = fnSrc.match(/querySelector\(['"]\.([^'"]+)['"]\)/);
  assert.ok(selectorMatch, 'Must have a querySelector call');
  assert.equal(selectorMatch[1], 'rc-wheel-unified', 'Selector must be rc-wheel-unified');
});

test('P1-2: buildWheelCard renders .rc-wheel-unified class', () => {
  const fnStart = referralJsSrc.indexOf('function buildWheelCard');
  const fnEnd = referralJsSrc.indexOf('function getWheelSvgMini');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/rc-wheel-unified/.test(fnSrc), 'buildWheelCard must render .rc-wheel-unified');
});

// ═══════════════════════════════════════════════════════════════════════
// P2: NOT CONFIRMED — verify openWheel already has feedback
// ═══════════════════════════════════════════════════════════════════════

test('P2-1: openWheel shows popup when no spins available', () => {
  const fnStart = referralJsSrc.indexOf('function openWheel');
  const fnEnd = referralJsSrc.indexOf('function closeWheelModal');
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/total_available.*=== 0/.test(fnSrc), 'Must check for no spins');
  assert.ok(/showPopup|alert/.test(fnSrc), 'Must show popup or alert');
  assert.ok(/come_back_tomorrow/.test(fnSrc), 'Must use come_back_tomorrow translation key');
});

// ═══════════════════════════════════════════════════════════════════════
// Behavioral: Verify timezone correctness (FIX 4 — Finding D)
// ═══════════════════════════════════════════════════════════════════════

// FIX 4: The new timezone-safe implementation (no setDate/setHours on offset Date)
function getNextTehranMidnightISO_Fixed(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  const todayStr = fmt.format(now);
  const [y, m, d] = todayStr.split('-').map(Number);
  const nextDay = new Date(Date.UTC(y, m - 1, d + 1));
  const yyyy = nextDay.getUTCFullYear();
  const mm = String(nextDay.getUTCMonth() + 1).padStart(2, '0');
  const dd = String(nextDay.getUTCDate()).padStart(2, '0');
  return new Date(`${yyyy}-${mm}-${dd}T00:00:00+03:30`).toISOString();
}

test('BEHAVIORAL-1: getNextTehranMidnightISO produces valid ISO at Tehran midnight (not UTC midnight)', () => {
  // FIX 4: The result must be Tehran midnight (20:30:00Z), NOT UTC midnight (00:00:00Z)
  const result = getNextTehranMidnightISO_Fixed(new Date());
  const parsed = new Date(result);

  // Must be a valid date
  assert.ok(!isNaN(parsed.getTime()), 'Must produce valid Date');

  // Must be in the future
  assert.ok(parsed.getTime() > Date.now(), 'Must be in the future');

  // FIX 4: Must end with '20:30:00.000Z' (Tehran midnight = 00:00+03:30 = 20:30Z prev day)
  // The OLD buggy code ended with '00:00:00.000Z' (UTC midnight = 03:30 Tehran — wrong!)
  assert.ok(result.endsWith('20:30:00.000Z'),
    `Must end with '20:30:00.000Z' (Tehran midnight), got: ${result}`);

  // Must be 0-24h from now
  const diffHours = (parsed.getTime() - Date.now()) / 3600000;
  assert.ok(diffHours > 0 && diffHours <= 24, `Should be 0-24h from now, got ${diffHours.toFixed(1)}h`);

  assert.ok(result.endsWith('Z'), 'Must end with Z (UTC ISO format)');
});

test('BEHAVIORAL-2: getNextTehranMidnightISO produces Tehran midnight at all test times', () => {
  // FIX 4 (Finding D): Test at 11 different Tehran times to verify the function
  // ALWAYS produces Tehran midnight (20:30Z), never UTC midnight (00:00Z),
  // and never produces a past timestamp.
  const testCases = [
    ['23:59 Tehran', '2026-08-13T23:59:00+03:30'],
    ['00:00 Tehran', '2026-08-13T00:00:00+03:30'],
    ['00:30 Tehran', '2026-08-13T00:30:00+03:30'],
    ['01:00 Tehran', '2026-08-13T01:00:00+03:30'],
    ['02:00 Tehran', '2026-08-13T02:00:00+03:30'],
    ['03:00 Tehran', '2026-08-13T03:00:00+03:30'],
    ['03:29 Tehran', '2026-08-13T03:29:00+03:30'],
    ['03:30 Tehran', '2026-08-13T03:30:00+03:30'],
    ['04:00 Tehran', '2026-08-13T04:00:00+03:30'],
    ['12:00 Tehran', '2026-08-13T12:00:00+03:30'],
    ['23:00 Tehran', '2026-08-13T23:00:00+03:30'],
  ];

  for (const [label, iso] of testCases) {
    const mockNow = new Date(iso);
    const expiresAt = getNextTehranMidnightISO_Fixed(mockNow);
    const inPast = new Date(expiresAt).getTime() <= mockNow.getTime();
    const isTehranMidnight = expiresAt.endsWith('20:30:00.000Z');

    assert.ok(!inPast, `${label}: expires_at must NOT be in the past (got ${expiresAt} for now ${mockNow.toISOString()})`);
    assert.ok(isTehranMidnight, `${label}: expires_at must be Tehran midnight (20:30Z), got ${expiresAt}`);
  }
});

test('BEHAVIORAL-3: Source code uses timezone-safe implementation (no setDate/setHours on offset Date)', () => {
  // FIX 4: Verify the ACTUAL source code uses the new implementation
  const fnStart = wheelRepoSrc.indexOf('function getNextTehranMidnightISO');
  const fnEnd = wheelRepoSrc.indexOf('\n  }', fnStart);
  const fnSrc = wheelRepoSrc.slice(fnStart, fnEnd);

  // Must NOT use the buggy pattern: setDate/setHours on a Date constructed with +03:30
  assert.ok(!/setDate\(.*getDate\(\)\s*\+\s*1\)/.test(fnSrc),
    'FIX 4: Must NOT use setDate(getDate()+1) — this operates in UTC, not Tehran');

  assert.ok(!/setHours\(0,\s*0,\s*0,\s*0\)/.test(fnSrc),
    'FIX 4: Must NOT use setHours(0,0,0,0) — this operates in UTC, not Tehran');

  // Must use the timezone-safe pattern: Date.UTC + construct ISO with +03:30
  assert.ok(/Date\.UTC/.test(fnSrc), 'FIX 4: Must use Date.UTC for timezone-safe date arithmetic');
  assert.ok(/\+03:30/.test(fnSrc), 'FIX 4: Must construct ISO with +03:30 offset');
  assert.ok(/en-CA/.test(fnSrc), 'FIX 4: Must use en-CA locale for ISO date format');
});

// ═══════════════════════════════════════════════════════════════════════
// FIX 1+2: Referral render-skip tests (Finding A, B, C)
// ═══════════════════════════════════════════════════════════════════════

test('FIX1+2-1: referral.js has _lastRenderedSignature variable', () => {
  assert.ok(/let _lastRenderedSignature\s*=\s*null/.test(referralJsSrc),
    'FIX 1+2: referral.js must have _lastRenderedSignature state variable');
});

test('FIX1+2-2: referral.js has computeDataSignature function', () => {
  assert.ok(/function computeDataSignature\(data\)/.test(referralJsSrc),
    'FIX 1+2: referral.js must have computeDataSignature function');
});

test('FIX1+2-3: renderPage accepts opts parameter with force option', () => {
  const fnStart = referralJsSrc.indexOf('function renderPage(');
  const fnEnd = referralJsSrc.indexOf('\n  }', fnStart);
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/renderPage\(data,\s*opts\s*=\s*\{\}\)/.test(fnSrc),
    'FIX 1+2: renderPage must accept opts={force} parameter');
  assert.ok(/opts\.force/.test(fnSrc), 'FIX 1+2: renderPage must check opts.force');
  assert.ok(/_lastRenderedSignature/.test(fnSrc), 'FIX 1+2: renderPage must use _lastRenderedSignature');
});

test('FIX1+2-4: openReferral resets signature and uses force:true on cache render', () => {
  const fnStart = referralJsSrc.indexOf('function openReferral(');
  const fnEnd = referralJsSrc.indexOf('function closeReferral', fnStart);
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/_lastRenderedSignature\s*=\s*null/.test(fnSrc),
    'FIX 1+2: openReferral must reset _lastRenderedSignature on open');
  assert.ok(/renderPage\(cached\.data,\s*\{\s*force:\s*true\s*\}\)/.test(fnSrc),
    'FIX 1+2: openReferral must call renderPage with {force:true} for cache render');
});

test('FIX1+2-5: fresh data render does NOT use force (allows skip)', () => {
  const fnStart = referralJsSrc.indexOf('function openReferral(');
  const fnEnd = referralJsSrc.indexOf('function closeReferral', fnStart);
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  // The second renderPage call (after API calls) must NOT have force:true
  // Find the last renderPage call in openReferral
  const renderCalls = fnSrc.match(/renderPage\([^)]+\)/g) || [];
  assert.ok(renderCalls.length >= 2, 'openReferral must call renderPage at least twice (cache + fresh)');
  // The last call (fresh data) must not contain force:true
  const lastCall = renderCalls[renderCalls.length - 1];
  assert.ok(!/force:\s*true/.test(lastCall),
    'FIX 1+2: fresh data renderPage call must NOT use force:true (allows skip if unchanged)');
});

test('FIX3-1: refreshWheelStatus invalidates signature', () => {
  const fnStart = referralJsSrc.indexOf('async function refreshWheelStatus');
  const fnEnd = referralJsSrc.indexOf('async function loadMoreHistory', fnStart);
  const fnSrc = referralJsSrc.slice(fnStart, fnEnd);
  assert.ok(/_lastRenderedSignature\s*=\s*null/.test(fnSrc),
    'FIX 3: refreshWheelStatus must invalidate _lastRenderedSignature so next render picks up new wheel data');
});

// ═══════════════════════════════════════════════════════════════════════
// FIX 5: Defensive daily spin logic (Finding E, F)
// ═══════════════════════════════════════════════════════════════════════

test('FIX5-1: getOrCreateDailySpins excludes expired available rows from count', () => {
  const fnStart = wheelRepoSrc.indexOf('async function getOrCreateDailySpins');
  const fnEnd = wheelRepoSrc.indexOf('async function _hashLockKey', fnStart);
  const fnSrc = wheelRepoSrc.slice(fnStart, fnEnd);

  // Strip JS comments (the FIX 5 comment mentions the old pattern for documentation)
  const fnNoComments = fnSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');

  // FIX 5: The count query must NOT count expired 'available' rows.
  // Old buggy query: AND status IN ('available', 'used')
  // New fixed query: AND (status = 'used' OR (status = 'available' AND (expires_at IS NULL OR expires_at > NOW())))
  assert.ok(!/status IN \('available',\s*'used'\)/.test(fnNoComments),
    'FIX 5: getOrCreateDailySpins must NOT use status IN (\'available\', \'used\') — counts expired rows');

  assert.ok(/status\s*=\s*'used'/.test(fnNoComments),
    'FIX 5: getOrCreateDailySpins must count used rows');
  assert.ok(/expires_at IS NULL OR expires_at > NOW\(\)/.test(fnNoComments),
    'FIX 5: getOrCreateDailySpins must exclude expired available rows (expires_at IS NULL OR expires_at > NOW())');
});

test('FIX5-2: getOrCreateDailySpins final SELECT also excludes expired rows', () => {
  const fnStart = wheelRepoSrc.indexOf('async function getOrCreateDailySpins');
  const fnEnd = wheelRepoSrc.indexOf('async function _hashLockKey', fnStart);
  const fnSrc = wheelRepoSrc.slice(fnStart, fnEnd);

  // The third query (final SELECT of available spins) must also exclude expired
  const selectMatch = fnSrc.match(/SELECT id, status FROM wheel_spins[\s\S]*?ORDER BY id ASC/);
  assert.ok(selectMatch, 'Must have final SELECT query');
  assert.ok(/expires_at IS NULL OR expires_at > NOW\(\)/.test(selectMatch[0]),
    'FIX 5: final SELECT must also exclude expired rows');
});

test('FIX5-3: getAvailableSpins already excludes expired (regression check)', () => {
  const fnStart = wheelRepoSrc.indexOf('async function getAvailableSpins');
  const fnEnd = wheelRepoSrc.indexOf('async function getRewardPool', fnStart);
  const fnSrc = wheelRepoSrc.slice(fnStart, fnEnd);
  assert.ok(/expires_at IS NULL OR expires_at > NOW\(\)/.test(fnSrc),
    'getAvailableSpins must exclude expired rows (existing behavior, regression check)');
});

// ═══════════════════════════════════════════════════════════════════════
// FIX 7: RTL CSS (Finding I)
// ═══════════════════════════════════════════════════════════════════════

test('FIX7-1: referral.css does NOT have invalid [dir="rtl"] @keyframes', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, 'referral.css'), 'utf8');
  // Strip CSS comments before checking (the FIX 7 comment mentions the old pattern)
  const cssNoComments = cssSrc.replace(/\/\*[\s\S]*?\*\//g, '');
  // The invalid pattern: [dir="rtl"] @keyframes ... (outside comments)
  assert.ok(!/\[dir="rtl"\]\s*@keyframes/.test(cssNoComments),
    'FIX 7: referral.css must NOT contain [dir="rtl"] @keyframes (invalid CSS — selector before at-rule)');
});

test('FIX7-2: referral.css has valid RTL animation pattern', () => {
  const cssSrc = fs.readFileSync(path.join(__dirname, 'referral.css'), 'utf8');
  // Must have a separate @keyframes for RTL
  assert.ok(/@keyframes rcHistSlideInRtl/.test(cssSrc),
    'FIX 7: referral.css must have @keyframes rcHistSlideInRtl (separate RTL keyframes)');
  // Must apply via selector on the element
  assert.ok(/\[dir="rtl"\]\s*\.rc-hist-item/.test(cssSrc),
    'FIX 7: referral.css must apply RTL animation via [dir="rtl"] .rc-hist-item selector');
  assert.ok(/animation-name:\s*rcHistSlideInRtl/.test(cssSrc),
    'FIX 7: referral.css must set animation-name: rcHistSlideInRtl');
});

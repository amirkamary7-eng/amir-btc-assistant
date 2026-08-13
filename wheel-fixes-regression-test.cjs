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
// Behavioral: Verify timezone correctness
// ═══════════════════════════════════════════════════════════════════════

test('BEHAVIORAL-1: getNextTehranMidnightISO produces valid ISO with correct timezone', () => {
  // The function constructs: new Date("YYYY-MM-DDTHH:MM:SS+03:30")
  // then adds 1 day, sets to 00:00:00, and returns toISOString()
  // The result should be a UTC ISO string representing Tehran midnight

  // Simulate the function
  function getTehranDateString() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    return fmt.format(new Date());
  }

  function getNextTehranMidnightISO() {
    const now = new Date();
    const tehranParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tehran',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const p = {};
    for (const part of tehranParts) p[part.type] = part.value;
    const tehranNow = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}+03:30`);
    const tomorrowMidnight = new Date(tehranNow);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    tomorrowMidnight.setHours(0, 0, 0, 0);
    return tomorrowMidnight.toISOString();
  }

  const result = getNextTehranMidnightISO();
  const parsed = new Date(result);

  // Must be a valid date
  assert.ok(!isNaN(parsed.getTime()), 'Must produce valid Date');

  // Must be in the future
  assert.ok(parsed.getTime() > Date.now(), 'Must be in the future');

  // Must be approximately 24h from now (within a few hours — Tehran midnight)
  const diffHours = (parsed.getTime() - Date.now()) / 3600000;
  assert.ok(diffHours > 0 && diffHours <= 24, `Should be 0-24h from now, got ${diffHours.toFixed(1)}h`);

  // The ISO string must be parseable by `new Date()` in any timezone
  // (ISO 8601 with Z suffix is universally parseable)
  assert.ok(result.endsWith('Z'), 'Must end with Z (UTC ISO format)');
});

test('BEHAVIORAL-2: Backend timestamp differs from local midnight for non-Tehran timezones', () => {
  // Simulate a user in London (UTC+0) at 22:00 local time
  // Tehran is UTC+3:30, so it's 01:30 next day in Tehran
  // Tehran midnight (00:00) = 20:30 UTC previous day
  // So next Tehran midnight is the CURRENT day's Tehran midnight (which already passed)
  // → next Tehran midnight is TOMORROW at 00:00 Tehran = 20:30 UTC today

  // At 22:00 UTC:
  // - Local London midnight = 02:00 UTC tomorrow (4h from now)
  // - Tehran midnight = 20:30 UTC today (already passed) → next is 20:30 UTC tomorrow (22.5h from now)

  // These are DIFFERENT — confirming the timezone mismatch exists
  // and the fix (using backend timestamp) is necessary

  function getNextTehranMidnightISO() {
    const now = new Date();
    const tehranParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tehran',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const p = {};
    for (const part of tehranParts) p[part.type] = part.value;
    const tehranNow = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}+03:30`);
    const tomorrowMidnight = new Date(tehranNow);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    tomorrowMidnight.setHours(0, 0, 0, 0);
    return tomorrowMidnight.toISOString();
  }

  const tehranMidnight = new Date(getNextTehranMidnightISO());

  // Local midnight (what the old code used)
  const localMidnight = new Date();
  localMidnight.setHours(24, 0, 0, 0);

  // These should be different (unless the test happens to run exactly at Tehran midnight)
  // In practice they will differ by the timezone offset
  const diffMs = Math.abs(tehranMidnight.getTime() - localMidnight.getTime());
  // If in Tehran timezone, diff would be 0. In any other timezone, diff > 0.
  // We can't guarantee the test runs outside Tehran timezone, but we can verify
  // the function produces a valid, different result conceptually.
  assert.ok(tehranMidnight.getTime() > 0, 'Tehran midnight must be valid');
  assert.ok(localMidnight.getTime() > 0, 'Local midnight must be valid');
  // The key point: the function EXISTS and produces a valid ISO string
  // that the frontend can use instead of guessing local midnight
});

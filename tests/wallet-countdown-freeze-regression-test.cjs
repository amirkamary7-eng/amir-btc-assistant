/**
 * Wallet Weekly Countdown Freeze Regression Test (F1)
 *
 * ROOT CAUSE (production RCA — Batch A):
 *   _startWeeklyCountdown() (wallet.js) had an inner update() function that,
 *   when `diff <= 0`, recursively called _startWeeklyCountdown() — which
 *   cleared the timer and called update() SYNCHRONOUSLY again. At Saturday
 *   00:00:00–00:00:59 Tehran (browser tz = Tehran):
 *     weekday='Sat' → daysToSaturday=0
 *     tehranHour=0, tehranMinute=0 → the +7-day branch is NOT taken
 *     target = today 00:00 local == now → diff <= 0
 *     → _startWeeklyCountdown() → update() (sync) → same conditions →
 *       INFINITE SYNCHRONOUS RECURSION → stack overflow → tab freeze
 *       for the full 60-second window (until tehranMinute=1 at 00:01:00).
 *
 * FIX (F1): replace the recursive call with a BOUNDED advance —
 *   if (diff <= 0) { target.setDate(target.getDate() + 7); recompute diff; }
 *   if (diff <= 0) { el.textContent = ''; return; }  // defensive, no recursion
 * The weekly calculation logic (weekdayMap, daysToSaturday, +7 branch) is
 * UNCHANGED. No new timer, no synchronous recursion.
 *
 * This test verifies:
 *   F1-01: update() does NOT recursively call _startWeeklyCountdown()
 *   F1-02: diff<=0 branch uses bounded advance (setDate +7), not recursion
 *   F1-03: defensive second diff<=0 check hides element without recursion
 *   F1-04: weekly calculation logic unchanged
 *   F1-05..08: Saturday 00:00:00 / :30 / :59 / 00:01:00 Tehran boundary cases
 *   F1-09: normal weekday (Wednesday) — countdown to upcoming Saturday
 *   F1-10: no synchronous recursion — update() terminates
 *
 * Run: node --test tests/wallet-countdown-freeze-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WALLET_SRC = fs.readFileSync(path.join(__dirname, '..', 'wallet.js'), 'utf8');

// ── Extract _startWeeklyCountdown function body (paren-match params, then brace-match) ──────────
function extractFn(src, name) {
  const sigRe = new RegExp('function\\s+' + name + '\\s*\\(');
  const sigMatch = sigRe.exec(src);
  assert.ok(sigMatch, name + ' must exist in wallet.js');
  const start = sigMatch.index;
  let i = src.indexOf('(', start);
  assert.ok(i > -1, name + ' must have param list');
  let pd = 1; i++;
  while (pd > 0 && i < src.length) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    i++;
  }
  i = src.indexOf('{', i);
  assert.ok(i > -1, name + ' must have a body');
  let bd = 1; i++;
  while (bd > 0 && i < src.length) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') bd--;
    i++;
  }
  return src.slice(start, i);
}

const COUNTDOWN_FN = extractFn(WALLET_SRC, '_startWeeklyCountdown');

// Extract just the inner update() function body
function extractUpdateBody() {
  const us = COUNTDOWN_FN.indexOf('function update()');
  assert.ok(us > -1, 'update() inner function must exist');
  let i = COUNTDOWN_FN.indexOf('{', us);
  let depth = 1;
  i++;
  while (depth > 0 && i < COUNTDOWN_FN.length) {
    if (COUNTDOWN_FN[i] === '{') depth++;
    else if (COUNTDOWN_FN[i] === '}') depth--;
    i++;
  }
  return COUNTDOWN_FN.slice(us, i);
}
const UPDATE_BODY = extractUpdateBody();

// Strip JS comments so source-level assertions don't match comment text
// (e.g. the F1 FIX comment mentions _startWeeklyCountdown() for context).
function stripComments(src) {
  return src
    .replace(/\/\*[\s\S]*?\*\//g, '')   // block comments
    .replace(/\/\/[^\n]*/g, '');        // line comments
}
const UPDATE_NO_COMMENTS = stripComments(UPDATE_BODY);

// ============================================================================
// Source-level: recursion removed, bounded advance in place
// ============================================================================

test('F1-01: update() does NOT recursively call _startWeeklyCountdown()', () => {
  // The old code had `_startWeeklyCountdown(); // Recalculate` inside update()
  // when diff <= 0. This caused infinite synchronous recursion at the Sat
  // 00:00 Tehran boundary. Assert: NO call to _startWeeklyCountdown() inside
  // the update() function body.
  // Comments stripped so the F1 FIX context comment (which mentions the
  // old recursive call for documentation) doesn't trigger a false positive.
  assert.ok(!/_startWeeklyCountdown\s*\(\s*\)/.test(UPDATE_NO_COMMENTS),
    'update() must NOT recursively call _startWeeklyCountdown() — caused stack overflow / tab freeze at Sat 00:00 Tehran');
  assert.ok(!/_startWeeklyCountdown\s*\(\s*\)\s*;/.test(UPDATE_NO_COMMENTS),
    'update() must NOT contain any recursive _startWeeklyCountdown() call statement');
});

test('F1-02: diff <= 0 branch uses bounded advance (target.setDate +7), not recursion', () => {
  // The fix replaces recursion with a bounded advance. Verify the advance
  // exists inside update() and is associated with the diff <= 0 branch.
  assert.match(UPDATE_BODY, /target\.setDate\(\s*target\.getDate\(\)\s*\+\s*7\s*\)/,
    'update() must advance target by 7 days (bounded) when diff <= 0');
  // Confirm the first diff <= 0 check is followed (within a small window) by
  // the bounded advance, not by a recursive call.
  const diffIdx = UPDATE_BODY.search(/if\s*\(\s*diff\s*<=\s*0\s*\)/);
  assert.ok(diffIdx > -1, 'first diff <= 0 check must exist');
  const afterCheck = UPDATE_BODY.slice(diffIdx, diffIdx + 200);
  assert.match(afterCheck, /target\.setDate\(\s*target\.getDate\(\)\s*\+\s*7\s*\)/,
    'first diff <= 0 branch must advance target by 7 days (bounded)');
  assert.ok(!/_startWeeklyCountdown/.test(afterCheck),
    'first diff <= 0 branch must NOT call _startWeeklyCountdown (no recursion)');
});

test('F1-03: defensive second diff <= 0 check hides element without recursion', () => {
  // After the bounded advance, there must be a second diff <= 0 guard that
  // sets el.textContent = '' and returns (defensive against clock skew).
  // This is the no-recursion exit path.
  const matches = [...UPDATE_BODY.matchAll(/if\s*\(\s*diff\s*<=\s*0\s*\)/g)];
  assert.ok(matches.length >= 2,
    'there must be at least 2 diff <= 0 checks (bounded advance + defensive exit)');
  // The second check must hide the element and return (no recursion)
  const secondIdx = matches[1].index;
  const afterSecond = UPDATE_BODY.slice(secondIdx, secondIdx + 120);
  assert.match(afterSecond, /el\.textContent\s*=\s*''/,
    'defensive diff <= 0 branch must set el.textContent = ""');
  assert.match(afterSecond, /return/,
    'defensive diff <= 0 branch must return');
  assert.ok(!/_startWeeklyCountdown/.test(afterSecond),
    'defensive branch must NOT call _startWeeklyCountdown');
});

test('F1-04: weekly calculation logic unchanged (weekdayMap, daysToSaturday, +7 branch)', () => {
  // The fix must NOT change the target calculation logic.
  assert.match(COUNTDOWN_FN, /weekdayMap\s*=\s*\{\s*'Sat':\s*0/,
    'weekdayMap must start with Sat:0 (unchanged)');
  assert.match(COUNTDOWN_FN, /daysToSaturday\s*=\s*\(\s*7\s*-\s*\(\s*weekdayMap/,
    'daysToSaturday calculation must be unchanged');
  assert.match(COUNTDOWN_FN, /if\s*\(\s*tehranHour\s*>\s*0\s*\|\|\s*tehranMinute\s*>\s*0\s*\)\s*\{[^}]*target\.setDate/,
    '+7 branch for past-midnight Saturday must be unchanged');
});

// ============================================================================
// Behavioral: boundary cases produce valid countdown (no recursion)
// ============================================================================
//
// Faithful re-implementation of the update() target-calculation + diff logic
// (mirrors wallet.js _startWeeklyCountdown update() — including the F1 fix).
// Tests the REAL Intl.DateTimeFormat at the Saturday 00:00 Tehran boundary.

function computeDiff(now) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', weekday: 'short',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', hour12: false,
  });
  const parts = fmt.formatToParts(now);
  const weekday = parts.find(p => p.type === 'weekday')?.value || 'Sat';
  const weekdayMap = { 'Sat': 0, 'Sun': 1, 'Mon': 2, 'Tue': 3, 'Wed': 4, 'Thu': 5, 'Fri': 6 };
  const daysToSaturday = (7 - (weekdayMap[weekday] ?? 0)) % 7;
  const target = new Date(now);
  target.setDate(target.getDate() + daysToSaturday);
  target.setHours(0, 0, 0, 0);
  if (daysToSaturday === 0) {
    const tehranHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
    const tehranMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
    if (tehranHour > 0 || tehranMinute > 0) {
      target.setDate(target.getDate() + 7);
    }
  }
  let diff = target.getTime() - now.getTime();
  // F1 fix: bounded advance instead of recursion
  if (diff <= 0) {
    target.setDate(target.getDate() + 7);
    diff = target.getTime() - now.getTime();
  }
  return {
    diff,
    weekday,
    tehranHour: parts.find(p => p.type === 'hour')?.value,
    tehranMinute: parts.find(p => p.type === 'minute')?.value,
    daysToSaturday,
  };
}

// Saturday 00:00:00 Tehran = Friday 20:30:00 UTC (Tehran is UTC+03:30)
const SAT_00_00_00 = '2025-01-03T20:30:00.000Z';
const SAT_00_00_30 = '2025-01-03T20:30:30.000Z';
const SAT_00_00_59 = '2025-01-03T20:30:59.000Z';
const SAT_00_01_00 = '2025-01-03T20:31:00.000Z';
const WED_NOON = '2025-01-01T12:00:00.000Z'; // Wed 15:30 Tehran

test('F1-05: Saturday 00:00:00 Tehran — bounded advance, diff > 0 (no recursion)', () => {
  const now = new Date(SAT_00_00_00);
  const r = computeDiff(now);
  assert.equal(r.weekday, 'Sat', 'precondition: Tehran weekday is Saturday');
  assert.equal(r.tehranHour, '00', 'precondition: tehranHour=00');
  assert.equal(r.tehranMinute, '00', 'precondition: tehranMinute=00');
  assert.equal(r.daysToSaturday, 0, 'precondition: daysToSaturday=0 (today is Saturday)');
  // OLD CODE: diff would be <= 0 → infinite recursion → freeze.
  // NEW CODE: bounded advance → diff > 0.
  assert.ok(r.diff > 0, 'diff must be > 0 after bounded advance (was <= 0 before fix → recursion → freeze)');
  assert.ok(r.diff > 6 * 86400000, 'diff should be ~7 days (next Saturday 00:00 Tehran)');
  assert.ok(r.diff <= 7 * 86400000, 'diff should not exceed 7 days');
});

test('F1-06: Saturday 00:00:30 Tehran — bounded advance, diff > 0', () => {
  const now = new Date(SAT_00_00_30);
  const r = computeDiff(now);
  assert.equal(r.weekday, 'Sat');
  assert.equal(r.tehranHour, '00');
  assert.equal(r.tehranMinute, '00');
  assert.equal(r.daysToSaturday, 0);
  assert.ok(r.diff > 0, 'diff must be > 0 after bounded advance');
  assert.ok(r.diff > 6 * 86400000, 'diff should be ~7 days minus 30s');
  assert.ok(r.diff < 7 * 86400000, 'diff should be < 7d (30s into the window)');
});

test('F1-07: Saturday 00:00:59 Tehran — bounded advance, diff > 0 (last second of freeze window)', () => {
  const now = new Date(SAT_00_00_59);
  const r = computeDiff(now);
  assert.equal(r.weekday, 'Sat');
  assert.equal(r.tehranHour, '00');
  assert.equal(r.tehranMinute, '00');
  assert.equal(r.daysToSaturday, 0);
  assert.ok(r.diff > 0, 'diff must be > 0 after bounded advance');
  assert.ok(r.diff > 6 * 86400000, 'diff should be ~7 days minus 59s');
});

test('F1-08: Saturday 00:01:00 Tehran — +7 branch taken (existing logic), diff > 0', () => {
  // At 00:01:00, tehranMinute=1 → the +7-day branch IS taken (existing logic).
  // The F1 fix's bounded advance is NOT needed here. This verifies the fix
  // doesn't break the normal past-midnight path.
  const now = new Date(SAT_00_01_00);
  const r = computeDiff(now);
  assert.equal(r.weekday, 'Sat');
  assert.equal(r.tehranHour, '00');
  assert.equal(r.tehranMinute, '01');
  assert.equal(r.daysToSaturday, 0);
  assert.ok(r.diff > 0, 'diff must be > 0 (+7 branch taken)');
  assert.ok(r.diff > 6 * 86400000, 'diff should be ~7 days minus 1min');
});

test('F1-09: normal weekday (Wednesday) — countdown to upcoming Saturday, diff > 0', () => {
  const now = new Date(WED_NOON);
  const r = computeDiff(now);
  assert.equal(r.weekday, 'Wed', 'precondition: Tehran weekday is Wednesday');
  assert.ok(r.daysToSaturday > 0 && r.daysToSaturday < 7, 'daysToSaturday for Wednesday should be 1-6');
  assert.ok(r.diff > 0, 'diff must be > 0 (upcoming Saturday)');
  assert.ok(r.diff < 4 * 86400000, 'Wednesday afternoon → Saturday is < 4 days');
});

test('F1-10: no synchronous recursion — computeDiff terminates at boundary', () => {
  // Simulate calling update() at the Saturday 00:00 boundary. The old code
  // would recurse infinitely (update → _startWeeklyCountdown → update → ...).
  // The fix makes update() return after the bounded advance. We verify by
  // calling computeDiff at the boundary — it returns (doesn't hang).
  const now = new Date(SAT_00_00_00);
  const start = Date.now();
  const r = computeDiff(now);
  const elapsed = Date.now() - start;
  assert.ok(elapsed < 1000, 'computeDiff must terminate in < 1s (no infinite recursion)');
  assert.ok(r.diff > 0, 'diff must be > 0 (bounded advance worked)');
});

// ============================================================================
// Integration: setInterval called exactly once (no timer thrashing)
// ============================================================================

test('F1-11: _startWeeklyCountdown calls setInterval exactly once (no recursive timer setup)', () => {
  // Source-level: verify the function body calls setInterval exactly once
  // (not inside update(), which would thrash on recursion).
  const setIntervalCalls = (COUNTDOWN_FN.match(/setInterval\(/g) || []).length;
  assert.equal(setIntervalCalls, 1, '_startWeeklyCountdown must call setInterval exactly once (timer setup at function level, not inside update)');
  // update() itself must NOT call setInterval (the single setInterval call
  // must be at the function level, after update()'s closing brace).
  assert.ok(!/setInterval/.test(UPDATE_BODY),
    'update() must NOT call setInterval (would thrash on recursion)');
  // The single setInterval(update) call must be OUTSIDE update() — find it
  // in COUNTDOWN_FN and verify it comes after the end of update()'s body.
  const updateEndIdx = COUNTDOWN_FN.indexOf(UPDATE_BODY) + UPDATE_BODY.length;
  const setIntervalIdx = COUNTDOWN_FN.indexOf('setInterval(update');
  assert.ok(setIntervalIdx > -1, 'must find setInterval(update) call');
  assert.ok(setIntervalIdx >= updateEndIdx,
    'setInterval(update) must be outside/after update() — no recursive timer setup inside update()');
});

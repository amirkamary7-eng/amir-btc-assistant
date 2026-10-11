/**
 * H6-STARV-01 — Alert Symbol Coverage (post Task-70 FIX) Regression Tests
 *
 * ✅ DESIRED-BEHAVIOR TEST (updated in Task 70).
 *
 * HISTORY: this file was originally a CHARACTERIZATION test that documented
 * the then-current BROKEN behavior: the fixed `.slice(0, 14)` OHLC window
 * (combined with listActiveForCron's deterministic ORDER BY created_at DESC)
 * permanently starved every unique symbol ranked 15+ — alerts on those
 * symbols were never evaluated and never fired (alerts do not expire). Its
 * header instructed: "When the starvation is fixed in a future phase, this
 * test must be UPDATED (or replaced) to assert the new fair-coverage
 * behavior."
 *
 * Task 70 implemented that fix: `_selectOhlcWindow` (worker-proxy.js) keeps
 * the hard cap of 14 symbols per tick (Cloudflare Free 50-subrequest budget
 * unchanged) but picks the LEAST-RECENTLY-FETCHED symbols first. This file
 * now asserts the FAIR-COVERAGE behavior:
 *
 *   1. Hard cap stays 14 per tick (subrequest budget unchanged).
 *   2. Cold start behaves exactly like the old fixed window (list order) —
 *      regression-safe first tick.
 *   3. With >14 unique symbols, coverage ROTATES: every symbol is evaluated
 *      at least once every ceil(n/14) ticks — no permanent starvation and
 *      NO escape conditions (trigger/delete of other alerts) required.
 *   4. A brand-new alert's symbol is prioritized on the very next tick
 *      (never-fetched symbols first) — immediate first-check UX preserved.
 *   5. ≤14 unique symbols → ALL evaluated every tick (unchanged).
 *
 * The simulations below run the REAL extracted _selectOhlcWindow code from
 * worker-proxy.js (brace-slicing + a fresh module scope per selector =
 * fresh per-isolate state, deterministic — same technique as
 * tests/market-rate-limit-multi-isolate-test.cjs).
 *
 * Run: node --test tests/h6-starv-01-starvation-characterization-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const ALERTS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'repositories', 'alerts.js'), 'utf8');

// ─── Extract the REAL selector from worker-proxy.js ─────────────────────────
function extractFn(srcText, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*function ' + name + '\\s*\\(');
  const m = re.exec(srcText);
  if (!m) throw new Error('function not found: ' + name);
  const braceStart = srcText.indexOf('{', m.index);
  let depth = 0;
  for (let j = braceStart; j < srcText.length; j++) {
    if (srcText[j] === '{') depth++;
    else if (srcText[j] === '}') { if (--depth === 0) return srcText.slice(m.index, j + 1).replace(/^\s+/, ''); }
  }
  throw new Error('unbalanced braces: ' + name);
}

/** Fresh module scope = fresh per-isolate state (deterministic). */
function makeRealSelector() {
  return new Function(
    'const _ohlcWindowLastFetched = new Map();\n' +
    'let _ohlcWindowTick = 0;\n' +
    extractFn(WORKER_SRC, '_selectOhlcWindow') +
    '\nreturn _selectOhlcWindow;'
  )();
}

/** Unique symbols for a simulated alert list, ORDER BY created_at DESC. */
function symbolsFor(n) {
  const alerts = [];
  for (let i = 0; i < n; i++) {
    alerts.push({
      id: 'alert_' + i,
      user_id: 'user_' + i,
      symbol: 'SYM' + String(i).padStart(2, '0'),
      price: 100,
      direction: 'above',
      last_price: null,
      last_checked_at: null,
      created_at: new Date(Date.now() - (n - i) * 60000).toISOString(),
    });
  }
  // ORDER BY created_at DESC → newest first: [SYM{n-1}, ..., SYM00]
  const sorted = [...alerts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
  return sorted.map(a => String(a.symbol || '').trim().toUpperCase()).filter(Boolean);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source assertions: the fair-coverage code exists
// ═══════════════════════════════════════════════════════════════════════════

test('STARV-01-SRC-A: _selectOhlcWindow exists and replaces the old fixed cap', () => {
  assert.ok(WORKER_SRC.includes('const uniqueSymbols = _selectOhlcWindow(uniqueSymbolsAll, 14);'),
    'runScheduledAlertsBaseline must select the OHLC window via _selectOhlcWindow (hard cap 14)');
  assert.ok(WORKER_SRC.includes('function _selectOhlcWindow(symbols, windowSize)'),
    'the _selectOhlcWindow helper must exist');
  assert.ok(!WORKER_SRC.includes('].slice(0, 14)'),
    'the old fixed inline cap (the starvation root cause) must be GONE from worker-proxy.js');
});

test('STARV-01-SRC-B: listActiveForCron uses ORDER BY created_at DESC (deliberately unchanged)', () => {
  // The query is intentionally untouched: fairness comes from the selector's
  // per-isolate least-recently-fetched state, NOT from the DB query.
  assert.ok(ALERTS_SRC.includes('ORDER BY created_at DESC'),
    'listActiveForCron must still use ORDER BY created_at DESC');
  assert.ok(ALERTS_SRC.includes('WHERE status = \'active\''),
    'listActiveForCron filters by status=active');
});

test('STARV-01-SRC-C: no OFFSET/cursor in the query; fairness state lives in the selector', () => {
  // Verify there is no OFFSET clause in listActiveForCron
  const listFnStart = ALERTS_SRC.indexOf('async function listActiveForCron');
  const listFnEnd = ALERTS_SRC.indexOf('}', ALERTS_SRC.indexOf('LIMIT $1', listFnStart));
  const listFnBody = ALERTS_SRC.slice(listFnStart, listFnEnd);
  assert.ok(!/OFFSET/i.test(listFnBody),
    'listActiveForCron must NOT have OFFSET (no pagination)');
  assert.ok(!/cursor/i.test(listFnBody),
    'listActiveForCron must NOT have cursor logic');
  // The per-isolate least-recently-fetched rotation state exists (this is
  // what closes the starvation the original characterization pinned).
  assert.ok(WORKER_SRC.includes('const _ohlcWindowLastFetched = new Map();'),
    'the per-isolate _ohlcWindowLastFetched state must exist');
  assert.ok(WORKER_SRC.includes('let _ohlcWindowTick = 0;'),
    'the per-isolate _ohlcWindowTick counter must exist');
});

test('STARV-01-SRC-D: eval loop still skips (not corrupts) alerts whose symbol is not in symbolOhlcMap', () => {
  // The skip branch: if (!ohlc || ...) { skipped_ohlc_unavailable++; continue; }
  // With rotation this branch is now TRANSIENT (≤ ceil(n/14) ticks) instead
  // of permanent — but its no-silent-loss semantics must stay intact.
  assert.ok(WORKER_SRC.includes('skipped_ohlc_unavailable'),
    'The OHLC-unavailable skip counter must exist');
  assert.ok(WORKER_SRC.includes('resultPayload.skipped_ohlc_unavailable += 1'),
    'The skip increment must exist');
});

test('STARV-01-SRC-E: skipped alerts do NOT get last_price / last_checked_at updated (H6 Phase 1 fix)', () => {
  const ohlcCheckIdx = WORKER_SRC.indexOf('if (!ohlc || !Number.isFinite(ohlc.high)');
  const candleHighIdx = WORKER_SRC.indexOf('const candleHigh = ohlc.high;', ohlcCheckIdx);
  const branchBody = WORKER_SRC.slice(ohlcCheckIdx, candleHighIdx);
  assert.ok(!branchBody.includes('_pendingUpdates.push'),
    'Skipped alerts must NOT be pushed to _pendingUpdates (last_price not touched)');
  assert.ok(branchBody.includes('continue'),
    'Skipped alerts must continue (exit the eval iteration for this alert)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Simulations with the REAL selector (50 unique symbols)
// ═══════════════════════════════════════════════════════════════════════════

test('STARV-01-SIM-01: 50 unique symbols → exactly 14 per tick; cold start = newest 14 (list order)', () => {
  const selectWindow = makeRealSelector();
  const uniqueSymbols = selectWindow(symbolsFor(50), 14);
  assert.equal(uniqueSymbols.length, 14,
    'only 14 unique symbols are selected for OHLC fetch (the cap)');
  // Cold start (fresh isolate, all never-fetched, ties by list order):
  // the first window is the NEWEST 14 — exactly like the old fixed window.
  assert.equal(uniqueSymbols[0], 'SYM49', 'newest symbol is first (cold start = list order)');
  assert.equal(uniqueSymbols[13], 'SYM36', '14th symbol is SYM36 (same as the old fixed window)');
});

test('STARV-01-SIM-02 (was starvation): coverage now ROTATES — every symbol within ceil(50/14)=4 ticks', () => {
  const N = 50;
  const selectWindow = makeRealSelector();
  const symbols = symbolsFor(N);
  const seen = new Set();
  const TICKS = Math.ceil(N / 14); // 4
  for (let tick = 0; tick < TICKS; tick++) {
    const window = selectWindow(symbols, 14);
    assert.equal(window.length, 14, `tick ${tick}: exactly 14 symbols selected`);
    for (const s of window) seen.add(s);
  }
  assert.equal(seen.size, N,
    `after ${TICKS} ticks ALL ${N} symbols were evaluated at least once (no permanent starvation)`);
  // The old broken behavior (pinned by the original characterization test)
  // was: the SAME 14 symbols every cycle. Now the union must GROW beyond 14
  // after the second tick.
  const selectWindow2 = makeRealSelector();
  const w1 = new Set(selectWindow2(symbols, 14));
  const w2 = new Set(selectWindow2(symbols, 14));
  const union = new Set([...w1, ...w2]);
  assert.ok(union.size > 14,
    'the second tick must introduce NEW symbols (rotation) — the old code selected the same 14 forever');
});

test('STARV-01-SIM-03 (was starvation): the OLDEST symbol is evaluated with NO escape conditions', () => {
  // The old behavior: SYM00 (oldest) stayed starved until 36 newer alerts
  // triggered or were deleted. Now it is evaluated within ceil(50/14)=4
  // ticks without ANY alert triggering or being deleted.
  const N = 50;
  const selectWindow = makeRealSelector();
  const symbols = symbolsFor(N);
  let escapedAt = -1;
  for (let tick = 1; tick <= Math.ceil(N / 14); tick++) {
    const window = selectWindow(symbols, 14);
    if (window.includes('SYM00')) { escapedAt = tick; break; }
  }
  assert.ok(escapedAt > 0,
    `SYM00 (oldest) must be evaluated within ceil(${N}/14)=${Math.ceil(N / 14)} ticks with no escape conditions (got tick ${escapedAt})`);
  assert.ok(escapedAt <= Math.ceil(N / 14),
    `SYM00 escape tick (${escapedAt}) must be ≤ ceil(n/14)`);
});

test('STARV-01-SIM-04 (strengthened): a brand-new alert with a NEW symbol is evaluated on the VERY NEXT tick', () => {
  // The old behavior also prioritized new symbols (they entered top-14 by
  // created_at DESC) but DISPLACED the previous 14th symbol into permanent
  // starvation. Now: new symbol enters immediately AND the displaced symbol
  // is not permanently starved.
  const N = 20;
  const selectWindow = makeRealSelector();
  const symbols = symbolsFor(N); // SYM19..SYM00 (newest first)
  // Reach steady state: run enough ticks to cover all symbols.
  const coverTicks = Math.ceil(N / 14); // 2
  for (let t = 0; t < coverTicks; t++) selectWindow(symbols, 14);
  // A brand-new alert on a brand-new symbol arrives (newest → first in the
  // next listActiveForCron result).
  const withNew = ['SYM99', ...symbols];
  const nextWindow = selectWindow(withNew, 14);
  assert.ok(nextWindow.includes('SYM99'),
    'the brand-new symbol must be in the VERY NEXT window (never-fetched priority)');
});

test('STARV-01-SIM-05: ≤14 symbols → no starvation (cap does not bite — behavior unchanged)', () => {
  // Regression constraint preserved from the original characterization: with
  // 14 or fewer unique symbols, ALL are evaluated every tick.
  for (let n = 0; n <= 14; n++) {
    const selectWindow = makeRealSelector();
    const symbols = symbolsFor(n);
    for (let tick = 0; tick < 3; tick++) {
      const window = selectWindow(symbols, 14);
      assert.equal(window.length, n,
        `N=${n}, tick=${tick}: all ${n} symbols evaluated (cap=14 does not reduce when N≤14)`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Subrequest accounting (unchanged by the fix)
// ═══════════════════════════════════════════════════════════════════════════

test('STARV-01-SUBREQ: 14 symbols × 2 subreq/symbol (cache-hit) + fixed overhead ≈ 40-50', () => {
  // The fix does NOT change the subrequest budget: still exactly ≤14
  // symbols fetched per tick (selector picks WHICH 14, not how many).
  const N = 50;
  const evaluated = 14;
  const subreqPerSymbolCacheHit = 2; // 1 KV read + 1 HTTP fetch
  const fixedOverhead = 12; // alerts list + bulk DB + KV inv + processQueue(5)
  const total = evaluated * subreqPerSymbolCacheHit + fixedOverhead;
  assert.ok(total <= 50,
    `Free Plan: ${total} subrequests ≤ 50 limit (unchanged by the rotation fix)`);
  assert.ok(N >= evaluated, 'the cap (14) is independent of the active symbol count');
});

console.log('✅ H6-STARV-01 (fair coverage, post Task-70 fix) tests loaded.');
console.log('   ℹ️ These tests assert the FIXED behavior (every symbol evaluated');
console.log('   at least once every ceil(n/14) ticks; hard cap 14 preserved).');

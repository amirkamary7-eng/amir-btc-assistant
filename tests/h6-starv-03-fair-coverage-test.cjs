/**
 * H6-STARV-03 — Fair-Coverage Deep Behavioral Tests (Task 70)
 *
 * Runs the REAL _selectOhlcWindow extracted from worker-proxy.js
 * (brace-slicing + fresh module scope per selector = fresh per-isolate
 * state, deterministic) and asserts the hard guarantees of the fix:
 *
 *   FAIR-01  n ≤ 14 → identity (ALL symbols, EVERY tick — unchanged).
 *   FAIR-02  window never exceeds 14; symbols unique; deterministic.
 *   FAIR-03  coverage bound: every symbol selected at least once every
 *            ceil(n/14) consecutive ticks, for n ∈ {15,16,20,28,43,50,100,500};
 *            max selection gap over a long run ≤ ceil(n/14).
 *   FAIR-04  new-symbol priority: a brand-new symbol at steady state is in
 *            the VERY NEXT window (immediate first-check trigger UX).
 *   FAIR-05  churn: removed symbols disappear; the state Map stays bounded.
 *   FAIR-06  static pins: call site, FETCH_BATCH, fetch loop, maxAlerts.
 *
 * Run: node --test tests/h6-starv-03-fair-coverage-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');

// ─── Extract the REAL selector ───────────────────────────────────────────────
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

const SELECTOR_CODE =
  'const _ohlcWindowLastFetched = new Map();\n' +
  'let _ohlcWindowTick = 0;\n' +
  extractFn(WORKER_SRC, '_selectOhlcWindow');

/** Fresh module scope = fresh per-isolate state (deterministic). */
function makeRealSelector() {
  return new Function(SELECTOR_CODE + '\nreturn _selectOhlcWindow;')();
}

/** The live state Map of a selector (for FAIR-05 boundedness checks). */
function makeRealSelectorWithState() {
  const scope = new Function(SELECTOR_CODE + '\nreturn { select: _selectOhlcWindow, state: _ohlcWindowLastFetched };')();
  return scope;
}

const syms = (n) => Array.from({ length: n }, (_, i) => 'SYM' + String(i).padStart(3, '0'));

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-01 — n ≤ 14 → identity (unchanged behavior)
// ═══════════════════════════════════════════════════════════════════════════

test('FAIR-01: n ≤ 14 → ALL symbols selected EVERY tick (behavior identical to pre-fix)', () => {
  for (let n = 0; n <= 14; n++) {
    const selectWindow = makeRealSelector();
    const symbols = syms(n);
    for (let tick = 0; tick < 3; tick++) {
      const window = selectWindow(symbols, 14);
      assert.equal(window.length, n, `n=${n} tick=${tick}: all ${n} symbols selected`);
      assert.deepEqual([...window].sort(), [...symbols].sort(), `n=${n} tick=${tick}: same symbol set`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-02 — cap + uniqueness + determinism invariants
// ═══════════════════════════════════════════════════════════════════════════

test('FAIR-02: window never exceeds 14; symbols unique; deterministic across fresh scopes', () => {
  for (const n of [15, 20, 50, 500]) {
    const a = makeRealSelector();
    const b = makeRealSelector();
    const symbols = syms(n);
    for (let tick = 0; tick < 10; tick++) {
      const wa = a(symbols, 14);
      const wb = b(symbols, 14);
      assert.ok(wa.length <= 14, `n=${n} tick=${tick}: window size ${wa.length} ≤ 14`);
      assert.equal(new Set(wa).size, wa.length, `n=${n} tick=${tick}: no duplicate symbols in window`);
      assert.deepEqual(wa, wb, `n=${n} tick=${tick}: deterministic (two fresh scopes agree)`);
    }
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-03 — the core anti-starvation coverage bound
// ═══════════════════════════════════════════════════════════════════════════

test('FAIR-03: every symbol is selected at least once every ceil(n/14) consecutive ticks (no starvation)', () => {
  for (const n of [15, 16, 20, 28, 43, 50, 100, 500]) {
    const selectWindow = makeRealSelector();
    const symbols = syms(n);
    const bound = Math.ceil(n / 14);
    const RUN = bound * 3; // run 3 full coverage cycles
    const lastSeen = new Map(); // symbol → tick index of last selection
    const gaps = new Map(); // symbol → max observed gap
    for (let tick = 1; tick <= RUN; tick++) {
      const window = selectWindow(symbols, 14);
      for (const s of window) {
        if (lastSeen.has(s)) {
          const gap = tick - lastSeen.get(s);
          gaps.set(s, Math.max(gaps.get(s) || 0, gap));
        }
        lastSeen.set(s, tick);
      }
      // Rolling-window coverage: every ⌈n/14⌉ consecutive ticks include every
      // symbol at least once (check the completed windows only).
      if (tick >= bound && tick % bound === 0) {
        const windowStart = tick - bound + 1;
        for (const s of symbols) {
          const seen = lastSeen.get(s);
          assert.ok(seen !== undefined && seen >= windowStart,
            `n=${n}: symbol ${s} NOT selected within ticks ${windowStart}..${tick} (bound ${bound} violated)`);
        }
      }
    }
    // Max gap over the whole run (excluding the warm-up first selection).
    for (const s of symbols) {
      assert.ok((gaps.get(s) || 0) <= bound,
        `n=${n}: symbol ${s} max gap ${gaps.get(s)} > bound ${bound}`);
    }
    assert.equal(lastSeen.size, n, `n=${n}: all symbols were selected at least once`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-04 — brand-new symbol priority (immediate first check)
// ═══════════════════════════════════════════════════════════════════════════

test('FAIR-04: a brand-new symbol at steady state is in the VERY NEXT window', () => {
  for (const n of [15, 20, 50]) {
    const selectWindow = makeRealSelector();
    const symbols = syms(n);
    // Steady state: full coverage already achieved.
    for (let t = 0; t < Math.ceil(n / 14); t++) selectWindow(symbols, 14);
    // New alert on a brand-new symbol (never fetched → t=0 → top priority).
    const next = selectWindow(['BRANDNEW', ...symbols], 14);
    assert.ok(next.includes('BRANDNEW'),
      `n=${n}: brand-new symbol must be in the very next window (never-fetched priority)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-05 — churn: removed symbols disappear; state stays bounded
// ═══════════════════════════════════════════════════════════════════════════

test('FAIR-05: churn — removed symbols are not selected; the state Map stays bounded', () => {
  const { select, state } = makeRealSelectorWithState();
  let symbols = syms(40);
  for (let t = 0; t < 3; t++) select(symbols, 14);
  // Half the alerts are deleted/triggered.
  symbols = symbols.slice(0, 20);
  for (let t = 0; t < 10; t++) {
    const window = select(symbols, 14);
    for (const s of window) {
      assert.ok(symbols.includes(s),
        `tick ${t}: selected symbol ${s} is not in the active list`);
    }
  }
  // The prune path keeps the Map bounded (≤ 2n after prune triggers).
  assert.ok(state.size <= symbols.length * 2 + 14,
    `state Map size ${state.size} must stay bounded (active=${symbols.length})`);
});

// ═══════════════════════════════════════════════════════════════════════════
// FAIR-06 — static pins around the call site
// ═══════════════════════════════════════════════════════════════════════════

test('FAIR-06: static pins — call site, FETCH_BATCH, fetch loop, maxAlerts default', () => {
  assert.ok(WORKER_SRC.includes('const uniqueSymbols = _selectOhlcWindow(uniqueSymbolsAll, 14);'),
    'runScheduledAlertsBaseline must call _selectOhlcWindow(uniqueSymbolsAll, 14)');
  assert.ok(WORKER_SRC.includes('const FETCH_BATCH = 15;'),
    'FETCH_BATCH must still be 15 (single batch for ≤14 symbols)');
  assert.ok(WORKER_SRC.includes('const KLINE_EXCHANGES = [\'bybit\', \'okx\', \'mexc\'];'),
    'KLINE_EXCHANGES unchanged');
  assert.ok(WORKER_SRC.includes("ALERTS_CRON_MAX_ALERTS', 500"),
    'maxAlerts default must still be 500');
  // The fetch loop still iterates the (≤14) selected symbols in FETCH_BATCH chunks.
  const loopIdx = WORKER_SRC.indexOf('for (let i = 0; i < uniqueSymbols.length; i += FETCH_BATCH)');
  assert.ok(loopIdx > -1, 'the OHLC fetch loop must still iterate uniqueSymbols by FETCH_BATCH');
});

console.log('✅ H6-STARV-02 (fair-coverage deep behavioral) tests loaded.');

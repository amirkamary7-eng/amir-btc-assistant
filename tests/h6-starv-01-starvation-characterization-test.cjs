/**
 * H6-STARV-01 — Alert Symbol Starvation Characterization Test
 *
 * ⚠️ THIS IS A CHARACTERIZATION TEST, NOT A DESIRED-BEHAVIOR TEST.
 *
 * It ACCURATELY documents the CURRENT production behavior: alerts whose
 * unique symbol falls outside the top-14 (by created_at DESC) are
 * PERMANENTLY starved — they are never evaluated, regardless of how many
 * cache-miss cycles pass. This test PASSES because it describes the
 * current (broken) behavior. When the starvation is fixed in a future
 * phase, this test must be UPDATED (or replaced) to assert the new
 * fair-coverage behavior.
 *
 * Background (from AUDIT-DEEP-H6):
 *   - `listActiveForCron` (alerts.js:392-401) uses
 *       SELECT ... WHERE status='active' ORDER BY created_at DESC LIMIT $1
 *     with NO OFFSET, NO cursor, NO rotation.
 *   - `uniqueSymbols` (worker-proxy.js:5711-5713) is computed as
 *       [...new Set(alerts.map(a => a.symbol))].slice(0, 14)
 *     — only the first 14 unique symbols (by Set insertion order, which
 *     follows the alerts array order = created_at DESC).
 *   - The eval loop (worker-proxy.js:5761) iterates ALL alerts, but looks
 *     up `symbolOhlcMap.get(symbol)` which only contains entries for the
 *     14 sliced symbols. Alerts whose symbol is NOT in the map hit the
 *     `!ohlc` branch (L5779) → `skipped_ohlc_unavailable++` → continue.
 *   - The H6 Phase 1 silent-loss fix (L5779-5802) ensures skipped alerts
 *     retain their `last_price` / `last_checked_at` — but they are STILL
 *     starved on the next tick because the same ORDER BY reloads the same
 *     top-14.
 *
 * Escape conditions from starvation (the ONLY ways a starved alert gets
 * evaluated):
 *   1. One of the top-14 alerts triggers (status → 'triggered', excluded
 *      from next query).
 *   2. One of the top-14 alerts is deleted by the user.
 *   3. A new alert on the starved symbol is created with a newer
 *      created_at (potentially pushing it into top-14).
 *
 * If none of these occur, the alert is starved INDEFINITELY.
 *
 * This test does NOT modify any production code. It only reads source
 * files and simulates the current behavior.
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

// ═══════════════════════════════════════════════════════════════════════
// SECTION 1 — Source assertions: the starvation-causing code exists
// ═══════════════════════════════════════════════════════════════════════

test('STARV-01-SRC-A: .slice(0, 14) symbol cap exists in worker-proxy.js', () => {
  assert.ok(WORKER_SRC.includes('].slice(0, 14)'),
    'The 14-symbol cap (.slice(0, 14)) must exist — it is the root cause of starvation');
});

test('STARV-01-SRC-B: listActiveForCron uses ORDER BY created_at DESC (no rotation)', () => {
  assert.ok(ALERTS_SRC.includes('ORDER BY created_at DESC'),
    'listActiveForCron must use ORDER BY created_at DESC — deterministic ordering with no rotation');
  assert.ok(ALERTS_SRC.includes('WHERE status = \'active\''),
    'listActiveForCron filters by status=active');
});

test('STARV-01-SRC-C: NO OFFSET / cursor / rotation logic in alerts cron path', () => {
  // Verify there is no OFFSET clause in listActiveForCron
  const listFnStart = ALERTS_SRC.indexOf('async function listActiveForCron');
  const listFnEnd = ALERTS_SRC.indexOf('}', ALERTS_SRC.indexOf('LIMIT $1', listFnStart));
  const listFnBody = ALERTS_SRC.slice(listFnStart, listFnEnd);
  assert.ok(!/OFFSET/i.test(listFnBody),
    'listActiveForCron must NOT have OFFSET (no pagination)');
  assert.ok(!/cursor/i.test(listFnBody),
    'listActiveForCron must NOT have cursor logic');
  // Verify no rotation state in worker-proxy.js alerts path
  // (module-level rotation counter, KV-backed cursor, etc.)
  const alertsBaselineIdx = WORKER_SRC.indexOf('runScheduledAlertsBaseline');
  if (alertsBaselineIdx > -1) {
    const baselineBody = WORKER_SRC.slice(alertsBaselineIdx, alertsBaselineIdx + 5000);
    assert.ok(!/rotationIdx|rotation_idx|cronCursor|cron_cursor|tickCount\s*%/i.test(baselineBody),
      'runScheduledAlertsBaseline must NOT contain rotation cursor logic (starvation root cause)');
  }
});

test('STARV-01-SRC-D: eval loop skips alerts whose symbol is not in symbolOhlcMap', () => {
  // The skip branch: if (!ohlc || ...) { skipped_ohlc_unavailable++; continue; }
  assert.ok(WORKER_SRC.includes('skipped_ohlc_unavailable'),
    'The OHLC-unavailable skip counter must exist (this is the starvation manifestation)');
  assert.ok(WORKER_SRC.includes('resultPayload.skipped_ohlc_unavailable += 1'),
    'The skip increment must exist');
});

test('STARV-01-SRC-E: skipped alerts do NOT get last_price / last_checked_at updated (H6 Phase 1 fix)', () => {
  // This is correct for cross-detection (prevPrice preserved), but it
  // means starved alerts retain their old last_checked_at → they do NOT
  // bubble up in a priority-ordered query (there is no such query).
  const ohlcCheckIdx = WORKER_SRC.indexOf('if (!ohlc || !Number.isFinite(ohlc.high)');
  const candleHighIdx = WORKER_SRC.indexOf('const candleHigh = ohlc.high;', ohlcCheckIdx);
  const branchBody = WORKER_SRC.slice(ohlcCheckIdx, candleHighIdx);
  assert.ok(!branchBody.includes('_pendingUpdates.push'),
    'Skipped alerts must NOT be pushed to _pendingUpdates (last_price not touched)');
  assert.ok(branchBody.includes('continue'),
    'Skipped alerts must continue (exit the eval iteration for this alert)');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2 — Simulation: 50 unique symbols over 5 cache-miss cycles
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simulates the alerts cron behavior with N=50 unique symbols across 5
 * cache-miss cycles. A "cache-miss cycle" = the module-level isolate
 * cache (_alertsIsolateCache, TTL 60s) has expired, so a fresh DB query
 * runs listActiveForCron → returns the same 50 alerts in the same
 * ORDER BY created_at DESC order → same .slice(0, 14) → same 14 symbols.
 */

test('STARV-01-SIM-01: 50 unique symbols → only 14 evaluated per cycle (starvation)', () => {
  const N = 50;
  // Build 50 alerts, each with a unique symbol.
  // Alert 0 is the OLDEST (created_at = 10 min ago).
  // Alert 49 is the NEWEST (created_at = now).
  const alerts = [];
  for (let i = 0; i < N; i++) {
    alerts.push({
      id: 'alert_' + i,
      user_id: 'user_' + i,
      symbol: 'SYM' + String(i).padStart(2, '0'),
      price: 100,
      direction: 'above',
      last_price: null,
      last_checked_at: null,
      created_at: new Date(Date.now() - (N - i) * 60000).toISOString(),
    });
  }
  // ORDER BY created_at DESC → newest first: [SYM49, SYM48, ..., SYM01, SYM00]
  const sorted = [...alerts].sort((a, b) =>
    new Date(b.created_at) - new Date(a.created_at));
  // uniqueSymbols = Set(alerts.map(symbol)) then .slice(0, 14)
  const uniqueSymbols = [...new Set(
    sorted.map(a => String(a.symbol || '').trim().toUpperCase()).filter(Boolean)
  )].slice(0, 14);

  assert.equal(uniqueSymbols.length, 14,
    'only 14 unique symbols are selected for OHLC fetch (the cap)');
  // The 14 evaluated are the NEWEST 14: SYM49..SYM36
  assert.equal(uniqueSymbols[0], 'SYM49', 'newest symbol is first');
  assert.equal(uniqueSymbols[13], 'SYM36', '14th symbol is SYM36');
  // The 36 starved are the OLDEST 36: SYM00..SYM35
  const starved = sorted.slice(14).map(a => a.symbol);
  assert.equal(starved.length, 36, '36 symbols are starved');
  assert.ok(starved.includes('SYM00'), 'oldest symbol SYM00 is starved');
  assert.ok(starved.includes('SYM35'), 'SYM35 is starved');
  assert.ok(!uniqueSymbols.includes('SYM00'), 'SYM00 NOT in evaluated set');
  assert.ok(!uniqueSymbols.includes('SYM35'), 'SYM35 NOT in evaluated set');
});

test('STARV-01-SIM-02: 5 cache-miss cycles → SAME 14 symbols every cycle (no rotation)', () => {
  const N = 50;
  const CYCLES = 5;
  // Build alerts (same as SIM-01)
  const alerts = [];
  for (let i = 0; i < N; i++) {
    alerts.push({
      id: 'alert_' + i,
      symbol: 'SYM' + String(i).padStart(2, '0'),
      created_at: new Date(Date.now() - (N - i) * 60000).toISOString(),
      last_price: null,
      last_checked_at: null,
    });
  }

  // Simulate 5 cache-miss cycles. Each cycle:
  //   1. Module cache expired → fresh DB query → listActiveForCron
  //   2. Same 50 alerts returned (none triggered/deleted between cycles)
  //   3. Same ORDER BY created_at DESC → same uniqueSymbols → same .slice(0,14)
  const evaluatedPerCycle = [];
  const starvedPerCycle = [];
  for (let cycle = 0; cycle < CYCLES; cycle++) {
    // Simulate listActiveForCron: ORDER BY created_at DESC
    const sorted = [...alerts].sort((a, b) =>
      new Date(b.created_at) - new Date(a.created_at));
    // Simulate uniqueSymbols construction + .slice(0, 14)
    const uniqueSymbols = [...new Set(
      sorted.map(a => String(a.symbol || '').trim().toUpperCase()).filter(Boolean)
    )].slice(0, 14);
    evaluatedPerCycle.push(new Set(uniqueSymbols));
    starvedPerCycle.push(sorted.slice(14).map(a => a.symbol));
  }

  // Assert: the SAME 14 symbols are evaluated every cycle
  const cycle0Set = evaluatedPerCycle[0];
  for (let c = 1; c < CYCLES; c++) {
    const cycleSet = evaluatedPerCycle[c];
    // Every symbol in cycle 0 must be in cycle c (same set)
    for (const sym of cycle0Set) {
      assert.ok(cycleSet.has(sym),
        `Cycle ${c}: symbol ${sym} was evaluated in cycle 0 but NOT in cycle ${c} — rotation detected (UNEXPECTED with current code)`);
    }
    // No NEW symbols should appear in cycle c that weren't in cycle 0
    for (const sym of cycleSet) {
      assert.ok(cycle0Set.has(sym),
        `Cycle ${c}: symbol ${sym} appeared newly (was starved in cycle 0) — this would mean rotation exists, but current code has none`);
    }
  }

  // Assert: the 36 starved symbols are the SAME every cycle (never rotate in)
  const starvedCycle0 = new Set(starvedPerCycle[0]);
  for (let c = 1; c < CYCLES; c++) {
    for (const sym of starvedPerCycle[c]) {
      assert.ok(starvedCycle0.has(sym),
        `Cycle ${c}: starved symbol ${sym} was NOT starved in cycle 0 — starvation set changed (UNEXPECTED)`);
    }
  }
});

test('STARV-01-SIM-03: starvation is PERMANENT unless a top-14 alert triggers or is deleted', () => {
  const N = 50;
  const alerts = [];
  for (let i = 0; i < N; i++) {
    alerts.push({
      id: 'alert_' + i,
      symbol: 'SYM' + String(i).padStart(2, '0'),
      created_at: new Date(Date.now() - (N - i) * 60000).toISOString(),
      status: 'active',
    });
  }

  // Cycle 0: SYM00 is starved (position 36 in the sorted list, outside top-14)
  function getCycle(alertsArr) {
    const sorted = [...alertsArr]
      .filter(a => a.status === 'active')
      .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
    return [...new Set(
      sorted.map(a => String(a.symbol || '').trim().toUpperCase()).filter(Boolean)
    )].slice(0, 14);
  }
  let cycle0 = getCycle(alerts);
  assert.ok(!cycle0.includes('SYM00'), 'SYM00 is starved in cycle 0');

  // Cycle 1: no escape condition fires → SYM00 still starved
  let cycle1 = getCycle(alerts);
  assert.ok(!cycle1.includes('SYM00'), 'SYM00 still starved in cycle 1 (no escape)');

  // Cycle 2: simulate a top-14 alert triggering (status → triggered)
  //   SYM49 (newest, position 0) triggers → removed from active set
  const sym49Alert = alerts.find(a => a.symbol === 'SYM49');
  sym49Alert.status = 'triggered';
  let cycle2 = getCycle(alerts);
  // Now SYM35 (the 15th newest, previously starved) should enter top-14
  assert.ok(cycle2.includes('SYM35'),
    'After SYM49 triggers, SYM35 (previously starved) enters top-14');
  // But SYM00 is STILL starved (it's still outside top-14)
  assert.ok(!cycle2.includes('SYM00'),
    'SYM00 STILL starved even after SYM49 triggers — it needs 36 more top-14 alerts to trigger/delete');

  // This proves: starvation is only escapable one-symbol-at-a-time as
  // each top-14 alert triggers or is deleted. For SYM00 to be evaluated,
  // ALL 36 alerts between it and the top-14 must trigger or be deleted.
});

test('STARV-01-SIM-04: a brand-new alert with a NEW symbol enters top-14 immediately', () => {
  // A new alert created NOW has created_at = NOW() → becomes the newest
  // → first in ORDER BY created_at DESC → first in uniqueSymbols Set.
  // This DISPLACES the previous 14th symbol (now 15th → starved).
  const alerts = [];
  for (let i = 0; i < 15; i++) {
    alerts.push({
      id: 'alert_' + i,
      symbol: 'SYM' + String(i).padStart(2, '0'),
      created_at: new Date(Date.now() - (15 - i) * 60000).toISOString(),
    });
  }
  // With 15 symbols, all 15 are in top-14? No — .slice(0,14) drops SYM00.
  let cycle = [...new Set(
    [...alerts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(a => String(a.symbol).toUpperCase()).filter(Boolean)
  )].slice(0, 14);
  assert.equal(cycle.length, 14, '15 symbols → 14 evaluated');
  assert.ok(!cycle.includes('SYM00'), 'SYM00 (oldest) starved');

  // Create a NEW alert with a NEW symbol (SYM99)
  alerts.push({
    id: 'alert_99',
    symbol: 'SYM99',
    created_at: new Date().toISOString(), // NOW → newest
  });
  cycle = [...new Set(
    [...alerts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
      .map(a => String(a.symbol).toUpperCase()).filter(Boolean)
  )].slice(0, 14);
  assert.equal(cycle[0], 'SYM99', 'new symbol SYM99 enters at position 0');
  assert.ok(!cycle.includes('SYM00'), 'SYM00 still starved');
  assert.ok(!cycle.includes('SYM01'), 'SYM01 now ALSO starved (displaced by SYM99)');
  // The new alert displaced the previous 14th (SYM01) into starvation.
});

test('STARV-01-SIM-05: ≤14 symbols → no starvation (cap does not bite)', () => {
  // This verifies the "≤14 behavior unchanged" constraint: with 14 or
  // fewer unique symbols, ALL are evaluated every tick (no starvation).
  for (let n = 0; n <= 14; n++) {
    const alerts = [];
    for (let i = 0; i < n; i++) {
      alerts.push({
        symbol: 'SYM' + i,
        created_at: new Date(Date.now() - i * 1000).toISOString(),
      });
    }
    const uniqueSymbols = [...new Set(
      [...alerts].sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .map(a => String(a.symbol || '').trim().toUpperCase()).filter(Boolean)
    )].slice(0, 14);
    assert.equal(uniqueSymbols.length, n,
      `N=${n}: all ${n} symbols evaluated (cap=14 does not reduce when N≤14)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 3 — Subrequest accounting (current behavior, Free Plan)
// ═══════════════════════════════════════════════════════════════════════

test('STARV-01-SUBREQ: 14 symbols × 2 subreq/symbol (cache-hit) + fixed overhead ≈ 40-50', () => {
  // Current behavior on Free Plan: 14 symbols evaluated, each costs 2
  // subrequests (1 KV read + 1 HTTP fetch on cache-hit). The 36 starved
  // symbols cost 0 subrequests (they hit the !ohlc skip branch, no fetch).
  const N = 50;
  const evaluated = 14;
  const starved = N - evaluated; // 36
  const subreqPerSymbolCacheHit = 2; // 1 KV read + 1 HTTP fetch
  const fixedOverhead = 12; // alerts list + bulk DB + KV inv + processQueue(5)
  const total = evaluated * subreqPerSymbolCacheHit + fixedOverhead;
  assert.ok(total <= 50,
    `Free Plan: ${total} subrequests ≤ 50 limit (starved symbols cost 0)`);
  assert.equal(starved, 36, '36 symbols starved at 0 subrequest cost');
});

console.log('✅ H6-STARV-01 (starvation characterization) tests loaded.');
console.log('   ⚠️ These tests DOCUMENT the current starvation behavior.');
console.log('   When starvation is fixed, UPDATE these tests to assert fair coverage.');

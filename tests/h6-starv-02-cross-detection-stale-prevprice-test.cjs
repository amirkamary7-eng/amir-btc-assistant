/**
 * H6-STARV-02 — Cross-Detection with Stale prevPrice Characterization Test
 *
 * Verifies that the current cross-detection logic correctly handles
 * prevPrice that was set in a PREVIOUS evaluation (potentially many
 * ticks ago, if the alert was starved or OHLC was unavailable).
 *
 * Background (from AUDIT-DEEP-H6):
 *   - `prevPrice = alert.last_price` (worker-proxy.js:5767) — persisted in
 *     the DB via the bulk UPDATE at L6230-6254.
 *   - The H6 Phase 1 silent-loss fix (L5779-5802) ensures that when OHLC
 *     is unavailable, the alert's last_price is NOT touched → prevPrice
 *     retains its value from the last tick where OHLC WAS available.
 *   - Cross-detection logic (L5823-5917):
 *       direction='below':
 *         - prevPrice == null → trigger if candleLow <= target (first check)
 *         - prevPrice > target && candleLow <= target → trigger (cross_down)
 *         - prevPrice <= target && candleLow <= target → NO retrigger (still_below)
 *       direction='above':
 *         - prevPrice == null → trigger if candleHigh >= target (first check)
 *         - prevPrice < target && candleHigh >= target → trigger (cross_up)
 *         - prevPrice >= target && candleHigh >= target → NO retrigger (still_above)
 *
 * This test verifies:
 *   1. prevPrice is sourced from alert.last_price (persisted in DB).
 *   2. The cross-detection branches exist and use the correct logic.
 *   3. Simulated scenarios with a GAP between evaluations (stale prevPrice)
 *      still trigger correctly — the cross-detection logic does NOT depend
 *      on consecutive-tick evaluations, only on prevPrice (persisted) and
 *      the current candle (freshly fetched).
 *
 * This test does NOT modify any production code. It only reads source
 * files and simulates the current behavior.
 *
 * Run: node --test tests/h6-starv-02-cross-detection-stale-prevprice-test.cjs
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
// SECTION 1 — Source assertions: prevPrice sourcing + cross-detection logic
// ═══════════════════════════════════════════════════════════════════════

test('STARV-02-SRC-A: prevPrice is sourced from alert.last_price (persisted in DB)', () => {
  assert.ok(WORKER_SRC.includes('const prevPrice = alert?.last_price != null ? Number(alert.last_price) : null'),
    'prevPrice must be sourced from alert.last_price (persisted via bulk UPDATE)');
});

test('STARV-02-SRC-B: last_price is persisted via bulk UPDATE (CASE WHEN)', () => {
  assert.ok(WORKER_SRC.includes('last_price = CASE id'),
    'Bulk UPDATE must use CASE id for last_price persistence');
  assert.ok(WORKER_SRC.includes('last_checked_at = NOW()'),
    'Bulk UPDATE must set last_checked_at = NOW()');
});

test('STARV-02-SRC-C: cross-detection for direction=below exists with correct logic', () => {
  assert.ok(WORKER_SRC.includes("direction === 'below'"),
    'direction=below branch must exist');
  assert.ok(WORKER_SRC.includes('prevPrice > targetPrice && candleLow <= targetPrice'),
    'cross_down branch: prevPrice > target && candleLow <= target');
  assert.ok(WORKER_SRC.includes('prevPrice <= targetPrice && candleLow <= targetPrice'),
    'still_below_no_retrigger branch: prevPrice <= target && candleLow <= target');
  assert.ok(WORKER_SRC.includes("triggerReason = 'cross_down'"),
    'cross_down trigger reason must exist');
  assert.ok(WORKER_SRC.includes("triggerReason = 'still_below_no_retrigger'"),
    'still_below_no_retrigger reason must exist');
});

test('STARV-02-SRC-D: cross-detection for direction=above exists with correct logic', () => {
  // The production code uses `if (direction === 'below') { ... } else { /* direction = 'above' (default) */ ... }`
  // — the 'above' branch is an else-branch with a comment, NOT a `direction === 'above'` check.
  assert.ok(WORKER_SRC.includes("direction = 'above'"),
    'direction=above branch must exist (as else-branch with comment "direction = \'above\' (default)")');
  assert.ok(WORKER_SRC.includes('prevPrice < targetPrice && candleHigh >= targetPrice'),
    'cross_up branch: prevPrice < target && candleHigh >= target');
  assert.ok(WORKER_SRC.includes('prevPrice >= targetPrice && candleHigh >= targetPrice'),
    'still_above_no_retrigger branch: prevPrice >= target && candleHigh >= target');
  assert.ok(WORKER_SRC.includes("triggerReason = 'cross_up'"),
    'cross_up trigger reason must exist');
  assert.ok(WORKER_SRC.includes("triggerReason = 'still_above_no_retrigger'"),
    'still_above_no_retrigger reason must exist');
});

test('STARV-02-SRC-E: first-check (prevPrice == null) branches exist for both directions', () => {
  assert.ok(WORKER_SRC.includes('prevPrice == null || !Number.isFinite(prevPrice)'),
    'First-check branch (prevPrice == null) must exist');
  assert.ok(WORKER_SRC.includes('candleLow <= targetPrice'),
    'First-check below: trigger if candleLow <= target');
  assert.ok(WORKER_SRC.includes('candleHigh >= targetPrice'),
    'First-check above: trigger if candleHigh >= target');
});

// ═══════════════════════════════════════════════════════════════════════
// SECTION 2 — Simulation: cross-detection with stale prevPrice (gap)
// ═══════════════════════════════════════════════════════════════════════

/**
 * Simulates the cross-detection logic. This function MIRRORS the actual
 * production logic in worker-proxy.js:5808-5917, but in pure JS for
 * testing. It does NOT import or call the production code.
 */
function evaluateCrossDetection(direction, targetPrice, prevPrice, candle) {
  const candleHigh = candle.high;
  const candleLow = candle.low;
  let shouldTrigger = false;
  let triggerReason = 'no_cross';

  if (direction === 'below') {
    if (prevPrice == null || !Number.isFinite(prevPrice)) {
      shouldTrigger = candleLow <= targetPrice;
      triggerReason = shouldTrigger ? 'immediate_below' : 'above_target_no_cross';
    } else if (prevPrice > targetPrice && candleLow <= targetPrice) {
      shouldTrigger = true;
      triggerReason = 'cross_down';
    } else if (prevPrice <= targetPrice && candleLow <= targetPrice) {
      shouldTrigger = false;
      triggerReason = 'still_below_no_retrigger';
    }
  } else if (direction === 'above') {
    if (prevPrice == null || !Number.isFinite(prevPrice)) {
      shouldTrigger = candleHigh >= targetPrice;
      triggerReason = shouldTrigger ? 'immediate_above' : 'below_target_no_cross';
    } else if (prevPrice < targetPrice && candleHigh >= targetPrice) {
      shouldTrigger = true;
      triggerReason = 'cross_up';
    } else if (prevPrice >= targetPrice && candleHigh >= targetPrice) {
      shouldTrigger = false;
      triggerReason = 'still_above_no_retrigger';
    }
  }
  return { shouldTrigger, triggerReason };
}

test('STARV-02-SIM-01: direction=below with stale prevPrice (5-tick gap) → cross_down triggers', () => {
  // Scenario: alert set for BTC at target=100, direction=below.
  // 5 ticks ago, BTC was at 105 (prevPrice=105, persisted in last_price).
  // Between tick N-5 and tick N, the alert was NOT evaluated (starved).
  // At tick N, OHLC arrives: candle high=106, low=98, close=99.
  // prevPrice=105 > target=100 AND candleLow=98 <= target=100 → cross_down!
  const result = evaluateCrossDetection('below', 100, 105, { high: 106, low: 98, close: 99 });
  assert.ok(result.shouldTrigger, 'Must trigger cross_down (prevPrice 105 > 100, candleLow 98 <= 100)');
  assert.equal(result.triggerReason, 'cross_down',
    'trigger reason must be cross_down');
});

test('STARV-02-SIM-02: direction=above with stale prevPrice (5-tick gap) → cross_up triggers', () => {
  // Scenario: alert for ETH at target=100, direction=above.
  // 5 ticks ago, ETH was at 95 (prevPrice=95, persisted).
  // At tick N: candle high=102, low=94, close=101.
  // prevPrice=95 < target=100 AND candleHigh=102 >= target=100 → cross_up!
  const result = evaluateCrossDetection('above', 100, 95, { high: 102, low: 94, close: 101 });
  assert.ok(result.shouldTrigger, 'Must trigger cross_up (prevPrice 95 < 100, candleHigh 102 >= 100)');
  assert.equal(result.triggerReason, 'cross_up',
    'trigger reason must be cross_up');
});

test('STARV-02-SIM-03: direction=below, no cross in current candle → no trigger', () => {
  // prevPrice=105 (above target=100), but current candle low=103 (above target).
  // Price did NOT cross down through target this candle → no trigger.
  const result = evaluateCrossDetection('below', 100, 105, { high: 106, low: 103, close: 104 });
  assert.ok(!result.shouldTrigger, 'Must NOT trigger (candleLow 103 > target 100 — no cross)');
  assert.equal(result.triggerReason, 'no_cross',
    'trigger reason must be no_cross');
});

test('STARV-02-SIM-04: direction=below, already below (still_below_no_retrigger)', () => {
  // prevPrice=95 (already below target=100), candle low=93 (still below).
  // This is NOT a new cross — price was already below and stayed below.
  // → still_below_no_retrigger (no trigger).
  const result = evaluateCrossDetection('below', 100, 95, { high: 97, low: 93, close: 94 });
  assert.ok(!result.shouldTrigger,
    'Must NOT trigger (already below, no new cross)');
  assert.equal(result.triggerReason, 'still_below_no_retrigger',
    'trigger reason must be still_below_no_retrigger');
});

test('STARV-02-SIM-05: direction=above, already above (still_above_no_retrigger)', () => {
  // prevPrice=105 (already above target=100), candle high=107 (still above).
  // Not a new cross → still_above_no_retrigger.
  const result = evaluateCrossDetection('above', 100, 105, { high: 107, low: 103, close: 106 });
  assert.ok(!result.shouldTrigger,
    'Must NOT trigger (already above, no new cross)');
  assert.equal(result.triggerReason, 'still_above_no_retrigger',
    'trigger reason must be still_above_no_retrigger');
});

test('STARV-02-SIM-06: first-check (prevPrice == null) direction=below → immediate_below', () => {
  // Brand-new alert, never evaluated. prevPrice=null.
  // Candle low=98 <= target=100 → immediate trigger.
  const result = evaluateCrossDetection('below', 100, null, { high: 102, low: 98, close: 99 });
  assert.ok(result.shouldTrigger, 'Must trigger immediate_below (first check, candleLow <= target)');
  assert.equal(result.triggerReason, 'immediate_below',
    'trigger reason must be immediate_below');
});

test('STARV-02-SIM-07: first-check (prevPrice == null) direction=above → immediate_above', () => {
  // Brand-new alert, never evaluated. prevPrice=null.
  // Candle high=102 >= target=100 → immediate trigger.
  const result = evaluateCrossDetection('above', 100, null, { high: 102, low: 95, close: 101 });
  assert.ok(result.shouldTrigger, 'Must trigger immediate_above (first check, candleHigh >= target)');
  assert.equal(result.triggerReason, 'immediate_above',
    'trigger reason must be immediate_above');
});

test('STARV-02-SIM-08: stale prevPrice does NOT break cross-detection (gap is transparent)', () => {
  // This is the KEY test: simulate a 5-tick gap where the alert was
  // starved (not evaluated). The prevPrice from 5 ticks ago is still
  // valid (persisted via last_price). The cross-detection logic uses
  // ONLY prevPrice and the current candle — it does NOT care about the
  // gap duration.

  // Tick 0: alert evaluated, prevPrice=null → no trigger, last_price set to candleClose=105
  let prevPrice = null;
  let candle0 = { high: 106, low: 103, close: 105 };
  let result = evaluateCrossDetection('below', 100, prevPrice, candle0);
  assert.ok(!result.shouldTrigger, 'Tick 0: prevPrice=null, candleLow 103 > 100 → no immediate trigger');
  // last_price is set to candleClose for next tick
  prevPrice = candle0.close; // 105

  // Ticks 1-4: alert STARVED (not evaluated — symbol outside top-14).
  // last_price stays at 105 (H6 Phase 1 fix: skipped alerts' last_price NOT touched).
  // No evaluation happens → prevPrice remains 105.

  // Tick 5: alert finally evaluated again (e.g., it entered top-14).
  // Current candle: high=106, low=98, close=99.
  // prevPrice=105 (from tick 0!) > target=100 AND candleLow=98 <= 100 → cross_down!
  let candle5 = { high: 106, low: 98, close: 99 };
  result = evaluateCrossDetection('below', 100, prevPrice, candle5);
  assert.ok(result.shouldTrigger,
    'Tick 5 (after 5-tick gap): cross_down must trigger (prevPrice 105 from tick 0 > 100, candleLow 98 <= 100)');
  assert.equal(result.triggerReason, 'cross_down',
    'trigger reason must be cross_down even with 5-tick gap');

  // The gap did NOT prevent the trigger — the logic is gap-transparent.
  // This is CORRECT behavior: the cross happened (price went from 105 to 98,
  // crossing target=100). The 5-tick gap just means we detected it late.
});

test('STARV-02-SIM-09: stale prevPrice can MISS an intraminute cross-and-return (known limitation)', () => {
  // Known limitation: if price crosses target and RETURNS within the gap,
  // the cross is missed. This is the same limitation as the current 1-min
  // polling (price could cross and return within 60s), but the gap widens
  // the miss window.
  //
  // Tick 0: prevPrice=95, candle close=95 (below target=100). last_price=95.
  // Ticks 1-4: starved.
  // Tick 5: candle high=102, low=94, close=96. Price spiked to 102 (above
  //   target=100) and returned to 96 (below target).
  //   prevPrice=95 < target=100 AND candleHigh=102 >= 100 → cross_up!
  //   This is DETECTED (cross_up) because the candle high caught the spike.
  //
  // BUT: if the spike happened during ticks 1-4 (the gap) and price returned
  // to 95 by tick 5, the candle at tick 5 would NOT show the spike. The cross
  // would be MISSED.
  //
  // This test documents that the 1m candle cross-detection works WITHIN a
  // single evaluation but cannot detect crosses that happened DURING the gap.
  let prevPrice = 95; // from tick 0
  let candle5 = { high: 102, low: 94, close: 96 };
  let result = evaluateCrossDetection('above', 100, prevPrice, candle5);
  assert.ok(result.shouldTrigger,
    'Cross-up detected: prevPrice 95 < 100, candleHigh 102 >= 100 → cross_up (spike visible in THIS candle)');
  assert.equal(result.triggerReason, 'cross_up');

  // Document the limitation: if the spike was in a PREVIOUS candle (during gap),
  // the current candle doesn't show it → missed.
  let candle5_noSpike = { high: 97, low: 94, close: 96 }; // no spike in THIS candle
  result = evaluateCrossDetection('above', 100, prevPrice, candle5_noSpike);
  assert.ok(!result.shouldTrigger,
    'If spike happened during gap and price returned, current candle shows no cross → MISSED (known limitation of gap evaluation)');
});

console.log('✅ H6-STARV-02 (cross-detection with stale prevPrice) tests loaded.');
console.log('   These tests verify the CURRENT cross-detection logic works with stale prevPrice.');
console.log('   No production code is modified.');

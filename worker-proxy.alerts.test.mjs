/**
 * Price Alert Cross-Detection Logic Tests
 *
 * Tests the trigger logic in runScheduledAlertsBaseline independently
 * by simulating various price scenarios:
 *   - Exact match
 *   - Cross up (price goes from below to above target)
 *   - Cross down (price goes from above to below target)
 *   - Gap (price jumps over target between cron runs)
 *   - Volatility (price oscillates around target)
 *   - Multiple alerts on same symbol
 *   - Multiple users on same price
 *   - Re-trigger prevention (already triggered alert)
 *   - First-check immediate trigger (price already above/below on first cron)
 *   - No re-trigger when price stays above/below after first fire
 */

import { test } from 'node:test';
import assert from 'node:assert';

/**
 * Replicate the cross-detection logic from runScheduledAlertsBaseline.
 * This is the EXACT logic used in production — keep in sync.
 */
function evaluateTrigger({ direction, targetPrice, prevPrice, currentPrice, lastCheckedAt }) {
  let shouldTrigger = false;
  let triggerReason = 'no_cross';

  if (direction === 'below') {
    if (prevPrice == null || !Number.isFinite(prevPrice)) {
      shouldTrigger = currentPrice <= targetPrice;
      triggerReason = shouldTrigger ? 'immediate_below' : 'above_target_no_cross';
    } else if (prevPrice > targetPrice && currentPrice <= targetPrice) {
      shouldTrigger = true;
      triggerReason = 'cross_down';
    } else if (prevPrice <= targetPrice && currentPrice <= targetPrice) {
      if (lastCheckedAt == null) {
        shouldTrigger = true;
        triggerReason = 'first_check_below';
      } else {
        triggerReason = 'still_below_no_retrigger';
      }
    } else {
      triggerReason = 'moved_back_up';
    }
  } else {
    // direction = 'above'
    if (prevPrice == null || !Number.isFinite(prevPrice)) {
      shouldTrigger = currentPrice >= targetPrice;
      triggerReason = shouldTrigger ? 'immediate_above' : 'below_target_no_cross';
    } else if (prevPrice < targetPrice && currentPrice >= targetPrice) {
      shouldTrigger = true;
      triggerReason = 'cross_up';
    } else if (prevPrice >= targetPrice && currentPrice >= targetPrice) {
      if (lastCheckedAt == null) {
        shouldTrigger = true;
        triggerReason = 'first_check_above';
      } else {
        triggerReason = 'still_above_no_retrigger';
      }
    } else {
      triggerReason = 'moved_back_down';
    }
  }

  return { shouldTrigger, triggerReason };
}

test('Cross-detection: direction=above, exact match on first check triggers', () => {
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: null, currentPrice: 120000, lastCheckedAt: null });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'immediate_above');
});

test('Cross-detection: direction=above, first check below target does NOT trigger', () => {
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: null, currentPrice: 119950, lastCheckedAt: null });
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'below_target_no_cross');
});

test('Cross-detection: direction=above, cross UP through target triggers', () => {
  // BTC was at 119950, now at 120030 → trigger (price crossed up through 120000)
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119950, currentPrice: 120030, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_up');
});

test('Cross-detection: direction=above, GAP over target triggers', () => {
  // BTC was at 119000, jumped to 121000 (gap) → trigger
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119000, currentPrice: 121000, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_up');
});

test('Cross-detection: direction=above, price stays above does NOT re-trigger', () => {
  // Already triggered, price still above → no re-trigger
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 120030, currentPrice: 120050, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'still_above_no_retrigger');
});

test('Cross-detection: direction=above, price moved back down does NOT trigger', () => {
  // Price went back below target → no trigger (waiting for next cross up)
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 120030, currentPrice: 119980, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'moved_back_down');
});

test('Cross-detection: direction=below, cross DOWN through target triggers', () => {
  // BTC was at 120030, now at 119980 → trigger
  const r = evaluateTrigger({ direction: 'below', targetPrice: 120000, prevPrice: 120030, currentPrice: 119980, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_down');
});

test('Cross-detection: direction=below, GAP down through target triggers', () => {
  // BTC was at 121000, dropped to 119000 (gap) → trigger
  const r = evaluateTrigger({ direction: 'below', targetPrice: 120000, prevPrice: 121000, currentPrice: 119000, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_down');
});

test('Cross-detection: direction=below, price stays below does NOT re-trigger', () => {
  const r = evaluateTrigger({ direction: 'below', targetPrice: 120000, prevPrice: 119980, currentPrice: 119950, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'still_below_no_retrigger');
});

test('Cross-detection: direction=below, first check below target triggers', () => {
  // User created alert when price was already below → fire on first cron tick
  const r = evaluateTrigger({ direction: 'below', targetPrice: 120000, prevPrice: null, currentPrice: 119950, lastCheckedAt: null });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'immediate_below');
});

test('Cross-detection: decimal precision does not cause miss', () => {
  // Price 119999.999999 close to 120000 — should NOT trigger (still below)
  const r1 = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119950, currentPrice: 119999.999999, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r1.shouldTrigger, false);

  // Price 120000.000001 just above — should trigger (crossed up)
  const r2 = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119950, currentPrice: 120000.000001, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r2.shouldTrigger, true);
  assert.equal(r2.triggerReason, 'cross_up');
});

test('Cross-detection: volatility — price oscillates around target', () => {
  // Sequence: 119950 → 120030 (trigger) → 119980 → 120050 (would trigger again if not for status='triggered')
  // First cross up
  const r1 = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119950, currentPrice: 120030, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r1.shouldTrigger, true);

  // After trigger, alert status becomes 'triggered' — cron query skips it.
  // But if we simulate the same alert re-activated (e.g. user re-created it):
  // price moved back down → no trigger
  const r2 = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 120030, currentPrice: 119980, lastCheckedAt: '2026-07-25T00:05:00Z' });
  assert.equal(r2.shouldTrigger, false);
  assert.equal(r2.triggerReason, 'moved_back_down');

  // Price crosses up again → trigger (this is a NEW cross, not a duplicate)
  const r3 = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119980, currentPrice: 120050, lastCheckedAt: '2026-07-25T00:10:00Z' });
  assert.equal(r3.shouldTrigger, true);
  assert.equal(r3.triggerReason, 'cross_up');
});

test('Cross-detection: high volatility — multiple crosses in sequence', () => {
  // Simulates fast price movement: 119950 → 120100 → 119900 → 120200 → 119800
  // Each up-cross should trigger; each down-move should NOT (direction=above)
  const target = 120000;
  const prices = [119950, 120100, 119900, 120200, 119800, 120300];
  let prevPrice = null;
  let lastCheckedAt = null;
  const triggers = [];

  for (const price of prices) {
    const r = evaluateTrigger({ direction: 'above', targetPrice: target, prevPrice, currentPrice: price, lastCheckedAt });
    if (r.shouldTrigger) triggers.push({ price, reason: r.triggerReason });
    prevPrice = price;
    lastCheckedAt = new Date().toISOString();
  }

  // Should trigger 3 times (once per up-cross)
  assert.equal(triggers.length, 3, `Expected 3 triggers, got ${triggers.length}: ${JSON.stringify(triggers)}`);
  assert.equal(triggers[0].price, 120100);
  assert.equal(triggers[1].price, 120200);
  assert.equal(triggers[2].price, 120300);
});

test('Cross-detection: multiple alerts on same symbol all trigger independently', () => {
  // User A: alert at 120000 above
  // User B: alert at 119500 below
  // User C: alert at 121000 above
  // Price moves from 119000 → 120500 → should trigger A and B (B is below 119500? no, 119500 > 119000)
  // Actually: B set 119500 below, price was 119000 (already below 119500? no, 119000 < 119500, so YES below)
  // Wait, "below 119500" means trigger when price drops to/below 119500. Price 119000 is below 119500.
  // First check: immediate_below → trigger.

  const rA = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119000, currentPrice: 120500, lastCheckedAt: '2026-07-25T00:00:00Z' });
  const rB = evaluateTrigger({ direction: 'below', targetPrice: 119500, prevPrice: null, currentPrice: 119000, lastCheckedAt: null });
  const rC = evaluateTrigger({ direction: 'above', targetPrice: 121000, prevPrice: 119000, currentPrice: 120500, lastCheckedAt: '2026-07-25T00:00:00Z' });

  assert.equal(rA.shouldTrigger, true, 'A should trigger (crossed up 120000)');
  assert.equal(rB.shouldTrigger, true, 'B should trigger (first check, already below 119500)');
  assert.equal(rC.shouldTrigger, false, 'C should NOT trigger (120500 < 121000)');
});

test('Cross-detection: edge case — price exactly equals target on cross', () => {
  // prevPrice=119999.99, currentPrice=120000.00 (exactly target)
  // direction=above: prevPrice < target, currentPrice >= target → trigger
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119999.99, currentPrice: 120000, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_up');
});

test('Cross-detection: edge case — prevPrice exactly equals target', () => {
  // prevPrice=120000 (exactly target), currentPrice=120100
  // direction=above: prevPrice >= target (NOT < target), currentPrice >= target
  // → falls into "still_above_no_retrigger" (or first_check_above if lastCheckedAt is null)
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 120000, currentPrice: 120100, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'still_above_no_retrigger');
});

test('Cross-detection: very small price movements near target', () => {
  // prevPrice=119999.99999, currentPrice=120000.00001 — micro-cross
  const r = evaluateTrigger({ direction: 'above', targetPrice: 120000, prevPrice: 119999.99999, currentPrice: 120000.00001, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_up');
});

test('Cross-detection: tiny stablecoin prices (e.g. DOGE at $0.15)', () => {
  // DOGE alert at $0.15 above, prev $0.149, current $0.151
  const r = evaluateTrigger({ direction: 'above', targetPrice: 0.15, prevPrice: 0.149, currentPrice: 0.151, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
  assert.equal(r.triggerReason, 'cross_up');
});

test('Cross-detection: SHIB-like micro prices ($0.00001)', () => {
  // SHIB alert at $0.000020 above
  const r = evaluateTrigger({ direction: 'above', targetPrice: 0.00002, prevPrice: 0.0000199, currentPrice: 0.0000201, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
});

test('Cross-detection: large BTC prices ($100k+)', () => {
  // BTC alert at $100000 above
  const r = evaluateTrigger({ direction: 'above', targetPrice: 100000, prevPrice: 99500, currentPrice: 100100, lastCheckedAt: '2026-07-25T00:00:00Z' });
  assert.equal(r.shouldTrigger, true);
});

test('Performance: 1000 alerts evaluated in <50ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 1000; i++) {
    evaluateTrigger({
      direction: i % 2 === 0 ? 'above' : 'below',
      targetPrice: 50000 + i,
      prevPrice: 49999 + i,
      currentPrice: 50001 + i,
      lastCheckedAt: '2026-07-25T00:00:00Z',
    });
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 50, `1000 evaluations took ${elapsed}ms (expected <50ms)`);
});

test('Performance: 10000 alerts evaluated in <500ms', () => {
  const t0 = Date.now();
  for (let i = 0; i < 10000; i++) {
    evaluateTrigger({
      direction: 'above',
      targetPrice: 50000,
      prevPrice: 49999,
      currentPrice: 50001,
      lastCheckedAt: '2026-07-25T00:00:00Z',
    });
  }
  const elapsed = Date.now() - t0;
  assert.ok(elapsed < 500, `10000 evaluations took ${elapsed}ms (expected <500ms)`);
});

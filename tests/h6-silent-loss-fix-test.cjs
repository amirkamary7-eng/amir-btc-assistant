/**
 * H6 Phase 1 — Alert/OHLC Silent-Loss Fix Regression Tests
 *
 * Background:
 *   The H6 audit (PHASE-H6-ALERT-CRON-OHLC-SUBREQUEST-AUDIT in worklog)
 *   identified a SILENT LOSS bug for direction='below' alerts:
 *
 *   When OHLC was unavailable for a symbol (beyond the cap of 14, or fetch
 *   failed), the eval loop pushed { alertId, currentPrice: 0 } to
 *   _pendingUpdates. The bulk UPDATE then set last_price=0 AND
 *   last_checked_at=NOW() for this alert.
 *
 *   For direction='below' alerts with last_price=0 and last_checked_at set:
 *   - Next tick when OHLC arrives: prevPrice=0 (≤ targetPrice) and
 *     candleLow ≤ targetPrice → matches 'still_below_no_retrigger' branch
 *     (because last_checked_at != null) → shouldTrigger=FALSE → NO TRIGGER.
 *   - The alert NEVER fires, even though price IS below target → SILENT LOSS.
 *
 * Fix (H6 Phase 1):
 *   When OHLC is unavailable, DON'T push to _pendingUpdates. The alert
 *   retains its previous valid last_price and last_checked_at. On the next
 *   tick when OHLC is available, cross-detection runs with the ORIGINAL
 *   prevPrice → trigger fires correctly.
 *
 *   This is a surgical fix: only the OHLC-unavailable branch is changed.
 *   No other code is touched (trigger evaluation, markTriggeredBulk,
 *   notification flow, fetchOhlc1m, above-direction logic — all UNCHANGED).
 *
 * Critical guarantees:
 *   - direction='below' + OHLC available → previous behavior preserved
 *   - direction='below' + OHLC unavailable → NO fake last_price=0 / last_checked_at
 *   - OHLC returns on next tick → alert can trigger correctly (prevPrice preserved)
 *   - direction='above' + OHLC unavailable → no regression (same skip)
 *   - Real trigger → notification + markTriggeredBulk unchanged
 *   - Alert subrequest count does NOT increase (actually reduces bulk UPDATE size)
 *
 * Run: node --test tests/h6-silent-loss-fix-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const ALERTS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/repositories/alerts.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/cron/scheduler.js'), 'utf8');
const TELEMETRY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/telemetry.js'), 'utf8');
const REFERRAL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/referral-rewards.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — The fix: OHLC-unavailable branch no longer pushes currentPrice:0
// ═══════════════════════════════════════════════════════════════════════════

test('H6-SILENT-01: OHLC-unavailable branch does NOT push currentPrice:0 to _pendingUpdates', () => {
  // The OLD code had: _pendingUpdates.push({ alertId, currentPrice: 0 });
  // The NEW code should NOT have this line in the OHLC-unavailable branch.
  // Find the OHLC-unavailable branch (the if block that checks !ohlc || ...)
  const ohlcCheckIdx = SRC.indexOf("if (!ohlc || !Number.isFinite(ohlc.high)");
  assert.notEqual(ohlcCheckIdx, -1, 'OHLC-unavailable branch must exist');
  // Find the next major statement after this branch (the candleHigh assignment)
  const candleHighIdx = SRC.indexOf('const candleHigh = ohlc.high;', ohlcCheckIdx);
  assert.notEqual(candleHighIdx, -1, 'candleHigh assignment must exist after OHLC check');
  // Extract the branch body
  const branchBody = SRC.slice(ohlcCheckIdx, candleHighIdx);
  // The OLD behavior: push currentPrice:0 to _pendingUpdates
  // Check for the exact push pattern (not just the string 'currentPrice: 0'
  // which also appears in our explanatory comment about the old behavior).
  assert.ok(!branchBody.includes('_pendingUpdates.push({ alertId, currentPrice: 0 })'),
    'OHLC-unavailable branch must NOT push { alertId, currentPrice: 0 } to _pendingUpdates (H6 Phase 1 fix)');
  assert.ok(!branchBody.includes('_pendingUpdates.push'),
    'OHLC-unavailable branch must NOT push to _pendingUpdates at all (H6 Phase 1 fix)');
  // The NEW behavior: increment counter + continue
  assert.ok(branchBody.includes('skipped_ohlc_unavailable'),
    'OHLC-unavailable branch must increment skipped_ohlc_unavailable counter');
  assert.ok(branchBody.includes('continue'),
    'OHLC-unavailable branch must continue (skip this alert)');
});

test('H6-SILENT-02: skipped_ohlc_unavailable counter declared in resultPayload', () => {
  assert.ok(SRC.includes('skipped_ohlc_unavailable: 0'),
    'resultPayload must have skipped_ohlc_unavailable: 0 field');
});

test('H6-SILENT-03: skipped_ohlc_unavailable counter incremented in OHLC-unavailable branch', () => {
  const ohlcCheckIdx = SRC.indexOf("if (!ohlc || !Number.isFinite(ohlc.high)");
  const candleHighIdx = SRC.indexOf('const candleHigh = ohlc.high;', ohlcCheckIdx);
  const branchBody = SRC.slice(ohlcCheckIdx, candleHighIdx);
  assert.ok(branchBody.includes('resultPayload.skipped_ohlc_unavailable += 1'),
    'OHLC-unavailable branch must increment resultPayload.skipped_ohlc_unavailable');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Alerts WITH OHLC: behavior UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

test('H6-SILENT-04: alerts WITH OHLC still push to _pendingUpdates with candleClose', () => {
  // The line that pushes alerts WITH OHLC to _pendingUpdates must be unchanged.
  // Pattern: _pendingUpdates.push({ alertId, currentPrice: candleClose });
  assert.ok(SRC.includes('_pendingUpdates.push({ alertId, currentPrice: candleClose })'),
    'Alerts with OHLC must still push { alertId, currentPrice: candleClose } to _pendingUpdates');
});

test('H6-SILENT-05: bulk UPDATE still sets last_price + last_checked_at for alerts WITH OHLC', () => {
  // The bulk UPDATE must still update last_price (via CASE WHEN) and last_checked_at.
  // This is the existing behavior for alerts that HAVE OHLC.
  assert.ok(SRC.includes('last_price = CASE id'),
    'Bulk UPDATE must still use CASE id for last_price');
  assert.ok(SRC.includes('last_checked_at = NOW()'),
    'Bulk UPDATE must still set last_checked_at = NOW()');
});

test('H6-SILENT-06: cross-detection logic for direction=below UNCHANGED', () => {
  // The trigger evaluation logic must be unchanged. Verify the key branches:
  assert.ok(SRC.includes("direction === 'below'"),
    'direction=below branch must exist');
  assert.ok(SRC.includes('prevPrice > targetPrice && candleLow <= targetPrice'),
    'cross_down branch must exist (prevPrice > target && candleLow <= target)');
  assert.ok(SRC.includes('prevPrice <= targetPrice && candleLow <= targetPrice'),
    'still_below_no_retrigger branch must exist');
  assert.ok(SRC.includes("triggerReason = 'cross_down'"),
    'cross_down trigger reason preserved');
  assert.ok(SRC.includes("triggerReason = 'still_below_no_retrigger'"),
    'still_below_no_retrigger reason preserved (this branch is correct when OHLC was available)');
});

test('H6-SILENT-07: cross-detection logic for direction=above UNCHANGED', () => {
  assert.ok(SRC.includes('prevPrice < targetPrice && candleHigh >= targetPrice'),
    'cross_up branch must exist (prevPrice < target && candleHigh >= target)');
  assert.ok(SRC.includes("triggerReason = 'cross_up'"),
    'cross_up trigger reason preserved');
  assert.ok(SRC.includes("triggerReason = 'still_above_no_retrigger'"),
    'still_above_no_retrigger reason preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Trigger + notification flow UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

test('H6-SILENT-08: _triggeredAlerts.push preserved (trigger collection unchanged)', () => {
  // The triggered alerts collection must still work the same way.
  assert.ok(SRC.includes('_triggeredAlerts.push({'),
    '_triggeredAlerts.push must still be called for triggered alerts');
});

test('H6-SILENT-09: markTriggeredBulk preserved (CAS UPDATE unchanged)', () => {
  assert.ok(SRC.includes('markTriggeredBulk'),
    'markTriggeredBulk must still be called');
  assert.ok(ALERTS_SRC.includes('async function markTriggeredBulk'),
    'markTriggeredBulk function must exist in alerts.js');
  assert.ok(ALERTS_SRC.includes("WHERE id IN") && ALERTS_SRC.includes("status = 'active'"),
    'CAS WHERE status=active preserved in markTriggeredBulk');
});

test('H6-SILENT-10: bulk INSERT notifications + queue preserved', () => {
  // The bulk INSERT for notifications and queue must be unchanged.
  assert.ok(SRC.includes('INSERT INTO notifications') && SRC.includes('ON CONFLICT (id) DO NOTHING'),
    'Bulk INSERT notifications with ON CONFLICT preserved');
  assert.ok(SRC.includes('INSERT INTO notification_queue') && SRC.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'Bulk INSERT notification_queue with ON CONFLICT preserved');
});

test('H6-SILENT-11: KV invalidation preserved (defense-in-depth deletes)', () => {
  assert.ok(SRC.includes("env.APP_CACHE?.delete?.('alerts:active-list')"),
    'KV delete alerts:active-list preserved');
  assert.ok(SRC.includes("env.APP_CACHE?.delete?.('alerts:active-exists')"),
    'KV delete alerts:active-exists preserved (defense-in-depth)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — fetchOhlc1m + cache behavior UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

test('H6-SILENT-12: fetchOhlc1m function UNCHANGED (cache hit/miss behavior preserved)', () => {
  assert.ok(SRC.includes('async function fetchOhlc1m(env, symbol)'),
    'fetchOhlc1m function must exist');
  assert.ok(SRC.includes('readAppCache(env, priceCacheKey)'),
    'KV cache read for exchange routing preserved');
  assert.ok(SRC.includes('writeAppCache(env, priceCacheKey, exchangeKey'),
    'KV cache write for exchange routing preserved');
  assert.ok(SRC.includes('KLINE_EXCHANGES.map'),
    'Parallel fallback to all exchanges preserved');
});

test('H6-SILENT-13: OHLC cap of 14 UNCHANGED (H6 Phase 2 NOT applied)', () => {
  // The cap must still be 14 — this fix is Phase 1 only (silent loss fix).
  // Phase 2 (cap reduction) is NOT in scope.
  assert.ok(SRC.includes('.slice(0, 14)'),
    'OHLC cap must remain at 14 (H6 Phase 2 NOT applied)');
  assert.ok(!SRC.includes('.slice(0, 7)'),
    'OHLC cap must NOT be 7 (H6 Phase 2 NOT applied)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Subrequest impact (should NOT increase)
// ═══════════════════════════════════════════════════════════════════════════

test('H6-SILENT-14: fix does NOT add new queryDb/fetch/KV calls', () => {
  // The fix only REMOVES a push to _pendingUpdates and ADDS a counter increment.
  // No new queryDb, fetch, readAppCache, or writeAppCache calls should be added
  // in the OHLC-unavailable branch.
  const ohlcCheckIdx = SRC.indexOf("if (!ohlc || !Number.isFinite(ohlc.high)");
  const candleHighIdx = SRC.indexOf('const candleHigh = ohlc.high;', ohlcCheckIdx);
  const branchBody = SRC.slice(ohlcCheckIdx, candleHighIdx);
  assert.ok(!branchBody.includes('queryDb'),
    'OHLC-unavailable branch must NOT add queryDb calls');
  assert.ok(!branchBody.includes('fetch('),
    'OHLC-unavailable branch must NOT add fetch calls');
  assert.ok(!branchBody.includes('readAppCache'),
    'OHLC-unavailable branch must NOT add KV read calls');
  assert.ok(!branchBody.includes('writeAppCache'),
    'OHLC-unavailable branch must NOT add KV write calls');
});

test('H6-SILENT-15: fix REDUCES bulk UPDATE size (fewer rows to update)', () => {
  // Before the fix: alerts without OHLC were pushed to _pendingUpdates with
  // currentPrice:0. The bulk UPDATE updated ALL of them (including the fake
  // price:0 ones). After the fix: only alerts WITH OHLC are in _pendingUpdates.
  // The bulk UPDATE is smaller → fewer SQL parameters → same 1 query but smaller.
  // The subrequest count does NOT increase (still 1 bulk UPDATE query).
  assert.ok(SRC.includes('if (_pendingUpdates.length > 0)'),
    'Bulk UPDATE still gated on _pendingUpdates.length > 0');
  // The bulk UPDATE is still 1 queryDb call regardless of _pendingUpdates.length
  // (CASE WHEN with N entries is still 1 SQL statement).
  const bulkUpdateIdx = SRC.indexOf('const bulkSql = `UPDATE price_alerts SET last_price = CASE id');
  assert.notEqual(bulkUpdateIdx, -1, 'Bulk UPDATE SQL must still use CASE id');
  assert.ok(SRC.includes('await queryDb(env, bulkSql, params, 1, pool)'),
    'Bulk UPDATE must still be 1 queryDb call');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Scope verification: no out-of-scope changes
// ═══════════════════════════════════════════════════════════════════════════

test('H6-SILENT-16: scheduler.js UNCHANGED (cron schedule + minute-0 retry block intact)', () => {
  assert.ok(SCHEDULER_SRC.includes("'* * * * *'"),
    '1-min cron trigger unchanged');
  assert.ok(SCHEDULER_SRC.includes("'*/5 * * * *'"),
    '5-min cron trigger unchanged');
  assert.ok(SCHEDULER_SRC.includes("'*/15 * * * *'"),
    '15-min cron trigger unchanged');
  assert.ok(SCHEDULER_SRC.includes('retryFailedReferralRewards'),
    'H5 retry: retryFailedReferralRewards still wired');
  assert.ok(SCHEDULER_SRC.includes('retryFailedWheelRewards'),
    'H5 retry: retryFailedWheelRewards still wired');
  assert.ok(SCHEDULER_SRC.includes('retryFailedMissionRewards'),
    'H5 retry: retryFailedMissionRewards still wired');
  assert.ok(SCHEDULER_SRC.includes('retryFailedRefunds'),
    'H5 retry: retryFailedRefunds still wired');
});

test('H6-SILENT-17: Telemetry Phase A+B UNCHANGED (skip flags preserved)', () => {
  assert.ok(TELEMETRY_SRC.includes('_telemetryCreatePermissionDenied'),
    'Telemetry Phase A flag preserved');
  assert.ok(TELEMETRY_SRC.includes('_tickCleanupPermissionDenied'),
    'Telemetry Phase B flag (tick) preserved');
  assert.ok(TELEMETRY_SRC.includes('_e2eCleanupPermissionDenied'),
    'Telemetry Phase B flag (e2e) preserved');
});

test('H6-SILENT-18: H5 Layer 2+3 UNCHANGED (referral-rewards.js preserved)', () => {
  assert.ok(REFERRAL_SRC.includes('LIMIT 1'),
    'H5 Layer 2: referral retry LIMIT=1 preserved');
  // Mission retry must still be LIMIT 3 (3-day window safety)
  const missionFnStart = REFERRAL_SRC.indexOf('async function retryFailedMissionRewards');
  const missionFnEnd = REFERRAL_SRC.indexOf('async function', missionFnStart + 10);
  const missionBody = REFERRAL_SRC.slice(missionFnStart, missionFnEnd === -1 ? REFERRAL_SRC.length : missionFnEnd);
  assert.ok(missionBody.includes('LIMIT 3'),
    'H5 Layer 2: mission retry LIMIT=3 preserved (3-day window safety)');
  // enqueueOnly: true on 3 referral notification calls
  const creditFnStart = REFERRAL_SRC.indexOf('async function creditReferralWithReward');
  const creditFnEnd = REFERRAL_SRC.indexOf('async function', creditFnStart + 10);
  const creditBody = REFERRAL_SRC.slice(creditFnStart, creditFnEnd === -1 ? REFERRAL_SRC.length : creditFnEnd);
  const enqueueOnlyCount = (creditBody.match(/enqueueOnly: true/g) || []).length;
  assert.equal(enqueueOnlyCount, 3,
    'H5 Layer 3: 3 referral notification calls with enqueueOnly: true');
});

test('H6-SILENT-19: alerts.js UNCHANGED (listActiveForCron + markTriggeredBulk preserved)', () => {
  assert.ok(ALERTS_SRC.includes('async function listActiveForCron'),
    'listActiveForCron preserved');
  assert.ok(ALERTS_SRC.includes('ORDER BY created_at DESC'),
    'Alert ordering by created_at DESC preserved');
  assert.ok(ALERTS_SRC.includes("WHERE status = 'active'"),
    'Alert status filter preserved');
  // alerts.js must NOT contain the new counter (fix is in worker-proxy.js only)
  assert.ok(!ALERTS_SRC.includes('skipped_ohlc_unavailable'),
    'alerts.js must NOT contain skipped_ohlc_unavailable (fix is local to worker-proxy.js)');
});

test('H6-SILENT-20: TTL UNCHANGED (CHART_EXCHANGE_CACHE_TTL not modified in this phase)', () => {
  // The H6 Phase 1 fix is ONLY the silent-loss fix. TTL extension was
  // considered but NOT applied (per user instruction: "اگر درباره TTL
  // اطمینان کافی نداری، TTL را تغییر نده").
  // Verify the TTL is still 3600 (1 hour) — unchanged.
  const wranglerSrc = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
  assert.ok(wranglerSrc.includes('"CHART_EXCHANGE_CACHE_TTL": 3600'),
    'CHART_EXCHANGE_CACHE_TTL must remain 3600 (TTL NOT changed in Phase 1)');
  // The default in worker-proxy.js getNumericEnv should also be 3600
  assert.ok(SRC.includes("'CHART_EXCHANGE_CACHE_TTL', 3600"),
    'worker-proxy.js default for CHART_EXCHANGE_CACHE_TTL must remain 3600');
});

test('H6-SILENT-21: only worker-proxy.js changed (no scope leak)', () => {
  // The fix is local to worker-proxy.js. No other production files should
  // contain the new counter or the H6 Phase 1 comment.
  const filesToCheck = [
    { name: 'src/cron/scheduler.js', src: SCHEDULER_SRC },
    { name: 'src/repositories/alerts.js', src: ALERTS_SRC },
    { name: 'src/repositories/wallet.js', src: fs.readFileSync(path.join(__dirname, '..', 'src/repositories/wallet.js'), 'utf8') },
    { name: 'src/repositories/notification_platform.js', src: fs.readFileSync(path.join(__dirname, '..', 'src/repositories/notification_platform.js'), 'utf8') },
    { name: 'src/news/telemetry.js', src: TELEMETRY_SRC },
    { name: 'src/services/referral-rewards.js', src: REFERRAL_SRC },
  ];
  for (const { name, src } of filesToCheck) {
    assert.ok(!src.includes('skipped_ohlc_unavailable'),
      `${name} must NOT contain skipped_ohlc_unavailable (scope leak)`);
    assert.ok(!src.includes('H6 Phase 1 SILENT-LOSS FIX'),
      `${name} must NOT contain H6 Phase 1 comment (scope leak)`);
  }
});

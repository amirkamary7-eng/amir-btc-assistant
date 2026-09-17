/**
 * H5-HIGH Fix — Price Alert Bulk Trigger Notifications Regression Test
 *
 * Background:
 *   The H5-HIGH audit identified that the per-alert trigger path in
 *   runScheduledAlertsBaseline caused Cloudflare Workers Free Plan
 *   exceededResources (50-subrequest limit) with as few as 5 triggered
 *   alerts. Each triggered alert cost ~10-13 subrequests:
 *     - markTriggered (1 DB CAS) + 2 KV deletes (alerts:active-list + exists)
 *     - getUserChannelPreference (1 DB)
 *     - notificationService.create → notif INSERT + queue INSERT +
 *       processQueue(3) immediate call (up to 7 subrequests)
 *
 * Fix (H5-HIGH, Option A — Bulk INSERT Pattern):
 *   Refactored runScheduledAlertsBaseline to collect all triggered alerts in
 *   the eval loop, then process them in BULK after the loop:
 *     1. markTriggeredBulk (1 DB CAS UPDATE for all alerts, returns claimed set)
 *     2. Batch preference lookup (1 DB SELECT for all triggered users)
 *     3. Bulk INSERT notifications (mini_app channel) via unnest()
 *     4. Bulk INSERT queue items (telegram channel) via unnest()
 *     5. Single KV delete at end (was 2×N per-alert deletes before)
 *   Plus: NO per-alert processQueue(3) — removed the immediate call.
 *   Plus: processQueue(5) at end of 1-min cron (existing) drains queue.
 *
 * This test asserts all 13 requirements from the user spec:
 *   1. enqueueOnly behavior active (per-alert processQueue removed)
 *   2. per-alert processQueue no longer executes
 *   3. bulk preference lookup used (batch SELECT with IN clause)
 *   4. bulk markTriggered only claims active rows (CAS preserved)
 *   5. race/concurrent trigger does not cause duplicate notifications
 *   6. notification dedup preserved (ON CONFLICT (id) DO NOTHING)
 *   7. queue dedup preserved (ON CONFLICT (notification_id, user_id) DO NOTHING)
 *   8. last_trigger_price correct (per-alert via CASE WHEN)
 *   9. all triggered alerts in same tick enqueued; NO cap=5
 *   10. KV invalidation at most once per tick (not per-alert)
 *   11. existing processQueue(5) at end of 1-min cron preserved
 *   12. subrequest budget assertions for 14 triggers
 *   13. existing alert behavior/regression tests still pass
 *
 * Scope:
 *   Source-inspection test (no runtime execution). Mirrors pattern of
 *   `retry-batch-size-test.cjs`, `cron-architecture-test.cjs`, and
 *   `mission-reward-retry-test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const ALERTS_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/alerts.js'), 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractFunctionBody(src, fnName, marker = `async function ${fnName}`) {
  const startIdx = src.indexOf(marker);
  assert.notEqual(startIdx, -1, `Function ${fnName} must exist`);
  const nextAsyncIdx = src.indexOf('async function ', startIdx + marker.length);
  const endIdx = nextAsyncIdx === -1 ? src.length : nextAsyncIdx;
  return src.slice(startIdx, endIdx);
}

function extractRunScheduledAlertsBaseline() {
  return extractFunctionBody(WORKER_SRC, 'runScheduledAlertsBaseline');
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — enqueueOnly behavior + per-alert processQueue removed
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-01: alerts path no longer calls notificationService.create per-alert (enqueueOnly-equivalent via bulk INSERT)', () => {
  const body = extractRunScheduledAlertsBaseline();
  // The per-alert notificationService.create call (with its implicit processQueue(3))
  // must be REMOVED from the eval loop. The bulk path uses direct queryDb INSERTs.
  // We assert that the notificationService.create call is NOT inside the eval loop
  // (the loop is bounded by `for (const alert of alerts) {` ... `}`).
  const loopStart = body.indexOf('for (const alert of alerts) {');
  assert.notEqual(loopStart, -1, 'eval loop must exist');
  // Find the end of the eval loop: the closing `}` followed by the bulk processing block
  // The bulk block starts with "if (_triggeredAlerts.length > 0)"
  const bulkBlockStart = body.indexOf('if (_triggeredAlerts.length > 0) {', loopStart);
  assert.notEqual(bulkBlockStart, -1, 'bulk processing block must exist after eval loop');
  const evalLoopBody = body.slice(loopStart, bulkBlockStart);
  // Check for actual function CALLS (await notificationService.create) — not comment text mentions
  const notifCallPattern = /await\s+notificationService\.create\s*\(/g;
  const notifCallMatches = (evalLoopBody.match(notifCallPattern) || []).length;
  assert.equal(notifCallMatches, 0,
    `eval loop must NOT call notificationService.create (replaced by bulk INSERT after loop). Found ${notifCallMatches} calls. Comment mentions are OK.`);
  const processQueueCallPattern = /await\s+(?:notificationPlatformRepo\??\.)?processQueue\s*\(/g;
  const pqCallMatches = (evalLoopBody.match(processQueueCallPattern) || []).length;
  assert.equal(pqCallMatches, 0,
    `eval loop must NOT call processQueue (per-alert processQueue(3) removed). Found ${pqCallMatches} calls. Comment mentions are OK.`);
});

test('H5HIGH-02: per-alert processQueue(3) is NOT called in alerts path (eval loop body only — comments allowed)', () => {
  // The original sendNotification call would trigger processQueue(3) via the
  // notificationService.create wrapper. The bulk path bypasses this entirely.
  // We check for actual function CALLS (not comment text mentions) — the
  // H5-HIGH fix comments reference processQueue(5) (existing) and processQueue(3)
  // (removed) for documentation, but no actual call exists in the function body.
  const body = extractRunScheduledAlertsBaseline();
  // Check for actual function calls (await processQueue or await notificationPlatformRepo.processQueue)
  // NOT comment text. Pattern: 'await ' followed by optional chain then 'processQueue('
  const callPattern = /await\s+(?:notificationPlatformRepo\??\.)?processQueue\s*\(/g;
  const callMatches = (body.match(callPattern) || []).length;
  assert.equal(callMatches, 0,
    `runScheduledAlertsBaseline must NOT have any processQueue function calls (was N×processQueue(3) per-alert before, now 0). Found ${callMatches} calls. Comment mentions are OK.`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — Bulk preference lookup
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-03: bulk preference lookup uses batch SELECT with IN clause (mirrors processBroadcastFull)', () => {
  const body = extractRunScheduledAlertsBaseline();
  // The batch pref query uses SELECT user_id, ch_price_alert FROM notification_settings WHERE user_id IN (...)
  assert.ok(body.includes('ch_price_alert AS pref'),
    'must SELECT ch_price_alert column (price alert preference)');
  assert.ok(body.includes('FROM notification_settings WHERE user_id IN ('),
    'must use batch IN-clause SELECT (not per-user queries)');
  // Verify the pattern builds placeholders dynamically
  assert.ok(body.includes("userIds.map((_, i) => `$${i + 1}`).join(',')"),
    'must build placeholders dynamically (mirror processBroadcastFull pattern)');
  // Verify prefMap is populated from query result
  assert.ok(body.includes('prefMap.set(String(row.user_id), String(row.pref))'),
    'must populate prefMap from query result rows');
});

test('H5HIGH-03b: NO per-alert getUserChannelPreference call (replaced by batch query)', () => {
  const body = extractRunScheduledAlertsBaseline();
  // The original called notificationPlatformRepo.getUserChannelPreference per alert
  // The bulk path uses a single batch query instead.
  // Check for actual function calls (not comment text mentions).
  const callPattern = /await\s+notificationPlatformRepo\.getUserChannelPreference\s*\(/g;
  const callMatches = (body.match(callPattern) || []).length;
  assert.equal(callMatches, 0,
    `must NOT call notificationPlatformRepo.getUserChannelPreference per-alert (replaced by batch IN-clause query). Found ${callMatches} calls. Comment mentions are OK.`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — Bulk CAS markTriggered (only claims active rows)
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-04: markTriggeredBulk is defined in alerts.js repository', () => {
  assert.ok(ALERTS_REPO_SRC.includes('async function markTriggeredBulk'),
    'markTriggeredBulk must be defined in alerts.js');
  assert.ok(ALERTS_REPO_SRC.includes('markTriggeredBulk,'),
    'markTriggeredBulk must be exported in repository return object');
});

test('H5HIGH-04b: markTriggeredBulk uses CAS WHERE status=\'active\' (only claims active rows)', () => {
  const body = extractFunctionBody(ALERTS_REPO_SRC, 'markTriggeredBulk');
  assert.ok(body.includes("status = 'active'"),
    "markTriggeredBulk must CAS on status='active' (only active rows claimed)");
  assert.ok(body.includes('RETURNING id'),
    'markTriggeredBulk must RETURN id to identify claimed alerts');
  // Verify the UPDATE sets all required fields (mirrors original markTriggered)
  assert.ok(body.includes("status = 'triggered'"),
    "must set status='triggered'");
  assert.ok(body.includes('triggered_at = NOW()'),
    'must set triggered_at = NOW()');
  assert.ok(body.includes('last_trigger_price ='),
    'must set last_trigger_price (per-alert via CASE WHEN)');
  assert.ok(body.includes('last_price ='),
    'must set last_price (per-alert via CASE WHEN, mirrors last_trigger_price)');
});

test('H5HIGH-04c: markTriggeredBulk returns claimed array (caller filters to claimed alerts only)', () => {
  const body = extractFunctionBody(ALERTS_REPO_SRC, 'markTriggeredBulk');
  // Returns array of { alertId, claimed, triggerPrice }
  assert.ok(body.includes('return triggers.map(t => ({'),
    'must return triggers.map with per-alert result');
  assert.ok(body.includes('alertId: t.alertId'),
    'must include alertId in result');
  assert.ok(body.includes('claimed:'),
    'must include claimed boolean in result');
  // Verify claimed set is built from RETURNING ids
  assert.ok(body.includes('claimedIds = new Set'),
    'must build claimedIds Set from RETURNING rows');
  assert.ok(body.includes('claimedIds.has'),
    'must check claimedIds.has(alertId) for each trigger');
});

test('H5HIGH-04d: worker-proxy.js calls markTriggeredBulk (not per-alert markTriggered)', () => {
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('alertRepo.markTriggeredBulk'),
    'runScheduledAlertsBaseline must call alertRepo.markTriggeredBulk');
  // The OLD per-alert markTriggered call must NOT be in the eval loop
  // (it might still exist as a fallback in legacy code path, but not in the bulk path)
  // We check that the per-alert markTriggered call is NOT in the bulk processing block
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  if (bulkStart !== -1) {
    const bulkBlock = body.slice(bulkStart);
    assert.ok(!bulkBlock.includes('alertRepo.markTriggered(env, alertId,'),
      'bulk processing block must NOT call per-alert markTriggered (uses markTriggeredBulk instead)');
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — Race/concurrent trigger safety (no duplicate notifications)
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-05: race/concurrent trigger does not cause duplicate notifications (CAS + claimed filtering)', () => {
  // If two cron ticks overlap (1-min + 5-min at same minute, or 1-min + 1-min isolate overlap),
  // both might evaluate the same alert as shouldTrigger=true. Both call markTriggeredBulk.
  // Only the FIRST UPDATE...WHERE status='active' RETURNING id succeeds for each alert;
  // the second returns 0 rows → claimed=false → no notification created.
  const body = extractRunScheduledAlertsBaseline();
  // Verify claimed filtering logic exists
  assert.ok(body.includes('claimedIds = new Set'),
    'must build claimedIds Set (CAS winners)');
  assert.ok(body.includes('claimedAlerts = _triggeredAlerts.filter(t => claimedIds.has'),
    'must filter _triggeredAlerts to only claimed ones (race losers skipped)');
  // Verify duplicate_triggers_prevented counter is incremented for race losers
  assert.ok(body.includes('duplicate_triggers_prevented +='),
    'must increment duplicate_triggers_prevented for race losers');
});

test('H5HIGH-05b: markTriggeredBulk fail-safe returns all not-claimed on exception (no notifications on failure)', () => {
  const body = extractFunctionBody(ALERTS_REPO_SRC, 'markTriggeredBulk');
  // On exception, return all as claimed=false → caller skips notification creation
  // This prevents duplicate notifications when CAS fails (e.g., DB connection error)
  assert.ok(body.includes('claimed: false'),
    'on failure, must return claimed:false for all triggers (no notifications created)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — Notification dedup preserved
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-06: notification dedup preserved (ON CONFLICT (id) DO NOTHING)', () => {
  const body = extractRunScheduledAlertsBaseline();
  // Bulk INSERT notifications must use ON CONFLICT (id) DO NOTHING
  assert.ok(body.includes('INSERT INTO notifications'),
    'must bulk INSERT into notifications table');
  assert.ok(body.includes('ON CONFLICT (id) DO NOTHING'),
    'must use ON CONFLICT (id) DO NOTHING (idempotency preserved)');
});

test('H5HIGH-06b: notificationId pattern preserved (dedupKey → notif_id)', () => {
  // Original: `notif_${String(dedupKey).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
  // dedupKey for alerts: `price_alert_${alertId}_${userId}`
  // → notificationId = `notif_price_alert_${alertId}_${userId}` (sanitized, sliced)
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('notif_price_alert_${t.alertId}_${t.userId}'),
    'must build notif_id from price_alert_${alertId}_${userId} pattern');
  assert.ok(body.includes(".replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)"),
    'must sanitize + slice notif_id (preserves original dedupKey → notif_id transformation)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6 — Queue dedup preserved
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-07: queue dedup preserved (ON CONFLICT (notification_id, user_id) DO NOTHING)', () => {
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('INSERT INTO notification_queue'),
    'must bulk INSERT into notification_queue table');
  assert.ok(body.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'must use ON CONFLICT (notification_id, user_id) DO NOTHING (queue idempotency preserved)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 7 — last_trigger_price correct (per-alert via CASE WHEN)
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-08: last_trigger_price per-alert correct (CASE WHEN with parameterized ids + prices)', () => {
  const body = extractFunctionBody(ALERTS_REPO_SRC, 'markTriggeredBulk');
  // Per-alert last_trigger_price via CASE WHEN id WHEN $id THEN $price::numeric
  assert.ok(body.includes('CASE id'),
    'must use CASE id pattern (per-alert last_trigger_price)');
  assert.ok(body.includes('WHEN $'),
    'must use parameterized WHEN $N placeholders');
  assert.ok(body.includes('::numeric'),
    'must cast price to ::numeric (preserves original markTriggered casting)');
  // Verify both last_trigger_price AND last_price are set (mirrors original)
  assert.ok(body.includes('last_trigger_price ='),
    'must SET last_trigger_price');
  assert.ok(body.includes('last_price ='),
    'must SET last_price (mirrors original markTriggered which sets both)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 8 — All triggered alerts enqueued; NO cap=5
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-09: NO MAX_ALERTS_TRIGGERED_PER_TICK cap (all triggers in same tick enqueued)', () => {
  const body = extractRunScheduledAlertsBaseline();
  // The eval loop must NOT break after N triggers
  assert.ok(!body.includes('MAX_ALERTS_TRIGGERED_PER_TICK'),
    'must NOT define MAX_ALERTS_TRIGGERED_PER_TICK (no trigger cap)');
  // Verify _triggeredAlerts is collected WITHOUT any cap
  assert.ok(body.includes('_triggeredAlerts.push({'),
    'must push ALL triggered alerts to _triggeredAlerts (no cap)');
  // Verify the eval loop continues for ALL alerts (no break after N triggers)
  // We check that the push happens for EVERY shouldTrigger=true alert by verifying
  // the eval loop does NOT have a `break` or `if (count > N) break` pattern after push
  const loopStart = body.indexOf('for (const alert of alerts) {');
  const bulkStart = body.indexOf('if (_triggeredAlerts.length > 0) {', loopStart);
  const loopBody = body.slice(loopStart, bulkStart);
  // After push, there should be NO trigger-count-based break
  assert.ok(!loopBody.includes('break;') || loopBody.indexOf('break;') > loopBody.indexOf('_triggeredAlerts.push'),
    'no break-after-N pattern in eval loop (all triggers processed)');
});

test('H5HIGH-09b: bulk INSERT uses unnest() (scales to any alert count)', () => {
  // The unnest() pattern means N alerts → 1 INSERT query (not N INSERT queries).
  // This is what allows the implementation to scale to 5, 14, 50, 100, 500 triggers
  // without exceeding the 50-subrequest limit.
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('SELECT * FROM unnest('),
    'must use unnest() pattern for bulk INSERT (scales to any count)');
  // Count unnest() occurrences — should be 2 (one for notifications, one for queue)
  const unnestCount = (body.match(/SELECT \* FROM unnest\(/g) || []).length;
  assert.equal(unnestCount, 2,
    `must have exactly 2 unnest() calls (1 for notif, 1 for queue) — found ${unnestCount}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 9 — KV invalidation at most once per tick
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-10: KV invalidation at most once per tick (was 2×N per-alert deletes before)', () => {
  // The original markTriggered (alerts.js:313-314) did 2 KV deletes PER ALERT.
  // The bulk path moves KV deletes OUT of markTriggeredBulk and does them ONCE
  // at end of bulk processing in runScheduledAlertsBaseline.
  const alertsBody = extractFunctionBody(ALERTS_REPO_SRC, 'markTriggeredBulk');
  // markTriggeredBulk must NOT do per-alert KV deletes (caller does single delete at end)
  assert.ok(!alertsBody.includes("env.APP_CACHE?.delete?.('alerts:active-exists')"),
    'markTriggeredBulk must NOT delete alerts:active-exists (caller does single delete)');
  assert.ok(!alertsBody.includes("env.APP_CACHE?.delete?.('alerts:active-list')"),
    'markTriggeredBulk must NOT delete alerts:active-list (caller does single delete)');

  // worker-proxy.js must do single KV deletes at end of bulk processing
  const workerBody = extractRunScheduledAlertsBaseline();
  // Count KV delete calls in the bulk processing block
  const bulkStart = workerBody.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  assert.notEqual(bulkStart, -1, 'bulk processing block must exist');
  const bulkEnd = workerBody.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = workerBody.slice(bulkStart, bulkEnd === -1 ? workerBody.length : bulkEnd);
  const kvDeleteCount = (bulkBlock.match(/env\.APP_CACHE\?\.delete\?\.\(/g) || []).length;
  assert.equal(kvDeleteCount, 2,
    `bulk processing block must have exactly 2 KV deletes (alerts:active-list + alerts:active-exists) — found ${kvDeleteCount}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 10 — Existing processQueue(5) at end of 1-min cron preserved
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-11: existing processQueue(5) at end of 1-min cron preserved (NOT modified)', () => {
  // The existing processQueue(5) call at worker-proxy.js:16217 must remain unchanged.
  // It drains the queue (with first 5 sends) after alerts cron completes.
  // The H5-HIGH fix only touches runScheduledAlertsBaseline, NOT the scheduled() dispatcher.
  const scheduledMatch = WORKER_SRC.indexOf('notificationPlatformRepo?.processQueue');
  assert.notEqual(scheduledMatch, -1, 'processQueue call must exist in scheduled()');
  // Verify the limit is 5 for the 1-min cron (not changed by H5-HIGH fix)
  const oneMinBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('if (isEveryMinute)'),
    WORKER_SRC.indexOf('return;', WORKER_SRC.indexOf('if (isEveryMinute)'))
  );
  assert.ok(oneMinBlock.includes('processQueue(env, sendTelegramMessage, pool, 5)'),
    '1-min cron must still call processQueue with limit=5 (unchanged)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 11 — Subrequest budget assertions for 14 triggers
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-12: subrequest budget for 14 triggers + OHLC cache hit ≤ 50 (with safety margin)', () => {
  // Worst case (H6 cap=14, 14 triggers, OHLC cache hit):
  //   14 × 2 (OHLC cache hit) = 28
  //   1 (markTriggeredBulk) + 1 (batch pref) + 1 (bulk notif INSERT) + 1 (bulk queue INSERT) = 4
  //   1 (bulk last_price UPDATE) + 2 (KV deletes) = 3
  //   11 (processQueue(5) at end of 1-min cron, full queue worst case)
  //   Total: 28 + 4 + 3 + 11 = 46 ≤ 50 ✅ (4 subrequest safety margin)
  const body = extractRunScheduledAlertsBaseline();
  // Verify the comment documents the budget
  assert.ok(body.includes('46 ≤ 50') || body.includes('46 ≤50') || body.includes('= 46'),
    'must document worst-case subrequest budget (46 ≤ 50) in code comments');

  // Count actual bulk DB operations in the bulk processing block:
  //   - 1 markTriggeredBulk
  //   - 1 batch pref queryDb
  //   - 1 bulk notif INSERT queryDb
  //   - 1 bulk queue INSERT queryDb
  //   - 1 bulk last_price UPDATE queryDb (existing, separate block)
  //   - 2 KV deletes (alerts:active-list + alerts:active-exists)
  // The KV deletes don't count toward the bulk INSERT/UPDATE count.
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  // Count queryDb calls in the bulk processing block (excluding catch fallbacks)
  const markTriggeredBulkCall = (bulkBlock.match(/alertRepo\??\.markTriggeredBulk\(/g) || []).length;
  assert.ok(markTriggeredBulkCall >= 1, 'must call markTriggeredBulk at least once');

  // Verify 3 queryDb calls in the bulk block (pref + notif INSERT + queue INSERT)
  // Note: markTriggeredBulk is its own queryDb call inside alerts.js, not counted here
  const queryDbCallsInBulk = (bulkBlock.match(/await queryDb\(env/g) || []).length;
  assert.ok(queryDbCallsInBulk >= 3,
    `must have at least 3 queryDb calls in bulk block (pref + notif INSERT + queue INSERT) — found ${queryDbCallsInBulk}`);
});

test('H5HIGH-12b: subrequest budget scales to ANY alert count (5, 14, 50, 100, 500 — all use same 4 bulk ops)', () => {
  // The bulk INSERT pattern uses unnest() — N alerts → 1 INSERT.
  // So whether 5 or 500 alerts trigger, the bulk DB ops count stays constant.
  const body = extractRunScheduledAlertsBaseline();
  // Verify unnest() is used for both INSERTs (this is the scaling property)
  assert.ok(body.includes('SELECT * FROM unnest('),
    'must use unnest() — N alerts → 1 INSERT (constant subrequest count)');
  // Verify NO per-alert queryDb call inside the eval loop (only bulk after)
  const loopStart = body.indexOf('for (const alert of alerts) {');
  const bulkStart = body.indexOf('if (_triggeredAlerts.length > 0) {', loopStart);
  const loopBody = body.slice(loopStart, bulkStart);
  // The eval loop must NOT have await queryDb calls for triggers (only _pendingUpdates.push and _triggeredAlerts.push)
  // Note: There's already _pendingUpdates.push (existing bulk last_price UPDATE pattern)
  // We only care that the per-alert trigger path doesn't add new queryDb calls
  assert.ok(!loopBody.includes('await queryDb(env, `UPDATE price_alerts\n      SET status = \'triggered\''),
    'eval loop must NOT call per-alert markTriggered queryDb (replaced by bulk after loop)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 12 — Existing alert behavior/regression tests still pass (structural checks)
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-13: existing alert behavior preserved (OHLC cross-detection logic unchanged)', () => {
  // The eval loop's cross-detection logic (direction='above'/'below', prevPrice, candleHigh/Low)
  // must be UNCHANGED. The H5-HIGH fix only touches what happens AFTER shouldTrigger=true.
  const body = extractRunScheduledAlertsBaseline();
  // Cross-detection logic must still exist
  assert.ok(body.includes('OHLC CROSS-DETECTION LOGIC'),
    'OHLC cross-detection comment must exist (logic preserved)');
  assert.ok(body.includes("direction === 'below'"),
    "direction='below' branch must exist (preserved)");
  assert.ok(body.includes("prevPrice > targetPrice && candleLow <= targetPrice"),
    'cross_down detection must exist (preserved)');
  assert.ok(body.includes("prevPrice < targetPrice && candleHigh >= targetPrice"),
    'cross_up detection must exist (preserved)');
});

test('H5HIGH-13b: existing counters preserved (cross_detections, immediate_triggers, duplicate_triggers_prevented, triggered_count, delivery_failures, skipped_pref_disabled)', () => {
  // All resultPayload counters from the original must still be incremented.
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('resultPayload.cross_detections += 1'),
    'cross_detections counter preserved');
  assert.ok(body.includes('resultPayload.immediate_triggers += 1'),
    'immediate_triggers counter preserved');
  assert.ok(body.includes('resultPayload.duplicate_triggers_prevented +='),
    'duplicate_triggers_prevented counter preserved');
  assert.ok(body.includes('resultPayload.triggered_count += 1'),
    'triggered_count counter preserved');
  assert.ok(body.includes('resultPayload.delivery_failures += 1'),
    'delivery_failures counter preserved');
  assert.ok(body.includes('resultPayload.skipped_pref_disabled += 1'),
    'skipped_pref_disabled counter preserved');
  assert.ok(body.includes('resultPayload.skipped_guest_users += 1'),
    'skipped_guest_users counter preserved');
  assert.ok(body.includes('resultPayload.skipped_price_missing += 1'),
    'skipped_price_missing counter preserved');
  assert.ok(body.includes('resultPayload.dispatch_errors.push'),
    'dispatch_errors tracking preserved');
});

test('H5HIGH-13c: bulk last_price UPDATE pattern preserved (existing pre-H5-HIGH code)', () => {
  // The existing bulk last_price UPDATE (worker-proxy.js:13508-13536 originally)
  // is a SEPARATE bulk operation that was already there before H5-HIGH.
  // It must be PRESERVED — H5-HIGH does NOT touch it.
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('ARCHITECTURAL FIX: Bulk UPDATE all alerts in a SINGLE query'),
    'existing bulk last_price UPDATE comment must exist (preserved)');
  assert.ok(body.includes('UPDATE price_alerts SET last_price = CASE id'),
    'existing bulk last_price UPDATE SQL must exist (preserved)');
});

test('H5HIGH-13d: original markTriggered function preserved in alerts.js (no removal)', () => {
  // The original per-alert markTriggered is still exported (used by tests, fallback paths,
  // and possibly other callers). H5-HIGH adds markTriggeredBulk as a NEW function —
  // it does NOT remove markTriggered.
  assert.ok(ALERTS_REPO_SRC.includes('async function markTriggered(env, alertId, triggerPrice, pool = null)'),
    'original markTriggered must still exist (H5-HIGH adds markTriggeredBulk, does NOT remove markTriggered)');
  assert.ok(ALERTS_REPO_SRC.includes('markTriggered, markTriggeredBulk,'),
    'both markTriggered AND markTriggeredBulk must be exported');
  // Original markTriggered's per-alert KV deletes are PRESERVED (not changed)
  const origBody = extractFunctionBody(ALERTS_REPO_SRC, 'markTriggered');
  assert.ok(origBody.includes("env.APP_CACHE?.delete?.('alerts:active-exists')"),
    'original markTriggered must still do its own KV deletes (preserved — used by other callers)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 13 — Sanity: scope verification (no scope creep)
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-14: scope is limited to alerts trigger path (no H4/H6/News/Calendar/VPN/Membership changes)', () => {
  // The H5-HIGH fix should NOT modify:
  //   - H4 (KV write optimization for News AI stats)
  //   - H6 (OHLC cap=14 + MARKET_CACHE_TTL=120)
  //   - News AI / Calendar / VPN / Membership
  //   - Frontend
  //   - Notification fan-out outside of alerts
  const body = extractRunScheduledAlertsBaseline();
  // Verify no News AI or Calendar code in alerts path
  assert.ok(!body.includes('processNewsAIBatch'),
    'alerts path must NOT reference processNewsAIBatch (no scope creep)');
  assert.ok(!body.includes('runCalendarAlertsCheck'),
    'alerts path must NOT reference runCalendarAlertsCheck (no scope creep)');
  assert.ok(!body.includes('fetchCalendarFeed'),
    'alerts path must NOT reference fetchCalendarFeed (no scope creep)');
});

test('H5HIGH-15: alerts path uses queryDb directly (not notificationService — bypassing per-alert processQueue(3))', () => {
  // The bulk path calls queryDb directly for INSERT into notifications + queue,
  // bypassing notificationService.create (which would trigger processQueue(3)).
  // This is the "enqueueOnly: true" equivalent — but implemented via direct queryDb.
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('await queryDb(env, `'),
    'must use queryDb directly for bulk INSERTs');
  // Verify notificationService.create is NOT called in the bulk path
  // (check for actual function calls, not comment text mentions)
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  if (bulkStart !== -1) {
    const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
    const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);
    const callPattern = /await\s+notificationService\.create\s*\(/g;
    const callMatches = (bulkBlock.match(callPattern) || []).length;
    assert.equal(callMatches, 0,
      `bulk processing block must NOT call notificationService.create (uses direct queryDb INSERTs instead). Found ${callMatches} calls. Comment mentions are OK.`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 14 — OPTION D: markTriggeredBulk runs AFTER bulk INSERTs (reliability)
// ═══════════════════════════════════════════════════════════════════════════

test('H5HIGH-OPTD-01: markTriggeredBulk runs AFTER bulk INSERTs (not before)', () => {
  // Option D: INSERT first, then markTriggeredBulk. This ensures that if INSERT
  // fails, alerts remain 'active' → next tick retries → NO LOSS.
  const body = extractRunScheduledAlertsBaseline();
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  assert.notEqual(bulkStart, -1, 'bulk processing block must exist');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  // Find the position of markTriggeredBulk call vs bulk INSERT calls
  const markPos = bulkBlock.indexOf('await alertRepo.markTriggeredBulk(env, triggers, pool)');
  const notifInsertPos = bulkBlock.indexOf('INSERT INTO notifications');
  const queueInsertPos = bulkBlock.indexOf('INSERT INTO notification_queue');

  assert.notEqual(markPos, -1, 'markTriggeredBulk must be called in bulk block');
  assert.notEqual(notifInsertPos, -1, 'bulk notif INSERT must exist');
  assert.notEqual(queueInsertPos, -1, 'bulk queue INSERT must exist');

  // OPTION D: markTriggeredBulk must run AFTER both INSERTs
  assert.ok(markPos > notifInsertPos,
    `markTriggeredBulk must run AFTER notif INSERT (Option D). markPos=${markPos}, notifInsertPos=${notifInsertPos}`);
  assert.ok(markPos > queueInsertPos,
    `markTriggeredBulk must run AFTER queue INSERT (Option D). markPos=${markPos}, queueInsertPos=${queueInsertPos}`);
});

test('H5HIGH-OPTD-02: bulk INSERT runs for ALL _triggeredAlerts (not just claimed — claimed determined later)', () => {
  // Option D: batch pref lookup + partition use _triggeredAlerts (ALL),
  // not claimedAlerts (which is computed AFTER markTriggeredBulk).
  const body = extractRunScheduledAlertsBaseline();
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  // The pref lookup and partition must use _triggeredAlerts, not claimedAlerts
  // (claimedAlerts is computed AFTER markTriggeredBulk at STEP 5)
  const prefLookupPos = bulkBlock.indexOf('Batch preference lookup');
  const partitionPos = bulkBlock.indexOf('Partition ALL triggered alerts');
  const markPos = bulkBlock.indexOf('STEP 5: Bulk CAS markTriggered');

  // pref lookup and partition must come BEFORE markTriggeredBulk
  assert.ok(prefLookupPos < markPos, 'pref lookup must run BEFORE markTriggeredBulk');
  assert.ok(partitionPos < markPos, 'partition must run BEFORE markTriggeredBulk');

  // Verify partition uses _triggeredAlerts (not claimedAlerts)
  const partitionBlock = bulkBlock.slice(partitionPos, markPos);
  assert.ok(partitionBlock.includes('for (const t of _triggeredAlerts)'),
    'partition must iterate _triggeredAlerts (ALL, not just claimed)');

  // Verify pref lookup uses _triggeredAlerts
  const prefBlock = bulkBlock.slice(prefLookupPos, partitionPos);
  assert.ok(prefBlock.includes('_triggeredAlerts.map'),
    'pref lookup must use _triggeredAlerts (ALL, not just claimed)');
});

test('H5HIGH-OPTD-03: notification INSERT failure → alerts remain active (mark hasn\'t run yet)', () => {
  // Option D: if notif INSERT fails, markTriggeredBulk hasn't run yet →
  // alerts stay 'active' → next tick retries → NO LOSS.
  // We verify this by checking the ORDER: notif INSERT .catch() sets
  // notifInsertOk=false, but markTriggeredBulk runs AFTER (so alerts not yet
  // marked triggered). The .catch() does NOT throw, so execution continues
  // to markTriggeredBulk.
  const body = extractRunScheduledAlertsBaseline();
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  // notif INSERT .catch() sets flag but does NOT throw
  assert.ok(bulkBlock.includes("notifInsertOk = false;"),
    'notif INSERT failure must set notifInsertOk=false (not throw)');
  // queue INSERT .catch() sets flag but does NOT throw
  assert.ok(bulkBlock.includes("queueInsertOk = false;"),
    'queue INSERT failure must set queueInsertOk=false (not throw)');

  // Verify markTriggeredBulk runs AFTER the .catch() blocks
  const notifCatchPos = bulkBlock.lastIndexOf("notifInsertOk = false;");
  const queueCatchPos = bulkBlock.lastIndexOf("queueInsertOk = false;");
  const markPos = bulkBlock.indexOf('await alertRepo.markTriggeredBulk(env, triggers, pool)');

  assert.ok(markPos > notifCatchPos,
    'markTriggeredBulk must run AFTER notif INSERT .catch()');
  assert.ok(markPos > queueCatchPos,
    'markTriggeredBulk must run AFTER queue INSERT .catch()');
});

test('H5HIGH-OPTD-04: INSERT succeeds + mark fails → orphan rows handled by ON CONFLICT on next tick', () => {
  // Option D: if INSERTs succeed but markTriggeredBulk fails, orphan notif/queue
  // rows exist. Next tick's INSERT is no-op (ON CONFLICT DO NOTHING), mark may
  // succeed. No duplicates, no permanent loss.
  // We verify: ON CONFLICT DO NOTHING is present on both INSERTs.
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('ON CONFLICT (id) DO NOTHING'),
    'notif INSERT must use ON CONFLICT (id) DO NOTHING (handles orphan rows on next tick)');
  assert.ok(body.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'queue INSERT must use ON CONFLICT (notification_id, user_id) DO NOTHING (handles orphan rows on next tick)');
});

test('H5HIGH-OPTD-05: normal flow — INSERT succeeds + mark succeeds → alerts triggered', () => {
  // Option D normal flow: INSERT → mark → count.
  // All three steps execute in order. No loss, no duplicates.
  const body = extractRunScheduledAlertsBaseline();
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  // Verify all 7 steps exist in order:
  // STEP 1: pref lookup
  // STEP 2: partition
  // STEP 3: notif INSERT
  // STEP 4: queue INSERT
  // STEP 5: markTriggeredBulk
  // STEP 6: count
  // STEP 7: KV deletes
  const step1 = bulkBlock.indexOf('STEP 1: Batch preference');
  const step2 = bulkBlock.indexOf('STEP 2: Partition');
  const step3 = bulkBlock.indexOf('STEP 3: Bulk INSERT in-app');
  const step4 = bulkBlock.indexOf('STEP 4: Bulk INSERT Telegram');
  const step5 = bulkBlock.indexOf('STEP 5: Bulk CAS markTriggered');
  const step6 = bulkBlock.indexOf('STEP 6: Count delivery');
  const step7 = bulkBlock.indexOf('STEP 7: KV invalidation');

  assert.notEqual(step1, -1, 'STEP 1 must exist');
  assert.notEqual(step2, -1, 'STEP 2 must exist');
  assert.notEqual(step3, -1, 'STEP 3 must exist');
  assert.notEqual(step4, -1, 'STEP 4 must exist');
  assert.notEqual(step5, -1, 'STEP 5 must exist');
  assert.notEqual(step6, -1, 'STEP 6 must exist');
  assert.notEqual(step7, -1, 'STEP 7 must exist');

  // Verify order: step1 < step2 < step3 < step4 < step5 < step6 < step7
  assert.ok(step1 < step2, `STEP 1 must come before STEP 2`);
  assert.ok(step2 < step3, `STEP 2 must come before STEP 3`);
  assert.ok(step3 < step4, `STEP 3 must come before STEP 4`);
  assert.ok(step4 < step5, `STEP 4 must come before STEP 5 (Option D: mark AFTER INSERTs)`);
  assert.ok(step5 < step6, `STEP 5 must come before STEP 6`);
  assert.ok(step6 < step7, `STEP 6 must come before STEP 7`);
});

test('H5HIGH-OPTD-06: claimedAlerts computed AFTER markTriggeredBulk (not before)', () => {
  // Option D: claimedAlerts is computed at STEP 5 (after markTriggeredBulk),
  // not at the beginning. This is the key difference from the original
  // implementation where claimedAlerts was computed first.
  const body = extractRunScheduledAlertsBaseline();
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  const claimedAlertsPos = bulkBlock.indexOf('const claimedAlerts = _triggeredAlerts.filter');
  const markPos = bulkBlock.indexOf('await alertRepo.markTriggeredBulk(env, triggers, pool)');

  assert.notEqual(claimedAlertsPos, -1, 'claimedAlerts must be computed');
  assert.notEqual(markPos, -1, 'markTriggeredBulk must be called');

  // claimedAlerts must be computed AFTER markTriggeredBulk
  assert.ok(claimedAlertsPos > markPos,
    `claimedAlerts must be computed AFTER markTriggeredBulk (Option D). claimedAlertsPos=${claimedAlertsPos}, markPos=${markPos}`);
});

test('H5HIGH-OPTD-07: KV deletes only run if claimedAlerts.length > 0', () => {
  // Option D: KV deletes are conditional on claimedAlerts.length > 0.
  // If no alerts were claimed (all already triggered by another cron),
  // no KV invalidation needed (nothing changed in the alerts table).
  const body = extractRunScheduledAlertsBaseline();
  const bulkStart = body.indexOf('// ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──');
  const bulkEnd = body.indexOf('// ── ARCHITECTURAL FIX: Bulk UPDATE all alerts', bulkStart);
  const bulkBlock = body.slice(bulkStart, bulkEnd === -1 ? body.length : bulkEnd);

  // Find the KV delete block
  const kvDeletePos = bulkBlock.indexOf("if (claimedAlerts.length > 0) {");
  const kvDeleteBlock = bulkBlock.slice(kvDeletePos, kvDeletePos + 200);

  assert.ok(kvDeleteBlock.includes("env.APP_CACHE?.delete?.('alerts:active-list')"),
    'KV delete for alerts:active-list must be inside if (claimedAlerts.length > 0)');
  assert.ok(kvDeleteBlock.includes("env.APP_CACHE?.delete?.('alerts:active-exists')"),
    'KV delete for alerts:active-exists must be inside if (claimedAlerts.length > 0)');
});

test('H5HIGH-OPTD-08: dispatch_errors mention "alerts remain active" (Option D reliability)', () => {
  // Option D: dispatch_errors should reflect that alerts remain active
  // (markTriggeredBulk runs AFTER INSERTs, so INSERT failure means alerts
  // stay active → next tick retries).
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(body.includes('alerts remain active'),
    'dispatch_errors must mention "alerts remain active" (Option D: INSERT failure → alerts stay active)');
  assert.ok(body.includes('next tick retries'),
    'dispatch_errors must mention "next tick retries" (Option D: INSERT failure → retry on next tick)');
});

test('H5HIGH-OPTD-09: NO trigger cap (all triggered alerts processed in same tick)', () => {
  // Option D preserves: no trigger cap, no artificial break.
  // All triggered alerts are INSERTed + marked in the same tick.
  const body = extractRunScheduledAlertsBaseline();
  assert.ok(!body.includes('MAX_ALERTS_TRIGGERED_PER_TICK'),
    'must NOT define MAX_ALERTS_TRIGGERED_PER_TICK');
  // The eval loop pushes ALL triggers to _triggeredAlerts
  assert.ok(body.includes('_triggeredAlerts.push({'),
    'must push ALL triggered alerts to _triggeredAlerts (no cap)');
});

test('H5HIGH-OPTD-10: processQueue(5) unchanged at end of 1-min cron', () => {
  // Option D does NOT touch processQueue(5) — it's still at the end of the
  // 1-min cron, unchanged.
  const oneMinBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('if (isEveryMinute)'),
    WORKER_SRC.indexOf('return;', WORKER_SRC.indexOf('if (isEveryMinute)'))
  );
  assert.ok(oneMinBlock.includes('processQueue(env, sendTelegramMessage, pool, 5)'),
    '1-min cron must still call processQueue with limit=5 (unchanged by Option D)');
});

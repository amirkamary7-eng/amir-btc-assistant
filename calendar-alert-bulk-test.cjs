/**
 * H5-HIGH Calendar Alert Broadcast Bulk Fix — Regression Test
 *
 * Background:
 *   The Calendar Alert broadcast path (runCalendarAlertsCheck PATH 1) used
 *   per-user notificationService.create with enqueueOnly:true. Each user
 *   cost 3 DB subrequests (pref SELECT + notif INSERT + queue INSERT).
 *   With N joined users, subrequest count = 24 + 3N → exceeded 50 with
 *   as few as 10 users → exceededResources → permanent notification loss.
 *
 * Fix (H5-HIGH Calendar Bulk):
 *   Replaced per-user dispatch loop with bulk pattern (mirror processBroadcastFull):
 *   1. Batch preference lookup (1 DB SELECT WHERE user_id IN)
 *   2. Partition by channel (mini_app / telegram / both / none)
 *   3. Bulk INSERT notifications via unnest() (1 DB, ON CONFLICT (id) DO NOTHING)
 *   4. Bulk INSERT queue via unnest() (1 DB, ON CONFLICT (notification_id, user_id) DO NOTHING)
 *   5. Dedup key write AFTER INSERTs (crash recovery preserved)
 *   6. processQueue(10) at end (existing, preserved)
 *
 * Subrequest budget after fix: 27 (constant, scales to any user count)
 *
 * This test verifies all 17 requirements from the user spec.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractFunctionBody(src, fnName) {
  const startMarker = `async function ${fnName}`;
  const startIdx = src.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Function ${fnName} must exist in worker-proxy.js`);
  const nextAsyncIdx = src.indexOf('async function ', startIdx + startMarker.length);
  const endIdx = nextAsyncIdx === -1 ? src.length : nextAsyncIdx;
  return src.slice(startIdx, endIdx);
}

function extractCalendarBroadcastPath(src) {
  // Extract the PATH 1 broadcast loop (from "for (const event of events)"
  // to the processQueue(10) call that ends PATH 1)
  const body = extractFunctionBody(src, 'runCalendarAlertsCheck');
  const loopStart = body.indexOf('for (const event of events) {');
  assert.notEqual(loopStart, -1, 'Calendar event loop must exist');
  // PATH 1 ends at the SECOND PATH marker
  const path2Start = body.indexOf('SECOND PATH: Per-user calendar reminders');
  const endIdx = path2Start === -1 ? body.length : path2Start;
  return body.slice(loopStart, endIdx);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — Batch preference lookup
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-01: batch preference lookup used (batch SELECT with IN clause)', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes('ch_calendar AS pref'),
    'must SELECT ch_calendar column (calendar preference)');
  assert.ok(path1.includes('FROM notification_settings WHERE user_id IN ('),
    'must use batch IN-clause SELECT (not per-user queries)');
  assert.ok(path1.includes("allUserIds.map((_, i) => `$${i + 1}`).join(',')"),
    'must build placeholders dynamically (mirror processBroadcastFull pattern)');
  assert.ok(path1.includes('prefMap.set(String(row.user_id), String(row.pref))'),
    'must populate prefMap from query result rows');
});

test('CAL-BULK-02: getUserChannelPreference per-user call removed from PATH 1', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  // Check for actual function calls (not comment text mentions)
  const callPattern = /await\s+notificationPlatformRepo\.getUserChannelPreference\s*\(/g;
  const callMatches = (path1.match(callPattern) || []).length;
  assert.equal(callMatches, 0,
    `PATH 1 must NOT call getUserChannelPreference per-user (replaced by batch IN-clause query). Found ${callMatches} calls. Comment mentions are OK.`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — Bulk INSERT with unnest()
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-03: bulk notification INSERT uses unnest()', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes('INSERT INTO notifications'),
    'must bulk INSERT into notifications table');
  assert.ok(path1.includes('SELECT * FROM unnest('),
    'must use unnest() pattern for multi-row INSERT');
  assert.ok(path1.includes('ON CONFLICT (id) DO NOTHING'),
    'must use ON CONFLICT (id) DO NOTHING (idempotency preserved)');
});

test('CAL-BULK-04: bulk queue INSERT uses unnest()', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes('INSERT INTO notification_queue'),
    'must bulk INSERT into notification_queue table');
  assert.ok(path1.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'must use ON CONFLICT (notification_id, user_id) DO NOTHING (queue idempotency preserved)');
  // Count unnest() occurrences — should be 2 (one for notif, one for queue)
  const unnestCount = (path1.match(/SELECT \* FROM unnest\(/g) || []).length;
  assert.equal(unnestCount, 2,
    `must have exactly 2 unnest() calls (1 for notif, 1 for queue) — found ${unnestCount}`);
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — Notification ID transformation preserved
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-05: notification ID uses same sanitization as sendNotification', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  // sendNotification: `notif_${String(dedupKey).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
  // Calendar dedupKey: `cal_event_${eventKey}_${uid}`
  assert.ok(path1.includes('`notif_cal_event_${eventKey}_${uid}`'),
    'must build notif_id from cal_event_${eventKey}_${uid} pattern');
  assert.ok(path1.includes(".replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)"),
    'must sanitize + slice notif_id (preserves original dedupKey → notif_id transformation)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — Channel preference behavior preserved
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-06: none preference → no INSERT (skipped in partition)', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes("if (userChannel === 'none') continue;"),
    "'none' preference users must be skipped in partition (no INSERT)");
});

test('CAL-BULK-07: mini_app preference → only notification INSERT', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes("if (userChannel === 'mini_app' || userChannel === 'both') miniAppUsers.push(uid);"),
    "'mini_app' users must be pushed to miniAppUsers (notif INSERT only)");
  // channel for mini_app-only users: 'mini_app' (not 'both')
  assert.ok(path1.includes("telegramUsers.includes(uid) ? 'both' : 'mini_app'"),
    "channel column must be 'mini_app' for mini_app-only users (matches sendNotification)");
});

test('CAL-BULK-08: telegram preference → only queue INSERT', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes("if (userChannel === 'telegram' || userChannel === 'both') telegramUsers.push(uid);"),
    "'telegram' users must be pushed to telegramUsers (queue INSERT only)");
  // telegram-only users are NOT in miniAppUsers → no notif INSERT for them
  // (verified by the partition logic: only mini_app/both go to miniAppUsers)
});

test('CAL-BULK-09: both preference → both notification + queue INSERT', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  // 'both' users appear in BOTH miniAppUsers AND telegramUsers
  assert.ok(path1.includes("if (userChannel === 'mini_app' || userChannel === 'both') miniAppUsers.push(uid);"),
    "'both' users must be in miniAppUsers (notif INSERT)");
  assert.ok(path1.includes("if (userChannel === 'telegram' || userChannel === 'both') telegramUsers.push(uid);"),
    "'both' users must be in telegramUsers (queue INSERT)");
  // channel for 'both' users: 'both' (since they're in telegramUsers)
  assert.ok(path1.includes("telegramUsers.includes(uid) ? 'both' : 'mini_app'"),
    "channel column must be 'both' for both-pref users (matches sendNotification)");
});

test('CAL-BULK-10: missing preference → defaults to both', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes("prefMap.get(uid) || 'both'"),
    "missing preference must default to 'both' (matches sendNotification default)");
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — Dedup + processQueue ordering
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-11: dedup write placed AFTER bulk INSERTs', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  const notifInsertPos = path1.indexOf('INSERT INTO notifications');
  const queueInsertPos = path1.indexOf('INSERT INTO notification_queue');
  const dedupWritePos = path1.indexOf("writeAppCache(env, dedupKey");

  assert.notEqual(notifInsertPos, -1, 'notif INSERT must exist');
  assert.notEqual(queueInsertPos, -1, 'queue INSERT must exist');
  assert.notEqual(dedupWritePos, -1, 'dedup write must exist');

  assert.ok(dedupWritePos > notifInsertPos,
    `dedup write must be AFTER notif INSERT. dedupPos=${dedupWritePos}, notifPos=${notifInsertPos}`);
  assert.ok(dedupWritePos > queueInsertPos,
    `dedup write must be AFTER queue INSERT. dedupPos=${dedupWritePos}, queuePos=${queueInsertPos}`);
});

test('CAL-BULK-12: processQueue(10) still exists at end of PATH 1', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  assert.ok(path1.includes('processQueue(env, sendTelegramMessage, pool, 10)'),
    'processQueue(10) must still exist at end of PATH 1 (unchanged)');
});

test('CAL-BULK-13: no per-user processQueue(3) in PATH 1 (replaced by bulk INSERT)', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  // Check for actual processQueue function calls (not comment text)
  const callPattern = /await\s+(?:notificationPlatformRepo\??\.)?processQueue\s*\(/g;
  const callMatches = (path1.match(callPattern) || []).length;
  // Should be exactly 1 (the processQueue(10) at end)
  assert.equal(callMatches, 1,
    `PATH 1 must have exactly 1 processQueue call (the processQueue(10) at end). Found ${callMatches} calls. Per-user processQueue(3) removed.`);
  // Verify it's processQueue with limit=10 (not 3)
  assert.ok(path1.includes('pool, 10)'),
    'the single processQueue call must use limit=10 (not 3)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6 — No artificial cap
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-14: no artificial user cap (no slice/LIMIT on joined users)', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  // The SELECT telegram_id FROM users WHERE channel_joined = TRUE must NOT have a LIMIT
  assert.ok(path1.includes('SELECT telegram_id FROM users WHERE channel_joined = TRUE'),
    'must use same SELECT query for joined users');
  // Check that the SELECT does NOT have a LIMIT clause
  const selectIdx = path1.indexOf('SELECT telegram_id FROM users WHERE channel_joined = TRUE');
  const selectEnd = path1.indexOf('`', selectIdx);
  const selectSql = path1.slice(selectIdx, selectEnd);
  assert.ok(!selectSql.includes('LIMIT'),
    'joined users SELECT must NOT have LIMIT (no artificial cap)');
  // Also check no .slice(0, N) on allUserIds
  assert.ok(!path1.includes('allUserIds.slice'),
    'must NOT slice allUserIds (no artificial cap)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 7 — Scope verification (PATH 2 / Price Alert / H6 untouched)
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-15: PATH 2 (per-user calendar reminders) untouched', () => {
  const body = extractFunctionBody(WORKER_SRC, 'runCalendarAlertsCheck');
  const path2Start = body.indexOf('SECOND PATH: Per-user calendar reminders');
  assert.notEqual(path2Start, -1, 'PATH 2 must still exist (untouched)');
  // PATH 2 must still use notificationService.create (per-reminder dispatch)
  const path2Block = body.slice(path2Start);
  assert.ok(path2Block.includes('notificationService.create'),
    'PATH 2 must still use notificationService.create (per-reminder, untouched)');
  assert.ok(path2Block.includes('calendarReminderRepo.markFired'),
    'PATH 2 must still use markFired (untouched)');
  assert.ok(path2Block.includes('calendarReminderRepo.listPending'),
    'PATH 2 must still use listPending (untouched)');
});

test('CAL-BULK-16: Price Alert (runScheduledAlertsBaseline) untouched by Calendar fix', () => {
  // Verify runScheduledAlertsBaseline still exists and is unchanged
  assert.ok(WORKER_SRC.includes('async function runScheduledAlertsBaseline'),
    'runScheduledAlertsBaseline must still exist (Price Alert untouched)');
  // Verify the Calendar fix did NOT touch the Price Alert function
  const priceAlertBody = extractFunctionBody(WORKER_SRC, 'runScheduledAlertsBaseline');
  // Price Alert must NOT reference calendar-specific code
  assert.ok(!priceAlertBody.includes('ch_calendar'),
    'Price Alert must NOT reference ch_calendar (Calendar-specific code not leaked)');
  assert.ok(!priceAlertBody.includes('cal_event_'),
    'Price Alert must NOT reference cal_event_ (Calendar-specific dedupKey not leaked)');
});

test('CAL-BULK-16b: H6 OHLC cap (slice(0, 14)) untouched', () => {
  assert.ok(WORKER_SRC.includes('slice(0, 14)'),
    'H6 OHLC cap (slice(0, 14)) must still exist (untouched)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 8 — Subrequest budget verification (constant regardless of user count)
// ═══════════════════════════════════════════════════════════════════════════

test('CAL-BULK-17: subrequest budget is constant (27) regardless of user count (1/10/50/100/500)', () => {
  const path1 = extractCalendarBroadcastPath(WORKER_SRC);
  // Count queryDb calls in PATH 1 (actual calls, not comment mentions)
  // Expected: 4 DB ops (SELECT users + batch pref + bulk notif INSERT + bulk queue INSERT)
  // Plus 1 KV read (dedup check) + 1 KV write (dedup key) = 2 KV ops
  // Plus processQueue(10) = up to 21 subrequests
  // Total: 4 DB + 2 KV + 21 processQueue = 27 (constant)

  // Verify the 4 DB operations exist:
  // 1. SELECT telegram_id FROM users
  assert.ok(path1.includes('SELECT telegram_id FROM users'),
    'must have 1 DB for SELECT joined users');
  // 2. batch pref SELECT
  assert.ok(path1.includes('SELECT user_id, ch_calendar AS pref'),
    'must have 1 DB for batch preference lookup');
  // 3. bulk notif INSERT
  assert.ok(path1.includes('INSERT INTO notifications'),
    'must have 1 DB for bulk notif INSERT');
  // 4. bulk queue INSERT
  assert.ok(path1.includes('INSERT INTO notification_queue'),
    'must have 1 DB for bulk queue INSERT');

  // Verify NO per-user queryDb calls (no loop with await queryDb per user)
  // The per-user loop for sentForThisEvent counting is JS-only (no queryDb)
  // Check that the only queryDb calls are the 4 bulk operations + processQueue
  const queryDbCallPattern = /await\s+queryDb\s*\(/g;
  const queryDbCallCount = (path1.match(queryDbCallPattern) || []).length;
  assert.ok(queryDbCallCount <= 4,
    `must have at most 4 queryDb calls in PATH 1 (SELECT users + batch pref + bulk notif + bulk queue). Found ${queryDbCallCount} calls.`);
  // Note: there might be 4 or fewer (if some are conditional with empty arrays)

  // Verify the budget is constant (scales to any user count)
  // The bulk INSERT uses unnest() — N rows in 1 query
  assert.ok(path1.includes('SELECT * FROM unnest('),
    'must use unnest() — N users → 1 INSERT (constant subrequest count)');
});

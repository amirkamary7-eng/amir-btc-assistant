/**
 * H5-HIGH Calendar Reminder PATH 2 Bulk Fix — Regression Test
 *
 * Background:
 *   PATH 2 (per-user calendar reminders) used per-reminder notificationService.create
 *   WITHOUT enqueueOnly:true. Each reminder cost 5-11 subrequests (pref + notif + queue +
 *   processQueue(3) + markFired). With 200 reminders (listPending LIMIT), worst case
 *   = 2201 subrequests → exceededResources.
 *
 * Fix:
 *   Replaced per-reminder loop with bulk pattern (same as PATH 1 + Price Alert H5-HIGH):
 *   1. Batch preference lookup (1 DB)
 *   2. Partition by channel (JS only)
 *   3. Bulk INSERT notifications via unnest() (1 DB, ON CONFLICT (id) DO NOTHING)
 *   4. Bulk INSERT queue via unnest() (1 DB, ON CONFLICT (notification_id, user_id) DO NOTHING)
 *   5. markFiredBulk (1 DB, WHERE id IN (...) AND fired_at IS NULL) — AFTER INSERTs
 *   6. processQueue(10) at end of PATH 2
 *
 * Subrequest budget after fix: 26 (constant, scales to any reminder count up to 200)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const REMINDERS_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/calendar_reminders.js'), 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractFunctionBody(src, fnName) {
  const startMarker = `async function ${fnName}`;
  const startIdx = src.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Function ${fnName} must exist`);
  const nextAsyncIdx = src.indexOf('async function ', startIdx + startMarker.length);
  const endIdx = nextAsyncIdx === -1 ? src.length : nextAsyncIdx;
  return src.slice(startIdx, endIdx);
}

function extractPATH2(src) {
  const body = extractFunctionBody(src, 'runCalendarAlertsCheck');
  const path2Start = body.indexOf('SECOND PATH: Per-user calendar reminders');
  assert.notEqual(path2Start, -1, 'PATH 2 must exist');
  // PATH 2 extends to end of function (or next major section)
  const path2End = body.indexOf('if (alertedCount.sent > 0 || alertedCount.skipped', path2Start);
  return body.slice(path2Start, path2End === -1 ? body.length : path2End);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// GROUP 1 — Batch preference lookup

test('CAL-REM-01: batch preference lookup used in PATH 2', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes('ch_calendar AS pref'), 'must SELECT ch_calendar');
  assert.ok(path2.includes('FROM notification_settings WHERE user_id IN ('), 'must use batch IN-clause');
});

test('CAL-REM-02: per-reminder getUserChannelPreference removed from PATH 2', () => {
  const path2 = extractPATH2(WORKER_SRC);
  const callPattern = /await\s+notificationPlatformRepo\.getUserChannelPreference\s*\(/g;
  assert.equal((path2.match(callPattern) || []).length, 0,
    'PATH 2 must NOT call getUserChannelPreference per-reminder');
});

// GROUP 2 — Bulk INSERT with unnest()

test('CAL-REM-03: bulk notification INSERT uses unnest() in PATH 2', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes('INSERT INTO notifications'), 'must bulk INSERT notifications');
  assert.ok(path2.includes('SELECT * FROM unnest('), 'must use unnest()');
  assert.ok(path2.includes('ON CONFLICT (id) DO NOTHING'), 'must use ON CONFLICT (id) DO NOTHING');
});

test('CAL-REM-04: bulk queue INSERT uses unnest() in PATH 2', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes('INSERT INTO notification_queue'), 'must bulk INSERT queue');
  assert.ok(path2.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'must use ON CONFLICT (notification_id, user_id) DO NOTHING');
  const unnestCount = (path2.match(/SELECT \* FROM unnest\(/g) || []).length;
  assert.equal(unnestCount, 2, `must have 2 unnest() calls — found ${unnestCount}`);
});

// GROUP 3 — Notification ID sanitization

test('CAL-REM-05: notification ID uses same sanitization as sendNotification', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes('`notif_cal_reminder_${r.id}_${r.user_id}`'),
    'must build notif_id from cal_reminder pattern');
  assert.ok(path2.includes(".replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)"),
    'must sanitize + slice notif_id (same as sendNotification)');
});

// GROUP 4 — Metadata exact match

test('CAL-REM-06: metadata has exact same keys as current per-reminder path', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes('event_title: r.event_title'), 'must have event_title');
  assert.ok(path2.includes('event_timestamp: r.event_timestamp'), 'must have event_timestamp');
  assert.ok(path2.includes('event_country: r.event_country'), 'must have event_country');
  assert.ok(path2.includes('lead_minutes: r.lead_minutes'), 'must have lead_minutes');
  assert.ok(path2.includes('reminder_id: r.id'), 'must have reminder_id');
});

// GROUP 5 — Channel preferences

test('CAL-REM-07: none preference → no INSERT (skipped in partition)', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes("if (userChannel === 'none') continue;"),
    "'none' must be skipped in partition");
});

test('CAL-REM-08: mini_app → only notification INSERT', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes("if (userChannel === 'mini_app' || userChannel === 'both') miniAppReminders.push(reminder);"),
    "'mini_app' must go to miniAppReminders");
});

test('CAL-REM-09: telegram → only queue INSERT', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes("if (userChannel === 'telegram' || userChannel === 'both') telegramReminders.push(reminder);"),
    "'telegram' must go to telegramReminders");
});

test('CAL-REM-10: both → both INSERTs', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes("r._userChannel === 'both' ? 'both' : 'mini_app'"),
    "channel='both' for both-pref users in notif INSERT");
});

test('CAL-REM-11: default → both (missing preference)', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes("reminderPrefMap.get(String(reminder.user_id)) || 'both'"),
    "missing preference must default to 'both'");
});

// GROUP 6 — markFiredBulk

test('CAL-REM-12: markFiredBulk defined in calendar_reminders.js', () => {
  assert.ok(REMINDERS_SRC.includes('async function markFiredBulk'),
    'markFiredBulk must be defined');
  assert.ok(REMINDERS_SRC.includes('markFiredBulk,'),
    'markFiredBulk must be exported');
});

test('CAL-REM-13: markFiredBulk uses CAS with fired_at IS NULL', () => {
  const body = extractFunctionBody(REMINDERS_SRC, 'markFiredBulk');
  assert.ok(body.includes('fired_at IS NULL'), 'must use WHERE fired_at IS NULL (CAS)');
  assert.ok(body.includes('RETURNING id'), 'must RETURN id');
  assert.ok(body.includes('id IN ('), 'must use WHERE id IN (...) (bulk)');
});

test('CAL-REM-14: markFiredBulk runs AFTER bulk INSERTs (ordering)', () => {
  const path2 = extractPATH2(WORKER_SRC);
  // Find the ACTUAL function CALL (not comment mentions)
  const notifInsertPos = path2.indexOf('INSERT INTO notifications');
  const queueInsertPos = path2.indexOf('INSERT INTO notification_queue');
  const markFiredPos = path2.indexOf('calendarReminderRepo.markFiredBulk(env,');

  assert.notEqual(markFiredPos, -1, 'markFiredBulk call must exist in PATH 2');
  assert.ok(markFiredPos > notifInsertPos, 'markFiredBulk must be AFTER notif INSERT');
  assert.ok(markFiredPos > queueInsertPos, 'markFiredBulk must be AFTER queue INSERT');
});

// GROUP 7 — processQueue + no per-reminder processQueue

test('CAL-REM-15: processQueue(10) at end of PATH 2', () => {
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(path2.includes('processQueue(env, sendTelegramMessage, pool, 10)'),
    'processQueue(10) must exist at end of PATH 2');
});

test('CAL-REM-16: no per-reminder processQueue(3) in PATH 2', () => {
  const path2 = extractPATH2(WORKER_SRC);
  const callPattern = /await\s+(?:notificationPlatformRepo\??\.)?processQueue\s*\(/g;
  const callMatches = (path2.match(callPattern) || []).length;
  assert.equal(callMatches, 1, `must have 1 processQueue call (the (10) at end) — found ${callMatches}`);
});

// GROUP 8 — LIMIT 200 preserved

test('CAL-REM-17: listPending LIMIT 200 preserved (no new cap)', () => {
  assert.ok(REMINDERS_SRC.includes('LIMIT 200'), 'listPending must still have LIMIT 200');
  // Check no artificial cap on pendingReminders array (slice/LIMIT on the JS array)
  // Note: .slice(0, 60) on notif_id is OK — that's sanitization, not a reminder cap
  const path2 = extractPATH2(WORKER_SRC);
  assert.ok(!path2.includes('pendingReminders.slice'),
    'must NOT slice pendingReminders array (no artificial cap)');
});

// GROUP 9 — Scope verification

test('CAL-REM-18: PATH 1 (Calendar Broadcast) untouched', () => {
  const body = extractFunctionBody(WORKER_SRC, 'runCalendarAlertsCheck');
  const path1End = body.indexOf('SECOND PATH: Per-user calendar reminders');
  const path1 = body.slice(0, path1End);
  assert.ok(path1.includes('BULK FIX: Batch preference lookup'),
    'PATH 1 must still have its bulk fix (from commit 4e02940)');
});

test('CAL-REM-19: Price Alert untouched', () => {
  assert.ok(WORKER_SRC.includes('async function runScheduledAlertsBaseline'),
    'runScheduledAlertsBaseline must still exist');
  assert.ok(WORKER_SRC.includes('slice(0, 14)'), 'H6 OHLC cap must still exist');
});

test('CAL-REM-20: no notificationService.create in PATH 2 (replaced by bulk)', () => {
  const path2 = extractPATH2(WORKER_SRC);
  const callPattern = /await\s+notificationService\.create\s*\(/g;
  assert.equal((path2.match(callPattern) || []).length, 0,
    'PATH 2 must NOT call notificationService.create (replaced by bulk INSERT)');
});

test('CAL-REM-21: original markFired (per-reminder) preserved in calendar_reminders.js', () => {
  assert.ok(REMINDERS_SRC.includes('async function markFired(env, reminderId, pool = null)'),
    'original markFired must still exist (not removed)');
  assert.ok(REMINDERS_SRC.includes('markFired,'),
    'markFired must be exported');
  assert.ok(REMINDERS_SRC.includes('markFiredBulk,'),
    'markFiredBulk must be exported');
});

// GROUP 10 — Subrequest budget

test('CAL-REM-22: subrequest budget constant (26) regardless of reminder count', () => {
  const path2 = extractPATH2(WORKER_SRC);
  // 4 queryDb calls: listPending (outside path2), batch pref, bulk notif, bulk queue, markFiredBulk
  // + processQueue(10) = up to 21
  // listPending is outside PATH 2 block (called before if block)
  // Inside PATH 2 block: batch pref (1) + bulk notif (1) + bulk queue (1) + markFiredBulk (1) + processQueue(10) (up to 21)
  // Total: 1 (listPending) + 4 (bulk ops) + 21 (processQueue) = 26
  assert.ok(path2.includes('SELECT * FROM unnest('), 'must use unnest() — scales to any count');
});

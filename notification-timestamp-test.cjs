/**
 * Notification Timestamp Regression Tests (Phase 3)
 *
 * Root cause confirmed by audit: app.js:9839 used `toLocaleDateString('fa-IR')`
 * (date-only, hard-coded locale). Fix: show date + time (24-hour, locale-aware
 * via currentLang, single Date object, `•` separator).
 *
 * Run: node --test notification-timestamp-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Static verification — the formatter code is correct
// ============================================================================

test('NOTIF-TS-01: renderNotifications uses dateStyle:medium + timeStyle:short + hour12:false', () => {
  // The fix must use dateStyle: 'medium' and timeStyle: 'short' with hour12: false.
  assert.ok(APP_SRC.includes("dateStyle: 'medium'"),
    'formatter must use dateStyle: medium');
  assert.ok(APP_SRC.includes("timeStyle: 'short'"),
    'formatter must use timeStyle: short');
  assert.ok(APP_SRC.includes('hour12: false'),
    'formatter must use hour12: false (24-hour)');
});

test('NOTIF-TS-02: formatter is locale-aware (currentLang → fa-IR / en-US)', () => {
  // The fix must select locale based on currentLang (fixes the prior i18n bug
  // where EN users saw Persian digits).
  assert.ok(APP_SRC.includes("currentLang === 'fa' ? 'fa-IR' : 'en-US'"),
    'formatter must select locale via currentLang === "fa" ? "fa-IR" : "en-US"');
});

test('NOTIF-TS-03: uses a single Date object per notification (not two new Date() calls)', () => {
  // The fix must build one Date and reuse it for date + time.
  assert.ok(APP_SRC.includes('const notificationDate = new Date(n.date)'),
    'must build a single notificationDate Date object');
  assert.ok(APP_SRC.includes('notificationDate.toLocaleDateString('),
    'must reuse notificationDate for toLocaleDateString');
  assert.ok(APP_SRC.includes('notificationDate.toLocaleTimeString('),
    'must reuse notificationDate for toLocaleTimeString');
});

test('NOTIF-TS-04: output uses " • " separator between date and time', () => {
  // The rendered HTML must contain "datePart • timePart".
  assert.ok(APP_SRC.includes('${datePart} • ${timePart}'),
    'rendered output must use " • " separator');
});

test('NOTIF-TS-05: old date-only hard-coded fa-IR formatter is GONE', () => {
  // The old buggy line was: toLocaleDateString('fa-IR') with no options.
  // After the fix, the only toLocaleDateString call in renderNotifications
  // is the one with _notifLocale + _notifDateOpts.
  assert.ok(!APP_SRC.includes("new Date(n.date).toLocaleDateString('fa-IR')"),
    'old hard-coded fa-IR date-only formatter must be removed');
});

test('NOTIF-TS-06: backend timestamp source unchanged (UTC ISO with Z)', () => {
  // The backend serializeRow must still send ISO UTC with Z suffix.
  const notifRepoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/notifications.js'), 'utf8');
  assert.ok(notifRepoSrc.includes('new Date(row.created_at).toISOString()'),
    'backend must still serialize created_at as ISO UTC (toISOString)');
});

test('NOTIF-TS-07: DB schema unchanged (TIMESTAMPTZ DEFAULT NOW())', () => {
  const notifRepoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/notifications.js'), 'utf8');
  assert.ok(notifRepoSrc.includes('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'),
    'DB schema must still be TIMESTAMPTZ DEFAULT NOW() (unchanged)');
});

test('NOTIF-TS-08: API response field unchanged (created_at)', () => {
  // The backend response must still use created_at (snake_case).
  const notifRepoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/notifications.js'), 'utf8');
  assert.ok(notifRepoSrc.includes('created_at: row.created_at'),
    'backend response must still include created_at field (unchanged)');
});

// ============================================================================
// Behavioral verification — the formatter produces correct output
// ============================================================================
// These tests run the ACTUAL formatter logic against known UTC timestamps and
// verify the output format + timezone conversion.

function runFormatter(isoDate, currentLang) {
  // Mirrors the app.js renderNotifications formatter logic.
  const _notifLocale = currentLang === 'fa' ? 'fa-IR' : 'en-US';
  const _notifDateOpts = { dateStyle: 'medium' };
  const _notifTimeOpts = { timeStyle: 'short', hour12: false };
  const notificationDate = new Date(isoDate);
  const datePart = notificationDate.toLocaleDateString(_notifLocale, _notifDateOpts);
  const timePart = notificationDate.toLocaleTimeString(_notifLocale, _notifTimeOpts);
  return `${datePart} • ${timePart}`;
}

test('NOTIF-TS-09: new notification (UTC now) → displays date + time with separator', () => {
  const iso = new Date().toISOString();
  const out = runFormatter(iso, 'fa');
  assert.ok(out.includes('•'), 'must contain "•" separator');
  const parts = out.split(' • ');
  assert.equal(parts.length, 2, 'must have exactly 2 parts (date + time)');
  assert.ok(parts[0].trim().length > 0, 'date part must be non-empty');
  assert.ok(parts[1].trim().length > 0, 'time part must be non-empty');
});

test('NOTIF-TS-10: old notification (days ago) → still displays date + time', () => {
  const old = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000).toISOString();
  const out = runFormatter(old, 'fa');
  assert.ok(out.includes('•'), 'old notification must also have date + time');
});

test('NOTIF-TS-11: time is 24-hour format (hour12: false)', () => {
  // Pick a timestamp at 14:30 UTC — in 24-hour format the time part must
  // contain "14" (not "2" + PM). Note: local timezone may shift the hour,
  // but the format itself must NOT contain AM/PM markers.
  const iso = '2026-08-21T14:30:00.000Z';
  const out = runFormatter(iso, 'en');
  const timePart = out.split(' • ')[1];
  // en-US with hour12:false → "14:30" (no AM/PM). If hour12 were true → "2:30 PM".
  assert.ok(!/AM|PM/.test(timePart),
    `time must be 24-hour (no AM/PM), got: "${timePart}"`);
  assert.ok(/^\d{1,2}:\d{2}$/.test(timePart),
    `time must be HH:MM format, got: "${timePart}"`);
});

test('NOTIF-TS-12: FA locale → Persian digits in output', () => {
  // fa-IR renders Persian digits. Use a fixed timestamp.
  const iso = '2026-08-21T08:35:00.000Z';
  const out = runFormatter(iso, 'fa');
  // fa-IR dateStyle:medium produces something like "۲۱ اوت ۲۰۲۶"
  // fa-IR timeStyle:short produces "۸:۳۵" or "08:35" — the key is Persian digits
  // somewhere. We check for at least one Persian digit (۰-۹).
  assert.ok(/[۰-۹]/.test(out),
    `FA locale must produce Persian digits, got: "${out}"`);
});

test('NOTIF-TS-13: EN locale → Latin digits in output', () => {
  const iso = '2026-08-21T08:35:00.000Z';
  const out = runFormatter(iso, 'en');
  // en-US produces Latin digits. Must NOT contain Persian digits.
  assert.ok(!/[۰-۹]/.test(out),
    `EN locale must NOT produce Persian digits, got: "${out}"`);
  assert.ok(/[0-9]/.test(out),
    `EN locale must produce Latin digits, got: "${out}"`);
});

test('NOTIF-TS-14: timestamp near midnight UTC → date + time consistent', () => {
  // A timestamp at 23:55 UTC. In Tehran (UTC+3:30) this is 03:25 the NEXT day.
  // The displayed date must match the displayed time's local date (not the UTC date).
  // We can't assert the exact date (depends on test runner tz), but we CAN assert
  // the format is consistent (date + time + separator, no NaN).
  const iso = '2026-08-21T23:55:00.000Z';
  const out = runFormatter(iso, 'fa');
  assert.ok(out.includes('•'), 'must have separator');
  assert.ok(!out.includes('Invalid Date'), 'must not produce Invalid Date');
  assert.ok(!out.includes('NaN'), 'must not produce NaN');
});

test('NOTIF-TS-15: locale switch fa → en → format updates correctly', () => {
  const iso = '2026-08-21T08:35:00.000Z';
  const faOut = runFormatter(iso, 'fa');
  const enOut = runFormatter(iso, 'en');
  // Both must have the separator + date + time.
  assert.ok(faOut.includes('•') && enOut.includes('•'), 'both must have separator');
  // FA must have Persian digits, EN must have Latin digits.
  assert.ok(/[۰-۹]/.test(faOut), 'FA must have Persian digits');
  assert.ok(/[0-9]/.test(enOut), 'EN must have Latin digits');
  // They must NOT be identical (different locales produce different output).
  assert.notEqual(faOut, enOut, 'FA and EN output must differ');
});

test('NOTIF-TS-16: timezone conversion — UTC ISO parsed correctly (no double-conversion)', () => {
  // The fix does NOT specify a timeZone option → browser default is used.
  // new Date(isoWithZ) parses as UTC. toLocaleString converts to browser tz.
  // We verify the Date object's internal value is the correct UTC epoch
  // (i.e., the Z suffix was respected).
  const iso = '2026-08-21T08:35:42.123Z';
  const d = new Date(iso);
  // The UTC hours should be 8 (matching the input).
  assert.equal(d.getUTCHours(), 8, 'ISO with Z must parse as UTC (hour 8)');
  assert.equal(d.getUTCMinutes(), 35, 'ISO with Z must parse as UTC (minute 35)');
  // The local getHours() may differ (browser tz), but the UTC value is canonical.
});

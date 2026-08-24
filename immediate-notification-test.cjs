/**
 * Immediate Notification Delivery — Regression Tests
 *
 * Tests the 3 changes:
 * 1. processQueue(LIMIT=1) called synchronously after enqueue in sendNotification
 * 2. sendTelegramMessage attaches retry_after to Error on 429
 * 3. processQueue catch uses e.retry_after for next_retry_at (fallback 60s)
 *
 * Run: node --test immediate-notification-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const NOTIF_REPO = fs.readFileSync(path.join(__dirname, 'src/repositories/notification_platform.js'), 'utf8');
const WORKER = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// 1. processQueue(LIMIT=1) after enqueue in sendNotification
// ============================================================================

test('IMM-001: sendNotification calls processQueue after enqueue', () => {
  // NOTIF-OPT: updated from LIMIT=1 to LIMIT=3 (concurrent Promise.allSettled)
  assert.ok(NOTIF_REPO.includes('await processQueue(env, env_sendTelegramMessage, pool, 3)'),
    'sendNotification must call processQueue(LIMIT=3) after enqueue (NOTIF-OPT: concurrent)');
});

test('IMM-002: processQueue call is wrapped in try/catch (non-fatal)', () => {
  assert.ok(NOTIF_REPO.includes("sendNotification immediate processQueue failed (cron will retry)"),
    'processQueue call must be non-fatal (wrapped in try/catch)');
});

test('IMM-003: processQueue uses env_sendTelegramMessage (module-level)', () => {
  assert.ok(NOTIF_REPO.includes('env_sendTelegramMessage'),
    'sendNotification must use env_sendTelegramMessage for processQueue');
});

test('IMM-004: processQueue call is gated on deliverToTelegram + enqueueOnly', () => {
  // The processQueue call is inside the `if (deliverToTelegram)` block
  // FIX 1: also gated on !enqueueOnly (broadcast loops skip immediate delivery)
  assert.ok(NOTIF_REPO.includes('if (env_sendTelegramMessage && !enqueueOnly)'),
    'processQueue must be inside deliverToTelegram + env_sendTelegramMessage + !enqueueOnly gate');
});

// ============================================================================
// 2. sendTelegramMessage attaches retry_after to Error on 429
// ============================================================================

test('IMM-005: 429 error has retry_after property (API body 429)', () => {
  assert.ok(WORKER.includes('_err429.retry_after'),
    'sendTelegramMessage must attach retry_after to error on API body 429');
});

test('IMM-006: 429 error has retry_after property (HTTP 429)', () => {
  assert.ok(WORKER.includes('_errHttp.retry_after'),
    'sendTelegramMessage must attach retry_after to error on HTTP 429');
});

test('IMM-007: retry_after is clamped to 1-60 range', () => {
  assert.ok(WORKER.includes('Math.max(1, Math.min(data.parameters.retry_after, 60))'),
    'API body retry_after must be clamped 1-60');
  assert.ok(WORKER.includes('Math.max(1, Math.min(_ra, 60))'),
    'HTTP header retry_after must be clamped 1-60');
});

// ============================================================================
// 3. processQueue catch uses e.retry_after for next_retry_at
// ============================================================================

test('IMM-008: processQueue catch reads e.retry_after', () => {
  assert.ok(NOTIF_REPO.includes("typeof e.retry_after === 'number'"),
    'processQueue catch must check e.retry_after');
});

test('IMM-009: processQueue catch uses retry_after for next_retry_at', () => {
  assert.ok(NOTIF_REPO.includes('make_interval(secs => $3)'),
    'processQueue catch must use make_interval with retry_after seconds');
});

test('IMM-010: processQueue catch falls back to 60s when no retry_after', () => {
  assert.ok(NOTIF_REPO.includes(': 60;'),
    'processQueue catch must fall back to 60 seconds when no retry_after');
});

// ============================================================================
// 4. Cron handlers unchanged
// ============================================================================

test('IMM-011: 1-min cron processQueue LIMIT 5 (FIX 3: was 3)', () => {
  assert.ok(WORKER.includes('processQueue(env, sendTelegramMessage, pool, 5)'),
    '1-min cron processQueue must be LIMIT 5 (FIX 3: increased from 3)');
});

test('IMM-012: 5-min cron processQueue LIMIT 15 (FIX 2: was 10)', () => {
  assert.ok(WORKER.includes('processQueue(env, sendTelegramMessage, pool, 15)'),
    '5-min cron processQueue must be LIMIT 15 (FIX 2: increased from 10, reduced from 20 after subrequest re-analysis)');
});

// ============================================================================
// 5. Duplicate protection still intact
// ============================================================================

test('IMM-013: FOR UPDATE SKIP LOCKED still present', () => {
  assert.ok(NOTIF_REPO.includes('FOR UPDATE SKIP LOCKED'),
    'FOR UPDATE SKIP LOCKED must still be present');
});

test('IMM-014: ON CONFLICT DO NOTHING still present in enqueue', () => {
  assert.ok(NOTIF_REPO.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'ON CONFLICT DO NOTHING must still be present');
});

test('IMM-015: telegram_message_id check still present', () => {
  assert.ok(NOTIF_REPO.includes('if (item.telegram_message_id)'),
    'telegram_message_id idempotency check must still be present');
});

// ============================================================================
// 6. Behavioral simulation
// ============================================================================

// Simulate the retry_after logic from processQueue catch
function computeRetrySeconds(error) {
  return (error && typeof error.retry_after === 'number' && error.retry_after > 0)
    ? Math.max(1, Math.min(error.retry_after, 60))
    : 60;
}

test('IMM-016: retry_after=3 → next_retry in 3 seconds', () => {
  const err = new Error('429');
  err.retry_after = 3;
  assert.equal(computeRetrySeconds(err), 3);
});

test('IMM-017: retry_after=0 → fallback to 60 seconds', () => {
  const err = new Error('429');
  err.retry_after = 0;
  assert.equal(computeRetrySeconds(err), 60);
});

test('IMM-018: no retry_after property → fallback to 60 seconds', () => {
  const err = new Error('some other error');
  assert.equal(computeRetrySeconds(err), 60);
});

test('IMM-019: retry_after=120 (over limit) → clamped to 60', () => {
  const err = new Error('429');
  err.retry_after = 120;
  assert.equal(computeRetrySeconds(err), 60);
});

test('IMM-020: retry_after=-5 (negative) → fallback to 60', () => {
  const err = new Error('429');
  err.retry_after = -5;
  assert.equal(computeRetrySeconds(err), 60);
});

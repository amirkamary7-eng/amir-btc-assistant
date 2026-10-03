/**
 * P0-1: Online Count Zero-Suppression Regression Test
 *
 * Verifies that fetchOnlineCount() suppresses a transient count=0
 * from the backend when a successful heartbeat occurred within the
 * last SESSION_TTL (360s). This prevents the "online count suddenly
 * shows 0" bug caused by the DO transiently having 0 sessions
 * between expiry and the next heartbeat.
 *
 * Scenarios tested:
 *   1. _lastHeartbeatSuccessTs exists and is set on successful heartbeat
 *   2. fetchOnlineCount has the suppress-0 logic
 *   3. The suppress window is 360000ms (360s = SESSION_TTL)
 *   4. count > 0 still passes through (not suppressed)
 *   5. count = 0 with STALE heartbeat (> 360s) is NOT suppressed
 *   6. count = 0 with NO heartbeat (_lastHeartbeatSuccessTs = 0) is NOT suppressed
 *   7. heartbeat error does NOT update _lastHeartbeatSuccessTs
 *
 * Run: node --test tests/online-count-zero-suppression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// ============================================================================
// SECTION 1: _lastHeartbeatSuccessTs variable exists
// ============================================================================

test('P0-1-VAR: _lastHeartbeatSuccessTs declared as module-level variable', () => {
  assert.ok(APP_SRC.includes('let _lastHeartbeatSuccessTs = 0;'),
    '_lastHeartbeatSuccessTs must be declared as module-level let = 0');
});

// ============================================================================
// SECTION 2: sendSessionHeartbeat sets _lastHeartbeatSuccessTs on success
// ============================================================================

test('P0-1-HB-SUCCESS: sendSessionHeartbeat sets _lastHeartbeatSuccessTs = Date.now() on success', () => {
  // Find the heartbeat success path — after apiFetch resolves successfully
  const hbStart = APP_SRC.indexOf('async function sendSessionHeartbeat');
  assert.ok(hbStart > -1, 'sendSessionHeartbeat function must exist');
  const hbEnd = APP_SRC.indexOf('\n}', hbStart + 50);
  const hbBody = APP_SRC.slice(hbStart, hbEnd);

  // Must set _lastHeartbeatSuccessTs BEFORE updateOnlineBadge (so suppression is active)
  const tsIdx = hbBody.indexOf('_lastHeartbeatSuccessTs = Date.now()');
  const badgeIdx = hbBody.indexOf("updateOnlineBadge(data.online_count");
  assert.ok(tsIdx > -1, 'sendSessionHeartbeat must set _lastHeartbeatSuccessTs = Date.now()');
  assert.ok(badgeIdx > -1, 'sendSessionHeartbeat must call updateOnlineBadge');
  assert.ok(tsIdx < badgeIdx,
    '_lastHeartbeatSuccessTs must be set BEFORE updateOnlineBadge in heartbeat success path');
});

test('P0-1-HB-ERROR: _lastHeartbeatSuccessTs NOT set in heartbeat catch block', () => {
  const hbStart = APP_SRC.indexOf('async function sendSessionHeartbeat');
  const hbEnd = APP_SRC.indexOf('finally {', hbStart);
  const hbBody = APP_SRC.slice(hbStart, hbEnd);

  // Find the catch block
  const catchStart = hbBody.indexOf('} catch (e)');
  assert.ok(catchStart > -1, 'heartbeat must have a catch block');
  const catchBody = hbBody.slice(catchStart);

  // _lastHeartbeatSuccessTs must NOT appear in the catch block
  assert.ok(!catchBody.includes('_lastHeartbeatSuccessTs'),
    '_lastHeartbeatSuccessTs must NOT be set in heartbeat catch/error path');
});

// ============================================================================
// SECTION 3: fetchOnlineCount has suppress-0 logic
// ============================================================================

test('P0-1-SUPPRESS: fetchOnlineCount suppresses count=0 when heartbeat is recent', () => {
  const focStart = APP_SRC.indexOf('async function fetchOnlineCount');
  assert.ok(focStart > -1, 'fetchOnlineCount function must exist');
  const focEnd = APP_SRC.indexOf('\n}', focStart + 50);
  const focBody = APP_SRC.slice(focStart, focEnd);

  // Must check data.count === 0
  assert.ok(focBody.includes('data.count === 0'),
    'fetchOnlineCount must check data.count === 0');

  // Must check _lastHeartbeatSuccessTs > 0
  assert.ok(focBody.includes('_lastHeartbeatSuccessTs > 0'),
    'fetchOnlineCount must check _lastHeartbeatSuccessTs > 0 (heartbeat has occurred)');

  // Must check time window < 360000 (360s = SESSION_TTL)
  assert.ok(focBody.includes('360000'),
    'fetchOnlineCount must use 360000ms (360s SESSION_TTL) as suppress window');

  // Must return early (not call updateOnlineBadge) when suppressed
  assert.ok(focBody.includes('return;'),
    'fetchOnlineCount must return early (skip updateOnlineBadge) when 0 is suppressed');
});

test('P0-1-SUPPRESS-ORDER: suppress check is BEFORE updateOnlineBadge call', () => {
  const focStart = APP_SRC.indexOf('async function fetchOnlineCount');
  const focEnd = APP_SRC.indexOf('\n}', focStart + 50);
  const focBody = APP_SRC.slice(focStart, focEnd);

  const suppressIdx = focBody.indexOf('data.count === 0');
  const badgeIdx = focBody.indexOf('updateOnlineBadge(data.count');
  assert.ok(suppressIdx > -1 && badgeIdx > -1,
    'both suppress check and updateOnlineBadge must exist in fetchOnlineCount');
  assert.ok(suppressIdx < badgeIdx,
    'suppress-0 check must come BEFORE updateOnlineBadge call');
});

// ============================================================================
// SECTION 4: Non-zero counts still pass through
// ============================================================================

test('P0-1-PASS-THROUGH: count > 0 still calls updateOnlineBadge (not suppressed)', () => {
  const focStart = APP_SRC.indexOf('async function fetchOnlineCount');
  const focEnd = APP_SRC.indexOf('\n}', focStart + 50);
  const focBody = APP_SRC.slice(focStart, focEnd);

  // updateOnlineBadge(data.count, ...) must still be called for non-zero counts
  // (the suppress only triggers on count === 0)
  assert.ok(focBody.includes('updateOnlineBadge(data.count'),
    'fetchOnlineCount must still call updateOnlineBadge for non-zero counts');

  // The suppress condition must include data.count === 0 (not data.count <= 0)
  // so that count=null/undefined still reaches updateOnlineBadge (shows "—")
  assert.ok(focBody.includes('data.count === 0'),
    'suppress must trigger on count === 0 only (not <= 0) so null/undefined pass through');
});

// ============================================================================
// SECTION 5: Stale heartbeat (> 360s) does NOT suppress
// ============================================================================

test('P0-1-STALE: suppress window is exactly 360000ms (360s SESSION_TTL)', () => {
  const focStart = APP_SRC.indexOf('async function fetchOnlineCount');
  const focEnd = APP_SRC.indexOf('\n}', focStart + 50);
  const focBody = APP_SRC.slice(focStart, focEnd);

  // Must use < 360000 (strictly less than — heartbeat older than 360s is NOT suppressed)
  assert.ok(focBody.includes('< 360000'),
    'suppress window must be < 360000ms — heartbeats older than SESSION_TTL are not authoritative');
});

// ============================================================================
// SECTION 6: No heartbeat yet (initial state) does NOT suppress
// ============================================================================

test('P0-1-INITIAL: _lastHeartbeatSuccessTs starts at 0 so initial 0 is NOT suppressed', () => {
  // If no heartbeat has succeeded yet, _lastHeartbeatSuccessTs = 0
  // The check _lastHeartbeatSuccessTs > 0 prevents suppression
  // This means the very first fetchOnlineCount returning 0 WILL display 0
  // (which is correct — no heartbeat = no proof user is online)
  const focStart = APP_SRC.indexOf('async function fetchOnlineCount');
  const focEnd = APP_SRC.indexOf('\n}', focStart + 50);
  const focBody = APP_SRC.slice(focStart, focEnd);

  assert.ok(focBody.includes('_lastHeartbeatSuccessTs > 0'),
    'fetchOnlineCount must check _lastHeartbeatSuccessTs > 0 — initial state (0) does NOT suppress');
});

console.log('✅ P0-1 Online Count Zero-Suppression regression tests loaded.');

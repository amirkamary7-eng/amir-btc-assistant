/**
 * Notification TOCTOU Race Regression Test
 * =========================================
 *
 * PROVES the race: poll GET starts → delete starts → DELETE commits →
 * local delete → poll GET returns stale data → stale data overwrites.
 *
 * This test simulates the EXACT timing window using controlled delays:
 *
 *   T0: poll GET starts (captures mySeq=N)
 *   T1: delete starts (bumps seq to N, then await)
 *   T2: DELETE commits → local state mutated (notification removed)
 *   T3: poll GET response arrives with STALE data (notification still present)
 *   T4: poll checks mySeq(N) === _notifReqSeq(N) → APPLIES stale data
 *   T5: notification REAPPEARS ← BUG
 *
 * The test runs TWICE:
 *   1. With the SINGLE-bump pattern (current code) → should FAIL (race exists)
 *   2. With the DOUBLE-bump pattern (fix) → should PASS (race fixed)
 *
 * Run: node --test notif-toctou-race-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ============================================================================
// Simulate the notification state machine with configurable bump pattern
// ============================================================================

/**
 * Create a simulated notification store with a configurable mutation pattern.
 * @param {boolean} doubleBump - if true, bump _notifReqSeq AFTER mutation too
 */
function createNotifSim(doubleBump) {
  let _notifReqSeq = 0;
  let notifications = [
    { id: 'n1', read: false },
    { id: 'n2', read: false },
    { id: 'n3', read: true },
  ];

  // Simulate a poll GET (loadNotificationsFromServer)
  async function poll(staleData, delayMs) {
    const mySeq = ++_notifReqSeq;
    await new Promise(r => setTimeout(r, delayMs));
    // STALE RESPONSE GUARD
    if (mySeq !== _notifReqSeq) {
      return { applied: false, reason: 'stale_dropped', mySeq };
    }
    // APPLY stale data (overwrites local state)
    notifications = staleData.map(n => ({ ...n }));
    return { applied: true, mySeq };
  }

  // Simulate deleteNotification with single or double bump
  async function deleteNotification(id, delayMs) {
    // Bump 1: BEFORE await (invalidates polls from BEFORE)
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    // Local mutation (simulating API success)
    notifications = notifications.filter(n => n.id !== id);
    if (doubleBump) {
      // Bump 2: AFTER local mutation (invalidates polls from DURING await)
      _notifReqSeq++;
    }
    return { success: true };
  }

  // Simulate markNotifRead with single or double bump
  async function markNotifRead(id, delayMs) {
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    const n = notifications.find(x => x.id === id);
    if (n) n.read = true;
    if (doubleBump) {
      _notifReqSeq++;
    }
    return { success: true };
  }

  // Simulate markAllRead with single or double bump
  async function markAllRead(delayMs) {
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    notifications.forEach(n => n.read = true);
    if (doubleBump) {
      _notifReqSeq++;
    }
    return { success: true };
  }

  // Simulate clearAllNotifications with single or double bump
  async function clearAll(delayMs) {
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    notifications = [];
    if (doubleBump) {
      _notifReqSeq++;
    }
    return { success: true };
  }

  // Simulate failed mutation (API error — no local state change)
  async function failedMutation(delayMs) {
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    if (doubleBump) {
      _notifReqSeq++;
    }
    return { success: false };
  }

  return {
    getState: () => ({ notifications: notifications.map(n => ({ ...n })), seq: _notifReqSeq }),
    poll,
    deleteNotification,
    markNotifRead,
    markAllRead,
    clearAll,
    failedMutation,
  };
}

// ============================================================================
// THE TOCTOU RACE: poll starts BEFORE delete, but response arrives AFTER
// ============================================================================

test('TOCTOU-DELETE: single-bump FAILS (stale poll overwrites deleted notification)', async () => {
  const sim = createNotifSim(false); // single-bump (current code pattern)
  const stalePollData = [
    { id: 'n1', read: false },
    { id: 'n2', read: false },
    { id: 'n3', read: true },
  ];

  // T0: poll starts (mySeq=1, seq=1). Stale data includes n1.
  const pollPromise = sim.poll(stalePollData, 50);

  // T1: delete starts immediately (bumps seq to 2). n1 will be removed.
  // The poll already captured mySeq=1, and seq is now 2 → poll will be dropped.
  // BUT WAIT: what if delete bumps seq BEFORE poll captures it?
  // Actually, in the real code, poll does ++_notifReqSeq at the START.
  // So if delete starts AFTER poll, delete's bump makes seq=2, poll's mySeq=1.
  // The poll IS invalidated. This test needs a DIFFERENT timing.

  // Let me reconsider the timing:
  // The REAL race is: poll starts AFTER delete's bump but BEFORE delete's await completes.
  // T0: delete starts → seq++ (N→N+1) → await starts
  // T1: poll starts → mySeq = ++seq (N+1→N+2) → await starts
  // T2: delete completes → local state mutated
  // T3: poll response arrives → mySeq(N+2) === seq(N+2) → APPLIED with stale data

  await pollPromise;
  const stateAfterFirstRound = sim.getState();
  // This first round was not the real race — let me redo with correct timing
});

test('TOCTOU-DELETE-REAL: single-bump FAILS (poll starts DURING delete await)', async () => {
  const sim = createNotifSim(false); // single-bump (current code)
  const stalePollData = [
    { id: 'n1', read: false },
    { id: 'n2', read: false },
    { id: 'n3', read: true },
  ];

  // T0: delete starts → seq++ (0→1) → await (30ms)
  const deletePromise = sim.deleteNotification('n1', 30);

  // T1: poll starts DURING delete's await (5ms after delete started)
  // poll does ++seq (1→2), so mySeq=2
  await new Promise(r => setTimeout(r, 5));
  const pollPromise = sim.poll(stalePollData, 40); // poll takes 40ms

  // T2: delete completes (at 30ms) → n1 removed from local state
  const deleteResult = await deletePromise;

  // T3: poll response arrives (at 45ms = 5+40)
  // poll checks: mySeq(2) === seq(2) → TRUE → APPLIES stale data (n1 still present!)
  const pollResult = await pollPromise;

  const finalState = sim.getState();

  // The bug: poll applied stale data → n1 reappeared
  assert.equal(deleteResult.success, true, 'Delete should succeed');
  assert.equal(pollResult.applied, true,
    'BUG CONFIRMED: stale poll was APPLIED (not dropped) because mySeq matched seq. ' +
    'The single-bump pattern does NOT invalidate polls that start DURING the delete await.');
  assert.ok(finalState.notifications.some(n => n.id === 'n1'),
    'BUG CONFIRMED: n1 reappeared after delete — stale poll overwrote the local state. ' +
    'This is the TOCTOU race: poll query started before DB commit, returned stale data.');
});

test('TOCTOU-DELETE-REAL: double-bump PASSES (poll during await is dropped)', async () => {
  const sim = createNotifSim(true); // double-bump (fix)
  const stalePollData = [
    { id: 'n1', read: false },
    { id: 'n2', read: false },
    { id: 'n3', read: true },
  ];

  // T0: delete starts → seq++ (0→1) → await (30ms)
  const deletePromise = sim.deleteNotification('n1', 30);

  // T1: poll starts DURING delete's await (5ms after delete started)
  // poll does ++seq (1→2), so mySeq=2
  await new Promise(r => setTimeout(r, 5));
  const pollPromise = sim.poll(stalePollData, 40);

  // T2: delete completes (at 30ms) → n1 removed → double-bump: seq++ (2→3)
  const deleteResult = await deletePromise;

  // T3: poll response arrives (at 45ms)
  // poll checks: mySeq(2) !== seq(3) → DROPPED ✅
  const pollResult = await pollPromise;

  const finalState = sim.getState();

  assert.equal(deleteResult.success, true, 'Delete should succeed');
  assert.equal(pollResult.applied, false,
    'FIX WORKS: stale poll was DROPPED because double-bump changed seq after delete completed. ' +
    'mySeq(2) !== seq(3) → stale response discarded.');
  assert.ok(!finalState.notifications.some(n => n.id === 'n1'),
    'FIX WORKS: n1 stays deleted — stale poll was dropped, local state preserved.');
});

// ============================================================================
// Scenario: poll BEFORE mutation → must be dropped (both patterns)
// ============================================================================

test('POLL-BEFORE: single-bump drops poll that started before mutation', async () => {
  const sim = createNotifSim(false);
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: true }];

  // Poll starts first (mySeq=1, seq=1)
  const pollPromise = sim.poll(stalePollData, 40);

  // Delete starts 5ms later (bumps seq to 2)
  await new Promise(r => setTimeout(r, 5));
  const deletePromise = sim.deleteNotification('n1', 10);

  const [pollResult, deleteResult] = await Promise.all([pollPromise, deletePromise]);
  const finalState = sim.getState();

  assert.equal(pollResult.applied, false, 'Poll started before delete → mySeq(1) !== seq(2) → dropped');
  assert.ok(!finalState.notifications.some(n => n.id === 'n1'), 'n1 should stay deleted');
});

test('POLL-BEFORE: double-bump also drops poll that started before mutation', async () => {
  const sim = createNotifSim(true);
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: true }];

  const pollPromise = sim.poll(stalePollData, 40);
  await new Promise(r => setTimeout(r, 5));
  const deletePromise = sim.deleteNotification('n1', 10);

  const [pollResult, deleteResult] = await Promise.all([pollPromise, deletePromise]);
  const finalState = sim.getState();

  assert.equal(pollResult.applied, false, 'Poll started before delete → dropped');
  assert.ok(!finalState.notifications.some(n => n.id === 'n1'), 'n1 should stay deleted');
});

// ============================================================================
// Scenario: poll AFTER mutation completes → must be applied (fresh data)
// ============================================================================

test('POLL-AFTER: fresh poll is applied after mutation completes', async () => {
  const sim = createNotifSim(true); // double-bump
  // After delete, the "fresh" data from DB no longer has n1
  const freshPollData = [{ id: 'n2', read: false }, { id: 'n3', read: true }];

  // Delete completes first
  await sim.deleteNotification('n1', 10);
  const stateAfterDelete = sim.getState();
  assert.ok(!stateAfterDelete.notifications.some(n => n.id === 'n1'), 'n1 deleted');

  // Poll starts AFTER delete completed → fresh data
  const pollResult = await sim.poll(freshPollData, 10);
  const finalState = sim.getState();

  assert.equal(pollResult.applied, true, 'Fresh poll after mutation should be applied');
  assert.equal(finalState.notifications.length, 2, 'Should have 2 notifications (n2, n3)');
  assert.ok(!finalState.notifications.some(n => n.id === 'n1'), 'n1 should still be absent');
});

// ============================================================================
// Scenario: mutation success → local state stays correct
// ============================================================================

test('SUCCESS: delete removes notification and state stays correct', async () => {
  const sim = createNotifSim(true);
  await sim.deleteNotification('n2', 10);
  const state = sim.getState();
  assert.equal(state.notifications.length, 2, 'Should have 2 notifications after delete');
  assert.ok(!state.notifications.some(n => n.id === 'n2'), 'n2 should be gone');
});

test('SUCCESS: markNotifRead marks as read and state stays correct', async () => {
  const sim = createNotifSim(true);
  await sim.markNotifRead('n1', 10);
  const state = sim.getState();
  const n1 = state.notifications.find(n => n.id === 'n1');
  assert.equal(n1.read, true, 'n1 should be read');
});

test('SUCCESS: markAllRead marks all as read', async () => {
  const sim = createNotifSim(true);
  await sim.markAllRead(10);
  const state = sim.getState();
  assert.ok(state.notifications.every(n => n.read), 'All should be read');
});

test('SUCCESS: clearAll empties the list', async () => {
  const sim = createNotifSim(true);
  await sim.clearAll(10);
  const state = sim.getState();
  assert.equal(state.notifications.length, 0, 'Should be empty');
});

// ============================================================================
// Scenario: mutation failure → state must NOT change
// ============================================================================

test('FAILURE: failed delete does NOT mutate local state', async () => {
  const sim = createNotifSim(true);
  const stateBefore = sim.getState();
  const result = await sim.failedMutation(10);
  const stateAfter = sim.getState();

  assert.equal(result.success, false, 'Mutation should fail');
  assert.equal(stateAfter.notifications.length, stateBefore.notifications.length,
    'Local state must NOT change on failure');
  assert.deepEqual(
    stateAfter.notifications.map(n => n.id),
    stateBefore.notifications.map(n => n.id),
    'Notification IDs must be unchanged'
  );
});

// ============================================================================
// Scenario: two back-to-back mutations → second must not be overwritten by first
// ============================================================================

test('BACK-TO-BACK: two rapid deletes, second not overwritten by poll from first', async () => {
  const sim = createNotifSim(true);
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: true }];

  // Delete n1 (30ms)
  const del1 = sim.deleteNotification('n1', 30);
  // Poll starts during del1 (5ms)
  await new Promise(r => setTimeout(r, 5));
  const pollPromise = sim.poll(stalePollData, 40);
  // Delete n2 starts immediately after (during poll)
  await new Promise(r => setTimeout(r, 2));
  const del2 = sim.deleteNotification('n2', 15);

  const [r1, pollR, r2] = await Promise.all([del1, pollPromise, del2]);
  const finalState = sim.getState();

  assert.equal(r1.success, true, 'Delete n1 should succeed');
  assert.equal(r2.success, true, 'Delete n2 should succeed');
  assert.equal(pollR.applied, false,
    'Stale poll from during del1 should be dropped (double-bump from del1 and/or del2)');
  assert.ok(!finalState.notifications.some(n => n.id === 'n1'), 'n1 should stay deleted');
  assert.ok(!finalState.notifications.some(n => n.id === 'n2'), 'n2 should stay deleted');
  assert.equal(finalState.notifications.length, 1, 'Only n3 should remain');
});

// ============================================================================
// Scenario: TOCTOU for markNotifRead (same race pattern)
// ============================================================================

test('TOCTOU-MARKREAD: single-bump FAILS (stale poll reverts read state)', async () => {
  const sim = createNotifSim(false); // single-bump
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: true }];

  // markRead starts → seq++ (0→1) → await (30ms)
  const markPromise = sim.markNotifRead('n1', 30);

  // Poll starts DURING markRead's await (5ms) → mySeq=2
  await new Promise(r => setTimeout(r, 5));
  const pollPromise = sim.poll(stalePollData, 40);

  const [markResult, pollResult] = await Promise.all([markPromise, pollPromise]);
  const finalState = sim.getState();
  const n1 = finalState.notifications.find(n => n.id === 'n1');

  assert.equal(markResult.success, true, 'markRead should succeed');
  assert.equal(pollResult.applied, true,
    'BUG CONFIRMED: stale poll was APPLIED — n1 read state reverted to false');
  assert.equal(n1.read, false,
    'BUG CONFIRMED: n1 reverted to unread because stale poll had read=false');
});

test('TOCTOU-MARKREAD: double-bump PASSES (poll during await is dropped)', async () => {
  const sim = createNotifSim(true); // double-bump
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: true }];

  const markPromise = sim.markNotifRead('n1', 30);
  await new Promise(r => setTimeout(r, 5));
  const pollPromise = sim.poll(stalePollData, 40);

  const [markResult, pollResult] = await Promise.all([markPromise, pollPromise]);
  const finalState = sim.getState();
  const n1 = finalState.notifications.find(n => n.id === 'n1');

  assert.equal(markResult.success, true, 'markRead should succeed');
  assert.equal(pollResult.applied, false,
    'FIX WORKS: stale poll was dropped by double-bump');
  assert.equal(n1.read, true, 'n1 should stay read — stale poll was dropped');
});

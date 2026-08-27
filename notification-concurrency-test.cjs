/**
 * Notification Concurrency / Race Condition Test (Final Verification)
 *
 * This is a REAL interleaving test (not static). It loads BOTH:
 *   - loadNotificationsFromServer (the GET /api/notifications function)
 *   - markNotifRead / deleteNotification (the mutations)
 * into the SAME sandbox so they share the _notifReqSeq counter and the
 * notifications array. A gated apiFetch lets us control exactly when the GET
 * response resolves, so we can interleave a mutation during the pending GET.
 *
 * Scenario (the exact bug the user described):
 *
 *   T0  GET /api/notifications starts (delayed — gated, not resolved yet)
 *       mySeq = 1, _notifReqSeq = 1
 *   T1  User clicks Mark Read / Delete (mutation starts)
 *   T2  Mutation resolves: _notifReqSeq bumped to 2, local state mutated
 *   T3  Old GET response resolves with STALE server data (n1 still unread)
 *   T4  Stale-response guard: mySeq(1) !== _notifReqSeq(2) → DISCARD
 *
 *   Expected: local state reflects the mutation (n1.read=true or n1 gone),
 *   NOT the stale GET response.
 *
 * We also test the FAILURE path (mutation fails): with the fix, the failed
 * mutation bumps seq → the stale GET is still discarded. Before the fix,
 * the failed mutation did NOT bump seq → the stale GET was applied →
 * notification reverted.
 *
 * Run: node --test notification-concurrency-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Line-based function extraction (robust against template literal ${...})
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^async function ${name}\\(`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`Function ${name} start not found in app.js`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j] === '}') {
      return lines.slice(startIdx, j + 1).join('\n');
    }
  }
  throw new Error(`Function ${name} end not found in app.js`);
}

const LOAD_NOTIF_SRC = extractFn(APP_SRC, 'loadNotificationsFromServer');
const MARK_NOTIF_READ_SRC = extractFn(APP_SRC, 'markNotifRead');
const DELETE_NOTIF_SRC = extractFn(APP_SRC, 'deleteNotification');

// ============================================================================
// Sandbox: load all 3 functions into a SHARED scope (shared _notifReqSeq + notifications)
// ============================================================================
function createSandbox(mocks) {
  const sharedState = {
    notifications: mocks.notifications ?? [
      { id: 'n1', title: 'A', body: 'body A', read: false, date: '2026-01-01' },
      { id: 'n2', title: 'B', body: 'body B', read: false, date: '2026-01-02' },
    ],
    _notifReqSeq: 0,
    _notifConsecutiveErrors: 0,
    _notifBackoffMs: 60000,
    _notifFetchError: false,
  };
  const callLog = { toast: [], render: [], getApplied: [], getStaleDropped: [], log: [] };
  const apiFetchImpl = mocks.apiFetch ?? (async () => { throw new Error('apiFetch not mocked'); });
  const g = {
    ...sharedState,
    UserContext: { isGuest: mocks.isGuest ?? (() => false) },
    apiFetch: apiFetchImpl,
    showMiniToast: (m) => callLog.toast.push(m),
    _updateBadgeFromLocal: () => callLog.render.push(Date.now()),
    renderNotifications: () => callLog.render.push(Date.now()),
    closeNotifModal: () => {},
    _logNotifEvent: (ev, data) => {
      callLog.log.push({ ev, data });
      if (ev === 'GET_APPLIED') callLog.getApplied.push(data);
      if (ev === 'GET_STALE_DROPPED') callLog.getStaleDropped.push(data);
    },
    confirm: () => true,
    t: (k) => k,
    // $ is used for the badge DOM lookup in loadNotificationsFromServer — return
    // null so the badge block is skipped (we only care about the notifications array).
    $: () => null,
    // console — capture warns/logs so test output stays clean
    console: { warn: () => {}, log: () => {} },
    API_BASE: 'https://test.local',
  };
  // Build a wrapper that shares state across all 3 functions.
  const wrapper = [
    'let notifications = __g.notifications;',
    'let _notifReqSeq = __g._notifReqSeq;',
    'let _notifConsecutiveErrors = __g._notifConsecutiveErrors;',
    'let _notifBackoffMs = __g._notifBackoffMs;',
    'let _notifFetchError = __g._notifFetchError;',
    'const UserContext = __g.UserContext;',
    'const apiFetch = __g.apiFetch;',
    'const showMiniToast = __g.showMiniToast;',
    'const _updateBadgeFromLocal = __g._updateBadgeFromLocal;',
    'const renderNotifications = __g.renderNotifications;',
    'const closeNotifModal = __g.closeNotifModal;',
    'const _logNotifEvent = __g._logNotifEvent;',
    'const confirm = __g.confirm;',
    'const t = __g.t;',
    'const $ = __g.$;',
    'const API_BASE = __g.API_BASE;',
    LOAD_NOTIF_SRC,
    MARK_NOTIF_READ_SRC,
    DELETE_NOTIF_SRC,
    'function __getState() { return { notifications, _notifReqSeq, _notifConsecutiveErrors, _notifFetchError }; }',
    'return { loadNotificationsFromServer, markNotifRead, deleteNotification, __getState };',
  ].join('\n');
  const evaluator = new Function('__g', wrapper);
  const result = evaluator(g);
  // Sync state back to sharedState on each getState() call — we mutate the
  // wrapper's locals, so __getState reads the LIVE values.
  return { ...result, _callLog: callLog };
}

// ============================================================================
// Gated apiFetch: GET requests are gated (delayed until releaseGet() is called);
// POST/DELETE resolve immediately. This lets us interleave a mutation during
// a pending GET.
// ============================================================================
function createGatedApiFetch(serverNotifications) {
  let getGateResolve = null;
  let pendingGetCount = 0;
  return {
    // The actual apiFetch implementation
    impl: async (url, opts) => {
      const method = (opts?.method || 'GET').toUpperCase();
      if (url === '/api/notifications' && method === 'GET') {
        pendingGetCount++;
        // Block until releaseGet() is called.
        await new Promise((resolve) => { getGateResolve = resolve; });
        pendingGetCount--;
        return {
          notifications: serverNotifications.map(n => ({ ...n, message: n.body })),
          unread_count: serverNotifications.filter(n => !n.read).length,
        };
      }
      if (url.startsWith('/api/notifications/') && method === 'POST') {
        // markNotifRead — server marks read
        const id = url.split('/')[3];
        const n = serverNotifications.find(x => x.id === id);
        if (n) n.read = true;
        return { status: 'success' };
      }
      if (url.startsWith('/api/notifications/') && method === 'DELETE') {
        // deleteNotification — server soft-deletes (remove from server list)
        const id = url.split('/')[3];
        const idx = serverNotifications.findIndex(x => x.id === id);
        if (idx >= 0) serverNotifications.splice(idx, 1);
        return { status: 'success' };
      }
      return { status: 'error', message: 'unknown endpoint' };
    },
    releaseGet: () => { if (getGateResolve) { const r = getGateResolve; getGateResolve = null; r(); } },
    isGetPending: () => pendingGetCount > 0,
  };
}

// ============================================================================
// TEST 1: Mark Read — stale GET response cannot overwrite newer state
// ============================================================================
test('CONCURRENCY-1: Mark Read during pending GET — stale GET discarded', async () => {
  // Server still thinks n1 is UNREAD (the GET response will be stale)
  const serverNotifications = [
    { id: 'n1', title: 'A', body: 'body A', read: false, created_at: '2026-01-01' },
    { id: 'n2', title: 'B', body: 'body B', read: false, created_at: '2026-01-02' },
  ];
  const gate = createGatedApiFetch(serverNotifications);
  const sandbox = createSandbox({ apiFetch: gate.impl });

  // T0: Start GET (delayed — will not resolve until releaseGet)
  const getPromise = sandbox.loadNotificationsFromServer();
  // Let the microtask queue run so GET reaches the await on apiFetch
  await new Promise(r => setImmediate(r));
  assert.ok(gate.isGetPending(), 'GET must be pending (delayed)');

  // Capture seq at GET start
  const seqAtGetStart = sandbox.__getState()._notifReqSeq;
  assert.equal(seqAtGetStart, 1, 'GET must have bumped seq to 1 at start');

  // T1+T2: While GET is pending, user marks n1 read (mutation resolves immediately)
  await sandbox.markNotifRead('n1');

  // Verify mutation succeeded locally
  const stateAfterMutation = sandbox.__getState();
  assert.equal(stateAfterMutation.notifications.find(n => n.id === 'n1').read, true,
    'n1 must be marked read locally after mutation');
  assert.equal(stateAfterMutation._notifReqSeq, 3,
    'mutation must have bumped seq to 3 (double-bump: before await + after mutation) (so GET with mySeq=1 will be discarded)');

  // T3: Release the GET — it resolves with STALE data (n1 still unread per server)
  gate.releaseGet();
  await getPromise;

  // T4: Stale-response guard should have discarded the GET response
  const finalState = sandbox.__getState();
  // 🚨 THE BUG: before the fix, the GET would overwrite local state with
  //    server truth (n1 still unread) → notification "reverted".
  //    After the fix: mySeq(1) !== _notifReqSeq(2) → DISCARDED.
  assert.equal(finalState.notifications.find(n => n.id === 'n1').read, true,
    'n1 must REMAIN read — stale GET response must NOT overwrite the mutation');
  assert.ok(sandbox._callLog.getStaleDropped.length >= 1,
    'GET_STALE_DROPPED must be logged (stale response was discarded)');
  assert.equal(sandbox._callLog.getApplied.length, 0,
    'GET_APPLIED must NOT be logged (stale response was not applied)');
});

// ============================================================================
// TEST 2: Delete — stale GET response cannot restore deleted notification
// ============================================================================
test('CONCURRENCY-2: Delete during pending GET — stale GET discarded', async () => {
  const serverNotifications = [
    { id: 'n1', title: 'A', body: 'body A', read: false, created_at: '2026-01-01' },
    { id: 'n2', title: 'B', body: 'body B', read: false, created_at: '2026-01-02' },
  ];
  const gate = createGatedApiFetch(serverNotifications);
  const sandbox = createSandbox({ apiFetch: gate.impl });

  // T0: Start GET (delayed)
  const getPromise = sandbox.loadNotificationsFromServer();
  await new Promise(r => setImmediate(r));
  assert.ok(gate.isGetPending(), 'GET must be pending');

  // T1+T2: While GET is pending, user deletes n1
  await sandbox.deleteNotification('n1');

  const stateAfterMutation = sandbox.__getState();
  assert.equal(stateAfterMutation.notifications.length, 1, 'n1 must be removed locally');
  assert.equal(stateAfterMutation.notifications.find(n => n.id === 'n1'), undefined,
    'n1 must be gone from local state');
  assert.equal(stateAfterMutation._notifReqSeq, 3, 'mutation must have bumped seq to 3 (double-bump)');

  // T3: Release the GET — server response still includes n1 (stale)
  gate.releaseGet();
  await getPromise;

  // T4: Stale GET must NOT restore n1
  const finalState = sandbox.__getState();
  assert.equal(finalState.notifications.length, 1, 'n1 must NOT be restored by stale GET');
  assert.equal(finalState.notifications.find(n => n.id === 'n1'), undefined,
    'n1 must remain absent — stale GET cannot re-add it');
  assert.ok(sandbox._callLog.getStaleDropped.length >= 1,
    'GET_STALE_DROPPED must be logged');
  assert.equal(sandbox._callLog.getApplied.length, 0, 'GET_APPLIED must NOT be logged');
});

// ============================================================================
// TEST 3: Mark Read FAILURE during pending GET — stale GET still discarded
// (This is the EXACT scenario the fix addresses — before the fix, the failed
//  mutation did NOT bump seq, so the stale GET WAS applied → notification reverted)
// ============================================================================
test('CONCURRENCY-3: FAILED Mark Read during pending GET — stale GET discarded (the fix)', async () => {
  // Server still thinks n1 is UNREAD
  const serverNotifications = [
    { id: 'n1', title: 'A', body: 'body A', read: false, created_at: '2026-01-01' },
  ];
  // Custom apiFetch: GET gated; POST throws (simulates mutation failure)
  let getGateResolve = null;
  let pendingGet = false;
  const failingApiFetch = async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (method === 'GET') {
      pendingGet = true;
      await new Promise((resolve) => { getGateResolve = resolve; });
      pendingGet = false;
      return {
        notifications: serverNotifications.map(n => ({ ...n, message: n.body })),
        unread_count: 1,
      };
    }
    if (method === 'POST') {
      // Simulate mutation FAILURE (network error / timeout / 5xx)
      throw new Error('network timeout');
    }
    return { status: 'error' };
  };
  const releaseGet = () => { if (getGateResolve) { const r = getGateResolve; getGateResolve = null; r(); } };
  const isGetPending = () => pendingGet;

  const sandbox = createSandbox({ apiFetch: failingApiFetch });

  // T0: Start GET (delayed)
  const getPromise = sandbox.loadNotificationsFromServer();
  await new Promise(r => setImmediate(r));
  assert.ok(isGetPending(), 'GET must be pending');
  assert.equal(sandbox.__getState()._notifReqSeq, 1, 'GET bumped seq to 1');

  // T1+T2: Mutation FAILS
  await sandbox.markNotifRead('n1');

  const stateAfterMutation = sandbox.__getState();
  // 🚨 BEFORE THE FIX: catch fell through to guest fallback → n1.read = true (false!)
  //    AND seq was NOT bumped → stale GET would be applied → n1 reverts to unread.
  // AFTER THE FIX: catch returns for auth user → n1.read stays false (correct),
  //    AND seq IS bumped to 2 → stale GET (mySeq=1) will be discarded.
  assert.equal(stateAfterMutation.notifications.find(n => n.id === 'n1').read, false,
    'n1 must NOT be marked read (mutation failed) — this is the core fix');
  assert.equal(stateAfterMutation._notifReqSeq, 2,
    'seq must be bumped to 2 on FAILURE (so stale GET is discarded)');

  // T3: Release the GET — server says n1 unread (stale)
  releaseGet();
  await getPromise;

  // T4: Stale GET must be discarded
  const finalState = sandbox.__getState();
  assert.equal(finalState.notifications.find(n => n.id === 'n1').read, false,
    'n1 must remain unread — stale GET must NOT be applied');
  assert.ok(sandbox._callLog.getStaleDropped.length >= 1,
    'GET_STALE_DROPPED must be logged (stale response discarded)');
  assert.equal(sandbox._callLog.getApplied.length, 0, 'GET_APPLIED must NOT be logged');
});

// ============================================================================
// TEST 4: Delete FAILURE during pending GET — stale GET still discarded
// ============================================================================
test('CONCURRENCY-4: FAILED Delete during pending GET — stale GET discarded', async () => {
  const serverNotifications = [
    { id: 'n1', title: 'A', body: 'body A', read: false, created_at: '2026-01-01' },
  ];
  let getGateResolve = null;
  let pendingGet = false;
  const failingApiFetch = async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (method === 'GET') {
      pendingGet = true;
      await new Promise((resolve) => { getGateResolve = resolve; });
      pendingGet = false;
      return {
        notifications: serverNotifications.map(n => ({ ...n, message: n.body })),
        unread_count: 1,
      };
    }
    if (method === 'DELETE') throw new Error('network error');
    return { status: 'error' };
  };
  const releaseGet = () => { if (getGateResolve) { const r = getGateResolve; getGateResolve = null; r(); } };

  const sandbox = createSandbox({ apiFetch: failingApiFetch });
  const getPromise = sandbox.loadNotificationsFromServer();
  await new Promise(r => setImmediate(r));

  // Mutation FAILS
  await sandbox.deleteNotification('n1');

  const stateAfterMutation = sandbox.__getState();
  // Sandbox starts with 2 notifications (n1, n2 from default mock). After a
  // FAILED delete of n1, BOTH must remain (length 2). Before the fix, the
  // catch fell through to guest fallback which filtered n1 out (length 1 — the bug).
  assert.equal(stateAfterMutation.notifications.length, 2,
    'n1 must NOT be removed (mutation failed) — this is the core fix');
  assert.ok(stateAfterMutation.notifications.find(n => n.id === 'n1'),
    'n1 must still be present');
  assert.equal(stateAfterMutation._notifReqSeq, 2,
    'seq must be bumped to 2 on FAILURE');

  releaseGet();
  await getPromise;

  const finalState = sandbox.__getState();
  // Sandbox started with [n1, n2]. Delete failed (n1 stays). GET discarded.
  // Final state: [n1, n2] still present, length 2.
  assert.equal(finalState.notifications.length, 2,
    'both n1 and n2 must still be present — stale GET did NOT change state');
  assert.ok(finalState.notifications.find(n => n.id === 'n1'),
    'n1 must still be present');
  assert.ok(sandbox._callLog.getStaleDropped.length >= 1, 'GET_STALE_DROPPED must be logged');
  assert.equal(sandbox._callLog.getApplied.length, 0, 'GET_APPLIED must NOT be logged');
});

// ============================================================================
// TEST 5: Control — no mutation, GET resolves normally and IS applied
// (Ensures the guard doesn't falsely discard valid responses)
// ============================================================================
test('CONCURRENCY-5: Control — GET without mutation IS applied', async () => {
  const serverNotifications = [
    { id: 'n1', title: 'A', body: 'body A', read: false, created_at: '2026-01-01' },
    { id: 'n2', title: 'B', body: 'body B', read: true, created_at: '2026-01-02' },
  ];
  const gate = createGatedApiFetch(serverNotifications);
  const sandbox = createSandbox({ apiFetch: gate.impl });

  // Start GET, release immediately (no mutation during pending)
  const getPromise = sandbox.loadNotificationsFromServer();
  await new Promise(r => setImmediate(r));
  gate.releaseGet();
  await getPromise;

  const finalState = sandbox.__getState();
  assert.equal(finalState.notifications.length, 2, 'GET response must be applied');
  assert.equal(finalState.notifications[0].id, 'n1');
  assert.equal(finalState.notifications[1].id, 'n2');
  assert.equal(finalState.notifications[1].read, true, 'server read state must be applied');
  assert.ok(sandbox._callLog.getApplied.length >= 1, 'GET_APPLIED must be logged');
  assert.equal(sandbox._callLog.getStaleDropped.length, 0, 'GET_STALE_DROPPED must NOT be logged');
});

// ============================================================================
// TEST 6: Multiple sequential mutations during a single pending GET
// (mark read + delete + mark all — all bump seq; GET discarded)
// ============================================================================
test('CONCURRENCY-6: Multiple mutations during pending GET — GET discarded', async () => {
  const serverNotifications = [
    { id: 'n1', title: 'A', body: 'body A', read: false, created_at: '2026-01-01' },
    { id: 'n2', title: 'B', body: 'body B', read: false, created_at: '2026-01-02' },
  ];
  const gate = createGatedApiFetch(serverNotifications);
  const sandbox = createSandbox({ apiFetch: gate.impl });

  const getPromise = sandbox.loadNotificationsFromServer();
  await new Promise(r => setImmediate(r));

  // Two mutations while GET is pending
  await sandbox.markNotifRead('n1');     // seq → 3 (double-bump: 1→2→3)
  await sandbox.deleteNotification('n2'); // seq → 5 (double-bump: 3→4→5)

  const stateAfterMutations = sandbox.__getState();
  assert.equal(stateAfterMutations._notifReqSeq, 5, 'two mutations → seq 5 (each double-bumps)');
  assert.equal(stateAfterMutations.notifications.length, 1, 'only n1 remains (n2 deleted)');
  assert.equal(stateAfterMutations.notifications[0].read, true, 'n1 is read');

  gate.releaseGet();
  await getPromise;

  const finalState = sandbox.__getState();
  assert.equal(finalState.notifications.length, 1, 'stale GET must NOT restore n2');
  assert.equal(finalState.notifications[0].id, 'n1', 'n1 still present');
  assert.equal(finalState.notifications[0].read, true, 'n1 still read');
  assert.ok(sandbox._callLog.getStaleDropped.length >= 1, 'GET discarded');
  assert.equal(sandbox._callLog.getApplied.length, 0, 'GET NOT applied');
});

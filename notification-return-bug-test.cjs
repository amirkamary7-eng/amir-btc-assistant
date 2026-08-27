/**
 * Notification Return Bug — Regression Tests (Phase 12 + 15)
 *
 * Root cause confirmed: in markNotifRead / deleteNotification / markAllRead /
 * clearAllNotifications, the catch block fell through to the "guest fallback"
 * block, which mutated local state as if the mutation had succeeded. On the
 * next poll (≤60s), server truth overwrote the false state → the
 * notification "reappeared" or "reverted".
 *
 * These tests verify the FIX: for an AUTHENTICATED user, a mutation failure
 * (network error / non-success / 404) must NOT mutate local state, must bump
 * _notifReqSeq (so any in-flight poll is discarded), and must show an error
 * toast. The guest fallback must ONLY run when the user is actually a guest.
 *
 * Approach: extract the 4 mutation functions from app.js by source-eval, drive
 * them with a mock apiFetch + mock UserContext + mock notifications array, and
 * assert on local-state mutations and seq bumps. No DOM, no real network.
 *
 * Run: node --test notification-return-bug-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Extract a function's body from app.js by line-based matching.
// All 4 target functions start at column 0 ("async function NAME(") and end
// at a column-0 "}". This avoids the brace-counting pitfalls of template
// literals with ${...} expression interpolation (which contain unbalanced
// braces that a naive string/brace scanner cannot handle).
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
  throw new Error(`Function ${name} end (column-0 '}') not found in app.js`);
}

const MARK_NOTIF_READ_SRC = extractFn(APP_SRC, 'markNotifRead');
const DELETE_NOTIF_SRC = extractFn(APP_SRC, 'deleteNotification');
const MARK_ALL_READ_SRC = extractFn(APP_SRC, 'markAllRead');
const CLEAR_ALL_SRC = extractFn(APP_SRC, 'clearAllNotifications');

// ============================================================================
// Test harness: evaluate a function in a sandbox with mock globals
// ============================================================================
function loadFn(src, name, mocks) {
  const exportsObj = {};
  const g = {
    notifications: mocks.notifications ?? [],
    _notifReqSeq: mocks._notifReqSeq ?? 0,
    UserContext: { isGuest: mocks.isGuest ?? (() => false) },
    apiFetch: mocks.apiFetch ?? (async () => ({ status: 'success' })),
    showMiniToast: mocks.showMiniToast ?? (() => {}),
    _updateBadgeFromLocal: mocks._updateBadgeFromLocal ?? (() => {}),
    renderNotifications: mocks.renderNotifications ?? (() => {}),
    closeNotifModal: mocks.closeNotifModal ?? (() => {}),
    _logNotifEvent: mocks._logNotifEvent ?? (() => {}),
    confirm: mocks.confirm ?? (() => true),
    t: mocks.t ?? ((k) => k),
  };
  // Build a wrapper that exposes the function plus mutable refs to state.
  // We declare `notifications` and `_notifReqSeq` as `let` so the function
  // can reassign them; we read final state via __getState.
  const wrapper = [
    'let notifications = __g.notifications;',
    'let _notifReqSeq = __g._notifReqSeq;',
    'const UserContext = __g.UserContext;',
    'const apiFetch = __g.apiFetch;',
    'const showMiniToast = __g.showMiniToast;',
    'const _updateBadgeFromLocal = __g._updateBadgeFromLocal;',
    'const renderNotifications = __g.renderNotifications;',
    'const closeNotifModal = __g.closeNotifModal;',
    'const _logNotifEvent = __g._logNotifEvent;',
    'const confirm = __g.confirm;',
    'const t = __g.t;',
    "const API_BASE = 'https://test.local';",
    src,
    'function __getState() { return { notifications, _notifReqSeq }; }',
    'return { fn: ' + name + ', __getState: __getState };',
  ].join('\n');
  const evaluator = new Function('__g', wrapper);
  return evaluator(g);
}

function makeMocks(overrides = {}) {
  const calls = { toast: [], render: [], badge: [], log: [] };
  return {
    notifications: overrides.notifications ?? [
      { id: 'n1', title: 'A', body: 'body A', read: false, date: '2026-01-01' },
      { id: 'n2', title: 'B', body: 'body B', read: false, date: '2026-01-02' },
    ],
    _notifReqSeq: overrides._notifReqSeq ?? 0,
    isGuest: overrides.isGuest ?? (() => false),
    apiFetch: overrides.apiFetch ?? (async () => { throw new Error('apiFetch not mocked'); }),
    showMiniToast: (msg) => calls.toast.push(msg),
    _updateBadgeFromLocal: () => calls.badge.push(Date.now()),
    renderNotifications: () => calls.render.push(Date.now()),
    closeNotifModal: () => calls.modalClosed = true,
    _logNotifEvent: (ev, data) => calls.log.push({ ev, data }),
    confirm: () => true,
    t: (k) => k,
    _calls: calls,
  };
}

// ============================================================================
// TEST A — markNotifRead success path (unchanged behavior, must still work)
// ============================================================================
test('NOTIF-RETURN-A1: markNotifRead SUCCESS marks read locally + bumps seq', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'success' }),
  });
  const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
  const before = __getState();
  await fn('n1');
  const after = __getState();
  assert.equal(after.notifications.find(n => n.id === 'n1').read, true, 'n1 must be marked read');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on success');
  assert.equal(mocks._calls.render.length, 1, 'render must be called once');
});

// TEST A — markNotifRead NETWORK ERROR (the root-cause bug)
test('NOTIF-RETURN-A2: markNotifRead NETWORK ERROR does NOT mutate local state', async () => {
  const mocks = makeMocks({
    apiFetch: async () => { throw new Error('network timeout'); },
  });
  const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
  const before = __getState();
  await fn('n1');
  const after = __getState();
  // ROOT-CAUSE FIX: local state must NOT be mutated on failure.
  assert.equal(after.notifications.find(n => n.id === 'n1').read, false,
    'n1 must remain UNREAD (failure must not falsely mark read)');
  assert.ok(after._notifReqSeq > before._notifReqSeq,
    'seq must be bumped on failure (so in-flight poll is discarded)');
  assert.ok(mocks._calls.toast.length >= 1, 'error toast must be shown');
});

// TEST A — markNotifRead NON-SUCCESS response (e.g. 404 / {status:'error'})
test('NOTIF-RETURN-A3: markNotifRead NON-SUCCESS does NOT mutate local state', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'error', message: 'Not found' }),
  });
  const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
  const before = __getState();
  await fn('n1');
  const after = __getState();
  assert.equal(after.notifications.find(n => n.id === 'n1').read, false,
    'n1 must remain UNREAD on non-success response');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on non-success');
  assert.ok(mocks._calls.toast.length >= 1, 'error toast must be shown');
});

// TEST A — markNotifRead for a GUEST user (fallback must STILL work)
test('NOTIF-RETURN-A4: markNotifRead GUEST uses fallback (mutates local state)', async () => {
  const apiCalls = [];
  const mocks = makeMocks({
    isGuest: () => true,
    apiFetch: async (url, opts) => { apiCalls.push({ url, opts }); return { status: 'success' }; },
  });
  const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
  await fn('n1');
  const after = __getState();
  assert.equal(after.notifications.find(n => n.id === 'n1').read, true,
    'guest fallback must mark read locally (no backend to call)');
  assert.equal(apiCalls.length, 0, 'apiFetch must NOT be called for a guest');
});

// ============================================================================
// TEST B — deleteNotification success / failure / guest
// ============================================================================
test('NOTIF-RETURN-B1: deleteNotification SUCCESS removes locally + bumps seq', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'success' }),
  });
  const { fn, __getState } = loadFn(DELETE_NOTIF_SRC, "deleteNotification", mocks);
  const before = __getState();
  await fn('n1');
  const after = __getState();
  assert.equal(after.notifications.find(n => n.id === 'n1'), undefined, 'n1 must be removed');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on success');
});

test('NOTIF-RETURN-B2: deleteNotification NETWORK ERROR does NOT remove locally', async () => {
  // 🚨 THIS IS THE RETURN BUG: previously the catch fell through to the guest
  //    fallback which filtered n1 out. Next poll re-added it → "reappeared".
  const mocks = makeMocks({
    apiFetch: async () => { throw new Error('network error'); },
  });
  const { fn, __getState } = loadFn(DELETE_NOTIF_SRC, "deleteNotification", mocks);
  const before = __getState();
  await fn('n1');
  const after = __getState();
  assert.equal(after.notifications.length, 2, 'notification must NOT be removed on failure');
  assert.ok(after.notifications.find(n => n.id === 'n1'), 'n1 must still be present');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on failure');
  assert.ok(mocks._calls.toast.length >= 1, 'error toast must be shown');
});

test('NOTIF-RETURN-B3: deleteNotification NON-SUCCESS does NOT remove locally', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'error', message: 'Not found' }),
  });
  const { fn, __getState } = loadFn(DELETE_NOTIF_SRC, "deleteNotification", mocks);
  const after_state = (await (async () => {
    const { fn, __getState } = loadFn(DELETE_NOTIF_SRC, "deleteNotification", mocks);
    await fn('n1');
    return __getState();
  })());
  assert.equal(after_state.notifications.length, 2, 'must NOT remove on non-success');
  assert.ok(after_state.notifications.find(n => n.id === 'n1'), 'n1 must still be present');
});

test('NOTIF-RETURN-B4: deleteNotification GUEST uses fallback (removes locally)', async () => {
  const apiCalls = [];
  const mocks = makeMocks({
    isGuest: () => true,
    apiFetch: async (url, opts) => { apiCalls.push({ url, opts }); return { status: 'success' }; },
  });
  const { fn, __getState } = loadFn(DELETE_NOTIF_SRC, "deleteNotification", mocks);
  await fn('n1');
  const after = __getState();
  assert.equal(after.notifications.length, 1, 'guest fallback must remove locally');
  assert.equal(apiCalls.length, 0, 'apiFetch must NOT be called for a guest');
});

// ============================================================================
// TEST C — markAllRead success / failure / guest
// ============================================================================
test('NOTIF-RETURN-C1: markAllRead SUCCESS marks all read + bumps seq', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'success' }),
  });
  const { fn, __getState } = loadFn(MARK_ALL_READ_SRC, "markAllRead", mocks);
  const before = __getState();
  await fn();
  const after = __getState();
  assert.ok(after.notifications.every(n => n.read), 'all must be read on success');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on success');
});

test('NOTIF-RETURN-C2: markAllRead NETWORK ERROR does NOT mark all read', async () => {
  // Previously the catch fell through to guest fallback → all marked read →
  // next poll reverted them all to unread. This is the return bug.
  const mocks = makeMocks({
    apiFetch: async () => { throw new Error('network error'); },
  });
  const { fn, __getState } = loadFn(MARK_ALL_READ_SRC, "markAllRead", mocks);
  const before = __getState();
  await fn();
  const after = __getState();
  assert.ok(after.notifications.every(n => !n.read), 'all must remain UNREAD on failure');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on failure');
  assert.ok(mocks._calls.toast.length >= 1, 'error toast must be shown');
});

test('NOTIF-RETURN-C3: markAllRead NON-SUCCESS does NOT mark all read', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'error' }),
  });
  const { fn, __getState } = loadFn(MARK_ALL_READ_SRC, "markAllRead", mocks);
  await fn();
  const after = __getState();
  assert.ok(after.notifications.every(n => !n.read), 'all must remain UNREAD on non-success');
});

test('NOTIF-RETURN-C4: markAllRead GUEST uses fallback (marks all read)', async () => {
  const apiCalls = [];
  const mocks = makeMocks({
    isGuest: () => true,
    apiFetch: async (url, opts) => { apiCalls.push({ url, opts }); return { status: 'success' }; },
  });
  const { fn, __getState } = loadFn(MARK_ALL_READ_SRC, "markAllRead", mocks);
  await fn();
  const after = __getState();
  assert.ok(after.notifications.every(n => n.read), 'guest fallback must mark all read');
  assert.equal(apiCalls.length, 0, 'apiFetch must NOT be called for a guest');
});

// ============================================================================
// TEST D — clearAllNotifications success / failure / guest
// ============================================================================
test('NOTIF-RETURN-D1: clearAll SUCCESS empties array + bumps seq', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'success', deleted_count: 2 }),
  });
  const { fn, __getState } = loadFn(CLEAR_ALL_SRC, "clearAllNotifications", mocks);
  const before = __getState();
  await fn();
  const after = __getState();
  assert.equal(after.notifications.length, 0, 'array must be empty on success');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on success');
});

test('NOTIF-RETURN-D2: clearAll NETWORK ERROR does NOT empty array', async () => {
  // Previously the catch fell through to guest fallback → array cleared →
  // next poll re-added them all. This is the return bug.
  const mocks = makeMocks({
    apiFetch: async () => { throw new Error('network error'); },
  });
  const { fn, __getState } = loadFn(CLEAR_ALL_SRC, "clearAllNotifications", mocks);
  const before = __getState();
  await fn();
  const after = __getState();
  assert.equal(after.notifications.length, 2, 'array must NOT be emptied on failure');
  assert.ok(after._notifReqSeq > before._notifReqSeq, 'seq must be bumped on failure');
  assert.ok(mocks._calls.toast.length >= 1, 'error toast must be shown');
});

test('NOTIF-RETURN-D3: clearAll NON-SUCCESS does NOT empty array', async () => {
  const mocks = makeMocks({
    apiFetch: async () => ({ status: 'error' }),
  });
  const { fn, __getState } = loadFn(CLEAR_ALL_SRC, "clearAllNotifications", mocks);
  await fn();
  const after = __getState();
  assert.equal(after.notifications.length, 2, 'array must NOT be emptied on non-success');
});

test('NOTIF-RETURN-D4: clearAll GUEST uses fallback (empties array)', async () => {
  const apiCalls = [];
  const mocks = makeMocks({
    isGuest: () => true,
    apiFetch: async (url, opts) => { apiCalls.push({ url, opts }); return { status: 'success' }; },
  });
  const { fn, __getState } = loadFn(CLEAR_ALL_SRC, "clearAllNotifications", mocks);
  await fn();
  const after = __getState();
  assert.equal(after.notifications.length, 0, 'guest fallback must empty array');
  assert.equal(apiCalls.length, 0, 'apiFetch must NOT be called for a guest');
});

// ============================================================================
// TEST E — Slow GET response (the seq stale-response guard)
// Simulate: poll A starts (seq=1) → mutation succeeds (seq=2) → poll A
// resolves with stale data. The stale-response guard in loadNotificationsFromServer
// (app.js:9610) must discard poll A's response. This test verifies the seq
// bumping mechanism that the guard depends on: a successful mutation bumps seq,
// so the guard will see mySeq !== _notifReqSeq and discard.
// ============================================================================
test('NOTIF-RETURN-E1: successful mutation bumps seq (stale-response guard precondition)', async () => {
  // Simulate: a poll captured seq=1 (mySeq=1, _notifReqSeq=1). Then a
  // markNotifRead succeeds → _notifReqSeq=2. The poll's stale check
  // (mySeq !== _notifReqSeq → 1 !== 2 → discard) is now armed.
  const mocks = makeMocks({
    _notifReqSeq: 1, // simulate an in-flight poll captured seq=1
    apiFetch: async () => ({ status: 'success' }),
  });
  const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
  await fn('n1');
  const after = __getState();
  // The mutation must have bumped seq to 2 → the in-flight poll (mySeq=1)
  // will be discarded by the guard at app.js:9610.
  assert.equal(after._notifReqSeq, 3, 'seq must be bumped to 3 (double-bump: before await + after mutation) (so the in-flight poll is discarded)');
  assert.equal(after.notifications.find(n => n.id === 'n1').read, true, 'n1 must be marked read');
});

test('NOTIF-RETURN-E2: FAILED mutation bumps seq (stale-response guard now armed on failure too)', async () => {
  // Before the fix: a FAILED mutation did NOT bump seq → the in-flight poll
  // (mySeq=1, _notifReqSeq=1) was NOT discarded → it applied stale server
  // truth → reverted the false local state. After the fix: a failed mutation
  // ALSO bumps seq → the poll is discarded → next poll fetches fresh truth.
  const mocks = makeMocks({
    _notifReqSeq: 1,
    apiFetch: async () => { throw new Error('timeout'); },
  });
  const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
  await fn('n1');
  const after = __getState();
  assert.equal(after._notifReqSeq, 2, 'seq must be bumped on failure (so in-flight poll is discarded)');
  assert.equal(after.notifications.find(n => n.id === 'n1').read, false, 'local state must NOT be mutated');
});

// ============================================================================
// TEST F — Static verification: the guest-fallback fall-through is gone
// ============================================================================
test('NOTIF-RETURN-F1: markNotifRead catch block returns before guest fallback (static)', () => {
  // The catch block must contain `if (!isGuest) { ... return; }` so it does
  // NOT fall through to the guest fallback for authenticated users.
  const fnBlock = MARK_NOTIF_READ_SRC;
  const catchIdx = fnBlock.indexOf('} catch (e) {');
  assert.notEqual(catchIdx, -1, 'catch block must exist');
  // Use a generous window (600 chars) — the catch block has multi-line comments.
  const afterCatch = fnBlock.slice(catchIdx, catchIdx + 600);
  assert.ok(afterCatch.includes('if (!isGuest)'), 'catch must guard with if (!isGuest)');
  assert.ok(afterCatch.includes('return;'), 'catch must return for authenticated users');
  // The guest fallback block after the try/catch must ALSO guard with if (!isGuest) return;
  const fallbackIdx = fnBlock.indexOf('Fallback for guests ONLY');
  assert.notEqual(fallbackIdx, -1, 'guest fallback comment must exist');
  const afterFallback = fnBlock.slice(fallbackIdx, fallbackIdx + 200);
  assert.ok(afterFallback.includes('if (!isGuest) return;'), 'guest fallback must guard with if (!isGuest) return;');
});

test('NOTIF-RETURN-F2: deleteNotification catch block returns before guest fallback (static)', () => {
  const fnBlock = DELETE_NOTIF_SRC;
  const catchIdx = fnBlock.indexOf('} catch (e) {');
  assert.notEqual(catchIdx, -1);
  const afterCatch = fnBlock.slice(catchIdx, catchIdx + 400);
  assert.ok(afterCatch.includes('if (!isGuest)'), 'catch must guard with if (!isGuest)');
  assert.ok(afterCatch.includes('return;'), 'catch must return for authenticated users');
  const fallbackIdx = fnBlock.indexOf('Fallback for guests ONLY');
  assert.notEqual(fallbackIdx, -1);
  const afterFallback = fnBlock.slice(fallbackIdx, fallbackIdx + 200);
  assert.ok(afterFallback.includes('if (!isGuest) return;'), 'guest fallback must guard');
});

test('NOTIF-RETURN-F3: markAllRead catch block returns before guest fallback (static)', () => {
  const fnBlock = MARK_ALL_READ_SRC;
  const catchIdx = fnBlock.indexOf('} catch (e) {');
  assert.notEqual(catchIdx, -1);
  const afterCatch = fnBlock.slice(catchIdx, catchIdx + 400);
  assert.ok(afterCatch.includes('if (!isGuest)'), 'catch must guard with if (!isGuest)');
  assert.ok(afterCatch.includes('return;'), 'catch must return for authenticated users');
});

test('NOTIF-RETURN-F4: clearAllNotifications catch block returns before guest fallback (static)', () => {
  const fnBlock = CLEAR_ALL_SRC;
  const catchIdx = fnBlock.indexOf('} catch (e) {');
  assert.notEqual(catchIdx, -1);
  const afterCatch = fnBlock.slice(catchIdx, catchIdx + 400);
  assert.ok(afterCatch.includes('if (!isGuest)'), 'catch must guard with if (!isGuest)');
  assert.ok(afterCatch.includes('return;'), 'catch must return for authenticated users');
});

// ============================================================================
// TEST G — seq bump accounting (Phase 3 verification)
// ============================================================================
test('NOTIF-RETURN-G1: seq is bumped on EVERY mutation outcome (success/failure/non-success)', async () => {
  // This is the core fix: previously seq was bumped ONLY on success, leaving
  // the stale-response guard disarmed on failure. Now it's bumped on all 3.
  for (const apiMock of [
    async () => ({ status: 'success' }),
    async () => { throw new Error('fail'); },
    async () => ({ status: 'error' }),
  ]) {
    const mocks = makeMocks({ apiFetch: apiMock });
    const { fn, __getState } = loadFn(MARK_NOTIF_READ_SRC, "markNotifRead", mocks);
    const before = __getState()._notifReqSeq;
    await fn('n1');
    const after = __getState()._notifReqSeq;
    assert.ok(after > before, `seq must bump on this outcome (before=${before}, after=${after})`);
  }
});

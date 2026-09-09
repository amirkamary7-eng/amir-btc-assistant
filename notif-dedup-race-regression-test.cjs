/**
 * Notification Read/Delete Revert via apiFetch GET Dedup Race — Regression Test
 *
 * Confirmed bug: when a 60s poll's GET /api/notifications is in-flight and the
 * user mutates (markRead/delete/markAllRead/clearAll) THEN triggers another
 * GET (e.g. by opening the notification panel), the second GET's apiFetch
 * call RECEIVES THE FIRST CALL'S IN-FLIGHT PROMISE via the _requestInFlight
 * dedup map (app.js:6213-6217). When the FIRST promise settles with stale
 * data (DB query ran BEFORE the mutation committed), the second caller's
 * mySeq === _notifReqSeq seq guard PASSES (because no other mutation happened
 * between the second call and the response), so the stale data is applied
 * to the local `notifications` array, reverting the user's mutation.
 *
 * Fix (Option 1): after each mutation success, delete _requestInFlight['/api/notifications']
 *   so the next loadNotificationsFromServer() makes a FRESH GET (no stale dedup).
 *   PLUS: make apiFetch's .finally() cleanup IDENTITY-SAFE so the FIRST poll's
 *   .finally() does NOT WRONGLY DELETE the second GET's dedup entry.
 *
 * Required scenarios (per user spec):
 *   1. Read Race        — mutation invalidates P1; P2 starts; stale P1 does NOT revert.
 *   2. Delete Race      — same, for delete.
 *   3. Identity-safe cleanup — P1.finally() must NOT delete P2's dedup entry.
 *   4. Existing dedup   — apiFetch dedup for OTHER endpoints still works.
 *
 * Run: node --test notif-dedup-race-regression-test.cjs
 *
 * NOTE: This test uses the REAL apiFetch source (extracted from app.js) with
 * the REAL _requestInFlight dedup map. It does NOT mock apiFetch — it mocks
 * only the underlying fetch() and proves the fix at the apiFetch layer.
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Extract apiFetch from app.js source (robust to {} in default params).
// We need: apiFetch, _requestInFlight.
// ============================================================================

function makeRealApiFetchSandbox(mockFetch) {
  const _requestInFlight = {};
  const waitForApiReady = async () => {};
  const getTelegramInitData = () => null;
  const API_BASE = 'https://test.local';
  const fakeAbortSignal = { timeout: () => null };
  const fakeConsole = { warn: () => {}, log: () => {}, error: () => {} };

  // Find apiFetch body start (skip past parameter list to opening brace)
  const fnStart = appSrc.indexOf('async function apiFetch(');
  if (fnStart < 0) throw new Error('apiFetch not found in app.js');
  const openBraceIdx = appSrc.indexOf(') {', fnStart);
  if (openBraceIdx < 0) throw new Error('apiFetch body open brace not found');
  let depth = 0, end = -1, inStr = false, strCh = '';
  for (let i = openBraceIdx + 2; i < appSrc.length; i++) {
    const c = appSrc[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
      continue;
    }
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; continue; }
    if (c === '/' && appSrc[i+1] === '/') {
      while (i < appSrc.length && appSrc[i] !== '\n') i++;
      continue;
    }
    if (c === '{') depth++;
    if (c === '}') { depth--; if (depth === 0) { end = i; break; } }
  }
  if (end < 0) throw new Error('apiFetch end not found');
  const apiFetchSrc = appSrc.slice(fnStart, end + 1);

  const wrapped = `
    "use strict";
    ${apiFetchSrc}
    return { apiFetch, _requestInFlight };
  `;
  const factory = new Function(
    '_requestInFlight', 'fetch', 'waitForApiReady', 'getTelegramInitData',
    'API_BASE', 'console', 'AbortSignal', wrapped,
  );
  return factory(_requestInFlight, mockFetch, waitForApiReady, getTelegramInitData, API_BASE, fakeConsole, fakeAbortSignal);
}

// ============================================================================
// Sandbox: replicates the EXACT app.js seq-guard pattern PLUS the fix
// (delete _requestInFlight['/api/notifications'] after each mutation success).
//
// The `applyFix` flag controls whether the sandbox applies the invalidation.
// When false, the sandbox mirrors the PRE-FIX production code (no invalidation).
// Tests use applyFix=false to prove the bug occurs, and applyFix=true to prove
// the fix resolves it.
// ============================================================================

function makeSandbox(apiFetch, _requestInFlight, applyFix = true) {
  const state = {
    _notifReqSeq: 0,
    notifications: [],
  };

  async function loadNotificationsFromServer() {
    const mySeq = ++state._notifReqSeq;
    const data = await apiFetch('/api/notifications');
    // Stale-response guard (mirrors app.js:12514)
    if (mySeq !== state._notifReqSeq) {
      return { stale_dropped: true, mySeq, cur: state._notifReqSeq };
    }
    // Apply (mirrors app.js:12526)
    state.notifications = data.notifications.map(n => ({
      id: n.id,
      read: Boolean(n.read),
    }));
    return { applied: true, mySeq, notifications: state.notifications.slice() };
  }

  async function markNotifRead(id) {
    // Mirror app.js:12679 — bump1 BEFORE await (TOCTOU)
    state._notifReqSeq++;
    const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
    if (res && res.status === 'success') {
      const n = state.notifications.find(x => x.id === id);
      if (n) n.read = true;
      // Mirror app.js:12690 — bump2 AFTER mutation success
      state._notifReqSeq++;
      // FIX: invalidate the dedup entry so the next loadNotificationsFromServer
      // gets a fresh GET (not the stale in-flight promise).
      if (applyFix) delete _requestInFlight['/api/notifications'];
      return { success: true };
    }
    return { success: false };
  }

  async function deleteNotification(id) {
    state._notifReqSeq++;
    const res = await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' });
    if (res && res.status === 'success') {
      state.notifications = state.notifications.filter(n => n.id !== id);
      state._notifReqSeq++;
      // FIX: invalidate the dedup entry.
      if (applyFix) delete _requestInFlight['/api/notifications'];
      return { success: true };
    }
    return { success: false };
  }

  return { state, loadNotificationsFromServer, markNotifRead, deleteNotification };
}

// ============================================================================
// Mock fetch: simulates a SLOW GET (returns stale pre-mutation data) and an
// INSTANT POST/DELETE (mutations succeed and commit immediately).
// ============================================================================

function makeMockFetch(serverState, getDelayMs = 200) {
  let getCallCount = 0;
  return {
    impl: async (url, opts) => {
      const method = (opts?.method || 'GET').toUpperCase();
      if (url === 'https://test.local/api/notifications' && method === 'GET') {
        getCallCount++;
        // REAL DB semantics: the SELECT query runs AT THE START (before the
        // network delay). Snapshot the data NOW so any later mutations don't
        // appear in this response even though it arrives later.
        // This mirrors real PostgreSQL: SELECT returns a snapshot at the
        // moment the query executes, not at the moment the client receives.
        const snapshot = serverState.list.map(n => ({
          id: n.id, message: n.body, read: n.read, created_at: n.created_at,
        }));
        const unreadCount = serverState.list.filter(n => !n.read).length;
        await new Promise(r => setTimeout(r, getDelayMs));
        return {
          ok: true,
          json: async () => ({
            notifications: snapshot,
            unread_count: unreadCount,
          }),
        };
      }
      if (url.startsWith('https://test.local/api/notifications/') && method === 'POST') {
        // url = https://test.local/api/notifications/<id>/read
        const parts = url.split('/');
        const id = parts[5];
        // markNotifRead — server commits INSTANTLY
        const n = serverState.list.find(x => x.id === id);
        if (n) n.read = true;
        return { ok: true, json: async () => ({ status: 'success' }) };
      }
      if (url.startsWith('https://test.local/api/notifications/') && method === 'DELETE') {
        const parts = url.split('/');
        const id = parts[5];
        // deleteNotification — server soft-deletes INSTANTLY
        const idx = serverState.list.findIndex(x => x.id === id);
        if (idx >= 0) serverState.list.splice(idx, 1);
        return { ok: true, json: async () => ({ status: 'success' }) };
      }
      return { ok: true, json: async () => ({ status: 'error' }) };
    },
    getCallCount: () => getCallCount,
  };
}

// Helper: microtask + small delay to let promises settle predictably
const tick = (ms = 0) => new Promise(r => setTimeout(r, ms));
const immediate = () => new Promise(r => setImmediate(r));

// ============================================================================
// TEST 1: READ RACE — markNotifRead survives a subsequent
// loadNotificationsFromServer call that would otherwise reuse the stale GET
// ============================================================================

test('NOTIF-DEDUP-1: Read Race — mutation invalidates dedup; stale P1 GET does NOT revert read state; P2 fetches fresh', async () => {
  const serverState = {
    list: [
      { id: 'n1', body: 'A', read: false, created_at: '2026-01-01' },
      { id: 'n2', body: 'B', read: false, created_at: '2026-01-02' },
    ],
  };
  const mock = makeMockFetch(serverState, /*getDelayMs*/ 200);
  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mock.impl);
  const sandbox = makeSandbox(apiFetch, _requestInFlight, /*applyFix*/ true);

  // T=0: 60s poll fires. GET starts. _requestInFlight[/api/notifications] = P1.
  const pollPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  assert.ok(_requestInFlight['/api/notifications'],
    'T=0: in-flight GET promise should be registered in _requestInFlight');
  assert.equal(mock.getCallCount(), 1, 'T=0: exactly 1 GET call to fetch');
  const P1Ref = _requestInFlight['/api/notifications'];

  // T=50ms: User clicks mark-as-read on n1. POST resolves instantly.
  // After mutation success, the fix deletes _requestInFlight['/api/notifications'].
  await tick(50);
  const mr = await sandbox.markNotifRead('n1');
  assert.equal(mr.success, true, 'T=50: markNotifRead must succeed');
  // FIX ASSERTION: dedup entry must be invalidated after mutation success
  assert.equal(_requestInFlight['/api/notifications'], undefined,
    'T=50: dedup entry must be INVALIDATED after mutation success (the fix)');

  // T=100ms: User opens notification panel → loadNotificationsFromServer() again.
  // Without the fix: apiFetch would return P1 (still in-flight) → stale data race.
  // WITH the fix: P1's entry was deleted → apiFetch starts a FRESH fetch (P2).
  await tick(50);
  const panelPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  // P2 should be a DIFFERENT promise than P1 (new fetch was started)
  const P2Ref = _requestInFlight['/api/notifications'];
  assert.notStrictEqual(P2Ref, P1Ref,
    'T=100: P2 must be a NEW promise (fresh fetch) — fix prevented stale reuse');
  assert.equal(mock.getCallCount(), 2,
    'T=100: a SECOND GET must have been made (fresh fetch, not dedup)');

  // T=200ms+: P1 (stale) and P2 (fresh) both resolve.
  await pollPromise;   // P1's awaiter — should be dropped (mySeq=1 != cur)
  await panelPromise;  // P2's awaiter — should apply fresh data

  // CRITICAL ASSERTION: n1.read must remain TRUE (the mutation must survive).
  // P1 carried stale read=false; P2 carries fresh read=true.
  // With the fix: P1 dropped (stale), P2 applied (fresh, read=true).
  // Without the fix: P2 dedup-reuses P1, applies stale read=false → BUG.
  const n1 = sandbox.state.notifications.find(n => n.id === 'n1');
  assert.ok(n1, 'n1 must exist in state after P2 applied');
  assert.equal(n1.read, true,
    'n1.read must be true — P2 fetched fresh data AFTER the mutation commit (P1 dropped as stale)');
});

// ============================================================================
// TEST 1b: BUG DETECTION — without the fix, the read race IS reproduced
// (proves the test setup actually exercises the bug; will FAIL with applyFix=false,
//  proving the bug is real, not just a phantom)
// ============================================================================

test('NOTIF-DEDUP-1b: BUG DETECTION — without fix, markNotifRead REVERTS to unread via dedup stale promise (proves test exercises the bug)', async () => {
  const serverState = {
    list: [
      { id: 'n1', body: 'A', read: false, created_at: '2026-01-01' },
      { id: 'n2', body: 'B', read: false, created_at: '2026-01-02' },
    ],
  };
  const mock = makeMockFetch(serverState, /*getDelayMs*/ 200);
  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mock.impl);
  // Sandbox WITHOUT the fix (applyFix=false) — mirrors pre-fix production code.
  const sandbox = makeSandbox(apiFetch, _requestInFlight, /*applyFix*/ false);

  // T=0: poll starts. P1 in-flight.
  const pollPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  assert.ok(_requestInFlight['/api/notifications'], 'P1 in-flight');
  const P1Ref = _requestInFlight['/api/notifications'];

  // T=50ms: mark n1 read. Without the fix, NO dedup invalidation happens.
  await tick(50);
  const mr = await sandbox.markNotifRead('n1');
  assert.equal(mr.success, true);
  // WITHOUT fix: dedup entry STILL HOLDS P1 (stale).
  assert.strictEqual(_requestInFlight['/api/notifications'], P1Ref,
    'WITHOUT fix: dedup entry still holds P1 (stale) — bug present');

  // T=100ms: panel open → loadNotificationsFromServer again.
  // WITHOUT fix: apiFetch dedup returns the SAME P1 → stale data race.
  await tick(50);
  const panelPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  assert.strictEqual(_requestInFlight['/api/notifications'], P1Ref,
    'WITHOUT fix: P2 dedup-reuses P1 (no new fetch)');
  assert.equal(mock.getCallCount(), 1,
    'WITHOUT fix: only ONE fetch made (the stale P1)');

  // T=200ms+: P1 resolves with stale data.
  await pollPromise;
  await panelPromise;

  // 🚨 THE BUG: n1.read is FALSE (reverted to unread).
  // This test PROVES the bug exists without the fix.
  const n1 = sandbox.state.notifications.find(n => n.id === 'n1');
  assert.ok(n1, 'n1 must exist in state');
  assert.equal(n1.read, false,
    'WITHOUT fix: n1.read is REVERTED to false (stale P1 data via dedup) — bug confirmed');
});

// ============================================================================
// TEST 2: DELETE RACE — deleteNotification invalidates dedup; stale P1 GET
// does NOT re-add the deleted notification
// ============================================================================

test('NOTIF-DEDUP-2: Delete Race — mutation invalidates dedup; stale P1 GET does NOT re-add deleted notification; P2 fetches fresh', async () => {
  const serverState = {
    list: [
      { id: 'n1', body: 'A', read: false, created_at: '2026-01-01' },
      { id: 'n2', body: 'B', read: false, created_at: '2026-01-02' },
    ],
  };
  const mock = makeMockFetch(serverState, /*getDelayMs*/ 200);
  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mock.impl);
  const sandbox = makeSandbox(apiFetch, _requestInFlight, /*applyFix*/ true);

  // T=0: poll starts. P1 in-flight.
  const pollPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  assert.ok(_requestInFlight['/api/notifications'], 'P1 in-flight');
  const P1Ref = _requestInFlight['/api/notifications'];

  // T=50ms: user deletes n1. POST/DELETE resolves instantly. Fix invalidates dedup.
  await tick(50);
  const dr = await sandbox.deleteNotification('n1');
  assert.equal(dr.success, true, 'delete must succeed');
  assert.equal(_requestInFlight['/api/notifications'], undefined,
    'dedup entry must be INVALIDATED after delete success (the fix)');

  // T=100ms: panel open → loadNotificationsFromServer again.
  // WITH fix: fresh P2 fetch (not deduped against the deleted P1).
  await tick(50);
  const panelPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  const P2Ref = _requestInFlight['/api/notifications'];
  assert.notStrictEqual(P2Ref, P1Ref, 'P2 must be a fresh promise (not deduped against P1)');
  assert.equal(mock.getCallCount(), 2, 'second GET must have been made');

  // T=200ms+: both resolve.
  await pollPromise;
  await panelPromise;

  // CRITICAL ASSERTION: n1 must NOT exist in state (delete survived).
  // P1 carried stale data (n1 still present); P2 carried fresh data (n1 gone).
  // With the fix: P1 dropped (stale), P2 applied (fresh, no n1).
  // Without the fix: P2 dedup-reuses P1, re-adds n1 → BUG.
  const n1 = sandbox.state.notifications.find(n => n.id === 'n1');
  assert.equal(n1, undefined,
    'n1 must NOT exist in state after delete — P2 fetched fresh data AFTER the delete commit');
});

// ============================================================================
// TEST 2b: BUG DETECTION — without the fix, the delete race IS reproduced
// ============================================================================

test('NOTIF-DEDUP-2b: BUG DETECTION — without fix, deleted notification REAPPEARS via dedup stale promise (proves test exercises the bug)', async () => {
  const serverState = {
    list: [
      { id: 'n1', body: 'A', read: false, created_at: '2026-01-01' },
      { id: 'n2', body: 'B', read: false, created_at: '2026-01-02' },
    ],
  };
  const mock = makeMockFetch(serverState, /*getDelayMs*/ 200);
  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mock.impl);
  // Sandbox WITHOUT the fix (applyFix=false).
  const sandbox = makeSandbox(apiFetch, _requestInFlight, /*applyFix*/ false);

  const pollPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  const P1Ref = _requestInFlight['/api/notifications'];

  await tick(50);
  const dr = await sandbox.deleteNotification('n1');
  assert.equal(dr.success, true);
  assert.strictEqual(_requestInFlight['/api/notifications'], P1Ref,
    'WITHOUT fix: dedup entry still holds P1 (stale) — bug present');

  await tick(50);
  const panelPromise = sandbox.loadNotificationsFromServer();
  await immediate();
  assert.strictEqual(_requestInFlight['/api/notifications'], P1Ref,
    'WITHOUT fix: P2 dedup-reuses P1 (no new fetch)');
  assert.equal(mock.getCallCount(), 1, 'WITHOUT fix: only ONE fetch made (stale P1)');

  await pollPromise;
  await panelPromise;

  // 🚨 THE BUG: n1 REAPPEARS in state (re-added via stale P1 dedup).
  const n1 = sandbox.state.notifications.find(n => n.id === 'n1');
  assert.ok(n1, 'WITHOUT fix: n1 REAPPEARS in state (bug confirmed)');
  assert.equal(n1.read, false, 'WITHOUT fix: reappeared n1 is in stale unread state');
});

// ============================================================================
// TEST 3: IDENTITY-SAFE CLEANUP — P1.finally() must NOT delete P2's dedup entry
//
// Scenario (per user spec):
//   P1 stored in _requestInFlight
//   ↓
//   mutation invalidates P1
//   ↓
//   P2 stored in _requestInFlight
//   ↓
//   P1.finally() runs
//   ↓
//   P2 MUST remain in _requestInFlight
// ============================================================================

test('NOTIF-DEDUP-3: Identity-safe cleanup — P1.finally() must NOT delete P2\'s in-flight entry', async () => {
  // Custom mock with separate delays: P1 resolves faster (200ms), P2 takes longer (400ms).
  // So when P1 settles at T=200, P2 (started at T=100) is STILL IN-FLIGHT.
  // The identity-safe check in apiFetch .finally() must NOT delete P2's entry.
  let getCallCount = 0;
  const mockFetch = async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (url === 'https://test.local/api/notifications' && method === 'GET') {
      getCallCount++;
      // First call → P1 (delay 200ms). Second call → P2 (delay 400ms).
      const delay = getCallCount === 1 ? 200 : 400;
      await tick(delay);
      return { ok: true, json: async () => ({ notifications: [], unread_count: 0 }) };
    }
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mockFetch);

  // T=0: P1 starts.
  const P1 = apiFetch('/api/notifications');
  await immediate();
  assert.ok(_requestInFlight['/api/notifications'], 'P1 registered');
  const P1Ref = _requestInFlight['/api/notifications'];

  // T=50ms: mutation invalidates P1's entry (simulating the fix).
  await tick(50);
  delete _requestInFlight['/api/notifications'];
  assert.equal(_requestInFlight['/api/notifications'], undefined,
    'P1 entry invalidated by mutation');

  // T=100ms: panel open → P2 starts. P2 should be a NEW promise in the slot.
  await tick(50);
  const P2 = apiFetch('/api/notifications');
  await immediate();
  const P2Ref = _requestInFlight['/api/notifications'];
  assert.notStrictEqual(P2Ref, P1Ref, 'P2 is a new distinct promise');
  assert.strictEqual(_requestInFlight['/api/notifications'], P2Ref,
    'P2 stored in _requestInFlight');

  // T=200ms: P1 settles. Its .finally() runs.
  // CRITICAL: without identity-safe cleanup, P1.finally() would WRONGLY DELETE P2's entry.
  // WITH identity-safe cleanup (`if (_requestInFlight[dedupeKey] === promise)`):
  //   P1's check fails (entry === P2Ref, not P1Ref) → no delete → P2 preserved.
  await P1;
  assert.strictEqual(_requestInFlight['/api/notifications'], P2Ref,
    'P2 entry MUST remain in _requestInFlight after P1.finally() — identity-safe cleanup');

  // T=500ms: P2 settles. Its .finally() should clean up its own entry.
  await P2;
  assert.equal(_requestInFlight['/api/notifications'], undefined,
    'P2 entry cleared by P2.finally() after P2 settles');
});

// ============================================================================
// TEST 4: EXISTING DEDUP BEHAVIOR UNAFFECTED — apiFetch still dedupes
// concurrent GETs to the SAME path when no mutation invalidates the entry
// ============================================================================

test('NOTIF-DEDUP-4: Existing dedup behavior — concurrent GETs to same path still dedupe (no mutation)', async () => {
  let getCallCount = 0;
  const mockFetch = async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (url === 'https://test.local/api/notifications' && method === 'GET') {
      getCallCount++;
      await tick(50);
      return { ok: true, json: async () => ({ notifications: [{ id: 'n1', message: 'A', read: false, created_at: '2026-01-01' }], unread_count: 1 }) };
    }
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mockFetch);

  // Two concurrent GETs to the SAME path — dedup should make only ONE fetch.
  // Note: apiFetch is async, so the OUTER promise it returns wraps an INNER
  // promise. The inner promise is what's stored in _requestInFlight. The outer
  // promise is what callers receive. We test dedup behavior by:
  //   - Calling apiFetch twice (concurrent)
  //   - Verifying only ONE fetch was made (the second call deduped)
  //   - Verifying both callers receive the same RESPONSE data
  const P1 = apiFetch('/api/notifications');
  await immediate();
  assert.ok(_requestInFlight['/api/notifications'], 'P1 in-flight entry registered');

  const P2 = apiFetch('/api/notifications');
  await immediate();
  // Both P1 and P2 should resolve to the SAME response (since P2 deduped against P1).
  // The fetch count should still be 1 (no new fetch was made).
  assert.equal(getCallCount, 1,
    'only ONE fetch should have been made — dedup returned the existing in-flight promise');

  // Both awaiters receive the same response data.
  const [r1, r2] = await Promise.all([P1, P2]);
  assert.deepEqual(r1, r2,
    'both awaiters must receive the same response — dedup correctly returned the same in-flight promise');

  // After settling, _requestInFlight should be cleared.
  assert.equal(_requestInFlight['/api/notifications'], undefined,
    'dedup entry cleared after settle');
});

// ============================================================================
// TEST 5: DEDUP FOR OTHER ENDPOINTS UNAFFECTED — fix only touches
// '/api/notifications' dedup; other paths' dedup behavior is preserved.
// ============================================================================

test('NOTIF-DEDUP-5: Other endpoints — dedup for other paths is NOT affected by the notification fix', async () => {
  let walletGetCount = 0;
  const mockFetch = async (url, opts) => {
    const method = (opts?.method || 'GET').toUpperCase();
    if (url === 'https://test.local/api/wallet' && method === 'GET') {
      walletGetCount++;
      await tick(50);
      return { ok: true, json: async () => ({ status: 'success', balance: 100 }) };
    }
    return { ok: true, json: async () => ({ status: 'success' }) };
  };

  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mockFetch);

  // Two concurrent GETs to /api/wallet — should dedupe.
  const P1 = apiFetch('/api/wallet');
  await immediate();
  assert.ok(_requestInFlight['/api/wallet'], 'wallet GET registered');

  const P2 = apiFetch('/api/wallet');
  await immediate();
  // Simulate a notification mutation (which deletes _requestInFlight['/api/notifications'])
  // — this should NOT affect the wallet GET dedup entry.
  delete _requestInFlight['/api/notifications'];
  assert.ok(_requestInFlight['/api/wallet'],
    'wallet dedup entry is UNAFFECTED by notification mutation invalidation');

  // Only ONE wallet fetch should have been made (dedup).
  assert.equal(walletGetCount, 1,
    'only ONE wallet GET made (dedup works for non-notification paths)');

  // Both wallet awaiters should receive the same response.
  const [r1, r2] = await Promise.all([P1, P2]);
  assert.equal(r1.balance, 100);
  assert.equal(r2.balance, 100);
  assert.deepEqual(r1, r2, 'both awaiters received the same response (deduped against the same in-flight promise)');
});

// ============================================================================
// TEST 6: CLOSE/REOPEN + POLLING OVERLAP (sanity) — a fresh load after the
// invalidation+stale-settle pattern must reflect post-mutation state.
// ============================================================================

test('NOTIF-DEDUP-6: After mutation + invalidation, a fresh GET reflects post-mutation state (close/reopen simulation)', async () => {
  const serverState = {
    list: [
      { id: 'n1', body: 'A', read: false, created_at: '2026-01-01' },
      { id: 'n2', body: 'B', read: false, created_at: '2026-01-02' },
    ],
  };
  const mock = makeMockFetch(serverState, /*getDelayMs*/ 50); // fast GET
  const { apiFetch, _requestInFlight } = makeRealApiFetchSandbox(mock.impl);
  const sandbox = makeSandbox(apiFetch, _requestInFlight, /*applyFix*/ true);

  // Initial load — populates state from server.
  await sandbox.loadNotificationsFromServer();
  assert.equal(sandbox.state.notifications.length, 2, 'initial load: 2 notifications');

  // Mark n1 read. Fix invalidates dedup.
  const mr = await sandbox.markNotifRead('n1');
  assert.equal(mr.success, true);

  // A "close/reopen" — fresh loadNotificationsFromServer after the invalidation.
  // Should make a FRESH GET (no stale dedup) and reflect post-mutation state.
  const result = await sandbox.loadNotificationsFromServer();
  assert.equal(result.applied, true, 'fresh GET must be applied');
  const n1 = sandbox.state.notifications.find(n => n.id === 'n1');
  assert.equal(n1.read, true,
    'n1.read=true — fresh GET queried DB AFTER the mutation commit');
});

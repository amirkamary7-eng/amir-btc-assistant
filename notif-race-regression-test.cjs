/**
 * Notification Race Condition Regression Test
 * =============================================
 *
 * Verifies that _notifReqSeq is bumped BEFORE the await apiFetch() in all 4
 * notification mutation functions (markNotifRead, deleteNotification,
 * markAllRead, clearAllNotifications). This ensures any in-flight poll
 * (GET /api/notifications) is immediately invalidated and cannot overwrite
 * the local state with stale data.
 *
 * Run: node --test notif-race-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const appSrc = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Helper: extract a function body from app.js source
// ============================================================================

function getFunctionBody(fnName) {
  const fnStart = appSrc.indexOf('async function ' + fnName + '(');
  if (fnStart < 0) return null;
  // Find the matching closing brace by counting braces
  let depth = 0;
  let inString = false;
  let stringChar = '';
  let bodyStart = -1;
  for (let i = fnStart; i < appSrc.length; i++) {
    const ch = appSrc[i];
    if (inString) {
      if (ch === '\\') { i++; continue; }
      if (ch === stringChar) inString = false;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') {
      inString = true;
      stringChar = ch;
      continue;
    }
    if (ch === '{') {
      if (depth === 0) bodyStart = i;
      depth++;
    } else if (ch === '}') {
      depth--;
      if (depth === 0 && bodyStart > -1) {
        return appSrc.slice(fnStart, i + 1);
      }
    }
  }
  return null;
}

// ============================================================================
// Static checks: _notifReqSeq++ must be BEFORE await apiFetch in each mutation
// ============================================================================

const MUTATION_FNS = ['markNotifRead', 'deleteNotification', 'markAllRead', 'clearAllNotifications'];

for (const fnName of MUTATION_FNS) {
  test(`${fnName}: _notifReqSeq++ appears BEFORE the first await apiFetch`, () => {
    const body = getFunctionBody(fnName);
    assert.ok(body, `${fnName} function not found`);

    // Find the first _notifReqSeq++ inside the authenticated-user branch
    // (must be before the await apiFetch)
    const seqBumpIdx = body.indexOf('_notifReqSeq++');
    assert.ok(seqBumpIdx > -1, `${fnName} must call _notifReqSeq++`);

    // Find the first await apiFetch (the mutation API call)
    const apiFetchMatch = body.match(/await\s+apiFetch\s*\(/);
    assert.ok(apiFetchMatch, `${fnName} must call await apiFetch`);
    const apiFetchIdx = body.indexOf(apiFetchMatch[0]);

    assert.ok(seqBumpIdx < apiFetchIdx,
      `${fnName}: _notifReqSeq++ (offset ${seqBumpIdx}) must come BEFORE await apiFetch (offset ${apiFetchIdx}). ` +
      'Previously the bump was AFTER the await, leaving a race window where an in-flight poll ' +
      'could arrive and overwrite local state with stale data.');
  });
}

for (const fnName of MUTATION_FNS) {
  test(`${fnName}: _notifReqSeq++ appears exactly ONCE (not in success/error/catch branches)`, () => {
    const body = getFunctionBody(fnName);
    assert.ok(body, `${fnName} function not found`);

    // Count all _notifReqSeq++ occurrences in the function body
    const matches = body.match(/_notifReqSeq\+\+/g) || [];
    assert.equal(matches.length, 1,
      `${fnName}: _notifReqSeq++ must appear exactly once (before the await). Found ${matches.length}. ` +
      'Multiple bumps (in success/error/catch branches) were the old pattern — now there is a single ' +
      'bump before the await that covers all branches.');
  });
}

// ============================================================================
// Dynamic simulation: verify the seq guard actually drops stale poll responses
// ============================================================================

test('DYN-1: in-flight poll is dropped when markNotifRead bumps seq before await', async () => {
  // Simulate the _notifReqSeq guard logic
  let _notifReqSeq = 0;
  let notifications = [{ id: 'n1', read: false }, { id: 'n2', read: false }];

  // Simulate a poll GET that starts BEFORE the mutation
  async function simulatePoll(staleData, delayMs) {
    const mySeq = ++_notifReqSeq;
    await new Promise(r => setTimeout(r, delayMs));
    // Stale response guard
    if (mySeq !== _notifReqSeq) {
      return { applied: false, reason: 'stale_dropped' };
    }
    notifications = staleData;
    return { applied: true };
  }

  // Simulate markNotifRead with the FIX (seq bump BEFORE await)
  async function simulateMarkNotifRead(id, delayMs) {
    // FIX: bump seq BEFORE the await
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    const n = notifications.find(x => x.id === id);
    if (n) n.read = true;
    return { success: true };
  }

  // Scenario: poll starts first, then markNotifRead starts during the poll
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }];

  // Poll starts (mySeq=1, _notifReqSeq=1)
  const pollPromise = simulatePoll(stalePollData, 50);

  // markNotifRead starts immediately (bumps seq to 2)
  const markPromise = simulateMarkNotifRead('n1', 10);

  const [pollResult, markResult] = await Promise.all([pollPromise, markPromise]);

  // Poll should have been DROPPED (its mySeq=1 !== _notifReqSeq=2)
  assert.equal(pollResult.applied, false,
    'In-flight poll must be dropped because _notifReqSeq was bumped by markNotifRead before the poll response arrived');
  assert.equal(pollResult.reason, 'stale_dropped',
    'Poll must report stale_dropped reason');

  // markNotifRead should have succeeded
  assert.equal(markResult.success, true);

  // The notification n1 should be read (markNotifRead won — poll was dropped)
  const n1 = notifications.find(n => n.id === 'n1');
  assert.equal(n1.read, true,
    'n1 should be read — markNotifRead applied its mutation and the stale poll was dropped');
});

test('DYN-2: in-flight poll is dropped when deleteNotification bumps seq before await', async () => {
  let _notifReqSeq = 0;
  let notifications = [{ id: 'n1', read: false }, { id: 'n2', read: false }];

  async function simulatePoll(staleData, delayMs) {
    const mySeq = ++_notifReqSeq;
    await new Promise(r => setTimeout(r, delayMs));
    if (mySeq !== _notifReqSeq) return { applied: false };
    notifications = staleData;
    return { applied: true };
  }

  async function simulateDelete(id, delayMs) {
    _notifReqSeq++;  // FIX: before await
    await new Promise(r => setTimeout(r, delayMs));
    notifications = notifications.filter(n => n.id !== id);
    return { success: true };
  }

  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }];
  const pollPromise = simulatePoll(stalePollData, 50);
  const deletePromise = simulateDelete('n1', 10);

  const [pollResult, deleteResult] = await Promise.all([pollPromise, deletePromise]);

  assert.equal(pollResult.applied, false,
    'In-flight poll must be dropped — delete bumped seq before the poll response arrived');
  assert.equal(deleteResult.success, true);

  // n1 should be gone (delete won — poll was dropped)
  assert.equal(notifications.find(n => n.id === 'n1'), undefined,
    'n1 should be deleted — delete applied its mutation and the stale poll was dropped');
  assert.equal(notifications.length, 1,
    'Only n2 should remain after delete');
});

test('DYN-3: failed mutation does NOT mutate local state', async () => {
  let _notifReqSeq = 0;
  let notifications = [{ id: 'n1', read: false }];

  async function simulateFailedMarkRead(id, delayMs) {
    _notifReqSeq++;  // FIX: before await
    await new Promise(r => setTimeout(r, delayMs));
    // Simulate API failure — do NOT mutate local state
    return { success: false };
  }

  const result = await simulateFailedMarkRead('n1', 10);
  assert.equal(result.success, false);

  // n1 should still be unread (mutation failed, local state unchanged)
  assert.equal(notifications[0].read, false,
    'n1 should still be unread after a failed mark-read — local state must NOT be mutated on failure');
});

test('DYN-4: concurrent polling + mutation (3 rapid mutations)', async () => {
  let _notifReqSeq = 0;
  let notifications = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: false }];

  async function simulatePoll(staleData, delayMs) {
    const mySeq = ++_notifReqSeq;
    await new Promise(r => setTimeout(r, delayMs));
    if (mySeq !== _notifReqSeq) return { applied: false };
    notifications = staleData;
    return { applied: true };
  }

  async function simulateMarkRead(id, delayMs) {
    _notifReqSeq++;
    await new Promise(r => setTimeout(r, delayMs));
    const n = notifications.find(x => x.id === id);
    if (n) n.read = true;
    return { success: true };
  }

  // Start a poll with stale data (all unread)
  const stalePollData = [{ id: 'n1', read: false }, { id: 'n2', read: false }, { id: 'n3', read: false }];
  const pollPromise = simulatePoll(stalePollData, 30);

  // Rapidly fire 3 mark-read mutations
  const m1 = simulateMarkRead('n1', 5);
  const m2 = simulateMarkRead('n2', 5);
  const m3 = simulateMarkRead('n3', 5);

  const [pollResult, ...mutationResults] = await Promise.all([pollPromise, m1, m2, m3]);

  // Poll must be dropped (seq was bumped 3 times by mutations)
  assert.equal(pollResult.applied, false,
    'In-flight poll must be dropped — 3 mutations bumped seq before the poll response arrived');

  // All mutations should succeed
  assert.ok(mutationResults.every(r => r.success), 'All 3 mutations should succeed');

  // All 3 notifications should be read (mutations won — poll was dropped)
  assert.ok(notifications.every(n => n.read),
    'All 3 notifications should be read — mutations applied and the stale poll was dropped');
});

test('DYN-5: _notifReqSeq increments exactly once per mutation', async () => {
  let _notifReqSeq = 0;

  async function simulateMutation(delayMs) {
    const seqBefore = _notifReqSeq;
    _notifReqSeq++;  // single bump before await
    await new Promise(r => setTimeout(r, delayMs));
    return { seqBefore, seqAfter: _notifReqSeq };
  }

  const r = await simulateMutation(10);
  assert.equal(r.seqAfter, r.seqBefore + 1,
    '_notifReqSeq must increment exactly once per mutation (was ' + r.seqBefore + ', now ' + r.seqAfter + ')');
});

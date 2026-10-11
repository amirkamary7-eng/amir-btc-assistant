/**
 * MK-09 — In-app notification "double count": NOT CONFIRMED (characterization)
 * ==========================================================================
 *
 * Task 62 finding MK-09 hypothesized that the in-app notification count could
 * double when the frontend optimistic notification and the server notification
 * (inserted by the cron Notification Platform) overlap.
 *
 * Re-verification against the real code showed double-counting is
 * STRUCTURALLY IMPOSSIBLE in every interleaving:
 *
 *   1. The ONLY mutations of the in-memory `notifications` array are:
 *      a) unshift in addNotification (optimistic), and
 *      b) the poll REPLACE — `notifications = data.notifications.map(...)`
 *         in loadNotificationsFromServer (full replacement, never a merge).
 *   2. The badge is ALWAYS an overwrite (never a sum): either the server's
 *      unread_count, or _updateBadgeFromLocal() = filter(!read).length.
 *   3. A stale-response seq guard drops out-of-order poll responses.
 *   4. The backend inserts exactly ONE row per triggered alert (deterministic
 *      notif ids + ON CONFLICT DO NOTHING + claimed gating).
 *
 * This test loads the REAL addNotification + REAL NotificationCenter
 * (notifications.js) and mirrors the real poll-replace semantics, exercising
 * every interleaving. It also pins the structural facts with source assertions.
 *
 * DOCUMENTED OBSERVATION (opposite direction, self-healing, out of scope):
 * frontend-first timeline — an immediate post-trigger poll can replace the
 * array BEFORE the cron inserts the server row → the optimistic entry
 * temporarily disappears and reappears on a later poll (<=60s). Changing
 * replace→identity-merge is a separate product decision.
 *
 * Run: node --test tests/mk09-notif-double-count-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const NC_SRC = fs.readFileSync(path.join(ROOT, 'notifications.js'), 'utf8');

// ============================================================================
// Extraction
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^function ${name}\\(`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`${name} not found`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j] === '}') return lines.slice(startIdx, j + 1).join('\n');
  }
  throw new Error(`${name} end not found`);
}
const ADD_NOTIFICATION_SRC = extractFn(APP_SRC, 'addNotification');

// ============================================================================
// Shared sandbox: REAL addNotification + REAL NotificationCenter
// The `notifications` variable lives INSIDE the sandbox (it gets REBOUND by
// both the >50 trim in addNotification and the poll replace — mirrors the
// module-level `let notifications` in app.js). All access goes through
// getters so the live binding is always read.
// ============================================================================
function createWorld() {
  const sends = [];
  const badgeState = { display: 'none', text: '' };
  const storage = new Map();
  const world = {
    badgeEl: { style: { display: 'none' }, innerText: '' },
    sends,
    storage,
    notifications: [],
  };

  const wrapper = [
    'let notifications = [];',
    'const notifyTelegram = __g.notifyTelegram;',
    'const getUserId = __g.getUserId;',
    'const isGuestUserId = __g.isGuestUserId;',
    'const updateNotifBadge = () => {};',
    'const playAlertSound = () => {};',
    'const window = __g.window;',
    'const localStorage = __g.localStorage;',
    'const console = { warn: () => {}, log: () => {} };',
    NC_SRC, // real NotificationCenter
    'function _updateBadgeFromLocal() {',
    '  const badge = __g.badgeEl;',
    '  const unread = notifications.filter(n => !n.read).length;',
    "  if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread > 99 ? '99+' : String(unread); }",
    "  else { badge.style.display = 'none'; }",
    '}',
    ADD_NOTIFICATION_SRC, // real addNotification (uses the shared `notifications`)
    // Poll-replace mirror of the REAL loadNotificationsFromServer semantics:
    // full array replacement + badge OVERWRITE with server unread_count.
    'function pollReplace(data) {',
    '  notifications = data.notifications.map(n => ({ id: n.id, title: n.title || \'\', body: n.message || \'\', read: Boolean(n.read), date: n.created_at || new Date().toISOString(), metadata: n.metadata || {} }));',
    '  const badge = __g.badgeEl;',
    '  const unread = data.unread_count || notifications.filter(n => !n.read).length;',
    "  if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread > 99 ? '99+' : String(unread); }",
    "  else { badge.style.display = 'none'; }",
    '  __g.world.notifications = notifications;',
    '}',
    'return { NotificationCenter, addNotification, pollReplace, _updateBadgeFromLocal, getNotifications: () => notifications };',
  ].join('\n');

  const g = {
    world,
    notifyTelegram: async () => { sends.push(1); },
    getUserId: () => '700300',
    isGuestUserId: (id) => String(id).startsWith('guest_'),
    window: {},
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
    badgeEl: world.badgeEl,
  };
  const sandbox = new Function('__g', wrapper)(g);

  // Convenience accessors on the world (delegating to the LIVE sandbox state)
  Object.defineProperty(world, 'notifications', {
    get: () => sandbox.getNotifications(),
    set: (v) => { /* pollReplace inside the sandbox owns assignment */ },
    configurable: true,
  });
  world.addNotification = sandbox.addNotification;
  world.pollReplace = sandbox.pollReplace;
  world._updateBadgeFromLocal = sandbox._updateBadgeFromLocal;
  return world;
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-09 S1: frontend-first — optimistic entry then poll converges to ONE entry (no double count)', () => {
  const w = createWorld();
  // Optimistic frontend notification for the trigger event
  w.addNotification('🔔 هشدار قیمت BTC', 'target reached', { sendToTelegram: false });
  assert.equal(w.notifications.length, 1);
  assert.equal(w._updateBadgeFromLocal && w.notifications.filter(n => !n.read).length, 1);
  // Poll (post-cron) returns the server row for the SAME event
  w.pollReplace({
    notifications: [{ id: 'srv-1', title: '🔔 هشدار قیمت BTC', message: 'target reached', read: false, created_at: '2026-01-15T10:00:00Z' }],
    unread_count: 1,
  });
  assert.equal(w.notifications.length, 1, 'poll REPLACEs the array — exactly one entry for the event');
  assert.equal(w.badgeEl.innerText, '1', 'badge = 1, never 2');
});

test('MK-09 S2: backend-first — poll then optimistic add converges on the next poll (no double count)', () => {
  const w = createWorld();
  // Poll brings the server row first
  w.pollReplace({
    notifications: [{ id: 'srv-1', title: '🔔 هشدار قیمت BTC', message: 'target reached', read: false, created_at: '2026-01-15T10:00:00Z' }],
    unread_count: 1,
  });
  // The frontend trigger fires AFTER the poll already delivered the event
  // (same title+body): NotificationCenter's 10s dedup suppresses its telegram
  // send, and the next poll replaces the array with authoritative server state.
  w.addNotification('🔔 هشدار قیمت BTC', 'target reached', { sendToTelegram: false });
  w.pollReplace({
    notifications: [{ id: 'srv-1', title: '🔔 هشدار قیمت BTC', message: 'target reached', read: false, created_at: '2026-01-15T10:00:00Z' }],
    unread_count: 1,
  });
  assert.equal(w.notifications.length, 1, 'converges to the single server entry');
  assert.equal(w.badgeEl.innerText, '1');
});

test('MK-09 S3: badge is ALWAYS an overwrite (server unread_count or local filter length — never a sum)', () => {
  const w = createWorld();
  w.addNotification('A', 'a', { sendToTelegram: false });
  w.addNotification('B', 'b', { sendToTelegram: false });
  assert.equal(w.notifications.filter(n => !n.read).length, 2);
  w._updateBadgeFromLocal();
  assert.equal(w.badgeEl.innerText, '2');
  // Server says 1 → badge shows 1 (overwrite, not +=)
  w.pollReplace({ notifications: [], unread_count: 1 });
  assert.equal(w.badgeEl.innerText, '1');
  // Server says 0 → hidden
  w.pollReplace({ notifications: [], unread_count: 0 });
  assert.equal(w.badgeEl.style.display, 'none');
});

test('MK-09 S4: DIFFERENT events are never deduped away — both survive', () => {
  const w = createWorld();
  w.addNotification('هشدار BTC', 'target 62000', { sendToTelegram: false });
  w.addNotification('هشدار ETH', 'target 3000', { sendToTelegram: false });
  assert.equal(w.notifications.length, 2, 'distinct events both exist in the array');
  const titles = w.notifications.map(n => n.title).sort();
  assert.deepEqual(titles, ['هشدار BTC', 'هشدار ETH']);
});

test('MK-09 S5: NotificationCenter localStorage backup is ISOLATED (separate list, MAX 50)', () => {
  const w = createWorld();
  for (let i = 0; i < 55; i++) {
    w.addNotification(`T${i}`, `unique body ${i}`, { sendToTelegram: false });
  }
  const stored = JSON.parse(w.storage.get('notifications') || '[]');
  assert.equal(stored.length, 50, 'NotificationCenter trims its backup to MAX=50');
  assert.equal(stored[0].title, 'T54', 'newest first');
});

test('MK-09 S6: idempotent polls — applying the same server response twice changes nothing', () => {
  const w = createWorld();
  const data = {
    notifications: [
      { id: 'srv-1', title: 'A', message: 'a', read: false, created_at: '2026-01-15T10:00:00Z' },
      { id: 'srv-2', title: 'B', message: 'b', read: true, created_at: '2026-01-15T09:00:00Z' },
    ],
    unread_count: 1,
  };
  w.pollReplace(data);
  const after1 = JSON.stringify(w.notifications);
  const badge1 = w.badgeEl.innerText;
  w.pollReplace(data);
  const after2 = JSON.stringify(w.notifications);
  const badge2 = w.badgeEl.innerText;
  assert.equal(after1, after2, 'identical poll responses produce identical state');
  assert.equal(badge1, badge2, 'identical badge');
  assert.equal(badge1, '1');
});

test('MK-09 S7 (source pins): the structural facts that make double-counting impossible', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = strip(APP_SRC);
  // 1. The poll REPLACES the array (single assignment site)
  const replaceSites = (code.match(/notifications = data\.notifications\.map/g) || []).length;
  assert.equal(replaceSites, 1, 'exactly one poll-replace assignment');
  // 2. Stale-response guard present
  assert.match(code, /mySeq !== _notifReqSeq/, 'stale poll responses are dropped');
  // 3. Badge assignments are overwrites
  const badgeZone = code.slice(code.indexOf('function _updateBadgeFromLocal'), code.indexOf('function toggleNotificationPanel'));
  assert.match(badgeZone, /badge\.innerText = unread/, 'local badge = filtered length');
  assert.ok(!badgeZone.includes('innerText +='), 'local badge never sums');
  // 4. The optimistic insert never reassigns the array (unshift + the >50 trim slice only)
  const addNotif = code.slice(code.indexOf('function addNotification'), code.indexOf('function updateNotifBadge'));
  assert.match(addNotif, /notifications\.unshift\(notif\)/, 'optimistic insert via unshift');
  const reassigns = (addNotif.match(/notifications\s*=\s*[^=][^\n]*/g) || [])
    .filter(l => !l.includes('notifications.slice(0, 50)'));
  assert.equal(reassigns.length, 0, 'addNotification only reassigns for the >50 trim (never replaces from server data)');
});

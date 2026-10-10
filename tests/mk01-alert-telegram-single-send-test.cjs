/**
 * MK-01 — Alert registration sends EXACTLY ONE Telegram confirmation
 * ================================================================
 *
 * Bug (Task 62 audit, Bug 1): a single valid price-alert registration produced
 * TWO identical Telegram confirmation messages, because the send path forked:
 *
 *   setPriceAlert → addNotification(title, body)            [no options → sendToTelegram:true]
 *     ├─ NotificationCenter.add(...)                         → notifyTelegram()  = SEND 1
 *     └─ (direct block in app.js addNotification)            → notifyTelegram()  = SEND 2
 *
 * Both sends hit POST /api/notify nearly simultaneously; the backend burst lock
 * (KV read-then-write, non-atomic) cannot de-duplicate concurrent requests, so
 * the user received 2 messages and the 5/day notify quota burned 2× per alert.
 *
 * FIX: the direct notifyTelegram block in app.js addNotification was removed.
 * NotificationCenter.add() (notifications.js) is now the SINGLE Telegram owner,
 * keeping its 10s dedup, guest gating, localStorage backup and sound logic.
 *
 * This test loads the REAL addNotification (extracted from app.js) and the REAL
 * notifications.js NotificationCenter into a shared sandbox with mocked leaf
 * dependencies, and counts actual notifyTelegram invocations.
 *
 * Pre-fix: S1 FAIL (2 sends) and S4 FAIL (3 sends on rapid double pattern).
 * Post-fix: all 6 scenarios pass.
 *
 * Run: node --test tests/mk01-alert-telegram-single-send-test.cjs
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
// Extraction helpers
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^function ${name}\\(`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`Function ${name} start not found`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j] === '}') {
      return lines.slice(startIdx, j + 1).join('\n');
    }
  }
  throw new Error(`Function ${name} end not found`);
}

const ADD_NOTIFICATION_SRC = extractFn(APP_SRC, 'addNotification');

// ============================================================================
// Sandbox: real addNotification + real NotificationCenter, mocked leaves
// ============================================================================
function createSandbox(opts = {}) {
  const userId = opts.userId ?? '700000001';
  const sends = [];              // actual notifyTelegram invocations
  const badgeUpdates = [];
  const sounds = [];
  const storage = new Map();

  const g = {
    // notifyTelegram is SHARED by both files — this is what we count.
    notifyTelegram: async (message) => { sends.push(message); return { ok: true }; },
    getUserId: () => userId,
    isGuestUserId: (id) => String(id).startsWith('guest_'),
    updateNotifBadge: () => { badgeUpdates.push(Date.now()); },
    playAlertSound: () => { sounds.push(Date.now()); },
    _updateBadgeFromLocal: () => { badgeUpdates.push(Date.now()); },
    console: { warn: () => {}, log: () => {} },
    localStorage: {
      getItem: (k) => (storage.has(k) ? storage.get(k) : null),
      setItem: (k, v) => storage.set(k, String(v)),
      removeItem: (k) => storage.delete(k),
    },
  };
  g.window = { AudioContext: undefined, webkitAudioContext: undefined };

  const wrapper = [
    'let notifications = [];',
    'const notifyTelegram = __g.notifyTelegram;',
    'const getUserId = __g.getUserId;',
    'const isGuestUserId = __g.isGuestUserId;',
    'const updateNotifBadge = __g.updateNotifBadge;',
    'const playAlertSound = __g.playAlertSound;',
    'const _updateBadgeFromLocal = __g._updateBadgeFromLocal;',
    'const window = __g.window;',
    'const localStorage = __g.localStorage;',
    'const console = __g.console;',
    NC_SRC, // defines const NotificationCenter + window.NotificationCenter = NotificationCenter
    ADD_NOTIFICATION_SRC,
    'function __getNotifications() { return notifications; }',
    'return { NotificationCenter, addNotification, __getNotifications, window };',
  ].join('\n');

  const evaluator = new Function('__g', wrapper);
  const sandbox = evaluator(g);
  return { ...sandbox, _sends: sends, _badgeUpdates: badgeUpdates, _sounds: sounds, _storage: storage };
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-01 S1: one alert registration sends EXACTLY ONE Telegram message', () => {
  const sb = createSandbox();
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  assert.equal(sb._sends.length, 1, `expected exactly 1 Telegram send, got ${sb._sends.length}`);
  assert.match(sb._sends[0], /BTCUSDT/);
  assert.match(sb._sends[0], /62000/);
});

test('MK-01 S2: guest users get ZERO Telegram sends (guest gating preserved)', () => {
  const sb = createSandbox({ userId: 'guest_abc123' });
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  assert.equal(sb._sends.length, 0, 'guest must never trigger a Telegram send');
  // in-app notification still created locally for the guest
  assert.equal(sb.__getNotifications().length, 1);
});

test('MK-01 S3: NotificationCenter 10s dedup still suppresses repeat sends', () => {
  const sb = createSandbox();
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  // Same title+body within the 10s dedup window — NotificationCenter returns null
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  assert.equal(sb._sends.length, 1, 'dedup must suppress the duplicate telegram send');
});

test('MK-01 S4: rapid double-registration pattern is bounded to ONE Telegram message', () => {
  // Pre-fix this pattern produced 3 sends (2 + suppressed-NC + 1 direct).
  const sb = createSandbox();
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  assert.equal(sb._sends.length, 1, `rapid repeats must stay deduped to 1 send, got ${sb._sends.length}`);
});

test('MK-01 S5: in-app notification, badge and sound behavior preserved (P0-7/P0-4)', () => {
  const sb = createSandbox();
  sb.addNotification('هشدار قیمت', 'BTCUSDT → $62000.00');
  // P0-7: in-memory array populated (badge/panel source of truth)
  const notifs = sb.__getNotifications();
  assert.equal(notifs.length, 1);
  assert.equal(notifs[0].title, 'هشدار قیمت');
  assert.equal(notifs[0].read, false);
  // P0-4: local badge computed
  assert.ok(sb._badgeUpdates.length >= 1, 'badge update must run');
  // Sound: app.js passes playSound:false to NotificationCenter and plays once itself
  assert.equal(sb._sounds.length, 1);
  // NotificationCenter localStorage backup still written
  const stored = sb._storage.get('notifications');
  assert.ok(stored, 'NotificationCenter localStorage backup must exist');
});

test('MK-01 S6 (source): app.js addNotification has NO direct notifyTelegram call — NotificationCenter is the single Telegram owner', () => {
  // Strip // line comments so explanatory text (which may mention the function)
  // does not false-positive the call-site scan.
  const stripComments = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const execSrc = stripComments(ADD_NOTIFICATION_SRC);

  // The extracted real addNotification must not contain a direct send call.
  assert.ok(!/notifyTelegram\s*\(/.test(execSrc),
    'addNotification must not call notifyTelegram directly (MK-01 regression)');

  // Repo-wide: the ONLY notifyTelegram( call-site must live in notifications.js
  // (app.js:9557 is the async function DEFINITION, not a call).
  const appCalls = [];
  stripComments(APP_SRC).split('\n').forEach((line, i) => {
    if (/notifyTelegram\s*\(/.test(line) && !/^async function notifyTelegram\(/.test(line)) {
      appCalls.push(`line ${i + 1}`);
    }
  });
  assert.equal(appCalls.length, 0, `app.js must have zero notifyTelegram call-sites, found at: ${appCalls.join(' | ')}`);

  const ncCallSites = (stripComments(NC_SRC).match(/notifyTelegram\s*\(/g) || []).length;
  assert.equal(ncCallSites, 1, `notifications.js must own exactly one send call-site, found ${ncCallSites}`);
});

/**
 * PERF-12 (Phase 40) — Shared AudioContext regression tests
 * ==========================================================
 *
 * Bug: NotificationCenter.playSound() created a NEW AudioContext on every
 * call and never closed it. Browsers cap simultaneous AudioContexts (~6 in
 * Chrome/Safari), so after roughly six notifications the sound silently died
 * mid-session; each leaked context also kept a native audio graph in memory.
 *
 * Fix: ONE lazily-created module-level shared context (_sharedAudioCtx) with
 * explicit state handling — suspended → resume(), closed → recreate,
 * pagehide → close(), creation failure → legacy per-play fallback.
 *
 * These tests evaluate the REAL notifications.js inside a sandbox with a
 * counting/failing mock AudioContext (same new Function pattern as
 * mk01-alert-telegram-single-send-test.cjs) and verify:
 *   1. 10 consecutive plays create exactly ONE shared context
 *   2. The notification tone is actually scheduled every play (audible
 *      behavior preserved — oscillators with the 660/880 two-tone envelope)
 *   3. Suspended contexts get resume()d — the state is never ignored
 *   4. Closed contexts are dropped and re-created on the next play
 *   5. pagehide closes the shared context and clears the reference
 *   6. AudioContext-unsupported environments stay silent (no throw)
 *   7. Creation failure falls back to a per-play context (still audible)
 *   8. Error inside scheduling is caught and warned, not thrown
 *   9. NotificationCenter.add() with sound still triggers playSound, and
 *      add() behavior (dedup/localStorage/telegram gating) is unchanged
 *
 * Run: node --test tests/perf12-audiocontext-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NC_SRC = fs.readFileSync(path.join(ROOT, 'notifications.js'), 'utf8');

// ============================================================================
// Mock AudioContext — counts constructions, records scheduling, can fail
// ============================================================================
function createMockAudioClass(opts = {}) {
  const state = {
    constructed: 0,       // number of `new AudioCtx()` calls
    closed: 0,           // number of close() calls
    resumed: 0,          // number of resume() calls
    oscillators: [],      // all oscillators ever scheduled
    lastCtx: null,
  };

  class MockAudioContext {
    constructor() {
      state.constructed++;
      this.state = opts.initialState || 'running';
      this.currentTime = 0;
      this.destination = { __destination: true };
      state.lastCtx = this;
    }
    createOscillator() {
      const osc = {
        type: 'sine',
        frequency: { value: 0, setValueAtTime() {} },
        connect() {},
        start() { osc._started = true; },
        stop() { osc._stopped = true; },
        _started: false,
        _stopped: false,
      };
      state.oscillators.push(osc);
      return osc;
    }
    createGain() {
      const gain = {
        gain: { setValueAtTime() {}, exponentialRampToValueAtTime() {}, linearRampToValueAtTime() {} },
        connect() {},
      };
      return gain;
    }
    resume() {
      state.resumed++;
      if (this.state === 'suspended') this.state = 'running';
      return Promise.resolve();
    }
    close() {
      state.closed++;
      this.state = 'closed';
      return Promise.resolve();
    }
    // Test hook: simulate a scheduling-time failure on demand
    setFailNextSchedule(fail) { this.__failSchedule = !!fail; }
  }
  if (opts.failConstruction) {
    // First construction throws (simulating the browser context cap), then a
    // flag can flip the class back to succeeding — modeling an environment
    // where later construction attempts succeed (the fallback path).
    let failRemaining = opts.failTimes ?? 1;
    class FlakyAudioContext extends MockAudioContext {
      constructor() {
        if (failRemaining > 0) {
          failRemaining--;
          throw new Error(opts.failConstruction);
        }
        super();
      }
    }
    FlakyAudioContext.__stopFailing = () => { failRemaining = 0; };
    return { AudioContext: FlakyAudioContext, state };
  }
  return { AudioContext: MockAudioContext, state };
}

// ============================================================================
// Sandbox builder — evaluates the REAL notifications.js with mocked leaves
// ============================================================================
function createSandbox(opts = {}) {
  const mock = createMockAudioClass(opts);
  const pagehideHandlers = [];
  const window = {
    AudioContext: mock.AudioContext,
    webkitAudioContext: undefined,
    addEventListener: (evt, handler) => {
      if (evt === 'pagehide') pagehideHandlers.push(handler);
    },
  };
  const storage = new Map();
  const localStorage = {
    getItem: (k) => (storage.has(k) ? storage.get(k) : null),
    setItem: (k, v) => storage.set(k, String(v)),
    removeItem: (k) => storage.delete(k),
  };
  const telegramSends = [];
  const badgeUpdates = [];

  const g = {
    notifyTelegram: async (message) => { telegramSends.push(message); return { ok: true }; },
    getUserId: () => opts.userId ?? '700000001',
    isGuestUserId: (id) => String(id).startsWith('guest_'),
    updateNotifBadge: () => { badgeUpdates.push(Date.now()); },
    console: { warn: (m, e) => { (g._warns = g._warns || []).push(m); }, log: () => {} },
  };

  const wrapper = [
    'const window = __g.window;',
    'const localStorage = __g.localStorage;',
    'const notifyTelegram = __g.notifyTelegram;',
    'const getUserId = __g.getUserId;',
    'const isGuestUserId = __g.isGuestUserId;',
    'const updateNotifBadge = __g.updateNotifBadge;',
    'const console = __g.console;',
    NC_SRC, // defines NotificationCenter (+ shared AudioContext region + pagehide listener)
    'return { NotificationCenter, window };',
  ].join('\n');

  const evaluator = new Function('__g', wrapper);
  g.window = window;
  g.localStorage = localStorage;
  const sandbox = evaluator(g);

  return {
    NotificationCenter: sandbox.NotificationCenter,
    window,
    mock: mock.state,
    pagehideHandlers,
    firePagehide: () => pagehideHandlers.forEach((h) => h()),
    storage,
    telegramSends,
    badgeUpdates,
    warns: () => g._warns || [],
  };
}

// ============================================================================
// S1 — The core PERF-12 acceptance test
// ============================================================================
test('PERF-12 S1: 10 consecutive playSound() calls create exactly ONE shared AudioContext', () => {
  const sb = createSandbox();
  for (let i = 0; i < 10; i++) sb.NotificationCenter.playSound();
  assert.equal(sb.mock.constructed, 1,
    `expected exactly 1 AudioContext construction for 10 plays, got ${sb.mock.constructed}`);
});

test('PERF-12 S2: every play schedules the full two-tone chime (audible behavior preserved)', () => {
  const sb = createSandbox();
  const PLAYS = 10;
  for (let i = 0; i < PLAYS; i++) sb.NotificationCenter.playSound();
  assert.equal(sb.mock.oscillators.length, PLAYS * 2,
    `each play must schedule 2 oscillators (660+880 Hz), got ${sb.mock.oscillators.length} for ${PLAYS} plays`);
  const started = sb.mock.oscillators.filter((o) => o._started);
  const stopped = sb.mock.oscillators.filter((o) => o._stopped);
  assert.equal(started.length, sb.mock.oscillators.length, 'every oscillator must be started');
  assert.equal(stopped.length, sb.mock.oscillators.length, 'every oscillator must be stopped');
});

// ============================================================================
// S3 — Lifecycle states are handled, never ignored
// ============================================================================
test('PERF-12 S3: suspended context is resumed before use (autoplay policy path)', () => {
  const sb = createSandbox({ initialState: 'suspended' });
  sb.NotificationCenter.playSound();
  sb.NotificationCenter.playSound();
  assert.ok(sb.mock.resumed >= 1,
    'suspended shared context must be resume()d — state must never be ignored');
  assert.equal(sb.mock.constructed, 1, 'still exactly one context');
});

test('PERF-12 S4: closed context is dropped and re-created on next play (bfcache restore path)', () => {
  const sb = createSandbox();
  sb.NotificationCenter.playSound();
  assert.equal(sb.mock.constructed, 1);
  // Simulate browser/bfcache closing the shared context
  sb.window.AudioContext && (sb.mock.lastCtx.state = 'closed');
  sb.NotificationCenter.playSound();
  assert.equal(sb.mock.constructed, 2,
    'a closed context must be re-created (closed contexts can never resume)');
  assert.equal(sb.mock.oscillators.length, 4, 'both plays scheduled their tones');
});

test('PERF-12 S5: pagehide closes the shared context and clears the reference', () => {
  const sb = createSandbox();
  sb.NotificationCenter.playSound();
  assert.equal(sb.mock.constructed, 1);
  sb.firePagehide();
  assert.equal(sb.mock.closed, 1, 'pagehide must close() the shared context');
  assert.equal(sb.mock.lastCtx.state, 'closed', 'context state is closed after pagehide');
  // Next play after bfcache restore creates a fresh context
  sb.NotificationCenter.playSound();
  assert.equal(sb.mock.constructed, 2, 'next play after pagehide re-creates the context');
});

// ============================================================================
// S6-S8 — Error handling
// ============================================================================
test('PERF-12 S6: no AudioContext support → silent no-op (no throw, no warn)', () => {
  const sb = createSandbox();
  // Override window with no AudioContext at all
  sb.window.AudioContext = undefined;
  assert.doesNotThrow(() => sb.NotificationCenter.playSound());
  assert.equal(sb.mock.constructed, 0, 'nothing constructed when unsupported');
  assert.equal(sb.warns().length, 0, 'unsupported browser is not an error (old behavior: silent return)');
});

test('PERF-12 S7: shared-context creation failure → legacy per-play fallback stays audible', () => {
  // Model: the browser context cap makes the FIRST construction throw, but
  // subsequent constructions succeed (a context was freed / cap is soft).
  // _getSharedAudioCtx() catches the failure and returns null → playSound's
  // fallback branch constructs its own context → tone still scheduled.
  const sb = createSandbox({ failConstruction: 'quota exceeded' });
  sb.NotificationCenter.playSound(); // 1st: shared creation throws → fallback constructs
  sb.NotificationCenter.playSound(); // shared still unset → fallback constructs again
  assert.equal(sb.mock.constructed, 2,
    `fallback must construct a per-play context so sound still works, got ${sb.mock.constructed}`);
  assert.equal(sb.mock.oscillators.length, 4, 'tone still scheduled on fallback contexts');
});

test('PERF-12 S8: scheduling failure inside playSound is caught + warned, never thrown', () => {
  const sb = createSandbox();
  // Sabotage the shared context's createOscillator on first use
  const orig = sb.window.AudioContext.prototype.createOscillator;
  sb.window.AudioContext.prototype.createOscillator = function () { throw new Error('boom'); };
  assert.doesNotThrow(() => sb.NotificationCenter.playSound(),
    'playSound must never throw into notification flows');
  assert.ok(sb.warns().some((w) => String(w).includes('Notification sound failed')),
    'failure must be logged via console.warn');
  sb.window.AudioContext.prototype.createOscillator = orig;
});

// ============================================================================
// S9 — NotificationCenter.add() behavior unchanged end-to-end
// ============================================================================
test('PERF-12 S9: add() still plays sound + dedup + localStorage + telegram gating (behavior preserved)', () => {
  const sb = createSandbox();
  const n1 = sb.NotificationCenter.add('هشدار قیمت', 'BTC → $62000', { sendToTelegram: true });
  assert.ok(n1, 'first add returns the notif');
  assert.equal(sb.mock.constructed, 1, 'exactly one shared context after one add');
  assert.equal(sb.mock.oscillators.length, 2, 'one tone scheduled');
  assert.equal(sb.telegramSends.length, 1, 'telegram sent once');
  assert.ok(sb.storage.has('notifications'), 'localStorage backup written');
  assert.ok(sb.badgeUpdates.length >= 1, 'badge updated');
  // 10s dedup suppresses the duplicate (sound + telegram + storage)
  const n2 = sb.NotificationCenter.add('هشدار قیمت', 'BTC → $62000');
  assert.equal(n2, null, 'duplicate add returns null');
  assert.equal(sb.telegramSends.length, 1, 'no second telegram send');
  assert.equal(sb.mock.oscillators.length, 2, 'no second tone');
  // silent option still suppresses sound
  sb.NotificationCenter.add('بی‌صدا', 'متن', { playSound: false, silent: true, sendToTelegram: false });
  assert.equal(sb.mock.oscillators.length, 2, 'silent add plays no tone');
});

test('PERF-12 S10: rapid multi-notification burst (the ~6-context death scenario) stays on ONE context', () => {
  const sb = createSandbox();
  // 12 DISTINCT notifications (dedup needs unique title/body) — pre-fix this
  // constructed 12 AudioContexts and crossed the ~6 browser cap; post-fix: 1.
  for (let i = 0; i < 12; i++) {
    sb.NotificationCenter.add(`عنوان ${i}`, `متن ${i}`, { sendToTelegram: false });
  }
  assert.equal(sb.mock.constructed, 1,
    `12-notification burst must share ONE context, got ${sb.mock.constructed}`);
  assert.equal(sb.mock.oscillators.length, 24, 'every notification scheduled its tone');
});

// ============================================================================
// Static source checks
// ============================================================================
test('PERF-12 P1 (static): playSound no longer constructs an AudioContext directly', () => {
  const playFnStart = NC_SRC.indexOf('playSound() {');
  assert.ok(playFnStart > -1, 'playSound must exist');
  const playFnEnd = NC_SRC.indexOf('_dedupKey(', playFnStart);
  const playBody = NC_SRC.slice(playFnStart, playFnEnd);
  assert.ok(!/new AudioCtx\(\)/.test(playBody) || !/\bnew AudioCtx\b/.test(playBody.replace(/fallbackCtx = new AudioCtx\(\);/, '')),
    'playSound must not construct the shared context inline (only the explicit fallback branch may)');
  assert.ok(playBody.includes('_getSharedAudioCtx()'), 'playSound uses the shared context getter');
  assert.ok(playBody.includes('_scheduleNotificationTone'), 'playSound delegates tone scheduling');
});

test('PERF-12 P2 (static): shared context is module-level and lazily created', () => {
  assert.ok(NC_SRC.includes('let _sharedAudioCtx = null;'), 'module-level shared context exists');
  assert.ok(NC_SRC.includes('function _getSharedAudioCtx()'), 'lazy getter exists');
});

test('PERF-12 P3 (static): pagehide closes the shared context', () => {
  assert.ok(/pagehide/.test(NC_SRC), 'pagehide listener registered');
  assert.ok(/_sharedAudioCtx\.close\(\)/.test(NC_SRC), 'pagehide handler closes the shared context');
});

test('PERF-12 P4 (static): tone envelope identical to pre-fix (660/880 Hz, sine, 0.12 offset)', () => {
  const toneFn = NC_SRC.slice(NC_SRC.indexOf('function _scheduleNotificationTone'),
    NC_SRC.indexOf('const NotificationCenter'));
  assert.ok(toneFn.includes('[660, 880].forEach((freq, i)'), 'two-tone frequencies preserved');
  assert.ok(toneFn.includes("osc.type = 'sine'"), 'sine wave preserved');
  assert.ok(toneFn.includes('i * 0.12'), 'inter-tone offset preserved');
  assert.ok(toneFn.includes('exponentialRampToValueAtTime(0.2, start + 0.02)'), 'attack envelope preserved');
  assert.ok(toneFn.includes('exponentialRampToValueAtTime(0.0001, start + 0.28)'), 'release envelope preserved');
});

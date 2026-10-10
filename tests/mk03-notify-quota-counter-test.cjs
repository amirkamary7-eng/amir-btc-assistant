/**
 * MK-03 — /api/notify daily quota counter characterization
 * ========================================================
 *
 * Task 62 audit finding MK-03: the 5/day per-user notify quota used a
 * read-check-write KV counter with a non-atomic burst lock. Analysis:
 *
 *  1. The 2× quota burn per alert (the user-visible symptom) was the MK-01
 *     frontend double-send — fixed at source in MK-01. Post-MK-01 there is
 *     exactly ONE notifyTelegram call-site (NotificationCenter.add behind its
 *     10s dedup), so no realistic same-instant request pair exists.
 *  2. The residual read-check-write race (two reads before either write →
 *     under-count) requires same-instant requests; the 2s burst lock catches
 *     arrivals ≥ms apart. Atomic alternatives (Durable Objects / SQL) are
 *     architecture changes whose necessity is not proven → NOT applied.
 *  3. UTC day boundary is standard and deterministic (getTodayIsoDate).
 *  4. readRateLimitCache fails CLOSED (no binding → null → treated as 0);
 *     writeRateLimitCache fails OPEN (put error → warn + continue).
 *  5. The counter increments BEFORE body validation and BEFORE the send
 *     (attempt semantics — failed sends consume quota) — documented accepted.
 *
 * This characterization test locks in the CURRENT contract with the REAL
 * controller (source-extracted createNotifyHandlers) and the REAL KV helpers
 * (readRateLimitCache/writeRateLimitCache extracted from worker-proxy.js)
 * over a mock KV namespace, so any future change to quota semantics must
 * consciously update this file.
 *
 * Run: node --test tests/mk03-notify-quota-counter-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const NOTIFY_CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/notify.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');

// ============================================================================
// Source extraction (project is CommonJS; src/ uses ESM `export function`)
// ============================================================================
function loadCreateNotifyHandlers() {
  const transformed = NOTIFY_CTRL_SRC.replace(/^export function createNotifyHandlers\(/m, 'function createNotifyHandlers(');
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'console', transformed + '\nmodule.exports.createNotifyHandlers = createNotifyHandlers;');
  wrapper(moduleObj, moduleObj.exports, { warn: () => {}, log: () => {}, error: () => {} });
  return moduleObj.exports.createNotifyHandlers;
}

function extractAsyncFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^async function ${name}\\(`);
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

// REAL KV helpers (module-level in worker-proxy.js)
const KV_HELPERS_SRC = [
  extractAsyncFn(WORKER_SRC, 'readRateLimitCache'),
  extractAsyncFn(WORKER_SRC, 'writeRateLimitCache'),
].join('\n');

function loadKvHelpers() {
  const moduleObj = { exports: {} };
  const wrapper = new Function('module', 'exports', 'console',
    KV_HELPERS_SRC + '\nmodule.exports = { readRateLimitCache, writeRateLimitCache };');
  wrapper(moduleObj, moduleObj.exports, { warn: (m) => moduleObj.exports.__warns.push(m), log: () => {}, error: () => {} });
  moduleObj.exports.__warns = [];
  return moduleObj.exports;
}

// ============================================================================
// Mock KV namespace with TTL + virtual clock (+ access journal)
// ============================================================================
function createMockKV(clock, opts = {}) {
  const store = new Map();       // key → { value, expiresAt }
  const journal = { reads: [], writes: [] };
  const neverSeeWrites = opts.neverSeeWrites === true; // simulates stale/never-propagated reads
  const kv = {
    async get(key) {
      journal.reads.push(key);
      if (neverSeeWrites) return null;
      const e = store.get(key);
      if (!e) return null;
      if (clock.now >= e.expiresAt) { store.delete(key); return null; }
      return e.value;
    },
    async put(key, value, options) {
      journal.writes.push({ key, value, ttl: options?.expirationTtl });
      if (neverSeeWrites) return;
      store.set(key, { value, expiresAt: clock.now + (Number(options?.expirationTtl) || 60) * 1000 });
    },
    _store: store,
    _journal: journal,
  };
  return kv;
}

// ============================================================================
// Harness: real controller + real KV helpers over mock KV
// ============================================================================
function createHarness(opts = {}) {
  const clock = { now: Date.parse('2026-01-15T10:00:00Z') };
  const kv = createMockKV(clock, opts);
  const kvHelpers = loadKvHelpers();
  let today = opts.today ?? '2026-01-15';
  const uid = opts.uid ?? '700100';
  const sends = [];
  const authErrors = opts.authError === true;

  const handlers = loadCreateNotifyHandlers()({
    jsonResponse: (body, init) => ({ __resp: true, status: init?.status ?? 200, body }),
    authenticateTelegramRequest: async () => (authErrors ? { error: { __resp: true, status: 401, body: { status: 'error' } } } : { user: { id: uid } }),
    readJsonBody: async (request) => ({ payload: request.__body }),
    normalizeOptionalString: (v) => (typeof v === 'string' ? v.trim() : null),
    buildBodyFieldValidationError: (field, type, msg, input, extra) => ({ field, type }), // passed THROUGH jsonResponse by the controller
    getTodayIsoDate: () => today,
    readRateLimitCache: kvHelpers.readRateLimitCache,
    writeRateLimitCache: kvHelpers.writeRateLimitCache,
    isBotConfigured: () => true,
    sendTelegramMessage: async (env, payload) => {
      if (opts.sendFails === true) throw new Error('telegram upstream 502');
      sends.push(payload);
      return { ok: true };
    },
  });

  const env = { RATE_LIMITS: kv };
  const request = (body) => ({ __body: body });
  const advanceMs = (ms) => { clock.now += ms; };
  const setToday = (d) => { today = d; };
  const dailyKey = () => `notify:${uid}:${today}`;

  return { handlers, env, request, sends, kv, clock, advanceMs, setToday, dailyKey, uid };
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-03 S1: single successful send increments the daily counter by exactly 1', async () => {
  const h = createHarness();
  const res = await h.handlers.handlePost(h.request({ message: '🔔 hello' }), h.env);
  assert.equal(res.status, 200);
  assert.deepEqual(res.body, { status: 'success', sent: true });
  assert.equal(h.sends.length, 1);
  assert.equal(h.sends[0].chat_id, Number(h.uid));
  assert.equal(h.sends[0].text, '🔔 hello');
  // Counter: 0 → 1
  assert.equal(h.kv._store.get(h.dailyKey()).value, '1');
  // Burst lock write uses the REAL helper → TTL clamped to KV minimum 60s
  const lockWrite = h.kv._journal.writes.find(w => w.key === `notify:lock:${h.uid}`);
  assert.ok(lockWrite, 'burst lock must be written');
  assert.equal(lockWrite.ttl, 60, 'writeRateLimitCache must clamp the 2s burst TTL to the 60s KV minimum');
});

test('MK-03 S2: 5/day boundary — first 5 sends pass, 6th is 429 with no send and no counter write', async () => {
  const h = createHarness();
  const statuses = [];
  for (let i = 1; i <= 6; i++) {
    const res = await h.handlers.handlePost(h.request({ message: `msg ${i}` }), h.env);
    statuses.push(res.status);
    h.advanceMs(61_000); // clear the 60s-clamped burst lock between sequential requests
  }
  assert.deepEqual(statuses, [200, 200, 200, 200, 200, 429]);
  assert.equal(h.sends.length, 5, 'exactly 5 sends must reach Telegram');
  assert.equal(h.kv._store.get(h.dailyKey()).value, '5', 'counter stops at 5');
});

test('MK-03 S3: UTC day rollover grants a fresh quota (new date key)', async () => {
  const h = createHarness();
  // Exhaust day 1
  for (let i = 1; i <= 5; i++) {
    const res = await h.handlers.handlePost(h.request({ message: `d1 msg ${i}` }), h.env);
    assert.equal(res.status, 200);
    h.advanceMs(61_000);
  }
  const refused = await h.handlers.handlePost(h.request({ message: 'd1 overflow' }), h.env);
  assert.equal(refused.status, 429);
  h.advanceMs(61_000); // the refused request also wrote the burst lock — let it expire
  // Roll over to the next UTC day
  h.setToday('2026-01-16');
  const fresh = await h.handlers.handlePost(h.request({ message: 'd2 first' }), h.env);
  assert.equal(fresh.status, 200, 'new UTC day must have a fresh quota');
  assert.equal(h.sends.length, 6);
  assert.equal(h.kv._store.get(`notify:${h.uid}:2026-01-16`).value, '1');
  // Previous day's counter untouched
  assert.equal(h.kv._store.get(`notify:${h.uid}:2026-01-15`).value, '5');
});

test('MK-03 S4: burst-lock 429 does NOT read or burn the daily counter', async () => {
  const h = createHarness();
  // Pre-hold the burst lock (as if a request arrived ms earlier)
  await h.env.RATE_LIMITS.put(`notify:lock:${h.uid}`, '1', { expirationTtl: 60 });
  const readsBefore = h.kv._journal.reads.length;
  const res = await h.handlers.handlePost(h.request({ message: 'burst window' }), h.env);
  assert.equal(res.status, 429);
  assert.equal(res.body.reason, 'rate_limited');
  assert.equal(res.body.retry_after, 2);
  assert.equal(h.sends.length, 0, 'no send while burst-locked');
  // Daily counter key never read nor written during the burst 429
  const dailyReads = h.kv._journal.reads.slice(readsBefore).filter(k => k === h.dailyKey());
  assert.equal(dailyReads.length, 0, 'burst 429 must not consult the daily counter');
  assert.ok(!h.kv._store.has(h.dailyKey()), 'burst 429 must not create the daily counter key');
});

test('MK-03 S5: authentication failure performs ZERO KV operations', async () => {
  const h = createHarness({ authError: true });
  const res = await h.handlers.handlePost(h.request({ message: 'x' }), h.env);
  assert.equal(res.status, 401);
  assert.equal(h.kv._journal.reads.length, 0, 'no KV reads on auth failure');
  assert.equal(h.kv._journal.writes.length, 0, 'no KV writes on auth failure');
  assert.equal(h.sends.length, 0);
});

test('MK-03 S6: failed Telegram send is still counted (attempt semantics — documented accepted)', async () => {
  const h = createHarness({ sendFails: true });
  const res = await h.handlers.handlePost(h.request({ message: 'will fail upstream' }), h.env);
  assert.equal(res.status, 200, 'upstream send failure is surfaced as skipped, not an error');
  assert.equal(res.body.sent, false);
  assert.equal(h.sends.length, 0);
  // The counter was incremented BEFORE the send attempt
  assert.equal(h.kv._store.get(h.dailyKey()).value, '1',
    'attempt semantics: failed sends consume quota (accepted, pinned)');
});

test('MK-03 S7: 422 body-validation failure still increments the counter first (documented order)', async () => {
  const h = createHarness();
  const res = await h.handlers.handlePost(h.request({ message: '' }), h.env);
  assert.equal(res.status, 422);
  assert.equal(res.body.type, 'string_too_short');
  assert.equal(h.sends.length, 0);
  assert.equal(h.kv._store.get(h.dailyKey()).value, '1',
    'counter increments before validation — documented accepted behavior');
});

test('MK-03 S8: same-instant race characterization — stale reads under-count (accepted residual, future-fix note)', async () => {
  // With reads that never observe prior writes (KV staleness / two isolates
  // racing in the same instant), both requests pass every gate and both send.
  // The second write wins, so the stored count is 1 instead of 2 → under-count.
  // Pre-MK-01 the frontend double-send produced this constantly; post-MK-01 the
  // single call-site behind the 10s NotificationCenter dedup makes a realistic
  // same-instant pair implausible, and the 2s burst lock catches ≥ms-apart
  // arrivals. Atomic counter (Durable Object / SQL) = architecture change,
  // necessity not proven → documented, not fixed.
  const h = createHarness({ neverSeeWrites: true });
  const [r1, r2] = await Promise.all([
    h.handlers.handlePost(h.request({ message: 'racer 1' }), h.env),
    h.handlers.handlePost(h.request({ message: 'racer 2' }), h.env),
  ]);
  assert.equal(r1.status, 200);
  assert.equal(r2.status, 200);
  assert.equal(h.sends.length, 2, 'same-instant racers both send (characterized, not fixed)');
  const finalCount = h.kv._journal.writes.filter(w => w.key === h.dailyKey()).pop().value;
  assert.equal(finalCount, '1', 'under-count: last write wins instead of 2 (FUTURE-FIX NOTE: if a same-instant source ever reappears, make the counter atomic)');
});

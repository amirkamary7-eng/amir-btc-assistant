/**
 * Online Count Multi-User Regression Test
 * ========================================
 *
 * Verifies the ROOT CAUSE FIX for "online count stuck at 1 when multiple
 * users are online" (per-isolate Worker cache serving stale counts).
 *
 * Background: each Cloudflare Worker isolate keeps its OWN module-level
 * `_onlineCountCache`. Previously, /api/online short-circuited on this
 * cache — so a heartbeat from User B on isolate #2 did NOT refresh
 * isolate #1's cache, and isolate #1 kept serving a stale count=1 for
 * up to 30s (cache TTL). The frontend only refreshed the badge every
 * 180s (heartbeat interval), compounding the staleness.
 *
 * FIX: /api/online now ALWAYS queries the PresenceDO directly. The cache
 * is WRITTEN on every successful DO query (and heartbeat/end) but is ONLY
 * READ when the DO itself fails (fallback for outage resilience).
 *
 * Scenarios tested:
 *   MULTI-USER-1: A → 1, B → 2, C → 3, /api/online → 3
 *   MULTI-USER-2: B expires → /api/online → 2
 *   MULTI-USER-3: stale cache=1 on A's isolate must NOT be served when DO has 3
 *   MULTI-USER-4: DO failure still falls back to the cached count (outage resilience)
 *   MULTI-USER-5: each user's heartbeat response carries the GLOBAL count (not just themselves)
 *
 * Run: node --test tests/online-count-multi-user-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ============================================================================
// Source loading helpers (mirrors presence-do-verification-test.cjs)
// ============================================================================
const DO_PRESENCE_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/durable-objects/presence.js'), 'utf8');
const SESSIONS_CTRL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/sessions.js'), 'utf8');

/** Extract the PresenceDO class body. */
function extractPresenceDOClass() {
  const start = DO_PRESENCE_SRC.indexOf('class PresenceDO {');
  assert.ok(start !== -1, 'PresenceDO class must exist');
  let depth = 0, end = -1, inStr = null;
  let i = start;
  while (i < DO_PRESENCE_SRC.length) {
    const ch = DO_PRESENCE_SRC[i];
    if (!inStr && ch === '/' && DO_PRESENCE_SRC[i + 1] === '/') {
      while (i < DO_PRESENCE_SRC.length && DO_PRESENCE_SRC[i] !== '\n') i++;
      continue;
    }
    if (!inStr && ch === '/' && DO_PRESENCE_SRC[i + 1] === '*') {
      i += 2;
      while (i < DO_PRESENCE_SRC.length && !(DO_PRESENCE_SRC[i] === '*' && DO_PRESENCE_SRC[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    if (inStr) {
      if (ch === '\\') { i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') { inStr = ch; i++; continue; }
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
    i++;
  }
  assert.ok(end !== -1, 'PresenceDO class must close');
  return DO_PRESENCE_SRC.slice(start, end);
}
const PRESENCE_DO_CLASS_SRC = extractPresenceDOClass();

function loadPresenceDOClass() {
  const exportsObj = {};
  const evaluator = new Function('exports', 'Response', 'URL', 'Date', 'console',
    `${PRESENCE_DO_CLASS_SRC}\nexports.PresenceDO = PresenceDO;`);
  evaluator(exportsObj, Response, URL, Date, console);
  return exportsObj.PresenceDO;
}

function loadSessionHandlersFactory() {
  const src = SESSIONS_CTRL_SRC
    .replace(/^export\s+function\s+createSessionHandlers/m, 'function createSessionHandlers');
  const exportsObj = {};
  const evaluator = new Function('exports', src + '\nexports.createSessionHandlers = createSessionHandlers;');
  evaluator(exportsObj);
  return exportsObj.createSessionHandlers;
}

// ============================================================================
// Mock DO state + binding (mirrors presence-do-verification-test.cjs)
// ============================================================================
function createMockDOState() {
  let alarmAt = null;
  const kvStore = new Map();
  return {
    storage: {
      async getAlarm() { return alarmAt; },
      async setAlarm(when) { alarmAt = when; },
      async deleteAlarm() { alarmAt = null; },
      async get(key) { return kvStore.get(key) ?? null; },
      async put(key, value) { kvStore.set(key, value); },
      async delete(key) { kvStore.delete(key); },
    },
    _peekStorage() { return kvStore; },
  };
}

function createMockPresenceDOBinding(PresenceDOClass) {
  const state = createMockDOState();
  const instance = new PresenceDOClass(state, {});
  let fetchCount = 0;
  const stub = {
    fetch(input) {
      fetchCount++;
      const url = typeof input === 'string' ? input : input.url;
      return instance.fetch({ url, method: 'GET', headers: new Headers() });
    },
  };
  const binding = {
    idFromName(name) { return { __doName: String(name) }; },
    idFromString(str) { return { __doName: str }; },
    newUniqueId() { return { __doName: null }; },
    get() { return stub; },
    _instance: instance,
    _state: state,
    _getFetchCount() { return fetchCount; },
    _simulateFailure(shouldFail) {
      if (shouldFail) stub.fetch = () => { throw new Error('SIMULATED DO FAILURE'); };
    },
  };
  return binding;
}

// ============================================================================
// Mock auth + deps (mirrors presence-do-verification-test.cjs)
// ============================================================================
function makeAuth(authUser) {
  return async function authenticateTelegramRequest() {
    return { error: null, user: authUser, startParam: null };
  };
}
function makeJsonResponse() {
  return function jsonResponse(obj, opts = {}) {
    const status = (opts && opts.status) || 200;
    return { status, _body: obj, async json() { return obj; }, headers: new Headers() };
  };
}
function makeGetNumericEnv() {
  return function getNumericEnv(env, key, def) {
    const v = env && env[key];
    if (v === undefined || v === null || v === '') return def;
    const n = Number(v);
    return Number.isFinite(n) ? n : def;
  };
}
function makeNormalizeOptionalString() {
  return function normalizeOptionalString(v) {
    if (v === undefined || v === null) return null;
    const s = String(v).trim();
    return s.length ? s : null;
  };
}
function makeMockRequest(method, urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : `http://localhost${urlPath}`;
  return { url, method, headers: new Headers() };
}
function createMockSessionRepo(initialState = {}) {
  let store = { ...initialState };
  return {
    async readPresenceState() { return JSON.parse(JSON.stringify(store)); },
    prunePresenceState(state, nowMs) {
      for (const [uid, exp] of Object.entries(state)) {
        if (!Number.isFinite(exp) || exp <= nowMs) delete state[uid];
      }
    },
    async persistPresenceState(_env, state) { store = JSON.parse(JSON.stringify(state)); },
    async deleteSession() {},
  };
}

/**
 * Build a handlers instance authenticated as a SPECIFIC user.
 * Each instance has its OWN module-level _onlineCountCache, which mirrors
 * how different Cloudflare Worker isolates keep separate caches.
 */
function buildHandlersWithUser(sessionRepo, userId) {
  const factory = loadSessionHandlersFactory();
  return factory({
    jsonResponse: makeJsonResponse(),
    authenticateTelegramRequest: makeAuth({ id: userId }),
    getNumericEnv: makeGetNumericEnv(),
    normalizeOptionalString: makeNormalizeOptionalString(),
    sessionRepo,
  });
}

// ============================================================================
// TESTS
// ============================================================================

test('MULTI-USER-1: A→1, B→2, C→3, /api/online→3 (global aggregation)', async () => {
  // 3 handler instances (3 "isolates"), each authenticated as a different
  // user, sharing ONE DO binding (the singleton). This mirrors production:
  // each user's requests land on some isolate, but all isolates talk to
  // the same PresenceDO.
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlersA = buildHandlersWithUser(repo, 111);
  const handlersB = buildHandlersWithUser(repo, 222);
  const handlersC = buildHandlersWithUser(repo, 333);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // A heartbeat → DO={A} → 1
  const rA = await handlersA.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  const bA = await rA.json();
  assert.equal(bA.online_count, 1, 'A heartbeat → 1');

  // B heartbeat → DO={A,B} → 2
  const rB = await handlersB.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  const bB = await rB.json();
  assert.equal(bB.online_count, 2, 'B heartbeat → 2');

  // C heartbeat → DO={A,B,C} → 3
  const rC = await handlersC.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  const bC = await rC.json();
  assert.equal(bC.online_count, 3, 'C heartbeat → 3');

  // /api/online from A's handler → must reflect the GLOBAL DO count (3),
  // NOT A's per-isolate cache (which A's heartbeat set to 1).
  const rOnline = await handlersA.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const bOnline = await rOnline.json();
  assert.equal(bOnline.count, 3, '/api/online → 3 (must query DO, not serve stale cache=1 from A isolate)');
});

test('MULTI-USER-2: B expires → /api/online → 2 (lazy prune)', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlersA = buildHandlersWithUser(repo, 111);
  const handlersB = buildHandlersWithUser(repo, 222);
  const handlersC = buildHandlersWithUser(repo, 333);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // Seed 3 users
  await handlersA.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  await handlersB.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  await handlersC.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);

  // Simulate B's session expiring (B closed the app, no more heartbeats).
  // Inject an expired entry directly into the DO's sessions Map (bypasses
  // the ttl-coercion so we can test the count()'s lazy-prune path).
  const inst = doBinding._instance;
  assert.ok(inst.sessions.has('222'), 'B must be in the DO before expiry');
  inst.sessions.set('222', Date.now() - 1000); // already expired

  // /api/online → DO count action lazy-prunes B → returns 2
  const r = await handlersA.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const b = await r.json();
  assert.equal(b.count, 2, 'after B expires → /api/online → 2 (lazy prune removes expired B)');
});

test('MULTI-USER-3: stale cache=1 must NOT be served when DO has 3 (root-cause guard)', async () => {
  // This is the CORE regression test for the "stuck at 1" bug.
  //
  // Setup: A's isolate has _onlineCountCache = {count:1} (set when only A
  // was online). Then B and C register on the DO via OTHER isolates
  // (handlersB, handlersC) — their heartbeats refresh THEIR caches but
  // NOT A's. The DO now has {A,B,C} = 3, but A's isolate cache is stale {1}.
  //
  // With the FIX: A's /api/online must query the DO → return 3 (NOT the
  // stale cached 1). Before the fix, it would have returned the stale 1.
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlersA = buildHandlersWithUser(repo, 111);
  const handlersB = buildHandlersWithUser(repo, 222);
  const handlersC = buildHandlersWithUser(repo, 333);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // A heartbeat (only A online) → DO={A}, A's isolate cache={1}
  await handlersA.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  // Populate A's isolate cache with 1 via an online call
  const rA1 = await handlersA.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const bA1 = await rA1.json();
  assert.equal(bA1.count, 1, 'A online when alone → 1');
  const fetchesAfterA = doBinding._getFetchCount();

  // B and C register on the DO via OTHER isolates (NOT A's isolate).
  // Their heartbeats refresh THEIR caches but NOT A's.
  await handlersB.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  await handlersC.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  // DO now has {A, B, C} = 3. A's isolate cache is STILL {1} (stale).

  // A's /api/online → with FIX: queries DO → 3 (NOT stale cache 1)
  const rA2 = await handlersA.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const bA2 = await rA2.json();
  assert.equal(bA2.count, 3,
    'A isolate must NOT serve stale cache=1 — must query DO → 3 (the root-cause fix)');

  // And it must have ACTUALLY queried the DO (not returned a cached value).
  const fetchesAfter = doBinding._getFetchCount();
  assert.ok(fetchesAfter > fetchesAfterA,
    `A online must have issued a NEW DO fetch (got ${fetchesAfter} total, was ${fetchesAfterA})`);
});

test('MULTI-USER-4: DO failure still falls back to cached count (outage resilience)', async () => {
  // The cache is NOT fully removed — it is still READ when the DO itself
  // fails, providing a best-effort last-known-good count during an outage.
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlersWithUser(repo, 111);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // Heartbeat → DO={A} → cache={1}
  await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  // Online call → queries DO, writes cache={1}
  await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);

  // Now simulate the DO failing (outage).
  doBinding._simulateFailure(true);

  // /api/online → DO fails → fall back to the cached count=1
  const r = await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const b = await r.json();
  assert.equal(b.count, 1,
    'DO failure → fallback cache returns last-known-good count=1 (outage resilience preserved)');
});

test('MULTI-USER-5: each heartbeat response carries the GLOBAL count', async () => {
  // The heartbeat response's online_count is what the frontend uses to
  // update the badge (via updateOnlineBadge). It MUST reflect the global
  // DO count (after this user's session is registered), not just 1.
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlersA = buildHandlersWithUser(repo, 111);
  const handlersB = buildHandlersWithUser(repo, 222);
  const handlersC = buildHandlersWithUser(repo, 333);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  const rA = await handlersA.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  assert.equal((await rA.json()).online_count, 1, 'A hb response → 1');

  const rB = await handlersB.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  assert.equal((await rB.json()).online_count, 2, 'B hb response → 2 (global)');

  const rC = await handlersC.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  assert.equal((await rC.json()).online_count, 3, 'C hb response → 3 (global)');

  // A re-heartbeat → should now also report 3 (A,B,C all in DO)
  const rA2 = await handlersA.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  assert.equal((await rA2.json()).online_count, 3, 'A re-hb response → 3 (sees B and C)');
});

test('MULTI-USER-6: source guard — /api/online has no cache-hit short-circuit', () => {
  // Static guard: the cache-hit short-circuit (the bug source) must be GONE
  // from src/controllers/sessions.js. The string `_rcaCacheHit` and the
  // `if (_rcaCacheHit)` return-on-cached-value block must not exist.
  assert.ok(!SESSIONS_CTRL_SRC.includes('_rcaCacheHit'),
    '_rcaCacheHit (cache-hit short-circuit) must be removed from sessions.js');
  assert.ok(!SESSIONS_CTRL_SRC.includes('now < _onlineCountCache.expiresAt'),
    'cache-hit expiry check (now < expiresAt) must be removed from /api/online path');
  // But the cache WRITE (for fallback) must REMAIN.
  assert.ok(SESSIONS_CTRL_SRC.includes('_onlineCountCache = { count:'),
    'fallback cache WRITE must remain (for DO-failure resilience)');
  assert.ok(SESSIONS_CTRL_SRC.includes('ONLINE_COUNT_CACHE_TTL_MS = 30000'),
    'ONLINE_COUNT_CACHE_TTL_MS constant must remain (fallback cache TTL)');
});

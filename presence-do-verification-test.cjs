/**
 * PresenceDO — Dedicated Final Verification Suite
 * ===============================================
 *
 * Verifies the Durable Object-based Online Members system across 12 areas:
 *
 *   1. Concurrency — multiple simultaneous heartbeats, no race/lost update
 *   2. heartbeat → count → end flow with correct counts at each step
 *   3. Expiration + alarm() pruning of expired sessions
 *   4. Worker count cache (TTL=30s) + invalidation after heartbeat/end
 *   5. Duplicate tab / duplicate heartbeat with same userId (idempotent)
 *   6. DO failure → KV fallback (functional, and NOT a RMW race on count)
 *   7. DO restart/eviction behavior + count recovery
 *   8. wrangler.jsonc bindings (dev/staging/production) + syntax/migration
 *   9. Security — userId only from authenticated request; cannot spoof/evict others
 *  10. No other endpoint uses session:presence_state as the primary source
 *  11. (covered by running full `npm test` separately — baseline comparison)
 *  12. (covered by `git diff --check` separately — final diff review)
 *
 * Run: node --test presence-do-verification-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ============================================================================
// Source loading helpers
// ============================================================================

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const SESSIONS_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/sessions.js'), 'utf8');
const WRANGLER_SRC = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');

/** Strip JSONC comments (line + block) WITHOUT touching `//` inside strings. */
function parseJsonc(text) {
  let out = '';
  let i = 0;
  let inStr = null;
  while (i < text.length) {
    const ch = text[i];
    if (inStr) {
      out += ch;
      if (ch === '\\' && i + 1 < text.length) { out += text[i + 1]; i += 2; continue; }
      if (ch === inStr) inStr = null;
      i++;
      continue;
    }
    if (ch === '"' || ch === "'") { inStr = ch; out += ch; i++; continue; }
    if (ch === '/' && text[i + 1] === '/') {
      while (i < text.length && text[i] !== '\n') i++;
      continue;
    }
    if (ch === '/' && text[i + 1] === '*') {
      i += 2;
      while (i < text.length && !(text[i] === '*' && text[i + 1] === '/')) i++;
      i += 2;
      continue;
    }
    out += ch;
    i++;
  }
  // trim trailing commas before } or ]
  out = out.replace(/,(\s*[}\]])/g, '$1');
  return JSON.parse(out);
}

/** Extract the PresenceDO class body from worker-proxy.js. */
function extractPresenceDOClass() {
  const start = WORKER_SRC.indexOf('class PresenceDO {');
  assert.ok(start !== -1, 'PresenceDO class must exist in worker-proxy.js');
  // Find matching closing brace at depth 0, skipping strings AND comments.
  let depth = 0, end = -1, inStr = null;
  let i = start;
  while (i < WORKER_SRC.length) {
    const ch = WORKER_SRC[i];
    const prev = WORKER_SRC[i - 1];
    // skip line comment
    if (!inStr && ch === '/' && WORKER_SRC[i + 1] === '/') {
      while (i < WORKER_SRC.length && WORKER_SRC[i] !== '\n') i++;
      continue;
    }
    // skip block comment
    if (!inStr && ch === '/' && WORKER_SRC[i + 1] === '*') {
      i += 2;
      while (i < WORKER_SRC.length && !(WORKER_SRC[i] === '*' && WORKER_SRC[i + 1] === '/')) i++;
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
    else if (ch === '}') {
      depth--;
      if (depth === 0) { end = i + 1; break; }
    }
    i++;
  }
  assert.ok(end !== -1, 'PresenceDO class must have a closing brace');
  return WORKER_SRC.slice(start, end);
}

const PRESENCE_DO_CLASS_SRC = extractPresenceDOClass();

/** Build a PresenceDO class in an isolated scope. */
function loadPresenceDOClass() {
  const exportsObj = {};
  const evaluator = new Function('exports', 'Response', 'URL', 'Date', 'console',
    `${PRESENCE_DO_CLASS_SRC}\nexports.PresenceDO = PresenceDO;`);
  evaluator(exportsObj, Response, URL, Date, console);
  return exportsObj.PresenceDO;
}

/** Load createSessionHandlers factory from src/controllers/sessions.js. */
function loadSessionHandlersFactory() {
  // Strip the `export ` keyword so the function becomes a plain declaration.
  const src = SESSIONS_CTRL_SRC
    .replace(/^export\s+function\s+createSessionHandlers/m, 'function createSessionHandlers');
  const exportsObj = {};
  const evaluator = new Function('exports', src + '\nexports.createSessionHandlers = createSessionHandlers;');
  evaluator(exportsObj);
  return exportsObj.createSessionHandlers;
}

// ============================================================================
// Mock Durable Object state (alarm storage)
// ============================================================================

function createMockDOState() {
  let alarmAt = null;
  return {
    storage: {
      async getAlarm() { return alarmAt; },
      async setAlarm(when) { alarmAt = when; },
      async deleteAlarm() { alarmAt = null; },
    },
    _peekAlarm() { return alarmAt; },
  };
}

/**
 * Create an in-process PresenceDO stub bound to env.PRESENCE_DO.
 * Each call to env.PRESENCE_DO.fetch(url) instantiates/forwards to a single
 * shared PresenceDO instance (mimicking how Cloudflare routes all requests
 * for the same DO ID to the same instance).
 */
function createMockPresenceDOBinding(PresenceDOClass, opts = {}) {
  const state = createMockDOState();
  const instance = new PresenceDOClass(state, {});
  let fetchCount = 0;
  const calls = [];
  const binding = {
    fetch(input) {
      fetchCount++;
      const url = typeof input === 'string' ? input : input.url;
      const u = new URL(url);
      const action = u.searchParams.get('action');
      const userId = u.searchParams.get('userId');
      const ttl = u.searchParams.get('ttl');
      calls.push({ action, userId, ttl });
      // `request` arg is unused by PresenceDO.fetch (it reads url only),
      // but pass a minimal Request-like object for safety.
      return instance.fetch({ url, method: 'GET', headers: new Headers() });
    },
    _instance: instance,
    _state: state,
    _getCalls() { return calls.slice(); },
    _getFetchCount() { return fetchCount; },
    // Simulate DO eviction: reset in-memory Map but keep alarm storage
    _simulateEviction() {
      instance.sessions = new Map();
      instance._alarmSet = false;
    },
    // Simulate DO throwing on every fetch
    _simulateFailure(shouldFail) {
      if (shouldFail) {
        binding.fetch = () => { throw new Error('SIMULATED DO FAILURE'); };
      }
    },
  };
  return binding;
}

// ============================================================================
// Mock session repository (tracks KV calls)
// ============================================================================

function createMockSessionRepo(initialState = {}) {
  let store = { ...initialState };
  const calls = { read: 0, prune: 0, persist: 0, delete: 0 };
  return {
    async readPresenceState(_env) {
      calls.read++;
      return JSON.parse(JSON.stringify(store));
    },
    prunePresenceState(state, nowMs) {
      calls.prune++;
      for (const [uid, expiresAt] of Object.entries(state)) {
        if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) delete state[uid];
      }
    },
    async persistPresenceState(_env, state, _ttl) {
      calls.persist++;
      store = JSON.parse(JSON.stringify(state));
    },
    async deleteSession(_env, _userId) {
      calls.delete++;
    },
    _getCalls() { return { ...calls }; },
    _getStore() { return JSON.parse(JSON.stringify(store)); },
  };
}

// ============================================================================
// Mock auth + helpers for controller tests
// ============================================================================

/**
 * Build a mock authenticateTelegramRequest that always authenticates as the
 * given user (unless `deny` is set, in which case it returns an error).
 */
function makeAuth(authUser, opts = {}) {
  return async function authenticateTelegramRequest(_request, _env) {
    if (opts.deny) {
      return {
        error: { _mockError: true, status: 401, _denied: true },
        user: null,
        startParam: null,
      };
    }
    return { error: null, user: authUser, startParam: null };
  };
}

function makeJsonResponse() {
  return function jsonResponse(obj, opts = {}, _env) {
    const status = (opts && opts.status) || 200;
    return {
      status,
      _body: obj,
      async json() { return obj; },
      headers: new Headers(),
    };
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

/** Build a mock Request for the controller. */
function makeMockRequest(method, urlPath) {
  const url = urlPath.startsWith('http') ? urlPath : `http://localhost${urlPath}`;
  return { url, method, headers: new Headers() };
}

/** Build a fresh handlers instance (cache reset between tests). */
function buildHandlers(sessionRepo) {
  const factory = loadSessionHandlersFactory();
  return factory({
    jsonResponse: makeJsonResponse(),
    authenticateTelegramRequest: makeAuth({ id: 12345 }),
    getNumericEnv: makeGetNumericEnv(),
    normalizeOptionalString: makeNormalizeOptionalString(),
    sessionRepo,
  });
}

// ============================================================================
// SECTION 1 — PresenceDO unit tests (concurrency, flow, expiration, alarm)
// ============================================================================

test('P1.heartbeat-count-end: correct counts at each step', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const doFetch = (action, userId, ttl) => binding.fetch(
    `https://do/internal?action=${action}${userId ? `&userId=${userId}` : ''}${ttl ? `&ttl=${ttl}` : ''}`);

  // Start: 0 online
  let r = await doFetch('count');
  assert.equal(r.status, 200);
  let body = await r.json();
  assert.equal(body.count, 0, 'initial count must be 0');

  // User A heartbeat
  r = await doFetch('heartbeat', 'A', 240000);
  body = await r.json();
  assert.equal(body.online_count, 1, 'after A heartbeat → 1');

  // User B heartbeat
  r = await doFetch('heartbeat', 'B', 240000);
  body = await r.json();
  assert.equal(body.online_count, 2, 'after B heartbeat → 2');

  // Count
  r = await doFetch('count');
  body = await r.json();
  assert.equal(body.count, 2, 'count query → 2');

  // User A end
  r = await doFetch('end', 'A');
  body = await r.json();
  assert.equal(body.online_count, 1, 'after A end → 1');

  // Count
  r = await doFetch('count');
  body = await r.json();
  assert.equal(body.count, 1, 'count query → 1');
});

test('P1.concurrency: 50 simultaneous heartbeats — no race/lost update', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const N = 50;
  // Fire N heartbeats "simultaneously" — DO serializes via single-instance fetch
  const promises = [];
  for (let i = 0; i < N; i++) {
    promises.push(binding.fetch(`https://do/internal?action=heartbeat&userId=u${i}&ttl=240000`));
  }
  const responses = await Promise.all(promises);
  // Every response must be OK and the LAST one must report N (serial execution → no lost update)
  for (const r of responses) {
    assert.equal(r.status, 200);
  }
  // After all settle, count must be exactly N
  const countResp = await binding.fetch('https://do/internal?action=count');
  const countBody = await countResp.json();
  assert.equal(countBody.count, N, `all ${N} heartbeats must be registered (no lost update)`);
});

test('P1.duplicate-heartbeat: same userId is idempotent (count stays 1)', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const doFetch = (action, userId, ttl) => binding.fetch(
    `https://do/internal?action=${action}${userId ? `&userId=${userId}` : ''}${ttl ? `&ttl=${ttl}` : ''}`);

  await doFetch('heartbeat', 'dup', 240000);
  await doFetch('heartbeat', 'dup', 240000);
  await doFetch('heartbeat', 'dup', 240000);
  const r = await doFetch('count');
  const body = await r.json();
  assert.equal(body.count, 1, 'duplicate heartbeats for same userId → count stays 1');
});

test('P1.expiration: count() lazily prunes expired entries', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const inst = binding._instance;
  // Inject one expired + one alive directly into the Map (bypasses the
  // `|| 240000` falsy-TTL fallback so we can test the lazy-prune path in count())
  const now = Date.now();
  inst.sessions.set('expired', now - 1000);
  inst.sessions.set('alive', now + 60000);

  const r = await binding.fetch('https://do/internal?action=count');
  const body = await r.json();
  // expired must be pruned by count()'s lazy prune; alive remains
  assert.equal(body.count, 1, 'expired entry must be pruned by count() lazy prune');
  assert.ok(inst.sessions.has('alive'), 'alive entry must survive count()');
  assert.ok(!inst.sessions.has('expired'), 'expired entry must be gone after count()');
});

test('P1.alarm: alarm() prunes all expired entries and reschedules', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const inst = binding._instance;
  const state = binding._state;

  // Insert one expired + one alive directly into the Map
  const now = Date.now();
  inst.sessions.set('expired1', now - 1000);
  inst.sessions.set('expired2', now - 1);
  inst.sessions.set('alive', now + 60000);

  // Trigger alarm (simulates the DO alarm firing)
  await inst.alarm();

  assert.equal(inst.sessions.size, 1, 'alarm must prune all expired entries');
  assert.ok(inst.sessions.has('alive'), 'alive entry must survive alarm');
  assert.ok(!inst.sessions.has('expired1'), 'expired1 pruned by alarm');
  assert.ok(!inst.sessions.has('expired2'), 'expired2 pruned by alarm');

  // Alarm must reschedule itself ~60s in the future
  const nextAlarm = state._peekAlarm();
  assert.ok(nextAlarm !== null, 'alarm must be rescheduled');
  assert.ok(nextAlarm > now + 50000 && nextAlarm < now + 70000,
    `alarm rescheduled ~60s out (got ${nextAlarm - now}ms)`);
});

test('P1.alarm-reschedule: alarm survives being called twice', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const inst = binding._instance;
  const state = binding._state;
  await inst.alarm();
  const a1 = state._peekAlarm();
  await inst.alarm();
  const a2 = state._peekAlarm();
  assert.ok(a1 !== null && a2 !== null, 'alarm remains scheduled after repeated calls');
});

test('P1.unknown-action: returns 404', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const r = await binding.fetch('https://do/internal?action=bogus&userId=X');
  assert.equal(r.status, 404);
});

test('P1.missing-userId: heartbeat/end return 400', async () => {
  const PresenceDO = loadPresenceDOClass();
  const binding = createMockPresenceDOBinding(PresenceDO);
  const r1 = await binding.fetch('https://do/internal?action=heartbeat');
  assert.equal(r1.status, 400, 'heartbeat without userId → 400');
  const r2 = await binding.fetch('https://do/internal?action=end');
  assert.equal(r2.status, 400, 'end without userId → 400');
});

// ============================================================================
// SECTION 2 — Controller integration (DO path, cache, fallback)
// ============================================================================

test('P2.heartbeat-DO-path: uses DO, returns online_count', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const req = makeMockRequest('POST', '/api/sessions/heartbeat?session_id=s1');
  const res = await handlers.handleHeartbeat(req, env);
  const body = await res.json();

  assert.equal(res.status, 200, 'heartbeat must succeed');
  assert.equal(body.status, 'success');
  assert.equal(typeof body.online_count, 'number', 'online_count must be a number');
  assert.equal(body.online_count, 1, 'first heartbeat → 1 online');
  // CRITICAL: DO must have been called
  assert.equal(doBinding._getFetchCount(), 1, 'DO.fetch must be called exactly once');
});

test('P2.heartbeat-DO-path: KV must NOT be touched when DO succeeds', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const req = makeMockRequest('POST', '/api/sessions/heartbeat');
  await handlers.handleHeartbeat(req, env);

  const calls = repo._getCalls();
  // CRITICAL ASSERTION: if the DO path works correctly, the KV read-modify-write
  // (readPresenceState + persistPresenceState) must NEVER run.
  assert.equal(calls.read, 0, 'KV readPresenceState must NOT be called when DO succeeds');
  assert.equal(calls.persist, 0, 'KV persistPresenceState must NOT be called when DO succeeds');
});

test('P2.count-DO-path: cache miss queries DO', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);

  // Seed one user
  await doBinding.fetch('https://do/internal?action=heartbeat&userId=seed&ttl=240000');

  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const req = makeMockRequest('GET', '/api/sessions/online');
  const res = await handlers.handleOnline(req, env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.count, 1, 'count must reflect seeded user');
  // KV must NOT be touched on count when DO works
  const calls = repo._getCalls();
  assert.equal(calls.read, 0, 'KV must NOT be read for online count when DO works');
});

test('P2.count-cache: 30s TTL — second call within TTL skips DO', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // First call: cache miss → hits DO
  await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const callsAfter1 = doBinding._getFetchCount();
  assert.ok(callsAfter1 >= 1, 'first online call must hit DO');

  // Second call immediately: cache hit → must NOT hit DO
  await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const callsAfter2 = doBinding._getFetchCount();
  assert.equal(callsAfter2, callsAfter1, 'second online call within TTL must NOT hit DO (cache hit)');
});

test('P2.count-cache-invalidation: heartbeat refreshes cache', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // Seed cache with count=0
  const r0 = await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const b0 = await r0.json();
  assert.equal(b0.count, 0);

  // Heartbeat → should refresh cache to 1
  await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);

  // Next online call: should return 1 from the refreshed cache WITHOUT hitting DO
  const callsBefore = doBinding._getFetchCount();
  const r1 = await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  const b1 = await r1.json();
  const callsAfter = doBinding._getFetchCount();
  assert.equal(b1.count, 1, 'cache must reflect heartbeat-refreshed count');
  assert.equal(callsAfter, callsBefore, 'online after heartbeat must use refreshed cache (no DO call)');
});

test('P2.end-DO-path: removes session and refreshes cache', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // Seed two users via heartbeat
  await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  // second user via direct DO call (different userId)
  await doBinding.fetch('https://do/internal?action=heartbeat&userId=other&ttl=240000');

  const r = await handlers.handleEnd(makeMockRequest('POST', '/api/sessions/end'), env);
  const body = await r.json();
  assert.equal(res_status(r), 200);
  assert.equal(body.online_count, 1, 'end must remove the authenticated user, leaving 1');

  // KV must NOT be touched
  const calls = repo._getCalls();
  assert.equal(calls.read, 0, 'end via DO must NOT read KV');
  assert.equal(calls.persist, 0, 'end via DO must NOT persist KV');
});

// helper because mock response status accessor
function res_status(r) { return r.status; }

test('P2.DO-failure: KV fallback returns a valid count', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  doBinding._simulateFailure(true); // every fetch throws
  const repo = createMockSessionRepo({ fallbackUser: Date.now() + 240000 });
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_CACHE: {}, SESSION_TTL: 240 };
  const req = makeMockRequest('GET', '/api/sessions/online');
  const res = await handlers.handleOnline(req, env);
  const body = await res.json();
  assert.equal(res.status, 200, 'online must still succeed via KV fallback');
  assert.equal(body.count, 1, 'count must come from KV fallback state');
});

test('P2.DO-failure-count: KV fallback is READ-ONLY (no RMW race on count)', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  doBinding._simulateFailure(true);
  const repo = createMockSessionRepo({ u1: Date.now() + 240000, u2: Date.now() + 240000 });
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_CACHE: {}, SESSION_TTL: 240 };
  await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);

  const calls = repo._getCalls();
  assert.ok(calls.read >= 1, 'KV must be read on fallback');
  assert.equal(calls.persist, 0, 'KV MUST NOT be persisted on count fallback (read-only → no RMW race)');
});

test('P2.DO-failure-heartbeat: KV fallback still functional (RMW acceptable on legacy path)', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  doBinding._simulateFailure(true);
  const repo = createMockSessionRepo({});
  const handlers = buildHandlers(repo);

  const env = { PRESENCE_DO: doBinding, SESSION_CACHE: {}, SESSION_TTL: 240 };
  const res = await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  const body = await res.json();
  assert.equal(res.status, 200);
  assert.equal(body.status, 'success');
  assert.equal(body.online_count, 1, 'fallback heartbeat must register the user');
  const calls = repo._getCalls();
  assert.ok(calls.read >= 1 && calls.persist >= 1, 'KV RMW must run on heartbeat fallback (legacy path)');
});

// ============================================================================
// SECTION 3 — DO restart / eviction recovery
// ============================================================================

test('P3.eviction: after eviction, count returns 0 then heartbeat re-registers', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  // Seed
  await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  let r = await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  let b = await r.json();
  assert.equal(b.count, 1, 'pre-eviction count = 1');

  // Simulate DO eviction: in-memory Map lost
  doBinding._simulateEviction();

  // Wait for cache to expire so next online call hits DO
  // (We can't easily fast-forward 30s; instead query DO directly to observe post-eviction state)
  const directCount = await doBinding.fetch('https://do/internal?action=count');
  const directBody = await directCount.json();
  assert.equal(directBody.count, 0, 'post-eviction DO count must be 0 (in-memory Map lost)');

  // Recovery: a new heartbeat re-registers
  await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  const directCount2 = await doBinding.fetch('https://do/internal?action=count');
  const directBody2 = await directCount2.json();
  assert.equal(directBody2.count, 1, 'post-eviction heartbeat must re-register (recovery)');
});

// ============================================================================
// SECTION 4 — wrangler.jsonc bindings (dev/staging/production) + migration
// ============================================================================

test('P4.wrangler: valid JSONC parse', () => {
  const cfg = parseJsonc(WRANGLER_SRC);
  assert.ok(cfg, 'wrangler.jsonc must parse');
  assert.equal(cfg.name, 'amir-btc-assistant-api');
});

test('P4.wrangler: dev (top-level) has PRESENCE_DO binding', () => {
  const cfg = parseJsonc(WRANGLER_SRC);
  const bindings = cfg.durable_objects?.bindings || [];
  const presence = bindings.find(b => b.name === 'PRESENCE_DO');
  assert.ok(presence, 'dev must define PRESENCE_DO binding');
  assert.equal(presence.class_name, 'PresenceDO', 'class_name must be PresenceDO');
});

test('P4.wrangler: staging env has PRESENCE_DO binding', () => {
  const cfg = parseJsonc(WRANGLER_SRC);
  const staging = cfg.env?.staging;
  assert.ok(staging, 'staging env must exist');
  const bindings = staging.durable_objects?.bindings || [];
  const presence = bindings.find(b => b.name === 'PRESENCE_DO');
  assert.ok(presence, 'staging must define PRESENCE_DO binding');
  assert.equal(presence.class_name, 'PresenceDO');
});

test('P4.wrangler: production env has PRESENCE_DO binding', () => {
  const cfg = parseJsonc(WRANGLER_SRC);
  const prod = cfg.env?.production;
  assert.ok(prod, 'production env must exist');
  const bindings = prod.durable_objects?.bindings || [];
  const presence = bindings.find(b => b.name === 'PRESENCE_DO');
  assert.ok(presence, 'production must define PRESENCE_DO binding');
  assert.equal(presence.class_name, 'PresenceDO');
});

test('P4.wrangler: migration v1 declares new_sqlite_classes PresenceDO', () => {
  const cfg = parseJsonc(WRANGLER_SRC);
  const devMigrations = cfg.migrations || [];
  const v1 = devMigrations.find(m => m.tag === 'v1');
  assert.ok(v1, 'dev must have migration tag v1');
  assert.ok(Array.isArray(v1.new_sqlite_classes) && v1.new_sqlite_classes.includes('PresenceDO'),
    'migration v1 must declare new_sqlite_classes: ["PresenceDO"]');

  // staging + production must also declare the migration
  for (const envName of ['staging', 'production']) {
    const envCfg = cfg.env?.[envName];
    const envV1 = (envCfg?.migrations || []).find(m => m.tag === 'v1');
    assert.ok(envV1, `${envName} must have migration v1`);
    assert.ok(envV1.new_sqlite_classes?.includes('PresenceDO'),
      `${envName} migration v1 must include PresenceDO`);
  }
});

test('P4.wrangler: PresenceDO class is exported as a NAMED export from worker-proxy.js', () => {
  // Wrangler requires DO classes to be NAMED exports (export { PresenceDO } or
  // export class PresenceDO), NOT properties on the default export object.
  // Putting PresenceDO on `export default { PresenceDO, ... }` causes wrangler
  // deploy to FAIL with: "Your Worker depends on the following Durable Objects,
  // which are not exported in your entrypoint file: PresenceDO."
  assert.ok(
    /export\s*\{\s*PresenceDO\s*\};?/.test(WORKER_SRC) ||
    /export\s+class\s+PresenceDO\b/.test(WORKER_SRC),
    'PresenceDO must be a NAMED export (export { PresenceDO } or export class PresenceDO), ' +
    'NOT a property on export default — wrangler only detects named exports for DO bindings'
  );
  // Negative assertion: PresenceDO must NOT be on the default export object
  assert.doesNotMatch(WORKER_SRC, /export\s+default\s*\{[^}]*\bPresenceDO\b/,
    'PresenceDO must NOT be a property on export default (wrangler cannot detect it there)');
});

// ============================================================================
// SECTION 5 — Security: userId only from authenticated request
// ============================================================================

test('P5.security: heartbeat uses userId from auth, NOT from query param', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const factory = loadSessionHandlersFactory();
  // Auth as user 999
  const handlers = factory({
    jsonResponse: makeJsonResponse(),
    authenticateTelegramRequest: makeAuth({ id: 999 }),
    getNumericEnv: makeGetNumericEnv(),
    normalizeOptionalString: makeNormalizeOptionalString(),
    sessionRepo: repo,
  });

  // Attacker tries to register presence for user VICTIM via query param
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const req = makeMockRequest('POST', '/api/sessions/heartbeat?userId=VICTIM');
  await handlers.handleHeartbeat(req, env);

  // The DO must have been called with the AUTHENTICATED userId (999), not VICTIM
  const calls = doBinding._getCalls();
  const heartbeatCall = calls.find(c => c.action === 'heartbeat');
  assert.ok(heartbeatCall, 'heartbeat must call DO');
  assert.equal(heartbeatCall.userId, '999', 'DO userId must come from auth, not query');
  assert.notEqual(heartbeatCall.userId, 'VICTIM', 'spoofed userId must NOT reach DO');
});

test('P5.security: end uses userId from auth, cannot evict another user', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const factory = loadSessionHandlersFactory();
  const handlers = factory({
    jsonResponse: makeJsonResponse(),
    authenticateTelegramRequest: makeAuth({ id: 999 }),
    getNumericEnv: makeGetNumericEnv(),
    normalizeOptionalString: makeNormalizeOptionalString(),
    sessionRepo: repo,
  });

  // Pre-seed another user (VICTIM) in the DO
  await doBinding.fetch('https://do/internal?action=heartbeat&userId=VICTIM&ttl=240000');
  assert.equal((await (await doBinding.fetch('https://do/internal?action=count')).json()).count, 1);

  // Attacker (auth=999) tries to end VICTIM's session via query param
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const req = makeMockRequest('POST', '/api/sessions/end?userId=VICTIM');
  await handlers.handleEnd(req, env);

  // The DO end call must target user 999 (the authenticated user), NOT VICTIM
  const calls = doBinding._getCalls();
  const endCall = calls.find(c => c.action === 'end');
  assert.ok(endCall, 'end must call DO');
  assert.equal(endCall.userId, '999', 'end must target authenticated userId');
  assert.notEqual(endCall.userId, 'VICTIM', 'end must NOT allow evicting another user');

  // VICTIM must still be present in the DO (end could not evict another user)
  const countAfter = await (await doBinding.fetch('https://do/internal?action=count')).json();
  assert.equal(countAfter.count, 1, 'VICTIM must survive (end must NOT evict another user)');
});

test('P5.security: unauthenticated heartbeat returns auth error (no DO call)', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const factory = loadSessionHandlersFactory();
  const handlers = factory({
    jsonResponse: makeJsonResponse(),
    authenticateTelegramRequest: makeAuth({ id: 123 }, { deny: true }),
    getNumericEnv: makeGetNumericEnv(),
    normalizeOptionalString: makeNormalizeOptionalString(),
    sessionRepo: repo,
  });
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const res = await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat'), env);
  assert.equal(res.status, 401, 'unauthenticated heartbeat must return 401');
  assert.equal(doBinding._getFetchCount(), 0, 'DO must NOT be called when auth fails');
});

test('P5.security: unauthenticated online returns auth error (no DO call)', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const factory = loadSessionHandlersFactory();
  const handlers = factory({
    jsonResponse: makeJsonResponse(),
    authenticateTelegramRequest: makeAuth({ id: 123 }, { deny: true }),
    getNumericEnv: makeGetNumericEnv(),
    normalizeOptionalString: makeNormalizeOptionalString(),
    sessionRepo: repo,
  });
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };
  const res = await handlers.handleOnline(makeMockRequest('GET', '/api/sessions/online'), env);
  assert.equal(res.status, 401);
  assert.equal(doBinding._getFetchCount(), 0);
});

// ============================================================================
// SECTION 6 — No other endpoint uses session:presence_state as primary source
// ============================================================================

test('P6.no-old-endpoint: worker-proxy.js only references presence_state in a comment', () => {
  // Every reference to session:presence_state / readPresenceState / persistPresenceState
  // in worker-proxy.js must be inside the sessions controller wiring or a comment.
  const lines = WORKER_SRC.split('\n');
  let violations = [];
  lines.forEach((line, idx) => {
    if (/session:presence_state|readPresenceState|persistPresenceState|prunePresenceState/.test(line)) {
      // Allowed: comment lines, or the sessionRepo wiring line, or the architecture comment
      const isComment = /^\s*\/\//.test(line) || /^\s*\*/.test(line);
      const isWiring = /createSessionRepository/.test(line);
      if (!isComment && !isWiring) {
        violations.push({ line: idx + 1, text: line.trim() });
      }
    }
  });
  assert.equal(violations.length, 0,
    `no endpoint outside sessions controller may use presence_state as source: ${JSON.stringify(violations)}`);
});

test('P6.no-old-endpoint: sessions controller only touches KV in fallback branch', () => {
  // The controller source must guard every readPresenceState/persistPresenceState call
  // behind the KV fallback (i.e., after the DO block). We verify by checking that
  // readPresenceState/persistPresenceState appear ONLY after `if (env.PRESENCE_DO)` blocks.
  // Heuristic: count of `readPresenceState` calls == count of DO-fallback paths (3: hb/online/end).
  const ctrl = SESSIONS_CTRL_SRC;
  const readCount = (ctrl.match(/readPresenceState/g) || []).length;
  const persistCount = (ctrl.match(/persistPresenceState/g) || []).length;
  const doGuardCount = (ctrl.match(/if \(env\.PRESENCE_DO\)/g) || []).length;
  assert.equal(doGuardCount, 3, 'all 3 handlers must guard on env.PRESENCE_DO');
  assert.ok(readCount <= 3, `readPresenceState must only appear in fallback (<=3), got ${readCount}`);
  assert.ok(persistCount <= 2, `persistPresenceState must only appear in heartbeat+end fallback (<=2), got ${persistCount}`);
});

// ============================================================================
// SECTION 7 — const-reassignment regression guard (CRITICAL)
// ============================================================================
// The Worker count cache is declared with `const _onlineCountCache = {...}` but
// every handler reassigns it (`_onlineCountCache = {...}`). This throws
// `TypeError: Assignment to constant variable.` at runtime, gets caught by the
// surrounding try/catch, and silently falls through to KV — defeating the DO
// migration (KV RMW race is NOT eliminated). This suite MUST detect it.

test('P7.const-cache: _onlineCountCache is reassignable (no const-rebinding bug)', () => {
  // Extract the cache declaration line
  const m = SESSIONS_CTRL_SRC.match(/(const|let|var)\s+_onlineCountCache\s*=\s*\{/);
  assert.ok(m, '_onlineCountCache declaration must exist');
  const declKind = m[1];
  assert.equal(declKind, 'let',
    `CRITICAL BUG: _onlineCountCache is declared with "${declKind}" but reassigned in handlers → ` +
    `use "let" instead. With "const", every DO-path cache update throws TypeError and silently ` +
    `falls through to KV, defeating the entire PresenceDO migration.`);
});

test('P7.const-cache: handlers reassign _onlineCountCache (must be let)', () => {
  // Count reassignments
  const reassignCount = (SESSIONS_CTRL_SRC.match(/_onlineCountCache\s*=\s*\{/g) || []).length;
  assert.ok(reassignCount >= 3,
    `_onlineCountCache must be reassigned in >=3 handlers (heartbeat/online/end), found ${reassignCount}`);
});

// ============================================================================
// SECTION 8 — Duplicate tab (same userId heartbeat idempotency via controller)
// ============================================================================

test('P8.duplicate-tab: two heartbeats from same user → count stays 1', async () => {
  const PresenceDO = loadPresenceDOClass();
  const doBinding = createMockPresenceDOBinding(PresenceDO);
  const repo = createMockSessionRepo();
  const handlers = buildHandlers(repo);
  const env = { PRESENCE_DO: doBinding, SESSION_TTL: 240 };

  const r1 = await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat?session_id=t1'), env);
  const b1 = await r1.json();
  assert.equal(b1.online_count, 1, 'first tab → 1');

  // Second "tab" — same authenticated user, different session_id
  const r2 = await handlers.handleHeartbeat(makeMockRequest('POST', '/api/sessions/heartbeat?session_id=t2'), env);
  const b2 = await r2.json();
  assert.equal(b2.online_count, 1, 'duplicate tab (same userId) → count stays 1');
});

// ============================================================================
// SECTION 9 — Cache TTL boundary (30s) — structural verification
// ============================================================================

test('P9.cache-ttl: ONLINE_COUNT_CACHE_TTL_MS is 30000 (30s)', () => {
  const m = SESSIONS_CTRL_SRC.match(/ONLINE_COUNT_CACHE_TTL_MS\s*=\s*(\d+)/);
  assert.ok(m, 'ONLINE_COUNT_CACHE_TTL_MS constant must exist');
  assert.equal(Number(m[1]), 30000, 'cache TTL must be exactly 30000ms (30s)');
});

test('P9.cache-ttl: cache guards on expiresAt (expiry respected)', () => {
  // The online handler must check `now < _onlineCountCache.expiresAt` for cache hit
  assert.match(SESSIONS_CTRL_SRC, /now\s*<\s*_onlineCountCache\.expiresAt/,
    'online handler must respect cache expiry via now < expiresAt check');
});

// ============================================================================
// SECTION 10 — DO class structural requirements (TTL default, alarm 60s)
// ============================================================================

test('P10.do-structure: default TTL is 240000ms (240s)', () => {
  // PresenceDO.fetch reads ttl param with default 240000 (via `Number(...) || 240000`)
  assert.match(PRESENCE_DO_CLASS_SRC, /\|\|\s*240000\b/,
    'PresenceDO default TTL must be 240000ms (Number(ttl) || 240000)');
});

test('P10.do-structure: alarm reschedules ~60s (60000ms)', () => {
  assert.match(PRESENCE_DO_CLASS_SRC, /setAlarm\(\s*now\s*\+\s*60000\s*\)/,
    'alarm() must reschedule with now + 60000');
});

test('P10.do-structure: initial alarm set ~60s on first fetch', () => {
  assert.match(PRESENCE_DO_CLASS_SRC, /setAlarm\(\s*now\s*\+\s*60000\s*\)/,
    'first fetch must set initial alarm at now + 60000');
});

test('P10.do-structure: no persistence (in-memory Map only)', () => {
  // The class must NOT call state.storage.put/get for session data (only alarm)
  const storageCalls = (PRESENCE_DO_CLASS_SRC.match(/state\.storage\.(put|get|delete)\(/g) || [])
    .filter(s => !s.includes('getAlarm') && !s.includes('setAlarm') && !s.includes('deleteAlarm'));
  assert.equal(storageCalls.length, 0,
    'PresenceDO must NOT persist session data to storage (in-memory Map only); ' +
    `found storage calls: ${JSON.stringify(storageCalls)}`);
});

/**
 * Focused Verification — Bootstrap Rate Limit Fix
 *
 * Tests that the rate limit uses HMAC-validated userId, NOT unvalidated
 * initData. Verifies that an attacker with fake initData CANNOT consume
 * a victim's rate limit quota.
 *
 * Also tests that /api/notif-trace-results returns generic error (no e.message).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function buildInitData(botToken, user) {
  const entries = [
    ['auth_date', String(Math.floor(Date.now() / 1000))],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', JSON.stringify(user)],
  ];
  const dataCheckString = entries
    .slice()
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return entries
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .concat([`hash=${hash}`])
    .join('&');
}

/** Build INVALID initData (wrong hash) with a specific user ID */
function buildFakeInitData(user) {
  const entries = [
    ['auth_date', String(Math.floor(Date.now() / 1000))],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', JSON.stringify(user)],
    ['hash', '0000000000000000000000000000000000000000000000000000000000000000'],
  ];
  return entries
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
let _workerSourceCache = null;
function getWorkerSource() {
  if (!_workerSourceCache) _workerSourceCache = fs.readFileSync(WORKER_PATH, 'utf8');
  return _workerSourceCache;
}

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    async list({ prefix, limit } = {}) {
      const keys = [];
      for (const k of store.keys()) {
        if (!prefix || k.startsWith(prefix)) {
          keys.push({ name: k });
          if (keys.length >= (limit || 1000)) break;
        }
      }
      return { keys };
    },
  };
}

function createEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: 'postgres://mock?pgbouncer=true',
    APP_ENV: 'development',
    BOT_USERNAME: '',
    APP_CACHE: createMemoryKv(),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
    ...overrides,
  };
}

function createCountingPoolMock() {
  let _poolCount = 0;
  let _endCount = 0;
  let _queryCount = 0;
  const Pool = class Pool {
    constructor(opts) { _poolCount++; }
    async query(sql, params) {
      _queryCount++;
      const sqlLower = (sql || '').toLowerCase();
      if (sqlLower.includes('insert into users') && sqlLower.includes('returning')) {
        return { rows: [{ telegram_id: String(params?.[0] || '123456'), username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      }
      if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where telegram_id')) return { rows: [] };
      if (sqlLower.includes('from watchlist_items')) return { rows: [] };
      if (sqlLower.includes('from referrals')) return { rows: [] };
      if (sqlLower.includes('from token_balances')) return { rows: [] };
      if (sqlLower.includes('from token_transactions')) return { rows: [] };
      if (sqlLower.includes('from price_alerts')) return { rows: [] };
      if (sqlLower.includes('from notifications')) return { rows: [] };
      if (sqlLower.includes('from notification_settings')) return { rows: [] };
      if (sqlLower.includes('from analyses')) return { rows: [] };
      if (sqlLower.includes('from admins')) return { rows: [] };
      if (sqlLower.includes('on conflict') && sqlLower.includes('do nothing')) return { rows: [] };
      return { rows: [] };
    }
    async connect() {
      const self = this;
      return {
        async query(sql, params) { return self.query(sql, params); },
        release() {},
      };
    }
    end() { _endCount++; return Promise.resolve(); }
  };
  const neon = function() {
    const fn = async () => ({ rows: [] });
    fn.query = async () => ({ rows: [] });
    fn.transaction = async (cb) => cb({ query: fn.query });
    return fn;
  };
  return {
    '@neondatabase/serverless': { Pool, neon },
    _getStats: () => ({ poolCount: _poolCount, endCount: _endCount, queryCount: _queryCount }),
    _reset: () => { _poolCount = 0; _endCount = 0; _queryCount = 0; },
  };
}

function loadWorkerWithCountingPool() {
  const source = getWorkerSource();
  const mock = createCountingPoolMock();
  const defaultMocks = { '@neondatabase/serverless': mock['@neondatabase/serverless'] };
  const localModuleCache = {};
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(defaultMocks, id)) return defaultMocks[id];
    if (localModuleCache[id]) return localModuleCache[id];
    return require(id);
  };
  const localImportRe = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g;
  let localMatch;
  while ((localMatch = localImportRe.exec(source)) !== null) {
    const importPath = localMatch[4];
    if (localModuleCache[importPath]) continue;
    const resolvedPath = path.resolve(path.dirname(WORKER_PATH), importPath);
    let modSource = fs.readFileSync(resolvedPath, 'utf8');
    modSource = modSource
      .replace(/export\s+function\s+(\w+)/g, 'module.exports.$1 = function $1')
      .replace(/export\s+default\s+/g, 'module.exports.default = ');
    const mod = { exports: {} };
    new Function('require', 'module', 'exports',
      'console.log = () => {}; console.warn = () => {}; console.error = () => {};\n' + modSource
    )(localRequire, mod, mod.exports);
    localModuleCache[importPath] = mod.exports;
  }
  const transformed = source
    .replace("import { createHmac, timingSafeEqual } from 'node:crypto';", "const { createHmac, timingSafeEqual } = require('node:crypto');")
    .replace("import { Pool, neon } from '@neondatabase/serverless';", "const { Pool, neon } = require('@neondatabase/serverless');")
    .replace(/import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, named, p) => `const { ${named} } = require('${p}');`)
    .replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, name, p) => `const ${name} = require('${p}');`)
    .replace(/import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, name, p) => `const ${name} = require('${p}');`)
    .replace('export default {', 'module.exports = {');
  const module = { exports: {} };
  const evaluator = new Function('require', 'module', 'exports',
    'console.log = () => {}; console.warn = () => {}; console.error = () => {};\n' + transformed
  );
  evaluator(localRequire, module, module.exports);
  return { worker: module.exports, getStats: mock._getStats, reset: mock._reset };
}

async function sendRequest(worker, env, method, urlPath, options = {}) {
  const { body, headers = {}, initData } = options;
  const url = urlPath.startsWith('http') ? urlPath : `http://localhost${urlPath}`;
  const reqHeaders = new Headers(headers);
  if (initData) reqHeaders.set('X-Telegram-Init-Data', initData);
  const reqOpts = { method, headers: reqHeaders };
  if (body !== undefined) {
    reqOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!reqHeaders.has('Content-Type')) reqHeaders.set('Content-Type', 'application/json');
  }
  const request = new Request(url, reqOpts);
  const response = await worker.fetch(request, env, {});
  let responseBody;
  try { responseBody = await response.json(); } catch { responseBody = null; }
  return { status: response.status, body: responseBody, headers: response.headers };
}

// ============================================================================
// TEST 1: Valid authenticated bootstrap works (no rate limit on first request)
// ============================================================================
test('Bootstrap RL Fix: valid authenticated request succeeds (200)', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {}, initData,
  });
  assert.equal(res.status, 200, 'valid bootstrap should succeed');
  assert.equal(res.body.status, 'success');
});

// ============================================================================
// TEST 2: Invalid HMAC does NOT consume rate limit quota
// ============================================================================
test('Bootstrap RL Fix: invalid HMAC does NOT increment rate limit counter', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();

  // Attacker sends 15 requests with FAKE initData (invalid hash) claiming to be user 999888
  const fakeUser = { id: 999888, first_name: 'Victim' };
  const fakeInitData = buildFakeInitData(fakeUser);

  for (let i = 0; i < 15; i++) {
    const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
      body: {}, initData: fakeInitData,
    });
    // Should get 401 (invalid HMAC), NOT 429 (rate limited)
    assert.equal(res.status, 401, `request ${i+1} with fake initData should get 401, not 429`);
  }

  // Now the REAL user 999888 sends a valid request — should NOT be rate limited
  const validInitData = buildInitData('test-bot-token', fakeUser);
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {}, initData: validInitData,
  });
  assert.equal(res.status, 200, 'real user should NOT be rate limited after attacker sent 15 fake requests');
  assert.equal(res.body.status, 'success');
});

// ============================================================================
// TEST 3: Valid user IS rate limited after 10 requests
// ============================================================================
test('Bootstrap RL Fix: valid user gets 429 after 10 requests in 60s', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();

  const user = { id: 777777, first_name: 'RateLimit' };
  const initData = buildInitData('test-bot-token', user);

  // Send 10 requests — all should succeed (or get DB-related responses, not 429)
  for (let i = 0; i < 10; i++) {
    const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
      body: {}, initData,
    });
    assert.ok(res.status === 200 || res.status === 503,
      `request ${i+1} should be 200 or 503, got ${res.status}`);
  }

  // 11th request should be rate limited
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {}, initData,
  });
  assert.equal(res.status, 429, '11th request should be rate limited');
  assert.equal(res.body.code, 'RATE_LIMITED');
});

// ============================================================================
// TEST 4: Different users have separate rate limit counters
// ============================================================================
test('Bootstrap RL Fix: different users have separate rate limit counters', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();

  const user1 = { id: 111111, first_name: 'User1' };
  const user2 = { id: 222222, first_name: 'User2' };
  const initData1 = buildInitData('test-bot-token', user1);
  const initData2 = buildInitData('test-bot-token', user2);

  // User 1 sends 10 requests
  for (let i = 0; i < 10; i++) {
    await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
      body: {}, initData: initData1,
    });
  }

  // User 1 is now rate limited
  const res1 = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {}, initData: initData1,
  });
  assert.equal(res1.status, 429, 'user 1 should be rate limited');

  // User 2 should NOT be rate limited
  const res2 = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {}, initData: initData2,
  });
  assert.ok(res2.status === 200 || res2.status === 503,
    'user 2 should NOT be rate limited');
});

// ============================================================================
// TEST 5: Rate limit uses HMAC-validated userId (attacker can't consume victim's quota)
// ============================================================================
test('Bootstrap RL Fix: attacker with fake userId CANNOT consume victim quota', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();

  const victim = { id: 555555, first_name: 'Victim' };
  const attackerFakeInitData = buildFakeInitData(victim);

  // Attacker sends 20 requests with fake initData claiming to be victim
  for (let i = 0; i < 20; i++) {
    const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
      body: {}, initData: attackerFakeInitData,
    });
    assert.equal(res.status, 401, `attacker request ${i+1} should get 401`);
  }

  // Victim sends valid request — should NOT be rate limited
  const victimInitData = buildInitData('test-bot-token', victim);
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {}, initData: victimInitData,
  });
  assert.equal(res.status, 200, 'victim should NOT be rate limited — attacker could not consume quota');
  assert.equal(res.body.status, 'success');
});

// ============================================================================
// TEST 6: /api/notif-trace-results returns generic error (no e.message leak)
// ============================================================================
test('Bootstrap RL Fix: /api/notif-trace-results returns generic error in non-production', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  // Use development env so the endpoint is accessible (not gated)
  const env = createEnv({ APP_ENV: 'development' });
  reset();

  // The endpoint should return a generic error, not raw e.message
  // We need to trigger an error — remove APP_CACHE.list to cause the catch block
  const envNoCache = createEnv({ APP_ENV: 'development', APP_CACHE: null });
  const res = await sendRequest(worker, envNoCache, 'GET', '/api/notif-trace-results');

  // Should return 500 with generic message (or 200 with empty traces if no error)
  // The key assertion: response body does NOT contain raw e.message
  if (res.status === 500) {
    assert.equal(res.body.status, 'error', 'should have status: error');
    assert.equal(res.body.message, 'Failed to load traces',
      'should have generic message, NOT raw e.message');
    // Verify NO 'error' field with raw message
    assert.ok(!res.body.error || res.body.error === undefined,
      'should NOT have raw error field');
  }
});

// ============================================================================
// TEST 7: /api/notif-trace-results returns 404 in production
// ============================================================================
test('Bootstrap RL Fix: /api/notif-trace-results returns 404 in production', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv({ APP_ENV: 'production' });
  reset();

  const res = await sendRequest(worker, env, 'GET', '/api/notif-trace-results');
  assert.equal(res.status, 404, 'should return 404 in production');
  assert.equal(res.body.message, 'Not available in production');
});

module.exports = { loadWorkerWithCountingPool, createEnv, sendRequest, buildInitData, buildFakeInitData };

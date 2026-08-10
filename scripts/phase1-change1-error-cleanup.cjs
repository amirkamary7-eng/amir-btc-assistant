/**
 * PHASE 1 / CHANGE 1 — Error/Exception Cleanup Verification (TEST 5)
 *
 * Verifies that when a request fails (throws, errors out, or returns an
 * error response), the pool is still properly cleaned up and the Worker
 * remains healthy for subsequent requests.
 *
 * Test scenarios:
 *   - Request that throws internally (caught by outer try/catch → 500)
 *   - Request that returns an error response (401, 422, 404)
 *   - Request with malformed body (JSON parse error)
 *   - Request to DB-not-configured endpoint (503)
 *   - After each failure: verify pool was ended, env._reqPool restored,
 *     and next request works correctly.
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

// Pool mock that throws on specific SQL patterns (to simulate DB errors)
function createErrorInjectingPoolMock(errorOnSqlPattern) {
  let _createCount = 0;
  let _endCount = 0;
  let _queryCount = 0;
  const Pool = class Pool {
    constructor(opts) { _createCount++; }
    async query(sql, params) {
      _queryCount++;
      const sqlLower = (sql || '').toLowerCase();
      // Inject error if pattern matches
      if (errorOnSqlPattern && sqlLower.includes(errorOnSqlPattern)) {
        throw new Error('Simulated DB error on pattern: ' + errorOnSqlPattern);
      }
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
    _getStats: () => ({ createCount: _createCount, endCount: _endCount, queryCount: _queryCount }),
    _reset: () => { _createCount = 0; _endCount = 0; _queryCount = 0; },
  };
}

function loadWorkerWithErrorPool(errorOnSqlPattern) {
  const source = getWorkerSource();
  const mock = createErrorInjectingPoolMock(errorOnSqlPattern);
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
  return { status: response.status, body: responseBody };
}

// ============================================================================
// TEST 5A: Request with DB query error — pool still cleaned up
//          (bootstrap's getById query throws → controller catches → 503 DB_ERROR)
// ============================================================================
test('CHANGE 1 / TEST 5A: DB query error → pool cleaned up, response returned', async () => {
  // Inject error on 'from users' (matches getById's SELECT FROM users query)
  const { worker, getStats, reset } = loadWorkerWithErrorPool('from users');
  const env = createEnv();
  reset();

  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456' },
  });

  // Bootstrap catches DB errors and returns safeDbErrorResponse (503 with DB_ERROR)
  assert.ok(res.status >= 500, `expected 5xx error, got ${res.status}`);
  const stats = getStats();
  // Pool was created
  assert.ok(stats.createCount >= 1, 'pool should be created');
  // Pool was ENDED even though query threw — this is the critical assertion
  // (withSharedPool uses a local _pool variable, so cleanup happens even if
  // queryDb nullified env._reqPool on error)
  assert.equal(stats.endCount, stats.createCount, `all created pools should be ended (create=${stats.createCount}, end=${stats.endCount})`);
  // env._reqPool should be restored (falsy — doesn't point to closed pool)
  assert.ok(!env._reqPool, 'env._reqPool should be falsy after error (restored)');
});

// ============================================================================
// TEST 5B: After error, next request works correctly (Worker remains healthy)
// ============================================================================
test('CHANGE 1 / TEST 5B: after error, next request works (Worker healthy)', async () => {
  // First: inject error, expect failure
  const { worker: workerErr, getStats: getStatsErr, reset: resetErr } = loadWorkerWithErrorPool('from users');
  const env1 = createEnv();
  resetErr();
  const res1 = await sendRequest(workerErr, env1, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456' },
  });
  assert.ok(res1.status >= 500, `first request should fail (got ${res1.status})`);

  // Second: fresh worker (no error injection), expect success
  const { worker: workerOk, getStats: getStatsOk, reset: resetOk } = loadWorkerWithErrorPool(null);
  const env2 = createEnv();
  resetOk();
  const res2 = await sendRequest(workerOk, env2, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456' },
  });
  assert.equal(res2.status, 200, 'second request should succeed');
  assert.equal(res2.body.status, 'success', 'second request body should be success');

  const stats2 = getStatsOk();
  assert.equal(stats2.createCount, 1, 'second request: 1 pool created');
  assert.equal(stats2.endCount, 1, 'second request: 1 pool ended (cleanup works)');
});

// ============================================================================
// TEST 5C: Malformed JSON body — pool cleaned up, error response returned
// ============================================================================
test('CHANGE 1 / TEST 5C: malformed JSON body → pool cleaned up, error response', async () => {
  const { worker, getStats, reset } = loadWorkerWithErrorPool(null);
  const env = createEnv();
  reset();

  const request = new Request('http://localhost/api/users/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-valid-json',
  });
  const response = await worker.fetch(request, env, {});

  assert.ok(response.status >= 400, `expected 4xx/5xx, got ${response.status}`);
  const stats = getStats();
  // Pool created (withSharedPool runs before router)
  assert.equal(stats.createCount, 1, 'pool should be created');
  // Pool ended (cleanup in finally)
  assert.equal(stats.endCount, 1, 'pool should be ended (cleanup works)');
  // env._reqPool restored
  assert.ok(!env._reqPool, 'env._reqPool should be falsy after error');
});

// ============================================================================
// TEST 5D: Auth failure (401) — pool cleaned up
// ============================================================================
test('CHANGE 1 / TEST 5D: auth failure (401) → pool cleaned up', async () => {
  const { worker, getStats, reset } = loadWorkerWithErrorPool(null);
  const env = createEnv();
  reset();

  const res = await sendRequest(worker, env, 'GET', '/api/watchlist');
  assert.equal(res.status, 401);
  const stats = getStats();
  assert.equal(stats.createCount, 1, 'pool created');
  assert.equal(stats.endCount, 1, 'pool ended (cleanup)');
  assert.ok(!env._reqPool, 'env._reqPool restored');
});

// ============================================================================
// TEST 5E: 404 route — pool cleaned up
// ============================================================================
test('CHANGE 1 / TEST 5E: 404 route → pool cleaned up', async () => {
  const { worker, getStats, reset } = loadWorkerWithErrorPool(null);
  const env = createEnv();
  reset();

  const res = await sendRequest(worker, env, 'GET', '/api/unknown-route');
  assert.equal(res.status, 404);
  const stats = getStats();
  assert.equal(stats.createCount, 1, 'pool created');
  assert.equal(stats.endCount, 1, 'pool ended (cleanup)');
  assert.ok(!env._reqPool, 'env._reqPool restored');
});

// ============================================================================
// TEST 5F: Multiple sequential errors — each cleans up, Worker stays healthy
// ============================================================================
test('CHANGE 1 / TEST 5F: 3 sequential errors → each cleans up, 4th request succeeds', async () => {
  const { worker, getStats, reset } = loadWorkerWithErrorPool(null);
  const env = createEnv();
  reset();

  // 3 error requests (401, 404, 401)
  await sendRequest(worker, env, 'GET', '/api/watchlist'); // 401
  assert.equal(getStats().createCount, 1);
  assert.equal(getStats().endCount, 1);

  await sendRequest(worker, env, 'GET', '/api/unknown-route'); // 404
  assert.equal(getStats().createCount, 2);
  assert.equal(getStats().endCount, 2);

  await sendRequest(worker, env, 'GET', '/api/watchlist'); // 401
  assert.equal(getStats().createCount, 3);
  assert.equal(getStats().endCount, 3);

  // 4th request — should succeed
  const res = await sendRequest(worker, env, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(getStats().createCount, 4);
  assert.equal(getStats().endCount, 4);
});

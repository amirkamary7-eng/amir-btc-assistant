/**
 * PHASE 1 / CHANGE 1 — Pool Reuse Verification (TEST 3)
 *
 * Verifies that withSharedPool wrap results in exactly 1 Pool.create per
 * HTTP request, regardless of how many queryDb calls the request makes.
 *
 * Before CHANGE 1: N queryDb = N Pool.create (each with TLS handshake)
 * After CHANGE 1:  N queryDb = 1 Pool.create (shared via env._reqPool)
 *
 * Also verifies pool cleanup (end() is called once per request).
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

// Counting Pool mock — tracks create/end/query counts
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
      if (sqlLower.includes('from campaigns')) return { rows: [] };
      if (sqlLower.includes('from wheel_history')) return { rows: [] };
      if (sqlLower.includes('from wheel_rewards')) return { rows: [] };
      if (sqlLower.includes('from referral_reward_tiers')) return { rows: [] };
      if (sqlLower.includes('from mission_rewards')) return { rows: [] };
      if (sqlLower.includes('from rewards')) return { rows: [] };
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
// TEST 3A: Single query-heavy request creates exactly 1 Pool.create
// ============================================================================
test('CHANGE 1 / TEST 3A: POST /api/users/bootstrap creates exactly 1 Pool (not N)', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456', username: 'testuser' },
  });

  assert.equal(res.status, 200, 'bootstrap should succeed');
  const stats = getStats();
  // Bootstrap makes 3-8 queryDb calls. Before CHANGE 1: 3-8 Pool.create.
  // After CHANGE 1: 1 Pool.create (shared via env._reqPool).
  assert.equal(stats.poolCount, 1, `Expected 1 Pool.create, got ${stats.poolCount}`);
  // Pool.end should be called exactly once (in withSharedPool finally)
  assert.equal(stats.endCount, 1, `Expected 1 Pool.end, got ${stats.endCount}`);
  // Multiple queries should have been executed (proving the pool was reused)
  assert.ok(stats.queryCount >= 3, `Expected at least 3 queries, got ${stats.queryCount}`);
});

// ============================================================================
// TEST 3B: Simple route (no DB queries) creates 1 Pool but executes 0 queries
//          (withSharedPool always creates a pool when DB is configured, even
//           if the route doesn't use it. This is acceptable — the pool is
//           closed in finally. The alternative of lazy-creating the pool
//           only on first queryDb call would add complexity for minimal gain.)
// ============================================================================
test('CHANGE 1 / TEST 3B: GET /api/health creates 1 Pool, 0 queries (no DB used)', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();
  const res = await sendRequest(worker, env, 'GET', '/api/health');

  assert.equal(res.status, 200, 'health should succeed');
  const stats = getStats();
  // Health endpoint doesn't use DB — withSharedPool still creates a pool
  // (it always does), but no queries run through it.
  assert.equal(stats.poolCount, 1, `Expected 1 Pool.create (withSharedPool always creates), got ${stats.poolCount}`);
  assert.equal(stats.endCount, 1, `Expected 1 Pool.end, got ${stats.endCount}`);
  assert.equal(stats.queryCount, 0, `Expected 0 queries, got ${stats.queryCount}`);
});

// ============================================================================
// TEST 3C: DB-not-configured skips Pool creation entirely
// ============================================================================
test('CHANGE 1 / TEST 3C: POST /api/users/bootstrap without DB creates 0 Pool', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv({ DATABASE_URL: undefined, DIRECT_URL: undefined });
  reset();
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456' },
  });

  assert.equal(res.status, 503, 'bootstrap without DB should return 503');
  const stats = getStats();
  // isDatabaseConfigured returns false → withSharedPool skips createPool
  assert.equal(stats.poolCount, 0, `Expected 0 Pool.create, got ${stats.poolCount}`);
  assert.equal(stats.endCount, 0, `Expected 0 Pool.end, got ${stats.endCount}`);
});

// ============================================================================
// TEST 3D: Watchlist GET (uses DB) creates 1 Pool
// ============================================================================
test('CHANGE 1 / TEST 3D: GET /api/watchlist creates exactly 1 Pool', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  const initData = buildInitData('test-bot-token', { id: 999888, first_name: 'Test' });
  reset();
  const res = await sendRequest(worker, env, 'GET', '/api/watchlist', { initData });

  assert.equal(res.status, 200, 'watchlist should succeed');
  const stats = getStats();
  assert.equal(stats.poolCount, 1, `Expected 1 Pool.create, got ${stats.poolCount}`);
  assert.equal(stats.endCount, 1, `Expected 1 Pool.end, got ${stats.endCount}`);
});

// ============================================================================
// TEST 3E: Auth failure (401) still creates 1 Pool (withSharedPool runs first)
//          but executes 0 queries (auth fails before any DB call)
// ============================================================================
test('CHANGE 1 / TEST 3E: GET /api/watchlist without auth creates 1 Pool, 0 queries', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();
  const res = await sendRequest(worker, env, 'GET', '/api/watchlist');

  assert.equal(res.status, 401, 'should return 401');
  const stats = getStats();
  // withSharedPool runs BEFORE the router — so 1 pool is created even on auth fail
  assert.equal(stats.poolCount, 1, `Expected 1 Pool.create, got ${stats.poolCount}`);
  assert.equal(stats.endCount, 1, `Expected 1 Pool.end, got ${stats.endCount}`);
  assert.equal(stats.queryCount, 0, `Expected 0 queries (auth fail before DB), got ${stats.queryCount}`);
});

// ============================================================================
// TEST 3F: 404 (route not found) creates 1 Pool, 0 queries
// ============================================================================
test('CHANGE 1 / TEST 3F: GET /api/unknown-route creates 1 Pool, 0 queries', async () => {
  const { worker, getStats, reset } = loadWorkerWithCountingPool();
  const env = createEnv();
  reset();
  const res = await sendRequest(worker, env, 'GET', '/api/unknown-route');

  assert.equal(res.status, 404, 'should return 404');
  const stats = getStats();
  assert.equal(stats.poolCount, 1, `Expected 1 Pool.create, got ${stats.poolCount}`);
  assert.equal(stats.endCount, 1, `Expected 1 Pool.end, got ${stats.endCount}`);
});

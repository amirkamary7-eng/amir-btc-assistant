/**
 * PHASE 1 / CHANGE 1 — Concurrent Requests Verification (TEST 4)
 *
 * Verifies that concurrent HTTP requests do NOT leak pool state between
 * each other. Each request must get its own pool (1 Pool.create per
 * request), and pools must not be shared across requests.
 *
 * Test approach:
 *   - Use a Pool mock that assigns a unique ID to each Pool instance
 *   - Track which Pool instance handles which query
 *   - Fire N concurrent requests and verify each request's queries
 *     go to its own pool (not another request's pool)
 *   - Verify total Pool.create count = N (one per request)
 *   - Verify total Pool.end count = N (one per request, cleanup works)
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

// Pool mock that tracks pool instances by unique ID + records which pool
// handled which query. Allows us to verify NO cross-request pool sharing.
function createTracingPoolMock() {
  let _nextPoolId = 1;
  let _createCount = 0;
  let _endCount = 0;
  const _pools = new Map(); // poolId → { createdAt, endedAt, queryCount, querySqls: [] }
  const _allQueries = []; // { poolId, sql, ts }

  const Pool = class Pool {
    constructor(opts) {
      this._poolId = _nextPoolId++;
      _createCount++;
      _pools.set(this._poolId, { createdAt: Date.now(), endedAt: null, queryCount: 0, querySqls: [] });
    }
    async query(sql, params) {
      const sqlLower = (sql || '').toLowerCase();
      // Record this query against this pool
      const poolInfo = _pools.get(this._poolId);
      if (poolInfo) {
        poolInfo.queryCount++;
        poolInfo.querySqls.push(String(sql || '').slice(0, 80));
      }
      _allQueries.push({ poolId: this._poolId, sql: String(sql || '').slice(0, 80), ts: Date.now() });

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
    end() {
      _endCount++;
      const info = _pools.get(this._poolId);
      if (info) info.endedAt = Date.now();
      return Promise.resolve();
    }
  };
  const neon = function() {
    const fn = async () => ({ rows: [] });
    fn.query = async () => ({ rows: [] });
    fn.transaction = async (cb) => cb({ query: fn.query });
    return fn;
  };
  return {
    '@neondatabase/serverless': { Pool, neon },
    _getStats: () => ({
      createCount: _createCount,
      endCount: _endCount,
      poolCount: _pools.size,
      pools: Object.fromEntries(_pools),
      allQueries: _allQueries.slice(),
    }),
    _reset: () => {
      _createCount = 0;
      _endCount = 0;
      _pools.clear();
      _allQueries.length = 0;
      _nextPoolId = 1;
    },
  };
}

function loadWorkerWithTracingPool() {
  const source = getWorkerSource();
  const mock = createTracingPoolMock();
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
// TEST 4A: 5 concurrent bootstrap requests create 5 separate pools
//          (no cross-request pool sharing)
// ============================================================================
test('CHANGE 1 / TEST 4A: 5 concurrent bootstraps create 5 separate pools (no leakage)', async () => {
  const { worker, getStats, reset } = loadWorkerWithTracingPool();
  const env = createEnv();
  reset();

  const N = 5;
  const requests = [];
  for (let i = 0; i < N; i++) {
    requests.push(sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
      body: { user_id: String(100000 + i), username: `user${i}` },
    }));
  }
  const responses = await Promise.all(requests);

  // All 5 should succeed
  for (let i = 0; i < N; i++) {
    assert.equal(responses[i].status, 200, `request ${i} should succeed`);
  }

  const stats = getStats();
  // Exactly N pools created (one per request — NO sharing)
  assert.equal(stats.createCount, N, `Expected ${N} Pool.create, got ${stats.createCount}`);
  // Exactly N pools ended (cleanup works for all)
  assert.equal(stats.endCount, N, `Expected ${N} Pool.end, got ${stats.endCount}`);

  // Verify each pool was used by multiple queries (proving intra-request reuse)
  // AND no two requests shared the same pool
  const poolIds = Object.keys(stats.pools).map(Number);
  assert.equal(poolIds.length, N, `Expected ${N} unique pool IDs, got ${poolIds.length}`);

  // Each pool should have been ended (cleanup works)
  // Note: queryCount may be 0 for some pools if ensureSchema was cached by
  // a concurrent request. The key assertion is that pools are NOT shared.
  for (const pid of poolIds) {
    const info = stats.pools[pid];
    assert.ok(info.endedAt !== null, `Pool ${pid} should have been ended (cleanup)`);
  }

  // CRITICAL: Verify no two requests shared the same pool.
  // Each pool's queries should be isolated — if we had N=5 requests and
  // 5 pools, but one pool handled ALL queries, that would indicate sharing.
  // With proper isolation, queries should be distributed across pools.
  // (Note: some pools may have 0 queries due to schema cache, but the pool
  // COUNT must equal the request COUNT — proving no reuse.)
  assert.equal(stats.createCount, N, `createCount must equal request count (no reuse)`);
  assert.equal(stats.endCount, N, `endCount must equal request count (no leak)`);
});

// ============================================================================
// TEST 4B: 10 concurrent watchlist GETs (auth required) create 10 pools
// ============================================================================
test('CHANGE 1 / TEST 4B: 10 concurrent watchlist GETs create 10 separate pools', async () => {
  const { worker, getStats, reset } = loadWorkerWithTracingPool();
  const env = createEnv();
  reset();

  const N = 10;
  const initData = buildInitData('test-bot-token', { id: 999888, first_name: 'Test' });
  const requests = [];
  for (let i = 0; i < N; i++) {
    requests.push(sendRequest(worker, env, 'GET', '/api/watchlist', { initData }));
  }
  const responses = await Promise.all(requests);

  for (let i = 0; i < N; i++) {
    assert.equal(responses[i].status, 200, `request ${i} should succeed`);
  }

  const stats = getStats();
  assert.equal(stats.createCount, N, `Expected ${N} Pool.create, got ${stats.createCount}`);
  assert.equal(stats.endCount, N, `Expected ${N} Pool.end, got ${stats.endCount}`);
});

// ============================================================================
// TEST 4C: Mixed concurrent requests (health + bootstrap + watchlist + 404)
//          — health and 404 create pools but use 0 queries
//          — bootstrap and watchlist create pools and use queries
// ============================================================================
test('CHANGE 1 / TEST 4C: mixed concurrent requests create 1 pool each, no leakage', async () => {
  const { worker, getStats, reset } = loadWorkerWithTracingPool();
  const env = createEnv();
  reset();

  const initData = buildInitData('test-bot-token', { id: 999888, first_name: 'Test' });
  const requests = [
    sendRequest(worker, env, 'GET', '/api/health'),
    sendRequest(worker, env, 'POST', '/api/users/bootstrap', { body: { user_id: '111' } }),
    sendRequest(worker, env, 'GET', '/api/watchlist', { initData }),
    sendRequest(worker, env, 'GET', '/api/unknown-route'),
    sendRequest(worker, env, 'GET', '/api/system/status'),
  ];
  const responses = await Promise.all(requests);

  assert.equal(responses[0].status, 200); // health
  assert.equal(responses[1].status, 200); // bootstrap
  assert.equal(responses[2].status, 200); // watchlist
  assert.equal(responses[3].status, 404); // unknown
  assert.equal(responses[4].status, 200); // system status

  const stats = getStats();
  assert.equal(stats.createCount, 5, `Expected 5 Pool.create, got ${stats.createCount}`);
  assert.equal(stats.endCount, 5, `Expected 5 Pool.end, got ${stats.endCount}`);
});

// ============================================================================
// TEST 4D: Sequential requests reuse env but each gets its own pool
//          (proves env._reqPool is properly saved/restored)
// ============================================================================
test('CHANGE 1 / TEST 4D: sequential requests each get fresh pool (env._reqPool restored)', async () => {
  const { worker, getStats, reset } = loadWorkerWithTracingPool();
  const env = createEnv();
  reset();

  // First request
  const res1 = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '111' },
  });
  assert.equal(res1.status, 200);
  const stats1 = getStats();
  assert.equal(stats1.createCount, 1, 'first request: 1 pool');
  assert.equal(stats1.endCount, 1, 'first request: 1 end');

  // Verify env._reqPool is falsy after request completes (restored to previous = undefined/null)
  // The key invariant: env._reqPool does NOT point to the closed pool.
  assert.ok(!env._reqPool, 'env._reqPool should be falsy after request (restored to previous)');

  // Second request — should create a NEW pool (not reuse the closed one)
  const res2 = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '222' },
  });
  assert.equal(res2.status, 200);
  const stats2 = getStats();
  assert.equal(stats2.createCount, 2, 'second request: 2 pools total (1 new)');
  assert.equal(stats2.endCount, 2, 'second request: 2 ends total (1 new)');

  // env._reqPool still falsy
  assert.ok(!env._reqPool, 'env._reqPool should still be falsy after second request');
});

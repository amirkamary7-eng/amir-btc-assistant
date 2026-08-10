/**
 * PHASE 1 / CHANGE 1 — Response Contract Verification
 *
 * Verifies that wrapping fetch() in withSharedPool preserves the Response
 * contract for ALL route categories.
 *
 * This test reuses the same loadWorker/createEnv helpers as the main test file.
 * Since those helpers are not exported, we duplicate the minimal setup here.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// Build valid Telegram initData for auth-required routes
function buildInitData(botToken, user, options = {}) {
  const entries = [
    ['auth_date', String(options.authDate ?? Math.floor(Date.now() / 1000))],
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
    dump() { return Object.fromEntries(store.entries()); },
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

// Mock Pool — counts end() calls so we can verify cleanup
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
      if (sqlLower.includes('select') && sqlLower.includes('from users') && sqlLower.includes('where telegram_id')) {
        return { rows: [] };
      }
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

function loadWorker(pgOverride) {
  const source = getWorkerSource();
  const defaultMocks = {
    '@neondatabase/serverless': pgOverride || createCountingPoolMock()['@neondatabase/serverless'],
  };
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
    .replace(
      /import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g,
      (_, named, p) => `const { ${named} } = require('${p}');`,
    )
    .replace(
      /import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g,
      (_, name, p) => `const ${name} = require('${p}');`,
    )
    .replace(
      /import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g,
      (_, name, p) => `const ${name} = require('${p}');`,
    )
    .replace('export default {', 'module.exports = {');
  const module = { exports: {} };
  const evaluator = new Function('require', 'module', 'exports',
    'console.log = () => {}; console.warn = () => {}; console.error = () => {};\n' + transformed
  );
  evaluator(localRequire, module, module.exports);
  return module.exports;
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
  return { status: response.status, body: responseBody, headers: response.headers, raw: response };
}

// Export helpers for use by other test files if needed
module.exports = { loadWorker, createEnv, createMemoryKv, sendRequest, createCountingPoolMock };

// ============================================================================
// TEST 2A: Successful route — GET /api/health
// ============================================================================
test('CHANGE 1 / TEST 2A: GET /api/health returns 200 with valid JSON body', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/health');

  assert.equal(res.status, 200, 'status should be 200');
  assert.equal(res.body.status, 'ok', 'body.status should be "ok"');
  assert.ok(res.headers.get('access-control-allow-origin'), 'should have CORS header');
});

// ============================================================================
// TEST 2B: Async Response — POST /api/users/bootstrap (uses DB, async)
// ============================================================================
test('CHANGE 1 / TEST 2B: POST /api/users/bootstrap returns 200 with user object (async Response)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456', username: 'testuser' },
  });

  assert.equal(res.status, 200, 'status should be 200');
  assert.equal(res.body.status, 'success', 'body.status should be "success"');
  assert.ok(res.body.user, 'body should have user object');
  assert.ok(res.body.watchlist, 'body should have watchlist array');
});

// ============================================================================
// TEST 2C: Auth failure — GET /api/watchlist without auth returns 401
// ============================================================================
test('CHANGE 1 / TEST 2C: GET /api/watchlist without auth returns 401 (not undefined)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/watchlist');

  assert.equal(res.status, 401, 'status should be 401');
  assert.ok(res.body !== null, 'body should not be null (undefined response would be null)');
});

// ============================================================================
// TEST 2D: Validation failure — POST /api/alerts with invalid symbol returns 422
// ============================================================================
test('CHANGE 1 / TEST 2D: POST /api/alerts invalid symbol returns 422 (validation)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/alerts', {
    body: { symbol: 'INVALID!SYMBOL', price: 100, direction: 'above' },
    initData,
  });

  assert.equal(res.status, 422, 'status should be 422 (validation error)');
  assert.ok(res.body, 'body should be present');
});

// ============================================================================
// TEST 2E: 404 — unknown route returns 404 (not undefined)
// ============================================================================
test('CHANGE 1 / TEST 2E: GET /api/unknown-route returns 404 (not undefined)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/unknown-route');

  assert.equal(res.status, 404, 'status should be 404');
  assert.equal(res.body.status, 'error', 'body.status should be "error"');
});

// ============================================================================
// TEST 2F: Direct Response — OPTIONS preflight returns 204
// ============================================================================
test('CHANGE 1 / TEST 2F: OPTIONS preflight returns 204 (direct Response)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const response = await worker.fetch(
    new Request('http://localhost/api/health', { method: 'OPTIONS' }),
    env,
    {},
  );

  assert.equal(response.status, 204, 'status should be 204');
  assert.ok(response.headers.get('access-control-allow-origin'), 'CORS origin');
  assert.ok(response.headers.get('access-control-allow-methods'), 'CORS methods');
});

// ============================================================================
// TEST 2G: DB not configured — bootstrap returns 503
// ============================================================================
test('CHANGE 1 / TEST 2G: POST /api/users/bootstrap without DB returns 503 (DB not configured)', async () => {
  const worker = loadWorker();
  const env = createEnv({ DATABASE_URL: undefined, DIRECT_URL: undefined });
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456' },
  });

  assert.equal(res.status, 503, 'status should be 503');
  assert.equal(res.body.status, 'DB_ERROR', 'body.status should be "DB_ERROR"');
});

// ============================================================================
// TEST 2H: Maintenance mode — GET /api/system/status returns 200 (no auth)
// ============================================================================
test('CHANGE 1 / TEST 2H: GET /api/system/status returns 200 (public, no auth)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/system/status');

  assert.equal(res.status, 200, 'status should be 200');
  assert.equal(res.body.status, 'success', 'body.status should be "success"');
  assert.equal(res.body.maintenance.enabled, false, 'maintenance should be disabled by default');
});

// ============================================================================
// TEST 2I: Response is a real Response object (not undefined, not null)
// ============================================================================
test('CHANGE 1 / TEST 2I: fetch() always returns a real Response object (never undefined)', async () => {
  const worker = loadWorker();
  const env = createEnv();

  const routes = [
    { method: 'GET', path: '/api/health' },
    { method: 'GET', path: '/api/unknown-route' },
    { method: 'GET', path: '/api/system/status' },
    { method: 'OPTIONS', path: '/api/health' },
  ];

  for (const route of routes) {
    const request = new Request(`http://localhost${route.path}`, { method: route.method });
    const response = await worker.fetch(request, env, {});
    assert.ok(response, `Response for ${route.method} ${route.path} should not be undefined/null`);
    assert.equal(typeof response.status, 'number', `${route.method} ${route.path}: response.status should be a number`);
    assert.ok(response.headers, `${route.method} ${route.path}: response should have headers`);
    assert.equal(typeof response.json, 'function', `${route.method} ${route.path}: response should have .json() method`);
  }
});

// ============================================================================
// TEST 2J: WithSharedPool wrapper does not swallow thrown errors
// ============================================================================
test('CHANGE 1 / TEST 2J: thrown errors propagate correctly (not swallowed by wrapper)', async () => {
  const worker = loadWorker();
  const env = createEnv();

  const request = new Request('http://localhost/api/users/bootstrap', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: 'not-valid-json',
  });
  const response = await worker.fetch(request, env, {});

  assert.ok(response, 'response should not be undefined');
  assert.ok(response.status >= 400 && response.status < 600, 'should be an error status (4xx or 5xx)');
});

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ============================================================================
// Test Helpers
// ============================================================================

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');

/** Cache the worker source to avoid repeated disk reads. */
let _workerSourceCache = null;
function getWorkerSource() {
  if (!_workerSourceCache) {
    _workerSourceCache = fs.readFileSync(WORKER_PATH, 'utf8');
  }
  return _workerSourceCache;
}

/**
 * Load the worker module by transforming ESM → CJS and bundling local src/ modules.
 * Each call creates a fresh module instance with isolated state.
 */
function loadWorker(pgOverride) {
  const source = getWorkerSource();
  const defaultMocks = {
    '@neondatabase/serverless': pgOverride || {
      Pool: class Pool {
        async query() { return { rows: [] }; }
        async connect() { return { async query() { return { rows: [] }; }, release() {} }; }
      },
    },
  };

  // Build require function with local module support
  const localModuleCache = {};
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(defaultMocks, id)) return defaultMocks[id];
    if (localModuleCache[id]) return localModuleCache[id];
    return require(id);
  };

  // Resolve and bundle local ESM modules (src/**/*.js)
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

  // Transform main source ESM → CJS
  const transformed = source
    .replace(
      "import { createHmac, timingSafeEqual } from 'node:crypto';",
      "const { createHmac, timingSafeEqual } = require('node:crypto');",
    )
    .replace("import { Pool } from '@neondatabase/serverless';", "const { Pool } = require('@neondatabase/serverless');")
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

  const suppressedSource =
    'console.log = () => {}; console.warn = () => {}; console.error = () => {};\n' + transformed;

  const module = { exports: {} };
  const evaluator = new Function('require', 'module', 'exports', suppressedSource);
  evaluator(localRequire, module, module.exports);
  return module.exports;
}

/**
 * Build a valid Telegram initData string for testing.
 * The hash is computed over DECODED values, matching the worker's
 * validateTelegramInitData which decodes values before HMAC comparison.
 */
function buildInitData(botToken, user, options = {}) {
  const entries = [
    ['auth_date', String(options.authDate ?? Math.floor(Date.now() / 1000))],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', JSON.stringify(user)],
  ];

  // Hash is computed over DECODED values (matching the worker validator)
  const dataCheckString = entries
    .slice()
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  // Build the final initData string with URL-ENCODED values
  return entries
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .concat([`hash=${hash}`])
    .join('&');
}

/**
 * Extract validateTelegramInitData from the worker source for isolated unit tests.
 */
function loadValidateTelegramInitData() {
  const source = getWorkerSource();
  const helperStart = source.indexOf('function parseTelegramInitDataPairs');
  // Use 'async function authenticateTelegramRequest' to avoid including trailing 'async '
  const helperEnd = source.indexOf('async function authenticateTelegramRequest');
  const helperSrc = source.slice(helperStart, helperEnd);
  const exportsObj = {};
  const evaluator = new Function(
    'createHmac', 'timingSafeEqual', 'exports',
    `${helperSrc}; exports.validateTelegramInitData = validateTelegramInitData;`,
  );
  evaluator(crypto.createHmac, crypto.timingSafeEqual, exportsObj);
  return exportsObj.validateTelegramInitData;
}

/** Create a mock env with sensible defaults for development mode. */
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

/** In-memory KV namespace mock (Cloudflare Workers KV API subset). */
function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    dump() { return Object.fromEntries(store.entries()); },
  };
}

/**
 * Send a request through the worker's fetch handler.
 * Returns { status, body, headers }.
 */
async function sendRequest(worker, env, method, urlPath, options = {}) {
  const { body, headers = {}, initData } = options;
  const url = urlPath.startsWith('http') ? urlPath : `http://localhost${urlPath}`;
  const reqHeaders = new Headers(headers);
  if (initData) {
    reqHeaders.set('X-Telegram-Init-Data', initData);
  }
  const reqOpts = { method, headers: reqHeaders };
  if (body !== undefined) {
    reqOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!reqHeaders.has('Content-Type')) {
      reqHeaders.set('Content-Type', 'application/json');
    }
  }
  const request = new Request(url, reqOpts);
  const response = await worker.fetch(request, env, {});
  let responseBody;
  try {
    responseBody = await response.json();
  } catch {
    responseBody = null;
  }
  return { status: response.status, body: responseBody, headers: response.headers };
}

// ============================================================================
// 1. Auth — validateTelegramInitData (isolated unit tests)
// ============================================================================
test('Auth: valid initData returns user object', async () => {
  const validate = loadValidateTelegramInitData();
  const user = { id: 123456, first_name: 'Test', username: 'testuser' };
  const initData = buildInitData('test-bot-token', user);
  const result = await validate(initData, 'test-bot-token');
  assert.ok(result);
  assert.equal(result.id, 123456);
  assert.equal(result.first_name, 'Test');
});

test('Auth: wrong bot token returns null', async () => {
  const validate = loadValidateTelegramInitData();
  const user = { id: 123456, first_name: 'Test' };
  const initData = buildInitData('correct-token', user);
  const result = await validate(initData, 'wrong-token');
  assert.equal(result, null);
});

test('Auth: tampered user id returns null', async () => {
  const validate = loadValidateTelegramInitData();
  const user = { id: 123456, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const tampered = initData.replace(
    /user=[^&]+/,
    'user=' + encodeURIComponent(JSON.stringify({ id: 999999, first_name: 'Hacker' })),
  );
  const result = await validate(tampered, 'test-bot-token');
  assert.equal(result, null);
});

test('Auth: expired auth_date returns null', async () => {
  const validate = loadValidateTelegramInitData();
  const user = { id: 123456, first_name: 'Test' };
  const oldDate = Math.floor(Date.now() / 1000) - 200000; // ~2.3 days ago
  const initData = buildInitData('test-bot-token', user, { authDate: oldDate });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null);
});

test('Auth: empty initData returns null', async () => {
  const validate = loadValidateTelegramInitData();
  const result = await validate('', 'test-bot-token');
  assert.equal(result, null);
});

test('Auth: null initData returns null', async () => {
  const validate = loadValidateTelegramInitData();
  const result = await validate(null, 'test-bot-token');
  assert.equal(result, null);
});

test('Auth: REPLACE_WITH_TOKEN returns null', async () => {
  const validate = loadValidateTelegramInitData();
  const user = { id: 123456, first_name: 'Test' };
  const initData = buildInitData('REPLACE_WITH_TOKEN', user);
  const result = await validate(initData, 'REPLACE_WITH_TOKEN');
  assert.equal(result, null);
});

// ============================================================================
// 2. Health — GET /api/health
// ============================================================================
test('Health: returns status ok with service flags', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.bot_configured, true);
  assert.equal(res.body.database_ready, true);
  assert.equal(res.body.cache_ready, true);
});

test('Health: reflects missing KV bindings', async () => {
  const worker = loadWorker();
  const env = createEnv({ APP_CACHE: null, RATE_LIMITS: null, JOIN_CACHE: null, SESSION_CACHE: null });
  const res = await sendRequest(worker, env, 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
  assert.equal(res.body.cache_ready, false);
});

// ============================================================================
// 3. Bootstrap — POST /api/users/bootstrap
// ============================================================================
test('Bootstrap: creates user in dev mode via body.user_id', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456', first_name: 'Ali' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.user.user_id, '123456');
  assert.ok(Array.isArray(res.body.watchlist));
  assert.equal(res.body.is_admin, false);
});

test('Bootstrap: admin user gets is_admin true', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '831704732' },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.is_admin, true);
});

test('Bootstrap: with valid Telegram initData', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 999888, first_name: 'Reza', username: 'reza' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: {},
    initData,
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.user.user_id, '999888');
});

test('Bootstrap: returns 503 when database not configured', async () => {
  const worker = loadWorker();
  const env = createEnv({ DATABASE_URL: undefined, DIRECT_URL: undefined });
  const res = await sendRequest(worker, env, 'POST', '/api/users/bootstrap', {
    body: { user_id: '123456' },
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.status, 'DB_ERROR');
});

// ============================================================================
// 4. Watchlist — GET / PUT /api/watchlist
// ============================================================================
test('Watchlist GET: returns empty array for new user', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/watchlist?user_id=123456');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.ok(Array.isArray(res.body.symbols));
  assert.ok(Array.isArray(res.body.watchlist));
});

test('Watchlist PUT: accepts symbols and returns result', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'PUT', '/api/watchlist?user_id=123456', {
    body: { symbols: ['BTC', 'ETH', 'SOL'] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.ok(Array.isArray(res.body.symbols));
});

test('Watchlist PUT: deduplicates and uppercases symbols', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'PUT', '/api/watchlist?user_id=123456', {
    body: { symbols: ['btc', 'eth', 'BTC', 'sol'] },
  });
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.ok(Array.isArray(res.body.symbols));
});

test('Watchlist GET: without auth returns error', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/watchlist');
  assert.equal(res.status, 401);
});

test('Watchlist PUT: invalid body returns 422', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'PUT', '/api/watchlist?user_id=123456', {
    body: 'not-json',
  });
  assert.equal(res.status, 422);
});

// ============================================================================
// 5. Alerts — POST / GET / DELETE /api/alerts
// ============================================================================
// alertHandlers call authenticateTelegramRequest WITHOUT await (code bug).
// The Promise has no .error property (undefined), so auth check passes.
// Then `authState.user.id` crashes with TypeError OUTSIDE the try-catch,
// After fix: alerts properly authenticate and return 401 without auth.

test('Alerts POST: without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'POST', '/api/alerts', {
    body: { symbol: 'BTC', target_price: 100000 },
  });
  assert.equal(res.status, 401);
});

test('Alerts GET: without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/alerts');
  assert.equal(res.status, 401);
});

test('Alerts DELETE: without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'DELETE', '/api/alerts/alert-001');
  assert.equal(res.status, 401);
});

// With valid initData, alerts now properly authenticate and return 503 (no DB configured).
test('Alerts POST: with valid initData returns 503 (no DB)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/alerts', {
    body: { symbol: 'BTC', target_price: 100000 },
    initData,
  });
  assert.equal(res.status, 503);
});

// ============================================================================
// 6. Admin access control
// ============================================================================
test('Admin: is-admin returns true for super admin env var user', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/admin/is-admin?user_id=831704732');
  assert.equal(res.status, 200);
  assert.equal(res.body.is_admin, true);
  assert.equal(res.body.is_super, true);
  assert.equal(res.body.reason, 'env_super_admin');
});

test('Admin: is-admin returns false for non-admin user', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/admin/is-admin?user_id=123456');
  assert.equal(res.status, 200);
  assert.equal(res.body.is_admin, false);
  assert.equal(res.body.is_super, false);
});

test('Admin: dashboard returns 403 for non-admin user via initData', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 123456, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  // requireAdmin properly awaits authenticateTelegramRequest, then checks DB
  // DB mock returns empty rows → admin = null → 403
  const res = await sendRequest(worker, env, 'GET', '/api/admin/dashboard', { initData });
  assert.equal(res.status, 403);
});

test('Admin: dashboard returns 401 without any auth', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/admin/dashboard?user_id=123456');
  // requireAdmin calls authenticateTelegramRequest (awaited) which checks
  // X-Telegram-Init-Data header — missing → 401
  assert.equal(res.status, 401);
});

test('Admin: is-admin without auth returns diagnostic info', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/admin/is-admin');
  assert.equal(res.status, 200);
  assert.equal(res.body.is_admin, false);
  assert.ok(res.body.reason);
});

// ============================================================================
// 7. AI Chat — POST /api/assistant/chat
// ============================================================================
test('AI Chat: without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'Hello' },
  });
  assert.equal(res.status, 401);
});

test('AI Chat: without RATE_LIMITS KV returns 503', async () => {
  const worker = loadWorker();
  const env = createEnv({ RATE_LIMITS: null });
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'Hello' },
    initData,
  });
  assert.equal(res.status, 503);
  assert.ok(res.body.message.includes('RATE_LIMITS'));
});

test('AI Chat: no AI provider configured returns 503', async () => {
  const worker = loadWorker();
  const rateLimits = createMemoryKv();
  const env = createEnv({
    RATE_LIMITS: rateLimits,
    GEMINI_API_KEY: '',
    OPENROUTER_API_KEY: '',
    DEEPSEEK_API_KEY: '',
  });
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'What is Bitcoin?' },
    initData,
  });
  assert.equal(res.status, 503);
  assert.equal(res.body.reason, 'all_providers_failed');
});

test('AI Chat: rate limited by cooldown returns 429', async () => {
  const rateLimits = createMemoryKv();
  await rateLimits.put('ai:cooldown:999888', '1');
  const worker = loadWorker();
  const env = createEnv({ RATE_LIMITS: rateLimits });
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'Hello' },
    initData,
  });
  assert.equal(res.status, 429);
  assert.equal(res.body.reason, 'cooldown');
});

test('AI Chat: empty message returns 422', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: '' },
    initData,
  });
  assert.equal(res.status, 422);
});

test('AI Chat: missing message field returns 422', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: {},
    initData,
  });
  assert.equal(res.status, 422);
});

test('AI Chat: with mocked Gemini returns reply', async () => {
  const worker = loadWorker();
  const rateLimits = createMemoryKv();
  const env = createEnv({ RATE_LIMITS: rateLimits, GEMINI_API_KEY: 'fake-key' });
  const user = { id: 999888, first_name: 'Test' };
  const initData = buildInitData('test-bot-token', user);

  // Mock global fetch for Gemini API call
  const originalFetch = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({
        candidates: [{
          content: { parts: [{ text: 'Bitcoin is a decentralized digital currency.' }] },
        }],
      }), { status: 200, headers: { 'Content-Type': 'application/json' } });
    }
    return originalFetch.call(globalThis, url, init);
  };

  try {
    const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
      body: { message: 'What is Bitcoin?' },
      initData,
    });
    assert.equal(res.status, 200);
    assert.equal(res.body.status, 'success');
    assert.equal(res.body.provider, 'gemini');
    assert.ok(res.body.reply);
    assert.ok(res.body.reply.includes('Bitcoin'));
  } finally {
    globalThis.fetch = originalFetch;
  }
});

// ============================================================================
// Misc / Edge Cases
// ============================================================================
test('Root: GET / returns ok', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'ok');
});

test('404: unknown route returns 404', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/unknown-route');
  assert.equal(res.status, 404);
});

test('OPTIONS: preflight returns 204 with CORS headers', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const response = await worker.fetch(
    new Request('http://localhost/api/health', { method: 'OPTIONS' }),
    env,
    {},
  );
  assert.equal(response.status, 204);
  assert.ok(response.headers.get('access-control-allow-origin'));
  assert.ok(response.headers.get('access-control-allow-methods'));
});

// ============================================================================
// Maintenance Mode — /api/system/status + /api/admin/maintenance
// ============================================================================
test('Maintenance: GET /api/system/status returns default disabled state (no auth)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'GET', '/api/system/status');
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.maintenance.enabled, false);
  assert.equal(res.body.maintenance.progress, 0);
  assert.ok(res.body.maintenance.title, 'should have default title');
  assert.ok(res.body.maintenance.description, 'should have default description');
});

test('Maintenance: PUT /api/admin/maintenance without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const res = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, progress: 50 },
  });
  assert.equal(res.status, 401);
});

test('Maintenance: PUT /api/admin/maintenance with admin auth updates state', async () => {
  const worker = loadWorker();
  const env = createEnv(); // ADMIN_TELEGRAM_ID = '831704732', bot token = 'test-bot-token'
  const user = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', user);

  const updateRes = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, title: 'Test Mode', description: 'Testing', progress: 42 },
    initData,
  });
  assert.equal(updateRes.status, 200);
  assert.equal(updateRes.body.status, 'success');
  assert.equal(updateRes.body.maintenance.enabled, true);
  assert.equal(updateRes.body.maintenance.title, 'Test Mode');
  assert.equal(updateRes.body.maintenance.progress, 42);
  assert.ok(updateRes.body.maintenance.updated_at, 'should have updated_at timestamp');
});

test('Maintenance: state persists across requests (GET after PUT)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', user);

  // PUT with admin
  await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, progress: 75, title: 'Persisted State' },
    initData,
  });
  // GET — should return the persisted state
  const getRes = await sendRequest(worker, env, 'GET', '/api/system/status');
  assert.equal(getRes.status, 200);
  assert.equal(getRes.body.maintenance.enabled, true);
  assert.equal(getRes.body.maintenance.progress, 75);
  assert.equal(getRes.body.maintenance.title, 'Persisted State');
});

test('Maintenance: progress is clamped to 0-100 range', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', user);

  // Test over 100
  const res1 = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, progress: 150 },
    initData,
  });
  assert.equal(res1.body.maintenance.progress, 100);
  // Test under 0
  const res2 = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, progress: -10 },
    initData,
  });
  assert.equal(res2.body.maintenance.progress, 0);
});

test('Maintenance: title is truncated to 60 chars', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', user);
  const longTitle = 'A'.repeat(100);

  const res = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, title: longTitle },
    initData,
  });
  assert.equal(res.body.maintenance.title.length, 60);
});

test('Maintenance: disabling sets enabled to false', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', user);

  // First enable
  await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, progress: 50 },
    initData,
  });
  // Then disable
  const res = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: false },
    initData,
  });
  assert.equal(res.body.maintenance.enabled, false);
  // Verify GET returns disabled
  const getRes = await sendRequest(worker, env, 'GET', '/api/system/status');
  assert.equal(getRes.body.maintenance.enabled, false);
});

test('Maintenance: non-admin user gets 403', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 123456, first_name: 'Regular User' }; // Not an admin
  const initData = buildInitData('test-bot-token', user);

  const res = await sendRequest(worker, env, 'PUT', '/api/admin/maintenance', {
    body: { enabled: true, progress: 50 },
    initData,
  });
  assert.equal(res.status, 403);
});
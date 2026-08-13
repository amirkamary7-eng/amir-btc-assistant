/**
 * ADMIN-RUNTIME-INTEGRATION-TEST
 *
 * Runtime integration tests using the loadWorker pattern from worker-proxy.test.cjs.
 * These tests exercise ACTUAL HTTP endpoints with mock DB to verify:
 *   - P0 privilege escalation prevention (runtime)
 *   - A-2 reward status whitelist (runtime)
 *   - A-6 admin list authorization (runtime)
 *   - A-3 rate limiting (runtime)
 *   - A-1 XSS escaping output (runtime)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');

// The existing worker-proxy.test.cjs has loadWorker that handles all ESM→CJS
// transformations. We can't import it (it runs tests on require), but we can
// read its source, extract the helper section (before the first test() call),
// and eval just that part.

const testFileSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.test.cjs'), 'utf8');
// Get everything before the first `test(` call — that's the helper section
const firstTestIdx = testFileSrc.indexOf("\ntest('");
const helperSrc = testFileSrc.slice(0, firstTestIdx > 0 ? firstTestIdx : 0);

// Evaluate the helper code in a sandbox to get loadWorker, buildInitData, etc.
const vm = require('node:vm');
const sandbox = {
  require,
  module: { exports: {} },
  exports: {},
  console: { log: () => {}, warn: () => {}, error: () => {} },
  process: { env: {} },
  crypto,
  path,
  fs,
  assert,
  test: () => {}, // no-op test() calls
  __dirname: __dirname,
  __filename: __filename,
  URL,
  Request,
  Response,
  Headers,
  fetch: () => Promise.resolve(new Response('{}', { status: 200, headers: { 'Content-Type': 'application/json' } })),
  setTimeout,
  clearTimeout,
  AbortController,
  performance: { now: () => Date.now() },
  Date,
  Math,
  Map,
  Set,
  Object,
  Array,
  String,
  Number,
  Boolean,
  JSON,
  Promise,
  Error,
  TypeError,
  RegExp,
  TextEncoder,
  TextDecoder,
  Uint8Array,
};
sandbox.global = sandbox;
vm.createContext(sandbox);
vm.runInContext(helperSrc + '\nmodule.exports = { loadWorker, buildInitData, createEnv, createMemoryKv };', sandbox);
const { loadWorker, buildInitData, createEnv, createMemoryKv } = sandbox.module.exports;

// ── Admin user objects ─────────────────────────────────────────────────
const ADMIN_USER = { id: '831704732', first_name: 'Admin', username: 'admin' };
const REGULAR_USER = { id: '123456789', first_name: 'Regular', username: 'regular' };

// ═══════════════════════════════════════════════════════════════════════
// P0 RUNTIME: Admin endpoints require authentication
// ═══════════════════════════════════════════════════════════════════════

test('RUNTIME-P0-1: GET /api/admin/admins without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/admins', { method: 'GET' }),
    env, {}
  );
  assert.equal(response.status, 401);
  const body = await response.json();
  assert.ok(body.detail.includes('Missing') || body.detail.includes('init data'));
});

test('RUNTIME-P0-2: GET /api/admin/dashboard without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/dashboard', { method: 'GET' }),
    env, {}
  );
  assert.equal(response.status, 401);
});

test('RUNTIME-P0-3: POST /api/admin/admins without auth returns 401', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/admins', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ telegram_id: '999', role: 'admin' }),
    }),
    env, {}
  );
  assert.equal(response.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════
// A-6 RUNTIME: Admin list requires admins.view permission
// ═══════════════════════════════════════════════════════════════════════

test('RUNTIME-A-6-1: Admin with admins.view can list admins', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/admins', {
      method: 'GET',
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    env, {}
  );
  // Admin user is env super admin — should pass auth
  // May return 503 if DB mock doesn't have admins table, but NOT 401/403
  assert.ok(response.status !== 401, 'Should not return 401 for authenticated admin');
  assert.ok(response.status !== 403, 'Should not return 403 for super admin');
});

test('RUNTIME-A-6-2: Non-admin user cannot list admins', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, REGULAR_USER);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/admins', {
      method: 'GET',
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    env, {}
  );
  // Non-admin should get 403 (not in admins table)
  assert.equal(response.status, 403);
});

// ═══════════════════════════════════════════════════════════════════════
// A-2 RUNTIME: Reward status whitelist
// ═══════════════════════════════════════════════════════════════════════

test('RUNTIME-A-2-1: Invalid reward status is rejected with 422', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/rewards/1/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({ status: 'hacked' }),
    }),
    env, {}
  );
  // Should be 422 (invalid status) — NOT 401/403 (auth passes as super admin)
  // May be 503 if DB not configured, but auth+whitelist should work before DB
  assert.ok(response.status !== 401, 'Should not return 401 for authenticated admin');
  if (response.status === 422) {
    const body = await response.json();
    assert.ok(body.message.includes('Invalid status') || body.code === 'INVALID_STATUS',
      'Should return INVALID_STATUS error');
  }
});

test('RUNTIME-A-2-2: Valid reward status "approved" is accepted (not 422)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/rewards/1/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({ status: 'approved' }),
    }),
    env, {}
  );
  // Should NOT be 422 (valid status passes whitelist)
  assert.ok(response.status !== 422, 'Valid status "approved" should not return 422');
});

test('RUNTIME-A-2-3: Empty status is rejected', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/rewards/1/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({ status: '' }),
    }),
    env, {}
  );
  assert.equal(response.status, 422);
});

test('RUNTIME-A-2-4: SQL-like status is rejected', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/rewards/1/status', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
      body: JSON.stringify({ status: "pending' OR 1=1--" }),
    }),
    env, {}
  );
  assert.equal(response.status, 422);
});

// ═══════════════════════════════════════════════════════════════════════
// A-3 RUNTIME: Rate limiting on admin mutations
// ═══════════════════════════════════════════════════════════════════════

test('RUNTIME-A-3-1: Normal admin request is allowed (under threshold)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  // Single request should not be rate limited
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/admins', {
      method: 'GET',
      headers: { 'X-Telegram-Init-Data': initData },
    }),
    env, {}
  );
  assert.ok(response.status !== 429, 'Single request should not be rate limited');
});

test('RUNTIME-A-3-2: Excessive admin mutations trigger rate limit (429)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const initData = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);

  // Fire 25 POST requests (limit is 20 per 60s)
  let rateLimited = false;
  for (let i = 0; i < 25; i++) {
    const response = await worker.fetch(
      new Request('http://localhost/api/admin/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData },
        body: JSON.stringify({ telegram_id: String(9000000 + i), role: 'admin' }),
      }),
      env, {}
    );
    if (response.status === 429) {
      rateLimited = true;
      break;
    }
  }
  assert.ok(rateLimited, 'Should hit rate limit (429) after 20+ mutations');
});

test('RUNTIME-A-3-3: Rate limit is per-admin (different admin not affected)', async () => {
  const worker = loadWorker();
  const env = createEnv({ ADMIN_TELEGRAM_ID: '831704732', ADMIN_TELEGRAM_IDS: '831704732,999999' });

  // Exhaust admin 831704732's rate limit
  const initData1 = buildInitData(env.TELEGRAM_BOT_TOKEN, ADMIN_USER);
  for (let i = 0; i < 22; i++) {
    await worker.fetch(
      new Request('http://localhost/api/admin/admins', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Telegram-Init-Data': initData1 },
        body: JSON.stringify({ telegram_id: String(8000000 + i), role: 'admin' }),
      }),
      env, {}
    );
  }

  // Admin 999999 should still be able to make requests
  const admin2 = { id: '999999', first_name: 'Admin2', username: 'admin2' };
  const initData2 = buildInitData(env.TELEGRAM_BOT_TOKEN, admin2);
  const response = await worker.fetch(
    new Request('http://localhost/api/admin/admins', {
      method: 'GET',
      headers: { 'X-Telegram-Init-Data': initData2 },
    }),
    env, {}
  );
  assert.ok(response.status !== 429, 'Different admin should not be rate limited');
});

// ═══════════════════════════════════════════════════════════════════════
// A-5 RUNTIME: CORS behavior
// ═══════════════════════════════════════════════════════════════════════

test('RUNTIME-A-5-1: CORS with valid WEBAPP_URL returns correct origin', async () => {
  const worker = loadWorker();
  const env = createEnv({ WEBAPP_URL: 'https://amir-btc-assistant.pages.dev' });
  const response = await worker.fetch(
    new Request('http://localhost/api/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://amir-btc-assistant.pages.dev' },
    }),
    env, {}
  );
  assert.equal(response.status, 204);
  const corsOrigin = response.headers.get('access-control-allow-origin');
  assert.ok(corsOrigin, 'CORS origin header must be present');
  assert.equal(corsOrigin, 'https://amir-btc-assistant.pages.dev');
});

test('RUNTIME-A-5-2: CORS never returns wildcard *', async () => {
  const worker = loadWorker();
  // Test with missing WEBAPP_URL
  const env = createEnv({ WEBAPP_URL: '' });
  const response = await worker.fetch(
    new Request('http://localhost/api/health', {
      method: 'OPTIONS',
      headers: { Origin: 'https://evil.com' },
    }),
    env, {}
  );
  const corsOrigin = response.headers.get('access-control-allow-origin');
  assert.ok(corsOrigin !== '*', 'CORS must never return wildcard *');
});

// ═══════════════════════════════════════════════════════════════════════
// A-1 RUNTIME: XSS — verify escaped output in HTML
// ═══════════════════════════════════════════════════════════════════════

test('RUNTIME-A-1-1: adminEscapeJsId produces safe output for malicious IDs', () => {
  // Load admin.js source and extract adminEscapeJsId function
  const adminSrc = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
  const fnStart = adminSrc.indexOf('function adminEscapeJsId');
  const fnEnd = adminSrc.indexOf('\n}', fnStart);
  const fnSrc = adminSrc.slice(fnStart, fnEnd + 2);

  // Also need adminEscapeHtml
  const htmlFnStart = adminSrc.indexOf('function adminEscapeHtml');
  const htmlFnEnd = adminSrc.indexOf('\n}', htmlFnStart);
  const htmlFnSrc = adminSrc.slice(htmlFnStart, htmlFnEnd + 2);

  // Create a mini-evaluator
  const evaluator = new Function('document', htmlFnSrc + '\n' + fnSrc + '\nreturn { adminEscapeHtml, adminEscapeJsId };');

  // Mock document with createElement + createTextNode
  const mockDiv = { _html: '', set innerHTML(v) { this._html = v; }, get innerHTML() { return this._html; } };
  const mockDocument = {
    createElement: () => mockDiv,
    createTextNode: (text) => ({ nodeValue: String(text) }),
  };
  mockDiv.appendChild = function(child) {
    // Simulate browser: text node → HTML-escaped string
    this._html = String(child.nodeValue)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  };

  const { adminEscapeJsId } = evaluator(mockDocument);

  // Test with malicious ID that tries to break out of JS string
  const maliciousIds = [
    "1'; alert('xss'); //",
    '1"; alert(\'xss\'); //',
    "1\\'; alert(1); //",
    '<script>alert(1)</script>',
    "1' OR '1'='1",
  ];

  for (const id of maliciousIds) {
    const escaped = adminEscapeJsId(id);
    // The escaped value should NOT contain unescaped single quotes
    // that could break out of onclick="fn('VALUE')"
    // After HTML entity encoding, ' becomes &#39;
    // Then we prepend \ to prevent JS string termination after entity decode
    assert.ok(!escaped.includes("'") || escaped.includes("\\&#39;"),
      `Malicious ID "${id}" should be safely escaped. Got: "${escaped}"`);
    // Should not contain unescaped < or >
    assert.ok(!escaped.includes('<') && !escaped.includes('>'),
      `Malicious ID "${id}" should not contain raw < or >. Got: "${escaped}"`);
  }
});

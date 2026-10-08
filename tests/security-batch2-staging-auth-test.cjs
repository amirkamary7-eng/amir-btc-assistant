/**
 * Security Batch 2 — Staging / Auth Hardening Regression Tests
 * ------------------------------------------------------------
 * AP-1: _DATA_PATHS + PROTECTED_PATHS gates moved from prod-only to
 *       !isDevMode(env) — staging now gated like production; unknown/unset
 *       APP_ENV FAILS CLOSED.
 * AP-2: /api/start-diag + /api/notif-diag-report gates moved from prod-only
 *       to !isDevMode(env) — unauthenticated GET (webhook info) and POST
 *       (setWebhook / arbitrary JSON DB write) are no longer staging-exposed.
 * AP-3: trigger-alerts shared-secret comparison switched from === to the
 *       canonical timingSafeEqualSecret() helper (no length leak; Method 2
 *       Telegram admin auth preserved).
 *
 * Behavioral tests drive the REAL worker fetch handler (loadWorker harness)
 * with a stubbed global fetch so no real network access happens.
 *
 * Run: node --test tests/security-batch2-staging-auth-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');

// ── loadWorker harness (same ESM→CJS transform as the chat-ai-quota suite) ──
function loadWorker(pgOverride) {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');
  const defaultMocks = {
    'pg': { Pool: class { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } } },
    '@neondatabase/serverless': pgOverride || {
      Pool: class Pool { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } },
      neon: function () { const f = async () => []; f.query = async () => ({ rows: [] }); f.transaction = async (cb) => cb({ query: f.query }); return f; },
    },
  };
  const lmc = {}; const lr = (id) => { if (defaultMocks[id]) return defaultMocks[id]; if (lmc[id]) return lmc[id]; return require(id); };
  const lire = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g; let m;
  while ((m = lire.exec(source)) !== null) { const ip = m[4]; if (lmc[ip]) continue; const rp = path.resolve(path.dirname(WORKER_PATH), ip); let ms = fs.readFileSync(rp, 'utf8'); ms = ms.replace(/import\s+\{([^}]*)\}\s+from\s+['"]node:([^'"]+)['"];?/g, (_, named, mod) => `const { ${named} } = require('node:${mod}');`).replace(/export\s+(?:async\s+)?function\s+(\w+)/g, 'module.exports.$1 = function $1').replace(/export\s+default\s+/g, 'module.exports.default = ').replace(/export\s+const\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+let\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+var\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+\{\s*(\w+)\s*\};?/g, 'module.exports.$1 = $1;'); const mod = { exports: {} }; new Function('require', 'module', 'exports', ms)(lr, mod, mod.exports); lmc[ip] = mod.exports; }
  const t = source.replace("import { createHmac, timingSafeEqual } from 'node:crypto';", "const { createHmac, timingSafeEqual } = require('node:crypto');").replace(/import\s+\{([^}]*)\}\s+from\s+['"]node:([^'"]+)['"];?/g, (_, named, mod) => `const { ${named} } = require('node:${mod}');`).replace("import { Pool as NeonPool, neon } from '@neondatabase/serverless';", "const { Pool: NeonPool, neon } = require('@neondatabase/serverless');").replace("import { Pool as PgPool } from 'pg';", "const { Pool: PgPool } = require('pg');").replace(/import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const { ${n} } = require('${p}');`).replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace(/import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace('export default {', 'module.exports = {').replace(/export\s+\{\s*(\w+)\s*\};?/g, 'module.exports.$1 = $1;');
  const mod = { exports: {} }; new Function('require', 'module', 'exports', t)(lr, mod, mod.exports); return mod.exports;
}

function createMemoryKv(i = {}) { const s = new Map(Object.entries(i)); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v, o) { s.set(k, v); }, async delete(k) { s.delete(k); }, dump() { return Object.fromEntries(s.entries()); } }; }
function buildInitData(b, u) { const e = [['auth_date', String(Math.floor(Date.now() / 1000))], ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'], ['user', JSON.stringify(u)]]; const d = e.slice().sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => `${k}=${v}`).join('\n'); const sk = crypto.createHmac('sha256', 'WebAppData').update(b).digest(); const h = crypto.createHmac('sha256', sk).update(d).digest('hex'); return e.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).concat([`hash=${h}`]).join('&'); }

function createEnv(o = {}) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: '',
    APP_ENV: 'development',
    BOT_USERNAME: '',
    APP_CACHE: createMemoryKv({ 'market:data:v3': JSON.stringify([{ symbol: 'BTC', priceUsd: 97000, changePercent24Hr: -1.5 }]) }),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
  }, o);
}

async function sendRequest(w, e, m, p, o = {}) {
  const u = p.startsWith('http') ? p : `http://localhost${p}`;
  const h = new Headers(o.headers || {});
  if (o.initData) h.set('X-Telegram-Init-Data', o.initData);
  const r = { method: m, headers: h };
  if (o.body !== undefined) { r.body = JSON.stringify(o.body); h.set('Content-Type', 'application/json'); h.set('Content-Length', String(Buffer.byteLength(r.body))); }
  const res = await w.fetch(new Request(u, r), e, {});
  let b; try { b = await res.json(); } catch { b = null; }
  return { status: res.status, body: b };
}

// Stub global fetch for the whole file — behavioral tests must not hit the network.
const realFetch = globalThis.fetch;
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });

const ADMIN_USER = { id: 831704732, first_name: 'Admin', username: 'admin', lang_code: 'fa' };
function adminInitData() { return buildInitData('test-bot-token', ADMIN_USER); }

// ═══════════════════════════════════════════════════════════════════════════
// A. AP-1 — _DATA_PATHS behavioral (real fetch handler)
// ═══════════════════════════════════════════════════════════════════════════

test('B2-AP1-01: staging + GET /api/forex → 401 (staging bypass closed)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'GET', '/api/forex');
  assert.equal(res.status, 401, `expected 401 from gate, got ${res.status}`);
});

test('B2-AP1-02: production + GET /api/forex → 401 (unchanged behavior)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production' }), 'GET', '/api/forex');
  assert.equal(res.status, 401);
});

test('B2-AP1-03: development + GET /api/forex → NOT 401/403 (dev bypass preserved)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'development' }), 'GET', '/api/forex');
  assert.notEqual(res.status, 401, 'gate must be inactive in development');
  assert.notEqual(res.status, 403, 'join gate must be inactive in development');
});

test('B2-AP1-04: APP_ENV unset + GET /api/forex → 401 (fail-closed)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: undefined }), 'GET', '/api/forex');
  assert.equal(res.status, 401, 'unknown APP_ENV must NOT bypass auth');
});

test('B2-AP1-05: staging + authorized admin initData → passes the _DATA_PATHS gate', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'GET', '/api/forex', { initData: adminInitData() });
  assert.notEqual(res.status, 401, 'valid initData must pass the gate on staging');
  assert.notEqual(res.status, 403, 'admin must bypass the channel-join requirement');
});

test('B2-AP1-06: staging + GET /api/analyses → 401 (list endpoint gated)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'GET', '/api/analyses');
  assert.equal(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
// B. AP-1 — PROTECTED_PATHS behavioral (real fetch handler)
// ═══════════════════════════════════════════════════════════════════════════

test('B2-AP1-07: staging + GET /api/wallet → 401 (was public on staging)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'GET', '/api/wallet');
  assert.equal(res.status, 401);
});

test('B2-AP1-08: production + GET /api/wallet → 401 (unchanged behavior)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production' }), 'GET', '/api/wallet');
  assert.equal(res.status, 401);
});

test('B2-AP1-09: staging + authorized admin initData + /api/wallet → gate accepts valid auth', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'GET', '/api/wallet', { initData: adminInitData() });
  assert.notEqual(res.status, 401, 'valid initData must pass the gate on staging');
  assert.notEqual(res.status, 403, 'admin must bypass the channel-join requirement');
});

test('B2-AP1-10: APP_ENV unset + GET /api/watchlist → 401 (fail-closed)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: undefined }), 'GET', '/api/watchlist');
  assert.equal(res.status, 401);
});

test('B2-AP1-11: APP_ENV variants (case/whitespace) all fail closed', async () => {
  const w = loadWorker();
  // NOTE: isDevMode() intentionally normalizes case+whitespace (S-01), so
  // 'Development' IS dev mode; only values that are not 'development' after
  // normalization — including near-misses like 'dev' — must fail closed.
  for (const v of [' Staging ', 'STAGING', 'staging ', 'dev', 'develop', 'development2']) {
    const res = await sendRequest(w, createEnv({ APP_ENV: v }), 'GET', '/api/forex');
    assert.equal(res.status, 401, `APP_ENV=${JSON.stringify(v)} must NOT bypass auth (exact-match only)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// C. AP-2 — start-diag / notif-diag-report behavioral
// ═══════════════════════════════════════════════════════════════════════════

test('B2-AP2-01: staging + GET /api/start-diag → 404', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'GET', '/api/start-diag');
  assert.equal(res.status, 404);
  assert.equal(res.body?.message, 'Not available in production');
});

test('B2-AP2-02: staging + POST /api/start-diag → 404 (setWebhook blocked)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'POST', '/api/start-diag', { body: {} });
  assert.equal(res.status, 404);
});

test('B2-AP2-03: production + GET /api/start-diag → 404 (unchanged)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production' }), 'GET', '/api/start-diag');
  assert.equal(res.status, 404);
});

test('B2-AP2-04: development + GET /api/start-diag → accessible (NOT 404)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'development' }), 'GET', '/api/start-diag');
  assert.notEqual(res.status, 404, 'dev mode must keep the diagnostic endpoint');
});

test('B2-AP2-05: APP_ENV unset + GET /api/start-diag → 404 (fail-closed)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: undefined }), 'GET', '/api/start-diag');
  assert.equal(res.status, 404);
});

test('B2-AP2-06: staging + POST /api/notif-diag-report → 404 (arbitrary JSON write blocked)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'staging' }), 'POST', '/api/notif-diag-report', { body: { anything: 'x'.repeat(10000) } });
  assert.equal(res.status, 404);
});

// ═══════════════════════════════════════════════════════════════════════════
// D. AP-3 — trigger-alerts secret matrix (real fetch handler)
// ═══════════════════════════════════════════════════════════════════════════

const SECRET = 'cron-shared-secret-abcdef0123456789';

test('B2-AP3-01: correct X-Cron-Secret → authorized (not 401)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'POST', '/api/admin/trigger-alerts', { headers: { 'X-Cron-Secret': SECRET } });
  assert.notEqual(res.status, 401, 'matching secret must authorize');
});

test('B2-AP3-02: wrong secret → 401', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'POST', '/api/admin/trigger-alerts', { headers: { 'X-Cron-Secret': 'wrong-secret' } });
  assert.equal(res.status, 401);
});

test('B2-AP3-03: missing secret header → 401', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'POST', '/api/admin/trigger-alerts', {});
  assert.equal(res.status, 401);
});

test('B2-AP3-04: prefix of the secret (different length) → 401', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'POST', '/api/admin/trigger-alerts', { headers: { 'X-Cron-Secret': SECRET.slice(0, 10) } });
  assert.equal(res.status, 401);
});

test('B2-AP3-05: Method 2 — valid admin initData without secret → authorized (not 401)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'POST', '/api/admin/trigger-alerts', { initData: adminInitData() });
  assert.notEqual(res.status, 401, 'Method 2 admin auth must be preserved');
});

test('B2-AP3-06: Method 2 — valid initData of a NON-admin → 401', async () => {
  const w = loadWorker();
  const initData = buildInitData('test-bot-token', { id: 999111222, first_name: 'User', lang_code: 'fa' });
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'POST', '/api/admin/trigger-alerts', { initData });
  assert.equal(res.status, 401);
});

test('B2-AP3-07: unset ALERTS_CRON_SHARED_SECRET + no header → 401 (fail-closed)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production' }), 'POST', '/api/admin/trigger-alerts', {});
  assert.equal(res.status, 401);
});

test('B2-AP3-08: GET + correct secret → still allowed (GET path preserved)', async () => {
  const w = loadWorker();
  const res = await sendRequest(w, createEnv({ APP_ENV: 'production', ALERTS_CRON_SHARED_SECRET: SECRET }), 'GET', '/api/admin/trigger-alerts', { headers: { 'X-Cron-Secret': SECRET } });
  assert.notEqual(res.status, 401);
});

// ═══════════════════════════════════════════════════════════════════════════
// E. timingSafeEqualSecret — unit tests on the REAL helper
// ═══════════════════════════════════════════════════════════════════════════

function extractTimingSafeEqualSecret() {
  const re = /function\s+timingSafeEqualSecret\s*\(/;
  const m = re.exec(WORKER_SRC);
  if (!m) throw new Error('timingSafeEqualSecret not found');
  // brace count from function start (simple body, no strings with braces)
  let depth = 0, i = WORKER_SRC.indexOf('{', m.index);
  for (let j = i; j < WORKER_SRC.length; j++) {
    if (WORKER_SRC[j] === '{') depth++;
    else if (WORKER_SRC[j] === '}') { depth--; if (depth === 0) return WORKER_SRC.slice(m.index, j + 1); }
  }
  throw new Error('unbalanced');
}
const timingSafeEqualSecret = new Function('createHmac', 'timingSafeEqual', 'TextEncoder',
  `return (${extractTimingSafeEqualSecret()})`)(crypto.createHmac, crypto.timingSafeEqual, TextEncoder);

test('B2-TS-01: equal strings → true', () => {
  assert.equal(timingSafeEqualSecret('abc123', 'abc123'), true);
});

test('B2-TS-02: same-length different strings → false', () => {
  assert.equal(timingSafeEqualSecret('abc123', 'abc124'), false);
});

test('B2-TS-03: different lengths → false (no throw, no length leak)', () => {
  assert.equal(timingSafeEqualSecret('short', 'much-longer-string-value'), false);
  assert.equal(timingSafeEqualSecret('', 'x'), false);
  assert.equal(timingSafeEqualSecret('x', ''), false);
});

test('B2-TS-04: empty vs empty → true (=== semantics preserved)', () => {
  assert.equal(timingSafeEqualSecret('', ''), true);
});

test('B2-TS-05: constant-prefix of same length → false', () => {
  assert.equal(timingSafeEqualSecret('aXcde', 'abcde'), false);
});

test('B2-TS-06: unicode strings compared correctly', () => {
  assert.equal(timingSafeEqualSecret('رمز-یک', 'رمز-یک'), true);
  assert.equal(timingSafeEqualSecret('رمز-یک', 'رمز-دو'), false);
});

// ═══════════════════════════════════════════════════════════════════════════
// F. Source pins
// ═══════════════════════════════════════════════════════════════════════════

test('B2-SRC-01: _DATA_PATHS gate uses !isDevMode(env)', () => {
  const idx = WORKER_SRC.indexOf('const _DATA_PATHS');
  const block = WORKER_SRC.slice(idx, idx + 700);
  assert.ok(block.includes('!isDevMode(env) && _DATA_PATHS.test(url.pathname)'),
    '_DATA_PATHS gate must be !isDevMode(env) && …');
});

test('B2-SRC-02: PROTECTED_PATHS gate uses !isDevMode(env)', () => {
  const idx = WORKER_SRC.indexOf('const PROTECTED_PATHS');
  const block = WORKER_SRC.slice(idx, idx + 700);
  assert.ok(block.includes('!isDevMode(env) && PROTECTED_PATHS.test(url.pathname)'),
    'PROTECTED_PATHS gate must be !isDevMode(env) && …');
});

test('B2-SRC-03: no prod-only gate variables remain for the AP-1 gates', () => {
  assert.ok(!WORKER_SRC.includes('const _isProdEnv ='), 'the _DATA_PATHS prod-only var must be gone');
  assert.ok(!WORKER_SRC.includes('const _isProduction = String'), 'the PROTECTED_PATHS prod-only var must be gone');
});

test('B2-SRC-04: start-diag gate uses !isDevMode(env) with the standard 404', () => {
  const idx = WORKER_SRC.indexOf("if (url.pathname === '/api/start-diag')");
  const block = WORKER_SRC.slice(idx, idx + 300);
  assert.ok(block.includes('!isDevMode(env)'), 'gate must use !isDevMode(env)');
  assert.ok(block.includes('status: 404'), 'gate must return 404');
});

test('B2-SRC-05: notif-diag-report gate uses !isDevMode(env) with the standard 404', () => {
  const idx = WORKER_SRC.indexOf("if (url.pathname === '/api/notif-diag-report')");
  const block = WORKER_SRC.slice(idx, idx + 600);
  assert.ok(block.includes('!isDevMode(env)'), 'gate must use !isDevMode(env)');
  assert.ok(block.includes('status: 404'), 'gate must return 404');
});

test('B2-SRC-06: AP-3 comparison is timing-safe (no raw === on the shared secret)', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/admin/trigger-alerts'");
  const block = WORKER_SRC.slice(idx, idx + 1400);
  assert.ok(block.includes('timingSafeEqualSecret(providedSecret, expectedSecret)'),
    'trigger-alerts Method 1 must use timingSafeEqualSecret');
  assert.ok(!block.includes('providedSecret === expectedSecret'),
    'the raw === comparison must be gone');
});

test('B2-SRC-07: isDevMode is the exact-match development definition (S-01 preserved)', () => {
  const idx = WORKER_SRC.indexOf('function isDevMode(env)');
  const block = WORKER_SRC.slice(idx, idx + 200);
  assert.ok(block.includes("'development'"), "isDevMode must compare against 'development' exactly");
});

test('B2-SRC-08: the 5 read-only staging diag monitors remain prod-gated (out-of-scope boundary)', () => {
  // cron-monitor, news-ai-monitor, news-ai-timing, news-ai-pending,
  // notif-trace-results: documented LOW residual — intentionally untouched.
  for (const route of ['/api/cron-monitor', '/api/news-ai-monitor', '/api/news-ai-timing', '/api/news-ai-pending', '/api/notif-trace-results']) {
    const idx = WORKER_SRC.indexOf(`url.pathname === '${route}'`);
    assert.ok(idx > -1, `${route} route must exist`);
    const block = WORKER_SRC.slice(idx, idx + 500);
    assert.ok(block.includes('_isProd'), `${route} keeps its existing _isProd gate (untouched)`);
  }
});

test('B2-SRC-09: trigger-alerts 401 failure path unchanged', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/admin/trigger-alerts'");
  const block = WORKER_SRC.slice(idx, idx + 2000);
  assert.ok(block.includes("status: 401"), '401 path must remain');
  assert.ok(block.includes("'Unauthorized'"), 'Unauthorized message must remain');
});

test('B2-SRC-10: admin-diag not touched by Batch 2 (still authenticateTelegramRequest)', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/admin-diag'");
  const block = WORKER_SRC.slice(idx, idx + 800);
  assert.ok(block.includes('authenticateTelegramRequest'), 'admin-diag auth unchanged');
  assert.ok(!block.includes('!isDevMode'), 'Batch 2 must not alter the admin-diag gate');
});

globalThis.fetch = realFetch;

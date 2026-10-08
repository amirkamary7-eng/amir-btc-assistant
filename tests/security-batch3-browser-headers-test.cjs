/**
 * Security Batch 3 — Browser Security / Headers Regression Tests
 * ----------------------------------------------------------------
 * HD-3: nosniff on EVERY JSON API response (jsonResponse) + OPTIONS preflight
 * HD-8: ad-image ACAO fail-closed (_adImageAcao — no more `|| '*'`)
 * HD-7: /api/market singleFlight rebuild restores Cache-Control no-store
 * HD-6: CSV exports get security headers + CORS (cross-origin admin download)
 * HD-5: Pages _headers gains the global document-level security block
 *       (nosniff, Referrer-Policy, Permissions-Policy, CSP-RO)
 * HD-4: ENFORCED CSP frame-ancestors 'self' + web.telegram.org + t.me
 * HD-1: full policy in Content-Security-Policy-Report-Only (enforcement
 *       deferred pending the ~453 inline-handler nonce/hash migration)
 *
 * Behavioral tests drive the REAL worker fetch handler; _headers assertions
 * run the REAL build script output (scripts/prepare-pages.mjs).
 *
 * Run: node --test tests/security-batch3-browser-headers-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');
const PREPARE_SRC = fs.readFileSync(path.join(__dirname, '..', 'scripts', 'prepare-pages.mjs'), 'utf8');
const MEMBERSHIP_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'membership.js'), 'utf8');
const ADS_CTRL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'advertisements.js'), 'utf8');

// ── loadWorker harness (same ESM→CJS transform as the chat-ai-quota suite) ──
function loadWorker() {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');
  const defaultMocks = {
    'pg': { Pool: class { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } } },
    '@neondatabase/serverless': {
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
    DATABASE_URL: 'postgresql://test',
    APP_ENV: 'production',
    BOT_USERNAME: '',
    WEBAPP_URL: 'https://amir-btc.pages.dev',
    APP_CACHE: createMemoryKv({ 'market:data:v3': JSON.stringify([{ symbol: 'BTC', priceUsd: 97000, changePercent24Hr: -1.5 }]) }),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
  }, o);
}

async function rawRequest(w, e, m, p, o = {}) {
  const u = p.startsWith('http') ? p : `http://localhost${p}`;
  const h = new Headers(o.headers || {});
  if (o.initData) h.set('X-Telegram-Init-Data', o.initData);
  const r = { method: m, headers: h };
  const res = await w.fetch(new Request(u, r), e, {});
  const clone = res.clone(); // clone BEFORE consuming the body
  const body = await res.text();
  // Raw leading bytes (Response.text() strips a leading UTF-8 BOM per spec).
  const bytes = new Uint8Array(await clone.arrayBuffer());
  return { status: res.status, headers: res.headers, body, bytes };
}

const ADMIN_USER = { id: 831704732, first_name: 'Admin', username: 'admin', lang_code: 'fa' };
const adminInitData = () => buildInitData('test-bot-token', ADMIN_USER);

// ════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL — real worker fetch handler
// ════════════════════════════════════════════════════════════════════════════

test('B3-BHV-01: GET /api/health → 200 with nosniff (HD-3)', async () => {
  const w = loadWorker();
  const res = await rawRequest(w, createEnv(), 'GET', '/api/health');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('B3-BHV-02: OPTIONS preflight → 204 with nosniff (HD-3)', async () => {
  const w = loadWorker();
  const res = await rawRequest(w, createEnv(), 'OPTIONS', '/api/health');
  assert.equal(res.status, 204);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('B3-BHV-03: 401 error path also carries nosniff (HD-3 whole surface)', async () => {
  const w = loadWorker();
  const res = await rawRequest(w, createEnv(), 'GET', '/api/wallet');
  assert.equal(res.status, 401);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('B3-BHV-04: /api/market (KV-warm) → no-store + nosniff (HD-7)', async () => {
  const w = loadWorker();
  const res = await rawRequest(w, createEnv(), 'GET', '/api/market');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Cache-Control'), 'no-store, no-cache, must-revalidate',
    'singleFlight rebuild must restore the jsonResponse Cache-Control value');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
});

test('B3-BHV-05: /api/market Cache-Control matches the jsonResponse value exactly (HD-7)', async () => {
  const w = loadWorker();
  const market = await rawRequest(w, createEnv(), 'GET', '/api/market');
  const health = await rawRequest(w, createEnv(), 'GET', '/api/health');
  assert.equal(market.headers.get('Cache-Control'), health.headers.get('Cache-Control'),
    'market and jsonResponse must emit the same Cache-Control');
});

test('B3-BHV-06: ad image ACAO — WEBAPP_URL set → its origin (HD-8)', async () => {
  const w = loadWorker();
  // seed an image into the KV the repo reads (adimg:<id>)
  const env = createEnv();
  await env.RATE_LIMITS.put('adimg:abcd1234abcd1234', 'image/png\n' + Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64'));
  const res = await rawRequest(w, env, 'GET', '/api/advertisements/image/abcd1234abcd1234');
  assert.equal(res.status, 200, 'image must be served');
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'https://amir-btc.pages.dev');
});

test('B3-BHV-07: ad image ACAO — WEBAPP_URL unset → NO ACAO header (fail-closed)', async () => {
  const w = loadWorker();
  const env = createEnv({ WEBAPP_URL: '' });
  await env.RATE_LIMITS.put('adimg:abcd1234abcd1234', 'image/png\n' + Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64'));
  const res = await rawRequest(w, env, 'GET', '/api/advertisements/image/abcd1234abcd1234');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null,
    'unset WEBAPP_URL must NOT fall back to *');
});

test('B3-BHV-08: ad image ACAO — malformed WEBAPP_URL → NO ACAO header', async () => {
  const w = loadWorker();
  const env = createEnv({ WEBAPP_URL: 'not-a-url' });
  await env.RATE_LIMITS.put('adimg:abcd1234abcd1234', 'image/png\n' + Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64'));
  const res = await rawRequest(w, env, 'GET', '/api/advertisements/image/abcd1234abcd1234');
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), null);
});

test('B3-BHV-09: ad image ACAO — localhost dev origin echoes back', async () => {
  const w = loadWorker();
  const env = createEnv({ WEBAPP_URL: 'https://amir-btc.pages.dev' });
  await env.RATE_LIMITS.put('adimg:abcd1234abcd1234', 'image/png\n' + Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mP8z8BQDwAEhQGAhKmMIQAAAABJRU5ErkJggg==', 'base64').toString('base64'));
  const res = await rawRequest(w, env, 'GET', '/api/advertisements/image/abcd1234abcd1234',
    { headers: { Origin: 'http://localhost:5173' } });
  assert.equal(res.status, 200);
  assert.equal(res.headers.get('Access-Control-Allow-Origin'), 'http://localhost:5173');
});

test('B3-BHV-10: ad image — invalid ID → 404 (unchanged)', async () => {
  const w = loadWorker();
  const res = await rawRequest(w, createEnv(), 'GET', '/api/advertisements/image/!!!');
  assert.equal(res.status, 404);
});

// ── CSV exports (HD-6) ─────────────────────────────────────────────────────

async function csvRequest(route) {
  const w = loadWorker();
  return rawRequest(w, createEnv(), 'GET', route, { initData: adminInitData() });
}

function assertCsvHeaders(res, filename) {
  assert.equal(res.status, 200, `route must succeed: ${res.status} ${res.body.slice(0, 120)}`);
  assert.equal(res.headers.get('Content-Type'), 'text/csv; charset=utf-8');
  assert.equal(res.headers.get('Content-Disposition'), `attachment; filename="${filename}"`);
  assert.equal(res.headers.get('Cache-Control'), 'no-store, no-cache, must-revalidate');
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');
  assert.ok(res.headers.get('Access-Control-Allow-Origin'),
    'ACAO must be present so the cross-origin admin download works');
  assert.equal(res.bytes[0], 0xEF, 'UTF-8 BOM byte 1');
  assert.equal(res.bytes[1], 0xBB, 'UTF-8 BOM byte 2');
  assert.equal(res.bytes[2], 0xBF, 'UTF-8 BOM byte 3');
}

test('B3-BHV-11: membership requests CSV — full security headers + BOM + header row', async () => {
  const res = await csvRequest('/api/admin/membership/requests/export');
  assertCsvHeaders(res, 'membership-requests.csv');
  assert.ok(res.body.includes('Telegram ID'), 'header row present');
});

test('B3-BHV-12: membership users CSV — full security headers + BOM + header row', async () => {
  const res = await csvRequest('/api/admin/membership/users/export');
  assertCsvHeaders(res, 'membership-users.csv');
  assert.ok(res.body.includes('Telegram ID'), 'header row present');
});

test('B3-BHV-13: membership audit-logs CSV — full security headers + BOM + header row', async () => {
  const res = await csvRequest('/api/admin/membership/logs/export');
  assertCsvHeaders(res, 'membership-audit-logs.csv');
  assert.ok(res.body.includes('Action'), 'header row present');
});

test('B3-BHV-14: CSV export unauthenticated → 401', async () => {
  const w = loadWorker();
  const res = await rawRequest(w, createEnv(), 'GET', '/api/admin/membership/requests/export');
  assert.equal(res.status, 401);
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE PINS — worker + controllers
// ════════════════════════════════════════════════════════════════════════════

test('B3-SRC-01: jsonResponse sets nosniff with a has() guard (HD-3)', () => {
  const idx = WORKER_SRC.indexOf('function jsonResponse(payload, init = {}, env = null)');
  const block = WORKER_SRC.slice(idx, idx + 1200);
  assert.ok(block.includes("headers.set('X-Content-Type-Options', 'nosniff')"), 'nosniff must be set');
  assert.ok(block.includes("if (!headers.has('X-Content-Type-Options'))"), 'guarded so callers can override');
});

test('B3-SRC-02: /api/market rebuild sets Cache-Control + nosniff (HD-7)', () => {
  const withCorsIdx = WORKER_SRC.indexOf('const _marketHeaders = withCors(');
  assert.ok(withCorsIdx > -1, 'withCors object literal must exist');
  const obj = WORKER_SRC.slice(withCorsIdx, withCorsIdx + 500);
  assert.ok(obj.includes("'Cache-Control': 'no-store, no-cache, must-revalidate'"), 'no-store restored');
  assert.ok(obj.includes("'X-Content-Type-Options': 'nosniff'"), 'nosniff present');
});

test('B3-SRC-03: _adImageAcao fail-closed \u2014 no wildcard fallback remains (HD-8)', () => {
  assert.ok(/function\s+_adImageAcao\s*\(/.test(ADS_CTRL_SRC), 'helper must exist');
  assert.ok(!ADS_CTRL_SRC.includes("'Access-Control-Allow-Origin': String(env.WEBAPP_URL"),
    'the wildcard fallback CODE must be gone (doc comments may quote it)');
  const idx = ADS_CTRL_SRC.indexOf('function _adImageAcao');
  const block = ADS_CTRL_SRC.slice(idx, idx + 1400);
  assert.ok(block.includes('localhost|127\\.0\\.0\\.1'), 'localhost dev echo');
  assert.ok(block.includes("new URL(webapp).origin"), 'WEBAPP_URL contributes ORIGIN only');
  assert.ok(/return ''/.test(block), 'unset/malformed → empty (no header)');
});

test('B3-SRC-04: csvSecurityHeaders exists and all 3 exports route through it (HD-6)', () => {
  assert.ok(/function\s+csvSecurityHeaders\s*\(/.test(MEMBERSHIP_SRC), 'helper must exist');
  assert.equal((MEMBERSHIP_SRC.match(/csvSecurityHeaders\('membership-[a-z-]+\.csv', env\)/g) || []).length, 3,
    'requests/users/logs exports must all use csvSecurityHeaders');
  const idx = MEMBERSHIP_SRC.indexOf('function csvSecurityHeaders');
  const block = MEMBERSHIP_SRC.slice(idx, idx + 700);
  assert.ok(block.includes('withCors('), 'ACAO via withCors');
  assert.ok(block.includes('no-store'), 'no-store');
  assert.ok(block.includes('nosniff'), 'nosniff');
  assert.ok(block.includes('Content-Disposition'), 'attachment disposition');
});

test('B3-SRC-05: withCors injected into createMembershipHandlers DI (HD-6 wiring)', () => {
  const idx = WORKER_SRC.indexOf('const membershipHandlers = createMembershipHandlers({');
  const block = WORKER_SRC.slice(idx, idx + 900);
  assert.ok(block.includes('withCors,'), 'withCors must be injected');
});

// ════════════════════════════════════════════════════════════════════════════
// SOURCE PINS — Pages _headers build (HD-5/HD-4/HD-1)
// ════════════════════════════════════════════════════════════════════════════

function buildHeadersFile() {
  // Re-run the REAL build script logic to obtain the _headers content.
  const { execSync } = require('node:child_process');
  const out = path.join(__dirname, '..', 'webapp', 'pages-dist', '_headers');
  if (!fs.existsSync(out)) {
    execSync('node scripts/prepare-pages.mjs', { cwd: path.join(__dirname, '..'), stdio: 'pipe' });
  }
  return fs.readFileSync(out, 'utf8');
}
const HEADERS_FILE = buildHeadersFile();

// Extract the /* rule block: lines after the bare '/*' rule until the next
// blank line. (A naive split('/*') would also cut inside the CSP directive
// 'https://*.tradingview.com'.)
function globalSecurityBlock() {
  const lines = HEADERS_FILE.split('\n');
  const start = lines.findIndex((l) => l.trim() === '/*');
  assert.ok(start > -1, '/* rule must exist in _headers');
  const out = [];
  for (let i = start + 1; i < lines.length; i++) {
    if (lines[i].trim() === '') break;
    out.push(lines[i].trim());
  }
  return out.join('\n');
}
const GLOBAL_BLOCK = globalSecurityBlock();
function headerValue(name) {
  const line = GLOBAL_BLOCK.split('\n').find((l) => l.startsWith(name + ':'));
  return line ? line.slice(name.length + 1).trim() : '';
}

test('B3-SRC-06: _headers gains the global /* security block (HD-5)', () => {
  assert.ok(/^\/\*$/m.test(HEADERS_FILE), '/* rule present');
  assert.ok(GLOBAL_BLOCK.includes('X-Content-Type-Options: nosniff'));
  assert.ok(GLOBAL_BLOCK.includes('Referrer-Policy: strict-origin-when-cross-origin'));
  assert.ok(GLOBAL_BLOCK.includes('Permissions-Policy:'));
  assert.ok(GLOBAL_BLOCK.includes('Content-Security-Policy:'));
  assert.ok(GLOBAL_BLOCK.includes('Content-Security-Policy-Report-Only:'));
});

test('B3-SRC-07: Permissions-Policy denies unused features, KEEPS clipboard-write=(self)', () => {
  const pp = headerValue('Permissions-Policy');
  for (const feat of ['camera=()', 'microphone=()', 'geolocation=()', 'payment=()', 'usb=()', 'bluetooth=()', 'midi=()', 'clipboard-read=()', 'interest-cohort=()']) {
    assert.ok(pp.includes(feat), `must deny ${feat}`);
  }
  assert.ok(pp.includes('clipboard-write=(self)'), 'clipboard-write=(self) must be KEPT for copy buttons');
});

test('B3-SRC-08: NO Cache-Control inside the /* block (immutable asset rules untouched)', () => {
  assert.ok(!GLOBAL_BLOCK.includes('Cache-Control'), 'the /* block must not set Cache-Control');
});

test('B3-SRC-09: existing cache rules untouched (index.html no-store + 1-year immutable)', () => {
  assert.ok(/\/index\.html[\s\S]{0,200}Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate/.test(HEADERS_FILE));
  assert.ok(/\/\*\.js\n {2}Cache-Control: public, max-age=31536000, immutable/.test(HEADERS_FILE));
  assert.ok(/\/\*\.css\n {2}Cache-Control: public, max-age=31536000, immutable/.test(HEADERS_FILE));
  assert.ok(/\/assets\/\*\n {2}Cache-Control: public, max-age=31536000, immutable/.test(HEADERS_FILE));
});

test('B3-SRC-10: enforced CSP is frame-ancestors-only with the exact Telegram origins (HD-4)', () => {
  assert.equal(headerValue('Content-Security-Policy'), "frame-ancestors 'self' https://web.telegram.org https://t.me");
});

test('B3-SRC-11: enforced CSP contains ONLY frame-ancestors (no script-src etc.)', () => {
  const csp = headerValue('Content-Security-Policy');
  assert.ok(!csp.includes('script-src'), 'script-src must NOT be enforced yet (inline handlers)');
  assert.ok(!csp.includes("frame-ancestors 'none'"), 'never none — Telegram web clients must embed');
});

test('B3-SRC-12: CSP-Report-Only carries the full policy minimums (HD-1)', () => {
  const ro = headerValue('Content-Security-Policy-Report-Only');
  for (const frag of ["object-src 'none'", "base-uri 'self'", "script-src 'self' 'unsafe-inline' https://telegram.org https://s3.tradingview.com", "img-src 'self' data: https:", "form-action 'self'", "worker-src 'none'", "manifest-src 'none'", "media-src 'none'", "frame-src https://*.tradingview.com"]) {
    assert.ok(ro.includes(frag), `CSP-RO must include ${frag}`);
  }
});

test('B3-SRC-13: CSP-RO connect-src is WORKER_API_URL-aware (effectiveWorkerApiOrigin)', () => {
  assert.ok(/function\s+effectiveWorkerApiOrigin\s*\(/.test(PREPARE_SRC), 'helper must exist');
  const ro = headerValue('Content-Security-Policy-Report-Only');
  const connect = ro.split('connect-src ')[1].split(';')[0];
  assert.ok(connect.includes('https://scanner.tradingview.com'), 'TradingView scanner allowed');
  assert.ok(/https:\/\/[a-z0-9.-]+\.workers\.dev/.test(connect), 'a concrete worker origin (no env → hardcoded default)');
});

test('B3-SRC-14: prepare-pages build script uses effectiveWorkerApiOrigin() in the CSP-RO line', () => {
  const idx = PREPARE_SRC.indexOf('Content-Security-Policy-Report-Only:');
  assert.ok(idx > -1, 'CSP-RO line must exist in the build script');
  const line = PREPARE_SRC.slice(idx, idx + 400);
  assert.ok(line.includes('${effectiveWorkerApiOrigin()}'), 'worker origin must come from the helper');
});

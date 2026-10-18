/**
 * INITDATA auth_date FAIL-CLOSED REGRESSION TEST — SEC-05 (Phase 20)
 * =================================================================
 *
 * FINDING (Phase 19 final audit, re-verified in Phase 20 scope at 698b3c71):
 *   validateTelegramInitData (worker-proxy.js) treated the auth_date
 *   freshness check as OPTIONAL:
 *     * initData with NO auth_date at all validated successfully (fail-open)
 *     * non-numeric auth_date ('abc') validated successfully (fail-open)
 *     * a FUTURE-dated auth_date was accepted (negative age always passes
 *       the max-age check), extending the payload's acceptance window by
 *       its future offset.
 *   A hash-valid initData string is bound to the bot token, so the primary
 *   abuse class is replay of a CAPTURED initData string: with the fail-open
 *   classes, a captured payload with a stripped/garbage auth_date never
 *   expired, and a future-dated payload stayed valid beyond 24h.
 *
 * FIX UNDER TEST (minimal, fail-closed — same idiom as SEC-03/SEC-04):
 *   1. auth_date is REQUIRED (missing / non-numeric / <= 0 → reject).
 *   2. auth_date more than 300s in the FUTURE → reject (clock-skew window).
 *   3. auth_date older than maxAgeSeconds (default 86400 = 24h) → reject.
 *   The 24h TTL is deliberately KEPT: Telegram generates initData once per
 *   Mini App launch and long sessions are normal; shortening it is a
 *   product decision, not a security fix.
 *   NO replay/nonce store is added — this test file makes no claim of full
 *   replay protection.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   * SECTION 1 — isolated unit tests on the REAL validateTelegramInitData
 *     extracted from worker-proxy.js source (same harness as
 *     tests/worker-proxy.test.cjs).
 *   * SECTION 2 — source locks (fail-closed marker present, optional-guard
 *     pattern gone).
 *   * SECTION 3 — behavioral matrix through the REAL worker (loadWorker
 *     harness) driving the _DATA_PATHS auth gate (GET /api/forex) with a
 *     hash-valid initData string per time class.
 *
 *   Pre-fix (baseline 698b3c71): U3/U4/U6/U8 + B2/B3/B4/B6 FAIL
 *   (missing / non-numeric / future auth_date all validated).
 *   Post-fix: all tests PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// initData builder — hash-valid strings with FULLY CONTROLLABLE pairs.
// Mirrors the worker's DCS construction: pairs excluding 'hash', sorted by
// key, DECODED values joined with '\n' (worker-proxy.js:1306-1319).
// ═══════════════════════════════════════════════════════════════════════════
function buildSignedInitData(botToken, user, options = {}) {
  const entries = [];
  if (options.includeAuthDate !== false) {
    entries.push(['auth_date', String(options.authDateRaw ?? Math.floor(Date.now() / 1000))]);
  }
  if (options.startParam !== undefined) {
    entries.push(['start_param', String(options.startParam)]);
  }
  entries.push(['query_id', options.queryId || 'AAHdF6IQAAAAAN0XohDhrOrc']);
  entries.push(['user', JSON.stringify(user)]);
  const dataCheckString = entries
    .slice()
    .sort(([a], [b]) => a.localeCompare(b))
    .map(([k, v]) => `${k}=${v}`)
    .join('\n');
  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
  return entries
    .map(([k, v]) => `${k}=${encodeURIComponent(v)}`)
    .concat([`hash=${hash}`])
    .join('&');
}

// ── Extract the REAL validateTelegramInitData for isolated unit tests ──
// (same extraction harness as tests/worker-proxy.test.cjs)
function loadValidateTelegramInitData() {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');
  const helperStart = source.indexOf('function parseTelegramInitDataPairs');
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

const NOW = Math.floor(Date.now() / 1000);
const USER = { id: 424242, first_name: 'Sec05', username: 'sec05_user' };
const ADMIN = { id: 831704732, first_name: 'Admin', username: 'admin' };

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Isolated unit tests on the REAL validator
// ═══════════════════════════════════════════════════════════════════════════

test('SEC05-U1: fresh auth_date validates and returns { user, startParam }', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { startParam: 'ref_888' });
  const result = await validate(initData, 'test-bot-token');
  assert.ok(result, 'fresh initData must validate');
  assert.equal(result.user.id, 424242);
  assert.equal(result.startParam, 'ref_888', 'signed start_param must be extracted');
});

test('SEC05-U2: auth_date just inside the 24h TTL (86399s) still validates', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: NOW - 86399 });
  const result = await validate(initData, 'test-bot-token');
  assert.ok(result, 'age 86399s <= 86400s must validate');
});

test('SEC05-U3: MISSING auth_date → rejected (was the fail-open hole)', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { includeAuthDate: false });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'initData without auth_date must FAIL CLOSED');
});

test('SEC05-U4: non-numeric auth_date → rejected (was the fail-open hole)', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: 'abc' });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, "auth_date='abc' must FAIL CLOSED");
});

test('SEC05-U5: empty auth_date value → rejected', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: '' });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'empty auth_date must FAIL CLOSED');
});

test('SEC05-U6: auth_date = 0 → rejected (non-positive epoch is invalid)', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: '0' });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'auth_date=0 must FAIL CLOSED');
});

test('SEC05-U7: negative auth_date → rejected', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: '-100' });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'negative auth_date must FAIL CLOSED');
});

test('SEC05-U8: auth_date far in the FUTURE (+86400s) → rejected (window-extension fix)', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: NOW + 86400 });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'future auth_date beyond the 300s skew must FAIL CLOSED');
});

test('SEC05-U9: auth_date slightly in the future (+60s, within skew) → validates (clock drift tolerated)', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: NOW + 60 });
  const result = await validate(initData, 'test-bot-token');
  assert.ok(result, 'future auth_date within the 300s clock-skew window must validate');
});

test('SEC05-U10: auth_date future beyond skew (+600s) → rejected', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('test-bot-token', USER, { authDateRaw: NOW + 600 });
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'future auth_date beyond the 300s skew must FAIL CLOSED');
});

test('SEC05-U11: hash mismatch still rejected regardless of fresh auth_date (regression lock)', async () => {
  const validate = loadValidateTelegramInitData();
  const initData = buildSignedInitData('OTHER-token', USER);
  const result = await validate(initData, 'test-bot-token');
  assert.equal(result, null, 'HMAC validation must remain the primary gate');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Source locks
// ═══════════════════════════════════════════════════════════════════════════

test('SEC05-S1: fail-closed auth_date block carries the SEC-05 FIX marker', () => {
  assert.ok(WORKER_SRC.includes('SEC-05 FIX'),
    'worker-proxy.js must carry the SEC-05 FIX marker');
});

test('SEC05-S2: the optional auth_date guard pattern is gone (fail-open removed)', () => {
  const fnStart = WORKER_SRC.indexOf('async function validateTelegramInitData');
  const fnEnd = WORKER_SRC.indexOf('async function authenticateTelegramRequest');
  const fnSrc = WORKER_SRC.slice(fnStart, fnEnd);
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'validateTelegramInitData must exist');
  assert.ok(!fnSrc.includes('if (authDateValue) {'),
    'the old optional wrapper `if (authDateValue) {` must be removed');
  assert.ok(!fnSrc.includes('if (Number.isFinite(authDate)) {'),
    'the old nested finite-guard must be removed (non-finite now rejects)');
  assert.ok(fnSrc.includes('return null'),
    'the function must retain its null-return failure contract');
});

test('SEC05-S3: 24h default TTL preserved (maxAgeSeconds = 86400 — product decision, not a security change)', () => {
  const fnStart = WORKER_SRC.indexOf('async function validateTelegramInitData');
  const fnEnd = WORKER_SRC.indexOf('async function authenticateTelegramRequest');
  const fnSrc = WORKER_SRC.slice(fnStart, fnEnd);
  assert.ok(/maxAgeSeconds\s*=\s*86400/.test(fnSrc),
    'the default TTL must remain 86400s (24h) — shortening it would 401 long Mini App sessions');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Behavioral matrix through the REAL worker (_DATA_PATHS gate)
// The gate (worker-proxy.js ~:8142) runs authenticateTelegramRequest on
// GET /api/forex for every non-dev environment, BEFORE any DB access:
//   401  → auth rejected (the class under test)
//   ≠401 → auth accepted (admin user also clears requireChannelJoin via the
//          Gateway's isAdminTelegramId early-exit, so the request proceeds)
// ═══════════════════════════════════════════════════════════════════════════

// ── loadWorker harness (same ESM→CJS transform as the sec03/sec04 suites) ──
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

function createMemoryKv(i = {}) {
  const s = new Map(Object.entries(i));
  return {
    async get(k) { return s.has(k) ? s.get(k) : null; },
    async put(k, v, o) { s.set(k, v); },
    async delete(k) { s.delete(k); },
    async list(o) {
      const keys = [];
      for (const k of s.keys()) {
        if (o && o.prefix && !k.startsWith(o.prefix)) continue;
        keys.push({ name: k });
        if (o && o.limit && keys.length >= o.limit) break;
      }
      return { keys };
    },
  };
}

function createEnv(o = {}) {
  const env = Object.assign({
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: '',
    APP_ENV: 'development',
    BOT_USERNAME: '',
    APP_CACHE: createMemoryKv(),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
  }, o);
  if (Object.prototype.hasOwnProperty.call(o, 'APP_ENV') && o.APP_ENV === undefined) {
    delete env.APP_ENV;
  }
  return env;
}

// Stub global fetch — behavioral tests must not hit the network.
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });

/** GET /api/forex with the given initData header; returns {status, body}. */
async function probeForex(worker, env, initData) {
  const headers = new Headers({ 'User-Agent': 'sec05-regression-test' });
  if (initData) headers.set('X-Telegram-Init-Data', initData);
  const res = await worker.fetch(
    new Request('http://localhost/api/forex', { method: 'GET', headers }),
    env, {});
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

test('SEC05-B1: staging + fresh auth_date + admin → auth accepted (not 401)', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN);
  const r = await probeForex(worker, createEnv({ APP_ENV: 'staging' }), initData);
  assert.notEqual(r.status, 401, 'fresh signed initData must pass the auth gate');
});

test('SEC05-B2: staging + initData WITHOUT auth_date → 401 (fail-closed through the real gate)', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN, { includeAuthDate: false });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'staging' }), initData);
  assert.equal(r.status, 401, 'missing auth_date must be rejected end-to-end');
});

test('SEC05-B3: production + initData WITHOUT auth_date → 401', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN, { includeAuthDate: false });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'production' }), initData);
  assert.equal(r.status, 401, 'missing auth_date must be rejected in production too');
});

test('SEC05-B4: staging + FUTURE auth_date (+2h) → 401 (window-extension fix)', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN, { authDateRaw: Math.floor(Date.now() / 1000) + 7200 });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'staging' }), initData);
  assert.equal(r.status, 401, 'future-dated auth_date beyond skew must be rejected');
});

test('SEC05-B5: staging + auth_date older than 24h (now-86402) → 401 (existing TTL contract)', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN, { authDateRaw: Math.floor(Date.now() / 1000) - 86402 });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'staging' }), initData);
  assert.equal(r.status, 401, 'stale auth_date must be rejected (pre-existing behavior preserved)');
});

test('SEC05-B6: staging + non-numeric auth_date → 401', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN, { authDateRaw: 'not-a-number' });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'staging' }), initData);
  assert.equal(r.status, 401, 'non-numeric auth_date must be rejected end-to-end');
});

test('SEC05-B7: staging + auth_date slightly future (+60s, within skew) + admin → auth accepted', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', ADMIN, { authDateRaw: Math.floor(Date.now() / 1000) + 60 });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'staging' }), initData);
  assert.notEqual(r.status, 401, 'small clock skew must be tolerated (no false 401s)');
});

test('SEC05-B8: dev + initData WITHOUT auth_date → gate inactive in dev (dev bypass preserved, unrelated to the gate)', async () => {
  const worker = loadWorker();
  const initData = buildSignedInitData('test-bot-token', USER, { includeAuthDate: false });
  const r = await probeForex(worker, createEnv({ APP_ENV: 'development' }), initData);
  assert.notEqual(r.status, 401, 'the _DATA_PATHS gate itself stays dev-inactive (SEC-04/B2-AP1 contract)');
});

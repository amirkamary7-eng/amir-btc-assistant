/**
 * DIAGNOSTICS GATES FAIL-CLOSED REGRESSION TEST — SEC-04 (Phase 11)
 * =================================================================
 *
 * FINDING (Phase 10 read-only audit, CONFIRMED, Medium/P2):
 *   Five zero-auth diagnostic endpoints were gated on the APP_ENV ===
 *   'production' EQUALITY check (`const _isProd = ...`):
 *     GET /api/cron-monitor, GET /api/news-ai-monitor, GET /api/news-ai-timing,
 *     GET /api/news-ai-pending, GET /api/notif-trace-results
 *   Only the exact string 'production' was blocked. Staging served all five
 *   live (verified: HTTP 200 with real telemetry on the public staging URL),
 *   and unset/typo/whitespace-padded APP_ENV values ('prod', ' production')
 *   would re-open them in ANY deployment. The gate lacked isDevMode's
 *   trim(), so leading/trailing whitespace bypassed it as well.
 *
 * FIX UNDER TEST (Phase 11, minimal):
 *   Each of the five gates is now `if (!isDevMode(env)) -> 404` — the same
 *   fail-closed idiom already used by the H2 (/api/notif-diag-report) and
 *   H3 (/api/start-diag) gates. Only APP_ENV='development' (any case, with
 *   surrounding whitespace tolerated, per isDevMode trim+toLowerCase) serves
 *   the endpoints; staging, unset, and every invalid value fail closed.
 *   Response body/message unchanged ("Not available in production").
 *
 * TEST PROTOCOL (RED → GREEN):
 *   Behavioral tests drive the REAL worker module — the exact ESM→CJS
 *   loadWorker harness used by webhook-secret-failclosed-sec03-regression-
 *   test.cjs / security-batch2-staging-auth-test.cjs — so the REAL route
 *   dispatch, the REAL isDevMode, and the REAL handlers all execute.
 *   globalThis.fetch is stubbed (diagnostics handlers must not call out).
 *
 *   Pre-fix (baseline 2dc00f4c): SEC04-S2/S3/S4 + B3/B4/B5/B6 FAIL
 *   (staging/unset/'prod'/' production' served 200 — the fail-open).
 *   Post-fix: all 14 PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const SRC = fs.readFileSync(WORKER_PATH, 'utf8');

const DIAGNOSTIC_PATHS = [
  '/api/cron-monitor',
  '/api/news-ai-monitor',
  '/api/news-ai-timing',
  '/api/news-ai-pending',
  '/api/notif-trace-results',
];

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source locks (the five gates exist and are fail-closed)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC04-S1: all five GET diagnostic routes exist', () => {
  for (const p of DIAGNOSTIC_PATHS) {
    assert.ok(SRC.includes(`request.method === 'GET' && url.pathname === '${p}'`),
      `GET route ${p} must exist`);
  }
});

test('SEC04-S2: each of the five gates is fail-closed via !isDevMode(env) -> 404', () => {
  for (const p of DIAGNOSTIC_PATHS) {
    const routeIdx = SRC.indexOf(`url.pathname === '${p}'`);
    assert.ok(routeIdx > -1, `route ${p} must exist`);
    const block = SRC.slice(routeIdx, routeIdx + 900);
    assert.ok(block.includes('!isDevMode(env)'),
      `gate for ${p} must use !isDevMode(env) (fail-closed idiom)`);
    assert.ok(block.includes('status: 404'),
      `gate for ${p} must return 404`);
    assert.ok(block.includes('Not available in production'),
      `gate for ${p} must return the standard not-available message`);
    assert.ok(!block.includes('_isProd'),
      `gate for ${p} must no longer use the _isProd equality check`);
  }
});

test('SEC04-S3: no legacy _isProd equality gate remains anywhere in the worker', () => {
  assert.equal((SRC.match(/_isProd/g) || []).length, 0,
    'all five _isProd equality gates must be removed');
  assert.ok(!SRC.includes("String(env.APP_ENV || '').toLowerCase() === 'production'"),
    'the APP_ENV production-equality gate pattern must not remain');
});

test('SEC04-S4: exactly five SEC-04 FIX markers (scope lock — nothing else touched)', () => {
  assert.equal((SRC.match(/SEC-04 FIX/g) || []).length, 5,
    'only the five approved gates carry the SEC-04 FIX marker');
});

test('SEC04-S5: isDevMode idiom unchanged (trim + lowercase + development-only)', () => {
  const idx = SRC.indexOf('function isDevMode(env)');
  assert.ok(idx > -1, 'isDevMode must exist');
  const def = SRC.slice(idx, idx + 200);
  assert.ok(def.includes("String(env.APP_ENV || '')"),
    'must read APP_ENV with empty-string fallback (unset -> not dev)');
  assert.ok(def.includes('.trim().toLowerCase()'),
    'must trim + lowercase (whitespace-padded values must not bypass)');
  assert.ok(def.includes("=== 'development'"),
    'must compare against development only');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Behavioral matrix through the REAL worker
// ═══════════════════════════════════════════════════════════════════════════

// ── loadWorker harness (same ESM→CJS transform as the sec03/security-batch2 suites) ──
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

// In-memory KV WITH list() — cron-monitor and notif-trace-results call
// env.APP_CACHE.list({prefix}) before reading entries.
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
    dump() { return Object.fromEntries(s.entries()); },
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
    delete env.APP_ENV; // simulate the variable missing entirely
  }
  return env;
}

// Stub global fetch — behavioral tests must not hit the network.
let outboundFetchCalls = 0;
globalThis.fetch = async () => { outboundFetchCalls++; return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } }); };

/** GET a diagnostics endpoint; returns {status, body}. */
async function getDiagnostic(worker, env, urlPath) {
  const res = await worker.fetch(
    new Request(`http://localhost${urlPath}`, { method: 'GET', headers: new Headers({ 'User-Agent': 'sec04-regression-test' }) }),
    env, {});
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

async function assertAll404(envOverrides, label) {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  for (const p of DIAGNOSTIC_PATHS) {
    const r = await getDiagnostic(worker, createEnv(envOverrides), p);
    assert.equal(r.status, 404, `${label}: ${p} must be 404 (fail-closed)`);
    assert.equal(r.body && r.body.status, 'error', `${label}: ${p} body.status must be error`);
    assert.equal(r.body && r.body.message, 'Not available in production',
      `${label}: ${p} must return the standard not-available message`);
  }
  assert.equal(outboundFetchCalls, 0, `${label}: 404 responses must trigger no outbound fetch`);
}

test('SEC04-B1: development -> 200 on ALL FIVE endpoints (dev access preserved)', async () => {
  const worker = loadWorker();
  for (const p of DIAGNOSTIC_PATHS) {
    const r = await getDiagnostic(worker, createEnv({ APP_ENV: 'development' }), p);
    assert.equal(r.status, 200, `dev access to ${p} must be preserved`);
    assert.ok(!r.body || r.body.status !== 'error',
      `dev response for ${p} must be real handler output, not a gate error`);
  }
});

test('SEC04-B2: production -> 404 on all five (existing contract preserved)', async () => {
  await assertAll404({ APP_ENV: 'production' }, 'production');
});

test('SEC04-B3: staging -> 404 on all five (THE fix — staging was exposed live)', async () => {
  await assertAll404({ APP_ENV: 'staging' }, 'staging');
});

test('SEC04-B4: APP_ENV unset entirely -> 404 on all five (safe default)', async () => {
  await assertAll404({ APP_ENV: undefined }, 'unset');
});

test("SEC04-B5: invalid APP_ENV 'prod' (typo) -> 404 on all five", async () => {
  await assertAll404({ APP_ENV: 'prod' }, 'typo-prod');
});

test("SEC04-B6: whitespace ' production' (leading space) -> 404 on all five (trim class)", async () => {
  // Phase 10 sub-finding: the OLD equality gate had toLowerCase() but NO
  // trim(), so ' production' bypassed it. isDevMode trims — now fail-closed.
  await assertAll404({ APP_ENV: ' production' }, 'whitespace-pad');
});

test("SEC04-B7: case variant 'Production' -> 404 on all five", async () => {
  await assertAll404({ APP_ENV: 'Production' }, 'case-variant');
});

test('SEC04-B8: dev 200 responses are genuine handler payloads (gate passage proven)', async () => {
  const worker = loadWorker();
  // cron-monitor returns server_time/totalLogEntries
  const cron = await getDiagnostic(worker, createEnv({ APP_ENV: 'development' }), '/api/cron-monitor');
  assert.equal(cron.status, 200);
  assert.equal(typeof cron.body.totalLogEntries, 'number', 'cron-monitor payload shape');
  // news-ai-monitor returns {status:'success', ...monitoring}
  const mon = await getDiagnostic(worker, createEnv({ APP_ENV: 'development' }), '/api/news-ai-monitor');
  assert.equal(mon.status, 200);
  assert.equal(mon.body.status, 'success', 'news-ai-monitor payload shape');
  // news-ai-timing returns {status:'success', ...timing}
  const tim = await getDiagnostic(worker, createEnv({ APP_ENV: 'development' }), '/api/news-ai-timing');
  assert.equal(tim.status, 200);
  assert.equal(tim.body.status, 'success', 'news-ai-timing payload shape');
  // news-ai-pending returns {status:'success', total_articles, diagnostics}
  const pend = await getDiagnostic(worker, createEnv({ APP_ENV: 'development' }), '/api/news-ai-pending');
  assert.equal(pend.status, 200);
  assert.equal(pend.body.status, 'success', 'news-ai-pending payload shape');
  assert.equal(typeof pend.body.total_articles, 'number', 'news-ai-pending total_articles');
  // notif-trace-results returns {trace_count, traces}
  const tr = await getDiagnostic(worker, createEnv({ APP_ENV: 'development' }), '/api/notif-trace-results');
  assert.equal(tr.status, 200);
  assert.equal(tr.body.trace_count, 0, 'notif-trace-results payload shape (empty KV)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — isDevMode semantics (mirror of the source definition)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC04-M1: isDevMode semantics — only development (case/space tolerant) is true', () => {
  function isDevMode(env) {
    const v = String(env.APP_ENV || '').trim().toLowerCase();
    return v === 'development';
  }
  // true only for development variants
  assert.equal(isDevMode({ APP_ENV: 'development' }), true);
  assert.equal(isDevMode({ APP_ENV: 'DEVELOPMENT' }), true);
  assert.equal(isDevMode({ APP_ENV: ' development ' }), true);
  // false for every non-development value — including all bypass classes
  assert.equal(isDevMode({ APP_ENV: 'production' }), false);
  assert.equal(isDevMode({ APP_ENV: 'Production' }), false);
  assert.equal(isDevMode({ APP_ENV: ' production' }), false);
  assert.equal(isDevMode({ APP_ENV: 'production ' }), false);
  assert.equal(isDevMode({ APP_ENV: 'staging' }), false);
  assert.equal(isDevMode({ APP_ENV: 'prod' }), false);
  assert.equal(isDevMode({ APP_ENV: '' }), false);
  assert.equal(isDevMode({}), false, 'unset APP_ENV must NOT be dev');
  assert.equal(isDevMode({ APP_ENV: undefined }), false);
});

/**
 * WEBHOOK SECRET FAIL-CLOSED REGRESSION TEST — SEC-03 (Phase 8)
 * =============================================================
 *
 * FINDING (Phase 7 read-only audit, CONFIRMED):
 *   worker-proxy.js handleTelegramWebhook gated ALL secret validation on
 *   `if (env.TELEGRAM_WEBHOOK_SECRET)` — when the secret is UNSET or EMPTY
 *   (accidental removal, fresh environment, deploy misconfiguration) the
 *   validation block is skipped entirely (fail-open). Any unauthenticated
 *   POST /telegram (or POST / — the root path routes to the same handler,
 *   worker-proxy.js route dispatch) then reached the handler: spoofed /start
 *   processing (sendTelegramMessage to arbitrary chats, pending_ref KV
 *   writes poisoning referral attribution) and membership API quota abuse —
 *   none rate-limited on this path. The misconfiguration is SILENT: no
 *   endpoint or log asserts the secret exists in production.
 *
 *   Live production probes (Phase 7) showed the deployed secret IS set
 *   (403 on all probes) — the vulnerability is latent in code, not active
 *   in the current deployment.
 *
 * FIX UNDER TEST (Phase 8, minimal):
 *   An `else if (!isDevMode(env))` branch now REJECTS with 403
 *   "Webhook secret not configured" when the secret is unset/empty in ANY
 *   non-development environment (production, staging, or APP_ENV missing
 *   entirely — the safe default). APP_ENV=development (local `wrangler dev`)
 *   keeps the permissive behavior so webhook testing works without a secret.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   Behavioral tests drive the REAL worker module — the exact ESM→CJS
 *   loadWorker harness used by security-batch2-staging-auth-test.cjs /
 *   worker-proxy.test.cjs — so the REAL route dispatch (POST /telegram AND
 *   POST /), the REAL validation gate, the REAL timingSafeEqualSecret and
 *   the REAL isDevMode all execute. globalThis.fetch is stubbed and its
 *   call count asserted to be ZERO for every rejected request (rejection
 *   happens before ANY Telegram API side effect).
 *
 *   Pre-fix (baseline 5718d6b9): SEC03-WH-04/05/06/07/09 FAIL (unset/empty
 *   secret in non-dev environments returned 200 — the fail-open).
 *   Post-fix: all PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');

// ── loadWorker harness (same ESM→CJS transform as the security-batch2 suite) ──
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

function createEnv(o = {}) {
  return Object.assign({
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
}

// Stub global fetch for the whole file — behavioral tests must not hit the
// network, and the call count doubles as the "no side effects" oracle.
let outboundFetchCalls = 0;
globalThis.fetch = async () => { outboundFetchCalls++; return new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } }); };

const SECRET = 'unit-test-webhook-secret-0123456789abcdef';
const SECRET_HEADER = { 'X-Telegram-Bot-Api-Secret-Token': SECRET };

/** Send a POST with an EMPTY Telegram update ({}) — zero handler side effects. */
async function postUpdate(worker, env, urlPath, headers) {
  const url = urlPath.startsWith('http') ? urlPath : `http://localhost${urlPath}`;
  const h = new Headers(headers || {});
  const body = '{}';
  h.set('Content-Type', 'application/json');
  h.set('Content-Length', String(Buffer.byteLength(body)));
  const res = await worker.fetch(new Request(url, { method: 'POST', headers: h, body }), env, {});
  let parsed = null;
  try { parsed = await res.json(); } catch { /* 200 responses have an empty body */ }
  return { status: res.status, body: parsed };
}

// ═══════════════════════════════════════════════════════════════════════════
// A. Configured-secret behavior (S-02 contract — must NOT be weakened by SEC-03)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC03-WH-01: configured secret + MISSING header -> 403 Missing (S-02 contract preserved)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  const r = await postUpdate(worker, createEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, APP_ENV: 'production' }), '/telegram', {});
  assert.equal(r.status, 403, 'missing header with configured secret must be rejected');
  assert.equal(r.body && r.body.detail, 'Missing webhook secret token');
  assert.equal(outboundFetchCalls, 0, 'rejection must happen before ANY Telegram API call');
});

test('SEC03-WH-02: configured secret + WRONG header (same length) -> 403 Invalid (timing-safe path)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  // Same-length wrong token exercises the timingSafeEqualSecret comparison
  // without a length shortcut (HMAC-based constant-time comparison).
  const wrong = SECRET.slice(0, -1) + 'X';
  assert.equal(wrong.length, SECRET.length);
  const r = await postUpdate(worker, createEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, APP_ENV: 'production' }), '/telegram', { 'X-Telegram-Bot-Api-Secret-Token': wrong });
  assert.equal(r.status, 403, 'wrong header with configured secret must be rejected');
  assert.equal(r.body && r.body.detail, 'Invalid webhook secret token');
  assert.equal(outboundFetchCalls, 0);
});

test('SEC03-WH-03: configured secret + CORRECT header -> 200 (valid Telegram update processed)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  // Empty update {}: handler accepts, finds no callback_query and no /start
  // message, and returns the silent 200 Telegram expects. No API calls fire.
  const r = await postUpdate(worker, createEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, APP_ENV: 'production' }), '/telegram', SECRET_HEADER);
  assert.equal(r.status, 200, 'correct secret must let the update through');
  assert.equal(outboundFetchCalls, 0, 'empty update produces no Telegram API side effects');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. THE SEC-03 FIX — unset/empty secret in non-development environments
// ═══════════════════════════════════════════════════════════════════════════

test('SEC03-WH-04: UNSET secret + production -> 403 Webhook secret not configured (THE fix)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  const env = createEnv({ APP_ENV: 'production' });
  delete env.TELEGRAM_WEBHOOK_SECRET; // unset — not merely empty
  const r = await postUpdate(worker, env, '/telegram', {});
  assert.equal(r.status, 403, 'unset secret in production must fail CLOSED (was 200 pre-fix)');
  assert.equal(r.body && r.body.detail, 'Webhook secret not configured');
  assert.equal(outboundFetchCalls, 0, 'unauthenticated request must never start processing');
});

test('SEC03-WH-05: EMPTY-STRING secret + production -> 403 (empty counts as unset)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  const r = await postUpdate(worker, createEnv({ TELEGRAM_WEBHOOK_SECRET: '', APP_ENV: 'production' }), '/telegram', {});
  assert.equal(r.status, 403, 'empty-string secret must fail closed, not disable validation');
  assert.equal(r.body && r.body.detail, 'Webhook secret not configured');
  assert.equal(outboundFetchCalls, 0);
});

test('SEC03-WH-06: UNSET secret + staging -> 403 (staging is a non-development environment)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  const env = createEnv({ APP_ENV: 'staging' });
  delete env.TELEGRAM_WEBHOOK_SECRET;
  const r = await postUpdate(worker, env, '/telegram', {});
  assert.equal(r.status, 403, 'unset secret in staging must fail closed');
  assert.equal(r.body && r.body.detail, 'Webhook secret not configured');
  assert.equal(outboundFetchCalls, 0);
});

test('SEC03-WH-07: UNSET secret + APP_ENV missing entirely -> 403 (safe default)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  // APP_ENV absent (misconfigured deploy) must NOT silently become dev mode.
  const env = createEnv({ APP_ENV: undefined });
  delete env.TELEGRAM_WEBHOOK_SECRET;
  const r = await postUpdate(worker, env, '/telegram', {});
  assert.equal(r.status, 403, 'missing APP_ENV defaults to non-dev -> fail closed');
  assert.equal(r.body && r.body.detail, 'Webhook secret not configured');
  assert.equal(outboundFetchCalls, 0);
});

test('SEC03-WH-08: UNSET secret + development -> 200 (local dev behavior PRESERVED)', async () => {
  const worker = loadWorker();
  outboundFetchCalls = 0;
  const env = createEnv({ APP_ENV: 'development' });
  delete env.TELEGRAM_WEBHOOK_SECRET;
  // The explicit carve-out: `wrangler dev` (APP_ENV=development via
  // wrangler.jsonc top-level vars) must keep working without a secret so
  // local webhook testing is unaffected by the fix.
  const r = await postUpdate(worker, env, '/telegram', {});
  assert.equal(r.status, 200, 'development without secret must keep the permissive behavior');
});

// ═══════════════════════════════════════════════════════════════════════════
// C. Route parity — POST /telegram AND POST / (both dispatch to the webhook)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC03-WH-09: BOTH routes (/telegram and /) behave identically for every secret state', async () => {
  const worker = loadWorker();

  // (a) unset secret in production: BOTH paths must fail closed.
  const prodNoSecret = createEnv({ APP_ENV: 'production' });
  delete prodNoSecret.TELEGRAM_WEBHOOK_SECRET;
  for (const p of ['/telegram', '/']) {
    outboundFetchCalls = 0;
    const r = await postUpdate(worker, prodNoSecret, p, {});
    assert.equal(r.status, 403, `POST ${p} with unset secret in production must 403`);
    assert.equal(r.body && r.body.detail, 'Webhook secret not configured', `POST ${p} detail`);
    assert.equal(outboundFetchCalls, 0, `POST ${p} rejection precedes any side effect`);
  }

  // (b) valid secret + header: BOTH paths accept.
  for (const p of ['/telegram', '/']) {
    const r = await postUpdate(worker, createEnv({ TELEGRAM_WEBHOOK_SECRET: SECRET, APP_ENV: 'production' }), p, SECRET_HEADER);
    assert.equal(r.status, 200, `POST ${p} with correct secret must pass`);
  }

  // (c) development without secret: BOTH paths stay permissive.
  const devEnv = createEnv({ APP_ENV: 'development' });
  delete devEnv.TELEGRAM_WEBHOOK_SECRET;
  for (const p of ['/telegram', '/']) {
    const r = await postUpdate(worker, devEnv, p, {});
    assert.equal(r.status, 200, `POST ${p} in development without secret must stay permissive`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// D. Source-level locks (guard shape + dispatch wiring, refactor-resistant)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC03-WH-10: source lock — fail-closed guard gated on isDevMode + both-route dispatch intact', () => {
  const src = fs.readFileSync(WORKER_PATH, 'utf8');

  // (a) The validation region must contain the fail-closed else-branch gated
  //     on isDevMode (NOT on a string compare that could drift with wrangler vars).
  const valStart = src.indexOf('async function handleTelegramWebhook');
  const valEnd = src.indexOf('let messageContext = null;', valStart);
  assert.ok(valStart !== -1 && valEnd !== -1, 'webhook handler must be found');
  const guard = src.slice(valStart, valEnd);
  assert.ok(guard.includes('else if (!isDevMode(env))'),
    'unset-secret branch must be gated on isDevMode(env) — the same dev-mode predicate used across the worker');
  assert.ok(guard.includes("'Webhook secret not configured'"),
    'unset-secret rejection detail must stay stable (tests + ops greppability)');

  // (b) The route dispatch must keep sending BOTH POST /telegram and POST /
  //     to handleTelegramWebhook — the fix must protect both entry points.
  assert.ok(/request\.method === 'POST' && \(url\.pathname === '\/telegram' \|\| url\.pathname === '\/'\)/.test(src)
    || src.includes("request.method === 'POST' && (url.pathname === '/telegram' || url.pathname === '/')"),
    'route dispatch must keep routing POST /telegram AND POST / to the webhook handler');

  // (c) GET must NOT reach the webhook (dispatch is POST-only — locks the
  //     accidental-broadening direction too).
  const dispatch = src.slice(src.indexOf('url.pathname === \'/telegram\'') - 200, src.indexOf('url.pathname === \'/telegram\'') + 200);
  assert.ok(dispatch.includes("request.method === 'POST'"), 'webhook dispatch must remain POST-only');
});

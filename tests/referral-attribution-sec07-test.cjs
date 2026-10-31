/**
 * REFERRAL ATTRIBUTION FAIL-CLOSED REGRESSION TEST — SEC-07 (Phase 20)
 * =====================================================================
 *
 * FINDING (Phase 19 final audit, re-verified in Phase 20 scope at 698b3c71):
 *   src/controllers/users.js handleBootstrap seeded the referral referrer
 *   from the UNSIGNED request body:
 *     let signedReferrerId = normalizeOptionalString(payload.referrer_id);
 *     if (auth?.startParam ...) { signed value only OVERRIDES it }
 *   When the signed start_param was absent or non-ref (organic launch,
 *   analysis deep links), the unsigned body value was trusted as the
 *   referrer. Any client could attribute its registration to an arbitrary
 *   Telegram ID (referral-reward farming: register alt accounts with
 *   referrer_id = main account).
 *
 * FIX UNDER TEST:
 *   The referrer is accepted ONLY from the SIGNED start_param inside the
 *   HMAC-validated initData. The body value is honored ONLY in development
 *   mode (isDevMode) for local testing (same fail-closed idiom as
 *   SEC-03/SEC-04/SEC-05). Legitimate referral flows are preserved:
 *   Mini App ref deep links carry start_param INSIDE the signed initData,
 *   and the bot /start path re-attaches startapp=ref_<id> to the WebApp
 *   button URL (worker-proxy.js pending_ref flow) — both arrive signed.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   Behavioral tests drive the REAL worker (loadWorker harness) through
 *   POST /api/users/bootstrap with a RECORDING DB pool mock: every
 *   (sql, params) pair is captured, and canned rows are dispatched per
 *   query shape. The security assertion is on the recorded traffic:
 *     * `INSERT INTO referrals (inviter_id, ...)` params[0] must be the
 *       SIGNED referrer (888), never the tampered body value (999).
 *     * With no signed start_param, NO referral insert may occur at all.
 *
 *   Pre-fix (baseline 698b3c71): B2/B3/B4 FAIL (body-only referrer
 *   produced INSERT INTO referrals with the attacker-chosen id).
 *   Post-fix: all tests PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const USERS_CTRL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'users.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// initData builder (auth_date always present — SEC-05 contract) with an
// optional SIGNED start_param.
// ═══════════════════════════════════════════════════════════════════════════
function buildSignedInitData(botToken, user, options = {}) {
  const entries = [
    ['auth_date', String(Math.floor(Date.now() / 1000))],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
  ];
  if (options.startParam !== undefined) {
    entries.push(['start_param', String(options.startParam)]);
  }
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

// ── loadWorker harness with a RECORDING Neon pool mock ──
function loadWorker(recordingPoolClass) {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');
  const defaultMocks = {
    'pg': { Pool: class { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } } },
    '@neondatabase/serverless': recordingPoolClass,
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

/**
 * Recording Neon Pool mock.
 * Dispatches canned rows per SQL shape and records every (sql, params).
 *  - opts.existingReferral: row returned for `FROM referrals WHERE invitee_id`
 *    (simulates a prior attribution — first-inviter-wins path).
 *  - Inviter existence: `SELECT telegram_id FROM users WHERE telegram_id = $1`
 *    returns a row for ANY probed id (so attribution differences are purely
 *    a function of WHICH id the server chose to probe/insert).
 */
function createRecordingPoolClass(opts = {}) {
  const queries = [];
  const dispatch = async (sql, params) => {
    const s = String(sql || '');
    const low = s.toLowerCase();
    // Referral INSERT — the security-critical write.
    if (low.includes('insert into referrals')) {
      return { rows: [{ id: 'ref-new-1', rewarded: false }], rowCount: 1 };
    }
    // Existing-referral check (first inviter wins).
    if (low.includes('from referrals') && low.includes('where invitee_id')) {
      return { rows: opts.existingReferral ? [opts.existingReferral] : [] };
    }
    // Inviter existence probe — record which ids the server probed.
    if (low.includes('select telegram_id from users where telegram_id')) {
      return { rows: [{ telegram_id: String(params && params[0]) }] };
    }
    // User bootstrap insert.
    if (low.includes('insert into users')) {
      return { rows: [{ telegram_id: String(params && params[0]), channel_joined: false, username: 'u', lang: 'fa' }] };
    }
    return { rows: [], rowCount: 0 };
  };
  class RecordingPool {
    constructor(cfg) { this._cfg = cfg; }
    async query(sql, params) { queries.push({ sql: String(sql || ''), params: params ? params.slice() : [] }); return dispatch(sql, params); }
    async connect() { const self = this; return { async query(sql, params) { return self.query(sql, params); }, release() {} }; }
    end() { return Promise.resolve(); }
  }
  return {
    Pool: RecordingPool,
    queries,
    // neon() HTTP fallback stub — never expected on these paths (DATABASE_URL
    // is set so createPool returns the RecordingPool), kept for harness parity.
    neon: function () { const f = async () => []; f.query = async () => ({ rows: [] }); f.transaction = async (cb) => cb({ query: f.query }); return f; },
  };
}

function createEnv(o = {}) {
  const env = Object.assign({
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: 'postgres://mock',
    APP_ENV: 'production',
    REFERRAL_SECRET_SALT: 'sec07-test-referral-secret-salt-64chars-configured',
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

// Stub global fetch (Telegram getChatMember etc.) — must not hit the network.
globalThis.fetch = async () => new Response(JSON.stringify({ ok: true, result: {} }), { status: 200, headers: { 'content-type': 'application/json' } });

const INVITEE = { id: 555001, first_name: 'Invitee', username: 'invitee_user' };

/** POST /api/users/bootstrap; returns { status, body, queries }. */
async function bootstrap(worker, env, { initData, body, urlQuery }) {
  const headers = new Headers({ 'User-Agent': 'sec07-regression-test' });
  if (initData) headers.set('X-Telegram-Init-Data', initData);
  if (body !== undefined) {
    headers.set('Content-Type', 'application/json');
  }
  const url = 'http://localhost/api/users/bootstrap' + (urlQuery || '');
  const reqOpts = { method: 'POST', headers };
  if (body !== undefined) reqOpts.body = JSON.stringify(body);
  const res = await worker.fetch(new Request(url, reqOpts), env, {});
  let parsed = null;
  try { parsed = await res.json(); } catch { /* non-JSON body */ }
  return { status: res.status, body: parsed };
}

const referralInserts = (queries) => queries.filter(q => /insert into referrals/i.test(q.sql));
const inviterProbes = (queries) => queries
  .filter(q => /select telegram_id from users where telegram_id/i.test(q.sql))
  .map(q => String(q.params[0]));

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Behavioral matrix through the REAL worker bootstrap route
// ═══════════════════════════════════════════════════════════════════════════

test('SEC07-B1: production, signed start_param=ref_888 + TAMPERED body referrer_id=999 → referral attributed to 888 only', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE, { startParam: 'ref_888' });
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id), username: 'invitee_user', referrer_id: '999' },
  });
  assert.equal(r.status, 200, 'bootstrap must succeed (referral flow intact)');
  const inserts = referralInserts(rec.queries);
  assert.equal(inserts.length, 1, 'exactly one referral insert for a signed referrer');
  assert.equal(String(inserts[0].params[0]), '888', 'inviter_id must be the SIGNED referrer (888), not the body value (999)');
  assert.deepEqual(inviterProbes(rec.queries), ['888'], 'only the signed referrer id may be probed');
});

test('SEC07-B2: production, NO start_param + body referrer_id=999 → NO referral created (THE fix)', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE); // no start_param
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id), username: 'invitee_user', referrer_id: '999' },
  });
  assert.equal(r.status, 200, 'bootstrap itself must still succeed');
  assert.equal(referralInserts(rec.queries).length, 0,
    'an unsigned body referrer_id must NOT create a referral in production');
  assert.equal(inviterProbes(rec.queries).length, 0,
    'the inviter existence probe must not even run for a body-only referrer');
});

test('SEC07-B3: staging, NO start_param + body referrer_id=999 → NO referral created', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE);
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'staging' }), {
    initData,
    body: { user_id: String(INVITEE.id), referrer_id: '999' },
  });
  assert.equal(r.status, 200);
  assert.equal(referralInserts(rec.queries).length, 0, 'staging must behave like production (fail-closed)');
});

test('SEC07-B4: production, NON-ref start_param (analysis_123) + body referrer_id=888 → NO referral created', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE, { startParam: 'analysis_123' });
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id), referrer_id: '888' },
  });
  assert.equal(r.status, 200);
  assert.equal(referralInserts(rec.queries).length, 0,
    'a non-ref signed start_param must not combine with a body referrer to create a referral');
});

test('SEC07-B5: production, signed ref_777 + EMPTY body referrer_id → referral attributed to 777 (normal deep-link case)', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE, { startParam: 'ref_777' });
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id), referrer_id: '' },
  });
  assert.equal(r.status, 200);
  const inserts = referralInserts(rec.queries);
  assert.equal(inserts.length, 1, 'valid signed referral must be recorded');
  assert.equal(String(inserts[0].params[0]), '777');
});

test('SEC07-B6: production, signed ref_888 + NO referrer_id field in body at all → referral attributed to 888', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE, { startParam: 'ref_888' });
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id), username: 'invitee_user' },
  });
  assert.equal(r.status, 200);
  const inserts = referralInserts(rec.queries);
  assert.equal(inserts.length, 1);
  assert.equal(String(inserts[0].params[0]), '888');
});

test('SEC07-B7: development, NO initData + ?user_id= fallback + body referrer_id=888 → referral created (dev fallback preserved)', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'development' }), {
    urlQuery: `?user_id=${INVITEE.id}`,
    body: { user_id: String(INVITEE.id), referrer_id: '888' },
  });
  assert.equal(r.status, 200, 'dev-mode bootstrap must work without initData');
  const inserts = referralInserts(rec.queries);
  assert.equal(inserts.length, 1, 'dev mode must still accept body referrer_id for local testing');
  assert.equal(String(inserts[0].params[0]), '888');
});

test('SEC07-B8: development, body referrer_id with INVALID format (abc) → no referral insert (M-R4 numeric guard intact)', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'development' }), {
    urlQuery: `?user_id=${INVITEE.id}`,
    body: { user_id: String(INVITEE.id), referrer_id: 'abc' },
  });
  assert.equal(r.status, 200);
  assert.equal(referralInserts(rec.queries).length, 0, 'non-numeric referrer must never create a referral');
});

test('SEC07-B9: production, signed ref_888 but invitee ALREADY has a referral → no second insert (first-inviter-wins preserved)', async () => {
  const rec = createRecordingPoolClass({ existingReferral: { id: 'ref-early', inviter_id: '111', rewarded: false } });
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE, { startParam: 'ref_888' });
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id), referrer_id: '888' },
  });
  assert.equal(r.status, 200);
  assert.equal(referralInserts(rec.queries).length, 0,
    'an existing referral must not be replaced or duplicated (first inviter wins)');
});

test('SEC07-B10: production, signed SELF-referral (ref_<own id>) → no referral insert (self-referral guard intact)', async () => {
  const rec = createRecordingPoolClass();
  const worker = loadWorker(rec);
  const initData = buildSignedInitData('test-bot-token', INVITEE, { startParam: `ref_${INVITEE.id}` });
  const r = await bootstrap(worker, createEnv({ APP_ENV: 'production' }), {
    initData,
    body: { user_id: String(INVITEE.id) },
  });
  assert.equal(r.status, 200);
  assert.equal(referralInserts(rec.queries).length, 0, 'self-referral must be rejected downstream (M-R4)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Source locks
// ═══════════════════════════════════════════════════════════════════════════

test('SEC07-S1: users.js carries the SEC-07 FIX marker', () => {
  assert.ok(USERS_CTRL_SRC.includes('SEC-07 FIX'),
    'src/controllers/users.js must carry the SEC-07 FIX marker');
});

test('SEC07-S2: the unconditional body-referrer seed is gone (fail-open removed)', () => {
  assert.ok(
    !USERS_CTRL_SRC.includes('let signedReferrerId = normalizeOptionalString(payload.referrer_id);'),
    'the pre-fix unconditional `signedReferrerId = normalizeOptionalString(payload.referrer_id)` line must not remain');
});

test('SEC07-S3: the body fallback is dev-gated (isDevMode)', () => {
  assert.ok(
    USERS_CTRL_SRC.includes('if (!signedReferrerId && isDevMode(env))'),
    'the body referrer fallback must be gated on isDevMode(env)');
});

test('SEC07-S4: signed start_param remains the primary source (^ref_(\\d+)$ contract)', () => {
  assert.ok(
    USERS_CTRL_SRC.includes("auth.startParam.match(/^ref_(\\d+)$/)") ||
    USERS_CTRL_SRC.includes('auth.startParam.match(/^ref_(\\d+)$/)'),
    'the signed start_param ref_ extraction contract must be preserved');
});

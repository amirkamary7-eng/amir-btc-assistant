/**
 * EXCHANGE CAMPAIGNS — STAGE 5B API CONTRACT REGRESSION TEST
 * =============================================================
 * Locks the user-facing campaigns backend contract:
 *
 *   1. Migration integrity: promo_campaigns + promo_campaign_registrations
 *      DDL is idempotent, has the UNIQUE (campaign_id, telegram_id)
 *      constraint, FKs without CASCADE, status CHECK, partial visibility
 *      index, updated_at trigger — and does NOT touch the reward_center
 *      `campaigns` table or the legacy `exchange_campaigns` table.
 *   2. Repository behavior (mocked queryDb): atomic registration SQL shape,
 *      idempotent ON CONFLICT DO NOTHING + RETURNING mapping, dev/prod
 *      ensureSchema guards, ISO timestamp normalization.
 *   3. Controller behavior (mocked deps): full register matrix —
 *      401 / 400 / 429 / 404 (DRAFT/DELETED/missing) / 409 (not-started,
 *      ended, stopped, state-changed) / 200 (inserted vs already_registered),
 *      server-side UTC effective status, telegram id taken ONLY from
 *      validated initData.
 *   4. Route wiring: the three /api/campaigns* matchers + PROTECTED_PATHS
 *      gate in worker-proxy.js.
 *   5. i18n parity: the new cmp_register_* keys exist in fa AND en.
 *
 * All tests are offline: no DB, no network, no Worker invocation.
 *
 * Run: node --test tests/campaigns-api-contract-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const MIGRATE = read('scripts/00-migrate.sql');
const REPO_SRC = read('src/repositories/campaigns.js');
const CTRL_SRC = read('src/controllers/campaigns.js');
const WORKER = read('worker-proxy.js');
const FRONTEND = read('campaigns.js');
const REWARD_CENTER = read('src/repositories/reward_center.js');
const I18N_SRC = read('i18n.js');

// ── Module loader (ESM factory files are bundled by wrangler in prod;
//    tests strip the single `export ` prefix and evaluate the factory) ───────

function loadFactory(filePath, factoryName) {
  const src = read(filePath);
  assert.match(src, new RegExp(`export function ${factoryName}\\b`),
    `${filePath} must export ${factoryName}`);
  const stripped = src.replace(/^export\s+/m, '');
  const mod = {};
  new Function('module', stripped + `\nmodule.exports = ${factoryName};`)(mod);
  return mod.exports;
}

const createCampaignsRepository = loadFactory('src/repositories/campaigns.js', 'createCampaignsRepository');
const createCampaignsHandlers = loadFactory('src/controllers/campaigns.js', 'createCampaignsHandlers');

// Parse + import-resolution check via esbuild (the same parser/bundler the
// build pipeline uses — node --check cannot parse ESM .js under type:commonjs).
test('CAM-00: repo + controller + worker all parse and their imports resolve (esbuild)', () => {
  const esbuild = require('esbuild');
  for (const f of ['src/repositories/campaigns.js', 'src/controllers/campaigns.js', 'worker-proxy.js']) {
    esbuild.transformSync(read(f), { loader: 'js', format: 'esm' });
  }
  // Full bundle of the worker entry: proves createCampaignsRepository /
  // createCampaignsHandlers imports resolve and exports exist.
  esbuild.buildSync({
    entryPoints: [path.join(ROOT, 'worker-proxy.js')],
    bundle: true,
    format: 'esm',
    platform: 'node',
    external: ['node:*', '@neondatabase/serverless', 'pg'],
    write: false,
    logLevel: 'silent',
  });
});

// ═══════════════════════════════════════════════════════════════════════════
// 1. MIGRATION INTEGRITY
// ═══════════════════════════════════════════════════════════════════════════

test('CAM-01: promo_campaigns DDL — idempotent, CHECK status, timestamps, uuid PK', () => {
  assert.match(MIGRATE, /CREATE TABLE IF NOT EXISTS promo_campaigns \(/);
  assert.match(MIGRATE, /id\s+TEXT PRIMARY KEY DEFAULT gen_random_uuid\(\)::text/);
  assert.match(MIGRATE, /starts_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(MIGRATE, /ends_at\s+TIMESTAMPTZ,/);
  assert.match(MIGRATE, /CHECK \(status IN \('DRAFT', 'PUBLISHED', 'STOPPED', 'DELETED'\)\)/);
  assert.match(MIGRATE, /created_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  assert.match(MIGRATE, /updated_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
});

test('CAM-02: registrations DDL — UNIQUE(campaign_id, telegram_id), FKs without CASCADE, history-preserving', () => {
  assert.match(MIGRATE, /CREATE TABLE IF NOT EXISTS promo_campaign_registrations \(/);
  assert.match(MIGRATE, /UNIQUE \(campaign_id, telegram_id\)/);
  assert.match(MIGRATE, /campaign_id\s+TEXT NOT NULL REFERENCES promo_campaigns\(id\)/);
  assert.match(MIGRATE, /telegram_id\s+VARCHAR\(64\) NOT NULL REFERENCES users\(telegram_id\)/);
  assert.match(MIGRATE, /registered_at\s+TIMESTAMPTZ NOT NULL DEFAULT NOW\(\)/);
  // No CASCADE on either FK: soft-delete keeps history, hard-delete is blocked.
  const regBlock = MIGRATE.slice(
    MIGRATE.indexOf('CREATE TABLE IF NOT EXISTS promo_campaign_registrations'),
    MIGRATE.indexOf('CREATE TABLE IF NOT EXISTS promo_campaign_registrations') + 700,
  );
  assert.doesNotMatch(regBlock, /ON DELETE CASCADE/i, 'registrations must NOT cascade-delete');
});

test('CAM-03: visibility index is partial (PUBLISHED/STOPPED only) + per-user index + updated_at trigger', () => {
  assert.match(MIGRATE, /CREATE INDEX IF NOT EXISTS idx_promo_campaigns_list\s+ON promo_campaigns \(starts_at DESC\) WHERE status IN \('PUBLISHED', 'STOPPED'\)/);
  assert.match(MIGRATE, /CREATE INDEX IF NOT EXISTS idx_pcr_user ON promo_campaign_registrations \(telegram_id\)/);
  assert.match(MIGRATE, /DROP TRIGGER IF EXISTS trg_promo_campaigns_updated ON promo_campaigns;/);
  assert.match(MIGRATE, /CREATE TRIGGER trg_promo_campaigns_updated BEFORE UPDATE ON promo_campaigns/);
});

test('CAM-04: existing campaign tables untouched (reward_center `campaigns` + legacy `exchange_campaigns`)', () => {
  // Exactly one definition each — unchanged count.
  assert.equal((MIGRATE.match(/CREATE TABLE IF NOT EXISTS campaigns \(/g) || []).length, 1);
  assert.equal((MIGRATE.match(/CREATE TABLE IF NOT EXISTS exchange_campaigns \(/g) || []).length, 1);
  assert.equal((MIGRATE.match(/CREATE TABLE IF NOT EXISTS promo_campaigns \(/g) || []).length, 1);
  assert.equal((MIGRATE.match(/CREATE TABLE IF NOT EXISTS promo_campaign_registrations \(/g) || []).length, 1);
  // No destructive or structural statements against the two existing tables.
  // (Substring-safe: "promo_campaigns" never contains " campaigns"/"_campaigns" forms below.)
  assert.ok(!MIGRATE.includes('DROP TABLE campaigns'), 'no DROP on reward_center campaigns');
  assert.ok(!MIGRATE.includes('DROP TABLE exchange_campaigns'), 'no DROP on exchange_campaigns');
  assert.ok(!MIGRATE.includes('ALTER TABLE campaigns '), 'no ALTER on reward_center campaigns');
  assert.ok(!MIGRATE.includes('ALTER TABLE exchange_campaigns '), 'no ALTER on exchange_campaigns');
  // reward_center module does not reference the new tables (unchanged module).
  assert.ok(!REWARD_CENTER.includes('promo_campaign'), 'reward_center must stay on `campaigns` only');
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. REPOSITORY BEHAVIOR (mocked queryDb)
// ═══════════════════════════════════════════════════════════════════════════

function buildRepo(queryDbImpl) {
  return createCampaignsRepository({
    queryDb: queryDbImpl,
    isDatabaseConfigured: (env) => Boolean(env && env.DATABASE_URL),
  });
}

test('CAM-10: ensureSchema skips runtime DDL in production (PROD-DDL-SKIP)', async () => {
  const queries = [];
  const repo = buildRepo(async (env, sql) => { queries.push(sql); return { rows: [] }; });
  await repo.ensureSchema({ APP_ENV: 'production', DATABASE_URL: 'postgres://x' });
  assert.equal(queries.length, 0, 'production must not run runtime DDL');
});

test('CAM-11: ensureSchema is a no-op when the DB is not configured', async () => {
  const queries = [];
  const repo = buildRepo(async (env, sql) => { queries.push(sql); return { rows: [] }; });
  await repo.ensureSchema({ APP_ENV: 'development' }); // no DATABASE_URL
  assert.equal(queries.length, 0);
});

test('CAM-12: ensureSchema succeeds once then caches (flag set only on success)', async () => {
  let calls = 0;
  const repo = buildRepo(async () => { calls += 1; return { rows: [] }; });
  await repo.ensureSchema({ APP_ENV: 'development', DATABASE_URL: 'postgres://x' });
  await repo.ensureSchema({ APP_ENV: 'development', DATABASE_URL: 'postgres://x' });
  assert.equal(calls, 1, 'second call must be cached (_schemaVerified)');
  // Failure path: flag must NOT be set → next call retries.
  let fail = true;
  const repo2 = buildRepo(async () => { if (fail) throw new Error('ddl down'); return { rows: [] }; });
  await assert.rejects(() => repo2.ensureSchema({ APP_ENV: 'development', DATABASE_URL: 'postgres://x' }));
  fail = false;
  await repo2.ensureSchema({ APP_ENV: 'development', DATABASE_URL: 'postgres://x' }); // retries, succeeds
});

test('CAM-13: registerUser — atomic INSERT…SELECT…WHERE EXISTS…ON CONFLICT DO NOTHING…RETURNING', async () => {
  let captured = null;
  const repo = buildRepo(async (env, sql, params) => {
    captured = { sql, params };
    return { rows: [{ id: 42, registered_at: new Date('2026-02-01T10:00:00Z') }] };
  });
  const res = await repo.registerUser({ DATABASE_URL: 'x' }, 'camp-1', '111');
  assert.equal(res.inserted, true);
  assert.equal(res.row.id, 42);
  assert.equal(res.row.registered_at, '2026-02-01T10:00:00.000Z', 'Date → ISO');
  // SQL shape — the concurrency contract.
  assert.match(captured.sql, /INSERT INTO promo_campaign_registrations \(campaign_id, telegram_id\)/);
  assert.match(captured.sql, /WHERE EXISTS \(/);
  assert.match(captured.sql, /c\.status = 'PUBLISHED'/);
  assert.match(captured.sql, /c\.starts_at <= NOW\(\)/);
  assert.match(captured.sql, /\(c\.ends_at IS NULL OR c\.ends_at > NOW\(\)\)/);
  assert.match(captured.sql, /ON CONFLICT \(campaign_id, telegram_id\) DO NOTHING/);
  assert.match(captured.sql, /RETURNING id, registered_at/);
  assert.deepEqual(captured.params, ['camp-1', '111']);
});

test('CAM-14: registerUser no-op (0 rows) maps to inserted:false', async () => {
  const repo = buildRepo(async () => ({ rows: [] }));
  const res = await repo.registerUser({ DATABASE_URL: 'x' }, 'camp-1', '111');
  assert.equal(res.inserted, false);
  assert.equal(res.row, null);
});

test('CAM-15: listVisibleCampaigns — visible-status filter, per-user join, row mapping', async () => {
  let captured = null;
  const repo = buildRepo(async (env, sql, params) => {
    captured = { sql, params };
    return {
      rows: [{
        id: 'camp-2', title_fa: 'عنوان', title_en: 'Title', summary_fa: 's', summary_en: 's',
        body_fa: 'b', body_en: 'b', image_url: null,
        starts_at: new Date('2026-01-01T00:00:00Z'), ends_at: null,
        status: 'PUBLISHED', registered: true, registered_at: new Date('2026-02-02T00:00:00Z'),
      }],
    };
  });
  const list = await repo.listVisibleCampaigns({ DATABASE_URL: 'x' }, '222');
  assert.equal(list.length, 1);
  assert.equal(list[0].id, 'camp-2');
  assert.equal(list[0].starts_at, '2026-01-01T00:00:00.000Z');
  assert.equal(list[0].registered, true);
  assert.equal(list[0].registered_at, '2026-02-02T00:00:00.000Z');
  assert.match(captured.sql, /LEFT JOIN promo_campaign_registrations r/);
  assert.match(captured.sql, /r\.telegram_id = \$1/);
  assert.match(captured.sql, /c\.status IN \('PUBLISHED', 'STOPPED'\)/);
  assert.match(captured.sql, /ORDER BY c\.starts_at DESC/);
  assert.deepEqual(captured.params, ['222', 50]);
  // ISO-string inputs (neon HTTP driver) pass through unchanged.
  const repo2 = buildRepo(async () => ({
    rows: [{ id: 'c', title_fa: '', title_en: '', status: 'STOPPED', registered: false, starts_at: '2026-03-03T00:00:00Z', ends_at: null }],
  }));
  const list2 = await repo2.listVisibleCampaigns({ DATABASE_URL: 'x' }, '222');
  assert.equal(list2[0].starts_at, '2026-03-03T00:00:00Z');
});

test('CAM-16: repository never reads/writes reward_center `campaigns` or legacy `exchange_campaigns`', () => {
  assert.doesNotMatch(REPO_SRC, /\bFROM campaigns\b/);
  assert.doesNotMatch(REPO_SRC, /\bINTO campaigns\b/);
  assert.doesNotMatch(REPO_SRC, /\bFROM exchange_campaigns\b/);
  assert.doesNotMatch(REPO_SRC, /\bINTO exchange_campaigns\b/);
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. CONTROLLER BEHAVIOR (mocked deps)
// ═══════════════════════════════════════════════════════════════════════════

function buildHandlers(config) {
  const {
    authUser = { id: '111' },
    authError = null,
    dbConfigured = true,
    rateLimited = false,
    repo: repoConfig = {},
  } = config;
  const calls = { order: [], queryLog: [] };

  const repo = {
    ensureSchema: async () => { calls.order.push('ensureSchema'); },
    listVisibleCampaigns: async (env, tgId) => {
      calls.order.push('list'); calls.queryLog.push(['list', tgId]);
      return repoConfig.list ? repoConfig.list(tgId) : [];
    },
    getVisibleCampaignById: async (env, id, tgId) => {
      calls.order.push('detail'); calls.queryLog.push(['detail', id, tgId]);
      return repoConfig.detail ? repoConfig.detail(id, tgId) : null;
    },
    registerUser: async (env, id, tgId) => {
      calls.order.push('register'); calls.queryLog.push(['register', id, tgId]);
      return repoConfig.register ? repoConfig.register(id, tgId) : { inserted: false, row: null };
    },
    isRegistered: async (env, id, tgId) => {
      calls.order.push('isRegistered');
      return repoConfig.isRegistered ? repoConfig.isRegistered(id, tgId) : null;
    },
    getCampaignForGate: async (env, id) => {
      calls.order.push('gate');
      return repoConfig.gate ? repoConfig.gate(id) : null;
    },
  };

  const handlers = createCampaignsHandlers({
    jsonResponse: (payload, init = {}) => ({ __json: payload, __status: init.status || 200 }),
    authenticateTelegramRequest: async () => (authError ? { error: authError, user: null } : { error: null, user: authUser }),
    safeDbErrorResponse: (error, options = {}) => ({ __json: { status: 'error', message: 'Database unavailable' }, __status: 503 }),
    safeError: (label, e) => `${label}: ${e && e.message}`,
    isDatabaseConfigured: () => dbConfigured,
    campaignsRepo: repo,
    isUserRateLimited: async (env, tgId, category, max, windowSeconds) => {
      calls.order.push('rateLimit');
      calls.queryLog.push(['rateLimit', tgId, category, max, windowSeconds]);
      return rateLimited;
    },
    ensureUserRow: async (env, tgId) => { calls.order.push('ensureUser'); calls.queryLog.push(['ensureUser', tgId]); },
  });

  return { handlers, calls };
}

const REQ = { url: 'https://x/api/campaigns', method: 'GET' };
const PAST = new Date(Date.now() - 86400000).toISOString();
const FUTURE = new Date(Date.now() + 86400000).toISOString();

test('CAM-20: handleList — 401 passthrough when initData is missing/invalid', async () => {
  const { handlers } = buildHandlers({ authError: { __json: { detail: 'Invalid Telegram init data' }, __status: 401 } });
  const res = await handlers.handleList(REQ, {});
  assert.equal(res.__status, 401);
});

test('CAM-21: handleList — 503 when DB is not configured (frontend falls back to labeled demo)', async () => {
  const { handlers } = buildHandlers({ dbConfigured: false });
  const res = await handlers.handleList(REQ, {});
  assert.equal(res.__status, 503);
  assert.equal(res.__json.status, 'error');
});

test('CAM-22: handleList — 200 shape with server-computed effective_status (UTC formula)', async () => {
  const { handlers, calls } = buildHandlers({
    repo: {
      list: () => [
        { id: 'a', title_fa: 'a', title_en: 'a', summary_fa: null, summary_en: null, body_fa: '', body_en: '', image_url: null, starts_at: PAST, ends_at: null, status: 'PUBLISHED', registered: false, registered_at: null },
        { id: 'b', title_fa: 'b', title_en: 'b', summary_fa: null, summary_en: null, body_fa: '', body_en: '', image_url: null, starts_at: FUTURE, ends_at: null, status: 'PUBLISHED', registered: false, registered_at: null },
        { id: 'c', title_fa: 'c', title_en: 'c', summary_fa: null, summary_en: null, body_fa: '', body_en: '', image_url: null, starts_at: PAST, ends_at: PAST, status: 'PUBLISHED', registered: true, registered_at: PAST },
        { id: 'd', title_fa: 'd', title_en: 'd', summary_fa: null, summary_en: null, body_fa: '', body_en: '', image_url: null, starts_at: FUTURE, ends_at: null, status: 'STOPPED', registered: false, registered_at: null },
      ],
    },
  });
  const res = await handlers.handleList(REQ, { DATABASE_URL: 'x' });
  assert.equal(res.__status, 200);
  assert.equal(res.__json.status, 'ok');
  assert.equal(res.__json.count, 4);
  assert.equal(res.__json.campaigns.length, 4);
  assert.deepEqual(
    res.__json.campaigns.map((c) => c.effective_status),
    ['ACTIVE', 'UPCOMING', 'ENDED', 'STOPPED'],
    'effective status formula: STOPPED > UPCOMING > ENDED > ACTIVE (same semantics as the frontend)',
  );
  assert.equal(res.__json.campaigns[2].registered, true, 'per-user registered flag passes through');
  // Telegram id used for the query comes from validated auth, nothing else.
  assert.deepEqual(calls.queryLog[0], ['list', '111']);
});

test('CAM-23: handleGetDetail — 400 malformed id, 404 missing/DRAFT/DELETED, 200 found', async () => {
  const { handlers } = buildHandlers({});
  const bad = await handlers.handleGetDetail(REQ, { DATABASE_URL: 'x' }, '../etc/passwd');
  assert.equal(bad.__status, 400);
  assert.equal(bad.__json.code, 'INVALID_CAMPAIGN_ID');

  const missing = await handlers.handleGetDetail(REQ, { DATABASE_URL: 'x' }, 'nope');
  assert.equal(missing.__status, 404);
  assert.equal(missing.__json.code, 'CAMPAIGN_NOT_FOUND');

  const { handlers: h2 } = buildHandlers({
    repo: { detail: () => ({ id: 'ok', title_fa: 't', title_en: 't', summary_fa: null, summary_en: null, body_fa: '', body_en: '', image_url: null, starts_at: PAST, ends_at: null, status: 'PUBLISHED', registered: false, registered_at: null }) },
  });
  const ok = await h2.handleGetDetail(REQ, { DATABASE_URL: 'x' }, 'ok');
  assert.equal(ok.__status, 200);
  assert.equal(ok.__json.campaign.id, 'ok');
  assert.equal(ok.__json.campaign.effective_status, 'ACTIVE');
});

test('CAM-24: handleRegister — 400 malformed id, 401 unauthenticated, 429 rate-limited before any DB write', async () => {
  const { handlers, calls } = buildHandlers({});
  const bad = await handlers.handleRegister(REQ, { DATABASE_URL: 'x' }, 'bad/id!!');
  assert.equal(bad.__status, 400);
  assert.equal(bad.__json.code, 'INVALID_CAMPAIGN_ID');

  const { handlers: h401 } = buildHandlers({ authError: { __json: { detail: 'x' }, __status: 401 } });
  assert.equal((await h401.handleRegister(REQ, { DATABASE_URL: 'x' }, 'ok')).__status, 401);

  const { handlers: h429, calls: c429 } = buildHandlers({ rateLimited: true });
  const rl = await h429.handleRegister(REQ, { DATABASE_URL: 'x' }, 'ok');
  assert.equal(rl.__status, 429);
  assert.equal(rl.__json.code, 'RATE_LIMITED');
  assert.ok(!c429.order.includes('ensureUser'), 'rate limit must fire before ensureUserRow');
  assert.ok(!c429.order.includes('register'), 'rate limit must fire before the registration insert');
  assert.deepEqual(c429.queryLog.find((q) => q[0] === 'rateLimit'), ['rateLimit', '111', 'campaign_register', 10, 60],
    'rate limit category/max/window as designed');
});

test('CAM-25: handleRegister — happy path: DB-confirmed insert → 200, success ONLY from RETURNING row', async () => {
  const { handlers, calls } = buildHandlers({
    repo: { register: () => ({ inserted: true, row: { id: 7, registered_at: '2026-02-03T00:00:00Z' } }) },
  });
  const res = await handlers.handleRegister(REQ, { DATABASE_URL: 'x' }, 'camp-9');
  assert.equal(res.__status, 200);
  assert.equal(res.__json.status, 'ok');
  assert.equal(res.__json.registered, true);
  assert.equal(res.__json.already_registered, false);
  assert.equal(res.__json.campaign_id, 'camp-9');
  assert.equal(res.__json.registered_at, '2026-02-03T00:00:00Z');
  // Order: rate-limit → ensureUser (FK safety) → insert.
  const seq = calls.order.filter((x) => ['rateLimit', 'ensureUser', 'register'].includes(x));
  assert.deepEqual(seq, ['rateLimit', 'ensureUser', 'register']);
  assert.deepEqual(calls.queryLog.find((q) => q[0] === 'register'), ['register', 'camp-9', '111'],
    'telegram id comes only from validated initData');
});

test('CAM-26: handleRegister — duplicate (no-op insert) disambiguated via isRegistered → already_registered', async () => {
  const { handlers } = buildHandlers({
    repo: {
      register: () => ({ inserted: false, row: null }),
      isRegistered: () => ({ id: 7, registered_at: '2026-02-04T00:00:00Z' }),
    },
  });
  const res = await handlers.handleRegister(REQ, { DATABASE_URL: 'x' }, 'camp-9');
  assert.equal(res.__status, 200);
  assert.equal(res.__json.registered, true);
  assert.equal(res.__json.already_registered, true);
  assert.equal(res.__json.registered_at, '2026-02-04T00:00:00Z');
});

test('CAM-27: handleRegister — invalid campaign states map to the exact contract codes', async () => {
  const cases = [
    { gate: null, status: 404, code: 'CAMPAIGN_NOT_FOUND' },
    { gate: { id: 'x', status: 'DRAFT', starts_at: PAST, ends_at: null }, status: 404, code: 'CAMPAIGN_NOT_FOUND' },
    { gate: { id: 'x', status: 'DELETED', starts_at: PAST, ends_at: null }, status: 404, code: 'CAMPAIGN_NOT_FOUND' },
    { gate: { id: 'x', status: 'STOPPED', starts_at: PAST, ends_at: null }, status: 409, code: 'CAMPAIGN_STOPPED' },
    { gate: { id: 'x', status: 'PUBLISHED', starts_at: FUTURE, ends_at: null }, status: 409, code: 'CAMPAIGN_NOT_STARTED' },
    { gate: { id: 'x', status: 'PUBLISHED', starts_at: PAST, ends_at: PAST }, status: 409, code: 'CAMPAIGN_ENDED' },
  ];
  for (const c of cases) {
    const { handlers } = buildHandlers({
      repo: {
        register: () => ({ inserted: false, row: null }),
        isRegistered: () => null,
        gate: () => c.gate,
      },
    });
    const res = await handlers.handleRegister(REQ, { DATABASE_URL: 'x' }, 'x');
    assert.equal(res.__status, c.status, `gate=${c.gate && c.gate.status} → HTTP ${c.status}`);
    assert.equal(res.__json.code, c.code);
    assert.equal(res.__json.status, 'error');
  }
});

test('CAM-28: handleRegister — publish-race retry path and terminal CAMPAIGN_STATE_CHANGED', async () => {
  // Retry path: first insert no-op (stale snapshot), gate valid, retry inserts.
  let attempts = 0;
  const { handlers } = buildHandlers({
    repo: {
      register: () => { attempts += 1; return attempts === 1 ? { inserted: false, row: null } : { inserted: true, row: { id: 9, registered_at: '2026-02-05T00:00:00Z' } }; },
      isRegistered: () => null,
      gate: () => ({ id: 'x', status: 'PUBLISHED', starts_at: PAST, ends_at: null }),
    },
  });
  const res = await handlers.handleRegister(REQ, { DATABASE_URL: 'x' }, 'x');
  assert.equal(res.__status, 200);
  assert.equal(res.__json.registered, true);
  assert.equal(res.__json.already_registered, false);
  assert.equal(attempts, 2, 'exactly one retry');

  // Terminal path: both attempts no-op, no existing row, gate valid → 409 retryable.
  const { handlers: h2 } = buildHandlers({
    repo: {
      register: () => ({ inserted: false, row: null }),
      isRegistered: () => null,
      gate: () => ({ id: 'x', status: 'PUBLISHED', starts_at: PAST, ends_at: null }),
    },
  });
  const res2 = await h2.handleRegister(REQ, { DATABASE_URL: 'x' }, 'x');
  assert.equal(res2.__status, 409);
  assert.equal(res2.__json.code, 'CAMPAIGN_STATE_CHANGED');
});

test('CAM-29: handleRegister — DB not configured → 503; never announces success', async () => {
  const { handlers } = buildHandlers({ dbConfigured: false });
  const res = await handlers.handleRegister(REQ, {}, 'x');
  assert.equal(res.__status, 503);
  assert.equal(res.__json.status, 'error');
});

test('CAM-30: controller never trusts client-supplied identity (no body parse, auth-only telegram id)', () => {
  assert.doesNotMatch(CTRL_SRC, /request\.json\(\)/, 'register is one-tap — no request body is parsed');
  assert.doesNotMatch(CTRL_SRC, /searchParams\.get\('(user_id|telegram_id)'\)/, 'no user id from query params');
  // Identity flows exclusively from the validated initData user object.
  assert.match(CTRL_SRC, /user: authState\.user/, 'auth helper returns ONLY the validated initData user');
  assert.match(CTRL_SRC, /listVisibleCampaigns\(env, user\.id\)/, 'list is keyed by the auth user id');
  assert.match(CTRL_SRC, /const telegramId = String\(user\.id\)/, 'register uses the auth user id only');
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. ROUTE WIRING (worker-proxy.js)
// ═══════════════════════════════════════════════════════════════════════════

test('CAM-40: worker wires the three user routes + PROTECTED_PATHS gate', () => {
  assert.match(WORKER, /import \{ createCampaignsRepository \} from '\.\/src\/repositories\/campaigns\.js';/);
  assert.match(WORKER, /import \{ createCampaignsHandlers \} from '\.\/src\/controllers\/campaigns\.js';/);
  // PROTECTED_PATHS now includes campaigns (initData + channel-membership gate).
  assert.match(WORKER, /PROTECTED_PATHS = \/\^\\\/api\\\/\(wallet\|tickets\|alerts\|campaigns\|/);
  // Route matchers.
  assert.match(WORKER, /url\.pathname === '\/api\/campaigns'/, 'GET list (exact)');
  assert.match(WORKER, /\/\^\\\/api\\\/campaigns\\\/\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(url\.pathname\)/, 'GET detail (anchored)');
  assert.match(WORKER, /\/\^\\\/api\\\/campaigns\\\/\[A-Za-z0-9_-\]\{1,64\}\\\/register\$\/\.test\(url\.pathname\)/, 'POST register (anchored)');
  // Handlers instantiated with the security deps.
  assert.match(WORKER, /const campaignsHandlers = createCampaignsHandlers\(\{/);
  assert.match(WORKER, /campaignsRepo,\s*\n\s*isUserRateLimited,\s*\n\s*ensureUserRow,/);
});

test('CAM-41: Stage 6B admin routes exist and stay off the user API surface', () => {
  // Stage 6B added the admin panel backend under /api/admin/campaigns* —
  // detailed wiring is locked in tests/campaigns-admin-api-contract-test.cjs.
  assert.match(WORKER, /'\/api\/admin\/campaigns'/, 'admin list/create base route exists (Stage 6B)');
  // The reward_center admin routes (existing) are a different subsystem and stay.
  assert.match(WORKER, /\/api\/admin\/reward-center\/campaigns/, 'reward_center admin routes unchanged');
  // The USER-facing surface remains exactly three routes — no new user paths.
  assert.ok(WORKER.includes("url.pathname === '/api/campaigns'"), 'user list route unchanged');
  // Admin and user route families stay disjoint (no /api/campaigns handler
  // dispatches to campaignsAdminHandlers).
  const adminDispatch = WORKER.slice(WORKER.indexOf('EXCHANGE CAMPAIGNS — Admin routes'));
  assert.ok(!adminDispatch.slice(0, adminDispatch.indexOf('/api/sessions')).includes('campaignsHandlers.handle'), 'admin block never calls the user handlers');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. FRONTEND ↔ BACKEND CONTRACT ALIGNMENT
// ═══════════════════════════════════════════════════════════════════════════

test('CAM-50: frontend registers only in real mode, one-tap POST, initData header', () => {
  assert.match(FRONTEND, /'\/api\/campaigns\/' \+ encodeURIComponent\(String\(id\)\) \+ '\/register'/);
  assert.match(FRONTEND, /method: 'POST'/);
  assert.match(FRONTEND, /apiHeaders\(true\)/);
  assert.match(FRONTEND, /X-Telegram-Init-Data/);
  // Demo mode: toast only, never a POST (honest fallback).
  assert.match(FRONTEND, /if \(_demoMode\) \{\s*\n\s*toast\(t\('cmp_register_soon'\)\)/);
  // Success only when the server confirms (registered === true).
  assert.match(FRONTEND, /res\.body && res\.body\.registered === true/);
});

test('CAM-51: all new cmp_register_* i18n keys exist in fa AND en (real i18n.js)', () => {
  const ctx = new Function(I18N_SRC + '\n;return { i18n };')();
  const keys = [
    'cmp_register_in_progress', 'cmp_register_success', 'cmp_register_already',
    'cmp_register_stopped', 'cmp_register_rate_limited', 'cmp_register_error',
  ];
  for (const k of keys) {
    assert.ok(typeof ctx.i18n.fa[k] === 'string' && ctx.i18n.fa[k].trim().length > 0, `fa.${k} non-empty`);
    assert.ok(typeof ctx.i18n.en[k] === 'string' && ctx.i18n.en[k].trim().length > 0, `en.${k} non-empty`);
  }
});

test('CAM-52: frontend error-code handling covers every controller error code', () => {
  for (const code of ['CAMPAIGN_NOT_STARTED', 'CAMPAIGN_ENDED', 'CAMPAIGN_STOPPED', 'CAMPAIGN_STATE_CHANGED', 'RATE_LIMITED']) {
    assert.ok(FRONTEND.includes(code), `frontend maps ${code}`);
  }
});

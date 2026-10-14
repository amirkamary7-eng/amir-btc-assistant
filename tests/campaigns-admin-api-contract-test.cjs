/**
 * EXCHANGE CAMPAIGNS — STAGE 6B SECTION 2 ADMIN API CONTRACT REGRESSION TEST
 * ==========================================================================
 *
 * Locks the admin backend for promo campaigns:
 *
 *   1. Repository admin functions (mocked queryDb): list/detail with
 *      registration_count subquery + parameterized filters/pagination,
 *      parameterized INSERT, whitelisted SET-builder UPDATE (status is
 *      NOT updatable), DELETED-terminal guards in SQL, registrations list
 *      with users JOIN.
 *   2. Controller behavior (mocked deps): campaigns.view / campaigns.manage
 *      permission gates, admin-mutation rate limit BEFORE any repo call,
 *      full server-side validation matrix (title/summary/body lengths,
 *      image_url via the REAL advertisements.js HTTPS validator — 5C-L4,
 *      strict ISO 8601 dates with timezone, ends_at > starts_at, status
 *      whitelist), lifecycle state machine (DRAFT→PUBLISHED→STOPPED→PUBLISHED,
 *      DELETED terminal, idempotent same-status), soft delete, CSV export
 *      (BOM, exact header, quote escaping, formula-injection neutralization,
 *      attachment + no-store + nosniff), audit logging of mutations only.
 *   3. Route wiring: the 9 /api/admin/campaigns* matchers in worker-proxy.js,
 *      factory deps, and the PROTECTED_PATHS gate staying OFF admin routes.
 *   4. Boundary: no schema changes, no CASCADE, no cross-module table access,
 *      revoke script still covers both promo tables (Section 1 intact).
 *
 * All tests are offline: no DB, no network, no Worker invocation. The
 * Postgres-specific SQL ( guards, partial UPDATE, subqueries) is verified by
 * SHAPE ONLY — no live PG server exists in this sandbox (M2 remains open).
 *
 * Run: node --test tests/campaigns-admin-api-contract-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const REPO_SRC = read('src/repositories/campaigns.js');
const CTRL_SRC = read('src/controllers/campaigns_admin.js');
const WORKER = read('worker-proxy.js');
const REVOKE = read('scripts/01-revoke-anon-authenticated.sql');

// ── Module loaders (same eval-based pattern as campaigns-api-contract-test) ─

function loadFactory(filePath, factoryName) {
  const src = read(filePath);
  assert.match(src, new RegExp(`export function ${factoryName}\\b`),
    `${filePath} must export ${factoryName}`);
  const stripped = src.replace(/^export\s+/m, '');
  const mod = {};
  new Function('module', stripped + `\nmodule.exports = ${factoryName};`)(mod);
  return mod.exports;
}

// ESM → CJS via esbuild, for the multi-export advertisements.js validators.
function loadEsmExports(filePath) {
  const esbuild = require('esbuild');
  const out = esbuild.transformSync(read(filePath), { loader: 'js', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
  return mod.exports;
}

const createCampaignsRepository = loadFactory('src/repositories/campaigns.js', 'createCampaignsRepository');
const createCampaignsAdminHandlers = loadFactory('src/controllers/campaigns_admin.js', 'createCampaignsAdminHandlers');
const { isValidImageUrl } = loadEsmExports('src/repositories/advertisements.js');

// ── Parse + bundle check (esbuild — the production parser) ──────────────────

test('CAMA-00: repo + controller + worker parse and imports resolve (esbuild)', () => {
  const esbuild = require('esbuild');
  for (const f of ['src/repositories/campaigns.js', 'src/controllers/campaigns_admin.js', 'worker-proxy.js']) {
    esbuild.transformSync(read(f), { loader: 'js', format: 'esm' });
  }
  // Full bundle proves createCampaignsAdminHandlers + isValidImageUrl imports resolve.
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
// 1. REPOSITORY ADMIN FUNCTIONS (mocked queryDb)
// ═══════════════════════════════════════════════════════════════════════════

function buildRepo(queryDbImpl) {
  return createCampaignsRepository({
    queryDb: queryDbImpl,
    isDatabaseConfigured: (env) => Boolean(env && env.DATABASE_URL),
  });
}

const ADMIN_ROW = {
  id: 'c1', title_fa: 'کمپین', title_en: 'Campaign', summary_fa: 'خلاصه', summary_en: 'Summary',
  body_fa: 'متن', body_en: 'Body', image_url: 'https://cdn.example.com/a.webp',
  starts_at: new Date('2026-01-01T00:00:00Z'), ends_at: null, status: 'PUBLISHED',
  created_at: new Date('2025-12-01T00:00:00Z'), updated_at: new Date('2025-12-02T00:00:00Z'),
  registration_count: 7,
};

test('CAMA-10: listCampaignsAdmin — status+search parameterized, pagination bounds, count+data split, row mapping', async () => {
  const queries = [];
  const repo = buildRepo(async (env, sql, params) => {
    queries.push({ sql, params });
    // Count query starts with SELECT COUNT — the DATA query also contains
    // COUNT(*) inside the registration_count subquery, so match on the prefix.
    if (/^SELECT COUNT/.test(String(sql).trim())) return { rows: [{ total: 42 }] };
    return { rows: [ADMIN_ROW] };
  });
  const result = await repo.listCampaignsAdmin({ DATABASE_URL: 'x' }, { status: 'DRAFT', search: 'عکس', page: 2, limit: 10 });

  const countQ = queries[0];
  const dataQ = queries[1];
  // Filter values are BOUND, never interpolated; search is wrapped as a LIKE term.
  assert.deepEqual(countQ.params, ['DRAFT', '%عکس%']);
  assert.match(dataQ.sql, /WHERE c\.status = \$1 AND \(c\.title_fa ILIKE \$2 OR c\.title_en ILIKE \$2\)/);
  // LIMIT/OFFSET are the last two bound params, offset = (page-1)*limit.
  assert.deepEqual(dataQ.params, ['DRAFT', '%عکس%', 10, 10]);
  // registration_count subquery is part of the select.
  assert.match(dataQ.sql, /\(SELECT COUNT\(\*\)::int FROM promo_campaign_registrations r/);
  // Row mapping incl. Date → ISO and registration_count coercion.
  assert.equal(result.items[0].id, 'c1');
  assert.equal(result.items[0].starts_at, '2026-01-01T00:00:00.000Z');
  assert.equal(result.items[0].registration_count, 7);
  assert.equal(result.total, 42);
  assert.equal(result.totalPages, 5);

  // No filters → no WHERE; limit clamped to 100, page to >=1.
  const queries2 = [];
  const repo2 = buildRepo(async (env, sql, params) => {
    queries2.push({ sql, params });
    if (/^SELECT COUNT/.test(String(sql).trim())) return { rows: [{ total: 0 }] };
    return { rows: [] };
  });
  await repo2.listCampaignsAdmin({ DATABASE_URL: 'x' }, { page: 0, limit: 999 });
  assert.ok(!queries2[0].sql.includes('WHERE'));
  assert.deepEqual(queries2[1].params, [100, 0], 'limit clamped to 100, offset floor at 0');
});

test('CAMA-11: getCampaignById — any-status read with registration_count, null when missing', async () => {
  let captured = null;
  const repo = buildRepo(async (env, sql, params) => {
    captured = { sql, params };
    return { rows: [ADMIN_ROW] };
  });
  const c = await repo.getCampaignById({ DATABASE_URL: 'x' }, 'c1');
  assert.equal(c.id, 'c1');
  assert.equal(c.registration_count, 7);
  assert.match(captured.sql, /WHERE c\.id = \$1/);
  assert.deepEqual(captured.params, ['c1']);

  const repo2 = buildRepo(async () => ({ rows: [] }));
  assert.equal(await repo2.getCampaignById({ DATABASE_URL: 'x' }, 'nope'), null);
});

test('CAMA-12: createCampaign — fully parameterized INSERT, defaults applied, registration_count 0', async () => {
  let captured = null;
  const repo = buildRepo(async (env, sql, params) => {
    captured = { sql, params };
    // INSERT ... RETURNING shape: plain columns only (no registration_count).
    return { rows: [{
      id: 'c1', title_fa: 'کمپین', title_en: 'Campaign', summary_fa: null, summary_en: null,
      body_fa: '', body_en: '', image_url: null,
      starts_at: new Date('2026-01-01T00:00:00Z'), ends_at: null, status: 'DRAFT',
      created_at: new Date('2025-12-01T00:00:00Z'), updated_at: new Date('2025-12-01T00:00:00Z'),
    }] };
  });
  const c = await repo.createCampaign({ DATABASE_URL: 'x' }, {
    title_fa: 'کمپین', title_en: 'Campaign', summary_fa: null, summary_en: null,
    body_fa: '', body_en: '', image_url: null, starts_at: '2026-01-01T00:00:00Z', ends_at: null, status: 'DRAFT',
  });
  assert.match(captured.sql, /INSERT INTO promo_campaigns\s+\(title_fa, title_en, summary_fa, summary_en, body_fa, body_en,/);
  assert.match(captured.sql, /VALUES \(\$1, \$2, \$3, \$4, \$5, \$6, \$7, \$8, \$9, \$10\)/);
  assert.deepEqual(captured.params, ['کمپین', 'Campaign', null, null, '', '', null, '2026-01-01T00:00:00Z', null, 'DRAFT']);
  // A fresh uuid campaign cannot have registrations — count is 0 by construction.
  assert.equal(c.registration_count, 0);
});

test('CAMA-13: updateCampaign — whitelisted SET builder, status NOT updatable, unknown keys ignored, live registration_count (M-2)', async () => {
  const queries = [];
  // Faithful Postgres emulation: UPDATE ... RETURNING yields PLAIN columns
  // only (Postgres rejects the registration_count subquery inside RETURNING);
  // the follow-up canonical admin SELECT yields the row WITH the live count.
  const RETURN_ROW = { ...ADMIN_ROW };
  delete RETURN_ROW.registration_count;
  const repo = buildRepo(async (env, sql, params) => {
    queries.push({ sql, params });
    if (/^UPDATE/.test(String(sql).trim())) return { rows: [{ ...RETURN_ROW }] };
    return { rows: [{ ...ADMIN_ROW }] };
  });
  const c = await repo.updateCampaign({ DATABASE_URL: 'x' }, 'c1', { title_en: 'New', image_url: null });
  assert.match(queries[0].sql, /SET title_en = \$1, image_url = \$2, updated_at = NOW\(\)/);
  assert.deepEqual(queries[0].params, ['New', null, 'c1']);
  // M-2: the UPDATE alone cannot yield registration_count — a follow-up
  // canonical admin SELECT (_ADMIN_SELECT_COLUMNS) must run and its live
  // count must surface (non-zero, so a mock returning 0 cannot hide a wrong
  // implementation).
  assert.match(queries[1].sql, /SELECT\s+c\.id, c\.title_fa/, 'follow-up is the canonical admin select');
  assert.match(queries[1].sql, /\(SELECT COUNT\(\*\)::int FROM promo_campaign_registrations r/);
  assert.match(queries[1].sql, /WHERE c\.id = \$1/);
  assert.deepEqual(queries[1].params, ['c1']);
  assert.equal(c.id, 'c1');
  assert.equal(c.registration_count, 7, 'live registration_count re-read after UPDATE (audit M-2)');

  // Fallback: re-read misses (impossible without a hard DELETE) → the mapped
  // RETURNING row is still returned (registration_count coerces to 0).
  const repoFb = buildRepo(async (env, sql) => (/^UPDATE/.test(String(sql).trim()) ? { rows: [{ ...RETURN_ROW }] } : { rows: [] }));
  const cFb = await repoFb.updateCampaign({ DATABASE_URL: 'x' }, 'c1', { title_en: 'New' });
  assert.equal(cFb.id, 'c1', 'fallback keeps a usable row when the re-read misses');
  assert.equal(cFb.registration_count, 0);

  // status / unknown columns produce NO SQL at all (no injection surface).
  let queries2 = 0;
  const repo2 = buildRepo(async () => { queries2 += 1; return { rows: [] }; });
  assert.equal(await repo2.updateCampaign({ DATABASE_URL: 'x' }, 'c1', { status: 'PUBLISHED' }), null);
  assert.equal(await repo2.updateCampaign({ DATABASE_URL: 'x' }, 'c1', { evil: '; DROP TABLE users;--' }), null);
  assert.equal(queries2, 0, 'no query may run for non-whitelisted fields');
});

test('CAMA-14: setCampaignStatus — DELETED-terminal guard in SQL, parameterized status, live registration_count (M-2)', async () => {
  const queries = [];
  // Faithful Postgres emulation (as in CAMA-13): RETURNING has plain columns
  // only; the follow-up admin SELECT carries the live count.
  const RETURN_ROW = { ...ADMIN_ROW };
  delete RETURN_ROW.registration_count;
  const repo = buildRepo(async (env, sql, params) => {
    queries.push({ sql, params });
    if (/^UPDATE/.test(String(sql).trim())) return { rows: [{ ...RETURN_ROW }] };
    return { rows: [{ ...ADMIN_ROW }] };
  });
  const c = await repo.setCampaignStatus({ DATABASE_URL: 'x' }, 'c1', 'STOPPED');
  assert.match(queries[0].sql, /SET status = \$2, updated_at = NOW\(\)/);
  assert.match(queries[0].sql, /AND status <> 'DELETED'/, 'DELETED is terminal at the SQL level');
  assert.deepEqual(queries[0].params, ['c1', 'STOPPED']);
  assert.match(queries[1].sql, /\(SELECT COUNT\(\*\)::int FROM promo_campaign_registrations r/, 'canonical admin re-read runs');
  assert.equal(c.status, 'PUBLISHED', 'row mapping from the re-read');
  assert.equal(c.registration_count, 7, 'live registration_count re-read after status change (audit M-2)');

  const repo2 = buildRepo(async () => ({ rows: [] }));
  assert.equal(await repo2.setCampaignStatus({ DATABASE_URL: 'x' }, 'c1', 'PUBLISHED'), null);
});

test('CAMA-15: softDeleteCampaign — SOFT only (status→DELETED), guard, boolean result', async () => {
  let captured = null;
  const repo = buildRepo(async (env, sql, params) => {
    captured = { sql, params };
    return { rows: [{ id: 'c1' }] };
  });
  assert.equal(await repo.softDeleteCampaign({ DATABASE_URL: 'x' }, 'c1'), true);
  assert.match(captured.sql, /SET status = 'DELETED', updated_at = NOW\(\)/);
  assert.match(captured.sql, /AND status <> 'DELETED'/);
  assert.ok(!captured.sql.includes('DELETE FROM'), 'never a hard DELETE');
  assert.deepEqual(captured.params, ['c1']);

  const repo2 = buildRepo(async () => ({ rows: [] }));
  assert.equal(await repo2.softDeleteCampaign({ DATABASE_URL: 'x' }, 'c1'), false);
});

test('CAMA-16: listRegistrations — users LEFT JOIN, bound pagination, null-safe mapping, limit clamp', async () => {
  const queries = [];
  const repo = buildRepo(async (env, sql, params) => {
    queries.push({ sql, params });
    if (/COUNT\(\*\)/.test(sql)) return { rows: [{ total: 3 }] };
    return { rows: [{ id: 9, telegram_id: '111', registered_at: new Date('2026-02-01T10:00:00Z'), username: null, first_name: 'Amir', last_name: null }] };
  });
  const r = await repo.listRegistrations({ DATABASE_URL: 'x' }, 'c1', { page: 2, limit: 2000 });
  assert.match(queries[1].sql, /LEFT JOIN users u ON u\.telegram_id = r\.telegram_id/);
  assert.match(queries[1].sql, /ORDER BY r\.registered_at DESC, r\.id DESC/);
  assert.deepEqual(queries[1].params, ['c1', 1000, 1000], 'limit clamped to 1000; offset = (2-1)*1000');
  assert.equal(r.items[0].telegram_id, '111');
  assert.equal(r.items[0].username, null);
  assert.equal(r.items[0].registered_at, '2026-02-01T10:00:00.000Z');
  assert.equal(r.total, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. CONTROLLER BEHAVIOR (mocked deps — REAL isValidImageUrl)
// ═══════════════════════════════════════════════════════════════════════════

function buildHandlers(config = {}) {
  const {
    admin = { telegram_id: '900', role: 'admin', permissions: ['campaigns.view', 'campaigns.manage'], active: true },
    authError = null,
    rateLimited = false,
    dbConfigured = true,
    body = null,
    bodyError = null,
    repo: repoConfig = {},
    storeImageImpl = null,
  } = config;
  const calls = { requireAdmin: [], rateLimit: [], repo: [], log: [], storeImage: [] };

  const repo = {
    ensureSchema: async () => {},
    listCampaignsAdmin: async (env, p) => { calls.repo.push(['list', p]); return repoConfig.list ? repoConfig.list(p) : { items: [], total: 0, page: 1, limit: 20, totalPages: 1 }; },
    getCampaignById: async (env, id) => { calls.repo.push(['get', id]); return repoConfig.get ? repoConfig.get(id) : null; },
    createCampaign: async (env, data) => { calls.repo.push(['create', data]); return repoConfig.create ? repoConfig.create(data) : { id: 'new-1', registration_count: 0, created_at: '2026-01-01T00:00:00Z', updated_at: '2026-01-01T00:00:00Z', ...data }; },
    updateCampaign: async (env, id, fields) => { calls.repo.push(['update', id, fields]); return repoConfig.update ? repoConfig.update(id, fields) : { id, registration_count: 0, ...fields }; },
    setCampaignStatus: async (env, id, s) => { calls.repo.push(['setStatus', id, s]); return repoConfig.setStatus ? repoConfig.setStatus(id, s) : { id, status: s, registration_count: 0 }; },
    softDeleteCampaign: async (env, id) => { calls.repo.push(['softDelete', id]); return repoConfig.softDelete ? repoConfig.softDelete(id) : true; },
    listRegistrations: async (env, id, p) => { calls.repo.push(['registrations', id, p]); return repoConfig.registrations ? repoConfig.registrations(id, p) : { items: [], total: 0, page: 1, limit: 20, totalPages: 1 }; },
  };

  const adminRepo = {
    logAdminAction: async (env, entry) => { calls.log.push(entry); return 1; },
  };

  const advertisementsRepo = {
    storeImage: async (env, dataUri, contentType) => {
      calls.storeImage.push({ dataUri, contentType });
      if (storeImageImpl) return storeImageImpl(dataUri, contentType);
      return '/api/advertisements/image/img_test1234';
    },
  };

  const handlers = createCampaignsAdminHandlers({
    jsonResponse: (payload, init = {}) => ({ __json: payload, __status: init.status || 200 }),
    requireAdmin: async (request, env, perm) => {
      calls.requireAdmin.push(perm);
      if (authError) return { error: authError, admin: null };
      return { error: null, admin };
    },
    readJsonBody: async () => (bodyError ? { error: bodyError } : { payload: body }),
    safeDbErrorResponse: () => ({ __json: { status: 'error', message: 'Database unavailable' }, __status: 503 }),
    safeError: (label, e) => `${label}: ${e && e.message}`,
    isDatabaseConfigured: () => dbConfigured,
    isUserRateLimited: async (env, id, category, max, win) => {
      calls.rateLimit.push([id, category, max, win]);
      return rateLimited;
    },
    campaignsRepo: repo,
    adminRepo,
    advertisementsRepo,
    withCors: (headers = {}) => new Headers(headers),
    isValidImageUrl,
  });

  return { handlers, calls };
}

const REQ = (url = 'https://x/api/admin/campaigns') => ({ url, method: 'GET' });
const PAST = '2026-01-01T00:00:00Z';
const FUTURE = '2026-06-01T00:00:00Z';

const VALID_CREATE = {
  title_fa: 'کمپین', title_en: 'Campaign', summary_fa: 'خلاصه', summary_en: 'Summary',
  body_fa: 'متن', body_en: 'Body', image_url: 'https://cdn.example.com/a.webp',
  starts_at: FUTURE, ends_at: '2026-07-01T00:00:00Z',
};

function existingCampaign(over = {}) {
  return {
    id: 'c1', title_fa: 'کمپین', title_en: 'Campaign', summary_fa: null, summary_en: null,
    body_fa: '', body_en: '', image_url: null, starts_at: PAST, ends_at: null,
    status: 'DRAFT', created_at: '2025-12-01T00:00:00Z', updated_at: '2025-12-01T00:00:00Z',
    registration_count: 3, ...over,
  };
}

// ── Permission gates ────────────────────────────────────────────────────────

test('CAMA-20: reads gated by campaigns.view, mutations by campaigns.manage', async () => {
  const reads = [
    ['handleAdminListCampaigns', [REQ()]],
    ['handleAdminGetCampaign', [REQ(), {}, 'c1']],
    ['handleAdminListRegistrations', [REQ('https://x/api/admin/campaigns/c1/registrations'), {}, 'c1']],
    ['handleAdminExportRegistrations', [REQ('https://x/api/admin/campaigns/c1/registrations/export'), {}, 'c1']],
  ];
  for (const [name, args] of reads) {
    const { handlers, calls } = buildHandlers({});
    await handlers[name](...args);
    assert.deepEqual(calls.requireAdmin, ['campaigns.view'], `${name} requires campaigns.view`);
  }

  const writes = [
    ['handleAdminCreateCampaign', [REQ(), {}, {}]],
    ['handleAdminUpdateCampaign', [REQ(), {}, 'c1']],
    ['handleAdminSetCampaignStatus', [REQ(), {}, 'c1']],
    ['handleAdminDeleteCampaign', [REQ(), {}, 'c1']],
  ];
  for (const [name, args] of writes) {
    const { handlers, calls } = buildHandlers({ body: {} });
    await handlers[name](...args);
    assert.deepEqual(calls.requireAdmin, ['campaigns.manage'], `${name} requires campaigns.manage`);
  }
});

test('CAMA-21: 401/403 passthrough, and mutation rate limit fires BEFORE any repo call', async () => {
  const { handlers } = buildHandlers({ authError: { __json: { detail: 'Invalid Telegram init data' }, __status: 401 } });
  assert.equal((await handlers.handleAdminListCampaigns(REQ(), {})).__status, 401);
  assert.equal((await handlers.handleAdminCreateCampaign(REQ(), {}, {})).__status, 401);

  const { handlers: h403 } = buildHandlers({ authError: { __json: { detail: 'Insufficient permissions' }, __status: 403 } });
  assert.equal((await h403.handleAdminListCampaigns(REQ(), {})).__status, 403);

  for (const [name, args] of [
    ['handleAdminCreateCampaign', [REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' }, {}]],
    ['handleAdminUpdateCampaign', [REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' }, 'c1']],
    ['handleAdminSetCampaignStatus', [REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' }, 'c1']],
    ['handleAdminDeleteCampaign', [REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' }, 'c1']],
    ['handleAdminUploadCampaignImage', [REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' }]],
  ]) {
    const { handlers: h, calls } = buildHandlers({ rateLimited: true, body: {} });
    const res = await h[name](...args);
    assert.equal(res.__status, 429, `${name} rate limited → 429`);
    assert.equal(res.__json.code, 'RATE_LIMITED');
    assert.deepEqual(calls.repo, [], `${name}: no repo call when throttled`);
    assert.deepEqual(calls.rateLimit, [['900', 'admin-mutation', 20, 60]], 'admin-mutation bucket 20/60s');
  }
  // Reads are never rate limited.
  const { handlers: hr, calls: cr } = buildHandlers({ rateLimited: true });
  await hr.handleAdminListCampaigns(REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' });
  assert.deepEqual(cr.rateLimit, []);
});

// ── Validation matrix ──────────────────────────────────────────────────────

test('CAMA-22: create validation matrix — lengths, types, image_url (REAL validator), strict ISO 8601, window', async () => {
  const cases = [
    // [label, payload-mutation, expected error field]
    ['missing title_fa', (p) => delete p.title_fa, 'title_fa'],
    ['null title_fa', (p) => { p.title_fa = null; }, 'title_fa'],
    ['empty title_en', (p) => { p.title_en = '   '; }, 'title_en'],
    ['title 201 chars', (p) => { p.title_fa = 'a'.repeat(201); }, 'title_fa'],
    ['non-string title', (p) => { p.title_en = 42; }, 'title_en'],
    ['summary 501 chars', (p) => { p.summary_fa = 's'.repeat(501); }, 'summary_fa'],
    ['body 5001 chars', (p) => { p.body_en = 'b'.repeat(5001); }, 'body_en'],
    ['http image_url', (p) => { p.image_url = 'http://cdn.example.com/a.webp'; }, 'image_url'],
    ['IP-literal image_url (SSRF)', (p) => { p.image_url = 'https://192.168.1.1/a.webp'; }, 'image_url'],
    ['localhost image_url', (p) => { p.image_url = 'https://localhost/a.webp'; }, 'image_url'],
    ['javascript: image_url', (p) => { p.image_url = 'javascript:alert(1)'; }, 'image_url'],
    ['data: image_url', (p) => { p.image_url = 'data:image/png;base64,AAAA'; }, 'image_url'],
    ['userinfo image_url', (p) => { p.image_url = 'https://user:pass@cdn.example.com/a.webp'; }, 'image_url'],
    ['non-ISO starts_at', (p) => { p.starts_at = '02/01/2026'; }, 'starts_at'],
    ['starts_at without timezone', (p) => { p.starts_at = '2026-01-01T00:00:00'; }, 'starts_at'],
    ['date-only starts_at', (p) => { p.starts_at = '2026-01-01'; }, 'starts_at'],
    ['non-ISO ends_at', (p) => { p.ends_at = 'tomorrow'; }, 'ends_at'],
    ['ends_at before starts_at', (p) => { p.ends_at = '2025-06-01T00:00:00Z'; }, 'ends_at'],
    ['ends_at equal to starts_at', (p) => { p.ends_at = FUTURE; }, 'ends_at'],
  ];
  for (const [label, mutate, field] of cases) {
    const payload = { ...VALID_CREATE };
    mutate(payload);
    const { handlers } = buildHandlers({ body: payload });
    const res = await handlers.handleAdminCreateCampaign(REQ(), { DATABASE_URL: 'x' });
    assert.equal(res.__status, 400, `${label} → 400`);
    assert.equal(res.__json.code, 'VALIDATION_ERROR', `${label} → VALIDATION_ERROR`);
    assert.ok(res.__json.errors.some((e) => e.field === field), `${label} reports field ${field}`);
  }

  // Positive controls: valid https URL, null image, null ends_at, .png/.svg ext.
  const okCases = [
    ['https image_url', { image_url: 'https://cdn.example.com/banner.png' }],
    ['internal uploaded image_url', { image_url: '/api/advertisements/image/AbCdEfGh1234' }],
    ['null image_url', { image_url: null }],
    ['null ends_at', { ends_at: null }],
    ['+02:00 offset ends_at', { starts_at: '2026-01-01T00:00:00+02:00', ends_at: '2026-02-01T00:00:00+02:00' }],
  ];
  for (const [label, over] of okCases) {
    const payload = { ...VALID_CREATE, ...over };
    const { handlers, calls } = buildHandlers({ body: payload });
    const res = await handlers.handleAdminCreateCampaign(REQ(), { DATABASE_URL: 'x' });
    assert.equal(res.__status, 200, `${label} → 200`);
    assert.ok(calls.repo.some((c) => c[0] === 'create'), `${label} reached the repo`);
  }
});

test('CAMA-23: create — default DRAFT, direct PUBLISHED allowed, STOPPED/DELETED rejected', async () => {
  const { handlers, calls } = buildHandlers({ body: { ...VALID_CREATE } });
  const res = await handlers.handleAdminCreateCampaign(REQ(), { DATABASE_URL: 'x' });
  assert.equal(res.__status, 200);
  assert.equal(calls.repo[0][1].status, 'DRAFT', 'status defaults to DRAFT');

  const { handlers: h2, calls: c2 } = buildHandlers({ body: { ...VALID_CREATE, status: 'PUBLISHED' } });
  assert.equal((await h2.handleAdminCreateCampaign(REQ(), { DATABASE_URL: 'x' })).__status, 200);
  assert.equal(c2.repo[0][1].status, 'PUBLISHED', 'direct publish allowed');

  for (const bad of ['STOPPED', 'DELETED', 'draft', 'PUBLISHED ', 42]) {
    const { handlers: h3 } = buildHandlers({ body: { ...VALID_CREATE, status: bad } });
    const res3 = await h3.handleAdminCreateCampaign(REQ(), { DATABASE_URL: 'x' });
    assert.equal(res3.__status, 400, `status=${JSON.stringify(bad)} → 400`);
    assert.ok(res3.__json.errors.some((e) => e.field === 'status'), `status=${JSON.stringify(bad)} reports field status`);
  }
});

// ── Update ─────────────────────────────────────────────────────────────────

test('CAMA-24: update — status field rejected, empty patch rejected, DELETED 409, merged window check, happy path', async () => {
  // status via PUT is rejected with a pointer to the status endpoint.
  const { handlers } = buildHandlers({ body: { status: 'PUBLISHED' }, repo: { get: () => existingCampaign() } });
  const res = await handlers.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(res.__status, 400);
  assert.ok(res.__json.errors.some((e) => e.field === 'status' && /status endpoint/.test(e.message)));

  // No updatable fields at all.
  const { handlers: hEmpty } = buildHandlers({ body: {}, repo: { get: () => existingCampaign() } });
  const resEmpty = await hEmpty.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resEmpty.__status, 400);
  assert.ok(resEmpty.__json.errors.some((e) => /no updatable fields/.test(e.message)));

  // DELETED rows are immutable.
  const { handlers: hDel } = buildHandlers({ body: { title_en: 'New' }, repo: { get: () => existingCampaign({ status: 'DELETED' }) } });
  const resDel = await hDel.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resDel.__status, 409);
  assert.equal(resDel.__json.code, 'CAMPAIGN_ALREADY_DELETED');

  // Missing → 404.
  const { handlers: h404 } = buildHandlers({ body: { title_en: 'New' } });
  assert.equal((await h404.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1')).__status, 404);

  // Window check uses the MERGED values: patch only ends_at, stored starts_at wins.
  const { handlers: hWin } = buildHandlers({
    body: { ends_at: '2025-06-01T00:00:00Z' },
    repo: { get: () => existingCampaign({ starts_at: PAST }) },
  });
  const resWin = await hWin.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resWin.__status, 400);
  assert.ok(resWin.__json.errors.some((e) => e.field === 'ends_at'));

  // M-1: explicit null on a REQUIRED field is a clean 400 (not a 503 from
  // the DB NOT NULL violation), and no UPDATE reaches the repo.
  for (const requiredTitle of ['title_fa', 'title_en']) {
    const { handlers: hNull, calls: cNull } = buildHandlers({
      body: { [requiredTitle]: null, summary_fa: 'kept' },
      repo: { get: () => existingCampaign() },
    });
    const resNull = await hNull.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
    assert.equal(resNull.__status, 400, `${requiredTitle}: null → 400`);
    assert.equal(resNull.__json.code, 'VALIDATION_ERROR', `${requiredTitle}: VALIDATION_ERROR`);
    assert.ok(resNull.__json.errors.some((e) => e.field === requiredTitle && /cannot be null/.test(e.message)), `${requiredTitle} reports the null field`);
    assert.ok(!cNull.repo.some((c) => c[0] === 'update'), `${requiredTitle}: no UPDATE reaches the repo`);
  }

  // M-1 counterpart: optional fields still CLEAR on explicit null.
  const { handlers: hClear, calls: cClear } = buildHandlers({
    body: { summary_fa: null, body_fa: null },
    repo: { get: () => existingCampaign() },
  });
  const resClear = await hClear.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resClear.__status, 200, 'optional null still clears');
  assert.deepEqual(
    cClear.repo.find((c) => c[0] === 'update')[2],
    { summary_fa: null, body_fa: '' },
    'summary clears to NULL, body clears to empty string',
  );

  // Happy path: partial patch passes only validated fields to the repo.
  const { handlers: hOk, calls } = buildHandlers({
    body: { title_en: 'New Title', image_url: 'https://cdn.example.com/x.png' },
    repo: {
      get: () => existingCampaign(),
      update: (id, fields) => ({ ...existingCampaign(), ...fields, registration_count: 9 }),
    },
  });
  const resOk = await hOk.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resOk.__status, 200);
  assert.equal(resOk.__json.campaign.registration_count, 9, 'M-2: repo registration_count passes through untouched');
  const updateCall = calls.repo.find((c) => c[0] === 'update');
  assert.equal(updateCall[1], 'c1');
  assert.deepEqual(updateCall[2], { title_en: 'New Title', image_url: 'https://cdn.example.com/x.png' });
});

// ── Status transitions ─────────────────────────────────────────────────────

test('CAMA-25: state machine — publish/stop/resume legal, invalid transitions 409/400, idempotent same-status', async () => {
  const legal = [
    ['DRAFT', 'PUBLISHED', 200],
    ['PUBLISHED', 'STOPPED', 200],
    ['STOPPED', 'PUBLISHED', 200],
  ];
  for (const [from, to, expected] of legal) {
    const { handlers, calls } = buildHandlers({
      body: { status: to },
      repo: {
        get: () => existingCampaign({ status: from }),
        setStatus: (id, s) => ({ ...existingCampaign({ status: s }), registration_count: 11 }),
      },
    });
    const res = await handlers.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
    assert.equal(res.__status, expected, `${from} → ${to}`);
    assert.equal(calls.repo.find((c) => c[0] === 'setStatus')[2], to);
    assert.equal(res.__json.campaign.registration_count, 11, 'M-2: live count passes through on status change');
  }

  const illegal = [
    ['DRAFT', 'STOPPED', 'INVALID_STATUS_TRANSITION'],
    ['STOPPED', 'STOPPED', null], // same-status → idempotent 200, NOT an error
  ];
  const { handlers: hSame } = buildHandlers({ body: { status: 'STOPPED' }, repo: { get: () => existingCampaign({ status: 'STOPPED' }) } });
  const resSame = await hSame.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resSame.__status, 200, 'same-status is an idempotent no-op');
  assert.equal(resSame.__json.campaign.status, 'STOPPED');
  assert.equal(resSame.__json.campaign.registration_count, 3, 'M-2: idempotent path returns the stored live count');

  const { handlers: hIll } = buildHandlers({ body: { status: 'STOPPED' }, repo: { get: () => existingCampaign({ status: 'DRAFT' }) } });
  const resIll = await hIll.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resIll.__status, 409);
  assert.equal(resIll.__json.code, 'INVALID_STATUS_TRANSITION');
  assert.ok(/DRAFT.*STOPPED/.test(resIll.__json.message), 'message names the rejected transition');

  // DELETED is terminal: 409 before any repo mutation.
  const { handlers: hDead, calls: cDead } = buildHandlers({ body: { status: 'PUBLISHED' }, repo: { get: () => existingCampaign({ status: 'DELETED' }) } });
  const resDead = await hDead.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resDead.__status, 409);
  assert.equal(resDead.__json.code, 'CAMPAIGN_ALREADY_DELETED');
  assert.ok(!cDead.repo.some((c) => c[0] === 'setStatus'), 'no status write on a deleted campaign');

  // Illegal targets rejected at the whitelist level (400).
  for (const bad of ['DELETED', 'DRAFT', 'ARCHIVED', 'published', 42, null]) {
    const { handlers: hBad } = buildHandlers({ body: { status: bad }, repo: { get: () => existingCampaign({ status: 'DRAFT' }) } });
    const resBad = await hBad.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
    assert.equal(resBad.__status, 400, `target=${JSON.stringify(bad)} → 400`);
    assert.equal(resBad.__json.code, 'INVALID_STATUS');
  }

  // Missing → 404; repo raced-delete → 409 CAMPAIGN_STATE_CHANGED.
  const { handlers: h404 } = buildHandlers({ body: { status: 'PUBLISHED' } });
  assert.equal((await h404.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1')).__status, 404);
  const { handlers: hRace } = buildHandlers({ body: { status: 'PUBLISHED' }, repo: { get: () => existingCampaign(), setStatus: () => null } });
  const resRace = await hRace.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resRace.__status, 409);
  assert.equal(resRace.__json.code, 'CAMPAIGN_STATE_CHANGED');
});

// ── Delete ─────────────────────────────────────────────────────────────────

test('CAMA-26: delete — soft only, 404/409 mapping, race-safe', async () => {
  const { handlers, calls } = buildHandlers({ repo: { get: () => existingCampaign({ status: 'PUBLISHED' }) } });
  const res = await handlers.handleAdminDeleteCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(res.__status, 200);
  assert.equal(res.__json.deleted, true);
  assert.equal(res.__json.id, 'c1');
  assert.ok(calls.repo.some((c) => c[0] === 'softDelete'), 'soft delete executed');

  const { handlers: h404 } = buildHandlers({});
  assert.equal((await h404.handleAdminDeleteCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1')).__status, 404);

  const { handlers: h409 } = buildHandlers({ repo: { get: () => existingCampaign({ status: 'DELETED' }) } });
  const res409 = await h409.handleAdminDeleteCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(res409.__status, 409);
  assert.equal(res409.__json.code, 'CAMPAIGN_ALREADY_DELETED');

  const { handlers: hRace } = buildHandlers({ repo: { get: () => existingCampaign(), softDelete: () => false } });
  const resRace = await hRace.handleAdminDeleteCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(resRace.__status, 409);
  assert.equal(resRace.__json.code, 'CAMPAIGN_STATE_CHANGED');
});

// ── Registrations + CSV export ─────────────────────────────────────────────

test('CAMA-27: registrations list — 404 for missing campaign, pagination pass-through, response shape', async () => {
  const { handlers } = buildHandlers({});
  assert.equal((await handlers.handleAdminListRegistrations(REQ(), {}, 'c1')).__status, 404);

  const { handlers: h, calls } = buildHandlers({
    repo: {
      get: () => existingCampaign({ registration_count: 5 }),
      registrations: (id, p) => ({ items: [{ id: 9, telegram_id: '111', username: 'amir', first_name: null, last_name: null, registered_at: PAST }], total: 5, page: p.page, limit: p.limit, totalPages: 1 }),
    },
  });
  const res = await h.handleAdminListRegistrations(REQ('https://x/api/admin/campaigns/c1/registrations?page=3&limit=7'), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(res.__status, 200);
  assert.equal(res.__json.campaign_id, 'c1');
  assert.equal(res.__json.registration_count, 5);
  assert.equal(res.__json.total, 5);
  assert.equal(res.__json.items[0].telegram_id, '111');
  assert.deepEqual(calls.repo.find((c) => c[0] === 'registrations')[2], { page: 3, limit: 7 });
});

test('CAMA-28: CSV export — BOM, exact header, quote escaping, formula-injection neutralization, security headers, 404', async () => {
  const { handlers } = buildHandlers({});
  assert.equal((await handlers.handleAdminExportRegistrations(REQ(), {}, 'c1')).__status, 404);

  const { handlers: h } = buildHandlers({
    repo: {
      get: () => existingCampaign(),
      registrations: () => ({
        items: [
          { id: 1, telegram_id: '111', username: '=HYPERLINK("http://evil.example","click")', first_name: 'Am,ir', last_name: 'O"Brian', registered_at: PAST },
          { id: 2, telegram_id: '222', username: '+SUM(A1:A9)', first_name: null, last_name: null, registered_at: PAST },
          { id: 3, telegram_id: '333', username: '@cmd', first_name: null, last_name: null, registered_at: PAST },
          { id: 4, telegram_id: '444', username: 'normal', first_name: null, last_name: null, registered_at: PAST },
        ],
        total: 4, page: 1, limit: 1000, totalPages: 1,
      }),
    },
  });
  const res = await h.handleAdminExportRegistrations(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.ok(res instanceof Response, 'CSV export returns a real Response');
  assert.equal(res.status, 200);
  // Security headers (membership.js pattern).
  assert.match(res.headers.get('Content-Type') || '', /text\/csv; charset=utf-8/);
  assert.equal(res.headers.get('Content-Disposition'), 'attachment; filename="campaign-registrations-c1.csv"');
  assert.match(res.headers.get('Cache-Control') || '', /no-store/);
  assert.equal(res.headers.get('X-Content-Type-Options'), 'nosniff');

  // BOM check on RAW BYTES — res.text() performs spec "UTF-8 decode" which
  // strips a leading BOM, so the byte sequence EF BB BF is verified here.
  const rawBytes = new Uint8Array(await res.arrayBuffer());
  assert.equal(rawBytes[0], 0xef, 'UTF-8 BOM byte 1 for Excel');
  assert.equal(rawBytes[1], 0xbb, 'UTF-8 BOM byte 2');
  assert.equal(rawBytes[2], 0xbf, 'UTF-8 BOM byte 3');

  // TextDecoder (default) strips the BOM — so the decoded text starts
  // directly at the header row (BOM itself is verified above on raw bytes).
  const text = new TextDecoder('utf-8').decode(rawBytes);
  const lines = text.split('\n');
  assert.equal(lines[0], 'Registration ID,Telegram ID,Username,First Name,Last Name,Registered At', 'exact header row');
  // Formula-injection neutralized: leading = + - @ get the single-quote prefix.
  assert.ok(lines[1].includes("'=HYPERLINK"), '= prefix neutralized');
  assert.ok(lines[2].includes("'+SUM(A1:A9)"), '+ prefix neutralized');
  assert.ok(lines[3].includes("'@cmd"), '@ prefix neutralized');
  assert.ok(!lines[4].includes("'normal"), 'plain values untouched');
  // Quote/comma escaping: quoted cells with doubled quotes.
  assert.ok(lines[1].includes('"Am,ir"'), 'comma → quoted cell');
  assert.ok(lines[1].includes('O""Brian'), 'inner quote doubled');
  // Nulls render as empty cells: first_name + last_name both null → ",,,".
  assert.ok(lines[2].includes(',,,'),
    `null name fields → empty cells (got row: ${lines[2]})`);
});

// ── CSV CR/LF regression (audit M-3) ────────────────────────────────────────
// A naive split('\n') would split INSIDE quoted fields, so these helpers
// track quote state the way a real CSV consumer (Excel / Sheets / parsers) does.

function splitCsvRecords(text) {
  const records = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (ch === '"') inQ = !inQ;
    if (ch === '\n' && !inQ) { records.push(cur); cur = ''; }
    else cur += ch;
  }
  if (cur.length) records.push(cur);
  return records;
}

function parseCsvRow(line) {
  const cells = [];
  let cur = '';
  let inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (inQ) {
      if (ch === '"') {
        if (line[i + 1] === '"') { cur += '"'; i++; }
        else inQ = false;
      } else cur += ch; // embedded CR/LF/comma stay inside the cell
    } else if (ch === '"') inQ = true;
    else if (ch === ',') { cells.push(cur); cur = ''; }
    else cur += ch;
  }
  cells.push(cur);
  return cells;
}

test('CAMA-28b: CSV CR/LF regression (M-3) — records never split, formulas never executable', async () => {
  // Crafted Telegram profile names: mid-field CR (the audit case x\r=2+5),
  // mid-field LF, dangerous leading chars with embedded CR/LF, mixed quotes.
  const crafted = [
    'x\r=2+5',                                // audit M-3 regression case
    'x\n=2+5',                                // LF mid-field
    '\r=2+5',                                 // leading CR → quote-prefixed text
    '=2+5\rcmd',                              // leading '=' with embedded CR
    '-2+5\r=SUM(1)',                          // leading '-'
    '@echo\rcmd',                             // leading '@'
    '\t=2+5',                                 // leading tab
    'a"\rb',                                  // quote + CR mixed mid-field
    '=HYPERLINK("http://evil","x")\rINJECT',  // quote + CR + classic formula
    'plain',                                  // control row untouched
  ];
  const { handlers: h } = buildHandlers({
    repo: {
      get: () => existingCampaign(),
      registrations: () => ({
        items: crafted.map((name, i) => ({
          id: i + 1, telegram_id: String(100 + i), username: null, first_name: name,
          last_name: null, registered_at: PAST,
        })),
        total: crafted.length, page: 1, limit: 1000, totalPages: 1,
      }),
    },
  });
  const res = await h.handleAdminExportRegistrations(REQ(), { DATABASE_URL: 'x' }, 'c1');
  assert.equal(res.status, 200);
  const rawBytes = new Uint8Array(await res.arrayBuffer());
  const text = new TextDecoder('utf-8').decode(rawBytes); // strips the BOM

  // One record per registration: neither CR nor LF may create a new record.
  const records = splitCsvRecords(text);
  assert.equal(records.length, crafted.length + 1, 'exactly header + one record per registration — CR/LF never split a record');
  assert.equal(records[0], 'Registration ID,Telegram ID,Username,First Name,Last Name,Registered At', 'header intact');

  for (let i = 0; i < crafted.length; i++) {
    const cells = parseCsvRow(records[i + 1]);
    assert.equal(cells.length, 6, `row ${i + 1} keeps exactly 6 cells`);
    // Neutralization contract: a leading dangerous char gained the ' prefix;
    // everything else round-trips byte-identically (embedded CR/LF included).
    const expected = /^[=+\-@\t\r]/.test(crafted[i]) ? `'${crafted[i]}` : crafted[i];
    assert.equal(cells[3], expected, `first_name round-trips: ${JSON.stringify(crafted[i])}`);
  }

  // Hard invariant: NO parsed cell in ANY data row starts with a character a
  // spreadsheet app could interpret as a formula start (=, +, -, @, tab, CR).
  for (let i = 1; i < records.length; i++) {
    for (const cell of parseCsvRow(records[i])) {
      assert.ok(!/^[=+\-@\t\r]/.test(cell), `cell starts with a formula char: ${JSON.stringify(cell)}`);
    }
  }

  // The audit case specifically: the CR survives INSIDE the quoted field of
  // ONE record — no second record, no executable "=2+5" fragment.
  assert.ok(records[1].includes('"x\r=2+5"'), 'the CR field is emitted quoted');
  assert.equal(parseCsvRow(records[1])[3], 'x\r=2+5');
});

// ── Audit logging ─────────────────────────────────────────────────────────

test('CAMA-29: mutations are audited to admin_logs; reads never log', async () => {
  const logCalls = [];
  const baseRepo = {
    get: () => existingCampaign({ status: 'PUBLISHED' }),
    registrations: () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
  };
  // Dedicated harness whose logAdminAction pushes into the SHARED capture, so
  // all four mutations can run with different bodies but one log array.
  function makeShared(body) {
    const calls = { requireAdmin: [], rateLimit: [], repo: [], log: logCalls };
    const repo = {
      ensureSchema: async () => {},
      listCampaignsAdmin: async () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 }),
      getCampaignById: async () => baseRepo.get(),
      createCampaign: async (env, data) => { calls.repo.push(['create', data]); return { id: 'new-1', ...data, registration_count: 0 }; },
      updateCampaign: async (env, id, fields) => { calls.repo.push(['update', id, fields]); return { id, ...fields, registration_count: 0 }; },
      setCampaignStatus: async (env, id, s) => { calls.repo.push(['setStatus', id, s]); return { id, status: s, registration_count: 0 }; },
      softDeleteCampaign: async (env, id) => { calls.repo.push(['softDelete', id]); return true; },
      listRegistrations: async () => baseRepo.registrations(),
    };
    const handlers = createCampaignsAdminHandlers({
      jsonResponse: (payload, init = {}) => ({ __json: payload, __status: init.status || 200 }),
      requireAdmin: async () => ({ error: null, admin: { telegram_id: '900' } }),
      readJsonBody: async () => ({ payload: body }),
      safeDbErrorResponse: () => ({ __json: {}, __status: 503 }),
      safeError: () => 'x',
      isDatabaseConfigured: () => true,
      isUserRateLimited: async () => false,
      campaignsRepo: repo,
      adminRepo: { logAdminAction: async (env, entry) => { logCalls.push(entry); return 1; } },
      withCors: (h2 = {}) => new Headers(h2),
      isValidImageUrl,
    });
    return { handlers, calls };
  }
  await makeShared({ ...VALID_CREATE }).handlers.handleAdminCreateCampaign(REQ(), { DATABASE_URL: 'x' });
  await makeShared({ title_en: 'New' }).handlers.handleAdminUpdateCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');
  await makeShared({ status: 'STOPPED' }).handlers.handleAdminSetCampaignStatus(REQ(), { DATABASE_URL: 'x' }, 'c1');
  await makeShared(null).handlers.handleAdminDeleteCampaign(REQ(), { DATABASE_URL: 'x' }, 'c1');

  const actions = logCalls.map((l) => l.action);
  assert.deepEqual(actions, ['campaigns_admin.create', 'campaigns_admin.update', 'campaigns_admin.status', 'campaigns_admin.delete']);
  for (const l of logCalls) {
    assert.equal(l.admin_id, '900', 'admin id from requireAdmin');
    assert.equal(l.target_type, 'promo_campaign');
    assert.equal(l.target_id, l.action === 'campaigns_admin.create' ? 'new-1' : 'c1');
  }
  const statusLog = logCalls.find((l) => l.action === 'campaigns_admin.status');
  assert.deepEqual(statusLog.details, { from: 'PUBLISHED', to: 'STOPPED' }, 'status log records from/to');
  // create log keeps a compact summary (no full body dump).
  const createLog = logCalls.find((l) => l.action === 'campaigns_admin.create');
  assert.ok(!('body_fa' in createLog.details), 'no full body dump into admin_logs');

  // Reads never log.
  const { handlers: hr, calls: cr } = buildHandlers({ repo: { get: () => existingCampaign(), registrations: () => ({ items: [], total: 0, page: 1, limit: 20, totalPages: 1 }) } });
  await hr.handleAdminListCampaigns(REQ(), {});
  await hr.handleAdminGetCampaign(REQ(), {}, 'c1');
  await hr.handleAdminListRegistrations(REQ(), {}, 'c1');
  await hr.handleAdminExportRegistrations(REQ(), {}, 'c1');
  assert.deepEqual(cr.log, [], 'reads are not audited');
});

// ── Misc guards ────────────────────────────────────────────────────────────

test('CAMA-30: malformed ids → 400 INVALID_CAMPAIGN_ID everywhere; 503 when DB not configured', async () => {
  const { handlers } = buildHandlers({});
  for (const [name, bad] of [
    ['handleAdminGetCampaign', '../etc/passwd'],
    ['handleAdminUpdateCampaign', 'bad/id!!'],
    ['handleAdminSetCampaignStatus', 'x'.repeat(65)],
    ['handleAdminDeleteCampaign', '%20'],
    ['handleAdminListRegistrations', 'nope?search=1'],
    ['handleAdminExportRegistrations', 'ok id'],
  ]) {
    const res = await handlers[name](REQ(), {}, bad);
    assert.equal(res.__status, 400, `${name} with malformed id → 400`);
    assert.equal(res.__json.code, 'INVALID_CAMPAIGN_ID');
  }
  const { handlers: h503 } = buildHandlers({ dbConfigured: false, body: {} });
  assert.equal((await h503.handleAdminListCampaigns(REQ(), {})).__status, 503);
  assert.equal((await h503.handleAdminGetCampaign(REQ(), {}, 'c1')).__status, 503);
  assert.equal((await h503.handleAdminCreateCampaign(REQ(), {}, {})).__status, 503);
});

test('CAMA-31: list — status filter whitelist, search/page/limit bounds, 200 shape', async () => {
  const { handlers } = buildHandlers({});
  const bad = await handlers.handleAdminListCampaigns(REQ('https://x/api/admin/campaigns?status=ARCHIVED'), { DATABASE_URL: 'x' });
  assert.equal(bad.__status, 400);
  assert.equal(bad.__json.code, 'INVALID_STATUS_FILTER');

  const { handlers: h, calls } = buildHandlers({
    repo: { list: (p) => ({ items: [], total: 0, ...p, totalPages: 1 }) },
  });
  const res = await h.handleAdminListCampaigns(REQ('https://x/api/admin/campaigns?status=DRAFT&search=bit&limit=999&page=0'), { DATABASE_URL: 'x' });
  assert.equal(res.__status, 200);
  assert.equal(res.__json.status, 'success');
  const listCall = calls.repo.find((c) => c[0] === 'list')[1];
  assert.equal(listCall.status, 'DRAFT');
  assert.equal(listCall.search, 'bit', 'search param trimmed and passed through');
  assert.equal(listCall.limit, 100, 'limit clamped to 100');
  assert.equal(listCall.page, 1, 'page floored at 1');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3. ROUTE WIRING (worker-proxy.js)
// ═══════════════════════════════════════════════════════════════════════════

test('CAMA-40: the 10 admin route matchers are wired exactly as designed', () => {
  // Base list/create.
  assert.match(WORKER, /request\.method === 'GET' && url\.pathname === '\/api\/admin\/campaigns'/);
  assert.match(WORKER, /request\.method === 'POST' && url\.pathname === '\/api\/admin\/campaigns'/);
  // WebP image upload (must exist; single-segment matcher is method-scoped to GET/PUT/PATCH/DELETE).
  assert.match(WORKER, /request\.method === 'POST' && url\.pathname === '\/api\/admin\/campaigns\/upload-image'/);
  assert.match(WORKER, /campaignsAdminHandlers\.handleAdminUploadCampaignImage/);
  // Single-segment :id (anchored so sub-paths fall through).
  assert.match(WORKER, /\/\^\\\/api\\\/admin\\\/campaigns\\\/\[A-Za-z0-9_-\]\{1,64\}\$\/\.test\(url\.pathname\)/);
  assert.match(WORKER, /request\.method === 'GET'\) return campaignsAdminHandlers\.handleAdminGetCampaign/);
  assert.match(WORKER, /request\.method === 'PUT' \|\| request\.method === 'PATCH'\) return campaignsAdminHandlers\.handleAdminUpdateCampaign/);
  assert.match(WORKER, /request\.method === 'DELETE'\) return campaignsAdminHandlers\.handleAdminDeleteCampaign/);
  // /status with PUT+POST alias.
  assert.match(WORKER, /\(request\.method === 'PUT' \|\| request\.method === 'POST'\) && \/\^\\\/api\\\/admin\\\/campaigns\\\/\[A-Za-z0-9_-\]\{1,64\}\\\/status\$\/\.test\(url\.pathname\)/);
  assert.match(WORKER, /campaignsAdminHandlers\.handleAdminSetCampaignStatus/);
  // Registrations + export.
  assert.match(WORKER, /\\\/registrations\$\/\.test\(url\.pathname\)/);
  assert.match(WORKER, /campaignsAdminHandlers\.handleAdminListRegistrations/);
  assert.match(WORKER, /\\\/registrations\\\/export\$\/\.test\(url\.pathname\)/);
  assert.match(WORKER, /campaignsAdminHandlers\.handleAdminExportRegistrations/);
  // Dispatch order sanity: export matcher is present (anchored) — and the
  // :id matcher cannot swallow sub-paths (anchored $ everywhere).
});

test('CAMA-41: factory wiring — deps incl. requireAdmin, campaignsRepo, adminRepo, withCors, isValidImageUrl', () => {
  assert.match(WORKER, /import \{ createCampaignsAdminHandlers \} from '\.\/src\/controllers\/campaigns_admin\.js';/);
  assert.match(WORKER, /import \{ isValidImageUrl \} from '\.\/src\/repositories\/advertisements\.js';/);
  assert.match(WORKER, /const campaignsAdminHandlers = createCampaignsAdminHandlers\(\{/);
  const wiring = WORKER.slice(WORKER.indexOf('const campaignsAdminHandlers = createCampaignsAdminHandlers({'));
  const block = wiring.slice(0, wiring.indexOf('});'));
  for (const dep of ['requireAdmin: adminHandlers.requireAdmin', 'campaignsRepo', 'adminRepo', 'advertisementsRepo', 'withCors', 'isValidImageUrl', 'isUserRateLimited']) {
    assert.ok(block.includes(dep), `factory receives ${dep}`);
  }
});

test('CAMA-42: PROTECTED_PATHS gate covers the USER routes but NOT the admin routes', () => {
  const line = WORKER.match(/^.*PROTECTED_PATHS = .*$/m)[0];
  const PROTECTED_PATHS = new Function(line + '\nreturn PROTECTED_PATHS;')();
  assert.ok(PROTECTED_PATHS.test('/api/campaigns'), 'user routes stay behind the auth+channel gate');
  assert.ok(!PROTECTED_PATHS.test('/api/admin/campaigns'), 'admin base route NOT channel-gated');
  assert.ok(!PROTECTED_PATHS.test('/api/admin/campaigns/c1/registrations'), 'admin registrations NOT channel-gated');
  assert.ok(!PROTECTED_PATHS.test('/api/admin/campaigns/upload-image'), 'upload route NOT channel-gated (admin-authenticated)');
});

// ═══════════════════════════════════════════════════════════════════════════
// 3b. WEBP IMAGE UPLOAD ENDPOINT (campaigns.manage, WebP-only)
// ═══════════════════════════════════════════════════════════════════════════

const WEBP_URI = 'data:image/webp;base64,UklGRhoAAABXRUJQVlA4TA0AAAAvAAAAEAcQERGIiP4HAA==';
const JPEG_URI = 'data:image/jpeg;base64,/9j/4AAQSkZJRgABAQEAYABgAAD//gA=';

test('CAMA-60: upload-image gated by campaigns.manage + admin-mutation rate limit BEFORE storage', async () => {
  const { handlers, calls } = buildHandlers({ body: { data_uri: WEBP_URI } });
  const res = await handlers.handleAdminUploadCampaignImage(REQ('https://x/api/admin/campaigns/upload-image'), { RATE_LIMITS: 'on', DATABASE_URL: 'x' });
  assert.equal(res.__status, 200);
  assert.deepEqual(calls.requireAdmin, ['campaigns.manage'], 'upload requires campaigns.manage');
  assert.deepEqual(calls.rateLimit, [['900', 'admin-mutation', 20, 60]], 'rate limit checked');
  assert.equal(calls.storeImage.length, 1, 'storeImage called exactly once');
});

test('CAMA-61: upload-image rejects non-WebP payloads with 422 WEBP_REQUIRED (JPG/PNG/SVG/raw) and never stores them', async () => {
  for (const [label, uri] of [
    ['jpeg', JPEG_URI],
    ['png', 'data:image/png;base64,iVBORw0KGgoAAAANSUhEUg=='],
    ['svg', 'data:image/svg+xml;base64,PHN2ZyB4bWxucz0iaHR0cDovL3d3dy53My5vcmcvMjAwMC9zdmciPjwvc3ZnPg=='],
    ['gif', 'data:image/gif;base64,R0lGODlhAQABAAAAACw='],
    ['no-data-uri', 'not-a-data-uri'],
  ]) {
    const { handlers, calls } = buildHandlers({ body: { data_uri: uri } });
    const res = await handlers.handleAdminUploadCampaignImage(REQ(), {});
    assert.equal(res.__status, 422, `${label} → 422`);
    assert.equal(res.__json.code, 'WEBP_REQUIRED', `${label} → WEBP_REQUIRED`);
    assert.equal(calls.storeImage.length, 0, `${label} must NEVER reach storage`);
  }
});

test('CAMA-62: upload-image requires data_uri (422 IMAGE_REQUIRED); body errors pass through', async () => {
  const { handlers } = buildHandlers({ body: {} });
  const res = await handlers.handleAdminUploadCampaignImage(REQ(), {});
  assert.equal(res.__status, 422);
  assert.equal(res.__json.code, 'IMAGE_REQUIRED');

  const { handlers: h2 } = buildHandlers({ bodyError: { __json: { detail: 'Request body too large' }, __status: 413 } });
  const res2 = await h2.handleAdminUploadCampaignImage(REQ(), {});
  assert.equal(res2.__status, 413, 'readJsonBody errors (size cap) pass through');
});

test('CAMA-63: valid WebP → 200 { status, url } + internal URL + audit log', async () => {
  const { handlers, calls } = buildHandlers({ body: { data_uri: WEBP_URI } });
  const res = await handlers.handleAdminUploadCampaignImage(REQ(), {});
  assert.equal(res.__status, 200);
  assert.equal(res.__json.status, 'success');
  assert.equal(res.__json.url, '/api/advertisements/image/img_test1234', 'returns the internal (KV-served) URL form');
  assert.equal(calls.storeImage[0].contentType, 'image/webp', 'storeImage receives image/webp');
  assert.equal(calls.storeImage[0].dataUri, WEBP_URI);
  assert.equal(calls.log.length, 1, 'mutation is audited');
  assert.equal(calls.log[0].action, 'campaigns_admin.upload_image');
});

test('CAMA-64: storage failures (oversize / magic mismatch) → 422 UPLOAD_FAILED, message surfaced, nothing faked', async () => {
  for (const [label, err] of [
    ['oversize', new Error('Image too large: 640000 bytes (max 512000)')],
    ['magic mismatch', new Error('Image content does not match declared content-type')],
    ['kv unavailable', new Error('Image storage unavailable (KV not bound)')],
  ]) {
    const { handlers, calls } = buildHandlers({
      body: { data_uri: WEBP_URI },
      storeImageImpl: () => { throw err; },
    });
    const res = await handlers.handleAdminUploadCampaignImage(REQ(), {});
    assert.equal(res.__status, 422, `${label} → 422 UPLOAD_FAILED`);
    assert.equal(res.__json.code, 'UPLOAD_FAILED');
    assert.ok(res.__json.message.includes(label === 'oversize' ? 'too large' : label === 'magic mismatch' ? 'does not match' : 'unavailable'),
      `${label} message surfaced honestly`);
    assert.equal(calls.log.length, 0, 'failed uploads are NOT audited as success');
  }
});

test('CAMA-65: unauthorized admin → auth error passes through before any storage call', async () => {
  const { handlers, calls } = buildHandlers({
    authError: { __json: { detail: 'Insufficient permissions' }, __status: 403 },
    body: { data_uri: WEBP_URI },
  });
  const res = await handlers.handleAdminUploadCampaignImage(REQ(), {});
  assert.equal(res.__status, 403);
  assert.equal(calls.storeImage.length, 0);
  assert.equal(calls.rateLimit.length, 0, 'no rate-limit slot burned for unauthorized callers');
});

test('CAMA-66: rate-limited admin → 429 before storage', async () => {
  const { handlers, calls } = buildHandlers({ rateLimited: true, body: { data_uri: WEBP_URI } });
  const res = await handlers.handleAdminUploadCampaignImage(REQ(), { RATE_LIMITS: 'on', DATABASE_URL: 'x' });
  assert.equal(res.__status, 429);
  assert.equal(res.__json.code, 'RATE_LIMITED');
  assert.equal(calls.storeImage.length, 0);
});

// ═══════════════════════════════════════════════════════════════════════════
// 4. BOUNDARY / NON-REGRESSION
// ═══════════════════════════════════════════════════════════════════════════

test('CAMA-50: no schema changes, no CASCADE, no cross-module table access, revoke coverage intact', () => {
  // The repo never mutates schema or cascades anything.
  for (const forbidden of ['ALTER TABLE', 'DROP TABLE', 'DROP INDEX', 'TRUNCATE', 'ON DELETE CASCADE', 'CREATE TABLE AS']) {
    assert.ok(!REPO_SRC.includes(forbidden), `repo must not contain "${forbidden}"`);
  }
  // Cross-module boundary: only the two promo tables (+ users read via JOIN);
  // never the reward_center `campaigns` table or other modules' tables.
  for (const foreign of ['wallet_transactions', 'alerts', 'membership_requests', 'membership_users', 'payments', 'referrals']) {
    assert.ok(!REPO_SRC.includes(foreign), `repo must not touch ${foreign}`);
  }
  assert.doesNotMatch(REPO_SRC, /\bFROM campaigns\b/, 'never reads reward_center campaigns');
  assert.doesNotMatch(REPO_SRC, /\bINTO campaigns\b/, 'never writes reward_center campaigns');
  // The controller holds no SQL at all (delegated to the repo).
  assert.ok(!CTRL_SRC.includes('queryDb'), 'controller never queries the DB directly');
  assert.ok(!CTRL_SRC.includes('request.json()'), 'body parsing only via readJsonBody (size-limited)');
  // Section 1 is intact: the revoke script still strips anon/authenticated
  // grants from BOTH promo tables (needed again post-migration).
  assert.ok(REVOKE.includes('promo_campaigns'), 'revoke script covers promo_campaigns');
  assert.ok(REVOKE.includes('promo_campaign_registrations'), 'revoke script covers promo_campaign_registrations');
  // The 5B migration is untouched by this stage (no new tables needed).
  const MIGRATE = read('scripts/00-migrate.sql');
  assert.equal((MIGRATE.match(/CREATE TABLE IF NOT EXISTS promo_campaigns \(/g) || []).length, 1, 'exactly one promo_campaigns definition');
  assert.equal((MIGRATE.match(/CREATE TABLE IF NOT EXISTS promo_campaign_registrations \(/g) || []).length, 1, 'exactly one registrations definition');
});

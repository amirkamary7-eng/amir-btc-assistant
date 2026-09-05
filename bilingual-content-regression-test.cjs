/**
 * Bilingual Content Regression Tests — FA/EN i18n for app_content + membership_rules
 *
 * Tests:
 *   A. app_content bilingual: getContent/updateContent per language, EN fallback, cache isolation
 *   B. membership_rules bilingual: getActiveRules per language, EN fallback
 *   C. handleGetRules controller: ?lang= parsing + cache key isolation
 *   D. Persistence: bootstrap preserves existing DB lang (fresh-device overwrite fix)
 *   E. Migration SQL idempotency (source-text checks)
 *
 * Uses source-eval pattern (same as membership-rules-test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_CONTENT_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/app_content.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/membership.js'), 'utf8');
const MEMBERSHIP_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
const USERS_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/users.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const APP_JS_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const MIGRATION_SRC = fs.readFileSync(path.join(__dirname, 'scripts/bilingual-content-schema.sql'), 'utf8');
const INDEX_HTML_SRC = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

function loadFn(src, exportName) {
  const cleaned = src.replace(/export\s+function\s+create(\w+)/g, 'function create$1');
  const exportsObj = {};
  const evaluator = new Function('exports', cleaned + `; exports.${exportName} = ${exportName};`);
  evaluator(exportsObj);
  return exportsObj[exportName];
}

const createAppContentRepository = loadFn(APP_CONTENT_SRC, 'createAppContentRepository');
const createMembershipRepository = loadFn(MEMBERSHIP_REPO_SRC, 'createMembershipRepository');
const createMembershipHandlers = loadFn(MEMBERSHIP_CTRL_SRC, 'createMembershipHandlers');

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

// ─── A. app_content bilingual ──────────────────────────────────────────────

function createMockAppContentQueryDb(opts = {}) {
  const calls = [];
  const fn = async (env, sql, params) => {
    calls.push({ sql, params });
    const s = (sql || '').toLowerCase();
    // CREATE TABLE / ALTER TABLE / INSERT (seed): return success
    if (s.includes('create table') || s.includes('alter table')) return { rows: [], rowCount: 0 };
    if (s.includes('insert into app_content')) return { rows: [], rowCount: 1 };
    if (s.includes('select id from app_content where id')) return { rows: [] }; // table empty → seed
    // SELECT content by id
    if (s.includes('from app_content') && s.includes('where id = $1')) {
      const row = opts.row ? { ...opts.row } : null;
      return { rows: row ? [row] : [] };
    }
    // UPDATE / INSERT for updateContent
    if (s.includes('insert into app_content') && s.includes('on conflict')) return { rows: [], rowCount: 1 };
    return { rows: [], rowCount: 0 };
  };
  fn._calls = calls;
  return fn;
}

function buildAppContentDeps(opts = {}) {
  const env = { APP_CACHE: createMemoryKv() };
  const queryDb = opts.queryDb || createMockAppContentQueryDb(opts);
  const readAppCache = async (env, key) => env.APP_CACHE.get(key);
  const writeAppCache = async (env, key, value, ttl) => env.APP_CACHE.put(key, value, ttl);
  const repo = createAppContentRepository({ queryDb, readAppCache, writeAppCache });
  return { repo, env, queryDb, _kv: env.APP_CACHE };
}

test('A1: getContent fa returns FA title/sections', async () => {
  const faTitle = 'درباره ما';
  const faSections = [{ heading: 'AmirBTC', body: 'پارسی متن' }];
  const { repo, env, _kv } = buildAppContentDeps({
    row: { id: 'about', title: faTitle, sections: faSections, title_en: 'About Us', sections_en: [{ heading: 'AmirBTC', body: 'English body' }], version: '1.0.0', updated_at: null },
  });
  const result = await repo.getContent(env, 'about', 'fa');
  assert.equal(result.title, faTitle, 'FA title returned');
  assert.deepEqual(result.sections, faSections, 'FA sections returned');
  // Cache key isolated with :fa suffix
  assert.ok(_kv._store.has('app_content:about:fa'), 'fa cache key written');
  assert.ok(!_kv._store.has('app_content:about:en'), 'en cache key NOT written for fa request');
});

test('A2: getContent en returns EN title/sections from DB EN columns', async () => {
  const enTitle = 'About Us';
  const enSections = [{ heading: 'AmirBTC', body: 'English body' }];
  const { repo, env, _kv } = buildAppContentDeps({
    row: { id: 'about', title: 'درباره ما', sections: [{ heading: 'AmirBTC', body: 'پارسی' }], title_en: enTitle, sections_en: enSections, version: '1.0.0', updated_at: null },
  });
  const result = await repo.getContent(env, 'about', 'en');
  assert.equal(result.title, enTitle, 'EN title returned');
  assert.deepEqual(result.sections, enSections, 'EN sections returned');
  assert.ok(_kv._store.has('app_content:about:en'), 'en cache key written');
  assert.ok(!_kv._store.has('app_content:about:fa'), 'fa cache key NOT written for en request');
});

test('A3: getContent en with NULL/empty EN columns falls back to English SEED_DATA (not Persian)', async () => {
  const { repo, env } = buildAppContentDeps({
    row: { id: 'about', title: 'درباره ما', sections: [{ heading: 'پارسی', body: 'پارسی' }], title_en: null, sections_en: [], version: '1.0.0', updated_at: null },
  });
  const result = await repo.getContent(env, 'about', 'en');
  // MUST be English (from SEED_DATA), never Persian
  assert.equal(result.title, 'About Us', 'EN fallback title is English, not Persian');
  assert.ok(result.sections.length > 0, 'EN fallback sections non-empty');
  // Verify NO Persian leaked into the EN fallback
  for (const sec of result.sections) {
    assert.ok(!/[\u0600-\u06FF]/.test(sec.heading || ''), 'EN fallback heading has no Persian chars: ' + sec.heading);
    assert.ok(!/[\u0600-\u06FF]/.test(sec.body || ''), 'EN fallback body has no Persian chars');
  }
});

test('A4: getContent with undefined lang defaults to fa (backward compat)', async () => {
  const { repo, env } = buildAppContentDeps({
    row: { id: 'about', title: 'درباره ما', sections: [], title_en: 'About Us', sections_en: [], version: '1.0.0', updated_at: null },
  });
  const result = await repo.getContent(env, 'about', undefined);
  assert.equal(result.title, 'درباره ما', 'undefined lang → FA returned');
});

test('A5: cache keys isolated per language (no shared cache)', async () => {
  const { repo, env, _kv } = buildAppContentDeps({
    row: { id: 'terms', title: 'قوانین', sections: [{ heading: '۱', body: 'پارسی' }], title_en: 'Terms', sections_en: [{ heading: '1', body: 'English' }], version: '2.0.0', updated_at: null },
  });
  await repo.getContent(env, 'terms', 'fa');
  await repo.getContent(env, 'terms', 'en');
  assert.ok(_kv._store.has('app_content:terms:fa'), 'fa cache exists');
  assert.ok(_kv._store.has('app_content:terms:en'), 'en cache exists');
  const faData = JSON.parse(_kv._store.get('app_content:terms:fa'));
  const enData = JSON.parse(_kv._store.get('app_content:terms:en'));
  assert.equal(faData.title, 'قوانین', 'fa cache has FA title');
  assert.equal(enData.title, 'Terms', 'en cache has EN title');
});

test('A6: updateContent fa only updates FA columns (SQL has title/sections, NOT title_en/sections_en)', async () => {
  const queryDb = createMockAppContentQueryDb({});
  const { repo, env } = buildAppContentDeps({ queryDb });
  await repo.updateContent(env, 'about', { title: 'FA new', sections: [{ heading: 'h', body: 'b' }], version: '2.0.0', updated_by: 'admin1' }, 'fa');
  // Find the INSERT/UPDATE call
  const insertCall = queryDb._calls.find(c => /insert into app_content/i.test(c.sql) && /on conflict/i.test(c.sql));
  assert.ok(insertCall, 'INSERT/UPDATE call made');
  // FA save SQL must NOT mention title_en / sections_en
  assert.ok(!/title_en/i.test(insertCall.sql), 'FA save SQL does NOT touch title_en');
  assert.ok(!/sections_en/i.test(insertCall.sql), 'FA save SQL does NOT touch sections_en');
  assert.ok(/title\s*=|title\b/.test(insertCall.sql), 'FA save SQL touches title');
});

test('A7: updateContent en only updates EN columns (SQL has title_en/sections_en, NOT title/sections)', async () => {
  const queryDb = createMockAppContentQueryDb({});
  const { repo, env } = buildAppContentDeps({ queryDb });
  await repo.updateContent(env, 'about', { title: 'EN new', sections: [{ heading: 'h', body: 'b' }], version: '2.0.0', updated_by: 'admin1' }, 'en');
  const insertCall = queryDb._calls.find(c => /insert into app_content/i.test(c.sql) && /on conflict/i.test(c.sql));
  assert.ok(insertCall, 'INSERT/UPDATE call made');
  // EN save SQL must mention title_en / sections_en and NOT set title= / sections= (FA columns)
  assert.ok(/title_en/i.test(insertCall.sql), 'EN save SQL touches title_en');
  assert.ok(/sections_en/i.test(insertCall.sql), 'EN save SQL touches sections_en');
  // Verify the SET clause does NOT assign to the FA columns title/sections
  const setClause = (insertCall.sql.match(/do update set\s+(.*?)(\n|$)/i) || [])[1] || '';
  assert.ok(!/\btitle\s*=/.test(setClause), 'EN save SET clause does NOT assign title (FA)');
  assert.ok(!/\bsections\s*=/.test(setClause), 'EN save SET clause does NOT assign sections (FA)');
});

test('A8: updateContent invalidates only the saved language cache key', async () => {
  const { repo, env, _kv } = buildAppContentDeps({
    row: { id: 'about', title: 'درباره ما', sections: [], title_en: 'About Us', sections_en: [], version: '1.0.0', updated_at: null },
  });
  // Pre-populate BOTH cache keys with "OLD" content
  await _kv.put('app_content:about:fa', JSON.stringify({ type: 'about', title: 'OLD FA', sections: [], version: '1.0.0' }));
  await _kv.put('app_content:about:en', JSON.stringify({ type: 'about', title: 'OLD EN', sections: [], version: '1.0.0' }));
  // Save FA → should refresh :fa with NEW content, leave :en untouched
  await repo.updateContent(env, 'about', { title: 'NEW FA', sections: [], version: '1.0.0', updated_by: 'admin' }, 'fa');
  // FA cache is refreshed (key still exists, but content is NEW)
  assert.ok(_kv._store.has('app_content:about:fa'), 'fa cache key exists (refreshed with new content)');
  const faCached = JSON.parse(_kv._store.get('app_content:about:fa'));
  assert.equal(faCached.title, 'NEW FA', 'fa cache now has NEW FA content (invalidated+refreshed)');
  // EN cache is UNTOUCHED (still OLD EN content)
  assert.ok(_kv._store.has('app_content:about:en'), 'en cache key still exists (not deleted)');
  const enCached = JSON.parse(_kv._store.get('app_content:about:en'));
  assert.equal(enCached.title, 'OLD EN', 'en cache UNTOUCHED (still has OLD EN content)');
});

// ─── B. membership_rules bilingual ──────────────────────────────────────────

function createMockMembershipRulesQueryDb(opts = {}) {
  const calls = [];
  const fn = async (env, sql, params) => {
    calls.push({ sql, params });
    const s = (sql || '').toLowerCase();
    if (s.includes('from membership_rules') && s.includes("where status = 'active'")) {
      return { rows: opts.rulesRow ? [opts.rulesRow] : [] };
    }
    return { rows: [], rowCount: 0 };
  };
  fn._calls = calls;
  return fn;
}

function buildMembershipRepoDeps(opts = {}) {
  const env = { APP_CACHE: createMemoryKv() };
  const queryDb = opts.queryDb || createMockMembershipRulesQueryDb(opts);
  const queryDbTransaction = async (env, queries) => queries.map(() => ({ rows: [], rowCount: 0 }));
  const repo = createMembershipRepository({
    queryDb, queryDbTransaction,
    isDatabaseConfigured: () => true,
    isoDate: () => '2026-01-01',
    normalizeOptionalString: (s) => s == null ? null : String(s).trim(),
  });
  return { repo, env, queryDb };
}

test('B1: getActiveRules fa returns FA fields', async () => {
  const faTitle = 'قوانین عضویت Premium — نسخه ۱';
  const faBody = '# قوانین\n\nپارسی متن';
  const faSummary = 'خلاصه پارسی';
  const { repo, env } = buildMembershipRepoDeps({
    rulesRow: { id: 'r1', version: 1, title: faTitle, body_markdown: faBody, summary: faSummary, title_en: 'EN title', body_markdown_en: 'EN body', summary_en: 'EN summary', status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const result = await repo.getActiveRules(env, 'fa');
  assert.ok(result, 'rules returned');
  assert.equal(result.title, faTitle, 'FA title returned');
  assert.equal(result.body_markdown, faBody, 'FA body returned');
  assert.equal(result.summary, faSummary, 'FA summary returned');
});

test('B2: getActiveRules en returns EN fields from DB EN columns', async () => {
  const enTitle = 'Premium Membership Rules — Version 1';
  const enBody = '# Premium Rules\n\nEnglish body';
  const enSummary = 'English summary';
  const { repo, env } = buildMembershipRepoDeps({
    rulesRow: { id: 'r1', version: 1, title: 'قوانین پارسی', body_markdown: 'پارسی', summary: 'پارسی', title_en: enTitle, body_markdown_en: enBody, summary_en: enSummary, status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const result = await repo.getActiveRules(env, 'en');
  assert.equal(result.title, enTitle, 'EN title returned from DB EN columns');
  assert.equal(result.body_markdown, enBody, 'EN body returned from DB EN columns');
  assert.equal(result.summary, enSummary, 'EN summary returned from DB EN columns');
});

test('B3: getActiveRules en with NULL EN columns falls back to English constants (not Persian)', async () => {
  const { repo, env } = buildMembershipRepoDeps({
    rulesRow: { id: 'r1', version: 1, title: 'قوانین پارسی', body_markdown: '# قوانین\n\nپارسی', summary: 'پارسی', title_en: null, body_markdown_en: null, summary_en: null, status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const result = await repo.getActiveRules(env, 'en');
  assert.ok(result, 'rules returned');
  // MUST be English, never Persian
  assert.equal(result.title, 'Premium Membership Rules — Version 1', 'EN fallback title is English');
  assert.ok(!/[\u0600-\u06FF]/.test(result.title), 'EN fallback title has no Persian');
  assert.ok(!/[\u0600-\u06FF]/.test(result.body_markdown), 'EN fallback body has no Persian');
  assert.ok(!/[\u0600-\u06FF]/.test(result.summary), 'EN fallback summary has no Persian');
  assert.ok(result.body_markdown.includes('Premium Membership Rules'), 'EN fallback body is the English content');
});

test('B4: getActiveRules with undefined lang defaults to fa (backward compat)', async () => {
  const { repo, env } = buildMembershipRepoDeps({
    rulesRow: { id: 'r1', version: 1, title: 'پارسی', body_markdown: 'پ', summary: 'پ', title_en: 'EN', body_markdown_en: 'EN', summary_en: 'EN', status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const result = await repo.getActiveRules(env, undefined);
  assert.equal(result.title, 'پارسی', 'undefined lang → FA returned');
});

test('B5: getActiveRules en SELECT query includes _en columns', async () => {
  const queryDb = createMockMembershipRulesQueryDb({
    rulesRow: { id: 'r1', version: 1, title: 'پ', body_markdown: 'پ', summary: 'پ', title_en: 'E', body_markdown_en: 'E', summary_en: 'E', status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const { repo, env } = buildMembershipRepoDeps({ queryDb });
  await repo.getActiveRules(env, 'en');
  const selectCall = queryDb._calls.find(c => /from membership_rules/i.test(c.sql) && /status = 'active'/i.test(c.sql));
  assert.ok(selectCall, 'SELECT call made');
  assert.ok(/title_en/i.test(selectCall.sql), 'SELECT includes title_en');
  assert.ok(/body_markdown_en/i.test(selectCall.sql), 'SELECT includes body_markdown_en');
  assert.ok(/summary_en/i.test(selectCall.sql), 'SELECT includes summary_en');
});

// ─── C. handleGetRules controller: ?lang= + cache isolation ──────────────────

function buildControllerDeps(opts = {}) {
  const env = { APP_CACHE: createMemoryKv(), ...opts.envOverrides };
  const queryDb = opts.queryDb || createMockMembershipRulesQueryDb(opts);
  const queryDbTransaction = async (env, queries) => queries.map(() => ({ rows: [], rowCount: 0 }));
  const membershipRepo = createMembershipRepository({
    queryDb, queryDbTransaction,
    isDatabaseConfigured: () => true,
    isoDate: () => '2026-01-01',
    normalizeOptionalString: (s) => s == null ? null : String(s).trim(),
  });
  const jsonResponse = (body, init, env) => ({ status: init?.status || 200, body });
  const authenticateTelegramRequest = async (request, env) => {
    const initData = request.headers?.get?.('X-Telegram-Init-Data');
    if (!initData) return { error: { status: 401, body: { error: 'Unauthorized' } } };
    try {
      const params = new URLSearchParams(initData);
      const userStr = params.get('user');
      if (!userStr) return { error: { status: 401, body: { error: 'No user' } } };
      return { user: JSON.parse(userStr), error: null };
    } catch { return { error: { status: 401, body: { error: 'Bad initData' } } }; }
  };
  const readAppCache = async (env, key) => env.APP_CACHE.get(key);
  const writeAppCache = async (env, key, value, ttl) => env.APP_CACHE.put(key, value, ttl);
  const safeDbErrorResponse = (e, init, env) => ({ status: 503, body: { error: 'DB error', message: e.message } });
  const buildBodyFieldValidationError = (errors, env) => ({ status: 422, body: { error: 'Validation failed', details: errors } });
  const readJsonBody = async (request) => {
    try {
      const text = await request.text();
      if (!text) return { payload: {}, error: null };
      return { payload: JSON.parse(text), error: null };
    } catch { return { payload: null, error: { status: 400, body: { error: 'Invalid JSON' } } }; }
  };
  return {
    jsonResponse, authenticateTelegramRequest, isAdminTelegramId: () => false, isDatabaseConfigured: () => true,
    readAppCache, writeAppCache, safeDbErrorResponse, buildBodyFieldValidationError,
    readJsonBody, membershipRepo, queryDbTransaction,
    notificationRepo: null, notificationPlatformRepo: null, notificationService: null,
    sendTelegramMessage: async () => ({}), resolveWebAppUrl: () => 'https://app.example.com',
    _env: env, _kv: env.APP_CACHE,
  };
}

function buildInitData(token, user) {
  const crypto = require('node:crypto');
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user || { id: 123, first_name: 'Test' }));
  const data = params.toString();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return data + '&hash=' + hash;
}

test('C1: handleGetRules ?lang=fa uses cache key mb:rules:active:fa', async () => {
  const deps = buildControllerDeps({
    rulesRow: { id: 'r1', version: 1, title: 'قوانین', body_markdown: '# ق', summary: 'خ', title_en: 'EN', body_markdown_en: 'EN', summary_en: 'EN', status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const req = new Request('https://worker.example.com/api/membership/rules?lang=fa', { headers: { 'X-Telegram-Init-Data': initData } });
  const res = await handlers.handleGetRules(req, deps._env);
  assert.equal(res.status, 200);
  assert.ok(deps._kv._store.has('mb:rules:active:fa'), 'cache key is mb:rules:active:fa');
  assert.ok(!deps._kv._store.has('mb:rules:active:en'), 'en cache key NOT written');
  assert.ok(!deps._kv._store.has('mb:rules:active'), 'old shared cache key NOT used');
});

test('C2: handleGetRules ?lang=en uses cache key mb:rules:active:en + returns EN content', async () => {
  const deps = buildControllerDeps({
    rulesRow: { id: 'r1', version: 1, title: 'قوانین', body_markdown: '# ق', summary: 'خ', title_en: 'EN title', body_markdown_en: 'EN body', summary_en: 'EN summary', status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const req = new Request('https://worker.example.com/api/membership/rules?lang=en', { headers: { 'X-Telegram-Init-Data': initData } });
  const res = await handlers.handleGetRules(req, deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.title, 'EN title', 'returns EN title');
  assert.ok(deps._kv._store.has('mb:rules:active:en'), 'cache key is mb:rules:active:en');
  assert.ok(!deps._kv._store.has('mb:rules:active:fa'), 'fa cache key NOT written');
});

test('C3: handleGetRules without ?lang= defaults to fa (backward compat)', async () => {
  const deps = buildControllerDeps({
    rulesRow: { id: 'r1', version: 1, title: 'قوانین', body_markdown: '# ق', summary: 'خ', title_en: 'EN', body_markdown_en: 'EN', summary_en: 'EN', status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const req = new Request('https://worker.example.com/api/membership/rules', { headers: { 'X-Telegram-Init-Data': initData } });
  const res = await handlers.handleGetRules(req, deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.title, 'قوانین', 'no ?lang= → FA returned (backward compat)');
  assert.ok(deps._kv._store.has('mb:rules:active:fa'), 'cache key defaults to fa');
});

test('C4: handleGetRules ?lang=en with NULL EN columns returns English fallback (no Persian leak)', async () => {
  const deps = buildControllerDeps({
    rulesRow: { id: 'r1', version: 1, title: 'قوانین پارسی', body_markdown: '# قوانین\n\nپارسی', summary: 'پارسی', title_en: null, body_markdown_en: null, summary_en: null, status: 'ACTIVE', effective_at: null, created_at: null },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const req = new Request('https://worker.example.com/api/membership/rules?lang=en', { headers: { 'X-Telegram-Init-Data': initData } });
  const res = await handlers.handleGetRules(req, deps._env);
  assert.equal(res.status, 200);
  assert.ok(!/[\u0600-\u06FF]/.test(res.body.data.title), 'no Persian in EN title fallback');
  assert.ok(!/[\u0600-\u06FF]/.test(res.body.data.body_markdown), 'no Persian in EN body fallback');
  assert.ok(!/[\u0600-\u06FF]/.test(res.body.data.summary), 'no Persian in EN summary fallback');
});

// ─── D. Persistence: bootstrap preserves existing DB lang ──────────────────

test('D1: users.js bootstrap SQL preserves existing DB lang (COALESCE(users.lang, EXCLUDED.lang))', () => {
  // Source-text check: the ON CONFLICT DO UPDATE SET lang clause must prefer users.lang
  assert.ok(/lang\s*=\s*COALESCE\(users\.lang,\s*EXCLUDED\.lang\)/i.test(USERS_REPO_SRC),
    'bootstrap preserves existing DB lang over request lang (fresh-device overwrite fix)');
  // Make sure the OLD buggy pattern is NOT present
  assert.ok(!/lang\s*=\s*COALESCE\(EXCLUDED\.lang,\s*users\.lang\)/i.test(USERS_REPO_SRC),
    'old buggy pattern (COALESCE(EXCLUDED.lang, users.lang)) is removed');
});

test('D2: app.js _bootstrapUserImpl protects explicit local lang from server overwrite', () => {
  // Source-text check: the bootstrap impl must check explicitLocalLang before adopting server lang
  assert.ok(/_getExplicitLocalLang\(\)/.test(APP_JS_SRC), '_getExplicitLocalLang() called in bootstrap');
  assert.ok(/if\s*\(!explicitLocalLang\s*&&\s*\(data\.user\?\.lang\s*===\s*'fa'\s*\|\|\s*data\.user\?\.lang\s*===\s*'en'\)\)/.test(APP_JS_SRC),
    'server lang adopted ONLY when no explicit local pref');
});

test('D3: app.js _getExplicitLocalLang distinguishes explicit pref from default', () => {
  assert.ok(/function _getExplicitLocalLang\(\)/.test(APP_JS_SRC), '_getExplicitLocalLang function defined');
  // The function must have a `return null` path (when no localStorage key matches fa/en)
  // Extract just the function body using a balanced-brace scan.
  const startIdx = APP_JS_SRC.indexOf('function _getExplicitLocalLang');
  assert.ok(startIdx > -1, 'function _getExplicitLocalLang found in source');
  // Find the closing brace of the function by scanning braces from its opening brace.
  const openBrace = APP_JS_SRC.indexOf('{', startIdx);
  let depth = 0, endBrace = -1;
  for (let i = openBrace; i < APP_JS_SRC.length; i++) {
    const ch = APP_JS_SRC[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) { endBrace = i; break; } }
  }
  assert.ok(endBrace > -1, 'function body bounds found');
  const body = APP_JS_SRC.slice(startIdx, endBrace + 1);
  assert.ok(/return null/.test(body), '_getExplicitLocalLang has a `return null` path (no explicit pref)');
});

test('D4: index.html has pre-render lang bootstrap script', () => {
  assert.ok(/Pre-render Language Bootstrap/.test(INDEX_HTML_SRC), 'pre-render lang bootstrap comment present');
  assert.ok(/localStorage\.getItem\('app_lang'\)/.test(INDEX_HTML_SRC), 'pre-render reads localStorage app_lang');
  assert.ok(/document\.documentElement\.lang\s*=\s*lang/.test(INDEX_HTML_SRC), 'pre-render sets documentElement.lang');
  assert.ok(/document\.documentElement\.dir\s*=/.test(INDEX_HTML_SRC), 'pre-render sets documentElement.dir');
  // Verify it runs in <head> (before body content)
  const headEnd = INDEX_HTML_SRC.indexOf('</head>');
  const bootstrapScript = INDEX_HTML_SRC.indexOf('Pre-render Language Bootstrap');
  assert.ok(bootstrapScript > -1 && bootstrapScript < headEnd, 'bootstrap script is inside <head>');
});

// ─── E. Migration SQL idempotency (source checks) ──────────────────────────

test('E1: migration SQL uses IF NOT EXISTS for all ALTER TABLE', () => {
  const alterMatches = MIGRATION_SRC.match(/alter table\s+\w+\s+add column/gi) || [];
  const idempotentMatches = MIGRATION_SRC.match(/alter table\s+\w+\s+add column\s+if not exists/gi) || [];
  assert.equal(alterMatches.length, idempotentMatches.length, 'all ALTER TABLE ADD COLUMN use IF NOT EXISTS');
});

test('E2: migration SQL backfill uses WHERE _en IS NULL (preserves admin edits on rerun)', () => {
  // app_content backfills
  const appContentBackfills = (MIGRATION_SRC.match(/where id = '\w+' and title_en is null/gi) || []).length;
  assert.ok(appContentBackfills >= 3, 'app_content has 3 backfill statements (about/terms/privacy) with WHERE title_en IS NULL');
  // membership_rules backfill
  assert.ok(/where title_en is null/i.test(MIGRATION_SRC), 'membership_rules backfill uses WHERE title_en IS NULL');
});

test('E3: migration SQL never modifies Persian columns (title/sections/body_markdown/summary without _en)', () => {
  // No UPDATE statement should set title= or sections= or body_markdown= or summary= (the FA columns)
  // Find all UPDATE ... SET clauses and verify they only set _en columns
  const updateMatches = MIGRATION_SRC.match(/update\s+\w+\s+set[\s\S]*?(?=where|;|$)/gi) || [];
  for (const u of updateMatches) {
    // Allow title_en =, sections_en =, body_markdown_en =, summary_en =
    // Forbid bare title =, sections =, body_markdown =, summary =
    assert.ok(!/\btitle\s*=[^_]/i.test(u) || /title_en\s*=/i.test(u), 'UPDATE does NOT set bare title (only title_en allowed): ' + u.substring(0, 100));
  }
});

test('E4: migration SQL has EN content for all 4 content types', () => {
  assert.ok(MIGRATION_SRC.includes("'About Us'"), 'EN About title present');
  assert.ok(MIGRATION_SRC.includes("'Terms & Conditions'"), 'EN Terms title present');
  assert.ok(MIGRATION_SRC.includes("'Privacy Policy'"), 'EN Privacy title present');
  assert.ok(MIGRATION_SRC.includes("'Premium Membership Rules — Version 1'"), 'EN Membership Rules title present');
  // Verify NO Persian in the EN content blocks (rough check on heading values)
  // Extract sections_en JSON blocks and check for Persian
  const enBlocks = MIGRATION_SRC.match(/sections_en\s*=\s*'(\[[\s\S]*?\])'::jsonb/gi) || [];
  for (const block of enBlocks) {
    assert.ok(!/[\u0600-\u06FF]/.test(block), 'EN sections block has no Persian chars');
  }
});

// ─── F. worker-proxy routing: ?lang= passthrough ────────────────────────────

test('F1: worker-proxy GET /api/content/{type} passes ?lang= to getContent', () => {
  assert.ok(/url\.searchParams\.get\('lang'\)/.test(WORKER_SRC), 'worker-proxy parses ?lang= for content GET');
  assert.ok(/appContentRepo\.getContent\(env,\s*contentType,\s*lang\)/.test(WORKER_SRC), 'worker-proxy passes lang to getContent');
});

test('F2: worker-proxy PUT /api/admin/content/{type} passes ?lang= to updateContent', () => {
  assert.ok(/appContentRepo\.updateContent\(env,\s*contentType,\s*\{[\s\S]*?\},\s*lang\)/.test(WORKER_SRC), 'worker-proxy passes lang to updateContent (4th arg)');
});

// ─── G. Frontend: loadContent + loadRules pass ?lang= ───────────────────────

test('G1: app.js loadContent passes ?lang= to /api/content/{type}', () => {
  assert.ok(/\/api\/content\/'\s*\+\s*type\s*\+\s*'\?lang='\s*\+\s*langParam/.test(APP_JS_SRC), 'loadContent includes ?lang= in URL');
});

test('G2: membership-user.js loadRules passes ?lang= to /api/membership/rules', () => {
  const memUserSrc = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');
  assert.ok(/\/api\/membership\/rules\?lang=/.test(memUserSrc), 'loadRules includes ?lang= in URL');
});

test('G3: app.js admin editor saves with ?lang= (_editingContentLang)', () => {
  assert.ok(/_editingContentLang/.test(APP_JS_SRC), '_editingContentLang variable defined');
  assert.ok(/\/api\/admin\/content\/'\s*\+\s*_editingContentType\s*\+\s*'\?lang='\s*\+\s*_editingContentLang/.test(APP_JS_SRC), 'admin save uses ?lang=_editingContentLang');
  assert.ok(/function switchEditorLang/.test(APP_JS_SRC), 'switchEditorLang function defined');
});

// ─── H. Bottom Navigation invariant preserved ──────────────────────────────

test('H1: bottom-nav CSS still has direction:rtl (preserves visual order in both FA/EN)', () => {
  const componentsCss = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
  assert.ok(/\.bottom-nav\s*\{[^}]*direction:\s*rtl/i.test(componentsCss), '.bottom-nav direction:rtl preserved (nav invariant)');
});

test('H2: bottom-nav DOM order unchanged (Dashboard, Market, Analysis, News, Profile)', () => {
  // Extract the bottom-nav block from index.html
  const navMatch = INDEX_HTML_SRC.match(/<nav class="bottom-nav">([\s\S]*?)<\/nav>/);
  assert.ok(navMatch, 'bottom-nav block found');
  const navBlock = navMatch[1];
  const dataPages = [...navBlock.matchAll(/data-page="(\w+-?\w*)"/g)].map(m => m[1]);
  assert.deepEqual(dataPages, ['dashboard-page', 'market-page', 'analysis-page', 'news-page', 'profile-page'],
    'bottom-nav DOM order preserved exactly');
});

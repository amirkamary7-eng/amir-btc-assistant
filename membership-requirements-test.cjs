/**
 * Phase 2 — Membership Requirements + Exchange Decoupling Tests
 *
 * Tests data-driven exchange requirements: retrieval, admin management,
 * submit validation, frontend decoupling, migration safety, security.
 * Uses source-eval pattern.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEMBERSHIP_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/membership.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const FRONTEND_SRC = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');

function loadFn(src, exportName) {
  const cleaned = src.replace(/export\s+function\s+createMembershipHandlers/, 'function createMembershipHandlers')
    .replace(/export\s+function\s+createMembershipRepository/, 'function createMembershipRepository');
  const exportsObj = {};
  const evaluator = new Function('exports', cleaned + `; exports.${exportName} = ${exportName};`);
  evaluator(exportsObj);
  return exportsObj[exportName];
}

const createMembershipHandlers = loadFn(MEMBERSHIP_CTRL_SRC, 'createMembershipHandlers');
const createMembershipRepository = loadFn(MEMBERSHIP_REPO_SRC, 'createMembershipRepository');

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return { async get(key) { return store.has(key) ? store.get(key) : null; }, async put(key, value, opts) { store.set(key, value); }, async delete(key) { store.delete(key); }, _store: store };
}

function createEnv(overrides = {}) {
  return { TELEGRAM_BOT_TOKEN: 'test-bot-token', REQUIRED_CHANNEL: 'amir_btc_2024', ADMIN_TELEGRAM_ID: '831704732', DATABASE_URL: 'postgres://mock', APP_ENV: 'development', BOT_USERNAME: '', APP_CACHE: createMemoryKv(), RATE_LIMITS: createMemoryKv(), JOIN_CACHE: createMemoryKv(), SESSION_CACHE: createMemoryKv(), ...overrides };
}

function buildInitData(token, user) {
  const params = new URLSearchParams();
  params.set('user', JSON.stringify(user || { id: 123, first_name: 'Test' }));
  const data = params.toString();
  const secret = crypto.createHmac('sha256', 'WebAppData').update(token).digest();
  const hash = crypto.createHmac('sha256', secret).update(data).digest('hex');
  return data + '&hash=' + hash;
}

function makeRequest(method, path, { initData, body, headers } = {}) {
  const h = new Headers(headers || {});
  if (initData) h.set('X-Telegram-Init-Data', initData);
  if (body && typeof body === 'object') return new Request('https://worker.example.com' + path, { method, headers: h, body: JSON.stringify(body) });
  return new Request('https://worker.example.com' + path, { method, headers: h });
}

function createMockQueryDb(opts = {}) {
  const calls = [];
  const fn = async (env, sql, params) => {
    calls.push({ sql, params });
    const s = (sql || '').toLowerCase();
    if (s.includes('from membership_requirements') && s.includes("where status = 'active'")) return { rows: opts.requirementRow ? [opts.requirementRow] : [] };
    if (s.includes('from membership_requirements') && s.includes('where version =')) {
      const v = Number(params?.[0]);
      return { rows: (opts.requirementRow && opts.requirementRow.version === v) ? [opts.requirementRow] : (opts.requirementByVersion ? [opts.requirementByVersion(v)] : []) };
    }
    if (s.includes('from membership_requirements') && s.includes('order by version desc')) return { rows: opts.allRequirements || [] };
    if (s.includes('from membership_rules') && s.includes("where status = 'active'")) return { rows: opts.rulesRow ? [opts.rulesRow] : [] };
    if (s.includes('from membership_rule_acceptances')) return { rows: opts.acceptanceRow ? [opts.acceptanceRow] : [] };
    if (s.includes('insert into membership_rule_acceptances')) return { rows: [{ id: 'acc-1', telegram_id: String(params?.[0]), rules_version: Number(params?.[1]), accepted_at: new Date().toISOString() }] };
    if (s.includes('from membership_users') && s.includes('where telegram_id')) return { rows: [] };
    if (s.includes('from membership_requests') && s.includes('where telegram_id') && s.includes('and status =')) return { rows: opts.pendingRequest ? [opts.pendingRequest] : [] };
    if (s.includes('from membership_requests') && s.includes('where exchange_uid')) return { rows: [] };
    if (s.includes('insert into membership_users')) return { rows: [{ telegram_id: String(params?.[0]) }] };
    if (s.includes('insert into membership_requirements')) return { rows: [{ id: 'req-new', version: 2, status: 'DRAFT' }] };
    if (s.includes('select 1 from membership_users')) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 0 };
  };
  fn._calls = calls;
  return fn;
}

function createMockTransaction() {
  const calls = [];
  const fn = async (env, queries) => {
    calls.push(queries);
    return queries.map(q => {
      const s = (q.sql || '').toLowerCase();
      if (s.includes('insert into membership_requests') && s.includes('returning')) return { rows: [{ id: 'req-' + Date.now(), telegram_id: String(q.params?.[0]), exchange_name: q.params?.[1], exchange_uid: q.params?.[2] }] };
      return { rows: [], rowCount: 0 };
    });
  };
  fn._calls = calls;
  return fn;
}

function buildDeps(opts = {}) {
  const env = createEnv();
  const queryDb = opts.queryDb || createMockQueryDb(opts);
  const queryDbTransaction = opts.queryDbTransaction || createMockTransaction();
  const membershipRepo = createMembershipRepository({ queryDb, queryDbTransaction, isDatabaseConfigured: () => true, isoDate: () => '2026-01-01', normalizeOptionalString: (s) => s == null ? null : String(s).trim() });
  const jsonResponse = (body, init, env) => ({ status: init?.status || 200, body });
  const authenticateTelegramRequest = async (request, env) => {
    const initData = request.headers?.get?.('X-Telegram-Init-Data');
    if (!initData) return { error: { status: 401, body: { error: 'Unauthorized' } } };
    try { const params = new URLSearchParams(initData); const userStr = params.get('user'); if (!userStr) return { error: { status: 401, body: { error: 'No user' } } }; return { user: JSON.parse(userStr), error: null }; } catch { return { error: { status: 401, body: { error: 'Bad' } } }; }
  };
  const isAdminTelegramId = (env, id) => String(id) === '831704732';
  const isDatabaseConfigured = () => true;
  const readAppCache = async (env, key) => env.APP_CACHE.get(key);
  const writeAppCache = async (env, key, value, ttl) => env.APP_CACHE.put(key, value, ttl);
  const safeDbErrorResponse = (e, init, env) => ({ status: 503, body: { error: 'DB error', message: e.message } });
  const buildBodyFieldValidationError = (errors, env) => ({ status: 422, body: { error: 'Validation failed', details: errors } });
  const readJsonBody = async (request) => { try { const text = await request.text(); if (!text) return { payload: {}, error: null }; return { payload: JSON.parse(text), error: null }; } catch { return { payload: null, error: { status: 400, body: { error: 'Invalid JSON' } } }; } };
  return { jsonResponse, authenticateTelegramRequest, isAdminTelegramId, isDatabaseConfigured, readAppCache, writeAppCache, safeDbErrorResponse, buildBodyFieldValidationError, readJsonBody, membershipRepo, queryDbTransaction, notificationRepo: null, notificationPlatformRepo: null, notificationService: null, sendTelegramMessage: async () => ({}), resolveWebAppUrl: () => 'https://app.example.com', _env: env, _queryDb: queryDb };
}

// ─── Tests: Requirement retrieval ───────────────────────────────────────────

test('REQ-01: GET /api/membership/requirement without auth → 401', async () => {
  const deps = buildDeps({ requirementRow: { version: 1, exchange_name: 'Bitunix', status: 'ACTIVE' } });
  const handlers = createMembershipHandlers(deps);
  const res = await handlers.handleGetRequirement(makeRequest('GET', '/api/membership/requirement'), deps._env);
  assert.equal(res.status, 401);
});

test('REQ-02: GET requirement with auth → returns active requirement', async () => {
  const deps = buildDeps({ requirementRow: { id: 'r1', version: 1, label: 'Bitunix + First Trade', exchange_name: 'Bitunix', exchange_register_url: 'https://bitunix.com/register?vipCode=AMIRBTC', uid_label: 'شناسه کاربری Bitunix', referral_code: 'AMIRBTC', requires_first_trade: true, required_volume: 0, reward_level: 'PREMIUM', grace_period_days: 14, status: 'ACTIVE', effective_at: '2026-01-01', expires_at: null, metadata: { button_text: 'ثبت‌نام در Bitunix' } } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleGetRequirement(makeRequest('GET', '/api/membership/requirement', { initData }), deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.active, true);
  assert.equal(res.body.data.exchange_name, 'Bitunix');
  assert.equal(res.body.data.exchange_register_url, 'https://bitunix.com/register?vipCode=AMIRBTC');
  assert.equal(res.body.data.uid_label, 'شناسه کاربری Bitunix');
  assert.equal(res.body.data.requires_first_trade, true);
  assert.equal(res.body.data.reward_level, 'PREMIUM');
  assert.equal(res.body.data.grace_period_days, 14);
});

test('REQ-03: GET requirement when no active → graceful', async () => {
  const deps = buildDeps({ requirementRow: null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleGetRequirement(makeRequest('GET', '/api/membership/requirement', { initData }), deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.active, false);
  assert.equal(res.body.data.exchange_name, null);
});

// ─── Tests: Admin management ────────────────────────────────────────────────

test('ADMIN-01: GET requirements without admin → 403', async () => {
  const deps = buildDeps();
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 999 });
  const res = await handlers.handleListRequirements(makeRequest('GET', '/api/admin/membership/requirements', { initData }), deps._env);
  assert.equal(res.status, 403);
});

test('ADMIN-02: GET requirements with admin → returns list', async () => {
  const deps = buildDeps({ allRequirements: [{ id: 'r1', version: 1, exchange_name: 'Bitunix', status: 'ACTIVE' }] });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 831704732 });
  const res = await handlers.handleListRequirements(makeRequest('GET', '/api/admin/membership/requirements', { initData }), deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.length, 1);
});

test('ADMIN-03: POST requirements creates DRAFT', async () => {
  const deps = buildDeps();
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 831704732 });
  const res = await handlers.handleCreateRequirement(makeRequest('POST', '/api/admin/membership/requirements', { initData, body: { exchange_name: 'Bybit', exchange_register_url: 'https://bybit.com' } }), deps._env);
  assert.equal(res.status, 201);
});

test('ADMIN-04: POST requirements without exchange_name → 422', async () => {
  const deps = buildDeps();
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 831704732 });
  const res = await handlers.handleCreateRequirement(makeRequest('POST', '/api/admin/membership/requirements', { initData, body: { label: 'Missing' } }), deps._env);
  assert.equal(res.status, 422);
});

test('ADMIN-05: POST activate with non-existent version → 404', async () => {
  const deps = buildDeps({ requirementByVersion: () => null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 831704732 });
  const res = await handlers.handleActivateRequirement(makeRequest('POST', '/api/admin/membership/requirements/activate', { initData, body: { version: 999 } }), deps._env);
  assert.equal(res.status, 404);
});

// ─── Tests: Submit validation ───────────────────────────────────────────────

test('SUBMIT-01: POST request with matching exchange → 201', async () => {
  const deps = buildDeps({ requirementRow: { version: 1, exchange_name: 'Bitunix', status: 'ACTIVE' }, rulesRow: { version: 1, status: 'ACTIVE' }, acceptanceRow: { id: 'a1', telegram_id: '123', rules_version: 1, accepted_at: '2026-01-01' }, pendingRequest: null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleSubmitRequest(makeRequest('POST', '/api/membership/request', { initData, body: { exchange: 'Bitunix', uid: 'UID123456' } }), deps._env);
  assert.equal(res.status, 201, 'got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.requirement_version, 1);
});

test('SUBMIT-02: POST request with non-matching exchange → 403', async () => {
  const deps = buildDeps({ requirementRow: { version: 1, exchange_name: 'Bitunix', status: 'ACTIVE' }, rulesRow: { version: 1, status: 'ACTIVE' }, acceptanceRow: { id: 'a1', telegram_id: '123', rules_version: 1, accepted_at: '2026-01-01' }, pendingRequest: null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleSubmitRequest(makeRequest('POST', '/api/membership/request', { initData, body: { exchange: 'Bybit', uid: 'UID123456' } }), deps._env);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'EXCHANGE_NOT_MATCHING_REQUIREMENT');
  assert.equal(res.body.active_exchange, 'Bitunix');
});

test('SUBMIT-03: POST request fail-open — requirement table missing → 201', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE' }, acceptanceRow: { id: 'a1', telegram_id: '123', rules_version: 1, accepted_at: '2026-01-01' }, pendingRequest: null });
  const origQueryDb = deps._queryDb;
  const throwingQueryDb = async (env, sql, params) => { if ((sql || '').toLowerCase().includes('membership_requirements')) throw new Error('table does not exist'); return origQueryDb(env, sql, params); };
  deps._queryDb = throwingQueryDb;
  deps.membershipRepo = createMembershipRepository({ queryDb: throwingQueryDb, queryDbTransaction: deps.queryDbTransaction, isDatabaseConfigured: () => true, isoDate: () => '2026-01-01', normalizeOptionalString: (s) => s == null ? null : String(s).trim() });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleSubmitRequest(makeRequest('POST', '/api/membership/request', { initData, body: { exchange: 'Bitunix', uid: 'UID123456' } }), deps._env);
  assert.equal(res.status, 201, 'fail-open: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.requirement_version, null);
});

// ─── Tests: Frontend decoupling ─────────────────────────────────────────────

test('FE-01: Frontend has FALLBACK_REQUIREMENT with Bitunix values', () => {
  assert.ok(FRONTEND_SRC.includes('FALLBACK_REQUIREMENT'));
  assert.ok(FRONTEND_SRC.includes("'Bitunix'"));
  assert.ok(FRONTEND_SRC.includes('bitunix.com/register?vipCode=AMIRBTC'));
});

test('FE-02: Frontend has loadRequirement + getRequirement', () => {
  assert.ok(FRONTEND_SRC.includes('async function loadRequirement'));
  assert.ok(FRONTEND_SRC.includes('function getRequirement'));
  assert.ok(FRONTEND_SRC.includes("/api/membership/requirement"));
});

test('FE-03: openBitunix delegates to openRegisterUrl (data-driven)', () => {
  assert.ok(FRONTEND_SRC.includes('function openRegisterUrl'));
  assert.ok(FRONTEND_SRC.includes('return openRegisterUrl()'));
  const block = FRONTEND_SRC.match(/function openBitunix\(\)\s*\{[^}]*\}/);
  assert.ok(block && !block[0].includes('bitunix.com/register'), 'openBitunix no longer hard-codes URL');
});

test('FE-04: submitUid uses data-driven exchange name', () => {
  assert.ok(FRONTEND_SRC.includes('req.exchange_name'));
  assert.ok(!/JSON\.stringify\(\{\s*exchange:\s*'Bitunix'/.test(FRONTEND_SRC), 'no hard-coded Bitunix in body');
});

test('FE-05: openActivationPopup uses data-driven values', () => {
  assert.ok(FRONTEND_SRC.includes('var uidLabel'));
  assert.ok(FRONTEND_SRC.includes('var buttonText'));
  assert.ok(FRONTEND_SRC.includes('var timelineStep1Text'));
  assert.ok(FRONTEND_SRC.includes('esc(buttonText)'));
  assert.ok(FRONTEND_SRC.includes('esc(uidLabel)'));
});

// ─── Tests: Migration ───────────────────────────────────────────────────────

test('MIG-01: migration idempotent + non-destructive', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-requirements-schema.sql'), 'utf8');
  const codeOnly = sql.replace(/--[^\n]*/g, '');
  assert.ok(codeOnly.includes('CREATE TABLE IF NOT EXISTS membership_requirements'));
  assert.ok(codeOnly.includes('ON CONFLICT (version) DO NOTHING'));
  assert.ok(!/\bDROP\s+TABLE\b/i.test(codeOnly));
  assert.ok(!/\bTRUNCATE\b/i.test(codeOnly));
});

test('MIG-02: migration creates unique index for single ACTIVE', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-requirements-schema.sql'), 'utf8');
  assert.ok(sql.includes('uq_membership_req_active'));
  assert.ok(sql.includes("WHERE status = 'ACTIVE'"));
});

test('MIG-03: migration seeds Bitunix v1 ACTIVE', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-requirements-schema.sql'), 'utf8');
  assert.ok(sql.includes("'Bitunix'"));
  assert.ok(sql.includes("'ACTIVE'"));
  assert.ok(sql.includes('bitunix.com/register?vipCode=AMIRBTC'));
  assert.ok(sql.includes('AMIRBTC'));
});

test('MIG-04: migration adds current_requirement_id + requirement_id', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-requirements-schema.sql'), 'utf8');
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS current_requirement_id'));
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS requirement_id'));
});

test('MIG-05: migration has rollback comment', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts/membership-requirements-schema.sql'), 'utf8');
  assert.ok(sql.includes('Rollback:'));
});

// ─── Tests: Routes + Security ───────────────────────────────────────────────

test('ROUTES-01: Requirement routes registered', () => {
  assert.ok(WORKER_SRC.includes("'/api/membership/requirement'"));
  assert.ok(WORKER_SRC.includes("'/api/admin/membership/requirements'"));
  assert.ok(WORKER_SRC.includes("'/api/admin/membership/requirements/activate'"));
  assert.ok(WORKER_SRC.includes('handleGetRequirement'));
  assert.ok(WORKER_SRC.includes('handleListRequirements'));
  assert.ok(WORKER_SRC.includes('handleCreateRequirement'));
  assert.ok(WORKER_SRC.includes('handleActivateRequirement'));
});

test('SEC-01: No premium gating yet', () => {
  const calls = WORKER_SRC.match(/membershipAuthority\.(require|isPremium)\s*\(/g) || [];
  assert.equal(calls.length, 0);
});

test('SEC-02: validateCreateRequest no longer uses SUPPORTED_EXCHANGES', () => {
  const ctrl = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
  assert.ok(!ctrl.includes('SUPPORTED_EXCHANGES.includes'), 'SUPPORTED_EXCHANGES.includes removed from validateCreateRequest');
});

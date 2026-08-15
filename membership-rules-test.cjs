/**
 * Phase 1 — Premium Rules + Versioned Acceptance Tests
 *
 * Tests rules retrieval, acceptance recording, submit validation,
 * migration safety, and security (IDOR, version tampering, fail-open).
 * Uses source-eval pattern for isolated testing.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEMBERSHIP_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/membership.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

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
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

function createEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: 'postgres://mock?pgbouncer=true',
    APP_ENV: 'development',
    BOT_USERNAME: '',
    APP_CACHE: createMemoryKv(),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
    ...overrides,
  };
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
  if (body && typeof body === 'object') {
    return new Request('https://worker.example.com' + path, { method, headers: h, body: JSON.stringify(body) });
  }
  return new Request('https://worker.example.com' + path, { method, headers: h });
}

function createMockQueryDb(opts = {}) {
  const calls = [];
  const fn = async (env, sql, params) => {
    calls.push({ sql, params });
    const s = (sql || '').toLowerCase();
    if (s.includes('from membership_rules') && s.includes("where status = 'active'")) {
      return { rows: opts.rulesRow ? [opts.rulesRow] : [] };
    }
    if (s.includes('from membership_rules') && s.includes('where version =')) {
      const v = Number(params?.[0]);
      return { rows: (opts.rulesRow && opts.rulesRow.version === v) ? [opts.rulesRow] : [] };
    }
    if (s.includes('from membership_rule_acceptances')) {
      return { rows: opts.acceptanceRow ? [opts.acceptanceRow] : [] };
    }
    if (s.includes('insert into membership_rule_acceptances')) {
      return { rows: [{ id: 'acc-1', telegram_id: String(params?.[0]), rules_version: Number(params?.[1]), accepted_at: new Date().toISOString() }] };
    }
    if (s.includes('from membership_users') && s.includes('where telegram_id')) { return { rows: [] }; }
    if (s.includes('from membership_requests') && s.includes('where telegram_id') && s.includes('and status =')) { return { rows: opts.pendingRequest ? [opts.pendingRequest] : [] }; }
    if (s.includes('from membership_requests') && s.includes('where exchange_uid')) { return { rows: [] }; }
    if (s.includes('insert into membership_users')) { return { rows: [{ telegram_id: String(params?.[0]) }] }; }
    if (s.includes('select 1 from membership_users')) { return { rows: [{ '?column?': 1 }] }; }
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
      if (s.includes('insert into membership_requests') && s.includes('returning')) {
        return { rows: [{ id: 'req-' + Date.now(), telegram_id: String(q.params?.[0]), exchange_name: q.params?.[1], exchange_uid: q.params?.[2] }] };
      }
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
  const membershipRepo = createMembershipRepository({
    queryDb, queryDbTransaction,
    isDatabaseConfigured: () => true,
    isoDate: () => new Date().toISOString().slice(0, 10),
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
  const isAdminTelegramId = (env, id) => String(id) === '831704732';
  const isDatabaseConfigured = () => true;
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
    jsonResponse, authenticateTelegramRequest, isAdminTelegramId, isDatabaseConfigured,
    readAppCache, writeAppCache, safeDbErrorResponse, buildBodyFieldValidationError,
    readJsonBody, membershipRepo, queryDbTransaction,
    notificationRepo: null, notificationPlatformRepo: null, notificationService: null,
    sendTelegramMessage: async () => ({}), resolveWebAppUrl: () => 'https://app.example.com',
    _env: env, _queryDb: queryDb,
  };
}

// ─── Tests: Rules retrieval ─────────────────────────────────────────────────

test('RULES-01: GET /api/membership/rules without auth → 401', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, title: 'v1', body_markdown: '# Rules', summary: 's', status: 'ACTIVE', effective_at: null, created_at: null } });
  const handlers = createMembershipHandlers(deps);
  const res = await handlers.handleGetRules(makeRequest('GET', '/api/membership/rules'), deps._env);
  assert.equal(res.status, 401);
});

test('RULES-02: GET rules with auth → returns active version', async () => {
  const deps = buildDeps({
    rulesRow: { version: 1, title: 'قوانین v1', body_markdown: '# Rules', summary: 's', status: 'ACTIVE', effective_at: '2026-01-01', created_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123, first_name: 'Test' });
  const res = await handlers.handleGetRules(makeRequest('GET', '/api/membership/rules', { initData }), deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.version, 1);
  assert.equal(res.body.data.active, true);
});

test('RULES-03: GET rules when no active version → graceful', async () => {
  const deps = buildDeps({ rulesRow: null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleGetRules(makeRequest('GET', '/api/membership/rules', { initData }), deps._env);
  assert.equal(res.status, 200);
  assert.equal(res.body.data.active, false);
  assert.equal(res.body.data.version, null);
});

// ─── Tests: Acceptance ──────────────────────────────────────────────────────

test('ACCEPT-01: POST accept without auth → 401', async () => {
  const deps = buildDeps();
  const handlers = createMembershipHandlers(deps);
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { body: { rules_version: 1 } }), deps._env);
  assert.equal(res.status, 401);
});

test('ACCEPT-02: POST accept with valid version → 200', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE', title: 'v1', body_markdown: 'c', summary: 's', effective_at: null, created_at: null } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 1 } }), deps._env);
  assert.equal(res.status, 200, 'got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.accepted, true);
  assert.equal(res.body.data.rules_version, 1);
});

test('ACCEPT-03: POST accept with non-existent version → 404', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE' } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 999 } }), deps._env);
  assert.equal(res.status, 404);
  assert.equal(res.body.code, 'RULES_NOT_FOUND');
});

test('ACCEPT-04: POST accept with non-active version → 409', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ARCHIVED', title: 'v1', body_markdown: 'c', summary: 's', effective_at: null, created_at: null } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 1 } }), deps._env);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'RULES_NOT_ACTIVE');
});

test('ACCEPT-05: POST accept missing version → 422', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE' } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: {} }), deps._env);
  assert.equal(res.status, 422);
});

test('ACCEPT-06: POST accept is idempotent (duplicate → 200)', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE', title: 'v1', body_markdown: 'c', summary: 's', effective_at: null, created_at: null } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const r1 = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 1 } }), deps._env);
  assert.equal(r1.status, 200);
  const r2 = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 1 } }), deps._env);
  assert.equal(r2.status, 200, 'duplicate acceptance must be idempotent');
});

test('ACCEPT-07: IDOR — body telegram_id ignored, uses auth user', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE', title: 'v1', body_markdown: 'c', summary: 's', effective_at: null, created_at: null } });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 1, telegram_id: '999' } }), deps._env);
  assert.equal(res.status, 200);
  const acceptCall = deps._queryDb._calls.find(c => c.sql && c.sql.toLowerCase().includes('insert into membership_rule_acceptances'));
  assert.ok(acceptCall);
  assert.equal(acceptCall.params[0], '123', 'telegram_id from auth, not body');
});

// ─── Tests: Request submission ──────────────────────────────────────────────

test('REQUEST-01: POST request WITHOUT acceptance → 403 RULES_NOT_ACCEPTED', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE', effective_at: null, created_at: null }, acceptanceRow: null, pendingRequest: null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleSubmitRequest(makeRequest('POST', '/api/membership/request', { initData, body: { exchange: 'Bitunix', uid: 'UID123456' } }), deps._env);
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'RULES_NOT_ACCEPTED');
  assert.equal(res.body.active_version, 1);
});

test('REQUEST-02: POST request WITH acceptance → 201, rules_version stamped', async () => {
  const deps = buildDeps({ rulesRow: { version: 1, status: 'ACTIVE', effective_at: null, created_at: null }, acceptanceRow: { id: 'a1', telegram_id: '123', rules_version: 1, accepted_at: '2026-01-01' }, pendingRequest: null });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleSubmitRequest(makeRequest('POST', '/api/membership/request', { initData, body: { exchange: 'Bitunix', uid: 'UID123456' } }), deps._env);
  assert.equal(res.status, 201, 'got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.rules_version, 1);
});

test('REQUEST-03: POST request fail-open — rules table missing → 201', async () => {
  const deps = buildDeps({ rulesRow: null, pendingRequest: null });
  const origQueryDb = deps._queryDb;
  const throwingQueryDb = async (env, sql, params) => {
    if ((sql || '').toLowerCase().includes('membership_rules')) throw new Error('table does not exist');
    return origQueryDb(env, sql, params);
  };
  deps._queryDb = throwingQueryDb;
  deps.membershipRepo = createMembershipRepository({ queryDb: throwingQueryDb, queryDbTransaction: deps.queryDbTransaction, isDatabaseConfigured: () => true, isoDate: () => '2026-01-01', normalizeOptionalString: (s) => s == null ? null : String(s).trim() });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleSubmitRequest(makeRequest('POST', '/api/membership/request', { initData, body: { exchange: 'Bitunix', uid: 'UID123456' } }), deps._env);
  assert.equal(res.status, 201, 'fail-open: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.rules_version, null);
});

// ─── Tests: Security ────────────────────────────────────────────────────────

test('SECURITY-01: Version tampering — accepting archived version → 409', async () => {
  const deps = buildDeps({ rulesRow: { version: 2, status: 'ACTIVE', effective_at: null, created_at: null } });
  const origQueryDb = deps._queryDb;
  const customQueryDb = async (env, sql, params) => {
    const s = (sql || '').toLowerCase();
    if (s.includes('from membership_rules') && s.includes('where version =')) {
      const v = Number(params?.[0]);
      if (v === 1) return { rows: [{ version: 1, title: 'v1', body_markdown: 'c', summary: 's', status: 'ARCHIVED', effective_at: null, created_at: null }] };
      if (v === 2) return { rows: [{ version: 2, title: 'v2', body_markdown: 'c', summary: 's', status: 'ACTIVE', effective_at: null, created_at: null }] };
      return { rows: [] };
    }
    return origQueryDb(env, sql, params);
  };
  deps._queryDb = customQueryDb;
  deps.membershipRepo = createMembershipRepository({ queryDb: customQueryDb, queryDbTransaction: deps.queryDbTransaction, isDatabaseConfigured: () => true, isoDate: () => '2026-01-01', normalizeOptionalString: (s) => s == null ? null : String(s).trim() });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: 123 });
  const res = await handlers.handleAcceptRules(makeRequest('POST', '/api/membership/rules/accept', { initData, body: { rules_version: 1 } }), deps._env);
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'RULES_NOT_ACTIVE');
});

test('SECURITY-02: No premium gating yet — source inspection', () => {
  const authorityCalls = WORKER_SRC.match(/membershipAuthority\.(require|isPremium)\s*\(/g) || [];
  assert.equal(authorityCalls.length, 0, 'Phase 1: still no premium gating');
});

test('SECURITY-03: Rules routes registered in worker', () => {
  assert.ok(WORKER_SRC.includes("'/api/membership/rules'"), 'GET rules route');
  assert.ok(WORKER_SRC.includes("'/api/membership/rules/accept'"), 'POST accept route');
  assert.ok(WORKER_SRC.includes("'/api/membership/rules/accepted'"), 'GET accepted route');
  assert.ok(WORKER_SRC.includes('handleGetRules'), 'handler wired');
  assert.ok(WORKER_SRC.includes('handleAcceptRules'), 'handler wired');
  assert.ok(WORKER_SRC.includes('handleCheckAcceptance'), 'handler wired');
});

// ─── Tests: Migration ───────────────────────────────────────────────────────

test('MIG-01: migration file exists and is idempotent', () => {
  const migrationPath = path.join(__dirname, 'scripts', 'membership-rules-schema.sql');
  assert.ok(fs.existsSync(migrationPath));
  const sql = fs.readFileSync(migrationPath, 'utf8');
  const codeOnly = sql.replace(/--[^\n]*/g, '');
  assert.ok(codeOnly.includes('CREATE TABLE IF NOT EXISTS membership_rules'), 'idempotent table');
  assert.ok(codeOnly.includes('CREATE TABLE IF NOT EXISTS membership_rule_acceptances'), 'idempotent acceptance table');
  assert.ok(codeOnly.includes('ON CONFLICT (version) DO NOTHING'), 'idempotent seed');
  assert.ok(!/\bDROP\s+TABLE\b/i.test(codeOnly), 'no DROP TABLE');
  assert.ok(!/\bTRUNCATE\b/i.test(codeOnly), 'no TRUNCATE');
});

test('MIG-02: migration creates unique constraint on acceptances', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts', 'membership-rules-schema.sql'), 'utf8');
  assert.ok(sql.includes('uq_acceptance_user_version'), 'unique constraint');
  assert.ok(sql.includes('ON membership_rule_acceptances (telegram_id, rules_version)'), 'correct columns');
});

test('MIG-03: migration adds rules_version to membership_requests', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts', 'membership-rules-schema.sql'), 'utf8');
  assert.ok(sql.includes('ADD COLUMN IF NOT EXISTS rules_version'), 'adds column');
});

test('MIG-04: migration seeds v1 ACTIVE', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts', 'membership-rules-schema.sql'), 'utf8');
  assert.ok(sql.includes("'ACTIVE'"), 'seeds ACTIVE');
  assert.ok(sql.includes('ON CONFLICT (version) DO NOTHING'), 'idempotent seed');
});

test('MIG-05: migration has rollback comment', () => {
  const sql = fs.readFileSync(path.join(__dirname, 'scripts', 'membership-rules-schema.sql'), 'utf8');
  assert.ok(sql.includes('Rollback:'), 'rollback documented');
});

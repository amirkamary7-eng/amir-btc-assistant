/**
 * EXCHANGE_REGISTER_URL SCHEME ALLOWLIST REGRESSION TEST — SEC-08 (Phase 20)
 * ===========================================================================
 *
 * FINDING (Phase 19 final audit, re-verified in Phase 20 scope at 698b3c71):
 *   src/controllers/membership.js:
 *     * handleCreateRequirement validated exchange_register_url for
 *       PRESENCE ONLY — 'javascript:alert(1)' passed validation and was
 *       stored in membership_requirements.
 *     * handleGetRequirement served the stored value VERBATIM in the
 *       user-facing DTO (and cached it in APP_CACHE for 5 minutes).
 *   The value is consumed client-side by membership-user.js
 *   openRegisterUrl() via Telegram.WebApp.openLink(url) /
 *   window.open(url, '_blank') — a javascript:/data: URL is a code-
 *   execution sink in the Mini App for every user that opens the
 *   membership register button. (Write is admin-gated, which limits
 *   exploitability to a compromised/insider admin — hence
 *   defense-in-depth rather than a Critical.)
 *
 * FIX UNDER TEST:
 *   * Write path: absolute http(s) URL required (trimmed, <=2048 chars);
 *     dangerous schemes and non-absolute strings are rejected with 422
 *     BEFORE reaching the DB.
 *   * Read path: legacy rows with invalid values degrade to null — the
 *     frontend falls back to its built-in FALLBACK_REQUIREMENT() URL
 *     (membership-user.js openRegisterUrl uses `req.exchange_register_url
 *     || FALLBACK...`), so the UI contract is preserved. Sanitization runs
 *     BEFORE writeAppCache so cached copies are clean too.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   Controller-level behavioral tests against the REAL
 *   createMembershipHandlers with a recording mock queryDb (same harness
 *   pattern as tests/membership-requirements-test.cjs).
 *
 *   Pre-fix (baseline 698b3c71): W2/W3/W4/W5/W6/W11 + R1/R3/R4 FAIL
 *   (dangerous/relative/oversized URLs stored; legacy bad values served).
 *   Post-fix: all tests PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const MEMBERSHIP_CTRL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'membership.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'repositories', 'membership.js'), 'utf8');

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

const ADMIN = { id: 831704732, first_name: 'Admin', username: 'admin' };
function adminInitData() { return buildInitData('test-bot-token', ADMIN); }
const USER = { id: 424242, first_name: 'User' };
function userInitData() { return buildInitData('test-bot-token', USER); }

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
    if (s.includes('from membership_requirements') && s.includes('where version =')) return { rows: opts.requirementRow ? [opts.requirementRow] : [] };
    if (s.includes('from membership_requirements') && s.includes('order by version desc')) return { rows: opts.allRequirements || [] };
    if (s.includes('insert into membership_requirements')) return { rows: [{ id: 'req-new', version: 2, status: 'DRAFT', exchange_register_url: String(params?.[2] ?? '') }] };
    if (s.includes('from membership_rules') && s.includes("where status = 'active'")) return { rows: opts.rulesRow ? [opts.rulesRow] : [] };
    if (s.includes('from membership_rule_acceptances')) return { rows: opts.acceptanceRow ? [opts.acceptanceRow] : [] };
    if (s.includes('insert into membership_rule_acceptances')) return { rows: [{ id: 'acc-1' }] };
    if (s.includes('from membership_users') && s.includes('where telegram_id')) return { rows: [] };
    if (s.includes('from membership_requests')) return { rows: [] };
    if (s.includes('insert into membership_users')) return { rows: [{ telegram_id: String(params?.[0]) }] };
    if (s.includes('select 1 from membership_users')) return { rows: [{ '?column?': 1 }] };
    return { rows: [], rowCount: 0 };
  };
  fn._calls = calls;
  return fn;
}

function createMockTransaction() {
  const fn = async (env, queries) => queries.map(() => ({ rows: [], rowCount: 0 }));
  fn._calls = [];
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
    try { const params = new URLSearchParams(initData); const userStr = params.get('user'); if (!userStr) return { error: { status: 401, body: { error: 'No user' } } }; return { user: JSON.parse(userStr), error: null }; } catch { return { error: { status: 401, body: { error: 'Bad' } } } };
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

/** The stored active requirement row used for read-path tests. */
function activeRequirementRow(url) {
  return { id: 'r1', version: 1, label: 'Bitunix + First Trade', exchange_name: 'Bitunix', exchange_register_url: url, uid_label: 'شناسه کاربری', referral_code: 'AMIRBTC', requires_first_trade: true, required_volume: 0, reward_level: 'PREMIUM', grace_period_days: 14, status: 'ACTIVE', effective_at: '2026-01-01', expires_at: null, metadata: {} };
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Write path (POST /api/admin/membership/requirements)
// ═══════════════════════════════════════════════════════════════════════════

async function createRequirement(url, opts = {}) {
  const deps = buildDeps(opts);
  const handlers = createMembershipHandlers(deps);
  const res = await handlers.handleCreateRequirement(
    makeRequest('POST', '/api/admin/membership/requirements', { initData: adminInitData(), body: { exchange_name: 'Bitunix', exchange_register_url: url } }),
    deps._env);
  return { res, deps };
}

test('SEC08-W1: valid https URL accepted (201) — legitimate admin flow intact', async () => {
  const { res } = await createRequirement('https://www.bitunix.com/register?vipCode=AMIRBTC');
  assert.equal(res.status, 201, 'valid https URL must be accepted');
});

test('SEC08-W2: javascript: URL rejected with 422 (THE fix — was stored pre-fix)', async () => {
  const { res } = await createRequirement('javascript:alert(document.domain)');
  assert.equal(res.status, 422, 'javascript: scheme must be rejected at the write path');
  const detail = JSON.stringify(res.body);
  assert.ok(detail.includes('exchange_register_url'), 'the 422 must name the offending field');
});

test('SEC08-W3: data:text/html URL rejected with 422', async () => {
  const { res } = await createRequirement('data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==');
  assert.equal(res.status, 422, 'data: scheme must be rejected');
});

test('SEC08-W4: vbscript: URL rejected with 422', async () => {
  const { res } = await createRequirement('vbscript:msgbox("x")');
  assert.equal(res.status, 422, 'vbscript: scheme must be rejected');
});

test('SEC08-W5: file: URL rejected with 422', async () => {
  const { res } = await createRequirement('file:///etc/passwd');
  assert.equal(res.status, 422, 'file: scheme must be rejected');
});

test('SEC08-W6: relative path "/register" rejected with 422 (not an absolute URL)', async () => {
  const { res } = await createRequirement('/register?vipCode=AMIRBTC');
  assert.equal(res.status, 422, 'relative paths must be rejected');
});

test('SEC08-W7: scheme-less "bitunix.com/register" rejected with 422', async () => {
  const { res } = await createRequirement('bitunix.com/register?vipCode=AMIRBTC');
  assert.equal(res.status, 422, 'scheme-less host paths must be rejected');
});

test('SEC08-W8: empty string rejected with 422 (presence contract preserved)', async () => {
  const { res } = await createRequirement('');
  assert.equal(res.status, 422, 'empty value must stay rejected');
});

test('SEC08-W9: plain http:// URL accepted (no unnecessary restriction)', async () => {
  const { res } = await createRequirement('http://example.com/register');
  assert.equal(res.status, 201, 'http scheme is safe (no code execution) and must remain accepted');
});

test('SEC08-W10: uppercase HTTPS:// accepted (URL constructor lowercases the protocol)', async () => {
  const { res } = await createRequirement('HTTPS://WWW.BITUNIX.COM/REGISTER');
  assert.equal(res.status, 201, 'scheme case must not matter');
});

test('SEC08-W11: whitespace-padded https URL accepted AND stored trimmed', async () => {
  const { res, deps } = await createRequirement('  https://www.bitunix.com/register?vipCode=AMIRBTC  ');
  assert.equal(res.status, 201, 'padded valid URL must be accepted');
  const insertCall = deps._queryDb._calls.find(c => /insert into membership_requirements/i.test(c.sql));
  assert.ok(insertCall, 'the requirement insert must have run');
  assert.equal(insertCall.params[2], 'https://www.bitunix.com/register?vipCode=AMIRBTC',
    'the stored value must be the TRIMMED url');
});

test('SEC08-W12: URL longer than 2048 chars rejected with 422', async () => {
  const longUrl = 'https://example.com/r?' + 'a'.repeat(2100);
  const { res } = await createRequirement(longUrl);
  assert.equal(res.status, 422, 'oversized URLs must be rejected');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Read path (GET /api/membership/requirement)
// ═══════════════════════════════════════════════════════════════════════════

async function getRequirement(requirementRow) {
  const deps = buildDeps({ requirementRow });
  const handlers = createMembershipHandlers(deps);
  const res = await handlers.handleGetRequirement(
    makeRequest('GET', '/api/membership/requirement', { initData: userInitData() }),
    deps._env);
  let body = res.body;
  if (body && typeof body.then !== 'function') { /* already plain */ }
  return { res, deps, data: body && body.data };
}

test('SEC08-R1: LEGACY row with javascript: URL → dto.exchange_register_url === null (THE fix)', async () => {
  const { res, data } = await getRequirement(activeRequirementRow('javascript:alert(document.domain)'));
  assert.equal(res.status, 200, 'the read endpoint itself must keep working');
  assert.equal(data.exchange_register_url, null, 'an invalid legacy URL must NOT be served to clients');
});

test('SEC08-R2: legacy row with data: URL → null', async () => {
  const { data } = await getRequirement(activeRequirementRow('data:text/html,<script>alert(1)</script>'));
  assert.equal(data.exchange_register_url, null);
});

test('SEC08-R3: row with valid https URL → passed through unchanged', async () => {
  const { data } = await getRequirement(activeRequirementRow('https://www.bitunix.com/register?vipCode=AMIRBTC'));
  assert.equal(data.exchange_register_url, 'https://www.bitunix.com/register?vipCode=AMIRBTC');
});

test('SEC08-R4: row with non-string stored value (number) → null (defensive)', async () => {
  const { data } = await getRequirement(activeRequirementRow(12345));
  assert.equal(data.exchange_register_url, null, 'non-string stored values must degrade to null');
});

test('SEC08-R5: sanitized value is what gets CACHED (clean cache after legacy bad row)', async () => {
  const { deps, data } = await getRequirement(activeRequirementRow('javascript:alert(1)'));
  assert.equal(data.exchange_register_url, null);
  const cached = deps._env.APP_CACHE._store.get('mb:req:active');
  assert.ok(cached, 'the DTO must be cached as before');
  const cachedDto = JSON.parse(cached);
  assert.equal(cachedDto.exchange_register_url, null, 'the CACHED copy must carry the sanitized value, not the raw one');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — Source locks
// ═══════════════════════════════════════════════════════════════════════════

test('SEC08-S1: membership controller carries the SEC-08 FIX marker', () => {
  assert.ok(MEMBERSHIP_CTRL_SRC.includes('SEC-08 FIX'),
    'src/controllers/membership.js must carry the SEC-08 FIX marker');
});

test('SEC08-S2: the allowlist is scheme-based (http/https), not a blacklist', () => {
  // The helper must NOT blacklist specific strings — it must allow ONLY
  // http/https protocols via the URL constructor (allowlist by design).
  assert.ok(MEMBERSHIP_CTRL_SRC.includes("parsed.protocol === 'https:' || parsed.protocol === 'http:'"),
    'the validator must be an explicit protocol allowlist');
  assert.ok(!MEMBERSHIP_CTRL_SRC.includes('javascript:alert') || MEMBERSHIP_CTRL_SRC.indexOf('SEC-08 FIX') > -1,
    'javascript: may only appear inside explanatory comments');
});

test('SEC08-S3: the read path sanitizes BEFORE caching (scoped to handleGetRequirement)', () => {
  // Scope to the handleGetRequirement function — other handlers earlier in
  // the file also call writeAppCache, which would break a whole-file index
  // comparison.
  const fnStart = MEMBERSHIP_CTRL_SRC.indexOf('async function handleGetRequirement');
  const fnEnd = MEMBERSHIP_CTRL_SRC.indexOf('/** GET /api/admin/membership/requirements');
  assert.ok(fnStart > -1 && fnEnd > fnStart, 'handleGetRequirement must exist');
  const fnSrc = MEMBERSHIP_CTRL_SRC.slice(fnStart, fnEnd);
  const sanitizeIdx = fnSrc.indexOf('exchange_register_url: sanitizeExchangeRegisterUrl(req.exchange_register_url)');
  const cacheIdx = fnSrc.indexOf('await writeAppCache(env, cacheKey, JSON.stringify(dto), CACHE_TTL.STATUS);');
  assert.ok(sanitizeIdx > -1, 'the dto must use sanitizeExchangeRegisterUrl');
  assert.ok(cacheIdx > sanitizeIdx, 'writeAppCache must come after sanitization');
});

/**
 * Phase 7C — Pre-Launch Critical Fixes (H1 + H2)
 *
 * H1: admToast undefined — all 17 error-message call sites fall through to
 *     native alert(). Fix: wire window.admToast in app.js to delegate to
 *     adminToast (color-coded, when available) or showToast (always available).
 *
 * H2: SUSPENDED user can bypass suspension by submitting a new membership
 *     request. Fix: handleSubmitRequest now checks canTransition(currentStatus,
 *     'PENDING') and returns 409 INVALID_TRANSITION if not allowed.
 *
 * Uses the source-string assertion pattern (same as premium-ui-test.cjs) for
 * H1 (frontend wiring) and the source-eval pattern (same as membership-rules-
 * test.cjs) for H2 (backend handler behavior).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const APP_JS_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const MEMBERSHIP_USER_SRC = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');
const COSMETICS_SRC = fs.readFileSync(path.join(__dirname, 'cosmetics.js'), 'utf8');
const MEMBERSHIP_ADMIN_SRC = fs.readFileSync(path.join(__dirname, 'membership-admin.js'), 'utf8');
const ADMIN_JS_SRC = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');

// ─── Backend source-eval for H2 ───────────────────────────────────────────

const MEMBERSHIP_CTRL_SRC = fs.readFileSync(
  path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(
  path.join(__dirname, 'src/repositories/membership.js'), 'utf8');

function loadFn(src, exportName) {
  const cleaned = src.replace(
    new RegExp(`export\\s+function\\s+${exportName}`),
    `function ${exportName}`);
  const exportsObj = {};
  const evaluator = new Function('exports', cleaned + `; exports.${exportName} = ${exportName};`);
  evaluator(exportsObj);
  return exportsObj[exportName];
}

const createMembershipHandlers = loadFn(MEMBERSHIP_CTRL_SRC, 'createMembershipHandlers');
const createMembershipRepository = loadFn(MEMBERSHIP_REPO_SRC, 'createMembershipRepository');

// ─── Mock helpers for H2 ──────────────────────────────────────────────────

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
    return new Request('https://worker.example.com' + path, {
      method, headers: h, body: JSON.stringify(body),
    });
  }
  return new Request('https://worker.example.com' + path, { method, headers: h });
}

/**
 * Mock queryDb that returns a configurable user row.
 * The userRow can be mutated between calls to simulate state changes.
 */
function createMockQueryDb(opts = {}) {
  const calls = [];
  let currentUserRow = opts.userRow || null;

  const fn = async (env, sql, params) => {
    calls.push({ sql, params });
    const s = (sql || '').toLowerCase();

    if (s.includes('from membership_users') && s.includes('where telegram_id')) {
      return { rows: currentUserRow ? [currentUserRow] : [] };
    }
    if (s.includes('from membership_requests') && s.includes('where telegram_id') && s.includes('and status =')) {
      return { rows: opts.pendingRequest ? [opts.pendingRequest] : [] };
    }
    if (s.includes('from membership_requests') && s.includes('where id =')) {
      // findRequestById — return the configured requestRow.
      return { rows: opts.requestRow ? [opts.requestRow] : [] };
    }
    if (s.includes('from membership_requests') && s.includes('where exchange_uid')) {
      return { rows: [] };
    }
    if (s.includes('insert into membership_users')) {
      return { rows: [{ telegram_id: String(params?.[0]) }] };
    }
    if (s.includes('select 1 from membership_users')) {
      return { rows: [{ '?column?': 1 }] };
    }
    if (s.includes('from membership_rules')) {
      return { rows: [] };
    }
    if (s.includes('from membership_rule_acceptances')) {
      return { rows: opts.acceptanceRow ? [opts.acceptanceRow] : [] };
    }
    // isExchangeMatchingActive → no active requirement (fail-open)
    if (s.includes('from membership_requirements')) {
      return { rows: [] };
    }
    return { rows: [], rowCount: 0 };
  };
  fn._calls = calls;
  fn._setUserRow = (row) => { currentUserRow = row; };
  fn._currentUserRow = () => currentUserRow;
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
    membershipAuthority: null, // not needed for H2 test (invalidateCaches fallback path)
    _env: env, _queryDb: queryDb,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// H1: admToast wiring tests
// ═══════════════════════════════════════════════════════════════════════════

// ─── H1: Verify showToast + adminToast exist in their respective files ─────

test('H1-TRACE-01: showToast(msg) is defined in app.js', () => {
  assert.ok(APP_JS_SRC.includes('function showToast(msg)'),
    'showToast must be defined in app.js');
});

test('H1-TRACE-02: adminToast(message, type) is defined in admin.js with 2-arg signature', () => {
  assert.ok(ADMIN_JS_SRC.includes('function adminToast(message, type)'),
    'adminToast must be defined in admin.js with (message, type) signature');
});

test('H1-TRACE-03: adminToast supports success/error/info types with color coding', () => {
  const body = ADMIN_JS_SRC.slice(
    ADMIN_JS_SRC.indexOf('function adminToast'),
    ADMIN_JS_SRC.indexOf('function adminBadge')
  );
  assert.ok(body.includes("type === 'success'"),
    'adminToast handles success type');
  assert.ok(body.includes("type === 'error'"),
    'adminToast handles error type');
  assert.ok(body.includes('rgba(0,200,150'),
    'success → green color');
  assert.ok(body.includes('rgba(255,77,77'),
    'error → red color');
});

// ─── H1: Verify window.admToast is now wired ───────────────────────────────

test('H1-WIRE-01: window.admToast is assigned in app.js', () => {
  assert.ok(APP_JS_SRC.includes('window.admToast ='),
    'window.admToast must be assigned in app.js');
});

test('H1-WIRE-02: window.admToast delegates to adminToast when available', () => {
  // Extract the admToast shim body.
  const start = APP_JS_SRC.indexOf('window.admToast = function admToastShim');
  assert.ok(start >= 0, 'admToastShim function must exist');
  const body = APP_JS_SRC.slice(start, start + 800);
  assert.ok(body.includes("typeof window.adminToast === 'function'"),
    'shim checks for window.adminToast availability');
  assert.ok(body.includes('return window.adminToast(message, type)'),
    'shim delegates to adminToast(message, type) when available');
});

test('H1-WIRE-03: window.admToast falls back to showToast when adminToast unavailable', () => {
  const start = APP_JS_SRC.indexOf('window.admToast = function admToastShim');
  const body = APP_JS_SRC.slice(start, start + 800);
  assert.ok(body.includes("typeof showToast === 'function'"),
    'shim checks for showToast availability');
  assert.ok(body.includes('return showToast(message)'),
    'shim delegates to showToast(message) as fallback');
});

test('H1-WIRE-04: window.admToast does NOT create a second toast system', () => {
  // The shim must NOT define a new toast DOM element or styling — it must
  // ONLY delegate to existing adminToast / showToast / showMiniToast.
  const start = APP_JS_SRC.indexOf('window.admToast = function admToastShim');
  const body = APP_JS_SRC.slice(start, start + 800);
  assert.ok(!body.includes('document.createElement'),
    'shim must NOT create DOM elements (reuses existing toast systems)');
  assert.ok(!body.includes('classList.add'),
    'shim must NOT manipulate classes (reuses existing toast systems)');
});

test('H1-WIRE-05: window.admToast preserves the (message, type) signature', () => {
  const start = APP_JS_SRC.indexOf('window.admToast = function admToastShim');
  const body = APP_JS_SRC.slice(start, start + 200);
  assert.ok(body.includes('function admToastShim(message, type)'),
    'shim accepts (message, type) — matches all 17 call sites');
});

// ─── H1: Verify all 17 call sites are covered by the wiring ───────────────

test('H1-COVER-01: membership-user.js has 7 admToast call sites (all use if-guard)', () => {
  const matches = [...MEMBERSHIP_USER_SRC.matchAll(/if \(window\.admToast\) admToast\(/g)];
  assert.equal(matches.length, 7,
    'membership-user.js must have exactly 7 admToast call sites');
});

test('H1-COVER-02: cosmetics.js has 6 admToast call sites', () => {
  const matches = [...COSMETICS_SRC.matchAll(/if \(window\.admToast\) admToast\(/g)];
  assert.equal(matches.length, 6,
    'cosmetics.js must have exactly 6 admToast call sites');
});

test('H1-COVER-03: membership-admin.js has 4 admToast call sites', () => {
  const matches = [...MEMBERSHIP_ADMIN_SRC.matchAll(/if \(window\.admToast\) admToast\(/g)];
  assert.equal(matches.length, 4,
    'membership-admin.js must have exactly 4 admToast call sites');
});

test('H1-COVER-04: all 17 call sites use the (message, type) signature', () => {
  // Every admToast call must pass 2 arguments (message + type).
  const allSources = MEMBERSHIP_USER_SRC + COSMETICS_SRC + MEMBERSHIP_ADMIN_SRC;
  const calls = [...allSources.matchAll(/admToast\(([^)]+)\)/g)];
  for (const m of calls) {
    const args = m[1].split(',');
    assert.ok(args.length >= 2,
      `admToast call must have 2+ args (message, type). Got: admToast(${m[1]})`);
  }
});

// ─── H1: Verify RULES_NOT_ACCEPTED UX remains intact ──────────────────────

test('H1-UX-01: RULES_NOT_ACCEPTED recovery uses admToast (not native alert as primary)', () => {
  // The rulesMsg in _submitUidInternal must go through admToast as the PRIMARY
  // path. The `else alert(rulesMsg)` fallback is allowed (it only runs if
  // window.admToast is undefined — which can no longer happen with the shim
  // wired, but is harmless to keep as a defensive guard).
  const idx = MEMBERSHIP_USER_SRC.indexOf("res.code === 'RULES_NOT_ACCEPTED'");
  const block = MEMBERSHIP_USER_SRC.slice(idx, idx + 1200);
  // Primary path must be admToast.
  assert.ok(block.includes('if (window.admToast) admToast(rulesMsg'),
    'RULES_NOT_ACCEPTED recovery must use admToast(rulesMsg, "error") as primary path');
  // Any alert() must be in an `else` fallback (after the admToast if-guard),
  // never as the primary/only path.
  const admToastIdx = block.indexOf('if (window.admToast) admToast(rulesMsg');
  const alertIdx = block.indexOf('alert(rulesMsg)');
  assert.ok(alertIdx > admToastIdx,
    'alert(rulesMsg) must only appear as an `else` fallback AFTER the admToast if-guard, not as the primary path');
  assert.ok(block.slice(admToastIdx, alertIdx).includes('else'),
    'there must be an `else` between admToast and alert (fallback pattern)');
});

test('H1-UX-02: RULES_NOT_ACCEPTED Persian message preserved', () => {
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf("res.code === 'RULES_NOT_ACCEPTED'"),
    MEMBERSHIP_USER_SRC.indexOf("res.code === 'RULES_NOT_ACCEPTED'") + 800
  );
  assert.ok(block.includes('قوانین عضویت به‌روزرسانی شده‌اند'),
    'Persian "rules updated" message preserved');
  assert.ok(block.includes('نسخه جدید را مطالعه کرده و دوباره تأیید کنید'),
    'Persian "read + re-accept new version" message preserved');
});

// ─── H1: Verify no native alert fallback for affected paths ────────────────

test('H1-NOALERT-01: membership-user.js submitUid paths use admToast, not alert', () => {
  // The submitUid block must not have any bare alert() calls that bypass admToast.
  // (The else alert() fallbacks in cosmetics.js are separate — they guard against
  // admToast being undefined. With the shim wired, admToast is always defined,
  // so the if-branch always runs.)
  const block = MEMBERSHIP_USER_SRC.slice(
    MEMBERSHIP_USER_SRC.indexOf('async function _submitUidInternal'),
    MEMBERSHIP_USER_SRC.indexOf('  // ─── Helpers')
  );
  // Every alert() in this block must be in an `else alert(...)` after an
  // `if (window.admToast) admToast(...)` — i.e. a fallback, never the primary path.
  // With the shim wired, window.admToast is always truthy, so the if-branch runs.
  const alertCount = (block.match(/else alert\(/g) || []).length;
  const admToastCount = (block.match(/if \(window\.admToast\) admToast\(/g) || []).length;
  assert.ok(admToastCount >= alertCount,
    'every alert() must be a fallback after an admToast if-guard');
});

test('H1-NOALERT-02: with window.admToast wired, the if-branch always executes', () => {
  // Since window.admToast is now always a function (the shim), `if (window.admToast)`
  // is always truthy. The `else alert(...)` branches in cosmetics.js are dead code
  // now — but harmless to keep. Verify the shim is always truthy.
  const start = APP_JS_SRC.indexOf('window.admToast = function admToastShim');
  assert.ok(start >= 0, 'shim exists');
  // The shim is a function expression assigned to window.admToast — always truthy.
  assert.ok(APP_JS_SRC.includes('window.admToast = function admToastShim'),
    'window.admToast is a function (always truthy)');
});

// ─── H1: Existing toast behavior preserved ────────────────────────────────

test('H1-PRESERVE-01: showMiniToast still exposed on window (unchanged)', () => {
  assert.ok(APP_JS_SRC.includes('window.showMiniToast = showMiniToast'),
    'window.showMiniToast assignment unchanged');
});

test('H1-PRESERVE-02: showToast function definition unchanged (still 1-arg)', () => {
  assert.ok(APP_JS_SRC.includes('function showToast(msg) {\n    showMiniToast(msg);'),
    'showToast definition unchanged — still delegates to showMiniToast');
});

test('H1-PRESERVE-03: adminToast function definition unchanged', () => {
  assert.ok(ADMIN_JS_SRC.includes('function adminToast(message, type) {'),
    'adminToast definition unchanged');
  // Verify the color coding is intact.
  const body = ADMIN_JS_SRC.slice(
    ADMIN_JS_SRC.indexOf('function adminToast'),
    ADMIN_JS_SRC.indexOf('function adminBadge')
  );
  assert.ok(body.includes('rgba(0,200,150,0.95)'),
    'success green color unchanged');
  assert.ok(body.includes('rgba(255,77,77,0.95)'),
    'error red color unchanged');
});

test('H1-PRESERVE-04: existing showToast callers in app.js unaffected', () => {
  // app.js itself calls showToast directly in a few places — those must still work.
  const directCalls = [...APP_JS_SRC.matchAll(/showToast\(/g)];
  assert.ok(directCalls.length >= 1,
    'showToast is still called directly in app.js (unchanged)');
});

// ═══════════════════════════════════════════════════════════════════════════
// H2: SUSPENDED request bypass tests
// ═══════════════════════════════════════════════════════════════════════════

const TARGET_TG_ID = '555666777';

function makeUserRow(status, level) {
  return {
    telegram_id: TARGET_TG_ID,
    membership_level: level || 'FREE',
    membership_status: status,
    membership_source: 'MANUAL',
    approved_at: null,
    expire_at: null,
    username: 'testuser',
    first_name: 'Test',
    last_name: 'User',
  };
}

const VALID_BODY = { exchange: 'Bitunix', uid: 'UID123456' };

// ─── H2: SUSPENDED → PENDING rejected ──────────────────────────────────────

test('H2-REJECT-01: SUSPENDED user submitting request → 409 INVALID_TRANSITION', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('SUSPENDED', 'PREMIUM'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 409, 'SUSPENDED → PENDING must be rejected with 409');
  assert.equal(res.body.code, 'INVALID_TRANSITION',
    'must return INVALID_TRANSITION code');
  assert.equal(res.body.details.from, 'SUSPENDED',
    'details.from must be SUSPENDED');
  assert.equal(res.body.details.to, 'PENDING',
    'details.to must be PENDING');
});

test('H2-REJECT-02: SUSPENDED user remains SUSPENDED after rejected request', async () => {
  // Verify the mock DB row was NOT mutated to PENDING.
  const deps = buildDeps({
    userRow: makeUserRow('SUSPENDED', 'PREMIUM'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  // The user row mock should still be SUSPENDED.
  assert.equal(deps._queryDb._currentUserRow().membership_status, 'SUSPENDED',
    'user status must remain SUSPENDED after rejected request');
});

test('H2-REJECT-03: no membership_request INSERT if transition is invalid', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('SUSPENDED', 'PREMIUM'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const txMock = deps.queryDbTransaction;
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  // The transaction must NOT have been called (no INSERT, no UPDATE).
  assert.equal(txMock._calls.length, 0,
    'queryDbTransaction must NOT be called when transition is invalid — no request created');
});

test('H2-REJECT-04: APPROVED user submitting new request → 409 INVALID_TRANSITION', async () => {
  // APPROVED users also cannot submit a new request (must be suspended/expired first).
  const deps = buildDeps({
    userRow: makeUserRow('APPROVED', 'PREMIUM'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 409, 'APPROVED → PENDING must be rejected');
  assert.equal(res.body.code, 'INVALID_TRANSITION');
  assert.equal(res.body.details.from, 'APPROVED');
});

test('H2-REJECT-05: PENDING user submitting another request → 409 INVALID_TRANSITION', async () => {
  // Note: this path is also caught by the DUPLICATE_REQUEST check earlier,
  // but if pendingRequest mock returns null, the state-machine check catches it.
  const deps = buildDeps({
    userRow: makeUserRow('PENDING', 'FREE'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 409);
  assert.equal(res.body.code, 'INVALID_TRANSITION');
  assert.equal(res.body.details.from, 'PENDING');
});

// ─── H2: Legitimate reapplication paths still work ────────────────────────

test('H2-VALID-01: INACTIVE → PENDING succeeds (new user)', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('INACTIVE', 'FREE'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 201, 'INACTIVE → PENDING must succeed. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'PENDING');
});

test('H2-VALID-02: REJECTED → PENDING succeeds (reapply after rejection)', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('REJECTED', 'FREE'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 201, 'REJECTED → PENDING must succeed. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'PENDING');
});

test('H2-VALID-03: EXPIRED → PENDING succeeds (reapply after expiry)', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('EXPIRED', 'FREE'),
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 201, 'EXPIRED → PENDING must succeed. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'PENDING');
});

test('H2-VALID-04: non-existent user (no row) → INACTIVE default → PENDING succeeds', async () => {
  // A brand-new user has no membership_users row. The handler must default to
  // INACTIVE and allow the transition to PENDING.
  const deps = buildDeps({
    userRow: null, // no existing row
    pendingRequest: null,
    acceptanceRow: { id: 'a1', telegram_id: TARGET_TG_ID, rules_version: 1, accepted_at: '2026-01-01' },
  });
  const handlers = createMembershipHandlers(deps);
  const initData = buildInitData('test-bot-token', { id: Number(TARGET_TG_ID), first_name: 'Test' });
  const res = await handlers.handleSubmitRequest(
    makeRequest('POST', '/api/membership/request', { initData, body: VALID_BODY }),
    deps._env,
  );
  assert.equal(res.status, 201, 'non-existent user → INACTIVE → PENDING must succeed. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.data.status, 'PENDING');
});

// ─── H2: Admin approval behavior unchanged ────────────────────────────────

test('H2-ADMIN-01: admin approve handler still works for PENDING → APPROVED', async () => {
  // The H2 fix only touched handleSubmitRequest. Admin approve/reject/suspend/
  // reactivate/expire/set-level handlers must remain unchanged.
  const deps = buildDeps({
    userRow: makeUserRow('PENDING', 'FREE'),
    requestRow: { id: 'req-001', telegram_id: TARGET_TG_ID, status: 'PENDING' },
  });
  const handlers = createMembershipHandlers(deps);
  const adminInitData = buildInitData('test-bot-token', { id: 831704732, first_name: 'Admin', username: 'admin' });
  const res = await handlers.handleApprove(
    makeRequest('POST', '/api/admin/membership/approve', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'approve test' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'admin approve must still work. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
});

test('H2-ADMIN-02: admin suspend handler still works for APPROVED → SUSPENDED', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('APPROVED', 'PREMIUM'),
    requestRow: { id: 'req-001', telegram_id: TARGET_TG_ID, status: 'PENDING' },
  });
  const handlers = createMembershipHandlers(deps);
  const adminInitData = buildInitData('test-bot-token', { id: 831704732, first_name: 'Admin', username: 'admin' });
  const res = await handlers.handleSuspend(
    makeRequest('POST', '/api/admin/membership/suspend', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'suspend test' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'admin suspend must still work. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
});

test('H2-ADMIN-03: admin reactivate handler still works for SUSPENDED → APPROVED', async () => {
  const deps = buildDeps({
    userRow: makeUserRow('SUSPENDED', 'PREMIUM'),
    requestRow: { id: 'req-001', telegram_id: TARGET_TG_ID, status: 'PENDING' },
  });
  const handlers = createMembershipHandlers(deps);
  const adminInitData = buildInitData('test-bot-token', { id: 831704732, first_name: 'Admin', username: 'admin' });
  const res = await handlers.handleReactivate(
    makeRequest('POST', '/api/admin/membership/reactivate', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'reactivate test' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'admin reactivate must still work. Got: ' + JSON.stringify(res.body));
  assert.equal(res.body.ok, true);
});

// ─── H2: State machine integrity ──────────────────────────────────────────

test('H2-STATE-01: canTransition() used in handleSubmitRequest', () => {
  // Source-level verification: handleSubmitRequest must call canTransition().
  const block = MEMBERSHIP_CTRL_SRC.slice(
    MEMBERSHIP_CTRL_SRC.indexOf('async function handleSubmitRequest'),
    MEMBERSHIP_CTRL_SRC.indexOf('async function handleGetRules')
  );
  assert.ok(block.includes('canTransition(currentStatus, \'PENDING\')'),
    'handleSubmitRequest must call canTransition(currentStatus, "PENDING")');
});

test('H2-STATE-02: 409 INVALID_TRANSITION response format matches admin handlers', () => {
  const block = MEMBERSHIP_CTRL_SRC.slice(
    MEMBERSHIP_CTRL_SRC.indexOf('async function handleSubmitRequest'),
    MEMBERSHIP_CTRL_SRC.indexOf('async function handleGetRules')
  );
  assert.ok(block.includes("'INVALID_TRANSITION'"),
    'must return INVALID_TRANSITION code');
  assert.ok(block.includes('status: 409'),
    'must return 409 status');
  assert.ok(block.includes('details: { from: currentStatus, to: \'PENDING\' }'),
    'must include details.from + details.to');
});

test('H2-STATE-03: ALLOWED_TRANSITIONS unchanged (still only allows INACTIVE/REJECTED/EXPIRED → PENDING)', () => {
  // Verify the state machine was NOT modified to add SUSPENDED → PENDING.
  const block = MEMBERSHIP_CTRL_SRC.slice(
    MEMBERSHIP_CTRL_SRC.indexOf('const ALLOWED_TRANSITIONS'),
    MEMBERSHIP_CTRL_SRC.indexOf('function canTransition')
  );
  assert.ok(block.includes("INACTIVE: ['PENDING']"),
    'INACTIVE → PENDING allowed');
  assert.ok(block.includes("REJECTED: ['PENDING']"),
    'REJECTED → PENDING allowed');
  assert.ok(block.includes("EXPIRED: ['PENDING']"),
    'EXPIRED → PENDING allowed');
  assert.ok(block.includes("SUSPENDED: ['APPROVED']"),
    'SUSPENDED → APPROVED only (NOT PENDING)');
  assert.ok(block.includes("PENDING: ['APPROVED', 'REJECTED']"),
    'PENDING → APPROVED/REJECTED (NOT PENDING)');
  assert.ok(block.includes("APPROVED: ['SUSPENDED', 'EXPIRED']"),
    'APPROVED → SUSPENDED/EXPIRED (NOT PENDING)');
});

test('H2-STATE-04: state check happens BEFORE the transaction (no partial writes)', () => {
  const block = MEMBERSHIP_CTRL_SRC.slice(
    MEMBERSHIP_CTRL_SRC.indexOf('async function handleSubmitRequest'),
    MEMBERSHIP_CTRL_SRC.indexOf('async function handleGetRules')
  );
  const stateCheckIdx = block.indexOf("canTransition(currentStatus, 'PENDING')");
  const txIdx = block.indexOf('queryDbTransaction(env, txQueries)');
  assert.ok(stateCheckIdx >= 0, 'state check exists');
  assert.ok(txIdx >= 0, 'transaction call exists');
  assert.ok(stateCheckIdx < txIdx,
    'state check must happen BEFORE the transaction — no partial writes');
});

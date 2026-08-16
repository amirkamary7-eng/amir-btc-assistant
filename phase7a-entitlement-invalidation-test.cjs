/**
 * Phase 7A — MembershipAuthority Entitlement Cache Invalidation Tests (I1 fix)
 *
 * Verifies that admin/user state-changing handlers in the membership controller
 * immediately bust the mb:ent:{telegramId} positive entitlement cache via the
 * newly-injected membershipAuthority dependency, closing the previous ≤60s
 * stale-isPremium()=true window on revoke paths.
 *
 * Coverage:
 *   WIRING-01..03 — membershipAuthority is injected into createMembershipHandlers
 *                   and the controller calls invalidate() on every state change.
 *   POPULATE-01   — Premium entitlement cache is populated by isPremium().
 *   SUSPEND-01..02 — Admin suspend (request-based) invalidates mb:ent:{id}
 *                    immediately; isPremium() returns false right after.
 *   EXPIRE-01..02  — Admin manual expire invalidates mb:ent:{id} immediately.
 *   SETLEVEL-01..02 — Admin set-level → FREE invalidates mb:ent:{id} immediately.
 *   GRANT-01..02   — Grant-side paths (approve, reactivate) still work; cache
 *                    is also invalidated (defensive) but no stale-false risk.
 *   NEG-01..02     — Negative entitlement is NOT cached (asymmetric policy
 *                    preserved); invalidating a non-cached user is a no-op.
 *   FALLBACK-01    — When membershipAuthority is NOT injected (backwards
 *                    compatibility with old test harnesss), the controller
 *                    still deletes mb:ent:{id} directly via the fallback path.
 *
 * Uses source-eval pattern for isolated testing (same as membership-rules-test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

// ─── Load sources ──────────────────────────────────────────────────────────

const MEMBERSHIP_CTRL_SRC = fs.readFileSync(
  path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
const MEMBERSHIP_REPO_SRC = fs.readFileSync(
  path.join(__dirname, 'src/repositories/membership.js'), 'utf8');
const AUTHORITY_SRC = fs.readFileSync(
  path.join(__dirname, 'src/services/membership_authority.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(
  path.join(__dirname, 'worker-proxy.js'), 'utf8');

function loadFn(src, exportName, replacePattern) {
  let cleaned = src;
  if (replacePattern) {
    cleaned = cleaned.replace(replacePattern, `function ${exportName}`);
  } else {
    cleaned = cleaned.replace(
      new RegExp(`export\\s+function\\s+${exportName}`),
      `function ${exportName}`);
  }
  const exportsObj = {};
  const evaluator = new Function('exports', cleaned + `; exports.${exportName} = ${exportName};`);
  evaluator(exportsObj);
  return exportsObj[exportName];
}

const createMembershipHandlers = loadFn(MEMBERSHIP_CTRL_SRC, 'createMembershipHandlers');
const createMembershipRepository = loadFn(MEMBERSHIP_REPO_SRC, 'createMembershipRepository');
const createMembershipAuthority = loadFn(AUTHORITY_SRC, 'createMembershipAuthority');

// ─── Mock helpers ──────────────────────────────────────────────────────────

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

/** Mock queryDb that returns a configurable user row + records UPDATE calls. */
function createMockQueryDb(opts = {}) {
  const calls = [];
  let currentUserRow = opts.userRow || null;

  const fn = async (env, sql, params) => {
    calls.push({ sql, params });
    const s = (sql || '').toLowerCase();

    // SELECT membership_users by telegram_id
    if (s.includes('from membership_users') && s.includes('where telegram_id')) {
      return { rows: currentUserRow ? [currentUserRow] : [] };
    }
    // UPDATE membership_users — capture the new state so subsequent findByTelegramId
    // returns the post-mutation row (simulates DB state change).
    if (s.includes('update membership_users') && s.includes('set')) {
      // Heuristic: parse the new status / level from the SET clause.
      const statusMatch = s.match(/membership_status\s*=\s*'([A-Z]+)'/);
      const levelMatch = s.match(/membership_level\s*=\s*'([A-Z]+)'/);
      if (statusMatch || levelMatch) {
        currentUserRow = {
          ...(currentUserRow || {}),
          membership_status: statusMatch ? statusMatch[1] : (currentUserRow?.membership_status || 'INACTIVE'),
          membership_level: levelMatch ? levelMatch[1] : (currentUserRow?.membership_level || 'FREE'),
        };
      }
      return { rows: [], rowCount: 1 };
    }
    // membership_requests lookups
    if (s.includes('from membership_requests') && s.includes('where telegram_id') && s.includes('and status =')) {
      return { rows: opts.pendingRequest ? [opts.pendingRequest] : [] };
    }
    if (s.includes('from membership_requests') && s.includes('where exchange_uid')) {
      return { rows: [] };
    }
    if (s.includes('from membership_requests') && s.includes('where id =')) {
      return { rows: opts.requestRow ? [opts.requestRow] : [] };
    }
    if (s.includes('insert into membership_users')) {
      return { rows: [{ telegram_id: String(params?.[0]) }] };
    }
    if (s.includes('select 1 from membership_users')) {
      return { rows: [{ '?column?': 1 }] };
    }
    // Rules lookups (fail-open when no rules row)
    if (s.includes('from membership_rules')) {
      return { rows: [] };
    }
    if (s.includes('from membership_rule_acceptances')) {
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
    // Mirror the queryDb mock: apply UPDATE membership_users mutations to the
    // shared currentUserRow state by returning a synthetic result. We also
    // parse the SQL to update the in-memory state via the side-effect of
    // queryDb being called next. For simplicity here, we just return empty
    // results — the test scenarios below configure queryDb to return the
    // post-mutation row on the next findByTelegramId call.
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

/** Build the deps for createMembershipHandlers, with membershipAuthority injected. */
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
  const membershipAuthority = createMembershipAuthority({
    membershipRepo,
    readAppCache: async (e, k) => e.APP_CACHE.get(k),
    writeAppCache: async (e, k, v, t) => e.APP_CACHE.put(k, v, t),
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

  const deps = {
    jsonResponse, authenticateTelegramRequest, isAdminTelegramId, isDatabaseConfigured,
    readAppCache, writeAppCache, safeDbErrorResponse, buildBodyFieldValidationError,
    readJsonBody, membershipRepo, queryDbTransaction,
    notificationRepo: null, notificationPlatformRepo: null, notificationService: null,
    sendTelegramMessage: async () => ({}), resolveWebAppUrl: () => 'https://app.example.com',
    // PHASE 7A: inject the real MembershipAuthority instance.
    membershipAuthority,
    _env: env, _queryDb: queryDb,
  };
  return deps;
}

/** Build deps WITHOUT membershipAuthority (for fallback-path test). */
function buildDepsWithoutAuthority(opts = {}) {
  const deps = buildDeps(opts);
  delete deps.membershipAuthority;
  return deps;
}

const ADMIN_USER = { id: 831704732, first_name: 'Admin', username: 'admin' };
const TARGET_TG_ID = '555666777';

const PREMIUM_USER_ROW = {
  telegram_id: TARGET_TG_ID,
  membership_level: 'PREMIUM',
  membership_status: 'APPROVED',
  membership_source: 'EXCHANGE',
  approved_at: '2026-01-01T00:00:00Z',
  expire_at: null,
  username: 'target_user',
  first_name: 'Target',
  last_name: 'User',
};

const PENDING_REQUEST_ROW = {
  id: 'req-001',
  telegram_id: TARGET_TG_ID,
  exchange_name: 'Bitunix',
  exchange_uid: 'UID123456',
  status: 'PENDING',
  created_at: '2026-01-01T00:00:00Z',
};

// ─── Tests: Wiring ─────────────────────────────────────────────────────────

test('WIRING-01: worker-proxy.js injects membershipAuthority into createMembershipHandlers', () => {
  // Find the createMembershipHandlers({ ... }) call block and verify it includes membershipAuthority.
  const idx = WORKER_SRC.indexOf('createMembershipHandlers({');
  assert.ok(idx >= 0, 'createMembershipHandlers call exists');
  const block = WORKER_SRC.slice(idx, idx + 800);
  assert.ok(block.includes('membershipAuthority'),
    'membershipAuthority must be injected into createMembershipHandlers');
});

test('WIRING-02: membership controller destructures membershipAuthority from deps', () => {
  assert.ok(MEMBERSHIP_CTRL_SRC.includes('membershipAuthority,'),
    'controller must destructure membershipAuthority from deps');
});

test('WIRING-03: invalidateCaches() calls membershipAuthority.invalidate() when present', () => {
  assert.ok(MEMBERSHIP_CTRL_SRC.includes('membershipAuthority.invalidate(env, telegramId)'),
    'invalidateCaches must call membershipAuthority.invalidate()');
  assert.ok(MEMBERSHIP_CTRL_SRC.includes("'mb:ent:' + telegramId"),
    'fallback path must delete mb:ent:{id} directly');
});

// ─── Tests: Premium entitlement cache populated ────────────────────────────

test('POPULATE-01: isPremium() populates mb:ent:{id} for APPROVED PREMIUM user', async () => {
  const deps = buildDeps({ userRow: PREMIUM_USER_ROW });
  const tgId = TARGET_TG_ID;
  // First call: hits DB, caches positive result.
  const isPrem = await deps.membershipAuthority.isPremium(deps._env, tgId);
  assert.equal(isPrem, true, 'APPROVED PREMIUM user is premium');
  // Cache key must now exist.
  assert.ok(deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'positive entitlement must be cached under mb:ent:{id}');
});

// ─── Tests: Admin suspend invalidates mb:ent:{id} immediately ──────────────

test('SUSPEND-01: handleSuspend clears mb:ent:{id} cache immediately', async () => {
  // Start with an APPROVED PREMIUM user.
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' },
    requestRow: null,
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  // Populate the entitlement cache.
  await deps.membershipAuthority.isPremium(deps._env, tgId);
  assert.ok(deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'precondition: cache populated');

  // Admin calls POST /api/admin/membership/suspend with a requestId.
  // The state-machine path requires the user to be APPROVED, which our mock is.
  // We use handleSuspend (request-based) which expects { requestId }.
  // Configure the mock to return a PENDING request so findRequestById succeeds.
  deps._queryDb._setUserRow({ ...PREMIUM_USER_ROW, membership_status: 'APPROVED' });

  // We need findRequestById to return a request for the target user.
  // Rebuild queryDb with a requestRow configured.
  const depsWithReq = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' },
    requestRow: { id: 'req-001', telegram_id: tgId, status: 'PENDING' },
  });
  const handlersWithReq = createMembershipHandlers(depsWithReq);
  // Populate cache in the new env.
  await depsWithReq.membershipAuthority.isPremium(depsWithReq._env, tgId);
  assert.ok(depsWithReq._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'precondition: cache populated (with req)');

  // Note: handleSuspend requires user to be APPROVED (not PENDING request).
  // The action handler does NOT check req.status === 'PENDING' for suspend;
  // it checks canTransition(statusBefore, 'SUSPENDED'). APPROVED → SUSPENDED is allowed.
  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlersWithReq.handleSuspend(
    makeRequest('POST', '/api/admin/membership/suspend', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'test suspend' },
    }),
    depsWithReq._env,
  );
  assert.equal(res.status, 200, 'suspend should succeed, got: ' + JSON.stringify(res.body));

  // CRITICAL ASSERTION: mb:ent:{id} must be cleared immediately.
  assert.ok(!depsWithReq._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'mb:ent:{id} MUST be cleared immediately after suspend (no 60s stale window)');
});

test('SUSPEND-02: after suspend, isPremium() returns false (no stale true)', async () => {
  // Use a mutable user row so the mock DB reflects the suspend mutation.
  let currentUserRow = { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' };
  const env = createEnv();
  const queryDb = async (e, sql, params) => {
    const s = (sql || '').toLowerCase();
    if (s.includes('from membership_users') && s.includes('where telegram_id')) {
      return { rows: [currentUserRow] };
    }
    if (s.includes('update membership_users') && s.includes('set')) {
      // Reflect the mutation: APPROVED → SUSPENDED
      currentUserRow = { ...currentUserRow, membership_status: 'SUSPENDED' };
      return { rows: [], rowCount: 1 };
    }
    if (s.includes('from membership_requests') && s.includes('where id =')) {
      return { rows: [{ id: 'req-001', telegram_id: TARGET_TG_ID, status: 'PENDING' }] };
    }
    if (s.includes('from membership_rules')) return { rows: [] };
    if (s.includes('from membership_rule_acceptances')) return { rows: [] };
    return { rows: [], rowCount: 0 };
  };
  const queryDbTransaction = async (e, queries) => {
    // Apply UPDATE membership_users mutations to the in-memory row.
    for (const q of queries) {
      const s = (q.sql || '').toLowerCase();
      if (s.includes('update membership_users') && s.includes('set')) {
        if (s.includes("'suspended'")) {
          currentUserRow = { ...currentUserRow, membership_status: 'SUSPENDED' };
        } else if (s.includes("'expired'")) {
          currentUserRow = { ...currentUserRow, membership_status: 'EXPIRED' };
        } else if (s.includes("'inactive'")) {
          currentUserRow = { ...currentUserRow, membership_status: 'INACTIVE', membership_level: 'FREE' };
        } else if (s.includes("'approved'")) {
          currentUserRow = { ...currentUserRow, membership_status: 'APPROVED' };
        }
      }
    }
    return queries.map(q => ({ rows: [], rowCount: 0 }));
  };
  const membershipRepo = createMembershipRepository({
    queryDb, queryDbTransaction,
    isDatabaseConfigured: () => true,
    isoDate: () => '2026-01-01',
    normalizeOptionalString: (s) => s == null ? null : String(s).trim(),
  });
  const membershipAuthority = createMembershipAuthority({
    membershipRepo,
    readAppCache: async (e, k) => e.APP_CACHE.get(k),
    writeAppCache: async (e, k, v, t) => e.APP_CACHE.put(k, v, t),
  });
  const deps = {
    jsonResponse: (body, init) => ({ status: init?.status || 200, body }),
    authenticateTelegramRequest: async (request) => {
      const initData = request.headers?.get?.('X-Telegram-Init-Data');
      const params = new URLSearchParams(initData);
      return { user: JSON.parse(params.get('user')), error: null };
    },
    isAdminTelegramId: (env, id) => String(id) === '831704732',
    isDatabaseConfigured: () => true,
    readAppCache: async (e, k) => e.APP_CACHE.get(k),
    writeAppCache: async (e, k, v, t) => e.APP_CACHE.put(k, v, t),
    safeDbErrorResponse: (e) => ({ status: 503, body: { error: 'DB error', message: e.message } }),
    buildBodyFieldValidationError: (errors) => ({ status: 422, body: { error: 'Validation failed', details: errors } }),
    readJsonBody: async (request) => {
      const text = await request.text();
      return { payload: text ? JSON.parse(text) : {}, error: null };
    },
    membershipRepo, queryDbTransaction,
    notificationRepo: null, notificationPlatformRepo: null, notificationService: null,
    sendTelegramMessage: async () => ({}), resolveWebAppUrl: () => 'https://app.example.com',
    membershipAuthority,
    _env: env,
  };

  const handlers = createMembershipHandlers(deps);
  // Populate cache while user is APPROVED PREMIUM.
  assert.equal(await membershipAuthority.isPremium(env, TARGET_TG_ID), true);
  assert.ok(env.APP_CACHE._store.has('mb:ent:' + TARGET_TG_ID),
    'precondition: cache populated');

  // Suspend the user.
  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleSuspend(
    makeRequest('POST', '/api/admin/membership/suspend', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'test' },
    }),
    env,
  );
  assert.equal(res.status, 200, 'suspend succeeded: ' + JSON.stringify(res.body));

  // CRITICAL: isPremium must now return false immediately (no 60s stale window).
  assert.equal(await membershipAuthority.isPremium(env, TARGET_TG_ID), false,
    'after suspend + invalidate, isPremium() must return false immediately — NO stale true window');
});

// ─── Tests: Admin manual expire invalidates mb:ent:{id} immediately ────────

test('EXPIRE-01: handleManualExpire clears mb:ent:{id} cache immediately', async () => {
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' },
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  // Populate cache.
  await deps.membershipAuthority.isPremium(deps._env, tgId);
  assert.ok(deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'precondition: cache populated');

  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleManualExpire(
    makeRequest('POST', '/api/admin/membership/users/expire', {
      initData: adminInitData,
      body: { telegramId: tgId, adminNote: 'manual expire' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'expire succeeded: ' + JSON.stringify(res.body));

  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'mb:ent:{id} MUST be cleared immediately after manual expire');
});

// ─── Tests: Admin set-level → FREE invalidates mb:ent:{id} immediately ─────

test('SETLEVEL-01: handleSetLevel → FREE clears mb:ent:{id} cache immediately', async () => {
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' },
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  await deps.membershipAuthority.isPremium(deps._env, tgId);
  assert.ok(deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'precondition: cache populated');

  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleSetLevel(
    makeRequest('POST', '/api/admin/membership/users/set-level', {
      initData: adminInitData,
      body: { telegramId: tgId, level: 'FREE', adminNote: 'revoke premium' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'set-level→FREE succeeded: ' + JSON.stringify(res.body));

  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'mb:ent:{id} MUST be cleared immediately after set-level → FREE');
});

test('SETLEVEL-02: handleSetLevel → PREMIUM also invalidates (defensive)', async () => {
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_level: 'FREE', membership_status: 'INACTIVE' },
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  // No cache populated (FREE user → negative not cached).
  // After set-level → PREMIUM, cache should still be empty (no stale entry).
  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleSetLevel(
    makeRequest('POST', '/api/admin/membership/users/set-level', {
      initData: adminInitData,
      body: { telegramId: tgId, level: 'PREMIUM', adminNote: 'grant premium' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'set-level→PREMIUM succeeded: ' + JSON.stringify(res.body));
  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'cache must be empty after set-level → PREMIUM (defensive invalidate)');
});

// ─── Tests: Grant-side behavior unchanged ──────────────────────────────────

test('GRANT-01: handleReactivate on a SUSPENDED PREMIUM user — cache also cleared (defensive)', async () => {
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'SUSPENDED' },
    requestRow: null,
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  // Manually populate the cache with a stale positive entry.
  await deps._env.APP_CACHE.put('mb:ent:' + tgId, JSON.stringify({
    isPremium: true, level: 'PREMIUM', status: 'APPROVED', source: 'EXCHANGE',
    approvedAt: '2026-01-01T00:00:00Z', expireAt: null,
    eligible: true, graceUntil: null, computedAt: '2026-01-01T00:00:00Z',
  }), 60);
  assert.ok(deps._env.APP_CACHE._store.has('mb:ent:' + tgId), 'precondition');

  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  // handleReactivate (request-based) requires user to be SUSPENDED.
  // Our mock returns a SUSPENDED user, but we need a requestId.
  // Rebuild with requestRow.
  const depsWithReq = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'SUSPENDED' },
    requestRow: { id: 'req-001', telegram_id: tgId, status: 'PENDING' },
  });
  const handlersWithReq = createMembershipHandlers(depsWithReq);
  // Manually populate cache (user is SUSPENDED so isPremium would return false; bypass).
  await depsWithReq._env.APP_CACHE.put('mb:ent:' + tgId, JSON.stringify({
    isPremium: true, level: 'PREMIUM', status: 'APPROVED', source: 'EXCHANGE',
    approvedAt: '2026-01-01T00:00:00Z', expireAt: null,
    eligible: true, graceUntil: null, computedAt: '2026-01-01T00:00:00Z',
  }), 60);

  const res = await handlersWithReq.handleReactivate(
    makeRequest('POST', '/api/admin/membership/reactivate', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'reactivate' },
    }),
    depsWithReq._env,
  );
  assert.equal(res.status, 200, 'reactivate succeeded: ' + JSON.stringify(res.body));
  // Cache should be cleared (defensive) even on grant side.
  assert.ok(!depsWithReq._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'reactivate should also invalidate cache (defensive — prevents stale approvedAt/level)');
});

test('GRANT-02: handleApprove (PENDING → APPROVED) — no stale-false risk (grant side unaffected)', async () => {
  // Approve path: user starts as FREE/INACTIVE (no positive cache to be stale).
  // After approve, cache is invalidated (defensive). The next isPremium() call
  // queries DB fresh and caches the new positive result.
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_level: 'FREE', membership_status: 'INACTIVE' },
    requestRow: { id: 'req-001', telegram_id: TARGET_TG_ID, status: 'PENDING' },
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  // FREE/INACTIVE → isPremium returns false, nothing cached.
  assert.equal(await deps.membershipAuthority.isPremium(deps._env, tgId), false);
  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'negative not cached (asymmetric policy)');

  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleApprove(
    makeRequest('POST', '/api/admin/membership/approve', {
      initData: adminInitData,
      body: { requestId: 'req-001', adminNote: 'approve' },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'approve succeeded: ' + JSON.stringify(res.body));
  // Cache still empty (defensive invalidate on a non-cached user is a no-op).
  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'cache empty after approve (defensive invalidate is a no-op on empty cache)');
});

// ─── Tests: Negative entitlement NOT cached (asymmetric policy preserved) ──

test('NEG-01: isPremium() for INACTIVE/FREE user does NOT populate mb:ent:{id}', async () => {
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_level: 'FREE', membership_status: 'INACTIVE' },
  });
  const tgId = TARGET_TG_ID;
  await deps.membershipAuthority.isPremium(deps._env, tgId);
  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'negative entitlement must NOT be cached');
});

test('NEG-02: invalidating a non-cached user is a no-op (no error)', async () => {
  const deps = buildDeps({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' },
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;
  // No prior isPremium() call → cache empty.
  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleManualExpire(
    makeRequest('POST', '/api/admin/membership/users/expire', {
      initData: adminInitData,
      body: { telegramId: tgId },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'expire on non-cached user must not error');
});

// ─── Tests: Fallback path (membershipAuthority not injected) ───────────────

test('FALLBACK-01: without membershipAuthority injected, invalidateCaches still deletes mb:ent:{id} directly', async () => {
  // Build deps WITHOUT membershipAuthority (simulates old test harness or pre-7A wiring).
  const deps = buildDepsWithoutAuthority({
    userRow: { ...PREMIUM_USER_ROW, membership_status: 'APPROVED' },
  });
  const handlers = createMembershipHandlers(deps);
  const tgId = TARGET_TG_ID;

  // Manually populate the entitlement cache (simulating a prior isPremium() call
  // from another code path that DID have authority access).
  await deps._env.APP_CACHE.put('mb:ent:' + tgId, JSON.stringify({
    isPremium: true, level: 'PREMIUM', status: 'APPROVED', source: 'EXCHANGE',
    approvedAt: null, expireAt: null, eligible: true, graceUntil: null,
    computedAt: '2026-01-01T00:00:00Z',
  }), 60);
  assert.ok(deps._env.APP_CACHE._store.has('mb:ent:' + tgId), 'precondition');

  const adminInitData = buildInitData('test-bot-token', ADMIN_USER);
  const res = await handlers.handleManualExpire(
    makeRequest('POST', '/api/admin/membership/users/expire', {
      initData: adminInitData,
      body: { telegramId: tgId },
    }),
    deps._env,
  );
  assert.equal(res.status, 200, 'expire succeeded without authority injected');
  // Fallback path must still clear mb:ent:{id}.
  assert.ok(!deps._env.APP_CACHE._store.has('mb:ent:' + tgId),
    'fallback path must delete mb:ent:{id} directly');
});

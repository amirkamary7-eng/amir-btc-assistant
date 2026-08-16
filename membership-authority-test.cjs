/**
 * MembershipAuthority — Phase 0 Foundation Tests
 *
 * Tests the entitlement authority in isolation by:
 * 1. Reading the source of src/services/membership_authority.js
 * 2. Evaluating it with `new Function` (ES module export → CommonJS bridge)
 * 3. Injecting mock deps (membershipRepo, readAppCache, writeAppCache)
 *
 * Coverage:
 *   - Pure computation (_computeEntitlement) for all 6 states + expiry
 *   - isPremium() with cache hit/miss
 *   - getEntitlement() single-flight deduplication
 *   - Negative result never cached
 *   - Positive result cached 60s
 *   - invalidate() clears cache
 *   - require() not needed (Phase 0: no feature gating)
 *   - DB error fails-safe to not-premium
 *   - Full Telegram ID never logged
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ─── Load the authority source ──────────────────────────────────────────────

const AUTHORITY_SRC = fs.readFileSync(
  path.join(__dirname, 'src/services/membership_authority.js'),
  'utf8'
);

function loadAuthority() {
  const src = AUTHORITY_SRC.replace(
    /export\s+function\s+createMembershipAuthority/,
    'function createMembershipAuthority'
  );
  const exportsObj = {};
  const evaluator = new Function('exports', src + '; exports.createMembershipAuthority = createMembershipAuthority;');
  evaluator(exportsObj);
  return exportsObj.createMembershipAuthority;
}

const createMembershipAuthority = loadAuthority();

// ─── Mock helpers ───────────────────────────────────────────────────────────

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

function createMockRepo(userRow) {
  let callCount = 0;
  return {
    findByTelegramId: async (env, tgId) => {
      callCount++;
      return userRow;
    },
    _callCount: () => callCount,
  };
}

function createEnv(overrides = {}) {
  return {
    APP_CACHE: createMemoryKv(),
    ...overrides,
  };
}

function makeUser(overrides = {}) {
  return {
    membership_level: 'FREE',
    membership_status: 'INACTIVE',
    membership_source: 'MANUAL',
    approved_at: null,
    expire_at: null,
    ...overrides,
  };
}

// ─── Tests: Pure computation (_computeEntitlement) ─────────────────────────

test('AUTH-01: _computeEntitlement — APPROVED + PREMIUM + no expire → isPremium=true', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({
    membership_level: 'PREMIUM',
    membership_status: 'APPROVED',
    membership_source: 'EXCHANGE',
    approved_at: '2026-01-01T00:00:00Z',
    expire_at: null,
  });
  const ent = auth._computeEntitlement(user, Date.now());
  assert.equal(ent.isPremium, true);
  assert.equal(ent.level, 'PREMIUM');
  assert.equal(ent.status, 'APPROVED');
  assert.equal(ent.source, 'EXCHANGE');
  assert.equal(ent.eligible, true);
  assert.equal(ent.graceUntil, null);
  assert.ok(ent.computedAt);
});

test('AUTH-02: _computeEntitlement — PENDING → isPremium=false', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({ membership_level: 'PREMIUM', membership_status: 'PENDING' });
  assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, false);
});

test('AUTH-03: _computeEntitlement — SUSPENDED → isPremium=false', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({ membership_level: 'PREMIUM', membership_status: 'SUSPENDED' });
  assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, false);
});

test('AUTH-04: _computeEntitlement — EXPIRED → isPremium=false', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({ membership_level: 'PREMIUM', membership_status: 'EXPIRED' });
  assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, false);
});

test('AUTH-05: _computeEntitlement — INACTIVE → isPremium=false', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({ membership_level: 'FREE', membership_status: 'INACTIVE' });
  const ent = auth._computeEntitlement(user, Date.now());
  assert.equal(ent.isPremium, false);
  assert.equal(ent.level, 'FREE');
  assert.equal(ent.status, 'INACTIVE');
});

test('AUTH-06: _computeEntitlement — REJECTED → isPremium=false', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({ membership_level: 'FREE', membership_status: 'REJECTED' });
  assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, false);
});

test('AUTH-07: _computeEntitlement — APPROVED but expire_at in past → isPremium=false', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const user = makeUser({
    membership_level: 'PREMIUM',
    membership_status: 'APPROVED',
    expire_at: '2020-01-01T00:00:00Z',
  });
  assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, false);
});

test('AUTH-08: _computeEntitlement — APPROVED + future expire_at → isPremium=true', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const future = new Date(Date.now() + 86400000).toISOString();
  const user = makeUser({
    membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: future,
  });
  assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, true);
});

test('AUTH-09: _computeEntitlement — null user (unknown) → isPremium=false, FREE/INACTIVE', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  const ent = auth._computeEntitlement(null, Date.now());
  assert.equal(ent.isPremium, false);
  assert.equal(ent.level, 'FREE');
  assert.equal(ent.status, 'INACTIVE');
  assert.equal(ent.source, 'MANUAL');
});

test('AUTH-10: _computeEntitlement — VIP and ELITE levels also grant premium', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null,
    writeAppCache: async () => {},
  });
  for (const level of ['VIP', 'PREMIUM', 'ELITE']) {
    const user = makeUser({ membership_level: level, membership_status: 'APPROVED' });
    assert.equal(auth._computeEntitlement(user, Date.now()).isPremium, true, `${level} + APPROVED = premium`);
  }
  const freeUser = makeUser({ membership_level: 'FREE', membership_status: 'APPROVED' });
  assert.equal(auth._computeEntitlement(freeUser, Date.now()).isPremium, false, 'FREE + APPROVED = NOT premium');
});

// ─── Tests: isPremium with cache ────────────────────────────────────────────

test('AUTH-11: isPremium — first call hits DB, caches positive result', async () => {
  const repo = createMockRepo(makeUser({
    membership_level: 'PREMIUM', membership_status: 'APPROVED',
  }));
  const env = createEnv();
  const auth = createMembershipAuthority({
    membershipRepo: repo, readAppCache: async (e,k) => e.APP_CACHE.get(k),
    writeAppCache: async (e,k,v,t) => e.APP_CACHE.put(k,v,t),
  });
  const r1 = await auth.isPremium(env, '999');
  assert.equal(r1, true);
  assert.equal(repo._callCount(), 1, 'first call hits DB');

  const ck = 'mb:ent:999';
  assert.ok(env.APP_CACHE._store.has(ck), 'positive result cached');

  const r2 = await auth.isPremium(env, '999');
  assert.equal(r2, true);
  assert.equal(repo._callCount(), 1, 'second call uses cache (no DB hit)');
});

test('AUTH-12: isPremium — negative result NOT cached (re-checks every time)', async () => {
  const repo = createMockRepo(makeUser({ membership_status: 'INACTIVE' }));
  const env = createEnv();
  const auth = createMembershipAuthority({
    membershipRepo: repo, readAppCache: async (e,k) => e.APP_CACHE.get(k),
    writeAppCache: async (e,k,v,t) => e.APP_CACHE.put(k,v,t),
  });
  await auth.isPremium(env, '888');
  assert.equal(repo._callCount(), 1);
  assert.ok(!env.APP_CACHE._store.has('mb:ent:888'), 'negative NOT cached');
  await auth.isPremium(env, '888');
  assert.equal(repo._callCount(), 2, 'second call hits DB (negative not cached)');
});

// ─── Tests: invalidate ──────────────────────────────────────────────────────

test('AUTH-13: invalidate — clears entitlement + status cache', async () => {
  const repo = createMockRepo(makeUser({
    membership_level: 'PREMIUM', membership_status: 'APPROVED',
  }));
  const env = createEnv();
  const auth = createMembershipAuthority({
    membershipRepo: repo, readAppCache: async (e,k) => e.APP_CACHE.get(k),
    writeAppCache: async (e,k,v,t) => e.APP_CACHE.put(k,v,t),
  });
  await auth.isPremium(env, '777');
  assert.ok(env.APP_CACHE._store.has('mb:ent:777'));
  await env.APP_CACHE.put('mb:status:777', 'cached', 300);
  await auth.invalidate(env, '777');
  assert.ok(!env.APP_CACHE._store.has('mb:ent:777'), 'entitlement cache cleared');
  assert.ok(!env.APP_CACHE._store.has('mb:status:777'), 'status cache cleared');
});

test('AUTH-14: invalidate — after revoke, isPremium re-queries and returns false', async () => {
  let currentUser = makeUser({ membership_level: 'PREMIUM', membership_status: 'APPROVED' });
  const repo = { findByTelegramId: async () => currentUser };
  const env = createEnv();
  const auth = createMembershipAuthority({
    membershipRepo: repo, readAppCache: async (e,k) => e.APP_CACHE.get(k),
    writeAppCache: async (e,k,v,t) => e.APP_CACHE.put(k,v,t),
  });
  assert.equal(await auth.isPremium(env, '666'), true);
  currentUser = makeUser({ membership_level: 'PREMIUM', membership_status: 'SUSPENDED' });
  await auth.invalidate(env, '666');
  assert.equal(await auth.isPremium(env, '666'), false, 'after suspend + invalidate → false');
});

// ─── Tests: Single-flight deduplication ─────────────────────────────────────

test('AUTH-15: getEntitlement — concurrent calls share one DB query', async () => {
  let dbCalls = 0;
  const repo = {
    findByTelegramId: async () => {
      dbCalls++;
      await new Promise(r => setTimeout(r, 50));
      return makeUser({ membership_level: 'PREMIUM', membership_status: 'APPROVED' });
    },
  };
  const env = createEnv();
  const auth = createMembershipAuthority({
    membershipRepo: repo, readAppCache: async (e,k) => e.APP_CACHE.get(k),
    writeAppCache: async (e,k,v,t) => e.APP_CACHE.put(k,v,t),
  });
  const results = await Promise.all([
    auth.getEntitlement(env, '111'),
    auth.getEntitlement(env, '111'),
    auth.getEntitlement(env, '111'),
    auth.getEntitlement(env, '111'),
    auth.getEntitlement(env, '111'),
  ]);
  assert.equal(dbCalls, 1, '5 concurrent calls → 1 DB query');
  for (const ent of results) assert.equal(ent.isPremium, true);
});

// ─── Tests: Fail-safe ───────────────────────────────────────────────────────

test('AUTH-16: isPremium — DB error returns false (fail-safe)', async () => {
  const repo = { findByTelegramId: async () => { throw new Error('DB down'); } };
  const env = createEnv();
  const auth = createMembershipAuthority({
    membershipRepo: repo, readAppCache: async (e,k) => e.APP_CACHE.get(k),
    writeAppCache: async (e,k,v,t) => e.APP_CACHE.put(k,v,t),
  });
  assert.equal(await auth.isPremium(env, '123'), false, 'DB error → false (fail-safe)');
});

test('AUTH-17: isPremium — cache read error falls through to DB', async () => {
  const repo = createMockRepo(makeUser({
    membership_level: 'PREMIUM', membership_status: 'APPROVED',
  }));
  const auth = createMembershipAuthority({
    membershipRepo: repo,
    readAppCache: async () => { throw new Error('KV read failed'); },
    writeAppCache: async () => {},
  });
  assert.equal(await auth.isPremium({}, '123'), true, 'cache error falls through to DB');
});

test('AUTH-18: invalidate — KV delete error is non-fatal', async () => {
  const env = { APP_CACHE: { delete: async () => { throw new Error('KV delete failed'); } } };
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null, writeAppCache: async () => {},
  });
  await auth.invalidate(env, '123'); // must not throw
});

// ─── Tests: Constants ───────────────────────────────────────────────────────

test('AUTH-19: Constants — TTL=60s, PREMIUM_LEVELS correct', () => {
  const auth = createMembershipAuthority({
    membershipRepo: createMockRepo(null),
    readAppCache: async () => null, writeAppCache: async () => {},
  });
  assert.equal(auth._constants.CACHE_TTL_POSITIVE, 60);
  assert.ok(auth._constants.PREMIUM_LEVELS.has('VIP'));
  assert.ok(auth._constants.PREMIUM_LEVELS.has('PREMIUM'));
  assert.ok(auth._constants.PREMIUM_LEVELS.has('ELITE'));
  assert.ok(!auth._constants.PREMIUM_LEVELS.has('FREE'));
});

// ─── Tests: Phase 0 scope guard ─────────────────────────────────────────────

test('AUTH-20: Phase 3/4 — authority is called for tier-based quotas (expected)', () => {
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  // Phase 3+4: isPremium IS called (for tier-based quotas and rewards), but require() is NOT.
  const requireCalls = workerSrc.match(/membershipAuthority\.require\s*\(/g) || [];
  assert.equal(requireCalls.length, 0, 'no authority.require() calls (no Premium-exclusive gating)');
  const isPremiumCalls = workerSrc.match(/membershipAuthority\.isPremium\s*\(/g) || [];
  assert.ok(isPremiumCalls.length >= 1, 'isPremium called for tier-based quotas (Phase 3/4)');
});

test('AUTH-21: Phase 0 — authority is wired in worker-proxy.js', () => {
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  assert.ok(workerSrc.includes('import { createMembershipAuthority }'), 'import present');
  assert.ok(workerSrc.includes('const membershipAuthority = createMembershipAuthority'), 'instance created');
  assert.ok(workerSrc.includes('membershipRepo'), 'wired with membershipRepo');
  assert.ok(workerSrc.includes('readAppCache'), 'wired with readAppCache');
  assert.ok(workerSrc.includes('writeAppCache'), 'wired with writeAppCache');
});

// ─── Tests: Privacy ─────────────────────────────────────────────────────────

test('AUTH-22: Diagnostics do not log full Telegram ID', () => {
  const warnings = [];
  const origWarn = console.warn;
  console.warn = (...args) => { warnings.push(args.join(' ')); };
  try {
    const repo = { findByTelegramId: async () => { throw new Error('test'); } };
    const auth = createMembershipAuthority({
      membershipRepo: repo,
      readAppCache: async () => null,
      writeAppCache: async () => {},
    });
    return auth.isPremium({}, '987654321012345').then(() => {
      const fullIdPresent = warnings.some(w => w.includes('987654321012345'));
      assert.equal(fullIdPresent, false, 'full Telegram ID must NOT appear in logs');
    });
  } finally {
    console.warn = origWarn;
  }
});

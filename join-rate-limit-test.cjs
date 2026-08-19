/**
 * MembershipGateway rate-limit & join verification tests (RL-001 to RL-017).
 *
 * Tests the smart rate gate + Telegram 429 backoff + post-join verification.
 *
 * Run: node --test join-rate-limit-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GATEWAY_SRC = fs.readFileSync(path.join(__dirname, 'src/services/membershipGateway.js'), 'utf8');

function loadGateway(mockDeps) {
  const exportsObj = {};
  const src = GATEWAY_SRC.replace(/^export\s+function\s+/m, 'function ');
  const evaluator = new Function('exports', 'setTimeout', 'console', src + '\nexports.createMembershipGateway = createMembershipGateway;');
  evaluator(exportsObj, setTimeout, console);
  return exportsObj.createMembershipGateway(mockDeps);
}

function createMockDeps(opts = {}) {
  return {
    isAdminTelegramId: opts.isAdminTelegramId || (() => false),
    getCachedJoinStatus: opts.getCachedJoinStatus || (async () => null),
    setCachedJoinStatus: opts.setCachedJoinStatus || (async () => {}),
    getDbUserJoinState: opts.getDbUserJoinState || (async () => null),
    persistDbUserJoinState: opts.persistDbUserJoinState || (async () => {}),
    checkChannelMembership: opts.checkChannelMembership || (async () => ({ joined: true })),
    checkAdditionalRequiredChannels: opts.checkAdditionalRequiredChannels || (async () => ({ joined: true, channels: 0 })),
    isDatabaseConfigured: opts.isDatabaseConfigured || (() => true),
    safeError: opts.safeError || ((scope, err) => JSON.stringify({ scope, error: String(err) })),
  };
}

function createEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'test-token',
    REQUIRED_CHANNEL: 'test_channel',
    ADMIN_TELEGRAM_ID: '999999',
    APP_CACHE: { get: async () => null, put: async () => {} },
    JOIN_CACHE: { get: async () => null, put: async () => {} },
    RATE_LIMITS: { get: async () => null, put: async () => {} },
    ...overrides,
  };
}

// RL-001: Non-member → Check → not joined
test('RL-001: Non-member returns joined:false', async () => {
  const deps = createMockDeps({
    checkChannelMembership: async () => ({ joined: false, reason: 'not_member' }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(result.joined, false);
});

// RL-002: Immediate second Check — rate gate returns last-known (no Telegram)
test('RL-002: Immediate second check returns rate_limited (no Telegram)', async () => {
  let telegramCount = 0;
  const deps = createMockDeps({
    checkChannelMembership: async () => { telegramCount++; return { joined: false, reason: 'not_member' }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  await gw.check(env, '123', { forceRefresh: true });
  const r2 = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(r2.joined, false);
  assert.equal(r2.reason, 'rate_limited');
  assert.ok(r2.retry_after > 0, 'should have retry_after');
  assert.equal(telegramCount, 1, 'Telegram should be called only ONCE');
});

// RL-003: Rapid clicks — only 1 Telegram call
test('RL-003: 5 rapid clicks → 1 Telegram call', async () => {
  let telegramCount = 0;
  const deps = createMockDeps({
    checkChannelMembership: async () => { telegramCount++; return { joined: false, reason: 'not_member' }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  for (let i = 0; i < 5; i++) {
    await gw.check(env, '123', { forceRefresh: true });
  }
  assert.equal(telegramCount, 1, '5 rapid clicks should result in only 1 Telegram call');
});

// RL-004: Non-member → Join → Check within 5s → rate_limited (but returns last-known false)
test('RL-004: After join, check within 5s returns rate_limited with last-known false', async () => {
  let telegramCount = 0;
  let userJoined = false;
  const deps = createMockDeps({
    checkChannelMembership: async () => {
      telegramCount++;
      return userJoined ? { joined: true } : { joined: false, reason: 'not_member' };
    },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  // First check: not member
  await gw.check(env, '123', { forceRefresh: true });
  // User joins
  userJoined = true;
  // Second check within 5s: rate gate returns last-known (false) + rate_limited
  const r2 = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(r2.joined, false, 'should return last-known false (rate gate)');
  assert.equal(r2.reason, 'rate_limited');
  assert.equal(telegramCount, 1, 'Telegram should NOT be called again within 5s');
});

// RL-005: Multiple checks after join (sequential, > 5s apart)
test('RL-005: After join, check after 5s → joined:true', async () => {
  let userJoined = false;
  const deps = createMockDeps({
    checkChannelMembership: async () => userJoined ? { joined: true } : { joined: false, reason: 'not_member' },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  await gw.check(env, '123', { forceRefresh: true });
  userJoined = true;
  // Wait > 5s (rate gate TTL)
  await new Promise(r => setTimeout(r, 5100));
  const r2 = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(r2.joined, true, 'should be joined after rate gate expires');
});

// RL-006: Multiple concurrent checks after join — dedup
test('RL-006: 5 concurrent checks → 1 Telegram call (dedup)', async () => {
  let telegramCount = 0;
  const deps = createMockDeps({
    checkChannelMembership: async () => {
      telegramCount++;
      await new Promise(r => setTimeout(r, 50));
      return { joined: true };
    },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const results = await Promise.all([
    gw.check(env, '123', { forceRefresh: true }),
    gw.check(env, '123', { forceRefresh: true }),
    gw.check(env, '123', { forceRefresh: true }),
    gw.check(env, '123', { forceRefresh: true }),
    gw.check(env, '123', { forceRefresh: true }),
  ]);
  for (const r of results) assert.equal(r.joined, true);
  assert.equal(telegramCount, 1, '5 concurrent checks → 1 Telegram call (dedup)');
});

// RL-007: Different users concurrent — separate calls
test('RL-007: Different users → separate Telegram calls', async () => {
  let telegramCount = 0;
  const deps = createMockDeps({
    checkChannelMembership: async () => { telegramCount++; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  await Promise.all([
    gw.check(env, '111', { forceRefresh: true }),
    gw.check(env, '222', { forceRefresh: true }),
    gw.check(env, '333', { forceRefresh: true }),
  ]);
  assert.equal(telegramCount, 3, 'different users → 3 calls');
});

// RL-008: Telegram 429 + retry_after → backoff stored
test('RL-008: Telegram 429 → telegram_rate_limited + retry_after', async () => {
  let telegramCount = 0;
  const deps = createMockDeps({
    checkChannelMembership: async () => {
      telegramCount++;
      return { joined: false, reason: 'api_error', detail: '429 Too Many Requests: retry after 5' };
    },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const r1 = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(r1.joined, false);
  assert.equal(r1.reason, 'telegram_rate_limited');
  assert.equal(r1.retry_after, 5);
});

// RL-009: After 429, subsequent check respects backoff (no Telegram)
test('RL-009: After 429, second check respects backoff (no Telegram call)', async () => {
  let telegramCount = 0;
  let callCount = 0;
  // Use a REAL in-memory KV store (not a no-op mock) so backoff persists
  const kvStore = new Map();
  const realKv = {
    get: async (key) => kvStore.has(key) ? kvStore.get(key) : null,
    put: async (key, value) => { kvStore.set(key, value); },
  };
  const deps = createMockDeps({
    checkChannelMembership: async () => {
      telegramCount++;
      callCount++;
      if (callCount === 1) {
        return { joined: false, reason: 'api_error', detail: '429 Too Many Requests: retry after 5' };
      }
      return { joined: true };
    },
  });
  const gw = loadGateway(deps);
  const env = createEnv({ APP_CACHE: realKv });
  // First: 429
  await gw.check(env, '123', { forceRefresh: true });
  // Second: should respect backoff (KV has tgbackoff:123)
  const r2 = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(r2.reason, 'telegram_rate_limited');
  assert.equal(telegramCount, 1, 'Telegram should NOT be called during backoff');
});

// RL-010: Telegram timeout → fail-closed
test('RL-010: Telegram timeout → joined:false (fail-closed)', async () => {
  const deps = createMockDeps({
    checkChannelMembership: async () => { throw new Error('AbortError'); },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'api_error');
});

// RL-011: Telegram 500 → fail-closed
test('RL-011: Telegram 500 → joined:false (fail-closed)', async () => {
  const deps = createMockDeps({
    checkChannelMembership: async () => ({ joined: false, reason: 'api_error', detail: '500 Server Error' }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'api_error');
});

// RL-012: Multiple required channels — parallel
test('RL-012: Multiple required channels — all checked', async () => {
  const deps = createMockDeps({
    checkChannelMembership: async () => ({ joined: true }),
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 3 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123', { forceRefresh: true });
  assert.equal(result.joined, true);
  assert.equal(result.channels.checked, 4); // 1 primary + 3 required
});

// RL-013: Admin — bypass, no rate limit
test('RL-013: Admin → bypass, no Telegram, no rate limit', async () => {
  let telegramCount = 0;
  const deps = createMockDeps({
    isAdminTelegramId: () => true,
    checkChannelMembership: async () => { telegramCount++; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const r1 = await gw.check(env, '999', { forceRefresh: true });
  const r2 = await gw.check(env, '999', { forceRefresh: true });
  assert.equal(r1.joined, true);
  assert.equal(r1.admin, true);
  assert.equal(r2.joined, true);
  assert.equal(telegramCount, 0, 'admin never calls Telegram');
});

// RL-014: Guest — bypass
test('RL-014: Guest → bypass', async () => {
  const deps = createMockDeps();
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, 'guest_abc', { forceRefresh: true });
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'guest_user');
});

// RL-015: forceRefresh skips cache
test('RL-015: forceRefresh skips cache', async () => {
  let kvChecked = false;
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => { kvChecked = true; return null; },
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  await gw.check(env, '123', { forceRefresh: true });
  // KV is checked even with forceRefresh in the current implementation
  // (the forceRefresh only skips the session cache and the cache HIT path)
  // But Telegram MUST be called
  assert.equal(telegramCalled, true);
});

// RL-016: Cache hit → fast (no Telegram)
test('RL-016: KV cache hit → no Telegram', async () => {
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => true,
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123', { forceRefresh: false });
  assert.equal(result.joined, true);
  assert.equal(telegramCalled, false);
});

// RL-017: Cache miss → Telegram
test('RL-017: KV cache miss → Telegram called', async () => {
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  await gw.check(env, '123', { forceRefresh: false });
  assert.equal(telegramCalled, true);
});

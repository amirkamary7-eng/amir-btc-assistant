/**
 * MembershipGateway unit tests (GW-001 to GW-016).
 *
 * These tests verify the Gateway's core logic with mocked dependencies.
 * No real Telegram API, no real KV, no real DB.
 *
 * Run: node --test membership-gateway-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const GATEWAY_SRC = fs.readFileSync(path.join(__dirname, 'src/services/membershipGateway.js'), 'utf8');

// ============================================================================
// Load Gateway via source-eval (same pattern as other test files)
// ============================================================================

function loadGateway(mockDeps) {
  const exportsObj = {};
  // Strip the export keyword and evaluate
  const src = GATEWAY_SRC.replace(/^export\s+function\s+/m, 'function ');
  const evaluator = new Function('exports', 'setTimeout', 'console', src + '\nexports.createMembershipGateway = createMembershipGateway;');
  evaluator(exportsObj, setTimeout, console);
  const gateway = exportsObj.createMembershipGateway(mockDeps);
  return gateway;
}

// ============================================================================
// Mock factories
// ============================================================================

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

// ============================================================================
// GW-001: Admin bypass → joined:true, admin:true, no Telegram
// ============================================================================

test('GW-001: Admin bypass returns joined:true with admin flag, no Telegram call', async () => {
  let telegramCalled = false;
  const deps = createMockDeps({
    isAdminTelegramId: () => true,
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '999999', {});
  assert.equal(result.joined, true);
  assert.equal(result.admin, true);
  assert.equal(result.reason, 'admin_bypass');
  assert.equal(telegramCalled, false, 'Telegram must NOT be called for admin bypass');
  assert.ok(result.elapsed_ms >= 0);
});

// ============================================================================
// GW-002: Guest user → joined:false, reason:guest_user
// ============================================================================

test('GW-002: Guest user returns joined:false with guest_user reason', async () => {
  const deps = createMockDeps();
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, 'guest_abc123', {});
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'guest_user');
});

// ============================================================================
// GW-003: Member (all channels joined) → joined:true
// ============================================================================

test('GW-003: Member (primary + required joined) returns joined:true', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null, // cache miss → fresh check
    getDbUserJoinState: async () => null,  // DB miss
    checkChannelMembership: async () => ({ joined: true }),
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 2 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, true);
  assert.equal(result.reason, 'member');
  assert.equal(result.admin, false);
  assert.equal(result.cached, false);
});

// ============================================================================
// GW-004: Non-member (primary not joined) → joined:false
// ============================================================================

test('GW-004: Non-member (primary not joined) returns joined:false', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: false, reason: 'not_member' }),
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'not_member');
});

// ============================================================================
// GW-005: Non-member (required channel not joined) → joined:false
// ============================================================================

test('GW-005: Non-member (required channel not joined) returns joined:false', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: true }),
    checkAdditionalRequiredChannels: async () => ({ joined: false, channels: 1, channel: 'extra_chan' }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'additional_channel_required');
  assert.ok(result.channels.failed.includes('extra_chan'));
});

// ============================================================================
// GW-006: Telegram timeout → joined:false (fail-closed)
// ============================================================================

test('GW-006: Telegram timeout returns joined:false (fail-closed)', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => { throw new Error('AbortError'); }, // simulates timeout
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  // allSettled catches the rejection, primaryResult becomes api_error
  assert.equal(result.reason, 'api_error');
});

// ============================================================================
// GW-007: Telegram 429 → joined:false (fail-closed)
// ============================================================================

test('GW-007: Telegram 429 returns joined:false (fail-closed)', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: false, reason: 'api_error', detail: '429 Too Many Requests' }),
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'api_error');
});

// ============================================================================
// GW-008: Telegram 500 → joined:false (fail-closed)
// ============================================================================

test('GW-008: Telegram 500 returns joined:false (fail-closed)', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: true }),
    checkAdditionalRequiredChannels: async () => ({ joined: false, reason: 'api_error', detail: '500 Server Error' }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'api_error');
});

// ============================================================================
// GW-009: Partial channel failure (1 of 3 errors) → joined:false
// ============================================================================

test('GW-009: Partial channel failure returns joined:false', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: true }), // primary OK
    checkAdditionalRequiredChannels: async () => ({ joined: false, reason: 'api_error', channels: 2 }), // extra failed
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  // Primary joined but extra failed → additional_channel_required or api_error
  assert.ok(['additional_channel_required', 'api_error'].includes(result.reason));
});

// ============================================================================
// GW-010: KV cache hit → fast path, no Telegram
// ============================================================================

test('GW-010: KV cache hit (joined:true) returns fast without Telegram', async () => {
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => true, // KV says joined
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, true);
  assert.equal(result.cached, true);
  assert.equal(telegramCalled, false, 'Telegram must NOT be called on KV cache hit');
});

// ============================================================================
// GW-011: KV cache miss → fresh Telegram
// ============================================================================

test('GW-011: KV cache miss triggers fresh Telegram check', async () => {
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null, // cache miss
    getDbUserJoinState: async () => null,  // DB miss
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 1 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, true);
  assert.equal(telegramCalled, true, 'Telegram MUST be called on cache miss');
});

// ============================================================================
// GW-012: forceRefresh:true → skips KV cache
// ============================================================================

test('GW-012: forceRefresh:true skips KV cache and does fresh Telegram', async () => {
  let kvChecked = false;
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => { kvChecked = true; return true; },
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', { forceRefresh: true });
  assert.equal(result.joined, true);
  assert.equal(kvChecked, false, 'KV cache must NOT be checked when forceRefresh:true');
  assert.equal(telegramCalled, true, 'Telegram MUST be called when forceRefresh:true');
});

// ============================================================================
// GW-013: Duplicate in-flight request → reuses same promise
// ============================================================================

test('GW-013: Duplicate in-flight request reuses same promise (no double Telegram)', async () => {
  let telegramCallCount = 0;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => {
      telegramCallCount++;
      await new Promise(r => setTimeout(r, 50)); // slow to keep in-flight
      return { joined: true };
    },
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  // Fire 3 concurrent checks for same user
  const [r1, r2, r3] = await Promise.all([
    gw.check(env, '123456', {}),
    gw.check(env, '123456', {}),
    gw.check(env, '123456', {}),
  ]);
  assert.equal(r1.joined, true);
  assert.equal(r2.joined, true);
  assert.equal(r3.joined, true);
  assert.equal(telegramCallCount, 1, 'Telegram must be called only ONCE for concurrent same-user requests');
});

// ============================================================================
// GW-014: Concurrent callers (5x) → single Telegram call
// ============================================================================

test('GW-014: 5 concurrent callers → single Telegram call', async () => {
  let telegramCallCount = 0;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => {
      telegramCallCount++;
      await new Promise(r => setTimeout(r, 50));
      return { joined: true };
    },
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const results = await Promise.all([
    gw.check(env, '123456', {}),
    gw.check(env, '123456', {}),
    gw.check(env, '123456', {}),
    gw.check(env, '123456', {}),
    gw.check(env, '123456', {}),
  ]);
  for (const r of results) {
    assert.equal(r.joined, true);
  }
  assert.equal(telegramCallCount, 1, 'Telegram must be called only ONCE for 5 concurrent requests');
});

// ============================================================================
// GW-015: restricted + is_member=false → joined:false
// ============================================================================

test('GW-015: restricted + is_member=false → joined:false (handled by checkChannelMembership)', async () => {
  // Note: isJoinedMember is INSIDE checkChannelMembership (worker-proxy.js).
  // The Gateway delegates to checkChannelMembership which uses isJoinedMember.
  // This test verifies the Gateway correctly propagates the not-joined result.
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: false, reason: 'not_member' }), // simulates restricted+is_member:false
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
});

// ============================================================================
// GW-016: restricted + is_member=true → joined:true
// ============================================================================

test('GW-016: restricted + is_member=true → joined:true', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => ({ joined: true }), // simulates restricted+is_member:true
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, true);
});

// ============================================================================
// Additional tests: session cache, overall timeout, KV cache false
// ============================================================================

test('GW-017: Session cache (in-memory 30s) hit → fast path, no KV, no Telegram', async () => {
  let kvChecked = false;
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => { kvChecked = true; return null; },
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  // First call: cache miss → fresh Telegram → populates session cache
  const r1 = await gw.check(env, '123456', {});
  assert.equal(r1.joined, true);
  assert.equal(telegramCalled, true, 'first call must hit Telegram');
  // Second call: session cache hit → no KV, no Telegram
  telegramCalled = false;
  kvChecked = false;
  const r2 = await gw.check(env, '123456', {});
  assert.equal(r2.joined, true);
  assert.equal(r2.cached, true);
  assert.equal(telegramCalled, false, 'second call must NOT hit Telegram (session cache)');
  assert.equal(kvChecked, false, 'second call must NOT hit KV (session cache)');
});

test('GW-018: Overall gateway timeout fires if Telegram hangs forever', async () => {
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => new Promise(() => {}), // never resolves
    checkAdditionalRequiredChannels: async () => new Promise(() => {}), // never resolves
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const t0 = Date.now();
  const result = await gw.check(env, '123456', { timeout: 200 }); // 200ms timeout for test
  const elapsed = Date.now() - t0;
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'timeout');
  assert.ok(elapsed < 500, `must complete within ~200ms, took ${elapsed}ms`);
});

test('GW-019: KV cache hit (joined:false) → fast path returns not-joined', async () => {
  let telegramCalled = false;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => false, // KV says NOT joined
    checkChannelMembership: async () => { telegramCalled = true; return { joined: true }; },
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  const result = await gw.check(env, '123456', {});
  assert.equal(result.joined, false);
  assert.equal(result.cached, true);
  assert.equal(telegramCalled, false);
});

test('GW-020: Different users → no dedup leakage (separate Telegram calls)', async () => {
  let telegramCallCount = 0;
  const deps = createMockDeps({
    getCachedJoinStatus: async () => null,
    getDbUserJoinState: async () => null,
    checkChannelMembership: async () => { telegramCallCount++; return { joined: true }; },
    checkAdditionalRequiredChannels: async () => ({ joined: true, channels: 0 }),
  });
  const gw = loadGateway(deps);
  const env = createEnv();
  await Promise.all([
    gw.check(env, '111', {}),
    gw.check(env, '222', {}),
    gw.check(env, '333', {}),
  ]);
  assert.equal(telegramCallCount, 3, 'Different users must get separate Telegram calls (no leakage)');
});

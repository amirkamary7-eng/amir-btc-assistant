/**
 * KV Write Optimization Tests — KVO series
 *
 * Verifies that the KV write optimization changes:
 *   1. Route direct KV puts through writeAppCache/_kvWriteDedup for dedup
 *   2. Remove dead code (writeHeartbeat)
 *   3. Use fixed health-check key
 *   4. Add _kvWriteDedup helper for JOIN_CACHE and RATE_LIMITS
 *
 * All assertions use source-inspection (structural) + behavioral verification.
 * No business logic should change — only write dedup.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const SESSIONS_SRC = fs.readFileSync(path.join(ROOT, 'src/repositories/sessions.js'), 'utf8');
const ADMIN_SRC = fs.readFileSync(path.join(ROOT, 'src/repositories/admin.js'), 'utf8');
const ASSISTANT_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/assistant.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// KVO-1: Fear & Greed — fetchFearGreed routes through writeAppCache
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-1: fetchFearGreed uses writeAppCache (not direct env_APP_CACHE.put)', () => {
  const block = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function fetchFearGreed'),
    WORKER_SRC.indexOf('function _classifyFG')
  );
  assert.ok(block.includes('writeAppCache'),
    'fetchFearGreed must call writeAppCache for _kvWriteCache dedup');
  assert.ok(!block.includes('env_APP_CACHE.put('),
    'fetchFearGreed must NOT use direct env_APP_CACHE.put');
  // Key, value serialization, TTL preserved
  assert.ok(block.includes('FG_CACHE_KEY'),
    'key preserved');
  assert.ok(block.includes('JSON.stringify(result)'),
    'value serialization preserved');
  assert.ok(block.includes('FG_CACHE_TTL'),
    'TTL preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-2: Web Search Cache — performWebSearch routes through writeAppCache
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-2: performWebSearch uses writeAppCache (not direct env.APP_CACHE.put)', () => {
  const block = ASSISTANT_SRC.slice(
    ASSISTANT_SRC.indexOf('async function performWebSearch'),
    ASSISTANT_SRC.indexOf('async function performWikipediaSearch')
  );
  assert.ok(block.includes('writeAppCache'),
    'performWebSearch must call writeAppCache for _kvWriteCache dedup');
  assert.ok(!block.includes('env.APP_CACHE.put('),
    'performWebSearch must NOT use direct env.APP_CACHE.put');
  // Key, value, TTL preserved
  assert.ok(block.includes('cacheKey'),
    'key preserved');
  assert.ok(block.includes('WEB_SEARCH_CACHE_TTL'),
    'TTL preserved');
});

test('KVO-2b: assistant controller deps include writeAppCache', () => {
  assert.ok(ASSISTANT_SRC.includes('writeAppCache,'),
    'writeAppCache must be in assistant controller deps');
});

test('KVO-2c: worker-proxy wires writeAppCache into assistant handlers', () => {
  const block = WORKER_SRC.slice(
    WORKER_SRC.indexOf('const assistantHandlers = createAssistantHandlers'),
    WORKER_SRC.indexOf('  // Chat AI v2:')
  );
  assert.ok(block.includes('writeAppCache'),
    'worker-proxy must wire writeAppCache into assistant handlers');
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-3: Dead code — writeHeartbeat removed from sessions.js
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-3: writeHeartbeat function removed from sessions.js', () => {
  assert.ok(!SESSIONS_SRC.includes('async function writeHeartbeat'),
    'writeHeartbeat function must be removed');
  assert.ok(!SESSIONS_SRC.includes('writeHeartbeat,'),
    'writeHeartbeat export must be removed');
  // The remaining functions are still present
  assert.ok(SESSIONS_SRC.includes('async function persistPresenceState'),
    'persistPresenceState still present');
  assert.ok(SESSIONS_SRC.includes('async function deleteSession'),
    'deleteSession still present');
  assert.ok(SESSIONS_SRC.includes('async function readSessionId'),
    'readSessionId still present');
});

test('KVO-3b: no callers of writeHeartbeat anywhere in codebase', () => {
  // Verify no other file references writeHeartbeat
  const allFiles = [
    'worker-proxy.js',
    'src/controllers/sessions.js',
    'src/controllers/wallet.js',
    'src/services/membershipGateway.js',
  ];
  for (const f of allFiles) {
    const src = fs.readFileSync(path.join(ROOT, f), 'utf8');
    // Allow the comment in sessions.js that explains removal
    const withoutComments = src.replace(/\/\/[^\n]*/g, '');
    assert.ok(!withoutComments.includes('writeHeartbeat'),
      `${f} must not reference writeHeartbeat`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-4: Health probe — fixed key
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-4: health-check uses fixed key (not Date.now())', () => {
  assert.ok(ADMIN_SRC.includes("'health-check:probe'"),
    'health-check must use fixed key "health-check:probe"');
  assert.ok(!ADMIN_SRC.includes("'health-check:' + Date.now()"),
    'must NOT use health-check:{Date.now()}');
  // TTL still 60s
  assert.ok(ADMIN_SRC.includes("expirationTtl: 60"),
    'TTL 60s preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-5: Ad image TTL — SKIPPED (would break active images)
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-5: ad image storeImage unchanged (TTL skipped to avoid broken images)', () => {
  const AD_SRC = fs.readFileSync(path.join(ROOT, 'src/repositories/advertisements.js'), 'utf8');
  // storeImage should still be direct put (no TTL change)
  const block = AD_SRC.slice(
    AD_SRC.indexOf('async function storeImage'),
    AD_SRC.indexOf('async function getImage')
  );
  assert.ok(block.includes('env.RATE_LIMITS.put(key,'),
    'storeImage still uses direct KV put (TTL not added — would break images)');
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-6: _kvWriteDedup helper exists + used by setCachedJoinStatus + checkAdditionalRequiredChannels
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-6a: _kvWriteDedup helper exists in worker-proxy.js', () => {
  assert.ok(WORKER_SRC.includes('async function _kvWriteDedup('),
    '_kvWriteDedup helper must exist');
  assert.ok(WORKER_SRC.includes('_kvWriteCache.get(key)'),
    '_kvWriteDedup must reuse existing _kvWriteCache');
});

test('KVO-6b: setCachedJoinStatus uses _kvWriteDedup', () => {
  const block = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function setCachedJoinStatus'),
    WORKER_SRC.indexOf('function getTodayIsoDate')
  );
  assert.ok(block.includes('_kvWriteDedup'),
    'setCachedJoinStatus must call _kvWriteDedup');
  assert.ok(!block.includes('env.JOIN_CACHE.put('),
    'setCachedJoinStatus must NOT use direct env.JOIN_CACHE.put');
  // TTL logic preserved
  assert.ok(block.includes('JOIN_CACHE_TTL'),
    'TTL logic preserved');
  assert.ok(block.includes("60"),
    '60s TTL for not-joined preserved');
});

test('KVO-6c: checkAdditionalRequiredChannels uses _kvWriteDedup for both paths', () => {
  const block = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels'),
    WORKER_SRC.indexOf('async function resolveChannelMembership')
  );
  // Both the negative and positive paths must use _kvWriteDedup
  // Count occurrences: should be 2 (one for '0', one for '1')
  const dedupCount = (block.match(/_kvWriteDedup/g) || []).length;
  assert.ok(dedupCount >= 2,
    `checkAdditionalRequiredChannels must call _kvWriteDedup at least 2 times (neg+pos), found ${dedupCount}`);
  // No direct env.RATE_LIMITS.put remaining (the old pattern)
  assert.ok(!block.includes('env.RATE_LIMITS.put('),
    'checkAdditionalRequiredChannels must NOT use direct env.RATE_LIMITS.put');

  // Read-before-write cache check preserved
  assert.ok(block.includes('env.RATE_LIMITS.get(cacheKey)'),
    'read-before-write cache check preserved');
  // Jittered TTL preserved
  assert.ok(block.includes('_ttlJitter'),
    'jittered TTL preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-6d: Behavioral test — _kvWriteDedup actually deduplicates
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-6d: _kvWriteDedup skips redundant writes with identical value (behavioral)', async () => {
  // Extract _kvWriteDedup + its dependencies (_kvWriteCache, _KV_WRITE_CACHE_MAX)
  // from worker-proxy.js and drive them with a mock KV namespace.
  const fnSrc = `
    const _kvWriteCache = new Map();
    const _KV_WRITE_CACHE_MAX = 200;
    ${WORKER_SRC.slice(
      WORKER_SRC.indexOf('async function _kvWriteDedup('),
      WORKER_SRC.indexOf('// ═══════════════════════════════════════════════════════════════════════════',
        WORKER_SRC.indexOf('async function _kvWriteDedup('))
    )}
    module.exports = { _kvWriteDedup, _kvWriteCache };
  `;
  const mod = { exports: {} };
  new Function('module', 'exports', fnSrc)(mod, mod.exports);
  const { _kvWriteDedup } = mod.exports;

  // Mock KV namespace
  let writeCount = 0;
  const mockKV = {
    put: async (key, value, opts) => {
      writeCount++;
      return Promise.resolve();
    },
  };

  // First write — should write
  await _kvWriteDedup(mockKV, 'join:user123', '1', 300);
  assert.equal(writeCount, 1, 'first call writes');

  // Second write with SAME value within TTL — should SKIP
  await _kvWriteDedup(mockKV, 'join:user123', '1', 300);
  assert.equal(writeCount, 1, 'second call with same value SKIPS (dedup)');

  // Write with DIFFERENT value — should write
  await _kvWriteDedup(mockKV, 'join:user123', '0', 60);
  assert.equal(writeCount, 2, 'call with different value writes');

  // Write to DIFFERENT key — should write
  await _kvWriteDedup(mockKV, 'adch:user456:hash', '1', 75);
  assert.equal(writeCount, 3, 'call with different key writes');

  // Same different key, same value — should SKIP
  await _kvWriteDedup(mockKV, 'adch:user456:hash', '1', 75);
  assert.equal(writeCount, 3, 'second call with same key+value SKIPS');
});

test('KVO-6e: _kvWriteDedup handles null/missing namespace gracefully', async () => {
  const fnSrc = `
    const _kvWriteCache = new Map();
    const _KV_WRITE_CACHE_MAX = 200;
    ${WORKER_SRC.slice(
      WORKER_SRC.indexOf('async function _kvWriteDedup('),
      WORKER_SRC.indexOf('// ═══════════════════════════════════════════════════════════════════════════',
        WORKER_SRC.indexOf('async function _kvWriteDedup('))
    )}
    module.exports = { _kvWriteDedup };
  `;
  const mod = { exports: {} };
  new Function('module', 'exports', fnSrc)(mod, mod.exports);
  const { _kvWriteDedup } = mod.exports;

  // null namespace — should not throw
  await _kvWriteDedup(null, 'key', 'value', 60);
  // undefined namespace — should not throw
  await _kvWriteDedup(undefined, 'key', 'value', 60);
  // namespace without put function — should not throw
  await _kvWriteDedup({}, 'key', 'value', 60);
  // All pass = no throw = graceful handling
  assert.ok(true, 'null/missing namespace handled gracefully');
});

test('KVO-6f: _kvWriteDedup re-writes after TTL expires (value-match but expired)', async () => {
  const fnSrc = `
    const _kvWriteCache = new Map();
    const _KV_WRITE_CACHE_MAX = 200;
    ${WORKER_SRC.slice(
      WORKER_SRC.indexOf('async function _kvWriteDedup('),
      WORKER_SRC.indexOf('// ═══════════════════════════════════════════════════════════════════════════',
        WORKER_SRC.indexOf('async function _kvWriteDedup('))
    )}
    module.exports = { _kvWriteDedup, _kvWriteCache };
  `;
  const mod = { exports: {} };
  new Function('module', 'exports', fnSrc)(mod, mod.exports);
  const { _kvWriteDedup, _kvWriteCache } = mod.exports;

  let writeCount = 0;
  const mockKV = {
    put: async () => { writeCount++; return Promise.resolve(); },
  };

  // Write with TTL=60 (minimum clamped)
  await _kvWriteDedup(mockKV, 'test:key', 'val', 60);
  assert.equal(writeCount, 1, 'first write');

  // Manually expire the cache entry (simulate TTL expiry)
  const entry = _kvWriteCache.get('test:key');
  entry.expiresAt = Date.now() - 1000; // expired 1s ago
  _kvWriteCache.set('test:key', entry);

  // Same value but expired — should RE-WRITE
  await _kvWriteDedup(mockKV, 'test:key', 'val', 60);
  assert.equal(writeCount, 2, 're-write after TTL expiry even with same value');
});

// ═══════════════════════════════════════════════════════════════════════════
// KVO-7: Regression — no business logic / credit path / economic changes
// ═══════════════════════════════════════════════════════════════════════════

test('KVO-7: no economic/credit-path code changed', () => {
  // entitlement_config.js must be unchanged
  const EC_SRC = fs.readFileSync(path.join(ROOT, 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(EC_SRC.includes('getMissionRewardAmount'), 'entitlement helpers intact');
  assert.ok(EC_SRC.includes('getReferralRewardAmount'), 'entitlement helpers intact');

  // repositories/ must be unchanged (except sessions.js dead-code removal)
  const WALLET_REPO = fs.readFileSync(path.join(ROOT, 'src/repositories/wallet.js'), 'utf8');
  assert.ok(WALLET_REPO.includes('claimDailyRewardWithStreak'),
    'wallet repository crediting logic intact');
  assert.ok(WALLET_REPO.includes('STREAK_REWARDS'),
    'streak rewards logic intact');

  // Mission token issuance still uses Phase 2D (no KV)
  assert.ok(WORKER_SRC.includes('PHASE 2D'),
    'Phase 2D signed tokens intact');
  assert.ok(WORKER_SRC.includes('_signMissionToken'),
    'mission token signing intact');
});

test('KVO-7b: PresenceDO + heartbeat path unchanged (only dead code removed)', () => {
  // PresenceDO storage puts still present (not KV)
  assert.ok(WORKER_SRC.includes("this.state.storage.put('sessions_snapshot'"),
    'PresenceDO snapshot storage intact');
  assert.ok(WORKER_SRC.includes('this.state.storage.put(`key${keyIndex}`'),
    'GroqRouterDO storage intact');

  // Heartbeat handler in the SESSIONS CONTROLLER still uses DO primary path
  const SESSIONS_CTRL = fs.readFileSync(path.join(ROOT, 'src/controllers/sessions.js'), 'utf8');
  const block = SESSIONS_CTRL.slice(
    SESSIONS_CTRL.indexOf('async function handleHeartbeat'),
    SESSIONS_CTRL.indexOf('async function handleOnline')
  );
  assert.ok(block.includes('env.PRESENCE_DO'),
    'heartbeat still uses PRESENCE_DO as primary');
  assert.ok(block.includes('KV FALLBACK'),
    'heartbeat KV fallback preserved');
  assert.ok(block.includes('persistPresenceState'),
    'heartbeat fallback still uses persistPresenceState (1 write, not 3)');
});

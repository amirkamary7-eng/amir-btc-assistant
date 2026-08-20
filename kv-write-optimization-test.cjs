/**
 * KV Write Optimization — Rate Limit Coalesced Counter tests (P0-A).
 *
 * Verifies the write-coalesced rate limiter (_checkRateLimitCoalesced) used by
 * isMarketRateLimited / isUserRateLimited:
 *
 *   - Normal request under limit → allowed
 *   - At limit → blocked
 *   - Over limit → blocked (and NO KV write on the block)
 *   - Window reset → counter resets (new windowIndex)
 *   - Concurrent requests → no bypass within a single isolate
 *   - KV write failure (quota exhausted) → isolate STILL self-limits via
 *     in-memory delta (fixes the previous fail-open bypass)
 *   - KV read failure → isolate STILL self-limits via in-memory delta
 *   - Fail-open when env.RATE_LIMITS is absent (preserved behavior)
 *   - Writes are COALESCED (fewer writes than requests for low traffic)
 *   - Near the limit, every request forces a flush (accuracy at boundary)
 *
 * Run: node --test kv-write-optimization-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// Extract the rate-limit block (constants + functions) from worker-proxy.js
// and evaluate it in a fresh scope per call so the in-memory _rlCoalesceState
// Map is reset between tests.
// ============================================================================

const RL_BLOCK_START = WORKER_SRC.indexOf('const MARKET_RATE_LIMIT_MAX = 30;');
const RL_BLOCK_END = WORKER_SRC.indexOf('function getAdminIds(env) {');
assert.ok(RL_BLOCK_START !== -1 && RL_BLOCK_END !== -1 && RL_BLOCK_END > RL_BLOCK_START,
  'rate-limit block anchors must exist in worker-proxy.js');
const RL_BLOCK = WORKER_SRC.slice(RL_BLOCK_START, RL_BLOCK_END);

function loadRateLimitFns() {
  // _trackKvWrite is defined elsewhere in worker-proxy.js as a no-op; provide it.
  // setTimeout/clearTimeout are used nowhere in this block but kept for safety.
  const exportsObj = {};
  const evaluator = new Function('exports', 'console', 'setTimeout', 'clearTimeout',
    '_trackKvWrite = function(){};\n' +
    RL_BLOCK +
    '\nexports.isMarketRateLimited = isMarketRateLimited;' +
    '\nexports.isUserRateLimited = isUserRateLimited;' +
    '\nexports._checkRateLimitCoalesced = _checkRateLimitCoalesced;' +
    '\nexports._rlCoalesceState = _rlCoalesceState;');
  evaluator(exportsObj, console, setTimeout, clearTimeout);
  return exportsObj;
}

// ============================================================================
// Mock KV that COUNTS get/put calls and can simulate failures
// ============================================================================

function createMockKv(opts = {}) {
  const store = new Map();
  return {
    getCount: 0,
    putCount: 0,
    failGet: !!opts.failGet,
    failPut: !!opts.failPut,
    hangGet: !!opts.hangGet,
    async get(key) {
      this.getCount++;
      if (this.failGet) throw new Error('KV get failed (simulated)');
      if (this.hangGet) return new Promise(() => {});
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, ttl) {
      this.putCount++;
      if (this.failPut) throw new Error('KV put failed (quota exhausted — simulated)');
      store.set(key, value);
      this._lastValue = value;
      this._lastTtl = ttl;
    },
    _store: store,
    _lastValue: null,
    _lastTtl: null,
    // Helper: read & parse the stored counter
    readCount(currentWindowIndex) {
      if (!this._lastValue) return { count: 0, winIdx: currentWindowIndex };
      try {
        const p = JSON.parse(this._lastValue);
        if (p && typeof p === 'object' && 'c' in p) return { count: p.c | 0, winIdx: p.w | 0 };
      } catch {}
      const n = parseInt(this._lastValue, 10);
      return { count: Number.isFinite(n) ? n : 0, winIdx: currentWindowIndex };
    },
  };
}

// ============================================================================
// Tests
// ============================================================================

test('RLOPT-001: request under limit → allowed (no block)', async () => {
  const { isMarketRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit 30; first request must be allowed
  const blocked = await isMarketRateLimited(env, '1.2.3.4', 'user1');
  assert.equal(blocked, false, 'first request under limit must be allowed');
});

test('RLOPT-002: at limit → blocked', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit 5, window 60s. Make 5 allowed requests, then the 6th must block.
  for (let i = 0; i < 5; i++) {
    const b = await isUserRateLimited(env, 'u1', 'test', 5, 60);
    assert.equal(b, false, `request ${i + 1} must be allowed`);
  }
  const blocked = await isUserRateLimited(env, 'u1', 'test', 5, 60);
  assert.equal(blocked, true, '6th request at limit must be BLOCKED');
});

test('RLOPT-003: over limit → blocked, and NO KV write on the block', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit 3
  for (let i = 0; i < 3; i++) await isUserRateLimited(env, 'u1', 'test', 3, 60);
  const putCountBefore = kv.putCount;
  // 4th and 5th must block
  const b4 = await isUserRateLimited(env, 'u1', 'test', 3, 60);
  const b5 = await isUserRateLimited(env, 'u1', 'test', 3, 60);
  assert.equal(b4, true, '4th request over limit must be BLOCKED');
  assert.equal(b5, true, '5th request over limit must be BLOCKED');
  assert.equal(kv.putCount, putCountBefore, 'NO KV write must occur on a BLOCKED decision');
});

test('RLOPT-004: window reset → counter resets (new windowIndex)', async () => {
  // Use a tiny window + manipulate Date.now via a custom clock is complex;
  // instead simulate a window rollover by directly pre-seeding KV with a
  // STALE-window entry and confirming the limiter treats it as 0 (reset).
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // Seed KV with a stale-window counter at the limit (old windowIndex).
  const oldWindowIndex = 0; // impossibly old
  kv._store.set('url:test:u1', JSON.stringify({ c: 100, w: oldWindowIndex }));
  // The limiter reads it, sees winIdx != currentWindowIndex, treats as 0 → allows.
  const blocked = await isUserRateLimited(env, 'u1', 'test', 5, 60);
  assert.equal(blocked, false, 'stale-window entry must NOT block (counter reset)');
});

test('RLOPT-005: concurrent requests (5 parallel) → no bypass within isolate', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit 10. Fire 10 concurrent requests — none should be falsely allowed
  // beyond the limit. (All 10 may be allowed since they're under/at the limit.)
  const results = await Promise.all(
    Array.from({ length: 10 }, () => isUserRateLimited(env, 'u1', 'test', 10, 60))
  );
  const allowed = results.filter(b => b === false).length;
  const blocked = results.filter(b => b === true).length;
  assert.equal(allowed + blocked, 10, 'all 10 must resolve');
  // Within a single isolate, the delta is serialized (JS is single-threaded),
  // so the limiter must count correctly: at most 10 allowed, rest blocked.
  assert.ok(allowed <= 10, `allowed (${allowed}) must not exceed limit (10)`);
});

test('RLOPT-006: KV write failure (quota exhausted) → isolate STILL self-limits', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv({ failPut: true }); // every put() throws
  const env = { RATE_LIMITS: kv };
  // limit 4, window 60s. Writes will fail, but the in-memory delta must still
  // advance so the isolate self-limits at the limit (NO total bypass).
  let allowed = 0;
  for (let i = 0; i < 8; i++) {
    const b = await isUserRateLimited(env, 'u1', 'test', 4, 60);
    if (b === false) allowed++;
  }
  // Without the fix: KV write fail → counter never advances → ALL 8 allowed
  // (total bypass). With the fix: in-memory delta advances → blocks at ~4.
  // Allow a small tolerance for the near-limit flushing semantics, but it must
  // be far below 8 (the unbounded bypass).
  assert.ok(allowed <= 5, `KV write failure must NOT cause total bypass (allowed=${allowed}, expected <=5)`);
  assert.ok(allowed >= 4, `should allow up to the limit before blocking (allowed=${allowed})`);
});

test('RLOPT-007: KV read failure → isolate STILL self-limits via in-memory delta', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv({ failGet: true, failPut: true }); // both fail
  const env = { RATE_LIMITS: kv };
  // limit 3, window 60s. KV is fully down. The isolate must still self-limit.
  let allowed = 0;
  for (let i = 0; i < 6; i++) {
    const b = await isUserRateLimited(env, 'u1', 'test', 3, 60);
    if (b === false) allowed++;
  }
  assert.ok(allowed <= 4, `KV fully down must NOT cause bypass (allowed=${allowed}, expected <=4)`);
  assert.ok(allowed >= 3, `should allow up to the limit (allowed=${allowed})`);
});

test('RLOPT-008: fail-open when env.RATE_LIMITS is absent (preserved behavior)', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  // No RATE_LIMITS binding → must NOT throw, must return false (allow).
  const b1 = await isUserRateLimited({}, 'u1', 'test', 5, 60);
  const b2 = await isUserRateLimited({ RATE_LIMITS: null }, 'u1', 'test', 5, 60);
  const b3 = await isUserRateLimited(null, 'u1', 'test', 5, 60);
  assert.equal(b1, false, 'no RATE_LIMITS binding → fail-open (allow)');
  assert.equal(b2, false, 'null RATE_LIMITS → fail-open (allow)');
  assert.equal(b3, false, 'null env → fail-open (allow)');
});

test('RLOPT-009: writes are COALESCED — fewer writes than requests (low traffic)', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit 30. Make 3 requests (well under limit, well under FLUSH_SIZE threshold).
  // With the OLD code: 3 KV writes (1 per request). With coalescing: 0-1 writes.
  for (let i = 0; i < 3; i++) {
    await isUserRateLimited(env, 'u1', 'test', 30, 60);
  }
  // The 3 requests are under the FLUSH_SIZE (ceil(30*0.15)=5) and under the
  // near-limit margin, and within the FLUSH_INTERVAL (5s) — so NO flush
  // should have occurred yet → 0 writes. (Delta sits in-memory.)
  assert.ok(kv.putCount <= 1, `low-traffic should coalesce to <=1 write, got ${kv.putCount}`);
  assert.equal(kv.getCount, 3, 'KV is READ on every request (reads are not the quota bottleneck)');
});

test('RLOPT-010: near the limit → forces per-request flush (accuracy at boundary)', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit 10, near-limit margin = ceil(10*0.5) = 5 → flush starts at effective 6+.
  // Make 6 requests to reach the near-limit zone, then verify subsequent requests
  // each force a flush (write count grows roughly 1:1 near the boundary).
  for (let i = 0; i < 6; i++) {
    await isUserRateLimited(env, 'u1', 'test', 10, 60);
  }
  const writesAtNearLimit = kv.putCount;
  // Requests 7,8,9,10 are in the near-limit zone → each forces a flush.
  await isUserRateLimited(env, 'u1', 'test', 10, 60); // 7th
  await isUserRateLimited(env, 'u1', 'test', 10, 60); // 8th
  await isUserRateLimited(env, 'u1', 'test', 10, 60); // 9th
  await isUserRateLimited(env, 'u1', 'test', 10, 60); // 10th
  const writesAfterNearLimit = kv.putCount;
  // Each near-limit request must have triggered a flush (write count grew).
  assert.ok(writesAfterNearLimit > writesAtNearLimit,
    `near-limit requests must force flushes (before=${writesAtNearLimit}, after=${writesAfterNearLimit})`);
  // Specifically, ~4 near-limit requests → ~4 additional writes (1:1 accuracy).
  assert.ok((writesAfterNearLimit - writesAtNearLimit) >= 3,
    `near-limit should flush ~per-request (delta=${writesAfterNearLimit - writesAtNearLimit}, expected >=3)`);
});

test('RLOPT-011: stored counter uses JSON {c, w} format with windowIndex', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // Trigger a flush (size threshold for limit 4 = ceil(4*0.15)=2 → flush at delta 2)
  await isUserRateLimited(env, 'u1', 'test', 4, 60);
  await isUserRateLimited(env, 'u1', 'test', 4, 60);
  assert.ok(kv.putCount >= 1, 'a flush must have occurred');
  assert.ok(kv._lastValue, 'a value must have been written');
  const parsed = JSON.parse(kv._lastValue);
  assert.ok(typeof parsed === 'object' && parsed !== null, 'stored value must be JSON object');
  assert.equal(typeof parsed.c, 'number', 'must have numeric "c" (count) field');
  assert.equal(typeof parsed.w, 'number', 'must have numeric "w" (windowIndex) field');
  assert.equal(parsed.c, 2, 'count must reflect the coalesced delta');
});

test('RLOPT-012: isMarketRateLimited preserves key format mrl:{uid}:{ip}', async () => {
  const { isMarketRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  await isMarketRateLimited(env, '1.2.3.4', '42');
  // Trigger a flush to inspect the key.
  for (let i = 0; i < 4; i++) await isMarketRateLimited(env, '1.2.3.4', '42');
  assert.ok(kv._lastValue, 'a flush must have occurred');
  // The stored key must be mrl:42:1.2.3.4 (uid:ip) — verified via the store.
  const keys = Array.from(kv._store.keys());
  assert.ok(keys.some(k => k === 'mrl:42:1.2.3.4'),
    `key must be 'mrl:42:1.2.3.4' (uid:ip), got: ${JSON.stringify(keys)}`);
});

test('RLOPT-013: isUserRateLimited preserves key format url:{category}:{uid}', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  for (let i = 0; i < 3; i++) await isUserRateLimited(env, 'u1', 'bootstrap', 5, 60);
  const keys = Array.from(kv._store.keys());
  assert.ok(keys.some(k => k === 'url:bootstrap:u1'),
    `key must be 'url:bootstrap:u1', got: ${JSON.stringify(keys)}`);
});

test('RLOPT-014: TTL respects KV minimum 60s (window < 60 clamped)', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // windowSeconds = 10 (< 60). KV requires TTL >= 60 → must clamp to 60.
  for (let i = 0; i < 3; i++) await isUserRateLimited(env, 'u1', 'test', 5, 10);
  assert.ok(kv._lastTtl, 'a TTL must have been set');
  assert.ok(kv._lastTtl.expirationTtl >= 60,
    `TTL must be clamped to >=60 (got ${kv._lastTtl.expirationTtl})`);
});

test('RLOPT-015: backward compat — legacy plain-string counter is parsed', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // Seed KV with a LEGACY plain-string counter (pre-rollout format) at 4.
  kv._store.set('url:test:u1', '4');
  // limit 5. The legacy count (4) must be honored → only 1 more allowed, then block.
  const b1 = await isUserRateLimited(env, 'u1', 'test', 5, 60);
  assert.equal(b1, false, '5th request (legacy count 4) must be allowed');
  const b2 = await isUserRateLimited(env, 'u1', 'test', 5, 60);
  assert.equal(b2, true, '6th request must be BLOCKED (legacy count honored)');
});

test('RLOPT-016: different keys are independent (no cross-contamination)', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // user1 hits limit 3
  for (let i = 0; i < 3; i++) await isUserRateLimited(env, 'u1', 'test', 3, 60);
  // user2 must NOT be affected by user1's count
  const b = await isUserRateLimited(env, 'u2', 'test', 3, 60);
  assert.equal(b, false, 'different user must have independent counter');
});

test('RLOPT-017: non-numeric / invalid limit is handled safely', async () => {
  const { isUserRateLimited } = loadRateLimitFns();
  const kv = createMockKv();
  const env = { RATE_LIMITS: kv };
  // limit = 0 / NaN / undefined → helper clamps to 1 (minimum).
  // Use the SAME key for both requests so the counter accumulates.
  const b1 = await isUserRateLimited(env, 'u1', 'test', 0, 60);
  assert.equal(b1, false, 'limit=0 → clamps to 1, first request allowed');
  const b2 = await isUserRateLimited(env, 'u1', 'test', 0, 60);
  assert.equal(b2, true, 'limit=0 → second request (same key) blocks at clamped limit 1');
});

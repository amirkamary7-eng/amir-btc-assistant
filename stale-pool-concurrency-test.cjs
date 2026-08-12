/**
 * STALE-POOL-CONCURRENCY-TEST
 *
 * Verifies the stale-pool race condition fix in queryDb.
 *
 * SCENARIO (reproduces the production 503 bug):
 *   1. Request A enters withSharedPool, creates pool_A, sets env._reqPool = pool_A
 *   2. Request B enters withSharedPool, saves prev=pool_A, sets env._reqPool = pool_B
 *   3. Request C enters withSharedPool, saves prev=pool_B, sets env._reqPool = pool_C
 *   4. Request B finishes, restores env._reqPool = pool_A, ends pool_B
 *   5. Request C finishes, restores env._reqPool = pool_B (ENDED!), ends pool_C
 *   6. Request A calls queryDb → reads env._reqPool = pool_B (ENDED!)
 *      → BEFORE FIX: throws "Cannot use a pool after calling end on the pool" → 503
 *      → AFTER FIX: clears env._reqPool, falls through to per-call pool → SUCCESS
 *
 * This test uses the REAL withSharedPool + queryDb logic extracted from
 * worker-proxy.js (simplified to remove tracing but preserve pool lifecycle).
 * It uses a mock Pool class that simulates the "Cannot use a pool after end"
 * error and tracks all created pools to verify no leaks.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Mock Pool that simulates @neondatabase/serverless Pool behavior ────
// Tracks created pools to verify lifecycle + detect leaks.
const _allCreatedPools = new Set();

class MockPool {
  constructor(options = {}) {
    this.id = `pool_${_allCreatedPools.size + 1}_${Math.random().toString(36).slice(2, 6)}`;
    this._ended = false;
    this._connectionString = options.connectionString || 'mock://test';
    this.queryCount = 0;
    _allCreatedPools.add(this);
  }

  async query(sql, params) {
    if (this._ended) {
      throw new Error('Cannot use a pool after calling end on the pool');
    }
    this.queryCount++;
    // Simulate a successful query
    return { rows: [{ test: 1 }], rowCount: 1 };
  }

  async end() {
    this._ended = true;
  }

  connect() {
    if (this._ended) throw new Error('Cannot use a pool after calling end on the pool');
    return Promise.resolve({
      query: (sql, params) => this.query(sql, params),
      release: () => {},
    });
  }
}

// Reset pool tracker between tests
function resetPoolTracker() {
  _allCreatedPools.clear();
}

// ── Extracted + simplified withSharedPool (mirrors worker-proxy.js:1645) ──
async function withSharedPool(env, fn, PoolClass = MockPool) {
  // Mirrors real withSharedPool: save/restore env._reqPool
  const _prevReqPool = env._reqPool;
  const _pool = new PoolClass({ connectionString: 'mock://test' });
  env._reqPool = _pool;
  try {
    return await fn();
  } finally {
    // Restore PREVIOUS value BEFORE closing our pool
    env._reqPool = _prevReqPool;
    // Close our pool with a 500ms timeout (same as real code)
    try {
      await Promise.race([
        _pool.end(),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch {}
  }
}

// ── Extracted + simplified queryDb (mirrors worker-proxy.js:1788) ──────
// Includes the STALE-POOL FIX (fall through on "Cannot use a pool after end")
async function queryDb(env, sqlText, params = [], PoolClass = MockPool) {
  // Request-scoped shared pool path
  if (env && env._reqPool) {
    try {
      const result = await env._reqPool.query(sqlText, params);
      return result; // SUCCESS
    } catch (error) {
      const errMsg = String(error?.message || '');
      env._reqPool = null; // Clear broken pool
      // STALE-POOL FIX: fall through on this specific error
      if (errMsg.includes('Cannot use a pool after calling end on the pool')) {
        // Fall through to per-call pool path
      } else {
        throw error; // Other errors still throw
      }
    }
  }

  // Per-call pool path (fallback)
  const _callPool = new PoolClass({ connectionString: 'mock://test' });
  try {
    const result = await _callPool.query(sqlText, params);
    return result;
  } finally {
    try { await _callPool.end(); } catch {}
  }
}

// ── Also define the OLD (buggy) queryDb for comparison testing ─────────
async function queryDb_OLD_BUGGY(env, sqlText, params = [], PoolClass = MockPool) {
  // OLD behavior: re-throw all errors from env._reqPool
  if (env && env._reqPool) {
    try {
      const result = await env._reqPool.query(sqlText, params);
      return result;
    } catch (error) {
      env._reqPool = null;
      throw error; // BUG: re-throws stale-pool error → 503
    }
  }
  const _callPool = new PoolClass({ connectionString: 'mock://test' });
  try {
    return await _callPool.query(sqlText, params);
  } finally {
    try { await _callPool.end(); } catch {}
  }
}

// ── Tests ──────────────────────────────────────────────────────────────

test('STALE-POOL-001 (BUG REPRO): Old code throws "Cannot use a pool after end" → would be 503', async () => {
  resetPoolTracker();
  const env = {};

  // Simulate the race: Request A enters, then B, then C, then B and C finish, then A queries
  // Step 1: Request A enters withSharedPool
  const prevReqPool_A = env._reqPool; // null
  const pool_A = new MockPool();
  env._reqPool = pool_A;

  // Step 2: Request B enters (saves prev=pool_A, sets pool_B)
  const pool_B = new MockPool();
  env._reqPool = pool_B;

  // Step 3: Request C enters (saves prev=pool_B, sets pool_C)
  const pool_C = new MockPool();
  env._reqPool = pool_C;

  // Step 4: Request B finishes (restores prev=pool_A, ends pool_B)
  env._reqPool = pool_A; // restore
  await pool_B.end();

  // Step 5: Request C finishes (restores prev=pool_B which is ENDED, ends pool_C)
  env._reqPool = pool_B; // restore ENDED pool!
  await pool_C.end();

  // Step 6: Request A tries to query → env._reqPool = pool_B (ENDED)
  // OLD BUGGY behavior: throws error
  await assert.rejects(
    queryDb_OLD_BUGGY(env, 'SELECT 1'),
    (err) => {
      assert.match(err.message, /Cannot use a pool after calling end on the pool/);
      return true;
    },
    'OLD code MUST throw the stale-pool error (proves the bug exists)'
  );

  console.log('  ✅ BUG CONFIRMED: Old code throws "Cannot use a pool after end"');
});

test('STALE-POOL-002 (FIX): New code falls through to per-call pool on stale-pool error', async () => {
  resetPoolTracker();
  const env = {};

  // Reproduce the same race
  const pool_A = new MockPool();
  env._reqPool = pool_A;
  const pool_B = new MockPool();
  env._reqPool = pool_B;
  const pool_C = new MockPool();
  env._reqPool = pool_C;
  env._reqPool = pool_A; // B restores
  await pool_B.end();
  env._reqPool = pool_B; // C restores ENDED pool
  await pool_C.end();

  // NEW behavior: falls through to per-call pool, query succeeds
  const result = await queryDb(env, 'SELECT 1');

  assert.ok(result, 'Query MUST return a result');
  assert.equal(result.rows[0].test, 1);
  console.log('  ✅ FIX VERIFIED: New code falls through to per-call pool, query succeeds');
});

test('STALE-POOL-003: Concurrent A/B/C — bootstrap (multiple queries) completes for all 3 requests', async () => {
  resetPoolTracker();
  // This test simulates the FULL bootstrap flow: 3 concurrent requests, each
  // making multiple queryDb calls (ensureTable, getById, bootstrap, watchlist, etc.)
  // All 3 must complete successfully despite the pool race.

  const sharedEnv = {}; // Simulates the shared `env` object in a single isolate

  async function simulateRequest(requestId, queryCount) {
    return withSharedPool(sharedEnv, async () => {
      const results = [];
      for (let i = 0; i < queryCount; i++) {
        // Add small delay to increase race window
        await new Promise(r => setTimeout(r, Math.random() * 5));
        const result = await queryDb(sharedEnv, `SELECT ${i} FROM test_${requestId}`);
        results.push(result);
      }
      return { requestId, queryCount: results.length };
    });
  }

  // Fire 3 concurrent requests, each making 5 queries
  const results = await Promise.all([
    simulateRequest('A', 5),
    simulateRequest('B', 5),
    simulateRequest('C', 5),
  ]);

  console.log('  Results:', results);
  for (const r of results) {
    assert.equal(r.queryCount, 5, `Request ${r.requestId} must complete all 5 queries`);
  }
  console.log('  ✅ All 3 concurrent requests completed all queries');
});

test('STALE-POOL-004: No pool leak — all created pools are end()ed', async () => {
  resetPoolTracker();
  const env = {};

  // Run a few requests that trigger both shared-pool and per-call fallback paths
  await withSharedPool(env, async () => {
    await queryDb(env, 'SELECT 1');
    await queryDb(env, 'SELECT 2');
  });
  await withSharedPool(env, async () => {
    await queryDb(env, 'SELECT 3');
  });

  // Check pool lifecycle: every pool created must be ended
  const created = Array.from(_allCreatedPools);
  console.log(`  Total pools created: ${created.length}`);
  const ended = created.filter(p => p._ended);
  const notEnded = created.filter(p => !p._ended);

  console.log(`  Pools ended: ${ended.length}`);
  console.log(`  Pools NOT ended (LEAK): ${notEnded.length}`);

  if (notEnded.length > 0) {
    console.log('  Leaked pools:', notEnded.map(p => p.id));
  }

  assert.equal(notEnded.length, 0, 'NO pool leak — all created pools must be end()ed');
  console.log('  ✅ No pool leak detected');
});

test('STALE-POOL-005: Fallback per-call pool is properly cleaned up in same request', async () => {
  resetPoolTracker();
  const env = {};

  // Force the fallback path by setting env._reqPool to an ended pool
  const endedPool = new MockPool();
  await endedPool.end();
  env._reqPool = endedPool;

  const poolsBefore = _allCreatedPools.size;
  const result = await queryDb(env, 'SELECT 1');
  const poolsAfter = _allCreatedPools.size;

  // A new per-call pool must have been created
  assert.equal(poolsAfter, poolsBefore + 1, 'One new per-call pool must be created for fallback');

  // The new per-call pool must be ended (cleanup in finally)
  const newPool = Array.from(_allCreatedPools).slice(-1)[0];
  assert.equal(newPool._ended, true, 'Fallback per-call pool must be end()ed after query');

  console.log('  ✅ Fallback per-call pool created and properly cleaned up');
});

test('STALE-POOL-006: Multiple queries in one request — fallback path cleans up each per-call pool', async () => {
  resetPoolTracker();
  const env = {};

  // Set env._reqPool to an ended pool to force fallback for ALL queries
  const endedPool = new MockPool();
  await endedPool.end();
  env._reqPool = endedPool;

  // Make 3 queries — each should create+cleanup its own per-call pool
  const poolsBefore = _allCreatedPools.size;
  await queryDb(env, 'SELECT 1');
  await queryDb(env, 'SELECT 2');
  await queryDb(env, 'SELECT 3');
  const poolsAfter = _allCreatedPools.size;

  // 3 queries × 1 per-call pool each = 3 new pools (plus the initial ended pool)
  assert.equal(poolsAfter - poolsBefore, 3, '3 per-call pools must be created (one per query)');

  // All 3 new pools must be ended
  const newPools = Array.from(_allCreatedPools).slice(poolsBefore - poolsBefore); // get all
  const recentlyCreated = Array.from(_allCreatedPools).filter(p => p !== endedPool);
  const allEnded = recentlyCreated.every(p => p._ended);
  assert.equal(allEnded, true, 'All per-call fallback pools must be end()ed — no leak');

  console.log(`  ✅ 3 per-call pools created and all cleaned up (no leak)`);
});

test('STALE-POOL-007: Real production scenario — concurrent bootstraps with 5 queries each', async () => {
  resetPoolTracker();
  // This most closely simulates the production 503 scenario:
  // - Multiple users call /api/users/bootstrap concurrently
  // - Each bootstrap makes ~5 queryDb calls (ensureTable, getById, bootstrap, watchlist, etc.)
  // - The race must NOT cause any bootstrap to fail

  const sharedEnv = {};
  const numRequests = 5; // 5 concurrent users
  const queriesPerRequest = 5; // 5 DB queries per bootstrap

  async function simulateBootstrap(userId) {
    return withSharedPool(sharedEnv, async () => {
      // Simulate the 5 queryDb calls in handleBootstrap:
      // 1. ensureTable (cached, but let's count it)
      // 2. getById
      // 3. bootstrap (UPSERT)
      // 4. processReferralOnBootstrap (multiple queries)
      // 5. watchlistRepo.getSymbols
      for (let i = 0; i < queriesPerRequest; i++) {
        await new Promise(r => setTimeout(r, Math.random() * 2)); // simulate async
        const result = await queryDb(sharedEnv, `-- query ${i} for user ${userId}`);
        if (!result) throw new Error(`Query ${i} failed for user ${userId}`);
      }
      return { userId, success: true, queries: queriesPerRequest };
    });
  }

  const requests = [];
  for (let i = 0; i < numRequests; i++) {
    requests.push(simulateBootstrap(`user_${i}`));
  }

  const results = await Promise.all(requests);

  console.log('  Bootstrap results:');
  for (const r of results) {
    console.log(`    ${r.userId}: success=${r.success}, queries=${r.queries}`);
  }

  // All requests must succeed
  for (const r of results) {
    assert.equal(r.success, true, `${r.userId} must succeed`);
    assert.equal(r.queries, queriesPerRequest, `${r.userId} must complete all queries`);
  }

  // Verify no pool leak
  const allPools = Array.from(_allCreatedPools);
  const notEnded = allPools.filter(p => !p._ended);
  assert.equal(notEnded.length, 0, 'NO pool leak — all pools end()ed');

  console.log(`  ✅ All ${numRequests} concurrent bootstraps succeeded, no pool leak`);
});

test('STALE-POOL-008: Other errors from env._reqPool still throw (fix is specific to stale-pool)', async () => {
  resetPoolTracker();
  const env = {};

  // Create a pool that throws a DIFFERENT error (not stale-pool)
  class OtherErrorPool extends MockPool {
    async query() {
      throw new Error('Connection terminated unexpectedly');
    }
  }
  env._reqPool = new OtherErrorPool();

  // This should THROW (not fall through) because it's not the stale-pool error
  await assert.rejects(
    queryDb(env, 'SELECT 1'),
    (err) => {
      assert.match(err.message, /Connection terminated unexpectedly/);
      return true;
    },
    'Non-stale-pool errors MUST still throw (preserves existing error handling)'
  );

  console.log('  ✅ Non-stale-pool errors still throw (fix is specific)');
});

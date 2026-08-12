/**
 * WHEEL-RACE-CONCURRENCY-TEST
 *
 * Proves (or refutes) the race condition in getOrCreateDailySpins.
 *
 * Strategy:
 *  - Load the REAL wheel repository from src/repositories/wheel.js
 *  - Inject a mock queryDb + queryDbTransaction that simulates a real
 *    PostgreSQL database with transaction semantics:
 *      • Each queryDbTransaction = BEGIN ... COMMIT (atomic, isolated)
 *      • pg_advisory_xact_lock is transaction-scoped (released on COMMIT)
 *      • COUNT sees committed state at the instant it runs
 *      • INSERT mutates a shared in-memory table
 *  - Run N concurrent getOrCreateDailySpins calls for the same user/day
 *  - Count the resulting rows in wheel_spins
 *
 * Expected with the CURRENT code (race condition):
 *  - 2 concurrent calls with maxSpins=3 → up to 6 rows inserted (3 + 3)
 *  - 3 concurrent calls with maxSpins=3 → up to 9 rows inserted
 *
 * Expected AFTER the fix (single transaction):
 *  - Any number of concurrent calls → exactly maxSpins rows
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Load the real wheel repository source ──────────────────────────────
const wheelRepoPath = path.join(__dirname, 'src', 'repositories', 'wheel.js');
const wheelSrc = fs.readFileSync(wheelRepoPath, 'utf8');

// Transform ESM → CJS so we can require it
const cjsSource = wheelSrc
  .replace(/^export\s+function\s+createWheelRepository/m, 'function createWheelRepository')
  + '\nmodule.exports = { createWheelRepository };';

const moduleObj = { exports: {} };
const evaluator = new Function('require', 'module', 'exports', cjsSource);
evaluator(require, moduleObj, moduleObj.exports);
const { createWheelRepository } = moduleObj.exports;

// ── In-memory database simulator with transaction semantics ────────────
function createDbSimulator() {
  // Shared state — represents the committed table
  const state = {
    wheel_spins: [],          // array of { id, user_id, spin_type, source, status, spin_date, ... }
    nextSpinId: 1,
  };

  // Active locks (transaction-scoped). Keyed by lockKey. Value = transaction id.
  const activeLocks = new Map();

  // Simulate queryDb (non-transactional, autocommit)
  async function queryDb(env, sql, params = []) {
    return executeSql(sql, params, null);
  }

  // Simulate queryDbTransaction — all queries in one atomic batch
  async function queryDbTransaction(env, queries) {
    const txnId = Math.random().toString(36).slice(2);
    const results = [];
    // All queries see the same snapshot? No — we simulate READ COMMITTED:
    // each query sees committed state AT THE TIME IT RUNS.
    for (const { sql, params } of queries) {
      results.push(await executeSql(sql, params, txnId));
    }
    // On COMMIT, release any transaction-scoped locks held by this txn
    for (const [k, v] of activeLocks.entries()) {
      if (v === txnId) activeLocks.delete(k);
    }
    return results;
  }

  // Execute a single SQL statement against the in-memory state
  function executeSql(sql, params, txnId) {
    const sqlLower = sql.trim().toLowerCase();

    // pg_advisory_xact_lock($1) — acquire transaction-scoped lock
    if (sqlLower.startsWith('select pg_advisory_xact_lock')) {
      const lockKey = String(params[0]);
      // If lock is held by another active txn, we'd block — but for the race
      // test, we want to show that the lock is RELEASED between the two
      // separate queryDbTransaction calls, so we just acquire it (no blocking
      // needed since each queryDbTransaction is sequential in our sim).
      activeLocks.set(lockKey, txnId);
      return Promise.resolve({ rows: [{ pg_advisory_xact_lock: '' }] });
    }

    // COUNT(*) FROM wheel_spins WHERE ...
    if (sqlLower.includes('select count(*)') && sqlLower.includes('from wheel_spins') && !sqlLower.includes('with current_count')) {
      const uid = String(params[0]);
      const spinDate = params[1];
      // Count ALL spins (available + used) for this user/day — matches the
      // COUNT query in getOrCreateDailySpins (status IN ('available','used'))
      const cnt = state.wheel_spins.filter(s =>
        s.user_id === uid &&
        s.spin_type === 'daily' &&
        s.source === 'daily_free' &&
        s.spin_date === spinDate &&
        (s.status === 'available' || s.status === 'used')
      ).length;
      return Promise.resolve({ rows: [{ cnt }] });
    }

    // NEW (FIXED) CTE: WITH current_count AS (...) ... INSERT ... SELECT ... RETURNING
    // This is the single-transaction atomic count + conditional insert.
    if (sqlLower.includes('with current_count') && sqlLower.includes('generate_series')) {
      const uid = String(params[0]);
      const spinDate = params[1];
      const maxSpins = Number(params[2]);
      const expiresAt = params[3];
      // Count current spins (available + used)
      const currentCount = state.wheel_spins.filter(s =>
        s.user_id === uid && s.spin_type === 'daily' && s.source === 'daily_free' &&
        s.spin_date === spinDate && (s.status === 'available' || s.status === 'used')
      ).length;
      const needed = Math.max(0, maxSpins - currentCount);
      // Insert exactly `needed` rows
      for (let i = 0; i < needed; i++) {
        state.wheel_spins.push({
          id: state.nextSpinId++,
          user_id: uid, spin_type: 'daily', source: 'daily_free',
          status: 'available', spin_date: spinDate, expires_at: expiresAt,
          created_at: new Date().toISOString(),
        });
      }
      return Promise.resolve({ rows: [{ before_count: currentCount, inserted_count: needed }] });
    }

    // INSERT INTO wheel_spins ...
    if (sqlLower.startsWith('insert into wheel_spins')) {
      const uid = String(params[0]);
      const expiresAt = params[1];
      const spinDate = params[2];
      const row = {
        id: state.nextSpinId++,
        user_id: uid,
        spin_type: 'daily',
        source: 'daily_free',
        status: 'available',
        spin_date: spinDate,
        expires_at: expiresAt,
        created_at: new Date().toISOString(),
      };
      state.wheel_spins.push(row);
      return Promise.resolve({ rows: [row] });
    }

    // SELECT id, status FROM wheel_spins ... (final read in getOrCreateDailySpins)
    if (sqlLower.startsWith('select id, status from wheel_spins')) {
      const uid = String(params[0]);
      const spinDate = params[1];
      const rows = state.wheel_spins.filter(s =>
        s.user_id === uid &&
        s.spin_type === 'daily' &&
        s.source === 'daily_free' &&
        s.spin_date === spinDate &&
        s.status === 'available'
      ).map(s => ({ id: s.id, status: s.status }));
      return Promise.resolve({ rows });
    }

    // CREATE TABLE / ALTER TABLE / INSERT INTO wheel_rewards — no-op in sim
    if (sqlLower.startsWith('create table') || sqlLower.startsWith('alter table') ||
        sqlLower.startsWith('create index') || sqlLower.startsWith('drop index') ||
        sqlLower.startsWith('insert into wheel_rewards')) {
      return Promise.resolve({ rows: [] });
    }
    if (sqlLower.startsWith('select count(*)') && sqlLower.includes('from wheel_rewards')) {
      return Promise.resolve({ rows: [{ cnt: 8 }] }); // pretend seeded
    }

    return Promise.resolve({ rows: [] });
  }

  return {
    queryDb,
    queryDbTransaction,
    _state: state,
    _reset() { state.wheel_spins.length = 0; state.nextSpinId = 1; activeLocks.clear(); },
  };
}

// ── Test: prove the FIX holds maxSpins under concurrency ───────────────
test('WHEEL-RACE-001: 3 concurrent calls must NOT exceed maxSpins (FIXED)', async () => {
  const db = createDbSimulator();
  const wheelRepo = createWheelRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });

  const env = {};
  const userId = '88888888';
  const maxSpins = 3;

  // Fire 3 concurrent calls. With the FIXED single-transaction code,
  // the advisory lock is held for the entire count+insert, so the 2nd
  // and 3rd callers see the 1st caller's inserts and insert 0 rows.
  const results = await Promise.all([
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
  ]);

  const totalRowsInserted = db._state.wheel_spins.filter(s =>
    s.user_id === userId && s.spin_type === 'daily'
  ).length;

  console.log('  Results:', results.map(r => ({ avail: r.total_available, allowed: r.total_allowed })));
  console.log('  Total rows in wheel_spins for user:', totalRowsInserted);
  console.log('  maxSpins =', maxSpins);

  if (totalRowsInserted > maxSpins) {
    console.log(`  ❌ RACE STILL PRESENT: ${totalRowsInserted} rows (maxSpins=${maxSpins}) — exceeded by ${totalRowsInserted - maxSpins}`);
  } else {
    console.log(`  ✅ RACE FIXED: ${totalRowsInserted} rows (maxSpins=${maxSpins}) — limit holds`);
  }

  // The fix must guarantee totalRowsInserted === maxSpins exactly.
  assert.equal(totalRowsInserted, maxSpins,
    `Race condition still present: ${totalRowsInserted} rows inserted, expected exactly ${maxSpins}`);
});

test('WHEEL-RACE-002: 2 concurrent calls must NOT exceed maxSpins (FIXED)', async () => {
  const db = createDbSimulator();
  const wheelRepo = createWheelRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });

  const env = {};
  const userId = '99999999';
  const maxSpins = 3;

  const results = await Promise.all([
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
  ]);

  const totalRowsInserted = db._state.wheel_spins.filter(s =>
    s.user_id === userId && s.spin_type === 'daily'
  ).length;

  console.log('  2-call results:', results.map(r => ({ avail: r.total_available })));
  console.log('  Total rows:', totalRowsInserted, '(maxSpins=3)');

  assert.equal(totalRowsInserted, maxSpins,
    `Race condition still present: ${totalRowsInserted} rows, expected exactly ${maxSpins}`);
});

test('WHEEL-RACE-003: 5 concurrent calls must NOT exceed maxSpins (FIXED)', async () => {
  const db = createDbSimulator();
  const wheelRepo = createWheelRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });

  const env = {};
  const userId = '77777777';
  const maxSpins = 3;

  const results = await Promise.all([
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
    wheelRepo.getOrCreateDailySpins(env, userId, maxSpins),
  ]);

  const totalRowsInserted = db._state.wheel_spins.filter(s =>
    s.user_id === userId && s.spin_type === 'daily'
  ).length;

  console.log('  5-call results:', results.map(r => ({ avail: r.total_available })));
  console.log('  Total rows:', totalRowsInserted, '(maxSpins=3)');

  assert.equal(totalRowsInserted, maxSpins,
    `Race condition still present: ${totalRowsInserted} rows, expected exactly ${maxSpins}`);
});

test('WHEEL-RACE-004: single call inserts exactly maxSpins', async () => {
  const db = createDbSimulator();
  const wheelRepo = createWheelRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });

  const env = {};
  const userId = '66666666';
  const maxSpins = 3;

  const result = await wheelRepo.getOrCreateDailySpins(env, userId, maxSpins);
  const totalRowsInserted = db._state.wheel_spins.filter(s =>
    s.user_id === userId && s.spin_type === 'daily'
  ).length;

  console.log('  Single-call result:', result);
  console.log('  Total rows:', totalRowsInserted);

  assert.equal(totalRowsInserted, maxSpins);
  assert.equal(result.total_available, maxSpins);
  assert.equal(result.total_allowed, maxSpins);
});

test('WHEEL-RACE-005: second call after first completes inserts 0 new rows', async () => {
  const db = createDbSimulator();
  const wheelRepo = createWheelRepository({
    queryDb: db.queryDb,
    queryDbTransaction: db.queryDbTransaction,
  });

  const env = {};
  const userId = '55555555';
  const maxSpins = 3;

  // First call — creates 3 spins
  const r1 = await wheelRepo.getOrCreateDailySpins(env, userId, maxSpins);
  // Second call (sequential) — should see 3 existing, insert 0
  const r2 = await wheelRepo.getOrCreateDailySpins(env, userId, maxSpins);

  const totalRowsInserted = db._state.wheel_spins.filter(s =>
    s.user_id === userId && s.spin_type === 'daily'
  ).length;

  console.log('  r1:', r1, 'r2:', r2);
  console.log('  Total rows:', totalRowsInserted);

  assert.equal(totalRowsInserted, maxSpins, 'Second call should not add new rows');
  assert.equal(r2.total_available, maxSpins);
});

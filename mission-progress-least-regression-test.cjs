/**
 * MISSION PROGRESS LEAST() REGRESSION TEST — PHASE 2D minimal race fix
 *
 * Verifies the LEAST(mission_progress.progress_count + 1, mission_progress.target_count)
 * cap in incrementMissionProgress (both daily and weekly UPSERT paths).
 *
 * The race (confirmed in Phase 2E verification):
 *   - incrementMissionProgress and markMissionRewarded are TWO separate auto-commit
 *     statements (queryDb, NOT queryDbTransaction) — no shared row lock.
 *   - In the ~5-15ms window between increment reaching target and markMissionRewarded
 *     committing, a concurrent/replayed increment sees rewarded=FALSE and inflates
 *     progress_count beyond target_count (e.g., 6/5, 2/1).
 *   - CASE WHEN rewarded=FALSE alone is INSUFFICIENT — it only blocks increment
 *     AFTER rewarded=TRUE, not in the race window.
 *   - The LEAST() cap closes the window: even if a second increment sees rewarded=FALSE,
 *     progress_count is capped at target_count.
 *
 * pg-mem is single-threaded, so we cannot test TRUE concurrency. Instead we
 * simulate the race OBSERVABLE: pre-seed progress_count at target-1, then call
 * incrementMissionProgress twice in succession (simulating two requests that
 * both passed the token check before either reached markMissionRewarded).
 * Without LEAST(), the second call inflates to target+1. With LEAST(), it caps
 * at target.
 *
 * ── LEAST-series ────────────────────────────────────────────────────────────
 *   LEAST-1  target=5, progress=4 → two sequential increments → progress caps at 5 (not 6)
 *   LEAST-2  target=1, progress=0 → two sequential increments → progress caps at 1 (not 2)
 *   LEAST-3  after rewarded=TRUE → increment leaves progress UNCHANGED (CASE WHEN FALSE)
 *   LEAST-4  weekly path (read_news) → same cap behavior as daily (LEAST-1 equivalent)
 *   LEAST-5  completed flag is TRUE when progress reaches target (never missed)
 *   LEAST-6  economic invariant: markMissionRewarded CAS — only ONE claim succeeds
 *   LEAST-7  no-migration invariant: LEAST() is pure SQL, no schema change needed
 *   LEAST-8  idempotency: repeated increments after target do NOT change progress
 *
 * Source-level guard:
 *   LEAST-SRC  reward_center.js contains LEAST( in both UPSERT branches
 *   LEAST-NO-MIGRATION  scripts/00-migrate.sql is unchanged (no new CHECK or column)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const ROOT = path.join(__dirname);

// ── Load the REAL createRewardCenterRepository from current source ─────────
const rewardSrc = fs.readFileSync(path.join(ROOT, 'src/repositories/reward_center.js'), 'utf8');
const factoryBody = rewardSrc
  .replace(/export\s+function\s+/g, 'function ')
  .replace(/export\s+const\s+/g, 'const ');
const factoryWrapped = `${factoryBody}\nmodule.exports = { createRewardCenterRepository };`;
const factoryMod = { exports: {} };
new Function('module', 'exports', 'require', factoryWrapped)(factoryMod, factoryMod.exports, require);
const createRewardCenterRepository = factoryMod.exports.createRewardCenterRepository;

// ── Schema (mirrors production mission_progress + weekly partial unique index) ──
const SCHEMA_SQL = `
  CREATE TABLE mission_progress (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    mission_id VARCHAR(64) NOT NULL,
    progress_count INTEGER NOT NULL DEFAULT 0,
    target_count INTEGER NOT NULL DEFAULT 1,
    completed BOOLEAN NOT NULL DEFAULT FALSE,
    rewarded BOOLEAN NOT NULL DEFAULT FALSE,
    daily_date DATE NOT NULL DEFAULT CURRENT_DATE,
    week_start DATE,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    UNIQUE(user_id, mission_id, daily_date)
  );
  CREATE UNIQUE INDEX idx_mission_progress_week
    ON mission_progress (user_id, mission_id, week_start)
    WHERE week_start IS NOT NULL;
`;

// ── Param interpolation (same approach as wallet-test-harness.cjs) ─────────
function interpolate(sql, params = []) {
  let out = sql;
  for (let i = 0; i < params.length; i++) {
    const v = params[i];
    let lit;
    if (v === null || v === undefined) lit = 'NULL';
    else if (typeof v === 'number') lit = String(v);
    else if (typeof v === 'boolean') lit = v ? 'TRUE' : 'FALSE';
    else {
      const s = String(v).replace(/'/g, `''`);
      lit = `'${s}'`;
    }
    out = out.split('$' + (i + 1)).join(lit);
  }
  return out;
}

function normalizeRows(rows) {
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (v instanceof Date) {
        const iso = v.toISOString();
        if (iso.slice(11, 23) === '00:00:00.000') {
          row[k] = iso.slice(0, 10);
          continue;
        }
      }
      if (Array.isArray(v)) row[k] = v.length === 0 ? null : v[0];
    }
  }
  return rows;
}

/**
 * Build a test harness:
 *  - pg-mem with mission_progress schema (daily UNIQUE + weekly partial UNIQUE)
 *  - queryDb that intercepts ensureSchema batch SQL (schema is pre-created)
 *  - queryDb that intercepts the jsonb_set migration (pg-mem lacks jsonb_set)
 *  - raw() for direct test setup/assertions
 */
function makeHarness() {
  const db = newDb();
  db.public.many(SCHEMA_SQL);

  const Pool = db.adapters.createPg().Pool;

  async function queryDb(env, sqlText, params = []) {
    const sql = String(sqlText);
    // Intercept ensureSchema batch (CREATE TABLE IF NOT EXISTS etc.) — schema
    // is pre-created. Also intercept seed INSERTs and the jsonb_set migration.
    if (sql.includes('CREATE TABLE IF NOT EXISTS')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('CREATE INDEX IF NOT EXISTS')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('ALTER TABLE mission_progress')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('jsonb_set')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO wheel_config')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('INSERT INTO reward_emergency_controls')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('referral_reward_tiers') && sql.includes('INSERT')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('reward_library') && sql.includes('INSERT')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('mission_rewards') && sql.includes('INSERT')) {
      return { rows: [], rowCount: 0 };
    }
    if (sql.includes('SELECT COUNT(*)') && sql.includes('FROM')) {
      // Seed-count checks return 1 so the seed INSERTs are skipped
      return { rows: [{ cnt: 1 }], rowCount: 1 };
    }

    const pool = new Pool();
    try {
      const r = await pool.query(interpolate(sql, params), []);
      return { rows: normalizeRows(r.rows), rowCount: r.rowCount };
    } finally {
      try { pool.end(); } catch {}
    }
  }

  async function queryDbTransaction(env, queries) {
    const pool = new Pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const { sql, params } of queries) {
        const r = await client.query(interpolate(String(sql), params || []), []);
        results.push({ rows: normalizeRows(r.rows), rowCount: r.rowCount });
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch {}
      throw error;
    } finally {
      try { client.release(); } catch {}
      try { pool.end(); } catch {}
    }
  }

  async function raw(sql, params = []) {
    const pool = new Pool();
    try {
      const r = await pool.query(interpolate(sql, params), []);
      return { rows: normalizeRows(r.rows), rowCount: r.rowCount };
    } finally {
      try { pool.end(); } catch {}
    }
  }

  return Object.freeze({ queryDb, queryDbTransaction, raw });
}

// ── Date helpers ────────────────────────────────────────────────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);

function setupRepo() {
  const h = makeHarness();
  const deps = {
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
    isDatabaseConfigured: () => true,
    isoDate: (v) => v ? new Date(v).toISOString() : null,
    normalizeOptionalString: (v) => v || null,
    getTehranDateString: () => todayStr(),
    getTehranWeekStart: () => todayStr(),
  };
  const repo = createRewardCenterRepository(deps);
  return { h, repo };
}

// Helper: read current mission_progress row
async function getProgressRow(h, userId, missionId) {
  const r = await h.raw(
    `SELECT progress_count, target_count, completed, rewarded
     FROM mission_progress
     WHERE user_id = $1 AND mission_id = $2
     ORDER BY id DESC LIMIT 1`,
    [String(userId), String(missionId)],
  );
  return r.rows[0] || null;
}

// Helper: pre-seed a mission_progress row at a specific state
async function seedProgress(h, userId, missionId, { progress, target, completed, rewarded, dailyDate, weekStart }) {
  await h.raw(
    `INSERT INTO mission_progress (user_id, mission_id, progress_count, target_count, completed, rewarded, daily_date, week_start)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)`,
    [
      String(userId), String(missionId),
      Number(progress), Number(target),
      Boolean(completed), Boolean(rewarded),
      dailyDate || todayStr(),
      weekStart || null,
    ],
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// TESTS
// ═══════════════════════════════════════════════════════════════════════════

test('LEAST-1: target=5, progress=4 → two sequential increments cap at 5 (not 6)', async () => {
  const { h, repo } = setupRepo();
  const userId = 'u_least_1';
  const missionId = 'daily_login'; // daily mission
  const target = 5;

  // Pre-seed at progress=4, rewarded=FALSE (the race starting state)
  await seedProgress(h, userId, missionId, {
    progress: 4, target, completed: false, rewarded: false,
  });

  // Simulate two concurrent requests that both passed the token check
  // before either reached markMissionRewarded. Both call increment.
  const r1 = await repo.incrementMissionProgress({}, userId, missionId, target);
  const r2 = await repo.incrementMissionProgress({}, userId, missionId, target);

  // Both should report completed=TRUE
  assert.equal(r1.completed, true, 'first increment should mark completed=TRUE');
  assert.equal(r2.completed, true, 'second increment should also mark completed=TRUE');

  // CRITICAL: progress_count must NEVER exceed target_count
  assert.equal(r1.progress_count, 5, 'first increment: progress = 5 (reached target)');
  assert.equal(r2.progress_count, 5, 'second increment: progress CAPPED at 5 (LEAST), NOT 6');

  // Verify DB state
  const row = await getProgressRow(h, userId, missionId);
  assert.equal(Number(row.progress_count), 5, 'DB progress_count = 5 (capped)');
  assert.equal(row.completed, true, 'DB completed = TRUE');
  assert.equal(row.rewarded, false, 'DB rewarded still FALSE (markMissionRewarded not called yet)');
});

test('LEAST-2: target=1, progress=0 → two sequential increments cap at 1 (not 2)', async () => {
  const { h, repo } = setupRepo();
  const userId = 'u_least_2';
  const missionId = 'daily_login';
  const target = 1;

  // No pre-seed — first call INSERTs (progress=1, completed=TRUE since target<=1)
  const r1 = await repo.incrementMissionProgress({}, userId, missionId, target);
  // Second call simulates a replay/concurrent request
  const r2 = await repo.incrementMissionProgress({}, userId, missionId, target);

  assert.equal(r1.progress_count, 1, 'first increment: progress = 1');
  assert.equal(r2.progress_count, 1, 'second increment: progress CAPPED at 1 (LEAST), NOT 2');
  assert.equal(r1.completed, true, 'first: completed=TRUE');
  assert.equal(r2.completed, true, 'second: completed=TRUE');

  const row = await getProgressRow(h, userId, missionId);
  assert.equal(Number(row.progress_count), 1, 'DB progress_count = 1 (capped, not 2)');
});

test('LEAST-3: after rewarded=TRUE, increment leaves progress UNCHANGED', async () => {
  const { h, repo } = setupRepo();
  const userId = 'u_least_3';
  const missionId = 'daily_login';
  const target = 5;

  // Pre-seed at progress=5, rewarded=TRUE (mission already completed and rewarded)
  await seedProgress(h, userId, missionId, {
    progress: 5, target, completed: true, rewarded: true,
  });

  // Multiple increments after reward — should all be no-ops
  const r1 = await repo.incrementMissionProgress({}, userId, missionId, target);
  const r2 = await repo.incrementMissionProgress({}, userId, missionId, target);
  const r3 = await repo.incrementMissionProgress({}, userId, missionId, target);

  assert.equal(r1.progress_count, 5, 'post-reward increment 1: progress unchanged at 5');
  assert.equal(r2.progress_count, 5, 'post-reward increment 2: progress unchanged at 5');
  assert.equal(r3.progress_count, 5, 'post-reward increment 3: progress unchanged at 5');
  assert.equal(r1.completed, true, 'post-reward: completed still TRUE');
  assert.equal(r1.rewarded, true, 'post-reward: rewarded still TRUE');

  const row = await getProgressRow(h, userId, missionId);
  assert.equal(Number(row.progress_count), 5, 'DB progress_count unchanged after post-reward increments');
  assert.equal(row.rewarded, true, 'DB rewarded still TRUE');
});

test('LEAST-4: weekly path (read_news) → same LEAST() pattern as daily (source-level)', () => {
  // pg-mem does not support ON CONFLICT (col) WHERE ... (partial-index conflict
  // target) — its parser rejects the `WHERE week_start IS NOT NULL` clause.
  // This is a pg-mem limitation, NOT a code issue: real PostgreSQL supports
  // partial-index ON CONFLICT (verified in production schema at
  // scripts/00-migrate.sql line 561-563: idx_mission_progress_week).
  //
  // The LEAST() change is IDENTICAL in both branches (same SQL pattern, same
  // expression). We verify at the source level that both branches contain the
  // same LEAST() guard, and the daily path (LEAST-1) already exercises the
  // real SQL against pg-mem.
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/reward_center.js'), 'utf8');

  // Extract the weekly UPSERT block (contains "ON CONFLICT (user_id, mission_id, week_start)")
  const weeklyBlockMatch = src.match(/ON CONFLICT \(user_id, mission_id, week_start\)[\s\S]*?RETURNING \*/);
  assert.ok(weeklyBlockMatch, 'weekly UPSERT block found');
  const weeklyBlock = weeklyBlockMatch[0];
  assert.ok(
    /LEAST\(mission_progress\.progress_count\s*\+\s*1,\s*mission_progress\.target_count\)/.test(weeklyBlock),
    'weekly branch contains LEAST(progress_count + 1, target_count)',
  );
  assert.ok(
    /CASE WHEN mission_progress\.rewarded = FALSE/.test(weeklyBlock),
    'weekly branch retains CASE WHEN rewarded=FALSE guard',
  );

  // Extract the daily UPSERT block (contains "ON CONFLICT (user_id, mission_id, daily_date)")
  const dailyBlockMatch = src.match(/ON CONFLICT \(user_id, mission_id, daily_date\)[\s\S]*?RETURNING \*/);
  assert.ok(dailyBlockMatch, 'daily UPSERT block found');
  const dailyBlock = dailyBlockMatch[0];
  assert.ok(
    /LEAST\(mission_progress\.progress_count\s*\+\s*1,\s*mission_progress\.target_count\)/.test(dailyBlock),
    'daily branch contains LEAST(progress_count + 1, target_count)',
  );

  // Both branches use the IDENTICAL LEAST() expression
  const weeklyLeast = weeklyBlock.match(/LEAST\(mission_progress\.progress_count\s*\+\s*1,\s*mission_progress\.target_count\)/)[0];
  const dailyLeast = dailyBlock.match(/LEAST\(mission_progress\.progress_count\s*\+\s*1,\s*mission_progress\.target_count\)/)[0];
  assert.equal(weeklyLeast, dailyLeast, 'weekly and daily LEAST() expressions are identical');
});

test('LEAST-5: progress caps at target, completed eventually TRUE (never missed)', async () => {
  const { h, repo } = setupRepo();
  const userId = 'u_least_5';
  const missionId = 'daily_login';
  const target = 3;

  // NOTE: pg-mem evaluates SET clauses sequentially (progress_count is updated
  // BEFORE completed is evaluated), while real PostgreSQL evaluates all SET
  // expressions against the OLD row. This means pg-mem shows completed=TRUE
  // one step earlier than real PG. We assert the KEY invariant (progress_count
  // caps at target, completed is eventually TRUE) rather than intermediate
  // completed values, which differ between pg-mem and real PG.

  // Increment 1: progress 1
  const r1 = await repo.incrementMissionProgress({}, userId, missionId, target);
  assert.equal(r1.progress_count, 1, 'increment 1: progress = 1');

  // Increment 2: progress 2
  const r2 = await repo.incrementMissionProgress({}, userId, missionId, target);
  assert.equal(r2.progress_count, 2, 'increment 2: progress = 2');

  // Increment 3: progress 3 (reached target)
  const r3 = await repo.incrementMissionProgress({}, userId, missionId, target);
  assert.equal(r3.progress_count, 3, 'increment 3: progress = 3 (reached target)');
  assert.equal(r3.completed, true, 'increment 3: completed=TRUE (reached target)');

  // Increment 4 (replay): progress CAPPED at 3, completed still TRUE
  const r4 = await repo.incrementMissionProgress({}, userId, missionId, target);
  assert.equal(r4.progress_count, 3, 'increment 4 (replay): progress CAPPED at 3');
  assert.equal(r4.completed, true, 'increment 4: completed still TRUE');

  // Increment 5-10: all capped at 3
  for (let i = 5; i <= 10; i++) {
    const r = await repo.incrementMissionProgress({}, userId, missionId, target);
    assert.equal(r.progress_count, 3, `increment ${i}: progress still 3 (capped)`);
    assert.equal(r.completed, true, `increment ${i}: completed still TRUE`);
  }

  const row = await getProgressRow(h, userId, missionId);
  assert.equal(Number(row.progress_count), 3, 'DB progress_count = 3 (capped)');
});

test('LEAST-6: economic invariant — markMissionRewarded CAS, only ONE claim succeeds', async () => {
  const { h, repo } = setupRepo();
  const userId = 'u_least_6';
  const missionId = 'daily_login';
  const target = 5;

  // Pre-seed at progress=5, completed=TRUE, rewarded=FALSE
  await seedProgress(h, userId, missionId, {
    progress: 5, target, completed: true, rewarded: false,
  });

  // Two concurrent markMissionRewarded calls — only ONE should succeed (CAS)
  const [claim1, claim2] = await Promise.all([
    repo.markMissionRewarded({}, userId, missionId),
    repo.markMissionRewarded({}, userId, missionId),
  ]);

  // Exactly one claim must succeed
  const claims = [claim1, claim2].filter(c => c === true);
  assert.equal(claims.length, 1, 'exactly ONE markMissionRewarded claim succeeds (CAS)');

  // DB: rewarded=TRUE
  const row = await getProgressRow(h, userId, missionId);
  assert.equal(row.rewarded, true, 'DB rewarded = TRUE after successful claim');
});

test('LEAST-7: no-migration invariant — LEAST() is pure SQL, no schema change', async () => {
  // Verify the migrate.sql does NOT contain a CHECK constraint on progress_count
  // (which would have been the migration-based approach we rejected)
  const migrateSql = fs.readFileSync(path.join(ROOT, 'scripts/00-migrate.sql'), 'utf8');
  assert.ok(
    !/CHECK\s*\(\s*progress_count\s*<=\s*target_count/i.test(migrateSql),
    'no CHECK(progress_count <= target_count) constraint added (LEAST() is pure SQL, no migration)',
  );
});

test('LEAST-8: idempotency — repeated increments after target do NOT change progress', async () => {
  const { h, repo } = setupRepo();
  const userId = 'u_least_8';
  const missionId = 'daily_login';
  const target = 5;

  // Pre-seed at target
  await seedProgress(h, userId, missionId, {
    progress: 5, target, completed: true, rewarded: false,
  });

  // 10 increments — all should be capped at 5
  for (let i = 0; i < 10; i++) {
    const r = await repo.incrementMissionProgress({}, userId, missionId, target);
    assert.equal(r.progress_count, 5, `increment ${i + 1}: progress still 5 (capped)`);
  }

  const row = await getProgressRow(h, userId, missionId);
  assert.equal(Number(row.progress_count), 5, 'DB progress_count = 5 after 10 increments');
});

// ═══════════════════════════════════════════════════════════════════════════
// SOURCE-LEVEL GUARDS
// ═══════════════════════════════════════════════════════════════════════════

test('LEAST-SRC: reward_center.js contains LEAST() in both UPSERT branches', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/reward_center.js'), 'utf8');
  const leastMatches = src.match(/LEAST\(/g) || [];
  // Must appear exactly twice (weekly + daily progress_count SET clause)
  // Note: completed clause does NOT use LEAST (intentionally — it's a boolean comparison)
  assert.ok(
    leastMatches.length >= 2,
    `LEAST() must appear at least 2 times (weekly + daily), found ${leastMatches.length}`,
  );
});

test('LEAST-SRC: both branches use LEAST(progress_count + 1, target_count) pattern', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/reward_center.js'), 'utf8');
  const pattern = /LEAST\(mission_progress\.progress_count\s*\+\s*1,\s*mission_progress\.target_count\)/g;
  const matches = src.match(pattern) || [];
  assert.equal(
    matches.length, 2,
    `exactly 2 LEAST(progress_count + 1, target_count) occurrences (weekly + daily), found ${matches.length}`,
  );
});

test('LEAST-SRC: CASE WHEN rewarded=FALSE guard present in both branches', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/reward_center.js'), 'utf8');
  const caseMatches = src.match(/CASE WHEN mission_progress\.rewarded = FALSE/g) || [];
  // 2 per branch (progress_count + completed) × 2 branches = 4
  assert.ok(
    caseMatches.length >= 4,
    `CASE WHEN rewarded=FALSE guard present in both branches, found ${caseMatches.length}`,
  );
});

test('LEAST-SRC: markMissionRewarded CAS unchanged (WHERE rewarded = FALSE)', () => {
  const src = fs.readFileSync(path.join(ROOT, 'src/repositories/reward_center.js'), 'utf8');
  // markMissionRewarded must still have WHERE rewarded = FALSE (CAS pattern)
  assert.ok(
    /UPDATE mission_progress\s+SET rewarded = TRUE.*?WHERE.*?rewarded = FALSE/s.test(src),
    'markMissionRewarded retains WHERE rewarded = FALSE (CAS unchanged)',
  );
});

test('LEAST-NO-MIGRATION: scripts/00-migrate.sql has no new progress_count constraint', () => {
  const migrateSql = fs.readFileSync(path.join(ROOT, 'scripts/00-migrate.sql'), 'utf8');
  // Verify no new CHECK or ALTER for progress_count capping
  assert.ok(
    !/ALTER TABLE mission_progress ADD CONSTRAINT.*progress_count/i.test(migrateSql),
    'no new ALTER TABLE constraint on progress_count (no migration needed)',
  );
});

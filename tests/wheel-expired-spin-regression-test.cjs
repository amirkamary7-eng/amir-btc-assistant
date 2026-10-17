/**
 * WHEEL-EXPIRED-SPIN REGRESSION TEST — SEC-02
 *
 * Finding (master audit + Phase 1 revalidation, both CONFIRMED):
 *   consumeSpin's UPDATE (src/repositories/wheel.js) guarded only
 *   (id, user_id, status='available') — NO expires_at predicate — while
 *   every allocation/listing query (getOrCreateDailySpins count + final
 *   SELECT, getAvailableSpins) already enforces
 *   (expires_at IS NULL OR expires_at > NOW()).
 *   The controller passes an explicit body.spin_id straight to consumeSpin,
 *   short-circuiting the allocation path, so any authenticated user could
 *   harvest spin ids and consume EXPIRED-but-still-'available' rows forever
 *   ("zombie" spins — payout inflation).
 *
 * FIX UNDER TEST:
 *   consumeSpin's UPDATE now adds AND (expires_at IS NULL OR expires_at > NOW())
 *   — identical predicate to the allocation/listing paths. NULL-expires rows
 *   (legacy, no expiry set) remain consumable.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   The REAL wheel repository is loaded from src/repositories/wheel.js
 *   (ESM→CJS transform, same pattern as wheel-race-concurrency-test.cjs) and
 *   its REAL SQL is executed verbatim against pg-mem (same Pool/session-client
 *   pattern as wallet-test-harness.cjs). Run against the pre-fix code,
 *   WHEEL-EXPIRED-01 FAILS — that failure is the vulnerability reproduction
 *   (mirrors scripts/sec02_wheel_expiry_repro.cjs). Run against the fixed
 *   code, everything must pass.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const ROOT = path.join(__dirname, '..');

// ── Load the REAL wheel repository from current source ────────────────────
const wheelRepoPath = path.join(ROOT, 'src', 'repositories', 'wheel.js');
const wheelSrc = fs.readFileSync(wheelRepoPath, 'utf8');

// Source-assertion target: the consumeSpin UPDATE must carry the expiry
// predicate while preserving the id / user_id / status guards.
test('WHEEL-EXPIRED-07: consumeSpin UPDATE carries the expiry predicate (source)', () => {
  const fnStart = wheelSrc.indexOf('async function consumeSpin');
  assert.ok(fnStart > -1, 'consumeSpin must exist in wheel.js');
  const fnEnd = wheelSrc.indexOf('async function getSpinHistory', fnStart);
  const fnSrc = wheelSrc.slice(fnStart, fnEnd);
  const updateMatch = fnSrc.match(/UPDATE wheel_spins[\s\S]*?RETURNING id, spin_type, source, campaign_id/);
  assert.ok(updateMatch, 'consumeSpin must contain the atomic UPDATE');
  const update = updateMatch[0].replace(/--[^\n]*/g, ''); // strip SQL comments
  assert.ok(/id\s*=\s*\$1/.test(update), 'must keep the row-id guard (id = $1)');
  assert.ok(/user_id\s*=\s*\$2/.test(update), 'must keep the ownership guard (user_id = $2)');
  assert.ok(/status\s*=\s*'available'/.test(update), 'must keep the state guard (status = available)');
  assert.ok(
    /expires_at IS NULL OR expires_at > NOW\(\)/.test(update),
    'SEC-02: consumeSpin UPDATE must enforce (expires_at IS NULL OR expires_at > NOW())',
  );
});

const cjsSource = wheelSrc
  .replace(/^export\s+function\s+createWheelRepository/m, 'function createWheelRepository')
  + '\nmodule.exports = { createWheelRepository };';
const moduleObj = { exports: {} };
const evaluator = new Function('require', 'module', 'exports', cjsSource);
evaluator(require, moduleObj, moduleObj.exports);
const { createWheelRepository } = moduleObj.exports;

// ── pg-mem schema — mirrors wheel.js ensureSchema exactly ──────────────────
const SCHEMA_SQL = `
  CREATE TABLE wheel_spins (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    spin_type VARCHAR(16) NOT NULL DEFAULT 'daily',
    source VARCHAR(32) NOT NULL DEFAULT 'daily_free',
    status VARCHAR(16) NOT NULL DEFAULT 'available',
    campaign_id VARCHAR(64),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    expires_at TIMESTAMPTZ,
    used_at TIMESTAMPTZ,
    spin_date DATE NOT NULL DEFAULT CURRENT_DATE
  );
  CREATE TABLE wheel_history (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    spin_id INTEGER REFERENCES wheel_spins(id),
    reward_type VARCHAR(32) NOT NULL,
    reward_amount INTEGER NOT NULL DEFAULT 0,
    reward_label VARCHAR(128),
    spin_type VARCHAR(16) NOT NULL DEFAULT 'daily',
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
  CREATE TABLE wheel_rewards (
    id SERIAL PRIMARY KEY,
    reward_type VARCHAR(32) NOT NULL,
    reward_amount INTEGER NOT NULL DEFAULT 0,
    reward_label VARCHAR(128),
    weight INTEGER NOT NULL DEFAULT 1,
    is_active BOOLEAN NOT NULL DEFAULT TRUE,
    campaign_id VARCHAR(64),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );
`;

// ── Param interpolation + harness (same shim rationale as wallet-test-harness.cjs) ──
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
      if (v.startsWith('{') || v.startsWith('[')) {
        try { JSON.parse(v); lit = `'${s}'::jsonb`; } catch { lit = `'${s}'`; }
      } else lit = `'${s}'`;
    }
    out = out.split('$' + (i + 1)).join(lit);
  }
  return out;
}

function makeHarness() {
  const db = newDb();
  db.public.many(SCHEMA_SQL);
  const Pool = db.adapters.createPg().Pool;

  async function queryDb(_env, sql, params = []) {
    const pool = new Pool();
    try {
      const r = await pool.query(interpolate(String(sql), params), []);
      return { rows: r.rows, rowCount: r.rowCount };
    } finally {
      try { pool.end(); } catch { /* ignore */ }
    }
  }

  async function queryDbTransaction(_env, queries) {
    const pool = new Pool();
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      const results = [];
      for (const { sql, params } of queries) {
        const r = await client.query(interpolate(String(sql), params || []), []);
        results.push({ rows: r.rows, rowCount: r.rowCount });
      }
      await client.query('COMMIT');
      return results;
    } catch (error) {
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
      throw error;
    } finally {
      try { client.release(); } catch { /* ignore */ }
      try { pool.end(); } catch { /* ignore */ }
    }
  }

  async function raw(sql, params = []) {
    return queryDb({}, sql, params);
  }

  return { queryDb, queryDbTransaction, raw };
}

/** Fresh repo on a fresh harness with one deterministic active reward. */
function makeStack() {
  const h = makeHarness();
  const wheelRepo = createWheelRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
  });
  return { h, wheelRepo };
}

async function seedReward(h) {
  await h.raw(
    `INSERT INTO wheel_rewards (reward_type, reward_amount, reward_label, weight, is_active, metadata)
     VALUES ('token', 5, '۵ AB', 1, TRUE, '{}')`,
  );
}

/**
 * Seed a spin row with explicit lifecycle fields.
 * Returns the inserted row's id.
 */
async function seedSpin(h, { userId = 'u1', status = 'available', expiresAt = null, createdDaysAgo = 0, spinType = 'daily', source = 'daily_free' }) {
  // expiresAt is a raw SQL expression (e.g. "NOW() - INTERVAL '4 days'") or null.
  const expiresSql = expiresAt === null ? 'NULL' : expiresAt;
  const r = await h.raw(
    `INSERT INTO wheel_spins (user_id, spin_type, source, status, metadata, created_at, expires_at, spin_date)
     VALUES ($1, $2, $3, $4, '{}', NOW() - INTERVAL '${Number(createdDaysAgo)} days', ${expiresSql}, CURRENT_DATE - ${Number(createdDaysAgo)})
     RETURNING id`,
    [userId, spinType, source, status],
  );
  return Number(r.rows[0].id);
}

async function spinRow(h, id) {
  const r = await h.raw('SELECT id, status, used_at, expires_at FROM wheel_spins WHERE id = $1', [Number(id)]);
  return r.rows[0] || null;
}

async function historyCount(h, spinId) {
  const r = await h.raw('SELECT COUNT(*)::int AS c FROM wheel_history WHERE spin_id = $1', [Number(spinId)]);
  return Number(r.rows[0].c);
}

async function assertNotAvailable(h, spinId) {
  const row = await spinRow(h, spinId);
  assert.equal(row.status, 'available', 'rejected spin must remain available (not consumed)');
  assert.equal(row.used_at, null, 'rejected spin must not get used_at set');
  assert.equal(await historyCount(h, spinId), 0, 'rejected spin must not produce wheel_history (no reward record)');
}

function isSpinNotAvailable(e) {
  return e && e.code === 'SPIN_NOT_AVAILABLE';
}

// ═══════════════════════════════════════════════════════════════════════════
// SEC-02 core: expired-available rows must NOT be consumable
// ═══════════════════════════════════════════════════════════════════════════

test('WHEEL-EXPIRED-01: an EXPIRED available spin cannot be consumed (SEC-02, RED on pre-fix code)', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  // "Zombie" row: created 5 days ago, expired 4 days ago, still status=available
  // (no sweeper exists — see audit; exactly the production hazard state).
  const id = await seedSpin(h, { userId: 'u_sec02', expiresAt: "NOW() - INTERVAL '4 days'", createdDaysAgo: 5 });

  await assert.rejects(
    () => wheelRepo.consumeSpin({}, 'u_sec02', id),
    (e) => {
      assert.ok(isSpinNotAvailable(e), `expected SPIN_NOT_AVAILABLE, got: ${e && e.message}`);
      return true;
    },
    'expired-available spin must be rejected',
  );
  await assertNotAvailable(h, id);
});

test('WHEEL-EXPIRED-02: an expired spin is rejected even when the caller supplies its explicit spin_id', async () => {
  // The controller short-circuit: body.spin_id goes straight to consumeSpin,
  // bypassing getOrCreateDailySpins' expiry-filtered allocation. The repo-level
  // predicate must hold regardless of which caller/path supplies the id.
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  const id = await seedSpin(h, { userId: 'u_sec02b', expiresAt: "NOW() - INTERVAL '1 second'", createdDaysAgo: 1 });

  await assert.rejects(
    () => wheelRepo.consumeSpin({}, 'u_sec02b', String(id)),
    isSpinNotAvailable,
    'explicit spin_id of an expired row must be rejected',
  );
  await assertNotAvailable(h, id);
});

// ═══════════════════════════════════════════════════════════════════════════
// Behavior preservation: valid rows keep working exactly as before
// ═══════════════════════════════════════════════════════════════════════════

test('WHEEL-EXPIRED-03: a valid unexpired spin IS consumed and its reward recorded', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  const id = await seedSpin(h, { userId: 'u_ok', expiresAt: "NOW() + INTERVAL '8 hours'" });

  const result = await wheelRepo.consumeSpin({}, 'u_ok', id);

  assert.equal(result.spin_id, id);
  assert.equal(result.spin_type, 'daily');
  assert.equal(result.reward.type, 'token');
  assert.equal(result.reward.amount, 5);

  const row = await spinRow(h, id);
  assert.equal(row.status, 'used', 'fresh spin must be consumed');
  assert.ok(row.used_at, 'used_at must be set');
  assert.equal(await historyCount(h, id), 1, 'exactly one wheel_history row (reward recorded)');
});

test('WHEEL-EXPIRED-04: a NULL-expires legacy spin remains consumable (backward compatibility)', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  // Legacy row: no expiry configured (expires_at IS NULL) — e.g. old rows
  // created before expires_at existed / campaign rows without expiry.
  const id = await seedSpin(h, { userId: 'u_legacy', expiresAt: null, createdDaysAgo: 9 });

  const result = await wheelRepo.consumeSpin({}, 'u_legacy', id);
  assert.equal(result.spin_id, id, 'NULL-expires row must still be consumable');
  const row = await spinRow(h, id);
  assert.equal(row.status, 'used');
  assert.equal(await historyCount(h, id), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Concurrency / repeat semantics: at most one successful claim
// ═══════════════════════════════════════════════════════════════════════════

test('WHEEL-EXPIRED-05: concurrent consumption attempts allow exactly ONE winner', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  const id = await seedSpin(h, { userId: 'u_race', expiresAt: "NOW() + INTERVAL '8 hours'" });

  const outcomes = await Promise.allSettled([
    wheelRepo.consumeSpin({}, 'u_race', id),
    wheelRepo.consumeSpin({}, 'u_race', id),
    wheelRepo.consumeSpin({}, 'u_race', id),
  ]);

  const wins = outcomes.filter(o => o.status === 'fulfilled');
  const losses = outcomes.filter(o => o.status === 'rejected');
  assert.equal(wins.length, 1, `exactly one concurrent claim must win (got ${wins.length})`);
  assert.equal(losses.length, 2, 'the other concurrent claims must be rejected');
  for (const o of losses) {
    assert.ok(isSpinNotAvailable(o.reason), `loser must fail with SPIN_NOT_AVAILABLE, got: ${o.reason && o.reason.message}`);
  }
  assert.equal(await historyCount(h, id), 1, 'exactly one reward record — no double reward');
  const row = await spinRow(h, id);
  assert.equal(row.status, 'used');
});

test('WHEEL-EXPIRED-06: repeated sequential attempts cannot double-consume', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  const id = await seedSpin(h, { userId: 'u_seq', expiresAt: "NOW() + INTERVAL '8 hours'" });

  await wheelRepo.consumeSpin({}, 'u_seq', id); // first — succeeds
  await assert.rejects(
    () => wheelRepo.consumeSpin({}, 'u_seq', id), // second — must fail
    isSpinNotAvailable,
    'second sequential consume must be rejected (status guard)',
  );
  assert.equal(await historyCount(h, id), 1);
});

// ═══════════════════════════════════════════════════════════════════════════
// Existing authorization / ownership guards remain enforced
// ═══════════════════════════════════════════════════════════════════════════

test('WHEEL-EXPIRED-08: ownership guard — another user cannot consume the spin', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  const id = await seedSpin(h, { userId: 'u_owner', expiresAt: "NOW() + INTERVAL '8 hours'" });

  await assert.rejects(
    () => wheelRepo.consumeSpin({}, 'u_attacker', id),
    isSpinNotAvailable,
    'spin belonging to another user must be rejected (user_id guard)',
  );
  await assertNotAvailable(h, id);
});

test('WHEEL-EXPIRED-09: state guard — an already-used spin cannot be re-consumed', async () => {
  const { h, wheelRepo } = makeStack();
  await seedReward(h);
  const id = await seedSpin(h, { userId: 'u_used', status: 'used', expiresAt: "NOW() + INTERVAL '8 hours'" });

  await assert.rejects(
    () => wheelRepo.consumeSpin({}, 'u_used', id),
    isSpinNotAvailable,
    'used spin must be rejected (status guard)',
  );
  assert.equal(await historyCount(h, id), 0, 'no new history for an already-used spin');
});

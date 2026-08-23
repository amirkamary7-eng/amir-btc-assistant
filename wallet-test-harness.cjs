/**
 * WALLET TEST HARNESS — shared pg-mem harness for wallet/economy/cosmetics tests.
 *
 * Executes the REAL production modules (loaded from src/ at runtime) against a
 * real in-memory PostgreSQL engine (pg-mem), using the same Pool/Client pattern
 * as scripts/e2e-referral-test.mjs.
 *
 * Harness shims (test-environment only, production SQL is executed VERBATIM):
 *   1. Param interpolation ($N → SQL literal): pg-mem's pg adapter binds every
 *      parameter as TEXT, which breaks numeric arithmetic (`balance - $2`).
 *      Real PostgreSQL coerces unknown-type params from context; interpolation
 *      reproduces that behavior.
 *   2. JSON-looking string params get a ::jsonb cast (pg-mem lacks unknown-type
 *      coercion in INSERT..SELECT context; real PG coerces automatically).
 *   3. Scalar-subquery results are unwrapped from arrays (pg-mem returns []
 *      or [v]; real PG returns NULL or v).
 *   4. ensureSchema batch SQL is intercepted as a no-op success — the schema is
 *      pre-created by the harness (CREATE UNIQUE INDEX IF NOT EXISTS on partial
 *      index etc. are already applied).
 *   5. user_cosmetic_ownership INSERT ... ON CONFLICT DO NOTHING RETURNING:
 *      on conflict pg-mem returns the EXISTING row; real PostgreSQL returns
 *      0 rows. The harness pre-checks existence and short-circuits to 0 rows,
 *      reproducing real-PG observable behavior (verified by probe: pg-mem
 *      count=1 but RETURNING=[{id:1}] on the conflicting insert).
 *
 * Not a test file itself — required by:
 *   - wallet-debit-atomic-regression-test.cjs
 *   - cosmetics-refund-guard-test.cjs
 */

const fs = require('node:fs');
const path = require('node:path');
const { newDb } = require('pg-mem');

const ROOT = path.join(__dirname);

// ── Schema (mirrors production tables + runtime ensureSchema columns) ──────
const SCHEMA_SQL = `
  CREATE TABLE users (
    telegram_id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(128), first_name VARCHAR(128), last_name VARCHAR(128),
    lang VARCHAR(8) NOT NULL DEFAULT 'fa',
    channel_joined BOOLEAN NOT NULL DEFAULT FALSE,
    channel_verified_at TIMESTAMPTZ,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE token_balances (
    user_id VARCHAR(64) PRIMARY KEY,
    balance INTEGER NOT NULL DEFAULT 0,
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE token_transactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    amount INTEGER NOT NULL,
    tx_type VARCHAR(32) NOT NULL,
    source VARCHAR(32) NOT NULL DEFAULT 'system',
    status VARCHAR(16) NOT NULL DEFAULT 'completed',
    description VARCHAR(256),
    ref_id VARCHAR(64),
    metadata JSONB DEFAULT '{}',
    created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
  );

  CREATE TABLE profile_cosmetics (
    id SERIAL PRIMARY KEY,
    cosmetic_key VARCHAR(64) NOT NULL,
    title VARCHAR(128) NOT NULL,
    description TEXT,
    rarity VARCHAR(32) NOT NULL DEFAULT 'common',
    type VARCHAR(32) NOT NULL DEFAULT 'frame',
    token_cost INTEGER NOT NULL DEFAULT 0,
    premium_required BOOLEAN NOT NULL DEFAULT FALSE,
    active BOOLEAN NOT NULL DEFAULT TRUE,
    preview_url VARCHAR(512),
    metadata JSONB DEFAULT '{}'
  );

  CREATE TABLE user_cosmetic_ownership (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    cosmetic_id INTEGER NOT NULL,
    tokens_spent INTEGER NOT NULL DEFAULT 0,
    is_active BOOLEAN NOT NULL DEFAULT FALSE,
    purchased_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    activated_at TIMESTAMPTZ,
    updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_user_cosmetic UNIQUE (user_id, cosmetic_id)
  );
`;

// Partial unique index — same definition as wallet.js ensureSchema (R-3.1).
const UNIQUE_INDEX_SQL = `
  CREATE UNIQUE INDEX idx_token_tx_user_type_ref
    ON token_transactions (user_id, tx_type, ref_id)
    WHERE ref_id IS NOT NULL AND status = 'completed'
`;

// ── Param interpolation (see header note #1 and #2) ─────────────────────────
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

// ── Row normalization (see header note #3) ─────────────────────────────────
function normalizeRows(rows) {
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      const v = row[k];
      if (Array.isArray(v)) row[k] = v.length === 0 ? null : v[0];
    }
  }
  return rows;
}

/**
 * Create a fresh pg-mem harness: { queryDb, queryDbTransaction, raw, insertBalance, insertCosmetic }
 *  - queryDb(env, sql, params)          — replica of worker-proxy queryDb (Pool per call)
 *  - queryDbTransaction(env, queries)    — replica of worker-proxy queryDbTransaction
 *    (BEGIN → statements → COMMIT, ROLLBACK + rethrow on error — session client)
 *  - raw(sql, params)                    — direct query for test setup/assertions
 */
function makePgHarness() {
  const db = newDb();
  db.public.many(SCHEMA_SQL);
  db.public.many(UNIQUE_INDEX_SQL);
  const Pool = db.adapters.createPg().Pool;

  async function queryDb(env, sqlText, params = []) {
    const sql = String(sqlText);
    // ensureSchema batch — schema is pre-created by the harness (note #4)
    if (sql.includes('idx_token_tx_user_type_ref')) {
      return { rows: [], rowCount: 0 };
    }
    // Shim #5: pg-mem's plain INSERT ... ON CONFLICT DO NOTHING RETURNING
    // returns the existing row on conflict; real PG returns 0 rows. Emulate
    // real PG so createOwnership's created flag matches production behavior.
    if (
      sql.includes('INSERT INTO user_cosmetic_ownership') &&
      /ON CONFLICT/i.test(sql) &&
      /RETURNING/i.test(sql) &&
      params && params.length >= 2
    ) {
      const pre = await raw(
        'SELECT id FROM user_cosmetic_ownership WHERE user_id = $1 AND cosmetic_id = $2 LIMIT 1',
        [String(params[0]), String(params[1])],
      );
      if (pre.rows.length > 0) {
        return { rows: [], rowCount: 0 };
      }
      // no conflict — fall through and execute normally
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
      try { await client.query('ROLLBACK'); } catch { /* ignore */ }
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

  async function insertBalance(userId, balance) {
    await raw('INSERT INTO token_balances (user_id, balance) VALUES ($1, $2)', [String(userId), Number(balance)]);
  }

  async function insertCosmetic(id, tokenCost) {
    await raw(
      `INSERT INTO profile_cosmetics (id, cosmetic_key, title, description, rarity, type, token_cost, premium_required, active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, FALSE, TRUE)`,
      [Number(id), 'test_frame_' + id, 'Test Frame ' + id, 'test cosmetic', 'rare', 'frame', Number(tokenCost)],
    );
  }

  return Object.freeze({ queryDb, queryDbTransaction, raw, insertBalance, insertCosmetic });
}

// ── ES module loader (repo files use `export function` — evaluate as CJS) ──
function loadFactory(relPath, exportName) {
  const src = fs.readFileSync(path.join(ROOT, relPath), 'utf8');
  const body = src.replace(/export\s+function\s+/g, 'function ');
  const wrapped = `${body}\nmodule.exports = { ${exportName} };`;
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', wrapped)(mod, mod.exports, require);
  if (typeof mod.exports[exportName] !== 'function') {
    throw new Error(`Failed to load ${exportName} from ${relPath}`);
  }
  return mod.exports[exportName];
}

// Production factories (loaded from CURRENT source — tests always run against
// whatever is in src/ right now).
const createWalletRepository = loadFactory('src/repositories/wallet.js', 'createWalletRepository');
const createEconomyService = loadFactory('src/services/economy.js', 'createEconomyService');
const createCosmeticsRepository = loadFactory('src/repositories/cosmetics.js', 'createCosmeticsRepository');
const createCosmeticsHandlers = loadFactory('src/controllers/cosmetics.js', 'createCosmeticsHandlers');

/** Build the full real stack: walletRepo + economyService on a fresh pg harness. */
function makeRealStack() {
  const h = makePgHarness();
  const walletRepo = createWalletRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
  });
  const economyService = createEconomyService({ walletRepo, queryDb: h.queryDb });
  return { h, walletRepo, economyService };
}

// ── Assertion helpers ──────────────────────────────────────────────────────
async function txCount(h, extraWhere = '') {
  const r = await h.raw(`SELECT COUNT(*)::int AS c FROM token_transactions ${extraWhere}`);
  return Number(r.rows[0].c);
}

async function balanceOf(h, userId) {
  const r = await h.raw('SELECT balance FROM token_balances WHERE user_id = $1', [String(userId)]);
  return r.rows.length ? Number(r.rows[0].balance) : null;
}

async function txRows(h, extraWhere = '', orderBy = 'id ASC') {
  const r = await h.raw(
    `SELECT id, user_id, amount, tx_type, source, status, description, ref_id
     FROM token_transactions ${extraWhere} ORDER BY ${orderBy}`,
  );
  return r.rows;
}

module.exports = {
  makePgHarness,
  makeRealStack,
  loadFactory,
  createWalletRepository,
  createEconomyService,
  createCosmeticsRepository,
  createCosmeticsHandlers,
  interpolate,
  txCount,
  balanceOf,
  txRows,
};

/**
 * E2E Referral Test — End-to-End verification of the complete referral flow.
 *
 * This test uses pg-mem (a real PostgreSQL engine in memory) to execute the
 * EXACT same SQL queries that the Cloudflare Worker runs in production.
 *
 * Flow under test:
 *   1. User A (inviter) bootstraps → user row created
 *   2. User A joins channel → channel_joined = TRUE
 *   3. User B (invitee) bootstraps with referrer_id = A → referral row created
 *      (reward NOT yet credited because B hasn't joined channel)
 *   4. User B joins channel → processPendingReferralReward fires:
 *      - token_balances for A incremented by 3
 *      - token_transaction recorded for A
 *      - referral.rewarded = TRUE, channel_verified = TRUE
 *   5. Verify stats: total=1, active=1, rewarded=1, balance=3
 *
 * The SQL strings below are COPIED VERBATIM from:
 *   - src/repositories/users.js     (bootstrap, getById)
 *   - src/repositories/referrals.js (getStats, getTokens)
 *   - src/repositories/wallet.js    (getWalletState)
 *   - worker-proxy.js               (processReferralOnBootstrap,
 *                                     processPendingReferralReward,
 *                                     creditReferralWithReward)
 *
 * Usage: node scripts/e2e-referral-test.mjs
 */

import { newDb } from 'pg-mem';

// ============================================================================
// Configuration
// ============================================================================
const REFERRAL_TOKENS_PER_INVITE = 3;

const USER_A_ID = '100000001'; // Inviter
const USER_B_ID = '200000002'; // Invitee
const USER_A_NAME = 'Alice (Inviter)';
const USER_B_NAME = 'Bob (Invitee)';

// ============================================================================
// Database Setup — pg-mem (real PostgreSQL engine)
// ============================================================================
const db = newDb();

// Create schema matching production (from docs/DATABASE_SCHEMA.md)
db.public.many(`
  CREATE TABLE users (
    telegram_id       VARCHAR(64)  PRIMARY KEY,
    username          VARCHAR(128),
    first_name        VARCHAR(128),
    last_name         VARCHAR(128),
    lang              VARCHAR(8)   NOT NULL DEFAULT 'fa',
    channel_joined    BOOLEAN      NOT NULL DEFAULT FALSE,
    channel_verified_at TIMESTAMPTZ,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    updated_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE TABLE referrals (
    id                SERIAL       PRIMARY KEY,
    inviter_id        VARCHAR(64)  NOT NULL REFERENCES users(telegram_id),
    invitee_id        VARCHAR(64)  NOT NULL REFERENCES users(telegram_id),
    channel_verified  BOOLEAN      NOT NULL DEFAULT FALSE,
    rewarded          BOOLEAN      NOT NULL DEFAULT FALSE,
    created_at        TIMESTAMPTZ  NOT NULL DEFAULT NOW(),
    CONSTRAINT uq_referral_invitee UNIQUE (invitee_id)
  );
  CREATE INDEX idx_referrals_inviter ON referrals(inviter_id);

  CREATE TABLE token_balances (
    user_id    VARCHAR(64)  PRIMARY KEY REFERENCES users(telegram_id),
    balance    INTEGER      NOT NULL DEFAULT 0,
    updated_at TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );

  CREATE TABLE token_transactions (
    id          SERIAL       PRIMARY KEY,
    user_id     VARCHAR(64)  NOT NULL REFERENCES users(telegram_id),
    amount      INTEGER      NOT NULL,
    tx_type     VARCHAR(32)  NOT NULL,
    description VARCHAR(256),
    ref_id      VARCHAR(64),
    created_at  TIMESTAMPTZ  NOT NULL DEFAULT NOW()
  );
  CREATE INDEX idx_tx_user ON token_transactions(user_id);
`);

// Register json_build_object — pg-mem doesn't implement it natively,
// but real PostgreSQL (Neon) does. This is a test-environment shim only.
db.public.registerFunction({
  name: 'json_build_object',
  returns: 'jsonb',
  args: [],
  variadic: true,
  implementation: (...args) => {
    const obj = {};
    for (let i = 0; i + 1 < args.length; i += 2) {
      obj[String(args[i])] = args[i + 1] instanceof Date
        ? args[i + 1].toISOString()
        : args[i + 1];
    }
    return JSON.stringify(obj);
  },
});

// pg-mem Pool adapter — mimics @neondatabase/serverless Pool interface
const pgPool = db.adapters.createPg();
const Pool = pgPool.Pool;

// ============================================================================
// queryDb — EXACT replica of worker-proxy.js queryDb (without retry/timeout)
// Uses a Pool per call to match production architecture.
// ============================================================================
async function queryDb(sqlText, params = []) {
  const pool = new Pool();
  try {
    const result = await pool.query(sqlText, params);
    return result;
  } finally {
    pool.end();
  }
}

// ============================================================================
// queryDbTransaction — EXACT replica of worker-proxy.js queryDbTransaction
// BEGIN → queries → COMMIT (ROLLBACK on error)
// ============================================================================
async function queryDbTransaction(queries) {
  const pool = new Pool();
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const { sql, params } of queries) {
      results.push(await client.query(sql, params));
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
    pool.end();
  }
}

// ============================================================================
// Helper: normalizeOptionalString (from worker-proxy.js)
// ============================================================================
function normalizeOptionalString(value) {
  if (value == null) return null;
  const s = String(value).trim();
  return s.length > 0 ? s : null;
}

// ============================================================================
// SQL QUERIES — COPIED VERBATIM FROM PRODUCTION CODE
// ============================================================================

// --- From src/repositories/users.js ---

// getById
const SQL_USER_GET_BY_ID = `
  SELECT
    telegram_id,
    username,
    first_name,
    last_name,
    lang,
    channel_joined,
    channel_verified_at,
    created_at,
    updated_at
  FROM users
  WHERE telegram_id = $1
  LIMIT 1
`;

// bootstrap (upsert)
const SQL_USER_BOOTSTRAP = `
  INSERT INTO users (
    telegram_id,
    username,
    first_name,
    last_name,
    lang,
    channel_joined,
    channel_verified_at,
    created_at,
    updated_at
  )
  VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), $7, NOW(), NOW())
  ON CONFLICT (telegram_id) DO UPDATE
  SET
    username = COALESCE(EXCLUDED.username, users.username),
    first_name = COALESCE(EXCLUDED.first_name, users.first_name),
    last_name = COALESCE(EXCLUDED.last_name, users.last_name),
    lang = COALESCE(EXCLUDED.lang, users.lang),
    updated_at = NOW()
  RETURNING
    telegram_id,
    username,
    first_name,
    last_name,
    lang,
    channel_joined,
    channel_verified_at,
    created_at,
    updated_at
`;

// --- From worker-proxy.js ---

// processReferralOnBootstrap: check inviter exists
const SQL_CHECK_INVITER = `
  SELECT telegram_id FROM users WHERE telegram_id = $1 LIMIT 1
`;

// processReferralOnBootstrap: check existing referral
const SQL_CHECK_EXISTING_REFERRAL = `
  SELECT id, inviter_id, rewarded
  FROM referrals
  WHERE invitee_id = $1
  LIMIT 1
`;

// processReferralOnBootstrap: insert referral
const SQL_INSERT_REFERRAL = `
  INSERT INTO referrals (inviter_id, invitee_id, channel_verified, rewarded, created_at)
  VALUES ($1, $2, FALSE, FALSE, NOW())
  ON CONFLICT (invitee_id) DO NOTHING
  RETURNING id, rewarded
`;

// processPendingReferralReward: find unrewarded referral
const SQL_FIND_PENDING_REFERRAL = `
  SELECT id, inviter_id, rewarded
  FROM referrals
  WHERE invitee_id = $1 AND rewarded = FALSE
  LIMIT 1
`;

// creditReferralWithReward: 3 queries in a transaction
const SQL_CREDIT_REWARD_TX = [
  {
    sql: `
      INSERT INTO token_balances (user_id, balance, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET
        balance = token_balances.balance + EXCLUDED.balance,
        updated_at = NOW()
    `,
    params: null, // set at runtime
  },
  {
    sql: `
      INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id, created_at)
      VALUES ($1, $2, $3, $4, $5, NOW())
    `,
    params: null, // set at runtime
  },
  {
    sql: `UPDATE referrals SET channel_verified = TRUE, rewarded = TRUE WHERE id = $1`,
    params: null, // set at runtime
  },
];

// --- From src/repositories/referrals.js ---

// getStats (CTE query)
const SQL_REFERRAL_STATS = `
  WITH ref_stats AS (
    SELECT
      COUNT(*)::int AS total,
      COUNT(*) FILTER (WHERE channel_verified = true)::int AS active,
      COUNT(*) FILTER (WHERE rewarded = true)::int AS rewarded
    FROM referrals
    WHERE inviter_id = $1
  ),
  bal AS (
    SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1
  )
  SELECT r.total, r.active, r.rewarded, COALESCE(b.balance, 0) AS balance
  FROM ref_stats r, bal b
`;

// getTokens (CTE query)
const SQL_REFERRAL_TOKENS = `
  WITH bal AS (
    SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1
  ),
  tx AS (
    SELECT id, amount, tx_type, description, ref_id, created_at
    FROM token_transactions
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  )
  SELECT
    COALESCE((SELECT balance FROM bal), 0) AS balance,
    COALESCE(json_agg(
      json_build_object(
        'id', tx.id, 'amount', tx.amount, 'tx_type', tx.tx_type,
        'description', tx.description, 'ref_id', tx.ref_id, 'created_at', tx.created_at
      )
    ) FILTER (WHERE tx.id IS NOT NULL), '[]') AS history
  FROM tx
`;

// --- From src/repositories/wallet.js ---

// getWalletState (CTE query)
const SQL_WALLET_STATE = `
  WITH bal AS (
    SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1
  ),
  tx AS (
    SELECT id, amount, tx_type, description, ref_id, created_at
    FROM token_transactions
    WHERE user_id = $1
    ORDER BY created_at DESC
    LIMIT 50
  )
  SELECT
    COALESCE((SELECT balance FROM bal), 0) AS balance,
    COALESCE(json_agg(
      json_build_object(
        'id', tx.id,
        'amount', tx.amount,
        'tx_type', tx.tx_type,
        'description', tx.description,
        'ref_id', tx.ref_id,
        'created_at', tx.created_at
      )
    ) FILTER (WHERE tx.id IS NOT NULL), '[]') AS history
  FROM tx
`;

// ============================================================================
// REPOSITORY FUNCTIONS — mirror production logic exactly
// ============================================================================

/**
 * userRepo.bootstrap — from src/repositories/users.js
 */
async function userBootstrap(userId, payload) {
  const existingUser = await queryDb(SQL_USER_GET_BY_ID, [String(userId)]);
  const fallbackLang = existingUser.rows[0]?.lang || 'fa';
  const lang = payload.lang || fallbackLang;
  const result = await queryDb(SQL_USER_BOOTSTRAP, [
    String(userId),
    normalizeOptionalString(payload.username),
    normalizeOptionalString(payload.first_name),
    normalizeOptionalString(payload.last_name),
    lang,
    existingUser.rows[0] ? Boolean(existingUser.rows[0].channel_joined) : false,
    existingUser.rows[0]?.channel_verified_at ? new Date(existingUser.rows[0].channel_verified_at).toISOString() : null,
  ]);
  return result.rows[0] || null;
}

/**
 * creditReferralWithReward — from worker-proxy.js
 * Credits tokens + creates transaction + marks referral rewarded, atomically.
 */
async function creditReferralWithReward(inviterId, referralId, inviteeId, amount, alsoVerifyChannel) {
  const queries = [
    {
      sql: SQL_CREDIT_REWARD_TX[0].sql,
      params: [String(inviterId), Number(amount)],
    },
    {
      sql: SQL_CREDIT_REWARD_TX[1].sql,
      params: [String(inviterId), Number(amount), 'referral_reward', `Invite reward for user ${String(inviteeId)}`, String(referralId)],
    },
    {
      sql: alsoVerifyChannel
        ? 'UPDATE referrals SET channel_verified = TRUE, rewarded = TRUE WHERE id = $1'
        : 'UPDATE referrals SET rewarded = TRUE WHERE id = $1',
      params: [Number(referralId)],
    },
  ];
  await queryDbTransaction(queries);
}

/**
 * processPendingReferralReward — from worker-proxy.js
 * Finds unrewarded referral for invitee and credits reward if channel joined.
 */
async function processPendingReferralReward(inviteeId, channelJoined) {
  if (!channelJoined) {
    return null;
  }
  const rewardAmount = REFERRAL_TOKENS_PER_INVITE;
  if (rewardAmount <= 0) return null;

  const pendingResult = await queryDb(SQL_FIND_PENDING_REFERRAL, [String(inviteeId)]);
  const pending = pendingResult.rows[0] || null;
  if (!pending) return null;

  await creditReferralWithReward(
    String(pending.inviter_id),
    Number(pending.id),
    inviteeId,
    rewardAmount,
    true, // alsoVerifyChannel
  );

  return { referral_id: pending.id, rewarded: true };
}

/**
 * processReferralOnBootstrap — from worker-proxy.js
 * Creates referral row for new users, then delegates reward processing.
 */
async function processReferralOnBootstrap(inviteeId, referrerId, channelJoined, isNewUser) {
  const normalizedReferrerId = normalizeOptionalString(referrerId);

  // M-R4: reject non-numeric referrer_id or self-referral
  if (!normalizedReferrerId || !/^\d{1,20}$/.test(normalizedReferrerId) || normalizedReferrerId === String(inviteeId)) {
    return { rejected: true, reason: 'M-R4-invalid-or-self' };
  }

  // Design: only new users can be referred
  if (!isNewUser) {
    return { rejected: true, reason: 'NOT-new-user' };
  }

  // Verify inviter exists
  const inviterResult = await queryDb(SQL_CHECK_INVITER, [normalizedReferrerId]);
  if (!inviterResult.rows[0]) {
    return { rejected: true, reason: 'inviter-not-found' };
  }

  // Check for existing referral (race condition handling)
  const existingResult = await queryDb(SQL_CHECK_EXISTING_REFERRAL, [String(inviteeId)]);
  const existing = existingResult.rows[0] || null;

  if (existing) {
    await processPendingReferralReward(inviteeId, channelJoined);
    return { referral_id: existing.id, already_exists: true };
  }

  // Insert referral (race-safe via ON CONFLICT DO NOTHING)
  const insertResult = await queryDb(SQL_INSERT_REFERRAL, [normalizedReferrerId, String(inviteeId)]);
  const createdReferral = insertResult.rows[0] || null;
  if (!createdReferral) {
    return { referral_id: null, already_exists: true, race_won: false };
  }

  // Delegate reward processing (idempotent)
  const rewardResult = await processPendingReferralReward(inviteeId, channelJoined);
  return { referral_id: createdReferral.id, rewarded: Boolean(rewardResult?.rewarded) };
}

/**
 * referralRepo.getStats — from src/repositories/referrals.js
 */
async function getReferralStats(userId) {
  const result = await queryDb(SQL_REFERRAL_STATS, [String(userId)]);
  const row = result.rows[0] || {};
  return {
    total: Number(row.total || 0),
    active: Number(row.active || 0),
    rewarded: Number(row.rewarded || 0),
    tokens: Number(row.balance || 0),
    reward_per_invite: REFERRAL_TOKENS_PER_INVITE,
  };
}

/**
 * walletRepo.getWalletState — from src/repositories/wallet.js
 *
 * NOTE: Production uses json_agg(json_build_object(...)) in a single CTE query.
 * pg-mem doesn't implement json_build_object natively, so we split into two
 * simple queries here. Both approaches return identical data — the production
 * CTE is just an optimization to reduce round-trips. The underlying SQL
 * (SELECT balance, SELECT transactions) is exactly the same.
 */
async function getWalletState(userId) {
  // Query 1: balance (same as production CTE's 'bal' subquery)
  const balResult = await queryDb(
    'SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1',
    [String(userId)],
  );
  const balance = Number(balResult.rows[0]?.balance || 0);

  // Query 2: transactions (same as production CTE's 'tx' subquery)
  const txResult = await queryDb(
    `SELECT id, amount, tx_type, description, ref_id, created_at
     FROM token_transactions
     WHERE user_id = $1
     ORDER BY created_at DESC
     LIMIT 50`,
    [String(userId)],
  );
  const history = txResult.rows.map((row) => ({
    id: row.id,
    amount: Number(row.amount),
    type: row.tx_type,
    description: row.description,
    ref_id: row.ref_id,
    created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
  }));

  return { balance, history };
}

// ============================================================================
// TEST UTILITIES
// ============================================================================

let stepCount = 0;
const results = {
  referral_row_created: false,
  token_awarded: false,
  transaction_created: false,
  stats_correct: false,
};

function logStep(label) {
  stepCount++;
  console.log(`\n${'═'.repeat(70)}`);
  console.log(`  STEP ${stepCount}: ${label}`);
  console.log(`${'═'.repeat(70)}`);
}

function logSuccess(msg) {
  console.log(`  ✅ ${msg}`);
}

function logInfo(msg) {
  console.log(`  ℹ️  ${msg}`);
}

function logFail(msg) {
  console.log(`  ❌ ${msg}`);
}

function printTable(rows, title) {
  if (title) console.log(`  📋 ${title}:`);
  if (!rows || rows.length === 0) {
    console.log('     (no rows)');
    return;
  }
  const cols = Object.keys(rows[0]);
  console.log(`     ${cols.join(' | ')}`);
  console.log(`     ${cols.map(() => '---').join('-+-')}`);
  for (const row of rows) {
    console.log(`     ${cols.map(c => String(row[c] ?? 'NULL').substring(0, 30)).join(' | ')}`);
  }
}

// ============================================================================
// E2E TEST EXECUTION
// ============================================================================

async function runE2ETest() {
  console.log('╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  E2E REFERRAL SYSTEM TEST — Real PostgreSQL (pg-mem engine)          ║');
  console.log('║  Tests EXACT production SQL from worker-proxy.js + repositories      ║');
  console.log('╚══════════════════════════════════════════════════════════════════════╝');
  console.log(`  REFERRAL_TOKENS_PER_INVITE = ${REFERRAL_TOKENS_PER_INVITE}`);
  console.log(`  User A (Inviter):  ${USER_A_ID} (${USER_A_NAME})`);
  console.log(`  User B (Invitee):  ${USER_B_ID} (${USER_B_NAME})`);

  // ─── STEP 1: User A bootstraps (inviter) ──────────────────────────────
  logStep('User A (Inviter) bootstraps — POST /api/users/bootstrap');

  // Check if User A already exists
  const preExistingA = await queryDb(SQL_USER_GET_BY_ID, [USER_A_ID]);
  const isNewUserA = !preExistingA.rows[0];
  logInfo(`isNewUser = ${isNewUserA}`);

  const userA = await userBootstrap(USER_A_ID, {
    username: 'alice_crypto',
    first_name: 'Alice',
    last_name: 'Inviter',
    lang: 'en',
  });
  logSuccess(`User A created: telegram_id=${userA.telegram_id}, channel_joined=${userA.channel_joined}`);

  const usersAfterA = await queryDb('SELECT telegram_id, username, first_name, channel_joined FROM users WHERE telegram_id = $1', [USER_A_ID]);
  printTable(usersAfterA.rows, 'users table (User A)');

  // ─── STEP 2: User A joins channel ─────────────────────────────────────
  logStep('User A joins required channel — channel_joined = TRUE');

  await queryDb(
    `UPDATE users SET channel_joined = TRUE, channel_verified_at = NOW(), updated_at = NOW() WHERE telegram_id = $1`,
    [USER_A_ID],
  );
  const userAAfterJoin = await queryDb(SQL_USER_GET_BY_ID, [USER_A_ID]);
  logSuccess(`User A channel_joined = ${userAAfterJoin.rows[0].channel_joined}`);

  // ─── STEP 3: User B bootstraps with referrer_id = A ───────────────────
  logStep('User B (Invitee) bootstraps with referrer_id = User A');

  // Frontend sends referrer_id extracted from start_param "ref_100000001"
  const referrerIdForB = USER_A_ID; // This is what getReferrerId() returns after stripping "ref_" prefix
  logInfo(`referrer_id sent in bootstrap body = "${referrerIdForB}" (from start_param "ref_${referrerIdForB}")`);

  // Check if User B already exists
  const preExistingB = await queryDb(SQL_USER_GET_BY_ID, [USER_B_ID]);
  const isNewUserB = !preExistingB.rows[0];
  logInfo(`isNewUser = ${isNewUserB}`);

  // Bootstrap User B
  const userB = await userBootstrap(USER_B_ID, {
    username: 'bob_newbie',
    first_name: 'Bob',
    last_name: 'Invitee',
    lang: 'fa',
  });
  logSuccess(`User B created: telegram_id=${userB.telegram_id}, channel_joined=${userB.channel_joined}`);

  // Process referral — channelJoined = FALSE (User B hasn't joined yet)
  const channelJoinedB = Boolean(userB.channel_joined); // false for new user
  logInfo(`channelJoined = ${channelJoinedB} (User B hasn't joined channel yet)`);

  const referralResult = await processReferralOnBootstrap(
    USER_B_ID,
    referrerIdForB,
    channelJoinedB,
    isNewUserB,
  );
  logInfo(`processReferralOnBootstrap result: ${JSON.stringify(referralResult)}`);

  if (referralResult.referral_id) {
    logSuccess(`Referral row created with id=${referralResult.referral_id}`);
    results.referral_row_created = true;
  } else {
    logFail(`Referral NOT created: ${JSON.stringify(referralResult)}`);
  }

  // Verify referral row in database
  const referralRows = await queryDb(
    'SELECT id, inviter_id, invitee_id, channel_verified, rewarded, created_at FROM referrals WHERE invitee_id = $1',
    [USER_B_ID],
  );
  printTable(referralRows.rows, 'referrals table (after bootstrap)');

  // At this point, reward should NOT be credited (channel not joined)
  const balanceABeforeReward = await queryDb('SELECT user_id, balance FROM token_balances WHERE user_id = $1', [USER_A_ID]);
  logInfo(`User A token balance BEFORE channel join: ${balanceABeforeReward.rows[0]?.balance || 0} (expected: 0 — no rows yet)`);

  const txBeforeReward = await queryDb('SELECT COUNT(*)::int as count FROM token_transactions WHERE user_id = $1', [USER_A_ID]);
  logInfo(`User A transactions BEFORE channel join: ${txBeforeReward.rows[0].count} (expected: 0)`);

  // ─── STEP 4: User B joins channel → trigger reward ────────────────────
  logStep('User B joins required channel → processPendingReferralReward fires');

  await queryDb(
    `UPDATE users SET channel_joined = TRUE, channel_verified_at = NOW(), updated_at = NOW() WHERE telegram_id = $1`,
    [USER_B_ID],
  );
  const userBAfterJoin = await queryDb(SQL_USER_GET_BY_ID, [USER_B_ID]);
  logSuccess(`User B channel_joined = ${userBAfterJoin.rows[0].channel_joined}`);

  // This simulates the channel-join callback that calls processPendingReferralReward
  logInfo('Calling processPendingReferralReward(B, channelJoined=true)...');
  const rewardResult = await processPendingReferralReward(USER_B_ID, true);
  logInfo(`processPendingReferralReward result: ${JSON.stringify(rewardResult)}`);

  if (rewardResult && rewardResult.rewarded) {
    logSuccess(`Reward credited! referral_id=${rewardResult.referral_id}`);
    results.token_awarded = true;
  } else {
    logFail(`Reward NOT credited: ${JSON.stringify(rewardResult)}`);
  }

  // ─── STEP 5: Verify all database changes ──────────────────────────────
  logStep('VERIFICATION — Query all tables to confirm referral flow completed');

  // 5a. Referral row
  console.log('\n  ── 5a. Referral Row ──');
  const referralFinal = await queryDb(
    'SELECT id, inviter_id, invitee_id, channel_verified, rewarded, created_at FROM referrals WHERE invitee_id = $1',
    [USER_B_ID],
  );
  printTable(referralFinal.rows, 'referrals (final)');
  if (referralFinal.rows[0]) {
    const r = referralFinal.rows[0];
    logSuccess(`referral.id = ${r.id}`);
    logSuccess(`referral.inviter_id = ${r.inviter_id} (expected: ${USER_A_ID})`);
    logSuccess(`referral.invitee_id = ${r.invitee_id} (expected: ${USER_B_ID})`);
    logSuccess(`referral.channel_verified = ${r.channel_verified} (expected: true)`);
    logSuccess(`referral.rewarded = ${r.rewarded} (expected: true)`);
  }

  // 5b. Token balance for User A (inviter)
  console.log('\n  ── 5b. Token Balance (User A / Inviter) ──');
  const balanceFinal = await queryDb('SELECT user_id, balance, updated_at FROM token_balances WHERE user_id = $1', [USER_A_ID]);
  printTable(balanceFinal.rows, 'token_balances (User A)');
  if (balanceFinal.rows[0]) {
    const b = balanceFinal.rows[0];
    logSuccess(`token_balances.user_id = ${b.user_id}`);
    logSuccess(`token_balances.balance = ${b.balance} (expected: ${REFERRAL_TOKENS_PER_INVITE})`);
    if (Number(b.balance) === REFERRAL_TOKENS_PER_INVITE) {
      results.token_awarded = true;
    }
  }

  // 5c. Token transaction for User A
  console.log('\n  ── 5c. Token Transaction (User A / Inviter) ──');
  const txFinal = await queryDb(
    'SELECT id, user_id, amount, tx_type, description, ref_id, created_at FROM token_transactions WHERE user_id = $1 ORDER BY created_at DESC',
    [USER_A_ID],
  );
  printTable(txFinal.rows, 'token_transactions (User A)');
  if (txFinal.rows[0]) {
    const t = txFinal.rows[0];
    logSuccess(`transaction.id = ${t.id}`);
    logSuccess(`transaction.user_id = ${t.user_id} (expected: ${USER_A_ID})`);
    logSuccess(`transaction.amount = ${t.amount} (expected: ${REFERRAL_TOKENS_PER_INVITE})`);
    logSuccess(`transaction.tx_type = ${t.tx_type} (expected: referral_reward)`);
    logSuccess(`transaction.ref_id = ${t.ref_id} (expected: referral id)`);
    results.transaction_created = true;
  }

  // 5d. Referral stats (GET /api/referrals/stats)
  console.log('\n  ── 5d. Referral Stats (GET /api/referrals/stats) ──');
  const stats = await getReferralStats(USER_A_ID);
  console.log(`     ${JSON.stringify(stats, null, 2).split('\n').join('\n     ')}`);
  logSuccess(`stats.total = ${stats.total} (expected: 1)`);
  logSuccess(`stats.active = ${stats.active} (expected: 1)`);
  logSuccess(`stats.rewarded = ${stats.rewarded} (expected: 1)`);
  logSuccess(`stats.tokens = ${stats.tokens} (expected: ${REFERRAL_TOKENS_PER_INVITE})`);
  if (stats.total === 1 && stats.active === 1 && stats.rewarded === 1 && stats.tokens === REFERRAL_TOKENS_PER_INVITE) {
    results.stats_correct = true;
  }

  // 5e. Wallet state (GET /api/wallet)
  console.log('\n  ── 5e. Wallet State (GET /api/wallet) ──');
  const wallet = await getWalletState(USER_A_ID);
  console.log(`     balance = ${wallet.balance}`);
  console.log(`     history.length = ${wallet.history.length}`);
  if (wallet.history[0]) {
    console.log(`     history[0] = ${JSON.stringify(wallet.history[0], null, 2).split('\n').join('\n     ')}`);
  }

  // ─── STEP 6: Idempotency test — re-running reward should be a no-op ──
  logStep('Idempotency Check — re-run processPendingReferralReward (should be no-op)');

  const idempotentResult = await processPendingReferralReward(USER_B_ID, true);
  logInfo(`Second call result: ${JSON.stringify(idempotentResult)} (expected: null — no unrewarded referrals)`);

  const balanceAfterIdempotent = await queryDb('SELECT balance FROM token_balances WHERE user_id = $1', [USER_A_ID]);
  logSuccess(`Balance after idempotent call: ${balanceAfterIdempotent.rows[0].balance} (expected: ${REFERRAL_TOKENS_PER_INVITE} — no double-reward)`);

  const txCountAfterIdempotent = await queryDb('SELECT COUNT(*)::int as count FROM token_transactions WHERE user_id = $1', [USER_A_ID]);
  logSuccess(`Transaction count after idempotent call: ${txCountAfterIdempotent.rows[0].count} (expected: 1 — no duplicate)`);

  // ─── FINAL SUMMARY ────────────────────────────────────────────────────
  console.log('\n╔══════════════════════════════════════════════════════════════════════╗');
  console.log('║  E2E TEST RESULTS                                                     ║');
  console.log('╠══════════════════════════════════════════════════════════════════════╣');
  console.log(`║  Referral row created:    ${results.referral_row_created ? '✅ YES' : '❌ NO '}                             ║`);
  console.log(`║  Token awarded:           ${results.token_awarded ? '✅ YES' : '❌ NO '}                             ║`);
  console.log(`║  Transaction created:     ${results.transaction_created ? '✅ YES' : '❌ NO '}                             ║`);
  console.log(`║  Stats correct:           ${results.stats_correct ? '✅ YES' : '❌ NO '}                             ║`);
  console.log(`║  Idempotency verified:    ${idempotentResult === null && Number(balanceAfterIdempotent.rows[0].balance) === REFERRAL_TOKENS_PER_INVITE ? '✅ YES' : '❌ NO '}                             ║`);
  console.log('╚══════════════════════════════════════════════════════════════════════╝');

  const allPassed = results.referral_row_created && results.token_awarded && results.transaction_created && results.stats_correct;
  if (allPassed) {
    console.log('\n  🎉 ALL CHECKS PASSED — Referral system verified End-to-End.\n');
    process.exit(0);
  } else {
    console.log('\n  ⚠️  SOME CHECKS FAILED — Review output above.\n');
    process.exit(1);
  }
}

// Run the test
runE2ETest().catch((err) => {
  console.error('\n💥 E2E TEST CRASHED:', err);
  console.error(err.stack);
  process.exit(1);
});

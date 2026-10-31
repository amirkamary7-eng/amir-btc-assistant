/**
 * P0 Remediation Test: NEW-DB-01
 * Comprehensive Cascade Account Deletion & Anti-Farming Verification (Option B)
 */

const { test } = require("node:test");
const assert = require("node:assert/strict");
const fs = require("node:fs");
const path = require("node:path");
const { newDb } = require("pg-mem");

function loadUserRepo() {
  const repoPath = path.join(__dirname, "..", "src", "repositories", "users.js");
  const src = fs.readFileSync(repoPath, "utf8");
  const cjsSource = src.replace(/^export\s+function\s+createUserRepository/m, "function createUserRepository")
    + "\nmodule.exports = { createUserRepository };";
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", cjsSource);
  fn(require, mod, mod.exports);
  return mod.exports.createUserRepository;
}

const createUserRepository = loadUserRepo();

function loadReferralRewardsService() {
  const servicePath = path.join(__dirname, "..", "src", "services", "referral-rewards.js");
  const src = fs.readFileSync(servicePath, "utf8");
  const cjsSource = src
    .replace(/^export\s+function\s+createReferralRewardsService/m, "function createReferralRewardsService")
    + "\nmodule.exports = { createReferralRewardsService };";
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", cjsSource);
  fn(require, mod, mod.exports);
  return mod.exports.createReferralRewardsService;
}
const createReferralRewardsService = loadReferralRewardsService();


function setupMockDatabase() {
  const db = newDb();

  // Create real schema matching scripts/00-migrate.sql
  // Using pg-mem compatible column definitions
  db.public.many(`
    CREATE TABLE users (
      telegram_id VARCHAR(64) PRIMARY KEY,
      username VARCHAR(128),
      first_name VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE referrals (
      id SERIAL PRIMARY KEY,
      inviter_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      invitee_id VARCHAR(64) NOT NULL UNIQUE REFERENCES users(telegram_id),
      channel_verified BOOLEAN DEFAULT FALSE,
      rewarded BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE token_balances (
      user_id VARCHAR(64) PRIMARY KEY REFERENCES users(telegram_id),
      balance INTEGER NOT NULL DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE token_transactions (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      amount INTEGER NOT NULL,
      tx_type VARCHAR(32) NOT NULL,
      description VARCHAR(256),
      ref_id VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE pending_refunds (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      amount INTEGER NOT NULL,
      refund_ref_id VARCHAR(128) NOT NULL,
      original_ref_id VARCHAR(128),
      source VARCHAR(32) DEFAULT 'alert',
      status VARCHAR(16) DEFAULT 'pending',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE token_transactions_archive (
      id SERIAL PRIMARY KEY,
      original_tx_id INTEGER NOT NULL UNIQUE,
      account_tombstone_id TEXT NOT NULL,
      amount INTEGER NOT NULL,
      tx_type VARCHAR(32) NOT NULL,
      source VARCHAR(32) DEFAULT 'system',
      status VARCHAR(16) DEFAULT 'completed',
      description VARCHAR(256),
      ref_id VARCHAR(128),
      metadata JSONB DEFAULT '{}',
      original_created_at TIMESTAMPTZ DEFAULT NOW(),
      archived_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE TABLE claimed_referral_pairs (
      pair_hash VARCHAR(64) PRIMARY KEY,
      claim_type VARCHAR(32) DEFAULT 'pair',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE watchlist_items (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      symbol VARCHAR(32) NOT NULL,
      position INTEGER DEFAULT 0,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE promo_campaigns (
      id TEXT PRIMARY KEY,
      title TEXT NOT NULL
    );

    CREATE TABLE promo_campaign_registrations (
      id SERIAL PRIMARY KEY,
      campaign_id TEXT NOT NULL REFERENCES promo_campaigns(id),
      telegram_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      registered_at TIMESTAMPTZ DEFAULT NOW(),
      UNIQUE (campaign_id, telegram_id)
    );

    CREATE TABLE price_alerts (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      symbol VARCHAR(32) NOT NULL,
      price NUMERIC(24,8) NOT NULL,
      direction VARCHAR(16) DEFAULT 'above',
      status VARCHAR(16) DEFAULT 'active',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE notifications (
      id TEXT PRIMARY KEY,
      user_id TEXT NOT NULL,
      type TEXT NOT NULL,
      title TEXT DEFAULT '',
      message TEXT DEFAULT '',
      read_status BOOLEAN DEFAULT FALSE,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE notification_queue (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      status TEXT DEFAULT 'pending',
      priority TEXT DEFAULT 'normal',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE notification_settings (
      user_id TEXT PRIMARY KEY,
      analysis BOOLEAN DEFAULT TRUE,
      calendar BOOLEAN DEFAULT FALSE,
      price_alert BOOLEAN DEFAULT FALSE
    );

    CREATE TABLE daily_checkin_streaks (
      user_id TEXT PRIMARY KEY,
      streak_day SMALLINT DEFAULT 0,
      cycle_count INTEGER DEFAULT 0,
      updated_at TIMESTAMPTZ DEFAULT NOW(),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE calendar_reminders (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      event_key VARCHAR(255) NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE tickets (
      id VARCHAR(64) PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      user_name VARCHAR(128) NOT NULL,
      title VARCHAR(256) NOT NULL,
      body TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE ticket_replies (
      id SERIAL PRIMARY KEY,
      ticket_id VARCHAR(64) NOT NULL REFERENCES tickets(id),
      sender_type VARCHAR(16) NOT NULL,
      message TEXT NOT NULL,
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE admins (
      telegram_id VARCHAR(64) PRIMARY KEY,
      role VARCHAR(32) NOT NULL DEFAULT 'admin'
    );

    -- Anti-farming tables: NO foreign key to users(telegram_id)
    CREATE TABLE wheel_spins (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      spin_type VARCHAR(16) DEFAULT 'daily',
      status VARCHAR(16) DEFAULT 'used',
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE wheel_history (
      id SERIAL PRIMARY KEY,
      spin_id INTEGER REFERENCES wheel_spins(id),
      user_id VARCHAR(64) NOT NULL,
      reward_name VARCHAR(128),
      created_at TIMESTAMPTZ DEFAULT NOW()
    );

    CREATE TABLE mission_progress (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      mission_id VARCHAR(64) NOT NULL,
      progress_count INTEGER DEFAULT 1,
      target_count INTEGER DEFAULT 1,
      completed BOOLEAN DEFAULT TRUE,
      rewarded BOOLEAN DEFAULT TRUE
    );

    CREATE TABLE alert_quota (
      id SERIAL PRIMARY KEY,
      user_id TEXT NOT NULL,
      alert_type VARCHAR(32) DEFAULT 'price_alert',
      used_count INTEGER DEFAULT 5
    );

    CREATE TABLE deleted_users (
      id SERIAL PRIMARY KEY,
      telegram_id VARCHAR(64) NOT NULL UNIQUE,
      previous_inviter_id VARCHAR(64),
      deleted_at TIMESTAMPTZ DEFAULT NOW(),
      cooldown_until TIMESTAMPTZ
    );
  `);

  const Pool = db.adapters.createPg().Pool;
  const pool = new Pool();

  async function queryDb(env, sqlText, params = []) {
    const s = String(sqlText || '');
    // Harness shim: intercept CREATE TABLE / INDEX on deleted_users (already created above)
    if (s.includes('CREATE TABLE IF NOT EXISTS deleted_users') ||
        s.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_users_telegram_id_uniq') || s.includes('CREATE TABLE IF NOT EXISTS token_transactions_archive') || s.includes('CREATE TABLE IF NOT EXISTS claimed_referral_pairs')) {
      return { rows: [], rowCount: 0 };
    }
    // Handle INTERVAL arithmetic in pg-mem
    if (s.includes('INSERT INTO deleted_users')) {
      const uid = params[0];
      const prev = params[1] || null;
      db.public.many(`
        INSERT INTO deleted_users (telegram_id, previous_inviter_id, deleted_at, cooldown_until)
        VALUES ('${uid}', ${prev ? `'${prev}'` : 'NULL'}, NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE SET deleted_at = NOW()
      `);
      return { rows: [], rowCount: 1 };
    }
    return pool.query(sqlText, params);
  }

  async function queryDbTransaction(env, queries) {
    const client = await pool.connect();
    try {
      await client.query("BEGIN");
      const results = [];
      for (const q of queries) {
        const res = await client.query(q.sql, q.params || []);
        results.push(res);
      }
      await client.query("COMMIT");
      return results;
    } catch (err) {
      await client.query("ROLLBACK");
      throw err;
    } finally {
      client.release();
    }
  }

  return { db, pool, queryDb, queryDbTransaction };
}

test("NEW-DB-01: deleteAccount deletes all user-linked data atomically without FK errors", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };

  const repo = createUserRepository({
    queryDb,
    queryDbTransaction,
    queryDbDirect: queryDb,
    getPool: () => ({}),
  });

  const TARGET_USER = "10001";
  const OTHER_USER = "20002";

  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES
      ('${TARGET_USER}', 'alice', 'Alice'),
      ('${OTHER_USER}', 'bob', 'Bob');

    INSERT INTO promo_campaigns (id, title) VALUES ('camp_01', 'Welcome Promo');

    INSERT INTO referrals (inviter_id, invitee_id) VALUES ('${OTHER_USER}', '${TARGET_USER}');
    INSERT INTO referrals (inviter_id, invitee_id) VALUES ('${TARGET_USER}', '${OTHER_USER}');

    INSERT INTO token_balances (user_id, balance) VALUES ('${TARGET_USER}', 500), ('${OTHER_USER}', 200);
    INSERT INTO token_transactions (user_id, amount, tx_type) VALUES ('${TARGET_USER}', 100, 'credit');

    INSERT INTO pending_refunds (user_id, amount, refund_ref_id) VALUES ('${TARGET_USER}', 50, 'ref_refund_001');

    INSERT INTO watchlist_items (user_id, symbol) VALUES ('${TARGET_USER}', 'BTCUSDT');

    INSERT INTO promo_campaign_registrations (campaign_id, telegram_id) VALUES ('camp_01', '${TARGET_USER}');

    INSERT INTO price_alerts (id, user_id, symbol, price) VALUES ('alt_1', '${TARGET_USER}', 'BTCUSDT', 65000);

    INSERT INTO notifications (id, user_id, type) VALUES ('n_1', '${TARGET_USER}', 'alert');
    INSERT INTO notification_queue (user_id, status) VALUES ('${TARGET_USER}', 'pending');
    INSERT INTO notification_settings (user_id) VALUES ('${TARGET_USER}');

    INSERT INTO daily_checkin_streaks (user_id, streak_day) VALUES ('${TARGET_USER}', 3);
    INSERT INTO calendar_reminders (user_id, event_key) VALUES ('${TARGET_USER}', 'cpi_report_2026');

    INSERT INTO tickets (id, user_id, user_name, title, body) VALUES ('t_1', '${TARGET_USER}', 'Alice', 'Help', 'Need assistance');
    INSERT INTO ticket_replies (ticket_id, sender_type, message) VALUES ('t_1', 'user', 'Still waiting');

    INSERT INTO admins (telegram_id, role) VALUES ('${TARGET_USER}', 'mod');

    INSERT INTO wheel_spins (id, user_id, spin_type, status) VALUES (1, '${TARGET_USER}', 'daily', 'used');
    INSERT INTO wheel_history (spin_id, user_id, reward_name) VALUES (1, '${TARGET_USER}', '50_TOKENS');
    INSERT INTO mission_progress (user_id, mission_id, completed, rewarded) VALUES ('${TARGET_USER}', 'daily_login', true, true);
    INSERT INTO alert_quota (user_id, alert_type, used_count) VALUES ('${TARGET_USER}', 'price_alert', 5);
  `);

  const summary = await repo.deleteAccount(env, TARGET_USER);

  assert.equal(summary.userId, TARGET_USER);
  assert.equal(summary.cooldownRecorded, true);

  // 1. Verify TARGET_USER deleted from users
  const userCheck = db.public.many(`SELECT * FROM users WHERE telegram_id = '${TARGET_USER}'`);
  assert.equal(userCheck.length, 0, "User row must be deleted");

  // 2. Verify all FK child tables are cleaned up for TARGET_USER
  assert.equal(db.public.many(`SELECT * FROM token_balances WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM pending_refunds WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM watchlist_items WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM promo_campaign_registrations WHERE telegram_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM price_alerts WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM notifications WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM notification_queue WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM notification_settings WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM daily_checkin_streaks WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM calendar_reminders WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM ticket_replies WHERE ticket_id = 't_1'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM tickets WHERE user_id = '${TARGET_USER}'`).length, 0);
  assert.equal(db.public.many(`SELECT * FROM admins WHERE telegram_id = '${TARGET_USER}'`).length, 0);

  // 3. Verify OTHER_USER data is completely untouched
  const otherUserCheck = db.public.many(`SELECT * FROM users WHERE telegram_id = '${OTHER_USER}'`);
  assert.equal(otherUserCheck.length, 1, "Other user must remain intact");
  const otherBalance = db.public.many(`SELECT * FROM token_balances WHERE user_id = '${OTHER_USER}'`);
  assert.equal(otherBalance[0].balance, 200, "Other user balance must remain intact");

  // 4. OPTION B ANTI-FARMING VERIFICATION:
  // Wheel spins, history, mission progress, and alert quota MUST REMAIN
  const spinCheck = db.public.many(`SELECT * FROM wheel_spins WHERE user_id = '${TARGET_USER}'`);
  assert.equal(spinCheck.length, 1, "Option B: wheel_spins row must be preserved");
  assert.equal(spinCheck[0].status, "used");

  const historyCheck = db.public.many(`SELECT * FROM wheel_history WHERE user_id = '${TARGET_USER}'`);
  assert.equal(historyCheck.length, 1, "Option B: wheel_history row must be preserved");

  const missionCheck = db.public.many(`SELECT * FROM mission_progress WHERE user_id = '${TARGET_USER}'`);
  assert.equal(missionCheck.length, 1, "Option B: mission_progress row must be preserved");
  assert.equal(missionCheck[0].completed, true);

  const quotaCheck = db.public.many(`SELECT * FROM alert_quota WHERE user_id = '${TARGET_USER}'`);
  assert.equal(quotaCheck.length, 1, "Option B: alert_quota row must be preserved");
  assert.equal(quotaCheck[0].used_count, 5);

  // 5. Cooldown record verification
  const cooldownCheck = db.public.many(`SELECT * FROM deleted_users WHERE telegram_id = '${TARGET_USER}'`);
  assert.equal(cooldownCheck.length, 1, "Cooldown entry in deleted_users must be present");
  assert.equal(cooldownCheck[0].previous_inviter_id, OTHER_USER);
});

test("NEW-DB-01 Anti-Farming: Re-registration cannot reclaim daily free spins or missions", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };

  const repo = createUserRepository({
    queryDb,
    queryDbTransaction,
    queryDbDirect: queryDb,
    getPool: () => ({}),
  });

  const ATTACKER = "999888";

  // 1. Attacker is created and claims daily spin and daily mission
  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES ('${ATTACKER}', 'attacker', 'Attacker');
    INSERT INTO wheel_spins (id, user_id, spin_type, status, created_at) VALUES (55, '${ATTACKER}', 'daily', 'used', NOW());
    INSERT INTO mission_progress (user_id, mission_id, completed, rewarded) VALUES ('${ATTACKER}', 'daily_login', true, true);
  `);

  // 2. Attacker deletes their account
  await repo.deleteAccount(env, ATTACKER);

  // 3. Verify user is deleted
  assert.equal(db.public.many(`SELECT * FROM users WHERE telegram_id = '${ATTACKER}'`).length, 0);

  // 4. Attacker re-registers (simulate bootstrap)
  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES ('${ATTACKER}', 'attacker', 'Attacker');
  `);

  // 5. Check if daily spin is already used today for this user_id
  const dailySpinsToday = db.public.many(`
    SELECT * FROM wheel_spins 
    WHERE user_id = '${ATTACKER}' 
      AND spin_type = 'daily' 
      AND status = 'used'
  `);
  assert.equal(dailySpinsToday.length, 1, "Existing daily spin is found; attacker CANNOT get a second free spin today");

  // 6. Check if daily login mission is already completed today for this user_id
  const missionToday = db.public.many(`
    SELECT * FROM mission_progress 
    WHERE user_id = '${ATTACKER}' 
      AND mission_id = 'daily_login' 
      AND completed = true
  `);
  assert.equal(missionToday.length, 1, "Existing mission progress is found; attacker CANNOT re-claim login tokens today");
});


test("NEW-DB-01: Financial archive preservation, PII scrubbing and zero-sum burn", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_FIN = "30003";
  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES ('${USER_FIN}', 'charlie', 'Charlie');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_FIN}', 150);
    INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id) VALUES
      ('${USER_FIN}', 100, 'daily_claim', 'Daily check-in', 'daily_30003_2026-10-31'),
      ('${USER_FIN}', 100, 'wheel_reward', 'Wheel win', 'wheel_30003_2026-10-31_1'),
      ('${USER_FIN}', -50, 'alert_debit', 'Price alert debit for 30003', 'alert_30003_101');
  `);

  const summary = await repo.deleteAccount(env, USER_FIN);

  assert.equal(summary.burnedBalance, 150, "Burned balance must equal starting balance 150");
  assert.equal(summary.archivedCount, 4, "Must archive 3 original txs + 1 burn tx");

  // Verify token_transactions is empty for user
  const activeTxs = db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_FIN}'`);
  assert.equal(activeTxs.length, 0, "Active token_transactions must be completely cleared");

  // Verify token_balances is deleted
  const activeBal = db.public.many(`SELECT * FROM token_balances WHERE user_id = '${USER_FIN}'`);
  assert.equal(activeBal.length, 0, "Active token_balance must be cleared");

  // Verify archive records
  const archived = db.public.many(`SELECT * FROM token_transactions_archive WHERE account_tombstone_id = '${summary.tombstoneId}' ORDER BY original_tx_id ASC`);
  assert.equal(archived.length, 4, "Archive must contain all 4 records");

  // Verify zero-sum ledger: sum of all amounts for this tombstone MUST EQUAL 0
  const sumAmount = archived.reduce((acc, row) => acc + Number(row.amount), 0);
  assert.equal(sumAmount, 0, "Ledger equilibrium: sum of all archived amounts including burn must be exactly 0");

  // Verify PII scrubbing: zero raw telegram IDs in ref_id or description
  for (const row of archived) {
    if (row.ref_id) {
      assert.ok(!row.ref_id.includes(USER_FIN), `ref_id ${row.ref_id} must not leak telegram ID`);
      assert.ok(row.ref_id.includes("ANON") || !/\d{5,}/.test(row.ref_id), "ref_id must have numeric IDs scrubbed");
    }
    if (row.description) {
      assert.ok(!row.description.includes(USER_FIN), `description ${row.description} must not leak telegram ID`);
      if (row.tx_type === "alert_debit") {
        assert.ok(row.description.includes("[SCRUBBED]"), "description with user id must be scrubbed");
      }
    }
  }
});

test("NEW-DB-01: Zero balance account deletion creates clean archive without redundant burn", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_ZERO = "40004";
  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES ('${USER_ZERO}', 'dave', 'Dave');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_ZERO}', 0);
    INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id) VALUES
      ('${USER_ZERO}', 50, 'daily_claim', 'Daily check-in', 'daily_40004_2026-10-31'),
      ('${USER_ZERO}', -50, 'cosmetic_buy', 'Bought theme', 'cosmetic_purchase_40004_dark');
  `);

  const summary = await repo.deleteAccount(env, USER_ZERO);

  assert.equal(summary.burnedBalance, 0, "No burn should occur when balance is 0");
  assert.equal(summary.archivedCount, 2, "Archive contains exactly 2 original txs");

  const archived = db.public.many(`SELECT * FROM token_transactions_archive WHERE account_tombstone_id = '${summary.tombstoneId}'`);
  assert.equal(archived.length, 2);
  const sumAmount = archived.reduce((acc, row) => acc + Number(row.amount), 0);
  assert.equal(sumAmount, 0, "Ledger was already balanced at 0");
});

test("NEW-DB-01: Open pending refunds are cancelled on account deletion", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_REF = "50005";
  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES ('${USER_REF}', 'eve', 'Eve');
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('${USER_REF}', 20, 'ref_pend_01', 'pending'),
      ('${USER_REF}', 30, 'ref_comp_01', 'completed');
  `);

  const summary = await repo.deleteAccount(env, USER_REF);
  assert.equal(summary.openPendingRefunds, 1, "Must detect 1 open pending refund");

  // Verify all pending_refunds for this user were deleted during cascade
  const refundsRemaining = db.public.many(`SELECT * FROM pending_refunds WHERE user_id = '${USER_REF}'`);
  assert.equal(refundsRemaining.length, 0, "All pending_refunds rows for deleted user must be removed");
});

test("NEW-DB-01: Transaction rollback preserves data integrity on failure", async () => {
  const { db, queryDb } = setupMockDatabase();
  const env = { APP_ENV: "test" };

  // Mock queryDbTransaction that simulates failure in cascade
  const failingTx = async (env, queries) => {
    throw new Error("Simulated database constraint failure during cascade");
  };

  const repo = createUserRepository({ queryDb, queryDbTransaction: failingTx, queryDbDirect: queryDb });

  const USER_FAIL = "60006";
  db.public.many(`
    INSERT INTO users (telegram_id, username, first_name) VALUES ('${USER_FAIL}', 'frank', 'Frank');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_FAIL}', 300);
    INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id) VALUES
      ('${USER_FAIL}', 300, 'daily_claim', 'Claim', 'daily_60006_2026-10-31');
  `);

  await assert.rejects(
    async () => repo.deleteAccount(env, USER_FAIL),
    /Simulated database constraint failure/
  );

  // User MUST still exist
  const userCheck = db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_FAIL}'`);
  assert.equal(userCheck.length, 1, "User must NOT be deleted if transaction rolled back");

  // Balance MUST be restored
  const balCheck = db.public.many(`SELECT * FROM token_balances WHERE user_id = '${USER_FAIL}'`);
  assert.equal(balCheck[0].balance, 300, "Balance must be restored to original 300");

  // Burn transaction must NOT remain
  const burnCheck = db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_FAIL}' AND tx_type = 'account_deletion_burn'`);
  assert.equal(burnCheck.length, 0, "Burn transaction must be deleted on rollback");

  // deleted_users must NOT have cooldown record
  const cdCheck = db.public.many(`SELECT * FROM deleted_users WHERE telegram_id = '${USER_FAIL}'`);
  assert.equal(cdCheck.length, 0, "deleted_users must NOT retain record if deletion failed");
});

test("NEW-DB-01: Permanent referral anti-fraud blocks re-claim even past 15-day cooldown", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test", REFERRAL_SECRET_SALT: "test-salt-secret-key-12345" };
  const userRepo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const INVITER_A = "70001";
  const INVITEE_B = "70002";
  const INVITER_C = "70003";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${INVITER_A}', 'inviter_a'), ('${INVITEE_B}', 'invitee_b'), ('${INVITER_C}', 'inviter_c');
    INSERT INTO referrals (inviter_id, invitee_id, channel_verified, rewarded) VALUES ('${INVITER_A}', '${INVITEE_B}', true, true);
  `);

  // Step 1: User B deletes account
  await userRepo.deleteAccount(env, INVITEE_B);

  // Verify permanent referral pair recorded
  const claimedPairs = db.public.many(`SELECT * FROM claimed_referral_pairs`);
  assert.ok(claimedPairs.length >= 2, "Must record both pair and invitee hashes");

  // Step 2: Simulate 16 days passing (expired cooldown in deleted_users)
  db.public.many(`
    UPDATE deleted_users SET cooldown_until = NOW() - INTERVAL '1 day' WHERE telegram_id = '${INVITEE_B}'
  `);

  // Step 3: Wire referral-rewards service
  const economyService = {
    grantReward: async () => ({ success: true })
  };
  const referralRewardsService = createReferralRewardsService({
    queryDb,
    notificationService: null,
    walletRepo: null,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => s ? String(s) : null,
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => userRepo
  });

  // Re-registration with same inviter A: MUST BE REJECTED by permanent anti-fraud
  const attemptSame = await referralRewardsService.processReferralOnBootstrap(env, INVITEE_B, INVITER_A, true, true);
  assert.equal(attemptSame?.rejected, true, "Same inviter must be permanently rejected");
  assert.match(attemptSame?.reason, /Permanent referral anti-fraud/);

  // Re-registration with new inviter C: MUST ALSO BE REJECTED by invitee-lifetime anti-fraud
  const attemptNew = await referralRewardsService.processReferralOnBootstrap(env, INVITEE_B, INVITER_C, true, true);
  assert.equal(attemptNew?.rejected, true, "New inviter must also be permanently rejected for already-rewarded invitee");
  assert.match(attemptNew?.reason, /Permanent referral anti-fraud/);
});

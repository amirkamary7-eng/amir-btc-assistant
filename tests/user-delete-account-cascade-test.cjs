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

function loadWalletRepo() {
  const walletPath = path.join(__dirname, "..", "src", "repositories", "wallet.js");
  const wSrc = fs.readFileSync(walletPath, "utf8");
  const cjsSource = wSrc
    .replace(/^export\s+function\s+createWalletRepository/m, "function createWalletRepository")
    + "\nmodule.exports = { createWalletRepository };";
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", cjsSource);
  fn(require, mod, mod.exports);
  return mod.exports.createWalletRepository;
}
const createWalletRepository = loadWalletRepo();

function loadEconomyService() {
  const econPath = path.join(__dirname, "..", "src", "services", "economy.js");
  const eSrc = fs.readFileSync(econPath, "utf8");
  const cjsSource = eSrc
    .replace(/^export\s+function\s+createEconomyService/m, "function createEconomyService")
    + "\nmodule.exports = { createEconomyService };";
  const mod = { exports: {} };
  const fn = new Function("require", "module", "exports", cjsSource);
  fn(require, mod, mod.exports);
  return mod.exports.createEconomyService;
}
const createEconomyService = loadEconomyService();


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
      source VARCHAR(32) DEFAULT 'system',
      status VARCHAR(16) DEFAULT 'completed',
      description VARCHAR(256),
      ref_id VARCHAR(128),
      metadata JSONB DEFAULT '{}',
      created_at TIMESTAMPTZ DEFAULT NOW(),
      updated_at TIMESTAMPTZ DEFAULT NOW()
    );
    CREATE UNIQUE INDEX idx_token_tx_user_type_ref
      ON token_transactions (user_id, tx_type, ref_id)
      WHERE ref_id IS NOT NULL AND status = 'completed';

    CREATE TABLE pending_refunds (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      amount INTEGER NOT NULL,
      refund_ref_id VARCHAR(128) NOT NULL,
      original_ref_id VARCHAR(128),
      source VARCHAR(32) DEFAULT 'alert',
      description VARCHAR(256),
      metadata JSONB DEFAULT '{}',
      status VARCHAR(16) DEFAULT 'pending',
      retry_count SMALLINT DEFAULT 0,
      last_retry_at TIMESTAMPTZ,
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

  function rewriteDistinctFrom(sql) {
    return String(sql)
      .replace("SELECT $1, $2, NOW() FROM tx_insert", "SELECT $1, $2::integer, NOW() FROM tx_insert")
      .replace(
        /([a-zA-Z0-9_.$:]+)\s+IS\s+DISTINCT\s+FROM\s+([a-zA-Z0-9_.$:]+)/gi,
        (_, l, r) => `((${l} IS NULL AND ${r} IS NOT NULL) OR (${l} IS NOT NULL AND ${r} IS NULL) OR (${l} <> ${r}))`
      );
  }

  // Transaction serialization lock for pg-mem (simulates row-level FOR UPDATE serialization across concurrent connections)
  let _txQueue = Promise.resolve();
  function withTxLock(fn) {
    const next = _txQueue.then(fn, fn);
    _txQueue = next.catch(() => {});
    return next;
  }

  async function queryDb(env, sqlText, params = []) {
    const s = rewriteDistinctFrom(String(sqlText || ''));
    if (s.includes('CREATE TABLE IF NOT EXISTS deleted_users') ||
        s.includes('CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_users_telegram_id_uniq') ||
        s.includes('CREATE TABLE IF NOT EXISTS token_transactions_archive') ||
        s.includes('CREATE TABLE IF NOT EXISTS claimed_referral_pairs') ||
        s.includes('idx_token_tx_user_type_ref')) {
      return { rows: [], rowCount: 0 };
    }
    return pool.query(s, params);
  }

  async function queryDbTransaction(env, queries) {
    return withTxLock(async () => {
      const backup = db.backup();
      const client = await pool.connect();
      try {
        await client.query("BEGIN");
        let results = [];
        if (typeof queries === "function") {
          const txQuery = (sql, params = []) => client.query(rewriteDistinctFrom(sql), params);
          results = await queries(txQuery);
        } else {
          for (const q of queries) {
            const res = await client.query(rewriteDistinctFrom(q.sql), q.params || []);
            results.push(res);
          }
        }
        await client.query("COMMIT");
        return results;
      } catch (err) {
        await client.query("ROLLBACK").catch(() => {});
        backup.restore();
        throw err;
      } finally {
        client.release();
      }
    });
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


test("H1-REMEDIATION: Account deletion auto-settles pending refunds prior to burn", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_H1 = "80001";
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_H1}', 'h1_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_H1}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('${USER_H1}', 30, 'ref_p1', 'pending');
    INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id) VALUES
      ('${USER_H1}', 100, 'daily_claim', 'Claim', 'tx_h1_1');
  `);

  const summary = await repo.deleteAccount(env, USER_H1);

  assert.equal(summary.openPendingRefunds, 1, "Must detect 1 pending refund");
  assert.equal(summary.burnedBalance, 130, "Burned balance must equal initial 100 + auto-settled refund 30");

  const archived = db.public.many(`SELECT * FROM token_transactions_archive WHERE account_tombstone_id = '${summary.tombstoneId}'`);
  assert.equal(archived.length, 3, "Archived txs must contain original 1, auto-settled refund 1, and burn 1");

  const sumAmount = archived.reduce((acc, row) => acc + Number(row.amount), 0);
  assert.equal(sumAmount, 0, "Ledger total sum across archive including auto-settled refund must equal exactly 0");
});

test("H2-REMEDIATION: Deep recursive PII scrubbing for nested JSON objects, arrays, and numeric keys", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_H2 = "80002";
  const nestedMeta = JSON.stringify({
    details: {
      user_id: "80002",
      telegram_id: "80002",
      nested_array: [{ invitee_id: "80002", num_id: 80002, comment: "user 80002 referred" }],
      raw_num: 80002
    }
  });

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_H2}', 'h2_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_H2}', 0);
    INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id, metadata) VALUES
      ('${USER_H2}', 0, 'test_meta', 'User 80002 action', 'ref_80002_meta', '${nestedMeta.replace(/'/g, "''")}');
  `);

  const summary = await repo.deleteAccount(env, USER_H2);

  const archived = db.public.many(`SELECT * FROM token_transactions_archive WHERE account_tombstone_id = '${summary.tombstoneId}'`);
  assert.equal(archived.length, 1);

  const meta = typeof archived[0].metadata === 'string' ? JSON.parse(archived[0].metadata) : archived[0].metadata;
  assert.equal(meta.details.user_id, undefined, "Nested user_id must be stripped");
  assert.equal(meta.details.telegram_id, undefined, "Nested telegram_id must be stripped");
  assert.equal(meta.details.nested_array[0].invitee_id, undefined, "Array item invitee_id must be stripped");
  assert.equal(meta.details.nested_array[0].num_id, "ANON", "Numeric ID inside array item must be scrubbed");
  assert.match(meta.details.nested_array[0].comment, /ANON/, "String text inside array item must be scrubbed");
});

test("H2-REMEDIATION: Archive duplicate content mismatch triggers rollback", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_H2_DUP = "80003";
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_H2_DUP}', 'h2_dup_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_H2_DUP}', 50);
    INSERT INTO token_transactions (id, user_id, amount, tx_type, description, ref_id) VALUES
      (9001, '${USER_H2_DUP}', 50, 'daily_claim', 'Claim', 'ref_9001');
    INSERT INTO token_transactions_archive (original_tx_id, account_tombstone_id, amount, tx_type, description, ref_id, original_created_at) VALUES
      (9001, 'old_tombstone_id', 9999, 'DIFFERENT_TYPE', 'Old claim', 'ref_9001', NOW());
  `);

  await assert.rejects(
    async () => repo.deleteAccount(env, USER_H2_DUP),
    /Archive duplicate content mismatch/
  );

  const userCheck = db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_H2_DUP}'`);
  assert.equal(userCheck.length, 1, "User must NOT be deleted when archive duplicate mismatch occurs");
});

test("H3-REMEDIATION: Production Fail-Closed when REFERRAL_SECRET_SALT is unconfigured", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const envProdMissingSalt = { APP_ENV: "production" };
  const userRepo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_H3 = "80004";
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_H3}', 'h3_user');
  `);

  await assert.rejects(
    async () => userRepo.deleteAccount(envProdMissingSalt, USER_H3),
    /REFERRAL_SECRET_SALT must be securely configured/
  );

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
    economyService: { grantReward: async () => ({ success: true }) },
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => userRepo
  });

  const bootstrapRes = await referralRewardsService.processReferralOnBootstrap(envProdMissingSalt, "80005", USER_H3, true, true);
  assert.equal(bootstrapRes?.rejected, true);
  assert.match(bootstrapRes?.reason, /REFERRAL_SECRET_SALT is not configured/);
});


test("J1-REMEDIATION: Single atomic transaction rolls back refund settlement, burn, and user deletion on failure", async () => {
  const { db, queryDb } = setupMockDatabase();
  const env = { APP_ENV: "test" };

  // Failing transaction mock
  const failingTx = async (env, queries) => {
    throw new Error("Simulated DB connection drop inside queryDbTransaction");
  };

  const repo = createUserRepository({ queryDb, queryDbTransaction: failingTx, queryDbDirect: queryDb });

  const USER_J1 = "90001";
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_J1}', 'j1_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_J1}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('${USER_J1}', 50, 'ref_j1_fail', 'pending');
  `);

  await assert.rejects(
    async () => repo.deleteAccount(env, USER_J1),
    /Simulated DB connection drop/
  );

  // User MUST still exist
  assert.equal(db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_J1}'`).length, 1);
  // Balance MUST remain unchanged at 100
  assert.equal(db.public.many(`SELECT * FROM token_balances WHERE user_id = '${USER_J1}'`)[0].balance, 100);
  // Pending refund MUST remain pending
  assert.equal(db.public.many(`SELECT * FROM pending_refunds WHERE user_id = '${USER_J1}'`)[0].status, 'pending');
});

test("J2-REMEDIATION: Complete archive duplicate verification across description, ref_id, source, and metadata", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_J2 = "90002";
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_J2}', 'j2_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_J2}', 0);
    INSERT INTO token_transactions (id, user_id, amount, tx_type, source, description, ref_id) VALUES
      (9501, '${USER_J2}', 100, 'daily_claim', 'daily_system', 'Daily login', 'ref_9501');
    INSERT INTO token_transactions_archive (original_tx_id, account_tombstone_id, amount, tx_type, source, description, ref_id, original_created_at) VALUES
      (9501, 'old_tombstone', 100, 'daily_claim', 'DIFFERENT_SOURCE', 'Daily login', 'ref_9501', NOW());
  `);

  await assert.rejects(
    async () => repo.deleteAccount(env, USER_J2),
    /Archive duplicate content mismatch across fields/
  );
});

test("J2-REMEDIATION: Archive duplicate with identical content and differently-ordered JSON metadata keys PASSES", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });

  const USER_J2_PASS = "90003";
  const now = new Date().toISOString();
  const metaSrc = JSON.stringify({ a: 1, b: 2 });
  const metaArch = JSON.stringify({ b: 2, a: 1 }); // Same content, different key order

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_J2_PASS}', 'j2_pass_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_J2_PASS}', 0);
    INSERT INTO token_transactions (id, user_id, amount, tx_type, source, description, ref_id, metadata, created_at) VALUES
      (9502, '${USER_J2_PASS}', 100, 'daily_claim', 'system', 'Daily', 'ref_9502', '${metaSrc}', '${now}');
    INSERT INTO token_transactions_archive (original_tx_id, account_tombstone_id, amount, tx_type, source, description, ref_id, metadata, original_created_at) VALUES
      (9502, 'existing_tombstone', 100, 'daily_claim', 'system', 'Daily', 'ref_9502', '${metaArch}', '${now}');
  `);

  const summary = await repo.deleteAccount(env, USER_J2_PASS);
  assert.equal(summary.userId, USER_J2_PASS);
  assert.equal(db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_J2_PASS}'`).length, 0);
});


// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5P — Concurrency, Canonical Refund Idempotency & Archive Integrity
// ═══════════════════════════════════════════════════════════════════════════

test("5P-CONCURRENCY-01: Concurrent deleteAccount and retryFailedRefunds for same user and refund never double-credits", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const userRepo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const USER_C1 = "91001";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_C1}', 'c1_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_C1}', 100);
    INSERT INTO token_transactions (user_id, amount, tx_type, source, description, ref_id) VALUES
      ('${USER_C1}', 100, 'daily_claim', 'system', 'Initial claim', 'ref_c1_init');
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status) VALUES
      ('${USER_C1}', 40, 'canon_refund_c1', 'alert', 'Refund 40', 'pending');
  `);

  // Wire REAL createWalletRepository and REAL createEconomyService
  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const economyService = createEconomyService({ walletRepo, queryDb });

  const referralRewardsService = createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => userRepo
  });

  const [delSummary] = await Promise.all([
    userRepo.deleteAccount(env, USER_C1),
    referralRewardsService.retryFailedRefunds(env)
  ]);

  assert.equal(delSummary.burnedBalance, 140, "Total burned balance must be exactly 100 + 40 = 140 (never 180)");
  const archived = db.public.many(`SELECT * FROM token_transactions_archive WHERE account_tombstone_id = '${delSummary.tombstoneId}' ORDER BY original_tx_id ASC`);
  assert.equal(archived.length, 3, "Exactly 3 archived rows: initial (+100), single refund (+40), single burn (-140)");
  const refundArch = archived.filter(r => r.tx_type === "marketplace_refund");
  assert.equal(refundArch.length, 1, "Refund must be credited and archived exactly once");
  assert.equal(refundArch[0].ref_id, "canon_refund_c1", "Canonical refund_ref_id must be used");
  const netSum = archived.reduce((acc, r) => acc + Number(r.amount), 0);
  assert.equal(netSum, 0, "Archived ledger must net to 0");
});

test("5P-CONCURRENCY-02: Two concurrent retryFailedRefunds workers for the same pending refund credit only once", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_C2 = "91002";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_C2}', 'c2_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_C2}', 50);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status) VALUES
      ('${USER_C2}', 25, 'canon_refund_c2', 'alert', 'Refund 25', 'pending');
  `);

  let grantCallCount = 0;
  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const realEconomy = createEconomyService({ walletRepo, queryDb });
  const economyService = {
    grantReward: async (opts) => {
      grantCallCount++;
      return realEconomy.grantReward(opts);
    }
  };

  const makeWorker = () => createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await Promise.all([
    makeWorker().retryFailedRefunds(env),
    makeWorker().retryFailedRefunds(env)
  ]);

  assert.equal(grantCallCount, 1, "Atomic status=processing claim must prevent second worker from calling grantReward");
  const bal = db.public.many(`SELECT balance FROM token_balances WHERE user_id = '${USER_C2}'`)[0].balance;
  assert.equal(bal, 75, "Wallet balance must increase exactly once (50 + 25 = 75)");
  const pref = db.public.many(`SELECT status FROM pending_refunds WHERE user_id = '${USER_C2}'`)[0];
  assert.equal(pref.status, "completed", "Pending refund must be marked completed");
});

test("5P-CONCURRENCY-03: Two concurrent deleteAccount calls for the same user settle and archive only once", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const USER_C3 = "91003";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_C3}', 'c3_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_C3}', 60);
    INSERT INTO token_transactions (user_id, amount, tx_type, source, description, ref_id) VALUES
      ('${USER_C3}', 60, 'daily_claim', 'system', 'Initial', 'ref_c3_init');
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('${USER_C3}', 40, 'canon_refund_c3', 'pending');
  `);

  const [res1, res2] = await Promise.all([
    repo.deleteAccount(env, USER_C3),
    repo.deleteAccount(env, USER_C3)
  ]);

  const primary = res1.alreadyDeleted ? res2 : res1;
  const secondary = res1.alreadyDeleted ? res1 : res2;
  assert.equal(primary.burnedBalance, 100, "Primary deleteAccount must settle +40 and burn 100");
  assert.equal(secondary.alreadyDeleted, true, "Secondary concurrent deleteAccount must detect alreadyDeleted and exit cleanly");
  assert.equal(secondary.burnedBalance, 0, "Secondary call must not burn anything");

  const allArchived = db.public.many("SELECT * FROM token_transactions_archive ORDER BY original_tx_id ASC");
  assert.equal(allArchived.length, 3, "Only 3 archive rows must exist across both concurrent calls");
});

test("5P-REF-CONFLICT: ref_id conflict with different owner, amount, or tx_type rolls back entire deleteAccount", async () => {
  const env = { APP_ENV: "test" };

  // Case A: Different owner (user_id mismatch)
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('92001', 'u1'), ('92002', 'u2');
      INSERT INTO token_balances (user_id, balance) VALUES ('92001', 50), ('92002', 50);
      INSERT INTO token_transactions (user_id, amount, tx_type, source, status, ref_id) VALUES
        ('92002', 30, 'marketplace_refund', 'marketplace', 'completed', 'shared_conflict_ref');
      INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
        ('92001', 30, 'shared_conflict_ref', 'pending');
    `);
    await assert.rejects(
      async () => repo.deleteAccount(env, "92001"),
      /Refund ref_id conflict mismatch/
    );
    assert.equal(db.public.many("SELECT * FROM users WHERE telegram_id = '92001'").length, 1, "User must not be deleted on owner conflict");
    assert.equal(db.public.many("SELECT balance FROM token_balances WHERE user_id = '92001'")[0].balance, 50);
  }

  // Case B: Different amount
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('92003', 'u3');
      INSERT INTO token_balances (user_id, balance) VALUES ('92003', 50);
      INSERT INTO token_transactions (user_id, amount, tx_type, source, status, ref_id) VALUES
        ('92003', 999, 'marketplace_refund', 'marketplace', 'completed', 'amt_conflict_ref');
      INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
        ('92003', 30, 'amt_conflict_ref', 'pending');
    `);
    await assert.rejects(
      async () => repo.deleteAccount(env, "92003"),
      /Refund ref_id conflict mismatch/
    );
    assert.equal(db.public.many("SELECT * FROM users WHERE telegram_id = '92003'").length, 1);
  }

  // Case C: Different tx_type
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('92004', 'u4');
      INSERT INTO token_balances (user_id, balance) VALUES ('92004', 50);
      INSERT INTO token_transactions (user_id, amount, tx_type, source, status, ref_id) VALUES
        ('92004', 30, 'daily_claim', 'system', 'completed', 'type_conflict_ref');
      INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
        ('92004', 30, 'type_conflict_ref', 'pending');
    `);
    await assert.rejects(
      async () => repo.deleteAccount(env, "92004"),
      /Refund ref_id conflict mismatch/
    );
    assert.equal(db.public.many("SELECT * FROM users WHERE telegram_id = '92004'").length, 1);
  }
});

test("5P-ROLLBACK-SETTLEMENT: Failure during refund insert or pending_refunds settlement rolls back completely", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_R1 = "93001";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_R1}', 'r1_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_R1}', 80);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('${USER_R1}', 20, 'ref_r1', 'pending');
  `);

  // Wrap queryDbTransaction so UPDATE pending_refunds returns 0 rows (simulating settlement failure)
  const interceptTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
    const wrappedTxQuery = async (sql, params) => {
      if (String(sql).includes("UPDATE pending_refunds SET status = 'settled'")) {
        return { rows: [], rowCount: 0 };
      }
      return txQuery(sql, params);
    };
    return fn(wrappedTxQuery);
  });

  const repo = createUserRepository({ queryDb, queryDbTransaction: interceptTx, queryDbDirect: queryDb });
  await assert.rejects(
    async () => repo.deleteAccount(env, USER_R1),
    /Failed to mark pending_refund/
  );

  assert.equal(db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_R1}'`).length, 1, "User must remain after settlement failure rollback");
  assert.equal(db.public.many(`SELECT balance FROM token_balances WHERE user_id = '${USER_R1}'`)[0].balance, 80, "Wallet balance must roll back to 80");
  assert.equal(db.public.many(`SELECT status FROM pending_refunds WHERE user_id = '${USER_R1}'`)[0].status, "pending", "Refund must remain pending");
  assert.equal(db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_R1}'`).length, 0, "Inserted refund tx must be rolled back");
});

test("5P-NO-FAKE-ID: nextFakeId is completely removed and all archive original_tx_id values come from real PostgreSQL SERIAL sequence", async () => {
  const usersSrc = fs.readFileSync(path.join(__dirname, "../src/repositories/users.js"), "utf8");
  assert.equal(usersSrc.includes("nextFakeId"), false, "nextFakeId must be completely removed from src/repositories/users.js");
  assert.equal(usersSrc.includes("900000"), false, "Synthetic 900000 ID offset must be completely removed from src/repositories/users.js");
  assert.equal(usersSrc.includes("auto_refund_"), false, "Synthetic auto_refund_ ref_id must be completely removed from src/repositories/users.js");

  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const USER_REAL_ID = "94001";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_REAL_ID}', 'real_id_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_REAL_ID}', 50);
    INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id) VALUES
      ('${USER_REAL_ID}', 50, 'daily_claim', 'Claim', 'claim_94001');
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('${USER_REAL_ID}', 25, 'refund_canon_94001', 'pending');
  `);

  const summary = await repo.deleteAccount(env, USER_REAL_ID);
  const archived = db.public.many(`SELECT original_tx_id, tx_type, amount FROM token_transactions_archive WHERE account_tombstone_id = '${summary.tombstoneId}' ORDER BY original_tx_id ASC`);
  assert.equal(archived.length, 3);
  assert.deepEqual(
    archived.map(r => r.original_tx_id),
    [1, 2, 3],
    "All 3 archived rows (original + refund + burn) must have sequential PostgreSQL SERIAL IDs [1, 2, 3], never 900000+"
  );
});

test("5P-ARCHIVE-COMPLETENESS: Missing or extra archive records trigger rollback before any DELETE FROM token_transactions", async () => {
  const env = { APP_ENV: "test" };

  // Case A: Missing archive record (simulate archive INSERT skipped)
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const USER_MISS = "95001";
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('${USER_MISS}', 'miss_user');
      INSERT INTO token_balances (user_id, balance) VALUES ('${USER_MISS}', 0);
      INSERT INTO token_transactions (user_id, amount, tx_type, ref_id) VALUES ('${USER_MISS}', 10, 'daily_claim', 'ref_m1');
    `);
    const skipArchiveInsertTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
      return fn(async (sql, params) => {
        if (String(sql).includes("INSERT INTO token_transactions_archive")) {
          return { rows: [], rowCount: 0 };
        }
        return txQuery(sql, params);
      });
    });
    const repo = createUserRepository({ queryDb, queryDbTransaction: skipArchiveInsertTx, queryDbDirect: queryDb });
    await assert.rejects(
      async () => repo.deleteAccount(env, USER_MISS),
      /Archive verification failed: missing archive record/
    );
    assert.equal(db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_MISS}'`).length, 1, "Source token_transactions row must NOT be deleted when archive is missing");
  }

  // Case B: Extra archive record under the same tombstone_id
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const USER_EXTRA = "95002";
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('${USER_EXTRA}', 'extra_user');
      INSERT INTO token_balances (user_id, balance) VALUES ('${USER_EXTRA}', 0);
      INSERT INTO token_transactions (user_id, amount, tx_type, ref_id) VALUES ('${USER_EXTRA}', 10, 'daily_claim', 'ref_e1');
    `);
    const injectExtraArchiveTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
      return fn(async (sql, params) => {
        const res = await txQuery(sql, params);
        if (String(sql).includes("INSERT INTO token_transactions_archive")) {
          const tombstone = params[1];
          await txQuery(
            `INSERT INTO token_transactions_archive (original_tx_id, account_tombstone_id, amount, tx_type, source, status, original_created_at)
             VALUES (99999, $1, 500, 'phantom_tx', 'system', 'completed', NOW())`,
            [tombstone]
          );
        }
        return res;
      });
    });
    const repo = createUserRepository({ queryDb, queryDbTransaction: injectExtraArchiveTx, queryDbDirect: queryDb });
    await assert.rejects(
      async () => repo.deleteAccount(env, USER_EXTRA),
      /Archive verification failed: extra archive record/
    );
    assert.equal(db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_EXTRA}'`).length, 1, "Source token_transactions row must NOT be deleted when extra archive row exists");
  }

  // Case C: Duplicate archive record for same original_tx_id (simulated viadupArchRes returning duplicate)
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const USER_DUP = "95003";
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('${USER_DUP}', 'dup_user');
      INSERT INTO token_balances (user_id, balance) VALUES ('${USER_DUP}', 0);
      INSERT INTO token_transactions (user_id, amount, tx_type, ref_id) VALUES ('${USER_DUP}', 10, 'daily_claim', 'ref_d1');
    `);
    const simulateDuplicateArchiveTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
      return fn(async (sql, params) => {
        if (String(sql).includes("INNER JOIN token_transactions_archive a2")) {
          return { rows: [{ original_tx_id: 1 }], rowCount: 1 };
        }
        return txQuery(sql, params);
      });
    });
    const repo = createUserRepository({ queryDb, queryDbTransaction: simulateDuplicateArchiveTx, queryDbDirect: queryDb });
    await assert.rejects(
      async () => repo.deleteAccount(env, USER_DUP),
      /Archive verification failed: duplicate archive record/
    );
    assert.equal(db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_DUP}'`).length, 1, "Source token_transactions row must NOT be deleted when duplicate archive row exists");
  }
});

test("5P-ARCHIVE-8-FIELDS: Mismatch in any of the 8 archive fields (amount, tx_type, source, status, description, ref_id, metadata, original_created_at) triggers rollback", async () => {
  const env = { APP_ENV: "test" };
  const baseNow = "2026-10-31T00:00:00.000Z";
  const baseRow = {
    amount: 100,
    tx_type: "daily_claim",
    source: "system",
    status: "completed",
    description: "Clean description",
    ref_id: "clean_ref_id",
    metadata: JSON.stringify({ tier: "gold", nested: { ok: true } }),
    original_created_at: baseNow
  };

  const mutations = [
    { field: "amount", override: { amount: 101 } },
    { field: "tx_type", override: { tx_type: "tampered_type" } },
    { field: "source", override: { source: "tampered_source" } },
    { field: "status", override: { status: "failed" } },
    { field: "description (value mismatch)", override: { description: "Tampered description" } },
    { field: "description (NULL vs non-NULL)", override: { description: null } },
    { field: "ref_id (value mismatch)", override: { ref_id: "tampered_ref" } },
    { field: "ref_id (NULL vs non-NULL)", override: { ref_id: null } },
    { field: "metadata (JSONB structural mismatch)", override: { metadata: JSON.stringify({ tier: "silver", nested: { ok: true } }) } },
    { field: "original_created_at (timestamp mismatch)", override: { original_created_at: "2025-01-01T00:00:00.000Z" } }
  ];

  for (let i = 0; i < mutations.length; i++) {
    const { field, override } = mutations[i];
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const repo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
    const uid = String(96000 + i);
    const txId = 7000 + i;
    const arch = { ...baseRow, ...override };

    await queryDb(env, "INSERT INTO users (telegram_id, username) VALUES ($1, $2)", [uid, "u_" + i]);
    await queryDb(env, "INSERT INTO token_balances (user_id, balance) VALUES ($1, 0)", [uid]);
    await queryDb(
      env,
      `INSERT INTO token_transactions (id, user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [txId, uid, baseRow.amount, baseRow.tx_type, baseRow.source, baseRow.status, baseRow.description, baseRow.ref_id, baseRow.metadata, baseRow.original_created_at]
    );
    await queryDb(
      env,
      `INSERT INTO token_transactions_archive (original_tx_id, account_tombstone_id, amount, tx_type, source, status, description, ref_id, metadata, original_created_at)
       VALUES ($1, 'pre_existing_tomb', $2, $3, $4, $5, $6, $7, $8, $9)`,
      [txId, arch.amount, arch.tx_type, arch.source, arch.status, arch.description, arch.ref_id, arch.metadata, arch.original_created_at]
    );

    await assert.rejects(
      async () => repo.deleteAccount(env, uid),
      /Archive duplicate content mismatch across fields/,
      `Mismatch on field [${field}] must reject and rollback`
    );

    const remainingTx = db.public.many(`SELECT * FROM token_transactions WHERE id = ${txId}`);
    assert.equal(remainingTx.length, 1, `Source transaction must NOT be deleted when [${field}] mismatches`);
  }
});

test("5P-PRE-DELETE-PROOF: Archive verification queries execute strictly BEFORE any DELETE FROM token_transactions", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_ORDER = "97001";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_ORDER}', 'order_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_ORDER}', 50);
    INSERT INTO token_transactions (user_id, amount, tx_type, ref_id) VALUES ('${USER_ORDER}', 50, 'daily_claim', 'ref_ord_1');
  `);

  const sqlLog = [];
  const loggingTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
    return fn(async (sql, params) => {
      sqlLog.push(String(sql).replace(/\s+/g, " ").trim());
      return txQuery(sql, params);
    });
  });

  const repo = createUserRepository({ queryDb, queryDbTransaction: loggingTx, queryDbDirect: queryDb });
  await repo.deleteAccount(env, USER_ORDER);

  const verifyMissingIdx = sqlLog.findIndex(s => s.includes("LEFT JOIN token_transactions_archive a ON a.original_tx_id = s.id"));
  const verifyExtraIdx = sqlLog.findIndex(s => s.includes("WHERE a.account_tombstone_id = $2 AND s.id IS NULL"));
  const verifyFieldsIdx = sqlLog.findIndex(s => s.includes("INNER JOIN token_transactions src ON src.id = a.original_tx_id"));
  const deleteTxIdx = sqlLog.findIndex(s => s.includes("DELETE FROM token_transactions WHERE user_id = $1"));

  assert.ok(verifyMissingIdx > -1 && verifyExtraIdx > -1 && verifyFieldsIdx > -1 && deleteTxIdx > -1, "All verification queries and DELETE query must be logged");
  assert.ok(verifyMissingIdx < deleteTxIdx, "Missing-archive check must execute BEFORE DELETE FROM token_transactions");
  assert.ok(verifyExtraIdx < deleteTxIdx, "Extra-archive check must execute BEFORE DELETE FROM token_transactions");
  assert.ok(verifyFieldsIdx < deleteTxIdx, "8-field archive comparison must execute BEFORE DELETE FROM token_transactions");
});


// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5R — Stale Processing Recovery, Real Economy Stack & ON CONFLICT Race
// ═══════════════════════════════════════════════════════════════════════════

test("5R-STALE-RECOVERY-01: Crash after claim (before creditTokens) leaves stale processing row -> recovered after 5m and credited exactly once", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_SR1 = "98001";

  // Insert user with a refund stuck in status=processing from 10 minutes ago (crash before creditTokens)
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_SR1}', 'sr1_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_SR1}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status, last_retry_at, updated_at, created_at)
    VALUES ('${USER_SR1}', 35, 'stale_ref_sr1', 'alert', 'Stale refund 35', 'processing', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes');
  `);

  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const economyService = createEconomyService({ walletRepo, queryDb });
  const referralService = createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await referralService.retryFailedRefunds(env);

  const bal = db.public.many(`SELECT balance FROM token_balances WHERE user_id = '${USER_SR1}'`)[0].balance;
  assert.equal(bal, 135, "Wallet balance must be credited once (100 + 35 = 135)");
  const pref = db.public.many(`SELECT status FROM pending_refunds WHERE user_id = '${USER_SR1}'`)[0];
  assert.equal(pref.status, "completed", "Stale processing refund must transition to completed");
  const txs = db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_SR1}' AND ref_id = 'stale_ref_sr1'`);
  assert.equal(txs.length, 1, "Exactly 1 refund transaction must exist");
});

test("5R-STALE-RECOVERY-02: Crash after creditTokens committed (before status=completed) -> recovered without double-credit", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_SR2 = "98002";

  // Simulate state where worker claimed row (status=processing, 10m ago), creditTokens succeeded (+45 already in balance & token_transactions), then worker crashed before UPDATE status=completed
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_SR2}', 'sr2_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_SR2}', 145);
    INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id)
    VALUES ('${USER_SR2}', 45, 'marketplace_refund', 'marketplace', 'completed', 'Prior refund credit', 'stale_ref_sr2');
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status, last_retry_at, updated_at, created_at)
    VALUES ('${USER_SR2}', 45, 'stale_ref_sr2', 'alert', 'Stale refund 45', 'processing', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes');
  `);

  let grantCalled = 0;
  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const realEcon = createEconomyService({ walletRepo, queryDb });
  const economyService = {
    grantReward: async (opts) => {
      grantCalled++;
      return realEcon.grantReward(opts);
    }
  };
  const referralService = createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await referralService.retryFailedRefunds(env);

  assert.equal(grantCalled, 0, "Pre-credit check must detect existing valid transaction + balance and skip grantReward");
  const bal = db.public.many(`SELECT balance FROM token_balances WHERE user_id = '${USER_SR2}'`)[0].balance;
  assert.equal(bal, 145, "Wallet balance must remain 145 (no double credit)");
  const pref = db.public.many(`SELECT status FROM pending_refunds WHERE user_id = '${USER_SR2}'`)[0];
  assert.equal(pref.status, "completed", "Stale processing refund must transition to completed");
});

test("5R-STALE-RECOVERY-03: Fresh active processing refund (< 5 minutes) is NOT stolen by another retry worker", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_SR3 = "98003";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_SR3}', 'sr3_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_SR3}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status, last_retry_at, updated_at, created_at)
    VALUES ('${USER_SR3}', 20, 'fresh_ref_sr3', 'alert', 'Fresh active refund', 'processing', NOW(), NOW(), NOW());
  `);

  let grantCalled = 0;
  const economyService = { grantReward: async () => { grantCalled++; return { success: true, txId: 1 }; } };
  const referralService = createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo: null,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await referralService.retryFailedRefunds(env);
  assert.equal(grantCalled, 0, "Fresh in-flight processing row must not be re-claimed before 5-minute timeout");
});

test("5R-ON-CONFLICT-RACE: Concurrent creditTokens insert between deleteAccount SELECT and INSERT is handled idempotently if valid and rolled back if mismatched", async () => {
  const env = { APP_ENV: "test" };

  // Case A: Concurrent valid insert (same user, same amount, marketplace_refund) -> idempotent settle, no double credit
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const USER_RACE_OK = "98004";
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('${USER_RACE_OK}', 'race_ok');
      INSERT INTO token_balances (user_id, balance) VALUES ('${USER_RACE_OK}', 100);
      INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES ('${USER_RACE_OK}', 30, 'race_ref_ok', 'pending');
    `);

    // Simulate concurrent creditTokens inserting the tx and updating balance right before deleteAccount runs INSERT INTO token_transactions
    const raceSimTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
      return fn(async (sql, params) => {
        if (String(sql).includes("INSERT INTO token_transactions") && String(sql).includes("marketplace_refund")) {
          // Concurrent creditTokens just inserted the row and credited +30
          await txQuery(
            "INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id) VALUES ($1, $2, 'marketplace_refund', 'marketplace', 'completed', 'Concurrent credit', $3)",
            [USER_RACE_OK, 30, "race_ref_ok"]
          );
          await txQuery("UPDATE token_balances SET balance = balance + 30 WHERE user_id = $1", [USER_RACE_OK]);
        }
        return txQuery(sql, params);
      });
    });

    const repo = createUserRepository({ queryDb, queryDbTransaction: raceSimTx, queryDbDirect: queryDb });
    const summary = await repo.deleteAccount(env, USER_RACE_OK);
    assert.equal(summary.burnedBalance, 130, "Balance must be credited only once (100 + 30 = 130) even when ON CONFLICT DO NOTHING returns 0 rows");
  }

  // Case B: Concurrent mismatched insert (different amount) -> full rollback
  {
    const { db, queryDb, queryDbTransaction } = setupMockDatabase();
    const USER_RACE_BAD = "98005";
    db.public.many(`
      INSERT INTO users (telegram_id, username) VALUES ('${USER_RACE_BAD}', 'race_bad');
      INSERT INTO token_balances (user_id, balance) VALUES ('${USER_RACE_BAD}', 100);
      INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES ('${USER_RACE_BAD}', 30, 'race_ref_bad', 'pending');
    `);

    const raceBadSimTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
      return fn(async (sql, params) => {
        if (String(sql).includes("INSERT INTO token_transactions") && String(sql).includes("marketplace_refund")) {
          await txQuery(
            "INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id) VALUES ($1, $2, 'marketplace_refund', 'marketplace', 'completed', 'Tampered', $3)",
            [USER_RACE_BAD, 999, "race_ref_bad"]
          );
        }
        return txQuery(sql, params);
      });
    });

    const repo = createUserRepository({ queryDb, queryDbTransaction: raceBadSimTx, queryDbDirect: queryDb });
    await assert.rejects(
      async () => repo.deleteAccount(env, USER_RACE_BAD),
      /Refund ref_id conflict mismatch/
    );
    assert.equal(db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_RACE_BAD}'`).length, 1, "User must not be deleted when concurrent conflicting ref_id is detected");
  }
});


// ═══════════════════════════════════════════════════════════════════════════
// PHASE 5T — Fencing Token Protection, Single-Tx Lock Order, Schema Parity & Crash Simulations
// ═══════════════════════════════════════════════════════════════════════════

test("5T-FENCING-01: Stale worker waking up after timeout cannot overwrite a newer worker claim or completed/settled status", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_F1 = "99001";

  // Initial state: Worker A claimed the row 10 minutes ago with token_A, then stalled
  const staleMetaA = JSON.stringify({ order_id: "ord_1", _claim_token: "claim_1_0_stale_worker_A", _claim_version: 0 });
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_F1}', 'f1_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_F1}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, metadata, status, retry_count, last_retry_at, updated_at, created_at)
    VALUES ('${USER_F1}', 40, 'fenced_ref_1', 'alert', 'Fenced refund', '${staleMetaA}', 'processing', 0, NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes', NOW() - INTERVAL '10 minutes');
  `);

  // Worker B runs retryFailedRefunds, reclaims the stale row with a new claimToken, credits +40, and marks status = completed
  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const economyService = createEconomyService({ walletRepo, queryDb });
  const workerB = createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await workerB.retryFailedRefunds(env);

  const afterB = db.public.many(`SELECT status, retry_count, metadata FROM pending_refunds WHERE user_id = '${USER_F1}'`)[0];
  assert.equal(afterB.status, "completed", "Worker B must mark the refund completed");
  const metaB = typeof afterB.metadata === "string" ? JSON.parse(afterB.metadata) : afterB.metadata;
  assert.notEqual(metaB._claim_token, "claim_1_0_stale_worker_A", "Worker B must have stamped a fresh fencing claim token");

  // Now Stale Worker A wakes up and attempts:
  // (a) Fenced completion UPDATE with token_A
  const staleCompleteRes = await queryDb(
    env,
    `UPDATE pending_refunds SET status = 'completed', last_retry_at = NOW(), updated_at = NOW() WHERE id = $1 AND status = 'processing' AND retry_count = $2 AND COALESCE(metadata::jsonb->>'_claim_token', '') = $3 RETURNING id`,
    [1, 0, "claim_1_0_stale_worker_A"]
  );
  assert.equal(staleCompleteRes.rows.length, 0, "Stale Worker A completion UPDATE must be rejected by fencing check");

  // (b) Fenced failure (pending + retry_count + 1) UPDATE with token_A
  const staleFailMetaA = JSON.stringify({ order_id: "ord_1", _claim_token: "claim_1_0_stale_worker_A", _claim_version: 1 });
  const stalePendingRes = await queryDb(
    env,
    `UPDATE pending_refunds SET status = 'pending', retry_count = retry_count + 1, last_retry_at = NOW(), updated_at = NOW(), metadata = $5 WHERE id = $1 AND retry_count = $2 AND ((status = 'processing' AND COALESCE(metadata::jsonb->>'_claim_token', '') = $3) OR ((status = 'pending' OR (status = 'processing' AND COALESCE(last_retry_at, updated_at, created_at) < NOW() - INTERVAL '5 minutes')) AND COALESCE(metadata::jsonb->>'_claim_token', '') = $4)) RETURNING id, retry_count`,
    [1, 0, "claim_1_0_stale_worker_A", "", staleFailMetaA]
  );
  assert.equal(stalePendingRes.rows.length, 0, "Stale Worker A pending/retry_count UPDATE must be rejected by fencing check");

  // (c) Fenced exhausted UPDATE with token_A
  const staleExhaustedRes = await queryDb(
    env,
    `UPDATE pending_refunds SET status = 'exhausted', updated_at = NOW() WHERE id = $1 AND status = 'pending' AND retry_count = $2 AND COALESCE(metadata::jsonb->>'_claim_token', '') = $3 RETURNING id`,
    [1, 1, "claim_1_0_stale_worker_A"]
  );
  assert.equal(staleExhaustedRes.rows.length, 0, "Stale Worker A exhausted UPDATE must be rejected by fencing check");

  // Verify Worker B state is completely untouched
  const finalRow = db.public.many(`SELECT status, retry_count FROM pending_refunds WHERE user_id = '${USER_F1}'`)[0];
  assert.equal(finalRow.status, "completed");
  assert.equal(finalRow.retry_count, 0);
  const finalBal = db.public.many(`SELECT balance FROM token_balances WHERE user_id = '${USER_F1}'`)[0].balance;
  assert.equal(finalBal, 140, "Balance must remain 140 (credited once by Worker B)");
});

test("5T-LOCK-ORDER-01: retryFailedRefunds runs in a single queryDbTransaction and acquires locks in identical order to deleteAccount", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_LO = "99002";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_LO}', 'lo_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_LO}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status)
    VALUES ('${USER_LO}', 25, 'lo_ref_1', 'alert', 'Lock order refund', 'pending');
  `);

  let txCount = 0;
  const txQueries = [];
  const trackingTx = (e, fn) => {
    txCount++;
    return queryDbTransaction(e, async (txQuery) => {
      return fn(async (sql, params) => {
        txQueries.push(String(sql).replace(/\s+/g, " ").trim());
        return txQuery(sql, params);
      });
    });
  };

  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction: trackingTx, queryDbDirect: queryDb });
  const economyService = createEconomyService({ walletRepo, queryDb });
  const referralService = createReferralRewardsService({
    queryDb,
    queryDbTransaction: trackingTx,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await referralService.retryFailedRefunds(env);

  assert.equal(txCount, 1, "retryFailedRefunds + grantReward + creditTokens must execute inside a SINGLE queryDbTransaction");

  const lock1Idx = txQueries.findIndex(q => q.includes("SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE"));
  const lock2Idx = txQueries.findIndex(q => q.includes("SELECT balance FROM token_balances WHERE user_id = $1 FOR UPDATE"));
  const lock3Idx = txQueries.findIndex(q => q.includes("FROM pending_refunds WHERE id = $1 FOR UPDATE"));
  const claimIdx = txQueries.findIndex(q => q.includes("UPDATE pending_refunds SET status = 'processing'"));
  const lock4Idx = txQueries.findIndex(q => q.includes("FROM token_transactions WHERE ref_id = $1 FOR UPDATE"));
  const creditIdx = txQueries.findIndex(q => q.includes("WITH tx_insert AS"));
  const completeIdx = txQueries.findIndex(q => q.includes("UPDATE pending_refunds SET status = 'completed'"));

  assert.ok(lock1Idx > -1 && lock2Idx > -1 && lock3Idx > -1 && claimIdx > -1 && lock4Idx > -1 && creditIdx > -1 && completeIdx > -1, "All lifecycle steps must run inside txQuery");
  assert.ok(lock1Idx < lock2Idx, "Lock 1 (users FOR UPDATE) must precede Lock 2 (token_balances FOR UPDATE)");
  assert.ok(lock2Idx < lock3Idx, "Lock 2 (token_balances FOR UPDATE) must precede Lock 3 (pending_refunds FOR UPDATE)");
  assert.ok(lock3Idx < claimIdx && claimIdx < lock4Idx, "Lock 3 + claim must precede Lock 4 (token_transactions FOR UPDATE)");
  assert.ok(lock4Idx < creditIdx && creditIdx < completeIdx, "Lock 4 must precede credit CTE, which must precede fenced status=completed");
});

test("5T-SCHEMA-PARITY-01: Composite index (user_id, tx_type, ref_id) does not hide cross-user or cross-type ref_id conflicts even when multiple rows exist", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };

  // With the real composite index (user_id, tx_type, ref_id), insert TWO rows with the same ref_id:
  // Row 1: valid row for user 99003 (marketplace_refund, 50)
  // Row 2: conflicting row for user 99004 (marketplace_refund, 50) sharing the same ref_id
  // Previously LIMIT 1 would only see Row 1 and miss Row 2!
  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('99003', 'u_99003'), ('99004', 'u_99004');
    INSERT INTO token_balances (user_id, balance) VALUES ('99003', 100), ('99004', 100);
    INSERT INTO token_transactions (user_id, amount, tx_type, source, status, ref_id) VALUES
      ('99003', 50, 'marketplace_refund', 'marketplace', 'completed', 'dup_composite_ref'),
      ('99004', 50, 'marketplace_refund', 'marketplace', 'completed', 'dup_composite_ref');
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, status) VALUES
      ('99003', 50, 'dup_composite_ref', 'pending');
  `);

  // 1. deleteAccount must detect the second conflicting row and rollback
  const userRepo = createUserRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  await assert.rejects(
    async () => userRepo.deleteAccount(env, "99003"),
    /Refund ref_id conflict mismatch/
  );
  assert.equal(db.public.many("SELECT * FROM users WHERE telegram_id = '99003'").length, 1, "User 99003 must not be deleted when composite conflict exists");

  // 2. retryFailedRefunds must also detect the second conflicting row, rollback, and increment retry_count
  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction, queryDbDirect: queryDb });
  const economyService = createEconomyService({ walletRepo, queryDb });
  const referralService = createReferralRewardsService({
    queryDb,
    queryDbTransaction,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await referralService.retryFailedRefunds(env);
  const pref = db.public.many("SELECT status, retry_count FROM pending_refunds WHERE user_id = '99003'")[0];
  assert.equal(pref.status, "pending", "Conflicting refund must not be marked completed");
  assert.equal(pref.retry_count, 1, "Failed conflict must increment retry_count via fenced catch handler");
});

test("5T-CRASH-SIMULATION: Atomic rollback when completion fencing fails after creditTokens, and exhausted transition at retry 10", async () => {
  const { db, queryDb, queryDbTransaction } = setupMockDatabase();
  const env = { APP_ENV: "test" };
  const USER_CS = "99005";

  db.public.many(`
    INSERT INTO users (telegram_id, username) VALUES ('${USER_CS}', 'cs_user');
    INSERT INTO token_balances (user_id, balance) VALUES ('${USER_CS}', 100);
    INSERT INTO pending_refunds (user_id, amount, refund_ref_id, source, description, status, retry_count)
    VALUES ('${USER_CS}', 60, 'cs_ref_1', 'alert', 'Crash sim refund', 'pending', 9);
  `);

  // Simulate failure at the final UPDATE pending_refunds SET status = 'completed' AFTER creditTokens has already inserted tx and updated balance inside txQuery
  const failOnCompleteTx = (e, fn) => queryDbTransaction(e, async (txQuery) => {
    return fn(async (sql, params) => {
      if (String(sql).includes("UPDATE pending_refunds SET status = 'completed'")) {
        return { rows: [], rowCount: 0 };
      }
      return txQuery(sql, params);
    });
  });

  const walletRepo = createWalletRepository({ queryDb, queryDbTransaction: failOnCompleteTx, queryDbDirect: queryDb });
  const economyService = createEconomyService({ walletRepo, queryDb });
  const referralService = createReferralRewardsService({
    queryDb,
    queryDbTransaction: failOnCompleteTx,
    notificationService: null,
    walletRepo,
    rewardCenterRepo: null,
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => (s ? String(s) : null),
    resolveWebAppUrl: () => "https://example.com",
    safeError: () => "error",
    getMissionRewardAmount: () => 10,
    economyService,
    membershipAuthority: null,
    ENTITLEMENT: {},
    getUserRepo: () => null
  });

  await referralService.retryFailedRefunds(env);

  // Because creditTokens and UPDATE status='completed' share the same transaction, the +60 credit MUST be rolled back!
  const bal = db.public.many(`SELECT balance FROM token_balances WHERE user_id = '${USER_CS}'`)[0].balance;
  assert.equal(bal, 100, "Wallet balance must roll back to 100 when status=completed fails inside the shared transaction");
  const txs = db.public.many(`SELECT * FROM token_transactions WHERE user_id = '${USER_CS}'`);
  assert.equal(txs.length, 0, "Inserted token_transactions row must roll back when status=completed fails");

  // And because retry_count was 9 (9 + 1 >= 10), the fenced catch handler must transition status to exhausted
  const pref = db.public.many(`SELECT status, retry_count FROM pending_refunds WHERE user_id = '${USER_CS}'`)[0];
  assert.equal(pref.retry_count, 10, "retry_count must increment from 9 to 10");
  assert.equal(pref.status, "exhausted", "Refund must transition to exhausted on 10th failure");
});

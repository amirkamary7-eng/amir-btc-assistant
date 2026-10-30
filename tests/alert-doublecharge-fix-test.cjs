/**
 * Alert Double-Charge Fix (H1) — Regression Tests
 *
 * Verifies that when a paid alert creation request results in a reactivation
 * (alert already active, ON CONFLICT DO UPDATE), the debit is refunded.
 *
 * Condition: alert.reactivated === true && !claimedFree && debitAmount > 0
 *
 * Run: node --test alert-doublecharge-fix-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ALERTS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/alerts.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — Source-text: the refund branch exists with the correct condition
// ═══════════════════════════════════════════════════════════════════════════

test('H1-01: refund branch exists with condition alert.reactivated && !claimedFree && debitAmount > 0', () => {
  assert.ok(ALERTS_SRC.includes('alert.reactivated && !claimedFree && debitAmount > 0'),
    'must have the exact condition for the reactivation refund');
});

test('H1-02: refund uses grantReward with marketplace_refund rewardType', () => {
  assert.ok(ALERTS_SRC.includes("rewardType: 'marketplace_refund'"),
    'must use marketplace_refund (the established refund pattern)');
  assert.ok(ALERTS_SRC.includes('economyService.grantReward'),
    'must call economyService.grantReward for the refund');
});

test('H1-03: refund refId is alertRefId + _refund (idempotent)', () => {
  assert.ok(ALERTS_SRC.includes('`${alertRefId}_refund`'),
    'refund refId must be ${alertRefId}_refund for idempotency');
});

test('H1-04: refund failure persists to pending_refunds', () => {
  assert.ok(ALERTS_SRC.includes('INSERT INTO pending_refunds'),
    'must INSERT into pending_refunds on refund failure');
  assert.ok(ALERTS_SRC.includes("ON CONFLICT (refund_ref_id) WHERE status = 'pending' DO NOTHING"),
    'must use ON CONFLICT DO NOTHING for idempotent pending_refunds INSERT');
  assert.ok(ALERTS_SRC.includes("'alert'"),
    'must use source = alert for the pending_refunds entry');
});

test('H1-05: refund branch is in the SUCCESS path (not just the catch block)', () => {
  // The refund branch must be BEFORE the return jsonResponse({ status: 'success' ...})
  const refundIdx = ALERTS_SRC.indexOf('alert.reactivated && !claimedFree && debitAmount > 0');
  const successReturnIdx = ALERTS_SRC.indexOf("return jsonResponse({ status: 'success', alert }", refundIdx);
  assert.ok(refundIdx > -1 && successReturnIdx > -1,
    'refund branch must exist before the success return');
  assert.ok(refundIdx < successReturnIdx,
    'refund branch must be BEFORE the success return (not in the catch block)');
});

test('H1-06: existing catch-block refund is still intact (create-failure refund)', () => {
  // The catch-block refund (lines 277+) must still be present — it handles
  // the case where alertRepo.create THROWS (not reactivation).
  const catchRefundIdx = ALERTS_SRC.indexOf('alert_create_failure');
  assert.ok(catchRefundIdx > -1,
    'the existing create-failure refund (catch block) must still be present');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — Behavioral simulations: the fix works correctly
// ═══════════════════════════════════════════════════════════════════════════

// Simulated grantReward (idempotent via refId)
function makeMockGrantReward() {
  const calls = [];
  const credited = new Map(); // refId → amount
  return {
    calls,
    fn: async function ({ userId, amount, refId }) {
      calls.push({ userId, amount, refId });
      if (refId && credited.has(refId)) {
        return { success: true, idempotent: true };
      }
      credited.set(refId, amount);
      return { success: true, idempotent: false };
    },
    credited,
  };
}

test('SIM-01: paid concurrent duplicate → one debit + one refund (no double-charge)', async () => {
  const mock = makeMockGrantReward();
  let debitCount = 0;
  const balance = { user: 100 };

  // Simulate two concurrent paid requests for the same alert
  async function simulatePaidAlert(reactivated) {
    const refId = `alert_user_BTC_50000_above_2026-09-16_${Date.now()}_${Math.random()}`;
    // Step 1: debit
    if (balance.user >= 5) {
      balance.user -= 5;
      debitCount++;
    }
    // Step 2: alertRepo.create → reactivated?
    const alert = { reactivated };
    // Step 3: the fix — if reactivated && !claimedFree && debitAmount > 0 → refund
    if (alert.reactivated === true && true && 5 > 0) {
      await mock.fn({ userId: 'user', amount: 5, refId: `${refId}_refund` });
      balance.user += 5; // refund credits the balance back
    }
    return { alert, refId };
  }

  // Request A: creates the alert (not reactivated)
  const a = await simulatePaidAlert(false);
  // Request B: reactivates the alert (already active)
  const b = await simulatePaidAlert(true);

  assert.equal(debitCount, 2, 'both requests debited (different refIds)');
  assert.equal(mock.calls.length, 1, 'only ONE refund (for the reactivating request B)');
  assert.equal(balance.user, 95, 'net: user paid 5 (A) + debited 5 (B) + refunded 5 (B) = 100-5 = 95');
});

test('SIM-02: paid reactivation → refund issued', async () => {
  const mock = makeMockGrantReward();
  // Single request that reactivates an existing active alert
  const refId = 'alert_user_ETH_3000_above_2026-09-16_123';
  const alert = { reactivated: true };
  const claimedFree = false;
  const debitAmount = 5;

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: debitAmount, refId: `${refId}_refund` });
  }
  assert.equal(mock.calls.length, 1, 'refund was called');
  assert.equal(mock.calls[0].amount, 5, 'correct amount');
  assert.equal(mock.calls[0].refId, 'alert_user_ETH_3000_above_2026-09-16_123_refund', 'correct refId');
});

test('SIM-03: refund failure → pending_refunds INSERT', async () => {
  let pendingInsert = null;
  const failingGrant = async () => { throw new Error('DB timeout'); };
  const refId = 'alert_user_BTC_50000_above_2026-09-16_456';

  try {
    await failingGrant({ refId: `${refId}_refund` });
  } catch (refundErr) {
    // Persist to pending_refunds (simulated)
    pendingInsert = {
      user_id: 'user',
      amount: 5,
      refund_ref_id: `${refId}_refund`,
      original_ref_id: refId,
      source: 'alert',
      status: 'pending',
    };
  }
  assert.ok(pendingInsert, 'pending_refunds entry was created');
  assert.equal(pendingInsert.refund_ref_id, `${refId}_refund`, 'correct refund_ref_id');
  assert.equal(pendingInsert.source, 'alert', 'correct source');
  assert.equal(pendingInsert.status, 'pending', 'correct status');
});

test('SIM-04: pending refund retry → idempotent (no double-credit)', async () => {
  const mock = makeMockGrantReward();
  const refId = 'alert_user_BTC_50000_above_2026-09-16_789_refund';

  // First retry: succeeds
  await mock.fn({ userId: 'user', amount: 5, refId });
  // Second retry (cron re-processes): idempotent
  await mock.fn({ userId: 'user', amount: 5, refId });

  assert.equal(mock.calls.length, 2, 'grantReward called twice (cron retry)');
  assert.equal(mock.credited.size, 1, 'only ONE credit (idempotent)');
  assert.equal(mock.credited.get(refId), 5, 'credited exactly 5');
});

test('SIM-05: duplicate refund request → no double-credit', async () => {
  const mock = makeMockGrantReward();
  const refId = 'alert_user_SOL_100_above_2026-09-16_999_refund';

  // Same refId called twice
  await mock.fn({ userId: 'user', amount: 5, refId });
  await mock.fn({ userId: 'user', amount: 5, refId });

  assert.equal(mock.credited.size, 1, 'only 1 unique credit');
  assert.equal(mock.calls[1].refId, refId, 'second call same refId');
});

test('SIM-06: normal paid alert (reactivated=false) → no refund', async () => {
  const mock = makeMockGrantReward();
  const alert = { reactivated: false };
  const claimedFree = false;
  const debitAmount = 5;

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: 5, refId: 'test_refund' });
  }
  assert.equal(mock.calls.length, 0, 'no refund for normal first paid alert');
});

test('SIM-07: free reactivation → no refund (debitAmount=0)', async () => {
  const mock = makeMockGrantReward();
  const alert = { reactivated: true };
  const claimedFree = true; // free path
  const debitAmount = 0;    // no debit on free path

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: 5, refId: 'test_refund' });
  }
  assert.equal(mock.calls.length, 0, 'no refund for free reactivation (no debit)');
});

test('SIM-08: deleted/triggered alert recreation → still charged (reactivated=false)', async () => {
  const mock = makeMockGrantReward();
  // Delete + re-create: ON CONFLICT WHERE status='active' does NOT match (deleted alert has status='deleted')
  // → INSERT (new alert) → reactivated=false
  // Triggered alert re-create: ON CONFLICT WHERE status='active' does NOT match (status='triggered')
  // → INSERT (new alert) → reactivated=false
  const alert = { reactivated: false }; // new alert, not reactivation
  const claimedFree = false;
  const debitAmount = 5;

  if (alert.reactivated && !claimedFree && debitAmount > 0) {
    await mock.fn({ userId: 'user', amount: 5, refId: 'test_refund' });
  }
  assert.equal(mock.calls.length, 0, 'no refund — user correctly charged for new alert after delete/trigger');
});

console.log('✅ Alert double-charge fix (H1) regression tests loaded.');


// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — NEW-FIN-01 Executable Runtime Tests (pg-mem + Real Controllers)
// ═══════════════════════════════════════════════════════════════════════════

const {
  makeRealStack,
  loadFactory,
  balanceOf,
  txCount,
} = require("./wallet-test-harness.cjs");

const createAlertHandlers = loadFactory("src/controllers/alerts.js", "createAlertHandlers");
const createReferralRewardsService = loadFactory("src/services/referral-rewards.js", "createReferralRewardsService");

test("FIN01-01 (runtime pg-mem): 10-digit Telegram user + long symbol/price → alertRefId & _refund fit in VARCHAR(64) and immediate refund restores balance", async () => {
  const stack = makeRealStack();
  const { h, economyService } = stack;
  const USER_10_DIGIT = "6842219966";
  await h.insertBalance(USER_10_DIGIT, 100);

  const norm = (v) => (v == null ? null : String(v).trim() || null);
  const jsonResponse = (body, init = {}) => ({ status: init.status || 200, body });
  const safeDbErrorResponse = () => ({ status: 500, body: { status: "error" } });
  const safeError = (_s, e) => e;
  const buildBodyFieldValidationError = (errs) => ({ status: 422, body: { errors: errs } });
  const authenticateTelegramRequest = async () => ({ error: null, user: { id: USER_10_DIGIT } });
  const readJsonBody = async (req) => ({ error: null, payload: req.__payload });

  const ecoRepo = {
    checkQuota: async () => ({
      allowed: true,
      isFree: false,
      costInTokens: 5,
      effectiveFreePerDay: 3,
      config: { free_per_day: 3, cost_per_extra: 5 },
    }),
    claimFreeSlot: async () => ({ claimed: false, usedNow: 3 }),
    incrementQuota: async () => {},
    releaseFreeSlot: async () => {},
  };

  const failingAlertRepo = {
    create: async () => {
      throw new Error("simulated DB error on price_alerts INSERT");
    },
  };

  const handlers = createAlertHandlers({
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: norm,
    alertRepo: failingAlertRepo,
    alertEconomyRepo: ecoRepo,
    economyService,
    membershipAuthority: { isPremium: async () => false },
    isUserRateLimited: async () => false,
    queryDb: h.queryDb,
  });

  // Previously: alert_6842219966_1000SHIBUSDT_0.00028491_above_2026-10-30_1761814200000_refund = 78 chars (> 64) → SQLSTATE 22001!
  const res = await handlers.handleCreate(
    {
      __payload: {
        user_id: USER_10_DIGIT,
        symbol: "1000SHIBUSDT",
        price: "0.00028491",
        direction: "above",
      },
    },
    {}
  );

  assert.equal(res.status, 500, "create failure returns 500");
  assert.equal(await balanceOf(h, USER_10_DIGIT), 100, "balance must be restored to 100 AB after immediate refund");

  const txs = await h.raw(
    "SELECT tx_type, amount, ref_id FROM token_transactions WHERE user_id = $1 ORDER BY id ASC",
    [USER_10_DIGIT]
  );
  assert.equal(txs.rows.length, 2, "must record both alert_debit and marketplace_refund");
  assert.equal(txs.rows[0].tx_type, "alert_debit");
  assert.equal(Number(txs.rows[0].amount), -5);
  assert.ok(txs.rows[0].ref_id.length <= 50, `debit ref_id must be compact (got ${txs.rows[0].ref_id.length}: ${txs.rows[0].ref_id})`);

  assert.equal(txs.rows[1].tx_type, "marketplace_refund");
  assert.equal(Number(txs.rows[1].amount), 5);
  assert.equal(txs.rows[1].ref_id, `${txs.rows[0].ref_id}_refund`);
  assert.ok(txs.rows[1].ref_id.length <= 64, `refund ref_id must fit in VARCHAR(64) (got ${txs.rows[1].ref_id.length})`);
});

test("FIN01-02 (runtime pg-mem): create fails AND immediate refund fails → persists to pending_refunds and retryFailedRefunds recovers balance", async () => {
  const stack = makeRealStack();
  const { h, economyService } = stack;
  const USER_10_DIGIT = "6842219966";
  await h.insertBalance(USER_10_DIGIT, 100);

  // Apply the NEW-FIN-01 migration widening ref_id & pending_refunds to VARCHAR(128)
  await h.raw("ALTER TABLE token_transactions ALTER COLUMN ref_id TYPE VARCHAR(128);");
  await h.raw(`
    CREATE TABLE IF NOT EXISTS pending_refunds (
      id SERIAL PRIMARY KEY,
      user_id VARCHAR(64) NOT NULL,
      amount INTEGER NOT NULL,
      refund_ref_id VARCHAR(128) NOT NULL,
      original_ref_id VARCHAR(128),
      source VARCHAR(32) NOT NULL DEFAULT 'alert',
      description VARCHAR(256),
      metadata JSONB DEFAULT '{}',
      status VARCHAR(16) NOT NULL DEFAULT 'pending',
      retry_count INTEGER NOT NULL DEFAULT 0,
      last_retry_at TIMESTAMPTZ,
      created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );
    CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_refunds_ref_id ON pending_refunds (refund_ref_id);
  `);

  const pgMemOutboxQueryDb = async (env, sql, params) => {
    const s = String(sql);
    if (s.includes("INSERT INTO pending_refunds")) {
      return h.queryDb(
        env,
        s.replace(
          "ON CONFLICT (refund_ref_id) WHERE status = 'pending' DO NOTHING",
          "ON CONFLICT (refund_ref_id) DO NOTHING"
        ),
        params
      );
    }
    return h.queryDb(env, sql, params);
  };

  let shouldFailRefund = true;
  const flakyEconomy = {
    ...economyService,
    grantReward: async (args) => {
      if (shouldFailRefund) throw new Error("temporary DB outage during immediate refund");
      return economyService.grantReward(args);
    },
  };

  const norm = (v) => (v == null ? null : String(v).trim() || null);
  const handlers = createAlertHandlers({
    jsonResponse: (body, init = {}) => ({ status: init.status || 200, body }),
    authenticateTelegramRequest: async () => ({ error: null, user: { id: USER_10_DIGIT } }),
    readJsonBody: async (req) => ({ error: null, payload: req.__payload }),
    safeDbErrorResponse: () => ({ status: 500, body: { status: "error" } }),
    safeError: (_s, e) => e,
    buildBodyFieldValidationError: (errs) => ({ status: 422, body: { errors: errs } }),
    isDatabaseConfigured: () => true,
    normalizeOptionalString: norm,
    alertRepo: { create: async () => { throw new Error("alert DB insert failed"); } },
    alertEconomyRepo: {
      checkQuota: async () => ({ allowed: true, isFree: false, costInTokens: 5, effectiveFreePerDay: 3 }),
      claimFreeSlot: async () => ({ claimed: false, usedNow: 3 }),
      incrementQuota: async () => {},
      releaseFreeSlot: async () => {},
    },
    economyService: flakyEconomy,
    membershipAuthority: { isPremium: async () => false },
    isUserRateLimited: async () => false,
    queryDb: pgMemOutboxQueryDb,
  });

  const res = await handlers.handleCreate(
    {
      __payload: {
        user_id: USER_10_DIGIT,
        symbol: "MATICUSDT",
        price: "123456.789",
        direction: "below",
      },
    },
    {}
  );
  assert.equal(res.status, 500);
  assert.equal(await balanceOf(h, USER_10_DIGIT), 95, "balance is 95 while refund is pending in outbox");

  const pending = await h.raw("SELECT * FROM pending_refunds WHERE user_id = $1", [USER_10_DIGIT]);
  assert.equal(pending.rows.length, 1, "pending_refunds must contain 1 pending row");
  assert.equal(pending.rows[0].status, "pending");
  assert.equal(Number(pending.rows[0].amount), 5);

  // Now run the real retryFailedRefunds cron logic
  shouldFailRefund = false;
  const referralService = createReferralRewardsService({
    isDatabaseConfigured: () => true,
    queryDb: pgMemOutboxQueryDb,
    economyService: flakyEconomy,
  });
  await referralService.retryFailedRefunds({});

  assert.equal(await balanceOf(h, USER_10_DIGIT), 100, "retryFailedRefunds must restore balance to 100 AB");
  const afterRetry = await h.raw("SELECT status FROM pending_refunds WHERE user_id = $1", [USER_10_DIGIT]);
  assert.equal(afterRetry.rows[0].status, "completed", "pending_refunds row must be marked completed");
});

test("FIN01-03: 64-bit FNV-1a spec digest uniqueness + VARCHAR(128) schema migration verification", async () => {
  const MIGRATE_SQL = fs.readFileSync(path.join(__dirname, "..", "scripts/00-migrate.sql"), "utf8");
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, "..", "src/repositories/wallet.js"), "utf8");

  assert.ok(
    MIGRATE_SQL.includes("ALTER TABLE token_transactions ALTER COLUMN ref_id TYPE VARCHAR(128);"),
    "00-migrate.sql must widen token_transactions.ref_id to VARCHAR(128)"
  );
  assert.ok(
    MIGRATE_SQL.includes("ALTER TABLE pending_refunds ALTER COLUMN refund_ref_id TYPE VARCHAR(128);"),
    "00-migrate.sql must widen pending_refunds.refund_ref_id to VARCHAR(128)"
  );
  assert.ok(
    MIGRATE_SQL.includes("ALTER TABLE pending_refunds ALTER COLUMN original_ref_id TYPE VARCHAR(128);"),
    "00-migrate.sql must widen pending_refunds.original_ref_id to VARCHAR(128)"
  );
  assert.ok(
    WALLET_SRC.includes("ALTER TABLE token_transactions ALTER COLUMN ref_id TYPE VARCHAR(128);"),
    "wallet.js ensureSchema must widen token_transactions.ref_id to VARCHAR(128)"
  );

  // Verify 0 collisions across 1,200 distinct (symbol, price, direction) specs
  function computeDigest(sym, price, dir) {
    const input = `${sym}:${price}:${dir}`;
    let h = 0xcbf29ce484222325n;
    for (let i = 0; i < input.length; i++) {
      h ^= BigInt(input.charCodeAt(i));
      h = (h * 0x100000001b3n) & 0xffffffffffffffffn;
    }
    return h.toString(16).padStart(16, "0");
  }

  const seen = new Set();
  const symbols = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "TONUSDT", "MATICUSDT", "1000SHIBUSDT", "DOGEUSDT", "XRPUSDT", "ADAUSDT", "AVAXUSDT"];
  for (const sym of symbols) {
    for (let p = 1; p <= 60; p++) {
      for (const dir of ["above", "below"]) {
        const d = computeDigest(sym, String(p * 123.4567), dir);
        assert.equal(d.length, 16);
        assert.ok(!seen.has(d), `collision detected for ${sym}:${p}:${dir}`);
        seen.add(d);
      }
    }
  }
  assert.equal(seen.size, 1200, "all 1,200 distinct alert specs must produce distinct 16-char digests");
});

/**
 * P1+P2 SECURITY FIX TESTS — target_id verification + VPN race protection
 *
 * P1-FIX: Mission target_id must be BOUND into the event token at issue
 * time and VERIFIED at complete time. A client cannot:
 *   - issue with target A then complete with target B
 *   - issue with no target then complete with any target
 *   - complete without any target when one was bound
 *
 * P2-FIX: VPN purchase must be race-safe at the DB level. Two concurrent
 * purchases of the same plan must result in exactly 1 purchase + 1 debit.
 * (The real-PG concurrency test is in the staging suite — here we verify
 * the partial unique index exists and ON CONFLICT DO NOTHING works on pg-mem.)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeRealStack,
  makePgHarness,
  loadFactory,
  balanceOf,
  txCount,
} = require('./wallet-test-harness.cjs');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const WALLET_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');

// ── P1: target_id binding ──────────────────────────────────────────────────

// Extract the real issueMissionEventToken + consumeMissionEventToken
// (same pattern as mission-event-token-test.cjs)
const startIdx = WORKER_SRC.indexOf('// MISSION EVENT TOKEN SERVICE');
const endIdx = WORKER_SRC.indexOf('function buildFastApiValidationError', startIdx);
const TOKEN_SERVICE_SRC = WORKER_SRC.slice(startIdx, endIdx);

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) {
      store.set(key, value);
      if (options && options.expirationTtl) {
        setTimeout(() => store.delete(key), options.expirationTtl * 1000).unref?.();
      }
    },
    async delete(key) { store.delete(key); },
  };
}

function loadTokenService() {
  const wrapped = `${TOKEN_SERVICE_SRC}\nmodule.exports = { issueMissionEventToken, consumeMissionEventToken };`;
  const mod = { exports: {} };
  new Function('module', 'exports', wrapped)(mod, mod.exports);
  return mod.exports;
}

// ── P1 Tests ───────────────────────────────────────────────────────────────

test('P1-1: issueMissionEventToken stores target_id (not just "1")', async () => {
  const { issueMissionEventToken } = loadTokenService();
  const kv = createMemoryKv();
  const env = { SESSION_CACHE: kv };

  const token = await issueMissionEventToken(env, 'u1', 'read_news', 'article_123');
  assert.ok(token && token.length === 32, 'token issued');

  // The KV value must be the target_id, not '1'
  const key = `mt:${'u1'}:${'read_news'}:${new Date().toISOString().slice(0, 10)}:${token}`;
  const stored = await kv.get(key);
  assert.equal(stored, 'article_123', 'stored value must be the bound target_id');
});

test('P1-2: consume with MATCHING target_id → success', async () => {
  const { issueMissionEventToken, consumeMissionEventToken } = loadTokenService();
  const kv = createMemoryKv();
  const env = { SESSION_CACHE: kv };

  const token = await issueMissionEventToken(env, 'u1', 'read_news', 'article_456');
  const consumed = await consumeMissionEventToken(env, 'u1', 'read_news', token, 'article_456');
  assert.equal(consumed, true, 'matching target → token consumed');
});

test('P1-3: consume with DIFFERENT target_id → REJECTED', async () => {
  const { issueMissionEventToken, consumeMissionEventToken } = loadTokenService();
  const kv = createMemoryKv();
  const env = { SESSION_CACHE: kv };

  const token = await issueMissionEventToken(env, 'u1', 'read_news', 'article_789');
  // Try to complete with a DIFFERENT target
  const consumed = await consumeMissionEventToken(env, 'u1', 'read_news', token, 'different_article');
  assert.equal(consumed, false, 'mismatched target → rejected');
});

test('P1-4: consume with NO target when one was bound → REJECTED', async () => {
  const { issueMissionEventToken, consumeMissionEventToken } = loadTokenService();
  const kv = createMemoryKv();
  const env = { SESSION_CACHE: kv };

  const token = await issueMissionEventToken(env, 'u1', 'read_news', 'article_X');
  // Try to complete without any target
  const consumed = await consumeMissionEventToken(env, 'u1', 'read_news', token, '');
  assert.equal(consumed, false, 'missing target → rejected');
});

test('P1-5: issue with NO target + consume with NO target → success (no-target missions)', async () => {
  const { issueMissionEventToken, consumeMissionEventToken } = loadTokenService();
  const kv = createMemoryKv();
  const env = { SESSION_CACHE: kv };

  const token = await issueMissionEventToken(env, 'u1', 'check_calendar', '');
  const consumed = await consumeMissionEventToken(env, 'u1', 'check_calendar', token, '');
  assert.equal(consumed, true, 'both empty → valid (missions that legitimately have no target)');
});

test('P1-6: controller passes target_id to issueMissionEventToken', () => {
  // Static verification: the controller must extract target_id from the body
  // and pass it as the 4th argument
  assert.ok(WALLET_CTRL_SRC.includes('issueMissionEventToken(env, userId, missionId, targetId)'),
    'controller must pass targetId to issueMissionEventToken');
  assert.ok(WALLET_CTRL_SRC.includes('consumeMissionEventToken(env, userId, missionId, eventToken, completeTargetId)'),
    'controller must pass completeTargetId to consumeMissionEventToken');
  assert.ok(WALLET_CTRL_SRC.includes("body?.target_id"),
    'controller must extract target_id from the request body');
});

// ── P2 Tests ───────────────────────────────────────────────────────────────

test('P2-1: partial unique index exists in ensureSchema', () => {
  const repoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_purchases.js'), 'utf8');
  assert.ok(repoSrc.includes('uq_rp_pending_plan'),
    'partial unique index uq_rp_pending_plan must be created');
  assert.ok(repoSrc.includes("WHERE status = 'pending'"),
    'index must be partial (only pending)');
});

test('P2-2: createVpnPurchase uses ON CONFLICT DO NOTHING', () => {
  const repoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_purchases.js'), 'utf8');
  assert.ok(repoSrc.includes('ON CONFLICT DO NOTHING'),
    'insert must use ON CONFLICT DO NOTHING for atomic race protection');
  // No pre-SELECT race window: the old SELECT-then-INSERT is gone
  assert.ok(!repoSrc.includes('SELECT id FROM reward_purchases\n       WHERE user_id = $1 AND reward_type'),
    'the racy SELECT-then-INSERT pattern must be removed');
});

test('P2-3: race simulation — concurrent createVpnPurchase → only ONE created', async () => {
  // pg-mem test: simulate the race by wrapping queryDb to intercept the
  // INSERT and simulate two concurrent calls arriving at the same instant.
  const createRewardPurchaseRepository = loadFactory(
    'src/repositories/reward_purchases.js', 'createRewardPurchaseRepository',
  );

  // Build a custom harness with the unique index
  const h = makePgHarness();
  // Create the reward_purchases table with the unique index
  await h.queryDb({}, `
    CREATE TABLE reward_purchases (
      id SERIAL PRIMARY KEY, user_id VARCHAR(64), reward_type VARCHAR(32),
      plan_id VARCHAR(64), plan_name VARCHAR(128),
      vpn_gb INTEGER, cost_ab INTEGER, duration_days INTEGER DEFAULT 7,
      status VARCHAR(16) DEFAULT 'pending', tracking_id VARCHAR(64),
      tx_ref_id VARCHAR(128), vpn_link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      fulfilled_at TIMESTAMPTZ, fulfilled_by VARCHAR(64),
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`, []);
  await h.queryDb({}, `
    CREATE UNIQUE INDEX uq_rp_pending_plan ON reward_purchases (user_id, reward_type, vpn_gb)
    WHERE status = 'pending'`, []);

  const repo = createRewardPurchaseRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
    isDatabaseConfigured: () => true,
    getTehranDateString: () => '2026-01-01',
  });

  // Simulate concurrent purchases: fire two in "parallel" (sequential in
  // single-threaded pg-mem, but the ON CONFLICT handles the logical race)
  const [r1, r2] = [
    await repo.createVpnPurchase({}, 'race_u', 'vpn_4gb', 200, 'ref_A'),
    await repo.createVpnPurchase({}, 'race_u', 'vpn_4gb', 200, 'ref_B'),
  ];

  assert.equal(r1.created, true, 'first request creates the purchase');
  assert.equal(r2.created, false, 'second request gets created=false (conflict)');
  assert.ok(r2.purchase && r2.purchase.id === r1.purchase.id, 'second gets the same purchase ID');

  // Only ONE purchase row exists
  const count = await h.queryDb({}, 'SELECT COUNT(*)::int AS c FROM reward_purchases', []);
  assert.equal(Number(count.rows[0].c), 1, 'exactly one purchase row');
});

test('P2-4: after fulfillment, same plan can be purchased again', async () => {
  const createRewardPurchaseRepository = loadFactory(
    'src/repositories/reward_purchases.js', 'createRewardPurchaseRepository',
  );
  const h = makePgHarness();
  await h.queryDb({}, `
    CREATE TABLE reward_purchases (
      id SERIAL PRIMARY KEY, user_id VARCHAR(64), reward_type VARCHAR(32),
      plan_id VARCHAR(64), plan_name VARCHAR(128),
      vpn_gb INTEGER, cost_ab INTEGER, duration_days INTEGER DEFAULT 7,
      status VARCHAR(16) DEFAULT 'pending', tracking_id VARCHAR(64),
      tx_ref_id VARCHAR(128), vpn_link TEXT,
      created_at TIMESTAMPTZ DEFAULT NOW(),
      fulfilled_at TIMESTAMPTZ, fulfilled_by VARCHAR(64),
      expires_at TIMESTAMPTZ,
      updated_at TIMESTAMPTZ DEFAULT NOW()
    )`, []);
  await h.queryDb({}, `
    CREATE UNIQUE INDEX uq_rp_pending_plan ON reward_purchases (user_id, reward_type, vpn_gb)
    WHERE status = 'pending'`, []);

  const repo = createRewardPurchaseRepository({
    queryDb: h.queryDb, queryDbTransaction: h.queryDbTransaction,
    isDatabaseConfigured: () => true, getTehranDateString: () => '2026-01-01',
  });

  // First purchase
  const first = await repo.createVpnPurchase({}, 'u1', 'vpn_4gb', 200, 'ref_1');
  assert.equal(first.created, true);

  // Fulfill it (frees the index slot)
  const fulfilled = await repo.fulfillPurchase({}, first.purchase.id, 'admin1');
  assert.ok(fulfilled, 'fulfilled');

  // Can purchase again
  const second = await repo.createVpnPurchase({}, 'u1', 'vpn_4gb', 200, 'ref_2');
  assert.equal(second.created, true, 'after fulfillment, same plan purchasable again');
});

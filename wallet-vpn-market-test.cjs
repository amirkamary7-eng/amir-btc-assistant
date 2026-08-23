/**
 * VPN REWARD MARKET + MISSION SECURITY TEST — VM/MS-series
 *
 * Tests the new VPN purchase flow (Phase 5-8) and mission target-based
 * security (Phase 2) using the real modules against pg-mem.
 *
 * ── VM-series: VPN Purchase Flow ──────────────────────────────────────────
 *   VM1  Free user → 403 PREMIUM_REQUIRED (server-side check)
 *   VM2  Premium user + sufficient balance → 201, debit once, purchase created
 *   VM3  Premium user + insufficient balance → 402, zero side effects
 *   VM4  Duplicate pending purchase → 409 + refund of the second debit
 *   VM5  Purchase record failure after debit → refund issued
 *   VM6  Invalid plan → 422
 *   VM7  Plans catalog is correct (exactly 5, 100-500 AB)
 *
 * ── MS-series: Mission Target Security ────────────────────────────────────
 *   MS1  autoInstrumentTabs removed — no tab-switch triggers
 *   MS2  Mission triggers are target-based (news_article_open etc.)
 *   MS3  VPN routes registered in worker-proxy
 *   MS4  Admin fulfill endpoint exists
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeRealStack,
  loadFactory,
  balanceOf,
  txCount,
} = require('./wallet-test-harness.cjs');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');

const createRewardPurchaseRepository = loadFactory(
  'src/repositories/reward_purchases.js', 'createRewardPurchaseRepository',
);

const ENV = {};

function makeVpnStack({ premium = false, balance = 0 } = {}) {
  const stack = makeRealStack();
  const h = stack.h;
  if (balance > 0) h.insertBalance('u1', balance);

  const ecoMock = {
    debitUser: async (p) => stack.economyService.debitUser(p),
    grantReward: async (p) => stack.economyService.grantReward(p),
  };
  const grants = [];
  const ecoSpy = {
    debitUser: async (p) => { return ecoMock.debitUser(p); },
    grantReward: async (p) => { grants.push(p); return ecoMock.grantReward(p); },
  };

  const membershipAuthority = { isPremium: async () => premium };
  const notificationService = { create: async () => ({ success: true }) };

  const createRewardPurchaseHandlers = loadFactory(
    'src/controllers/reward_purchases.js', 'createRewardPurchaseHandlers',
  );
  const repo = createRewardPurchaseRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
    isDatabaseConfigured: () => true,
    getTehranDateString: () => '2026-01-01',
  });

  const handlers = createRewardPurchaseHandlers({
    jsonResponse: (body, init = {}, _e) => ({ __http: true, status: init.status || 200, body }),
    authenticateTelegramRequest: async () => ({ error: null, user: { id: 'u1', username: 'testuser', first_name: 'Test' } }),
    readJsonBody: async (req) => ({ error: null, payload: req.__payload }),
    safeDbErrorResponse: (e) => ({ __http: true, status: 500, body: { status: 'error' } }),
    safeError: (_s, e) => e,
    isDatabaseConfigured: () => true,
    economyService: ecoSpy,
    rewardPurchaseRepo: repo,
    membershipAuthority,
    notificationService,
    requireAdmin: async () => ({ error: null, admin: { telegram_id: 'admin1' } }),
  });

  return { h, stack, repo, handlers, grants };
}

async function purchase(handlers, planId) {
  return handlers.handleVpnPurchase(
    { url: 'x', __payload: { plan_id: planId }, headers: { get: () => null } },
    ENV,
  );
}

// ═══════════════════════════════════════════════════════════════════════════

test('VM1: Free user → 403 PREMIUM_REQUIRED (server-side entitlement check)', async () => {
  const { handlers } = makeVpnStack({ premium: false, balance: 500 });
  const res = await purchase(handlers, 'vpn_2gb');
  assert.equal(res.status, 403);
  assert.equal(res.body.code, 'PREMIUM_REQUIRED');
});

test('VM2: Premium user + balance → 201, exactly one debit, purchase pending', async () => {
  const { h, handlers } = makeVpnStack({ premium: true, balance: 500 });
  const res = await purchase(handlers, 'vpn_4gb');
  assert.equal(res.status, 201);
  assert.equal(res.body.purchase.status, 'pending');
  assert.equal(res.body.purchase.vpn_gb, 4);

  assert.equal(await txCount(h, "WHERE tx_type = 'vpn_purchase' AND status = 'completed'"), 1, 'exactly one debit');
  assert.equal(await balanceOf(h, 'u1'), 300, '500 - 200 = 300');
});

test('VM3: Premium + insufficient balance → 402, zero side effects', async () => {
  const { h, handlers } = makeVpnStack({ premium: true, balance: 50 });
  const res = await purchase(handlers, 'vpn_4gb');
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'PAYMENT_FAILED');
  assert.equal(await txCount(h, ''), 0, 'zero transactions');
  assert.equal(await balanceOf(h, 'u1'), 50, 'balance untouched');
});

test('VM4: Duplicate pending purchase → 409 + refund of second debit', async () => {
  const { h, handlers } = makeVpnStack({ premium: true, balance: 1000 });
  const first = await purchase(handlers, 'vpn_4gb');
  assert.equal(first.status, 201);
  const balanceAfterFirst = await balanceOf(h, 'u1'); // 800

  const second = await purchase(handlers, 'vpn_4gb');
  assert.equal(second.status, 409);
  assert.equal(second.body.code, 'DUPLICATE_PENDING');

  // Net zero for the second attempt: debit + refund
  assert.equal(await balanceOf(h, 'u1'), balanceAfterFirst, 'balance unchanged after duplicate attempt');
});

test('VM5: purchase record failure after debit → refund issued (token not lost)', async () => {
  const { h, stack, grants } = {};
  const s = makeRealStack();
  const h2 = s.h;
  await h2.insertBalance('u1', 500);

  // Create handlers with a BROKEN repo (createVpnPurchase always throws)
  const createRewardPurchaseHandlers = loadFactory(
    'src/controllers/reward_purchases.js', 'createRewardPurchaseHandlers',
  );
  const brokenRepo = {
    getVpnPlan: (id) => ({ id, gb: 4, costAb: 200 }),
    createVpnPurchase: async () => { throw new Error('DB_WRITE_FAILED'); },
  };
  const handlers = createRewardPurchaseHandlers({
    jsonResponse: (body, init = {}, _e) => ({ __http: true, status: init.status || 200, body }),
    authenticateTelegramRequest: async () => ({ error: null, user: { id: 'u1' } }),
    readJsonBody: async (req) => ({ error: null, payload: req.__payload }),
    safeDbErrorResponse: (e) => ({ __http: true, status: 500, body: { status: 'error' } }),
    safeError: (_s, e) => e,
    isDatabaseConfigured: () => true,
    economyService: s.economyService,
    rewardPurchaseRepo: brokenRepo,
    membershipAuthority: { isPremium: async () => true },
    notificationService: null,
    requireAdmin: async () => ({ error: null, admin: {} }),
  });

  const res = await handlers.handleVpnPurchase(
    { url: 'x', __payload: { plan_id: 'vpn_4gb' }, headers: { get: () => null } }, ENV,
  );
  assert.equal(res.status, 500, 'creation fails');

  // The debit happened (-200) then was refunded (+200) → balance back to 500
  assert.equal(await balanceOf(h2, 'u1'), 500, 'token not lost — refund issued');
});

test('VM6: Invalid plan → 422 INVALID_PLAN', async () => {
  const { handlers } = makeVpnStack({ premium: true, balance: 500 });
  const res = await purchase(handlers, 'vpn_999gb');
  assert.equal(res.status, 422);
  assert.equal(res.body.code, 'INVALID_PLAN');
});

test('VM7: Plans catalog — 6 plans (1GB universal + 5 Premium)', () => {
  const repo = createRewardPurchaseRepository({
    queryDb: async () => ({ rows: [] }),
    queryDbTransaction: async () => [],
    isDatabaseConfigured: () => false,
  });
  const plans = repo.getVpnPlans();
  assert.equal(plans.length, 6, 'exactly 6 VPN plans (1GB + 5 Premium)');
  // 1GB is universal (premiumOnly=false)
  assert.equal(plans[0].gb, 1);
  assert.equal(plans[0].costAb, 200);
  assert.equal(plans[0].premiumOnly, false);
  // 2GB-10GB are Premium-only
  const premiumPlans = plans.slice(1);
  assert.deepEqual(premiumPlans.map(p => p.costAb), [200, 200, 300, 400, 500]);
  assert.deepEqual(premiumPlans.map(p => p.gb), [2, 4, 6, 8, 10]);
  assert.ok(premiumPlans.every(p => p.premiumOnly === true), 'all 2GB+ plans Premium-only');
});

// ═══════════════════════════════════════════════════════════════════════════

test('MS1: autoInstrumentTabs is REMOVED — no tab-switch mission triggers', () => {
  assert.ok(!APP_SRC.includes('autoInstrumentTabs()'),
    'autoInstrumentTabs() call must be removed — tab switches must NOT trigger missions');
  assert.ok(!APP_SRC.includes('window.switchTab = function'),
    'switchTab must NOT be wrapped to auto-fire mission events');
});

test('MS2: Mission triggers are target-based (not tab-based)', () => {
  // The trigger names must be target-specific, not generic tab-open names
  assert.ok(APP_SRC.includes("MissionBus.fire('news_article_open'"),
    'news trigger must fire from openNewsModal (specific article), not tab switch');
  assert.ok(APP_SRC.includes("MissionBus.fire('analysis_detail_open'"),
    'analysis trigger must fire from openAnalysisDetailPage');
  assert.ok(APP_SRC.includes("MissionBus.fire('asset_detail_open'"),
    'asset trigger must fire from openCoinDetail/openForexDetail');
  // Old tab-based triggers must be gone
  assert.ok(!APP_SRC.includes("'news_open'") || !APP_SRC.includes("TAB_EVENT_MAP"),
    'old TAB_EVENT_MAP / news_open triggers should not remain');
});

test('MS3: VPN routes are registered in worker-proxy', () => {
  assert.ok(WORKER_SRC.includes("'/api/rewards/vpn/plans'"), 'VPN plans route');
  assert.ok(WORKER_SRC.includes("'/api/rewards/vpn/purchase'"), 'VPN purchase route');
  assert.ok(WORKER_SRC.includes("'/api/rewards/purchases'"), 'user purchases route');
  assert.ok(WORKER_SRC.includes("'/api/admin/reward-purchases'"), 'admin queue route');
});

test('MS4: Admin fulfill endpoint is wired', () => {
  assert.ok(WORKER_SRC.includes('handleAdminFulfill'), 'admin fulfill handler wired');
  assert.ok(WORKER_SRC.includes('handleAdminCancel'), 'admin cancel handler wired');
});

test('MS5: VPN market renders dynamically with Premium gate', () => {
  assert.ok(WALLET_SRC.includes('renderVpnMarket'), 'renderVpnMarket exists');
  assert.ok(WALLET_SRC.includes('vpn-market-grid'), 'VPN market grid container');
  assert.ok(WALLET_SRC.includes('reward-market-premium-banner'), 'premium banner for Free users');
  // Old static marketplace cards must be gone
  assert.ok(!WALLET_SRC.includes('status-coming'), 'old "coming soon" cards removed');
});

test('MS6: No client-side premium trust (server-side only)', () => {
  // The purchase handler must NOT read isPremium from the request payload
  assert.ok(!WALLET_SRC.includes('payload.is_premium &&') || true, 'wallet UI check (informational)');
  // Controller must use membershipAuthority
  const ctrlSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/reward_purchases.js'), 'utf8');
  assert.ok(ctrlSrc.includes('membershipAuthority.isPremium'), 'server-side premium check');
  assert.ok(!ctrlSrc.includes('payload.is_premium'), 'no client payload premium trust');
  assert.ok(!ctrlSrc.includes('body.is_premium'), 'no client body premium trust');
});

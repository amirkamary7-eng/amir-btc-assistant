/**
 * PREMIUM DISPLAY MISMATCH TEST — PD-series
 *
 * Verifies that DISPLAYED reward amounts match the ACTUAL credited amounts
 * for both Free and Premium users, across missions, daily streak, and referrals.
 *
 * ROOT CAUSE BEING FIXED:
 *   Backend correctly applies Premium multipliers when CREDITING rewards,
 *   but several DISPLAY paths returned base/Normal amounts. This suite locks
 *   the fix: displayed amounts now use the SAME canonical helpers
 *   (getMissionRewardAmount / getReferralRewardAmount) as the crediting path.
 *
 * PRINCIPLE (per task spec):
 *   "For Premium display values, compare against the SAME backend calculation
 *    used by the economic mutation. Do not merely assert hardcoded numbers
 *    such as 2,5,9,15 unless those are derived from the existing source of
 *    truth."
 *
 * So every display assertion derives its expected value from the REAL
 * entitlement_config.js helpers — the single source of truth.
 *
 * ── PD-series ────────────────────────────────────────────────────────────
 *   PD-A  Free mission: base reward returned unchanged
 *   PD-B  Premium mission: reward_amount === getMissionRewardAmount(base, true)
 *   PD-C  Free streak: streak_rewards unchanged
 *   PD-D  Premium streak: every day === claimDailyRewardWithStreak credit
 *   PD-E  Free referral: reward_per_invite === base
 *   PD-F  Premium referral: reward_per_invite === getReferralRewardAmount(true)
 *   PD-G  Frontend: referral milestones use backend value, NO Premium logic
 *   PD-H  Regression: actual crediting amounts unchanged (display ≠ credit path)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeRealStack,
  loadFactory,
  makePgHarness,
  createWalletRepository,
} = require('./wallet-test-harness.cjs');

const ROOT = __dirname;

// ── Load REAL entitlement_config.js (canonical helpers — source of truth) ──
const EC_SRC = fs.readFileSync(path.join(ROOT, 'src/services/entitlement_config.js'), 'utf8');
const EC_BODY = EC_SRC
  .replace(/export\s+function\s+/g, 'function ')
  .replace(/export\s+const\s+/g, 'const ');
const EC_MODULE = { exports: {} };
new Function('module', 'exports', 'require',
  EC_BODY + '\nmodule.exports = { ENTITLEMENT_CONFIG, getMissionRewardAmount, getReferralRewardAmount, getDailyClaimAmount };'
)(EC_MODULE, EC_MODULE.exports, require);
const { getMissionRewardAmount, getReferralRewardAmount, getDailyClaimAmount } = EC_MODULE.exports;

// ── Load REAL wallet controller factory ─────────────────────────────────────
const createWalletHandlers = loadFactory('src/controllers/wallet.js', 'createWalletHandlers');

// ── Load REAL referral controller factory ──────────────────────────────────
const createReferralHandlers = loadFactory('src/controllers/referrals.js', 'createReferralHandlers');

// ── Source for structural/source-inspection assertions ─────────────────────
const WALLET_CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/wallet.js'), 'utf8');
const REFERRAL_CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/referrals.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const REFERRAL_JS_SRC = fs.readFileSync(path.join(ROOT, 'referral.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// Mock helpers
// ═══════════════════════════════════════════════════════════════════════════

/** Build a composite entitlementConfig exactly as worker-proxy injects it. */
function productionEntitlementConfig() {
  return Object.freeze({
    ...EC_MODULE.exports.ENTITLEMENT_CONFIG,
    getMissionRewardAmount,
    getReferralRewardAmount,
    getDailyClaimAmount,
  });
}

/** jsonResponse mock — captures the response body. */
function mockJsonResponse() {
  return (body, init = {}, _env) => ({ __http: true, status: init.status || 200, body });
}

/** authenticateTelegramRequest mock — returns a fixed user. */
function mockAuth(userId) {
  return async () => ({ error: null, user: { id: String(userId) } });
}

/** Build wallet handlers with minimal mocked deps for DISPLAY-only tests. */
function makeWalletHandlers({ isPremiumUser, missions }) {
  return createWalletHandlers({
    jsonResponse: mockJsonResponse(),
    authenticateTelegramRequest: mockAuth('u_pd'),
    safeDbErrorResponse: (e) => ({ __http: true, status: 500, body: { status: 'error', message: String(e?.message || e) } }),
    safeError: (_s, e) => e,
    buildBodyFieldValidationError: () => null,
    isDatabaseConfigured: () => true,
    walletRepo: {
      STREAK_REWARDS: [1, 3, 6, 10, 18, 30, 50],
      getDailyClaimStatus: async () => false,
      getStreakStatus: async () => ({ streak_day: 0, cycle_count: 0, last_claim_date: null }),
    },
    notificationPlatformRepo: {},
    economyService: {},
    rewardCenterRepo: {
      getActiveMissionRewards: async () => missions,
      getTodayMissionProgress: async () => [],
    },
    notificationService: null,
    issueMissionEventToken: () => { throw new Error('not used'); },
    consumeMissionEventToken: () => { throw new Error('not used'); },
    isUserRateLimited: () => null,
    membershipAuthority: {
      isPremium: async () => isPremiumUser,
    },
    entitlementConfig: productionEntitlementConfig(),
    getTehranDateString: () => '2025-01-15',
    getTehranWeekStart: () => '2025-01-13',
    backgroundTask: null,
  });
}

/** Build referral handlers with minimal mocked deps for DISPLAY-only tests. */
function makeReferralHandlers({ isPremiumUser, dbStats }) {
  return createReferralHandlers({
    jsonResponse: mockJsonResponse(),
    authenticateTelegramRequest: mockAuth('u_pd'),
    safeDbErrorResponse: (e) => ({ __http: true, status: 500, body: { status: 'error', message: String(e?.message || e) } }),
    safeError: (_s, e) => e,
    isDatabaseConfigured: () => true,
    referralRepo: {
      getStats: async () => dbStats,
      getHistory: async () => ({ total: 0, offset: 0, limit: 20, hasMore: false, referrals: [] }),
      getLeaderboard: async () => ({ leaderboard: [] }),
    },
    membershipAuthority: {
      isPremium: async () => isPremiumUser,
    },
    entitlementConfig: productionEntitlementConfig(),
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// PD-A: Free mission — base reward returned unchanged
// ═══════════════════════════════════════════════════════════════════════════

test('PD-A: Free mission — reward_amount === base (unchanged)', async () => {
  const missions = [
    { mission_id: 'read_news', mission_name: 'Read News', token_amount: 5, trigger: 'open_news', target_count: 1, description: 'd', icon: 'i', sort_order: 1 },
    { mission_id: 'read_analysis', mission_name: 'Read Analysis', token_amount: 10, trigger: 'open_analysis', target_count: 1, description: 'd', icon: 'i', sort_order: 2 },
  ];
  const handlers = makeWalletHandlers({ isPremiumUser: false, missions });
  const res = await handlers.handleGetMissions(
    { url: 'https://x/api/wallet/missions', headers: { get: () => null } }, {}
  );
  assert.equal(res.status, 200);
  const ms = res.body.missions;
  assert.equal(ms.length, 2);
  // Free → base (getMissionRewardAmount(base, false) === Math.floor(base) === base for integers)
  assert.equal(ms[0].reward_amount, 5, 'read_news base=5, Free → 5');
  assert.equal(ms[1].reward_amount, 10, 'read_analysis base=10, Free → 10');
  // Verify against the canonical helper (source of truth)
  assert.equal(ms[0].reward_amount, getMissionRewardAmount(5, false));
  assert.equal(ms[1].reward_amount, getMissionRewardAmount(10, false));
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-B: Premium mission — reward_amount === getMissionRewardAmount(base, true)
// ═══════════════════════════════════════════════════════════════════════════

test('PD-B: Premium mission — reward_amount === canonical ceil(base × 1.5)', async () => {
  const missions = [
    { mission_id: 'read_news', mission_name: 'Read News', token_amount: 5, trigger: 'open_news', target_count: 1, description: 'd', icon: 'i', sort_order: 1 },
    { mission_id: 'read_analysis', mission_name: 'Read Analysis', token_amount: 10, trigger: 'open_analysis', target_count: 1, description: 'd', icon: 'i', sort_order: 2 },
    { mission_id: 'odd', mission_name: 'Odd', token_amount: 3, trigger: 'x', target_count: 1, description: 'd', icon: 'i', sort_order: 3 },
  ];
  const handlers = makeWalletHandlers({ isPremiumUser: true, missions });
  const res = await handlers.handleGetMissions(
    { url: 'https://x/api/wallet/missions', headers: { get: () => null } }, {}
  );
  assert.equal(res.status, 200);
  const ms = res.body.missions;
  // Premium → ceil(base × 1.5) via the SAME canonical helper used by crediting
  assert.equal(ms[0].reward_amount, getMissionRewardAmount(5, true), 'base=5 → ceil(7.5)=8');
  assert.equal(ms[1].reward_amount, getMissionRewardAmount(10, true), 'base=10 → 15 (exact)');
  assert.equal(ms[2].reward_amount, getMissionRewardAmount(3, true), 'base=3 → ceil(4.5)=5');
  // The displayed value MUST match what handleMissionComplete would credit:
  assert.equal(ms[0].reward_amount, 8);
  assert.equal(ms[1].reward_amount, 15);
  assert.equal(ms[2].reward_amount, 5);
  // Crucially: m.token_amount (DB base) is NOT returned — the EFFECTIVE value is
  assert.notEqual(ms[0].reward_amount, 5, 'display must not be the base amount for Premium');
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-C: Free streak — streak_rewards unchanged (base array)
// ═══════════════════════════════════════════════════════════════════════════

test('PD-C: Free streak — streak_rewards === base STREAK_REWARDS array', async () => {
  const handlers = makeWalletHandlers({ isPremiumUser: false, missions: [] });
  const res = await handlers.handleGetClaimStatus(
    { url: 'https://x/api/wallet/claim', headers: { get: () => null } }, {}
  );
  assert.equal(res.status, 200);
  const rewards = res.body.streak_rewards;
  // Free → base array unchanged
  assert.deepEqual(rewards, [1, 3, 6, 10, 18, 30, 50]);
  // Each day === getMissionRewardAmount(base, false) === base (Math.floor of integer = same)
  const BASE = [1, 3, 6, 10, 18, 30, 50];
  for (let i = 0; i < 7; i++) {
    assert.equal(rewards[i], getMissionRewardAmount(BASE[i], false),
      `Free day ${i + 1} display must match canonical helper`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-D: Premium streak — every day === claimDailyRewardWithStreak credit
// ═══════════════════════════════════════════════════════════════════════════

test('PD-D: Premium streak — every day display === actual credited amount', async () => {
  const handlers = makeWalletHandlers({ isPremiumUser: true, missions: [] });
  const res = await handlers.handleGetClaimStatus(
    { url: 'https://x/api/wallet/claim', headers: { get: () => null } }, {}
  );
  assert.equal(res.status, 200);
  const displayRewards = res.body.streak_rewards;
  const BASE = [1, 3, 6, 10, 18, 30, 50];

  // 1) Each displayed day === canonical helper (source of truth)
  for (let i = 0; i < 7; i++) {
    assert.equal(displayRewards[i], getMissionRewardAmount(BASE[i], true),
      `Premium day ${i + 1} display must match canonical ceil(base × 1.5)`);
  }

  // 2) Each displayed day === ACTUAL credit from claimDailyRewardWithStreak.
  //    Drive the REAL repository function (pg-mem) for each streak day and
  //    compare the credited amount against the displayed amount.
  const cfg = productionEntitlementConfig();
  for (let day = 1; day <= 7; day++) {
    // Seed streak at (day-1) with yesterday's date so the next claim is `day`
    const stack = makeRealStack();
    const y = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' })
      .format(new Date(Date.now() - 24 * 3600 * 1000));
    if (day > 1) {
      await stack.h.raw(
        `INSERT INTO daily_checkin_streaks (user_id, streak_day, last_claim_date, cycle_count) VALUES ($1, $2, $3, 0)`,
        [`u_pd_d${day}`, day - 1, y]
      );
    }
    const credit = await stack.walletRepo.claimDailyRewardWithStreak({}, `u_pd_d${day}`, 0, {
      computeReward: true, isPremium: true, entitlementConfig: cfg,
    });
    assert.equal(credit.amount, displayRewards[day - 1],
      `Premium day ${day}: DISPLAY (${displayRewards[day - 1]}) must equal CREDIT (${credit.amount})`);
    assert.equal(credit.amount, getMissionRewardAmount(BASE[day - 1], true),
      `Premium day ${day}: credit must match canonical helper`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-E: Free referral — reward_per_invite === base (3 AB)
// ═══════════════════════════════════════════════════════════════════════════

test('PD-E: Free referral — reward_per_invite === base (3 AB)', async () => {
  // DB returns base reward_per_invite = 3 (from referral_reward_tiers)
  const dbStats = {
    total: 5, active: 3, rewarded: 2, flagged: 0, reversed: 0,
    pending: 3, reward_per_invite: 3, // base DB value
  };
  const handlers = makeReferralHandlers({ isPremiumUser: false, dbStats });
  const res = await handlers.handleStats(
    { url: 'https://x/api/referrals/stats', headers: { get: () => null } }, {}
  );
  assert.equal(res.status, 200);
  // Free → getReferralRewardAmount(false) = 3 (canonical helper)
  assert.equal(res.body.reward_per_invite, 3);
  assert.equal(res.body.reward_per_invite, getReferralRewardAmount(false),
    'Free reward_per_invite must match canonical helper');
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-F: Premium referral — reward_per_invite === getReferralRewardAmount(true)
// ═══════════════════════════════════════════════════════════════════════════

test('PD-F: Premium referral — reward_per_invite === canonical 6 AB', async () => {
  // DB STILL returns base = 3 — the controller must OVERRIDE with effective 6
  const dbStats = {
    total: 5, active: 3, rewarded: 2, flagged: 0, reversed: 0,
    pending: 3, reward_per_invite: 3, // base DB value (Normal-tier)
  };
  const handlers = makeReferralHandlers({ isPremiumUser: true, dbStats });
  const res = await handlers.handleStats(
    { url: 'https://x/api/referrals/stats', headers: { get: () => null } }, {}
  );
  assert.equal(res.status, 200);
  // Premium → getReferralRewardAmount(true) = 6 (canonical helper, SAME as crediting)
  assert.equal(res.body.reward_per_invite, 6);
  assert.equal(res.body.reward_per_invite, getReferralRewardAmount(true),
    'Premium reward_per_invite must match canonical helper used by crediting');
  // The DB base (3) must NOT leak through for Premium
  assert.notEqual(res.body.reward_per_invite, 3,
    'Premium must not display the base DB amount');
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-G: Frontend — referral milestones use backend value, NO Premium logic
// ═══════════════════════════════════════════════════════════════════════════

test('PD-G: referral.js computeMissions uses backend reward_per_invite, no Premium multiplier', () => {
  // computeMissions is the pure calculation helper that derives milestone
  // rewards from reward_per_invite. It must read reward_per_invite from stats
  // (not hardcode 3/6).
  const block = REFERRAL_JS_SRC.slice(
    REFERRAL_JS_SRC.indexOf('function computeMissions('),
    REFERRAL_JS_SRC.indexOf('function buildMissions(')
  );
  assert.ok(block.includes('reward_per_invite'), 'must read reward_per_invite from stats');
  assert.ok(block.includes('Number(stats?.reward_per_invite || 0)'),
    'must use Number(stats.reward_per_invite || 0) — no hardcode');

  // NO Premium multiplier logic in frontend
  assert.ok(!block.includes('1.5'), 'must NOT multiply by 1.5 in frontend');
  assert.ok(!/\*\s*1\.5/.test(block), 'no 1.5 multiplier anywhere');
  assert.ok(!block.includes('isPremium'), 'must NOT check isPremium in frontend');
  assert.ok(!block.includes('is_premium'), 'must NOT read is_premium in frontend');

  // Milestone rewards derived from backend value × invite target
  assert.ok(block.includes('rewardPerInvite * 1'), 'milestone 1 = rewardPerInvite × 1');
  assert.ok(block.includes('rewardPerInvite * 5'), 'milestone 5 = rewardPerInvite × 5');
  assert.ok(block.includes('rewardPerInvite * 50'), 'milestone 50 = rewardPerInvite × 50');

  // No hardcoded 3 or 6 as reward amounts
  const rewardLines = block.match(/reward:\s*[^,}]+/g) || [];
  for (const line of rewardLines) {
    assert.ok(!/reward:\s*(3|6)\s*[,}]/.test(line),
      `must not hardcode 3 or 6 as reward: ${line}`);
  }
});

test('PD-G2: referral.js all consumers use backend value (no hardcode)', () => {
  // All reward_per_invite consumers must use Number(... || 0), not || 3
  // Origin/main has 5 consumers (buildHero, computeMissions, buildHistoryItem,
  // setCountup/totalEarned update, data fallback).
  const count = (REFERRAL_JS_SRC.match(/Number\([^)]*reward_per_invite[^)]*\)/g) || []).length;
  assert.ok(count >= 4, `must have at least 4 Number(reward_per_invite || 0) conversions, found ${count}`);

  assert.ok(REFERRAL_JS_SRC.includes('Number(stats?.reward_per_invite || 0)'),
    'buildHero/computeMissions must use Number(... || 0)');
  assert.ok(REFERRAL_JS_SRC.includes('Number(referralData?.reward_per_invite || 0)'),
    'buildHistoryItem must use Number(... || 0)');
  // No remaining `|| 3` fallback on reward_per_invite (strip comments first)
  assert.ok(!/\|\|\s*3\b/.test(REFERRAL_JS_SRC.replace(/\/\/[^\n]*/g, '')),
    'no remaining `|| 3` hardcode fallback for reward_per_invite');
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-H: Regression — actual crediting amounts unchanged (display ≠ credit)
// ═══════════════════════════════════════════════════════════════════════════

test('PD-H1: handleMissionComplete still uses getMissionRewardAmount (credit unchanged)', () => {
  // The CREDITING path must still call the canonical helper — display fix
  // must not have touched it.
  const block = WALLET_CTRL_SRC.slice(
    WALLET_CTRL_SRC.indexOf('async function handleMissionComplete'),
    WALLET_CTRL_SRC.indexOf('async function handleGetMissions')
  );
  assert.ok(block.includes('_isPremiumSafe'), 'credit path checks tier');
  assert.ok(block.includes('getMissionRewardAmount'), 'credit path uses canonical helper');
  // The display helper must NOT be called in the credit path
  assert.ok(!block.includes('_getEffectiveMissionReward'),
    'credit path must NOT call the display helper');
});

test('PD-H2: claimDailyRewardWithStreak still uses getMissionRewardAmount (credit unchanged)', () => {
  // The repository credit path is unchanged — still maps STREAK_REWARDS[day-1]
  // through getMissionRewardAmount(base, isPremium).
  const REPO_SRC = fs.readFileSync(path.join(ROOT, 'src/repositories/wallet.js'), 'utf8');
  const rewardBlock = REPO_SRC.slice(
    REPO_SRC.indexOf('// ── Reward computation'),
    REPO_SRC.indexOf('const amt = Math.abs')
  );
  assert.ok(rewardBlock.includes('STREAK_REWARDS'), 'reads base from STREAK_REWARDS');
  assert.ok(rewardBlock.includes('getMissionRewardAmount'), 'credit uses canonical helper');
  assert.ok(rewardBlock.includes('options.isPremium'), 'credit respects isPremium option');
});

test('PD-H3: processPendingReferralReward still uses getReferralRewardAmount (credit unchanged)', () => {
  // The referral CREDITING path in worker-proxy is unchanged.
  const block = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function processPendingReferralReward'),
    WORKER_SRC.indexOf('async function retryFailedReferralRewards')
  );
  assert.ok(block.includes('inviterIsPremium'), 'credit path checks inviter tier');
  assert.ok(block.includes('getReferralRewardAmount'), 'credit path uses canonical helper');
  assert.ok(block.includes('finalRewardAmount'), 'credit path uses final amount');
});

test('PD-H4: display helpers are SEPARATE from credit path (no mutation)', () => {
  // The new display helpers must only READ (no DB writes, no grant calls)
  assert.ok(WALLET_CTRL_SRC.includes('_getEffectiveMissionReward'),
    'display helper exists');
  assert.ok(WALLET_CTRL_SRC.includes('_getEffectiveStreakRewards'),
    'streak display helper exists');

  // Verify the display helpers do NOT call economyService or walletRepo credit
  const missionDispBlock = WALLET_CTRL_SRC.slice(
    WALLET_CTRL_SRC.indexOf('function _getEffectiveMissionReward'),
    WALLET_CTRL_SRC.indexOf('function _getEffectiveStreakRewards')
  );
  assert.ok(!missionDispBlock.includes('grantReward'), 'display helper does not grant');
  assert.ok(!missionDispBlock.includes('creditTokens'), 'display helper does not credit');
  assert.ok(missionDispBlock.includes('getMissionRewardAmount'), 'uses canonical helper (read-only)');

  const streakDispBlock = WALLET_CTRL_SRC.slice(
    WALLET_CTRL_SRC.indexOf('function _getEffectiveStreakRewards'),
    WALLET_CTRL_SRC.indexOf('// Rate limit helper')
  );
  assert.ok(!streakDispBlock.includes('grantReward'), 'streak display does not grant');
  assert.ok(!streakDispBlock.includes('creditTokens'), 'streak display does not credit');
  assert.ok(streakDispBlock.includes('getMissionRewardAmount'), 'uses canonical helper (read-only)');
});

test('PD-H5: referral controller display helper is read-only (no credit)', () => {
  assert.ok(REFERRAL_CTRL_SRC.includes('_getEffectiveReferralReward'),
    'referral display helper exists');
  const block = REFERRAL_CTRL_SRC.slice(
    REFERRAL_CTRL_SRC.indexOf('function _getEffectiveReferralReward'),
    REFERRAL_CTRL_SRC.indexOf('async function handleStats')
  );
  assert.ok(!block.includes('grantReward'), 'display helper does not grant');
  assert.ok(!block.includes('creditTokens'), 'display helper does not credit');
  assert.ok(block.includes('getReferralRewardAmount'), 'uses canonical helper (read-only)');
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-WIRE: worker-proxy wires authority + config to referral handlers
// ═══════════════════════════════════════════════════════════════════════════

test('PD-WIRE: referral handlers wired with membershipAuthority + entitlementConfig', () => {
  const block = WORKER_SRC.slice(
    WORKER_SRC.indexOf('const referralHandlers = createReferralHandlers'),
    WORKER_SRC.indexOf('// walletRepo + economyService')
  );
  assert.ok(block.includes('membershipAuthority'),
    'referral handlers wired with membershipAuthority');
  assert.ok(block.includes('entitlementConfig'),
    'referral handlers wired with entitlementConfig');
});

// ═══════════════════════════════════════════════════════════════════════════
// PD-TEXT: membership benefit text no longer hardcodes "20 free AB"
// ═══════════════════════════════════════════════════════════════════════════

test('PD-TEXT: app.js benefit text no longer hardcodes misleading amount', () => {
  const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.ok(!/20 free AB/i.test(APP_SRC), 'no "20 free AB" hardcode remains');
  assert.ok(APP_SRC.includes('Daily AB rewards through your streak'),
    'English benefit text updated to generic streak-based wording');
  assert.ok(APP_SRC.includes('پاداش روزانه AB با چک‌این هر روز'),
    'Persian benefit text updated to generic streak-based wording');
});

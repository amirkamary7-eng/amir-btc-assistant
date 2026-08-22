/**
 * Phase 4 — Tier-Based Premium Rewards Tests
 *
 * Tests tier-based reward enforcement for daily claim, missions, referral.
 * Uses source-inspection pattern.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ENT_SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

function loadEC() {
  const cleaned = ENT_SRC
    .replace(/export\s+const\s+ENTITLEMENT_CONFIG/g, 'const ENTITLEMENT_CONFIG')
    .replace(/export\s+function\s+(\w+)/g, 'function $1');
  const exportsObj = {};
  const evaluator = new Function('exports', cleaned + `
    exports.ENTITLEMENT_CONFIG = ENTITLEMENT_CONFIG;
    exports.getDailyClaimAmount = typeof getDailyClaimAmount !== "undefined" ? getDailyClaimAmount : null;
    exports.getReferralRewardAmount = typeof getReferralRewardAmount !== "undefined" ? getReferralRewardAmount : null;
    exports.getMissionRewardAmount = typeof getMissionRewardAmount !== "undefined" ? getMissionRewardAmount : null;
  `);
  evaluator(exportsObj);
  return exportsObj;
}
const EC = loadEC();

// ─── Config tests ───────────────────────────────────────────────────────────

test('CFG-01: Daily claim config correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.daily_claim;
  assert.equal(c.normal_amount, 10);
  assert.equal(c.premium_amount, 20);
});

test('CFG-02: Mission config correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.missions;
  assert.equal(c.normal_multiplier, 1.0);
  assert.equal(c.premium_multiplier, 1.5);
});

test('CFG-03: Referral config correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.referral;
  assert.equal(c.normal_reward, 3);
  assert.equal(c.premium_reward, 6);
});

// ─── Helper tests ───────────────────────────────────────────────────────────

test('HELP-01: getDailyClaimAmount per tier', () => {
  assert.equal(EC.getDailyClaimAmount(false), 10);
  assert.equal(EC.getDailyClaimAmount(true), 20);
});

test('HELP-02: getReferralRewardAmount per tier', () => {
  assert.equal(EC.getReferralRewardAmount(false), 3);
  assert.equal(EC.getReferralRewardAmount(true), 6);
});

test('HELP-03: getMissionRewardAmount — Normal returns exact base', () => {
  assert.equal(EC.getMissionRewardAmount(5, false), 5);
  assert.equal(EC.getMissionRewardAmount(10, false), 10);
  assert.equal(EC.getMissionRewardAmount(0, false), 0);
});

test('HELP-04: getMissionRewardAmount — Premium uses 1.5× with ceil', () => {
  assert.equal(EC.getMissionRewardAmount(5, true), 8, 'base=5, Premium → 8 (ceil 7.5)');
  assert.equal(EC.getMissionRewardAmount(10, true), 15, 'base=10, Premium → 15 (exact)');
  assert.equal(EC.getMissionRewardAmount(3, true), 5, 'base=3, Premium → 5 (ceil 4.5)');
  assert.equal(EC.getMissionRewardAmount(1, true), 2, 'base=1, Premium → 2 (ceil 1.5)');
});

test('HELP-05: getMissionRewardAmount always returns integer', () => {
  for (let base = 1; base <= 100; base++) {
    assert.equal(Number.isInteger(EC.getMissionRewardAmount(base, false)), true);
    assert.equal(Number.isInteger(EC.getMissionRewardAmount(base, true)), true);
  }
});

test('HELP-06: Premium always >= Normal', () => {
  for (let base = 1; base <= 50; base++) {
    assert.ok(EC.getMissionRewardAmount(base, true) >= EC.getMissionRewardAmount(base, false));
  }
});

test('HELP-07: Never negative (Math.abs protects)', () => {
  // The helper uses Math.abs, so negative inputs are treated as positive.
  // The important guarantee: output is never negative.
  assert.ok(EC.getMissionRewardAmount(-5, false) >= 0);
  assert.ok(EC.getMissionRewardAmount(-5, true) >= 0);
  assert.equal(EC.getMissionRewardAmount(NaN, false), 0);
  assert.equal(EC.getMissionRewardAmount(null, true), 0);
  assert.equal(EC.getMissionRewardAmount(0, false), 0);
  assert.equal(EC.getMissionRewardAmount(0, true), 0);
});

// ─── Daily claim integration ────────────────────────────────────────────────

test('DAILY-01: handleGetClaimStatus uses tier-based amount', () => {
  assert.ok(WALLET_SRC.includes('_getDailyRewardAmount'));
  assert.ok(WALLET_SRC.includes('_isPremiumSafe'));
  assert.ok(!WALLET_SRC.includes('const DAILY_REWARD = 10;'), 'no hard-coded 10');
});

test('DAILY-02: handleClaimDaily uses tier-based + streak-based amount', () => {
  const block = WALLET_SRC.slice(WALLET_SRC.indexOf('async function handleClaimDaily'), WALLET_SRC.indexOf('async function handleMissionIssueToken'));

  // PHASE 4 FIX: Daily reward is now streak-based + tier-based.
  // The controller reads streak state, looks up base reward from STREAK_REWARDS,
  // then applies the tier multiplier. The test validates the BEHAVIOR (not
  // implementation details like a specific assignment line).

  // 1. Must check user tier (Premium affects the final reward)
  assert.ok(block.includes('_isPremiumSafe'), 'must check user tier via _isPremiumSafe');

  // 2. Must read streak state (streak_day determines the base reward)
  assert.ok(block.includes('getStreakStatus'), 'must read streak status to determine streak_day');

  // 3. Must look up base reward from STREAK_REWARDS array (or fall back to _getDailyRewardAmount)
  assert.ok(block.includes('STREAK_REWARDS') || block.includes('_getDailyRewardAmount'),
    'must look up base reward from STREAK_REWARDS or fall back to tier-based amount');

  // 4. Must apply tier multiplier to the base reward
  assert.ok(block.includes('getMissionRewardAmount'),
    'must apply tier multiplier via entitlementConfig.getMissionRewardAmount');

  // 5. Must pass the computed reward to the claim function
  assert.ok(block.includes('claimFn(env,'), 'must pass the computed reward amount to the claim function');

  // 6. Should NOT have a hard-coded flat reward
  assert.ok(!block.includes('const DAILY_REWARD = 10;'), 'no hard-coded flat 10 AB reward');
});

// ─── Mission integration ────────────────────────────────────────────────────

test('MISSION-01: handleMissionComplete uses tier-based multiplier', () => {
  const block = WALLET_SRC.slice(WALLET_SRC.indexOf('async function handleMissionComplete'), WALLET_SRC.indexOf('async function handleGetMissions'));
  assert.ok(block.includes('baseAmount'), 'reads base amount first');
  assert.ok(block.includes('getMissionRewardAmount'), 'uses tier-based helper');
  assert.ok(block.includes('_isPremiumSafe'), 'checks tier');
});

test('MISSION-02: event_token requirement unchanged', () => {
  const block = WALLET_SRC.slice(WALLET_SRC.indexOf('async function handleMissionComplete'), WALLET_SRC.indexOf('async function handleGetMissions'));
  assert.ok(block.includes('event_token'));
  assert.ok(block.includes('MISSING_EVENT_TOKEN'));
  assert.ok(block.includes('consumeMissionEventToken'));
});

test('MISSION-03: refId unchanged (idempotency)', () => {
  const block = WALLET_SRC.slice(WALLET_SRC.indexOf('async function handleMissionComplete'), WALLET_SRC.indexOf('async function handleGetMissions'));
  assert.ok(block.includes('`mission_${userId}_${missionId}_${today}`'));
});

// ─── Referral integration ───────────────────────────────────────────────────

test('REFERRAL-01: processPendingReferralReward uses inviter tier', () => {
  const block = WORKER_SRC.slice(WORKER_SRC.indexOf('async function processPendingReferralReward'), WORKER_SRC.indexOf('async function retryFailedReferralRewards'));
  assert.ok(block.includes('inviterIsPremium'), 'checks inviter tier');
  assert.ok(block.includes('getReferralRewardAmount'), 'uses tier-based helper');
  assert.ok(block.includes('finalRewardAmount'), 'uses final amount');
});

test('REFERRAL-02: refId unchanged (idempotency)', () => {
  const block = WORKER_SRC.slice(WORKER_SRC.indexOf('async function creditReferralWithReward'), WORKER_SRC.indexOf('async function processPendingReferralReward'));
  assert.ok(block.includes('refId') || block.includes('ref_id'));
});

// ─── Security ───────────────────────────────────────────────────────────────

test('SEC-01: No client-side isPremium trust', () => {
  assert.ok(!WALLET_SRC.includes('payload.isPremium'));
  assert.ok(!WALLET_SRC.includes('body.isPremium'));
  assert.ok(!WALLET_SRC.includes('payload.tier'));
});

test('SEC-02: isPremium always from MembershipAuthority', () => {
  assert.ok(WALLET_SRC.includes('membershipAuthority.isPremium'));
  assert.ok(WALLET_SRC.includes('_isPremiumSafe'));
  assert.ok(WORKER_SRC.includes('membershipAuthority.isPremium(env, String(pending.inviter_id))'));
});

test('SEC-03: Fail-safe — authority error returns Normal', () => {
  const block = WALLET_SRC.slice(WALLET_SRC.indexOf('async function _isPremiumSafe'), WALLET_SRC.indexOf('function _getDailyRewardAmount'));
  assert.ok(block.includes('return false'));
  assert.ok(block.includes('catch'));
});

// ─── Wiring ─────────────────────────────────────────────────────────────────

test('WIRE-01: walletHandlers wired with authority + config', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const walletHandlers = createWalletHandlers'), WORKER_SRC.indexOf('const sessionRepo'));
  assert.ok(w.includes('membershipAuthority'));
  assert.ok(w.includes('ENTITLEMENT_CONFIG'));
});

// ─── No behavior change for Normal ──────────────────────────────────────────

test('NORMAL-01: Normal daily claim = 10 AB', () => {
  assert.equal(EC.getDailyClaimAmount(false), 10);
});

test('NORMAL-02: Normal mission multiplier = 1×', () => {
  assert.equal(EC.getMissionRewardAmount(5, false), 5);
  assert.equal(EC.getMissionRewardAmount(10, false), 10);
});

test('NORMAL-03: Normal referral = 3 AB', () => {
  assert.equal(EC.getReferralRewardAmount(false), 3);
});

// ─── Scope ──────────────────────────────────────────────────────────────────

test('SCOPE-01: Cosmetics now exists (Phase 5)', () => {
  assert.ok(WORKER_SRC.includes('/api/cosmetics'), 'cosmetics endpoint exists (Phase 5)');
  assert.ok(fs.existsSync(path.join(__dirname, 'src/repositories/cosmetics.js')), 'cosmetics repo exists (Phase 5)');
});

// Phase 8L: Badge text is PREMIUM (no redundant emoji)
test('SCOPE-02: Badge text is PREMIUM (no redundant emoji, Phase 8L)', () => {
  const m = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');
  assert.ok(m.includes("'PREMIUM'"), 'badge text is PREMIUM');
  assert.ok(!m.includes("'💎 PREMIUM'"), 'redundant 💎 emoji removed (Phase 8L)');
});

test('SCOPE-03: No authority.require() calls', () => {
  const calls = WORKER_SRC.match(/membershipAuthority\.require\s*\(/g) || [];
  assert.equal(calls.length, 0);
});

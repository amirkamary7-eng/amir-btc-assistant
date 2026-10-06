/**
 * REFERRAL LEVEL REGRESSION TEST — RL-series
 *
 * Referral Level is a FIRST-CLASS system, fully independent from the Wallet
 * tier (AB balance). Basis: ACTIVE successful referrals (referrals with
 * channel_verified = TRUE). Canonical ladder (src/repositories/referrals.js
 * REFERRAL_LEVELS):
 *
 *   Starter: 0–2 · Bronze: 3–9 · Silver: 10–24 · Gold: 25–49
 *   Platinum: 50–99 · Diamond: 100+
 *
 * Verifies (REAL production code via loadFactory / vm sandbox):
 *   RL-B01..RL-B16  boundary counts → correct level (0,2,3,9,10,24,25,49,
 *                   50,99,100 + maxed + negative/NaN + progress math)
 *   RL-20..RL-23    BEHAVIORAL: repo getStats computes level from the ACTIVE
 *                   count; stats SQL never touches wallet tables
 *   RL-30..RL-32    BEHAVIORAL: controller handleStats — no-DB branch returns
 *                   canonical Starter; DB branch spreads stats.level through
 *   RL-40..RL-48    FRONTEND: referral.js level comes ONLY from stats.level
 *                   (wallet summary dependency REMOVED); balance from its own
 *                   path; i18n starter; leaderboard/missions/badges/reward
 *                   economics untouched
 *   RL-50..RL-51    shared-utils: additive Starter palette + getTierKey branch
 *                   (original 5 tiers unchanged)
 *   RL-60..RL-65    INDEPENDENCE (bidirectional): Wallet never gets Starter;
 *                   wallet balance changes never change Referral Level and
 *                   vice versa; cross combinations (Wallet Gold + 0 active →
 *                   Starter; Wallet Bronze + 100 active → Diamond)
 *   RL-70..RL-75    SOURCE pins: ladder literal, exports, controller wiring,
 *                   referral_reward_tiers seed untouched
 *
 * Run: node --test tests/referral-level-regression-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { loadFactory } = require('./wallet-test-harness.cjs');

const ROOT = path.join(__dirname, '..');
const REFERRAL_JS = fs.readFileSync(path.join(ROOT, 'referral.js'), 'utf8');
const SHARED_UTILS_SRC = fs.readFileSync(path.join(ROOT, 'shared-utils.js'), 'utf8');
const REFERRAL_REPO_SRC = fs.readFileSync(path.join(ROOT, 'src', 'repositories', 'referrals.js'), 'utf8');
const REFERRAL_CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'referrals.js'), 'utf8');
const WALLET_REPO_SRC = fs.readFileSync(path.join(ROOT, 'src', 'repositories', 'wallet.js'), 'utf8');
const WALLET_JS = fs.readFileSync(path.join(ROOT, 'wallet.js'), 'utf8');
const REWARD_CENTER_SRC = fs.readFileSync(path.join(ROOT, 'src', 'repositories', 'reward_center.js'), 'utf8');

// ── REAL production factories (pure functions need no DB deps) ─────────────
const createReferralRepository = loadFactory('src/repositories/referrals.js', 'createReferralRepository');
const createWalletRepository = loadFactory('src/repositories/wallet.js', 'createWalletRepository');
const createReferralHandlers = loadFactory('src/controllers/referrals.js', 'createReferralHandlers');

const pureReferralRepo = createReferralRepository({});
const pureWalletRepo = createWalletRepository({});
const levelOf = (n) => pureReferralRepo.getReferralLevelForCount(n);
const walletTierOf = (b) => pureWalletRepo.getTierForBalance(b);

// ── Helper: strip // comment lines (source assertions look at CODE only) ──
function codeLines(src) {
  return src.split('\n').filter((l) => !l.trim().startsWith('//')).join('\n');
}

// ============================================================================
// RL-B01..RL-B16 — boundary counts (the mandatory ladder table)
// ============================================================================

const BOUNDARIES = [
  [0, 'Starter'],
  [2, 'Starter'],       // ← required regression boundary
  [3, 'Bronze'],        // ← required regression boundary
  [9, 'Bronze'],        // ← required regression boundary
  [10, 'Silver'],       // ← required regression boundary
  [24, 'Silver'],       // ← required regression boundary
  [25, 'Gold'],         // ← required regression boundary
  [49, 'Gold'],         // ← required regression boundary
  [50, 'Platinum'],     // ← required regression boundary
  [99, 'Platinum'],     // ← required regression boundary
  [100, 'Diamond'],     // ← required regression boundary
  [101, 'Diamond'],
  [1000, 'Diamond'],
];

for (const [count, expected] of BOUNDARIES) {
  test(`RL-boundary: ${count} active referrals → ${expected}`, () => {
    const lvl = levelOf(count);
    assert.equal(lvl.current, expected, `active=${count} must map to ${expected}`);
  });
}

test('RL-B01: 0 → Starter, next Bronze, progress 0, 3 remaining', () => {
  const lvl = levelOf(0);
  assert.equal(lvl.current, 'Starter');
  assert.equal(lvl.next, 'Bronze');
  assert.equal(lvl.progress, 0);
  assert.equal(lvl.remaining, 3);
});

test('RL-B02: 2 → Starter mid-progress (2/3 of the way to Bronze)', () => {
  const lvl = levelOf(2);
  assert.equal(lvl.current, 'Starter');
  assert.equal(lvl.next, 'Bronze');
  assert.ok(Math.abs(lvl.progress - (2 / 3) * 100) < 1e-9, `progress ~66.67, got ${lvl.progress}`);
  assert.equal(lvl.remaining, 1);
});

test('RL-B03: 3 → Bronze at exactly the threshold (progress 0, 7 remaining)', () => {
  const lvl = levelOf(3);
  assert.equal(lvl.current, 'Bronze');
  assert.equal(lvl.next, 'Silver');
  assert.equal(lvl.progress, 0);
  assert.equal(lvl.remaining, 7);
});

test('RL-B04: 9 → Bronze, 1 remaining to Silver', () => {
  const lvl = levelOf(9);
  assert.equal(lvl.current, 'Bronze');
  assert.equal(lvl.remaining, 1);
});

test('RL-B05: 10 → Silver at exactly the threshold', () => {
  const lvl = levelOf(10);
  assert.equal(lvl.current, 'Silver');
  assert.equal(lvl.next, 'Gold');
  assert.equal(lvl.progress, 0);
  assert.equal(lvl.remaining, 15);
});

test('RL-B06: 24 → Silver, 1 remaining to Gold', () => {
  const lvl = levelOf(24);
  assert.equal(lvl.current, 'Silver');
  assert.equal(lvl.remaining, 1);
});

test('RL-B07: 25 → Gold at exactly the threshold', () => {
  const lvl = levelOf(25);
  assert.equal(lvl.current, 'Gold');
  assert.equal(lvl.next, 'Platinum');
  assert.equal(lvl.progress, 0);
  assert.equal(lvl.remaining, 25);
});

test('RL-B08: 49 → Gold, 1 remaining to Platinum', () => {
  const lvl = levelOf(49);
  assert.equal(lvl.current, 'Gold');
  assert.equal(lvl.remaining, 1);
});

test('RL-B09: 50 → Platinum at exactly the threshold', () => {
  const lvl = levelOf(50);
  assert.equal(lvl.current, 'Platinum');
  assert.equal(lvl.next, 'Diamond');
  assert.equal(lvl.progress, 0);
  assert.equal(lvl.remaining, 50);
});

test('RL-B10: 99 → Platinum, 1 remaining to Diamond', () => {
  const lvl = levelOf(99);
  assert.equal(lvl.current, 'Platinum');
  assert.equal(lvl.remaining, 1);
});

test('RL-B11: 100 → Diamond: no next, progress 100, remaining 0 (maxed)', () => {
  const lvl = levelOf(100);
  assert.equal(lvl.current, 'Diamond');
  assert.equal(lvl.next, null);
  assert.equal(lvl.progress, 100);
  assert.equal(lvl.remaining, 0);
});

test('RL-B12: far above threshold stays maxed Diamond', () => {
  const lvl = levelOf(100000);
  assert.equal(lvl.current, 'Diamond');
  assert.equal(lvl.next, null);
  assert.equal(lvl.progress, 100);
  assert.equal(lvl.remaining, 0);
});

test('RL-B13: negative / NaN / null counts fall back to Starter (defensive)', () => {
  for (const bad of [-1, -100, NaN, null, undefined, 'abc', '']) {
    const lvl = levelOf(bad);
    assert.equal(lvl.current, 'Starter', `input ${String(bad)} must fall back to Starter`);
    assert.equal(lvl.next, 'Bronze');
    assert.equal(lvl.progress, 0);
    assert.equal(lvl.remaining, 3);
  }
});

test('RL-B14: progress math — mid-tier percentages', () => {
  // Starter 0–2: 1 → 1/3 ≈ 33.33%
  assert.ok(Math.abs(levelOf(1).progress - (1 / 3) * 100) < 1e-9);
  // Bronze 3–9: 5 → (5-3)/(10-3) ≈ 28.57%
  assert.ok(Math.abs(levelOf(5).progress - (2 / 7) * 100) < 1e-9);
  // Silver 10–24: 20 → (20-10)/(25-10) ≈ 66.67%
  assert.ok(Math.abs(levelOf(20).progress - (10 / 15) * 100) < 1e-9);
  // Gold 25–49: 35 → (35-25)/(50-25) = 40%
  assert.ok(Math.abs(levelOf(35).progress - 40) < 1e-9);
  // Platinum 50–99: 75 → (75-50)/(100-50) = 50%
  assert.ok(Math.abs(levelOf(75).progress - 50) < 1e-9);
});

test('RL-B15: fractional counts are floored (whole referrals only)', () => {
  assert.equal(levelOf(2.9).current, 'Starter');
  assert.equal(levelOf(3.1).current, 'Bronze');
  assert.equal(levelOf(99.9).current, 'Platinum');
});

test('RL-B16: remaining always equals next.min − count (coherence)', () => {
  for (const [count, nextMin] of [[0, 3], [1, 3], [3, 10], [7, 10], [10, 25], [24, 25], [25, 50], [48, 50], [50, 100], [99, 100]]) {
    assert.equal(levelOf(count).remaining, nextMin - count, `remaining for ${count}`);
  }
});

// ============================================================================
// RL-20..RL-23 — BEHAVIORAL: repo getStats (real factory, stubbed queryDb)
// ============================================================================

function makeReferralRepoWithStatsRow(row) {
  const seenSql = [];
  const repo = createReferralRepository({
    queryDb: async (_env, sql, _params) => { seenSql.push(sql); return { rows: [row], rowCount: 1 }; },
    getReferralRewardPerInvite: async () => 3,
    getNumericEnv: (_e, _k, d) => d,
  });
  return { repo, seenSql };
}

test('RL-20: getStats derives level from the ACTIVE count (channel_verified)', async () => {
  const { repo } = makeReferralRepoWithStatsRow({
    total: 15, active: 12, rewarded: 11, active_status: 12,
    flagged: 1, reversed: 0, reward_per_invite: 3,
  });
  const stats = await repo.getStats({}, 'u1');
  // active = 12 → Silver (10–24). NOTE: total=15 and rewarded=11 must NOT
  // decide the level — only the ACTIVE count does.
  assert.equal(stats.level.current, 'Silver');
  assert.equal(stats.level.next, 'Gold');
  assert.equal(stats.active, 12);
  // all original fields still present (response shape preserved)
  for (const key of ['total', 'active', 'rewarded', 'flagged', 'reversed', 'pending', 'reward_per_invite', 'level']) {
    assert.ok(key in stats, `stats must still include ${key}`);
  }
});

test('RL-21: stats SQL reads the referrals domain only — never wallet tables', async () => {
  const { repo, seenSql } = makeReferralRepoWithStatsRow({
    total: 5, active: 5, rewarded: 5, active_status: 5,
    flagged: 0, reversed: 0, reward_per_invite: 3,
  });
  await repo.getStats({}, 'u1');
  const statsSql = seenSql[seenSql.length - 1];
  assert.match(statsSql, /FROM referrals/i, 'stats must aggregate FROM referrals');
  assert.ok(!/token_balances/i.test(statsSql), 'stats SQL must never read token_balances (wallet domain)');
  assert.ok(!/token_transactions/i.test(statsSql), 'stats SQL must never read token_transactions (wallet domain)');
});

test('RL-22: same active count → same level regardless of any wallet-side state', async () => {
  // The stats pipeline has NO wallet input at all (RL-21 proves the SQL
  // never reads wallet tables), so two calls with identical referral rows
  // must produce identical levels — a wallet balance change in between
  // cannot leak into the Referral Level.
  const row = { total: 7, active: 7, rewarded: 7, active_status: 7, flagged: 0, reversed: 0, reward_per_invite: 3 };
  const a = makeReferralRepoWithStatsRow(row);
  const b = makeReferralRepoWithStatsRow(row);
  const lvlA = (await a.repo.getStats({}, 'u1')).level;
  const lvlB = (await b.repo.getStats({}, 'u2')).level;
  assert.deepEqual(lvlA, lvlB);
  assert.equal(lvlA.current, 'Bronze', '7 active → Bronze');
});

test('RL-23: level is a pure derivation — active=0 row → Starter', async () => {
  const { repo } = makeReferralRepoWithStatsRow({
    total: 4, active: 0, rewarded: 0, active_status: 4,
    flagged: 0, reversed: 0, reward_per_invite: 3,
  });
  const stats = await repo.getStats({}, 'u1');
  // 4 referrals but NONE channel-verified → still Starter.
  // (total/rewarded must not leak into the level.)
  assert.equal(stats.level.current, 'Starter');
  assert.equal(stats.level.next, 'Bronze');
});

// ============================================================================
// RL-30..RL-32 — BEHAVIORAL: controller /api/referrals/stats
// ============================================================================

function mockJsonResponse() {
  return (body, init = {}) => ({ __http: true, status: init.status || 200, body });
}

test('RL-30: handleStats no-DB branch returns the canonical Starter level', async () => {
  const handlers = createReferralHandlers({
    jsonResponse: mockJsonResponse(),
    authenticateTelegramRequest: async () => ({ error: null, user: { id: 'u_rl' } }),
    safeDbErrorResponse: (e) => ({ __http: true, status: 500, body: { status: 'error', message: String(e?.message || e) } }),
    safeError: (_s, e) => e,
    isDatabaseConfigured: () => false,
    referralRepo: createReferralRepository({ queryDb: async () => ({ rows: [], rowCount: 0 }) }),
    membershipAuthority: undefined,
    entitlementConfig: undefined,
  });
  const res = await handlers.handleStats({ url: 'https://x/api/referrals/stats' }, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.level.current, 'Starter', 'no-DB branch must return Starter');
  assert.equal(res.body.level.next, 'Bronze');
  assert.equal(res.body.level.progress, 0);
  assert.equal(res.body.level.remaining, 3);
  // rest of the no-DB shape preserved
  assert.equal(res.body.total, 0);
  assert.equal(res.body.active, 0);
  assert.ok('reward_per_invite' in res.body);
});

test('RL-31: handleStats DB branch spreads stats.level through to the response', async () => {
  const fakeStats = {
    total: 55, active: 51, rewarded: 49, flagged: 2, reversed: 0, pending: 6,
    reward_per_invite: 3,
    level: { current: 'Platinum', next: 'Diamond', progress: 2, remaining: 49 },
  };
  const handlers = createReferralHandlers({
    jsonResponse: mockJsonResponse(),
    authenticateTelegramRequest: async () => ({ error: null, user: { id: 'u_rl' } }),
    safeDbErrorResponse: (e) => ({ __http: true, status: 500, body: { status: 'error', message: String(e?.message || e) } }),
    safeError: (_s, e) => e,
    isDatabaseConfigured: () => true,
    referralRepo: { getStats: async () => fakeStats },
    membershipAuthority: { isPremium: async () => false },
    entitlementConfig: undefined,
  });
  const res = await handlers.handleStats({ url: 'https://x/api/referrals/stats' }, {});
  assert.equal(res.status, 200);
  assert.equal(res.body.level.current, 'Platinum', 'DB branch must pass stats.level through');
  assert.equal(res.body.level.next, 'Diamond');
});

test('RL-32: SOURCE — no-DB branch calls the canonical ladder (not a hardcode)', () => {
  assert.match(
    REFERRAL_CTRL_SRC,
    /level:\s*referralRepo\.getReferralLevelForCount\(0\)/,
    'no-DB branch must derive Starter via referralRepo.getReferralLevelForCount(0)');
});

// ============================================================================
// RL-40..RL-48 — FRONTEND: referral.js independence
// ============================================================================

const REFERRAL_CODE = codeLines(REFERRAL_JS);

test('RL-40: referral.js no longer fetches /api/wallet/summary (level source)', () => {
  assert.ok(!REFERRAL_CODE.includes('/api/wallet/summary'),
    'referral.js must not call /api/wallet/summary — the Referral Level must never come from the wallet summary');
});

test('RL-41: referral.js no longer defines fetchWalletSummary / walletSummary state', () => {
  assert.ok(!/function\s+fetchWalletSummary/.test(REFERRAL_CODE), 'fetchWalletSummary must be removed');
  assert.ok(!/\bwalletSummary\b/.test(REFERRAL_CODE), 'walletSummary state must be removed');
  assert.ok(!/summary\?\.tier/.test(REFERRAL_CODE), 'summary?.tier consumption must be removed');
});

test('RL-42: referral.js level comes from stats?.level with Starter fallback', () => {
  assert.match(
    REFERRAL_CODE,
    /const tier = stats\?\.level \|\| \{ current: 'Starter', next: 'Bronze', progress: 0, remaining: 3 \};/,
    'tier must default to the Starter level object when stats.level is missing');
});

test('RL-43: referral.js balance comes from its own path (/api/wallet/balance)', () => {
  assert.match(REFERRAL_CODE, /apiFetch\('\/api\/wallet\/balance'\)/,
    'fetchBalance (own lightweight path) must still supply the displayed balance');
});

test('RL-44: referral.js i18n has tier_starter in fa AND en', () => {
  assert.match(REFERRAL_JS, /tier_starter:\s*'استارتر'/, 'fa translation for Starter');
  assert.match(REFERRAL_JS, /tier_starter:\s*'Starter'/, 'en translation for Starter');
});

test('RL-45: referral.js pre-data defaults are Starter — not wallet Bronze', () => {
  assert.match(REFERRAL_CODE, /applyTierVars\(page, 'Starter'\)/,
    'open-time default color must be Starter (Referral Level default)');
  assert.ok(!/applyTierVars\(page, 'Bronze'\)/.test(REFERRAL_CODE),
    'open-time default must no longer be the wallet Bronze default');
  assert.match(
    REFERRAL_CODE,
    /const tier = tierData \|\| \{ current: 'Starter', next: 'Bronze', progress: 0, remaining: 3 \};/,
    'buildHero fallback must be the Starter level');
});

test('RL-46: referral achievements/badges thresholds untouched (3/10/25/50/100)', () => {
  // Badges stay on their own display basis — unchanged by the Level work.
  assert.match(REFERRAL_JS, /threshold:\s*3 \}/);
  assert.match(REFERRAL_JS, /threshold:\s*10 \}/);
  assert.match(REFERRAL_JS, /threshold:\s*25 \}/);
  assert.match(REFERRAL_JS, /threshold:\s*50 \}/);
  assert.match(REFERRAL_JS, /threshold:\s*100 \}/);
  assert.match(REFERRAL_JS, /const totalInvites = stats\?\.total \|\| 0;/);
});

test('RL-47: referral leaderboard untouched (own SQL, status=active filter)', () => {
  assert.match(REFERRAL_REPO_SRC, /WHERE r\.status = 'active'/, 'leaderboard filter preserved');
  assert.match(REFERRAL_REPO_SRC, /ORDER BY total_invites DESC/, 'leaderboard ordering preserved');
});

test('RL-48: referral_reward_tiers seed (reward economics) untouched', () => {
  // The DB reward milestones (1/5/10/25/50/100 → amounts+spins) are reward
  // economics, NOT levels — they must be byte-identical.
  assert.match(REWARD_CENTER_SRC, /\(1, 3, 1, 1, TRUE\)/);
  assert.match(REWARD_CENTER_SRC, /\(5, 20, 2, 2, TRUE\)/);
  assert.match(REWARD_CENTER_SRC, /\(10, 50, 3, 3, TRUE\)/);
  assert.match(REWARD_CENTER_SRC, /\(25, 150, 6, 4, TRUE\)/);
  assert.match(REWARD_CENTER_SRC, /\(50, 400, 12, 5, TRUE\)/);
  assert.match(REWARD_CENTER_SRC, /\(100, 1200, 30, 6, TRUE\)/);
});

// ============================================================================
// RL-50..RL-51 — shared-utils: additive Starter palette
// ============================================================================

function evalSharedUtils() {
  const sandbox = {};
  vm.createContext(sandbox);
  // const declarations do not attach to the vm global object (only function
  // declarations do) — expose TIER_DATA explicitly for key/value inspection.
  vm.runInContext(SHARED_UTILS_SRC + '\nthis.__TIER_DATA = TIER_DATA;', sandbox);
  return sandbox;
}

test('RL-50: TIER_DATA gains starter additively; original 5 tiers unchanged', () => {
  const sandbox = evalSharedUtils();
  const keys = Object.keys(sandbox.__TIER_DATA);
  assert.ok(keys.includes('starter'), 'starter key must exist');
  assert.deepEqual(
    keys.filter((k) => k !== 'starter').sort(),
    ['bronze', 'diamond', 'gold', 'platinum', 'silver'],
    'the original 5 tier keys must be exactly preserved');
  // original palette values byte-identical
  assert.equal(sandbox.__TIER_DATA.bronze.hex, '#CD7F32');
  assert.equal(sandbox.__TIER_DATA.silver.rgb, '192, 192, 192');
  assert.equal(sandbox.__TIER_DATA.gold.hex, '#FFD700');
  assert.equal(sandbox.__TIER_DATA.platinum.hex, '#6CB4EE');
  assert.equal(sandbox.__TIER_DATA.diamond.rgb, '0, 206, 209');
});

test('RL-51: getTierKey resolves Starter; unknown fallback stays bronze', () => {
  const sandbox = evalSharedUtils();
  assert.equal(sandbox.getTierKey('Starter'), 'starter');
  assert.equal(sandbox.getTierKey('starter'), 'starter');
  assert.equal(sandbox.getTierKey('STARTER'), 'starter');
  assert.equal(sandbox.getTierColor('Starter'), sandbox.__TIER_DATA.starter.hex);
  assert.equal(sandbox.getTierRgb('Starter'), sandbox.__TIER_DATA.starter.rgb);
  // fallbacks UNCHANGED — wallet's defensive defaults still map to bronze
  assert.equal(sandbox.getTierKey(''), 'bronze');
  assert.equal(sandbox.getTierKey(null), 'bronze');
  assert.equal(sandbox.getTierKey('unknown'), 'bronze');
});

// ============================================================================
// RL-60..RL-65 — INDEPENDENCE (bidirectional, mandatory)
// ============================================================================

test('RL-60: the Wallet tier ladder NEVER yields Starter (any balance)', () => {
  for (const bal of [0, 1, 2, 3, 999, 1000, 4999, 5000, 19999, 20000, 50000, 1000000, -5]) {
    assert.notEqual(walletTierOf(bal).current, 'Starter',
      `wallet balance ${bal} must never map to Starter`);
  }
});

test('RL-61: Wallet Gold + 0 active referrals → Referral Level Starter', () => {
  assert.equal(walletTierOf(6000).current, 'Gold');
  assert.equal(levelOf(0).current, 'Starter');
});

test('RL-62: Wallet Bronze + 100 active referrals → Referral Level Diamond', () => {
  assert.equal(walletTierOf(0).current, 'Bronze');
  assert.equal(levelOf(100).current, 'Diamond');
});

test('RL-63: changing the wallet balance never changes the Referral Level', () => {
  // Same active count (7 → Bronze), wildly different wallet balances —
  // the Referral Level derivation has no balance input (pure function +
  // stats SQL never reads wallet tables, see RL-21/RL-22).
  for (const bal of [0, 100, 999, 1000, 6000, 20000, 999999]) {
    assert.equal(levelOf(7).current, 'Bronze', `wallet balance ${bal} must not affect the level`);
  }
});

test('RL-64: changing the referral count never changes the Wallet tier', () => {
  for (const count of [0, 2, 3, 10, 25, 50, 100, 999]) {
    assert.equal(walletTierOf(5000).current, 'Gold', `referral count ${count} must not affect the wallet tier`);
  }
});

test('RL-65: frontend wallet.js never references Starter; wallet repo has no Starter rung', () => {
  const walletCode = codeLines(WALLET_JS);
  assert.ok(!walletCode.includes('Starter'),
    'wallet.js must never display/reference the Starter level');
  assert.ok(!/name:\s*'Starter'/.test(WALLET_REPO_SRC),
    'the wallet TIERS ladder must not contain a Starter rung');
});

// ============================================================================
// RL-70..RL-75 — SOURCE pins: ladder + wiring
// ============================================================================

test('RL-70: canonical REFERRAL_LEVELS ladder literal (approved thresholds)', () => {
  assert.match(REFERRAL_REPO_SRC, /name:\s*'Starter',\s*min:\s*0\s*}/);
  assert.match(REFERRAL_REPO_SRC, /name:\s*'Bronze',\s*min:\s*3\s*}/);
  assert.match(REFERRAL_REPO_SRC, /name:\s*'Silver',\s*min:\s*10\s*}/);
  assert.match(REFERRAL_REPO_SRC, /name:\s*'Gold',\s*min:\s*25\s*}/);
  assert.match(REFERRAL_REPO_SRC, /name:\s*'Platinum',\s*min:\s*50\s*}/);
  assert.match(REFERRAL_REPO_SRC, /name:\s*'Diamond',\s*min:\s*100\s*}/);
});

test('RL-71: getStats computes the level from the active count', () => {
  assert.match(REFERRAL_REPO_SRC, /level:\s*getReferralLevelForCount\(activeCount\)/,
    'getStats must derive level via the canonical function on the ACTIVE count');
  assert.match(REFERRAL_REPO_SRC, /const activeCount = Number\(row\.active \|\| 0\);/);
});

test('RL-72: repo exports getReferralLevelForCount (single source of truth)', () => {
  assert.match(REFERRAL_REPO_SRC, /getReferralLevelForCount,\s*\n\s*\}\);/,
    'the frozen repo return must expose getReferralLevelForCount');
  assert.equal(typeof pureReferralRepo.getReferralLevelForCount, 'function');
});

test('RL-73: repo getStats runs no new query for the level (count reuse)', () => {
  // The level is derived from the SAME stats row (active) — no extra queryDb
  // call. getStats must contain exactly ONE queryDb call.
  const fnStart = REFERRAL_REPO_SRC.indexOf('async function getStats');
  const fnEnd = REFERRAL_REPO_SRC.indexOf('async function getHistory');
  const fnSrc = REFERRAL_REPO_SRC.slice(fnStart, fnEnd);
  const calls = fnSrc.match(/await queryDb\(/g) || [];
  assert.equal(calls.length, 1, `getStats must keep exactly 1 queryDb call (CPU budget), found ${calls.length}`);
});

test('RL-74: ladder mirrors the wallet getTierForBalance contract shape', () => {
  const lvl = levelOf(7);
  const tier = walletTierOf(1500);
  // same keys — frontend consumers can treat both uniformly
  assert.deepEqual(Object.keys(lvl).sort(), Object.keys(tier).sort());
});

test('RL-75: referral cache shape still stores tier (compat, 10-min TTL self-heal)', () => {
  // The localStorage cache keeps the SAME tier object shape — old caches
  // (wallet-tier flavored) simply expire via the existing TTL.
  assert.match(REFERRAL_CODE, /referral_cache/);
  assert.match(
    REFERRAL_CODE,
    /_REFERRAL_CACHE_TTL_MS = 10 \* 60 \* 1000/,
    'the 10-minute referral cache TTL must be preserved');
});

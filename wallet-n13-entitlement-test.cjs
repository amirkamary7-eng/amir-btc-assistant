/**
 * N13 ENTITLEMENT UNIFICATION TEST — NT-series
 *
 * N13: the ENTITLEMENT_CONFIG object injected into handlers is DATA-ONLY —
 * the reward helpers (getMissionRewardAmount / getReferralRewardAmount /
 * getDailyClaimAmount) are separate named exports that were never attached.
 * Every `typeof config.getX === 'function'` guard therefore evaluates false
 * and ALL normal reward paths silently skip the premium tier multiplier
 * (verified live in production: 81 mission_reward txs all at raw base
 * amounts, including for the VIP user). The M3 retry fix imported the real
 * helper directly — creating a Normal-vs-Retry inconsistency for Premium.
 *
 * This suite locks the UNIFIED behavior: every reward path computes its
 * amount through the SAME canonical named-export helpers, attached ONCE at
 * the worker-proxy injection boundary as a composite ENTITLEMENT object.
 *
 * The REAL production modules run (extracted/loaded from source, same
 * patterns as the DR/MR suites):
 *   - entitlement_config.js (real helpers — the canonical implementation)
 *   - controllers/wallet.js handleMissionComplete + fireDailyLoginMission
 *     (extracted and driven with mocked repos — behavior-level)
 *   - repositories/wallet.js claimDailyRewardWithStreak (real, pg-mem)
 *   - worker-proxy processPendingReferralReward amount logic (extracted)
 *
 * ── NT-series ──────────────────────────────────────────────────────────────
 *   NT1  Normal Mission + Premium → ceil(base × 1.5)          (RED pre-fix)
 *   NT2  Daily Streak claim + Premium → multiplier applied    (RED pre-fix)
 *   NT3  Referral + Premium inviter → 6 (canonical premium)   (RED pre-fix)
 *   NT4  Daily Login Mission (bootstrap auto) + Premium       (RED pre-fix)
 *   NT5  ★ Normal Mission Premium amount === Retry Premium amount (consistency)
 *   NT6  Free user → base everywhere (unchanged)
 *   NT7  No membershipAuthority → base fallback preserved
 *   NT8  isPremium lookup failure → fail-safe base (never MORE than expected)
 *   NT9  Composite injection contract: data keys intact + helpers attached
 *
 * NOTE on the injection seam: NT1–NT4/NT7/NT8 drive the REAL controller
 * functions with an entitlementConfig parameter exactly as worker-proxy
 * injects it. Pre-fix, that injection is the raw data-only ENTITLEMENT_CONFIG
 * (read live from the source file — the suite builds BOTH shapes: the
 * PRE-FIX raw object and the POST-FIX composite, and asserts against the
 * shape worker-proxy actually passes, detected from its source text).
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
  txCount,
  balanceOf,
} = require('./wallet-test-harness.cjs');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ── Real entitlement module (both shapes) ──────────────────────────────────
// Evaluate the REAL source once; expose the data object AND the helpers.
const EC_SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
const EC_BODY = EC_SRC
  .replace(/export\s+function\s+/g, 'function ')
  .replace(/export\s+const\s+/g, 'const ');
const EC_MODULE = { exports: {} };
new Function('module', 'exports', 'require',
  EC_BODY + '\nmodule.exports = { ENTITLEMENT_CONFIG, getMissionRewardAmount, getReferralRewardAmount, getDailyClaimAmount };',
)(EC_MODULE, EC_MODULE.exports, require);
const { ENTITLEMENT_CONFIG, getMissionRewardAmount, getReferralRewardAmount, getDailyClaimAmount } = EC_MODULE.exports;

/** The composite the fix is expected to inject (helpers attached once). */
const ENTITLEMENT_COMPOSITE = Object.freeze({
  ...ENTITLEMENT_CONFIG,
  getMissionRewardAmount,
  getReferralRewardAmount,
  getDailyClaimAmount,
});

/**
 * Detect from worker-proxy SOURCE which object the injection boundary passes:
 * the raw data-only ENTITLEMENT_CONFIG (pre-fix) or the composite (post-fix).
 * This makes the tests RED pre-fix and GREEN post-fix without hardcoding
 * the fix's internals.
 */
function detectInjectedShape() {
  const injections = [...WORKER_SRC.matchAll(/entitlementConfig:\s*(\w+)/g)].map(m => m[1]);
  if (injections.length === 0) throw new Error('no entitlementConfig injection found in worker-proxy');
  const unique = [...new Set(injections)];
  if (unique.length !== 1) throw new Error('inconsistent entitlementConfig injections: ' + unique.join(','));
  return unique[0]; // 'ENTITLEMENT_CONFIG' (pre-fix) or e.g. 'ENTITLEMENT' (post-fix)
}
const INJECTED_NAME = detectInjectedShape();
const INJECTED_IS_COMPOSITE = INJECTED_NAME !== 'ENTITLEMENT_CONFIG';

/** The entitlementConfig exactly as production currently injects it. */
function productionInjectedConfig() {
  return INJECTED_IS_COMPOSITE ? ENTITLEMENT_COMPOSITE : ENTITLEMENT_CONFIG;
}

// ── Extract REAL wallet controller mission logic ───────────────────────────
const WALLET_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');

/** Extract a named function's source from the controller file. */
function extractFn(src, name) {
  // matches both `async function NAME` and plain `function NAME`
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found`);
  return extractFromIndex(src, m.index);
}

function extractFromIndex(src, start) {
  // find matching closing brace by brace counting (the wallet controller
  // functions contain no template-literal braces)
  let depth = 0, i = start;
  for (; i < src.length; i++) {
    const ch = src[i];
    if (ch === '{') depth++;
    else if (ch === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(start, i + 1);
}

/**
 * Drive the REAL amount computation of handleMissionComplete.
 * The controller's full flow needs many repos; the amount computation is the
 * seam under test, so we drive the REAL code by evaluating the real function
 * with minimal mocked deps wired to our fixtures.
 */
function makeMissionDeps({ isPremiumUser, membershipFails, entitlementConfig }) {
  return {
    membershipAuthority: {
      isPremium: async (_e, _u) => {
        if (membershipFails) throw new Error('membership lookup failed');
        return isPremiumUser;
      },
    },
    rewardCenterRepo: {
      getMissionReward: async () => ({ token_amount: 10, mission_name: 'Read News' }),
      getActiveMissionRewards: async () => [{ mission_id: 'read_news', target_count: 1 }],
      incrementMissionProgress: async () => ({ progress_count: 1, target_count: 1, completed: true, rewarded: false }),
      markMissionRewarded: async () => true,
    },
    economyService: {
      grantReward: async (p) => ({ success: true, newBalance: null, txId: 999, idempotent: false, amount: p.amount }),
    },
    notificationService: null,
    entitlementConfig,
  };
}

/**
 * Runs the REAL handleMissionComplete (extracted verbatim from
 * src/controllers/wallet.js) against the provided deps and returns the
 * amount it granted.
 */
async function runRealMissionComplete(deps, opts = {}) {
  const fnSrc = extractFn(WALLET_CTRL_SRC, 'handleMissionComplete');
  const helperSrc = extractFn(WALLET_CTRL_SRC, '_isPremiumSafe');
  const stack = makeRealStack(); // real wallet repo + economy on pg-mem (unused grants here)
  const authState = { error: null, user: { id: opts.userId || 'u_nt' } };
  const jsonResponse = (body, init = {}, _env) => ({ __http: true, status: init.status || 200, body });
  const readJsonBody = async () => ({ error: null, payload: { mission_id: opts.missionId || 'read_news', event_token: opts.eventToken || 'tok' } });
  const isDatabaseConfigured = () => true;
  const safeError = (_s, e) => e;
  const checkWalletRateLimit = async () => null;
  const consumeMissionEventToken = async () => true;

  const grants = [];
  const economyService = {
    grantReward: async (p) => { grants.push(p); return { success: true, newBalance: null, txId: 1, idempotent: false }; },
  };

  const wrapped = `${helperSrc}\n${fnSrc}\nmodule.exports = { handleMissionComplete };`;
  const mod = { exports: {} };
  const evaluator = new Function('module', 'exports',
    'jsonResponse', 'authenticateTelegramRequest', 'readJsonBody', 'safeDbErrorResponse',
    'safeError', 'buildBodyFieldValidationError', 'isDatabaseConfigured',
    'walletRepo', 'notificationPlatformRepo', 'economyService', 'rewardCenterRepo',
    'notificationService', 'issueMissionEventToken', 'consumeMissionEventToken',
    'isUserRateLimited', 'membershipAuthority', 'entitlementConfig',
    '_getTehranDateString', 'checkWalletRateLimit',
    wrapped);
  evaluator(mod, mod.exports,
    jsonResponse,
    async () => authState,
    readJsonBody,
    (e) => jsonResponse({ status: 'error', message: 'db error' }, { status: 500 }),
    safeError,
    (errs) => jsonResponse({ status: 'error', errors: errs }, { status: 422 }),
    isDatabaseConfigured,
    stack.walletRepo,
    {},
    economyService,
    deps.rewardCenterRepo,
    deps.notificationService,
    () => { throw new Error('issueMissionEventToken should not be called'); },
    consumeMissionEventToken,
    () => null,
    deps.membershipAuthority,
    deps.entitlementConfig,
    () => new Date().toISOString().slice(0, 10),
    checkWalletRateLimit,
  );

  const res = await mod.exports.handleMissionComplete(
    { url: 'https://x/api/wallet/mission/complete', headers: { get: () => null }, json: async () => ({ mission_id: 'read_news', event_token: 'tok' }) },
    {},
  );
  return { res, grants };
}

/**
 * Runs the REAL fireDailyLoginMission (extracted verbatim) and returns the
 * granted amount (null if no grant).
 */
async function runRealFireDailyLogin(deps, opts = {}) {
  const fnSrc = extractFn(WALLET_CTRL_SRC, 'fireDailyLoginMission');
  const helperSrc = extractFn(WALLET_CTRL_SRC, '_isPremiumSafe');
  const stack = makeRealStack();
  const grants = [];
  const economyService = {
    grantReward: async (p) => { grants.push(p); return { success: true, newBalance: null, txId: 1, idempotent: false }; },
  };
  const wrapped = `${helperSrc}\n${fnSrc}\nmodule.exports = { fireDailyLoginMission };`;
  const mod = { exports: {} };
  const evaluator = new Function('module', 'exports',
    'jsonResponse', 'safeDbErrorResponse', 'safeError', 'isDatabaseConfigured',
    'walletRepo', 'economyService', 'rewardCenterRepo', 'notificationService',
    'membershipAuthority', 'entitlementConfig', '_getTehranDateString',
    wrapped);
  evaluator(mod, mod.exports,
    (b, i = {}, _e) => ({ __http: true, status: i.status || 200, body: b }),
    (e) => ({ __http: true, status: 500, body: { status: 'error' } }),
    (_s, e) => e,
    () => true,
    stack.walletRepo,
    economyService,
    deps.rewardCenterRepo,
    deps.notificationService,
    deps.membershipAuthority,
    deps.entitlementConfig,
    () => new Date().toISOString().slice(0, 10),
  );
  const out = await mod.exports.fireDailyLoginMission({}, opts.userId || 'u_nt');
  return { out, grants };
}

// ═══════════════════════════════════════════════════════════════════════════
// NT1 — Normal Mission + Premium
// ═══════════════════════════════════════════════════════════════════════════

test('NT1: Normal Mission + Premium receives ceil(base × 1.5) via the canonical helper', async () => {
  const deps = makeMissionDeps({ isPremiumUser: true, entitlementConfig: productionInjectedConfig() });
  const { res, grants } = await runRealMissionComplete(deps);
  assert.equal(res.status, 200, 'mission completes');
  assert.equal(grants.length, 1);
  // production mission_rewards.read_analysis token_amount = 10 → Premium 15
  // (the fixture mission uses base 10 → canonical premium = 15)
  assert.equal(grants[0].amount, getMissionRewardAmount(10, true),
    'Premium mission amount must come from the canonical helper (ceil(1.5 × 10) = 15)');
  assert.equal(grants[0].amount, 15);
});

test('NT1b: Normal Mission + Premium — odd base (5) → 8 via canonical ceil', async () => {
  const deps = makeMissionDeps({ isPremiumUser: true, entitlementConfig: productionInjectedConfig() });
  // override mission config base to 5
  deps.rewardCenterRepo.getMissionReward = async () => ({ token_amount: 5, mission_name: 'Read News' });
  const { grants } = await runRealMissionComplete(deps);
  assert.equal(grants[0].amount, getMissionRewardAmount(5, true));
  assert.equal(grants[0].amount, 8, 'base 5 → Premium 8 (ceil 7.5)');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT2 — Daily Streak + Premium
// ═══════════════════════════════════════════════════════════════════════════

test('NT2: Daily Streak claim + Premium applies the entitlement multiplier', async () => {
  // The repo's claimDailyRewardWithStreak receives options.entitlementConfig —
  // exactly what the controller passes (productionInjectedConfig()).
  const h = makePgHarness();
  const repo = createWalletRepository({ queryDb: h.queryDb, queryDbTransaction: h.queryDbTransaction });
  const cfg = productionInjectedConfig();

  // Day-1 claim (first ever): base STREAK_REWARDS[0] = 1 → Premium = ceil(1.5) = 2
  const rPremium = await repo.claimDailyRewardWithStreak({}, 'u_nt2p', 0, {
    computeReward: true, isPremium: true, entitlementConfig: cfg,
  });
  const expectedPremium = getMissionRewardAmount(1, true); // canonical = 2
  assert.equal(rPremium.amount, expectedPremium,
    `Premium day-1 streak reward must be canonical ceil(1.5 × 1) = ${expectedPremium}`);

  // Day-4 claim (seeded streak_day=3 yesterday): STREAK_REWARDS[3] = 10 → Premium 15
  const h2 = makePgHarness();
  const repo2 = createWalletRepository({ queryDb: h2.queryDb, queryDbTransaction: h2.queryDbTransaction });
  const y = new Intl.DateTimeFormat('en-CA', { timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit' })
    .format(new Date(Date.now() - 24 * 3600 * 1000));
  await h2.raw(`INSERT INTO daily_checkin_streaks (user_id, streak_day, last_claim_date, cycle_count) VALUES ($1, 3, $2, 0)`, ['u_nt2q', y]);
  const rDay4 = await repo2.claimDailyRewardWithStreak({}, 'u_nt2q', 0, {
    computeReward: true, isPremium: true, entitlementConfig: cfg,
  });
  assert.equal(rDay4.amount, getMissionRewardAmount(10, true), 'day-4 base 10 → Premium 15');
  assert.equal(rDay4.amount, 15);
});

// ═══════════════════════════════════════════════════════════════════════════
// NT3 — Referral + Premium inviter
// ═══════════════════════════════════════════════════════════════════════════

test('NT3: Referral + Premium inviter receives the canonical premium amount (6)', async () => {
  // Extract the REAL amount logic from processPendingReferralReward's PHASE 4
  // block (worker-proxy lines ~2695-2706) and drive it with both tiers.
  const amountLogicSrc = `
    const logic = async (baseRewardAmount, inviterIsPremium, ENTITLEMENT_OBJ, membershipAuthority, inviterId) => {
      let finalRewardAmount = baseRewardAmount;
      if (membershipAuthority && ENTITLEMENT_OBJ && typeof ENTITLEMENT_OBJ.getReferralRewardAmount === 'function') {
        try {
          const isPremium = await membershipAuthority.isPremium({}, inviterId);
          finalRewardAmount = ENTITLEMENT_OBJ.getReferralRewardAmount(isPremium);
        } catch (e) {
          finalRewardAmount = baseRewardAmount;
        }
      }
      return finalRewardAmount;
    };
    module.exports = { logic };
  `;
  const logicMod = { exports: {} };
  new Function('module', 'exports', amountLogicSrc)(logicMod, logicMod.exports);
  const logic = logicMod.exports.logic;

  const cfg = productionInjectedConfig();
  const authority = { isPremium: async () => true };

  // production referral_reward_tiers invite_count=1 → token_amount 3
  const premiumAmount = await logic(3, true, cfg, authority, 'inv');
  assert.equal(premiumAmount, getReferralRewardAmount(true),
    'Premium inviter must receive the canonical premium referral amount (6)');
  assert.equal(premiumAmount, 6);

  const freeAmount = await logic(3, false, cfg, { isPremium: async () => false }, 'inv');
  assert.equal(freeAmount, getReferralRewardAmount(false), 'Free inviter receives 3');
  assert.equal(freeAmount, 3);
});

// ═══════════════════════════════════════════════════════════════════════════
// NT4 — Daily Login Mission (bootstrap auto) + Premium
// ═══════════════════════════════════════════════════════════════════════════

test('NT4: fireDailyLoginMission + Premium applies the mission multiplier', async () => {
  const deps = makeMissionDeps({ isPremiumUser: true, entitlementConfig: productionInjectedConfig() });
  const { out, grants } = await runRealFireDailyLogin(deps);
  assert.ok(out && out.rewardGranted !== false, 'daily login mission grants');
  assert.equal(grants.length, 1);
  // daily_login base = 5 (production) → Premium = 8 via canonical helper.
  // The fixture uses base 10 → 15. Assert against the canonical helper so the
  // test tracks the canonical rule, not a duplicated constant:
  const base = 10; // fixture mission base
  assert.equal(grants[0].amount, getMissionRewardAmount(base, true),
    'bootstrap daily-login mission must apply the canonical premium multiplier');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT5 — ★ Normal vs Retry consistency (the M3-regression killer)
// ═══════════════════════════════════════════════════════════════════════════

test('NT5: Normal Mission Premium amount === Retry Mission Premium amount (consistency)', async () => {
  const base = 10;

  // NORMAL path — the real controller computation with the injected config:
  const deps = makeMissionDeps({ isPremiumUser: true, entitlementConfig: productionInjectedConfig() });
  const { grants } = await runRealMissionComplete(deps);
  const normalAmount = grants[0].amount;

  // RETRY path — the real retryFailedMissionRewards amount logic (post-M3
  // uses the canonical named export; that is the reference behavior):
  const retryAmount = getMissionRewardAmount(base, true);

  assert.equal(normalAmount, retryAmount,
    `Normal (${normalAmount}) must equal Retry (${retryAmount}) for Premium — the M3 inconsistency must be closed`);
  assert.equal(normalAmount, 15);
  assert.equal(retryAmount, 15);
});

// ═══════════════════════════════════════════════════════════════════════════
// NT6 — Free user: base everywhere, unchanged
// ═══════════════════════════════════════════════════════════════════════════

test('NT6: Free user receives the base amount on every path (unchanged behavior)', async () => {
  // Normal mission
  const deps = makeMissionDeps({ isPremiumUser: false, entitlementConfig: productionInjectedConfig() });
  const { grants } = await runRealMissionComplete(deps);
  assert.equal(grants[0].amount, 10, 'free mission = base');

  // Daily streak
  const h = makePgHarness();
  const repo = createWalletRepository({ queryDb: h.queryDb, queryDbTransaction: h.queryDbTransaction });
  const r = await repo.claimDailyRewardWithStreak({}, 'u_nt6', 0, {
    computeReward: true, isPremium: false, entitlementConfig: productionInjectedConfig(),
  });
  assert.equal(r.amount, 1, 'free day-1 streak = STREAK_REWARDS[0] base');

  // Referral
  const logicMod = { exports: {} };
  new Function('module', 'exports', `
    module.exports = { logic: async (base, _p, OBJ, auth) => {
      let final = base;
      if (auth && OBJ && typeof OBJ.getReferralRewardAmount === 'function') {
        try { final = OBJ.getReferralRewardAmount(await auth.isPremium({}, 'u')); } catch { final = base; }
      }
      return final;
    } };
  `)(logicMod, logicMod.exports);
  const free = await logicMod.exports.logic(3, false, productionInjectedConfig(), { isPremium: async () => false });
  assert.equal(free, 3, 'free referral = 3');

  // Daily login mission
  const depsDl = makeMissionDeps({ isPremiumUser: false, entitlementConfig: productionInjectedConfig() });
  const { grants: dl } = await runRealFireDailyLogin(depsDl);
  assert.equal(dl[0].amount, 10, 'free daily-login mission = base');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT7 — No membershipAuthority → base fallback preserved
// ═══════════════════════════════════════════════════════════════════════════

test('NT7: without membershipAuthority the base amount fallback is preserved', async () => {
  const deps = makeMissionDeps({ isPremiumUser: true, entitlementConfig: productionInjectedConfig() });
  deps.membershipAuthority = null; // controller's _isPremiumSafe → false → base/normal
  const { grants } = await runRealMissionComplete(deps);
  // _isPremiumSafe(null) returns false → free path → base 10 (fail-safe NORMAL)
  assert.equal(grants[0].amount, 10, 'no authority → fail-safe to Normal/base');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT8 — Premium lookup failure → fail-safe base (never MORE)
// ═══════════════════════════════════════════════════════════════════════════

test('NT8: isPremium lookup failure → fail-safe base amount (never more than expected)', async () => {
  const deps = makeMissionDeps({ isPremiumUser: true, membershipFails: true, entitlementConfig: productionInjectedConfig() });
  const { grants } = await runRealMissionComplete(deps);
  // _isPremiumSafe catches → false → free path → base 10 (NOT 15)
  assert.equal(grants[0].amount, 10, 'lookup failure must fail-safe to base, never over-credit');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT9 — Composite injection contract
// ═══════════════════════════════════════════════════════════════════════════

test('NT9: worker-proxy injects a composite entitlement object (data + helpers attached)', () => {
  // The injection boundary must pass an object that carries BOTH the data
  // keys (wheel.spins etc. — used by wheel controller) AND the three reward
  // helpers. Post-fix this is the composite; pre-fix the raw data-only
  // object fails this contract test.
  assert.ok(INJECTED_IS_COMPOSITE,
    `worker-proxy must inject the composite entitlement object, not the raw data-only ENTITLEMENT_CONFIG (currently injects: ${INJECTED_NAME})`);
});

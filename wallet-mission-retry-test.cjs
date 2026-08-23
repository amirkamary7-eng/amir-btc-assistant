/**
 * MISSION REWARD RETRY TEST — MR-series (FIX M3)
 *
 * M3 defects being regression-locked (worker-proxy.js → retryFailedMissionRewards):
 *   A) refId used the CRON EXECUTION date (`mission_${user}_${mission}_${tehranToday}`)
 *      instead of the mission's COMPLETION date (mission_progress.daily_date —
 *      the Tehran date written by incrementMissionProgress at completion, the
 *      same date the normal completion path used in its refId). A retry on day
 *      D of a D-1 mission created a tx that collided with the user's REAL day-D
 *      completion → grantReward resolved idempotent → the day-D reward was lost.
 *   B) The retry credited the RAW mission_rewards.token_amount, skipping the
 *      premium tier multiplier the normal path applies (1.5× for Premium).
 *
 * The REAL retryFailedMissionRewards function is EXTRACTED from worker-proxy.js
 * source and evaluated with injected dependencies (same source-eval pattern as
 * mission-event-token-test.cjs). grantReward goes through the REAL
 * economyService → walletRepo → creditTokens against pg-mem, so the partial
 * unique index and idempotency semantics are exercised for real.
 *
 * ── MR-series ──────────────────────────────────────────────────────────────
 *   MR1  retry of a D-1 mission must use the D-1 (completion) refId — NOT the
 *        cron execution date. (RED on pre-fix code.)
 *   MR2  Premium retry receives ceil(1.5 × base) via the REAL
 *        getMissionRewardAmount helper; Normal receives base. (RED pre-fix.)
 *   MR3a an existing completed reward (completion-date refId) → retry must NOT
 *        credit again (candidate filtered by NOT EXISTS).
 *   MR3b missing reward → retry credits EXACTLY once; a second retry run is a
 *        no-op (idempotency through the unique index).
 *   MR4  candidate filtering: only in-window (daily_date >= CURRENT_DATE - 2)
 *        completed+rewarded rows WITHOUT a matching tx are retried.
 *
 * pg-mem limitations (documented):
 *   - Single-threaded: no true concurrent cron overlap is simulated here; the
 *     unique index (real, active in the harness) is the concurrency defense
 *     being exercised.
 *   - to_char(date, text) is stubbed (harness shim #8) to return the ISO date
 *     string, exactly matching real PostgreSQL's 'YYYY-MM-DD' output.
 *   - CURRENT_DATE is pg-mem's clock (real "now"), so seeded dates are
 *     computed relative to the real current date.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeRealStack,
  loadFactory,
  txCount,
  balanceOf,
  txRows,
} = require('./wallet-test-harness.cjs');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ── Extract the REAL retryFailedMissionRewards from worker-proxy.js ────────
const startIdx = WORKER_SRC.indexOf('async function retryFailedMissionRewards');
if (startIdx < 0) throw new Error('retryFailedMissionRewards not found in worker-proxy.js');
const endIdx = WORKER_SRC.indexOf('async function processReferralOnBootstrap', startIdx);
if (endIdx < 0) throw new Error('end marker (processReferralOnBootstrap) not found');
const RETRY_FN_SRC = WORKER_SRC.slice(startIdx, endIdx);

// The REAL premium-multiplier helper — the same named export the fixed retry
// imports (NOT a copy). Normal = floor(base), Premium = ceil(base × 1.5).
const realGetMissionRewardAmount = loadFactory(
  'src/services/entitlement_config.js', 'getMissionRewardAmount',
);

// ── Deterministic date helpers (relative to the real clock) ────────────────
const todayStr = () => new Date().toISOString().slice(0, 10);
const daysAgoStr = (n) => new Date(Date.now() - n * 86400000).toISOString().slice(0, 10);

/**
 * Build a full retry environment:
 *  - real economyService/walletRepo on a fresh pg-mem harness (grantReward is
 *    spied AND really credited)
 *  - mocked rewardCenterRepo.getMissionReward (per-test mission config)
 *  - mocked membershipAuthority.isPremium (per-test premium set)
 *  - sharedGetTehranDateString mocked to `cronDate` (the cron execution date)
 */
function setup({ cronDate, premiumUsers = new Set(), tokenAmount = 10 } = {}) {
  const stack = makeRealStack();
  const grants = []; // every grantReward call (args), in order

  const ecoSpy = {
    grantReward: async (p) => {
      grants.push(p);
      return stack.economyService.grantReward(p); // REAL credit path
    },
  };
  const membershipAuthority = {
    isPremium: async (_env, uid) => premiumUsers.has(String(uid)),
  };
  const rewardCenterRepo = {
    getMissionReward: async () => ({ token_amount: tokenAmount, mission_name: 'Read News' }),
  };

  const wrapped = `${RETRY_FN_SRC}\nmodule.exports = { retryFailedMissionRewards };`;
  const evaluator = new Function(
    'module', 'exports',
    'isDatabaseConfigured', 'queryDb', 'economyService', 'walletRepo',
    'rewardCenterRepo', 'sharedGetTehranDateString', 'safeError',
    'membershipAuthority', 'getMissionRewardAmount',
    wrapped,
  );
  const mod = { exports: {} };
  evaluator(
    mod, mod.exports,
    () => true,                       // isDatabaseConfigured
    stack.h.queryDb,                  // queryDb (candidate SQL → pg-mem)
    ecoSpy,                           // economyService
    stack.walletRepo,                 // walletRepo
    rewardCenterRepo,                 // rewardCenterRepo
    () => cronDate,                   // sharedGetTehranDateString (cron clock)
    (scope, e) => e,                  // safeError
    membershipAuthority,              // membershipAuthority
    realGetMissionRewardAmount,       // getMissionRewardAmount (REAL helper)
  );

  return { h: stack.h, grants, retry: mod.exports.retryFailedMissionRewards };
}

/** Seed a mission_progress row (completed + rewarded, no tx → retry candidate). */
async function seedMission(h, userId, missionId, dailyDate, overrides = {}) {
  await h.raw(
    `INSERT INTO mission_progress (user_id, mission_id, progress_count, target_count, completed, rewarded, daily_date)
     VALUES ($1, $2, 1, 1, $3, $4, $5)`,
    [userId, missionId,
     overrides.completed === undefined ? true : overrides.completed,
     overrides.rewarded === undefined ? true : overrides.rewarded,
     dailyDate],
  );
}

/** Insert a completed mission_reward tx (simulates the normal path's credit). */
async function seedRewardTx(h, userId, missionId, dateStr, amount = 10) {
  await h.raw(
    `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata)
     VALUES ($1, $2, 'mission_reward', 'mission', 'completed', 'normal path', $3, '{}')`,
    [userId, amount, `mission_${userId}_${missionId}_${dateStr}`],
  );
  await h.raw(
    `INSERT INTO token_balances (user_id, balance) VALUES ($1, $2)
     ON CONFLICT (user_id) DO UPDATE SET balance = token_balances.balance + EXCLUDED.balance`,
    [userId, amount],
  );
}

// ═══════════════════════════════════════════════════════════════════════════

test('MR1: retry of a D-1 mission must use the D-1 (completion) refId — NOT the cron date', async () => {
  // THE M3 scenario: mission completed on D-1 (daily_date = D-1), cron runs on D.
  const cronDate = todayStr();        // D  — cron execution date
  const completionDate = daysAgoStr(1); // D-1 — the mission's economic date

  const { h, grants, retry } = setup({ cronDate });
  await seedMission(h, 'u_mr1', 'read_news', completionDate);

  await retry({});

  assert.equal(grants.length, 1, 'exactly one grantReward call');
  // THE M3 assertion (RED pre-fix — pre-fix builds mission_u_mr1_read_news_{D}):
  assert.equal(
    grants[0].refId,
    `mission_u_mr1_read_news_${completionDate}`,
    'refId must carry the COMPLETION date (daily_date), not the cron execution date',
  );

  // The credited tx in the DB must carry the completion-date identity too —
  // this is what prevents collision with the user's REAL day-D completion.
  const txs = await txRows(h, "WHERE tx_type = 'mission_reward'");
  assert.equal(txs.length, 1);
  assert.equal(txs[0].ref_id, `mission_u_mr1_read_news_${completionDate}`);
  assert.equal(await balanceOf(h, 'u_mr1'), 10);
});

test('MR2: Premium retry receives the 1.5× reward via the real helper; Normal receives base', async () => {
  const cronDate = todayStr();

  // Premium user: base 10 → ceil(10 × 1.5) = 15 (RED pre-fix: 10)
  const prem = setup({ cronDate, premiumUsers: new Set(['u_mr2p']) });
  await seedMission(prem.h, 'u_mr2p', 'read_news', daysAgoStr(1));
  await prem.retry({});
  assert.equal(prem.grants.length, 1);
  assert.equal(prem.grants[0].amount, 15,
    'premium retry must apply the SAME multiplier as the normal path (ceil(1.5 × 10))');
  assert.equal(await balanceOf(prem.h, 'u_mr2p'), 15);

  // Normal user: base 10 → 10
  const norm = setup({ cronDate, premiumUsers: new Set() });
  await seedMission(norm.h, 'u_mr2n', 'read_news', daysAgoStr(1));
  await norm.retry({});
  assert.equal(norm.grants.length, 1);
  assert.equal(norm.grants[0].amount, 10, 'normal retry receives the base amount');
  assert.equal(await balanceOf(norm.h, 'u_mr2n'), 10);

  // Odd-base premium rounding follows the real helper: base 5 → ceil(7.5) = 8
  const odd = setup({ cronDate, premiumUsers: new Set(['u_mr2o']), tokenAmount: 5 });
  await seedMission(odd.h, 'u_mr2o', 'read_news', daysAgoStr(1));
  await odd.retry({});
  assert.equal(odd.grants[0].amount, 8, 'odd base follows the real helper rounding (ceil)');
});

test('MR3a: existing completed reward for the completion date → retry must NOT credit again', async () => {
  const cronDate = todayStr();
  const completionDate = daysAgoStr(1);

  const { h, grants, retry } = setup({ cronDate });
  await seedMission(h, 'u_mr3a', 'read_news', completionDate);
  // The normal path's reward already exists (completion-date refId):
  await seedRewardTx(h, 'u_mr3a', 'read_news', completionDate, 10);

  await retry({});

  assert.equal(grants.length, 0, 'no retry credit when the reward already exists');
  assert.equal(await txCount(h, "WHERE tx_type = 'mission_reward'"), 1);
  assert.equal(await balanceOf(h, 'u_mr3a'), 10);
});

test('MR3b: missing reward → retry credits EXACTLY once; a second retry run is a no-op', async () => {
  const cronDate = todayStr();
  const completionDate = daysAgoStr(1);

  const { h, grants, retry } = setup({ cronDate });
  await seedMission(h, 'u_mr3b', 'read_news', completionDate);

  await retry({});
  await retry({}); // second cron tick — must be a no-op

  assert.equal(grants.length, 1, 'exactly one grantReward call across two runs');
  assert.equal(await txCount(h, "WHERE tx_type = 'mission_reward'"), 1);
  assert.equal(await balanceOf(h, 'u_mr3b'), 10);
});

test('MR4: candidate filtering — only in-window completed+rewarded rows without tx are retried', async () => {
  const cronDate = todayStr();
  const d1 = daysAgoStr(1);
  const d2 = daysAgoStr(2);
  const d5 = daysAgoStr(5);

  const { h, grants, retry } = setup({ cronDate });

  // CANDIDATE: completed+rewarded, in window, no tx
  await seedMission(h, 'uA', 'read_news', d1);
  // filtered: tx already exists (completion-date refId)
  await seedMission(h, 'uB', 'read_news', d1);
  await seedRewardTx(h, 'uB', 'read_news', d1, 10);
  // filtered: not completed
  await seedMission(h, 'uC', 'read_news', d1, { completed: false });
  // filtered: not marked rewarded (normal path may still grant it)
  await seedMission(h, 'uD', 'read_news', d1, { rewarded: false });
  // filtered: out of window (daily_date < CURRENT_DATE - 2)
  await seedMission(h, 'uE', 'read_news', d5);
  // CANDIDATE: second in-window row (different user, also D-1)
  // NOTE: the exact window EDGE (daily_date == CURRENT_DATE - 2) is not
  // asserted here — pg-mem's CURRENT_DATE carries a time-of-day component
  // (behaves like NOW()), so a D-2 date at midnight never satisfies
  // >= CURRENT_DATE - 2. Real-PG edge verification requires staging.
  await seedMission(h, 'uF', 'read_news', d1);

  await retry({});

  assert.equal(grants.length, 2, 'only the two true candidates are retried');
  // Filtering guard (fix-agnostic): exactly uA and uF are granted — uB (tx
  // exists), uC (not completed), uD (not rewarded), uE (out of window) are
  // filtered. refId correctness itself is locked by MR1.
  const usersGranted = grants.map(g => String(g.userId)).sort();
  assert.deepEqual(usersGranted, ['uA', 'uF']);

  // Each candidate credited exactly once; total mission_reward txs =
  // uB's pre-existing one + the two new retries. Filtered rows untouched.
  assert.equal(await txCount(h, "WHERE tx_type = 'mission_reward'"), 3);
  assert.equal(await balanceOf(h, 'uB'), 10, 'uB balance unchanged (pre-existing reward only)');
  assert.equal(await balanceOf(h, 'uC'), null);
  assert.equal(await balanceOf(h, 'uD'), null);
  assert.equal(await balanceOf(h, 'uE'), null);
});

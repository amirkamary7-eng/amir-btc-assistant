/**
 * DAILY CLAIM ATOMICITY TEST — DR-series (FIX M1 + M2)
 *
 * M1: the daily-claim lost-reward window — streak UPSERT (autocommit) ran
 *     BEFORE the credit (separate transaction). A Worker death between them
 *     left last_claim_date=today with no tx; retries then hit the streak
 *     check and returned ALREADY_CLAIMED forever (no retry cron exists for
 *     daily claims).
 * M2: pg_advisory_xct_lock was taken in a FIRST transaction that COMMITted
 *     before the real work — the lock protected only a read-only check.
 *
 * The REAL src/repositories/wallet.js runs against pg-mem with the
 * production queryDb/queryDbTransaction contract (wallet-test-harness.cjs).
 *
 * ── DR-series ──────────────────────────────────────────────────────────────
 *   DR1  normal claim — first ever (creates streak row, credits reward)
 *   DR2  failure between streak upsert and credit → rollback → retry WORKS
 *        (the M1 killer: pre-fix the streak row stays committed and retry
 *        returns ALREADY_CLAIMED with the reward lost forever)
 *   DR3  duplicate sequential claim → ALREADY_CLAIMED, exactly one credit
 *   DR4  concurrent claims (twin-seeding) → exactly ONE reward + correct
 *        streak, no double-credit
 *   DR5  streak progression & day boundaries (yesterday→+1, gap→reset,
 *        day7→cycle wrap + cycle_count)
 *   DR6  idempotent-after-conflict: a pre-existing completed tx for today
 *        → ALREADY_CLAIMED (unique index still the last line of defense)
 *   DR7  premium multiplier path (entitlementConfig applied, amount intact)
 *   DR8  response contract: shape of the success response unchanged
 *
 * pg-mem limitations (documented):
 *   - pg_advisory_xact_lock is NOT supported → the harness stubs it as a
 *     no-op (see harness registerFunction). Tests lock RESULT semantics
 *     (one winner, correct state), not lock/blocking behavior. Real-PG
 *     concurrency verification requires a staging database.
 *   - Single-threaded: true interleaving is simulated deterministically via
 *     twin-seeding (same proven technique as D9/CR5 for C1).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const {
  makePgHarness,
  createWalletRepository,
  txCount,
  balanceOf,
  txRows,
} = require('./wallet-test-harness.cjs');

const ENV = {};

/** Build a repo on a fresh harness. */
function fresh() {
  const h = makePgHarness();
  const repo = createWalletRepository({
    queryDb: h.queryDb,
    queryDbTransaction: h.queryDbTransaction,
  });
  return { h, repo };
}

async function streakRow(h, userId) {
  const r = await h.raw(
    'SELECT streak_day, last_claim_date, cycle_count FROM daily_checkin_streaks WHERE user_id = $1',
    [String(userId)],
  );
  return r.rows[0] || null;
}

async function dailyTxCount(h) {
  return txCount(h, "WHERE tx_type = 'daily_claim'");
}

// Mirrors the production controller call exactly (wallet.js:248):
// claimDailyRewardWithStreak(env, userId, 0, { computeReward: true, isPremium, entitlementConfig })
const CLAIM = (repo, uid, options = {}) =>
  repo.claimDailyRewardWithStreak(ENV, uid, 0, { computeReward: true, isPremium: false, ...options });

async function assertAlreadyClaimed(promise) {
  await assert.rejects(promise, (e) => e.code === 'ALREADY_CLAIMED');
}

// ═══════════════════════════════════════════════════════════════════════════

test('DR1: normal first claim — streak row created, reward credited, response shape intact', async () => {
  const { h, repo } = fresh();
  const r = await CLAIM(repo, 'u_dr1');

  assert.equal(r.claimed, true);
  assert.equal(r.amount, 1);           // STREAK_REWARDS[0] — day 1
  assert.equal(r.streak_day, 1);
  assert.equal(r.cycle_complete, false);
  assert.equal(r.cycle_count, 0);
  assert.ok(r.txId > 0);
  assert.equal(await dailyTxCount(h), 1);
  assert.equal(await balanceOf(h, 'u_dr1'), 1);

  const s = await streakRow(h, 'u_dr1');
  assert.equal(s.streak_day, 1);
  assert.equal(s.cycle_count, 0);

  // tx row shape
  const rows = await txRows(h, "WHERE tx_type = 'daily_claim'");
  assert.equal(rows[0].amount, 1);
  assert.equal(rows[0].status, 'completed');
  assert.ok(/^daily_\d{4}-\d{2}-\d{2}$/.test(rows[0].ref_id));
});

test('DR2: failure between streak upsert and credit → rollback → retry WORKS (M1 killer)', async () => {
  // Simulate a Worker death / DB error after the streak UPSERT but before the
  // credit commit. Injected by wrapping queryDbTransaction: the FIRST
  // transaction (lock+check) passes, then we poison the CREDIT transaction
  // (identified by its balance_upsert CTE) to throw AFTER letting any
  // pre-credit statements run — with the fix, streak upsert runs INSIDE the
  // same poisoned transaction, so it must roll back with it.
  const base = makePgHarness();
  let poisoned = false;
  const wrappedTxn = async (env, queries) => {
    const sqls = queries.map(q => String(q.sql));
    const isCreditTxn = sqls.some(s => s.includes('balance_upsert'));
    if (isCreditTxn && !poisoned) {
      poisoned = true;
      throw new Error('SIMULATED_WORKER_DEATH_BEFORE_CREDIT');
    }
    return base.queryDbTransaction(env, queries);
  };
  const repo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: wrappedTxn,
  });

  // Claim attempt 1 — dies before the credit commits
  await assert.rejects(
    CLAIM(repo, 'u_dr2'),
    (e) => /SIMULATED_WORKER_DEATH_BEFORE_CREDIT/.test(String(e.message)),
  );

  // THE M1 ASSERTIONS (fail on pre-fix code):
  // (a) no partial state may survive — no tx, no balance change
  assert.equal(await dailyTxCount(base), 0, 'no daily_claim tx may exist after the failed claim');
  assert.equal(await balanceOf(base, 'u_dr2'), null, 'no balance change');
  // (b) the streak row must NOT be stuck on today (else retry → ALREADY_CLAIMED forever)
  const s = await streakRow(base, 'u_dr2');
  const tehranToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  assert.ok(!s || String(s.last_claim_date).slice(0, 10) !== tehranToday,
    'streak last_claim_date must roll back — a committed last_claim_date=today with no tx is the lost-reward window');

  // (c) retry with the SAME repo/lock must be able to claim successfully
  const retryRepo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: base.queryDbTransaction,
  });
  const r2 = await CLAIM(retryRepo, 'u_dr2');
  assert.equal(r2.claimed, true);
  assert.equal(r2.amount, 1);
  assert.equal(r2.streak_day, 1);
  assert.equal(await dailyTxCount(base), 1);
  assert.equal(await balanceOf(base, 'u_dr2'), 1);
});

test('DR2b: failure INSIDE the credit CTE (statement error) → full rollback, retry works', async () => {
  // Variant: the poisoned transaction is not the first call — poison the
  // second queryDbTransaction invocation regardless of content (belt & braces:
  // with the fix everything except the lock+check runs in ONE transaction,
  // so poisoning either the whole thing or the credit yields the same state).
  const base = makePgHarness();
  let calls = 0;
  const wrappedTxn = async (env, queries) => {
    calls++;
    if (calls === 2) throw new Error('SIMULATED_MID_CLAIM_FAILURE');
    return base.queryDbTransaction(env, queries);
  };
  const repo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: wrappedTxn,
  });

  await assert.rejects(CLAIM(repo, 'u_dr2b'), /SIMULATED_MID_CLAIM_FAILURE/);

  assert.equal(await dailyTxCount(base), 0);
  assert.equal(await balanceOf(base, 'u_dr2b'), null);
  const s = await streakRow(base, 'u_dr2b');
  assert.ok(!s, 'no partial streak row may survive a mid-claim failure');

  const retryRepo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: base.queryDbTransaction,
  });
  const r2 = await CLAIM(retryRepo, 'u_dr2b');
  assert.equal(r2.claimed, true);
  assert.equal(await dailyTxCount(base), 1);
});

test('DR3: duplicate sequential claim → ALREADY_CLAIMED, exactly one credit', async () => {
  const { h, repo } = fresh();
  const first = await CLAIM(repo, 'u_dr3');
  assert.equal(first.claimed, true);

  await assertAlreadyClaimed(CLAIM(repo, 'u_dr3'));

  assert.equal(await dailyTxCount(h), 1);
  assert.equal(await balanceOf(h, 'u_dr3'), 1);
});

test('DR4: concurrent claims (twin-seeding) → exactly ONE reward + correct streak', async () => {
  // Deterministic interleaving: request B's lock+check transaction commits a
  // completed twin tx + balance credit for the same refId right before A's
  // own transaction runs (A's earlier read saw nothing). Post-fix both A's
  // streak upsert AND A's credit run in A's single transaction — the credit
  // INSERT hits the unique index → the WHOLE transaction (streak upsert
  // included) rolls back → A must resolve ALREADY_CLAIMED rather than
  // leaving divergent state.
  const base = makePgHarness();
  let twinDone = false;
  const wrappedTxn = async (env, queries) => {
    const sqls = queries.map(q => String(q.sql));
    const isLockTxn = sqls.some(s => s.includes('pg_advisory_xact_lock'));
    if (isLockTxn && !twinDone) {
      // this is the FIRST transaction of request A (lock+check) — let it run
      // normally; the twin is committed at the START of A's SECOND
      // transaction (the combined one), i.e. after A's check passed.
      twinDone = true;
      return base.queryDbTransaction(env, queries);
    }
    if (!twinDone) {
      // request B (or subsequent) — run normally
      return base.queryDbTransaction(env, queries);
    }
    // A's second (post-check) transaction: commit the twin first.
    // A's check already saw nothing → simulate B winning the race NOW.
    const tehranToday = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
    }).format(new Date());
    await base.raw(
      `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata)
       VALUES ($1, 1, 'daily_claim', 'daily', 'completed', 'twin claim', $2, '{}')`,
      ['u_dr4', `daily_${tehranToday}`],
    );
    await base.raw('INSERT INTO token_balances (user_id, balance) VALUES ($1, 1)', ['u_dr4']);
    return base.queryDbTransaction(env, queries);
  };
  const repo = createWalletRepository({
    queryDb: base.queryDb,
    queryDbTransaction: wrappedTxn,
  });

  let r;
  let alreadyClaimed = false;
  try {
    r = await CLAIM(repo, 'u_dr4');
  } catch (e) {
    // Post-fix contract: the losing claim resolves ALREADY_CLAIMED (the
    // credit CTE's ON CONFLICT made the whole claim a no-op).
    if (e && e.code === 'ALREADY_CLAIMED') {
      alreadyClaimed = true;
    } else {
      throw e;
    }
  }

  // Either way (no-op resolution or ALREADY_CLAIMED), the loser must NOT
  // perform a SECOND real credit nor advance the streak past the winner.
  if (!alreadyClaimed) {
    const reportedSecondCredit = (r.claimed === true) && !(r.idempotent === true);
    assert.equal(reportedSecondCredit, false,
      'the losing concurrent claim must not report a fresh successful credit');
  }
  assert.equal(await dailyTxCount(base), 1, 'exactly ONE reward (the twin\'s)');
  assert.equal(await balanceOf(base, 'u_dr4'), 1, 'credited exactly once');

  // Streak state must reflect exactly one claim (day 1), not day 2.
  const s = await streakRow(base, 'u_dr4');
  assert.ok(s, 'streak row exists');
  assert.equal(Number(s.streak_day), 1, 'streak must be day 1 (single claim), not advanced by the loser');
});

test('DR5: streak progression and day boundaries', async () => {
  const { h, repo } = fresh();
  const tehranToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());
  const yesterday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - 24 * 60 * 60 * 1000));
  const twoDaysAgo = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date(Date.now() - 48 * 60 * 60 * 1000));

  // Seed: claimed yesterday with streak_day=3 → today must be day 4
  await h.raw(
    `INSERT INTO daily_checkin_streaks (user_id, streak_day, last_claim_date, cycle_count)
     VALUES ($1, 3, $2, 0)`,
    ['u_dr5a', yesterday],
  );
  const ra = await CLAIM(repo, 'u_dr5a');
  assert.equal(ra.streak_day, 4);
  assert.equal(ra.amount, 10); // STREAK_REWARDS[3]
  assert.equal(ra.cycle_complete, false);

  // Seed: last claim two days ago (streak broken) → day 1 restart
  await h.raw(
    `INSERT INTO daily_checkin_streaks (user_id, streak_day, last_claim_date, cycle_count)
     VALUES ($1, 5, $2, 0)`,
    ['u_dr5b', twoDaysAgo],
  );
  const rb = await CLAIM(repo, 'u_dr5b');
  assert.equal(rb.streak_day, 1);
  assert.equal(rb.amount, 1);

  // Seed: day 7 yesterday → today wraps to day 1 + cycle_count increments
  await h.raw(
    `INSERT INTO daily_checkin_streaks (user_id, streak_day, last_claim_date, cycle_count)
     VALUES ($1, 7, $2, 2)`,
    ['u_dr5c', yesterday],
  );
  const rc = await CLAIM(repo, 'u_dr5c');
  assert.equal(rc.streak_day, 1);
  assert.equal(rc.cycle_complete, true);
  assert.equal(rc.cycle_count, 3);
  assert.equal(rc.amount, 1);
  const s = await streakRow(h, 'u_dr5c');
  assert.equal(Number(s.cycle_count), 3);

  assert.equal(await dailyTxCount(h), 3);
  assert.equal(await balanceOf(h, 'u_dr5a'), 10);
  assert.equal(await balanceOf(h, 'u_dr5b'), 1);
  assert.equal(await balanceOf(h, 'u_dr5c'), 1);
});

test('DR6: pre-existing completed tx for today → ALREADY_CLAIMED (unique index last defense)', async () => {
  const { h, repo } = fresh();
  const tehranToday = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
  }).format(new Date());

  await h.raw(
    `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata)
     VALUES ($1, 1, 'daily_claim', 'daily', 'completed', 'pre-existing', $2, '{}')`,
    ['u_dr6', `daily_${tehranToday}`],
  );
  await h.raw('INSERT INTO token_balances (user_id, balance) VALUES ($1, 1)', ['u_dr6']);

  await assertAlreadyClaimed(CLAIM(repo, 'u_dr6'));
  assert.equal(await dailyTxCount(h), 1, 'no second tx');
  assert.equal(await balanceOf(h, 'u_dr6'), 1, 'no second credit');
});

test('DR7: premium multiplier applied via entitlementConfig — amount intact', async () => {
  const { h, repo } = fresh();
  const ec = { getMissionRewardAmount: (base, isPremium) => (isPremium ? Math.ceil(base * 1.5) : base) };

  const normal = await CLAIM(repo, 'u_dr7a', { entitlementConfig: ec });
  assert.equal(normal.amount, 1); // day 1 base, no multiplier

  const premium = await CLAIM(repo, 'u_dr7b', { isPremium: true, entitlementConfig: ec });
  assert.equal(premium.amount, 2); // ceil(1 * 1.5)
  assert.equal(await balanceOf(h, 'u_dr7b'), 2);
});

test('DR8: response contract — success shape unchanged for the controller', async () => {
  const { repo } = fresh();
  const r = await CLAIM(repo, 'u_dr8');

  // Controller spreads ...result into its JSON response — these exact keys
  // must keep existing with the same semantics.
  assert.equal(typeof r.claimed, 'boolean');
  assert.equal(typeof r.amount, 'number');
  assert.ok(r.newBalance === null || typeof r.newBalance === 'number');
  assert.ok(r.txId === null || r.txId > 0);
  assert.equal(typeof r.streak_day, 'number');
  assert.equal(typeof r.cycle_complete, 'boolean');
  assert.equal(typeof r.cycle_count, 'number');
});

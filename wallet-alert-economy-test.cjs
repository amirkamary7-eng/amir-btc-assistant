/**
 * ALERT ECONOMY TEST — AE-series (FIX M5)
 *
 * M5 defects being regression-locked (src/controllers/alerts.js handleCreate +
 * src/repositories/alert_economy.js):
 *
 *   A — Free-quota race: checkQuota (plain read) → create → incrementQuota
 *       (after) is not atomic. With freeRemaining=1, N concurrent requests
 *       ALL pass checkQuota as free → all create → all increment — each extra
 *       alert that should have been PAID escapes payment.
 *   B — Refund re-computes the amount: on create-failure the refund block
 *       calls checkQuota AGAIN and refunds whatever cost it returns NOW.
 *       Midnight crossing (debit 23:59 at cost=5, create fails 00:00 on a
 *       fresh quota day, re-check says cost=0) → refund SKIPPED → user loses
 *       the debited tokens. Config change between debit and refund → wrong
 *       refund amount. Free-at-billing + exhausted-at-refund → PHANTOM refund
 *       of tokens that were never debited.
 *   C — UTC quota date: quota_date uses new Date().toISOString() (UTC) while
 *       the rest of the reward system uses the Tehran date helper — quota
 *       resets at 03:30 Tehran instead of midnight.
 *
 * The REAL modules run: handleCreate extracted verbatim from
 * src/controllers/alerts.js, the real alert_economy repository (loadFactory),
 * the real alert repository, and the real economyService → walletRepo →
 * creditTokens/debitTokens on pg-mem.
 *
 * ── AE-series ──────────────────────────────────────────────────────────────
 *   AE1  concurrent free-quota race — exactly ONE free escape is impossible:
 *        with freeRemaining=1 and two racing creations, one must PAY
 *        (RED pre-fix: zero debits, both free)
 *   AE2  midnight refund — refund must equal the ACTUAL debited amount even
 *        when the quota day rolls between debit and refund
 *        (RED pre-fix: refund skipped, user loses 5 tokens)
 *   AE3  config-change refund — refund must equal the debit even if
 *        cost_per_extra changes between debit and refund
 *        (RED pre-fix: refunds the NEW cost 2 instead of the debited 5)
 *   AE4  quota date source — Tehran helper injected into the repo is honored
 *        (RED pre-fix: repo computes UTC internally, injected helper ignored)
 *   AE4b quota writes — increment lands on the Tehran date, not UTC
 *   AE5  phantom refund — a FREE creation that fails must NOT be refunded
 *        (RED pre-fix: re-check sees exhausted quota → refunds 5 never debited)
 *   AE6a free alert success — no debit, quota +1 (guard, green both phases)
 *   AE6b paid alert success — debit once, quota +1, no refund (guard)
 *   AE6c reactivation — no quota consumption, no debit (guard; exercises the
 *        claim-release path post-fix)
 *   AE6d insufficient balance — 402, zero side effects (guard)
 *   AE7  failed free creation releases the claimed slot — quota NOT consumed
 *        (guard; exercises release post-fix)
 *
 * pg-mem limitations (documented):
 *   - Single-threaded: the AE1 race is simulated deterministically by running
 *     request B's full handleCreate INSIDE request A's alertRepo.create call
 *     (twin-seeding — same proven technique as D9/CR5/DR4).
 *   - Clock-dependent seeding is avoided: AE1 seeds the quota row on BOTH the
 *     UTC date and the Tehran date (the repo uses one or the other depending
 *     on fix phase); assertions use MAX(used_count) across both rows.
 *   - Text→date coercion in INSERT..SELECT requires explicit ::date casts in
 *     the claim SQL (works identically on real PostgreSQL).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const {
  makeRealStack,
  loadFactory,
  balanceOf,
} = require('./wallet-test-harness.cjs');

const ALERTS_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/alerts.js'), 'utf8');
const createAlertRepository = loadFactory('src/repositories/alerts.js', 'createAlertRepository');
const createAlertEconomyRepository = loadFactory('src/repositories/alert_economy.js', 'createAlertEconomyRepository');

const norm = (v) => { if (v == null) return null; const s = String(v).trim(); return s.length ? s : null; };
const utcToday = () => new Date().toISOString().slice(0, 10);
const tehranToday = () => new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Tehran', year: 'numeric', month: '2-digit', day: '2-digit',
}).format(new Date());

// ── source extraction (same pattern as the NT suite) ───────────────────────
function extractFn(src, name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found`);
  let depth = 0, i = m.index;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) break; }
  }
  return src.slice(m.index, i + 1);
}
const HANDLE_CREATE_SRC = extractFn(ALERTS_CTRL_SRC, 'handleCreate');

/**
 * Build a full alert stack on a fresh pg-mem harness:
 *   - REAL economyService/walletRepo (shared harness)
 *   - REAL alertRepo + alertEconomyRepo (with injectable Tehran date helper)
 *   - driveCreate(payload, opts): runs the REAL handleCreate
 *     opts.alertEconomyRepo: override (wrapped) — for the refund/race fixtures
 *     opts.createImpl: override alertRepo.create behavior
 */
function makeAlertStack({ getTehranDateString } = {}) {
  const stack = makeRealStack();
  const h = stack.h;

  const alertRepo = createAlertRepository({
    queryDb: h.queryDb,
    ensureUserRow: async () => {},
    normalizeOptionalString: norm,
  });
  const ecoRepo = createAlertEconomyRepository({
    queryDb: h.queryDb,
    isDatabaseConfigured: () => true,
    isoDate: (v) => v,
    normalizeOptionalString: norm,
    getTehranDateString,
  });

  const jsonResponse = (body, init = {}, _env) => ({ __http: true, status: init.status || 200, body });
  const safeDbErrorResponse = (e) => ({ __http: true, status: 500, body: { status: 'error', message: 'Database error' } });
  const safeError = (_s, e) => e;
  const buildBodyFieldValidationError = (errs) => ({ __http: true, status: 422, body: { status: 'error', errors: errs } });
  const authenticateTelegramRequest = async () => ({ error: null, user: { id: '700001' }, startParam: null });
  const readJsonBody = async (req) => ({ error: null, payload: req.__payload });
  const membershipAuthority = { isPremium: async () => false };

  function buildController({ alertRepo: repoOverride, ecoRepo: ecoOverride } = {}) {
    const wrapped = `${HANDLE_CREATE_SRC}\nmodule.exports = { handleCreate };`;
    const mod = { exports: {} };
    const evaluator = new Function('module', 'exports',
      'jsonResponse', 'authenticateTelegramRequest', 'readJsonBody', 'safeDbErrorResponse',
      'safeError', 'buildBodyFieldValidationError', 'isDatabaseConfigured',
      'alertRepo', 'alertEconomyRepo', 'economyService', 'membershipAuthority',
      wrapped);
    evaluator(mod, mod.exports,
      jsonResponse, authenticateTelegramRequest, readJsonBody, safeDbErrorResponse,
      safeError, buildBodyFieldValidationError, () => true,
      repoOverride || alertRepo, ecoOverride || ecoRepo,
      stack.economyService, membershipAuthority);
    return mod.exports.handleCreate;
  }

  const handleCreate = buildController();

  async function driveCreate(payload, opts = {}) {
    const fn = opts.controller || handleCreate;
    const req = {
      url: 'https://x/api/alerts',
      __payload: payload,
      headers: { get: () => null },
    };
    return fn(req, {});
  }

  return { h, stack, alertRepo, ecoRepo, handleCreate, buildController, driveCreate };
}

// ── assertion helpers ──────────────────────────────────────────────────────
async function txCount(h, where) {
  const r = await h.raw(`SELECT COUNT(*)::int AS c FROM token_transactions ${where}`);
  return Number(r.rows[0].c);
}
async function txSums(h, where) {
  const r = await h.raw(`SELECT COALESCE(SUM(amount),0)::int AS s FROM token_transactions ${where}`);
  return Number(r.rows[0].s);
}
async function maxUsed(h, userId) {
  const r = await h.raw(`SELECT COALESCE(MAX(used_count), 0)::int AS m FROM alert_quota WHERE user_id = $1`, [userId]);
  return Number(r.rows[0].m);
}

const BTC = { symbol: 'BTC', price: 50000, direction: 'above' };
const ETH = { symbol: 'ETH', price: 3000, direction: 'below' };

/** Wrap the real eco repo: sequential checkQuota results + claim override. */
function wrapEcoRepo(realRepo, { checkQuotaSeq, claim, passthrough } = {}) {
  let call = 0;
  const out = {
    ...realRepo,
    checkQuota: async (...args) => {
      if (checkQuotaSeq && checkQuotaSeq.length) {
        const idx = Math.min(call, checkQuotaSeq.length - 1);
        call++;
        const r = checkQuotaSeq[idx];
        return typeof r === 'function' ? r(...args) : r;
      }
      return realRepo.checkQuota(...args);
    },
  };
  if (claim) {
    out.claimFreeSlot = async () => claim;
  } else if (passthrough === false) {
    // no claimFreeSlot at all (pre-fix repo shape)
    delete out.claimFreeSlot;
  }
  return out;
}

// ═══════════════════════════════════════════════════════════════════════════
// AE1 — free-quota race (twin-seeded concurrency)
// ═══════════════════════════════════════════════════════════════════════════

test('AE1: with freeRemaining=1, two racing creations — exactly one stays free, the other PAYS', async () => {
  const t = makeAlertStack();
  await t.stack.h.insertBalance('700001', 100);
  await t.ecoRepo.ensureSchema({});

  // Seed used=2 (free=3 → one free slot left) via the REAL incrementQuota —
  // writes the row with the repo's own date source and typed ::date cast
  // (a raw text-literal seed breaks pg-mem's ON CONFLICT conflict detection).
  await t.ecoRepo.incrementQuota({}, '700001', 'price_alert');
  await t.ecoRepo.incrementQuota({}, '700001', 'price_alert');

  // Twin-seeding: request B (full real handleCreate, ETH) runs INSIDE request
  // A's alertRepo.create — the deterministic interleaving of the race.
  let twinDone = false;
  const realCreate = t.alertRepo.create.bind(t.alertRepo);
  const racingRepo = {
    ...t.alertRepo,
    create: async (...args) => {
      if (!twinDone) {
        twinDone = true;
        await t.driveCreate(ETH); // ← B races in between A's check and A's create
      }
      return realCreate(...args);
    },
  };
  const racingController = t.buildController({ alertRepo: racingRepo });
  const res = await t.driveCreate(BTC, { controller: racingController });
  assert.equal(res.status, 200, 'A succeeds');
  assert.equal(res.body.status, 'success');

  // THE RACE ASSERTIONS:
  // Exactly ONE debit of 5 must exist (the loser of the free-slot race pays).
  const debits = await txCount(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'");
  assert.equal(debits, 1, 'exactly one paid alert — the other consumed the last free slot (pre-fix: 0 debits = race)');
  const debitSum = await txSums(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'");
  assert.equal(debitSum, -5);

  // Quota: both creations counted on the active row (2 → 4).
  assert.equal(await maxUsed(t.h, '700001'), 4, 'both creations counted (used 2 → 4)');

  // No refunds — both creations succeeded.
  assert.equal(await txCount(t.h, "WHERE tx_type = 'marketplace_refund'"), 0);

  // Both alerts exist.
  const alerts = await t.h.raw(`SELECT COUNT(*)::int AS c FROM price_alerts WHERE user_id = $1`, ['700001']);
  assert.equal(Number(alerts.rows[0].c), 2);
});

// ═══════════════════════════════════════════════════════════════════════════
// AE2 — midnight refund (exact-amount refund)
// ═══════════════════════════════════════════════════════════════════════════

test('AE2: midnight crossing — create fails on a fresh quota day → refund EXACTLY the debited 5', async () => {
  const t = makeAlertStack();
  await t.stack.h.insertBalance('700001', 100);

  const eco = wrapEcoRepo(t.ecoRepo, {
    checkQuotaSeq: [
      // billing decision (23:59, quota exhausted): PAID, cost 5
      { allowed: true, isFree: false, costInTokens: 5, usedToday: 3, freeRemaining: 0, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } },
      // refund-time re-check (00:00+ on a fresh day): FREE, cost 0
      { allowed: true, isFree: true, costInTokens: 0, usedToday: 0, freeRemaining: 3, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } },
    ],
    claim: { claimed: false, usedNow: 3 },
  });
  const throwingRepo = { ...t.alertRepo, create: async () => { throw new Error('SIMULATED_CREATE_FAILURE'); } };
  const ctrl = t.buildController({ alertRepo: throwingRepo, ecoRepo: eco });

  const res = await t.driveCreate(BTC, { controller: ctrl });
  assert.equal(res.status, 500, 'creation fails (db error path)');

  // The debit happened (before midnight): exactly -5.
  assert.equal(await txCount(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'"), 1);
  assert.equal(await txSums(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'"), -5);

  // THE MIDNIGHT ASSERTION (RED pre-fix — the re-check said cost=0, refund skipped):
  const refunds = await txCount(t.h, "WHERE tx_type = 'marketplace_refund' AND status = 'completed'");
  assert.equal(refunds, 1, 'refund MUST be issued for the debited tokens');
  const refundSum = await txSums(t.h, "WHERE tx_type = 'marketplace_refund' AND status = 'completed'");
  assert.equal(refundSum, 5, 'refund must be EXACTLY the debited amount (5) — not the re-computed 0');

  // Net zero for the user.
  assert.equal(await balanceOf(t.h, '700001'), 100);
});

// ═══════════════════════════════════════════════════════════════════════════
// AE3 — config-change refund
// ═══════════════════════════════════════════════════════════════════════════

test('AE3: cost config changes between debit and refund → refund the DEBITED 5, not the new cost 2', async () => {
  const t = makeAlertStack();
  await t.stack.h.insertBalance('700001', 100);

  const eco = wrapEcoRepo(t.ecoRepo, {
    checkQuotaSeq: [
      { allowed: true, isFree: false, costInTokens: 5, usedToday: 3, freeRemaining: 0, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } },
      // admin changed cost_per_extra 5 → 2 before the refund re-check
      { allowed: true, isFree: false, costInTokens: 2, usedToday: 3, freeRemaining: 0, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 2 } },
    ],
    claim: { claimed: false, usedNow: 3 },
  });
  const throwingRepo = { ...t.alertRepo, create: async () => { throw new Error('SIMULATED_CREATE_FAILURE'); } };
  const ctrl = t.buildController({ alertRepo: throwingRepo, ecoRepo: eco });

  const res = await t.driveCreate(BTC, { controller: ctrl });
  assert.equal(res.status, 500);

  assert.equal(await txSums(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'"), -5);
  // RED pre-fix: refunds the re-computed 2. Correct: refund the debited 5.
  const refundSum = await txSums(t.h, "WHERE tx_type = 'marketplace_refund' AND status = 'completed'");
  assert.equal(refundSum, 5, 'refund must equal the ACTUAL debit (5), not the new config cost (2)');
});

// ═══════════════════════════════════════════════════════════════════════════
// AE4 / AE4b — quota date source (Tehran helper honored)
// ═══════════════════════════════════════════════════════════════════════════

test('AE4: quota lookup honors the injected Tehran date helper (not UTC)', async () => {
  const t = makeAlertStack({ getTehranDateString: () => '2026-01-01' });
  // Let the real repo create its schema first.
  await t.ecoRepo.ensureSchema({});
  // Seed an EXHAUSTED quota on the Tehran date 2026-01-01.
  await t.h.raw(
    `INSERT INTO alert_quota (user_id, alert_type, used_count, quota_date) VALUES ($1, 'price_alert', 3, '2026-01-01')`,
    ['700001'],
  );

  const q = await t.ecoRepo.checkQuota({}, '700001', 'price_alert', false);
  // RED pre-fix: the repo computes the UTC date internally, finds no row for
  // it, and reports a fresh free quota.
  assert.equal(q.usedToday, 3, 'quota must be read for the Tehran date (2026-01-01)');
  assert.equal(q.costInTokens, 5, 'quota exhausted on the Tehran date → paid alert');
  assert.equal(q.isFree, false);
});

test('AE4b: quota writes land on the Tehran date (not UTC)', async () => {
  const t = makeAlertStack({ getTehranDateString: () => '2026-01-01' });
  await t.ecoRepo.ensureSchema({});

  await t.ecoRepo.incrementQuota({}, '700002', 'price_alert');

  const onTehran = await t.h.raw(
    `SELECT used_count FROM alert_quota WHERE user_id = $1 AND quota_date = '2026-01-01'`, ['700002']);
  assert.equal(onTehran.rows.length, 1, 'the quota row must be written for the Tehran date');
  assert.equal(Number(onTehran.rows[0].used_count), 1);

  const onUtc = await t.h.raw(
    `SELECT COUNT(*)::int AS c FROM alert_quota WHERE user_id = $1 AND quota_date = $2`, ['700002', utcToday()]);
  assert.equal(Number(onUtc.rows[0].c), 0, 'no quota row on the UTC date');
});

// ═══════════════════════════════════════════════════════════════════════════
// AE5 — phantom refund (free at billing, exhausted at refund re-check)
// ═══════════════════════════════════════════════════════════════════════════

test('AE5: FREE creation that fails must NOT be refunded (no phantom tokens)', async () => {
  // NOTE (pre-fix behavior): this test PASSES on the unfixed code too — but
  // only because the pre-fix refund path is DEAD CODE: the catch block
  // references `isPremium`, which is block-scoped to the billing `if` above,
  // so the refund attempt throws ReferenceError (swallowed by its try/catch)
  // BEFORE any phantom refund could be granted (documented as finding M5-B2).
  // Post-fix this test guards the real invariant: refund iff debitAmount > 0.
  const t = makeAlertStack();

  const eco = wrapEcoRepo(t.ecoRepo, {
    checkQuotaSeq: [
      // billing: FREE (quota has remaining)
      { allowed: true, isFree: true, costInTokens: 0, usedToday: 1, freeRemaining: 2, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } },
      // refund-time re-check (another request exhausted the quota meanwhile):
      { allowed: true, isFree: false, costInTokens: 5, usedToday: 3, freeRemaining: 0, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } },
    ],
    claim: { claimed: true, usedNow: 2 },
  });
  const throwingRepo = { ...t.alertRepo, create: async () => { throw new Error('SIMULATED_CREATE_FAILURE'); } };
  const ctrl = t.buildController({ alertRepo: throwingRepo, ecoRepo: eco });

  const res = await t.driveCreate(BTC, { controller: ctrl });
  assert.equal(res.status, 500);

  // No debit happened → NOTHING may be refunded.
  assert.equal(await txCount(t.h, "WHERE tx_type = 'alert_debit'"), 0, 'free creation → no debit');
  // RED pre-fix: the re-check saw cost=5 → granted a phantom 5-token refund.
  assert.equal(await txCount(t.h, "WHERE tx_type = 'marketplace_refund'"), 0,
    'a failed FREE creation must NOT trigger any refund');
});

// ═══════════════════════════════════════════════════════════════════════════
// AE6 — guards (current correct behavior preserved)
// ═══════════════════════════════════════════════════════════════════════════

test('AE6a: free alert success — no debit, quota consumed once', async () => {
  const t = makeAlertStack();
  const res = await t.driveCreate(BTC);
  assert.equal(res.status, 200);
  assert.equal(res.body.status, 'success');
  assert.equal(res.body.alert.reactivated, false);
  assert.equal(await txCount(t.h, "WHERE tx_type = 'alert_debit'"), 0);
  assert.equal(await txCount(t.h, "WHERE tx_type = 'marketplace_refund'"), 0);
  assert.equal(await maxUsed(t.h, '700001'), 1, 'quota used 0 → 1');
});

test('AE6b: paid alert success — debit once, quota counted, no refund', async () => {
  const t = makeAlertStack();
  await t.stack.h.insertBalance('700001', 100);

  const eco = wrapEcoRepo(t.ecoRepo, {
    checkQuotaSeq: [{ allowed: true, isFree: false, costInTokens: 5, usedToday: 3, freeRemaining: 0, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } }],
    claim: { claimed: false, usedNow: 3 },
  });
  const ctrl = t.buildController({ ecoRepo: eco });
  const res = await t.driveCreate(BTC, { controller: ctrl });
  assert.equal(res.status, 200);
  assert.equal(await txCount(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'"), 1);
  assert.equal(await txSums(t.h, "WHERE tx_type = 'alert_debit' AND status = 'completed'"), -5);
  assert.equal(await txCount(t.h, "WHERE tx_type = 'marketplace_refund'"), 0);
  assert.equal(await maxUsed(t.h, '700001'), 1, 'paid creation still counted in quota');
});

test('AE6c: reactivating an existing alert consumes NO quota and debits nothing', async () => {
  const t = makeAlertStack();
  const first = await t.driveCreate(BTC);
  assert.equal(first.status, 200);

  const second = await t.driveCreate(BTC); // identical → reactivation
  assert.equal(second.status, 200);
  assert.equal(second.body.alert.reactivated, true);

  assert.equal(await maxUsed(t.h, '700001'), 1, 'reactivation must not consume quota (stays at 1)');
  assert.equal(await txCount(t.h, "WHERE tx_type = 'alert_debit'"), 0);
  const alerts = await t.h.raw(`SELECT COUNT(*)::int AS c FROM price_alerts WHERE user_id = $1`, ['700001']);
  assert.equal(Number(alerts.rows[0].c), 1, 'still a single alert row');
});

test('AE6d: insufficient balance — 402, zero side effects', async () => {
  const t = makeAlertStack();
  await t.ecoRepo.ensureSchema({}); // wrapped eco never creates the schema itself
  // NO balance row → debit fails.

  const eco = wrapEcoRepo(t.ecoRepo, {
    checkQuotaSeq: [{ allowed: true, isFree: false, costInTokens: 5, usedToday: 3, freeRemaining: 0, effectiveFreePerDay: 3, config: { alert_type: 'price_alert', is_enabled: true, free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 } }],
    claim: { claimed: false, usedNow: 3 },
  });
  const ctrl = t.buildController({ ecoRepo: eco });
  const res = await t.driveCreate(BTC, { controller: ctrl });
  assert.equal(res.status, 402);
  assert.equal(res.body.code, 'PAYMENT_FAILED');
  assert.equal(await txCount(t.h, ''), 0, 'no transactions at all');
  assert.equal(await maxUsed(t.h, '700001'), 0, 'quota untouched');
});

test('AE7: failed FREE creation releases the claimed slot — quota NOT consumed', async () => {
  const t = makeAlertStack();
  const throwingRepo = { ...t.alertRepo, create: async () => { throw new Error('SIMULATED_CREATE_FAILURE'); } };
  const ctrl = t.buildController({ alertRepo: throwingRepo });

  const res = await t.driveCreate(BTC, { controller: ctrl });
  assert.equal(res.status, 500);

  // A failed creation must not consume the free quota.
  const rows = await t.h.raw(`SELECT COUNT(*)::int AS c FROM alert_quota WHERE user_id = $1 AND used_count > 0`, ['700001']);
  assert.equal(Number(rows.rows[0].c), 0, 'no consumed quota after failed creation');
  assert.equal(await txCount(t.h, ''), 0, 'no transactions (no debit → no refund)');
});

/**
 * H5-CRITICAL Fix — Retry Batch Size Regression Test
 *
 * Background:
 *   The H5 audit identified that the 1-min cron at minute===0 runs 4 retry
 *   jobs in separate `ctx.waitUntil` calls. Each retry job had `LIMIT 20`.
 *   In worst case (each retry finds 20 items × ~5 DB queries per item),
 *   the combined invocation could consume 4 × 101 = ~404 subrequests —
 *   MASSIVELY exceeding the Cloudflare Workers Free Plan 50-subrequest
 *   limit per invocation (subrequests accumulate across the entire
 *   invocation including all ctx.waitUntil promises).
 *
 * Fix (H5-CRITICAL):
 *   Reduced `LIMIT 20` → `LIMIT 3` in all 4 retry queries:
 *     1. retryFailedReferralRewards  (worker-proxy.js:~3351)
 *     2. retryFailedWheelRewards      (worker-proxy.js:~3406)
 *     3. retryFailedMissionRewards   (worker-proxy.js:~3521)
 *     4. retryFailedRefunds          (worker-proxy.js:~3622)
 *
 * This test asserts:
 *   1. Each of the 4 retry QUERIES has `LIMIT 3` (verified via the SQL
 *      template closing pattern `LIMIT 3\`,`, which is unique to SQL
 *      query strings — comments mentioning "LIMIT 20" don't have this
 *      pattern).
 *   2. None of the 4 retry function bodies contain the SQL template
 *      closing pattern `LIMIT 20\`,` anymore (comments are allowed).
 *   3. Function names and overall logic are unchanged (still bounded by
 *      ORDER BY ... ASC, still iterate the result rows, still per-row
 *      try/catch for batch isolation).
 *   4. Unrelated `LIMIT 20` occurrences elsewhere in worker-proxy.js
 *      (getNewsAIMonitoring rolling window, admin diagnostic endpoints)
 *      are UNCHANGED — only the 4 retry queries were modified.
 *   5. Retry idempotency is preserved (UNIQUE constraint references still
 *      present; per-row try/catch still present; only batch size changed).
 *
 * Scope:
 *   Source-inspection test (no runtime execution). Mirrors the pattern
 *   of `mission-reward-retry-test.cjs` and `cron-architecture-test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a function body from worker-proxy.js source by function name.
 * Returns the substring from `async function <name>` to the next
 * `async function ` (or end-of-file if last function).
 */
function extractFunctionBody(fnName) {
  const startMarker = `async function ${fnName}`;
  const startIdx = WORKER_SRC.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Function ${fnName} must exist in worker-proxy.js`);

  const nextAsyncIdx = WORKER_SRC.indexOf('async function ', startIdx + startMarker.length);
  const endIdx = nextAsyncIdx === -1 ? WORKER_SRC.length : nextAsyncIdx;

  return WORKER_SRC.slice(startIdx, endIdx);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — All 4 retry QUERIES have `LIMIT 3` (verified via SQL template
// closing pattern `LIMIT 3\`,` — unique to SQL strings, NOT to comments)
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-01: retryFailedReferralRewards SQL query closes with `LIMIT 3`, (was `LIMIT 20`,)', () => {
  const body = extractFunctionBody('retryFailedReferralRewards');
  assert.ok(body.includes('LIMIT 3`,'),
    'retryFailedReferralRewards SQL query must close with `LIMIT 3`, (H5-CRITICAL fix)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedReferralRewards SQL query must NOT close with `LIMIT 20`, anymore');
});

test('H5-CRIT-02: retryFailedWheelRewards SQL query closes with `LIMIT 3`, (was `LIMIT 20`,)', () => {
  const body = extractFunctionBody('retryFailedWheelRewards');
  assert.ok(body.includes('LIMIT 3`,'),
    'retryFailedWheelRewards SQL query must close with `LIMIT 3`, (H5-CRITICAL fix)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedWheelRewards SQL query must NOT close with `LIMIT 20`, anymore');
});

test('H5-CRIT-03: retryFailedMissionRewards SQL query closes with `LIMIT 3`, (was `LIMIT 20`,)', () => {
  const body = extractFunctionBody('retryFailedMissionRewards');
  assert.ok(body.includes('LIMIT 3`,'),
    'retryFailedMissionRewards SQL query must close with `LIMIT 3`, (H5-CRITICAL fix)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedMissionRewards SQL query must NOT close with `LIMIT 20`, anymore');
});

test('H5-CRIT-04: retryFailedRefunds SQL query closes with `LIMIT 3`, (was `LIMIT 20`,)', () => {
  const body = extractFunctionBody('retryFailedRefunds');
  assert.ok(body.includes('LIMIT 3`,'),
    'retryFailedRefunds SQL query must close with `LIMIT 3`, (H5-CRITICAL fix)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedRefunds SQL query must NOT close with `LIMIT 20`, anymore');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — Function names + structure preserved
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-05: all 4 retry function names are unchanged', () => {
  assert.ok(WORKER_SRC.includes('async function retryFailedReferralRewards'),
    'retryFailedReferralRewards function name preserved');
  assert.ok(WORKER_SRC.includes('async function retryFailedWheelRewards'),
    'retryFailedWheelRewards function name preserved');
  assert.ok(WORKER_SRC.includes('async function retryFailedMissionRewards'),
    'retryFailedMissionRewards function name preserved');
  assert.ok(WORKER_SRC.includes('async function retryFailedRefunds'),
    'retryFailedRefunds function name preserved');
});

test('H5-CRIT-06: retry queries preserve ORDER BY ... ASC (oldest-first unchanged)', () => {
  // Idempotency + determinism require ORDER BY ... ASC so oldest items
  // are retried first. The H5-CRITICAL fix only reduced the LIMIT —
  // ORDER BY direction must remain ASC for all 4 retry queries.
  const referralBody = extractFunctionBody('retryFailedReferralRewards');
  assert.ok(referralBody.includes('ORDER BY invitee_id ASC'),
    'retryFailedReferralRewards must preserve ORDER BY invitee_id ASC');

  const wheelBody = extractFunctionBody('retryFailedWheelRewards');
  assert.ok(wheelBody.includes('ORDER BY wh.created_at ASC'),
    'retryFailedWheelRewards must preserve ORDER BY wh.created_at ASC');

  const missionBody = extractFunctionBody('retryFailedMissionRewards');
  assert.ok(missionBody.includes('ORDER BY mp.daily_date ASC, mp.user_id ASC'),
    'retryFailedMissionRewards must preserve ORDER BY mp.daily_date ASC, mp.user_id ASC');

  const refundsBody = extractFunctionBody('retryFailedRefunds');
  assert.ok(refundsBody.includes('ORDER BY created_at ASC'),
    'retryFailedRefunds must preserve ORDER BY created_at ASC');
});

test('H5-CRIT-07: retry functions preserve per-row try/catch (batch isolation)', () => {
  // H5-CRITICAL fix only reduced batch size — the per-row error isolation
  // pattern (individual try/catch so one failure doesn't abort the batch)
  // must remain intact.
  for (const fnName of [
    'retryFailedReferralRewards',
    'retryFailedWheelRewards',
    'retryFailedMissionRewards',
    'retryFailedRefunds',
  ]) {
    const body = extractFunctionBody(fnName);
    assert.ok(body.includes('catch (e)'),
      `${fnName} must preserve per-row try/catch for batch isolation`);
    assert.ok(body.includes('for (const row of result.rows'),
      `${fnName} must preserve the for-loop iteration pattern`);
  }
});

test('H5-CRIT-08: retry functions preserve isDatabaseConfigured guard', () => {
  // All 4 retry functions must early-return if DB is not configured.
  // H5-CRITICAL fix must not have touched this guard.
  for (const fnName of [
    'retryFailedReferralRewards',
    'retryFailedWheelRewards',
    'retryFailedMissionRewards',
    'retryFailedRefunds',
  ]) {
    const body = extractFunctionBody(fnName);
    assert.ok(body.includes('isDatabaseConfigured(env)'),
      `${fnName} must preserve isDatabaseConfigured(env) guard`);
    assert.ok(body.includes('if (result.rows.length === 0) return'),
      `${fnName} must preserve early-return on empty result`);
  }
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 3 — Idempotency preserved (only batch size changed)
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-09: retryFailedReferralRewards preserves processPendingReferralReward call (idempotency via creditTokens UNIQUE constraint)', () => {
  // The idempotency of referral retries comes from processPendingReferralReward
  // → creditReferralWithReward → creditTokens' UNIQUE constraint on ref_id.
  // H5-CRITICAL fix only reduced LIMIT — must not have touched the call.
  const body = extractFunctionBody('retryFailedReferralRewards');
  assert.ok(body.includes('await processPendingReferralReward(env,'),
    'retryFailedReferralRewards must still call processPendingReferralReward');
});

test('H5-CRIT-10: retryFailedWheelRewards preserves economyService.grantReward call + refId pattern (idempotency via UNIQUE constraint on ref_id)', () => {
  // The idempotency of wheel retries comes from economyService.grantReward
  // → creditTokens' UNIQUE constraint on (user_id, tx_type, ref_id).
  // H5-CRITICAL fix only reduced LIMIT — must not have touched the call.
  const body = extractFunctionBody('retryFailedWheelRewards');
  assert.ok(body.includes('economyService.grantReward'),
    'retryFailedWheelRewards must still call economyService.grantReward');
  // refId pattern is the idempotency key — must be preserved exactly
  assert.ok(body.includes('wheel_${row.user_id}_${row.spin_date_str}_${row.spin_id}'),
    'retryFailedWheelRewards must preserve refId pattern (idempotency key)');
});

test('H5-CRIT-11: retryFailedMissionRewards preserves economyService.grantReward call + mission refId pattern', () => {
  // The idempotency of mission retries comes from economyService.grantReward
  // → creditTokens' UNIQUE constraint on (user_id, tx_type, ref_id), where
  // refId = `mission_${user_id}_${mission_id}_${date_str}`.
  // H5-CRITICAL fix only reduced LIMIT — must not have touched the call.
  const body = extractFunctionBody('retryFailedMissionRewards');
  assert.ok(body.includes('economyService.grantReward'),
    'retryFailedMissionRewards must still call economyService.grantReward');
  assert.ok(body.includes('mission_${row.user_id}_${row.mission_id}_${row.date_str}'),
    'retryFailedMissionRewards must preserve mission refId pattern (idempotency key)');
});

test('H5-CRIT-12: retryFailedRefunds preserves grantReward + status UPDATE pattern (idempotency via refund_ref_id UNIQUE)', () => {
  // The idempotency of refund retries comes from economyService.grantReward
  // → creditTokens' UNIQUE constraint on ref_id (refund_ref_id).
  // H5-CRITICAL fix only reduced LIMIT — must not have touched the grantReward
  // call or the status UPDATE pattern.
  const body = extractFunctionBody('retryFailedRefunds');
  assert.ok(body.includes('economyService.grantReward'),
    'retryFailedRefunds must still call economyService.grantReward');
  assert.ok(body.includes('marketplace_refund'),
    'retryFailedRefunds must preserve rewardType=marketplace_refund');
  // Success path: mark as completed
  assert.ok(body.includes("status = 'completed'"),
    'retryFailedRefunds must preserve UPDATE status=completed on success');
  // Failure path: increment retry_count
  assert.ok(body.includes('retry_count = retry_count + 1'),
    'retryFailedRefunds must preserve retry_count increment on failure');
  // Exhaustion path: mark as exhausted after 10 retries
  assert.ok(body.includes("status = 'exhausted'"),
    'retryFailedRefunds must preserve status=exhausted after 10 retries');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 4 — Unrelated LIMIT 20 occurrences UNCHANGED
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-13: getNewsAIMonitoring still uses LIMIT 20 (unrelated — rolling 20-entry window for /api/news-ai-monitor)', () => {
  // This LIMIT 20 is the rolling-window size for the news AI monitoring
  // endpoint (SELECT ... FROM news_ai_tick_log ORDER BY created_at DESC
  // LIMIT 20). It has NOTHING to do with retry batch sizes. The H5-CRITICAL
  // fix must NOT have touched it.
  // (Also asserted in telemetry-db-migration-test.cjs MON-01.)
  //
  // Find the getNewsAIMonitoring function and verify its body still has
  // `LIMIT 20` (inside the SQL template, so this is the SQL LIMIT — not
  // a comment).
  const fnStart = WORKER_SRC.indexOf('async function getNewsAIMonitoring');
  assert.notEqual(fnStart, -1, 'getNewsAIMonitoring function must exist');

  // Find the next `async function ` to bound the search (function end).
  const nextFnIdx = WORKER_SRC.indexOf('async function ', fnStart + 10);
  const fnBody = WORKER_SRC.slice(fnStart, nextFnIdx === -1 ? WORKER_SRC.length : nextFnIdx);

  assert.ok(fnBody.includes('FROM news_ai_tick_log'),
    'getNewsAIMonitoring must still SELECT FROM news_ai_tick_log');
  assert.ok(fnBody.includes('LIMIT 20'),
    'getNewsAIMonitoring must still use LIMIT 20 (rolling 20-entry window — UNRELATED to retry batch size)');
});

test('H5-CRIT-14: admin /api/start-diag activeAlerts query still uses LIMIT 20 (unrelated — admin diagnostic endpoint)', () => {
  // This LIMIT 20 is the admin diagnostic endpoint that lists active price
  // alerts for the start-diag report. It has NOTHING to do with retry batch
  // sizes. The H5-CRITICAL fix must NOT have touched it.
  // Pattern: SELECT id, user_id, symbol, ... FROM price_alerts WHERE status = 'active'
  //          ORDER BY created_at DESC LIMIT 20
  const diagIdx = WORKER_SRC.indexOf("FROM price_alerts WHERE status = 'active' ORDER BY created_at DESC LIMIT 20");
  assert.notEqual(diagIdx, -1,
    'admin start-diag activeAlerts query must still use LIMIT 20 (UNRELATED to retry batch size)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 5 — Sanity: 4 retry functions still wired into cron (no changes to call sites)
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-15: all 4 retry functions are still called from the 1-min cron (minute===0 hourly branch)', () => {
  // H5-CRITICAL fix only changed LIMIT inside the retry queries. The call
  // sites in scheduled() must remain unchanged (still 4 ctx.waitUntil calls,
  // still gated by _hourlyMinute === 0).
  assert.ok(WORKER_SRC.includes('_hourlyMinute === 0'),
    '1-min cron must still gate hourly retries by _hourlyMinute === 0');

  // Verify all 4 retry calls are still inside ctx.waitUntil blocks
  for (const fnCall of [
    'await retryFailedReferralRewards(env)',
    'await retryFailedWheelRewards(env)',
    'await retryFailedMissionRewards(env)',
    'await retryFailedRefunds(env)',
  ]) {
    assert.ok(WORKER_SRC.includes(fnCall),
      `${fnCall} must still be called from the 1-min cron hourly branch`);
  }
});

test('H5-CRIT-16: exactly 4 `LIMIT 3\`,` occurrences in worker-proxy.js (one per retry query, no extras)', () => {
  // The H5-CRITICAL fix added exactly 4 `LIMIT 3\`,` occurrences (one per
  // retry query). This count must be exactly 4 — not less (regression) and
  // not more (accidental scope creep).
  //
  // Note: processQueue uses `LIMIT ${batchLimit}` (dynamic) and cron comments
  // mention "LIMIT 3" in processQueue CPU budget discussions, but those are
  // NOT `LIMIT 3\`,` patterns (they're either dynamic interpolation or
  // comment text). So the exact match `LIMIT 3\`,` is the precise signature
  // of the 4 retry queries.
  const matches = (WORKER_SRC.match(/LIMIT 3`,/g) || []).length;
  assert.equal(matches, 4,
    `must have exactly 4 \`LIMIT 3\`,\` occurrences (one per retry query) — found ${matches}`);
});

test('H5-CRIT-17: retryFailed* jobs are NOT inside the isEvery15Min block (architecture preserved)', () => {
  // Regression guard from cron-architecture-test.cjs (T7-T9) — the H5-CRITICAL
  // fix must NOT have moved retry jobs into the */15 branch.
  const idx15 = WORKER_SRC.indexOf('if (isEvery15Min) {');
  assert.notEqual(idx15, -1, 'isEvery15Min block must exist');
  // Find the next major block boundary after the isEvery15Min block
  // (the catch at the end of the withPhasePool block)
  const catchIdx = WORKER_SRC.indexOf('}).catch((e) => {', idx15);
  const block = WORKER_SRC.slice(idx15, catchIdx === -1 ? idx15 + 5000 : catchIdx);

  assert.ok(!block.includes('await retryFailedReferralRewards'),
    'retryFailedReferralRewards must NOT be in the isEvery15Min block (architecture preserved)');
  assert.ok(!block.includes('await retryFailedWheelRewards'),
    'retryFailedWheelRewards must NOT be in the isEvery15Min block (architecture preserved)');
  assert.ok(!block.includes('await retryFailedMissionRewards'),
    'retryFailedMissionRewards must NOT be in the isEvery15Min block (architecture preserved)');
  assert.ok(!block.includes('await retryFailedRefunds'),
    'retryFailedRefunds must NOT be in the isEvery15Min block (architecture preserved)');
});

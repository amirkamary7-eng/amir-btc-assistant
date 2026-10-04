/**
 * H5-CRITICAL + H5 Layer 2+3 Fix — Retry Batch Size + enqueueOnly Regression Test
 *
 * Background:
 *   The H5 audit identified that the 1-min cron at minute===0 runs 4 retry
 *   jobs (referral/wheel/mission/refund). ARCH-BATCH2 moved the gate from
 *   minute 0 to minute 1 to isolate retries from the triple-cron overlap.
 *   jobs in separate `ctx.waitUntil` calls. Each retry job had `LIMIT 20`.
 *   In worst case (each retry finds 20 items × ~5 DB queries per item),
 *   the combined invocation could consume 4 × 101 = ~404 subrequests —
 *   MASSIVELY exceeding the Cloudflare Workers Free Plan 50-subrequest
 *   limit per invocation (subrequests accumulate across the entire
 *   invocation including all ctx.waitUntil promises).
 *
 * Fix Stage 1 (H5-CRITICAL):
 *   Reduced `LIMIT 20` → `LIMIT 3` in all 4 retry queries.
 *
 * Fix Stage 2 (H5 Layer 2 — option A+ enhanced):
 *   Further reduced `LIMIT 3` → `LIMIT 1` in 3 of the 4 retry queries:
 *     1. retryFailedReferralRewards  — LIMIT 3 → LIMIT 1
 *     2. retryFailedWheelRewards      — LIMIT 3 → LIMIT 1
 *     3. retryFailedMissionRewards   — KEEP LIMIT 3 (3-day hard window)
 *     4. retryFailedRefunds           — LIMIT 3 → LIMIT 1
 *   Mission is kept at LIMIT 3 because of the 3-day hard window
 *   (daily_date >= CURRENT_DATE - 2). LIMIT=1 would drain max 24 items
 *   in 3 days; a backlog spike > 24 items would cause permanent mission
 *   reward loss. LIMIT=3 drains 72 items in 3 days (3× safety margin).
 *
 * Fix Stage 3 (H5 Layer 3 — enqueueOnly on referral notifications):
 *   Added `enqueueOnly: true` to the 3 `notificationService.create`
 *   calls inside `creditReferralWithReward`. This skips the in-flight
 *   processQueue(3) cascade inside sendNotification. The 1-min cron's
 *   processQueue(5) (scheduler.js:148) drains the queue every minute
 *   using FOR UPDATE SKIP LOCKED, so notifications are still delivered
 *   within ~60s. Saves ~21 subrequests per referral retry item.
 *
 * This test asserts:
 *   1. Referral/Wheel/Refund retry queries close with `LIMIT 1\`,`.
 *   2. Mission retry query STILL closes with `LIMIT 3\`,` (preserved).
 *   3. None of the 4 retry function bodies contain `LIMIT 20\`,` anymore.
 *   4. Function names and overall logic are unchanged (still bounded by
 *      ORDER BY ... ASC, still iterate the result rows, still per-row
 *      try/catch for batch isolation).
 *   5. Unrelated `LIMIT 20` occurrences elsewhere in worker-proxy.js
 *      (getNewsAIMonitoring rolling window, admin diagnostic endpoints)
 *      are UNCHANGED — only the 4 retry queries were modified.
 *   6. Retry idempotency is preserved (UNIQUE constraint references still
 *      present; per-row try/catch still present; only batch size changed).
 *   7. Exactly 3 `enqueueOnly: true` occurrences in creditReferralWithReward
 *      (one per notificationService.create call).
 *   8. enqueueOnly is NOT used anywhere else (no accidental scope creep).
 *
 * Scope:
 *   Source-inspection test (no runtime execution). Mirrors the pattern
 *   of `mission-reward-retry-test.cjs` and `cron-architecture-test.cjs`.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const REFERRAL_REWARDS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/referral-rewards.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/cron/scheduler.js'), 'utf8');
const TELEMETRY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/telemetry.js'), 'utf8');
const SUMMARY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/summary.js'), 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

/**
 * Extract a function body from worker-proxy.js source by function name.
 * Returns the substring from `async function <name>` to the next
 * `async function ` (or end-of-file if last function).
 */
function extractFunctionBody(fnName) {
  const startMarker = `async function ${fnName}`;
  const startIdx = REFERRAL_REWARDS_SRC.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Function ${fnName} must exist in worker-proxy.js`);

  const nextAsyncIdx = REFERRAL_REWARDS_SRC.indexOf('async function ', startIdx + startMarker.length);
  const endIdx = nextAsyncIdx === -1 ? REFERRAL_REWARDS_SRC.length : nextAsyncIdx;

  return REFERRAL_REWARDS_SRC.slice(startIdx, endIdx);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 1 — Retry QUERIES: referral/wheel/refund use LIMIT 1, mission
// KEEPS LIMIT 3 (H5 Layer 2 — staged LIMIT reduction).
// Verified via SQL template closing pattern `LIMIT N\`,` — unique to SQL
// strings, NOT to comments.
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-01: retryFailedReferralRewards SQL query closes with `LIMIT 1`, (was `LIMIT 3`, was `LIMIT 20`, — H5 Layer 2)', () => {
  const body = extractFunctionBody('retryFailedReferralRewards');
  assert.ok(body.includes('LIMIT 1`,'),
    'retryFailedReferralRewards SQL query must close with `LIMIT 1`, (H5 Layer 2 — was LIMIT 3, was LIMIT 20)');
  assert.ok(!body.includes('LIMIT 3`,'),
    'retryFailedReferralRewards SQL query must NOT close with `LIMIT 3`, anymore (H5 Layer 2)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedReferralRewards SQL query must NOT close with `LIMIT 20`, anymore');
});

test('H5-CRIT-02: retryFailedWheelRewards SQL query closes with `LIMIT 1`, (was `LIMIT 3`, was `LIMIT 20`, — H5 Layer 2)', () => {
  const body = extractFunctionBody('retryFailedWheelRewards');
  assert.ok(body.includes('LIMIT 1`,'),
    'retryFailedWheelRewards SQL query must close with `LIMIT 1`, (H5 Layer 2 — was LIMIT 3, was LIMIT 20)');
  assert.ok(!body.includes('LIMIT 3`,'),
    'retryFailedWheelRewards SQL query must NOT close with `LIMIT 3`, anymore (H5 Layer 2)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedWheelRewards SQL query must NOT close with `LIMIT 20`, anymore');
});

test('H5-CRIT-03: retryFailedMissionRewards SQL query STILL closes with `LIMIT 3`, (KEPT — 3-day hard window safety margin — H5 Layer 2)', () => {
  const body = extractFunctionBody('retryFailedMissionRewards');
  assert.ok(body.includes('LIMIT 3`,'),
    'retryFailedMissionRewards SQL query must STILL close with `LIMIT 3`, (H5 Layer 2 — KEPT for 3-day window safety)');
  assert.ok(!body.includes('LIMIT 1`,'),
    'retryFailedMissionRewards SQL query must NOT close with `LIMIT 1`, (would risk permanent mission reward loss)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedMissionRewards SQL query must NOT close with `LIMIT 20`, anymore');
});

test('H5-CRIT-04: retryFailedRefunds SQL query closes with `LIMIT 1`, (was `LIMIT 3`, was `LIMIT 20`, — H5 Layer 2)', () => {
  const body = extractFunctionBody('retryFailedRefunds');
  assert.ok(body.includes('LIMIT 1`,'),
    'retryFailedRefunds SQL query must close with `LIMIT 1`, (H5 Layer 2 — was LIMIT 3, was LIMIT 20)');
  assert.ok(!body.includes('LIMIT 3`,'),
    'retryFailedRefunds SQL query must NOT close with `LIMIT 3`, anymore (H5 Layer 2)');
  assert.ok(!body.includes('LIMIT 20`,'),
    'retryFailedRefunds SQL query must NOT close with `LIMIT 20`, anymore');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 2 — Function names + structure preserved
// ═══════════════════════════════════════════════════════════════════════════

test('H5-CRIT-05: all 4 retry function names are unchanged', () => {
  assert.ok(REFERRAL_REWARDS_SRC.includes('async function retryFailedReferralRewards'),
    'retryFailedReferralRewards function name preserved');
  assert.ok(REFERRAL_REWARDS_SRC.includes('async function retryFailedWheelRewards'),
    'retryFailedWheelRewards function name preserved');
  assert.ok(REFERRAL_REWARDS_SRC.includes('async function retryFailedMissionRewards'),
    'retryFailedMissionRewards function name preserved');
  assert.ok(REFERRAL_REWARDS_SRC.includes('async function retryFailedRefunds'),
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
  const fnStart = TELEMETRY_SRC.indexOf('async function getNewsAIMonitoring');
  assert.notEqual(fnStart, -1, 'getNewsAIMonitoring function must exist');

  // Find the next `async function ` to bound the search (function end).
  const nextFnIdx = TELEMETRY_SRC.indexOf('async function ', fnStart + 10);
  const fnBody = TELEMETRY_SRC.slice(fnStart, nextFnIdx === -1 ? TELEMETRY_SRC.length : nextFnIdx);

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

test('H5-CRIT-15: all 4 retry functions are still called from the 1-min cron (minute===1 hourly branch)', () => {
  // H5-CRITICAL fix only changed LIMIT inside the retry queries. The call
  // sites in scheduled() must remain unchanged (still 4 ctx.waitUntil calls,
  // still gated by _hourlyMinute === 1 — moved from 0 to 1 by ARCH-BATCH2
  // to isolate retries from the triple-cron overlap at minute 0).
  assert.ok(SCHEDULER_SRC.includes('_hourlyMinute === 1'),
    '1-min cron must gate hourly retries by _hourlyMinute === 1 (moved from 0 by ARCH-BATCH2)');
  assert.ok(!SCHEDULER_SRC.includes('_hourlyMinute === 0'),
    '1-min cron must NOT gate hourly retries by _hourlyMinute === 0 (moved to 1)');

  // Verify all 4 retry calls are still inside ctx.waitUntil blocks
  for (const fnCall of [
    'await retryFailedReferralRewards(env)',
    'await retryFailedWheelRewards(env)',
    'await retryFailedMissionRewards(env)',
    'await retryFailedRefunds(env)',
  ]) {
    assert.ok(SCHEDULER_SRC.includes(fnCall),
      `${fnCall} must still be called from the 1-min cron hourly branch`);
  }
});

test('H5-CRIT-16: exactly 1 `LIMIT 3\`,` occurrence in referral-rewards.js (only mission retry — H5 Layer 2)', () => {
  // The H5-CRITICAL fix added exactly 4 `LIMIT 3\`,` occurrences (one per
  // retry query). H5 Layer 2 reduced 3 of them to `LIMIT 1\`,`, Only the
  // mission retry KEEPS `LIMIT 3\`,`` (preserved for 3-day window safety).
  //
  // Note: processQueue uses `LIMIT ${batchLimit}` (dynamic) and cron comments
  // mention "LIMIT 3" in processQueue CPU budget discussions, but those are
  // NOT `LIMIT 3\`,` patterns (they're either dynamic interpolation or
  // comment text). So the exact match `LIMIT 3\`,` is the precise signature
  // of SQL retry queries.
  const matches = (REFERRAL_REWARDS_SRC.match(/LIMIT 3`,/g) || []).length;
  assert.equal(matches, 1,
    `must have exactly 1 \`LIMIT 3\`,\` occurrence (only mission retry — H5 Layer 2) — found ${matches}`);
});

test('H5-CRIT-16b: exactly 3 `LIMIT 1\`,` occurrences in referral-rewards.js (referral/wheel/refund — H5 Layer 2)', () => {
  // H5 Layer 2 added exactly 3 `LIMIT 1\`,` occurrences (referral, wheel,
  // refund). Mission KEEPS LIMIT 3 (asserted in H5-CRIT-03/16 above).
  const matches = (REFERRAL_REWARDS_SRC.match(/LIMIT 1`,/g) || []).length;
  assert.equal(matches, 3,
    `must have exactly 3 \`LIMIT 1\`,\` occurrences (referral/wheel/refund — H5 Layer 2) — found ${matches}`);
});

test('H5-CRIT-17: retryFailed* jobs are NOT inside the isEvery15Min block (architecture preserved)', () => {
  // Regression guard from cron-architecture-test.cjs (T7-T9) — the H5-CRITICAL
  // fix must NOT have moved retry jobs into the */15 branch.
  const idx15 = SCHEDULER_SRC.indexOf('if (isEvery15Min) {');
  assert.notEqual(idx15, -1, 'isEvery15Min block must exist');
  // Find the next major block boundary after the isEvery15Min block
  // (the catch at the end of the withPhasePool block)
  const catchIdx = SCHEDULER_SRC.indexOf('}).catch((e) => {', idx15);
  const block = SCHEDULER_SRC.slice(idx15, catchIdx === -1 ? idx15 + 5000 : catchIdx);

  assert.ok(!block.includes('await retryFailedReferralRewards'),
    'retryFailedReferralRewards must NOT be in the isEvery15Min block (architecture preserved)');
  assert.ok(!block.includes('await retryFailedWheelRewards'),
    'retryFailedWheelRewards must NOT be in the isEvery15Min block (architecture preserved)');
  assert.ok(!block.includes('await retryFailedMissionRewards'),
    'retryFailedMissionRewards must NOT be in the isEvery15Min block (architecture preserved)');
  assert.ok(!block.includes('await retryFailedRefunds'),
    'retryFailedRefunds must NOT be in the isEvery15Min block (architecture preserved)');
});

// ═══════════════════════════════════════════════════════════════════════════
// GROUP 6 — H5 Layer 3: enqueueOnly=true on the 3 referral notification
// calls inside creditReferralWithReward. Skips the in-flight processQueue(3)
// cascade inside sendNotification; the 1-min cron's processQueue(5) still
// delivers within ~60s. Saves ~21 subrequests per referral retry item.
// ═══════════════════════════════════════════════════════════════════════════

function extractCreditReferralWithRewardBody() {
  // creditReferralWithReward is the function containing the 3
  // notificationService.create calls. Extracted to its own block.
  const startMarker = 'async function creditReferralWithReward';
  const startIdx = REFERRAL_REWARDS_SRC.indexOf(startMarker);
  assert.notEqual(startIdx, -1, 'creditReferralWithReward must exist');
  const nextAsyncIdx = REFERRAL_REWARDS_SRC.indexOf('async function ', startIdx + startMarker.length);
  const endIdx = nextAsyncIdx === -1 ? REFERRAL_REWARDS_SRC.length : nextAsyncIdx;
  return REFERRAL_REWARDS_SRC.slice(startIdx, endIdx);
}

test('H5-LAYER3-01: creditReferralWithReward contains exactly 3 notificationService.create calls', () => {
  const body = extractCreditReferralWithRewardBody();
  const matches = (body.match(/notificationService\.create\(env, \{/g) || []).length;
  assert.equal(matches, 3,
    `creditReferralWithReward must contain exactly 3 notificationService.create calls (referral_new_invite, referral_reward, referral_rich) — found ${matches}`);
});

test('H5-LAYER3-02: all 3 notificationService.create calls in creditReferralWithReward have enqueueOnly: true', () => {
  const body = extractCreditReferralWithRewardBody();
  // Count occurrences of `enqueueOnly: true` — must be exactly 3.
  const matches = (body.match(/enqueueOnly: true/g) || []).length;
  assert.equal(matches, 3,
    `all 3 notificationService.create calls must have enqueueOnly: true (H5 Layer 3) — found ${matches}`);
});

test('H5-LAYER3-03: referral_new_invite notification has enqueueOnly: true', () => {
  const body = extractCreditReferralWithRewardBody();
  // Find the block for the referral_new_invite call (Call 1)
  const callStart = body.indexOf("templateKey: 'referral_new_invite'");
  assert.notEqual(callStart, -1, 'referral_new_invite call must exist');
  // The enqueueOnly: true must appear AFTER this call's opening and BEFORE
  // the next call's closing `}).catch(() => {})` (or `});` for the rich call).
  const callEnd = body.indexOf('}).catch(() => {})', callStart);
  assert.notEqual(callEnd, -1, 'referral_new_invite call must close');
  const callBlock = body.slice(callStart, callEnd);
  assert.ok(callBlock.includes('enqueueOnly: true'),
    'referral_new_invite notification must have enqueueOnly: true (H5 Layer 3)');
});

test('H5-LAYER3-04: referral_reward notification has enqueueOnly: true', () => {
  const body = extractCreditReferralWithRewardBody();
  const callStart = body.indexOf("templateKey: 'referral_reward'");
  assert.notEqual(callStart, -1, 'referral_reward call must exist');
  const callEnd = body.indexOf('}).catch(() => {})', callStart);
  assert.notEqual(callEnd, -1, 'referral_reward call must close');
  const callBlock = body.slice(callStart, callEnd);
  assert.ok(callBlock.includes('enqueueOnly: true'),
    'referral_reward notification must have enqueueOnly: true (H5 Layer 3)');
});

test('H5-LAYER3-05: referral_rich notification has enqueueOnly: true', () => {
  const body = extractCreditReferralWithRewardBody();
  // The referral_rich call is the 3rd call (Phase 2 — rich Telegram message).
  // It uses `dedupKey: `referral_rich_${referralId}`` and has telegramExtra.
  const callStart = body.indexOf('dedupKey: `referral_rich_${referralId}`');
  assert.notEqual(callStart, -1, 'referral_rich call (Phase 2) must exist');
  // The call ends with `});` (no .catch wrapper — it's awaited directly).
  // Find the first `});` AFTER the telegramExtra block closes.
  const telegramExtraIdx = body.indexOf('telegramExtra:', callStart);
  assert.notEqual(telegramExtraIdx, -1, 'referral_rich must have telegramExtra');
  const callEnd = body.indexOf('});', telegramExtraIdx);
  assert.notEqual(callEnd, -1, 'referral_rich call must close after telegramExtra');
  const callBlock = body.slice(callStart, callEnd);
  assert.ok(callBlock.includes('enqueueOnly: true'),
    'referral_rich notification must have enqueueOnly: true (H5 Layer 3)');
});

test('H5-LAYER3-06: enqueueOnly is NOT used outside creditReferralWithReward in referral-rewards.js (no accidental scope creep)', () => {
  // enqueueOnly: true must ONLY appear in creditReferralWithReward's 3 calls.
  // It must NOT be added to retryFailedReferralRewards, retryFailedWheelRewards,
  // retryFailedMissionRewards, retryFailedRefunds, or processPendingReferralReward.
  const creditBody = extractCreditReferralWithRewardBody();
  const totalMatches = (REFERRAL_REWARDS_SRC.match(/enqueueOnly: true/g) || []).length;
  const creditMatches = (creditBody.match(/enqueueOnly: true/g) || []).length;
  assert.equal(totalMatches, creditMatches,
    `enqueueOnly: true must ONLY appear inside creditReferralWithReward — total=${totalMatches}, credit=${creditMatches}`);
});

test('H5-LAYER3-07: enqueueOnly: true is NOT added to worker-proxy.js (no accidental scope creep beyond referral-rewards.js)', () => {
  // The H5 Layer 3 change must ONLY affect the 3 referral notification calls
  // in src/services/referral-rewards.js. No other notificationService.create
  // call (in alerts, calendar, broadcast, etc.) should have enqueueOnly: true
  // added by this change.
  //
  // Note: the existing broadcast loops already use enqueueOnly: true
  // (added by the Phase 1 broadcast-batch fix). That's fine — those are
  // pre-existing. We only assert that we did NOT add NEW enqueueOnly: true
  // occurrences outside referral-rewards.js.
  //
  // Approach: count enqueueOnly: true occurrences in worker-proxy.js. This
  // count must be 0 (the existing broadcast loops are in
  // notification_platform.js's processBroadcastFull, not in worker-proxy.js).
  const workerMatches = (WORKER_SRC.match(/enqueueOnly: true/g) || []).length;
  assert.equal(workerMatches, 0,
    `worker-proxy.js must have ZERO new enqueueOnly: true occurrences (H5 Layer 3 only touched referral-rewards.js) — found ${workerMatches}`);
});

test('H5-LAYER3-08: notification persistence preserved — INSERT notifications + enqueue still run (enqueueOnly only skips processQueue cascade)', () => {
  // enqueueOnly: true is gated at notification_platform.js:1227:
  //   `if (env_sendTelegramMessage && !enqueueOnly) { await processQueue(...); }`
  // The INSERT notifications (line 1185-1194) and enqueue (line 706-710)
  // are NOT gated by enqueueOnly — they ALWAYS run. This test verifies
  // the gate is still present and correct.
  const NOTIF_REPO = fs.readFileSync(path.join(__dirname, '..', 'src/repositories/notification_platform.js'), 'utf8');
  assert.ok(NOTIF_REPO.includes('if (env_sendTelegramMessage && !enqueueOnly)'),
    'processQueue cascade must still be gated on !enqueueOnly (H5 Layer 3 relies on this)');
  // INSERT notifications must NOT be gated by enqueueOnly — must always run
  // when deliverToMiniApp is true.
  assert.ok(NOTIF_REPO.includes('if (deliverToMiniApp)'),
    'INSERT notifications must still be gated on deliverToMiniApp (NOT on enqueueOnly)');
  // Enqueue must NOT be gated by enqueueOnly — must always run when
  // deliverToTelegram is true.
  assert.ok(NOTIF_REPO.includes('if (deliverToTelegram)'),
    'enqueue must still be gated on deliverToTelegram (NOT on enqueueOnly)');
});

test('H5-LAYER3-09: dedupKey pattern preserved for all 3 referral notifications (idempotency unchanged)', () => {
  // enqueueOnly: true only skips the in-flight processQueue(3). The dedupKey
  // (which becomes the deterministic notificationId) MUST be preserved
  // so ON CONFLICT (id) DO NOTHING still prevents duplicates.
  const body = extractCreditReferralWithRewardBody();
  assert.ok(body.includes('dedupKey: `referral_new_${referralId}`'),
    'referral_new_invite dedupKey must be preserved (idempotency via deterministic notificationId)');
  assert.ok(body.includes('dedupKey: `referral_reward_${referralId}`'),
    'referral_reward dedupKey must be preserved');
  assert.ok(body.includes('dedupKey: `referral_rich_${referralId}`'),
    'referral_rich dedupKey must be preserved');
});

test('H5-LAYER3-10: telegramExtra preserved on referral_rich notification (rich message buttons unchanged)', () => {
  // The referral_rich notification has inline keyboard buttons (telegramExtra).
  // H5 Layer 3 must NOT have touched this — only enqueueOnly was added.
  const body = extractCreditReferralWithRewardBody();
  assert.ok(body.includes('telegramExtra:'),
    'referral_rich notification must still have telegramExtra (inline keyboard)');
  assert.ok(body.includes('reply_markup:'),
    'referral_rich notification must still have reply_markup (inline keyboard)');
  assert.ok(body.includes("parse_mode: 'HTML'"),
    'referral_rich notification must still have parse_mode HTML');
});

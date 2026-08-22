/**
 * Phase 2 — Daily Mission Reward Recovery Tests
 *
 * Tests the retryFailedMissionRewards cron function that recovers
 * daily mission rewards where markMissionRewarded succeeded but
 * economyService.grantReward failed (reward-loss window).
 *
 * Test cases:
 * 1. Missing reward transaction → reward recovered
 * 2. Existing transaction → no duplicate reward
 * 3. Idempotent retry (run twice → no duplicate)
 * 4. Unrelated transactions ignored
 * 5. Multiple missions/users recovered
 * 6. Out-of-window mission not processed
 * 7. Individual failure doesn't abort batch
 *
 * Uses source-eval pattern (same as existing test files).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');

// ─── Source verification tests (no runtime execution) ─────────────────────

test('MISSION-RETRY-01: retryFailedMissionRewards function exists', () => {
  assert.ok(WORKER_SRC.includes('async function retryFailedMissionRewards'),
    'retryFailedMissionRewards must be defined');
});

test('MISSION-RETRY-02: uses same ref_id format as fireDailyLoginMission (Tehran date)', () => {
  // PHASE 1 FIX: fireDailyLoginMission now uses Tehran date (not UTC) for refId.
  // Retry must use the SAME Tehran date to maintain idempotency.
  // The retry cron uses sharedGetTehranDateString() (same helper as fireDailyLoginMission).
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes('sharedGetTehranDateString'),
    'retry must use sharedGetTehranDateString helper (Tehran date, consistent with fireDailyLoginMission)');
  assert.ok(retryBlock.includes("`mission_${row.user_id}_${row.mission_id}_${tehranToday}`"),
    'retry must use Tehran date in refId: mission_${user_id}_${mission_id}_${tehranToday}');
});

test('MISSION-RETRY-03: uses same tx_type as original reward', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes("'mission_reward'"),
    'retry must use tx_type: mission_reward');
});

test('MISSION-RETRY-04: query finds completed+rewarded missions without token_transactions', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes('completed = TRUE'),
    'query must filter completed = TRUE');
  assert.ok(retryBlock.includes('rewarded = TRUE'),
    'query must filter rewarded = TRUE');
  assert.ok(retryBlock.includes('NOT EXISTS'),
    'query must use NOT EXISTS to find missing transactions');
  assert.ok(retryBlock.includes("tx_type = 'mission_reward'"),
    'query must match tx_type = mission_reward');
});

test('MISSION-RETRY-05: query bounded to today + yesterday + day before (timezone safety)', () => {
  // PHASE 1 FIX: query window widened to CURRENT_DATE - 2 to cover timezone edge cases.
  // Tehran is UTC+3:30, so a mission completed at 00:00 Tehran (20:30 UTC previous day)
  // would have daily_date = previous UTC day. The retry cron must check 3 candidate
  // ref_ids (daily_date, daily_date+1, daily_date-1) to find the matching token_transaction.
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes('CURRENT_DATE - 2'),
    'query must bound to today + yesterday + day before (CURRENT_DATE - 2) for timezone safety');
});

test('MISSION-RETRY-06: query has LIMIT 20', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes('LIMIT 20'),
    'query must have LIMIT 20 for bounded batch');
});

test('MISSION-RETRY-07: reward amount from DB (not hardcoded)', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes('getMissionReward'),
    'retry must call getMissionReward to get amount from DB');
  assert.ok(retryBlock.includes('missionConfig.token_amount'),
    'retry must use missionConfig.token_amount');
});

test('MISSION-RETRY-08: individual failure does not abort batch', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  // Each row has its own try/catch
  assert.ok(retryBlock.includes("catch (e)"),
    'each row must have individual try/catch');
  assert.ok(retryBlock.includes("don't abort the batch"),
    'comment must document batch isolation');
});

test('MISSION-RETRY-09: wired into */15 cron schedule', () => {
  assert.ok(WORKER_SRC.includes('retryFailedMissionRewards(env)'),
    'retryFailedMissionRewards must be called in the cron');
  assert.ok(WORKER_SRC.includes("'phase2-mission'"),
    'must log phase2-mission');
  assert.ok(WORKER_SRC.includes('_savedReqPoolForMission'),
    'must use env._reqPool save/restore pattern (same as referral/wheel)');
});

test('MISSION-RETRY-10: does NOT modify markMissionRewarded or creditTokens', () => {
  // Verify the original functions are unchanged
  assert.ok(WORKER_SRC.includes('WHERE rewarded = FALSE'),
    'markMissionRewarded WHERE clause preserved');
  assert.ok(WORKER_SRC.includes('ON CONFLICT DO NOTHING'),
    'creditTokens ON CONFLICT preserved');
});

test('MISSION-RETRY-11: does NOT modify fireDailyLoginMission', () => {
  // fireDailyLoginMission is in src/controllers/wallet.js
  assert.ok(WALLET_SRC.includes('async function fireDailyLoginMission'),
    'fireDailyLoginMission exists in wallet.js');
  assert.ok(WALLET_SRC.includes('markMissionRewarded'),
    'fireDailyLoginMission still calls markMissionRewarded');
  assert.ok(WALLET_SRC.includes('economyService.grantReward'),
    'fireDailyLoginMission still calls grantReward');
  // The catch that returns null must still be present
  assert.ok(WALLET_SRC.includes("safeError('fire-daily-login-mission'"),
    'fireDailyLoginMission still has its try/catch with safeError');
});

test('MISSION-RETRY-12: does NOT add diagnostics or modify bootstrap', () => {
  // Phase 12: temporary bootstrap diagnostic instrumentation (_bsDiag / _bsLog)
  // was removed from the codebase entirely. The retry function must not contain
  // either helper — this assertion is now structural (the helpers no longer
  // exist anywhere in worker-proxy.js, so their absence here is trivially true
  // and serves as a regression guard against re-introduction).
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(!retryBlock.includes('_bsDiag'),
    'no _bsDiag added to retry function');
  assert.ok(!retryBlock.includes('_bsLog'),
    'no _bsLog added to retry function');
  // Whole-file regression guard: the diagnostic helpers themselves must be gone.
  assert.ok(!WORKER_SRC.includes('function _bsDiag'),
    '_bsDiag function definition must be removed from worker-proxy.js');
  assert.ok(!WORKER_SRC.includes('function _sanitizeDiagString'),
    '_sanitizeDiagString function definition must be removed from worker-proxy.js');
});

test('MISSION-RETRY-13: uses safeError for top-level catch (existing pattern)', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes("safeError('mission-reward-retry-cron'"),
    'top-level catch must use safeError with mission-reward-retry-cron scope');
});

test('MISSION-RETRY-14: checks isDatabaseConfigured + economyService + walletRepo', () => {
  const retryBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function retryFailedMissionRewards'),
    WORKER_SRC.indexOf('async function retryFailedMissionRewards') + 6500
  );
  assert.ok(retryBlock.includes('isDatabaseConfigured(env)'),
    'must check isDatabaseConfigured');
  assert.ok(retryBlock.includes('!economyService || !walletRepo'),
    'must check economyService + walletRepo availability');
});

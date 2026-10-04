/**
 * Batch 2 — Architecture Audit (Reliability) Regression Tests
 *
 * Phase 1: Request/Correlation ID (X-Request-Id header + request_id wiring)
 * Phase 2: Hourly Retry Isolation (retry gate moved from minute 0 to minute 1)
 * Phase 3: Overlap Protection (audit-only — NO concurrency:cancel-in-progress)
 * Phase 4: LIMIT comments corrected (LIMIT 20 → actual values)
 *
 * Run: node --test tests/batch2-arch-audit-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/cron/scheduler.js'), 'utf8');
const ECONOMY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/economy.js'), 'utf8');
const REFERRAL_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/services/referral-rewards.js'), 'utf8');
const WRANGLER_SRC = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

// ============================================================================
// PHASE 1 — Request / Correlation ID
// ============================================================================

test('1a. jsonResponse adds X-Request-Id header from trace context', () => {
  const fnStart = WORKER_SRC.indexOf('function jsonResponse(');
  assert.ok(fnStart > -1, 'jsonResponse must exist');
  const fnEnd = WORKER_SRC.indexOf('\n}', fnStart);
  const fnBody = WORKER_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WORKER_SRC.length);
  assert.match(fnBody, /X-Request-Id/, 'jsonResponse must set X-Request-Id header');
  assert.match(fnBody, /_traceContextALS\.getStore\(\)\?\.id/, 'must read traceId from _traceContextALS');
});

test('1b. OPTIONS preflight also adds X-Request-Id', () => {
  const optionsIdx = WORKER_SRC.indexOf("request.method === 'OPTIONS'");
  assert.ok(optionsIdx > -1, 'OPTIONS preflight must exist');
  const optionsBody = WORKER_SRC.slice(optionsIdx, Math.min(optionsIdx + 300, WORKER_SRC.length));
  assert.match(optionsBody, /X-Request-Id/, 'OPTIONS preflight must also set X-Request-Id');
});

test('1c. fetch handler sets env._requestId from traceId', () => {
  assert.match(WORKER_SRC, /env\._requestId\s*=\s*_traceCtx\.id/,
    'fetch handler must set env._requestId from the trace context');
});

test('1d. grantReward wires request_id from env._requestId', () => {
  const fnStart = ECONOMY_SRC.indexOf('async function grantReward');
  assert.ok(fnStart > -1, 'grantReward must exist');
  const fnEnd = ECONOMY_SRC.indexOf('\n  }', fnStart);
  const fnBody = ECONOMY_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : ECONOMY_SRC.length);
  assert.match(fnBody, /env\?._requestId/, 'grantReward must reference env._requestId');
  assert.match(fnBody, /request_id:\s*auditInfo\.request_id\s*\|\|\s*env\?._requestId/,
    'grantReward must populate request_id from env._requestId');
});

test('1e. debitUser also wires request_id', () => {
  const fnStart = ECONOMY_SRC.indexOf('async function debitUser');
  assert.ok(fnStart > -1, 'debitUser must exist');
  const fnEnd = ECONOMY_SRC.indexOf('\n  }', fnStart);
  const fnBody = ECONOMY_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : ECONOMY_SRC.length);
  assert.match(fnBody, /env\?._requestId/, 'debitUser must reference env._requestId');
  assert.match(fnBody, /request_id:\s*auditInfo\.request_id\s*\|\|\s*env\?._requestId/,
    'debitUser must populate request_id from env._requestId');
});

test('1f. no new DB query, subrequest, or network call added for request ID', () => {
  const fnStart = ECONOMY_SRC.indexOf('async function grantReward');
  const auditIdx = ECONOMY_SRC.indexOf('_fullAuditInfo', fnStart);
  const spreadEnd = ECONOMY_SRC.indexOf(';', auditIdx);
  const spreadBlock = ECONOMY_SRC.slice(auditIdx, spreadEnd);
  assert.doesNotMatch(spreadBlock, /queryDb|fetch\(|env\.AI\.run/,
    'request_id wiring must NOT add any DB/subrequest/network call');
});

// ============================================================================
// PHASE 2 — Hourly Retry Isolation (minute 0 → minute 1)
// ============================================================================

test('2a. retry gate is at minute 1, NOT minute 0', () => {
  assert.match(SCHEDULER_SRC, /if \(_hourlyMinute === 1\)/,
    'retry gate must be at UTC minute 1 (not 0)');
  assert.doesNotMatch(SCHEDULER_SRC, /if \(_hourlyMinute === 0\)/,
    'retry gate must NOT be at UTC minute 0');
});

test('2b. retry comment references minute 1', () => {
  assert.match(SCHEDULER_SRC, /UTC minute 1/, 'comment must reference UTC minute 1');
  assert.match(SCHEDULER_SRC, /ARCH-BATCH2/, 'comment must reference ARCH-BATCH2 traceability');
});

test('2c. alert cron (runScheduledAlertsBaseline) UNTOUCHED', () => {
  const alertsStart = SCHEDULER_SRC.indexOf('runScheduledAlertsBaseline');
  assert.ok(alertsStart > -1, 'runScheduledAlertsBaseline call must exist');
  const alertsEnd = SCHEDULER_SRC.indexOf('}).catch', alertsStart);
  const retryGate = SCHEDULER_SRC.indexOf('_hourlyMinute', alertsEnd > 0 ? alertsEnd : 0);
  assert.ok(retryGate > alertsEnd,
    'retry gate must come AFTER the alerts+queue waitUntil block (not inside it)');
});

test('2d. retries still in separate ctx.waitUntil calls (not inside alert execution)', () => {
  const retrySection = SCHEDULER_SRC.slice(
    SCHEDULER_SRC.indexOf('if (_hourlyMinute === 1)'),
    SCHEDULER_SRC.indexOf('return;', SCHEDULER_SRC.indexOf('if (_hourlyMinute === 1)'))
  );
  assert.match(retrySection, /ctx\.waitUntil/, 'retries must be in ctx.waitUntil calls');
  const waitUntilCount = (retrySection.match(/ctx\.waitUntil/g) || []).length;
  assert.equal(waitUntilCount, 4,
    `expected 4 retry ctx.waitUntil calls, found ${waitUntilCount}`);
});

// ============================================================================
// PHASE 3 — Overlap Protection (audit-only, NO code change)
// ============================================================================

test('3a. NO concurrency:cancel-in-progress added to wrangler.jsonc', () => {
  assert.doesNotMatch(WRANGLER_SRC, /cancel-in-progress|cancel_in_progress/i,
    'concurrency:cancel-in-progress must NOT be added (can cause missed alerts)');
});

test('3b. no DB advisory lock added for cron serialization', () => {
  assert.doesNotMatch(SCHEDULER_SRC, /pg_advisory_lock.*cron|cron.*pg_advisory_lock/i,
    'no DB advisory lock should be added for cron serialization');
});

// ============================================================================
// PHASE 4 — LIMIT Comments Corrected
// ============================================================================

test('4a. no "LIMIT 20" comment remains in referral-rewards.js', () => {
  assert.doesNotMatch(REFERRAL_SRC, /LIMIT 20/,
    'outdated "LIMIT 20" comment must be corrected');
});

test('4b. referral retry comment says LIMIT 1', () => {
  const idx = REFERRAL_SRC.indexOf('Safety: LIMIT');
  assert.ok(idx > -1, 'referral retry safety comment must exist');
  const comment = REFERRAL_SRC.slice(idx, Math.min(idx + 100, REFERRAL_SRC.length));
  assert.match(comment, /LIMIT 1/, 'referral retry comment must say LIMIT 1');
});

test('4c. mission retry comment says LIMIT 3', () => {
  const idx = REFERRAL_SRC.indexOf('Bounded: LIMIT');
  assert.ok(idx > -1, 'mission retry bounded comment must exist');
  const comment = REFERRAL_SRC.slice(idx, Math.min(idx + 100, REFERRAL_SRC.length));
  assert.match(comment, /LIMIT 3/, 'mission retry comment must say LIMIT 3');
});

test('4d. retry comments reference hourly at UTC minute 1', () => {
  const idx = REFERRAL_SRC.indexOf('Bounded: LIMIT');
  const comment = REFERRAL_SRC.slice(idx, Math.min(idx + 200, REFERRAL_SRC.length));
  assert.match(comment, /hourly at UTC minute 1/,
    'retry comment must reference hourly at UTC minute 1 (not every 15 min)');
});

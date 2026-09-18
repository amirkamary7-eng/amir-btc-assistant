/**
 * H5-5min News AI Subrequest Budget Fix — Regression Test
 *
 * MAX_SUMMARIES_PER_TICK reduced from 4 to 2 to stay within
 * Cloudflare Workers Free Plan 50-subrequest limit.
 *
 * Per-iteration cost: 14 subrequests (cache miss + Groq success via DO)
 * 4 iterations × 14 = 56 → over 50 ❌
 * 2 iterations × 14 = 28 → under 50 ✅ (22 margin for other phases)
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── Tests ───────────────────────────────────────────────────────────────────

test('H5-5MIN-01: MAX_SUMMARIES_PER_TICK === 2 (was 4, reduced for subrequest safety)', () => {
  const maxMatch = WORKER_SRC.match(/MAX_SUMMARIES_PER_TICK\s*=\s*(\d+)/);
  assert.ok(maxMatch, 'MAX_SUMMARIES_PER_TICK must exist');
  assert.equal(maxMatch[1], '2', 'MAX_SUMMARIES_PER_TICK must be 2 (H5-5min fix)');
});

test('H5-5MIN-02: MAX_SUMMARIES_PER_TICK NOT 4 (old value removed)', () => {
  assert.ok(!WORKER_SRC.includes('MAX_SUMMARIES_PER_TICK = 4'),
    'Old value MAX_SUMMARIES_PER_TICK = 4 must NOT exist');
});

test('H5-5MIN-03: Phase 1d loop uses MAX_SUMMARIES_PER_TICK as iteration limit', () => {
  const loopMatch = WORKER_SRC.match(/for\s*\(let\s+i\s*=\s*0;\s*i\s*<\s*MAX_SUMMARIES_PER_TICK;\s*i\+\+\)/);
  assert.ok(loopMatch, 'Phase 1d must use MAX_SUMMARIES_PER_TICK in for loop');
});

test('H5-5MIN-04: overlap skip on :00/:15/:30/:45 still exists', () => {
  assert.ok(WORKER_SRC.includes('_phase1dIsOverlapWith15Min'),
    'Phase 1d overlap check must exist');
  assert.ok(WORKER_SRC.includes('_phase1dCurrentMinute % 15 === 0'),
    'Overlap detection (% 15 === 0) must exist');
  assert.ok(WORKER_SRC.includes('isEvery5Min && !_phase1dIsOverlapWith15Min'),
    'Phase 1d must be gated by both isEvery5Min AND !overlap');
});

test('H5-5MIN-05: queue processing still functional (processOneArticleSummary unchanged)', () => {
  assert.ok(WORKER_SRC.includes('async function processOneArticleSummary'),
    'processOneArticleSummary must still exist (unchanged)');
  assert.ok(WORKER_SRC.includes('async function getSummaryQueue'),
    'getSummaryQueue must still exist');
  assert.ok(WORKER_SRC.includes('async function saveSummaryQueue'),
    'saveSummaryQueue must still exist');
});

test('H5-5MIN-06: AI provider chain unchanged (generateSummaryWithFallback)', () => {
  assert.ok(WORKER_SRC.includes('async function generateSummaryWithFallback'),
    'generateSummaryWithFallback must still exist');
  assert.ok(WORKER_SRC.includes("attemptProvider('groq'"),
    'Groq provider attempt must still exist');
  assert.ok(WORKER_SRC.includes("attemptProvider('openrouter'"),
    'OpenRouter provider attempt must still exist');
  assert.ok(WORKER_SRC.includes("attemptProvider('workers-ai'"),
    'Workers AI provider attempt must still exist');
});

test('H5-5MIN-07: no other changes to Phase 1d structure (break + recordNewsAITick preserved)', () => {
  const phase1dIdx = WORKER_SRC.indexOf('if (isEvery5Min && !_phase1dIsOverlapWith15Min)');
  assert.notEqual(phase1dIdx, -1, 'Phase 1d block must exist');
  const phase1dBlock = WORKER_SRC.slice(phase1dIdx, phase1dIdx + 2000);
  assert.ok(phase1dBlock.includes('processOneArticleSummary'),
    'Phase 1d must call processOneArticleSummary');
  assert.ok(phase1dBlock.includes('recordNewsAITick'),
    'Phase 1d must still call recordNewsAITick');
  assert.ok(phase1dBlock.includes('break'),
    'Phase 1d must still have break on empty queue');
});

test('H5-5MIN-08: subrequest budget safe (2 × 14 = 28, under 50 with margin)', () => {
  // Verify MAX_SUMMARIES_PER_TICK is 2
  const maxMatch = WORKER_SRC.match(/MAX_SUMMARIES_PER_TICK\s*=\s*(\d+)/);
  const maxVal = Number(maxMatch[1]);
  assert.equal(maxVal, 2);
  // 2 iterations × 14 subrequests/iteration = 28 subrequests for Phase 1d
  // + ~10 overhead from other phases = ~38 total (under 50 with 12 margin)
  const phase1dCost = maxVal * 14;
  const typicalOverhead = 10;
  const total = phase1dCost + typicalOverhead;
  assert.ok(total <= 50, `Phase 1d (${phase1dCost}) + overhead (${typicalOverhead}) = ${total} must be ≤ 50`);
});

test('H5-5MIN-09: Price Alert / Calendar / processQueue untouched', () => {
  assert.ok(WORKER_SRC.includes('async function runScheduledAlertsBaseline'),
    'Price Alert must still exist');
  assert.ok(WORKER_SRC.includes('async function runCalendarAlertsCheck'),
    'Calendar must still exist');
  assert.ok(WORKER_SRC.includes('processQueue(env, sendTelegramMessage, pool, 5)'),
    '1-min cron processQueue(5) must still exist');
  assert.ok(WORKER_SRC.includes('processQueue(env, sendTelegramMessage, pool, 15)'),
    '5-min cron processQueue(15) must still exist');
});

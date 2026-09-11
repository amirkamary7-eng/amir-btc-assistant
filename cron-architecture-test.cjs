/**
 * Cron Architecture Regression Test
 *
 * Verifies the cron workload separation:
 *   - retryFailed jobs are NOT in the 15-min branch
 *   - retryFailed jobs ARE in the hourly branch
 *   - processOneArticleSummary is NOT called in processNewsAIBatch
 *   - processOneArticleSummary IS called in the 5-min Phase 1d path
 *   - Queue circuit breaker exists in processNewsAIBatch
 *   - No duplicate cron registration in wrangler.jsonc
 *   - 15-min branch still runs calendar + market + processNewsAIBatch
 *
 * Run: node --test cron-architecture-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const WRANGLER_SRC = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');

// ────────────────────────────────────────────────────────────────────────────
// T7-T9: retryFailed* NOT in */15 branch
// ────────────────────────────────────────────────────────────────────────────

test('T7: retryFailedReferralRewards is NOT called inside the isEvery15Min block', () => {
  // Find the isEvery15Min block that contains processNewsAIBatch (the main */15 heavy block)
  // and verify it does NOT contain any await retryFailedReferralRewards call
  const blockStart = WORKER_SRC.indexOf('if (isEvery15Min) {', WORKER_SRC.indexOf('processNewsAIBatch') - 2000);
  assert.ok(blockStart > 0, 'Must find the isEvery15Min block containing processNewsAIBatch');

  // Find the closing brace of this block (count braces)
  let depth = 0;
  let blockEnd = -1;
  for (let i = blockStart; i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') depth++;
    if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
  }
  assert.ok(blockEnd > 0, 'Must find the closing brace of the isEvery15Min block');

  const block = WORKER_SRC.slice(blockStart, blockEnd);
  assert.ok(!block.includes('await retryFailedReferralRewards'),
    'retryFailedReferralRewards must NOT be called inside the isEvery15Min block');
});

test('T8: retryFailedWheelRewards is NOT called inside the isEvery15Min block', () => {
  const blockStart = WORKER_SRC.indexOf('if (isEvery15Min) {', WORKER_SRC.indexOf('processNewsAIBatch') - 2000);
  let depth = 0;
  let blockEnd = -1;
  for (let i = blockStart; i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') depth++;
    if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
  }
  const block = WORKER_SRC.slice(blockStart, blockEnd);
  assert.ok(!block.includes('await retryFailedWheelRewards'),
    'retryFailedWheelRewards must NOT be called inside the isEvery15Min block');
});

test('T9: retryFailedMissionRewards is NOT called inside the isEvery15Min block', () => {
  const blockStart = WORKER_SRC.indexOf('if (isEvery15Min) {', WORKER_SRC.indexOf('processNewsAIBatch') - 2000);
  let depth = 0;
  let blockEnd = -1;
  for (let i = blockStart; i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') depth++;
    if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { blockEnd = i; break; } }
  }
  const block = WORKER_SRC.slice(blockStart, blockEnd);
  assert.ok(!block.includes('await retryFailedMissionRewards'),
    'retryFailedMissionRewards must NOT be called inside the isEvery15Min block');
});

// ────────────────────────────────────────────────────────────────────────────
// T10: retryFailed* ARE in the hourly branch
// ────────────────────────────────────────────────────────────────────────────

test('T10: all three retryFailed* jobs are called inside the isHourly block', () => {
  const hourlyStart = WORKER_SRC.indexOf('if (isHourly) {');
  assert.ok(hourlyStart > 0, 'isHourly block must exist');

  // Find the closing brace
  let depth = 0;
  let hourlyEnd = -1;
  for (let i = hourlyStart; i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') depth++;
    if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { hourlyEnd = i; break; } }
  }
  assert.ok(hourlyEnd > 0, 'Must find closing brace of isHourly block');

  const block = WORKER_SRC.slice(hourlyStart, hourlyEnd);
  assert.ok(block.includes('await retryFailedReferralRewards'),
    'retryFailedReferralRewards must be called inside isHourly block');
  assert.ok(block.includes('await retryFailedWheelRewards'),
    'retryFailedWheelRewards must be called inside isHourly block');
  assert.ok(block.includes('await retryFailedMissionRewards'),
    'retryFailedMissionRewards must be called inside isHourly block');
});

// ────────────────────────────────────────────────────────────────────────────
// T11: processOneArticleSummary NOT in processNewsAIBatch
// ────────────────────────────────────────────────────────────────────────────

test('T11: processOneArticleSummary is NOT called inside processNewsAIBatch', () => {
  const batchStart = WORKER_SRC.indexOf('async function processNewsAIBatch');
  assert.ok(batchStart > 0, 'processNewsAIBatch function must exist');

  // Find the closing brace of the function
  let depth = 0;
  let batchEnd = -1;
  for (let i = batchStart; i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') depth++;
    if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { batchEnd = i; break; } }
  }
  assert.ok(batchEnd > 0, 'Must find closing brace of processNewsAIBatch');

  const fnBody = WORKER_SRC.slice(batchStart, batchEnd);
  assert.ok(!fnBody.includes('await processOneArticleSummary'),
    'processOneArticleSummary must NOT be called inside processNewsAIBatch (removed from STEP 9)');
});

// ────────────────────────────────────────────────────────────────────────────
// T12: processOneArticleSummary IS in the */5 Phase 1d path
// ────────────────────────────────────────────────────────────────────────────

test('T12: processOneArticleSummary IS called in the */5 Phase 1d path', () => {
  // The */5 Phase 1d path has MAX_SUMMARIES_PER_TICK
  const phase1dIdx = WORKER_SRC.indexOf('MAX_SUMMARIES_PER_TICK');
  assert.ok(phase1dIdx > 0, 'MAX_SUMMARIES_PER_TICK must exist (Phase 1d)');

  // Check that processOneArticleSummary is called near that location (within 500 chars)
  const nearby = WORKER_SRC.slice(phase1dIdx, phase1dIdx + 500);
  assert.ok(nearby.includes('processOneArticleSummary'),
    'processOneArticleSummary must be called in the Phase 1d path');
});

// ────────────────────────────────────────────────────────────────────────────
// T13: Queue circuit breaker exists in processNewsAIBatch
// ────────────────────────────────────────────────────────────────────────────

test('T13: queue circuit breaker exists in processNewsAIBatch with threshold 40', () => {
  const batchStart = WORKER_SRC.indexOf('async function processNewsAIBatch');
  let depth = 0;
  let batchEnd = -1;
  for (let i = batchStart; i < WORKER_SRC.length; i++) {
    if (WORKER_SRC[i] === '{') depth++;
    if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { batchEnd = i; break; } }
  }
  const fnBody = WORKER_SRC.slice(batchStart, batchEnd);

  assert.ok(fnBody.includes('CIRCUIT_BREAKER'),
    'Circuit breaker must exist in processNewsAIBatch');
  assert.ok(fnBody.includes('NEWS_QUEUE_OVERLOAD_THRESHOLD'),
    'NEWS_QUEUE_OVERLOAD_THRESHOLD constant must exist');
  assert.ok(fnBody.includes('> 40') || fnBody.includes('NEWS_QUEUE_OVERLOAD_THRESHOLD = 40'),
    'Threshold must be 40');
  assert.ok(fnBody.includes('queue_overloaded'),
    'Circuit breaker must return reason: queue_overloaded');
  // Must check pending + processing (not failed)
  assert.ok(fnBody.includes("q.status === 'pending' || q.status === 'processing'"),
    'Circuit breaker must count pending + processing items');
});

// ────────────────────────────────────────────────────────────────────────────
// T14: Circuit breaker does NOT stop the */5 summary consumer
// ────────────────────────────────────────────────────────────────────────────

test('T14: circuit breaker is inside processNewsAIBatch (*/15 only), NOT inside Phase 1d', () => {
  // The circuit breaker should be in processNewsAIBatch (called from */15)
  // and NOT in the Phase 1d path (called from */5)
  const phase1dIdx = WORKER_SRC.indexOf('MAX_SUMMARIES_PER_TICK');
  const nearby = WORKER_SRC.slice(phase1dIdx, phase1dIdx + 1000);
  assert.ok(!nearby.includes('CIRCUIT_BREAKER'),
    'Circuit breaker must NOT be in the Phase 1d (*/5) path — only in processNewsAIBatch (*/15)');
});

// ────────────────────────────────────────────────────────────────────────────
// T15: No duplicate cron registration
// ────────────────────────────────────────────────────────────────────────────

test('T15: no duplicate cron registration in wrangler.jsonc', () => {
  // Count occurrences of each cron expression in wrangler.jsonc
  const crons = ['* * * * *', '*/5 * * * *', '*/15 * * * *', '0 * * * *'];
  for (const cron of crons) {
    // Count in the production section (not staging)
    const prodSection = WRANGLER_SRC.slice(WRANGLER_SRC.indexOf('"production"'));
    const count = (prodSection.match(new RegExp(`"${cron.replace(/\*/g, '\\*')}"`, 'g')) || []).length;
    assert.ok(count === 1, `Cron "${cron}" must appear exactly once in production (found ${count})`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// T16: All 4 cron routes exist in scheduled()
// ────────────────────────────────────────────────────────────────────────────

test('T16: all 4 cron routes exist in scheduled() handler', () => {
  assert.ok(WORKER_SRC.includes("const isEveryMinute = cronExpr === '* * * * *'"),
    'isEveryMinute route must exist');
  assert.ok(WORKER_SRC.includes("const isEvery5Min = cronExpr === '*/5 * * * *'"),
    'isEvery5Min route must exist');
  assert.ok(WORKER_SRC.includes("const isEvery15Min = cronExpr === '*/15 * * * *'"),
    'isEvery15Min route must exist');
  assert.ok(WORKER_SRC.includes("const isHourly = cronExpr === '0 * * * *'"),
    'isHourly route must exist');
});

// ────────────────────────────────────────────────────────────────────────────
// T17: 15-min branch still runs calendar + market + processNewsAIBatch
// ────────────────────────────────────────────────────────────────────────────

test('T17: 15-min branch still runs calendar cache + market overview + processNewsAIBatch', () => {
  // There are TWO isEvery15Min blocks in the scheduled() handler:
  // Block 1 (~15904): calendar cache refresh
  // Block 2 (~15944): market overview + processNewsAIBatch
  // Verify each contains the expected jobs.

  // Find the calendar cache isEvery15Min block by looking for fetchCalendarFeed
  // AFTER the scheduled() function starts
  const scheduledStart = WORKER_SRC.indexOf('async scheduled(');
  assert.ok(scheduledStart > 0, 'scheduled() handler must exist');

  // Find all isEvery15Min blocks after scheduled()
  const blocks = [];
  let searchFrom = scheduledStart;
  while (true) {
    const idx = WORKER_SRC.indexOf('if (isEvery15Min) {', searchFrom);
    if (idx === -1) break;
    // Find closing brace
    let depth = 0;
    let end = -1;
    for (let i = idx; i < WORKER_SRC.length; i++) {
      if (WORKER_SRC[i] === '{') depth++;
      if (WORKER_SRC[i] === '}') { depth--; if (depth === 0) { end = i; break; } }
    }
    if (end > 0) {
      blocks.push({ start: idx, end: end, content: WORKER_SRC.slice(idx, end) });
      searchFrom = end + 1;
    } else break;
  }

  assert.ok(blocks.length >= 2, `Must find at least 2 isEvery15Min blocks in scheduled() (found ${blocks.length})`);

  // Block 0: calendar cache
  assert.ok(blocks[0].content.includes('fetchCalendarFeed'),
    'First isEvery15Min block must run calendar cache refresh (fetchCalendarFeed)');

  // Block 1: market + newsAI
  assert.ok(blocks[1].content.includes('refreshOverview') || blocks[1].content.includes('marketOverviewSvc'),
    'Second isEvery15Min block must run market overview');
  assert.ok(blocks[1].content.includes('processNewsAIBatch'),
    'Second isEvery15Min block must run processNewsAIBatch');
});

// ────────────────────────────────────────────────────────────────────────────
// T18: stepLog is untouched (still 34+ references)
// ────────────────────────────────────────────────────────────────────────────

test('T18: stepLog is untouched (still exists in worker-proxy.js)', () => {
  const count = (WORKER_SRC.match(/stepLog/g) || []).length;
  assert.ok(count >= 30, `stepLog must have at least 30 references (found ${count})`);
});

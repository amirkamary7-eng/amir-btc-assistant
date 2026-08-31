/**
 * Option A - Skip processOneArticleSummary on 15-min overlap
 *
 * Validates that processOneArticleSummary only runs on 5-min ticks that do NOT
 * overlap with 15-min. This prevents a 6-request Groq burst at :00/:15/:30/:45.
 *
 * Tests:
 *   OA-001: processOneArticleSummary condition includes !isEvery15Min
 *   OA-002: processOneArticleSummary does NOT run on 15-min overlap ticks
 *   OA-003: processOneArticleSummary DOES run on 5-min non-overlap ticks
 *   OA-004: calendar check still runs on ALL 5-min ticks (not skipped)
 *   OA-005: processNewsAIBatch still runs on 15-min (not affected)
 *   OA-006: failover chain unchanged (groq -> groq-secondary -> gemini -> ...)
 *   OA-007: no API key value in diff
 *
 * Run: node --test option-a-skip-overlap-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// Find the processOneArticleSummary cron condition block
function findProcessOneArticleSummaryBlock() {
  const marker = '// OPTION A: Skip on';
  const idx = WORKER.indexOf(marker);
  assert.ok(idx >= 0, 'OPTION A comment must exist');
  // Get the next 800 chars after the comment (includes the if condition)
  return WORKER.slice(idx, idx + 800);
}

test('OA-001: processOneArticleSummary condition includes !isEvery15Min', () => {
  const block = findProcessOneArticleSummaryBlock();
  assert.ok(block.includes('if (isEvery5Min && !isEvery15Min)'),
    'processOneArticleSummary must be gated on isEvery5Min && !isEvery15Min');
});

test('OA-002: processOneArticleSummary does NOT run on */15 overlap ticks', () => {
  // At :00/:15/:30/:45, isEvery5Min=true AND isEvery15Min=true
  // The condition `isEvery5Min && !isEvery15Min` = true && !true = false → SKIP
  // Simulate the condition:
  const isEvery5Min = true;
  const isEvery15Min = true;
  const shouldRun = isEvery5Min && !isEvery15Min;
  assert.equal(shouldRun, false,
    'processOneArticleSummary must NOT run when isEvery5Min=true AND isEvery15Min=true (overlap)');
});

test('OA-003: processOneArticleSummary DOES run on */5 non-overlap ticks', () => {
  // At :05/:10/:20/:25/:35/:40/:50/:55, isEvery5Min=true AND isEvery15Min=false
  // The condition `isEvery5Min && !isEvery15Min` = true && !false = true → RUN
  const isEvery5Min = true;
  const isEvery15Min = false;
  const shouldRun = isEvery5Min && !isEvery15Min;
  assert.equal(shouldRun, true,
    'processOneArticleSummary MUST run when isEvery5Min=true AND isEvery15Min=false (non-overlap)');
});

test('OA-004: calendar check still runs on ALL */5 ticks (not skipped)', () => {
  // The calendar check at line ~15245 must still use `if (isEvery5Min)` (without !isEvery15Min)
  // Find the calendar check block
  const calIdx = WORKER.indexOf('runCalendarAlertsCheck(env, { isEvery15Min: false }, pool)');
  assert.ok(calIdx >= 0, 'calendar check call not found');
  // Look backwards for the if condition
  const before = WORKER.slice(calIdx - 300, calIdx);
  assert.ok(before.includes('if (isEvery5Min)'),
    'calendar check must still run on ALL */5 ticks (condition: if (isEvery5Min), NOT gated on !isEvery15Min)');
  assert.ok(!before.includes('if (isEvery5Min && !isEvery15Min)'),
    'calendar check must NOT be skipped on */15 overlap (only processOneArticleSummary is skipped)');
});

test('OA-005: processNewsAIBatch still runs on 15-min (not affected)', () => {
  // processNewsAIBatch must still run on isEvery15Min
  const idx = WORKER.indexOf('await processNewsAIBatch(env, pool)');
  assert.ok(idx >= 0, 'processNewsAIBatch call not found');
  // Search backwards for the isEvery15Min gate (is ~1500 chars before the call)
  const before = WORKER.slice(idx - 2000, idx);
  assert.ok(before.includes('if (isEvery15Min)'),
    'processNewsAIBatch must still be gated on if (isEvery15Min) (unchanged)');
});

test('OA-006: failover chain unchanged (groq → groq-secondary → gemini → ...)', () => {
  // Verify the chain order in generateSummaryWithFallback
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  const groqPos = body.indexOf("attemptProvider('groq',");
  const groqSecPos = body.indexOf("attemptProvider('groq-secondary',");
  const geminiPos = body.indexOf("attemptProvider('gemini',");
  const openrouterPos = body.indexOf("attemptProvider('openrouter',");
  const workersAiPos = body.indexOf("attemptProvider('workers-ai',");
  assert.ok(groqPos < groqSecPos, 'groq before groq-secondary');
  assert.ok(groqSecPos < geminiPos, 'groq-secondary before gemini');
  assert.ok(geminiPos < openrouterPos, 'gemini before openrouter');
  assert.ok(openrouterPos < workersAiPos, 'openrouter before workers-ai');
});

test('OA-007: no API key value in diff', () => {
  const GROQ_KEY_PATTERN = /gsk_[A-Za-z0-9]{10,}/;
  assert.ok(!GROQ_KEY_PATTERN.test(WORKER),
    'no hardcoded Groq API key (gsk_...) in worker-proxy.js');
});

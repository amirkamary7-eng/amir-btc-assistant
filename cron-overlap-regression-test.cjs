/**
 * Cron Overlap Regression Test (Phase 3 — Priority 3)
 * =====================================================
 *
 * PROBLEM: The "OPTION A" overlap mitigation at worker-proxy.js:~15728 uses:
 *   if (isEvery5Min && !isEvery15Min) { ... Phase 1d ... }
 *
 * But isEvery5Min and isEvery15Min are BOTH derived from `controller.cron`
 * (the triggering cron expression), NOT from the current wall-clock minute.
 * Each cron trigger creates a SEPARATE scheduled() invocation with exactly
 * ONE cron expression. So:
 *   - When the 5-min cron fires at :00, isEvery5Min=true, isEvery15Min=false
 *     (condition TRUE, Phase 1d RUNS — this is the bug)
 *   - When the 15-min cron fires at :00, isEvery5Min=false, isEvery15Min=true
 *     (condition FALSE, Phase 1d skipped — but the 5-min invocation already ran it)
 *
 * The INTENT was: "skip Phase 1d at :00/:15/:30/:45 because the 15-min cron
 * already runs processNewsAIBatch." But the condition is ALWAYS true on
 * 5-min invocations, so Phase 1d runs at EVERY 5-min tick including overlap.
 *
 * This causes up to 14 Groq calls/min at :00/:15/:30/:45 (4 summaries x 2 keys
 * from Phase 1d + 6 calls from processNewsAIBatch) vs GROQ_RPM_LIMIT=20.
 *
 * FIX: Use the current UTC minute to detect overlap:
 *   const currentMinute = new Date().getUTCMinutes();
 *   const isOverlapWith15Min = currentMinute % 15 === 0;
 *   if (isEvery5Min && !isOverlapWith15Min) { ... Phase 1d ... }
 *
 * Run: node --test cron-overlap-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ── Locate the Phase 1d block ──
const phase1dMarker = 'MAX_SUMMARIES_PER_TICK';
const phase1dIdx = workerSrc.indexOf(phase1dMarker);
assert.ok(phase1dIdx !== -1, 'Phase 1d block (MAX_SUMMARIES_PER_TICK) must exist in worker-proxy.js');

// Find the `if` condition that guards the Phase 1d block (search backwards from MAX_SUMMARIES_PER_TICK)
const searchStart = Math.max(0, phase1dIdx - 500);
const searchRegion = workerSrc.substring(searchStart, phase1dIdx + 200);
const ifMatch = searchRegion.match(/if\s*\(([^)]{1,200})\)\s*\{[^}]*MAX_SUMMARIES_PER_TICK/);
assert.ok(ifMatch, 'Must find the if-condition guarding MAX_SUMMARIES_PER_TICK');
const phase1dCondition = ifMatch[1];

// ── Test 1: PROVE the bug exists — current condition uses isEvery15Min variable ──
// The variable isEvery15Min is derived from controller.cron (per-invocation),
// NOT from the current wall-clock minute. It is ALWAYS false on */5 invocations.
test('CRON-OVERLAP-001: Phase 1d condition must NOT rely on isEvery15Min variable (per-invocation, always false on */5)', () => {
  // The isEvery15Min variable is set from controller.cron, not from the current minute.
  // On a */5 invocation, isEvery15Min is ALWAYS false, making `!isEvery15Min` always true.
  // This means the overlap skip NEVER works.
  assert.ok(
    !phase1dCondition.includes('isEvery15Min'),
    `Phase 1d condition must NOT use isEvery15Min variable (it is per-invocation, always false on */5). ` +
    `Found condition: "${phase1dCondition}". ` +
    `Fix: use current UTC minute (e.g., new Date().getUTCMinutes() % 15 === 0) to detect overlap.`
  );
});

// ── Test 2: FIX — Phase 1d condition must use current-minute overlap check ──
test('CRON-OVERLAP-002: Phase 1d condition must use current-minute overlap check (getUTCMinutes % 15)', () => {
  // The fix should check the current UTC minute to detect :00/:15/:30/:45 overlap.
  // Acceptable patterns:
  //   - new Date().getUTCMinutes() % 15 === 0
  //   - currentMinute % 15 === 0  (if currentMinute is defined from getUTCMinutes)
  //   - isOverlapWith15Min  (if derived from getUTCMinutes)
  const hasMinuteCheck =
    phase1dCondition.includes('getUTCMinutes') ||
    phase1dCondition.includes('currentMinute') ||
    phase1dCondition.includes('OverlapWith15') ||
    phase1dCondition.includes('overlap');
  assert.ok(
    hasMinuteCheck,
    `Phase 1d condition must use a current-minute-based overlap check (getUTCMinutes % 15). ` +
    `Found condition: "${phase1dCondition}".`
  );
});

// ── Test 3: Still uses isEvery5Min (must remain scoped to */5 cron only) ──
test('CRON-OVERLAP-003: Phase 1d condition must still require isEvery5Min (scoped to */5 cron)', () => {
  assert.ok(
    phase1dCondition.includes('isEvery5Min'),
    `Phase 1d condition must still include isEvery5Min (to ensure it only runs on */5 invocations). ` +
    `Found condition: "${phase1dCondition}".`
  );
});

// ── Test 4: No change to cron schedule in wrangler.jsonc ──
test('CRON-OVERLAP-004: wrangler.jsonc production crons must be unchanged (every-min, 5-min, 15-min)', () => {
  const wranglerSrc = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');
  // Find the production env block (line with "production": { — NOT APP_ENV which appears later)
  const prodMatch = wranglerSrc.match(/"production"\s*:\s*\{/);
  assert.ok(prodMatch, 'Must find production env block in wrangler.jsonc');
  const prodIdx = prodMatch.index;
  // Get the section from production block start — the crons are in the first ~60 lines of this block
  const prodSection = wranglerSrc.substring(prodIdx, prodIdx + 2000);
  // Must have all 3 cron expressions in the production section
  assert.ok(prodSection.includes('"* * * * *"'), 'Production must have every-minute cron');
  assert.ok(prodSection.includes('"*/5 * * * *"'), 'Production must have every-5-min cron');
  assert.ok(prodSection.includes('"*/15 * * * *"'), 'Production must have every-15-min cron');
});

// ── Test 5: No change to MAX_SUMMARIES_PER_TICK value ──
test('CRON-OVERLAP-005: MAX_SUMMARIES_PER_TICK must remain 4 (no change to job count)', () => {
  const maxMatch = workerSrc.match(/MAX_SUMMARIES_PER_TICK\s*=\s*(\d+)/);
  assert.ok(maxMatch, 'MAX_SUMMARIES_PER_TICK must exist');
  assert.equal(maxMatch[1], '4', 'MAX_SUMMARIES_PER_TICK must remain 4');
});

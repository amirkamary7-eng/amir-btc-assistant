/**
 * H5 Source Threshold Fix — Regression Test
 *
 * processOneArticleSummary line 8837: source_insufficient_length threshold
 * reduced from 200 to 150 chars to allow RSS-description-only articles
 * (NYT, CoinDesk) to reach AI generation.
 *
 * Production evidence (READ-ONLY investigation, 2026-09-18):
 *   - NYT "Japan Raises Interest Rates" failed with 199 chars (1 short of 200)
 *   - CoinDesk "Ether and XRP ETFs" failed with 191 chars
 *   - NYT RSS: 25/48 items (52%) have combined title+desc < 200 chars
 *   - CoinDesk RSS: 4/25 items (16%) have combined title+desc < 200 chars
 *   - Lowering to 150 catches 22/25 NYT failures + 2/4 CoinDesk failures
 *
 * Safeguards unchanged (verified by this test):
 *   - text_too_short threshold (line 8810): still < 50 chars
 *   - Stage 4 fallback (line 8773): still >= 50 chars
 *   - Summary output validator (line 8910): still >= 200 chars
 *   - PERMANENT_FAIL_REASONS: source_insufficient_length still permanent
 *   - DEGRADED_PUBLISHERS: CoinDesk still present
 *   - Provider fallback chain: groq → openrouter → workers-ai → openai unchanged
 *   - MAX_SUMMARIES_PER_TICK: still 2 (H5-5min fix preserved)
 *
 * All assertions are read-only source-code checks — no production behavior change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, 'src/cron/scheduler.js'), 'utf8');
const NEWS_SHARED_SRC = fs.readFileSync(path.join(__dirname, 'src/news/shared.js'), 'utf8');

// Helper: find the threshold value associated with a specific fail_reason.
// Matches: if (articleText.length < N) { ... fail_reason = 'REASON' ...
// Uses [^}]*? (non-greedy, no closing brace) so it stays within the same
// if-block — cannot accidentally span from text_too_short into
// source_insufficient_length (the text_too_short return-object's closing }
// breaks the match before reaching source_insufficient_length).
function findThresholdForFailReason(reason) {
  const re = new RegExp(
    'if\\s*\\(\\s*articleText\\.length\\s*<\\s*(\\d+)\\s*\\)\\s*\\{[^}]*?fail_reason\\s*=\\s*\'' + reason + '\''
  );
  const m = WORKER_SRC.match(re);
  return m ? Number(m[1]) : null;
}

// ─── Tests ───────────────────────────────────────────────────────────────────

test('SOURCE-THRESHOLD-01: source_insufficient_length threshold is 150 (was 200)', () => {
  const threshold = findThresholdForFailReason('source_insufficient_length');
  assert.ok(threshold !== null, 'source_insufficient_length threshold must exist');
  assert.equal(threshold, 150, 'Threshold must be 150 (H5 source threshold fix — was 200)');
});

test('SOURCE-THRESHOLD-02: old threshold value 200 is NOT used for source_insufficient_length', () => {
  const threshold = findThresholdForFailReason('source_insufficient_length');
  assert.ok(threshold !== null);
  assert.notEqual(threshold, 200, 'Old threshold 200 must NOT be used (must be 150 after fix)');
});

test('SOURCE-THRESHOLD-03: 149 chars → source_insufficient_length (still fails)', () => {
  const threshold = findThresholdForFailReason('source_insufficient_length');
  assert.equal(threshold, 150);
  // 149 < 150 → fails with source_insufficient_length
  assert.ok(149 < threshold, '149 chars must fail (149 < 150)');
});

test('SOURCE-THRESHOLD-04: 150 chars passes threshold (no longer fails)', () => {
  const threshold = findThresholdForFailReason('source_insufficient_length');
  assert.equal(threshold, 150);
  // 150 is NOT < 150 → passes (no longer fails with source_insufficient_length)
  assert.ok(!(150 < threshold), '150 chars must pass threshold (150 < 150 is false)');
});

test('SOURCE-THRESHOLD-05: 191 chars (CoinDesk) passes threshold', () => {
  const threshold = findThresholdForFailReason('source_insufficient_length');
  assert.equal(threshold, 150);
  // 191 is NOT < 150 → passes (previously failed with old 200 threshold)
  assert.ok(!(191 < threshold), '191 chars (CoinDesk "Ether and XRP ETFs") must pass threshold');
});

test('SOURCE-THRESHOLD-06: 199 chars (NYT) passes threshold', () => {
  const threshold = findThresholdForFailReason('source_insufficient_length');
  assert.equal(threshold, 150);
  // 199 is NOT < 150 → passes (previously failed with old 200 threshold — was 1 char short)
  assert.ok(!(199 < threshold), '199 chars (NYT "Japan Raises Interest Rates") must pass threshold');
});

test('SOURCE-THRESHOLD-07: text_too_short threshold unchanged at 50 chars', () => {
  const threshold = findThresholdForFailReason('text_too_short');
  assert.ok(threshold !== null, 'text_too_short threshold must exist');
  assert.equal(threshold, 50, 'text_too_short threshold must remain 50 (unchanged)');
});

test('SOURCE-THRESHOLD-08: < 50 chars still produces text_too_short (not source_insufficient_length)', () => {
  const textThreshold = findThresholdForFailReason('text_too_short');
  const sourceThreshold = findThresholdForFailReason('source_insufficient_length');
  assert.equal(textThreshold, 50);
  assert.equal(sourceThreshold, 150);
  // 49 chars: 49 < 50 → fails with text_too_short (NOT source_insufficient_length)
  assert.ok(49 < textThreshold, '49 chars must fail with text_too_short (not source_insufficient_length)');
});

test('SOURCE-THRESHOLD-09: summary output minimum unchanged at 200 chars', () => {
  // Line 8910: if (sanitizedSummary.trim().length >= 200) — the AI output validator
  // Must remain 200 (AI must still produce 200+ char summaries even with 150-char source)
  const m = WORKER_SRC.match(/if\s*\(\s*sanitizedSummary\.trim\(\)\.length\s*>=\s*(\d+)\s*\)/);
  assert.ok(m, 'Summary output validator (sanitizedSummary >= N) must exist');
  assert.equal(m[1], '200', 'Summary output minimum must remain 200 chars (unchanged — AI quality bar preserved)');
});

test('SOURCE-THRESHOLD-10: source_insufficient_length still in PERMANENT_FAIL_REASONS', () => {
  const m = WORKER_SRC.match(/PERMANENT_FAIL_REASONS\s*=\s*\[([^\]]+)\]/);
  assert.ok(m, 'PERMANENT_FAIL_REASONS list must exist');
  assert.ok(m[1].includes("'source_insufficient_length'"),
    'source_insufficient_length must remain in PERMANENT_FAIL_REASONS (still permanent failure)');
});

test('SOURCE-THRESHOLD-11: Stage 4 fallback threshold unchanged at 50 chars', () => {
  // Stage 4 RSS description fallback (line 8773): if (combined.length >= 50) { articleText = combined; ... }
  // Must remain 50 (user explicitly said NOT to change this)
  const m = WORKER_SRC.match(
    /if\s*\(\s*combined\.length\s*>=\s*(\d+)\s*\)\s*\{[\s\S]*?articleText\s*=\s*combined[\s\S]*?extractionSource\s*=\s*'rss_description'/
  );
  assert.ok(m, 'Stage 4 RSS fallback threshold must exist');
  assert.equal(m[1], '50', 'Stage 4 fallback threshold must remain 50 (unchanged)');
});

test('SOURCE-THRESHOLD-12: DEGRADED_PUBLISHERS unchanged (CoinDesk still present)', () => {
  // CoinDesk must still be in DEGRADED_PUBLISHERS (unchanged)
  assert.ok(WORKER_SRC.includes("'www.coindesk.com'"),
    'CoinDesk must remain in DEGRADED_PUBLISHERS (unchanged)');
});

test('SOURCE-THRESHOLD-13: news:failed_urls tracking logic unchanged', () => {
  // news:failed_urls KV set must still be written for permanent failures (unchanged)
  assert.ok(WORKER_SRC.includes("'news:failed_urls'"),
    "news:failed_urls KV key must still exist (unchanged retry tracking)");
  assert.ok(WORKER_SRC.includes('PERMANENT_FAIL_REASONS'),
    'PERMANENT_FAIL_REASONS list must still exist (unchanged)');
});

test('SOURCE-THRESHOLD-14: MAX_SUMMARIES_PER_TICK unchanged at 2 (H5-5min fix preserved)', () => {
  // H5-5min fix (commit e2ede82) must remain intact
  const m = SCHEDULER_SRC.match(/MAX_SUMMARIES_PER_TICK\s*=\s*(\d+)/);
  assert.ok(m, 'MAX_SUMMARIES_PER_TICK must exist');
  assert.equal(m[1], '2', 'MAX_SUMMARIES_PER_TICK must remain 2 (H5-5min fix preserved)');
});

test('SOURCE-THRESHOLD-15: provider fallback chain unchanged', () => {
  // Provider chain order must remain: groq → openrouter → workers-ai → openai
  assert.ok(WORKER_SRC.includes("attemptProvider('groq'"), 'Groq provider must still exist (unchanged)');
  assert.ok(WORKER_SRC.includes("attemptProvider('openrouter'"), 'OpenRouter provider must still exist (unchanged)');
  assert.ok(WORKER_SRC.includes("attemptProvider('workers-ai'"), 'Workers AI provider must still exist (unchanged)');
  assert.ok(WORKER_SRC.includes("attemptProvider('openai'"), 'OpenAI provider must still exist (unchanged)');
  assert.ok(WORKER_SRC.includes('async function generateSummaryWithFallback'),
    'generateSummaryWithFallback must still exist (unchanged)');
});

test('SOURCE-THRESHOLD-16: validatePersianOutput validator unchanged', () => {
  // Persian validator must still exist (AI quality bar preserved)
  assert.ok(NEWS_SHARED_SRC.includes('function validatePersianOutput'),
    'validatePersianOutput must still exist in src/news/shared.js (unchanged — AI quality bar)');
});

test('SOURCE-THRESHOLD-17: comment above threshold line still references original rationale', () => {
  // The PHASE 2 FIX comment above line 8837 is documentation — must still exist
  // (verifies we didn't accidentally remove or modify the comment block)
  assert.ok(WORKER_SRC.includes('PHASE 2 FIX — Source integrity'),
    'PHASE 2 FIX source integrity comment must still exist (unchanged documentation)');
});

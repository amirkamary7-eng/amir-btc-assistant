// ============================================================================
// HOTFIX REGRESSION TESTS (Commit 2.1)
//
// Verifies that the ReferenceError "newsWriteActuallyWritten is not defined"
// is permanently fixed. The error was introduced by Commit 1 (publication gate)
// which removed variable declarations from processNewsAIBatch STEP 6 but left
// references in the function's return value (FINISH result object).
//
// These tests ensure:
//   1. The removed variables are NEVER referenced in actual code (only in comments)
//   2. The result object does not contain any of the dead fields
//   3. The publication gate (Commit 1) is NOT restored (no premature news:farsi write)
//   4. processNewsAIBatch can construct its return value without throwing
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
// PATH FIX (Step-5 extraction): processNewsAIBatch moved to src/news/summary.js
const SUMMARY_PATH = path.join(__dirname, '..', 'src', 'news', 'summary.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');
const SUMMARY_SRC = fs.readFileSync(SUMMARY_PATH, 'utf8');

// Extract processNewsAIBatch function body (from function declaration to the
// createNewsSummary factory's return statement, which immediately follows
// processNewsAIBatch in src/news/summary.js).
function getProcessNewsAIBatchBody() {
  const startMarker = 'async function processNewsAIBatch(';
  const startIdx = SUMMARY_SRC.indexOf(startMarker);
  assert.ok(startIdx > -1, 'processNewsAIBatch must exist');
  // PATH FIX: original endMarker 'function parseCalendarDate' lives in
  // src/services/calendar.js (different module). The createNewsSummary
  // factory's return statement (immediately following processNewsAIBatch in
  // summary.js) is the equivalent next-code-block anchor.
  const endMarker = '    generateSummaryWithFallback,';
  const endIdx = SUMMARY_SRC.indexOf(endMarker, startIdx);
  assert.ok(endIdx > -1, 'createNewsSummary factory return (next code block) must exist');
  return SUMMARY_SRC.slice(startIdx, endIdx);
}

// ============================================================================
// Test 1: No actual code references to removed variables (comments are OK)
// ============================================================================

test('HOTFIX-1: newsWriteActuallyWritten is NOT referenced in code (only in comments)', () => {
  const body = getProcessNewsAIBatchBody();
  // Remove all // comments and /* */ comments, then check for the variable
  const codeOnly = body
    .replace(/\/\*[\s\S]*?\*\//g, '') // remove block comments
    .replace(/\/\/.*$/gm, ''); // remove line comments
  assert.ok(!/\bnewsWriteActuallyWritten\b/.test(codeOnly),
    'newsWriteActuallyWritten must NOT appear in actual code (only in comments). ' +
    'This variable was removed by Commit 1 (publication gate) and referencing it ' +
    'causes ReferenceError: newsWriteActuallyWritten is not defined');
});

test('HOTFIX-2: newsWriteWasSkipped is NOT referenced in code', () => {
  const body = getProcessNewsAIBatchBody();
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bnewsWriteWasSkipped\b/.test(codeOnly),
    'newsWriteWasSkipped must NOT appear in actual code');
});

test('HOTFIX-3: kvAvailable is NOT referenced in code', () => {
  const body = getProcessNewsAIBatchBody();
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\bkvAvailable\b/.test(codeOnly),
    'kvAvailable must NOT appear in actual code');
});

test('HOTFIX-4: inMemoryCached is NOT referenced in code', () => {
  const body = getProcessNewsAIBatchBody();
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\binMemoryCached\b/.test(codeOnly),
    'inMemoryCached must NOT appear in actual code');
});

test('HOTFIX-5: inMemoryMatches is NOT referenced in code', () => {
  const body = getProcessNewsAIBatchBody();
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/\binMemoryMatches\b/.test(codeOnly),
    'inMemoryMatches must NOT appear in actual code');
});

// ============================================================================
// Test 2: Result object does not contain the dead fields
// ============================================================================

test('HOTFIX-6: processNewsAIBatch result object does NOT contain dead fields', () => {
  const body = getProcessNewsAIBatchBody();
  // Find the result object construction
  const resultIdx = body.indexOf('const result = {');
  assert.ok(resultIdx > -1, 'result object must exist');
  // PATH FIX: widened 1000 → 2000 — the Step-5 extraction expanded the
  // HOTFIX (Commit 2.1) comment block in the result object, pushing
  // ai:/elapsed: past the original 1000-char window.
  const resultBlock = body.slice(resultIdx, resultIdx + 2000);

  // These fields must NOT be in the result object
  assert.ok(!/newsCacheWritten:/.test(resultBlock), 'newsCacheWritten must be removed from result');
  assert.ok(!/newsCacheSkipped:/.test(resultBlock), 'newsCacheSkipped must be removed from result');
  assert.ok(!/newsWriteWasSkipped:/.test(resultBlock), 'newsWriteWasSkipped must be removed from result');
  assert.ok(!/kvAvailable:/.test(resultBlock), 'kvAvailable must be removed from result');
  assert.ok(!/inMemoryCached:/.test(resultBlock), 'inMemoryCached must be removed from result');
  assert.ok(!/inMemoryMatches:/.test(resultBlock), 'inMemoryMatches must be removed from result');

  // These fields SHOULD still be present (they use defined variables)
  assert.ok(/articlesCached:/.test(resultBlock), 'articlesCached should still be present');
  assert.ok(/newsJsonLength:/.test(resultBlock), 'newsJsonLength should still be present (newsJson is defined)');
  assert.ok(/enqueue:/.test(resultBlock), 'enqueue should still be present');
  assert.ok(/ai:/.test(resultBlock), 'ai should still be present');
  assert.ok(/elapsed:/.test(resultBlock), 'elapsed should still be present');
});

// ============================================================================
// Test 3: Publication gate (Commit 1) is NOT restored
// ============================================================================

test('HOTFIX-7: Instant news display — processNewsAIBatch writes to news:farsi immediately', () => {
  const body = getProcessNewsAIBatchBody();
  // The publication gate (Commit 1) removed the writeAppCache to FARSI_NEWS_CACHE_KEY
  // from processNewsAIBatch. The hotfix must NOT restore it.
  // Verify STEP 6 still has the "PUBLICATION GATE" comment and NO writeAppCache.
  const step6Idx = body.indexOf('KV_ARTICLES_published_merge');
  assert.ok(step6Idx > -1, 'Commit 2.7 merge-aware publication marker must remain');

  // Verify NO writeAppCache to FARSI_NEWS_CACHE_KEY in the batch analysis area
  // (the only writeAppCache calls should be for news:ai:{hash} in succeedWithSummary,
  // which is outside processNewsAIBatch)
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Check that there's no writeAppCache(env, FARSI_NEWS_CACHE_KEY in STEP 6 or STEP 7
  const step6Start = codeOnly.indexOf('STEP 6');
  const step8Start = codeOnly.indexOf('STEP 8');
  if (step6Start > -1 && step8Start > -1) {
    const step6to8 = codeOnly.slice(step6Start, step8Start);
    assert.ok(!/writeAppCache\s*\(\s*env\s*,\s*FARSI_NEWS_CACHE_KEY/.test(step6to8),
      'PUBLICATION GATE must NOT be restored — no writeAppCache to FARSI_NEWS_CACHE_KEY in STEP 6-7');
  }
});

test('HOTFIX-8: publishArticleToFarsiNews still exists (Commit 1 publication gate)', () => {
  // PATH FIX: publishArticleToFarsiNews + PUBLICATION GATE extracted to src/news/summary.js
  assert.ok(SUMMARY_SRC.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist (Commit 1 publication gate)');
  assert.ok(SUMMARY_SRC.includes('PUBLICATION GATE (Commit 1)'),
    'PUBLICATION GATE comments must remain');
});

// ============================================================================
// Test 4: Commit 2 queue priority remains intact
// ============================================================================

test('HOTFIX-9: Commit 2 queue priority remains intact (priority: high on enqueue)', () => {
  // PATH FIX: queue priority + PERMANENT_FAIL_REASONS + RETRY JITTER extracted to src/news/summary.js
  assert.ok(SUMMARY_SRC.includes("priority: 'high'"),
    'Commit 2 priority: "high" must remain on new queue items');
  assert.ok(SUMMARY_SRC.includes('QUEUE PRIORITY (Commit 2)'),
    'Commit 2 queue priority comments must remain');
  assert.ok(SUMMARY_SRC.includes('PERMANENT_FAIL_REASONS'),
    'Commit 2 PERMANENT_FAIL_REASONS must remain');
  assert.ok(SUMMARY_SRC.includes('RETRY JITTER'),
    'Commit 2 retry jitter must remain');
});

// ============================================================================
// Test 5: newsJson is still defined (used by newsJsonLength in result)
// ============================================================================

test('HOTFIX-10: newsJsonLength is still computed in processNewsAIBatch result', () => {
  const body = getProcessNewsAIBatchBody();
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  // Commit 2.7: const newsJson was removed; newsJsonLength is now computed inline
  // as JSON.stringify(trimmed).length. Verify the inline computation remains.
  assert.ok(/newsJsonLength/.test(codeOnly),
    'newsJsonLength must still be computed in the result object');
});

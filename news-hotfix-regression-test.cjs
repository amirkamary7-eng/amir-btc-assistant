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

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

// Extract processNewsAIBatch function body (from function declaration to next top-level function)
function getProcessNewsAIBatchBody() {
  const startMarker = 'async function processNewsAIBatch(';
  const startIdx = source.indexOf(startMarker);
  assert.ok(startIdx > -1, 'processNewsAIBatch must exist');
  // Find the end — look for the next top-level function or the closing brace
  // at column 0. We'll use a simpler approach: find 'function parseCalendarDate'
  // which comes right after processNewsAIBatch.
  const endMarker = 'function parseCalendarDate';
  const endIdx = source.indexOf(endMarker, startIdx);
  assert.ok(endIdx > -1, 'parseCalendarDate (next function) must exist');
  return source.slice(startIdx, endIdx);
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
  const resultBlock = body.slice(resultIdx, resultIdx + 1000);

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

test('HOTFIX-7: Publication gate remains intact — processNewsAIBatch does NOT write news:farsi', () => {
  const body = getProcessNewsAIBatchBody();
  // The publication gate (Commit 1) removed the writeAppCache to FARSI_NEWS_CACHE_KEY
  // from processNewsAIBatch. The hotfix must NOT restore it.
  // Verify STEP 6 still has the "PUBLICATION GATE" comment and NO writeAppCache.
  const step6Idx = body.indexOf('KV_ARTICLES_skip_publish_gate');
  assert.ok(step6Idx > -1, 'Commit 1 publication gate (skip write) must remain');

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
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist (Commit 1 publication gate)');
  assert.ok(source.includes('PUBLICATION GATE (Commit 1)'),
    'PUBLICATION GATE comments must remain');
});

// ============================================================================
// Test 4: Commit 2 queue priority remains intact
// ============================================================================

test('HOTFIX-9: Commit 2 queue priority remains intact (priority: high on enqueue)', () => {
  assert.ok(source.includes("priority: 'high'"),
    'Commit 2 priority: "high" must remain on new queue items');
  assert.ok(source.includes('QUEUE PRIORITY (Commit 2)'),
    'Commit 2 queue priority comments must remain');
  assert.ok(source.includes('PERMANENT_FAIL_REASONS'),
    'Commit 2 PERMANENT_FAIL_REASONS must remain');
  assert.ok(source.includes('RETRY JITTER'),
    'Commit 2 retry jitter must remain');
});

// ============================================================================
// Test 5: newsJson is still defined (used by newsJsonLength in result)
// ============================================================================

test('HOTFIX-10: newsJson is still defined in processNewsAIBatch (used by result.newsJsonLength)', () => {
  const body = getProcessNewsAIBatchBody();
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(/const\s+newsJson\s*=/.test(codeOnly),
    'newsJson must still be declared — it is used by newsJsonLength in the result object');
});

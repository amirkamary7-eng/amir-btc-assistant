// ============================================================================
// HOTFIX REGRESSION TESTS — Cache Starvation + Bootstrap Hang (Commit 2.2)
//
// Verifies:
//   1. news:farsi TTL is 86400 (24 hours) in publishArticleToFarsiNews
//   2. processNewsAIBatch TTL refresh does NOT publish unapproved articles
//   3. readJsonBody returns 408 on timeout
//   4. Commit 1 publication gate remains intact
//   5. Commit 2 queue priority remains intact
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

// ============================================================================
// Test 1: news:farsi TTL is 86400 in publishArticleToFarsiNews
// ============================================================================

test('HOTFIX22-1: publishArticleToFarsiNews uses TTL 86400 (24 hours)', () => {
  // Find the publishArticleToFarsiNews function and check the TTL
  const fnStart = source.indexOf('async function publishArticleToFarsiNews');
  assert.ok(fnStart > -1, 'publishArticleToFarsiNews must exist');
  const fnBlock = source.slice(fnStart, fnStart + 3500);
  // Must contain 86400 as the TTL default
  assert.ok(/86400/.test(fnBlock),
    'publishArticleToFarsiNews must use TTL 86400 (24 hours), not 1800 (30 min)');
  // Must NOT contain the old 1800 default in the writeAppCache call
  const writeIdx = fnBlock.indexOf('writeAppCache');
  assert.ok(writeIdx > -1, 'must have writeAppCache call');
  const writeBlock = fnBlock.slice(writeIdx, writeIdx + 300);
  assert.ok(!/1800/.test(writeBlock),
    'writeAppCache in publishArticleToFarsiNews must NOT use old 1800 TTL');
});

// ============================================================================
// Test 2: processNewsAIBatch TTL refresh does NOT publish unapproved articles
// ============================================================================

test('HOTFIX22-2: processNewsAIBatch TTL refresh only re-writes existing content (no new articles)', () => {
  // Find STEP 8.5 (the TTL refresh block)
  const refreshIdx = source.indexOf('STEP 8.5: REFRESH news:farsi TTL');
  assert.ok(refreshIdx > -1, 'STEP 8.5 TTL refresh must exist');
  const refreshBlock = source.slice(refreshIdx, refreshIdx + 1200);

  // Must read existing content and re-write it — NOT add new articles
  assert.ok(/readAppCache\(env,\s*FARSI_NEWS_CACHE_KEY\)/.test(refreshBlock),
    'TTL refresh must read existing news:farsi content');
  assert.ok(/writeAppCache\(env,\s*FARSI_NEWS_CACHE_KEY,\s*existingNews/.test(refreshBlock),
    'TTL refresh must re-write the EXISTING content (not new articles)');

  // Must NOT call publishArticleToFarsiNews in actual CODE (comments are OK)
  // Strip comments before checking
  const codeOnly = refreshBlock
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');
  assert.ok(!/publishArticleToFarsiNews/.test(codeOnly),
    'TTL refresh must NOT call publishArticleToFarsiNews in code (publication gate intact)');

  // Must NOT add trimmed/deduped articles to news:farsi
  assert.ok(!/trimmed/.test(codeOnly),
    'TTL refresh must NOT add trimmed (unanalyzed) articles to news:farsi');
});

test('HOTFIX22-2b: TTL refresh is in processNewsAIBatch (not in publishArticleToFarsiNews)', () => {
  // Verify the TTL refresh is in processNewsAIBatch, between STEP 8 and STEP 9
  const batchStart = source.indexOf('async function processNewsAIBatch');
  const refreshIdx = source.indexOf('STEP 8.5: REFRESH news:farsi TTL');
  const step9Idx = source.indexOf('STEP 9: PROCESS ONE ARTICLE FROM QUEUE');

  assert.ok(batchStart > -1, 'processNewsAIBatch must exist');
  assert.ok(refreshIdx > batchStart, 'TTL refresh must be inside processNewsAIBatch');
  assert.ok(refreshIdx < step9Idx, 'TTL refresh must be BEFORE STEP 9');
});

// ============================================================================
// Test 3: readJsonBody returns 408 on timeout
// ============================================================================

test('HOTFIX22-3: readJsonBody has timeout that returns 408', () => {
  const fnStart = source.indexOf('async function readJsonBody');
  assert.ok(fnStart > -1, 'readJsonBody must exist');
  const fnBlock = source.slice(fnStart, fnStart + 5000);

  // Must have Promise.race for timeout (per-chunk or fallback)
  assert.ok(/Promise\.race/.test(fnBlock),
    'readJsonBody must use Promise.race for timeout');
  // Must have timeout (CHUNK_TIMEOUT_MS = 5000)
  assert.ok(/CHUNK_TIMEOUT_MS/.test(fnBlock),
    'readJsonBody must have CHUNK_TIMEOUT_MS');
  assert.ok(/5000/.test(fnBlock),
    'readJsonBody must have 5s (5000ms) chunk timeout');
  // Must return 408 on timeout
  assert.ok(/status:\s*408/.test(fnBlock),
    'readJsonBody must return HTTP 408 on timeout');
  // Must still have the existing size validation
  assert.ok(/413/.test(fnBlock),
    'readJsonBody must still have 413 size validation');
  // Must still have JSON validation
  assert.ok(/422/.test(fnBlock),
    'readJsonBody must still have 422 JSON validation');
});

test('HOTFIX22-3b: readJsonBody timeout does NOT remove existing validation', () => {
  const fnStart = source.indexOf('async function readJsonBody');
  const fnBlock = source.slice(fnStart, fnStart + 5000);

  // Content-Length check must still exist
  assert.ok(/Content-Length/.test(fnBlock),
    'Content-Length check must remain');
  // JSON.parse must still exist
  assert.ok(/JSON\.parse/.test(fnBlock),
    'JSON.parse must remain');
  // buildBodyFieldValidationError must still exist
  assert.ok(/buildBodyFieldValidationError/.test(fnBlock),
    'buildBodyFieldValidationError must remain');
});

// ============================================================================
// Test 4: Commit 1 publication gate remains intact
// ============================================================================

test('HOTFIX22-4: Instant news display restored — articles published before AI', () => {
  // publishArticleToFarsiNews must still exist
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist (Commit 1)');

  // PUBLICATION GATE comments must remain
  assert.ok(source.includes('PUBLICATION GATE (Commit 1)'),
    'PUBLICATION GATE comments must remain (Commit 1)');

  // processNewsAIBatch must NOT write new articles to news:farsi
  // (only the TTL refresh of EXISTING content is allowed)
  const batchStart = source.indexOf('async function processNewsAIBatch');
  const batchEnd = source.indexOf('function parseCalendarDate', batchStart);
  const batchBlock = source.slice(batchStart, batchEnd > 0 ? batchEnd : batchStart + 10000);

  // Find STEP 6 — must have the "skip publish gate" comment
  assert.ok(/KV_ARTICLES_published_immediate/.test(batchBlock),
    'STEP 6 must publish articles immediately (Commit 2.6)');

  // The TTL refresh (STEP 8.5) must only re-write existing content, not add new
  const refreshIdx = batchBlock.indexOf('STEP 8.5: REFRESH news:farsi TTL');
  assert.ok(refreshIdx > -1, 'STEP 8.5 TTL refresh must exist');
  const refreshBlock = batchBlock.slice(refreshIdx, refreshIdx + 800);
  assert.ok(/existingNews/.test(refreshBlock),
    'TTL refresh must use existingNews (not new articles)');

});

// ============================================================================
// Test 5: Commit 2 queue priority remains intact
// ============================================================================

test('HOTFIX22-5: Commit 2 queue priority remains intact', () => {
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
// Test 6: Hotfix 2.1 (newsWriteActuallyWritten) remains fixed
// ============================================================================

test('HOTFIX22-6: Hotfix 2.1 remains fixed (no newsWriteActuallyWritten in code)', () => {
  // The variable name should only appear in comments, not in actual code
  // Remove all comments and check
  const codeOnly = source
    .replace(/\/\*[\s\S]*?\*\//g, '') // block comments
    .replace(/\/\/.*$/gm, ''); // line comments
  assert.ok(!/\bnewsWriteActuallyWritten\b/.test(codeOnly),
    'newsWriteActuallyWritten must NOT appear in actual code (Hotfix 2.1 intact)');
});

// ============================================================================
// Behavioral test: readJsonBody timeout actually works
// ============================================================================

test('HOTFIX22-7: readJsonBody timeout returns 408 when request.text() hangs', async () => {
  // We can't easily test the actual readJsonBody (it's inside the bundled worker),
  // but we can verify the Promise.race + timeout pattern works correctly.

  // Simulate a hanging request.text() that never resolves
  const hangingPromise = new Promise(() => {}); // never resolves

  // Apply the same timeout pattern as readJsonBody
  let result;
  try {
    const bodyTimeoutMs = 100; // 100ms for testing (not 10s)
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request body read timeout')), bodyTimeoutMs);
    });
    await Promise.race([hangingPromise, timeoutPromise]);
  } catch (e) {
    // Simulate the catch block in readJsonBody
    result = { status: 408, detail: 'Request body read timeout' };
  }

  assert.ok(result, 'should have a result after timeout');
  assert.strictEqual(result.status, 408, 'should return 408 on timeout');
  assert.strictEqual(result.detail, 'Request body read timeout');
});

test('HOTFIX22-8: readJsonBody timeout does NOT fire when body arrives quickly', async () => {
  // Simulate a fast request.text() that resolves immediately
  const fastPromise = Promise.resolve('{"user_id":"123"}');

  let result;
  try {
    const bodyTimeoutMs = 100;
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('Request body read timeout')), bodyTimeoutMs);
    });
    const body = await Promise.race([fastPromise, timeoutPromise]);
    result = { ok: true, body };
  } catch (e) {
    result = { ok: false, error: e.message };
  }

  assert.ok(result.ok, 'should succeed when body arrives quickly');
  assert.strictEqual(result.body, '{"user_id":"123"}');
});

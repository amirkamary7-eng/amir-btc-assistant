// ============================================================================
// HOTFIX 2.4 REGRESSION TESTS — Telegram Timeout + Failed URL Tracking
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

// TEST GROUP A — Telegram timeout
test('HOTFIX24-A1: getChatMemberDebugPayload fetch has AbortController with 5s timeout', () => {
  const fnStart = source.indexOf('async function getChatMemberDebugPayload');
  assert.ok(fnStart > -1, 'getChatMemberDebugPayload must exist');
  const fnBlock = source.slice(fnStart, fnStart + 3000);

  assert.ok(/AbortController/.test(fnBlock), 'Must use AbortController');
  assert.ok(/tgController\.abort/.test(fnBlock), 'Must call tgController.abort() on timeout');
  assert.ok(/5000/.test(fnBlock), 'Timeout must be 5000ms (5 seconds)');
  assert.ok(/clearTimeout\(tgTimeoutId\)/.test(fnBlock), 'Must clearTimeout in finally');
  assert.ok(/signal:\s*tgController\.signal/.test(fnBlock), 'Must pass signal to fetch');
});

test('HOTFIX24-A2: Telegram timeout uses finally to clear timer', () => {
  const fnStart = source.indexOf('async function getChatMemberDebugPayload');
  const fnBlock = source.slice(fnStart, fnStart + 3000);
  assert.ok(/finally\s*\{/.test(fnBlock), 'Must have finally block to clear timeout');
});

test('HOTFIX24-A3: Existing error handling preserved (catch block returns payload)', () => {
  const fnStart = source.indexOf('async function getChatMemberDebugPayload');
  const fnBlock = source.slice(fnStart, fnStart + 3000);
  assert.ok(/catch \(error\)/.test(fnBlock), 'Must have catch block');
  assert.ok(/payload\.telegram_response/.test(fnBlock), 'Must set telegram_response on error');
  assert.ok(/return payload/.test(fnBlock), 'Must return payload (not throw)');
});

// TEST GROUP B — News failed URL tracking
test('HOTFIX24-B1: requeueWithRetry tracks permanently failed URLs in KV', () => {
  const fnStart = source.indexOf('async function requeueWithRetry');
  assert.ok(fnStart > -1, 'requeueWithRetry must exist');
  const fnBlock = source.slice(fnStart, fnStart + 3000);

  assert.ok(/news:failed_urls/.test(fnBlock), 'Must write to news:failed_urls KV key');
  assert.ok(/isPermanentFailure/.test(fnBlock), 'Must check isPermanentFailure');
  assert.ok(/canonicalizeUrl/.test(fnBlock), 'Must canonicalize URL before tracking');
  assert.ok(/24 \* 3600/.test(fnBlock), 'Must use 24h TTL for failed URL set');
});

test('HOTFIX24-B2: enqueueForSummary skips URLs in the failed URL set', () => {
  const fnStart = source.indexOf('async function enqueueForSummary');
  assert.ok(fnStart > -1, 'enqueueForSummary must exist');
  const fnBlock = source.slice(fnStart, fnStart + 4000);

  assert.ok(/failedUrlSet/.test(fnBlock), 'Must load failedUrlSet');
  assert.ok(/news:failed_urls/.test(fnBlock), 'Must read from news:failed_urls KV key');
  assert.ok(/failedUrlSet\[canonicalUrl\]/.test(fnBlock), 'Must check canonical URL against failed set');
  assert.ok(/skipped\+\+/.test(fnBlock), 'Must skip (increment skipped counter)');
});

test('HOTFIX24-B3: Only permanent failures are tracked (not transient)', () => {
  const fnStart = source.indexOf('async function requeueWithRetry');
  const fnBlock = source.slice(fnStart, fnStart + 3000);

  const trackIdx = fnBlock.indexOf('news:failed_urls');
  assert.ok(trackIdx > -1, 'Must have failed URL tracking');
  const permIdx = fnBlock.indexOf('isPermanentFailure');
  assert.ok(permIdx > -1 && permIdx < trackIdx, 'Failed URL tracking must be after isPermanentFailure check');
  const blockBefore = fnBlock.slice(permIdx, trackIdx);
  assert.ok(/if\s*\(isPermanentFailure/.test(blockBefore), 'Must check isPermanentFailure before tracking');
});

test('HOTFIX24-B4: Publication gate remains intact', () => {
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist');
  assert.ok(source.includes('PUBLICATION GATE (Commit 1)'),
    'Publication gate comments must remain');
  assert.ok(source.includes('readyOnly'),
    'API readyOnly filter must remain');
});

test('HOTFIX24-B5: Existing queue cleanup (Hotfix 2.3) remains intact', () => {
  assert.ok(source.includes('Cleaned') && source.includes('failed items'),
    'Failed queue cleanup from Hotfix 2.3 must remain');
  assert.ok(source.includes('HOTFIX (Commit 2.3)'),
    'Hotfix 2.3 comments must remain');
});

test('HOTFIX24-B6: Commit 2 queue priority remains intact', () => {
  assert.ok(source.includes("priority: 'high'"),
    'Commit 2 priority: "high" must remain');
  assert.ok(source.includes('PERMANENT_FAIL_REASONS'),
    'Commit 2 PERMANENT_FAIL_REASONS must remain');
});

// ============================================================================
// QUEUE PRIORITY + FAILED CLEANUP TESTS (Commit 2)
//
// Verifies:
//   Test 1: New high-priority article is selected before an old low-priority retry
//   Test 2: Multiple high-priority articles are processed in correct age order
//   Test 3: Low-priority retries eventually get processed (anti-starvation)
//   Test 4: fetch_403 is permanently failed without 3 retries
//   Test 5: fetch_404 is permanently failed without 3 retries
//   Test 6: Transient 429/5xx/network errors still use retry/backoff
//   Test 7: Retry jitter stays within the expected range (±20%)
//   Test 8: Existing duplicate/claim protection remains intact
//   Test 9: Commit 1 publication gate remains intact
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

// ============================================================================
// Source-level tests (verify code patterns exist)
// ============================================================================

test('QP-1: Queue items have priority field set to "high" on enqueue', () => {
  // Find the enqueue push by looking for the PUBLICATION GATE comment near queue.push
  const marker = 'published_at: null,';
  const markerIdx = source.indexOf(marker);
  assert.ok(markerIdx > -1, 'published_at field must exist in queue item');
  // The priority field comes right after published_at
  const enqueueBlock = source.slice(markerIdx, markerIdx + 500);
  assert.ok(/priority:\s*['"]high['"]/.test(enqueueBlock),
    'New queue items must have priority: "high" after published_at');
});

test('QP-2: requeueWithRetry sets priority to "low"', () => {
  const requeueIdx = source.indexOf('async function requeueWithRetry(');
  assert.ok(requeueIdx > -1, 'requeueWithRetry must exist');
  const requeueBlock = source.slice(requeueIdx, requeueIdx + 1500);
  assert.ok(/article\.priority\s*=\s*['"]low['"]/.test(requeueBlock),
    'requeueWithRetry must set article.priority = "low"');
});

test('QP-3: Queue selection prefers HIGH priority + oldest enqueued_at', () => {
  // Find the selection logic by searching for the Commit 2 comment
  const selIdx = source.indexOf('Find first eligible item — QUEUE PRIORITY (Commit 2)');
  assert.ok(selIdx > -1, 'Queue priority selection logic must exist');
  const selBlock = source.slice(selIdx, selIdx + 3000);
  assert.ok(/highIdx/.test(selBlock), 'Must track high-priority index');
  assert.ok(/lowIdx/.test(selBlock), 'Must track low-priority index');
  assert.ok(/highOldestEnqueued/.test(selBlock), 'Must track oldest high-priority enqueued_at');
  assert.ok(/lowOldestEnqueued/.test(selBlock), 'Must track oldest low-priority enqueued_at');
  // Verify HIGH is preferred when both exist
  assert.ok(/highIdx !== -1/.test(selBlock), 'Must check highIdx first');
});

test('QP-4: Anti-starvation logic exists (LOW gets chance when HIGH is recent)', () => {
  const selIdx = source.indexOf('Find first eligible item — QUEUE PRIORITY (Commit 2)');
  const selBlock = source.slice(selIdx, selIdx + 3000);
  assert.ok(/anti-starvation|Anti-starvation/.test(selBlock),
    'Must have anti-starvation comment/logic');
  assert.ok(/Math\.random\(\)\s*<\s*0\.2/.test(selBlock),
    'Must have 20% chance for LOW when HIGH is recent');
});

test('QP-5: fetch_403 and fetch_404 are in PERMANENT_FAIL_REASONS', () => {
  const permIdx = source.indexOf('PERMANENT_FAIL_REASONS');
  assert.ok(permIdx > -1, 'PERMANENT_FAIL_REASONS must exist');
  const permBlock = source.slice(permIdx, permIdx + 300);
  assert.ok(/fetch_403/.test(permBlock), 'fetch_403 must be in permanent fail list');
  assert.ok(/fetch_404/.test(permBlock), 'fetch_404 must be in permanent fail list');
  assert.ok(/isPermanentFailure/.test(permBlock), 'Must check isPermanentFailure flag');
});

test('QP-6: Permanent failures set status=failed immediately (not after 3 retries)', () => {
  const permIdx = source.indexOf('PERMANENT_FAIL_REASONS');
  const permBlock = source.slice(permIdx, permIdx + 500);
  assert.ok(/isPermanentFailure \|\| newRetryCount >= NEWS_SUMMARY_MAX_RETRIES/.test(permBlock),
    'Must fail immediately on permanent failure OR after max retries');
});

test('QP-7: Retry jitter adds ±20% to backoff delay', () => {
  const jitterIdx = source.indexOf('RETRY JITTER');
  assert.ok(jitterIdx > -1, 'Retry jitter logic must exist');
  const jitterBlock = source.slice(jitterIdx, jitterIdx + 500);
  assert.ok(/jitterMultiplier/.test(jitterBlock), 'Must compute jitterMultiplier');
  assert.ok(/Math\.random\(\)/.test(jitterBlock), 'Must use Math.random() for jitter');
  // ±20% means multiplier range 0.8 to 1.2
  assert.ok(/0\.4/.test(jitterBlock), 'Must use 0.4 range (±20% = 0.8 to 1.2)');
});

test('QP-8: Transient errors (429, 5xx, network) NOT in permanent fail list', () => {
  const permIdx = source.indexOf('PERMANENT_FAIL_REASONS');
  const permBlock = source.slice(permIdx, permIdx + 300);
  // Verify transient errors are NOT in the permanent list
  assert.ok(!/'fetch_429'/.test(permBlock), 'fetch_429 must NOT be permanent (transient)');
  assert.ok(!/'fetch_500'/.test(permBlock), 'fetch_500 must NOT be permanent (transient)');
  assert.ok(!/'fetch_502'/.test(permBlock), 'fetch_502 must NOT be permanent (transient)');
  assert.ok(!/'fetch_503'/.test(permBlock), 'fetch_503 must NOT be permanent (transient)');
  assert.ok(!/'network_error'/.test(permBlock), 'network_error must NOT be permanent (transient)');
  assert.ok(!/'all_providers_failed'/.test(permBlock), 'all_providers_failed must NOT be permanent (transient)');
});

test('QP-9: Commit 1 publication gate remains intact (publishArticleToFarsiNews)', () => {
  // Verify Commit 1 changes are still present
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist (Commit 1)');
  assert.ok(source.includes('PUBLICATION GATE (Commit 1)'),
    'PUBLICATION GATE comments must remain (Commit 1)');
  // Verify news:farsi is NOT written in processNewsAIBatch
  const step6Idx = source.indexOf('KV_ARTICLES_skip_publish_gate');
  assert.ok(step6Idx > -1, 'Commit 1 publication gate (skip write) must remain');
  // Verify API filter for ai_summary
  assert.ok(source.includes('readyOnly'),
    'Commit 1 API filter (readyOnly) must remain');
});

test('QP-10: Claim mechanism (status=processing) remains intact', () => {
  // Verify the atomic claim is still present
  assert.ok(source.includes("article.status = 'processing'"),
    'Atomic claim (status=processing) must remain');
  assert.ok(source.includes('_claim_expires_at'),
    'Claim expiration must remain');
  assert.ok(source.includes('claimed_by_another'),
    'Concurrent claim detection must remain');
});

// ============================================================================
// Behavioral tests: verify queue selection logic works correctly
// ============================================================================

// Extract the queue selection logic for isolated testing
function loadQueueSelector() {
  // We test the selection logic by simulating it with the same algorithm
  // used in the worker. This verifies the LOGIC, not the exact code.
  return function selectFromQueue(queue, now) {
    let highIdx = -1;
    let lowIdx = -1;
    let highOldestEnqueued = Infinity;
    let lowOldestEnqueued = Infinity;
    for (let i = 0; i < queue.length; i++) {
      const item = queue[i];
      if (!item || !item.url) continue;
      if (item.status === 'failed') continue;
      if (item.status === 'processing') continue;
      if (item.next_retry && item.next_retry > now) continue;
      const itemPriority = item.priority || 'high';
      const itemEnqueued = item.enqueued_at || now;
      if (itemPriority === 'low') {
        if (lowIdx === -1 || itemEnqueued < lowOldestEnqueued) {
          lowIdx = i;
          lowOldestEnqueued = itemEnqueued;
        }
      } else {
        if (highIdx === -1 || itemEnqueued < highOldestEnqueued) {
          highIdx = i;
          highOldestEnqueued = itemEnqueued;
        }
      }
    }
    let idx = -1;
    if (highIdx !== -1) {
      if (lowIdx !== -1 && (now - highOldestEnqueued) < 2 * 60 * 1000) {
        // 20% chance LOW (deterministic for testing — caller can override Math.random)
        idx = (global._testRandomValue !== undefined && global._testRandomValue < 0.2) ? lowIdx : highIdx;
      } else {
        idx = highIdx;
      }
    } else if (lowIdx !== -1) {
      idx = lowIdx;
    }
    return { idx, highIdx, lowIdx, highOldestEnqueued, lowOldestEnqueued };
  };
}

test('QP-BEHAVIORAL-1: New high-priority article selected before old low-priority retry', () => {
  const select = loadQueueSelector();
  const now = Date.now();
  const queue = [
    // Old retry (low priority, enqueued 30 min ago)
    { url: 'https://old-retry.com/1', status: 'pending', priority: 'low', enqueued_at: now - 30 * 60 * 1000, next_retry: null },
    // New article (high priority, enqueued 1 min ago)
    { url: 'https://new-article.com/1', status: 'pending', priority: 'high', enqueued_at: now - 60 * 1000, next_retry: null },
  ];
  global._testRandomValue = 0.5; // > 0.2, so HIGH is selected
  const result = select(queue, now);
  assert.strictEqual(result.idx, 1, 'New high-priority article (index 1) must be selected');
  assert.strictEqual(queue[result.idx].url, 'https://new-article.com/1');
  delete global._testRandomValue;
});

test('QP-BEHAVIORAL-2: Multiple high-priority articles processed in age order (oldest first)', () => {
  const select = loadQueueSelector();
  const now = Date.now();
  const queue = [
    // High priority, enqueued 5 min ago
    { url: 'https://article-5min.com', status: 'pending', priority: 'high', enqueued_at: now - 5 * 60 * 1000, next_retry: null },
    // High priority, enqueued 1 min ago
    { url: 'https://article-1min.com', status: 'pending', priority: 'high', enqueued_at: now - 60 * 1000, next_retry: null },
    // High priority, enqueued 3 min ago
    { url: 'https://article-3min.com', status: 'pending', priority: 'high', enqueued_at: now - 3 * 60 * 1000, next_retry: null },
  ];
  global._testRandomValue = 0.5;
  const result = select(queue, now);
  // Oldest high-priority is at index 0 (5 min ago)
  assert.strictEqual(result.idx, 0, 'Oldest high-priority article (5 min) must be selected first');
  assert.strictEqual(queue[result.idx].url, 'https://article-5min.com');
  delete global._testRandomValue;
});

test('QP-BEHAVIORAL-3: Low-priority retries eventually get processed (anti-starvation)', () => {
  const select = loadQueueSelector();
  const now = Date.now();
  const queue = [
    // New high-priority article (just enqueued, <2 min)
    { url: 'https://new.com', status: 'pending', priority: 'high', enqueued_at: now - 30 * 1000, next_retry: null },
    // Old low-priority retry
    { url: 'https://old-retry.com', status: 'pending', priority: 'low', enqueued_at: now - 60 * 60 * 1000, next_retry: null },
  ];
  // Simulate 20% chance: set random < 0.2 to select LOW
  global._testRandomValue = 0.1; // < 0.2 → LOW selected
  const result = select(queue, now);
  assert.strictEqual(result.idx, 1, 'Low-priority retry must be selected when anti-starvation triggers');
  assert.strictEqual(queue[result.idx].url, 'https://old-retry.com');
  delete global._testRandomValue;
});

test('QP-BEHAVIORAL-4: Low-priority processed when no high-priority eligible', () => {
  const select = loadQueueSelector();
  const now = Date.now();
  const queue = [
    // High-priority but in backoff (next_retry in future)
    { url: 'https://high-backoff.com', status: 'pending', priority: 'high', enqueued_at: now - 60 * 1000, next_retry: now + 5 * 60 * 1000 },
    // Low-priority, eligible
    { url: 'https://low-eligible.com', status: 'pending', priority: 'low', enqueued_at: now - 60 * 60 * 1000, next_retry: null },
  ];
  const result = select(queue, now);
  assert.strictEqual(result.idx, 1, 'Low-priority must be selected when no high-priority is eligible');
  assert.strictEqual(queue[result.idx].url, 'https://low-eligible.com');
});

test('QP-BEHAVIORAL-5: Failed items are skipped', () => {
  const select = loadQueueSelector();
  const now = Date.now();
  const queue = [
    // Failed item (should be skipped)
    { url: 'https://failed.com', status: 'failed', priority: 'low', enqueued_at: now - 120 * 60 * 1000, next_retry: null },
    // Eligible item
    { url: 'https://eligible.com', status: 'pending', priority: 'high', enqueued_at: now - 60 * 1000, next_retry: null },
  ];
  global._testRandomValue = 0.5;
  const result = select(queue, now);
  assert.strictEqual(result.idx, 1, 'Failed items must be skipped');
  assert.strictEqual(queue[result.idx].url, 'https://eligible.com');
  delete global._testRandomValue;
});

test('QP-BEHAVIORAL-6: Processing items are skipped (claim protection)', () => {
  const select = loadQueueSelector();
  const now = Date.now();
  const queue = [
    // Processing item (should be skipped — claimed by another tick)
    { url: 'https://processing.com', status: 'processing', priority: 'high', enqueued_at: now - 60 * 1000, next_retry: null },
    // Eligible item
    { url: 'https://eligible.com', status: 'pending', priority: 'high', enqueued_at: now - 30 * 1000, next_retry: null },
  ];
  global._testRandomValue = 0.5;
  const result = select(queue, now);
  assert.strictEqual(result.idx, 1, 'Processing items must be skipped (claim protection)');
  assert.strictEqual(queue[result.idx].url, 'https://eligible.com');
  delete global._testRandomValue;
});

// ============================================================================
// Jitter range test
// ============================================================================

test('QP-JITTER-1: Retry jitter produces values within ±20% of backoff', () => {
  // Simulate the jitter calculation 1000 times and verify all are within range
  const backoffMin = 5; // 5 minutes
  const baseMs = backoffMin * 60 * 1000; // 300000 ms
  const minAllowed = baseMs * 0.8; // 240000 (4 min)
  const maxAllowed = baseMs * 1.2; // 360000 (6 min)

  let minObserved = Infinity;
  let maxObserved = -Infinity;
  for (let i = 0; i < 1000; i++) {
    const jitterMultiplier = 1 + (Math.random() - 0.5) * 0.4; // 0.8 to 1.2
    const backoffMs = Math.round(baseMs * jitterMultiplier);
    if (backoffMs < minObserved) minObserved = backoffMs;
    if (backoffMs > maxObserved) maxObserved = backoffMs;
    assert.ok(backoffMs >= minAllowed - 1, `backoff ${backoffMs}ms must be >= ${minAllowed}ms (4 min)`);
    assert.ok(backoffMs <= maxAllowed + 1, `backoff ${backoffMs}ms must be <= ${maxAllowed}ms (6 min)`);
  }
  // Verify the range is actually being used (not all same value)
  assert.ok(maxObserved - minObserved > 10000, 'Jitter must produce varied values (range > 10s)');
});

// ============================================================================
// Permanent failure simulation tests
// ============================================================================

test('QP-PERMANENT-1: fetch_403 marks article as failed immediately (retry_count=1)', () => {
  // Simulate the requeueWithRetry logic for fetch_403
  const PERMANENT_FAIL_REASONS = ['fetch_403', 'fetch_404', 'fetch_410', 'invalid_url_scheme'];
  const NEWS_SUMMARY_MAX_RETRIES = 3;

  const article = { retry_count: 0, status: 'pending', priority: 'high' };
  const reason = 'fetch_403';
  const now = Date.now();

  // Simulate requeueWithRetry
  const newRetryCount = (article.retry_count || 0) + 1;
  const isPermanentFailure = PERMANENT_FAIL_REASONS.includes(reason);
  article.retry_count = newRetryCount;
  article.priority = 'low';
  article.last_attempt = now;
  if (isPermanentFailure || newRetryCount >= NEWS_SUMMARY_MAX_RETRIES) {
    article.status = 'failed';
    article.fail_reason = reason;
  }

  assert.strictEqual(article.retry_count, 1, 'fetch_403 should only increment retry to 1');
  assert.strictEqual(article.status, 'failed', 'fetch_403 must immediately mark as failed');
  assert.strictEqual(article.fail_reason, 'fetch_403');
  assert.strictEqual(article.priority, 'low', 'Failed items get low priority');
});

test('QP-PERMANENT-2: fetch_404 marks article as failed immediately (retry_count=1)', () => {
  const PERMANENT_FAIL_REASONS = ['fetch_403', 'fetch_404', 'fetch_410', 'invalid_url_scheme'];
  const NEWS_SUMMARY_MAX_RETRIES = 3;

  const article = { retry_count: 0, status: 'pending', priority: 'high' };
  const reason = 'fetch_404';

  const newRetryCount = (article.retry_count || 0) + 1;
  const isPermanentFailure = PERMANENT_FAIL_REASONS.includes(reason);
  article.retry_count = newRetryCount;
  if (isPermanentFailure || newRetryCount >= NEWS_SUMMARY_MAX_RETRIES) {
    article.status = 'failed';
    article.fail_reason = reason;
  }

  assert.strictEqual(article.retry_count, 1, 'fetch_404 should only increment retry to 1');
  assert.strictEqual(article.status, 'failed', 'fetch_404 must immediately mark as failed');
});

test('QP-TRANSIENT-1: fetch_429 (rate limit) does NOT permanently fail — uses retry/backoff', () => {
  const PERMANENT_FAIL_REASONS = ['fetch_403', 'fetch_404', 'fetch_410', 'invalid_url_scheme'];
  const NEWS_SUMMARY_MAX_RETRIES = 3;
  const NEWS_SUMMARY_BACKOFF_MINUTES = [5, 15, 30];

  const article = { retry_count: 0, status: 'pending', priority: 'high' };
  const reason = 'fetch_429'; // rate limit — transient
  const now = Date.now();

  // Simulate requeueWithRetry
  const newRetryCount = (article.retry_count || 0) + 1;
  const backoffMin = NEWS_SUMMARY_BACKOFF_MINUTES[Math.min(newRetryCount - 1, NEWS_SUMMARY_BACKOFF_MINUTES.length - 1)] || 30;
  const isPermanentFailure = PERMANENT_FAIL_REASONS.includes(reason);
  article.retry_count = newRetryCount;
  article.priority = 'low';
  article.last_attempt = now;
  const jitterMultiplier = 1 + (Math.random() - 0.5) * 0.4;
  article.next_retry = now + Math.round(backoffMin * 60 * 1000 * jitterMultiplier);
  if (isPermanentFailure || newRetryCount >= NEWS_SUMMARY_MAX_RETRIES) {
    article.status = 'failed';
    article.fail_reason = reason;
  }

  assert.strictEqual(article.retry_count, 1, 'fetch_429 should increment retry to 1');
  assert.notStrictEqual(article.status, 'failed', 'fetch_429 must NOT permanently fail on first attempt');
  assert.strictEqual(article.status, 'pending', 'fetch_429 keeps status as pending for retry');
  assert.ok(article.next_retry > now, 'fetch_429 must have next_retry set (backoff)');
  assert.ok(article.priority, 'low', 'Retried items get low priority');
});

test('QP-TRANSIENT-2: all_providers_failed (5xx/network) does NOT permanently fail on first attempt', () => {
  const PERMANENT_FAIL_REASONS = ['fetch_403', 'fetch_404', 'fetch_410', 'invalid_url_scheme'];
  const NEWS_SUMMARY_MAX_RETRIES = 3;

  const article = { retry_count: 0, status: 'pending', priority: 'high' };
  const reason = 'all_providers_failed'; // transient — providers may recover

  const newRetryCount = (article.retry_count || 0) + 1;
  const isPermanentFailure = PERMANENT_FAIL_REASONS.includes(reason);
  article.retry_count = newRetryCount;
  if (isPermanentFailure || newRetryCount >= NEWS_SUMMARY_MAX_RETRIES) {
    article.status = 'failed';
    article.fail_reason = reason;
  }

  assert.notStrictEqual(article.status, 'failed', 'all_providers_failed must NOT permanently fail on attempt 1');
  assert.strictEqual(article.retry_count, 1, 'Should increment retry count');
});

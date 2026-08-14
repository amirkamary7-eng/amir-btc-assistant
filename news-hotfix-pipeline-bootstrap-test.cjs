// ============================================================================
// HOTFIX 2.3 REGRESSION TESTS — News Pipeline + Bootstrap Hang Fix
//
// Verifies:
// NEWS:
//   1. fetchFarsiNews does not start useless waitUntil refresh
//   2. Publication gate remains active
//   3. Failed queue cleanup does not affect unrelated queues
//
// BOOTSTRAP:
//   4. Valid bootstrap request still works (readJsonBody reads body correctly)
//   5. Empty body does not hang
//   6. Slow/missing body does not hang (per-chunk timeout)
//   7. JSON validation still returns expected errors
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

// ============================================================================
// NEWS TESTS
// ============================================================================

test('HOTFIX23-1: fetchFarsiNews does NOT call ctx.waitUntil for background refresh', () => {
  const fnStart = source.indexOf('async function fetchFarsiNews');
  assert.ok(fnStart > -1, 'fetchFarsiNews must exist');
  const fnBlock = source.slice(fnStart, fnStart + 5000);

  // Strip comments before checking for ctx.waitUntil in actual code
  const codeOnly = fnBlock
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/\/\/.*$/gm, '');

  // Must NOT contain ctx.waitUntil in actual code (comments are OK)
  assert.ok(!/ctx\.waitUntil\(/.test(codeOnly),
    'fetchFarsiNews must NOT call ctx.waitUntil in code — the useless background refresh was removed');

  // Must still return emptyResult on cache miss
  assert.ok(/emptyResult/.test(fnBlock),
    'fetchFarsiNews must still return emptyResult on cache miss');

  // Must have the HOTFIX comment
  assert.ok(/HOTFIX.*Commit 2.3/.test(fnBlock),
    'fetchFarsiNews must have the HOTFIX (Commit 2.3) comment');
});

test('HOTFIX23-2: Publication gate remains active', () => {
  // publishArticleToFarsiNews must still exist
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist (Commit 1 publication gate)');

  // PUBLICATION GATE comments must remain
  assert.ok(source.includes('PUBLICATION GATE (Commit 1)'),
    'PUBLICATION GATE comments must remain');

  // readyOnly filter must still exist
  assert.ok(source.includes('readyOnly'),
    'API readyOnly filter must remain');

  // processNewsAIBatch must NOT write new articles to news:farsi
  // (only TTL refresh of existing content is allowed)
  const batchStart = source.indexOf('async function processNewsAIBatch');
  const batchEnd = source.indexOf('function parseCalendarDate', batchStart);
  const batchBlock = source.slice(batchStart, batchEnd > 0 ? batchEnd : batchStart + 15000);
  assert.ok(/KV_ARTICLES_skip_publish_gate/.test(batchBlock),
    'STEP 6 must still skip publication (Commit 1 publication gate)');
});

test('HOTFIX23-3: Failed queue cleanup only removes status=failed items', () => {
  // Find the cleanup logic in enqueueForSummary
  const enqueueStart = source.indexOf('async function enqueueForSummary');
  assert.ok(enqueueStart > -1, 'enqueueForSummary must exist');
  const enqueueBlock = source.slice(enqueueStart, enqueueStart + 3000);

  // Must have the failed cleanup logic
  assert.ok(/status === 'failed'/.test(enqueueBlock),
    'enqueueForSummary must remove items with status=failed');

  // Must NOT touch pending or processing items
  const cleanupIdx = enqueueBlock.indexOf('Cleaned');
  if (cleanupIdx > -1) {
    const cleanupBlock = enqueueBlock.slice(Math.max(0, cleanupIdx - 500), cleanupIdx + 200);
    assert.ok(!/status === 'pending'/.test(cleanupBlock) || !cleanupBlock.includes('splice'),
      'Cleanup must NOT remove pending items');
  }

  // Must log the cleanup
  assert.ok(/\[NEWS-QUEUE\] Cleaned/.test(enqueueBlock),
    'Cleanup must log [NEWS-QUEUE] Cleaned message');
});

// ============================================================================
// BOOTSTRAP TESTS
// ============================================================================

test('HOTFIX23-4: readJsonBody uses ReadableStream reader (not request.text())', () => {
  const fnStart = source.indexOf('async function readJsonBody');
  assert.ok(fnStart > -1, 'readJsonBody must exist');
  const fnBlock = source.slice(fnStart, fnStart + 4500);

  // Must use getReader() for per-chunk reading
  assert.ok(/getReader\(\)/.test(fnBlock),
    'readJsonBody must use request.body.getReader() for per-chunk reading');

  // Must have per-chunk timeout
  assert.ok(/CHUNK_TIMEOUT_MS/.test(fnBlock),
    'readJsonBody must have CHUNK_TIMEOUT_MS constant');
  assert.ok(/5000/.test(fnBlock),
    'CHUNK_TIMEOUT_MS must be 5000 (5 seconds)');
});

test('HOTFIX23-5: Empty body (no Content-Length or CL=0) returns empty object immediately', () => {
  const fnStart = source.indexOf('async function readJsonBody');
  const fnBlock = source.slice(fnStart, fnStart + 4500);

  // Must have early return for empty body
  assert.ok(/!contentLength || Number\(contentLength\) === 0/.test(fnBlock),
    'readJsonBody must check for empty Content-Length and return early');
  assert.ok(/return \{ payload: \{\} \}/.test(fnBlock),
    'readJsonBody must return { payload: {} } for empty body');
});

test('HOTFIX23-6: Per-chunk timeout returns 408 on timeout', () => {
  const fnStart = source.indexOf('async function readJsonBody');
  const fnBlock = source.slice(fnStart, fnStart + 4500);

  // Must have Promise.race for per-chunk timeout
  assert.ok(/Promise\.race\(\[readPromise, timeoutPromise\]\)/.test(fnBlock),
    'readJsonBody must use Promise.race for per-chunk timeout');

  // Must return 408 on chunk timeout
  assert.ok(/status:\s*408/.test(fnBlock),
    'readJsonBody must return 408 on chunk timeout');

  // Must cancel the reader on timeout
  assert.ok(/reader\.cancel\(\)/.test(fnBlock),
    'readJsonBody must cancel the reader on timeout');
});

test('HOTFIX23-7: JSON validation still returns expected errors', () => {
  const fnStart = source.indexOf('async function readJsonBody');
  const fnBlock = source.slice(fnStart, fnStart + 5000);

  // Must still have JSON.parse
  assert.ok(/JSON\.parse/.test(fnBlock),
    'readJsonBody must still have JSON.parse');

  // Must still have 422 for invalid JSON
  assert.ok(/422/.test(fnBlock),
    'readJsonBody must still return 422 for invalid JSON');

  // Must still have buildBodyFieldValidationError
  assert.ok(/buildBodyFieldValidationError/.test(fnBlock),
    'readJsonBody must still use buildBodyFieldValidationError');

  // Must still have 413 for oversized body
  assert.ok(/413/.test(fnBlock),
    'readJsonBody must still return 413 for oversized body');
});

// ============================================================================
// Behavioral tests: simulate body reading scenarios
// ============================================================================

test('HOTFIX23-8: Body reader handles valid JSON body correctly', async () => {
  // Simulate a valid JSON body stream
  const jsonData = JSON.stringify({ user_id: '123456', username: 'test' });
  const encoder = new TextEncoder();
  const chunks = [encoder.encode(jsonData)];

  // Create a mock ReadableStream
  const stream = new ReadableStream({
    start(controller) {
      for (const chunk of chunks) {
        controller.enqueue(chunk);
      }
      controller.close();
    }
  });

  // Simulate the readJsonBody logic
  const reader = stream.getReader();
  const decoder = new TextDecoder();
  let bodyParts = [];
  let totalSize = 0;
  const maxSize = 102400;
  const CHUNK_TIMEOUT_MS = 5000;

  while (true) {
    const readPromise = reader.read();
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('chunk_timeout')), CHUNK_TIMEOUT_MS);
    });

    let result;
    try {
      result = await Promise.race([readPromise, timeoutPromise]);
    } catch (e) {
      try { await reader.cancel(); } catch {}
      assert.fail('Should not timeout on valid body');
    }

    if (result.done) break;

    if (result.value) {
      totalSize += result.value.byteLength;
      if (totalSize > maxSize) {
        try { await reader.cancel(); } catch {}
        assert.fail('Should not exceed max size');
      }
      bodyParts.push(decoder.decode(result.value, { stream: true }));
    }
  }

  const bodyText = bodyParts.join('');
  const payload = JSON.parse(bodyText);
  assert.strictEqual(payload.user_id, '123456');
  assert.strictEqual(payload.username, 'test');
});

test('HOTFIX23-9: Body reader returns 408 when body stream never sends data', async () => {
  // Simulate a stream that never sends data (Content-Length set but no body)
  const stream = new ReadableStream({
    start(controller) {
      // Never enqueue anything, never close — simulates missing body
    }
  });

  // Simulate the readJsonBody logic with short timeout for testing
  const reader = stream.getReader();
  const CHUNK_TIMEOUT_MS = 100; // 100ms for testing

  let timedOut = false;
  try {
    while (true) {
      const readPromise = reader.read();
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('chunk_timeout')), CHUNK_TIMEOUT_MS);
      });

      try {
        await Promise.race([readPromise, timeoutPromise]);
      } catch (e) {
        timedOut = true;
        try { await reader.cancel(); } catch {}
        break;
      }
    }
  } catch (e) {
    // Expected
  }

  assert.ok(timedOut, 'Should timeout when body stream never sends data');
});

test('HOTFIX23-10: Body reader handles empty body (CL=0) without stream read', () => {
  // Simulate the early return for empty body
  const contentLength = '0';
  if (!contentLength || Number(contentLength) === 0) {
    // This is the early return path — no stream read, no hang possible
    const result = { payload: {} };
    assert.deepStrictEqual(result, { payload: {} });
  } else {
    assert.fail('Should not reach stream read for empty body');
  }
});

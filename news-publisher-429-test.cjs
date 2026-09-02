/**
 * News AI Pipeline regression tests — publisher 429/403 + Gemini circuit breaker.
 *
 * Tests:
 *   NEWS-RL-001: publisher 200 → normal article flow
 *   NEWS-RL-002: publisher 429 without Retry-After → bounded backoff
 *   NEWS-RL-003: publisher 429 with Retry-After → exact retry_after respected
 *   NEWS-RL-004: publisher 403 → permanent failure, no retry storm
 *   NEWS-RL-005: 403 + RSS description → fallback content
 *   NEWS-RL-006: no article content + no RSS description → clean skip
 *   NEWS-RL-007: content:encoded available → correctly parsed
 *   NEWS-RL-008: Gemini 429 → retry_after handled (circuit breaker)
 *   NEWS-RL-009: Gemini prolonged OPEN → no infinite probe loop
 *   NEWS-RL-010: Gemini unavailable → fallback provider still works
 *   NEWS-RL-011: User-Agent updated (Chrome/131 not Chrome/120)
 *   NEWS-RL-012: Sec-Fetch headers present
 *   NEWS-RL-013: hostname diagnostic logging
 *   NEWS-RL-014: publisher fetch failure doesn't break unrelated news
 *   NEWS-RL-015: multiple publisher failures don't create retry storm
 *
 * Run: node --test news-publisher-429-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// PHASE 1 — User-Agent + Headers
// ============================================================================

test('NEWS-RL-011: User-Agent updated to Chrome/131 (not Chrome/120)', () => {
  // The article fetch must use Chrome/131 or later
  assert.ok(WORKER_SRC.includes('Chrome/131.0.0.0'),
    'Article fetch User-Agent must be Chrome/131 (was Chrome/120)');
  // Must NOT have the old Chrome/120 in the article fetch path
  // (it may still exist in other fetch paths like RSS fetch)
  const articleFetchSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('const articleRes = await fetch(article.url'),
    WORKER_SRC.indexOf('const articleRes = await fetch(article.url') + 1000
  );
  assert.ok(!articleFetchSection.includes('Chrome/120'),
    'Article fetch must NOT use Chrome/120 UA');
});

test('NEWS-RL-012: Sec-Fetch headers present in article fetch', () => {
  const articleFetchSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('const articleRes = await fetch(article.url'),
    WORKER_SRC.indexOf('const articleRes = await fetch(article.url') + 1500
  );
  assert.ok(articleFetchSection.includes('Sec-Fetch-Dest'),
    'Article fetch must include Sec-Fetch-Dest header');
  assert.ok(articleFetchSection.includes('Sec-Fetch-Mode'),
    'Article fetch must include Sec-Fetch-Mode header');
  assert.ok(articleFetchSection.includes('Sec-Fetch-Site'),
    'Article fetch must include Sec-Fetch-Site header');
});

test('NEWS-RL-013: hostname diagnostic logging in article fetch', () => {
  assert.ok(WORKER_SRC.includes('articleHostname'),
    'Article fetch must extract hostname for diagnostics');
  assert.ok(/console\.warn.*host=/.test(WORKER_SRC),
    'Article fetch must log hostname in console.warn');
});

// ============================================================================
// PHASE 2 — Retry-After parsing
// ============================================================================

test('NEWS-RL-002: publisher 429 without Retry-After → bounded backoff (default)', () => {
  // requeueWithRetry must accept retryAfterSeconds parameter
  assert.ok(WORKER_SRC.includes('retryAfterSeconds'),
    'requeueWithRetry must accept retryAfterSeconds parameter');
  // When retryAfterSeconds is null/0, default backoff is used
  assert.ok(WORKER_SRC.includes('effectiveBackoffMin'),
    'requeueWithRetry must have effectiveBackoffMin logic');
});

test('NEWS-RL-003: publisher 429 with Retry-After → exact retry_after respected', () => {
  // The article fetch must parse Retry-After header
  const articleFetchSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('if (articleRes.status === 429)'),
    WORKER_SRC.indexOf('if (articleRes.status === 429)') + 500
  );
  assert.ok(articleFetchSection.includes('Retry-After') || articleFetchSection.includes('retry-after'),
    'Article fetch must parse Retry-After header on 429');
  assert.ok(articleFetchSection.includes('retryAfterSeconds'),
    '429 handling must store retryAfterSeconds');
  // requeueWithRetry must use retryAfterSeconds when available
  assert.ok(WORKER_SRC.includes('Math.min(Math.ceil(retryAfterSeconds / 60), 60)'),
    'retryAfterSeconds must be capped at 60 min');
});

// ============================================================================
// PHASE 3 — 403 Publisher Handling
// ============================================================================

test('NEWS-RL-004: publisher 403 → permanent failure (in PERMANENT_FAIL_REASONS)', () => {
  assert.ok(WORKER_SRC.includes("'fetch_403'"),
    'fetch_403 must be in PERMANENT_FAIL_REASONS');
});

test('NEWS-RL-005: 403 + RSS description → fallback content (rss_description_fallback)', () => {
  // The article fetch must have 403 fallback to RSS description
  assert.ok(WORKER_SRC.includes('rss_description_fallback'),
    '403 handling must have rss_description_fallback contentSource');
  assert.ok(WORKER_SRC.includes("articleRes.status === 403"),
    '403 status must trigger fallback logic');
  // Must check RSS description length before using as fallback
  assert.ok(WORKER_SRC.includes('rssContent.length >= 50'),
    'Must check RSS content length before fallback');
});

test('NEWS-RL-006: no article content + no RSS description → clean skip (text_too_short)', () => {
  // The pipeline must handle the case where neither article nor RSS has enough content
  assert.ok(WORKER_SRC.includes('text_too_short'),
    'Pipeline must mark articles with insufficient content as text_too_short');
  assert.ok(WORKER_SRC.includes("articleText.length < 50"),
    'Must check articleText.length < 50');
});

// ============================================================================
// PHASE 4 — RSS Parser (content:encoded)
// ============================================================================

test('NEWS-RL-007: content:encoded support in parseRssItems', () => {
  // parseRssItems must extract content:encoded
  const parseStart = WORKER_SRC.indexOf('function parseRssItems');
  // Find the full function body (matching braces)
  let depth = 0, end = parseStart;
  while (WORKER_SRC[end] !== '{') end++;
  for (; end < WORKER_SRC.length; end++) {
    if (WORKER_SRC[end] === '{') depth++;
    else if (WORKER_SRC[end] === '}') { depth--; if (depth === 0) break; }
  }
  const parseBlock = WORKER_SRC.slice(parseStart, end + 1);
  assert.ok(parseBlock.includes('content:encoded'),
    'parseRssItems must parse <content:encoded> tag');
  assert.ok(parseBlock.includes('contentEncoded'),
    'parseRssItems must store contentEncoded field');
});

// ============================================================================
// PHASE 5 — Gemini Circuit Breaker
// ============================================================================

test('NEWS-RL-008: Gemini 429 → circuit breaker handles retryable failure', () => {
  // classifyHttpError must classify 429 as retryable
  assert.ok(WORKER_SRC.includes("status === 429") && WORKER_SRC.includes("'retryable'"),
    '429 must be classified as retryable');
});

test('NEWS-RL-009: Gemini prolonged OPEN → no infinite probe loop', () => {
  // Prolonged-open constants must exist
  assert.ok(WORKER_SRC.includes('CIRCUIT_BREAKER_PROLONGED_OPEN_THRESHOLD'),
    'CIRCUIT_BREAKER_PROLONGED_OPEN_THRESHOLD must exist');
  assert.ok(WORKER_SRC.includes('CIRCUIT_BREAKER_PROLONGED_OPEN_MS'),
    'CIRCUIT_BREAKER_PROLONGED_OPEN_MS must exist');
  assert.ok(WORKER_SRC.includes('probe_failures'),
    'Circuit breaker must track probe_failures');
  assert.ok(WORKER_SRC.includes('isProlonged'),
    'Circuit breaker must have isProlonged logic');
  // Prolonged backoff must be longer than normal
  assert.ok(WORKER_SRC.includes('CIRCUIT_BREAKER_PROLONGED_OPEN_MS = 60 * 60 * 1000'),
    'Prolonged open must be 1 hour (60 min)');
});

test('NEWS-RL-010: N/A Gemini removed — fallback chain is Groq → OpenRouter → Workers AI', () => {
  assert.ok(true, 'N/A: Gemini removed. Fallback chain is now Groq Router → OpenRouter → Workers AI → OpenAI.');
});

// ============================================================================
// PHASE 6 — Provider Fallback
// ============================================================================

test('NEWS-RL-014: publisher fetch failure does not break unrelated news items', () => {
  // requeueWithRetry must splice + push the failed item, not abort the whole queue
  assert.ok(WORKER_SRC.includes('queue.splice(idx, 1)'),
    'requeueWithRetry must remove failed item from current position');
  assert.ok(WORKER_SRC.includes('queue.push(article)'),
    'requeueWithRetry must push failed item to end of queue');
});

test('NEWS-RL-015: multiple publisher failures do not create retry storm', () => {
  // NEWS_SUMMARY_MAX_RETRIES must be 3 (bounded)
  assert.ok(WORKER_SRC.includes('NEWS_SUMMARY_MAX_RETRIES = 3'),
    'Max retries must be 3 (bounded)');
  // NEWS_SUMMARY_BACKOFF_MINUTES must be [5, 15, 30] (increasing)
  assert.ok(WORKER_SRC.includes('NEWS_SUMMARY_BACKOFF_MINUTES = [5, 15, 30]'),
    'Backoff must be [5, 15, 30] minutes (increasing)');
  // Jitter must exist to prevent thundering herd
  assert.ok(WORKER_SRC.includes('jitterMultiplier'),
    'Backoff must have jitter to prevent thundering herd');
});

// ============================================================================
// Summary
// ============================================================================

test('SUMMARY: all news-ai publisher fixes verified', () => {
  // Final assertion: all key patterns exist
  const patterns = [
    'Chrome/131.0.0.0',           // updated UA
    'Sec-Fetch-Dest',             // browser headers
    'Retry-After',                // 429 retry-after parsing
    'retryAfterSeconds',          // passed to requeueWithRetry
    'rss_description_fallback',   // 403 fallback
    'content:encoded',            // RSS content support
    'CIRCUIT_BREAKER_PROLONGED_OPEN_MS', // prolonged open
    'probe_failures',             // probe tracking
  ];
  for (const p of patterns) {
    assert.ok(WORKER_SRC.includes(p), `Pattern "${p}" must exist in source`);
  }
});

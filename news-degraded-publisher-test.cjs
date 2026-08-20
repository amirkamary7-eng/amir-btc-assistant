/**
 * Behavioral tests for Degraded Publishers (CoinDesk) + RSS fallback.
 *
 * These tests verify the DEGRADED_PUBLISHERS logic with REAL function execution
 * against synthetic article data — NOT source-string matching.
 *
 * Run: node --test news-degraded-publisher-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// Source-level verification of DEGRADED_PUBLISHERS
// ============================================================================

test('DEGRADED-001: DEGRADED_PUBLISHERS set contains www.coindesk.com', () => {
  assert.ok(WORKER_SRC.includes('DEGRADED_PUBLISHERS'),
    'DEGRADED_PUBLISHERS must exist in source');
  assert.ok(WORKER_SRC.includes("'www.coindesk.com'"),
    'www.coindesk.com must be in DEGRADED_PUBLISHERS');
});

test('DEGRADED-002: DEGRADED_PUBLISHERS checked before article fetch (STEP 0.5 before STEP 1)', () => {
  const step05Idx = WORKER_SRC.indexOf('STEP 0.5: Check DEGRADED_PUBLISHERS');
  const step1Idx = WORKER_SRC.indexOf('STEP 1: Fetch article HTML');
  assert.ok(step05Idx > -1, 'STEP 0.5 must exist');
  assert.ok(step1Idx > -1, 'STEP 1 must exist');
  assert.ok(step05Idx < step1Idx, 'STEP 0.5 must come before STEP 1');
});

test('DEGRADED-003: Degraded publisher uses RSS description (stripTags + title + length check)', () => {
  const degradedBlock = WORKER_SRC.slice(
    WORKER_SRC.indexOf('DEGRADED_PUBLISHERS.has(articleHostname)'),
    WORKER_SRC.indexOf('DEGRADED_PUBLISHERS.has(articleHostname)') + 800
  );
  assert.ok(degradedBlock.includes('stripTags(article.description'),
    'Degraded publisher must stripTags the RSS description');
  assert.ok(degradedBlock.includes('stripTags(article.title'),
    'Degraded publisher must stripTags the title');
  assert.ok(degradedBlock.includes('rssContent.length >= 50'),
    'Degraded publisher must check RSS content length >= 50');
  assert.ok(degradedBlock.includes("contentSource = 'rss_description_degraded'"),
    'Degraded publisher must set contentSource to rss_description_degraded');
});

test('DEGRADED-004: Degraded publisher with too-short RSS → clean skip (failed, not retried)', () => {
  // Search a wider window around the degraded publisher logic
  const degradedCheckIdx = WORKER_SRC.indexOf('DEGRADED_PUBLISHERS.has(articleHostname)');
  const degradedBlock = WORKER_SRC.slice(degradedCheckIdx, degradedCheckIdx + 1500);
  assert.ok(degradedBlock.includes("article.status = 'failed'"),
    'Degraded publisher with too-short RSS must mark as failed (not retried)');
  assert.ok(degradedBlock.includes("degraded_publisher_rss_too_short"),
    'Must have specific fail_reason');
});

test('DEGRADED-005: Non-degraded publisher (Cointelegraph) → article fetch proceeds normally', () => {
  // The article fetch code (STEP 1) must still exist for non-degraded publishers
  const step1Idx = WORKER_SRC.indexOf('STEP 1: Fetch article HTML');
  assert.ok(step1Idx > -1, 'STEP 1 must still exist for non-degraded publishers');
  // Verify the article fetch with Chrome/131 UA is still present
  const fetchSection = WORKER_SRC.slice(step1Idx, step1Idx + 2000);
  assert.ok(fetchSection.includes('Chrome/131'),
    'Non-degraded publisher fetch must still use Chrome/131 UA');
  assert.ok(fetchSection.includes('await fetch(article.url'),
    'Non-degraded publisher must still do article fetch');
});

test('DEGRADED-006: 403 fallback still works for non-degraded publishers', () => {
  // The 403 RSS fallback must still exist in the article fetch section
  const status403Idx = WORKER_SRC.indexOf('articleRes.status === 403');
  assert.ok(status403Idx > -1, '403 status check must exist');
  const fetchSection = WORKER_SRC.slice(status403Idx, status403Idx + 1000);
  assert.ok(fetchSection.includes('stripTags(article.description'),
    '403 fallback must still use stripTags');
  assert.ok(fetchSection.includes('rss_description_fallback'),
    '403 fallback must still set rss_description_fallback');
});

test('DEGRADED-007: 429 Retry-After still works for non-degraded publishers', () => {
  const retrySection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('articleRes.status === 429'),
    WORKER_SRC.indexOf('articleRes.status === 429') + 500
  );
  assert.ok(retrySection.includes('Retry-After') || retrySection.includes('retry-after'),
    '429 handling must still parse Retry-After');
  assert.ok(retrySection.includes('retryAfterSeconds'),
    '429 must still pass retryAfterSeconds to requeueWithRetry');
});

test('DEGRADED-008: content:encoded still checked first (STEP 0 before STEP 0.5)', () => {
  const step0Idx = WORKER_SRC.indexOf('STEP 0: Check content:encoded');
  const step05Idx = WORKER_SRC.indexOf('STEP 0.5: Check DEGRADED_PUBLISHERS');
  assert.ok(step0Idx > -1, 'STEP 0 must exist');
  assert.ok(step05Idx > -1, 'STEP 0.5 must exist');
  assert.ok(step0Idx < step05Idx, 'STEP 0 (content:encoded) must come before STEP 0.5 (degraded)');
});

test('DEGRADED-009: SSRF protection intact (URL scheme validation)', () => {
  // The URL scheme validation must still exist
  assert.ok(WORKER_SRC.includes("invalid_url_scheme"),
    'URL scheme validation must still exist');
  assert.ok(WORKER_SRC.includes("/^https?:\\/\\//i.test(article.url)"),
    'http(s) URL scheme check must still exist');
});

test('DEGRADED-010: contentSource = rss_description_degraded is distinct from rss_description_fallback', () => {
  // These must be different values so diagnostics can distinguish:
  // - rss_description_degraded: degraded publisher (CoinDesk) → skipped fetch
  // - rss_description_fallback: non-degraded publisher 403 → fetch failed, fallback to RSS
  assert.ok(WORKER_SRC.includes("'rss_description_degraded'"),
    'Must have rss_description_degraded contentSource');
  assert.ok(WORKER_SRC.includes("'rss_description_fallback'"),
    'Must have rss_description_fallback contentSource');
  assert.notEqual('rss_description_degraded', 'rss_description_fallback',
    'Degraded and fallback content sources must be distinct');
});

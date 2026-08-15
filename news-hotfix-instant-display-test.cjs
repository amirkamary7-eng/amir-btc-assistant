// ============================================================================
// HOTFIX 2.6 REGRESSION TESTS — Instant News Display + Premium Pending UI
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const APP_JS_PATH = path.join(__dirname, 'app.js');
const CSS_PATH = path.join(__dirname, 'style.css');
const source = fs.readFileSync(WORKER_PATH, 'utf8');
const appJs = fs.readFileSync(APP_JS_PATH, 'utf8');
const css = fs.readFileSync(CSS_PATH, 'utf8');

// Test 1: processNewsAIBatch STEP 6 writes to news:farsi immediately
test('HOTFIX26-1: STEP 6 writes articles to news:farsi BEFORE AI analysis', () => {
  const batchStart = source.indexOf('async function processNewsAIBatch');
  assert.ok(batchStart > -1, 'processNewsAIBatch must exist');
  const batchBlock = source.slice(batchStart, batchStart + 12000);

  // Must have the immediate write
  assert.ok(/KV_ARTICLES_published_immediate/.test(batchBlock),
    'STEP 6 must log KV_ARTICLES_published_immediate');
  assert.ok(/writeAppCache\(\s*env,\s*FARSI_NEWS_CACHE_KEY,\s*newsJson/.test(batchBlock),
    'STEP 6 must write to news:farsi immediately');
});

// Test 2: fetchFarsiNews does NOT filter out articles without ai_summary
test('HOTFIX26-2: fetchFarsiNews returns ALL articles (no readyOnly filter)', () => {
  const fnStart = source.indexOf('async function fetchFarsiNews');
  assert.ok(fnStart > -1, 'fetchFarsiNews must exist');
  const fnBlock = source.slice(fnStart, fnStart + 3000);

  // Must NOT have readyOnly filter
  const codeOnly = fnBlock.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!/readyOnly/.test(codeOnly),
    'fetchFarsiNews must NOT have readyOnly filter — AI is enrichment, not display requirement');

  // Must return enriched (not filtered)
  assert.ok(/return \{ status: 'success', source: 'cache', data/.test(fnBlock),
    'fetchFarsiNews must return all enriched data');
});

// Test 3: STEP 7 re-caches enriched articles after batch analysis
test('HOTFIX26-3: STEP 7 re-caches articles with sentiment/impact after batch analysis', () => {
  const batchStart = source.indexOf('async function processNewsAIBatch');
  const batchBlock = source.slice(batchStart, batchStart + 12000);

  // Must have re-cache after batch analysis
  assert.ok(/BATCH_ANALYZE_done/.test(batchBlock), 'Must have BATCH_ANALYZE_done');
  const doneIdx = batchBlock.indexOf('BATCH_ANALYZE_done');
  const aroundDone = batchBlock.slice(Math.max(0, doneIdx - 300), doneIdx + 100);
  assert.ok(/writeAppCache.*FARSI_NEWS_CACHE_KEY/.test(aroundDone),
    'Must re-cache to news:farsi after batch analysis succeeds');
});

// Test 4: publishArticleToFarsiNews still exists (for AI enrichment updates)
test('HOTFIX26-4: publishArticleToFarsiNews still exists for AI enrichment', () => {
  assert.ok(source.includes('async function publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must still exist — used to update articles when AI succeeds');
});

// Test 5: Failed URL tracking remains intact
test('HOTFIX26-5: Failed URL tracking remains intact', () => {
  assert.ok(source.includes('news:failed_urls'),
    'news:failed_urls tracking must remain');
  assert.ok(source.includes('failedUrlSet'),
    'failedUrlSet check in enqueueForSummary must remain');
  assert.ok(source.includes('PERMANENT_FAIL_REASONS'),
    'PERMANENT_FAIL_REASONS must remain');
});

// Test 6: NEWS_CACHE_TTL is 86400
test('HOTFIX26-6: NEWS_CACHE_TTL default is 86400 in code', () => {
  assert.ok(/getNumericEnv\(env,\s*'NEWS_CACHE_TTL',\s*86400\)/.test(source),
    'Code must use 86400 as NEWS_CACHE_TTL default');
});

// Test 7: publishResult fix remains intact (no ReferenceError)
test('HOTFIX26-7: publishResult declared outside try block (Commit 2.5 fix intact)', () => {
  const fnStart = source.indexOf('async function succeedWithSummary');
  const fnBlock = source.slice(fnStart, fnStart + 2000);
  const outerTryIdx = fnBlock.indexOf('try {');
  const publishResultIdx = fnBlock.indexOf('let publishResult = null');
  assert.ok(publishResultIdx > -1 && publishResultIdx < outerTryIdx,
    'publishResult must be declared BEFORE the outer try block');
});

// Test 8: Frontend buildNewsPendingBox uses premium shimmer
test('HOTFIX26-8: buildNewsPendingBox uses shimmer bar (not old spinner)', () => {
  const fnStart = appJs.indexOf('function buildNewsPendingBox');
  assert.ok(fnStart > -1, 'buildNewsPendingBox must exist');
  const fnBlock = appJs.slice(fnStart, fnStart + 2000);

  assert.ok(/news-modal-shimmer-bar/.test(fnBlock),
    'Must use shimmer bar instead of old spinner');
  assert.ok(!/news-modal-pending-spinner/.test(fnBlock),
    'Must NOT use old pending-spinner class');
  assert.ok(/تحلیل هوشمند/.test(fnBlock),
    'Must use "تحلیل هوشمند" (smart analysis) label');
});

// Test 9: CSS has premium shimmer animation
test('HOTFIX26-9: CSS has premium shimmer and gold accent styles', () => {
  assert.ok(/news-modal-shimmer-bar/.test(css), 'Must have shimmer-bar CSS');
  assert.ok(/shimmerSlide/.test(css), 'Must have shimmerSlide animation');
  assert.ok(/news-modal-ai-pending/.test(css), 'Must have ai-pending state CSS');
  assert.ok(/news-modal-ai-unavailable/.test(css), 'Must have ai-unavailable state CSS');
  assert.ok(/news-modal-ai-retry/.test(css), 'Must have ai-retry state CSS');
  assert.ok(/d4af37/.test(css), 'Must use gold (#d4af37) accent color');
});

// Test 10: Queue priority and publication gate for AI remain intact
test('HOTFIX26-10: Queue priority and AI publication path remain intact', () => {
  assert.ok(source.includes("priority: 'high'"),
    'Queue priority system must remain');
  assert.ok(source.includes('succeedWithSummary'),
    'succeedWithSummary must remain (AI enrichment path)');
  assert.ok(source.includes('publishArticleToFarsiNews'),
    'publishArticleToFarsiNews must remain (AI updates article in news:farsi)');
});

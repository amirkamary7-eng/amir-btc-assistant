/**
 * News Persistence & Feed Reliability Regression Test
 * =====================================================
 *
 * Verifies the P0-P4 fixes for news pipeline:
 *   P0: STEP 6 no longer hard-overwrites news:farsi (uses merge)
 *   P1: /api/farsi-news falls back to DB when KV is empty/missing
 *   P2: 4-day DB retention cleanup exists
 *   P3: NEWS_CACHE_TTL reduced to 1800s (30 min) in production
 *   P4: Partial AI failure does NOT destroy previous feed
 *
 * Run: node --test news-persistence-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const repoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/news_articles.js'), 'utf8');
const wranglerSrc = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');

// ════════════════════════════════════════════════════════════════════════════
// P0: STEP 6 must NOT hard-overwrite news:farsi (use merge instead)
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P0-001: processNewsAIBatch STEP 6 must NOT use writeAppCache directly on FARSI_NEWS_CACHE_KEY', () => {
  // The destructive pattern was: writeAppCache(env, FARSI_NEWS_CACHE_KEY, JSON.stringify(trimmed), ...)
  // Find STEP 6 region and verify it uses publishArticleToFarsiNews instead.
  const step6Idx = workerSrc.indexOf('STEP 6: PUBLISH (MERGE-AWARE)');
  assert.ok(step6Idx !== -1, 'STEP 6 merge-aware comment must exist');
  const step6Body = workerSrc.substring(step6Idx, step6Idx + 1200);
  assert.ok(
    step6Body.includes('publishArticleToFarsiNews'),
    'STEP 6 must use publishArticleToFarsiNews (merge) instead of hard overwrite'
  );
  // Must NOT have the old destructive writeAppCache pattern in STEP 6
  assert.ok(
    !step6Body.includes("writeAppCache(\n        env,\n        FARSI_NEWS_CACHE_KEY,\n        newsJson"),
    'STEP 6 must NOT have the old hard-overwrite writeAppCache call'
  );
});

test('NEWS-P0-002: STEP 7 must also use merge (not hard overwrite)', () => {
  // STEP 7 re-caches with enriched sentiment. Must use merge too.
  const step7Idx = workerSrc.indexOf('STEP 7: BATCH AI ANALYSIS');
  assert.ok(step7Idx !== -1, 'STEP 7 must exist');
  const step7Body = workerSrc.substring(step7Idx, step7Idx + 2000);
  // Find the re-cache section after batch analysis
  const reCacheIdx = step7Body.indexOf('Articles are already in news:farsi from STEP 6');
  assert.ok(reCacheIdx !== -1, 'STEP 7 re-cache section must exist');
  const reCacheBody = step7Body.substring(reCacheIdx, reCacheIdx + 500);
  assert.ok(
    reCacheBody.includes('publishArticleToFarsiNews'),
    'STEP 7 re-cache must use publishArticleToFarsiNews (merge), not hard overwrite'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P0: publishArticleToFarsiNews must be merge-aware (unchanged — verify it still is)
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P0-003: publishArticleToFarsiNews must read existing + merge (not overwrite)', () => {
  const fnStart = workerSrc.indexOf('async function publishArticleToFarsiNews(');
  assert.ok(fnStart !== -1, 'publishArticleToFarsiNews must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2000);
  assert.ok(fnBody.includes('readAppCache'), 'publishArticleToFarsiNews must read existing KV');
  assert.ok(fnBody.includes('findIndex'), 'publishArticleToFarsiNews must dedup by URL (findIndex)');
  assert.ok(fnBody.includes('unshift'), 'publishArticleToFarsiNews must prepend new articles');
  assert.ok(fnBody.includes('slice(0, MAX_NEWS_ARTICLES)'), 'publishArticleToFarsiNews must trim to max');
});

// ════════════════════════════════════════════════════════════════════════════
// P1: fetchFarsiNews must have DB fallback when KV is empty/missing
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P1-004: fetchFarsiNews must fall back to DB (listForFeed) when KV is empty/missing', () => {
  const fnStart = workerSrc.indexOf('async function fetchFarsiNews(');
  assert.ok(fnStart !== -1, 'fetchFarsiNews must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(
    fnBody.includes('P1 FIX: DB FALLBACK'),
    'fetchFarsiNews must have DB fallback section'
  );
  assert.ok(
    fnBody.includes('newsArticleRepo.listForFeed'),
    'fetchFarsiNews must call newsArticleRepo.listForFeed for DB fallback'
  );
  assert.ok(
    fnBody.includes("source: 'db'"),
    'fetchFarsiNews must return source:"db" when reading from DB'
  );
});

test('NEWS-P1-005: fetchFarsiNews must re-cache DB result to KV', () => {
  const fnStart = workerSrc.indexOf('async function fetchFarsiNews(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  // Find the DB fallback section and verify it re-caches
  const dbFallbackIdx = fnBody.indexOf('P1 FIX: DB FALLBACK');
  const dbFallbackBody = fnBody.substring(dbFallbackIdx, dbFallbackIdx + 1600);
  assert.ok(
    dbFallbackBody.includes('writeAppCache'),
    'DB fallback must re-cache result to KV for subsequent fast-path requests'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P1: news_articles repo must have listForFeed method
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P1-006: news_articles repo must export listForFeed method', () => {
  assert.ok(
    repoSrc.includes('async function listForFeed'),
    'news_articles repo must define listForFeed function'
  );
  assert.ok(
    repoSrc.includes('listForFeed,') && repoSrc.includes('return Object.freeze'),
    'news_articles repo must export listForFeed in the frozen object'
  );
});

test('NEWS-P1-007: listForFeed must query articles from last 4 days', () => {
  const fnStart = repoSrc.indexOf('async function listForFeed');
  assert.ok(fnStart !== -1, 'listForFeed must exist');
  const fnBody = repoSrc.substring(fnStart, fnStart + 1500);
  assert.ok(
    fnBody.includes("INTERVAL '4 days'"),
    'listForFeed must filter to last 4 days (retention window)'
  );
  assert.ok(
    fnBody.includes('ORDER BY'),
    'listForFeed must order results (most recent first)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P2: DB retention cleanup must exist
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P2-008: news_articles repo must export cleanupOld method', () => {
  assert.ok(
    repoSrc.includes('async function cleanupOld'),
    'news_articles repo must define cleanupOld function'
  );
  assert.ok(
    repoSrc.includes('cleanupOld,'),
    'news_articles repo must export cleanupOld'
  );
});

test('NEWS-P2-009: cleanupOld must DELETE articles older than retention window', () => {
  const fnStart = repoSrc.indexOf('async function cleanupOld');
  assert.ok(fnStart !== -1, 'cleanupOld must exist');
  const fnBody = repoSrc.substring(fnStart, fnStart + 600);
  assert.ok(
    fnBody.includes('DELETE FROM news_articles'),
    'cleanupOld must DELETE from news_articles'
  );
  assert.ok(
    fnBody.includes('days'),
    'cleanupOld must use days-based retention'
  );
});

test('NEWS-P2-010: processNewsAIBatch must call cleanupOld (4-day retention)', () => {
  const step11Idx = workerSrc.indexOf('STEP 11: DB RETENTION CLEANUP');
  assert.ok(step11Idx !== -1, 'processNewsAIBatch must have STEP 11 (DB retention cleanup)');
  const step11Body = workerSrc.substring(step11Idx, step11Idx + 500);
  assert.ok(
    step11Body.includes('cleanupOld'),
    'STEP 11 must call newsArticleRepo.cleanupOld'
  );
  assert.ok(
    step11Body.includes('4') || step11Body.includes('retention_days: 4'),
    'STEP 11 must use 4-day retention'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P3: NEWS_CACHE_TTL must be 1800s (30 min) in production
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P3-011: production wrangler.jsonc must have NEWS_CACHE_TTL = 1800', () => {
  // Find the production ENV block (line with "production": {) — NOT APP_ENV which appears later.
  // Use indexOf (first occurrence) since the env block comes before APP_ENV.
  const prodIdx = wranglerSrc.indexOf('"production": {');
  assert.ok(prodIdx !== -1, 'Production env block must exist');
  // NEWS_CACHE_TTL appears ~2300 chars into the production block — use 3000 window
  const prodSection = wranglerSrc.substring(prodIdx, prodIdx + 3000);
  const ttlMatch = prodSection.match(/"NEWS_CACHE_TTL"\s*:\s*(\d+)/);
  assert.ok(ttlMatch, 'NEWS_CACHE_TTL must exist in production env block');
  assert.equal(ttlMatch[1], '1800', `Production NEWS_CACHE_TTL must be 1800 (30 min), got ${ttlMatch[1]}`);
});

// ════════════════════════════════════════════════════════════════════════════
// P4: Partial failure guard — must not destroy previous feed
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-P4-012: processNewsAIBatch must log partial batch (P4 guard)', () => {
  const guardIdx = workerSrc.indexOf('P4 GUARD: Log if batch was partial');
  assert.ok(guardIdx !== -1, 'P4 guard comment must exist');
  const guardBody = workerSrc.substring(guardIdx, guardIdx + 700);
  assert.ok(
    guardBody.includes('Partial batch'),
    'P4 guard must log partial batch warning'
  );
  assert.ok(
    guardBody.includes('Feed preserved via merge'),
    'P4 guard must confirm feed preserved via merge'
  );
});

test('NEWS-P4-013: STEP 5 early-return on 0 survivors must be preserved (total failure)', () => {
  // When deduped.length === 0, the function returns early WITHOUT writing to KV.
  // This preserves the previous feed on total AI failure.
  const earlyReturnIdx = workerSrc.indexOf("deduped.length === 0");
  assert.ok(earlyReturnIdx !== -1, 'STEP 5 must have deduped.length === 0 early-return guard');
  const earlyReturnBody = workerSrc.substring(earlyReturnIdx - 50, earlyReturnIdx + 300);
  assert.ok(
    earlyReturnBody.includes('return') && earlyReturnBody.includes('no_articles'),
    'STEP 5 must return early (no_articles) when 0 survivors — preserves previous feed'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// Scope protection: fallback chain unchanged
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-SCOPE-014: Fallback chain order unchanged (Groq → Gemini → OpenRouter → Workers AI → OpenAI)', () => {
  // News AI summary fallback chain (in generateSummaryWithFallback)
  const summaryStart = workerSrc.indexOf('FALLBACK CHAIN (Provider Activation Phase');
  assert.ok(summaryStart !== -1, 'Summary fallback chain comment must exist');
  const chainBody = workerSrc.substring(summaryStart, summaryStart + 600);
  assert.ok(chainBody.includes('Groq'), 'Chain must include Groq');
  assert.ok(chainBody.includes('Gemini'), 'Chain must include Gemini');
  assert.ok(chainBody.includes('OpenRouter'), 'Chain must include OpenRouter');
  assert.ok(chainBody.includes('Workers AI'), 'Chain must include Workers AI');
  assert.ok(chainBody.includes('OpenAI'), 'Chain must include OpenAI');
});

test('NEWS-SCOPE-015: No provider removed from News AI (NEWS_PROVIDER_* flags unchanged)', () => {
  // All 5 providers must still be gated by their NEWS_PROVIDER_* flags
  assert.ok(workerSrc.includes("NEWS_PROVIDER_GROQ"), 'Groq provider flag must exist');
  assert.ok(workerSrc.includes("NEWS_PROVIDER_GEMINI"), 'Gemini provider flag must exist');
  assert.ok(workerSrc.includes("NEWS_PROVIDER_OPENROUTER"), 'OpenRouter provider flag must exist');
  assert.ok(workerSrc.includes("NEWS_PROVIDER_WORKERS_AI"), 'Workers AI provider flag must exist');
  assert.ok(workerSrc.includes("NEWS_PROVIDER_OPENAI"), 'OpenAI provider flag must exist');
});

test('NEWS-SCOPE-016: Circuit breaker keys unchanged (groq-key0, groq-key1)', () => {
  const routedStart = workerSrc.indexOf('async function _groqRoutedFetch(');
  const routedBody = workerSrc.substring(routedStart, routedStart + 1500);
  assert.ok(routedBody.includes("'groq-key0'"), 'groq-key0 circuit key must be unchanged');
  assert.ok(routedBody.includes("'groq-key1'"), 'groq-key1 circuit key must be unchanged');
});

// ════════════════════════════════════════════════════════════════════════════
// DB as source of truth confirmation
// ════════════════════════════════════════════════════════════════════════════
test('NEWS-ARCH-017: KV is only a cache (DB is source of truth)', () => {
  // fetchFarsiNews must have both KV fast-path AND DB fallback
  const fnStart = workerSrc.indexOf('async function fetchFarsiNews(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(fnBody.includes("source: 'cache'"), 'KV fast-path returns source:cache');
  assert.ok(fnBody.includes("source: 'db'"), 'DB fallback returns source:db');
  assert.ok(fnBody.includes("source: 'rss_unavailable'"), 'Empty fallback returns source:rss_unavailable');
});

test('NEWS-ARCH-018: news_articles table must have created_at index (for retention cleanup)', () => {
  // The index idx_news_articles_created must exist for efficient cleanup queries
  const migrateSrc = fs.readFileSync(path.join(__dirname, 'scripts/00-migrate.sql'), 'utf8');
  assert.ok(
    migrateSrc.includes('idx_news_articles_created'),
    'news_articles must have idx_news_articles_created index for retention cleanup'
  );
  assert.ok(
    migrateSrc.includes('CREATE TABLE IF NOT EXISTS news_articles'),
    'news_articles table must exist in migration'
  );
});

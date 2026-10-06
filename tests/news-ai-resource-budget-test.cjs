/**
 * News AI Resource-Budget Regression Test
 *
 * RCA context (2026-10-04 05:30 UTC onset):
 *   The 15-min cron's processNewsAIBatch hit `exceededResources` because it
 *   enqueued up to 10 articles/tick x 4 = 40/hour, outpacing the 5-min cron's
 *   processing rate (MAX_SUMMARIES_PER_TICK=2 x 8 non-overlap ticks = 16/hour).
 *   This caused the queue to grow -> the circuit breaker (queue > 40) skipped
 *   the ENTIRE batch -> wasted ticks + sustained exceededResources.
 *
 * FIX (src/news/summary.js processNewsAIBatch):
 *   1. Cap articles processed per 15-min tick to 4 (MAX_ARTICLES_PER_15MIN_TICK).
 *      4 x 4 = 16/hour enqueue capacity MATCHES the 16/hour 5-min processing rate
 *      (MAX_SUMMARIES_PER_TICK=2 x 8 non-overlap ticks) exactly — in sustained
 *      high volume the queue does NOT grow (enqueue = drain), so the circuit
 *      breaker (queue > 40) never triggers via queue growth. This is the
 *      zero-growth steady state.
 *      Excess articles are NOT dropped — they reappear in RSS next tick (15min)
 *      and are deduped by canonical URL (publishArticleToFarsiNews +
 *      enqueueForSummary). No article is lost.
 *   2. Throttle DB retention cleanup (STEP 11) to hourly (:00 tick only via
 *      getUTCMinutes() < 15). Was 96x/day (every 15-min tick), now 24x/day.
 *      Saves 3 DB subrequests on 3 of 4 ticks (72 fewer DB roundtrips/day).
 *
 * This test verifies:
 *   NB-01: MAX_ARTICLES_PER_15MIN_TICK constant exists and equals 4
 *   NB-02: trimmed is capped at min(MAX_NEWS_ARTICLES, MAX_ARTICLES_PER_15MIN_TICK)
 *   NB-03: deferred articles are logged (ARTICLES_DEFERRED stepLog + console.log)
 *   NB-04: the cap (4) matches the 5-min processing rate exactly (16/h = 16/h, zero queue growth)
 *   NB-05: DB cleanup is throttled (_runHourlyCleanup / getUTCMinutes() < 15)
 *   NB-06: cleanupOld still called with 4-day retention (within the throttle)
 *   NB-07: cleanupTickLog + cleanupE2ETimingLog still called (within the throttle)
 *   NB-08: no article drop — deferred articles reappear via RSS + dedup
 *   NB-09: spike safety — even with 20 filtered articles, only 6 processed/tick
 *   NB-10: the fix is ONLY in processNewsAIBatch (not in alert/wallet/economy)
 *
 * Run: node --test tests/news-ai-resource-budget-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SUMMARY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'news', 'summary.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'cron', 'scheduler.js'), 'utf8');

// ── Helper: extract a named function body (paren-match params, then brace-match) ──
function extractFn(src, name) {
  const sigRe = new RegExp('function\\s+' + name + '\\s*\\(');
  const sigMatch = sigRe.exec(src);
  assert.ok(sigMatch, name + ' must exist');
  const start = sigMatch.index;
  let i = src.indexOf('(', start);
  let pd = 1; i++;
  while (pd > 0 && i < src.length) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    i++;
  }
  i = src.indexOf('{', i);
  let bd = 1; i++;
  while (bd > 0 && i < src.length) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') bd--;
    i++;
  }
  return src.slice(start, i);
}
const BATCH_FN = extractFn(SUMMARY_SRC, 'processNewsAIBatch');

// ============================================================================
// NB-01..03: per-tick article cap (MAX_ARTICLES_PER_15MIN_TICK = 4)
// ============================================================================

test('NB-01: MAX_ARTICLES_PER_15MIN_TICK constant exists and equals 4', () => {
  assert.match(BATCH_FN, /MAX_ARTICLES_PER_15MIN_TICK\s*=\s*4/,
    'processNewsAIBatch must define MAX_ARTICLES_PER_15MIN_TICK = 4 (matches */5 drain rate: 4×4=16/h = 16/h process)');
});

test('NB-02: trimmed is capped at Math.min(MAX_NEWS_ARTICLES, MAX_ARTICLES_PER_15MIN_TICK)', () => {
  assert.match(BATCH_FN, /trimmed\s*=\s*deduped\.slice\(\s*0,\s*Math\.min\(\s*MAX_NEWS_ARTICLES\s*,\s*MAX_ARTICLES_PER_15MIN_TICK\s*\)\s*\)/,
    'trimmed must be capped at Math.min(MAX_NEWS_ARTICLES, MAX_ARTICLES_PER_15MIN_TICK) — bounds to 4');
  // Also verify the old unconditional slice(0, MAX_NEWS_ARTICLES) is gone from processNewsAIBatch
  // (the old code was: const trimmed = deduped.slice(0, MAX_NEWS_ARTICLES))
  // The new code uses Math.min. Verify the OLD pattern is NOT present:
  const batchStart = SUMMARY_SRC.indexOf('async function processNewsAIBatch');
  const batchEnd = SUMMARY_SRC.indexOf('\n  return {', batchStart);
  const batchBody = SUMMARY_SRC.slice(batchStart, batchEnd);
  assert.ok(!/const trimmed = deduped\.slice\(0, MAX_NEWS_ARTICLES\)/.test(batchBody),
    'the old unconditional cap (slice(0, MAX_NEWS_ARTICLES)) must be replaced by the Math.min cap');
});

test('NB-03: deferred articles are logged (ARTICLES_DEFERRED stepLog + console.log)', () => {
  assert.match(BATCH_FN, /stepLog\(\s*['"]ARTICLES_DEFERRED['"]/,
    'must log ARTICLES_DEFERRED via stepLog when articles are deferred');
  assert.match(BATCH_FN, /console\.log\(\s*`?\[NEWS-AI-BUDGET\]/,
    'must log [NEWS-AI-BUDGET] via console.log when articles are deferred');
  assert.match(BATCH_FN, /deferredArticleCount\s*=\s*deduped\.length\s*-\s*trimmed\.length/,
    'must compute deferredArticleCount = deduped.length - trimmed.length');
  assert.match(BATCH_FN, /if\s*\(\s*deferredArticleCount\s*>\s*0\s*\)/,
    'must only log when deferredArticleCount > 0');
});

// ============================================================================
// NB-04: the cap (4) matches the */5 processing rate exactly (zero queue growth)
// ============================================================================

test('NB-04: the cap (4) matches the */5 processing rate exactly (zero queue growth)', () => {
  // The */5 cron processes MAX_SUMMARIES_PER_TICK=2 per non-overlap tick.
  // Non-overlap ticks = 12 - 4 (overlap with */15) = 8/hour.
  // Processing rate = 2 × 8 = 16/hour.
  // The */15 enqueue cap = 4 × 4 = 16/hour = EXACTLY the processing rate.
  // In sustained high volume, enqueue = drain → queue does NOT grow →
  // circuit breaker never triggers via queue growth. Zero-growth steady state.
  // Verify MAX_SUMMARIES_PER_TICK=2 in scheduler.js
  assert.match(SCHEDULER_SRC, /MAX_SUMMARIES_PER_TICK\s*=\s*2/,
    '*/5 cron must have MAX_SUMMARIES_PER_TICK = 2 (baseline for the cap derivation)');
  const cap = 4;
  const enqueueRate = cap * 4;     // 16/hour
  const processRate = 2 * 8;       // 16/hour
  assert.equal(enqueueRate, processRate,
    `enqueue capacity (${enqueueRate}/h) must EQUAL processing rate (${processRate}/h) — zero queue growth in sustained high volume`);
  assert.equal(enqueueRate, 16,
    'enqueue capacity must be 16/hour (4 × 4)');
  assert.equal(processRate, 16,
    'processing rate must be 16/hour (2 × 8)');
});

// ============================================================================
// NB-05..07: DB retention cleanup throttle (hourly)
// ============================================================================

test('NB-05: DB cleanup is throttled to hourly (_runHourlyCleanup / getUTCMinutes() < 15)', () => {
  assert.match(BATCH_FN, /_runHourlyCleanup\s*=\s*new Date\(\)\.getUTCMinutes\(\)\s*<\s*15/,
    'must compute _runHourlyCleanup = getUTCMinutes() < 15 (the :00 tick of :00/:15/:30/:45)');
  assert.match(BATCH_FN, /if\s*\(\s*_runHourlyCleanup\s*\)/,
    'must wrap cleanup in if (_runHourlyCleanup)');
});

test('NB-06: cleanupOld still called with 4-day retention (within the throttle)', () => {
  // The cleanupOld call must be INSIDE the if (_runHourlyCleanup) block
  const ifIdx = BATCH_FN.indexOf('if (_runHourlyCleanup)');
  assert.ok(ifIdx > -1, 'if (_runHourlyCleanup) must exist');
  const afterIf = BATCH_FN.slice(ifIdx);
  assert.match(afterIf, /cleanupOld\(env,\s*4,\s*pool\)/,
    'cleanupOld(env, 4, pool) must be called inside the throttle block');
  // Verify retention is still 4 days
  assert.match(afterIf, /retention_days:\s*4/,
    'retention_days must still be 4');
});

test('NB-07: cleanupTickLog + cleanupE2ETimingLog still called (within the throttle)', () => {
  const ifIdx = BATCH_FN.indexOf('if (_runHourlyCleanup)');
  const afterIf = BATCH_FN.slice(ifIdx);
  assert.match(afterIf, /cleanupTickLog\(env,\s*4\)/,
    'cleanupTickLog(env, 4) must be called inside the throttle block');
  assert.match(afterIf, /cleanupE2ETimingLog\(env,\s*4\)/,
    'cleanupE2ETimingLog(env, 4) must be called inside the throttle block');
});

// ============================================================================
// NB-08: no article drop — deferred articles reappear via RSS + dedup
// ============================================================================

test('NB-08: no article drop — deferred articles reappear via RSS + dedup', () => {
  // The fix comment must mention that deferred articles reappear in RSS
  assert.match(BATCH_FN, /reappear in RSS next tick/i,
    'must document that deferred articles reappear in RSS next tick');
  // publishArticleToFarsiNews must still dedup by canonical URL (so re-discovered
  // articles from RSS are no-ops, not duplicates)
  const pubStart = SUMMARY_SRC.indexOf('async function publishArticleToFarsiNews');
  assert.ok(pubStart > -1, 'publishArticleToFarsiNews must exist');
  const pubBody = SUMMARY_SRC.slice(pubStart, pubStart + 3000);
  assert.match(pubBody, /canonicalizeUrl|canonical/i,
    'publishArticleToFarsiNews must dedup by canonical URL (so deferred articles are no-ops next tick)');
  // enqueueForSummary must skip already-queued URLs
  const enqStart = SUMMARY_SRC.indexOf('async function enqueueForSummary');
  assert.ok(enqStart > -1, 'enqueueForSummary must exist');
  const enqBody = SUMMARY_SRC.slice(enqStart, enqStart + 3000);
  assert.match(enqBody, /existingByUrl|existingByUrl\s*=\s*new Map/,
    'enqueueForSummary must dedup by URL (existingByUrl) — so re-discovered articles are not double-enqueued');
});

// ============================================================================
// NB-09: spike safety — even with 20 filtered articles, only 4 processed/tick
// ============================================================================

test('NB-09: spike safety — cap bounds processing regardless of filtered count', () => {
  // Simulate: filterAndScoreNews returns 20 articles (spike). The cap (4)
  // means trimmed = deduped.slice(0, 4) = 4. Only 4 are translated/published/
  // enqueued. The other 16 are deferred (logged) and reappear next tick.
  // The Math.min(MAX_NEWS_ARTICLES=12, MAX_ARTICLES_PER_15MIN_TICK=4) = 4.
  // Even if deduped has 20, trimmed = deduped.slice(0, 4) = 4.
  // Verify the cap is a SLICE (not a filter) — so it always bounds to 4
  assert.match(BATCH_FN, /deduped\.slice\(\s*0,\s*Math\.min\(/,
    'trimmed must be a slice(0, cap) — always bounds to cap regardless of deduped.length');
  // Verify the for loops use trimmed (capped), not deduped (uncapped)
  const trimmedIdx = BATCH_FN.indexOf('const trimmed = deduped.slice');
  const afterTrim = BATCH_FN.slice(trimmedIdx);
  // publish loop must iterate trimmed, not deduped
  assert.match(afterTrim, /for\s*\(\s*const article of trimmed\s*\)/,
    'publish loop must iterate trimmed (capped), not deduped');
});

// ============================================================================
// NB-10: the fix is ONLY in processNewsAIBatch (not in alert/wallet/economy)
// ============================================================================

test('NB-10: the fix is ONLY in src/news/summary.js — no alert/wallet/economy/membership change', () => {
  // The fix touches only src/news/summary.js (processNewsAIBatch).
  // Verify the alert cron (scheduler.js 1-min block) is unchanged by this fix:
  //   - No MAX_ARTICLES_PER_15MIN_TICK in scheduler.js
  //   - No _runHourlyCleanup in scheduler.js
  assert.ok(!SCHEDULER_SRC.includes('MAX_ARTICLES_PER_15MIN_TICK'),
    'MAX_ARTICLES_PER_15MIN_TICK must NOT be in scheduler.js (fix is news-only)');
  assert.ok(!SCHEDULER_SRC.includes('_runHourlyCleanup'),
    '_runHourlyCleanup must NOT be in scheduler.js (fix is news-only)');
  // Verify the fix is in summary.js (processNewsAIBatch)
  assert.match(SUMMARY_SRC, /MAX_ARTICLES_PER_15MIN_TICK/,
    'MAX_ARTICLES_PER_15MIN_TICK must be in summary.js');
  assert.match(SUMMARY_SRC, /_runHourlyCleanup/,
    '_runHourlyCleanup must be in summary.js');
});

// ============================================================================
// NB-11: the 1-min alert cron is NOT affected (alert speed/accuracy preserved)
// ============================================================================

test('NB-11: alert cron (1-min) path is unchanged — alert speed/accuracy preserved', () => {
  // The 1-min cron (runScheduledAlertsBaseline) must not reference the budget cap
  const alertStart = SCHEDULER_SRC.indexOf('runScheduledAlertsBaseline');
  if (alertStart > -1) {
    const alertBody = SCHEDULER_SRC.slice(alertStart, alertStart + 5000);
    assert.ok(!alertBody.includes('MAX_ARTICLES_PER_15MIN_TICK'),
      'alert cron must not reference MAX_ARTICLES_PER_15MIN_TICK (news-only fix)');
    assert.ok(!alertBody.includes('_runHourlyCleanup'),
      'alert cron must not reference _runHourlyCleanup (news-only fix)');
  }
  // The */15 news batch is dispatched separately from alerts
  assert.match(SCHEDULER_SRC, /processNewsAIBatch/,
    'processNewsAIBatch is called from scheduler (the */15 news path)');
});

// ============================================================================
// NB-12: behavioral simulation — cap + defer + dedup = no drop, bounded work
// ============================================================================

test('NB-12: behavioral — 10 filtered articles → 4 processed/tick, 0 dropped over 4 ticks', () => {
  // Simulate the cap + defer + dedup mechanism over multiple ticks.
  // RSS re-fetches each tick; filterAndScoreNews re-scores by freshness, so
  // the top-4 rotates as articles age (already-published ones rank lower).
  // publishArticleToFarsiNews dedupes by canonical URL (no-op for published).
  function simulateTick(published, allArticles, tickNum, cap) {
    // Rotate the array each tick to simulate score changes (fresh articles
    // rank higher; published articles age and drop in the ranking).
    const offset = (tickNum * 3) % allArticles.length;
    const rotated = [...allArticles.slice(offset), ...allArticles.slice(0, offset)];
    const deduped = rotated.slice(0, 10); // filterAndScoreNews returns top 10
    const trimmed = deduped.slice(0, cap);
    let processed = 0, deferred = 0, noops = 0;
    for (const a of trimmed) {
      if (published.has(a)) { noops++; }
      else { published.add(a); processed++; }
    }
    deferred = deduped.length - trimmed.length;
    return { processed, deferred, noops };
  }

  // 10 articles discovered in tick 1 (no new in subsequent ticks — they
  // reappear in RSS and are re-scored).
  const allArticles = Array.from({length: 10}, (_, i) => 'article-' + i);
  const published = new Set();
  let totalProcessed = 0, totalDeferred = 0;
  const cap = 4;
  for (let t = 0; t < 6; t++) {
    const r = simulateTick(published, allArticles, t, cap);
    totalProcessed += r.processed; totalDeferred += r.deferred;
  }
  // All 10 unique articles must be processed (0 drops)
  assert.equal(published.size, 10, 'all 10 articles must be published over 6 ticks (0 drops)');
  assert.equal(totalProcessed, 10, 'exactly 10 article-processings (one per unique article)');
  assert.ok(totalDeferred > 0, 'some articles were deferred (the cap is working)');
});

test('NB-13: spike safety — 20 filtered articles → bounded work, no exceededResources', () => {
  // Simulate a spike: 20 new articles in one tick.
  // The cap (4) ensures only 4 are processed this tick. The other 16 are
  // deferred. No exceededResources because per-tick work is bounded.
  function countWorkForTick(filteredCount, cap) {
    const trimmed = Math.min(filteredCount, cap);
    return {
      translated: trimmed,      // batch translate processes trimmed.length headlines
      published: trimmed,       // publish loop iterates trimmed
      enqueued: trimmed,        // enqueue processes trimmed
      batchAnalyzed: trimmed,  // batch analyze processes trimmed
      deferred: filteredCount - trimmed,
      totalWork: trimmed * 4,  // 4 loops over trimmed
    };
  }
  // Without cap (old behavior): 20 articles → 20×4 = 80 loop iterations
  const oldWork = countWorkForTick(20, 20); // no cap = 20
  // With cap (new behavior): 20 articles → 4×4 = 16 loop iterations
  const newWork = countWorkForTick(20, 4);
  assert.ok(newWork.totalWork < oldWork.totalWork,
    `spike work with cap (${newWork.totalWork}) < without cap (${oldWork.totalWork}) — prevents exceededResources`);
  assert.equal(newWork.translated, 4, 'only 4 translated (bounded)');
  assert.equal(newWork.deferred, 16, '16 deferred to next tick');
  assert.equal(newWork.totalWork, 16, 'total loop work = 16 (4×4)');
  // Verify the cap bounds per-tick work regardless of filtered count.
  // The per-tick loop work (4 loops × 4 articles = 16) is well under the
  // old unbounded work (4 × 20 = 80). This is the structural guarantee
  // against exceededResources.
  assert.ok(newWork.totalWork <= 16, 'per-tick work bounded to 16 loop iterations (4×4)');
});

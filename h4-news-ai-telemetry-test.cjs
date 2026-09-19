/**
 * H4 News AI Telemetry Migration — Regression Test
 *
 * Tests that the legacy KV RMW telemetry call sites have been removed from
 * processOneArticleSummary and that telemetry data now flows through
 * recordNewsAITick → news_ai_tick_log (Postgres).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── Helpers ─────────────────────────────────────────────────────────────────

function extractFunctionBody(src, fnName) {
  const startMarker = `async function ${fnName}`;
  const startIdx = src.indexOf(startMarker);
  assert.notEqual(startIdx, -1, `Function ${fnName} must exist`);
  const nextAsyncIdx = src.indexOf('async function ', startIdx + startMarker.length);
  const endIdx = nextAsyncIdx === -1 ? src.length : nextAsyncIdx;
  return src.slice(startIdx, endIdx);
}

// ─── Tests ───────────────────────────────────────────────────────────────────

// GROUP 3 — Telemetry data in recordNewsAITick payload

test('H4-07: recordNewsAITick call site includes cache_hit field', () => {
  const callSiteIdx = WORKER_SRC.indexOf("type: 'tick_5min'");
  assert.notEqual(callSiteIdx, -1, 'tick_5min call site must exist');
  const callSiteBlock = WORKER_SRC.slice(callSiteIdx, callSiteIdx + 1200);
  assert.ok(callSiteBlock.includes('cache_hit:'),
    'recordNewsAITick tick_5min call must include cache_hit field');
});

test('H4-08: recordNewsAITick call site includes provider_attempts field', () => {
  const callSiteIdx = WORKER_SRC.indexOf("type: 'tick_5min'");
  const callSiteBlock = WORKER_SRC.slice(callSiteIdx, callSiteIdx + 1200);
  assert.ok(callSiteBlock.includes('provider_attempts:'),
    'recordNewsAITick tick_5min call must include provider_attempts field');
});

test('H4-09: recordNewsAITick call site includes fallback_used field', () => {
  const callSiteIdx = WORKER_SRC.indexOf("type: 'tick_5min'");
  const callSiteBlock = WORKER_SRC.slice(callSiteIdx, callSiteIdx + 1200);
  assert.ok(callSiteBlock.includes('fallback_used:'),
    'recordNewsAITick tick_5min call must include fallback_used field');
});

test('H4-10: recordNewsAITick call site includes final_provider field', () => {
  const callSiteIdx = WORKER_SRC.indexOf("type: 'tick_5min'");
  const callSiteBlock = WORKER_SRC.slice(callSiteIdx, callSiteIdx + 1200);
  assert.ok(callSiteBlock.includes('final_provider:'),
    'recordNewsAITick tick_5min call must include final_provider field');
});

// GROUP 4 — succeedWithSummary + requeueWithRetry return cache_hit + provider_attempts

test('H4-11: succeedWithSummary return includes cache_hit: false + provider_attempts', () => {
  const body = extractFunctionBody(WORKER_SRC, 'succeedWithSummary');
  assert.ok(body.includes('cache_hit: false'),
    'succeedWithSummary must return cache_hit: false (AI success path = cache miss)');
  assert.ok(body.includes('provider_attempts:'),
    'succeedWithSummary must return provider_attempts');
  // Verify only 3 fields per attempt (no sensitive data leaked)
  assert.ok(body.includes('provider: a.provider'),
    'provider_attempts must include provider');
  assert.ok(body.includes('success: !!a.success'),
    'provider_attempts must include success');
  assert.ok(body.includes('duration_ms: Number(a.duration_ms)'),
    'provider_attempts must include duration_ms');
  // Verify NO sensitive fields in provider_attempts
  assert.ok(!body.includes('error_detail: a.error_detail'),
    'provider_attempts must NOT include error_detail');
  assert.ok(!body.includes('summary: a.summary'),
    'provider_attempts must NOT include summary text');
});

test('H4-12: requeueWithRetry return includes cache_hit: false + provider_attempts', () => {
  // Find the requeueWithRetry return block by searching for the function
  const requeueIdx = WORKER_SRC.indexOf('async function requeueWithRetry');
  assert.notEqual(requeueIdx, -1, 'requeueWithRetry must exist');
  // Extract a generous block (5000 chars) to capture the return
  const requeueBlock = WORKER_SRC.slice(requeueIdx, requeueIdx + 5000);
  assert.ok(requeueBlock.includes('cache_hit: false'),
    'requeueWithRetry must return cache_hit: false');
  assert.ok(requeueBlock.includes('provider_attempts:'),
    'requeueWithRetry must return provider_attempts');
  assert.ok(requeueBlock.includes('(attempts || [])'),
    'requeueWithRetry must use (attempts || []) for safety when attempts is undefined');
});

// GROUP 5 — getNewsAIMonitoring reads from Postgres (not KV)

test('H4-13: getNewsAIMonitoring does NOT read NEWS_AI_CACHE_STATS_KEY from KV', () => {
  const body = extractFunctionBody(WORKER_SRC, 'getNewsAIMonitoring');
  const kvReadPattern = /readAppCache\s*\(\s*env\s*,\s*NEWS_AI_CACHE_STATS_KEY\s*\)/g;
  assert.equal((body.match(kvReadPattern) || []).length, 0,
    'getNewsAIMonitoring must NOT read NEWS_AI_CACHE_STATS_KEY from KV');
});

test('H4-14: getNewsAIMonitoring does NOT read NEWS_AI_PROVIDER_STATS_KEY from KV', () => {
  const body = extractFunctionBody(WORKER_SRC, 'getNewsAIMonitoring');
  const kvReadPattern = /readAppCache\s*\(\s*env\s*,\s*NEWS_AI_PROVIDER_STATS_KEY\s*\)/g;
  assert.equal((body.match(kvReadPattern) || []).length, 0,
    'getNewsAIMonitoring must NOT read NEWS_AI_PROVIDER_STATS_KEY from KV');
});

test('H4-15: getNewsAIMonitoring queries Postgres for provider stats', () => {
  const body = extractFunctionBody(WORKER_SRC, 'getNewsAIMonitoring');
  assert.ok(body.includes('jsonb_array_elements(stats->\'provider_attempts\')'),
    'getNewsAIMonitoring must use jsonb_array_elements for provider stats');
  assert.ok(body.includes("FROM news_ai_tick_log"),
    'getNewsAIMonitoring must query news_ai_tick_log');
});

test('H4-16: getNewsAIMonitoring queries Postgres for cache stats', () => {
  const body = extractFunctionBody(WORKER_SRC, 'getNewsAIMonitoring');
  assert.ok(body.includes("stats ? 'cache_hit'"),
    'getNewsAIMonitoring must check for cache_hit field (backward compat with old rows)');
  assert.ok(body.includes("summary_reason' = 'cache_hit'"),
    'getNewsAIMonitoring must fallback to summary_reason for old rows');
});

// GROUP 6 — Essential KV writes preserved

test('H4-17: essential KV writes still exist (saveSummaryQueue, aiKey, farsi, failed_urls)', () => {
  assert.ok(WORKER_SRC.includes('NEWS_SUMMARY_QUEUE_KEY'),
    'news:summary_queue must still exist');
  assert.ok(WORKER_SRC.includes('NEWS_AI_CACHE_PREFIX'),
    'news:ai:{hash} must still exist');
  assert.ok(WORKER_SRC.includes('FARSI_NEWS_CACHE_KEY'),
    'news:farsi must still exist');
  assert.ok(WORKER_SRC.includes("'news:failed_urls'"),
    'news:failed_urls must still exist');
});

// GROUP 7 — AI generation behavior unchanged

test('H4-18: generateSummaryWithFallback unchanged (still exists + returns attempts)', () => {
  assert.ok(WORKER_SRC.includes('async function generateSummaryWithFallback'),
    'generateSummaryWithFallback must still exist');
  // Check in the WHOLE source (attempts.push is in a nested function)
  assert.ok(WORKER_SRC.includes('attempts.push'),
    'generateSummaryWithFallback (or its nested attemptProvider) must still push attempts');
  assert.ok(WORKER_SRC.includes('fallbackUsed'),
    'generateSummaryWithFallback must still return fallbackUsed');
});

test('H4-19: succeedWithSummary AI logic unchanged (summary save + publish)', () => {
  const body = extractFunctionBody(WORKER_SRC, 'succeedWithSummary');
  assert.ok(body.includes('writeAppCache(env, aiKey'),
    'succeedWithSummary must still save summary to KV (aiKey)');
  assert.ok(body.includes('publishArticleToFarsiNews'),
    'succeedWithSummary must still publish to farsi news');
  assert.ok(body.includes('saveSummaryQueue'),
    'succeedWithSummary must still save queue');
});

// GROUP 8 — Scope verification

test('H4-20: Price Alert untouched', () => {
  assert.ok(WORKER_SRC.includes('async function runScheduledAlertsBaseline'),
    'runScheduledAlertsBaseline must still exist');
  assert.ok(WORKER_SRC.includes('slice(0, 14)'),
    'H6 OHLC cap must still exist');
});

test('H4-21: Calendar untouched (PATH 1 + PATH 2)', () => {
  assert.ok(WORKER_SRC.includes('async function runCalendarAlertsCheck'),
    'runCalendarAlertsCheck must still exist');
  assert.ok(WORKER_SRC.includes('markFiredBulk'),
    'markFiredBulk must still exist (Calendar PATH 2)');
  assert.ok(WORKER_SRC.includes('BULK FIX: Batch preference lookup'),
    'PATH 1 bulk fix must still exist');
});

test('H4-22: processQueue + scheduled unchanged', () => {
  assert.ok(WORKER_SRC.includes('processQueue(env, sendTelegramMessage, pool, 5)'),
    '1-min cron processQueue(5) must still exist');
  assert.ok(WORKER_SRC.includes('processQueue(env, sendTelegramMessage, pool, 10)'),
    'calendar processQueue(10) must still exist');
  assert.ok(WORKER_SRC.includes('async scheduled('),
    'scheduled() must still exist');
});

test('H4-23: shared notification code untouched (notification_platform.js)', () => {
  const npSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/notification_platform.js'), 'utf8');
  assert.ok(npSrc.includes('async function sendNotification'),
    'sendNotification must still exist in notification_platform.js');
  assert.ok(npSrc.includes('ON CONFLICT (id) DO NOTHING'),
    'ON CONFLICT (id) DO NOTHING must still exist');
  assert.ok(npSrc.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'ON CONFLICT (notification_id, user_id) DO NOTHING must still exist');
});

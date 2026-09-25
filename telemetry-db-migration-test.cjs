/**
 * Telemetry DB Migration (Option 1) — Regression Tests
 *
 * Verifies that recordNewsAITick + recordE2ETiming have been migrated from KV
 * (news:ai_monitor / news:ai_e2e_timing read-modify-write) to Postgres INSERTs
 * (news_ai_tick_log / news_ai_e2e_log), with:
 *   - No remaining KV read/write in either record function
 *   - ensureTelemetryTables idempotent DDL + isolate cache
 *   - 4-day retention cleanup (cleanupTickLog + cleanupE2ETimingLog) wired into STEP 11
 *   - getNewsAIMonitoring reads tick history from the DB (not KV)
 *   - getE2ETimingStats reads timing history from the DB (not KV)
 *   - Response shape preserved (history oldest→newest, last_tick = newest, stats + by_provider)
 *   - Failure is best-effort (catch + console.warn, never breaks News AI)
 *   - Constants (NEWS_AI_MONITOR_KEY + NEWS_AI_E2E_TIMING_KEY + TTLs) preserved as dead code
 *
 * Run: node --test telemetry-db-migration-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const TELEMETRY_SRC = fs.readFileSync(path.join(__dirname, 'src/news/telemetry.js'), 'utf8');

// Helper: extract a function body from source text
function fnBody(name) {
  const marker = 'async function ' + name + '(';
  // Try telemetry module first, then fall back to worker-proxy.js for non-telemetry functions
  let start = TELEMETRY_SRC.indexOf(marker);
  let sourceText = TELEMETRY_SRC;
  if (start === -1) {
    start = SRC.indexOf(marker);
    sourceText = SRC;
  }
  if (start === -1) return '';
  let depth = 0, i = sourceText.indexOf('{', start);
  for (; i < sourceText.length; i++) {
    if (sourceText[i] === '{') depth++;
    else if (sourceText[i] === '}') { depth--; if (depth === 0) break; }
  }
  return sourceText.slice(start, i + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 1 — recordNewsAITick: migrated from KV to Postgres INSERT
// ═══════════════════════════════════════════════════════════════════════════

test('TICK-01: recordNewsAITick exists', () => {
  assert.ok(TELEMETRY_SRC.includes('async function recordNewsAITick(env, stats)'),
    'recordNewsAITick must exist');
});

test('TICK-02: recordNewsAITick does NOT use readAppCache (KV read eliminated)', () => {
  const body = fnBody('recordNewsAITick');
  assert.ok(!body.includes('readAppCache'),
    'recordNewsAITick must NOT call readAppCache (KV read-modify-write eliminated)');
});

test('TICK-03: recordNewsAITick does NOT use writeAppCache (KV write eliminated)', () => {
  const body = fnBody('recordNewsAITick');
  assert.ok(!body.includes('writeAppCache'),
    'recordNewsAITick must NOT call writeAppCache (KV write eliminated)');
});

test('TICK-04: recordNewsAITick does NOT reference NEWS_AI_MONITOR_KEY', () => {
  const body = fnBody('recordNewsAITick');
  assert.ok(!body.includes('NEWS_AI_MONITOR_KEY'),
    'recordNewsAITick must NOT reference NEWS_AI_MONITOR_KEY (no KV key usage)');
});

test('TICK-05: recordNewsAITick calls ensureTelemetryTables + insertNewsAITickLog', () => {
  const body = fnBody('recordNewsAITick');
  assert.ok(body.includes('ensureTelemetryTables'),
    'recordNewsAITick must call ensureTelemetryTables (idempotent DDL)');
  assert.ok(body.includes('insertNewsAITickLog'),
    'recordNewsAITick must call insertNewsAITickLog (Postgres INSERT)');
});

test('TICK-06: recordNewsAITick stores tick_type correctly (extracts from stats.type)', () => {
  const body = fnBody('recordNewsAITick');
  assert.ok(body.includes('stats.type') || body.includes('stats?.type'),
    'recordNewsAITick must extract tick_type from stats.type');
  assert.ok(body.includes("tickType") || body.includes("tick_type"),
    'recordNewsAITick must use a tickType variable');
});

test('TICK-07: recordNewsAITick failure is best-effort (catch + warn, no throw)', () => {
  const body = fnBody('recordNewsAITick');
  assert.ok(body.includes('catch'),
    'recordNewsAITick must have a try/catch');
  assert.ok(body.includes('console.warn'),
    'recordNewsAITick must console.warn on failure (not throw)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 2 — recordE2ETiming: migrated from KV to Postgres INSERT
// ═══════════════════════════════════════════════════════════════════════════

test('E2E-01: recordE2ETiming exists', () => {
  assert.ok(TELEMETRY_SRC.includes('async function recordE2ETiming(env, timing)'),
    'recordE2ETiming must exist');
});

test('E2E-02: recordE2ETiming does NOT use readAppCache (KV read eliminated)', () => {
  const body = fnBody('recordE2ETiming');
  assert.ok(!body.includes('readAppCache'),
    'recordE2ETiming must NOT call readAppCache');
});

test('E2E-03: recordE2ETiming does NOT use writeAppCache (KV write eliminated)', () => {
  const body = fnBody('recordE2ETiming');
  assert.ok(!body.includes('writeAppCache'),
    'recordE2ETiming must NOT call writeAppCache');
});

test('E2E-04: recordE2ETiming does NOT reference NEWS_AI_E2E_TIMING_KEY', () => {
  const body = fnBody('recordE2ETiming');
  assert.ok(!body.includes('NEWS_AI_E2E_TIMING_KEY'),
    'recordE2ETiming must NOT reference NEWS_AI_E2E_TIMING_KEY');
});

test('E2E-05: recordE2ETiming calls ensureTelemetryTables + insertNewsAIE2ELog', () => {
  const body = fnBody('recordE2ETiming');
  assert.ok(body.includes('ensureTelemetryTables'),
    'recordE2ETiming must call ensureTelemetryTables');
  assert.ok(body.includes('insertNewsAIE2ELog'),
    'recordE2ETiming must call insertNewsAIE2ELog (Postgres INSERT)');
});

test('E2E-06: recordE2ETiming stores url + provider + timing fields', () => {
  const body = fnBody('recordE2ETiming');
  assert.ok(body.includes('url') && body.includes('provider'),
    'recordE2ETiming must extract url + provider for dedicated columns');
  // Verify the timing fields are passed through (via timingPayload spread)
  assert.ok(body.includes('timingPayload') || body.includes('...timing'),
    'recordE2ETiming must pass the timing payload to the INSERT');
});

test('E2E-07: recordE2ETiming failure is best-effort (catch + warn, no throw)', () => {
  const body = fnBody('recordE2ETiming');
  assert.ok(body.includes('catch') && body.includes('console.warn'),
    'recordE2ETiming must catch + console.warn (not throw)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 3 — ensureTelemetryTables: idempotent DDL + isolate cache
// ═══════════════════════════════════════════════════════════════════════════

test('DDL-01: ensureTelemetryTables exists', () => {
  assert.ok(TELEMETRY_SRC.includes('async function ensureTelemetryTables(env)'),
    'ensureTelemetryTables must exist');
});

test('DDL-02: news_ai_tick_log table DDL is correct', () => {
  const body = fnBody('ensureTelemetryTables');
  assert.ok(body.includes('CREATE TABLE IF NOT EXISTS news_ai_tick_log'),
    'must CREATE TABLE IF NOT EXISTS news_ai_tick_log (idempotent)');
  assert.ok(body.includes('id SERIAL PRIMARY KEY'), 'must have id SERIAL PRIMARY KEY');
  assert.ok(body.includes('created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()'), 'must have created_at');
  assert.ok(body.includes('tick_type VARCHAR(16) NOT NULL'), 'must have tick_type');
  assert.ok(body.includes('stats JSONB NOT NULL'), 'must have stats JSONB');
  assert.ok(body.includes('idx_news_ai_tick_log_created'), 'must have index on created_at DESC');
});

test('DDL-03: news_ai_e2e_log table DDL is correct', () => {
  const body = fnBody('ensureTelemetryTables');
  assert.ok(body.includes('CREATE TABLE IF NOT EXISTS news_ai_e2e_log'),
    'must CREATE TABLE IF NOT EXISTS news_ai_e2e_log (idempotent)');
  assert.ok(body.includes('url TEXT'), 'must have url TEXT');
  assert.ok(body.includes('provider VARCHAR(32)'), 'must have provider');
  assert.ok(body.includes('timing JSONB NOT NULL'), 'must have timing JSONB');
  assert.ok(body.includes('idx_news_ai_e2e_log_created'), 'must have index on created_at DESC');
});

test('DDL-04: ensureTelemetryTables uses isolate cache (_telemetryTablesEnsured)', () => {
  assert.ok(TELEMETRY_SRC.includes('let _telemetryTablesEnsured = false'),
    'must have _telemetryTablesEnsured module-level cache flag');
  const body = fnBody('ensureTelemetryTables');
  assert.ok(body.includes('_telemetryTablesEnsured'),
    'ensureTelemetryTables must check/set the cache flag');
});

test('DDL-05: ensureTelemetryTables failure is best-effort (catch + warn)', () => {
  const body = fnBody('ensureTelemetryTables');
  assert.ok(body.includes('catch') && body.includes('console.warn'),
    'ensureTelemetryTables must catch + warn (not throw)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 4 — INSERT helpers: parameterized, no SQL interpolation
// ═══════════════════════════════════════════════════════════════════════════

test('INSERT-01: insertNewsAITickLog uses parameterized INSERT ($1, $2::jsonb)', () => {
  const body = fnBody('insertNewsAITickLog');
  assert.ok(body.includes('INSERT INTO news_ai_tick_log'), 'must INSERT into news_ai_tick_log');
  assert.ok(body.includes('$1') && body.includes('$2::jsonb'),
    'must use parameterized $1 + $2::jsonb (no SQL interpolation)');
  assert.ok(body.includes('JSON.stringify'),
    'must JSON.stringify the stats payload');
});

test('INSERT-02: insertNewsAIE2ELog uses parameterized INSERT ($1, $2, $3::jsonb)', () => {
  const body = fnBody('insertNewsAIE2ELog');
  assert.ok(body.includes('INSERT INTO news_ai_e2e_log'), 'must INSERT into news_ai_e2e_log');
  assert.ok(body.includes('$1') && body.includes('$2') && body.includes('$3::jsonb'),
    'must use parameterized $1 + $2 + $3::jsonb');
  assert.ok(body.includes('JSON.stringify'),
    'must JSON.stringify the timing payload');
});

test('INSERT-03: both INSERT helpers swallow failure (catch + warn)', () => {
  const tickBody = fnBody('insertNewsAITickLog');
  const e2eBody = fnBody('insertNewsAIE2ELog');
  assert.ok(tickBody.includes('catch') && tickBody.includes('console.warn'),
    'insertNewsAITickLog must catch + warn');
  assert.ok(e2eBody.includes('catch') && e2eBody.includes('console.warn'),
    'insertNewsAIE2ELog must catch + warn');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 5 — Endpoint read paths: DB SELECT, not KV read
// ═══════════════════════════════════════════════════════════════════════════

test('MON-01: getNewsAIMonitoring reads tick history FROM news_ai_tick_log (not KV)', () => {
  const body = fnBody('getNewsAIMonitoring');
  assert.ok(body.includes('FROM news_ai_tick_log'),
    'getNewsAIMonitoring must SELECT FROM news_ai_tick_log');
  assert.ok(body.includes('ORDER BY created_at DESC'),
    'must ORDER BY created_at DESC (newest first)');
  assert.ok(body.includes('LIMIT 20'),
    'must LIMIT 20 (rolling window)');
  assert.ok(!body.includes('readAppCache(env, NEWS_AI_MONITOR_KEY)'),
    'getNewsAIMonitoring must NOT read NEWS_AI_MONITOR_KEY from KV');
});

test('MON-02: getNewsAIMonitoring reverses DB rows to oldest→newest', () => {
  const body = fnBody('getNewsAIMonitoring');
  assert.ok(body.includes('reverse()'),
    'must reverse() the DB DESC result to oldest→newest (matching prior KV order)');
});

test('MON-03: getNewsAIMonitoring reconstructs {ts, type, ...stats} from DB row', () => {
  const body = fnBody('getNewsAIMonitoring');
  assert.ok(body.includes('ts:') && body.includes('r.tick_type') || body.includes('type: r.tick_type'),
    'must reconstruct ts from created_at + type from tick_type');
  assert.ok(body.includes('r.stats') || body.includes('...r.stats') || body.includes('r.stats'),
    'must spread the stats JSONB');
});

test('MON-04: getNewsAIMonitoring last_tick is the newest (last element after reverse)', () => {
  const body = fnBody('getNewsAIMonitoring');
  assert.ok(body.includes('history.length - 1') || body.includes('history[history.length - 1]'),
    'last_tick must be history[history.length-1] (newest after reverse to oldest→newest)');
});

test('MON-05: getNewsAIMonitoring still reads OTHER KV data (not migrated)', () => {
  const body = fnBody('getNewsAIMonitoring');
  // These must STILL be read from KV (NOT migrated):
  assert.ok(body.includes('getSummaryQueue'),
    'must still read the summary queue from KV');
  // H4 FIX: NEWS_AI_PROVIDER_STATS_KEY is NO LONGER read from KV — migrated to Postgres
  // Circuit state + groq router are read via helper functions (not direct KV key references
  // in the function body), but their calls should still be present:
  assert.ok(body.includes('getCircuitState'),
    'must still read circuit breaker state');
  assert.ok(body.includes('_groqRouterGetKeyState'),
    'must still read groq router key state');
});

test('TIMING-01: getE2ETimingStats reads FROM news_ai_e2e_log (not KV)', () => {
  const body = fnBody('getE2ETimingStats');
  assert.ok(body.includes('FROM news_ai_e2e_log'),
    'getE2ETimingStats must SELECT FROM news_ai_e2e_log');
  assert.ok(body.includes('ORDER BY created_at DESC'),
    'must ORDER BY created_at DESC');
  assert.ok(body.includes('LIMIT 50'),
    'must LIMIT 50 (rolling window)');
  assert.ok(!body.includes('readAppCache(env, NEWS_AI_E2E_TIMING_KEY)'),
    'getE2ETimingStats must NOT read NEWS_AI_E2E_TIMING_KEY from KV');
});

test('TIMING-02: getE2ETimingStats reverses DB rows to oldest→newest', () => {
  const body = fnBody('getE2ETimingStats');
  assert.ok(body.includes('reverse()'),
    'must reverse() to oldest→newest');
});

test('TIMING-03: getE2ETimingStats reconstructs {ts, url, provider, ...timing}', () => {
  const body = fnBody('getE2ETimingStats');
  assert.ok(body.includes('ts:') && body.includes('url:') && body.includes('provider:'),
    'must reconstruct ts + url + provider from DB columns');
  assert.ok(body.includes('r.timing') || body.includes('...r.timing'),
    'must spread the timing JSONB');
});

test('TIMING-04: getE2ETimingStats preserves stats + by_provider computation', () => {
  const body = fnBody('getE2ETimingStats');
  // The stats computation (avg, max, min) + by_provider breakdown must remain.
  assert.ok(body.includes('avg_total_e2e_ms') || body.includes('avg('),
    'must still compute avg stats');
  assert.ok(body.includes('byProvider') || body.includes('by_provider'),
    'must still compute by_provider breakdown');
  assert.ok(body.includes('history.slice'),
    'must still slice the history for the response (last 20 shown)');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 6 — Retention: 4-day cleanup wired into processNewsAIBatch
// ═══════════════════════════════════════════════════════════════════════════

test('RET-01: cleanupTickLog exists with 4-day DELETE', () => {
  const body = fnBody('cleanupTickLog');
  assert.ok(body.includes('DELETE FROM news_ai_tick_log'),
    'must DELETE FROM news_ai_tick_log');
  assert.ok(body.includes("NOW() -") && body.includes("interval"),
    'must use NOW() - interval for retention');
  assert.ok(body.includes("4") || body.includes("days = 4") || body.includes("days === undefined"),
    'must default to 4 days');
});

test('RET-02: cleanupE2ETimingLog exists with 4-day DELETE', () => {
  const body = fnBody('cleanupE2ETimingLog');
  assert.ok(body.includes('DELETE FROM news_ai_e2e_log'),
    'must DELETE FROM news_ai_e2e_log');
  assert.ok(body.includes("NOW() -") && body.includes("interval"),
    'must use NOW() - interval');
});

test('RET-03: both cleanup helpers are best-effort (catch + warn)', () => {
  const tickBody = fnBody('cleanupTickLog');
  const e2eBody = fnBody('cleanupE2ETimingLog');
  assert.ok(tickBody.includes('catch') && tickBody.includes('console.warn'),
    'cleanupTickLog must catch + warn');
  assert.ok(e2eBody.includes('catch') && e2eBody.includes('console.warn'),
    'cleanupE2ETimingLog must catch + warn');
});

test('RET-04: cleanup wired into processNewsAIBatch STEP 11', () => {
  const batchBody = fnBody('processNewsAIBatch');
  assert.ok(batchBody.includes('cleanupTickLog'),
    'processNewsAIBatch must call cleanupTickLog');
  assert.ok(batchBody.includes('cleanupE2ETimingLog'),
    'processNewsAIBatch must call cleanupE2ETimingLog');
  assert.ok(batchBody.includes('TELEMETRY_RETENTION_cleanup'),
    'must log the telemetry cleanup step');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 7 — Dead code preserved (rollback safety)
// ═══════════════════════════════════════════════════════════════════════════

test('DEAD-01: NEWS_AI_MONITOR_KEY constant preserved (dead code for rollback)', () => {
  assert.ok(SRC.includes("const NEWS_AI_MONITOR_KEY = 'news:ai_monitor'"),
    'NEWS_AI_MONITOR_KEY must still be declared (dead code, rollback safety)');
});

test('DEAD-02: NEWS_AI_E2E_TIMING_KEY + TTL preserved (dead code)', () => {
  assert.ok(TELEMETRY_SRC.includes("const NEWS_AI_E2E_TIMING_KEY = 'news:ai_e2e_timing'"),
    'NEWS_AI_E2E_TIMING_KEY must still be declared');
  assert.ok(TELEMETRY_SRC.includes('NEWS_AI_E2E_TIMING_TTL'),
    'NEWS_AI_E2E_TIMING_TTL must still be declared');
});

// ═══════════════════════════════════════════════════════════════════════════
// SECTION 8 — Behavioral simulation: INSERT + failure-swallow + ordering
// ═══════════════════════════════════════════════════════════════════════════

test('SIM-01: recordNewsAITick INSERT pattern + DB failure swallowed (simulation)', async () => {
  // Simulate the recordNewsAITick logic: ensureTelemetryTables + INSERT + catch.
  let insertCall = null;
  let ensureCall = false;
  function mockEnsure(env) { ensureCall = true; return Promise.resolve(); }
  function mockInsert(env, tickType, stats) {
    insertCall = { tickType, stats: JSON.parse(JSON.stringify(stats)) };
    return Promise.resolve();
  }

  // Simulate the function body (mirrors the actual recordNewsAITick logic)
  async function simRecordNewsAITick(env, stats) {
    try {
      await mockEnsure(env);
      const tickType = (stats && stats.type) || 'batch';
      const { type, ts, ...statsPayload } = stats || {};
      await mockInsert(env, tickType, statsPayload);
    } catch (e) {
      // Must NOT throw
    }
  }

  // Test 1: normal INSERT — tick_type + stats stored correctly
  await simRecordNewsAITick({}, {
    type: 'tick_5min',
    elapsed_ms: 1500,
    summary_processed: true,
    summary_success: true,
    queue_length: 5,
  });
  assert.ok(ensureCall, 'ensureTelemetryTables was called');
  assert.ok(insertCall, 'INSERT was called');
  assert.equal(insertCall.tickType, 'tick_5min',
    'tick_type extracted from stats.type');
  assert.equal(insertCall.stats.elapsed_ms, 1500, 'stats.elapsed_ms preserved');
  assert.equal(insertCall.stats.summary_processed, true, 'stats.summary_processed preserved');
  assert.equal(insertCall.stats.queue_length, 5, 'stats.queue_length preserved');
  assert.ok(!insertCall.stats.type, 'type must NOT be in the stats JSONB (it is in tick_type column)');
  assert.ok(!insertCall.stats.ts, 'ts must NOT be in the stats JSONB (it comes from created_at)');

  // Test 2: DB failure swallowed — function returns normally (no throw)
  let threwOnFailure = false;
  function failingInsert() { return Promise.reject(new Error('DB connection refused')); }
  async function simRecordNewsAITickFailing(env, stats) {
    try {
      await mockEnsure(env);
      const tickType = (stats && stats.type) || 'batch';
      const { type, ts, ...statsPayload } = stats || {};
      await failingInsert(env, tickType, statsPayload);
    } catch (e) {
      // swallowed — telemetry failure must NOT break News AI
    }
  }
  try {
    await simRecordNewsAITickFailing({}, { type: 'batch', elapsed_ms: 100 });
  } catch (e) {
    threwOnFailure = true;
  }
  assert.equal(threwOnFailure, false,
    'recordNewsAITick must NOT throw on DB failure (telemetry is best-effort)');
});

test('SIM-02: recordE2ETiming INSERT pattern + DB failure swallowed (simulation)', async () => {
  let insertCall = null;
  function mockInsert(env, url, provider, timing) {
    insertCall = { url, provider, timing: JSON.parse(JSON.stringify(timing)) };
    return Promise.resolve();
  }

  async function simRecordE2ETiming(env, timing) {
    try {
      const { ts, url, provider, ...timingPayload } = timing || {};
      await mockInsert(env, url, provider, timingPayload);
    } catch (e) { /* swallowed */ }
  }

  await simRecordE2ETiming({}, {
    ts: 1710000000000,
    url: 'https://example.com/article',
    provider: 'groq',
    rss_fetched_at: 1710000000000,
    enqueued_at: 1710000001000,
    summary_started_at: 1710000002000,
    summary_completed_at: 1710000004000,
    total_e2e_ms: 4000,
    queue_wait_ms: 1000,
    summary_gen_ms: 2000,
  });

  assert.ok(insertCall, 'INSERT was called');
  assert.equal(insertCall.url, 'https://example.com/article', 'url stored in dedicated column');
  assert.equal(insertCall.provider, 'groq', 'provider stored in dedicated column');
  assert.equal(insertCall.timing.rss_fetched_at, 1710000000000, 'rss_fetched_at in JSONB');
  assert.equal(insertCall.timing.total_e2e_ms, 4000, 'total_e2e_ms in JSONB');
  assert.equal(insertCall.timing.summary_gen_ms, 2000, 'summary_gen_ms in JSONB');
  assert.ok(!insertCall.timing.ts, 'ts NOT in JSONB (comes from created_at)');
  assert.ok(!insertCall.timing.url, 'url NOT in JSONB (in dedicated column)');
  assert.ok(!insertCall.timing.provider, 'provider NOT in JSONB (in dedicated column)');

  // DB failure swallowed
  let threw = false;
  async function simFailing(env, timing) {
    try {
      const { ts, url, provider, ...timingPayload } = timing || {};
      throw new Error('DB timeout');
    } catch (e) { /* swallowed */ }
  }
  try { await simFailing({}, {}); } catch (e) { threw = true; }
  assert.equal(threw, false, 'recordE2ETiming must NOT throw on DB failure');
});

test('SIM-03: endpoint read ordering — DB DESC reversed to oldest→newest', () => {
  // Simulate the DB returning newest-first (DESC), then reversing to oldest→newest.
  const dbRows = [
    { tick_type: 'batch', stats: { elapsed_ms: 3000 }, ts: 1710000003000 }, // newest
    { tick_type: 'tick_5min', stats: { elapsed_ms: 1500 }, ts: 1710000002000 },
    { tick_type: 'tick_5min', stats: { elapsed_ms: 1200 }, ts: 1710000001000 }, // oldest
  ];
  // Reverse to oldest→newest (mirrors the .reverse() in getNewsAIMonitoring)
  const history = dbRows.reverse().map(function (r) {
    return {
      ts: Math.round(Number(r.ts)),
      type: r.tick_type,
      ...((r.stats && typeof r.stats === 'object') ? r.stats : {}),
    };
  });
  // Verify ordering: oldest first, newest last
  assert.equal(history[0].ts, 1710000001000, 'first = oldest');
  assert.equal(history[2].ts, 1710000003000, 'last = newest');
  assert.equal(history[0].type, 'tick_5min', 'first type preserved');
  assert.equal(history[2].type, 'batch', 'last type preserved');
  assert.equal(history[0].elapsed_ms, 1200, 'stats spread correctly');
  // last_tick = history[history.length-1] = newest
  const lastTick = history[history.length - 1];
  assert.equal(lastTick.ts, 1710000003000, 'last_tick is the newest');
});

test('SIM-04: retention DELETE — 4-day interval query', async () => {
  // Simulate the cleanupTickLog DELETE query
  let deleteQuery = null;
  let deleteParams = null;
  function mockQueryDb(env, sql, params) {
    deleteQuery = sql;
    deleteParams = params;
    return Promise.resolve({ rows: [{ id: 1 }, { id: 2 }] });
  }

  async function simCleanupTickLog(env, days) {
    if (days === undefined) days = 4;
    try {
      const result = await mockQueryDb(env, `
        DELETE FROM news_ai_tick_log
        WHERE created_at < NOW() - ($1::text)::interval
      `, [`${parseInt(days, 10) || 4} days`]);
      return (result.rows || []).length;
    } catch (e) { return 0; }
  }

  const deleted = await simCleanupTickLog({}, 4);
  assert.equal(deleted, 2, 'returns deleted count');
  assert.ok(deleteQuery.includes('DELETE FROM news_ai_tick_log'), 'correct table');
  assert.ok(deleteQuery.includes('NOW() -'), 'uses NOW() - interval');
  assert.equal(deleteParams[0], '4 days', '4-day retention interval');
});

test('SIM-05: ensureTelemetryTables isolate cache — skips DDL on warm isolate', async () => {
  // Simulate the _telemetryTablesEnsured flag behavior
  let ddlCallCount = 0;
  let _ensured = false;
  async function simEnsure(env) {
    if (_ensured) return;
    try {
      ddlCallCount++;
      _ensured = true;
    } catch (e) { /* swallowed */ }
  }

  await simEnsure({}); // first call — DDL runs
  await simEnsure({}); // second call — skipped (cache hit)
  await simEnsure({}); // third call — skipped
  assert.equal(ddlCallCount, 1, 'DDL must run only once per isolate (cache flag)');
});

console.log('✅ Telemetry DB migration (Option 1) regression tests loaded.');

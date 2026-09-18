/**
 * Groq DO Monitor Fix — Regression Test
 *
 * Monitoring fix: /api/news-ai-monitor now reads Groq key states from the
 * Durable Object (getStates action) when GROQ_ROUTER_DO is available, instead
 * of from KV (which is stale when the DO path is active in production).
 *
 * Changes verified by this test:
 *   1. getNewsAIMonitoring tries DO getStates before KV
 *   2. KV fallback preserved when DO unavailable
 *   3. Response includes groq_router_source field
 *   4. No secrets/API keys in response
 *   5. getStates is read-only (no storage.put mutation)
 *   6. Provider behavior unchanged (routing, selection, batch, threshold)
 *   7. Existing monitor fields preserved (groq_router_keys, etc.)
 *
 * All assertions are read-only source-code checks — no production behavior change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ─── Tests ───────────────────────────────────────────────────────────────────

test('DO-MONITOR-01: getNewsAIMonitoring tries DO getStates before KV', () => {
  // The DO path should be attempted BEFORE the KV fallback
  const doPathIdx = WORKER_SRC.indexOf("doStub.fetch('https://do/?action=getStates'");
  const kvFallbackIdx = WORKER_SRC.indexOf('// KV fallback: if DO path failed');
  assert.ok(doPathIdx > 0, 'DO getStates fetch must exist');
  assert.ok(kvFallbackIdx > 0, 'KV fallback must exist');
  assert.ok(doPathIdx < kvFallbackIdx, 'DO path must come BEFORE KV fallback');
});

test('DO-MONITOR-02: DO path is gated on env.GROQ_ROUTER_DO.idFromName availability', () => {
  // FIX: DurableObjectNamespace does NOT have .fetch() — that's on the stub.
  // Must check .idFromName (a method on the namespace itself).
  assert.ok(
    WORKER_SRC.includes("typeof env.GROQ_ROUTER_DO.idFromName === 'function'"),
    'DO path must check GROQ_ROUTER_DO.idFromName (NOT .fetch — .fetch is on the stub, not the namespace)'
  );
  assert.ok(
    !WORKER_SRC.includes("typeof env.GROQ_ROUTER_DO.fetch === 'function'"),
    'Must NOT use old .fetch check (always false on DurableObjectNamespace in ES Module API)'
  );
});

test('DO-MONITOR-03: groq_router_source field exists in response', () => {
  assert.ok(
    WORKER_SRC.includes("groq_router_source: groq_router_source"),
    'Response must include groq_router_source field'
  );
  assert.ok(
    WORKER_SRC.includes("groq_router_source = 'durable_object'"),
    'Source must be set to durable_object when DO path succeeds'
  );
  assert.ok(
    WORKER_SRC.includes("groq_router_source = 'kv_fallback'"),
    'Source must default to kv_fallback when DO path unavailable'
  );
});

test('DO-MONITOR-04: KV fallback preserved when DO unavailable', () => {
  // The KV fallback loop must still exist and use _groqRouterGetKeyState
  const kvFallbackSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('// KV fallback: if DO path failed'),
    WORKER_SRC.indexOf('// KV fallback: if DO path failed') + 1000
  );
  assert.ok(kvFallbackSection.includes('_groqRouterGetKeyState'), 'KV fallback must use _groqRouterGetKeyState');
  assert.ok(kvFallbackSection.includes('for (let i = 0; i < 4; i++)'), 'KV fallback must loop over 4 keys');
});

test('DO-MONITOR-05: No secrets/API keys in monitor response', () => {
  // The response should NOT include raw API key values — only 'configured' boolean
  const grkIdx = WORKER_SRC.indexOf('groq_router_keys: groqRouterKeys');
  const responseSection = WORKER_SRC.slice(grkIdx, grkIdx + 500);
  assert.ok(!responseSection.includes('GROQ_API_KEY)'), 'Must NOT expose raw GROQ_API_KEY value (only Boolean)');
  assert.ok(responseSection.includes('groq_router_source'), 'Must include groq_router_source');
  assert.ok(!responseSection.includes('Bearer'), 'Must NOT expose Bearer headers');
});

test('DO-MONITOR-06: getStates action is read-only (no storage.put)', () => {
  // Extract the getStates action block
  const getStatesStart = WORKER_SRC.indexOf("if (action === 'getStates')");
  const getStatesEnd = WORKER_SRC.indexOf("return new Response('Unknown action'", getStatesStart);
  const getStatesBlock = WORKER_SRC.slice(getStatesStart, getStatesEnd);
  
  assert.ok(getStatesBlock.length > 0, 'getStates action must exist');
  assert.ok(getStatesBlock.includes('_getKeyState'), 'getStates must call _getKeyState');
  assert.ok(!getStatesBlock.includes('storage.put'), 'getStates must NOT call storage.put (read-only)');
  assert.ok(!getStatesBlock.includes('_setKeyState'), 'getStates must NOT call _setKeyState (read-only)');
});

test('DO-MONITOR-07: _getKeyState is read-only (no storage.put)', () => {
  // Extract the _getKeyState method
  const getKeyStateStart = WORKER_SRC.indexOf('async _getKeyState(keyIndex)');
  const getKeyStateEnd = WORKER_SRC.indexOf('async _setKeyState', getKeyStateStart);
  const getKeyStateBlock = WORKER_SRC.slice(getKeyStateStart, getKeyStateEnd);
  
  assert.ok(getKeyStateBlock.length > 0, '_getKeyState method must exist');
  assert.ok(getKeyStateBlock.includes('storage.get'), '_getKeyState must read from storage');
  assert.ok(!getKeyStateBlock.includes('storage.put'), '_getKeyState must NOT write to storage (read-only)');
});

test('DO-MONITOR-08: getStates includes probe_failures in response', () => {
  // The DO getStates response should include probe_failures
  const getStatesStart = WORKER_SRC.indexOf("if (action === 'getStates')");
  const getStatesEnd = WORKER_SRC.indexOf("return new Response('Unknown action'", getStatesStart);
  const getStatesBlock = WORKER_SRC.slice(getStatesStart, getStatesEnd);
  
  assert.ok(getStatesBlock.includes('probe_failures'), 'getStates must include probe_failures in response');
});

test('DO-MONITOR-09: DO path uses idFromName("groq-router") for consistent DO instance', () => {
  // The DO ID must be derived from a stable name so the same DO instance is used
  // for both reserve/record (in groqRouterExecute) and getStates (in monitoring)
  const monitorDoId = WORKER_SRC.indexOf("idFromName('groq-router')", WORKER_SRC.indexOf('MONITORING FIX'));
  const routerDoId = WORKER_SRC.indexOf("idFromName('groq-router')", WORKER_SRC.indexOf('groqRouterExecute'));
  
  assert.ok(monitorDoId > 0, 'Monitor DO path must use idFromName("groq-router")');
  assert.ok(routerDoId > 0, 'Router DO path must use idFromName("groq-router")');
  // Both use the same DO name → same DO instance → consistent state
});

test('DO-MONITOR-10: DO monitoring call does NOT appear in cron/scheduled path', () => {
  // The getStates call should ONLY be in getNewsAIMonitoring (HTTP handler),
  // NOT in the scheduled() handler or processOneArticleSummary
  const scheduledStart = WORKER_SRC.indexOf('async scheduled(');
  const scheduledEnd = WORKER_SRC.indexOf('},', scheduledStart + 10000); // end of scheduled handler
  const scheduledBlock = WORKER_SRC.slice(scheduledStart, scheduledEnd);
  
  assert.ok(!scheduledBlock.includes('getStates'), 'getStates must NOT be called from scheduled/cron handler');
  assert.ok(!scheduledBlock.includes('action=getStates'), 'getStates URL must NOT appear in cron path');
});

test('DO-MONITOR-11: Provider routing behavior unchanged', () => {
  // The monitoring fix must NOT change any routing behavior
  assert.ok(WORKER_SRC.includes('async function groqRouterExecute'), 'groqRouterExecute must still exist');
  assert.ok(WORKER_SRC.includes('async function generateSummaryWithFallback'), 'generateSummaryWithFallback must still exist');
  assert.ok(WORKER_SRC.includes("attemptProvider('groq'"), 'Groq provider must still be attempted');
  assert.ok(WORKER_SRC.includes("attemptProvider('openrouter'"), 'OpenRouter provider must still be attempted');
  assert.ok(WORKER_SRC.includes("attemptProvider('workers-ai'"), 'Workers AI provider must still be attempted');
});

test('DO-MONITOR-12: H5 safeguards unchanged', () => {
  assert.ok(WORKER_SRC.includes('MAX_SUMMARIES_PER_TICK = 2'), 'MAX_SUMMARIES_PER_TICK must remain 2');
  assert.ok(WORKER_SRC.includes('articleText.length < 150'), 'Source threshold must remain 150');
  assert.ok(WORKER_SRC.includes('articleText.length < 50'), 'text_too_short must remain 50');
  assert.ok(WORKER_SRC.includes('sanitizedSummary.trim().length >= 200'), 'Summary output minimum must remain 200');
  assert.ok(WORKER_SRC.includes('GROQ_ROUTER_MAX_PER_WINDOW = 3'), 'Window limit must remain 3');
});

test('DO-MONITOR-13: Existing monitor fields preserved', () => {
  // Find the main response return — it starts with 'return {' followed by 'ts: now,'
  const fnStart = WORKER_SRC.indexOf('async function getNewsAIMonitoring');
  const returnIdx = WORKER_SRC.indexOf('return {\n    ts: now,', fnStart);
  assert.ok(returnIdx > 0, 'Main response return must exist');
  const responseEnd = WORKER_SRC.indexOf('\n  };', returnIdx);
  const responseBlock = WORKER_SRC.slice(returnIdx, responseEnd);
  
  const requiredFields = [
    'queue_length', 'pending_count', 'failed_count', 'cache_hit_rate',
    'total_summaries_generated', 'provider_status', 'circuit_breaker_open_count',
    'groq_router_keys', 'groq_router_source', 'summary_cache_hits', 'summary_cache_misses',
    'failed_items', 'flags', 'config', 'providers', 'fallback_count',
    'average_provider', 'average_summary_time_ms',
  ];
  
  for (const field of requiredFields) {
    assert.ok(responseBlock.includes(field), `Response must still include '${field}'`);
  }
});

test('DO-MONITOR-14: DO getStates call is wrapped in try/catch with KV fallback', () => {
  // If the DO call fails, it must fall back to KV (not crash the monitor endpoint)
  const doPathSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('// Try DO path first'),
    WORKER_SRC.indexOf('// KV fallback')
  );
  assert.ok(doPathSection.includes('try'), 'DO path must be wrapped in try');
  assert.ok(doPathSection.includes('catch'), 'DO path must have catch');
  assert.ok(doPathSection.includes('falling back to KV'), 'Catch must log fallback message');
});

test('DO-MONITOR-15: DO getStates sends correct keyIndices', () => {
  // The DO getStates call must send keyIndices [0, 1, 2, 3]
  const doPathSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('// Try DO path first'),
    WORKER_SRC.indexOf('// KV fallback')
  );
  assert.ok(doPathSection.includes('keyIndices = [0, 1, 2, 3]'), 'Must send keyIndices [0, 1, 2, 3]');
  assert.ok(doPathSection.includes("action=getStates"), 'Must use action=getStates');
  assert.ok(doPathSection.includes('POST'), 'Must use POST method');
});

test('DO-MONITOR-16: DO response ok-status is checked before json() parse', () => {
  const doPathSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('// Try DO path first'),
    WORKER_SRC.indexOf('// KV fallback')
  );
  const okIdx = doPathSection.indexOf('!statesRes.ok');
  const jsonIdx = doPathSection.indexOf('statesRes.json()');
  assert.ok(okIdx > 0, 'Must have !statesRes.ok guard');
  assert.ok(jsonIdx > 0, 'Must call statesRes.json()');
  assert.ok(okIdx < jsonIdx, '!statesRes.ok guard must come BEFORE statesRes.json()');
  assert.ok(doPathSection.includes('throw new Error'), 'Non-OK response must throw (caught by catch → KV fallback)');
});

test('DO-MONITOR-17: No diagnostic [DO-DIAG] logs remain in source', () => {
  assert.ok(!WORKER_SRC.includes('DO-DIAG'), 'Diagnostic logs must be removed');
  assert.ok(!WORKER_SRC.includes('_doCond'), 'Temporary _doCond variable must be removed');
  assert.ok(!WORKER_SRC.includes('_diagStates'), 'Temporary _diagStates variable must be removed');
});

test('DO-MONITOR-18: groqRouterExecute uses .idFromName check (not .fetch)', () => {
  // The routing code must also use the correct check
  const routerSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function groqRouterExecute'),
    WORKER_SRC.indexOf('async function groqRouterExecute') + 2000
  );
  assert.ok(
    routerSection.includes("typeof env.GROQ_ROUTER_DO.idFromName === 'function'"),
    'groqRouterExecute must use .idFromName check (NOT .fetch)'
  );
  assert.ok(
    !routerSection.includes("typeof env.GROQ_ROUTER_DO.fetch === 'function'"),
    'groqRouterExecute must NOT use old .fetch check'
  );
});

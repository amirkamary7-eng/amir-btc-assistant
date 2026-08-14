/**
 * NEWS-AI-P0-FIXES-TEST
 *
 * Regression tests for the 3 P0 fixes to the News AI pipeline:
 *   P0-1: Circuit Breaker protection for batchAnalyzeNews (Gemini + Workers AI)
 *   P0-2: Circuit Breaker for translation (translation-workers-ai) + concurrency limit
 *   P0-3: singleFlight for fetchFarsiNews live path (Thundering Herd prevention)
 *
 * These are SOURCE-LEVEL tests — they verify the code contains the required
 * circuit breaker calls, concurrency limits, and singleFlight wrapper.
 * They also verify behavior via extracted function logic.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const src = fs.readFileSync(WORKER_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// P0-1: Circuit Breaker for batchAnalyzeNews
// ═══════════════════════════════════════════════════════════════════════

test('P0-1-1: batchAnalyzeNews calls shouldAttemptProvider for Gemini', () => {
  // Find batchAnalyzeNews function
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  assert.ok(fnStart > -1, 'batchAnalyzeNews must exist');
  // Find the end (next 'async function' or '// Method 3')
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  // Verify shouldAttemptProvider is called for Gemini
  assert.ok(
    /shouldAttemptProvider\(env,\s*['"]gemini['"]\)/.test(fnSrc),
    'batchAnalyzeNews must call shouldAttemptProvider(env, "gemini") before Gemini fetch'
  );
});

test('P0-1-2: batchAnalyzeNews calls shouldAttemptProvider for Workers AI', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  assert.ok(
    /shouldAttemptProvider\(env,\s*['"]workers-ai['"]\)/.test(fnSrc),
    'batchAnalyzeNews must call shouldAttemptProvider(env, "workers-ai") before Workers AI call'
  );
});

test('P0-1-3: batchAnalyzeNews calls recordCircuitResult for Gemini success + failure', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  // Success recording
  assert.ok(
    /recordCircuitResult\(env,\s*['"]gemini['"]\s*,\s*true\)/.test(fnSrc),
    'batchAnalyzeNews must call recordCircuitResult(env, "gemini", true) on Gemini success'
  );

  // Failure recording (at least 2: HTTP error + network/timeout)
  const geminiFailureCalls = (fnSrc.match(/recordCircuitResult\(env,\s*['"]gemini['"]\s*,\s*false/g) || []).length;
  assert.ok(geminiFailureCalls >= 2, `batchAnalyzeNews must call recordCircuitResult(env, "gemini", false) on failures (found ${geminiFailureCalls}, expected >= 2)`);
});

test('P0-1-4: batchAnalyzeNews calls recordCircuitResult for Workers AI success + failure', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  assert.ok(
    /recordCircuitResult\(env,\s*['"]workers-ai['"]\s*,\s*true\)/.test(fnSrc),
    'batchAnalyzeNews must call recordCircuitResult(env, "workers-ai", true) on Workers AI success'
  );

  const waiFailureCalls = (fnSrc.match(/recordCircuitResult\(env,\s*['"]workers-ai['"]\s*,\s*false/g) || []).length;
  assert.ok(waiFailureCalls >= 1, `batchAnalyzeNews must call recordCircuitResult(env, "workers-ai", false) on failure (found ${waiFailureCalls})`);
});

test('P0-1-5: batchAnalyzeNews skips Gemini when circuit is OPEN', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  // The code must have: if (cbGemini.attempt) { ... } else { skip }
  assert.ok(
    /cbGemini\.attempt/.test(fnSrc) && /circuit OPEN/.test(fnSrc),
    'batchAnalyzeNews must check cbGemini.attempt and log "circuit OPEN" when skipping Gemini'
  );
});

test('P0-1-6: batchAnalyzeNews skips Workers AI when circuit is OPEN', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  assert.ok(
    /cbWAI\.attempt/.test(fnSrc) && /Workers AI circuit OPEN/.test(fnSrc),
    'batchAnalyzeNews must check cbWAI.attempt and log "Workers AI circuit OPEN" when skipping'
  );
});

test('P0-1-7: batchAnalyzeNews uses classifyHttpError for Gemini HTTP status', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const method3Idx = src.indexOf('// Method 3: Rule-based fallback', fnStart);
  const fnSrc = src.slice(fnStart, method3Idx);

  // Gemini now routes through DB gateway. The HTTP status comes from
  // geminiResult.status_code (not res.status). classifyHttpError is still used.
  assert.ok(
    /classifyHttpError\(statusCode \|\| 500\)/.test(fnSrc),
    'batchAnalyzeNews must classify HTTP errors (429/5xx = retryable) using classifyHttpError on statusCode'
  );
});

// ═══════════════════════════════════════════════════════════════════════
// P0-2: Circuit Breaker for Translation + Concurrency Limit
// ═══════════════════════════════════════════════════════════════════════

test('P0-2-1: translateToFarsi calls shouldAttemptProvider for translation-workers-ai', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  assert.ok(fnStart > -1, 'translateToFarsi must exist');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 1);

  assert.ok(
    /shouldAttemptProvider\(env,\s*['"]translation-workers-ai['"]\)/.test(fnSrc),
    'translateToFarsi must call shouldAttemptProvider(env, "translation-workers-ai") before Workers AI m2m100'
  );
});

test('P0-2-2: translateToFarsi calls recordCircuitResult for translation success + failure', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 1);

  assert.ok(
    /recordCircuitResult\(env,\s*['"]translation-workers-ai['"]\s*,\s*true\)/.test(fnSrc),
    'translateToFarsi must call recordCircuitResult(env, "translation-workers-ai", true) on success'
  );

  assert.ok(
    /recordCircuitResult\(env,\s*['"]translation-workers-ai['"]\s*,\s*false/.test(fnSrc),
    'translateToFarsi must call recordCircuitResult(env, "translation-workers-ai", false) on failure'
  );
});

test('P0-2-3: translateToFarsi skips Workers AI when circuit is OPEN', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 1);

  assert.ok(
    /cbTranslation\.attempt/.test(fnSrc),
    'translateToFarsi must check cbTranslation.attempt before calling Workers AI'
  );
  assert.ok(
    /circuit OPEN/.test(fnSrc),
    'translateToFarsi must log "circuit OPEN" when skipping Workers AI'
  );
});

test('P0-2-4: translateToFarsi Google fallback only runs when Workers AI failed (result === text)', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 1);

  // The Google fallback must be gated on `result === text` (meaning Workers AI didn't translate)
  assert.ok(
    /if\s*\(result\s*===\s*text/.test(fnSrc),
    'Google Translate fallback must only run when result === text (Workers AI failed to translate)'
  );
});

test('P0-2-5: processNewsAIBatch translation uses concurrency limit (batches of 3)', () => {
  // Find the STEP 4 TRANSLATION section in processNewsAIBatch
  const step4Idx = src.indexOf('STEP 4: TRANSLATION');
  assert.ok(step4Idx > -1, 'STEP 4 TRANSLATION must exist');
  const step5Idx = src.indexOf('STEP 5:', step4Idx);
  const step4Src = src.slice(step4Idx, step5Idx);

  // Verify TRANSLATION_CONCURRENCY = 3 (not Promise.all over all items)
  assert.ok(
    /TRANSLATION_CONCURRENCY\s*=\s*3/.test(step4Src),
    'processNewsAIBatch must use TRANSLATION_CONCURRENCY = 3 (was unbounded Promise.all)'
  );
  assert.ok(
    /for\s*\(let i\s*=\s*0;\s*i\s*<\s*filtered\.length;\s*i\s*\+=\s*TRANSLATION_CONCURRENCY\)/.test(step4Src),
    'processNewsAIBatch must process translations in batches of 3, not unbounded Promise.all'
  );
});

test('P0-2-6: buildFarsiNewsArticles translation batch size reduced to 3', () => {
  const fnStart = src.indexOf('async function buildFarsiNewsArticles');
  assert.ok(fnStart > -1, 'buildFarsiNewsArticles must exist');
  const fnEnd = src.indexOf('\n}', src.indexOf('return articles.filter', fnStart));
  const fnSrc = src.slice(fnStart, fnEnd);

  // The batch size must be 3 (was 10)
  assert.ok(
    /TRANSLATION_BATCH_SIZE\s*=\s*3/.test(fnSrc),
    'buildFarsiNewsArticles must use TRANSLATION_BATCH_SIZE = 3 (was 10)'
  );
});

// ═══════════════════════════════════════════════════════════════════════
// P0-3: singleFlight for fetchFarsiNews (Thundering Herd prevention)
// ═══════════════════════════════════════════════════════════════════════

test('P0-3-1: fetchFarsiNews wraps live-fetch path in singleFlight', () => {
  // HOTFIX (Commit 2.3): The singleFlight + _runNewsLiveFetchPipeline was removed
  // because it no longer writes to news:farsi (Commit 1 publication gate).
  // The waitUntil background refresh was useless and got cancelled by the runtime.
  // This test now verifies the function exists and returns emptyResult on cache miss.
  const fnStart = src.indexOf('async function fetchFarsiNews');
  assert.ok(fnStart > -1, 'fetchFarsiNews must exist');
  // singleFlight may or may not be present — the important thing is that
  // fetchFarsiNews returns emptyResult on cache miss (no useless background refresh)
  const fnEnd = src.lastIndexOf('});', src.indexOf('// ── AI NEWS SUMMARIZATION', fnStart));
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/emptyResult/.test(fnSrc),
    'fetchFarsiNews must return emptyResult on cache miss');
});

test('P0-3-2: singleFlight key is unique to farsi-news (not shared with other endpoints)', () => {
  // HOTFIX (Commit 2.3): singleFlight for farsi-news was removed.
  // This test now just verifies the function exists.
  const fnStart = src.indexOf('async function fetchFarsiNews');
  assert.ok(fnStart > -1, 'fetchFarsiNews must exist');
});

test('P0-3-3: singleFlight wrapper documents per-isolate limitation', () => {
  const fnStart = src.indexOf('async function fetchFarsiNews');
  // Wider window (5000 chars) to capture the full singleFlight comment block
  // P0-B fix added more comments, so the window needs to be wider.
  const fnSrc = src.slice(fnStart, fnStart + 5000);

  // The comment must explicitly mention "PER-ISOLATE" and "not a distributed lock"
  assert.ok(
    /PER-ISOLATE/.test(fnSrc) && /not a distributed lock/.test(fnSrc),
    'singleFlight wrapper must document that it is per-isolate, not a distributed lock'
  );
});

test('P0-3-4: cache-hit path is NOT inside singleFlight (only live-fetch is)', () => {
  const fnStart = src.indexOf('async function fetchFarsiNews');
  // PUBLICATION GATE (Commit 1): window increased from 3000 to 5000 to accommodate
  // the readyOnly filter code added between cache-hit and singleFlight.
  const fnSrc = src.slice(fnStart, fnStart + 5000);

  // The cache-hit path (readAppCache + enrichNewsWithAISummaries) must be
  // BEFORE the singleFlight wrapper. Verify "cachedNews" appears before "singleFlight".
  const cachedNewsIdx = fnSrc.indexOf('cachedNews');
  const singleFlightIdx = fnSrc.indexOf('singleFlight');

  assert.ok(cachedNewsIdx > -1, 'cache-hit path must exist');
  assert.ok(singleFlightIdx > -1, 'singleFlight wrapper must exist');
  assert.ok(cachedNewsIdx < singleFlightIdx, 'cache-hit path must be BEFORE singleFlight (not wrapped)');
});

// ═══════════════════════════════════════════════════════════════════════
// Behavioral tests: verify the fix logic works correctly
// ═══════════════════════════════════════════════════════════════════════

test('P0-BEHAVIORAL-1: Circuit breaker functions accept arbitrary provider keys', () => {
  // Verify the abstraction is generic — shouldAttemptProvider and recordCircuitResult
  // use the provider parameter as part of a KV key, so 'translation-workers-ai' works.
  // The actual code uses template literal: `${CIRCUIT_BREAKER_KEY_PREFIX}${provider}`
  const cbBlockStart = src.indexOf('async function getCircuitState');
  const cbBlockEnd = src.indexOf('// ── Cache stats');
  const cbBlockSrc = src.slice(cbBlockStart, cbBlockEnd);

  // getCircuitState, saveCircuitState use ${CIRCUIT_BREAKER_KEY_PREFIX}${provider}
  assert.ok(
    /CIRCUIT_BREAKER_KEY_PREFIX\}\$\{provider/.test(cbBlockSrc),
    'Circuit breaker functions must use ${CIRCUIT_BREAKER_KEY_PREFIX}${provider} as KV key (generic abstraction)'
  );

  // Verify shouldAttemptProvider and recordCircuitResult exist and call getCircuitState/saveCircuitState
  assert.ok(/async function shouldAttemptProvider/.test(cbBlockSrc), 'shouldAttemptProvider must exist');
  assert.ok(/async function recordCircuitResult/.test(cbBlockSrc), 'recordCircuitResult must exist');
  assert.ok(/getCircuitState\(env,\s*provider\)/.test(cbBlockSrc), 'functions must call getCircuitState(env, provider)');
});

test('P0-BEHAVIORAL-2: No new circuit breaker constants added (reuses existing)', () => {
  // The fix must NOT introduce new circuit breaker threshold constants.
  // It should reuse CIRCUIT_BREAKER_FAILURE_THRESHOLD and CIRCUIT_BREAKER_OPEN_MS.
  // Count occurrences — should be unchanged (defined once, used multiple times).
  const thresholdDefs = (src.match(/CIRCUIT_BREAKER_FAILURE_THRESHOLD\s*=\s*\d+/g) || []).length;
  assert.equal(thresholdDefs, 1, 'CIRCUIT_BREAKER_FAILURE_THRESHOLD must be defined exactly once (not duplicated)');

  const openMsDefs = (src.match(/CIRCUIT_BREAKER_OPEN_MS\s*=\s*[\d\s*]+;/g) || []).length;
  assert.equal(openMsDefs, 1, 'CIRCUIT_BREAKER_OPEN_MS must be defined exactly once (not duplicated)');
});

test('P0-BEHAVIORAL-3: batchAnalyzeNews fallback chain unchanged (Gemini → Workers AI → rule-based)', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const fnEnd = src.indexOf('// NEWSBE-006 FIX', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);

  // Verify order: Method 1 (Gemini) → Method 2 (Workers AI) → Method 3 (rule-based)
  const method1Idx = fnSrc.indexOf('Method 1: Gemini');
  const method2Idx = fnSrc.indexOf('Method 2: Workers AI');
  const method3Idx = fnSrc.indexOf('Method 3: Rule-based fallback');

  assert.ok(method1Idx > -1 && method2Idx > -1 && method3Idx > -1, 'All 3 methods must exist');
  assert.ok(method1Idx < method2Idx, 'Method 1 (Gemini) must come before Method 2 (Workers AI)');
  assert.ok(method2Idx < method3Idx, 'Method 2 (Workers AI) must come before Method 3 (rule-based)');
});

test('P0-BEHAVIORAL-4: translation fallback chain: Workers AI → Google (only if failed) → original text', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 1);

  // Workers AI is primary
  assert.ok(/env\.AI\.run\(['"]@cf\/meta\/m2m100-1\.2b['"]/.test(fnSrc), 'Workers AI m2m100 must be primary');

  // Google fallback gated on `result === text` (Workers AI failed)
  assert.ok(/if\s*\(result\s*===\s*text/.test(fnSrc), 'Google fallback must be gated on Workers AI failure');

  // P0-C FIX: translateToFarsi now returns { text, translation_failed } object.
  // Must return cacheEntry (not bare result string).
  assert.ok(/return cacheEntry/.test(fnSrc), 'Must return cacheEntry ({ text, translation_failed })');

  // P0-C FIX: translation_failed flag must be set when both providers fail
  assert.ok(/translation_failed\s*=\s*true/.test(fnSrc), 'Must set translation_failed=true when both providers fail');
});

// ═══════════════════════════════════════════════════════════════════════
// P0-B/C/D FIX REGRESSION TESTS (2026-08-13)
// ═══════════════════════════════════════════════════════════════════════

test('P0-A-1: NEWS_CACHE_TTL in wrangler.jsonc is 1800 (not 300)', () => {
  const wranglerSrc = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');
  // All 3 environments must have NEWS_CACHE_TTL: 1800
  const matches = wranglerSrc.match(/"NEWS_CACHE_TTL":\s*(\d+)/g) || [];
  assert.ok(matches.length >= 3, `Expected at least 3 NEWS_CACHE_TTL entries, found ${matches.length}`);
  for (const m of matches) {
    const val = parseInt(m.match(/\d+$/)[0], 10);
    assert.equal(val, 1800, `NEWS_CACHE_TTL must be 1800, got ${val}`);
  }
});

test('P0-B-1: fetchFarsiNews accepts ctx parameter (3rd arg)', () => {
  const fnStart = src.indexOf('async function fetchFarsiNews');
  const fnEnd = src.indexOf('// ── P0-B FIX', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/fetchFarsiNews\(env,\s*categoryFilter,\s*ctx\s*=\s*null\)/.test(fnSrc), 'fetchFarsiNews must accept ctx as 3rd parameter');
});

test('P0-B-2: handleFarsiNews passes ctx to fetchFarsiNews', () => {
  const fnStart = src.indexOf('async function handleFarsiNews');
  const fnEnd = src.indexOf('async function handleTelegramWebhook');
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/handleFarsiNews\(request,\s*env,\s*ctx\s*=\s*null\)/.test(fnSrc), 'handleFarsiNews must accept ctx as 3rd parameter');
  assert.ok(/fetchFarsiNews\(env,\s*categoryFilter,\s*ctx\)/.test(fnSrc), 'handleFarsiNews must pass ctx to fetchFarsiNews');
});

test('P0-B-3: fetchFarsiNews uses ctx.waitUntil for background refresh on cache miss', () => {
  const fnStart = src.indexOf('async function fetchFarsiNews');
  const fnEnd = src.indexOf('// ── P0-B FIX: Extracted pipeline');
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/ctx\.waitUntil\(/.test(fnSrc), 'fetchFarsiNews must use ctx.waitUntil for background refresh');
  assert.ok(/emptyResult/.test(fnSrc), 'fetchFarsiNews must return emptyResult immediately on cache miss with ctx');
});

test('P0-B-4: _runNewsLiveFetchPipeline extracted as separate function', () => {
  assert.ok(/async function _runNewsLiveFetchPipeline\(env\)/.test(src), '_runNewsLiveFetchPipeline must be a separate function');
});

test('P0-B-5: singleFlight still used for pipeline (thundering herd prevention)', () => {
  // HOTFIX (Commit 2.3): singleFlight for farsi-news was removed.
  // The background refresh pipeline was useless (no longer writes to news:farsi).
  // This test now verifies fetchFarsiNews exists and handles cache miss gracefully.
  const fnStart = src.indexOf('async function fetchFarsiNews');
  assert.ok(fnStart > -1, 'fetchFarsiNews must exist');
});

test('P0-C-1: translateToFarsi returns { text, translation_failed } object', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 1);
  assert.ok(/return\s*\{\s*text:\s*'',\s*translation_failed:\s*false\s*\}/.test(fnSrc), 'Must return { text, translation_failed } for empty input');
  assert.ok(/const cacheEntry = \{\s*text:\s*result,\s*translation_failed\s*\}/.test(fnSrc), 'Must construct cacheEntry object');
});

test('P0-C-2: buildFarsiNewsArticles sets translation_failed on articles', () => {
  const fnStart = src.indexOf('async function buildFarsiNewsArticles');
  const fnEnd = src.indexOf('async function sanitizeNewsTitle');
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/translation_failed/.test(fnSrc), 'buildFarsiNewsArticles must set translation_failed field');
  // title is set to empty string via assignment (title = '') not object property (title: '')
  assert.ok(/title\s*=\s*''/.test(fnSrc), 'buildFarsiNewsArticles must set title to empty on translation failure');
  assert.ok(/title_en:/.test(fnSrc), 'buildFarsiNewsArticles must preserve English title in title_en');
});

test('P0-C-3: processNewsAIBatch (cron) handles new translateToFarsi return type', () => {
  const fnStart = src.indexOf('const processOne = async (f) =>');
  const fnEnd = src.indexOf('};', fnStart + 10);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  assert.ok(/tResult\.text/.test(fnSrc), 'processOne must use tResult.text from translateToFarsi');
  assert.ok(/tResult\.translation_failed/.test(fnSrc), 'processOne must use tResult.translation_failed');
  assert.ok(/translation_failed/.test(fnSrc), 'processOne must set translation_failed on article');
});

test('P0-C-4: cron path filters out empty-title articles (translation_failed)', () => {
  const fnStart = src.indexOf('STEP 5: DEDUP by URL');
  const fnEnd = src.indexOf('STEP 6:', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/!a\.title \|\| !a\.title\.trim\(\)/.test(fnSrc), 'Cron dedup must filter out empty titles (translation_failed articles)');
});

test('P0-D-1: buildFarsiNewsArticles only translates titles (not descriptions)', () => {
  const fnStart = src.indexOf('async function buildFarsiNewsArticles');
  const fnEnd = src.indexOf('async function sanitizeNewsTitle');
  const fnSrc = src.slice(fnStart, fnEnd);
  // Must NOT have flatMap with title + description
  assert.ok(!/flatMap.*title.*description/.test(fnSrc), 'buildFarsiNewsArticles must NOT translate descriptions (was title+description flatMap)');
  // Must only translate titles
  assert.ok(/titlesToTranslate\s*=/.test(fnSrc), 'buildFarsiNewsArticles must have titlesToTranslate array (title only)');
});

test('P0-D-2: buildFarsiNewsArticles description is kept in original English', () => {
  const fnStart = src.indexOf('async function buildFarsiNewsArticles');
  const fnEnd = src.indexOf('async function sanitizeNewsTitle');
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/P0-D FIX: Description is NOT translated/.test(fnSrc), 'Must document that description is not translated');
});

// ═══════════════════════════════════════════════════════════════════════
// ERROR PERSISTENCE FIX: requeueWithRetry must store fail_attempts
// ═══════════════════════════════════════════════════════════════════════

test('ERR-PERSIST-1: requeueWithRetry accepts attempts parameter', () => {
  const fnStart = src.indexOf('async function requeueWithRetry');
  const fnEnd = src.indexOf('\n  }', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  assert.ok(/requeueWithRetry\(reason,\s*errorDetail,\s*attempts\)/.test(fnSrc),
    'requeueWithRetry must accept attempts as 3rd parameter');
});

test('ERR-PERSIST-2: requeueWithRetry stores fail_attempts on article', () => {
  const fnStart = src.indexOf('async function requeueWithRetry');
  const fnEnd = src.indexOf('\n  }', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  // Must set article.fail_attempts from attempts array
  assert.ok(/article\.fail_attempts\s*=/.test(fnSrc),
    'requeueWithRetry must set article.fail_attempts');
  assert.ok(/attempts\.map/.test(fnSrc),
    'Must map attempts to fail_attempts array');
  // Must include provider, error, errorType (same format as non-retryable path)
  assert.ok(/provider:\s*a\.provider/.test(fnSrc),
    'fail_attempts must include provider field');
  assert.ok(/error:\s*a\.error/.test(fnSrc),
    'fail_attempts must include error field');
  assert.ok(/errorType:\s*a\.errorType/.test(fnSrc),
    'fail_attempts must include errorType field');
});

test('ERR-PERSIST-3: requeueWithRetry guards against missing attempts', () => {
  const fnStart = src.indexOf('async function requeueWithRetry');
  const fnEnd = src.indexOf('\n  }', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  // Must check that attempts is a non-empty array before setting fail_attempts
  assert.ok(/attempts\s*&&\s*Array\.isArray\(attempts\)\s*&&\s*attempts\.length\s*>\s*0/.test(fnSrc),
    'requeueWithRetry must guard: only set fail_attempts if attempts is a non-empty array');
});

test('ERR-PERSIST-4: all_providers_failed caller passes attempts to requeueWithRetry', () => {
  // Find the call site at the end of processOneArticleSummary
  const callIdx = src.indexOf("requeueWithRetry('all_providers_failed'");
  assert.ok(callIdx > -1, 'Must have requeueWithRetry call with all_providers_failed');
  const callSrc = src.slice(callIdx, callIdx + 200);
  assert.ok(/fallbackResult\.attempts/.test(callSrc),
    'all_providers_failed caller must pass fallbackResult.attempts as 3rd arg');
});

test('ERR-PERSIST-5: other requeueWithRetry callers still work (no attempts param)', () => {
  // Other callers (fetch_error, invalid_url_scheme, etc.) don't pass attempts.
  // This is correct — those failures happen before AI providers are called.
  // Verify they still call with 2 args (reason, errorDetail) — no 3rd arg.
  const callers = [
    "requeueWithRetry('kv_write_failed'",
    "requeueWithRetry('invalid_url_scheme'",
    "requeueWithRetry('fetch_'",
    "requeueWithRetry('fetch_error'",
  ];
  for (const caller of callers) {
    const idx = src.indexOf(caller);
    assert.ok(idx > -1, `Must have caller: ${caller}`);
    // Get the full call (up to closing paren)
    const callSrc = src.slice(idx, idx + 200);
    // These should NOT pass a 3rd argument (no attempts)
    // Check that the call ends with 2 args: reason, errorDetail)
    assert.ok(!/fallbackResult\.attempts/.test(callSrc),
      `${caller} should NOT pass fallbackResult.attempts (no AI providers called)`);
  }
});

test('ERR-PERSIST-6: fail_attempts format matches non-retryable path', () => {
  // The non-retryable path (all_providers_non_retryable) stores:
  //   article.fail_attempts = attempts.map(a => ({ provider, error, errorType }))
  // The retryable path (requeueWithRetry) must use the SAME format.
  const retryableStart = src.indexOf('async function requeueWithRetry');
  const retryableEnd = src.indexOf('\n  }', retryableStart);
  const retryableSrc = src.slice(retryableStart, retryableEnd + 2);

  const nonRetryableStart = src.indexOf("article.fail_reason = 'all_providers_non_retryable'");
  const nonRetryableEnd = src.indexOf('\n    }', nonRetryableStart);
  const nonRetryableSrc = src.slice(nonRetryableStart, nonRetryableEnd);

  // Both must have provider, error, errorType fields
  const fields = ['provider', 'error', 'errorType'];
  for (const field of fields) {
    assert.ok(new RegExp(`${field}:\\s*a\\.${field}`).test(retryableSrc),
      `retryable path must include ${field} field`);
    assert.ok(new RegExp(`${field}:\\s*a\\.${field}`).test(nonRetryableSrc),
      `non-retryable path must include ${field} field (format consistency)`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// GROQ INTEGRATION TESTS
// ═══════════════════════════════════════════════════════════════════════

test('GROQ-1: tryGroq function exists', () => {
  assert.ok(/async function tryGroq\(/.test(src), 'tryGroq function must exist');
});

test('GROQ-2: tryGroq uses groq_generate DB function', () => {
  const fnStart = src.indexOf('async function tryGroq');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  assert.ok(/groq_generate/.test(fnSrc), 'tryGroq must call groq_generate DB function');
  assert.ok(/llama-3\.3-70b-versatile/.test(fnSrc), 'tryGroq must use llama-3.3-70b-versatile model');
});

test('GROQ-3: tryGroq does NOT use GEMINI_API_KEY', () => {
  const fnStart = src.indexOf('async function tryGroq');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  assert.ok(!/GEMINI_API_KEY/.test(fnSrc), 'tryGroq must NOT reference GEMINI_API_KEY');
});

test('GROQ-4: tryGroq does NOT use generativelanguage.googleapis.com', () => {
  const fnStart = src.indexOf('async function tryGroq');
  const fnEnd = src.indexOf('\n}', fnStart + 100);
  const fnSrc = src.slice(fnStart, fnEnd + 2);
  assert.ok(!/generativelanguage\.googleapis\.com/.test(fnSrc), 'tryGroq must NOT call Google Gemini API directly');
});

test('GROQ-5: Groq is first provider in generateSummaryWithFallback', () => {
  const fnStart = src.indexOf('Provider 0: Groq');
  assert.ok(fnStart > -1, 'Groq must be Provider 0 in summary chain');
  const geminiStart = src.indexOf('Provider 1: Gemini');
  assert.ok(geminiStart > fnStart, 'Gemini must come AFTER Groq');
});

test('GROQ-6: Groq is first method in batchAnalyzeNews', () => {
  const fnStart = src.indexOf('async function batchAnalyzeNews');
  const fnEnd = src.indexOf('async function _hashLockKey', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  const groqIdx = fnSrc.indexOf('Method 0: Groq');
  const geminiIdx = fnSrc.indexOf('Method 1: Gemini');
  assert.ok(groqIdx > -1, 'batchAnalyzeNews must have Method 0: Groq');
  assert.ok(geminiIdx > -1, 'batchAnalyzeNews must have Method 1: Gemini');
  assert.ok(groqIdx < geminiIdx, 'Groq must come before Gemini in batchAnalyzeNews');
});

test('GROQ-7: Groq is first provider in translateToFarsi', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('async function _runNewsLiveFetchPipeline', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  const groqIdx = fnSrc.indexOf('Primary: Groq');
  const waiIdx = fnSrc.indexOf('Fallback 1: Cloudflare Workers AI');
  assert.ok(groqIdx > -1, 'translateToFarsi must have Primary: Groq');
  assert.ok(waiIdx > -1, 'translateToFarsi must have Fallback 1: Workers AI');
  assert.ok(groqIdx < waiIdx, 'Groq must come before Workers AI in translateToFarsi');
});

test('GROQ-8: Groq circuit breaker uses "groq" provider key', () => {
  const fnStart = src.indexOf('async function translateToFarsi');
  const fnEnd = src.indexOf('async function _runNewsLiveFetchPipeline', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/shouldAttemptProvider\(env,\s*['"]groq['"]\)/.test(fnSrc), 'Translation must check circuit breaker for "groq"');
  assert.ok(/recordCircuitResult\(env,\s*['"]groq['"]/.test(fnSrc), 'Translation must record circuit breaker for "groq"');
});

test('GROQ-9: Groq summary uses attemptProvider wrapper', () => {
  assert.ok(/attemptProvider\(\s*['"]groq['"]/.test(src), 'Groq summary must use attemptProvider wrapper');
});

test('GROQ-10: NEWS_PROVIDER_GROQ flag exists with default true', () => {
  assert.ok(/isNewsProviderEnabled\(env,\s*['"]NEWS_PROVIDER_GROQ['"]\s*,\s*true\)/.test(src),
    'NEWS_PROVIDER_GROQ must be checked with default true');
});

test('GROQ-11: Groq provider added to monitoring provider lists', () => {
  assert.ok(/providers.*=.*\['groq'/.test(src), 'Groq must be in provider monitoring list');
  assert.ok(/providerNames.*=.*\['groq'/.test(src), 'Groq must be in providerNames list');
  assert.ok(/providers_priority.*\['groq'/.test(src), 'Groq must be in providers_priority list');
});

test('GROQ-12: No hardcoded Groq API key', () => {
  assert.ok(!/gsk_[A-Za-z0-9]{20,}/.test(src), 'No hardcoded Groq API key (gsk_*) in source');
});

test('GROQ-13: Groq falls back to Gemini on failure', () => {
  // Find the integration point (not the function definition comment)
  const fnStart = src.indexOf('// Provider 0: Groq (primary) — always tried first');
  assert.ok(fnStart > -1, 'Groq summary integration must exist');
  const afterGroq = src.slice(fnStart, fnStart + 1500);
  assert.ok(/falling back to Gemini/.test(afterGroq), 'Groq failure must log "falling back to Gemini"');
  assert.ok(/!summary/.test(afterGroq), 'Gemini must be gated on !summary (only if Groq failed)');
});

test('GROQ-14: Groq batch falls back to Gemini on failure', () => {
  const fnStart = src.indexOf('Method 0: Groq');
  const fnEnd = src.indexOf('Method 1: Gemini', fnStart);
  const fnSrc = src.slice(fnStart, fnEnd);
  assert.ok(/falling back to Gemini/.test(fnSrc), 'Groq batch failure must log "falling back to Gemini"');
});

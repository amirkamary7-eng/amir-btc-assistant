/**
 * Groq Rate-Limit Handling Regression Test
 * ==========================================
 *
 * Tests the P0/P1 fixes for Groq 429 amplification + classification + cooldown.
 *
 * Run: node --test groq-429-handling-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const assistantSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');

// ════════════════════════════════════════════════════════════════════════════
// Helper: extract function source for testing pure functions
// ════════════════════════════════════════════════════════════════════════════
function extractFunction(src, name) {
  const idx = src.indexOf(`function ${name}(`);
  if (idx === -1) return null;
  // Find the closing brace
  let depth = 0;
  let start = src.indexOf('{', idx);
  let end = start;
  for (let i = start; i < src.length; i++) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') { depth--; if (depth === 0) { end = i + 1; break; } }
  }
  return src.substring(idx, end);
}

// ════════════════════════════════════════════════════════════════════════════
// P0: newsJson ReferenceError fix
// ════════════════════════════════════════════════════════════════════════════
test('P0-001: processNewsAIBatch must NOT reference undefined newsJson variable', () => {
  // The old code had: newsJsonLength: newsJson.length,
  // where newsJson was no longer declared (removed in P0 merge fix).
  // The fix: newsJsonLength: JSON.stringify(trimmed).length,
  assert.ok(
    workerSrc.includes('newsJsonLength: JSON.stringify(trimmed).length'),
    'newsJsonLength must use JSON.stringify(trimmed).length (not undefined newsJson)'
  );
  assert.ok(
    !workerSrc.includes('newsJsonLength: newsJson.length'),
    'must NOT reference undefined newsJson variable'
  );
});

test('P0-002: No bare newsJson variable reference remains in processNewsAIBatch (excluding comments)', () => {
  // Find processNewsAIBatch function body
  const fnStart = workerSrc.indexOf('async function processNewsAIBatch(');
  assert.ok(fnStart !== -1, 'processNewsAIBatch must exist');
  // Find the end (next 'async function' at same indent level)
  const fnEnd = workerSrc.indexOf('\nasync function', fnStart + 1);
  const fnBody = workerSrc.substring(fnStart, fnEnd > 0 ? fnEnd : fnStart + 5000);
  // Strip comments before checking (bare newsJson in comments is OK)
  const stripped = fnBody.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Check no bare newsJson reference in actual code (only newsJsonLength is allowed)
  const bareNewsJson = stripped.match(/\bnewsJson\b(?!Length)/g);
  assert.ok(
    !bareNewsJson || bareNewsJson.length === 0,
    `processNewsAIBatch must NOT reference bare newsJson in code (found ${bareNewsJson?.length || 0} references outside comments)`
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P1: 429 Classification (classifyGroq429)
// ════════════════════════════════════════════════════════════════════════════
test('P1-001: classifyGroq429 function exists', () => {
  assert.ok(
    workerSrc.includes('function classifyGroq429('),
    'classifyGroq429 function must exist'
  );
});

test('P1-002: TPD 429 classification (tokens per day)', () => {
  // Simulate the function with eval (it's a pure function)
  const fnSrc = extractFunction(workerSrc, 'classifyGroq429');
  const fn = new Function('return ' + fnSrc)();
  const body = '{"error":{"message":"Rate limit reached for model openai/gpt-oss-120b in organization org_01 on tokens per day (TPD): Limit 200000, Used 199607"}}';
  assert.equal(fn(429, body), 'daily_quota_tpd');
});

test('P1-003: RPD 429 classification (requests per day)', () => {
  const fnSrc = extractFunction(workerSrc, 'classifyGroq429');
  const fn = new Function('return ' + fnSrc)();
  const body = '{"error":{"message":"Rate limit reached on requests per day (RPD)"}}';
  assert.equal(fn(429, body), 'daily_quota_rpd');
});

test('P1-004: RPM 429 classification (requests per minute)', () => {
  const fnSrc = extractFunction(workerSrc, 'classifyGroq429');
  const fn = new Function('return ' + fnSrc)();
  const body = '{"error":{"message":"Rate limit reached on requests per minute (RPM)"}}';
  assert.equal(fn(429, body), 'rate_limit_rpm');
});

test('P1-005: TPM 429 classification (tokens per minute)', () => {
  const fnSrc = extractFunction(workerSrc, 'classifyGroq429');
  const fn = new Function('return ' + fnSrc)();
  const body = '{"error":{"message":"Rate limit reached on tokens per minute (TPM)"}}';
  assert.equal(fn(429, body), 'rate_limit_tpm');
});

test('P1-006: Generic 429 classification (no recognized pattern)', () => {
  const fnSrc = extractFunction(workerSrc, 'classifyGroq429');
  const fn = new Function('return ' + fnSrc)();
  const body = '{"error":{"message":"Too many requests"}}';
  assert.equal(fn(429, body), 'rate_limit_generic');
});

test('P1-007: Non-429 status returns null', () => {
  const fnSrc = extractFunction(workerSrc, 'classifyGroq429');
  const fn = new Function('return ' + fnSrc)();
  assert.equal(fn(200, '{}'), null);
  assert.equal(fn(500, '{}'), null);
});

// ════════════════════════════════════════════════════════════════════════════
// P1: Retry-After Parsing (parseGroqRetryAfter)
// ════════════════════════════════════════════════════════════════════════════
test('P1-008: parseGroqRetryAfter function exists', () => {
  assert.ok(
    workerSrc.includes('function parseGroqRetryAfter('),
    'parseGroqRetryAfter function must exist'
  );
});

test('P1-009: Parse "15m32.688s" → 933 seconds (ceil of 932.688)', () => {
  const fnSrc = extractFunction(workerSrc, 'parseGroqRetryAfter');
  const fn = new Function('return ' + fnSrc)();
  const body = 'Rate limit reached. Please try again in 15m32.688s. Need more tokens?';
  const result = fn(body);
  assert.equal(result, 933); // ceil(15*60 + 32.688) = ceil(932.688) = 933
});

test('P1-010: Parse "10m9.552s" → 610 seconds', () => {
  const fnSrc = extractFunction(workerSrc, 'parseGroqRetryAfter');
  const fn = new Function('return ' + fnSrc)();
  const body = 'Please try again in 10m9.552s';
  const result = fn(body);
  assert.equal(result, 610); // 10*60 + 10 (ceil of 9.552)
});

test('P1-011: Parse "1h30m" → 5400 seconds', () => {
  const fnSrc = extractFunction(workerSrc, 'parseGroqRetryAfter');
  const fn = new Function('return ' + fnSrc)();
  const body = 'Please try again in 1h30m';
  const result = fn(body);
  assert.equal(result, 5400); // 1*3600 + 30*60
});

test('P1-012: Parse "45s" → 45 seconds', () => {
  const fnSrc = extractFunction(workerSrc, 'parseGroqRetryAfter');
  const fn = new Function('return ' + fnSrc)();
  const body = 'retry in 45s';
  const result = fn(body);
  assert.equal(result, 45);
});

test('P1-013: Unparseable body returns null', () => {
  const fnSrc = extractFunction(workerSrc, 'parseGroqRetryAfter');
  const fn = new Function('return ' + fnSrc)();
  const body = 'Some random error without retry info';
  assert.equal(fn(body), null);
});

// ════════════════════════════════════════════════════════════════════════════
// P1: parseGroq429Info (combined)
// ════════════════════════════════════════════════════════════════════════════
test('P1-014: parseGroq429Info returns structured info for TPD 429', () => {
  // Source-text verification (parseGroq429Info calls classifyGroq429 + parseGroqRetryAfter
  // which can't be eval'd in isolation)
  const fnStart = workerSrc.indexOf('function parseGroq429Info(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 800);
  assert.ok(fnBody.includes('quota_type'), 'must compute quota_type');
  assert.ok(fnBody.includes('retry_after_seconds'), 'must compute retry_after_seconds');
  assert.ok(fnBody.includes('parsed_from_body'), 'must track parsed_from_body');
  assert.ok(fnBody.includes('classifyGroq429'), 'must call classifyGroq429');
  assert.ok(fnBody.includes('parseGroqRetryAfter'), 'must call parseGroqRetryAfter');
  // Verify fallback table has TPD=15min, RPD=1h, RPM=60s, TPM=60s, generic=10min
  assert.ok(fnBody.includes('15 * 60'), 'TPD fallback must be 15 min');
  assert.ok(fnBody.includes('60 * 60'), 'RPD fallback must be 1 hour');
  assert.ok(fnBody.includes('rate_limit_rpm: 60'), 'RPM fallback must be 60s');
  assert.ok(fnBody.includes('rate_limit_tpm: 60'), 'TPM fallback must be 60s');
});

test('P1-015: parseGroq429Info uses fallback for TPD when no retry-after in body', () => {
  // Verified in P1-014 (source-text assertion includes fallback table check)
  // This test confirms the fallback value for TPD is 15 min (900s)
  const fnStart = workerSrc.indexOf('function parseGroq429Info(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 800);
  assert.ok(fnBody.includes('daily_quota_tpd: 15 * 60'), 'TPD fallback must be 15*60=900s');
});

test('P1-016: parseGroq429Info RPM fallback is 60s', () => {
  const fnStart = workerSrc.indexOf('function parseGroq429Info(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 800);
  assert.ok(fnBody.includes('rate_limit_rpm: 60'), 'RPM fallback must be 60s');
});

// ════════════════════════════════════════════════════════════════════════════
// P1: _groqFetchWithKey returns groq_429_info
// ════════════════════════════════════════════════════════════════════════════
test('P1-017: groqRouterExecute return includes groq_429_info field', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  assert.ok(fnStart !== -1, 'groqRouterExecute must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(
    fnBody.includes('groq_429_info') && fnBody.includes('parseGroq429Info'),
    'groqRouterExecute must return groq_429_info (from parseGroq429Info)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P1: recordCircuitResult uses Groq 429 cooldown
// ════════════════════════════════════════════════════════════════════════════
test('P1-018: recordCircuitResult extracts Groq 429 cooldown from errorMessage', () => {
  const fnStart = workerSrc.indexOf('async function recordCircuitResult(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 3000);
  assert.ok(
    fnBody.includes('http_429:') && fnBody.includes('groq429CooldownMs'),
    'recordCircuitResult must extract Groq 429 cooldown from errorMessage (http_429:quota_type:seconds)'
  );
});

test('P1-019: recordCircuitResult uses groq429CooldownMs for OPEN duration (not fixed 10 min)', () => {
  const fnStart = workerSrc.indexOf('async function recordCircuitResult(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 3000);
  // The HALF_OPEN branch should use groq429CooldownMs if available
  assert.ok(
    fnBody.includes('groq429CooldownMs') && fnBody.includes('backoffMs = groq429CooldownMs'),
    'recordCircuitResult must use groq429CooldownMs as backoffMs when available'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// P1: Single HALF-OPEN probe (in-memory probe lock)
// ════════════════════════════════════════════════════════════════════════════
test('P1-020: shouldAttemptProvider has in-memory probe lock (_probeLockInMemory)', () => {
  assert.ok(
    workerSrc.includes('_probeLockInMemory'),
    'shouldAttemptProvider must use _probeLockInMemory for single-probe enforcement'
  );
});

test('P1-021: shouldAttemptProvider returns attempt:false when probe in progress', () => {
  const fnStart = workerSrc.indexOf('async function shouldAttemptProvider(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2500);
  assert.ok(
    fnBody.includes('probe_in_progress') && fnBody.includes('attempt: false'),
    'shouldAttemptProvider must return attempt:false with reason probe_in_progress when another caller is probing'
  );
})

test('P1-022: recordCircuitResult clears probe lock on HALF_OPEN completion', () => {
  const fnStart = workerSrc.indexOf('async function recordCircuitResult(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 1500);
  assert.ok(
    fnBody.includes('_probeLockInMemory.delete(provider)'),
    'recordCircuitResult must clear _probeLockInMemory when probe completes (HALF_OPEN state)'
  );
})

// ════════════════════════════════════════════════════════════════════════════
// P0: Batch→individual amplification fix
// ════════════════════════════════════════════════════════════════════════════
test('P0-023: batchTranslateToFarsi skips individual Groq fallback on 429', () => {
  const fnStart = workerSrc.indexOf('async function batchTranslateToFarsi(');
  assert.ok(fnStart !== -1, 'batchTranslateToFarsi must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(
    fnBody.includes('batchGroq429') && fnBody.includes('groq_429_info'),
    'batchTranslateToFarsi must check groq_429_info on batch result'
  );
  assert.ok(
    fnBody.includes('skipping individual Groq fallback to prevent amplification'),
    'batchTranslateToFarsi must log skipping individual Groq fallback on 429'
  );
})

test('P0-024: batchTranslateToFarsi preserves individual fallback for non-429 failures', () => {
  const fnStart = workerSrc.indexOf('async function batchTranslateToFarsi(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  // Must still have the non-429 individual fallback path
  assert.ok(
    fnBody.includes('Non-429 batch failure') && fnBody.includes('existing individual fallback'),
    'batchTranslateToFarsi must preserve individual fallback for non-429 failures (malformed/invalid output)'
  );
})

// ════════════════════════════════════════════════════════════════════════════
// P1: Central Groq availability (Chat consults News AI circuits)
// ════════════════════════════════════════════════════════════════════════════
test('P1-025: callGroqChat uses groqRouterExecute (shared 4-key router)', () => {
  const fnStart = assistantSrc.indexOf('async function callGroqChat(');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 1500);
  assert.ok(
    fnBody.includes('groqRouterExecute'),
    'callGroqChat must use groqRouterExecute (shared 4-key router)'
  );
})

test('P1-026: callGroqSecondaryChat removed (router handles all key selection)', () => {
  assert.ok(
    !assistantSrc.includes('async function callGroqSecondaryChat('),
    'callGroqSecondaryChat must be REMOVED (router handles all key selection)'
  );
})

// ════════════════════════════════════════════════════════════════════════════
// Scope protection: fallback chain + circuits unchanged
// ════════════════════════════════════════════════════════════════════════════
test('SCOPE-027: Fallback chain: Groq → OpenRouter → Workers AI → OpenAI (Gemini removed)', () => {
  // Check active code (strip comments) for attemptProvider calls
  const active = workerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  const chain = ['groq', 'openrouter', 'workers-ai', 'openai'];
  let lastIdx = -1;
  for (const p of chain) {
    const idx = active.indexOf(`attemptProvider('${p}'`);
    if (idx !== -1) {
      assert.ok(idx > lastIdx, `Provider ${p} must come after previous in chain`);
      lastIdx = idx;
    }
  }
  // Gemini must NOT be in active code
  assert.ok(!active.includes("attemptProvider('gemini'"), 'Gemini must NOT be in fallback chain (active code)');
})

test('SCOPE-028: Old groq-key0/groq-key1 replaced by router per-key state', () => {
  assert.ok(workerSrc.includes('groq:router:key'), 'Router must use groq:router:key{N} prefix');
})

test('SCOPE-029: classifyHttpError unchanged for non-429 (400/401/403/404 non-retryable)', () => {
  const fnSrc = extractFunction(workerSrc, 'classifyHttpError');
  const fn = new Function('return ' + fnSrc)();
  assert.equal(fn(400), 'non_retryable');
  assert.equal(fn(401), 'non_retryable');
  assert.equal(fn(403), 'non_retryable');
  assert.equal(fn(404), 'non_retryable');
  assert.equal(fn(500), 'retryable');
  assert.equal(fn(429), 'retryable'); // still retryable (sub-classification is separate)
})

test('SCOPE-030: Gemini removed, other provider flags intact', () => {
  ['NEWS_PROVIDER_GROQ', 'NEWS_PROVIDER_OPENROUTER',
   'NEWS_PROVIDER_WORKERS_AI', 'NEWS_PROVIDER_OPENAI'].forEach(flag => {
    assert.ok(workerSrc.includes(flag), `${flag} must exist`);
  });
  assert.ok(!workerSrc.includes('NEWS_PROVIDER_GEMINI'), 'NEWS_PROVIDER_GEMINI must be REMOVED');
})

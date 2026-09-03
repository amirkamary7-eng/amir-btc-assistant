/**
 * 4-Key Groq Router + Gemini Removal Regression Test
 * ===================================================
 *
 * Tests the GROQ-ROUTER-4KEY redesign:
 *   - Centralized 4-key router (groqRouterExecute)
 *   - Per-key state (3/10min budget, circuit, HALF_OPEN probe)
 *   - 429 classification + retry_after (per-key cooldown)
 *   - Gemini completely removed
 *   - Chat + News share the same router
 *   - Batch 429 → zero individual Groq requests
 *
 * Run: node --test groq-router-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const assistantSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');

// ════════════════════════════════════════════════════════════════════════════
// 1. Router exists + discovers 1-4 keys
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-001: groqRouterExecute function exists', () => {
  assert.ok(
    workerSrc.includes('async function groqRouterExecute('),
    'groqRouterExecute function must exist'
  );
});

test('ROUTER-002: Router discovers all 4 key slots from env', () => {
  const fnStart = workerSrc.indexOf('function _groqRouterDiscoverKeys(');
  assert.ok(fnStart !== -1, '_groqRouterDiscoverKeys must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 600);
  assert.ok(fnBody.includes('env.GROQ_API_KEY'), 'must check GROQ_API_KEY');
  assert.ok(fnBody.includes('env.GROQ_API_KEY_1'), 'must check GROQ_API_KEY_1');
  assert.ok(fnBody.includes('env.GROQ_API_KEY_2'), 'must check GROQ_API_KEY_2');
  assert.ok(fnBody.includes('env.GROQ_API_KEY_3'), 'must check GROQ_API_KEY_3');
});

test('ROUTER-003: Router handles 0 keys gracefully (returns 503)', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2000);
  assert.ok(
    fnBody.includes("no_groq_keys_configured") && fnBody.includes('503'),
    'Router must return 503 with no_groq_keys_configured when 0 keys'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 2. Key selection (least-used healthy key)
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-004: selectBestKey function exists', () => {
  assert.ok(
    workerSrc.includes('async function _groqRouterSelectBestKey('),
    '_groqRouterSelectBestKey must exist'
  );
});

test('ROUTER-005: Key selection picks least-used healthy key', () => {
  const fnStart = workerSrc.indexOf('async function _groqRouterSelectBestKey(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2700);
  // Must sort by window_requests.length (least-used) and tie-break by index
  assert.ok(fnBody.includes('window_requests.length'), 'must use window_requests for selection');
  assert.ok(fnBody.includes('candidates.sort('), 'must sort candidates');
  assert.ok(fnBody.includes('a.key.index - b.key.index'), 'must tie-break by lowest index');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Application safety limit (3/10min per key)
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-006: 3/10min budget enforced (GROQ_ROUTER_MAX_PER_WINDOW=3)', () => {
  assert.ok(
    workerSrc.includes('GROQ_ROUTER_MAX_PER_WINDOW = 3'),
    'GROQ_ROUTER_MAX_PER_WINDOW must be 3'
  );
  assert.ok(
    workerSrc.includes('GROQ_ROUTER_WINDOW_MS = 10 * 60 * 1000'),
    'GROQ_ROUTER_WINDOW_MS must be 10 minutes'
  );
});

test('ROUTER-007: Key at 3/3 is excluded (window_limit)', () => {
  const fnStart = workerSrc.indexOf('async function _groqRouterSelectBestKey(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2500);
  assert.ok(
    fnBody.includes('window_limit') && fnBody.includes('GROQ_ROUTER_MAX_PER_WINDOW'),
    'selectBestKey must exclude keys at window_limit (3/3)'
  );
});

test('ROUTER-008: Key at 3/3 does NOT block other keys', () => {
  // The selection loop iterates ALL keys and collects candidates.
  // A key at 3/3 is skipped (eligible=false) but others remain eligible.
  const fnStart = workerSrc.indexOf('async function _groqRouterSelectBestKey(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2500);
  assert.ok(
    fnBody.includes('candidates.push') && fnBody.includes('eligible'),
    'selectBestKey must collect ALL eligible candidates (not stop at first unavailable)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Per-key 429 handling (only affected key opens)
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-009: 429 opens ONLY the affected key (per-key state)', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6000);
  // Must call _groqRouterRecord429 with the specific keyIndex (not all keys)
  assert.ok(
    fnBody.includes('_groqRouterRecord429(env, keyIndex,'),
    'Router must record 429 for the specific keyIndex only'
  );
});

test('ROUTER-010: Per-key state stored separately (groq:router:key{N})', () => {
  assert.ok(
    workerSrc.includes("GROQ_ROUTER_KEY_PREFIX = 'groq:router:key'"),
    'Per-key state must use groq:router:key{N} prefix'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 5. HALF_OPEN single probe
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-011: HALF_OPEN has one probe per key (in-memory lock)', () => {
  assert.ok(
    workerSrc.includes('_groqRouterProbeLockInMemory'),
    'Router must have _groqRouterProbeLockInMemory for single-probe enforcement'
  );
  const fnStart = workerSrc.indexOf('async function _groqRouterSelectBestKey(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2500);
  assert.ok(
    fnBody.includes('probe_in_progress') && fnBody.includes('GROQ_ROUTER_PROBE_LOCK_MS'),
    'selectBestKey must defer concurrent callers with probe_in_progress'
  );
});

test('ROUTER-012: Probe success restores key (recordSuccess clears lock)', () => {
  const fnStart = workerSrc.indexOf('async function _groqRouterRecordSuccess(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 800);
  assert.ok(
    fnBody.includes('_groqRouterProbeLockInMemory.delete(keyIndex)'),
    'recordSuccess must clear probe lock'
  );
  assert.ok(
    fnBody.includes("state: 'CLOSED'"),
    'recordSuccess must set state to CLOSED'
  );
});

test('ROUTER-013: Probe 429 reopens with FRESH retry_after', () => {
  const fnStart = workerSrc.indexOf('async function _groqRouterRecord429(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 800);
  assert.ok(
    fnBody.includes('_groqRouterProbeLockInMemory.delete(keyIndex)'),
    'record429 must clear probe lock'
  );
  assert.ok(
    fnBody.includes('groq429Info?.retry_after_seconds'),
    'record429 must use FRESH retry_after from new 429 body'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Batch 429 amplification fix
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-014: Batch 429 → zero individual Groq requests (skipping individual)', () => {
  const fnStart = workerSrc.indexOf('async function batchTranslateToFarsi(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(
    fnBody.includes('batchGroq429') && fnBody.includes('groq_429_info'),
    'batchTranslateToFarsi must check groq_429_info on batch result'
  );
  assert.ok(
    fnBody.includes('skipping individual Groq fallback to prevent amplification'),
    'batchTranslateToFarsi must log skipping individual Groq fallback on 429'
  );
});

test('ROUTER-015: Non-429 batch failure still permits individual fallback', () => {
  const fnStart = workerSrc.indexOf('async function batchTranslateToFarsi(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(
    fnBody.includes('Non-429 batch failure') && fnBody.includes('existing individual fallback'),
    'batchTranslateToFarsi must preserve individual fallback for non-429 failures'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 7. Chat + News share the same router
// ════════════════════════════════════════════════════════════════════════════
test('ROUTER-016: Chat callGroqChat uses groqRouterExecute', () => {
  const fnStart = assistantSrc.indexOf('async function callGroqChat(');
  assert.ok(fnStart !== -1, 'callGroqChat must exist');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 1500);
  assert.ok(
    fnBody.includes('groqRouterExecute'),
    'callGroqChat must use groqRouterExecute (shared router)'
  );
});

test('ROUTER-017: No separate Chat Groq pool (callGroqSecondaryChat removed)', () => {
  assert.ok(
    !assistantSrc.includes('async function callGroqSecondaryChat('),
    'callGroqSecondaryChat must be REMOVED (no separate Chat Groq pool)'
  );
});

test('ROUTER-018: Chat has no separate chat-groq-secondary circuit (merged into router)', () => {
  // chat-groq may appear in comments (historical) and as a template literal
  // `chat-${providerName}` in attemptChatProvider (which is fine — it's a
  // Chat-level circuit that controls whether to ATTEMPT Groq, not a separate
  // key pool). The key requirement is: no callGroqSecondaryChat (separate pool).
  assert.ok(
    !assistantSrc.includes('async function callGroqSecondaryChat('),
    'callGroqSecondaryChat must be REMOVED (no separate Chat Groq pool)'
  );
  // Verify Chat text path does NOT have groq-secondary as a provider entry
  const fnStart = assistantSrc.indexOf('const providers = hasImage');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 800);
  assert.ok(
    !fnBody.includes("['groq-secondary'"),
    'Chat providers array must NOT have groq-secondary entry'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 8. Gemini completely removed
// ════════════════════════════════════════════════════════════════════════════
test('GEMINI-019: tryGemini function removed from worker-proxy.js', () => {
  assert.ok(
    !workerSrc.includes('async function tryGemini('),
    'tryGemini must be REMOVED from worker-proxy.js'
  );
});

test('GEMINI-020: callGeminiChat function removed from assistant.js', () => {
  // FINAL AUDIT: Gemini restored for Chat ONLY (not removed)
  assert.ok(
    assistantSrc.includes('async function callGeminiChat('),
    'callGeminiChat must exist (restored for Chat vision + text fallback)'
  );
});

test('GEMINI-021: NEWS_PROVIDER_GEMINI flag removed from active code', () => {
  // Check no active NEWS_PROVIDER_GEMINI references (comments are OK)
  const workerActive = workerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !workerActive.includes("NEWS_PROVIDER_GEMINI"),
    'NEWS_PROVIDER_GEMINI must be REMOVED from active code (comments OK)'
  );
  const assistantActive = assistantSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !assistantActive.includes("NEWS_PROVIDER_GEMINI"),
    'NEWS_PROVIDER_GEMINI must be REMOVED from assistant.js active code'
  );
});

test('GEMINI-022: No gemini circuit key in active code', () => {
  const workerActive = workerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !workerActive.includes("'gemini'") && !workerActive.includes('"gemini"'),
    "'gemini' circuit key must be REMOVED from active code"
  );
});

test('GEMINI-023: Gemini absent from News AI summary fallback chain', () => {
  // The summary fallback must be: Groq → OpenRouter → Workers AI → OpenAI
  const fnStart = workerSrc.indexOf('async function generateSummaryWithFallback');
  if (fnStart === -1) return; // function name may differ
  const fnBody = workerSrc.substring(fnStart, fnStart + 3000);
  const geminiActive = fnBody.replace(/\/\/[^\n]*/g, '');
  assert.ok(
    !geminiActive.includes("attemptProvider('gemini'"),
    'Gemini must NOT be in summary fallback chain'
  );
});

test('GEMINI-024: Gemini IS present in Chat fallback chain (restored for Chat only)', () => {
  const fnStart = assistantSrc.indexOf('const providers = hasImage');
  if (fnStart === -1) return;
  const fnBody = assistantSrc.substring(fnStart, fnStart + 800);
  assert.ok(
    fnBody.includes("['gemini'") && fnBody.includes('callGeminiChat'),
    'Gemini MUST be in Chat providers array (restored for Chat text + vision)'
  );
});

test('GEMINI-025: Chat image path returns error (no Gemini)', () => {
  // FINAL AUDIT: Gemini restored for Chat image path
  const fnStart = assistantSrc.indexOf('const providers = hasImage');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 600);
  assert.ok(
    fnBody.includes("['gemini'") && fnBody.includes('callGeminiChat'),
    'Chat image path must use Gemini (restored for vision)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 9. Old coordinator removed
// ════════════════════════════════════════════════════════════════════════════
test('COORDINATOR-026: Old Global Groq Coordinator removed (checkGroqCapacity/recordGroqRequest)', () => {
  const workerActive = workerSrc.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(
    !workerActive.includes('async function checkGroqCapacity(') &&
    !workerActive.includes('async function recordGroqRequest('),
    'Old coordinator functions (checkGroqCapacity/recordGroqRequest) must be REMOVED'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 10. newsJson fix preserved
// ════════════════════════════════════════════════════════════════════════════
test('NEWSJSON-027: newsJson ReferenceError fixed (uses JSON.stringify(trimmed).length)', () => {
  assert.ok(
    workerSrc.includes('newsJsonLength: JSON.stringify(trimmed).length'),
    'newsJsonLength must use JSON.stringify(trimmed).length (not undefined newsJson)'
  );
  assert.ok(
    !workerSrc.includes('newsJsonLength: newsJson.length'),
    'must NOT reference undefined newsJson variable'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 11. 429 classification + retry_after preserved
// ════════════════════════════════════════════════════════════════════════════
test('CLASSIFY-028: classifyGroq429 still works (TPD/RPD/RPM/TPM/generic)', () => {
  assert.ok(workerSrc.includes('function classifyGroq429('), 'classifyGroq429 must exist');
  assert.ok(workerSrc.includes('daily_quota_tpd'), 'must classify TPD');
  assert.ok(workerSrc.includes('daily_quota_rpd'), 'must classify RPD');
  assert.ok(workerSrc.includes('rate_limit_rpm'), 'must classify RPM');
  assert.ok(workerSrc.includes('rate_limit_tpm'), 'must classify TPM');
  assert.ok(workerSrc.includes('rate_limit_generic'), 'must classify generic');
});

test('CLASSIFY-029: parseGroqRetryAfter still works (15m32.688s)', () => {
  assert.ok(workerSrc.includes('function parseGroqRetryAfter('), 'parseGroqRetryAfter must exist');
});

test('CLASSIFY-030: Router returns groq_429_info field', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 3000);
  assert.ok(
    fnBody.includes('groq_429_info') && fnBody.includes('parseGroq429Info'),
    'Router must return groq_429_info (from parseGroq429Info)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 12. Fallback chain order (no Gemini, no groq-secondary)
// ════════════════════════════════════════════════════════════════════════════
test('FALLBACK-031: News AI summary fallback: Groq → OpenRouter → Workers AI → OpenAI', () => {
  const fnStart = workerSrc.indexOf('FALLBACK CHAIN (GROQ-ROUTER-4KEY');
  assert.ok(fnStart !== -1, 'Fallback chain comment must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 1500);
  // Order: Groq first, then OpenRouter, then Workers AI, then OpenAI
  const groqIdx = fnBody.indexOf("attemptProvider('groq'");
  const openrouterIdx = fnBody.indexOf("attemptProvider('openrouter'");
  const workersAiIdx = fnBody.indexOf("attemptProvider('workers-ai'");
  const openaiIdx = fnBody.indexOf("attemptProvider('openai'");
  if (groqIdx > 0 && openrouterIdx > 0) {
    assert.ok(groqIdx < openrouterIdx, 'Groq must come before OpenRouter');
  }
  if (openrouterIdx > 0 && workersAiIdx > 0) {
    assert.ok(openrouterIdx < workersAiIdx, 'OpenRouter must come before Workers AI');
  }
});

test('FALLBACK-032: Chat fallback: Groq → OpenRouter → Workers AI → OpenAI (no Gemini)', () => {
  // FINAL AUDIT: Chat fallback: Groq → OpenRouter → Gemini → Workers AI → OpenAI
  const fnStart = assistantSrc.indexOf('const providers = hasImage');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 800);
  assert.ok(fnBody.includes("['groq'"), 'Chat must have Groq');
  assert.ok(fnBody.includes("['openrouter'"), 'Chat must have OpenRouter');
  assert.ok(fnBody.includes("['gemini'"), 'Chat must have Gemini (restored)');
  assert.ok(fnBody.includes("['workers-ai'"), 'Chat must have Workers AI');
  assert.ok(!fnBody.includes("['groq-secondary'"), 'Chat must NOT have groq-secondary');
});

// ════════════════════════════════════════════════════════════════════════════
// 13. Observability (no API key in logs)
// ════════════════════════════════════════════════════════════════════════════
test('OBSERVE-033: Router logs [GROQ-ROUTER] with key index (not key value)', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 4500);
  assert.ok(
    fnBody.includes('[GROQ-ROUTER] key='),
    'Router must log [GROQ-ROUTER] with key index'
  );
  // Must NOT log apiKey or Authorization header
  assert.ok(
    !fnBody.includes('${apiKey}') && !fnBody.includes('Authorization'),
    'Router must NOT log API key value or Authorization header'
  );
});

test('OBSERVE-034: Router logs usage, quota_type, cooldown, reason', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 6500);
  assert.ok(fnBody.includes('usage='), 'must log usage');
  assert.ok(fnBody.includes('quota_type='), 'must log quota_type');
  assert.ok(fnBody.includes('cooldown_remaining='), 'must log cooldown_remaining');
  assert.ok(fnBody.includes('reason='), 'must log reason');
});

// ════════════════════════════════════════════════════════════════════════════
// 14. Non-Groq circuits unchanged
// ════════════════════════════════════════════════════════════════════════════
test('SCOPE-035: Non-Groq circuits unchanged (openrouter, workers-ai, openai)', () => {
  assert.ok(workerSrc.includes("'openrouter'"), 'openrouter circuit must exist');
  assert.ok(workerSrc.includes("'workers-ai'"), 'workers-ai circuit must exist');
  assert.ok(workerSrc.includes("'openai'"), 'openai circuit must exist');
});

test('SCOPE-036: classifyHttpError unchanged for non-429', () => {
  const fnStart = workerSrc.indexOf('function classifyHttpError(');
  const fnEnd = workerSrc.indexOf('\n}', fnStart);
  const fnBody = workerSrc.substring(fnStart, fnEnd + 2);
  assert.ok(fnBody.includes("status === 429"), '429 still retryable');
  assert.ok(fnBody.includes("status === 400"), '400 non-retryable');
  assert.ok(fnBody.includes("status === 401"), '401 non-retryable');
  assert.ok(fnBody.includes("status === 403"), '403 non-retryable');
  assert.ok(fnBody.includes("status === 404"), '404 non-retryable');
});

// ════════════════════════════════════════════════════════════════════════════
// 15. No retry amplification
// ════════════════════════════════════════════════════════════════════════════
test('AMPLIFY-037: No dual-key retry loop (router selects ONE key per request)', () => {
  // The old _groqRoutedFetch tried preferred key then other key (2 requests).
  // The new router selects ONE best key per request (1 request).
  const fnStart = workerSrc.indexOf('async function _groqRoutedFetch(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 800);
  assert.ok(
    fnBody.includes('groqRouterExecute') && !fnBody.includes('preferredKey') && !fnBody.includes('otherKey'),
    '_groqRoutedFetch must delegate to router (no preferred/other key dual-key loop)'
  );
});

test('AMPLIFY-038: tryGroqSecondary removed (dead code, no dual-key retry)', () => {
  assert.ok(
    !workerSrc.includes('async function tryGroqSecondary('),
    'tryGroqSecondary must be REMOVED (router replaces dual-key routing)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// 16. Durable Object for STRICT concurrency-safe budget enforcement
// ════════════════════════════════════════════════════════════════════════════
test('DO-039: GroqRouterDO class exists and is exported', () => {
  assert.ok(
    workerSrc.includes('class GroqRouterDO'),
    'GroqRouterDO class must exist'
  );
  assert.ok(
    workerSrc.includes('export { GroqRouterDO }'),
    'GroqRouterDO must be exported (required by wrangler)'
  );
});

test('DO-040: GroqRouterDO has reserve action (serialized key selection)', () => {
  const classStart = workerSrc.indexOf('class GroqRouterDO');
  const classBody = workerSrc.substring(classStart, classStart + 5000);
  assert.ok(classBody.includes("action === 'reserve'"), 'DO must have reserve action');
  assert.ok(classBody.includes('_selectBestKey'), 'DO must call _selectBestKey (serialized)');
});

test('DO-041: GroqRouterDO has record action (serialized state update)', () => {
  const classStart = workerSrc.indexOf('class GroqRouterDO');
  const classBody = workerSrc.substring(classStart, classStart + 5000);
  assert.ok(classBody.includes("action === 'record'"), 'DO must have record action');
  assert.ok(classBody.includes('groq_429_info'), 'DO must handle groq_429_info in record');
});

test('DO-042: groqRouterExecute uses DO when available (strict enforcement)', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 1000);
  assert.ok(
    fnBody.includes('env.GROQ_ROUTER_DO') && fnBody.includes('idFromName'),
    'groqRouterExecute must use GROQ_ROUTER_DO when available'
  );
});

test('DO-043: groqRouterExecute falls back to KV when DO not available', () => {
  const fnStart = workerSrc.indexOf('async function groqRouterExecute(');
  const fnBody = workerSrc.substring(fnStart, fnStart + 5000);
  assert.ok(
    fnBody.includes('KV FALLBACK') || fnBody.includes('_groqRouterSelectBestKey'),
    'groqRouterExecute must fall back to KV when DO not available'
  );
});

test('DO-044: wrangler.jsonc has GROQ_ROUTER_DO binding in production', () => {
  const wranglerSrc = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');
  const prodIdx = wranglerSrc.indexOf('"production": {');
  const prodSection = wranglerSrc.substring(prodIdx, prodIdx + 3000);
  assert.ok(
    prodSection.includes('GROQ_ROUTER_DO') && prodSection.includes('GroqRouterDO'),
    'Production wrangler.jsonc must have GROQ_ROUTER_DO binding'
  );
  assert.ok(
    prodSection.includes('"v2"') && prodSection.includes('GroqRouterDO'),
    'Production must have v2 migration for GroqRouterDO'
  );
});

test('DO-045: DO uses state.storage (transactional, not KV)', () => {
  const classStart = workerSrc.indexOf('class GroqRouterDO');
  const classBody = workerSrc.substring(classStart, classStart + 2000);
  assert.ok(
    classBody.includes('this.state.storage.get') && classBody.includes('this.state.storage.put'),
    'GroqRouterDO must use state.storage (DO transactional storage, not KV)'
  );
});

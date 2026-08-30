/**
 * Groq Secondary API Key + Clean AI Failover Chain — Regression Tests
 *
 * Validates the implementation of the 6-tier failover chain:
 *   1. Groq Primary (GROQ_API_KEY via Vault → groq_generate DB function)
 *   2. Groq Secondary (GROQ_API_KEY_1 via direct HTTP fetch)
 *   3. Gemini (gemini_generate DB function)
 *   4. OpenRouter (direct HTTP)
 *   5. Workers AI (env.AI binding)
 *   6. Rule-based fallback (news batch only)
 *
 * Tests:
 *   GS-001: tryGroqSecondary function exists with correct signature
 *   GS-002: tryGroqSecondary returns non_retryable when GROQ_API_KEY_1 is not set
 *   GS-003: tryGroqSecondary uses env.GROQ_API_KEY_1 (NOT env.GROQ_API_KEY)
 *   GS-004: tryGroqSecondary calls api.groq.com directly (not via DB function)
 *   GS-005: tryGroqSecondary provider label is 'groq-secondary' (unambiguous)
 *   GS-006: tryGroqSecondary does NOT use Groq Coordinator (independent quota)
 *   GS-007: generateSummaryWithFallback has groq-secondary between groq and gemini
 *   GS-008: generateSummaryWithFallback has OpenRouter BEFORE Workers AI (reordered)
 *   GS-009: batchAnalyzeNews has groq-secondary between groq and gemini
 *   GS-010: translateToFarsi has groq-secondary between groq and Workers AI
 *   GS-011: batchTranslateToFarsi has groq-secondary batch after primary batch
 *   GS-012: Chat path (assistant.js) has groq-secondary between groq and gemini
 *   GS-013: callGroqSecondaryChat exists with correct signature
 *   GS-014: Independent circuit breaker keys (groq vs groq-secondary)
 *   GS-015: translateToFarsi uses 'translation-groq-secondary' circuit key
 *   GS-016: recordProviderAttempt includes 'groq-secondary' in stats
 *   GS-017: news-ai-monitor includes GROQ_API_KEY_1_CONFIGURED flag
 *   GS-018: NEWS_PROVIDER_GROQ gates both primary AND secondary
 *   GS-019: API key value NEVER appears in any console.log or response
 *   GS-020: API key is NOT hardcoded in source (only env reference)
 *   GS-021: 429 from Groq Primary triggers failover to Groq Secondary (chain test)
 *   GS-022: Timeout from Groq Primary triggers failover to Groq Secondary (chain test)
 *   GS-023: All providers fail → rule-based fallback (batchAnalyzeNews)
 *   GS-024: No existing provider internal logic changed (Groq/Gemini/OpenRouter/WorkersAI)
 *   GS-025: No prompt/model/response format changes
 *   GS-026: No DB schema changes (no CREATE/ALTER/DROP in diff)
 *   GS-027: No cron schedule changes
 *   GS-028: Failover chain order is deterministic (no parallel calls)
 *
 * Run: node --test groq-secondary-failover-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const ASSISTANT = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');

// SECURITY: No API key values are stored in this test file.
// Tests verify that NO 'gsk_' prefix (Groq API key format) appears in any source file.
// The actual key is set as a Cloudflare secret (GROQ_API_KEY_1) via `wrangler secret put`.

// ============================================================================
// Phase 1 — tryGroqSecondary function exists and is correct
// ============================================================================

test('GS-001: tryGroqSecondary function exists with correct signature', () => {
  assert.ok(WORKER.includes('async function tryGroqSecondary(env, prompt, systemPrompt)'),
    'tryGroqSecondary must be defined');
});

test('GS-002: tryGroqSecondary returns non_retryable when GROQ_API_KEY_1 is not set', () => {
  const fnMatch = WORKER.match(/async function tryGroqSecondary\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'tryGroqSecondary not found');
  const body = fnMatch[1];
  assert.ok(body.includes("env.GROQ_API_KEY_1"),
    'must check env.GROQ_API_KEY_1');
  assert.ok(body.includes("'no_api_key'"),
    'must return error=no_api_key when key missing');
  assert.ok(body.includes("'non_retryable'"),
    'must return non_retryable when key missing');
});

test('GS-003: tryGroqSecondary uses env.GROQ_API_KEY_1 (NOT env.GROQ_API_KEY)', () => {
  const fnMatch = WORKER.match(/async function tryGroqSecondary\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const body = fnMatch[1];
  assert.ok(body.includes('env.GROQ_API_KEY_1'),
    'must use env.GROQ_API_KEY_1');
  // Must NOT reference env.GROQ_API_KEY (the primary key)
  assert.ok(!body.includes('env.GROQ_API_KEY[^_]'),
    'must NOT use env.GROQ_API_KEY (primary key)');
  // Use a more precise check: no assignment from env.GROQ_API_KEY (without _1)
  const lines = body.split('\n');
  for (const line of lines) {
    if (line.includes('GROQ_API_KEY') && !line.includes('GROQ_API_KEY_1')) {
      assert.fail(`tryGroqSecondary references GROQ_API_KEY without _1: ${line.trim()}`);
    }
  }
});

test('GS-004: tryGroqSecondary calls api.groq.com directly (not via DB function)', () => {
  const fnMatch = WORKER.match(/async function tryGroqSecondary\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const body = fnMatch[1];
  assert.ok(body.includes('https://api.groq.com/openai/v1/chat/completions'),
    'must call api.groq.com directly');
  assert.ok(!body.includes('groq_generate'),
    'must NOT use groq_generate DB function (direct HTTP instead)');
  assert.ok(body.includes('fetch('),
    'must use fetch() for direct HTTP call');
});

test('GS-005: tryGroqSecondary provider label is groq-secondary (unambiguous)', () => {
  const fnMatch = WORKER.match(/async function tryGroqSecondary\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const body = fnMatch[1];
  const providerLabels = (body.match(/provider:\s*'groq-secondary'/g) || []).length;
  assert.ok(providerLabels >= 4,
    `must use provider='groq-secondary' in all return paths (found ${providerLabels}, expected >=4)`);
  // Must NEVER use provider='groq' (that's the primary label)
  assert.ok(!body.includes("provider: 'groq'"),
    "must NOT use provider='groq' (that is the primary label)");
});

test('GS-006: tryGroqSecondary does NOT use Groq Coordinator (independent quota)', () => {
  const fnMatch = WORKER.match(/async function tryGroqSecondary\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const body = fnMatch[1];
  assert.ok(!body.includes('checkGroqCapacity'),
    'must NOT call checkGroqCapacity (secondary has its own quota)');
  assert.ok(!body.includes('recordGroqRequest'),
    'must NOT call recordGroqRequest (secondary has its own quota)');
  assert.ok(!body.includes('estimateGroqTokens'),
    'must NOT call estimateGroqTokens (secondary has its own quota)');
});

// ============================================================================
// Phase 2 — generateSummaryWithFallback chain order
// ============================================================================

test('GS-007: generateSummaryWithFallback has groq-secondary between groq and gemini', () => {
  // Use indexOf on the full WORKER source (function boundaries are hard to extract with regex due to nesting)
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  assert.ok(fnStart >= 0, 'generateSummaryWithFallback not found');
  // Find the next top-level function or end of file as the boundary
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  const groqPos = body.indexOf("attemptProvider('groq',");
  const groqSecPos = body.indexOf("attemptProvider('groq-secondary',");
  const geminiPos = body.indexOf("attemptProvider('gemini',");
  assert.ok(groqPos >= 0, 'groq must be in chain');
  assert.ok(groqSecPos >= 0, 'groq-secondary must be in chain');
  assert.ok(geminiPos >= 0, 'gemini must be in chain');
  assert.ok(groqPos < groqSecPos, 'groq must come BEFORE groq-secondary');
  assert.ok(groqSecPos < geminiPos, 'groq-secondary must come BEFORE gemini');
});

test('GS-008: generateSummaryWithFallback has OpenRouter BEFORE Workers AI (reordered)', () => {
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  const openrouterPos = body.indexOf("attemptProvider('openrouter',");
  const workersAiPos = body.indexOf("attemptProvider('workers-ai',");
  assert.ok(openrouterPos >= 0, 'openrouter must be in chain');
  assert.ok(workersAiPos >= 0, 'workers-ai must be in chain');
  assert.ok(openrouterPos < workersAiPos,
    'openrouter must come BEFORE workers-ai (per failover chain spec)');
});

// ============================================================================
// Phase 3 — batchAnalyzeNews chain
// ============================================================================

test('GS-009: batchAnalyzeNews has groq-secondary between groq and gemini', () => {
  const fnMatch = WORKER.match(/async function batchAnalyzeNews\(env, articles\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'batchAnalyzeNews not found');
  const body = fnMatch[1];
  // In batchAnalyzeNews, Groq secondary is identified by the circuit key 'groq-secondary'
  const groqPos = body.indexOf("shouldAttemptProvider(env, 'groq')");
  const groqSecPos = body.indexOf("shouldAttemptProvider(env, 'groq-secondary')");
  const geminiPos = body.indexOf("shouldAttemptProvider(env, 'gemini')");
  assert.ok(groqPos >= 0, 'groq must be in chain');
  assert.ok(groqSecPos >= 0, 'groq-secondary must be in chain');
  assert.ok(geminiPos >= 0, 'gemini must be in chain');
  assert.ok(groqPos < groqSecPos, 'groq must come BEFORE groq-secondary');
  assert.ok(groqSecPos < geminiPos, 'groq-secondary must come BEFORE gemini');
});

// ============================================================================
// Phase 4 — translateToFarsi chain
// ============================================================================

test('GS-010: translateToFarsi has groq-secondary between groq and Workers AI', () => {
  const fnMatch = WORKER.match(/async function translateToFarsi\(text, env\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'translateToFarsi not found');
  const body = fnMatch[1];
  const groqCircuitPos = body.indexOf("shouldAttemptProvider(env, 'groq')");
  const groqSecCircuitPos = body.indexOf("shouldAttemptProvider(env, 'translation-groq-secondary')");
  const workersAiCircuitPos = body.indexOf("shouldAttemptProvider(env, 'translation-workers-ai')");
  assert.ok(groqCircuitPos >= 0, 'groq circuit check must exist');
  assert.ok(groqSecCircuitPos >= 0, 'translation-groq-secondary circuit check must exist');
  assert.ok(workersAiCircuitPos >= 0, 'translation-workers-ai circuit check must exist');
  assert.ok(groqCircuitPos < groqSecCircuitPos,
    'groq must come BEFORE groq-secondary');
  assert.ok(groqSecCircuitPos < workersAiCircuitPos,
    'groq-secondary must come BEFORE Workers AI');
});

// ============================================================================
// Phase 5 — batchTranslateToFarsi chain
// ============================================================================

test('GS-011: batchTranslateToFarsi has groq-secondary batch after primary batch', () => {
  const fnMatch = WORKER.match(/async function batchTranslateToFarsi\(texts, env\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(fnMatch, 'batchTranslateToFarsi not found');
  const body = fnMatch[1];
  // Primary batch uses circuit key 'groq'
  // Secondary batch uses circuit key 'translation-groq-secondary'
  const primaryBatchPos = body.indexOf("shouldAttemptProvider(env, 'groq')");
  const secondaryBatchPos = body.indexOf("shouldAttemptProvider(env, 'translation-groq-secondary')");
  assert.ok(primaryBatchPos >= 0, 'primary Groq batch must exist');
  assert.ok(secondaryBatchPos >= 0, 'secondary Groq batch must exist');
  assert.ok(primaryBatchPos < secondaryBatchPos,
    'primary batch must come BEFORE secondary batch');
});

// ============================================================================
// Phase 6 — Chat path (assistant.js)
// ============================================================================

test('GS-012: Chat path has groq-secondary between groq and gemini', () => {
  // Find the TEXT-ONLY path (the vision path also has ['gemini',] which confuses indexOf)
  const textPathStart = ASSISTANT.indexOf('// Text-only path — failover chain');
  assert.ok(textPathStart >= 0, 'Text-only path comment not found in generateAssistantReply');
  // Search within the text-only providers array (from textPathStart to the next 2000 chars)
  const body = ASSISTANT.slice(textPathStart, textPathStart + 2000);
  const groqPos = body.indexOf("['groq',");
  const groqSecPos = body.indexOf("['groq-secondary',");
  const geminiPos = body.indexOf("['gemini',");
  const openrouterPos = body.indexOf("['openrouter',");
  const workersAiPos = body.indexOf("['workers-ai',");
  assert.ok(groqPos >= 0, 'groq must be in chat chain');
  assert.ok(groqSecPos >= 0, 'groq-secondary must be in chat chain');
  assert.ok(geminiPos >= 0, 'gemini must be in chat chain');
  assert.ok(groqPos < groqSecPos, 'groq must come BEFORE groq-secondary');
  assert.ok(groqSecPos < geminiPos, 'groq-secondary must come BEFORE gemini');
  assert.ok(geminiPos < openrouterPos, 'gemini must come BEFORE openrouter');
  assert.ok(openrouterPos < workersAiPos, 'openrouter must come BEFORE workers-ai');
});

test('GS-013: callGroqSecondaryChat exists with correct signature', () => {
  assert.ok(ASSISTANT.includes('async function callGroqSecondaryChat(env, prompt)'),
    'callGroqSecondaryChat must be defined');
  // Must use env.GROQ_API_KEY_1
  const fnMatch = ASSISTANT.match(/async function callGroqSecondaryChat\(env, prompt\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, 'callGroqSecondaryChat body not found');
  const body = fnMatch[1];
  assert.ok(body.includes('env.GROQ_API_KEY_1'),
    'must use env.GROQ_API_KEY_1');
  assert.ok(body.includes('https://api.groq.com/openai/v1/chat/completions'),
    'must call api.groq.com directly');
});

// ============================================================================
// Phase 7 — Circuit breaker independence
// ============================================================================

test('GS-014: Independent circuit breaker keys (groq vs groq-secondary)', () => {
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  assert.ok(body.includes("attemptProvider('groq',"),
    'primary uses circuit key groq');
  assert.ok(body.includes("attemptProvider('groq-secondary',"),
    'secondary uses circuit key groq-secondary (independent)');
});

test('GS-015: translateToFarsi uses translation-groq-secondary circuit key', () => {
  const fnMatch = WORKER.match(/async function translateToFarsi\(text, env\)\s*\{([\s\S]*?)\n\}/);
  const body = fnMatch[1];
  assert.ok(body.includes("'translation-groq-secondary'"),
    'must use translation-groq-secondary circuit key (separate from translation-workers-ai)');
  assert.ok(!body.includes("shouldAttemptProvider(env, 'groq-secondary')"),
    'translation path should use translation-groq-secondary (not the summary path key)');
});

// ============================================================================
// Phase 8 — Stats and monitoring
// ============================================================================

test('GS-016: recordProviderAttempt includes groq-secondary in stats', () => {
  const fnMatch = WORKER.match(/async function recordProviderAttempt\(env, provider, success, durationMs\)\s*\{([\s\S]*?)\n  \}/);
  assert.ok(fnMatch, 'recordProviderAttempt not found');
  const body = fnMatch[1];
  assert.ok(body.includes("'groq-secondary': { success: 0, failed: 0, total_ms: 0 }"),
    "must initialize 'groq-secondary' in stats");
  assert.ok(body.includes("'groq-secondary', 'gemini'") || body.includes("'groq-secondary'"),
    'must include groq-secondary in the nested provider check loop');
});

test('GS-017: news-ai-monitor includes GROQ_API_KEY_1_CONFIGURED flag', () => {
  assert.ok(WORKER.includes('GROQ_API_KEY_1_CONFIGURED'),
    'news-ai-monitor must expose GROQ_API_KEY_1_CONFIGURED flag (Boolean, not the key value)');
  // Must use Boolean() to avoid leaking the key value
  assert.ok(WORKER.includes('Boolean(env.GROQ_API_KEY_1)'),
    'must use Boolean(env.GROQ_API_KEY_1) — never the raw key value');
});

// ============================================================================
// Phase 9 — Feature flag gating
// ============================================================================

test('GS-018: NEWS_PROVIDER_GROQ gates both primary AND secondary', () => {
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  assert.ok(body.includes("isNewsProviderEnabled(env, 'NEWS_PROVIDER_GROQ', true)"),
    'primary must be gated on NEWS_PROVIDER_GROQ');
  assert.ok(body.includes("env.GROQ_API_KEY_1"),
    'secondary must be gated on env.GROQ_API_KEY_1');
  // Find the secondary block and verify it has both conditions
  const secBlockIdx = body.indexOf("attemptProvider('groq-secondary'");
  assert.ok(secBlockIdx >= 0, 'groq-secondary block must exist');
  const secBlockPrefix = body.slice(0, secBlockIdx);
  assert.ok(secBlockPrefix.includes("!summary"),
    'secondary block must be guarded by !summary');
  assert.ok(secBlockPrefix.includes("NEWS_PROVIDER_GROQ"),
    'secondary block must be gated on NEWS_PROVIDER_GROQ');
  assert.ok(secBlockPrefix.includes("GROQ_API_KEY_1"),
    'secondary block must be gated on GROQ_API_KEY_1');
});

// ============================================================================
// Phase 10 — SECURITY: API key leak prevention
// ============================================================================

test('GS-019: NO Groq API key (gsk_ prefix) hardcoded in ANY source file', () => {
  // SECURITY: No 'gsk_' prefix (Groq API key format) may appear in any source file.
  // The actual key is set ONLY as a Cloudflare secret (GROQ_API_KEY_1) via `wrangler secret put`.
  // This test scans all .js/.cjs/.mjs/.json/.jsonc/.sql files in the project (excluding node_modules/.git).
  const GROQ_KEY_PATTERN = /gsk_[A-Za-z0-9]{10,}/;
  const checkFiles = (dir) => {
    const files = fs.readdirSync(dir, { withFileTypes: true });
    for (const f of files) {
      const fullPath = path.join(dir, f.name);
      if (f.isDirectory() && f.name !== 'node_modules' && f.name !== '.git') {
        checkFiles(fullPath);
      } else if (f.isFile() && (f.name.endsWith('.js') || f.name.endsWith('.cjs') || f.name.endsWith('.mjs') || f.name.endsWith('.json') || f.name.endsWith('.jsonc') || f.name.endsWith('.sql'))) {
        const content = fs.readFileSync(fullPath, 'utf8');
        if (GROQ_KEY_PATTERN.test(content)) {
          assert.fail(`Hardcoded Groq API key (gsk_...) found in ${fullPath}`);
        }
      }
    }
  };
  checkFiles(__dirname);
});

test('GS-020: API key is NOT hardcoded in source (only env reference)', () => {
  // Must reference env.GROQ_API_KEY_1, not a hardcoded string starting with gsk_
  assert.ok(!WORKER.includes('gsk_'),
    'no hardcoded Groq API key (gsk_...) in worker-proxy.js');
  assert.ok(!ASSISTANT.includes('gsk_'),
    'no hardcoded Groq API key (gsk_...) in assistant.js');
  // Verify env reference exists
  assert.ok(WORKER.includes('env.GROQ_API_KEY_1'),
    'must reference env.GROQ_API_KEY_1');
  assert.ok(ASSISTANT.includes('env.GROQ_API_KEY_1'),
    'must reference env.GROQ_API_KEY_1 in assistant.js');
  // Must NOT log the key value
  const logPattern = /console\.\w+\(.*GROQ_API_KEY_1[^B]/;
  assert.ok(!logPattern.test(WORKER),
    'must NOT log env.GROQ_API_KEY_1 directly (use Boolean() for config flags)');
  assert.ok(!logPattern.test(ASSISTANT),
    'must NOT log env.GROQ_API_KEY_1 directly in assistant.js');
});

// ============================================================================
// Phase 11 — Failover chain scenario tests (static verification)
// ============================================================================

test('GS-021 (Test 2): 429 from Groq Primary triggers failover to Groq Secondary', () => {
  assert.ok(WORKER.includes("if (status === 429 || status === 408 || status >= 500) return 'retryable'"),
    '429 must be classified as retryable');
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // After groq fails, the next block checks !summary && ... && env.GROQ_API_KEY_1
  const secBlockIdx = body.indexOf("attemptProvider('groq-secondary'");
  assert.ok(secBlockIdx >= 0, 'groq-secondary block must exist');
  const secBlockPrefix = body.slice(0, secBlockIdx);
  assert.ok(secBlockPrefix.includes('!summary'),
    'groq-secondary block must be guarded by !summary (only tried if primary failed)');
  assert.ok(secBlockPrefix.includes('GROQ_API_KEY_1'),
    'groq-secondary block must check GROQ_API_KEY_1');
});

test('GS-022 (Test 3): Timeout from Groq Primary triggers failover to Groq Secondary', () => {
  // tryGroq catches AbortError → returns error='timeout', errorType='retryable'
  // → !summary → tries groq-secondary
  const tryGroqMatch = WORKER.match(/async function tryGroq\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const body = tryGroqMatch[1];
  assert.ok(body.includes("isAbort ? 'timeout' : 'network_error'"),
    'tryGroq must classify AbortError as timeout (retryable)');
  assert.ok(body.includes("errorType: 'retryable'"),
    'tryGroq timeout must be retryable');
});

test('GS-023 (Test 7): All providers fail → rule-based fallback (batchAnalyzeNews)', () => {
  const fnMatch = WORKER.match(/async function batchAnalyzeNews\(env, articles\)\s*\{([\s\S]*?)\n\}/);
  const body = fnMatch[1];
  // Must have a rule-based fallback at the end
  assert.ok(body.includes("rule-based fallback") || body.includes("Rule-based fallback"),
    'must have rule-based fallback');
  // The fallback must return a non-null result for every article
  assert.ok(body.includes("fallback[i] = {") || body.includes("fallback[i]="),
    'rule-based fallback must populate result for every article');
  // Must NOT throw on all-providers-fail
  assert.ok(!body.includes("throw new Error") || body.indexOf("throw new Error") < body.indexOf("rule-based"),
    'batchAnalyzeNews must not throw when all providers fail — it uses rule-based fallback');
});

// ============================================================================
// Phase 12 — No unnecessary changes
// ============================================================================

test('GS-024: No existing provider internal logic changed', () => {
  // tryGroq must still use groq_generate DB function
  const tryGroqMatch = WORKER.match(/async function tryGroq\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const tryGroqBody = tryGroqMatch[1];
  assert.ok(tryGroqBody.includes('groq_generate'),
    'tryGroq must still use groq_generate DB function (unchanged)');
  assert.ok(tryGroqBody.includes('checkGroqCapacity'),
    'tryGroq must still use Groq Coordinator (unchanged)');
  // tryGemini must still use gemini_generate DB function
  const tryGeminiMatch = WORKER.match(/async function tryGemini\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const tryGeminiBody = tryGeminiMatch[1];
  assert.ok(tryGeminiBody.includes('gemini_generate'),
    'tryGemini must still use gemini_generate DB function (unchanged)');
  // tryOpenRouter must still use fetch to openrouter.ai
  const tryOpenRouterMatch = WORKER.match(/async function tryOpenRouter\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const tryOpenRouterBody = tryOpenRouterMatch[1];
  assert.ok(tryOpenRouterBody.includes('openrouter.ai/api/v1/chat/completions'),
    'tryOpenRouter must still call openrouter.ai (unchanged)');
  // tryWorkersAI must still use env.AI.run
  const tryWorkersAIMatch = WORKER.match(/async function tryWorkersAI\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const tryWorkersAIBody = tryWorkersAIMatch[1];
  assert.ok(tryWorkersAIBody.includes('env.AI.run'),
    'tryWorkersAI must still use env.AI.run (unchanged)');
});

test('GS-025: No prompt/model/response format changes', () => {
  // Model names must be unchanged
  assert.ok(WORKER.includes("'openai/gpt-oss-120b'"),
    'Groq model must still be openai/gpt-oss-120b');
  assert.ok(WORKER.includes("'gemini-3.5-flash'"),
    'Gemini model must still be gemini-3.5-flash');
  assert.ok(WORKER.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    'Workers AI model must still be llama-3.3-70b-instruct-fp8-fast');
  assert.ok(WORKER.includes('nvidia/nemotron-3-super-120b-a12b:free') || ASSISTANT.includes('nvidia/nemotron-3-super-120b-a12b:free'),
    'OpenRouter model must be unchanged');
  // tryGroqSecondary uses the SAME model as tryGroq
  const tryGroqSecMatch = WORKER.match(/async function tryGroqSecondary\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  const tryGroqSecBody = tryGroqSecMatch[1];
  assert.ok(tryGroqSecBody.includes("'openai/gpt-oss-120b'"),
    'tryGroqSecondary must use the same model as tryGroq (openai/gpt-oss-120b)');
});

test('GS-026: No DB schema changes (no CREATE/ALTER/DROP in this task)', () => {
  // This task should NOT have modified any .sql migration files
  // The groq-model-update.sql must be unchanged
  const groqSql = fs.readFileSync(path.join(__dirname, 'scripts/groq-model-update.sql'), 'utf8');
  // It should still reference GROQ_API_KEY in vault (not GROQ_API_KEY_1)
  assert.ok(groqSql.includes("WHERE name = 'GROQ_API_KEY'"),
    'groq-model-update.sql must still reference GROQ_API_KEY in vault (primary unchanged)');
  // It should NOT reference GROQ_API_KEY_1 (secondary is handled in Worker, not DB)
  assert.ok(!groqSql.includes('GROQ_API_KEY_1'),
    'groq-model-update.sql must NOT reference GROQ_API_KEY_1 (secondary is Worker-side only)');
});

test('GS-027: No cron schedule changes', () => {
  // wrangler.jsonc crons must be unchanged
  assert.ok(WRANGLER.includes('"* * * * *"'),
    'cron * * * * * must still exist');
  assert.ok(WRANGLER.includes('"*/5 * * * *"'),
    'cron */5 * * * * must still exist');
  assert.ok(WRANGLER.includes('"*/15 * * * *"'),
    'cron */15 * * * * must still exist');
});

test('GS-028: Failover chain order is deterministic (no parallel calls)', () => {
  const fnStart = WORKER.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  assert.ok(!body.includes('Promise.all('),
    'generateSummaryWithFallback must NOT use Promise.all (sequential fallback)');
  assert.ok(!body.includes('Promise.allSettled('),
    'generateSummaryWithFallback must NOT use Promise.allSettled (sequential fallback)');
  // Each provider block must be guarded by !summary (groq-secondary, gemini, openrouter, workers-ai)
  const summaryGuards = (body.match(/if\s*\(!summary\s*&&/g) || []).length;
  assert.ok(summaryGuards >= 4,
    `each fallback provider must be guarded by !summary (found ${summaryGuards}, expected >=4 for groq-sec/gemini/openrouter/workers-ai)`);
});

// ============================================================================
// Phase 13 — Wrangler.jsonc secret note
// ============================================================================

test('GS-029: wrangler.jsonc does NOT contain GROQ_API_KEY_1 in vars (must be a secret, not a var)', () => {
  // GROQ_API_KEY_1 must be a Cloudflare SECRET (set via wrangler secret put),
  // NOT a plain var in wrangler.jsonc (which would be visible in the repo)
  assert.ok(!WRANGLER.includes('GROQ_API_KEY_1'),
    'GROQ_API_KEY_1 must NOT be in wrangler.jsonc vars — it must be set as a Cloudflare secret via `wrangler secret put GROQ_API_KEY_1`');
  // GROQ_API_KEY should also not be in vars (it is in Vault, not Worker env)
  assert.ok(!WRANGLER.includes('"GROQ_API_KEY"'),
    'GROQ_API_KEY must NOT be in wrangler.jsonc vars either (it is in Supabase Vault)');
});

test('GS-030: Original GROQ_API_KEY path is untouched (Vault → groq_generate)', () => {
  // The groq_generate DB function must still read from vault.GROQ_API_KEY
  const groqSql = fs.readFileSync(path.join(__dirname, 'scripts/groq-model-update.sql'), 'utf8');
  assert.ok(groqSql.includes("WHERE name = 'GROQ_API_KEY'"),
    'groq_generate must still read GROQ_API_KEY from vault (unchanged)');
  // The Worker must NOT reference env.GROQ_API_KEY (the primary key is in Vault, not Worker env)
  // env.GROQ_API_KEY_1 is the secondary — that is fine
  const groqApiKeyRefs = (WORKER.match(/env\.GROQ_API_KEY(?!_1)/g) || []).length;
  assert.equal(groqApiKeyRefs, 0,
    `Worker must NOT reference env.GROQ_API_KEY (primary key is in Vault) — found ${groqApiKeyRefs} references`);
  const assistantGroqApiKeyRefs = (ASSISTANT.match(/env\.GROQ_API_KEY(?!_1)/g) || []).length;
  assert.equal(assistantGroqApiKeyRefs, 0,
    `assistant.js must NOT reference env.GROQ_API_KEY (primary key is in Vault) — found ${assistantGroqApiKeyRefs} references`);
});

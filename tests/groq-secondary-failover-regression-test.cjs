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

const WORKER = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const ASSISTANT = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/assistant.js'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');
// Router architecture: functions extracted to src/news/providers.js + src/news/summary.js
const PROVIDERS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/providers.js'), 'utf8');
const SUMMARY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/news/summary.js'), 'utf8');

// SECURITY: No API key values are stored in this test file.
// Tests verify that NO 'gsk_' prefix (Groq API key format) appears in any source file.
// The actual key is set as a Cloudflare secret (GROQ_API_KEY_1) via `wrangler secret put`.

// ============================================================================
// Phase 1 — tryGroqSecondary function exists and is correct
// ============================================================================

// OBSOLETE — REMOVED: GS-001: tryGroqSecondary function exists with correct signature
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: tryGroqSecondary was REMOVED from production. The router discovers
// all 4 keys at runtime via _groqRouterDiscoverKeys (no separate "secondary"
// concept). There is no tryGroqSecondary function to assert against anymore.

// OBSOLETE — REMOVED: GS-002: tryGroqSecondary returns non_retryable when GROQ_API_KEY_1 is not set
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The entire "secondary key" concept was removed. The router DO holds
// a pool of 4 keys discovered at runtime; there is no per-key "non_retryable /
// no_api_key" branch because discovery is centralized in _groqRouterDiscoverKeys.

// OBSOLETE — REMOVED: GS-003: tryGroqSecondary uses env.GROQ_API_KEY_1 (NOT env.GROQ_API_KEY)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: tryGroqSecondary no longer exists. Keys are discovered via
// _groqRouterDiscoverKeys which reads env.GROQ_API_KEY, env.GROQ_API_KEY_1,
// env.GROQ_API_KEY_2, env.GROQ_API_KEY_3 in a single pass — there is no
// per-secondary env access pattern left to test.

// OBSOLETE — REMOVED: GS-004: tryGroqSecondary calls api.groq.com directly (not via DB function)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: tryGroqSecondary was deleted. All Groq calls now go through
// _groqRouterCallGateway which invokes the DB function groq_generate_with_key
// (key passed in explicitly). No direct api.groq.com fetch and no separate
// secondary entry point remain.

// OBSOLETE — REMOVED: GS-005: tryGroqSecondary provider label is groq-secondary (unambiguous)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The 'groq-secondary' provider label no longer exists. All Groq calls
// (whether they happen to use key slot 0, 1, 2, or 3) report provider='groq'.
// The router picks the slot internally; the caller never sees a slot label.

// OBSOLETE — REMOVED: GS-006: tryGroqSecondary does NOT use Groq Coordinator (independent quota)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: tryGroqSecondary is gone AND the Groq Coordinator itself was entirely
// replaced by the Router DO. The secondary's "independent quota" was a property
// of the deleted function; there is no comparison left to make.

// ============================================================================
// Phase 2 — generateSummaryWithFallback chain order
// ============================================================================

// OBSOLETE — REMOVED: GS-007: generateSummaryWithFallback uses dual-key routed tryGroq (no redundant tryGroqSecondary)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The "no redundant tryGroqSecondary" assertion is obsolete because
// there is no tryGroqSecondary function left to be redundant. The router
// handles multi-key rotation internally; generateSummaryWithFallback now
// simply awaits _groqRouterExecute.

test('GS-008: generateSummaryWithFallback has OpenRouter BEFORE Workers AI (reordered)', () => {
  // Router architecture: generateSummaryWithFallback extracted to src/news/summary.js
  const fnStart = SUMMARY_SRC.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = SUMMARY_SRC.indexOf('\nasync function ', fnStart + 100);
  const body = SUMMARY_SRC.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  const openrouterPos = body.indexOf("attemptProvider('openrouter',");
  const workersAiPos = body.indexOf("attemptProvider('workers-ai',");
  assert.ok(openrouterPos >= 0, 'openrouter must be in chain');
  assert.ok(workersAiPos >= 0, 'workers-ai must be in chain');
  assert.ok(openrouterPos < workersAiPos,
    'openrouter must come BEFORE workers-ai (per 4-provider chain: Groq→OpenRouter→WorkersAI→OpenAI)');
});

// ============================================================================
// Phase 3 — batchAnalyzeNews chain
// ============================================================================

// OBSOLETE — REMOVED: GS-009: batchAnalyzeNews has groq-secondary between groq and gemini
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The 'groq-secondary' circuit key is gone (no secondary concept).
// Furthermore batchAnalyzeNews no longer has an inline Gemini branch — it calls
// the unified _groqRouterExecute and the router decides which key/slot to use.
// There is no chain ordering left to assert here.

// ============================================================================
// Phase 4 — translateToFarsi chain
// ============================================================================

// OBSOLETE — REMOVED: GS-010: translateToFarsi has groq-secondary between groq and Workers AI
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: 'translation-groq-secondary' circuit key removed — there is no
// secondary. translateToFarsi calls _groqRouterExecute; the router DO holds per-key
// circuit state. The three-tier ordering (groq → groq-secondary → workers-ai)
// no longer exists in this function.

// ============================================================================
// Phase 5 — batchTranslateToFarsi chain
// ============================================================================

// OBSOLETE — REMOVED: GS-011: batchTranslateToFarsi has groq-secondary batch after primary batch
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The primary/secondary batch split is gone. batchTranslateToFarsi now
// makes a single call to _groqRouterExecute; the router internally retries with
// a different key slot if the first returns a 429/5xx. No second batch exists.

// ============================================================================
// Phase 6 — Chat path (assistant.js)
// ============================================================================

// OBSOLETE — REMOVED: GS-012: Chat path has groq-secondary between groq and gemini
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The chat path (assistant.js callGroqChat) now calls groqRouterExecute
// for all Groq traffic. There is no ['groq', 'groq-secondary', 'gemini', ...]
// failover array — the router handles slot selection internally.

// OBSOLETE — REMOVED: GS-013: callGroqSecondaryChat exists with correct signature
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: callGroqSecondaryChat was deleted. There is now a single callGroqChat
// function that routes through groqRouterExecute. No secondary chat entry point
// exists, so its signature cannot be asserted.

// ============================================================================
// Phase 7 — Circuit breaker independence
// ============================================================================

// OBSOLETE — REMOVED: GS-014: Independent circuit breaker keys (groq vs groq-secondary)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The 'groq-secondary' circuit key no longer exists. Per-key circuit
// state is now held inside the Router DO (each of the 4 keys has its own
// open/half-open/closed flag). There is no separate KV-based circuit key to
// compare against the primary.

// OBSOLETE — REMOVED: GS-015: translateToFarsi uses translation-groq-secondary circuit key
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The 'translation-groq-secondary' circuit key was deleted along with
// the secondary-key concept. translateToFarsi now goes through _groqRouterExecute
// which routes by key slot (0-3), not by provider label.

// ============================================================================
// Phase 8 — Stats and monitoring
// ============================================================================

// OBSOLETE — REMOVED: GS-017: news-ai-monitor includes GROQ_API_KEY_1_CONFIGURED flag
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: The GROQ_API_KEY_1_CONFIGURED monitor flag was removed. The news-ai
// monitor now reports GROQ_ROUTER_KEY_COUNT (number of keys the router DO
// discovered at runtime) — there is no separate per-slot _CONFIGURED flag.

// ============================================================================
// Phase 9 — Feature flag gating
// ============================================================================

test('GS-018: NEWS_PROVIDER_GROQ gates primary Groq in generateSummaryWithFallback', () => {
  // Router architecture: generateSummaryWithFallback extracted to src/news/summary.js
  // No secondary concept — single NEWS_PROVIDER_GROQ gate for the Groq Router path.
  const fnStart = SUMMARY_SRC.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = SUMMARY_SRC.indexOf('\nasync function ', fnStart + 100);
  const body = SUMMARY_SRC.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  assert.ok(body.includes("isNewsProviderEnabled(env, 'NEWS_PROVIDER_GROQ', true)"),
    'Groq Router must be gated on NEWS_PROVIDER_GROQ');
  assert.ok(body.includes("attemptProvider('groq'"),
    'Groq must be in the chain via attemptProvider');
  // No secondary — verify 'groq-secondary' only appears in comments (not in active code)
  const codeOnly = body.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/.*$/gm, '');
  assert.ok(!codeOnly.includes("groq-secondary"),
    'groq-secondary must NOT exist in active code (replaced by 4-key Router DO)');
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
  checkFiles(path.join(__dirname, '..'));
});

test('GS-020: API key is NOT hardcoded in source (only env reference)', () => {
  // Router architecture: key discovery in src/news/providers.js (_groqRouterDiscoverKeys)
  assert.ok(!PROVIDERS_SRC.includes('gsk_'),
    'no hardcoded Groq API key (gsk_...) in providers.js');
  assert.ok(!ASSISTANT.includes('gsk_'),
    'no hardcoded Groq API key (gsk_...) in assistant.js');
  // Verify env reference exists in providers.js (router discovers keys from env)
  assert.ok(PROVIDERS_SRC.includes('env.GROQ_API_KEY'),
    'must reference env.GROQ_API_KEY in providers.js (router key discovery)');
  assert.ok(PROVIDERS_SRC.includes('env.GROQ_API_KEY_1'),
    'must reference env.GROQ_API_KEY_1 in providers.js (router key discovery)');
  // Must NOT log the key value
  const logPattern = /console\.\w+\(.*GROQ_API_KEY[^B]/;
  assert.ok(!logPattern.test(PROVIDERS_SRC),
    'must NOT log env.GROQ_API_KEY directly (use Boolean() for config flags)');
  assert.ok(!logPattern.test(ASSISTANT),
    'must NOT log env.GROQ_API_KEY directly in assistant.js');
});

// ============================================================================
// Phase 11 — Failover chain scenario tests (static verification)
// ============================================================================

// OBSOLETE — REMOVED: GS-021 (Test 2): 429 from Groq Primary triggers failover to Groq Secondary
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: 429 from a Groq key no longer triggers an explicit failover block in
// generateSummaryWithFallback. The Router DO opens the per-key circuit on 429
// and, on the next reserve() call, picks a different key slot. The caller sees
// a normal completion or an all-keys-exhausted error — no inline failover chain.

// OBSOLETE — REMOVED: GS-022 (Test 3): Timeout from Groq Primary triggers failover to Groq Secondary
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: Timeout / 5xx from a Groq key no longer triggers an explicit
// secondary failover branch. The Router DO handles 5xx/timeout by marking the
// current key circuit as OPEN and selecting a different key on the next reserve.
// There is no 'retryable' errorType returned to generateSummaryWithFallback.

test('GS-023 (Test 7): All providers fail → rule-based fallback (batchAnalyzeNews)', () => {
  // Router architecture: batchAnalyzeNews extracted to src/news/summary.js
  const fnStart = SUMMARY_SRC.indexOf('async function batchAnalyzeNews');
  assert.ok(fnStart > -1, 'batchAnalyzeNews must exist in summary.js');
  // Use a generous slice to capture the full function (rule-based fallback is near the end)
  const body = SUMMARY_SRC.slice(fnStart, fnStart + 20000);
  // Must have a rule-based fallback at the end
  assert.ok(body.includes("rule-based fallback") || body.includes("Rule-based fallback"),
    'must have rule-based fallback');
  // Must NOT throw on all-providers-fail
  assert.ok(!body.includes("throw new Error") || body.indexOf("throw new Error") < body.indexOf("rule-based"),
    'batchAnalyzeNews must not throw when all providers fail — it uses rule-based fallback');
});

// ============================================================================
// Phase 12 — No unnecessary changes
// ============================================================================

test('GS-024: Non-Groq provider logic unchanged (OpenRouter, WorkersAI, OpenAI)', () => {
  // Router architecture: provider functions extracted to src/news/providers.js
  // Groq now uses _groqRoutedFetch (router DO) instead of groq_generate + checkGroqCapacity.
  // tryGemini removed (Gemini provider deleted). Only verify non-Groq providers are intact.

  // tryOpenRouter must still use fetch to openrouter.ai
  const orMatch = PROVIDERS_SRC.match(/async function tryOpenRouter\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(orMatch, 'tryOpenRouter must exist in providers.js');
  assert.ok(orMatch[1].includes('openrouter.ai/api/v1/chat/completions'),
    'tryOpenRouter must still call openrouter.ai (unchanged)');

  // tryWorkersAI must still use env.AI.run
  const waiMatch = PROVIDERS_SRC.match(/async function tryWorkersAI\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(waiMatch, 'tryWorkersAI must exist in providers.js');
  assert.ok(waiMatch[1].includes('env.AI.run'),
    'tryWorkersAI must still use env.AI.run (unchanged)');

  // tryOpenAI must still exist
  const oaiMatch = PROVIDERS_SRC.match(/async function tryOpenAI\(env, prompt, systemPrompt\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(oaiMatch, 'tryOpenAI must exist in providers.js');
});

test('GS-025: Current model names verified in providers.js', () => {
  // Router architecture: Groq model is now 'openai/gpt-oss-120b' (was llama-3.3-70b-versatile)
  // Gemini removed — no gemini model to check
  // tryGroqSecondary removed — no secondary model to check
  assert.ok(PROVIDERS_SRC.includes("'openai/gpt-oss-120b'"),
    'Groq model must be openai/gpt-oss-120b (router architecture)');
  assert.ok(PROVIDERS_SRC.includes('@cf/meta/llama-3.3-70b-instruct-fp8-fast'),
    'Workers AI model must still be llama-3.3-70b-instruct-fp8-fast (unchanged)');
  // OpenRouter model
  assert.ok(PROVIDERS_SRC.includes('nvidia/nemotron-3-super-120b-a12b:free') || ASSISTANT.includes('nvidia/nemotron-3-super-120b-a12b:free'),
    'OpenRouter model must be unchanged');
});

test('GS-026: No DB schema changes (no CREATE/ALTER/DROP in this task)', () => {
  // This task should NOT have modified any .sql migration files
  // The groq-model-update.sql must be unchanged
  const groqSql = fs.readFileSync(path.join(__dirname, '..', 'scripts/groq-model-update.sql'), 'utf8');
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
  // Router architecture: generateSummaryWithFallback extracted to src/news/summary.js
  // DO serializes all key selection — deterministic by design
  const fnStart = SUMMARY_SRC.indexOf('async function generateSummaryWithFallback(env, prompt, systemPrompt)');
  const nextFn = SUMMARY_SRC.indexOf('\nasync function ', fnStart + 100);
  const body = SUMMARY_SRC.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  assert.ok(!body.includes('Promise.all('),
    'generateSummaryWithFallback must NOT use Promise.all (sequential fallback)');
  assert.ok(!body.includes('Promise.allSettled('),
    'generateSummaryWithFallback must NOT use Promise.allSettled (sequential fallback)');
  // 4-provider chain: each non-primary provider guarded by !summary
  const summaryGuards = (body.match(/if\s*\(!summary\s*&&/g) || []).length;
  assert.ok(summaryGuards >= 3,
    `each fallback provider must be guarded by !summary (found ${summaryGuards}, expected >=3 for openrouter/workers-ai/openai)`);
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

test('GS-030: GROQ_API_KEY is env-based (Cloudflare secret, not Vault)', () => {
  // Router architecture: keys discovered from env at runtime in providers.js (_groqRouterDiscoverKeys)
  // No groqPrimaryGenerate helper — router uses groqRouterExecute → _groqRouterCallGateway
  // The DB function groq_generate_with_key is called internally with explicit key param.
  const groqSql = fs.readFileSync(path.join(__dirname, '..', 'scripts/groq-model-update.sql'), 'utf8');
  assert.ok(groqSql.includes("WHERE name = 'GROQ_API_KEY'"),
    'groq_generate DB function still reads GROQ_API_KEY from vault (backward compat)');
  // Worker/providers must reference env.GROQ_API_KEY (router key discovery)
  assert.ok(PROVIDERS_SRC.includes('env.GROQ_API_KEY'),
    'providers.js MUST reference env.GROQ_API_KEY (router discovers from env)');
  // No active groq_generate() DB function calls (router uses groq_generate_with_key with explicit key)
  assert.ok(PROVIDERS_SRC.includes('groq_generate_with_key'),
    'providers.js uses groq_generate_with_key (key passed explicitly, not from Vault)');
});

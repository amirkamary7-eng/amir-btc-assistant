/**
 * Groq DB Gateway Migration Regression Test
 * ===========================================
 *
 * Verifies that the Worker routes Groq calls through the Supabase DB gateway
 * (public.groq_generate_with_key) instead of direct fetch to api.groq.com.
 *
 * BACKGROUND: Direct Worker → api.groq.com returns HTTP 403 from Cloudflare
 * WAF edge (server:cloudflare). Both Groq keys blocked equally. Root cause:
 * Groq's Cloudflare WAF blocks Cloudflare Worker egress IPs. Fix: route
 * through Supabase DB gateway (same pattern as gemini_generate).
 *
 * Run: node --test groq-gateway-migration-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const assistantSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');

// ════════════════════════════════════════════════════════════════════════════
// TEST 1: _groqFetchWithKey (News AI) must use DB gateway, NOT direct fetch
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-001: _groqFetchWithKey must call groq_generate_with_key DB function (not direct fetch)', () => {
  const fnStart = workerSrc.indexOf('async function _groqFetchWithKey(');
  assert.ok(fnStart !== -1, '_groqFetchWithKey must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2000);
  assert.ok(
    fnBody.includes('groq_generate_with_key'),
    '_groqFetchWithKey must call public.groq_generate_with_key DB function (DB gateway migration)'
  );
  assert.ok(
    !fnBody.includes("fetch('https://api.groq.com"),
    '_groqFetchWithKey must NOT use direct fetch to api.groq.com (WAF blocks Worker egress)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 2: groqPrimaryGenerate (Chat Key0) must use DB gateway
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-002: groqPrimaryGenerate must call groq_generate_with_key DB function (not direct fetch)', () => {
  const fnStart = workerSrc.indexOf('async function groqPrimaryGenerate(');
  assert.ok(fnStart !== -1, 'groqPrimaryGenerate must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 1500);
  assert.ok(
    fnBody.includes('groq_generate_with_key'),
    'groqPrimaryGenerate must call public.groq_generate_with_key DB function (DB gateway migration)'
  );
  assert.ok(
    !fnBody.includes("fetch('https://api.groq.com"),
    'groqPrimaryGenerate must NOT use direct fetch to api.groq.com (WAF blocks Worker egress)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 3: callGroqSecondaryChat (Chat Key1) must use DB gateway
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-003: callGroqSecondaryChat must call groq_generate_with_key DB function (not direct fetch)', () => {
  const fnStart = assistantSrc.indexOf('async function callGroqSecondaryChat(');
  assert.ok(fnStart !== -1, 'callGroqSecondaryChat must exist');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 1500);
  assert.ok(
    fnBody.includes('groq_generate_with_key'),
    'callGroqSecondaryChat must call public.groq_generate_with_key DB function (DB gateway migration)'
  );
  assert.ok(
    !fnBody.includes("fetch('https://api.groq.com"),
    'callGroqSecondaryChat must NOT use direct fetch to api.groq.com (WAF blocks Worker egress)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 4: DB gateway function passes API key as PARAMETER (not from Vault)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-004: All 3 Groq DB gateway calls must pass API key as 3rd parameter ($3::text)', () => {
  // _groqFetchWithKey
  const fetchStart = workerSrc.indexOf('async function _groqFetchWithKey(');
  const fetchBody = workerSrc.substring(fetchStart, fetchStart + 2000);
  assert.ok(
    fetchBody.includes('$3::text') && fetchBody.includes('apiKey'),
    '_groqFetchWithKey must pass apiKey as $3::text parameter to groq_generate_with_key'
  );

  // groqPrimaryGenerate
  const primStart = workerSrc.indexOf('async function groqPrimaryGenerate(');
  const primBody = workerSrc.substring(primStart, primStart + 1500);
  assert.ok(
    primBody.includes('$3::text') && primBody.includes('apiKey'),
    'groqPrimaryGenerate must pass apiKey as $3::text parameter to groq_generate_with_key'
  );

  // callGroqSecondaryChat
  const secStart = assistantSrc.indexOf('async function callGroqSecondaryChat(');
  const secBody = assistantSrc.substring(secStart, secStart + 1500);
  assert.ok(
    secBody.includes('$3::text') && secBody.includes('apiKey'),
    'callGroqSecondaryChat must pass apiKey as $3::text parameter to groq_generate_with_key'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 5: Keys still read from env.GROQ_API_KEY / env.GROQ_API_KEY_1 (unchanged)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-005: Groq keys still read from env.GROQ_API_KEY / env.GROQ_API_KEY_1 (Cloudflare secrets preserved)', () => {
  const fetchStart = workerSrc.indexOf('async function _groqFetchWithKey(');
  const fetchBody = workerSrc.substring(fetchStart, fetchStart + 500);
  assert.ok(fetchBody.includes('env.GROQ_API_KEY_1'), '_groqFetchWithKey must still read Key1 from env.GROQ_API_KEY_1');
  assert.ok(fetchBody.includes('env.GROQ_API_KEY'), '_groqFetchWithKey must still read Key0 from env.GROQ_API_KEY');

  const primStart = workerSrc.indexOf('async function groqPrimaryGenerate(');
  const primBody = workerSrc.substring(primStart, primStart + 500);
  assert.ok(primBody.includes('env.GROQ_API_KEY'), 'groqPrimaryGenerate must still read Key0 from env.GROQ_API_KEY');

  const secStart = assistantSrc.indexOf('async function callGroqSecondaryChat(');
  const secBody = assistantSrc.substring(secStart, secStart + 500);
  assert.ok(secBody.includes('env.GROQ_API_KEY_1'), 'callGroqSecondaryChat must still read Key1 from env.GROQ_API_KEY_1');
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 6: SQL migration file must define groq_generate_with_key function
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-006: 00-migrate.sql must define public.groq_generate_with_key function', () => {
  const migrateSrc = fs.readFileSync(path.join(__dirname, 'scripts/00-migrate.sql'), 'utf8');
  assert.ok(
    migrateSrc.includes('CREATE OR REPLACE FUNCTION public.groq_generate_with_key'),
    '00-migrate.sql must define public.groq_generate_with_key function'
  );
  assert.ok(
    migrateSrc.includes('SECURITY DEFINER'),
    'groq_generate_with_key must be SECURITY DEFINER (same as gemini_generate)'
  );
  assert.ok(
    migrateSrc.includes("search_path TO 'public', 'vault', 'extensions'"),
    'groq_generate_with_key must lock search_path (security)'
  );
  assert.ok(
    migrateSrc.includes('GRANT EXECUTE ON FUNCTION public.groq_generate_with_key'),
    'groq_generate_with_key must have GRANT EXECUTE'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 7: DB gateway function must NOT read from vault (key is a parameter)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-007: groq_generate_with_key must NOT read from vault.decrypted_secrets (key is a parameter)', () => {
  const migrateSrc = fs.readFileSync(path.join(__dirname, 'scripts/00-migrate.sql'), 'utf8');
  // Find the groq_generate_with_key function body
  const fnStart = migrateSrc.indexOf('CREATE OR REPLACE FUNCTION public.groq_generate_with_key');
  assert.ok(fnStart !== -1, 'groq_generate_with_key function must exist');
  // Find the end (the next $function$ after this function)
  const fnEnd = migrateSrc.indexOf('$function$;', fnStart);
  const fnBody = migrateSrc.substring(fnStart, fnEnd);
  assert.ok(
    !fnBody.includes('vault.decrypted_secrets'),
    'groq_generate_with_key must NOT read from vault — key is passed as parameter (p_api_key)'
  );
  assert.ok(
    fnBody.includes('p_api_key'),
    'groq_generate_with_key must use p_api_key parameter'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 8: No direct fetch to api.groq.com remains in Worker code
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-008: No direct fetch to api.groq.com remains in Worker or assistant code', () => {
  // Check worker-proxy.js — the only allowed reference is in comments
  const workerFetchGroq = workerSrc.match(/fetch\(['"]https:\/\/api\.groq\.com/g) || [];
  assert.equal(
    workerFetchGroq.length, 0,
    `worker-proxy.js must have 0 direct fetch() calls to api.groq.com (found ${workerFetchGroq.length}). All Groq calls must go through DB gateway.`
  );

  // Check assistant.js
  const assistantFetchGroq = assistantSrc.match(/fetch\(['"]https:\/\/api\.groq\.com/g) || [];
  assert.equal(
    assistantFetchGroq.length, 0,
    `assistant.js must have 0 direct fetch() calls to api.groq.com (found ${assistantFetchGroq.length}). All Groq calls must go through DB gateway.`
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 9: Circuit breaker keys unchanged (groq-key0, groq-key1)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-009: Circuit breaker keys (groq-key0, groq-key1) unchanged in _groqRoutedFetch', () => {
  const routedStart = workerSrc.indexOf('async function _groqRoutedFetch(');
  assert.ok(routedStart !== -1, '_groqRoutedFetch must exist');
  const routedBody = workerSrc.substring(routedStart, routedStart + 1500);
  assert.ok(routedBody.includes("'groq-key0'"), '_groqRoutedFetch must still use groq-key0 circuit key');
  assert.ok(routedBody.includes("'groq-key1'"), '_groqRoutedFetch must still use groq-key1 circuit key');
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 10: Chat fallback chain order unchanged (groq → groq-secondary → gemini → ...)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-010: Chat fallback chain order unchanged (groq → groq-secondary → gemini → openrouter → workers-ai)', () => {
  // Find the providers array in assistant.js
  // Structure: const providers = hasImage ? [ ... ] : [ text-only chain ];
  const providersMatch = assistantSrc.match(/const providers = hasImage\s*\?\s*\[[\s\S]*?\]\s*:\s*\[([\s\S]*?)\];/);
  assert.ok(providersMatch, 'Chat providers array must exist');
  const textChain = providersMatch[1];
  const groqIdx = textChain.indexOf("'groq'");
  const groqSecIdx = textChain.indexOf("'groq-secondary'");
  const geminiIdx = textChain.indexOf("'gemini'");
  const openrouterIdx = textChain.indexOf("'openrouter'");
  const workersAiIdx = textChain.indexOf("'workers-ai'");
  assert.ok(groqIdx !== -1 && groqSecIdx !== -1, 'Chat must have groq + groq-secondary');
  assert.ok(groqIdx < groqSecIdx, 'groq must come before groq-secondary');
  assert.ok(groqSecIdx < geminiIdx, 'groq-secondary must come before gemini');
  assert.ok(geminiIdx < openrouterIdx, 'gemini must come before openrouter');
  assert.ok(openrouterIdx < workersAiIdx, 'openrouter must come before workers-ai');
});

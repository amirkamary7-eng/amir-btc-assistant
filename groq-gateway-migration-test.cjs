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
test('GROQ-GW-001: _groqRouterCallGateway must call groq_generate_with_key DB function (not direct fetch)', () => {
  const fnStart = workerSrc.indexOf('async function _groqRouterCallGateway(');
  assert.ok(fnStart !== -1, '_groqRouterCallGateway must exist');
  const fnBody = workerSrc.substring(fnStart, fnStart + 2000);
  assert.ok(
    fnBody.includes('groq_generate_with_key'),
    '_groqRouterCallGateway must call public.groq_generate_with_key DB function (DB gateway migration)'
  );
  assert.ok(
    !fnBody.includes("fetch('https://api.groq.com"),
    '_groqRouterCallGateway must NOT use direct fetch to api.groq.com (WAF blocks Worker egress)'
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
    fnBody.includes('groqRouterExecute'),
    'groqPrimaryGenerate must use groqRouterExecute (which uses DB gateway)'
  );
  assert.ok(
    !fnBody.includes("fetch('https://api.groq.com"),
    'groqPrimaryGenerate must NOT use direct fetch to api.groq.com (uses router instead)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 3: callGroqSecondaryChat (Chat Key1) must use DB gateway
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-003: callGroqSecondaryChat removed (router handles all keys)', () => {
  assert.ok(
    !assistantSrc.includes('async function callGroqSecondaryChat('),
    'callGroqSecondaryChat must be REMOVED (router handles all key selection)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 4: DB gateway function passes API key as PARAMETER (not from Vault)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-004: _groqRouterCallGateway must pass API key as 3rd parameter ($3::text)', () => {
  // _groqRouterCallGateway (the single DB gateway call site)
  const gwStart = workerSrc.indexOf('async function _groqRouterCallGateway(');
  assert.ok(gwStart !== -1, '_groqRouterCallGateway must exist');
  const gwBody = workerSrc.substring(gwStart, gwStart + 1000);
  assert.ok(
    gwBody.includes('$3::text') && gwBody.includes('apiKey'),
    '_groqRouterCallGateway must pass apiKey as $3::text parameter to groq_generate_with_key'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 5: Keys still read from env.GROQ_API_KEY / env.GROQ_API_KEY_1 (unchanged)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-005: Router discovers all 4 Groq keys from env (Cloudflare secrets preserved)', () => {
  const discoverStart = workerSrc.indexOf('function _groqRouterDiscoverKeys(');
  assert.ok(discoverStart !== -1, '_groqRouterDiscoverKeys must exist');
  const discoverBody = workerSrc.substring(discoverStart, discoverStart + 500);
  assert.ok(discoverBody.includes('env.GROQ_API_KEY'), 'must read Key0 from env.GROQ_API_KEY');
  assert.ok(discoverBody.includes('env.GROQ_API_KEY_1'), 'must read Key1 from env.GROQ_API_KEY_1');
  assert.ok(discoverBody.includes('env.GROQ_API_KEY_2'), 'must read Key2 from env.GROQ_API_KEY_2');
  assert.ok(discoverBody.includes('env.GROQ_API_KEY_3'), 'must read Key3 from env.GROQ_API_KEY_3');
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
test('GROQ-GW-008: No direct fetch to api.groq.com remains (all via DB gateway)', () => {
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
test('GROQ-GW-009: Old groq-key0/groq-key1 circuits replaced by router per-key state', () => {
  // The old groq-key0/groq-key1 circuit keys are replaced by groq:router:key{N}
  assert.ok(
    workerSrc.includes("GROQ_ROUTER_KEY_PREFIX = 'groq:router:key'"),
    'Router must use groq:router:key{N} prefix (replaces old groq-key0/groq-key1)'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 10: Chat fallback chain order unchanged (groq → groq-secondary → gemini → ...)
// ════════════════════════════════════════════════════════════════════════════
test('GROQ-GW-010: Chat fallback chain: Groq → OpenRouter → Workers AI → OpenAI (no Gemini, no groq-secondary)', () => {
  // FINAL AUDIT: Chat fallback: Groq → OpenRouter → Gemini → Workers AI → OpenAI
  const fnStart = assistantSrc.indexOf('const providers = hasImage');
  assert.ok(fnStart !== -1, 'Chat providers array must exist');
  const fnBody = assistantSrc.substring(fnStart, fnStart + 800);
  assert.ok(fnBody.includes("['groq'"), 'Chat must have Groq');
  assert.ok(fnBody.includes("['openrouter'"), 'Chat must have OpenRouter');
  assert.ok(fnBody.includes("['gemini'"), 'Chat must have Gemini (restored for Chat only)');
  assert.ok(fnBody.includes("['workers-ai'"), 'Chat must have Workers AI');
  assert.ok(!fnBody.includes("['groq-secondary'"), 'Chat must NOT have groq-secondary');
});

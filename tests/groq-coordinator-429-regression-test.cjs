/**
 * Fix 1 + Fix 2 — Groq Coordinator 429 Tracking + RPM Limit Regression Tests
 *
 * Fix 1: recordGroqRequest must be called when Groq Primary returns HTTP 429
 *   (the request DID reach Groq and consumed quota). Tests verify:
 *   - F1-001: tryGroq calls recordGroqRequest on 429 (News Summary path)
 *   - F1-002: batchTranslateToFarsi calls recordGroqRequest on 429
 *   - F1-003: translateToFarsi calls recordGroqRequest on 429
 *   - F1-004: batchAnalyzeNews calls recordGroqRequest on 429
 *   - F1-005: callGroqChat calls recordGroqRequest on 429 (chat path)
 *   - F1-006: recordGroqRequest is NOT called on non-429 HTTP errors (400/500)
 *   - F1-007: recordGroqRequest is NOT called on timeout/network errors
 *   - F1-008: recordGroqRequest is NOT called twice for the same request (no double-count)
 *   - F1-009: recordGroqRequest IS called on success (existing behavior preserved)
 *
 * Fix 2: GROQ_RPM_LIMIT=20 in production wrangler.jsonc
 *   - F2-001: wrangler.jsonc production vars include GROQ_RPM_LIMIT=20
 *   - F2-002: wrangler.jsonc staging does NOT have GROQ_RPM_LIMIT (uses default 30)
 *   - F2-003: wrangler.jsonc top-level does NOT have GROQ_RPM_LIMIT (uses default 30)
 *   - F2-004: getGroqRpmLimit reads env.GROQ_RPM_LIMIT (not a dead config)
 *   - F2-005: effective RPM with margin 0.85 = 17 (20 * 0.85 = 17)
 *
 * Run: node --test groq-coordinator-429-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');
const ASSISTANT = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/assistant.js'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(__dirname, '..', 'wrangler.jsonc'), 'utf8');

// ============================================================================
// Fix 1 — recordGroqRequest called on 429 (all 5 Primary paths)
// ============================================================================

// OBSOLETE — REMOVED: F1-001: tryGroq calls recordGroqRequest on 429 (News Summary path)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the Router DO `record` action.
// The DO records each request exactly once after the gateway call returns
// (whether 200, 429, 5xx, or timeout). tryGroq no longer has an inline
// `statusCode === 429` branch that calls recordGroqRequest directly.

// OBSOLETE — REMOVED: F1-002: batchTranslateToFarsi calls recordGroqRequest on 429
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the Router DO `record` action.
// batchTranslateToFarsi no longer inspects groqResult.status_code === 429;
// the DO handles all status code accounting inside its record() handler.

// OBSOLETE — REMOVED: F1-003: translateToFarsi calls recordGroqRequest on 429
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the Router DO `record` action.
// translateToFarsi no longer has the indEstTokens / recordGroqRequest inline
// 429 branch; the DO's record() handles status accounting per request.

// OBSOLETE — REMOVED: F1-004: batchAnalyzeNews calls recordGroqRequest on 429
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the Router DO `record` action.
// batchAnalyzeNews no longer branches on statusCode === 429 to call
// recordGroqRequest(env, batchEstTokens); the DO records every call centrally.

// OBSOLETE — REMOVED: F1-005: callGroqChat calls recordGroqRequest on 429 (chat path)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the Router DO `record` action.
// callGroqChat no longer has a "Fix 1: If Groq returned 429" block with a
// recordGroqRequest(env, _estTokens) call; the DO records each call once.

// OBSOLETE — REMOVED: F1-006: recordGroqRequest is NOT called on non-429 HTTP errors (tryGroq)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest no longer exists; the Router DO `record` action is
// invoked once per request regardless of HTTP status (including 400/500).
// The "only on 429" selective-recording behavior is obsolete.

// OBSOLETE — REMOVED: F1-007: recordGroqRequest is NOT called on timeout/network errors (tryGroq)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the DO `record` action. The DO
// records every request including timeouts/network errors (treated as 5xx in
// the per-key circuit), so the "do not record on timeout" rule no longer holds.

// OBSOLETE — REMOVED: F1-008: recordGroqRequest is NOT called twice for the same request (no double-count)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the DO `record` action. The DO
// is the single owner of the per-key counter and is invoked exactly once per
// request via _groqRouterCallGateway — there is no double-count path to test.

// OBSOLETE — REMOVED: F1-009: recordGroqRequest IS called on success (existing behavior preserved)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: recordGroqRequest was replaced by the DO `record` action. The DO
// records successful calls once per request — there is no inline success-path
// recordGroqRequest call in tryGroq / callGroqChat anymore.

// ============================================================================
// Fix 2 — GROQ_RPM_LIMIT=20 in production wrangler.jsonc
// ============================================================================

test('F2-001: wrangler.jsonc production vars include GROQ_RPM_LIMIT=20', () => {
  // Find the production env block
  const prodIdx = WRANGLER.indexOf('"production": {');
  assert.ok(prodIdx >= 0, 'production env not found in wrangler.jsonc');
  // Find the vars block within production (window widened — migrations + vars are ~3500 chars)
  const prodBlock = WRANGLER.slice(prodIdx, prodIdx + 5000);
  const varsIdx = prodBlock.indexOf('"vars": {');
  assert.ok(varsIdx >= 0, 'vars block not found in production env');
  const varsBlock = prodBlock.slice(varsIdx, varsIdx + 2000);
  assert.ok(varsBlock.includes('"GROQ_RPM_LIMIT": 20'),
    'production vars must include GROQ_RPM_LIMIT=20');
});

test('F2-002: wrangler.jsonc staging does NOT have GROQ_RPM_LIMIT (uses default 30)', () => {
  const stagingIdx = WRANGLER.indexOf('"staging": {');
  assert.ok(stagingIdx >= 0, 'staging env not found in wrangler.jsonc');
  const stagingBlock = WRANGLER.slice(stagingIdx, stagingIdx + 3000);
  const varsIdx = stagingBlock.indexOf('"vars": {');
  assert.ok(varsIdx >= 0, 'vars block not found in staging env');
  const varsBlock = stagingBlock.slice(varsIdx, varsIdx + 1000);
  assert.ok(!varsBlock.includes('GROQ_RPM_LIMIT'),
    'staging vars must NOT include GROQ_RPM_LIMIT (uses code default 30)');
});

test('F2-003: wrangler.jsonc top-level does NOT have GROQ_RPM_LIMIT (uses default 30)', () => {
  // Top-level vars is the first "vars" block before "env"
  const envIdx = WRANGLER.indexOf('"env": {');
  assert.ok(envIdx >= 0, 'env block not found');
  const topLevelBlock = WRANGLER.slice(0, envIdx);
  const varsIdx = topLevelBlock.indexOf('"vars": {');
  assert.ok(varsIdx >= 0, 'top-level vars block not found');
  const varsBlock = topLevelBlock.slice(varsIdx, envIdx);
  assert.ok(!varsBlock.includes('GROQ_RPM_LIMIT'),
    'top-level vars must NOT include GROQ_RPM_LIMIT (uses code default 30)');
});

// OBSOLETE — REMOVED: F2-004: getGroqRpmLimit reads env.GROQ_RPM_LIMIT (not a dead config)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: getGroqRpmLimit() was removed entirely. The router uses a fixed
// MAX_PER_WINDOW=3 calls per 10-minute window per key, configured as a
// constant inside the DO. There is no env.GROQ_RPM_LIMIT read left to verify.

// OBSOLETE — REMOVED: F2-005: effective RPM with margin 0.85 = 17 (20 * 0.85 = 17)
// The following functionality was removed when the Groq Coordinator was
// replaced by the Groq Router Durable Object (src/durable-objects/groq-router.js).
// Reason: getGroqRpmLimit() and the safety-margin computation were removed.
// The router uses a flat MAX_PER_WINDOW=3 calls per 10-minute window per key
// (12 calls/min across 4 keys) — there is no 20 * 0.85 = 17 math left to assert.

// ============================================================================
// Security: no API key in diff
// ============================================================================

test('SEC: no Groq API key value (gsk_ prefix) in any source file', () => {
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

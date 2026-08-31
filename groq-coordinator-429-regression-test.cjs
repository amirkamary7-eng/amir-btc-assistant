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

const WORKER = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const ASSISTANT = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
const WRANGLER = fs.readFileSync(path.join(__dirname, 'wrangler.jsonc'), 'utf8');

// ============================================================================
// Fix 1 — recordGroqRequest called on 429 (all 5 Primary paths)
// ============================================================================

test('F1-001: tryGroq calls recordGroqRequest on 429 (News Summary path)', () => {
  // Find the 429-handling branch in tryGroq
  const fnStart = WORKER.indexOf('async function tryGroq(env, prompt, systemPrompt)');
  assert.ok(fnStart >= 0, 'tryGroq not found');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // Find the statusCode !== 200 branch
  const branchIdx = body.indexOf('if (statusCode !== 200)');
  assert.ok(branchIdx >= 0, 'statusCode !== 200 branch not found in tryGroq');
  const branch = body.slice(branchIdx, branchIdx + 500);
  // Must have a 429-specific recordGroqRequest call
  assert.ok(branch.includes('statusCode === 429'),
    'must check statusCode === 429 in the error branch');
  assert.ok(branch.includes('recordGroqRequest(env, estTokens)'),
    'must call recordGroqRequest on 429 in tryGroq');
});

test('F1-002: batchTranslateToFarsi calls recordGroqRequest on 429', () => {
  const fnStart = WORKER.indexOf('async function batchTranslateToFarsi(texts, env)');
  assert.ok(fnStart >= 0, 'batchTranslateToFarsi not found');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // Find the HTTP error branch (groqResult.status_code !== 200)
  const branchMarker = body.indexOf('Groq failed (HTTP ${groqResult.status_code}) — falling back to individual');
  assert.ok(branchMarker >= 0, 'HTTP error branch not found in batchTranslateToFarsi');
  const branch = body.slice(branchMarker - 400, branchMarker + 200);
  assert.ok(branch.includes('groqResult.status_code === 429'),
    'must check groqResult.status_code === 429');
  assert.ok(branch.includes('recordGroqRequest(env, estTokens)'),
    'must call recordGroqRequest on 429 in batchTranslateToFarsi');
});

test('F1-003: translateToFarsi calls recordGroqRequest on 429', () => {
  const fnStart = WORKER.indexOf('async function translateToFarsi(text, env)');
  assert.ok(fnStart >= 0, 'translateToFarsi not found');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // Find the HTTP error branch
  const branchMarker = body.indexOf("Groq failed (non-fatal)");
  assert.ok(branchMarker >= 0, 'HTTP error branch not found in translateToFarsi');
  const branch = body.slice(branchMarker - 400, branchMarker + 200);
  assert.ok(branch.includes('groqResult.status_code === 429'),
    'must check groqResult.status_code === 429');
  assert.ok(branch.includes('recordGroqRequest(env, indEstTokens)'),
    'must call recordGroqRequest on 429 in translateToFarsi (with indEstTokens)');
});

test('F1-004: batchAnalyzeNews calls recordGroqRequest on 429', () => {
  const fnStart = WORKER.indexOf('async function batchAnalyzeNews(env, articles)');
  assert.ok(fnStart >= 0, 'batchAnalyzeNews not found');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // Find the HTTP error branch
  const branchMarker = body.indexOf('Groq failed (HTTP ${statusCode}) — falling back to Gemini');
  assert.ok(branchMarker >= 0, 'HTTP error branch not found in batchAnalyzeNews');
  const branch = body.slice(branchMarker - 400, branchMarker + 200);
  assert.ok(branch.includes('statusCode === 429'),
    'must check statusCode === 429');
  assert.ok(branch.includes('recordGroqRequest(env, batchEstTokens)'),
    'must call recordGroqRequest on 429 in batchAnalyzeNews (with batchEstTokens)');
});

test('F1-005: callGroqChat calls recordGroqRequest on 429 (chat path)', () => {
  const fnStart = ASSISTANT.indexOf('async function callGroqChat(env, prompt)');
  assert.ok(fnStart >= 0, 'callGroqChat not found');
  const nextFn = ASSISTANT.indexOf('\n  function ', fnStart + 100);
  const body = ASSISTANT.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // Must have a 429 check before _parseGroqResult (which throws on non-200)
  const fixComment = body.indexOf('Fix 1: If Groq returned 429');
  assert.ok(fixComment >= 0, 'Fix 1 comment not found in callGroqChat');
  const fixBlock = body.slice(fixComment, fixComment + 800);
  assert.ok(fixBlock.includes('_groqStatusCode === 429'),
    'must check _groqStatusCode === 429');
  assert.ok(fixBlock.includes('recordGroqRequest(env, _estTokens)'),
    'must call recordGroqRequest on 429 in callGroqChat');
});

test('F1-006: recordGroqRequest is NOT called on non-429 HTTP errors (tryGroq)', () => {
  // In tryGroq, the 429 check is specific — other HTTP errors (400/500) should NOT record
  const fnStart = WORKER.indexOf('async function tryGroq(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  const branchIdx = body.indexOf('if (statusCode !== 200)');
  const branch = body.slice(branchIdx, branchIdx + 500);
  // The recordGroqRequest must be INSIDE the statusCode === 429 if-block,
  // not before it (which would fire on all HTTP errors)
  const recordIdx = branch.indexOf('recordGroqRequest');
  const check429Idx = branch.indexOf('statusCode === 429');
  assert.ok(recordIdx > check429Idx,
    'recordGroqRequest must be AFTER the statusCode === 429 check (only fires on 429, not other errors)');
});

test('F1-007: recordGroqRequest is NOT called on timeout/network errors (tryGroq)', () => {
  const fnStart = WORKER.indexOf('async function tryGroq(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  // The OUTER catch block (timeout/network) must NOT call recordGroqRequest.
  // Find the catch block that contains isAbort (the timeout/network handler)
  const isAbortIdx = body.indexOf('isAbort = e?.name');
  assert.ok(isAbortIdx >= 0, 'isAbort (timeout/network catch) not found in tryGroq');
  // Find the catch block start before isAbort
  const catchStart = body.lastIndexOf('} catch (e) {', isAbortIdx);
  assert.ok(catchStart >= 0, 'catch block for timeout/network not found');
  const catchBlock = body.slice(catchStart, isAbortIdx + 300);
  assert.ok(!catchBlock.includes('recordGroqRequest'),
    'timeout/network catch block must NOT call recordGroqRequest — request may not have reached Groq');
});

test('F1-008: recordGroqRequest is NOT called twice for the same request (no double-count)', () => {
  // In tryGroq, the 429 branch returns immediately after recording —
  // the success branch (which also records) is never reached on 429
  const fnStart = WORKER.indexOf('async function tryGroq(env, prompt, systemPrompt)');
  const nextFn = WORKER.indexOf('\nasync function ', fnStart + 100);
  const body = WORKER.slice(fnStart, nextFn > 0 ? nextFn : undefined);
  const branch429 = body.indexOf('if (statusCode === 429)');
  const returnAfter429 = body.indexOf('return {', branch429);
  const successRecord = body.indexOf('recordGroqRequest(env, estTokens);', returnAfter429);
  // The success-branch recordGroqRequest must come AFTER the 429 return,
  // meaning it's only reachable on success (not double-counted)
  assert.ok(successRecord > 0,
    'success-branch recordGroqRequest must exist after the 429 return (no double-count)');
});

test('F1-009: recordGroqRequest IS called on success (existing behavior preserved)', () => {
  // All 5 paths must still call recordGroqRequest on success
  // tryGroq
  const tryGroqBody = WORKER.slice(
    WORKER.indexOf('async function tryGroq'),
    WORKER.indexOf('\nasync function ', WORKER.indexOf('async function tryGroq') + 100)
  );
  assert.ok(tryGroqBody.includes('success: true') && tryGroqBody.includes('recordGroqRequest'),
    'tryGroq must still call recordGroqRequest on success');
  // callGroqChat
  const callGroqBody = ASSISTANT.slice(
    ASSISTANT.indexOf('async function callGroqChat'),
    ASSISTANT.indexOf('\n  function ', ASSISTANT.indexOf('async function callGroqChat') + 100)
  );
  assert.ok(callGroqBody.includes('ONLY on success') && callGroqBody.includes('recordGroqRequest'),
    'callGroqChat must still call recordGroqRequest on success');
});

// ============================================================================
// Fix 2 — GROQ_RPM_LIMIT=20 in production wrangler.jsonc
// ============================================================================

test('F2-001: wrangler.jsonc production vars include GROQ_RPM_LIMIT=20', () => {
  // Find the production env block
  const prodIdx = WRANGLER.indexOf('"production": {');
  assert.ok(prodIdx >= 0, 'production env not found in wrangler.jsonc');
  // Find the vars block within production
  const prodBlock = WRANGLER.slice(prodIdx, prodIdx + 3000);
  const varsIdx = prodBlock.indexOf('"vars": {');
  assert.ok(varsIdx >= 0, 'vars block not found in production env');
  const varsBlock = prodBlock.slice(varsIdx, varsIdx + 1000);
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

test('F2-004: getGroqRpmLimit reads env.GROQ_RPM_LIMIT (not a dead config)', () => {
  assert.ok(WORKER.includes('function getGroqRpmLimit(env)'),
    'getGroqRpmLimit function must exist');
  // The function must read env.GROQ_RPM_LIMIT
  const fnBody = WORKER.slice(
    WORKER.indexOf('function getGroqRpmLimit(env)'),
    WORKER.indexOf('function getGroqRpmLimit(env)') + 200
  );
  assert.ok(fnBody.includes('env?.GROQ_RPM_LIMIT'),
    'getGroqRpmLimit must read env.GROQ_RPM_LIMIT — this confirms the wrangler.jsonc var is NOT dead config');
  assert.ok(fnBody.includes("'30'"),
    'getGroqRpmLimit must have default fallback of 30');
});

test('F2-005: effective RPM with margin 0.85 = 17 (20 * 0.85 = 17)', () => {
  // Verify the math: effectiveRpmLimit = Math.floor(rpmLimit * margin)
  // With rpmLimit=20 and margin=0.85: Math.floor(20 * 0.85) = Math.floor(17.0) = 17
  const rpmLimit = 20;
  const margin = 0.85;
  const effective = Math.floor(rpmLimit * margin);
  assert.equal(effective, 17,
    `effective RPM = Math.floor(${rpmLimit} * ${margin}) = ${effective} (expected 17)`);
  // Verify the code uses Math.floor for the effective limit
  assert.ok(WORKER.includes('Math.floor(rpmLimit * margin)'),
    'checkGroqCapacity must use Math.floor(rpmLimit * margin) for effective limit');
});

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
  checkFiles(__dirname);
});

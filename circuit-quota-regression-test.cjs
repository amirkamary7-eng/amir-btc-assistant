/**
 * Circuit Breaker + m2m100 Quota Suppression Regression Tests
 * ============================================================
 * Tests for:
 * 1. FIX 1: Coordinator denial must NOT trip circuit breaker
 * 2. FIX 2: m2m100 4006 daily quota suppression
 *
 * Run: node --test circuit-quota-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');

// ═════════════════════════════════════════════════════════════════════
// FIX 1: Coordinator denial must NOT trip circuit
// ═════════════════════════════════════════════════════════════════════

test('FIX1-01: attemptProvider checks coordinator_skipped before recordCircuitResult', () => {
  // The code must have: if (!r.coordinator_skipped) { recordCircuitResult(...) }
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function attemptProvider'),
    WORKER_SRC.indexOf('async function attemptProvider') + 2500
  );
  assert.ok(section.includes('coordinator_skipped'),
    'attemptProvider must check coordinator_skipped flag');
  // The !r.coordinator_skipped check wraps recordCircuitResult
  // Find the LAST occurrence of coordinator_skipped (the guard)
  const guardIdx = section.lastIndexOf('coordinator_skipped');
  const recordIdx = section.indexOf('recordCircuitResult', guardIdx);
  assert.ok(guardIdx > -1, 'coordinator_skipped guard must exist');
  assert.ok(recordIdx > -1, 'recordCircuitResult must exist after guard');
  assert.ok(recordIdx > guardIdx,
    'recordCircuitResult must be inside the !coordinator_skipped guard');
});

test('FIX1-02: tryGroq returns coordinator_skipped=true when capacity denied', () => {
  const tryGroqSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function tryGroq'),
    WORKER_SRC.indexOf('async function tryGemini')
  );
  assert.ok(tryGroqSection.includes('coordinator_skipped: true'),
    'tryGroq must return coordinator_skipped: true when capacity is denied');
});

test('FIX1-03: Chat AI checks _coordinatorSkipped before circuit recording', () => {
  assert.ok(ASSISTANT_SRC.includes('!error?._coordinatorSkipped'),
    'Chat AI must check _coordinatorSkipped before recording circuit failure');
});

test('FIX1-04: Real Groq 429 still trips circuit (not skipped)', () => {
  // When Groq returns HTTP 429, tryGroq does NOT set coordinator_skipped
  // The error is classified as retryable via classifyHttpError(429)
  // attemptProvider will record it because coordinator_skipped is falsy
  const tryGroqSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function tryGroq'),
    WORKER_SRC.indexOf('async function tryGemini')
  );
  // Verify that HTTP errors do NOT set coordinator_skipped
  const httpErrorSection = tryGroqSection.slice(
    tryGroqSection.indexOf('statusCode !== 200'),
    tryGroqSection.indexOf('statusCode !== 200') + 300
  );
  assert.ok(!httpErrorSection.includes('coordinator_skipped'),
    'HTTP errors must NOT set coordinator_skipped (they are real provider failures)');
});

test('FIX1-05: Real Groq 5xx still trips circuit (not skipped)', () => {
  // classifyHttpError(500) → 'retryable'
  // tryGroq returns this without coordinator_skipped
  // attemptProvider records it as failure
  const tryGroqSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function tryGroq'),
    WORKER_SRC.indexOf('async function tryGemini')
  );
  // The only place coordinator_skipped is set is in the capacity check
  const coordinatorSkipCount = (tryGroqSection.match(/coordinator_skipped/g) || []).length;
  assert.equal(coordinatorSkipCount, 1,
    'coordinator_skipped should appear exactly once (only in capacity check)');
});

// ═════════════════════════════════════════════════════════════════════
// FIX 2: m2m100 4006 daily quota suppression
// ═════════════════════════════════════════════════════════════════════

test('FIX2-01: isM2m100QuotaExhausted function exists', () => {
  assert.ok(WORKER_SRC.includes('async function isM2m100QuotaExhausted'),
    'isM2m100QuotaExhausted must exist');
});

test('FIX2-02: markM2m100QuotaExhausted function exists', () => {
  assert.ok(WORKER_SRC.includes('async function markM2m100QuotaExhausted'),
    'markM2m100QuotaExhausted must exist');
});

test('FIX2-03: M2M100_QUOTA_KV_KEY is defined', () => {
  assert.ok(WORKER_SRC.includes("M2M100_QUOTA_KV_KEY = 'wai:m2m100:quota_exhausted'"),
    'M2M100_QUOTA_KV_KEY must be defined');
});

test('FIX2-04: isM2m100QuotaExhausted checks in-memory flag first (fast path)', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function isM2m100QuotaExhausted'),
    WORKER_SRC.indexOf('async function isM2m100QuotaExhausted') + 500
  );
  assert.ok(section.includes('_m2m100QuotaExhausted'),
    'Must check in-memory flag');
  assert.ok(section.includes('_m2m100QuotaResetAt'),
    'Must check reset timestamp');
});

test('FIX2-05: isM2m100QuotaExhausted checks KV for cross-isolate propagation', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function isM2m100QuotaExhausted'),
    WORKER_SRC.indexOf('async function isM2m100QuotaExhausted') + 800
  );
  assert.ok(section.includes('readAppCache'),
    'Must read from KV for cross-isolate propagation');
  assert.ok(section.includes('M2M100_QUOTA_KV_KEY'),
    'Must use the KV key');
});

test('FIX2-06: isM2m100QuotaExhausted auto-resets when reset time passes', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function isM2m100QuotaExhausted'),
    WORKER_SRC.indexOf('async function isM2m100QuotaExhausted') + 600
  );
  assert.ok(section.includes('Date.now() >= _m2m100QuotaResetAt'),
    'Must auto-reset when current time passes reset time');
  assert.ok(section.includes('_m2m100QuotaExhausted = false'),
    'Must clear the flag on reset');
});

test('FIX2-07: markM2m100QuotaExhausted calculates UTC midnight reset', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function markM2m100QuotaExhausted'),
    WORKER_SRC.indexOf('async function markM2m100QuotaExhausted') + 600
  );
  assert.ok(section.includes('Date.UTC'),
    'Must calculate UTC midnight using Date.UTC');
  assert.ok(section.includes('getUTCDate() + 1'),
    'Must calculate next day for midnight reset');
});

test('FIX2-08: markM2m100QuotaExhausted writes to KV with TTL until midnight', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function markM2m100QuotaExhausted'),
    WORKER_SRC.indexOf('async function markM2m100QuotaExhausted') + 800
  );
  assert.ok(section.includes('writeAppCache'),
    'Must write to KV');
  assert.ok(section.includes('ttlSeconds'),
    'Must calculate TTL seconds');
  assert.ok(section.includes('Math.max(60'),
    'TTL must have minimum 60 seconds (KV requirement)');
});

test('FIX2-09: translateToFarsi checks quota BEFORE calling m2m100', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('if (env?.AI) {'),
    WORKER_SRC.indexOf('if (env?.AI) {') + 1000
  );
  // Find the section that contains m2m100 check
  const m2m100Section = section.slice(section.indexOf('m2m100QuotaExhausted'));
  assert.ok(m2m100Section.includes('isM2m100QuotaExhausted'),
    'translateToFarsi must call isM2m100QuotaExhausted');
  // The quota check must come BEFORE env.AI.run
  const quotaCheckIdx = section.indexOf('isM2m100QuotaExhausted');
  const aiRunIdx = section.indexOf('env.AI.run');
  assert.ok(quotaCheckIdx > -1 && aiRunIdx > -1, 'Both must exist');
  assert.ok(quotaCheckIdx < aiRunIdx,
    'Quota check must come BEFORE env.AI.run call');
});

test('FIX2-10: translateToFarsi calls markM2m100QuotaExhausted on 4006', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('FIX 2: If 4006'),
    WORKER_SRC.indexOf('FIX 2: If 4006') + 300
  );
  assert.ok(section.includes('markM2m100QuotaExhausted'),
    'Must call markM2m100QuotaExhausted when 4006 is detected');
  assert.ok(section.includes('msgHasQuotaError'),
    'Must check msgHasQuotaError (covers 4006, 3036, 5035)');
});

test('FIX2-11: Suppression is separate from circuit breaker (different key)', () => {
  assert.ok(WORKER_SRC.includes("'wai:m2m100:quota_exhausted'"),
    'Quota suppression KV key is separate from circuit breaker keys');
  assert.ok(WORKER_SRC.includes("'news:circuit:"),
    'Circuit breaker uses different key prefix');
  // The suppression key does NOT use circuit breaker prefix
  assert.ok(!WORKER_SRC.includes("news:circuit:wai:m2m100"),
    'Quota suppression must NOT use circuit breaker prefix');
});

test('FIX2-12: After quota exhausted, m2m100 is NOT called (no env.AI.run)', () => {
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('FIX 2: Check daily quota suppression'),
    WORKER_SRC.indexOf('FIX 2: Check daily quota suppression') + 500
  );
  assert.ok(section.includes('if (m2m100QuotaExhausted)'),
    'Must check quota flag');
  // When quota exhausted, code falls through to Google Translate
  // without calling env.AI.run
  assert.ok(section.includes('else'),
    'Must have else block for when quota is NOT exhausted');
});

// ═════════════════════════════════════════════════════════════════════
// Integration: verify both fixes coexist correctly
// ═════════════════════════════════════════════════════════════════════

test('INTEGRATION-01: Circuit breaker still works for real failures (not coordinator)', () => {
  // recordCircuitResult is still called for non-coordinator failures
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('FIX: Coordinator denial'),
    WORKER_SRC.indexOf('FIX: Coordinator denial') + 300
  );
  assert.ok(section.includes('if (!r.coordinator_skipped)'),
    'Must still call recordCircuitResult for non-coordinator failures');
  assert.ok(section.includes('recordCircuitResult'),
    'recordCircuitResult must still be present');
});

test('INTEGRATION-02: m2m100 circuit breaker still works (separate from quota)', () => {
  // The circuit breaker for 'translation-workers-ai' is still checked
  // (after the quota check passes)
  const section = WORKER_SRC.slice(
    WORKER_SRC.indexOf('FIX 2: Check daily quota suppression'),
    WORKER_SRC.indexOf('FIX 2: Check daily quota suppression') + 800
  );
  assert.ok(section.includes('shouldAttemptProvider'),
    'Circuit breaker check must still be present (after quota check)');
  assert.ok(section.includes("'translation-workers-ai'"),
    'Circuit breaker key must be translation-workers-ai');
});

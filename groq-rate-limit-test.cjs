/**
 * Test: Groq rate limiting — batch translation replaces sequential individual calls.
 *
 * PHASE 3 UPDATE: The old TRANSLATION_BATCH_SIZE=1 (sequential one-at-a-time)
 * approach has been replaced with batchTranslateToFarsi(), which sends all
 * headlines in 1-2 Groq requests instead of 21 individual calls.
 *
 * Run: node --test groq-rate-limit-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

test('GROQ-RL-001: batchTranslateToFarsi replaces individual sequential calls', () => {
  // The old TRANSLATION_BATCH_SIZE approach is gone — replaced by batchTranslateToFarsi
  assert.ok(!WORKER_SRC.includes('TRANSLATION_BATCH_SIZE = 1'),
    'Old TRANSLATION_BATCH_SIZE = 1 must be removed (replaced by batchTranslateToFarsi)');
  assert.ok(!WORKER_SRC.includes('TRANSLATION_BATCH_SIZE = 3'),
    'Old TRANSLATION_BATCH_SIZE = 3 must be removed');
  assert.ok(WORKER_SRC.includes('batchTranslateToFarsi'),
    'batchTranslateToFarsi must be used for translations');
});

test('GROQ-RL-002: batchTranslateToFarsi sends multiple headlines in 1 Groq call', () => {
  // Verify batch approach: sends multiple headlines in a single Groq request
  assert.ok(WORKER_SRC.includes('BATCH_TRANSLATION_MAX_BATCH'),
    'Must have BATCH_TRANSLATION_MAX_BATCH constant');
  assert.ok(WORKER_SRC.includes('batchTexts.map((t, i) =>'),
    'Must build numbered headline list for batch request');
  assert.ok(WORKER_SRC.includes('JSON array'),
    'Must ask for JSON array response');
});

test('GROQ-RL-003: Groq model, circuit, fallback chain unchanged', () => {
  // Model must still be openai/gpt-oss-120b
  assert.ok(WORKER_SRC.includes("'openai/gpt-oss-120b'"),
    'Groq model must be unchanged');
  // Circuit breaker key must still be 'groq'
  assert.ok(WORKER_SRC.includes("shouldAttemptProvider(env, 'groq')"),
    'Groq circuit breaker key must be unchanged');
  // Fallback chain must still have Groq → Gemini → Workers AI → OpenRouter
  assert.ok(WORKER_SRC.includes("attemptProvider('groq'") &&
          WORKER_SRC.includes("attemptProvider('gemini'") &&
          WORKER_SRC.includes("attemptProvider('workers-ai'") &&
          WORKER_SRC.includes("attemptProvider('openrouter'"),
    'Provider fallback chain must be unchanged');
  // max_tokens for summary (1024) and batch analysis (2048) must be unchanged
  assert.ok(WORKER_SRC.includes('groq_generate') &&
          WORKER_SRC.includes('1024') &&
          WORKER_SRC.includes('2048'),
    'max_tokens for summary (1024) and batch (2048) must be unchanged');
});

test('GROQ-RL-004: batchTranslateToFarsi falls back to individual on failure', () => {
  assert.ok(WORKER_SRC.includes('Falling back to individual translation'),
    'Must have fallback to individual translateToFarsi');
  assert.ok(WORKER_SRC.includes('translateToFarsi(batchTexts[i], env)'),
    'Must call translateToFarsi for individual fallback');
});

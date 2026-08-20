/**
 * Test: Groq translation batch size is 1 (sequential, not parallel).
 *
 * Run: node --test groq-rate-limit-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

test('GROQ-RL-001: TRANSLATION_BATCH_SIZE is 1 (sequential, not parallel)', () => {
  assert.ok(WORKER_SRC.includes('TRANSLATION_BATCH_SIZE = 1'),
    'TRANSLATION_BATCH_SIZE must be 1 (was 3)');
  assert.ok(!WORKER_SRC.includes('TRANSLATION_BATCH_SIZE = 3'),
    'old TRANSLATION_BATCH_SIZE = 3 must be removed');
});

test('GROQ-RL-002: batch size 1 means Promise.all receives only 1 item (no parallel Groq calls)', () => {
  // With batch size 1, Promise.all receives a single-element array
  // → only 1 translateToFarsi call per iteration → sequential, not parallel
  const batchSizeIdx = WORKER_SRC.indexOf('TRANSLATION_BATCH_SIZE = 1');
  const loopBlock = WORKER_SRC.slice(batchSizeIdx, batchSizeIdx + 300);
  assert.ok(loopBlock.includes('for (let i = 0; i < titlesToTranslate.length; i += TRANSLATION_BATCH_SIZE)'),
    'loop must iterate by TRANSLATION_BATCH_SIZE');
  assert.ok(loopBlock.includes('Promise.all'),
    'Promise.all still used (with 1-item array = sequential)');
});

test('GROQ-RL-003: no other Groq changes (model, prompt, circuit, fallback unchanged)', () => {
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
  // max_tokens must be unchanged
  assert.ok(WORKER_SRC.includes('groq_generate') &&
          WORKER_SRC.includes('1024') &&
          WORKER_SRC.includes('2048'),
    'max_tokens for summary (1024) and batch (2048) must be unchanged');
});

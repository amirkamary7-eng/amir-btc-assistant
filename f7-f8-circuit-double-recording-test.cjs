/**
 * F7/F8 Circuit Double-Recording Regression Test
 * ================================================
 *
 * PROBLEM (F7): _groqRoutedFetch records per-key circuit results (inner layer).
 * Then attemptProvider ALSO records the result (outer layer). Transport failures
 * (HTTP non-200) get recorded TWICE — once per-key by inner, once as 'groq-key0'
 * by outer. This increments consecutive_failures 2x, tripping the circuit too fast.
 *
 * PROBLEM (F8): The outer layer always records with providerName='groq-key0',
 * even if the actual request used Key 1. This means groq-key0's circuit trips
 * faster than groq-key1's (asymmetric).
 *
 * FIX REQUIREMENTS:
 *   1. Transport failure (HTTP non-200, key_slot >= 0): only inner layer records
 *   2. Semantic failure (HTTP 200 + validation fail): outer layer records with REAL key_slot
 *   3. No key tried (key_slot === -1): outer layer does NOT record (don't attribute to wrong key)
 *   4. Success: outer layer records (idempotent, no harm)
 *   5. Chat path (assistant.js) UNCHANGED
 *
 * 8-SCENARIO MATRIX:
 *   1. Key0 -> 200 -> valid: inner records success(key0), outer records success(groq-key0) [OK]
 *   2. Key0 -> fail -> Key1 -> valid: inner records fail(key0)+success(key1), outer records success [OK]
 *   3. Key0 -> fail -> Key1 -> fail: inner records fail(key0)+fail(key1), outer SKIPS [FIX]
 *   4. Key0 -> 200 -> invalid JSON: inner records success(key0), outer records fail(real key_slot) [FIX]
 *   5. Key0 -> 200 -> Persian validation fail: inner records success(key0), outer records fail(real key_slot) [FIX]
 *   6. Key1 -> 200 -> valid: inner records success(key1), outer records success [OK]
 *   7. Key1 -> fail -> Key0 -> valid: inner records fail(key1)+success(key0), outer records success [OK]
 *   8. No key tried (both circuits OPEN): key_slot=-1, outer SKIPS [FIX]
 *
 * Run: node --test f7-f8-circuit-double-recording-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const assistantSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');

// ── Locate attemptProvider function body ──
const attemptProviderStart = workerSrc.indexOf('async function attemptProvider(');
assert.ok(attemptProviderStart !== -1, 'attemptProvider function must exist');
// Get ~800 chars of the function body (enough to cover the recordCircuitResult call)
const attemptProviderBody = workerSrc.substring(attemptProviderStart, attemptProviderStart + 4000);

// ── Locate _groqRoutedFetch function body ──
const routedFetchStart = workerSrc.indexOf('async function _groqRoutedFetch(');
assert.ok(routedFetchStart !== -1, '_groqRoutedFetch function must exist');
const routedFetchBody = workerSrc.substring(routedFetchStart, routedFetchStart + 1500);

// ════════════════════════════════════════════════════════════════════════════
// TEST 1: attemptProvider must check key_slot before recording (F7/F8 fix)
// ════════════════════════════════════════════════════════════════════════════
test('F7-001: attemptProvider must check r.key_slot before calling recordCircuitResult', () => {
  // The fix must check key_slot to distinguish:
  //   - Transport failure (key_slot >= 0, !success, !validation_failure) → SKIP (inner recorded)
  //   - No key tried (key_slot === -1) → SKIP (don't attribute to wrong key)
  //   - Semantic failure (validation_failure) → RECORD with real key_slot
  //   - Non-Groq provider (no key_slot) → RECORD normally
  const hasKeySlotCheck = attemptProviderBody.includes('key_slot');
  assert.ok(
    hasKeySlotCheck,
    'attemptProvider must check r.key_slot before recording circuit result. ' +
    'This is required to avoid double-recording transport failures (F7) and ' +
    'wrong-key attribution (F8).'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 2: Transport failure must NOT be double-recorded (F7 fix)
// ════════════════════════════════════════════════════════════════════════════
test('F7-002: attemptProvider must SKIP recordCircuitResult for transport failures (error starts with http_)', () => {
  // The fix must distinguish transport failures (HTTP non-200, error='http_XXX')
  // from semantic failures (invalid_json, empty_response, persian_validation_failed).
  // Transport failures are already recorded by _groqRoutedFetch inner layer.
  const hasTransportCheck = attemptProviderBody.includes("startsWith('http_')") ||
                           attemptProviderBody.includes('startsWith("http_")');
  assert.ok(
    hasTransportCheck,
    'attemptProvider must check if error starts with http_ to identify transport failures. ' +
    'Transport failures (HTTP non-200) are already recorded by _groqRoutedFetch inner layer.'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 3: No-key-tried (key_slot === -1) must NOT be recorded (F8 fix)
// ════════════════════════════════════════════════════════════════════════════
test('F8-003: attemptProvider must SKIP recordCircuitResult when key_slot === -1 (no key tried, circuits OPEN)', () => {
  // When both Groq circuits are OPEN, _groqRoutedFetch returns key_slot=-1 without fetching.
  // The outer layer must NOT record this as a failure of 'groq-key0' (wrong attribution).
  // Check that the code handles key_slot === -1 or key_slot < 0
  const hasNoKeyCheck = attemptProviderBody.includes('=== -1') ||
                        attemptProviderBody.includes('< 0') ||
                        attemptProviderBody.includes('>= 0');
  assert.ok(
    hasNoKeyCheck,
    'attemptProvider must handle key_slot === -1 (no key tried) by NOT recording ' +
    'circuit result against wrong key. Found body does not check for -1 or < 0.'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 4: Semantic failure must use REAL key_slot for attribution (F8 fix)
// ════════════════════════════════════════════════════════════════════════════
test('F8-004: attemptProvider must use real key_slot (groq-key${r.key_slot}) for attribution', () => {
  // For Groq calls, the outer layer should record against groq-key${r.key_slot}
  // (the ACTUAL key used), not always providerName (groq-key0).
  // This applies to both success and semantic failure recording.
  const hasRealKeyAttribution = attemptProviderBody.includes('groq-key${');
  assert.ok(
    hasRealKeyAttribution,
    'attemptProvider must use real key_slot for circuit attribution. ' +
    'Expected pattern: `groq-key${r.key_slot}`. ' +
    'Currently always uses providerName (groq-key0) which causes asymmetric circuit tripping.'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 5: _groqRoutedFetch must still record per-key results (inner layer unchanged)
// ════════════════════════════════════════════════════════════════════════════
test('F7-005: _groqRoutedFetch must still call recordCircuitResult per-key (inner layer)', () => {
  // The inner layer recording must be preserved — it records transport failures per-key.
  const innerRecordCount = (routedFetchBody.match(/recordCircuitResult/g) || []).length;
  assert.ok(
    innerRecordCount >= 2,
    `_groqRoutedFetch must call recordCircuitResult at least 2 times (per-key). Found ${innerRecordCount}.`
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 6: Chat path (assistant.js) must be UNCHANGED — no key_slot checks
// ════════════════════════════════════════════════════════════════════════════
test('F7-006: Chat path (assistant.js) must NOT have key_slot logic (Chat uses separate circuit keys)', () => {
  // Chat uses chat-groq / chat-groq-secondary circuit keys (separate from News AI).
  // Chat does NOT use _groqRoutedFetch or key_slot. The F7/F8 fix must NOT touch Chat.
  const chatHasKeySlot = assistantSrc.includes('key_slot');
  assert.ok(
    !chatHasKeySlot,
    'Chat path (assistant.js) must NOT reference key_slot. ' +
    'Chat uses separate circuit keys (chat-groq, chat-groq-secondary). ' +
    'The F7/F8 fix is News AI only.'
  );
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 7: attemptProvider must still record SUCCESS (idempotent, closes circuit)
// ════════════════════════════════════════════════════════════════════════════
test('F7-007: attemptProvider must still call recordCircuitResult on success (closes circuit)', () => {
  // Success recording is idempotent (sets state to CLOSED). Double-recording success is harmless.
  // The fix must NOT skip success recording.
  const hasSuccessRecording = attemptProviderBody.includes('recordCircuitResult');
  assert.ok(hasSuccessRecording, 'attemptProvider must still call recordCircuitResult (for success + semantic failures).');
});

// ════════════════════════════════════════════════════════════════════════════
// TEST 8: Non-Groq providers (Gemini, OpenRouter, etc.) must still be recorded normally
// ════════════════════════════════════════════════════════════════════════════
test('F7-008: attemptProvider must guard key_slot check (non-Groq providers have no key_slot)', () => {
  // Non-Groq providers (Gemini, OpenRouter, Workers AI, OpenAI) don't have key_slot.
  // The fix must guard the key_slot check (only apply when key_slot exists).
  // Check for: key_slot !== undefined, or typeof check, or !== null guard.
  const hasGuardedCheck = attemptProviderBody.includes('!== undefined') ||
                          attemptProviderBody.includes('!== null');
  assert.ok(
    hasGuardedCheck,
    'attemptProvider must guard the key_slot check (only apply when key_slot exists). ' +
    'Non-Groq providers (Gemini, OpenRouter, etc.) do not have key_slot and must still be recorded normally.'
  );
});

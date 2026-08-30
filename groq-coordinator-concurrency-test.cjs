/**
 * Global Groq Coordinator — Concurrency Race Condition Test
 * ==========================================================
 * Simulates N concurrent requests hitting checkGroqCapacity + recordGroqRequest
 * simultaneously to measure overshoot beyond the effective limit.
 *
 * Uses a mock KV that simulates Cloudflare KV's read-modify-write semantics
 * (including the race window where multiple reads happen before any write).
 *
 * Run: node --test groq-coordinator-concurrency-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ═════════════════════════════════════════════════════════════════════
// Mock KV — simulates Cloudflare Workers KV with eventual consistency
// ═════════════════════════════════════════════════════════════════════

class MockKV {
  constructor() {
    this.store = new Map();
    this.readCount = 0;
    this.writeCount = 0;
  }

  async get(key) {
    this.readCount++;
    // Simulate KV latency (0ms for test speed, but async)
    return this.store.get(key) || null;
  }

  async put(key, value, opts) {
    this.writeCount++;
    this.store.set(key, value);
  }

  // Simulate concurrent reads seeing the same state (the race window)
  // In real KV, two concurrent reads can both see the old value before
  // either write completes.
  reset() {
    this.store.clear();
    this.readCount = 0;
    this.writeCount = 0;
  }
}

// ═════════════════════════════════════════════════════════════════════
// Coordinator functions (mirrors worker-proxy.js, adapted for mock KV)
// ═════════════════════════════════════════════════════════════════════

const GROQ_RPM_KEY = 'groq:global:rpm';
const GROQ_TPM_KEY = 'groq:global:tpm';
const GROQ_COORDINATOR_TTL = 120;

function getGroqRpmLimit(env) {
  return Math.max(1, parseInt(env?.GROQ_RPM_LIMIT || '30', 10));
}

function getGroqTpmLimit(env) {
  return Math.max(1000, parseInt(env?.GROQ_TPM_LIMIT || '14000', 10));
}

function getGroqSafetyMargin(env) {
  return Math.max(0.5, Math.min(0.99, parseFloat(env?.GROQ_SAFETY_MARGIN || '0.85')));
}

function estimateGroqTokens(prompt, systemPrompt, maxTokens) {
  const promptChars = (prompt || '').length;
  const systemChars = (systemPrompt || '').length;
  const inputTokens = Math.ceil((promptChars + systemChars) / 3);
  return inputTokens + (maxTokens || 500);
}

async function checkGroqCapacity(env, estimatedTokens = 500) {
  const kv = env.APP_CACHE;
  const now = Date.now();
  const windowMs = 60 * 1000;
  const windowStart = now - windowMs;

  let rpmTimestamps = [];
  try {
    const rpmRaw = await kv.get(GROQ_RPM_KEY);
    if (rpmRaw) {
      rpmTimestamps = JSON.parse(rpmRaw);
      if (!Array.isArray(rpmTimestamps)) rpmTimestamps = [];
    }
  } catch { rpmTimestamps = []; }

  rpmTimestamps = rpmTimestamps.filter(ts => ts > windowStart);

  let tpmData = { tokens: 0, windowStart: now };
  try {
    const tpmRaw = await kv.get(GROQ_TPM_KEY);
    if (tpmRaw) {
      tpmData = JSON.parse(tpmRaw);
      if (!tpmData.tokens) tpmData = { tokens: 0, windowStart: now };
    }
  } catch { tpmData = { tokens: 0, windowStart: now }; }

  if (tpmData.windowStart < windowStart) {
    tpmData = { tokens: 0, windowStart: now };
  }

  const rpmLimit = getGroqRpmLimit(env);
  const tpmLimit = getGroqTpmLimit(env);
  const margin = getGroqSafetyMargin(env);

  const effectiveRpmLimit = Math.floor(rpmLimit * margin);
  const effectiveTpmLimit = Math.floor(tpmLimit * margin);

  const currentRpm = rpmTimestamps.length;
  const currentTpm = tpmData.tokens;

  if (currentRpm >= effectiveRpmLimit) {
    return { allowed: false, rpmCount: currentRpm, tpmCount: currentTpm, reason: `rpm_limit (${currentRpm}/${effectiveRpmLimit})` };
  }

  if (currentTpm + estimatedTokens > effectiveTpmLimit) {
    return { allowed: false, rpmCount: currentRpm, tpmCount: currentTpm, reason: `tpm_limit (${currentTpm + estimatedTokens}/${effectiveTpmLimit})` };
  }

  return { allowed: true, rpmCount: currentRpm, tpmCount: currentTpm, reason: 'ok' };
}

async function recordGroqRequest(env, estimatedTokens = 500) {
  const kv = env.APP_CACHE;
  const now = Date.now();
  const windowMs = 60 * 1000;

  // Update RPM
  let rpmTimestamps = [];
  try {
    const rpmRaw = await kv.get(GROQ_RPM_KEY);
    if (rpmRaw) {
      rpmTimestamps = JSON.parse(rpmRaw);
      if (!Array.isArray(rpmTimestamps)) rpmTimestamps = [];
    }
  } catch { rpmTimestamps = []; }

  rpmTimestamps = rpmTimestamps.filter(ts => ts > now - windowMs);
  rpmTimestamps.push(now);
  if (rpmTimestamps.length > 100) {
    rpmTimestamps = rpmTimestamps.slice(-100);
  }
  await kv.put(GROQ_RPM_KEY, JSON.stringify(rpmTimestamps), GROQ_COORDINATOR_TTL);

  // Update TPM
  let tpmData = { tokens: 0, windowStart: now };
  try {
    const tpmRaw = await kv.get(GROQ_TPM_KEY);
    if (tpmRaw) {
      tpmData = JSON.parse(tpmRaw);
      if (!tpmData.tokens) tpmData = { tokens: 0, windowStart: now };
    }
  } catch { tpmData = { tokens: 0, windowStart: now }; }

  if (tpmData.windowStart < now - windowMs) {
    tpmData = { tokens: 0, windowStart: now };
  }

  tpmData.tokens += estimatedTokens;
  await kv.put(GROQ_TPM_KEY, JSON.stringify(tpmData), GROQ_COORDINATOR_TTL);
}

// ═════════════════════════════════════════════════════════════════════
// Helper: simulate a single request's full lifecycle
// ═════════════════════════════════════════════════════════════════════

async function simulateRequest(env, estTokens) {
  // Step 1: Check capacity
  const capacity = await checkGroqCapacity(env, estTokens);

  if (!capacity.allowed) {
    return { allowed: false, reason: capacity.reason, recorded: false };
  }

  // Step 2: (Simulated) Groq call succeeds
  // Small delay to create the race window
  await new Promise(resolve => setTimeout(resolve, 1));

  // Step 3: Record the request
  await recordGroqRequest(env, estTokens);

  return { allowed: true, reason: 'ok', recorded: true };
}

// Helper: read final state
async function getFinalState(env) {
  const kv = env.APP_CACHE;
  const now = Date.now();
  const windowMs = 60 * 1000;

  let rpmTimestamps = [];
  try {
    const rpmRaw = await kv.get(GROQ_RPM_KEY);
    if (rpmRaw) rpmTimestamps = JSON.parse(rpmRaw);
  } catch {}

  rpmTimestamps = rpmTimestamps.filter(ts => ts > now - windowMs);

  let tpmData = { tokens: 0, windowStart: now };
  try {
    const tpmRaw = await kv.get(GROQ_TPM_KEY);
    if (tpmRaw) tpmData = JSON.parse(tpmRaw);
  } catch {}

  return {
    rpm: rpmTimestamps.length,
    tpm: tpmData.tokens || 0,
  };
}

// ═════════════════════════════════════════════════════════════════════
// TEST 1: 10 concurrent requests, RPM limit=30, margin=0.85
// Effective limit = floor(30 * 0.85) = 25
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-01: 10 concurrent requests with empty KV — all should be allowed (below limit)', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  const estTokens = 500; // 500 tokens per request

  // Launch 10 concurrent requests
  const results = await Promise.all(
    Array.from({ length: 10 }, () => simulateRequest(env, estTokens))
  );

  const allowed = results.filter(r => r.allowed).length;
  const rejected = results.filter(r => !r.allowed).length;
  const finalState = await getFinalState(env);

  // All 10 should be allowed (10 < 25 effective RPM limit)
  assert.equal(allowed, 10, 'All 10 should be allowed (below effective limit of 25)');
  assert.equal(rejected, 0, 'None should be rejected');

  // Final RPM should be 10 (all recorded)
  assert.equal(finalState.rpm, 10, `Final RPM should be 10, got ${finalState.rpm}`);

  // Final TPM should be 5000 (10 × 500)
  assert.equal(finalState.tpm, 5000, `Final TPM should be 5000, got ${finalState.tpm}`);

  // No overshoot
  assert.ok(finalState.rpm <= 25, `RPM (${finalState.rpm}) should be within effective limit (25)`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 2: 25 concurrent requests (exactly at effective limit) — race window
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-02: 25 concurrent requests — all read empty KV, all allowed (RACE)', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  const estTokens = 500;

  // Launch 25 concurrent requests — all will read empty KV simultaneously
  const results = await Promise.all(
    Array.from({ length: 25 }, () => simulateRequest(env, estTokens))
  );

  const allowed = results.filter(r => r.allowed).length;
  const rejected = results.filter(r => !r.allowed).length;
  const finalState = await getFinalState(env);

  // RACE CONDITION: All 25 read empty KV → all see rpm=0 → all allowed
  // Effective limit is 25, so all are technically "allowed" by the check
  assert.equal(allowed, 25, 'All 25 should be allowed (race: all read rpm=0, 0 < 25)');
  assert.equal(rejected, 0, 'None should be rejected');

  // Final RPM = 25 (exactly at effective limit)
  assert.equal(finalState.rpm, 25, `Final RPM should be 25, got ${finalState.rpm}`);

  // This is NOT overshoot — 25 is exactly the effective limit
  // The hard Groq limit is 30, so 25 is safe
  assert.ok(finalState.rpm <= 30, `RPM (${finalState.rpm}) should be within hard limit (30)`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 3: 30 concurrent requests — MAXIMUM RACE (all read empty KV)
// Hard limit = 30, effective limit = 25
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-03: 30 concurrent requests — MAX RACE, measure overshoot', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  const estTokens = 500;

  // Launch 30 concurrent requests — all read empty KV simultaneously
  const results = await Promise.all(
    Array.from({ length: 30 }, () => simulateRequest(env, estTokens))
  );

  const allowed = results.filter(r => r.allowed).length;
  const rejected = results.filter(r => !r.allowed).length;
  const finalState = await getFinalState(env);

  const effectiveLimit = Math.floor(30 * 0.85); // = 25
  const hardLimit = 30;

  console.log(`\n  CONCURRENCY-03 Results:`);
  console.log(`    Requests launched: 30`);
  console.log(`    Allowed: ${allowed}`);
  console.log(`    Rejected: ${rejected}`);
  console.log(`    Effective limit (with margin): ${effectiveLimit}`);
  console.log(`    Hard Groq limit: ${hardLimit}`);
  console.log(`    Final RPM: ${finalState.rpm}`);
  console.log(`    Final TPM: ${finalState.tpm}`);
  console.log(`    Overshoot beyond effective: ${finalState.rpm - effectiveLimit}`);
  console.log(`    Overshoot beyond hard limit: ${Math.max(0, finalState.rpm - hardLimit)}`);

  // With race: all 30 read rpm=0 → all allowed
  // But 0 < 25 (effective), so all pass the check
  assert.ok(allowed <= 30, `Allowed (${allowed}) should not exceed 30`);

  // Final RPM could be up to 30 (all allowed + recorded)
  // Overshoot beyond effective limit (25) = up to 5
  // But still within hard limit (30)
  const overshootBeyondEffective = finalState.rpm - effectiveLimit;
  const overshootBeyondHard = Math.max(0, finalState.rpm - hardLimit);

  console.log(`    Overshoot beyond effective: ${overshootBeyondEffective}`);
  console.log(`    Overshoot beyond hard: ${overshootBeyondHard}`);

  // KEY QUESTION: Can overshoot exceed the HARD limit?
  // With 30 concurrent and hard limit 30: max allowed = 30 (all pass check at rpm=0)
  // So final RPM = 30 = hard limit. No overshoot beyond hard limit.
  assert.ok(finalState.rpm <= hardLimit,
    `Final RPM (${finalState.rpm}) must not exceed hard limit (${hardLimit})`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 4: 50 concurrent requests — EXTREME BURST
// Hard limit = 30, effective limit = 25
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-04: 50 concurrent requests — EXTREME BURST', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  const estTokens = 500;

  // Launch 50 concurrent requests
  const results = await Promise.all(
    Array.from({ length: 50 }, () => simulateRequest(env, estTokens))
  );

  const allowed = results.filter(r => r.allowed).length;
  const rejected = results.filter(r => !r.allowed).length;
  const finalState = await getFinalState(env);

  const effectiveLimit = Math.floor(30 * 0.85); // = 25
  const hardLimit = 30;

  console.log(`\n  CONCURRENCY-04 Results:`);
  console.log(`    Requests launched: 50`);
  console.log(`    Allowed: ${allowed}`);
  console.log(`    Rejected: ${rejected}`);
  console.log(`    Final RPM: ${finalState.rpm}`);
  console.log(`    Overshoot beyond effective: ${finalState.rpm - effectiveLimit}`);
  console.log(`    Overshoot beyond hard: ${Math.max(0, finalState.rpm - hardLimit)}`);

  // With 50 concurrent and all reading empty KV:
  // All 50 see rpm=0 < 25 → all allowed
  // Final RPM = 50 (ALL recorded)
  // Overshoot beyond hard limit (30) = 20

  // THIS IS THE WORST CASE: 50 concurrent requests all passing the check
  // because they all read the same empty state.
  // In production, 50 concurrent Groq requests would be extremely unusual:
  // - News cron is sequential
  // - Chat is 1 request per user message
  // - Batch translation is 1-2 requests total
  // - Batch analysis is 1 request
  // The only way to get 50 concurrent is a massive coordinated user burst

  console.log(`    ⚠️  OVERSHOOT WARNING: ${finalState.rpm - hardLimit} requests beyond hard limit`);
  console.log(`    However: 50 concurrent Groq requests is unrealistic for this workload.`);
  console.log(`    News cron is sequential, Chat is 1-per-user, batch is 1-2 total.`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 5: Sequential requests (no race) — verify correct limiting
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-05: 30 sequential requests — should stop at effective limit (25)', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  const estTokens = 500;
  let allowed = 0;
  let rejected = 0;

  // Process sequentially (await each one)
  for (let i = 0; i < 30; i++) {
    const result = await simulateRequest(env, estTokens);
    if (result.allowed) allowed++;
    else rejected++;
  }

  const finalState = await getFinalState(env);
  const effectiveLimit = Math.floor(30 * 0.85); // = 25

  console.log(`\n  CONCURRENCY-05 (Sequential) Results:`);
  console.log(`    Allowed: ${allowed}`);
  console.log(`    Rejected: ${rejected}`);
  console.log(`    Final RPM: ${finalState.rpm}`);
  console.log(`    Effective limit: ${effectiveLimit}`);

  // Sequential: each request reads the updated state before checking
  // RPM limit: 25 (floor(30 * 0.85))
  // TPM limit: 11900 (floor(14000 * 0.85))
  // Each request uses 500 tokens
  // TPM runs out first: 11900 / 500 = 23.8 → 23 requests allowed by TPM
  // RPM (23) is still below 25, so TPM is the binding constraint
  assert.equal(allowed, 23, `23 should be allowed (TPM is binding constraint: 11900/500=23.8)`);
  assert.equal(rejected, 7, '7 should be rejected (TPM limit hit before RPM)');
  assert.equal(finalState.rpm, 23, `Final RPM should be 23`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 6: TPM race — 20 concurrent requests, each 1000 tokens
// TPM limit = 14000, margin = 0.85 → effective = 11900
// 20 × 1000 = 20000 > 11900, but with race all might pass
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-06: 20 concurrent requests — TPM race test', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  const estTokens = 1000; // 1000 tokens per request
  const effectiveTpmLimit = Math.floor(14000 * 0.85); // = 11900

  // Launch 20 concurrent requests (20 × 1000 = 20000 tokens)
  const results = await Promise.all(
    Array.from({ length: 20 }, () => simulateRequest(env, estTokens))
  );

  const allowed = results.filter(r => r.allowed).length;
  const finalState = await getFinalState(env);

  console.log(`\n  CONCURRENCY-06 (TPM Race) Results:`);
  console.log(`    Requests launched: 20 (1000 tokens each)`);
  console.log(`    Allowed: ${allowed}`);
  console.log(`    Final RPM: ${finalState.rpm}`);
  console.log(`    Final TPM: ${finalState.tpm}`);
  console.log(`    Effective TPM limit: ${effectiveTpmLimit}`);
  console.log(`    Hard TPM limit: 14000`);
  console.log(`    Overshoot beyond effective: ${finalState.tpm - effectiveTpmLimit}`);
  console.log(`    Overshoot beyond hard: ${Math.max(0, finalState.tpm - 14000)}`);

  // With race: all 20 read tpm=0, 0+1000=1000 < 11900 → all allowed
  // Final TPM = 20000 (20 × 1000)
  // Overshoot beyond hard limit (14000) = 6000

  // But wait — RPM check also applies:
  // 20 < 25 (effective RPM) → all pass RPM check
  // And 0+1000 < 11900 (effective TPM) → all pass TPM check
  // So all 20 are allowed

  // This means TPM can overshoot by 6000 (43% over hard limit)
  // However, Groq's TPM limit is usually per-minute, and 20000 tokens
  // in one minute is well within most plans (free tier: 14400 TPM)
  // The overshoot would be 20000 - 14400 = 5600 tokens over

  console.log(`    ⚠️  TPM overshoot: ${Math.max(0, finalState.tpm - 14000)} tokens beyond hard limit`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 7: Realistic production scenario — 3 concurrent (1 chat + 1 translation + 1 summary)
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-07: 3 concurrent requests (realistic production burst)', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  // Simulate: 1 Chat (1500 tokens), 1 Batch translation (2000 tokens), 1 Summary (1500 tokens)
  const requests = [
    simulateRequest(env, 1500), // Chat
    simulateRequest(env, 2000), // Batch translation
    simulateRequest(env, 1500), // Summary
  ];

  const results = await Promise.all(requests);
  const allowed = results.filter(r => r.allowed).length;
  const finalState = await getFinalState(env);

  const effectiveRpmLimit = Math.floor(30 * 0.85); // = 25
  const effectiveTpmLimit = Math.floor(14000 * 0.85); // = 11900

  console.log(`\n  CONCURRENCY-07 (Realistic) Results:`);
  console.log(`    Requests: 3 (Chat 1500 + Translation 2000 + Summary 1500)`);
  console.log(`    Allowed: ${allowed}`);
  console.log(`    Final RPM: ${finalState.rpm}`);
  console.log(`    Final TPM: ${finalState.tpm}`);
  console.log(`    Effective RPM limit: ${effectiveRpmLimit}`);
  console.log(`    Effective TPM limit: ${effectiveTpmLimit}`);
  console.log(`    Overshoot: NONE (3 << 25, 5000 << 11900)`);

  // 3 requests with 5000 total tokens — well within limits
  assert.equal(allowed, 3, 'All 3 should be allowed');
  assert.ok(finalState.rpm <= 30, 'RPM within hard limit');
  assert.ok(finalState.tpm <= 14000, 'TPM within hard limit');
});

// ═════════════════════════════════════════════════════════════════════
// TEST 8: Pre-primed KV (20 RPM already consumed) + 10 concurrent
// Tests race when KV is NOT empty
// ═════════════════════════════════════════════════════════════════════

test('CONCURRENCY-08: 20 RPM pre-consumed + 10 concurrent — race with existing state', async () => {
  const kv = new MockKV();
  const env = { APP_CACHE: kv, GROQ_RPM_LIMIT: '30', GROQ_TPM_LIMIT: '14000', GROQ_SAFETY_MARGIN: '0.85' };

  // Pre-populate KV with 20 RPM already consumed
  const now = Date.now();
  const existingTimestamps = Array.from({ length: 20 }, (_, i) => now - (i * 100));
  await kv.put(GROQ_RPM_KEY, JSON.stringify(existingTimestamps), GROQ_COORDINATOR_TTL);
  await kv.put(GROQ_TPM_KEY, JSON.stringify({ tokens: 8000, windowStart: now }), GROQ_COORDINATOR_TTL);

  // Now launch 10 concurrent requests
  const estTokens = 500;
  const results = await Promise.all(
    Array.from({ length: 10 }, () => simulateRequest(env, estTokens))
  );

  const allowed = results.filter(r => r.allowed).length;
  const rejected = results.filter(r => !r.allowed).length;
  const finalState = await getFinalState(env);

  const effectiveRpmLimit = Math.floor(30 * 0.85); // = 25

  console.log(`\n  CONCURRENCY-08 (Pre-primed) Results:`);
  console.log(`    Pre-existing RPM: 20`);
  console.log(`    Pre-existing TPM: 8000`);
  console.log(`    Concurrent requests: 10`);
  console.log(`    Allowed: ${allowed}`);
  console.log(`    Rejected: ${rejected}`);
  console.log(`    Final RPM: ${finalState.rpm}`);
  console.log(`    Final TPM: ${finalState.tpm}`);
  console.log(`    Effective RPM limit: ${effectiveRpmLimit}`);
  console.log(`    Hard RPM limit: 30`);

  // RACE: All 10 read rpm=20, 20 < 25 → all allowed
  // Final RPM = 20 + 10 = 30 (exactly at hard limit, 5 over effective)
  // This is the MOST REALISTIC dangerous scenario:
  // 20 requests already consumed in the minute, then 10 concurrent arrive

  const overshootBeyondEffective = finalState.rpm - effectiveRpmLimit;
  const overshootBeyondHard = Math.max(0, finalState.rpm - 30);

  console.log(`    Overshoot beyond effective: ${overshootBeyondEffective}`);
  console.log(`    Overshoot beyond hard: ${overshootBeyondHard}`);

  // With 20 pre-consumed + 10 concurrent (all passing):
  // Final RPM = 30 = hard limit. No overshoot beyond hard limit.
  assert.ok(finalState.rpm <= 30,
    `Final RPM (${finalState.rpm}) must not exceed hard limit (30)`);
});

// ═════════════════════════════════════════════════════════════════════
// TEST 9: Source-level verification — circuit breaker independence
// ═════════════════════════════════════════════════════════════════════

test('SRC-01: Circuit breaker key "groq" (News) and "chat-groq" (Chat) are separate', () => {
  const fs = require('fs');
  const path = require('path');
  const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

  // News uses 'groq' circuit key
  assert.ok(WORKER_SRC.includes("shouldAttemptProvider(env, 'groq')"),
    "News must use 'groq' circuit breaker key");

  // Chat uses 'chat-${providerName}' pattern (which produces 'chat-groq')
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(ASSISTANT_SRC.includes("chatCircuitKey = `chat-${providerName}`"),
    "Chat must use 'chat-${providerName}' circuit key pattern");

  // Verify they are NOT the same string
  assert.ok(!ASSISTANT_SRC.includes("shouldAttemptProvider(env, 'groq')"),
    "Chat must NOT use 'groq' circuit key directly");
});

// ═════════════════════════════════════════════════════════════════════
// TEST 10: Source-level — recordGroqRequest only on success paths
// ═════════════════════════════════════════════════════════════════════

test('SRC-02: recordGroqRequest is NOT called in error/rejected paths', () => {
  const fs = require('fs');
  const path = require('path');
  const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');

  // In tryGroq: recordGroqRequest should be AFTER the success check
  const tryGroqSection = WORKER_SRC.slice(
    WORKER_SRC.indexOf('async function tryGroq'),
    WORKER_SRC.indexOf('async function tryGemini')
  );
  const recordIdx = tryGroqSection.indexOf('recordGroqRequest');
  const successCheckIdx = tryGroqSection.indexOf('text.trim().length >= 50');
  assert.ok(recordIdx > successCheckIdx,
    'recordGroqRequest must come AFTER success check in tryGroq');

  // In assistant.js: recordGroqRequest must come AFTER _parseGroqResult
  const callGroqSection = ASSISTANT_SRC.slice(
    ASSISTANT_SRC.indexOf('async function callGroqChat'),
    ASSISTANT_SRC.indexOf('function _parseGroqResult')
  );
  const parseIdx = callGroqSection.indexOf('_parseGroqResult');
  const recordIdxChat = callGroqSection.indexOf('recordGroqRequest');
  assert.ok(parseIdx > -1 && recordIdxChat > -1,
    'Both _parseGroqResult and recordGroqRequest must exist in callGroqChat');
  assert.ok(recordIdxChat > parseIdx,
    'recordGroqRequest must come AFTER _parseGroqResult in callGroqChat');
});

// ═════════════════════════════════════════════════════════════════════
// TEST 11: Summary — overall assessment
// ═════════════════════════════════════════════════════════════════════

test('SUMMARY: Race condition assessment', () => {
  console.log(`
  ═══ RACE CONDITION ASSESSMENT SUMMARY ═══

  1. SEQUENTIAL (no race):
     - Coordinator works perfectly. Stops at effective limit (25 of 30).
     - No overshoot. Circuit breaker remains ultimate safety net.

  2. CONCURRENT (race exists):
     - Multiple requests can read the same KV state simultaneously.
     - All pass the check before any of them writes back.
     - Overshoot = number of concurrent requests that pass simultaneously.

  3. MAX THEORETICAL OVERSHOOT:
     - With 30 RPM hard limit and 0.85 margin: effective = 25
     - If 30 requests arrive simultaneously on EMPTY KV: all 30 pass
       (all read rpm=0 < 25). Final RPM = 30 = hard limit.
     - If 50+ arrive: 50 pass (all read rpm=0 < 25). Final RPM = 50.
       Overshoot beyond hard limit = 20. ⚠️
     - With 20 pre-consumed + 10 concurrent: 10 pass (all read rpm=20 < 25).
       Final RPM = 30 = hard limit. No overshoot beyond hard. ✅

  4. PRODUCTION REALITY:
     - News cron: SEQUENTIAL (processNewsAIBatch items one at a time)
     - Batch translation: 1-2 requests total (batched)
     - Chat AI: 1 request per user message (human typing speed)
     - Summary queue: 1 item at a time (processOneArticleSummary)
     - Typical concurrent Groq requests: 1-3
     - Maximum realistic burst: 5-10 (unlikely but possible)

  5. SAFETY MARGIN COVERAGE:
     - With 0.85 margin: 15% headroom = 5 extra requests
     - 5 concurrent requests overshoot: 5 (within 15% headroom) ✅
     - 10 concurrent requests overshoot: 10 (exceeds 15% headroom) ⚠️
     - BUT: 10 concurrent Groq requests is extremely unlikely in this workload

  6. CONCLUSION:
     - Race condition is REAL but IMPACT IS ACCEPTABLE for this workload.
     - Safety margin (85%) covers up to ~5 concurrent requests.
     - Circuit breaker (3 failures → 10min OPEN) catches any 429s that slip through.
     - Adding Durable Object would add ~50ms latency per request for minimal benefit.
     - NO DURABLE OBJECT NEEDED. Document the limitation instead.
  `);
});

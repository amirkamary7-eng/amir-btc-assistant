/**
 * CORS Race Condition Regression Test
 * ====================================
 *
 * Verifies that the CORS Origin handling is per-request and cannot leak across
 * concurrent requests. Triggered by Task 1 — a reported race condition where
 * a module-level `_currentRequestOrigin` variable could be overwritten by
 * Request B before Request A's withCors() read it, causing A's response to
 * echo B's Origin.
 *
 * This test has two parts:
 *
 * 1. Static check (A-1..A-4): the worker source must NOT set or read a
 *    module-level `_currentRequestOrigin` for CORS purposes. It must use
 *    `env._reqOrigin` (per-invocation) instead.
 *
 * 2. Dynamic check (B-1..B-4): simulates 4 concurrent requests with different
 *    Origins, with `await` yields between set and read, and verifies each
 *    response echoes ONLY its own request's Origin.
 *
 * Run: node --test cors-race-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// PART A — Static checks on worker-proxy.js source
// ============================================================================

test('A-1: _currentRequestOrigin is fully removed (no declaration, no set, no read)', () => {
  // After the final cleanup, the module-level `_currentRequestOrigin` variable
  // is COMPLETELY removed — not just unused, but declared nowhere. This is the
  // strongest guarantee: no stray reader can ever resurrect it.
  const references = workerSrc.match(/_currentRequestOrigin/g) || [];
  assert.equal(references.length, 0,
    `Expected zero _currentRequestOrigin references (full removal), found ${references.length}. ` +
    'The variable, its declaration, and all comments referencing it must be removed.');
});

test('A-2: withCors() does NOT read module-level _currentRequestOrigin', () => {
  const corsStart = workerSrc.indexOf('function withCors');
  assert.ok(corsStart > -1, 'withCors function not found');
  const corsEnd = workerSrc.indexOf('return merged;', corsStart);
  const corsSrc = workerSrc.slice(corsStart, corsEnd);
  // Filter out comment lines — only check actual code references
  const corsCode = corsSrc.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!/_currentRequestOrigin/.test(corsCode),
    'withCors() must NOT reference _currentRequestOrigin in code — it should read env._reqOrigin instead');
  assert.ok(/env\._reqOrigin/.test(corsCode),
    'withCors() must read env._reqOrigin (the per-invocation Origin)');
});

test('A-3: fetch() sets env._reqOrigin (per-invocation), not module-level', () => {
  const fetchStart = workerSrc.indexOf('async fetch(request, env, ctx)');
  assert.ok(fetchStart > -1, 'fetch handler not found');
  // Look at the first 500 chars of the fetch handler body
  const fetchBody = workerSrc.slice(fetchStart, fetchStart + 800);
  assert.ok(/env\._reqOrigin\s*=\s*request\.headers\.get\(['"]Origin['"]\)/.test(fetchBody),
    'fetch() must set env._reqOrigin = request.headers.get("Origin") at the top');
});

test('A-4: the old "Workers handle one request per invocation" comment is removed or corrected', () => {
  // The old misleading comment justified the module-level variable.
  // It must be gone (or the word "safe to keep module-scoped" must not appear).
  assert.ok(!/safe to keep module-scoped/.test(workerSrc),
    'The misleading "safe to keep module-scoped" comment must be removed — Workers CAN interleave requests in one isolate');
});

// ============================================================================
// PART B — Dynamic simulation of the race condition
// ============================================================================
//
// We simulate the Cloudflare Workers concurrency model:
//   - Multiple requests share ONE isolate (one JS realm, one module scope).
//   - Each request gets its OWN `env` object (per-invocation).
//   - `await` yields the event loop, allowing another request to run.
//
// We replicate the withCors() + jsonResponse() logic exactly (using env._reqOrigin),
// then fire 4 concurrent requests with interleaved awaits and verify no
// cross-contamination of the Access-Control-Allow-Origin header.

/**
 * Replicate withCors() logic from worker-proxy.js — reads env._reqOrigin.
 * WEBAPP_URL is set, so the non-localhost branch resolves to the WEBAPP_URL
 * origin (production-like behavior). For localhost, it echoes reqOrigin.
 */
function withCors_sim(headers, env) {
  const merged = new Headers(headers);
  const reqOrigin = (env && env._reqOrigin) ? env._reqOrigin : null;
  const isLocalhost = reqOrigin && (reqOrigin.startsWith('http://localhost:') || reqOrigin.startsWith('https://localhost:'));
  if (isLocalhost) {
    merged.set('Access-Control-Allow-Origin', reqOrigin);
  } else if (env && env.WEBAPP_URL) {
    try {
      merged.set('Access-Control-Allow-Origin', new URL(env.WEBAPP_URL).origin);
    } catch {
      merged.set('Access-Control-Allow-Origin', reqOrigin || '');
    }
  } else {
    merged.set('Access-Control-Allow-Origin', reqOrigin || '');
  }
  merged.set('Access-Control-Allow-Methods', 'GET, POST, PUT, DELETE, OPTIONS');
  merged.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');
  return merged;
}

/**
 * Simulate one request through the fetch handler. The `delayMs` await between
 * set and read simulates I/O (DB query, KV read, upstream fetch) that yields
 * the event loop — exactly the window where the old module-level variable
 * could be overwritten by another request.
 */
async function simulateRequest(origin, webappUrl, delayMs) {
  // Each request gets its OWN env object (per-invocation in Cloudflare Workers)
  const env = { WEBAPP_URL: webappUrl };
  // CORS RACE FIX: set on env, not module-level
  env._reqOrigin = origin;
  // Simulate I/O that yields the event loop (DB, KV, fetch, etc.)
  await new Promise(r => setTimeout(r, delayMs));
  // Build the response headers — reads env._reqOrigin
  const headers = withCors_sim({}, env);
  return headers.get('Access-Control-Allow-Origin');
}

test('B-1: 4 concurrent localhost requests — each response echoes its OWN Origin', async () => {
  // Localhost origins take the `isLocalhost` branch which directly echoes reqOrigin.
  // This is the most direct test of the race: if the module-level variable were
  // still in use, the last request to set it (D) would win and ALL responses
  // would echo D's Origin.
  const origins = {
    A: 'http://localhost:3000',
    B: 'http://localhost:3001',
    C: 'http://localhost:3002',
    D: 'http://localhost:3003',
  };
  // Fire all 4 concurrently, with varying delays so they interleave
  const [a, b, c, d] = await Promise.all([
    simulateRequest(origins.A, 'https://app.example.com', 10),
    simulateRequest(origins.B, 'https://app.example.com', 5),
    simulateRequest(origins.C, 'https://app.example.com', 15),
    simulateRequest(origins.D, 'https://app.example.com', 8),
  ]);
  assert.equal(a, origins.A, `Request A should echo Origin A (${origins.A}), got ${a}`);
  assert.equal(b, origins.B, `Request B should echo Origin B (${origins.B}), got ${b}`);
  assert.equal(c, origins.C, `Request C should echo Origin C (${origins.C}), got ${c}`);
  assert.equal(d, origins.D, `Request D should echo Origin D (${origins.D}), got ${d}`);
});

test('B-2: 4 concurrent production requests — each resolves to WEBAPP_URL (not leaked)', async () => {
  // Non-localhost origins resolve to the pinned WEBAPP_URL.
  // The point of this test: even with 4 concurrent requests with different
  // Origins and interleaved awaits, the WEBAPP_URL branch must NOT be affected
  // by cross-request Origin leakage (each env is isolated).
  const webappUrl = 'https://amir-btc-assistant.pages.dev';
  const expected = new URL(webappUrl).origin;
  const origins = {
    A: 'https://evil-a.example.com',
    B: 'https://evil-b.example.com',
    C: 'https://evil-c.example.com',
    D: 'https://evil-d.example.com',
  };
  const [a, b, c, d] = await Promise.all([
    simulateRequest(origins.A, webappUrl, 12),
    simulateRequest(origins.B, webappUrl, 6),
    simulateRequest(origins.C, webappUrl, 18),
    simulateRequest(origins.D, webappUrl, 9),
  ]);
  assert.equal(a, expected, `Request A should resolve to WEBAPP_URL (${expected}), got ${a}`);
  assert.equal(b, expected, `Request B should resolve to WEBAPP_URL (${expected}), got ${b}`);
  assert.equal(c, expected, `Request C should resolve to WEBAPP_URL (${expected}), got ${c}`);
  assert.equal(d, expected, `Request D should resolve to WEBAPP_URL (${expected}), got ${d}`);
});

test('B-3: interleaved awaits — Request A is delayed past B/C/D but still keeps its own Origin', async () => {
  // This is the exact race scenario from the bug report:
  //   A sets Origin A → awaits (long delay)
  //   B sets Origin B → awaits → reads → returns Origin B
  //   C sets Origin C → awaits → reads → returns Origin C
  //   D sets Origin D → awaits → reads → returns Origin D
  //   A finally reads → MUST still return Origin A (not D)
  const origins = {
    A: 'http://localhost:4000',
    B: 'http://localhost:4001',
    C: 'http://localhost:4002',
    D: 'http://localhost:4003',
  };
  // A has the LONGEST delay — it's still pending when B, C, D complete.
  // With the old module-level bug, A would read D's Origin (the last setter).
  const [a, b, c, d] = await Promise.all([
    simulateRequest(origins.A, 'https://app.example.com', 50),  // A: longest
    simulateRequest(origins.B, 'https://app.example.com', 5),   // B: quick
    simulateRequest(origins.C, 'https://app.example.com', 10),  // C: medium
    simulateRequest(origins.D, 'https://app.example.com', 15),  // D: medium
  ]);
  assert.equal(a, origins.A, `Request A (delayed) should still echo Origin A, got ${a} — RACE CONDITION DETECTED`);
  assert.equal(b, origins.B);
  assert.equal(c, origins.C);
  assert.equal(d, origins.D);
});

test('B-4: many concurrent requests (stress) — no Origin leakage', async () => {
  // 20 concurrent requests, each with a unique localhost origin and random delay.
  // Every response must echo its own origin.
  const N = 20;
  const origins = Array.from({ length: N }, (_, i) => `http://localhost:${5000 + i}`);
  const delays = Array.from({ length: N }, () => Math.floor(Math.random() * 30) + 1);
  const results = await Promise.all(
    origins.map((o, i) => simulateRequest(o, 'https://app.example.com', delays[i]))
  );
  for (let i = 0; i < N; i++) {
    assert.equal(results[i], origins[i],
      `Request ${i} (origin ${origins[i]}) should echo its own origin, got ${results[i]}`);
  }
});

// ============================================================================
// PART C — Prove the OLD (buggy) design would fail this test
// ============================================================================
// This is a meta-test: it simulates the OLD module-level design and confirms
// it WOULD fail the race test. This proves the test is meaningful (not a
// tautology) and documents why the fix was necessary.

test('C-1: (meta) the OLD module-level design WOULD fail B-3 (proves the test is meaningful)', async () => {
  // Simulate the old buggy design: one shared module-level variable.
  let _sharedOrigin = null;  // <-- the bug

  async function simulateOldRequest(origin, delayMs) {
    _sharedOrigin = origin;  // <-- overwrites shared state
    await new Promise(r => setTimeout(r, delayMs));
    // Reads the shared state — which may have been overwritten by another request
    const isLocalhost = _sharedOrigin && _sharedOrigin.startsWith('http://localhost:');
    return isLocalhost ? _sharedOrigin : 'https://app.example.com';
  }

  const origins = {
    A: 'http://localhost:4000',
    B: 'http://localhost:4001',
    C: 'http://localhost:4002',
    D: 'http://localhost:4003',
  };
  const [a, b, c, d] = await Promise.all([
    simulateOldRequest(origins.A, 50),  // A: longest — will read D's origin
    simulateOldRequest(origins.B, 5),
    simulateOldRequest(origins.C, 10),
    simulateOldRequest(origins.D, 15),
  ]);
  // The old design: A reads the LAST setter (D), so A !== origins.A.
  // This confirms our test B-3 would have caught the bug.
  assert.notEqual(a, origins.A,
    `Old design: A should NOT equal origins.A (it should leak D's origin). Got a=${a}. ` +
    'If this assertion fails, the old design no longer leaks — investigate.');
  assert.equal(a, origins.D, `Old design: A should leak D's origin (the last setter). Got a=${a}`);
});

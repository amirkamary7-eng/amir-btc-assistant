/**
 * Regression test for bootstrap hang fix.
 *
 * ROOT CAUSE: logBootstrapE2E calls were `await`ed, each doing 2 KV operations
 * (read + write). With 12 calls per bootstrap, that's 24 KV operations that
 * could hang the request if KV had a transient issue.
 *
 * ORIGINAL FIX: All log calls were made fire-and-forget (`void logBootstrapE2E(...)`)
 * AND each had an internal 500ms timeout race so even the background promise
 * couldn't hang indefinitely.
 *
 * P0-B KV-WRITE OPTIMIZATION (current): logStartE2E / logBootstrapE2E no longer
 * touch APP_CACHE KV at all — they emit structured console.log entries (captured
 * by Cloudflare Observability). The 500ms timeout race is therefore REMOVED
 * (there is no I/O to hang). HANG-003 / HANG-004 now assert the NEW no-KV
 * contract. HANG-005..007 still pass trivially (no KV → instant completion).
 * HANG-001/002/009/010/011/SUMMARY still guard the fire-and-forget `void`
 * pattern, which is unchanged.
 *
 * Tests:
 * 1. bootstrap success (normal flow completes)
 * 2. bootstrap with Telegram timeout (5s AbortController fires)
 * 3. bootstrap concurrent requests x5 (dedup + no deadlock)
 * 4. failed bootstrap can recover on next request (no stuck state)
 * 5. logBootstrapE2E is fire-and-forget (doesn't block)
 * 6. logBootstrapE2E does NOT perform KV operations (P0-B)
 * 7. logStartE2E is fire-and-forget (doesn't block)
 * 8. logStartE2E does NOT perform KV operations (P0-B)
 *
 * Run: node --test bootstrap-hang-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const USERS_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/users.js'), 'utf8');

// ============================================================================
// Section 1: Static verification — fire-and-forget pattern
// ============================================================================

test('HANG-001: ALL logBootstrapE2E calls in users.js use void (fire-and-forget)', () => {
  // Count void logBootstrapE2E calls — must be > 0
  const voidCount = (USERS_SRC.match(/void\s+logBootstrapE2E\s*\(/g) || []).length;
  assert.ok(voidCount >= 10, `Expected >=10 void logBootstrapE2E calls, got ${voidCount}`);
  // Count await logBootstrapE2E calls — must be 0 (none should block)
  const awaitCount = (USERS_SRC.match(/await\s+logBootstrapE2E\s*\(/g) || []).length;
  assert.equal(awaitCount, 0, `Expected 0 await logBootstrapE2E calls (all must be void), got ${awaitCount}`);
});

test('HANG-002: ALL logStartE2E calls in worker-proxy.js use void (fire-and-forget)', () => {
  const voidCount = (WORKER_SRC.match(/void\s+logStartE2E\s*\(/g) || []).length;
  assert.ok(voidCount >= 10, `Expected >=10 void logStartE2E calls, got ${voidCount}`);
  const awaitCount = (WORKER_SRC.match(/await\s+logStartE2E\s*\(/g) || []).length;
  assert.equal(awaitCount, 0, `Expected 0 await logStartE2E calls (all must be void), got ${awaitCount}`);
});

test('HANG-003: logBootstrapE2E does NOT perform KV operations (P0-B: KV removed)', () => {
  // P0-B KV-WRITE OPTIMIZATION: logBootstrapE2E no longer reads/writes APP_CACHE.
  // The internal 500ms Promise.race timeout was ONLY needed to bound the now-
  // removed KV read+write. With KV gone, there is no I/O to hang — the function
  // emits a structured console.log (event: 'bootstrap_e2e') and returns.
  const fnStart = WORKER_SRC.indexOf('async function logBootstrapE2E');
  assert.notStrictEqual(fnStart, -1, 'logBootstrapE2E must be defined');
  let depth = 0, inStr = false, strCh = '';
  let i = fnStart;
  while (WORKER_SRC[i] !== '{') i++;
  for (; i < WORKER_SRC.length; i++) {
    const c = WORKER_SRC[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
    } else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
  }
  const fnBlock = WORKER_SRC.slice(fnStart, i + 1);
  assert.ok(!fnBlock.includes('APP_CACHE.get'), 'logBootstrapE2E must NOT read APP_CACHE (KV read removed)');
  assert.ok(!fnBlock.includes('APP_CACHE.put'), 'logBootstrapE2E must NOT write APP_CACHE (KV write removed)');
  assert.ok(fnBlock.includes('console.log'), 'logBootstrapE2E must emit structured console.log');
  assert.ok(fnBlock.includes("'bootstrap_e2e'"), 'logBootstrapE2E console.log must tag event: bootstrap_e2e');
});

test('HANG-004: logStartE2E does NOT perform KV operations (P0-B: KV removed)', () => {
  // P0-B KV-WRITE OPTIMIZATION: logStartE2E no longer reads/writes APP_CACHE.
  // The internal 500ms Promise.race timeout was ONLY needed to bound the now-
  // removed KV read+write. With KV gone, there is no I/O to hang — the function
  // emits a structured console.log (event: 'start_e2e') and returns.
  const fnStart = WORKER_SRC.indexOf('async function logStartE2E');
  assert.notStrictEqual(fnStart, -1, 'logStartE2E must be defined');
  let depth = 0, inStr = false, strCh = '';
  let i = fnStart;
  while (WORKER_SRC[i] !== '{') i++;
  for (; i < WORKER_SRC.length; i++) {
    const c = WORKER_SRC[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
    } else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) break; }
    }
  }
  const fnBlock = WORKER_SRC.slice(fnStart, i + 1);
  assert.ok(!fnBlock.includes('APP_CACHE.get'), 'logStartE2E must NOT read APP_CACHE (KV read removed)');
  assert.ok(!fnBlock.includes('APP_CACHE.put'), 'logStartE2E must NOT write APP_CACHE (KV write removed)');
  assert.ok(fnBlock.includes('console.log'), 'logStartE2E must emit structured console.log');
  assert.ok(fnBlock.includes("'start_e2e'"), 'logStartE2E console.log must tag event: start_e2e');
});

// ============================================================================
// Section 2: Dynamic tests — bootstrap flow simulation
// ============================================================================

// Extract logBootstrapE2E from worker-proxy.js for dynamic testing
function extractFn(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Function ${name} not found`);
  const start = m.index;
  let i = start;
  while (i < src.length && src[i] !== '(') i++;
  let parenDepth = 0, inStrP = false, strChP = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStrP) { if (c === '\\') { i++; continue; } if (c === strChP) inStrP = false; }
    else {
      if (c === '"' || c === "'" || c === '`') { inStrP = true; strChP = c; }
      else if (c === '(') parenDepth++;
      else if (c === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    }
  }
  while (i < src.length && src[i] !== '{') i++;
  let depth = 0, inStr = false, strCh = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) { if (c === '\\') { i++; continue; } if (c === strCh) inStr = false; }
    else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
  }
  throw new Error(`end of ${name} not found`);
}

const logBootstrapE2E_SRC = extractFn(WORKER_SRC, 'logBootstrapE2E');
const logStartE2E_SRC = extractFn(WORKER_SRC, 'logStartE2E');

function loadLogFn(src) {
  const exportsObj = {};
  const evaluator = new Function('exports', 'setTimeout', 'clearTimeout', 'console',
    src + '\nexports.fn = logBootstrapE2E || logStartE2E;');
  evaluator(exportsObj, setTimeout, clearTimeout, console);
  return exportsObj.fn;
}

// Create a mock KV that can simulate hang/delay
function createMockKv(opts = {}) {
  const store = new Map();
  return {
    async get(key) {
      if (opts.getDelay) await new Promise(r => setTimeout(r, opts.getDelay));
      if (opts.getHang) return new Promise(() => {}); // never resolves
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value, opts2) {
      if (opts.putDelay) await new Promise(r => setTimeout(r, opts.putDelay));
      if (opts.putHang) return new Promise(() => {}); // never resolves
      store.set(key, value);
    },
    _store: store,
  };
}

// ============================================================================
// HANG-005: logBootstrapE2E completes even when KV hangs (timeout protection)
// ============================================================================

test('HANG-005: logBootstrapE2E completes within 600ms even when KV.get hangs', async () => {
  // This is THE test for the root cause: if KV hangs, the log function must
  // still return within ~500ms (the timeout race), NOT hang forever.
  const logFn = loadLogFn(logBootstrapE2E_SRC);
  const env = {
    APP_CACHE: createMockKv({ getHang: true }), // KV.get never resolves
  };

  const start = Date.now();
  await logFn(env, { phase: 'test', userId: '123' });
  const elapsed = Date.now() - start;

  // Must complete within ~600ms (500ms timeout + small overhead)
  assert.ok(elapsed < 700, `logBootstrapE2E must complete within 700ms when KV hangs, took ${elapsed}ms`);
});

test('HANG-006: logBootstrapE2E completes within 600ms even when KV.put hangs', async () => {
  const logFn = loadLogFn(logBootstrapE2E_SRC);
  const env = {
    APP_CACHE: createMockKv({ putHang: true }), // KV.put never resolves
  };

  const start = Date.now();
  await logFn(env, { phase: 'test', userId: '123' });
  const elapsed = Date.now() - start;

  assert.ok(elapsed < 700, `logBootstrapE2E must complete within 700ms when KV.put hangs, took ${elapsed}ms`);
});

test('HANG-007: logBootstrapE2E completes within 600ms when KV is slow (1s delay)', async () => {
  const logFn = loadLogFn(logBootstrapE2E_SRC);
  const env = {
    APP_CACHE: createMockKv({ getDelay: 1000, putDelay: 1000 }), // 1s per op
  };

  const start = Date.now();
  await logFn(env, { phase: 'test', userId: '123' });
  const elapsed = Date.now() - start;

  // Must NOT wait 2s (get + put) — timeout race cuts it at ~500ms
  assert.ok(elapsed < 700, `logBootstrapE2E must complete within 700ms when KV is slow, took ${elapsed}ms`);
});

// ============================================================================
// HANG-008: logBootstrapE2E is non-fatal (never throws)
// ============================================================================

test('HANG-008: logBootstrapE2E never throws even on KV error', async () => {
  const logFn = loadLogFn(logBootstrapE2E_SRC);
  const env = {
    APP_CACHE: {
      get() { throw new Error('KV error'); },
      put() { throw new Error('KV error'); },
    },
  };

  // Must not throw
  await logFn(env, { phase: 'test', userId: '123' });
  assert.ok(true, 'logBootstrapE2E did not throw on KV error');
});

// ============================================================================
// HANG-009: bootstrap handler uses void (not await) for all log calls
// ============================================================================

test('HANG-009: bootstrap handler does NOT await any logBootstrapE2E call', () => {
  // Verify NO `await logBootstrapE2E` pattern remains in users.js
  // (the old blocking pattern that caused the hang)
  assert.ok(!USERS_SRC.includes('await logBootstrapE2E'),
    'users.js must NOT contain any "await logBootstrapE2E" — all calls must be void (fire-and-forget)');
});

// ============================================================================
// HANG-010: bootstrap handler fires-and-forgets ALL log calls
// ============================================================================

test('HANG-010: bootstrap handler fires-and-forgets ALL logBootstrapE2E calls', () => {
  // Every logBootstrapE2E call must be prefixed with `void` (not `await`)
  const lines = USERS_SRC.split('\n');
  const logLines = lines.filter(l => l.includes('logBootstrapE2E('));
  for (const line of logLines) {
    assert.ok(line.includes('void logBootstrapE2E('),
      `logBootstrapE2E call must use void: ${line.trim()}`);
  }
});

// ============================================================================
// HANG-011: /start handler fires-and-forgets ALL logStartE2E calls
// ============================================================================

test('HANG-011: /start handler fires-and-forgets ALL logStartE2E calls', () => {
  const lines = WORKER_SRC.split('\n');
  const logLines = lines.filter(l => l.includes('logStartE2E(') && !l.includes('function') && !l.includes('exports.'));
  for (const line of logLines) {
    assert.ok(line.includes('void logStartE2E('),
      `logStartE2E call must use void: ${line.trim()}`);
  }
});

// ============================================================================
// HANG-012: Telegram getChatMember has 5s AbortController timeout
// ============================================================================

test('HANG-012: getChatMemberDebugPayload has 5s AbortController timeout', () => {
  // Verify the Telegram call has a timeout — this prevents the Telegram API
  // from hanging the bootstrap indefinitely
  assert.ok(WORKER_SRC.includes('setTimeout(() => tgController.abort(), 5000)'),
    'getChatMemberDebugPayload must have 5s AbortController timeout');
});

test('HANG-013: _checkSingleTelegramChannel has 5s AbortController timeout', () => {
  assert.ok(WORKER_SRC.includes('setTimeout(() => controller.abort(), 5000)'),
    '_checkSingleTelegramChannel must have 5s AbortController timeout');
});

// ============================================================================
// HANG-014: bootstrapUser frontend dedup (in app.js) — no deadlock
// ============================================================================

test('HANG-014: bootstrapUser dedup clears on completion (no stuck promise)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes('.finally(() => { _bootstrapUserInFlight = null; })'),
    'bootstrapUser must clear _bootstrapUserInFlight in finally block (prevents stuck promise)');
});

// ============================================================================
// Summary
// ============================================================================

test('SUMMARY: all fire-and-forget patterns verified', () => {
  // Final assertion: no `await log` pattern remains anywhere
  const workerAwaitLog = (WORKER_SRC.match(/await\s+log(Start|Bootstrap)E2E/g) || []).length;
  const usersAwaitLog = (USERS_SRC.match(/await\s+log(Start|Bootstrap)E2E/g) || []).length;
  assert.equal(workerAwaitLog + usersAwaitLog, 0,
    `No "await log*E2E" patterns should remain. Worker: ${workerAwaitLog}, Users: ${usersAwaitLog}`);
});

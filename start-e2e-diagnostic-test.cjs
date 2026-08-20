/**
 * Regression test for [START-E2E] / [BOOTSTRAP-E2E] diagnostic logging.
 *
 * P0-B KV-WRITE OPTIMIZATION: logStartE2E / logBootstrapE2E no longer persist
 * to APP_CACHE KV. They previously did 1 KV read + 1 KV write per call (rolling
 * array, TTL 1800s) — ~2,500-9,500 KV writes/day, the 2nd-largest KV Write
 * consumer. They now emit structured console.log entries captured by Cloudflare
 * Observability (wrangler tail / dashboard Logs; observability.enabled in
 * wrangler.jsonc). No business logic depends on the KV values — only the
 * /api/start-diag and /api/bootstrap-diag diagnostic endpoints read them, and
 * those endpoints now report the migration.
 *
 * These tests verify the NEW contract:
 *   1. logStartE2E / logBootstrapE2E do NOT call APP_CACHE.get or APP_CACHE.put
 *   2. They emit a structured console.log (JSON with event tag + fields)
 *   3. userId is sanitized (reduced to 4-char suffix, not full ID)
 *   4. No tokens or PII are logged
 *   5. Function is non-fatal (never throws) even on console.log failure
 *   6. Preserves entry data (phase, error, telegram_ok, etc.)
 *   7. Handles null/undefined env gracefully
 *
 * Run: node --test start-e2e-diagnostic-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');

// ============================================================================
// Mock KV that COUNTS get/put calls (to assert they are NOT made)
// ============================================================================

function createCountingKv() {
  const store = new Map();
  return {
    getCount: 0,
    putCount: 0,
    async get(key) { this.getCount++; return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { this.putCount++; store.set(key, value); this._lastOpts = opts; },
    _store: store,
    _lastOpts: null,
  };
}

// ============================================================================
// Mock console.log that captures calls (so we can assert structured output)
// ============================================================================

function captureConsole() {
  const calls = [];
  const orig = console.log;
  console.log = (...args) => { calls.push(args); };
  return {
    calls,
    restore() { console.log = orig; },
    // Parse the first JSON argument of the last console.log call
    lastJson() {
      if (!calls.length) return null;
      const last = calls[calls.length - 1];
      try { return JSON.parse(last[0]); } catch { return null; }
    },
  };
}

// ============================================================================
// Extract logStartE2E / logBootstrapE2E from worker-proxy.js via source-eval
// ============================================================================

const fs = require('node:fs');
const path = require('node:path');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

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

const logStartE2E_SRC = extractFn(WORKER_SRC, 'logStartE2E');
const logBootstrapE2E_SRC = extractFn(WORKER_SRC, 'logBootstrapE2E');

function loadFn(src) {
  const exportsObj = {};
  const evaluator = new Function('exports', 'console', src + '\nexports.fn = logStartE2E || logBootstrapE2E;');
  // Use a separate console sink so the loaded function's console.log does not
  // pollute test output. The real capture is done by monkey-patching this sink.
  const sink = { log: () => {} };
  evaluator(exportsObj, sink);
  return exportsObj.fn;
}

// Re-extract with a shared console reference so tests can capture output.
function loadFnWithConsole(src, consoleObj) {
  const exportsObj = {};
  // Use typeof guards so loading a SINGLE function source (where the other
  // is not declared) does not throw a ReferenceError. The evaluator defines
  // whichever function lives in `src`, then exports it.
  const evaluator = new Function('exports', 'console',
    src + '\nexports.fn = typeof logStartE2E !== "undefined" ? logStartE2E : (typeof logBootstrapE2E !== "undefined" ? logBootstrapE2E : null);');
  evaluator(exportsObj, consoleObj);
  return exportsObj.fn;
}

// ============================================================================
// Tests — logStartE2E
// ============================================================================

test('LOG-001: logStartE2E does NOT call APP_CACHE.put (KV write removed)', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'command_detected', userId: '123456789' });
    assert.equal(kv.putCount, 0, 'logStartE2E must NOT call APP_CACHE.put (KV write removed)');
    assert.equal(kv.getCount, 0, 'logStartE2E must NOT call APP_CACHE.get (KV read removed)');
  } finally {
    cap.restore();
  }
});

test('LOG-002: logStartE2E emits a structured console.log with event tag', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'command_detected', userId: '123456789' });
    assert.ok(cap.calls.length >= 1, 'logStartE2E must emit at least one console.log');
    const parsed = cap.lastJson();
    assert.ok(parsed, 'console.log argument must be valid JSON');
    assert.equal(parsed.event, 'start_e2e', 'structured log must carry event: "start_e2e"');
    assert.equal(parsed.phase, 'command_detected');
    assert.ok(parsed.ts, 'timestamp must be present');
  } finally {
    cap.restore();
  }
});

test('LOG-003: logStartE2E sanitizes userId (4-char suffix only, no full ID)', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'test', userId: '123456789' });
    const parsed = cap.lastJson();
    // Must NOT contain the full userId
    const entryStr = JSON.stringify(parsed);
    assert.ok(!entryStr.includes('123456789'), 'full userId must NOT be logged');
    // Should contain the 4-char suffix
    assert.equal(parsed.uid, '…6789', 'should have 4-char uid suffix');
    // Should NOT have userId field
    assert.equal(parsed.userId, undefined, 'userId field must be stripped');
  } finally {
    cap.restore();
  }
});

test('LOG-004: logStartE2E handles short userIds', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'test', userId: '42' });
    const parsed = cap.lastJson();
    assert.equal(parsed.uid, '42', 'short userId used as-is (no suffix slice)');
  } finally {
    cap.restore();
  }
});

test('LOG-005: logStartE2E handles missing userId (no uid field)', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'no_user' });
    const parsed = cap.lastJson();
    assert.equal(parsed.uid, undefined);
    assert.equal(parsed.userId, undefined);
  } finally {
    cap.restore();
  }
});

test('LOG-006: logStartE2E is non-fatal — never throws on console.log failure', async () => {
  // Even if console.log throws, logStartE2E must NOT throw (it would break /start)
  const kv = createCountingKv();
  const throwingConsole = { log() { throw new Error('console unavailable'); } };
  const fn = loadFnWithConsole(logStartE2E_SRC, throwingConsole);
  // Should not throw
  await fn({ APP_CACHE: kv }, { phase: 'test', userId: '123' });
  assert.ok(true, 'logStartE2E did not throw on console.log error');
});

test('LOG-007: logStartE2E handles null/undefined env gracefully', async () => {
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    // Should not throw — env is optional now (no KV access)
    await fn(null, { phase: 'test' });
    await fn(undefined, { phase: 'test' });
    await fn({}, { phase: 'test' });
    await fn({ APP_CACHE: null }, { phase: 'test' });
    assert.ok(true, 'handles null/undefined env without throwing');
  } finally {
    cap.restore();
  }
});

test('LOG-008: logStartE2E does NOT log tokens or secrets', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    const env = {
      APP_CACHE: kv,
      TELEGRAM_BOT_TOKEN: 'SUPER_SECRET_TOKEN_123',
      TELEGRAM_WEBHOOK_SECRET: 'WEBHOOK_SECRET_456',
    };
    await fn(env, { phase: 'test', userId: '123' });
    // The emitted log must NOT contain any token or secret values
    const logged = JSON.stringify(cap.calls);
    assert.ok(!logged.includes('SUPER_SECRET_TOKEN_123'), 'TELEGRAM_BOT_TOKEN must NOT appear in log');
    assert.ok(!logged.includes('WEBHOOK_SECRET_456'), 'TELEGRAM_WEBHOOK_SECRET must NOT appear in log');
  } finally {
    cap.restore();
  }
});

test('LOG-009: logStartE2E preserves entry data (phase, error, telegram_ok, etc.)', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, {
      phase: 'sendMessage_failed',
      userId: '9887654',
      telegram_ok: false,
      error: 'Telegram sendMessage failed: 400 Bad Request: WEBAPP_URL_INVALID',
    });
    const parsed = cap.lastJson();
    assert.equal(parsed.event, 'start_e2e');
    assert.equal(parsed.phase, 'sendMessage_failed');
    assert.equal(parsed.telegram_ok, false);
    assert.ok(parsed.error.includes('400'));
    assert.ok(parsed.ts, 'timestamp must be present');
    assert.equal(parsed.uid, '…7654');
  } finally {
    cap.restore();
  }
});

test('LOG-010: logStartE2E does NOT touch KV even when KV is healthy', async () => {
  // Confirms the optimization is unconditional — not gated on a feature flag.
  const kv = createCountingKv();
  // Pre-populate KV as if legacy data existed — must NOT be read or overwritten.
  kv._store.set('start:e2e_log', JSON.stringify([{ phase: 'legacy' }]));
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'new_call', userId: '222' });
    assert.equal(kv.getCount, 0, 'must NOT read legacy KV');
    assert.equal(kv.putCount, 0, 'must NOT write KV');
    // Legacy data untouched
    const raw = kv._store.get('start:e2e_log');
    assert.ok(raw.includes('legacy'), 'legacy KV data must be left untouched');
  } finally {
    cap.restore();
  }
});

test('LOG-011: logStartE2E is async and returns a promise (fire-and-forget compatible)', async () => {
  const fn = loadFnWithConsole(logStartE2E_SRC, console);
  const ret = fn({ APP_CACHE: createCountingKv() }, { phase: 'test' });
  assert.ok(ret && typeof ret.then === 'function', 'must return a Promise (callers use `void`)');
  await ret;
});

test('LOG-012: logStartE2E handles concurrent calls without error', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logStartE2E_SRC, console);
    await Promise.all([
      fn({ APP_CACHE: kv }, { phase: 'a', userId: '1' }),
      fn({ APP_CACHE: kv }, { phase: 'b', userId: '2' }),
      fn({ APP_CACHE: kv }, { phase: 'c', userId: '3' }),
    ]);
    assert.equal(cap.calls.length, 3, '3 concurrent calls → 3 console.log entries');
    assert.equal(kv.putCount, 0, 'no KV writes even under concurrency');
  } finally {
    cap.restore();
  }
});

// ============================================================================
// Tests — logBootstrapE2E (same NEW contract)
// ============================================================================

test('LOG-013: logBootstrapE2E does NOT call APP_CACHE.put (KV write removed)', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logBootstrapE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'entry', userId: '987654321' });
    assert.equal(kv.putCount, 0, 'logBootstrapE2E must NOT call APP_CACHE.put');
    assert.equal(kv.getCount, 0, 'logBootstrapE2E must NOT call APP_CACHE.get');
  } finally {
    cap.restore();
  }
});

test('LOG-014: logBootstrapE2E emits structured console.log with event tag', async () => {
  const kv = createCountingKv();
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logBootstrapE2E_SRC, console);
    await fn({ APP_CACHE: kv }, { phase: 'membership_resolved', userId: '987654321', joined: true });
    const parsed = cap.lastJson();
    assert.ok(parsed, 'console.log argument must be valid JSON');
    assert.equal(parsed.event, 'bootstrap_e2e');
    assert.equal(parsed.phase, 'membership_resolved');
    assert.equal(parsed.joined, true);
    assert.equal(parsed.uid, '…4321');
  } finally {
    cap.restore();
  }
});

test('LOG-015: logBootstrapE2E is non-fatal and handles null env', async () => {
  const cap = captureConsole();
  try {
    const fn = loadFnWithConsole(logBootstrapE2E_SRC, console);
    await fn(null, { phase: 'test' });
    await fn(undefined, { phase: 'test' });
    assert.ok(true, 'handles null/undefined env without throwing');
  } finally {
    cap.restore();
  }
});

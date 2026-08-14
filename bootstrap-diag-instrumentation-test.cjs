// ============================================================================
// DIAGNOSTIC INSTRUMENTATION TESTS — _bsDiag, _sanitizeDiagString, _sanitizeDiagValue
//
// These tests verify ONLY the diagnostic instrumentation added for the bootstrap
// hang root-cause analysis. They do NOT test business logic, do NOT simulate hangs,
// and do NOT alter production behavior.
//
// Coverage:
//   A) Normal diagnostic event structure (valid JSON, required fields)
//   B) Error sanitization (secrets stripped before logging)
//   C) Instrumentation failure safety (_bsDiag never throws into request path)
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const source = fs.readFileSync(WORKER_PATH, 'utf8');

// Extract the diagnostic instrumentation block from worker-proxy.js source.
// We isolate _sanitizeDiagString, _sanitizeDiagValue, and _bsDiag so they can be
// tested WITHOUT loading the entire worker module (which requires DB/Telemetry mocks).
function loadDiagInstrumentation(consoleWarnStub) {
  // Find the instrumentation block: from "_sanitizeDiagString" to the end of _bsDiag.
  const startMarker = 'function _sanitizeDiagString(str)';
  const startIdx = source.indexOf(startMarker);
  assert.notStrictEqual(startIdx, -1, '_sanitizeDiagString not found in worker-proxy.js');

  // The block ends at the closing brace of _bsDiag. We find the next
  // "async function readJsonBody" which immediately follows _bsDiag.
  const endMarker = 'async function readJsonBody';
  const endIdx = source.indexOf(endMarker, startIdx);
  assert.notStrictEqual(endIdx, -1, 'readJsonBody marker not found');

  const blockSrc = source.slice(startIdx, endIdx);

  // The block references _traceId (module-scoped variable). We provide a stub.
  // _bsDiag reads env._bsDiagId and _traceId. We expose _traceId via a wrapper.
  const _traceId = 'test-trace-1234';
  const exportsObj = {};
  const evaluator = new Function(
    '_traceId',
    'console',
    'exports',
    `${blockSrc}
     exports._sanitizeDiagString = _sanitizeDiagString;
     exports._sanitizeDiagValue = _sanitizeDiagValue;
     exports._bsDiag = _bsDiag;`,
  );
  evaluator(_traceId, { warn: consoleWarnStub || (() => {}) }, exportsObj);
  return exportsObj;
}

// ============================================================================
// A) NORMAL DIAGNOSTIC EVENT STRUCTURE
// ============================================================================

test('DIAG-A1: _bsDiag emits valid JSON to console.warn', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  const env = { _bsDiagId: 'bs_test_abc' };
  diag._bsDiag(env, 'read-body', 'start');
  assert.ok(captured !== null, 'console.warn should have been called');
  let parsed;
  assert.doesNotThrow(() => { parsed = JSON.parse(captured); }, 'emitted string must be valid JSON');
  assert.strictEqual(parsed.event, 'bootstrap-diag');
  assert.strictEqual(parsed.stage, 'read-body');
  assert.strictEqual(parsed.phase, 'start');
  assert.strictEqual(parsed.requestId, 'bs_test_abc', 'requestId must come from env._bsDiagId');
  assert.strictEqual(parsed.traceId, 'test-trace-1234', 'traceId must come from _traceId');
  assert.ok(typeof parsed.timestamp === 'string' && parsed.timestamp.length > 0, 'timestamp present');
});

test('DIAG-A2: _bsDiag includes durationMs on END events', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  diag._bsDiag({}, 'read-body', 'end', { durationMs: 42 });
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.phase, 'end');
  assert.strictEqual(parsed.durationMs, 42, 'durationMs must be preserved from extra');
});

test('DIAG-A3: _bsDiag falls back to _traceId when env._bsDiagId is absent', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  diag._bsDiag(null, 'entry', 'start');
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.requestId, 'test-trace-1234', 'falls back to _traceId');
});

test('DIAG-A4: _bsDiag uses "no-id" when both env._bsDiagId and _traceId are absent', () => {
  // Re-load with _traceId = '' to simulate missing trace
  const exportsObj = {};
  const blockSrc = source.slice(
    source.indexOf('function _sanitizeDiagString(str)'),
    source.indexOf('async function readJsonBody'),
  );
  const evaluator = new Function('_traceId', 'console', 'exports',
    `${blockSrc}; exports._bsDiag = _bsDiag;`);
  evaluator('', { warn: (m) => { exportsObj._last = m; } }, exportsObj);
  exportsObj._bsDiag(null, 'entry', 'start');
  const parsed = JSON.parse(exportsObj._last);
  assert.strictEqual(parsed.requestId, 'no-id');
});

// ============================================================================
// B) ERROR SANITIZATION — SECRETS MUST NEVER BE LOGGED
// ============================================================================

test('DIAG-B1: token=SECRET is sanitized to token=***', () => {
  const diag = loadDiagInstrumentation(() => {});
  const result = diag._sanitizeDiagString('connection failed: token=abc123SECRETvalue');
  assert.ok(!result.includes('abc123SECRETvalue'), 'raw secret must not appear');
  assert.ok(result.includes('token=***'), 'token pattern must be redacted');
});

test('DIAG-B2: key=SECRET is sanitized to key=***', () => {
  const diag = loadDiagInstrumentation(() => {});
  const result = diag._sanitizeDiagString('error: key="super-secret-key-value"');
  assert.ok(!result.includes('super-secret-key-value'), 'raw key must not appear');
  assert.ok(result.includes('key=***'), 'key pattern must be redacted');
});

test('DIAG-B3: secret=SECRET is sanitized to secret=***', () => {
  const diag = loadDiagInstrumentation(() => {});
  const result = diag._sanitizeDiagString('config: secret=mySecretValue123');
  assert.ok(!result.includes('mySecretValue123'));
  assert.ok(result.includes('secret=***'));
});

test('DIAG-B4: password=SECRET is sanitized to password=***', () => {
  const diag = loadDiagInstrumentation(() => {});
  const result = diag._sanitizeDiagString('auth: password=hunter2pass');
  assert.ok(!result.includes('hunter2pass'));
  assert.ok(result.includes('password=***'));
});

test('DIAG-B5: postgres://user:password@host connection string is sanitized', () => {
  const diag = loadDiagInstrumentation(() => {});
  const raw = 'postgres://postgres:Ali%2399391377@db.example.supabase.co:5432/postgres';
  const result = diag._sanitizeDiagString(raw);
  assert.ok(!result.includes('Ali%2399391377'), 'password must not appear');
  assert.ok(!result.includes('postgres:Ali'), 'user:password combo must not appear');
  assert.ok(result.includes('***:***@'), 'credentials must be redacted');
});

test('DIAG-B6: Telegram Bot API URL with token is sanitized', () => {
  const diag = loadDiagInstrumentation(() => {});
  const raw = 'fetch failed: https://api.telegram.org/bot123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx/getChatMember';
  const result = diag._sanitizeDiagString(raw);
  assert.ok(!result.includes('123456789:AAExxxx'), 'bot token must not appear');
  assert.ok(!result.includes('AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'), 'full token must not appear');
  assert.ok(result.includes('bot***'), 'token must be redacted');
});

test('DIAG-B7: Telegram initData query-string is redacted entirely', () => {
  const diag = loadDiagInstrumentation(() => {});
  const raw = 'auth failed: hash=abc123def456&user=%7B%22id%22%3A123%7D&auth_date=1234567890';
  const result = diag._sanitizeDiagString(raw);
  assert.ok(!result.includes('abc123def456'), 'hash must not appear');
  assert.ok(!result.includes('%22id%22'), 'user JSON must not appear');
  assert.strictEqual(result, '[INITDATA_REDACTED]', 'initData must be fully redacted');
});

test('DIAG-B8: Bearer token in Authorization header is sanitized', () => {
  const diag = loadDiagInstrumentation(() => {});
  const raw = 'request header: Bearer eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.payload.signature';
  const result = diag._sanitizeDiagString(raw);
  assert.ok(!result.includes('eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9'), 'JWT must not appear');
  assert.ok(result.includes('Bearer ***'), 'bearer token must be redacted');
});

test('DIAG-B9: api_key= and apikey= are sanitized', () => {
  const diag = loadDiagInstrumentation(() => {});
  assert.ok(diag._sanitizeDiagString('api_key=sk_live_12345').includes('api_key=***'));
  assert.ok(diag._sanitizeDiagString('apikey=sk_live_12345').includes('apikey=***'));
  assert.ok(!diag._sanitizeDiagString('api_key=sk_live_12345').includes('sk_live_12345'));
});

test('DIAG-B10: access_token= and refresh_token= are sanitized', () => {
  const diag = loadDiagInstrumentation(() => {});
  assert.ok(diag._sanitizeDiagString('access_token=tok_abc123').includes('access_token=***'));
  assert.ok(diag._sanitizeDiagString('refresh_token=ref_xyz789').includes('refresh_token=***'));
  assert.ok(!diag._sanitizeDiagString('refresh_token=ref_xyz789').includes('ref_xyz789'));
});

test('DIAG-B11: bot_token= is sanitized', () => {
  const diag = loadDiagInstrumentation(() => {});
  const result = diag._sanitizeDiagString('env: bot_token=123456789:AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx');
  assert.ok(!result.includes('AAExxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx'));
  assert.ok(result.includes('bot_token=***'));
});

test('DIAG-B12: errorMessage in _bsDiag extra is sanitized end-to-end', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  const secretMsg = 'fetch failed: https://api.telegram.org/bot123456:AAExxxxxxxx/getChatMember';
  diag._bsDiag({}, 'telegram-api', 'error', {
    errorName: 'Error',
    errorMessage: secretMsg,
  });
  const parsed = JSON.parse(captured);
  assert.ok(!JSON.stringify(parsed).includes('AAExxxxxxxx'), 'bot token must not appear in emitted log');
  assert.ok(!JSON.stringify(parsed).includes('123456:AAExx'), 'token prefix must not appear');
  assert.ok(parsed.errorMessage.includes('bot***'), 'errorMessage must contain redacted token');
});

test('DIAG-B13: nested object values are sanitized recursively', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  diag._bsDiag({}, 'test', 'start', {
    outer: {
      url: 'https://api.telegram.org/bot123456:AAExxxxxxxx/getMe',
      nested: { password: 'secret123' },
    },
  });
  const logStr = captured;
  assert.ok(!logStr.includes('AAExxxxxxxx'), 'nested bot token must not appear');
  assert.ok(!logStr.includes('secret123'), 'nested password must not appear');
  assert.ok(logStr.includes('bot***'), 'nested URL must be redacted');
  // When 'password' is an object KEY, the value is fully redacted to [REDACTED]
  // (stronger than the string-level password=*** pattern).
  assert.ok(logStr.includes('[REDACTED]'), 'nested password value must be fully redacted');
});

test('DIAG-B14: authorization key in object is fully redacted', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  diag._bsDiag({}, 'test', 'start', {
    headers: { Authorization: 'Bearer eyJsomejwt', Cookie: 'session=abc' },
  });
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.headers.Authorization, '[REDACTED]', 'Authorization must be fully redacted');
  assert.strictEqual(parsed.headers.Cookie, '[REDACTED]', 'Cookie must be fully redacted');
  assert.ok(!captured.includes('eyJsomejwt'), 'JWT must not appear');
  assert.ok(!captured.includes('session=abc'), 'cookie value must not appear');
});

test('DIAG-B15: x-telegram-init-data key is fully redacted', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  diag._bsDiag({}, 'test', 'start', {
    headers: { 'X-Telegram-Init-Data': 'hash=abc&user=%7B%22id%22%3A123%7D' },
  });
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.headers['X-Telegram-Init-Data'], '[REDACTED]');
  assert.ok(!captured.includes('hash=abc'), 'initData hash must not appear');
});

test('DIAG-B16: strings are truncated to 150 chars AFTER sanitization', () => {
  const diag = loadDiagInstrumentation(() => {});
  const long = 'token=secret_' + 'x'.repeat(200);
  const result = diag._sanitizeDiagString(long);
  assert.ok(result.length <= 150, 'must be truncated to 150 chars');
  assert.ok(result.includes('token=***'), 'sanitization must happen before truncation');
});

test('DIAG-B17: non-secret error messages are preserved (not over-redacted)', () => {
  const diag = loadDiagInstrumentation(() => {});
  const result = diag._sanitizeDiagString('Connection terminated: ECONNRESET at NeonPool.query');
  assert.ok(result.includes('ECONNRESET'), 'legitimate error code must be preserved');
  assert.ok(result.includes('Connection terminated'), 'error description must be preserved');
});

test('DIAG-B18: numbers and booleans in extra are preserved unchanged', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  diag._bsDiag({}, 'test', 'start', { durationMs: 42, isNewUser: true, count: 0 });
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.durationMs, 42);
  assert.strictEqual(parsed.isNewUser, true);
  assert.strictEqual(parsed.count, 0);
});

// ============================================================================
// C) INSTRUMENTATION FAILURE SAFETY — _bsDiag MUST NEVER THROW
// ============================================================================

test('DIAG-C1: _bsDiag does not throw when console.warn throws', () => {
  const diag = loadDiagInstrumentation(() => { throw new Error('console broken'); });
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', { foo: 'bar' });
  }, '_bsDiag must swallow internal errors');
});

test('DIAG-C2: _bsDiag does not throw when extra contains a circular reference', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  const circular = { name: 'test' };
  circular.self = circular;
  // JSON.stringify throws on circular refs by default — _bsDiag must catch it
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', circular);
  });
  // Either it logged a sanitized version (if _sanitizeDiagValue handled the cycle)
  // or it silently failed — both are acceptable. It must NOT throw.
  if (captured !== null) {
    assert.doesNotThrow(() => JSON.parse(captured), 'if logged, must be valid JSON');
  }
});

test('DIAG-C3: _bsDiag does not throw when extra contains a function value', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', { callback: () => {}, fn: function named() {} });
  });
  const parsed = JSON.parse(captured);
  assert.strictEqual(parsed.callback, '[function]');
  assert.strictEqual(parsed.fn, '[function]');
});

test('DIAG-C4: _bsDiag does not throw when extra contains a Symbol', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', { sym: Symbol('test') });
  });
  // JSON.stringify converts Symbols to undefined, so key is dropped — acceptable
  assert.doesNotThrow(() => JSON.parse(captured));
});

test('DIAG-C5: _bsDiag does not throw when env is undefined', () => {
  const diag = loadDiagInstrumentation(() => {});
  assert.doesNotThrow(() => {
    diag._bsDiag(undefined, 'entry', 'start');
  });
});

test('DIAG-C6: _bsDiag does not throw when stage/phase are null', () => {
  const diag = loadDiagInstrumentation(() => {});
  assert.doesNotThrow(() => {
    diag._bsDiag({}, null, null, null);
  });
});

test('DIAG-C7: _bsDiag handles deeply nested objects without infinite recursion', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  // Build a 10-level deep object — _sanitizeDiagValue caps at depth 5
  let deep = { level: 0 };
  let current = deep;
  for (let i = 1; i < 10; i++) {
    current.child = { level: i, secret: 'password=deep' + i };
    current = current.child;
  }
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', deep);
  });
  if (captured !== null) {
    assert.doesNotThrow(() => JSON.parse(captured));
    assert.ok(!captured.includes('password=deep5'), 'deep secret must be redacted or capped');
  }
});

test('DIAG-C8: _bsDiag handles large arrays by capping at 20 elements', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  const bigArr = Array.from({ length: 100 }, (_, i) => `item${i}`);
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', { items: bigArr });
  });
  const parsed = JSON.parse(captured);
  assert.ok(Array.isArray(parsed.items), 'array must be preserved');
  assert.ok(parsed.items.length <= 20, 'array must be capped at 20 elements');
});

test('DIAG-C9: _bsDiag handles objects with >30 keys by capping', () => {
  let captured = null;
  const diag = loadDiagInstrumentation((msg) => { captured = msg; });
  const bigObj = {};
  for (let i = 0; i < 50; i++) bigObj[`key${i}`] = `value${i}`;
  assert.doesNotThrow(() => {
    diag._bsDiag({}, 'test', 'start', bigObj);
  });
  const parsed = JSON.parse(captured);
  // Base entry always has 6 reserved keys: event, requestId, traceId, stage, phase, timestamp.
  // The extra object is capped at 30 keys by _sanitizeDiagValue.
  const reservedKeys = 6;
  const extraKeyCount = Object.keys(parsed).length - reservedKeys;
  assert.ok(extraKeyCount <= 30, 'object must be capped at ~30 keys (got ' + extraKeyCount + ')');
});

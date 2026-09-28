/**
 * Mission Tokens ESM Import Regression Test
 *
 * Purpose: Verify that src/auth/mission-tokens.js properly imports
 * createHmac and timingSafeEqual from 'node:crypto'. This test was
 * created after a production regression (commit 7d0181e, PR #17) where
 * the extraction of mission token code to a separate ES module forgot
 * to carry over the `import { createHmac, timingSafeEqual } from
 * 'node:crypto'` statement, causing:
 *   POST /api/wallet/mission/issue-token → 503
 *   ReferenceError: createHmac is not defined
 *
 * Why this test exists: The existing tests (mission-event-token-test.cjs,
 * wallet-p1-p2-security-fix-test.cjs) use `new Function()` + dependency
 * injection (passing createHmac as a parameter). That approach masks the
 * missing import — the test always passes because createHmac is injected
 * externally. This test uses Node.js's REAL ESM module resolution via a
 * data URL, so the `import` statement in mission-tokens.js is actually
 * resolved by Node.js. If the import is missing, ReferenceError is thrown.
 *
 * Coverage:
 *   1. issueMissionEventToken() produces a signed token (createHmac path)
 *   2. consumeMissionEventToken() validates the same token (timingSafeEqual path)
 *   3. Cross-user rejection
 *   4. Target binding rejection
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── Load mission-tokens.js as a REAL ES module ──────────────────────────
// We use a data URL so Node.js treats the .js source as an ES module
// (regardless of package.json "type" setting). The `import { createHmac,
// timingSafeEqual } from 'node:crypto'` statement in the source is
// resolved by Node.js's real module system. If the import is missing,
// createHmac will be ReferenceError at runtime.
//
// This is fundamentally different from the `new Function()` approach used
// by other tests, which injects createHmac as a parameter and masks
// the missing import.
let _createMissionTokenService = null;

async function loadMissionTokenService() {
  if (_createMissionTokenService) return _createMissionTokenService;
  const src = fs.readFileSync(
    path.join(__dirname, '..', 'src/auth/mission-tokens.js'),
    'utf8'
  );
  const dataUrl = `data:text/javascript;base64,${Buffer.from(src).toString('base64')}`;
  const mod = await import(dataUrl);
  _createMissionTokenService = mod.createMissionTokenService;
  return _createMissionTokenService;
}

// ── Minimal test helpers (no external dependencies) ─────────────────────

function sharedGetTehranDateString() {
  return new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).format(new Date());
}

function createMockKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

function createMockEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'test-bot-token-123456:ABCdefGHI',
    SESSION_CACHE: createMockKv(),
    ...overrides,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// TEST 1: ESM module loads without ReferenceError (createHmac is imported)
// ═══════════════════════════════════════════════════════════════════════════

test('ESM import: mission-tokens.js loads createHmac + timingSafeEqual without ReferenceError', async () => {
  const createMissionTokenService = await loadMissionTokenService();
  const svc = createMissionTokenService({ sharedGetTehranDateString });
  assert.ok(typeof svc.issueMissionEventToken === 'function',
    'issueMissionEventToken must be a function');
  assert.ok(typeof svc.consumeMissionEventToken === 'function',
    'consumeMissionEventToken must be a function');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 2: issueMissionEventToken produces a signed token (createHmac path)
// ═══════════════════════════════════════════════════════════════════════════

test('issueMissionEventToken produces a signed token (HMAC-SHA256 path)', async () => {
  const createMissionTokenService = await loadMissionTokenService();
  const svc = createMissionTokenService({ sharedGetTehranDateString });
  const env = createMockEnv();

  // This calls _signMissionToken → _getMissionSigningKey → createHmac
  // If createHmac is not imported, this throws ReferenceError
  const token = await svc.issueMissionEventToken(env, 'user_123', 'read_news', 'article_456');

  assert.ok(token, 'token must not be null/undefined');
  assert.ok(typeof token === 'string', 'token must be a string');
  assert.ok(token.includes('.'),
    'signed token must contain dot separator (payloadBase64.signature)');

  // Verify token structure: payloadBase64.signature
  const parts = token.split('.');
  assert.equal(parts.length, 2, 'token must have exactly 2 parts separated by dot');
  const [payloadB64, sig] = parts;
  assert.ok(payloadB64.length > 0, 'payload part must not be empty');
  assert.ok(sig.length > 0, 'signature part must not be empty');

  // HMAC-SHA256 produces a 64-char hex signature
  assert.ok(/^[0-9a-f]+$/.test(sig), 'signature must be a hex string');
  assert.equal(sig.length, 64, 'HMAC-SHA256 signature must be 64 hex chars');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 3: consumeMissionEventToken validates the same token (timingSafeEqual path)
// ═══════════════════════════════════════════════════════════════════════════

test('consumeMissionEventToken validates the same signed token (timingSafeEqual path)', async () => {
  const createMissionTokenService = await loadMissionTokenService();
  const svc = createMissionTokenService({ sharedGetTehranDateString });
  const env = createMockEnv();

  // Issue a token
  const token = await svc.issueMissionEventToken(env, 'user_123', 'read_news', 'article_456');
  assert.ok(token, 'token must be issued');

  // Consume the same token — this calls _verifyMissionTokenSignature →
  // _getMissionSigningKey → createHmac + timingSafeEqual
  // If createHmac or timingSafeEqual is not imported, this throws ReferenceError
  const consumed = await svc.consumeMissionEventToken(
    env, 'user_123', 'read_news', token, 'article_456'
  );
  assert.equal(consumed, true, 'valid token must be consumed successfully');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 4: Cross-user rejection (token bound to user_123, consumed by user_999)
// ═══════════════════════════════════════════════════════════════════════════

test('consumeMissionEventToken rejects wrong user (cross-user prevention)', async () => {
  const createMissionTokenService = await loadMissionTokenService();
  const svc = createMissionTokenService({ sharedGetTehranDateString });
  const env = createMockEnv();

  const token = await svc.issueMissionEventToken(env, 'user_123', 'read_news', 'article_456');
  const consumed = await svc.consumeMissionEventToken(
    env, 'user_999', 'read_news', token, 'article_456'
  );
  assert.equal(consumed, false, 'token must be rejected for wrong user');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 5: Target binding rejection (token bound to article_456, consumed with wrong_target)
// ═══════════════════════════════════════════════════════════════════════════

test('consumeMissionEventToken rejects wrong target (target binding enforcement)', async () => {
  const createMissionTokenService = await loadMissionTokenService();
  const svc = createMissionTokenService({ sharedGetTehranDateString });
  const env = createMockEnv();

  const token = await svc.issueMissionEventToken(env, 'user_123', 'read_news', 'article_456');
  const consumed = await svc.consumeMissionEventToken(
    env, 'user_123', 'read_news', token, 'wrong_target'
  );
  assert.equal(consumed, false, 'token must be rejected for wrong target');
});

// ═══════════════════════════════════════════════════════════════════════════
// TEST 6: Cross-mission rejection (token for read_news, consumed with open_calendar)
// ═══════════════════════════════════════════════════════════════════════════

test('consumeMissionEventToken rejects wrong mission (cross-mission prevention)', async () => {
  const createMissionTokenService = await loadMissionTokenService();
  const svc = createMissionTokenService({ sharedGetTehranDateString });
  const env = createMockEnv();

  const token = await svc.issueMissionEventToken(env, 'user_123', 'read_news', 'article_456');
  const consumed = await svc.consumeMissionEventToken(
    env, 'user_123', 'open_calendar', token, 'article_456'
  );
  assert.equal(consumed, false, 'token must be rejected for wrong mission');
});

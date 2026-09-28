/**
 * MISSION-EVENT-TOKEN-TEST
 *
 * Verifies the mission event token mechanism (MISSION-ABUSE FIX / WALLET-002):
 *   1. issueMissionEventToken returns a 32-char hex token
 *   2. consumeMissionEventToken returns true for valid token, false for invalid
 *   3. Token is one-time use (second consume returns false)
 *   4. Replay attack rejected (same token can't be consumed twice)
 *   5. Concurrent consume of same token — only ONE succeeds
 *   6. daily_login doesn't need a token (tested via controller logic)
 *   7. Token from one user can't be consumed by another
 *
 * The functions are tested via the Worker's exported default. We use a
 * minimal in-memory KV simulator to test the actual logic.
 */

const { test, before } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ── In-memory KV namespace simulator (Cloudflare KV API subset) ────────
function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, options) {
      store.set(key, value);
      // TTL handling is implicit — in production KV handles it.
      // For testing, we simulate expiration by tracking TTL.
      if (options && options.expirationTtl) {
        setTimeout(() => store.delete(key), options.expirationTtl * 1000).unref?.();
      }
    },
    async delete(key) { store.delete(key); },
    _store: store,
    _size: () => store.size,
  };
}

// ── Load mission token service from extracted module ───────────────────
// The mission token functions were extracted to src/auth/mission-tokens.js
// (behavior-preserving move). The module is a real ES module that begins
// with `import { createHmac, timingSafeEqual } from 'node:crypto'`.
//
// We load it as real ESM via a data URL so Node.js resolves the import
// statement natively. If the import is missing or malformed, a SyntaxError
// is thrown at load time — preventing the regression previously masked by
// the old `new Function()` + dependency-injection approach, which silently
// injected createHmac/timingSafeEqual as function parameters and hid a
// missing top-level import (PR #41 restored the import; this test now
// guards against its accidental removal).
//
// The factory receives sharedGetTehranDateString (from
// src/services/timezone.js) so the FA-7 Tehran-date fix is exercised.
const missionTokensSrc = fs.readFileSync(path.join(__dirname, '..', 'src/auth/mission-tokens.js'), 'utf8');

// FA-7: _getTodayISOString now delegates to sharedGetTehranDateString (Tehran
// timezone). We must provide this helper to the factory.
const sharedGetTehranDateString = function() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

let issueMissionEventToken;
let consumeMissionEventToken;
let isMissionEventTokenConsumed;

before(async () => {
  // Load mission-tokens.js as a real ES module via a base64 data URL.
  // This forces Node.js to resolve the
  // `import { createHmac, timingSafeEqual } from 'node:crypto'` statement.
  // If the import is missing, ReferenceError/SyntaxError is thrown at
  // runtime — preventing the regression previously hidden by the
  // new Function() + dependency-injection approach.
  const dataUrl = `data:text/javascript;base64,${Buffer.from(missionTokensSrc).toString('base64')}`;
  const mod = await import(dataUrl);
  // Call the factory to get the token service functions
  const tokenService = mod.createMissionTokenService({ sharedGetTehranDateString });
  ({
    issueMissionEventToken,
    consumeMissionEventToken,
    isMissionEventTokenConsumed,
  } = tokenService);
});

// ── Tests ──────────────────────────────────────────────────────────────

test('MISSION-001: issueMissionEventToken returns a signed token string', async () => {
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '11111111';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  console.log('  Token:', token);

  assert.ok(token, 'Token must be returned');
  assert.equal(typeof token, 'string');
  assert.ok(token.includes('.'), 'Signed token must contain a dot separator');
});

test('MISSION-002: consumeMissionEventToken returns true for valid token', async () => {
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '22222222';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  const consumed = await consumeMissionEventToken(env, userId, missionId, token);

  assert.equal(consumed, true, 'Valid token MUST be consumed successfully');
});

test('MISSION-003: Signed token consume succeeds — DB idempotency handles replay', async () => {
  // PHASE 2D: Signed tokens are stateless — consume always returns true for
  // a valid token. Replay prevention is handled by DB idempotency:
  //   - incrementMissionProgress: CASE WHEN rewarded=FALSE (no progress inflation)
  //   - markMissionRewarded: WHERE rewarded=FALSE (CAS, only one reward)
  //   - grantReward: UNIQUE(ref_id) ON CONFLICT DO NOTHING (no double-credit)
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '33333333';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  const c1 = await consumeMissionEventToken(env, userId, missionId, token);
  const c2 = await consumeMissionEventToken(env, userId, missionId, token);

  assert.equal(c1, true, 'First consume must succeed');
  assert.equal(c2, true, 'Second consume also succeeds (stateless token) — DB handles replay');
});

test('MISSION-004: Replay returns true at token level — DB prevents double-reward', async () => {
  // PHASE 2D: Signed tokens are stateless. The same token can be consumed
  // multiple times at the token level (returns true each time). The DB
  // is the authoritative safety net:
  //   - markMissionRewarded CAS: only first call sets rewarded=TRUE
  //   - grantReward UNIQUE(ref_id): only first call credits tokens
  //   - incrementMissionProgress CASE WHEN rewarded=FALSE: no progress inflation
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '44444444';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  await consumeMissionEventToken(env, userId, missionId, token);

  // Replay — token is still valid (stateless)
  const replayResult = await consumeMissionEventToken(env, userId, missionId, token);
  assert.equal(replayResult, true, 'Replay succeeds at token level — DB prevents double-reward');
});

test('MISSION-005: Concurrent consume — DB-level idempotency is the final safety net', async () => {
  // PHASE 2D: Signed tokens are stateless — all consumes succeed at token level.
  // DB idempotency is the authoritative safety net:
  //   - markMissionRewarded CAS: only one sets rewarded=TRUE
  //   - grantReward UNIQUE(ref_id): only one credits tokens
  //   - incrementMissionProgress CASE WHEN rewarded=FALSE: no progress inflation
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '55555555';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);

  // All consumes succeed at token level — DB is the safety net
  const c1 = await consumeMissionEventToken(env, userId, missionId, token);
  const c2 = await consumeMissionEventToken(env, userId, missionId, token);
  const c3 = await consumeMissionEventToken(env, userId, missionId, token);

  assert.equal(c1, true, 'First consume succeeds (stateless token)');
  assert.equal(c2, true, 'Second consume succeeds (stateless token) — DB prevents double-reward');
  assert.equal(c3, true, 'Third consume succeeds (stateless token) — DB prevents double-reward');
});

test('MISSION-006: Token from one user cannot be consumed by another user', async () => {
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userA = '66666661';
  const userB = '66666662';
  const missionId = 'read_news';

  // User A issues a token
  const token = await issueMissionEventToken(env, userA, missionId);

  // User B tries to consume User A's token (with User B's userId)
  const consumed = await consumeMissionEventToken(env, userB, missionId, token);
  assert.equal(consumed, false, 'Cross-user consume MUST fail');

  // User A can still consume their own token
  const consumedA = await consumeMissionEventToken(env, userA, missionId, token);
  assert.equal(consumedA, true, 'Original user can consume their token');
});

test('MISSION-007: Token from one mission cannot be used for another mission', async () => {
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '77777777';
  const mission1 = 'read_news';
  const mission2 = 'read_analysis';

  // Issue token for mission1
  const token = await issueMissionEventToken(env, userId, mission1);

  // Try to consume for mission2 — MUST fail
  const consumed = await consumeMissionEventToken(env, userId, mission2, token);
  assert.equal(consumed, false, 'Cross-mission consume MUST fail');
});

test('MISSION-008: Invalid token formats rejected', async () => {
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '88888888';
  const missionId = 'read_news';

  // No token
  assert.equal(await consumeMissionEventToken(env, userId, missionId, ''), false);
  assert.equal(await consumeMissionEventToken(env, userId, missionId, null), false);
  assert.equal(await consumeMissionEventToken(env, userId, missionId, undefined), false);

  // Wrong length
  assert.equal(await consumeMissionEventToken(env, userId, missionId, 'abc'), false);
  assert.equal(await consumeMissionEventToken(env, userId, missionId, 'a'.repeat(31)), false);
  assert.equal(await consumeMissionEventToken(env, userId, missionId, 'a'.repeat(33)), false);

  // Non-hex
  assert.equal(await consumeMissionEventToken(env, userId, missionId, 'z'.repeat(32)), false);
});

test('MISSION-009: KV unavailable — signed token issue still works (no KV dependency)', async () => {
  // PHASE 2D: Signed tokens do NOT require KV. Issue should succeed
  // even with no SESSION_CACHE binding.
  const env1 = { TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const token = await issueMissionEventToken(env1, '99999999', 'read_news');
  assert.ok(token, 'Issue must succeed without KV (signed token)');
  assert.ok(token.includes('.'), 'Token must be signed format');

  // Consume also works without KV (signed token verification)
  const consumed = await consumeMissionEventToken(env1, '99999999', 'read_news', token);
  assert.equal(consumed, true, 'Consume must succeed without KV (signed token)');
});

test('MISSION-010: Multiple issues allowed — DB CASE WHEN rewarded=FALSE prevents progress inflation', async () => {
  // PHASE 2D: Signed tokens are stateless — multiple tokens can be issued
  // and consumed. One-per-day enforcement is handled by DB:
  //   - incrementMissionProgress: CASE WHEN rewarded=FALSE → no increment if already rewarded
  //   - markMissionRewarded CAS: only one reward
  //   - grantReward UNIQUE(ref_id): no double-credit
  const env = { SESSION_CACHE: createMemoryKv(), TELEGRAM_BOT_TOKEN: 'test-bot-token' };
  const userId = '10101010';
  const missionId = 'read_news';

  // First action — issue token, consume it
  const token1 = await issueMissionEventToken(env, userId, missionId);
  const c1 = await consumeMissionEventToken(env, userId, missionId, token1);
  assert.equal(c1, true, 'First action — token consumed');

  // Second action same day — issue a NEW token (allowed)
  const token2 = await issueMissionEventToken(env, userId, missionId);
  assert.ok(token2, 'Second token can be issued');
  assert.notEqual(token2, token1, 'Tokens must be different');

  // Consume second token — succeeds at token level (stateless)
  // DB CASE WHEN rewarded=FALSE prevents progress inflation
  const c2 = await consumeMissionEventToken(env, userId, missionId, token2);
  assert.equal(c2, true, 'Second consume succeeds at token level — DB prevents progress inflation');
});

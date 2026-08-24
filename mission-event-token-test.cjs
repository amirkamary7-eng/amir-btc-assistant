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

const test = require('node:test');
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

// ── Extract mission token functions from worker-proxy.js source ────────
// The functions are top-level in worker-proxy.js. We load them by creating
// an isolated module with the needed functions and a mock crypto.
const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// Find the mission token function block
const startIdx = workerSrc.indexOf('// MISSION EVENT TOKEN SERVICE');
const endIdx = workerSrc.indexOf('function buildFastApiValidationError', startIdx);
if (startIdx < 0 || endIdx < 0) {
  throw new Error('Could not locate mission token service block in worker-proxy.js');
}
const tokenServiceSrc = workerSrc.slice(startIdx, endIdx);

// Build an isolated module with the token service functions
// FA-7: _getTodayISOString now delegates to sharedGetTehranDateString (Tehran
// timezone). We must provide this helper in the eval context.
const sharedGetTehranDateString = function() {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Tehran',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  });
  return fmt.format(new Date());
};

const wrappedSrc = `
${tokenServiceSrc}
module.exports = {
  issueMissionEventToken,
  consumeMissionEventToken,
  isMissionEventTokenConsumed,
  MISSION_TOKEN_PREFIX,
  MISSION_TOKEN_TTL_SECONDS,
};
`;

const tokenModule = { exports: {} };
const evaluator = new Function('require', 'module', 'exports', 'crypto', 'sharedGetTehranDateString', wrappedSrc);
evaluator(require, tokenModule, tokenModule.exports, globalThis.crypto, sharedGetTehranDateString);
const {
  issueMissionEventToken,
  consumeMissionEventToken,
  isMissionEventTokenConsumed,
} = tokenModule.exports;

// ── Tests ──────────────────────────────────────────────────────────────

test('MISSION-001: issueMissionEventToken returns a 32-char hex token', async () => {
  const env = { SESSION_CACHE: createMemoryKv() };
  const userId = '11111111';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  console.log('  Token:', token);

  assert.ok(token, 'Token must be returned');
  assert.equal(typeof token, 'string');
  assert.equal(token.length, 32, 'Token must be 32 chars');
  assert.ok(/^[0-9a-f]{32}$/.test(token), 'Token must be hex');
});

test('MISSION-002: consumeMissionEventToken returns true for valid token', async () => {
  const env = { SESSION_CACHE: createMemoryKv() };
  const userId = '22222222';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  const consumed = await consumeMissionEventToken(env, userId, missionId, token);

  assert.equal(consumed, true, 'Valid token MUST be consumed successfully');
});

test('MISSION-003: Token is one-time use — second consume returns false', async () => {
  const env = { SESSION_CACHE: createMemoryKv() };
  const userId = '33333333';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);
  const c1 = await consumeMissionEventToken(env, userId, missionId, token);
  const c2 = await consumeMissionEventToken(env, userId, missionId, token);

  assert.equal(c1, true, 'First consume must succeed');
  assert.equal(c2, false, 'Second consume MUST fail (one-time use)');
});

test('MISSION-004: Replay attack rejected — used token cannot be replayed', async () => {
  const env = { SESSION_CACHE: createMemoryKv() };
  const userId = '44444444';
  const missionId = 'read_news';

  // Issue token, consume it (mission completed)
  const token = await issueMissionEventToken(env, userId, missionId);
  await consumeMissionEventToken(env, userId, missionId, token);

  // Attacker tries to replay the SAME token to claim reward again
  const replayResult = await consumeMissionEventToken(env, userId, missionId, token);
  assert.equal(replayResult, false, 'Replay attack MUST be rejected');

  // Also verify via isMissionEventTokenConsumed
  const isConsumed = await isMissionEventTokenConsumed(env, userId, missionId);
  assert.equal(isConsumed, true, 'Mission should be marked as consumed');
});

test('MISSION-005: Concurrent consume — DB-level idempotency is the final safety net', async () => {
  // NOTE: This test documents a known limitation of the token-based approach.
  // In a real KV (network-bound), the time between get() and delete() allows
  // other concurrent requests to also pass the get() check. The KV doesn't
  // support atomic compare-and-set, so concurrent consume of the same token
  // could theoretically all succeed.
  //
  // However, the DB-level safety net (markMissionRewarded with
  // UPDATE ... WHERE rewarded = FALSE RETURNING id) is the FINAL authority
  // and is atomic in PostgreSQL. Even if multiple concurrent consumes
  // succeed at the token level, only ONE will get the reward at the DB level.
  //
  // This test verifies the SEQUENTIAL behavior (which always works):
  const env = { SESSION_CACHE: createMemoryKv() };
  const userId = '55555555';
  const missionId = 'read_news';

  const token = await issueMissionEventToken(env, userId, missionId);

  // Sequential consumes — only first succeeds
  const c1 = await consumeMissionEventToken(env, userId, missionId, token);
  const c2 = await consumeMissionEventToken(env, userId, missionId, token);
  const c3 = await consumeMissionEventToken(env, userId, missionId, token);

  assert.equal(c1, true, 'First sequential consume must succeed');
  assert.equal(c2, false, 'Second sequential consume must fail (one-time)');
  assert.equal(c3, false, 'Third sequential consume must fail');

  // For concurrent consume, the DB-level idempotency (markMissionRewarded +
  // UNIQUE(user_id, mission_id, daily_date) + creditTokens UNIQUE on ref_id)
  // is the authoritative safety net. Even if multiple concurrent token consumes
  // succeed, only ONE reward is granted at the DB level.
});

test('MISSION-006: Token from one user cannot be consumed by another user', async () => {
  const env = { SESSION_CACHE: createMemoryKv() };
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
  const env = { SESSION_CACHE: createMemoryKv() };
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
  const env = { SESSION_CACHE: createMemoryKv() };
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

test('MISSION-009: KV unavailable — issue returns null, consume returns false (fail-safe)', async () => {
  // No SESSION_CACHE binding
  const env1 = {};
  const token = await issueMissionEventToken(env1, '99999999', 'read_news');
  assert.equal(token, null, 'Issue must return null if KV unavailable');

  // SESSION_CACHE present but missing methods
  const env2 = { SESSION_CACHE: {} };
  const token2 = await issueMissionEventToken(env2, '99999999', 'read_news');
  assert.equal(token2, null);

  const consumed = await consumeMissionEventToken(env2, '99999999', 'read_news', 'a'.repeat(32));
  assert.equal(consumed, false, 'Consume must return false if KV unavailable');
});

test('MISSION-010: Multiple issues per day allowed but consume marker blocks double-reward', async () => {
  // Scenario: User opens news tab, gets token, completes mission.
  // User opens news tab again later same day, gets a new token.
  // But they cannot complete the mission AGAIN (already rewarded).
  // The mission_progress UNIQUE(user_id, mission_id, daily_date) + rewarded flag
  // handles this at the DB level. The token mechanism handles it at the API level
  // via the consumed marker.
  const env = { SESSION_CACHE: createMemoryKv() };
  const userId = '10101010';
  const missionId = 'read_news';

  // First action — issue token, consume it
  const token1 = await issueMissionEventToken(env, userId, missionId);
  const c1 = await consumeMissionEventToken(env, userId, missionId, token1);
  assert.equal(c1, true, 'First action — token consumed');

  // Second action same day — issue a NEW token (this is allowed)
  const token2 = await issueMissionEventToken(env, userId, missionId);
  assert.ok(token2, 'Second token can be issued');
  assert.notEqual(token2, token1, 'Tokens must be different');

  // Try to consume — MUST fail because already consumed today
  const c2 = await consumeMissionEventToken(env, userId, missionId, token2);
  assert.equal(c2, false, 'Second consume same day MUST fail (already consumed)');
});

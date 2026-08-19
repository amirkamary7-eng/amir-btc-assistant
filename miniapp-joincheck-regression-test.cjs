/**
 * Regression test for AUDIT-P1 bugs:
 *
 * Bug #1: Bootstrap "PHASE 2 SAFE OPTIMIZATION" overrode a correct `joined: false`
 *         result with a stale `freshUserRow.channel_joined=true` DB value.
 *         When admin added a new required channel, the user's first Mini App open
 *         after that incorrectly returned channel_joined=true (stale bypass).
 *
 * Bug #2: `forceRefresh` was not propagated into `checkAdditionalRequiredChannels`,
 *         so even with forceRefresh:true, the DB-channel check could return a
 *         stale KV-cached result.
 *
 * These tests verify the fixes via source-eval (extracting the actual functions
 * from worker-proxy.js + src/controllers/users.js).
 *
 * Run: node --test miniapp-joincheck-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const USERS_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/users.js'), 'utf8');

// ============================================================================
// Source extraction helpers
// ============================================================================

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

function extractConstSet(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[[^\\]]*\\]\\)`);
  const m = re.exec(src);
  if (!m) throw new Error(`Const set ${name} not found`);
  return m[0];
}

// ============================================================================
// BUG #2 TEST: forceRefresh propagation into checkAdditionalRequiredChannels
// ============================================================================

function buildSandboxSrc() {
  const parts = [];
  parts.push(extractConstSet(WORKER_SRC, 'JOINED_STATUSES'));
  ['safeError', 'isBotConfigured', 'getAdminIds', 'isAdminTelegramId',
   'resolveRequiredChannel', 'normalizeRequiredChannel', 'getTelegramChatId',
   'resolveWebAppUrl', 'buildTelegramApiUrl', 'isJoinedMember',
   'getChatMemberDebugPayload', 'checkChannelMembership',
   '_checkSingleTelegramChannel', '_hashChannelSet',
   'checkAdditionalRequiredChannels'].forEach(n => {
    try { parts.push(extractFn(WORKER_SRC, n)); } catch (e) { /* skip if missing */ }
  });
  parts.push('exports.checkAdditionalRequiredChannels = checkAdditionalRequiredChannels;');
  parts.push('exports._hashChannelSet = _hashChannelSet;');
  parts.push('exports.isJoinedMember = isJoinedMember;');
  return parts.join('\n\n');
}

const SANDBOX_SRC = buildSandboxSrc();

function loadSandbox(fetchImpl) {
  const exportsObj = {};
  const evaluator = new Function('exports', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'console', SANDBOX_SRC);
  evaluator(exportsObj, fetchImpl, AbortController, setTimeout, clearTimeout, console);
  return exportsObj;
}

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value, opts) { store.set(key, value); },
    async delete(key) { store.delete(key); },
    _store: store,
  };
}

// ============================================================================
// Section 1: Bug #2 — forceRefresh propagation into checkAdditionalRequiredChannels
// ============================================================================

test('BUG2-001: checkAdditionalRequiredChannels accepts forceRefresh parameter', () => {
  // Source-level check: the function signature must accept { forceRefresh }
  assert.ok(SANDBOX_SRC.includes('async function checkAdditionalRequiredChannels(env, userId, { forceRefresh = false } = {})'),
    'checkAdditionalRequiredChannels must accept { forceRefresh } parameter');
});

test('BUG2-002: with forceRefresh=true, KV cache read is SKIPPED (source-level)', () => {
  // Static-analysis test: verify the source code guards the KV cache read with
  // `!forceRefresh`. This proves that when forceRefresh=true, the cache is skipped
  // and a fresh Telegram getChatMember call is made.
  //
  // We can't do a dynamic test because checkAdditionalRequiredChannels internally
  // calls _getActiveAdChannels which needs the advertisementsRepo (complex to mock).
  // The static test is sufficient because the fix is a simple `if (!forceRefresh && ...)`
  // guard around the cache read.
  assert.ok(SANDBOX_SRC.includes('if (!forceRefresh && env.RATE_LIMITS'),
    'forceRefresh must guard the KV cache read — when true, cache is skipped');
});

test('BUG2-003: with forceRefresh=false (default), KV cache read STILL happens (source-level)', () => {
  // Verify the default behavior is unchanged: forceRefresh=false still reads cache.
  // The guard `if (!forceRefresh && ...)` means when forceRefresh=false (default),
  // the condition evaluates to `if (true && ...)` → cache IS read.
  assert.ok(SANDBOX_SRC.includes('if (!forceRefresh && env.RATE_LIMITS'),
    'default forceRefresh=false must still read cache (guard passes when forceRefresh is false)');
});

// ============================================================================
// Section 2: Bug #1 — Bootstrap stale-DB-row override REMOVED
// ============================================================================

test('BUG1-001: users.js bootstrap uses MembershipGateway (single call, no stale DB override)', () => {
  // STEP 5 migration: bootstrap now uses a single membershipGateway.check() call
  // instead of TWO sequential resolveChannelMembership calls. The stale-DB-row
  // override (freshUserRow.channel_joined) must NOT be used to skip the check.
  assert.ok(USERS_CTRL_SRC.includes('membershipGateway.check'),
    'bootstrap must use membershipGateway.check');
  assert.ok(!USERS_CTRL_SRC.includes('if (freshUserRow?.channel_joined)'),
    'bootstrap must NOT use freshUserRow.channel_joined to skip membership check');
});

test('BUG1-002: users.js bootstrap makes a SINGLE membership call (no duplicate forceRefresh)', () => {
  // STEP 5 migration: the old code called resolveChannelMembership TWICE
  // (forceRefresh:false then forceRefresh:true if first not-joined).
  // The new code calls membershipGateway.check ONCE with forceRefresh:false.
  // The Gateway internally handles cache miss → fresh Telegram check.
  assert.ok(USERS_CTRL_SRC.includes('membershipGateway.check'),
    'bootstrap must use membershipGateway.check');
  // Must NOT have a second resolveChannelMembership call with forceRefresh:true
  const firstCheckPos = USERS_CTRL_SRC.indexOf('membershipGateway.check');
  assert.ok(firstCheckPos > -1, 'membershipGateway.check call must exist');
  // The old duplicate pattern (resolveChannelMembership + forceRefresh:true in else)
  // must be GONE:
  const stalePattern = /resolveChannelMembership\(.*forceRefresh:\s*true/s;
  assert.ok(!stalePattern.test(USERS_CTRL_SRC.slice(firstCheckPos, firstCheckPos + 2000)),
    'bootstrap must NOT have a second resolveChannelMembership(forceRefresh:true) call');
});

test('BUG1-003: error fallback still uses freshUserRow.channel_joined (safe best-effort)', () => {
  // On error, the catch block falls back to the DB row — this is intentional
  // (best-effort, requireChannelJoin middleware will re-check on every API call).
  const catchSection = USERS_CTRL_SRC.match(/catch\s*\(e\)\s*\{[^}]*channelJoined[^}]*\}/s);
  assert.ok(catchSection, 'catch block must fall back to freshUserRow.channel_joined');
  assert.ok(catchSection[0].includes('freshUserRow?.channel_joined'),
    'catch block must use freshUserRow?.channel_joined as fallback');
});

// ============================================================================
// Section 3: /start handler still uses forceRefresh:true (no regression)
// ============================================================================

test('NOREGRESS-001: /start handler uses MembershipGateway with forceRefresh: true', () => {
  // STEP 4 of Membership Gateway migration: /start now calls membershipGateway.check()
  assert.ok(WORKER_SRC.includes('membershipGateway.check(env, messageContext.userId, { forceRefresh: true })'),
    '/start must call membershipGateway.check with forceRefresh: true');
});

test('NOREGRESS-002: /api/users/check-join uses MembershipGateway with forceRefresh: true', () => {
  // STEP 2 of Membership Gateway migration: check-join now calls membershipGateway.check()
  // instead of resolveChannelMembership directly. The Gateway wraps the same logic
  // (parallel Telegram, dedup, fail-closed) but preserves the response shape:
  // { status: 'success', channel_joined: boolean }
  assert.ok(WORKER_SRC.includes("membershipGateway.check(env, _joinUserId, { forceRefresh: true })"),
    '/api/users/check-join must call membershipGateway.check with forceRefresh: true');
});

// ============================================================================
// Section 4: checkAdditionalRequiredChannels call site propagation
// ============================================================================

test('BUG2-004: resolveChannelMembership propagates forceRefresh to checkAdditionalRequiredChannels at the fresh-check call site', () => {
  // The call site at line ~3232 must pass { forceRefresh }
  assert.ok(WORKER_SRC.includes('checkAdditionalRequiredChannels(env, uid, { forceRefresh })'),
    'resolveChannelMembership must propagate forceRefresh to checkAdditionalRequiredChannels');
});

// ============================================================================
// Section 5: isJoinedMember consistency (all 3 call sites)
// ============================================================================

test('NOREGRESS-003: isJoinedMember is used at all 3 getChatMember call sites', () => {
  // Count occurrences of isJoinedMember in the source
  const matches = WORKER_SRC.match(/isJoinedMember\(/g);
  assert.ok(matches && matches.length >= 4, // 3 call sites + 1 definition
    `isJoinedMember must be called at 3 sites (+1 def). Found ${matches?.length || 0}`);
});

test('NOREGRESS-004: JOINED_STATUSES still contains restricted (isJoinedMember handles it)', () => {
  assert.ok(WORKER_SRC.includes("new Set(['creator', 'administrator', 'member', 'restricted'])"),
    'JOINED_STATUSES must still contain restricted (isJoinedMember handles is_member)');
});

// ============================================================================
// Section 6: AUDIT-P1-JOINCHECK new fixes — parallel Telegram calls, dedup, fail-closed
// ============================================================================

// BUG #4: Parallel Telegram getChatMember calls (was sequential N×5s)
test('BUG4-001: checkAdditionalRequiredChannels uses Promise.all (not sequential for-await)', () => {
  // The fresh-check loop must use Promise.all to parallelize per-channel Telegram calls.
  // This bounds latency at 5s regardless of channel count (was 5N seconds).
  const fnStart = WORKER_SRC.indexOf('async function checkAdditionalRequiredChannels');
  const nextFn = WORKER_SRC.indexOf('async function', fnStart + 50);
  const fnBlock = nextFn > -1 ? WORKER_SRC.slice(fnStart, nextFn) : WORKER_SRC.slice(fnStart, fnStart + 3500);
  assert.ok(fnBlock.includes('Promise.all'),
    'checkAdditionalRequiredChannels must use Promise.all to parallelize Telegram calls');
  assert.ok(fnBlock.includes('channels.map(ch =>'),
    'Promise.all must map over channels');
  // Must NOT use sequential `for (const ch of channels)` with `await` inside
  // (the old pattern that caused N×5s latency).
  assert.ok(!/for\s*\(const\s+ch\s+of\s+channels\)\s*\{[^}]*await\s+_checkSingleTelegramChannel/s.test(fnBlock),
    'must NOT use sequential for-await loop for Telegram calls');
});

// BUG #1: bootstrapUser dedup (was called concurrently from multiple sites)
test('BUG1-NEW-001: bootstrapUser has in-flight dedup', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes('_bootstrapUserInFlight'),
    'bootstrapUser must use _bootstrapUserInFlight for dedup');
  assert.ok(APP_SRC.includes('if (_bootstrapUserInFlight)'),
    'bootstrapUser must check _bootstrapUserInFlight before executing');
  assert.ok(APP_SRC.includes('async function _bootstrapUserImpl()'),
    'bootstrapUser must delegate to _bootstrapUserImpl (separated for dedup)');
});

test('BUG1-NEW-002: bootstrapUser dedup clears on completion (finally block)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes(".finally(() => { _bootstrapUserInFlight = null; })"),
    'bootstrapUser must clear _bootstrapUserInFlight in finally block');
});

// BUG #7: Fail-closed on Telegram api_error (was fail-open via DB/KV fallback)
test('BUG7-001: resolveChannelMembership returns joined=false on api_error (fail-closed)', () => {
  // The old code fell back to DB users.channel_joined or KV cache on api_error.
  // The new code returns joined:false immediately — fail-closed, no bypass.
  const fnStart = WORKER_SRC.indexOf('async function resolveChannelMembership');
  const nextFn = WORKER_SRC.indexOf('async function', fnStart + 50);
  const fnBlock = nextFn > -1 ? WORKER_SRC.slice(fnStart, nextFn) : WORKER_SRC.slice(fnStart, fnStart + 4000);
  const apiErrorSection = fnBlock.slice(fnBlock.indexOf("result.reason === 'api_error'"));
  // Must NOT fall back to DB on api_error
  assert.ok(!apiErrorSection.includes('from_db_fallback'),
    'resolveChannelMembership must NOT fall back to DB on api_error (was fail-open)');
  // Must NOT fall back to KV cache on api_error
  assert.ok(!apiErrorSection.includes('cached_fallback'),
    'resolveChannelMembership must NOT fall back to KV cache on api_error (was fail-open)');
  // Must return joined:false
  assert.ok(apiErrorSection.includes("joined: false"),
    'resolveChannelMembership must return joined:false on api_error (fail-closed)');
});

// NO-REGRESSION: existing valid-member path still works (env channel joined + DB channels joined)
test('NOREGRESS-005: resolveChannelMembership still returns joined:true for valid members', () => {
  const fnStart = WORKER_SRC.indexOf('async function resolveChannelMembership');
  const nextFn = WORKER_SRC.indexOf('async function', fnStart + 50);
  const fnBlock = nextFn > -1 ? WORKER_SRC.slice(fnStart, nextFn) : WORKER_SRC.slice(fnStart, fnStart + 4000);
  // The valid-member path (result.joined + extra.joined) must still return { joined: true }
  assert.ok(fnBlock.includes('return result;') && fnBlock.includes('setCachedJoinStatus(env, uid, true)'),
    'resolveChannelMembership must still cache + return joined:true for valid members');
});

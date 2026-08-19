/**
 * Regression test for /start + Join Check code paths.
 *
 * This test extracts the ACTUAL functions from worker-proxy.js via source-eval
 * (no mocking of the function bodies — only `fetch` is mocked for Telegram API
 * calls). It locks in the correct behavior for:
 *
 *   1. /start command parsing (`/start`, `/start ref_xxx`, `/start@Bot`, etc.)
 *   2. Referral parameter extraction
 *   3. /start reply payload construction (member vs non-member, with/without referral)
 *   4. Join Check status mapping for ALL Telegram getChatMember statuses
 *   5. REGRESSION FIX: `restricted` + `is_member: false` → joined=false
 *      (was incorrectly joined=true before the fix)
 *
 * Run: node --test start-join-check-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');

// ============================================================================
// Source extraction helpers
// ============================================================================

/** Extract a function declaration's full source (including body) by name. */
function extractFn(src, name) {
  const re = new RegExp(`(?:async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`Function ${name} not found in worker-proxy.js`);
  const start = m.index;
  // Step 1: find the end of the parameter list (matching closing paren).
  // This correctly handles destructuring params like `{ cacheBust = true } = {}`.
  let i = start;
  while (i < src.length && src[i] !== '(') i++;
  if (i >= src.length) throw new Error(`Could not find param list start for ${name}`);
  let parenDepth = 0, inStrP = false, strChP = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStrP) {
      if (c === '\\') { i++; continue; }
      if (c === strChP) inStrP = false;
    } else {
      if (c === '"' || c === "'" || c === '`') { inStrP = true; strChP = c; }
      else if (c === '(') parenDepth++;
      else if (c === ')') { parenDepth--; if (parenDepth === 0) { i++; break; } }
    }
  }
  // Step 2: find the body's opening brace (skip whitespace between `)` and `{`).
  while (i < src.length && src[i] !== '{') i++;
  if (i >= src.length) throw new Error(`Could not find body start for ${name}`);
  // Step 3: find the body's matching closing brace.
  let depth = 0, inStr = false, strCh = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inStr) {
      if (c === '\\') { i++; continue; }
      if (c === strCh) inStr = false;
    } else {
      if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; }
      else if (c === '{') depth++;
      else if (c === '}') { depth--; if (depth === 0) return src.slice(start, i + 1); }
    }
  }
  throw new Error(`Could not find end of ${name}`);
}

/** Extract a `const X = new Set([...])` declaration. */
function extractConstSet(src, name) {
  const re = new RegExp(`const\\s+${name}\\s*=\\s*new Set\\(\\[[^\\]]*\\]\\)`);
  const m = re.exec(src);
  if (!m) throw new Error(`Const set ${name} not found`);
  return m[0];
}

// ============================================================================
// Build sandboxed module (all functions extracted from REAL worker-proxy.js)
// ============================================================================

function buildSandboxSrc() {
  const parts = [];
  // Constants
  parts.push(extractConstSet(WORKER_SRC, 'JOINED_STATUSES'));
  // Pure helpers (used by syncMenuButton + getChatMemberDebugPayload)
  parts.push(extractFn(WORKER_SRC, 'safeError'));
  parts.push(extractFn(WORKER_SRC, 'isBotConfigured'));
  parts.push(extractFn(WORKER_SRC, 'getAdminIds'));
  parts.push(extractFn(WORKER_SRC, 'isAdminTelegramId'));
  parts.push(extractFn(WORKER_SRC, 'resolveRequiredChannel'));
  parts.push(extractFn(WORKER_SRC, 'normalizeRequiredChannel'));
  parts.push(extractFn(WORKER_SRC, 'getTelegramChatId'));
  parts.push(extractFn(WORKER_SRC, 'resolveWebAppUrl'));
  parts.push(extractFn(WORKER_SRC, 'buildTelegramApiUrl'));
  // /start helpers
  parts.push(extractFn(WORKER_SRC, 'isTelegramStartCommand'));
  parts.push(extractFn(WORKER_SRC, 'extractStartParam'));
  parts.push(extractFn(WORKER_SRC, 'extractTelegramMessageContext'));
  parts.push(extractFn(WORKER_SRC, 'buildStartReplyPayload'));
  // Join check helpers
  parts.push(extractFn(WORKER_SRC, 'getChatMemberDebugPayload'));
  parts.push(extractFn(WORKER_SRC, 'checkChannelMembership'));
  parts.push(extractFn(WORKER_SRC, '_checkSingleTelegramChannel'));
  parts.push(extractFn(WORKER_SRC, '_hashChannelSet'));
  // syncMenuButton (uses fetch + buildTelegramApiUrl + resolveWebAppUrl + safeError)
  parts.push(extractFn(WORKER_SRC, 'syncMenuButton'));
  // isJoinedMember (added by audit/start-join-check fix)
  parts.push(extractFn(WORKER_SRC, 'isJoinedMember'));
  // Exports
  parts.push('exports.isTelegramStartCommand = isTelegramStartCommand;');
  parts.push('exports.extractStartParam = extractStartParam;');
  parts.push('exports.extractTelegramMessageContext = extractTelegramMessageContext;');
  parts.push('exports.buildStartReplyPayload = buildStartReplyPayload;');
  parts.push('exports.getChatMemberDebugPayload = getChatMemberDebugPayload;');
  parts.push('exports.checkChannelMembership = checkChannelMembership;');
  parts.push('exports._checkSingleTelegramChannel = _checkSingleTelegramChannel;');
  parts.push('exports._hashChannelSet = _hashChannelSet;');
  parts.push('exports.syncMenuButton = syncMenuButton;');
  parts.push('exports.isJoinedMember = isJoinedMember;');
  parts.push('exports.JOINED_STATUSES = JOINED_STATUSES;');
  return parts.join('\n\n');
}

const SANDBOX_SRC = buildSandboxSrc();

/** Load sandbox with a custom fetch implementation. */
function loadSandbox(fetchImpl) {
  const exportsObj = {};
  const evaluator = new Function(
    'exports', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'console',
    SANDBOX_SRC,
  );
  evaluator(exportsObj, fetchImpl, AbortController, setTimeout, clearTimeout, console);
  return exportsObj;
}

// ============================================================================
// Mock factories
// ============================================================================

/** Build a mock fetch that returns a fixed Telegram getChatMember response.
 *  NOTE: Telegram API URLs are `https://api.telegram.org/bot{TOKEN}/{method}`,
 *  so we match on the method name (e.g. `/getChatMember`), NOT the full path.
 */
function makeMockFetch(opts = {}) {
  const calls = [];
  const getChatMemberResponse = opts.getChatMemberResponse ?? {
    ok: true,
    result: { status: 'member', user: { id: 123456 } },
  };
  const setChatMenuButtonResponse = opts.setChatMenuButtonResponse ?? { ok: true, result: true };
  const sendMessageResponse = opts.sendMessageResponse ?? { ok: true, result: { message_id: 1 } };
  const fetchImpl = async (url, reqOpts) => {
    const urlStr = String(url);
    calls.push({ url: urlStr, method: reqOpts?.method || 'GET', body: reqOpts?.body });
    // Match on /{methodName} to avoid false-matching the bot token segment.
    if (urlStr.includes('/getChatMember')) {
      return { ok: true, json: async () => getChatMemberResponse };
    }
    if (urlStr.includes('/setChatMenuButton')) {
      return { ok: true, json: async () => setChatMenuButtonResponse };
    }
    if (urlStr.includes('/sendMessage')) {
      return { ok: true, json: async () => sendMessageResponse };
    }
    // Default: return empty success
    return { ok: true, json: async () => ({ ok: true, result: {} }) };
  };
  fetchImpl.calls = calls;
  return fetchImpl;
}

/** Standard test env (non-admin user, configured bot, env channel set). */
function makeEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'test_channel',
    ADMIN_TELEGRAM_ID: '999999', // different from test userId (123456) so admin bypass doesn't fire
    BOT_USERNAME: 'TestBot',
    WEBAPP_URL: 'https://example.com/app',
    ...overrides,
  };
}

// ============================================================================
// Section 1: /start command parsing (pure functions, no fetch needed)
// ============================================================================

test('START-001: isTelegramStartCommand matches bare /start', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.isTelegramStartCommand('/start'), true);
  assert.equal(mod.isTelegramStartCommand('  /start  '), true);
});

test('START-002: isTelegramStartCommand matches /start ref_xxx', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.isTelegramStartCommand('/start ref_12345'), true);
  assert.equal(mod.isTelegramStartCommand('/start ref_abc'), true);
});

test('START-003: isTelegramStartCommand matches /start@BotUsername', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.isTelegramStartCommand('/start@TestBot'), true);
  assert.equal(mod.isTelegramStartCommand('/start@TestBot ref_123'), true);
});

test('START-004: isTelegramStartCommand rejects non-start commands', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.isTelegramStartCommand('/help'), false);
  assert.equal(mod.isTelegramStartCommand('/settings'), false);
  assert.equal(mod.isTelegramStartCommand('start'), false); // no leading slash
  assert.equal(mod.isTelegramStartCommand('/startother'), false); // different command
  assert.equal(mod.isTelegramStartCommand('/startx'), false); // not followed by space/end
  assert.equal(mod.isTelegramStartCommand(''), false);
  assert.equal(mod.isTelegramStartCommand(null), false);
  assert.equal(mod.isTelegramStartCommand(undefined), false);
});

test('START-005: extractStartParam returns ref token when present', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.extractStartParam('/start ref_12345'), 'ref_12345');
  assert.equal(mod.extractStartParam('/start@Bot ref_abc'), 'ref_abc');
  assert.equal(mod.extractStartParam('  /start ref_xyz  '), 'ref_xyz');
});

test('START-006: extractStartParam returns null when no ref token', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.extractStartParam('/start'), null);
  assert.equal(mod.extractStartParam('/start@Bot'), null);
  assert.equal(mod.extractStartParam('/start hello'), null); // non-ref_ prefix
  assert.equal(mod.extractStartParam(''), null);
  assert.equal(mod.extractStartParam(null), null);
});

test('START-007: extractTelegramMessageContext parses valid update', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  const ctx = mod.extractTelegramMessageContext({
    message: {
      from: { id: 123456 },
      chat: { id: 123456 },
      text: '/start ref_abc',
    },
  });
  assert.equal(ctx.userId, '123456');
  assert.equal(ctx.chatId, 123456);
  assert.equal(ctx.text, '/start ref_abc');
  assert.equal(ctx.startParam, 'ref_abc');
});

test('START-008: extractTelegramMessageContext handles missing fields', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  assert.equal(mod.extractTelegramMessageContext({}), null);
  assert.equal(mod.extractTelegramMessageContext({ message: {} }), null);
  assert.equal(mod.extractTelegramMessageContext({ message: { from: {} } }), null);
  assert.equal(mod.extractTelegramMessageContext(null), null);
});

test('START-009: extractTelegramMessageContext uses userId as chatId when chat missing', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  const ctx = mod.extractTelegramMessageContext({
    message: { from: { id: 789 }, text: '/start' },
  });
  assert.equal(ctx.userId, '789');
  assert.equal(ctx.chatId, 789); // falls back to userId
});

// ============================================================================
// Section 2: /start reply payload construction
// ============================================================================

test('START-010: buildStartReplyPayload for NON-member shows join button', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  const env = makeEnv();
  const payload = mod.buildStartReplyPayload(env, 123456, false, null);
  assert.equal(payload.chat_id, 123456);
  assert.ok(payload.text.includes('کانال'), `text should mention channel, got: ${payload.text}`);
  // Inline keyboard: [channel url button] + [check_join callback button]
  const kb = payload.reply_markup.inline_keyboard;
  assert.equal(kb.length, 2);
  assert.equal(kb[0][0].text, '📢 عضویت در کانال');
  assert.ok(kb[0][0].url.includes('t.me/test_channel'));
  assert.equal(kb[1][0].text, '✅ عضو شدم — ورود به اپلیکیشن');
  assert.equal(kb[1][0].callback_data, 'check_join');
});

test('START-011: buildStartReplyPayload for member shows Mini App button', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  const env = makeEnv();
  const payload = mod.buildStartReplyPayload(env, 123456, true, null);
  assert.equal(payload.chat_id, 123456);
  assert.ok(payload.text.includes('خوش برگشتی'));
  const btn = payload.reply_markup.inline_keyboard[0][0];
  assert.equal(btn.text, '🚀 باز کردن مینی‌اپ');
  assert.ok(btn.web_app.url, 'web_app.url should be set');
});

test('START-012: buildStartReplyPayload for member with referral appends startapp', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  const env = makeEnv();
  const payload = mod.buildStartReplyPayload(env, 123456, true, 'ref_12345');
  const btn = payload.reply_markup.inline_keyboard[0][0];
  assert.ok(btn.web_app.url.includes('startapp=ref_12345'), `URL should contain startapp=ref_12345, got: ${btn.web_app.url}`);
});

test('START-013: buildStartReplyPayload for member without referral has no startapp', () => {
  const mod = loadSandbox(() => Promise.resolve({ ok: true, json: () => ({}) }));
  const env = makeEnv();
  const payload = mod.buildStartReplyPayload(env, 123456, true, null);
  const btn = payload.reply_markup.inline_keyboard[0][0];
  assert.ok(!btn.web_app.url.includes('startapp='), `URL should NOT contain startapp=, got: ${btn.web_app.url}`);
});

// ============================================================================
// Section 3: Join Check status mapping — ALL Telegram getChatMember statuses
// ============================================================================

async function testStatus(status, isMember, expectedJoined) {
  const tgResponse = { ok: true, result: { status, user: { id: 123456 } } };
  if (status === 'restricted') {
    tgResponse.result.is_member = isMember; // true/false/undefined
  }
  const fetchImpl = makeMockFetch({ getChatMemberResponse: tgResponse });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const payload = await mod.getChatMemberDebugPayload('123456', env);
  return payload;
}

test('JOIN-001: getChatMember status=member → joined=true', async () => {
  const p = await testStatus('member', undefined, true);
  assert.equal(p.joined, true, 'member should be joined=true');
});

test('JOIN-002: getChatMember status=administrator → joined=true', async () => {
  const p = await testStatus('administrator', undefined, true);
  assert.equal(p.joined, true, 'administrator should be joined=true');
});

test('JOIN-003: getChatMember status=creator → joined=true', async () => {
  const p = await testStatus('creator', undefined, true);
  assert.equal(p.joined, true, 'creator should be joined=true');
});

test('JOIN-004: getChatMember status=left → joined=false', async () => {
  const p = await testStatus('left', undefined, false);
  assert.equal(p.joined, false, 'left should be joined=false');
});

test('JOIN-005: getChatMember status=kicked → joined=false', async () => {
  const p = await testStatus('kicked', undefined, false);
  assert.equal(p.joined, false, 'kicked should be joined=false');
});

test('JOIN-006: getChatMember status=restricted + is_member=true → joined=true', async () => {
  const p = await testStatus('restricted', true, true);
  assert.equal(p.joined, true, 'restricted+is_member=true should be joined=true');
});

test('JOIN-007: getChatMember status=restricted + is_member=undefined → joined=true (safe default)', async () => {
  // When is_member is not present in the response (older Telegram API versions),
  // we conservatively treat restricted as joined (backward compat).
  const p = await testStatus('restricted', undefined, true);
  assert.equal(p.joined, true, 'restricted+is_member=undefined should be joined=true (safe default)');
});

// ============================================================================
// Section 4: REGRESSION FIX — the bug that was fixed
// ============================================================================

test('JOIN-REG-001 (REGRESSION FIX): restricted + is_member=false → joined=false', async () => {
  // BEFORE FIX: returned joined=true (BUG — user is restricted AND has LEFT the channel)
  // AFTER FIX:  returns joined=false (correct — user is not a member)
  const p = await testStatus('restricted', false, false);
  assert.equal(p.joined, false, 'REGRESSION: restricted+is_member=false MUST be joined=false. If this fails, the bug has regressed.');
});

test('JOIN-REG-002 (REGRESSION FIX): checkChannelMembership restricted + is_member=false → joined=false', async () => {
  // Verify the bug fix also covers checkChannelMembership (the wrapper around getChatMemberDebugPayload)
  const tgResponse = {
    ok: true,
    result: { status: 'restricted', is_member: false, user: { id: 123456 } },
  };
  const fetchImpl = makeMockFetch({ getChatMemberResponse: tgResponse });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false, 'REGRESSION: checkChannelMembership restricted+is_member=false MUST be joined=false');
});

test('JOIN-REG-003 (REGRESSION FIX): _checkSingleTelegramChannel restricted + is_member=false → joined=false', async () => {
  // Verify the bug fix also covers _checkSingleTelegramChannel (used for admin-configured DB channels)
  const tgResponse = {
    ok: true,
    result: { status: 'restricted', is_member: false, user: { id: 123456 } },
  };
  const fetchImpl = makeMockFetch({ getChatMemberResponse: tgResponse });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod._checkSingleTelegramChannel(env, '@test_channel', '123456');
  assert.equal(result.joined, false, 'REGRESSION: _checkSingleTelegramChannel restricted+is_member=false MUST be joined=false');
});

// ============================================================================
// Section 5: Error response handling
// ============================================================================

test('JOIN-008: Telegram error "user not found" → joined=false, reason=not_member', async () => {
  const fetchImpl = makeMockFetch({
    getChatMemberResponse: { ok: false, description: 'Bad Request: user not found' },
  });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'not_member');
});

test('JOIN-009: Telegram error "chat not found" → joined=false, reason=channel_not_found', async () => {
  const fetchImpl = makeMockFetch({
    getChatMemberResponse: { ok: false, description: 'Bad Request: chat not found' },
  });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'channel_not_found');
});

test('JOIN-010: Telegram error "bot is not a member" → joined=false, reason=bot_not_in_channel', async () => {
  // REGRESSION FIX: Previously, this returned reason='not_member' because the
  // error string 'bot is not a member of the channel chat' CONTAINS 'not a member'
  // as a substring, and the not_member check came BEFORE the bot_not_in_channel
  // check. The fix reorders the checks so bot_not_in_channel is matched first.
  const fetchImpl = makeMockFetch({
    getChatMemberResponse: { ok: false, description: 'Bad Request: bot is not a member of the channel chat' },
  });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'bot_not_in_channel', `expected bot_not_in_channel, got ${result.reason}`);
});

test('JOIN-010b: Telegram error "user is not a member" (distinct from bot) → reason=not_member', async () => {
  // Verify the reordering didn't break the not_member case for actual "user is not a member" errors.
  const fetchImpl = makeMockFetch({
    getChatMemberResponse: { ok: false, description: 'Bad Request: user is not a member of the channel chat' },
  });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'not_member');
});

test('JOIN-010c: Telegram error "need administrator" → reason=bot_not_in_channel', async () => {
  // Bot lacks admin privileges to read channel members.
  const fetchImpl = makeMockFetch({
    getChatMemberResponse: { ok: false, description: 'Bad Request: need administrator rights' },
  });
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'bot_not_in_channel');
});

// ============================================================================
// Section 5b: isJoinedMember direct unit tests (the helper introduced by the fix)
// ============================================================================

test('HELPER-001: isJoinedMember(null) → false', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember(null), false);
  assert.equal(mod.isJoinedMember(undefined), false);
});

test('HELPER-002: isJoinedMember member/administrator/creator → true', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember({ status: 'member' }), true);
  assert.equal(mod.isJoinedMember({ status: 'administrator' }), true);
  assert.equal(mod.isJoinedMember({ status: 'creator' }), true);
});

test('HELPER-003: isJoinedMember left/kicked → false', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember({ status: 'left' }), false);
  assert.equal(mod.isJoinedMember({ status: 'kicked' }), false);
});

test('HELPER-004: isJoinedMember restricted + is_member=true → true', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember({ status: 'restricted', is_member: true }), true);
});

test('HELPER-005 (REGRESSION): isJoinedMember restricted + is_member=false → false', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember({ status: 'restricted', is_member: false }), false);
});

test('HELPER-006: isJoinedMember restricted + is_member undefined → true (safe default)', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember({ status: 'restricted' }), true);
  assert.equal(mod.isJoinedMember({ status: 'restricted', is_member: undefined }), true);
});

test('HELPER-007: isJoinedMember unknown status → false', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod.isJoinedMember({ status: 'unknown' }), false);
  assert.equal(mod.isJoinedMember({ status: '' }), false);
  assert.equal(mod.isJoinedMember({}), false);
});

// ============================================================================
// Section 6: Edge cases — guest user, admin bypass, bot not configured
// ============================================================================

test('JOIN-011: Telegram fetch throws → joined=false, reason=api_error', async () => {
  const fetchImpl = async () => { throw new Error('Network timeout'); };
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'api_error');
});

test('JOIN-012: guest userId → joined=false, reason=guest_user', async () => {
  const mod = loadSandbox(makeMockFetch());
  const env = makeEnv();
  const result = await mod.checkChannelMembership('guest_abc', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'guest_user');
});

test('JOIN-013: admin userId → joined=true, admin=true (admin bypass)', async () => {
  const mod = loadSandbox(makeMockFetch());
  const env = makeEnv({ ADMIN_TELEGRAM_ID: '123456' }); // user IS the admin
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, true);
  assert.equal(result.admin, true);
});

test('JOIN-014: bot not configured → joined=false, reason=bot_not_configured', async () => {
  const mod = loadSandbox(makeMockFetch());
  const env = makeEnv({ TELEGRAM_BOT_TOKEN: '' });
  const result = await mod.checkChannelMembership('123456', env);
  assert.equal(result.joined, false);
  assert.equal(result.reason, 'bot_not_configured');
});

// ============================================================================
// Section 7: syncMenuButton payload verification
// ============================================================================

test('START-014: syncMenuButton calls setChatMenuButton with web_app menu button', async () => {
  const fetchImpl = makeMockFetch();
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  await mod.syncMenuButton(env);
  // Find the setChatMenuButton call
  const menuCall = fetchImpl.calls.find(c => c.url.includes('setChatMenuButton'));
  assert.ok(menuCall, 'syncMenuButton should call setChatMenuButton');
  const body = JSON.parse(menuCall.body);
  assert.equal(body.menu_button.type, 'web_app');
  assert.equal(body.menu_button.text, 'OPEN App');
  assert.ok(body.menu_button.web_app.url, 'web_app.url must be set');
  // Intentionally NO chat_id (sets DEFAULT for all users)
  assert.equal(body.chat_id, undefined, 'chat_id should be undefined (sets DEFAULT menu button)');
});

test('START-015: syncMenuButton swallows errors silently (idempotent)', async () => {
  const fetchImpl = async () => { throw new Error('Telegram API down'); };
  const mod = loadSandbox(fetchImpl);
  const env = makeEnv();
  // Should NOT throw
  await mod.syncMenuButton(env);
  assert.ok(true, 'syncMenuButton did not throw on fetch error');
});

// ============================================================================
// Section 8: _hashChannelSet — cache invalidation on channel list change
// ============================================================================

test('JOIN-015: _hashChannelSet returns "0" for empty channel list', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.equal(mod._hashChannelSet([]), '0');
  assert.equal(mod._hashChannelSet(null), '0');
});

test('JOIN-016: _hashChannelSet is deterministic for same channels', () => {
  const mod = loadSandbox(makeMockFetch());
  const channels1 = [{ username: '@chanA' }, { username: '@chanB' }];
  const channels2 = [{ username: '@chanB' }, { username: '@chanA' }]; // different order
  assert.equal(mod._hashChannelSet(channels1), mod._hashChannelSet(channels2), 'order should not matter');
});

test('JOIN-017: _hashChannelSet differs for different channel sets', () => {
  const mod = loadSandbox(makeMockFetch());
  const a = mod._hashChannelSet([{ username: '@chanA' }]);
  const b = mod._hashChannelSet([{ username: '@chanB' }]);
  assert.notEqual(a, b, 'different channels should produce different hashes');
});

test('JOIN-018: _hashChannelSet is case-insensitive on usernames', () => {
  const mod = loadSandbox(makeMockFetch());
  const a = mod._hashChannelSet([{ username: '@ChannelA' }]);
  const b = mod._hashChannelSet([{ username: '@channela' }]);
  assert.equal(a, b, 'case should not matter');
});

// ============================================================================
// Summary
// ============================================================================

test('SUMMARY: JOINED_STATUSES contains expected statuses', () => {
  const mod = loadSandbox(makeMockFetch());
  assert.ok(mod.JOINED_STATUSES.has('creator'));
  assert.ok(mod.JOINED_STATUSES.has('administrator'));
  assert.ok(mod.JOINED_STATUSES.has('member'));
  assert.ok(mod.JOINED_STATUSES.has('restricted'));
  assert.ok(!mod.JOINED_STATUSES.has('left'));
  assert.ok(!mod.JOINED_STATUSES.has('kicked'));
});

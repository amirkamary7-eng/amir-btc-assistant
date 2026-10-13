/**
 * TASK 79 REMEDIATION REGRESSION TESTS
 *
 * Locks down the Task 79 fixes (branch fix/task79-remaining-remediation):
 *
 *   A. T78-BE-01 — membership rules-accept failure toast:
 *      POST /api/membership/rules/accept failures must NEVER surface the raw
 *      server error ('Failed to record acceptance' 500, local-apiFetch's
 *      fabricated 'HTTP 500' for non-JSON bodies). Every shape maps to a
 *      localized i18n key (mem_err_accept_failed / mem_err_rules_updated /
 *      mem_err_rules_changed); the raw server detail goes to console.warn.
 *
 *   B. T78-BE-03 + claim-code mapping — wallet daily-claim popup:
 *      RATE_LIMITED (429, 5/60s — reachable by re-tapping claim) and
 *      DAILY_DISABLED (403 kill-switch) previously leaked their raw English
 *      server messages; non-JSON failures leaked the frontend's own
 *      'Network error' literal. All must map to localized WT keys; unknown
 *      codes keep the documented server-message-first fallback; ALREADY_
 *      CLAIMED (BE-102) behavior is preserved.
 *
 * Run: node --test tests/task79-remaining-remediation-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WALLET_SRC = fs.readFileSync(path.join(ROOT, 'wallet.js'), 'utf8');
const MEMBERSHIP_SRC = fs.readFileSync(path.join(ROOT, 'membership-user.js'), 'utf8');
const WALLET_CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'wallet.js'), 'utf8');
const MEMBERSHIP_CTRL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'membership.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');

// ── Helper: extract a named function (paren-match + brace-match) ──
// (Same technique as task75-remediation-regression-test.cjs.)
function extractFn(src, name) {
  const sigRe = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/[$]/g, '[$&]') + '\\s*\\(');
  const sigMatch = sigRe.exec(src);
  assert.ok(sigMatch, name + ' must exist in source');
  const start = sigMatch.index;
  let i = src.indexOf('(', start);
  let pd = 1; i++;
  while (pd > 0 && i < src.length) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    i++;
  }
  i = src.indexOf('{', i);
  let bd = 1; i++;
  while (bd > 0 && i < src.length) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') bd--;
    i++;
  }
  return src.slice(start, i);
}

// ── Helper: extract a `const NAME = { ... }` dictionary literal ──
// (Brace-matched; string-internal '{n}' placeholders are brace-balanced so
// naive counting is safe here — same assumption as extractFn.)
function extractDict(src, name) {
  const start = src.indexOf('const ' + name + ' = {');
  assert.ok(start >= 0, name + ' must exist in source');
  let i = src.indexOf('{', start), bd = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') { bd--; if (bd === 0) break; }
  }
  assert.ok(i < src.length, name + ' block must close');
  return src.slice(start, i + 1);
}

// ═══════════════════════════════════════════════════════════════════════════
// A. T78-BE-01 — membership rules-accept failure toast
// ═══════════════════════════════════════════════════════════════════════════

// One shared context: real i18n.js (real t()) + the real mapper function.
const _mbCtx = (() => {
  const warns = [];
  const sandbox = {
    console: { warn: (...a) => warns.push(a.join(' ')), log: () => {}, error: () => {} },
    window: {},
  };
  vm.createContext(sandbox);
  vm.runInContext(I18N_SRC + '\n' + extractFn(MEMBERSHIP_SRC, 'membershipAcceptError') + '\nthis.__fn = membershipAcceptError;', sandbox);
  return { sandbox, warns };
})();

function runMembershipAccept(res, lang) {
  vm.runInContext('currentLang = ' + JSON.stringify(lang || 'fa'), _mbCtx.sandbox);
  const out = vm.runInContext('membershipAcceptError(' + JSON.stringify(res ?? null) + ')', _mbCtx.sandbox);
  return out;
}

// The three real localized values (verified against i18n.js at test time).
const MB_FA = {
  accept_failed: 'خطا در ثبت پذیرش قوانین. لطفاً دوباره تلاش کنید.',
  rules_updated: 'نسخه قوانین به‌روزرسانی شده است. لطفاً نسخه جدید را مطالعه و تأیید کنید.',
  rules_changed: 'نسخه قوانین فعال تغییر کرده است. لطفاً نسخه جدید را تأیید کنید.',
};
const MB_EN = {
  accept_failed: 'Failed to record rules acceptance. Please try again.',
  rules_updated: 'Rules version has been updated. Please read and accept the new version.',
  rules_changed: 'Active rules version has changed. Please accept the new version.',
};

test('T78-BE-01-S1: backend still returns the error shapes this mapper exists for (source pins)', () => {
  assert.match(MEMBERSHIP_CTRL_SRC, /'Failed to record acceptance', code: 'ACCEPTANCE_FAILED' \}, \{ status: 500 \}/,
    'controller must still return the 500 ACCEPTANCE_FAILED body');
  assert.match(MEMBERSHIP_CTRL_SRC, /'Rules version not found', code: 'RULES_NOT_FOUND' \}, \{ status: 404 \}/,
    'controller must still return the 404 RULES_NOT_FOUND body');
  assert.match(MEMBERSHIP_CTRL_SRC, /'Cannot accept a non-active rules version', code: 'RULES_NOT_ACTIVE' \}, \{ status: 409 \}/,
    'controller must still return the 409 RULES_NOT_ACTIVE body');
});

test('T78-BE-01-B1: 500 ACCEPTANCE_FAILED body → localized mem_err_accept_failed (FA)', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 500, error: 'Failed to record acceptance', code: 'ACCEPTANCE_FAILED', status: 'error' }, 'fa');
  assert.equal(out.msg, MB_FA.accept_failed, 'must show the localized acceptance-failure message, never the raw server string');
  assert.equal(out.refresh, false, 'generic failures must not trigger the rules refresh flow');
});

test('T78-BE-01-B2: non-JSON failure (local apiFetch fabricated "HTTP 500") → localized generic (FA)', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 500, error: 'HTTP 500' }, 'fa');
  assert.equal(out.msg, MB_FA.accept_failed, 'fabricated HTTP-status text must never reach the user');
});

test('T78-BE-01-B3: 404 RULES_NOT_FOUND → mem_err_rules_updated + refresh flow', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 404, error: 'Rules version not found', code: 'RULES_NOT_FOUND' }, 'fa');
  assert.equal(out.msg, MB_FA.rules_updated);
  assert.equal(out.refresh, true, 'rules-version drift must keep the refresh-and-rerender behavior');
});

test('T78-BE-01-B4: 409 RULES_NOT_ACTIVE → mem_err_rules_changed + refresh flow', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 409, error: 'Cannot accept a non-active rules version', code: 'RULES_NOT_ACTIVE' }, 'fa');
  assert.equal(out.msg, MB_FA.rules_changed);
  assert.equal(out.refresh, true);
});

test('T78-BE-01-B5: null response (total fetch failure) → localized generic', () => {
  const out = runMembershipAccept(null, 'fa');
  assert.equal(out.msg, MB_FA.accept_failed);
  assert.equal(out.refresh, false);
});

test('T78-BE-01-B6: 401 auth shape (detail field, no error/code) → localized generic', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 401, detail: 'Authentication required' }, 'fa');
  assert.equal(out.msg, MB_FA.accept_failed, 'auth failures must not leak the route-level English detail');
});

test('T78-BE-01-B7: 503 DB shape (status/message, no error field) → localized generic', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 503, status: 'error', message: 'Database unavailable' }, 'fa');
  assert.equal(out.msg, MB_FA.accept_failed);
});

test('T78-BE-01-B8: EN users get the English dictionary values', () => {
  const out = runMembershipAccept({ ok: false, _httpStatus: 500, error: 'Failed to record acceptance', code: 'ACCEPTANCE_FAILED' }, 'en');
  assert.equal(out.msg, MB_EN.accept_failed);
});

test('T78-BE-01-B9: raw server detail is preserved in console.warn (support diagnostics)', () => {
  _mbCtx.warns.length = 0;
  runMembershipAccept({ ok: false, _httpStatus: 500, error: 'Failed to record acceptance', code: 'ACCEPTANCE_FAILED' }, 'fa');
  const line = _mbCtx.warns.join('\n');
  assert.match(line, /rules\/accept failed/);
  assert.match(line, /ACCEPTANCE_FAILED/);
  assert.match(line, /Failed to record acceptance/, 'the raw server string must be LOGGED, just not displayed');
});

test('T78-BE-01-W1: call site routes every failure through the mapper (no raw acceptRes.error display)', () => {
  assert.match(MEMBERSHIP_SRC, /var mapped = membershipAcceptError\(acceptRes\);/,
    'the rules-accept failure branch must use the mapper');
  assert.doesNotMatch(MEMBERSHIP_SRC, /acceptRes && acceptRes\.error\) \? acceptRes\.error/,
    'the old raw-error preference must be gone');
  assert.match(MEMBERSHIP_SRC, /admToast\(mapped\.msg, 'error'\)|alert\(mapped\.msg\)/,
    'the toast/alert must render the mapped localized message');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. T78-BE-03 + claim-code mapping — wallet daily-claim popup
// ═══════════════════════════════════════════════════════════════════════════

// Real dictionaries + real WT + real mapper in one shared context per language.
function makeWalletCtx(lang) {
  const sandbox = {
    console: { warn: () => {}, log: () => {}, error: () => {} },
    window: {},
    detectLang: () => lang,
  };
  vm.createContext(sandbox);
  vm.runInContext(
    extractDict(WALLET_SRC, 'WT_FA') + '\n' +
    extractDict(WALLET_SRC, 'WT_EN') + '\n' +
    extractFn(WALLET_SRC, 'WT') + '\n' +
    extractFn(WALLET_SRC, '_claimErrorText') + '\n' +
    'this.__out = { _claimErrorText };',
    sandbox,
  );
  return sandbox;
}

test('T79-W-S1: backend claim error codes are still returned with these shapes (source pins)', () => {
  assert.match(WALLET_CTRL_SRC, /'Too many requests\. Please wait\.', code: 'RATE_LIMITED' \}, \{ status: 429 \}/,
    'claim rate limit must stay a coded 429');
  assert.match(WALLET_CTRL_SRC, /'Daily rewards are temporarily disabled', code: 'DAILY_DISABLED' \}, \{ status: 403 \}/,
    'claim kill-switch must stay a coded 403');
  assert.match(WALLET_CTRL_SRC, /'Already claimed today', code: 'ALREADY_CLAIMED' \}, \{ status: 409 \}/,
    'BE-102 shape must stay a coded 409');
});

test('T79-W-B1: ALREADY_CLAIMED 409 body → localized already_claimed (BE-102 preserved)', () => {
  const out = vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', message: 'Already claimed today', code: 'ALREADY_CLAIMED' }) + ')', makeWalletCtx('fa'));
  assert.equal(out, 'جایزه امروز را قبلاً دریافت کرده‌اید. فردا دوباره سر بزنید.');
});

test('T79-W-B2: RATE_LIMITED 429 body → localized claim_rate_limited (was raw English)', () => {
  const out = vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', message: 'Too many requests. Please wait.', code: 'RATE_LIMITED' }) + ')', makeWalletCtx('fa'));
  assert.equal(out, 'درخواست‌های شما بیش از حد مجاز است. کمی صبر کنید و دوباره تلاش کنید.');
  assert.notEqual(out, 'Too many requests. Please wait.', 'the raw English server message must never be displayed');
});

test('T79-W-B3: DAILY_DISABLED 403 body → localized claim_disabled (was raw English)', () => {
  const out = vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', message: 'Daily rewards are temporarily disabled', code: 'DAILY_DISABLED' }) + ')', makeWalletCtx('fa'));
  assert.equal(out, 'دریافت جایزه روزانه موقتاً غیرفعال است. کمی بعد دوباره تلاش کنید.');
});

test('T79-W-B4: non-JSON network failure (NETWORK_ERROR code) → localized claim_error (was "Network error")', () => {
  const out = vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', code: 'NETWORK_ERROR' }) + ')', makeWalletCtx('fa'));
  assert.equal(out, 'دریافت جایزه ناموفق بود');
  assert.notEqual(out, 'Network error', 'the frontend English literal must never be displayed');
});

test('T79-W-B5: unknown code keeps the documented server-message-first fallback', () => {
  const out = vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', message: 'Some future server detail', code: 'FUTURE_CODE' }) + ')', makeWalletCtx('fa'));
  assert.equal(out, 'Some future server detail', 'unknown codes preserve the pre-existing fallback behavior');
});

test('T79-W-B6: no code and no message → localized generic claim_error', () => {
  const out = vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error' }) + ')', makeWalletCtx('fa'));
  assert.equal(out, 'دریافت جایزه ناموفق بود');
  assert.equal(vm.runInContext('_claimErrorText(null)', makeWalletCtx('fa')), 'دریافت جایزه ناموفق بود');
});

test('T79-W-B7: EN users get English dictionary values for the mapped codes', () => {
  const ctx = makeWalletCtx('en');
  assert.equal(vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', message: 'Too many requests. Please wait.', code: 'RATE_LIMITED' }) + ')', ctx),
    'Too many requests. Please wait a moment and try again.');
  assert.equal(vm.runInContext('_claimErrorText(' + JSON.stringify({ status: 'error', message: 'Daily rewards are temporarily disabled', code: 'DAILY_DISABLED' }) + ')', ctx),
    'Daily rewards are temporarily disabled. Please try again later.');
});

test('T79-W-D1: new WT keys exist in BOTH dictionaries (FA/EN parity for the claim family)', () => {
  const sandbox = {};
  vm.createContext(sandbox);
  vm.runInContext(extractDict(WALLET_SRC, 'WT_FA') + '\n' + extractDict(WALLET_SRC, 'WT_EN') + '\nthis.__out = { WT_FA, WT_EN };', sandbox);
  const { WT_FA, WT_EN } = sandbox.__out;
  for (const k of ['already_claimed', 'claim_rate_limited', 'claim_disabled', 'claim_error']) {
    assert.ok(typeof WT_FA[k] === 'string' && WT_FA[k].length > 0, 'WT_FA.' + k + ' must exist');
    assert.ok(typeof WT_EN[k] === 'string' && WT_EN[k].length > 0, 'WT_EN.' + k + ' must exist');
    assert.match(WT_FA[k], /[\u0600-\u06FF]/, 'WT_FA.' + k + ' must be Persian');
  }
});

test('T79-W-W1: call-site wiring — the popup uses _claimErrorText; the "Network error" literal is gone', () => {
  assert.match(WALLET_SRC, /const claimErrorMsg = _claimErrorText\(result\);/,
    'the claim popup must route through the shared mapper');
  assert.ok(!/message:\s*'Network error'/.test(WALLET_SRC),
    'wallet.js must no longer RETURN the English "Network error" string');
  assert.match(WALLET_SRC, /return \{ status: 'error', code: 'NETWORK_ERROR' \};/,
    'the claimDailyRewardAPI non-JSON catch must return a machine-readable code');
});

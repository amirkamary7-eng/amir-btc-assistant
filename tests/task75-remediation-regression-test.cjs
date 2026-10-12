/**
 * TASK 75 REMEDIATION REGRESSION TESTS
 *
 * Locks down the three Stage-2 fixes from Task 75 (remaining UX audit
 * remediation on branch fix/ux-copy-remediation):
 *
 *   A. BE-118 — VPN purchase error path is LIVE (not dead code):
 *      window.apiFetch throws on ALL non-2xx; the backend returns
 *      422/403/429/402/409 for INVALID_PLAN/PREMIUM_REQUIRED/
 *      PLAN_LIMIT_REACHED/PAYMENT_FAILED/DUPLICATE_PENDING. The catch block
 *      must parse the thrown body and map each code to a localized toast
 *      (never raw English / raw JSON), with a connection-error fallback for
 *      non-JSON bodies. Success/payment/plan-limit/duplicate BEHAVIOR stays
 *      server-side and unchanged — this suite asserts display only.
 *
 *   B. NT-005 — referral reward channel dedup + unit unification:
 *      ONE reward must not produce TWO Telegram messages for users whose
 *      ch_referral preference is 'telegram'/'both'. The plain referral_reward
 *      template dispatch now carries skipTelegram:true (in-app INSERT only);
 *      the rich Telegram message remains the sole Telegram carrier and no
 *      longer says «توکن» (unit unified to AB).
 *
 *   C. BE-112 family — cosmetics shop catalog load never renders the raw
 *      thrown body; plus translateTxDesc covers the
 *      'Refund: VPN {n}GB duplicate pending' wallet-history shape.
 *
 * Run: node --test tests/task75-remediation-regression-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const WALLET_SRC = fs.readFileSync(path.join(ROOT, 'wallet.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const COSMETICS_SRC = fs.readFileSync(path.join(ROOT, 'cosmetics.js'), 'utf8');
const NOTIF_PLATFORM_SRC = fs.readFileSync(path.join(ROOT, 'src', 'repositories', 'notification_platform.js'), 'utf8');
const REFERRAL_REWARDS_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'referral-rewards.js'), 'utf8');
const CTRL_PURCHASES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'reward_purchases.js'), 'utf8');

// ── Helper: extract a named function (paren-match + brace-match) ──
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

// ═══════════════════════════════════════════════════════════════════════════
// A. BE-118 — SOURCE: backend returns non-2xx for every coded VPN error,
//    and apiFetch throws on every non-2xx response.
// ═══════════════════════════════════════════════════════════════════════════

test('BE-118-S1: apiFetch throws on ALL non-2xx (the premise of the live path)', () => {
  assert.match(APP_SRC, /if \(!res\.ok\) \{/, 'apiFetch must gate on !res.ok');
  assert.match(APP_SRC, /const err = new Error\(errMsg\);\s*err\.status = res\.status;/,
    'apiFetch must throw an Error carrying the status/body');
});

test('BE-118-S2: backend VPN purchase errors are all non-2xx', () => {
  assert.match(CTRL_PURCHASES_SRC, /code: 'INVALID_PLAN'[^}]*\}, \{ status: 422 \}/,
    'INVALID_PLAN → 422');
  assert.match(CTRL_PURCHASES_SRC, /code: 'PREMIUM_REQUIRED',\s*\}, \{ status: 403 \}/,
    'PREMIUM_REQUIRED → 403');
  assert.match(CTRL_PURCHASES_SRC, /code: 'PLAN_LIMIT_REACHED',[\s\S]*?\}, \{ status: 429 \}/,
    'PLAN_LIMIT_REACHED → 429');
  assert.match(CTRL_PURCHASES_SRC, /code: 'PAYMENT_FAILED',\s*required_tokens: plan\.costAb,\s*\}, \{ status: 402 \}/,
    'PAYMENT_FAILED → 402');
  assert.match(CTRL_PURCHASES_SRC, /code: 'DUPLICATE_PENDING',\s*purchase_id: existingPurchase\?\.id \|\| null,\s*\}, \{ status: 409 \}/,
    'DUPLICATE_PENDING (idempotent debit) → 409');
});

test('BE-118-S3: shared mapper exists and catch parses the thrown body', () => {
  assert.ok(WALLET_SRC.includes('function _showVpnPurchaseError(j)'), 'shared mapper must exist');
  const execFn = extractFn(WALLET_SRC, 'executeVpnPurchase');
  assert.match(execFn, /catch \(e\) \{[\s\S]*?JSON\.parse\(e && e\.message\)/,
    'catch must parse the thrown body (BE-102/BE-112 pattern)');
  assert.match(execFn, /_showVpnPurchaseError\(j\)/, 'catch must route through the shared mapper');
  assert.ok(!/showToast\(WT\('vpn_connection_error'\)\);\s*\}\s*finally/.test(execFn.replace(/\n\s*\/\/[^\n]*/g, '')),
    'catch must not be a bare connection-error toast anymore');
});

// ═══════════════════════════════════════════════════════════════════════════
// A. BE-118 — BEHAVIORAL: prove the mapped messages actually display.
//    Executes the REAL executeVpnPurchase / _showVpnPurchaseError with a mock
//    window.apiFetch that throws the backend's exact error bodies and a
//    recording showToast. Asserts the toast the user actually sees.
// ═══════════════════════════════════════════════════════════════════════════

function runVpnPurchaseScenario(thrownMessage) {
  const toasts = [];
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    document: { querySelector: () => null },
    window: { apiFetch: async () => { throw new Error(thrownMessage); } },
    JSON, String, Number, Boolean, isNaN, parseInt, parseFloat,
    showToast: (msg) => { toasts.push(msg); },
    WT: (key, params) => key + (params && Object.keys(params).length ? '|' + JSON.stringify(params) : ''),
    detectLang: () => 'fa',
    closeVpnConfirmModal: () => {},
    invalidateWalletCache: () => {},
    refreshWalletBalance: () => {},
    updateNotifBadge: () => {},
    _purchaseInFlight: false,
    _walletMutationSeq: 0,
    _markVpnCardPurchased: () => {},
    showVpnSuccessModal: () => {},
    _setAuthoritativeBalance: () => {},
    _syncTierVisuals: () => {},
    walletData: null,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(WALLET_SRC, '_showVpnPurchaseError') + '\n' + extractFn(WALLET_SRC, 'executeVpnPurchase'), sandbox);
  const promise = vm.runInContext('executeVpnPurchase("vpn5")', sandbox);
  return promise.then(() => toasts);
}

test('BE-118-B1: PLAN_LIMIT_REACHED 429 body → vpn_plan_limit toast with days (user-visible)', async () => {
  const toasts = await runVpnPurchaseScenario('{"status":"error","message":"You already purchased this plan. 17 days until next purchase.","code":"PLAN_LIMIT_REACHED","days_remaining":17}');
  assert.deepEqual(toasts, ['vpn_plan_limit|{"n":17}'],
    'the 30-day limit must surface the localized plan-limit toast, not raw English');
});

test('BE-118-B2: PAYMENT_FAILED 402 body → vpn_insufficient_ab toast with required tokens', async () => {
  const toasts = await runVpnPurchaseScenario('{"status":"error","message":"Insufficient AB balance","code":"PAYMENT_FAILED","required_tokens":25}');
  assert.deepEqual(toasts, ['vpn_insufficient_ab|{"n":25}'], 'insufficient balance must surface the localized amount toast');
});

test('BE-118-B3: DUPLICATE_PENDING 409 body → vpn_pending_error toast', async () => {
  const toasts = await runVpnPurchaseScenario('{"status":"error","message":"You already have a pending purchase for this plan. Please wait for fulfillment.","code":"DUPLICATE_PENDING"}');
  assert.deepEqual(toasts, ['vpn_pending_error'], 'duplicate request must surface the localized pending toast');
});

test('BE-118-B4: PREMIUM_REQUIRED 403 body → vpn_premium_required toast', async () => {
  const toasts = await runVpnPurchaseScenario('{"status":"error","message":"Premium membership required to purchase this plan","code":"PREMIUM_REQUIRED"}');
  assert.deepEqual(toasts, ['vpn_premium_required']);
});

test('BE-118-B5: INVALID_PLAN 422 body → vpn_invalid_plan toast', async () => {
  const toasts = await runVpnPurchaseScenario('{"status":"error","message":"Invalid plan","code":"INVALID_PLAN"}');
  assert.deepEqual(toasts, ['vpn_invalid_plan']);
});

test('BE-118-B6: unknown coded error → vpn_unknown_error (never the raw message)', async () => {
  const toasts = await runVpnPurchaseScenario('{"status":"error","message":"Mystery server detail","code":"SOMETHING_ELSE"}');
  assert.deepEqual(toasts, ['vpn_unknown_error'], 'unknown codes must never render the server message');
});

test('BE-118-B7: non-JSON body (network/HTML/HTTP 500) → vpn_connection_error fallback', async () => {
  for (const raw of ['HTTP 500', 'Failed to fetch', '<html>Bad Gateway</html>', '']) {
    const toasts = await runVpnPurchaseScenario(raw);
    assert.deepEqual(toasts, ['vpn_connection_error'], 'non-JSON failures must fall back to the connection toast: ' + JSON.stringify(raw));
  }
});

test('BE-118-B8: buy button is re-enabled after error (behavior preserved)', async () => {
  let btnState = null;
  const btn = { disabled: false, dataset: { originalText: 'خرید' }, textContent: 'خرید' };
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    document: { querySelector: (sel) => (sel.includes('vpn-buy-btn') ? btn : null) },
    window: { apiFetch: async () => { throw new Error('{"status":"error","code":"INVALID_PLAN","message":"Invalid plan"}'); } },
    JSON, String, Number, Boolean,
    showToast: () => {},
    WT: (key, params) => key,
    detectLang: () => 'fa',
    closeVpnConfirmModal: () => {},
    _purchaseInFlight: false,
    _walletMutationSeq: 0,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(WALLET_SRC, '_showVpnPurchaseError') + '\n' + extractFn(WALLET_SRC, 'executeVpnPurchase'), sandbox);
  await vm.runInContext('executeVpnPurchase("vpn5")', sandbox);
  btnState = { disabled: btn.disabled, text: btn.textContent };
  assert.equal(btnState.disabled, false, 'error must re-enable the buy button');
  assert.equal(btnState.text, 'خرید', 'error must restore the button label');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. NT-005 — SOURCE: skipTelegram plumbing
// ═══════════════════════════════════════════════════════════════════════════

test('NT-005-S1: sendNotification supports skipTelegram and honors it in delivery', () => {
  assert.match(NOTIF_PLATFORM_SRC, /skipTelegram = false/, 'skipTelegram opt with safe default');
  assert.match(NOTIF_PLATFORM_SRC,
    /const deliverToTelegram = \(userChannel === 'telegram' \|\| userChannel === 'both'\) && !skipTelegram;/,
    'deliverToTelegram must be gated on !skipTelegram');
  assert.match(NOTIF_PLATFORM_SRC,
    /const deliverToMiniApp = \(userChannel === 'mini_app' \|\| userChannel === 'both'\) && !skipInApp;/,
    'deliverToMiniApp must remain gated on !skipInApp (unchanged semantics)');
});

test('NT-005-S2: plain referral_reward dispatch carries skipTelegram, rich message does not', () => {
  // Extract the FULL plain create() call (lastIndexOf back to its start, forward
  // to its closing .catch) — a plain text slice can end early inside comments.
  const tplIdx = REFERRAL_REWARDS_SRC.indexOf("templateKey: 'referral_reward'");
  const plainStart = REFERRAL_REWARDS_SRC.lastIndexOf('notificationService.create', tplIdx);
  const plainEnd = REFERRAL_REWARDS_SRC.indexOf('}).catch', tplIdx);
  const plainBlock = REFERRAL_REWARDS_SRC.slice(plainStart, plainEnd);
  assert.ok(plainBlock.includes("templateKey: 'referral_reward'"), 'sanity: extracted the plain reward dispatch');
  assert.ok(plainBlock.includes('skipTelegram: true'),
    'the plain template dispatch must suppress its redundant Telegram copy');
  const richMetaIdx = REFERRAL_REWARDS_SRC.indexOf("kind: 'referral_rich_message'");
  const richStart = REFERRAL_REWARDS_SRC.lastIndexOf('notificationService.create', richMetaIdx);
  const richEnd = REFERRAL_REWARDS_SRC.indexOf('});', richMetaIdx);
  const richBlock = REFERRAL_REWARDS_SRC.slice(richStart, richEnd);
  assert.ok(!richBlock.includes('skipTelegram'),
    'the rich message must remain the Telegram carrier (no skipTelegram)');
  assert.ok(richBlock.includes("channel: 'telegram'"), 'rich message stays channel telegram');
  assert.ok(richBlock.includes('skipInApp: true'), 'rich message stays Telegram-only (skipInApp)');
});

test('NT-005-S3: rich message closing line no longer says «توکن»', () => {
  const richBlock = REFERRAL_REWARDS_SRC.slice(
    REFERRAL_REWARDS_SRC.indexOf('referral_rich_'),
    REFERRAL_REWARDS_SRC.indexOf('} catch (msgErr)')
  );
  assert.ok(!richBlock.includes('توکن'), 'no raw «توکن» in the rich reward message');
  assert.ok(richBlock.includes('AB بیشتری دریافت کنید'), 'closing line uses AB unit');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. NT-005 — BEHAVIORAL: the REAL deliverToTelegram expression against the
//    full preference matrix (tests the exact shipped code, not a copy).
// ═══════════════════════════════════════════════════════════════════════════

test('NT-005-B1: deliverToTelegram matrix — skipTelegram suppresses ONLY telegram', () => {
  const m = NOTIF_PLATFORM_SRC.match(/const deliverToTelegram = ([^;]+);/);
  assert.ok(m, 'deliverToTelegram expression must exist');
  const expr = m[1];
  const evalExpr = new Function('userChannel', 'skipTelegram', 'return (' + expr + ');');
  // Before the fix, a ch_referral='both' user got TWO Telegram messages for one reward.
  assert.equal(evalExpr('both', false), true, 'normal notifications still deliver on both');
  assert.equal(evalExpr('telegram', false), true, 'normal notifications still deliver on telegram');
  assert.equal(evalExpr('mini_app', false), false, 'mini_app-only users get no Telegram');
  // After the fix, the plain referral_reward copy is suppressed even for both/telegram users:
  assert.equal(evalExpr('both', true), false, 'skipTelegram must suppress the plain copy for both-pref users');
  assert.equal(evalExpr('telegram', true), false, 'skipTelegram must suppress the plain copy for telegram-pref users');
  assert.equal(evalExpr('mini_app', true), false, 'no change for mini_app users');
});

test('NT-005-B2: deliverToMiniApp matrix — skipTelegram does NOT touch in-app', () => {
  // Grab the sendNotification definition specifically (the one gated on skipInApp).
  const m = NOTIF_PLATFORM_SRC.match(/const deliverToMiniApp = \(([^;)]+[^;]*)\) && !skipInApp;/);
  assert.ok(m, 'sendNotification deliverToMiniApp must stay gated on !skipInApp');
  const expr = '(' + m[1] + ') && !skipInApp';
  assert.ok(!expr.includes('skipTelegram'), 'in-app delivery must not depend on skipTelegram');
  const evalExpr = new Function('userChannel', 'skipInApp', 'return (' + expr + ');');
  assert.equal(evalExpr('both', false), true, 'in-app INSERT preserved for both-pref users');
  assert.equal(evalExpr('mini_app', false), true, 'in-app INSERT preserved for mini_app users');
  assert.equal(evalExpr('telegram', false), false, 'telegram-only users keep no in-app copy');
  assert.equal(evalExpr('both', true), false, 'skipInApp still suppresses in-app (unchanged semantics)');
});

// ═══════════════════════════════════════════════════════════════════════════
// B. NT-005 — BEHAVIORAL: the REAL creditReferralWithReward — one reward,
//    exactly three notification dispatches with the right channel flags,
//    and the reward payment itself (grantReward + rewarded UPDATE).
// ═══════════════════════════════════════════════════════════════════════════

test('NT-005-B3: one referral reward — payment happens once, message flags are correct', async () => {
  const creates = [];
  const grantCalls = [];
  const queries = [];
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    String, Number, Boolean, JSON, Promise,
    economyService: {
      grantReward: async (args) => {
        grantCalls.push(args);
        return { idempotent: false, newBalance: 153 };
      },
    },
    queryDb: async (...args) => { queries.push(args[1]); return { rowCount: 1 }; },
    notificationService: {
      create: async (env, opts) => { creates.push(opts); return { id: 'n' + creates.length }; },
    },
    resolveWebAppUrl: () => 'https://webapp.example.com',
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(REFERRAL_REWARDS_SRC, 'creditReferralWithReward'), sandbox);
  await vm.runInContext("creditReferralWithReward({ BOT_USERNAME: 'testbot' }, 111, 42, 222, 3, false)", sandbox);

  // ── Reward payment: exactly one grant of the right amount/type/refId ──
  assert.equal(grantCalls.length, 1, 'the reward must be granted exactly once');
  assert.equal(grantCalls[0].amount, 3);
  assert.equal(grantCalls[0].rewardType, 'referral_reward');
  assert.equal(grantCalls[0].refId, '42');
  assert.equal(grantCalls[0].description, 'Invite reward for user 222');
  // ── rewarded flag update (marks the referral row) ──
  assert.ok(queries.some((q) => /UPDATE referrals SET rewarded = TRUE/.test(q)),
    'the referral row must be marked rewarded');

  // ── Message count + channel flags: exactly 3 dispatches ──
  assert.equal(creates.length, 3, 'exactly 3 notification dispatches (invite, plain reward, rich)');
  const [invite, plainReward, rich] = creates;
  assert.equal(invite.templateKey, 'referral_new_invite');
  assert.ok(!(invite.skipTelegram === true), 'invite notice must keep default telegram behavior');
  assert.equal(plainReward.templateKey, 'referral_reward');
  assert.equal(plainReward.skipTelegram, true, 'plain reward copy must NOT enqueue its own Telegram message (NT-005)');
  assert.equal(rich.metadata && rich.metadata.kind, 'referral_rich_message');
  assert.equal(rich.channel, 'telegram', 'the rich message is the Telegram carrier');
  assert.equal(rich.skipInApp, true, 'rich message stays Telegram-only');
  assert.ok(!(rich.skipTelegram === true), 'rich message must not suppress itself');
  assert.ok(String(rich.message).includes('+3 AB'), 'rich message shows the AB amount');
  assert.ok(!String(rich.message).includes('توکن'), 'rich message has no «توکن» unit leak');
  assert.equal(rich.telegramExtra && rich.telegramExtra.parse_mode, 'HTML');
});

test('NT-005-B4: idempotent re-credit dispatches NO messages (spam guard preserved)', async () => {
  const creates = [];
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    String, Number, Boolean, JSON, Promise,
    economyService: { grantReward: async () => ({ idempotent: true, newBalance: 153 }) },
    queryDb: async () => ({ rowCount: 1 }),
    notificationService: { create: async (e, o) => { creates.push(o); } },
    resolveWebAppUrl: () => 'https://webapp.example.com',
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(REFERRAL_REWARDS_SRC, 'creditReferralWithReward'), sandbox);
  await vm.runInContext("creditReferralWithReward({ BOT_USERNAME: 'testbot' }, 111, 42, 222, 3, false)", sandbox);
  assert.equal(creates.length, 0, 'an idempotent (already-credited) reward must not dispatch any message');
});

// ═══════════════════════════════════════════════════════════════════════════
// C1. BE-112 family — cosmetics shop catalog load never renders raw bodies
// ═══════════════════════════════════════════════════════════════════════════

test('BE-112-S1: cosmetics catalog-load catch no longer renders e.message', () => {
  assert.ok(!COSMETICS_SRC.includes("renderShopError('خطا: ' + (e.message"),
    'the raw thrown-body render must be gone');
  const openShopFn = extractFn(COSMETICS_SRC, 'openShop');
  assert.match(openShopFn, /catch \(e\) \{[\s\S]*?renderShopError\('خطا در بارگذاری کاتالوگ'\)/,
    'catalog-load failures must show the generic localized error');
});

test('BE-112-B1: catalog load failure shows generic error, not raw JSON', async () => {
  const errors = [];
  const fakeEl = () => ({ id: '', className: '', innerHTML: '', appendChild: () => {}, onclick: null, style: {} });
  const sandbox = {
    console: { warn: () => {}, error: () => {}, log: () => {} },
    document: {
      createElement: fakeEl,
      getElementById: () => null,
      body: { appendChild: () => {} },
    },
    _shopOpen: false,
    _catalog: null,
    apiFetch: async () => { throw new Error('{"status":"error","message":"Catalog unavailable","code":"DB_DOWN"}'); },
    renderShopError: (msg) => { errors.push(msg); },
    closeShop: () => {},
    renderShop: () => {},
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(COSMETICS_SRC, 'openShop'), sandbox);
  await vm.runInContext('openShop()', sandbox);
  assert.deepEqual(errors, ['خطا در بارگذاری کاتالوگ'],
    'the user must see the generic Persian catalog error — never the raw thrown body');
});

// ═══════════════════════════════════════════════════════════════════════════
// C2. translateTxDesc — 'Refund: VPN {n}GB duplicate pending' shape
// ═══════════════════════════════════════════════════════════════════════════

test('TXDESC-B1: duplicate-pending VPN refund renders fully in Persian', () => {
  const sandbox = {
    detectLang: () => 'fa',
    getTxLabel: (k) => 'label:' + k,
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(WALLET_SRC, 'translateTxDesc'), sandbox);
  const out = vm.runInContext("translateTxDesc('Refund: VPN 5GB duplicate pending')", sandbox);
  assert.ok(out.includes('بازگشت وجه'), 'must be translated as a refund');
  assert.ok(!/[a-zA-Z]/.test(out.replace(/VPN|AB/g, '')), 'must not contain leftover English words: ' + out);
  assert.ok(out.includes('5'), 'plan size must be preserved');

  // Existing shapes must keep working (no regression):
  assert.equal(vm.runInContext("translateTxDesc('Refund: VPN 5GB purchase failed')", sandbox),
    'بازگشت وجه: خرید VPN 5 گیگابایتی ناموفق بود');
  assert.equal(vm.runInContext("translateTxDesc('Refund: VPN 5GB already pending')", sandbox),
    'بازگشت وجه: درخواست VPN 5 گیگابایتی قبلاً در انتظار بوده است');
  // English users see the original description untouched:
  const sandboxEn = { detectLang: () => 'en', getTxLabel: (k) => 'label:' + k };
  vm.createContext(sandboxEn);
  vm.runInContext(extractFn(WALLET_SRC, 'translateTxDesc'), sandboxEn);
  assert.equal(vm.runInContext("translateTxDesc('Refund: VPN 5GB duplicate pending')", sandboxEn),
    'Refund: VPN 5GB duplicate pending', 'EN users keep the raw description (module behavior)');
});

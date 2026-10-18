/**
 * PHASE 31 — ISSUE 2 REGRESSION TEST: AB ticker span persistence
 * ==============================================================
 *
 * Phase 30 finding (CONFIRMED, Medium — regression of PR #66 DOM-FIX,
 * 2026-10-03):
 *   The Profile preview card and the Wallet hero render the balance as
 *     wallet.js:601  <div class="balance-value">${formatNumber(balance)} <span class="balance-ticker">AB</span></div>
 *     wallet.js:807  <div class="wallet-hero-balance-value">${formatNumber(balance)} <span class="hero-ticker">AB</span></div>
 *   All balance writers used `el.textContent = <number>` — assigning
 *   textContent replaces ALL child nodes, so every refresh path
 *   (60s poll / visibilitychange / Profile revisit / bfcache pageshow /
 *   claimDaily / VPN purchase / post-mutation fallback / every count-up
 *   animation frame) silently destroyed the "AB" unit span.
 *
 * Phase 31 fix under test:
 *   New shared helper setBalanceAmountText(el, valueText) in shared-utils.js
 *   (loaded before wallet.js AND app.js — index.html script order). It
 *   updates ONLY the leading text node (preserving its trailing separator
 *   whitespace) so the unit span survives; 6 writer sites now call it:
 *     wallet.js  refreshWalletBalance (:2584)
 *     wallet.js  executeVpnPurchase   (:2413)
 *     wallet.js  claimDaily fallback  (:1707)
 *     app.js     animateBalanceChange frames (:6147/:6149)
 *     app.js     refreshWalletAfterMutation fallback (:6059)
 *     app.js     bootstrap wallet_changed fallback (:1042)
 *
 * What this suite locks (no jsdom available — structural DOM shim with
 * REAL textContent semantics: setter clears children, getter concatenates):
 *   1. Markup fidelity: both render templates keep their ticker span +
 *      number/separator structure (render side of the contract).
 *   2. Behavioral — setBalanceAmountText on the REAL profile-card structure:
 *      value changes, span survives, separator preserved, no duplicates.
 *   3. Behavioral — setBalanceAmountText on the REAL wallet-hero structure.
 *   4. Behavioral — REAL refreshWalletBalance (sandboxed, real helper):
 *      60s-poll / foreground / revisit path preserves the span.
 *   5. Behavioral — REAL animateBalanceChange (sandboxed, real helper,
 *      deterministic rAF pump): span survives EVERY count-up frame and the
 *      final value is exact. claimDaily's DOM update delegates to this
 *      function (wallet.js:1703-1704), so its path is covered here.
 *   6. Source — all 6 writer sites call setBalanceAmountText; the exact
 *      old destructive textContent write patterns are gone.
 *   7. Fallback semantics — plain mock objects / empty elements (no child
 *      structure) still receive the value via the textContent fallback
 *      (keeps sandboxed regression-test mocks and non-ticker variants
 *      — skeleton / login-prompt — behaving exactly as before).
 *
 * Run: node --test tests/phase31-issue2-ab-ticker-persistence-test.cjs
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
const SHARED_SRC = fs.readFileSync(path.join(ROOT, 'shared-utils.js'), 'utf8');

// ── extractFn: same paren/brace matcher as wallet-tier-freshness suite ──────
function extractFn(src, name) {
  const sigRe = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
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

// ── Structural DOM shim (real textContent semantics) ───────────────────────
class FakeText {
  constructor(value) { this.nodeType = 3; this.nodeValue = String(value); }
  get textContent() { return this.nodeValue; }
}
class FakeElement {
  constructor(tagName, className) {
    this.nodeType = 1;
    this.tagName = tagName;
    this.className = className;
    this.childNodes = [];
  }
  get firstChild() { return this.childNodes[0] || null; }
  get textContent() { return this.childNodes.map(c => c.textContent).join(''); }
  set textContent(v) { this.childNodes = [new FakeText(v)]; } // REAL semantics: clears children
  insertBefore(node, ref) {
    const i = ref ? this.childNodes.indexOf(ref) : -1;
    if (i === -1) this.childNodes.push(node);
    else this.childNodes.splice(i, 0, node);
    return node;
  }
}

/** Builds the DOM structure the wallet render templates produce:
 *  <div class="${cls}">${number} <span class="${tickerCls}">AB</span></div> */
function buildBalanceCard(cls, tickerCls, numberText) {
  const el = new FakeElement('div', cls);
  el.childNodes.push(new FakeText(numberText + ' '));
  const span = new FakeElement('span', tickerCls);
  span.textContent = 'AB';
  el.childNodes.push(span);
  return el;
}

const hasTickerSpan = (el, tickerCls) =>
  el.childNodes.filter(c => c.nodeType === 1 && c.className === tickerCls && c.textContent === 'AB');

const countUnitTexts = (el) =>
  el.childNodes.map(c => c.textContent).join('').split('AB').length - 1;

// ── Load the REAL helper + REAL functions into sandboxes ───────────────────
function runWithHelper(fnSource, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(extractFn(SHARED_SRC, 'setBalanceAmountText'), sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. Markup fidelity — the render side keeps producing the ticker span
// ════════════════════════════════════════════════════════════════════════════

test('Issue 2: profile-card render template keeps the AB ticker span + separator', () => {
  assert.match(WALLET_SRC,
    /<div class="balance-value">\$\{formatNumber\(balance\)\} <span class="balance-ticker">AB<\/span><\/div>/,
    'renderProfileCard template must keep: number + space + <span class="balance-ticker">AB</span>');
});

test('Issue 2: wallet-hero render template keeps the AB ticker span + separator', () => {
  assert.match(WALLET_SRC,
    /<div class="wallet-hero-balance-value">\$\{formatNumber\(balance\)\} <span class="hero-ticker">AB<\/span><\/div>/,
    'renderWalletPage template must keep: number + space + <span class="hero-ticker">AB</span>');
});

// ════════════════════════════════════════════════════════════════════════════
// 2-3. Behavioral — REAL setBalanceAmountText on both card structures
// ════════════════════════════════════════════════════════════════════════════

test('Issue 2: helper preserves .balance-ticker span on the Profile card', () => {
  const sandbox = { console: { warn: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(SHARED_SRC, 'setBalanceAmountText'), sandbox);
  const el = buildBalanceCard('balance-value', 'balance-ticker', '1,234');

  sandbox.setBalanceAmountText(el, '9,876');

  assert.equal(el.childNodes[0].nodeValue, '9,876 ',
    'value text node updated (separator space preserved — not "9,876AB")');
  assert.equal(el.childNodes.length, 2, 'exactly 2 children — span not destroyed, none added');
  const spans = hasTickerSpan(el, 'balance-ticker');
  assert.equal(spans.length, 1, 'the single AB ticker span survives');
  assert.equal(el.textContent, '9,876 AB', 'visible text = new value + unit');
  assert.equal(countUnitTexts(el), 1, 'no duplicate AB units');
});

test('Issue 2: helper preserves .hero-ticker span on the Wallet hero', () => {
  const sandbox = { console: { warn: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(SHARED_SRC, 'setBalanceAmountText'), sandbox);
  const el = buildBalanceCard('wallet-hero-balance-value', 'hero-ticker', '50');

  sandbox.setBalanceAmountText(el, '123,456');

  assert.equal(el.childNodes[0].nodeValue, '123,456 ');
  assert.equal(el.childNodes.length, 2);
  assert.equal(hasTickerSpan(el, 'hero-ticker').length, 1);
  assert.equal(el.textContent, '123,456 AB');
  assert.equal(countUnitTexts(el), 1);
});

test('Issue 2: helper falls back to textContent for elements without child structure', () => {
  const sandbox = { console: { warn: () => {} } };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(SHARED_SRC, 'setBalanceAmountText'), sandbox);
  // Plain mock object (as used by sandboxed regression tests) + empty element
  const mock = { textContent: '900' };
  sandbox.setBalanceAmountText(mock, '2,500');
  assert.equal(mock.textContent, '2,500', 'plain mock still updated via fallback');

  const empty = new FakeElement('div', 'balance-value');
  sandbox.setBalanceAmountText(empty, '7');
  assert.equal(empty.textContent, '7', 'empty element (no unit span) still updated');
  assert.equal(empty.childNodes.length, 1, 'single text node — nothing duplicated');
});

test('Issue 2: helper inserts value before an element-first child without destroying it', () => {
  const sandbox = {
    console: { warn: () => {} },
    document: { createTextNode: (v) => new FakeText(v) },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(SHARED_SRC, 'setBalanceAmountText'), sandbox);
  // Defensive path: span first, no leading text node
  const el = new FakeElement('div', 'balance-value');
  const span = new FakeElement('span', 'balance-ticker');
  span.textContent = 'AB';
  el.childNodes.push(span);

  sandbox.setBalanceAmountText(el, '42');

  assert.equal(el.childNodes.length, 2, 'text node inserted, span kept');
  assert.strictEqual(el.childNodes[0].nodeType, 3, 'inserted node is a text node');
  assert.equal(el.childNodes[0].nodeValue, '42');
  assert.strictEqual(el.childNodes[1], span, 'the original span instance is untouched');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. Behavioral — REAL refreshWalletBalance (60s poll / foreground / revisit)
// ════════════════════════════════════════════════════════════════════════════

async function runRefreshWalletBalance(el) {
  const store = new Map();
  const sandbox = {
    _walletMutationSeq: 0,
    _lastKnownBalance: 0,
    walletData: null,
    _walletCache: { wallet: null },
    window: { apiFetch: async () => ({ status: 'success', balance: 2500 }) },
    console: { warn: () => {} },
    document: { querySelector: () => el },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    _syncTierVisuals: () => {},
  };
  runWithHelper(extractFn(WALLET_SRC, 'refreshWalletBalance'), sandbox);
  await sandbox.refreshWalletBalance();
  return el;
}

test('Issue 2: REAL refreshWalletBalance preserves the Profile-card AB span', async () => {
  const el = buildBalanceCard('balance-value', 'balance-ticker', '1,234');
  await runRefreshWalletBalance(el);
  assert.equal(el.childNodes[0].nodeValue, '2,500 ', 'fresh value written with separator');
  assert.equal(hasTickerSpan(el, 'balance-ticker').length, 1, 'AB ticker span survives the poll refresh');
  assert.equal(el.textContent, '2,500 AB', 'visible: new balance + AB unit');
  assert.equal(countUnitTexts(el), 1, 'no duplicate units');
});

test('Issue 2: REAL refreshWalletBalance preserves the Wallet-hero AB span', async () => {
  const el = buildBalanceCard('wallet-hero-balance-value', 'hero-ticker', '900');
  await runRefreshWalletBalance(el);
  assert.equal(hasTickerSpan(el, 'hero-ticker').length, 1, 'hero-ticker span survives');
  assert.equal(el.textContent, '2,500 AB');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. Behavioral — REAL animateBalanceChange (claimDaily delegates to it)
// ════════════════════════════════════════════════════════════════════════════

test('Issue 2: REAL animateBalanceChange keeps the AB span through EVERY count-up frame', () => {
  const el = buildBalanceCard('balance-value', 'balance-ticker', '900');
  let now = 0;
  let frameCbs = [];
  const sandbox = {
    performance: { now: () => now },
    requestAnimationFrame: (cb) => { frameCbs.push(cb); return frameCbs.length; },
  };
  runWithHelper(extractFn(APP_SRC, 'animateBalanceChange'), sandbox);

  sandbox.animateBalanceChange(el, 900, 2500);

  // Deterministic rAF pump: 150ms steps → frames at 150/300/450/600ms.
  let pumps = 0;
  while (frameCbs.length && pumps < 10) {
    const cbs = frameCbs;
    frameCbs = [];
    now += 150;
    for (const cb of cbs) cb(now);
    pumps++;
    // After EVERY frame: the span must still be there, exactly once.
    assert.equal(hasTickerSpan(el, 'balance-ticker').length, 1,
      `AB ticker span must survive count-up frame #${pumps} (t=${now}ms)`);
    assert.equal(el.childNodes.length, 2,
      `element must keep exactly [text, span] children after frame #${pumps}`);
  }
  assert.ok(pumps >= 4, 'animation must have run to completion (>=4 frames)');
  assert.equal(el.textContent, '2,500 AB', 'final count-up value is the target balance + unit');
  assert.equal(countUnitTexts(el), 1, 'no duplicate units after animation');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. Source — every writer site uses the helper; old destructive writes gone
// ════════════════════════════════════════════════════════════════════════════

test('Issue 2: refreshWalletBalance (wallet.js) writes via setBalanceAmountText', () => {
  const body = extractFn(WALLET_SRC, 'refreshWalletBalance');
  assert.match(body, /setBalanceAmountText\(el,\s*Number\(resp\.balance\)\.toLocaleString\('en-US'\)\)/,
    'poll/foreground/revisit refresh must use the span-preserving helper');
  assert.doesNotMatch(body, /\.textContent\s*=\s*Number\(resp\.balance\)/,
    'the destructive bare textContent write must be gone');
});

test('Issue 2: executeVpnPurchase (wallet.js) writes via setBalanceAmountText', () => {
  const body = extractFn(WALLET_SRC, 'executeVpnPurchase');
  assert.match(body, /setBalanceAmountText\(balEl,\s*resp\.new_balance\.toLocaleString\('en-US'\)\)/,
    'VPN purchase authoritative-balance write must use the helper');
  assert.doesNotMatch(body, /balEl\.textContent\s*=\s*resp\.new_balance/,
    'the destructive VPN-purchase write must be gone');
});

test('Issue 2: claimDaily (wallet.js) fallback writes via setBalanceAmountText', () => {
  const body = extractFn(WALLET_SRC, 'claimDaily');
  assert.match(body, /setBalanceAmountText\(balanceEl,\s*result\.newBalance\.toLocaleString\('en-US'\)\)/,
    'claimDaily fallback (animateBalanceChange unavailable) must use the helper');
  assert.doesNotMatch(body, /balanceEl\.textContent\s*=\s*result\.newBalance/,
    'the destructive claimDaily fallback write must be gone');
  // Primary path (animation) — same delegation as before the fix:
  assert.match(body, /animateBalanceChange\(balanceEl,\s*currentBalance,\s*result\.newBalance\)/,
    'claimDaily primary path still delegates to animateBalanceChange');
});

test('Issue 2: animateBalanceChange (app.js) frames write via setBalanceAmountText', () => {
  const body = extractFn(APP_SRC, 'animateBalanceChange');
  assert.match(body, /setBalanceAmountText\(el,\s*current\.toLocaleString\('en-US'\)\)/,
    'per-frame write must use the helper');
  assert.match(body, /setBalanceAmountText\(el,\s*to\.toLocaleString\('en-US'\)\)/,
    'final-frame write must use the helper');
  assert.doesNotMatch(body, /el\.textContent\s*=\s*(current|to)\.toLocaleString/,
    'the destructive per-frame textContent writes must be gone');
});

test('Issue 2: refreshWalletAfterMutation (app.js) fallback writes via setBalanceAmountText', () => {
  const body = extractFn(APP_SRC, 'refreshWalletAfterMutation');
  assert.match(body, /setBalanceAmountText\(balanceEl,\s*newBalance\.toLocaleString\('en-US'\)\)/,
    'post-mutation fallback write must use the helper');
  assert.doesNotMatch(body, /balanceEl\.textContent\s*=\s*newBalance\.toLocaleString/,
    'the destructive post-mutation fallback write must be gone');
});

test('Issue 2: bootstrap wallet_changed (app.js) fallback writes via setBalanceAmountText', () => {
  // The bootstrap block is inline (not a named function) — assert the exact
  // old write pattern is gone from app.js and the new one is present.
  assert.doesNotMatch(APP_SRC, /balanceEl\.textContent\s*=\s*data\.wallet_balance\.toLocaleString\('en-US'\)/,
    'the destructive bootstrap wallet_changed fallback write must be gone');
  assert.match(APP_SRC, /setBalanceAmountText\(balanceEl,\s*data\.wallet_balance\.toLocaleString\('en-US'\)\)/,
    'bootstrap wallet_changed fallback must use the helper');
});

test('Issue 2: shared-utils.js exports the helper and loads before wallet.js/app.js', () => {
  assert.match(SHARED_SRC, /function setBalanceAmountText\(el, valueText\)/,
    'helper must be a global function in shared-utils.js');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const sharedIdx = html.indexOf('src="shared-utils.js"');
  const walletIdx = html.indexOf('src="wallet.js"');
  const appIdx = html.indexOf('src="app.js"');
  assert.ok(sharedIdx > -1 && walletIdx > -1 && appIdx > -1,
    'all three scripts must be referenced in index.html');
  assert.ok(sharedIdx < walletIdx && sharedIdx < appIdx,
    'shared-utils.js must load BEFORE wallet.js and app.js (script order)');
});

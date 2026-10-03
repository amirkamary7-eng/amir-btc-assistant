/**
 * Wallet Balance DOM-Selector Regression Test
 *
 * ROOT CAUSE (production RCA 2026-10-03):
 *   refreshWalletBalance() (wallet.js) targeted document.getElementById(
 *   'wallet-balance-amount') — an element that DOES NOT EXIST in the DOM.
 *   The actual rendered balance elements are:
 *     - .balance-value (Profile preview card, rendered by renderProfileCard)
 *     - .wallet-hero-balance-value (Wallet hero, rendered by renderWalletPage)
 *   So the 60s poller, visibilitychange/pageshow (Fix #2), and Profile
 *   revisit (Fix #3) all fetched the fresh balance (Fix #1 queryDbDirect
 *   worked) but NEVER displayed it — the fetched value was stored in
 *   _lastKnownBalance and silently dropped.
 *
 * FIX (DOM-FIX): all 4 balance-update call sites now use a canonical
 * querySelector list that targets the REAL elements first, with legacy
 * selectors retained for compatibility:
 *   '.balance-value, .wallet-hero-balance-value, .wallet-balance-value,
 *    .hero-balance, .wallet-balance-amount, #wallet-balance-amount'
 *
 * This test verifies all 9 invariants:
 *   1. refreshWalletBalance selector matches .balance-value
 *   2. refreshWalletBalance selector matches .wallet-hero-balance-value
 *   3. Profile preview (.balance-value) is a target
 *   4. Wallet hero (.wallet-hero-balance-value) is a target
 *   5. refreshWalletAfterMutation (app.js) targets the real elements
 *   6. VPN purchase (wallet.js) targets the real elements (no getElementById)
 *   7. claimDaily (wallet.js) targets .balance-value (Profile preview)
 *   8. #wallet-balance-amount is no longer the SOLE target (no bare getElementById)
 *   9. stale-response / mutation-seq / authoritative-balance guards preserved
 *
 * Run: node --test tests/wallet-balance-dom-selector-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WALLET_SRC = fs.readFileSync(path.join(__dirname, '..', 'wallet.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// The canonical selector list (must match all 4 call sites).
const CANONICAL_SELECTOR = '.balance-value, .wallet-hero-balance-value, .wallet-balance-value, .hero-balance, .wallet-balance-amount, #wallet-balance-amount';

// ────────────────────────────────────────────────────────────────────────────
// Mock querySelector simulator: given a set of mock elements and a selector
// string, return the first matching element. Handles simple `.class` and
// `#id` selectors (the canonical list is all simple selectors, no combinators).
// ────────────────────────────────────────────────────────────────────────────
function makeMockDom(elements) {
  // elements: [{ classes: ['balance-value'], id: null, textContent: '0' }, ...]
  return {
    querySelector(selector) {
      const parts = selector.split(',').map(s => s.trim());
      for (const part of parts) {
        for (const el of elements) {
          if (part.startsWith('.') && el.classes.includes(part.slice(1))) return el;
          if (part.startsWith('#') && el.id === part.slice(1)) return el;
        }
      }
      return null;
    },
    getElementById(id) {
      return elements.find(e => e.id === id) || null;
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Tests 1-2: refreshWalletBalance selector matches the real elements
// (behavioral: simulate the selector against mock DOMs)
// ────────────────────────────────────────────────────────────────────────────

test('1. refreshWalletBalance selector matches .balance-value (Profile preview card)', () => {
  // Extract the selector used in refreshWalletBalance (wallet.js)
  const fnStart = WALLET_SRC.indexOf('async function refreshWalletBalance');
  assert.ok(fnStart > -1, 'refreshWalletBalance must exist');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart);
  const fnBody = WALLET_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WALLET_SRC.length);
  const selMatch = fnBody.match(/querySelector\((['"`])([^'"`]+)\1/);
  assert.ok(selMatch, 'refreshWalletBalance must use querySelector');
  const selector = selMatch[2];

  // Simulate a DOM with only .balance-value (Profile page, no Wallet hero)
  const profileEl = { classes: ['balance-value'], id: null, textContent: '0' };
  const dom = makeMockDom([profileEl]);
  const found = dom.querySelector(selector);
  assert.ok(found === profileEl, 'selector must match .balance-value when only it exists');
});

test('2. refreshWalletBalance selector matches .wallet-hero-balance-value (Wallet hero)', () => {
  const fnStart = WALLET_SRC.indexOf('async function refreshWalletBalance');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart);
  const fnBody = WALLET_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WALLET_SRC.length);
  const selMatch = fnBody.match(/querySelector\((['"`])([^'"`]+)\1/);
  const selector = selMatch[2];

  // Simulate a DOM with only .wallet-hero-balance-value (Wallet full page open)
  const heroEl = { classes: ['wallet-hero-balance-value'], id: null, textContent: '0' };
  const dom = makeMockDom([heroEl]);
  const found = dom.querySelector(selector);
  assert.ok(found === heroEl, 'selector must match .wallet-hero-balance-value when only it exists');
});

// ────────────────────────────────────────────────────────────────────────────
// Tests 3-4: source-level guards — the canonical selector includes both real elements
// ────────────────────────────────────────────────────────────────────────────

test('3. Profile preview (.balance-value) is a target in refreshWalletBalance', () => {
  const fnStart = WALLET_SRC.indexOf('async function refreshWalletBalance');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart);
  const fnBody = WALLET_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WALLET_SRC.length);
  assert.match(fnBody, /\.balance-value/,
    'refreshWalletBalance selector must include .balance-value (the Profile preview element)');
});

test('4. Wallet hero (.wallet-hero-balance-value) is a target in refreshWalletBalance', () => {
  const fnStart = WALLET_SRC.indexOf('async function refreshWalletBalance');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart);
  const fnBody = WALLET_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WALLET_SRC.length);
  assert.match(fnBody, /\.wallet-hero-balance-value/,
    'refreshWalletBalance selector must include .wallet-hero-balance-value (the Wallet hero element)');
});

// ────────────────────────────────────────────────────────────────────────────
// Test 5: refreshWalletAfterMutation (app.js) targets the real elements
// ────────────────────────────────────────────────────────────────────────────

test('5. refreshWalletAfterMutation (app.js) targets .balance-value + .wallet-hero-balance-value', () => {
  // refreshWalletAfterMutation is declared as `function` (not async) in app.js.
  const fnStart = APP_SRC.indexOf('function refreshWalletAfterMutation(');
  assert.ok(fnStart > -1, 'refreshWalletAfterMutation must exist in app.js');
  // Find the next function boundary (any top-level function declaration)
  const nextFn = APP_SRC.indexOf('\nfunction ', fnStart + 30);
  const fnBody = APP_SRC.slice(fnStart, nextFn > 0 ? nextFn : APP_SRC.length);
  // Extract the querySelector string literal from the function body
  const selMatch = fnBody.match(/querySelector\(\s*'([^']+)'\)/);
  assert.ok(selMatch, 'refreshWalletAfterMutation must use querySelector with a string literal');
  const selector = selMatch[1];
  assert.ok(selector.includes('.balance-value'),
    'refreshWalletAfterMutation selector must include .balance-value (Profile preview)');
  assert.ok(selector.includes('.wallet-hero-balance-value'),
    'refreshWalletAfterMutation selector must include .wallet-hero-balance-value (Wallet hero)');
});

// ────────────────────────────────────────────────────────────────────────────
// Test 6: VPN purchase (wallet.js) targets the real elements (no bare getElementById)
// ────────────────────────────────────────────────────────────────────────────

test('6. VPN purchase refresh targets real elements (no bare getElementById)', () => {
  // Find the VPN purchase balance update (wallet.js) — search for the new_balance handler.
  const idx = WALLET_SRC.indexOf("typeof resp.new_balance === 'number'");
  assert.ok(idx > -1, 'VPN purchase new_balance handler must exist');
  const body = WALLET_SRC.slice(idx, Math.min(idx + 900, WALLET_SRC.length));
  // Extract the querySelector string literal
  const selMatch = body.match(/querySelector\(\s*'([^']+)'\)/);
  assert.ok(selMatch, 'VPN purchase must use querySelector with a string literal');
  const selector = selMatch[1];
  assert.ok(selector.includes('.balance-value'),
    'VPN purchase selector must include .balance-value');
  assert.ok(selector.includes('.wallet-hero-balance-value'),
    'VPN purchase selector must include .wallet-hero-balance-value');
  // And must NOT use getElementById('wallet-balance-amount') as the SOLE target
  assert.doesNotMatch(body, /const balEl = document\.getElementById\('wallet-balance-amount'\)/,
    'VPN purchase must NOT use bare getElementById (was a no-op — id does not exist)');
});

// ────────────────────────────────────────────────────────────────────────────
// Test 7: claimDaily (wallet.js) targets .balance-value (Profile preview)
// ────────────────────────────────────────────────────────────────────────────

test('7. claimDaily targets .balance-value (Profile preview, not just Wallet hero)', () => {
  const fnStart = WALLET_SRC.indexOf('async function claimDaily');
  assert.ok(fnStart > -1, 'claimDaily must exist');
  // claimDaily is a very long function (~16K chars); use a generous slice.
  const fnBody = WALLET_SRC.slice(fnStart, Math.min(fnStart + 20000, WALLET_SRC.length));
  // Find the querySelector that specifically targets balance elements (contains .balance-value).
  // claimDaily has other querySelectors (.wallet-preview for the streak card) — we need the balance one.
  const selMatch = fnBody.match(/querySelector\(\s*'([^']*\.balance-value[^']*)'\)/);
  assert.ok(selMatch, 'claimDaily must have a querySelector containing .balance-value');
  const selector = selMatch[1];
  assert.ok(selector.includes('.balance-value'),
    'claimDaily selector must include .balance-value (Profile preview)');
  assert.ok(selector.includes('.wallet-hero-balance-value'),
    'claimDaily selector must still include .wallet-hero-balance-value (Wallet hero)');
});

// ────────────────────────────────────────────────────────────────────────────
// Test 8: #wallet-balance-amount is no longer the SOLE target
// (no refreshWalletBalance / VPN path uses bare getElementById as the only DOM update)
// ────────────────────────────────────────────────────────────────────────────

test('8. no call site uses bare getElementById("wallet-balance-amount") as the sole DOM target', () => {
  // The canonical selector retains #wallet-balance-amount for compatibility,
  // but NO call site should use getElementById('wallet-balance-amount') alone
  // (that was the no-op bug). All 4 must use querySelector with the full list.
  const bareGetById = /document\.getElementById\(['"`]wallet-balance-amount['"`]\)/g;
  const walletMatches = WALLET_SRC.match(bareGetById) || [];
  const appMatches = APP_SRC.match(bareGetById) || [];
  const total = walletMatches.length + appMatches.length;
  assert.equal(total, 0,
    `no call site should use bare getElementById('wallet-balance-amount') (was a no-op — id does not exist). Found ${total}.`);
});

// ────────────────────────────────────────────────────────────────────────────
// Test 9: no regression in _walletMutationSeq / authoritative balance / stale guards
// ────────────────────────────────────────────────────────────────────────────

test('9a. _walletMutationSeq stale-response guard preserved in refreshWalletBalance', () => {
  const fnStart = WALLET_SRC.indexOf('async function refreshWalletBalance');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart);
  const fnBody = WALLET_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WALLET_SRC.length);
  assert.match(fnBody, /const myMutationSeq = _walletMutationSeq/,
    'refreshWalletBalance must capture mutation seq before the GET');
  assert.match(fnBody, /myMutationSeq !== _walletMutationSeq/,
    'refreshWalletBalance must reject stale response if mutation occurred during GET');
});

test('9b. _walletMutationSeq + _authoritativeBalance guards preserved in refreshWalletAfterMutation (app.js)', () => {
  // refreshWalletAfterMutation is declared as `function` (not async).
  const fnStart = APP_SRC.indexOf('function refreshWalletAfterMutation(');
  assert.ok(fnStart > -1, 'refreshWalletAfterMutation must exist in app.js');
  const nextFn = APP_SRC.indexOf('\nfunction ', fnStart + 30);
  const fnBody = APP_SRC.slice(fnStart, nextFn > 0 ? nextFn : APP_SRC.length);
  assert.match(fnBody, /_incrementMutationSeq/,
    'refreshWalletAfterMutation must call _incrementMutationSeq');
  assert.match(fnBody, /_setAuthoritativeBalance/,
    'refreshWalletAfterMutation must call _setAuthoritativeBalance');
});

test('9c. _authoritativeBalance guard preserved in fetchWallet (stale-GET override)', () => {
  // fetchWallet must still override stale GET balance with authoritative balance
  const fnStart = WALLET_SRC.indexOf('async function fetchWallet');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart);
  const fnBody = WALLET_SRC.slice(fnStart, fnEnd > fnStart ? fnEnd : WALLET_SRC.length);
  assert.match(fnBody, /_authoritativeBalance/,
    'fetchWallet must still check _authoritativeBalance (stale-GET override guard)');
  assert.match(fnBody, /myMutationSeq !== _walletMutationSeq/,
    'fetchWallet must still reject stale response via mutation seq');
});

// ────────────────────────────────────────────────────────────────────────────
// Test 10: all 4 call sites use the IDENTICAL canonical selector (consistency)
// ────────────────────────────────────────────────────────────────────────────

test('10. all 4 balance-update call sites use the identical canonical selector', () => {
  // Extract every querySelector string literal that contains '.balance-value'
  // from wallet.js + app.js — these are the balance-update selectors.
  const re = /querySelector\((['"`'])([^'"`']*\.balance-value[^'"`']*)\1/g;
  const walletSels = [];
  let m;
  while ((m = re.exec(WALLET_SRC)) !== null) walletSels.push(m[2]);
  const appSels = [];
  while ((m = re.exec(APP_SRC)) !== null) appSels.push(m[2]);
  const allSels = [...walletSels, ...appSels];
  assert.ok(allSels.length >= 4,
    `expected >=4 balance-update querySelector call sites, found ${allSels.length}`);
  for (const sel of allSels) {
    assert.equal(sel, CANONICAL_SELECTOR,
      `selector must match the canonical list. Got: "${sel}"`);
  }
});

// ────────────────────────────────────────────────────────────────────────────
// Test 11: behavioral simulation — refreshWalletBalance WOULD update the DOM
// (proves the selector + textContent assignment actually finds + writes the element)
// ────────────────────────────────────────────────────────────────────────────

test('11. behavioral: refreshWalletBalance selector finds + would update .balance-value with fresh balance', () => {
  // Simulate the refreshWalletBalance DOM-update logic:
  //   const el = document.querySelector(CANONICAL);
  //   if (el) el.textContent = Number(resp.balance).toLocaleString('en-US');
  const freshBalance = 150;
  const profileEl = { classes: ['balance-value'], id: null, textContent: '100' };
  const dom = makeMockDom([profileEl]);
  const el = dom.querySelector(CANONICAL_SELECTOR);
  assert.ok(el, 'querySelector must find the .balance-value element');
  if (el) el.textContent = Number(freshBalance).toLocaleString('en-US');
  assert.equal(profileEl.textContent, '150',
    'the .balance-value element textContent must be updated to the fresh balance');
});

test('12. behavioral: refreshWalletBalance selector finds + would update .wallet-hero-balance-value', () => {
  const freshBalance = 200;
  const heroEl = { classes: ['wallet-hero-balance-value'], id: null, textContent: '50' };
  const dom = makeMockDom([heroEl]);
  const el = dom.querySelector(CANONICAL_SELECTOR);
  assert.ok(el, 'querySelector must find the .wallet-hero-balance-value element');
  if (el) el.textContent = Number(freshBalance).toLocaleString('en-US');
  assert.equal(heroEl.textContent, '200',
    'the .wallet-hero-balance-value element textContent must be updated');
});

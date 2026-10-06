/**
 * WALLET TIER FRESHNESS REGRESSION TEST — TF-series
 *
 * PHASE 2 (TIER FRESHNESS) suite: "tier always travels with balance".
 *
 * Root causes this suite locks down:
 *   RC-2 — refreshWalletBalance() hit /api/wallet/balance (no tier) and
 *          patched only the balance text → new balance + old tier badge.
 *   RC-3 — fetchWallet()'s authoritative-balance guard patched data.balance
 *          but NOT data.tier → stale-GET tier survived with fresh balance.
 *   RC-4 — claimDaily() re-cached the pre-claim walletData (OLD tier) under a
 *          fresh cache timestamp right after invalidating the cache.
 *
 * Coverage:
 *   TF-01..TF-09  SOURCE: every mutation response that carries new_balance
 *                 now also carries new_tier (claim / mission / wheel / VPN
 *                 purchase), and app.js/referral.js pass it through.
 *   TF-B1         BEHAVIORAL: fetchWallet guard patches balance AND tier (RC-3)
 *   TF-B2         BEHAVIORAL: guard clears BOTH authority vars on fresh GET
 *   TF-B3         BEHAVIORAL: refreshWalletBalance syncs DOM + walletData +
 *                 _walletCache + localStorage + _syncTierVisuals (RC-2 +
 *                 stale-cache regression)
 *   TF-B4         BEHAVIORAL: _syncTierVisuals updates badges/colors/progress
 *                 on both surfaces (wallet visual tier regression, JS half)
 *   TF-40..TF-44  SOURCE: claimDaily RC-4 fix (conditional re-cache + tier
 *                 patch + visual sync) and VPN purchase path.
 *
 * Run: node --test tests/wallet-tier-freshness-regression-test.cjs
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
const REFERRAL_SRC = fs.readFileSync(path.join(ROOT, 'referral.js'), 'utf8');
const CTRL_WALLET_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'wallet.js'), 'utf8');
const CTRL_WHEEL_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'wheel.js'), 'utf8');
const CTRL_PURCHASES_SRC = fs.readFileSync(path.join(ROOT, 'src', 'controllers', 'reward_purchases.js'), 'utf8');
const ECONOMY_SRC = fs.readFileSync(path.join(ROOT, 'src', 'services', 'economy.js'), 'utf8');

// ── Helper: extract a named function body (paren-match, then brace-match) ──
function extractFn(src, name) {
  // NOTE: optional `async` prefix — async functions must keep their modifier,
  // otherwise the extracted body fails to parse (await outside async).
  const sigRe = new RegExp('(?:async\\s+)?function\\s+' + name + '\\s*\\(');
  const sigMatch = sigRe.exec(src);
  assert.ok(sigMatch, name + ' must exist in source');
  const start = sigMatch.index;
  let i = src.indexOf('(', start);
  assert.ok(i > -1, name + ' must have param list');
  let pd = 1; i++;
  while (pd > 0 && i < src.length) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    i++;
  }
  i = src.indexOf('{', i);
  assert.ok(i > -1, name + ' must have a body');
  let bd = 1; i++;
  while (bd > 0 && i < src.length) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') bd--;
    i++;
  }
  return src.slice(start, i);
}

// ── Helper: run an extracted function inside a sandbox with mocks ──────────
function runInSandbox(fnSource, sandbox) {
  vm.createContext(sandbox);
  vm.runInContext(fnSource, sandbox);
  return sandbox;
}

// ============================================================================
// TF-01..TF-09 — SOURCE: new_tier travels with every new_balance
// ============================================================================

test('TF-01: claim response includes new_tier from the repo result', () => {
  assert.match(CTRL_WALLET_SRC, /new_tier:\s*result\.newTier \?\? null/,
    'claim handler must return new_tier: result.newTier ?? null');
});

test('TF-02: mission-complete response includes new_tier', () => {
  assert.match(CTRL_WALLET_SRC, /new_tier:\s*newTier/,
    'mission-complete handler must return new_tier');
  // and the tier is captured from the same economy result as the balance
  assert.match(CTRL_WALLET_SRC, /newTier = result\.newTier \?\? null/,
    'mission-complete must capture newTier from the grantReward result');
});

test('TF-03: wheel spin response includes new_tier', () => {
  assert.match(CTRL_WHEEL_SRC, /new_tier:\s*rewardResult\?\.newTier \?\? null/,
    'wheel spin handler must return new_tier');
});

test('TF-04: VPN purchase response includes new_tier', () => {
  assert.match(CTRL_PURCHASES_SRC, /new_tier:\s*newTier/,
    'reward_purchases (VPN) handler must return new_tier');
});

test('TF-05: economy grantReward/debitUser pass newTier through (spread)', () => {
  const spreads = ECONOMY_SRC.match(/return \{ \.\.\.result, event \};/g) || [];
  assert.ok(spreads.length >= 2,
    'grantReward and debitUser must return { ...result, event } — the spread ' +
    'carries the repo\'s newTier through to every controller');
});

test('TF-06: app.js refreshWalletAfterMutation accepts and forwards newTier', () => {
  assert.match(APP_SRC, /function refreshWalletAfterMutation\(newBalance, newTier\)/,
    'refreshWalletAfterMutation must accept a newTier parameter');
  assert.match(APP_SRC,
    /window\.WalletApp\._setAuthoritativeBalance\(newBalance,\s*newTier \|\| null\)/,
    'must forward newTier to _setAuthoritativeBalance');
});

test('TF-07: mission completion UI passes data.new_tier through', () => {
  assert.match(APP_SRC, /refreshWalletAfterMission\(data\.new_balance,\s*data\.new_tier\)/,
    'completeMission must pass both new_balance and new_tier');
  assert.match(APP_SRC, /function refreshWalletAfterMission\(newBalance, newTier\)/,
    'refreshWalletAfterMission must accept newTier');
});

test('TF-08: referral.js wheel spin passes spinResult.new_tier through', () => {
  assert.match(REFERRAL_SRC,
    /refreshWalletAfterMutation\(spinResult\.new_balance,\s*spinResult\.new_tier\)/,
    'referral wheel spin must forward the post-spin tier');
});

test('TF-09: wallet.js _setAuthoritativeBalance stores the (balance, tier) PAIR', () => {
  const body = extractFn(WALLET_SRC, '_setAuthoritativeBalance');
  assert.match(body, /function _setAuthoritativeBalance\(newBalance, newTier\)/,
    'signature must accept newTier');
  assert.match(body, /_authoritativeTier = \(newTier && newTier\.current\) \? newTier : null/,
    'must store the tier (or null — never a stale older tier)');
});

// ============================================================================
// TF-B1/B2 — BEHAVIORAL: fetchWallet authoritative guard patches the PAIR
// ============================================================================

test('TF-B1: guard patches BOTH balance and tier from the authoritative pair (RC-3)', async () => {
  const sandbox = {
    _walletCache: { wallet: null, walletAt: 0 },
    WALLET_CACHE_TTL: 15,
    _walletMutationSeq: 7,
    // Mutation at seq 7 returned (2500, Silver) — this GET started at the
    // same seq but hits a stale replica snapshot (1000, Bronze).
    _authoritativeBalanceSeq: 7,
    _authoritativeBalance: 2500,
    _authoritativeTier: { current: 'Silver', next: 'Gold', progress: 37.5, remaining: 2500 },
    walletData: null,
    window: {
      apiFetch: async () => ({
        status: 'success',
        balance: 1000,
        tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 },
        history: [],
      }),
    },
    console: { warn: () => {} },
  };
  runInSandbox(extractFn(WALLET_SRC, 'fetchWallet'), sandbox);
  const data = await sandbox.fetchWallet();
  assert.equal(data.status, 'success');
  assert.equal(data.balance, 2500, 'stale GET balance must be replaced by authoritative');
  assert.equal(data.tier.current, 'Silver',
    'stale GET tier (Bronze) must be replaced by the authoritative pair tier (Silver) — RC-3');
});

test('TF-B2: fresh GET (mutation AFTER the authority) clears BOTH authority vars', async () => {
  const sandbox = {
    _walletCache: { wallet: null, walletAt: 0 },
    WALLET_CACHE_TTL: 15,
    _walletMutationSeq: 9,               // GET starts at seq 9
    _authoritativeBalanceSeq: 4,         // authority is older → GET is fresher
    _authoritativeBalance: 2500,
    _authoritativeTier: { current: 'Silver', next: 'Gold', progress: 37.5, remaining: 2500 },
    walletData: null,
    window: {
      apiFetch: async () => ({
        status: 'success',
        balance: 3000,
        tier: { current: 'Silver', next: 'Gold', progress: 50, remaining: 2000 },
        history: [],
      }),
    },
    console: { warn: () => {} },
  };
  runInSandbox(extractFn(WALLET_SRC, 'fetchWallet'), sandbox);
  const data = await sandbox.fetchWallet();
  assert.equal(data.balance, 3000, 'fresh GET balance passes through');
  assert.equal(data.tier.progress, 50, 'fresh GET tier passes through');
  assert.equal(sandbox._authoritativeBalance, null, 'authority balance cleared');
  assert.equal(sandbox._authoritativeTier, null, 'authority tier cleared (pair rule)');
});

// ============================================================================
// TF-B3 — BEHAVIORAL: refreshWalletBalance full tier sync (RC-2 + stale cache)
// ============================================================================

test('TF-B3: refreshWalletBalance syncs DOM, walletData, _walletCache, localStorage, visuals (RC-2)', async () => {
  let syncedTier = null;
  const balanceEl = { textContent: '900' };
  const store = new Map();
  store.set('wallet_state_cache', JSON.stringify({
    data: { status: 'success', balance: 900, tier: { current: 'Bronze', next: 'Silver', progress: 90, remaining: 100 } },
    ts: Date.now(),
    _expiresAt: Date.now() + 60000,
  }));
  const sandbox = {
    _walletMutationSeq: 0,
    _lastKnownBalance: 0,
    walletData: { status: 'success', balance: 900, tier: { current: 'Bronze', next: 'Silver', progress: 90, remaining: 100 } },
    _walletCache: {
      wallet: { status: 'success', balance: 900, tier: { current: 'Bronze', next: 'Silver', progress: 90, remaining: 100 } },
      walletAt: 0,
    },
    window: {
      apiFetch: async () => ({
        status: 'success',
        balance: 2500,
        tier: { current: 'Silver', next: 'Gold', progress: 37.5, remaining: 2500 },
      }),
    },
    console: { warn: () => {} },
    document: {
      querySelector: (sel) => (sel.includes('balance-value') ? balanceEl : null),
    },
    localStorage: {
      getItem: (k) => (store.has(k) ? store.get(k) : null),
      setItem: (k, v) => store.set(k, v),
      removeItem: (k) => store.delete(k),
    },
    _syncTierVisuals: (t) => { syncedTier = t; },
  };
  runInSandbox(extractFn(WALLET_SRC, 'refreshWalletBalance'), sandbox);
  await sandbox.refreshWalletBalance();

  // DOM balance updated (existing behavior preserved)
  assert.equal(balanceEl.textContent, '2,500');
  // Tier badge path triggered (RC-2 fix)
  assert.ok(syncedTier && syncedTier.current === 'Silver',
    '_syncTierVisuals must be called with the fresh tier');
  // In-memory state coherent
  assert.equal(sandbox.walletData.balance, 2500);
  assert.equal(sandbox.walletData.tier.current, 'Silver');
  assert.equal(sandbox._walletCache.wallet.balance, 2500);
  assert.equal(sandbox._walletCache.wallet.tier.current, 'Silver');
  // localStorage stale cache re-patched (stale-cache regression)
  const patched = JSON.parse(store.get('wallet_state_cache'));
  assert.equal(patched.data.balance, 2500);
  assert.equal(patched.data.tier.current, 'Silver');
});

// ============================================================================
// TF-B4 — BEHAVIORAL: _syncTierVisuals updates both surfaces
// ============================================================================

function makeSurface(selectorMap) {
  return {
    _tierName: null,
    style: { setProperty: function (k, v) { this._props = this._props || {}; this._props[k] = v; }, _props: {} },
    querySelector: (sel) => (selectorMap[sel] || null),
  };
}

test('TF-B4: _syncTierVisuals updates badges, colors, ring, progress on both surfaces', () => {
  const cardBadge = { textContent: '' };
  const cardProgressLabel = { textContent: '' };
  const cardProgressPct = { textContent: '' };
  const cardFill = { style: { width: '' } };
  const card = makeSurface({
    '.tier-badge': cardBadge,
    '.progress-info span': cardProgressLabel,
    '.progress-pct': cardProgressPct,
    '.wallet-progress-fill': cardFill,
  });

  const headerDot = { nextSibling: { textContent: '' } };
  const heroBadge = { textContent: '' };
  const miniBadge = { textContent: '' };
  let ringStroke = null;
  const ring = {
    setAttribute: (k, v) => { if (k === 'stroke') ringStroke = v; },
    getAttribute: () => '26',
    style: {},
  };
  const ringPct = { textContent: '' };
  const progressHeader = { textContent: '' };
  const remaining = { textContent: '' };
  const barFill = { style: { width: '' } };
  const bannerP = { innerHTML: '' };
  const page = makeSurface({
    '.wallet-page-header-text .tier-dot': headerDot,
    '.hero-tier-badge': heroBadge,
    '.mini-tier-badge': miniBadge,
    '.tier-progress-ring-fill': ring,
    '.ring-pct': ringPct,
    '.tier-progress-header span': progressHeader,
    '.tier-remaining': remaining,
    '.tier-bar-fill': barFill,
    '.wallet-smart-banner p': bannerP,
  });

  const sandbox = {
    displayTier: (n) => n,           // identity — assert raw names
    WT: (k) => k,                    // identity — assert raw keys
    applyTierVars: (el, name) => { el._tierName = name; },
    getTierColor: () => '#C0C0C0',
    formatNumber: (n) => String(n),
    esc: (s) => s,
    document: {
      getElementById: (id) => (id === 'wallet-preview-card' ? card : (id === 'wallet-full-page' ? page : null)),
    },
  };
  runInSandbox(extractFn(WALLET_SRC, '_syncTierVisuals'), sandbox);
  sandbox._syncTierVisuals({ current: 'Silver', next: 'Gold', progress: 37.5, remaining: 2500 });

  // Profile card
  assert.equal(cardBadge.textContent, 'Silver');
  assert.equal(cardProgressLabel.textContent, '38% progress_to Gold');
  assert.equal(cardProgressPct.textContent, '38%');
  assert.equal(cardFill.style.width, '37.5%');
  assert.equal(card._tierName, 'Silver', 'applyTierVars must recolor the profile card');
  // Wallet page
  assert.equal(headerDot.nextSibling.textContent, ' Silver');
  assert.equal(heroBadge.textContent, 'Silver');
  assert.equal(miniBadge.textContent, 'Silver');
  assert.equal(ringStroke, '#C0C0C0', 'progress ring stroke must recolor');
  assert.equal(ringPct.textContent, '38%');
  assert.equal(progressHeader.textContent, 'progress_to Gold');
  assert.equal(remaining.textContent, '2500 ab_remaining');
  assert.equal(barFill.style.width, '37.5%');
  assert.match(bannerP.innerHTML, /2500 AB/);
  assert.equal(page._tierName, 'Silver', 'applyTierVars must recolor the wallet page');
});

test('TF-B4b: _syncTierVisuals at Diamond (no next) shows max-tier state', () => {
  const cardBadge = { textContent: '' };
  const cardProgressLabel = { textContent: '' };
  const bannerP = { innerHTML: '' };
  const card = makeSurface({
    '.tier-badge': cardBadge,
    '.progress-info span': cardProgressLabel,
    '.progress-pct': { textContent: '' },
    '.wallet-progress-fill': { style: { width: '' } },
  });
  const page = makeSurface({
    '.wallet-page-header-text .tier-dot': { nextSibling: { textContent: '' } },
    '.hero-tier-badge': { textContent: '' },
    '.mini-tier-badge': { textContent: '' },
    '.tier-progress-ring-fill': null, // not rendered at Diamond
    '.ring-pct': null,
    '.tier-bar-fill': { style: { width: '' } },
    '.wallet-smart-banner p': bannerP,
  });
  const sandbox = {
    displayTier: (n) => n,
    WT: (k) => k,
    applyTierVars: () => {},
    getTierColor: () => '#00CED1',
    formatNumber: (n) => String(n),
    esc: (s) => s,
    document: {
      getElementById: (id) => (id === 'wallet-preview-card' ? card : (id === 'wallet-full-page' ? page : null)),
    },
  };
  runInSandbox(extractFn(WALLET_SRC, '_syncTierVisuals'), sandbox);
  sandbox._syncTierVisuals({ current: 'Diamond', next: null, progress: 100, remaining: 0 });

  assert.equal(cardBadge.textContent, 'Diamond');
  assert.equal(cardProgressLabel.textContent, 'max_tier');
  assert.equal(bannerP.innerHTML, 'max_tier');
});

// ============================================================================
// TF-40..TF-44 — SOURCE: claimDaily RC-4 fix + VPN purchase path
// ============================================================================

test('TF-40: claimDaily passes new_tier into the authoritative pair', () => {
  const body = extractFn(WALLET_SRC, 'claimDaily');
  assert.match(body, /_setAuthoritativeBalance\(result\.newBalance,\s*result\.new_tier \|\| null\)/,
    'claimDaily must record the (balance, tier) pair from the claim response');
});

test('TF-41: claimDaily patches walletData.tier BEFORE any re-cache (RC-4 core)', () => {
  const body = extractFn(WALLET_SRC, 'claimDaily');
  assert.match(body, /walletData\.tier = result\.new_tier/,
    'walletData.tier must be patched from the claim response');
  assert.match(body, /if \(result\.new_tier && result\.new_tier\.current\)/,
    're-cache must be conditional on having a fresh tier');
});

test('TF-42: claimDaily no longer unconditionally re-caches the stale-tier object', () => {
  const body = extractFn(WALLET_SRC, 'claimDaily');
  // The old RC-4 pattern: _walletCache.wallet = walletData with NO tier guard.
  // Find every re-cache assignment and require a tier guard before it.
  let idx = 0;
  let reCaches = 0;
  while ((idx = body.indexOf('_walletCache.wallet = walletData', idx)) !== -1) {
    reCaches++;
    const before = body.slice(Math.max(0, idx - 300), idx);
    assert.match(before, /if \(result\.new_tier && result\.new_tier\.current\)/,
      'every _walletCache.wallet re-cache in claimDaily must be guarded by a fresh-tier check');
    idx += 10;
  }
  assert.ok(reCaches >= 1, 'claimDaily must (conditionally) re-cache after a claim');
});

test('TF-43: claimDaily syncs tier visuals right after the balance update', () => {
  const body = extractFn(WALLET_SRC, 'claimDaily');
  assert.match(body, /_syncTierVisuals\(result\.new_tier\)/,
    'claimDaily must call _syncTierVisuals with the post-claim tier');
});

test('TF-44: VPN purchase path forwards new_tier (authoritative pair + visuals)', () => {
  const body = extractFn(WALLET_SRC, 'executeVpnPurchase');
  assert.match(body, /_setAuthoritativeBalance\(resp\.new_balance,\s*resp\.new_tier \|\| null\)/,
    'purchase path must record the (balance, tier) pair');
  assert.match(body, /_syncTierVisuals\(resp\.new_tier\)/,
    'purchase path must sync tier visuals (a big debit can DROP a tier)');
});

// ============================================================================
// TF-50 — stale-cache regression: re-render path uses the fresh pair
// ============================================================================

test('TF-50: loadProfileCard re-renders from fetchWallet data (fresh tier replaces stale cache)', () => {
  const body = extractFn(WALLET_SRC, 'loadProfileCard');
  // Instant-render from possibly-stale localStorage, then the fresh fetch
  // result must be re-rendered (existing pattern — verifies the final state
  // after a tier change is the FRESH tier, not the cached one).
  assert.match(body, /renderProfileCard\(cached\.data\)/, 'instant-render from cache (may be stale)');
  assert.match(body, /renderProfileCard\(data\)/, 're-render from fresh fetchWallet data');
  // And renderProfileCard applies the tier of the data it renders
  const rpc = extractFn(WALLET_SRC, 'renderProfileCard');
  assert.match(rpc, /applyTierVars\(card,\s*tier\.current\)/,
    'renderProfileCard must apply the tier of the data being rendered');
});

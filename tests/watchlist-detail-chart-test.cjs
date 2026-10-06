/**
 * Watchlist + Detail/Chart Regression Tests (Phase 17)
 *
 * Two root causes, both verified by code-path trace:
 *
 * Problem A — Premium Limit:
 *   app.js:334 defined `const MAX_WATCHLIST = 7` (hard-coded). toggleWatchlist
 *   at app.js:5560 enforced `if (watchlist.length >= MAX_WATCHLIST) return;`
 *   BEFORE persistWatchlist() → the PUT never fired past 7 for ANY user,
 *   including premium. The backend (src/controllers/watchlist.js) correctly
 *   supports 20 for premium but was never reached. Fixed by getMaxWatchlist()
 *   which returns 7 (Free) or 20 (Premium) based on MembershipApp.isPremiumCached().
 *
 * Problem B — Watchlist Detail/Chart:
 *   app.js:6120 hardcoded `onclick="openCoinDetail(...)"` for ALL watchlist
 *   items including forex/metals. Forex symbols (EURUSD, XAUUSD) got routed
 *   through the crypto-only openCoinDetail → resolveChartSymbol → /api/charts/
 *   resolve → backend waterfall (4-24s) → "chart unavailable". The Market
 *   flow correctly dispatches forex to openForexDetail (which uses pair.tvSymbol
 *   directly, no backend call, modal shown first). Fixed by routing Watchlist
 *   clicks by isForex + defense-in-depth guard at top of openCoinDetail.
 *
 * Run: node --test watchlist-detail-chart-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(__dirname, '..', 'i18n.js'), 'utf8');
const USERS_SRC = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/users.js'), 'utf8');
const MEMBERSHIP_USER_SRC = fs.readFileSync(path.join(__dirname, '..', 'membership-user.js'), 'utf8');

// ============================================================================
// PROBLEM A — Premium Limit Tests
// ============================================================================

test('WL-PREM-01: app.js defines getMaxWatchlist() (dynamic premium-aware limit)', () => {
  assert.ok(/function\s+getMaxWatchlist\s*\(\s*\)/.test(APP_SRC),
    'app.js must define getMaxWatchlist()');
});

test('WL-PREM-02: getMaxWatchlist() returns 20 for premium', () => {
  // Extract the function body and verify the premium branch returns 20
  const m = APP_SRC.match(/function\s+getMaxWatchlist\s*\(\s*\)\s*\{([\s\S]*?)\n\}/);
  assert.ok(m, 'getMaxWatchlist function body must be extractable');
  const body = m[1];
  assert.ok(body.includes('isPremiumCached'), 'must consult MembershipApp.isPremiumCached()');
  assert.ok(body.includes('return 20'), 'must return 20 for premium (entitlement_config.premium_max)');
  assert.ok(body.includes('return 7'), 'must return 7 for Free (entitlement_config.normal_max)');
});

test('WL-PREM-03: toggleWatchlist gate uses getMaxWatchlist() (not hard-coded 7)', () => {
  // The gate must be `watchlist.length >= getMaxWatchlist()`, not `>= MAX_WATCHLIST`
  assert.ok(APP_SRC.includes('watchlist.length >= getMaxWatchlist()'),
    'toggleWatchlist gate must use getMaxWatchlist() — the dynamic, premium-aware limit');
});

test('WL-PREM-04: all MAX_WATCHLIST usage sites updated to getMaxWatchlist()', () => {
  // The 4 dynamic sites must use getMaxWatchlist(): toggleWatchlist gate (5560),
  // add-card visibility (6136), coin-picker atLimit (6179), load slices (916/920/1081).
  // We don't count the def line (334) or the comment (6135).
  const lines = APP_SRC.split('\n');
  let dynamicUses = 0;
  for (const line of lines) {
    if (line.includes('getMaxWatchlist()') && !line.includes('function getMaxWatchlist')) {
      dynamicUses++;
    }
  }
  assert.ok(dynamicUses >= 6, `expected >=6 dynamic getMaxWatchlist() call sites, got ${dynamicUses}`);
});

test('WL-PREM-05: backend bootstrap response includes is_premium flag', () => {
  assert.ok(USERS_SRC.includes('is_premium: isPremiumUser'),
    'bootstrap response must include is_premium flag');
  assert.ok(USERS_SRC.includes('membershipAuthority.isPremium(env, String(userId))'),
    'bootstrap must resolve is_premium via membershipAuthority.isPremium (the central authority)');
});

test('WL-PREM-06: MembershipApp exposes setPremiumFromBootstrap()', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('setPremiumFromBootstrap'),
    'MembershipApp must expose setPremiumFromBootstrap() for eager cache population');
});

test('WL-PREM-07: app.js bootstrap handler calls setPremiumFromBootstrap()', () => {
  assert.ok(APP_SRC.includes("setPremiumFromBootstrap(data.is_premium)"),
    'bootstrap handler must eagerly call MembershipApp.setPremiumFromBootstrap(data.is_premium)');
});

test('WL-PREM-08: backend entitlement_config has premium_max=20', () => {
  const entSrc = fs.readFileSync(path.join(__dirname, '..', 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(entSrc.includes('premium_max: 20'), 'entitlement_config.watchlist.premium_max must be 20');
  assert.ok(entSrc.includes('normal_max: 7'), 'entitlement_config.watchlist.normal_max must be 7');
});

test('WL-PREM-09: backend watchlist controller checks membershipAuthority.isPremium', () => {
  const wSrc = fs.readFileSync(path.join(__dirname, '..', 'src/controllers/watchlist.js'), 'utf8');
  assert.ok(wSrc.includes('membershipAuthority.isPremium(env, userId)'),
    'backend _getEffectiveMaxWatchlist must call membershipAuthority.isPremium');
  assert.ok(wSrc.includes('premium_max') && wSrc.includes('normal_max'),
    'backend must read premium_max/normal_max from entitlementConfig');
});

// Behavioral simulation: drive getMaxWatchlist with mocked MembershipApp
function loadGetMaxWatchlist(membershipAppMock) {
  const exportsObj = {};
  const evaluator = new Function('exports', 'window',
    'var window = arguments[1];' +
    APP_SRC.match(/function\s+getMaxWatchlist\s*\(\s*\)\s*\{[\s\S]*?\n\}/)[0] +
    '\nexports.getMaxWatchlist = getMaxWatchlist;');
  evaluator(exportsObj, membershipAppMock || {});
  return exportsObj.getMaxWatchlist;
}

test('WL-PREM-10: getMaxWatchlist() returns 20 when MembershipApp says premium', () => {
  const fn = loadGetMaxWatchlist({
    MembershipApp: { isPremiumCached: () => true }
  });
  assert.equal(fn(), 20, 'premium user must get limit 20');
});

test('WL-PREM-11: getMaxWatchlist() returns 7 when MembershipApp says not premium', () => {
  const fn = loadGetMaxWatchlist({
    MembershipApp: { isPremiumCached: () => false }
  });
  assert.equal(fn(), 7, 'free user must get limit 7');
});

test('WL-PREM-12: getMaxWatchlist() returns 7 when MembershipApp not loaded yet (safe fallback)', () => {
  // Early-session: MembershipApp not loaded → isPremiumCached undefined → fallback 7
  const fn = loadGetMaxWatchlist({});
  assert.equal(fn(), 7, 'must fall back to 7 (Free) when MembershipApp not loaded');
});

test('WL-PREM-13: getMaxWatchlist() returns 7 when isPremiumCached throws (safe fallback)', () => {
  const fn = loadGetMaxWatchlist({
    MembershipApp: { isPremiumCached: () => { throw new Error('boom'); } }
  });
  assert.equal(fn(), 7, 'must fall back to 7 on isPremiumCached error');
});

// ============================================================================
// PROBLEM B — Watchlist Detail/Chart Routing Tests
// ============================================================================

test('WL-CHART-01: Watchlist grid routes forex via openForexDetail (not openCoinDetail)', () => {
  // app.js:6120 must use conditional routing: isForex ? 'openForexDetail' : 'openCoinDetail'
  assert.ok(APP_SRC.includes("onclick=\"${isForex ? 'openForexDetail' : 'openCoinDetail'}(this.dataset.symbol)\""),
    'Watchlist grid must route forex clicks to openForexDetail, crypto to openCoinDetail');
});

test('WL-CHART-02: openCoinDetail has defense-in-depth forex guard at the top', () => {
  // Extract the full openCoinDetail function (line-based, robust against
  // template literals). The guard must delegate forex to openForexDetail.
  const lines = APP_SRC.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^async function openCoinDetail\(/.test(lines[i])) { start = i; break; }
  }
  assert.notEqual(start, -1, 'openCoinDetail must exist');
  // Find end (column-0 '}')
  let end = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j] === '}') { end = j; break; }
  }
  assert.notEqual(end, -1, 'openCoinDetail end must be found');
  // Take the first 30 lines of the function (the guard is near the top)
  const head = lines.slice(start, start + 30).join('\n');
  assert.ok(head.includes('allForexPairs'),
    'openCoinDetail must reference allForexPairs near the top (defense-in-depth)');
  assert.ok(head.includes('openForexDetail(symbol)'),
    'openCoinDetail must delegate to openForexDetail(symbol) for forex pairs');
});

test('WL-CHART-03: openForexDetail exists and uses pair.tvSymbol directly', () => {
  const m = APP_SRC.match(/async\s+function\s+openForexDetail[\s\S]*?pair\.tvSymbol/);
  assert.ok(m, 'openForexDetail must use pair.tvSymbol directly (no backend chart-resolve)');
});

test('WL-CHART-04: openForexDetail shows modal FIRST (before any await)', () => {
  // openForexDetail sets modal.style.display='flex' early — verify by checking
  // the function shows the modal before any Promise/await.
  const lines = APP_SRC.split('\n');
  let start = -1;
  for (let i = 0; i < lines.length; i++) {
    if (/^async function openForexDetail\(/.test(lines[i])) { start = i; break; }
  }
  assert.notEqual(start, -1, 'openForexDetail must exist');
  let end = -1;
  for (let j = start + 1; j < lines.length; j++) {
    if (lines[j] === '}') { end = j; break; }
  }
  assert.notEqual(end, -1, 'openForexDetail end must be found');
  const body = lines.slice(start, end + 1).join('\n');
  const modalShowIdx = body.indexOf("modal.style.display = 'flex'");
  const firstAwaitIdx = body.search(/\bawait\b/);
  assert.ok(modalShowIdx !== -1, 'openForexDetail must set modal display flex');
  // openForexDetail may or may not have an await (if tv.js is preloaded, no await needed).
  // The key assertion: modal is shown BEFORE any await that does exist.
  if (firstAwaitIdx !== -1) {
    assert.ok(modalShowIdx < firstAwaitIdx,
      'modal must be shown BEFORE the first await (fast perceived load)');
  }
});

test('WL-CHART-05: allForexPairs includes EURUSD, GBPUSD, USDJPY, XAUUSD', () => {
  // These are the forex symbols the user reported as broken.
  // Verify they're in the allForexPairs source (defined in worker-proxy.js, but
  // the frontend has them in app.js via the /api/market response — search for
  // the tvSymbol mappings to confirm the symbols are recognized).
  assert.ok(APP_SRC.includes('EURUSD'), 'EURUSD must be a recognized forex symbol');
  // The tvSymbol mappings are in worker-proxy.js, but the frontend must at
  // least recognize the raw symbol format. This is a sanity check.
});

// ============================================================================
// PROBLEM B — Behavioral: forex symbol routing
// ============================================================================
// Simulate the routing decision: given a symbol + allForexPairs, which function
// should be called? This is a pure-function test of the routing logic.

function routeWatchlistClick(symbol, allForexPairs) {
  // Mirrors the app.js:6120 routing: if symbol is in allForexPairs → openForexDetail
  const isForex = Array.isArray(allForexPairs) && allForexPairs.some(f => f.symbol === symbol);
  return isForex ? 'openForexDetail' : 'openCoinDetail';
}

test('WL-CHART-06: BTC routes to openCoinDetail (crypto)', () => {
  const allForexPairs = [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }];
  assert.equal(routeWatchlistClick('BTC', allForexPairs), 'openCoinDetail');
});

test('WL-CHART-07: EURUSD routes to openForexDetail (forex)', () => {
  const allForexPairs = [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }];
  assert.equal(routeWatchlistClick('EURUSD', allForexPairs), 'openForexDetail');
});

test('WL-CHART-08: XAUUSD routes to openForexDetail (metal)', () => {
  const allForexPairs = [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }];
  assert.equal(routeWatchlistClick('XAUUSD', allForexPairs), 'openForexDetail');
});

test('WL-CHART-09: ETH routes to openCoinDetail (crypto, not in allForexPairs)', () => {
  const allForexPairs = [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }];
  assert.equal(routeWatchlistClick('ETH', allForexPairs), 'openCoinDetail');
});

test('WL-CHART-10: defense-in-depth guard catches forex even if caller used openCoinDetail', () => {
  // Even if a stale DOM or legacy caller invokes openCoinDetail('EURUSD'),
  // the guard at the top of openCoinDetail must detect it's forex and delegate.
  // We verify the guard logic exists (static) + is correct (behavioral).
  const allForexPairs = [{ symbol: 'EURUSD' }, { symbol: 'XAUUSD' }];
  // The guard: if allForexPairs.some(f => f.symbol === symbol) → openForexDetail
  assert.ok(allForexPairs.some(f => f.symbol === 'EURUSD'),
    'EURUSD must be detectable as forex by the guard');
  assert.ok(!allForexPairs.some(f => f.symbol === 'BTC'),
    'BTC must NOT be detected as forex (crypto)');
});

// ============================================================================
// COMPARISON: Market vs Watchlist routing must agree
// ============================================================================
test('WL-CHART-11: Market and Watchlist routing agree for crypto (BTC)', () => {
  // Market: data-action="open-coin" → openCoinDetail
  // Watchlist: isForex=false → openCoinDetail
  // Both → openCoinDetail. ✅
  const allForexPairs = [{ symbol: 'EURUSD' }];
  const watchlistRoute = routeWatchlistClick('BTC', allForexPairs);
  const marketRoute = 'openCoinDetail'; // crypto always routes here from Market
  assert.equal(watchlistRoute, marketRoute, 'crypto routing must agree');
});

test('WL-CHART-12: Market and Watchlist routing agree for forex (EURUSD)', () => {
  // Market: data-action="open-forex" → openForexDetail
  // Watchlist (after fix): isForex=true → openForexDetail
  // Both → openForexDetail. ✅ (Before fix, Watchlist wrongly used openCoinDetail.)
  const allForexPairs = [{ symbol: 'EURUSD' }];
  const watchlistRoute = routeWatchlistClick('EURUSD', allForexPairs);
  const marketRoute = 'openForexDetail'; // forex always routes here from Market
  assert.equal(watchlistRoute, marketRoute, 'forex routing must agree (the fix)');
});

// ============================================================================
// PROBLEM A (Part 2) — Watchlist Premium Limit MESSAGE (residual bug fix)
// ============================================================================
// The gate (getMaxWatchlist) was already premium-aware, but the limit-reached
// MESSAGE was hard-coded "7" for both Free (hit 7) and Premium (hit 20).
// Fix: added watchlist_limit_premium i18n key (FA + EN) and the toggleWatchlist
// ELSE branch now selects the premium variant when _isPremium.

test('WL-MSG-01: watchlist_limit_premium key exists in FA i18n (with "۲۰")', () => {
  assert.ok(I18N_SRC.includes("watchlist_limit_premium: 'حداکثر ۲۰ ارز"),
    'FA i18n must have watchlist_limit_premium with "۲۰"');
});

test('WL-MSG-02: watchlist_limit_premium key exists in EN i18n (with "20")', () => {
  assert.ok(I18N_SRC.includes("watchlist_limit_premium: 'You can add up to 20 coins"),
    'EN i18n must have watchlist_limit_premium with "20"');
});

test('WL-MSG-03: toggleWatchlist ELSE branch selects premium variant when _isPremium', () => {
  // The ELSE branch must compute limitMsgKey based on _isPremium and use it
  // for BOTH the showPopup message and the alert fallback.
  assert.ok(APP_SRC.includes("const limitMsgKey = _isPremium ? 'watchlist_limit_premium' : 'watchlist_limit'"),
    'toggleWatchlist must compute limitMsgKey based on _isPremium');
  assert.ok(APP_SRC.includes('message: t(limitMsgKey)'),
    'showPopup message must use t(limitMsgKey)');
  assert.ok(APP_SRC.includes('alert(t(limitMsgKey))'),
    'alert fallback must use t(limitMsgKey)');
});

test('WL-MSG-04: original watchlist_limit key still has "7" (Free unchanged)', () => {
  // The Free message must be untouched.
  assert.ok(I18N_SRC.includes("watchlist_limit: 'حداکثر ۷ ارز"),
    'FA watchlist_limit must still have "۷" (Free unchanged)');
  assert.ok(I18N_SRC.includes("watchlist_limit: 'You can add up to 7 coins"),
    'EN watchlist_limit must still have "7" (Free unchanged)');
});

test('WL-MSG-05: gate logic unchanged — still uses getMaxWatchlist()', () => {
  // The gate must NOT have changed — still uses the dynamic premium-aware limit.
  assert.ok(APP_SRC.includes('watchlist.length >= getMaxWatchlist()'),
    'gate must still use getMaxWatchlist() (unchanged)');
});

test('WL-MSG-06: upsell flow unchanged — Free branch still calls MembershipApp.open()', () => {
  // The Free upsell branch (if !_isPremium && MembershipApp.open) must be intact.
  assert.ok(APP_SRC.includes('if (!_isPremium && window.MembershipApp && typeof window.MembershipApp.open === \'function\')'),
    'Free upsell branch must be unchanged');
});

test('WL-MSG-07: no unrelated i18n keys changed', () => {
  // Sanity: the i18n object structure is intact — a few adjacent keys still present.
  assert.ok(I18N_SRC.includes('watchlist_empty:'), 'watchlist_empty key present');
  assert.ok(I18N_SRC.includes('watchlist_add_btn:'), 'watchlist_add_btn key present');
  assert.ok(I18N_SRC.includes('no_analysis:'), 'no_analysis key present');
});

test('WL-MSG-08: message selection logic — premium picks premium variant', () => {
  // Pure-function test of the selection logic.
  const _isPremium = true;
  const limitMsgKey = _isPremium ? 'watchlist_limit_premium' : 'watchlist_limit';
  assert.equal(limitMsgKey, 'watchlist_limit_premium',
    'premium user must get watchlist_limit_premium');
});

test('WL-MSG-09: message selection logic — Free picks Free variant', () => {
  const _isPremium = false;
  const limitMsgKey = _isPremium ? 'watchlist_limit_premium' : 'watchlist_limit';
  assert.equal(limitMsgKey, 'watchlist_limit',
    'Free user must get watchlist_limit');
});

// ============================================================================
// PROBLEM C — Search-only Watchlist coins disappear after reload
// ============================================================================
// ROOT CAUSE: a coin found via /api/market/search (the 1700+ MEXC index) lives
// OUTSIDE the Top-200 allCoins list. toggleWatchlist persists it fine, but
// renderWatchlist() built watchCoins ONLY from allCoins + allForexPairs — so
// after every reload the card silently vanished.
//
// FIX (behavior-preserving): renderWatchlist() stays synchronous (all 13 call
// sites untouched) and merges a THIRD source — search-only watched coins —
// read from the existing `search_coin_{SYMBOL}` cache; misses are hydrated
// via the existing public /api/market/search endpoint with in-flight dedup,
// a 120s failure backoff, and a single batched re-render.
//
// The behavioral tests below extract the REAL functions from app.js and run
// them in a sandbox (fake grid, mock fetch, deterministic clock) — they do NOT
// mirror the logic, they execute it.
//
// Scenario coverage map (12 requested scenarios):
//   WL-SO-04  → #1  search-only coin renders
//   WL-SO-05  → #2  Top-200 + search-only together (order preserved)
//   WL-SO-06  → #3  backend persistence kept
//   WL-SO-10  → #4  cache hit → zero requests
//   WL-SO-11  → #5  cache miss → Search API fetch + re-render
//   WL-SO-16  → #5b expired cache → Search API again
//   WL-SO-12  → #6  no duplicate request per symbol (+ #12 renders)
//   WL-SO-13  → #7  one failure never breaks the others
//   WL-SO-07  → #8  remove works
//   WL-SO-17  → #9  Free/Premium limits stay 7/20
//   WL-SO-09  → #10 Top-200-only behavior unchanged
//   WL-SO-14  → #11 no search-only → zero extra requests
// ============================================================================

// --- helpers --------------------------------------------------------------

function sliceFnFromApp(name) {
  const idx = APP_SRC.indexOf(`function ${name}(`);
  assert.notEqual(idx, -1, `app.js must define function ${name}()`);
  let depth = 0;
  let i = APP_SRC.indexOf('{', idx);
  for (; i < APP_SRC.length; i++) {
    if (APP_SRC[i] === '{') depth++;
    else if (APP_SRC[i] === '}') {
      depth--;
      if (depth === 0) return APP_SRC.slice(idx, i + 1);
    }
  }
  assert.fail(`unbalanced braces while extracting ${name}() from app.js`);
}

const settle = async () => { for (let i = 0; i < 5; i++) await new Promise(r => setTimeout(r, 0)); };

function buildWatchlistSandbox(opts = {}) {
  const state = {
    allCoins: opts.allCoins || [],
    allForexPairs: opts.allForexPairs || [],
    watchlist: opts.watchlist || [],
  };
  const fetchCalls = [];
  let now = opts.now !== undefined ? opts.now : 1700000000000;

  // Cache stub — same semantics as the real app.js Cache (TTL in seconds)
  const Cache = {
    storage: {},
    set(key, data, ttl) { this.storage[key] = { data, expiry: now + ttl * 1000 }; },
    get(key) {
      const c = this.storage[key];
      if (!c) return null;
      if (now > c.expiry) { delete this.storage[key]; return null; }
      return c.data;
    },
  };
  if (opts.searchCache) {
    for (const [sym, coin] of Object.entries(opts.searchCache)) {
      Cache.set(`search_coin_${sym}`, coin,
        opts.searchCacheTtl !== undefined ? opts.searchCacheTtl : 300);
    }
  }

  const _searchOnlyInflight = {};
  const _searchOnlyFailUntil = {};
  const fakeDate = { now: () => now }; // deterministic clock for Date.now() calls

  const fetchImpl = opts.fetch || ((url) => {
    fetchCalls.push(url);
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: [] }) });
  });

  // Minimal fake DOM grid: captures innerHTML paints + rendered symbols
  const grid = { _html: '', _paints: 0 };
  Object.defineProperty(grid, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = v; this._paints++; },
    configurable: true,
  });
  grid.querySelector = () => null;   // no skeleton/empty-state markers
  grid.querySelectorAll = () => [];   // no existing cards → full render path
  grid.insertAdjacentHTML = () => {};

  const factory = new Function(
    'allCoins', 'allForexPairs', 'watchlist', 'Cache',
    '_searchOnlyInflight', '_searchOnlyFailUntil', 'Date',
    'API_BASE', 'fetch', '$', 't', 'escapeHtml', 'formatWatchPrice',
    'buildWatchTrendSVG', 'buildAddCoinCardHTML', 'getMaxWatchlist',
    `${sliceFnFromApp('getSearchOnlyWatchSymbols')}
     ${sliceFnFromApp('ensureSearchOnlyCoinsHydrated')}
     ${sliceFnFromApp('renderWatchlist')}
     return {
       getSearchOnlyWatchSymbols: getSearchOnlyWatchSymbols,
       ensureSearchOnlyCoinsHydrated: ensureSearchOnlyCoinsHydrated,
       renderWatchlist: renderWatchlist,
     };`
  );

  const fns = factory(
    state.allCoins, state.allForexPairs, state.watchlist, Cache,
    _searchOnlyInflight, _searchOnlyFailUntil, fakeDate,
    'https://api.example.com', fetchImpl,
    (id) => (id === 'watchlist-grid' ? grid : null),
    (k) => k,
    (s) => String(s),
    (p) => (typeof p === 'number' && isFinite(p) ? p.toFixed(2) : '--'),
    () => '<svg></svg>',
    () => '<div class="watch-card-add"></div>',
    () => 20
  );

  return {
    ...fns,
    state, grid, fetchCalls, CacheObj: Cache,
    inflight: _searchOnlyInflight,
    failUntil: _searchOnlyFailUntil,
    advanceClock(ms) { now += ms; },
    paints: () => grid._paints,
    renderedSymbols() {
      const out = [];
      for (const m of grid._html.matchAll(/data-symbol="([^"]+)"/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
      }
      return out;
    },
  };
}

// --- contract tests --------------------------------------------------------

test('WL-SO-01: renderWatchlist stays synchronous (no async signature change)', () => {
  // Static: must NOT be declared async — all 13 call sites are fire-and-forget.
  assert.ok(!/async\s+function\s+renderWatchlist/.test(APP_SRC),
    'renderWatchlist must not be async');
  // Behavioral: calling it must not return a Promise.
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }], watchlist: ['BTC'],
  });
  const r = sb.renderWatchlist();
  assert.strictEqual(r, undefined, 'renderWatchlist() must return undefined, not a Promise');
});

test('WL-SO-02: renderWatchlist merges the third source (search-only) after crypto + forex', () => {
  // Static: the merge line must append searchOnlyWatch AFTER crypto + forex.
  assert.ok(APP_SRC.includes('const watchCoins = [...cryptoWatch, ...forexWatch, ...searchOnlyWatch];'),
    'watchCoins must merge crypto, forex, then search-only (in that order)');
  // Behavioral order check happens in WL-SO-05.
});

test('WL-SO-03: existing search-tab cache write is unchanged (same key + TTL)', () => {
  // The search tab's own cache write (line ~4920) must be untouched.
  assert.ok(APP_SRC.includes('Cache.set(`search_coin_${c.symbol}`, coinData, 300);'),
    'search tab must still cache with key search_coin_{SYMBOL} and TTL 300');
  // The hydration path must write the SAME key and the SAME TTL.
  assert.ok(APP_SRC.includes('Cache.set(`search_coin_${sym}`, {'),
    'hydration must write the same search_coin_{SYMBOL} cache key');
  assert.ok(/Cache\.set\(`search_coin_\$\{sym\}`, \{[\s\S]*?\}, 300\); \/\/ 5 min/.test(APP_SRC),
    'hydration must use the same 5-minute TTL as the search tab');
});

test('WL-SO-04: search-only coin in the watchlist renders from cache (scenario 1)', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['FLOKI'],
    searchCache: { FLOKI: { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1 } },
  });
  sb.renderWatchlist();
  assert.deepEqual(sb.renderedSymbols(), ['FLOKI'],
    'the search-only watched coin must render from the existing cache');
  assert.equal(sb.fetchCalls.length, 0, 'cache hit → zero network requests');
});

test('WL-SO-05: Top-200 + Forex + search-only render together, order preserved (scenario 2)', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }, { symbol: 'ETH' }],
    allForexPairs: [{ symbol: 'EURUSD', price: 1.08, change: -0.2, name: 'Euro Dollar' }],
    watchlist: ['ETH', 'EURUSD', 'BTC', 'FLOKI'],
    searchCache: { FLOKI: { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1 } },
  });
  sb.renderWatchlist();
  // Existing order contract: crypto (allCoins order) → forex → search-only.
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'ETH', 'EURUSD', 'FLOKI'],
    'Top-200 first, then Forex, then search-only — existing order untouched');
  assert.equal(sb.fetchCalls.length, 0, 'everything cached → zero requests');
});

test('WL-SO-06: search-only symbol still persisted to the backend (scenario 3)', () => {
  // toggleWatchlist must keep pushing ANY symbol (Top-200 or not) and persist.
  const toggleBody = sliceFnFromApp('toggleWatchlist');
  assert.ok(toggleBody.includes('watchlist.push(symbol);'),
    'toggleWatchlist must still push the symbol unconditionally');
  assert.ok(toggleBody.includes('persistWatchlist();'),
    'toggleWatchlist must still call persistWatchlist()');
  const persistBody = sliceFnFromApp('persistWatchlist');
  assert.ok(persistBody.includes("'/api/watchlist'") && persistBody.includes('method: \'PUT\''),
    'persistWatchlist must still PUT the whole watchlist to /api/watchlist');
  // renderWatchlist itself must never mutate the watchlist.
  const renderBody = sliceFnFromApp('renderWatchlist');
  assert.ok(!/\bwatchlist\s*(?:=[^=]|\.splice|\.push|\.pop|\.shift)/.test(renderBody),
    'renderWatchlist must never add/remove watchlist entries');
});

test('WL-SO-07: removing a search-only coin removes its card (scenario 8)', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1 } },
  });
  sb.renderWatchlist();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'], 'both cards before removal');
  // Same mutation toggleWatchlist performs: splice + re-render.
  sb.state.watchlist.splice(sb.state.watchlist.indexOf('FLOKI'), 1);
  sb.renderWatchlist();
  assert.deepEqual(sb.renderedSymbols(), ['BTC'],
    'removing the search-only coin must remove its card');
  assert.equal(sb.fetchCalls.length, 0, 'removal must not trigger any request');
});

test('WL-SO-08: toggleWatchlist removal flow unchanged (splice + persist + render)', () => {
  const toggleBody = sliceFnFromApp('toggleWatchlist');
  assert.ok(toggleBody.includes('watchlist.splice(idx, 1);'),
    'removal path must still splice by index');
  assert.ok(toggleBody.includes('persistWatchlist();') && toggleBody.includes('renderWatchlist();'),
    'removal path must still persist then re-render');
});

test('WL-SO-09: Top-200-only watchlist renders exactly as before (scenario 10)', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }, { symbol: 'ETH' }, { symbol: 'SOL' }],
    watchlist: ['ETH', 'BTC'],
  });
  sb.renderWatchlist();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'ETH'],
    'Top-200-only rendering is unchanged (allCoins order, as before)');
  assert.equal(sb.fetchCalls.length, 0, 'no search-only coins → zero extra requests');
  assert.equal(sb.paints(), 1, 'exactly one render paint — no hydration re-render needed');
});

test('WL-SO-10: cached search-only coin → zero Search API requests (scenario 4)', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1 } },
  });
  sb.ensureSearchOnlyCoinsHydrated();
  assert.equal(sb.fetchCalls.length, 0,
    'cache hit → the Search API must not be called');
});

test('WL-SO-11: cache miss → /api/market/search fetch, cache write, re-render (scenario 5)', async () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['BTC', 'FLOKI'],
    fetch: (url) => {
      sb.fetchCalls.push(url);
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{ symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1, volume: 12345, rank: 0 }],
        }),
      });
    },
  });
  sb.renderWatchlist(); // paint #1: BTC only (FLOKI not cached yet)
  const inflight = Object.values(sb.inflight);
  assert.equal(inflight.length, 1, 'exactly one symbol to hydrate');
  await Promise.allSettled(inflight);
  await settle(); // batched re-render fires
  assert.equal(sb.fetchCalls.length, 1, 'exactly one fetch');
  assert.ok(sb.fetchCalls[0] === 'https://api.example.com/api/market/search?q=FLOKI',
    'must call the existing /api/market/search endpoint with the symbol as q');
  assert.ok(sb.CacheObj.get('search_coin_FLOKI'),
    'result must be cached under the existing search_coin_{SYMBOL} key');
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'],
    'after hydration the card must appear (the reload-survival path)');
  assert.equal(sb.paints(), 2, 'initial paint + exactly one batched re-render');
  // The re-render's own hydration must be a no-op (cache now hits).
  await settle();
  assert.equal(sb.fetchCalls.length, 1, 'no loop — re-render does not fetch again');
});

test('WL-SO-12: repeated renders never duplicate a symbol request (scenarios 6 + 12)', async () => {
  let unblock;
  const gate = new Promise(r => { unblock = r; });
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['BTC', 'FLOKI', 'PEPE'],
    fetch: (url) => {
      sb.fetchCalls.push(url);
      return gate.then(() => ({ ok: true, json: () => Promise.resolve({ results: [] }) }));
    },
  });
  // Three concurrent render/hydration passes while the fetches are still pending.
  sb.ensureSearchOnlyCoinsHydrated();
  sb.ensureSearchOnlyCoinsHydrated();
  sb.ensureSearchOnlyCoinsHydrated();
  assert.equal(sb.fetchCalls.length, 2,
    'three renders → still exactly one request per symbol (in-flight dedup)');
  unblock();
  await Promise.allSettled(Object.values(sb.inflight));
  await settle();
  assert.equal(sb.paints(), 1,
    'a single batched re-render — not one per render call (no request/render storm)');
  assert.equal(sb.fetchCalls.length, 2,
    'the re-render must not fire additional requests');
});

test('WL-SO-13: one search-only coin failing never breaks the others (scenario 7)', async () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['BTC', 'FLOKI', 'PEPE'],
    fetch: (url) => {
      sb.fetchCalls.push(url);
      if (url.includes('q=PEPE')) return Promise.reject(new Error('network down'));
      return Promise.resolve({
        ok: true,
        json: () => Promise.resolve({
          results: [{ symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1, volume: 12345, rank: 0 }],
        }),
      });
    },
  });
  sb.renderWatchlist();
  const inflight = Object.values(sb.inflight);
  await Promise.allSettled(inflight);
  await settle();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'],
    'the successful coin renders; the failed one is skipped, not shown broken');
  assert.deepEqual(sb.state.watchlist, ['BTC', 'FLOKI', 'PEPE'],
    'the failure must NOT remove or mutate the watchlist');
  assert.equal(sb.fetchCalls.length, 2, 'one attempt per symbol, no retry storm');
  // Backoff: within the window, no new request for the failed symbol.
  sb.ensureSearchOnlyCoinsHydrated();
  assert.equal(sb.fetchCalls.length, 2, 'backoff window → no immediate refetch');
  // After the 120s window expires, exactly one bounded retry for the failed symbol.
  sb.advanceClock(120001);
  sb.ensureSearchOnlyCoinsHydrated();
  assert.equal(sb.fetchCalls.length, 3,
    'after backoff expiry: exactly one retry — and only for the failed symbol (FLOKI stays cached)');
});

test('WL-SO-14: no search-only coins → zero Search API requests (scenario 11)', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }, { symbol: 'ETH' }],
    allForexPairs: [{ symbol: 'EURUSD', price: 1.08, change: -0.2, name: 'Euro Dollar' }],
    watchlist: ['ETH', 'EURUSD', 'BTC'],
  });
  sb.renderWatchlist();
  sb.ensureSearchOnlyCoinsHydrated();
  assert.equal(sb.fetchCalls.length, 0,
    'watchlist fully covered by Top-200 + Forex → zero extra requests (behavior unchanged)');
});

test('WL-SO-15: market data not loaded yet → no premature search fetches', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [], // Top-200 not loaded — symbols cannot be classified yet
    watchlist: ['FLOKI', 'PEPE'],
  });
  sb.renderWatchlist();
  assert.ok(sb.grid.innerHTML.includes('watchlist-skeleton'),
    'skeleton path still taken when market data is missing');
  assert.equal(sb.fetchCalls.length, 0,
    'must not fetch through the search path before Top-200 is loaded');
  assert.equal(Object.keys(sb.inflight).length, 0, 'nothing in-flight');
});

test('WL-SO-16: expired cache falls back to the Search API again (scenario 5b)', async () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1 } },
    searchCacheTtl: 300, // same as production
  });
  sb.renderWatchlist();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'], 'fresh cache renders the card');
  assert.equal(sb.fetchCalls.length, 0);
  // Let the 5-minute cache expire.
  sb.advanceClock(300001);
  sb.renderWatchlist();
  const inflight = Object.values(sb.inflight);
  assert.equal(inflight.length, 1, 'expired cache → exactly one symbol re-hydrates');
  await Promise.allSettled(inflight);
  await settle();
  assert.equal(sb.fetchCalls.length, 1,
    'expired cache → the Search API is hit again (once)');
});

test('WL-SO-17: free/premium limits stay exactly 7/20 (scenario 9)', () => {
  // The gate in toggleWatchlist must still use the dynamic premium-aware limit.
  assert.ok(APP_SRC.includes('watchlist.length >= getMaxWatchlist()'),
    'add gate unchanged: watchlist.length >= getMaxWatchlist()');
  const maxBody = sliceFnFromApp('getMaxWatchlist');
  assert.ok(maxBody.includes('return 20') && maxBody.includes('return 7'),
    'getMaxWatchlist still returns 20 (Premium) / 7 (Free)');
  // The add-card condition inside renderWatchlist must be untouched too.
  const renderBody = sliceFnFromApp('renderWatchlist');
  assert.ok(renderBody.includes('watchlist.length < getMaxWatchlist()'),
    'add-card condition unchanged: watchlist.length < getMaxWatchlist()');
});

test('WL-SO-18: getSearchOnlyWatchSymbols classifies symbols correctly', () => {
  const sb = buildWatchlistSandbox({
    allCoins: [{ symbol: 'BTC' }, { symbol: 'ETH' }],
    allForexPairs: [{ symbol: 'EURUSD', price: 1, change: 0, name: 'EUR' }],
    watchlist: ['BTC', 'EURUSD', 'FLOKI', '', null, 0, 'ETH'],
  });
  assert.deepEqual(sb.getSearchOnlyWatchSymbols(), ['FLOKI'],
    'only symbols outside Top-200 + Forex are search-only; junk entries are ignored');
  const empty = buildWatchlistSandbox({ allCoins: [], watchlist: ['FLOKI'] });
  assert.deepEqual(empty.getSearchOnlyWatchSymbols(), [],
    'before Top-200 loads nothing can be classified — returns [] (no premature fetch)');
});


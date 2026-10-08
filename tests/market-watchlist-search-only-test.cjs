/**
 * Market → Watchlist Search-Only Coins — Regression Tests
 *
 * Companion suite to tests/watchlist-detail-chart-test.cjs (PR #71, which
 * fixed the DASHBOARD grid). Root cause (Task 38 audit): renderMarket()'s
 * `case 'watchlist'` built the Market Watchlist tab ONLY from
 * allCoins ∩ watchlist + allForexPairs ∩ watchlist — search-only watched
 * coins (added via /api/market/search, outside Top-200) were silently
 * dropped on the Market tab while the Dashboard showed them.
 *
 * FIX (behavior-preserving): renderMarket()'s watchlist case now merges the
 * SAME third source through the SAME mechanism the Dashboard uses —
 * getSearchOnlyWatchSymbols() + ensureSearchOnlyCoinsHydrated() +
 * Cache.get(`search_coin_${SYM}`) — plus a tiny helper
 * (ensureMarketWatchlistSearchOnly) that re-renders the Market tab after a
 * hydration batch settles, only while the user is still on it. The
 * price-only diff fast path falls back to the same cache for search-only
 * rows so their prices never go stale.
 *
 * Like the Dashboard suite, the behavioral tests below extract the REAL
 * functions from app.js and run them in a sandbox (fake list DOM, mock
 * fetch, deterministic clock) — they do NOT mirror the logic, they
 * execute it.
 *
 * Scenario coverage map (10 requested scenarios):
 *   #1  Top-200-only Market Watchlist      → WL-MKT-01
 *   #2  search-only-only Market Watchlist  → WL-MKT-02
 *   #3  Top-200 + Forex + search-only      → WL-MKT-03 (+ count bar)
 *   #4  survives reload (cold cache)       → WL-MKT-04
 *   #5  remove from Market Watchlist       → WL-MKT-05
 *   #6  search-only price not stale        → WL-MKT-06 (+ expiry WL-MKT-07)
 *   #7  no search-only → zero requests     → WL-MKT-09 (+ 01/03)
 *   #8  cold cache → hydrate + re-render   → WL-MKT-04 / 07 / 08
 *   #9  existing 52/52 Dashboard tests     → run separately (suite untouched)
 *   #10 market-related suites              → run separately
 * Plus regression guards: WL-MKT-10 (crypto tab unchanged),
 * WL-MKT-11 (forex-only unchanged), WL-MKT-12 (row structure),
 * WL-MKT-13 (static contract).
 *
 * Run: node --test tests/market-watchlist-search-only-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

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

const settle = async () => { for (let i = 0; i < 8; i++) await new Promise(r => setTimeout(r, 0)); };

/**
 * Minimal fake Market list element. `fastPathRows` simulates the DOM state
 * required by renderMarket's price-only diff fast path
 * (list.querySelector('.mkt-coin-row') truthy + querySelectorAll rows).
 */
function makeFakeRow(symbol) {
  const price = { textContent: '$0.00' };
  const change = { textContent: '+0.00%', className: 'mkt-coin-change up' };
  const svgEl = { setAttribute() {} };
  const star = { classList: { contains: () => false, toggle() {} }, querySelector: () => svgEl };
  return {
    dataset: { symbol },
    classList: { contains: () => false }, // neither btc-pair-row nor anything else
    _price: price,
    _change: change,
    querySelector(sel) {
      if (sel === '.mkt-coin-price') return price;
      if (sel === '.mkt-coin-change') return change;
      if (sel === '.mkt-coin-star') return star;
      return null;
    },
  };
}

function buildMarketSandbox(opts = {}) {
  const state = {
    allCoins: opts.allCoins || [],
    allForexPairs: opts.allForexPairs || [],
    watchlist: opts.watchlist || [],
  };
  const fetchCalls = [];
  let now = opts.now !== undefined ? opts.now : 1700000000000;
  let renderWatchlistCalls = 0;

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

  // Default fetch impl: record the URL, serve opts.searchResults[sym].
  const fetchImpl = opts.fetch || ((url) => {
    fetchCalls.push(String(url));
    const q = /q=([^&]+)/.exec(String(url));
    const sym = q ? decodeURIComponent(q[1]) : '';
    const hit = (opts.searchResults && opts.searchResults[sym]) || null;
    return Promise.resolve({ ok: true, json: () => Promise.resolve({ results: hit ? [hit] : [] }) });
  });

  // Minimal fake #coin-list-rows element
  const listEl = {
    _html: '',
    _paints: 0,
    fastPathRows: null, // set by tests to engage the price-diff fast path
    querySelector(sel) {
      if (sel === '.mkt-coin-row') return this.fastPathRows ? { dataset: {} } : null;
      return null;
    },
    querySelectorAll(sel) {
      if (sel === '.mkt-coin-row') return this.fastPathRows || [];
      return [];
    },
  };
  Object.defineProperty(listEl, 'innerHTML', {
    get() { return this._html; },
    set(v) { this._html = String(v); this._paints++; },
    configurable: true,
  });
  const documentStub = { getElementById: (id) => (id === 'coin-list-rows' ? listEl : null) };

  const factory = new Function(
    'allCoins', 'allForexPairs', 'watchlist', 'Cache',
    '_searchOnlyInflight', '_searchOnlyFailUntil', 'Date',
    'API_BASE', 'fetch', 'document', 't', 'renderWatchlist',
    'initCurrentMarketTab', 'initSearchTerm',
    `let currentMarketTab = initCurrentMarketTab;
     let searchTerm = initSearchTerm;
     let _lastMarketRenderKey = '';
     let marketVisibleCount = 100;
     const MARKET_DEFAULT_LIMIT = 100;
     ${sliceFnFromApp('getSearchOnlyWatchSymbols')}
     ${sliceFnFromApp('ensureSearchOnlyCoinsHydrated')}
     ${sliceFnFromApp('ensureMarketWatchlistSearchOnly')}
     ${sliceFnFromApp('escapeHtml')}
     ${sliceFnFromApp('renderMarketItem')}
     ${sliceFnFromApp('renderCryptoItem')}
     ${sliceFnFromApp('renderForexItem')}
     ${sliceFnFromApp('renderMarket')}
     return {
       renderMarket: renderMarket,
       ensureMarketWatchlistSearchOnly: ensureMarketWatchlistSearchOnly,
       getSearchOnlyWatchSymbols: getSearchOnlyWatchSymbols,
       ensureSearchOnlyCoinsHydrated: ensureSearchOnlyCoinsHydrated,
       setCurrentMarketTab: (v) => { currentMarketTab = v; },
       setSearchTerm: (v) => { searchTerm = v; },
       getRenderKey: () => _lastMarketRenderKey,
     };`
  );

  // NOTE: buildInfoBar is a LOCAL no-op inside renderMarket (returns '') in
  // app.js, so the info-bar count is not observable through innerHTML — the
  // user-visible count consistency is the number of rendered rows, verified
  // via renderedSymbols().length below (+ the count expression statically in
  // WL-MKT-13).
  const fns = factory(
    state.allCoins, state.allForexPairs, state.watchlist, Cache,
    _searchOnlyInflight, _searchOnlyFailUntil, fakeDate,
    'https://api.example.com', fetchImpl,
    documentStub,
    (k) => k,                                        // t()
    () => { renderWatchlistCalls++; },               // renderWatchlist spy (Dashboard)
    opts.currentMarketTab !== undefined ? opts.currentMarketTab : 'watchlist',
    opts.searchTerm !== undefined ? opts.searchTerm : ''
  );

  return {
    ...fns,
    state, listEl, fetchCalls, CacheObj: Cache,
    inflight: _searchOnlyInflight,
    failUntil: _searchOnlyFailUntil,
    advanceClock(ms) { now += ms; },
    paints: () => listEl._paints,
    html: () => listEl._html,
    renderWatchlistCalls: () => renderWatchlistCalls,
    renderedSymbols() {
      const out = [];
      for (const m of listEl._html.matchAll(/class="mkt-coin-row[^"]*" data-symbol="([^"]+)"/g)) {
        if (!out.includes(m[1])) out.push(m[1]);
      }
      return out;
    },
  };
}

const FLOKI_CACHED = { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.0002, changePercent24Hr: 5.1, volumeUsd24Hr: 9000, rank: 0 };
const FLOKI_REMOTE = { symbol: 'FLOKI', name: 'Floki', priceUsd: 0.00025, changePercent24Hr: 3.3, volume: 12000 };

// --- scenario tests ---------------------------------------------------------

test('WL-MKT-01: Top-200-only watchlist renders exactly as before (scenario 1)', () => {
  const sb = buildMarketSandbox({
    allCoins: [
      { symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 },
      { symbol: 'ETH', name: 'Ethereum', priceUsd: 3000, changePercent24Hr: -0.5 },
    ],
    watchlist: ['BTC'],
  });
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC'],
    'Top-200-only watchlist must render the watched Top-200 coin');
  assert.equal(sb.renderedSymbols().length, 1, 'exactly one row — unchanged');
  assert.equal(sb.fetchCalls.length, 0, 'no search-only coins → zero requests');
});

test('WL-MKT-02: search-only-only watchlist renders from cache, zero requests (scenario 2)', () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
  });
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['FLOKI'],
    'the search-only watched coin must render on the Market Watchlist tab (pre-fix: "no data")');
  assert.equal(sb.renderedSymbols().length, 1, 'count includes the search-only coin');
  assert.equal(sb.fetchCalls.length, 0, 'cache hit → zero network requests');
});

test('WL-MKT-03: Top-200 + Forex + search-only render together, order + count (scenario 3)', () => {
  const sb = buildMarketSandbox({
    allCoins: [
      { symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 },
      { symbol: 'ETH', name: 'Ethereum', priceUsd: 3000, changePercent24Hr: -0.5 },
    ],
    allForexPairs: [{ symbol: 'EURUSD', price: 1.08, change: -0.2, name: 'Euro Dollar', category: 'major' }],
    watchlist: ['ETH', 'EURUSD', 'BTC', 'FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
  });
  sb.renderMarket();
  // Same order contract as the Dashboard grid: crypto (allCoins order) → forex → search-only.
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'ETH', 'EURUSD', 'FLOKI'],
    'Top-200 first, then Forex, then search-only — existing order untouched');
  assert.equal(sb.renderedSymbols().length, 4,
    'row count = crypto + forex + search-only (2 + 1 + 1) — count consistent');
  assert.equal(sb.fetchCalls.length, 0, 'everything cached → zero requests');
});

test('WL-MKT-04: cold cache → hydration fetch → Market re-render (scenarios 4 + 8)', async () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['BTC', 'FLOKI'], // FLOKI came from search → cold cache after reload
    searchResults: { FLOKI: FLOKI_REMOTE },
  });
  // First render: FLOKI not cached yet → only BTC renders, hydration starts.
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC'], 'pre-hydration: only Top-200 renders');
  assert.equal(sb.fetchCalls.length, 1, 'exactly one hydration request for the missing symbol');
  assert.ok(sb.fetchCalls[0].includes('/api/market/search?q=FLOKI'),
    'hydration must use the existing public search endpoint');
  await settle();
  // Settle watcher: user still on watchlist tab → full re-render with FLOKI.
  assert.equal(sb.paints(), 2, 'hydration settle must trigger exactly one Market re-render');
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'],
    'after hydration the search-only coin must survive (reload survival)');
  assert.equal(sb.renderedSymbols().length, 2, 'count includes the hydrated coin');
  assert.equal(sb.fetchCalls.length, 1, 'no request storm — still exactly one request');
  // Second render (e.g. 60s poll) with warm cache: no further requests.
  sb.renderMarket();
  assert.equal(sb.fetchCalls.length, 1, 'warm cache → no additional requests on re-render');
});

test('WL-MKT-05: removing the search-only coin removes its Market row (scenario 5)', () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
  });
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'], 'both rows before removal');
  // Same mutation toggleWatchlist performs: splice + re-render (app.js:5540-5544).
  sb.state.watchlist.splice(sb.state.watchlist.indexOf('FLOKI'), 1);
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC'],
    'removing the search-only coin must remove its Market row');
  assert.equal(sb.fetchCalls.length, 0, 'removal must not trigger any request');
});

test('WL-MKT-06: fast-path price diff updates the search-only row from cache — not stale (scenario 6)', () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
  });
  sb.renderMarket(); // full render → render key set
  // Engage the price-only diff fast path (list already has rows).
  const btcRow = makeFakeRow('BTC');
  const flokiRow = makeFakeRow('FLOKI');
  sb.listEl.fastPathRows = [btcRow, flokiRow];
  // Fresh data arrives: Top-200 poll updates allCoins, hydration refreshed the cache.
  sb.state.allCoins[0].priceUsd = 61000;
  sb.state.allCoins[0].changePercent24Hr = 2.5;
  sb.CacheObj.set('search_coin_FLOKI',
    { ...FLOKI_CACHED, priceUsd: 0.00031, changePercent24Hr: -2.4 }, 300);
  sb.renderMarket(); // same render key → fast path
  assert.equal(sb.paints(), 1, 'fast path must NOT rebuild innerHTML');
  assert.equal(btcRow._price.textContent, '$61,000.00', 'Top-200 row price updated from allCoins');
  assert.equal(flokiRow._price.textContent, '$0.000310',
    'search-only row price must update from the search coin cache (was stale pre-fix)');
  assert.equal(flokiRow._change.textContent, '-2.40%', 'search-only row change must update too');
  assert.equal(sb.fetchCalls.length, 0, 'warm cache → zero requests in the fast path');
});

test('WL-MKT-07: expired cache → fast path re-hydrates once and re-renders fresh (scenario 6b/8)', async () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
    searchResults: { FLOKI: FLOKI_REMOTE },
  });
  sb.renderMarket(); // full render, cache warm
  sb.listEl.fastPathRows = [makeFakeRow('BTC'), makeFakeRow('FLOKI')];
  sb.advanceClock(301 * 1000); // 5-min search cache TTL expires
  sb.renderMarket(); // fast path → ensure() sees the miss → one re-hydration
  assert.equal(sb.fetchCalls.length, 1, 'expired cache → exactly one re-hydration request');
  await settle();
  assert.ok(sb.paints() >= 2, 'settle watcher must re-render the Market tab with fresh data');
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'], 'search-only row still present');
  assert.ok(sb.html().includes('0.000250'),
    're-rendered row must show the FRESH price from re-hydration, not the stale one');
  assert.equal(sb.fetchCalls.length, 1, 'no request storm — still one request');
});

test('WL-MKT-08: hydration settle does NOT re-render after leaving the watchlist tab (guard)', async () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['BTC', 'FLOKI'],
    searchResults: { FLOKI: FLOKI_REMOTE },
  });
  sb.renderMarket(); // hydration starts (1 fetch)
  sb.setCurrentMarketTab('overview'); // user switches away BEFORE settle
  const paintsBefore = sb.paints();
  await settle();
  assert.equal(sb.paints(), paintsBefore,
    'no Market re-render when currentMarketTab is no longer watchlist');
  // Coming back later still shows the hydrated coin (cache now warm).
  sb.setCurrentMarketTab('watchlist');
  sb.listEl.fastPathRows = null;
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'FLOKI'],
    'returning to the tab must render the hydrated search-only coin');
});

test('WL-MKT-09: no search-only coins → zero extra requests, full + fast path (scenario 7)', () => {
  const sb = buildMarketSandbox({
    allCoins: [
      { symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 },
      { symbol: 'ETH', name: 'Ethereum', priceUsd: 3000, changePercent24Hr: -0.5 },
    ],
    allForexPairs: [{ symbol: 'EURUSD', price: 1.08, change: -0.2, name: 'Euro Dollar', category: 'major' }],
    watchlist: ['BTC', 'EURUSD'],
  });
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'EURUSD'], 'crypto + forex as before');
  sb.listEl.fastPathRows = [makeFakeRow('BTC'), makeFakeRow('EURUSD')];
  sb.renderMarket(); // fast path
  assert.equal(sb.fetchCalls.length, 0,
    'no search-only watched coin → zero extra requests in BOTH paths');
});

test('WL-MKT-10: crypto tab (overview) unchanged — search-only coins do not leak (regression)', () => {
  const sb = buildMarketSandbox({
    currentMarketTab: 'overview',
    allCoins: [
      { symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 },
      { symbol: 'ETH', name: 'Ethereum', priceUsd: 3000, changePercent24Hr: -0.5 },
    ],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
  });
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['BTC', 'ETH'],
    'overview tab must render allCoins exactly as before — no search-only leak');
  assert.equal(sb.fetchCalls.length, 0, 'overview tab must not trigger hydration');
});

test('WL-MKT-11: forex-only watchlist renders exactly as before (regression)', () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    allForexPairs: [{ symbol: 'EURUSD', price: 1.08, change: -0.2, name: 'Euro Dollar', category: 'major' }],
    watchlist: ['EURUSD'],
  });
  sb.renderMarket();
  assert.deepEqual(sb.renderedSymbols(), ['EURUSD'], 'forex-only watchlist unchanged');
  assert.equal(sb.renderedSymbols().length, 1, 'count unchanged for forex-only');
  assert.equal(sb.fetchCalls.length, 0, 'forex-only → zero requests');
});

test('WL-MKT-12: search-only row uses the standard market row structure (star/actions)', () => {
  const sb = buildMarketSandbox({
    allCoins: [{ symbol: 'BTC', name: 'Bitcoin', priceUsd: 60000, changePercent24Hr: 1.5 }],
    watchlist: ['BTC', 'FLOKI'],
    searchCache: { FLOKI: FLOKI_CACHED },
  });
  sb.renderMarket();
  const html = sb.html();
  // Same row markup renderCryptoItem produces for Top-200 coins.
  assert.ok(html.includes('data-symbol="FLOKI" data-action="open-coin"'),
    'search-only row must open coin detail like any market row');
  assert.ok(/data-symbol="FLOKI" data-action="toggle-watch"/.test(html),
    'search-only row must have the star/remove toggle');
  const flokiBlock = html.slice(html.indexOf('data-symbol="FLOKI" data-action="open-coin"'));
  assert.ok(flokiBlock.includes('mkt-coin-price'), 'search-only row must show a price');
  assert.ok(flokiBlock.includes('mkt-coin-change'), 'search-only row must show 24h change');
});

test('WL-MKT-13: static contract — the fix lives in renderMarket, the Dashboard fix untouched', () => {
  // The Market watchlist case merges the third source via the EXISTING mechanism.
  assert.ok(APP_SRC.includes('function ensureMarketWatchlistSearchOnly()'),
    'the Market-side hydration/re-render helper must exist');
  assert.ok(APP_SRC.includes('const searchOnlyItems = getSearchOnlyWatchSymbols()'),
    'renderMarket watchlist case must compute search-only items via getSearchOnlyWatchSymbols()');
  assert.ok(APP_SRC.includes('Cache.get(`search_coin_${sym}`)'),
    'renderMarket must read the existing search coin cache key');
  assert.ok(APP_SRC.includes('filtered.length + forexWatched.length + searchOnlyItems.length'),
    'info bar count must include crypto + forex + search-only');
  // Fast-path fallback prevents stale prices.
  assert.ok(APP_SRC.includes('|| Cache.get(`search_coin_${symbol}`)'),
    'price-diff fast path must fall back to the search coin cache');
  // Settle watcher guard + render key invalidation.
  assert.ok(APP_SRC.includes("_lastMarketRenderKey = null; // bypass the price-only fast path"),
    'watcher must invalidate the render key before re-rendering');
  // No new cache / no duplicated hydration logic: the helper delegates to the existing one.
  const helper = sliceFnFromApp('ensureMarketWatchlistSearchOnly');
  assert.ok(helper.includes('ensureSearchOnlyCoinsHydrated();'),
    'helper must delegate to the existing hydration (no new request path)');
  assert.ok(helper.includes("currentMarketTab === 'watchlist' && !searchTerm"),
    'Market re-render only while still on the watchlist tab, never during search');
  // Dashboard fix (PR #71) untouched.
  assert.ok(APP_SRC.includes('const watchCoins = [...cryptoWatch, ...forexWatch, ...searchOnlyWatch];'),
    'Dashboard merge line must be unchanged');
  // toggleWatchlist still re-renders Market after add/remove (existing behavior).
  const toggleBody = sliceFnFromApp('toggleWatchlist');
  assert.ok(toggleBody.includes('renderMarket();'),
    'toggleWatchlist must still re-render the Market list');
});

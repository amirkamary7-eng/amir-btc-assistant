/**
 * MK-07 — Cold start fires /api/market exactly ONCE
 * ================================================
 *
 * Task 62 finding MK-07: every page load fired /api/market TWICE —
 *   call #1: init loadMarketData(false) — ALWAYS fetches on a fresh page load
 *            (the in-memory Cache('market') is empty on page load; localStorage
 *            hydration populates allCoins directly but never the Cache), and
 *   call #2: an unconditional setTimeout(2000) → loadMarketData(true).
 * The server-side KV market cache TTL is 120s, so call #2 returned the SAME KV
 * payload on ~98% of loads — fresher only in the ~2% where the KV TTL expired
 * inside the 2s window. The "background refresh" intent was not achieved; the
 * cost was doubled cold-start market traffic.
 *
 * FIX: the deferred force-refresh block was removed from init. Freshness is
 * preserved by the existing system (pinned by this test):
 *   1. 60s visibility-gated market polling,
 *   2. 120s in-memory Cache TTL (steady-state dedup),
 *   3. localStorage hydration (version-gated, <=5 min old) for instant paint,
 *   4. bfcache recovery.
 *
 * Pre-fix: S1/S2 FAIL (2 calls + 2s timer). S3/S4/S5 pin behaviors that must
 * survive: cold fetch actually fetches, warm short-circuit, hydration gate.
 *
 * Run: node --test tests/mk07-cold-start-double-fetch-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// ============================================================================
// Extraction helpers
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^async function ${name}\\(`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`${name} not found`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j] === '}') return lines.slice(startIdx, j + 1).join('\n');
  }
  throw new Error(`${name} end not found`);
}

// The init market block: loadMarketData(false).then(...)...catch(...)
function extractInitBlock() {
  const lines = APP_SRC.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'loadMarketData(false).then(() => {') { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('init market block not found');
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j].trim() === '});') return lines.slice(startIdx, j + 1).join('\n');
  }
  throw new Error('init market block end not found');
}
const INIT_BLOCK = extractInitBlock();
const LOAD_MARKET_DATA_SRC = extractFn(APP_SRC, 'loadMarketData');

// ============================================================================
// Sandboxes
// ============================================================================
// Init-block sandbox: mocked loadMarketData + renders; records timers.
function createInitSandbox() {
  const calls = { loadMarketData: [], renders: new Set(), timers: [] };
  const wrapper = [
    'const loadMarketData = (force) => { __g.calls.loadMarketData.push(force); return Promise.resolve(); };',
    'const renderMarketTicker = () => { __g.calls.renders.add("ticker"); };',
    'const renderDashboardMarketStatus = () => { __g.calls.renders.add("status"); };',
    'const renderWatchlist = () => { __g.calls.renders.add("watchlist"); };',
    'const console = { warn: () => {} };',
    'const setTimeout = (fn, ms) => { __g.calls.timers.push(ms); return 0; };',
    INIT_BLOCK,
  ].join('\n');
  new Function('__g', wrapper)({ calls });
  return calls;
}

// Real loadMarketData sandbox with mocked leaves.
function createLoadSandbox(opts = {}) {
  const apiCalls = [];
  const cacheStore = new Map();
  const Cache = {
    get: (k) => cacheStore.get(k) ?? null,
    set: (k, v, ttl) => cacheStore.set(k, v),
  };
  if (opts.warm) cacheStore.set('market', [{ symbol: 'BTC', priceUsd: 100000 }]);

  const storage = new Map();
  const g = {
    calls: apiCalls,
    renderOrder: [],
  };
  const noop = (name) => () => { g.renderOrder.push(name); };
  const wrapper = [
    'let allCoins = __g.warm ? [] : [];',
    'let tabLoaded = { market: false };',
    'let globalMarketData = null;',
    'let lastMarketFetchTime = 0;',
    'const API_BASE = "https://test.local";',
    'const document = { getElementById: () => null };',
    'const Cache = __g.Cache;',
    'const localStorage = __g.localStorage;',
    'const apiFetch = __g.apiFetch;',
    'const loadMarketOverview = async () => {};',
    'const renderMarket = __g.noop("renderMarket");',
    'const renderWatchlist = __g.noop("renderWatchlist");',
    'const renderSummary = __g.noop("renderSummary");',
    'const renderDashboardHeatmap = __g.noop("renderDashboardHeatmap");',
    'const renderMarketInsights = __g.noop("renderMarketInsights");',
    'const renderMarketTicker = __g.noop("renderMarketTicker");',
    'const renderDashboardMarketStatus = __g.noop("renderDashboardMarketStatus");',
    'const prefetchTopChartSymbols = () => {};',
    'const setTimeout = (fn) => { try { fn(); } catch (_) {} return 0; };',
    'const requestIdleCallback = undefined;',
    'const console = { log: () => {}, warn: () => {}, error: () => {} };',
    'const t = (k) => k;',
    LOAD_MARKET_DATA_SRC,
    'return { loadMarketData, __getAllCoins: () => allCoins, __getTabLoaded: () => tabLoaded };',
  ].join('\n');

  const sandbox = new Function('__g', wrapper)({
    warm: opts.warm,
    Cache,
    localStorage: {
      setItem: (k, v) => storage.set(k, String(v)),
      getItem: (k) => storage.get(k) ?? null,
    },
    apiFetch: async (url) => {
      apiCalls.push(url);
      return {
        status: 'success',
        data: [{ symbol: 'BTC', priceUsd: 100000 }, { symbol: 'ETH', priceUsd: 3000 }],
        global: null,
      };
    },
    noop,
  });
  return { ...sandbox, _apiCalls: apiCalls, _cacheStore: cacheStore, _storage: storage };
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-07 S1: cold start fires loadMarketData exactly ONCE (was 2 calls)', async () => {
  const calls = createInitSandbox();
  // let the .then() chain settle
  await new Promise(r => setImmediate(r));
  assert.equal(calls.loadMarketData.length, 1, `init must call loadMarketData once, got ${calls.loadMarketData.length}`);
  assert.equal(calls.loadMarketData[0], false, 'the single init call is cache-first (force=false)');
  assert.deepEqual([...calls.renders].sort(), ['status', 'ticker', 'watchlist'],
    'renders must still run after the initial load');
});

test('MK-07 S2: no deferred 2s force-refresh timer is registered', async () => {
  const calls = createInitSandbox();
  await new Promise(r => setImmediate(r));
  const deferred = calls.timers.filter(ms => ms === 2000);
  assert.equal(deferred.length, 0, 'the 2000ms deferred force-refresh must be gone');
  assert.equal(calls.timers.length, 0, 'no other init timers should be needed for market');
});

test('MK-07 S3: SURVIVING BEHAVIOR — real loadMarketData still fetches on a cold Cache', async () => {
  const sb = createLoadSandbox();
  await sb.loadMarketData(false);
  assert.equal(sb._apiCalls.length, 1, 'cold load must fetch /api/market exactly once');
  assert.equal(sb._apiCalls[0], '/api/market');
  assert.equal(sb.__getAllCoins().length, 2, 'allCoins populated from the API response');
  assert.equal(sb.__getTabLoaded().market, true, 'tabLoaded.market set on success');
  assert.ok(sb._cacheStore.has('market'), 'Cache.set(market) written');
});

test('MK-07 S4: SURVIVING BEHAVIOR — warm in-memory Cache short-circuits (no fetch)', async () => {
  const sb = createLoadSandbox({ warm: true });
  await sb.loadMarketData(false);
  assert.equal(sb._apiCalls.length, 0, 'cache hit must not fetch');
  assert.equal(sb.__getAllCoins().length, 1, 'allCoins served from Cache');
});

test('MK-07 S5: SURVIVING BEHAVIOR — localStorage hydration stays version-gated with 5-min TTL', () => {
  // The DOMContentLoaded hydration block must keep BOTH guards (version + age)
  // so stale/unversioned localStorage data never paints.
  const hydrateStart = APP_SRC.indexOf('const MARKET_CACHE_VERSION');
  assert.ok(hydrateStart !== -1, 'hydration version gate must exist');
  const domBlock = APP_SRC.slice(hydrateStart, hydrateStart + 1600);
  assert.match(domBlock, /MARKET_CACHE_VERSION = 4/, 'hydration pins the cache version');
  assert.match(domBlock, /MARKET_CACHE_TTL_MS = 5 \* 60 \* 1000/, 'hydration enforces the 5-minute TTL');
  assert.match(domBlock, /cachedVersion >= MARKET_CACHE_VERSION/, 'version gate enforced');
  assert.match(domBlock, /cachedVersion >= MARKET_CACHE_VERSION && isFresh/, 'both gates required together');
  // And the deferred 2s force-refresh must be gone from the REAL init block
  assert.ok(!/setTimeout\(\(\) => loadMarketData\(true\)/.test(APP_SRC),
    'no deferred force-refresh setTimeout may remain in app.js');
});

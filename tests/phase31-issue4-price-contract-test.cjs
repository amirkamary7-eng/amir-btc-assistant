/**
 * PHASE 31 — ISSUE 4 REGRESSION TEST: price contract, chart source label,
 * Refresh scope, and forex race guard
 * ================================================================
 *
 * Phase 30 Issue 4 (CONFIRMED, High technical priority — BY-DESIGN
 * multi-source price architecture; the fix is a labeling + refresh
 * contract, NOT number syncing):
 *
 *   Three price semantics coexist on the coin/forex detail view:
 *     LIST/HEADER  — /api/market aggregate (CoinGecko family, ≤120s KV;
 *                    forex: frankfurter ECB / Yahoo, ≤120s KV)
 *     ALERT CARD   — exchange USDT spot one-shot (fetchAlertBasisPrice →
 *                    /api/market/prices; Yahoo for gold/stocks) — the SAME
 *                    family the 1-min cron evaluates (MK-11)
 *     CHART        — TradingView widget's OWN live feed (tv_symbol from
 *                    /api/charts/resolve / pair.tvSymbol)
 *   Live-captured deltas (Phase 30): BTC list $82,049.42 vs chart
 *   $82,038.42 (0.013%); EURUSD ECB-ref 1.12532 vs Yahoo-live 1.1242;
 *   gold list GC=F futures vs chart OANDA spot. All NATURAL basis
 *   differences — syncing the numbers would be wrong.
 *
 * Phase 31 fix under test:
 *   A. Chart source label (cd_chart_source, fa+en) in the detail modal's
 *      chart section — states the chart's REAL source (TradingView live
 *      feed) so the difference reads as three price semantics, not a bug.
 *      No fake timestamp is displayed (a live third-party feed has no
 *      fetch timestamp; fabricating one is forbidden by the acceptance
 *      criteria). The LIST side already carries source+timestamp
 *      (#mkt-source-text, #mkt-overview-updated from globalMarketData)
 *      plus the MK-08 stale/fallback indicator.
 *   B. refreshMarketData(): still force-refreshes the crypto list ALWAYS
 *      (pre-existing behavior); now ALSO force-refreshes forex when the
 *      Forex or Watchlist sub-tab is active (forex pairs are a related
 *      VISIBLE consumer — Phase 30 confirmed the button previously did
 *      nothing for them). The open detail modal (refreshed by the 60s
 *      poll; unreachable behind the overlay) and the TradingView chart
 *      (own live feed, now labeled) are deliberately NOT wired.
 *   C. loadForexData(force): force skips the 120s client cache; a new
 *      _forexLoadSeq sequence token rejects stale /api/forex responses so
 *      an older slow response can never overwrite a newer one.
 *
 * NOT changed (locked here): alert economy/thresholds/units (MK-06/
 * MK-11), provider chains and fallbacks, fetchAlertBasisPrice one-shot
 * semantics, the 60s poll's refreshOpenDetailPrice header contract.
 *
 * Run: node --test tests/phase31-issue4-price-contract-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const CD_CSS = fs.readFileSync(path.join(ROOT, 'coin-detail.css'), 'utf8');

// ── Helpers ─────────────────────────────────────────────────────────────────
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

// ════════════════════════════════════════════════════════════════════════════
// A. Chart source label — real source, both locales, no fake timestamp
// ════════════════════════════════════════════════════════════════════════════

test('Issue 4 A: detail modal chart section carries the cd-chart-source label before #detail-chart', () => {
  const sectionStart = INDEX_HTML.indexOf('<div class="cd-chart-section">');
  assert.ok(sectionStart > -1, 'chart section must exist');
  const sectionEnd = INDEX_HTML.indexOf('</div>', INDEX_HTML.indexOf('id="detail-chart"'));
  const section = INDEX_HTML.slice(sectionStart, sectionEnd);
  const labelIdx = section.indexOf('cd-chart-source');
  const chartIdx = section.indexOf('id="detail-chart"');
  assert.ok(labelIdx > -1, 'the chart source label element must exist inside the chart section');
  assert.ok(chartIdx > -1 && labelIdx < chartIdx, 'the label must sit BEFORE the chart container (visible above the widget)');
  assert.match(section, /<div class="cd-chart-source" data-i18n="cd_chart_source">/,
    'label must be bound to the i18n key cd_chart_source');
});

test('Issue 4 A: cd_chart_source defined in BOTH dictionaries and names the REAL source (TradingView)', () => {
  const ctx = new Function(
    I18N_SRC + '\n;return { i18n, t, setLang: (l) => { currentLang = l; } };'
  )();
  assert.ok(ctx.i18n.fa && ctx.i18n.en, 'both dictionaries must exist');
  assert.equal(ctx.t('cd_chart_source'), ctx.i18n.fa.cd_chart_source);
  for (const [locale, value] of Object.entries({ fa: ctx.i18n.fa.cd_chart_source, en: ctx.i18n.en.cd_chart_source })) {
    assert.ok(/tradingview/i.test(value),
      `${locale}.cd_chart_source must name the chart's real source (TradingView)`);
    // Must NOT claim the chart is on the list's aggregate source:
    assert.ok(!/coingecko|coinmarketcap|کوین[\s‌]?گیکو|کوینمارکت/i.test(value),
      `${locale}.cd_chart_source must not misattribute the chart to a provider it does not use`);
    // Acceptance criterion: no fake timestamp / fabricated data time:
    assert.ok(!/\d{1,2}:\d{2}/.test(value),
      `${locale}.cd_chart_source must not display a fabricated timestamp`);
  }
  ctx.setLang('en');
  assert.equal(ctx.t('cd_chart_source'), ctx.i18n.en.cd_chart_source);
});

test('Issue 4 A: coin-detail.css styles .cd-chart-source (muted premium caption)', () => {
  assert.match(CD_CSS, /\.cd-chart-source\s*\{/, 'label style rule must exist');
});

test('Issue 4 A: list-side source+timestamp contract still present (existing elements, untouched)', () => {
  // Phase 30 contract: the market overview already renders a REAL source and
  // timestamp; MK-08 renders stale/fallback states. These must stay.
  assert.match(APP_SRC, /getElementById\('mkt-source-text'\)/, 'overview source label writer must remain');
  assert.match(APP_SRC, /getElementById\('mkt-overview-updated'\)/, 'overview timestamp writer must remain');
  assert.match(APP_SRC, /function setMarketDataStatus/, 'MK-08 stale/fallback indicator must remain');
});

// ════════════════════════════════════════════════════════════════════════════
// B. refreshMarketData — visible-surface scope (behavioral, sandboxed)
// ════════════════════════════════════════════════════════════════════════════

function sandboxRefresh(tab) {
  const calls = { market: [], forex: [] };
  const sandbox = {
    currentMainTab: tab,
    loadMarketData: (...a) => { calls.market.push(a); return Promise.resolve(); },
    loadForexData: (...a) => { calls.forex.push(a); return Promise.resolve(); },
  };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(APP_SRC, 'refreshMarketData'), sandbox);
  sandbox.refreshMarketData();
  return calls;
}

test('Issue 4 B: crypto tab — Refresh force-reloads the crypto list ONLY (pre-existing behavior preserved)', () => {
  const calls = sandboxRefresh('crypto');
  assert.deepEqual(calls.market, [[true]], 'loadMarketData(true) must always run');
  assert.deepEqual(calls.forex, [], 'no forex fetch when the forex surface is not visible');
});

test('Issue 4 B: forex tab — Refresh ALSO force-reloads forex data', () => {
  const calls = sandboxRefresh('forex');
  assert.deepEqual(calls.market, [[true]], 'crypto list refresh unchanged');
  assert.deepEqual(calls.forex, [[true]], 'loadForexData(true) must run when the forex tab is visible');
});

test('Issue 4 B: watchlist tab — Refresh force-reloads forex (watchlist renders allForexPairs rows)', () => {
  const calls = sandboxRefresh('watchlist');
  assert.deepEqual(calls.market, [[true]]);
  assert.deepEqual(calls.forex, [[true]], 'watchlist merges allForexPairs (app.js renderWatchlist) — forex is a visible consumer');
});

test('Issue 4 B: refreshMarketData does NOT touch the chart widget or alert basis (source contract)', () => {
  const body = extractFn(APP_SRC, 'refreshMarketData');
  assert.ok(!/createTradingViewWidget|ensureTradingViewLoaded/.test(body),
    'Refresh must not reload the TradingView widget (own live feed — labeled instead)');
  assert.ok(!/fetchAlertBasisPrice/.test(body),
    'Refresh must not re-fetch the alert basis mid-view (MK-11 one-shot semantics)');
});

// ════════════════════════════════════════════════════════════════════════════
// C. loadForexData(force) — cache semantics + stale-response race guard
// ════════════════════════════════════════════════════════════════════════════

function makeForexSandbox({ apiFetch, seededCache }) {
  const store = new Map();
  const sandbox = {
    API_BASE: 'https://unit.test',
    _forexLoadSeq: 0,
    allForexPairs: [],
    Cache: {
      get: (k) => (store.has(k) ? store.get(k) : null),
      set: (k, v) => store.set(k, v),
    },
    apiFetch,
    renderMarket: () => { sandbox._renderedMarket++; },
    renderWatchlist: () => { sandbox._renderedWatchlist++; },
    localStorage: {
      setItem: () => {},
      getItem: () => null,
    },
    console: { warn: () => {} },
    _renderedMarket: 0,
    _renderedWatchlist: 0,
  };
  if (seededCache) store.set('forex', seededCache);
  vm.createContext(sandbox);
  vm.runInContext(extractFn(APP_SRC, 'loadForexData'), sandbox);
  return sandbox;
}

const CACHED_PAIRS = [{ symbol: 'EURUSD', price: 1.1, change: 0.1 }];
const FRESH_PAIRS = [{ symbol: 'EURUSD', price: 1.2, change: 0.2 }];

test('Issue 4 C: non-force call uses the client cache and never hits the API', async () => {
  let apiCalls = 0;
  const sandbox = makeForexSandbox({
    apiFetch: async () => { apiCalls++; return { status: 'success', data: FRESH_PAIRS }; },
    seededCache: CACHED_PAIRS,
  });
  await sandbox.loadForexData(false);
  assert.equal(apiCalls, 0, 'cache hit must not call /api/forex');
  assert.deepEqual(sandbox.allForexPairs, CACHED_PAIRS, 'cached pairs applied');
  assert.equal(sandbox._renderedMarket, 1);
});

test('Issue 4 C: force call SKIPS the cache and fetches fresh data', async () => {
  let apiCalls = 0;
  const sandbox = makeForexSandbox({
    apiFetch: async () => { apiCalls++; return { status: 'success', data: FRESH_PAIRS }; },
    seededCache: CACHED_PAIRS,
  });
  await sandbox.loadForexData(true);
  assert.equal(apiCalls, 1, 'force must bypass the 120s client cache');
  assert.deepEqual(sandbox.allForexPairs, FRESH_PAIRS, 'fresh pairs applied');
  assert.equal(sandbox._renderedMarket, 1);
  assert.equal(sandbox._renderedWatchlist, 1, 'watchlist re-rendered so its forex rows update on the same tap');
});

test('Issue 4 C: STALE RESPONSE RACE — an older slow /api/forex response can never overwrite a newer one', async () => {
  // Call A starts first, resolves LAST with OLD data; call B starts later,
  // resolves FIRST with NEW data. A's write must be rejected by the seq guard.
  let resolverA, resolverB;
  const pending = [];
  const apiFetch = async () => new Promise((resolve) => { pending.push(resolve); });
  const sandbox = makeForexSandbox({ apiFetch });

  const pA = sandbox.loadForexData(true); // older call
  const pB = sandbox.loadForexData(true); // newer call
  await new Promise((r) => setTimeout(r, 0));

  // Newer response lands first with NEW data:
  pending[1]({ status: 'success', data: FRESH_PAIRS });
  await pB;
  assert.deepEqual(sandbox.allForexPairs, FRESH_PAIRS, 'newer response applied');

  // Older response lands last with OLD data — must be REJECTED:
  pending[0]({ status: 'success', data: CACHED_PAIRS });
  await pA;
  assert.deepEqual(sandbox.allForexPairs, FRESH_PAIRS,
    'the stale older response must NOT overwrite the newer data (seq token guard)');
});

test('Issue 4 C: seq token declared and initialized (module state)', () => {
  assert.match(APP_SRC, /let _forexLoadSeq = 0;/,
    '_forexLoadSeq must be a module-level counter initialized to 0');
});

// ════════════════════════════════════════════════════════════════════════════
// D. Untouched contracts — alert economy + header/list shared source
// ════════════════════════════════════════════════════════════════════════════

test('Issue 4 D: fetchAlertBasisPrice one-shot contract unchanged (MK-11)', () => {
  const body = extractFn(APP_SRC, 'fetchAlertBasisPrice');
  assert.match(body, /token !== _detailLoadToken \|\| _currentDetailSymbol !== displaySymbol/,
    'race guard (detail token + symbol) must be preserved');
  assert.match(body, /getAlertUnitLabel\(baseSymbol\)/,
    'alert card unit must still come from the MK-06 routing table (USDT/USD)');
  assert.match(body, /priceEl\.textContent = '\$' \+ fmtBasis\(basePrice\)/,
    'outside-top-200 header price source (USDT spot anchor) must be preserved');
});

test('Issue 4 D: 60s poll still refreshes the open detail header and NEVER flips the crypto alert basis', () => {
  const body = extractFn(APP_SRC, 'refreshOpenDetailPrice');
  assert.match(body, /getElementById\('detail-coin-price'\)/,
    'open-detail header price update must remain (60s poll contract)');
  assert.match(body, /if \(!isCrypto && !isBtcPair\)/,
    'MK-11 guard must remain: the crypto alert card is owned by the USDT anchor, never overwritten by the market tick');
});

test('Issue 4 D: top-200 detail header still shares the list source (allCoins.priceUsd)', () => {
  // Phase 30 contract: list row and detail header display the SAME value
  // family for top-200 coins — both read allCoins (CoinGecko aggregate).
  const body = extractFn(APP_SRC, 'openCoinDetail');
  assert.match(body, /priceStr = coin\.priceUsd > 1 \? coin\.priceUsd\.toLocaleString/,
    'header price must still render coin.priceUsd (the list row source)');
});

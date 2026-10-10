/**
 * MK-10 — Market search: query-keyed result cache
 * ==============================================
 *
 * Task 62 finding MK-10: the 250ms debounce (NEWSFE-009) and the
 * stale-response guard (currentSearch !== _lastSearchTerm) were present, and
 * the backend /api/market/search rate-limits + caches the MEXC index per query
 * for 5 min server-side — but the frontend had NO query-keyed result cache:
 * every re-typed query re-fetched byte-identical data.
 *
 * FIX (app.js only):
 *   - module-level _searchResultCache Map, TTL 60s (_SEARCH_RESULT_CACHE_TTL_MS),
 *     bound 20 (_SEARCH_RESULT_CACHE_MAX, oldest evicted by insertion order);
 *   - the search branch restructured around applySearchData — a single render
 *     path shared by the cache hit and the fresh network response;
 *   - ONLY successful index responses are cached (never the degraded
 *     allCoins fallback, never errors);
 *   - stale-response guard, input debounce and skeleton unchanged.
 *
 * This test extracts the REAL search branch (applySearchData + the search if)
 * from renderMarket and runs it with a controlled fetch and a virtual clock.
 *
 * Pre-fix: S1 FAIL (two fetches for the same query); S5/S6/S7 FAIL (no cache).
 *
 * Run: node --test tests/mk10-market-search-cache-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// ============================================================================
// Extract the REAL search branch (applySearchData + the `if (searchTerm)` part)
// ============================================================================
function extractSearchBranch() {
  const lines = APP_SRC.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (lines[i].trim() === 'function applySearchData(data, searchTerm) {') { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error('applySearchData not found');
  let endIdx = -1;
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j].includes('// Tab-based rendering (no search)')) { endIdx = j - 1; break; }
  }
  if (endIdx === -1) throw new Error('search branch end not found');
  // back up to the closing brace of the `if (searchTerm)` block
  while (endIdx > startIdx && lines[endIdx].trim() !== '}') endIdx--;
  return lines.slice(startIdx, endIdx + 1).join('\n');
}
const SEARCH_BRANCH_SRC = extractSearchBranch();

// NOTE: the sandbox is built programmatically below (makeSandbox) — the
// extracted branch is wrapped in __searchBranch(searchTerm) whose parameter
// shadows the module-level searchTerm, exactly like the real renderMarket flow.
function makeSandbox() {
  const state = {
    now: Date.parse('2026-01-15T10:00:00Z'),
    fetchLog: [],
    gates: new Map(),
    renders: [],
    coinCacheSets: [],
  };
  const fetchImpl = (url) => {
    state.fetchLog.push(url);
    return new Promise((resolve) => {
      state.gates.set(url, (payload) => resolve({ ok: true, json: async () => payload }));
    });
  };
  const respond = (url, payload) => state.gates.get(url)?.(payload);
  const list = { set innerHTML(v) { state.renders.push(v); }, get innerHTML() { return state.renders[state.renders.length - 1] || ''; } };
  const Cache = { set: (k, v, ttl) => state.coinCacheSets.push(k) };
  const DateObj = { now: () => state.now };

  const wrapper = [
    'const Date = __g.DateObj;',
    'const fetch = __g.fetchImpl;',
    'const API_BASE = "https://test.local";',
    'const _SEARCH_RESULT_CACHE_TTL_MS = 60 * 1000;',
    'const _SEARCH_RESULT_CACHE_MAX = 20;',
    'let _searchResultCache = new Map();',
    'let _lastSearchTerm = "";',
    'const allForexPairs = [];',
    'const allCoins = [{ symbol: "BTCL", name: "local btc", priceUsd: 1 }];',
    'const Cache = __g.Cache;',
    'const t = (k) => k;',
    'const renderMarketItem = (item) => `<div>${item.symbol}</div>`;',
    'const buildInfoBar = (count, label) => `BAR(${count})`;',
    'const list = __g.list;',
    'function __searchBranch(searchTerm) {',
    SEARCH_BRANCH_SRC.replace(/^    /gm, '    '),
    '}',
    'function __getCacheSize() { return _searchResultCache.size; }',
    'function __getCacheKeys() { return [..._searchResultCache.keys()]; }',
    'return { __searchBranch, __getCacheSize, __getCacheKeys };',
  ].join('\n');

  const sb = new Function('__g', wrapper)({
    DateObj, fetchImpl, Cache, list,
  });
  return { state, respond, sb, list };
}

const mkResp = (syms) => ({ results: syms.map(s => ({ symbol: s, name: s, priceUsd: 1, changePercent24Hr: 0, volume: 0 })), total_index: 1700 });
const settle = () => new Promise(r => setImmediate(r));

// ============================================================================
// Scenarios
// ============================================================================
test('MK-10 S1: same query twice within TTL → exactly ONE network fetch (was 2)', async () => {
  const { state, respond, sb } = makeSandbox();
  sb.__searchBranch('bit');
  respond('https://test.local/api/market/search?q=bit', mkResp(['BTC', 'BITE']));
  await settle();
  state.renders.length = 0;
  sb.__searchBranch('bit'); // cache hit — no fetch, no gate
  await settle();
  assert.equal(state.fetchLog.length, 1, 'the repeat query must be served from the cache');
  assert.ok(state.renders[state.renders.length - 1].includes('BTC'), 'results rendered from cache');
});

test('MK-10 S2: different queries both fetch (no cross-contamination)', async () => {
  const { state, respond, sb } = makeSandbox();
  sb.__searchBranch('bit');
  respond('https://test.local/api/market/search?q=bit', mkResp(['BTC']));
  await settle();
  sb.__searchBranch('eth');
  respond('https://test.local/api/market/search?q=eth', mkResp(['ETH']));
  await settle();
  assert.equal(state.fetchLog.length, 2);
  assert.ok(state.renders[state.renders.length - 1].includes('ETH'), 'latest query rendered');
});

test('MK-10 S3: stale-response guard preserved — a late response for an OLD query is discarded', async () => {
  const { state, respond, sb } = makeSandbox();
  sb.__searchBranch('bit');
  sb.__searchBranch('eth'); // user retyped before 'bit' resolved
  respond('https://test.local/api/market/search?q=bit', mkResp(['BTC']));
  respond('https://test.local/api/market/search?q=eth', mkResp(['ETH']));
  await settle();
  const last = state.renders[state.renders.length - 1];
  assert.ok(!last.includes('BTC') || last.includes('ETH'), 'stale bit-response must not overwrite the eth render');
  assert.ok(last.includes('ETH'), 'current query result rendered');
});

test('MK-10 S4: debounce + input handler unchanged (source pin)', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = strip(APP_SRC);
  assert.match(code, /setTimeout\(\(\) => \{[\s\S]{0,200}renderMarket\(\)/, 'debounced renderMarket preserved');
  assert.match(code, /_lastSearchTerm = searchTerm/, 'input handler still records the term per keystroke');
});

test('MK-10 S5: cache hit renders IDENTICAL results (same render path)', async () => {
  const { state, respond, sb } = makeSandbox();
  sb.__searchBranch('bit');
  respond('https://test.local/api/market/search?q=bit', mkResp(['BTC', 'BITE']));
  await settle();
  const first = state.renders[state.renders.length - 1];
  state.renders.length = 0;
  sb.__searchBranch('bit');
  await settle();
  const second = state.renders[state.renders.length - 1];
  assert.equal(second, first, 'cache hit must render byte-identical output');
});

test('MK-10 S6: TTL expiry (60s) → the query is re-fetched', async () => {
  const { state, respond, sb } = makeSandbox();
  sb.__searchBranch('bit');
  respond('https://test.local/api/market/search?q=bit', mkResp(['BTC']));
  await settle();
  state.now += 61 * 1000; // TTL expired
  sb.__searchBranch('bit');
  assert.equal(state.fetchLog.length, 2, 'expired entry must trigger a fresh fetch');
  respond('https://test.local/api/market/search?q=bit', mkResp(['BTC']));
  await settle();
});

test('MK-10 S7: cache is BOUND to 20 entries — oldest evicted (capped memory)', async () => {
  const { state, respond, sb } = makeSandbox();
  for (let i = 1; i <= 21; i++) {
    sb.__searchBranch(`q${i}`);
    respond(`https://test.local/api/market/search?q=q${i}`, mkResp([`C${i}`]));
    await settle();
  }
  assert.equal(sb.__getCacheSize(), 20, 'cache size capped at 20');
  const keys = sb.__getCacheKeys();
  assert.ok(!keys.includes('q1'), 'oldest entry evicted');
  assert.ok(keys.includes('q21'), 'newest entry retained');
});

test('MK-10 S8: errors and degraded fallback renders are NEVER cached', async () => {
  const { state, respond, sb } = makeSandbox();
  // (a) empty results (0 hits) are not cached
  sb.__searchBranch('nothing');
  respond('https://test.local/api/market/search?q=nothing', { results: [], total_index: 1700 });
  await settle();
  assert.equal(sb.__getCacheSize(), 0, 'empty-result responses must not be cached');
  assert.ok(state.renders[state.renders.length - 1].includes('search_no_result'), 'no-result state rendered');

  // (b) source pin: only the successful path writes to the cache
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = strip(APP_SRC);
  const branch = code.slice(code.indexOf('if (searchTerm) {'), code.indexOf('// Tab-based rendering (no search)'));
  const cacheWrites = (branch.match(/_searchResultCache\.set\(/g) || []).length;
  assert.equal(cacheWrites, 1, 'exactly one cache write site');
  assert.match(branch, /if \(!data \|\| !data\.results \|\| data\.results\.length === 0\) \{\s*\n\s*applySearchData\(data, searchTerm\);\s*\n\s*return;\s*\n\s*\}/,
    'empty/error responses return BEFORE the cache write');
  // (c) the degraded allCoins fallback lives in .catch — never touches the cache
  const catchZone = branch.slice(branch.indexOf('.catch('));
  assert.ok(!catchZone.includes('_searchResultCache'), 'the fallback render never writes the cache');
});

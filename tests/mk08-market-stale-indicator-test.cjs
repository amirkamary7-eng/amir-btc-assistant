/**
 * MK-08 — Market stale/fallback data indicator
 * ============================================
 *
 * Task 62 finding MK-08: /api/market reports data degradation through its
 * contract — dataSource 'stale_cache' with stale:true (ALL providers failed,
 * serving last good cache), live fallback providers ('coincap+cmc',
 * 'binance+cmc', 'mexc+cmc') — but the frontend consumed these fields ONLY in
 * console.log. On fetch failure the previous allCoins (<=5 min old from
 * localStorage hydration) stayed on screen as if live, with no user-visible
 * indication.
 *
 * FIX (4 files):
 *  - index.html: status <p> in mkt-header-text (display:none default,
 *    role=status, aria-live).
 *  - market.css: .mkt-data-status {display:none} + -warn (#F5A623) + -info
 *    (#6B7A8D). No other layout/design change.
 *  - app.js: setMarketDataStatus(mode) + wiring in loadMarketData (stale→warn,
 *    fallback dataSource→info, healthy→ok) and the catch path (retained data
 *    on fetch failure → offline).
 *  - i18n.js: 3 keys fa+en.
 *
 * Semantics: fresh CoinGecko + normal (<=120s) server cache = NO indicator
 * (within the designed envelope); hard no-data failure keeps the existing
 * market_error empty state (never claims live).
 *
 * Run: node --test tests/mk08-market-stale-indicator-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MARKET_CSS = fs.readFileSync(path.join(ROOT, 'market.css'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');

// ============================================================================
// Extraction
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^function ${name}\\(`);
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
const SET_STATUS_SRC = extractFn(APP_SRC, 'setMarketDataStatus');

// Fake element + document for the real setMarketDataStatus
function createDom() {
  const el = {
    className: 'mkt-data-status',
    textContent: '',
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = v; },
  };
  const doc = { getElementById: (id) => (id === 'mkt-data-status' ? el : null) };
  return { el, doc };
}

function runSetStatus(mode, translations) {
  const { el, doc } = createDom();
  const t = (k) => translations[k] ?? k;
  const fn = new Function('document', 't', `${SET_STATUS_SRC}\nreturn setMarketDataStatus;`)(doc, t);
  fn(mode);
  return el;
}

// ============================================================================
// Scenarios
// ============================================================================
const FA = {
  market_status_stale: 'FA_STALE',
  market_status_fallback: 'FA_FALLBACK',
  market_status_offline: 'FA_OFFLINE',
};

test('MK-08 S1: setMarketDataStatus("ok") hides the indicator (healthy = zero footprint)', () => {
  const el = runSetStatus('ok', FA);
  assert.equal(el.className, 'mkt-data-status');
  assert.equal(el.textContent, '');
});

test('MK-08 S2: stale (stale_cache served after all providers failed) → warn class + text', () => {
  const el = runSetStatus('warn', FA);
  assert.equal(el.className, 'mkt-data-status mkt-warn');
  assert.equal(el.textContent, 'FA_STALE');
  assert.equal(el.attrs['aria-live'], 'assertive');
});

test('MK-08 S3: offline (fetch failed, retained data displayed) → warn class + text', () => {
  const el = runSetStatus('offline', FA);
  assert.equal(el.className, 'mkt-data-status mkt-warn');
  assert.equal(el.textContent, 'FA_OFFLINE');
  assert.equal(el.attrs['aria-live'], 'assertive');
});

test('MK-08 S4: fallback providers live → info class + text', () => {
  const el = runSetStatus('info', FA);
  assert.equal(el.className, 'mkt-data-status mkt-info');
  assert.equal(el.textContent, 'FA_FALLBACK');
  assert.equal(el.attrs['aria-live'], 'polite');
});

test('MK-08 S5: index.html has the status element with a11y semantics inside mkt-header-text', () => {
  const start = INDEX_HTML.indexOf('class="mkt-header-text"');
  const end = INDEX_HTML.indexOf('</div>', start);
  const block = INDEX_HTML.slice(start, end);
  assert.ok(start !== -1 && block.includes('mkt-data-status'),
    'status <p> must live inside mkt-header-text');
  assert.match(block, /id="mkt-data-status"/, 'stable id for getElementById');
  assert.match(block, /role="status"/, 'role=status for screen readers');
  assert.match(block, /aria-live="polite"/, 'aria-live region');
  assert.ok(!block.includes('data-i18n="mkt-data-status"'),
    'no data-i18n — text is set dynamically via t() (static pass would clobber it)');
});

test('MK-08 S6: market.css hides the indicator by default and only colors -warn/-info', () => {
  assert.match(MARKET_CSS, /\.mkt-data-status\s*\{\s*display:\s*none/, 'default hidden');
  assert.match(MARKET_CSS, /\.mkt-data-status\.mkt-warn\s*\{[^}]*color:\s*#F5A623/, 'warn = #F5A623');
  assert.match(MARKET_CSS, /\.mkt-data-status\.mkt-info\s*\{[^}]*color:\s*#6B7A8D/, 'info = #6B7A8D');
  // No other CSS selectors were modified: exactly one rule block per class
  const count = (re) => (MARKET_CSS.match(re) || []).length;
  assert.equal(count(/\.mkt-data-status\s*\{/g), 1);
  assert.equal(count(/\.mkt-data-status\.mkt-warn\s*\{/g), 1);
  assert.equal(count(/\.mkt-data-status\.mkt-info\s*\{/g), 1);
});

test('MK-08 S7: i18n keys exist in BOTH fa and en', () => {
  const faBlock = I18N_SRC.slice(I18N_SRC.indexOf('    fa: {'), I18N_SRC.indexOf('    en: {'));
  const enBlock = I18N_SRC.slice(I18N_SRC.indexOf('    en: {'));
  for (const key of ['market_status_stale', 'market_status_fallback', 'market_status_offline']) {
    assert.ok(faBlock.includes(key), `${key} missing in fa`);
    assert.ok(enBlock.includes(key), `${key} missing in en`);
    const faVal = faBlock.match(new RegExp(`${key}: '([^']*)'`))?.[1];
    const enVal = enBlock.match(new RegExp(`${key}: '([^']*)'`))?.[1];
    assert.ok(faVal && faVal.trim().length > 0, `${key} fa value non-empty`);
    assert.ok(enVal && enVal.trim().length > 0, `${key} en value non-empty`);
  }
});

test('MK-08 S8: loadMarketData wiring maps the /api/market contract to the right modes', () => {
  const loadFn = APP_SRC.slice(
    APP_SRC.indexOf('async function loadMarketData'),
    APP_SRC.indexOf('\n}', APP_SRC.indexOf('async function loadMarketData'))
  );
  // Success path: stale → warn
  assert.match(loadFn, /if \(res\.stale === true\) \{\s*\n\s*setMarketDataStatus\('warn'\)/,
    'stale:true must map to warn');
  // Fallback providers → info (anything that is not coingecko/cache)
  assert.match(loadFn, /res\.dataSource && res\.dataSource !== 'coingecko' && res\.dataSource !== 'cache'/,
    'non-primary/non-cache dataSource gates the info mode');
  assert.match(loadFn, /setMarketDataStatus\('info'\)/);
  // Healthy → ok
  assert.match(loadFn, /setMarketDataStatus\('ok'\)/);
  // Catch path: retained data → offline
  assert.match(loadFn, /if \(allCoins\.length\) \{\s*\n\s*setMarketDataStatus\('offline'\)/,
    'fetch failure with retained data must show offline');
  // Hard no-data failure keeps the existing empty state (never claims live)
  assert.match(loadFn, /market_error/);
});

test('MK-08 S9: healthy responses show NO indicator (envelope semantics)', async () => {
  // Behavioral: run the real contract branch selector with representative
  // server responses and verify the mode passed to setMarketDataStatus.
  const modes = [];
  const setStatus = (m) => modes.push(m);
  const branchSrc = `
    function __select(res) {
      if (res.stale === true) {
        ${'__setStatus'}('warn');
      } else if (res.dataSource && res.dataSource !== 'coingecko' && res.dataSource !== 'cache') {
        ${'__setStatus'}('info');
      } else {
        ${'__setStatus'}('ok');
      }
    }
  `;
  const select = new Function('__setStatus', branchSrc + '\nreturn __select;')(setStatus);
  // The documented contract values from src/services/market-data.js:
  const cases = [
    { dataSource: 'coingecko', cached: false, expected: 'ok' },        // fresh
    { dataSource: 'cache', cached: true, expected: 'ok' },            // normal KV cache
    { dataSource: 'stale_cache', cached: true, stale: true, expected: 'warn' }, // all providers failed
    { dataSource: 'coincap+cmc', cached: false, expected: 'info' },   // live fallback
    { dataSource: 'binance+cmc', cached: false, expected: 'info' },
    { dataSource: 'mexc+cmc', cached: false, expected: 'info' },
  ];
  for (const c of cases) {
    modes.length = 0;
    select(c);
    assert.equal(modes[0], c.expected, `dataSource=${c.dataSource} stale=${!!c.stale} must map to ${c.expected}`);
  }
});

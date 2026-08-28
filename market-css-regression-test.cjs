/**
 * market.css Extraction — Regression Test (Phase 4)
 * ==================================================
 * Run: node --test market-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const marketSrc = fs.readFileSync(path.join(__dirname, 'market.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// Market selectors that MUST be in market.css
const MKT_SELECTORS = [
  '.mkt-header', '.mkt-overview-grid', '.mkt-stat-card',
  '.mkt-coin-row', '.mkt-coin-logo', '.mkt-coin-symbol',
  '.mkt-forex-group', '.mkt-forex-row'
];

for (const sel of MKT_SELECTORS) {
  test(`MKT: market.css has ${sel}`, () => {
    assert.ok(marketSrc.includes(sel), `market.css must contain ${sel}`);
  });
}

// style.css must NOT have .mkt- definitions (0 remaining)
test('STYLE: style.css has 0 .mkt- selector definitions', () => {
  const mktDefs = styleSrc.match(/^\.mkt-/gm) || [];
  assert.equal(mktDefs.length, 0, `style.css must NOT define any .mkt- selectors — found ${mktDefs.length}`);
});

// .market-ticker must STAY in style.css (shared, not extracted)
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/,
    'style.css must keep .market-ticker (shared between Dashboard and Market)');
});

// .cd- (coin detail) must STAY in style.css
test('KEEP: style.css still has .cd-fullscreen', () => {
  assert.match(styleSrc, /\.cd-fullscreen\s*\{/,
    'style.css must keep .cd-fullscreen (coin-detail, not market)');
});

// No duplication with other CSS files
test('NO-DUP: .mkt-header NOT in base/components/dashboard', () => {
  assert.ok(!/\.mkt-header\s*\{/.test(baseSrc));
  assert.ok(!/\.mkt-header\s*\{/.test(compSrc));
  assert.ok(!/\.mkt-header\s*\{/.test(dashSrc));
});

// market.css does NOT contain shared selectors
const NOT_IN_MARKET = ['.app-header', '.bottom-nav', '.skeleton-hero', '#dashboard-page', '.modal '];
for (const sel of NOT_IN_MARKET) {
  test(`NOMKT: market.css does NOT define ${sel}`, () => {
    const defPattern = new RegExp(sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&') + '\\s*\\{', 'm');
    assert.ok(!defPattern.test(marketSrc), `market.css must NOT define ${sel}`);
  });
}

// Load order
test('HTML: market.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="market\.css">/);
});
test('HTML: market.css loads AFTER dashboard.css', () => {
  assert.ok(htmlSrc.indexOf('dashboard.css') < htmlSrc.indexOf('market.css'));
});
test('HTML: market.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('market.css') < htmlSrc.indexOf('style.css'));
});

// Build pipeline
test('BUILD: market.css in prepare-pages.mjs', () => {
  assert.match(buildSrc, /'market\.css'/);
});

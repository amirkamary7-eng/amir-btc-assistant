/**
 * dashboard.css Extraction — Regression Test (Phase 3)
 * =====================================================
 * Run: node --test dashboard-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const dashSrc = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// Dashboard selectors that MUST be in dashboard.css
const DASH_SELECTORS = [
  '#dashboard-page', '.hero-banner-slider', '.hero-slide', '.hero-cta',
  '.dashboard-market-status', '.dms-card', '.dms-fg-gauge', '.dms-trend-graphic',
  '.dashboard-bottom-spacer', '.dashboard-featured-analysis-wrap',
  '.dashboard-calendar', '.trend-fallback'
];

for (const sel of DASH_SELECTORS) {
  test(`DASH: dashboard.css has ${sel}`, () => {
    assert.ok(dashSrc.includes(sel), `dashboard.css must contain ${sel}`);
  });
}

// These must NOT be in dashboard.css (they're shared/other-page)
const NOT_IN_DASH = ['.market-ticker-track', '.nav-item', '.app-header', '.skeleton-hero'];
for (const sel of NOT_IN_DASH) {
  test(`NODASH: dashboard.css does NOT contain ${sel} definition`, () => {
    // Allow references in comments, but not as a selector definition
    const defPattern = new RegExp(`^\\s*${sel.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}\\s*[{,]`, 'm');
    assert.ok(!defPattern.test(dashSrc), `dashboard.css must NOT define ${sel}`);
  });
}

// style.css must still have the later overrides (glassmorphism)
test('OVERRIDE: style.css keeps .dms-card glassmorphism override', () => {
  assert.match(styleSrc, /Improve Dashboard cards with glassmorphism/,
    'style.css must keep the later .dms-card glassmorphism override');
  assert.match(styleSrc, /\.dms-card\s*\{[\s\S]*?overflow:\s*hidden/,
    'style.css must keep .dms-card { overflow: hidden } override');
});

// style.css must still have market ticker
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/,
    'style.css must keep .market-ticker (shared component, not extracted)');
});

// No duplication with base.css / components.css
test('NO-DUP: .hero-banner-slider NOT in base.css or components.css', () => {
  assert.ok(!/\.hero-banner-slider\s*\{/.test(baseSrc));
  assert.ok(!/\.hero-banner-slider\s*\{/.test(compSrc));
});

test('NO-DUP: #dashboard-page NOT in base.css or components.css', () => {
  assert.ok(!/#dashboard-page\s*\{/.test(baseSrc));
  assert.ok(!/#dashboard-page\s*\{/.test(compSrc));
});

// Load order
test('HTML: dashboard.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="dashboard\.css">/);
});
test('HTML: dashboard.css loads AFTER components.css', () => {
  assert.ok(htmlSrc.indexOf('components.css') < htmlSrc.indexOf('dashboard.css'));
});
test('HTML: dashboard.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('dashboard.css') < htmlSrc.indexOf('style.css'));
});

// Build pipeline
test('BUILD: dashboard.css in prepare-pages.mjs', () => {
  assert.match(buildSrc, /'dashboard\.css'/);
});

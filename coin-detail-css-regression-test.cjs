/**
 * coin-detail.css Extraction — Regression Test (Phase 6)
 * =======================================================
 * Run: node --test coin-detail-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const cdSrc = fs.readFileSync(path.join(__dirname, 'coin-detail.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// Coin-detail selectors in coin-detail.css
const CD_SELECTORS = [
  '.cd-fullscreen', '.cd-top-bar', '.cd-identity', '.cd-coin-logo',
  '.cd-title', '.cd-price', '.cd-change', '.cd-actions',
  '.cd-content', '.cd-chart', '.cd-stats-grid', '.cd-tf-bar',
  '.cd-alert-card', '.cd-section'
];

for (const sel of CD_SELECTORS) {
  test(`CD: coin-detail.css has ${sel}`, () => {
    assert.ok(cdSrc.includes(sel), `coin-detail.css must contain ${sel}`);
  });
}

// style.css must NOT have .cd- definitions (except body.jl-locked override)
test('STYLE: style.css has only body.jl-locked .cd- override (no definitions)', () => {
  const cdDefs = styleSrc.match(/^\.cd-/gm) || [];
  assert.equal(cdDefs.length, 0, `style.css must NOT define any .cd- selectors — found ${cdDefs.length}`);
});

test('STYLE: style.css keeps body.jl-locked .cd-fullscreen override', () => {
  assert.ok(styleSrc.includes('body.jl-locked .cd-fullscreen'),
    'style.css must keep the body.jl-locked .cd-fullscreen override');
});

// .tk- (tickets) was extracted to tickets.css in Phase 7
test('KEEP: .tk-overlay is in tickets.css, not style.css (Phase 7)', () => {
  assert.ok(!/\.tk-overlay\s*\{/.test(styleSrc),
    'style.css should NOT have .tk-overlay — it was extracted to tickets.css in Phase 7');
});

// No duplication with base/components
test('NO-DUP: .cd-fullscreen NOT in base.css or components.css', () => {
  assert.ok(!/\.cd-fullscreen\s*\{/.test(baseSrc));
  assert.ok(!/\.cd-fullscreen\s*\{/.test(compSrc));
});

// @keyframes
test('KEYFRAMES: coin-detail.css has @keyframes cdSlideIn', () => {
  assert.match(cdSrc, /@keyframes\s+cdSlideIn/);
});
test('KEYFRAMES: coin-detail.css has @keyframes cdSlideOut', () => {
  assert.match(cdSrc, /@keyframes\s+cdSlideOut/);
});

// Load order
test('HTML: coin-detail.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="coin-detail\.css">/);
});
test('HTML: coin-detail.css loads AFTER news.css', () => {
  assert.ok(htmlSrc.indexOf('news.css') < htmlSrc.indexOf('coin-detail.css'));
});
test('HTML: coin-detail.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('coin-detail.css') < htmlSrc.indexOf('style.css'));
});

// Build pipeline
test('BUILD: coin-detail.css in prepare-pages.mjs', () => {
  assert.match(buildSrc, /'coin-detail\.css'/);
});

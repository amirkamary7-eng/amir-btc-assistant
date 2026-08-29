/**
 * analysis-detail.css Extraction — Regression Test (Phase 5)
 * ===========================================================
 * Verifies that Analysis Detail (.adp-*) and Image Viewer (.iv-*)
 * CSS were correctly extracted from style.css into analysis-detail.css.
 *
 * Run: node --test analysis-detail-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const adSrc = fs.readFileSync(path.join(__dirname, 'analysis-detail.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// .adp-* selectors in analysis-detail.css
// ============================================================================

const ADP_SELECTORS = [
  '.adp-progress-bar', '.adp-header', '.adp-back-btn', '.adp-header-info',
  '.adp-header-title', '.adp-coin-avatar', '.adp-coin-badge', '.adp-tf-badge',
  '.adp-views-badge', '.adp-admin-btns', '.adp-body', '.adp-image-wrap',
  '.adp-image', '.adp-image-zoom-hint', '.adp-title', '.adp-levels',
  '.adp-content', '.adp-content-p', '.adp-meta', '.adp-meta-dot',
  '.adp-footer', '.adp-action-btn', '.adp-bookmark-btn', '.adp-share-btn',
  '.adp-sentiment', '.adp-related', '.adp-related-header', '.adp-related-list',
  '.adp-related-item', '.adp-related-coin', '.adp-related-info',
  '.adp-related-title', '.adp-related-meta', '.adp-related-arrow'
];

const IV_SELECTORS = [
  '.iv-overlay', '.iv-header', '.iv-close-btn', '.iv-viewport', '.iv-controls', '.iv-btn'
];

for (const sel of ADP_SELECTORS) {
  test(`ADP: analysis-detail.css has ${sel}`, () => {
    assert.ok(adSrc.includes(sel), `analysis-detail.css must contain ${sel}`);
  });
}

for (const sel of IV_SELECTORS) {
  test(`IV: analysis-detail.css has ${sel}`, () => {
    assert.ok(adSrc.includes(sel), `analysis-detail.css must contain ${sel}`);
  });
}

// style.css must NOT have .adp-/.iv- definitions (except @media override)
test('STYLE: style.css has 0 .adp-* base selectors', () => {
  const defs = styleSrc.match(/^\.adp-/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .adp-* selectors — found ${defs.length}`);
});

test('STYLE: style.css has 0 .iv-* selectors', () => {
  const defs = styleSrc.match(/^\.iv-/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .iv-* selectors — found ${defs.length}`);
});

test('STYLE: style.css has 0 #region 5', () => {
  assert.ok(!styleSrc.includes('#region 5'), 'style.css must NOT have #region 5');
});

test('STYLE: style.css has 0 #region 6', () => {
  assert.ok(!styleSrc.includes('#region 6'), 'style.css must NOT have #region 6');
});

// KEPT: .adp-levels @media override stays in style.css
test('KEEP: style.css still has .adp-levels @media override', () => {
  assert.ok(styleSrc.includes('.adp-levels'), 'style.css must keep .adp-levels @media override (shared @media block)');
});

// KEPT: #region 7 (Admin Form Modal)
test('KEEP: style.css still has #region 7', () => {
  assert.ok(styleSrc.includes('#region 7'), 'style.css must keep #region 7 (Admin Form Modal)');
});

// KEPT: shared selectors
test('KEEP: style.css still has .input-field', () => {
  assert.match(styleSrc, /^\.input-field\s*\{/m);
});

test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});

// No duplication with other extracted CSS files
test('NO-DUP: .adp-* NOT in base.css or components.css (except admin-ready rule)', () => {
  // base.css has body:not(.admin-ready) .adp-admin-btns — that's a usage, not a definition
  assert.ok(!/^\.adp-/gm.test(baseSrc), 'base.css must NOT define .adp-* selectors');
  assert.ok(!/^\.adp-/gm.test(compSrc), 'components.css must NOT define .adp-* selectors');
});

test('NO-DUP: .iv-* NOT in base.css or components.css', () => {
  assert.ok(!/\.iv-overlay/.test(baseSrc));
  assert.ok(!/\.iv-overlay/.test(compSrc));
});

// Load order
test('HTML: analysis-detail.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="analysis-detail\.css">/);
});

test('HTML: analysis-detail.css loads AFTER price-alerts.css', () => {
  assert.ok(htmlSrc.indexOf('price-alerts.css') < htmlSrc.indexOf('analysis-detail.css'),
    'analysis-detail.css must load AFTER price-alerts.css');
});

test('HTML: analysis-detail.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('analysis-detail.css') < htmlSrc.indexOf('style.css'),
    'analysis-detail.css must load BEFORE style.css');
});

// Build pipeline
test('BUILD: analysis-detail.css in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'analysis-detail\.css'/);
});

test('BUILD: analysis-detail.css listed BEFORE style.css in hashedFiles', () => {
  assert.ok(buildSrc.indexOf("'analysis-detail.css'") < buildSrc.indexOf("'style.css'"),
    'analysis-detail.css must be listed before style.css in hashedFiles array');
});

// CSS integrity
test('INTEGRITY: analysis-detail.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of adSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

test('INTEGRITY: style.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

// Size sanity
test('SIZE: analysis-detail.css has 700+ lines', () => {
  const lineCount = adSrc.split('\n').length;
  assert.ok(lineCount >= 700, `analysis-detail.css should have 700+ lines, has ${lineCount}`);
});

test('SIZE: style.css reduced (was 6450, should be < 5800)', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 5800, `style.css should be < 5800 lines after extraction, has ${lineCount}`);
});

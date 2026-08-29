/**
 * price-alerts.css Extraction — Regression Test (Phase 4)
 * ========================================================
 * Verifies that Price Alerts CSS was correctly extracted from style.css
 * into price-alerts.css with no regressions.
 *
 * Run: node --test price-alerts-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const paSrc = fs.readFileSync(path.join(__dirname, 'price-alerts.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// Price Alerts selectors in price-alerts.css
// ============================================================================

const ALERT_SELECTORS = [
  '.alert-section-header', '.alert-hint', '.alert-form',
  '.alert-direction-row', '.alert-dir-btn', '.alert-price-wrapper',
  '.alert-price-prefix', '.alert-price-input', '.alert-submit-btn',
  '.alert-list', '.alert-item', '.alert-item-left',
  '.alert-item-status-dot', '.alert-item-info', '.alert-item-top',
  '.alert-item-symbol', '.alert-item-badge', '.alert-item-target',
  '.alert-remove-btn', '.alert-empty'
];

const TREND_SELECTORS = [
  '.trend-strength-section', '.trend-strength-header',
  '.trend-strength-bar', '.trend-strength-fill', '.trend-strength-label'
];

for (const sel of ALERT_SELECTORS) {
  test(`ALERT: price-alerts.css has ${sel}`, () => {
    assert.ok(paSrc.includes(sel), `price-alerts.css must contain ${sel}`);
  });
}

for (const sel of TREND_SELECTORS) {
  test(`TREND: price-alerts.css has ${sel}`, () => {
    assert.ok(paSrc.includes(sel), `price-alerts.css must contain ${sel}`);
  });
}

// style.css must NOT have .alert-form/.alert-dir-*/.alert-item-*/.trend-strength-*
test('STYLE: style.css has 0 .alert-form definitions', () => {
  const defs = styleSrc.match(/^\.alert-form\s*\{/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-form — found ${defs.length}`);
});

test('STYLE: style.css has 0 .alert-dir-* definitions', () => {
  const defs = styleSrc.match(/^\.alert-dir-/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-dir-* — found ${defs.length}`);
});

test('STYLE: style.css has 0 .alert-item-* definitions', () => {
  const defs = styleSrc.match(/^\.alert-item/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-item-* — found ${defs.length}`);
});

test('STYLE: style.css has 0 .trend-strength-* definitions', () => {
  const defs = styleSrc.match(/^\.trend-strength/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .trend-strength-* — found ${defs.length}`);
});

test('STYLE: style.css has 0 .alert-list definitions', () => {
  const defs = styleSrc.match(/^\.alert-list\s*\{/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-list — found ${defs.length}`);
});

test('STYLE: style.css has 0 .alert-price-* definitions', () => {
  const defs = styleSrc.match(/^\.alert-price/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-price-* — found ${defs.length}`);
});

test('STYLE: style.css has 0 .alert-submit-btn definitions', () => {
  const defs = styleSrc.match(/^\.alert-submit-btn/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-submit-btn — found ${defs.length}`);
});

test('STYLE: style.css has 0 .alert-remove-btn definitions', () => {
  const defs = styleSrc.match(/^\.alert-remove-btn/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT have .alert-remove-btn — found ${defs.length}`);
});

test('STYLE: style.css has 0 #region هشدار قیمت', () => {
  assert.ok(!styleSrc.includes('#region هشدار قیمت'), 'style.css must NOT have #region هشدار قیمت');
});

// KEPT: Shared selectors must stay in style.css
test('KEEP: style.css still has .input-field', () => {
  assert.match(styleSrc, /^\.input-field\s*\{/m, 'style.css must keep .input-field (shared)');
});

test('KEEP: style.css still has .submit-btn', () => {
  assert.match(styleSrc, /^\.submit-btn\s*\{/m, 'style.css must keep .submit-btn (shared)');
});

// KEPT: Coin Detail alert selectors (different from Price Alerts form)
test('KEEP: style.css still has .alert-section (Coin Detail)', () => {
  assert.match(styleSrc, /^\.alert-section\s*\{/m, 'style.css must keep .alert-section (Coin Detail)');
});

test('KEEP: style.css still has .alert-current-price (Coin Detail)', () => {
  assert.match(styleSrc, /^\.alert-current-price\s*\{/m, 'style.css must keep .alert-current-price (Coin Detail)');
});

// KEPT: .market-ticker
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});

// No duplication with other extracted CSS files
test('NO-DUP: .alert-form NOT in base.css or components.css', () => {
  assert.ok(!/\.alert-form/.test(baseSrc));
  assert.ok(!/\.alert-form/.test(compSrc));
});

test('NO-DUP: .trend-strength NOT in base.css or components.css', () => {
  assert.ok(!/\.trend-strength/.test(baseSrc));
  assert.ok(!/\.trend-strength/.test(compSrc));
});

// Load order
test('HTML: price-alerts.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="price-alerts\.css">/);
});

test('HTML: price-alerts.css loads AFTER announcement.css', () => {
  assert.ok(htmlSrc.indexOf('announcement.css') < htmlSrc.indexOf('price-alerts.css'),
    'price-alerts.css must load AFTER announcement.css');
});

test('HTML: price-alerts.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('price-alerts.css') < htmlSrc.indexOf('style.css'),
    'price-alerts.css must load BEFORE style.css');
});

// Build pipeline
test('BUILD: price-alerts.css in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'price-alerts\.css'/);
});

test('BUILD: price-alerts.css listed BEFORE style.css in hashedFiles', () => {
  assert.ok(buildSrc.indexOf("'price-alerts.css'") < buildSrc.indexOf("'style.css'"),
    'price-alerts.css must be listed before style.css in hashedFiles array');
});

// CSS integrity
test('INTEGRITY: price-alerts.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of paSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

test('INTEGRITY: style.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

// Size sanity
test('SIZE: price-alerts.css has 200+ lines', () => {
  const lineCount = paSrc.split('\n').length;
  assert.ok(lineCount >= 200, `price-alerts.css should have 200+ lines, has ${lineCount}`);
});

test('SIZE: style.css reduced (was 6644, should be < 6500)', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 6500, `style.css should be < 6500 lines after extraction, has ${lineCount}`);
});

/**
 * tickets.css Extraction — Regression Test (Phase 7)
 * ==================================================
 * Run: node --test tickets-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const tkSrc = fs.readFileSync(path.join(__dirname, 'tickets.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const mbSrc = fs.readFileSync(path.join(__dirname, 'membership.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// Ticket selectors in tickets.css
const TK_SELECTORS = [
  '.tk-overlay', '.tk-sheet', '.tk-handle', '.tk-header',
  '.tk-close', '.tk-body', '.tk-form-card', '.tk-input',
  '.tk-submit-btn', '.tk-mini-spinner', '.tk-list',
  '.tk-card', '.tk-card-header', '.tk-badge'
];

for (const sel of TK_SELECTORS) {
  test(`TK: tickets.css has ${sel}`, () => {
    assert.ok(tkSrc.includes(sel), `tickets.css must contain ${sel}`);
  });
}

// style.css must NOT have .tk- definitions
test('STYLE: style.css has 0 .tk- selectors', () => {
  const tkDefs = styleSrc.match(/^\.tk-/gm) || [];
  assert.equal(tkDefs.length, 0, `style.css must NOT define any .tk- selectors — found ${tkDefs.length}`);
});

// body.jl-locked moved to membership.css (Phase 8)
test('KEEP: membership.css has body.jl-locked', () => {
  assert.ok(mbSrc.includes('body.jl-locked'), 'membership.css must have body.jl-locked (moved from style.css in Phase 8)');
});
test('MOVED: style.css no longer has body.jl-locked', () => {
  assert.ok(!styleSrc.includes('body.jl-locked'), 'style.css must NOT have body.jl-locked (moved to membership.css in Phase 8)');
});

// .market-ticker stays
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});

// .join-status-bar moved to membership.css (Phase 8)
test('KEEP: membership.css has .join-status-bar', () => {
  assert.ok(mbSrc.includes('.join-status-bar'), 'membership.css must have .join-status-bar (moved from style.css in Phase 8)');
});
test('MOVED: style.css no longer has .join-status-bar', () => {
  assert.ok(!styleSrc.includes('.join-status-bar'), 'style.css must NOT have .join-status-bar (moved to membership.css in Phase 8)');
});

// No duplication with base/components
test('NO-DUP: .tk-overlay NOT in base.css or components.css', () => {
  assert.ok(!/\.tk-overlay\s*\{/.test(baseSrc));
  assert.ok(!/\.tk-overlay\s*\{/.test(compSrc));
});

// @keyframes
test('KEYFRAMES: tickets.css has @keyframes tkSpin', () => {
  assert.match(tkSrc, /@keyframes\s+tkSpin/);
});

// Load order
test('HTML: tickets.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="tickets\.css">/);
});
test('HTML: tickets.css loads AFTER coin-detail.css', () => {
  assert.ok(htmlSrc.indexOf('coin-detail.css') < htmlSrc.indexOf('tickets.css'));
});
test('HTML: tickets.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('tickets.css') < htmlSrc.indexOf('style.css'));
});

// Build pipeline
test('BUILD: tickets.css in prepare-pages.mjs', () => {
  assert.match(buildSrc, /'tickets\.css'/);
});

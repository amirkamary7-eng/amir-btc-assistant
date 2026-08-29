/**
 * announcement.css Extraction — Regression Test (Phase 3)
 * ========================================================
 * Verifies that Beta-popup and Ad-popup CSS were correctly extracted from
 * style.css into announcement.css with no regressions.
 *
 * Run: node --test announcement-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const annSrc = fs.readFileSync(path.join(__dirname, 'announcement.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// Beta-popup selectors in announcement.css
// ============================================================================

const BETA_SELECTORS = [
  '.beta-popup-overlay', '.beta-popup-card', '.beta-popup-header',
  '.beta-popup-glow', '.beta-popup-badge', '.beta-popup-orbit',
  '.beta-popup-body', '.beta-popup-title', '.beta-popup-desc',
  '.beta-popup-detail', '.beta-popup-report', '.beta-popup-report-title',
  '.beta-popup-report-text', '.beta-popup-report-icon', '.beta-popup-report-desc',
  '.beta-popup-actions', '.beta-popup-btn-primary', '.beta-popup-btn-secondary',
  '.beta-popup-closing'
];

for (const sel of BETA_SELECTORS) {
  test(`BETA: announcement.css has ${sel}`, () => {
    assert.ok(annSrc.includes(sel), `announcement.css must contain ${sel}`);
  });
}

// Beta-popup @keyframes
const BETA_KEYFRAMES = ['beta-overlay-in', 'beta-overlay-out', 'beta-card-in', 'beta-card-out', 'beta-glow-pulse'];

for (const kf of BETA_KEYFRAMES) {
  test(`BETA-KF: announcement.css has @keyframes ${kf}`, () => {
    assert.match(annSrc, new RegExp(`@keyframes\\s+${kf}`));
  });
}

// ============================================================================
// Ad-popup selectors in announcement.css
// ============================================================================

const AD_SELECTORS = [
  '.ad-popup-overlay', '.ad-popup-card', '.ad-popup-close',
  '.ad-popup-image-wrap', '.ad-popup-image', '.ad-popup-body',
  '.ad-popup-title', '.ad-popup-text', '.ad-popup-button',
  '.ad-popup-closing'
];

for (const sel of AD_SELECTORS) {
  test(`AD: announcement.css has ${sel}`, () => {
    assert.ok(annSrc.includes(sel), `announcement.css must contain ${sel}`);
  });
}

// Ad-popup @keyframes
const AD_KEYFRAMES = ['ad-overlay-in', 'ad-card-in', 'ad-card-out'];

for (const kf of AD_KEYFRAMES) {
  test(`AD-KF: announcement.css has @keyframes ${kf}`, () => {
    assert.match(annSrc, new RegExp(`@keyframes\\s+${kf}`));
  });
}

// ============================================================================
// style.css must NOT have beta-popup/ad-popup definitions
// ============================================================================

test('STYLE: style.css has 0 .beta-popup selectors', () => {
  const defs = styleSrc.match(/^\.beta-popup/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .beta-popup selectors — found ${defs.length}`);
});

test('STYLE: style.css has 0 .ad-popup selectors', () => {
  const defs = styleSrc.match(/^\.ad-popup/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .ad-popup selectors — found ${defs.length}`);
});

test('STYLE: style.css has 0 @keyframes beta-*', () => {
  assert.ok(!/@keyframes\s+beta-/.test(styleSrc), 'style.css must NOT have any @keyframes beta-*');
});

test('STYLE: style.css has 0 @keyframes ad-*', () => {
  assert.ok(!/@keyframes\s+ad-/.test(styleSrc), 'style.css must NOT have any @keyframes ad-*');
});

test('STYLE: style.css has 0 BETA LAUNCH POPUP', () => {
  assert.ok(!styleSrc.includes('BETA LAUNCH POPUP'), 'style.css must NOT have BETA LAUNCH POPUP section');
});

test('STYLE: style.css has 0 ADVERTISEMENT POPUP', () => {
  assert.ok(!styleSrc.includes('ADVERTISEMENT POPUP'), 'style.css must NOT have ADVERTISEMENT POPUP section');
});

// ============================================================================
// KEPT: Adjacent sections must stay in style.css
// ============================================================================

test('KEEP: style.css still has PHASE 5 — Profile Cosmetics', () => {
  assert.ok(styleSrc.includes('PHASE 5 — Profile Cosmetics'), 'style.css must keep Cosmetics section');
});

test('KEEP: style.css still has PHASE 2 UI FIX', () => {
  assert.ok(styleSrc.includes('PHASE 2 UI FIX'), 'style.css must keep PHASE 2 UI FIX section');
});

test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});

// ============================================================================
// No duplication with other extracted CSS files
// ============================================================================

test('NO-DUP: .beta-popup NOT in base.css or components.css', () => {
  assert.ok(!/\.beta-popup/.test(baseSrc));
  assert.ok(!/\.beta-popup/.test(compSrc));
});

test('NO-DUP: .ad-popup NOT in base.css or components.css', () => {
  assert.ok(!/\.ad-popup/.test(baseSrc));
  assert.ok(!/\.ad-popup/.test(compSrc));
});

// ============================================================================
// Load order
// ============================================================================

test('HTML: announcement.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="announcement\.css">/);
});

test('HTML: announcement.css loads AFTER maintenance.css', () => {
  assert.ok(htmlSrc.indexOf('maintenance.css') < htmlSrc.indexOf('announcement.css'),
    'announcement.css must load AFTER maintenance.css');
});

test('HTML: announcement.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('announcement.css') < htmlSrc.indexOf('style.css'),
    'announcement.css must load BEFORE style.css');
});

// ============================================================================
// Build pipeline
// ============================================================================

test('BUILD: announcement.css in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'announcement\.css'/);
});

test('BUILD: announcement.css listed BEFORE style.css in hashedFiles', () => {
  assert.ok(buildSrc.indexOf("'announcement.css'") < buildSrc.indexOf("'style.css'"),
    'announcement.css must be listed before style.css in hashedFiles array');
});

// ============================================================================
// CSS integrity
// ============================================================================

test('INTEGRITY: announcement.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of annSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

test('INTEGRITY: style.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

// @media preserved
test('MEDIA: announcement.css has @media (max-width: 360px)', () => {
  assert.match(annSrc, /@media\s*\(max-width:\s*360px\)/);
});

test('MEDIA: announcement.css has @media (max-width: 400px)', () => {
  assert.match(annSrc, /@media\s*\(max-width:\s*400px\)/);
});

test('MEDIA: announcement.css has prefers-reduced-motion', () => {
  assert.match(annSrc, /@media\s*\(prefers-reduced-motion:\s*reduce\)/);
});

// Size sanity
test('SIZE: announcement.css has 500+ lines', () => {
  const lineCount = annSrc.split('\n').length;
  assert.ok(lineCount >= 500, `announcement.css should have 500+ lines, has ${lineCount}`);
});

test('SIZE: style.css reduced (was 7157, should be < 6700)', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 6700, `style.css should be < 6700 lines after extraction, has ${lineCount}`);
});

/**
 * maintenance.css Extraction — Regression Test (Phase 2)
 * =======================================================
 * Verifies that Maintenance Mode CSS was correctly extracted from style.css
 * into maintenance.css with no regressions.
 *
 * Run: node --test maintenance-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const maintSrc = fs.readFileSync(path.join(__dirname, 'maintenance.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const compSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// Maintenance selectors in maintenance.css
// ============================================================================

const MAINT_SELECTORS = [
  '.maint-overlay', '.maint-content', '.maint-particles', '.maint-particle',
  '.maint-data-streams', '.maint-stream-line', '.maint-stream-1',
  '.maint-stream-2', '.maint-stream-3', '.maint-core-scene', '.maint-core-svg',
  '.maint-core-deepglow', '.maint-core-aurora', '.maint-core-reflection',
  '.maint-core-toplight', '.maint-badge', '.maint-title', '.maint-desc',
  '.maint-status-rotator', '.maint-status-text', '.maint-progress-wrap',
  '.maint-progress-track', '.maint-progress-fill', '.maint-progress-label',
  '.maint-progress-percent', '.maint-progress-text', '.maint-admin-bypass'
];

const MC_SELECTORS = [
  '.mc-ring-outer', '.mc-ring-mid', '.mc-ring-inner', '.mc-core-hex',
  '.mc-beams', '.mc-orbit', '.mc-orbit-dot', '.mc-orbit-1', '.mc-orbit-2',
  '.mc-orbit-3', '.mc-orbit-4'
];

for (const sel of MAINT_SELECTORS) {
  test(`MAINT: maintenance.css has ${sel}`, () => {
    assert.ok(maintSrc.includes(sel), `maintenance.css must contain ${sel}`);
  });
}

for (const sel of MC_SELECTORS) {
  test(`MC: maintenance.css has ${sel}`, () => {
    assert.ok(maintSrc.includes(sel), `maintenance.css must contain ${sel}`);
  });
}

// @keyframes for Maintenance
const MAINT_KEYFRAMES = [
  'maintFadeIn', 'maintFloatUp', 'maintStreamPulse', 'maintCardIn',
  'mcFloat', 'mcDeepPulse', 'mcAuroraPulse', 'mcReflectPulse',
  'mcCorePulse', 'mcRotateCW', 'mcRotateCCW', 'mcOrbit1', 'mcOrbit2',
  'mcOrbit3', 'mcOrbit4', 'maintStatusFade', 'maintProgressShine'
];

for (const kf of MAINT_KEYFRAMES) {
  test(`KF: maintenance.css has @keyframes ${kf}`, () => {
    assert.match(maintSrc, new RegExp(`@keyframes\\s+${kf}`));
  });
}

// style.css must NOT have any .maint-/.mc definitions
test('STYLE: style.css has 0 .maint- selectors', () => {
  const defs = styleSrc.match(/^\.maint-/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .maint- selectors — found ${defs.length}`);
});

test('STYLE: style.css has 0 .mc selectors', () => {
  const defs = styleSrc.match(/^\.mc[A-Z]/gm) || [];
  assert.equal(defs.length, 0, `style.css must NOT define any .mc* selectors — found ${defs.length}`);
});

test('STYLE: style.css has 0 @keyframes maint* (overlay keyframes)', () => {
  // Note: @keyframes maint-spin is a separate keyframe in Ads Admin section
  // (used for admin access checking indicator), NOT part of Maintenance overlay.
  // Only check for the 17 overlay-specific keyframes.
  const overlayKeyframes = ['maintFadeIn', 'maintFloatUp', 'maintStreamPulse', 'maintCardIn',
    'maintStatusFade', 'maintProgressShine'];
  for (const kf of overlayKeyframes) {
    assert.ok(!new RegExp(`@keyframes\\s+${kf}`).test(styleSrc),
      `style.css must NOT have @keyframes ${kf} (moved to maintenance.css)`);
  }
});

test('STYLE: style.css has 0 @keyframes mc*', () => {
  assert.ok(!/@keyframes\s+mc[A-Z]/.test(styleSrc), 'style.css must NOT have any @keyframes mc*');
});

test('STYLE: style.css has 0 #region Maintenance Mode', () => {
  assert.ok(!styleSrc.includes('#region Maintenance Mode'), 'style.css must NOT have #region Maintenance Mode');
});

test('STYLE: style.css has 0 #endregion Maintenance Mode', () => {
  assert.ok(!styleSrc.includes('#endregion Maintenance Mode'), 'style.css must NOT have #endregion Maintenance Mode');
});

// KEPT: .ptr-indicator (was after Maintenance, must stay in style.css)
test('KEEP: style.css still has .ptr-indicator', () => {
  assert.ok(styleSrc.includes('.ptr-indicator'), 'style.css must keep .ptr-indicator (Analysis page, not Maintenance)');
});

// KEPT: .market-ticker and other shared components
test('KEEP: style.css still has .market-ticker', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{/);
});

test('KEEP: style.css still has #endregion Admin Panel Rebuild', () => {
  assert.ok(styleSrc.includes('#endregion Admin Panel Rebuild'), 'style.css must keep Admin Panel section');
});

// No duplication with other extracted CSS files
test('NO-DUP: .maint-overlay NOT in base.css, components.css, or ai.css', () => {
  const aiSrc = fs.readFileSync(path.join(__dirname, 'ai.css'), 'utf8');
  assert.ok(!/\.maint-overlay/.test(baseSrc));
  assert.ok(!/\.maint-overlay/.test(compSrc));
  assert.ok(!/\.maint-overlay/.test(aiSrc));
});

test('NO-DUP: .mc-core-hex NOT in base.css, components.css, or ai.css', () => {
  const aiSrc = fs.readFileSync(path.join(__dirname, 'ai.css'), 'utf8');
  assert.ok(!/\.mc-core-hex/.test(baseSrc));
  assert.ok(!/\.mc-core-hex/.test(compSrc));
  assert.ok(!/\.mc-core-hex/.test(aiSrc));
});

// Load order
test('HTML: maintenance.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="maintenance\.css">/);
});

test('HTML: maintenance.css loads AFTER ai.css', () => {
  assert.ok(htmlSrc.indexOf('ai.css') < htmlSrc.indexOf('maintenance.css'),
    'maintenance.css must load AFTER ai.css');
});

test('HTML: maintenance.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('maintenance.css') < htmlSrc.indexOf('style.css'),
    'maintenance.css must load BEFORE style.css');
});

// Build pipeline
test('BUILD: maintenance.css in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'maintenance\.css'/);
});

test('BUILD: maintenance.css listed BEFORE style.css in hashedFiles', () => {
  assert.ok(buildSrc.indexOf("'maintenance.css'") < buildSrc.indexOf("'style.css'"),
    'maintenance.css must be listed before style.css in hashedFiles array');
});

// CSS integrity
test('INTEGRITY: maintenance.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of maintSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

test('INTEGRITY: style.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

// @media preserved
test('MEDIA: maintenance.css has @media (max-width: 380px)', () => {
  assert.match(maintSrc, /@media\s*\(max-width:\s*380px\)/);
});

// Size sanity
test('SIZE: maintenance.css has 350+ lines', () => {
  const lineCount = maintSrc.split('\n').length;
  assert.ok(lineCount >= 350, `maintenance.css should have 350+ lines, has ${lineCount}`);
});

test('SIZE: style.css reduced (was 7530, should be < 7200)', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 7200, `style.css should be < 7200 lines after extraction, has ${lineCount}`);
});

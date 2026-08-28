/**
 * components.css Extraction — Regression Test
 * ============================================
 * Verifies Phase 2 CSS extraction: shared components moved from style.css
 * to components.css.
 *
 * Run: node --test components-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const componentsSrc = fs.readFileSync(path.join(__dirname, 'components.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const mbSrc = fs.readFileSync(path.join(__dirname, 'membership.css'), 'utf8');
const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// components.css has the shared components
// ============================================================================

test('COMP-1: components.css has .skeleton-hero', () => {
  assert.match(componentsSrc, /\.skeleton-hero\s*\{/,
    'components.css must have .skeleton-hero');
});

test('COMP-2: components.css has .skeleton-card', () => {
  assert.match(componentsSrc, /\.skeleton-card\s*\{/,
    'components.css must have .skeleton-card');
});

test('COMP-3: components.css has .skeleton-line', () => {
  assert.match(componentsSrc, /\.skeleton-line\s*\{/,
    'components.css must have .skeleton-line');
});

test('COMP-4: components.css has .modal', () => {
  assert.match(componentsSrc, /\.modal\s*\{/,
    'components.css must have .modal');
});

test('COMP-5: components.css has .modal-box', () => {
  assert.match(componentsSrc, /\.modal-box\s*\{/,
    'components.css must have .modal-box');
});

test('COMP-6: components.css has .modal-header', () => {
  assert.match(componentsSrc, /\.modal-header\s*\{/,
    'components.css must have .modal-header');
});

test('COMP-7: components.css has .bottom-nav', () => {
  assert.match(componentsSrc, /\.bottom-nav\s*\{/,
    'components.css must have .bottom-nav');
});

test('COMP-8: components.css has .nav-item', () => {
  assert.match(componentsSrc, /\.nav-item\s*\{/,
    'components.css must have .nav-item');
});

test('COMP-9: components.css has .scroll-top-btn', () => {
  assert.match(componentsSrc, /\.scroll-top-btn\s*\{/,
    'components.css must have .scroll-top-btn');
});

test('COMP-10: components.css has .empty-state', () => {
  assert.match(componentsSrc, /\.empty-state\s*\{/,
    'components.css must have .empty-state');
});

test('COMP-11: components.css has .cancel-btn', () => {
  assert.match(componentsSrc, /\.cancel-btn\s*\{/,
    'components.css must have .cancel-btn (shared modal action button)');
});

// ============================================================================
// style.css NO LONGER DEFINES these (moved to components.css)
// ============================================================================

test('STYLE-1: style.css no longer DEFINES .skeleton-hero', () => {
  assert.ok(!/\.skeleton-hero\s*\{/.test(styleSrc),
    'style.css must NOT define .skeleton-hero — it is in components.css');
});

test('STYLE-2: style.css no longer DEFINES .modal', () => {
  assert.ok(!/^\.modal\s*\{/m.test(styleSrc),
    'style.css must NOT define .modal (top-level) — it is in components.css');
});

test('STYLE-3: style.css no longer DEFINES .bottom-nav', () => {
  assert.ok(!/^\.bottom-nav\s*\{/m.test(styleSrc),
    'style.css must NOT define .bottom-nav (top-level) — it is in components.css');
});

test('STYLE-4: style.css no longer DEFINES .empty-state (top-level)', () => {
  assert.ok(!/^\.empty-state\s*\{/m.test(styleSrc),
    'style.css must NOT define .empty-state (top-level) — it is in components.css');
});

test('STYLE-5: style.css no longer DEFINES .scroll-top-btn', () => {
  assert.ok(!/\.scroll-top-btn\s*\{/.test(styleSrc),
    'style.css must NOT define .scroll-top-btn — it is in components.css');
});

// ============================================================================
// Later overrides STAY in style.css (cascade preserved)
// ============================================================================

test('OVERRIDE-1: .modal-box @media override stays in style.css', () => {
  assert.match(styleSrc, /\.modal-box\s*\{/,
    'style.css must KEEP the .modal-box @media override (later in cascade)');
});

test('OVERRIDE-2: body.jl-locked .bottom-nav override moved to membership.css (Phase 8)', () => {
  assert.match(mbSrc, /body\.jl-locked\s+\.bottom-nav/,
    'membership.css must have the body.jl-locked .bottom-nav override (moved from style.css in Phase 8)');
  assert.ok(!/body\.jl-locked\s+\.bottom-nav/.test(styleSrc),
    'style.css must NOT have body.jl-locked .bottom-nav (moved to membership.css in Phase 8)');
});

test('OVERRIDE-3: .tk-list .empty-state moved to tickets.css (Phase 7)', () => {
  // This was in style.css during Phase 2, but Phase 7 extracted all .tk-* to tickets.css.
  // Now it should be in tickets.css, not style.css.
  assert.ok(!/\.tk-list\s+\.empty-state/.test(styleSrc),
    'style.css should NOT have .tk-list .empty-state — it was extracted to tickets.css in Phase 7');
});

// ============================================================================
// No duplication between base.css and components.css
// ============================================================================

test('NO-DUP-1: .skeleton-shimmer keyframe is in base.css, NOT components.css', () => {
  assert.match(baseSrc, /@keyframes\s+skeleton-shimmer/,
    'base.css must have @keyframes skeleton-shimmer (extracted in Phase 1)');
  assert.ok(!/@keyframes\s+skeleton-shimmer/.test(componentsSrc),
    'components.css must NOT duplicate @keyframes skeleton-shimmer');
});

// ============================================================================
// Load order in index.html
// ============================================================================

test('HTML-1: components.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="components\.css">/,
    'index.html must have <link rel="stylesheet" href="components.css">');
});

test('HTML-2: components.css loads AFTER base.css', () => {
  const baseIdx = htmlSrc.indexOf('base.css');
  const compIdx = htmlSrc.indexOf('components.css');
  assert.ok(baseIdx > -1 && compIdx > -1);
  assert.ok(baseIdx < compIdx,
    'base.css must load BEFORE components.css');
});

test('HTML-3: components.css loads BEFORE style.css', () => {
  const compIdx = htmlSrc.indexOf('components.css');
  const styleIdx = htmlSrc.indexOf('style.css');
  assert.ok(compIdx > -1 && styleIdx > -1);
  assert.ok(compIdx < styleIdx,
    'components.css must load BEFORE style.css (preserves cascade: components defined first, overrides in style.css apply later)');
});

// ============================================================================
// Build pipeline
// ============================================================================

test('BUILD-1: components.css is in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'components\.css'/,
    'prepare-pages.mjs must include components.css in the hashedFiles array');
});

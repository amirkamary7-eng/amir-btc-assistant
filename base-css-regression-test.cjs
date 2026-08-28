/**
 * base.css Extraction — Regression Test
 * =======================================
 *
 * Verifies that:
 *   1. base.css exists and contains :root variables
 *   2. style.css no longer contains :root (it's in base.css)
 *   3. base.css has header/brand/live-indicator/notif-btn
 *   4. style.css no longer has those base sections
 *   5. base.css loads BEFORE style.css in index.html
 *   6. prepare-pages.mjs includes base.css in hashedFiles
 *   7. base.css has the CSS reset (* + body)
 *   8. base.css has skeleton-shimmer keyframe
 *   9. base.css has coin-icon-fallback
 *   10. base.css has priceFlash animations
 *
 * Run: node --test base-css-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const baseSrc = fs.readFileSync(path.join(__dirname, 'base.css'), 'utf8');
const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const buildSrc = fs.readFileSync(path.join(__dirname, 'scripts/prepare-pages.mjs'), 'utf8');

// ============================================================================
// base.css has the base sections
// ============================================================================

test('BASE-1: base.css defines :root variables', () => {
  assert.match(baseSrc, /:root\s*\{/,
    'base.css must have :root { ... } with CSS variables');
  assert.match(baseSrc, /--bg-primary/,
    'base.css must define --bg-primary');
  assert.match(baseSrc, /--accent/,
    'base.css must define --accent');
});

test('BASE-2: base.css has global reset', () => {
  assert.match(baseSrc, /\*\s*\{\s*margin:\s*0/,
    'base.css must have the global * reset');
  assert.match(baseSrc, /body\s*\{/,
    'base.css must have body styling');
});

test('BASE-3: base.css has admin flash prevention', () => {
  assert.match(baseSrc, /body:not\(\.admin-ready\)/,
    'base.css must have admin flash prevention rules');
});

test('BASE-4: base.css has skeleton-shimmer keyframe', () => {
  assert.match(baseSrc, /@keyframes\s+skeleton-shimmer/,
    'base.css must have @keyframes skeleton-shimmer');
});

test('BASE-5: base.css has scrollbar styling', () => {
  assert.match(baseSrc, /::-webkit-scrollbar/,
    'base.css must have ::-webkit-scrollbar');
});

test('BASE-6: base.css has coin-icon-fallback', () => {
  assert.match(baseSrc, /\.coin-icon-fallback/,
    'base.css must have .coin-icon-fallback');
});

test('BASE-7: base.css has priceFlash animations', () => {
  assert.match(baseSrc, /@keyframes\s+priceFlashGreen/,
    'base.css must have @keyframes priceFlashGreen');
  assert.match(baseSrc, /@keyframes\s+priceFlashRed/,
    'base.css must have @keyframes priceFlashRed');
});

test('BASE-8: base.css has header', () => {
  assert.match(baseSrc, /\.app-header/,
    'base.css must have .app-header');
});

test('BASE-9: base.css has brand', () => {
  assert.match(baseSrc, /\.header-brand/,
    'base.css must have .header-brand');
  assert.match(baseSrc, /\.brand-amirbtc/,
    'base.css must have .brand-amirbtc');
});

test('BASE-10: base.css has live indicator', () => {
  assert.match(baseSrc, /\.live-indicator/,
    'base.css must have .live-indicator');
  assert.match(baseSrc, /\.live-count/,
    'base.css must have .live-count');
});

test('BASE-11: base.css has notification button', () => {
  assert.match(baseSrc, /\.notif-btn/,
    'base.css must have .notif-btn');
  assert.match(baseSrc, /\.notif-badge/,
    'base.css must have .notif-badge');
});

test('BASE-12: base.css has section headers', () => {
  assert.match(baseSrc, /\.section-header/,
    'base.css must have .section-header');
  assert.match(baseSrc, /\.section-title/,
    'base.css must have .section-title');
});

test('BASE-13: base.css has .page and .page.active', () => {
  assert.match(baseSrc, /\.page\s*\{/,
    'base.css must have .page { ... }');
  assert.match(baseSrc, /\.page\.active/,
    'base.css must have .page.active');
});

test('BASE-14: base.css has @keyframes fadeSlide', () => {
  assert.match(baseSrc, /@keyframes\s+fadeSlide/,
    'base.css must have @keyframes fadeSlide (used by .page animation)');
});

// ============================================================================
// style.css NO LONGER has these base sections
// ============================================================================

test('STYLE-1: style.css no longer DEFINES primary :root variables', () => {
  // The primary :root DEFINITION (--bg-primary: #0B0F14; --accent: #FF8A00; etc.)
  // is in base.css. style.css still USES these via var(--accent) — that's correct.
  // We check that style.css does not DEFINE them (no :root block with --bg-primary:).
  assert.ok(!/--bg-primary\s*:/.test(styleSrc),
    'style.css must NOT DEFINE --bg-primary (no `--bg-primary:` assignment) — the :root definition is in base.css');
  assert.ok(!/--accent\s*:\s*#/.test(styleSrc),
    'style.css must NOT DEFINE --accent with a color value — the :root definition is in base.css');
});

test('STYLE-2: style.css no longer has global reset', () => {
  assert.ok(!/\*\s*\{\s*margin:\s*0/.test(styleSrc),
    'style.css must NOT have the global * reset — it should be in base.css');
});

test('STYLE-3: style.css no longer has .app-header', () => {
  assert.ok(!/\.app-header\s*\{/.test(styleSrc),
    'style.css must NOT have .app-header — it should be in base.css');
});

test('STYLE-4: style.css no longer has .brand-amirbtc', () => {
  assert.ok(!/\.brand-amirbtc\s*\{/.test(styleSrc),
    'style.css must NOT have .brand-amirbtc — it should be in base.css');
});

test('STYLE-5: style.css no longer has .live-indicator', () => {
  assert.ok(!/\.live-indicator\s*\{/.test(styleSrc),
    'style.css must NOT have .live-indicator — it should be in base.css');
});

test('STYLE-6: style.css no longer has .notif-btn definition', () => {
  // style.css may reference .notif-btn in other contexts but should not DEFINE it
  assert.ok(!/\.notif-btn\s*\{/.test(styleSrc),
    'style.css must NOT define .notif-btn — it should be in base.css');
});

// ============================================================================
// Load order in index.html
// ============================================================================

test('HTML-1: base.css link exists', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="base\.css">/,
    'index.html must have <link rel="stylesheet" href="base.css">');
});

test('HTML-2: base.css loads BEFORE style.css', () => {
  const baseIdx = htmlSrc.indexOf('base.css');
  const styleIdx = htmlSrc.indexOf('style.css');
  assert.ok(baseIdx > -1, 'base.css link not found');
  assert.ok(styleIdx > -1, 'style.css link not found');
  assert.ok(baseIdx < styleIdx,
    'base.css must load BEFORE style.css in index.html');
});

// ============================================================================
// Build pipeline
// ============================================================================

test('BUILD-1: base.css is in prepare-pages.mjs hashedFiles', () => {
  assert.match(buildSrc, /'base\.css'/,
    'prepare-pages.mjs must include base.css in the hashedFiles array');
});

// ============================================================================
// No duplication
// ============================================================================

test('NO-DUP-1: primary :root variable DEFINITIONS are NOT in both files', () => {
  // --bg-primary DEFINITION (--bg-primary: #0B0F14;) must be in base.css only.
  // style.css still USES var(--bg-primary) — that's correct and expected.
  const baseDefinesBgPrimary = /--bg-primary\s*:\s*#/.test(baseSrc);
  const styleDefinesBgPrimary = /--bg-primary\s*:\s*#/.test(styleSrc);
  assert.ok(baseDefinesBgPrimary && !styleDefinesBgPrimary,
    '--bg-primary DEFINITION must be in base.css ONLY, not in style.css');
});

test('NO-DUP-2: .app-header is NOT in both files', () => {
  const baseHas = /\.app-header\s*\{/.test(baseSrc);
  const styleHas = /\.app-header\s*\{/.test(styleSrc);
  assert.ok(baseHas && !styleHas,
    '.app-header must be in base.css ONLY, not in style.css');
});

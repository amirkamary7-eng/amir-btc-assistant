/**
 * Dead CSS Removal — Regression Test (Phase 10)
 * ===============================================
 * Verifies that proven-dead CSS was correctly removed from style.css
 * and that all LIVE CSS (false positives from Phase 9 audit) is preserved.
 *
 * Run: node --test dead-css-removal-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ============================================================================
// REMOVED: .pub-* (Telegram Publisher) — 0 JS/HTML refs, proven dead
// ============================================================================

test('REMOVED: style.css has 0 .pub-header definitions', () => {
  assert.ok(!/\.pub-header\s*\{/.test(styleSrc), '.pub-header must be removed (dead CSS)');
});
test('REMOVED: style.css has 0 .pub-stat-card definitions', () => {
  assert.ok(!/\.pub-stat-card/.test(styleSrc), '.pub-stat-card must be removed (dead CSS)');
});
test('REMOVED: style.css has 0 .pub-tabs definitions', () => {
  assert.ok(!/\.pub-tabs/.test(styleSrc), '.pub-tabs must be removed (dead CSS)');
});
test('REMOVED: style.css has 0 .pub-toolbar definitions', () => {
  assert.ok(!/\.pub-toolbar/.test(styleSrc), '.pub-toolbar must be removed (dead CSS)');
});
test('REMOVED: style.css has 0 TELEGRAM PUBLISHER comments', () => {
  assert.ok(!/TELEGRAM PUBLISHER/.test(styleSrc), 'TELEGRAM PUBLISHER comment must be removed');
});
test('REMOVED: style.css has 0 .pub- prefixed selectors', () => {
  const pubDefs = styleSrc.match(/^\.pub-/gm) || [];
  assert.equal(pubDefs.length, 0, `style.css must NOT have any .pub- selectors — found ${pubDefs.length}`);
});
test('REMOVED: style.css has 0 @keyframes pubPulse', () => {
  assert.ok(!/@keyframes\s+pubPulse/.test(styleSrc), '@keyframes pubPulse must be removed');
});
test('REMOVED: style.css has 0 @keyframes pubFadeIn', () => {
  assert.ok(!/@keyframes\s+pubFadeIn/.test(styleSrc), '@keyframes pubFadeIn must be removed');
});
test('REMOVED: style.css has 0 @keyframes pubSpin', () => {
  assert.ok(!/@keyframes\s+pubSpin/.test(styleSrc), '@keyframes pubSpin must be removed');
});
test('REMOVED: style.css has 0 @keyframes pubSlideDown', () => {
  assert.ok(!/@keyframes\s+pubSlideDown/.test(styleSrc), '@keyframes pubSlideDown must be removed');
});
test('REMOVED: style.css has 0 @keyframes pubShimmer', () => {
  assert.ok(!/@keyframes\s+pubShimmer/.test(styleSrc), '@keyframes pubShimmer must be removed');
});

// ============================================================================
// REMOVED: Beta-popup Block 2 (duplicate of Block 1)
// ============================================================================

test('REMOVED: style.css has exactly 1 .beta-popup-overlay definition (was 2)', () => {
  const defs = styleSrc.match(/\.beta-popup-overlay\s*\{/g) || [];
  assert.equal(defs.length, 1, `Expected 1 .beta-popup-overlay definition, found ${defs.length}`);
});
test('REMOVED: style.css has exactly 1 base .beta-popup-card definition (was 2)', () => {
  // Only count the base definition (not .beta-popup-closing .beta-popup-card or @media variants)
  const defs = styleSrc.match(/^\.beta-popup-card\s*\{/gm) || [];
  assert.equal(defs.length, 1, `Expected 1 base .beta-popup-card definition, found ${defs.length}`);
});
test('REMOVED: style.css has exactly 1 @keyframes beta-overlay-in (was 2)', () => {
  const defs = styleSrc.match(/@keyframes\s+beta-overlay-in/g) || [];
  assert.equal(defs.length, 1, `Expected 1 @keyframes beta-overlay-in, found ${defs.length}`);
});
test('REMOVED: style.css has exactly 1 @keyframes beta-card-in (was 2)', () => {
  const defs = styleSrc.match(/@keyframes\s+beta-card-in/g) || [];
  assert.equal(defs.length, 1, `Expected 1 @keyframes beta-card-in, found ${defs.length}`);
});
test('REMOVED: style.css has exactly 1 @keyframes beta-glow-pulse (was 2)', () => {
  const defs = styleSrc.match(/@keyframes\s+beta-glow-pulse/g) || [];
  assert.equal(defs.length, 1, `Expected 1 @keyframes beta-glow-pulse, found ${defs.length}`);
});
test('REMOVED: style.css has exactly 1 BETA LAUNCH POPUP comment (was 2)', () => {
  const defs = styleSrc.match(/BETA LAUNCH POPUP/g) || [];
  assert.equal(defs.length, 1, `Expected 1 BETA LAUNCH POPUP comment, found ${defs.length}`);
});

// ============================================================================
// REMOVED: Duplicate @keyframes spin (kept 1, removed 2)
// ============================================================================

test('REMOVED: style.css has exactly 1 @keyframes spin (was 3)', () => {
  const defs = styleSrc.match(/@keyframes\s+spin\s*\{/g) || [];
  assert.equal(defs.length, 1, `Expected 1 @keyframes spin, found ${defs.length}`);
});
test('KEPT: @keyframes spin definition exists (first definition preserved)', () => {
  // Just verify exactly one @keyframes spin definition exists
  const defs = styleSrc.match(/@keyframes\s+spin/g) || [];
  assert.equal(defs.length, 1, 'Exactly 1 @keyframes spin must exist (first definition preserved)');
});

// ============================================================================
// REMOVED: .market-summary-bar (0 JS/HTML refs, proven dead)
// ============================================================================

test('REMOVED: style.css has 0 .market-summary-bar definitions', () => {
  assert.ok(!/\.market-summary-bar/.test(styleSrc), '.market-summary-bar must be removed (dead CSS)');
});
test('REMOVED: style.css has 0 "Market Summary Bar" comments', () => {
  assert.ok(!/Market Summary Bar/.test(styleSrc), 'Market Summary Bar comment must be removed');
});

// ============================================================================
// KEPT (FALSE POSITIVES from Phase 9 — all are LIVE, used in CSS animations)
// ============================================================================

test('KEPT: @keyframes bs-fade-in still present (used by .bs-overlay.bs-open)', () => {
  assert.match(styleSrc, /@keyframes\s+bs-fade-in/);
  assert.match(styleSrc, /animation:\s*bs-fade-in/);
});
test('KEPT: @keyframes coinFadeOut still present (used by .coin-list.fade-out)', () => {
  assert.match(styleSrc, /@keyframes\s+coinFadeOut/);
  assert.match(styleSrc, /animation:\s*coinFadeOut/);
});
test('KEPT: @keyframes coinFadeIn still present (used by .coin-list.fade-in)', () => {
  assert.match(styleSrc, /@keyframes\s+coinFadeIn/);
  assert.match(styleSrc, /animation:\s*coinFadeIn/);
});
test('KEPT: @keyframes detailSlideUp still present (used by .detail-* animation)', () => {
  assert.match(styleSrc, /@keyframes\s+detailSlideUp/);
  assert.match(styleSrc, /animation:\s*detailSlideUp/);
});
test('KEPT: @keyframes detailSlideDown still present (used by .detail-* animation)', () => {
  assert.match(styleSrc, /@keyframes\s+detailSlideDown/);
  assert.match(styleSrc, /animation:\s*detailSlideDown/);
});

// ============================================================================
// KEPT: .summary-* shared classes (used by wallet.js, overridden by wallet.css)
// ============================================================================

test('KEPT: .summary-item still present (shared with wallet.js)', () => {
  assert.match(styleSrc, /\.summary-item\s*\{/);
});
test('KEPT: .summary-label still present (shared with wallet.js)', () => {
  assert.match(styleSrc, /\.summary-label\s*\{/);
});
test('KEPT: .summary-value still present (shared with wallet.js)', () => {
  assert.match(styleSrc, /\.summary-value\s*\{/);
});
test('KEPT: .summary-divider still present (shared with wallet.js)', () => {
  assert.match(styleSrc, /\.summary-divider\s*\{/);
});

// ============================================================================
// KEPT: Beta-popup Block 1 (the live block)
// ============================================================================

test('KEPT: .beta-popup-overlay still has valid definition', () => {
  assert.match(styleSrc, /\.beta-popup-overlay\s*\{[^}]*position:\s*fixed/);
});
test('KEPT: .beta-popup-card still has valid definition', () => {
  assert.match(styleSrc, /\.beta-popup-card\s*\{/);
});

// ============================================================================
// CSS integrity checks
// ============================================================================

test('INTEGRITY: style.css braces are balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

test('INTEGRITY: style.css has fewer lines than before removal', () => {
  const lineCount = styleSrc.split('\n').length;
  assert.ok(lineCount < 8968, `style.css should be < 8968 lines (was 8968 before Phase 10), has ${lineCount}`);
  assert.ok(lineCount > 7000, `style.css should still be > 7000 lines (sanity check), has ${lineCount}`);
});

// ============================================================================
// HTML still references style.css (no accidental removal of link tag)
// ============================================================================

test('HTML: style.css link tag still present', () => {
  assert.match(htmlSrc, /<link\s+rel="stylesheet"\s+href="style\.css">/);
});

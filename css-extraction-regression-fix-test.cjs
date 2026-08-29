/**
 * CSS Extraction Regression Fix — Regression Test
 * =================================================
 * Verifies that two regressions introduced by CSS extraction (Phase 3) are fixed:
 *
 * 1. Market Ticker: Missing /* comment opener caused CSS parse error that
 *    swallowed the .market-ticker base rule. The bare text "1b. MARKET TICKER"
 *    was parsed as an invalid selector, and error recovery consumed the
 *    .market-ticker { ... } block.
 *
 * 2. Important News: Legacy .important-news-* rules in style.css (lines 74-80)
 *    overrode the enhanced rules in dashboard.css because style.css loads
 *    AFTER dashboard.css. Before extraction, both were in style.css and the
 *    enhanced version (later in file) won. After extraction, the cascade
 *    inverted.
 *
 * Run: node --test css-extraction-regression-fix-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const styleSrc = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const dashSrc = fs.readFileSync(path.join(__dirname, 'dashboard.css'), 'utf8');
const htmlSrc = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');

// ============================================================================
// Bug 1: Market Ticker — missing /* comment opener
// ============================================================================

test('MT-1: style.css has /* opening comment before "1b. MARKET TICKER"', () => {
  // The bare text "1b. MARKET TICKER" must be inside a CSS comment,
  // not bare text that causes a parse error. Verify there's a /* before it
  // with no intervening */ that would close the comment.
  const idx = styleSrc.indexOf('1b. MARKET TICKER');
  assert.ok(idx > -1, 'style.css must contain "1b. MARKET TICKER"');
  // Look backwards from idx for the nearest /* and */
  const before = styleSrc.slice(0, idx);
  const lastOpen = before.lastIndexOf('/*');
  const lastClose = before.lastIndexOf('*/');
  assert.ok(lastOpen > lastClose,
    'style.css must have /* opening comment before "1b. MARKET TICKER" (was missing, caused CSS parse error that swallowed .market-ticker rule)');
});

test('MT-2: style.css has proper /* ... */ comment around MARKET TICKER header', () => {
  // Verify the comment is properly opened and closed
  assert.match(styleSrc, /\/\*[\s\S]*?1b\. MARKET TICKER[\s\S]*?\*\//,
    'style.css must have a proper /* ... */ comment containing "1b. MARKET TICKER"');
});

test('MT-3: style.css has .market-ticker base rule with height:46px', () => {
  // The base rule must exist and have height:46px (not overridden by parse error)
  assert.match(styleSrc, /\.market-ticker\s*\{[^}]*height:\s*46px/,
    '.market-ticker must have height:46px in its base rule');
});

test('MT-4: style.css has .market-ticker base rule with display:flex', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{[^}]*display:\s*flex/,
    '.market-ticker must have display:flex in its base rule');
});

test('MT-5: style.css has .market-ticker base rule with overflow:hidden', () => {
  assert.match(styleSrc, /\.market-ticker\s*\{[^}]*overflow:\s*hidden/,
    '.market-ticker must have overflow:hidden in its base rule');
});

test('MT-6: .market-ticker base rule NOT duplicated in dashboard.css or market.css', () => {
  const marketSrc = fs.readFileSync(path.join(__dirname, 'market.css'), 'utf8');
  assert.ok(!/\.market-ticker\s*\{/.test(dashSrc),
    'dashboard.css must NOT have .market-ticker base rule (it stays in style.css)');
  assert.ok(!/\.market-ticker\s*\{/.test(marketSrc),
    'market.css must NOT have .market-ticker base rule (it stays in style.css)');
});

// ============================================================================
// Bug 2: Important News — cascade inversion
// ============================================================================

test('IN-1: style.css does NOT have legacy .important-news-list base rule', () => {
  // The legacy base rule was removed because it overrode the enhanced version
  // in dashboard.css (style.css loads after dashboard.css).
  assert.ok(!/\.important-news-list\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-list base rule (moved to dashboard.css)');
});

test('IN-2: style.css does NOT have legacy .important-news-item base rule', () => {
  assert.ok(!/\.important-news-item\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-item base rule (moved to dashboard.css)');
});

test('IN-3: style.css does NOT have legacy .important-news-img base rule', () => {
  assert.ok(!/\.important-news-img\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-img base rule (moved to dashboard.css)');
});

test('IN-4: style.css does NOT have legacy .important-news-content base rule', () => {
  assert.ok(!/\.important-news-content\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-content base rule (moved to dashboard.css)');
});

test('IN-5: style.css does NOT have legacy .important-news-title base rule', () => {
  assert.ok(!/\.important-news-title\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-title base rule (moved to dashboard.css)');
});

test('IN-6: style.css does NOT have legacy .important-news-source base rule', () => {
  assert.ok(!/\.important-news-source\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-source base rule (moved to dashboard.css)');
});

test('IN-7: style.css KEEPS .important-news-item:hover (not in dashboard.css)', () => {
  // The :hover rule was always in the legacy block and is NOT duplicated in
  // dashboard.css. It provides the hover interaction on top of the enhanced base.
  assert.match(styleSrc, /\.important-news-item:hover\s*\{/,
    'style.css must KEEP .important-news-item:hover (not in dashboard.css)');
  assert.ok(!/\.important-news-item:hover\s*\{/.test(dashSrc),
    'dashboard.css must NOT have .important-news-item:hover (stays in style.css)');
});

// ============================================================================
// Enhanced rules in dashboard.css (verify they're intact)
// ============================================================================

test('IN-8: dashboard.css has enhanced .important-news-item with min-height:88px', () => {
  assert.match(dashSrc, /\.important-news-item\s*\{[^}]*min-height:\s*88px/,
    'dashboard.css must have enhanced .important-news-item with min-height:88px');
});

test('IN-9: dashboard.css has enhanced .important-news-item with gap:12px', () => {
  assert.match(dashSrc, /\.important-news-item\s*\{[^}]*gap:\s*12px/,
    'dashboard.css must have enhanced .important-news-item with gap:12px');
});

test('IN-10: dashboard.css has .important-news-item.priority-urgent', () => {
  assert.match(dashSrc, /\.important-news-item\.priority-urgent/);
});

// ============================================================================
// Load order verification
// ============================================================================

test('ORDER: dashboard.css loads BEFORE style.css', () => {
  assert.ok(htmlSrc.indexOf('dashboard.css') < htmlSrc.indexOf('style.css'),
    'dashboard.css must load BEFORE style.css (so style.css :hover adds on top)');
});

// ============================================================================
// Bug 3: .important-news-skeleton-* cascade inversion (same pattern as Bug 2)
// ============================================================================

test('SKEL-1: style.css does NOT have legacy .important-news-skeleton base rule', () => {
  assert.ok(!/\.important-news-skeleton\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-skeleton base rule (moved to dashboard.css)');
});
test('SKEL-2: style.css does NOT have legacy .important-news-skeleton-item base rule', () => {
  assert.ok(!/\.important-news-skeleton-item\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-skeleton-item base rule');
});
test('SKEL-3: style.css does NOT have legacy .important-news-skeleton-img base rule', () => {
  assert.ok(!/\.important-news-skeleton-img\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-skeleton-img base rule');
});
test('SKEL-4: style.css does NOT have legacy .important-news-skeleton-text base rule', () => {
  assert.ok(!/\.important-news-skeleton-text\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-skeleton-text base rule');
});
test('SKEL-5: style.css does NOT have legacy .important-news-skeleton-line base rule', () => {
  assert.ok(!/\.important-news-skeleton-line\s*\{/.test(styleSrc),
    'style.css must NOT have .important-news-skeleton-line base rule');
});
test('SKEL-6: style.css does NOT have legacy .important-news-skeleton-line:nth-child rules', () => {
  assert.ok(!/\.important-news-skeleton-line:nth-child/.test(styleSrc),
    'style.css must NOT have .important-news-skeleton-line:nth-child rules');
});
test('SKEL-7: dashboard.css has enhanced .important-news-skeleton with gap:10px', () => {
  assert.match(dashSrc, /\.important-news-skeleton\s*\{[^}]*gap:\s*10px/);
});
test('SKEL-8: dashboard.css has enhanced .important-news-skeleton-item with min-height:88px', () => {
  assert.match(dashSrc, /\.important-news-skeleton-item\s*\{[^}]*min-height:\s*88px/);
});
test('SKEL-9: dashboard.css has enhanced .important-news-skeleton-img with width:64px', () => {
  assert.match(dashSrc, /\.important-news-skeleton-img\s*\{[^}]*width:\s*64px/);
});

// ============================================================================
// Bug 4: @keyframes newsFadeIn cascade inversion
// ============================================================================

test('KF-1: style.css has @keyframes newsFadeIn with translateY(6px)', () => {
  assert.match(styleSrc, /@keyframes\s+newsFadeIn\s*\{[^}]*translateY\(6px\)/,
    'style.css must have @keyframes newsFadeIn with translateY(6px) (dashboard version, moved to win cascade)');
});
test('KF-2: dashboard.css does NOT have @keyframes newsFadeIn definition', () => {
  // The definition was moved to style.css; only a NOTE comment may remain
  assert.ok(!/@keyframes\s+newsFadeIn\s*\{/.test(dashSrc),
    'dashboard.css must NOT have @keyframes newsFadeIn definition (moved to style.css)');
});
test('KF-3: news.css still has @keyframes newsFadeIn with translateY(12px)', () => {
  const newsSrc = fs.readFileSync(path.join(__dirname, 'news.css'), 'utf8');
  assert.match(newsSrc, /@keyframes\s+newsFadeIn\s*\{[^}]*translateY\(12px\)/,
    'news.css must still have @keyframes newsFadeIn with translateY(12px) (unchanged)');
});
test('KF-4: style.css loads AFTER news.css (cascade order)', () => {
  assert.ok(htmlSrc.indexOf('news.css') < htmlSrc.indexOf('style.css'),
    'style.css must load AFTER news.css so the 6px version wins (matching baseline)');
});

// ============================================================================
// CSS integrity
// ============================================================================

test('INTEGRITY: style.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of styleSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});
test('INTEGRITY: dashboard.css braces balanced', () => {
  let open = 0, close = 0;
  for (const ch of dashSrc) { if (ch === '{') open++; if (ch === '}') close++; }
  assert.equal(open, close, `Brace mismatch: ${open} open vs ${close} close`);
});

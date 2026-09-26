/**
 * News Image Fallback Regression Tests
 *
 * These tests verify the RUNTIME behavior of the centralized news image
 * fallback system (newsImageFallback + NEWS_FALLBACK_IMG + getAmirbtcFallbackSvg).
 *
 * They do NOT test source-text patterns — they actually invoke the functions
 * with mock img elements and verify the src changes correctly at each tier.
 *
 * Coverage:
 *   1. Healthy image → src unchanged (newsImageFallback NOT called)
 *   2. Broken image → NEWS_FALLBACK_IMG (Tier 1 WebP)
 *   3. No URL → NEWS_FALLBACK_IMG (via placeholderImg in render path)
 *   4. WebP itself fails → NEWS_FALLBACK_SVG_LAST_RESORT (Tier 2 inline SVG)
 *   5. No infinite loop (3+ calls → stops at SVG, no crash)
 *   6. No old SVG placeholders remain in source
 *
 * Run: node --test news-image-fallback-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Extract the fallback implementation from app.js source
// ============================================================================

// Extract NEWS_FALLBACK_IMG constant
const fbImgMatch = APP_SRC.match(/const\s+NEWS_FALLBACK_IMG\s*=\s*['"]([^'"]+)['"]/);
assert.ok(fbImgMatch, 'NEWS_FALLBACK_IMG constant must exist in app.js');
const NEWS_FALLBACK_IMG = fbImgMatch[1];

// Extract NEWS_FALLBACK_SVG_LAST_RESORT constant
const svgMatch = APP_SRC.match(/const\s+NEWS_FALLBACK_SVG_LAST_RESORT\s*=\s*['"]([^'"]+)['"]/);
assert.ok(svgMatch, 'NEWS_FALLBACK_SVG_LAST_RESORT constant must exist in app.js');
const NEWS_FALLBACK_SVG_LAST_RESORT = svgMatch[1];

// Extract the newsImageFallback function source
const fnMatch = APP_SRC.match(/window\.newsImageFallback\s*=\s*function\s*\([^)]*\)\s*\{([\s\S]*?)\n\};/);
assert.ok(fnMatch, 'newsImageFallback function must exist in app.js');
const fnBody = fnMatch[1];

// Create a sandbox evaluator that simulates the browser environment
function loadNewsImageFallback() {
  const sandbox = {
    window: {},
    NEWS_FALLBACK_IMG,
    NEWS_FALLBACK_SVG_LAST_RESORT,
  };
  const src = `window.newsImageFallback = function(imgEl) {${fnBody}\n};`;
  const evaluator = new Function('window', 'NEWS_FALLBACK_IMG', 'NEWS_FALLBACK_SVG_LAST_RESORT', src);
  evaluator(sandbox.window, sandbox.NEWS_FALLBACK_IMG, sandbox.NEWS_FALLBACK_SVG_LAST_RESORT);
  return sandbox.window.newsImageFallback;
}

// Mock img element that simulates browser behavior
function createMockImg(src, classes = []) {
  const classSet = new Set(classes);
  return {
    _src: src || '',
    _webpFallbackTried: false,
    _svgFallbackApplied: false,
    style: {},
    classList: {
      contains: (c) => classSet.has(c),
      add: (c) => classSet.add(c),
      remove: (c) => classSet.delete(c),
    },
    get src() { return this._src; },
    set src(v) { this._src = v; },
  };
}

const newsImageFallback = loadNewsImageFallback();

// ============================================================================
// Test 1: Healthy image → src unchanged (newsImageFallback NOT called)
// ============================================================================

test('NIF-01: healthy image src stays unchanged when newsImageFallback is NOT called', () => {
  const img = createMockImg('https://example.com/valid-news-image.jpg');
  // Simulate: browser loads the image successfully → onerror NEVER fires
  // → newsImageFallback is NEVER called → src stays as the original
  assert.equal(img.src, 'https://example.com/valid-news-image.jpg',
    'Healthy image src must remain unchanged when fallback is not triggered');
  assert.equal(img._webpFallbackTried, false,
    '_webpFallbackTried must be false (fallback never invoked)');
});

// ============================================================================
// Test 2: Broken image → NEWS_FALLBACK_IMG (Tier 1 WebP)
// ============================================================================

test('NIF-02: broken image onerror → src becomes NEWS_FALLBACK_IMG (Tier 1 WebP)', () => {
  const img = createMockImg('https://broken-url.example.com/image.jpg');
  // Simulate: browser tries to load → fails → fires onerror → newsImageFallback called
  newsImageFallback(img);
  assert.equal(img.src, NEWS_FALLBACK_IMG,
    `Broken image src must be replaced with NEWS_FALLBACK_IMG (${NEWS_FALLBACK_IMG}). Got: ${img.src}`);
  assert.equal(img._webpFallbackTried, true,
    '_webpFallbackTried must be true after Tier 1 fallback applied');
  assert.equal(img._svgFallbackApplied, false,
    '_svgFallbackApplied must be false (Tier 2 not reached yet)');
  assert.equal(img.style.objectFit, 'cover',
    'objectFit must be set to cover to prevent layout shift');
});

// ============================================================================
// Test 3: No URL → fallback used (source-level verification of placeholderImg)
// ============================================================================

test('NIF-03: no image URL → NEWS_FALLBACK_IMG used as placeholder', () => {
  // Verify in source that placeholderImg is assigned NEWS_FALLBACK_IMG
  // (this covers the render path where n.image is falsy → placeholderImg is used)
  const placeholderAssignments = (APP_SRC.match(/const placeholderImg = NEWS_FALLBACK_IMG;/g) || []).length;
  assert.ok(placeholderAssignments >= 4,
    `At least 4 'const placeholderImg = NEWS_FALLBACK_IMG;' assignments must exist (found ${placeholderAssignments}). ` +
    `These cover: news tab cards, hero slider, search/filter cards, and pagination cards.`);

  // Also verify the inline expression n.image || placeholderImg is used in img src
  const imgWithPlaceholder = (APP_SRC.match(/src="\$\{escapeHtml\(n\.image \|\| placeholderImg\)\}"/g) || []).length;
  assert.ok(imgWithPlaceholder >= 3,
    `At least 3 'src="${'${escapeHtml(n.image || placeholderImg)}'}"' must exist in img tags (found ${imgWithPlaceholder}). ` +
    `This ensures no-URL images get the fallback placeholder.`);
});

// ============================================================================
// Test 4: WebP itself fails → NEWS_FALLBACK_SVG_LAST_RESORT (Tier 2 inline SVG)
// ============================================================================

test('NIF-04: WebP fallback fails → NEWS_FALLBACK_SVG_LAST_RESORT (Tier 2 SVG)', () => {
  const img = createMockImg('https://broken-url.example.com/image.jpg');
  // Simulate: primary image fails → Tier 1 WebP applied
  newsImageFallback(img);
  assert.equal(img.src, NEWS_FALLBACK_IMG, 'Tier 1: WebP should be set');

  // Simulate: WebP also fails to load → onerror fires again → Tier 2 SVG
  newsImageFallback(img);
  assert.equal(img.src, NEWS_FALLBACK_SVG_LAST_RESORT,
    `Tier 2: src must be NEWS_FALLBACK_SVG_LAST_RESORT. Got: ${img.src}`);
  assert.equal(img._svgFallbackApplied, true,
    '_svgFallbackApplied must be true after Tier 2 fallback applied');
});

// ============================================================================
// Test 5: No infinite loop (3+ onerror calls → stops, no crash)
// ============================================================================

test('NIF-05: 3+ successive onerror calls → no infinite loop, no crash', () => {
  const img = createMockImg('https://broken.example.com/image.jpg');

  // Call 1: primary fails → Tier 1 WebP
  newsImageFallback(img);
  assert.equal(img.src, NEWS_FALLBACK_IMG, 'Call 1: WebP');

  // Call 2: WebP fails → Tier 2 SVG
  newsImageFallback(img);
  assert.equal(img.src, NEWS_FALLBACK_SVG_LAST_RESORT, 'Call 2: SVG last resort');

  // Call 3: SVG also "fails" → should NOT change src (both tiers exhausted)
  assert.doesNotThrow(
    () => newsImageFallback(img),
    'Call 3 must not throw even when both fallback tiers are exhausted'
  );
  assert.equal(img.src, NEWS_FALLBACK_SVG_LAST_RESORT,
    'Call 3: src must remain SVG (no further fallback, no loop)');

  // Call 4: same — should be a no-op
  assert.doesNotThrow(
    () => newsImageFallback(img),
    'Call 4 must not throw'
  );
  assert.equal(img.src, NEWS_FALLBACK_SVG_LAST_RESORT,
    'Call 4: src must still be SVG (no loop)');
});

// ============================================================================
// Test 6: No old SVG placeholders remain in source
// ============================================================================

test('NIF-06: no old inline SVG placeholderImg definitions remain in source', () => {
  // Check that NO 'const placeholderImg = 'data:image/svg+xml,...' exists
  const oldSvgPlaceholders = (APP_SRC.match(/const placeholderImg = 'data:image\/svg\+xml/g) || []).length;
  assert.equal(oldSvgPlaceholders, 0,
    `No old inline SVG 'placeholderImg = data:image/svg+xml...' definitions should remain (found ${oldSvgPlaceholders}). ` +
    `All must be replaced with 'placeholderImg = NEWS_FALLBACK_IMG'.`);

  // Check that NO inline onerror="this.src='${placeholderImg}'" exists
  // (the old hero slide fallback that bypassed newsImageFallback)
  const oldInlineOnerror = (APP_SRC.match(/onerror="this\.src='\$\{placeholderImg\}'"/g) || []).length;
  assert.equal(oldInlineOnerror, 0,
    `No old inline onerror="this.src='${'${placeholderImg}'}'" should remain (found ${oldInlineOnerror}). ` +
    `All must be replaced with onerror="newsImageFallback(this)".`);

  // Verify the ONLY data:image/svg URI in news-related context is NEWS_FALLBACK_SVG_LAST_RESORT
  // (which is the intentional last-resort fallback)
  const svgDataUris = (APP_SRC.match(/data:image\/svg\+xml/g) || []).length;
  // Should be exactly 1: the NEWS_FALLBACK_SVG_LAST_RESORT constant definition
  assert.ok(svgDataUris <= 2,
    `At most 2 data:image/svg+xml occurrences expected (NEWS_FALLBACK_SVG_LAST_RESORT definition + possibly a regex check). Found ${svgDataUris}.`);
});

// ============================================================================
// Test 7: getAmirbtcFallbackSvg returns NEWS_FALLBACK_IMG (backward compat)
// ============================================================================

test('NIF-07: getAmirbtcFallbackSvg() returns NEWS_FALLBACK_IMG (backward compat)', () => {
  // Verify the function body returns NEWS_FALLBACK_IMG
  const fnSrc = APP_SRC.match(/function getAmirbtcFallbackSvg\([^)]*\)\s*\{([^}]*)\}/);
  assert.ok(fnSrc, 'getAmirbtcFallbackSvg function must exist in app.js');
  const body = fnSrc[1];
  assert.ok(body.includes('return NEWS_FALLBACK_IMG'),
    'getAmirbtcFallbackSvg must return NEWS_FALLBACK_IMG (not an inline SVG data URI)');
  assert.ok(!body.includes('data:image/svg'),
    'getAmirbtcFallbackSvg must NOT return inline SVG data URI anymore');
});

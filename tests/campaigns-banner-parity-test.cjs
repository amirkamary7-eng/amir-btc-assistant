/**
 * CAMPAIGNS — HERO BANNER PARITY REGRESSION TEST
 * =================================================
 * Locks the "three banners, one identical frame" contract:
 *
 *   1. All three hero banner assets (premium / channel / campaigns) have a
 *      ~2:1 width:height ratio (the .hero-banner-slider container is
 *      aspect-ratio: 2/1). The campaign banner was re-encoded from
 *      1280x588 (2.177:1) to an exact 2:1 file (1200x600) by extending
 *      its near-uniform dark background — full content preserved, no
 *      horizontal crop, no stretch.
 *   2. All three slides in index.html use the SAME img class
 *      (hero-slide-img hero-slide-img--cover) → identical frame size and
 *      display behavior (object-fit:fill on a 2:1 file = perfect fit).
 *   3. The legacy per-slide workaround (.hero-slide-img--ratio with
 *      object-fit:cover) is fully gone — it caused a live ~4.4%/side crop
 *      that clipped real banner content (headline edge, ETH coin, green
 *      arrow) and made the third banner look zoomed-in vs the other two.
 *   4. The JPG master stays untouched on disk (source of truth).
 *   5. dashboard.css hero classes are untouched (no global redesign).
 *
 * WebP dimensions are parsed straight from the RIFF/VP8 bitstream —
 * no image library needed. All tests are offline.
 *
 * Run: node --test tests/campaigns-banner-parity-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f));
const exists = (f) => fs.existsSync(path.join(ROOT, f));

// ── Minimal WebP dimension parser (RIFF container) ────────────────────────
function webpDimensions(file) {
  const buf = read(file);
  assert.equal(buf.toString('ascii', 0, 4), 'RIFF', `${file}: not a RIFF/WebP file`);
  assert.equal(buf.toString('ascii', 8, 12), 'WEBP', `${file}: missing WEBP signature`);
  const chunk = buf.toString('ascii', 12, 16);
  if (chunk === 'VP8X') {
    // Extended format: 24-bit canvas width/height minus one.
    return {
      width: buf.readUIntLE(24, 3) + 1,
      height: buf.readUIntLE(27, 3) + 1,
    };
  }
  if (chunk === 'VP8 ') {
    // Lossy: 14-bit values inside the frame tag (little-endian, masked).
    return {
      width: buf.readUInt16LE(26) & 0x3fff,
      height: buf.readUInt16LE(28) & 0x3fff,
    };
  }
  if (chunk === 'VP8L') {
    // Lossless: 14-bit values packed in the signature bits.
    const bits = buf.readUInt32LE(21);
    return { width: (bits & 0x3fff) + 1, height: ((bits >> 14) & 0x3fff) + 1 };
  }
  assert.fail(`${file}: unsupported WebP chunk ${chunk}`);
}

const BANNERS = [
  { file: 'assets/banner-premium.webp', slide: 0 },
  { file: 'assets/banner-channel.webp', slide: 1 },
  { file: 'assets/banner-campian.webp', slide: 2 },
];

const HTML = read('index.html').toString('utf8');
const DASH_CSS = read('dashboard.css').toString('utf8');
const CMP_CSS = read('campaigns.css').toString('utf8');

// Container contract (dashboard.css is the reference — untouched).
test('container contract: .hero-banner-slider keeps aspect-ratio 2/1 (dashboard.css untouched)', () => {
  const m = DASH_CSS.match(/\.hero-banner-slider\s*\{[^}]*aspect-ratio:\s*2\s*\/\s*1/);
  assert.ok(m, '.hero-banner-slider must keep aspect-ratio: 2/1');
});

// ── 1. All three assets are ~2:1 ───────────────────────────────────────────
for (const { file } of BANNERS) {
  test(`asset ratio: ${file} is within 2.5% of 2:1 (no live crop needed)`, () => {
    assert.ok(exists(file), `${file} must exist`);
    const { width, height } = webpDimensions(file);
    const ratio = width / height;
    // Healthy references: premium 2.034, channel 2.003, campaigns 2.000.
    // Anything outside [1.95, 2.05] would visibly crop or stretch in the 2:1 frame.
    assert.ok(
      ratio >= 1.95 && ratio <= 2.05,
      `${file} ratio ${ratio.toFixed(4)} outside [1.95, 2.05] — banner parity broken (was the asset re-encoded?)`,
    );
  });
}

test('campaign banner is the exact 2:1 parity file (1200x600)', () => {
  const { width, height } = webpDimensions('assets/banner-campian.webp');
  assert.equal(width, 1200, 'campaign banner width must be 1200 (same class as the other banners)');
  assert.equal(height, 600, 'campaign banner height must be 600 (exact 2:1)');
});

test('campaign banner content is not upscaled beyond the JPG master', () => {
  // The JPG master (1280x588) must still exist untouched, and the WebP must
  // never be wider than the master (no upscaling — only a 2:1 re-compose).
  assert.ok(exists('assets/banner-campian.jpg'), 'JPG master must remain on disk');
  const { width } = webpDimensions('assets/banner-campian.webp');
  assert.ok(width <= 1280, `webp width ${width} exceeds the 1280px master — upscaling forbidden`);
});

// ── 2. All three slides share the same class ──────────────────────────────
for (const { file, slide } of BANNERS) {
  test(`slide ${slide} (${file}): uses the shared hero-slide-img--cover class`, () => {
    const block = HTML.match(
      new RegExp(`<div class="hero-slide[^"]*" data-slide="${slide}"[\\s\\S]*?</div>`),
    )?.[0] || '';
    assert.ok(block, `slide ${slide} block must exist`);
    assert.match(
      block,
      /hero-slide-img hero-slide-img--cover/,
      `slide ${slide} must use the shared --cover class (identical frame behavior)`,
    );
    assert.doesNotMatch(block, /hero-slide-img--ratio/, `slide ${slide} must not use the legacy --ratio class`);
  });
}

// ── 3. Legacy workaround fully removed ─────────────────────────────────────
test('legacy --ratio rule removed everywhere', () => {
  assert.doesNotMatch(HTML, /hero-slide-img--ratio/, 'index.html must not reference --ratio');
  assert.doesNotMatch(CMP_CSS, /\.hero-slide-img--ratio\s*\{/, 'campaigns.css must not define the --ratio rule');
  assert.doesNotMatch(DASH_CSS, /\.hero-slide-img--ratio/, 'dashboard.css must not define --ratio (untouched anyway)');
});

test('campaigns.css documents the parity decision', () => {
  assert.match(
    CMP_CSS,
    /banner parity/i,
    'campaigns.css header must document the banner-parity fix (asset re-encoded to 2:1)',
  );
});

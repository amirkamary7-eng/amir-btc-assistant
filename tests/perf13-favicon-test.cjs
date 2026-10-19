/**
 * PERF-13 (Phase 40) — Inline SVG favicon regression tests
 * =========================================================
 *
 * Bug: index.html declared no icon (<link rel="icon">), so on every cold
 * load the browser auto-requested /favicon.ico. Cloudflare Pages answered
 * with the SPA fallback — the FULL index.html (~199KB, ~35KB gzip) served
 * with Content-Type text/html — producing a broken tab icon AND wasting
 * transfer on every cold load (Phase 37 measurement; Phase 39 audit PERF-13).
 *
 * Fix (audit-prescribed, scoped to index.html only): an inline data-URI SVG
 * favicon in <head>. Declaring a valid icon suppresses the implicit
 * /favicon.ico request entirely (audit acceptance: "cold load → NO
 * /favicon.ico request OR ≤5KB with 200"). No new static file, no
 * prepare-pages.mjs build change, no _headers/_redirects change — so the
 * SPA fallback that serves deep links for every OTHER unmatched route keeps
 * its exact pre-fix behavior.
 *
 * Fix tests (F) verify the icon declaration itself:
 *   F1. a <link rel="icon" type="image/svg+xml"> exists inside <head>
 *   F2. the href is a data: URI — no network URL, no relative file path
 *   F3. the percent-encoded payload decodes to a valid SVG document
 *   F4. the URI is safely encoded (no raw '#', lossless decode round-trip)
 *   F5. the icon tag respects the audit size budget (≤ 2KB)
 *   F6. exactly ONE icon link (a duplicate declaration re-opens requests)
 *
 * Scope tests (S) verify the architecture around the fix is untouched:
 *   S1. prepare-pages.mjs has NO favicon handling (inline-only fix)
 *   S2. no _redirects introduced anywhere (SPA fallback semantics preserved)
 *   S3. no favicon.ico / favicon.svg static file added (audit: index.html only)
 *   S4. the _headers CSP-Report-Only img-src still allows data: URIs
 *   S5. the _headers cache rules for all other routes are intact
 *       (index.html no-store / version.json no-store+ACAO / *.js+*.css+assets
 *       1-year immutable — exactly the pre-fix rule set)
 *   S6. the version-check script still runs FIRST in <head> (order invariant)
 *
 * Behavioral (B) + meta (M):
 *   B1. a strict icon-selection simulation picks the data-URI icon and the
 *       decoded SVG actually draws something (≥1 shape element)
 *   M1. pre-fix head (icon stripped) → no declared icon → engine WOULD
 *       request /favicon.ico → receives the full SPA HTML (the ~199KB waste)
 *
 * Run: node --test tests/perf13-favicon-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const PAGES_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-pages.mjs'), 'utf8');

// ── Extract the <head>…</head> section (single-page app: exactly one <head>) ──
const headMatch = /<head>([\s\S]*?)<\/head>/.exec(INDEX_SRC);
assert.ok(headMatch, 'index.html must contain a <head> section');
const HEAD = headMatch[1];

// All icon link declarations in the head (rel="icon" / rel="shortcut icon").
const ICON_LINK_RE = /<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/gi;
const iconLinks = HEAD.match(ICON_LINK_RE) || [];

// ── Icon-selection simulation (the algorithm a browser runs before deciding
//    whether to fall back to the implicit /favicon.ico request) ──
function selectIcon(headSource) {
  const links = headSource.match(/<link\s+[^>]*rel=["'](?:shortcut\s+)?icon["'][^>]*>/gi) || [];
  for (const tag of links) {
    // Delimiter-aware attribute extraction: the data-URI href legitimately
    // contains ' characters (SVG attrs use single quotes), so the value must
    // be read up to the SAME quote that opened it, not up to any quote.
    const rel = (/rel=(["'])(.*?)\1/).exec(tag);
    const href = (/href=(["'])(.*?)\1/).exec(tag);
    const type = (/type=(["'])(.*?)\1/).exec(tag);
    if (!rel || !href) continue;
    if (rel[2] !== 'icon' && rel[2] !== 'shortcut icon') continue;
    if (!type || type[2] !== 'image/svg+xml') continue;
    if (!href[2].startsWith('data:image/svg+xml,')) continue;
    return { rel: rel[2], type: type[2], href: href[2] };
  }
  return null;
}

function decodeIconHref(href) {
  const payload = href.slice('data:image/svg+xml,'.length);
  // Throws on malformed percent-encoding — exactly what we want to catch.
  return decodeURIComponent(payload);
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE FIX — the inline data-URI icon declaration
// ════════════════════════════════════════════════════════════════════════════

test('PERF-13 F1: <link rel="icon" type="image/svg+xml"> declared inside <head>', () => {
  assert.ok(iconLinks.length >= 1, 'an icon link must exist in <head>');
  const tag = iconLinks[0];
  assert.match(tag, /rel=["']icon["']/, 'rel must be exactly "icon"');
  assert.match(tag, /type=["']image\/svg\+xml["']/, 'type must be image/svg+xml');
});

test('PERF-13 F2: icon href is a data: URI (no network URL, no relative path)', () => {
  const sel = selectIcon(HEAD);
  assert.ok(sel, 'a valid data-URI icon must be selectable from the head');
  assert.ok(sel.href.startsWith('data:image/svg+xml,'),
    'the icon must be inlined — an external or relative href would create the /favicon.ico-style request PERF-13 removes');
  assert.ok(!/^https?:/i.test(sel.href), 'must not point at a network origin');
  assert.ok(!/^\//.test(sel.href), 'must not point at a site path (would hit the SPA fallback again)');
});

test('PERF-13 F3: the percent-encoded payload decodes to a valid SVG document', () => {
  const sel = selectIcon(HEAD);
  assert.ok(sel);
  const svg = decodeIconHref(sel.href);
  assert.ok(svg.startsWith('<svg'), 'decoded payload must start with <svg');
  assert.ok(svg.endsWith('</svg>'), 'decoded payload must end with </svg>');
  assert.ok(svg.includes("xmlns='http://www.w3.org/2000/svg'"), 'SVG namespace must be declared (required for standalone rendering)');
});

test('PERF-13 F4: data URI safely encoded — no raw "#", lossless round-trip', () => {
  const sel = selectIcon(HEAD);
  assert.ok(sel);
  // A raw '#' in a URI would truncate the payload at the fragment — broken icon.
  assert.ok(!sel.href.includes('#'), 'data URI must percent-encode # as %23');
  // Round-trip: decode then re-encode must reproduce the same payload.
  const payload = sel.href.slice('data:image/svg+xml,'.length);
  const decoded = decodeURIComponent(payload);
  assert.equal(encodeURIComponent(decoded), payload,
    'decode→encode round-trip must be lossless (canonical encodeURIComponent form)');
});

test('PERF-13 F5: icon tag respects the audit size budget (≤ 2KB)', () => {
  const sel = selectIcon(HEAD);
  assert.ok(sel);
  const tag = iconLinks[0];
  assert.ok(tag.length <= 2048,
    `icon link must stay within the ~1-2KB audit budget (got ${tag.length} bytes) — ` +
    'the whole point of PERF-13 is to REMOVE ~199KB from cold loads, not re-add weight');
});

test('PERF-13 F6: exactly ONE icon link (duplicates re-open icon requests)', () => {
  assert.equal(iconLinks.length, 1,
    'a single authoritative icon declaration — multiple links make engines re-resolve icons');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. SCOPE — build, headers and SPA fallback for other routes untouched
// ════════════════════════════════════════════════════════════════════════════

test('PERF-13 S1: prepare-pages.mjs has NO favicon handling (inline-only fix)', () => {
  assert.doesNotMatch(PAGES_SRC, /favicon/i,
    'the build script must not gain favicon logic — the audit scopes PERF-13 to index.html only');
  assert.doesNotMatch(PAGES_SRC, /_redirects/,
    'no redirect rules may be generated — the Pages SPA fallback behavior must stay as-is');
});

test('PERF-13 S2: no _redirects file introduced (SPA fallback semantics preserved)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, '_redirects')),
    'a root _redirects file would change route matching for every unmatched path — forbidden by the PERF-13 scope');
});

test('PERF-13 S3: no favicon.ico / favicon.svg static file added (audit: index.html only)', () => {
  assert.ok(!fs.existsSync(path.join(ROOT, 'favicon.ico')),
    'a favicon.ico static file would need build/_headers changes — outside the approved scope');
  assert.ok(!fs.existsSync(path.join(ROOT, 'favicon.svg')),
    'a favicon.svg static file would need build/_headers changes — outside the approved scope');
});

test('PERF-13 S4: _headers CSP-Report-Only img-src still allows data: URIs', () => {
  assert.ok(PAGES_SRC.includes("img-src 'self' data:"),
    'the CSP img-src must keep allowing data: URIs so the inline icon is CSP-compatible');
});

test('PERF-13 S5: _headers cache rules for all other routes intact', () => {
  // index.html — never cache (Telegram WebView freshness contract)
  assert.ok(PAGES_SRC.includes("'/index.html'"), '/index.html rule present');
  assert.ok(PAGES_SRC.includes("'  Cache-Control: no-store, no-cache, must-revalidate, proxy-revalidate'"),
    'index.html no-store rule unchanged');
  // version.json — never cache + CORS for the version check
  assert.ok(PAGES_SRC.includes("'/version.json'"), '/version.json rule present');
  assert.ok(PAGES_SRC.includes("'  Access-Control-Allow-Origin: *'"),
    'version.json CORS rule unchanged');
  // hashed JS/CSS/assets — 1 year immutable, exactly three rules
  const immutable = PAGES_SRC.match(/'  Cache-Control: public, max-age=31536000, immutable'/g) || [];
  assert.equal(immutable.length, 3,
    'exactly the three pre-fix immutable rules (js / css / assets) — no new rule, none removed');
  assert.ok(PAGES_SRC.includes("'/*.js'") && PAGES_SRC.includes("'/*.css'") && PAGES_SRC.includes("'/assets/*'"),
    'hashed js/css/assets rule paths unchanged');
});

test('PERF-13 S6: version-check script still runs FIRST in <head> (order invariant)', () => {
  const versionCheckIdx = INDEX_SRC.indexOf('Version Check (MUST be first');
  const iconIdx = INDEX_SRC.indexOf('<link rel="icon"');
  assert.ok(versionCheckIdx !== -1, 'version-check block must exist');
  assert.ok(iconIdx !== -1, 'icon link must exist');
  assert.ok(versionCheckIdx < iconIdx,
    'the version-check script must stay before the icon declaration — PERF-13 must not disturb the "version check first" invariant');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. BEHAVIORAL + META
// ════════════════════════════════════════════════════════════════════════════

test('PERF-13 B1: icon selection resolves to the data URI and the SVG draws content', () => {
  const sel = selectIcon(HEAD);
  assert.ok(sel, 'the simulated engine must resolve a declared icon (→ no implicit /favicon.ico request)');
  const svg = decodeIconHref(sel.href);
  const shapes = (svg.match(/<(rect|circle|path|polygon|ellipse)\b/gi) || []).length;
  assert.ok(shapes >= 1, `the icon SVG must contain drawable shapes (found ${shapes})`);
  // The icon must render at standard favicon sizes: a viewBox is required so
  // 16x16/32x32 renders scale instead of clipping.
  assert.match(svg, /viewBox=['"][^'"]+['"]/, 'SVG must declare a viewBox');
});

test('PERF-13 M1 (meta): pre-fix head (no icon link) → engine requests /favicon.ico → ~199KB SPA HTML', () => {
  // Strip every icon link from the current head to reconstruct the pre-fix DOM.
  const preFixHead = HEAD.replace(ICON_LINK_RE, '');
  const sel = selectIcon(preFixHead);
  assert.equal(sel, null,
    'with no declared icon the engine falls back to the implicit /favicon.ico request');
  // What that request used to receive: the Cloudflare Pages SPA fallback —
  // the FULL index.html document — as text/html. Broken icon + wasted bytes.
  assert.ok(INDEX_SRC.length > 100 * 1024,
    `the SPA fallback payload is the entire index.html (${(INDEX_SRC.length / 1024).toFixed(1)}KB) — the waste PERF-13 eliminates`);
});

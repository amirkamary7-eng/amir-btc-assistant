/**
 * PHASE 34 REGRESSION — Header-to-Content Gap Root-Cause Fix
 * File: tests/phase34-header-content-gap-test.cjs
 *
 * CONTEXT (evidence trail, see worklog phase-34):
 *   User reported an excessive blank band between the app header and page
 *   content (production screenshots circled on News + Market). Pixel audit of
 *   the production photos (576x1280, scale ~1.536 => ~375 CSS px viewport)
 *   against local reproduction at 320/360/390/430/768/1280 proved production
 *   geometry IDENTICAL to local: app-header box [0,56], blank band
 *   [56,68] = .page padding-top, then first-component internal padding
 *   (.ni-topbar 10px / .mkt-header 14px). No environment bug, no double
 *   header-height reservation, no spacer, no safe-area duplication
 *   (env(safe-area-inset-top)=0 inside the Telegram webview), no fadeSlide
 *   residue (settles at translateY(0)).
 *
 * ROOT CAUSE: double top-spacing — the sticky .app-header already terminates
 *   with 12px internal bottom padding + 1px border, and .page then stacked a
 *   FULL 12px page-level top padding on top of it. Combined with the first
 *   component's own padding this read as a ~38-56px visually-empty band
 *   under the header (worst on News/Market whose first rows are low-contrast).
 *
 * FIX (minimal, shared, all pages): base.css `.page` padding 12px 0 20px ->
 *   4px 0 20px. One line. The header's own 12px internal padding + border
 *   remain the standard design separation.
 *
 * THIS SUITE LOCKS:
 *   1. The fixed .page padding (4px top / 20px bottom) + fadeSlide unchanged
 *      + no negative-margin or transform hack smuggled in.
 *   2. The .app-header contract UNTOUCHED (56px, sticky top:0, z 100,
 *      12px 16px padding, 1px border-bottom) — height/offsets must not drift.
 *   3. Sticky sub-header family UNTOUCHED (top:56px): .mkt-header,
 *      .mkt-list-header, .ni-topbar, .analysis-tabs-row, .adp-header.
 *   4. Fullscreen overlay headers UNTOUCHED at top:0 (the fix must not leak
 *      into overlays): campaigns .cmp-header, referral header.
 *   5. body halo + body safe-area padding-top env(safe-area-inset-top)
 *      unchanged (halo/safe-area explicitly NOT part of this fix).
 *   6. Component paddings NOT flattened by the fix (.ni-topbar and
 *      .mkt-header keep their designed internal paddings — the fix removed
 *      only the duplicated page-level spacing).
 *
 * Run: node --test tests/phase34-header-content-gap-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const baseSrc = read('base.css');
const marketSrc = read('market.css');
const newsSrc = read('news.css');
const styleSrc = read('style.css');
const adpSrc = read('analysis-detail.css');
const campaignsSrc = read('campaigns.css');
const referralSrc = read('referral.css');

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractRule(src, selector) {
  const re = new RegExp(escapeRegExp(selector) + '\\s*\\{');
  const m = re.exec(src);
  assert.ok(m, `selector ${selector} must exist in CSS source`);
  let i = src.indexOf('{', m.index);
  let depth = 1; i++;
  while (depth > 0 && i < src.length) {
    if (src[i] === '{') depth++;
    else if (src[i] === '}') depth--;
    i++;
  }
  return src.slice(m.index, i);
}
function decl(rule, prop) {
  const clean = rule.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp('(?:^|[;\\s{])' + prop + '\\s*:\\s*([^;]+);').exec(clean);
  return m ? m[1].trim() : null;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE FIX — .page padding-top 12px -> 4px, nothing else on this rule
// ════════════════════════════════════════════════════════════════════════════

test('Phase 34 FIX: .page padding is 4px 0 20px (duplicated top spacing removed)', () => {
  const rule = extractRule(baseSrc, '.page');
  assert.equal(decl(rule, 'padding'), '4px 0 20px',
    '.page padding must be exactly 4px 0 20px — 4px breathing gap instead of the duplicated 12px');
  assert.equal(decl(rule, 'display'), 'none', '.page tab-hiding display:none unchanged');
  assert.equal(decl(rule, 'animation'), 'fadeSlide 0.3s ease', 'fadeSlide entry animation unchanged');
});

test('Phase 34 FIX: no negative-margin / transform hack compensating the gap', () => {
  const rule = extractRule(baseSrc, '.page');
  const clean = rule.replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/margin-top\s*:\s*-/.test(clean), 'no negative margin-top on .page');
  assert.ok(!/transform\s*:\s*translate[Yy]?\(/.test(clean), 'no translate hack on .page');
});

test('Phase 34 FIX: old 12px duplicated padding must not reappear anywhere', () => {
  assert.doesNotMatch(baseSrc, /\.page\s*\{\s*display:\s*none;\s*padding:\s*12px\s*0\s*20px;/,
    'the pre-fix duplicated spacing is forbidden from returning');
});

test('Phase 34 FIX: #dashboard-page ID override gets the same 4px top padding', () => {
  // dashboard.css overrides .page via ID specificity — the duplication existed
  // there too (12px base / 10px <=360px). Both collapsed to 4px like .page.
  const dashSrc = read('dashboard.css');
  const rule = extractRule(dashSrc, '#dashboard-page');
  assert.equal(decl(rule, 'padding'), '4px 16px 24px',
    'dashboard root keeps its side/bottom padding but drops the duplicated 12px top');
  assert.ok(/@media\s*\(max-width:\s*360px\)\s*\{[^}]*#dashboard-page\s*\{\s*padding:\s*4px\s*12px\s*20px;/.test(dashSrc.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\n\s*\n/g, '\n')) || /#dashboard-page\s*\{\s*padding:\s*4px\s*12px\s*20px;/.test(dashSrc),
    'the <=360px dashboard rule keeps 12px sides / 20px bottom with the same 4px top');
  assert.doesNotMatch(dashSrc, /#dashboard-page\s*\{\s*padding:\s*12px\s*16px\s*24px;/,
    'the old 12px dashboard top padding must not return');
});

// ════════════════════════════════════════════════════════════════════════════
// 2. HEADER CONTRACT UNTOUCHED — the fix must not alter the header itself
// ════════════════════════════════════════════════════════════════════════════

test('Phase 34 SCOPE: .app-header geometry untouched (56px / sticky top:0 / z 100 / 12px 16px)', () => {
  const rule = extractRule(baseSrc, '.app-header');
  assert.equal(decl(rule, 'height'), '56px', 'header height unchanged — Phase 34 does not shrink the header');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '0');
  assert.equal(decl(rule, 'z-index'), '100');
  assert.equal(decl(rule, 'padding'), '12px 16px',
    'the header keeps its own 12px internal bottom padding — the standard design separation');
  assert.equal(decl(rule, 'border-bottom'), '1px solid rgba(255,255,255,0.05)',
    'header bottom border unchanged');
});

test('Phase 34 SCOPE: header brand logo rule untouched (out-of-scope asset styling)', () => {
  const rule = extractRule(baseSrc, '.brand-logo');
  assert.equal(decl(rule, 'height'), '62px',
    'brand-logo height stays as-is in this phase (documented finding, not part of the approved fix)');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. STICKY SUB-HEADER FAMILY UNTOUCHED — offsets still anchor to the 56px header
// ════════════════════════════════════════════════════════════════════════════

test('Phase 34 SCOPE: sticky sub-headers keep top:56px (mkt-header / mkt-list-header / ni-topbar)', () => {
  assert.equal(decl(extractRule(marketSrc, '.mkt-header'), 'top'), '56px');
  // 2026-10-22 market header/scroll overlap fix: .mkt-list-header moved from the
  // flat 56px to the STACKED offset (it sits under the sticky .mkt-header, the
  // only such bar in the app) — still anchored to the 56px app-header. Contract
  // locked by tests/market-header-sticky-stack-test.cjs.
  assert.equal(decl(extractRule(marketSrc, '.mkt-list-header'), 'top'), 'calc(56px + var(--mkt-header-h, 64px))');
  assert.equal(decl(extractRule(newsSrc, '.ni-topbar'), 'top'), '56px');
});

test('Phase 34 SCOPE: sticky sub-headers keep top:56px (analysis-tabs-row / adp-header)', () => {
  assert.equal(decl(extractRule(styleSrc, '.analysis-tabs-row'), 'top'), '56px');
  assert.equal(decl(extractRule(adpSrc, '.adp-header'), 'top'), '56px');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. OVERLAY HEADERS UNTOUCHED — the fix must not leak into fullscreen overlays
// ════════════════════════════════════════════════════════════════════════════

test('Phase 34 SCOPE: fullscreen overlay headers stay at top:0 (no page-padding leak)', () => {
  assert.equal(decl(extractRule(campaignsSrc, '.cmp-header'), 'top'), '0');
  assert.match(referralSrc, /position:\s*sticky;\s*top:\s*0;\s*z-index:\s*10/,
    'referral overlay header must keep sticky top:0');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. HALO + SAFE-AREA UNTOUCHED — explicitly deferred parts of the band
// ════════════════════════════════════════════════════════════════════════════

test('Phase 34 SCOPE: body top halo radial-gradient unchanged', () => {
  assert.match(baseSrc,
    /background-image:\s*radial-gradient\(ellipse 80% 50% at 50% 0%,\s*rgba\(255,138,0,0\.03\) 0%,\s*transparent 60%\)/,
    'the halo is design, not the gap — unchanged by Phase 34');
});

test('Phase 34 SCOPE: body safe-area padding-top env() unchanged', () => {
  const rule = extractRule(baseSrc, 'body');
  assert.equal(decl(rule, 'padding-top'), 'env(safe-area-inset-top, 0px)',
    'notch-device safe-area handling is untouched');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. FIRST-COMPONENT PADDINGS UNTOUCHED — only the duplicated layer was removed
// ════════════════════════════════════════════════════════════════════════════

test('Phase 34 SCOPE: .ni-topbar internal padding unchanged (10px 16px 8px)', () => {
  assert.equal(decl(extractRule(newsSrc, '.ni-topbar'), 'padding'), '10px 16px 8px',
    'News topbar keeps its designed internal padding');
});

test('Phase 34 SCOPE: .mkt-header internal padding unchanged (14px 16px 10px)', () => {
  assert.equal(decl(extractRule(marketSrc, '.mkt-header'), 'padding'), '14px 16px 10px',
    'Market header keeps its designed internal padding');
});

/**
 * PHASE 31 — ISSUE 3 REGRESSION TEST: sticky sub-header offset contract
 * ====================================================================
 *
 * Phase 30 finding (CONFIRMED, runtime-measured on prod + Phase 31 local
 * headless re-verification) + Phase 31 GLOBAL page audit (Stage A-D):
 *
 *   DEFECT 1 — Market: .mkt-header { position:sticky; top:0; z-index:10 }
 *     pinned BEHIND the sticky app-header (top:0, z-index:100, height:56px,
 *     base.css:103). When Market was scrolled, the bar slid under the
 *     app-header (measured: top edge -40..-56px below the app-header's
 *     bottom edge), leaving a clipped sliver, and the Refresh button
 *     (#market-refresh-btn, a child of .mkt-header) became UNCLICKABLE
 *     (elementFromPoint at its center returned HEADER.app-header).
 *
 *   DEFECT 2 — Analysis Detail (found by the Phase 31 full-app audit, same
 *     defect class): .adp-header { position:sticky; top:0; z-index:10 }
 *     buried completely (-56px) behind the app-header when the analysis
 *     detail page scrolled, making the BACK button unclickable.
 *
 *   CORRECT precedent already in the codebase (anchor + family):
 *     .app-header           base.css            height:56px, sticky top:0, z:100
 *     .mkt-list-header      market.css:453      sticky top:56px, z:20
 *     .ni-topbar            news.css:392        sticky top:56px, z:15
 *     .analysis-tabs-row    style.css:2386      sticky top:56px, z:5
 *
 * Phase 31 fix under test (two one-line offsets, zero visual change at rest):
 *     market.css          .mkt-header  top: 0  -> top: 56px
 *     analysis-detail.css .adp-header  top: 0  -> top: 56px
 *
 * Verified at runtime (local static build, agent-browser 390x844 AND
 * 1280x800): app-header renders exactly 56px in BOTH viewports (no media
 * query alters it — checked all CSS); after the fix both bars pin flush
 * below the app-header (gap 0) with the Refresh / Back buttons clickable;
 * every main page's resting geometry is byte-identical (first content top
 * = 68 = 56 header + 12 page padding, all pages, both viewports).
 *
 * What this suite locks (static contracts — runtime measurement above is
 * the evidence, this file is the permanent guard):
 *   1. ANCHOR: .app-header keeps height:56px + sticky top:0 + z-index:100.
 *   2. FIX: .mkt-header and .adp-header are sticky with top:56px (not 0).
 *   3. FAMILY: every page-level sub-header that lives under the app-header
 *      uses the SAME 56px offset (.mkt-list-header, .ni-topbar,
 *      .analysis-tabs-row) — cross-page consistency contract.
 *   4. NO-CLIPPING GUARD: neither fixed bar may return to top:0 with a
 *      z-index below the app-header's 100 (the burial mechanism).
 *   5. OVERLAY PATTERN PROTECTED: full-page overlays' own headers KEEP
 *      top:0 (wallet / referral / campaigns / admin cover the app-header
 *      entirely — their headers must NOT be "fixed" to 56px later).
 *   6. GLOBAL INVARIANTS UNTOUCHED: .page padding stays 12px 0 20px, the
 *      body top radial-gradient halo stays, .app-header z-index stays 100
 *      (Phase 31 explicitly forbids global base.css changes).
 *   7. REFRESH BUTTON LIVES INSIDE .mkt-header (index.html) — its scrolled
 *      accessibility is exactly what the 56px offset restores.
 *
 * Run: node --test tests/phase31-issue3-header-sticky-offset-test.cjs
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
const walletSrc = read('wallet.css');
const campaignsSrc = read('campaigns.css');
const referralSrc = read('referral.css');
const indexHtml = read('index.html');

// ── Extract one CSS rule block (selector -> declarations), brace-matched ───
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
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function decl(rule, prop) {
  // Strip /* ... */ comments first (inline comments may contain prose like
  // "top:0 pinned this bar" that would otherwise match), then anchor the
  // property name so `top` cannot match inside `border-top` and `position`
  // cannot match inside `background-position`.
  const clean = rule.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp('(?:^|[;\\s{])' + prop + '\\s*:\\s*([^;]+);').exec(clean);
  return m ? m[1].trim() : null;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. ANCHOR — the app-header contract every sub-header offset depends on
// ════════════════════════════════════════════════════════════════════════════

test('Issue 3 ANCHOR: .app-header keeps height 56px + sticky top:0 + z-index 100', () => {
  const rule = extractRule(baseSrc, '.app-header');
  assert.equal(decl(rule, 'height'), '56px',
    'app-header height is the 56px anchor every sub-header offset builds on');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '0');
  assert.equal(decl(rule, 'z-index'), '100',
    'app-header must stay above every page-level sub-header (z 10..20)');
});

test('Issue 3 ANCHOR: no media query redefines .app-header height', () => {
  // Any rule mentioning app-header outside the base rule must not set height.
  const lines = baseSrc.split('\n');
  let inAppHeader = false; let depth = 0;
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (!inAppHeader && /\.app-header\s*\{/.test(line)) { inAppHeader = true; }
    if (inAppHeader) {
      depth += (line.match(/\{/g) || []).length - (line.match(/\}/g) || []).length;
      if (depth <= 0) { inAppHeader = false; continue; }
      // height declared inside the block:
      if (/height\s*:/.test(line) && !/56px/.test(line)) {
        assert.fail(`base.css line ${i + 1} sets a non-56px height on .app-header`);
      }
    }
  }
  // And no other CSS file defines .app-header height at all:
  for (const [name, src] of [['market.css', marketSrc], ['news.css', newsSrc], ['style.css', styleSrc]]) {
    const r = /\.app-header\s*\{[^}]*height\s*:\s*([^;]+);/.exec(src);
    assert.ok(!r, `${name} must not override .app-header height (found: ${r && r[1]})`);
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE FIX — the two defective bars now offset below the app-header
// ════════════════════════════════════════════════════════════════════════════

test('Issue 3 FIX: .mkt-header (Market) is sticky at top:56px — not top:0', () => {
  const rule = extractRule(marketSrc, '.mkt-header');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '56px',
    'Market header must pin flush below the 56px app-header (top:0 buried it behind the app-header and made Refresh unclickable when scrolled)');
});

test('Issue 3 FIX: .adp-header (Analysis Detail) is sticky at top:56px — not top:0', () => {
  const rule = extractRule(adpSrc, '.adp-header');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '56px',
    'Analysis-detail header must pin below the app-header (top:0 buried the back button when scrolled)');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. FAMILY — cross-page consistency of every under-app-header sticky bar
// ════════════════════════════════════════════════════════════════════════════

test('Issue 3 FAMILY: .mkt-list-header (Market column header) keeps top:56px', () => {
  const rule = extractRule(marketSrc, '.mkt-list-header');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '56px');
});

test('Issue 3 FAMILY: .ni-topbar (News) keeps top:56px', () => {
  const rule = extractRule(newsSrc, '.ni-topbar');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '56px');
});

test('Issue 3 FAMILY: .analysis-tabs-row (Analysis) keeps top:56px', () => {
  const rule = extractRule(styleSrc, '.analysis-tabs-row');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '56px');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. NO-CLIPPING GUARD — the burial mechanism cannot come back
// ════════════════════════════════════════════════════════════════════════════

test('Issue 3 GUARD: .mkt-header and .adp-header z-index stay below app-header (no z war)', () => {
  const mkt = extractRule(marketSrc, '.mkt-header');
  const adp = extractRule(adpSrc, '.adp-header');
  // They currently use 10; anything < 100 keeps the app-header on top.
  const zMkt = Number(decl(mkt, 'z-index'));
  const zAdp = Number(decl(adp, 'z-index'));
  assert.ok(zMkt > 0 && zMkt < 100, `.mkt-header z-index must stay 1..99 (got ${zMkt})`);
  assert.ok(zAdp > 0 && zAdp < 100, `.adp-header z-index must stay 1..99 (got ${zAdp})`);
});

test('Issue 3 GUARD: no page-level sticky bar under the app-header regresses to top:0', () => {
  // The four known page-level bars under the app-header:
  for (const [file, src, sel] of [
    ['market.css', marketSrc, '.mkt-header'],
    ['market.css', marketSrc, '.mkt-list-header'],
    ['analysis-detail.css', adpSrc, '.adp-header'],
    ['news.css', newsSrc, '.ni-topbar'],
    ['style.css', styleSrc, '.analysis-tabs-row'],
  ]) {
    const rule = extractRule(src, sel);
    const pos = decl(rule, 'position');
    const top = decl(rule, 'top');
    if (pos === 'sticky') {
      assert.notEqual(top, '0', `${file} ${sel} must not stick at top:0 (buried behind the z-100 app-header)`);
    }
  }
});

// ════════════════════════════════════════════════════════════════════════════
// 5. OVERLAY PATTERN PROTECTED — full-page overlays keep their own top:0
// ════════════════════════════════════════════════════════════════════════════

test('Issue 3 OVERLAYS: wallet / campaigns / referral own headers KEEP sticky top:0', () => {
  // These overlays cover the viewport (incl. the app-header) entirely —
  // their headers are the TOP-most bar in their own layer, so top:0 is
  // correct for them. Guards against over-applying the 56px pattern.
  const wallet = extractRule(walletSrc, '.wallet-page-header');
  assert.equal(decl(wallet, 'position'), 'sticky');
  assert.equal(decl(wallet, 'top'), '0', 'wallet overlay header must stay at top:0 (covers app-header)');

  const cmp = extractRule(campaignsSrc, '.cmp-header');
  assert.equal(decl(cmp, 'position'), 'sticky');
  assert.equal(decl(cmp, 'top'), '0', 'campaigns overlay header must stay at top:0');

  // referral.css header rule (sticky top:0 inside the full-page overlay)
  assert.match(referralSrc, /position:\s*sticky;\s*top:\s*0;\s*z-index:\s*10/,
    'referral overlay header must keep sticky top:0');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. GLOBAL INVARIANTS — Phase 31 forbids base.css / global styling changes
// ════════════════════════════════════════════════════════════════════════════

test('Issue 3 INVARIANT: .page padding stays 12px 0 20px (no global spacing change)', () => {
  assert.match(baseSrc, /\.page\s*\{\s*display:\s*none;\s*padding:\s*12px\s*0\s*20px;/,
    'the shared 12px top page padding is the designed header-content spacing on ALL pages — unchanged');
});

test('Issue 3 INVARIANT: body top halo radial-gradient unchanged', () => {
  assert.match(baseSrc,
    /background-image:\s*radial-gradient\(ellipse 80% 50% at 50% 0%,\s*rgba\(255,138,0,0\.03\) 0%,\s*transparent 60%\)/,
    'the premium top halo is part of the design — unchanged');
});

// ════════════════════════════════════════════════════════════════════════════
// 7. REFRESH BUTTON — the clickable-when-scrolled contract's markup side
// ════════════════════════════════════════════════════════════════════════════

test('Issue 7 REFRESH: #market-refresh-btn stays inside .mkt-header (markup)', () => {
  const mktHeaderStart = indexHtml.indexOf('<div class="mkt-header">');
  assert.ok(mktHeaderStart > -1, 'index.html must contain the .mkt-header block');
  const headerEnd = indexHtml.indexOf('</div>', indexHtml.indexOf('market-refresh-btn'));
  const btnIdx = indexHtml.indexOf('id="market-refresh-btn"');
  assert.ok(btnIdx > mktHeaderStart && btnIdx < headerEnd + 50,
    'the refresh button must remain a child of .mkt-header — pinning .mkt-header at top:56px is what keeps the button clickable while scrolled');
});

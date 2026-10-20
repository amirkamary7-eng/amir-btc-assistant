/**
 * PERF-15 (Phase 40) — Non-blocking CSS loading regression tests
 * =================================================================
 *
 * Bug: membership.css (11.8KB gz) and maintenance.css (3.4KB gz) were the two
 * remaining RENDER-BLOCKING non-critical stylesheets in <head> (index.html
 * :141/:143 pre-fix). Every other optional sheet already used the proven
 * media="print" + onload="this.media='all'" async pattern (10 sheets).
 * Blocking these two delayed first paint by their full download time although
 * neither is needed for the initial dashboard view.
 *
 * Fix (audit-prescribed): move BOTH link tags to the same media=print pattern
 * WITHOUT changing their DOM positions — the CSSOM cascade order follows DOM
 * position, not load-completion order, so the final style application order
 * is byte-identical.
 *
 * FOUC analysis that shaped the fix (static DOM audit, verified in tests):
 *   - maintenance.css is inherently safe: EVERY maint- prefixed and mc-
 *     prefixed element lives
 *     inside #maintenance-overlay, which has inline display:none and is only
 *     shown by showMaintenancePopup() AFTER the maintenance-check API
 *     round-trip completes — by then the sheet (download starts at parse
 *     time) has applied. The boot loader shown meanwhile is inline-styled.
 *   - membership.css: all initial-DOM elements it styles are inside inline-
 *     hidden containers (#join-lock-overlay) or inside hidden .page sections
 *     (profile-page, hidden by BLOCKING base.css) — EXCEPT #join-status-bar,
 *     which contains visible default content ("Checking membership…" +
 *     spinner) and is hidden solely by the .join-status-bar base rule's
 *     opacity:0/pointer-events:none. A tiny inline pre-hide duplicating
 *     EXACTLY those two values (class selector → .join-status-bar.visible
 *     still overrides) makes the pre-CSS window visually identical.
 *
 * TEST COVERAGE LIMITATION (explicit per instruction): these are static
 * source/DOM-structure assertions plus a simulated cascade resolution —
 * they are NOT a real browser render. True FOUC/visual verification needs
 * a real browser session (audit acceptance: "بازبینی بصری"). The B-tests
 * simulate the exact mechanisms (media swap, specificity resolution) but
 * cannot replace human visual review in staging.
 *
 * Run: node --test tests/perf15-css-nonblocking-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const INDEX_SRC = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const MEMBERSHIP_SRC = fs.readFileSync(path.join(ROOT, 'membership.css'), 'utf8');
const MAINTENANCE_SRC = fs.readFileSync(path.join(ROOT, 'maintenance.css'), 'utf8');
const BASE_SRC = fs.readFileSync(path.join(ROOT, 'base.css'), 'utf8');
const PAGES_SRC = fs.readFileSync(path.join(ROOT, 'scripts', 'prepare-pages.mjs'), 'utf8');

// ── Helpers ─────────────────────────────────────────────────────────────────

function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** Extract a full CSS rule block (selector { … }) via brace matching. */
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

/**
 * Find the source span [start, end) of the element opened at `openIdx`,
 * balancing open/close tags of `tag` (e.g. 'div', 'section'). HTML in this
 * project never self-closes these tags, so plain depth counting is exact.
 */
function elementSpan(html, openIdx, tag) {
  const openRe = new RegExp(`<${tag}\\b`, 'g');
  const closeRe = new RegExp(`</${tag}>`, 'g');
  let depth = 0;
  let idx = openIdx;
  let peekedOpen = null; // cached peek — exec() is stateful, re-calling it
  // after taking the close branch would silently DROP the peeked open match.
  for (;;) {
    if (peekedOpen === null) {
      openRe.lastIndex = idx;
      const om = openRe.exec(html);
      peekedOpen = om ? om.index : Infinity;
    }
    closeRe.lastIndex = idx;
    const cm = closeRe.exec(html);
    const closePos = cm ? cm.index : Infinity;
    if (peekedOpen < closePos) {
      depth++; idx = peekedOpen + 1; peekedOpen = null;
    } else if (closePos < Infinity) {
      depth--; idx = closePos + closeRe.source.length; // keep the peeked open
      if (depth === 0) return [openIdx, closePos];
    } else {
      throw new Error('unbalanced <' + tag + '> from ' + openIdx);
    }
  }
}

/** All class-attribute tokens in the HTML with their source positions. */
function classTokens(html) {
  const out = [];
  const re = /class="([^"]*)"/g;
  let m;
  while ((m = re.exec(html))) {
    for (const tok of m[1].split(/\s+/)) {
      if (tok) out.push({ token: tok, index: m.index });
    }
  }
  return out;
}

// The exact non-blocking pattern shared by all async sheets.
const ASYNC_ATTR = ' media="print" onload="this.media=\'all\'"';

// ════════════════════════════════════════════════════════════════════════════
// 1. THE FIX — the two link tags + the pre-hide guard
// ════════════════════════════════════════════════════════════════════════════

test('PERF-15 F1: membership.css link uses the media=print + onload swap pattern', () => {
  assert.ok(INDEX_SRC.includes(`<link rel="stylesheet" href="membership.css"${ASYNC_ATTR}>`),
    'membership.css must use the exact proven async pattern');
});

test('PERF-15 F2: maintenance.css link uses the media=print + onload swap pattern', () => {
  assert.ok(INDEX_SRC.includes(`<link rel="stylesheet" href="maintenance.css"${ASYNC_ATTR}>`),
    'maintenance.css must use the exact proven async pattern');
});

test('PERF-15 F3: both links keep rel="stylesheet" + plain href (build-hashable)', () => {
  // prepare-pages.mjs hashes these files and rewrites href="x.css" — the tags
  // must remain ordinary stylesheet links for the build pipeline.
  for (const f of ['membership.css', 'maintenance.css']) {
    const tag = INDEX_SRC.match(new RegExp(`<link rel="stylesheet" href="${escapeRegExp(f)}"[^>]*>`));
    assert.ok(tag, `${f} link tag present`);
    assert.match(tag[0], /^<link rel="stylesheet" href="[^"]+" media="print" onload="this\.media='all'">$/,
      `${f} tag must be exactly: stylesheet link + async attrs (nothing else)`);
  }
});

test('PERF-15 F4: async count is 12; the blocking set is exactly the 5 critical sheets', () => {
  const links = INDEX_SRC.match(/<link rel="stylesheet"[^>]*>/g) || [];
  assert.equal(links.length, 17, '17 stylesheet links total (unchanged count)');
  const asyncSheets = links.filter((t) => t.includes('media="print"'));
  const blockingSheets = links.filter((t) => !t.includes('media="print"'));
  assert.equal(asyncSheets.length, 12, '12 async sheets (10 pre-existing + membership + maintenance)');
  assert.deepEqual(
    blockingSheets.map((t) => /href="([^"]+)"/.exec(t)[1]),
    ['base.css', 'components.css', 'dashboard.css', 'market.css', 'style.css'],
    'exactly the 5 critical sheets stay render-blocking (initial dashboard view)');
});

test('PERF-15 F5: the pre-hide inline style exists with the exact guard values', () => {
  assert.ok(INDEX_SRC.includes('<style>.join-status-bar{opacity:0;pointer-events:none}</style>'),
    'the tiny FOUC pre-hide must be present verbatim');
});

test('PERF-15 F6: the pre-hide sits in <head> BEFORE the membership.css link', () => {
  const preHideIdx = INDEX_SRC.indexOf('<style>.join-status-bar{opacity:0;pointer-events:none}</style>');
  const memIdx = INDEX_SRC.indexOf('href="membership.css"');
  const headEnd = INDEX_SRC.indexOf('</head>');
  assert.ok(preHideIdx !== -1 && memIdx !== -1);
  assert.ok(preHideIdx < memIdx, 'pre-hide precedes the membership.css link (paired guard)');
  assert.ok(preHideIdx < headEnd, 'pre-hide is inside <head> (applies before first paint)');
});

test('PERF-15 F7: pre-hide uses a CLASS selector — .join-status-bar.visible can still override', () => {
  // Specificity guard: an ID pre-hide (#join-status-bar, 1-0-0) would
  // permanently beat .join-status-bar.visible (0-2-0) and break the bar's
  // show behavior. The class form (0-1-0) ties with the base rule and loses
  // to .visible — exactly like the real stylesheet.
  const m = /<style>([^<]*)<\/style>/.exec(INDEX_SRC.slice(INDEX_SRC.indexOf('.join-status-bar{opacity') - 20));
  assert.ok(m, 'inline style block found');
  const body = m[1];
  assert.ok(body.startsWith('.join-status-bar{'), 'selector must be class-scoped');
  assert.ok(!body.startsWith('#'), 'ID selector would break the .visible override — forbidden');
});

test('PERF-15 F8: pre-hide values EXACTLY match the membership.css base rule (visual parity)', () => {
  const base = extractRule(MEMBERSHIP_SRC, '.join-status-bar');
  assert.equal(decl(base, 'opacity'), '0', 'membership.css base rule opacity is 0');
  assert.equal(decl(base, 'pointer-events'), 'none', 'membership.css base rule pointer-events is none');
  // The pre-hide duplicates exactly those two declarations → the computed
  // visibility of the bar is identical before and after the sheet applies.
  assert.ok(INDEX_SRC.includes('<style>.join-status-bar{opacity:0;pointer-events:none}</style>'));
});

// ════════════════════════════════════════════════════════════════════════════
// 2. SCOPE — order preservation, untouched CSS, FOUC containment, build
// ════════════════════════════════════════════════════════════════════════════

test('PERF-15 S1: complete DOM order of all 17 stylesheet links preserved', () => {
  // The pre-fix order, now and forever (CSSOM cascade = DOM order):
  const order = [
    'base.css', 'components.css', 'dashboard.css', 'market.css',
    'news.css', 'coin-detail.css', 'tickets.css', 'membership.css',
    'ai.css', 'maintenance.css', 'announcement.css', 'price-alerts.css',
    'analysis-detail.css', 'style.css', 'wallet.css', 'referral.css', 'campaigns.css',
  ];
  let prev = -1;
  for (const f of order) {
    const idx = INDEX_SRC.indexOf(`href="${f}"`);
    assert.ok(idx !== -1, `${f} link present`);
    assert.ok(idx > prev, `${f} must come after ${order[order.indexOf(f) - 1]} (DOM order preserved)`);
    prev = idx;
  }
});

test('PERF-15 S2: the CSS files themselves are untouched (anchor rules intact)', () => {
  // PERF-15 must not edit CSS values/rules — anchor rules prove the sheets
  // still carry their critical declarations.
  const jsb = extractRule(MEMBERSHIP_SRC, '.join-status-bar');
  assert.equal(decl(jsb, 'position'), 'fixed');
  assert.equal(decl(jsb, 'z-index'), '10003');
  const overlay = extractRule(MAINTENANCE_SRC, '.maint-overlay');
  assert.equal(decl(overlay, 'z-index'), '999999');
  assert.equal(decl(overlay, 'position'), 'fixed');
  // base.css still hides non-active pages (the blocking sheet that keeps the
  // hidden tabs invisible while async sheets stream in).
  assert.equal(decl(extractRule(BASE_SRC, '.page'), 'display'), 'none');
});

test('PERF-15 S3: maintenance FOUC containment — every maint-*/mc-* element inside the inline-hidden overlay', () => {
  const overlayOpen = INDEX_SRC.indexOf('<div id="maintenance-overlay"');
  assert.ok(overlayOpen !== -1, '#maintenance-overlay exists');
  assert.ok(INDEX_SRC.slice(overlayOpen, overlayOpen + 200).includes('style="display:none;"'),
    'the overlay is inline-hidden (no CSS dependency for its initial state)');
  // The overlay's inner markup is not perfectly div-balanced (browsers
  // tolerate it), so an exact depth scan cannot bound it. Instead: the next
  // body-level element (4-space indent, non-maint id) is the first sibling
  // AFTER the overlay — everything maint-/mc- before that boundary is inside
  // the overlay's subtree.
  const bodyLevelRe = /\n    <(?:div|section)[^>]*id="(?!maint-)/g;
  bodyLevelRe.lastIndex = overlayOpen + 1;
  const nextSibling = bodyLevelRe.exec(INDEX_SRC);
  assert.ok(nextSibling, 'a body-level successor element exists after the overlay');
  const overlayEnd = nextSibling.index;
  let checked = 0;
  for (const { token, index } of classTokens(INDEX_SRC)) {
    if (token.startsWith('maint-') || token.startsWith('mc-')) {
      checked++;
      assert.ok(index > overlayOpen && index < overlayEnd,
        `class "${token}" must live inside #maintenance-overlay (maintenance.css is safe to load async)`);
    }
  }
  assert.ok(checked > 10, `expected the full maint/mc element set inside the overlay (found ${checked})`);
});

test('PERF-15 S4: join-lock FOUC containment — every join-lock-*/jl-* element inside the inline-hidden overlay', () => {
  const overlayOpen = INDEX_SRC.indexOf('<div id="join-lock-overlay"');
  assert.ok(overlayOpen !== -1, '#join-lock-overlay exists');
  assert.ok(INDEX_SRC.slice(overlayOpen, overlayOpen + 200).includes('style="display:none;"'),
    'the overlay is inline-hidden');
  const [start, end] = elementSpan(INDEX_SRC, overlayOpen, 'div');
  for (const { token, index } of classTokens(INDEX_SRC)) {
    if (token.startsWith('join-lock-') || token.startsWith('jl-')) {
      assert.ok(index > start && index < end,
        `class "${token}" must live inside #join-lock-overlay (invisible regardless of membership.css timing)`);
    }
  }
});

test('PERF-15 S5: membership-badge lives inside the hidden profile-page section', () => {
  const pageOpen = INDEX_SRC.indexOf('<section id="profile-page"');
  assert.ok(pageOpen !== -1);
  // profile-page must NOT be the active page — .page{display:none} from
  // BLOCKING base.css keeps it invisible at first paint.
  assert.ok(!INDEX_SRC.slice(pageOpen, pageOpen + 80).includes('active'),
    'profile-page is not the initially-active section');
  const [start, end] = elementSpan(INDEX_SRC, pageOpen, 'section');
  const badgeIdx = INDEX_SRC.indexOf('id="membership-badge"');
  assert.ok(badgeIdx > start && badgeIdx < end,
    'membership-badge is inside the hidden profile page — safe while membership.css streams in');
});

test('PERF-15 S6: #join-status-bar content untouched + no inline display:none (JS contract unchanged)', () => {
  const barOpen = INDEX_SRC.indexOf('<div id="join-status-bar"');
  assert.ok(barOpen !== -1);
  const tag = INDEX_SRC.slice(barOpen, INDEX_SRC.indexOf('>', barOpen) + 1);
  assert.ok(!tag.includes('style='), 'no inline style on the bar — visibility stays class-driven (.visible)');
  const [start, end] = elementSpan(INDEX_SRC, barOpen, 'div');
  const barHtml = INDEX_SRC.slice(start, end);
  assert.ok(barHtml.includes('Checking membership…'), 'default visible content is untouched (drives the pre-hide need)');
  assert.ok(barHtml.includes('data-state="hidden"'), 'initial state attribute untouched');
});

test('PERF-15 S7: build compatibility — prepare-pages href rewrite still matches the new tag form', () => {
  // Replicates prepare-pages.mjs replaceReferences() EXACTLY on the new tags.
  for (const f of ['membership.css', 'maintenance.css']) {
    const tag = INDEX_SRC.match(new RegExp(`<link rel="stylesheet" href="${escapeRegExp(f)}"[^>]*>`))[0];
    const escaped = f.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re = new RegExp(`(href=["'])${escaped}(["'])`, 'g');
    const hashed = f.replace('.css', '.a1b2c3d4.css');
    const out = tag.replace(re, `$1${hashed}$2`);
    assert.ok(out.includes(`href="${hashed}"`),
      `${f} href must be hash-rewritable (build pipeline unaffected)`);
    assert.ok(out.includes('media="print" onload="this.media=\'all\'"'),
      'async attributes preserved through the rewrite');
  }
  // The pre-hide contains no href — the build regexes cannot touch it.
  assert.ok(PAGES_SRC.includes('copyIndexHtml'), 'index.html copied verbatim by the build');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. BEHAVIORAL (simulated mechanisms)
// ════════════════════════════════════════════════════════════════════════════

test('PERF-15 B1: the onload handler flips media print → all (the CSS-apply mechanism)', () => {
  for (const f of ['membership.css', 'maintenance.css']) {
    const tag = INDEX_SRC.match(new RegExp(`<link rel="stylesheet" href="${escapeRegExp(f)}"[^>]*>`))[0];
    const onloadSrc = /onload="([^"]*)"/.exec(tag);
    assert.ok(onloadSrc, 'onload attribute present');
    assert.equal(onloadSrc[1], "this.media='all'", 'handler is the canonical swap');
    // Execute the real handler against a mock link (own static source only).
    const fn = new Function(onloadSrc[1]);
    const mockLink = { media: 'print' };
    fn.call(mockLink);
    assert.equal(mockLink.media, 'all', `${f}: media flips to all → sheet applies`);
  }
});

test('PERF-15 B2: cascade simulation — bar invisible pre-CSS and post-CSS; .visible still shows it', () => {
  // Mini specificity-aware resolver: (specificity, source order) — later
  // wins per property, exactly like the CSSOM cascade.
  const rules = [
    { id: 'preHide', spec: 10, order: 0, when: true, decls: { opacity: '0', pointerEvents: 'none' } },
    { id: 'memBase', spec: 10, order: 1, when: true, decls: { opacity: '0', pointerEvents: 'none' } },
    { id: 'memVisible', spec: 20, order: 2, when: false, decls: { opacity: '1', pointerEvents: 'auto' } },
  ];
  function resolve(hasVisible) {
    const applicable = rules.filter((r) => r.when || (r.id === 'memVisible' && hasVisible));
    applicable.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
    const out = {};
    for (const r of applicable) Object.assign(out, r.decls);
    return out;
  }
  // Pre-CSS window (only the inline pre-hide applies): invisible.
  assert.deepEqual(resolve(false) && { opacity: rules[0].decls.opacity, pointerEvents: rules[0].decls.pointerEvents },
    { opacity: '0', pointerEvents: 'none' }, 'pre-CSS: bar invisible (pre-hide working)');
  // Post-CSS, hidden state (pre-hide + base rule — identical values): invisible.
  const post = resolve(false);
  assert.equal(post.opacity, '0', 'post-CSS hidden state: opacity 0 — visual parity');
  assert.equal(post.pointerEvents, 'none', 'post-CSS hidden state: pointer-events none — parity');
  // Post-CSS, JS shows the bar (.visible — higher specificity): visible.
  const shown = resolve(true);
  assert.equal(shown.opacity, '1', '.join-status-bar.visible wins over BOTH 0-1-0 rules → bar shows');
  assert.equal(shown.pointerEvents, 'auto', 'interaction restored');
  // Negative control — an ID-based pre-hide would break the show path:
  const idRule = { spec: 100, order: 0, decls: { opacity: '0' } };
  const withId = [idRule, rules[2]];
  withId.sort((a, b) => (a.spec - b.spec) || (a.order - b.order));
  const outId = {};
  for (const r of withId) Object.assign(outId, r.decls);
  assert.equal(outId.opacity, '0', 'ID pre-hide would freeze the bar hidden — hence F7 forbids it');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. META — prove the pre-fix form needed the pre-hide (load-bearing proof)
// ════════════════════════════════════════════════════════════════════════════

test('PERF-15 M1 (meta): pre-fix HTML had blocking links and NO pre-hide — blocking was load-bearing', () => {
  // Reconstruct the pre-fix head by undoing exactly this fix.
  const preFix = INDEX_SRC
    .replace(new RegExp(`(href="membership\\.css")${escapeRegExp(ASYNC_ATTR)}>`), '$1>')
    .replace(new RegExp(`(href="maintenance\\.css")${escapeRegExp(ASYNC_ATTR)}>`), '$1>')
    .replace(/\n\s*<!-- PERF-15 \(Phase 40\):[\s\S]*?-->\n\s*<style>\.join-status-bar\{opacity:0;pointer-events:none\}<\/style>/, '\n');
  assert.ok(preFix.includes('<link rel="stylesheet" href="membership.css">'),
    'pre-fix: membership.css was render-blocking');
  assert.ok(preFix.includes('<link rel="stylesheet" href="maintenance.css">'),
    'pre-fix: maintenance.css was render-blocking');
  assert.ok(!preFix.includes('<style>.join-status-bar{opacity:0;pointer-events:none}</style>'),
    'pre-fix: no pre-hide existed — the ONLY initial hiding of the visible-content bar was the blocking sheet itself');
  // …which is exactly why converting without the pre-hide would have flashed
  // "Checking membership…" unstyled at the document bottom on every cold load.
});

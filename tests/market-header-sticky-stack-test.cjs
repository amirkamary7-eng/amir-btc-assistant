/**
 * MARKET HEADER/SCROLL OVERLAP — STACKED-STICKY REGRESSION TEST
 * ====================================================================
 *
 * Defect (2026-10-22, user-reported, runtime-confirmed on a local static
 * build at 390x844 with 80 seeded coins):
 *
 *   market.css pinned BOTH sticky bars of the Market page at top:56px:
 *     .mkt-header      (page title bar: icon + "بازار" + subtitle + Refresh)  z:10
 *     .mkt-list-header (coin-list column header: # | ارز | قیمت | 24H | ★)   z:20
 *
 *   Phase 31 Issue 3 (commit 7c2561b0) had moved the title bar from top:0
 *   (buried behind the z:100 app-header) to top:56px — the exact offset the
 *   column header already occupied. When the coin list scrolled, both bars
 *   stuck in the SAME band: the column header (z:20) painted OVER the title
 *   bar (z:10), and the title bar's uncovered lower half hung over the
 *   scrolling coin rows. Measured overlap: 33px (title bar stuck 56–135.3,
 *   column header stuck 56–89, first coin row top 93.8).
 *
 * Fix under test (smallest maintainable change — stacked sticky headers):
 *   market.css  .mkt-list-header  top: 56px  ->  top: calc(56px + var(--mkt-header-h, 64px))
 *   app.js      syncMarketListHeaderOffset() keeps --mkt-header-h equal to the
 *               LIVE .mkt-header height (ResizeObserver + resize listener) —
 *               the height is dynamic: ~64px healthy, ~79px when the MK-08
 *               .mkt-data-status line is visible (stale/offline/fallback).
 *
 * Intended stacked order when the Market page is scrolled:
 *   app-header (0–56)  >  title bar (56–56+H1)  >  column header (56+H1–…)  >  rows
 *
 * What this suite locks (static contracts; runtime evidence above):
 *   1. STACKED OFFSET: the column header's sticky top is exactly
 *      calc(56px + var(--mkt-header-h, 64px)) — anchored to the 56px
 *      app-header AND stacked below the title bar via the measured var.
 *   2. TITLE BAR UNTOUCHED: .mkt-header keeps sticky top:56px z:10 (the
 *      Phase 31 contract — Refresh stays clickable when scrolled).
 *   3. Z ORDER: app-header 100 > column header 20 > title bar 10 > rows
 *      (auto) — no z-index war, nothing exceeds the app-header.
 *   4. SYNC WIRING: app.js defines syncMarketListHeaderOffset, sets
 *      --mkt-header-h on #mkt-list-header, observes .mkt-header with a
 *      ResizeObserver, and NEVER publishes a hidden/zero measurement.
 *   5. DOM CONTRACT: #mkt-list-header stays INSIDE #coin-list (same scroll
 *      container + shared grid padding as the rows — column alignment).
 *   6. SINGLE SOURCE OF TRUTH: only market.css defines the sticky top for
 *      .mkt-list-header (no duplicated overrides in any other CSS file).
 *
 * Run: node --test tests/market-header-sticky-stack-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');
const marketSrc = read('market.css');
const baseSrc = read('base.css');
const appSrc = read('app.js');
const indexHtml = read('index.html');

const CSS_FILES = [
  'base.css', 'components.css', 'dashboard.css', 'market.css', 'news.css',
  'style.css', 'wallet.css', 'referral.css', 'campaigns.css', 'membership.css',
  'announcement.css', 'ai.css', 'analysis-detail.css', 'coin-detail.css',
  'price-alerts.css', 'tickets.css', 'maintenance.css', 'components.css'
].filter((v, i, a) => a.indexOf(v) === i); // dedupe

// ── helpers (same extraction style as the phase31 suite) ──
function escapeRegExp(s) {
  return s.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}
function extractRule(src, selector) {
  const re = new RegExp(escapeRegExp(selector) + '\\s*\\{');
  const m = re.exec(src);
  if (!m) return null;
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
  if (!rule) return undefined;
  // Strip /* ... */ comments first (inline comments may contain prose like
  // "top:0 pinned this bar" that would otherwise match), then anchor the
  // property name so `top` cannot match inside `border-top`.
  const clean = rule.replace(/\/\*[\s\S]*?\*\//g, '');
  const m = new RegExp('(?:^|[;\\s{])' + escapeRegExp(prop) + '\\s*:\\s*([^;]+);').exec(clean);
  return m ? m[1].trim() : undefined;
}

// ════════════════════════════════════════════════════════════════════════════
// 1. THE STACKED OFFSET — the core fix
// ════════════════════════════════════════════════════════════════════════════

test('STACK: .mkt-list-header sticks at calc(56px + var(--mkt-header-h, 64px)) — one title bar below the app-header', () => {
  const rule = extractRule(marketSrc, '.mkt-list-header');
  assert.ok(rule, '.mkt-list-header rule must exist in market.css');
  assert.equal(decl(rule, 'position'), 'sticky');
  const top = decl(rule, 'top');
  assert.equal(top, 'calc(56px + var(--mkt-header-h, 64px))',
    'the column header must stack BELOW the sticky title bar, not share its 56px band ' +
    '(both bars at top:56px made the z:20 column header paint over the z:10 title bar — 33px measured overlap)');
});

test('STACK: the calc() keeps the 56px app-header anchor and a sane fallback', () => {
  const top = decl(extractRule(marketSrc, '.mkt-list-header'), 'top');
  assert.match(top, /^calc\(56px \+/,
    'the stacked offset must remain anchored to the locked 56px app-header height (base.css, phase31 suite)');
  const fb = /var\(--mkt-header-h,\s*(\d+)px\)/.exec(top);
  assert.ok(fb, 'the var must carry a static px fallback (no-JS / pre-sync paint)');
  const fbPx = Number(fb[1]);
  assert.ok(fbPx >= 56 && fbPx <= 96,
    `fallback must approximate a real title-bar height (~64px healthy, ~79px with the MK-08 status line) — got ${fbPx}px`);
});

// ════════════════════════════════════════════════════════════════════════════
// 2. THE TITLE BAR CONTRACT IS UNCHANGED (Phase 31 Issue 3 still holds)
// ════════════════════════════════════════════════════════════════════════════

test('TITLE BAR: .mkt-header keeps sticky top:56px z:10 (Phase 31 — Refresh clickable when scrolled)', () => {
  const rule = extractRule(marketSrc, '.mkt-header');
  assert.equal(decl(rule, 'position'), 'sticky');
  assert.equal(decl(rule, 'top'), '56px',
    'the title bar still pins flush below the 56px app-header');
  assert.equal(decl(rule, 'z-index'), '10');
});

// ════════════════════════════════════════════════════════════════════════════
// 3. Z ORDER — app-header > column header > title bar > rows
// ════════════════════════════════════════════════════════════════════════════

test('Z ORDER: app-header(100) > .mkt-list-header(20) > .mkt-header(10) — no z war', () => {
  const zApp = Number(decl(extractRule(baseSrc, '.app-header'), 'z-index'));
  const zList = Number(decl(extractRule(marketSrc, '.mkt-list-header'), 'z-index'));
  const zTitle = Number(decl(extractRule(marketSrc, '.mkt-header'), 'z-index'));
  assert.equal(zApp, 100);
  assert.equal(zList, 20, 'column header stays above the coin rows');
  assert.equal(zTitle, 10, 'title bar stays above the coin rows, below the column header');
  assert.ok(zApp > zList && zList > zTitle, 'strict stacking order app-header > column header > title bar');
  // Coin rows must NOT create a stacking context above the bars:
  const rowRule = extractRule(marketSrc, '.mkt-coin-row');
  assert.equal(decl(rowRule, 'z-index'), undefined, '.mkt-coin-row must stay in the base layer (no z-index)');
});

// ════════════════════════════════════════════════════════════════════════════
// 4. THE JS SYNC — keeps --mkt-header-h equal to the live title-bar height
// ════════════════════════════════════════════════════════════════════════════

test('SYNC: app.js defines syncMarketListHeaderOffset and publishes --mkt-header-h on #mkt-list-header', () => {
  assert.match(appSrc, /function\s+syncMarketListHeaderOffset\s*\(/,
    'the sync function must exist');
  assert.match(appSrc, /getElementById\(['"]mkt-list-header['"]\)/,
    'it must target the column header element');
  assert.match(appSrc, /setProperty\(['"]--mkt-header-h['"]/,
    'it must publish the --mkt-header-h custom property');
});

test('SYNC: a ResizeObserver watches .mkt-header (dynamic height: MK-08 status line, font load, tab show)', () => {
  assert.match(appSrc, /new\s+ResizeObserver\(syncMarketListHeaderOffset\)/,
    'the observer callback must be the sync function');
  assert.match(appSrc, /_mktHeaderStackRO\.observe\(mktHeader\)/,
    'it must observe the .mkt-header element');
});

test('SYNC GUARD: hidden/zero measurements are never published (offset cannot collapse onto the title bar)', () => {
  const fn = /function\s+syncMarketListHeaderOffset\s*\(\)\s*\{[\s\S]*?\n\}/.exec(appSrc);
  assert.ok(fn, 'sync function body found');
  assert.match(fn[0], /if\s*\(h\s*>\s*0\)/,
    'the height guard must reject display:none (0px) measurements');
  assert.match(fn[0], /getBoundingClientRect\(\)\.height/,
    'sub-pixel height source (getBoundingClientRect, not offsetHeight)');
});

// ════════════════════════════════════════════════════════════════════════════
// 5. DOM CONTRACT — the column header shares the list's scroll container
// ════════════════════════════════════════════════════════════════════════════

test('DOM: #mkt-list-header stays inside #coin-list, before #coin-list-rows (column alignment context)', () => {
  const listStart = indexHtml.indexOf('<div class="mkt-coin-list" id="coin-list"');
  const headerIdx = indexHtml.indexOf('class="mkt-list-header" id="mkt-list-header"');
  const rowsIdx = indexHtml.indexOf('<div class="mkt-coin-list-rows" id="coin-list-rows">');
  assert.ok(listStart > -1 && headerIdx > -1 && rowsIdx > -1, 'all three elements exist');
  assert.ok(listStart < headerIdx && headerIdx < rowsIdx,
    'the sticky column header must remain INSIDE the coin list, above the rows container');
});

// ════════════════════════════════════════════════════════════════════════════
// 6. SINGLE SOURCE OF TRUTH — no duplicated sticky-top overrides anywhere
// ════════════════════════════════════════════════════════════════════════════

test('NO-DUP: only market.css defines .mkt-list-header position/top (no override layers)', () => {
  for (const f of CSS_FILES) {
    let src;
    try { src = read(f); } catch { continue; }
    if (f === 'market.css') continue;
    const rule = extractRule(src, '.mkt-list-header');
    if (rule) {
      assert.ok(!/position\s*:|top\s*:/.test(rule),
        `${f} must not override .mkt-list-header positioning (found: ${rule.slice(0, 80)})`);
    }
  }
});

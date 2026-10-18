/**
 * PHASE 31 — ISSUE 1 REGRESSION TEST: Market subtitle wording (i18n)
 * =================================================================
 *
 * Phase 30 finding (CONFIRMED, Low):
 *   The Market page subtitle is rendered from the i18n key
 *   `market_subtitle` (index.html:375, p.mkt-subtitle[data-i18n]).
 *   The old copy was crypto-specific while the Market page also lists
 *   Forex groups (Metals / Indices / Commodities — app.js forex groups):
 *     fa: «داده‌های لحظه‌ای بازار ارزهای دیجیتال»  (i18n.js:87)
 *     en: 'Live Cryptocurrency Market Data'          (i18n.js:1620)
 *
 * Phase 31 fix under test (copy-only, exactly two dictionary values):
 *     fa: «داده‌های لحظه‌ای بازارهای جهانی»
 *     en: 'Live Global Market Data'
 *
 * What this suite locks:
 *   1. Both locales carry the approved generalized copy (exact match).
 *   2. Neither locale's final value contains crypto-only wording
 *      (ارزهای دیجیتال / کریپتو / Cryptocurrency / crypto / Crypto).
 *   3. The REAL t() — loaded from i18n.js, not a stub — returns the
 *      translated text in both language modes (never the raw key).
 *   4. The subtitle is actually DISPLAYED from the dictionary:
 *      index.html binds data-i18n="market_subtitle" to the subtitle
 *      element, and app.js applyLanguage() writes el.innerText = t(key)
 *      for [data-i18n] elements (the display path verified in Phase 30).
 *   5. No collateral copy drift: the Market TITLE key `market` and the
 *      Market tab labels stay unchanged (generic wording preserved).
 *
 * Run: node --test tests/phase31-issue1-market-subtitle-i18n-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18N_PATH = path.join(ROOT, 'i18n.js');

// ── Load the REAL i18n.js (global-scope vanilla JS, no exports) ─────────────
// Same loader pattern as p0-i18n-missing-keys-regression-test.cjs.
const I18N_SRC = fs.readFileSync(I18N_PATH, 'utf8');
const loadI18nContext = () => new Function(
  I18N_SRC + '\n;return { i18n, t, setLang: (l) => { currentLang = l; }, getLang: () => currentLang };'
)();
const ctx = loadI18nContext();

const INDEX_HTML = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

const APPROVED_FA = 'داده‌های لحظه‌ای بازارهای جهانی';
const APPROVED_EN = 'Live Global Market Data';

// Crypto-only wording that must NOT appear in the generalized subtitle.
const FORBIDDEN_PATTERNS = [
  /ارزهای\s*دیجیتال/,
  /کریپتو/,
  /رمزارز/,
  /cryptocurrency/i,
  /\bcrypto\b/i,
];

// ── 1. Approved generalized copy in both dictionaries ───────────────────────

test('Issue 1: fa.market_subtitle is the approved generalized copy', () => {
  assert.ok(ctx.i18n.fa, 'fa dictionary must exist');
  assert.equal(ctx.i18n.fa.market_subtitle, APPROVED_FA,
    'fa.market_subtitle must be the approved generalized Persian copy');
});

test('Issue 1: en.market_subtitle is the approved generalized copy', () => {
  assert.ok(ctx.i18n.en, 'en dictionary must exist');
  assert.equal(ctx.i18n.en.market_subtitle, APPROVED_EN,
    'en.market_subtitle must be the approved generalized English copy');
});

// ── 2. No crypto-specific wording survives in either locale ────────────────

test('Issue 1: market_subtitle contains no crypto-only wording (fa + en)', () => {
  for (const [locale, value] of Object.entries({
    fa: ctx.i18n.fa.market_subtitle,
    en: ctx.i18n.en.market_subtitle,
  })) {
    for (const re of FORBIDDEN_PATTERNS) {
      assert.ok(!re.test(value),
        `${locale}.market_subtitle (${JSON.stringify(value)}) must not match crypto-only pattern ${re}`);
    }
  }
});

// ── 3. Real t() resolves the key in both language modes ─────────────────────

test('Issue 1: real t() returns translated subtitle in fa and en modes', () => {
  ctx.setLang('fa');
  assert.equal(ctx.t('market_subtitle'), APPROVED_FA,
    't("market_subtitle") in fa mode must return the Persian copy, not the raw key');
  ctx.setLang('en');
  assert.equal(ctx.t('market_subtitle'), APPROVED_EN,
    't("market_subtitle") in en mode must return the English copy, not the raw key');
});

// ── 4. Display path: index.html binding + applyLanguage innerText write ─────

test('Issue 1: index.html binds data-i18n="market_subtitle" on the subtitle element', () => {
  assert.match(INDEX_HTML,
    /<p class="mkt-subtitle" data-i18n="market_subtitle"[^>]*>/,
    'Market subtitle element must keep the data-i18n="market_subtitle" binding');
});

test('Issue 1: applyLanguage() writes dictionary text into [data-i18n] elements', () => {
  // app.js:3812 (Phase 30 evidence): the only writer of data-i18n elements.
  assert.match(APP_SRC,
    /_i18nElements\.forEach\(el => \{ const key = el\.dataset\.i18n; if \(key\) el\.innerText = t\(key\); \}\)/,
    'applyLanguage() must keep writing el.innerText = t(key) for [data-i18n] elements');
});

// ── 5. No collateral drift: title + tab labels stay generic/unchanged ───────

test('Issue 1: Market title key stays generic (no collateral drift)', () => {
  assert.equal(ctx.i18n.fa.market, 'بازار', 'fa.market title copy must be untouched');
  assert.equal(ctx.i18n.en.market, 'Market', 'en.market title copy must be untouched');
});

test('Issue 1: Market tab structure untouched (crypto + forex tabs still bound)', () => {
  // Phase 30 evidence: index.html:500-508 — market tabs crypto/forex/watchlist.
  assert.match(INDEX_HTML, /data-i18n="mkt_tab_crypto"/,
    'crypto tab binding must still exist');
  assert.match(INDEX_HTML, /data-i18n="mkt_tab_forex"/,
    'forex tab binding must still exist');
});

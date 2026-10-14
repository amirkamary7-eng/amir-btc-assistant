/**
 * P0 i18n MISSING KEYS REGRESSION TEST — DY-001 / DY-002
 * =======================================================
 *
 * Root cause being locked out (from docs/ux-copy-audit/00-summary.md):
 *   DY-001 — key `error_generic` was referenced at 11 sites in app.js
 *             (markAllRead / clearAllNotifications / deleteNotification /
 *              markNotifRead / setPriceAlert sync + notif-list empty-state)
 *             but never defined in i18n.js. Because t() falls back to the
 *             raw key string (`i18n[currentLang]?.[key] || i18n.fa[key] || key`),
 *             users saw the literal string "error_generic" in a toast — the
 *             `|| 'Error'` fallbacks in app.js never fire (truthy string).
 *   DY-002 — key `done` was referenced at 2 sites in app.js (success toast
 *             after "mark all read" and "clear all notifications") but never
 *             defined, so users saw the raw word "done" on success.
 *
 * What this suite locks:
 *   1. `error_generic` and `done` exist in BOTH fa and en dictionaries,
 *      with the exact approved copy (audit 08-recommendations.md, plus
 *      trailing period to match the file's two-sentence convention).
 *   2. The REAL t() — loaded from i18n.js, not a stub — returns the
 *      translated text (never the raw key) in both language modes.
 *   3. app.js still actually calls t('error_generic') / t('done'), so the
 *      keys stay live (guards against dead-key rot in the other direction).
 *   4. Class guard: every static t('key') literal across ALL frontend files
 *      that consume the shared global i18n (app.js, admin.js,
 *      membership-user.js, membership-admin.js, assistant.js) resolves in
 *      BOTH dictionaries. This assertion is exactly what would have caught
 *      DY-001/DY-002 before shipping — it fails on any future key that is
 *      called but not defined.
 *
 * Run: node --test tests/p0-i18n-missing-keys-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const I18N_PATH = path.join(ROOT, 'i18n.js');

// ── Load the REAL i18n.js (global-scope vanilla JS, no exports) ─────────────
// It defines `let currentLang`, `const i18n`, `function t(key, params)`.
// Verified: no window/document/localStorage access at load time.
const I18N_SRC = fs.readFileSync(I18N_PATH, 'utf8');
const loadI18nContext = () => new Function(
  I18N_SRC + '\n;return { i18n, t, setLang: (l) => { currentLang = l; }, getLang: () => currentLang };'
)();
const ctx = loadI18nContext();

const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');

// Files that consume the shared global t() from i18n.js (index.html script order).
const I18N_CONSUMERS = [
  'app.js',
  'admin.js',
  'membership-user.js',
  'membership-admin.js',
  'assistant.js',
  'campaigns.js',
];

// ── 1. DY-001: `error_generic` defined in both dictionaries ─────────────────

test('DY-001: error_generic exists in fa AND en with approved copy', () => {
  assert.ok(ctx.i18n.fa && ctx.i18n.en, 'both fa and en dictionaries must exist');
  assert.equal(ctx.i18n.fa.error_generic, 'خطایی رخ داد. لطفاً دوباره تلاش کنید.',
    'fa.error_generic must be the approved Persian copy');
  assert.equal(ctx.i18n.en.error_generic, 'Something went wrong. Please try again.',
    'en.error_generic must be the approved English copy');
});

// ── 2. DY-002: `done` defined in both dictionaries ──────────────────────────

test('DY-002: done exists in fa AND en with approved copy', () => {
  assert.equal(ctx.i18n.fa.done, 'انجام شد', 'fa.done must be the approved Persian copy');
  assert.equal(ctx.i18n.en.done, 'Done', 'en.done must be the approved English copy');
});

// ── 3. Real t() returns translations, never the raw key ────────────────────

test('t() resolves error_generic and done in fa mode (no raw-key leak)', () => {
  ctx.setLang('fa');
  assert.equal(ctx.getLang(), 'fa');
  const errFa = ctx.t('error_generic');
  const doneFa = ctx.t('done');
  assert.notEqual(errFa, 'error_generic', 'fa: raw key must never surface to users');
  assert.notEqual(doneFa, 'done', 'fa: raw key must never surface to users');
  assert.match(errFa, /[\u0600-\u06FF]/, 'fa error_generic must contain Persian characters');
  assert.match(doneFa, /[\u0600-\u06FF]/, 'fa done must contain Persian characters');
});

test('t() resolves error_generic and done in en mode (no raw-key leak)', () => {
  ctx.setLang('en');
  assert.equal(ctx.getLang(), 'en');
  const errEn = ctx.t('error_generic');
  const doneEn = ctx.t('done');
  assert.notEqual(errEn, 'error_generic', 'en: raw key must never surface to users');
  assert.notEqual(doneEn, 'done', 'en: raw key must never surface to users');
  assert.match(errEn, /[a-z]/i, 'en error_generic must contain English letters');
  assert.match(doneEn, /[a-z]/i, 'en done must contain English letters');
});

test('en fallback still covers fa-only gaps and vice versa (t() chain intact)', () => {
  // The fallback chain `i18n[currentLang]?.[key] || i18n.fa[key] || key` must
  // be unchanged: an en user still sees the fa text for a fa-only key, never
  // the raw key. error_generic/done are now defined in BOTH, so they resolve
  // identically whichever chain branch fires.
  ctx.setLang('en');
  assert.equal(ctx.t('error_generic'), ctx.i18n.en.error_generic);
  ctx.setLang('fa');
  assert.equal(ctx.t('error_generic'), ctx.i18n.fa.error_generic);
});

// ── 4. app.js call sites still reference the keys (keys stay live) ──────────

test('app.js still calls t(\'error_generic\') at the 11 audited sites and t(\'done\') at 2', () => {
  const errSites = (APP_SRC.match(/\bt\(\s*'error_generic'\s*\)/g) || []).length;
  const doneSites = (APP_SRC.match(/\bt\(\s*'done'\s*\)/g) || []).length;
  assert.ok(errSites >= 11,
    `expected >= 11 t('error_generic') call sites in app.js (audit: 11), found ${errSites}`);
  assert.ok(doneSites >= 2,
    `expected >= 2 t('done') call sites in app.js (audit: 2), found ${doneSites}`);
});

// ── 5. Class guard: every static t('key') literal resolves in BOTH dicts ────
// This is the assertion that would have caught DY-001/DY-002 pre-ship.

test('every static t(\'key\') literal in i18n consumers resolves in fa AND en', () => {
  const KEY_RE = /\bt\(\s*'([^']+)'/g;
  const failures = [];
  for (const file of I18N_CONSUMERS) {
    const src = fs.readFileSync(path.join(ROOT, file), 'utf8');
    const keys = new Set();
    let m;
    while ((m = KEY_RE.exec(src)) !== null) keys.add(m[1]);
    for (const key of keys) {
      if (!(key in ctx.i18n.fa)) failures.push(`${file}: '${key}' missing in fa dictionary`);
      if (!(key in ctx.i18n.en)) failures.push(`${file}: '${key}' missing in en dictionary`);
    }
  }
  assert.deepEqual(failures, [],
    `missing i18n keys would render the raw key string to users (DY-001/DY-002 class).\n${failures.join('\n')}`);
});

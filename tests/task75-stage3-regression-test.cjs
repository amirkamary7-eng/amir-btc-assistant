/**
 * TASK 75 STAGE-3 REGRESSION TESTS
 *
 * Locks down the Stage-3 (P2/minor) remediation items from Task 75:
 *   - NT-026  mission seed descriptions use the polite register
 *   - NT-025  wheel no-reward label localized for EN users (RT dictionary)
 *   - A11y    watch-card-remove keyboard access (tabindex + Enter/Space + focus ring)
 *   - A11y    coin-detail modal aria-labels bound to i18n; market coin-stars use t()
 *   - AD P2   adminFormatDate: language-aware calendar + Asia/Tehran timezone
 *   - MO P2   assistant ACTION_LABELS + retry button language-aware
 *   - TG-019e all-day/tentative alert events render labels, not placeholder clock
 *   - NT-032  calendar-data.json static fallback is not stale (has future events)
 *
 * Run: node --test tests/task75-stage3-regression-test.cjs
 */
'use strict';

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const read = (p) => fs.readFileSync(path.join(ROOT, p), 'utf8');
const APP_SRC = read('app.js');
const INDEX_HTML = read('index.html');
const I18N_SRC = read('i18n.js');
const REFERRAL_SRC = read('referral.js');
const ASSISTANT_SRC = read('assistant.js');
const ADMIN_SRC = read('admin.js');
const WORKER_SRC = read('worker-proxy.js');
const RC_REPO_SRC = read('src/repositories/reward_center.js');
const DASHBOARD_CSS = read('dashboard.css');

// Load real dictionaries (same harness as p0 tests)
const notifSandbox = { window: {}, console };
vm.createContext(notifSandbox);
vm.runInContext(I18N_SRC + '\nthis.__out = { i18n, t };', notifSandbox);
const { i18n } = notifSandbox.__out;

// ── Helper: extract a named function ──
function extractFn(src, name) {
  const sigRe = new RegExp('(?:async\\s+)?function\\s+' + name.replace(/[$]/g, '[$&]') + '\\s*\\(');
  const sigMatch = sigRe.exec(src);
  assert.ok(sigMatch, name + ' must exist in source');
  const start = sigMatch.index;
  let i = src.indexOf('(', start);
  let pd = 1; i++;
  while (pd > 0 && i < src.length) {
    if (src[i] === '(') pd++;
    else if (src[i] === ')') pd--;
    i++;
  }
  i = src.indexOf('{', i);
  let bd = 1; i++;
  while (bd > 0 && i < src.length) {
    if (src[i] === '{') bd++;
    else if (src[i] === '}') bd--;
    i++;
  }
  return src.slice(start, i);
}

// ═══════════════════════════════════════════════════════════════════════════
// NT-026 — mission seed descriptions (polite register)
// ═══════════════════════════════════════════════════════════════════════════

test('NT-026: seed descriptions use the polite register (کنید/شوید, not کن/شو)', () => {
  const seedBlock = RC_REPO_SRC.slice(
    RC_REPO_SRC.indexOf('INSERT INTO mission_rewards'),
    RC_REPO_SRC.indexOf('ON CONFLICT (mission_id) DO NOTHING')
  );
  assert.ok(seedBlock.length > 0, 'mission seed INSERT must exist');
  for (const d of (seedBlock.match(/"description":"[^"]*"/g) || [])) {
    assert.ok(!/(باز کن|بررسی کن|بخوان|وارد اپ شو)(?![یی])/.test(d),
      'informal verb found in seed description: ' + d);
  }
  assert.ok(seedBlock.includes('هر روز وارد اپ شوید'), 'daily_login polite description');
  assert.ok(seedBlock.includes('باز کنید و بخوانید'), 'read_news polite description');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT-025 — wheel no-reward label localized for EN users
// ═══════════════════════════════════════════════════════════════════════════

test('NT-025: RT dictionaries carry no_reward_label in FA and EN', () => {
  assert.ok(REFERRAL_SRC.includes("no_reward_label: 'جایزه‌ای تنظیم نشده است'"),
    'FA RT no_reward_label');
  assert.ok(REFERRAL_SRC.includes("no_reward_label: 'No reward configured'"),
    'EN RT no_reward_label');
});

test('NT-025: result-card sub-label routes no_reward through RT, not the raw backend label', () => {
  assert.match(REFERRAL_SRC,
    /reward\.type === 'no_reward'\s*\?\s*RT\('no_reward_label'\)/,
    'the no_reward sub-label must render the localized RT text');
});

// ═══════════════════════════════════════════════════════════════════════════
// A11y — watch-card-remove keyboard access
// ═══════════════════════════════════════════════════════════════════════════

test('A11y: watch-card-remove is focusable and keyboard-activatable', () => {
  const line = APP_SRC.split('\n').find((l) => l.includes('watch-card-remove') && l.includes('aria-label'));
  assert.ok(line, 'watch-card-remove span must exist');
  assert.match(line, /tabindex="0"/, 'must be focusable via tabindex');
  assert.match(line, /onkeydown="if\(event\.key==='Enter'\|\|event\.key===' '\)/,
    'Enter and Space must activate it');
  assert.match(line, /role="button"/, 'role=button preserved');
  assert.match(DASHBOARD_CSS, /\.watch-card-remove:focus-visible\s*\{/,
    'a visible :focus-visible ring must exist');
});

// ═══════════════════════════════════════════════════════════════════════════
// A11y — coin-detail aria-labels + market coin-stars
// ═══════════════════════════════════════════════════════════════════════════

test('A11y: coin-detail aria-labels are i18n-bound and keys exist in FA+EN', () => {
  const bindings = ['cd_aria_dialog', 'cd_aria_watchlist', 'cd_aria_alert', 'cd_aria_close', 'cd_aria_timeframe', 'cd_aria_direction'];
  for (const key of bindings) {
    assert.ok(INDEX_HTML.includes(`data-i18n-aria-label="${key}"`),
      'index.html must bind ' + key);
    assert.ok(i18n.fa[key], 'FA key must exist: ' + key);
    assert.ok(i18n.en[key], 'EN key must exist: ' + key);
  }
});

test('A11y: market coin-star aria-labels use t() (no hardcoded English)', () => {
  const count = (APP_SRC.match(/aria-label="\$\{inWatch \? t\('remove_from_watchlist'\) : t\('add_to_watchlist'\)\}"/g) || []).length;
  assert.ok(count >= 2, 'both market coin-star surfaces must use t() — found ' + count);
  assert.ok(!APP_SRC.includes("aria-label=\"${inWatch ? 'Remove from watchlist' : 'Add to watchlist'}\""),
    'no hardcoded English coin-star label may remain');
});

test('i18n: FA/EN key parity holds after the new keys', () => {
  const fa = new Set(Object.keys(i18n.fa));
  const en = new Set(Object.keys(i18n.en));
  const missingInEn = [...fa].filter((k) => !en.has(k));
  const missingInFa = [...en].filter((k) => !fa.has(k));
  assert.deepEqual(missingInEn, [], 'every FA key needs an EN twin');
  assert.deepEqual(missingInFa, [], 'every EN key needs an FA twin');
});

// ═══════════════════════════════════════════════════════════════════════════
// AD P2 — adminFormatDate (language-aware + Tehran timezone)
// ═══════════════════════════════════════════════════════════════════════════

test('AD-date: adminFormatDate is language-aware and pinned to Asia/Tehran', () => {
  const fn = extractFn(ADMIN_SRC, 'adminFormatDate');
  assert.match(fn, /currentLang === 'fa'/, 'calendar follows the panel language');
  assert.match(fn, /fa-IR/, 'Persian calendar for fa');
  assert.match(fn, /en-US/, 'Gregorian calendar for en');
  const tzCount = (fn.match(/timeZone: 'Asia\/Tehran'/g) || []).length;
  assert.ok(tzCount === 2, 'both branches pin Asia/Tehran');
});

test('AD-date: adminFormatDate behavioral (fa vs en, Tehran pinning)', () => {
  // Fixed instant: 2026-10-12T00:30:00Z → Tehran 04:00 same day
  const iso = '2026-10-12T00:30:00.000Z';
  const faOut = (() => {
    const sandbox = { currentLang: 'fa' };
    vm.createContext(sandbox);
    vm.runInContext(extractFn(ADMIN_SRC, 'adminFormatDate'), sandbox);
    return vm.runInContext('adminFormatDate(' + JSON.stringify(iso) + ')', sandbox);
  })();
  assert.ok(faOut.includes('۴') || faOut.includes('4'), 'FA render shows Tehran hour: ' + faOut);
  assert.ok(/[۰-۹]/.test(faOut), 'FA render uses Persian digits: ' + faOut);

  const enOut = (() => {
    const sandbox = { currentLang: 'en' };
    vm.createContext(sandbox);
    vm.runInContext(extractFn(ADMIN_SRC, 'adminFormatDate'), sandbox);
    return vm.runInContext('adminFormatDate(' + JSON.stringify(iso) + ')', sandbox);
  })();
  assert.ok(/Oct 12/.test(enOut), 'EN render keeps Gregorian short form: ' + enOut);
  assert.ok(!/04:00/.test(new Date(iso).toLocaleString('en-US', { timeZone: 'UTC' })) || true, 'sanity');
  // Tehran pinning: regardless of this test host's timezone, hour must be 04 (Tehran).
  assert.ok(/4:00/.test(enOut.replace(/\u200f|\u202f/g, '')), 'EN hour is Tehran-pinned (4:00): ' + enOut);
});

// ═══════════════════════════════════════════════════════════════════════════
// MO P2 — assistant ACTION_LABELS + retry button
// ═══════════════════════════════════════════════════════════════════════════

test('MO-labels: assistant ACTION_LABELS has FA+EN dictionaries with equal coverage', () => {
  const faBlock = ASSISTANT_SRC.slice(ASSISTANT_SRC.indexOf('const ACTION_LABELS_FA'), ASSISTANT_SRC.indexOf('const ACTION_LABELS_EN'));
  const enBlock = ASSISTANT_SRC.slice(ASSISTANT_SRC.indexOf('const ACTION_LABELS_EN'), ASSISTANT_SRC.indexOf('const _actionLang'));
  const faKeys = (faBlock.match(/open_[a-z_]+:/g) || []).length;
  const enKeys = (enBlock.match(/open_[a-z_]+:/g) || []).length;
  assert.ok(faKeys >= 19, 'FA dictionary covers all actions (' + faKeys + ')');
  assert.equal(faKeys, enKeys, 'EN dictionary must mirror FA');
  assert.match(ASSISTANT_SRC, /\(typeof currentLang !== 'undefined' && currentLang === 'en'\) \? 'en' : 'fa'/,
    'language detection follows the global i18n state');
  assert.match(ASSISTANT_SRC, /ACTION_LABELS = _actionLang === 'en' \? ACTION_LABELS_EN : ACTION_LABELS_FA/,
    'dictionary pick follows the detected language');
});

test('MO-labels: assistant retry button is language-aware', () => {
  assert.match(ASSISTANT_SRC, /retryBtn\.textContent = \(typeof currentLang !== 'undefined' && currentLang === 'en'\)\s*\?\s*'↻ Retry' : '↻ تلاش مجدد'/,
    'retry button text follows the panel language');
});

// ═══════════════════════════════════════════════════════════════════════════
// TG-019 edge — all-day/tentative alert rendering
// ═══════════════════════════════════════════════════════════════════════════

test('TG-019e: all-day/tentative events render labels, not the placeholder clock', () => {
  const sandbox = { Date, isNaN, String };
  vm.createContext(sandbox);
  vm.runInContext(extractFn(WORKER_SRC, 'formatEventTimeTehran') + '\n' + extractFn(WORKER_SRC, 'formatEventTimeForAlert'), sandbox);
  const allDay = vm.runInContext("formatEventTimeForAlert({ time: 'All Day', timestamp: '2026-10-12T12:00:00.000Z' })", sandbox);
  assert.equal(allDay, 'تمام‌روز');
  const tentative = vm.runInContext("formatEventTimeForAlert({ time: 'Tentative', timestamp: '2026-10-12T12:00:00.000Z' })", sandbox);
  assert.equal(tentative, 'زمان احتمالی');
  const timed = vm.runInContext("formatEventTimeForAlert({ time: '2:00 pm', timestamp: '2026-10-12T18:00:00.000Z' })", sandbox);
  assert.ok(timed.includes('به وقت تهران'), 'timed events keep the Tehran label: ' + timed);
  assert.ok(!timed.includes('2:00 pm'), 'raw feed string must not leak: ' + timed);
  // Alert body uses the new helper:
  assert.match(WORKER_SRC, /const message = `\$\{event\.country\} \$\{event\.flag\} — \$\{formatEventTimeForAlert\(event\)\}`/,
    'calendar alert body routes through formatEventTimeForAlert');
});

// ═══════════════════════════════════════════════════════════════════════════
// NT-032 — calendar snapshot freshness
// ═══════════════════════════════════════════════════════════════════════════

test('NT-032: static calendar fallback contains current-week events (not all past)', () => {
  const data = JSON.parse(read('assets/calendar-data.json'));
  assert.ok(Array.isArray(data) && data.length > 0, 'snapshot must be a non-empty array');
  const now = Date.now();
  const ts = data.map((e) => new Date(e.timestamp).getTime()).filter((t) => !isNaN(t));
  const future = ts.filter((t) => t >= now).length;
  assert.ok(future > 0, 'snapshot must contain at least one future event (dead-fallback regression)');
  const inWindow = ts.filter((t) => t >= now - 24 * 3600 * 1000 && t <= now + 7 * 24 * 3600 * 1000).length;
  assert.ok(inWindow === ts.length, 'all snapshot events must sit in the live ±1d/+7d serving window');
  // Shape must stay pre-mapped (the serving path skips re-mapping when flag is present)
  assert.ok(typeof data[0].flag === 'string', 'snapshot events must stay pre-mapped (flag field)');
  for (const k of ['title', 'country', 'flag', 'date', 'impact', 'impact_label', 'status', 'timestamp']) {
    assert.ok(k in data[0], 'pre-mapped field must exist: ' + k);
  }
});

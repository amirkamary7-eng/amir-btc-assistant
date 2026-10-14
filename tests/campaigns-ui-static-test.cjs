/**
 * CAMPAIGNS UI — STAGE 4 STATIC REGRESSION TEST
 * =============================================
 * Locks the Exchange Campaigns user-UI wiring (hero 3rd slide,
 * fullscreen list/detail overlays, i18n keys, build registration)
 * WITHOUT a browser. Pure static assertions on the repo files.
 *
 * What this suite locks:
 *   1. campaigns.js / campaigns.css exist and campaigns.js parses
 *      (node --check) and exposes window.CampaignsApp with the
 *      four approved methods (open/close/openDetail/closeDetail).
 *   2. index.html contains the 3rd hero slide referencing
 *      assets/banner-campian.webp with the ratio-preserving class,
 *      the 3rd dot (data-dot="2"), the campaigns.css link, the
 *      #campaigns-full-page container and the deferred script tag
 *      placed AFTER i18n.js and BEFORE app.js.
 *   3. The two EXISTING hero slides are preserved byte-for-byte
 *      at the contract level: slide 0 → banner-premium.webp +
 *      MembershipApp.open(); slide 1 → banner-channel.webp +
 *      t.me/amir_btc_2024 link (no regression on the current
 *      banners' appearance or behavior).
 *   4. Slider behavior is preserved: app.js still discovers slides
 *      dynamically (querySelectorAll('.hero-slide')) and dashboard.css
 *      is untouched for the existing classes (no .hero-slide-img--ratio
 *      definition there — the new class lives only in campaigns.css).
 *   5. All cmp_* i18n keys exist in BOTH fa and en dictionaries
 *      (loads the real i18n.js, same technique as the p0 test).
 *   6. Build pipeline: campaigns.js + campaigns.css are registered in
 *      prepare-pages.mjs hashedFiles.
 *   7. Registration safety (Stage 5B contract): in DEMO mode campaigns.js
 *      must never send a register POST (honest not-live toast only); in REAL
 *      mode the one-tap POST is sent, and success is announced ONLY when the
 *      server confirmed it (body.registered === true). No faked success.
 *   8. UX contracts: scroll lock, Telegram BackButton integration,
 *      safe-area support, RTL handling.
 *
 * Run: node --test tests/campaigns-ui-static-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ROOT = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(ROOT, f), 'utf8');

const CMP_JS = read('campaigns.js');
const CMP_CSS = read('campaigns.css');
const HTML = read('index.html');
const PREPARE = read('scripts/prepare-pages.mjs');

// ── 1. Files exist & JS parses ─────────────────────────────────────────────

test('campaigns.js exists, parses (node --check), exposes CampaignsApp', () => {
  assert.ok(CMP_JS.length > 0, 'campaigns.js must not be empty');
  execFileSync(process.execPath, ['--check', path.join(ROOT, 'campaigns.js')], {
    stdio: 'pipe',
  });
  assert.match(CMP_JS, /window\.CampaignsApp\s*=/, 'must register window.CampaignsApp');
  for (const m of ['open', 'close', 'openDetail', 'closeDetail']) {
    assert.match(CMP_JS, new RegExp(`\\b${m}\\s*:`), `CampaignsApp API must include ${m}`);
  }
});

test('campaigns.css exists with overlay, badge, bar and safe-area styles', () => {
  assert.ok(CMP_CSS.length > 0, 'campaigns.css must not be empty');
  assert.match(CMP_CSS, /#campaigns-full-page\s*(,|\{)/, 'list overlay selector');
  assert.match(CMP_CSS, /\.cmp-detail-overlay\s*\{/, 'detail overlay selector');
  assert.match(CMP_CSS, /\.cmp-badge--active\s*\{/, 'ACTIVE badge style');
  assert.match(CMP_CSS, /\.cmp-badge--upcoming\s*\{/, 'UPCOMING badge style');
  assert.match(CMP_CSS, /\.cmp-badge--ended\s*\{/, 'ENDED badge style');
  assert.match(CMP_CSS, /\.cmp-badge--stopped\s*\{/, 'STOPPED badge style');
  assert.match(CMP_CSS, /\.cmp-detail-bar\s*\{/, 'fixed bottom bar style');
  assert.match(CMP_CSS, /safe-area-inset-bottom/, 'bottom bar respects safe area');
  assert.match(CMP_CSS, /safe-area-inset-top/, 'header respects safe area');
  assert.match(CMP_CSS, /\.cmp-demo-chip\s*\{/, 'demo data chip style');
});

// ── 2. index.html wiring ───────────────────────────────────────────────────

test('index.html: 3rd hero slide with campaign webp + ratio class + open handler', () => {
  assert.match(
    HTML,
    /<div class="hero-slide" data-slide="2"[^>]*CampaignsApp\.open\(\)/,
    'slide 2 must open CampaignsApp',
  );
  const slide2 = HTML.match(/<div class="hero-slide" data-slide="2"[\s\S]*?<\/div>/)?.[0] || '';
  assert.ok(slide2, 'slide 2 block must exist');
  assert.match(slide2, /assets\/banner-campian\.webp/, 'slide 2 uses the campaign webp');
  assert.match(slide2, /hero-slide-img--ratio/, 'slide 2 img uses the ratio-preserving class');
  assert.doesNotMatch(slide2, /hero-cta/, 'no CTA overlay on the campaign slide (approved design)');
  assert.match(slide2, /data-i18n-aria-label="cmp_hero_aria"/, 'localized aria-label');
});

test('index.html: 3rd dot present, dots container has exactly 3 dots', () => {
  const dotsBlock = HTML.match(/<div class="hero-slider-dots" id="hero-slider-dots">([\s\S]*?)<\/div>/)?.[1] || '';
  const dots = dotsBlock.match(/<span class="hero-dot[^"]*" data-dot="\d+"><\/span>/g) || [];
  assert.equal(dots.length, 3, `expected exactly 3 dots, found ${dots.length}`);
  assert.match(dotsBlock, /data-dot="2"/, 'third dot must be data-dot="2"');
});

test('index.html: css link, container div, script order (i18n → campaigns → app)', () => {
  assert.match(HTML, /<link rel="stylesheet" href="campaigns\.css"/, 'campaigns.css link tag');
  assert.match(
    HTML,
    /<div id="campaigns-full-page" class="campaigns-full-page"><\/div>/,
    'fullscreen list container',
  );
  assert.match(HTML, /<script src="campaigns\.js" defer><\/script>/, 'deferred script tag');
  const i18nPos = HTML.indexOf('<script src="i18n.js" defer>');
  const cmpPos = HTML.indexOf('<script src="campaigns.js" defer>');
  const appPos = HTML.indexOf('<script src="app.js" defer>');
  assert.ok(i18nPos !== -1 && cmpPos !== -1 && appPos !== -1, 'all three script tags present');
  assert.ok(i18nPos < cmpPos, 'campaigns.js must load AFTER i18n.js (uses global t())');
  assert.ok(cmpPos < appPos, 'campaigns.js must load BEFORE app.js');
});

// ── 3. Existing slides preserved (appearance + behavior) ───────────────────

test('index.html: existing slide 0 (premium) preserved', () => {
  const slide0 = HTML.match(/<div class="hero-slide active" data-slide="0"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  assert.ok(slide0, 'slide 0 block must exist');
  assert.match(slide0, /assets\/banner-premium\.webp/, 'slide 0 keeps banner-premium.webp');
  assert.match(slide0, /hero-slide-img hero-slide-img--cover/, 'slide 0 keeps its original img class');
  assert.match(slide0, /MembershipApp\.open\(\)/, 'slide 0 keeps MembershipApp.open behavior');
  assert.match(slide0, /data-i18n="premium_activate"/, 'slide 0 CTA keeps its i18n key');
});

test('index.html: existing slide 1 (channel) preserved', () => {
  const slide1 = HTML.match(/<div class="hero-slide" data-slide="1"[\s\S]*?<\/div>\s*<\/div>/)?.[0] || '';
  assert.ok(slide1, 'slide 1 block must exist');
  assert.match(slide1, /assets\/banner-channel\.webp/, 'slide 1 keeps banner-channel.webp');
  assert.match(slide1, /hero-slide-img hero-slide-img--cover/, 'slide 1 keeps its original img class');
  assert.match(slide1, /t\.me\/amir_btc_2024/, 'slide 1 keeps the channel link');
  assert.match(slide1, /data-i18n="join_channel"/, 'slide 1 CTA keeps its i18n key');
});

test('slider logic untouched: app.js still discovers slides dynamically', () => {
  const appSrc = read('app.js');
  assert.match(appSrc, /querySelectorAll\('\.hero-slide'\)/, 'dynamic slide discovery');
  assert.match(appSrc, /querySelectorAll\('\.hero-dot'\)/, 'dynamic dot discovery');
});

test('dashboard.css untouched for hero classes (new class lives only in campaigns.css)', () => {
  const dashSrc = read('dashboard.css');
  assert.match(dashSrc, /\.hero-slide-img--cover\s*\{/, 'existing cover class still in dashboard.css');
  assert.doesNotMatch(
    dashSrc,
    /\.hero-slide-img--ratio/,
    'dashboard.css must NOT define the new ratio class (no changes allowed to dashboard.css)',
  );
  assert.match(CMP_CSS, /\.hero-slide-img--ratio\s*\{/, 'ratio class defined in campaigns.css');
});

test('banner assets on disk unchanged (webp + jpg both present)', () => {
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/banner-campian.webp')), 'campaign webp exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/banner-campian.jpg')), 'original jpg untouched (still present)');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/banner-premium.webp')), 'premium banner exists');
  assert.ok(fs.existsSync(path.join(ROOT, 'assets/banner-channel.webp')), 'channel banner exists');
});

// ── 4. i18n parity for cmp_* keys (real i18n.js loaded, p0-test technique) ─

const I18N_SRC = read('i18n.js');
const loadI18nContext = () =>
  new Function(I18N_SRC + '\n;return { i18n };')();

test('every cmp_* key referenced by campaigns.js exists in fa AND en', () => {
  const ctx = loadI18nContext();
  const KEY_RE = /\bt\(\s*'([^']+)'/g;
  const keys = new Set();
  let m;
  while ((m = KEY_RE.exec(CMP_JS)) !== null) {
    if (m[1].startsWith('cmp_')) keys.add(m[1]);
  }
  assert.ok(keys.size >= 20, `campaigns.js should reference the cmp_* keys (found ${keys.size})`);
  const failures = [];
  for (const key of keys) {
    if (!(key in ctx.i18n.fa)) failures.push(`${key} missing in fa`);
    if (!(key in ctx.i18n.en)) failures.push(`${key} missing in en`);
  }
  assert.deepEqual(failures, [], `cmp_* i18n parity failures:\n${failures.join('\n')}`);
});

test('all declared cmp_* dictionaries hold the same key set in fa and en', () => {
  const ctx = loadI18nContext();
  const faKeys = Object.keys(ctx.i18n.fa).filter((k) => k.startsWith('cmp_')).sort();
  const enKeys = Object.keys(ctx.i18n.en).filter((k) => k.startsWith('cmp_')).sort();
  assert.deepEqual(faKeys, enKeys, 'fa and en cmp_* key sets must be identical');
  assert.ok(faKeys.length >= 20, `expected >= 20 cmp_* keys, found ${faKeys.length}`);
});

test('no raw-key leak: fa and en cmp_* values are non-empty strings', () => {
  const ctx = loadI18nContext();
  for (const lang of ['fa', 'en']) {
    for (const [k, v] of Object.entries(ctx.i18n[lang])) {
      if (!k.startsWith('cmp_')) continue;
      assert.equal(typeof v, 'string', `${lang}.${k} must be a string`);
      assert.ok(v.trim().length > 0, `${lang}.${k} must be non-empty`);
    }
  }
});

// ── 5. Build pipeline registration ─────────────────────────────────────────

test('prepare-pages.mjs hashes campaigns.js and campaigns.css', () => {
  assert.match(PREPARE, /'campaigns\.js',/, 'campaigns.js in hashedFiles');
  assert.match(PREPARE, /'campaigns\.css',/, 'campaigns.css in hashedFiles');
});

test('p0 i18n class-guard covers campaigns.js as a consumer', () => {
  const p0 = read('tests/p0-i18n-missing-keys-regression-test.cjs');
  assert.match(p0, /'campaigns\.js',/, 'campaigns.js must be in I18N_CONSUMERS');
});

// ── 6. Safety: no simulated/real registration ──────────────────────────────

test('register POST is gated on demo mode (demo never sends, real mode does)', () => {
  // Demo mode: the honest not-live toast — no POST path.
  const registerHandler = CMP_JS.slice(
    CMP_JS.indexOf("if (action === 'register-info')"),
    CMP_JS.indexOf("var card = target.closest"),
  );
  assert.ok(registerHandler.includes('if (_demoMode)'),
    'register handler must branch on _demoMode first');
  const demoBranch = registerHandler.slice(
    registerHandler.indexOf('if (_demoMode)'),
    registerHandler.indexOf('handleRegisterClick(actionEl)'),
  );
  assert.ok(demoBranch.includes('cmp_register_soon'),
    'demo branch shows the honest not-live copy');
  assert.ok(!demoBranch.includes('registerCampaign('),
    'demo branch must NOT call registerCampaign (no POST in demo mode)');
  assert.ok(registerHandler.includes('handleRegisterClick(actionEl)'),
    'real mode dispatches to the register flow');
  // The register POST itself targets ONLY the live register endpoint.
  assert.match(CMP_JS, /'\/api\/campaigns\/'.*.*'\/register'/,
    'register URL is /api/campaigns/:id/register');
  const methods = CMP_JS.match(/method:\s*'([A-Z]+)'/g) || [];
  assert.deepEqual([...new Set(methods)].sort(), ["method: 'GET'", "method: 'POST'"],
    'exactly two HTTP methods: list GET + register POST');
});

test('register success is server-confirmed only; errors mapped honestly (no fake success)', () => {
  assert.match(CMP_JS, /res\.body && res\.body\.registered === true/,
    'success requires the server body to confirm registered===true');
  assert.match(CMP_JS, /cmp_register_success/, 'uses the success copy');
  assert.match(CMP_JS, /cmp_register_already/, 'uses the already-registered copy');
  assert.match(CMP_JS, /already_registered/, 'distinguishes already-registered server responses');
  // Error codes mapped to honest messages — never a success toast.
  assert.match(CMP_JS, /CAMPAIGN_NOT_STARTED/, 'maps CAMPAIGN_NOT_STARTED');
  assert.match(CMP_JS, /CAMPAIGN_STOPPED/, 'maps CAMPAIGN_STOPPED');
  assert.match(CMP_JS, /RATE_LIMITED/, 'maps RATE_LIMITED');
  assert.match(CMP_JS, /cmp_register_error/, 'generic failure copy exists');
  // In-flight guard: exactly one register POST at a time.
  assert.match(CMP_JS, /_registeringId/, 'single in-flight registration guard');
  // Demo copy still present for the demo path.
  assert.match(CMP_JS, /cmp_register_soon/, 'honest not-live copy retained for demo mode');
});

test('GET list attaches the signed Telegram initData header', () => {
  assert.match(CMP_JS, /X-Telegram-Init-Data/, 'initData header is set');
  assert.match(CMP_JS, /window\.getTelegramInitData/,
    'uses the shared app.js helper (same header apiFetch sends)');
});

test('demo data is clearly labeled in code and UI', () => {
  assert.match(CMP_JS, /buildDemoCampaigns/, 'demo data builder exists');
  assert.match(CMP_JS, /cmp_demo_notice/, 'demo notice key used');
  assert.match(CMP_JS, /cmp_demo_badge/, 'demo badge key used');
  assert.match(CMP_JS, /cmp_demo_detail_note/, 'demo detail note key used');
  const demoTitles = CMP_JS.match(/title_fa:\s*'([^']*)'/g) || [];
  assert.ok(
    demoTitles.every((t) => /نمایشی/.test(t)),
    'every demo title must contain the word نمایشی (demo)',
  );
});

// ── 7. UX contracts ───────────────────────────────────────────────────────

test('scroll lock: body overflow toggled on open/close', () => {
  assert.match(CMP_JS, /document\.body\.style\.overflow = 'hidden'/, 'lock on open');
  assert.match(CMP_JS, /document\.body\.style\.overflow = ''/, 'release on close');
});

test('Telegram BackButton integration with stale-entry guards', () => {
  assert.match(CMP_JS, /window\.tgBackPush/, 'pushes close handlers onto the Back stack');
  assert.match(CMP_JS, /window\.tgBackPop/, 'pops its own entry when closed in-page');
  assert.match(CMP_JS, /_closingListFromBack/, 'list stale/back guard');
  assert.match(CMP_JS, /_closingDetailFromBack/, 'detail stale/back guard');
});

test('RTL/LTR: applyDir sets direction per current language', () => {
  assert.match(CMP_JS, /setAttribute\('dir',/, 'sets dir attribute');
  assert.match(CMP_JS, /'rtl' : 'ltr'/, 'rtl for fa, ltr otherwise');
});

test('API fallback: any failure degrades to clearly-labeled demo mode', () => {
  assert.match(CMP_JS, /demoMode: true/, 'failed loads resolve to demo mode');
  assert.match(CMP_JS, /_demoMode = result\.demoMode/, 'demo mode applied only after generation check (no stale overwrite)');
  assert.match(CMP_JS, /bad shape/, 'shape validation rejects malformed responses');
});

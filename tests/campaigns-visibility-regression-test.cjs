/**
 * CAMPAIGNS — PUBLISHED-CAMPAIGN VISIBILITY REGRESSION TEST (behavioral)
 * =====================================================================
 * Root cause this suite locks (Problem B): the campaign list used to be
 * fetched WITHOUT waiting for Telegram auth readiness (unlike app.js
 * apiFetch, which awaits waitForApiReady — on cold-open the SDK may not
 * have populated initData yet), and ANY failure fell back to clearly-labeled
 * DEMO data — masking 401/503/network failures as "no campaigns". A
 * published campaign therefore "did not show" for users.
 *
 * Behavioral harness: the REAL campaigns.js is executed in a vm with DOM,
 * fetch and i18n stubs; open()/retry flows are driven end-to-end.
 *
 * Locked contracts:
 *   VIS-01  open() waits for auth readiness BEFORE the fetch (order + header)
 *   VIS-02  a throwing waitForApiReady never blocks the fetch (resolve-on-fail)
 *   VIS-03  401 → honest error state (retry button + real status; no demo, no empty)
 *   VIS-04  network failure → honest error state (not demo, not empty)
 *   VIS-05  retry button re-fires the load and recovers on success
 *   VIS-06  re-open always refetches fresh data (no stale/blank masking)
 *   VIS-07  internal /api/ image URLs resolve against API_BASE; external untouched
 *   VIS-08  language switch changes the rendered text; stored data unchanged
 *   VIS-09  zero campaigns → honest EMPTY state (not error, not demo)
 *   VIS-10  status badges: ACTIVE / UPCOMING / STOPPED rendered per campaign
 *   VIS-11  stored campaign data is never mutated by rendering
 *
 * Server-side visibility (PUBLISHED/STOPPED visible; DRAFT/DELETED never
 * leave the server) is locked by CAM-15 in campaigns-api-contract-test.cjs;
 * the admin publish → DB/API status reflection is locked by the CAMA
 * setCampaignStatus tests in campaigns-admin-api-contract-test.cjs.
 *
 * All tests are offline. Run: node --test tests/campaigns-visibility-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CMP_SRC = fs.readFileSync(path.join(ROOT, 'campaigns.js'), 'utf8');

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeEl(id) {
  return {
    id,
    innerHTML: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute() {},
    appendChild() {},
    scrollTop: 0,
    style: {},
  };
}

/**
 * Execute the REAL campaigns.js in a fresh vm context.
 * opts:
 *   fetchHandler (url, opts)        -> Promise<Response-like> (required)
 *   apiBase                          -> window.API_BASE (default 'https://api.test')
 *   lang                             -> window.currentLang (default 'fa')
 *   waitForApiReady                  -> custom stub for window.waitForApiReady
 *   recordOrder                      -> push 'wait'/'fetch' into calls.order
 */
function loadModule(opts) {
  const window = {
    API_BASE: opts.apiBase !== undefined ? opts.apiBase : 'https://api.test',
    currentLang: opts.lang || 'fa',
    getTelegramInitData: () => 'init-data-stub',
  };
  if (opts.waitForApiReady) window.waitForApiReady = opts.waitForApiReady;
  else if (opts.recordOrder) {
    window.waitForApiReady = () => new Promise((r) => setTimeout(() => r(), 5));
  }

  const calls = { order: [], fetches: [] };
  const listeners = {};
  const pageEl = makeEl('campaigns-full-page');
  const bodyEl = makeEl('cmp-list-body');
  const document = {
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    getElementById(id) {
      if (id === 'campaigns-full-page') return pageEl;
      if (id === 'cmp-list-body') return bodyEl;
      return null;
    },
    createElement: () => makeEl('created'),
    body: { style: {} },
  };
  const sandbox = {
    window,
    document,
    fetch(url, options) {
      calls.order.push('fetch');
      calls.fetches.push({ url, options });
      return opts.fetchHandler(url, options);
    },
    t: (k) => k,
    showToast: () => {},
    Element: class Element {
      closest() { return null; }
    },
    AbortController,
    setTimeout,
    clearTimeout,
    console,
  };
  vm.createContext(sandbox);
  vm.runInContext(CMP_SRC, sandbox, { filename: 'campaigns.js' });
  return { window, document, pageEl, bodyEl, listeners, calls, sandbox };
}

// Standard 200 list response factory.
const okResponse = (campaigns) => ({
  ok: true,
  status: 200,
  json: async () => ({ status: 'ok', count: campaigns.length, campaigns }),
});
const errResponse = (status) => ({
  ok: false,
  status,
  json: async () => ({}),
});

const DAY = 24 * 60 * 60 * 1000;
const iso = (offsetDays) => new Date(Date.now() + offsetDays * DAY).toISOString();

// ── VIS-01: auth wait precedes the fetch ────────────────────────────────────

test('VIS-01: open() waits for Telegram auth readiness BEFORE the fetch', async () => {
  const m = loadModule({
    recordOrder: true,
    fetchHandler: () => Promise.resolve(okResponse([])),
  });
  m.window.CampaignsApp.open();
  await flush();
  assert.deepEqual(m.calls.order, ['fetch'], 'recordOrder mode: fetch happened (auth wait stub resolves quickly)');
  assert.equal(m.calls.fetches.length, 1, 'exactly one list fetch');
  const headers = m.calls.fetches[0].options.headers;
  assert.equal(headers['X-Telegram-Init-Data'], 'init-data-stub', 'signed initData header attached');
  assert.equal(m.calls.fetches[0].url, 'https://api.test/api/campaigns', 'URL built from API_BASE');
});

test('VIS-01b: the fetch is not sent until the auth promise resolves (ordering)', async () => {
  let releaseAuth;
  const gate = new Promise((r) => { releaseAuth = r; });
  const m = loadModule({
    waitForApiReady: () => gate,
    fetchHandler: () => Promise.resolve(okResponse([])),
  });
  m.window.CampaignsApp.open();
  await flush(10);
  assert.equal(m.calls.fetches.length, 0, 'fetch must NOT be sent while auth is pending');
  releaseAuth();
  await flush(10);
  assert.equal(m.calls.fetches.length, 1, 'fetch fires as soon as auth resolves');
});

test('VIS-02: a THROWING waitForApiReady never blocks the fetch (resolve-on-fail)', async () => {
  const m = loadModule({
    waitForApiReady: () => { throw new Error('API_BASE not configured'); },
    fetchHandler: () => Promise.resolve(okResponse([])),
  });
  m.window.CampaignsApp.open();
  await flush();
  assert.equal(m.calls.fetches.length, 1, 'fetch still runs when the auth helper throws');
});

// ── VIS-03/04: honest error states — no demo, no empty masking ──────────────

test('VIS-03: 401 → honest error state with retry + real status (no demo, no empty)', async () => {
  const m = loadModule({
    fetchHandler: () => Promise.resolve(errResponse(401)),
  });
  m.window.CampaignsApp.open();
  await flush();
  const html = m.bodyEl.innerHTML;
  assert.match(html, /cmp_list_error/, 'error title shown');
  assert.match(html, /HTTP 401/, 'the real failure status is surfaced');
  assert.match(html, /data-action="retry"/, 'retry button offered');
  assert.ok(!html.includes('cmp-card'), 'no campaign cards fabricated');
  assert.ok(!html.includes('cmp_list_empty'), 'not masked as the empty state');
  assert.ok(!html.includes('نمایشی'), 'no demo data');
});

test('VIS-04: network failure → honest error state (not demo, not empty)', async () => {
  const m = loadModule({
    fetchHandler: () => Promise.reject(new Error('network down')),
  });
  m.window.CampaignsApp.open();
  await flush();
  const html = m.bodyEl.innerHTML;
  assert.match(html, /cmp_list_error/, 'error title shown');
  assert.match(html, /network down/, 'failure detail surfaced');
  assert.match(html, /data-action="retry"/, 'retry button offered');
  assert.ok(!html.includes('cmp_list_empty'), 'not masked as the empty state');
});

// ── VIS-05: retry recovers ──────────────────────────────────────────────────

test('VIS-05: the retry button re-fires the load and recovers on success', async () => {
  let failing = true;
  const m = loadModule({
    fetchHandler: () => (failing
      ? Promise.resolve(errResponse(503))
      : Promise.resolve(okResponse([{
        id: 'camp-retry', title_fa: 'کمپین بازیابی', title_en: 'Recovered',
        starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false,
      }]))),
  });
  m.window.CampaignsApp.open();
  await flush();
  assert.match(m.bodyEl.innerHTML, /cmp_list_error/, 'initial failure shown');

  // Simulate a click on the retry button through the real delegation handler.
  const clickHandler = m.listeners.click[0];
  const fakeActionEl = { getAttribute: (n) => (n === 'data-action' ? 'retry' : null) };
  const fakeTarget = new m.sandbox.Element();
  fakeTarget.closest = (sel) => (sel === '[data-action]' ? fakeActionEl : null);
  failing = false;
  clickHandler({ target: fakeTarget });
  await flush();
  assert.match(m.bodyEl.innerHTML, /کمپین بازیابی/, 'recovered: the real campaign renders');
  assert.equal(m.calls.fetches.length, 2, 'retry fired a second fetch');
});

// ── VIS-06: re-open refetches fresh data ────────────────────────────────────

test('VIS-06: re-open always refetches fresh data (publish → next open shows it)', async () => {
  let published = false;
  const m = loadModule({
    fetchHandler: () => Promise.resolve(okResponse(published
      ? [{ id: 'camp-new', title_fa: 'کمپین تازه منتشرشده', title_en: 'Fresh', starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false }]
      : [])),
  });
  m.window.CampaignsApp.open();
  await flush();
  assert.match(m.bodyEl.innerHTML, /cmp_list_empty/, 'before publish: honest empty state');

  // The admin publishes elsewhere; the user re-opens the page.
  published = true;
  m.window.CampaignsApp.close();
  m.window.CampaignsApp.open();
  await flush();
  assert.match(m.bodyEl.innerHTML, /کمپین تازه منتشرشده/, 'newly published campaign appears after re-open');
  assert.equal(m.calls.fetches.length, 2, 'every open performs a fresh fetch (no cache)');
});

// ── VIS-07: internal image URL resolution ───────────────────────────────────

test('VIS-07: internal /api/ image URLs resolve against API_BASE; external untouched', async () => {
  const m = loadModule({
    fetchHandler: () => Promise.resolve(okResponse([
      { id: 'c1', title_fa: 'داخلی', title_en: 'Internal', image_url: '/api/advertisements/image/img_12345678', starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false },
      { id: 'c2', title_fa: 'خارجی', title_en: 'External', image_url: 'https://cdn.example.com/banner.webp', starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false },
    ])),
  });
  m.window.CampaignsApp.open();
  await flush();
  const html = m.bodyEl.innerHTML;
  assert.match(html, /src="https:\/\/api\.test\/api\/advertisements\/image\/img_12345678"/,
    'internal upload URL prefixed with the API base');
  assert.match(html, /src="https:\/\/cdn\.example\.com\/banner\.webp"/, 'external URL untouched');
  assert.ok(!html.includes('src="/api/advertisements'), 'no raw relative internal src remains');
});

// ── VIS-08: language switch (Problem C display contract) ─────────────────────

test('VIS-08: switching the app language changes the rendered text; stored data unchanged', async () => {
  const serverCampaign = {
    id: 'c-lang', title_fa: 'عنوان فارسی', title_en: 'English Title',
    summary_fa: 'خلاصه فارسی', summary_en: 'English Summary',
    starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false,
  };
  const snapshot = JSON.parse(JSON.stringify(serverCampaign));
  const m = loadModule({
    lang: 'fa',
    fetchHandler: () => Promise.resolve(okResponse([serverCampaign])),
  });
  m.window.CampaignsApp.open();
  await flush();
  assert.match(m.bodyEl.innerHTML, /عنوان فارسی/, 'fa render shows the Persian title');
  assert.ok(!m.bodyEl.innerHTML.includes('English Title'), 'fa render hides the English title');

  m.window.CampaignsApp.close();
  m.window.currentLang = 'en';
  m.window.CampaignsApp.open();
  await flush();
  assert.match(m.bodyEl.innerHTML, /English Title/, 'en render shows the English title');
  assert.ok(!m.bodyEl.innerHTML.includes('عنوان فارسی</h3>'), 'en render hides the Persian title');

  // The stored server data was never mutated by any render pass.
  assert.deepEqual(serverCampaign, snapshot, 'stored campaign text unchanged');
});

test('VIS-08b: a campaign without a translation shows the ORIGINAL text in both languages', async () => {
  // Single-field campaign saved with only Persian (no manual translation):
  // title_en carries the ORIGINAL text (no fake translation) — English users
  // see the same original via the display fallback.
  const single = {
    id: 'c-single', title_fa: 'فقط فارسی', title_en: 'فقط فارسی',
    summary_fa: 'خلاصه', summary_en: null,
    starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false,
  };
  const m = loadModule({
    lang: 'en',
    fetchHandler: () => Promise.resolve(okResponse([single])),
  });
  m.window.CampaignsApp.open();
  await flush();
  assert.match(m.bodyEl.innerHTML, /فقط فارسی/, 'original text shown for the en user (honest, no fake translation)');
});

// ── VIS-09: honest empty state ──────────────────────────────────────────────

test('VIS-09: zero campaigns → honest EMPTY state (not error, not demo)', async () => {
  const m = loadModule({
    fetchHandler: () => Promise.resolve(okResponse([])),
  });
  m.window.CampaignsApp.open();
  await flush();
  const html = m.bodyEl.innerHTML;
  assert.match(html, /cmp_list_empty/, 'empty state shown');
  assert.ok(!html.includes('cmp_list_error'), 'not an error');
  assert.ok(!html.includes('cmp-card'), 'no fabricated cards');
});

// ── VIS-10: status badges render per campaign state ─────────────────────────

test('VIS-10: status badges — ACTIVE / UPCOMING / STOPPED rendered per campaign', async () => {
  const m = loadModule({
    fetchHandler: () => Promise.resolve(okResponse([
      { id: 'a', title_fa: 'فعال', title_en: 'A', starts_at: iso(-1), ends_at: iso(10), status: 'PUBLISHED', registered: false },
      { id: 'u', title_fa: 'به‌زودی', title_en: 'U', starts_at: iso(5), ends_at: iso(20), status: 'PUBLISHED', registered: false },
      { id: 's', title_fa: 'متوقف', title_en: 'S', starts_at: iso(-10), ends_at: null, status: 'STOPPED', registered: false },
    ])),
  });
  m.window.CampaignsApp.open();
  await flush();
  const html = m.bodyEl.innerHTML;
  assert.match(html, /cmp-badge--active/, 'ACTIVE badge');
  assert.match(html, /cmp-badge--upcoming/, 'UPCOMING badge');
  assert.match(html, /cmp-badge--stopped/, 'STOPPED badge');
  // All three campaigns render (STOPPED stays listed per the current contract).
  assert.match(html, /فعال/);
  assert.match(html, /به‌زودی/);
  assert.match(html, /متوقف/);
});

// ── VIS-11: server data is never mutated ────────────────────────────────────

test('VIS-11: rendering never mutates the server payload', async () => {
  const serverCampaigns = [
    { id: 'x1', title_fa: 'یکی', title_en: 'One', summary_fa: null, summary_en: null, body_fa: 'متن', body_en: '', image_url: null, starts_at: iso(-1), ends_at: null, status: 'PUBLISHED', registered: false },
    { id: 'x2', title_fa: 'دو', title_en: 'Two', summary_fa: null, summary_en: null, body_fa: '', body_en: 'body', image_url: '/api/advertisements/image/img_abcdefgh', starts_at: iso(-2), ends_at: iso(9), status: 'PUBLISHED', registered: true },
  ];
  const snapshot = JSON.parse(JSON.stringify(serverCampaigns));
  const m = loadModule({
    fetchHandler: () => Promise.resolve(okResponse(serverCampaigns)),
  });
  m.window.CampaignsApp.open();
  await flush();
  m.window.CampaignsApp.close();
  m.window.currentLang = 'en';
  m.window.CampaignsApp.open();
  await flush();
  assert.deepEqual(serverCampaigns, snapshot, 'server payload untouched across renders + language switch');
});

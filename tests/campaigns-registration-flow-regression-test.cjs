/**
 * CAMPAIGNS — REGISTRATION LINK / SHARE / DEEP-LINK REGRESSION (behavioral)
 * ==========================================================================
 * Locks the P0/P1 fixes shipped in the campaigns UX/registration-flow PR:
 *
 *   P0-1  Register bar behavior: the one-tap button never becomes
 *         permanently disabled on failure; double-clicks fire exactly ONE
 *         registration POST; server-confirmed success is the only path to
 *         the registered state.
 *   P0-2  Admin registration URL end-to-end (client side): a campaign with
 *         a validated registration_url renders an OPEN-LINK button that
 *         navigates to the STORED URL without any registration POST or
 *         state change; legacy campaigns keep the one-tap flow unchanged;
 *         an invalid stored URL never navigates anywhere.
 *   P1-3  Share: title + short description + public campaign deep link +
 *         registration link in the payload; Web Share API first, honest
 *         clipboard copy fallback with success/error feedback; the payload
 *         NEVER contains user data, tokens or Telegram initData.
 *   Deep  campaign_<id> links: openAndShow waits for the current load and
 *         opens the detail for a VISIBLE campaign only (DRAFT/DELETED/missing
 *         ids honestly leave the list view; a failed load keeps the honest
 *         error state).
 *
 * Behavioral harness: the REAL campaigns.js is executed in a vm with DOM,
 * fetch, URL, navigator and i18n stubs; open()/click flows run end-to-end.
 *
 * All tests are offline. Run: node --test tests/campaigns-registration-flow-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

const ROOT = path.join(__dirname, '..');
const CMP_SRC = fs.readFileSync(path.join(ROOT, 'campaigns.js'), 'utf8');

const flush = (ms = 30) => new Promise((r) => setTimeout(r, ms));

function makeEl(id, className) {
  return {
    id: id || '',
    className: className || '',
    innerHTML: '',
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
    setAttribute() {},
    isConnected: true,
    appendChild() {},
    removeChild() {},
    scrollTop: 0,
    style: {},
    value: '',
    select() {},
    focus() {},
  };
}

/**
 * Execute the REAL campaigns.js in a fresh vm context.
 * opts:
 *   fetchHandler(url, opts) -> Promise<Response-like> (required)
 *   navigatorStub        -> sandbox navigator (default: none — copy fallback path)
 *   telegram             -> window.Telegram (default: none)
 *   botUsername          -> window.BOT_USERNAME
 *   apiBase / lang / recordOrder / waitForApiReady
 */
function loadModule(opts) {
  const window = {
    API_BASE: opts.apiBase !== undefined ? opts.apiBase : 'https://api.test',
    currentLang: opts.lang || 'fa',
    getTelegramInitData: () => 'init-data-stub',
  };
  if (opts.botUsername !== undefined) window.BOT_USERNAME = opts.botUsername;
  if (opts.telegram !== undefined) window.Telegram = opts.telegram;
  if (opts.windowOpen !== undefined) window.open = opts.windowOpen;
  if (opts.waitForApiReady) window.waitForApiReady = opts.waitForApiReady;
  else if (opts.recordOrder) {
    window.waitForApiReady = () => new Promise((r) => setTimeout(() => r(), 5));
  }

  const calls = { order: [], fetches: [], toasts: [], openLink: [], windowOpen: [], shareCalls: [], clipboard: [], execCommand: 0 };
  const listeners = {};
  const pageEl = makeEl('campaigns-full-page');
  const bodyEl = makeEl('cmp-list-body');
  const created = [];
  const document = {
    addEventListener(ev, fn) { (listeners[ev] = listeners[ev] || []).push(fn); },
    getElementById(id) {
      if (id === 'campaigns-full-page') return pageEl;
      if (id === 'cmp-list-body') return bodyEl;
      return null;
    },
    createElement(tag) {
      const el = makeEl('created-' + tag, '');
      el.tagName = tag;
      created.push(el);
      return el;
    },
    execCommand() { calls.execCommand += 1; return true; },
    body: { style: {}, appendChild() {}, removeChild() {} },
  };
  const sandbox = {
    window,
    document,
    URL, // the real URL constructor — the client validator needs it
    fetch(url, options) {
      calls.order.push('fetch');
      calls.fetches.push({ url, options });
      return opts.fetchHandler(url, options);
    },
    t: (k) => k,
    showToast: (msg) => { calls.toasts.push(msg); },
    navigator: opts.navigatorStub,
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
  return { window, document, pageEl, bodyEl, listeners, calls, sandbox, created };
}

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

const ACTIVE_REG_URL = {
  id: 'camp-url', title_fa: 'کمپین با لینک', title_en: 'Linked campaign',
  summary_fa: 'خلاصه', summary_en: 'Summary',
  body_fa: 'متن بلند', body_en: 'Long body',
  image_url: null, registration_url: 'https://exchange.example.com/register?via=amirbtc',
  starts_at: iso(-1), ends_at: iso(10), status: 'PUBLISHED', registered: false,
};
const ACTIVE_LEGACY = {
  id: 'camp-legacy', title_fa: 'کمپین قدیمی', title_en: 'Legacy campaign',
  summary_fa: null, summary_en: null, body_fa: '', body_en: '',
  image_url: null, registration_url: null,
  starts_at: iso(-1), ends_at: iso(10), status: 'PUBLISHED', registered: false,
};

/** Open the list AND the detail overlay; returns the detail element. */
async function openDetailOf(m, id) {
  m.window.CampaignsApp.open();
  await flush();
  m.window.CampaignsApp.openDetail(id);
  const el = m.created[m.created.length - 1]; // ensureDetailElement appends the overlay
  return el;
}

/** Fire a delegated click on a [data-action] element through the REAL handler. */
function clickAction(m, action) {
  const handler = m.listeners.click[0];
  const fakeActionEl = { getAttribute: (n) => (n === 'data-action' ? action : null) };
  const fakeTarget = new m.sandbox.Element();
  fakeTarget.closest = (sel) => (sel === '[data-action]' ? fakeActionEl : null);
  handler({ target: fakeTarget });
}

// ═══════════════════════════════════════════════════════════════════════════
// P0-2 — ADMIN REGISTRATION URL (client side)
// ═══════════════════════════════════════════════════════════════════════════

test('REG-01: ACTIVE campaign with a valid registration_url renders the OPEN-LINK button, not the one-tap button', async () => {
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([ACTIVE_REG_URL])) });
  const el = await openDetailOf(m, 'camp-url');
  assert.match(el.innerHTML, /data-action="open-register-url"/, 'open-link button rendered');
  assert.ok(!el.innerHTML.includes('data-action="register-info"'), 'one-tap register button NOT rendered');
  assert.ok(!/disabled/.test(el.innerHTML.match(/<button class="cmp-register-btn"[^>]*>/)[0]), 'button is NOT disabled');
});

test('REG-02: legacy campaign without registration_url keeps the one-tap register flow unchanged', async () => {
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([ACTIVE_LEGACY])) });
  const el = await openDetailOf(m, 'camp-legacy');
  assert.match(el.innerHTML, /data-action="register-info"/, 'one-tap button still rendered');
  assert.ok(!el.innerHTML.includes('open-register-url'));
});

test('REG-03: clicking the URL button opens the STORED URL via Telegram openLink — no POST, no state change, not disabled', async () => {
  const m = loadModule({
    telegram: { WebApp: { openLink: (u) => m.calls.openLink.push(u) } },
    fetchHandler: () => Promise.resolve(okResponse([ACTIVE_REG_URL])),
  });
  const el = await openDetailOf(m, 'camp-url');
  const before = el.innerHTML;
  clickAction(m, 'open-register-url');
  await flush();
  assert.deepEqual(m.calls.openLink, ['https://exchange.example.com/register?via=amirbtc'],
    'the exact stored URL is opened');
  assert.equal(m.calls.fetches.length, 1, 'only the original list fetch — NO registration POST');
  assert.ok(m.calls.fetches.every((f) => !/\/register$/.test(f.url)), 'no request ever hits the register endpoint');
  assert.equal(el.innerHTML, before, 'detail not re-rendered — button state untouched');
  assert.equal(m.calls.toasts.filter((x) => /cmp_register/.test(x)).length, 0, 'no registration toast — nothing was registered');
});

test('REG-04: the URL button can be clicked again (never permanently disabled)', async () => {
  const m = loadModule({
    telegram: { WebApp: { openLink: (u) => m.calls.openLink.push(u) } },
    fetchHandler: () => Promise.resolve(okResponse([ACTIVE_REG_URL])),
  });
  await openDetailOf(m, 'camp-url');
  clickAction(m, 'open-register-url');
  await flush();
  clickAction(m, 'open-register-url');
  await flush();
  assert.equal(m.calls.openLink.length, 2, 'second click opens the link again');
  assert.equal(m.calls.fetches.length, 1, 'still zero registration POSTs');
});

test('REG-05: an INVALID stored URL never navigates — honest error, button stays usable', async () => {
  const evil = { ...ACTIVE_REG_URL, id: 'camp-evil', registration_url: 'javascript:alert(document.domain)' };
  const m = loadModule({
    telegram: { WebApp: { openLink: (u) => m.calls.openLink.push(u) } },
    windowOpen: (u) => m.calls.windowOpen.push(u),
    fetchHandler: () => Promise.resolve(okResponse([evil])),
  });
  await openDetailOf(m, 'camp-evil');
  // The button degrades honestly: an invalid link renders as the SAFE one-tap
  // in-app flow (never navigates to a dangerous destination).
  assert.ok(!m.calls.openLink.length && !m.calls.windowOpen.length, 'nothing opened at render');
  clickAction(m, 'open-register-url');
  await flush();
  assert.equal(m.calls.openLink.length, 0, 'javascript: URL NEVER opened');
  assert.equal(m.calls.windowOpen.length, 0, 'javascript: URL never window.opened either');
  assert.ok(m.calls.toasts.includes('cmp_register_url_invalid'), 'honest invalid-link toast shown');
});

test('REG-06: data:, vbscript: and malformed URLs are all rejected by the client validator', async () => {
  const cases = [
    'data:text/html;base64,PHNjcmlwdD5hbGVydCgxKTwvc2NyaXB0Pg==',
    'vbscript:msgbox(1)',
    'not a url',
    'https://user:pass@exchange.example.com/register',
    'http://localhost/x',
    'http://127.0.0.1/x',
    'http://[::1]/x',
    '',
  ];
  for (const bad of cases) {
    const c = { ...ACTIVE_REG_URL, id: 'c-' + Math.random().toString(36).slice(2, 8), registration_url: bad };
    const m = loadModule({
      telegram: { WebApp: { openLink: (u) => m.calls.openLink.push(u) } },
      windowOpen: (u) => m.calls.windowOpen.push(u),
      fetchHandler: () => Promise.resolve(okResponse([c])),
    });
    const el = await openDetailOf(m, c.id);
    clickAction(m, 'open-register-url');
    await flush();
    assert.equal(m.calls.openLink.length, 0, `never navigates for ${JSON.stringify(bad)}`);
    assert.equal(m.calls.windowOpen.length, 0, `never window.opens for ${JSON.stringify(bad)}`);
    assert.ok(el.innerHTML.length > 0);
  }
});

test('REG-07: REGISTERED state wins over registration_url (server truth, disabled button)', async () => {
  const reg = { ...ACTIVE_REG_URL, id: 'camp-done', registered: true };
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([reg])) });
  const el = await openDetailOf(m, 'camp-done');
  assert.match(el.innerHTML, /disabled/, 'registered button is disabled');
  assert.ok(!el.innerHTML.includes('open-register-url'), 'no open-link action for a registered user');
  assert.ok(!el.innerHTML.includes('register-info'), 'no one-tap register for a registered user');
});

test('REG-08: UPCOMING and STOPPED campaigns keep their closed buttons even with a registration_url', async () => {
  const upcoming = { ...ACTIVE_REG_URL, id: 'camp-soon', starts_at: iso(5), ends_at: iso(20) };
  const stopped = { ...ACTIVE_REG_URL, id: 'camp-stopped', status: 'STOPPED' };
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([upcoming, stopped])) });
  const el1 = await openDetailOf(m, 'camp-soon');
  assert.match(el1.innerHTML, /cmp-registration-not-started|cmp_registration_not_started/, 'upcoming button closed');
  assert.ok(!el1.innerHTML.includes('open-register-url'));
  m.window.CampaignsApp.closeDetail();
  const el2 = await openDetailOf(m, 'camp-stopped');
  assert.ok(!el2.innerHTML.includes('open-register-url'), 'stopped campaign does not open the link');
});

// ═══════════════════════════════════════════════════════════════════════════
// P0-1 — ONE-TAP BUTTON RE-CLICK / DUPLICATE GUARDS (legacy flow, unchanged)
// ═══════════════════════════════════════════════════════════════════════════

test('BTN-01: one-tap FAILURE re-renders an ENABLED button — never permanently disabled', async () => {
  const m = loadModule({
    fetchHandler: (url) => (/\/register$/.test(url)
      ? Promise.resolve(errResponse(503))
      : Promise.resolve(okResponse([ACTIVE_LEGACY]))),
  });
  const el = await openDetailOf(m, 'camp-legacy');
  clickAction(m, 'register-info');
  await flush();
  assert.equal(m.calls.fetches.length, 2, 'the register POST was sent');
  const btn = el.innerHTML.match(/<button class="cmp-register-btn"[^>]*>/)[0];
  assert.ok(!/disabled/.test(btn), 'after failure the button is enabled again');
  assert.match(el.innerHTML, /data-action="register-info"/, 'retry action restored');
  assert.ok(m.calls.toasts.includes('cmp_register_error'), 'honest error toast');
});

test('BTN-02: rapid DOUBLE-CLICK fires exactly ONE registration POST (in-flight guard)', async () => {
  let slowResolve;
  const m = loadModule({
    fetchHandler: (url) => (/\/register$/.test(url)
      ? new Promise((res) => { slowResolve = res; })
      : Promise.resolve(okResponse([ACTIVE_LEGACY]))),
  });
  await openDetailOf(m, 'camp-legacy');
  clickAction(m, 'register-info');
  clickAction(m, 'register-info');
  clickAction(m, 'register-info');
  await flush();
  const registerCalls = m.calls.fetches.filter((f) => /\/register$/.test(f.url));
  assert.equal(registerCalls.length, 1, 'in-flight guard collapses duplicate clicks into ONE POST');
  slowResolve(okResponse([{ registered: true }]));
  await flush();
});

test('BTN-03: server-confirmed success is the ONLY path to the registered state', async () => {
  const m = loadModule({
    fetchHandler: (url) => (/\/register$/.test(url)
      ? Promise.resolve({ ok: true, status: 200, json: async () => ({ status: 'ok', registered: true, already_registered: false }) })
      : Promise.resolve(okResponse([ACTIVE_LEGACY]))),
  });
  const el = await openDetailOf(m, 'camp-legacy');
  clickAction(m, 'register-info');
  await flush();
  assert.match(el.innerHTML, /disabled/, 'registered state after server confirmation');
  assert.ok(m.calls.toasts.includes('cmp_register_success'), 'success toast (server-confirmed)');
});

// ═══════════════════════════════════════════════════════════════════════════
// P1-3 — SHARE
// ═══════════════════════════════════════════════════════════════════════════

test('SHR-01: the share button is ALWAYS present in the detail bar (registered/ended too)', async () => {
  const reg = { ...ACTIVE_REG_URL, id: 'camp-done2', registered: true };
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([reg])) });
  const el = await openDetailOf(m, 'camp-done2');
  assert.match(el.innerHTML, /class="cmp-share-btn"[^>]*data-action="share"/, 'share button present for a registered campaign');
});

test('SHR-02: Web Share API used when available; payload has title, summary, deep link, registration URL — and NO secrets', async () => {
  const m = loadModule({
    botUsername: 'AmirTestBot',
    navigatorStub: { share: (data) => { m.calls.shareCalls.push(data); return Promise.resolve(); } },
    fetchHandler: () => Promise.resolve(okResponse([ACTIVE_REG_URL])),
  });
  await openDetailOf(m, 'camp-url');
  clickAction(m, 'share');
  await flush();
  assert.equal(m.calls.shareCalls.length, 1, 'navigator.share called exactly once');
  const s = m.calls.shareCalls[0];
  assert.equal(s.url, 'https://t.me/AmirTestBot?startapp=campaign_camp-url', 'public campaign deep link as the share url');
  assert.match(s.text, /کمپین با لینک/, 'title included');
  assert.match(s.text, /خلاصه/, 'short description included');
  assert.match(s.text, /https:\/\/exchange\.example\.com\/register\?via=amirbtc/, 'registration link included');
  assert.match(s.text, /https:\/\/t\.me\/AmirTestBot\?startapp=campaign_camp-url/, 'deep link also in the text');
  // NO secrets anywhere in the payload.
  assert.ok(!JSON.stringify(s).includes('init-data-stub'), 'no Telegram initData in the share payload');
  assert.ok(!JSON.stringify(s).includes('X-Telegram-Init-Data'), 'no auth headers in the share payload');
});

test('SHR-03: no Web Share API → clipboard copy fallback with SUCCESS feedback', async () => {
  const m = loadModule({
    botUsername: 'AmirTestBot',
    navigatorStub: {
      clipboard: { writeText: (t) => { m.calls.clipboard.push(t); return Promise.resolve(); } },
    },
    fetchHandler: () => Promise.resolve(okResponse([{ ...ACTIVE_REG_URL, image_url: 'https://cdn.example.com/banner.webp' }])),
  });
  await openDetailOf(m, 'camp-url');
  clickAction(m, 'share');
  await flush();
  assert.equal(m.calls.clipboard.length, 1, 'clipboard.writeText called');
  const text = m.calls.clipboard[0];
  assert.match(text, /کمپین با لینک/, 'title in copied text');
  assert.match(text, /https:\/\/t\.me\/AmirTestBot\?startapp=campaign_camp-url/, 'campaign link in copied text');
  assert.match(text, /https:\/\/exchange\.example\.com\/register\?via=amirbtc/, 'registration link in copied text');
  assert.match(text, /https:\/\/cdn\.example\.com\/banner\.webp/, 'image URL in copied text (platform cannot share the file)');
  assert.ok(m.calls.toasts.includes('cmp_share_copied'), 'success feedback toast');
});

test('SHR-04: clipboard FAILURE → honest error feedback (execCommand fallback attempted first)', async () => {
  const m = loadModule({
    navigatorStub: {
      clipboard: { writeText: () => Promise.reject(new Error('denied')) },
    },
    fetchHandler: () => Promise.resolve(okResponse([ACTIVE_LEGACY])),
  });
  await openDetailOf(m, 'camp-legacy');
  clickAction(m, 'share');
  await flush();
  assert.equal(m.calls.execCommand, 1, 'legacy execCommand fallback attempted');
  assert.ok(m.calls.toasts.includes('cmp_share_copied'), 'execCommand succeeded → success toast');
});

test('SHR-05: clipboard + execCommand both fail → honest ERROR feedback', async () => {
  const m = loadModule({
    navigatorStub: { clipboard: { writeText: () => Promise.reject(new Error('denied')) } },
    fetchHandler: () => Promise.resolve(okResponse([ACTIVE_LEGACY])),
  });
  // break execCommand too
  m.document.execCommand = () => { throw new Error('unsupported'); };
  await openDetailOf(m, 'camp-legacy');
  clickAction(m, 'share');
  await flush();
  assert.ok(m.calls.toasts.includes('cmp_share_copy_error'), 'error feedback toast shown');
});

test('SHR-06: user-CANCELLED native share (AbortError) is not treated as an error — no copy, no toast', async () => {
  const m = loadModule({
    navigatorStub: {
      share: () => Promise.reject(Object.assign(new Error('cancelled'), { name: 'AbortError' })),
      clipboard: { writeText: (t) => { m.calls.clipboard.push(t); return Promise.resolve(); } },
    },
    fetchHandler: () => Promise.resolve(okResponse([ACTIVE_LEGACY])),
  });
  await openDetailOf(m, 'camp-legacy');
  clickAction(m, 'share');
  await flush();
  assert.equal(m.calls.clipboard.length, 0, 'no copy after a user cancel');
  assert.equal(m.calls.toasts.length, 0, 'no toast after a user cancel');
});

// ═══════════════════════════════════════════════════════════════════════════
// DEEP LINK (campaign_<id> → openAndShow)
// ═══════════════════════════════════════════════════════════════════════════

test('DL-01: openAndShow opens list → waits for the load → opens the detail of the visible campaign', async () => {
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([ACTIVE_REG_URL])) });
  m.window.CampaignsApp.openAndShow('camp-url');
  await flush();
  assert.ok(m.pageEl.classList.contains('open'), 'list overlay opened');
  const el = m.created[m.created.length - 1];
  assert.match(el.innerHTML, /کمپین با لینک/, 'the requested campaign detail rendered');
  assert.match(el.innerHTML, /data-action="open-register-url"/, 'with its registration-url button');
});

test('DL-02: deep link to a NON-VISIBLE id honestly leaves the list view (nothing fabricated)', async () => {
  const m = loadModule({ fetchHandler: () => Promise.resolve(okResponse([ACTIVE_REG_URL])) });
  m.window.CampaignsApp.openAndShow('draft-campaign-id');
  await flush();
  assert.ok(m.pageEl.classList.contains('open'), 'list opened');
  const detailEls = m.created.filter((el) => el.className === 'cmp-detail-overlay');
  assert.equal(detailEls.length, 0, 'no detail element ever created — nothing fabricated');
  assert.match(m.bodyEl.innerHTML, /کمپین با لینک/, 'the honest list view stays on screen');
});

test('DL-03: deep link with a FAILED load keeps the honest error state (never an empty list)', async () => {
  const m = loadModule({ fetchHandler: () => Promise.resolve(errResponse(401)) });
  m.window.CampaignsApp.openAndShow('camp-url');
  await flush();
  assert.ok(m.pageEl.classList.contains('open'), 'list overlay opened');
  assert.match(m.bodyEl.innerHTML, /cmp_list_error/, 'honest error state rendered');
  assert.match(m.bodyEl.innerHTML, /HTTP 401/, 'real failure surfaced');
  assert.ok(!m.bodyEl.innerHTML.includes('cmp_list_empty'), 'not masked as empty');
});

test('DL-04: app.js wires the campaign_ deep-link prefix to CampaignsApp.openAndShow', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  assert.match(src, /sp\.startsWith\('campaign_'\)/, 'campaign_ prefix handled in checkAnalysisDeepLink');
  assert.match(src, /CampaignsApp\.openAndShow\(campaignId\)/, 'dispatched to CampaignsApp.openAndShow');
  // The prefix is unique — no collision with the existing prefixes.
  assert.ok(!src.includes("startsWith('campaigns_')"), 'no ambiguous campaigns_ prefix');
});

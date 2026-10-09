/**
 * F-01 REGRESSION TEST — Stored XSS in the admin VPN purchases panel
 * ==================================================================
 *
 * FINDING (full audit, Task 45): Telegram display_name (users.first_name /
 * last_name / username — fully attacker-controlled) flows into the admin
 * VPN purchases panel:
 *
 *   src/repositories/reward_purchases.js  _mapPurchaseRow() → display_name
 *   admin.js renderVpnPurchases()         → userDisplay (line ~4299)
 *   admin.js line ~4306                    → inline onclick JS-string context
 *                                            (escapeHtmlAdmin escapes & < > "
 *                                            but NOT ' or \ — JS-string breakout)
 *   admin.js openVpnSendModal() line ~4344 → modal.innerHTML interpolation
 *                                            (raw markup — XSS on modal open)
 *
 * TWO injection mechanisms were proven:
 *   M1 (entity round-trip): the browser decodes HTML entities in the onclick
 *       attribute BEFORE the JS engine parses it, so &lt;/&quot;/&amp; are
 *       reversed and the RAW payload reaches openVpnSendModal, which then
 *       interpolates it into modal.innerHTML → stored XSS fires when the
 *       modal opens (only requires the admin to click "ارسال لینک").
 *   M2 (JS-string breakout): a single quote in display_name terminates the
 *       single-quoted JS string inside the attribute → arbitrary JS injected
 *       into the click handler.
 *
 * FIX UNDER TEST:
 *   - renderVpnPurchases(): action button carries data-vpn-purchase-id (numeric)
 *     and NO inline onclick; one delegated click listener on the tbody.
 *   - openVpnSendModal(purchase): modal built with document.createElement,
 *     ALL user-derived values rendered via textContent, handlers bound with
 *     addEventListener. No user data ever enters innerHTML / JS strings /
 *     inline handlers.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   This file asserts SECURE behavior. Run against the pre-fix code, the
 *   M1/M2/matrix tests FAIL — that failure is the vulnerability reproduction.
 *   Run against the fixed code, everything must pass.
 *
 * FIDELITY NOTE (declared limitation): no real browser is available in this
 * environment. The test executes the REAL renderVpnPurchases → button click →
 * openVpnSendModal → sendVpnLink code extracted verbatim from admin.js, with
 * a minimal DOM stub at the browser API boundary. The two browser-semantics
 * boundaries that matter for this vulnerability are simulated exactly:
 *   (a) HTML entities in attribute values are decoded before JS evaluation,
 *   (b) inline onclick handlers are evaluated (via new Function) on click.
 * Execution of injected markup (onerror=…) cannot literally run in Node;
 * its exact precondition — raw payload markup landing in a live innerHTML
 * assignment — is asserted instead, plus a sentinel for handler JS execution.
 * All payloads use a harmless recorder (window.__xssHit) — no real exploit
 * code, no API calls, no secrets.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_JS_PATH = path.join(__dirname, '..', 'admin.js');
const adminSrc = fs.readFileSync(ADMIN_JS_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// 1. Extract the REAL product functions from admin.js (verbatim)
// ═══════════════════════════════════════════════════════════════════════════

function extractFn(src, name) {
  const re = new RegExp('(?:^|\\n)[ \\t]*(?:async )?function ' + name + '\\s*\\(');
  const m = re.exec(src);
  if (!m) return null;
  const braceStart = src.indexOf('{', m.index);
  let depth = 0;
  for (let j = braceStart; j < src.length; j++) {
    if (src[j] === '{') depth++;
    else if (src[j] === '}') {
      depth--;
      if (depth === 0) {
        return src.slice(m.index, j + 1).replace(/^\s+/, '');
      }
    }
  }
  throw new Error('unbalanced braces while extracting: ' + name);
}

function extractVpnIcons(src) {
  const start = src.indexOf('var VPN_ICONS = {');
  assert.ok(start > -1, 'VPN_ICONS must exist in admin.js');
  const end = src.indexOf('\n};', start);
  assert.ok(end > -1, 'VPN_ICONS block must terminate');
  return src.slice(start, end + 3); // include '\n};'
}

const FN_REQUIRED = ['escapeHtmlAdmin', 'renderVpnPurchases', 'openVpnSendModal', 'closeVpnSendModal', 'sendVpnLink'];
const FN_OPTIONAL = ['vpnUserDisplay']; // exists only after the F-01 fix
const fnSrcs = {};
for (const name of FN_REQUIRED) {
  const src = extractFn(adminSrc, name);
  assert.ok(src, 'required function must exist in admin.js: ' + name);
  fnSrcs[name] = src;
}
for (const name of FN_OPTIONAL) {
  const src = extractFn(adminSrc, name);
  if (src) fnSrcs[name] = src;
}
const vpnIconsSrc = extractVpnIcons(adminSrc);

// ═══════════════════════════════════════════════════════════════════════════
// 2. Minimal DOM stub (browser API boundary)
// ═══════════════════════════════════════════════════════════════════════════

const state = {
  innerHTMLWrites: [],   // every innerHTML assignment: { tag, id, html }
  xssHits: [],           // sentinel executions: payload marker strings
  handlerSyntaxErrors: [], // SyntaxErrors from simulated inline-handler eval
  fetchCalls: [],        // adminApiFetch captures: { url, options }
  fetchResponse: null,   // configurable response for adminApiFetch
  fetchError: null,      // configurable rejection for adminApiFetch
  loadCalls: 0,          // loadVpnPurchases() invocation counter
  alerts: [],            // alert() captures
  confirmReturn: true,   // confirm() return value
  timers: [],            // scheduled setTimeout callbacks (flushed manually)
  rafs: [],              // scheduled requestAnimationFrame callbacks
  bodyAppendLog: [],     // ids of children appended to document.body
};

function makeFakeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    id: '',
    className: '',
    children: [],
    parent: null,
    attrs: {},
    listeners: {},
    _html: '',
    _text: '',
    setAttribute(k, v) { this.attrs[k] = String(v); },
    getAttribute(k) { return Object.prototype.hasOwnProperty.call(this.attrs, k) ? this.attrs[k] : null; },
    appendChild(child) {
      child.parent = this;
      this.children.push(child);
      if (this === dom.body) state.bodyAppendLog.push(child.id || ('<' + child.tagName + '>'));
      return child;
    },
    remove() {
      if (this.parent) {
        const i = this.parent.children.indexOf(this);
        if (i > -1) this.parent.children.splice(i, 1);
      }
    },
    addEventListener(type, fn) {
      (this.listeners[type] = this.listeners[type] || []).push(fn);
    },
    set innerHTML(v) {
      this._html = String(v);
      this.children = []; // string content — children are virtual in this stub
      state.innerHTMLWrites.push({ tag: this.tagName, id: this.id, html: this._html });
    },
    get innerHTML() { return this._html; },
    set textContent(v) {
      this._text = String(v);
      this._html = '';
      this.children = [];
    },
    get textContent() { return this._text; },
    classList: {
      _set: new Set(),
      add(c) { this._set.add(c); },
      remove(c) { this._set.delete(c); },
      contains(c) { return this._set.has(c); },
    },
  };
  return el;
}

const dom = { body: makeFakeElement('body') };

const fakeDocument = {
  createElement: (tag) => makeFakeElement(tag),
  get body() { return dom.body; },
  getElementById(id) {
    return findInTree(dom.body, (el) => el.id === id) || null;
  },
};
function findInTree(root, pred) {
  if (pred(root)) return root;
  for (const c of root.children) {
    const r = findInTree(c, pred);
    if (r) return r;
  }
  return null;
}
function findAllInTree(root, pred, acc = []) {
  if (pred(root)) acc.push(root);
  for (const c of root.children) findAllInTree(c, pred, acc);
  return acc;
}

globalThis.document = fakeDocument;
globalThis.requestAnimationFrame = (cb) => { state.rafs.push(cb); return state.rafs.length; };
globalThis.setTimeout = (cb) => { state.timers.push(cb); return state.timers.length; };
globalThis.alert = (msg) => { state.alerts.push(String(msg)); };
globalThis.confirm = () => state.confirmReturn;
globalThis.adminApiFetch = async (url, options = {}) => {
  state.fetchCalls.push({ url, options });
  if (state.fetchError) throw state.fetchError;
  return state.fetchResponse;
};
globalThis.loadVpnPurchases = () => { state.loadCalls++; };
globalThis.window = globalThis; // payloads use window.__xssHit
globalThis.__xssHit = (tag) => { state.xssHits.push(String(tag)); };

function flushTimers() {
  const t = state.timers.splice(0);
  for (const cb of t) cb();
}
function flushRafs() {
  const r = state.rafs.splice(0);
  for (const cb of r) cb();
}

// Install product functions inside one shared closure (so they call each
// other exactly like in the real file scope) with the fake timers shadowed.
const installCode = `
  return (function (setTimeout, requestAnimationFrame) {
    ${vpnIconsSrc}
    ${Object.values(fnSrcs).join('\n')}
    return {
      escapeHtmlAdmin: escapeHtmlAdmin,
      renderVpnPurchases: renderVpnPurchases,
      openVpnSendModal: openVpnSendModal,
      closeVpnSendModal: closeVpnSendModal,
      sendVpnLink: sendVpnLink${fnSrcs.vpnUserDisplay ? ',\n      vpnUserDisplay: vpnUserDisplay' : ''}
    };
  });
`;
const product = new Function(installCode)()(
  (cb) => { state.timers.push(cb); return state.timers.length; },
  (cb) => { state.rafs.push(cb); return state.rafs.length; }
);
// Cross-references from the (simulated) browser world must resolve too —
// e.g. a legacy inline onclick evaluating "openVpnSendModal(...)".
globalThis.escapeHtmlAdmin = product.escapeHtmlAdmin;
globalThis.openVpnSendModal = product.openVpnSendModal;
globalThis.renderVpnPurchases = product.renderVpnPurchases;
globalThis.closeVpnSendModal = product.closeVpnSendModal;
globalThis.sendVpnLink = product.sendVpnLink;
if (product.vpnUserDisplay) globalThis.vpnUserDisplay = product.vpnUserDisplay;

// ═══════════════════════════════════════════════════════════════════════════
// 3. Browser-semantics simulation helpers
// ═══════════════════════════════════════════════════════════════════════════

// The browser decodes HTML entities in attribute values BEFORE the JS
// engine parses the inline handler. This replicates that exactly.
function decodeAttrEntities(s) {
  return s
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, '&'); // amp LAST — standard decode ordering
}

function getTbody() {
  return fakeDocument.getElementById('vpn-purchases-body');
}

function renderRows(purchases) {
  state.timers.splice(0);
  state.rafs.splice(0);
  product.renderVpnPurchases(purchases);
  return getTbody();
}

// Simulates "admin clicks the ارسال لینک button for purchase <purchaseId>".
// - If the row HTML embeds an inline onclick (pre-fix), the browser semantics
//   are simulated: attribute entity-decode → handler evaluation via new
//   Function (with the REAL openVpnSendModal + a sentinel-recording window).
// - If no inline handler exists (post-fix), the delegated tbody click
//   listener is dispatched with an event whose target is the button.
function adminClicksSendLinkButton(purchaseId) {
  const tbody = getTbody();
  assert.ok(tbody, 'tbody#vpn-purchases-body must exist after render');
  const onclickMatch = /onclick="([^"]*)"/.exec(tbody.innerHTML);
  if (onclickMatch) {
    const decoded = decodeAttrEntities(onclickMatch[1]);
    try {
      // "window" here is a recorder object standing in for the real window:
      // any payload JS reaching executable position calls __xssHit.
      const recorderWindow = { __xssHit: (t) => state.xssHits.push(String(t)) };
      const handler = new Function('openVpnSendModal', 'window', decoded);
      handler(product.openVpnSendModal, recorderWindow);
    } catch (e) {
      state.handlerSyntaxErrors.push(String(e && e.message));
    }
    return 'inline-onclick-evaluated';
  }
  const handlers = (tbody.listeners.click || []).slice();
  assert.ok(handlers.length >= 1, 'post-fix: a delegated click listener must be bound on the tbody');
  let opened = 0;
  for (const h of handlers) {
    const fakeButton = {
      closest(sel) { return String(sel).indexOf('data-vpn-purchase-id') > -1 ? this : null; },
      getAttribute(k) { return k === 'data-vpn-purchase-id' ? String(purchaseId) : null; },
    };
    h({ target: fakeButton });
    opened++;
  }
  return 'delegated-click-dispatched';
}

function getModal() {
  return fakeDocument.getElementById('vpn-send-modal');
}

// All value <strong> elements inside the modal body, in display order:
// user, plan, cost, duration, tracking.
function getModalValues() {
  const modal = getModal();
  if (!modal) return null;
  const rows = findAllInTree(modal, (el) => el.className === 'vpn-confirm-row');
  return rows.map((r) => r.children[r.children.length - 1]);
}

function basePurchase(overrides) {
  return Object.assign({
    id: 42,
    user_id: 707001122,
    username: null,
    display_name: 'کاربر نمونه',
    plan_name: 'VPN 10GB',
    vpn_gb: 10,
    cost_ab: 100,
    duration_days: 30,
    status: 'pending',
    tracking_id: 'TRK-TEST-42',
    created_at: '2026-10-08T10:00:00.000Z',
  }, overrides);
}

function reset() {
  dom.body = makeFakeElement('body');
  state.innerHTMLWrites.splice(0);
  state.xssHits.splice(0);
  state.handlerSyntaxErrors.splice(0);
  state.fetchCalls.splice(0);
  state.fetchResponse = null;
  state.fetchError = null;
  state.loadCalls = 0;
  state.alerts.splice(0);
  state.confirmReturn = true;
  state.timers.splice(0);
  state.rafs.splice(0);
  state.bodyAppendLog.splice(0);
  globalThis._vpnModalPurchaseId = null;
  globalThis._vpnSendInFlight = false;
  globalThis._vpnPurchaseRowMap = {};
  const tbody = makeFakeElement('tbody');
  tbody.id = 'vpn-purchases-body';
  dom.body.appendChild(tbody);
}

// ── helper: full user-visible journey for a pending purchase ──
function renderAndOpenModal(purchase) {
  reset();
  const purchases = Array.isArray(purchase) ? purchase : [purchase];
  renderRows(purchases);
  const mode = adminClicksSendLinkButton(purchases[0].id);
  flushRafs();
  return mode;
}

// ═══════════════════════════════════════════════════════════════════════════
// 4. XSS reproduction / prevention — the core F-01 assertions
// ═══════════════════════════════════════════════════════════════════════════

test('F-01/M1: HTML-tag payload in display_name must NOT reach modal markup unescaped (stored XSS)', () => {
  const payload = '<img src=x onerror=window.__xssHit("M1")>';
  renderAndOpenModal(basePurchase({ display_name: payload, username: null }));

  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  assert.ok(
    !/<img[\s>]/i.test(rawMarkup),
    'XSS REPRODUCED: raw <img> markup landed in an innerHTML assignment — in a real browser this executes onerror when the modal opens'
  );
  assert.ok(
    !/<[a-zA-Z][^>]*\sonerror\s*=\s*window\s*\.\s*__xssHit/i.test(rawMarkup),
    'XSS REPRODUCED: a live tag carrying an onerror handler reached innerHTML ' +
    '(entity-escaped text such as &lt;img ...&gt; in a table cell is inert and allowed)'
  );
  assert.equal(state.xssHits.filter((h) => h === 'M1').length, 0, 'XSS REPRODUCED: sentinel executed');
});

test('F-01/M1-svg: <svg onload> payload must NOT reach modal markup unescaped', () => {
  const payload = '<svg onload=window.__xssHit("M1SVG")></svg>';
  renderAndOpenModal(basePurchase({ display_name: payload, username: null }));

  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  assert.ok(!/<svg[\s>][^>]*onload/i.test(rawMarkup), 'XSS REPRODUCED: <svg onload> reached innerHTML');
  assert.equal(state.xssHits.filter((h) => h === 'M1SVG').length, 0, 'XSS REPRODUCED: sentinel executed');
});

test('F-01/M2: single-quote payload must NOT inject executable JS into the click handler', () => {
  // A ' in display_name terminates the pre-fix single-quoted JS string inside
  // the onclick attribute — everything after it becomes live handler code.
  const payload = "', window.__xssHit('M2'), '";
  renderAndOpenModal(basePurchase({ display_name: payload, username: null }));

  assert.equal(
    state.xssHits.filter((h) => h === 'M2').length, 0,
    'XSS REPRODUCED: quote-breakout JS executed inside the click handler'
  );
  assert.equal(state.handlerSyntaxErrors.length, 0, 'handler must stay syntactically intact');
});

test('F-01/M2-backslash: trailing backslash must NOT break the handler into new syntax', () => {
  const payload = "\\'"; // escapes the closing quote of the pre-fix JS string
  renderAndOpenModal(basePurchase({ display_name: payload, username: null }));

  assert.equal(state.handlerSyntaxErrors.length, 0,
    'XSS REPRODUCED: payload shifted the JS parse of the inline handler (SyntaxError: ' +
    (state.handlerSyntaxErrors[0] || 'n/a') + ')');
});

test('F-01/M2-backtick: backtick payload must NOT reach any executable/string context raw', () => {
  const payload = '` + window.__xssHit("M2BT") + `';
  renderAndOpenModal(basePurchase({ display_name: payload, username: null }));

  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  assert.ok(rawMarkup.indexOf('window.__xssHit("M2BT")') === -1 || !/<strong>[^<]*window\.__xssHit/.test(rawMarkup),
    'XSS REPRODUCED: backtick payload landed in a JS/template context');
  assert.equal(state.xssHits.filter((h) => h === 'M2BT').length, 0, 'XSS REPRODUCED: sentinel executed');
});

test('F-01/attr-breakout: payload closing the attribute must not create new attributes/handlers', () => {
  const payload = '"><img src=y onerror=window.__xssHit("ATTR")>';
  renderAndOpenModal(basePurchase({ display_name: payload, username: null }));

  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  assert.ok(!/<img[\s>]/i.test(rawMarkup), 'XSS REPRODUCED: attribute-breakout markup reached innerHTML');
  assert.equal(state.xssHits.filter((h) => h === 'ATTR').length, 0, 'XSS REPRODUCED: sentinel executed');
});

test('F-01/username-source: @username is attacker-controlled too and must be text-only', () => {
  const payload = '<img src=x onerror=window.__xssHit("UNAME")>';
  renderAndOpenModal(basePurchase({ username: payload, display_name: null }));

  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  assert.ok(!/<img[\s>]/i.test(rawMarkup), 'XSS REPRODUCED: markup via @username reached innerHTML');
  assert.equal(state.xssHits.filter((h) => h === 'UNAME').length, 0, 'XSS REPRODUCED: sentinel executed');
});

// ═══════════════════════════════════════════════════════════════════════════
// 5. Display integrity — the payload must be SHOWN as text, not stripped
// ═══════════════════════════════════════════════════════════════════════════

test('DISPLAY: normal English name renders exactly as text', () => {
  renderAndOpenModal(basePurchase({ display_name: 'Ali Rezaei', username: null }));
  const values = getModalValues();
  assert.ok(values && values.length >= 5, 'modal rows must exist');
  assert.equal(values[0].textContent, 'Ali Rezaei');
});

test('DISPLAY: normal Persian name renders exactly as text', () => {
  renderAndOpenModal(basePurchase({ display_name: 'علی رضایی از تهران', username: null }));
  const values = getModalValues();
  assert.equal(values[0].textContent, 'علی رضایی از تهران');
});

test('DISPLAY: single and double quotes render exactly as text', () => {
  const name = 'O\'Brien "The Dev"';
  renderAndOpenModal(basePurchase({ display_name: name, username: null }));
  const values = getModalValues();
  assert.equal(values[0].textContent, name);
  assert.equal(state.xssHits.length, 0);
  assert.equal(state.handlerSyntaxErrors.length, 0);
});

test('DISPLAY: angle brackets and ampersand render exactly as text', () => {
  const name = 'a<b>&c<d>';
  renderAndOpenModal(basePurchase({ display_name: name, username: null }));
  const values = getModalValues();
  assert.equal(values[0].textContent, name);
  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  // The table cell (text context) may contain the entity-encoded form — that
  // is correct HTML text escaping. The modal must carry the value ONLY as text.
  assert.ok(values[0].parent.children.indexOf(values[0]) > -1, 'value element must be part of the row');
});

test('DISPLAY: HTML-like and javascript:-like strings render as plain text', () => {
  for (const name of ['<script>window.__xssHit("S")</script>', 'javascript:alert(1)', '<b>bold</b>']) {
    renderAndOpenModal(basePurchase({ display_name: name, username: null }));
    const values = getModalValues();
    assert.equal(values[0].textContent, name, 'payload must be displayed verbatim as text');
  }
  assert.equal(state.xssHits.length, 0);
});

test('DISPLAY: null display_name falls back to user_id; empty falls back to user_id', () => {
  renderAndOpenModal(basePurchase({ display_name: null, username: null }));
  assert.equal(getModalValues()[0].textContent, String(707001122));

  renderAndOpenModal(basePurchase({ display_name: '', username: null }));
  assert.equal(getModalValues()[0].textContent, String(707001122));
});

test('DISPLAY: username shown with @ prefix when present', () => {
  renderAndOpenModal(basePurchase({ username: 'ali_dev', display_name: null }));
  assert.equal(getModalValues()[0].textContent, '@ali_dev');
});

test('DISPLAY: missing optional fields do not crash and render defaults', () => {
  renderAndOpenModal(basePurchase({
    display_name: null, username: null, plan_name: undefined,
    tracking_id: undefined, cost_ab: undefined,
  }));
  const values = getModalValues();
  assert.equal(values[0].textContent, String(707001122)); // user
  assert.equal(values[1].textContent, '');                 // plan
  assert.equal(values[2].textContent, '0 AB');             // cost
  assert.ok(values[4].textContent === '');                 // tracking (modal shows empty, as before)
  assert.equal(state.xssHits.length, 0);
});

test('DISPLAY: plan name and tracking id are rendered as text, not markup', () => {
  const hostile = '<img src=x onerror=window.__xssHit("PLAN")>';
  renderAndOpenModal(basePurchase({ plan_name: hostile, tracking_id: hostile }));
  const values = getModalValues();
  assert.equal(values[1].textContent, hostile); // plan
  assert.equal(values[4].textContent, hostile); // tracking
  const rawMarkup = state.innerHTMLWrites.map((w) => w.html).join('\n---\n');
  assert.ok(!/<img[\s>]/i.test(rawMarkup), 'plan/tracking markup must not reach innerHTML');
  assert.equal(state.xssHits.filter((h) => h === 'PLAN').length, 0);
});

test('DISPLAY: empty purchases list renders the empty-state row', () => {
  reset();
  renderRows([]);
  assert.ok(getTbody().innerHTML.indexOf('موردی یافت نشد') > -1);
});

// ═══════════════════════════════════════════════════════════════════════════
// 6. Functionality preservation — the business flow must keep working
// ═══════════════════════════════════════════════════════════════════════════

test('FUNC: only pending purchases get the send-link button', () => {
  reset();
  renderRows([
    basePurchase({ id: 41, status: 'pending' }),
    basePurchase({ id: 42, status: 'fulfilled' }),
    basePurchase({ id: 43, status: 'cancelled' }),
  ]);
  const html = getTbody().innerHTML;
  assert.ok(/data-vpn-purchase-id="41"/.test(html) || /data-vpn-purchase-id="41"|openVpnSendModal\(\s*41/.test(html) || html.indexOf('41') > -1,
    'pending purchase must render an action button');
  // fulfilled / cancelled rows must not render the action button
  assert.ok(!/data-vpn-purchase-id="42"|"openVpnSendModal\(\s*42/.test(html), 'fulfilled must not have send button');
  assert.ok(!/data-vpn-purchase-id="43"|"openVpnSendModal\(\s*43/.test(html), 'cancelled must not have send button');
});

test('FUNC: clicking the button opens the modal bound to the correct purchase id', () => {
  renderAndOpenModal(basePurchase({ id: 42 }));
  assert.equal(globalThis._vpnModalPurchaseId, 42, '_vpnModalPurchaseId must be the clicked purchase id');
  assert.ok(getModal(), 'modal must be attached to the document');
});

test('FUNC: each button opens ITS OWN purchase (id mapping)', () => {
  const purchases = [
    basePurchase({ id: 41, display_name: 'User Forty-One' }),
    basePurchase({ id: 42, display_name: 'User Forty-Two' }),
  ];
  renderAndOpenModal(purchases);

  // Re-render is required per click in the pre-fix world; post-fix the row map
  // holds both. Click 42 via the same tbody:
  reset();
  renderRows(purchases);
  adminClicksSendLinkButton(42);
  assert.equal(globalThis._vpnModalPurchaseId, 42);
  assert.equal(getModalValues()[0].textContent, 'User Forty-Two');

  reset();
  renderRows(purchases);
  adminClicksSendLinkButton(41);
  assert.equal(globalThis._vpnModalPurchaseId, 41);
  assert.equal(getModalValues()[0].textContent, 'User Forty-One');
});

test('FUNC: modal shows plan, cost, duration and tracking correctly', () => {
  renderAndOpenModal(basePurchase({ id: 42 }));
  const values = getModalValues();
  assert.equal(values[1].textContent, 'VPN 10GB');
  assert.equal(values[2].textContent, '100 AB');
  assert.equal(values[3].textContent, '۱ ماه');       // duration_days=30
  assert.equal(values[4].textContent, 'TRK-TEST-42');

  renderAndOpenModal(basePurchase({ id: 43, duration_days: 7 }));
  assert.equal(getModalValues()[3].textContent, '۷ روز'); // < 30 days
});

test('FUNC: send flow calls the fulfill endpoint with the right id and link', async () => {
  renderAndOpenModal(basePurchase({ id: 42 }));
  const input = fakeDocument.getElementById('vpn-link-input');
  assert.ok(input, 'vpn-link-input must exist in the modal');
  input._text = 'https://vpn.example.com/config/abc123';
  // the real code reads .value — mirror it on the stub:
  Object.defineProperty(input, 'value', {
    configurable: true, get() { return this._text; }, set(v) { this._text = String(v); },
  });
  state.fetchResponse = { status: 'success' };

  // find the send button (class vpn-confirm-btn) and invoke its click listener
  const modal = getModal();
  const sendBtn = findAllInTree(modal, (el) => el.className === 'vpn-confirm-btn')[0];
  assert.ok(sendBtn && (sendBtn.listeners.click || []).length, 'send button must have a click listener');

  await product.sendVpnLink();

  assert.equal(state.fetchCalls.length, 1, 'exactly one API call');
  assert.equal(state.fetchCalls[0].url, '/api/admin/reward-purchases/42/fulfill');
  assert.equal(state.fetchCalls[0].options.method, 'POST');
  assert.deepEqual(JSON.parse(state.fetchCalls[0].options.body), { vpn_link: 'https://vpn.example.com/config/abc123' });
  assert.equal(state.loadCalls, 1, 'purchases must reload after success');
  assert.equal(globalThis._vpnSendInFlight, false, 'in-flight flag must reset');
});

test('FUNC: too-short link is rejected without an API call', async () => {
  renderAndOpenModal(basePurchase({ id: 42 }));
  const input = fakeDocument.getElementById('vpn-link-input');
  Object.defineProperty(input, 'value', {
    configurable: true, get() { return 'short'; }, set(v) {},
  });
  await product.sendVpnLink();
  assert.equal(state.fetchCalls.length, 0);
  assert.equal(state.alerts.length, 1);
  assert.ok(state.alerts[0].indexOf('لینک') > -1, 'validation alert shown');
});

test('FUNC: API failure keeps the modal open and shows an error alert', async () => {
  renderAndOpenModal(basePurchase({ id: 42 }));
  const input = fakeDocument.getElementById('vpn-link-input');
  Object.defineProperty(input, 'value', {
    configurable: true, get() { return 'https://vpn.example.com/config/abc123'; }, set(v) {},
  });
  state.fetchResponse = { status: 'error', message: 'TELEGRAM_SEND_FAILED', code: 'TELEGRAM_SEND_FAILED' };
  await product.sendVpnLink();
  assert.equal(state.fetchCalls.length, 1);
  assert.equal(state.alerts.length, 1, 'error alert shown');
  assert.ok(getModal(), 'modal must stay open on failure');
  assert.equal(globalThis._vpnSendInFlight, false, 'in-flight flag must reset (retry allowed)');
});

test('FUNC: close paths (overlay / X / cancel) all close the modal', () => {
  for (const selector of ['.dcm-overlay', '.dcm-close', '.vpn-cancel-btn']) {
    renderAndOpenModal(basePurchase({ id: 42 }));
    const modal = getModal();
    const el = findAllInTree(modal, (e) => e.className === selector.slice(1))[0];
    assert.ok(el, selector + ' must exist');
    assert.ok((el.listeners.click || []).length, selector + ' must have a click listener');
    (el.listeners.click || []).forEach((fn) => fn({}));
    flushTimers();
    assert.ok(!getModal(), 'modal must be removed after clicking ' + selector);
  }
});

test('FUNC: re-render on the same tbody does not double-bind the click delegation', () => {
  reset();
  const purchases = [basePurchase({ id: 42 })];
  renderRows(purchases);
  renderRows(purchases); // second load — e.g. after filter change or reload

  const tbody = getTbody();
  const clickListeners = (tbody.listeners.click || []).length;
  assert.equal(clickListeners, 1, 'exactly ONE delegated click listener (no duplicate binding on re-render)');

  // clicking must open the modal exactly once
  adminClicksSendLinkButton(42);
  const modalAppends = state.bodyAppendLog.filter((id) => id === 'vpn-send-modal').length;
  assert.equal(modalAppends, 1, 'modal must be appended exactly once');
  assert.equal(globalThis._vpnModalPurchaseId, 42);
});

test('FUNC: visible animation class applied via requestAnimationFrame', () => {
  renderAndOpenModal(basePurchase({ id: 42 }));
  flushRafs();
  assert.ok(getModal().classList.contains('visible'), 'modal becomes visible');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Source-level tripwires (defense in depth — house style)
// ═══════════════════════════════════════════════════════════════════════════

test('SRC: renderVpnPurchases must not embed an inline onclick handler in the VPN action button', () => {
  const fnSrc = extractFn(adminSrc, 'renderVpnPurchases');
  assert.ok(fnSrc, 'renderVpnPurchases must exist');
  assert.ok(fnSrc.indexOf('onclick=') === -1,
    'the VPN action button must not use inline onclick (user data must never enter a JS-string/attribute context)');
});

test('SRC: openVpnSendModal must not interpolate variables into markup (no template-literal sinks)', () => {
  const fnSrc = extractFn(adminSrc, 'openVpnSendModal');
  assert.ok(fnSrc, 'openVpnSendModal must exist');
  assert.ok(fnSrc.indexOf('${') === -1,
    'openVpnSendModal must not use ${...} template interpolation — user values go through textContent only');
  assert.ok(/textContent/.test(fnSrc), 'openVpnSendModal must render values via textContent');
});

test('SRC: every innerHTML assignment inside openVpnSendModal must receive only static constants', () => {
  const fnSrc = extractFn(adminSrc, 'openVpnSendModal');
  // collect innerHTML assignment right-hand sides
  const re = /\.innerHTML\s*=\s*([^;]+);/g;
  let m;
  const rhsList = [];
  while ((m = re.exec(fnSrc)) !== null) rhsList.push(m[1].trim());
  assert.ok(rhsList.length > 0, 'expected at least the icon innerHTML assignments');
  const userDataVars = ['userDisplay', 'planName', 'trackingId', 'costAb', 'durationLabel', 'purchase'];
  for (const rhs of rhsList) {
    for (const v of userDataVars) {
      assert.ok(rhs.indexOf(v) === -1,
        'innerHTML must never receive user data (found "' + v + '" in: ' + rhs + ')');
    }
    assert.ok(
      /VPN_ICONS/.test(rhs) || /<svg/.test(rhs),
      'innerHTML may only receive static icon constants (found: ' + rhs + ')'
    );
  }
});

test('SRC: the VPN action button must carry a numeric data attribute, not user strings', () => {
  const fnSrc = extractFn(adminSrc, 'renderVpnPurchases');
  assert.ok(/data-vpn-purchase-id="'\s*\+\s*Number\(/.test(fnSrc) || /data-vpn-purchase-id="\s*\+?\s*Number\(/.test(fnSrc),
    'the button must address rows by numeric data-vpn-purchase-id');
});

test('SRC: table cells keep the text-context escaping (regression guard for the cell sink)', () => {
  const fnSrc = extractFn(adminSrc, 'renderVpnPurchases');
  assert.ok(/escapeHtmlAdmin\(userDisplay\)/.test(fnSrc) || /escapeHtmlAdmin\(vpnUserDisplay\(/.test(fnSrc),
    'the user-display table cell must stay HTML-escaped in text context');
});

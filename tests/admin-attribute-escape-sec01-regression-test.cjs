/**
 * ADMIN-ATTRIBUTE-ESCAPE REGRESSION TEST — SEC-01
 * ==================================================================
 *
 * FINDING (master audit + Phase 1 revalidation, both CONFIRMED):
 *   adminEscapeHtml (DOM text-node serialization, admin.js) escapes only
 *   & < > — double and single quotes pass through RAW. Six admin edit forms
 *   interpolate DB-stored campaign/ad/template values into double-quoted
 *   value="…" / src="…" attributes through that escaper, so a stored payload
 *   like   x" autofocus onfocus="alert(1)   breaks out of the attribute and
 *   injects new event-handler attributes (stored XSS; write path stores raw,
 *   no HTML sanitization). CSP is Report-Only — no backstop.
 *
 * FIX UNDER TEST:
 *   New adminEscapeAttr helper (escapes & < > " ') applied to every
 *   attribute-value interpolation in the six form builders:
 *     1. campaign     _cmpRenderForm      (alias f → adminEscapeAttr)
 *     2. ad-channel   showAdChannelForm
 *     3. ad-popup     _adsPopupFormHtml
 *     4. ad-message   _adsMessageFormHtml
 *     5. np-template  editNpTemplate
 *     6. wheel-config loadRcWheelConfig
 *
 * TEST PROTOCOL (RED → GREEN):
 *   The REAL form builders are extracted verbatim from admin.js (same
 *   extractFn pattern as admin-vpn-modal-xss-regression-test.cjs) and
 *   executed with a minimal DOM stub. Their emitted HTML is parsed with a
 *   QUOTE-AWARE tokenizer (real attribute semantics, not string greps):
 *     (a) payload containment — the input's value attribute, after entity
 *         decoding, is EXACTLY the hostile payload (a quote breakout would
 *         terminate the attribute early);
 *     (b) structure parity — benign vs hostile renders produce IDENTICAL
 *         tag + attribute-name signatures (an injected autofocus/onfocus/
 *         <img>/<svg> would add entries);
 *     (c) benign preservation — normal text, ampersands, quotes and
 *         Unicode round-trip unchanged.
 *   Run against pre-fix code, these FAIL (the vulnerability reproduction);
 *   against the fixed code, everything must pass.
 *
 * FIDELITY NOTE: no real browser in this environment. The tokenizer
 * reproduces the browser's attribute-tokenization boundary conditions that
 * matter for this bug class: quoted values may contain > and < without
 * terminating the tag, and a raw quote inside a quoted value terminates it.
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

function loadFn(name, deps) {
  const src = extractFn(adminSrc, name);
  assert.ok(src, `required function must exist in admin.js: ${name}`);
  const paramNames = Object.keys(deps);
  const args = paramNames.map(k => deps[k]);
  const factory = new Function(paramNames.join(','), `${src}\nreturn ${name};`);
  return factory(...args);
}

// Escapers + formatters (real source)
// adminEscapeHtml performs DOM text-node serialization (createTextNode →
// innerHTML) — the stub below reproduces the EXACT browser boundary that
// matters for this bug class: text-node serialization escapes ONLY & < >
// (quotes pass through raw). This is the root cause under test, kept faithful.
function makeDomStub() {
  function createTextNode(text) { return { nodeType: 3, _text: String(text) }; }
  function createElement(tag) {
    return {
      nodeType: 1, tagName: String(tag).toUpperCase(), _children: [],
      appendChild(child) { this._children.push(child); return child; },
      get innerHTML() {
        return this._children.map(c =>
          c._text != null
            ? String(c._text).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
            : ''
        ).join('');
      },
      set innerHTML(v) { this._html = String(v); },
    };
  }
  return { createElement, createTextNode };
}
const adminEscapeHtml = loadFn('adminEscapeHtml', { document: makeDomStub() });
// SEC-01 helper — REQUIRED: extraction itself fails on pre-fix code (RED).
const adminEscapeAttr = loadFn('adminEscapeAttr', {});
const adminFormatNumber = loadFn('adminFormatNumber', {});
const adminEscapeJsId = loadFn('adminEscapeJsId', { adminEscapeHtml });

// ═══════════════════════════════════════════════════════════════════════════
// 2. Quote-aware HTML tokenizer (the browser-semantics boundary)
// ═══════════════════════════════════════════════════════════════════════════

/** Parse all tags with attributes; quoted values may contain < and >. */
function parseHtmlTags(html) {
  const tags = [];
  let i = 0;
  while (i < html.length) {
    const lt = html.indexOf('<', i);
    if (lt === -1) break;
    if (html.startsWith('<!--', lt)) {
      const end = html.indexOf('-->', lt);
      i = end === -1 ? html.length : end + 3;
      continue;
    }
    let j = lt + 1;
    if (html[j] === '/') j++;
    const nameStart = j;
    while (j < html.length && /[a-zA-Z0-9-]/.test(html[j])) j++;
    if (j === nameStart) { i = lt + 1; continue; } // stray '<' in text
    const name = html.slice(nameStart, j).toLowerCase();
    const attrs = [];
    while (j < html.length) {
      while (j < html.length && /\s/.test(html[j])) j++;
      if (j >= html.length || html[j] === '>') break;
      if (html[j] === '/' && html[j + 1] === '>') break;
      const ns = j;
      while (j < html.length && !/[\s=<>]/.test(html[j])) j++;
      if (j === ns) { j++; continue; }
      const attrName = html.slice(ns, j).toLowerCase();
      let value = null;
      let k = j;
      while (k < html.length && /\s/.test(html[k])) k++;
      if (html[k] === '=') {
        k++;
        while (k < html.length && /\s/.test(html[k])) k++;
        if (html[k] === '"' || html[k] === "'") {
          const q = html[k];
          k++;
          const vs = k;
          while (k < html.length && html[k] !== q) k++;
          value = html.slice(vs, k);
          k++;
        } else {
          const vs = k;
          while (k < html.length && !/[\s>]/.test(html[k])) k++;
          value = html.slice(vs, k);
        }
        j = k;
      }
      attrs.push({ name: attrName, value });
    }
    const gt = html.indexOf('>', j);
    i = gt === -1 ? html.length : gt + 1;
    tags.push({ tag: name, attrs });
  }
  return tags;
}

function decodeEntities(s) {
  return String(s)
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&lt;/g, '<')
    .replace(/&gt;/g, '>')
    .replace(/&amp;/g, '&');
}

function findTag(tags, tagName, id) {
  return tags.find(t => t.tag === tagName && t.attrs.some(a => a.name === 'id' && a.value === id));
}

function attrValue(tag, name) {
  const a = tag ? tag.attrs.find(x => x.name === name) : null;
  return a ? a.value : null;
}

/** Textarea CONTENT round-trip (RCDATA — not an attribute). */
function textareaContent(html, id) {
  const re = new RegExp('<textarea[^>]*id="' + id + '"[^>]*>([\\s\\S]*?)</textarea>', 'i');
  const m = re.exec(html);
  return m ? decodeEntities(m[1]) : null;
}

/** Structural signature: tag + id + sorted attribute names. */
function structureSignature(html) {
  return parseHtmlTags(html).map(t => {
    const id = attrValue(t, 'id');
    const names = t.attrs.map(a => a.name).sort().join(',');
    return `${t.tag}#${id || ''}[${names}]`;
  });
}

// ═══════════════════════════════════════════════════════════════════════════
// 3. Hostile payloads + benign values (harmless recorders — no real exploits)
// ═══════════════════════════════════════════════════════════════════════════

// Double-quote breakout: terminates value= early, injects attributes.
const P_DQ = 'x" autofocus onfocus="window.__xssHit(1)';
// Element injection attempt inside attribute / textarea content.
const P_ELEM = '"><img src=x onerror=window.__xssHit(2) data-y="';
// Textarea RCDATA breakout: closes the textarea and injects an element.
const P_TA = '</textarea><img src=x onerror=window.__xssHit(3)>';

const BENIGN_TEXT = 'سلام دنیا و متن عادی';
const BENIGN_MIXED = 'Tom & Jerry "quotes" — it\'s fine ✓ Ünïcödé';

// ═══════════════════════════════════════════════════════════════════════════
// 4. Generic six-form safety assertion
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Assert the form builder's escaping for one render pair.
 * @param {object} o
 * @param {string} o.formName    human-readable form name
 * @param {string} o.benignHtml  rendered form with benign data
 * @param {string} o.hostileHtml rendered form with hostile data
 * @param {Array}  o.attrFields  [{ tag, id, attr, payload }] — attribute round-trips
 * @param {Array}  o.textareas   [{ id, payload }] — textarea content round-trips
 */
function assertFormSafe({ formName, benignHtml, hostileHtml, attrFields, textareas = [] }) {
  // (a) Structure parity: hostile render must not create ANY new tag or
  // attribute name vs the benign render (catches injected autofocus,
  // onfocus, <img>, <svg>, onerror, ...).
  const benignSig = structureSignature(benignHtml);
  const hostileSig = structureSignature(hostileHtml);
  assert.deepEqual(
    hostileSig,
    benignSig,
    `${formName}: hostile render must not introduce new tags/attributes.\n` +
    `  benign : ${JSON.stringify(benignSig)}\n` +
    `  hostile: ${JSON.stringify(hostileSig)}`,
  );

  // (b) Dangerous-attribute sweep (belt and suspenders on top of parity).
  for (const t of parseHtmlTags(hostileHtml)) {
    for (const a of t.attrs) {
      if (/^on/.test(a.name)) {
        assert.ok(
          !(a.value && a.value.includes('__xssHit')),
          `${formName}: event handler attribute <${t.tag} ${a.name}> must never carry payload content`,
        );
      }
    }
    assert.notEqual(a0(t), 'autofocus', `${formName}: autofocus attribute must never be injected`);
    function a0(tag) { return tag.attrs.some(x => x.name === 'autofocus') ? 'autofocus' : null; }
  }

  // (c) Attribute containment: decoded value === full payload.
  const hostileTags = parseHtmlTags(hostileHtml);
  for (const { tag, id, attr, payload } of attrFields) {
    const el = findTag(hostileTags, tag, id);
    assert.ok(el, `${formName}: <${tag} id="${id}"> must exist in the hostile render`);
    const raw = attrValue(el, attr);
    assert.ok(raw !== null, `${formName}: <${tag} id="${id}"> must have a ${attr} attribute`);
    assert.equal(
      decodeEntities(raw),
      payload,
      `${formName}: payload must remain INSIDE ${attr} of #${id} (entity-decoded value must equal the payload exactly)`,
    );
  }

  // (d) Textarea containment: decoded content === full payload.
  for (const { id, payload } of textareas) {
    const content = textareaContent(hostileHtml, id);
    assert.ok(content !== null, `${formName}: <textarea id="${id}"> must exist in the hostile render`);
    assert.equal(
      content,
      payload,
      `${formName}: payload must stay inert text inside textarea #${id}`,
    );
  }
}

/** Benign round-trip: value decodes back to the exact benign string. */
function assertBenignValue(html, formName, tag, id, attr, expected) {
  const el = findTag(parseHtmlTags(html), tag, id);
  assert.ok(el, `${formName}: <${tag} id="${id}"> must exist in the benign render`);
  assert.equal(decodeEntities(attrValue(el, attr)), expected,
    `${formName}: benign value of #${id} must round-trip exactly`);
}

// ═══════════════════════════════════════════════════════════════════════════
// 5. Minimal DOM stub
// ═══════════════════════════════════════════════════════════════════════════

function makeEl(id) {
  return {
    id,
    tagName: 'DIV',
    style: { display: '' },
    attrs: {},
    setAttribute(k, v) { this.attrs[k] = String(v); },
    classList: { add() {}, remove() {}, contains() { return false; } },
    _html: '',
    set innerHTML(v) { this._html = String(v); },
    get innerHTML() { return this._html; },
  };
}

function makeDoc(elements) {
  return { getElementById: (id) => elements[id] || null };
}

// Shared translation / icon stubs (static text — irrelevant to escaping).
const tStub = (k) => k;
const CMP_ICONS_STUB = { basic: '', schedule: '', image: '', link: '', publish: '' };
const adsIconStub = () => '';

// ═══════════════════════════════════════════════════════════════════════════
// 6. adminEscapeAttr unit matrix (RED on pre-fix code — helper missing)
// ═══════════════════════════════════════════════════════════════════════════

test('SEC01-ATTR-01: adminEscapeAttr escapes all five HTML-special characters', () => {
  assert.equal(adminEscapeAttr('<a href="x">&\''), '&lt;a href=&quot;x&quot;&gt;&amp;&#39;');
  assert.equal(adminEscapeAttr('plain text 123'), 'plain text 123');
  // Unicode passes through untouched (no double-encoding).
  assert.equal(adminEscapeAttr(BENIGN_TEXT), BENIGN_TEXT);
  assert.equal(adminEscapeAttr(BENIGN_MIXED), 'Tom &amp; Jerry &quot;quotes&quot; — it&#39;s fine ✓ Ünïcödé');
  // Falsy handling matches the sibling escapers' contract.
  assert.equal(adminEscapeAttr(''), '');
  assert.equal(adminEscapeAttr(null), '');
  assert.equal(adminEscapeAttr(undefined), '');
  // Repeated application is stable (idempotent on already-escaped &).
  assert.equal(adminEscapeAttr('&amp;'), '&amp;amp;');
});

test('SEC01-ATTR-02: adminEscapeHtml semantics preserved (text-context escaper untouched)', () => {
  // Regression guard: SEC-01 must NOT have altered the shared text escaper
  // (hundreds of call sites rely on it; SEC-15 is a separate finding).
  const src = extractFn(adminSrc, 'adminEscapeHtml');
  assert.ok(src.includes('document.createElement'), 'adminEscapeHtml must keep DOM text-node serialization');
  assert.ok(!/replace\(/.test(src.replace(/\/\/[^\n]*/g, '')), 'adminEscapeHtml must stay a pure DOM serializer');
});

// ═══════════════════════════════════════════════════════════════════════════
// 7. Form 1 — campaign edit form (_cmpRenderForm, alias f)
// ═══════════════════════════════════════════════════════════════════════════

function renderCampaignForm(c) {
  const box = makeEl('cmp-form-card');
  const fn = loadFn('_cmpRenderForm', {
    adminEscapeHtml,
    adminEscapeAttr,
    t: tStub,
    CMP_ICONS: CMP_ICONS_STUB,
    _cmpPanelLang: () => 'fa',
    _cmpToLocalInput: (v) => String(v || ''),
    _cmpAdminImgUrl: (v) => String(v || ''),
  });
  fn(box, c);
  return box.innerHTML;
}

test('SEC01-ATTR-03: campaign edit form — payload containment + structure parity', () => {
  const benign = renderCampaignForm({
    title_fa: BENIGN_TEXT, title_en: 'Special Campaign',
    summary_fa: 'خلاصه & متن', summary_en: 'Summary & "quotes"',
    body_fa: 'متن کامل', body_en: 'Body with & chars',
    starts_at: '2026-10-20T12:00', ends_at: '2026-10-27T12:00',
    image_url: 'https://cdn.example.com/a.webp?x=1&y=2',
    registration_url: 'https://t.me/amirbtc?start=ref_123',
  });
  const hostile = renderCampaignForm({
    title_fa: P_DQ, title_en: P_ELEM,
    summary_fa: P_DQ, summary_en: P_ELEM,
    body_fa: P_TA, body_en: P_DQ,
    starts_at: '2026-10-20T12:00"X', ends_at: '2026-10-27T12:00"Y',
    image_url: P_ELEM,
    registration_url: P_DQ,
  });

  assertFormSafe({
    formName: 'campaign form (_cmpRenderForm)',
    benignHtml: benign,
    hostileHtml: hostile,
    attrFields: [
      { tag: 'input', id: 'cmp-f-title', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'cmp-f-summary', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'cmp-f-starts', attr: 'value', payload: '2026-10-20T12:00"X' },
      { tag: 'input', id: 'cmp-f-ends', attr: 'value', payload: '2026-10-27T12:00"Y' },
      { tag: 'img', id: 'cmp-f-image-preview', attr: 'src', payload: P_ELEM },
      { tag: 'input', id: 'cmp-f-image-url', attr: 'value', payload: P_ELEM },
      { tag: 'input', id: 'cmp-f-reg-url', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'cmp-f-tr-title', attr: 'value', payload: P_ELEM },
      { tag: 'input', id: 'cmp-f-tr-summary', attr: 'value', payload: P_ELEM },
    ],
    textareas: [
      { id: 'cmp-f-body', payload: P_TA },
      { id: 'cmp-f-tr-body', payload: P_DQ },
    ],
  });

  // Benign preservation: unicode, ampersand and mixed quotes round-trip.
  assertBenignValue(benign, 'campaign form', 'input', 'cmp-f-title', 'value', BENIGN_TEXT);
  assertBenignValue(benign, 'campaign form', 'input', 'cmp-f-tr-title', 'value', 'Special Campaign');
  assertBenignValue(benign, 'campaign form', 'input', 'cmp-f-summary', 'value', 'خلاصه & متن');
  assertBenignValue(benign, 'campaign form', 'input', 'cmp-f-reg-url', 'value', 'https://t.me/amirbtc?start=ref_123');
});

// ═══════════════════════════════════════════════════════════════════════════
// 8. Form 2 — ad-channel edit form (showAdChannelForm)
// ═══════════════════════════════════════════════════════════════════════════

function renderAdChannelForm(ch) {
  const form = makeEl('ads-channel-form');
  const cache = [ch];
  const fn = loadFn('showAdChannelForm', {
    document: makeDoc({ 'ads-channel-form': form }),
    _adsChannelCache: cache,
    _adsIcon: adsIconStub,
    adminToast: () => {},
    adminEscapeHtml,
    adminEscapeAttr,
    adminFormatNumber,
    adminEscapeJsId,
  });
  fn(String(ch.id));
  return form.innerHTML;
}

test('SEC01-ATTR-04: ad-channel edit form — payload containment + structure parity', () => {
  const benign = renderAdChannelForm({
    id: 7, channel_username: 'amirbtc', channel_title: 'کانال امیر بیت‌کوین',
    join_url: 'https://t.me/amirbtc?x=1&y=2', display_order: 3,
    is_active: true, status: 'active', campaign_status: 'active',
  });
  const hostile = renderAdChannelForm({
    id: 7, channel_username: P_DQ, channel_title: P_ELEM,
    join_url: P_DQ, display_order: 3,
    is_active: true, status: 'active', campaign_status: 'active',
  });

  assertFormSafe({
    formName: 'ad-channel form (showAdChannelForm)',
    benignHtml: benign,
    hostileHtml: hostile,
    attrFields: [
      { tag: 'input', id: 'ads-ch-username', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'ads-ch-title', attr: 'value', payload: P_ELEM },
      { tag: 'input', id: 'ads-ch-joinurl', attr: 'value', payload: P_DQ },
    ],
  });

  assertBenignValue(benign, 'ad-channel form', 'input', 'ads-ch-title', 'value', 'کانال امیر بیت‌کوین');
  assertBenignValue(benign, 'ad-channel form', 'input', 'ads-ch-joinurl', 'value', 'https://t.me/amirbtc?x=1&y=2');
});

// ═══════════════════════════════════════════════════════════════════════════
// 9. Form 3 — ad-popup form (_adsPopupFormHtml)
// ═══════════════════════════════════════════════════════════════════════════

function renderAdPopupForm(p) {
  const fn = loadFn('_adsPopupFormHtml', {
    adminEscapeHtml,
    adminEscapeAttr,
    adminEscapeJsId,
    adminFormatNumber,
    _formatCooldownHuman: () => '',
    _adsIcon: adsIconStub,
  });
  return fn(p);
}

test('SEC01-ATTR-05: ad-popup form — payload containment + structure parity', () => {
  const benign = renderAdPopupForm({
    id: 5, title: BENIGN_TEXT, body_text: 'متن پیام عادی',
    button_label: 'مشاهده', button_url: 'https://example.com/a?b=1&c=2',
    image_url: 'https://cdn.example.com/p.webp', display_order: 2,
    cooldown_seconds: 86400, is_active: true, status: 'active', campaign_status: 'active',
  });
  const hostile = renderAdPopupForm({
    id: 5, title: P_DQ, body_text: P_TA,
    button_label: P_ELEM, button_url: P_DQ,
    image_url: P_ELEM, display_order: 2,
    cooldown_seconds: 86400, is_active: true, status: 'active', campaign_status: 'active',
  });

  assertFormSafe({
    formName: 'ad-popup form (_adsPopupFormHtml)',
    benignHtml: benign,
    hostileHtml: hostile,
    attrFields: [
      { tag: 'input', id: 'ads-pp-title', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'ads-pp-btnlabel', attr: 'value', payload: P_ELEM },
      { tag: 'input', id: 'ads-pp-btnurl', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'ads-pp-imgurl', attr: 'value', payload: P_ELEM },
      { tag: 'img', id: 'ads-pp-preview', attr: 'src', payload: P_ELEM },
    ],
    textareas: [{ id: 'ads-pp-body', payload: P_TA }],
  });

  assertBenignValue(benign, 'ad-popup form', 'input', 'ads-pp-title', 'value', BENIGN_TEXT);
  assertBenignValue(benign, 'ad-popup form', 'input', 'ads-pp-btnurl', 'value', 'https://example.com/a?b=1&c=2');
});

// ═══════════════════════════════════════════════════════════════════════════
// 10. Form 4 — ad-message form (_adsMessageFormHtml)
// ═══════════════════════════════════════════════════════════════════════════

function renderAdMessageForm(m) {
  const fn = loadFn('_adsMessageFormHtml', {
    adminEscapeHtml,
    adminEscapeAttr,
    adminEscapeJsId,
    _adsIcon: adsIconStub,
  });
  return fn(m);
}

test('SEC01-ATTR-06: ad-message form — payload containment + structure parity', () => {
  const benign = renderAdMessageForm({
    id: 9, title: BENIGN_TEXT, body_text: 'متن پیام عادی',
    button_label: 'مشاهده', button_url: 'https://example.com/m?x=1',
    image_url: 'https://cdn.example.com/m.webp', destinations: 'both',
    target_audience: 'all', is_active: true, status: 'active', campaign_status: 'active',
  });
  const hostile = renderAdMessageForm({
    id: 9, title: P_DQ, body_text: P_TA,
    button_label: P_ELEM, button_url: P_DQ,
    image_url: P_ELEM, destinations: 'both',
    target_audience: 'all', is_active: true, status: 'active', campaign_status: 'active',
  });

  assertFormSafe({
    formName: 'ad-message form (_adsMessageFormHtml)',
    benignHtml: benign,
    hostileHtml: hostile,
    attrFields: [
      { tag: 'input', id: 'ads-msg-title', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'ads-msg-btnlabel', attr: 'value', payload: P_ELEM },
      { tag: 'input', id: 'ads-msg-btnurl', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'ads-msg-imgurl', attr: 'value', payload: P_ELEM },
      { tag: 'img', id: 'ads-msg-preview', attr: 'src', payload: P_ELEM },
    ],
    textareas: [{ id: 'ads-msg-body', payload: P_TA }],
  });

  assertBenignValue(benign, 'ad-message form', 'input', 'ads-msg-title', 'value', BENIGN_TEXT);
});

// ═══════════════════════════════════════════════════════════════════════════
// 11. Form 5 — notification-template edit form (editNpTemplate)
// ═══════════════════════════════════════════════════════════════════════════

function renderNpTemplateForm(tpl) {
  const section = makeEl('np-templates-section');
  const fn = loadFn('editNpTemplate', {
    document: makeDoc({ 'np-templates-section': section }),
    _npTemplateCache: [tpl],
    adminToast: () => {},
    t: tStub,
    adminEscapeHtml,
    adminEscapeAttr,
    adminEscapeJsId,
  });
  fn(String(tpl.id));
  return section.innerHTML;
}

test('SEC01-ATTR-07: np-template edit form — payload containment + structure parity', () => {
  const benign = renderNpTemplateForm({
    id: 3, key: 'wheel_reward', category: 'system', priority: 'medium',
    channel: 'both', title: BENIGN_TEXT, message: 'قالب پیام عادی', is_active: true,
  });
  const hostile = renderNpTemplateForm({
    id: 3, key: 'wheel_reward', category: P_DQ, priority: 'medium',
    channel: 'both', title: P_ELEM, message: P_TA, is_active: true,
  });

  assertFormSafe({
    formName: 'np-template form (editNpTemplate)',
    benignHtml: benign,
    hostileHtml: hostile,
    attrFields: [
      { tag: 'input', id: 'np-tpl-category', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'np-tpl-title', attr: 'value', payload: P_ELEM },
    ],
    textareas: [{ id: 'np-tpl-message', payload: P_TA }],
  });

  assertBenignValue(benign, 'np-template form', 'input', 'np-tpl-title', 'value', BENIGN_TEXT);
});

// ═══════════════════════════════════════════════════════════════════════════
// 12. Form 6 — wheel-config form (loadRcWheelConfig, async)
// ═══════════════════════════════════════════════════════════════════════════

async function renderWheelConfigForm(config) {
  const section = makeEl('rc-wheel-config-section');
  let rcWheelConfig = null;
  const fn = loadFn('loadRcWheelConfig', {
    document: makeDoc({ 'rc-wheel-config-section': section }),
    t: tStub,
    _adminLoadToken: null,
    adminApiFetch: async () => ({ status: 'success', config }),
    _isLoadTokenStale: () => false,
    adminEscapeHtml,
    adminEscapeAttr,
    get _rcWheelConfig() { return rcWheelConfig; },
    set _rcWheelConfig(v) { rcWheelConfig = v; },
  });
  await fn();
  return section.innerHTML;
}

test('SEC01-ATTR-08: wheel-config form — payload containment + structure parity', async () => {
  const base = {
    is_enabled: true, daily_spin_enabled: true, referral_spin_enabled: true,
    mission_spin_enabled: true, premium_spin_enabled: true, campaign_spin_enabled: true,
    maintenance_mode: false, segment_count: 8, max_spins_per_user: 3,
    max_reward_per_day: 1000,
  };
  const benign = await renderWheelConfigForm({ ...base, version: '1.0.0', theme: 'default' });
  const hostile = await renderWheelConfigForm({ ...base, version: P_DQ, theme: P_ELEM });

  assertFormSafe({
    formName: 'wheel-config form (loadRcWheelConfig)',
    benignHtml: benign,
    hostileHtml: hostile,
    attrFields: [
      { tag: 'input', id: 'rc-wc-version', attr: 'value', payload: P_DQ },
      { tag: 'input', id: 'rc-wc-theme', attr: 'value', payload: P_ELEM },
    ],
  });

  assertBenignValue(benign, 'wheel-config form', 'input', 'rc-wc-version', 'value', '1.0.0');
  assertBenignValue(benign, 'wheel-config form', 'input', 'rc-wc-theme', 'value', 'default');
});

/**
 * ADMIN ADS LIST THUMBNAIL ESCAPE REGRESSION TEST — SEC-01b (Phase 4)
 * ==================================================================
 *
 * FINDING (Phase 3 independent review, CONFIRMED High, pre-existing —
 * same class as SEC-01, NOT introduced by commit 4afe62e4):
 *   admin.js:3432 _adsItemCard renders the LIST-view thumbnail as
 *       <img class="ads-item-thumb" src="' + adminEscapeHtml(opts.thumbnail) + '">
 *   adminEscapeHtml is DOM text-node serialization → escapes ONLY & < > —
 *   double quotes pass through RAW. Stored ad image_url values are
 *   quote-bearing URLs that the REAL server validator accepts:
 *
 *     isValidExternalImageUrl (src/repositories/advertisements.js:65-93)
 *       checks scheme/host/TLD/userinfo/path-extension — quotes are LEGAL
 *       URL characters, so new URL() accepts them. When the LAST '.' in
 *       u.pathname lands on an allowed extension (or the quote hides in
 *       the query string), the payload is VALID and stored VERBATIM
 *       (repositories/advertisements.js:532/570 popups, 684/722 messages).
 *
 *   Both admin LIST views feed stored image_url straight into the card:
 *       popups  LIST  admin.js:3864-3869   thumbnail: p.image_url || null
 *       messages LIST  admin.js:4126-4131   thumbnail: m.image_url || null
 *   → the raw '"' terminates the src attribute early and the remainder
 *     becomes live injected attributes (onerror/onfocus handlers) —
 *     stored XSS executing in every admin's panel on LIST render.
 *
 * FIX UNDER TEST (Phase 4, minimal one-token change):
 *   admin.js:3432 uses adminEscapeAttr (SEC-01 helper, escapes & < > " ')
 *   instead of adminEscapeHtml for the thumbnail src attribute value.
 *   Server-side validation is intentionally NOT changed: the sink fix is
 *   complete for the confirmed attack path, and rejecting quote-bearing
 *   URLs server-side would risk breaking legitimate URL forms.
 *
 * TEST PROTOCOL (RED → GREEN):
 *   The REAL _adsItemCard is extracted verbatim from admin.js (same
 *   extractFn pattern as admin-attribute-escape-sec01-regression-test.cjs)
 *   and driven with the EXACT opts construction of both LIST call sites.
 *   The REAL isValidImageUrl is loaded from the real repository module
 *   (esbuild, same pattern as campaigns-admin-api-contract-test.cjs) and
 *   each hostile payload is PROVEN to pass server validation first — so a
 *   green assertion here means: "this exact URL is storable in production
 *   AND cannot break out of the thumbnail attribute". Emitted HTML is
 *   parsed with the QUOTE-AWARE tokenizer (real attribute semantics).
 *
 *   Pre-fix (4afe62e4): ADS-LIST-THUMB-01/02 FAIL (payload not contained;
 *   onfocus/onerror attributes injected) — the RED half of the proof.
 *   Post-fix: both PASS.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const ADMIN_JS_PATH = path.join(ROOT, 'admin.js');
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

// adminEscapeHtml performs DOM text-node serialization (createTextNode →
// innerHTML). The stub reproduces the EXACT browser boundary that is the
// root cause of this bug class: text-node serialization escapes ONLY
// & < > (quotes pass through raw). Kept faithful on purpose.
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
// SEC-01 helper (present since Phase 2; the Phase 4 fix applies it here).
const adminEscapeAttr = loadFn('adminEscapeAttr', {});
// Icon helper is orthogonal to this bug (fixed dictionary lookup keyed by
// call-site literals) — stubbed to empty, exactly like the Phase 2 test.
const adsIconStub = () => '';

// The function under test — the REAL _adsItemCard (admin.js:3426-3451).
// Both escapers are injected so the extraction runs pre-fix (uses
// adminEscapeHtml → RED) and post-fix (uses adminEscapeAttr → GREEN).
const _adsItemCard = loadFn('_adsItemCard', {
  adminEscapeHtml,
  adminEscapeAttr,
  _adsIcon: adsIconStub,
});

// ═══════════════════════════════════════════════════════════════════════════
// 2. REAL server-side validator (attack-path reachability proof)
// ═══════════════════════════════════════════════════════════════════════════

// ESM → CJS via esbuild, for the multi-export advertisements.js validators
// (same pattern as campaigns-admin-api-contract-test.cjs).
function loadEsmExports(filePath) {
  const esbuild = require('esbuild');
  const out = esbuild.transformSync(fs.readFileSync(path.join(ROOT, filePath), 'utf8'), { loader: 'js', format: 'cjs' });
  const mod = { exports: {} };
  new Function('module', 'exports', 'require', out.code)(mod, mod.exports, require);
  return mod.exports;
}
const { isValidImageUrl } = loadEsmExports('src/repositories/advertisements.js');

// ═══════════════════════════════════════════════════════════════════════════
// 3. Quote-aware HTML tokenizer (the browser-semantics boundary)
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

function attrValue(tag, name) {
  const a = tag ? tag.attrs.find(x => x.name === name) : null;
  return a ? a.value : null;
}

function findThumbTag(html) {
  return parseHtmlTags(html).find(
    t => t.tag === 'img' && t.attrs.some(a => a.name === 'class' && a.value === 'ads-item-thumb')
  );
}

/** Structural signature: tag + sorted attribute names (no values). */
function cardSignature(html) {
  return parseHtmlTags(html)
    .map(t => `${t.tag}[${t.attrs.map(a => a.name).sort().join(',')}]`)
    .join('|');
}

// Attributes that must NEVER appear from thumbnail interpolation.
const DANGEROUS_ATTRS = [
  'onerror', 'onload', 'onfocus', 'onblur', 'onclick', 'ondblclick',
  'onmouseenter', 'onmouseover', 'onanimationstart', 'ontoggle',
  'autofocus', 'srcdoc', 'formaction', 'xlink:href',
];

// ═══════════════════════════════════════════════════════════════════════════
// 4. Hostile payloads + benign URLs (harmless recorders — no real exploits)
// ═══════════════════════════════════════════════════════════════════════════

// Both payloads PASS the real server validator (asserted in the tests):
//   P_FOCUS — quote breakout hidden in the QUERY string; the path keeps a
//             clean .png extension, so the extension check passes.
//   P_ERROR — trailing "//.png": the last path dot lands on an allowed
//             extension; the JS line-comment keeps the injected handler
//             syntactically valid when the closing quote appends ".png".
const P_FOCUS = 'https://cdn.example.com/promo.png?q=" autofocus onfocus="window.__xssHit(1)';
const P_ERROR = 'https://cdn.example.com/x" onerror="window.__xssHit(2)//.png';

// Legitimate storable image_url values (all pass isValidImageUrl) that must
// keep rendering EXACTLY as-is after the fix (no valid URL broken).
const BENIGN_URLS = [
  'https://cdn.example.com/img.png',
  'https://cdn.example.com/img.png?v=2&x=y&lang=fa',
  '/api/advertisements/image/AbCdEfGh12345678',
  'https://cdn.example.com/تصویر-۱.png',
  "https://example.com/it's-fine.png",
];

// ═══════════════════════════════════════════════════════════════════════════
// 5. LIST call-site simulators (admin.js:3850-3872 / 4106-4134)
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Popups LIST card — replicates the exact opts construction of the popups
 * list view (loadAdPopups → _popupsSrc.map, admin.js:3850-3872): the title
 * is escaped at the call site, and thumbnail is the RAW stored image_url.
 */
function renderPopupListCard(p) {
  return _adsItemCard({
    titleIcon: 'layout',
    title: p.title ? adminEscapeHtml(p.title) : '—',
    subtitle: '<span class="ads-meta-tag muted ltr">#' + adminEscapeHtml(p.id) + '</span>',
    statusBadge: '<span class="admin-badge admin-badge-green">' + adminEscapeHtml(p.campaign_status || p.status || 'active') + '</span>',
    thumbnail: p.image_url || null,
    metaParts: [
      '<span class="ads-meta-tag">کوئل‌داون: ' + adminEscapeHtml('۲۴ ساعت') + '</span>',
      '<span class="ads-meta-tag muted">آخرین تغییر: ' + adminEscapeHtml(p.updated_at || '—') + '</span>',
    ],
    actions: '<button class="adm-btn-sm" onclick="showAdPopupForm(\'' + adminEscapeHtml(String(p.id)) + '\')">ویرایش</button>',
  });
}

/**
 * Messages LIST card — replicates the exact opts construction of the
 * messages list view (loadAdMessages → _messagesSrc.map, admin.js:4106-4134).
 */
function renderMessageListCard(m) {
  return _adsItemCard({
    titleIcon: 'mail',
    title: m.title ? adminEscapeHtml(m.title) : '—',
    subtitle: '<span class="ads-meta-tag muted ltr">#' + adminEscapeHtml(m.id) + '</span>',
    statusBadge: '<span class="admin-badge admin-badge-blue">' + adminEscapeHtml(m.campaign_status || m.status || 'active') + '</span>',
    thumbnail: m.image_url || null,
    metaParts: [
      '<span class="ads-meta-tag">' + adminEscapeHtml('مینی‌اپ + تلگرام') + '</span>',
      '<span class="ads-meta-tag">' + adminEscapeHtml('همه') + '</span>',
      '<span class="ads-meta-tag muted">' + adminEscapeHtml(m.created_at || '—') + '</span>',
    ],
    actions: '<button class="adm-btn-sm" onclick="sendAdMessage(\'' + adminEscapeHtml(String(m.id)) + '\')">ارسال</button>',
  });
}

// Shared assertion core for one LIST render pair.
function assertListCardSafe({ viewName, hostileHtml, benignHtml, payload }) {
  const thumb = findThumbTag(hostileHtml);
  assert.ok(thumb, `${viewName}: thumbnail <img class="ads-item-thumb"> must be rendered for a stored image_url`);

  // (a) Payload containment — the src attribute, after entity decoding,
  //     must be EXACTLY the stored payload (a quote breakout would
  //     terminate the attribute early).
  const src = attrValue(thumb, 'src');
  assert.ok(src != null, `${viewName}: thumbnail img must carry a src attribute`);
  assert.equal(
    decodeEntities(src), payload,
    `${viewName}: stored image_url must be fully contained in src (early termination = attribute breakout)`
  );

  // (b) No injected event-handler / focus / URL-attr attributes on the img.
  const attrNames = thumb.attrs.map(a => a.name);
  for (const dangerous of DANGEROUS_ATTRS) {
    assert.ok(
      !attrNames.includes(dangerous),
      `${viewName}: injected attribute "${dangerous}" must never appear on the thumbnail img`
    );
  }
  assert.deepEqual(
    attrNames.slice().sort(), ['alt', 'class', 'src'],
    `${viewName}: thumbnail img must expose exactly class/src/alt — no injected attributes`
  );

  // (c) Structure parity — hostile render must not create any new tag or
  //     attribute name vs the benign render (catches any injection shape).
  assert.equal(
    cardSignature(hostileHtml), cardSignature(benignHtml),
    `${viewName}: hostile and benign renders must have identical tag/attribute structure`
  );
}

// ═══════════════════════════════════════════════════════════════════════════
// 6. Regression tests
// ═══════════════════════════════════════════════════════════════════════════

test('ADS-LIST-THUMB-01: popups LIST view — quote-bearing stored image_url cannot break out of the thumbnail src attribute', () => {
  // Attack-path reachability FIRST: this exact payload passes the REAL
  // server-side validator, i.e. it is storable in production via
  // POST/PUT /api/admin/advertisements/popups (ads.manage-gated).
  assert.equal(isValidImageUrl(P_FOCUS), true,
    'payload must pass the real isValidImageUrl (server accepts quote-bearing URLs — attack path reachable)');
  assert.ok(P_FOCUS.includes('"'), 'payload must carry the raw double-quote breakout character');

  // The popups LIST render pair (admin.js:3850-3872 construction).
  const benign = renderPopupListCard({
    id: 'adp_demo1', title: 'پاپ‌آپ ویژه', campaign_status: 'active',
    image_url: 'https://cdn.example.com/promo.png?q=regular',
    updated_at: '2026-10-17T09:00:00Z',
  });
  const hostile = renderPopupListCard({
    id: 'adp_demo1', title: 'پاپ‌آپ ویژه', campaign_status: 'active',
    image_url: P_FOCUS,
    updated_at: '2026-10-17T09:00:00Z',
  });

  assertListCardSafe({
    viewName: 'popups LIST view',
    hostileHtml: hostile,
    benignHtml: benign,
    payload: P_FOCUS,
  });
});

test('ADS-LIST-THUMB-02: messages LIST view — attack blocked AND every legitimate stored image_url renders unchanged', () => {
  // Attack-path reachability: same proof for the message payload shape.
  assert.equal(isValidImageUrl(P_ERROR), true,
    'payload must pass the real isValidImageUrl (trailing-extension bypass — attack path reachable)');
  assert.ok(P_ERROR.includes('"'), 'payload must carry the raw double-quote breakout character');

  const hostile = renderMessageListCard({
    id: 'adm_demo2', title: 'پیام کمپین', campaign_status: 'active',
    image_url: P_ERROR, created_at: '2026-10-17T10:30:00Z',
  });
  const benign = renderMessageListCard({
    id: 'adm_demo2', title: 'پیام کمپین', campaign_status: 'active',
    image_url: 'https://cdn.example.com/msg.png?v=1',
    created_at: '2026-10-17T10:30:00Z',
  });

  assertListCardSafe({
    viewName: 'messages LIST view',
    hostileHtml: hostile,
    benignHtml: benign,
    payload: P_ERROR,
  });

  // Benign preservation — no valid URL broken by the fix: every legitimate
  // storable image_url (server-accepted, asserted) must round-trip through
  // the src attribute EXACTLY after entity decoding, exactly like a real
  // browser decodes attribute values before fetching.
  for (const url of BENIGN_URLS) {
    assert.equal(isValidImageUrl(url), true, `benign URL must be server-accepted: ${url}`);
    const html = renderMessageListCard({
      id: 'adm_demo2', title: 'پیام کمپین', campaign_status: 'active',
      image_url: url, created_at: '2026-10-17T10:30:00Z',
    });
    const thumb = findThumbTag(html);
    assert.ok(thumb, `messages LIST view: thumbnail must render for benign URL: ${url}`);
    const src = attrValue(thumb, 'src');
    assert.equal(decodeEntities(src), url,
      `benign stored image_url must render unchanged (no valid URL broken): ${url}`);
  }

  // Null/empty image_url keeps producing NO thumbnail (existing behavior).
  const noImg = renderMessageListCard({
    id: 'adm_demo2', title: 'پیام کمپین', campaign_status: 'active',
    image_url: '', created_at: '2026-10-17T10:30:00Z',
  });
  assert.equal(findThumbTag(noImg), undefined,
    'empty image_url must not render a thumbnail (behavior preserved)');
});

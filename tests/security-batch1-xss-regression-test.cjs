/**
 * Security Batch 1 — XSS / Injection Regression Tests
 * ----------------------------------------------------
 * Pins every Batch 1 fix (FE-1, FE-2, FE-3, FE-4, FE-8, TG-1) with:
 *   (a) source pins on the exact fixed call sites, and
 *   (b) behavioral tests against the REAL shipping functions extracted
 *       from app.js / assistant.js / reward_purchases.js (vm-style
 *       extraction with stubbed DOM/i18n dependencies).
 *
 * Fixes covered:
 *   FE-1  app.js renderTicketThread     — ${r.message} → ${escapeHtml(r.message)}
 *   FE-2  app.js renderAboutContent     — content.version → escapeHtml(content.version)
 *   FE-3  app.js renderNotifications    — CTA href → escapeHtml(sanitizeNewsUrl(md.button_url))
 *   FE-4  assistant.js showFilePreview + showCompressionProgress — ${file.name} → ${escapeHtml(file.name)}
 *   FE-8  index.html target=_blank      — rel="noopener noreferrer" on both anchors
 *   TG-1  reward_purchases.js vpnLink   — _escapeTelegramHtml() at the Telegram output boundary
 *
 * Run: node --test tests/security-batch1-xss-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');
const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, '..', 'assistant.js'), 'utf8');
const INDEX_SRC = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const REWARD_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'controllers', 'reward_purchases.js'), 'utf8');

// ── Extraction helpers ──────────────────────────────────────────────────────
// Stack-based mini-tokenizer for extracting a complete function/method source:
//   - root 'code' frame counts { } — returns when the root depth returns to 0
//   - template literals push a 'tpl' frame; `${` inside one pushes an 'expr'
//     frame; the `}` that empties an expr frame pops back to the template
//   - strings ('…' / "…") and comments (// …  /* … */) are skipped, so
//     HTML/quote-bearing comments inside bodies cannot desync the count
function extractFromIndex(src, start) {
  // Regex-start heuristic: a `/` opens a regex literal when the previous
  // significant character is not an identifier/number/`)`/`]` (or when the
  // preceding word is a keyword like `return`). Handles `.replace(/"/g, …)`.
  function regexAllowed(i) {
    let j = i - 1;
    while (j >= 0 && /\s/.test(src[j])) j--;
    if (j < 0) return true;
    const c = src[j];
    if (c === ')' || c === ']' || c === '.') return false;
    if (/[A-Za-z0-9_$]/.test(c)) {
      let k = j;
      while (k >= 0 && /[A-Za-z0-9_$]/.test(src[k])) k--;
      const word = src.slice(k + 1, j + 1);
      return ['return', 'typeof', 'instanceof', 'in', 'of', 'case', 'delete',
        'void', 'do', 'else', 'yield', 'await', 'new', 'throw'].includes(word);
    }
    return true;
  }
  const stack = [{ type: 'code', depth: 0 }];
  for (let i = start; i < src.length; i++) {
    const ch = src[i], next = src[i + 1];
    const top = stack[stack.length - 1];
    if (top.type === 'lc') { if (ch === '\n' || ch === '\r') stack.pop(); continue; }
    if (top.type === 'bc') { if (ch === '*' && next === '/') { stack.pop(); i++; } continue; }
    if (top.type === 's') { if (ch === '\\') i++; else if (ch === "'") stack.pop(); continue; }
    if (top.type === 'd') { if (ch === '\\') i++; else if (ch === '"') stack.pop(); continue; }
    if (top.type === 're') {
      if (ch === '\\') { i++; continue; }
      if (ch === '[') { top.cls = true; continue; }
      if (ch === ']') { top.cls = false; continue; }
      if (ch === '/' && !top.cls) { stack.pop(); continue; }
      continue;
    }
    if (top.type === 'tpl') {
      if (ch === '\\') { i++; continue; }
      if (ch === '`') { stack.pop(); continue; }
      if (ch === '$' && next === '{') { stack.push({ type: 'expr', depth: 0 }); i++; continue; }
      continue;
    }
    // 'code' or 'expr' frame
    if (ch === '/' && next === '/') { stack.push({ type: 'lc' }); i++; continue; }
    if (ch === '/' && next === '*') { stack.push({ type: 'bc' }); i++; continue; }
    if (ch === '/' && regexAllowed(i)) { stack.push({ type: 're' }); continue; }
    if (ch === "'") { stack.push({ type: 's' }); continue; }
    if (ch === '"') { stack.push({ type: 'd' }); continue; }
    if (ch === '`') { stack.push({ type: 'tpl' }); continue; }
    if (ch === '{') { top.depth++; continue; }
    if (ch === '}') {
      if (top.type === 'expr' && top.depth === 0) { stack.pop(); continue; }
      top.depth--;
      if (top.type === 'code' && top.depth === 0) return src.slice(start, i + 1);
      continue;
    }
  }
  throw new Error('unbalanced braces in extraction');
}

function extractFunction(src, name) {
  const re = new RegExp(`(async\\s+)?function\\s+${name}\\s*\\(`);
  const m = re.exec(src);
  if (!m) throw new Error(`${name} not found`);
  return extractFromIndex(src, m.index);
}

function extractMethod(src, name) {
  const re = new RegExp(`(^|[^\\w$.])${name}\\s*\\([^)]*\\)\\s*\\{`);
  const m = re.exec(src);
  if (!m) throw new Error(`method ${name} not found`);
  return extractFromIndex(src, m.index + m[1].length);
}

// ── Real shipping functions ─────────────────────────────────────────────────
const escapeHtml = new Function(`return (${extractFunction(APP_SRC, 'escapeHtml')})`)();
const sanitizeNewsUrl = new Function(`return (${extractFunction(APP_SRC, 'sanitizeNewsUrl')})`)();
const renderTicketThread = new Function(
  't', 'formatTicketDate', 'escapeHtml',
  `return (${extractFunction(APP_SRC, 'renderTicketThread')})`
)((k) => `[${k}]`, () => '2026-01-01', escapeHtml);
const renderAboutContent = new Function(
  't', 'escapeHtml',
  `return (${extractFunction(APP_SRC, 'renderAboutContent')})`
)((k) => `[${k}]`, escapeHtml);
const _escapeTelegramHtml = new Function(`return (${extractFunction(REWARD_SRC, '_escapeTelegramHtml')})`)();

// ════════════════════════════════════════════════════════════════════════════
// SOURCE PINS — one per finding (fix present at the exact call site)
// ════════════════════════════════════════════════════════════════════════════

test('B1-FE1-SRC: renderTicketThread escapes ticket reply messages', () => {
  assert.ok(APP_SRC.includes('${escapeHtml(r.message)}'),
    'renderTicketThread must interpolate escapeHtml(r.message)');
  assert.ok(!/\$\{r\.message\}/.test(APP_SRC),
    'no raw ${r.message} interpolation may remain in app.js');
});

test('B1-FE2-SRC: renderAboutContent escapes the content version badge', () => {
  assert.ok(APP_SRC.includes('escapeHtml(content.version)'),
    'version badge must interpolate escapeHtml(content.version)');
  assert.ok(!/' \+ content\.version \+ '/.test(APP_SRC),
    'no raw content.version string concatenation may remain');
});

test('B1-FE3-SRC: notification CTA composes sanitizeNewsUrl + escapeHtml', () => {
  assert.ok(APP_SRC.includes('escapeHtml(sanitizeNewsUrl(md.button_url))'),
    'CTA href must be escapeHtml(sanitizeNewsUrl(md.button_url)) — scheme validation AND attribute escaping');
});

test('B1-FE4-SRC: both assistant.js file-name sinks are escaped', () => {
  const escaped = ASSISTANT_SRC.match(/\$\{escapeHtml\(file\.name\)\}/g) || [];
  assert.equal(escaped.length, 2,
    'showFilePreview + showCompressionProgress must both escape file.name');
  assert.ok(!/<div class="ai-file-preview-name">\$\{file\.name\}<\/div>/.test(ASSISTANT_SRC),
    'no raw ${file.name} interpolation may remain in the preview templates');
});

test('B1-FE8-SRC: index.html has no target="_blank" without rel noopener noreferrer', () => {
  const tags = INDEX_SRC.split('target="_blank"').slice(1); // remainder of each anchor tag
  assert.ok(tags.length >= 2, `expected at least 2 _blank anchors, found ${tags.length}`);
  for (const rest of tags) {
    const tagEnd = rest.indexOf('>');
    const tag = rest.slice(0, tagEnd);
    assert.ok(/rel="noopener noreferrer"/.test(tag),
      `anchor with target="_blank" missing rel="noopener noreferrer"`);
  }
});

test('B1-TG1-SRC: reward_purchases defines _escapeTelegramHtml and uses it on vpnLink', () => {
  assert.ok(/function\s+_escapeTelegramHtml\s*\(\s*str\s*\)/.test(REWARD_SRC),
    '_escapeTelegramHtml helper must exist (file-local _ convention)');
  assert.ok(REWARD_SRC.includes('${_escapeTelegramHtml(vpnLink)}'),
    'deliveryMsg must interpolate _escapeTelegramHtml(vpnLink)');
});

test('B1-TG1-SRC2: fulfillPurchase still receives the RAW vpnLink (DB behavior unchanged)', () => {
  assert.ok(REWARD_SRC.includes('fulfillPurchase(env, purchaseId, admin.telegram_id, vpnLink)'),
    'fulfillPurchase must keep the raw vpnLink — escaping is output-boundary only');
  assert.ok(!/fulfillPurchase\(env, purchaseId, admin\.telegram_id,\s*_escapeTelegramHtml\(vpnLink\)\)/.test(REWARD_SRC),
    'the escaping must NOT leak into the DB write');
});

// ════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL — REAL shipping functions, before→after security proof
// ════════════════════════════════════════════════════════════════════════════

test('B1-BHV-01: escapeHtml escapes all 5 HTML-special characters', () => {
  assert.equal(escapeHtml('<img src=x onerror="alert(1)">'), '&lt;img src=x onerror=&quot;alert(1)&quot;&gt;');
  assert.equal(escapeHtml("a&b<c>d'e\"f"), 'a&amp;b&lt;c&gt;d&#39;e&quot;f');
});

test('B1-BHV-02: escapeHtml returns empty string for falsy input', () => {
  assert.equal(escapeHtml(''), '');
  assert.equal(escapeHtml(null), '');
  assert.equal(escapeHtml(undefined), '');
});

test('B1-BHV-03: sanitizeNewsUrl allows http and https URLs', () => {
  assert.equal(sanitizeNewsUrl('https://example.com/a?b=1'), 'https://example.com/a?b=1');
  assert.equal(sanitizeNewsUrl('http://example.com'), 'http://example.com');
  assert.equal(sanitizeNewsUrl('  https://example.com  '), 'https://example.com');
});

test('B1-BHV-04: sanitizeNewsUrl rejects dangerous and unknown schemes', () => {
  assert.equal(sanitizeNewsUrl('javascript:alert(1)'), '#');
  assert.equal(sanitizeNewsUrl('JaVaScRiPt:alert(1)'), '#');
  assert.equal(sanitizeNewsUrl('data:text/html;base64,PHNjcmlwdD4='), '#');
  assert.equal(sanitizeNewsUrl('vbscript:msgbox(1)'), '#');
  assert.equal(sanitizeNewsUrl('ftp://example.com'), '#');
  assert.equal(sanitizeNewsUrl('//example.com'), '#');
});

test('B1-BHV-05: sanitizeNewsUrl rejects empty / non-string input', () => {
  assert.equal(sanitizeNewsUrl(''), '#');
  assert.equal(sanitizeNewsUrl('   '), '#');
  assert.equal(sanitizeNewsUrl(null), '#');
  assert.equal(sanitizeNewsUrl(undefined), '#');
});

test('B1-BHV-06: renderTicketThread escapes an admin reply containing HTML (FE-1 proof)', () => {
  const html = renderTicketThread([
    { from: 'admin', at: '2026-01-01T00:00:00Z', message: '<img src=x onerror=alert(1)>' },
  ]);
  assert.ok(!/<img src=x/.test(html), 'raw HTML payload must NOT survive into the thread HTML');
  assert.ok(html.includes('&lt;img src=x'), 'payload must appear HTML-escaped');
});

test('B1-BHV-07: renderTicketThread renders benign replies unchanged (content preserved)', () => {
  const html = renderTicketThread([
    { from: 'admin', at: '2026-01-01T00:00:00Z', message: 'مشکل شما حل شد ✅' },
  ]);
  assert.ok(html.includes('مشکل شما حل شد ✅'), 'benign content must render identically');
});

test('B1-BHV-08: renderAboutContent escapes a version string containing HTML (FE-2 proof)', () => {
  const html = renderAboutContent({ version: '<script>alert(1)</script>', sections: [] });
  assert.ok(!/<script>/.test(html), 'raw version HTML must NOT survive');
  assert.ok(html.includes('&lt;script&gt;'), 'version must render HTML-escaped');
});

test('B1-BHV-09: renderAboutContent renders benign versions and sections normally', () => {
  const html = renderAboutContent({
    version: '2.1.0',
    sections: [{ heading: 'About', body: 'Body text' }],
  });
  assert.ok(html.includes('2.1.0'), 'benign version must render');
  assert.ok(html.includes('Body text'), 'section body must render');
});

test('B1-BHV-10: _escapeTelegramHtml escapes & < > (Telegram HTML text rule)', () => {
  assert.equal(_escapeTelegramHtml('a<b>&c>'), 'a&lt;b&gt;&amp;c&gt;');
  assert.equal(_escapeTelegramHtml('<b>bold</b>'), '&lt;b&gt;bold&lt;/b&gt;');
});

test('B1-BHV-11: _escapeTelegramHtml leaves quotes and other characters intact', () => {
  // Quotes are inert inside Telegram message text — escaping them would
  // visibly alter delivered links for no security gain.
  const url = 'https://vpn.example.com/get?x=y&z=1';
  assert.equal(_escapeTelegramHtml(url), 'https://vpn.example.com/get?x=y&amp;z=1',
    'only the ampersand may be escaped in this URL');
});

test('B1-BHV-12: _escapeTelegramHtml is null-safe', () => {
  assert.equal(_escapeTelegramHtml(null), '');
  assert.equal(_escapeTelegramHtml(undefined), '');
});

// ── showFilePreview behavioral with DOM stubs ───────────────────────────────
function makeDom() {
  const elements = [];
  const makeEl = (tag) => {
    const el = {
      tagName: tag, id: '', className: '', innerHTML: '', style: {},
      listeners: {}, children: [],
      addEventListener(ev, fn) { (this.listeners[ev] ||= []).push(fn); },
      appendChild(c) { this.children.push(c); },
      insertBefore() {},
      querySelector() { return makeEl('div'); },
      parentNode: null,
    };
    elements.push(el);
    return el;
  };
  const composerAttach = makeEl('div');
  const document = {
    createElement: makeEl,
    getElementById: (id) => (id === 'ai-composer-attachment' ? composerAttach : makeEl('div')),
  };
  return { document, composerAttach, elements };
}

function previewHtml(attachment) {
  const methodSrc = extractMethod(ASSISTANT_SRC, 'showFilePreview').replace(/,\s*$/, '');
  const dom = makeDom();
  const thisStub = { removeFilePreview() {}, clearAttachment() {} };
  const fn = new Function('t', 'escapeHtml', 'document', 'FileReader',
    `return ({ ${methodSrc} }).showFilePreview;`)((k) => `[${k}]`, escapeHtml, dom.document,
    class { readAsDataURL() {} });
  fn.call(thisStub, attachment);
  const preview = dom.elements.find((el) => el.id === 'ai-file-preview');
  return preview ? preview.innerHTML : '';
}

test('B1-BHV-13: showFilePreview escapes a malicious file name (FE-4 proof)', () => {
  const html = previewHtml({
    status: 'ready',
    file: { name: '<img src=x onerror=alert(1)>.png', type: 'text/plain', size: 1024 },
    name: '<img src=x onerror=alert(1)>.png', size: 1024, data: null,
  });
  assert.ok(html.includes('ai-file-preview-name'), 'preview template rendered');
  assert.ok(!/<img src=x onerror=alert\(1\)>\.png<\/div>/.test(html),
    'raw file.name payload must NOT survive into innerHTML');
  assert.ok(html.includes('&lt;img src=x onerror=alert(1)&gt;.png'),
    'file.name must appear HTML-escaped');
});

test('B1-BHV-14: showFilePreview renders a benign file name unchanged', () => {
  const html = previewHtml({
    status: 'ready',
    file: { name: 'analysis.pdf', type: 'text/plain', size: 2048 },
    name: 'analysis.pdf', size: 2048, data: null,
  });
  assert.ok(html.includes('analysis.pdf'), 'benign file name must render identically');
});

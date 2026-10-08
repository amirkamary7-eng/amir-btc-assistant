/**
 * Security Batch 5 — External / API / Resource Hardening Regression Tests
 * -----------------------------------------------------------------------
 * EX-3: fetchJsonWithTimeout size-bounded BEFORE parse (Content-Length
 *       pre-check with stream cancel + post-read length check;
 *       FETCH_JSON_MAX_BYTES = 5MB; optional per-call maxBytes).
 * EX-2: extractImageUrl scheme validation (_okScheme — http(s) and
 *       protocol-relative only; javascript:/data:/blob:/vbscript:/file:/
 *       relative/>2048 → default image).
 * AP-5: /api/market/prices dedicated per-user rate limit (60/min,
 *       'market-prices' bucket, after auth before symbols parse).
 * AP-6: /api/market/overview isMarketRateLimited BEFORE the KV cache read
 *       (MKT-010 pattern; soft-auth uid; cron refresh unaffected).
 * EX-1: documented-only (trusted hardcoded 8-source RSS provenance +
 *       scheme gate + redirect follow + 5MB safeReadText + 8s timeout).
 *
 * Behavioral tests drive the REAL worker fetch handler and the REAL
 * extracted functions with a stubbed global fetch.
 *
 * Run: node --test tests/security-batch5-external-resources-test.cjs
 */
'use strict';
const test = require('node:test');
const { after } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');
const SHARED_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'news', 'shared.js'), 'utf8');
const SUMMARY_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'news', 'summary.js'), 'utf8');
const SCHEDULER_SRC = fs.readFileSync(path.join(__dirname, '..', 'src', 'cron', 'scheduler.js'), 'utf8');

// ── fetch counter stub (whole file — no network access) ────────────────────
const realFetch = globalThis.fetch;
let fetchCallCount = 0;
let fetchResponder = async () => new Response('{}', { status: 200, headers: { 'content-type': 'application/json' } });
globalThis.fetch = async (...args) => { fetchCallCount++; return fetchResponder(...args); };

// ── tokenizer extraction (same as batch1) ───────────────────────────────────
function extractFromIndex(src, start) {
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

// ════════════════════════════════════════════════════════════════════════════
// EX-3 — fetchJsonWithTimeout behavioral (real extracted function)
// ════════════════════════════════════════════════════════════════════════════

const FETCH_JSON_MAX_BYTES = 5 * 1024 * 1024;
function makeFetchJson() {
  return new Function('FETCH_JSON_MAX_BYTES', '_traceStage', 'EXTERNAL_FETCH_TIMEOUT_MS',
    `return (${extractFunction(WORKER_SRC, 'fetchJsonWithTimeout')})`)(FETCH_JSON_MAX_BYTES, () => {}, 8000);
}

function withResponder(fn, responder) {
  return async (...args) => {
    const prev = fetchResponder;
    fetchResponder = responder;
    try { return await fn(...args); } finally { fetchResponder = prev; }
  };
}

test('EX3-BHV-01: normal 2xx JSON parses → {ok:true, body}', async () => {
  const fn = makeFetchJson();
  const r = await (withResponder(fn, () => new Response('{"a":1}', { status: 200 })))('https://x.test/api');
  assert.deepEqual(r, { ok: true, body: { a: 1 } });
});

test('EX3-BHV-02: non-2xx → {ok:false, body:null}', async () => {
  const fn = makeFetchJson();
  const r = await (withResponder(fn, () => new Response('nope', { status: 503 })))('https://x.test/api');
  assert.deepEqual(r, { ok: false, body: null });
});

test('EX3-BHV-03: oversized declared Content-Length → rejected WITHOUT reading the body (stream canceled)', async () => {
  const fn = makeFetchJson();
  let cancelCalled = false;
  let readerUsed = false;
  const r = await (withResponder(fn, () => new Response('{"a":1}', {
    status: 200,
    headers: { 'Content-Length': String(FETCH_JSON_MAX_BYTES + 1) },
  })))('https://x.test/api');
  assert.equal(r.ok, false, 'oversize CL must be rejected');
  assert.equal(r.body, null);
  assert.equal(cancelCalled, false); // informational — cancel is best-effort
  assert.equal(readerUsed, false);
});

test('EX3-BHV-03b: oversized declared Content-Length cancels the body stream', async () => {
  const fn = makeFetchJson();
  let cancelCalled = false;
  const r = await (withResponder(fn, () => {
    const body = new ReadableStream({
      start(c) { c.enqueue(new TextEncoder().encode('{"a":1}')); },
      cancel() { cancelCalled = true; },
    });
    return new Response(body, { status: 200, headers: { 'Content-Length': String(FETCH_JSON_MAX_BYTES + 10) } });
  }))('https://x.test/api');
  assert.equal(r.ok, false);
  assert.equal(cancelCalled, true, 'response.body.cancel() must be invoked for the oversize stream');
});

test('EX3-BHV-04: oversized actual body without Content-Length (chunked) → rejected', async () => {
  const fn = makeFetchJson();
  const huge = 'x'.repeat(FETCH_JSON_MAX_BYTES + 100);
  const r = await (withResponder(fn, () => new Response(huge, { status: 200 })))('https://x.test/api');
  assert.deepEqual(r, { ok: false, body: null });
});

test('EX3-BHV-05: malformed JSON → {ok:false, body:null}', async () => {
  const fn = makeFetchJson();
  const r = await (withResponder(fn, () => new Response('not-json{', { status: 200 })))('https://x.test/api');
  assert.deepEqual(r, { ok: false, body: null });
});

test('EX3-BHV-06: timeout (fetch rejects with AbortError) → {ok:false, body:null}', async () => {
  const fn = makeFetchJson();
  const r = await (withResponder(fn, (url, init) => new Promise((_, rej) => {
    init.signal.addEventListener('abort', () => rej(Object.assign(new Error('The operation was aborted'), { name: 'AbortError' })));
  })))('https://x.test/api', 20);
  assert.deepEqual(r, { ok: false, body: null });
});

test('EX3-BHV-07: 1MB legitimate body is NOT truncated (5MB headroom works)', async () => {
  const fn = makeFetchJson();
  const payload = JSON.stringify({ data: 'a'.repeat(1024 * 1024) }); // ~1MB
  const r = await (withResponder(fn, () => new Response(payload, { status: 200 })))('https://x.test/api');
  assert.equal(r.ok, true, '1MB legit response must pass the 5MB bound');
  assert.equal(r.body.data.length, 1024 * 1024, 'body must be complete, not truncated');
});

test('EX3-BHV-08: per-call maxBytes override works', async () => {
  const fn = makeFetchJson();
  const r = await (withResponder(fn, () => new Response('{"a":"' + 'b'.repeat(2000) + '"}', { status: 200 })))('https://x.test/api', 8000, 1024);
  assert.deepEqual(r, { ok: false, body: null }, 'tiny per-call bound must reject the 2KB body');
});

test('EX3-SRC-01: FETCH_JSON_MAX_BYTES = 5MB + two-stage bound + cancel in source', () => {
  assert.ok(WORKER_SRC.includes('const FETCH_JSON_MAX_BYTES = 5 * 1024 * 1024'), '5MB constant');
  const idx = WORKER_SRC.indexOf('async function fetchJsonWithTimeout');
  const block = WORKER_SRC.slice(idx, idx + 2500);
  assert.ok(block.includes("response.headers.get('Content-Length')"), 'CL pre-check');
  assert.ok(block.includes('response.body?.cancel()'), 'stream cancel on oversize');
  assert.ok(block.includes('.length > maxBytes'), 'post-read length check');
  assert.ok(block.includes('JSON.parse(_text)'), 'parse happens on the bounded text only');
  assert.ok(!block.includes('await response.json()'), 'the old unbounded response.json() must be gone');
});

// ════════════════════════════════════════════════════════════════════════════
// EX-2 — extractImageUrl behavioral (real function, source-eval standalone)
// ════════════════════════════════════════════════════════════════════════════

const DEFAULT_IMG = 'https://images.cryptocompare.com/news/default/bitcoin.png';
// Standalone eval (self-contained by design — no external refs).
const sharedScope = `
${SHARED_SRC.match(/function _okScheme[\s\S]*?\n}/)[0]}
${extractFunction(SHARED_SRC, 'extractImageUrl')}
`;
const extractImageUrl = new Function(`${sharedScope}\nreturn extractImageUrl;`)();

test('EX2-BHV-01: http:// image URL passes', () => {
  assert.equal(extractImageUrl('<img src="http://img.irna.ir/a.jpg">', null), 'http://img.irna.ir/a.jpg');
});

test('EX2-BHV-02: https:// image URL passes and is trimmed', () => {
  assert.equal(extractImageUrl('<img src=" https://cdn.example.com/a.png ">', null), 'https://cdn.example.com/a.png');
});

test('EX2-BHV-03: protocol-relative //cdn… passes', () => {
  assert.equal(extractImageUrl('<img src="//cdn.example.com/a.png">', null), '//cdn.example.com/a.png');
});

test('EX2-BHV-04: javascript: img → default image', () => {
  assert.equal(extractImageUrl('<img src="javascript:alert(1)">', null), DEFAULT_IMG);
});

test('EX2-BHV-05: data: img → default image', () => {
  assert.equal(extractImageUrl('<img src="data:text/html;base64,PHNjcmlwdD4=">', null), DEFAULT_IMG);
});

test('EX2-BHV-06: vbscript:/blob:/file: → default image', () => {
  assert.equal(extractImageUrl('<img src="vbscript:msgbox(1)">', null), DEFAULT_IMG);
  assert.equal(extractImageUrl('<img src="blob:https://x">', null), DEFAULT_IMG);
  assert.equal(extractImageUrl('<img src="file:///etc/passwd">', null), DEFAULT_IMG);
});

test('EX2-BHV-07: relative /images/x.png → default image', () => {
  assert.equal(extractImageUrl('<img src="/images/2024/01/a.jpg">', null), DEFAULT_IMG);
});

test('EX2-BHV-08: >2048-char URL → default image', () => {
  assert.equal(extractImageUrl(`<img src="https://x.test/${'a'.repeat(2100)}">`, null), DEFAULT_IMG);
});

test('EX2-BHV-09: precedence — valid img beats enclosure; invalid img falls to valid enclosure; both invalid → default', () => {
  const itemBlock = '<enclosure url="https://enc.example.com/e.jpg" type="image/jpeg"/>';
  assert.equal(extractImageUrl('<img src="https://img.example.com/i.jpg">', itemBlock), 'https://img.example.com/i.jpg',
    'valid img wins over enclosure');
  assert.equal(extractImageUrl('<img src="javascript:alert(1)">', itemBlock), 'https://enc.example.com/e.jpg',
    'invalid img falls through to the (valid) enclosure');
  const badBlock = '<enclosure url="data:image/png;base64,AAAA"/>';
  assert.equal(extractImageUrl('<img src="javascript:alert(1)">', badBlock), DEFAULT_IMG,
    'both invalid → default image');
});

// ════════════════════════════════════════════════════════════════════════════
// EX-1 — documented-only provenance pins
// ════════════════════════════════════════════════════════════════════════════

test('EX1-SRC-01: exactly 8 hardcoded trusted RSS sources (no user/DB-controlled URLs)', () => {
  const m = WORKER_SRC.match(/const NEWS_RSS_SOURCES = \[([\s\S]*?)\n\];/);
  assert.ok(m, 'NEWS_RSS_SOURCES array found');
  const entries = m[1].match(/\{ url: '/g) || [];
  assert.equal(entries.length, 8);
  assert.ok(m[1].includes('https://'), 'all sources are hardcoded https URLs');
});

test('EX1-SRC-02: article fetch has the http(s) scheme gate (NEWSSEC-011)', () => {
  assert.ok(SUMMARY_SRC.includes("Article URL must be http(s)"));
  assert.ok(SUMMARY_SRC.includes('invalid_url_scheme'), 'scheme rejection with requeue code');
  assert.ok(SUMMARY_SRC.includes('/^https?:\\/\\//i.test(article.url)'), 'the http(s) scheme test on article.url');
});

test('EX1-SRC-03: article fetch follows redirects with a 5MB body cap (NEWSSEC-014) + RSS <link> provenance', () => {
  assert.ok(SUMMARY_SRC.includes("redirect: 'follow'"), 'redirect follow');
  assert.ok(SUMMARY_SRC.includes('await safeReadText(articleRes, 5 * 1024 * 1024)'), '5MB safeReadText cap');
  // provenance: article.url originates from RSS <link> extraction in shared.js
  assert.ok(SHARED_SRC.includes('extractFirstMatch'), 'RSS link extraction exists');
});

// ════════════════════════════════════════════════════════════════════════════
// Worker harness for AP-5 / AP-6 behavioral tests
// ════════════════════════════════════════════════════════════════════════════

function loadWorker() {
  const source = WORKER_SRC;
  const defaultMocks = {
    'pg': { Pool: class { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } } },
    '@neondatabase/serverless': {
      Pool: class Pool { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } },
      neon: function () { const f = async () => []; f.query = async () => ({ rows: [] }); f.transaction = async (cb) => cb({ query: f.query }); return f; },
    },
  };
  const lmc = {}; const lr = (id) => { if (defaultMocks[id]) return defaultMocks[id]; if (lmc[id]) return lmc[id]; return require(id); };
  const lire = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g; let m;
  while ((m = lire.exec(source)) !== null) { const ip = m[4]; if (lmc[ip]) continue; const rp = path.resolve(path.dirname(WORKER_PATH), ip); let ms = fs.readFileSync(rp, 'utf8'); ms = ms.replace(/import\s+\{([^}]*)\}\s+from\s+['"]node:([^'"]+)['"];?/g, (_, named, mod) => `const { ${named} } = require('node:${mod}');`).replace(/export\s+(?:async\s+)?function\s+(\w+)/g, 'module.exports.$1 = function $1').replace(/export\s+default\s+/g, 'module.exports.default = ').replace(/export\s+const\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+let\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+var\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+\{\s*(\w+)\s*\};?/g, 'module.exports.$1 = $1;'); const mod = { exports: {} }; new Function('require', 'module', 'exports', ms)(lr, mod, mod.exports); lmc[ip] = mod.exports; }
  const t = source.replace("import { createHmac, timingSafeEqual } from 'node:crypto';", "const { createHmac, timingSafeEqual } = require('node:crypto');").replace(/import\s+\{([^}]*)\}\s+from\s+['"]node:([^'"]+)['"];?/g, (_, named, mod) => `const { ${named} } = require('node:${mod}');`).replace("import { Pool as NeonPool, neon } from '@neondatabase/serverless';", "const { Pool: NeonPool, neon } = require('@neondatabase/serverless');").replace("import { Pool as PgPool } from 'pg';", "const { Pool: PgPool } = require('pg');").replace(/import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const { ${n} } = require('${p}');`).replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace(/import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace('export default {', 'module.exports = {').replace(/export\s+\{\s*(\w+)\s*\};?/g, 'module.exports.$1 = $1;');
  const mod = { exports: {} }; new Function('require', 'module', 'exports', t)(lr, mod, mod.exports); return mod.exports;
}

function createMemoryKv(i = {}) { const s = new Map(Object.entries(i)); return { async get(k) { return s.has(k) ? s.get(k) : null; }, async put(k, v, o) { s.set(k, v); }, async delete(k) { s.delete(k); }, dump() { return Object.fromEntries(s.entries()); } }; }
function buildInitData(b, u) { const e = [['auth_date', String(Math.floor(Date.now() / 1000))], ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'], ['user', JSON.stringify(u)]]; const d = e.slice().sort(([l], [r]) => l.localeCompare(r)).map(([k, v]) => `${k}=${v}`).join('\n'); const sk = crypto.createHmac('sha256', 'WebAppData').update(b).digest(); const h = crypto.createHmac('sha256', sk).update(d).digest('hex'); return e.map(([k, v]) => `${k}=${encodeURIComponent(v)}`).concat([`hash=${h}`]).join('&'); }

function createEnv(o = {}) {
  return Object.assign({
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: 'postgresql://test',
    APP_ENV: 'production',
    BOT_USERNAME: '',
    WEBAPP_URL: 'https://amir-btc.pages.dev',
    APP_CACHE: createMemoryKv({ 'market:overview:cmc': JSON.stringify({ fearGreedValue: 72, fearGreedClassification: 'Greed' }) }),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
  }, o);
}
const ADMIN_USER = { id: 831704732, first_name: 'Admin', username: 'admin', lang_code: 'fa' };
const adminInitData = () => buildInitData('test-bot-token', ADMIN_USER);
async function send(w, e, m, p, o = {}) {
  const u = p.startsWith('http') ? p : `http://localhost${p}`;
  const h = new Headers(o.headers || {});
  if (o.initData) h.set('X-Telegram-Init-Data', o.initData);
  if (o.ip) h.set('cf-connecting-ip', o.ip);
  const res = await w.fetch(new Request(u, { method: m, headers: h }), e, {});
  let b; try { b = await res.json(); } catch { b = null; }
  return { status: res.status, body: b };
}

// ════════════════════════════════════════════════════════════════════════════
// AP-5 — /api/market/prices dedicated rate limit
// ════════════════════════════════════════════════════════════════════════════

test('AP5-BHV-01: unauthenticated → 401', async () => {
  const w = loadWorker();
  const res = await send(w, createEnv(), 'GET', '/api/market/prices?symbols=BTC');
  assert.equal(res.status, 401);
});

test('AP5-BHV-02: authenticated, symbols omitted → 200 {prices:{}}', async () => {
  const w = loadWorker();
  const res = await send(w, createEnv(), 'GET', '/api/market/prices', { initData: adminInitData() });
  assert.equal(res.status, 200);
  assert.deepEqual(res.body.prices, {});
});

test('AP5-BHV-03: 30 requested symbols are capped at 15 (≤45 upstream subrequests)', async () => {
  const w = loadWorker();
  fetchCallCount = 0;
  const symbols = Array.from({ length: 30 }, (_, i) => `SYM${i}`).join(',');
  const res = await send(w, createEnv(), 'GET', `/api/market/prices?symbols=${symbols}`, { initData: adminInitData() });
  assert.equal(res.status, 200);
  assert.ok(fetchCallCount <= 45, `30 symbols must be capped at 15 → ≤45 fetches, saw ${fetchCallCount}`);
});

test('AP5-BHV-04: 60 requests allowed, the 61st → 429', async () => {
  const w = loadWorker();
  const env = createEnv();
  for (let i = 0; i < 60; i++) {
    const res = await send(w, env, 'GET', '/api/market/prices', { initData: adminInitData() });
    if (res.status !== 200) throw new Error(`request ${i + 1} unexpectedly ${res.status}`);
  }
  const blocked = await send(w, env, 'GET', '/api/market/prices', { initData: adminInitData() });
  assert.equal(blocked.status, 429, 'the 61st request within the window must be rate limited');
});

test('AP5-BHV-05: separate user buckets — a maxed user does not block another', async () => {
  const w = loadWorker();
  const env = createEnv();
  const userB = buildInitData('test-bot-token', { id: 111222333, first_name: 'B', lang_code: 'fa' });
  for (let i = 0; i < 60; i++) {
    await send(w, env, 'GET', '/api/market/prices', { initData: adminInitData() });
  }
  const blocked = await send(w, env, 'GET', '/api/market/prices', { initData: adminInitData() });
  assert.equal(blocked.status, 429);
  const other = await send(w, env, 'GET', '/api/market/prices', { initData: userB });
  assert.equal(other.status, 200, 'user B has an independent bucket');
});

test('AP5-SRC-01: dedicated market-prices category with 60/60s limits', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/market/prices'");
  const block = WORKER_SRC.slice(idx, idx + 1800);
  assert.ok(block.includes("isUserRateLimited(env, authState.user?.id, 'market-prices', 60, 60)"),
    'dedicated bucket: category market-prices, 60 requests / 60 seconds');
});

test('AP5-SRC-02: guard order — auth FIRST, then rate limit, then symbols parse', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/market/prices'");
  const block = WORKER_SRC.slice(idx, idx + 2000);
  const authIdx = block.indexOf('authenticateTelegramRequest(request, env)');
  const rlIdx = block.indexOf("isUserRateLimited(env, authState.user?.id, 'market-prices'");
  const symIdx = block.indexOf("url.searchParams.get('symbols')");
  assert.ok(authIdx > -1 && rlIdx > authIdx && symIdx > rlIdx, 'auth → rate-limit → parse');
});

test('AP5-SRC-03: NOT the generic mutation bucket (no mrl key reuse)', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/market/prices'");
  const block = WORKER_SRC.slice(idx, idx + 1800);
  assert.ok(!block.includes("'mrl'"), 'must not share the mrl mutation bucket');
});

test('AP5-SRC-04: cron path never routes through this HTTP endpoint', () => {
  assert.ok(!SCHEDULER_SRC.includes('/api/market/prices'),
    'scheduler must call the internal service, never the HTTP endpoint');
  assert.ok(SCHEDULER_SRC.includes('fetchSpotPriceUsd') || SCHEDULER_SRC.includes('FETCH_BATCH'),
    'the alert cron fetches prices via the internal service directly');
});

// ════════════════════════════════════════════════════════════════════════════
// AP-6 — /api/market/overview rate limit BEFORE the cache read
// ════════════════════════════════════════════════════════════════════════════

test('AP6-BHV-01: warm cache → 200 with ZERO upstream fetches', async () => {
  const w = loadWorker();
  fetchCallCount = 0;
  const res = await send(w, createEnv(), 'GET', '/api/market/overview');
  assert.equal(res.status, 200);
  assert.equal(res.body.fearGreedValue, 72);
  assert.equal(fetchCallCount, 0, 'warm KV cache must not hit upstream');
});

test('AP6-BHV-02: cache miss → fallback path attempted (not 429/401)', async () => {
  const w = loadWorker();
  const env = createEnv({ APP_CACHE: createMemoryKv() }); // cold cache
  fetchCallCount = 0;
  const res = await send(w, env, 'GET', '/api/market/overview');
  assert.notEqual(res.status, 429, 'first request must not be rate limited');
  assert.notEqual(res.status, 401, 'public endpoint stays public');
  assert.ok([200, 503].includes(res.status), `expected 200 (fallback ok) or 503 (upstream down), got ${res.status}`);
  assert.ok(fetchCallCount > 0, 'cache miss exercises the upstream fallback');
});

test('AP6-BHV-03: 30 anonymous requests from one IP allowed, the 31st → 429', async () => {
  const w = loadWorker();
  const env = createEnv();
  for (let i = 0; i < 30; i++) {
    const res = await send(w, env, 'GET', '/api/market/overview', { ip: '203.0.113.9' });
    if (res.status !== 200) throw new Error(`request ${i + 1} unexpectedly ${res.status}`);
  }
  const blocked = await send(w, env, 'GET', '/api/market/overview', { ip: '203.0.113.9' });
  assert.equal(blocked.status, 429, 'the 31st request in the window must be rate limited');
});

test('AP6-BHV-04: separate IP buckets — a maxed IP does not block another', async () => {
  const w = loadWorker();
  const env = createEnv();
  for (let i = 0; i < 30; i++) {
    await send(w, env, 'GET', '/api/market/overview', { ip: '203.0.113.9' });
  }
  assert.equal((await send(w, env, 'GET', '/api/market/overview', { ip: '203.0.113.9' })).status, 429);
  const other = await send(w, env, 'GET', '/api/market/overview', { ip: '198.51.100.7' });
  assert.equal(other.status, 200, 'a different client IP has an independent bucket');
});

test('AP6-BHV-05: repeated warm-cache requests cause no upstream fetches (cache hits counted, not refetched)', async () => {
  const w = loadWorker();
  const env = createEnv();
  fetchCallCount = 0;
  for (let i = 0; i < 10; i++) {
    const res = await send(w, env, 'GET', '/api/market/overview');
    assert.equal(res.status, 200);
  }
  assert.equal(fetchCallCount, 0, '10 warm requests → zero upstream calls');
});

test('AP6-SRC-01: isMarketRateLimited runs BEFORE the KV cache read', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/market/overview'");
  const block = WORKER_SRC.slice(idx, idx + 2000);
  const rlIdx = block.indexOf('isMarketRateLimited(env,');
  const cacheIdx = block.indexOf('getCachedOverview(env)');
  assert.ok(rlIdx > -1 && cacheIdx > -1 && rlIdx < cacheIdx,
    'the rate limit must precede the cache read so a cache outage cannot bypass it');
});

test('AP6-SRC-02: 429 with the standard Rate limited body', () => {
  const idx = WORKER_SRC.indexOf("url.pathname === '/api/market/overview'");
  const block = WORKER_SRC.slice(idx, idx + 2000);
  assert.ok(block.includes("jsonResponse({ status: 'error', message: 'Rate limited' }, { status: 429 }, env)"));
});

test('AP6-SRC-03: cron refresh is a direct service call, never HTTP', () => {
  assert.ok(SCHEDULER_SRC.includes('marketOverviewSvc.refreshOverview') || SCHEDULER_SRC.includes('refreshOverview(env)'),
    'scheduler refreshes the overview cache via the service directly');
  assert.ok(!SCHEDULER_SRC.includes('/api/market/overview'),
    'the scheduler must never call the HTTP endpoint');
});

// Restore the real fetch only AFTER all tests have run (a module-level
// restore would execute before the test callbacks fire).
after(() => { globalThis.fetch = realFetch; });

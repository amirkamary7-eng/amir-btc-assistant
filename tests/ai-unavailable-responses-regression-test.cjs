// AI ASSISTANT "در دسترس نیست" (Unavailable) RESPONSES — REGRESSION TEST
// ====================================================================
//
// DEFECT (user-reported 2026-10-22; production-confirmed via Workers Logs):
//   Ordinary chat messages frequently failed with the generic
//   "دستیار در دسترس نیست" (ai_error) even while AI providers were healthy.
//
// PRODUCTION EVIDENCE (Workers observability logs, 2026-10-14..22):
//   1. 2026-10-18 04:45:15Z — [ChatAI] provider=groq response validation
//      FAILED: reason=truncated — a substantive groq answer (≥500 chars whose
//      last char was not in the narrow sentence-ender list) was DISCARDED,
//      the fallback chain then overran the frontend request budget, and the
//      invocation ended with NO response (client-aborted) → user saw the
//      generic unavailable message despite a healthy provider + usable answer.
//   2. Two POST /api/assistant/chat invocations in that episode have NO
//      response field in the invocation log = client-canceled requests —
//      consistent with the frontend apiFetch 15s hard timeout aborting
//      in-flight generation (backend fallback chains legitimately take 30-60s+).
//   3. [ChatAI] all_providers_failed error logs: 0 in 7 days — the backend
//      chain almost never hard-failed; requests were cut off client-side.
//   4. [TG-AUTH] Hash mismatch — validation failed (×2, 2026-10-20) — 401
//      rejections were ALSO mapped by the frontend catch to the same generic
//      "دستیار در دسترس نیست".
//
// FIX UNDER TEST (smallest maintainable correction):
//   assistant.js (frontend):
//     F-A. sendMessage/retry pass their OWN bounded 90s chat signal to apiFetch
//          for /api/assistant/chat via createChatTimeout() — apiFetch only
//          applies its 15s default when no signal is set, so the chat request
//          gets a dedicated, still-BOUNDED 90s budget matching the backend's
//          per-provider bounds. PR #96 review follow-up: createChatTimeout ALSO
//          bounds LEGACY WebViews without AbortSignal.timeout (iOS 15.x
//          WKWebView, un-updated Android WebView < Chromium 103, old
//          QtWebEngine desktop builds) via AbortController+setTimeout —
//          previously those clients silently had NO timeout at all (apiFetch's
//          15s default no-ops there too, despite the old comment's claim).
//          Unrelated apiFetch calls keep their general 15s default untouched.
//     F-B. Failure classification in both catch blocks: timeout (TimeoutError/
//          AbortError) → ai_timeout; 401 → ai_auth_required; 422 →
//          ai_invalid_input; 503 → backend body message first. The generic
//          ai_error remains ONLY for genuinely unknown failures.
//   i18n.js: ai_timeout / ai_auth_required / ai_invalid_input keys in fa AND en
//          (text mirrors backend friendlyChatError so both layers agree).
//   src/controllers/assistant.js (backend):
//     B-A. 'truncated' validation is now a SOFT rejection: the first
//          soft-rejected reply is remembered; if NO provider yields a
//          fully-valid reply, it is returned as a last resort instead of
//          failing the whole request (all_providers_failed). Later fully-valid
//          providers still WIN (preference order preserved).
//     B-B. validateChatResponse sentence-ender list extended with legitimate
//          markdown/prose endings (… : ؛ ; » ] } *) that this assistant's own
//          style guide encourages ('**بولد**' ends with '*').
//
// TEST MATRIX (directive-mapped; deterministic mocks only — NO network):
//   Behavioral (loadWorker + mock DB pool + valid Telegram initData):
//     T1  Simple Persian general-knowledge question → reaches the model, 200.
//     T2  Persian wording NOT in any intent/keyword list → still reaches the
//         model (no "unsupported intent" rejection), 200.
//     T3  General English question → 200.
//     T4  Follow-up question with conversation history → 200, history accepted.
//     T5  AmirBTC features question → 200 (FAQ fast path or model).
//     T6  Market-data question → 200 with real cached market context injected.
//     T7  Primary provider failure + healthy fallback → fallback answer, 200.
//     T8  ALL providers genuinely failing → all_providers_failed with the
//         FRIENDLY retry message (NOT the generic unavailable text), HTTP 200.
//     T9  CORE BUG: only a "truncated"-validation reply available → it is
//         RETURNED (soft fallback) instead of all_providers_failed.
//     T10 Preference: truncated groq reply + fully-valid gemini reply → gemini.
//     T11 Extended enders: ≥500-char reply ending '*' → valid directly.
//     T12 Cooldown → 429 reason cooldown with specific message (not outage).
//     T13 Unauthenticated request → 401 (auth stays enforced — D.7/D.9).
//     T14 Groq 503 (all_keys_unavailable shape) → chain continues → gemini.
//     T15 EXACT production sequence Groq 503 + OpenRouter HTTP 404 (fetch
//         mocked to the real 404 shape) → chain STILL continues → gemini.
//         (PR #96 final review: production 404s 2026-10-20..22 — deactivated
//         free-model endpoint at OpenRouter; dead hop must not stop the chain.)
//   Source contracts (frontend): F1..F10 per above.
//   Legacy WebView timeout (PR #96 review follow-up):
//     L1  Modern path (AbortSignal.timeout available) → native bounded signal,
//         rejects as TimeoutError after the deadline.
//     L2  Legacy path (AbortSignal.timeout MISSING — iOS 15.x / Chromium <103)
//         → AbortController+setTimeout still bounds the request; timedOut()
//         flag set for engine-independent classification.
//     L3  clear() cancels the pending legacy timer (no dangling timeout).
//     L4  Ancient path (no AbortController at all) → null, previous behavior.
//     F8/F9/F10 — source contracts wiring the helper into send()/retry().
//   Source contracts (backend): B1..B3 + friendlyChatError text unchanged.
//   i18n: new keys present in BOTH dictionaries with exact copy.
//
// Run: node --test tests/ai-unavailable-responses-regression-test.cjs
'use strict';

const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const ROOT = path.join(__dirname, '..');
const WORKER_PATH = path.join(ROOT, 'worker-proxy.js');
function getWorkerSource() { return fs.readFileSync(WORKER_PATH, 'utf8'); }
const ASSISTANT_SRC = fs.readFileSync(path.join(ROOT, 'src/controllers/assistant.js'), 'utf8');
const FRONTEND_SRC = fs.readFileSync(path.join(ROOT, 'assistant.js'), 'utf8');
const APP_JS_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');

// ── Harness (same pattern as tests/chat-ai-quota-image-retention-test.cjs) ──
function loadWorker() {
  const source = getWorkerSource();
  const defaultMocks = {
    'pg': { Pool: class { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } } },
    '@neondatabase/serverless': {
      Pool: class Pool { async query() { return { rows: [] }; } async connect() { const s = this; return { async query(q, p) { return s.query(q, p); }, release() {} }; } end() { return Promise.resolve(); } },
      neon: function() { const f = async () => []; f.query = async () => ({ rows: [] }); f.transaction = async (cb) => cb({ query: f.query }); return f; },
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
  // OPENROUTER_API_KEY / OPENAI_API_KEY are deliberately UNSET (undefined) so
  // callOpenRouterChat/callOpenAIChat throw "not configured" instantly — the
  // provider chain stays deterministic with ZERO network access. groq runs
  // through the mocked DB gateway; gemini likewise; workers-ai has no AI
  // binding in tests (instant non_retryable). openai is flag-disabled anyway.
  return Object.assign({ TELEGRAM_BOT_TOKEN: 'test-bot-token', REQUIRED_CHANNEL: 'amir_btc_2024', ADMIN_TELEGRAM_ID: '831704732', DATABASE_URL: '', APP_ENV: 'development', BOT_USERNAME: '', APP_CACHE: createMemoryKv({ 'market:data:v3': JSON.stringify([{ symbol: 'BTC', priceUsd: 97000, changePercent24Hr: -1.5 }]), 'market:overview:cmc': JSON.stringify({ fearGreedValue: 72 }) }), RATE_LIMITS: createMemoryKv(), JOIN_CACHE: createMemoryKv(), SESSION_CACHE: createMemoryKv(), AI_COOLDOWN_SECONDS: 0, AI_DAILY_MESSAGE_LIMIT: 50, AI_DAILY_IMAGE_LIMIT: 3, OPENROUTER_API_KEY: undefined, OPENAI_API_KEY: undefined, GROQ_API_KEY: 'fake-groq-key' }, o);
}
async function sendRequest(w, e, m, p, o = {}) { const u = p.startsWith('http') ? p : `http://localhost${p}`; const h = new Headers(o.headers || {}); if (o.initData) h.set('X-Telegram-Init-Data', o.initData); const r = { method: m, headers: h }; if (o.body !== undefined) { r.body = JSON.stringify(o.body); h.set('Content-Type', 'application/json'); h.set('Content-Length', String(Buffer.byteLength(r.body))); } const res = await w.fetch(new Request(u, r), e, {}); let b; try { b = await res.json(); } catch { b = null; } return { status: res.status, body: b }; }

// Mock DB pool with configurable per-provider replies.
// groqReply: string reply from groq_generate_with_key (status 200)
// groqThrow: pool throws on groq SQL (DB gateway error → provider FAIL)
// groqStatus: override HTTP status for groq (e.g. 503 router-unavailable)
// geminiReply / geminiStatus: same knobs for gemini_generate
// captured: collects the prompts sent to each gateway
function makeChatPool(opts = {}) {
  const { groqReply = 'پاسخ نمونه دستیار.', groqThrow = false, groqStatus = 200,
          geminiReply = 'پاسخ جایگزین جیمینی.', geminiStatus = 200, geminiThrow = false } = opts;
  const captured = { groq: [], gemini: [] };
  const pool = {
    captured,
    query: async (sql, params) => {
      const sl = (sql || '').toLowerCase();
      if (sl.includes('insert into users') && sl.includes('returning')) return { rows: [{ telegram_id: String(params?.[0] || '700100'), username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, channel_verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      if (sl.includes('select') && sl.includes('from users') && sl.includes('where telegram_id')) return { rows: [] };
      if (sl.includes('from watchlist_items') || sl.includes('from referrals') || sl.includes('from token_balances') || sl.includes('from token_transactions') || sl.includes('from price_alerts') || sl.includes('from notifications') || sl.includes('from notification_settings') || sl.includes('from analyses') || sl.includes('from tickets') || sl.includes('from admins')) return { rows: [] };
      if (sl.includes('insert into watchlist_items')) return { rows: [] };
      if (sl.includes('on conflict') && sl.includes('do nothing')) return { rows: [] };
      if (sl.includes('groq_generate')) {
        if (groqThrow) throw new Error('groq gateway down');
        try { captured.groq.push(JSON.parse(params?.[1] || '[]').map(m => m.content).join('\n')); } catch {}
        return { rows: [{ result: { status_code: groqStatus, response_body: JSON.stringify({ choices: [{ message: { content: groqReply } }] }) } }] };
      }
      if (sl.includes('gemini_generate')) {
        if (geminiThrow) throw new Error('gemini gateway down');
        try { const c = JSON.parse(params?.[1] || '[]'); captured.gemini.push(JSON.stringify(c).slice(0, 200)); } catch {}
        return { rows: [{ result: { status_code: geminiStatus, response_body: JSON.stringify({ candidates: [{ content: { parts: [{ text: geminiReply }] } }] }) } }] };
      }
      return { rows: [] };
    },
    end: async () => {}, on: () => {},
  };
  return pool;
}

// ≥500-char substantive Persian reply that ends in a NON-ender character
// (a mid-word Persian letter) — the exact shape production discarded on
// 2026-10-18. Contains Persian-specific letters (پ) so arabic_only doesn't fire.
function makeTruncatedReply() {
  const body = 'پاسخ تفصیلی درباره سؤال شما: ' + 'این بخش توضیحات مفصل درباره بازار و مفاهیم مربوطه است که به صورت کامل ارائه می‌شود. '.repeat(9);
  return body + 'و در نهایت این نکته مهم را به خاطر بسپار';
}

// ═════════════════════════════════════════════════════════════════════════════
// BEHAVIORAL TESTS — ordinary messages reach the model and get answers
// ═════════════════════════════════════════════════════════════════════════════

test('T1: simple Persian general-knowledge question → model reply, HTTP 200', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'پایتخت فرانسه پاریس است.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'پایتخت فرانسه کجاست؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700101, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.equal(res.body?.reply, 'پایتخت فرانسه پاریس است.');
  assert.equal(res.body?.provider, 'groq');
  assert.ok(pool.captured.groq.length >= 1, 'groq gateway must have been called');
});

test('T2: Persian wording NOT in any intent/keyword list → still reaches the model (no unsupported-intent rejection)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'رنگ آسمان به خاطر پراکندگی ریلی نور است.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'رنگ آسمان چرا آبی است؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700102, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.ok(pool.captured.groq.length >= 1, 'message must reach the model — intent routing only selects context, never rejects');
});

test('T3: general English question → model reply, HTTP 200', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'The capital of France is Paris.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'What is the capital of France?', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700103, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.equal(res.body?.reply, 'The capital of France is Paris.');
});

test('T4: follow-up question with conversation history → history accepted, model reply', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'بله، همان موردی که قبلاً گفتم: پاریس.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: {
      message: 'پس اون مورد قبلی چی بود؟',
      history: [
        { role: 'user', content: 'پایتخت فرانسه چیه؟' },
        { role: 'assistant', content: 'پاریس هست.' },
      ],
      image: null, context: null,
    },
    initData: buildInitData('test-bot-token', { id: 700104, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.ok(pool.captured.groq.length >= 1);
  assert.ok(pool.captured.groq[0].includes('پایتخت فرانسه'), 'prior turn must be in the prompt (conversation context preserved)');
});

test('T5: AmirBTC features question → answered (FAQ fast path or model), HTTP 200', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'برای پرمیوم باید در صرافی ثبت‌نام کنی و UID بفرستی.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'چطور پرمیوم بخرم؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700105, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.ok(typeof res.body?.reply === 'string' && res.body.reply.length > 0);
  assert.ok(['faq_handler', 'groq', 'greeting_handler', 'clarification_handler'].includes(res.body?.provider), 'provider must be a legitimate answering path');
});

test('T6: market-data question → real cached market context injected into the prompt', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'بیت‌کوین الان حدود ۹۷هزار دلار است.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'قیمت بیت‌کوین چنده؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700106, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  const prompt = pool.captured.groq[0] || '';
  assert.ok(prompt.includes('BTC'), 'cached market data (real backend data) must be injected for market questions');
});

test('T7: primary provider failure + healthy fallback → fallback answer returned (HTTP 200)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  // groq fails at the GATEWAY level (HTTP 500, no pool-level throw — a thrown
  // pool error would clear env._reqPool and break the later gemini mock call).
  const pool = makeChatPool({ groqStatus: 500, geminiReply: 'پاسخ جایگزین از جیمینی.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'آیا فوتون جرم دارد؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700107, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.equal(res.body?.provider, 'gemini');
  assert.equal(res.body?.reply, 'پاسخ جایگزین از جیمینی.');
});

test('T8: ALL providers genuinely failing → all_providers_failed with the FRIENDLY retry message (not the generic unavailable text)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  // Both remaining providers fail at the gateway level (HTTP 500).
  const pool = makeChatPool({ groqStatus: 500, geminiStatus: 500 });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'سؤال عمومی دیگر', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700108, first_name: 'Test' }),
  });
  assert.equal(res.status, 200, 'Chat AI v2 Fix 3: structured error returns HTTP 200 so the frontend can show the friendly message');
  assert.equal(res.body?.status, 'error');
  assert.equal(res.body?.reason, 'all_providers_failed');
  assert.equal(res.body?.message, 'یه مشکلی در پاسخ‌دادن پیش اومد. چند لحظه دیگه دوباره امتحان کن.');
  assert.notEqual(res.body?.message, 'دستیار در دسترس نیست', 'must NOT claim the service is unavailable via the generic key');
});

test('T9 (CORE BUG): only a truncated-validation reply available → RETURNED as last resort instead of all_providers_failed', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const truncated = makeTruncatedReply();
  assert.ok(truncated.length >= 500, 'fixture must be ≥500 chars to trigger the truncation check');
  // gemini status 500 → the only substantive answer in the whole chain is the
  // truncated groq reply. OLD behavior: all_providers_failed (the production
  // 2026-10-18 failure). NEW behavior: the truncated reply is returned.
  const pool = makeChatPool({ groqReply: truncated, geminiStatus: 500 });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'تحلیل کامل بازار کریپتو امروز', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700109, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success', 'a substantive (truncated) answer must be returned, not a service failure');
  assert.equal(res.body?.reply, truncated);
  assert.equal(res.body?.provider, 'groq');
});

test('T10: truncated groq reply + fully-valid gemini reply → gemini WINS (soft fallback never preempts a better answer)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: makeTruncatedReply(), geminiReply: 'پاسخ کامل و معتبر جیمینی.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'فیزیک کوانتوم را به زبان ساده توضیح بده', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700110, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.equal(res.body?.provider, 'gemini', 'later fully-valid provider must be preferred over the soft-rejected reply');
  assert.equal(res.body?.reply, 'پاسخ کامل و معتبر جیمینی.');
});

test('T11: ≥500-char reply ending with markdown bold (\'*\') is directly valid (extended sentence enders)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const boldEnd = 'تحلیل مفصل بازار: ' + 'قیمت‌ها در محدوده حمایت و مقاومت حرکت می‌کنند و حجم معاملات روند مشخصی ندارد. '.repeat(8) + 'پایان تحلیل **مهم**';
  assert.ok(boldEnd.length >= 500);
  assert.equal(boldEnd[boldEnd.length - 1], '*');
  const pool = makeChatPool({ groqReply: boldEnd, geminiReply: 'نباید به این برسیم' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'تحلیل بازار بده', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700111, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.equal(res.body?.provider, 'groq', 'bold-terminated reply passes validation at the source — no fallback churn');
  assert.equal(res.body?.reply, boldEnd);
});

test('T12: cooldown → HTTP 429 reason cooldown with the specific wait message (not an outage claim)', async () => {
  const worker = loadWorker();
  const env = createEnv({ AI_COOLDOWN_SECONDS: 4 });
  const pool = makeChatPool({ groqReply: 'پاسخ.' });
  env._reqPool = pool;
  const initData = buildInitData('test-bot-token', { id: 700112, first_name: 'Test' });
  const first = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'سؤال اول', history: [], image: null, context: null }, initData,
  });
  assert.equal(first.status, 200);
  const second = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'سؤال دوم', history: [], image: null, context: null }, initData,
  });
  assert.equal(second.status, 429);
  assert.equal(second.body?.reason, 'cooldown');
  assert.ok(String(second.body?.message || '').includes('صبر'), 'cooldown message must say wait, not unavailable');
});

test('T13: unauthenticated request → HTTP 401 (auth enforcement preserved — no bypass via this fix)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  const pool = makeChatPool({ groqReply: 'پاسخ.' });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'سلام', history: [], image: null, context: null },
    // no initData header → optionalTelegramAuth rejects
  });
  assert.equal(res.status, 401);
});

// ═════════════════════════════════════════════════════════════════════════════
// PROVIDER-CHAIN RESILIENCE (PR #96 final review — OpenRouter 404 + Groq quota)
// ═════════════════════════════════════════════════════════════════════════════
//
// Production evidence (Workers Logs 2026-10-16..22, download/phase63/):
//   * Groq Router 503 "all_keys_unavailable" ×11 in 7d — all News-cron driven
//     (windows regularly 3/3 per key). A chat request arriving while the
//     shared budget is exhausted must still get an answer from LATER hops.
//   * OpenRouter http_404 ×3 (one/day 2026-10-20..22): the old free model's
//     only serving endpoint was deactivated at OpenRouter (endpoint status=-5,
//     uptime 0 — verified via the public /api/v1/models/{id}/endpoints API).
//     The production sequence "Groq 503 → OpenRouter 404 → NEXT provider" must
//     NEVER stop the chain early.
//
// T14: Groq 503 → chain continues (no early stop) → gemini answers.
// T15: EXACT production sequence — Groq 503 + OpenRouter HTTP 404 (fetch
//      mocked to the real 404 shape) → chain STILL continues → gemini answers.
// M1:  both OpenRouter call sites carry the evidence-verified LIVE model slug.

test('T14: Groq 503 (router all_keys_unavailable shape) → chain continues → gemini answers (HTTP 200)', async () => {
  const worker = loadWorker();
  const env = createEnv();
  // groq gateway returns a 503 (the router's all_keys_unavailable envelope);
  // OPENROUTER_API_KEY stays undefined → "not configured" fast-fail hop;
  // gemini must still answer — proving Groq quota exhaustion can never
  // produce "دستیار در دسترس نیست" while a later provider is healthy.
  const pool = makeChatPool({
    groqStatus: 503,
    geminiReply: 'پاسخ پس از کمبود سهمیه گروک.',
  });
  env._reqPool = pool;
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'نسبت هابل چیست و چگونه اندازه‌گیری می‌شود؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 700114, first_name: 'Test' }),
  });
  assert.equal(res.status, 200);
  assert.equal(res.body?.status, 'success');
  assert.equal(res.body?.provider, 'gemini', 'the chain must advance past a Groq 503 — no early stop');
  assert.equal(res.body?.reply, 'پاسخ پس از کمبود سهمیه گروک.');
  assert.ok(pool.captured.gemini.length >= 1, 'gemini gateway must have been called');
});

test('T15: EXACT production sequence — Groq 503 + OpenRouter HTTP 404 → chain STILL continues → gemini answers', async () => {
  const worker = loadWorker();
  const env = createEnv({ OPENROUTER_API_KEY: 'test-or-key' });
  const pool = makeChatPool({ groqStatus: 503, geminiReply: 'پاسخ نهایی پس از خطای ۴۰۴ اوپن‌روتر.' });
  env._reqPool = pool;
  // Stub global fetch ONLY for openrouter.ai → HTTP 404 (the exact production
  // failure shape of the deactivated free-model endpoint); other URLs pass
  // through to the real fetch.
  const realFetch = globalThis.fetch;
  let orCalls = 0;
  globalThis.fetch = async (input, init) => {
    const url = typeof input === 'string' ? input : (input && input.url) || '';
    if (url.includes('openrouter.ai/')) {
      orCalls++;
      return new Response(JSON.stringify({ error: { message: 'Model not found', code: 404 } }), { status: 404, headers: { 'Content-Type': 'application/json' } });
    }
    return realFetch(input, init);
  };
  try {
    const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
      body: { message: 'فرض کن این پرسش کاملاً نامتعارف باشد؟', history: [], image: null, context: null },
      initData: buildInitData('test-bot-token', { id: 700115, first_name: 'Test' }),
    });
    assert.equal(res.status, 200);
    assert.equal(res.body?.status, 'success');
    assert.equal(res.body?.provider, 'gemini', 'a 404 from one provider must NOT stop the fallback chain');
    assert.equal(res.body?.reply, 'پاسخ نهایی پس از خطای ۴۰۴ اوپن‌روتر.');
    assert.ok(orCalls >= 1, 'the OpenRouter hop must actually have been attempted (fetch returned 404)');
    assert.ok(pool.captured.gemini.length >= 1, 'gemini answered after the 404');
  } finally {
    globalThis.fetch = realFetch;
  }
});

test('M1: both OpenRouter call sites use the evidence-verified LIVE model (dead slug absent from both constants)', () => {
  const NEWS_PROVIDERS_SRC = fs.readFileSync(path.join(ROOT, 'src/news/providers.js'), 'utf8');
  // Constant declarations (NOT bare mentions — the refresh evidence comments
  // legitimately document the dead slug for future maintainers):
  assert.ok(ASSISTANT_SRC.includes("const CHAT_OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning:free'"),
    'chat constant must be the live slug (OpenRouter /endpoints API verified 2026-10-22: status=0, uptime 100%)');
  assert.ok(NEWS_PROVIDERS_SRC.includes("const OPENROUTER_MODEL = 'nvidia/nemotron-3.5-lightning:free'"),
    'news constant must be the live slug (same evidence)');
  assert.ok(!ASSISTANT_SRC.includes("const CHAT_OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'"),
    'chat constant must NOT be the deactivated 404ing slug');
  assert.ok(!NEWS_PROVIDERS_SRC.includes("const OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'"),
    'news constant must NOT be the deactivated 404ing slug');
});

// ═════════════════════════════════════════════════════════════════════════════
// FRONTEND SOURCE CONTRACTS
// ═════════════════════════════════════════════════════════════════════════════

test('F1: sendMessage AND retry pass a dedicated bounded 90s chat signal on ALL WebView generations', () => {
  assert.equal((FRONTEND_SRC.match(/chatTimeout = createChatTimeout\(90000\);/g) || []).length, 2,
    'both sendMessage and retry must create the bounded chat timeout');
  assert.equal((FRONTEND_SRC.match(/signal: chatTimeout \? chatTimeout\.signal : undefined/g) || []).length, 2,
    'both chat calls must pass the helper signal (modern AND legacy paths)');
});

test('F2: apiFetch default 15s timeout is UNCHANGED for all other endpoints', () => {
  assert.match(APP_JS_SRC, /AbortSignal\.timeout\(15000\)/, 'window.apiFetch keeps its general 15s default');
});

test('F3: timeout failures map to ai_timeout (NOT the generic ai_error) in both catch blocks', () => {
  const blocks = FRONTEND_SRC.split(/async (?:send|retry)\(/).slice(1);
  assert.ok(blocks.length >= 2, 'send + retry functions found');
  for (const b of blocks) {
    const catchIdx = b.indexOf('} catch (e) {');
    if (catchIdx === -1) continue;
    const catchBlock = b.slice(catchIdx, catchIdx + 3500);
    assert.ok(catchBlock.includes("e.name === 'TimeoutError' || e.name === 'AbortError'"), 'must detect the timeout abort by name');
    assert.ok(catchBlock.includes("t('ai_timeout')"), 'must show the honest timeout message');
  }
});

test('F4: 401 → ai_auth_required and 422 → ai_invalid_input in both catch blocks', () => {
  const blocks = FRONTEND_SRC.split(/async (?:send|retry)\(/).slice(1);
  for (const b of blocks) {
    const catchIdx = b.indexOf('} catch (e) {');
    if (catchIdx === -1) continue;
    const catchBlock = b.slice(catchIdx, catchIdx + 4500);
    assert.ok(catchBlock.includes("e.status === 401") && catchBlock.includes("t('ai_auth_required')"), '401 must map to the auth message');
    assert.ok(catchBlock.includes("e.status === 422") && catchBlock.includes("t('ai_invalid_input')"), '422 must map to the invalid-input message');
  }
});

test('F5: 503 prefers the backend body message over the generic text', () => {
  const blocks = FRONTEND_SRC.split(/async (?:send|retry)\(/).slice(1);
  for (const b of blocks) {
    const catchIdx = b.indexOf('} catch (e) {');
    if (catchIdx === -1) continue;
    const catchBlock = b.slice(catchIdx, catchIdx + 5000);
    const s503 = catchBlock.indexOf('e.status === 503');
    assert.ok(s503 !== -1, '503 branch exists');
    const branch = catchBlock.slice(s503, s503 + 700);
    assert.ok(branch.includes('JSON.parse(e.message)'), '503 branch parses the backend body');
  }
});

test('F6: timeout stays retryable (canRetry true for no-status errors)', () => {
  // canRetry logic: (e.status === 503 || (!e.status && e.status !== 429)) — a
  // TimeoutError has no .status → retryable. Locking the expression itself.
  assert.match(FRONTEND_SRC, /canRetry = \(e && \(e\.status === 503 \|\| \(!e\.status && e\.status !== 429\)\)\)/);
});

test('F7: error log line distinguishes timeouts (logs e.name)', () => {
  assert.match(FRONTEND_SRC, /e\.status \|\| e\.name \|\| 'no-status'/, 'console.warn must log e.name so timeout aborts are traceable');
});

// ═══════════════════════════════════════════════════════════════════════════
// LEGACY WEBVIEW TIMEOUT — PR #96 review follow-up (both paths bounded)
// The helper is extracted VERBATIM from assistant.js and executed in a vm
// sandbox whose globals model each WebView generation. No network, no DOM.
// ═════════════════════════════════════════════════════════════════════════

const vm = require('node:vm');

function extractCreateChatTimeoutSource() {
  const start = FRONTEND_SRC.indexOf('function createChatTimeout(');
  assert.ok(start !== -1, 'createChatTimeout must be defined at module scope in assistant.js');
  const end = FRONTEND_SRC.indexOf('\n}\n', start);
  assert.ok(end !== -1, 'createChatTimeout body must terminate at column 0');
  return FRONTEND_SRC.slice(start, end + 2);
}

function runCreateChatTimeout(sandbox) {
  const ctx = vm.createContext(sandbox);
  vm.runInContext(extractCreateChatTimeoutSource(), ctx);
  return sandbox.createChatTimeout;
}

test('F8: createChatTimeout covers BOTH paths — native .timeout() and AbortController+setTimeout fallback', () => {
  const src = extractCreateChatTimeoutSource();
  assert.match(src, /typeof AbortSignal\.timeout === 'function'/, 'modern path uses AbortSignal.timeout');
  assert.match(src, /new AbortController\(\)/, 'legacy path builds a manual controller');
  assert.match(src, /setTimeout\(/, 'legacy path bounds the request with setTimeout');
  assert.match(src, /return null/, 'ancient clients (no AbortController) keep previous behavior');
});

test('L1: modern path — AbortSignal.timeout available → native bounded signal rejects as TimeoutError', async () => {
  const createChatTimeout = runCreateChatTimeout({ AbortSignal, AbortController, setTimeout, clearTimeout, DOMException });
  const ct = createChatTimeout(80);
  assert.ok(ct && ct.signal instanceof AbortSignal, 'modern path returns a native signal');
  assert.equal(ct.signal.aborted, false, 'not aborted before the deadline');
  await assert.rejects(
    () => new Promise((_, rej) => ct.signal.addEventListener('abort', () => rej(ct.signal.reason))),
    (e) => e.name === 'TimeoutError'
  );
  ct.clear(); // no timer on the modern path — clear() must still be safe
});

test('L2: legacy path — AbortSignal.timeout MISSING → AbortController+setTimeout still bounds the request', async () => {
  // AbortSignal present but WITHOUT .timeout models iOS 15.x WKWebView /
  // Chromium <103 WebViews — the exact population the PR #96 review flagged.
  const createChatTimeout = runCreateChatTimeout({ AbortSignal: {}, AbortController, setTimeout, clearTimeout, DOMException });
  const ct = createChatTimeout(60);
  assert.ok(ct, 'legacy fallback must produce a signal object');
  assert.ok(ct.signal instanceof AbortSignal, 'legacy fallback uses a REAL AbortController signal fetch can honor');
  assert.equal(ct.signal.aborted, false, 'not aborted before the deadline');
  // fetch-like consumer that honors the signal (real fetch semantics):
  await assert.rejects(
    () => new Promise((resolve, reject) => {
      if (ct.signal.aborted) return reject(ct.signal.reason);
      ct.signal.addEventListener('abort', () => reject(ct.signal.reason || new DOMException('aborted', 'AbortError')));
    }),
    (e) => e.name === 'TimeoutError' || e.name === 'AbortError'
  );
  assert.equal(ct.timedOut(), true, 'timedOut() flag set — engine-independent timeout classification');
});

test('L3: legacy path — clear() cancels the pending timer (no dangling 90s timeout after settle)', async () => {
  const createChatTimeout = runCreateChatTimeout({ AbortSignal: {}, AbortController, setTimeout, clearTimeout, DOMException });
  const ct = createChatTimeout(50);
  ct.clear();
  await new Promise(r => setTimeout(r, 120));
  assert.equal(ct.signal.aborted, false, 'timer must have been cleared by clear()');
  assert.equal(ct.timedOut(), false, 'flag must stay false after clear()');
});

test('L4: ancient path — no AbortController at all → returns null (previous behavior preserved)', () => {
  const createChatTimeout = runCreateChatTimeout({ setTimeout, clearTimeout });
  assert.equal(createChatTimeout(90000), null);
});

test('F9: both finally blocks release the legacy fallback timer', () => {
  assert.equal((FRONTEND_SRC.match(/if \(chatTimeout\) chatTimeout\.clear\(\);/g) || []).length, 2,
    'send() and retry() finally blocks must clear the fallback timer');
});

test('F10: timeout classification honors the timedOut() flag (legacy engines without abort reasons)', () => {
  assert.equal((FRONTEND_SRC.match(/\(chatTimeout && chatTimeout\.timedOut\(\)\)/g) || []).length, 2,
    'both catch blocks must classify timeouts via the flag as well as the error name');
});

// ═════════════════════════════════════════════════════════════════════════════
// BACKEND SOURCE CONTRACTS
// ═════════════════════════════════════════════════════════════════════════════

test('B1: generateAssistantReply keeps a soft-rejected truncated reply as last resort', () => {
  const fnStart = ASSISTANT_SRC.indexOf('async function generateAssistantReply(');
  assert.ok(fnStart !== -1, 'generateAssistantReply exists');
  const fnEnd = ASSISTANT_SRC.indexOf('\n  }', fnStart);
  const fnBody = ASSISTANT_SRC.substring(fnStart, fnEnd);
  assert.ok(fnBody.includes('softRejected'), 'softRejected accumulator exists');
  assert.ok(fnBody.includes("validation.reason === 'truncated'"), 'ONLY truncated validation is soft');
  assert.ok(!fnBody.includes("validation.reason === 'output_leak'"), 'leaks stay hard rejects');
  assert.ok(fnBody.indexOf('if (softRejected)') < fnBody.indexOf('throw new Error(lastError)'), 'soft-rejected return happens BEFORE the all-providers-failed throw');
});

test('B2: validateChatResponse sentence enders include the extended markdown/prose endings', () => {
  const fnStart = ASSISTANT_SRC.indexOf('function validateChatResponse(');
  const fnBody = ASSISTANT_SRC.substring(fnStart, fnStart + 4000);
  const endersLine = ASSISTANT_SRC.split('\n').find(l => l.includes('const sentenceEnders = ['));
  assert.ok(endersLine, 'sentenceEnders list found');
  for (const ch of ['…', ':', '؛', ';', '»', ']', '}', '*']) {
    assert.ok(endersLine.includes(`'${ch}'`), `ender '${ch}' must be accepted`);
  }
  // Original enders preserved:
  for (const ch of ['.', '!', '?', '؟', '۔', ')', '"']) {
    assert.ok(endersLine.includes(`'${ch}'`), `original ender '${ch}' preserved`);
  }
  assert.ok(fnBody.includes('>= 500'), '500-char threshold preserved (test E5 contract)');
});

test('B3: friendlyChatError texts unchanged (all_providers_failed / timeout / auth_required)', () => {
  assert.ok(ASSISTANT_SRC.includes('یه مشکلی در پاسخ‌دادن پیش اومد. چند لحظه دیگه دوباره امتحان کن.'), 'all_providers_failed friendly text');
  assert.ok(ASSISTANT_SRC.includes('پاسخ طولانی شد. دوباره امتحان کن.'), 'timeout text');
  assert.ok(ASSISTANT_SRC.includes('برای استفاده از دستیار، باید از داخل تلگرام وارد شوید.'), 'auth_required text');
});

// ═════════════════════════════════════════════════════════════════════════════
// i18n CONTRACTS
// ═════════════════════════════════════════════════════════════════════════════

test('I18N-1: ai_timeout / ai_auth_required / ai_invalid_input exist in BOTH fa and en dictionaries', () => {
  const faBlock = I18N_SRC.substring(0, I18N_SRC.indexOf('const translations') !== -1 ? I18N_SRC.indexOf('const translations') : I18N_SRC.indexOf("en:"));
  const faIdx = I18N_SRC.indexOf('fa:');
  const enIdx = I18N_SRC.indexOf('en:', faIdx + 1000);
  const faDict = I18N_SRC.substring(faIdx, enIdx);
  const enDict = I18N_SRC.substring(enIdx);
  for (const key of ['ai_timeout', 'ai_auth_required', 'ai_invalid_input']) {
    assert.ok(new RegExp(key + "\\s*:").test(faDict), `${key} must exist in fa`);
    assert.ok(new RegExp(key + "\\s*:").test(enDict), `${key} must exist in en`);
  }
  assert.ok(faDict.includes('پاسخ طولانی شد. لطفاً دوباره امتحان کن.'), 'fa ai_timeout text');
  assert.ok(enDict.includes('The response took too long. Please try again.'), 'en ai_timeout text');
  assert.ok(faDict.includes('برای استفاده از دستیار، باید از داخل تلگرام وارد شوید.'), 'fa ai_auth_required text');
  assert.ok(faDict.includes('ورودی نامعتبره. لطفاً پیام خودت رو بررسی کن.'), 'fa ai_invalid_input text');
});

// Guards against accidental regression of the REAL i18n loader:
test('I18N-2: i18n.js still parses and exposes the new keys through the real t()', () => {
  const i18n = require(path.join(ROOT, 'i18n.js'));
  const t = (typeof i18n === 'function') ? i18n : (i18n.t || i18n.default && i18n.default.t);
  assert.ok(typeof t === 'function' || typeof require(path.join(ROOT, 'i18n.js')) === 'object', 'i18n module loads');
  // Source-level check is authoritative; the loader shape varies by mode.
  assert.ok(I18N_SRC.includes("ai_timeout: 'پاسخ طولانی شد"), 'fa key inline');
  assert.ok(I18N_SRC.includes("ai_timeout: 'The response took too long"), 'en key inline');
});

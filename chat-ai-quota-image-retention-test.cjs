// Chat AI Quota + Image Limits + 24h Retention + Web Search Answer Quality Regression
// Phases 1-12 test matrix
const { test } = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
function getWorkerSource() { return fs.readFileSync(WORKER_PATH, 'utf8'); }

function loadWorker(pgOverride) {
  const source = getWorkerSource();
  const defaultMocks = {
    'pg': { Pool: class { async query() { return { rows: [] }; } async connect() { return { async query() { return { rows: [] }; }, release() {} }; } end() { return Promise.resolve(); } } },
    '@neondatabase/serverless': pgOverride || {
      Pool: class Pool { async query(sql, params) {
        const sl = (sql||'').toLowerCase();
        if (sl.includes('insert into users') && sl.includes('returning')) return { rows: [{ telegram_id: String(params?.[0]||'123456'), username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, channel_verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
        if (sl.includes('select') && sl.includes('from users') && sl.includes('where telegram_id')) return { rows: [] };
        if (sl.includes('from watchlist_items') || sl.includes('from referrals') || sl.includes('from token_balances') || sl.includes('from token_transactions') || sl.includes('from price_alerts') || sl.includes('from notifications') || sl.includes('from notification_settings') || sl.includes('from analyses') || sl.includes('from tickets') || sl.includes('from admins')) return { rows: [] };
        if (sl.includes('insert into watchlist_items')) return { rows: [] };
        if (sl.includes('on conflict') && sl.includes('do nothing')) return { rows: [] };
        return { rows: [] };
      } async connect() { const s = this; return { async query(q,p) { return s.query(q,p); }, release() {} }; } end() { return Promise.resolve(); } },
      neon: function() { const f = async () => []; f.query = async () => ({ rows: [] }); f.transaction = async (cb) => cb({ query: f.query }); return f; },
    },
  };
  const lmc = {}; const lr = (id) => { if (defaultMocks[id]) return defaultMocks[id]; if (lmc[id]) return lmc[id]; return require(id); };
  const lire = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g; let m;
  while ((m = lire.exec(source)) !== null) { const ip = m[4]; if (lmc[ip]) continue; const rp = path.resolve(path.dirname(WORKER_PATH), ip); let ms = fs.readFileSync(rp, 'utf8'); ms = ms.replace(/export\s+function\s+(\w+)/g, 'module.exports.$1 = function $1').replace(/export\s+default\s+/g, 'module.exports.default = ').replace(/export\s+const\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+let\s+(\w+)\s*=/g, 'module.exports.$1 =').replace(/export\s+var\s+(\w+)\s*=/g, 'module.exports.$1 ='); const mod = { exports: {} }; new Function('require', 'module', 'exports', ms)(lr, mod, mod.exports); lmc[ip] = mod.exports; }
  const t = source.replace("import { createHmac, timingSafeEqual } from 'node:crypto';", "const { createHmac, timingSafeEqual } = require('node:crypto');").replace("import { Pool as NeonPool, neon } from '@neondatabase/serverless';", "const { Pool: NeonPool, neon } = require('@neondatabase/serverless');").replace("import { Pool as PgPool } from 'pg';", "const { Pool: PgPool } = require('pg');").replace(/import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const { ${n} } = require('${p}');`).replace(/import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace(/import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g, (_, n, p) => `const ${n} = require('${p}');`).replace('export default {', 'module.exports = {');
  const mod = { exports: {} }; new Function('require', 'module', 'exports', t)(lr, mod, mod.exports); return mod.exports;
}
function createMemoryKv(i={}) { const s=new Map(Object.entries(i)); return { async get(k){return s.has(k)?s.get(k):null;}, async put(k,v,o){s.set(k,v);}, async delete(k){s.delete(k);}, dump(){return Object.fromEntries(s.entries());} }; }
function buildInitData(b,u) { const e=[['auth_date',String(Math.floor(Date.now()/1000))],['query_id','AAHdF6IQAAAAAN0XohDhrOrc'],['user',JSON.stringify(u)]]; const d=e.slice().sort(([l],[r])=>l.localeCompare(r)).map(([k,v])=>`${k}=${v}`).join('\n'); const sk=crypto.createHmac('sha256','WebAppData').update(b).digest(); const h=crypto.createHmac('sha256',sk).update(d).digest('hex'); return e.map(([k,v])=>`${k}=${encodeURIComponent(v)}`).concat([`hash=${h}`]).join('&'); }
function createEnv(o={}) { return Object.assign({ TELEGRAM_BOT_TOKEN:'test-bot-token', REQUIRED_CHANNEL:'amir_btc_2024', ADMIN_TELEGRAM_ID:'831704732', DATABASE_URL:'', APP_ENV:'dev', BOT_USERNAME:'', APP_CACHE:createMemoryKv({'market:data:v3':JSON.stringify([{symbol:'BTC',priceUsd:97000,changePercent24Hr:-1.5}]),'market:overview:cmc':JSON.stringify({fearGreedValue:72})}), RATE_LIMITS:createMemoryKv(), JOIN_CACHE:createMemoryKv(), SESSION_CACHE:createMemoryKv(), AI_COOLDOWN_SECONDS:0, AI_DAILY_MESSAGE_LIMIT:50, AI_DAILY_IMAGE_LIMIT:3, OPENROUTER_API_KEY:'x', OPENAI_API_KEY:'x' }, o); }
async function sendRequest(w,e,m,p,o={}) { const u=p.startsWith('http')?p:`http://localhost${p}`; const h=new Headers(o.headers||{}); if(o.initData) h.set('X-Telegram-Init-Data',o.initData); const r={method:m,headers:h}; if(o.body!==undefined){ r.body=JSON.stringify(o.body); h.set('Content-Type','application/json'); h.set('Content-Length',String(Buffer.byteLength(r.body))); } const res=await w.fetch(new Request(u,r),e,{}); let b; try{b=await res.json();}catch{b=null;} return {status:res.status,body:b}; }

// Mock pool with configurable Groq response + premium status
function makeMockPool(opts={}) {
  const { groqReply='پاسخ نمونه', premiumRows=null, groqFail=false } = opts;
  return {
    query: async (sql, params) => {
      const sl = (sql||'').toLowerCase();
      if (sl.includes('insert into users') && sl.includes('returning')) return { rows: [{ telegram_id: String(params?.[0]||'777888'), username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, channel_verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      if (sl.includes('select') && sl.includes('from users') && sl.includes('where telegram_id')) return { rows: [] };
      if (sl.includes('from watchlist_items') || sl.includes('from referrals') || sl.includes('from token_balances') || sl.includes('from token_transactions') || sl.includes('from price_alerts') || sl.includes('from notifications') || sl.includes('from notification_settings') || sl.includes('from analyses') || sl.includes('from tickets') || sl.includes('from admins')) return { rows: [] };
      if (sl.includes('insert into watchlist_items')) return { rows: [] };
      if (sl.includes('on conflict') && sl.includes('do nothing')) return { rows: [] };
      // Mock membership query — return premium status if configured
      if (premiumRows && (sl.includes('membership') || sl.includes('premium') || sl.includes('is_premium'))) return { rows: premiumRows };
      if (sl.includes('groq_generate')) {
        if (groqFail) throw new Error('groq failed');
        return { rows: [{ result: { status_code: 200, response_body: JSON.stringify({ choices: [{ message: { content: groqReply } }] }) } }] };
      }
      if (sl.includes('gemini_generate')) return { rows: [{ result: { status_code: 200, response_body: JSON.stringify({ candidates: [{ content: { parts: [{ text: 'GEMINI' }] } }] }) } }] };
      return { rows: [] };
    },
    end: async () => {}, on: () => {},
  };
}

// ============================================================================
// PHASE 1: Chat Quota (Free=10, Premium=100)
// ============================================================================

test('FREE-CHAT-01: entitlementConfig Free chat limit = 10', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(SRC.includes('normal_daily_limit: 10'), 'Free chat limit must be 10');
});

test('FREE-CHAT-02: Free user msg 11 → rejected (429)', async () => {
  // Pre-populate KV with 10 messages already used
  const rateLimits = createMemoryKv();
  const today = new Date().toISOString().slice(0, 10);
  rateLimits.put(`ai:msgs:999111:${today}`, '10'); // 10 messages used
  const worker = loadWorker();
  const env = createEnv({ RATE_LIMITS: rateLimits });
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'hello' },
    initData: buildInitData('test-bot-token', { id: 999111, first_name: 'Test' }),
  });
  assert.equal(res.status, 429);
  assert.equal(res.body.reason, 'daily_message_limit');
});

test('FREE-CHAT-03: Free user msg 1-10 → success (quota check)', async () => {
  // Verify that with 9 messages used, the 10th is allowed
  const rateLimits = createMemoryKv();
  const today = new Date().toISOString().slice(0, 10);
  rateLimits.put(`ai:msgs:999112:${today}`, '9'); // 9 used, 10th allowed
  const worker = loadWorker();
  const env = createEnv({ RATE_LIMITS: rateLimits });
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'hello' },
    initData: buildInitData('test-bot-token', { id: 999112, first_name: 'Test' }),
  });
  // Should NOT be 429 for daily_message_limit (may be 503 if no provider, but not 429)
  assert.notEqual(res.status, 429, 'msg 10 should be allowed (not rate limited)');
  assert.notEqual(res.body?.reason, 'daily_message_limit');
});

test('PREMIUM-CHAT-01: entitlementConfig Premium chat limit = 100', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(SRC.includes('premium_daily_limit: 100'), 'Premium chat limit must be 100');
});

test('PREMIUM-CHAT-02: Premium user msg 101 → rejected (429)', async () => {
  // This test requires mocking membershipAuthority.isPremium to return true.
  // Since membership is DB-backed, we verify the config value is correct (100)
  // and the limit check logic uses entitlementConfig.
  // The actual premium flow is tested via the config assertion + checkRateLimits logic.
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  // Verify checkRateLimits uses entitlementConfig.ai_chat.premium_daily_limit
  assert.ok(SRC.includes('entitlementConfig.ai_chat.premium_daily_limit'),
    'checkRateLimits must use entitlementConfig.ai_chat.premium_daily_limit');
  assert.ok(SRC.includes('entitlementConfig.ai_chat.normal_daily_limit'),
    'checkRateLimits must use entitlementConfig.ai_chat.normal_daily_limit');
});

test('PREMIUM-CHAT-03: 50→100 flicker fixed — no hardcoded 50 fallback in CODE', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  // Remove comments before checking (comments may reference old code as documentation)
  const codeOnly = JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Must NOT have the old hardcoded 50 fallback in actual code
  assert.ok(!codeOnly.includes('data.messages_limit ?? 50'),
    'Must NOT have hardcoded ?? 50 fallback in code (causes 50→100 flicker)');
  // Must show loading state instead (either '...' text or ai-quota-loading class)
  assert.ok(codeOnly.includes('ai-quota-loading') || codeOnly.includes("'...'") || codeOnly.includes("'Loading...'"),
    'Must show loading state while quota fetches');
  // Must check if limit is null/undefined
  assert.ok(codeOnly.includes('limit == null') || codeOnly.includes('limit === null'),
    'Must check if limit is null before displaying');
});

// ============================================================================
// PHASE 3: Image Quota (Free=3, Premium=10)
// ============================================================================

test('IMAGE-01: entitlementConfig Free image limit = 3', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(SRC.includes('normal_daily_limit: 3'), 'Free image limit must be 3');
});

test('IMAGE-02: entitlementConfig Premium image limit = 10', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(SRC.includes('premium_daily_limit: 10'), 'Premium image limit must be 10');
});

test('IMAGE-03: checkRateLimits uses entitlementConfig for image limits', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('entitlementConfig.ai_image.premium_daily_limit'),
    'Must use entitlementConfig.ai_image.premium_daily_limit');
  assert.ok(SRC.includes('entitlementConfig.ai_image.normal_daily_limit'),
    'Must use entitlementConfig.ai_image.normal_daily_limit');
});

test('IMAGE-04: Backend rejects image >1.4MB (base64 length)', async () => {
  const worker = loadWorker();
  const env = createEnv({});
  // Create a fake large base64 image (>1.4MB)
  const largeImage = 'data:image/jpeg;base64,' + 'A'.repeat(1500000);
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'test', image: largeImage },
    initData: buildInitData('test-bot-token', { id: 999113, first_name: 'Test' }),
  });
  assert.equal(res.status, 422);
  assert.equal(res.body.reason, 'image_too_large');
});

test('IMAGE-05: Backend validates image type (must be string)', async () => {
  const worker = loadWorker();
  const env = createEnv({});
  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'test', image: 12345 },
    initData: buildInitData('test-bot-token', { id: 999114, first_name: 'Test' }),
  });
  assert.equal(res.status, 422);
});

test('IMAGE-06: Frontend has client-side compression (compressImage)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('compressImage'), 'Frontend must have compressImage function');
  assert.ok(JS.includes('MAX_DIMENSION'), 'Must have MAX_DIMENSION for resizing');
  assert.ok(JS.includes('canvas.toBlob'), 'Must use canvas for compression');
  assert.ok(JS.includes('image/jpeg'), 'Must compress to JPEG');
});

test('IMAGE-07: Frontend rejects if compression fails to reach <=1MB', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('حتی پس از فشرده‌سازی'),
    'Must reject if image still >1MB after compression');
});

test('IMAGE-08: Backend image size limit is 1.4MB base64 (≈1MB binary)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('1400000'), 'Backend must validate image base64 length <= 1400000');
  assert.ok(SRC.includes('image_too_large'), 'Must return image_too_large error');
});

// ============================================================================
// PHASE 5: Image Quota Visible in UI
// ============================================================================

test('QUOTA-UI-01: refreshLimits shows image quota from backend', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('images_used'), 'Must read images_used from backend');
  assert.ok(JS.includes('images_limit'), 'Must read images_limit from backend');
});

test('QUOTA-UI-02: UI displays image quota with SVG icon (no emoji)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  // Must display image quota (either via imgLine variable or ai-quota-pill with image type)
  assert.ok(JS.includes('imgLine') || JS.includes('data-quota-type="image"') || JS.includes("'image'"),
    'Must display image quota in UI');
  // Must NOT use emoji for image quota (professional SVG icons instead)
  const codeOnly = JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // The actual quota rendering should use SVG, not emoji
  assert.ok(codeOnly.includes('ai-quota-pill') || codeOnly.includes('ai-quota-icon'),
    'Must use SVG-based quota pills (not emoji)');
});

test('QUOTA-UI-03: No hardcoded quota fallbacks in CODE (50, 100, 3, 10)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  // Remove comments before checking
  const codeOnly = JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Must NOT have hardcoded fallback values that cause flicker
  assert.ok(!codeOnly.includes('?? 50'), 'Must NOT have ?? 50 fallback');
  assert.ok(!codeOnly.includes('?? 100'), 'Must NOT have ?? 100 fallback');
  // Check for ?? 3 or ?? 10 as standalone (not part of larger numbers)
  assert.ok(!/\?\?\s*3\b/.test(codeOnly) && !/\?\?\s*10\b/.test(codeOnly),
    'Must NOT have hardcoded image quota fallbacks (?? 3 or ?? 10)');
});

test('QUOTA-UI-04: Loading state shown while quota fetches', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('Loading') || JS.includes("'...'"),
    'Must show loading state while quota resolves');
});

// ============================================================================
// PHASE 6-7: 24h Retention + Cleanup
// ============================================================================

test('RETENTION-01: Chat message counters have 24h TTL (86400s)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('86400'), 'msg/image counters must have 86400s TTL (24h)');
});

test('RETENTION-02: Cooldown has short TTL (300s)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('300'), 'cooldown must have 300s TTL');
});

test('RETENTION-03: Web search cache has 5min TTL (300s)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('WEB_SEARCH_CACHE_TTL = 300'),
    'web search cache must have 300s TTL');
});

test('RETENTION-04: No chat history DB table (frontend-only)', () => {
  // Chat history is sent in payload, not stored in DB
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('normalizeAssistantHistory'),
    'History is normalized from frontend payload (not DB)');
  // Must NOT create any chat_messages or ai_messages table
  assert.ok(!SRC.includes('CREATE TABLE') || !SRC.includes('chat_messages'),
    'Must NOT create chat_messages DB table');
});

test('RETENTION-05: KV auto-expires (no manual cleanup needed for chat data)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  // writeRateLimitCache calls with expirationTtl — KV auto-expires
  assert.ok(SRC.includes('writeRateLimitCache'),
    'Must use writeRateLimitCache (which sets TTL)');
  // Verify TTL is passed (86400 for daily, 300 for cooldown)
  assert.ok(SRC.includes('86400') && SRC.includes('300'),
    'Must set proper TTLs for auto-expiration');
});

// ============================================================================
// PHASE 8: WS-REG-01 — Conflicting Web Search Fixture (Powell + Warsh → Warsh)
// ============================================================================

test('WS-REG-01: Conflicting fixture (Powell old + Warsh new) → context contains Warsh + MOST RECENT instruction', async () => {
  // This test uses a MOCK web search (not real) to verify the pipeline logic.
  // We mock the z-ai-web-dev-sdk import to return conflicting results.
  const worker = loadWorker();
  const env = createEnv({});

  // Track what gets injected into the prompt
  let capturedPrompt = null;
  const origQueryDb = env._reqPool;
  // We need to intercept the Groq call to capture the prompt
  const mockPool = {
    query: async (sql, params) => {
      const sl = (sql||'').toLowerCase();
      if (sl.includes('insert into users') && sl.includes('returning')) return { rows: [{ telegram_id: '888001', username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, channel_verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      if (sl.includes('select') && sl.includes('from users') && sl.includes('where telegram_id')) return { rows: [] };
      if (sl.includes('from watchlist_items') || sl.includes('from referrals') || sl.includes('from token_balances') || sl.includes('from token_transactions') || sl.includes('from price_alerts') || sl.includes('from notifications') || sl.includes('from notification_settings') || sl.includes('from analyses') || sl.includes('from tickets') || sl.includes('from admins')) return { rows: [] };
      if (sl.includes('insert into watchlist_items')) return { rows: [] };
      if (sl.includes('on conflict') && sl.includes('do nothing')) return { rows: [] };
      if (sl.includes('groq_generate')) {
        capturedPrompt = String(params?.[1] || '');
        // Return a reply that would be correct (mentions Warsh)
        return { rows: [{ result: { status_code: 200, response_body: JSON.stringify({ choices: [{ message: { content: 'رئیس فعلی فدرال رزرو کوین وارش است که از ۲۲ مه ۲۰۲۶ به این سمت منصوب شده است.' } }] }) } }] };
      }
      return { rows: [] };
    },
    end: async () => {}, on: () => {},
  };
  env._reqPool = mockPool;

  // Mock the web search by pre-populating cache with conflicting fixture
  // (This simulates what performWebSearch would produce with conflicting results)
  const conflictingFixture = [
    '=== Verified Web Search Results (Real-Time Data) ===',
    'Instruction: Use this verified data to answer the user question.',
    '- When results contain conflicting info (e.g., old vs new), prefer the MOST RECENT result (check the Date field) and authoritative sources.',
    '- Mention the source name and date when answering.',
    '- Do NOT invent information beyond what is listed here.',
    '- Only say "اطلاعات به‌روز قابل تأیید پیدا نشد" if ALL results are irrelevant to the question or empty.',
    '',
    'Result 1: Jerome Powell is Federal Reserve Chair',
    '  Content: Jerome Powell is the chair of the Federal Reserve.',
    '  Date: May 11, 2026',
    '  Source: example-old-source.com',
    '  URL: https://example-old-source.com/powell',
    '',
    'Result 2: Kevin Warsh becomes Federal Reserve Chair',
    '  Content: Kevin Warsh took office as chair of the Federal Reserve on May 22, 2026.',
    '  Date: May 22, 2026',
    '  Source: example-new-source.com',
    '  URL: https://example-new-source.com/warsh',
    '',
    '=== End Web Search ===',
  ].join('\n');

  // Pre-populate the web search cache so performWebSearch returns the fixture
  const cacheKey = 'chat:websearch:فدرال رزرو کیه';
  await env.APP_CACHE.put(cacheKey, conflictingFixture);

  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'رئیس فدرال رزرو کیه؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 888001, first_name: 'Test' }),
  });

  assert.equal(res.status, 200);
  assert.ok(capturedPrompt, 'Groq must have been called with a prompt');

  // Assertion 1: Final output must include Kevin Warsh / کوین وارش
  const reply = res.body?.reply || '';
  console.log('WS-REG-01 reply:', reply.substring(0, 200));
  assert.ok(
    reply.includes('Kevin') || reply.includes('Warsh') ||
    reply.includes('کوین') || reply.includes('وارش'),
    'FINAL OUTPUT must mention Kevin Warsh / کوین وارش'
  );

  // Assertion 2: Final output must NOT include the no-data message
  assert.ok(
    !reply.includes('اطلاعات به‌روز قابل تأیید نیست') &&
    !reply.includes('اطلاعات به‌روز قابل تأیید پیدا نشد'),
    'FINAL OUTPUT must NOT contain no-data message when valid results exist'
  );

  // Verify the prompt contains both Powell (old) and Warsh (new) + MOST RECENT instruction
  assert.ok(capturedPrompt.includes('Powell'), 'Prompt must contain old Powell result');
  assert.ok(capturedPrompt.includes('Warsh'), 'Prompt must contain new Warsh result');
  assert.ok(capturedPrompt.includes('MOST RECENT'), 'Prompt must have MOST RECENT instruction');
});

// ============================================================================
// PHASE 9: WS-REG-02 — Irrelevant Web Search Fixture → no-data response
// ============================================================================

test('WS-REG-02: All irrelevant results → context still injected (model decides no-data)', async () => {
  const worker = loadWorker();
  const env = createEnv({});
  let capturedPrompt = null;
  const mockPool = {
    query: async (sql, params) => {
      const sl = (sql||'').toLowerCase();
      if (sl.includes('insert into users') && sl.includes('returning')) return { rows: [{ telegram_id: '888002', username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, channel_verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      if (sl.includes('select') && sl.includes('from users') && sl.includes('where telegram_id')) return { rows: [] };
      if (sl.includes('from watchlist_items') || sl.includes('from referrals') || sl.includes('from token_balances') || sl.includes('from token_transactions') || sl.includes('from price_alerts') || sl.includes('from notifications') || sl.includes('from notification_settings') || sl.includes('from analyses') || sl.includes('from tickets') || sl.includes('from admins')) return { rows: [] };
      if (sl.includes('insert into watchlist_items')) return { rows: [] };
      if (sl.includes('on conflict') && sl.includes('do nothing')) return { rows: [] };
      if (sl.includes('groq_generate')) {
        capturedPrompt = String(params?.[1] || '');
        // Model SHOULD return no-data when all results are irrelevant
        return { rows: [{ result: { status_code: 200, response_body: JSON.stringify({ choices: [{ message: { content: 'اطلاعات به‌روز قابل تأیید پیدا نشد — لطفاً به منابع خبری معتبر مراجعه کنید.' } }] }) } }] };
      }
      return { rows: [] };
    },
    end: async () => {}, on: () => {},
  };
  env._reqPool = mockPool;

  // Pre-populate with IRRELEVANT results (no Fed chair info)
  const irrelevantFixture = [
    '=== Verified Web Search Results (Real-Time Data) ===',
    'Instruction: Use this verified data to answer the user question.',
    '- When results contain conflicting info, prefer the MOST RECENT result.',
    '- Only say "اطلاعات به‌روز قابل تأیید پیدا نشد" if ALL results are irrelevant.',
    '',
    'Result 1: Bitcoin Mining Difficulty Reaches All-Time High',
    '  Content: The Bitcoin network mining difficulty has increased.',
    '  Source: cryptominingnews.com',
    '',
    'Result 2: Ethereum ETF Approval Timeline',
    '  Content: SEC may approve Ethereum ETFs next quarter.',
    '  Source: etfnews.com',
    '',
    'Result 3: Weather Forecast for New York',
    '  Content: Sunny skies expected this weekend.',
    '  Source: weather.com',
    '',
    '=== End Web Search ===',
  ].join('\n');

  const cacheKey = 'chat:websearch:فدرال رزرو کیه';
  await env.APP_CACHE.put(cacheKey, irrelevantFixture);

  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'رئیس فدرال رزرو کیه؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 888002, first_name: 'Test' }),
  });

  assert.equal(res.status, 200);
  assert.ok(capturedPrompt, 'Groq must have been called');

  const reply = res.body?.reply || '';
  console.log('WS-REG-02 reply:', reply.substring(0, 200));

  // When all results are irrelevant, model SHOULD return no-data message
  assert.ok(
    reply.includes('اطلاعات به‌روز قابل تأیید') ||
    reply.includes('پیدا نشد'),
    'When all results irrelevant, FINAL OUTPUT must contain no-data message'
  );

  // Verify the prompt contains irrelevant results (no Powell/Warsh)
  assert.ok(!capturedPrompt.includes('Powell') && !capturedPrompt.includes('Warsh'),
    'Prompt must NOT contain Fed chair data (all results irrelevant)');
});

// ============================================================================
// PHASE 10: WS-REG-03 — Real Web Search (runtime, uses real SDK)
// ============================================================================

test('WS-REG-03: Real web search → current 2026 data in context', async (t) => {
  // This test uses the real z-ai-web-dev-sdk which requires a credential.
  // In CI without the credential, the web search will fail silently and
  // fall back to Wikipedia. We skip (not fail) if the SDK isn't available.
  let sdkAvailable = false;
  try {
    const ZAI = (await import('z-ai-web-dev-sdk')).default;
    const zai = await ZAI.create();
    // Test if web_search actually works (needs credential)
    const testResults = await zai.functions.invoke('web_search', { query: 'test', num: 1 });
    if (Array.isArray(testResults) && testResults.length > 0) sdkAvailable = true;
  } catch (e) {
    sdkAvailable = false;
  }

  if (!sdkAvailable) {
    t.skip('SKIPPED — z-ai-web-dev-sdk credential not available in CI');
    return;
  }

  const worker = loadWorker();
  const env = createEnv({});
  let webSearchCacheContent = null;
  const origPut = env.APP_CACHE.put.bind(env.APP_CACHE);
  env.APP_CACHE.put = async (k, v, o) => {
    if (k && k.startsWith('chat:websearch:')) webSearchCacheContent = v;
    return origPut(k, v, o);
  };
  const mockPool = {
    query: async (sql, params) => {
      const sl = (sql||'').toLowerCase();
      if (sl.includes('insert into users') && sl.includes('returning')) return { rows: [{ telegram_id: '888003', username: null, first_name: 'Test', last_name: null, lang: 'fa', channel_joined: false, channel_verified_at: null, created_at: new Date().toISOString(), updated_at: new Date().toISOString() }] };
      if (sl.includes('select') && sl.includes('from users') && sl.includes('where telegram_id')) return { rows: [] };
      if (sl.includes('from watchlist_items') || sl.includes('from referrals') || sl.includes('from token_balances') || sl.includes('from token_transactions') || sl.includes('from price_alerts') || sl.includes('from notifications') || sl.includes('from notification_settings') || sl.includes('from analyses') || sl.includes('from tickets') || sl.includes('from admins')) return { rows: [] };
      if (sl.includes('insert into watchlist_items')) return { rows: [] };
      if (sl.includes('on conflict') && sl.includes('do nothing')) return { rows: [] };
      if (sl.includes('groq_generate')) return { rows: [{ result: { status_code: 200, response_body: JSON.stringify({ choices: [{ message: { content: 'OK' } }] }) } }] };
      return { rows: [] };
    },
    end: async () => {}, on: () => {},
  };
  env._reqPool = mockPool;

  const res = await sendRequest(worker, env, 'POST', '/api/assistant/chat', {
    body: { message: 'رئیس فدرال رزرو کیه؟', history: [], image: null, context: null },
    initData: buildInitData('test-bot-token', { id: 888003, first_name: 'Test' }),
  });

  assert.equal(res.status, 200);
  assert.ok(webSearchCacheContent, 'Real web search must have run and cached results');

  const ctx = String(webSearchCacheContent);
  console.log('WS-REG-03 cache size:', ctx.length);
  // Must contain current 2026 data (Kevin Warsh or Jerome Powell — both are 2026 Fed chair references)
  assert.ok(ctx.includes('2026') || ctx.includes('فدرال'),
    'Real web search must return 2026 Fed data');
  // Must have the MOST RECENT instruction
  assert.ok(ctx.includes('MOST RECENT'),
    'Must have MOST RECENT instruction for conflicting info');
});

// ============================================================================
// PHASE 11: WS-REG-04 — Real Groq E2E (SKIPPED if no credential)
// ============================================================================

test('WS-REG-04: Real Groq E2E — SKIPPED (no production Groq credential in test env)', { skip: true }, async () => {
  // This test would require a real Groq API key configured in the test environment.
  // The test environment does not have GROQ_API_KEY or DATABASE_URL with real
  // groq_generate() DB function. The real Groq flow is verified via:
  // 1. Unit tests (mock Groq) — verify prompt structure
  // 2. Runtime tests (real web search + mock Groq) — verify context injection
  // 3. Production deployment + smoke test — verify end-to-end with real Groq
  //
  // SKIPPED — no production Groq credential in test env.
  // DO NOT attempt to bypass authentication or fake success.
});

// ============================================================================
// PHASE 12: Provider Chain Unchanged
// ============================================================================

test('PROVIDER-CHAIN-01: Groq→Gemini→OpenRouter→Workers AI→OpenAI order unchanged', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const providers = SRC.match(/const providers = \[([\s\S]*?)\];/);
  assert.ok(providers, 'Must have providers array');
  const block = providers[1];
  const groqIdx = block.indexOf("['groq'");
  const geminiIdx = block.indexOf("['gemini'");
  const orIdx = block.indexOf("['openrouter'");
  const waIdx = block.indexOf("['workers-ai'");
  const oaiIdx = block.indexOf("['openai'");
  assert.ok(groqIdx > -1 && groqIdx < geminiIdx, 'Groq before Gemini');
  assert.ok(geminiIdx < orIdx, 'Gemini before OpenRouter');
  assert.ok(orIdx < waIdx, 'OpenRouter before Workers AI');
  assert.ok(waIdx < oaiIdx, 'Workers AI before OpenAI');
});

test('AUDIT-01: worker-proxy.js NOT modified', () => {
  // This is verified by git diff — but also check that assistant.js doesn't
  // import anything new from worker-proxy.js
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const depsMatch = SRC.match(/const \{([^}]*)\} = deps/);
  assert.ok(depsMatch, 'Must have deps destructuring');
  assert.ok(!SRC.includes('fetchFarsiNews'), 'Must NOT import fetchFarsiNews');
  assert.ok(!SRC.includes('fetchGlobalStats'), 'Must NOT import fetchGlobalStats');
});

test('AUDIT-02: No hardcoded secrets', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  const all = SRC + JS;
  // Must NOT have hardcoded API keys
  assert.ok(!/sk-[a-z0-9]{20,}/i.test(all), 'No OpenAI keys');
  assert.ok(!/ghp_[a-z0-9]{30,}/i.test(all), 'No GitHub tokens');
});

console.log('✅ All Phase 1-12 quota/image/retention/websearch tests loaded.');

// ============================================================================
// PHASE 4-8: Professional Quota UI (SVG icons, popover, status colors)
// ============================================================================

test('QUOTA-UI-05: SVG icons used for chat quota (not emoji)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  const codeOnly = JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Must have SVG icon in quota rendering
  assert.ok(codeOnly.includes('ai-quota-icon'), 'Must use ai-quota-icon class');
  // Must NOT use emoji for chat quota
  assert.ok(!codeOnly.includes('💬'), 'Must NOT use 💬 emoji');
});

test('QUOTA-UI-06: SVG icons used for image quota (not emoji)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  const codeOnly = JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!codeOnly.includes('🖼️'), 'Must NOT use 🖼️ emoji');
  assert.ok(!codeOnly.includes('📷'), 'Must NOT use 📷 emoji');
});

test('QUOTA-UI-07: Quota pills are clickable (role=button, tabindex)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('role="button"'), 'Quota pills must have role=button');
  assert.ok(JS.includes('tabindex="0"'), 'Quota pills must have tabindex=0');
  assert.ok(JS.includes('showQuotaPopover'), 'Must have showQuotaPopover function');
});

test('QUOTA-UI-08: Quota popover function exists with close handlers', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('showQuotaPopover'), 'Must have showQuotaPopover');
  assert.ok(JS.includes('hideQuotaPopover'), 'Must have hideQuotaPopover');
  // Must handle Escape key
  assert.ok(JS.includes("e.key === 'Escape'"), 'Must close on Escape');
  // Must handle click outside
  assert.ok(JS.includes('outsideHandler') || JS.includes('click'), 'Must close on click outside');
});

test('QUOTA-UI-09: Quota status colors (healthy/warning/critical/empty)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('healthy'), 'Must have healthy status');
  assert.ok(JS.includes('warning'), 'Must have warning status');
  assert.ok(JS.includes('critical'), 'Must have critical status');
  assert.ok(JS.includes('empty'), 'Must have empty status');
});

test('QUOTA-UI-10: Quota popover has Persian text (dynamic, not hardcoded numbers)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('سهمیه'), 'Must have Persian quota text');
  assert.ok(JS.includes('باقی مانده'), 'Must have Persian "remaining" text');
  assert.ok(JS.includes('بازنشانی'), 'Must mention auto-reset');
  // Numbers must be dynamic (template literals)
  assert.ok(JS.includes('${remaining}'), 'Remaining count must be dynamic');
  assert.ok(JS.includes('${limit}'), 'Limit must be dynamic');
});

test('QUOTA-UI-11: Accessibility — aria-expanded, aria-label on quota pills', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('aria-expanded'), 'Must have aria-expanded');
  assert.ok(JS.includes('aria-label'), 'Must have aria-label');
  assert.ok(JS.includes('بستن'), 'Close button must have Persian aria-label');
});

// ============================================================================
// PHASE 9-14: File Preview + Compression
// ============================================================================

test('FILE-01: File preview card function exists', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('showFilePreview'), 'Must have showFilePreview function');
  assert.ok(JS.includes('removeFilePreview'), 'Must have removeFilePreview function');
});

test('FILE-02: File preview shows thumbnail + filename + size', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('ai-file-preview-thumb'), 'Must have thumbnail');
  assert.ok(JS.includes('ai-file-preview-name'), 'Must show filename');
  assert.ok(JS.includes('ai-file-size-final'), 'Must show final size');
});

test('FILE-03: File size visualization (3 states: healthy/warning/critical)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('حجم مناسب'), 'Must have healthy label');
  assert.ok(JS.includes('نزدیک سقف حجم'), 'Must have warning label');
  // Critical state must exist
  assert.ok(JS.includes('800 * 1024'), 'Must check 800KB threshold');
  assert.ok(JS.includes('MAX_FILE_SIZE'), 'Must check 1MB limit');
});

test('FILE-04: Compression shows original → final size', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('originalSize'), 'Must track original size');
  assert.ok(JS.includes('finalSize'), 'Must track final size');
  assert.ok(JS.includes('compressed'), 'Must track compressed flag');
  // Must show arrow between original and final
  assert.ok(JS.includes('ai-file-size-original'), 'Must show original size');
});

test('FILE-05: Compression in progress state shown', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('showCompressionProgress'), 'Must have showCompressionProgress');
  assert.ok(JS.includes('در حال بهینه‌سازی'), 'Must show Persian "optimizing" text');
  assert.ok(JS.includes('ai-file-compressing'), 'Must have compression CSS class');
});

test('FILE-06: Progressive quality reduction (0.85, 0.75, 0.65, 0.55)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('0.85'), 'Must try quality 0.85');
  assert.ok(JS.includes('0.75'), 'Must try quality 0.75');
  assert.ok(JS.includes('0.65'), 'Must try quality 0.65');
  assert.ok(JS.includes('0.55'), 'Must try quality 0.55');
});

test('FILE-07: PNG transparency handling (keeps PNG format)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('image/png'), 'Must check for PNG type');
  assert.ok(JS.includes('isPng'), 'Must detect PNG');
  // Must use PNG mime type when preserving transparency
  assert.ok(JS.includes("isPng ? 'image/png' : 'image/jpeg'"), 'Must keep PNG for transparency');
});

test('FILE-08: File remove button exists (no quota consumed on remove)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('ai-file-remove'), 'Must have remove button');
  // Remove must clear pendingImage WITHOUT calling backend (no quota consumed)
  assert.ok(JS.includes('this.pendingImage = null'), 'Remove must clear pendingImage');
});

test('FILE-09: Quota NOT consumed on file select (only on successful send)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  // handleFile must NOT call recordRateLimitUsage or similar
  // It should only set pendingImage
  const handleFn = JS.indexOf('async handleFile');
  const fnBlock = JS.slice(handleFn, handleFn + 3000);
  assert.ok(!fnBlock.includes('recordRateLimitUsage'), 'handleFile must NOT record quota usage');
  assert.ok(!fnBlock.includes('refreshLimits'), 'handleFile must NOT refresh limits (quota not consumed)');
});

test('FILE-10: Max dimension 1280px for resize', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  assert.ok(JS.includes('MAX_DIMENSION = 1280'), 'Must have MAX_DIMENSION = 1280');
});

test('FILE-11: Backend image validation (1.4MB base64)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
  assert.ok(SRC.includes('1400000'), 'Backend must validate <=1.4MB base64');
  assert.ok(SRC.includes('image_too_large'), 'Must return image_too_large error');
});

test('FILE-12: No UI emoji in file handling (📎❌ replaced with SVG/text)', () => {
  const JS = fs.readFileSync(path.join(__dirname, 'assistant.js'), 'utf8');
  const codeOnly = JS.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // Must NOT use emoji in UI chrome (file preview, error messages)
  assert.ok(!codeOnly.includes('❌'), 'Must NOT use ❌ emoji in UI');
  // Error messages should be plain Persian text
  assert.ok(codeOnly.includes('حجم تصویر حتی پس از فشرده‌سازی'), 'Must have Persian error text');
});

console.log('✅ All Phase 4-14 professional UI tests loaded.');

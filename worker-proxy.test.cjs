const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadWorker(overrides = {}) {
  const workerPath = path.join(__dirname, 'worker-proxy.js');
  const source = fs.readFileSync(workerPath, 'utf8');
  const transformed = source
    .replace("import { Buffer } from 'node:buffer';", "const { Buffer } = require('node:buffer');")
    .replace(
      "import { createHmac, timingSafeEqual } from 'node:crypto';",
      "const { createHmac, timingSafeEqual } = require('node:crypto');",
    )
    .replace("import pg from 'pg';", "const pg = require('pg');")
    .replace('export default {', 'module.exports = {');

  const module = { exports: {} };
  const defaultMocks = {
    pg: {
      Pool: class Pool {
        async query() {
          return { rows: [] };
        }
      },
    },
  };
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(overrides, id)) {
      return overrides[id];
    }
    if (Object.prototype.hasOwnProperty.call(defaultMocks, id)) {
      return defaultMocks[id];
    }
    return require(id);
  };
  const evaluator = new Function('require', 'module', 'exports', transformed);
  evaluator(localRequire, module, module.exports);
  return module.exports;
}

function buildInitData(botToken, user) {
  const entries = [
    ['auth_date', String(Math.floor(Date.now() / 1000))],
    ['query_id', 'AAHdF6IQAAAAAN0XohDhrOrc'],
    ['user', JSON.stringify(user)],
  ];

  const dataCheckString = entries
    .slice()
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, value]) => `${key}=${value}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return entries
    .concat([['hash', hash]])
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .join('&');
}

function createEnv(overrides = {}) {
  return {
    BACKEND_URL: 'https://backend.example',
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: 'amir_btc_2024',
    ADMIN_TELEGRAM_ID: '831704732',
    ...overrides,
  };
}

function createFetchStub(responseFactory) {
  const calls = [];
  async function stub(url, init = {}) {
    calls.push({
      url: String(url),
      method: init.method || 'GET',
      headers: new Headers(init.headers || {}),
      body: init.body === undefined ? undefined : await new Response(init.body).text(),
    });
    return responseFactory(url, init);
  }

  return { stub, calls };
}

function createMemoryKv(initial = {}) {
  const store = new Map(Object.entries(initial));
  return {
    async get(key) {
      return store.has(key) ? store.get(key) : null;
    },
    async put(key, value) {
      store.set(key, value);
    },
    async delete(key) {
      store.delete(key);
    },
    dump() {
      return Object.fromEntries(store.entries());
    },
  };
}

function createPgMock(queryHandler = async () => ({ rows: [] })) {
  const calls = [];

  class Pool {
    async query(sql, params) {
      calls.push({ sql, params });
      return queryHandler(sql, params);
    }
  }

  return {
    module: { Pool },
    calls,
  };
}

test('PUT /api/users/me/settings validates auth before proxying', async () => {
  const worker = loadWorker();
  let backendCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/users/me/settings', {
      method: 'PUT',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'spoofed', lang: 'fa' }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 401);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), { detail: 'Missing Telegram init data' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('PUT /api/users/me/settings rewrites user_id and proxies to backend', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ status: 'success' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/users/me/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', lang: 'en' }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.example/api/users/me/settings');
    assert.deepEqual(JSON.parse(calls[0].body), { user_id: '12345', lang: 'en' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('PUT /api/users/me/settings returns 503 when BACKEND_URL is missing', async () => {
  const worker = loadWorker();
  const initData = buildInitData('test-bot-token', { id: 12345, first_name: 'Amir' });
  let backendCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/users/me/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', lang: 'fa' }),
    });

    const response = await worker.fetch(request, createEnv({ BACKEND_URL: '' }));
    assert.equal(response.status, 503);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), {
      status: 'error',
      message: 'BACKEND_URL not configured for me/settings proxy',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/watchlist rewrites spoofed query user_id before proxying', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ status: 'success', symbols: ['BTC'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/watchlist?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.example/api/watchlist?user_id=12345');
  } finally {
    global.fetch = originalFetch;
  }
});

test('PUT /api/watchlist rewrites body user_id before proxying', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ status: 'success', symbols: ['BTC', 'ETH'] }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/watchlist', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', symbols: ['btc', 'eth'] }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.example/api/watchlist');
    assert.deepEqual(JSON.parse(calls[0].body), {
      user_id: '12345',
      symbols: ['btc', 'eth'],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/check-join returns cached join status for authenticated user', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const joinCache = createMemoryKv({ 'join:12345': '1' });
  let fetchCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('fetch should not be called when JOIN_CACHE already has a positive value');
  };

  try {
    const request = new Request('https://worker.example/api/check-join?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        JOIN_CACHE: joinCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(fetchCalled, false);
    assert.deepEqual(await response.json(), {
      status: 'success',
      joined: true,
      cached: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/check-join refresh=true checks Telegram and persists DB plus KV', async () => {
  const pgMock = createPgMock(async () => ({ rows: [] }));
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const joinCache = createMemoryKv();
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/check-join?user_id=spoofed&refresh=true', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
        JOIN_CACHE: joinCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /https:\/\/api\.telegram\.org\/bot.*\/getChatMember\?/);
    assert.match(calls[0].url, /user_id=12345/);
    assert.equal((await joinCache.get('join:12345')), '1');
    assert.equal(pgMock.calls.length, 1);
    assert.match(pgMock.calls[0].sql, /INSERT INTO users/i);
    assert.deepEqual(await response.json(), {
      status: 'success',
      joined: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/check-join uses users.channel_joined from DB as source of truth', async () => {
  const pgMock = createPgMock(async (sql) => {
    if (/SELECT telegram_id, channel_joined FROM users/i.test(sql)) {
      return {
        rows: [{ telegram_id: '12345', channel_joined: true }],
      };
    }
    return { rows: [] };
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    throw new Error('Telegram API should not be called when DB already confirms join');
  };

  try {
    const request = new Request('https://worker.example/api/check-join?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
        JOIN_CACHE: createMemoryKv(),
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(fetchCalled, false);
    assert.deepEqual(await response.json(), {
      status: 'success',
      joined: true,
      from_db: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/debug/check-join returns Telegram debug payload for authenticated user', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/debug/check-join?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /user_id=12345/);
    assert.deepEqual(await response.json(), {
      required_channel: 'amir_btc_2024',
      user_id: '12345',
      telegram_response: { ok: true, result: { status: 'member' } },
      joined: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/check-join/invalidate clears JOIN_CACHE for authenticated user', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const joinCache = createMemoryKv({ 'join:12345': '1' });

  try {
    const request = new Request('https://worker.example/api/check-join/invalidate?user_id=spoofed', {
      method: 'POST',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        JOIN_CACHE: joinCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(await joinCache.get('join:12345'), null);
    assert.deepEqual(await response.json(), {
      status: 'success',
      invalidated: true,
      user_id: '12345',
    });
  } finally {
  }
});

test('POST /telegram handles /start for non-member with join button', async () => {
  const worker = loadWorker();
  const { stub, calls } = createFetchStub(async () =>
    new Response(
      JSON.stringify(
        calls.length === 0
          ? { ok: true, result: { status: 'left' } }
          : { ok: true, result: { message_id: 1 } },
      ),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    ),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 10,
          from: { id: 12345, first_name: 'Amir' },
          chat: { id: 12345, type: 'private' },
          date: 1710000000,
          text: '/start',
        },
      }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /getChatMember/);
    assert.equal(calls[1].url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
    assert.deepEqual(JSON.parse(calls[1].body), {
      chat_id: 12345,
      text: '⚠️ برای استفاده از ربات، ابتدا باید در کانال ما عضو شوید.',
      reply_markup: {
        inline_keyboard: [[{ text: 'عضویت در کانال', url: 'https://t.me/amir_btc_2024' }]],
      },
      disable_web_page_preview: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/check-join tolerates DB read failure and still confirms joined via Telegram', async () => {
  const pgMock = createPgMock(async (sql) => {
    if (/SELECT telegram_id, channel_joined FROM users/i.test(sql)) {
      throw new Error('db read failed');
    }
    return { rows: [] };
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const joinCache = createMemoryKv();
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/check-join?user_id=spoofed&refresh=true', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
        JOIN_CACHE: joinCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.match(calls[0].url, /getChatMember/);
    assert.equal(await joinCache.get('join:12345'), '1');
    assert.equal(pgMock.calls.length, 1);
    assert.deepEqual(await response.json(), {
      status: 'success',
      joined: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /telegram handles /start for joined member with web_app button', async () => {
  const pgMock = createPgMock(async (sql) => {
    if (/SELECT telegram_id, channel_joined FROM users/i.test(sql)) {
      return {
        rows: [{ telegram_id: '12345', channel_joined: true }],
      };
    }
    return { rows: [] };
  });
  const worker = loadWorker({ pg: pgMock.module });
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 2,
        message: {
          message_id: 11,
          from: { id: 12345, first_name: 'Amir' },
          chat: { id: 12345, type: 'private' },
          date: 1710000001,
          text: '/start ref_abc',
        },
      }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
        WEBAPP_URL: 'https://miniapp.example',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(pgMock.calls.length, 1);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
    assert.deepEqual(JSON.parse(calls[0].body), {
      chat_id: 12345,
      text: 'خوش آمدید! دستیار هوشمند آماده خدمت‌رسانی است.',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 باز کردن مینی‌اپ', web_app: { url: 'https://miniapp.example' } }]],
      },
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /telegram handles /start for joined member via live Telegram check and persists DB', async () => {
  const pgMock = createPgMock(async () => ({ rows: [] }));
  const worker = loadWorker({ pg: pgMock.module });
  const { stub, calls } = createFetchStub(async (url) => {
    if (String(url).includes('/getChatMember?')) {
      return new Response(JSON.stringify({ ok: true, result: { status: 'member' } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    });
  });
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/telegram', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        update_id: 3,
        message: {
          message_id: 12,
          from: { id: 12345, first_name: 'Amir' },
          chat: { id: 12345, type: 'private' },
          date: 1710000002,
          text: '/start',
        },
      }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
        WEBAPP_URL: 'https://miniapp.example',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 2);
    assert.match(calls[0].url, /getChatMember/);
    assert.equal(calls[1].url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
    assert.equal(pgMock.calls.length, 2);
    assert.match(pgMock.calls[1].sql, /INSERT INTO users/i);
    assert.deepEqual(JSON.parse(calls[1].body), {
      chat_id: 12345,
      text: 'خوش آمدید! دستیار هوشمند آماده خدمت‌رسانی است.',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 باز کردن مینی‌اپ', web_app: { url: 'https://miniapp.example' } }]],
      },
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/assistant/limits reads cooldown from RATE_LIMITS KV', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const rateLimits = createMemoryKv({ 'ai:cooldown:12345': '1' });

  const request = new Request('https://worker.example/api/assistant/limits?user_id=spoofed', {
    method: 'GET',
    headers: {
      'X-Telegram-Init-Data': initData,
    },
  });

  const response = await worker.fetch(
    request,
    createEnv({
      RATE_LIMITS: rateLimits,
    }),
  );

  assert.equal(response.status, 200);
  assert.deepEqual(await response.json(), {
    status: 'success',
    allowed: false,
    reason: 'cooldown',
    retry_after: 4,
  });
});

test('POST /api/assistant/chat rejects daily message limit without calling backend', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const today = new Date().toISOString().slice(0, 10);
  const rateLimits = createMemoryKv({ [`ai:msgs:12345:${today}`]: '50' });
  const originalFetch = global.fetch;
  let backendCalled = false;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', message: 'hi', history: [] }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        RATE_LIMITS: rateLimits,
      }),
    );

    assert.equal(response.status, 429);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), {
      status: 'error',
      allowed: false,
      reason: 'daily_message_limit',
      used: 50,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/assistant/chat rewrites user_id, proxies, and records usage in RATE_LIMITS KV', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const rateLimits = createMemoryKv();
  const { stub, calls } = createFetchStub(async () =>
    new Response(JSON.stringify({ status: 'success', reply: 'ok', provider: 'test' }), {
      status: 200,
      headers: { 'Content-Type': 'application/json' },
    }),
  );
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', message: 'hi', history: [] }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        RATE_LIMITS: rateLimits,
      }),
    );

    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://backend.example/api/assistant/chat');
    assert.deepEqual(JSON.parse(calls[0].body), { user_id: '12345', message: 'hi', history: [] });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await rateLimits.get('ai:cooldown:12345'), '1');
    assert.equal(await rateLimits.get(`ai:msgs:12345:${today}`), '1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('SESSION_CACHE heartbeat/online/end flow keeps approximate online count', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv();

  const heartbeatRequest = new Request('https://worker.example/api/sessions/heartbeat?user_id=spoofed', {
    method: 'POST',
    headers: {
      'X-Telegram-Init-Data': initData,
    },
  });

  const env = createEnv({
    SESSION_CACHE: sessionCache,
  });

  const heartbeatResponse = await worker.fetch(heartbeatRequest, env);
  assert.equal(heartbeatResponse.status, 200);
  const heartbeatBody = await heartbeatResponse.json();
  assert.equal(heartbeatBody.status, 'success');
  assert.equal(heartbeatBody.online_count, 1);
  assert.equal(await sessionCache.get('session:12345'), heartbeatBody.session_id);
  assert.ok(await sessionCache.get('session:12345:seen'));

  const onlineRequest = new Request('https://worker.example/api/sessions/online', {
    method: 'GET',
    headers: {
      'X-Telegram-Init-Data': initData,
    },
  });

  const onlineResponse = await worker.fetch(onlineRequest, env);
  assert.equal(onlineResponse.status, 200);
  assert.deepEqual(await onlineResponse.json(), {
    status: 'success',
    count: 1,
  });

  const endRequest = new Request('https://worker.example/api/sessions/end?user_id=spoofed', {
    method: 'POST',
    headers: {
      'X-Telegram-Init-Data': initData,
    },
  });

  const endResponse = await worker.fetch(endRequest, env);
  assert.equal(endResponse.status, 200);
  assert.deepEqual(await endResponse.json(), {
    status: 'success',
    online_count: 0,
  });
  assert.equal(await sessionCache.get('session:12345'), null);
  assert.equal(await sessionCache.get('session:12345:seen'), null);

  const onlineAfterEndResponse = await worker.fetch(onlineRequest, env);
  assert.equal(onlineAfterEndResponse.status, 200);
  assert.deepEqual(await onlineAfterEndResponse.json(), {
    status: 'success',
    count: 0,
  });
});

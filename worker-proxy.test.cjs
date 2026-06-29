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

test('POST /telegram handles /start for non-member user natively in worker', async () => {
  const pgMock = createPgMock(async (sql) => {
    if (/SELECT telegram_id, channel_joined FROM users/i.test(sql)) {
      return {
        rows: [{ telegram_id: '12345', channel_joined: false }],
      };
    }
    return { rows: [] };
  });
  const worker = loadWorker({ pg: pgMock.module });
  const { stub, calls } = createFetchStub(async (url) => {
    if (String(url).includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 10,
          text: '/start',
          chat: { id: 12345, type: 'private' },
          from: { id: 12345, first_name: 'Amir' },
        },
      }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
    assert.deepEqual(JSON.parse(calls[0].body), {
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

test('POST /telegram handles /start for joined user and returns web_app button', async () => {
  const pgMock = createPgMock(async (sql) => {
    if (/SELECT telegram_id, channel_joined FROM users/i.test(sql)) {
      return {
        rows: [{ telegram_id: '12345', channel_joined: true }],
      };
    }
    return { rows: [] };
  });
  const worker = loadWorker({ pg: pgMock.module });
  const { stub, calls } = createFetchStub(async (url) => {
    if (String(url).includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 2 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/telegram', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({
        update_id: 1,
        message: {
          message_id: 11,
          text: '/start ref_payload',
          chat: { id: 12345, type: 'private' },
          from: { id: 12345, first_name: 'Amir' },
        },
      }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://example.test/db',
        WEBAPP_URL: 'https://miniapp.example/app',
      }),
    );
    assert.equal(response.status, 200);
    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telegram.org/bottest-bot-token/sendMessage');
    assert.deepEqual(JSON.parse(calls[0].body), {
      chat_id: 12345,
      text: 'خوش آمدید! دستیار هوشمند آماده خدمت‌رسانی است.',
      reply_markup: {
        inline_keyboard: [[{ text: '🚀 باز کردن مینی‌اپ', web_app: { url: 'https://miniapp.example/app' } }]],
      },
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduled worker syncs Telegram webhook to worker /telegram URL', async () => {
  const worker = loadWorker();
  const { stub, calls } = createFetchStub(async (url) => {
    if (String(url).includes('/setWebhook')) {
      return new Response(JSON.stringify({ ok: true, result: true }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    throw new Error(`Unexpected fetch URL: ${url}`);
  });
  const originalFetch = global.fetch;
  global.fetch = stub;

  try {
    const waitUntilCalls = [];
    await worker.scheduled(
      { cron: '*/5 * * * *' },
      createEnv({
        TELEGRAM_WEBHOOK_URL: 'https://worker.example/custom/path?stale=1',
      }),
      {
        waitUntil(promise) {
          waitUntilCalls.push(promise);
        },
      },
    );
    await Promise.all(waitUntilCalls);

    assert.equal(calls.length, 1);
    assert.equal(calls[0].url, 'https://api.telegram.org/bottest-bot-token/setWebhook');
    assert.deepEqual(JSON.parse(calls[0].body), {
      url: 'https://worker.example/telegram',
      drop_pending_updates: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

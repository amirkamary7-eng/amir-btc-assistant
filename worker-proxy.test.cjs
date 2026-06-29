const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

function loadWorker() {
  const workerPath = path.join(__dirname, 'worker-proxy.js');
  const source = fs.readFileSync(workerPath, 'utf8');
  const transformed = source
    .replace("import { Buffer } from 'node:buffer';", "const { Buffer } = require('node:buffer');")
    .replace(
      "import { createHmac, timingSafeEqual } from 'node:crypto';",
      "const { createHmac, timingSafeEqual } = require('node:crypto');",
    )
    .replace('export default {', 'module.exports = {');

  const module = { exports: {} };
  const evaluator = new Function('require', 'module', 'exports', transformed);
  evaluator(require, module, module.exports);
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

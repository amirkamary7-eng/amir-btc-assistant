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

test('PUT /api/users/me/settings ignores spoofed user_id and updates DB-backed user settings', async () => {
  const now = new Date().toISOString();
  const userRow = {
    telegram_id: '12345',
    username: 'amir',
    first_name: 'Amir',
    last_name: null,
    lang: 'fa',
    channel_joined: true,
    channel_verified_at: now,
    created_at: now,
    updated_at: now,
  };
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('UPDATE users')) {
      assert.equal(params[0], '12345');
      assert.equal(params[1], 'en');
      return {
        rows: [{ ...userRow, lang: 'en', updated_at: now }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/users/me/settings');
  };

  try {
    const request = new Request('https://worker.example/api/users/me/settings', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', lang: 'en' }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.user.user_id, '12345');
    assert.equal(body.user.lang, 'en');
    assert.equal(body.user.channel_joined, true);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/watchlist ignores spoofed query user_id and returns DB-backed symbols', async () => {
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('SELECT symbol') && sql.includes('FROM watchlist_items')) {
      assert.equal(params[0], '12345');
      return { rows: [{ symbol: 'BTC' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/watchlist');
  };

  try {
    const request = new Request('https://worker.example/api/watchlist?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      symbols: ['BTC'],
      watchlist: ['BTC'],
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('PUT /api/watchlist ignores spoofed body user_id and stores DB-backed symbols', async () => {
  const storedSymbols = [];
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('ON CONFLICT (telegram_id) DO NOTHING')) {
      assert.equal(params[0], '12345');
      return { rows: [] };
    }
    if (sql.includes('DELETE FROM watchlist_items')) {
      assert.equal(params[0], '12345');
      storedSymbols.length = 0;
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO watchlist_items')) {
      storedSymbols[params[2]] = params[1];
      return { rows: [] };
    }
    if (sql.includes('UPDATE users SET updated_at = NOW()')) {
      assert.equal(params[0], '12345');
      return { rows: [] };
    }
    if (sql.includes('SELECT symbol') && sql.includes('FROM watchlist_items')) {
      return { rows: storedSymbols.filter(Boolean).map((symbol) => ({ symbol })) };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/watchlist');
  };

  try {
    const request = new Request('https://worker.example/api/watchlist', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', symbols: ['btc', 'eth'] }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success', symbols: ['BTC', 'ETH'] });
    assert.deepEqual(storedSymbols, ['BTC', 'ETH']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/users/bootstrap writes profile to DB and returns DB-backed watchlist', async () => {
  const now = new Date().toISOString();
  const userRow = {
    telegram_id: '12345',
    username: 'amir',
    first_name: 'Amir',
    last_name: null,
    lang: 'en',
    channel_joined: false,
    channel_verified_at: null,
    created_at: now,
    updated_at: now,
  };
  let bootstrapCallCount = 0;
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM users') && sql.includes('LIMIT 1')) {
      if (bootstrapCallCount === 0) {
        bootstrapCallCount += 1;
        return { rows: [] };
      }
      return { rows: [userRow] };
    }
    if (sql.includes('ON CONFLICT (telegram_id) DO UPDATE')) {
      assert.equal(params[0], '12345');
      return { rows: [userRow] };
    }
    if (sql.includes('SELECT symbol') && sql.includes('FROM watchlist_items')) {
      return { rows: [{ symbol: 'BTC' }, { symbol: 'ETH' }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir', username: 'amir', language_code: 'en' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/users/bootstrap');
  };

  try {
    const request = new Request('https://worker.example/api/users/bootstrap', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', first_name: 'Spoofed', referrer_id: null }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.user.user_id, '12345');
    assert.equal(body.user.lang, 'en');
    assert.deepEqual(body.watchlist, ['BTC', 'ETH']);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/referrals/stats returns DB-backed referral stats', async () => {
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM referrals')) {
      assert.equal(params[0], '12345');
      return {
        rows: [
          { channel_verified: true, rewarded: true },
          { channel_verified: false, rewarded: false },
        ],
      };
    }
    if (sql.includes('FROM token_balances')) {
      assert.equal(params[0], '12345');
      return { rows: [{ balance: 6 }] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/referrals/stats');
  };

  try {
    const request = new Request('https://worker.example/api/referrals/stats?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });
    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
        REFERRAL_TOKENS_PER_INVITE: '3',
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      total: 2,
      active: 1,
      rewarded: 1,
      tokens: 6,
      reward_per_invite: 3,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/referrals/tokens returns DB-backed token history', async () => {
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM token_balances')) {
      assert.equal(params[0], '12345');
      return { rows: [{ balance: 9 }] };
    }
    if (sql.includes('FROM token_transactions')) {
      assert.equal(params[0], '12345');
      return {
        rows: [
          { id: 1, amount: 3, tx_type: 'referral_reward', description: 'Invite reward', ref_id: '7', created_at: now },
        ],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/referrals/tokens');
  };

  try {
    const request = new Request('https://worker.example/api/referrals/tokens?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });
    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.balance, 9);
    assert.equal(body.history.length, 1);
    assert.equal(body.history[0].type, 'referral_reward');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/notify returns standardized success payload when Telegram send succeeds', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  const { stub, calls } = createFetchStub(async () => new Response(JSON.stringify({ ok: true }), { status: 200 }));
  global.fetch = stub;

  try {
    const request = new Request('https://worker.example/api/notify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', message: 'hello' }),
    });
    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success', sent: true });
    assert.equal(calls.length, 1);
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

test('POST / accepts Telegram webhook payloads as a compatibility alias', async () => {
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
    const request = new Request('https://worker.example/', {
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
  } finally {
    global.fetch = originalFetch;
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

test('POST /api/assistant/chat returns 501 without calling backend or recording usage', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const rateLimits = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/assistant/chat');
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

    assert.equal(response.status, 501);
    assert.deepEqual(await response.json(), {
      status: 'error',
      message: 'assistant service is disabled on this worker',
    });
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await rateLimits.get('ai:cooldown:12345'), null);
    assert.equal(await rateLimits.get(`ai:msgs:12345:${today}`), null);
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

test('POST /api/tickets validates auth before proxying', async () => {
  const worker = loadWorker();
  let backendCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/tickets', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'spoofed', title: 't', body: 'b' }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 401);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), { detail: 'Missing Telegram init data' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/tickets ignores spoofed user_id and stores ticket in SESSION_CACHE', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/tickets');
  };

  try {
    const request = new Request('https://worker.example/api/tickets', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', user_name: 'x', title: 't', body: 'b' }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.ticket.user_id, '12345');
    assert.equal(body.ticket.user_name, 'x');
    const storedTickets = JSON.parse((await sessionCache.get('tickets:all')) || '[]');
    assert.equal(storedTickets.length, 1);
    assert.equal(storedTickets[0].id, body.ticket.id);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/tickets returns only authenticated user tickets', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv({
    'tickets:all': JSON.stringify([
      { id: 't1', user_id: '12345', user_name: 'x', title: 't', body: 'b', status: 'open', replies: [], created_at: new Date().toISOString() },
      { id: 't2', user_id: '999', user_name: 'y', title: 't2', body: 'b2', status: 'open', replies: [], created_at: new Date().toISOString() },
    ]),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/tickets');
  };

  try {
    const request = new Request('https://worker.example/api/tickets?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.tickets.length, 1);
    assert.equal(body.tickets[0].id, 't1');
    assert.equal(body.tickets[0].user_id, '12345');
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/tickets/all rejects non-admin user before proxying', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  let backendCalled = false;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/tickets/all?admin_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 403);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), { detail: 'Admin access required' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/tickets/all allows admin and returns all tickets from SESSION_CACHE', async () => {
  const worker = loadWorker();
  const adminUser = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', adminUser);
  const sessionCache = createMemoryKv({
    'tickets:all': JSON.stringify([{ id: 't1', user_id: '12345', user_name: 'x', title: 't', body: 'b', status: 'open', replies: [], created_at: new Date().toISOString() }]),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/tickets/all');
  };

  try {
    const request = new Request('https://worker.example/api/tickets/all?admin_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.tickets.length, 1);
    assert.equal(body.tickets[0].id, 't1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/tickets/:id/reply rejects non-admin user before proxying', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  let backendCalled = false;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/tickets/t1/reply', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ message: 'hello' }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 403);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), { detail: 'Admin access required' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('DELETE /api/tickets/:id deletes ticket when user owns it', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv({
    'tickets:all': JSON.stringify([{ id: 't1', user_id: '12345', user_name: 'x', title: 't', body: 'b', status: 'open', replies: [], created_at: new Date().toISOString() }]),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/tickets/:id delete');
  };

  try {
    const request = new Request('https://worker.example/api/tickets/t1?user_id=spoofed&admin_id=spoofed', {
      method: 'DELETE',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success' });
    assert.equal(await sessionCache.get('tickets:all'), JSON.stringify([]));
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/alerts validates auth before proxying', async () => {
  const worker = loadWorker();
  let backendCalled = false;
  const originalFetch = global.fetch;
  global.fetch = async () => {
    backendCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/alerts', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ user_id: 'spoofed', symbol: 'btc', price: 10, direction: 'above' }),
    });

    const response = await worker.fetch(request, createEnv());
    assert.equal(response.status, 401);
    assert.equal(backendCalled, false);
    assert.deepEqual(await response.json(), { detail: 'Missing Telegram init data' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/alerts ignores spoofed user_id and stores alert in SESSION_CACHE', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/alerts');
  };

  try {
    const request = new Request('https://worker.example/api/alerts', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ user_id: 'spoofed', symbol: 'btc', price: 10, direction: 'above' }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.alert.user_id, '12345');
    assert.equal(body.alert.symbol, 'btc');
    assert.ok(body.alert.id);
    const storedAlerts = JSON.parse((await sessionCache.get('alerts:12345')) || '[]');
    assert.equal(storedAlerts.length, 1);
    assert.equal(storedAlerts[0].id, body.alert.id);
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/alerts returns stored alerts for authenticated user', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv({
    'alerts:12345': JSON.stringify([{ id: 'a1', user_id: '12345', symbol: 'BTC', price: 10, direction: 'above', created_at: new Date().toISOString() }]),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/alerts');
  };

  try {
    const request = new Request('https://worker.example/api/alerts?user_id=spoofed', {
      method: 'GET',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.alerts.length, 1);
    assert.equal(body.alerts[0].id, 'a1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('DELETE /api/alerts/:id removes alert for authenticated user', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const sessionCache = createMemoryKv({
    'alerts:12345': JSON.stringify([{ id: 'a1', user_id: '12345', symbol: 'BTC', price: 10, direction: 'above', created_at: new Date().toISOString() }]),
  });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/alerts delete');
  };

  try {
    const request = new Request('https://worker.example/api/alerts/a1?user_id=spoofed', {
      method: 'DELETE',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const response = await worker.fetch(
      request,
      createEnv({
        SESSION_CACHE: sessionCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success', deleted: true });
    assert.equal(await sessionCache.get('alerts:12345'), JSON.stringify([]));
  } finally {
    global.fetch = originalFetch;
  }
});

test('Render removal: repo no longer hardcodes onrender.com in runtime config files', async () => {
  const files = [
    path.join(__dirname, 'index.html'),
    path.join(__dirname, 'env.example'),
    path.join(__dirname, 'main.py'),
    path.join(__dirname, 'webapp', 'pages-dist', 'index.html'),
  ];

  for (const filePath of files) {
    const content = fs.readFileSync(filePath, 'utf8');
    assert.equal(content.includes('onrender.com'), false, `Found onrender.com in ${filePath}`);
  }
});

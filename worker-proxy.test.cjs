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

  const encodedEntries = entries.map(([key, value]) => [key, encodeURIComponent(value)]);

  const dataCheckString = encodedEntries
    .slice()
    .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
    .map(([key, encodedValue]) => `${key}=${encodedValue}`)
    .join('\n');

  const secretKey = crypto.createHmac('sha256', 'WebAppData').update(botToken).digest();
  const hash = crypto.createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

  return encodedEntries
    .concat([['hash', hash]])
    .map(([key, value]) => `${key}=${value}`)
    .join('&');
}

function loadValidateTelegramInitData() {
  const workerPath = path.join(__dirname, 'worker-proxy.js');
  const source = fs.readFileSync(workerPath, 'utf8');
  const helperStart = source.indexOf('function parseTelegramInitDataPairs');
  const helperEnd = source.indexOf('function authenticateTelegramRequest');
  const helperSrc = source.slice(helperStart, helperEnd);
  const exportsObj = {};
  const evaluator = new Function(
    'createHmac',
    'timingSafeEqual',
    'Buffer',
    'exports',
    `${helperSrc}; exports.validateTelegramInitData = validateTelegramInitData;`,
  );
  evaluator(crypto.createHmac, crypto.timingSafeEqual, Buffer, exportsObj);
  return exportsObj.validateTelegramInitData;
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

test('buildInitData round-trip passes validateTelegramInitData', () => {
  const validateTelegramInitData = loadValidateTelegramInitData();
  const botToken = 'test-bot-token';
  const user = { id: 98765, first_name: 'RoundTrip', username: 'rt_user' };
  const initData = buildInitData(botToken, user);
  const parsed = validateTelegramInitData(initData, botToken);
  assert.ok(parsed);
  assert.equal(parsed.id, user.id);
});

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

test('POST /api/assistant/chat without Telegram init data is rejected when DEV_MODE is not enabled', async () => {
  const prevDevMode = process.env.DEV_MODE;
  delete process.env.DEV_MODE;

  const worker = loadWorker();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called when auth fails');
  };

  try {
    const request = new Request('https://worker.example/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: 'spoofed', message: 'hi', history: [] }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        RATE_LIMITS: createMemoryKv(),
      }),
    );
    assert.equal(response.status, 401);
    assert.deepEqual(await response.json(), { detail: 'Missing Telegram init data' });
  } finally {
    global.fetch = originalFetch;
    if (prevDevMode === undefined) {
      delete process.env.DEV_MODE;
    } else {
      process.env.DEV_MODE = prevDevMode;
    }
  }
});

test('POST /api/assistant/chat in DEV_MODE bypasses Telegram init data and uses mocked user id', async () => {
  const prevDevMode = process.env.DEV_MODE;
  process.env.DEV_MODE = 'true';

  const worker = loadWorker();
  const rateLimits = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }
    const body = JSON.parse(await new Response(init.body).text());
    assert.equal(body.contents[0].parts[0].text.includes('user: hi'), true);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'gemini reply' }],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
  };

  try {
    const request = new Request('https://worker.example/api/assistant/chat', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      body: JSON.stringify({ user_id: 'spoofed', message: 'hi', history: [] }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        RATE_LIMITS: rateLimits,
        GEMINI_API_KEY: 'gemini-key',
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      reply: 'gemini reply',
      provider: 'gemini',
    });

    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await rateLimits.get('ai:cooldown:12345'), '1');
    assert.equal(await rateLimits.get(`ai:msgs:12345:${today}`), '1');
  } finally {
    global.fetch = originalFetch;
    process.env.DEV_MODE = prevDevMode;
  }
});

test('POST /api/assistant/chat returns AI reply from Gemini and records usage in RATE_LIMITS', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const rateLimits = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (!String(url).includes('generativelanguage.googleapis.com')) {
      throw new Error(`Unexpected fetch url: ${url}`);
    }
    const body = JSON.parse(await new Response(init.body).text());
    assert.equal(body.contents[0].parts[0].text.includes('user: hi'), true);
    return new Response(
      JSON.stringify({
        candidates: [
          {
            content: {
              parts: [{ text: 'gemini reply' }],
            },
          },
        ],
      }),
      {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      },
    );
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
        GEMINI_API_KEY: 'gemini-key',
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      reply: 'gemini reply',
      provider: 'gemini',
    });
    const today = new Date().toISOString().slice(0, 10);
    assert.equal(await rateLimits.get('ai:cooldown:12345'), '1');
    assert.equal(await rateLimits.get(`ai:msgs:12345:${today}`), '1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/assistant/chat falls back to OpenRouter when Gemini fails', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const rateLimits = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    if (String(url).includes('generativelanguage.googleapis.com')) {
      return new Response(JSON.stringify({ error: { message: 'gemini down' } }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('openrouter.ai')) {
      const body = JSON.parse(await new Response(init.body).text());
      assert.equal(body.model, 'meta-llama/llama-3.3-70b-instruct:free');
      return new Response(
        JSON.stringify({
          choices: [{ message: { content: 'openrouter reply' } }],
        }),
        {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        },
      );
    }
    throw new Error(`Unexpected fetch url: ${url}`);
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
        GEMINI_API_KEY: 'gemini-key',
        OPENROUTER_API_KEY: 'openrouter-key',
      }),
    );

    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      reply: 'openrouter reply',
      provider: 'openrouter',
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/assistant/chat returns 503 when all AI providers fail and does not record usage', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const rateLimits = createMemoryKv();
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called when no AI provider is configured');
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

    assert.equal(response.status, 503);
    assert.deepEqual(await response.json(), {
      status: 'error',
      reason: 'all_providers_failed',
      detail: 'DeepSeek not configured',
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

test('POST /api/tickets ignores spoofed user_id and stores ticket in DB', async () => {
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('ON CONFLICT (telegram_id) DO NOTHING')) {
      assert.equal(params[0], '12345');
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO tickets')) {
      return {
        rows: [
          {
            id: 'ticket-1',
            user_id: '12345',
            user_name: 'x',
            title: 't',
            body: 'b',
            status: 'open',
            created_at: now,
          },
        ],
      };
    }
    if (sql.includes('FROM ticket_replies')) {
      assert.equal(params[0], 'ticket-1');
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
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
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.ticket.user_id, '12345');
    assert.equal(body.ticket.user_name, 'x');
    assert.equal(body.ticket.id, 'ticket-1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/tickets returns only authenticated user tickets from DB', async () => {
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM tickets') && sql.includes('WHERE user_id = $1')) {
      assert.equal(params[0], '12345');
      return {
        rows: [
          { id: 't1', user_id: '12345', user_name: 'x', title: 't', body: 'b', status: 'open', created_at: now },
        ],
      };
    }
    if (sql.includes('FROM ticket_replies')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
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
        DATABASE_URL: 'postgres://db.example/app',
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

test('GET /api/tickets/all allows admin and returns all tickets from DB', async () => {
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql) => {
    if (sql.includes('FROM tickets') && !sql.includes('WHERE user_id = $1')) {
      return {
        rows: [
          { id: 't1', user_id: '12345', user_name: 'x', title: 't', body: 'b', status: 'open', created_at: now },
        ],
      };
    }
    if (sql.includes('FROM ticket_replies')) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const adminUser = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', adminUser);
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
        DATABASE_URL: 'postgres://db.example/app',
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

test('DELETE /api/tickets/:id deletes ticket when user owns it in DB', async () => {
  let deletedTicketId = null;
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('DELETE FROM tickets')) {
      deletedTicketId = params[0];
      return { rows: [] };
    }
    if (sql.includes('FROM tickets') && sql.includes('WHERE id = $1')) {
      assert.equal(params[0], 't1');
      return {
        rows: [
          { id: 't1', user_id: '12345', user_name: 'x', title: 't', body: 'b', status: 'open', created_at: now },
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
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success' });
    assert.equal(deletedTicketId, 't1');
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

test('POST /api/alerts ignores spoofed user_id and stores alert in DB', async () => {
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('ON CONFLICT (telegram_id) DO NOTHING')) {
      assert.equal(params[0], '12345');
      return { rows: [] };
    }
    if (sql.includes('FROM price_alerts') && sql.includes('LIMIT 1')) {
      return { rows: [] };
    }
    if (sql.includes('INSERT INTO price_alerts')) {
      return {
        rows: [
          { id: 'a1', user_id: '12345', symbol: 'BTC', price: 10, direction: 'above', created_at: now },
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
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.alert.user_id, '12345');
    assert.equal(body.alert.symbol, 'BTC');
    assert.equal(body.alert.id, 'a1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/alerts returns stored alerts for authenticated user from DB', async () => {
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM price_alerts') && sql.includes("status = 'active'")) {
      assert.equal(params[0], '12345');
      return {
        rows: [{ id: 'a1', user_id: '12345', symbol: 'BTC', price: 10, direction: 'above', created_at: now }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
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
        DATABASE_URL: 'postgres://db.example/app',
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

test('DELETE /api/alerts/:id removes alert for authenticated user in DB', async () => {
  let deletedAlertId = null;
  const now = new Date().toISOString();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('DELETE FROM price_alerts')) {
      deletedAlertId = params[0];
      return { rows: [] };
    }
    if (sql.includes('FROM price_alerts') && sql.includes('WHERE id = $1')) {
      assert.equal(params[0], 'a1');
      return {
        rows: [{ id: 'a1', user_id: '12345', symbol: 'BTC', price: 10, direction: 'above', created_at: now }],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
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
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), { status: 'success', deleted: true });
    assert.equal(deletedAlertId, 'a1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('GET /api/analyses falls back to DB and hydrates APP_CACHE on cache miss', async () => {
  const now = new Date().toISOString();
  const analysesCache = createMemoryKv();
  const pgMock = createPgMock(async (sql) => {
    if (sql.includes('FROM analyses') && sql.includes('ORDER BY created_at DESC')) {
      return {
        rows: [
          {
            id: 'an1',
            coin: 'BTC',
            timeframe: '4h',
            image: 'https://example.test/a.png',
            text: 'analysis body',
            author: 'admin',
            author_id: '831704732',
            created_at: now,
            updated_at: now,
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/analyses');
  };

  try {
    const request = new Request('https://worker.example/api/analyses', {
      method: 'GET',
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
        APP_CACHE: analysesCache,
      }),
    );
    assert.equal(response.status, 200);
    assert.deepEqual(await response.json(), {
      status: 'success',
      analyses: [
        {
          id: 'an1',
          coin: 'BTC',
          timeframe: '4h',
          image: 'https://example.test/a.png',
          text: 'analysis body',
          author: 'admin',
          author_id: '831704732',
          date: now.slice(0, 10),
          created_at: now,
          updated_at: now,
        },
      ],
      version: 1,
    });
    assert.equal(await analysesCache.get('analyses:version'), '1');
    assert.equal(
      await analysesCache.get('analyses:list'),
      JSON.stringify([
        {
          id: 'an1',
          coin: 'BTC',
          timeframe: '4h',
          image: 'https://example.test/a.png',
          text: 'analysis body',
          author: 'admin',
          author_id: '831704732',
          date: now.slice(0, 10),
          created_at: now,
          updated_at: now,
        },
      ]),
    );
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/analyses rejects non-admin user before touching DB', async () => {
  const worker = loadWorker();
  const authUser = { id: 12345, first_name: 'Amir' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  let fetchCalled = false;
  global.fetch = async () => {
    fetchCalled = true;
    return new Response('unexpected');
  };

  try {
    const request = new Request('https://worker.example/api/analyses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({ coin: 'btc', timeframe: '4h', image: '', text: 'body', author: 'spoofed' }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
      }),
    );
    assert.equal(response.status, 403);
    assert.equal(fetchCalled, false);
    assert.deepEqual(await response.json(), { detail: 'Admin access required' });
  } finally {
    global.fetch = originalFetch;
  }
});

test('POST /api/analyses stores analysis in DB, ignores spoofed author_id, and bumps cache version', async () => {
  const now = new Date().toISOString();
  const analysesCache = createMemoryKv();
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('INSERT INTO analyses')) {
      assert.equal(params[1], 'BTC');
      assert.equal(params[2], '4h');
      assert.equal(params[5], 'Desk');
      assert.equal(params[6], '831704732');
      return {
        rows: [
          {
            id: 'an1',
            coin: 'BTC',
            timeframe: '4h',
            image: '',
            text: 'analysis body',
            author: 'Desk',
            author_id: '831704732',
            created_at: now,
            updated_at: now,
          },
        ],
      };
    }
    if (sql.includes('FROM analyses') && sql.includes('ORDER BY created_at DESC')) {
      return {
        rows: [
          {
            id: 'an1',
            coin: 'BTC',
            timeframe: '4h',
            image: '',
            text: 'analysis body',
            author: 'Desk',
            author_id: '831704732',
            created_at: now,
            updated_at: now,
          },
        ],
      };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/analyses create');
  };

  try {
    const request = new Request('https://worker.example/api/analyses', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({
        coin: 'btc',
        timeframe: '4h',
        image: '',
        text: 'analysis body',
        author: 'Desk',
        author_id: 'spoofed',
      }),
    });

    const response = await worker.fetch(
      request,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
        APP_CACHE: analysesCache,
      }),
    );
    assert.equal(response.status, 200);
    const body = await response.json();
    assert.equal(body.status, 'success');
    assert.equal(body.analysis.id, 'an1');
    assert.equal(body.analysis.author_id, '831704732');
    assert.equal(body.version, 1);
    assert.equal(await analysesCache.get('analyses:version'), '1');
  } finally {
    global.fetch = originalFetch;
  }
});

test('PUT and DELETE /api/analyses/:id update DB-backed cache version', async () => {
  const now = new Date().toISOString();
  const analysesCache = createMemoryKv({
    'analyses:version': '4',
    'analyses:list': JSON.stringify([]),
  });
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('UPDATE analyses')) {
      assert.equal(params[0], 'an1');
      assert.equal(params[1], 'ETH');
      return {
        rows: [
          {
            id: 'an1',
            coin: 'ETH',
            timeframe: '1d',
            image: '',
            text: 'updated body',
            author: 'Desk',
            author_id: '831704732',
            created_at: now,
            updated_at: now,
          },
        ],
      };
    }
    if (sql.includes('DELETE FROM analyses')) {
      assert.equal(params[0], 'an1');
      return { rows: [{ id: 'an1' }] };
    }
    if (sql.includes('FROM analyses') && sql.includes('ORDER BY created_at DESC')) {
      const version = await analysesCache.get('analyses:version');
      if (version === '4') {
        return {
          rows: [
            {
              id: 'an1',
              coin: 'ETH',
              timeframe: '1d',
              image: '',
              text: 'updated body',
              author: 'Desk',
              author_id: '831704732',
              created_at: now,
              updated_at: now,
            },
          ],
        };
      }
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const authUser = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', authUser);
  const originalFetch = global.fetch;
  global.fetch = async () => {
    throw new Error('fetch should not be called for /api/analyses update/delete');
  };

  try {
    const updateRequest = new Request('https://worker.example/api/analyses/an1', {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/json',
        'X-Telegram-Init-Data': initData,
      },
      body: JSON.stringify({
        coin: 'eth',
        timeframe: '1d',
        image: '',
        text: 'updated body',
      }),
    });

    const updateResponse = await worker.fetch(
      updateRequest,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
        APP_CACHE: analysesCache,
      }),
    );
    assert.equal(updateResponse.status, 200);
    assert.equal((await updateResponse.json()).version, 5);
    assert.equal(await analysesCache.get('analyses:version'), '5');

    const deleteRequest = new Request('https://worker.example/api/analyses/an1', {
      method: 'DELETE',
      headers: {
        'X-Telegram-Init-Data': initData,
      },
    });

    const deleteResponse = await worker.fetch(
      deleteRequest,
      createEnv({
        DATABASE_URL: 'postgres://db.example/app',
        APP_CACHE: analysesCache,
      }),
    );
    assert.equal(deleteResponse.status, 200);
    assert.deepEqual(await deleteResponse.json(), { status: 'success', version: 6 });
    assert.equal(await analysesCache.get('analyses:version'), '6');
    assert.equal(await analysesCache.get('analyses:list'), JSON.stringify([]));
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduled alerts runner triggers active price alerts and marks them triggered in DB', async () => {
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM price_alerts') && sql.includes("status = 'active'")) {
      return {
        rows: [
          { id: 'a1', user_id: '12345', symbol: 'BTC', price: 100, direction: 'above' },
          { id: 'a2', user_id: '12345', symbol: 'ETH', price: 999999, direction: 'above' },
        ],
      };
    }
    if (sql.includes('UPDATE price_alerts') && sql.includes("status = 'triggered'")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const calls = [];
  const originalFetch = global.fetch;
  global.fetch = async (url, init = {}) => {
    calls.push({ url: String(url), method: init.method || 'GET', body: init.body ? await new Response(init.body).text() : null });
    if (String(url).includes('api.binance.com/api/v3/ticker/price')) {
      return new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '101' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('api.mexc.com/api/v3/ticker/price')) {
      return new Response(JSON.stringify({ symbol: 'ETHUSDT', price: '2000' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: true, result: { message_id: 1 } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const pending = [];
    const ctx = {
      waitUntil(promise) {
        pending.push(promise);
      },
    };
    await worker.scheduled(
      { cron: '*/10 * * * *' },
      createEnv({
        ALERTS_CRON_ENABLED: 'true',
        DATABASE_URL: 'postgres://db.example/app',
      }),
      ctx,
    );
    await Promise.all(pending);

    const updateCalls = pgMock.calls.filter((call) => String(call.sql).includes('UPDATE price_alerts'));
    assert.equal(updateCalls.length, 1);
    assert.equal(updateCalls[0].params[0], 'a1');

    const sendCalls = calls.filter((call) => call.url.includes('/sendMessage'));
    assert.equal(sendCalls.length, 1);
    assert.deepEqual(JSON.parse(sendCalls[0].body), {
      chat_id: 12345,
      text: '🔔 هشدار قیمت فعال شد\nBTC — قیمت فعلی: 101.000000\nهدف: 100.000000',
      disable_web_page_preview: true,
    });
  } finally {
    global.fetch = originalFetch;
  }
});

test('scheduled alerts runner does not mark alert triggered when Telegram delivery fails', async () => {
  const pgMock = createPgMock(async (sql, params) => {
    if (sql.includes('FROM price_alerts') && sql.includes("status = 'active'")) {
      return {
        rows: [{ id: 'a1', user_id: '12345', symbol: 'BTC', price: 100, direction: 'above' }],
      };
    }
    if (sql.includes('UPDATE price_alerts') && sql.includes("status = 'triggered'")) {
      return { rows: [] };
    }
    throw new Error(`Unexpected SQL: ${sql}`);
  });
  const worker = loadWorker({ pg: pgMock.module });
  const originalFetch = global.fetch;
  global.fetch = async (url) => {
    if (String(url).includes('api.binance.com/api/v3/ticker/price')) {
      return new Response(JSON.stringify({ symbol: 'BTCUSDT', price: '101' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    if (String(url).includes('/sendMessage')) {
      return new Response(JSON.stringify({ ok: false, description: 'forbidden' }), {
        status: 500,
        headers: { 'Content-Type': 'application/json' },
      });
    }
    return new Response('not found', { status: 404 });
  };

  try {
    const pending = [];
    const ctx = {
      waitUntil(promise) {
        pending.push(promise);
      },
    };
    await worker.scheduled(
      { cron: '*/10 * * * *' },
      createEnv({
        ALERTS_CRON_ENABLED: 'true',
        DATABASE_URL: 'postgres://db.example/app',
      }),
      ctx,
    );
    await Promise.all(pending);

    const updateCalls = pgMock.calls.filter((call) => String(call.sql).includes('UPDATE price_alerts'));
    assert.equal(updateCalls.length, 0);
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

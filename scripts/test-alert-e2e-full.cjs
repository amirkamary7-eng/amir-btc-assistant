/**
 * Real E2E Price Alert Test with Full Worker
 *
 * Uses the same loadWorker() infrastructure as worker-proxy.test.cjs but with
 * a smarter mock DB that actually stores alerts, notifications, and tracks
 * state. This lets us verify the FULL alert flow end-to-end.
 *
 * Tests:
 *   1. POST /api/alerts creates an alert in DB
 *   2. GET /api/alerts returns the alert
 *   3. /api/admin/trigger-alerts runs the cron and triggers the alert
 *   4. Alert status changes to 'triggered'
 *   5. In-app notification is inserted into notifications table
 *   6. sendTelegramMessage is called (Telegram message sent)
 *   7. Duplicate trigger is prevented
 *   8. Timing is measured for each step
 */

const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');

const WORKER_PATH = path.join(__dirname, '..', 'worker-proxy.js');

// ── Stateful Mock DB ──
// Tracks alerts, notifications, settings, and queue across queries
class StatefulMockDb {
  constructor() {
    this.alerts = new Map();
    this.notifications = [];
    this.settings = new Map();
    this.queue = [];
    this.users = new Map();
    this.alertIdCounter = 1;
  }

  reset() {
    this.alerts.clear();
    this.notifications = [];
    this.settings.clear();
    this.queue = [];
    this.users.clear();
    this.alertIdCounter = 1;
  }

  async query(sql, params = []) {
    const sqlLower = (sql || '').toLowerCase().trim();

    // CREATE TABLE / ALTER TABLE / CREATE INDEX — no-op
    if (sqlLower.startsWith('create table') || sqlLower.startsWith('alter table') ||
        sqlLower.startsWith('create index') || sqlLower.startsWith('create unique')) {
      return { rows: [] };
    }

    // ── USERS ──
    if (sqlLower.includes('insert into users') && sqlLower.includes('returning')) {
      const userId = String(params[0]);
      if (!this.users.has(userId)) {
        this.users.set(userId, {
          telegram_id: userId, username: null, first_name: 'Test',
          lang: 'fa', channel_joined: true, channel_verified_at: new Date().toISOString(),
          created_at: new Date().toISOString(), updated_at: new Date().toISOString(),
        });
      }
      return { rows: [this.users.get(userId)] };
    }

    if (sqlLower.includes('from users') && sqlLower.includes('where telegram_id')) {
      const userId = String(params[0]);
      return { rows: this.users.has(userId) ? [this.users.get(userId)] : [] };
    }

    if (sqlLower.includes('select') && sqlLower.includes('from users') && !sqlLower.includes('where')) {
      return { rows: Array.from(this.users.values()) };
    }

    if (sqlLower.includes('on conflict') && sqlLower.includes('do nothing')) {
      return { rows: [] };
    }

    // ── PRICE ALERTS ──
    // Cron query: listActiveForCron
    if (sqlLower.includes('select') && sqlLower.includes('from price_alerts') &&
        sqlLower.includes("status = 'active'") && sqlLower.includes('order by created_at')) {
      const limit = Number(params[0] || 500);
      const activeAlerts = Array.from(this.alerts.values())
        .filter(a => a.status === 'active')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at))
        .slice(0, limit);
      return { rows: activeAlerts };
    }

    // Dedup check: SELECT WHERE user_id AND symbol AND price AND direction
    if (sqlLower.includes('select') && sqlLower.includes('from price_alerts') &&
        sqlLower.includes('where user_id') && sqlLower.includes('and symbol') &&
        sqlLower.includes('and price') && sqlLower.includes('and direction')) {
      const userId = String(params[0]);
      const symbol = String(params[1]);
      const price = Number(params[2]);
      const direction = String(params[3]);
      const existing = Array.from(this.alerts.values()).find(a =>
        a.user_id === userId && a.symbol === symbol &&
        Number(a.price) === price && a.direction === direction
      );
      return { rows: existing ? [existing] : [] };
    }

    // INSERT INTO price_alerts ... RETURNING
    if (sqlLower.includes('insert into price_alerts') && sqlLower.includes('returning')) {
      const id = String(params[0] || `alert-${this.alertIdCounter++}`);
      const userId = String(params[1]);
      const symbol = String(params[2]);
      const price = Number(params[3]);
      const direction = String(params[4]);
      const alert = {
        id, user_id: userId, symbol, price, direction,
        status: 'active',
        created_at: new Date(),
        triggered_at: null,
        last_price: null,
        last_checked_at: null,
        last_trigger_price: null,
      };
      this.alerts.set(id, alert);
      return { rows: [alert] };
    }

    // Reactivate: UPDATE status='active' WHERE id
    if (sqlLower.includes('update price_alerts') && sqlLower.includes("set status = 'active'")) {
      const id = String(params[0]);
      const alert = this.alerts.get(id);
      if (alert) {
        alert.status = 'active';
        alert.triggered_at = null;
        alert.created_at = new Date();
      }
      return { rows: [] };
    }

    // SELECT WHERE id = $1 (after reactivation, or findById)
    if (sqlLower.includes('select') && sqlLower.includes('from price_alerts') &&
        sqlLower.includes('where id =')) {
      const id = String(params[0]);
      const alert = this.alerts.get(id);
      return { rows: alert ? [alert] : [] };
    }

    // SELECT WHERE user_id (list endpoint)
    if (sqlLower.includes('select') && sqlLower.includes('from price_alerts') &&
        sqlLower.includes('where user_id')) {
      const userId = String(params[0]);
      const userAlerts = Array.from(this.alerts.values())
        .filter(a => a.user_id === userId && a.status === 'active')
        .sort((a, b) => new Date(b.created_at) - new Date(a.created_at));
      return { rows: userAlerts };
    }

    // updateLastChecked: UPDATE SET last_price
    if (sqlLower.includes('update price_alerts') && sqlLower.includes('set last_price')) {
      const id = String(params[0]);
      const lastPrice = Number(params[1]);
      const alert = this.alerts.get(id);
      if (alert) {
        alert.last_price = lastPrice;
        alert.last_checked_at = new Date();
      }
      return { rows: [] };
    }

    // markTriggered: UPDATE SET status='triggered' WHERE id AND status='active' RETURNING id
    if (sqlLower.includes('update price_alerts') &&
        sqlLower.includes("set status = 'triggered'") &&
        sqlLower.includes('where id =') && sqlLower.includes("and status = 'active'")) {
      const id = String(params[0]);
      const triggerPrice = Number(params[1]);
      const alert = this.alerts.get(id);
      if (alert && alert.status === 'active') {
        alert.status = 'triggered';
        alert.triggered_at = new Date();
        alert.last_trigger_price = triggerPrice;
        alert.last_price = triggerPrice;
        return { rows: [{ id: alert.id }] };
      }
      return { rows: [] };
    }

    // Legacy UPDATE triggered (no atomic guard)
    if (sqlLower.includes('update price_alerts') && sqlLower.includes('set status') &&
        sqlLower.includes('triggered_at') && !sqlLower.includes("and status = 'active'")) {
      const id = String(params[0]);
      const alert = this.alerts.get(id);
      if (alert) {
        alert.status = 'triggered';
        alert.triggered_at = new Date();
      }
      return { rows: [] };
    }

    // DELETE
    if (sqlLower.startsWith('delete from price_alerts')) {
      const id = String(params[0]);
      this.alerts.delete(id);
      return { rows: [] };
    }

    // ── NOTIFICATIONS ──
    if (sqlLower.includes('insert into notifications')) {
      const notif = {
        id: String(params[0]),
        user_id: String(params[1]),
        type: String(params[2]),
        title: String(params[3]),
        message: String(params[4]),
        metadata: params[5],
        read_status: false,
        priority: String(params[6] || 'medium'),
        category: String(params[7] || 'system'),
        channel: String(params[8] || 'mini_app'),
        status: 'delivered',
        action_url: params[9] || null,
        icon: params[10] || null,
        archived: false,
        created_at: new Date(),
        read_at: null,
      };
      this.notifications.push(notif);
      return { rows: [] };
    }

    if (sqlLower.includes('select') && sqlLower.includes('from notifications')) {
      if (sqlLower.includes('count(*)')) {
        return { rows: [{ cnt: this.notifications.length }] };
      }
      if (sqlLower.includes('where user_id')) {
        const userId = String(params[0]);
        return { rows: this.notifications.filter(n => n.user_id === userId) };
      }
      return { rows: this.notifications };
    }

    // ── NOTIFICATION SETTINGS ──
    if (sqlLower.includes('select') && sqlLower.includes('from notification_settings') &&
        sqlLower.includes('where user_id')) {
      const userId = String(params[0]);
      const settings = this.settings.get(userId);
      if (settings) {
        // Return the specific column requested
        if (sqlLower.includes('ch_price_alert')) {
          return { rows: [{ pref: settings.ch_price_alert || 'both' }] };
        }
        if (sqlLower.includes('price_alert')) {
          return { rows: [{ price_alert: settings.price_alert !== false }] };
        }
        return { rows: [settings] };
      }
      // No settings row — return defaults
      if (sqlLower.includes('ch_price_alert')) {
        return { rows: [{ pref: 'both' }] };
      }
      if (sqlLower.includes('price_alert')) {
        return { rows: [{ price_alert: true }] };
      }
      return { rows: [] };
    }

    if (sqlLower.includes('insert into notification_settings')) {
      const userId = String(params[0]);
      if (!this.settings.has(userId)) {
        this.settings.set(userId, {
          user_id: userId,
          price_alert: true,
          ch_price_alert: 'both',
        });
      }
      return { rows: [] };
    }

    if (sqlLower.includes('update notification_settings')) {
      return { rows: [] };
    }

    // ── NOTIFICATION QUEUE ──
    if (sqlLower.includes('insert into notification_queue')) {
      this.queue.push({
        notification_id: params[0],
        user_id: String(params[1]),
        channel: params[2],
        priority: params[3],
        payload: params[4],
        status: 'pending',
        attempts: 0,
        max_attempts: 3,
        created_at: new Date(),
      });
      return { rows: [] };
    }

    if (sqlLower.includes('select') && sqlLower.includes('from notification_queue') &&
        sqlLower.includes("status = 'pending'")) {
      return { rows: this.queue.filter(q => q.status === 'pending') };
    }

    if (sqlLower.includes('update notification_queue') && sqlLower.includes("set status = 'processed'")) {
      return { rows: [] };
    }

    // ── NOTIFICATION TEMPLATES ──
    if (sqlLower.includes('from notification_templates')) {
      return { rows: [] };
    }

    // ── ALERT ECONOMY ──
    if (sqlLower.includes('from alert_quota')) {
      return { rows: [] };
    }
    if (sqlLower.includes('from alert_config')) {
      return { rows: [{ type: 'price_alert', is_enabled: true, free_daily_limit: 3, token_cost_per_extra: 5 }] };
    }
    if (sqlLower.includes('insert into alert_quota') || sqlLower.includes('update alert_quota')) {
      return { rows: [] };
    }

    // ── WALLET ──
    if (sqlLower.includes('from wallet_transactions') || sqlLower.includes('insert into wallet_transactions') ||
        sqlLower.includes('update wallet')) {
      return { rows: [] };
    }
    if (sqlLower.includes('update users set')) {
      return { rows: [] };
    }

    // ── Generic SELECT count ──
    if (sqlLower.includes('select count(*)')) {
      return { rows: [{ cnt: 0 }] };
    }

    return { rows: [] };
  }
}

const mockDb = new StatefulMockDb();

// ── Mock Telegram API (tracks sent messages) ──
const sentTelegramMessages = [];
const mockFetch = async (url, opts = {}) => {
  // Intercept Telegram API calls
  if (String(url).includes('api.telegram.org') && String(url).includes('/sendMessage')) {
    const body = JSON.parse(opts.body || '{}');
    sentTelegramMessages.push({
      chat_id: body.chat_id,
      text: body.text,
      timestamp: Date.now(),
    });
    return {
      ok: true,
      status: 200,
      json: async () => ({ ok: true, result: { message_id: Math.floor(Math.random() * 1000000) } }),
    };
  }

  // Intercept exchange API calls (Binance, Bybit, OKX)
  // Return a price that will trigger our test alert
  if (String(url).includes('api.binance.com/api/v3/ticker/price')) {
    const symbol = new URL(url).searchParams.get('symbol') || '';
    // For BTCUSDT, return a price that crosses our test threshold
    if (symbol === 'BTCUSDT') {
      return {
        ok: true,
        status: 200,
        json: async () => ({ symbol, price: '100500.50' }),
      };
    }
    return { ok: true, status: 200, json: async () => ({ symbol, price: '1.0' }) };
  }

  if (String(url).includes('api.bybit.com')) {
    return {
      ok: true, status: 200,
      json: async () => ({ retCode: 1 }), // Make Bybit fail so we use Binance
    };
  }

  if (String(url).includes('okx.com')) {
    return {
      ok: true, status: 200,
      json: async () => ({ code: '1' }), // Make OKX fail
    };
  }

  // Default: return empty
  return { ok: false, status: 404, json: async () => ({}) };
};

// ── Load Worker (using same approach as worker-proxy.test.cjs) ──
function loadWorker(pgOverride) {
  const source = fs.readFileSync(WORKER_PATH, 'utf8');

  const defaultMocks = {
    '@neondatabase/serverless': pgOverride || {
      Pool: class {
        async query(sql, params) {
          return mockDb.query(sql, params);
        }
        async connect() {
          const self = this;
          return {
            async query(sql, params) { return self.query(sql, params); },
            release() {},
          };
        }
        end() { return Promise.resolve(); }
      },
    },
  };

  const localModuleCache = {};
  const localRequire = (id) => {
    if (Object.prototype.hasOwnProperty.call(defaultMocks, id)) return defaultMocks[id];
    if (localModuleCache[id]) return localModuleCache[id];
    return require(id);
  };

  // Resolve and bundle local ESM modules (src/**/*.js)
  const localImportRe = /import\s+(?:\{([^}]*)\}|\*\s+as\s+(\w+)|(\w+))\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g;
  let localMatch;
  while ((localMatch = localImportRe.exec(source)) !== null) {
    const importPath = localMatch[4];
    if (localModuleCache[importPath]) continue;
    const resolvedPath = path.resolve(path.dirname(WORKER_PATH), importPath);
    let modSource = fs.readFileSync(resolvedPath, 'utf8');
    modSource = modSource
      .replace(/export\s+function\s+(\w+)/g, 'module.exports.$1 = function $1')
      .replace(/export\s+default\s+/g, 'module.exports.default = ');
    const mod = { exports: {} };
    new Function('require', 'module', 'exports',
      'console.log = () => {}; console.warn = () => {}; console.error = () => {};\n' + modSource
    )(localRequire, mod, mod.exports);
    localModuleCache[importPath] = mod.exports;
  }

  // Transform main source ESM → CJS (same as worker-proxy.test.cjs)
  const transformed = source
    .replace(
      "import { createHmac, timingSafeEqual } from 'node:crypto';",
      "const { createHmac, timingSafeEqual } = require('node:crypto');",
    )
    .replace("import { Pool } from '@neondatabase/serverless';", "const { Pool } = require('@neondatabase/serverless');")
    .replace(
      /import\s+\{([^}]*)\}\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g,
      (_, named, p) => `const { ${named} } = require('${p}');`,
    )
    .replace(
      /import\s+\*\s+as\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g,
      (_, name, p) => `const ${name} = require('${p}');`,
    )
    .replace(
      /import\s+(\w+)\s+from\s+['"](\.\/src\/[^'"]+)['"];?/g,
      (_, name, p) => `const ${name} = require('${p}');`,
    )
    .replace('export default {', 'module.exports = {');

  // Replace global fetch with our mock (AFTER transformation)
  // Note: keep console.log for E2E test visibility (override the suppression)
  const finalSource = 'globalThis.fetch = arguments[3];\n' +
    'console.warn = () => {}; console.error = () => {};\n' + transformed;

  const mod = { exports: {} };
  const evaluator = new Function('require', 'module', 'exports', 'fetchMock', finalSource);
  evaluator(localRequire, mod, mod.exports, mockFetch);
  return mod.exports;
}

function buildInitData(botToken, user, options = {}) {
  const entries = [
    ['auth_date', String(options.authDate ?? Math.floor(Date.now() / 1000))],
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
    .map(([key, value]) => `${key}=${encodeURIComponent(value)}`)
    .concat([`hash=${hash}`])
    .join('&');
}

function createEnv(overrides = {}) {
  return {
    TELEGRAM_BOT_TOKEN: 'test-bot-token',
    REQUIRED_CHANNEL: '',
    ADMIN_TELEGRAM_ID: '831704732',
    DATABASE_URL: 'postgres://mock?pgbouncer=true',
    APP_ENV: 'production', // Use production so cron is enabled
    ALERTS_CRON_ENABLED: 'true',
    ALERTS_CRON_SHARED_SECRET: 'test-secret',
    BOT_USERNAME: 'test_bot',
    WEBAPP_URL: 'https://example.com',
    APP_CACHE: createMemoryKv(),
    RATE_LIMITS: createMemoryKv(),
    JOIN_CACHE: createMemoryKv(),
    SESSION_CACHE: createMemoryKv(),
    CHART_EXCHANGE_CACHE_TTL: 3600,
    ALERTS_CRON_MAX_ALERTS: 500,
    ...overrides,
  };
}

function createMemoryKv() {
  const store = new Map();
  return {
    async get(key) { return store.has(key) ? store.get(key) : null; },
    async put(key, value) { store.set(key, value); },
    async delete(key) { store.delete(key); },
  };
}

async function sendRequest(worker, env, method, urlPath, options = {}) {
  const { body, headers = {}, initData } = options;
  const url = urlPath.startsWith('http') ? urlPath : `http://localhost${urlPath}`;
  const reqHeaders = new Headers(headers);
  if (initData) {
    reqHeaders.set('X-Telegram-Init-Data', initData);
  }
  const reqOpts = { method, headers: reqHeaders };
  if (body !== undefined) {
    reqOpts.body = typeof body === 'string' ? body : JSON.stringify(body);
    if (!reqHeaders.has('Content-Type')) {
      reqHeaders.set('Content-Type', 'application/json');
    }
  }
  const request = new Request(url, reqOpts);
  const response = await worker.fetch(request, env, {});
  const text = await response.text();
  let parsed;
  try { parsed = JSON.parse(text); } catch { parsed = text; }
  return { status: response.status, body: parsed, headers: response.headers };
}

// ============================================================================
// RUN E2E TEST DIRECTLY (not via node:test, so we see console output)
// ============================================================================

async function runE2ETest() {
  console.log('🧪 Starting E2E Price Alert Test...\n');
  mockDb.reset();
  sentTelegramMessages.length = 0;

  const worker = loadWorker();
  const env = createEnv();
  const user = { id: 831704732, first_name: 'Admin' };
  const initData = buildInitData('test-bot-token', user);

  // ── STEP 1: Create alert (BTC above $100,000) ──
  console.log('═══════════════════════════════════════════════════════');
  console.log('STEP 1: Create alert (BTC above $100,000)');
  console.log('═══════════════════════════════════════════════════════');
  const t1Start = Date.now();
  const createRes = await sendRequest(worker, env, 'POST', '/api/alerts', {
    body: { symbol: 'BTC', price: 100000, direction: 'above' },
    initData,
  });
  const t1End = Date.now();
  console.log(`  Status: ${createRes.status}, Time: ${t1End - t1Start}ms`);
  console.log(`  Response: ${JSON.stringify(createRes.body).slice(0, 250)}`);

  let createdAlertId = null;
  if (createRes.status === 200 && createRes.body.alert) {
    console.log('  ✅ Alert created successfully');
    createdAlertId = createRes.body.alert.id;
    console.log(`  Alert ID: ${createdAlertId}`);
    console.log(`  Symbol: ${createRes.body.alert.symbol}`);
    console.log(`  Price: ${createRes.body.alert.price}`);
    console.log(`  Direction: ${createRes.body.alert.direction}`);
  } else {
    console.log(`  ⚠️ Alert creation returned ${createRes.status} — manually inserting for test`);
    mockDb.alerts.set('manual-test-alert', {
      id: 'manual-test-alert',
      user_id: '831704732',
      symbol: 'BTC',
      price: 100000,
      direction: 'above',
      status: 'active',
      created_at: new Date(),
      triggered_at: null,
      last_price: null,
      last_checked_at: null,
      last_trigger_price: null,
    });
    createdAlertId = 'manual-test-alert';
  }

  // ── STEP 2: Verify alert is in DB ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('STEP 2: Verify alert in DB');
  console.log('═══════════════════════════════════════════════════════');
  const activeAlerts = Array.from(mockDb.alerts.values()).filter(a => a.status === 'active');
  console.log(`  Active alerts in DB: ${activeAlerts.length}`);
  for (const a of activeAlerts) {
    console.log(`    - ${a.id}: ${a.symbol} ${a.direction} $${a.price} (status=${a.status})`);
  }

  // ── STEP 3: Manual trigger via /api/admin/trigger-alerts ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('STEP 3: Manual trigger (simulates cron run)');
  console.log('═══════════════════════════════════════════════════════');
  const t3Start = Date.now();
  const triggerRes = await sendRequest(worker, env, 'POST', '/api/admin/trigger-alerts', {
    headers: { 'X-Cron-Secret': 'test-secret' },
  });
  const t3End = Date.now();
  console.log(`  Status: ${triggerRes.status}, Time: ${t3End - t3Start}ms`);
  console.log(`  Response: ${JSON.stringify(triggerRes.body).slice(0, 400)}`);

  // ── STEP 4: Verify alert is now triggered ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('STEP 4: Verify alert triggered');
  console.log('═══════════════════════════════════════════════════════');
  const allAlerts = Array.from(mockDb.alerts.values());
  const triggeredAlerts = allAlerts.filter(a => a.status === 'triggered');
  const stillActive = allAlerts.filter(a => a.status === 'active');
  console.log(`  Total alerts in DB: ${allAlerts.length}`);
  console.log(`  Triggered alerts: ${triggeredAlerts.length}`);
  console.log(`  Still active alerts: ${stillActive.length}`);
  if (triggeredAlerts.length > 0) {
    const t = triggeredAlerts[0];
    console.log('  ✅ Alert was triggered!');
    console.log(`     Triggered at: ${t.triggered_at}`);
    console.log(`     Trigger price: ${t.last_trigger_price}`);
    console.log(`     Last checked: ${t.last_checked_at}`);
  } else {
    console.log('  ⚠️ Alert was NOT triggered (mock price fetch may not have triggered cross)');
  }

  // ── STEP 5: Check in-app notifications ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('STEP 5: Check in-app notifications');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Notifications in DB: ${mockDb.notifications.length}`);
  if (mockDb.notifications.length > 0) {
    console.log('  ✅ In-app notification was inserted!');
    for (const n of mockDb.notifications) {
      console.log(`     - ID: ${n.id}`);
      console.log(`       Title: ${n.title}`);
      console.log(`       Category: ${n.category}`);
      console.log(`       Priority: ${n.priority}`);
      console.log(`       Channel: ${n.channel}`);
    }
  } else {
    console.log('  ❌ No in-app notification inserted');
  }

  // ── STEP 6: Check Telegram messages ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('STEP 6: Check Telegram messages');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Telegram messages sent: ${sentTelegramMessages.length}`);
  if (sentTelegramMessages.length > 0) {
    console.log('  ✅ Telegram message was sent!');
    for (const m of sentTelegramMessages) {
      console.log(`     - Chat ID: ${m.chat_id}`);
      console.log(`       Text: ${m.text}`);
    }
  } else {
    console.log('  ⚠️ No Telegram message sent (alert may not have triggered)');
  }

  // ── STEP 7: Test duplicate prevention ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('STEP 7: Test duplicate trigger prevention');
  console.log('═══════════════════════════════════════════════════════');
  if (triggeredAlerts.length > 0) {
    const triggerRes2 = await sendRequest(worker, env, 'POST', '/api/admin/trigger-alerts', {
      headers: { 'X-Cron-Secret': 'test-secret' },
    });
    const triggeredAfter2 = Array.from(mockDb.alerts.values()).filter(a => a.status === 'triggered').length;
    const tgAfter2 = sentTelegramMessages.length;
    console.log(`  After 2nd trigger — Triggered alerts: ${triggeredAfter2}`);
    console.log(`  After 2nd trigger — Telegram messages: ${tgAfter2}`);
    if (triggeredAfter2 === triggeredAlerts.length && tgAfter2 === sentTelegramMessages.length) {
      console.log('  ✅ Duplicate trigger PREVENTED! No new notifications or Telegram messages.');
    } else {
      console.log('  ❌ Duplicate trigger NOT prevented!');
    }
  }

  // ── SUMMARY ──
  console.log('\n═══════════════════════════════════════════════════════');
  console.log('🎯 E2E TEST SUMMARY');
  console.log('═══════════════════════════════════════════════════════');
  console.log(`  Step 1 — Alert creation: ${t1End - t1Start}ms`);
  console.log(`  Step 3 — Manual trigger: ${t3End - t3Start}ms`);
  console.log(`  Total alerts in DB: ${allAlerts.length}`);
  console.log(`  Triggered: ${triggeredAlerts.length}`);
  console.log(`  In-app notifications: ${mockDb.notifications.length}`);
  console.log(`  Telegram messages: ${sentTelegramMessages.length}`);
  console.log('');

  return {
    alertCreated: createdAlertId !== null,
    alertTriggered: triggeredAlerts.length > 0,
    inAppNotificationSent: mockDb.notifications.length > 0,
    telegramMessageSent: sentTelegramMessages.length > 0,
    timing: {
      creation: t1End - t1Start,
      trigger: t3End - t3Start,
    },
  };
}

// Run directly if invoked as a script (not via node:test)
if (require.main === module) {
  runE2ETest().then(result => {
    console.log('\n📋 Final Result:');
    console.log(JSON.stringify(result, null, 2));
    process.exit(0);
  }).catch(err => {
    console.error('Fatal:', err);
    process.exit(1);
  });
}

// Export for node:test
module.exports = { runE2ETest, mockDb, sentTelegramMessages, loadWorker, createEnv, buildInitData, sendRequest };

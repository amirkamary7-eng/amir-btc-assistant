import { createHmac, timingSafeEqual } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { createAlertRepository } from './src/repositories/alerts.js';
import { createAlertHandlers } from './src/controllers/alerts.js';
import { createWatchlistRepository } from './src/repositories/watchlist.js';
import { createWatchlistHandlers } from './src/controllers/watchlist.js';
import { createReferralRepository } from './src/repositories/referrals.js';
import { createReferralHandlers } from './src/controllers/referrals.js';
import { createSessionRepository } from './src/repositories/sessions.js';
import { createSessionHandlers } from './src/controllers/sessions.js';
import { createTicketRepository } from './src/repositories/tickets.js';
import { createTicketHandlers } from './src/controllers/tickets.js';
import { createUserRepository } from './src/repositories/users.js';
import { createUserHandlers } from './src/controllers/users.js';
import { createNotifyHandlers } from './src/controllers/notify.js';
import { createAssistantHandlers } from './src/controllers/assistant.js';
import { createAnalysisRepository } from './src/repositories/analyses.js';
import { createAnalysisHandlers } from './src/controllers/analyses.js';

/**
 * Cloudflare Worker Shell
 * این فایل اولین shell کم‌ریسک مهاجرت را طبق `docs/CLOUDFLARE_PLAN.md` پیاده‌سازی می‌کند.
 * در این مرحله:
 * - `GET /` و `GET /api/health` مستقیماً از Worker پاسخ می‌گیرند.
 * - `POST /telegram` و منطق `/start` روی Worker اجرا می‌شود.
 * - مسیرهای کلیدی `/api/*` مستقیماً روی Worker اجرا می‌شوند.
 */

// ============================================================================
//#region ثابت‌ها و ابزارهای کمکی
// ============================================================================
const CORS_METHODS = 'GET, POST, PUT, DELETE, OPTIONS';
const CORS_ALLOW_HEADERS = 'Content-Type, X-Telegram-Init-Data, X-Telegram-Bot-Api-Secret-Token';
function withCors(headers = {}, env = null) {
  const merged = new Headers(headers);
  if (env) {
    try {
      merged.set('Access-Control-Allow-Origin', new URL(resolveWebAppUrl(env)).origin);
    } catch {
      merged.set('Access-Control-Allow-Origin', '*');
    }
  } else {
    merged.set('Access-Control-Allow-Origin', '*');
  }
  merged.set('Access-Control-Allow-Methods', CORS_METHODS);
  merged.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  return merged;
}

function jsonResponse(payload, init = {}, env = null) {
  const headers = withCors(init.headers, env);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }

  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
}

function safeDbErrorResponse(error, options = {}, env = null) {
  const {
    statusValue = 'error',
    message = 'Database unavailable',
  } = options;

  return jsonResponse(
    {
      status: statusValue,
      message,
    },
    { status: 503 },
    env,
  );
}

const MAX_BODY_BYTES = 102400; // 100 KB

async function readJsonBody(request, maxSize = MAX_BODY_BYTES, env = null) {
  const contentLength = request.headers.get('Content-Length');
  if (contentLength && Number(contentLength) > maxSize) {
    return { error: jsonResponse({ detail: 'Request body too large' }, { status: 413 }, env) };
  }
  const body = await request.text();
  if (body.length > maxSize) {
    return { error: jsonResponse({ detail: 'Request body too large' }, { status: 413 }, env) };
  }
  try {
    return { payload: JSON.parse(body) };
  } catch {
    return { error: jsonResponse(buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null), { status: 422 }, env) };
  }
}

function getNumericEnv(env, key, fallbackValue) {
  const rawValue = Number(env[key]);
  return Number.isFinite(rawValue) ? rawValue : fallbackValue;
}

function isBotConfigured(env) {
  return Boolean(env.TELEGRAM_BOT_TOKEN && env.TELEGRAM_BOT_TOKEN !== 'REPLACE_WITH_TOKEN');
}

function isDatabaseConfigured(env) {
  return Boolean(env.DATABASE_URL || env.DIRECT_URL);
}

function isCacheLayerConfigured(env) {
  return Boolean(env.JOIN_CACHE && env.APP_CACHE && env.RATE_LIMITS && env.SESSION_CACHE);
}

function isAlertsCronEnabled(env) {
  return String(env.ALERTS_CRON_ENABLED || 'false').trim().toLowerCase() === 'true';
}

async function readAppCache(env, key) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.get !== 'function') {
    return null;
  }

  return env.APP_CACHE.get(key);
}

async function writeAppCache(env, key, value, expirationTtl) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.put !== 'function') {
    return;
  }

  await env.APP_CACHE.put(key, value, { expirationTtl });
}

async function readRateLimitCache(env, key) {
  if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.get !== 'function') {
    return null;
  }

  return env.RATE_LIMITS.get(key);
}

async function writeRateLimitCache(env, key, value, expirationTtl) {
  if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.put !== 'function') {
    return;
  }

  await env.RATE_LIMITS.put(key, value, { expirationTtl });
}

async function deleteRateLimitCache(env, key) {
  if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.delete !== 'function') {
    return;
  }

  await env.RATE_LIMITS.delete(key);
}

async function readSessionCache(env, key) {
  if (!env.SESSION_CACHE || typeof env.SESSION_CACHE.get !== 'function') {
    return null;
  }

  return env.SESSION_CACHE.get(key);
}

async function writeSessionCache(env, key, value, expirationTtl) {
  if (!env.SESSION_CACHE || typeof env.SESSION_CACHE.put !== 'function') {
    return;
  }

  await env.SESSION_CACHE.put(key, value, { expirationTtl });
}

async function deleteSessionCache(env, key) {
  if (!env.SESSION_CACHE || typeof env.SESSION_CACHE.delete !== 'function') {
    return;
  }

  await env.SESSION_CACHE.delete(key);
}

function buildFastApiValidationError(type, msg, input, ctx) {
  const detail = {
    type,
    loc: ['query', 'symbol'],
    msg,
    input,
  };

  if (ctx) {
    detail.ctx = ctx;
  }

  return { detail: [detail] };
}

function buildQueryFieldValidationError(fieldName, type, msg, input, ctx) {
  const detail = {
    type,
    loc: ['query', fieldName],
    msg,
    input,
  };

  if (ctx) {
    detail.ctx = ctx;
  }

  return { detail: [detail] };
}

function buildBodyFieldValidationError(fieldName, type, msg, input, ctx) {
  const detail = {
    type,
    loc: ['body', fieldName],
    msg,
    input,
  };

  if (ctx) {
    detail.ctx = ctx;
  }

  return { detail: [detail] };
}

function getTelegramInitData(request) {
  return request.headers.get('X-Telegram-Init-Data') || '';
}

function parseTelegramInitDataPairs(initData) {
  return String(initData || '')
    .split('&')
    .filter((segment) => segment && segment.includes('='))
    .map((segment) => {
      const [key, ...rest] = segment.split('=');
      return [key, rest.join('=')];
    });
}

function decodeTelegramValue(value) {
  try {
    return decodeURIComponent(String(value || '').replace(/\+/g, '%20'));
  } catch {
    return String(value || '');
  }
}

function safeCompareStrings(left, right) {
  const leftBuffer = new TextEncoder().encode(String(left || ''));
  const rightBuffer = new TextEncoder().encode(String(right || ''));
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

/**
 * C1/C2 FIX: Timing-safe string comparison that does NOT leak length.
 * Pads the shorter buffer to match the longer one before comparison.
 * Use this for comparing secrets/tokens of variable length.
 */
function timingSafeEqualSecret(a, b) {
  const aBuf = new TextEncoder().encode(String(a || ''));
  const bBuf = new TextEncoder().encode(String(b || ''));
  const maxLen = Math.max(aBuf.length, bBuf.length);
  if (maxLen === 0) return true;
  // Use HMAC as a constant-time comparison since timingSafeEqual requires equal length.
  // SHA-256 output is always 32 bytes → eliminates length side-channel.
  const hmac = createHmac('sha256', 'timing-comparison-key');
  hmac.update(aBuf);
  const hashA = hmac.digest();
  const hmac2 = createHmac('sha256', 'timing-comparison-key');
  hmac2.update(bBuf);
  const hashB = hmac2.digest();
  return timingSafeEqual(hashA, hashB);
}

function validateTelegramInitData(initData, botToken, maxAgeSeconds = 3600) {
  if (!initData || !botToken || botToken === 'REPLACE_WITH_TOKEN') {
    return null;
  }

  try {
    const pairs = parseTelegramInitDataPairs(initData.trim());
    const decoded = {};
    const checkPairs = [];
    let receivedHash = null;

    for (const [key, rawValue] of pairs) {
      const decodedValue = decodeTelegramValue(rawValue);
      decoded[key] = decodedValue;
      if (key === 'hash') {
        receivedHash = rawValue;
      } else {
        checkPairs.push([key, rawValue]);
      }
    }

    if (!receivedHash) {
      return null;
    }

    const dataCheckString = checkPairs
      .sort(([leftKey], [rightKey]) => leftKey.localeCompare(rightKey))
      .map(([key, rawValue]) => `${key}=${rawValue}`)
      .join('\n');

    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');
    if (!safeCompareStrings(computedHash, receivedHash)) {
      return null;
    }

    const authDate = Number(decoded.auth_date);
    if (Number.isFinite(authDate)) {
      const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
      if (ageSeconds > maxAgeSeconds) {
        return null;
      }
    }

    if (!decoded.user) {
      return null;
    }

    const user = JSON.parse(decoded.user);
    return user && user.id ? user : null;
  } catch {
    return null;
  }
}

function authenticateTelegramRequest(request, env) {
  const initData = getTelegramInitData(request);
  if (!initData) {
    return {
      error: jsonResponse({ detail: 'Missing Telegram init data' }, { status: 401 }, env),
      user: null,
    };
  }

  if (!isBotConfigured(env)) {
    return {
      error: jsonResponse({ detail: 'Telegram bot token is not configured' }, { status: 401 }, env),
      user: null,
    };
  }

  const user = validateTelegramInitData(initData, String(env.TELEGRAM_BOT_TOKEN || ''));
  if (!user || !user.id) {
    return {
      error: jsonResponse({ detail: 'Invalid Telegram init data' }, { status: 401 }, env),
      user: null,
    };
  }

  return { error: null, user };
}

/**
 * Optional Telegram auth — tries initData, falls back to a raw user_id.
 * Returns { user, authMethod, error }.
 *   - On initData success: { user, authMethod: 'init_data', error: null }
 *   - On fallback success: { user, authMethod: 'fallback', error: null }
 *   - On both fail:     { user: null, authMethod: null, error: <original auth Response> }
 */
function optionalTelegramAuth(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.user) {
    return { user: authState.user, authMethod: 'init_data', error: null };
  }

  // Auth failed — try query-param fallback for development/testing
  const url = new URL(request.url);
  const fallbackId = (url.searchParams.get('user_id') || '').trim();

  if (fallbackId && /^\d+$/.test(fallbackId)) {
    console.log(
      JSON.stringify({ scope: 'optional-auth-fallback', user_id: fallbackId }),
    );
    return { user: { id: fallbackId }, authMethod: 'fallback', error: null };
  }

  // No fallback available — preserve the original auth error for the caller
  return { user: null, authMethod: null, error: authState.error };
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

const JOIN_CACHE_PREFIX = 'join:';
const JOINED_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);
const dbPools = new Map();

function resolveDatabaseUrl(env) {
  const url = String(env.DATABASE_URL || env.DIRECT_URL || '').trim();
  if (url && !url.includes('pgbouncer=true')) {
    console.warn('DATABASE_URL should include ?pgbouncer=true for Neon serverless Pool');
  }
  return url;
}

function resolveRequiredChannel(env) {
  return String(env.REQUIRED_CHANNEL || 'amir_btc_2024').trim();
}

function resolveWebAppUrl(env, { cacheBust = true } = {}) {
  // WEBAPP_URL must be set as a secret (wrangler secret put WEBAPP_URL --env production)
  // to the Cloudflare Pages domain, e.g. https://ebac5d41.amir-btc-assistant-pages.pages.dev
  const baseUrl = String(env.WEBAPP_URL || '').trim();
  if (!baseUrl || !cacheBust) return baseUrl;

  // Append daily cache-busting param to prevent Telegram WebView from serving stale HTML.
  // Telegram WebView caches aggressively by URL — a static URL = cached page.
  // Changes daily, so every deploy is guaranteed to reach users within 24h.
  // The inline version-check script in index.html handles sub-daily updates.
  const dayStamp = Math.floor(Date.now() / 86400000).toString(36);
  const url = new URL(baseUrl);
  url.searchParams.set('_v', dayStamp);
  return url.toString();
}

/**
 * Validate Origin header against WEBAPP_URL for browser-sourced requests.
 * - If Origin is absent (server-to-server, cURL, Telegram webhook) → allow.
 * - If Origin is present and matches WEBAPP_URL origin → allow.
 * - If Origin is present and does NOT match → 403.
 * Skipped entirely when APP_ENV is "development".
 */
function validateReferrer(request, env) {
  if (String(env.APP_ENV || '') === 'development') {
    return null;
  }

  const origin = request.headers.get('Origin');
  if (!origin) {
    return null;
  }

  let allowedOrigin;
  try {
    allowedOrigin = new URL(resolveWebAppUrl(env)).origin;
  } catch {
    return null;
  }

  try {
    const requestOrigin = new URL(origin).origin;
    if (requestOrigin === allowedOrigin) {
      return null;
    }
  } catch {
    // malformed Origin header → reject
  }

  return jsonResponse(
    { status: 'error', message: 'Forbidden: invalid origin' },
    { status: 403 }, env);
}

function getJoinCacheKey(userId) {
  return `${JOIN_CACHE_PREFIX}${String(userId)}`;
}

async function getCachedJoinStatus(env, userId) {
  if (!env.JOIN_CACHE || typeof env.JOIN_CACHE.get !== 'function') {
    return null;
  }

  try {
    const cached = await env.JOIN_CACHE.get(getJoinCacheKey(userId));
    if (cached === '1') {
      return true;
    }
    if (cached === '0') {
      return false;
    }
  } catch (error) {
    console.warn('JOIN_CACHE read failed:', error);
  }

  return null;
}

async function setCachedJoinStatus(env, userId, joined) {
  if (!env.JOIN_CACHE || typeof env.JOIN_CACHE.put !== 'function') {
    return;
  }

  try {
    await env.JOIN_CACHE.put(getJoinCacheKey(userId), joined ? '1' : '0', {
      expirationTtl: getNumericEnv(env, 'JOIN_CACHE_TTL', 1800),
    });
  } catch (error) {
    console.warn('JOIN_CACHE write failed:', error);
  }
}

async function invalidateJoinCache(env, userId) {
  const hadCachedValue = (await getCachedJoinStatus(env, userId)) !== null;

  if (env.JOIN_CACHE && typeof env.JOIN_CACHE.delete === 'function') {
    try {
      await env.JOIN_CACHE.delete(getJoinCacheKey(userId));
    } catch (error) {
      console.warn('JOIN_CACHE delete failed:', error);
    }
  }

  return hadCachedValue;
}

function getTodayIsoDate() {
  return new Date().toISOString().slice(0, 10);
}

function normalizeRequiredChannel(rawValue) {
  let value = String(rawValue || '').trim();
  if (!value) {
    return '';
  }

  value = value.split('?', 1)[0].trim();
  if (value.startsWith('https://') || value.startsWith('http://')) {
    const parts = value.split('t.me/', 2);
    value = parts.length === 2 ? parts[1] : value.split('/').pop() || '';
  }

  value = value.replace(/^@+/, '').trim();
  return value.split('/', 1)[0].trim();
}

function getTelegramChatId(env) {
  const normalizedChannel = normalizeRequiredChannel(resolveRequiredChannel(env));
  return normalizedChannel ? `@${normalizedChannel}` : `@${resolveRequiredChannel(env)}`;
}

function buildTelegramApiUrl(env, methodName) {
  return `https://api.telegram.org/bot${String(env.TELEGRAM_BOT_TOKEN || '')}/${methodName}`;
}

function isTelegramStartCommand(text) {
  return /^\/start(?:@\S+)?(?:\s|$)/u.test(String(text || '').trim());
}

function extractTelegramMessageContext(updatePayload) {
  const message = updatePayload?.message;
  const userId = message?.from?.id;
  const chatId = message?.chat?.id ?? userId;
  const text = message?.text;

  if (!message || userId === undefined || userId === null || chatId === undefined || chatId === null) {
    return null;
  }

  return {
    userId: String(userId),
    chatId,
    text: String(text || ''),
  };
}

function buildStartReplyPayload(env, chatId, isMember) {
  if (!isMember) {
    return {
      chat_id: chatId,
      text: '⚠️ برای استفاده از ربات، ابتدا باید در کانال ما عضو شوید.\n\nپس از عضویت، دکمه «✅ عضو شدم» را بزنید.',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '📌 عضویت در کانال',
              url: `https://t.me/${normalizeRequiredChannel(resolveRequiredChannel(env))}`,
            },
          ],
          [
            {
              text: '✅ عضو شدم',
              callback_data: 'check_join',
            },
          ],
        ],
      },
      disable_web_page_preview: true,
    };
  }

  return {
    chat_id: chatId,
    text: '✅ خوش آمدید! دستیار هوشمند آماده خدمت‌رسانی است.',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🚀 باز کردن مینی‌اپ',
            web_app: {
              url: resolveWebAppUrl(env),
            },
          },
        ],
      ],
    },
  };
}

async function sendTelegramMessage(env, payload) {
  const response = await fetch(buildTelegramApiUrl(env, 'sendMessage'), {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
    },
    body: JSON.stringify(payload),
  });

  if (!response.ok) {
    const responseText = await response.text();
    throw new Error(`Telegram sendMessage failed: HTTP ${response.status} ${responseText}`);
  }

  return response;
}

async function answerTelegramCallbackQuery(env, callbackQueryId, text = '', showAlert = false) {
  try {
    await fetch(buildTelegramApiUrl(env, 'answerCallbackQuery'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        text,
        show_alert: showAlert,
      }),
    });
  } catch (error) {
    console.warn('answerTelegramCallbackQuery failed:', error);
  }
}

/**
 * Set the Telegram Menu Button (hamburger menu) to open the Mini App.
 * Called on /start so the Menu Button URL is always in sync with WEBAPP_URL.
 * No chat_id = sets the DEFAULT menu button for ALL users.
 * Fails silently — non-critical (inline keyboard works independently).
 */
async function syncMenuButton(env) {
  try {
    const webAppUrl = resolveWebAppUrl(env);
    if (!webAppUrl) return;
    await fetch(buildTelegramApiUrl(env, 'setChatMenuButton'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        // Intentionally NO chat_id — sets the DEFAULT menu button for ALL users.
        // See: https://core.telegram.org/bots/api#setchatmenubutton
        menu_button: {
          type: 'web_app',
          text: '🚀 باز کردن مینی‌اپ',
          web_app: { url: webAppUrl },
        },
      }),
    });
    console.log(JSON.stringify({ scope: 'sync-menu-button', url: webAppUrl }));
  } catch (error) {
    console.warn('syncMenuButton failed (non-critical):', error);
  }
}

async function editTelegramMessageReplyMarkup(env, chatId, messageId, replyMarkup) {
  try {
    await fetch(buildTelegramApiUrl(env, 'editMessageReplyMarkup'), {
      method: 'POST',
      headers: { 'Content-Type': 'application/json; charset=utf-8' },
      body: JSON.stringify({
        chat_id: chatId,
        message_id: messageId,
        reply_markup: replyMarkup,
      }),
    });
  } catch (error) {
    console.warn('editTelegramMessageReplyMarkup failed:', error);
  }
}

const CALLBACK_RATE_LIMIT_TTL = 10; // seconds
const CALLBACK_RATE_LIMIT_KEY_PREFIX = 'cbrl:';

async function isCallbackRateLimited(env, userId) {
  const key = `${CALLBACK_RATE_LIMIT_KEY_PREFIX}${String(userId)}`;
  const existing = await readRateLimitCache(env, key);
  if (existing) {
    return true;
  }
  await writeRateLimitCache(env, key, '1', CALLBACK_RATE_LIMIT_TTL);
  return false;
}

function parseBooleanQueryParam(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function getAdminIds(env) {
  const ids = new Set();
  // Include the primary admin ID only if explicitly configured (Task 4.9 — no hardcoded fallback)
  const primary = String(env.ADMIN_TELEGRAM_ID || '').trim();
  if (primary) ids.add(primary);
  // Add additional comma-separated IDs (Task 3.2 — mirror backend/config.py:admin_ids)
  const extra = String(env.ADMIN_TELEGRAM_IDS || '').trim();
  if (extra) {
    for (const id of extra.split(',')) {
      const trimmed = id.trim();
      if (trimmed) ids.add(trimmed);
    }
  }
  return ids;
}

function isAdminTelegramId(env, userId) {
  return getAdminIds(env).has(String(userId));
}

function getDbPool(env) {
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  if (!dbPools.has(databaseUrl)) {
    dbPools.set(
      databaseUrl,
      new Pool({
        connectionString: databaseUrl,
        max: 3,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      }),
    );
  }

  const pool = dbPools.get(databaseUrl);
  // @ts-expect-error — idleTimeoutMillis is valid for @neondatabase/serverless Pool
  if (pool && typeof pool.totalCount === 'function' && pool.totalCount() === 0 && pool.idleCount() === 0) {
    // Stale pool detected (no connections, likely after isolate eviction). Recreate.
    pool.end().catch(() => {});
    dbPools.set(
      databaseUrl,
      new Pool({
        connectionString: databaseUrl,
        max: 3,
        idleTimeoutMillis: 10000,
        connectionTimeoutMillis: 5000,
      }),
    );
  }

  return dbPools.get(databaseUrl);
}

async function getDbUserJoinState(env, userId) {
  const pool = getDbPool(env);
  if (!pool) {
    return null;
  }

  try {
    const result = await pool.query('SELECT telegram_id, channel_joined FROM users WHERE telegram_id = $1 LIMIT 1', [
      String(userId),
    ]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      telegram_id: String(row.telegram_id),
      channel_joined: Boolean(row.channel_joined),
    };
  } catch (error) {
    console.warn('JOIN DB read failed:', error);
    return null;
  }
}

async function persistDbUserJoinState(env, userId, joined) {
  const pool = getDbPool(env);
  if (!pool) {
    return;
  }

  try {
    await pool.query(
      `
        INSERT INTO users (
          telegram_id,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at
        )
        VALUES ($1, 'fa', $2, $3, NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE
        SET
          channel_joined = EXCLUDED.channel_joined,
          channel_verified_at = EXCLUDED.channel_verified_at,
          updated_at = NOW()
      `,
      [String(userId), Boolean(joined), joined ? new Date().toISOString() : null],
    );
  } catch (error) {
    console.warn('JOIN DB write failed:', error);
  }
}

function getReferralRewardPerInvite(env) {
  return Math.max(getNumericEnv(env, 'REFERRAL_TOKENS_PER_INVITE', 3), 0);
}

async function queryDb(env, sql, params = [], retries = 1) {
  const pool = getDbPool(env);
  if (!pool) {
    throw new Error('Database not configured');
  }
  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      return await pool.query(sql, params);
    } catch (error) {
      if (attempt === retries) throw error;
      const ms = Math.min(100 * 2 ** attempt, 1000);
      await new Promise((r) => setTimeout(r, ms));
    }
  }
}

async function ensureUserRow(env, userId) {
  await queryDb(
    env,
    `
      INSERT INTO users (telegram_id, lang, channel_joined, created_at, updated_at)
      VALUES ($1, 'fa', FALSE, NOW(), NOW())
      ON CONFLICT (telegram_id) DO NOTHING
    `,
    [String(userId)],
  );
}

async function processReferralOnBootstrap(env, inviteeId, referrerId, channelJoined) {
  const normalizedReferrerId = normalizeOptionalString(referrerId);
  if (!normalizedReferrerId || normalizedReferrerId === String(inviteeId)) {
    return null;
  }

  const inviterResult = await queryDb(
    env,
    'SELECT telegram_id FROM users WHERE telegram_id = $1 LIMIT 1',
    [normalizedReferrerId],
  );
  if (!inviterResult.rows[0]) {
    return null;
  }

  const existingResult = await queryDb(
    env,
    `
      SELECT id, inviter_id, channel_verified, rewarded
      FROM referrals
      WHERE invitee_id = $1
      LIMIT 1
    `,
    [String(inviteeId)],
  );
  const existing = existingResult.rows[0] || null;
  const rewardAmount = getReferralRewardPerInvite(env);

  if (existing) {
    if (channelJoined && !existing.channel_verified) {
      await queryDb(
        env,
        'UPDATE referrals SET channel_verified = TRUE WHERE id = $1',
        [existing.id],
      );
      if (!existing.rewarded && rewardAmount > 0) {
        await creditReferralTokens(env, String(existing.inviter_id), rewardAmount, String(existing.id), inviteeId);
        await queryDb(
          env,
          'UPDATE referrals SET rewarded = TRUE WHERE id = $1',
          [existing.id],
        );
      }
    }
    return { referral_id: existing.id, already_exists: true };
  }

  const insertResult = await queryDb(
    env,
    `
      INSERT INTO referrals (inviter_id, invitee_id, channel_verified, rewarded, created_at)
      VALUES ($1, $2, $3, FALSE, NOW())
      RETURNING id, rewarded
    `,
    [normalizedReferrerId, String(inviteeId), Boolean(channelJoined)],
  );
  const createdReferral = insertResult.rows[0] || null;
  if (!createdReferral) {
    return null;
  }

  if (channelJoined && rewardAmount > 0) {
    await creditReferralTokens(env, normalizedReferrerId, rewardAmount, String(createdReferral.id), inviteeId);
    await queryDb(env, 'UPDATE referrals SET rewarded = TRUE WHERE id = $1', [createdReferral.id]);
  }

  return { referral_id: createdReferral.id, rewarded: Boolean(channelJoined && rewardAmount > 0) };
}

async function creditReferralTokens(env, userId, amount, refId, inviteeId) {
  await queryDb(
    env,
    `
      INSERT INTO token_balances (user_id, balance, updated_at)
      VALUES ($1, $2, NOW())
      ON CONFLICT (user_id) DO UPDATE
      SET
        balance = token_balances.balance + EXCLUDED.balance,
        updated_at = NOW()
    `,
    [String(userId), Number(amount)],
  );
  await queryDb(
    env,
    `
      INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id, created_at)
      VALUES ($1, $2, 'referral_reward', $3, $4, NOW())
    `,
    [String(userId), Number(amount), `Invite reward for user ${String(inviteeId)}`, String(refId)],
  );
}

async function getChatMemberDebugPayload(userId, env) {
  const uid = String(userId);
  const requiredChannel = resolveRequiredChannel(env);
  const chatId = getTelegramChatId(env);
  const payload = {
    required_channel: requiredChannel,
    user_id: uid,
    telegram_response: null,
    joined: false,
  };

  if (uid.startsWith('guest_')) {
    payload.telegram_response = { reason: 'guest_user' };
    return payload;
  }

  if (isAdminTelegramId(env, uid)) {
    payload.telegram_response = { admin: true, reason: 'admin_bypass' };
    payload.joined = true;
    return payload;
  }

  if (!isBotConfigured(env)) {
    payload.telegram_response = { reason: 'bot_not_configured' };
    return payload;
  }

  if (!/^\d+$/.test(uid)) {
    payload.telegram_response = { reason: 'invalid_user_id', value: uid };
    return payload;
  }

  try {
    const telegramResponse = await fetch(
      `https://api.telegram.org/bot${String(env.TELEGRAM_BOT_TOKEN || '')}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(uid)}`,
    );
    const data = await telegramResponse.json();
    payload.telegram_response = data;
    const status = data?.result?.status || '';
    payload.joined = Boolean(data?.ok && JOINED_STATUSES.has(status));
    return payload;
  } catch (error) {
    payload.telegram_response = {
      exception: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
    return payload;
  }
}

async function checkChannelMembership(userId, env) {
  const debugPayload = await getChatMemberDebugPayload(userId, env);
  const telegramResponse = debugPayload.telegram_response;

  if (telegramResponse && typeof telegramResponse === 'object') {
    if (telegramResponse.reason === 'guest_user') {
      return { joined: false, reason: 'guest_user' };
    }
    if (telegramResponse.reason === 'admin_bypass') {
      return { joined: true, admin: true };
    }
    if (telegramResponse.reason === 'bot_not_configured') {
      return { joined: false, reason: 'bot_not_configured' };
    }
    if (telegramResponse.ok) {
      const status = telegramResponse?.result?.status || '';
      return { joined: JOINED_STATUSES.has(status) };
    }

    const description = String(telegramResponse.description || '');
    const lowerDescription = description.toLowerCase();
    if (lowerDescription.includes('user not found') || lowerDescription.includes('not a member')) {
      return { joined: false, reason: 'not_member', detail: description };
    }
    if (lowerDescription.includes('chat not found')) {
      return { joined: false, reason: 'channel_not_found', detail: description };
    }
    if (lowerDescription.includes('bot is not a member') || lowerDescription.includes('need administrator')) {
      return { joined: false, reason: 'bot_not_in_channel', detail: description };
    }
    if (telegramResponse.http_error || telegramResponse.exception) {
      return { joined: false, reason: 'api_error', detail: JSON.stringify(telegramResponse) };
    }
    return { joined: false, reason: 'api_error', detail: description };
  }

  return { joined: false, reason: 'api_error' };
}

async function resolveChannelMembership(env, userId, { forceRefresh = false } = {}) {
  const uid = String(userId);

  if (uid.startsWith('guest_')) {
    return { joined: false, reason: 'guest_user' };
  }

  if (isAdminTelegramId(env, uid)) {
    return { joined: true, admin: true };
  }

  try {
    if (!forceRefresh) {
      const cached = await getCachedJoinStatus(env, uid);
      if (cached === true) {
        return { joined: true, cached: true };
      }

      if (isDatabaseConfigured(env)) {
        const dbUser = await getDbUserJoinState(env, uid);
        if (dbUser?.channel_joined) {
          await setCachedJoinStatus(env, uid, true);
          return { joined: true, from_db: true };
        }
      }
    }

    const result = await checkChannelMembership(uid, env);
    if (result.joined) {
      await setCachedJoinStatus(env, uid, true);
      if (isDatabaseConfigured(env)) {
        await persistDbUserJoinState(env, uid, true);
      }
      return result;
    }

    if (result.reason === 'api_error') {
      if (isDatabaseConfigured(env)) {
        const dbUser = await getDbUserJoinState(env, uid);
        if (dbUser?.channel_joined) {
          return { joined: true, from_db_fallback: true, reason: result.reason };
        }
      }

      const cached = await getCachedJoinStatus(env, uid);
      if (cached === true) {
        return { joined: true, cached_fallback: true, reason: result.reason };
      }

      return { ...result, joined: false };
    }

    await setCachedJoinStatus(env, uid, false);
    if (isDatabaseConfigured(env)) {
      await persistDbUserJoinState(env, uid, false);
    }
    return result;
  } catch (error) {
    return {
      status: 'DB_ERROR',
      joined: false,
      reason: 'database_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

const EXCHANGE_ORDER = [
  ['BINANCE', 'binance'],
  ['BYBIT', 'bybit'],
  ['OKX', 'okx'],
  ['KUCOIN', 'kucoin'],
  ['GATEIO', 'gateio'],
  ['MEXC', 'mexc'],
];

const CHART_CHECKERS = {
  binance: {
    buildUrl(symbol) {
      return `https://api.binance.com/api/v3/ticker/price?symbol=${encodeURIComponent(`${symbol}USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body && typeof body === 'object' && 'price' in body);
    },
  },
  bybit: {
    buildUrl(symbol) {
      return `https://api.bybit.com/v5/market/tickers?category=spot&symbol=${encodeURIComponent(`${symbol}USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body?.retCode === 0 && Array.isArray(body?.result?.list) && body.result.list.length > 0);
    },
  },
  okx: {
    buildUrl(symbol) {
      return `https://www.okx.com/api/v5/market/ticker?instId=${encodeURIComponent(`${symbol}-USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body?.code === '0' && Array.isArray(body?.data) && body.data.length > 0);
    },
  },
  kucoin: {
    buildUrl(symbol) {
      return `https://api.kucoin.com/api/v1/market/orderbook/level1?symbol=${encodeURIComponent(`${symbol}-USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body?.code === '200000');
    },
  },
  gateio: {
    buildUrl(symbol) {
      return `https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${encodeURIComponent(`${symbol}_USDT`)}`;
    },
    isMatch(body) {
      return Array.isArray(body) && body.length > 0;
    },
  },
  mexc: {
    buildUrl(symbol) {
      return `https://api.mexc.com/api/v3/ticker/price?symbol=${encodeURIComponent(`${symbol}USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body && typeof body === 'object' && 'price' in body);
    },
  },
};

function parseSpotTickerPrice(exchangeKey, body) {
  if (exchangeKey === 'binance' || exchangeKey === 'mexc') {
    const price = Number(body?.price);
    return Number.isFinite(price) ? price : null;
  }
  if (exchangeKey === 'bybit') {
    const item = Array.isArray(body?.result?.list) ? body.result.list[0] : null;
    const price = Number(item?.lastPrice ?? item?.last_price);
    return Number.isFinite(price) ? price : null;
  }
  if (exchangeKey === 'okx') {
    const item = Array.isArray(body?.data) ? body.data[0] : null;
    const price = Number(item?.last);
    return Number.isFinite(price) ? price : null;
  }
  if (exchangeKey === 'kucoin') {
    const price = Number(body?.data?.price);
    return Number.isFinite(price) ? price : null;
  }
  if (exchangeKey === 'gateio') {
    const item = Array.isArray(body) ? body[0] : null;
    const price = Number(item?.last ?? item?.last_price);
    return Number.isFinite(price) ? price : null;
  }
  return null;
}

async function fetchSpotTickerPrice(exchangeKey, symbol) {
  const checker = CHART_CHECKERS[exchangeKey];
  if (!checker) {
    return null;
  }
  const { ok, body } = await fetchJson(checker.buildUrl(symbol));
  if (!ok || !checker.isMatch(body)) {
    return null;
  }
  return parseSpotTickerPrice(exchangeKey, body);
}

async function fetchSpotPriceUsd(env, symbol) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) {
    return null;
  }
  const cacheKey = `chart:exchange:${normalizedSymbol}`;
  const cachedExchange = await readAppCache(env, cacheKey);
  if (cachedExchange) {
    const cachedPrice = await fetchSpotTickerPrice(cachedExchange, normalizedSymbol);
    if (cachedPrice !== null) {
      return { price: cachedPrice, exchange: cachedExchange, cached: true };
    }
  }

  for (const [, exchangeKey] of EXCHANGE_ORDER) {
    const price = await fetchSpotTickerPrice(exchangeKey, normalizedSymbol);
    if (price !== null) {
      await writeAppCache(env, cacheKey, exchangeKey, getNumericEnv(env, 'CHART_EXCHANGE_CACHE_TTL', 86400));
      return { price, exchange: exchangeKey, cached: false };
    }
  }

  return null;
}

const CALENDAR_CACHE_KEY = 'calendar:events';
const FARSI_NEWS_CACHE_KEY = 'news:farsi';

const NEWS_RSS_SOURCES = [
  ['https://cointelegraph.com/rss', 'کوین‌تلگراف'],
  ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'کوین‌دسک'],
];

const COUNTRY_FLAGS = {
  USD: '🇺🇸',
  US: '🇺🇸',
  EUR: '🇪🇺',
  EU: '🇪🇺',
  GBP: '🇬🇧',
  GB: '🇬🇧',
  JPY: '🇯🇵',
  JP: '🇯🇵',
  AUD: '🇦🇺',
  AU: '🇦🇺',
  CAD: '🇨🇦',
  CA: '🇨🇦',
  CHF: '🇨🇭',
  CH: '🇨🇭',
  CNY: '🇨🇳',
  CN: '🇨🇳',
  NZD: '🇳🇿',
  NZ: '🇳🇿',
  All: '🌍',
};

const IMPACT_MAP = {
  High: 'high',
  Medium: 'medium',
  Low: 'low',
  Holiday: 'low',
};

const HTML_ENTITY_MAP = {
  '&amp;': '&',
  '&lt;': '<',
  '&gt;': '>',
  '&quot;': '"',
  '&#39;': "'",
  '&nbsp;': ' ',
};

const EXTERNAL_FETCH_TIMEOUT_MS = 8000;

async function fetchJson(url) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
      signal: controller.signal,
    });
    clearTimeout(timeoutId);

    if (!response.ok) {
      return { ok: false, body: null };
    }

    return {
      ok: true,
      body: await response.json(),
    };
  } catch {
    return { ok: false, body: null };
  }
}

function decodeHtmlEntities(text) {
  return String(text || '').replace(/&(amp|lt|gt|quot|#39|nbsp);/g, (entity) => HTML_ENTITY_MAP[entity] || entity);
}

function cleanHtml(rawHtml) {
  if (!rawHtml) {
    return '';
  }

  const cleanText = decodeHtmlEntities(String(rawHtml).replace(/<[^>]+>/g, ' ')).replace(/\s+/g, ' ').trim();
  return cleanText.length > 150 ? `${cleanText.slice(0, 150)}...` : cleanText;
}

function parseRelativeTime(dateString) {
  try {
    const cleanDate = String(dateString || '').split(' +')[0].split(' GMT')[0].trim();
    const parsedTime = new Date(`${cleanDate} UTC`);
    if (Number.isNaN(parsedTime.getTime())) {
      return 'اخیراً';
    }

    const diffMs = Date.now() - parsedTime.getTime();
    const minutes = Math.floor(diffMs / 60000);
    if (minutes < 1) {
      return 'همین الان';
    }

    if (minutes < 60) {
      return `${minutes} دقیقه پیش`;
    }

    const hours = Math.floor(minutes / 60);
    if (hours < 24) {
      return `${hours} ساعت پیش`;
    }

    return `${Math.floor(hours / 24)} روز پیش`;
  } catch {
    return 'اخیراً';
  }
}

function extractFirstMatch(text, pattern) {
  const match = String(text || '').match(pattern);
  if (!match) {
    return '';
  }

  const capturedValue = match.slice(1).find((value) => typeof value === 'string' && value.trim() !== '');
  return capturedValue ? decodeHtmlEntities(capturedValue.trim()) : '';
}

function extractImageUrl(descriptionHtml) {
  const match = String(descriptionHtml || '').match(/src="([^"]+)"/i);
  return match ? match[1] : 'https://images.cryptocompare.com/news/default/bitcoin.png';
}

function parseRssItems(rssText) {
  return [...String(rssText || '').matchAll(/<item\b[\s\S]*?<\/item>/gi)].slice(0, 6).map((match) => {
    const block = match[0];
    const title = extractFirstMatch(block, /<title><!\[CDATA\[([\s\S]*?)\]\]><\/title>|<title>([\s\S]*?)<\/title>/i);
    const link = extractFirstMatch(block, /<link>([\s\S]*?)<\/link>/i);
    const descriptionRaw = extractFirstMatch(
      block,
      /<description><!\[CDATA\[([\s\S]*?)\]\]><\/description>|<description>([\s\S]*?)<\/description>/i,
    );
    const pubDate = extractFirstMatch(block, /<pubDate>([\s\S]*?)<\/pubDate>/i);

    return {
      title,
      url: link,
      descriptionHtml: descriptionRaw,
      description: cleanHtml(descriptionRaw),
      pubDate,
      image: extractImageUrl(descriptionRaw),
    };
  }).map((item) => ({
    ...item,
    title: item.title || item.description,
  }));
}

async function translateToFarsi(text) {
  if (!text) {
    return '';
  }

  try {
    const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t&q=${encodeURIComponent(text)}`;
    const response = await fetch(url, {
      method: 'GET',
      headers: {
        Accept: 'application/json',
      },
    });

    if (!response.ok) {
      return text;
    }

    const body = await response.json();
    if (!Array.isArray(body?.[0])) {
      return text;
    }

    const translated = body[0].map((part) => part?.[0] || '').join('').trim();
    return translated || text;
  } catch {
    return text;
  }
}

async function fetchRawNewsRss() {
  for (const [url, sourceName] of NEWS_RSS_SOURCES) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      const rssText = await response.text();
      if (response.ok && rssText.includes('<item>')) {
        return { rssText, sourceName };
      }
    } catch {
      // به منبع بعدی RSS می‌رویم.
    }
  }

  return { rssText: null, sourceName: null };
}

async function buildFarsiNewsArticles(rssText, sourceName) {
  const items = parseRssItems(rssText);
  const articles = [];

  for (const item of items) {
    const translatedTitle = await translateToFarsi(item.title || 'بدون عنوان');
    const translatedDescription = await translateToFarsi(item.description || '');

    articles.push({
      title: String(translatedTitle || item.title || 'بدون عنوان').replace(/\n/g, ' ').trim(),
      description: String(translatedDescription || item.description || '').replace(/\n/g, ' ').trim(),
      time_ago: parseRelativeTime(item.pubDate),
      source: sourceName,
      image: item.image,
      url: item.url,
    });
  }

  return articles.filter((item) => item.title || item.description);
}

async function fetchFarsiNews(env) {
  const cachedNews = await readAppCache(env, FARSI_NEWS_CACHE_KEY);
  if (cachedNews) {
    try {
      return {
        status: 'success',
        source: 'redis_cache',
        data: JSON.parse(cachedNews),
      };
    } catch {
      // cache خراب نادیده گرفته می‌شود تا داده تازه جایگزین شود.
    }
  }

  const { rssText, sourceName } = await fetchRawNewsRss();
  if (!rssText || !sourceName) {
    return {
      status: 'success',
      source: 'rss_unavailable',
      data: [],
    };
  }

  try {
    const articles = await buildFarsiNewsArticles(rssText, sourceName);
    if (articles.length > 0) {
      await writeAppCache(
        env,
        FARSI_NEWS_CACHE_KEY,
        JSON.stringify(articles),
        getNumericEnv(env, 'NEWS_CACHE_TTL', 300),
      );

      return {
        status: 'success',
        source: `${sourceName}_live`,
        data: articles,
      };
    }
  } catch {
    // در شکست parse/translate، fallback قراردادی برگردانده می‌شود.
  }

  return {
    status: 'success',
    source: 'rss_unavailable',
    data: [],
  };
}

function parseCalendarDate(dateString) {
  const parts = String(dateString || '').split('-');
  if (parts.length !== 3) {
    return null;
  }

  const [month, day, year] = parts.map((value) => Number(value));
  if (!Number.isInteger(month) || !Number.isInteger(day) || !Number.isInteger(year)) {
    return null;
  }

  return { year, month, day };
}

function parseCalendarTimeParts(timeString) {
  const normalized = String(timeString || '').trim().toLowerCase();
  const match = normalized.match(/^(\d{1,2}):(\d{2})\s*([ap]m)$/);
  if (!match) {
    return null;
  }

  let hour = Number(match[1]);
  const minute = Number(match[2]);
  const meridiem = match[3];

  if (!Number.isInteger(hour) || !Number.isInteger(minute)) {
    return null;
  }

  if (hour === 12) {
    hour = 0;
  }

  if (meridiem === 'pm') {
    hour += 12;
  }

  return { hour, minute };
}

function parseEventTime(dateString, timeString) {
  const parsedDate = parseCalendarDate(dateString);
  if (!parsedDate) {
    return null;
  }

  if (!timeString || ['All Day', 'Tentative'].includes(timeString)) {
    return new Date(Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day, 12, 0, 0));
  }

  const parsedTime = parseCalendarTimeParts(timeString);
  if (parsedTime) {
    return new Date(
      Date.UTC(
        parsedDate.year,
        parsedDate.month - 1,
        parsedDate.day,
        parsedTime.hour,
        parsedTime.minute,
        0,
      ),
    );
  }

  return new Date(Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day, 12, 0, 0));
}

function getEventStatus(eventDate, now) {
  if (!eventDate) {
    return 'upcoming';
  }

  const windowMs = 30 * 60 * 1000;
  if (eventDate.getTime() - windowMs <= now.getTime() && now.getTime() <= eventDate.getTime() + windowMs) {
    return 'live';
  }

  if (eventDate.getTime() < now.getTime()) {
    return 'past';
  }

  return 'upcoming';
}

function resolveCountryFlag(country) {
  const normalizedCountry = String(country || 'US');
  return COUNTRY_FLAGS[normalizedCountry] || COUNTRY_FLAGS[normalizedCountry.slice(0, 2)] || '🏳️';
}

function mapCalendarEvent(item, now, cutoffPast, cutoffFuture) {
  const country = item?.country || 'US';
  const eventDate = parseEventTime(item?.date || '', item?.time || '');

  if (eventDate && eventDate < cutoffPast) {
    return null;
  }

  if (eventDate && eventDate > cutoffFuture) {
    return null;
  }

  const impactLabel = item?.impact || 'Medium';
  return {
    title: item?.title || '',
    country,
    flag: resolveCountryFlag(country),
    time: item?.time || '',
    date: item?.date || '',
    impact: IMPACT_MAP[impactLabel] || 'medium',
    impact_label: impactLabel,
    forecast: item?.forecast || '',
    previous: item?.previous || '',
    actual: item?.actual || '',
    status: getEventStatus(eventDate, now),
    timestamp: eventDate ? eventDate.toISOString() : null,
  };
}

async function fetchCalendarFeed() {
  const urls = [
    'https://nfs.faireconomy.media/ff_calendar_thisweek.json',
    'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json',
  ];

  for (const url of urls) {
    try {
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
      });

      if (!response.ok) {
        continue;
      }

      const body = await response.json();
      if (Array.isArray(body)) {
        return body;
      }
    } catch {
      // به fallback بعدی feed می‌رویم تا رفتار نسخه پایتونی حفظ شود.
    }
  }

  return [];
}

async function fetchCalendarEvents(env) {
  const cachedEvents = await readAppCache(env, CALENDAR_CACHE_KEY);
  if (cachedEvents) {
    try {
      return JSON.parse(cachedEvents);
    } catch {
      // cache خراب نادیده گرفته می‌شود تا داده تازه جایگزین شود.
    }
  }

  const now = new Date();
  const cutoffPast = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
  const cutoffFuture = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
  const rawEvents = await fetchCalendarFeed();

  const events = rawEvents
    .map((item) => mapCalendarEvent(item, now, cutoffPast, cutoffFuture))
    .filter((item) => item !== null)
    .sort((left, right) => String(left.timestamp || '').localeCompare(String(right.timestamp || '')));

  await writeAppCache(
    env,
    CALENDAR_CACHE_KEY,
    JSON.stringify(events),
    getNumericEnv(env, 'CALENDAR_CACHE_TTL', 600),
  );

  return events;
}

async function exchangeHasSymbol(key, symbol) {
  const checker = CHART_CHECKERS[key];
  if (!checker) {
    return false;
  }

  try {
    const { ok, body } = await fetchJson(checker.buildUrl(symbol));
    return ok && checker.isMatch(body);
  } catch {
    return false;
  }
}

async function resolveChartExchange(env, rawSymbol) {
  const normalizedSymbol = rawSymbol.toUpperCase().trim();
  if (!normalizedSymbol) {
    return {
      found: false,
      symbol: null,
      exchange: null,
      tv_symbol: null,
      cached: false,
    };
  }

  const cacheKey = `chart:exchange:${normalizedSymbol}`;
  const cachedExchange = await readAppCache(env, cacheKey);

  if (cachedExchange) {
    const cachedMatch = EXCHANGE_ORDER.find(([, key]) => key === cachedExchange);
    if (cachedMatch) {
      const [tvName, key] = cachedMatch;
      return {
        found: true,
        symbol: normalizedSymbol,
        exchange: key,
        tv_symbol: `${tvName}:${normalizedSymbol}USDT`,
        cached: true,
      };
    }
  }

  for (const [tvName, key] of EXCHANGE_ORDER) {
    if (await exchangeHasSymbol(key, normalizedSymbol)) {
      await writeAppCache(env, cacheKey, key, getNumericEnv(env, 'CHART_EXCHANGE_CACHE_TTL', 86400));
      return {
        found: true,
        symbol: normalizedSymbol,
        exchange: key,
        tv_symbol: `${tvName}:${normalizedSymbol}USDT`,
        cached: false,
      };
    }
  }

  return {
    found: false,
    symbol: normalizedSymbol,
    exchange: null,
    tv_symbol: null,
    cached: false,
  };
}
//#endregion

// ============================================================================
//#region پاسخ‌های مستقیم Worker
// ============================================================================
function handleRoot(env) {
  return jsonResponse({
    status: 'ok',
    message: 'Amir BTC Assistant Backend is running!',
  }, {}, env);
}

function handleHealth(env) {
  return jsonResponse({
    status: 'ok',
    bot_configured: isBotConfigured(env),
    database_ready: isDatabaseConfigured(env),
    redis_ready: isCacheLayerConfigured(env),
  }, {}, env);
}

// ============================================================================
//#region Composition Root — Wired dependencies for layered modules
// ============================================================================
const alertRepo = createAlertRepository({ queryDb, ensureUserRow, normalizeOptionalString });
const alertHandlers = createAlertHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  readJsonBody,
  safeDbErrorResponse,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  alertRepo,
});
const watchlistRepo = createWatchlistRepository({ queryDb, ensureUserRow });
const watchlistHandlers = createWatchlistHandlers({
  jsonResponse,
  optionalTelegramAuth,
  readJsonBody,
  safeDbErrorResponse,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  watchlistRepo,
});
const referralRepo = createReferralRepository({ queryDb, getReferralRewardPerInvite });
const referralHandlers = createReferralHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  isDatabaseConfigured,
  referralRepo,
});
const sessionRepo = createSessionRepository({ readSessionCache, writeSessionCache, deleteSessionCache });
const sessionHandlers = createSessionHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  getNumericEnv,
  normalizeOptionalString,
  sessionRepo,
});
const ticketRepo = createTicketRepository({ queryDb, ensureUserRow, normalizeOptionalString });
const ticketHandlers = createTicketHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  readJsonBody,
  safeDbErrorResponse,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  isAdminTelegramId,
  getAdminIds,
  sendTelegramMessage,
  normalizeOptionalString,
  ticketRepo,
});
const userRepo = createUserRepository({ queryDb, normalizeOptionalString });
const userHandlers = createUserHandlers({
  jsonResponse,
  optionalTelegramAuth,
  readJsonBody,
  safeDbErrorResponse,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  normalizeOptionalString,
  processReferralOnBootstrap,
  userRepo,
  watchlistRepo,
});
const notifyHandlers = createNotifyHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  readJsonBody,
  normalizeOptionalString,
  buildBodyFieldValidationError,
  getTodayIsoDate,
  readRateLimitCache,
  writeRateLimitCache,
  isBotConfigured,
  sendTelegramMessage,
});
const assistantHandlers = createAssistantHandlers({
  jsonResponse,
  optionalTelegramAuth,
  readJsonBody,
  MAX_BODY_BYTES,
  buildBodyFieldValidationError,
  normalizeOptionalString,
  readRateLimitCache,
  writeRateLimitCache,
  getTodayIsoDate,
  getNumericEnv,
});
const analysisRepo = createAnalysisRepository({ queryDb, normalizeOptionalString });
const analysisHandlers = createAnalysisHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  buildBodyFieldValidationError,
  buildQueryFieldValidationError,
  isDatabaseConfigured,
  isAdminTelegramId,
  readAppCache,
  writeAppCache,
  analysisRepo,
});
//#endregion

async function handleChartResolve(request, env) {
  const url = new URL(request.url);
  const rawSymbol = url.searchParams.get('symbol');

  if (rawSymbol === null) {
    return jsonResponse(buildFastApiValidationError('missing', 'Field required', null), { status: 422 }, env);
  }

  if (rawSymbol.length < 1) {
    return jsonResponse(
      buildFastApiValidationError(
        'string_too_short',
        'String should have at least 1 character',
        rawSymbol,
        { min_length: 1 },
      ),
      { status: 422 }, env);
  }

  if (rawSymbol.length > 16) {
    return jsonResponse(
      buildFastApiValidationError(
        'string_too_long',
        'String should have at most 16 characters',
        rawSymbol,
        { max_length: 16 },
      ),
      { status: 422 }, env);
  }

  const result = await resolveChartExchange(env, rawSymbol);
  return jsonResponse({
    status: 'success',
    ...result,
  }, {}, env);
}

async function handleCalendarEvents(env) {
  const events = await fetchCalendarEvents(env);
  return jsonResponse({
    status: 'success',
    events,
  }, {}, env);
}

async function handleFarsiNews(env) {
  return jsonResponse(await fetchFarsiNews(env), {}, env);
}

async function handleTelegramWebhook(request, env) {
  const requestPath = new URL(request.url).pathname || '/';

  // ── Webhook secret validation (Task 2.11) ──────────────────────────────────
  // C1 FIX: timing-safe comparison to prevent side-channel secret extraction
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const headerToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!headerToken || !timingSafeEqualSecret(headerToken, webhookSecret)) {
      return jsonResponse(
        { status: 'error', detail: 'Invalid or missing webhook secret token' },
        { status: 403 }, env);
    }
  } else {
    console.warn('TELEGRAM_WEBHOOK_SECRET is not configured — webhook endpoint is unprotected');
  }
  // ── End webhook secret validation ─────────────────────────────────────────

  try {
    const updatePayload = await request.json();
    const callbackQuery = updatePayload?.callback_query;

    // ── Handle callback_query: "check_join" ────────────────────────────────
    if (callbackQuery) {
      const callbackData = callbackQuery?.data;
      const userId = String(callbackQuery?.from?.id || '');
      const chatId = callbackQuery?.message?.chat?.id;
      const messageId = callbackQuery?.message?.message_id;

      console.log(JSON.stringify({
        scope: 'telegram-callback',
        callback_data: callbackData,
        user_id: userId,
      }));

      if (callbackData !== 'check_join' || !userId || !chatId || !messageId) {
        await answerTelegramCallbackQuery(env, callbackQuery.id);
        return new Response(null, { status: 200, headers: withCors({}, env) });
      }

      // Rate limit: max 1 callback per 10 seconds per user
      const rateLimited = await isCallbackRateLimited(env, userId);
      if (rateLimited) {
        await answerTelegramCallbackQuery(env, callbackQuery.id, '⏳ لطفاً ۱۰ ثانیه صبر کنید و دوباره تلاش کنید.', false);
        return new Response(null, { status: 200, headers: withCors({}, env) });
      }

      // Check channel membership
      const membership = await resolveChannelMembership(env, userId, { forceRefresh: true });
      console.log(JSON.stringify({
        scope: 'callback-join-verify',
        user_id: userId,
        result: membership,
      }));

      if (membership?.joined) {
        // User is a member → show WebApp button, answer callback with success
        await answerTelegramCallbackQuery(env, callbackQuery.id, '✅ عضویت شما تأیید شد!', false);
        await editTelegramMessageReplyMarkup(env, chatId, messageId, {
          inline_keyboard: [
            [
              {
                text: '🚀 باز کردن مینی‌اپ',
                web_app: {
                  url: resolveWebAppUrl(env),
                },
              },
            ],
          ],
        });
      } else {
        // User is NOT a member
        const reason = membership?.reason || 'not_member';
        let errorMsg = '❌ هنوز عضو کانال نشده‌اید. لطفاً ابتدا عضو شوید و دوباره تلاش کنید.';
        if (reason === 'bot_not_in_channel') {
          errorMsg = '⚠️ خطای سیستمی: ربات عضو کانال نیست. لطفاً به مدیر اطلاع دهید.';
        } else if (reason === 'channel_not_found') {
          errorMsg = '⚠️ خطای سیستمی: کانال یافت نشد. لطفاً به مدیر اطلاع دهید.';
        } else if (reason === 'api_error') {
          errorMsg = '⚠️ خطای موقت در بررسی عضویت. لطفاً چند ثانیه دیگر دوباره تلاش کنید.';
        }
        await answerTelegramCallbackQuery(env, callbackQuery.id, errorMsg, true);
      }

      return new Response(null, { status: 200, headers: withCors({}, env) });
    }

    // ── Handle /start command ───────────────────────────────────────────────
    const messageContext = extractTelegramMessageContext(updatePayload);
    console.log(
      JSON.stringify({
        scope: 'telegram-webhook',
        path: requestPath,
        update_id: updatePayload?.update_id ?? null,
        has_message: Boolean(updatePayload?.message),
        is_start: Boolean(messageContext && isTelegramStartCommand(messageContext.text)),
      }),
    );
    if (!messageContext || !isTelegramStartCommand(messageContext.text)) {
      return new Response(null, {
        status: 200,
        headers: withCors({}, env),
      });
    }

    if (!isBotConfigured(env)) {
      return new Response(null, {
        status: 200,
        headers: withCors({}, env),
      });
    }

    const membership = await resolveChannelMembership(env, messageContext.userId);
    console.log(
      JSON.stringify({
        scope: 'telegram-start',
        user_id: messageContext.userId,
        result: membership,
      }),
    );
    const replyPayload = buildStartReplyPayload(env, messageContext.chatId, Boolean(membership?.joined));

    await sendTelegramMessage(env, replyPayload);

    // Sync the hamburger Menu Button URL with WEBAPP_URL (non-critical, fire-and-forget)
    syncMenuButton(env);
  } catch (error) {
    console.warn('Telegram webhook processing error:', error);
  }

  return new Response(null, {
    status: 200,
    headers: withCors({}, env),
  });
}
//#endregion

// ============================================================================
//#region زمان‌بندی پایه Worker
// ============================================================================
async function runScheduledAlertsBaseline(controller, env) {
  const payload = {
    status: 'ok',
    task: 'scheduled-alerts-execution',
    cron: controller.cron || 'manual',
    alerts_cron_enabled: isAlertsCronEnabled(env),
    secret_configured: Boolean(env.ALERTS_CRON_SHARED_SECRET),
  };

  if (!payload.alerts_cron_enabled) {
    console.log(
      JSON.stringify({
        ...payload,
        skipped: true,
        reason: 'ALERTS_CRON_ENABLED is false',
      }),
    );
    return;
  }

  if (!isDatabaseConfigured(env)) {
    console.log(
      JSON.stringify({
        ...payload,
        skipped: true,
        reason: 'Database not configured',
      }),
    );
    return;
  }

  if (!isBotConfigured(env)) {
    console.log(
      JSON.stringify({
        ...payload,
        skipped: true,
        reason: 'Telegram bot token is not configured',
      }),
    );
    return;
  }

  const maxAlerts = Math.max(getNumericEnv(env, 'ALERTS_CRON_MAX_ALERTS', 200), 0);
  const resultPayload = {
    ...payload,
    checked_count: 0,
    triggered_count: 0,
    price_fetch_failures: 0,
    delivery_failures: 0,
    skipped_price_missing: 0,
    skipped_guest_users: 0,
  };

  try {
    const alertsResult = await queryDb(
      env,
      `
        SELECT id, user_id, symbol, price, direction
        FROM price_alerts
        WHERE status = 'active'
        ORDER BY created_at DESC
      `,
    );
    const alerts = Array.isArray(alertsResult.rows) ? alertsResult.rows.slice(0, maxAlerts) : [];
    resultPayload.checked_count = alerts.length;

    if (!alerts.length) {
      console.log(JSON.stringify({ ...resultPayload, finished: true }));
      return;
    }

    const symbolPriceMap = new Map();
    for (const alert of alerts) {
      const symbol = String(alert?.symbol || '').trim().toUpperCase();
      if (!symbol) {
        resultPayload.skipped_price_missing += 1;
        continue;
      }
      if (!symbolPriceMap.has(symbol)) {
        const priceInfo = await fetchSpotPriceUsd(env, symbol);
        if (!priceInfo) {
          resultPayload.price_fetch_failures += 1;
          symbolPriceMap.set(symbol, null);
        } else {
          symbolPriceMap.set(symbol, priceInfo.price);
        }
      }
    }

    for (const alert of alerts) {
      const alertId = String(alert?.id || '');
      const userId = String(alert?.user_id || '');
      const symbol = String(alert?.symbol || '').trim().toUpperCase();
      const targetPrice = Number(alert?.price);
      const direction = String(alert?.direction || 'above').trim().toLowerCase();

      if (!alertId || !userId || userId.startsWith('guest_')) {
        resultPayload.skipped_guest_users += 1;
        continue;
      }
      if (!symbol || !Number.isFinite(targetPrice)) {
        resultPayload.skipped_price_missing += 1;
        continue;
      }

      const currentPrice = symbolPriceMap.get(symbol);
      if (!Number.isFinite(currentPrice)) {
        continue;
      }

      const shouldTrigger = (direction === 'below' && currentPrice <= targetPrice) || (direction !== 'below' && currentPrice >= targetPrice);
      if (!shouldTrigger) {
        continue;
      }

      try {
        const chatIdValue = Number(userId);
        const chatId = Number.isFinite(chatIdValue) ? chatIdValue : userId;
        const text = `🔔 هشدار قیمت فعال شد\n${symbol} — قیمت فعلی: ${Number(currentPrice).toFixed(6)}\nهدف: ${Number(targetPrice).toFixed(6)}`;
        await sendTelegramMessage(env, {
          chat_id: chatId,
          text,
          disable_web_page_preview: true,
        });

        await queryDb(
          env,
          `
            UPDATE price_alerts
            SET status = 'triggered', triggered_at = NOW()
            WHERE id = $1
          `,
          [alertId],
        );

        resultPayload.triggered_count += 1;
      } catch (error) {
        resultPayload.delivery_failures += 1;
        console.warn('scheduled alert delivery failed:', {
          alert_id: alertId,
          user_id: userId,
          symbol,
          error: error instanceof Error ? error.message : String(error),
        });
      }
    }

    console.log(JSON.stringify({ ...resultPayload, finished: true }));
  } catch (error) {
    console.warn('scheduled alerts runner failed:', error);
    console.log(
      JSON.stringify({
        ...payload,
        status: 'error',
        message: 'scheduled alerts runner failed',
        detail: error instanceof Error ? error.message : String(error),
      }),
    );
  }
}
//#endregion

// ============================================================================
//#region ورودی اصلی Worker
// ============================================================================
export default {
  async fetch(request, env) {
    if (request.method === 'OPTIONS') {
      return new Response(null, {
        status: 204,
        headers: withCors({}, env),
      });
    }

    try {
      const url = new URL(request.url);

      // Referrer/Origin validation for browser-sourced requests (Task 4.10)
      const referrerCheck = validateReferrer(request, env);
      if (referrerCheck) return referrerCheck;

      if (request.method === 'GET' && url.pathname === '/') {
        return handleRoot(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/health') {
        return handleHealth(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/charts/resolve') {
        return await handleChartResolve(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/calendar/events') {
        return await handleCalendarEvents(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/farsi-news') {
        return await handleFarsiNews(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/analyses') {
        return await analysisHandlers.handleList(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/analyses') {
        return await analysisHandlers.handleCreate(request, env);
      }

      if (request.method === 'PUT' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return await analysisHandlers.handleUpdate(request, env, analysisId);
      }

      if (request.method === 'DELETE' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return await analysisHandlers.handleDelete(request, env, analysisId);
      }

      if (request.method === 'POST' && url.pathname === '/api/tickets') {
        return await ticketHandlers.handleCreate(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/tickets') {
        return await ticketHandlers.handleList(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/tickets/all') {
        return await ticketHandlers.handleListAll(request, env);
      }

      if (request.method === 'POST' && /^\/api\/tickets\/[^/]+\/reply$/u.test(url.pathname)) {
        const ticketId = url.pathname.split('/')[3] || '';
        return await ticketHandlers.handleReply(request, env, ticketId);
      }

      if (request.method === 'DELETE' && /^\/api\/tickets\/[^/]+$/u.test(url.pathname) && url.pathname !== '/api/tickets/all') {
        const ticketId = url.pathname.split('/')[3] || '';
        return await ticketHandlers.handleDelete(request, env, ticketId);
      }

      if (request.method === 'POST' && url.pathname === '/api/alerts') {
        return await alertHandlers.handleCreate(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/alerts') {
        return await alertHandlers.handleList(request, env);
      }

      if (request.method === 'DELETE' && /^\/api\/alerts\/[^/]+$/u.test(url.pathname)) {
        const alertId = url.pathname.split('/')[3] || '';
        return await alertHandlers.handleDelete(request, env, alertId);
      }

      if (request.method === 'POST' && url.pathname === '/api/sessions/heartbeat') {
        return await sessionHandlers.handleHeartbeat(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/sessions/online') {
        return await sessionHandlers.handleOnline(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/sessions/end') {
        return await sessionHandlers.handleEnd(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/assistant/limits') {
        return await assistantHandlers.handleGetLimits(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/assistant/chat') {
        return await assistantHandlers.handlePostChat(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/users/me') {
        return await userHandlers.handleMe(request, env);
      }

      if (request.method === 'PUT' && url.pathname === '/api/users/me/settings') {
        return await userHandlers.handleMeSettings(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/users/bootstrap') {
        return await userHandlers.handleBootstrap(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/watchlist') {
        return await watchlistHandlers.handleGet(request, env);
      }

      if (request.method === 'PUT' && url.pathname === '/api/watchlist') {
        return await watchlistHandlers.handlePut(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/notify') {
        return await notifyHandlers.handlePost(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/referrals/stats') {
        return referralHandlers.handleStats(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/referrals/tokens') {
        return referralHandlers.handleTokens(request, env);
      }

      if (request.method === 'POST' && (url.pathname === '/telegram' || url.pathname === '/')) {
        return await handleTelegramWebhook(request, env);
      }

      return jsonResponse(
        {
          status: 'error',
          message: 'Route not found in Cloudflare shell',
        },
        { status: 404 }, env);
    } catch (error) {
      console.error('Unhandled worker request error:', error);
      return jsonResponse(
        {
          status: 'error',
          message: 'Internal server error',
        },
        { status: 500 }, env);
    }
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledAlertsBaseline(controller, env));
  },
};
//#endregion

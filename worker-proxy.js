import { Buffer } from 'node:buffer';
import { createHmac, timingSafeEqual } from 'node:crypto';
import pg from 'pg';

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
const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, X-Telegram-Init-Data',
};

function withCors(headers = {}) {
  const merged = new Headers(headers);
  Object.entries(CORS_HEADERS).forEach(([key, value]) => merged.set(key, value));
  return merged;
}

function jsonResponse(payload, init = {}) {
  const headers = withCors(init.headers);
  if (!headers.has('Content-Type')) {
    headers.set('Content-Type', 'application/json; charset=utf-8');
  }

  return new Response(JSON.stringify(payload), {
    ...init,
    headers,
  });
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
  return request.headers.get('X-Telegram-Init-Data') || new URL(request.url).searchParams.get('init_data') || '';
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
  const leftBuffer = Buffer.from(String(left || ''), 'utf8');
  const rightBuffer = Buffer.from(String(right || ''), 'utf8');
  if (leftBuffer.length !== rightBuffer.length) {
    return false;
  }
  return timingSafeEqual(leftBuffer, rightBuffer);
}

function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
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
        receivedHash = decodedValue;
      } else {
        checkPairs.push([key, decodedValue]);
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
      error: jsonResponse({ detail: 'Missing Telegram init data' }, { status: 401 }),
      user: null,
    };
  }

  if (!isBotConfigured(env)) {
    return {
      error: jsonResponse({ detail: 'Telegram bot token is not configured' }, { status: 401 }),
      user: null,
    };
  }

  const user = validateTelegramInitData(initData, String(env.TELEGRAM_BOT_TOKEN || ''));
  if (!user || !user.id) {
    return {
      error: jsonResponse({ detail: 'Invalid Telegram init data' }, { status: 401 }),
      user: null,
    };
  }

  return { error: null, user };
}

function normalizeOptionalString(value) {
  if (value === null || value === undefined) {
    return null;
  }
  const normalized = String(value).trim();
  return normalized ? normalized : null;
}

const { Pool } = pg;
const JOIN_CACHE_PREFIX = 'join:';
const JOINED_STATUSES = new Set(['creator', 'administrator', 'member', 'restricted']);
const SESSION_PREFIX = 'session:';
const SESSION_PRESENCE_STATE_KEY = 'session:presence_state';
const RATE_LIMIT_COOLDOWN_PREFIX = 'ai:cooldown:';
const RATE_LIMIT_MSG_PREFIX = 'ai:msgs:';
const RATE_LIMIT_IMG_PREFIX = 'ai:imgs:';
const joinDbPools = new Map();

function resolveDatabaseUrl(env) {
  return String(env.DATABASE_URL || env.DIRECT_URL || '').trim();
}

function resolveRequiredChannel(env) {
  return String(env.REQUIRED_CHANNEL || 'amir_btc_2024').trim();
}

function resolveWebAppUrl(env) {
  return String(env.WEBAPP_URL || 'https://amir-btc-assistant.vercel.app').trim();
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

function buildRateLimitKey(prefix, userId, isoDate = null) {
  const uid = String(userId);
  if (isoDate) {
    return `${prefix}${uid}:${isoDate}`;
  }
  return `${prefix}${uid}`;
}

async function checkRateLimits(env, userId) {
  const cooldownKey = buildRateLimitKey(RATE_LIMIT_COOLDOWN_PREFIX, userId);
  const cooldown = await readRateLimitCache(env, cooldownKey);
  const cooldownSeconds = getNumericEnv(env, 'AI_COOLDOWN_SECONDS', 4);
  if (cooldown) {
    return { allowed: false, reason: 'cooldown', retry_after: cooldownSeconds };
  }

  const isoDate = getTodayIsoDate();
  const msgKey = buildRateLimitKey(RATE_LIMIT_MSG_PREFIX, userId, isoDate);
  const imgKey = buildRateLimitKey(RATE_LIMIT_IMG_PREFIX, userId, isoDate);
  const msgLimit = getNumericEnv(env, 'AI_DAILY_MESSAGE_LIMIT', 50);
  const imgLimit = getNumericEnv(env, 'AI_DAILY_IMAGE_LIMIT', 3);

  const rawMsg = await readRateLimitCache(env, msgKey);
  const msgCount = rawMsg && /^\d+$/.test(String(rawMsg)) ? Number(rawMsg) : 0;
  if (msgCount >= msgLimit) {
    return { allowed: false, reason: 'daily_message_limit', used: msgCount };
  }

  const rawImg = await readRateLimitCache(env, imgKey);
  const imgCount = rawImg && /^\d+$/.test(String(rawImg)) ? Number(rawImg) : 0;

  return {
    allowed: true,
    messages_used: msgCount,
    messages_limit: msgLimit,
    images_used: imgCount,
    images_limit: imgLimit,
  };
}

async function recordRateLimitUsage(env, userId, hasImage) {
  const uid = String(userId);
  const cooldownSeconds = getNumericEnv(env, 'AI_COOLDOWN_SECONDS', 4);
  const isoDate = getTodayIsoDate();
  const msgKey = buildRateLimitKey(RATE_LIMIT_MSG_PREFIX, uid, isoDate);
  const imgKey = buildRateLimitKey(RATE_LIMIT_IMG_PREFIX, uid, isoDate);

  await writeRateLimitCache(env, buildRateLimitKey(RATE_LIMIT_COOLDOWN_PREFIX, uid), '1', cooldownSeconds);

  const rawMsg = await readRateLimitCache(env, msgKey);
  const msgCount = rawMsg && /^\d+$/.test(String(rawMsg)) ? Number(rawMsg) : 0;
  await writeRateLimitCache(env, msgKey, String(msgCount + 1), 86400);

  if (hasImage) {
    const rawImg = await readRateLimitCache(env, imgKey);
    const imgCount = rawImg && /^\d+$/.test(String(rawImg)) ? Number(rawImg) : 0;
    await writeRateLimitCache(env, imgKey, String(imgCount + 1), 86400);
  }
}

async function readPresenceState(env) {
  const raw = await readSessionCache(env, SESSION_PRESENCE_STATE_KEY);
  if (!raw) {
    return {};
  }

  try {
    const parsed = JSON.parse(raw);
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
      return {};
    }
    return parsed;
  } catch {
    return {};
  }
}

function prunePresenceState(state, nowMs) {
  for (const [userId, expiresAt] of Object.entries(state)) {
    if (!Number.isFinite(expiresAt) || expiresAt <= nowMs) {
      delete state[userId];
    }
  }
}

async function persistPresenceState(env, state, ttlSeconds) {
  await writeSessionCache(env, SESSION_PRESENCE_STATE_KEY, JSON.stringify(state), ttlSeconds * 2);
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
      text: '⚠️ برای استفاده از ربات، ابتدا باید در کانال ما عضو شوید.',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: 'عضویت در کانال',
              url: `https://t.me/${normalizeRequiredChannel(resolveRequiredChannel(env))}`,
            },
          ],
        ],
      },
      disable_web_page_preview: true,
    };
  }

  return {
    chat_id: chatId,
    text: 'خوش آمدید! دستیار هوشمند آماده خدمت‌رسانی است.',
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

function parseBooleanQueryParam(value) {
  return ['1', 'true', 'yes', 'on'].includes(String(value || '').trim().toLowerCase());
}

function isAdminTelegramId(env, userId) {
  return String(userId) === String(env.ADMIN_TELEGRAM_ID || '831704732');
}

function getJoinDbPool(env) {
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) {
    return null;
  }

  if (!joinDbPools.has(databaseUrl)) {
    joinDbPools.set(
      databaseUrl,
      new Pool({
        connectionString: databaseUrl,
        max: 3,
      }),
    );
  }

  return joinDbPools.get(databaseUrl);
}

async function getDbUserJoinState(env, userId) {
  const pool = getJoinDbPool(env);
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
  const pool = getJoinDbPool(env);
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

const CALENDAR_CACHE_KEY = 'calendar:events';
const FARSI_NEWS_CACHE_KEY = 'news:farsi';
const ANALYSES_LIST_KEY = 'analyses:list';
const ANALYSES_VERSION_KEY = 'analyses:version';

const MOCK_NEWS = [
  {
    title: 'فورى: بیت‌کوین سقف مقاومتی جدید را شکست!',
    description:
      'بازار ارزهای دیجیتال پس از ورود سرمایه‌گذاران سازمانی شاهد رشد شارپ فوق‌العاده‌ای در قیمت بیت‌کوین و اتریوم بوده است.',
    time_ago: '۵ دقیقه پیش',
    source: 'کوین‌تلگراف',
    image: 'https://images.cryptocompare.com/news/default/bitcoin.png',
    url: 'https://cointelegraph.com',
  },
];

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

async function fetchJson(url) {
  const response = await fetch(url, {
    method: 'GET',
    headers: {
      Accept: 'application/json',
    },
  });

  if (!response.ok) {
    return { ok: false, body: null };
  }

  try {
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
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          'User-Agent': 'Mozilla/5.0',
          Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
        },
      });

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
      source: 'mock_fallback',
      data: MOCK_NEWS,
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
    source: 'mock_fallback',
    data: MOCK_NEWS,
  };
}

async function readCachedAnalysesState(env) {
  const [cachedVersion, cachedList] = await Promise.all([
    readAppCache(env, ANALYSES_VERSION_KEY),
    readAppCache(env, ANALYSES_LIST_KEY),
  ]);

  let version = null;
  let analyses = null;

  if (cachedVersion !== null) {
    const numericVersion = Number(cachedVersion);
    if (Number.isFinite(numericVersion)) {
      version = numericVersion;
    }
  }

  if (cachedList) {
    try {
      const parsed = JSON.parse(cachedList);
      if (Array.isArray(parsed)) {
        analyses = parsed;
      }
    } catch {
      analyses = null;
    }
  }

  return { version, analyses };
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
function handleRoot() {
  return jsonResponse({
    status: 'ok',
    message: 'Amir BTC Assistant Backend is running!',
  });
}

function handleHealth(env) {
  return jsonResponse({
    status: 'ok',
    bot_configured: isBotConfigured(env),
    database_ready: isDatabaseConfigured(env),
    redis_ready: isCacheLayerConfigured(env),
  });
}

async function handleChartResolve(request, env) {
  const url = new URL(request.url);
  const rawSymbol = url.searchParams.get('symbol');

  if (rawSymbol === null) {
    return jsonResponse(buildFastApiValidationError('missing', 'Field required', null), { status: 422 });
  }

  if (rawSymbol.length < 1) {
    return jsonResponse(
      buildFastApiValidationError(
        'string_too_short',
        'String should have at least 1 character',
        rawSymbol,
        { min_length: 1 },
      ),
      { status: 422 },
    );
  }

  if (rawSymbol.length > 16) {
    return jsonResponse(
      buildFastApiValidationError(
        'string_too_long',
        'String should have at most 16 characters',
        rawSymbol,
        { max_length: 16 },
      ),
      { status: 422 },
    );
  }

  const result = await resolveChartExchange(env, rawSymbol);
  return jsonResponse({
    status: 'success',
    ...result,
  });
}

async function handleCalendarEvents(env) {
  const events = await fetchCalendarEvents(env);
  return jsonResponse({
    status: 'success',
    events,
  });
}

async function handleFarsiNews(env) {
  return jsonResponse(await fetchFarsiNews(env));
}

async function handleAnalyses(request, env) {
  const url = new URL(request.url);
  const rawVersion = url.searchParams.get('version');
  let requestedVersion = null;

  if (rawVersion !== null && rawVersion !== '') {
    const numericVersion = Number(rawVersion);
    if (!Number.isInteger(numericVersion)) {
      return jsonResponse(
        buildQueryFieldValidationError('version', 'int_parsing', 'Input should be a valid integer', rawVersion),
        { status: 422 },
      );
    }
    requestedVersion = numericVersion;
  }

  const cachedState = await readCachedAnalysesState(env);
  if (requestedVersion !== null && cachedState.version !== null && requestedVersion === cachedState.version) {
    return jsonResponse({
      status: 'success',
      analyses: null,
      version: cachedState.version,
      unchanged: true,
    });
  }

  if (requestedVersion === null && cachedState.version !== null && cachedState.analyses !== null) {
    return jsonResponse({
      status: 'success',
      analyses: cachedState.analyses,
      version: cachedState.version,
    });
  }

  return jsonResponse({
    status: 'success',
    analyses: cachedState.analyses ?? [],
    version: cachedState.version ?? 0,
  });
}

async function handleSessionsHeartbeat(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!env.SESSION_CACHE) {
    return jsonResponse(
      {
        status: 'error',
        message: 'SESSION_CACHE binding not configured',
      },
      { status: 503 },
    );
  }

  const url = new URL(request.url);
  const providedSessionId = normalizeOptionalString(url.searchParams.get('session_id'));
  const sessionId = providedSessionId || String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
  const userId = String(authState.user.id);
  const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
  const now = new Date();
  const lastSeen = now.toISOString();
  const nowMs = now.getTime();

  await Promise.all([
    writeSessionCache(env, `${SESSION_PREFIX}${userId}`, sessionId, ttlSeconds),
    writeSessionCache(env, `${SESSION_PREFIX}${userId}:seen`, lastSeen, ttlSeconds),
  ]);

  const state = await readPresenceState(env);
  prunePresenceState(state, nowMs);
  state[userId] = nowMs + ttlSeconds * 1000;
  await persistPresenceState(env, state, ttlSeconds);

  return jsonResponse({
    status: 'success',
    session_id: sessionId,
    last_seen: lastSeen,
    online_count: Object.keys(state).length,
  });
}

async function handleSessionsOnline(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!env.SESSION_CACHE) {
    return jsonResponse(
      {
        status: 'error',
        message: 'SESSION_CACHE binding not configured',
      },
      { status: 503 },
    );
  }

  const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
  const nowMs = Date.now();
  const state = await readPresenceState(env);
  prunePresenceState(state, nowMs);
  await persistPresenceState(env, state, ttlSeconds);

  return jsonResponse({
    status: 'success',
    count: Object.keys(state).length,
  });
}

async function handleSessionsEnd(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!env.SESSION_CACHE) {
    return jsonResponse(
      {
        status: 'error',
        message: 'SESSION_CACHE binding not configured',
      },
      { status: 503 },
    );
  }

  const ttlSeconds = getNumericEnv(env, 'SESSION_TTL', 120);
  const nowMs = Date.now();
  const userId = String(authState.user.id);

  await Promise.all([
    deleteSessionCache(env, `${SESSION_PREFIX}${userId}`),
    deleteSessionCache(env, `${SESSION_PREFIX}${userId}:seen`),
  ]);

  const state = await readPresenceState(env);
  prunePresenceState(state, nowMs);
  delete state[userId];
  await persistPresenceState(env, state, ttlSeconds);

  return jsonResponse({
    status: 'success',
    online_count: Object.keys(state).length,
  });
}

async function handleAssistantLimits(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!env.RATE_LIMITS) {
    return jsonResponse(
      {
        status: 'error',
        message: 'RATE_LIMITS binding not configured',
      },
      { status: 503 },
    );
  }

  const limits = await checkRateLimits(env, authState.user.id);
  return jsonResponse({ status: 'success', ...limits });
}

async function handleAssistantChat(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!env.RATE_LIMITS) {
    return jsonResponse(
      {
        status: 'error',
        message: 'RATE_LIMITS binding not configured',
      },
      { status: 503 },
    );
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  const message = payload.message;
  if (typeof message !== 'string') {
    return jsonResponse(
      buildBodyFieldValidationError('message', 'string_type', 'Input should be a valid string', message ?? null),
      { status: 422 },
    );
  }

  if (message.length < 1) {
    return jsonResponse(
      buildBodyFieldValidationError(
        'message',
        'string_too_short',
        'String should have at least 1 character',
        message,
        { min_length: 1 },
      ),
      { status: 422 },
    );
  }

  if (message.length > 4000) {
    return jsonResponse(
      buildBodyFieldValidationError(
        'message',
        'string_too_long',
        'String should have at most 4000 characters',
        message,
        { max_length: 4000 },
      ),
      { status: 422 },
    );
  }

  const userId = String(authState.user.id);
  const hasImage = Boolean(payload.image);

  const limits = await checkRateLimits(env, userId);
  if (!limits.allowed) {
    return jsonResponse({ status: 'error', ...limits }, { status: 429 });
  }

  if (hasImage && limits.images_used >= limits.images_limit) {
    return jsonResponse({ status: 'error', reason: 'daily_image_limit', allowed: false }, { status: 429 });
  }
  return jsonResponse(
    {
      status: 'error',
      message: 'assistant service is disabled on this worker',
    },
    { status: 501 },
  );
}

function getUserStateKey(userId) {
  return `user:${userId}`;
}

function getWatchlistKey(userId) {
  return `watchlist:${userId}`;
}

function getAlertsKey(userId) {
  return `alerts:${userId}`;
}

const TICKETS_ALL_KEY = 'tickets:all';

function getUserDataTtl(env) {
  return Math.max(getNumericEnv(env, 'USER_DATA_TTL', 60 * 60 * 24 * 30), 60 * 10);
}

async function readSessionJson(env, key, fallbackValue) {
  const raw = await readSessionCache(env, key);
  if (!raw) {
    return fallbackValue;
  }
  try {
    return JSON.parse(raw);
  } catch {
    return fallbackValue;
  }
}

async function writeSessionJson(env, key, value, ttlSeconds) {
  await writeSessionCache(env, key, JSON.stringify(value), ttlSeconds);
}

async function handleTicketsCreate(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  payload.user_id = String(authState.user.id);
  const ttlSeconds = getUserDataTtl(env);
  const allTickets = await readSessionJson(env, TICKETS_ALL_KEY, []);
  const ticketId = String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
  const now = new Date().toISOString();
  const ticket = {
    id: ticketId,
    user_id: payload.user_id,
    user_name: normalizeOptionalString(payload.user_name) || normalizeOptionalString(payload.username) || normalizeOptionalString(authState.user.first_name) || 'User',
    title: normalizeOptionalString(payload.title) || '',
    body: normalizeOptionalString(payload.body) || '',
    status: 'open',
    replies: [],
    created_at: now,
  };
  allTickets.push(ticket);
  await writeSessionJson(env, TICKETS_ALL_KEY, allTickets, ttlSeconds);
  return jsonResponse({ status: 'success', ticket });
}

async function handleTicketsList(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  const userId = String(authState.user.id);
  const allTickets = await readSessionJson(env, TICKETS_ALL_KEY, []);
  const tickets = allTickets.filter((ticket) => String(ticket.user_id) === userId);
  return jsonResponse({ status: 'success', tickets });
}

async function handleTicketsAll(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!isAdminTelegramId(env, authState.user.id)) {
    return jsonResponse({ detail: 'Admin access required' }, { status: 403 });
  }
  const allTickets = await readSessionJson(env, TICKETS_ALL_KEY, []);
  return jsonResponse({ status: 'success', tickets: allTickets });
}

async function handleTicketReply(request, env, ticketId) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  if (!isAdminTelegramId(env, authState.user.id)) {
    return jsonResponse({ detail: 'Admin access required' }, { status: 403 });
  }
  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  const message = normalizeOptionalString(payload.message) || '';
  if (!message) {
    return jsonResponse(
      buildBodyFieldValidationError('message', 'string_too_short', 'String should have at least 1 character', message, { min_length: 1 }),
      { status: 422 },
    );
  }

  const ttlSeconds = getUserDataTtl(env);
  const allTickets = await readSessionJson(env, TICKETS_ALL_KEY, []);
  const idx = allTickets.findIndex((ticket) => String(ticket.id) === String(ticketId));
  if (idx === -1) {
    return jsonResponse({ status: 'error', message: 'ticket not found' }, { status: 404 });
  }

  const ticket = allTickets[idx];
  const replies = Array.isArray(ticket.replies) ? ticket.replies.slice() : [];
  replies.push({ from: 'admin', message, at: new Date().toISOString() });
  allTickets[idx] = { ...ticket, replies, status: 'answered' };
  await writeSessionJson(env, TICKETS_ALL_KEY, allTickets, ttlSeconds);
  return jsonResponse({ status: 'success' });
}

async function handleTicketDelete(request, env, ticketId) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  const userId = String(authState.user.id);
  const isAdmin = isAdminTelegramId(env, authState.user.id);
  const ttlSeconds = getUserDataTtl(env);
  const allTickets = await readSessionJson(env, TICKETS_ALL_KEY, []);
  const idx = allTickets.findIndex((ticket) => String(ticket.id) === String(ticketId));
  if (idx === -1) {
    return jsonResponse({ status: 'error', message: 'ticket not found' }, { status: 404 });
  }

  const ticket = allTickets[idx];
  if (!isAdmin && String(ticket.user_id) !== userId) {
    return jsonResponse({ detail: 'Forbidden' }, { status: 403 });
  }

  allTickets.splice(idx, 1);
  await writeSessionJson(env, TICKETS_ALL_KEY, allTickets, ttlSeconds);
  return jsonResponse({ status: 'success' });
}

async function handleAlertsCreate(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  payload.user_id = String(authState.user.id);
  const ttlSeconds = getUserDataTtl(env);
  const userId = payload.user_id;
  const alerts = await readSessionJson(env, getAlertsKey(userId), []);
  const alertId = String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
  const now = new Date().toISOString();
  const alert = {
    id: alertId,
    user_id: userId,
    symbol: normalizeOptionalString(payload.symbol) || '',
    price: Number(payload.price),
    direction: normalizeOptionalString(payload.direction) || 'above',
    created_at: now,
  };
  alerts.push(alert);
  await writeSessionJson(env, getAlertsKey(userId), alerts, ttlSeconds);
  return jsonResponse({ status: 'success', alert });
}

async function handleAlertsList(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  const userId = String(authState.user.id);
  const alerts = await readSessionJson(env, getAlertsKey(userId), []);
  return jsonResponse({ status: 'success', alerts });
}

async function handleAlertDelete(request, env, alertId) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  const userId = String(authState.user.id);
  const ttlSeconds = getUserDataTtl(env);
  const alerts = await readSessionJson(env, getAlertsKey(userId), []);
  const nextAlerts = alerts.filter((alert) => String(alert.id) !== String(alertId));
  await writeSessionJson(env, getAlertsKey(userId), nextAlerts, ttlSeconds);
  return jsonResponse({ status: 'success', deleted: true });
}

async function handleUsersBootstrap(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }
  const userId = String(authState.user.id);
  payload.user_id = userId;
  const ttlSeconds = getUserDataTtl(env);
  const existingUserState = await readSessionJson(env, getUserStateKey(userId), {});
  const membership = await resolveChannelMembership(env, userId);
  const lang = normalizeOptionalString(payload.lang) || normalizeOptionalString(existingUserState.lang) || 'fa';
  const userState = {
    ...existingUserState,
    user_id: userId,
    telegram_id: userId,
    username: normalizeOptionalString(payload.username) || normalizeOptionalString(existingUserState.username) || null,
    first_name: normalizeOptionalString(payload.first_name) || normalizeOptionalString(existingUserState.first_name) || null,
    last_name: normalizeOptionalString(payload.last_name) || normalizeOptionalString(existingUserState.last_name) || null,
    lang,
    referrer_id: normalizeOptionalString(payload.referrer_id) || normalizeOptionalString(existingUserState.referrer_id) || null,
    channel_joined: Boolean(membership?.joined),
    updated_at: new Date().toISOString(),
  };
  const watchlist = await readSessionJson(env, getWatchlistKey(userId), []);
  await writeSessionJson(env, getUserStateKey(userId), userState, ttlSeconds);
  return jsonResponse({
    status: 'success',
    user: { lang: userState.lang, channel_joined: userState.channel_joined },
    watchlist: Array.isArray(watchlist) ? watchlist : [],
  });
}

async function handleUsersMe(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  const userId = String(authState.user.id);
  const state = await readSessionJson(env, getUserStateKey(userId), {});
  const membership = await resolveChannelMembership(env, userId);
  return jsonResponse({
    status: 'success',
    user: {
      id: userId,
      telegram_id: userId,
      username: normalizeOptionalString(state.username) || null,
      first_name: normalizeOptionalString(state.first_name) || null,
      last_name: normalizeOptionalString(state.last_name) || null,
      lang: normalizeOptionalString(state.lang) || 'fa',
      channel_joined: Boolean(membership?.joined),
    },
  });
}

async function handleUsersMeSettings(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  const userId = String(authState.user.id);
  payload.user_id = userId;
  const ttlSeconds = getUserDataTtl(env);
  const existingUserState = await readSessionJson(env, getUserStateKey(userId), {});
  const lang = normalizeOptionalString(payload.lang) || normalizeOptionalString(existingUserState.lang) || 'fa';
  const nextState = {
    ...existingUserState,
    user_id: userId,
    telegram_id: userId,
    lang,
    updated_at: new Date().toISOString(),
  };
  await writeSessionJson(env, getUserStateKey(userId), nextState, ttlSeconds);
  return jsonResponse({ status: 'success', user: { lang } });
}

async function handleWatchlistGet(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  const userId = String(authState.user.id);
  const symbols = await readSessionJson(env, getWatchlistKey(userId), []);
  const normalized = Array.isArray(symbols) ? symbols : [];
  return jsonResponse({ status: 'success', symbols: normalized, watchlist: normalized });
}

async function handleWatchlistPut(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  payload.user_id = String(authState.user.id);
  const symbols = Array.isArray(payload.symbols) ? payload.symbols.map((value) => String(value).toUpperCase()).filter(Boolean).slice(0, 50) : [];
  const ttlSeconds = getUserDataTtl(env);
  await writeSessionJson(env, getWatchlistKey(payload.user_id), symbols, ttlSeconds);
  return jsonResponse({ status: 'success', symbols });
}

async function handleReferralsStats(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }
  return jsonResponse({ total: 0, active: 0, tokens: 0 });
}

async function handleNotify(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const originalBody = await request.text();
  let payload;
  try {
    payload = JSON.parse(originalBody);
  } catch {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
      { status: 422 },
    );
  }

  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
    return jsonResponse(
      buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
      { status: 422 },
    );
  }

  const message = normalizeOptionalString(payload.message) || '';
  if (!message) {
    return jsonResponse(
      buildBodyFieldValidationError('message', 'string_too_short', 'String should have at least 1 character', message, { min_length: 1 }),
      { status: 422 },
    );
  }

  if (!isBotConfigured(env)) {
    return jsonResponse({ sent: false, reason: 'bot_not_configured' }, { status: 200 });
  }

  try {
    await sendTelegramMessage(env, {
      chat_id: Number(authState.user.id),
      text: message,
      disable_web_page_preview: true,
    });
    return jsonResponse({ sent: true });
  } catch {
    return jsonResponse({ sent: false }, { status: 200 });
  }
}

async function handleCheckJoin(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const url = new URL(request.url);
  const forceRefresh = parseBooleanQueryParam(url.searchParams.get('refresh'));
  const resolvedUserId = String(authState.user.id);

  if (forceRefresh) {
    await invalidateJoinCache(env, resolvedUserId);
  }

  const result = await resolveChannelMembership(env, resolvedUserId, {
    forceRefresh,
  });
  console.log(
    JSON.stringify({
      scope: 'check-join',
      user_id: resolvedUserId,
      force_refresh: forceRefresh,
      result,
    }),
  );
  if (result.status === 'DB_ERROR') {
    return jsonResponse(result);
  }

  return jsonResponse({
    status: 'success',
    ...result,
  });
}

async function handleDebugCheckJoin(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const debugPayload = await getChatMemberDebugPayload(String(authState.user.id), env);
  return jsonResponse({
    required_channel: debugPayload.required_channel,
    user_id: String(authState.user.id),
    telegram_response: debugPayload.telegram_response,
    joined: debugPayload.joined,
  });
}

async function handleCheckJoinInvalidate(request, env) {
  const authState = authenticateTelegramRequest(request, env);
  if (authState.error) {
    return authState.error;
  }

  const resolvedUserId = String(authState.user.id);
  const invalidated = await invalidateJoinCache(env, resolvedUserId);
  console.log(
    JSON.stringify({
      scope: 'check-join-invalidate',
      user_id: resolvedUserId,
      invalidated,
    }),
  );
  return jsonResponse({
    status: 'success',
    invalidated,
    user_id: resolvedUserId,
  });
}

async function handleTelegramWebhook(request, env) {
  const requestPath = new URL(request.url).pathname || '/';
  try {
    const updatePayload = await request.json();
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
        headers: withCors(),
      });
    }

    if (!isBotConfigured(env)) {
      return new Response(null, {
        status: 200,
        headers: withCors(),
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
  } catch (error) {
    console.warn('Telegram webhook processing error:', error);
  }

  return new Response(null, {
    status: 200,
    headers: withCors(),
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
  console.log(
    JSON.stringify({
      ...payload,
      skipped: true,
      reason: 'scheduled alerts runner is not configured on this worker',
    }),
  );
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
        headers: withCors(),
      });
    }

    const url = new URL(request.url);

    if (request.method === 'GET' && url.pathname === '/') {
      return handleRoot();
    }

    if (request.method === 'GET' && url.pathname === '/api/health') {
      return handleHealth(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/charts/resolve') {
      return handleChartResolve(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/calendar/events') {
      return handleCalendarEvents(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/farsi-news') {
      return handleFarsiNews(env);
    }

    if (request.method === 'GET' && url.pathname === '/api/analyses') {
      return handleAnalyses(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/tickets') {
      return handleTicketsCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/tickets') {
      return handleTicketsList(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/tickets/all') {
      return handleTicketsAll(request, env);
    }

    if (request.method === 'POST' && /^\/api\/tickets\/[^/]+\/reply$/u.test(url.pathname)) {
      const ticketId = url.pathname.split('/')[3] || '';
      return handleTicketReply(request, env, ticketId);
    }

    if (request.method === 'DELETE' && /^\/api\/tickets\/[^/]+$/u.test(url.pathname) && url.pathname !== '/api/tickets/all') {
      const ticketId = url.pathname.split('/')[3] || '';
      return handleTicketDelete(request, env, ticketId);
    }

    if (request.method === 'POST' && url.pathname === '/api/alerts') {
      return handleAlertsCreate(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/alerts') {
      return handleAlertsList(request, env);
    }

    if (request.method === 'DELETE' && /^\/api\/alerts\/[^/]+$/u.test(url.pathname)) {
      const alertId = url.pathname.split('/')[3] || '';
      return handleAlertDelete(request, env, alertId);
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions/heartbeat') {
      return handleSessionsHeartbeat(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/sessions/online') {
      return handleSessionsOnline(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/sessions/end') {
      return handleSessionsEnd(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/assistant/limits') {
      return handleAssistantLimits(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/assistant/chat') {
      return handleAssistantChat(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/users/me') {
      return handleUsersMe(request, env);
    }

    if (request.method === 'PUT' && url.pathname === '/api/users/me/settings') {
      return handleUsersMeSettings(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/users/bootstrap') {
      return handleUsersBootstrap(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/watchlist') {
      return handleWatchlistGet(request, env);
    }

    if (request.method === 'PUT' && url.pathname === '/api/watchlist') {
      return handleWatchlistPut(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/notify') {
      return handleNotify(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/referrals/stats') {
      return handleReferralsStats(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/check-join') {
      return handleCheckJoin(request, env);
    }

    if (request.method === 'GET' && url.pathname === '/api/debug/check-join') {
      return handleDebugCheckJoin(request, env);
    }

    if (request.method === 'POST' && url.pathname === '/api/check-join/invalidate') {
      return handleCheckJoinInvalidate(request, env);
    }

    if (request.method === 'POST' && (url.pathname === '/telegram' || url.pathname === '/')) {
      return handleTelegramWebhook(request, env);
    }

    return jsonResponse(
      {
        status: 'error',
        message: 'Route not found in Cloudflare shell',
      },
      { status: 404 },
    );
  },

  async scheduled(controller, env, ctx) {
    ctx.waitUntil(runScheduledAlertsBaseline(controller, env));
  },
};
//#endregion

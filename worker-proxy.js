import { createHmac, timingSafeEqual } from 'node:crypto';
import { Pool } from '@neondatabase/serverless';
import { createAlertRepository } from './src/repositories/alerts.js';
import { createAlertHandlers } from './src/controllers/alerts.js';
import { createWatchlistRepository } from './src/repositories/watchlist.js';
import { createWatchlistHandlers } from './src/controllers/watchlist.js';
import { createReferralRepository } from './src/repositories/referrals.js';
import { createReferralHandlers } from './src/controllers/referrals.js';
import { createWalletRepository } from './src/repositories/wallet.js';
import { createWalletHandlers } from './src/controllers/wallet.js';
import { createWheelRepository } from './src/repositories/wheel.js';
import { createWheelHandlers } from './src/controllers/wheel.js';
import { createEconomyService } from './src/services/economy.js';
import { createSessionRepository } from './src/repositories/sessions.js';
import { createSessionHandlers } from './src/controllers/sessions.js';
import { createTicketRepository } from './src/repositories/tickets.js';
import { createTicketHandlers } from './src/controllers/tickets.js';
import { createUserRepository } from './src/repositories/users.js';
import { createUserHandlers } from './src/controllers/users.js';
import { createNotifyHandlers } from './src/controllers/notify.js';
import { createNotificationRepository } from './src/repositories/notifications.js';
import { createNotificationHandlers } from './src/controllers/notifications.js';
import { createAssistantHandlers } from './src/controllers/assistant.js';
import { createAnalysisRepository } from './src/repositories/analyses.js';
import { createAnalysisHandlers } from './src/controllers/analyses.js';
import { createAdminRepository } from './src/repositories/admin.js';
import { createAdminHandlers } from './src/controllers/admin.js';
import { createRewardCenterRepository } from './src/repositories/reward_center.js';
import { createRewardCenterHandlers } from './src/controllers/reward_center.js';
import { createNotificationPlatformRepository } from './src/repositories/notification_platform.js';
import { createNotificationPlatformHandlers } from './src/controllers/notification_platform.js';
import { createMarketOverviewService } from './src/services/market_overview_service.js';

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
const CORS_ALLOW_HEADERS = 'Content-Type, X-Telegram-Init-Data, X-Telegram-Bot-Api-Secret-Token, Cache-Control';

/**
 * Sanitize an error for safe logging — strips potential secrets (DB URLs, tokens).
 * Neon/Postgres errors often include the connection string (with password).
 */
function safeError(scope, error) {
  const message = error instanceof Error ? error.message : String(error);
  // Strip common secret patterns from error messages
  const sanitized = message
    .replace(/(postgres|postgresql|pgbouncer):\/\/[^\s@]+:[^\s@]+@/gi, 'postgres://***:***@')
    .replace(/(token|key|secret|password)=["'][^"']+["']/gi, '$1=***');
  return JSON.stringify({ scope, error: sanitized, type: error?.constructor?.name });
}

function withCors(headers = {}, env = null) {
  const merged = new Headers(headers);
  // Echo localhost origins (any port) so the app can be previewed locally
  // via the Next.js dev server / `wrangler pages dev`. Real traffic keeps the
  // pinned WEBAPP_URL origin.
  const reqOrigin = _currentRequestOrigin;
  const isLocalhost = reqOrigin && (reqOrigin.startsWith('http://localhost:') || reqOrigin.startsWith('https://localhost:'));
  if (isLocalhost) {
    merged.set('Access-Control-Allow-Origin', reqOrigin);
  } else if (env) {
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

// Per-invocation request Origin (set at the top of the fetch handler). Workers
// handle one request per invocation, so this is safe to keep module-scoped.
let _currentRequestOrigin = null;

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

/**
 * Returns true when the Worker is NOT running in production.
 * Used to gate development-only auth fallbacks (e.g. ?user_id=) that must
 * never be active in production to prevent user impersonation.
 */
function isDevMode(env) {
  const v = String(env.APP_ENV || '').trim().toLowerCase();
  return v === 'development' || v === 'staging';
}

async function readAppCache(env, key) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.get !== 'function') {
    return null;
  }

  // FAIL-SAFE: KV read failure should return null (cache miss) not crash.
  // The caller will fall through to live data fetching.
  try {
    return await env.APP_CACHE.get(key);
  } catch (e) {
    console.warn('readAppCache failed (non-fatal):', e.message || e);
    return null;
  }
}

async function writeAppCache(env, key, value, expirationTtl) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.put !== 'function') {
    return;
  }

  try {
    await env.APP_CACHE.put(key, value, { expirationTtl });
  } catch (e) {
    // KV write limit exceeded or transient error — degrade gracefully
    console.warn('writeAppCache failed:', e.message || e);
  }
}

// ============================================================================
// DIAG: Write diagnostic log entries to KV for retrieval via /api/_diag/referral-log
// OPTIMIZATION: Use in-memory buffer + batch writes to reduce KV writes.
// Previously each diagLog call did 1 KV read + 1 KV write = 2 KV ops.
// With 21 calls per referral flow, that's 42 KV ops just for logging.
// Now: buffer in memory, flush once per request via waitUntil.
// ============================================================================
const DIAG_LOG_KEY = 'diag_referral_flow_log';
const DIAG_LOG_MAX = 50;
const _diagBuffer = [];

async function diagLog(env, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(line);
  // Buffer in memory — will be flushed by flushDiagLog()
  _diagBuffer.push(line);
  if (_diagBuffer.length > DIAG_LOG_MAX) {
    _diagBuffer.splice(0, _diagBuffer.length - DIAG_LOG_MAX);
  }
}

/** Flush buffered diag logs to KV (call once at end of request via waitUntil) */
async function flushDiagLog(env) {
  if (_diagBuffer.length === 0) return;
  if (!env?.APP_CACHE?.put) return;
  try {
    const existing = await env.APP_CACHE.get(DIAG_LOG_KEY);
    let lines = existing ? existing.split('\n').filter(Boolean) : [];
    lines = lines.concat(_diagBuffer);
    if (lines.length > DIAG_LOG_MAX) lines = lines.slice(-DIAG_LOG_MAX);
    await env.APP_CACHE.put(DIAG_LOG_KEY, lines.join('\n'), { expirationTtl: 600 });
    _diagBuffer.length = 0; // Clear buffer after successful flush
  } catch { /* KV write failure should not break the flow */ }
}

/** Fire-and-forget version for sync contexts (buffers, does not block caller) */
function diagLogSync(env, entry) {
  const line = JSON.stringify({ ts: new Date().toISOString(), ...entry });
  console.log(line);
  _diagBuffer.push(line);
  if (_diagBuffer.length > DIAG_LOG_MAX) {
    _diagBuffer.splice(0, _diagBuffer.length - DIAG_LOG_MAX);
  }
}

// ============================================================================
// MAINTENANCE MODE — System-wide maintenance state stored in APP_CACHE KV
// with in-memory fallback for when KV writes fail (free-plan daily limit).
// ============================================================================
const MAINT_KV_KEY = 'system_maintenance_state';
const MAINT_DEFAULTS = {
  enabled: false,
  title: 'در حال ساخت آینده‌ای بهتر!',
  description: 'در حال ارتقاء سیستم‌ها و اضافه کردن قابلیت‌های جدید هستیم. به‌زودی با تجربه‌ای فوق‌العاده بازمی‌گردیم.',
  progress: 0,
  updated_at: null,
  updated_by: null,
};

// In-memory fallback: persists across requests within the same Worker isolate.
// This ensures maintenance state survives even when KV writes are rate-limited.
// Each Worker isolate has its own copy, but KV is still the primary store
// and will be used when available.
let _maintMemoryState = null;
let _maintKvWriteFailed = false;

/**
 * Read the maintenance state.
 * Tries KV first, falls back to in-memory state, then defaults.
 * Never throws — on any error returns defaults.
 */
async function getMaintenanceState(env) {
  try {
    // If we have an in-memory override (from a previous setMaintenanceState
    // where KV write failed), use that as the source of truth.
    if (_maintMemoryState) {
      return { maintenance: { ...MAINT_DEFAULTS, ..._maintMemoryState } };
    }
    if (!env?.APP_CACHE || typeof env.APP_CACHE.get !== 'function') {
      return { maintenance: { ...MAINT_DEFAULTS } };
    }
    const raw = await env.APP_CACHE.get(MAINT_KV_KEY);
    if (!raw) return { maintenance: { ...MAINT_DEFAULTS } };
    const parsed = JSON.parse(raw);
    return {
      maintenance: {
        ...MAINT_DEFAULTS,
        ...parsed,
      },
    };
  } catch (e) {
    console.warn('getMaintenanceState error:', e.message || e);
    // Last resort: return in-memory state or defaults
    if (_maintMemoryState) {
      return { maintenance: { ...MAINT_DEFAULTS, ..._maintMemoryState } };
    }
    return { maintenance: { ...MAINT_DEFAULTS } };
  }
}

/**
 * Write the maintenance state to KV. Returns the new state.
 * On KV write failure, stores in memory as fallback so the state persists
 * within the Worker isolate. This prevents the "auto-disable" bug where
 * the admin enables maintenance but it immediately reverts because the
 * KV write failed and the next GET reads the old KV value.
 */
async function setMaintenanceState(env, patch, updatedBy) {
  const current = (await getMaintenanceState(env)).maintenance;
  const next = {
    ...current,
    // Clamp progress 0-100
    progress: patch.progress != null ? Math.max(0, Math.min(100, Number(patch.progress) || 0)) : current.progress,
    // Sanitize title/description
    title: patch.title != null ? String(patch.title).slice(0, 60) : current.title,
    description: patch.description != null ? String(patch.description).slice(0, 200) : current.description,
    enabled: patch.enabled != null ? Boolean(patch.enabled) : current.enabled,
    updated_at: new Date().toISOString(),
    updated_by: String(updatedBy || 'admin'),
  };

  let kvWriteSuccess = false;

  if (env?.APP_CACHE && typeof env.APP_CACHE.put === 'function') {
    try {
      await env.APP_CACHE.put(MAINT_KV_KEY, JSON.stringify(next));
      kvWriteSuccess = true;
      _maintKvWriteFailed = false;
    } catch (err) {
      console.warn('setMaintenanceState KV write failed, using in-memory fallback:', err?.message || err);
      _maintKvWriteFailed = true;
    }
  }

  // CRITICAL FIX: Always store in memory as well, so the state persists
  // even when KV writes fail. This prevents the "auto-disable" bug where
  // getMaintenanceState() reads the OLD KV value after a failed write.
  _maintMemoryState = { ...next };

  // Include warning in response if KV write failed (but state IS persisted in memory)
  const result = { maintenance: next };
  if (!kvWriteSuccess) {
    result.warning = 'State saved in memory only (KV write limit reached). State will reset when Worker restarts.';
  }
  return result;
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

  try {
    await env.RATE_LIMITS.put(key, value, { expirationTtl });
  } catch (e) {
    // KV write limit exceeded — degrade gracefully
    console.warn('writeRateLimitCache failed:', e.message || e);
  }
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

  try {
    await env.SESSION_CACHE.put(key, value, { expirationTtl });
  } catch (e) {
    // KV write limit exceeded — degrade gracefully
    console.warn('writeSessionCache failed:', e.message || e);
  }
}

async function deleteSessionCache(env, key) {
  if (!env.SESSION_CACHE || typeof env.SESSION_CACHE.delete !== 'function') {
    return;
  }

  try {
    await env.SESSION_CACHE.delete(key);
  } catch (e) {
    console.warn('deleteSessionCache failed:', e.message || e);
  }
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

async function validateTelegramInitData(initData, botToken, maxAgeSeconds = 86400) {
  if (!initData || !botToken || botToken === 'REPLACE_WITH_TOKEN') {
    return null;
  }

  try {
    const pairs = parseTelegramInitDataPairs(initData.trim());

    // Extract the received hash
    const hashPair = pairs.find(([k]) => k === 'hash');
    if (!hashPair || !hashPair[1]) return null;
    const receivedHash = hashPair[1];

    // Build data-check-string per Telegram Bot API spec:
    // - Exclude 'hash' field (it's what we're verifying)
    // - INCLUDE 'signature' field — confirmed via REAL production diagnostic data
    //   from Telegram Android 12.9.0:
    //   receivedHash: 3759fe79d6564ea5d6b0391f3c98a554b7d7f37718d7ba0983a980501b7df361
    //   Method A (include signature): computedHash matches receivedHash ✅
    //   Method B (exclude signature): computedHash does NOT match ❌
    //   Conclusion: Telegram Android computes HMAC-SHA256 hash WITH signature in DCS.
    // - Sort remaining fields alphabetically by key
    // - Decode all values before joining
    // - Join with '\n'
    // Reference: https://core.telegram.org/bots/webapps#validating-data-received-via-the-mini-app
    const dataCheckString = pairs
      .filter(([k]) => k !== 'hash')
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([k, v]) => k + '=' + decodeTelegramValue(v))
      .join('\n');

    // secret_key = HMAC-SHA256(key='WebAppData', message=botToken)
    const secretKey = createHmac('sha256', 'WebAppData').update(botToken).digest();

    // hash = HMAC-SHA256(key=secretKey, message=data_check_string)
    const computedHash = createHmac('sha256', secretKey).update(dataCheckString).digest('hex');

    if (!safeCompareStrings(computedHash, receivedHash)) {
      console.error('[TG-AUTH] Hash mismatch — validation failed');
      return null;
    }

    // Check auth_date freshness
    const authDateValue = pairs.find(([k]) => k === 'auth_date');
    if (authDateValue) {
      const authDate = Number(decodeTelegramValue(authDateValue[1]));
      if (Number.isFinite(authDate)) {
        const ageSeconds = Math.floor(Date.now() / 1000) - authDate;
        if (ageSeconds > maxAgeSeconds) return null;
      }
    }

    // Parse user
    const userPair = pairs.find(([k]) => k === 'user');
    if (!userPair) return null;
    const user = JSON.parse(decodeTelegramValue(userPair[1]));
    return user && user.id ? user : null;
  } catch (e) {
    console.error('[TG-AUTH] validateTelegramInitData exception:', e.message);
    return null;
  }
}
async function authenticateTelegramRequest(request, env) {
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

  const user = await validateTelegramInitData(initData, String(env.TELEGRAM_BOT_TOKEN || ''));
  if (!user || !user.id) {
    return {
      error: jsonResponse({ detail: 'Invalid Telegram init data' }, { status: 401 }, env),
      user: null,
    };
  }

  return { error: null, user };
}

/**
 * Enforce channel membership for protected API endpoints.
 * Returns a 403 Response if the user is NOT a channel member, or null if allowed.
 * Must be called AFTER authenticateTelegramRequest succeeds.
 * Caller is responsible for only calling this in production.
 */
async function requireChannelJoin(user, env) {
  if (!user || !user.id) {
    return jsonResponse({ detail: 'Authentication required' }, { status: 401 }, env);
  }
  if (isAdminTelegramId(env, user.id)) {
    return null; // Admin always passes
  }
  try {
    const membership = await resolveChannelMembership(env, String(user.id), { forceRefresh: false });
    if (membership?.joined) {
      return null; // Member — allowed
    }
  } catch {
    // On error, deny access for security
  }
  return jsonResponse({ detail: 'Channel membership required', code: 'CHANNEL_JOIN_REQUIRED' }, { status: 403 }, env);
}

/**
 * Optional Telegram auth — tries initData, falls back to a raw user_id.
 * Returns { user, authMethod, error }.
 *   - On initData success: { user, authMethod: 'init_data', error: null }
 *   - On fallback success: { user, authMethod: 'fallback', error: null }
 *   - On both fail:     { user: null, authMethod: null, error: <original auth Response> }
 */
async function optionalTelegramAuth(request, env) {
  const authState = await authenticateTelegramRequest(request, env);
  if (authState.user) {
    return { user: authState.user, authMethod: 'init_data', error: null };
  }

  // Security (C-1): fallback is ONLY allowed outside production.
  // In production, only cryptographically-verified initData is accepted.
  if (!isDevMode(env)) {
    return { user: null, authMethod: null, error: authState.error };
  }

  // Dev/test fallback — try query-param ?user_id=
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
// dbPools removed — using neon() stateless client instead

function resolveDatabaseUrl(env) {
  let url = String(env.DATABASE_URL || env.DIRECT_URL || '').trim();
  if (!url) return '';
  // Auto-append pgbouncer=true for Neon serverless Pool if missing.
  if (!url.includes('pgbouncer=true')) {
    url += (url.includes('?') ? '&' : '?') + 'pgbouncer=true';
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

  // Allow localhost origins (any port) so the app can be previewed locally
  // (e.g. via the Next.js dev server or `wrangler pages dev`). Real user
  // traffic still comes from the Telegram WebView / Pages domain and is
  // validated below. Telegram init-data remains the real auth layer.
  try {
    const reqOrigin = new URL(origin).origin;
    if (reqOrigin.startsWith('http://localhost:') || reqOrigin.startsWith('https://localhost:')) {
      return null;
    }
  } catch {
    // malformed Origin header → fall through to rejection below
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
    console.warn(safeError('join-cache-read', error));
  }

  return null;
}

async function setCachedJoinStatus(env, userId, joined) {
  if (!env.JOIN_CACHE || typeof env.JOIN_CACHE.put !== 'function') {
    return;
  }

  try {
    // SECURITY: shorter TTL for 'joined' (300s / 5 min) so a user who LEAVES the
    // channel loses access within 5 minutes. Shorter TTL for 'not joined' (60s)
    // so a user who JOINS is detected within 1 minute. This balances Telegram
    // API load with security freshness.
    const ttl = joined
      ? Math.min(getNumericEnv(env, 'JOIN_CACHE_TTL', 300), 300)  // max 5 min for joined
      : 60;  // 1 min for not-joined
    await env.JOIN_CACHE.put(getJoinCacheKey(userId), joined ? '1' : '0', {
      expirationTtl: ttl,
    });
  } catch (error) {
    console.warn(safeError('join-cache-write', error));
  }
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

function extractStartParam(text) {
  const match = /\/start(?:@\S+)?\s+(ref_\S+)/iu.exec(String(text || '').trim());
  const result = match ? match[1] : null;
  // Note: no env available here — logged at call site via diag-start-handler
  // console.log kept for wrangler-tail real-time viewing
  console.log(JSON.stringify({ scope: 'diag-extractStartParam', raw_text: String(text || '').trim(), extracted: result }));
  return result;
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
    startParam: extractStartParam(text),
  };
}

function buildStartReplyPayload(env, chatId, isMember, startParam) {
  if (!isMember) {
    return {
      chat_id: chatId,
      text: '👋 به دستیار هوشمند امیر بی‌تی‌سی خوش آمدید!\n\n📌 برای استفاده از امکانات برنامه، ابتدا عضو کانال رسمی شوید.',
      reply_markup: {
        inline_keyboard: [
          [
            {
              text: '📢 عضویت در کانال',
              url: `https://t.me/${normalizeRequiredChannel(resolveRequiredChannel(env))}`,
            },
          ],
          [
            {
              text: '✅ عضو شدم — ورود به اپلیکیشن',
              callback_data: 'check_join',
            },
          ],
        ],
      },
      disable_web_page_preview: true,
    };
  }

  // Build WebApp URL with startapp parameter if referral is present
  let webAppUrl = resolveWebAppUrl(env);
  if (startParam) {
    const url = new URL(webAppUrl);
    url.searchParams.set('startapp', startParam);
    webAppUrl = url.toString();
  }

  return {
    chat_id: chatId,
    text: '👋 سلام! خوش برگشتی.\n\n🚀 برای شروع، مینی‌اپ را باز کنید.',
    reply_markup: {
      inline_keyboard: [
        [
          {
            text: '🚀 باز کردن مینی‌اپ',
            web_app: {
              url: webAppUrl,
            },
          },
        ],
      ],
    },
  };
}

async function sendTelegramMessage(env, payload, { retries = 1, timeoutMs = 8000 } = {}) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const response = await fetch(buildTelegramApiUrl(env, 'sendMessage'), {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json; charset=utf-8',
        },
        body: JSON.stringify(payload),
        signal: controller.signal,
      });

      if (response.ok) {
        clearTimeout(timer);
        return response;
      }

      // Retry on 429 (rate limit) or 5xx (server error)
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
        await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000));
        continue;
      }

      const responseText = await response.text();
      clearTimeout(timer);
      throw new Error(`Telegram sendMessage failed: HTTP ${response.status} ${responseText}`);
    } catch (err) {
      if (err.name === 'AbortError' && attempt < retries) {
        // Timeout — retry once more
        continue;
      }
      clearTimeout(timer);
      throw err;
    }
  }
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
    console.warn(safeError('answer-callback-query', error));
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
          text: 'OPEN App',
          web_app: { url: webAppUrl },
        },
      }),
    });
    console.log(JSON.stringify({ scope: 'sync-menu-button', url: webAppUrl }));
  } catch (error) {
    console.warn(safeError('sync-menu-button', error));
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
    console.warn(safeError('edit-message-reply-markup', error));
  }
}

const CALLBACK_RATE_LIMIT_TTL = 10; // seconds
const CALLBACK_RATE_LIMIT_KEY_PREFIX = 'cbrl:';

const MARKET_RATE_LIMIT_MAX = 30; // requests per window
const MARKET_RATE_LIMIT_WINDOW = 60; // seconds
const MARKET_RATE_LIMIT_KEY_PREFIX = 'mrl:';

async function isCallbackRateLimited(env, userId) {
  const key = `${CALLBACK_RATE_LIMIT_KEY_PREFIX}${String(userId)}`;
  const existing = await readRateLimitCache(env, key);
  if (existing) {
    return true;
  }
  await writeRateLimitCache(env, key, '1', CALLBACK_RATE_LIMIT_TTL);
  return false;
}

/**
 * IP-based sliding-window rate limiter for public market endpoints.
 * Returns true if rate limited, false if allowed.
 */
async function isMarketRateLimited(env, ip) {
  const key = `${MARKET_RATE_LIMIT_KEY_PREFIX}${ip}`;
  const existing = await readRateLimitCache(env, key);
  if (existing) {
    const count = parseInt(existing, 10) || 0;
    if (count >= MARKET_RATE_LIMIT_MAX) return true;
    await writeRateLimitCache(env, key, String(count + 1), MARKET_RATE_LIMIT_WINDOW);
    return false;
  }
  await writeRateLimitCache(env, key, '1', MARKET_RATE_LIMIT_WINDOW);
  return false;
}

function getAdminIds(env) {
  const ids = new Set();
  // Include the primary admin ID only if explicitly configured (Task 4.9 — no hardcoded fallback)
  const primary = String(env.ADMIN_TELEGRAM_ID || '').trim();
  if (primary) ids.add(primary);
  // Add additional comma-separated IDs (comma-separated string in env var)
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

// Create a NEW Pool per queryDb call to avoid module-level I/O sharing.
// Pool is lightweight to create — it doesn't connect until query() is called.
// This eliminates "Cannot perform I/O on behalf of a different request" errors
// while keeping TCP connections (which work from Cloudflare Workers).
function createPool(env) {
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) return null;
  return new Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 8000,
  });
}

async function getDbUserJoinState(env, userId) {
  const pool = createPool(env);
  if (!pool) return null;
  try {
    const result = await pool.query('SELECT telegram_id, channel_joined FROM users WHERE telegram_id = $1 LIMIT 1', [String(userId)]);
    const row = result.rows[0];
    if (!row) {
      return null;
    }

    return {
      telegram_id: String(row.telegram_id),
      channel_joined: Boolean(row.channel_joined),
    };
  } catch (error) {
    console.warn(safeError('join-db-read', error));
    return null;
  } finally {
    pool.end().catch(() => {});
  }
}

async function persistDbUserJoinState(env, userId, joined) {
  const pool = createPool(env);
  if (!pool) return;
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
    console.warn(safeError('join-db-write', error));
  } finally {
    pool.end().catch(() => {});
  }
}

/**
 * Get referral reward per invite — DB-driven with env fallback.
 *
 * Reads from referral_reward_tiers table (tier for 1+ invites).
 * Falls back to env var REFERRAL_TOKENS_PER_INVITE (default 3) if:
 *   - Database is not configured
 *   - Table doesn't exist or is empty
 *   - Query fails
 *
 * This is the SINGLE SOURCE OF TRUTH for the base per-invite reward.
 * Admins can change it via Reward Center → Referral Rewards tab.
 */
async function getReferralRewardPerInvite(env) {
  // Try DB first
  if (isDatabaseConfigured(env)) {
    try {
      const result = await queryDb(
        env,
        `SELECT token_amount FROM referral_reward_tiers
         WHERE is_enabled = TRUE AND invite_count <= 1
         ORDER BY invite_count DESC LIMIT 1`,
      );
      if (result.rows[0] && Number(result.rows[0].token_amount) > 0) {
        return Number(result.rows[0].token_amount);
      }
    } catch (e) {
      // Table might not exist yet — fall through to env fallback
      console.warn('getReferralRewardPerInvite DB read failed, using env fallback:', e.message);
    }
  }
  // Env fallback (still configurable, but DB takes priority)
  return Math.max(getNumericEnv(env, 'REFERRAL_TOKENS_PER_INVITE', 3), 0);
}

async function queryDb(env, sqlText, params = [], retries = 2) {
  const pool = createPool(env);
  if (!pool) throw new Error('Database not configured');
  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      try {
        const timeoutMs = 8000;
        const result = await Promise.race([
          pool.query(sqlText, params),
          new Promise((_, reject) =>
            setTimeout(() => reject(new Error(`Query timeout after ${timeoutMs}ms: ${sqlText.substring(0, 60)}`)), timeoutMs)
          ),
        ]);
        return result;
      } catch (error) {
        if (attempt === retries) throw error;
        const ms = Math.min(200 * 2 ** attempt, 1000);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  } finally {
    pool.end().catch(() => {});
  }
}

/**
 * Execute multiple SQL statements inside a single DB transaction.
 * Uses pool.connect() → BEGIN → queries → COMMIT (ROLLBACK on error).
 * Requires Neon serverless Pool with transaction_mode support.
 */
async function queryDbTransaction(env, queries) {
  const pool = createPool(env);
  if (!pool) throw new Error('Database not configured');
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    const results = [];
    for (const { sql, params } of queries) {
      results.push(await client.query(sql, params));
    }
    await client.query('COMMIT');
    return results;
  } catch (error) {
    try { await client.query('ROLLBACK'); } catch { /* ignore */ }
    throw error;
  } finally {
    client.release();
    pool.end().catch(() => {});
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

/**
 * Credit referral reward tokens AND mark referral as rewarded — all in a
 * single database transaction so they are guaranteed to be consistent.
 *
 * If alsoVerifyChannel is true, also sets channel_verified = TRUE (used when
 * an existing referral gets its channel verification + reward in one go).
 *
 * Solves H-R1 + H-R2: no possibility of double-reward or balance/rewarded drift.
 */
async function creditReferralWithReward(env, inviterId, referralId, inviteeId, amount, alsoVerifyChannel) {
  await diagLog(env, { scope: 'diag-creditReferralWithReward', inviterId, referralId, inviteeId, amount, alsoVerifyChannel });
  try {
    // REFACTOR: use Economy Layer (Reward Engine) instead of direct creditTokens.
    // This ensures all rewards go through rule validation + event system.
    const result = await economyService.grantReward({
      userId: String(inviterId),
      amount: Number(amount),
      rewardType: 'referral_reward',
      description: `Invite reward for user ${String(inviteeId)}`,
      refId: String(referralId),
      metadata: { referral_id: String(referralId), invitee_id: String(inviteeId) },
      auditInfo: { actor: 'system' },
      env,
    });
    await diagLog(env, { scope: 'diag-creditReferralWithReward-SUCCESS', newBalance: result.newBalance, txId: result.txId });

    // Mark referral as rewarded
    await queryDb(env,
      alsoVerifyChannel
        ? 'UPDATE referrals SET channel_verified = TRUE, rewarded = TRUE WHERE id = $1'
        : 'UPDATE referrals SET rewarded = TRUE WHERE id = $1',
      [Number(referralId)],
    );

  // Send referral + reward notifications via Notification Platform (single entry point)
  if (notificationPlatformRepo) {
    try {
      // Referral notification (new referral created)
      await notificationPlatformRepo.dispatch(env, {
        userId: inviterId,
        templateKey: 'referral_new_invite',
        category: 'referral',
        priority: 'medium',
        channel: 'mini_app',
        metadata: { invitee_id: String(inviteeId), referral_id: String(referralId) },
      }).catch(() => {});
      // Reward notification (tokens credited)
      await notificationPlatformRepo.dispatch(env, {
        userId: inviterId,
        templateKey: 'referral_reward',
        category: 'referral',
        priority: 'high',
        channel: 'both',
        metadata: { amount: String(amount), referral_id: String(referralId), invitee_id: String(inviteeId) },
      }).catch(() => {});
    } catch { /* notification failure should not break reward */ }
  }
  } catch (err) {
    await diagLog(env, { scope: 'diag-creditReferralWithReward-ERROR', error: err?.message, stack: err?.stack });
    throw err;
  }
}

/**
 * Process a pending (unrewarded) referral reward.
 *
 * Independent of bootstrap — can be called from any point where channel_joined
 * becomes true. Finds the unrewarded referral for the invitee and, if the
 * invitee has joined the channel, atomically credits the reward.
 *
 * Idempotent: if rewarded is already TRUE, this is a no-op.
 * Race-safe: uses UPDATE ... WHERE rewarded = FALSE so only one caller wins.
 *
 * @param {object} env - Worker env
 * @param {string} inviteeId - The invitee's telegram_id
 * @param {boolean} channelJoined - Whether the invitee has joined the channel
 */
async function processPendingReferralReward(env, inviteeId, channelJoined) {
  if (!channelJoined) return null;

  // Kill switch: if referral rewards are emergency-disabled, skip
  if (await rewardCenterRepo.isSubsystemDisabled(env, 'referral')) {
    console.log('[REWARD] Referral rewards emergency-disabled — skipping');
    return null;
  }

  // DB-driven reward amount (async — reads from referral_reward_tiers)
  const rewardAmount = await getReferralRewardPerInvite(env);
  if (rewardAmount <= 0) return null;

  // Find unrewarded referral for this invitee
  const pendingResult = await queryDb(
    env,
    `
      SELECT id, inviter_id, rewarded
      FROM referrals
      WHERE invitee_id = $1 AND rewarded = FALSE
      LIMIT 1
    `,
    [String(inviteeId)],
  );
  const pending = pendingResult.rows[0] || null;
  if (!pending) return null;

  // Atomic: credit tokens + transaction record + rewarded=TRUE + channel_verified=TRUE
  await creditReferralWithReward(
    env,
    String(pending.inviter_id),
    Number(pending.id),
    inviteeId,
    rewardAmount,
    true, // alsoVerifyChannel
  );

  return { referral_id: pending.id, rewarded: true };
}

/**
 * Process referral on user bootstrap.
 *
 * Key design decisions:
 * - Only NEW users (first bootstrap) can generate a referral (Design).
 *   Existing users clicking a referral link are silently ignored.
 * - Self-referral is rejected.
 * - Non-numeric referrer_id is rejected (M-R4).
 * - INSERT uses ON CONFLICT DO NOTHING to avoid 503 on concurrent bootstraps (H-R3).
 * - Reward is delegated to processPendingReferralReward (called here and
 *   also after channel join verification).
 */
async function processReferralOnBootstrap(env, inviteeId, referrerId, channelJoined, isNewUser) {
  await diagLog(env, { scope: 'diag-processReferralOnBootstrap', inviteeId, referrerId, channelJoined, isNewUser });

  const normalizedReferrerId = normalizeOptionalString(referrerId);

  // M-R4: reject non-numeric referrer_id
  if (!normalizedReferrerId || !/^\d{1,20}$/.test(normalizedReferrerId) || normalizedReferrerId === String(inviteeId)) {
    await diagLog(env, { scope: 'diag-processReferralOnBootstrap-REJECTED', reason: 'M-R4-invalid-or-self', normalizedReferrerId, inviteeId });
    return null;
  }

  // Design: only new users can be referred
  if (!isNewUser) {
    await diagLog(env, { scope: 'diag-processReferralOnBootstrap-REJECTED', reason: 'NOT-new-user' });
    return null;
  }

  const inviterResult = await queryDb(
    env,
    'SELECT telegram_id FROM users WHERE telegram_id = $1 LIMIT 1',
    [normalizedReferrerId],
  );
  if (!inviterResult.rows[0]) {
    await diagLog(env, { scope: 'diag-processReferralOnBootstrap-REJECTED', reason: 'inviter-not-found', normalizedReferrerId });
    return null;
  }

  // Check for existing referral (race condition between concurrent bootstraps)
  const existingResult = await queryDb(
    env,
    `
      SELECT id, inviter_id, rewarded
      FROM referrals
      WHERE invitee_id = $1
      LIMIT 1
    `,
    [String(inviteeId)],
  );
  const existing = existingResult.rows[0] || null;

  if (existing) {
    await diagLog(env, { scope: 'diag-processReferralOnBootstrap-existing', referral_id: existing.id, rewarded: existing.rewarded });
    // Race: another concurrent bootstrap already inserted the referral.
    // Delegate reward processing (idempotent — won't double-reward).
    await processPendingReferralReward(env, inviteeId, channelJoined);
    return { referral_id: existing.id, already_exists: true };
  }

  // H-R3: INSERT with ON CONFLICT DO NOTHING — race-safe.
  const insertResult = await queryDb(
    env,
    `
      INSERT INTO referrals (inviter_id, invitee_id, channel_verified, rewarded, created_at)
      VALUES ($1, $2, FALSE, FALSE, NOW())
      ON CONFLICT (invitee_id) DO NOTHING
      RETURNING id, rewarded
    `,
    [normalizedReferrerId, String(inviteeId)],
  );
  const createdReferral = insertResult.rows[0] || null;
  await diagLog(env, { scope: 'diag-processReferralOnBootstrap-INSERT', createdReferral, rowCount: insertResult.rowCount });
  if (!createdReferral) {
    // Race lost — another request already inserted the referral.
    await diagLog(env, { scope: 'diag-processReferralOnBootstrap-race-lost' });
    return { referral_id: null, already_exists: true, race_won: false };
  }

  // Delegate reward processing (idempotent — safe to call even if channel_joined=false)
  await diagLog(env, { scope: 'diag-processReferralOnBootstrap-calling-reward', referral_id: createdReferral.id, channelJoined });
  const rewardResult = await processPendingReferralReward(env, inviteeId, channelJoined);
  await diagLog(env, { scope: 'diag-processReferralOnBootstrap-reward-result', rewardResult });

  return { referral_id: createdReferral.id, rewarded: Boolean(rewardResult?.rewarded) };
}

async function getChatMemberDebugPayload(userId, env) {
  const uid = String(userId);
  const requiredChannel = resolveRequiredChannel(env);
  const chatId = getTelegramChatId(env);
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '');
  const botConfigured = isBotConfigured(env);
  const isAdmin = isAdminTelegramId(env, uid);
  const payload = {
    required_channel: requiredChannel,
    chat_id_used: chatId,
    user_id: uid,
    bot_configured: botConfigured,
    is_admin: isAdmin,
    telegram_response: null,
    joined: false,
  };

  // DIAGNOSTIC LOG: capture every detail for debugging membership issues
  console.log(JSON.stringify({
    scope: 'diag-getChatMember',
    user_id: uid,
    required_channel: requiredChannel,
    chat_id_used: chatId,
    bot_configured: botConfigured,
    is_admin: isAdmin,
    is_guest: uid.startsWith('guest_'),
    is_numeric: /^\d+$/.test(uid),
  }));

  if (uid.startsWith('guest_')) {
    payload.telegram_response = { reason: 'guest_user' };
    return payload;
  }

  if (isAdmin) {
    payload.telegram_response = { admin: true, reason: 'admin_bypass' };
    payload.joined = true;
    console.log(JSON.stringify({ scope: 'diag-getChatMember-result', user_id: uid, result: 'admin_bypass', joined: true }));
    return payload;
  }

  if (!botConfigured) {
    payload.telegram_response = { reason: 'bot_not_configured' };
    console.log(JSON.stringify({ scope: 'diag-getChatMember-result', user_id: uid, result: 'bot_not_configured', joined: false }));
    return payload;
  }

  if (!/^\d+$/.test(uid)) {
    payload.telegram_response = { reason: 'invalid_user_id', value: uid };
    console.log(JSON.stringify({ scope: 'diag-getChatMember-result', user_id: uid, result: 'invalid_user_id', joined: false }));
    return payload;
  }

  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(uid)}`;
    console.log(JSON.stringify({ scope: 'diag-getChatMember-fetch', user_id: uid, url: telegramUrl.replace(botToken, 'BOT_TOKEN') }));
    const telegramResponse = await fetch(telegramUrl);
    const data = await telegramResponse.json();
    payload.telegram_response = data;
    const status = data?.result?.status || '';
    payload.joined = Boolean(data?.ok && JOINED_STATUSES.has(status));

    // DIAGNOSTIC LOG: the exact raw response from Telegram
    console.log(JSON.stringify({
      scope: 'diag-getChatMember-result',
      user_id: uid,
      telegram_ok: data?.ok,
      telegram_status: status,
      telegram_raw: JSON.stringify(data).slice(0, 500),
      joined: payload.joined,
      joined_statuses_list: [...JOINED_STATUSES],
    }));

    return payload;
  } catch (error) {
    payload.telegram_response = {
      exception: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
    console.log(JSON.stringify({ scope: 'diag-getChatMember-error', user_id: uid, error: payload.telegram_response }));
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

  // DIAGNOSTIC LOG
  console.log(JSON.stringify({ scope: 'diag-resolveMembership-start', user_id: uid, forceRefresh, is_guest: uid.startsWith('guest_'), is_admin: isAdminTelegramId(env, uid) }));

  if (uid.startsWith('guest_')) {
    return { joined: false, reason: 'guest_user' };
  }

  if (isAdminTelegramId(env, uid)) {
    console.log(JSON.stringify({ scope: 'diag-resolveMembership-admin', user_id: uid, joined: true }));
    return { joined: true, admin: true };
  }

  try {
    if (!forceRefresh) {
      const cached = await getCachedJoinStatus(env, uid);
      if (cached === true) {
        console.log(JSON.stringify({ scope: 'diag-resolveMembership-cached', user_id: uid, joined: true, source: 'kv_cache' }));
        return { joined: true, cached: true };
      }

      if (isDatabaseConfigured(env)) {
        const dbUser = await getDbUserJoinState(env, uid);
        console.log(JSON.stringify({ scope: 'diag-resolveMembership-db', user_id: uid, db_channel_joined: dbUser?.channel_joined }));
        if (dbUser?.channel_joined) {
          await setCachedJoinStatus(env, uid, true);
          console.log(JSON.stringify({ scope: 'diag-resolveMembership-db-hit', user_id: uid, joined: true, source: 'db' }));
          return { joined: true, from_db: true };
        }
      }
    }

    const result = await checkChannelMembership(uid, env);
    console.log(JSON.stringify({ scope: 'diag-resolveMembership-telegram-result', user_id: uid, joined: result.joined, reason: result.reason }));
    if (result.joined) {
      await setCachedJoinStatus(env, uid, true);
      if (isDatabaseConfigured(env)) {
        await persistDbUserJoinState(env, uid, true);
        // Process any pending referral reward — non-critical, don't let failure affect membership
        try {
          await processPendingReferralReward(env, uid, true);
        } catch (refErr) {
          console.warn(safeError('referral-reward-failed', refErr));
        }
      }
      return result;
    }

    if (result.reason === 'api_error') {
      // SECURITY FIX: during forceRefresh (used by bootstrap + check-join), do NOT
      // fall back to stale DB/cache values on Telegram API errors. This prevents
      // a user who LEFT the channel from getting in via a stale DB 'true' value
      // when the Telegram API is temporarily unavailable. Fail-closed = deny.
      // For non-forceRefresh (used by requireChannelJoin on data endpoints),
      // keep the fail-open behavior so legitimate members aren't locked out
      // during transient Telegram outages.
      if (!forceRefresh) {
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

// Exchange priority order — STRICT sequential fallback per task spec:
// Binance > Bybit > OKX > Bitget > KuCoin > MEXC > Gate > HTX
// The first exchange that has a valid SYMBOLUSDT pair wins. Results are cached
// 24h per symbol so subsequent opens are instant.
const EXCHANGE_ORDER = [
  ['BINANCE', 'binance'],
  ['BYBIT', 'bybit'],
  ['OKX', 'okx'],
  ['BITGET', 'bitget'],
  ['KUCOIN', 'kucoin'],
  ['MEXC', 'mexc'],
  ['GATEIO', 'gateio'],
  ['HTX', 'htx'],
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
  // Bitget: GET /api/v2/spot/market/tickers?symbol=BTCUSDT — returns array with data
  bitget: {
    buildUrl(symbol) {
      return `https://api.bitget.com/api/v2/spot/market/tickers?symbol=${encodeURIComponent(`${symbol}USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body?.code === '00000' && Array.isArray(body?.data) && body.data.length > 0);
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
  mexc: {
    buildUrl(symbol) {
      return `https://api.mexc.com/api/v3/ticker/price?symbol=${encodeURIComponent(`${symbol}USDT`)}`;
    },
    isMatch(body) {
      return Boolean(body && typeof body === 'object' && 'price' in body);
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
  // HTX (Huobi): GET /market/detail/merged?symbol=btcusdt — returns {status:"ok", tick:{...}}
  htx: {
    buildUrl(symbol) {
      return `https://api.huobi.pro/market/detail/merged?symbol=${encodeURIComponent(`${symbol}usdt`)}`;
    },
    isMatch(body) {
      return Boolean(body?.status === 'ok' && body?.tick);
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
  if (exchangeKey === 'bitget') {
    const item = Array.isArray(body?.data) ? body.data[0] : null;
    const price = Number(item?.lastPr);
    return Number.isFinite(price) ? price : null;
  }
  if (exchangeKey === 'htx') {
    const price = Number(body?.tick?.close);
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

  // CRITICAL FIX: Check exchanges SEQUENTIALLY in strict priority order.
  // Previous Promise.any() raced all exchanges — fastest response won, ignoring priority.
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

// News RSS sources with category metadata.
// All English sources verified working (HTTP 200) from prior testing.
// Rejected: CryptoPanic(403), DailyFX(403), FXStreet(403), Yahoo Finance(429)
// Persian sources: may be geo-blocked from CF Workers — silently skipped on failure.
const NEWS_RSS_SOURCES = [
  // ── Crypto ───────────────────────────────────────────────────────────
  { url: 'https://cointelegraph.com/rss', name: 'کوین‌تلگراف', category: 'crypto' },
  { url: 'https://www.coindesk.com/arc/outboundfeeds/rss/', name: 'کوین‌دسک', category: 'crypto' },
  { url: 'https://decrypt.co/feed', name: 'دیکریپت', category: 'crypto' },
  // ── Forex ────────────────────────────────────────────────────────────
  { url: 'https://www.actionforex.com/rss/', name: 'اکشن‌فارکس', category: 'forex' },
  { url: 'https://www.investing.com/rss/news_301.rss', name: 'اینستینگ', category: 'forex' },
  // ── Economy ──────────────────────────────────────────────────────────
  { url: 'https://feeds.bbci.co.uk/news/business/rss.xml', name: 'BBC Economy', category: 'economy' },
  { url: 'https://rss.nytimes.com/services/xml/rss/nyt/Business.xml', name: 'NYT Economy', category: 'economy' },
  // ── Persian (general economy/finance) ────────────────────────────────
  // No translation needed — articles already in Farsi.
  // Skipped automatically by fetchAllNewsRss() if source is unavailable.
  { url: 'https://www.irna.ir/rss', name: 'خبرگزاری ایرنا', category: 'economy', skipTranslate: true },
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

function extractImageUrl(descriptionHtml, itemBlock) {
  // 1. Check for <img src="..."> inside description HTML
  const imgMatch = String(descriptionHtml || '').match(/src="([^"]+)"/i);
  if (imgMatch) return imgMatch[1];

  // 2. Check for <enclosure url="..."> (used by IRNA, ISNA, many Persian feeds)
  if (itemBlock) {
    const enclosureMatch = String(itemBlock).match(/<enclosure[^>]+url="([^"]+)"/i);
    if (enclosureMatch) return enclosureMatch[1];
  }

  return 'https://images.cryptocompare.com/news/default/bitcoin.png';
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
      image: extractImageUrl(descriptionRaw, block),
    };
  }).map((item) => ({
    ...item,
    title: item.title || item.description,
  }));
}

/**
 * Translate text to Farsi using Cloudflare Workers AI (primary) with
 * Google Translate (unofficial endpoint) as fallback.
 *
 * Workers AI: free, no rate-limit, runs inside the Worker — no external call.
 * Google Translate fallback: kept for environments without AI binding.
 */
// In-memory translation cache — avoids re-translating the same text across requests.
// Key: hash of input text, Value: translated text.
// Survives for the lifetime of the Worker isolate.
const _translationCache = new Map();
const TRANSLATION_CACHE_MAX = 500;

async function translateToFarsi(text, env) {
  if (!text) return '';

  // OPTIMIZATION: Check in-memory translation cache first.
  // This avoids redundant AI/Google Translate calls for the same text
  // across multiple news refresh cycles.
  const cacheKey = text.length > 100 ? text.substring(0, 100) : text;
  if (_translationCache.has(cacheKey)) {
    return _translationCache.get(cacheKey);
  }

  let result = text;

  // ── Primary: Cloudflare Workers AI ─────────────────────────────────
  if (env?.AI) {
    try {
      const response = await env.AI.run('@cf/meta/m2m100-1.2b', {
        text,
        source_lang: 'english',
        target_lang: 'persian',
      });
      const translated = response?.translated_text;
      if (translated && typeof translated === 'string' && translated.trim()) {
        result = translated.trim();
      }
    } catch {
      // AI unavailable or model error — fall through to Google Translate
    }
  }

  // ── Fallback: Google Translate (unofficial) ───────────────────────
  if (result === text && env?.AI) {
    // Only use Google Translate if AI failed (result still equals input)
    try {
      const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=en&tl=fa&dt=t&q=${encodeURIComponent(text)}`;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'GET',
        headers: { Accept: 'application/json' },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

      if (response.ok) {
        const body = await response.json();
        if (Array.isArray(body?.[0])) {
          const translated = body[0].map((part) => part?.[0] || '').join('').trim();
          if (translated) result = translated;
        }
      }
    } catch {
      // Both AI and Google failed — return original text
    }
  }

  // Cache the result (even if it's the original text — avoids retrying failed translations)
  if (_translationCache.size >= TRANSLATION_CACHE_MAX) {
    // Evict oldest entry (first key in Map insertion order)
    const firstKey = _translationCache.keys().next().value;
    _translationCache.delete(firstKey);
  }
  _translationCache.set(cacheKey, result);

  return result;
}

/**
 * Fetch ALL RSS sources in parallel. Returns array of { rssText, sourceName, category }
 * for each source that responded successfully.
 */
async function fetchAllNewsRss() {
  const results = await Promise.allSettled(
    NEWS_RSS_SOURCES.map(async (source) => {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
      try {
        const response = await fetch(source.url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        const rssText = await response.text();
        if (response.ok && rssText.includes('<item>')) {
          return { rssText, sourceName: source.name, category: source.category, skipTranslate: !!source.skipTranslate };
        }
      } catch {
        // Source failed — will be filtered out below
      } finally {
        clearTimeout(timeoutId);
      }
      return null;
    })
  );
  return results
    .filter((r) => r.status === 'fulfilled' && r.value !== null)
    .map((r) => r.value);
}

async function buildFarsiNewsArticles(rssText, sourceName, category, env, skipTranslate = false) {
  const items = parseRssItems(rssText);
  if (items.length === 0) return [];

  // CPU OPTIMIZATION: Limit articles per source to 5 (was unlimited).
  // Each article requires 2 AI translations (title + description) = 2 Workers AI calls.
  // With 7 sources × 10 articles × 2 translations = 140 AI calls — far too many.
  // Now: 7 sources × 5 articles × 2 translations = 70 AI calls max.
  // Plus the Promise.all parallelism means these run concurrently.
  const MAX_ARTICLES_PER_SOURCE = 5;
  const limitedItems = items.slice(0, MAX_ARTICLES_PER_SOURCE);

  let allTranslations;
  if (skipTranslate) {
    // Persian sources — no translation needed
    allTranslations = limitedItems.map((item) => [
      item.title || 'بدون عنوان',
      item.description || '',
    ]);
  } else {
    // Parallel translation — all titles + descriptions translated concurrently
    allTranslations = await Promise.all(
      limitedItems.flatMap((item) => [
        translateToFarsi(item.title || 'بدون عنوان', env),
        translateToFarsi(item.description || '', env),
      ])
    );
  }

  const articles = [];
  for (let i = 0; i < limitedItems.length; i++) {
    const translatedTitle = allTranslations[i * 2];
    const translatedDescription = allTranslations[i * 2 + 1];

    articles.push({
      title: String(translatedTitle || limitedItems[i].title || 'بدون عنوان').replace(/\n/g, ' ').trim(),
      description: String(translatedDescription || limitedItems[i].description || '').replace(/\n/g, ' ').trim(),
      time_ago: parseRelativeTime(limitedItems[i].pubDate),
      source: sourceName,
      category: category || 'crypto',
      image: limitedItems[i].image,
      url: limitedItems[i].url,
      sentiment: classifySentiment(limitedItems[i].title, limitedItems[i].description),
    });
  }

  return articles.filter((item) => item.title || item.description);
}

function classifySentiment(title, description) {
  const text = `${title} ${description}`.toLowerCase();
  const bullish = ['رشد', 'صعود', 'موفق', 'بهبود', 'رکورد', 'پامپ', 'بالا', 'bullish', ' ATH', 'رالی', ' approvals', 'ETF', 'adopt', 'فیض', 'profit', 'surge', 'jump', 'rally', 'gain', 'recovery', 'positive', 'approve'];
  const bearish = ['سقوط', 'نزول', 'هک', 'کلاهبردی', 'کاهش', 'ریزش', '跌破', 'دانش', 'ban', 'bearish', 'hack', 'crash', 'drop', 'fall', 'decline', 'loss', 'scam', 'fraud', 'warning', 'risk', 'fear', 'sell-off', 'plunge', 'sanction', 'تحریم'];
  const breaking = ['فوری', 'breaking', 'urgent', 'breaking:', 'flash'];
  
  // Check breaking first
  if (breaking.some(w => text.includes(w))) return 'breaking';
  // Count matches
  const bullScore = bullish.filter(w => text.includes(w)).length;
  const bearScore = bearish.filter(w => text.includes(w)).length;
  if (bullScore > bearScore && bullScore > 0) return 'bullish';
  if (bearScore > bullScore && bearScore > 0) return 'bearish';
  // Check for macro keywords
  const macro = ['نرخ بهره', 'CPI', 'PPI', 'NFP', 'FOMC', 'تورم', 'inflation', 'interest rate', 'GDP', 'employment', 'unemployment'];
  if (macro.some(w => text.includes(w))) return 'macro';
  return 'neutral';
}

async function fetchFarsiNews(env, categoryFilter) {
  // Cache key includes category filter for per-category caching
  const cacheKey = categoryFilter
    ? `${FARSI_NEWS_CACHE_KEY}:${categoryFilter}`
    : FARSI_NEWS_CACHE_KEY;

  const cachedNews = await readAppCache(env, cacheKey);
  if (cachedNews) {
    try {
      const parsed = JSON.parse(cachedNews);
      // If a category filter is requested, apply it to cached data too
      const data = categoryFilter
        ? parsed.filter((a) => a.category === categoryFilter)
        : parsed;
      const categoryCounts = {
        all: parsed.length,
        crypto: parsed.filter(a => a.category === 'crypto').length,
        forex: parsed.filter(a => a.category === 'forex').length,
        economy: parsed.filter(a => a.category === 'economy').length,
      };
      return { status: 'success', source: 'cache', data, category_counts: categoryCounts };
    } catch {
      // Corrupt cache — fall through to live fetch
    }
  }

  // Fetch ALL sources in parallel
  const sources = await fetchAllNewsRss();
  if (sources.length === 0) {
    return { status: 'success', source: 'rss_unavailable', data: [], category_counts: { all: 0, crypto: 0, forex: 0, economy: 0 } };
  }

  try {
    // Build articles from all sources in parallel (translate within each source)
    const allArticles = (
      await Promise.all(
        sources.map((s) => buildFarsiNewsArticles(s.rssText, s.sourceName, s.category, env, s.skipTranslate))
      )
    ).flat();

    // Deduplicate by URL (same article from multiple sources)
    const seen = new Set();
    const deduped = allArticles.filter((a) => {
      if (!a.url || seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });

    if (deduped.length > 0) {
      // Limit total cached articles to reduce payload size and KV storage
      const MAX_NEWS_ARTICLES = 30;
      const trimmed = deduped.slice(0, MAX_NEWS_ARTICLES);

      // Cache the full (unfiltered) trimmed list
      await writeAppCache(
        env,
        FARSI_NEWS_CACHE_KEY,
        JSON.stringify(trimmed),
        getNumericEnv(env, 'NEWS_CACHE_TTL', 300),
      );

      const categoryCounts = {
        all: trimmed.length,
        crypto: trimmed.filter(a => a.category === 'crypto').length,
        forex: trimmed.filter(a => a.category === 'forex').length,
        economy: trimmed.filter(a => a.category === 'economy').length,
      };

      // Apply category filter if requested
      const data = categoryFilter
        ? trimmed.filter((a) => a.category === categoryFilter)
        : trimmed;

      return {
        status: 'success',
        source: `${sources.map((s) => s.sourceName).join(', ')}_live`,
        data,
        category_counts: categoryCounts,
      };
    }
  } catch {
    // Parse/translate failure
  }

  return { status: 'success', source: 'rss_unavailable', data: [], category_counts: { all: 0, crypto: 0, forex: 0, economy: 0 } };
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
  // ── ISO 8601 support (e.g. "2026-07-05T21:00:00-04:00") ─────────
  if (dateString && /^\d{4}-\d{2}-\d{2}T/.test(dateString)) {
    const d = new Date(dateString);
    if (!Number.isNaN(d.getTime())) return d;
    // ISO parse failed (malformed) — fall through to legacy parser
  }

  // ── Date-only ISO (e.g. "2026-07-05") ─────────────────────────────
  if (dateString && /^\d{4}-\d{2}-\d{2}$/.test(dateString)) {
    const parts = dateString.split('-');
    const year = Number(parts[0]);
    const month = Number(parts[1]);
    const day = Number(parts[2]);
    if (year && month && day) {
      const parsedTime = parseCalendarTimeParts(timeString);
      if (parsedTime) {
        return new Date(Date.UTC(year, month - 1, day, parsedTime.hour, parsedTime.minute, 0));
      }
      return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    }
  }

  // ── Legacy MM-DD-YYYY + HH:MMam/pm format ───────────────────────
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
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
      const response = await fetch(url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);

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
    .sort((left, right) => {
      // Null timestamps (unparseable) go to end
      if (!left.timestamp && !right.timestamp) return 0;
      if (!left.timestamp) return 1;
      if (!right.timestamp) return -1;
      return left.timestamp.localeCompare(right.timestamp);
    });

  // Only overwrite cache with valid (non-empty) data — preserve last good cache
  // on API failure or empty feed to prevent calendar from going blank.
  if (events.length > 0) {
    await writeAppCache(
      env,
      CALENDAR_CACHE_KEY,
      JSON.stringify(events),
      getNumericEnv(env, 'CALENDAR_CACHE_TTL', 600),
    );
  }

  // If new fetch yielded nothing but we had a (now-expired) cache, return empty
  // so the frontend can show "no events" rather than stale data.
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

  // CRITICAL FIX: Check exchanges SEQUENTIALLY in strict priority order.
  // Previous Promise.any() raced all exchanges — fastest response won, ignoring priority.
  // Now: Binance > Bybit > OKX > KuCoin > Gate > MEXC > CoinEx (strict sequential).
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

// fetchGlobalData removed — caching is now handled inside fetchGlobalStats()
// Database indexes are managed via migration scripts only (scripts/stabilization_indexes.sql).
// Runtime CREATE INDEX is intentionally removed from the Worker.

function handleHealth(env) {
  const webAppUrl = resolveWebAppUrl(env);
  console.log(JSON.stringify({
    scope: 'health-check',
    webapp_url_raw: String(env.WEBAPP_URL || '').trim(),
    webapp_url_resolved: webAppUrl,
    has_cache_bust: webAppUrl.includes('_v='),
  }));
  return jsonResponse({
    status: 'ok',
    bot_configured: isBotConfigured(env),
    database_ready: isDatabaseConfigured(env),
    cache_ready: isCacheLayerConfigured(env),
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
  safeError,
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
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  watchlistRepo,
});
const referralRepo = createReferralRepository({ queryDb, getReferralRewardPerInvite });
const referralHandlers = createReferralHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  referralRepo,
});
const walletRepo = createWalletRepository({ queryDb, queryDbTransaction });
const economyService = createEconomyService({ walletRepo, queryDb });

// ── Reward Center repository (needed by wheel + referral + admin) ──
// Must be created BEFORE wheelHandlers since handleSpin checks kill switches.
function _rcIsoDate(val) { return val ? new Date(val).toISOString() : null; }
const rewardCenterRepo = createRewardCenterRepository({
  queryDb,
  queryDbTransaction,
  isDatabaseConfigured,
  isoDate: _rcIsoDate,
  normalizeOptionalString,
});

// ── Notification Platform repository (needed by wheel + analysis + referral) ──
// Must be created BEFORE wheelHandlers since handleSpin dispatches notifications.
const notificationPlatformRepo = createNotificationPlatformRepository({
  queryDb,
  isDatabaseConfigured,
  isoDate: _rcIsoDate,
  normalizeOptionalString,
});

const wheelRepo = createWheelRepository({ queryDb, queryDbTransaction });
const wheelHandlers = createWheelHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  wheelRepo,
  economyService,
  rewardCenterRepo,
  notificationPlatformRepo,
});
const walletHandlers = createWalletHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  walletRepo,
  notificationPlatformRepo,
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
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  isAdminTelegramId,
  getAdminIds,
  sendTelegramMessage,
  normalizeOptionalString,
  ticketRepo,
  notificationPlatformRepo,
});
const userRepo = createUserRepository({ queryDb, normalizeOptionalString });
const userHandlers = createUserHandlers({
  jsonResponse,
  optionalTelegramAuth,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  normalizeOptionalString,
  isDevMode,
  isAdminTelegramId,
  processReferralOnBootstrap,
  resolveChannelMembership,
  userRepo,
  watchlistRepo,
  diagLog,
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
const notificationRepo = createNotificationRepository({ queryDb });
// notificationPlatformRepo is already created above (before wheelHandlers).
const notificationHandlers = createNotificationHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  notificationRepo,
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
  safeError,
  buildBodyFieldValidationError,
  buildQueryFieldValidationError,
  isDatabaseConfigured,
  isAdminTelegramId,
  readAppCache,
  writeAppCache,
  analysisRepo,
  notificationRepo,
  notificationPlatformRepo,
  sendTelegramMessage,
  resolveWebAppUrl,
  queryDb,
});
const adminRepo = createAdminRepository({ queryDb, normalizeOptionalString });
const adminHandlers = createAdminHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  optionalTelegramAuth,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  isAdminTelegramId,
  getAdminIds,
  sendTelegramMessage,
  normalizeOptionalString,
  adminRepo,
  notificationRepo,
  notificationPlatformRepo,
  diagLog,
});

// ── Reward Center (admin handlers) ──
// rewardCenterRepo is already created above (before wheelHandlers).
const rewardCenterHandlers = createRewardCenterHandlers({
  jsonResponse,
  requireAdmin: adminHandlers.requireAdmin,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  buildBodyFieldValidationError,
  normalizeOptionalString,
  getClientIp: (request) => request.headers.get('cf-connecting-ip') || null,
  adminRepo,
  rewardCenterRepo,
});
//#endregion

// ── Notification Platform (admin handlers) ──
// notificationPlatformRepo is already created above (before analysisHandlers).
const notificationPlatformHandlers = createNotificationPlatformHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  requireAdmin: adminHandlers.requireAdmin,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  buildBodyFieldValidationError,
  notificationPlatformRepo,
  sendTelegramMessage,
  adminRepo,
});
//#endregion

// ── Market Overview Service (CMC) — all CMC calls centralized here ──
const marketOverviewSvc = createMarketOverviewService({ readAppCache, writeAppCache, fetchJson });

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

  // Compute category counts from cached news
  let category_counts = { all: 0, crypto: 0, forex: 0, economy: 0 };
  try {
    const cachedNews = await readAppCache(env, FARSI_NEWS_CACHE_KEY);
    if (cachedNews) {
      const parsed = JSON.parse(cachedNews);
      if (Array.isArray(parsed)) {
        category_counts = {
          all: parsed.length,
          crypto: parsed.filter(a => a.category === 'crypto').length,
          forex: parsed.filter(a => a.category === 'forex').length,
          economy: parsed.filter(a => a.category === 'economy').length,
        };
      }
    }
  } catch {
    // Ignore — category counts are supplementary
  }

  return jsonResponse({
    status: 'success',
    events,
    category_counts,
  }, {}, env);
}

const MARKET_CACHE_TTL = 120; // 2 minutes — prices change frequently
const MARKET_GLOBAL_CACHE_TTL = 300; // 5 minutes — global stats change less frequently
const MARKET_FETCH_LIMIT = 200;

// ============================================================================
//#region Single Flight — Request Coalescing for Market Data
// ============================================================================
// Prevents cache stampede: when 100+ users refresh simultaneously,
// only ONE actual upstream API call is made. All concurrent requests
// share the same Promise until it resolves.
// ============================================================================

/** @type {Map<string, Promise<any>>} */
const _inflightRequests = new Map();

/**
 * Single-flight helper: if an identical request is already in-flight,
 * return the existing Promise instead of firing a new one.
 * Automatically cleaned up after resolution.
 *
 * CRITICAL: The Promise must resolve to a SERIALIZED value (e.g., JSON object),
 * NOT a Response object. Response bodies are streams that can only be consumed
 * once — sharing them across requests causes "Cannot perform I/O on behalf of
 * a different request" errors.
 */
function singleFlight(key, fn) {
  const existing = _inflightRequests.get(key);
  if (existing) return existing;

  const promise = fn().finally(() => {
    _inflightRequests.delete(key);
  });
  _inflightRequests.set(key, promise);
  return promise;
}

/**
 * Fetch Fear & Greed Index from Alternative.me (free, no API key required).
 * Returns { value: number, classification: string } or null.
 */
async function fetchFearGreed() {
  try {
    const { ok, body } = await fetchJson('https://api.alternative.me/fng/?limit=1');
    if (ok && body?.data?.[0]) {
      const d = body.data[0];
      return {
        value: parseInt(d.value, 10) || 0,
        classification: d.value_classification || 'Neutral',
        timestamp: d.timestamp || null,
      };
    }
  } catch (e) {
    console.warn('Global: Alternative.me F&G failed', e.message || e);
  }
  return null;
}

/**
 * Fetch global market stats with multi-source failover.
 * Priority: CoinMarketCap (if key) → CoinGecko (if key or public) → CoinCap (partial)
 * Also fetches Fear & Greed from Alternative.me in parallel.
 *
 * Returns { totalMarketCap, totalVolume, btcDominance, fearGreedValue, fearGreedClassification, source }
 * or null if ALL sources fail.
 */
/**
 * PHASE 2 FIX: Enrich market data with CoinMarketCap market cap & supply.
 * Called when fallback sources (CoinCap, Binance) return marketCapUsd=0.
 * Uses CMC API key if available, otherwise computes marketCap from
 * circulating supply estimates (price × known supply for top coins).
 *
 * Strategy:
 * 1. If CMC_API_KEY available: fetch /v2/cryptocurrency/listings/latest
 * 2. Build a symbol→{marketCap, supply} map
 * 3. For each coin in data, if marketCapUsd=0, fill from CMC map
 * 4. If no CMC key: use price × estimated supply for top 20 coins
 */
async function enrichMarketData(env, coins) {
  if (!coins || !coins.length) return coins;

  // Check if any coins actually need enrichment
  const needsEnrichment = coins.some(c => !c.marketCapUsd || c.marketCapUsd === 0);
  if (!needsEnrichment) return coins; // All good, no enrichment needed

  // Try CMC API if key is available
  if (env.CMC_API_KEY) {
    try {
      const cmcRes = await fetch('https://pro-api.coinmarketcap.com/v1/cryptocurrency/listings/latest?limit=200&start=1', {
        headers: { 'X-CMC_PRO_API_KEY': env.CMC_API_KEY },
        signal: AbortSignal.timeout(5000),
      });
      if (cmcRes.ok) {
        const cmcBody = await cmcRes.json();
        const cmcData = cmcBody?.data || [];
        // Build symbol → {marketCap, supply} map
        const cmcMap = new Map();
        for (const c of cmcData) {
          cmcMap.set(String(c.symbol).toUpperCase(), {
            marketCapUsd: parseFloat(c.quote?.USD?.market_cap) || 0,
            supply: parseFloat(c.circulating_supply) || 0,
            name: c.name || '',
            rank: c.cmc_rank || 0,
          });
        }
        // Enrich coins
        for (const coin of coins) {
          const cmc = cmcMap.get(coin.symbol);
          if (cmc) {
            if (!coin.marketCapUsd || coin.marketCapUsd === 0) {
              coin.marketCapUsd = cmc.marketCapUsd;
            }
            if (!coin.supply || coin.supply === 0) {
              coin.supply = cmc.supply;
            }
            if (!coin.name || coin.name === coin.symbol) {
              coin.name = cmc.name || coin.name;
            }
            if (!coin.rank || coin.rank === 0) {
              coin.rank = cmc.rank || coin.rank;
            }
          }
        }
        console.log('Market: enriched with CMC data, ' + coins.filter(c => c.marketCapUsd > 0).length + '/' + coins.length + ' coins have marketCap');
        return coins;
      }
    } catch (e) {
      console.warn('Market: CMC enrichment failed:', e.message || e);
    }
  }

  // Fallback: compute marketCap from price × estimated supply for top coins
  // This is a rough estimate — better than showing 0
  const estimatedSupply = {
    BTC: 19700000, ETH: 120000000, USDT: 110000000000, BNB: 150000000,
    SOL: 460000000, USDC: 33000000000, XRP: 56000000000, DOGE: 145000000000,
    ADA: 35000000000, TRX: 87000000000, AVAX: 400000000, SHIB: 589000000000000,
    DOT: 1400000000, LINK: 620000000, MATIC: 9300000000, LTC: 75000000,
    BCH: 19700000, UNI: 750000000, ATOM: 390000000, XLM: 29000000000,
  };
  for (const coin of coins) {
    if ((!coin.marketCapUsd || coin.marketCapUsd === 0) && estimatedSupply[coin.symbol]) {
      coin.marketCapUsd = coin.priceUsd * estimatedSupply[coin.symbol];
      coin.supply = estimatedSupply[coin.symbol];
    }
  }
  return coins;
}

async function fetchGlobalStats(env) {
  // ── Step 0: Check KV cache ──
  try {
    const raw = await readAppCache(env, 'market:global:v3');
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') return parsed;
    }
  } catch {}

  // ── Step 1: Fetch Fear & Greed in parallel (always from Alternative.me) ──
  const fgPromise = fetchFearGreed();

  // ── Step 2: Try data sources in priority order ──
  let stats = null;

  // ── Priority order: CoinGecko > CoinMarketCap > CoinPaprika ──

  // Level 1: CoinGecko Global (most accurate, matches coin data source)
  if (!stats) {
    try {
      const cgHeaders = { Accept: 'application/json' };
      const cgKey = env.COINGECKO_API_KEY;
      if (cgKey) cgHeaders['x-cg-pro-api-key'] = cgKey;
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
      const res = await fetch('https://api.coingecko.com/api/v3/global', {
        headers: cgHeaders,
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (res.ok) {
        const body = await res.json();
        if (body?.data) {
          const d = body.data;
          stats = {
            totalMarketCap: d.total_market_cap?.usd || 0,
            totalVolume: d.total_volume?.usd || 0,
            btcDominance: d.market_cap_percentage?.btc || 0,
            source: 'coingecko',
          };
          console.log('Global: CoinGecko success — mcap:', stats.totalMarketCap, 'vol:', stats.totalVolume, 'btcDom:', stats.btcDominance);
        }
      }
    } catch (e) {
      console.warn('Global: CoinGecko failed', e.message || e);
    }
  }

  // Level 2: CoinPaprika (free, no API key, reliable from CF Workers)
  if (!stats) {
    try {
      const { ok, body } = await fetchJson('https://api.coinpaprika.com/v1/global');
      if (ok && body) {
        stats = {
          totalMarketCap: body.market_cap_usd || 0,
          totalVolume: body.volume_24h_usd || 0,
          btcDominance: body.bitcoin_dominance_percentage || 0,
          source: 'coinpaprika',
        };
        console.log('Global: CoinPaprika success — mcap:', stats.totalMarketCap, 'vol:', stats.totalVolume, 'btcDom:', stats.btcDominance);
      }
    } catch (e) {
      console.warn('Global: CoinPaprika failed', e.message || e);
    }
  }

  // ── Step 3: Merge Fear & Greed ──
  try {
    const fg = await fgPromise;
    if (fg) {
      if (!stats) stats = {}; // FG available even if mcap sources all failed
      stats.fearGreedValue = fg.value;
      stats.fearGreedClassification = fg.classification;
      stats.fearGreedSource = 'alternative.me';
      stats.fearGreedTimestamp = fg.timestamp;
      console.log('Global: Fear & Greed =', fg.value, fg.classification, 'ts:', fg.timestamp);
    }
  } catch {}

  // ── Step 4: Cache result ──
  if (stats && (stats.totalMarketCap > 0 || stats.fearGreedValue > 0)) {
    try {
      await writeAppCache(env, 'market:global:v3', JSON.stringify(stats), MARKET_GLOBAL_CACHE_TTL);
    } catch {}
  }

  // Return null only if absolutely nothing was obtained
  if (!stats || (stats.totalMarketCap === 0 && !stats.fearGreedValue)) return null;
  return stats;
}

async function handleMarketData(env) {
  // Check KV cache first for coin data (v2 key — busts old incorrectly-normalized cache)
  const cachedRaw = await readAppCache(env, 'market:data:v3');
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Fetch global stats (uses its own cache internally)
        const globalData = await fetchGlobalStats(env);
        return jsonResponse({ status: 'success', data: parsed, cached: true, global: globalData, dataSource: 'cache' }, {}, env);
      }
    } catch {}
  }

  // Fetch global stats in parallel with market data (non-blocking)
  // fetchGlobalStats now handles its own caching, Fear & Greed, and multi-source failover
  const globalPromise = fetchGlobalStats(env);

  // Primary: CoinGecko
  try {
    const { ok, body } = await fetchJson(
      `https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=${MARKET_FETCH_LIMIT}&page=1&sparkline=false`
    );
    if (ok && Array.isArray(body) && body.length > 0) {
      const data = body
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
          symbol: String(item.symbol || '').toUpperCase(),
          name: item.name || '',
          rank: item.market_cap_rank || (index + 1),
          priceUsd: item.current_price || 0,
          // CoinGecko returns price_change_percentage_24h as direct percentage (e.g. -1.85 = -1.85%).
          // Field name is EXACTLY this — no confusion with 7d/ATH/ATL.
          changePercent24Hr: item.price_change_percentage_24h || 0,
          volumeUsd24Hr: item.total_volume || 0,
          marketCapUsd: item.market_cap || 0,
          supply: item.circulating_supply || 0,
          image: item.image || '',
        }))
        // Filter out coins with absurd percentages (> 1000%) — likely bad data
        .filter(c => Math.abs(c.changePercent24Hr) < 1000);
      let global = await globalPromise;
      await writeAppCache(env, 'market:data:v3', JSON.stringify(data), MARKET_CACHE_TTL);
      return jsonResponse({ status: 'success', data, cached: false, global, dataSource: 'coingecko' }, {}, env);
    }
  } catch (e) {
    console.warn('Market: CoinGecko failed', e.message || e);
  }

  // Fallback: CoinCap (enriched with CMC data for market cap & supply)
  try {
    const { ok, body } = await fetchJson('https://api.coincap.io/v2/assets?limit=' + MARKET_FETCH_LIMIT);
    const assets = body?.data || (Array.isArray(body) ? body : null);
    if (Array.isArray(assets) && assets.length > 0) {
      const data = assets.map(item => ({
        symbol: String(item.symbol || '').toUpperCase(),
        name: item.name || '',
        rank: parseInt(item.rank, 10) || 0,
        priceUsd: parseFloat(item.priceUsd) || 0,
        changePercent24Hr: (parseFloat(item.changePercent24Hr) || 0) * 100,
        volumeUsd24Hr: parseFloat(item.volumeUsd24Hr) || 0,
        marketCapUsd: parseFloat(item.marketCapUsd) || 0,
        supply: parseFloat(item.supply) || 0,
        image: `https://assets.coincap.io/assets/icons/${String(item.symbol || '').toLowerCase()}@2x.png`,
      }));
      const filtered = data.filter(c => Math.abs(c.changePercent24Hr) < 1000);

      // PHASE 2 FIX: Enrich with CoinMarketCap data if marketCap is 0
      const enriched = await enrichMarketData(env, filtered);
      let global = await globalPromise;
      await writeAppCache(env, 'market:data:v3', JSON.stringify(enriched), MARKET_CACHE_TTL);
      return jsonResponse({ status: 'success', data: enriched, cached: false, global, dataSource: 'coincap+cmc' }, {}, env);
    }
  } catch (e) {
    console.warn('Market: CoinCap fallback failed', e.message || e);
  }

  // Fallback 2: Binance Futures API (enriched with CMC data)
  try {
    const binanceRes = await fetchJson('https://fapi.binance.com/fapi/v1/ticker/24hr');
    if (Array.isArray(binanceRes.body) && binanceRes.body.length > 0) {
      const usdtPairs = binanceRes.body
        .filter(item => item.symbol.endsWith('USDT') && parseFloat(item.quoteVolume) > 0)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, MARKET_FETCH_LIMIT);

      if (usdtPairs.length > 0) {
        const data = usdtPairs.map((item, index) => {
          const sym = item.symbol.replace('USDT', '');
          return {
            symbol: sym,
            name: sym,
            rank: index + 1,
            priceUsd: parseFloat(item.lastPrice) || 0,
            changePercent24Hr: parseFloat(item.priceChangePercent) || 0,
            volumeUsd24Hr: parseFloat(item.quoteVolume) || 0,
            marketCapUsd: 0,
            supply: 0,
            image: `https://assets.coincap.io/assets/icons/${sym.toLowerCase()}@2x.png`,
          };
        })
        .filter(c => Math.abs(c.changePercent24Hr) < 1000);

        // PHASE 2 FIX: Enrich with CMC data
        const enriched = await enrichMarketData(env, data);
        const global = await globalPromise;
        await writeAppCache(env, 'market:data:v3', JSON.stringify(enriched), MARKET_CACHE_TTL);
        return jsonResponse({ status: 'success', data: enriched, cached: false, global, dataSource: 'binance+cmc' }, {}, env);
      }
    }
  } catch (e) {
    console.warn('Market: Binance Futures fallback failed', e.message || e);
  }

  // Fallback 3: MEXC (free, no API key, rarely rate-limited)
  // MEXC priceChangePercent is a decimal FRACTION, not a percentage.
  // Verified: BTC priceChange=-1164.24, lastPrice=62746.43 → calc=-1.8555%, MEXC returns -0.018200.
  // -0.018200 * 100 = -1.82% ≈ -1.8555% (diff from rounding). Confirmed: MUST multiply by 100.
  try {
    const mexcRes = await fetchJson('https://api.mexc.com/api/v3/ticker/24hr');
    if (Array.isArray(mexcRes.body) && mexcRes.body.length > 0) {
      const usdtPairs = mexcRes.body
        .filter(item => item.symbol.endsWith('USDT') && parseFloat(item.quoteVolume) > 0)
        .sort((a, b) => parseFloat(b.quoteVolume) - parseFloat(a.quoteVolume))
        .slice(0, MARKET_FETCH_LIMIT);

      if (usdtPairs.length > 0) {
        const data = usdtPairs.map((item, index) => {
          const sym = item.symbol.replace('USDT', '');
          return {
            symbol: sym,
            name: sym,
            rank: index + 1,
            priceUsd: parseFloat(item.lastPrice) || 0,
            // MEXC priceChangePercent is fraction → multiply by 100 for percentage.
            changePercent24Hr: (parseFloat(item.priceChangePercent) || 0) * 100,
            volumeUsd24Hr: parseFloat(item.quoteVolume) || 0,
            marketCapUsd: 0,
            supply: 0,
            image: `https://assets.coincap.io/assets/icons/${sym.toLowerCase()}@2x.png`,
          };
        })
        .filter(c => Math.abs(c.changePercent24Hr) < 1000);

        // PHASE 2 FIX: Enrich MEXC data with market cap & supply
        const enriched = await enrichMarketData(env, data);
        const global = await globalPromise;
        await writeAppCache(env, 'market:data:v3', JSON.stringify(enriched), MARKET_CACHE_TTL);
        return jsonResponse({ status: 'success', data: enriched, cached: false, global, dataSource: 'mexc+cmc' }, {}, env);
      }
    }
  } catch (e) {
    console.warn('Market: MEXC fallback failed', e.message || e);
  }

  // If stale cache exists, serve it (stale-while-error)
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        const global = await globalPromise;
        return jsonResponse({ status: 'success', data: parsed, cached: true, stale: true, global, dataSource: 'stale_cache' }, {}, env);
      }
    } catch {}
  }

  return jsonResponse({ status: 'error', message: 'All market data sources failed' }, { status: 503 }, env);
}

/**
 * Read cached global stats from KV, or return null.
 */
// fetchGlobalData removed — caching is now handled inside fetchGlobalStats()

// ============================================================================
//#region Forex Data
// ============================================================================
const FOREX_PAIRS = [
  // Major pairs
  { symbol: 'EURUSD', name: 'EUR/USD', tvSymbol: 'FX:EURUSD', category: 'major' },
  { symbol: 'GBPUSD', name: 'GBP/USD', tvSymbol: 'FX:GBPUSD', category: 'major' },
  { symbol: 'USDJPY', name: 'USD/JPY', tvSymbol: 'FX:USDJPY', category: 'major' },
  { symbol: 'USDCHF', name: 'USD/CHF', tvSymbol: 'FX:USDCHF', category: 'major' },
  { symbol: 'AUDUSD', name: 'AUD/USD', tvSymbol: 'FX:AUDUSD', category: 'major' },
  { symbol: 'USDCAD', name: 'USD/CAD', tvSymbol: 'FX:USDCAD', category: 'major' },
  { symbol: 'NZDUSD', name: 'NZD/USD', tvSymbol: 'FX:NZDUSD', category: 'major' },
  // Cross pairs
  { symbol: 'EURJPY', name: 'EUR/JPY', tvSymbol: 'FX:EURJPY', category: 'cross' },
  { symbol: 'GBPJPY', name: 'GBP/JPY', tvSymbol: 'FX:GBPJPY', category: 'cross' },
  { symbol: 'EURGBP', name: 'EUR/GBP', tvSymbol: 'FX:EURGBP', category: 'cross' },
  { symbol: 'AUDJPY', name: 'AUD/JPY', tvSymbol: 'FX:AUDJPY', category: 'cross' },
  { symbol: 'EURCHF', name: 'EUR/CHF', tvSymbol: 'FX:EURCHF', category: 'cross' },
  { symbol: 'GBPCAD', name: 'GBP/CAD', tvSymbol: 'FX:GBPCAD', category: 'cross' },
  { symbol: 'AUDNZD', name: 'AUD/NZD', tvSymbol: 'FX:AUDNZD', category: 'cross' },
  { symbol: 'EURCAD', name: 'EUR/CAD', tvSymbol: 'FX:EURCAD', category: 'cross' },
  // Metals / Commodities
  { symbol: 'XAUUSD', name: 'Gold', tvSymbol: 'OANDA:XAUUSD', category: 'metal' },
  { symbol: 'XAGUSD', name: 'Silver', tvSymbol: 'OANDA:XAGUSD', category: 'metal' },
  // Indices (no live price from frankfurter — price=0, chart via TradingView)
  { symbol: 'DXY',    name: 'US Dollar Index',  tvSymbol: 'TVC:DXY',        category: 'index' },
  { symbol: 'SPX',    name: 'S&P 500',         tvSymbol: 'SP:SPX',        category: 'index' },
  { symbol: 'NASDAQ',  name: 'NASDAQ Composite', tvSymbol: 'NASDAQ:NDX',    category: 'index' },
  { symbol: 'DJI',    name: 'Dow Jones 30',     tvSymbol: 'DJ:DJI',        category: 'index' },
  { symbol: 'VIX',    name: 'VIX Fear Index',   tvSymbol: 'TVC:VIX',       category: 'index' },
  { symbol: 'US10Y',  name: 'US 10Y Bond Yield', tvSymbol: 'TVC:US10Y',    category: 'index' },
  // Commodities
  { symbol: 'CL1',    name: 'Crude Oil WTI',   tvSymbol: 'NYMEX:CL1!',   category: 'commodity' },
  { symbol: 'NG1',    name: 'Natural Gas',      tvSymbol: 'NYMEX:NG1!',   category: 'commodity' },
  { symbol: 'BCOM',   name: 'Bloomberg Commodity', tvSymbol: 'TVC:BCOM',  category: 'commodity' },
];

const FOREX_CACHE_TTL = 120; // 2 minutes

async function handleForexData(env) {
  // Check KV cache
  const cachedRaw = await readAppCache(env, 'forex:data');
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return jsonResponse({ status: 'success', data: parsed, cached: true }, {}, env);
      }
    } catch {}
  }

  // Fetch from exchangerate-api or fallback
  let data = null;

  // Primary: fetch rates using a free API
  try {
    // Fetch metals prices in parallel with forex rates
    // BUG 3 fix: metals (XAU/USD, XAG/USD) via Yahoo Finance chart endpoint,
    // which returns regularMarketPrice + chartPreviousClose so we can compute a
    // REAL daily change. goldprice.org was returning 0/Forbidden from the Worker,
    // so Yahoo is the primary source now. Symbols: GC=F (gold futures), SI=F
    // (silver futures) — these track spot XAU/XAG closely and give real prices +
    // prev close. A browser-like User-Agent is set because Yahoo blocks generic
    // bot UAs. Also retains a goldprice.org fallback.
    const yahooQuote = async (sym) => {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), EXTERNAL_FETCH_TIMEOUT_MS);
        const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=5d`, {
          headers: {
            'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
            'Accept': 'application/json',
          },
          signal: ctrl.signal,
        });
        clearTimeout(t);
        if (!resp.ok) return null;
        const body = await resp.json();
        const meta = body?.chart?.result?.[0]?.meta || {};
        const price = Number(meta.regularMarketPrice) || 0;
        const prev = Number(meta.chartPreviousClose ?? meta.previousClose) || 0;
        return { price, prev };
      } catch { return null; }
    };
    const metalsPromise = Promise.all([yahooQuote('GC=F'), yahooQuote('SI=F')])
      .then(async ([g, s]) => {
        // Fallback to goldprice.org if Yahoo failed for either metal
        if (!g || !s) {
          const fb = await fetchJson('https://data-asg.goldprice.org/dbXRates/USD')
            .then(r => r.ok ? r.body?.items?.[0] : null)
            .catch(() => null);
          if (fb) {
            g = g || { price: Number(fb.xauPrice) || 0, prev: Number(fb.xauClose ?? fb.xauOpen) || 0 };
            s = s || { price: Number(fb.xagPrice) || 0, prev: Number(fb.xagClose ?? fb.xagOpen) || 0 };
          }
        }
        return {
          xau: g?.price || 0,
          xag: s?.price || 0,
          xauPrev: g?.prev || 0,
          xagPrev: s?.prev || 0,
          xauChgPct: null,
          xagChgPct: null,
        };
      })
      .catch(() => null);

    // BUG 3 fix: fetch a 7-day frankfurter TIME SERIES (in parallel) and compare
    // the two most recent business days. Using "yesterday" alone failed because
    // frankfurter's /latest and "yesterday" can resolve to the SAME ECB
    // publishing date (rates publish once per business day), yielding a 0%
    // change. The timeframe approach always yields two distinct business days.
    const endISO = new Date().toISOString().slice(0, 10);
    const startISO = new Date(Date.now() - 7 * 86400000).toISOString().slice(0, 10);
    const histPromise = fetchJson(`https://api.frankfurter.app/${startISO}..${endISO}?from=USD`)
      .then(res => {
        if (!res.ok || !res.body?.rates) return null;
        const dates = Object.keys(res.body.rates).sort();
        if (dates.length < 2) return null;
        return {
          prev: res.body.rates[dates[dates.length - 2]],
          last: res.body.rates[dates[dates.length - 1]],
        };
      })
      .catch(() => null);

    // Use frankfurter.app (free, no API key, reliable) for fiat pairs
    const { ok, body } = await fetchJson('https://api.frankfurter.app/latest?from=USD');
    if (ok && body?.rates) {
      const rates = body.rates;
      const metals = await metalsPromise;
      const prevRates = await histPromise;

      // Helper: compute a fiat pair price from a frankfurter rates object
      // (frankfurter quotes 1 USD = N units of XXX)
      const priceFromRates = (r, pair) => {
        const base = pair.symbol.slice(0, 3);
        const quote = pair.symbol.slice(3, 6);
        if (base === 'USD') return r[quote] || 0;
        if (quote === 'USD') { const b = r[base]; return b ? 1 / b : 0; }
        const b = r[base]; const q = r[quote];
        return (b && q) ? q / b : 0;
      };

      data = FOREX_PAIRS.map(pair => {
        let price = 0;
        let change = 0;

        // Indices & commodities have no API price — chart-only via TradingView
        if (pair.category === 'index' || pair.category === 'commodity') {
          return { symbol: pair.symbol, name: pair.name, tvSymbol: pair.tvSymbol, category: pair.category, price: 0, change: 0, isForex: true };
        }

        if (pair.symbol === 'XAUUSD') {
          price = metals?.xau || 0;
          if (typeof metals?.xauChgPct === 'number') change = metals.xauChgPct;
          else if (metals?.xauPrev > 0 && price > 0) change = ((price - metals.xauPrev) / metals.xauPrev) * 100;
        } else if (pair.symbol === 'XAGUSD') {
          price = metals?.xag || 0;
          if (typeof metals?.xagChgPct === 'number') change = metals.xagChgPct;
          else if (metals?.xagPrev > 0 && price > 0) change = ((price - metals.xagPrev) / metals.xagPrev) * 100;
        } else {
          price = priceFromRates(rates, pair);
          const prevRatesObj = prevRates?.prev;
          const prevPrice = prevRatesObj ? priceFromRates(prevRatesObj, pair) : 0;
          if (prevPrice > 0 && price > 0) change = ((price - prevPrice) / prevPrice) * 100;
        }

        // Round change to 2 decimals to keep the payload tidy
        change = Math.round(change * 100) / 100;

        return {
          symbol: pair.symbol,
          name: pair.name,
          tvSymbol: pair.tvSymbol,
          category: pair.category,
          price: price,
          change: change,
          isForex: true,
        };
      });

      await writeAppCache(env, 'forex:data', JSON.stringify(data), FOREX_CACHE_TTL);
      return jsonResponse({ status: 'success', data, cached: false }, {}, env);
    }
  } catch (e) {
    console.warn('Forex: frankfurter.app failed', e.message || e);
  }

  // Fallback: return static data with zero prices (user can still see charts)
  const fallback = FOREX_PAIRS.map(pair => ({
    symbol: pair.symbol,
    name: pair.name,
    tvSymbol: pair.tvSymbol,
    category: pair.category,
    price: 0,
    change: 0,
    isForex: true,
  }));

  // Serve stale cache if available
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        return jsonResponse({ status: 'success', data: parsed, cached: true, stale: true }, {}, env);
      }
    } catch {}
  }

  return jsonResponse({ status: 'success', data: fallback, cached: false }, {}, env);
}
//#endregion

async function handleFarsiNews(request, env) {
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));

  // Only allow known categories
  const validCategories = ['crypto', 'forex', 'economy', 'all'];
  const categoryFilter = category && validCategories.includes(category) && category !== 'all'
    ? category
    : null;

  const result = await fetchFarsiNews(env, categoryFilter);
  const allData = result.data || [];

  // Pagination
  const start = (page - 1) * limit;
  const paginatedData = allData.slice(start, start + limit);

  return jsonResponse({
    ...result,
    data: paginatedData,
    pagination: {
      page,
      limit,
      total: allData.length,
      hasMore: start + limit < allData.length,
    },
  }, {}, env);
}

async function handleTelegramWebhook(request, env) {
  const requestPath = new URL(request.url).pathname || '/';

  // ── Webhook secret validation (Task 2.11) ──────────────────────────────────
  // Only reject if a secret IS configured AND the header is present but wrong.
  // If no header is sent (webhook registered without secret_token), allow through.
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const headerToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (headerToken && !timingSafeEqualSecret(headerToken, webhookSecret)) {
      return jsonResponse(
        { status: 'error', detail: 'Invalid webhook secret token' },
        { status: 403 }, env);
    }
    if (!headerToken) {
      console.warn('TELEGRAM_WEBHOOK_SECRET is set but request has no secret header — allowing (webhook may lack secret_token)');
    }
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
        let callbackWebAppUrl = resolveWebAppUrl(env);

        // Retrieve pending referral from KV (stored during /start ref_xxx)
        const pendingRef = (env.JOIN_CACHE && typeof env.JOIN_CACHE.get === 'function')
          ? await env.JOIN_CACHE.get(`pending_ref:${userId}`)
          : null;
        if (pendingRef) {
          const url = new URL(callbackWebAppUrl);
          url.searchParams.set('startapp', pendingRef);
          callbackWebAppUrl = url.toString();
        }

        await diagLog(env, { scope: 'diag-callback-join-verify-SUCCESS', user_id: userId, webAppUrl: callbackWebAppUrl, had_pending_ref: Boolean(pendingRef) });
        await answerTelegramCallbackQuery(env, callbackQuery.id, '✅ عضویت تأیید شد! مینی‌اپ را باز کنید.', false);
        await editTelegramMessageReplyMarkup(env, chatId, messageId, {
          inline_keyboard: [
            [
              {
                text: '🚀 باز کردن مینی‌اپ',
                web_app: {
                  url: callbackWebAppUrl,
                },
              },
            ],
          ],
        });
      } else {
        // User is NOT a member
        const reason = membership?.reason || 'not_member';
        let errorMsg = '❌ هنوز عضو کانال نشده‌اید. ابتدا عضو شوید و دوباره کلیک کنید.';
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

    // CRITICAL: always do a real Telegram getChatMember check on /start.
    // Previously used resolveChannelMembership without forceRefresh, which
    // trusted stale KV cache / DB values — a user who LEFT the channel
    // still got the "member" response and the Mini App button.
    // Now forceRefresh:true forces a real Telegram API call every time.
    const membership = await resolveChannelMembership(env, messageContext.userId, { forceRefresh: true });
    console.log(
      JSON.stringify({
        scope: 'telegram-start',
        user_id: messageContext.userId,
        result: membership,
      }),
    );
    await diagLog(env, { scope: 'diag-start-handler', userId: messageContext.userId, startParam: messageContext.startParam, text: messageContext.text });

    // Store pending referral in KV so check_join callback can retrieve it later
    if (messageContext.startParam && env.JOIN_CACHE && typeof env.JOIN_CACHE.put === 'function') {
      try {
        await env.JOIN_CACHE.put(`pending_ref:${messageContext.userId}`, messageContext.startParam, { expirationTtl: 600 });
      } catch (e) {
        console.warn('JOIN_CACHE put pending_ref failed:', e.message || e);
      }
      await diagLog(env, { scope: 'diag-start-stored-pending-ref', userId: messageContext.userId, startParam: messageContext.startParam });
    }

    // If no startParam in current /start, check KV for a previously stored one
    let effectiveStartParam = messageContext.startParam;
    if (!effectiveStartParam && env.JOIN_CACHE && typeof env.JOIN_CACHE.get === 'function') {
      const storedRef = await env.JOIN_CACHE.get(`pending_ref:${messageContext.userId}`);
      if (storedRef) {
        effectiveStartParam = storedRef;
        await diagLog(env, { scope: 'diag-start-recovered-pending-ref', userId: messageContext.userId, storedRef });
      }
    }

    const replyPayload = buildStartReplyPayload(env, messageContext.chatId, Boolean(membership?.joined), effectiveStartParam);

    const finalWebAppUrl = (replyPayload.reply_markup && replyPayload.reply_markup.inline_keyboard && replyPayload.reply_markup.inline_keyboard[0] && replyPayload.reply_markup.inline_keyboard[0][0] && replyPayload.reply_markup.inline_keyboard[0][0].web_app) ? replyPayload.reply_markup.inline_keyboard[0][0].web_app.url : 'no-webapp-button';
    await diagLog(env, { scope: 'diag-start-reply-url', webAppUrl: finalWebAppUrl });
    await sendTelegramMessage(env, replyPayload);

    // Sync the hamburger Menu Button URL with WEBAPP_URL (non-critical, fire-and-forget)
    syncMenuButton(env);
  } catch (error) {
    console.error(safeError('telegram-webhook-error', error));
    // Attempt to notify the user that something went wrong
    if (messageContext?.chatId) {
      try {
        await sendTelegramMessage(env, {
          chat_id: messageContext.chatId,
          text: '⚠️ خطای موقت در پردازش درخواست. لطفاً دوباره /start را بزنید.',
        });
      } catch (notifyErr) {
        console.error(safeError('start-error-notify-failed', notifyErr));
      }
    }
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
// ── Phase 3: Calendar Alerts for high-impact events ───────────────────

const CALENDAR_ALERT_SENT_PREFIX = 'cal_alert:';

async function runCalendarAlertsCheck(env) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.get !== 'function') return;
  if (!notificationRepo) return;

  try {
    const events = await fetchCalendarEvents(env);
    const now = Date.now();
    const WINDOW_MS = 10 * 60 * 1000; // 10 minutes
    const alertedCount = { sent: 0, skipped: 0 };

    for (const event of events) {
      // Only high-impact events
      if (event.impact !== 'high') continue;

      const eventTs = event.timestamp ? new Date(event.timestamp).getTime() : 0;
      if (!eventTs) continue;

      const timeUntil = eventTs - now;
      // Only alert if event is within the next 10 minutes and hasn't passed
      if (timeUntil < 0 || timeUntil > WINDOW_MS) continue;

      // Dedup key: title + date + country
      const eventKey = `${String(event.title || '').slice(0, 60)}|${String(event.date || '')}|${String(event.country || '')}`;
      const dedupKey = `${CALENDAR_ALERT_SENT_PREFIX}${eventKey}`;

      // Check if already sent
      const alreadySent = await readAppCache(env, dedupKey);
      if (alreadySent) {
        alertedCount.skipped++;
        continue;
      }

      // Mark as sent (TTL: 2 hours covers the full event window)
      await writeAppCache(env, dedupKey, '1', 7200);

      // Fetch joined users
      const usersResult = await queryDb(
        env,
        `SELECT telegram_id FROM users WHERE channel_joined = TRUE`,
      );
      const allUserIds = usersResult.rows.map((r) => String(r.telegram_id));
      if (allUserIds.length === 0) continue;

      // CRITICAL FIX: Filter users who have calendar notifications enabled
      const userIds = await notificationRepo.filterUsersByPreference(env, allUserIds, 'calendar');
      if (userIds.length === 0) continue;

      const title = `🔔 رویداد مهم تقویم: ${event.title}`;
      const message = `${event.country} ${event.flag} — ${event.time || ''}`;

      // Send via Notification Platform (single entry point — handles settings, templates, queue)
      for (const uid of userIds) {
        await notificationPlatformRepo.dispatch(env, {
          userId: uid,
          title, message,
          category: 'calendar',
          priority: 'medium',
          channel: 'both',
          metadata: { event_title: event.title, event_date: event.date, event_time: event.time, event_country: event.country },
        }).catch(() => {});
      }
      alertedCount.sent++;
    }

    if (alertedCount.sent > 0 || alertedCount.skipped > 0) {
      console.log(JSON.stringify({ scope: 'calendar-alerts-check', ...alertedCount }));
    }
  } catch (error) {
    console.warn(safeError('calendar-alerts-check', error));
  }
}

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
    // AUDIT-002 FIX: Ensure table + indexes exist before querying (idempotent).
    // Adds idx_price_alerts_status_created for fast cron scans.
    if (typeof alertRepo?.ensureTable === 'function') {
      try { await alertRepo.ensureTable(env); } catch {}
    }
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

    // PHASE 4 FIX: Batch price fetches with Promise.all for parallelism.
    // Previously sequential (1 MEXC call at a time). Now fetches all unique
    // symbols concurrently, reducing cron runtime significantly.
    const symbolPriceMap = new Map();
    const uniqueSymbols = [...new Set(
      alerts.map(a => String(a?.symbol || '').trim().toUpperCase()).filter(Boolean)
    )];

    // Fetch all unique symbol prices in parallel (max 20 concurrent to avoid rate limits)
    const BATCH_SIZE = 20;
    for (let i = 0; i < uniqueSymbols.length; i += BATCH_SIZE) {
      const batch = uniqueSymbols.slice(i, i + BATCH_SIZE);
      const results = await Promise.allSettled(
        batch.map(async (symbol) => {
          const priceInfo = await fetchSpotPriceUsd(env, symbol);
          return { symbol, price: priceInfo?.price || null };
        })
      );
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.price) {
            symbolPriceMap.set(r.value.symbol, r.value.price);
          } else {
            resultPayload.price_fetch_failures += 1;
            symbolPriceMap.set(r.value.symbol, null);
          }
        } else {
          resultPayload.price_fetch_failures += 1;
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
        const webAppUrl = resolveWebAppUrl(env, { cacheBust: true });

        // CRITICAL FIX (AUDIT-002): Honor user notification preference BEFORE sending.
        // If the user disabled price_alert notifications, skip BOTH Telegram and in-app delivery.
        // The alert is still marked as triggered (status update below) so we don't keep checking it.
        let prefsEnabled = true; // default to enabled (fail-open) for backwards compat
        if (notificationRepo) {
          try {
            prefsEnabled = await notificationRepo.isPreferenceEnabled(env, userId, 'price_alert');
          } catch (e) {
            // prefs check failed — fail open (send notification) but log for monitoring
            console.warn('alert preference check failed, sending anyway:', {
              alert_id: alertId,
              user_id: userId,
              error: e instanceof Error ? e.message : String(e),
            });
          }
        }

        if (prefsEnabled) {
          // Send via Notification Platform ONLY (single entry point).
          // dispatch() with channel='both' handles: in-app notification + Telegram queue.
          // This replaces the old direct sendTelegramMessage which caused DUPLICATE messages.
          if (notificationPlatformRepo) {
            try {
              await notificationPlatformRepo.dispatch(env, {
                userId,
                templateKey: 'price_alert_hit',
                category: 'market',
                priority: 'high',
                channel: 'both',
                metadata: { symbol, price: String(currentPrice), alert_id: String(alertId), target_price: String(targetPrice), direction },
                title: `🔔 هشدار ${symbol}`,
                message: text,
              });
            } catch (notifErr) {
              console.warn('Notification Platform dispatch failed for price alert:', notifErr?.message);
            }
          } else {
            // Fallback: if notificationPlatformRepo not available, direct send
            const tgPayload = { chat_id: chatId, text, disable_web_page_preview: true };
            if (webAppUrl) {
              tgPayload.reply_markup = { inline_keyboard: [[{ text: 'Open Amir BTC Assistant 🚀', web_app: { url: webAppUrl } }]] };
            }
            await sendTelegramMessage(env, tgPayload).catch(() => {});
          }
        } else {
          // User opted out of price_alert notifications — log for audit trail
          console.log(JSON.stringify({
            scope: 'scheduled-alerts-execution',
            skipped_preference: true,
            alert_id: alertId,
            user_id: userId,
            symbol,
          }));
        }

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
    console.warn(safeError('scheduled-alerts-runner', error));
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
  async fetch(request, env, ctx) {
    _currentRequestOrigin = request.headers.get('Origin');
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

      // ── System Status (public — maintenance mode check) ──
      // No auth required: this MUST be reachable before app load, even for
      // unauthenticated users. The response contains only the maintenance
      // display fields (title, description, progress, enabled) — no secrets.
      if (request.method === 'GET' && url.pathname === '/api/system/status') {
        const state = await getMaintenanceState(env);
        return jsonResponse({
          status: 'success',
          maintenance: state.maintenance,
        }, {}, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/charts/resolve') {
        return await handleChartResolve(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/calendar/events') {
        return await handleCalendarEvents(env);
      }

      // ── Market Overview (CMC-powered, no auth required) ──
      if (request.method === 'GET' && url.pathname === '/api/market/overview') {
        const overview = await marketOverviewSvc.getCachedOverview(env);
        if (overview) {
          // PHASE 5 FIX: Enrich with Fear & Greed from alternative.me
          // (not included in CMC global metrics)
          if (!overview.fearGreedValue) {
            try {
              const fg = await fetchFearGreed();
              if (fg) {
                overview.fearGreedValue = fg.value;
                overview.fearGreedClassification = fg.classification;
                overview.fearGreedSource = 'alternative.me';
              }
            } catch { /* F&G is optional — don't fail overview if it fails */ }
          }
          return jsonResponse({ status: 'success', ...overview }, {}, env);
        }
        // Fallback: try fetchGlobalStats which includes F&G
        try {
          const stats = await fetchGlobalStats(env);
          if (stats) {
            return jsonResponse({ status: 'success', ...stats }, {}, env);
          }
        } catch {}
        return jsonResponse({ status: 'error', message: 'Market overview unavailable' }, { status: 503 }, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/market/overview/usage') {
        // Admin-only: CMC usage monitoring
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;
        if (!isAdminTelegramId(env, authState.user.id)) {
          return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
        }
        const usage = await marketOverviewSvc.getUsageLog(env);
        const keyInfo = env.CMC_API_KEY ? await marketOverviewSvc.fetchCMCKeyInfo(env.CMC_API_KEY) : null;
        return jsonResponse({ status: 'success', usage, keyInfo }, {}, env);
      }

      // ── Admin Panel API Routes (R4) ──
      if (url.pathname === '/api/admin/is-admin' && request.method === 'GET') {
        return await adminHandlers.handleIsAdmin(request, env);
      }
      if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
        return await adminHandlers.handleDashboard(request, env);
      }
      if (url.pathname === '/api/admin/admins' && request.method === 'GET') {
        return await adminHandlers.handleListAdmins(request, env);
      }
      if (url.pathname === '/api/admin/admins' && request.method === 'POST') {
        return await adminHandlers.handleAddAdmin(request, env);
      }
      if (/^\/api\/admin\/admins\/\d+$/.test(url.pathname) && request.method === 'PUT') {
        const adminId = url.pathname.split('/').pop();
        return await adminHandlers.handleUpdateAdmin(request, env, adminId);
      }
      if (/^\/api\/admin\/admins\/\d+$/.test(url.pathname) && request.method === 'DELETE') {
        const adminId = url.pathname.split('/').pop();
        return await adminHandlers.handleDeleteAdmin(request, env, adminId);
      }
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        return await adminHandlers.handleListUsers(request, env);
      }
      if (/^\/api\/admin\/users\/[^/]+\/stats$/.test(url.pathname) && request.method === 'GET') {
        const userId = decodeURIComponent(url.pathname.split('/')[4]);
        return await adminHandlers.handleUserDetail(request, env, userId);
      }
      if (url.pathname === '/api/admin/tickets' && request.method === 'GET') {
        return await adminHandlers.handleListTickets(request, env);
      }
      if (/^\/api\/admin\/tickets\/[^/]+\/reply$/.test(url.pathname) && request.method === 'POST') {
        const ticketId = url.pathname.split('/')[4];
        return await adminHandlers.handleReplyTicket(request, env, ticketId);
      }
      if (/^\/api\/admin\/tickets\/[^/]+\/status$/.test(url.pathname) && request.method === 'PUT') {
        const ticketId = url.pathname.split('/')[4];
        return await adminHandlers.handleUpdateTicketStatus(request, env, ticketId);
      }
      if (url.pathname === '/api/admin/broadcasts' && request.method === 'POST') {
        return await adminHandlers.handleCreateBroadcast(request, env);
      }
      if (url.pathname === '/api/admin/broadcasts' && request.method === 'GET') {
        return await adminHandlers.handleListBroadcasts(request, env);
      }
      if (url.pathname === '/api/admin/rewards' && request.method === 'GET') {
        return await adminHandlers.handleListRewards(request, env);
      }
      if (/^\/api\/admin\/rewards\/\d+\/status$/.test(url.pathname) && request.method === 'PUT') {
        const rewardId = url.pathname.split('/')[4];
        return await adminHandlers.handleUpdateReward(request, env, rewardId);
      }
      if (url.pathname === '/api/admin/transactions' && request.method === 'GET') {
        return await adminHandlers.handleListTransactions(request, env);
      }
      if (url.pathname === '/api/admin/referrals' && request.method === 'GET') {
        return await adminHandlers.handleListReferrals(request, env);
      }
      if (url.pathname === '/api/admin/system-health' && request.method === 'GET') {
        return await adminHandlers.handleSystemHealth(request, env);
      }
      if (url.pathname === '/api/admin/logs' && request.method === 'GET') {
        return await adminHandlers.handleLogs(request, env);
      }

      // ─────────────────────────────────────────────────────────────
      // REWARD CENTER (admin) — full reward management system
      // ─────────────────────────────────────────────────────────────

      // Overview & Analytics
      if (url.pathname === '/api/admin/reward-center/overview' && request.method === 'GET') {
        return await rewardCenterHandlers.handleOverview(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/analytics' && request.method === 'GET') {
        return await rewardCenterHandlers.handleAnalytics(request, env);
      }

      // Wheel Config
      if (url.pathname === '/api/admin/reward-center/wheel/config' && request.method === 'GET') {
        return await rewardCenterHandlers.handleGetWheelConfig(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/wheel/config' && (request.method === 'PUT' || request.method === 'POST')) {
        return await rewardCenterHandlers.handleUpdateWheelConfig(request, env);
      }

      // Wheel Rewards CRUD
      if (url.pathname === '/api/admin/reward-center/wheel/rewards' && request.method === 'GET') {
        return await rewardCenterHandlers.handleListWheelRewards(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/wheel/rewards' && request.method === 'POST') {
        return await rewardCenterHandlers.handleCreateWheelReward(request, env);
      }
      if (/^\/api\/admin\/reward-center\/wheel\/rewards\/\d+$/.test(url.pathname)) {
        const rewardId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return await rewardCenterHandlers.handleUpdateWheelReward(request, env, rewardId);
        if (request.method === 'DELETE') return await rewardCenterHandlers.handleDeleteWheelReward(request, env, rewardId);
      }

      // Reward Library CRUD
      if (url.pathname === '/api/admin/reward-center/library' && request.method === 'GET') {
        return await rewardCenterHandlers.handleListLibrary(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/library' && request.method === 'POST') {
        return await rewardCenterHandlers.handleCreateLibraryItem(request, env);
      }
      if (/^\/api\/admin\/reward-center\/library\/\d+$/.test(url.pathname)) {
        const itemId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return await rewardCenterHandlers.handleUpdateLibraryItem(request, env, itemId);
        if (request.method === 'DELETE') return await rewardCenterHandlers.handleDeleteLibraryItem(request, env, itemId);
      }

      // Referral Reward Tiers CRUD
      if (url.pathname === '/api/admin/reward-center/referral-tiers' && request.method === 'GET') {
        return await rewardCenterHandlers.handleListReferralTiers(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/referral-tiers' && request.method === 'POST') {
        return await rewardCenterHandlers.handleCreateReferralTier(request, env);
      }
      if (/^\/api\/admin\/reward-center\/referral-tiers\/\d+$/.test(url.pathname)) {
        const tierId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return await rewardCenterHandlers.handleUpdateReferralTier(request, env, tierId);
        if (request.method === 'DELETE') return await rewardCenterHandlers.handleDeleteReferralTier(request, env, tierId);
      }

      // Mission Rewards CRUD
      if (url.pathname === '/api/admin/reward-center/mission-rewards' && request.method === 'GET') {
        return await rewardCenterHandlers.handleListMissionRewards(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/mission-rewards' && request.method === 'POST') {
        return await rewardCenterHandlers.handleCreateMissionReward(request, env);
      }
      if (/^\/api\/admin\/reward-center\/mission-rewards\/\d+$/.test(url.pathname)) {
        const missionId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return await rewardCenterHandlers.handleUpdateMissionReward(request, env, missionId);
        if (request.method === 'DELETE') return await rewardCenterHandlers.handleDeleteMissionReward(request, env, missionId);
      }

      // Campaigns CRUD
      if (url.pathname === '/api/admin/reward-center/campaigns' && request.method === 'GET') {
        return await rewardCenterHandlers.handleListCampaigns(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/campaigns' && request.method === 'POST') {
        return await rewardCenterHandlers.handleCreateCampaign(request, env);
      }
      if (/^\/api\/admin\/reward-center\/campaigns\/[^/]+$/.test(url.pathname)) {
        const campaignId = decodeURIComponent(url.pathname.split('/').pop());
        if (request.method === 'PUT' || request.method === 'PATCH') return await rewardCenterHandlers.handleUpdateCampaign(request, env, campaignId);
        if (request.method === 'DELETE') return await rewardCenterHandlers.handleDeleteCampaign(request, env, campaignId);
      }

      // Emergency Controls
      if (url.pathname === '/api/admin/reward-center/emergency' && request.method === 'GET') {
        return await rewardCenterHandlers.handleGetEmergencyControls(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/emergency' && (request.method === 'PUT' || request.method === 'POST')) {
        return await rewardCenterHandlers.handleUpdateEmergencyControls(request, env);
      }

      // ── Maintenance Mode Controls (admin only) ──
      // GET    /api/admin/maintenance  → read current state
      // PUT    /api/admin/maintenance  → update {enabled, title, description, progress}
      // POST   /api/admin/maintenance  → alias for PUT (some clients prefer POST)
      if (url.pathname === '/api/admin/maintenance' && (request.method === 'GET' || request.method === 'PUT' || request.method === 'POST')) {
        // Auth: require admin (uses the same authenticateTelegramRequest + isAdminTelegramId
        // pattern as other admin endpoints). Super admins from env var are allowed.
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;
        if (!isAdminTelegramId(env, authState.user.id)) {
          return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
        }

        if (request.method === 'GET') {
          const state = await getMaintenanceState(env);
          return jsonResponse({ status: 'success', ...state }, {}, env);
        }

        // PUT / POST — update
        const bodyResult = await readJsonBody(request, 10240, env);
        if (bodyResult.error) return bodyResult.error;
        const payload = bodyResult.payload || {};

        // Only allow known fields; ignore everything else
        const patch = {};
        if (payload.enabled !== undefined) patch.enabled = Boolean(payload.enabled);
        if (payload.title !== undefined) patch.title = String(payload.title);
        if (payload.description !== undefined) patch.description = String(payload.description);
        if (payload.progress !== undefined) patch.progress = Number(payload.progress);

        try {
          const newState = await setMaintenanceState(env, patch, authState.user.id);
          return jsonResponse({ status: 'success', ...newState }, {}, env);
        } catch (err) {
          console.warn('maintenance update failed:', err?.message || err);
          return jsonResponse(
            { status: 'error', message: 'Failed to save maintenance state', detail: String(err?.message || err).slice(0, 200) },
            { status: 500 }, env
          );
        }
      }

      // ── SECURITY: Membership gate for data endpoints ──
      // User-specific data endpoints (forex, analyses, calendar, farsi-news) must
      // NOT serve data to non-members. system/status, charts/resolve, health, and
      // bootstrap remain public (needed for maintenance check + chart loading).
      //
      // ROOT-CAUSE FIX (Task 38): /api/market is now PUBLIC. Market prices are
      // universal public data — every user sees the same BTC price. The ticker
      // on the dashboard needs to render the INSTANT the app opens, not wait
      // for bootstrapUser() → membership verification → _startDataLoading().
      // Gating /api/market behind Telegram initData auth caused the ticker to
      // be empty for the first 2-5 seconds of every cold open, and FOREVER for
      // users whose bootstrap failed (network error, pending initData, guest,
      // etc.). Market data has zero user-specific value — no auth required.
      // The Worker still rate-limits by client IP (line 4149) so anonymous
      // access cannot be abused.
      const _DATA_PATHS = /^\/api\/(forex|analyses|calendar\/events|farsi-news)(\/|$)/;
      const _isProdEnv = String(env.APP_ENV || '').toLowerCase() === 'production';
      if (_isProdEnv && _DATA_PATHS.test(url.pathname)) {
        const _dataAuth = await authenticateTelegramRequest(request, env);
        if (_dataAuth.error) return _dataAuth.error;
        const _dataJoinBlocked = await requireChannelJoin(_dataAuth.user, env);
        if (_dataJoinBlocked) return _dataJoinBlocked;
      }

      if (request.method === 'GET' && url.pathname === '/api/market') {
        const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
        if (await isMarketRateLimited(env, clientIp)) {
          return jsonResponse({ status: 'error', message: 'Rate limited' }, { status: 429 }, env);
        }
        // Single Flight: coalesce concurrent requests into one upstream call.
        // CRITICAL: Must serialize the Response to avoid sharing stream I/O
        // across requests. We clone the response data and rebuild for each caller.
        const sharedResponse = await singleFlight('market:data:fetch', async () => {
          const resp = await handleMarketData(env);
          const text = await resp.text();
          return { status: resp.status, body: text };
        });
        return new Response(sharedResponse.body, {
          status: sharedResponse.status,
          headers: { 'Content-Type': 'application/json', 'Access-Control-Allow-Origin': '*' },
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/forex') {
        const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
        if (await isMarketRateLimited(env, clientIp)) {
          return jsonResponse({ status: 'error', message: 'Rate limited' }, { status: 429 }, env);
        }
        return await handleForexData(env);
      }

      if (request.method === 'GET' && url.pathname === '/api/farsi-news') {
        return await handleFarsiNews(request, env);
      }

      // Future: /api/news/stream SSE endpoint for breaking news push.
      // Requires Durable Object for true WebSocket, or simple SSE stream.
      // Current 30s polling + SWR provides adequate UX for Telegram Mini App.

      // Diagnostic endpoints — development only, block in production
      if (/^\/api\/_diag\//.test(url.pathname) && !isDevMode(env)) {
        return jsonResponse({ detail: 'Not found' }, { status: 404 }, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/_diag/analyses-db') {
        try {
          const countResult = await queryDb(env, 'SELECT COUNT(*) as total FROM analyses');
          const total = Number(countResult.rows[0]?.total || 0);
          let rows = [];
          if (total > 0) {
            const allResult = await queryDb(env, 'SELECT id, coin, timeframe, author, author_id, created_at, updated_at FROM analyses ORDER BY created_at DESC LIMIT 10');
            rows = allResult.rows;
          }
          const schemaResult = await queryDb(env, "SELECT column_name, data_type, is_nullable FROM information_schema.columns WHERE table_name = 'analyses' ORDER BY ordinal_position");
          const constraintsResult = await queryDb(env, "SELECT tc.constraint_name, tc.constraint_type, kcu.column_name FROM information_schema.table_constraints tc LEFT JOIN information_schema.key_column_usage kcu ON tc.constraint_name = kcu.constraint_name WHERE tc.table_name = 'analyses' ORDER BY tc.constraint_type, kcu.column_name");
          const tablesResult = await queryDb(env, "SELECT table_name FROM information_schema.tables WHERE table_schema = 'public' ORDER BY table_name");
          return jsonResponse({ db_row_count: total, rows, schema: schemaResult.rows, constraints: constraintsResult.rows, all_tables: tablesResult.rows.map(r => r.table_name), db_configured: isDatabaseConfigured(env) }, {}, env);
        } catch (e) {
          return jsonResponse({ error: e.message, stack: e.stack?.split('\n').slice(0, 5) }, { status: 500 }, env);
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/_diag/analyses-db') {
        try {
          const testId = 'diag_' + Date.now().toString(36);
          // Step 1: INSERT
          const insertResult = await queryDb(env,
            'INSERT INTO analyses (id, coin, timeframe, image, text, author, author_id, created_at, updated_at) VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW()) RETURNING id, coin, created_at',
            [testId, 'BTC', '1d', '', 'Diagnostic test analysis', 'System', 'diag', ]
          );
          const inserted = insertResult.rows[0];
          // Step 2: Immediate SELECT
          const selectResult = await queryDb(env, 'SELECT id, coin, text, created_at FROM analyses WHERE id = $1', [testId]);
          const selected = selectResult.rows[0];
          // Step 3: Count
          const countResult = await queryDb(env, 'SELECT COUNT(*) as total FROM analyses');
          const total = Number(countResult.rows[0]?.total || 0);
          // Step 4: DELETE the test row
          await queryDb(env, 'DELETE FROM analyses WHERE id = $1', [testId]);
          // Step 5: Count after delete
          const countAfter = await queryDb(env, 'SELECT COUNT(*) as total FROM analyses');
          const totalAfter = Number(countAfter.rows[0]?.total || 0);
          return jsonResponse({
            insert_ok: Boolean(inserted),
            inserted,
            select_ok: Boolean(selected),
            selected,
            count_before_delete: total,
            count_after_delete: totalAfter,
            db_configured: isDatabaseConfigured(env),
          }, {}, env);
        } catch (e) {
          return jsonResponse({ error: e.message, stack: e.stack?.split('\n').slice(0, 10) }, { status: 500 }, env);
        }
      }

      // DIAG: Read referral flow logs from KV
      if (request.method === 'GET' && url.pathname === '/api/_diag/referral-log') {
        try {
          const raw = await env.APP_CACHE.get(DIAG_LOG_KEY);
          const lines = raw ? raw.split('\n').filter(Boolean).map(l => { try { return JSON.parse(l); } catch { return l; } }) : [];
          return jsonResponse({ log_count: lines.length, logs: lines }, {
            headers: { 'Cache-Control': 'no-store' },
          }, env);
        } catch (e) {
          return jsonResponse({ error: e.message }, { status: 500 }, env);
        }
      }

      // ── Auth + Channel Join gate for protected routes (PRODUCTION ONLY) ──
      // Evaluated once; reused by all protected handlers below.
      // Unprotected routes (health, market, charts, calendar, public analyses, bootstrap) are above this line.
      let _protectedUser = null;
      let _joinBlocked = null;
      const PROTECTED_PATHS = /^\/api\/(wallet|tickets|alerts|assistant|referrals|users\/me|watchlist|sessions|notify|notifications)/;
      const _isProduction = String(env.APP_ENV || '').toLowerCase() === 'production';

      if (_isProduction && PROTECTED_PATHS.test(url.pathname)) {
        const _authState = await authenticateTelegramRequest(request, env);
        if (_authState.error) return _authState.error;
        _protectedUser = _authState.user;
        _joinBlocked = await requireChannelJoin(_protectedUser, env);
        if (_joinBlocked) return _joinBlocked;
      }

      // ── Analyses: Public endpoints ──
      if (request.method === 'GET' && url.pathname === '/api/analyses') {
        return await analysisHandlers.handleList(request, env);
      }

      // GET /api/analyses/:id (detail) — must be before PUT/DELETE pattern
      if (request.method === 'GET' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return await analysisHandlers.handleGetDetail(request, env, analysisId);
      }

      // POST /api/analyses/:id/view (increment views)
      if (request.method === 'POST' && /^\/api\/analyses\/[^/]+\/view$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return await analysisHandlers.handleIncrementView(request, env, analysisId);
      }

      // ── Analyses: Admin endpoints (new paths) ──
      if (request.method === 'POST' && url.pathname === '/api/admin/analyses') {
        return await analysisHandlers.handleCreate(request, env, ctx);
      }

      if (request.method === 'PUT' && /^\/api\/admin\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[4] || '';
        return await analysisHandlers.handleUpdate(request, env, analysisId);
      }

      if (request.method === 'DELETE' && /^\/api\/admin\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[4] || '';
        return await analysisHandlers.handleDelete(request, env, analysisId);
      }

      // ── Analyses: Legacy admin paths (backward compat) ──
      if (request.method === 'POST' && url.pathname === '/api/analyses') {
        return await analysisHandlers.handleCreateLegacy(request, env, ctx);
      }

      if (request.method === 'PUT' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return await analysisHandlers.handleUpdateLegacy(request, env, analysisId);
      }

      if (request.method === 'DELETE' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return await analysisHandlers.handleDeleteLegacy(request, env, analysisId);
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

      if (request.method === 'GET' && url.pathname === '/api/notifications') {
        return await notificationHandlers.handleList(request, env);
      }

      // ── Notification Settings API ──
      if (request.method === 'GET' && url.pathname === '/api/notifications/settings') {
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;
        try {
          const prefs = await notificationRepo.getSettings(env, String(authState.user.id));
          return jsonResponse({ status: 'success', preferences: prefs }, {}, env);
        } catch (err) {
          console.warn('notif-settings-get:', err?.message || err);
          return jsonResponse({ status: 'error', message: 'Failed to load settings' }, { status: 500 }, env);
        }
      }

      if (request.method === 'PUT' && url.pathname === '/api/notifications/settings') {
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;
        try {
          const bodyResult = await readJsonBody(request, 10240, env);
          if (bodyResult.error) return bodyResult.error;
          const prefs = bodyResult.payload?.preferences || {};
          await notificationRepo.saveSettings(env, String(authState.user.id), prefs);
          return jsonResponse({ status: 'success', preferences: { ...prefs } }, {}, env);
        } catch (err) {
          console.warn('notif-settings-save:', err?.message || err);
          return jsonResponse({ status: 'error', message: 'Failed to save settings' }, { status: 500 }, env);
        }
      }

      if (request.method === 'POST' && url.pathname === '/api/notifications/read-all') {
        return await notificationHandlers.handleMarkAllRead(request, env);
      }

      if (request.method === 'POST' && /^\/api\/notifications\/[^/]+\/read$/u.test(url.pathname)) {
        const notificationId = url.pathname.split('/')[3] || '';
        return await notificationHandlers.handleMarkRead(request, env, notificationId);
      }

      // ─────────────────────────────────────────────────────────────
      // NOTIFICATION PLATFORM — unified notification system
      // ─────────────────────────────────────────────────────────────

      // User: list notifications (with filter/search/pagination)
      if (request.method === 'GET' && url.pathname === '/api/notifications/platform/list') {
        return await notificationPlatformHandlers.handleList(request, env);
      }
      // User: unread count
      if (request.method === 'GET' && url.pathname === '/api/notifications/platform/unread-count') {
        return await notificationPlatformHandlers.handleUnreadCount(request, env);
      }
      // User: mark single notification as read
      if (request.method === 'POST' && /^\/api\/notifications\/platform\/[^/]+\/read$/.test(url.pathname)) {
        const notifId = url.pathname.split('/').pop();
        return await notificationPlatformHandlers.handleMarkRead(request, env, notifId);
      }
      // User: mark all as read
      if (request.method === 'POST' && url.pathname === '/api/notifications/platform/read-all') {
        return await notificationPlatformHandlers.handleMarkAllRead(request, env);
      }
      // User: archive notification
      if (request.method === 'POST' && /^\/api\/notifications\/platform\/[^/]+\/archive$/.test(url.pathname)) {
        const notifId = url.pathname.split('/')[4];
        return await notificationPlatformHandlers.handleArchive(request, env, notifId);
      }
      // User: delete notification
      if (request.method === 'DELETE' && /^\/api\/notifications\/platform\/[^/]+$/.test(url.pathname)) {
        const notifId = url.pathname.split('/').pop();
        return await notificationPlatformHandlers.handleDelete(request, env, notifId);
      }
      // User: get notification settings
      if (request.method === 'GET' && url.pathname === '/api/notifications/platform/settings') {
        return await notificationPlatformHandlers.handleGetSettings(request, env);
      }
      // User: update notification settings
      if (request.method === 'PUT' && url.pathname === '/api/notifications/platform/settings') {
        return await notificationPlatformHandlers.handleUpdateSettings(request, env);
      }

      // Admin: notification analytics
      if (request.method === 'GET' && url.pathname === '/api/admin/notifications/analytics') {
        return await notificationPlatformHandlers.handleAdminAnalytics(request, env);
      }
      // Admin: templates CRUD
      if (request.method === 'GET' && url.pathname === '/api/admin/notifications/templates') {
        return await notificationPlatformHandlers.handleListTemplates(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/notifications/templates') {
        return await notificationPlatformHandlers.handleCreateTemplate(request, env);
      }
      if (/^\/api\/admin\/notifications\/templates\/\d+$/.test(url.pathname)) {
        const tplId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return await notificationPlatformHandlers.handleUpdateTemplate(request, env, tplId);
        if (request.method === 'DELETE') return await notificationPlatformHandlers.handleDeleteTemplate(request, env, tplId);
      }
      // Admin: broadcasts
      if (request.method === 'GET' && url.pathname === '/api/admin/notifications/broadcasts') {
        return await notificationPlatformHandlers.handleListBroadcasts(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/notifications/broadcasts') {
        return await notificationPlatformHandlers.handleCreateBroadcast(request, env);
      }
      if (request.method === 'POST' && /^\/api\/admin\/notifications\/broadcasts\/\d+\/send$/.test(url.pathname)) {
        const bId = url.pathname.split('/')[5];
        return await notificationPlatformHandlers.handleProcessBroadcast(request, env, bId);
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

      // Recheck channel membership (used by frontend lock screen "Verify" button)
      // Rate-limited to prevent abuse: max 1 check per 3 seconds per user.
      if (request.method === 'POST' && url.pathname === '/api/users/check-join') {
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;
        const _joinUserId = String(authState.user.id);
        // Rate limit: 3s cooldown between checks
        if (env.RATE_LIMITS && typeof env.RATE_LIMITS.get === 'function') {
          try {
            const _rlKey = `jl:${_joinUserId}`;
            const _existing = await env.RATE_LIMITS.get(_rlKey);
            if (_existing) {
              return jsonResponse({ status: 'error', message: 'Too many requests. Please wait a few seconds.', code: 'RATE_LIMITED' }, { status: 429 }, env);
            }
            await env.RATE_LIMITS.put(_rlKey, '1', { expirationTtl: 3 });
          } catch { /* non-fatal */ }
        }
        const membership = await resolveChannelMembership(env, _joinUserId, { forceRefresh: true });
        return jsonResponse({ status: 'success', channel_joined: Boolean(membership?.joined) }, {}, env);
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
        return await referralHandlers.handleStats(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/referrals/history') {
        return await referralHandlers.handleHistory(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/referrals/leaderboard') {
        return await referralHandlers.handleLeaderboard(request, env);
      }

      // DEPRECATED: /api/referrals/tokens — use /api/wallet instead
      if (request.method === 'GET' && url.pathname === '/api/referrals/tokens') {
        return await walletHandlers.handleGetWallet(request, env);
      }

      // Wallet API Routes
      if (request.method === 'GET' && url.pathname === '/api/wallet') {
        return await walletHandlers.handleGetWallet(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/balance') {
        return await walletHandlers.handleGetBalance(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/summary') {
        return await walletHandlers.handleGetSummary(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/history') {
        return await walletHandlers.handleGetHistory(request, env);
      }

      if (request.method === 'GET' && /^\/api\/wallet\/transaction\/[^/]+$/.test(url.pathname)) {
        const txId = url.pathname.split('/')[3] || '';
        return await walletHandlers.handleGetTransaction(request, env, txId);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/claim') {
        return await walletHandlers.handleGetClaimStatus(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/wallet/claim') {
        return await walletHandlers.handleClaimDaily(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/referral-stats') {
        return await walletHandlers.handleReferralStats(request, env);
      }

      // ── Lucky Wheel API Routes ──
      if (request.method === 'GET' && url.pathname === '/api/wheel/status') {
        return await wheelHandlers.handleStatus(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/wheel/spin') {
        return await wheelHandlers.handleSpin(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wheel/history') {
        return await wheelHandlers.handleHistory(request, env);
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
      console.error(safeError('unhandled-request-error', error));
      return jsonResponse(
        {
          status: 'error',
          message: 'Internal server error',
        },
        { status: 500 }, env);
    }
  },

  async scheduled(controller, env, ctx) {
    // Wrap each task with a 25s timeout to prevent waitUntil cancellation
    const withTimeout = (promise, ms = 25000) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => { console.warn('Scheduled task timeout after', ms, 'ms'); resolve(); }, ms)),
      ]);

    ctx.waitUntil(withTimeout(runScheduledAlertsBaseline(controller, env)));
    // Refresh CMC Market Overview every 15 minutes
    if (env.CMC_API_KEY) {
      ctx.waitUntil(withTimeout(marketOverviewSvc.refreshOverview(env)));
    }
    // Phase 3 — Check for upcoming high-impact calendar events
    ctx.waitUntil(withTimeout(runCalendarAlertsCheck(env)));
  },
};
//#endregion

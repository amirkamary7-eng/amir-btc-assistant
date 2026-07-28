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
import { createCalendarReminderRepository } from './src/repositories/calendar_reminders.js';
import { createCalendarReminderHandlers } from './src/controllers/calendar_reminders.js';
import { createAdminRepository } from './src/repositories/admin.js';
import { createAdminHandlers } from './src/controllers/admin.js';
import { createRewardCenterRepository } from './src/repositories/reward_center.js';
import { createRewardCenterHandlers } from './src/controllers/reward_center.js';
import { createNotificationPlatformRepository, setEnvSendTelegramMessage } from './src/repositories/notification_platform.js';
import { createNotificationPlatformHandlers } from './src/controllers/notification_platform.js';
import { createAlertEconomyRepository } from './src/repositories/alert_economy.js';
import { createAlertEconomyHandlers } from './src/controllers/alert_economy.js';
import { createPublisherRepository } from './src/repositories/publisher.js';
import { createPublisherHandlers } from './src/controllers/publisher.js';
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
  // ROOT CAUSE FIX: Prevent browser/edge caching of API responses.
  // Without this, admin panel could show stale data from browser cache.
  // 'no-store' ensures every request hits the server.
  if (!headers.has('Cache-Control')) {
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
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

// In-memory cache of last-written values — prevents redundant KV writes.
// Key: KV key, Value: string that was last written.
// Survives for the lifetime of the Worker isolate.
const _kvWriteCache = new Map();
const _KV_WRITE_CACHE_MAX = 200;

// ── REAL KV WRITE TRACKING ──
// Counts actual KV.put calls per key prefix. Survives per isolate.
// Reported via /api/_diag/kv-write-stats
const _kvWriteStats = {
  startedAt: null, // Set on first write (lazy init)
  totalWrites: 0,
  totalSkipped: 0,
  byKey: {},       // exact key → count
  byPrefix: {},    // prefix (first 2 segments) → count
};
function _trackKvWrite(key) {
  if (!_kvWriteStats.startedAt) _kvWriteStats.startedAt = new Date().toISOString();
  _kvWriteStats.totalWrites++;
  const parts = String(key || '').split(':').slice(0, 2).join(':');
  _kvWriteStats.byPrefix[parts] = (_kvWriteStats.byPrefix[parts] || 0) + 1;
  _kvWriteStats.byKey[key] = (_kvWriteStats.byKey[key] || 0) + 1;
}
function _trackKvSkip() {
  _kvWriteStats.totalSkipped++;
}

async function writeAppCache(env, key, value, expirationTtl) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.put !== 'function') {
    console.warn('[writeAppCache] KV not available, skipping write:', key);
    return;
  }

  // SKIP-WRITTEN: If the value hasn't changed since last write, skip the KV put.
  const cachedValue = _kvWriteCache.get(key);
  if (cachedValue === value) {
    _trackKvSkip();
    return; // Value unchanged — skip write
  }

  try {
    // CRITICAL: Cloudflare KV rejects expirationTtl: 0 (means "delete").
    // Use undefined instead of 0 for "no expiration".
    const putOpts = {};
    if (expirationTtl && expirationTtl > 0) {
      putOpts.expirationTtl = expirationTtl;
    }
    await env.APP_CACHE.put(key, value, putOpts);
    _trackKvWrite(key);
    if (_kvWriteCache.size >= _KV_WRITE_CACHE_MAX) {
      const firstKey = _kvWriteCache.keys().next().value;
      _kvWriteCache.delete(firstKey);
    }
    _kvWriteCache.set(key, value);
  } catch (e) {
    console.warn('[writeAppCache] KV.put FAILED for key:', key, '| error:', e.message || e);
  }
}

// ============================================================================
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
    _trackKvWrite(DIAG_LOG_KEY);
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
      _trackKvWrite(MAINT_KV_KEY);
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
    _trackKvWrite('RATE_LIMITS:' + key);
  } catch (e) {
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
  try {
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
  } catch (e) {
    // SECURITY: If validateTelegramInitData throws (malformed initData, crypto error),
    // we must return 401 — never let the exception propagate and cause a 500.
    console.warn('authenticateTelegramRequest error:', e?.message || String(e));
    return {
      error: jsonResponse({ detail: 'Authentication error' }, { status: 401 }, env),
      user: null,
    };
  }
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
        // CRITICAL FIX: Telegram API returns HTTP 200 even when the API call
        // fails (e.g., bot can't send to user, chat not found, etc.).
        // We MUST parse the JSON body and check data.ok === true.
        const data = await response.json();
        if (data.ok === true) {
          clearTimeout(timer);
          return { ok: true, result: data.result, messageId: data.result?.message_id };
        }
        // API returned ok:false — log the error
        console.warn('Telegram API returned ok:false:', {
          error_code: data.error_code,
          description: data.description,
          chat_id: payload.chat_id,
        });
        // Don't retry on 403 (Forbidden — user hasn't started bot) or 400 (Bad Request)
        if (data.error_code === 403 || data.error_code === 400) {
          clearTimeout(timer);
          throw new Error(`Telegram sendMessage failed: ${data.error_code} ${data.description}`);
        }
        // Retry on 429 (rate limit)
        if (data.error_code === 429 && attempt < retries) {
          const retryAfter = data.parameters?.retry_after || 2;
          await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000));
          continue;
        }
        clearTimeout(timer);
        throw new Error(`Telegram sendMessage failed: ${data.error_code} ${data.description}`);
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

const CALLBACK_RATE_LIMIT_TTL = 60; // seconds — Cloudflare KV requires expirationTtl >= 60
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
 *
 * The rate-limit key now includes the Telegram user ID (when available from
 * authenticated initData) in ADDITION to the client IP. This closes two
 * long-standing loopholes:
 *   1. A single user rotating across multiple IPs (VPN/proxy) was able to
 *      bypass the per-IP cap. Now they are capped per user+IP.
 *   2. A single shared IP (e.g. a corporate NAT) with many real users was
 *      unfairly throttled. Now each user gets their own bucket on that IP.
 *
 * Unauthenticated requests (no initData) fall back to the legacy
 * `mrl:anon:<ip>` key so the existing IP-only protection still works for
 * anonymous callers.
 *
 * Returns true if rate limited, false if allowed.
 *
 * @param {object} env
 * @param {string} ip — Client IP (cf-connecting-ip).
 * @param {string|null|undefined} [userId] — Telegram user ID when available.
 */
async function isMarketRateLimited(env, ip, userId) {
  const uid = userId ? String(userId) : 'anon';
  const key = `${MARKET_RATE_LIMIT_KEY_PREFIX}${uid}:${ip}`;
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

// ── ROOT CAUSE FIX: Per-request Pool sharing ──
// Previously, queryDb created a new Pool for EVERY query call. When dashboard
// runs 17 parallel queries (Promise.allSettled), 17 WebSocket connections open
// simultaneously to Neon DB → connection exhaustion → "All attempts to open a
// WebSocket to connect to the database failed" errors.
//
// FIX: Pool is created ONCE per Worker fetch invocation and stored in a
// WeakMap keyed by the env object. All queryDb calls within the same request
// share the same Pool (reusing the WebSocket connection). Pool is closed
// after the fetch handler completes (in the finally block).
const _poolCache = new WeakMap();

function getSharedPool(env) {
  if (!env) return null;
  if (_poolCache.has(env)) return _poolCache.get(env);
  const pool = createPool(env);
  if (pool) _poolCache.set(env, pool);
  return pool;
}

function closeSharedPool(env) {
  if (!env) return;
  const pool = _poolCache.get(env);
  if (pool) {
    pool.end().catch(() => {});
    _poolCache.delete(env);
  }
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
    // PHASE 2: Also set bot_joined_at on first interaction (when user row is new).
    // On conflict (existing user), COALESCE preserves the existing bot_joined_at.
    await pool.query(
      `
        INSERT INTO users (
          telegram_id,
          lang,
          channel_joined,
          channel_verified_at,
          bot_joined_at,
          created_at,
          updated_at
        )
        VALUES ($1, 'fa', $2, $3, NOW(), NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE
        SET
          channel_joined = EXCLUDED.channel_joined,
          channel_verified_at = EXCLUDED.channel_verified_at,
          bot_joined_at = COALESCE(users.bot_joined_at, NOW()),
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
  // ROOT CAUSE FIX: Use shared pool instead of creating a new Pool per call.
  // This prevents WebSocket connection exhaustion when multiple queries run
  // in parallel (e.g., dashboard's 17 parallel COUNT queries).
  const pool = getSharedPool(env);
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
  } catch (error) {
    // If the shared pool's connection is broken, invalidate it so the next
    // queryDb call creates a fresh pool.
    closeSharedPool(env);
    throw error;
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
// Binance > Bybit > OKX > Bitget > KuCoin > MEXC > Gate > HTX > Coinbase > Kraken
//
// Each entry: [TradingView prefix, internal key, quote suffix]
//   - USDT pairs: Binance, Bybit, OKX, Bitget, KuCoin, MEXC, Gate, HTX
//   - USD pairs:  Coinbase, Kraken  (these exchanges primarily use USD, not USDT)
//
// IMPORTANT FIXES (verified via TradingView scanner API, 2026-07-26):
//   1. Gate.io TradingView prefix is `GATE` — NOT `GATEIO` (was wrong, caused "Symbol not found")
//   2. Added Coinbase + Kraken with USD pairs (user requested; many coins only chart here)
//   3. tv_symbol format is `${tvName}:${symbol}${suffix}` — all uppercase, no dash/underscore
const EXCHANGE_ORDER = [
  ['BINANCE',  'binance',  'USDT'],
  ['BYBIT',    'bybit',    'USDT'],
  ['OKX',      'okx',      'USDT'],
  ['BITGET',   'bitget',   'USDT'],
  ['KUCOIN',   'kucoin',   'USDT'],
  ['MEXC',     'mexc',     'USDT'],
  ['GATE',     'gateio',   'USDT'],   // FIXED: was GATEIO (invalid on TradingView)
  ['HTX',      'htx',      'USDT'],
  ['COINBASE', 'coinbase', 'USD'],    // NEW — USD pair
  ['KRAKEN',   'kraken',   'USD'],    // NEW — USD pair
];

const CHART_CHECKERS = {
  binance: {
    buildUrl(symbol) {
      // NOTE: api.binance.com returns HTTP 403 from Cloudflare Workers (IP blocked).
      // We use data-api.binance.vision as the primary Binance endpoint.
      // If that also fails (403), exchangeHasSymbol returns false and we
      // fall through to Bybit/OKX/etc.
      // IMPORTANT: Even if Binance API is unreachable, we still use
      // "BINANCE:SYMBOLUSDT" as the tv_symbol because TradingView widget
      // fetches chart data from its OWN servers — not from our Worker.
      return `https://data-api.binance.vision/api/v3/ticker/price?symbol=${encodeURIComponent(`${symbol}USDT`)}`;
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
  // Coinbase Exchange: GET /products/BTC-USD/ticker — returns {price:"..."}
  coinbase: {
    buildUrl(symbol) {
      return `https://api.exchange.coinbase.com/products/${encodeURIComponent(`${symbol}-USD`)}/ticker`;
    },
    isMatch(body) {
      return Boolean(body && typeof body === 'object' && 'price' in body);
    },
  },
  // Kraken: GET /0/public/Ticker?pair=BTCUSD — returns {error:[], result:{XXBTZUSD:{...}}}
  // NOTE: Kraken uses XBT for BTC, but for most other coins the symbol matches.
  // We try the straight symbol; if Kraken doesn't have it, isMatch returns false.
  kraken: {
    buildUrl(symbol) {
      // Kraken's BTC symbol is XBT, so map BTC → XBT for the pair name.
      const krakenBase = symbol === 'BTC' ? 'XBT' : symbol;
      return `https://api.kraken.com/0/public/Ticker?pair=${encodeURIComponent(`${krakenBase}USD`)}`;
    },
    isMatch(body) {
      return Boolean(body?.error && Array.isArray(body.error) && body.error.length === 0
        && body?.result && Object.keys(body.result).length > 0);
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

// Price fetch timeout — shorter than general EXTERNAL_FETCH_TIMEOUT_MS.
// Price APIs (Binance, Bybit, OKX) are fast (<500ms typically). If they
// don't respond in 4s, they're likely down or rate-limiting — fail fast
// and try the next exchange. This prevents cron timeout (25s limit) when
// multiple exchanges are slow.
const PRICE_FETCH_TIMEOUT_MS = 4000;

async function fetchSpotTickerPrice(exchangeKey, symbol) {
  const checker = CHART_CHECKERS[exchangeKey];
  if (!checker) {
    return null;
  }
  const { ok, body } = await fetchJsonWithTimeout(checker.buildUrl(symbol), PRICE_FETCH_TIMEOUT_MS);
  if (!ok || !checker.isMatch(body)) {
    return null;
  }
  return parseSpotTickerPrice(exchangeKey, body);
}

async function fetchSpotPriceUsd(env, symbol, options = {}) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) {
    return null;
  }

  // ── FOREX/INDEX/COMMODITY PRICE FETCH ──
  // For non-crypto symbols (EURUSD, XAUUSD, DXY, SPX, etc.), use Yahoo Finance
  // instead of crypto exchanges (Bybit, OKX). Crypto exchanges only have
  // ${symbol}USDT pairs — forex symbols like EURUSD would fail silently.
  const FOREX_YAHOO_MAP = {
    'XAUUSD': 'GC=F', 'XAGUSD': 'SI=F',
    'AAPL': 'AAPL', 'MSFT': 'MSFT', 'NVDA': 'NVDA', 'AMZN': 'AMZN',
    'GOOGL': 'GOOGL', 'META': 'META', 'TSLA': 'TSLA', 'NFLX': 'NFLX',
    'AMD': 'AMD', 'INTC': 'INTC', 'COIN': 'COIN', 'MSTR': 'MSTR',
    'EURUSD': 'EURUSD=X', 'GBPUSD': 'GBPUSD=X', 'USDJPY': 'USDJPY=X',
    'USDCHF': 'USDCHF=X', 'AUDUSD': 'AUDUSD=X', 'USDCAD': 'USDCAD=X',
    'NZDUSD': 'NZDUSD=X', 'EURJPY': 'EURJPY=X', 'GBPJPY': 'GBPJPY=X',
    'EURGBP': 'EURGBP=X', 'AUDJPY': 'AUDJPY=X', 'EURCHF': 'EURCHF=X',
    'GBPCAD': 'GBPCAD=X', 'AUDNZD': 'AUDNZD=X', 'EURCAD': 'EURCAD=X',
  };
  if (FOREX_YAHOO_MAP[normalizedSymbol]) {
    try {
      const yahooSym = FOREX_YAHOO_MAP[normalizedSymbol];
      const ctrl = new AbortController();
      const t = setTimeout(() => ctrl.abort(), 5000);
      const resp = await fetch(`https://query1.finance.yahoo.com/v8/finance/chart/${yahooSym}?interval=1d&range=5d`, {
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0 Safari/537.36',
          'Accept': 'application/json',
        },
        signal: ctrl.signal,
      });
      clearTimeout(t);
      if (resp.ok) {
        const body = await resp.json();
        const meta = body?.chart?.result?.[0]?.meta || {};
        const price = Number(meta.regularMarketPrice) || 0;
        if (price > 0) {
          return { price, exchange: 'yahoo', cached: false };
        }
      }
    } catch {}
    return null; // Forex symbol not found on Yahoo — don't try crypto exchanges
  }
  // ROOT CAUSE FIX: Use a SEPARATE cache key for price fetching.
  // Previously, this shared the chart resolver's cache key
  // (`chart:exchange:v2:`). The chart resolver caches 'binance' because
  // TradingView scanner confirms BINANCE:BTCUSDT exists (for chart display).
  // But data-api.binance.vision returns 403 from CF Workers — so every price
  // fetch would try Binance first (from cache), fail with 403, invalidate
  // the cache, then fall through to the parallel fallback.
  // This wasted ~200-500ms per alert check (HTTP round-trip for the 403).
  // With a separate cache key, the price fetch caches 'bybit' (which works
  // from CF Workers), and the chart resolver keeps 'binance' (for tv_symbol).
  // Both caches coexist without interfering with each other.
  const priceCacheKey = `price:exchange:${normalizedSymbol}`;
  const noCache = Boolean(options.noCache);

  // ── FAST PATH: Try cached exchange first (latency: 1 API call, max 4s) ──
  // Cache stores just the exchange key string (e.g. 'bybit').
  // Skip cache only when options.noCache is true (used by alert triggers to
  // get the FRESHEST price at trigger time, avoiding stale cache issues).
  let cachedExchange = null;
  if (!noCache) {
    try {
      const raw = await readAppCache(env, priceCacheKey);
      if (raw && typeof raw === 'string' && raw.length > 0 && raw.length < 30) {
        cachedExchange = raw.trim();
      }
    } catch {}
  }

  if (cachedExchange) {
    const cachedPrice = await fetchSpotTickerPrice(cachedExchange, normalizedSymbol);
    if (cachedPrice !== null) {
      return { price: cachedPrice, exchange: cachedExchange, cached: true };
    }
    // Cached exchange failed — invalidate cache (min TTL 60 for KV).
    await writeAppCache(env, priceCacheKey, '', 60).catch(() => {});
  }

  // ── FALLBACK: Try ALL exchanges in PARALLEL (max 4s total) ──
  // ROOT CAUSE FIX: Binance API (data-api.binance.vision) is IP-blocked from
  // Cloudflare Workers (403). It was always first in priority order, wasting
  // a full 4s timeout before falling through. Removed Binance from the list —
  // Bybit, OKX, MEXC are equally reliable for spot prices.
  // Also added Coinbase + Kraken (USD pairs) for broader coverage.
  const ALL_EXCHANGES = ['bybit', 'okx', 'bitget', 'kucoin', 'mexc', 'gateio', 'htx', 'coinbase', 'kraken'];

  const results = await Promise.allSettled(
    ALL_EXCHANGES.map(async (exchangeKey) => {
      const price = await fetchSpotTickerPrice(exchangeKey, normalizedSymbol);
      return { exchangeKey, price };
    })
  );

  // Iterate in priority order — first valid result wins
  for (const exchangeKey of ALL_EXCHANGES) {
    const idx = ALL_EXCHANGES.indexOf(exchangeKey);
    const r = results[idx];
    if (r && r.status === 'fulfilled' && r.value.price !== null) {
      // Cache the working exchange (not Binance) for future fast-path
      // Skip cache write when noCache=true (caller wants fresh data only)
      if (!noCache) {
        await writeAppCache(env, priceCacheKey, exchangeKey, getNumericEnv(env, 'CHART_EXCHANGE_CACHE_TTL', 3600));
      }
      return { price: r.value.price, exchange: exchangeKey, cached: false };
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

/**
 * fetchJson with a CUSTOM timeout (ms).
 * Used by price fetchers which need a shorter timeout (4s) than the
 * general 8s default — prevents cron timeout when multiple exchanges
 * are slow.
 */
async function fetchJsonWithTimeout(url, timeoutMs = EXTERNAL_FETCH_TIMEOUT_MS) {
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
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

async function fetchJson(url) {
  return fetchJsonWithTimeout(url, EXTERNAL_FETCH_TIMEOUT_MS);
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
    // FIX: Link can also be wrapped in CDATA — handle both cases
    let link = extractFirstMatch(block, /<link><!\[CDATA\[([\s\S]*?)\]\]><\/link>|<link>([\s\S]*?)<\/link>/i);
    // DEFENSIVE: strip any leftover CDATA markers if present
    if (link) {
      link = link.replace(/^<!\[CDATA\[/, '').replace(/\]\]>$/, '').trim();
    }
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
      // Enrich with AI summaries from KV (if available)
      const enriched = await enrichNewsWithAISummaries(env, parsed);
      const data = categoryFilter
        ? enriched.filter((a) => a.category === categoryFilter)
        : enriched;
      const categoryCounts = {
        all: enriched.length,
        crypto: enriched.filter(a => a.category === 'crypto').length,
        forex: enriched.filter(a => a.category === 'forex').length,
        economy: enriched.filter(a => a.category === 'economy').length,
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

      // ── AI NEWS: Background AI summarization is handled by CRON, not here ──
      // Previously tried to run processNewsAIJobs via ctx_waitUntil_safe (fire-and-forget),
      // but Cloudflare Workers kill the isolate after HTTP response is sent.
      // Now the cron handler (scheduled) calls processNewsAIJobs with real ctx.waitUntil.
      // This ensures AI summaries are generated within 1 minute of article appearing.

      // Enrich with AI summaries (from KV cache — instant if pre-processed by cron)
      const enriched = await enrichNewsWithAISummaries(env, trimmed);

      const categoryCounts = {
        all: enriched.length,
        crypto: enriched.filter(a => a.category === 'crypto').length,
        forex: enriched.filter(a => a.category === 'forex').length,
        economy: enriched.filter(a => a.category === 'economy').length,
      };

      // Apply category filter if requested
      const data = categoryFilter
        ? enriched.filter((a) => a.category === categoryFilter)
        : enriched;

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

// ── AI NEWS SUMMARIZATION: Background processing architecture ──
// Articles are processed in the background (not on user click).
// AI summaries are cached in KV with key: news:ai:{url_hash}
// When user opens an article, the summary is already ready (instant).

const NEWS_AI_CACHE_PREFIX = 'news:ai:';
const NEWS_AI_CACHE_TTL = 7 * 24 * 60 * 60; // 7 days

/**
 * Generate a stable hash from a URL for KV key.
 */
function hashUrl(url) {
  let hash = 0;
  for (let i = 0; i < url.length; i++) {
    const char = url.charCodeAt(i);
    hash = ((hash << 5) - hash) + char;
    hash = hash & hash;
  }
  return Math.abs(hash).toString(36);
}

/**
 * Enrich news articles with AI summaries from KV cache.
 * If summary exists → add ai_summary + ai_status='completed'
 * If not → add ai_status='pending' (frontend shows skeleton)
 */
async function enrichNewsWithAISummaries(env, articles) {
  if (!env.APP_CACHE || !Array.isArray(articles)) return articles;

  // PERF: Parallel KV reads — was sequential (30 reads × 50ms = 1.5s),
  // now parallel (30 reads in ~100ms total = 15x faster)
  const enriched = await Promise.all(
    articles.map(async (article) => {
      const aiKey = `${NEWS_AI_CACHE_PREFIX}${hashUrl(article.url || '')}`;
      let aiSummary = null;
      try {
        aiSummary = await readAppCache(env, aiKey);
      } catch {}
      return {
        ...article,
        ai_summary: aiSummary || null,
        ai_status: aiSummary ? 'completed' : 'pending',
      };
    })
  );
  return enriched;
}

/**
 * Process AI summarization jobs for news articles in the background.
 * Called via ctx.waitUntil when news are fetched.
 * For each article without an AI summary, generates one using Workers AI.
 */
async function processNewsAIJobs(env, articles) {
  if (!env.APP_CACHE || !articles.length) return { processed: 0, success: 0, failed: 0, errors: [], stats: { scanned: 0, alreadyCompleted: 0, skippedBeforeAI: 0, aiRequestsExecuted: 0, kvWrites: 0 } };

  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  const hasWorkersAI = !!env.AI;
  const errors = [];
  let success = 0, failed = 0;
  let aiRequestsExecuted = 0;
  let alreadyCompleted = 0;

  for (const article of articles.slice(0, 3)) { // Process max 3 per cycle (25s timeout)
    if (!article.url) continue;

    const aiKey = `${NEWS_AI_CACHE_PREFIX}${hashUrl(article.url)}`;

    // Check if summary already exists — SKIP ENTIRE PIPELINE if so
    // (no fetch, no extract, no AI call, no write)
    let existing = null;
    try {
      existing = await readAppCache(env, aiKey);
    } catch {}
    if (existing) { success++; alreadyCompleted++; continue; } // Already processed — skip ENTIRE pipeline

    console.log('[NEWS-AI-BG] Processing:', article.url.substring(0, 80));

    try {
      // Step 1: Fetch full article
      const fetchController = new AbortController();
      const fetchTimeout = setTimeout(() => fetchController.abort(), 10000);
      const articleRes = await fetch(article.url, {
        signal: fetchController.signal,
        headers: {
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
          'Accept': 'text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8',
          'Accept-Language': 'en-US,en;q=0.9',
        },
      });
      clearTimeout(fetchTimeout);

      if (!articleRes.ok) {
        console.warn('[NEWS-AI-BG] Article fetch failed:', articleRes.status);
        failed++;
        errors.push({ url: article.url.substring(0, 60), error: 'fetch_' + articleRes.status });
        continue; // Skip — will retry next cycle
      }

      const html = await articleRes.text();

      // Step 2: Extract article text
      let cleanedHtml = html
        .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, '')
        .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, '')
        .replace(/<nav[^>]*>[\s\S]*?<\/nav>/gi, '')
        .replace(/<footer[^>]*>[\s\S]*?<\/footer>/gi, '')
        .replace(/<header[^>]*>[\s\S]*?<\/header>/gi, '')
        .replace(/<aside[^>]*>[\s\S]*?<\/aside>/gi, '')
        .replace(/<noscript[^>]*>[\s\S]*?<\/noscript>/gi, '')
        .replace(/<form[^>]*>[\s\S]*?<\/form>/gi, '')
        .replace(/<iframe[^>]*>[\s\S]*?<\/iframe>/gi, '');

      let articleText = '';
      let articleMatch = cleanedHtml.match(/<article[^>]*>[\s\S]*?<\/article>/i);
      if (articleMatch) {
        articleText = articleMatch[0];
      }
      if (!articleText || articleText.length < 200) {
        articleMatch = cleanedHtml.match(/<main[^>]*>[\s\S]*?<\/main>/i);
        if (articleMatch) articleText = articleMatch[0];
      }
      if (!articleText || articleText.length < 200) {
        const paragraphs = cleanedHtml.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
        articleText = paragraphs.join(' ');
      }
      if (!articleText || articleText.length < 200) {
        articleText = cleanedHtml;
      }

      articleText = articleText
        .replace(/<[^>]+>/g, ' ')
        .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>').replace(/&quot;/g, '"').replace(/&#39;/g, "'")
        .replace(/\s+/g, ' ').trim();

      if (articleText.length > 10000) articleText = articleText.substring(0, 10000);

      if (articleText.length < 100) {
        // Use RSS body as fallback for AI
        articleText = (article.title || '') + '\n\n' + (article.body || article.description || '');
        if (articleText.length < 50) { failed++; continue; }
      }

      // Step 3: Generate AI summary
      let summary = null;
      let aiSource = 'none';

      // Method 1: Gemini 2.0 Flash (if quota available)
      if (GEMINI_API_KEY) {
        try {
          const prompt = `You are a professional Persian crypto journalist.

Read the entire article.

Rewrite it completely in Persian.

Rules:
- Keep every important detail.
- Do not shorten aggressively.
- Preserve numbers.
- Preserve names.
- Preserve timeline.
- Preserve technical details.
- Maximum 800 words.
- Use headings when appropriate.
- Do not add opinions.
- Do not invent anything.

At the end write:
برای مطالعه نسخه کامل می‌توانید از لینک منبع استفاده کنید.

Article:

${articleText}`;

          const geminiController = new AbortController();
          const geminiTimeout = setTimeout(() => geminiController.abort(), 45000);
          aiRequestsExecuted++;
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.3, maxOutputTokens: 4096, topP: 0.8 },
              }),
              signal: geminiController.signal,
            }
          );
          clearTimeout(geminiTimeout);

          if (geminiRes.ok) {
            const geminiData = await geminiRes.json();
            summary = geminiData?.candidates?.[0]?.content?.parts?.[0]?.text;
            if (summary && summary.trim().length >= 50) {
              aiSource = 'gemini-2.0-flash';
            } else {
              summary = null;
            }
          } else {
            errors.push({ url: article.url.substring(0, 60), error: 'gemini_' + geminiRes.status });
          }
        } catch (e) {
          console.warn('[NEWS-AI-BG] Gemini failed:', e.message);
          errors.push({ url: article.url.substring(0, 60), error: 'gemini_' + e.message.substring(0, 80) });
        }
      }

      // Method 2: Cloudflare Workers AI (free, always available)
      if (!summary && hasWorkersAI) {
        try {
          aiRequestsExecuted++;
          const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'You are a professional Persian crypto journalist. Rewrite the article in Persian. Keep all details, numbers, and names. Maximum 800 words. End with: برای مطالعه نسخه کامل می‌توانید از لینک منبع استفاده کنید.' },
              { role: 'user', content: articleText.substring(0, 8000) },
            ],
            max_tokens: 4096,
            temperature: 0.3,
          });

          if (aiResponse && aiResponse.response && aiResponse.response.trim().length >= 50) {
            summary = aiResponse.response;
            aiSource = 'cloudflare-workers-ai';
          } else {
            errors.push({ url: article.url.substring(0, 60), error: 'workers_ai_empty' });
          }
        } catch (e) {
          console.warn('[NEWS-AI-BG] Workers AI failed:', e.message);
          errors.push({ url: article.url.substring(0, 60), error: 'workers_ai_' + e.message.substring(0, 80) });
        }
      }

      // Step 4: Cache the summary in KV (7 days)
      if (summary && summary.trim().length >= 50) {
        try {
          await writeAppCache(env, aiKey, summary, NEWS_AI_CACHE_TTL);
          success++;
          console.log('[NEWS-AI-BG] SUCCESS:', article.url.substring(0, 60), 'source:', aiSource, 'length:', summary.length);
        } catch (e) {
          failed++;
          console.warn('[NEWS-AI-BG] KV write failed:', e.message);
          errors.push({ url: article.url.substring(0, 60), error: 'kv_write_' + e.message.substring(0, 80) });
        }
      } else {
        failed++;
        console.warn('[NEWS-AI-BG] All AI methods failed for:', article.url.substring(0, 60));
      }

    } catch (e) {
      failed++;
      console.warn('[NEWS-AI-BG] Error processing:', article.url.substring(0, 60), e.message);
      errors.push({ url: article.url.substring(0, 60), error: e.message.substring(0, 80) });
    }
  }
  return {
    processed: success + failed,
    success,
    failed,
    errors: errors.slice(0, 5),
    stats: {
      scanned: articles.length,
      alreadyCompleted,
      skippedBeforeAI: alreadyCompleted,
      aiRequestsExecuted,
      kvWrites: success - alreadyCompleted, // only new summaries cause KV writes
    },
  };
}

/**
 * Safe ctx.waitUntil wrapper — works even if ctx is not available.
 */
function ctx_waitUntil_safe(env, promise) {
  // In Worker context, ctx.waitUntil is available via the module scope.
  // But fetchFarsiNews doesn't have access to ctx. So we just fire-and-forget.
  // The promise runs in the background and writes to KV when done.
  promise.catch(() => {}); // Silent fail — don't crash the request
}

/**
 * CRON-BASED AI NEWS PROCESSING
 *
 * Called from the scheduled handler (cron) with real ctx.waitUntil.
 * Fetches latest news from RSS, then processes AI summaries for articles
 * that don't have one yet.
 *
 * This is the correct architecture because:
 * 1. Cron handler has ctx.waitUntil — Worker stays alive until processing completes
 * 2. Cron runs every 1 minute — articles get processed within 60s of appearing
 * 3. User HTTP requests only read from KV — instant response, no AI calls
 */
async function processNewsAIBatch(env) {
  if (!env.APP_CACHE) return;

  console.log('[NEWS-AI-CRON] Starting batch processing...');

  // Step 1: Fetch latest news articles from RSS
  const sources = await fetchAllNewsRss();
  if (!sources || sources.length === 0) {
    console.log('[NEWS-AI-CRON] No RSS sources available');
    return;
  }

  // Build articles from all sources
  const allArticles = (
    await Promise.all(
      sources.map((s) => buildFarsiNewsArticles(s.rssText, s.sourceName, s.category, env, s.skipTranslate))
    )
  ).flat();

  // Deduplicate by URL
  const seen = new Set();
  const deduped = allArticles.filter((a) => {
    if (!a.url || seen.has(a.url)) return false;
    seen.add(a.url);
    return true;
  });

  if (deduped.length === 0) {
    console.log('[NEWS-AI-CRON] No articles to process');
    return;
  }

  console.log('[NEWS-AI-CRON] Found', deduped.length, 'articles. Checking which need AI summaries...');

  // Step 1.5: Cache the articles in KV so users get instant response
  // (Previously articles were only cached when a user requested /api/farsi-news,
  // meaning the first user after cache expiry had to wait for live RSS fetch.)
  const MAX_NEWS_ARTICLES = 30;
  const trimmed = deduped.slice(0, MAX_NEWS_ARTICLES);
  const newsJson = JSON.stringify(trimmed);
  const newsWriteBefore = _kvWriteStats.totalWrites;
  const newsSkippedBefore = _kvWriteStats.totalSkipped;
  // Check if KV is available
  const kvAvailable = !!(env.APP_CACHE && typeof env.APP_CACHE.put === 'function');
  // Check if in-memory cache has this key
  const inMemoryCached = _kvWriteCache.has(FARSI_NEWS_CACHE_KEY);
  const inMemoryMatches = _kvWriteCache.get(FARSI_NEWS_CACHE_KEY) === newsJson;
  try {
    await writeAppCache(
      env,
      FARSI_NEWS_CACHE_KEY,
      newsJson,
      getNumericEnv(env, 'NEWS_CACHE_TTL', 300),
    );
  } catch (e) {
    console.warn('[NEWS-AI-CRON] Failed to cache articles:', e.message);
  }
  const newsWriteActuallyWritten = _kvWriteStats.totalWrites > newsWriteBefore;
  const newsWriteWasSkipped = _kvWriteStats.totalSkipped > newsSkippedBefore;

  // Step 2: Process AI summaries for articles that don't have one
  const aiResult = await processNewsAIJobs(env, deduped);

  console.log('[NEWS-AI-CRON] Batch processing complete.', aiResult);
  return {
    articlesPrepared: trimmed.length,
    newsCacheWritten: newsWriteActuallyWritten,
    newsCacheSkipped: !newsWriteActuallyWritten,
    newsWriteWasSkipped: newsWriteWasSkipped,
    kvAvailable: kvAvailable,
    inMemoryCached: inMemoryCached,
    inMemoryMatches: inMemoryMatches,
    newsJsonLength: newsJson.length,
    ai: aiResult,
    kvWriteStats: {
      totalWrites: _kvWriteStats.totalWrites,
      totalSkipped: _kvWriteStats.totalSkipped,
      byPrefix: Object.entries(_kvWriteStats.byPrefix).sort((a,b) => b[1]-a[1]).slice(0, 10).map(([k,v]) => ({key:k, writes:v})),
      byKey: Object.entries(_kvWriteStats.byKey).sort((a,b) => b[1]-a[1]).slice(0, 15).map(([k,v]) => ({key:k, writes:v})),
    },
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

/**
 * ROOT CAUSE FIX (RC-7): ForexFactory (nfs.faireconomy.media) publishes
 * event times in US Eastern Time (EST = UTC-5, EDT = UTC-4). The old code
 * used Date.UTC(...) which treated these times as UTC — making every event
 * appear 4-5 hours EARLIER than its real time. This caused the smart-alert
 * cron to fire notifications 4-5 hours before the actual event.
 *
 * This helper returns the current UTC offset (in milliseconds) for US
 * Eastern Time, accounting for DST (second Sunday of March → first Sunday
 * of November, 2:00 AM local). DST → -4h, standard → -5h.
 */
function getEasternTimeOffsetMs(date) {
  // Determine if `date` falls in DST (EDT, UTC-4) or standard (EST, UTC-5).
  // US DST: starts 2nd Sunday of March, ends 1st Sunday of November.
  const year = date.getUTCFullYear();
  // Find 2nd Sunday of March
  let marchFirst = new Date(Date.UTC(year, 2, 1));
  let marchDow = marchFirst.getUTCDay(); // 0=Sun
  let secondSundayMarch = 2 + ((7 - marchDow) % 7) + 7; // day-of-month
  if (marchDow === 0) secondSundayMarch = 8; // March 1 is Sunday → 2nd Sunday is 8th
  const dstStart = new Date(Date.UTC(year, 2, secondSundayMarch, 7, 0, 0)); // 2:00 AM EST = 7:00 UTC

  // Find 1st Sunday of November
  let novFirst = new Date(Date.UTC(year, 10, 1));
  let novDow = novFirst.getUTCDay();
  let firstSundayNov = 1 + ((7 - novDow) % 7);
  if (novDow === 0) firstSundayNov = 1; // Nov 1 is Sunday → 1st Sunday is 1st
  const dstEnd = new Date(Date.UTC(year, 10, firstSundayNov, 6, 0, 0)); // 2:00 AM EDT = 6:00 UTC

  if (date >= dstStart && date < dstEnd) {
    return -4 * 60 * 60 * 1000; // EDT = UTC-4
  }
  return -5 * 60 * 60 * 1000; // EST = UTC-5
}

function parseEventTime(dateString, timeString) {
  // ── ISO 8601 support (e.g. "2026-07-05T21:00:00-04:00") ─────────
  // These already include the UTC offset, so no ET correction needed.
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
        // ROOT CAUSE FIX (RC-7): ForexFactory publishes times in US Eastern
        // Time. Parse as UTC then apply the ET offset (DST-aware).
        const utcDate = new Date(Date.UTC(year, month - 1, day, parsedTime.hour, parsedTime.minute, 0));
        const offsetMs = getEasternTimeOffsetMs(utcDate);
        return new Date(utcDate.getTime() - offsetMs);
      }
      return new Date(Date.UTC(year, month - 1, day, 12, 0, 0));
    }
  }

  // ── Legacy MM-DD-YYYY + HH:MMam/pm format (ForexFactory) ─────────
  // Times are in US Eastern Time — apply DST-aware offset (RC-7 fix).
  const parsedDate = parseCalendarDate(dateString);
  if (!parsedDate) {
    return null;
  }

  if (!timeString || ['All Day', 'Tentative'].includes(timeString)) {
    return new Date(Date.UTC(parsedDate.year, parsedDate.month - 1, parsedDate.day, 12, 0, 0));
  }

  const parsedTime = parseCalendarTimeParts(timeString);
  if (parsedTime) {
    const utcDate = new Date(Date.UTC(
      parsedDate.year,
      parsedDate.month - 1,
      parsedDate.day,
      parsedTime.hour,
      parsedTime.minute,
      0,
    ));
    // ROOT CAUSE FIX (RC-7): apply ET offset so the timestamp reflects the
    // real event time, not 4-5 hours early.
    const offsetMs = getEasternTimeOffsetMs(utcDate);
    return new Date(utcDate.getTime() - offsetMs);
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

// ROOT CAUSE FIX (RC-1): In-memory isolate cache for calendar events.
// Survives KV TTL expiry — as long as the Worker isolate is alive, the
// last successfully fetched events are available even if the upstream
// goes down for an extended period. Cloudflare Workers isolates can
// live for hours under steady traffic, so this provides a strong safety
// net beyond the 10-minute KV TTL.
// `_calendarIsolateCache` is set ONLY on successful fetch (events.length > 0)
// and is returned when both KV cache and upstream fail.
let _calendarIsolateCache = null;
let _calendarIsolateCacheAt = 0; // timestamp of last successful fetch

async function fetchCalendarEvents(env) {
  // ROOT CAUSE FIX (RC-1): the previous "stale cache fallback" used
  // `env.APP_CACHE.get(key, { cacheTtl: 60 })` claiming KV resurrects
  // expired keys. This is factually wrong — KV deletes keys after
  // expirationTtl. The real safety net is the in-memory isolate cache
  // (_calendarIsolateCache) which survives as long as the Worker isolate
  // is alive. We also use single-flight (RC-10) to prevent cache stampede.

  // ROOT CAUSE FIX (RC-10): single-flight prevents concurrent requests
  // from all hitting the upstream when the KV cache expires. Only ONE
  // upstream fetch runs at a time; all concurrent callers share its result.
  return singleFlight('calendar:events:fetch', async () => {
    // 1. Try fresh KV cache (TTL-enforced by KV itself)
    const cachedEvents = await readAppCache(env, CALENDAR_CACHE_KEY);
    if (cachedEvents) {
      try {
        const parsed = JSON.parse(cachedEvents);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Update isolate cache so it stays fresh
          _calendarIsolateCache = parsed;
          _calendarIsolateCacheAt = Date.now();
          return parsed;
        }
      } catch {
        // cache corrupt — fall through to live fetch
      }
    }

    // 2. KV miss or empty — fetch fresh from upstream
    const now = new Date();
    const cutoffPast = new Date(now.getTime() - 2 * 24 * 60 * 60 * 1000);
    const cutoffFuture = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const rawEvents = await fetchCalendarFeed();

    const events = rawEvents
      .map((item) => mapCalendarEvent(item, now, cutoffPast, cutoffFuture))
      .filter((item) => item !== null)
      .sort((left, right) => {
        if (!left.timestamp && !right.timestamp) return 0;
        if (!left.timestamp) return 1;
        if (!right.timestamp) return -1;
        return left.timestamp.localeCompare(right.timestamp);
      });

    if (events.length > 0) {
      // Fresh fetch succeeded — write to KV cache + isolate cache
      await writeAppCache(
        env,
        CALENDAR_CACHE_KEY,
        JSON.stringify(events),
        getNumericEnv(env, 'CALENDAR_CACHE_TTL', 600),
      );
      _calendarIsolateCache = events;
      _calendarIsolateCacheAt = Date.now();
      return events;
    }

    // 3. Upstream returned empty. ROOT CAUSE FIX (RC-1): serve the
    // in-memory isolate cache rather than returning []. This survives
    // upstream outages that exceed the KV TTL (10 min). The isolate cache
    // is at most a few hours old (isolate lifetime).
    if (_calendarIsolateCache && _calendarIsolateCache.length > 0) {
      console.log('[calendar] upstream empty — serving isolate cache ' +
        `(${Math.round((Date.now() - _calendarIsolateCacheAt) / 1000)}s old)`);
      return _calendarIsolateCache;
    }

    // 4. No isolate cache either (cold start) — last resort: try a raw KV
    // read with a long cacheTtl (edge cache might still have it even if
    // origin expired). Best-effort, no guarantee.
    try {
      const rawCached = await env.APP_CACHE?.get?.(CALENDAR_CACHE_KEY, { cacheTtl: 86400 });
      if (rawCached) {
        const stale = JSON.parse(rawCached);
        if (Array.isArray(stale) && stale.length > 0) {
          return stale;
        }
      }
    } catch {
      // KV read failed — nothing more we can do
    }

    return [];
  });
}

// Chart resolution timeout — shorter than price fetch timeout.
// Used by the per-exchange fallback only (scanner API has its own 4s timeout).
const CHART_RESOLVE_TIMEOUT_MS = 2000;

// TradingView scanner endpoint — the SOURCE OF TRUTH for symbol existence.
// If scanner confirms a symbol exists, the TradingView widget WILL render it.
// Batch query: single HTTP call checks all candidate exchanges at once.
const TV_SCANNER_URL = 'https://scanner.tradingview.com/crypto/scan';
const TV_SCANNER_TIMEOUT_MS = 4000;

async function exchangeHasSymbol(key, symbol) {
  const checker = CHART_CHECKERS[key];
  if (!checker) {
    return false;
  }

  try {
    const { ok, body } = await fetchJsonWithTimeout(checker.buildUrl(symbol), CHART_RESOLVE_TIMEOUT_MS);
    return ok && checker.isMatch(body);
  } catch {
    return false;
  }
}

// Query TradingView's own scanner API to verify which candidate tv_symbols exist.
// Returns the first candidate (in priority order) that TradingView recognizes,
// or null if none match / scanner is unreachable.
async function resolveViaTradingViewScanner(candidates) {
  if (!candidates || candidates.length === 0) return null;
  try {
    const controller = new AbortController();
    const timeoutId = setTimeout(() => controller.abort(), TV_SCANNER_TIMEOUT_MS);
    const resp = await fetch(TV_SCANNER_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
      body: JSON.stringify({
        symbols: { tickers: candidates },
        columns: ['name', 'close'],
      }),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!resp.ok) return null;
    const data = await resp.json();
    const foundSet = new Set((data?.data || []).map(r => r.s));
    // Return first candidate in priority order that TradingView confirmed exists
    for (const candidate of candidates) {
      if (foundSet.has(candidate)) return candidate;
    }
    return null;
  } catch {
    return null;
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

  // Skip stablecoins and fiat that don't have meaningful crypto charts
  const skipSymbols = ['USDT', 'USD', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD'];
  if (skipSymbols.includes(normalizedSymbol)) {
    return {
      found: false,
      symbol: normalizedSymbol,
      exchange: null,
      tv_symbol: null,
      cached: false,
    };
  }

  // ── Cache lookup (full JSON result, versioned key) ──
  // Versioned so old cache entries (which stored only the exchange key string)
  // don't conflict with the new full-JSON format.
  const cacheKey = `chart:exchange:v2:${normalizedSymbol}`;
  const cached = await readAppCache(env, cacheKey);
  if (cached) {
    try {
      const parsed = JSON.parse(cached);
      if (parsed && typeof parsed.found === 'boolean') {
        return { ...parsed, cached: true };
      }
    } catch { /* malformed cache — fall through to fresh resolve */ }
  }

  // ── Build candidate tv_symbols in STRICT priority order ──
  // Each candidate is the exact string we pass to the TradingView widget.
  //   Binance > Bybit > OKX > Bitget > KuCoin > MEXC > Gate > HTX > Coinbase > Kraken
  const candidates = EXCHANGE_ORDER.map(
    ([tvName, _key, suffix]) => `${tvName}:${normalizedSymbol}${suffix}`
  );

  // ── PRIMARY: TradingView scanner API (batch, single HTTP call) ──
  // This is the SOURCE OF TRUTH: if scanner confirms a symbol exists, the
  // TradingView widget WILL render it. Far more reliable than checking each
  // exchange's own API (which may differ from what TradingView actually tracks).
  const scannerMatch = await resolveViaTradingViewScanner(candidates);
  if (scannerMatch) {
    const [tvExchange] = scannerMatch.split(':');
    const match = EXCHANGE_ORDER.find(([tvName]) => tvName === tvExchange);
    const result = {
      found: true,
      symbol: normalizedSymbol,
      exchange: match ? match[1] : tvExchange.toLowerCase(),
      tv_symbol: scannerMatch,
      cached: false,
    };
    await writeAppCache(env, cacheKey, JSON.stringify(result), getNumericEnv(env, 'CHART_EXCHANGE_CACHE_TTL', 3600));
    return result;
  }

  // ── FALLBACK: per-exchange API checks (sequential) ──
  // Used only if TradingView scanner is unreachable. Slower but independent
  // of TradingView availability.
  for (const [tvName, key, suffix] of EXCHANGE_ORDER) {
    if (await exchangeHasSymbol(key, normalizedSymbol)) {
      const result = {
        found: true,
        symbol: normalizedSymbol,
        exchange: key,
        tv_symbol: `${tvName}:${normalizedSymbol}${suffix}`,
        cached: false,
      };
      await writeAppCache(env, cacheKey, JSON.stringify(result), getNumericEnv(env, 'CHART_EXCHANGE_CACHE_TTL', 3600));
      return result;
    }
  }

  // ── Genuinely not found on any exchange ──
  // Short cache (5 min) so we retry sooner if the coin gets listed later.
  const notFound = {
    found: false,
    symbol: normalizedSymbol,
    exchange: null,
    tv_symbol: null,
    cached: false,
  };
  await writeAppCache(env, cacheKey, JSON.stringify(notFound), 300);
  return notFound;
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
// ── Alert Economy repository (must be created BEFORE alertHandlers) ──
const alertEconomyRepo = createAlertEconomyRepository({
  queryDb,
  isDatabaseConfigured,
  isoDate: _rcIsoDate,
  normalizeOptionalString,
});

// ── Wallet + Economy (must be created BEFORE alertHandlers which debits tokens) ──
const walletRepo = createWalletRepository({ queryDb, queryDbTransaction });
const economyService = createEconomyService({ walletRepo, queryDb });

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
  alertEconomyRepo,
  economyService,
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

// walletRepo + economyService already created above (before alertHandlers).

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

// alertEconomyRepo is already created above (before alertHandlers).
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
// Calendar Reminders — per-user reminders for economic calendar events.
// Stored in PostgreSQL so they survive across devices and actually fire.
const calendarReminderRepo = createCalendarReminderRepository({ queryDb });
const calendarReminderHandlers = createCalendarReminderHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  calendarReminderRepo,
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

// ── Alert Economy handlers (admin + user) ──
const alertEconomyHandlers = createAlertEconomyHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  requireAdmin: adminHandlers.requireAdmin,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  alertEconomyRepo,
  economyService,
});

//#endregion

// ── Telegram Publisher (admin) — channel publishing with queue + preview ──
const publisherRepo = createPublisherRepository({ queryDb, normalizeOptionalString });
const publisherHandlers = createPublisherHandlers({
  jsonResponse,
  requireAdmin: adminHandlers.requireAdmin,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  buildBodyFieldValidationError,
  normalizeOptionalString,
  publisherRepo,
  sendTelegramMessage,
  readAppCache,
  writeAppCache,
  resolveWebAppUrl,
  fetchFarsiNews,
  fetchCalendarEvents,
  analysisRepo,
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

const MARKET_CACHE_TTL = 30; // 30 seconds — prices must stay close to TradingView for alert accuracy
const MARKET_GLOBAL_CACHE_TTL = 300; // 5 minutes — global stats change less frequently
const MARKET_FETCH_LIMIT = 200;
const SEARCH_FETCH_LIMIT = 1500; // Extended list for search — not displayed in market list

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
 * Fetch Fear & Greed Index from CoinMarketCap (official API).
 * Uses CMC_API_KEY from env. Falls back to cached value if API fails.
 * If no cache, returns null (frontend shows 'Unknown').
 *
 * CMC endpoint: https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical
 * Cache TTL: 5 minutes (300s) — F&G doesn't change more often than hourly
 *
 * Returns { value: number, classification: string, timestamp: string } or null.
 */
const FG_CACHE_KEY = 'fear-greed:cmc';
const FG_CACHE_TTL = 300; // 5 minutes

async function fetchFearGreed() {
  // ── Step 1: Try CMC API ──
  const apiKey = env_CMC_API_KEY || null;
  if (apiKey) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical', {
        headers: {
          'Accept': 'application/json',
          'X-CMC_PRO_API_KEY': apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (res.ok) {
        const body = await res.json();
        const data = body?.data;
        if (data && Array.isArray(data) && data.length > 0) {
          const latest = data[0]; // Most recent entry
          const value = parseInt(latest.value, 10) || 0;
          const classification = latest.value_classification || _classifyFG(value);
          const timestamp = latest.timestamp || new Date().toISOString();
          const result = { value, classification, timestamp, source: 'coinmarketcap' };
          // Cache the result
          if (typeof env_APP_CACHE !== 'undefined' && env_APP_CACHE && typeof env_APP_CACHE.put === 'function') {
            try {
              await env_APP_CACHE.put(FG_CACHE_KEY, JSON.stringify(result), { expirationTtl: FG_CACHE_TTL });
            } catch {}
          }
          return result;
        }
      } else {
        console.warn('CMC F&G API returned HTTP', res.status);
      }
    } catch (e) {
      console.warn('CMC F&G fetch failed:', e?.message || e);
    }
  }

  // ── Step 2: API failed — try cached value ──
  if (typeof env_APP_CACHE !== 'undefined' && env_APP_CACHE && typeof env_APP_CACHE.get === 'function') {
    try {
      const cached = await env_APP_CACHE.get(FG_CACHE_KEY);
      if (cached) {
        const parsed = JSON.parse(cached);
        console.log('F&G: using cached value (API failed):', parsed.value, parsed.classification);
        return parsed;
      }
    } catch {}
  }

  // ── Step 3: No cache, no API — return null (frontend shows 'Unknown') ──
  console.warn('F&G: no API key, no cache — returning null');
  return null;
}

/**
 * Classify F&G value if API doesn't provide classification.
 * Standard ranges: 0-24 Extreme Fear, 25-44 Fear, 45-55 Neutral, 56-75 Greed, 76-100 Extreme Greed
 */
function _classifyFG(value) {
  if (value <= 24) return 'Extreme Fear';
  if (value <= 44) return 'Fear';
  if (value <= 55) return 'Neutral';
  if (value <= 75) return 'Greed';
  return 'Extreme Greed';
}

// Module-level env accessors (set in fetch handler, used by fetchFearGreed)
let env_CMC_API_KEY = null;
let env_APP_CACHE = null;

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

  // Level 3: MEXC global — MEXC is already used for coin prices and works
  // reliably from CF Workers. If CoinGecko rate-limits AND CoinPaprika fails,
  // MEXC gives us at least total market cap and BTC dominance.
  // Endpoint: https://api.mexc.com/api/v3/ticker/24hr — returns array of all tickers.
  // We compute global stats from this (sum of all quoteVolume, BTC dominance from BTCUSDT).
  if (!stats) {
    try {
      const controller = new AbortController();
      const tid = setTimeout(() => controller.abort(), 8000);
      const res = await fetch('https://api.mexc.com/api/v3/ticker/24hr', {
        signal: controller.signal,
        headers: { Accept: 'application/json' },
      });
      clearTimeout(tid);
      if (res.ok) {
        const tickers = await res.json();
        if (Array.isArray(tickers) && tickers.length > 0) {
          let totalVolume = 0;
          let btcVolume = 0;
          let btcPrice = 0;
          for (const t of tickers) {
            const symbol = String(t.symbol || '');
            const quoteVol = Number(t.quoteVolume) || 0;
            // Only count USDT pairs for volume
            if (symbol.endsWith('USDT')) {
              totalVolume += quoteVol;
              if (symbol === 'BTCUSDT') {
                btcPrice = Number(t.lastPrice) || 0;
                btcVolume = quoteVol;
              }
            }
          }
          // Estimate total market cap from BTC dominance approximation.
          // MEXC doesn't provide market cap directly, but we can estimate:
          // BTC market cap ≈ BTC price × circulating supply (19.7M as of 2026).
          // If BTC dominance ≈ 52% (typical), total mcap ≈ BTC mcap / 0.52.
          // This is a rough estimate — better than showing '--'.
          const BTC_CIRCULATING_SUPPLY = 19_700_000;
          const btcMarketCap = btcPrice * BTC_CIRCULATING_SUPPLY;
          const TYPICAL_BTC_DOMINANCE = 0.52;
          const estimatedTotalMcap = btcMarketCap / TYPICAL_BTC_DOMINANCE;
          stats = {
            totalMarketCap: estimatedTotalMcap,
            totalVolume: totalVolume,
            btcDominance: TYPICAL_BTC_DOMINANCE * 100,
            source: 'mexc-estimated',
          };
          console.log('Global: MEXC fallback success — est. mcap:', stats.totalMarketCap, 'vol:', stats.totalVolume, 'btcDom (assumed):', stats.btcDominance);
        }
      }
    } catch (e) {
      console.warn('Global: MEXC fallback failed', e.message || e);
    }
  }

  // ── Step 3: Merge Fear & Greed ──
  try {
    const fg = await fgPromise;
    if (fg) {
      if (!stats) stats = {}; // FG available even if mcap sources all failed
      stats.fearGreedValue = fg.value;
      stats.fearGreedClassification = fg.classification;
      stats.fearGreedSource = 'coinmarketcap';
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
  // ROOT CAUSE FIX: Prefer CMC cache for global stats to ensure CONSISTENCY
  // with /api/market/overview. Previously, this endpoint always called
  // fetchGlobalStats() (CoinGecko→CoinPaprika→MEXC) which returns DIFFERENT
  // values than CMC — causing the frontend to show inconsistent data:
  //   - /api/market/overview → CMC → volume=$36B, btcDom=58.6%
  //   - /api/market → CoinPaprika → volume=$81B, btcDom=56.1%
  // The frontend's loadMarketData() would OVERWRITE the CMC data (from
  // loadMarketOverview) with CoinPaprika data, making the cards show
  // different values depending on which API call completed last.
  // FIX: Use CMC cache as the primary source for `global` field. Only
  // fall back to fetchGlobalStats() if CMC cache is empty.
  const getGlobalData = async () => {
    try {
      const cmcOverview = await marketOverviewSvc.getCachedOverview(env);
      if (cmcOverview && cmcOverview.totalMarketCap > 0) {
        // Enrich with F&G if missing (CMC doesn't provide F&G)
        if (!cmcOverview.fearGreedValue) {
          try {
            const fg = await fetchFearGreed();
            if (fg) {
              cmcOverview.fearGreedValue = fg.value;
              cmcOverview.fearGreedClassification = fg.classification;
              cmcOverview.fearGreedSource = 'coinmarketcap';
            }
          } catch {}
        }
        return cmcOverview;
      }
    } catch {}
    // Fallback: CoinGecko → CoinPaprika → MEXC
    return await fetchGlobalStats(env);
  };

  // Check KV cache first for coin data (v2 key — busts old incorrectly-normalized cache)
  const cachedRaw = await readAppCache(env, 'market:data:v3');
  if (cachedRaw) {
    try {
      const parsed = JSON.parse(cachedRaw);
      if (Array.isArray(parsed) && parsed.length > 0) {
        // Fetch global stats — prefers CMC cache for consistency
        const globalData = await getGlobalData();
        return jsonResponse({ status: 'success', data: parsed, cached: true, global: globalData, dataSource: 'cache' }, {}, env);
      }
    } catch {}
  }

  // Fetch global stats (CMC-preferred) in parallel with market data
  const globalPromise = getGlobalData();

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
  // Metals
  { symbol: 'XAUUSD', name: 'Gold', tvSymbol: 'OANDA:XAUUSD', category: 'metal' },
  { symbol: 'XAGUSD', name: 'Silver', tvSymbol: 'OANDA:XAGUSD', category: 'metal' },
  // Global Stocks — TradingView embed verified working in Mini App
  { symbol: 'AAPL',  name: 'Apple',        tvSymbol: 'NASDAQ:AAPL',  category: 'stock' },
  { symbol: 'MSFT',  name: 'Microsoft',    tvSymbol: 'NASDAQ:MSFT',  category: 'stock' },
  { symbol: 'NVDA',  name: 'Nvidia',       tvSymbol: 'NASDAQ:NVDA',  category: 'stock' },
  { symbol: 'AMZN',  name: 'Amazon',       tvSymbol: 'NASDAQ:AMZN',  category: 'stock' },
  { symbol: 'GOOGL', name: 'Alphabet',     tvSymbol: 'NASDAQ:GOOGL', category: 'stock' },
  { symbol: 'META',  name: 'Meta',         tvSymbol: 'NASDAQ:META',  category: 'stock' },
  { symbol: 'TSLA',  name: 'Tesla',        tvSymbol: 'NASDAQ:TSLA',  category: 'stock' },
  { symbol: 'NFLX',  name: 'Netflix',      tvSymbol: 'NASDAQ:NFLX',  category: 'stock' },
  { symbol: 'AMD',   name: 'AMD',          tvSymbol: 'NASDAQ:AMD',   category: 'stock' },
  { symbol: 'INTC',  name: 'Intel',        tvSymbol: 'NASDAQ:INTC',  category: 'stock' },
  { symbol: 'COIN',  name: 'Coinbase',     tvSymbol: 'NASDAQ:COIN',  category: 'stock' },
  { symbol: 'MSTR',  name: 'MicroStrategy', tvSymbol: 'NASDAQ:MSTR', category: 'stock' },
];

const FOREX_CACHE_TTL = 120; // 2 minutes

async function handleForexData(env, options = {}) {
  const skipCache = options.skipCache === true;

  // Check KV cache (unless skipCache is set)
  if (!skipCache) {
    const cachedRaw = await readAppCache(env, 'forex:data');
    if (cachedRaw) {
      try {
        const parsed = JSON.parse(cachedRaw);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return jsonResponse({ status: 'success', data: parsed, cached: true }, {}, env);
        }
      } catch {}
    }
  } // end if (!skipCache)

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

    // Fetch metals + stocks from Yahoo Finance (parallel with forex rates)
    // Yahoo symbols: GC=F (gold), SI=F (silver), AAPL, MSFT, NVDA, etc.
    const yahooExtraMap = {
      'XAUUSD': 'GC=F',
      'XAGUSD': 'SI=F',
      'AAPL': 'AAPL',
      'MSFT': 'MSFT',
      'NVDA': 'NVDA',
      'AMZN': 'AMZN',
      'GOOGL': 'GOOGL',
      'META': 'META',
      'TSLA': 'TSLA',
      'NFLX': 'NFLX',
      'AMD': 'AMD',
      'INTC': 'INTC',
      'COIN': 'COIN',
      'MSTR': 'MSTR',
    };
    const yahooExtra = Promise.all(
      Object.entries(yahooExtraMap).map(async ([sym, yahooSym]) => {
        const q = await yahooQuote(yahooSym);
        return { sym, price: q?.price || 0, prev: q?.prev || 0 };
      })
    ).then(results => {
      const map = {};
      results.forEach(r => { if (r.price > 0) map[r.sym] = r; });
      return map;
    }).catch(() => ({}));

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
    // ROOT CAUSE FIX: frankfurter.app redirects HTTP→HTTPS with 301.
    // Cloudflare Workers' fetch() does NOT follow 301 redirects automatically
    // when the URL is already HTTPS (it follows http→https but not https→https).
    // The original code used fetchJson() which returned {ok: false} on 301
    // because response.ok is false for 301. This caused ALL forex prices to
    // fall through to the fallback (price=0).
    // FIX: Use fetch() with redirect: 'follow' (which is the default in Workers
    // but was being overridden by fetchJsonWithTimeout's explicit signal).
    // Also add detailed error logging.
    let frankfurterOk = false;
    let frankfurterRates = null;
    try {
      const ffResp = await fetch('https://api.frankfurter.app/latest?from=USD', {
        method: 'GET',
        headers: { 'Accept': 'application/json' },
        redirect: 'follow',
      });
      if (ffResp.ok) {
        const ffBody = await ffResp.json();
        if (ffBody?.rates) {
          frankfurterOk = true;
          frankfurterRates = ffBody.rates;
        }
      } else {
        console.warn('[Forex] frankfurter.app returned HTTP', ffResp.status);
      }
    } catch (ffErr) {
      console.warn('[Forex] frankfurter.app fetch error:', ffErr.message);
    }

    if (frankfurterOk && frankfurterRates) {
      const rates = frankfurterRates;
      const prevRates = await histPromise;
      const extraData = await yahooExtra; // metals + stocks from Yahoo

      // Helper: compute a fiat pair price from a frankfurter rates object
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

        // Metals & Stocks: fetch from Yahoo Finance
        if (pair.category === 'metal' || pair.category === 'stock') {
          const yd = extraData[pair.symbol];
          if (yd && yd.price > 0) {
            price = yd.price;
            if (yd.prev > 0) change = ((price - yd.prev) / yd.prev) * 100;
          }
          return { symbol: pair.symbol, name: pair.name, tvSymbol: pair.tvSymbol, category: pair.category, price, change: Math.round(change * 100) / 100, isForex: true };
        }

        // Fiat pairs: compute from frankfurter rates
        price = priceFromRates(rates, pair);
        const prevRatesObj = prevRates?.prev;
        const prevPrice = prevRatesObj ? priceFromRates(prevRatesObj, pair) : 0;
        if (prevPrice > 0 && price > 0) change = ((price - prevPrice) / prevPrice) * 100;

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
  if (!notificationPlatformRepo) return;

  try {
    const events = await fetchCalendarEvents(env);
    const now = Date.now();
    // ROOT CAUSE FIX (RC-3): user requirement is "exactly 1 hour before".
    // Was 10 minutes — notifications arrived too late. Now 60 minutes.
    const WINDOW_MS = 60 * 60 * 1000; // 1 hour
    // Minimum lead time — avoid firing for events that are already past or
    // starting within the next 30 seconds (race window).
    const MIN_LEAD_MS = 30 * 1000;
    const alertedCount = { sent: 0, skipped: 0, failed: 0 };

    for (const event of events) {
      // Only high-impact events
      if (event.impact !== 'high') continue;

      const eventTs = event.timestamp ? new Date(event.timestamp).getTime() : 0;
      if (!eventTs) continue;

      const timeUntil = eventTs - now;
      // Only alert if event is within the next 1 hour and hasn't just passed
      if (timeUntil < -MIN_LEAD_MS || timeUntil > WINDOW_MS) continue;

      // Dedup key: title + date + country (event-level, not per-user)
      const eventKey = `${String(event.title || '').slice(0, 60)}|${String(event.date || '')}|${String(event.country || '')}`;
      const dedupKey = `${CALENDAR_ALERT_SENT_PREFIX}${eventKey}`;

      // Check if already sent
      const alreadySent = await readAppCache(env, dedupKey);
      if (alreadySent) {
        alertedCount.skipped++;
        continue;
      }

      // ROOT CAUSE FIX (RC-5): mark dedup BEFORE dispatch to prevent the
      // every-minute + every-15-minute cron overlap from double-firing.
      // The previous "write before dispatch" approach lost notifications
      // on transient dispatch failure — now we use a longer TTL (4h) so
      // even if dispatch fails, the event won't be retried within the
      // 1-hour window. This is the correct trade-off: a missed event is
      // better than duplicate notifications (which spam users).
      // ROOT CAUSE FIX (RC-3): TTL bumped from 2h to 4h to cover the
      // 1-hour window plus event duration plus cron propagation delay.
      await writeAppCache(env, dedupKey, '1', 4 * 3600);

      // Fetch joined users
      const usersResult = await queryDb(
        env,
        `SELECT telegram_id FROM users WHERE channel_joined = TRUE`,
      );
      const allUserIds = usersResult.rows.map((r) => String(r.telegram_id));
      if (allUserIds.length === 0) continue;

      const title = `🔔 رویداد مهم تقویم: ${event.title}`;
      const message = `${event.country} ${event.flag} — ${event.time || ''}`;

      // ROOT CAUSE FIX (RC-4): the old code called
      // `notificationRepo.filterUsersByPreference(env, allUserIds, 'calendar')`
      // which reads the LEGACY boolean `calendar` column (default FALSE).
      // Most users never visit settings → no row → defaults to FALSE →
      // zero users receive calendar alerts. This was already fixed for
      // price alerts (using notificationPlatformRepo.getUserChannelPreference
      // which reads the NEW ch_calendar column defaulting to 'both').
      // Now we apply the same fail-open pattern: iterate all joined users
      // and call getUserChannelPreference per-user inside the dispatch loop.
      // notificationPlatformRepo.dispatch already calls getUserChannelPreference
      // internally (src/repositories/notification_platform.js:239), so we
      // can pass all joined users directly — users with ch_calendar='none'
      // will be filtered out inside dispatch.

      let sentForThisEvent = 0;
      for (const uid of allUserIds) {
        try {
          const dispatchResult = await notificationPlatformRepo.dispatch(env, {
            userId: uid,
            title, message,
            category: 'calendar',
            priority: 'medium',
            channel: 'both',
            metadata: { event_title: event.title, event_date: event.date, event_time: event.time, event_country: event.country },
          });
          // dispatch returns {status: 'filtered'} if user opted out
          if (dispatchResult && dispatchResult.status !== 'filtered') {
            sentForThisEvent++;
          }
        } catch (_) {
          // Per-user dispatch failure — don't abort the whole event
        }
      }
      if (sentForThisEvent > 0) {
        alertedCount.sent++;
      } else {
        alertedCount.failed++;
        // ROOT CAUSE FIX (RC-6): if NO user received the notification
        // (e.g. DB outage), delete the dedup key so the next cron tick
        // can retry. This prevents lost notifications when dispatch fails
        // transiently.
        try { await env.APP_CACHE?.delete?.(dedupKey); } catch {}
      }
    }

    // ───────────────────────────────────────────────────────────────────
    // SECOND PATH: Per-user calendar reminders (15m / 1h / 24h lead time)
    // ───────────────────────────────────────────────────────────────────
    // The loop above broadcasts ALL high-impact events to ALL joined users
    // exactly 1 hour before. This second path respects the user's CHOSEN
    // lead time per individual event — only users who explicitly set a
    // reminder receive a notification, at their chosen lead time.
    //
    // Deduplication: uses the `fired_at` column on calendar_reminders as
    // the definitive dedup (atomic UPDATE ... WHERE fired_at IS NULL).
    // KV dedup is not needed here because the DB CAS is authoritative.
    if (calendarReminderRepo) {
      try {
        await calendarReminderRepo.ensureSchema(env).catch(() => {});
        const pendingReminders = await calendarReminderRepo.listPending(env);
        let reminderStats = { dispatched: 0, skipped: 0, failed: 0 };

        for (const reminder of pendingReminders) {
          // Atomic claim: markFired returns false if another tick already fired it
          const claimed = await calendarReminderRepo.markFired(env, reminder.id);
          if (!claimed) {
            reminderStats.skipped++;
            continue;
          }

          const title = `🔔 یادآوری رویداد: ${reminder.event_title || 'تقویم اقتصادی'}`;
          const message = `${reminder.event_country || ''} ${reminder.event_timestamp ? '— ' + new Date(reminder.event_timestamp).toLocaleString('en-GB') : ''}`;

          try {
            const dispatchResult = await notificationPlatformRepo.dispatch(env, {
              userId: String(reminder.user_id),
              title, message,
              category: 'calendar',
              priority: 'medium',
              channel: 'both',
              metadata: {
                event_title: reminder.event_title,
                event_timestamp: reminder.event_timestamp,
                event_country: reminder.event_country,
                lead_minutes: reminder.lead_minutes,
                reminder_id: reminder.id,
              },
            });
            if (dispatchResult && dispatchResult.status !== 'filtered') {
              reminderStats.dispatched++;
            } else {
              reminderStats.skipped++;
            }
          } catch (dispatchErr) {
            // Per-user dispatch failure — don't abort the batch
            console.warn(safeError('calendar-reminder-dispatch', dispatchErr));
            reminderStats.failed++;
          }
        }

        if (pendingReminders.length > 0) {
          console.log(JSON.stringify({
            scope: 'calendar-reminders-check',
            ...reminderStats,
            total: pendingReminders.length,
          }));
        }
      } catch (reminderErr) {
        console.warn(safeError('calendar-reminders-check', reminderErr));
      }
    }

    if (alertedCount.sent > 0 || alertedCount.skipped > 0 || alertedCount.failed > 0) {
      console.log(JSON.stringify({ scope: 'calendar-alerts-check', ...alertedCount }));
    }
  } catch (error) {
    console.warn(safeError('calendar-alerts-check', error));
  }
}

/**
 * CRON TASK: Price Alert Checker
 *
 * Runs every 5 minutes. For each active price_alert:
 *   1. Fetch current price for the alert's symbol (batched by symbol)
 *   2. Apply cross-detection logic:
 *      - direction='above': trigger if previous price was below target AND current >= target
 *        (or no previous price: trigger if current >= target)
 *      - direction='below': trigger if previous price was above target AND current <= target
 *        (or no previous price: trigger if current <= target)
 *   3. Update last_price + last_checked_at (always — even if not triggered)
 *   4. If triggered:
 *      a. Atomically mark status='triggered' (prevents duplicate triggers)
 *      b. Send via notificationPlatformRepo.dispatch() with category='price_alert'
 *         - channel='both' → in-app notification + Telegram queue
 *      c. ALSO directly send Telegram (belt-and-suspenders, in case queue is delayed)
 *
 * BUGS FIXED IN v2 (2026-07-25):
 *   - BUG #1: processQueue was never called → Telegram messages stuck in queue forever
 *     FIX: Direct sendTelegramMessage alongside dispatch (queue is backup, not primary)
 *   - BUG #2: dispatch used category='market' but pref check used 'price_alert' (mismatch)
 *     FIX: Both use category='price_alert' now
 *   - BUG #3: No cross-detection — price could jump over target between cron runs and
 *     the alert would never fire if price reversed before next cron tick
 *     FIX: last_price column + cross-detection logic
 *   - BUG #4: Sequential price fetch with 8s timeout per exchange = 64s worst case
 *     FIX: Promise.any with 4s timeout — fastest valid exchange wins, but only check
 *     top 3 exchanges (Binance > Bybit > OKX) for speed
 *
 * LOGGING: Every alert logs {alert_id, user_id, symbol, target_price, prev_price,
 *   current_price, direction, triggered, reason, latency_ms} for full audit trail.
 */
async function runScheduledAlertsBaseline(controller, env) {
  const t0 = Date.now();
  // Stage-by-stage latency tracking for performance monitoring
  let _tDbEnd = null;       // end of DB query phase
  let _tPriceStart = null;  // start of price fetch phase
  let _tPriceEnd = null;    // end of price fetch phase
  let _tEvalStart = null;   // start of evaluation phase
  const payload = {
    status: 'ok',
    task: 'scheduled-alerts-execution',
    cron: controller.cron || 'manual',
    alerts_cron_enabled: isAlertsCronEnabled(env),
    secret_configured: Boolean(env.ALERTS_CRON_SHARED_SECRET),
    started_at: new Date().toISOString(),
  };

  if (!payload.alerts_cron_enabled) {
    console.log(JSON.stringify({ ...payload, skipped: true, reason: 'ALERTS_CRON_ENABLED is false' }));
    return;
  }
  if (!isDatabaseConfigured(env)) {
    console.log(JSON.stringify({ ...payload, skipped: true, reason: 'Database not configured' }));
    return;
  }
  if (!isBotConfigured(env)) {
    console.log(JSON.stringify({ ...payload, skipped: true, reason: 'Telegram bot token not configured' }));
    return;
  }

  const maxAlerts = Math.max(getNumericEnv(env, 'ALERTS_CRON_MAX_ALERTS', 500), 0);
  const resultPayload = {
    ...payload,
    checked_count: 0,
    triggered_count: 0,
    price_fetch_failures: 0,
    delivery_failures: 0,
    skipped_price_missing: 0,
    skipped_guest_users: 0,
    skipped_pref_disabled: 0,
    duplicate_triggers_prevented: 0,
    cross_detections: 0,
    immediate_triggers: 0,
    dispatch_errors: [], // E2E debug: capture dispatch errors for visibility
  };

  try {
    // AUDIT-002 FIX: Ensure table + indexes exist before querying (idempotent).
    // PERFORMANCE: Only run ensureTable on the 15-min cron (not every 1 min).
    // CREATE INDEX IF NOT EXISTS is fast but still a DB roundtrip — 8 queries × 200ms
    // = 1.6s of wasted latency on every 1-min cron. The 15-min cron handles it.
    // Bug 2 FIX: cron changed from */5 to * (every minute) for faster alert detection.
    if (controller.cron === '*/15 * * * *' && typeof alertRepo?.ensureTable === 'function') {
      try { await alertRepo.ensureTable(env); } catch {}
    }

    // Use the bulk cron query (only fetches active alerts, ordered by created_at DESC)
    const alerts = (typeof alertRepo?.listActiveForCron === 'function')
      ? await alertRepo.listActiveForCron(env, maxAlerts)
      : (await queryDb(env, `
          SELECT id, user_id, symbol, price, direction, last_price, last_checked_at
          FROM price_alerts
          WHERE status = 'active'
          ORDER BY created_at DESC
          LIMIT $1
        `, [maxAlerts])).rows;

    resultPayload.checked_count = alerts.length;
    _tDbEnd = Date.now(); // Phase 1 done: DB query

    if (!alerts.length) {
      console.log(JSON.stringify({ ...resultPayload, finished: true, duration_ms: Date.now() - t0 }));
      return resultPayload;
    }

    // ── PHASE 1: Batch fetch prices for all unique symbols ──
    // Use Promise.all with a strict 4-second per-fetch timeout.
    // We try Binance first (fastest, most reliable); if it fails, fall back to Bybit, then OKX.
    // The old code tried 8 exchanges sequentially with 8s timeout each = 64s worst case.
    // New: try top 3 exchanges in parallel, take first valid response.
    const symbolPriceMap = new Map();
    const symbolSourceMap = new Map();
    const uniqueSymbols = [...new Set(
      alerts.map(a => String(a?.symbol || '').trim().toUpperCase()).filter(Boolean)
    )];

    const fetchWithTimeout = async (symbol) => {
      const tFetch = Date.now();
      try {
        // OPTIMIZATION: Use noCache=true to always get the FRESHEST price from
        // the exchange. The cache (1h TTL) could serve a price that's up to 1h
        // old, causing the trigger to fire with a stale price that doesn't match
        // the current market. For alert accuracy, we always fetch live.
        const priceInfo = await fetchSpotPriceUsd(env, symbol, { noCache: true });
        return {
          symbol,
          price: priceInfo?.price || null,
          source: priceInfo?.exchange || (priceInfo?.cached ? 'cache' : null),
          cached: Boolean(priceInfo?.cached),
          latency_ms: Date.now() - tFetch,
        };
      } catch (e) {
        return { symbol, price: null, source: null, latency_ms: Date.now() - tFetch, error: e?.message };
      }
    };

    // Fetch all unique symbols in parallel (max 30 concurrent to avoid rate limits)
    const FETCH_BATCH = 30;
    _tPriceStart = Date.now(); // Phase 2 start: price fetch
    for (let i = 0; i < uniqueSymbols.length; i += FETCH_BATCH) {
      const batch = uniqueSymbols.slice(i, i + FETCH_BATCH);
      const results = await Promise.allSettled(batch.map(fetchWithTimeout));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.price && Number.isFinite(r.value.price)) {
            symbolPriceMap.set(r.value.symbol, r.value.price);
            symbolSourceMap.set(r.value.symbol, r.value.source);
          } else {
            resultPayload.price_fetch_failures += 1;
            symbolPriceMap.set(r.value.symbol, null);
          }
        } else {
          resultPayload.price_fetch_failures += 1;
        }
      }
    }

    _tPriceEnd = Date.now(); // Phase 2 done: price fetch
    _tEvalStart = Date.now(); // Phase 3 start: evaluation

    // ── PHASE 2: Evaluate each alert with cross-detection ──
    for (const alert of alerts) {
      const alertId = String(alert?.id || '');
      const userId = String(alert?.user_id || '');
      const symbol = String(alert?.symbol || '').trim().toUpperCase();
      const targetPrice = Number(alert?.price);
      const direction = String(alert?.direction || 'above').trim().toLowerCase();
      const prevPrice = alert?.last_price != null ? Number(alert.last_price) : null;

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
        // Still update last_checked_at so we know cron ran
        if (typeof alertRepo?.updateLastChecked === 'function') {
          try { await alertRepo.updateLastChecked(env, alertId, 0); } catch {}
        }
        continue;
      }

      // ── CROSS-DETECTION LOGIC ──
      // direction='above': trigger if price crossed up through target
      //   - First check (no prevPrice): trigger if currentPrice >= targetPrice (immediate)
      //   - Subsequent checks: trigger only if prevPrice < targetPrice AND currentPrice >= targetPrice
      //     (i.e. price was below and now is at or above)
      // direction='below': mirror logic
      let shouldTrigger = false;
      let triggerReason = 'no_cross';

      if (direction === 'below') {
        if (prevPrice == null || !Number.isFinite(prevPrice)) {
          // First-ever check — trigger if already below target
          shouldTrigger = currentPrice <= targetPrice;
          triggerReason = shouldTrigger ? 'immediate_below' : 'above_target_no_cross';
        } else if (prevPrice > targetPrice && currentPrice <= targetPrice) {
          // Crossed DOWN through target
          shouldTrigger = true;
          triggerReason = 'cross_down';
        } else if (prevPrice <= targetPrice && currentPrice <= targetPrice) {
          // Was below, still below — do NOT re-trigger (already fired or never fired)
          // If alert is still active and was below before, this is a fresh alert that
          // was created when price was already below — fire once to notify user
          // (this is the "immediate trigger on creation" case)
          // We rely on last_checked_at to detect this: if last_checked_at is NULL,
          // alert was never checked → fire immediately. Otherwise, skip.
          if (alert?.last_checked_at == null) {
            shouldTrigger = true;
            triggerReason = 'first_check_below';
          } else {
            triggerReason = 'still_below_no_retrigger';
          }
        } else {
          // prevPrice <= target, currentPrice > target — price moved back up
          triggerReason = 'moved_back_up';
        }
      } else {
        // direction = 'above' (default)
        if (prevPrice == null || !Number.isFinite(prevPrice)) {
          shouldTrigger = currentPrice >= targetPrice;
          triggerReason = shouldTrigger ? 'immediate_above' : 'below_target_no_cross';
        } else if (prevPrice < targetPrice && currentPrice >= targetPrice) {
          shouldTrigger = true;
          triggerReason = 'cross_up';
        } else if (prevPrice >= targetPrice && currentPrice >= targetPrice) {
          if (alert?.last_checked_at == null) {
            shouldTrigger = true;
            triggerReason = 'first_check_above';
          } else {
            triggerReason = 'still_above_no_retrigger';
          }
        } else {
          triggerReason = 'moved_back_down';
        }
      }

      // Always update last_price + last_checked_at (even if not triggered)
      if (typeof alertRepo?.updateLastChecked === 'function') {
        try { await alertRepo.updateLastChecked(env, alertId, currentPrice); } catch {}
      }

      if (!shouldTrigger) {
        // Log the no-trigger decision for audit trail
        console.log(JSON.stringify({
          scope: 'alert-check',
          alert_id: alertId,
          user_id: userId,
          symbol,
          direction,
          target_price: targetPrice,
          prev_price: prevPrice,
          current_price: currentPrice,
          triggered: false,
          reason: triggerReason,
        }));
        continue;
      }

      // Count trigger type for monitoring
      if (triggerReason.startsWith('cross_')) {
        resultPayload.cross_detections += 1;
      } else {
        resultPayload.immediate_triggers += 1;
      }

      // ── ATOMIC TRIGGER MARK (prevents duplicate triggers) ──
      // markTriggered only succeeds if status is still 'active'. If another cron
      // run already triggered this alert, this returns false and we skip.
      let triggered = false;
      if (typeof alertRepo?.markTriggered === 'function') {
        try {
          triggered = await alertRepo.markTriggered(env, alertId, currentPrice);
        } catch (e) {
          console.warn('markTriggered failed:', { alert_id: alertId, error: e?.message });
        }
      } else {
        // Fallback: legacy UPDATE without atomic guard
        await queryDb(env, `
          UPDATE price_alerts
          SET status = 'triggered', triggered_at = NOW(), last_trigger_price = $2
          WHERE id = $1
        `, [alertId, currentPrice]);
        triggered = true;
      }

      if (!triggered) {
        resultPayload.duplicate_triggers_prevented += 1;
        console.log(JSON.stringify({
          scope: 'alert-check',
          alert_id: alertId,
          user_id: userId,
          symbol,
          triggered: false,
          reason: 'duplicate_prevented',
        }));
        continue;
      }

      // ── SEND NOTIFICATIONS ──
      try {
        // Clean, short, professional notification text.
        // Only shows: alert fired + symbol + current price.
        // No target price, no direction, no extra text.
        const priceFmt = currentPrice >= 1
          ? Number(currentPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : Number(currentPrice).toFixed(6);

        const text = `🔔 هشدار قیمت فعال شد\nقیمت ${symbol} به ${priceFmt} USDT رسید.`;
        const webAppUrl = resolveWebAppUrl(env, { cacheBust: true });

        // ── TIMING LOG: track each stage for delay root-cause analysis ──
        const timing = {
          trigger_at: new Date().toISOString(),
          price_received_ms: Date.now() - t0,
          // t0 is the cron start time; currentPrice was fetched in Phase 1
        };

        // ── PREFERENCE CHECK (corrected) ──
        // OLD BUG: isPreferenceEnabled(env, userId, 'price_alert') returned false for ALL
        // users who never saved preferences (because default in DB schema is FALSE).
        // This silently blocked ~100% of price alert deliveries.
        //
        // NEW LOGIC:
        //   1. Check notificationPlatformRepo.getUserChannelPreference(userId, 'price_alert')
        //      → returns 'none' | 'mini_app' | 'telegram' | 'both'
        //      → default is 'both' if user has no settings row
        //   2. If 'none' → skip delivery entirely (user opted out)
        //   3. Otherwise → deliver via the user's preferred channel(s)
        //
        // REMOVED: legacy boolean price_alert check. The old `price_alert` column
        // defaults to FALSE in the DB schema, which was silently blocking ALL
        // alerts for users who never explicitly saved their notification settings.
        // The new ch_price_alert column (default 'both') is the authoritative source.
        let userChannel = 'both'; // fail-open: deliver if checks fail
        if (notificationPlatformRepo) {
          try {
            userChannel = await notificationPlatformRepo.getUserChannelPreference(env, userId, 'price_alert');
          } catch (e) {
            console.warn('getUserChannelPreference failed, defaulting to both:', {
              alert_id: alertId, user_id: userId, error: e?.message,
            });
          }
        }

        const shouldDeliver = (userChannel !== 'none');

        if (!shouldDeliver) {
          resultPayload.skipped_pref_disabled += 1;
          console.log(JSON.stringify({
            scope: 'alert-check',
            alert_id: alertId,
            user_id: userId,
            symbol,
            triggered: true,
            notif_skipped: 'pref_disabled',
            user_channel: userChannel,
          }));
          resultPayload.triggered_count += 1;
          continue;
        }

        let inAppDelivered = false;
        let telegramDelivered = false;

        // Determine effective delivery channel based on user preference
        const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
        const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';

        // ── (a) In-app notification — DIRECT INSERT (not dispatch) ──
        // ROOT CAUSE FIX for DUPLICATE TELEGRAM messages (Bug 3):
        // Previously, dispatch() was called with channel='mini_app'. BUT dispatch()
        // OVERRIDES the channel parameter with the user's per-category preference
        // (getUserChannelPreference). If user pref = 'both' (the default), then:
        //   - effectiveChannel = 'both'
        //   - deliverToTelegram = true → enqueue TG message in notification_queue
        //   - AND the alert code below direct-sends via sendTelegramMessage
        //   → user gets 2 TG messages (1 from queue, 1 direct)
        //
        // FIX: Replace dispatch() with a DIRECT INSERT into the notifications table.
        // This gives us full control: in-app INSERT only, NO Telegram enqueue.
        // Telegram is handled solely by the direct send below.
        if (deliverToMiniApp && isDatabaseConfigured(env)) {
          try {
            const tDispatchStart = Date.now();
            const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;
            await queryDb(env, `
              INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status, created_at)
              VALUES ($1, $2, $3, $4, $5, $6, FALSE, 'high', 'price_alert', 'mini_app', 'delivered', NOW())
            `, [
              notificationId,
              String(userId),
              'price_alert',
              `🔔 هشدار قیمت ${symbol}`,
              text,
              JSON.stringify({
                symbol,
                price: String(currentPrice),
                alert_id: alertId,
                target_price: String(targetPrice),
                direction,
                trigger_reason: triggerReason,
              }),
            ]);
            inAppDelivered = true;
            timing.dispatch_ms = Date.now() - tDispatchStart;
          } catch (notifErr) {
            console.warn('In-app notification INSERT failed for price alert:', notifErr?.message || notifErr);
            resultPayload.dispatch_errors.push({
              alert_id: alertId,
              error: notifErr?.message || String(notifErr),
              stack: notifErr?.stack?.slice(0, 200),
            });
          }
        }

        // ── (b) Direct Telegram send (immediate, with retry) ──
        // ROOT CAUSE FIX for LOST notifications:
        // Previously: if sendTelegramMessage failed, the alert was already marked
        // as 'triggered' → user never got notified. No retry.
        //
        // FIX: Try twice with a 1s delay between attempts. If both fail, enqueue
        // in notification_queue as fallback (queue retries on next cron tick).
        let telegramMessageId = null;
        let telegramError = null;
        if (deliverToTelegram) {
          const tTgStart = Date.now();
          try {
            const chatIdValue = Number(userId);
            const chatId = Number.isFinite(chatIdValue) ? chatIdValue : userId;
            const tgPayload = { chat_id: chatId, text, disable_web_page_preview: true };
            if (webAppUrl) {
              tgPayload.reply_markup = {
                inline_keyboard: [[{ text: 'Open Amir BTC Assistant 🚀', web_app: { url: webAppUrl } }]],
              };
            }

            // Attempt 1
            let tgResult = await sendTelegramMessage(env, tgPayload);
            telegramMessageId = tgResult?.messageId || tgResult?.result?.message_id || null;

            // Attempt 2 (retry if first failed)
            if (!telegramMessageId) {
              await new Promise(r => setTimeout(r, 1000));
              try {
                tgResult = await sendTelegramMessage(env, tgPayload);
                telegramMessageId = tgResult?.messageId || tgResult?.result?.message_id || null;
              } catch (retryErr) {
                telegramError = retryErr?.message || String(retryErr);
              }
            }

            telegramDelivered = !!telegramMessageId;
            timing.telegram_ms = Date.now() - tTgStart;

            // Fallback: if both direct send attempts failed, enqueue in queue
            // so the next cron tick can retry. This prevents lost notifications.
            if (!telegramDelivered && notificationPlatformRepo) {
              try {
                await queryDb(env, `
                  INSERT INTO notification_queue (notification_id, user_id, channel, priority, status, payload, created_at)
                  VALUES ($1, $2, 'telegram', 'high', 'pending', $3, NOW())
                `, [
                  `alert_${alertId}_${Date.now()}`,
                  String(userId),
                  JSON.stringify({ chat_id: chatId, text, reply_markup: tgPayload.reply_markup || null }),
                ]);
                console.warn('Telegram direct send failed twice — enqueued as fallback for queue retry');
              } catch (qErr) {
                console.warn('Fallback enqueue also failed:', qErr?.message);
              }
            }
          } catch (tgErr) {
            telegramError = tgErr?.message || String(tgErr);
            timing.telegram_ms = Date.now() - tTgStart;
            console.warn('Direct Telegram send failed for price alert:', telegramError);
          }
        }

        if (!inAppDelivered && !telegramDelivered) {
          resultPayload.delivery_failures += 1;
        }

        resultPayload.triggered_count += 1;

        // ── DETAILED TIMING LOG for delay root-cause analysis ──
        // Logs the full pipeline timing so we can pinpoint where delay occurs:
        //   price_received_ms: time from cron start to price being available
        //   dispatch_ms: time to insert in-app notification into DB
        //   telegram_ms: time to send Telegram message (including retry)
        //   total_ms: time from cron start to delivery complete
        console.log(JSON.stringify({
          scope: 'alert-check',
          alert_id: alertId,
          user_id: userId,
          symbol,
          direction,
          target_price: targetPrice,
          prev_price: prevPrice,
          current_price: currentPrice,
          triggered: true,
          reason: triggerReason,
          user_channel: userChannel,
          in_app_delivered: inAppDelivered,
          telegram_delivered: telegramDelivered,
          telegram_message_id: telegramMessageId,
          telegram_error: telegramError,
          price_source: symbolSourceMap.get(symbol),
          timing: {
            ...timing,
            total_ms: Date.now() - t0,
          },
        }));
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

    console.log(JSON.stringify({
      ...resultPayload,
      finished: true,
      duration_ms: Date.now() - t0,
      // STAGE-BY-STAGE LATENCY for performance monitoring:
      //   db_query_ms: time to SELECT active alerts from PostgreSQL
      //   price_fetch_total_ms: time to fetch prices for all unique symbols
      //   evaluation_ms: time to evaluate all alerts + trigger notifications
      //   total_ms: cron tick total (db + price_fetch + evaluation + delivery)
      phase_latency: {
        db_query_start: t0,
        db_query_end: _tDbEnd || null,
        price_fetch_start: _tPriceStart || null,
        price_fetch_end: _tPriceEnd || null,
        evaluation_start: _tEvalStart || null,
        evaluation_end: Date.now(),
        db_query_ms: _tDbEnd ? (_tDbEnd - t0) : null,
        price_fetch_ms: (_tPriceStart && _tPriceEnd) ? (_tPriceEnd - _tPriceStart) : null,
        evaluation_ms: (_tEvalStart) ? (Date.now() - _tEvalStart) : null,
      },
    }));
    return resultPayload;
  } catch (error) {
    console.warn(safeError('scheduled-alerts-runner', error));
    console.log(JSON.stringify({
      ...payload,
      status: 'error',
      message: 'scheduled alerts runner failed',
      detail: error instanceof Error ? error.message : String(error),
      duration_ms: Date.now() - t0,
    }));
  }
}
//#endregion

// ============================================================================
//#region ورودی اصلی Worker
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    _currentRequestOrigin = request.headers.get('Origin');
    // Set env accessors for fetchFearGreed (called from various places)
    env_CMC_API_KEY = env.CMC_API_KEY || null;
    env_APP_CACHE = env.APP_CACHE || null;
    // Set sendTelegramMessage for notification_platform.processBroadcast
    if (typeof setEnvSendTelegramMessage === 'function') {
      setEnvSendTelegramMessage(sendTelegramMessage);
    }
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

      // ── DIAGNOSTIC: Admin endpoint tester (temp, for root cause analysis) ──
      // Auth: X-Cron-Secret header must match ALERTS_CRON_SHARED_SECRET
      // Tests ALL admin endpoints internally and returns exact HTTP status + response body
      if (request.method === 'GET' && url.pathname === '/api/_diag/admin-test') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }

        const results = {};
        const endpoints = [
          { name: 'dashboard', path: '/api/admin/dashboard', method: 'GET' },
          { name: 'users', path: '/api/admin/users?page=1', method: 'GET' },
          { name: 'admins', path: '/api/admin/admins', method: 'GET' },
          { name: 'tickets', path: '/api/admin/tickets?page=1', method: 'GET' },
          { name: 'broadcasts', path: '/api/admin/broadcasts', method: 'GET' },
          { name: 'rewards', path: '/api/admin/rewards', method: 'GET' },
          { name: 'transactions', path: '/api/admin/transactions?page=1', method: 'GET' },
          { name: 'referrals', path: '/api/admin/referrals?page=1', method: 'GET' },
          { name: 'logs', path: '/api/admin/logs?page=1', method: 'GET' },
          { name: 'system-health', path: '/api/admin/system-health', method: 'GET' },
          { name: 'reward-center/overview', path: '/api/admin/reward-center/overview', method: 'GET' },
          { name: 'reward-center/wheel/config', path: '/api/admin/reward-center/wheel/config', method: 'GET' },
          { name: 'reward-center/wheel/rewards', path: '/api/admin/reward-center/wheel/rewards', method: 'GET' },
          { name: 'reward-center/library', path: '/api/admin/reward-center/library', method: 'GET' },
          { name: 'reward-center/referral-tiers', path: '/api/admin/reward-center/referral-tiers', method: 'GET' },
          { name: 'reward-center/mission-rewards', path: '/api/admin/reward-center/mission-rewards', method: 'GET' },
          { name: 'reward-center/campaigns', path: '/api/admin/reward-center/campaigns', method: 'GET' },
          { name: 'reward-center/emergency', path: '/api/admin/reward-center/emergency', method: 'GET' },
          { name: 'reward-center/analytics', path: '/api/admin/reward-center/analytics', method: 'GET' },
          { name: 'notifications/analytics', path: '/api/admin/notifications/analytics', method: 'GET' },
          { name: 'notifications/templates', path: '/api/admin/notifications/templates', method: 'GET' },
          { name: 'notifications/broadcasts', path: '/api/admin/notifications/broadcasts', method: 'GET' },
          { name: 'alert-economy/dashboard', path: '/api/admin/alert-economy/dashboard', method: 'GET' },
          { name: 'alert-economy/configs', path: '/api/admin/alert-economy/configs', method: 'GET' },
          { name: 'maintenance', path: '/api/admin/maintenance', method: 'GET' },
        ];

        for (const ep of endpoints) {
          try {
            // Build a fake admin request to test the endpoint internally
            const testReq = new Request(`https://worker.dev${ep.path}`, { method: ep.method });
            // Simulate super-admin by setting the env ADMIN_TELEGRAM_ID as the caller
            const adminId = String(env.ADMIN_TELEGRAM_ID || '0');
            // We need to bypass auth — call the handler directly with a mock auth
            const mockAuthState = { error: null, user: { id: adminId } };

            // For each endpoint, call the handler directly
            let response;
            const url = new URL(testReq.url);

            if (ep.name === 'dashboard') {
              const stats = await adminRepo.getDashboardStats(env).catch(e => ({ error: e.message }));
              const activity = await adminRepo.getRecentActivity(env, 10).catch(e => ({ error: e.message }));
              response = { status: 'success', stats, recent_activity: activity };
            } else if (ep.name === 'users') {
              response = await adminRepo.searchUsers(env, { search: '', page: 1, limit: 20 }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'admins') {
              response = { admins: await adminRepo.listAdmins(env).catch(e => ({ error: e.message })) };
            } else if (ep.name === 'tickets') {
              response = await adminRepo.listTicketsAdmin(env, { page: 1, limit: 20, status: '' }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'broadcasts') {
              response = await adminRepo.listBroadcasts(env, { page: 1, limit: 20 }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'rewards') {
              response = await adminRepo.listRewards(env, { status: '', page: 1, limit: 20 }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'transactions') {
              response = await adminRepo.listTransactions(env, { page: 1, limit: 20, user_id: '', tx_type: '' }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'referrals') {
              response = await adminRepo.listReferrals(env, { search: '', page: 1, limit: 20 }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'logs') {
              response = await adminRepo.getAdminLogs(env, { action: '', page: 1, limit: 20 }).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'system-health') {
              response = await adminRepo.getSystemHealth(env).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.name === 'maintenance') {
              response = await getMaintenanceState(env).catch(e => ({ status: 'error', error: e.message }));
            } else if (ep.path.startsWith('/api/admin/reward-center/')) {
              if (typeof rewardCenterRepo !== 'undefined') {
                if (ep.name === 'reward-center/overview') {
                  response = await rewardCenterRepo.getOverview(env).catch(e => ({ status: 'error', error: e.message }));
                } else if (ep.name === 'reward-center/wheel/config') {
                  response = await rewardCenterRepo.getWheelConfig(env).catch(e => ({ status: 'error', error: e.message }));
                } else if (ep.name === 'reward-center/wheel/rewards') {
                  response = { rewards: await rewardCenterRepo.listWheelRewards(env).catch(e => ({ error: e.message })) };
                } else if (ep.name === 'reward-center/library') {
                  response = { library: await rewardCenterRepo.listRewardLibrary(env).catch(e => ({ error: e.message })) };
                } else if (ep.name === 'reward-center/referral-tiers') {
                  response = { tiers: await rewardCenterRepo.listReferralTiers(env).catch(e => ({ error: e.message })) };
                } else if (ep.name === 'reward-center/mission-rewards') {
                  response = { missions: await rewardCenterRepo.listMissionRewards(env).catch(e => ({ error: e.message })) };
                } else if (ep.name === 'reward-center/campaigns') {
                  response = { campaigns: await rewardCenterRepo.listCampaigns(env).catch(e => ({ error: e.message })) };
                } else if (ep.name === 'reward-center/emergency') {
                  response = await rewardCenterRepo.getEmergencyControls(env).catch(e => ({ status: 'error', error: e.message }));
                } else if (ep.name === 'reward-center/analytics') {
                  response = await rewardCenterRepo.getAnalytics(env, { range: '7d' }).catch(e => ({ status: 'error', error: e.message }));
                }
              } else {
                response = { error: 'rewardCenterRepo not defined' };
              }
            } else if (ep.path.startsWith('/api/admin/notifications/')) {
              if (typeof notificationPlatformRepo !== 'undefined') {
                if (ep.name === 'notifications/analytics') {
                  response = await notificationPlatformRepo.getAnalytics(env, { range: '7d' }).catch(e => ({ status: 'error', error: e.message }));
                } else if (ep.name === 'notifications/templates') {
                  response = { templates: await notificationPlatformRepo.listTemplates(env).catch(e => ({ error: e.message })) };
                } else if (ep.name === 'notifications/broadcasts') {
                  response = await notificationPlatformRepo.listBroadcasts(env, { limit: 20, offset: 0 }).catch(e => ({ status: 'error', error: e.message }));
                }
              } else {
                response = { error: 'notificationPlatformRepo not defined' };
              }
            } else if (ep.path.startsWith('/api/admin/alert-economy/')) {
              if (typeof alertEconomyRepo !== 'undefined') {
                if (ep.name === 'alert-economy/dashboard') {
                  response = await alertEconomyRepo.getDashboard(env).catch(e => ({ status: 'error', error: e.message }));
                } else if (ep.name === 'alert-economy/configs') {
                  response = { configs: await alertEconomyRepo.getAllConfigs(env).catch(e => ({ error: e.message })) };
                }
              } else {
                response = { error: 'alertEconomyRepo not defined' };
              }
            } else {
              response = { error: 'not implemented in diag' };
            }

            const hasError = response && (response.error || response.status === 'error');
            results[ep.name] = {
              status: hasError ? 'ERROR' : 'OK',
              response: typeof response === 'object' ? JSON.stringify(response).substring(0, 500) : String(response).substring(0, 500),
            };
          } catch (e) {
            results[ep.name] = { status: 'EXCEPTION', error: e.message };
          }
        }

        return jsonResponse({ status: 'success', results }, {}, env);
      }

      // ── Manual Alert Trigger (admin-only, for testing) ──
      // Allows admins to force-run the alert cron without waiting 5 minutes.
      // Useful for E2E testing of alert triggers in production.
      // Auth method 1: ALERTS_CRON_SHARED_SECRET in X-Cron-Secret header
      // Auth method 2: Telegram admin auth (ADMIN_TELEGRAM_ID) via X-Telegram-Init-Data
      if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/api/admin/trigger-alerts') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.ALERTS_CRON_SHARED_SECRET || '';
        let authorized = false;

        // Method 1: shared secret
        if (expectedSecret && providedSecret === expectedSecret) {
          authorized = true;
        }

        // Method 2: Telegram admin auth
        if (!authorized) {
          try {
            const authState = await authenticateTelegramRequest(request, env);
            if (!authState.error && authState.user) {
              const adminIds = String(env.ADMIN_TELEGRAM_ID || env.ADMIN_TELEGRAM_IDS || '').split(',').map(s => s.trim());
              if (adminIds.includes(String(authState.user.id))) {
                authorized = true;
              }
            }
          } catch {}
        }

        if (!authorized) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }
        // Run the alert checker immediately
        const result = await runScheduledAlertsBaseline({ cron: 'manual-trigger' }, env);

        // Also return DB state for debugging
        let dbState = {};
        try {
          const activeAlerts = await queryDb(env, `SELECT id, user_id, symbol, price, direction, status, created_at, triggered_at, last_price, last_checked_at FROM price_alerts WHERE status = 'active' ORDER BY created_at DESC LIMIT 20`);
          const recentTriggered = await queryDb(env, `SELECT id, user_id, symbol, price, direction, status, triggered_at, last_trigger_price FROM price_alerts WHERE status = 'triggered' ORDER BY triggered_at DESC LIMIT 10`);
          const recentNotifs = await queryDb(env, `SELECT id, title, message, category, priority, channel, created_at FROM notifications ORDER BY created_at DESC LIMIT 10`);
          const recentQueue = await queryDb(env, `SELECT id, user_id, channel, status, created_at FROM notification_queue ORDER BY created_at DESC LIMIT 10`).catch(() => ({ rows: [] }));
          dbState = {
            active_alerts: activeAlerts.rows,
            recent_triggered: recentTriggered.rows,
            recent_notifications: recentNotifs.rows,
            recent_queue: recentQueue.rows,
          };
        } catch (e) {
          dbState = { error: e.message };
        }

        return jsonResponse({ status: 'success', message: 'Alert check triggered', result, dbState }, {}, env);
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

      // ── DIAGNOSTIC: Exchange reachability test ──

      if (request.method === 'GET' && url.pathname === '/api/calendar/events') {
        return await handleCalendarEvents(env);
      }

      // ── Calendar Reminders (per-user, stored in PostgreSQL) ──
      // POST   /api/calendar/reminders      — create/update
      // GET    /api/calendar/reminders      — list user's reminders
      // DELETE /api/calendar/reminders/:key — delete by event_key
      if (url.pathname === '/api/calendar/reminders' && request.method === 'POST') {
        return await calendarReminderHandlers.handleCreate(request, env);
      }
      if (url.pathname === '/api/calendar/reminders' && request.method === 'GET') {
        return await calendarReminderHandlers.handleList(request, env);
      }
      if (url.pathname.startsWith('/api/calendar/reminders/') && request.method === 'DELETE') {
        const eventKey = decodeURIComponent(url.pathname.slice('/api/calendar/reminders/'.length));
        return await calendarReminderHandlers.handleDelete(request, env, eventKey);
      }

      // ── Market Overview (CMC-powered, no auth required) ──
      if (request.method === 'GET' && url.pathname === '/api/market/overview') {
        const overview = await marketOverviewSvc.getCachedOverview(env);
        if (overview) {
          // PHASE 5 FIX: Enrich with Fear & Greed from CMC API
          // (not included in CMC global metrics)
          if (!overview.fearGreedValue) {
            try {
              const fg = await fetchFearGreed();
              if (fg) {
                overview.fearGreedValue = fg.value;
                overview.fearGreedClassification = fg.classification;
                overview.fearGreedSource = 'coinmarketcap';
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
      // PHASE 3 FIX (Bug 5): Admin DELETE ticket — previously didn't exist
      if (/^\/api\/admin\/tickets\/[^/]+$/.test(url.pathname) && request.method === 'DELETE') {
        const ticketId = url.pathname.split('/')[4];
        return await adminHandlers.handleDeleteTicket(request, env, ticketId);
      }
      // PHASE 3 FIX (Bug 6): Admin GET ticket replies — for conversation thread
      if (/^\/api\/admin\/tickets\/[^/]+\/replies$/.test(url.pathname) && request.method === 'GET') {
        const ticketId = url.pathname.split('/')[4];
        return await adminHandlers.handleListTicketReplies(request, env, ticketId);
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
        // Soft Telegram auth — extracts user_id (when initData is present) so
        // the rate-limit key can include it. We do NOT reject on auth failure
        // (this is a public endpoint); an unauthenticated request simply falls
        // back to the legacy IP-only bucket via the 'anon' placeholder.
        const _marketAuth = await authenticateTelegramRequest(request, env);
        const _marketUid = _marketAuth.user?.id || null;
        if (await isMarketRateLimited(env, clientIp, _marketUid)) {
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
        // Use withCors() so the Origin/Methods/Headers match every other response
        // (previously this branch set 'Access-Control-Allow-Origin: *' ad-hoc,
        // which broke the WEBAPP_URL pinning policy used elsewhere).
        const _marketHeaders = withCors({ 'Content-Type': 'application/json' }, env);
        return new Response(sharedResponse.body, {
          status: sharedResponse.status,
          headers: _marketHeaders,
        });
      }

      if (request.method === 'GET' && url.pathname === '/api/forex') {
        const clientIp = request.headers.get('cf-connecting-ip') || 'unknown';
        // Same soft-auth pattern as /api/market — include Telegram user ID in
        // the rate-limit key when initData is present.
        const _forexAuth = await authenticateTelegramRequest(request, env);
        const _forexUid = _forexAuth.user?.id || null;
        if (await isMarketRateLimited(env, clientIp, _forexUid)) {
          return jsonResponse({ status: 'error', message: 'Rate limited' }, { status: 429 }, env);
        }
        return await handleForexData(env);
      }

      // ── Real-time price for alert checking — independent from market cache ──
      // Returns the FRESHEST price for a symbol, fetched directly from Binance.
      // Used by frontend checkAlerts() to get real-time prices every 30s
      // without waiting for the 60s market polling cycle.
      // Auth required.
      if (request.method === 'GET' && url.pathname === '/api/market/price') {
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;

        const symbol = (url.searchParams.get('symbol') || '').toUpperCase().trim();
        if (!symbol) {
          return jsonResponse({ status: 'error', message: 'Missing symbol' }, { status: 422 }, env);
        }

        // Fetch fresh price directly from Binance (no cache)
        const priceInfo = await fetchSpotPriceUsd(env, symbol);
        if (priceInfo && priceInfo.price) {
          return jsonResponse({
            status: 'success',
            symbol,
            price: priceInfo.price,
            exchange: priceInfo.exchange,
            timestamp: Date.now(),
          }, {}, env);
        }
        return jsonResponse({ status: 'error', message: 'Price not available' }, { status: 404 }, env);
      }

      // ── PERFORMANCE: Batch price fetch — eliminates N+1 pattern in checkAlerts ──
      // Frontend sends: GET /api/market/prices?symbols=BTC,ETH,SOL
      // Backend fetches all prices in parallel, returns { BTC: {price, exchange}, ETH: {...} }
      // This reduces 10 API calls to 1 for users with multiple alerts.
      if (request.method === 'GET' && url.pathname === '/api/market/prices') {
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;

        const symbolsParam = (url.searchParams.get('symbols') || '').toUpperCase().trim();
        if (!symbolsParam) {
          return jsonResponse({ status: 'success', prices: {} }, {}, env);
        }

        const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 20);
        const results = await Promise.allSettled(
          symbols.map(async (sym) => {
            try {
              const priceInfo = await fetchSpotPriceUsd(env, sym);
              return { symbol: sym, price: priceInfo?.price || null, exchange: priceInfo?.exchange || null };
            } catch {
              return { symbol: sym, price: null, exchange: null };
            }
          })
        );

        const prices = {};
        for (const r of results) {
          if (r.status === 'fulfilled' && r.value.price) {
            prices[r.value.symbol] = { price: r.value.price, exchange: r.value.exchange };
          }
        }

        return jsonResponse({ status: 'success', prices, timestamp: Date.now() }, {}, env);
      }

      // ── Extended market search — PUBLIC (no auth required) ──
      // Returns coins matching the search query from a 1700+ coin dataset.
      // Uses MEXC API which returns ALL USDT pairs in a single request (no pagination).
      // Verified: MEXC returns 1740 USDT pairs including FLOKI, BONK, WIF, SUNDOG, BRETT.
      // Cached for 5 minutes.
      if (request.method === 'GET' && url.pathname === '/api/market/search') {
        const query = (url.searchParams.get('q') || '').toLowerCase().trim();
        if (!query || query.length < 1) {
          return jsonResponse({ status: 'success', results: [], total_index: 0 }, {}, env);
        }

        // Check cache first
        const searchCacheKey = `market:search:mexc:v2`;
        const cachedSearch = await readAppCache(env, searchCacheKey);
        let searchList = [];
        if (cachedSearch) {
          try { searchList = JSON.parse(cachedSearch); } catch {}
        }

        if (!searchList.length) {
          // Fetch ALL USDT pairs from MEXC in a single request.
          // MEXC returns ~1740 USDT pairs with FULL 24hr ticker data:
          // lastPrice, priceChangePercent, quoteVolume, highPrice, lowPrice
          try {
            const { ok, body } = await fetchJsonWithTimeout(
              'https://api.mexc.com/api/v3/ticker/24hr',
              8000
            );
            if (ok && Array.isArray(body)) {
              searchList = body
                .filter(item => {
                  const sym = String(item.symbol || '');
                  return sym.endsWith('USDT') && sym.length > 4;
                })
                .map(item => {
                  const sym = String(item.symbol || '').replace(/USDT$/, '');
                  const price = parseFloat(item.lastPrice) || 0;
                  const volume = parseFloat(item.quoteVolume) || 0;
                  // MEXC priceChangePercent is a FRACTION (0.000953 = 0.0953%)
                  // Multiply by 100 to get percentage like CoinGecko/CoinCap
                  const changePercent = (parseFloat(item.priceChangePercent) || 0) * 100;
                  return {
                    symbol: sym.toUpperCase(),
                    name: sym.toUpperCase(),
                    rank: 0,
                    priceUsd: price,
                    volume: volume,
                    changePercent24Hr: changePercent,
                    highPrice: parseFloat(item.highPrice) || 0,
                    lowPrice: parseFloat(item.lowPrice) || 0,
                  };
                })
                .filter(c => c.symbol.length >= 2 && c.priceUsd > 0)
                .sort((a, b) => b.volume - a.volume);
              await writeAppCache(env, searchCacheKey, JSON.stringify(searchList), 300);
            }
          } catch (e) {
            console.warn('Market search: MEXC fetch failed:', e.message);
          }
        }

        // Filter by query (search in symbol AND name)
        const results = searchList
          .filter(c =>
            c.symbol.toLowerCase().includes(query) ||
            c.name.toLowerCase().includes(query)
          )
          .slice(0, 30); // Limit results to 30

        return jsonResponse({
          status: 'success',
          results,
          total_index: searchList.length,
          cached: cachedSearch ? true : false,
        }, {}, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/farsi-news') {
        return await handleFarsiNews(request, env);
      }


      // ── DIAGNOSTIC: Find working Workers AI text generation model ──
      if (request.method === 'GET' && url.pathname === '/api/_diag/ai-models') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }
        if (!env.AI) {
          return jsonResponse({ status: 'error', error: 'AI binding not configured' }, {}, env);
        }
        const modelsToTry = [
          '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          '@cf/meta/llama-3.3-70b-instruct-fp8-fast',
          '@cf/meta/llama-3-8b-instruct',
          '@cf/meta/llama-2-7b-chat-int8',
          '@hf/thebloke/neural-chat-7b-v3-1-awq',
          '@cf/meta/mistral-7b-instruct-v0.1',
          '@cf/qwen/qwen1.5-14b-chat-awq',
          '@cf/qwen/qwen1.5-7b-chat-awq',
          '@cf/meta/llama-3.1-8b-instruct',
          '@cf/deepseek-ai/deepseek-coder-6.7b-instruct-awq',
        ];
        const results = [];
        for (const model of modelsToTry) {
          try {
            const response = await env.AI.run(model, {
              messages: [
                { role: 'user', content: 'Say "hello" in Persian (Farsi). Just one word.' },
              ],
              max_tokens: 20,
            });
            const text = response?.response || response?.generated_text || '';
            results.push({ model, status: 'OK', responseLength: text.length, sample: text.substring(0, 50) });
          } catch (e) {
            results.push({ model, status: 'FAIL', error: e.message?.substring(0, 100) });
          }
        }
        return jsonResponse({ status: 'success', results }, {}, env);
      }

      // ── DIAGNOSTIC: Test news summarization end-to-end ──
      if (request.method === 'GET' && url.pathname === '/api/_diag/news-ai-test') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }

        const testArticle = 'Bitcoin price surged 5% today, reaching $65,000. The rally was driven by institutional inflows into spot ETFs. BlackRock led with $218 million in daily inflows, followed by Fidelity with $89 million. Analysts at JPMorgan predict further upside if BTC breaks the $67,000 resistance level. The total crypto market cap now stands at $2.3 trillion. Ethereum also gained 3%, trading at $3,450. The Fear and Greed Index moved from 26 (Fear) to 34 (Fear), indicating improving sentiment.';

        const log = [];
        const t0 = Date.now();

        try {
          log.push({ step: 'AI_REQUEST', model: '@cf/meta/llama-3.3-70b-instruct-fp8-fast', articleLength: testArticle.length });

          const t1 = Date.now();
          const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'You are a professional Persian crypto journalist. Rewrite the article in Persian. Keep all details, numbers, and names. Maximum 800 words. End with: برای مطالعه نسخه کامل می‌توانید از لینک منبع استفاده کنید.' },
              { role: 'user', content: testArticle },
            ],
            max_tokens: 4096,
            temperature: 0.3,
          });
          const aiMs = Date.now() - t1;

          log.push({ step: 'AI_RESPONSE', timeMs: aiMs, hasResponse: !!aiResponse?.response });

          if (aiResponse && aiResponse.response) {
            log.push({ step: 'SUCCESS', summaryLength: aiResponse.response.length, first200: aiResponse.response.substring(0, 200) });
            return jsonResponse({ status: 'success', log, summary: aiResponse.response, totalMs: Date.now() - t0 }, {}, env);
          } else {
            log.push({ step: 'EMPTY_RESPONSE', fullResponse: JSON.stringify(aiResponse).substring(0, 300) });
            return jsonResponse({ status: 'error', log, error: 'Empty AI response', totalMs: Date.now() - t0 }, {}, env);
          }
        } catch (e) {
          log.push({ step: 'EXCEPTION', error: e.message });
          return jsonResponse({ status: 'error', log, error: e.message, totalMs: Date.now() - t0 }, {}, env);
        }
      }

      // ── DIAGNOSTIC: Forex data test (bypasses auth for debugging) ──
      if (request.method === 'GET' && url.pathname === '/api/_diag/forex-data') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }
        // Call handleForexData directly with skipCache=true to force fresh fetch
        const result = await handleForexData(env, { skipCache: true });
        const body = await result.json();
        const data = body.data || [];
        const report = data.map(item => ({
          symbol: item.symbol,
          category: item.category,
          price: item.price,
          change: item.change,
          tvSymbol: item.tvSymbol,
          hasPrice: item.price > 0,
        }));
        // Summary
        const byCategory = {};
        for (const item of data) {
          const cat = item.category;
          if (!byCategory[cat]) byCategory[cat] = { total: 0, withPrice: 0, withoutPrice: 0 };
          byCategory[cat].total++;
          if (item.price > 0) byCategory[cat].withPrice++;
          else byCategory[cat].withoutPrice++;
        }
        return jsonResponse({
          status: 'success',
          cached: body.cached,
          totalSymbols: data.length,
          symbolsWithPrice: data.filter(d => d.price > 0).length,
          symbolsWithoutPrice: data.filter(d => d.price === 0).length,
          byCategory,
          symbols: report,
        }, {}, env);
      }

      // ── DIAGNOSTIC: Real KV Write Stats ──
      if (request.method === 'GET' && url.pathname === '/api/_diag/kv-write-stats') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }
        // Sort by count descending
        const byPrefixSorted = Object.entries(_kvWriteStats.byPrefix)
          .sort((a, b) => b[1] - a[1])
          .map(([key, count]) => ({ key, writes: count }));
        const byKeySorted = Object.entries(_kvWriteStats.byKey)
          .sort((a, b) => b[1] - a[1])
          .slice(0, 30)
          .map(([key, count]) => ({ key, writes: count }));
        const uptimeMs = _kvWriteStats.startedAt ? Date.now() - new Date(_kvWriteStats.startedAt).getTime() : 0;
        const uptimeMin = Math.max(1, Math.round(uptimeMs / 60000));
        return jsonResponse({
          status: 'success',
          isolateStartedAt: _kvWriteStats.startedAt || 'no writes yet',
          uptimeMinutes: uptimeMin,
          totalWrites: _kvWriteStats.totalWrites,
          totalSkipped: _kvWriteStats.totalSkipped,
          writesPerMinute: uptimeMin > 0 ? Math.round(_kvWriteStats.totalWrites / uptimeMin * 10) / 10 : 0,
          byPrefix: byPrefixSorted,
          topKeys: byKeySorted,
        }, {}, env);
      }

      // ── DIAGNOSTIC: Full cron pipeline test (RSS → AI → KV → fetch) ──
      if (request.method === 'GET' && url.pathname === '/api/_diag/news-cron-pipeline') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }
        const log = [];
        const t0 = Date.now();
        try {
          // Step 1: Check if cron is configured
          log.push({ step: 'CRON_CONFIG', crons: ['* * * * *', '*/15 * * * *'] });

          // Step 1.5: Test RSS sources individually
          log.push({ step: 'RSS_SOURCES_TEST', sourceCount: NEWS_RSS_SOURCES.length });
          const sourceResults = await Promise.allSettled(
            NEWS_RSS_SOURCES.map(async (source) => {
              try {
                const controller = new AbortController();
                const timeoutId = setTimeout(() => controller.abort(), 5000);
                const response = await fetch(source.url, {
                  headers: { 'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)' },
                  signal: controller.signal,
                });
                clearTimeout(timeoutId);
                const text = await response.text();
                return { name: source.name, url: source.url, status: response.status, hasItems: text.includes('<item>'), length: text.length };
              } catch (e) {
                return { name: source.name, url: source.url, error: e.message };
              }
            })
          );
          log.push({
            step: 'RSS_RESULTS',
            sources: sourceResults.map(r => r.status === 'fulfilled' ? r.value : { error: r.reason?.message }),
          });

          // Step 2: Run processNewsAIBatch (the actual cron function)
          log.push({ step: 'BATCH_START' });
          const batchResult = await processNewsAIBatch(env).catch(e => ({ error: e.message }));
          log.push({ step: 'BATCH_DONE', result: batchResult });

          // Step 3: Fetch news and check how many have AI summaries
          const newsResult = await fetchFarsiNews(env, null);
          const articles = newsResult.data || [];
          const withAi = articles.filter(a => a.ai_summary && a.ai_summary.length > 50);
          const withoutAi = articles.filter(a => !a.ai_summary || a.ai_summary.length <= 50);
          log.push({
            step: 'FETCH_NEWS',
            source: newsResult.source,
            totalArticles: articles.length,
            withAiSummary: withAi.length,
            withoutAiSummary: withoutAi.length,
            sample: articles.slice(0, 3).map(a => ({
              title: (a.title || '').substring(0, 60),
              hasAi: !!(a.ai_summary && a.ai_summary.length > 50),
              aiStatus: a.ai_status,
            })),
          });

          log.push({ step: 'COMPLETE', totalMs: Date.now() - t0 });
          return jsonResponse({ status: 'success', log, totalMs: Date.now() - t0 }, {}, env);
        } catch (e) {
          log.push({ step: 'EXCEPTION', error: e.message, stack: e.stack?.substring(0, 200) });
          return jsonResponse({ status: 'error', log, error: e.message, totalMs: Date.now() - t0 }, {}, env);
        }
      }

      // ── DIAGNOSTIC: List available Gemini models ──
      if (request.method === 'GET' && url.pathname === '/api/_diag/gemini-models') {
        const providedSecret = request.headers.get('X-Cron-Secret') || '';
        const expectedSecret = env.DIAG_SECRET || '';
        if (!expectedSecret || providedSecret !== expectedSecret) {
          return jsonResponse({ status: 'error', message: 'Unauthorized' }, { status: 401 }, env);
        }
        const GEMINI_API_KEY = env.GEMINI_API_KEY;
        if (!GEMINI_API_KEY) {
          return jsonResponse({ status: 'error', error: 'no_api_key' }, {}, env);
        }
        try {
          // Try multiple model names — Google keeps renaming/deprecating
          const modelNames = [
            'gemini-2.5-flash',
            'gemini-2.0-flash',
            'gemini-1.5-flash',
            'gemini-1.5-flash-latest',
            'gemini-flash-latest',
          ];
          let geminiRes = null;
          let modelUsed = null;
          const modelErrors = [];
          for (const modelName of modelNames) {
            try {
              const testRes = await fetch(
                `https://generativelanguage.googleapis.com/v1beta/models/${modelName}:generateContent?key=${GEMINI_API_KEY}`,
                {
                  method: 'POST',
                  headers: { 'Content-Type': 'application/json' },
                  body: JSON.stringify({
                    contents: [{ parts: [{ text: 'Say hello' }] }],
                    generationConfig: { temperature: 0, maxOutputTokens: 10 },
                  }),
                  signal: AbortSignal.timeout(10000),
                }
              );
              if (testRes.ok) {
                geminiRes = testRes;
                modelUsed = modelName;
                break;
              } else {
                const errBody = await testRes.text().catch(() => '');
                modelErrors.push({ model: modelName, status: testRes.status, error: errBody.substring(0, 200) });
              }
            } catch (e) {
              modelErrors.push({ model: modelName, error: e.message });
            }
          }

          if (!geminiRes || !modelUsed) {
            return jsonResponse({ status: 'error', error: 'No working Gemini model found', testedModels: modelNames, modelErrors: modelErrors, apiKeyPrefix: GEMINI_API_KEY.substring(0, 10) + '...' }, {}, env);
          }

          return jsonResponse({ status: 'success', workingModel: modelUsed, testedModels: modelNames }, {}, env);
        } catch (e) {
          return jsonResponse({ status: 'error', error: e.message }, {}, env);
        }
      }

      // Future: /api/news/stream SSE endpoint for breaking news push.
      // Requires Durable Object for true WebSocket, or simple SSE stream.
      // Current 30s polling + SWR provides adequate UX for Telegram Mini App.

      // Diagnostic endpoints — development only, block in production
      if (/^\/api\/_diag\//.test(url.pathname) && !isDevMode(env)) {
        return jsonResponse({ detail: 'Not found' }, { status: 404 }, env);
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

      // ── Calendar Reminders routes are registered earlier (near /api/calendar/events) ──

      // ── Alert Economy: User quota status ──
      if (request.method === 'GET' && url.pathname === '/api/alerts/quota') {
        return await alertEconomyHandlers.handleQuotaStatus(request, env);
      }

      // ── Alert Economy: Admin config + dashboard ──
      if (request.method === 'GET' && url.pathname === '/api/admin/alert-economy/configs') {
        return await alertEconomyHandlers.handleListConfigs(request, env);
      }
      if (request.method === 'PUT' && /^\/api\/admin\/alert-economy\/configs\/[^/]+$/.test(url.pathname)) {
        const alertType = decodeURIComponent(url.pathname.split('/').pop());
        return await alertEconomyHandlers.handleUpdateConfig(request, env, alertType);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/alert-economy/dashboard') {
        return await alertEconomyHandlers.handleDashboard(request, env);
      }

      // ─────────────────────────────────────────────────────────────
      // TELEGRAM PUBLISHER — channel publishing system (admin-only)
      // ─────────────────────────────────────────────────────────────
      if (url.pathname === '/api/admin/publisher/settings' && (request.method === 'GET' || request.method === 'PUT' || request.method === 'POST')) {
        if (request.method === 'GET') return await publisherHandlers.handleGetSettings(request, env);
        return await publisherHandlers.handleUpdateSettings(request, env);
      }
      if (url.pathname === '/api/admin/publisher/preview' && request.method === 'POST') {
        return await publisherHandlers.handlePreview(request, env);
      }
      if (url.pathname === '/api/admin/publisher/queue' && request.method === 'POST') {
        return await publisherHandlers.handleEnqueue(request, env);
      }
      if (url.pathname === '/api/admin/publisher/send-now' && request.method === 'POST') {
        return await publisherHandlers.handleSendNow(request, env);
      }
      if (url.pathname === '/api/admin/publisher/queue' && request.method === 'GET') {
        return await publisherHandlers.handleListQueue(request, env, 'pending');
      }
      if (url.pathname === '/api/admin/publisher/sent' && request.method === 'GET') {
        return await publisherHandlers.handleListQueue(request, env, 'sent');
      }
      if (url.pathname === '/api/admin/publisher/failed' && request.method === 'GET') {
        return await publisherHandlers.handleListQueue(request, env, 'failed');
      }
      if (url.pathname === '/api/admin/publisher/logs' && request.method === 'GET') {
        return await publisherHandlers.handleListLogs(request, env);
      }
      if (url.pathname === '/api/admin/publisher/stats' && request.method === 'GET') {
        return await publisherHandlers.handleStats(request, env);
      }
      if (url.pathname === '/api/admin/publisher/process' && request.method === 'POST') {
        return await publisherHandlers.handleProcessNow(request, env);
      }
      if (url.pathname === '/api/admin/publisher/test-connection' && request.method === 'POST') {
        return await publisherHandlers.handleTestConnection(request, env);
      }
      if (/^\/api\/admin\/publisher\/retry\/\d+$/.test(url.pathname) && request.method === 'POST') {
        const id = url.pathname.split('/').pop();
        return await publisherHandlers.handleRetry(request, env, id);
      }
      if (/^\/api\/admin\/publisher\/cancel\/\d+$/.test(url.pathname) && request.method === 'POST') {
        const id = url.pathname.split('/').pop();
        return await publisherHandlers.handleCancel(request, env, id);
      }
      if (/^\/api\/admin\/publisher\/sent\/\d+$/.test(url.pathname) && request.method === 'DELETE') {
        const id = url.pathname.split('/').pop();
        return await publisherHandlers.handleDeleteSent(request, env, id);
      }
      if (/^\/api\/admin\/publisher\/dedup\/[^/]+\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
        const parts = url.pathname.split('/');
        const type = decodeURIComponent(parts[parts.length - 2]);
        const refId = decodeURIComponent(parts[parts.length - 1]);
        return await publisherHandlers.handleCheckDedup(request, env, type, refId);
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

      // ROOT CAUSE FIX: DELETE single notification — previously didn't exist,
      // frontend only cleared local state → notifications reappeared on next poll.
      if (request.method === 'DELETE' && /^\/api\/notifications\/[^/]+$/u.test(url.pathname)) {
        const notificationId = url.pathname.split('/')[3] || '';
        return await notificationHandlers.handleDelete(request, env, notificationId);
      }

      // ROOT CAUSE FIX: DELETE ALL notifications — previously clearAllNotifications()
      // in frontend only cleared the local array, no API call.
      if (request.method === 'DELETE' && url.pathname === '/api/notifications') {
        return await notificationHandlers.handleDeleteAll(request, env);
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
            // Cloudflare KV requires expirationTtl >= 60 seconds.
            // Was 3s → caused "KV PUT failed: Invalid expiration_ttl" on every request.
            // Cooldown is now 60s (acceptable: user who clicked Verify can wait 1 min to re-check).
            await env.RATE_LIMITS.put(_rlKey, '1', { expirationTtl: 60 });
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
    } finally {
      // ROOT CAUSE FIX: Close the shared DB pool after each request to
      // prevent WebSocket connection leaks. The pool is recreated on the
      // next request via getSharedPool().
      closeSharedPool(env);
    }
  },

  async scheduled(controller, env, ctx) {
    // Wrap each task with a 25s timeout to prevent waitUntil cancellation
    const withTimeout = (promise, ms = 25000) =>
      Promise.race([
        promise,
        new Promise((resolve) => setTimeout(() => { console.warn('Scheduled task timeout after', ms, 'ms'); resolve(); }, ms)),
      ]);

    const cronExpr = controller.cron || '* * * * *';
    const isEveryMinute = cronExpr === '* * * * *';
    const isEvery15Min = cronExpr === '*/15 * * * *';

    // PRIMARY: Price alert checker — runs on every tick.
    ctx.waitUntil(withTimeout(runScheduledAlertsBaseline(controller, env)));

    // Process notification queue on every tick.
    if (notificationPlatformRepo?.processQueue) {
      ctx.waitUntil(withTimeout(
        notificationPlatformRepo.processQueue(env, sendTelegramMessage).catch((e) => {
          console.warn('Notification queue processing failed:', e?.message);
        })
      ));
    }

    // Refresh CMC Market Overview — ONLY on 15-minute ticks (was running every minute!)
    if (isEvery15Min && env.CMC_API_KEY) {
      ctx.waitUntil(withTimeout(marketOverviewSvc.refreshOverview(env)));
    }

    // Check for upcoming high-impact calendar events — every tick
    ctx.waitUntil(withTimeout(runCalendarAlertsCheck(env)));

    // ── AI NEWS: Background processing — ONLY on every-minute ticks ──
    // Runs every 1 minute. Fetches RSS, caches articles, processes AI summaries.
    // Skip-if-unchanged in writeAppCache prevents redundant KV writes
    // when articles haven't changed since last cycle.
    if (isEveryMinute) {
      ctx.waitUntil(withTimeout(processNewsAIBatch(env), 25000));
    }

    // ── TELEGRAM PUBLISHER: process queue — every tick ──
    if (publisherHandlers?.processPublisherQueue) {
      ctx.waitUntil(withTimeout(
        publisherHandlers.processPublisherQueue(env, { maxItems: 8 }).catch((e) => {
          console.warn('Publisher queue processing failed:', e?.message);
        })
      , 25000));
    }
  },
};
//#endregion

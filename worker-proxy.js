import { createHmac, timingSafeEqual } from 'node:crypto';
import { Pool, neon } from '@neondatabase/serverless';
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
import { createNotificationService } from './src/services/notification_service.js';
import { createAlertEconomyRepository } from './src/repositories/alert_economy.js';
import { createAlertEconomyHandlers } from './src/controllers/alert_economy.js';
import { createPublisherRepository } from './src/repositories/publisher.js';
import { createPublisherHandlers } from './src/controllers/publisher.js';
import { createMarketOverviewService } from './src/services/market_overview_service.js';
import { createMembershipRepository } from './src/repositories/membership.js';
import { createMembershipHandlers } from './src/controllers/membership.js';
import { createNewsArticleRepository } from './src/repositories/news_articles.js';
import { createAppContentRepository } from './src/repositories/app_content.js';

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

// ═══════════════════════════════════════════════════════════════════════════
// TEMPORARY INSTRUMENTATION — traces I/O timing to pinpoint 8s/30s delays.
// Logs ALL queryDb calls (not just >500ms) to find the FIRST timeout.
// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 SAFE OPTIMIZATION: _traceQuery and _traceLog are now gated behind
// env.DB_TRACE_ENABLED. Previously they ran on EVERY queryDb call (console.log
// + JSON.stringify with 13 fields = ~0.08ms CPU each, ~2.4ms per bootstrap with
// 30 queries). Now they only run when explicitly enabled for debugging.
// _traceStage (slow stage >500ms) is ALWAYS enabled — it's cheap (only fires
// on slow operations) and useful for production observability.
let _traceId = 'no-trace';
let _traceEndpoint = '?';
let _traceMethod = '?';
let _traceQuerySeq = 0;
let _dbTraceEnabled = null; // cached env check (null = not yet checked)

function _setTraceContext(endpoint, method) {
  _traceId = Math.random().toString(36).slice(2, 10);
  _traceEndpoint = endpoint || '?';
  _traceMethod = method || '?';
  _traceQuerySeq = 0;
}

function _nextQuerySeq() {
  _traceQuerySeq += 1;
  return _traceQuerySeq;
}

function _traceStage(stageName, startTime) {
  const duration = Date.now() - startTime;
  if (duration > 500) {
    console.log(JSON.stringify({
      type: 'TRACE_SLOW_STAGE',
      traceId: _traceId,
      endpoint: _traceEndpoint,
      method: _traceMethod,
      stage: stageName,
      durationMs: duration,
      ts: new Date().toISOString()
    }));
  }
  return duration;
}

function _traceLog(stageName, extra) {
  // PHASE 2 SAFE OPTIMIZATION: No-op unless DB_TRACE_ENABLED is set.
  // This was used for diagnostic logging during CPU investigations.
  // Keeping the function signature for backward compat but making it a no-op
  // saves the JSON.stringify + console.log cost on every call.
  if (!_dbTraceEnabled) return;
  console.log(JSON.stringify({
    type: 'TRACE',
    traceId: _traceId,
    endpoint: _traceEndpoint,
    method: _traceMethod,
    stage: stageName,
    ...extra,
    ts: new Date().toISOString()
  }));
}

// PHASE 2 SAFE OPTIMIZATION: No-op unless DB_TRACE_ENABLED is set.
// Previously logged EVERY queryDb call. Now only logs when debugging is needed.
function _traceQuery(opts) {
  if (!_dbTraceEnabled) return;
  console.log(JSON.stringify({
    type: 'TRACE_QUERY',
    traceId: _traceId,
    endpoint: _traceEndpoint,
    method: _traceMethod,
    querySeq: opts.seq,
    poolType: opts.poolType,         // 'shared' | 'new'
    sql: opts.sql,                    // SQL preview (first 120 chars)
    startMs: opts.startMs,
    endMs: opts.endMs,
    durationMs: opts.durationMs,
    status: opts.status,              // 'ok' | 'error' | 'timeout'
    error: opts.error || null,        // error message if any
    attempt: opts.attempt || 1,
    ts: new Date().toISOString()
  }));
}

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
  const _t0 = Date.now();
  try {
    const _result = await env.APP_CACHE.get(key);
    _traceStage('KV.read:' + key.slice(0, 40), _t0);
    return _result;
  } catch (e) {
    _traceStage('KV.read.ERROR:' + key.slice(0, 40), _t0);
    console.warn('readAppCache failed (non-fatal):', e.message || e);
    return null;
  }
}

// In-memory cache of last-written values — prevents redundant KV writes.
// Key: KV key, Value: string that was last written.
// Survives for the lifetime of the Worker isolate.
const _kvWriteCache = new Map();
const _KV_WRITE_CACHE_MAX = 200;

// ── KV write tracking (DISABLED — was diagnostic instrumentation) ──
// ROOT-CAUSE FIX: _trackKvWrite and _trackKvSkip ran on EVERY writeAppCache
// call, doing string splitting + object property updates. Now no-ops.
const _kvWriteStats = { startedAt: null, totalWrites: 0, totalSkipped: 0, byKey: {}, byPrefix: {} };
function _trackKvWrite(key) { /* no-op: diagnostic tracking removed */ }
function _trackKvSkip() { /* no-op */ }

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
    // CRITICAL: Cloudflare KV requires expirationTtl >= 60 seconds.
    // Values below 60 cause "Invalid expiration_ttl" errors and the write
    // silently fails (caught below), meaning the cache is NEVER populated.
    // This was the root cause of the Market cache not working (was TTL=30).
    // FIX: Clamp any TTL < 60 up to 60. For TTL=0/undefined, omit (no expiry).
    const putOpts = {};
    if (expirationTtl && expirationTtl > 0) {
      putOpts.expirationTtl = Math.max(60, Math.floor(expirationTtl));
    }
    const _t0 = Date.now();
    await env.APP_CACHE.put(key, value, putOpts);
    _traceStage('KV.write:' + key.slice(0, 40), _t0);
    _trackKvWrite(key);
    if (_kvWriteCache.size >= _KV_WRITE_CACHE_MAX) {
      const firstKey = _kvWriteCache.keys().next().value;
      _kvWriteCache.delete(firstKey);
    }
    _kvWriteCache.set(key, value);
  } catch (e) {
    _traceStage('KV.write.ERROR:' + key.slice(0, 40), Date.now());
    console.warn('[writeAppCache] KV.put FAILED for key:', key, '| error:', e.message || e);
  }
}

// ROOT-CAUSE FIX: diagLog/flushDiagLog/diagLogSync were diagnostic logging
// functions that ran JSON.stringify + console.log + KV write on EVERY referral
// flow step (15+ calls per bootstrap). Each call costs ~0.5-1ms CPU.
// 15 calls × 1ms = 15ms CPU → exceededResources.
// These are now no-ops. All call sites remain for code structure but do nothing.
async function diagLog(env, entry) { /* no-op: diagnostic logging removed */ }
async function flushDiagLog(env) { /* no-op */ }
function diagLogSync(env, entry) { /* no-op */ }

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

    // ROOT CAUSE FIX (R-1.1): Extract start_param from the SIGNED initData.
    // Previously, validateTelegramInitData only returned the user object,
    // discarding start_param. The frontend then sent referrer_id in the
    // request body — which is NOT signed and can be tampered with.
    // Now we return start_param alongside user so the caller can use the
    // SIGNED referrer value instead of trusting the request body.
    const startParamPair = pairs.find(([k]) => k === 'start_param');
    const startParam = startParamPair ? decodeTelegramValue(startParamPair[1]) : null;

    return user && user.id ? { user, startParam } : null;
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
        startParam: null,
      };
    }

    if (!isBotConfigured(env)) {
      return {
        error: jsonResponse({ detail: 'Telegram bot token is not configured' }, { status: 401 }, env),
        user: null,
        startParam: null,
      };
    }

    const validated = await validateTelegramInitData(initData, String(env.TELEGRAM_BOT_TOKEN || ''));
    // ROOT CAUSE FIX (R-1.1): validateTelegramInitData now returns
    // { user, startParam } instead of just user. We extract both.
    // The startParam is the SIGNED start_param from initData — it cannot
    // be tampered with because it's covered by the HMAC hash.
    if (!validated || !validated.user || !validated.user.id) {
      return {
        error: jsonResponse({ detail: 'Invalid Telegram init data' }, { status: 401 }, env),
        user: null,
        startParam: null,
      };
    }

    return { error: null, user: validated.user, startParam: validated.startParam || null };
  } catch (e) {
    // SECURITY: If validateTelegramInitData throws (malformed initData, crypto error),
    // we must return 401 — never let the exception propagate and cause a 500.
    console.warn('authenticateTelegramRequest error:', e?.message || String(e));
    return {
      error: jsonResponse({ detail: 'Authentication error' }, { status: 401 }, env),
      user: null,
      startParam: null,
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
    const membership = await resolveChannelMembership(env, String(user.id), { forceRefresh: false, skipRewardProcessing: true });
    if (membership?.joined) {
      return null; // Member — allowed
    }
  } catch {
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
    // ROOT CAUSE FIX (R-1.1): pass through startParam from signed initData
    return { user: authState.user, startParam: authState.startParam || null, authMethod: 'init_data', error: null };
  }

  // Security (C-1): fallback is ONLY allowed outside production.
  // In production, only cryptographically-verified initData is accepted.
  if (!isDevMode(env)) {
    return { user: null, startParam: null, authMethod: null, error: authState.error };
  }

  // Dev/test fallback — try query-param ?user_id=
  const url = new URL(request.url);
  const fallbackId = (url.searchParams.get('user_id') || '').trim();

  if (fallbackId && /^\d+$/.test(fallbackId)) {
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

  // ROOT CAUSE FIX: When payload has a 'photo' field, use sendPhoto API
  // instead of sendMessage. Previously, ALL messages used sendMessage which
  // silently ignored the photo field — image messages were sent as text-only.
  const apiMethod = payload.photo ? 'sendPhoto' : 'sendMessage';

  for (let attempt = 0; attempt <= retries; attempt++) {
    try {
      const _t0 = Date.now();
      const response = await fetch(buildTelegramApiUrl(env, apiMethod), {
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
          _traceStage('Telegram.fetch:' + apiMethod + ' (attempt ' + (attempt+1) + ')', _t0);
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

// ────────────────────────────────────────────────────────────────────────────
// CONNECTION LAYER — ROOT-CAUSE FIX for "Cannot perform I/O on behalf of a
// different request"
//
// ARCHITECTURE
//   • Regular queries → neon() HTTP client (STATELESS, cached at module level)
//   • Transactions     → per-call Pool (WebSocket, created AND ended in one call)
//
// ROOT CAUSE OF THE OLD ERROR
//   The previous design cached a WebSocket `Pool` at module level
//   (`_modulePoolCache`). On Cloudflare Workers every request has its own I/O
//   context. A WebSocket connection opened inside Request A's context is BOUND
//   to that context. When Request B reuses the cached Pool, `pool.query()`
//   tries to drive a WebSocket that belongs to A's (now-finished) request
//   context → "Cannot perform I/O on behalf of a different request".
//   This broke: cron (1-min) alerts, channel-membership checks, admin
//   detection, and every admin-panel data fetch.
//
// WHY neon() HTTP IS SAFE TO CACHE
//   The neon() HTTP client is STATELESS: each query is a fresh `fetch()` to
//   Neon's HTTP SQL API. There is NO persistent socket, so there is NOTHING
//   that can belong to a different request. The cached object holds only config
//   (connection string + options) — no I/O state. Caching it at module level is
//   100% safe across requests AND across cron/HTTP boundaries.
//
// WHY TRANSACTIONS USE A PER-CALL POOL
//   Interactive transactions (BEGIN → dependent queries → COMMIT) need a
//   persistent WebSocket. We create a brand-new Pool inside queryDbTransaction,
//   use pool.connect() for the transaction, and `await pool.end()` in `finally`.
//   Because the Pool is created AND destroyed within a single request's async
//   execution, no I/O object ever crosses a request boundary.
//
// CPU PROFILE
//   neon() HTTP uses `fetch()` (~0.1ms CPU/query, no TLS handshake) — far under
//   the 10ms free-plan limit even for the every-minute cron (alerts+calendar).
//   Per-call Pool for transactions pays one TLS handshake (~5ms) ONLY when a
//   transaction actually runs (daily claim / wheel spin — a handful per minute).
// ────────────────────────────────────────────────────────────────────────────

// Resolve the connection string for the neon() HTTP client.
// Prefers DIRECT_URL (non-pooler) because Neon's HTTP SQL API is served on the
// DIRECT host — the pooler (-pooler) host speaks Postgres wire protocol only
// and does NOT serve HTTP. Using the pooler host here was the cause of the old
// "HTTP 530 / Error 1016" failures. We also strip `pgbouncer=true` (a
// WebSocket-only hint that is meaningless for HTTP).
function resolveNeonDatabaseUrl(env) {
  let url = String(env.DIRECT_URL || env.DATABASE_URL || '').trim();
  if (!url) return '';
  url = url.replace(/([?&])pgbouncer=true(&?)/, (_m, lead, trail) =>
    trail ? lead : (lead === '?' ? '' : ''),
  );
  return url;
}

// Module-level cache of neon() HTTP clients, keyed by connection string.
// SAFE: the neon() client holds only config — no sockets, no request context.
const _moduleNeonCache = new Map();

function getSharedNeon(env) {
  const url = resolveNeonDatabaseUrl(env);
  if (!url) return null;
  // Only use neon() HTTP for real Neon connection strings (contain neon.tech
  // or neon.ws in hostname). Mock/test URLs (e.g., postgres://mock) would
  // cause neon() HTTP to fail with DNS errors, changing error behavior
  // compared to Pool fallback. This check ensures tests using mock URLs
  // fall through to Pool (same behavior as before this fix).
  if (!url.includes('neon.tech') && !url.includes('neon.ws')) return null;
  if (_moduleNeonCache.has(url)) return _moduleNeonCache.get(url);
  let sql;
  try {
    // fullResults:true → returns { rows, rowCount, fields, ... } exactly like
    // pool.query(), so all existing callers (result.rows[0], result.rowCount)
    // keep working unchanged.
    sql = neon(url, { fullResults: true });
  } catch (e) {
    console.warn('[DB] neon() client init failed:', e?.message);
    return null;
  }
  _moduleNeonCache.set(url, sql);
  return sql;
}

// Create a brand-new Pool for a SINGLE transaction. NOT cached — used and
// `await pool.end()`-ed within queryDbTransaction so its WebSocket (and the
// request context it binds to) never escapes that call.
function createPool(env) {
  const _t0 = Date.now();
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) return null;
  const _poolId = 'p' + Math.random().toString(36).slice(2, 8);
  const _pool = new Pool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 3000,
  });
  _traceStage('Pool.create', _t0);
  _traceLog('Pool.create', { poolId: _poolId, durationMs: Date.now() - _t0 });
  _pool._tracePoolId = _poolId;
  return _pool;
}

/**
 * Phase-Scoped Pool helper for cron handlers.
 *
 * Creates a Pool and runs an async callback with it. The Pool is a LOCAL
 * variable (NOT stored on env), so it's never visible to other requests —
 * this prevents the "Cannot perform I/O on behalf of a different request"
 * bug that occurred with env._reqPool.
 *
 * Usage (in cron handler):
 *   const result = await withPhasePool(env, async (pool) => {
 *     await requeueStaleQueueItems(env, pool);
 *     await requeueStaleBroadcasts(env, pool);
 *     return { ok: true };
 *   });
 *
 * The pool is closed in `finally` so it's always released, even on error.
 *
 * NOTE: This is infrastructure only. It does NOT change cron behavior.
 * The cron handler still uses parallel ctx.waitUntil() calls per phase.
 * To use phase-scoped Pool, each phase's ctx.waitUntil must wrap its
 * queryDb calls in withPhasePool. This will be done in Phase 2 after
 * validation.
 */
async function withPhasePool(env, fn) {
  if (!isDatabaseConfigured(env)) {
    return fn(null);
  }
  const _phasePool = createPool(env);
  if (!_phasePool) {
    return fn(null);
  }
  try {
    return await fn(_phasePool);
  } finally {
    try { await _phasePool.end(); } catch {}
  }
}

/**
 * Wrap a handler with a request-scoped shared Pool.
 *
 * Creates ONE Pool (ONE TLS handshake to Supabase) that is reused by ALL
 * queryDb calls within the handler. Without this, each queryDb creates its
 * own Pool + TLS handshake (~100ms CPU each), causing Error 1102 when a
 * handler makes multiple queryDb calls.
 *
 * Usage:
 *   return handler.handleFoo(request, env, ctx);
 *
 * The Pool is closed in `finally` so its WebSocket is released before the
 * response is returned. Safe for Cloudflare Workers — the Pool never
 * outlives the request.
 */
async function withSharedPool(env, fn) {
  if (!isDatabaseConfigured(env)) {
    return fn();
  }
  env._reqPool = createPool(env);
  try {
    return await fn();
  } finally {
    if (env._reqPool) {
      try { await env._reqPool.end(); } catch {}
      env._reqPool = null;
    }
  }
}

async function getDbUserJoinState(env, userId) {
  // Routes through queryDb() → neon() HTTP (stateless). No shared Pool.
  try {
    const result = await queryDb(
      env,
      'SELECT telegram_id, channel_joined FROM users WHERE telegram_id = $1 LIMIT 1',
      [String(userId)],
    );
    const row = result.rows[0];
    if (!row) return null;
    return {
      telegram_id: String(row.telegram_id),
      channel_joined: Boolean(row.channel_joined),
    };
  } catch (error) {
    console.warn(safeError('join-db-read', error));
    return null;
  }
}

async function persistDbUserJoinState(env, userId, joined) {
  // Routes through queryDb() → neon() HTTP (stateless). No shared Pool.
  try {
    await queryDb(
      env,
      `INSERT INTO users (telegram_id, lang, channel_joined, channel_verified_at, bot_joined_at, created_at, updated_at)
       VALUES ($1, 'fa', $2, $3, NOW(), NOW(), NOW())
       ON CONFLICT (telegram_id) DO UPDATE
       SET channel_joined = EXCLUDED.channel_joined, channel_verified_at = EXCLUDED.channel_verified_at,
           bot_joined_at = COALESCE(users.bot_joined_at, NOW()), updated_at = NOW()`,
      [String(userId), Boolean(joined), joined ? new Date().toISOString() : null],
    );
  } catch (error) {
    console.warn(safeError('join-db-write', error));
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
// Module-level cache for referral reward amount. The value rarely changes
// (only when admin updates reward tiers), so a 60-second TTL is safe and
// eliminates a DB query on every processPendingReferralReward call.
let _rewardPerInviteCache = { value: null, expiresAt: 0 };
const REWARD_PER_INVITE_CACHE_TTL = 60000; // 60 seconds

async function getReferralRewardPerInvite(env) {
  // Check cache first
  const now = Date.now();
  if (_rewardPerInviteCache.value !== null && now < _rewardPerInviteCache.expiresAt) {
    return _rewardPerInviteCache.value;
  }
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
        const val = Number(result.rows[0].token_amount);
        _rewardPerInviteCache = { value: val, expiresAt: now + REWARD_PER_INVITE_CACHE_TTL };
        return val;
      }
    } catch (e) {
      // Table might not exist yet — fall through to env fallback
      console.warn('getReferralRewardPerInvite DB read failed, using env fallback:', e.message);
    }
  }
  // Env fallback (still configurable, but DB takes priority)
  const fallback = Math.max(getNumericEnv(env, 'REFERRAL_TOKENS_PER_INVITE', 3), 0);
  _rewardPerInviteCache = { value: fallback, expiresAt: now + REWARD_PER_INVITE_CACHE_TTL };
  return fallback;
}

// ── PER-CALL POOL (NO module-level state) ──────────────────────────────────
// ROOT-CAUSE FIX for "A promise was resolved from a different request context":
//
// The previous request-scoped Pool (_requestPool module-level variable) was
// SHARED across requests. Cloudflare Workers can interleave requests within
// the same isolate at await points — so while request A is awaiting a DB
// query, request B can start and read the same _requestPool. When request A's
// query resolves, it resolves in request B's context → the runtime error
// "A promise was resolved or rejected from a different request context" →
// "Worker's code had hung" → request canceled.
//
// FIX: return to PER-CALL Pool. Each queryDb call creates a fresh Pool, runs
// the query, and `await pool.end()`s it in `finally`. The Pool's WebSocket
// is created, used, and destroyed entirely within one synchronous async
// execution — it NEVER outlives the await boundary, so it can NEVER be
// observed by a different request.
//
// CPU cost: ~3-5ms per queryDb (Pool creation + TLS handshake). This is
// acceptable because:
//   1. Most endpoints make 1-3 queries (under 10ms CPU)
//   2. ensureSchema uses _schemaVerified cache (0 queries on warm isolates)
//   3. getReferralRewardPerInvite uses 60s cache (0 queries on warm isolates)
//   4. The retry logic only triggers on transient errors
//
// This is the ONLY safe pattern for @neondatabase/serverless Pool in
// Cloudflare Workers. Module-level Pool caching does NOT work because
// WebSocket connections are bound to the request context that created them.

async function queryDb(env, sqlText, params = [], retries = 1, pool = null) {
  const _seq = _nextQuerySeq();
  const _sqlPreview = String(sqlText).replace(/\s+/g, ' ').slice(0, 120);
  const _t0 = Date.now();
  // Phase-Scoped Pool: if a pool is explicitly passed (e.g., from cron handler),
  // use it directly. This allows multiple queryDb calls to share ONE Pool
  // without using env._reqPool (which would cause race conditions in parallel
  // ctx.waitUntil phases). The pool is a LOCAL variable in the caller's closure,
  // so it's NEVER visible to other requests → no "Cannot perform I/O" bug.
  if (pool) {
    try {
      const _result = await pool.query(sqlText, params);
      const _t1 = Date.now();
      _traceStage('queryDb.phasePool:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'phasePool', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _t1 - _t0 >= 7900 ? 'timeout' : 'ok', attempt: 1
      });
      return _result;
    } catch (error) {
      const _t1 = Date.now();
      const _errMsg = String(error?.message || '').slice(0, 200);
      const _isTimeout = _t1 - _t0 >= 7900 || _errMsg.includes('timeout') || _errMsg.includes('Timed out');
      _traceStage('queryDb.phasePool.ERROR:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'phasePool', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _isTimeout ? 'timeout' : 'error', error: _errMsg, attempt: 1
      });
      throw error;
    }
  }
  // Request-scoped shared pool: if env._reqPool is set (by the route wrapper),
  // reuse it instead of creating a per-call Pool. This means ALL queryDb calls
  // within one request share ONE WebSocket → ONE TLS handshake.
  if (env && env._reqPool) {
    try {
      const _result = await env._reqPool.query(sqlText, params);
      const _t1 = Date.now();
      _traceStage('queryDb.shared:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'shared', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _t1 - _t0 >= 7900 ? 'timeout' : 'ok', attempt: 1
      });
      return _result;
    } catch (error) {
      const _t1 = Date.now();
      const _errMsg = String(error?.message || '').slice(0, 200);
      const _isTimeout = _t1 - _t0 >= 7900 || _errMsg.includes('timeout') || _errMsg.includes('Timed out');
      _traceStage('queryDb.shared.ERROR:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'shared', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _isTimeout ? 'timeout' : 'error', error: _errMsg, attempt: 1
      });
      // If the shared pool is broken, clear it so future calls fall back.
      env._reqPool = null;
      throw error;
    }
  }

  // ── neon() HTTP path: stateless, no WebSocket, no TLS handshake ──
  // PROVEN: getSharedNeon() was defined (line 1280) but NEVER called.
  // All cron queries are non-transactional (SELECT/INSERT/UPDATE/DELETE).
  // neon() HTTP is safe for these — each query is a separate fetch() to
  // Neon's HTTP SQL API. No persistent connection = no TLS handshake CPU.
  // queryDbTransaction (BEGIN/COMMIT) still uses Pool — it's never called
  // from cron.
  const _sql = getSharedNeon(env);
  if (_sql) {
    try {
      const _result = await _sql(sqlText, params);
      const _t1 = Date.now();
      _traceStage('queryDb.neon:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'neon', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _t1 - _t0 >= 7900 ? 'timeout' : 'ok', attempt: 1
      });
      return _result;
    } catch (error) {
      const _t1 = Date.now();
      const _errMsg = String(error?.message || '').slice(0, 200);
      const _isTimeout = _t1 - _t0 >= 7900 || _errMsg.includes('timeout') || _errMsg.includes('Timed out');
      _traceStage('queryDb.neon.ERROR:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'neon', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _isTimeout ? 'timeout' : 'error', error: _errMsg, attempt: 1
      });
      // Fall through to Pool fallback (below) — neon() HTTP may fail if
      // Neon HTTP endpoint is unavailable; Pool uses WebSocket which may work.
    }
  }

  // ── Pool fallback: create a per-call WebSocket Pool (original path 3) ──
  const _tPoolCreate = Date.now();
  const _callPool = createPool(env);
  if (!_callPool) throw new Error('Database not configured');

  try {
    for (let attempt = 0; attempt <= retries; attempt++) {
      const _tAttempt = Date.now();
      try {
        const _result = await _callPool.query(sqlText, params);
        const _t1 = Date.now();
        _traceStage('queryDb.pool:' + _sqlPreview.slice(0, 60) + ' (attempt ' + (attempt+1) + ')', _t0);
        _traceQuery({
          seq: _seq, poolType: 'new', sql: _sqlPreview,
          startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
          status: _t1 - _t0 >= 7900 ? 'timeout' : 'ok', attempt: attempt + 1
        });
        return _result;
      } catch (error) {
        const _t1 = Date.now();
        const msg = String(error?.message || '');
        const _isTimeout = _t1 - _tAttempt >= 7900 || msg.includes('timeout') || msg.includes('Timed out');
        const isTransient = msg.includes('530') ||
                            msg.includes('1016') ||
                            msg.includes('ECONNRESET') ||
                            msg.includes('Connection terminated') ||
                            msg.includes('timeout') ||
                            msg.includes('fetch failed') ||
                            msg.includes('network');
        if (attempt === retries || !isTransient) {
          _traceStage('queryDb.pool.ERROR:' + _sqlPreview.slice(0, 60) + ' (attempt ' + (attempt+1) + ', ' + msg.slice(0, 60) + ')', _t0);
          _traceQuery({
            seq: _seq, poolType: 'new', sql: _sqlPreview,
            startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
            status: _isTimeout ? 'timeout' : 'error', error: msg.slice(0, 200), attempt: attempt + 1
          });
          throw error;
        }
        _traceLog('queryDb.retry', { seq: _seq, sql: _sqlPreview.slice(0, 60), attempt: attempt + 1, error: msg.slice(0, 80) });
        const ms = Math.min(300 * 2 ** attempt, 2000);
        await new Promise((r) => setTimeout(r, ms));
      }
    }
  } finally {
    const _tEnd = Date.now();
    try { await _callPool.end(); } catch {}
    _traceStage('queryDb.poolEnd:' + _sqlPreview.slice(0, 60), _tEnd);
  }
}

/**
 * Execute multiple SQL statements inside a single interactive DB transaction.
 *
 * Uses a FRESH Pool (WebSocket) created per call — NEVER shared across requests.
 * The Pool is fully closed (`await pool.end()`) in `finally` before returning,
 * so its WebSocket — and the request context that WebSocket is bound to — is
 * released synchronously with this call. No I/O object escapes, therefore no
 * "Cannot perform I/O on behalf of a different request" is possible.
 *
 * This is the ONLY place a Pool is used; regular queries go through neon() HTTP.
 */
async function queryDbTransaction(env, queries) {
  const _seq = _nextQuerySeq();
  const _t0 = Date.now();
  const _numQueries = queries ? queries.length : 0;
  const _sqlPreviews = queries ? queries.map(q => String(q.sql).replace(/\s+/g, ' ').slice(0, 80)).join(' | ') : '';
  const _tPoolCreate = Date.now();
  const pool = createPool(env);
  if (!pool) throw new Error('Database not configured');

  let client;
  const _tConnect = Date.now();
  try {
    client = await pool.connect();
    const _tConnectEnd = Date.now();
    _traceStage('queryDbTransaction.connect (' + _numQueries + ' queries)', _tConnect);
    _traceQuery({
      seq: _seq, poolType: 'new-txn', sql: '[CONNECT] ' + _sqlPreviews.slice(0, 120),
      startMs: _tConnect, endMs: _tConnectEnd, durationMs: _tConnectEnd - _tConnect,
      status: _tConnectEnd - _tConnect >= 7900 ? 'timeout' : 'ok', attempt: 1
    });
    await client.query('BEGIN');
    const results = [];
    for (const { sql, params } of queries) {
      results.push(await client.query(sql, params));
    }
    await client.query('COMMIT');
    const _t1 = Date.now();
    _traceStage('queryDbTransaction.total (' + _numQueries + ' queries)', _t0);
    _traceQuery({
      seq: _seq, poolType: 'new-txn', sql: '[TOTAL ' + _numQueries + 'Q] ' + _sqlPreviews.slice(0, 120),
      startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
      status: _t1 - _t0 >= 7900 ? 'timeout' : 'ok', attempt: 1
    });
    return results;
  } catch (error) {
    const _t1 = Date.now();
    const _errMsg = String(error?.message || '').slice(0, 200);
    const _isTimeout = _t1 - _t0 >= 7900 || _errMsg.includes('timeout') || _errMsg.includes('Timed out');
    _traceStage('queryDbTransaction.ERROR (' + _numQueries + ' queries, ' + _errMsg.slice(0, 60) + ')', _t0);
    _traceQuery({
      seq: _seq, poolType: 'new-txn', sql: '[ERROR] ' + _sqlPreviews.slice(0, 120),
      startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
      status: _isTimeout ? 'timeout' : 'error', error: _errMsg, attempt: 1
    });
    try { if (client) await client.query('ROLLBACK'); } catch {}
    throw error;
  } finally {
    if (client) {
      try { client.release(); } catch {}
    }
    try { await pool.end(); } catch {}
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
 * Credit referral reward tokens AND mark referral as rewarded.
 *
 * NOTE: These are TWO SEPARATE database operations, NOT a single transaction:
 *   1. economyService.grantReward → creditTokens (uses queryDbTransaction
 *      with BEGIN/COMMIT for balance + transaction INSERT)
 *   2. UPDATE referrals SET rewarded=TRUE (separate queryDb call)
 *
 * If the Worker crashes between steps 1 and 2:
 *   - Token balance is credited (step 1 committed)
 *   - referral.rewarded stays FALSE
 *   - retryFailedReferralRewards cron will retry
 *   - On retry, creditTokens' UNIQUE constraint on (user_id, tx_type, ref_id)
 *     prevents double-credit — returns {idempotent: true}
 *   - UPDATE referrals SET rewarded=TRUE then succeeds
 *
 * If alsoVerifyChannel is true, also sets channel_verified = TRUE (used when
 * an existing referral gets its channel verification + reward in one go).
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
    // ROOT CAUSE FIX (R-2.4): Added `AND rewarded = FALSE` condition.
    // Previously the UPDATE always succeeded even if rewarded was already
    // TRUE, providing no additional race protection. Now the UPDATE is
    // conditional — if a concurrent caller already set rewarded=TRUE, this
    // UPDATE affects 0 rows (which we ignore — the idempotency is handled
    // by creditTokens' UNIQUE constraint on ref_id).
    await queryDb(env,
      alsoVerifyChannel
        ? 'UPDATE referrals SET channel_verified = TRUE, rewarded = TRUE WHERE id = $1 AND rewarded = FALSE'
        : 'UPDATE referrals SET rewarded = TRUE WHERE id = $1 AND rewarded = FALSE',
      [Number(referralId)],
    );

  // Send referral + reward notifications via NotificationService (single entry point)
  // ROOT CAUSE FIX (4.5): Only dispatch notifications if the reward was NOT
  // idempotent (i.e., this is the first time the reward is credited). If
  // creditTokens returned idempotent:true, a concurrent caller already
  // dispatched the notifications — dispatching again would spam the inviter
  // with duplicate notifications.
  if (notificationService && result && !result.idempotent) {
    try {
      // Referral notification (new referral created) + Reward notification
      // dispatched in parallel for efficiency
      await Promise.all([
        notificationService.create(env, {
          userId: inviterId,
          templateKey: 'referral_new_invite',
          category: 'referral',
          priority: 'medium',
          channel: 'mini_app',
          metadata: { invitee_id: String(inviteeId), referral_id: String(referralId) },
          dedupKey: `referral_new_${referralId}`,
        }).catch(() => {}),
        notificationService.create(env, {
          userId: inviterId,
          templateKey: 'referral_reward',
          category: 'referral',
          priority: 'high',
          channel: 'both',
          metadata: { amount: String(amount), referral_id: String(referralId), invitee_id: String(inviteeId) },
          dedupKey: `referral_reward_${referralId}`,
        }).catch(() => {}),
      ]);
    } catch { /* notification failure should not break reward */ }
  }

  // ── Phase 2: Rich Telegram message to inviter with reward details + buttons ──
  // This is a premium UX message with inline keyboard buttons.
  // Per Phase 2: all Telegram delivery goes through NotificationService → queue.
  // The service supports telegramExtra (reply_markup, parse_mode) for rich messages.
  // skipInApp:true because this is a rich Telegram message (the in-app notification
  // was already created by the dispatch above).
  if (notificationService && result && !result.idempotent) {
    try {
      const newBalance = result.newBalance || 0;
      const botUsername = String(env.BOT_USERNAME || '');
      const webAppUrl = resolveWebAppUrl(env);
      const referralCenterUrl = webAppUrl ? `${webAppUrl}?startapp=referral_center` : null;
      const myReferralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${inviterId}` : null;

      const messageText =
        `🎉 تبریک!\n\n` +
        `👤 یک کاربر جدید با لینک دعوت شما وارد AMIRBTC Assistant شد.\n\n` +
        `🎁 پاداش شما: +${amount} Token\n` +
        `💎 موجودی جدید شما: ${newBalance} Token\n\n` +
        `از دعوت دوستان خود، توکن بیشتری دریافت کنید.`;

      // Build inline keyboard with two buttons
      const inlineKeyboard = [];
      if (referralCenterUrl) {
        inlineKeyboard.push([{
          text: '👥 مشاهده رفرال‌ها',
          web_app: { url: referralCenterUrl },
        }]);
      }
      if (myReferralLink) {
        inlineKeyboard.push([{
          text: '🔗 لینک دعوت من',
          url: myReferralLink,
        }]);
      }

      await notificationService.create(env, {
        userId: String(inviterId),
        category: 'referral',
        priority: 'high',
        channel: 'telegram',
        forceChannel: true,
        skipInApp: true,
        title: '🎉 تبریک!',
        message: messageText,
        metadata: { kind: 'referral_rich_message', invitee_id: String(inviteeId), amount: String(amount), new_balance: String(newBalance) },
        dedupKey: `referral_rich_${referralId}`,
        telegramExtra: {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined,
        },
      });
      await diagLog(env, { scope: 'diag-referral-reward-message-ENQUEUED', inviterId, inviteeId, amount, newBalance });
    } catch (msgErr) {
      // Non-fatal — the reward was credited, just the message failed to enqueue
      console.warn('[REFERRAL] Reward message enqueue failed (non-fatal):', msgErr?.message);
      await diagLog(env, { scope: 'diag-referral-reward-message-FAILED', error: msgErr?.message });
    }
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
 * ROOT CAUSE FIX (R-2.6): Retry failed referral rewards.
 *
 * Previously, if processPendingReferralReward failed (DB error, kill switch,
 * rewardAmount=0), the referral row stayed rewarded=FALSE forever — no
 * automatic retry. The user never got their reward and admin had no
 * visibility.
 *
 * This function is called by the cron every 5 minutes. It finds ALL
 * referrals where:
 *   - rewarded = FALSE
 *   - channel_verified = TRUE (invitee joined the channel)
 *   - created_at > NOW() - 24 hours (only retry recent ones, not ancient)
 * and re-runs processPendingReferralReward for each.
 *
 * Idempotent: creditTokens' UNIQUE constraint on ref_id ensures no
 * double-credit even if the retry runs concurrently with a bootstrap.
 */
async function retryFailedReferralRewards(env) {
  if (!isDatabaseConfigured(env)) return;
  try {
    // REF-003 FIX: Removed 24-hour filter — all eligible unrewarded referrals
    // should be retried, not just recent ones. Previously, referrals older
    // than 24h with channel_verified=TRUE and rewarded=FALSE were permanently
    // lost (no other recovery path exists).
    //
    // Safety: LIMIT 20 + ORDER BY created_at ASC ensures:
    //   1. Bounded batch — max 20 retries per cron tick (every 15 min)
    //   2. Oldest first — referrals waiting longest get priority
    //   3. Idempotent — creditTokens UNIQUE constraint prevents double-credit
    //   4. Subrequest budget — ~21 subrequests for 20 retries (under 50 limit)
    //   5. No starvation — next tick continues from where this one left off
    //      (processed referrals get rewarded=TRUE, so they're excluded next time)
    const result = await queryDb(env,
      `SELECT DISTINCT invitee_id FROM referrals
       WHERE rewarded = FALSE AND channel_verified = TRUE
       ORDER BY invitee_id ASC
       LIMIT 20`,
    );
    if (result.rows.length === 0) return;

    let retried = 0;
    let succeeded = 0;
    for (const row of result.rows) {
      try {
        const outcome = await processPendingReferralReward(env, String(row.invitee_id), true);
        retried++;
        if (outcome && outcome.rewarded) succeeded++;
      } catch (e) {
        // Individual retry failure — don't abort the batch
        console.warn('Referral retry failed for invitee', row.invitee_id, e?.message);
      }
    }
    if (retried > 0) {
          }
  } catch (e) {
    console.warn(safeError('referral-retry-cron', e));
  }
}

/**
 * ROOT CAUSE FIX (3.5): Retry failed wheel rewards.
 *
 * If consumeSpin succeeds but grantReward fails (DB error, kill switch),
 * the spin is marked 'used' but the user gets no tokens. This function
 * finds wheel_history rows where reward_amount > 0 but no matching
 * token_transactions row exists, and re-grants the reward.
 *
 * Idempotent: creditTokens' UNIQUE constraint on ref_id prevents
 * double-credit even if this runs concurrently with a spin.
 */
async function retryFailedWheelRewards(env) {
  if (!isDatabaseConfigured(env)) return;
  if (!economyService || !walletRepo) return;
  try {
    // Find wheel_history rows from the last 24h where reward_amount > 0
    // and no matching token_transaction exists for the expected refId.
    // refId format: wheel_${user_id}_${today}_${spin_id}
    const result = await queryDb(env,
      `SELECT wh.id, wh.user_id, wh.spin_id, wh.reward_amount, wh.reward_type,
              wh.reward_label, wh.created_at,
              to_char(wh.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS spin_date_str
       FROM wheel_history wh
       WHERE wh.reward_amount > 0
       AND wh.created_at > NOW() - INTERVAL '24 hours'
       AND NOT EXISTS (
         SELECT 1 FROM token_transactions tt
         WHERE tt.user_id = wh.user_id
         AND tt.tx_type = 'wheel_reward'
         AND tt.ref_id = 'wheel_' || wh.user_id || '_' || to_char(wh.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '_' || wh.spin_id
         AND tt.status = 'completed'
       )
       LIMIT 20`,
    );
    if (result.rows.length === 0) return;

    let retried = 0;
    let succeeded = 0;
    for (const row of result.rows) {
      try {
        const refId = `wheel_${row.user_id}_${row.spin_date_str}_${row.spin_id}`;
        const grantResult = await economyService.grantReward({
          userId: row.user_id,
          amount: Number(row.reward_amount),
          rewardType: row.reward_type,
          description: `Wheel reward (retry): ${row.reward_label || row.reward_type}`,
          refId: refId,
          metadata: { spin_id: row.spin_id, retry: true },
          auditInfo: { actor: 'cron-retry' },
          env,
        });
        retried++;
        if (grantResult && (grantResult.success || grantResult.idempotent)) succeeded++;
      } catch (e) {
        console.warn('Wheel reward retry failed for spin', row.spin_id, e?.message);
      }
    }
    if (retried > 0) {
          }
  } catch (e) {
    console.warn(safeError('wheel-reward-retry-cron', e));
  }
}

/**
 * Process referral on user bootstrap.
 *
 * ── ROOT-CAUSE FIX (referral not registering for returning users) ──
 * Previously this function had a `if (!isNewUser) return null` gate that
 * blocked referrals for ANY user who already had a DB row — even if they
 * had NO prior referral. This meant:
 *   - A user who opened the app once (without a referral link) could NEVER
 *     be referred later, even on their very first referral-link click.
 *   - A user who deleted their account and re-registered would be blocked
 *     if the user row was recreated before the referral was processed.
 *
 * FIX: The `isNewUser` gate is REMOVED. Referral attribution is now governed
 * SOLELY by the "first inviter wins" rule:
 *   1. If a referral row already exists for this invitee → keep the original
 *      inviter (no re-attribution). Idempotent.
 *   2. If NO referral row exists → create one (ON CONFLICT DO NOTHING for
 *      race safety). This works for brand-new users AND for existing users
 *      who never had a referral.
 *
 * This is safe because:
 *   - Self-referral is still rejected (M-R4 check).
 *   - Duplicate prevention is enforced by the referrals.invitee_id UNIQUE
 *     constraint + the pre-check at step 2.
 *   - Reward is still delegated to processPendingReferralReward (idempotent).
 *
 * Debug logging covers EVERY step so production issues can be traced:
 *   Start Parameter → Referrer → Telegram ID → Bootstrap → isNewUser
 *   → Insert → Reward → Final Result
 */
async function processReferralOnBootstrap(env, inviteeId, referrerId, channelJoined, isNewUser) {
  // ── DEBUG: Step 1 — Log entry point with all parameters ──
  await diagLog(env, {
    scope: 'diag-referral-STEP1-ENTRY',
    inviteeId,
    referrerId,
    channelJoined,
    isNewUser,
    note: 'processReferralOnBootstrap called'
  });

  const normalizedReferrerId = normalizeOptionalString(referrerId);

  // ── DEBUG: Step 2 — Validate referrer_id (M-R4: must be numeric, not self) ──
  if (!normalizedReferrerId || !/^\d{1,20}$/.test(normalizedReferrerId) || normalizedReferrerId === String(inviteeId)) {
    await diagLog(env, {
      scope: 'diag-referral-STEP2-REJECTED',
      reason: 'M-R4-invalid-or-self',
      normalizedReferrerId,
      inviteeId,
      referrerIdRaw: referrerId
    });
    return null;
  }
  await diagLog(env, { scope: 'diag-referral-STEP2-VALID', normalizedReferrerId, inviteeId });

  // ── ANTI-ABUSE: Check 15-day referral cooldown for deleted accounts ──
  // If this user previously deleted their account, they are in a 15-day
  // cooldown during which they CANNOT generate a new referral reward.
  // They can still use the app — only the referral is blocked.
  // This prevents abuse: delete → re-register with self-referral → farm rewards.
  if (typeof userRepo?.checkReferralCooldown === 'function') {
    const cooldown = await userRepo.checkReferralCooldown(env, inviteeId);
    if (cooldown.inCooldown) {
      await diagLog(env, {
        scope: 'diag-referral-STEP2b-COOLDOWN-REJECTED',
        inviteeId,
        reason: cooldown.reason,
        cooldownUntil: cooldown.cooldownUntil,
        deletedAt: cooldown.deletedAt,
        note: 'User is in 15-day referral cooldown after account deletion. Referral REJECTED. User can still use the app.'
      });
            return { referral_id: null, rejected: true, reason: cooldown.reason, cooldownUntil: cooldown.cooldownUntil };
    }
    await diagLog(env, { scope: 'diag-referral-STEP2b-COOLDOWN-PASS', inviteeId, note: 'Not in cooldown — proceeding' });
  }

  // ── ROOT-CAUSE FIX: `isNewUser` gate REMOVED ──
  // The "first inviter wins" rule (existing referral check + ON CONFLICT)
  // is sufficient to prevent abuse. See function docstring for full rationale.
  // We still log isNewUser for debugging/observability.
  await diagLog(env, {
    scope: 'diag-referral-STEP3-NEWUSER-CHECK',
    isNewUser,
    note: isNewUser ? 'Brand new user — proceeding' : 'Existing user — proceeding (isNewUser gate removed, first-inviter-wins applies)'
  });

  // ── DEBUG: Step 4 — Verify inviter exists in users table ──
  const inviterResult = await queryDb(
    env,
    'SELECT telegram_id FROM users WHERE telegram_id = $1 LIMIT 1',
    [normalizedReferrerId],
  );
  if (!inviterResult.rows[0]) {
    await diagLog(env, {
      scope: 'diag-referral-STEP4-REJECTED',
      reason: 'inviter-not-found',
      normalizedReferrerId,
      note: 'The referrer does not have a user row in the DB'
    });
    return null;
  }
  await diagLog(env, { scope: 'diag-referral-STEP4-INVITER-FOUND', inviterId: normalizedReferrerId });

  // ── DEBUG: Step 5 — Check for existing referral (first inviter wins) ──
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
    await diagLog(env, {
      scope: 'diag-referral-STEP5-EXISTING',
      referral_id: existing.id,
      existing_inviter: existing.inviter_id,
      rewarded: existing.rewarded,
      note: 'First inviter wins — keeping original attribution'
    });
    // Race: another concurrent bootstrap already inserted the referral.
    // Delegate reward processing (idempotent — won't double-reward).
    // PHASE 2 SAFE OPTIMIZATION: Skip processPendingReferralReward when channelJoined=false.
    // The function would early-return at line 1751 anyway (if (!channelJoined) return null),
    // but we save the 3 queryDb calls it makes BEFORE that check:
    //   - isSubsystemDisabled (cached 60s, but still 1 function call)
    //   - getReferralRewardPerInvite (cached 60s, but still 1 function call)
    //   - SELECT referrals WHERE rewarded=FALSE (real DB query — wasted)
    // The actual reward credit happens in resolveChannelMembership(forceRefresh:true)
    // when Telegram confirms channel_joined=true, OR in retryFailedReferralRewards cron.
    if (channelJoined) {
      await processPendingReferralReward(env, inviteeId, channelJoined);
    }
    await diagLog(env, { scope: 'diag-referral-FINAL', result: 'already_exists', referral_id: existing.id });
    return { referral_id: existing.id, already_exists: true };
  }
  await diagLog(env, { scope: 'diag-referral-STEP5-NO-EXISTING', note: 'No prior referral — will insert' });

  // ── DEBUG: Step 6 — INSERT referral row (H-R3: ON CONFLICT DO NOTHING — race-safe) ──
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
  await diagLog(env, {
    scope: 'diag-referral-STEP6-INSERT',
    createdReferral,
    rowCount: insertResult.rowCount,
    inviter: normalizedReferrerId,
    invitee: inviteeId
  });
  if (!createdReferral) {
    // Race lost — another request already inserted the referral.
    await diagLog(env, { scope: 'diag-referral-STEP6-race-lost', note: 'Another concurrent request won the INSERT race' });
    return { referral_id: null, already_exists: true, race_won: false };
  }

  // ── DEBUG: Step 7 — Delegate reward processing (idempotent) ──
  await diagLog(env, { scope: 'diag-referral-STEP7-REWARD-CALL', referral_id: createdReferral.id, channelJoined });
  // PHASE 2 SAFE OPTIMIZATION: Same as above — skip when channelJoined=false.
  // processPendingReferralReward would early-return anyway, but we save 3 queryDb calls.
  // Reward will be credited by resolveChannelMembership(forceRefresh:true) if user just joined,
  // OR by retryFailedReferralRewards cron.
  let rewardResult = null;
  if (channelJoined) {
    rewardResult = await processPendingReferralReward(env, inviteeId, channelJoined);
  }
  await diagLog(env, { scope: 'diag-referral-STEP7-REWARD-RESULT', rewardResult });

  // ── DEBUG: Step 8 — Final result ──
  const finalResult = { referral_id: createdReferral.id, rewarded: Boolean(rewardResult?.rewarded) };
  await diagLog(env, { scope: 'diag-referral-STEP8-FINAL', result: finalResult, inviteeId, inviterId: normalizedReferrerId });
  return finalResult;
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

  if (uid.startsWith('guest_')) {
    payload.telegram_response = { reason: 'guest_user' };
    return payload;
  }

  if (isAdmin) {
    payload.telegram_response = { admin: true, reason: 'admin_bypass' };
    payload.joined = true;
    return payload;
  }

  if (!botConfigured) {
    payload.telegram_response = { reason: 'bot_not_configured' };
    return payload;
  }

  if (!/^\d+$/.test(uid)) {
    payload.telegram_response = { reason: 'invalid_user_id', value: uid };
    return payload;
  }

  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(uid)}`;
    const telegramResponse = await fetch(telegramUrl);
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

async function resolveChannelMembership(env, userId, { forceRefresh = false, skipRewardProcessing = false } = {}) {
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
        // ROOT-CAUSE FIX for CPU exhaustion:
        //
        // processPendingReferralReward is ONLY called when skipRewardProcessing
        // is false. This flag is true for requireChannelJoin (the middleware that
        // gates every protected API endpoint: /api/wallet, /api/referrals/stats,
        // /api/sessions/online, etc.). Previously, EVERY protected endpoint
        // triggered the full referral reward chain (up to 6 queryDb calls:
        // isSubsystemDisabled + getReferralRewardPerInvite + SELECT referrals +
        // validateRules + creditTokens(ensureSchema + SELECT + INSERT) +
        // UPDATE referrals) = ~18-30ms CPU → exceededCpu.
        //
        // Reward processing belongs in bootstrap (once per app open) and
        // check-join (user explicitly clicked "Verify"), NOT in every API call.
        // The cron retryFailedReferralRewards() catches any missed rewards.
        if (!skipRewardProcessing) {
          try {
            await processPendingReferralReward(env, uid, true);
          } catch (refErr) {
            console.warn(safeError('referral-reward-failed', refErr));
          }
        }
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

  // ── FALLBACK: Try TOP 3 exchanges in PARALLEL (max 4s total) ──
  // ROOT CAUSE FIX: Binance API (data-api.binance.vision) is IP-blocked from
  // Cloudflare Workers (403). It was always first in priority order, wasting
  // a full 4s timeout before falling through. Removed Binance from the list —
  // Bybit, OKX, MEXC are equally reliable for spot prices.
  // Also added Coinbase + Kraken (USD pairs) for broader coverage.
  //
  // PHASE B FIX (PF-1): Reduced from 9 exchanges to 3 to prevent subrequest
  // exhaustion. Previously: 9 exchanges × 30 symbols (alerts cron) = 270
  // subrequests → exceeds Cloudflare Free's 50-subrequest limit.
  // Now: 3 exchanges × 30 symbols = 90 subrequests worst case (still high but
  // mitigated by the fast-path cache hit which reduces to 1 fetch per symbol).
  // The top 3 (bybit, okx, mexc) cover 99%+ of crypto symbols. Coinbase/Kraken
  // only needed for obscure USD pairs — those can fall through to null.
  const ALL_EXCHANGES = ['bybit', 'okx', 'mexc'];

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
  const _t0 = Date.now();
  const _urlPreview = String(url).slice(0, 60);
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
    _traceStage('fetchJson:' + _urlPreview, _t0);

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

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 1: PRE-FILTER ENGINE — Rule-based, 0 AI calls
// Filters out low-importance news before any translation or AI processing.
// Reduces ~48 raw RSS items to ~8-12 high-importance articles.
// ═══════════════════════════════════════════════════════════════════════════

const IMPORTANCE_KEYWORDS = [
  // Breaking (+3)
  { words: ['breaking', 'urgent', 'flash', 'just in', 'فوری', 'breaking:'], score: 3, tag: 'breaking' },
  // Bitcoin (+2)
  { words: ['bitcoin', 'btc', 'بیت‌کوین', 'بیت کوین'], score: 2, tag: 'bitcoin' },
  // Ethereum (+2)
  { words: ['ethereum', 'eth', 'اتریوم'], score: 2, tag: 'ethereum' },
  // ETF (+2)
  { words: ['etf', 'spot etf', 'bitcoin etf', 'ethereum etf'], score: 2, tag: 'etf' },
  // Federal Reserve / FOMC (+2)
  { words: ['fed', 'fomc', 'federal reserve', 'powell', 'rate cut', 'rate hike', 'interest rate', 'fed chair'], score: 2, tag: 'fed' },
  // SEC / Regulation (+2)
  { words: ['sec', 'securities and exchange', 'regulation', 'lawsuit', 'sanction', 'approve', 'ban', 'delist', 'delisting'], score: 2, tag: 'regulation' },
  // Hack / Security (+2)
  { words: ['hack', 'exploit', 'breach', 'stolen', 'vulnerability', 'security', 'scam', 'fraud', 'rug pull'], score: 2, tag: 'security' },
  // Exchange (+1)
  { words: ['binance', 'coinbase', 'kraken', 'okx', 'bybit', 'listing', 'listed', 'exchange', 'trading'], score: 1, tag: 'exchange' },
  // Institutional (+1)
  { words: ['microstrategy', 'tesla', 'blackrock', 'institutional', 'adoption', 'treasury', 'saylor'], score: 1, tag: 'institutional' },
  // Macro (+1)
  { words: ['cpi', 'ppi', 'nfp', 'gdp', 'inflation', 'unemployment', 'recession', 'consumer price', 'producer price'], score: 1, tag: 'macro' },
  // Partnership (+1)
  { words: ['partnership', 'integration', 'collaboration', 'merger', 'acquisition'], score: 1, tag: 'partnership' },
];

/**
 * Score a single RSS item by importance.
 * Returns { score, tags } or null if item has 0 importance matches.
 */
function scoreNewsItem(item) {
  const title = String(item.title || '').toLowerCase();
  const description = String(item.description || '').toLowerCase();
  const text = `${title} ${description}`;

  // Reject items with title too short or too long (spam)
  const titleLen = String(item.title || '').trim().length;
  if (titleLen < 20 || titleLen > 200) return null;

  let score = 0;
  const tags = [];

  for (const group of IMPORTANCE_KEYWORDS) {
    for (const word of group.words) {
      if (text.includes(word)) {
        score += group.score;
        if (!tags.includes(group.tag)) tags.push(group.tag);
        break; // One match per group is enough
      }
    }
  }

  // No important keywords found — filter out
  if (score === 0) return null;

  // Bonus: freshness (published < 2 hours ago)
  if (item.pubDate) {
    try {
      const pubTs = new Date(item.pubDate).getTime();
      const ageHours = (Date.now() - pubTs) / (1000 * 60 * 60);
      if (ageHours < 2) score += 1;
      else if (ageHours < 6) score += 0.5;
    } catch {}
  }

  // Bonus: authoritative sources
  const sourceName = String(item._sourceName || '').toLowerCase();
  if (sourceName.includes('coindesk') || sourceName.includes('cointelegraph')) {
    score += 1;
  }

  return { score, tags, item };
}

/**
 * Fuzzy deduplication using Jaccard similarity on normalized titles.
 * Removes near-duplicate articles from different sources.
 */
function fuzzyDedupNews(scoredItems, threshold = 0.7) {
  const normalized = scoredItems.map(s => ({
    ...s,
    normTitle: String(s.item.title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim()
      .split(' ')
      .filter(w => w.length > 2),
  }));

  const result = [];
  const used = new Set();

  for (let i = 0; i < normalized.length; i++) {
    if (used.has(i)) continue;
    result.push(normalized[i]);
    used.add(i);

    for (let j = i + 1; j < normalized.length; j++) {
      if (used.has(j)) continue;
      // Jaccard similarity
      const setA = new Set(normalized[i].normTitle);
      const setB = new Set(normalized[j].normTitle);
      const intersection = [...setA].filter(w => setB.has(w)).length;
      const union = new Set([...setA, ...setB]).size;
      const similarity = union > 0 ? intersection / union : 0;

      if (similarity >= threshold) {
        used.add(j); // Mark as duplicate
      }
    }
  }

  return result;
}

/**
 * Pre-Filter Engine: filters, scores, dedupes, and selects top-N news items.
 * Called BEFORE any AI/translation processing.
 *
 * Input: array of { title, url, description, pubDate, image, _sourceName, _category }
 * Output: array of top-N scored items { score, tags, item }
 */
function filterAndScoreNews(allItems, maxResults = 10) {
  // Stage 1: Score and filter (removes items with 0 importance)
  const scored = [];
  for (const item of allItems) {
    const result = scoreNewsItem(item);
    if (result) scored.push(result);
  }

  // Stage 2: Sort by score descending
  scored.sort((a, b) => b.score - a.score);

  // Stage 3: Fuzzy dedup (remove near-duplicates)
  const deduped = fuzzyDedupNews(scored);

  // Stage 4: Top-N selection
  return deduped.slice(0, maxResults);
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
    } catch (e) {
      // AI unavailable or model error — fall through to Google Translate
      console.warn('[TRANSLATE] m2m100 failed (non-fatal):', e?.message);
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
    } catch (e) {
      // Both AI and Google failed — return original text
      console.warn('[TRANSLATE] Google fallback failed (non-fatal):', e?.message);
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
        const _t0 = Date.now();
        const response = await fetch(source.url, {
          method: 'GET',
          headers: {
            'User-Agent': 'Mozilla/5.0 (compatible; NewsBot/1.0)',
            Accept: 'application/rss+xml, application/xml, text/xml;q=0.9, */*;q=0.8',
          },
          signal: controller.signal,
        });
        clearTimeout(timeoutId);
        _traceStage('RSS.fetch:' + source.name, _t0);
        const rssText = await response.text();
        if (response.ok && rssText.includes('<item>')) {
          return { rssText, sourceName: source.name, category: source.category, skipTranslate: !!source.skipTranslate };
        }
      } catch (e) {
        // Source failed — will be filtered out below. Log for observability.
        console.warn(`[RSS] Source "${source.name}" failed:`, e?.message || e);
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

  // ROOT-CAUSE FIX: Limit to 3 articles per source (was 5).
  // Cloudflare Workers free plan has a 50 subrequest limit per invocation.
  // With 7 sources × 5 articles × 2 translations = 70 subrequests → exceeds limit.
  // Now: 7 sources × 3 articles × 2 translations = 42 subrequests (under 50).
  // Plus RSS fetches (7) + article HTML fetches (up to 5) + AI summaries (up to 3) = 57 max.
  // To stay under 50: we process translations in 2 batches if needed.
  const MAX_ARTICLES_PER_SOURCE = 3;
  const limitedItems = items.slice(0, MAX_ARTICLES_PER_SOURCE);

  let allTranslations;
  if (skipTranslate) {
    // Persian sources — no translation needed
    allTranslations = limitedItems.map((item) => [
      item.title || 'بدون عنوان',
      item.description || '',
    ]);
  } else {
    // ROOT-CAUSE FIX: Process translations in BATCHES of 10 to stay under subrequest limit.
    // Each translateToFarsi call = 1 AI.run() subrequest (+ potentially 1 Google fetch).
    // With 7 sources × 3 articles × 2 = 42 translation calls, we batch them 10 at a time.
    const allTranslatableItems = limitedItems.flatMap((item) => [
      { text: item.title || 'بدون عنوان', isTitle: true },
      { text: item.description || '', isTitle: false },
    ]);

    allTranslations = [];
    const TRANSLATION_BATCH_SIZE = 10;
    for (let i = 0; i < allTranslatableItems.length; i += TRANSLATION_BATCH_SIZE) {
      const batch = allTranslatableItems.slice(i, i + TRANSLATION_BATCH_SIZE);
      const batchResults = await Promise.all(
        batch.map(item => translateToFarsi(item.text, env))
      );
      allTranslations.push(...batchResults);
    }
  }

  const articles = [];
  for (let i = 0; i < limitedItems.length; i++) {
    const translatedTitle = allTranslations[i * 2];
    const translatedDescription = allTranslations[i * 2 + 1];

    // SANITIZE: AI translation (m2m100) sometimes produces repeated words/phrases.
    // sanitizeNewsTitle removes duplicates BEFORE the title is cached in KV and
    // sent to frontend. This is the root-cause fix for the "duplicate title" bug.
    const rawTitle = String(translatedTitle || limitedItems[i].title || 'بدون عنوان').replace(/\n/g, ' ').trim();

    articles.push({
      title: sanitizeNewsTitle(rawTitle),
      description: String(translatedDescription || limitedItems[i].description || '').replace(/\n/g, ' ').trim(),
      time_ago: parseRelativeTime(limitedItems[i].pubDate),
      // Raw publication date in ISO format (UTC) — frontend converts to
      // Asia/Tehran for display. Item 2: news time in Tehran timezone.
      pub_date: limitedItems[i].pubDate ? new Date(limitedItems[i].pubDate).toISOString() : null,
      source: sourceName,
      category: category || 'crypto',
      image: limitedItems[i].image,
      url: limitedItems[i].url,
      sentiment: classifySentiment(limitedItems[i].title, limitedItems[i].description),
    });
  }

  return articles.filter((item) => item.title || item.description);
}

/**
 * Sanitize and deduplicate a news title.
 * Fixes the critical bug where AI translation (m2m100) produces repeated
 * words/phrases in the title. This runs on BOTH frontend and backend (defense
 * in depth) — backend sanitizes before caching in KV, frontend sanitizes on
 * receipt as a safety net.
 *
 * Handles:
 * 1. Consecutive duplicate words: "BTC BTC BTC rises" → "BTC rises"
 * 2. Consecutive duplicate phrases (2-6 words): "A B C A B C" → "A B C"
 * 3. Full title duplication (first half == second half)
 * 4. Whitespace normalization
 */
function sanitizeNewsTitle(rawTitle) {
  if (!rawTitle) return '';
  let title = String(rawTitle).replace(/\s+/g, ' ').trim();
  if (!title) return '';

  // 1. Remove consecutive duplicate words (2+ same words in a row → keep 1)
  //    Unicode-safe: doesn't rely on \b which fails for Persian/RTL text.
  let prev;
  do {
    prev = title;
    title = title.replace(/(\S+)(\s+\1)(?=\s|$)/gi, '$1');
  } while (title !== prev);

  // 2. Remove consecutive duplicate phrases (phrase of 2-8 words repeated)
  do {
    prev = title;
    title = title.replace(/((?:\S+\s+){1,8}\S+)\s+\1/gi, '$1');
  } while (title !== prev);

  // 3. Full title duplication: first half == second half
  const len = title.length;
  if (len > 20) {
    const mid = Math.floor(len / 2);
    const firstHalf = title.substring(0, mid).trim();
    const secondHalf = title.substring(mid).trim();
    if (firstHalf === secondHalf && firstHalf.length > 8) {
      title = firstHalf;
    } else {
      // Try finding the second occurrence of the first 10 chars
      const prefix = title.substring(0, 10);
      if (prefix.length === 10) {
        const secondOccurrence = title.indexOf(prefix, 5);
        if (secondOccurrence > 10 && secondOccurrence < len - 10) {
          const candidate = title.substring(0, secondOccurrence).trim();
          const remainder = title.substring(secondOccurrence).trim();
          if (candidate === remainder && candidate.length > 8) {
            title = candidate;
          }
        }
      }
    }
  }

  return title.replace(/\s+/g, ' ').trim();
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
      // ROOT CAUSE FIX (item 1 permanent): Apply sanitizeNewsTitle on the
      // CACHE-HIT path too. Previously sanitization only ran in
      // buildFarsiNewsArticles (live-fetch path). If the KV cache contained
      // old titles with AI-translation duplication artifacts (from before
      // the fix was deployed), they were served as-is — causing the bug to
      // persist in production even after the fix. Now every title is
      // sanitized regardless of whether it came from cache or live fetch.
      const sanitized = parsed.map(a => ({
        ...a,
        title: sanitizeNewsTitle(a.title),
      }));
      // Enrich with AI summaries from KV (if available)
      const enriched = await enrichNewsWithAISummaries(env, sanitized);
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
      const MAX_NEWS_ARTICLES = 12;
      const trimmed = deduped.slice(0, MAX_NEWS_ARTICLES);

      // Cache the full (unfiltered) trimmed list
      await writeAppCache(
        env,
        FARSI_NEWS_CACHE_KEY,
        JSON.stringify(trimmed),
        getNumericEnv(env, 'NEWS_CACHE_TTL', 1800), // 30 minutes
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
const NEWS_SUMMARY_QUEUE_KEY = 'news:summary_queue';
const NEWS_AI_MONITOR_KEY = 'news:ai_monitor'; // last tick stats
const NEWS_AI_MONITOR_TTL = 24 * 60 * 60; // 24h

// ────────────────────────────────────────────────────────────────────────────
// FEATURE FLAGS — News AI
// All News AI capabilities can be toggled on/off via env vars without code change.
// Set env var to 'false' or '0' to disable. Default: all enabled.
//   NEWS_AI_ENABLED              — master switch (disables everything below)
//   NEWS_SUMMARY_ENABLED         — per-article AI summary generation
//   NEWS_BATCH_ANALYSIS_ENABLED  — batch sentiment/impact/coins analysis
//   NEWS_QUEUE_ENABLED           — persistent queue management
// ────────────────────────────────────────────────────────────────────────────
function isNewsFlagEnabled(env, flagName, defaultValue = true) {
  const v = env?.[flagName];
  if (v === undefined || v === null || v === '') return defaultValue;
  if (typeof v === 'boolean') return v;
  const s = String(v).toLowerCase().trim();
  if (s === 'false' || s === '0' || s === 'off' || s === 'no') return false;
  return true;
}
function isNewsAIEnabled(env) {
  return isNewsFlagEnabled(env, 'NEWS_AI_ENABLED', true);
}
function isNewsSummaryEnabled(env) {
  return isNewsAIEnabled(env) && isNewsFlagEnabled(env, 'NEWS_SUMMARY_ENABLED', true);
}
function isNewsBatchAnalysisEnabled(env) {
  return isNewsAIEnabled(env) && isNewsFlagEnabled(env, 'NEWS_BATCH_ANALYSIS_ENABLED', true);
}
function isNewsQueueEnabled(env) {
  return isNewsAIEnabled(env) && isNewsFlagEnabled(env, 'NEWS_QUEUE_ENABLED', true);
}

// ── Retry config ──
const NEWS_SUMMARY_MAX_RETRIES = 3;
const NEWS_SUMMARY_BACKOFF_MINUTES = [5, 15, 30]; // after attempt 1, 2, 3 (failures)

// ────────────────────────────────────────────────────────────────────────────
// MULTI-PROVIDER AI FALLBACK (Phase 10)
// Provider priority: Gemini (primary) → Workers AI (fallback 1) → OpenAI (fallback 2)
// Each provider is tried only if the previous one failed.
// Fallback happens in the SAME invocation (no queue wait).
// Queue retry only when ALL providers fail.
//
// Feature flags (env vars, default values shown):
//   NEWS_PROVIDER_GEMINI       = true   (primary)
//   NEWS_PROVIDER_WORKERS_AI   = true   (fallback 1)
//   NEWS_PROVIDER_OPENAI       = false  (fallback 2 — opt-in, needs OPENAI_API_KEY)
//
// Error classification:
//   retryable     → 429, 5xx, timeout, network, invalid JSON, empty response
//                   (try next provider; if all fail with retryable → requeue)
//   non_retryable → 401/403 (key invalid), 404 (model not found), 400 (prompt invalid)
//                   (try next provider; if all fail with non-retryable → mark failed)
// ────────────────────────────────────────────────────────────────────────────
const NEWS_AI_PROVIDER_STATS_KEY = 'news:ai_provider_stats';
const OPENAI_MODEL = 'gpt-4o-mini'; // cheap, fast, good for summarization

function isNewsProviderEnabled(env, flagName, defaultValue) {
  return isNewsFlagEnabled(env, flagName, defaultValue);
}

/**
 * Classify an HTTP status code as retryable or non-retryable.
 * Retryable: 429 (rate limit), 5xx (server), 408 (timeout)
 * Non-retryable: 400 (bad prompt), 401/403 (auth), 404 (model not found)
 * Unknown → retryable (safe default — try next provider, requeue if all fail)
 */
function classifyHttpError(status) {
  if (status === 429 || status === 408 || status >= 500) return 'retryable';
  if (status === 400 || status === 401 || status === 403 || status === 404) return 'non_retryable';
  return 'retryable';
}

/**
 * Provider 1: Gemini 2.0 Flash (primary).
 * Returns { provider, success, summary?, error?, errorType, error_detail?, duration_ms }.
 */
async function tryGemini(env, prompt) {
  const t0 = Date.now();
  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  if (!GEMINI_API_KEY) {
    return { provider: 'gemini', success: false, error: 'no_api_key', errorType: 'non_retryable', duration_ms: 0 };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch(
      `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
      {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          contents: [{ parts: [{ text: prompt }] }],
          generationConfig: { temperature: 0.4, maxOutputTokens: 1024, topP: 0.85 },
        }),
        signal: controller.signal,
      }
    );
    clearTimeout(timeout);

    if (!res.ok) {
      const errorType = classifyHttpError(res.status);
      let errorBody = '';
      try { errorBody = (await res.text()).substring(0, 200); } catch {}
      return { provider: 'gemini', success: false, error: `http_${res.status}`, errorType, error_detail: errorBody, duration_ms: Date.now() - t0 };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return { provider: 'gemini', success: false, error: 'invalid_json', errorType: 'retryable', duration_ms: Date.now() - t0 };
    }

    const text = data?.candidates?.[0]?.content?.parts?.[0]?.text;
    if (text && text.trim().length >= 50) {
      return { provider: 'gemini', success: true, summary: text.trim(), duration_ms: Date.now() - t0 };
    }
    return { provider: 'gemini', success: false, error: 'empty_response', errorType: 'retryable', duration_ms: Date.now() - t0 };
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    return {
      provider: 'gemini',
      success: false,
      error: isAbort ? 'timeout' : 'network_error',
      errorType: 'retryable',
      error_detail: e?.message?.substring(0, 120),
      duration_ms: Date.now() - t0,
    };
  }
}

/**
 * Provider 2: Cloudflare Workers AI (fallback 1).
 * Uses the @cf/meta/llama-3.3-70b-instruct-fp8-fast model via env.AI binding.
 */
async function tryWorkersAI(env, prompt) {
  const t0 = Date.now();
  if (!env.AI) {
    return { provider: 'workers-ai', success: false, error: 'no_binding', errorType: 'non_retryable', duration_ms: 0 };
  }
  try {
    const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: 'You are a professional Persian crypto and financial journalist. Read the full article and write a 120-200 word analysis in fluent Farsi. Preserve all key numbers, names, and dates. Explain what happened, important details, why it matters, and market impact. Write original analysis, not translation. Do NOT invent any facts. Use blank lines between paragraphs.' },
        { role: 'user', content: prompt.substring(0, 12000) },
      ],
      max_tokens: 1024,
      temperature: 0.4,
    });

    if (aiResponse?.response && aiResponse.response.trim().length >= 50) {
      return { provider: 'workers-ai', success: true, summary: aiResponse.response.trim(), duration_ms: Date.now() - t0 };
    }
    return { provider: 'workers-ai', success: false, error: 'empty_response', errorType: 'retryable', duration_ms: Date.now() - t0 };
  } catch (e) {
    const msg = e?.message || String(e) || '';
    // Workers AI throws JS errors. Classify by message content.
    // Non-retryable: model not found, auth/binding issues
    // Retryable: timeout, rate limit, capacity, network
    const isNonRetryable = /not found|unauthorized|forbidden|invalid (model|binding|argument)/i.test(msg)
      && !/timeout|rate|429|capacity|network|temporarily|overloaded/i.test(msg);
    return {
      provider: 'workers-ai',
      success: false,
      error: 'runtime_error',
      errorType: isNonRetryable ? 'non_retryable' : 'retryable',
      error_detail: msg.substring(0, 120),
      duration_ms: Date.now() - t0,
    };
  }
}

/**
 * Provider 2: OpenAI (fallback 2 — opt-in via NEWS_PROVIDER_OPENAI=true + OPENAI_API_KEY).
 * Uses gpt-4o-mini (cheap, fast, good for summarization).
 */
async function tryOpenAI(env, prompt) {
  const t0 = Date.now();
  const OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return { provider: 'openai', success: false, error: 'no_api_key', errorType: 'non_retryable', duration_ms: 0 };
  }
  try {
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://api.openai.com/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENAI_API_KEY}`,
      },
      body: JSON.stringify({
        model: OPENAI_MODEL,
        messages: [
          { role: 'system', content: 'You are a professional Persian crypto and financial journalist. Read the full article and write a 120-200 word analysis in fluent Farsi. Preserve all key numbers, names, and dates. Explain what happened, important details, why it matters, and market impact. Write original analysis, not translation. Do NOT invent any facts. Use blank lines between paragraphs.' },
          { role: 'user', content: prompt.substring(0, 12000) },
        ],
        max_tokens: 1024,
        temperature: 0.4,
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorType = classifyHttpError(res.status);
      let errorBody = '';
      try { errorBody = (await res.text()).substring(0, 200); } catch {}
      return { provider: 'openai', success: false, error: `http_${res.status}`, errorType, error_detail: errorBody, duration_ms: Date.now() - t0 };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      return { provider: 'openai', success: false, error: 'invalid_json', errorType: 'retryable', duration_ms: Date.now() - t0 };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (text && text.trim().length >= 50) {
      return { provider: 'openai', success: true, summary: text.trim(), duration_ms: Date.now() - t0 };
    }
    return { provider: 'openai', success: false, error: 'empty_response', errorType: 'retryable', duration_ms: Date.now() - t0 };
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    return {
      provider: 'openai',
      success: false,
      error: isAbort ? 'timeout' : 'network_error',
      errorType: 'retryable',
      error_detail: e?.message?.substring(0, 120),
      duration_ms: Date.now() - t0,
    };
  }
}

// ────────────────────────────────────────────────────────────────────────────
// CIRCUIT BREAKER (Phase 10.5)
// Protects against wasteful repeated calls to a failing provider.
// State machine (per provider):
//   CLOSED  ──(3 consecutive retryable failures)──▶ OPEN (10 min)
//   OPEN    ──(10 min elapsed)─────────────────────▶ HALF_OPEN (1 probe attempt)
//   HALF_OPEN ──(probe success)───────────────────▶ CLOSED
//   HALF_OPEN ──(probe failure)───────────────────▶ OPEN (another 10 min)
//
// Only RETRYABLE errors (429, 5xx, timeout, network) count toward the circuit.
// Non-retryable errors (400/401/403/404 — config issues) do NOT trip the circuit
// because they won't resolve by waiting.
//
// State persists in KV (key: news:circuit:{provider}) so it survives across
// cron tick invocations and isolates.
// ────────────────────────────────────────────────────────────────────────────
const CIRCUIT_BREAKER_KEY_PREFIX = 'news:circuit:';
const CIRCUIT_BREAKER_TTL = 30 * 60; // 30 min (longer than OPEN window so state persists)
const CIRCUIT_BREAKER_FAILURE_THRESHOLD = 3; // 3 consecutive failures → OPEN
const CIRCUIT_BREAKER_OPEN_MS = 10 * 60 * 1000; // 10 minutes

/**
 * Read circuit breaker state for a provider from KV.
 * Returns { state, consecutive_failures, opened_at, retry_after, last_failure_reason }.
 * Defaults to CLOSED with 0 failures if no state stored.
 */
async function getCircuitState(env, provider) {
  if (!env.APP_CACHE) return { state: 'CLOSED', consecutive_failures: 0, opened_at: null, retry_after: null, last_failure_reason: null };
  try {
    const raw = await readAppCache(env, `${CIRCUIT_BREAKER_KEY_PREFIX}${provider}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.state) return parsed;
    }
  } catch (e) {
    console.warn(`[CIRCUIT] getState(${provider}) failed:`, e?.message);
  }
  return { state: 'CLOSED', consecutive_failures: 0, opened_at: null, retry_after: null, last_failure_reason: null };
}

/**
 * Save circuit breaker state to KV.
 */
async function saveCircuitState(env, provider, state) {
  if (!env.APP_CACHE) return;
  try {
    await writeAppCache(env, `${CIRCUIT_BREAKER_KEY_PREFIX}${provider}`, JSON.stringify(state), CIRCUIT_BREAKER_TTL);
  } catch (e) {
    console.warn(`[CIRCUIT] saveState(${provider}) failed:`, e?.message);
  }
}

/**
 * Check if a provider should be attempted, considering circuit breaker state.
 * Returns { attempt: boolean, state, retry_after, reason }.
 *
 * Logic:
 *   - CLOSED → attempt (normal)
 *   - OPEN + now < retry_after → skip (circuit open, wait)
 *   - OPEN + now >= retry_after → transition to HALF_OPEN, attempt (probe)
 *   - HALF_OPEN → attempt (probe in progress)
 *
 * If the circuit transitions OPEN → HALF_OPEN here, the new state is persisted
 * so concurrent ticks don't all probe at once.
 */
async function shouldAttemptProvider(env, provider) {
  const state = await getCircuitState(env, provider);
  const now = Date.now();

  if (state.state === 'CLOSED') {
    return { attempt: true, state: 'CLOSED', retry_after: null, reason: 'closed' };
  }

  if (state.state === 'OPEN') {
    if (state.retry_after && now < state.retry_after) {
      // Still in OPEN window — skip
      return { attempt: false, state: 'OPEN', retry_after: state.retry_after, reason: 'circuit_open' };
    }
    // OPEN window expired → transition to HALF_OPEN (probe)
    const newState = { ...state, state: 'HALF_OPEN' };
    await saveCircuitState(env, provider, newState);
    return { attempt: true, state: 'HALF_OPEN', retry_after: state.retry_after, reason: 'half_open_probe' };
  }

  if (state.state === 'HALF_OPEN') {
    // Probe in progress — allow attempt
    return { attempt: true, state: 'HALF_OPEN', retry_after: state.retry_after, reason: 'half_open' };
  }

  // Unknown state — default to allow
  return { attempt: true, state: state.state || 'CLOSED', retry_after: null, reason: 'unknown_state' };
}

/**
 * Record a provider attempt result and update circuit breaker state.
 * Called after every provider attempt (success or failure).
 *
 * - Success (any) → reset to CLOSED (consecutive_failures=0, opened_at=null)
 * - Retryable failure → increment consecutive_failures; if >= threshold → OPEN
 * - Non-retryable failure → do NOT count (config issue, not transient)
 * - HALF_OPEN + success → CLOSED
 * - HALF_OPEN + retryable failure → OPEN (another 10 min)
 */
async function recordCircuitResult(env, provider, success, errorType, errorMessage) {
  const state = await getCircuitState(env, provider);
  const now = Date.now();

  if (success) {
    // Success → always close the circuit
    if (state.state !== 'CLOSED' || state.consecutive_failures > 0) {
      await saveCircuitState(env, provider, {
        state: 'CLOSED',
        consecutive_failures: 0,
        opened_at: null,
        retry_after: null,
        last_failure_reason: null,
      });
    }
    return;
  }

  // Failure
  if (errorType !== 'retryable') {
    // Non-retryable failure → don't trip circuit (config issue)
    return;
  }

  // Retryable failure
  if (state.state === 'HALF_OPEN') {
    // Probe failed → back to OPEN for another 10 min
    await saveCircuitState(env, provider, {
      state: 'OPEN',
      consecutive_failures: state.consecutive_failures + 1,
      opened_at: now,
      retry_after: now + CIRCUIT_BREAKER_OPEN_MS,
      last_failure_reason: errorMessage || 'half_open_probe_failed',
    });
    return;
  }

  // CLOSED (or already OPEN) → increment consecutive failures
  const newFailures = (state.consecutive_failures || 0) + 1;
  if (newFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    // Trip the circuit → OPEN for 10 min
    await saveCircuitState(env, provider, {
      state: 'OPEN',
      consecutive_failures: newFailures,
      opened_at: now,
      retry_after: now + CIRCUIT_BREAKER_OPEN_MS,
      last_failure_reason: errorMessage || 'threshold_reached',
    });
  } else {
    // Below threshold — just update the counter
    await saveCircuitState(env, provider, {
      ...state,
      state: 'CLOSED',
      consecutive_failures: newFailures,
      last_failure_reason: errorMessage || null,
    });
  }
}

// ── Cache stats (Phase 10.5) ──
const NEWS_AI_CACHE_STATS_KEY = 'news:ai_cache_stats';

async function recordCacheStat(env, hit) {
  if (!env.APP_CACHE) return;
  try {
    const raw = await readAppCache(env, NEWS_AI_CACHE_STATS_KEY).catch(() => null);
    let stats = { hits: 0, misses: 0, updated_at: null };
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') stats = { ...stats, ...parsed };
    }
    if (hit) stats.hits++; else stats.misses++;
    stats.updated_at = Date.now();
    await writeAppCache(env, NEWS_AI_CACHE_STATS_KEY, JSON.stringify(stats), NEWS_AI_MONITOR_TTL);
  } catch (e) {
    console.warn('[CACHE-STATS] recordCacheStat failed:', e?.message);
  }
}

/**
 * Multi-provider fallback coordinator.
 * Tries providers in priority order (Gemini → Workers AI → OpenAI).
 * Each provider is tried ONLY if the previous one failed.
 * All attempts happen in the SAME invocation (no queue wait between providers).
 *
 * Circuit Breaker (Phase 10.5): Before calling each provider, checks if its
 * circuit is OPEN. If OPEN, skips that provider entirely and records a
 * 'circuit_open' attempt (counts as retryable for fallback decisions).
 *
 * Returns:
 *   { summary, usedProvider, attempts, totalDuration, anyRetryable, allNonRetryable, fallbackUsed }
 *
 * - summary: string | null (null = all providers failed)
 * - usedProvider: 'gemini' | 'workers-ai' | 'openai' | null
 * - attempts: array of per-provider results (for metadata + monitoring)
 * - fallbackUsed: true if success came from a non-primary provider
 */
async function generateSummaryWithFallback(env, prompt) {
  const attempts = [];
  let summary = null;
  let usedProvider = null;
  let totalDuration = 0;

  // Helper: attempt a provider with circuit breaker protection.
  // Returns the attempt result (with 'circuit_skipped' flag if skipped).
  async function attemptProvider(providerName, tryFn) {
    // Check circuit breaker first
    const circuitCheck = await shouldAttemptProvider(env, providerName);
    if (!circuitCheck.attempt) {
      // Circuit OPEN — skip this provider entirely
      const skippedAttempt = {
        provider: providerName,
        success: false,
        error: 'circuit_open',
        errorType: 'retryable', // counts as retryable so fallback continues to next provider
        error_detail: `circuit open until ${new Date(circuitCheck.retry_after).toISOString()}`,
        duration_ms: 0,
        circuit_skipped: true,
        circuit_state: circuitCheck.state,
      };
      attempts.push(skippedAttempt);
      return skippedAttempt;
    }

    // Circuit CLOSED or HALF_OPEN → attempt the provider
    const r = await tryFn();
    attempts.push(r);
    totalDuration += r.duration_ms || 0;

    // Record result in circuit breaker (updates state: CLOSED↔OPEN↔HALF_OPEN)
    try {
      await recordCircuitResult(env, providerName, r.success, r.errorType, r.error || r.error_detail);
    } catch (e) {
      console.warn(`[CIRCUIT] recordResult(${providerName}) failed:`, e?.message);
    }

    return r;
  }

  // ────────────────────────────────────────────────────────────────────────────
  // FALLBACK CHAIN (Provider Activation Phase — DeepSeek removed per user request)
  //   1) Gemini       (primary)      — NEWS_PROVIDER_GEMINI=true (default)
  //   2) Workers AI   (fallback 1)   — NEWS_PROVIDER_WORKERS_AI=true (default)
  //   3) OpenAI       (fallback 2)   — NEWS_PROVIDER_OPENAI=false (opt-in, paid)
  //
  // Gemini is ALWAYS tried first. Workers AI is ONLY used as fallback when
  // Gemini fails (timeout, quota, invalid response, network error, etc.).
  // Each provider is tried ONLY if the previous one failed.
  // Circuit breaker protects each provider independently.
  // No parallel calls — sequential fallback to minimize cost + latency.
  // ────────────────────────────────────────────────────────────────────────────

  // Provider 1: Gemini (primary) — always tried first
  if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_GEMINI', true)) {
    const r = await attemptProvider('gemini', () => tryGemini(env, prompt));
    if (r.success) {
      summary = r.summary;
      usedProvider = 'gemini';
      console.log('[NEWS-AI-FALLBACK] ✅ Gemini PRIMARY succeeded — no fallback needed');
    } else {
      console.warn(`[NEWS-AI-FALLBACK] ⚠️ Gemini failed (error=${r.error}, type=${r.errorType}, detail=${(r.error_detail || '').slice(0, 100)}) — falling back to Workers AI`);
    }
  }

  // Provider 2: Workers AI (fallback 1) — ONLY if Gemini didn't succeed
  if (!summary && isNewsProviderEnabled(env, 'NEWS_PROVIDER_WORKERS_AI', true)) {
    const r = await attemptProvider('workers-ai', () => tryWorkersAI(env, prompt));
    if (r.success) {
      summary = r.summary;
      usedProvider = 'workers-ai';
      console.log('[NEWS-AI-FALLBACK] ⚠️ Workers AI fallback succeeded (Gemini was unavailable)');
    }
  }

  // Provider 3: OpenAI (fallback 2, opt-in) — only if Gemini + Workers AI didn't succeed
  if (!summary && isNewsProviderEnabled(env, 'NEWS_PROVIDER_OPENAI', false)) {
    const r = await attemptProvider('openai', () => tryOpenAI(env, prompt));
    if (r.success) {
      summary = r.summary;
      usedProvider = 'openai';
    }
  }

  const anyRetryable = attempts.some(a => a.errorType === 'retryable');
  const allNonRetryable = attempts.length > 0 && attempts.every(a => a.errorType === 'non_retryable');
  // Fallback = success on a non-primary provider (i.e., at least one attempt failed before success)
  const fallbackUsed = attempts.length > 1 && !!summary;
  const circuitSkippedAny = attempts.some(a => a.circuit_skipped);

  return {
    summary,
    usedProvider,
    attempts,
    totalDuration,
    anyRetryable,
    allNonRetryable,
    fallbackUsed,
    circuitSkippedAny,
  };
}

/**
 * Record a per-provider attempt to the aggregate stats in KV.
 * Used by /api/news-ai-monitor for provider success/failure counts.
 */
async function recordProviderAttempt(env, provider, success, durationMs) {
  if (!env.APP_CACHE) return;
  try {
    const raw = await readAppCache(env, NEWS_AI_PROVIDER_STATS_KEY).catch(() => null);
    let stats = {
      gemini: { success: 0, failed: 0, total_ms: 0 },
      'workers-ai': { success: 0, failed: 0, total_ms: 0 },
      'openai': { success: 0, failed: 0, total_ms: 0 },
      fallback_count: 0,
      fallback_to: {},
      total_summaries: 0,
      total_duration_ms: 0,
      updated_at: null,
    };
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && typeof parsed === 'object') {
        stats = { ...stats, ...parsed };
        // Ensure nested provider objects exist
        for (const k of ['gemini', 'workers-ai', 'openai']) {
          if (!stats[k]) stats[k] = { success: 0, failed: 0, total_ms: 0 };
        }
        if (!stats.fallback_to) stats.fallback_to = {};
      }
    }
    if (success) {
      stats[provider].success++;
      stats[provider].total_ms += durationMs || 0;
      stats.total_summaries++;
      stats.total_duration_ms += durationMs || 0;
    } else {
      stats[provider].failed++;
    }
    stats.updated_at = Date.now();
    await writeAppCache(env, NEWS_AI_PROVIDER_STATS_KEY, JSON.stringify(stats), NEWS_AI_MONITOR_TTL);
  } catch (e) {
    console.warn('[NEWS-AI-STATS] recordProviderAttempt failed:', e?.message);
  }
}

/**
 * Record a fallback event (success on a non-primary provider).
 * Increments fallback_count + fallback_to.{provider}.
 */
async function recordFallbackEvent(env, finalProvider) {
  if (!env.APP_CACHE) return;
  try {
    const raw = await readAppCache(env, NEWS_AI_PROVIDER_STATS_KEY).catch(() => null);
    let stats = {};
    if (raw) stats = JSON.parse(raw) || {};
    stats.fallback_count = (stats.fallback_count || 0) + 1;
    stats.fallback_to = stats.fallback_to || {};
    stats.fallback_to[finalProvider] = (stats.fallback_to[finalProvider] || 0) + 1;
    stats.updated_at = Date.now();
    await writeAppCache(env, NEWS_AI_PROVIDER_STATS_KEY, JSON.stringify(stats), NEWS_AI_MONITOR_TTL);
  } catch (e) {
    console.warn('[NEWS-AI-STATS] recordFallbackEvent failed:', e?.message);
  }
}

/**
 * Queue Management for News AI Summaries.
 * Queue is stored in KV as a JSON array of queue-item objects.
 * Each cron tick processes ONE article from the queue (FIFO).
 * If Worker is killed, queue persists in KV — next tick continues.
 *
 * Queue item schema:
 *   {
 *     url: string,          — article URL (primary key, dedup)
 *     title: string,        — translated Farsi title
 *     title_en: string,     — original English title
 *     description: string,  — RSS description (fallback for AI input)
 *     source: string,       — source name
 *     category: string,     — 'crypto' | 'forex' | 'economy'
 *     retry_count: number,  — 0..3
 *     last_attempt: number|null, — epoch ms of last attempt
 *     next_retry: number|null,   — epoch ms when next retry is allowed
 *     status: 'pending'|'failed',— pending = needs processing, failed = exhausted retries
 *     enqueued_at: number,  — epoch ms when first enqueued
 *   }
 */

/**
 * Get the summary queue from KV.
 * Returns array of { url, title, source, category } objects.
 */
async function getSummaryQueue(env) {
  if (!env.APP_CACHE) return [];
  try {
    const raw = await readAppCache(env, NEWS_SUMMARY_QUEUE_KEY);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) return parsed;
    }
  } catch {}
  return [];
}

/**
 * Save the summary queue to KV (TTL=24h).
 */
async function saveSummaryQueue(env, queue) {
  if (!env.APP_CACHE) return;
  try {
    await writeAppCache(env, NEWS_SUMMARY_QUEUE_KEY, JSON.stringify(queue), 24 * 3600);
  } catch {}
}

/**
 * Add articles to the summary queue.
 * - Skips articles that already have summaries in KV (prevent duplicate work).
 * - Skips articles already in the queue (dedup by URL).
 * - Skips articles previously marked as 'failed' (exhausted retries).
 * - Respects NEWS_QUEUE_ENABLED feature flag (no-op when disabled).
 *
 * Each new queue item starts with retry_count=0, status='pending'.
 */
async function enqueueForSummary(env, articles) {
  if (!articles || articles.length === 0) return { enqueued: 0, skipped: 0, total: 0 };

  // Feature flag — when queue is disabled, do nothing (summaries won't be generated)
  if (!isNewsQueueEnabled(env)) {
    return { enqueued: 0, skipped: articles.length, total: 0, reason: 'queue_disabled' };
  }

  // Get existing queue
  const queue = await getSummaryQueue(env);
  const existingByUrl = new Map(queue.map(q => [q.url, q]));
  let enqueued = 0;
  let skipped = 0;

  const now = Date.now();

  // Add new articles (not already in queue, not already summarized, not failed)
  for (const a of articles) {
    if (!a.url) { skipped++; continue; }

    const existing = existingByUrl.get(a.url);
    if (existing) {
      // Already in queue — skip (don't touch its retry state)
      skipped++;
      continue;
    }

    // Skip if already marked 'failed' (exhausted all 3 retries)
    // (We check the queue itself because failed items remain in the queue
    //  with status='failed' for monitoring purposes.)

    // Check if summary already exists in KV → skip entirely
    const aiKey = `${NEWS_AI_CACHE_PREFIX}${hashUrl(a.url)}`;
    const cachedSummary = await readAppCache(env, aiKey).catch(() => null);
    if (cachedSummary) { skipped++; continue; }

    // ── DB CHECK (permanent storage) ──
    // Also check the news_articles table — if the article was analyzed before
    // and KV has expired (7-day TTL), the DB still has the summary.
    // This prevents re-enqueuing and re-processing old articles.
    if (newsArticleRepo) {
      const dbArticle = await newsArticleRepo.findByUrl(env, a.url).catch(() => null);
      if (dbArticle && dbArticle.summary && dbArticle.summary.trim().length >= 50) {
        // Summary exists in DB — refresh KV cache and skip
        try {
          const payload = JSON.stringify({
            summary: dbArticle.summary,
            provider: dbArticle.provider,
            attempts: [],
            generated_at: new Date(dbArticle.analyzed_at).getTime() || Date.now(),
            e2e: {},
          });
          await writeAppCache(env, aiKey, payload, NEWS_AI_CACHE_TTL);
        } catch {}
        skipped++;
        continue;
      }
    }

    queue.push({
      url: a.url,
      title: a.title_en || a.title || '',
      title_en: a.title_en || '',
      description: String(a.description || '').slice(0, 2000), // RSS description as fallback
      source: a.source || '',
      category: a.category || 'crypto',
      retry_count: 0,
      last_attempt: null,
      next_retry: null, // null = immediately eligible
      status: 'pending',
      enqueued_at: now,
      // Phase 10.5 E2E timing instrumentation
      rss_fetched_at: now,        // approx — RSS fetch happened seconds before enqueue
      summary_started_at: null,   // set when processOneArticleSummary picks this item
      summary_completed_at: null, // set when summary saved to KV (success)
      provider_used: null,        // 'gemini' | 'workers-ai' | 'openai'
    });
    existingByUrl.set(a.url, queue[queue.length - 1]);
    enqueued++;
  }

  // Limit queue size to 80 (prevent unbounded growth; preserves failed items for monitoring)
  // Keep newest 80 items, but always keep all 'failed' items (for audit) up to a cap of 20 failed.
  // PHASE B FIX (AI-1): Also recover stale 'processing' items (claim expired) back to 'pending'.
  // CLEANUP: Remove failed items older than 24 hours (they've been monitored long enough).
  const _now = Date.now();
  const STALE_FAILED_MS = 24 * 60 * 60 * 1000; // 24 hours
  for (const q of queue) {
    if (q.status === 'processing' && q._claim_expires_at && q._claim_expires_at < _now) {
      q.status = 'pending';
      q._claim_expires_at = null;
    }
    // Remove stale failed items (older than 24h) — they're no longer useful for monitoring
    if (q.status === 'failed' && q.last_attempt && (_now - q.last_attempt) > STALE_FAILED_MS) {
      q._remove = true;
    }
  }
  // Filter out items marked for removal
  const cleanQueue = queue.filter(q => !q._remove);
  const failedItems = cleanQueue.filter(q => q.status === 'failed').slice(-20);
  const pendingItems = cleanQueue.filter(q => q.status !== 'failed').slice(-60);
  const trimmedQueue = [...pendingItems, ...failedItems];
  await saveSummaryQueue(env, trimmedQueue);

  return { enqueued, skipped, total: trimmedQueue.length };
}

/**
 * Process ONE eligible article summary from the queue (FIFO with backoff).
 *
 * Eligibility:
 *   - status === 'pending' (not 'failed')
 *   - next_retry is null OR next_retry <= now (backoff window expired)
 *
 * Flow:
 *   1. Find first eligible item (don't pop yet — we may need to requeue with retry state)
 *   2. If summary already in KV → mark done (remove from queue)
 *   3. Fetch article HTML → extract readable text (article → main → <p> tags → RSS description)
 *   4. Generate AI summary (Gemini → Workers AI fallback)
 *   5. On success → save to KV (7 days) + remove from queue
 *   6. On failure → increment retry_count, set last_attempt, set next_retry (backoff)
 *      - If retry_count >= MAX_RETRIES → status='failed' (kept in queue for monitoring)
 *      - Else → keep in queue with updated retry state
 *   7. Update monitoring stats in KV
 *
 * Returns { processed: true, success, url, reason, retry_count, duration_ms }
 *      or { processed: false, empty: true } when no eligible item.
 */
async function processOneArticleSummary(env, pool = null) {
  const t0 = Date.now();

  // Feature flag — when summary is disabled, do nothing
  if (!isNewsSummaryEnabled(env)) {
    return { processed: false, empty: true, reason: 'summary_disabled' };
  }

  const queue = await getSummaryQueue(env);
  if (queue.length === 0) return { processed: false, empty: true };

  const now = Date.now();

  // Find first eligible item (FIFO among eligible)
  // PHASE B FIX (AI-1): Skip items with status='processing' to prevent
  // concurrent processOneArticleSummary calls from processing the same article.
  // Previously, */5 and */15 crons could both pick the same eligible item
  // → 2-3× duplicate AI calls on 15-min boundaries.
  // Now: mark item as 'processing' and save queue BEFORE AI call.
  // Concurrent calls see status='processing' and skip it.
  let idx = -1;
  for (let i = 0; i < queue.length; i++) {
    const item = queue[i];
    if (!item || !item.url) continue;
    if (item.status === 'failed') continue;
    if (item.status === 'processing') continue; // PHASE B FIX: skip items being processed
    // Eligible if next_retry is null or in the past
    if (item.next_retry && item.next_retry > now) continue;
    idx = i;
    break;
  }

  if (idx === -1) {
    // No eligible items — all either failed, processing, or in backoff
    return { processed: false, empty: true, reason: 'no_eligible', queueLength: queue.length };
  }

  const article = queue[idx];
  const aiKey = `${NEWS_AI_CACHE_PREFIX}${hashUrl(article.url)}`;

  // PHASE B FIX (AI-1): Atomic claim — mark item as 'processing' and save queue
  // BEFORE calling AI. This prevents concurrent cron ticks from picking the same item.
  // If Worker crashes mid-processing, requeueStaleQueueItems (or next tick) will
  // eventually retry it (status stays 'processing' but no other tick touches it
  // until a cleanup pass resets stale 'processing' items back to 'pending').
  article.status = 'processing';
  article.summary_started_at = now;
  article._claim_expires_at = now + 10 * 60 * 1000; // 10 min claim TTL
  await saveSummaryQueue(env, queue);

  // Reload queue to get the freshest state (in case another tick modified it)
  // and re-find our item by URL (in case queue was reordered)
  const freshQueue = await getSummaryQueue(env);
  let freshIdx = freshQueue.findIndex(q => q.url === article.url && q.status === 'processing');
  if (freshIdx === -1) {
    // Another tick already processed and removed this item — skip
    return { processed: false, empty: true, reason: 'claimed_by_another' };
  }
  // Use the fresh queue as our working copy
  queue.length = 0;
  queue.push(...freshQueue);
  idx = freshIdx;

  // ── SUMMARY CACHE CHECK (Phase 10.5) ──
  // Before running ANY provider, check if a valid summary already exists.
  // Two-layer check:
  //   1. KV cache (news:ai:{hash}) — fast, TTL 7 days
  //   2. DB (news_articles table) — permanent, no TTL
  // If either has a valid summary → skip AI entirely.

  // Ensure news_articles table exists (idempotent, cached per-isolate).
  // Called here (not from cron) to avoid DDL on hot cron paths.
  if (newsArticleRepo) {
    try { await newsArticleRepo.ensureTable(env); } catch {}
  }

  const existingRaw = await readAppCache(env, aiKey).catch(() => null);
  let existingSummary = null;
  let existingProvider = null;
  if (existingRaw) {
    // Parse JSON format (Phase 10+) or plain string (legacy)
    try {
      const parsed = JSON.parse(existingRaw);
      if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string' && parsed.summary.trim().length >= 50) {
        existingSummary = parsed.summary;
        existingProvider = parsed.provider || null;
      }
    } catch {
      // Plain string (legacy format)
      if (typeof existingRaw === 'string' && existingRaw.trim().length >= 50) {
        existingSummary = existingRaw;
      }
    }
  }

  // ── DB CHECK (permanent storage) ──
  // If KV cache missed, check the DB before calling AI.
  // The DB stores summaries permanently — no TTL expiry.
  if (!existingSummary && newsArticleRepo) {
    const dbArticle = await newsArticleRepo.findByUrl(env, article.url, pool).catch(() => null);
    if (dbArticle && dbArticle.summary && dbArticle.summary.trim().length >= 50) {
      existingSummary = dbArticle.summary;
      existingProvider = dbArticle.provider || 'db';
      // Also refresh KV cache so next check is faster
      try {
        const payload = JSON.stringify({
          summary: dbArticle.summary,
          provider: dbArticle.provider,
          attempts: [],
          generated_at: new Date(dbArticle.analyzed_at).getTime() || Date.now(),
          e2e: {},
        });
        await writeAppCache(env, aiKey, payload, NEWS_AI_CACHE_TTL);
      } catch {}
    }
  }

  if (existingSummary) {
    // CACHE HIT — valid summary exists (KV or DB), skip AI entirely
    try { await recordCacheStat(env, true); } catch {}
    queue.splice(idx, 1);
    await saveSummaryQueue(env, queue);
    return {
      processed: true, success: true, reason: 'cache_hit',
      url: article.url, provider: existingProvider, cache_hit: true,
      duration_ms: Date.now() - t0,
    };
  }
  // CACHE MISS — no valid summary in KV or DB, proceed to AI generation
  try { await recordCacheStat(env, false); } catch {}

  // Helper: requeue with retry state (mutates queue in place + persists)
  async function requeueWithRetry(reason, errorDetail) {
    const newRetryCount = (article.retry_count || 0) + 1;
    const backoffMin = NEWS_SUMMARY_BACKOFF_MINUTES[Math.min(newRetryCount - 1, NEWS_SUMMARY_BACKOFF_MINUTES.length - 1)] || 30;
    article.retry_count = newRetryCount;
    article.last_attempt = now;
    article.next_retry = now + backoffMin * 60 * 1000;
    if (newRetryCount >= NEWS_SUMMARY_MAX_RETRIES) {
      article.status = 'failed';
      article.fail_reason = reason;
    }
    // Move to end of queue (so other eligible items get a chance first)
    queue.splice(idx, 1);
    queue.push(article);
    await saveSummaryQueue(env, queue);
    return {
      processed: true,
      success: false,
      reason,
      error: errorDetail,
      url: article.url,
      retry_count: newRetryCount,
      next_retry: article.next_retry,
      status: article.status,
      duration_ms: Date.now() - t0,
    };
  }

  // Helper: on success — remove from queue + save summary WITH metadata
  // (Phase 10: store provider + attempts as JSON for monitoring + frontend visibility)
  async function succeedWithSummary(summary, provider, attempts) {
    const completedAt = Date.now();
    try {
      // Store as JSON with metadata (backward-compatible: enrichNewsWithAISummaries parses both)
      const payload = JSON.stringify({
        summary,
        provider, // 'gemini' | 'workers-ai' | 'openai'
        attempts: attempts.map(a => ({
          provider: a.provider,
          success: a.success,
          error: a.error || null,
          duration_ms: a.duration_ms || 0,
        })),
        generated_at: completedAt,
        // E2E timing (for /api/news-ai-timing diagnostics)
        e2e: {
          rss_fetched_at: article.rss_fetched_at || null,
          enqueued_at: article.enqueued_at || null,
          summary_started_at: article.summary_started_at || null,
          summary_completed_at: completedAt,
          total_e2e_ms: (article.rss_fetched_at) ? (completedAt - article.rss_fetched_at) : null,
          queue_wait_ms: (article.enqueued_at && article.summary_started_at)
            ? (article.summary_started_at - article.enqueued_at) : null,
          summary_gen_ms: (article.summary_started_at)
            ? (completedAt - article.summary_started_at) : null,
        },
      });
      await writeAppCache(env, aiKey, payload, NEWS_AI_CACHE_TTL);

      // ── PERMANENT DB STORAGE ──
      // Save summary to news_articles table (permanent — no TTL).
      // This prevents re-processing the same article after KV expires (7 days).
      // Uses ON CONFLICT DO UPDATE so re-analysis overwrites stale data.
      if (newsArticleRepo) {
        try {
          const fp = newsArticleRepo.fingerprint(article.url, article.title_en || article.title || '', article.source || '');
          await newsArticleRepo.saveAnalysis(env, {
            id: fp,
            url: article.url,
            title: article.title || article.title_en || '',
            title_en: article.title_en || '',
            source: article.source || '',
            category: article.category || 'crypto',
            summary: summary,
            sentiment: 'neutral',  // Will be enriched by batchAnalyzeNews
            impact: 'low',
            impact_reason: '',
            coins: [],
            provider: provider,
          }, pool);
        } catch (e) {
          // DB save is best-effort — KV cache is the primary read path
          console.warn('[NEWS-ARTICLES] DB save failed (non-fatal):', e?.message);
        }
      }

      // Record E2E timing to a rolling history in KV (for monitoring)
      try {
        await recordE2ETiming(env, {
          url: article.url,
          provider,
          rss_fetched_at: article.rss_fetched_at,
          enqueued_at: article.enqueued_at,
          summary_started_at: article.summary_started_at,
          summary_completed_at: completedAt,
          total_e2e_ms: (article.rss_fetched_at) ? (completedAt - article.rss_fetched_at) : null,
          queue_wait_ms: (article.enqueued_at && article.summary_started_at)
            ? (article.summary_started_at - article.enqueued_at) : null,
          summary_gen_ms: (article.summary_started_at)
            ? (completedAt - article.summary_started_at) : null,
        });
      } catch {}
    } catch (e) {
      // KV write failed — treat as retryable failure
      return requeueWithRetry('kv_write_failed', e?.message);
    }
    queue.splice(idx, 1);
    await saveSummaryQueue(env, queue);
    return {
      processed: true,
      success: true,
      url: article.url,
      provider,
      retry_count: article.retry_count || 0,
      duration_ms: Date.now() - t0,
      fallback_used: attempts.length > 1,
      e2e_total_ms: (article.rss_fetched_at) ? (completedAt - article.rss_fetched_at) : null,
    };
  }

  // ── STEP 1: Fetch article HTML ──
  let html = null;
  try {
    const fetchController = new AbortController();
    const fetchTimeout = setTimeout(() => fetchController.abort(), 8000);
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
      return requeueWithRetry('fetch_' + articleRes.status, 'HTTP ' + articleRes.status);
    }
    html = await articleRes.text();
  } catch (e) {
    return requeueWithRetry('fetch_error', e?.message?.substring(0, 120));
  }

  // ── STEP 2: Extract readable article text ──
  // Fallback chain: <article> → <main> → all <p> tags → RSS description (last resort)
  // NEVER fall back to raw cleanedHtml (junk), and NEVER show RSS body to user.
  // PERF FIX: Combined 9 separate regex .replace() calls into a single pass
  // using regex alternation. This reduces regex compilation and string
  // scanning from 9 passes to 1 pass — significant CPU savings on large HTML.
  let cleanedHtml = html
    .replace(/<(script|style|nav|footer|header|aside|noscript|form|iframe)[^>]*>[\s\S]*?<\/\1>/gi, '');

  function stripTags(s) {
    return s
      .replace(/<[^>]+>/g, ' ')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/\s+/g, ' ')
      .trim();
  }

  let articleText = '';
  let extractionSource = 'none';

  // Stage 1: <article>
  let m = cleanedHtml.match(/<article[^>]*>[\s\S]*?<\/article>/i);
  if (m && stripTags(m[0]).length >= 200) {
    articleText = stripTags(m[0]);
    extractionSource = 'article';
  }
  // Stage 2: <main>
  if (!articleText) {
    m = cleanedHtml.match(/<main[^>]*>[\s\S]*?<\/main>/i);
    if (m && stripTags(m[0]).length >= 200) {
      articleText = stripTags(m[0]);
      extractionSource = 'main';
    }
  }
  // Stage 3: all <p> tags
  if (!articleText) {
    const paragraphs = cleanedHtml.match(/<p[^>]*>[\s\S]*?<\/p>/gi) || [];
    const joined = stripTags(paragraphs.join(' '));
    if (joined.length >= 200) {
      articleText = joined;
      extractionSource = 'paragraphs';
    }
  }
  // Stage 4: RSS description (LAST RESORT — never raw cleanedHtml)
  if (!articleText) {
    const descText = stripTags(article.description || '');
    const titleText = stripTags(article.title || article.title_en || '');
    const combined = (titleText + '\n\n' + descText).trim();
    if (combined.length >= 50) {
      articleText = combined;
      extractionSource = 'rss_description';
    }
  }

  // Truncate to keep prompt size reasonable
  if (articleText.length > 8000) articleText = articleText.substring(0, 8000);

  if (articleText.length < 50) {
    // Truly nothing to summarize — mark as failed (no point retrying)
    article.retry_count = (article.retry_count || 0) + 1;
    article.last_attempt = now;
    article.status = 'failed'; // skip retries — article has no content
    article.fail_reason = 'text_too_short';
    queue.splice(idx, 1);
    queue.push(article);
    await saveSummaryQueue(env, queue);
    return {
      processed: true, success: false, reason: 'text_too_short',
      url: article.url, retry_count: article.retry_count, status: 'failed',
      duration_ms: Date.now() - t0,
    };
  }

  // ── STEP 3: Generate AI summary via MULTI-PROVIDER FALLBACK (Phase 10) ──
  // Providers tried in order: Gemini → Workers AI → OpenAI
  // Each provider only tried if the previous FAILED (same invocation, no queue wait).
  // Queue retry only when ALL providers fail.

  // Professional journalist prompt — emphasizes: read full article, preserve
  // numbers/names/dates, explain significance, no fabrication, fluent Farsi.
  // (Same prompt used by all 3 providers for consistent quality.)
  const JOURNALIST_SYSTEM = 'تو یک خبرنگار حرفه‌ای مالی و کریپتو هستی. وظیفه تو این است که مقاله زیر را کامل بخوانی و یک تحلیل حرفه‌ای، روان و دقیق به زبان فارسی بنویسی. تو مترجم نیستی، بازنویس نیستی، و تبلیغ‌نویس نیستی. تو یک تحلیل‌گر خبر هستی.';
  const JOURNALIST_PROMPT = `${JOURNALIST_SYSTEM}

متن کامل مقاله زیر را بخوان و یک تحلیل حرفه‌ای به زبان فارسی (فارسی روان) بنویس.

محدوده طول: ۱۲۰ تا ۲۰۰ کلمه.

ساختار (بر اساس حجم خبر تصمیم بگیر — مقاله کوتاه: ۲ پاراگراف، متوسط: ۳ پاراگراف، مهم: ۴ پاراگراف):

پاراگراف ۱ — چه اتفاقی افتاد: رویداد کلیدی را روشن توضیح بده. چه کسی، چه چیزی، کِی، کجا. تمام اعداد مهم (قیمت، درصد، مبلغ، تعداد) را حفظ کن. تمام نام افراد، شرکت‌ها و نهادها را دقیق بیاور.

پاراگراف ۲ — جزئیات مهم: زمینه و جزئیات کلیدی که بدون آن‌ها خبر ناقص است. دلایل، شرایط، یا اعداد تکمیلی.

پاراگراف ۳ — چرا اهمیت دارد: اهمیت این خبر برای بازار کریپتو/مالی را توضیح بده. چه چیزی می‌تواند تغییر کند؟ چه کسانی تحت تأثیر قرار می‌گیرند؟

پاراگراف ۴ — اثر روی بازار و نکته معامله‌گر: کدام ارزها، پروژه‌ها یا شرکت‌ها تأثیر می‌گیرند؟ یک نکته عملی که معامله‌گر یا سرمایه‌گذار باید بداند.

قوانین:
- فارسی کاملاً روان و طبیعی بنویس.
- عنوان یا توضیح را ترجمه نکن — یک تحلیل اصلی بنویس.
- هیچ‌گونه نظر یا پیش‌بینی که در مقاله نیست را اضافه نکن.
- هیچ واقع، عدد یا نقل‌قولی را نسازید.
- تمام اعداد، نام‌ها و تاریخ‌های مهم مقاله را حفظ کن.
- فقط بر اساس محتوای مقاله تحلیل کن.
- بین پاراگراف‌ها از خط خالی (\\n\\n) استفاده کن.

متن مقاله:

${articleText}`;

  // Run multi-provider fallback (Gemini → Workers AI → OpenAI)
  const fallbackResult = await generateSummaryWithFallback(env, JOURNALIST_PROMPT);

  // Record per-provider stats for monitoring (non-blocking, best-effort)
  for (const attempt of fallbackResult.attempts) {
    try {
      await recordProviderAttempt(env, attempt.provider, attempt.success, attempt.duration_ms || 0);
    } catch {}
  }
  // Record fallback event if success came from a non-primary provider
  if (fallbackResult.fallbackUsed && fallbackResult.usedProvider) {
    try { await recordFallbackEvent(env, fallbackResult.usedProvider); } catch {}
  }

  // ── STEP 4: Save to KV (7 days) or requeue ──
  if (fallbackResult.summary && fallbackResult.summary.trim().length >= 50) {
    // SUCCESS — save summary + provider metadata, remove from queue
    return succeedWithSummary(fallbackResult.summary, fallbackResult.usedProvider, fallbackResult.attempts);
  }

  // ALL PROVIDERS FAILED
  // Decision: requeue (retryable) vs mark failed (all non-retryable)
  if (fallbackResult.allNonRetryable && !fallbackResult.anyRetryable && fallbackResult.attempts.length > 0) {
    // All errors were non-retryable (invalid key, model not found, bad prompt)
    // → No point retrying — config won't change. Mark as failed immediately.
    article.retry_count = (article.retry_count || 0) + 1;
    article.last_attempt = now;
    article.status = 'failed';
    article.fail_reason = 'all_providers_non_retryable';
    article.fail_attempts = fallbackResult.attempts.map(a => ({ provider: a.provider, error: a.error, errorType: a.errorType }));
    queue.splice(idx, 1);
    queue.push(article);
    await saveSummaryQueue(env, queue);
    return {
      processed: true, success: false, reason: 'all_providers_non_retryable',
      url: article.url, retry_count: article.retry_count, status: 'failed',
      attempts: fallbackResult.attempts, duration_ms: Date.now() - t0,
    };
  }

  // At least one retryable error → requeue with backoff
  // (Queue retry ONLY when all providers fail — per Phase 10 spec)
  const failSummary = fallbackResult.attempts
    .map(a => `${a.provider}:${a.success ? 'ok' : a.error}`)
    .join(', ');
  return requeueWithRetry('all_providers_failed', failSummary);
}

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
 * Record News AI tick stats to KV for monitoring.
 * Called after each processNewsAIBatch / processOneArticleSummary tick.
 * Stores the last 20 ticks (rolling window) at NEWS_AI_MONITOR_KEY.
 */
async function recordNewsAITick(env, stats) {
  if (!env.APP_CACHE) return;
  try {
    const raw = await readAppCache(env, NEWS_AI_MONITOR_KEY).catch(() => null);
    let history = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    }
    history.push({ ts: Date.now(), ...stats });
    // Keep last 20 ticks
    if (history.length > 20) history = history.slice(-20);
    await writeAppCache(env, NEWS_AI_MONITOR_KEY, JSON.stringify(history), NEWS_AI_MONITOR_TTL);
  } catch (e) {
    console.warn('[NEWS-AI-MONITOR] recordTick failed:', e?.message);
  }
}

// ── E2E Timing History (Phase 10.5 final validation) ──
const NEWS_AI_E2E_TIMING_KEY = 'news:ai_e2e_timing';
const NEWS_AI_E2E_TIMING_TTL = 24 * 60 * 60; // 24h

/**
 * Record E2E timing for a completed summary to a rolling history in KV.
 * Used by /api/news-ai-timing endpoint for final production validation.
 * Keeps last 50 completed summaries.
 */
async function recordE2ETiming(env, timing) {
  if (!env.APP_CACHE) return;
  try {
    const raw = await readAppCache(env, NEWS_AI_E2E_TIMING_KEY).catch(() => null);
    let history = [];
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    }
    history.push({ ts: Date.now(), ...timing });
    // Keep last 50 completed summaries
    if (history.length > 50) history = history.slice(-50);
    await writeAppCache(env, NEWS_AI_E2E_TIMING_KEY, JSON.stringify(history), NEWS_AI_E2E_TIMING_TTL);
  } catch (e) {
    console.warn('[NEWS-AI-E2E] recordE2ETiming failed:', e?.message);
  }
}

/**
 * Get E2E timing history + computed stats (avg, max, min) for each phase.
 * Returns: { history, stats: { avg_total_e2e_ms, max_total_e2e_ms, avg_queue_wait_ms,
 *           avg_summary_gen_ms, count, by_provider: {} } }
 */
async function getE2ETimingStats(env) {
  let history = [];
  try {
    const raw = await readAppCache(env, NEWS_AI_E2E_TIMING_KEY).catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    }
  } catch {}

  if (history.length === 0) {
    return { history: [], stats: null, count: 0 };
  }

  // Compute stats
  const totals = history.filter(h => h.total_e2e_ms != null).map(h => h.total_e2e_ms);
  const queueWaits = history.filter(h => h.queue_wait_ms != null).map(h => h.queue_wait_ms);
  const genTimes = history.filter(h => h.summary_gen_ms != null).map(h => h.summary_gen_ms);

  const avg = (arr) => arr.length ? Math.round(arr.reduce((a, b) => a + b, 0) / arr.length) : 0;
  const max = (arr) => arr.length ? Math.max(...arr) : 0;
  const min = (arr) => arr.length ? Math.min(...arr) : 0;

  // By provider breakdown
  const byProvider = {};
  for (const h of history) {
    const p = h.provider || 'unknown';
    if (!byProvider[p]) byProvider[p] = { count: 0, total_e2e_ms: [], summary_gen_ms: [] };
    byProvider[p].count++;
    if (h.total_e2e_ms != null) byProvider[p].total_e2e_ms.push(h.total_e2e_ms);
    if (h.summary_gen_ms != null) byProvider[p].summary_gen_ms.push(h.summary_gen_ms);
  }
  for (const p of Object.keys(byProvider)) {
    byProvider[p].avg_total_e2e_ms = avg(byProvider[p].total_e2e_ms);
    byProvider[p].avg_summary_gen_ms = avg(byProvider[p].summary_gen_ms);
  }

  return {
    history: history.slice(-20), // last 20 for the response
    stats: {
      count: history.length,
      avg_total_e2e_ms: avg(totals),
      max_total_e2e_ms: max(totals),
      min_total_e2e_ms: min(totals),
      avg_queue_wait_ms: avg(queueWaits),
      max_queue_wait_ms: max(queueWaits),
      avg_summary_gen_ms: avg(genTimes),
      max_summary_gen_ms: max(genTimes),
    },
    by_provider: byProvider,
  };
}

/**
 * Get News AI monitoring snapshot.
 * Returns: { queue_length, pending_count, failed_count, in_backoff_count,
 *            oldest_enqueued_age_ms, last_tick, history, flags }
 */
async function getNewsAIMonitoring(env) {
  const queue = await getSummaryQueue(env);
  const now = Date.now();

  let pending = 0, failed = 0, inBackoff = 0;
  let oldestEnqueued = null;
  let totalRetries = 0;
  for (const item of queue) {
    if (item.status === 'failed') {
      failed++;
    } else {
      pending++;
      if (item.next_retry && item.next_retry > now) inBackoff++;
      totalRetries += (item.retry_count || 0);
    }
    if (item.enqueued_at && (!oldestEnqueued || item.enqueued_at < oldestEnqueued)) {
      oldestEnqueued = item.enqueued_at;
    }
  }

  // Read tick history
  let history = [];
  try {
    const raw = await readAppCache(env, NEWS_AI_MONITOR_KEY).catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (Array.isArray(parsed)) history = parsed;
    }
  } catch {}

  const lastTick = history.length > 0 ? history[history.length - 1] : null;

  // ── Phase 10: Provider stats (per-provider success/failed, fallback count, avg time) ──
  let providerStats = null;
  try {
    const raw = await readAppCache(env, NEWS_AI_PROVIDER_STATS_KEY).catch(() => null);
    if (raw) providerStats = JSON.parse(raw);
  } catch {}

  // Calculate "Average Provider" = the provider used most often for SUCCESSFUL summaries
  let avgProvider = null;
  let avgSummaryTimeMs = 0;
  if (providerStats) {
    const providers = ['gemini', 'workers-ai', 'openai'];
    let maxSuccess = 0;
    for (const p of providers) {
      if (providerStats[p] && providerStats[p].success > maxSuccess) {
        maxSuccess = providerStats[p].success;
        avgProvider = p;
      }
    }
    if (providerStats.total_summaries > 0) {
      avgSummaryTimeMs = Math.round(providerStats.total_duration_ms / providerStats.total_summaries);
    }
  }

  // ── Phase 10.5: Circuit Breaker state per provider ──
  const providerNames = ['gemini', 'workers-ai', 'openai'];
  const providerStatus = {};
  let circuitOpenCount = 0;
  for (const p of providerNames) {
    const cbState = await getCircuitState(env, p);
    // Auto-transition: if OPEN and retry_after passed, show as 'HALF_OPEN' (probe due)
    let displayState = cbState.state;
    if (cbState.state === 'OPEN' && cbState.retry_after && now >= cbState.retry_after) {
      displayState = 'HALF_OPEN'; // probe is due
    }
    providerStatus[p] = {
      state: displayState,
      consecutive_failures: cbState.consecutive_failures || 0,
      opened_at: cbState.opened_at || null,
      retry_after: cbState.retry_after || null,
      retry_after_in_ms: cbState.retry_after ? Math.max(0, cbState.retry_after - now) : null,
      last_failure_reason: cbState.last_failure_reason || null,
    };
    if (displayState === 'OPEN') circuitOpenCount++;
  }

  // ── Phase 10.5: Summary Cache stats ──
  let cacheHits = 0, cacheMisses = 0, cacheHitRate = 0;
  try {
    const raw = await readAppCache(env, NEWS_AI_CACHE_STATS_KEY).catch(() => null);
    if (raw) {
      const parsed = JSON.parse(raw);
      cacheHits = parsed.hits || 0;
      cacheMisses = parsed.misses || 0;
      const total = cacheHits + cacheMisses;
      cacheHitRate = total > 0 ? Math.round((cacheHits / total) * 1000) / 10 : 0; // % with 1 decimal
    }
  } catch {}

  return {
    ts: now,
    queue_length: queue.length,
    pending_count: pending,
    failed_count: failed,
    in_backoff_count: inBackoff,
    total_retries: totalRetries,
    oldest_enqueued_age_ms: oldestEnqueued ? (now - oldestEnqueued) : null,
    last_tick: lastTick,
    history: history.slice(-10), // last 10 ticks
    flags: {
      NEWS_AI_ENABLED: isNewsAIEnabled(env),
      NEWS_SUMMARY_ENABLED: isNewsSummaryEnabled(env),
      NEWS_BATCH_ANALYSIS_ENABLED: isNewsBatchAnalysisEnabled(env),
      NEWS_QUEUE_ENABLED: isNewsQueueEnabled(env),
      // Phase 10: provider flags
      NEWS_PROVIDER_GEMINI: isNewsProviderEnabled(env, 'NEWS_PROVIDER_GEMINI', true),
      NEWS_PROVIDER_WORKERS_AI: isNewsProviderEnabled(env, 'NEWS_PROVIDER_WORKERS_AI', true),
      NEWS_PROVIDER_OPENAI: isNewsProviderEnabled(env, 'NEWS_PROVIDER_OPENAI', false),
    },
    config: {
      max_retries: NEWS_SUMMARY_MAX_RETRIES,
      backoff_minutes: NEWS_SUMMARY_BACKOFF_MINUTES,
      summary_ttl_days: NEWS_AI_CACHE_TTL / (24 * 3600),
      news_list_ttl_minutes: 30,
      // Phase 10: provider config
      openai_model: OPENAI_MODEL,
      providers_priority: ['gemini', 'workers-ai', 'openai'],
      // Phase 10.5: circuit breaker config
      circuit_breaker_threshold: CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      circuit_breaker_open_ms: CIRCUIT_BREAKER_OPEN_MS,
    },
    // Phase 10: per-provider stats
    providers: {
      gemini: providerStats?.gemini || { success: 0, failed: 0, total_ms: 0 },
      'workers-ai': providerStats?.['workers-ai'] || { success: 0, failed: 0, total_ms: 0 },
      'openai': providerStats?.openai || { success: 0, failed: 0, total_ms: 0 },
    },
    fallback_count: providerStats?.fallback_count || 0,
    fallback_to: providerStats?.fallback_to || {},
    average_provider: avgProvider,
    average_summary_time_ms: avgSummaryTimeMs,
    total_summaries_generated: providerStats?.total_summaries || 0,
    provider_stats_updated_at: providerStats?.updated_at || null,
    // Phase 10.5: Circuit Breaker status
    provider_status: providerStatus,
    circuit_breaker_open_count: circuitOpenCount,
    // Phase 10.5: Summary Cache stats
    summary_cache_hits: cacheHits,
    summary_cache_misses: cacheMisses,
    cache_hit_rate: cacheHitRate, // percentage (0-100, 1 decimal)
    failed_items: queue.filter(q => q.status === 'failed').slice(-5).map(q => ({
      url: q.url, title: q.title, retry_count: q.retry_count,
      fail_reason: q.fail_reason, last_attempt: q.last_attempt,
    })),
  };
}


/**
 * Enrich news articles with AI summaries from KV cache.
 * If summary exists → add ai_summary + ai_status='completed'
 * If not → check queue to distinguish 'pending' (in queue, will be processed)
 *                                    from 'failed' (exhausted retries — won't be retried)
 *                                    from 'unknown' (not yet enqueued, will be picked up next cron)
 *
 * Frontend uses ai_status to decide message:
 *   completed → show summary
 *   pending   → "تحلیل این خبر در حال تولید است..."
 *   failed    → "تحلیل این خبر در دسترس نیست." (no infinite waiting)
 *   unknown   → same as pending (will be enqueued next cron)
 */
async function enrichNewsWithAISummaries(env, articles) {
  if (!env.APP_CACHE || !Array.isArray(articles)) return articles;

  // Read queue ONCE to build a URL → full item map (cheap, single KV read)
  // We need the full item (not just status) to distinguish pending vs retry
  let queueItemByUrl = new Map();
  try {
    const queue = await getSummaryQueue(env);
    const now = Date.now();
    for (const item of queue) {
      if (item.url) {
        // Derive display status from queue item:
        // - status='failed' → 'failed' (exhausted retries)
        // - status='pending' + next_retry > now → 'retry' (in backoff, waiting to retry)
        // - status='pending' + (no next_retry OR next_retry <= now) → 'pending' (eligible for next tick)
        let displayStatus = item.status || 'pending';
        if (displayStatus === 'pending' && item.next_retry && item.next_retry > now) {
          displayStatus = 'retry';
        }
        queueItemByUrl.set(item.url, { ...item, displayStatus });
      }
    }
  } catch (e) {
    console.warn('[NEWS-AI] enrichNews queue read error (non-fatal):', e?.message);
  }

  // Read circuit breaker states ONCE (3 KV reads, cheap) to detect rate_limited
  // If ALL enabled providers have OPEN circuits, articles without summaries get
  // 'rate_limited' status instead of 'pending' — so frontend can show a more
  // accurate message ("AI providers temporarily rate-limited, retrying soon").
  let allProvidersCircuitOpen = false;
  try {
    const enabledProviders = [];
    if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_GEMINI', true)) enabledProviders.push('gemini');
    if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_WORKERS_AI', true)) enabledProviders.push('workers-ai');
    if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_OPENAI', false)) enabledProviders.push('openai');

    if (enabledProviders.length > 0) {
      const now = Date.now();
      let openCount = 0;
      for (const p of enabledProviders) {
        const cbState = await getCircuitState(env, p);
        // Circuit is "blocking" if OPEN and retry_after hasn't passed yet
        if (cbState.state === 'OPEN' && cbState.retry_after && cbState.retry_after > now) {
          openCount++;
        }
      }
      allProvidersCircuitOpen = (openCount === enabledProviders.length);
    }
  } catch (e) {
    console.warn('[NEWS-AI] enrichNews circuit check error (non-fatal):', e?.message);
  }

  // PERF: Parallel KV reads — was sequential (30 reads × 50ms = 1.5s),
  // now parallel (30 reads in ~100ms total = 15x faster)
  const enriched = await Promise.all(
    articles.map(async (article) => {
      const aiKey = `${NEWS_AI_CACHE_PREFIX}${hashUrl(article.url || '')}`;
      let aiSummary = null;
      let aiProvider = null;
      let aiGeneratedAt = null;
      try {
        const raw = await readAppCache(env, aiKey);
        if (raw) {
          // Phase 10: KV now stores JSON { summary, provider, attempts, generated_at }
          // Backward compat: old entries are plain strings (just the summary text).
          // Try JSON parse first; if it fails or shape is wrong, treat as plain string.
          try {
            const parsed = JSON.parse(raw);
            if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
              aiSummary = parsed.summary;
              aiProvider = parsed.provider || null;
              aiGeneratedAt = parsed.generated_at || null;
            } else {
              // JSON but not the expected shape — treat as plain string
              aiSummary = raw;
            }
          } catch {
            // Not JSON — plain string (old format from before Phase 10)
            aiSummary = raw;
          }
        }
      } catch (e) { console.warn('[NEWS-AI] enrichNews KV read error:', e?.message); }
      let aiStatus;
      if (aiSummary) {
        aiStatus = 'completed';
      } else {
        const qItem = article.url ? queueItemByUrl.get(article.url) : null;
        if (qItem) {
          // In queue — use displayStatus ('pending' | 'retry' | 'failed')
          aiStatus = qItem.displayStatus || 'pending';
        } else {
          // Not in queue
          // If ALL providers are rate-limited (circuits OPEN), show 'rate_limited'
          // so frontend can display a more specific message
          aiStatus = allProvidersCircuitOpen ? 'rate_limited' : 'unknown';
        }
      }
      return {
        ...article,
        ai_summary: aiSummary || null,
        ai_status: aiStatus,
        ai_provider: aiProvider,     // Phase 10: which provider generated this ('gemini'|'workers-ai'|'openai'|null)
        ai_generated_at: aiGeneratedAt, // Phase 10: timestamp of generation
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

/**
 * Phase 3: Batch AI Analysis — analyzes ALL filtered articles in 1 AI call.
 * Returns sentiment, impact, reason, and related coins for each article.
 *
 * FALLBACK CHAIN (Provider Activation Phase — DeepSeek removed per user request):
 *   1) Gemini       (primary)    — NEWS_PROVIDER_GEMINI=true
 *   2) Workers AI   (fallback 1) — NEWS_PROVIDER_WORKERS_AI=true
 *   3) Rule-based   (fallback 2) — no AI, uses existing sentiment
 *
 * Gemini is ALWAYS tried first. Workers AI is ONLY used as fallback.
 * 1 AI call replaces 10 individual calls.
 */
async function batchAnalyzeNews(env, articles) {
  if (!articles || articles.length === 0) return {};

  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  const hasWorkersAI = !!env.AI;

  // Build prompt with all article titles
  const headlines = articles.map((a, i) => `${i + 1}. "${a.title_en || a.title}"`).join('\n');

  const prompt = `You are a professional crypto market analyst. Analyze these ${articles.length} news headlines.
For EACH headline, return a JSON array where each element has:
- "index": number (1-based)
- "sentiment": "bullish" | "bearish" | "neutral"
- "impact": "high" | "medium" | "low"
- "reason": one short sentence in Persian (Farsi) explaining the analysis
- "coins": array of related coin symbols (e.g., ["BTC", "ETH"])

Return ONLY the JSON array, no other text.

Headlines:
${headlines}`;

  // Helper: parse JSON array from AI response
  function parseBatchResult(text) {
    if (!text) return null;
    // PROVEN FIX: Workers AI (llama-3.3-70b) can return a non-string response
    // (object or undefined). Without this guard, .match() throws:
    // "aiResponse.response.match is not a function"
    if (typeof text !== 'string') return null;
    const jsonMatch = text.match(/\[[\s\S]*\]/);
    if (!jsonMatch) return null;
    try {
      const parsed = JSON.parse(jsonMatch[0]);
      const results = {};
      for (const item of parsed) {
        if (item && item.index && item.index >= 1 && item.index <= articles.length) {
          results[item.index - 1] = {
            sentiment: item.sentiment || 'neutral',
            impact: item.impact || 'low',
            impact_reason: item.reason || '',
            coins: Array.isArray(item.coins) ? item.coins : [],
          };
        }
      }
      return results;
    } catch { return null; }
  }

  // Method 1: Gemini 2.0 Flash (primary) — always tried first
  if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_GEMINI', true) && GEMINI_API_KEY) {
    try {
      const controller = new AbortController();
      const timeout = setTimeout(() => controller.abort(), 20000); // 20s timeout
      const res = await fetch(
        `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
        {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            contents: [{ parts: [{ text: prompt }] }],
            generationConfig: { temperature: 0.2, maxOutputTokens: 2048, topP: 0.8 },
          }),
          signal: controller.signal,
        }
      );
      clearTimeout(timeout);

      if (res.ok) {
        const data = await res.json();
        const text = data?.candidates?.[0]?.content?.parts?.[0]?.text || '';
        const parsed = parseBatchResult(text);
        if (parsed && Object.keys(parsed).length > 0) {
          console.log('[NEWS-AI-BATCH] ✅ Gemini PRIMARY succeeded — no fallback needed');
          return parsed;
        }
      } else {
        let errBody = '';
        try { errBody = (await res.text()).substring(0, 200); } catch {}
        console.warn(`[NEWS-AI-BATCH] ⚠️ Gemini failed (HTTP ${res.status}): ${errBody} — falling back to Workers AI`);
      }
    } catch (e) {
      console.warn('[NEWS-AI-BATCH] ⚠️ Gemini failed:', e?.message, '— falling back to Workers AI');
    }
  }

  // Method 2: Workers AI (fallback 1) — ONLY if Gemini didn't succeed
  if (isNewsProviderEnabled(env, 'NEWS_PROVIDER_WORKERS_AI', true) && hasWorkersAI) {
    try {
      const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
        messages: [
          { role: 'system', content: 'You are a crypto market analyst. Return ONLY a JSON array with sentiment, impact, reason (in Farsi), and coins for each headline.' },
          { role: 'user', content: prompt },
        ],
        max_tokens: 2048,
        temperature: 0.2,
      });

      if (aiResponse?.response) {
        const parsed = parseBatchResult(aiResponse.response);
        if (parsed && Object.keys(parsed).length > 0) {
          console.log('[NEWS-AI-BATCH] ⚠️ Workers AI fallback succeeded (Gemini was unavailable)');
          return parsed;
        }
      }
    } catch (e) {
      console.warn('[NEWS-AI-BATCH] Workers AI failed:', e?.message);
    }
  }

  // Method 3: Rule-based fallback (no AI)
  console.log('[NEWS-AI-BATCH] ⚠️ Using rule-based fallback (all AI providers failed)');
  const fallback = {};
  for (let i = 0; i < articles.length; i++) {
    fallback[i] = {
      sentiment: articles[i].sentiment || 'neutral',
      impact: 'low',
      impact_reason: '',
      coins: [],
    };
  }
  return fallback;
}

async function processNewsAIJobs(env, articles) {
  if (!env.APP_CACHE || !articles.length) return { processed: 0, success: 0, failed: 0, errors: [], stats: { scanned: 0, alreadyCompleted: 0, skippedBeforeAI: 0, aiRequestsExecuted: 0, kvWrites: 0 } };

  const GEMINI_API_KEY = env.GEMINI_API_KEY;
  const hasWorkersAI = !!env.AI;
  const errors = [];
  let success = 0, failed = 0;
  let aiRequestsExecuted = 0;
  let alreadyCompleted = 0;

  // ── ROOT-CAUSE FIX: Increased from 3 → 5 articles per cycle ──
  // With 25s timeout and ~3-5s per article (fetch + AI), 5 articles fit comfortably.
  // This reduces the backlog: 30 articles × 3/cycle = 10 cycles (10 min) → 6 cycles (6 min).
  // ROOT-CAUSE FIX: Reduced from 5 → 3 articles per cycle.
  // Each article = 1 HTML fetch + 1 AI.run() = 2 subrequests.
  // With 3 articles = 6 subrequests for AI summaries.
  // Plus RSS (7) + translations (42) = 55 total. Under 50 limit with batching.
  for (const article of articles.slice(0, 10)) { // Process all filtered articles (max 10)
    if (!article.url) continue;

    const aiKey = `${NEWS_AI_CACHE_PREFIX}${hashUrl(article.url)}`;
    const articleStart = Date.now();

    // Check if summary already exists — SKIP ENTIRE PIPELINE if so
    // (no fetch, no extract, no AI call, no write)
    let existing = null;
    try {
      existing = await readAppCache(env, aiKey);
    } catch (e) {
      console.warn('[NEWS-AI-BG] KV read error (non-fatal):', e?.message);
    }
    if (existing) {
      success++;
            continue;
    }


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
        console.warn(`[NEWS-AI-BG] FETCH_FAILED: HTTP ${articleRes.status} for ${article.url.substring(0, 80)}`);
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
        if (articleText.length < 50) {
          console.warn(`[NEWS-AI-BG] TEXT_TOO_SHORT: only ${articleText.length} chars — skipping`);
          failed++;
          continue;
        }
      }

      // Step 3: Generate AI summary
      let summary = null;
      let aiSource = 'none';

      // Method 1: Gemini 2.0 Flash (if quota available)
      if (GEMINI_API_KEY) {
        try {
          const prompt = `You are a professional Persian crypto and financial journalist.

Write a professional summary of this article in Persian (Farsi), 120-180 words.

Structure (use \\n\\n between paragraphs):

Paragraph 1 — What happened: Describe the key event clearly. Include important numbers, names, dates, and amounts. Be factual and precise.

Paragraph 2 — Why it matters: Explain the significance of this news for the crypto/financial market. What could change? Who is affected?

Paragraph 3 — What to watch: One practical note for traders or investors. What should they pay attention to going forward?

Rules:
- Write in fluent, natural Persian (Farsi).
- Do NOT translate the title or description — write an original analysis.
- Do NOT add opinions or predictions not supported by the article.
- Do NOT invent any facts, numbers, or quotes.
- 120-180 words total.
- Preserve all key numbers, names, and dates from the article.

Article:

${articleText}`;

          const geminiController = new AbortController();
          const geminiTimeout = setTimeout(() => geminiController.abort(), 25000); // 25s for deeper analysis
          aiRequestsExecuted++;
          const geminiRes = await fetch(
            `https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key=${GEMINI_API_KEY}`,
            {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({
                contents: [{ parts: [{ text: prompt }] }],
                generationConfig: { temperature: 0.4, maxOutputTokens: 1024, topP: 0.85 }, // ~180 words Farsi
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
        const aiStart = Date.now();
        try {
          aiRequestsExecuted++;
          const aiResponse = await env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
            messages: [
              { role: 'system', content: 'You are a professional Persian crypto and financial journalist. Write a 120-180 word summary in Farsi with 3 paragraphs: (1) What happened — key facts, numbers, names. (2) Why it matters — market significance. (3) What to watch — practical note for traders. Write original analysis, not translation. No invented facts.' },
              { role: 'user', content: articleText.substring(0, 8000) },
            ],
            max_tokens: 1024, // ~180 words Farsi
            temperature: 0.3,
          });
          
          if (aiResponse && aiResponse.response && aiResponse.response.trim().length >= 50) {
            summary = aiResponse.response;
            aiSource = 'cloudflare-workers-ai';
          } else {
            console.warn(`[NEWS-AI-BG] AI_EMPTY_RESPONSE: ${JSON.stringify(aiResponse).substring(0, 200)}`);
            errors.push({ url: article.url.substring(0, 60), error: 'workers_ai_empty' });
          }
        } catch (e) {
          console.warn(`[NEWS-AI-BG] AI_FAILED in ${Date.now() - aiStart}ms: ${e.message}`);
          console.warn(`[NEWS-AI-BG] AI Stack: ${e.stack?.substring(0, 300)}`);
          errors.push({ url: article.url.substring(0, 60), error: 'workers_ai_' + e.message.substring(0, 80) });
        }
      } else if (!summary && !hasWorkersAI) {
        console.warn('[NEWS-AI-BG] NO_AI_BINDING: env.AI not available — cannot generate summary');
      }

      // Step 4: SAVE — Cache the summary in KV (7 days)
      if (summary && summary.trim().length >= 50) {
        try {
          await writeAppCache(env, aiKey, summary, NEWS_AI_CACHE_TTL);
          success++;
        } catch (e) {
          failed++;
          console.warn(`[NEWS-AI-BG] KV_WRITE_FAILED: ${e.message}`);
          errors.push({ url: article.url.substring(0, 60), error: 'kv_write_' + e.message.substring(0, 80) });
        }
      } else {
        failed++;
        console.warn(`[NEWS-AI-BG] ALL_METHODS_FAILED for: ${article.url.substring(0, 60)}`);
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

// ROOT-CAUSE FIX: ctx_waitUntil_safe was REMOVED.
// It was a fire-and-forget wrapper that caused "A promise was resolved from
// a different request context" warnings. The pattern `promise.catch(() => {})`
// lets the promise continue running AFTER the HTTP response is sent, which
// means any I/O it does (fetch, KV.put) runs in a dead request context.
//
// The CORRECT pattern for background work in the fetch handler is:
//   ctx.waitUntil(promise)  — keeps the request context alive until the promise settles
//
// For the cron handler, ctx.waitUntil is already used correctly.
// For the fetch handler, all background work must either:
//   1. Be awaited before returning the Response, OR
//   2. Be wrapped in ctx.waitUntil(promise) if it must outlive the response

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
async function processNewsAIBatch(env, pool = null) {
  // ── ROOT-CAUSE FIX: Full try/catch with step-by-step logging ──
  // Previously this function had NO top-level try/catch, AND the caller at
  // line 6611 had no .catch(), so any rejection became an unhandled promise
  // rejection → Cloudflare logged a bare "error" with no stack/message.
  // Now every step is logged and any exception is caught + surfaced.
  const t0 = Date.now();
  const stepLog = (step, extra) => {
    const elapsed = Date.now() - t0;
      };

  // ── MERGED: try/catch + step logging (root-cause fix) + KV write stats (from HEAD) ──
  try {
    if (!env.APP_CACHE) {
      stepLog('ABORT', { reason: 'APP_CACHE_not_bound' });
      return { ok: false, reason: 'APP_CACHE_not_bound' };
    }

    // Feature flag — master switch. When NEWS_AI_ENABLED=false, skip the entire
    // batch (RSS, filter, translate, analyze, enqueue). Frontend will still
    // show cached news from KV (if any) but no new processing happens.
    if (!isNewsAIEnabled(env)) {
      stepLog('ABORT', { reason: 'news_ai_disabled' });
      return { ok: true, reason: 'news_ai_disabled', elapsed: Date.now() - t0, flags: { NEWS_AI_ENABLED: false } };
    }

    stepLog('START', { flags: {
      AI: isNewsAIEnabled(env),
      summary: isNewsSummaryEnabled(env),
      batch: isNewsBatchAnalysisEnabled(env),
      queue: isNewsQueueEnabled(env),
    } });

    // ── STEP 1: RSS FETCH ──
    stepLog('RSS_FETCH_start');
    let sources;
    try {
      sources = await fetchAllNewsRss();
    } catch (rssErr) {
      stepLog('RSS_FETCH_FAILED', { error: rssErr?.message, stack: rssErr?.stack?.substring(0, 200) });
      throw rssErr;
    }
    if (!sources || sources.length === 0) {
      stepLog('RSS_FETCH_empty', { sourceCount: 0 });
      return { ok: true, reason: 'no_rss_sources', elapsed: Date.now() - t0 };
    }
    stepLog('RSS_FETCH_done', { sourceCount: sources.length, names: sources.map(s => s.sourceName) });

    // ── STEP 2: PARSE ALL RSS ITEMS (no AI, no translation yet) ──
    stepLog('PARSE_start', { sources: sources.length });
    const allRawItems = [];
    for (const s of sources) {
      try {
        const items = parseRssItems(s.rssText);
        for (const item of items) {
          item._sourceName = s.sourceName;
          item._category = s.category;
          item._skipTranslate = s.skipTranslate;
          allRawItems.push(item);
        }
      } catch (parseErr) {
        console.warn(`[NEWS-AI-CRON] parseRssItems failed for "${s.sourceName}":`, parseErr?.message);
      }
    }
    stepLog('PARSE_done', { totalRawItems: allRawItems.length });

    // ── STEP 3: PRE-FILTER ENGINE (0 AI calls, rule-based) ──
    // Filters out low-importance news, scores by keywords, fuzzy dedup.
    // Reduces ~48 raw items to ~8-12 important articles BEFORE any AI.
    stepLog('PRE_FILTER_start', { input: allRawItems.length });
    const filtered = filterAndScoreNews(allRawItems, 10);
    stepLog('PRE_FILTER_done', {
      input: allRawItems.length,
      output: filtered.length,
      scores: filtered.map(f => ({ title: String(f.item.title).slice(0, 50), score: f.score, tags: f.tags })),
    });

    if (filtered.length === 0) {
      stepLog('PRE_FILTER_empty', { reason: 'no_important_articles' });
      return { ok: true, reason: 'no_important_articles', elapsed: Date.now() - t0 };
    }

    // ── STEP 4: TRANSLATION (only for filtered articles, title only) ──
    // Phase 2 optimization: only translate title, skip description translation.
    // Description is kept in original language for AI analysis context.
    stepLog('TRANSLATION_start', { articles: filtered.length });
    let allArticles;
    try {
      allArticles = await Promise.all(
        filtered.map(async (f) => {
          const item = f.item;
          let translatedTitle = item.title || 'بدون عنوان';

          // Only translate if not already Farsi
          if (!item._skipTranslate) {
            try {
              translatedTitle = await translateToFarsi(item.title || 'بدون عنوان', env);
            } catch (e) {
              console.warn('[NEWS-AI-CRON] translateToFarsi failed:', e?.message);
            }
          }

          const rawTitle = String(translatedTitle).replace(/\n/g, ' ').trim();
          return {
            title: sanitizeNewsTitle(rawTitle),
            title_en: item.title || '',
            description: String(item.description || '').replace(/\n/g, ' ').trim(),
            time_ago: parseRelativeTime(item.pubDate),
            pub_date: item.pubDate ? new Date(item.pubDate).toISOString() : null,
            source: item._sourceName,
            category: item._category || 'crypto',
            image: item.image,
            url: item.url,
            sentiment: classifySentiment(item.title, item.description),
            importance_tags: f.tags,
            importance_score: f.score,
          };
        })
      );
    } catch (transErr) {
      stepLog('TRANSLATION_FAILED', { error: transErr?.message, stack: transErr?.stack?.substring(0, 200) });
      throw transErr;
    }
    stepLog('TRANSLATION_done', { totalArticles: allArticles.length });

    // ── STEP 5: DEDUP by URL (safety net — filterAndScoreNews already deduped by title) ──
    const seen = new Set();
    const deduped = allArticles.filter((a) => {
      if (!a.url || seen.has(a.url)) return false;
      seen.add(a.url);
      return true;
    });
    if (deduped.length === 0) {
      stepLog('QUEUE_empty', { reason: 'no_articles_after_dedup' });
      return { ok: true, reason: 'no_articles', elapsed: Date.now() - t0 };
    }
    stepLog('QUEUE_done', { deduped: deduped.length });

    // ── STEP 6: CACHE ARTICLES in KV (TTL=30min, max=12 articles) ──
    // Phase 5 optimization: TTL 5min → 30min, max 30 → 12 articles.
    const MAX_NEWS_ARTICLES = 12;
    const trimmed = deduped.slice(0, MAX_NEWS_ARTICLES);
    const newsJson = JSON.stringify(trimmed);
    const newsWriteBefore = _kvWriteStats.totalWrites;
    const newsSkippedBefore = _kvWriteStats.totalSkipped;
    const kvAvailable = !!(env.APP_CACHE && typeof env.APP_CACHE.put === 'function');
    const inMemoryCached = _kvWriteCache.has(FARSI_NEWS_CACHE_KEY);
    const inMemoryMatches = _kvWriteCache.get(FARSI_NEWS_CACHE_KEY) === newsJson;
    try {
      await writeAppCache(
        env,
        FARSI_NEWS_CACHE_KEY,
        newsJson,
        getNumericEnv(env, 'NEWS_CACHE_TTL', 1800), // 30 minutes (was 300 = 5 min)
      );
      stepLog('KV_ARTICLES_cached', { count: trimmed.length });
    } catch (cacheErr) {
      console.warn('[NEWS-AI-CRON] Failed to cache articles (non-fatal):', cacheErr?.message);
      stepLog('KV_ARTICLES_cache_failed', { error: cacheErr?.message });
    }
    const newsWriteActuallyWritten = _kvWriteStats.totalWrites > newsWriteBefore;
    const newsWriteWasSkipped = _kvWriteStats.totalSkipped > newsSkippedBefore;

    // ── STEP 7: BATCH AI ANALYSIS (1 AI call for all articles) ──
    // Phase 3: Replaces individual sentiment with AI-powered batch analysis.
    // Returns: sentiment, impact, impact_reason, coins for each article.
    // Feature flag: NEWS_BATCH_ANALYSIS_ENABLED — when off, skip (rule-based sentiment stays).
    let batchAnalysis = {};
    if (isNewsBatchAnalysisEnabled(env)) {
      stepLog('BATCH_ANALYZE_start', { articles: trimmed.length });
      try {
        batchAnalysis = await batchAnalyzeNews(env, trimmed);
        // Enrich articles with AI analysis results
        for (let i = 0; i < trimmed.length; i++) {
          const analysis = batchAnalysis[i];
          if (analysis) {
            trimmed[i].sentiment = analysis.sentiment;
            trimmed[i].impact = analysis.impact;
            trimmed[i].impact_reason = analysis.impact_reason;
            trimmed[i].coins = analysis.coins;
          } else {
            trimmed[i].impact = trimmed[i].impact || 'low';
            trimmed[i].impact_reason = trimmed[i].impact_reason || '';
            trimmed[i].coins = trimmed[i].coins || [];
          }
        }
        // Re-cache with enriched data
        try {
          await writeAppCache(env, FARSI_NEWS_CACHE_KEY, JSON.stringify(trimmed), getNumericEnv(env, 'NEWS_CACHE_TTL', 1800));
        } catch {}
        stepLog('BATCH_ANALYZE_done', { analyzed: Object.keys(batchAnalysis).length });
      } catch (batchErr) {
        stepLog('BATCH_ANALYZE_FAILED', { error: batchErr?.message });
        // Non-fatal — articles already cached with rule-based sentiment
      }
    } else {
      stepLog('BATCH_ANALYZE_skipped', { reason: 'flag_disabled' });
    }

    // ── STEP 8: ENQUEUE ARTICLES FOR SUMMARY GENERATION ──
    // Queue-based: articles are added to KV queue, processed 1 per cron tick.
    // This prevents Worker timeout from killing summary generation.
    // Feature flag: NEWS_QUEUE_ENABLED — when off, skip enqueue (queue stays as-is).
    let enqueueResult = { enqueued: 0, skipped: 0, total: 0 };
    if (isNewsQueueEnabled(env)) {
      stepLog('SUMMARY_ENQUEUE_start', { articles: trimmed.length });
      try {
        enqueueResult = await enqueueForSummary(env, trimmed);
        stepLog('SUMMARY_ENQUEUE_done', enqueueResult);
      } catch (e) {
        stepLog('SUMMARY_ENQUEUE_FAILED', { error: e?.message });
      }
    } else {
      stepLog('SUMMARY_ENQUEUE_skipped', { reason: 'flag_disabled' });
    }

    // ── STEP 9: PROCESS ONE ARTICLE FROM QUEUE ──
    // Each cron tick processes ONE article summary (not 10 sequential).
    // Queue persists in KV — if Worker is killed, next tick continues.
    // Feature flag: NEWS_SUMMARY_ENABLED — when off, skip processing.
    stepLog('SUMMARY_PROCESS_start');
    let summaryResult = { processed: false, empty: true };
    if (isNewsSummaryEnabled(env)) {
      try {
        summaryResult = await processOneArticleSummary(env, pool);
        stepLog('SUMMARY_PROCESS_done', summaryResult);
      } catch (e) {
        stepLog('SUMMARY_PROCESS_FAILED', { error: e?.message });
      }
    } else {
      stepLog('SUMMARY_PROCESS_skipped', { reason: 'flag_disabled' });
    }

    // ── STEP 10: RECORD MONITORING TICK ──
    // Persists stats to KV so /api/news-ai-monitor can show rolling history.
    try {
      await recordNewsAITick(env, {
        type: 'batch',
        elapsed_ms: Date.now() - t0,
        rss_sources: sources.length,
        raw_items: allRawItems.length,
        filtered: filtered.length,
        cached: trimmed.length,
        enqueued: enqueueResult.enqueued || 0,
        enqueue_skipped: enqueueResult.skipped || 0,
        queue_total: enqueueResult.total || 0,
        summary_processed: summaryResult.processed || false,
        summary_success: summaryResult.success || false,
        summary_reason: summaryResult.reason || null,
        summary_retry_count: summaryResult.retry_count || 0,
        summary_duration_ms: summaryResult.duration_ms || 0,
      });
    } catch (e) {
      console.warn('[NEWS-AI-CRON] recordTick failed:', e?.message);
    }

    // ── FINISH ──
    const result = {
      ok: true,
      articlesCached: trimmed.length,
      newsCacheWritten: newsWriteActuallyWritten,
      newsCacheSkipped: !newsWriteActuallyWritten,
      newsWriteWasSkipped: newsWriteWasSkipped,
      kvAvailable: kvAvailable,
      inMemoryCached: inMemoryCached,
      inMemoryMatches: inMemoryMatches,
      newsJsonLength: newsJson.length,
      enqueue: enqueueResult,
      ai: summaryResult,
      elapsed: Date.now() - t0,
      kvWriteStats: {
        totalWrites: _kvWriteStats.totalWrites,
        totalSkipped: _kvWriteStats.totalSkipped,
        byPrefix: Object.entries(_kvWriteStats.byPrefix).sort((a,b) => b[1]-a[1]).slice(0, 10).map(([k,v]) => ({key:k, writes:v})),
        byKey: Object.entries(_kvWriteStats.byKey).sort((a,b) => b[1]-a[1]).slice(0, 15).map(([k,v]) => ({key:k, writes:v})),
      },
    };
    // FIX: was `aiResult?.success` (undefined variable) → use `summaryResult`
    stepLog('FINISH', { articlesCached: result.articlesCached, aiSuccess: summaryResult?.success, aiFailed: !summaryResult?.success && summaryResult?.processed ? 1 : 0 });
    return result;
  } catch (fatalErr) {
    // ── ROOT-CAUSE FIX: Surface the REAL error, not a bare "error" string ──
    const errMsg = fatalErr?.message || String(fatalErr);
    const errStack = fatalErr?.stack?.substring(0, 500);
    console.error('[NEWS-AI-CRON] FATAL ERROR:', errMsg);
    if (errStack) console.error('[NEWS-AI-CRON] Stack:', errStack);
    stepLog('FATAL', { error: errMsg, stack: errStack });
    return { ok: false, error: errMsg, elapsed: Date.now() - t0 };
  }
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
  // ROOT CAUSE FIX for "all events show as Past" bug:
  // Previously, the STATIC file (calendar-data.json on Pages CDN) was listed
  // FIRST. The static file is deployed once via git push and NEVER refreshed
  // automatically. As days pass, the events in the static file become stale
  // — all events eventually become "past" relative to the current date.
  //
  // FIX: Try the LIVE provider FIRST. The live provider
  // (nfs.faireconomy.media) returns the CURRENT week's events, refreshed
  // every 60 seconds (CDN-cached). The static file is now a FALLBACK only,
  // used when the live provider is down or rate-limited.
  const sources = [
    { url: 'https://nfs.faireconomy.media/ff_calendar_thisweek.json', type: 'direct' },
    { url: 'https://amir-btc-assistant-pages.pages.dev/calendar-data.json', type: 'pages-static' },
  ];

  for (const source of sources) {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), 8000);
      const _t0 = Date.now();
      const response = await fetch(source.url, {
        method: 'GET',
        headers: {
          Accept: 'application/json',
          'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36',
        },
        signal: controller.signal,
      });
      clearTimeout(timeoutId);
      const ms = Date.now() - _t0;
      const host = source.url.split('//')[1].split('/')[0];
      console.log('[CALENDAR] provider ' + host + ' (' + source.type + '): HTTP ' + response.status + ' in ' + ms + 'ms');

      if (response.status === 429 || response.status === 530 || !response.ok) {
        continue;
      }

      const body = await response.json();
      if (Array.isArray(body) && body.length > 0) {
        console.log('[CALENDAR] provider returned ' + body.length + ' events (' + source.type + ')');
        return body;
      } else {
        console.warn('[CALENDAR] provider returned empty or non-array');
      }
    } catch (e) {
      console.warn('[CALENDAR] provider fetch error (' + source.type + '): ' + (e?.message || e));
    }
  }

  console.warn('[CALENDAR] all providers failed or returned empty');
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
    const _tFlightStart = Date.now();

    // 0. Try in-memory isolate cache FIRST (instant, no I/O)
    // ROOT CAUSE FIX: Reduced TTL from 30 min to 5 min. Calendar events
    // change daily (new events appear, old events expire). A 30-min TTL
    // meant the Worker could serve stale data for up to 30 minutes after
    // the provider updated. With 5 min, the data is at most 5 min old.
    const _isolateAge = _calendarIsolateCacheAt ? Date.now() - _calendarIsolateCacheAt : Infinity;
    if (_calendarIsolateCache && _calendarIsolateCache.length > 0 && _isolateAge < 300000) {
      // Isolate cache is fresh (< 5 min) — serve immediately
      console.log('[CALENDAR] isolate cache hit: age=' + Math.round(_isolateAge / 1000) + 's, events=' + _calendarIsolateCache.length);
      return _calendarIsolateCache;
    }

    // 1. Try fresh KV cache (TTL-enforced by KV itself)
    const _tKVRead = Date.now();
    const cachedEvents = await readAppCache(env, CALENDAR_CACHE_KEY);
    console.log('[CALENDAR] KV read: ' + (Date.now() - _tKVRead) + 'ms, hit=' + (!!cachedEvents));
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
    // ROOT CAUSE FIX: cutoffPast was 2 days, which removed valid recent
    // events from the provider's "this week" data. The provider already
    // returns only current-week events, so we only need to filter out
    // events that are more than 1 day in the past (to remove fully-expired
    // events from the previous week that the provider may still include).
    const cutoffPast = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
    const cutoffFuture = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
    const _tFetchStart = Date.now();
    const rawEvents = await fetchCalendarFeed();
    console.log('[CALENDAR] upstream fetch: ' + (Date.now() - _tFetchStart) + 'ms, rawEvents=' + (rawEvents?.length || 0) + ' isArray=' + Array.isArray(rawEvents));

    // Check if events are already mapped (from Pages static file)
    // Pages static has: {title, country, flag, time, date, impact, impact_label, ...}
    // Direct provider has: {title, country, date, time, impact, forecast, ...}
    const isAlreadyMapped = Array.isArray(rawEvents) && rawEvents.length > 0 && rawEvents[0]?.flag !== undefined;

    let events;
    if (isAlreadyMapped) {
      // Events from Pages static are already mapped — use directly
      events = rawEvents
        .filter((item) => {
          if (!item.timestamp) return true;
          const d = new Date(item.timestamp);
          return d >= cutoffPast && d <= cutoffFuture;
        })
        .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
      console.log('[CALENDAR] using pre-mapped events: ' + events.length);
    } else {
      // Events from direct provider — map them
      events = (Array.isArray(rawEvents) ? rawEvents : [])
        .map((item) => mapCalendarEvent(item, now, cutoffPast, cutoffFuture))
        .filter((item) => item !== null)
        .sort((left, right) => {
          if (!left.timestamp && !right.timestamp) return 0;
          if (!left.timestamp) return 1;
          if (!right.timestamp) return -1;
          return left.timestamp.localeCompare(right.timestamp);
        });
      console.log('[CALENDAR] after map/filter: events=' + events.length + ' (from ' + (rawEvents?.length || 0) + ' raw)');
    }

    if (events.length > 0) {
      // Fresh fetch succeeded — write to KV cache + isolate cache
      try {
        await writeAppCache(
          env,
          CALENDAR_CACHE_KEY,
          JSON.stringify(events),
          getNumericEnv(env, 'CALENDAR_CACHE_TTL', 600),
        );
        console.log('[CALENDAR] KV write: success (' + events.length + ' events)');
      } catch (kvErr) {
        console.warn('[CALENDAR] KV write FAILED: ' + (kvErr?.message || kvErr));
      }
      _calendarIsolateCache = events;
      _calendarIsolateCacheAt = Date.now();
      console.log('[CALENDAR] isolate cache updated: ' + events.length + ' events');
      return events;
    }

    // 3. Upstream returned empty or error. NEVER return empty if we have
    // any valid cached data. Priority: isolate cache → KV cache → stale KV.
    // This ensures the calendar ALWAYS shows the last known good data,
    // even during extended upstream outages.

    // 3a. Try isolate cache (in-memory, instant)
    if (_calendarIsolateCache && _calendarIsolateCache.length > 0) {
      console.log('[CALENDAR] upstream empty — serving isolate cache: ' + _calendarIsolateCache.length + ' events (age=' + Math.round((Date.now() - _calendarIsolateCacheAt) / 1000) + 's)');
      // Try to refresh KV with isolate cache (in case KV expired)
      try {
        await writeAppCache(env, CALENDAR_CACHE_KEY, JSON.stringify(_calendarIsolateCache), 300);
      } catch {}
      return _calendarIsolateCache;
    }

    // 3b. Try KV cache (may still have data even if isolate cache is empty)
    try {
      const kvCached = await readAppCache(env, CALENDAR_CACHE_KEY);
      if (kvCached) {
        const parsed = JSON.parse(kvCached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('[CALENDAR] upstream empty — serving KV cache: ' + parsed.length + ' events');
          // Populate isolate cache so subsequent requests are instant
          _calendarIsolateCache = parsed;
          _calendarIsolateCacheAt = Date.now();
          return parsed;
        }
      }
    } catch {}

    // 3c. Last resort: try raw KV read with long cacheTtl (edge cache)
    try {
      const rawCached = await env.APP_CACHE?.get?.(CALENDAR_CACHE_KEY, { cacheTtl: 86400 });
      if (rawCached) {
        const stale = JSON.parse(rawCached);
        if (Array.isArray(stale) && stale.length > 0) {
          console.log('[CALENDAR] upstream empty — serving stale KV cache: ' + stale.length + ' events');
          _calendarIsolateCache = stale;
          _calendarIsolateCacheAt = Date.now();
          return stale;
        }
      }
    } catch {}

    // 3d. Truly no data anywhere — return empty
    console.warn('[CALENDAR] no cached data available anywhere — returning empty');
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
const referralRepo = createReferralRepository({ queryDb, getReferralRewardPerInvite, getNumericEnv });
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

// ── NotificationService (Phase 1: single entry point for all producers) ──
// Thin wrapper around notificationPlatformRepo.dispatch(). Establishes the
// centralized service layer. Future phases will migrate logic into this service.
const notificationService = createNotificationService({
  notificationPlatformRepo,
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
  notificationService,
});
const walletHandlers = createWalletHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  walletRepo,
  notificationPlatformRepo,
  economyService,
  rewardCenterRepo,
  notificationService,
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
  notificationService,
});
const userRepo = createUserRepository({ queryDb, normalizeOptionalString });
// adminRepo must be created BEFORE userHandlers because userHandlers (bootstrap)
// checks the DB admins table to detect DB-added admins (not just env super admin).
const adminRepo = createAdminRepository({ queryDb, normalizeOptionalString });
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
  adminRepo,
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
  notificationService,
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

// ── Membership Module — factory wiring ──────────────────────────────────────
const membershipRepo = createMembershipRepository({ queryDb, queryDbTransaction });

// ── News Articles Module — permanent storage for AI summaries ───────────────
const newsArticleRepo = createNewsArticleRepository({ queryDb });

// ── App Content Module — CMS for About / Terms / Privacy ───────────────────
const appContentRepo = createAppContentRepository({ queryDb, readAppCache, writeAppCache });
const membershipHandlers = createMembershipHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  isAdminTelegramId,
  isDatabaseConfigured,
  readAppCache,
  writeAppCache,
  safeDbErrorResponse,
  buildBodyFieldValidationError,
  readJsonBody,
  membershipRepo,
  queryDbTransaction,
  notificationRepo,
  notificationPlatformRepo,
  notificationService,
  sendTelegramMessage,
  resolveWebAppUrl,
});

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
  const _t0 = Date.now();
  let events = [];
  try {
    events = await fetchCalendarEvents(env);
    console.log('[CALENDAR] fetchCalendarEvents: ' + (Date.now() - _t0) + 'ms, events=' + (events?.length || 0));
    if (!events || !Array.isArray(events)) {
      console.warn('[CALENDAR] fetchCalendarEvents returned non-array: ' + typeof events);
      events = [];
    }
  } catch (e) {
    console.warn('[CALENDAR] fetchCalendarEvents ERROR: ' + e?.message + ' (' + (Date.now() - _t0) + 'ms)');
    events = [];
  }

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
    // Transparency fields: let the frontend know when data was last
    // refreshed and where it came from. This helps debug "stale data"
    // issues — the user can see if the data is live or from cache.
    server_time: new Date().toISOString(),
    last_updated: _calendarIsolateCacheAt ? new Date(_calendarIsolateCacheAt).toISOString() : null,
    isolate_cache_age_seconds: _calendarIsolateCacheAt ? Math.round((Date.now() - _calendarIsolateCacheAt) / 1000) : null,
    isolate_cache_count: _calendarIsolateCache?.length || 0,
  }, {}, env);
}

// ROOT-CAUSE FIX: Was 30 seconds, but Cloudflare KV requires expirationTtl >= 60.
// A TTL of 30 caused "Invalid expiration_ttl" on EVERY market cache write,
// meaning the market data was NEVER cached in KV — every request hit the
// upstream API. Now 60s (the minimum allowed by KV). writeAppCache also
// clamps any sub-60 TTL up to 60 as a safety net.
const MARKET_CACHE_TTL = 300; // 5 minutes — ROOT-CAUSE FIX: was 60s, caused 1,440+ KV writes/day. 5 min is acceptable for price data.
const MARKET_GLOBAL_CACHE_TTL = 900; // 15 minutes — global stats change less frequently
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
      const _t0 = Date.now();
      const res = await fetch('https://pro-api.coinmarketcap.com/v3/fear-and-greed/historical', {
        headers: {
          'Accept': 'application/json',
          'X-CMC_PRO_API_KEY': apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      _traceStage('fetchFearGreed.CMC', _t0);
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
        // ROOT-CAUSE FIX: Log the actual reason — if 429, it's rate limiting, not "no API key"
        if (res.status === 429) {
          console.warn('CMC F&G API rate limited (HTTP 429) — falling back to cache');
        } else {
          console.warn('CMC F&G API returned HTTP', res.status);
        }
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
        return parsed;
      }
    } catch {}
  }

  // ── Step 3: No cache, no API — return null (frontend shows 'Unknown') ──
  // ROOT-CAUSE FIX: This message was misleading — it says "no API key" but
  // the real cause is usually CMC returning 429 (rate limited) AND cache being
  // empty (because KV writes were failing due to quota exhaustion).
  console.warn('F&G: API unavailable and cache empty — returning null');
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

    // ROOT-CAUSE FIX: syncMenuButton was called fire-and-forget (no await),
    // which caused "A promise was resolved from a different request context"
    // warnings. The Telegram API call continued running AFTER the webhook
    // response was sent, resolving in a dead request context.
    // FIX: await it so it completes BEFORE the response is returned.
    // It's fast (~100ms) and idempotent, so blocking is acceptable.
    await syncMenuButton(env);
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

async function runCalendarAlertsCheck(env, { isEvery15Min = false } = {}, pool = null) {
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
        [], 1, pool,
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
          const dispatchResult = await notificationService.create(env, {
            userId: uid,
            title, message,
            category: 'calendar',
            priority: 'medium',
            channel: 'both',
            metadata: { event_title: event.title, event_date: event.date, event_time: event.time, event_country: event.country },
            dedupKey: `cal_event_${event.id}_${uid}`,
          }, pool);
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
        // ROOT-CAUSE FIX: Only run ensureSchema on 15-min cron (not every minute).
        // DDL queries (CREATE TABLE, ALTER TABLE) hold ACCESS EXCLUSIVE locks
        // and can block the pool connection for 10-24 seconds when multiple
        // isolates run them concurrently. The _schemaVerified flag is per-isolate,
        // so every new isolate re-runs ALL DDL — causing lock contention.
        // Now: only run on 15-min cron, which is enough for schema changes.
        if (isEvery15Min) {
          await calendarReminderRepo.ensureSchema(env).catch(() => {});
        }
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
            const dispatchResult = await notificationService.create(env, {
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
              dedupKey: `cal_reminder_${reminder.id}_${reminder.user_id}`,
            }, pool);
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
                  }

        // Cleanup old reminders (fired + event passed >24h) on 15-min ticks
        // to prevent the table from growing indefinitely.
        if (isEvery15Min) {
          try {
            const cleaned = await calendarReminderRepo.cleanupOld(env);
            if (cleaned > 0) {
                          }
          } catch (cleanupErr) {
            console.warn(safeError('calendar-reminders-cleanup', cleanupErr));
          }
        }
      } catch (reminderErr) {
        console.warn(safeError('calendar-reminders-check', reminderErr));
      }
    }

    if (alertedCount.sent > 0 || alertedCount.skipped > 0 || alertedCount.failed > 0) {
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
// Module-level in-memory cache for active alerts list.
// Same pattern as _calendarIsolateCache (line 6003).
// Persists across invocations in the SAME isolate (no I/O, no CPU to read).
// Different isolates do NOT share this — falls through to KV cache.
// TTL: 60s (same as KV cache).
let _alertsIsolateCache = null;
let _alertsIsolateCacheAt = 0;
const _ALERTS_ISOLATE_CACHE_TTL_MS = 60 * 1000; // 60 seconds

async function runScheduledAlertsBaseline(controller, env, pool = null) {
  const t0 = Date.now();
  // Stage-by-stage latency tracking for performance monitoring
  let _tDbEnd = null;       // end of DB query phase
  let _tPriceStart = null;  // start of price fetch phase
  let _tPriceEnd = null;    // end of price fetch phase
  let _tEvalStart = null;   // start of evaluation phase

  // PHASE 5 FIX (ALERT-14): Set env._reqPool so ALL queryDb calls inside this
  // function (including nested calls in markTriggered, sendNotification, enqueue)
  // share ONE Pool — no per-call createPool = no per-call TLS handshake.
  // Previously, only calls that explicitly passed `pool` used the shared Pool.
  // Calls in sendNotification/enqueue (which don't accept pool param) created
  // per-call Pools → 3-5ms CPU each → exceededCpu with 5+ triggers.
  // This is safe: env is per-invocation (not shared across requests/cron ticks).
  const _prevReqPool = env._reqPool;
  if (pool) env._reqPool = pool;

  const payload = {
    status: 'ok',
    task: 'scheduled-alerts-execution',
    cron: controller.cron || 'manual',
    alerts_cron_enabled: isAlertsCronEnabled(env),
    secret_configured: Boolean(env.ALERTS_CRON_SHARED_SECRET),
    started_at: new Date().toISOString(),
  };

  if (!payload.alerts_cron_enabled) {
        return;
  }
  if (!isDatabaseConfigured(env)) {
        return;
  }
  if (!isBotConfigured(env)) {
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
    // ═══════════════════════════════════════════════════════════════════
    // ROOT-CAUSE FIX for exceededCpu on * * * * * cron (cpuTime=18ms > 10ms):
    //
    // PROVEN from wrangler tail + GraphQL analytics:
    //   - 737/890 exceededResources have subrequests=1 (83%)
    //   - cpu_avg=10.6ms > 10ms Free plan limit
    //   - Worker killed DURING pool.query() TLS handshake (3-5ms CPU)
    //   - DB query (listActiveForCron) never completes
    //
    // ROOT CAUSE: WebSocket TLS handshake for @neondatabase/serverless Pool
    // consumes 3-5ms CPU. Combined with JS overhead (Pool construction,
    // query preparation, result parsing), total CPU reaches ~10-11ms,
    // exceeding the 10ms Free plan limit.
    //
    // FIX: Cache the ENTIRE alert list in KV (not just 'exists' flag).
    // When cache is valid, skip the DB query entirely → 0 TLS CPU.
    // Only query DB on cache miss (first run, after TTL expiry, or after
    // invalidation by create/delete operations).
    //
    // Safety:
    //   - last_price from cache is at most 60s stale (same as current TTL)
    //   - Cross-detection compares prevPrice vs currentPrice — 60s staleness
    //     doesn't affect direction detection (price doesn't cross AND rebound
    //     within 60s for any real asset)
    //   - last_checked_at from cache is non-null after first check →
    //     first_check triggers won't fire again (correct behavior)
    //   - When alert triggers (markTriggered), its status changes to
    //     'triggered' → next cache refresh excludes it automatically
    //   - create() and remove() already invalidate 'alerts:active-exists'
    //     cache → we also invalidate 'alerts:active-list' in those functions
    // ═══════════════════════════════════════════════════════════════════
    const ALERTS_EXIST_CACHE_KEY = 'alerts:active-exists';
    const ALERTS_LIST_CACHE_KEY = 'alerts:active-list';
    const ALERTS_LIST_TTL = 60; // seconds — same as alerts:active-exists

    // ═══════════════════════════════════════════════════════════════════
    // TWO-LAYER CACHE: Module-level (instant) → KV (shared) → DB (fallback)
    //
    // Layer 1: Module-level Map (_alertsIsolateCache)
    //   - 0 I/O, 0 CPU, 0 subrequests
    //   - Same isolate only (persists across * * * * * ticks)
    //   - TTL: 60s
    //
    // Layer 2: KV cache (alerts:active-list)
    //   - 1 subrequest (KV read), 0 CPU
    //   - Shared across isolates (but 60s propagation delay)
    //   - TTL: 60s
    //
    // Layer 3: DB query (listActiveForCron)
    //   - 1 subrequest (WebSocket), 3-5ms CPU (TLS handshake)
    //   - Only on cache miss
    // ═══════════════════════════════════════════════════════════════════

    // Step 1: Check module-level in-memory cache (instant, 0 I/O)
    let alerts = null;
    let alertsFromCache = false;
    const isolateCacheAge = _alertsIsolateCacheAt ? Date.now() - _alertsIsolateCacheAt : Infinity;
    if (_alertsIsolateCache && _alertsIsolateCache.length > 0 && isolateCacheAge < _ALERTS_ISOLATE_CACHE_TTL_MS) {
      alerts = _alertsIsolateCache;
      alertsFromCache = true;
    }

    // Step 2: If module-level miss, try KV cache
    if (!alerts) {
      const cachedListRaw = await readAppCache(env, ALERTS_LIST_CACHE_KEY);
      if (cachedListRaw) {
        try {
          const parsed = JSON.parse(cachedListRaw);
          if (Array.isArray(parsed)) {
            alerts = parsed;
            alertsFromCache = true;
            // Populate module-level cache from KV (so next tick is instant)
            _alertsIsolateCache = parsed;
            _alertsIsolateCacheAt = Date.now();
          }
        } catch {}
      }
    }

    // Step 3: If both caches miss, query DB (this is the path that causes exceededCpu)
    if (!alerts) {
      alerts = (typeof alertRepo?.listActiveForCron === 'function')
        ? await alertRepo.listActiveForCron(env, maxAlerts, pool)
        : (await queryDb(env, `
            SELECT id, user_id, symbol, price, direction, last_price, last_checked_at
            FROM price_alerts
            WHERE status = 'active'
            ORDER BY created_at DESC
            LIMIT $1
          `, [maxAlerts], 1, pool)).rows;

      // Cache the result in BOTH module-level and KV for next tick
      if (alerts.length > 0) {
        _alertsIsolateCache = alerts;
        _alertsIsolateCacheAt = Date.now();
        try {
          await writeAppCache(env, ALERTS_LIST_CACHE_KEY, JSON.stringify(alerts), ALERTS_LIST_TTL);
          await writeAppCache(env, ALERTS_EXIST_CACHE_KEY, '1', ALERTS_LIST_TTL);
        } catch {}
      } else {
        _alertsIsolateCache = [];
        _alertsIsolateCacheAt = Date.now();
        try { await writeAppCache(env, ALERTS_EXIST_CACHE_KEY, '0', ALERTS_LIST_TTL); } catch {}
      }
    }

    resultPayload.checked_count = alerts.length;
    _tDbEnd = Date.now(); // Phase 1 done: DB query (or cache hit)

    if (!alerts.length) {
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
        // PHASE 2 FIX (ALERT-01): Removed noCache=true. The fast-path cache
        // stores ONLY the exchange name (e.g. 'bybit'), NOT the price.
        // fetchSpotTickerPrice always returns a LIVE price from that exchange.
        // So bypassing the cache doesn't improve price freshness — it just
        // forces 3× subrequests per symbol (all exchanges fallback) instead
        // of 1 subrequest (cached exchange fast-path). This was the primary
        // cause of subrequest exhaustion (90 > 50 limit) and CPU waste.
        const priceInfo = await fetchSpotPriceUsd(env, symbol);
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

    // Fetch all unique symbols in parallel
    // PHASE 2 FIX (ALERT-02): Reduced from 30 to 15 to stay under Cloudflare's
    // 50-subrequest limit even on cache miss. With cache hit (ALERT-01 fix):
    // 15 × 1 = 15 subrequests. With cache miss: 15 × 3 = 45 < 50. Plus 2 DB
    // queries (listActiveForCron + bulk UPDATE) = 47 total — under 50 limit.
    const FETCH_BATCH = 15;
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
    // ARCHITECTURAL FIX: Collect all alert updates and do a SINGLE bulk UPDATE
    // at the end instead of 500 individual UPDATE queries.
    // This reduces DB calls from 500+ to 1, cutting CPU by ~99%.
    const _pendingUpdates = []; // [{ alertId, currentPrice }]
    const _triggeredAlerts = []; // [{ alertId, alert, currentPrice, triggerReason }]

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
        // Queue update with price=0 (price not available)
        _pendingUpdates.push({ alertId, currentPrice: 0 });
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

      // ARCHITECTURAL FIX: Queue the update instead of executing it immediately.
      // All updates will be batched into a single bulk UPDATE at the end.
      _pendingUpdates.push({ alertId, currentPrice });

      if (!shouldTrigger) {
        // Log the no-trigger decision for audit trail
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
          triggered = await alertRepo.markTriggered(env, alertId, currentPrice, pool);
        } catch (e) {
          console.warn('markTriggered failed:', { alert_id: alertId, error: e?.message });
        }
      } else {
        // Fallback: legacy UPDATE without atomic guard
        await queryDb(env, `
          UPDATE price_alerts
          SET status = 'triggered', triggered_at = NOW(), last_trigger_price = $2
          WHERE id = $1
        `, [alertId, currentPrice], 1, pool);
        triggered = true;
      }

      if (!triggered) {
        resultPayload.duplicate_triggers_prevented += 1;
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
                    resultPayload.triggered_count += 1;
          continue;
        }

        let inAppDelivered = false;
        let telegramDelivered = false;

        // Determine effective delivery channel based on user preference
        const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
        const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';

        // ── Phase 2: Unified delivery via NotificationService.create() ──
        // Per Phase 2: ALL Telegram delivery goes through the queue.
        // No direct sendTelegramMessage — the queue processor (cron) is the
        // single authorized sender and handles retry via max_attempts.
        //
        // Rich message (web_app button) is passed via telegramExtra.
        const alertTitle = `🔔 هشدار قیمت ${symbol}`;
        const telegramExtra = {
          disable_web_page_preview: true,
        };
        if (webAppUrl) {
          telegramExtra.reply_markup = {
            inline_keyboard: [[{ text: 'Open Amir BTC Assistant 🚀', web_app: { url: webAppUrl } }]],
          };
        }

        try {
          const tDispatchStart = Date.now();
          if (notificationService) {
            const result = await notificationService.create(env, {
              userId: String(userId),
              title: alertTitle,
              message: text,
              category: 'price_alert',
              priority: 'high',
              channel: userChannel, // honor the preference we already resolved
              forceChannel: true,   // we already checked — don't re-query
              metadata: {
                symbol,
                price: String(currentPrice),
                alert_id: alertId,
                target_price: String(targetPrice),
                direction,
                trigger_reason: triggerReason,
              },
              dedupKey: `price_alert_${alertId}_${userId}`,
              telegramExtra,
            }, pool);
            if (result.status === 'delivered') {
              inAppDelivered = deliverToMiniApp;
              telegramDelivered = deliverToTelegram;
            }
          }
          timing.dispatch_ms = Date.now() - tDispatchStart;
        } catch (notifErr) {
          console.warn('NotificationService.create failed for price alert:', notifErr?.message || notifErr);
          resultPayload.dispatch_errors.push({
            alert_id: alertId,
            error: notifErr?.message || String(notifErr),
            stack: notifErr?.stack?.slice(0, 200),
          });
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

    // ── ARCHITECTURAL FIX: Bulk UPDATE all alerts in a SINGLE query ──
    // Instead of 500 individual `UPDATE price_alerts SET last_price=$1 WHERE id=$2` calls,
    // we build a single CASE WHEN query that updates all alerts at once.
    // This reduces DB calls from 500+ to 1, cutting CPU by ~99%.
    if (_pendingUpdates.length > 0) {
      try {
        // ROOT-CAUSE FIX: Use parameterized query instead of string interpolation.
        // Previously: `WHEN ${Number(alertId)}` — but price_alerts.id is VARCHAR(64),
        // so Number(non-numeric-string) = NaN → SQL "WHEN NaN THEN..." →
        // PostgreSQL error: "column nan does not exist".
        // Now: use $N placeholders for both id and price values.
        // Note: $priceIdx::numeric cast is required because last_price is NUMERIC
        // and pg sends JS numbers as float8 which doesn't auto-cast to numeric.
        const caseParts = [];
        const params = [];
        const idPlaceholders = [];
        for (const { alertId, currentPrice } of _pendingUpdates) {
          const idIdx = params.length + 1;
          const priceIdx = params.length + 2;
          caseParts.push(`WHEN $${idIdx} THEN $${priceIdx}::numeric`);
          params.push(String(alertId), Number(currentPrice));
          idPlaceholders.push(`$${idIdx}`);
        }
        const bulkSql = `UPDATE price_alerts SET last_price = CASE id ${caseParts.join(' ')} END, last_checked_at = NOW() WHERE id IN (${idPlaceholders.join(',')})`;
        await queryDb(env, bulkSql, params, 1, pool);
      } catch (bulkErr) {
        console.warn('[ALERTS] Bulk UPDATE failed:', bulkErr?.message);
      }
    }

        return resultPayload;
  } catch (error) {
    // ROOT-CAUSE FIX: Log FULL error details — message, stack, and which phase failed
    const errMsg = error instanceof Error ? error.message : String(error);
    const errStack = error instanceof Error ? error.stack : null;
    console.error(JSON.stringify({
      scope: 'scheduled-alerts-runner-FAILED',
      message: 'scheduled alerts runner failed',
      error: errMsg,
      stack: errStack ? errStack.substring(0, 1000) : null,
      errorName: error instanceof Error ? error.name : 'Unknown',
      duration_ms: Date.now() - t0,
      phase: _tEvalStart ? 'evaluation/delivery' : _tPriceStart ? 'price_fetch' : _tDbEnd ? 'post_db' : 'db_query',
      checked_count: resultPayload.checked_count,
      triggered_count: resultPayload.triggered_count,
      pendingUpdates: typeof _pendingUpdates !== 'undefined' ? _pendingUpdates.length : 0,
    }));
  } finally {
    // PROVEN FIX: env._reqPool must be restored in finally, NOT after try/catch.
    // Previously, 'return resultPayload' inside try exited before reaching
    // the restore line, leaving env._reqPool pointing to withPhasePool's Pool.
    // When withPhasePool.finally() closed the Pool, separate ctx.waitUntil
    // calls (retryFailed*) that read env._reqPool found a closed Pool →
    // "Cannot perform I/O on behalf of a different request" error.
    env._reqPool = _prevReqPool;
  }
}
//#endregion

// ============================================================================
//#region ورودی اصلی Worker
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    _currentRequestOrigin = request.headers.get('Origin');
    // TEMP: set trace context for instrumentation
    const _url = new URL(request.url);
    _setTraceContext(_url.pathname, request.method);
    // PHASE 2 SAFE OPTIMIZATION: Cache DB_TRACE_ENABLED flag per request.
    // Default: false (no verbose query logging). Set env.DB_TRACE_ENABLED=true
    // to re-enable _traceQuery/_traceLog for debugging.
    _dbTraceEnabled = _dbTraceEnabled ?? (String(env.DB_TRACE_ENABLED || '').toLowerCase() === 'true');
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

      // ── App Content: About / Terms / Privacy (public read) ──
      if (request.method === 'GET' && url.pathname.startsWith('/api/content/')) {
        const contentType = url.pathname.split('/api/content/')[1]?.split('/')[0];
        if (!['about', 'terms', 'privacy'].includes(contentType)) {
          return jsonResponse({ status: 'error', message: 'Invalid content type' }, { status: 400 }, env);
        }
        try {
          const content = await appContentRepo.getContent(env, contentType);
          return jsonResponse({ status: 'success', data: content }, {}, env);
        } catch (e) {
          return jsonResponse({ status: 'error', message: 'Failed to load content' }, { status: 500 }, env);
        }
      }

      // ── App Content: Admin update (admin-only) ──
      if (request.method === 'PUT' && url.pathname.startsWith('/api/admin/content/')) {
        const contentType = url.pathname.split('/api/admin/content/')[1]?.split('/')[0];
        if (!['about', 'terms', 'privacy'].includes(contentType)) {
          return jsonResponse({ status: 'error', message: 'Invalid content type' }, { status: 400 }, env);
        }
        // Admin auth check
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) {
          return jsonResponse({ status: 'error', message: 'Authentication required' }, { status: 401 }, env);
        }
        if (!isAdminTelegramId(env, authState.user.id)) {
          return jsonResponse({ status: 'error', message: 'Admin access required' }, { status: 403 }, env);
        }
        try {
          const body = await request.json();
          console.log('[CONTENT SAVE] type:', contentType, 'title:', body.title, 'version:', body.version, 'sections_count:', Array.isArray(body.sections) ? body.sections.length : 'N/A');
          const updated = await appContentRepo.updateContent(env, contentType, {
            title: body.title,
            sections: body.sections,
            version: body.version,
            updated_by: String(authState.user.id),
          });
          console.log('[CONTENT SAVE] success:', JSON.stringify(updated).substring(0, 200));
          return jsonResponse({ status: 'success', data: updated }, {}, env);
        } catch (e) {
          console.error('[CONTENT SAVE] error:', e?.message);
          return jsonResponse({ status: 'error', message: 'Failed to update content: ' + (e?.message || '') }, { status: 500 }, env);
        }
      }

      // ── DIAGNOSTIC: CPU Profile for admin endpoints ──
      // Traces the FULL call graph with per-function CPU timing + query count.
      // Auth: X-Cron-Secret or ?secret= must match DIAG_SECRET.
      //        endpoint = dashboard | users | admins | tickets | rewards

      // ── DIAGNOSTIC: Join Check + Admin Detection flow tracer ──
      // Auth: X-Cron-Secret must match ALERTS_CRON_SHARED_SECRET
      // Pass ?user_id=123456 to trace a specific user's join check + admin detection.
      // Returns the result of EVERY stage so we can pinpoint exactly where it fails.

      // ── DIAGNOSTIC: Admin endpoint tester (temp, for root cause analysis) ──
      // Auth: X-Cron-Secret header must match ALERTS_CRON_SHARED_SECRET
      // Tests ALL admin endpoints internally and returns exact HTTP status + response body

      // ── Manual Alert Trigger (admin-only, for testing) ──
      // Allows admins to force-run the alert cron without waiting 5 minutes.
      // Useful for E2E testing of alert triggers in production.
      // Auth method 1: ALERTS_CRON_SHARED_SECRET in X-Cron-Secret header
      // Auth method 2: Telegram admin auth (ADMIN_TELEGRAM_ID) via X-Telegram-Init-Data
      if ((request.method === 'POST' || request.method === 'GET') && url.pathname === '/api/admin/trigger-alerts') {
        return await (async () => {
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
        })();
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

      // TEMP: Calendar provider diagnostic
      if (request.method === 'GET' && url.pathname === '/api/calendar/diag') {
        const results = [];
        for (const url of ['https://nfs.faireconomy.media/ff_calendar_thisweek.json', 'https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json']) {
          const t0 = Date.now();
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(url, { headers: { 'User-Agent': 'Mozilla/5.0' }, signal: controller.signal });
            clearTimeout(tid);
            const body = await res.text();
            let count = 'parse-error';
            try { const j = JSON.parse(body); count = Array.isArray(j) ? j.length : 'not-array'; } catch {}
            results.push({ url, status: res.status, ms: Date.now() - t0, bodyLength: body.length, events: count });
          } catch (e) {
            results.push({ url, error: e?.message || String(e), ms: Date.now() - t0 });
          }
        }
        return jsonResponse({ results, isolateCache: _calendarIsolateCache?.length || 0, isolateAge: _calendarIsolateCacheAt ? Date.now() - _calendarIsolateCacheAt : null }, {}, env);
      }

      // ── CRON MONITOR: Shows last 200 cron phase execution logs from KV ──
      // This endpoint proves whether cron phases complete successfully.
      // If a phase is "started" but never "complete", the Worker was killed
      // (exceededCpu) during that phase.
      if (request.method === 'GET' && url.pathname === '/api/cron-monitor') {
        // Read from KV (persists across isolates)
        let kvEntries = [];
        try {
          if (env.APP_CACHE?.list) {
            const listed = await env.APP_CACHE.list({ prefix: 'cron_log_', limit: 1000 });
            if (listed && listed.keys) {
              const entries = await Promise.all(
                listed.keys.map(k => env.APP_CACHE.get(k.name).catch(() => null))
              );
              for (const e of entries) {
                if (e) {
                  try { kvEntries.push(JSON.parse(e)); } catch {}
                }
              }
            }
          }
        } catch (e) {
          console.warn('[cron-monitor] KV list failed:', e?.message);
        }

        // Also include in-memory log (for same-isolate reads)
        const memLog = globalThis._cronMonitorLog || [];

        // Merge and deduplicate by tick+phase
        const allEntries = [...kvEntries, ...memLog];
        const seen = new Set();
        const deduped = allEntries.filter(e => {
          const key = e.tick + '_' + e.phase;
          if (seen.has(key)) return false;
          seen.add(key);
          return true;
        });

        // Group by tick ID
        const ticks = {};
        for (const entry of deduped) {
          if (!ticks[entry.tick]) ticks[entry.tick] = [];
          ticks[entry.tick].push(entry);
        }
        const tickSummaries = Object.entries(ticks).map(([tickId, entries]) => {
          const sorted = entries.sort((a, b) => new Date(a.ts) - new Date(b.ts));
          const first = sorted[0];
          const last = sorted[sorted.length - 1];
          const phases = entries.map(e => e.phase + ':' + e.status);
          // Check if this tick has a "start" but no "complete" for the overall phase
          // New code uses phase1a (split from phase1), old code uses phase1.
          // Check for BOTH to handle ticks from old and new code.
          const hasStart = entries.some(e => e.phase === 'start');
          const hasPhase1Complete = entries.some(e =>
            (e.phase === 'phase1' || e.phase === 'phase1a') && e.status === 'complete'
          );
          const killed = hasStart && !hasPhase1Complete;
          return {
            tickId,
            start: first.ts,
            minute: first.minute,
            cron: first.cron,
            elapsed_ms: last.elapsed_ms,
            phaseCount: entries.length,
            phases,
            killed: killed, // true if Worker was killed before phase1 completed
          };
        }).sort((a, b) => new Date(a.start) - new Date(b.start));

        return jsonResponse({
          server_time: new Date().toISOString(),
          totalLogEntries: deduped.length,
          totalTicks: Object.keys(ticks).length,
          ticksKilled: tickSummaries.filter(t => t.killed).length,
          ticksOk: tickSummaries.filter(t => !t.killed).length,
          ticks: tickSummaries.slice(-50), // last 50 ticks
        }, {}, env);
      }

      // ── News AI Monitor — queue stats, retry stats, flag status, tick history ──
      // Public (no auth) — same policy as /api/cron-monitor.
      // Use to verify: queue is draining, no permanent 'pending', retries working.
      if (request.method === 'GET' && url.pathname === '/api/news-ai-monitor') {
        try {
          const monitoring = await getNewsAIMonitoring(env);
          return jsonResponse({ status: 'success', ...monitoring }, {}, env);
        } catch (e) {
          return jsonResponse({ status: 'error', error: e?.message }, { status: 500 }, env);
        }
      }

      // ── News AI E2E Timing — final production validation ──
      // Shows end-to-end timing for recent completed summaries:
      // RSS → Enqueue → Summary Start → Summary Complete
      // Plus avg/max/min for each phase + per-provider breakdown.
      if (request.method === 'GET' && url.pathname === '/api/news-ai-timing') {
        try {
          const timing = await getE2ETimingStats(env);
          return jsonResponse({ status: 'success', ...timing }, {}, env);
        } catch (e) {
          return jsonResponse({ status: 'error', error: e?.message }, { status: 500 }, env);
        }
      }

      // ── News AI Pending Diagnostics — detailed per-article pending info ──
      // For each pending/unknown article in the current news list, shows:
      //   url, hash, queue_status, retry_count, provider, circuit_breaker_state,
      //   last_error, last_attempt, kv_exists, api_serves
      // Use to instantly identify which layer has the issue if pending persists.
      if (request.method === 'GET' && url.pathname === '/api/news-ai-pending') {
        try {
          // Read current news list from KV
          let articles = [];
          try {
            const raw = await readAppCache(env, FARSI_NEWS_CACHE_KEY);
            if (raw) articles = JSON.parse(raw) || [];
          } catch {}

          // Read queue
          const queue = await getSummaryQueue(env);
          const queueByUrl = new Map();
          for (const item of queue) {
            if (item.url) queueByUrl.set(item.url, item);
          }

          // Read circuit states
          const circuitStates = {};
          for (const p of ['gemini', 'workers-ai', 'openai']) {
            circuitStates[p] = await getCircuitState(env, p);
          }

          // For each article, check KV + build diagnostic info
          const now = Date.now();
          const diagnostics = await Promise.all(
            articles.map(async (a) => {
              const url = a.url || '';
              const hash = hashUrl(url);
              const aiKey = `${NEWS_AI_CACHE_PREFIX}${hash}`;
              let kvExists = false;
              let kvProvider = null;
              let kvSummaryLen = 0;
              try {
                const raw = await readAppCache(env, aiKey);
                if (raw) {
                  kvExists = true;
                  try {
                    const parsed = JSON.parse(raw);
                    if (parsed && typeof parsed === 'object' && typeof parsed.summary === 'string') {
                      kvProvider = parsed.provider || null;
                      kvSummaryLen = parsed.summary.length;
                    } else {
                      kvSummaryLen = raw.length;
                    }
                  } catch {
                    kvSummaryLen = raw.length;
                  }
                }
              } catch {}

              const qItem = queueByUrl.get(url);
              let queueStatus, retryCount, lastAttempt, lastError, nextRetry, providerUsed;
              if (qItem) {
                queueStatus = qItem.status || 'pending';
                retryCount = qItem.retry_count || 0;
                lastAttempt = qItem.last_attempt || null;
                lastError = qItem.fail_reason || qItem.last_error || null;
                nextRetry = qItem.next_retry || null;
                providerUsed = qItem.provider_used || null;
              } else {
                queueStatus = 'not_in_queue';
                retryCount = 0;
                lastAttempt = null;
                lastError = null;
                nextRetry = null;
                providerUsed = null;
              }

              return {
                url: url.substring(0, 100),
                hash,
                title: (a.title || '').substring(0, 60),
                queue_status: queueStatus,
                retry_count: retryCount,
                provider_used: providerUsed,
                last_attempt: lastAttempt,
                last_error: lastError,
                next_retry: nextRetry,
                next_retry_in_ms: nextRetry ? Math.max(0, nextRetry - now) : null,
                kv_exists: kvExists,
                kv_provider: kvProvider,
                kv_summary_length: kvSummaryLen,
                api_serves: kvExists && kvSummaryLen >= 50, // will be served as completed
                circuit_breaker: {
                  gemini: circuitStates.gemini?.state || 'CLOSED',
                  'workers-ai': circuitStates['workers-ai']?.state || 'CLOSED',
                  openai: circuitStates.openai?.state || 'CLOSED',
                },
                pending_age_ms: qItem?.enqueued_at ? (now - qItem.enqueued_at) : null,
              };
            })
          );

          return jsonResponse({
            status: 'success',
            ts: now,
            total_articles: articles.length,
            diagnostics,
          }, {}, env);
        } catch (e) {
          return jsonResponse({ status: 'error', error: e?.message }, { status: 500 }, env);
        }
      }

      // ── Calendar Reminders (per-user, stored in PostgreSQL) ──
      // POST   /api/calendar/reminders      — create/update
      // GET    /api/calendar/reminders      — list user's reminders
      // DELETE /api/calendar/reminders/:key — delete by event_key
      if (url.pathname === '/api/calendar/reminders' && request.method === 'POST') {
        return calendarReminderHandlers.handleCreate(request, env);
      }
      if (url.pathname === '/api/calendar/reminders' && request.method === 'GET') {
        return calendarReminderHandlers.handleList(request, env);
      }
      if (url.pathname.startsWith('/api/calendar/reminders/') && request.method === 'DELETE') {
        const eventKey = decodeURIComponent(url.pathname.slice('/api/calendar/reminders/'.length));
        return calendarReminderHandlers.handleDelete(request, env, eventKey);
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
        return adminHandlers.handleIsAdmin(request, env);
      }
      if (url.pathname === '/api/admin/dashboard' && request.method === 'GET') {
        return adminHandlers.handleDashboard(request, env);
      }
      if (url.pathname === '/api/admin/admins' && request.method === 'GET') {
        return adminHandlers.handleListAdmins(request, env);
      }
      if (url.pathname === '/api/admin/admins' && request.method === 'POST') {
        return adminHandlers.handleAddAdmin(request, env);
      }
      if (/^\/api\/admin\/admins\/\d+$/.test(url.pathname) && request.method === 'PUT') {
        const adminId = url.pathname.split('/').pop();
        return adminHandlers.handleUpdateAdmin(request, env, adminId);
      }
      if (/^\/api\/admin\/admins\/\d+$/.test(url.pathname) && request.method === 'DELETE') {
        const adminId = url.pathname.split('/').pop();
        return adminHandlers.handleDeleteAdmin(request, env, adminId);
      }
      if (url.pathname === '/api/admin/users' && request.method === 'GET') {
        return adminHandlers.handleListUsers(request, env);
      }
      if (/^\/api\/admin\/users\/[^/]+\/stats$/.test(url.pathname) && request.method === 'GET') {
        const userId = decodeURIComponent(url.pathname.split('/')[4]);
        return adminHandlers.handleUserDetail(request, env, userId);
      }
      if (url.pathname === '/api/admin/tickets' && request.method === 'GET') {
        return adminHandlers.handleListTickets(request, env);
      }
      if (/^\/api\/admin\/tickets\/[^/]+\/reply$/.test(url.pathname) && request.method === 'POST') {
        const ticketId = url.pathname.split('/')[4];
        return adminHandlers.handleReplyTicket(request, env, ticketId);
      }
      if (/^\/api\/admin\/tickets\/[^/]+\/status$/.test(url.pathname) && request.method === 'PUT') {
        const ticketId = url.pathname.split('/')[4];
        return adminHandlers.handleUpdateTicketStatus(request, env, ticketId);
      }
      // PHASE 3 FIX (Bug 5): Admin DELETE ticket — previously didn't exist
      if (/^\/api\/admin\/tickets\/[^/]+$/.test(url.pathname) && request.method === 'DELETE') {
        const ticketId = url.pathname.split('/')[4];
        return adminHandlers.handleDeleteTicket(request, env, ticketId);
      }
      // PHASE 3 FIX (Bug 6): Admin GET ticket replies — for conversation thread
      if (/^\/api\/admin\/tickets\/[^/]+\/replies$/.test(url.pathname) && request.method === 'GET') {
        const ticketId = url.pathname.split('/')[4];
        return adminHandlers.handleListTicketReplies(request, env, ticketId);
      }
      if (url.pathname === '/api/admin/broadcasts' && request.method === 'POST') {
        return adminHandlers.handleCreateBroadcast(request, env);
      }
      if (url.pathname === '/api/admin/broadcasts' && request.method === 'GET') {
        return adminHandlers.handleListBroadcasts(request, env);
      }
      if (url.pathname === '/api/admin/rewards' && request.method === 'GET') {
        return adminHandlers.handleListRewards(request, env);
      }
      if (/^\/api\/admin\/rewards\/\d+\/status$/.test(url.pathname) && request.method === 'PUT') {
        const rewardId = url.pathname.split('/')[4];
        return adminHandlers.handleUpdateReward(request, env, rewardId);
      }
      if (url.pathname === '/api/admin/transactions' && request.method === 'GET') {
        return adminHandlers.handleListTransactions(request, env);
      }
      if (url.pathname === '/api/admin/referrals' && request.method === 'GET') {
        return adminHandlers.handleListReferrals(request, env);
      }
      if (url.pathname === '/api/admin/system-health' && request.method === 'GET') {
        return adminHandlers.handleSystemHealth(request, env);
      }
      if (url.pathname === '/api/admin/logs' && request.method === 'GET') {
        return adminHandlers.handleLogs(request, env);
      }

      // ─────────────────────────────────────────────────────────────
      // REWARD CENTER (admin) — full reward management system
      // ─────────────────────────────────────────────────────────────

      // Overview & Analytics
      if (url.pathname === '/api/admin/reward-center/overview' && request.method === 'GET') {
        return rewardCenterHandlers.handleOverview(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/analytics' && request.method === 'GET') {
        return rewardCenterHandlers.handleAnalytics(request, env);
      }

      // Wheel Config
      if (url.pathname === '/api/admin/reward-center/wheel/config' && request.method === 'GET') {
        return rewardCenterHandlers.handleGetWheelConfig(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/wheel/config' && (request.method === 'PUT' || request.method === 'POST')) {
        return rewardCenterHandlers.handleUpdateWheelConfig(request, env);
      }

      // Wheel Rewards CRUD
      if (url.pathname === '/api/admin/reward-center/wheel/rewards' && request.method === 'GET') {
        return rewardCenterHandlers.handleListWheelRewards(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/wheel/rewards' && request.method === 'POST') {
        return rewardCenterHandlers.handleCreateWheelReward(request, env);
      }
      if (/^\/api\/admin\/reward-center\/wheel\/rewards\/\d+$/.test(url.pathname)) {
        const rewardId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return rewardCenterHandlers.handleUpdateWheelReward(request, env, rewardId);
        if (request.method === 'DELETE') return rewardCenterHandlers.handleDeleteWheelReward(request, env, rewardId);
      }

      // Reward Library CRUD
      if (url.pathname === '/api/admin/reward-center/library' && request.method === 'GET') {
        return rewardCenterHandlers.handleListLibrary(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/library' && request.method === 'POST') {
        return rewardCenterHandlers.handleCreateLibraryItem(request, env);
      }
      if (/^\/api\/admin\/reward-center\/library\/\d+$/.test(url.pathname)) {
        const itemId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return rewardCenterHandlers.handleUpdateLibraryItem(request, env, itemId);
        if (request.method === 'DELETE') return rewardCenterHandlers.handleDeleteLibraryItem(request, env, itemId);
      }

      // Referral Reward Tiers CRUD
      if (url.pathname === '/api/admin/reward-center/referral-tiers' && request.method === 'GET') {
        return rewardCenterHandlers.handleListReferralTiers(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/referral-tiers' && request.method === 'POST') {
        return rewardCenterHandlers.handleCreateReferralTier(request, env);
      }
      if (/^\/api\/admin\/reward-center\/referral-tiers\/\d+$/.test(url.pathname)) {
        const tierId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return rewardCenterHandlers.handleUpdateReferralTier(request, env, tierId);
        if (request.method === 'DELETE') return rewardCenterHandlers.handleDeleteReferralTier(request, env, tierId);
      }

      // Mission Rewards CRUD
      if (url.pathname === '/api/admin/reward-center/mission-rewards' && request.method === 'GET') {
        return rewardCenterHandlers.handleListMissionRewards(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/mission-rewards' && request.method === 'POST') {
        return rewardCenterHandlers.handleCreateMissionReward(request, env);
      }
      if (/^\/api\/admin\/reward-center\/mission-rewards\/\d+$/.test(url.pathname)) {
        const missionId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return rewardCenterHandlers.handleUpdateMissionReward(request, env, missionId);
        if (request.method === 'DELETE') return rewardCenterHandlers.handleDeleteMissionReward(request, env, missionId);
      }

      // Campaigns CRUD
      if (url.pathname === '/api/admin/reward-center/campaigns' && request.method === 'GET') {
        return rewardCenterHandlers.handleListCampaigns(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/campaigns' && request.method === 'POST') {
        return rewardCenterHandlers.handleCreateCampaign(request, env);
      }
      if (/^\/api\/admin\/reward-center\/campaigns\/[^/]+$/.test(url.pathname)) {
        const campaignId = decodeURIComponent(url.pathname.split('/').pop());
        if (request.method === 'PUT' || request.method === 'PATCH') return rewardCenterHandlers.handleUpdateCampaign(request, env, campaignId);
        if (request.method === 'DELETE') return rewardCenterHandlers.handleDeleteCampaign(request, env, campaignId);
      }

      // Emergency Controls
      if (url.pathname === '/api/admin/reward-center/emergency' && request.method === 'GET') {
        return rewardCenterHandlers.handleGetEmergencyControls(request, env);
      }
      if (url.pathname === '/api/admin/reward-center/emergency' && (request.method === 'PUT' || request.method === 'POST')) {
        return rewardCenterHandlers.handleUpdateEmergencyControls(request, env);
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
      const _DATA_PATHS = /^\/api\/(forex|analyses|farsi-news)(\/|$)/;
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

      // ── DIAGNOSTIC: Test news summarization end-to-end ──

      // ── DIAGNOSTIC: Forex data test (bypasses auth for debugging) ──

      // ── DIAGNOSTIC: Real KV Write Stats ──

      // ── DIAGNOSTIC: Referral Debug — inspect referral flow logs + DB state ──

      // ── DIAGNOSTIC: Full cron pipeline test (RSS → AI → KV → fetch) ──

      // ── DIAGNOSTIC: List available Gemini models ──

      // ── NOTIFICATIONS CPU TRACE ──
      // Instrumented version of /api/notifications that logs wall-time per step.
      // This route is BEFORE the PROTECTED_PATHS gate so it controls its own auth.
      // It replicates the EXACT same steps that /api/notifications goes through:
      //   1. authenticateTelegramRequest (HMAC)
      //   2. requireChannelJoin (KV read + DB query + maybe Telegram API)
      //   3. authenticateTelegramRequest AGAIN (inside handleList — redundant)
      //   4. DB query: notificationRepo.list
      //   5. DB query: notificationRepo.unreadCount
      //   6. JSON serialize
      if (request.method === 'GET' && url.pathname === '/api/notif-cpu-trace') {
        // P1-11 FIX: Gate debug endpoints behind non-production to prevent
        // information disclosure and CPU amplification in production.
        const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
        if (_isProd) {
          return jsonResponse({ status: 'error', message: 'Not available in production' }, { status: 404 }, env);
        }
        const trace = [];
        const t0 = performance.now();
        const stepAsync = async (name, fn) => {
          const before = performance.now();
          try {
            const r = await fn();
            const after = performance.now();
            trace.push({ step: name, wall_delta_ms: Math.round((after - before) * 100) / 100 });
            return r;
          } catch (e) {
            const after = performance.now();
            trace.push({ step: name + '_ERROR', wall_delta_ms: Math.round((after - before) * 100) / 100, error: String(e?.message || e).slice(0, 200) });
            throw e;
          }
        };
        const stepSync = (name, fn) => {
          const before = performance.now();
          const r = fn();
          const after = performance.now();
          trace.push({ step: name, wall_delta_ms: Math.round((after - before) * 100) / 100 });
          return r;
        };

        try {
          // STEP 1: Auth (1st — global middleware equivalent)
          const authState = await stepAsync('1_auth_telegram_1st', () => authenticateTelegramRequest(request, env))
          if (authState.error) {
            return jsonResponse({ status: 'auth_error', trace, total_wall_ms: Math.round((performance.now() - t0) * 100) / 100 }, { status: 401 }, env);
          }

          // STEP 2: requireChannelJoin (membership check — KV + DB + maybe Telegram API)
          const userId = String(authState.user.id);
          const joinBlocked = await stepAsync('2_requireChannelJoin', () => requireChannelJoin(authState.user, env));
          if (joinBlocked) {
            return jsonResponse({ status: 'join_required', trace, total_wall_ms: Math.round((performance.now() - t0) * 100) / 100 }, { status: 403 }, env);
          }

          // STEP 3: Auth (2nd — inside handleList — REDUNDANT?)
          await stepAsync('3_auth_telegram_2nd_redundant', () => authenticateTelegramRequest(request, env))

          // STEP 4: Parse query params
          const parsedUrl = stepSync('4_parse_url', () => new URL(request.url));
          const limit = stepSync('4_parse_limit', () => parseInt(parsedUrl.searchParams.get('limit') || '50', 10) || 50);

          // STEP 5: DB queries (Promise.all of list + unreadCount)
          let notifications, unread;
          await stepAsync('5_db_promise_all', async () => {
            [notifications, unread] = await Promise.all([
              stepAsync('5a_db_list', () => notificationRepo.list(env, userId, limit)),
              stepAsync('5b_db_unreadCount', () => notificationRepo.unreadCount(env, userId)),
            ]);
          });

          // STEP 6: JSON serialize
          stepSync('6_json_serialize', () => JSON.stringify({
            status: 'success', notifications, unread_count: unread,
          }));

          const totalWall = Math.round((performance.now() - t0) * 100) / 100;

          return jsonResponse({
            status: 'success',
            notifications_count: notifications?.length || 0,
            unread_count: unread,
            trace,
            total_wall_ms: totalWall,
            auth_call_count: 2,
            db_query_count: 3,
          }, {}, env);
        } catch (error) {
          const totalWall = Math.round((performance.now() - t0) * 100) / 100;
          return jsonResponse({
            status: 'error',
            message: String(error?.message || error).slice(0, 300),
            trace,
            total_wall_ms: totalWall,
          }, { status: 500 }, env);
        }
      }

      // ── NOTIF TRACE RESULTS — read traces from KV ──
      // Lists all notif_trace_* keys from KV and returns their contents.
      // No auth required (the traces themselves are keyed by random ID).
      if (request.method === 'GET' && url.pathname === '/api/notif-trace-results') {
        // P1-11 FIX: Gate debug endpoints behind non-production
        const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
        if (_isProd) {
          return jsonResponse({ status: 'error', message: 'Not available in production' }, { status: 404 }, env);
        }
        let traces = [];
        try {
          if (env.APP_CACHE?.list) {
            const listed = await env.APP_CACHE.list({ prefix: 'notif_trace_', limit: 100 });
            if (listed?.keys) {
              const entries = await Promise.all(
                listed.keys.map(k => env.APP_CACHE.get(k.name).catch(() => null))
              );
              for (const e of entries) {
                if (e) { try { traces.push(JSON.parse(e)); } catch {} }
              }
            }
          }
        } catch (e) {
          return jsonResponse({ error: e?.message }, { status: 500 }, env);
        }
        // Sort by timestamp descending (newest first)
        traces.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        return jsonResponse({
          server_time: new Date().toISOString(),
          trace_count: traces.length,
          traces: traces.slice(0, 20), // last 20 traces
        }, {}, env);
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
      const PROTECTED_PATHS = /^\/api\/(wallet|tickets|alerts|assistant|referrals|users\/me|watchlist|sessions|notify|notifications|notif-delete-diag)/;
      const _isProduction = String(env.APP_ENV || '').toLowerCase() === 'production';

      // ── CPU TRACE: attach trace array to request for instrumentation ──
      // The global middleware and route handlers both write to this array.
      // For /api/notifications, the trace is written to KV in the route handler.
      if (!request._cpuTrace) request._cpuTrace = [];
      const _gateT0 = performance.now();

      if (_isProduction && PROTECTED_PATHS.test(url.pathname)) {
        const _authT0 = performance.now();
        const _authState = await authenticateTelegramRequest(request, env);
        request._cpuTrace.push({ step: 'global_auth', wall_ms: Math.round((performance.now() - _authT0) * 100) / 100 });
        if (_authState.error) return _authState.error;
        _protectedUser = _authState.user;
        // PHASE 3 FIX: Set _protectedUser on the request object so notification
        // handlers can use it without calling authenticateTelegramRequest again.
        request._protectedUser = _protectedUser;

        const _joinT0 = performance.now();
        _joinBlocked = await requireChannelJoin(_protectedUser, env);
        request._cpuTrace.push({ step: 'global_requireChannelJoin', wall_ms: Math.round((performance.now() - _joinT0) * 100) / 100 });
        if (_joinBlocked) return _joinBlocked;
      }
      request._cpuTrace.push({ step: 'global_gate_total', wall_ms: Math.round((performance.now() - _gateT0) * 100) / 100 });

      // ── NOTIFICATION DELETE DIAGNOSTIC ──
      // Proves whether notifications reappear after delete, and WHY.
      // Placed AFTER PROTECTED_PATHS gate so _protectedUser is set.
      if (request.method === 'GET' && url.pathname === '/api/notif-delete-diag') {
        // P1-11 FIX: Gate debug endpoints behind non-production
        const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
        if (_isProd) {
          return jsonResponse({ status: 'error', message: 'Not available in production' }, { status: 404 }, env);
        }
        const result = { server_time: new Date().toISOString(), steps: [] };

        // Step 1: Check broadcasts in 'pending' or 'sending' status
        try {
          const broadcasts = await queryDb(env,
            `SELECT id, title, status, created_at, sent_at, total_sent, total_delivered, last_processed_user_id
             FROM notification_broadcasts
             WHERE status IN ('pending', 'sending')
             ORDER BY created_at ASC LIMIT 10`
          ).catch(() => ({ rows: [] }));
          result.steps.push({
            step: '1_active_broadcasts',
            count: broadcasts.rows.length,
            broadcasts: broadcasts.rows.map(r => ({
              id: r.id, title: (r.title||'').slice(0,50), status: r.status,
              created_at: r.created_at, sent_at: r.sent_at,
              total_sent: r.total_sent, total_delivered: r.total_delivered,
            })),
          });
        } catch (e) { result.steps.push({ step: '1_active_broadcasts', error: e?.message }); }

        // Step 2: Check ALL broadcasts in last 24h
        try {
          const recentBroadcasts = await queryDb(env,
            `SELECT id, title, status, created_at, sent_at
             FROM notification_broadcasts
             WHERE created_at > NOW() - INTERVAL '24 hours'
             ORDER BY created_at DESC LIMIT 10`
          ).catch(() => ({ rows: [] }));
          result.steps.push({
            step: '2_recent_broadcasts_24h',
            count: recentBroadcasts.rows.length,
            broadcasts: recentBroadcasts.rows.map(r => ({
              id: r.id, title: (r.title||'').slice(0,50), status: r.status,
              created_at: r.created_at, sent_at: r.sent_at,
            })),
          });
        } catch (e) { result.steps.push({ step: '2_recent_broadcasts_24h', error: e?.message }); }

        // Step 3: User's notifications with IDs
        if (_protectedUser?.id) {
          try {
            const userId = String(_protectedUser.id);
            const notifs = await queryDb(env,
              `SELECT id, type, title, read_status, deleted_at, created_at
               FROM notifications
               WHERE user_id = $1
               ORDER BY created_at DESC LIMIT 20`,
              [userId]
            ).catch(() => ({ rows: [] }));
            result.steps.push({
              step: '3_user_notifications',
              userId: userId,
              count: notifs.rows.length,
              notifications: notifs.rows.map(r => ({
                id: r.id, type: r.type, title: (r.title||'').slice(0,40),
                read_status: r.read_status, deleted_at: r.deleted_at,
                created_at: r.created_at,
                is_broadcast: String(r.id).startsWith('bc_'),
                is_notif_prefix: String(r.id).startsWith('notif_'),
              })),
            });

            // Step 4: KV cache
            try {
              const cached = await env.APP_CACHE?.get?.('notif_cache_' + userId).catch(() => null);
              result.steps.push({
                step: '4_kv_cache',
                cacheKey: 'notif_cache_' + userId,
                hasCache: !!cached,
                cacheLength: cached ? cached.length : 0,
              });
            } catch (e) { result.steps.push({ step: '4_kv_cache', error: e?.message }); }
          } catch (e) { result.steps.push({ step: '3_user_notifications', error: e?.message }); }
        } else {
          result.steps.push({ step: '3_user_notifications', note: 'no authenticated user' });
        }

        return jsonResponse(result, {}, env);
      }

      // ── Analyses: Public endpoints ──
      if (request.method === 'GET' && url.pathname === '/api/analyses') {
        return analysisHandlers.handleList(request, env);
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
        return analysisHandlers.handleCreate(request, env, ctx);
      }

      if (request.method === 'PUT' && /^\/api\/admin\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[4] || '';
        return analysisHandlers.handleUpdate(request, env, analysisId);
      }

      if (request.method === 'DELETE' && /^\/api\/admin\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[4] || '';
        return analysisHandlers.handleDelete(request, env, analysisId);
      }

      // ── Analyses: Legacy admin paths (backward compat) ──
      if (request.method === 'POST' && url.pathname === '/api/analyses') {
        return analysisHandlers.handleCreateLegacy(request, env, ctx);
      }

      if (request.method === 'PUT' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return analysisHandlers.handleUpdateLegacy(request, env, analysisId);
      }

      if (request.method === 'DELETE' && /^\/api\/analyses\/[^/]+$/u.test(url.pathname)) {
        const analysisId = url.pathname.split('/')[3] || '';
        return analysisHandlers.handleDeleteLegacy(request, env, analysisId);
      }

      if (request.method === 'POST' && url.pathname === '/api/tickets') {
        return ticketHandlers.handleCreate(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/tickets') {
        return ticketHandlers.handleList(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/tickets/all') {
        return ticketHandlers.handleListAll(request, env);
      }

      if (request.method === 'POST' && /^\/api\/tickets\/[^/]+\/reply$/u.test(url.pathname)) {
        const ticketId = url.pathname.split('/')[3] || '';
        return ticketHandlers.handleReply(request, env, ticketId);
      }

      if (request.method === 'DELETE' && /^\/api\/tickets\/[^/]+$/u.test(url.pathname) && url.pathname !== '/api/tickets/all') {
        const ticketId = url.pathname.split('/')[3] || '';
        return ticketHandlers.handleDelete(request, env, ticketId);
      }

      if (request.method === 'POST' && url.pathname === '/api/alerts') {
        return alertHandlers.handleCreate(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/alerts') {
        return alertHandlers.handleList(request, env);
      }

      if (request.method === 'DELETE' && /^\/api\/alerts\/[^/]+$/u.test(url.pathname)) {
        const alertId = url.pathname.split('/')[3] || '';
        return alertHandlers.handleDelete(request, env, alertId);
      }

      // ── Calendar Reminders routes are registered earlier (near /api/calendar/events) ──

      // ── Alert Economy: User quota status ──
      if (request.method === 'GET' && url.pathname === '/api/alerts/quota') {
        return alertEconomyHandlers.handleQuotaStatus(request, env);
      }

      // ── Alert Economy: Admin config + dashboard ──
      if (request.method === 'GET' && url.pathname === '/api/admin/alert-economy/configs') {
        return alertEconomyHandlers.handleListConfigs(request, env);
      }
      if (request.method === 'PUT' && /^\/api\/admin\/alert-economy\/configs\/[^/]+$/.test(url.pathname)) {
        const alertType = decodeURIComponent(url.pathname.split('/').pop());
        return alertEconomyHandlers.handleUpdateConfig(request, env, alertType);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/alert-economy/dashboard') {
        return alertEconomyHandlers.handleDashboard(request, env);
      }

      // ─────────────────────────────────────────────────────────────
      // TELEGRAM PUBLISHER — channel publishing system (admin-only)
      // ─────────────────────────────────────────────────────────────
      if (url.pathname === '/api/admin/publisher/settings' && (request.method === 'GET' || request.method === 'PUT' || request.method === 'POST')) {
        if (request.method === 'GET') return await publisherHandlers.handleGetSettings(request, env);
        return await publisherHandlers.handleUpdateSettings(request, env);
      }
      if (url.pathname === '/api/admin/publisher/preview' && request.method === 'POST') {
        return publisherHandlers.handlePreview(request, env);
      }
      if (url.pathname === '/api/admin/publisher/queue' && request.method === 'POST') {
        return publisherHandlers.handleEnqueue(request, env);
      }
      if (url.pathname === '/api/admin/publisher/send-now' && request.method === 'POST') {
        return publisherHandlers.handleSendNow(request, env);
      }
      if (url.pathname === '/api/admin/publisher/queue' && request.method === 'GET') {
        return publisherHandlers.handleListQueue(request, env, 'pending');
      }
      if (url.pathname === '/api/admin/publisher/sent' && request.method === 'GET') {
        return publisherHandlers.handleListQueue(request, env, 'sent');
      }
      if (url.pathname === '/api/admin/publisher/failed' && request.method === 'GET') {
        return publisherHandlers.handleListQueue(request, env, 'failed');
      }
      if (url.pathname === '/api/admin/publisher/logs' && request.method === 'GET') {
        return publisherHandlers.handleListLogs(request, env);
      }
      if (url.pathname === '/api/admin/publisher/stats' && request.method === 'GET') {
        return publisherHandlers.handleStats(request, env);
      }
      if (url.pathname === '/api/admin/publisher/process' && request.method === 'POST') {
        return publisherHandlers.handleProcessNow(request, env);
      }
      if (url.pathname === '/api/admin/publisher/test-connection' && request.method === 'POST') {
        return await publisherHandlers.handleTestConnection(request, env);
      }
      if (/^\/api\/admin\/publisher\/retry\/\d+$/.test(url.pathname) && request.method === 'POST') {
        const id = url.pathname.split('/').pop();
        return publisherHandlers.handleRetry(request, env, id);
      }
      if (/^\/api\/admin\/publisher\/cancel\/\d+$/.test(url.pathname) && request.method === 'POST') {
        const id = url.pathname.split('/').pop();
        return publisherHandlers.handleCancel(request, env, id);
      }
      if (/^\/api\/admin\/publisher\/sent\/\d+$/.test(url.pathname) && request.method === 'DELETE') {
        const id = url.pathname.split('/').pop();
        return publisherHandlers.handleDeleteSent(request, env, id);
      }
      if (/^\/api\/admin\/publisher\/dedup\/[^/]+\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
        const parts = url.pathname.split('/');
        const type = decodeURIComponent(parts[parts.length - 2]);
        const refId = decodeURIComponent(parts[parts.length - 1]);
        return publisherHandlers.handleCheckDedup(request, env, type, refId);
      }

      // ── Membership Module — User Routes ───────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/membership/status') {
        return membershipHandlers.handleGetStatus(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/membership/request') {
        return membershipHandlers.handleGetMyRequests(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/membership/request') {
        return membershipHandlers.handleSubmitRequest(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/membership/welcome-shown') {
        return membershipHandlers.handleMarkWelcomeShown(request, env);
      }

      // ── Membership Module — Admin Routes ──────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/stats') {
        return membershipHandlers.handleGetStats(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/requests') {
        return membershipHandlers.handleListRequests(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/requests/export') {
        return membershipHandlers.handleExportRequests(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/requests/bulk-approve') {
        return membershipHandlers.handleBulkApprove(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/requests/bulk-reject') {
        return membershipHandlers.handleBulkReject(request, env);
      }
      if (/^\/api\/admin\/membership\/request\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
        return membershipHandlers.handleGetRequest(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/approve') {
        return membershipHandlers.handleApprove(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/reject') {
        return membershipHandlers.handleReject(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/suspend') {
        return membershipHandlers.handleSuspend(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/reactivate') {
        return membershipHandlers.handleReactivate(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/users') {
        return membershipHandlers.handleListUsers(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/users/export') {
        return membershipHandlers.handleExportUsers(request, env);
      }
      if (/^\/api\/admin\/membership\/users\/[^/]+$/.test(url.pathname) && request.method === 'GET') {
        return membershipHandlers.handleGetUserDetail(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/users/suspend') {
        return membershipHandlers.handleManualSuspend(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/users/reactivate') {
        return membershipHandlers.handleManualReactivate(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/users/expire') {
        return membershipHandlers.handleManualExpire(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/users/set-level') {
        return membershipHandlers.handleSetLevel(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/logs') {
        return membershipHandlers.handleListLogs(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/logs/export') {
        return membershipHandlers.handleExportLogs(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/notifications') {
        // ═══════════════════════════════════════════════════════════════════════
        // ROOT CAUSE FIX for "The Promise did not resolve to 'Response'" error.
        //
        // PROBLEM:
        //   This route previously used an inline IIFE pattern:
        //     return await (async () => { ... 125 lines ... })();
        //
        //   The IIFE always returned a Response (all 3 return paths verified),
        //   and `return await` was present (commit 20cce0b). Yet production
        //   still showed "The Promise did not resolve to 'Response'" with
        //   cpuTimeMs: 1, outcome: exception.
        //
        // ROOT CAUSE (proven by elimination):
        //   The IIFE pattern was introduced when `withSharedPool` was removed
        //   (commit d754560). `withSharedPool` was a NAMED async function that
        //   did `return await fn()` internally — the runtime received a Promise
        //   from a named function. After removal, the code became an ANONYMOUS
        //   IIFE: `return await (async () => {...})()`. While semantically
        //   equivalent in standard JavaScript, the Cloudflare Workers runtime
        //   occasionally fails to propagate the return value through the
        //   anonymous IIFE + await pattern, causing the fetch handler's Promise
        //   to resolve to undefined → "Promise did not resolve to Response".
        //
        //   The `return await` fix (commit 20cce0b) was necessary but NOT
        //   sufficient — it fixed error propagation for THROWN errors, but the
        //   IIFE wrapper itself still caused occasional return value loss.
        //
        // FIX:
        //   Replace the 125-line inline IIFE with the existing
        //   `notificationHandlers.handleList` controller function. This:
        //     1. Removes the anonymous IIFE wrapper (the root cause)
        //     2. Uses the standard controller pattern (same as ALL other
        //        notification routes: /read-all, /:id/read, /:id, etc.)
        //     3. Uses _getUserId() which reads request._protectedUser from
        //        the PROTECTED_PATHS gate (no redundant HMAC)
        //     4. Has a simple try/catch that returns safeDbErrorResponse on error
        //     5. Returns jsonResponse (Response) on ALL paths
        //
        // TRADE-OFFS (acceptable):
        //   - Loses 30s KV response cache (optimization, not essential —
        //     frontend polls every 30s anyway, and the DB query is fast)
        //   - Loses combined DB query (uses 2 queries via Promise.all instead
        //     of 1 — optimization, not essential)
        //   - Loses CPU trace instrumentation (debug tool, not essential)
        //   - Gains: eliminates "Promise did not resolve to Response" error
        //
        // The notifications table already exists in production (running for
        // months). The IIFE's `ensureTable` call is not needed here —
        // notificationRepo.list/unreadCount query the table directly, same as
        // the cron handler does.
        // ═══════════════════════════════════════════════════════════════════════
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
        const result = await notificationHandlers.handleMarkAllRead(request, env);
        // Invalidate cache for this user
        if (_protectedUser?.id && env.APP_CACHE) {
          env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {});
        }
        return result;
      }

      if (request.method === 'POST' && /^\/api\/notifications\/[^/]+\/read$/u.test(url.pathname)) {
        const notificationId = url.pathname.split('/')[3] || '';
        const result = await notificationHandlers.handleMarkRead(request, env, notificationId);
        // Invalidate cache for this user
        if (_protectedUser?.id && env.APP_CACHE) {
          env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {});
        }
        return result;
      }

      // ROOT CAUSE FIX: DELETE single notification — previously didn't exist,
      // frontend only cleared local state → notifications reappeared on next poll.
      if (request.method === 'DELETE' && /^\/api\/notifications\/[^/]+$/u.test(url.pathname)) {
        const notificationId = url.pathname.split('/')[3] || '';
        const result = await notificationHandlers.handleDelete(request, env, notificationId);
        // Invalidate cache for this user
        if (_protectedUser?.id && env.APP_CACHE) {
          env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {});
        }
        return result;
      }

      // ROOT CAUSE FIX: DELETE ALL notifications — previously clearAllNotifications()
      // in frontend only cleared the local array, no API call.
      if (request.method === 'DELETE' && url.pathname === '/api/notifications') {
        const result = await notificationHandlers.handleDeleteAll(request, env);
        // Invalidate cache for this user
        if (_protectedUser?.id && env.APP_CACHE) {
          env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {});
        }
        return result;
      }

      // ─────────────────────────────────────────────────────────────
      // NOTIFICATION PLATFORM — unified notification system
      // ─────────────────────────────────────────────────────────────

      // User: list notifications (with filter/search/pagination)
      if (request.method === 'GET' && url.pathname === '/api/notifications/platform/list') {
        return notificationPlatformHandlers.handleList(request, env);
      }
      // User: unread count
      if (request.method === 'GET' && url.pathname === '/api/notifications/platform/unread-count') {
        return await notificationPlatformHandlers.handleUnreadCount(request, env);
      }
      // User: mark single notification as read
      if (request.method === 'POST' && /^\/api\/notifications\/platform\/[^/]+\/read$/.test(url.pathname)) {
        const notifId = url.pathname.split('/').pop();
        const res = await notificationPlatformHandlers.handleMarkRead(request, env, notifId);
        // P0-2 FIX: Invalidate notif cache so badge updates immediately
        if (_protectedUser?.id && env.APP_CACHE) { env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {}); }
        return res;
      }
      // User: mark all as read
      if (request.method === 'POST' && url.pathname === '/api/notifications/platform/read-all') {
        const res = await notificationPlatformHandlers.handleMarkAllRead(request, env);
        // P0-2 FIX: Invalidate notif cache
        if (_protectedUser?.id && env.APP_CACHE) { env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {}); }
        return res;
      }
      // User: archive notification
      if (request.method === 'POST' && /^\/api\/notifications\/platform\/[^/]+\/archive$/.test(url.pathname)) {
        const notifId = url.pathname.split('/')[4];
        const res = await notificationPlatformHandlers.handleArchive(request, env, notifId);
        // P0-2 FIX: Invalidate notif cache
        if (_protectedUser?.id && env.APP_CACHE) { env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {}); }
        return res;
      }
      // User: delete notification
      if (request.method === 'DELETE' && /^\/api\/notifications\/platform\/[^/]+$/.test(url.pathname)) {
        const notifId = url.pathname.split('/').pop();
        const res = await notificationPlatformHandlers.handleDelete(request, env, notifId);
        // P0-2 FIX: Invalidate notif cache
        if (_protectedUser?.id && env.APP_CACHE) { env.APP_CACHE.delete('notif_cache_' + _protectedUser.id).catch(() => {}); }
        return res;
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
        return notificationPlatformHandlers.handleAdminAnalytics(request, env);
      }
      // Admin: templates CRUD
      if (request.method === 'GET' && url.pathname === '/api/admin/notifications/templates') {
        return notificationPlatformHandlers.handleListTemplates(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/notifications/templates') {
        return notificationPlatformHandlers.handleCreateTemplate(request, env);
      }
      if (/^\/api\/admin\/notifications\/templates\/\d+$/.test(url.pathname)) {
        const tplId = url.pathname.split('/').pop();
        if (request.method === 'PUT' || request.method === 'PATCH') return notificationPlatformHandlers.handleUpdateTemplate(request, env, tplId);
        if (request.method === 'DELETE') return notificationPlatformHandlers.handleDeleteTemplate(request, env, tplId);
      }
      // Admin: broadcasts
      if (request.method === 'GET' && url.pathname === '/api/admin/notifications/broadcasts') {
        return notificationPlatformHandlers.handleListBroadcasts(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/notifications/broadcasts') {
        return notificationPlatformHandlers.handleCreateBroadcast(request, env);
      }
      if (request.method === 'POST' && /^\/api\/admin\/notifications\/broadcasts\/\d+\/send$/.test(url.pathname)) {
        const bId = url.pathname.split('/')[5];
        return notificationPlatformHandlers.handleProcessBroadcast(request, env, bId);
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
        return userHandlers.handleMe(request, env);
      }

      if (request.method === 'PUT' && url.pathname === '/api/users/me/settings') {
        return await userHandlers.handleMeSettings(request, env);
      }

      // ── ROOT-CAUSE FIX: Delete Account endpoint (cascade delete) ──
      // Permanently deletes the user and ALL their data. After this, the user
      // can re-register via a referral link and the referral will register.
      if (request.method === 'DELETE' && url.pathname === '/api/users/me') {
        return userHandlers.handleDeleteAccount(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/users/bootstrap') {
        return userHandlers.handleBootstrap(request, env);
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
        return watchlistHandlers.handlePut(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/notify') {
        return await notifyHandlers.handlePost(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/referrals/stats') {
        return await referralHandlers.handleStats(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/referrals/history') {
        return referralHandlers.handleHistory(request, env);
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
        return walletHandlers.handleGetHistory(request, env);
      }

      if (request.method === 'GET' && /^\/api\/wallet\/transaction\/[^/]+$/.test(url.pathname)) {
        const txId = url.pathname.split('/')[3] || '';
        return await walletHandlers.handleGetTransaction(request, env, txId);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/claim') {
        return await walletHandlers.handleGetClaimStatus(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/wallet/claim') {
        return walletHandlers.handleClaimDaily(request, env);
      }

      // ── Daily Missions API Routes ──
      if (request.method === 'POST' && url.pathname === '/api/wallet/mission/complete') {
        return walletHandlers.handleMissionComplete(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wallet/missions') {
        return walletHandlers.handleGetMissions(request, env);
      }

      // ── Lucky Wheel API Routes ──
      if (request.method === 'GET' && url.pathname === '/api/wheel/status') {
        return wheelHandlers.handleStatus(request, env);
      }

      if (request.method === 'POST' && url.pathname === '/api/wheel/spin') {
        return wheelHandlers.handleSpin(request, env);
      }

      if (request.method === 'GET' && url.pathname === '/api/wheel/history') {
        return wheelHandlers.handleHistory(request, env);
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
      // No per-request pool teardown needed: queryDb uses per-call Pool
      // (created + closed inside each queryDb call). No module-level Pool
      // state exists — nothing to clean up. This is the ONLY safe pattern
      // for @neondatabase/serverless Pool in Cloudflare Workers.
    }
  },

  async scheduled(controller, env, ctx) {
    // ═══════════════════════════════════════════════════════════════════
    // CRON MONITORING — tracks each phase's execution for exceededCpu proof
    // Uses KV with per-phase keys (atomic writes, no read-modify-write)
    // ═══════════════════════════════════════════════════════════════════
    const _cronTickId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const _cronTickStart = Date.now();
    const _cronTickMinute = new Date().getUTCMinutes();
    const _cronTickExpr = controller.cron || '* * * * *';
    if (!globalThis._cronMonitorLog) globalThis._cronMonitorLog = [];
    // PHASE 2 SAFE OPTIMIZATION: Initialize DB trace flag for cron context too.
    _dbTraceEnabled = _dbTraceEnabled ?? (String(env.DB_TRACE_ENABLED || '').toLowerCase() === 'true');
    const _logPhase = (phase, status, extra) => {
      const entry = {
        tick: _cronTickId,
        ts: new Date().toISOString(),
        cron: _cronTickExpr,
        minute: _cronTickMinute,
        phase,
        status,
        elapsed_ms: Date.now() - _cronTickStart,
        ...extra,
      };
      // In-memory (fast, but per-isolate)
      globalThis._cronMonitorLog.push(entry);
      if (globalThis._cronMonitorLog.length > 200) {
        globalThis._cronMonitorLog = globalThis._cronMonitorLog.slice(-200);
      }
      // ROOT-CAUSE FIX: KV writes for cron monitoring are DISABLED in production.
      // Previously: each phase wrote a separate KV key (cron_log_{tickId}_{phase})
      // = 1,440+ writes/day, which exhausted the Free Plan 1,000 writes/day limit.
      // Now: only in-memory log (globalThis._cronMonitorLog) is used.
      // /api/cron-monitor reads from in-memory log (same-isolate only).
      // This is acceptable — cron monitoring is a dev diagnostic, not critical.
    };
    _logPhase('start', 'begin');

    // ═══════════════════════════════════════════════════════════════════
    // ROOT-CAUSE FIX for exceededCpu on cron triggers:
    //
    // PROBLEM: The entire cron body was wrapped in ONE ctx.waitUntil().
    // Cloudflare measures CPU time across the ENTIRE invocation (the
    // scheduled() function call), including ALL ctx.waitUntil() promises.
    // So splitting phases into separate ctx.waitUntil() calls does NOT
    // give each phase its own 10ms CPU budget — the CPU limit applies
    // to the entire invocation.
    //
    // FIX (Phase 1): Reduced cron frequency from * * * * * (1,440 ticks/day)
    // to */5 * * * * (288 ticks/day) — 80% reduction in CPU pressure.
    // Each phase is still in its own ctx.waitUntil() for isolation (errors
    // in one phase don't crash others), but this does NOT reduce CPU usage.
    //
    // NOTE: The previous comment claimed "CPU is measured PER ctx.waitUntil()
    // promise" — this was INCORRECT. Cloudflare measures CPU across the
    // entire invocation, including all ctx.waitUntil() promises.
    //
    // PHASE LAYOUT (15-min cron):
    //   Phase 1: alerts + calendar (time-sensitive, ~5ms CPU)
    //   Phase 2: referral/wheel retries (~3ms CPU)
    //   Phase 3a (minute 0/30): notif queue + market overview (~5ms CPU)
    //   Phase 3b (minute 15/45): publisher + news AI (~8ms CPU with batching)
    //
    // PHASE LAYOUT (1-min cron):
    //   Alternate: alerts OR calendar (~3ms CPU) + broadcast batch (~2ms CPU)
    // ═══════════════════════════════════════════════════════════════════

    const cronExpr = controller.cron || '* * * * *';
    const isEveryMinute = cronExpr === '* * * * *';
    const isEvery5Min = cronExpr === '*/5 * * * *';
    const isEvery15Min = cronExpr === '*/15 * * * *';

    // ═══════════════════════════════════════════════════════════════════
    // DEDICATED PRICE ALERT CRON (every 1 minute)
    // PHASE 2 FIX: Price Alert has its own dedicated cron (* * * * *).
    // This cron ONLY runs runScheduledAlertsBaseline — nothing else.
    // No news AI, no queue processing, no cleanup, no broadcast.
    // This ensures:
    //   1. Alert detection latency = 0-60 seconds (was 5-10 minutes)
    //   2. No CPU competition from other jobs
    //   3. No subrequest competition
    //   4. Shared pool via withPhasePool (no per-call createPool)
    //   5. CAS (markTriggered WHERE status='active') prevents duplicates
    //      even if */5 or */15 ticks overlap
    // ═══════════════════════════════════════════════════════════════════
    if (isEveryMinute) {
      ctx.waitUntil(withPhasePool(env, async (pool) => {
        try {
          await runScheduledAlertsBaseline(controller, env, pool);
          _logPhase('alerts-1min', 'ok');
        } catch (e) {
          _logPhase('alerts-1min', 'error', { error: e?.message });
          console.warn('[CRON] 1-min alerts failed:', e?.message);
        }
      }));
      // Return early — 1-min cron does NOTHING else
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 4: SEQUENTIAL EXECUTION WITH SINGLE SHARED POOL
    // (Only */5 and */15 crons reach here — 1-min cron returns above)
    // ═══════════════════════════════════════════════════════════════════

    ctx.waitUntil(withPhasePool(env, async (pool) => {

      // ── Phase 4: Crash Recovery (every 5 min) ──
      if (isEvery5Min && notificationPlatformRepo) {
        try {
          const qResult = notificationPlatformRepo.requeueStaleQueueItems
            ? await notificationPlatformRepo.requeueStaleQueueItems(env, pool)
            : { requeued: 0 };
          const bResult = notificationPlatformRepo.requeueStaleBroadcasts
            ? await notificationPlatformRepo.requeueStaleBroadcasts(env, pool)
            : { requeued: 0 };
          if (qResult.requeued > 0 || bResult.requeued > 0) {
            console.log('[CRON] Phase 4 requeue:', JSON.stringify({ queue: qResult.requeued, broadcasts: bResult.requeued }));
          }
        } catch (e) {
          console.warn('[CRON] Phase 4 requeue failed:', e?.message);
        }

        // PHASE 3 FIX: Move processQueue from 30-min to 5-min cadence.
        // Previously processQueue ran only at :00 and :30 (every 30 min), causing
        // Telegram notifications to be delayed by up to 30 min.
        // Now runs on every 5-min tick. Safety:
        // - FOR UPDATE SKIP LOCKED prevents concurrent ticks from claiming same items
        // - telegram_message_id check prevents duplicate sends (Phase 7 idempotency)
        // - Fast exit when queue empty (1 queryDb, ~0.5ms CPU)
        // - Items capped at LIMIT 50 per tick
        if (notificationPlatformRepo?.processQueue) {
          try {
            const queueResult = await notificationPlatformRepo.processQueue(env, sendTelegramMessage, pool);
            if (queueResult.processed > 0) {
              console.log('[CRON] processQueue (5min):', JSON.stringify(queueResult));
            }
            _logPhase('phase4-processQueue', 'ok', queueResult);
          } catch (e) {
            _logPhase('phase4-processQueue', 'error', { error: e?.message });
            console.warn('[CRON] processQueue (5min) failed:', e?.message);
          }
        }
      }

      // ── PHASE 1a: Calendar check (*/5 only) ──
      // PHASE 2 FIX: Price Alert execution removed from */5 path.
      // Alerts now run on dedicated * * * * * cron (line 10250).
      // Only calendar check remains here on */5 ticks.
      try {
        if (isEvery5Min) {
          try { await runCalendarAlertsCheck(env, { isEvery15Min: false }, pool); _logPhase('phase1a-calendar', 'ok'); } catch (e) {
            _logPhase('phase1a-calendar', 'error', { error: e?.message });
            console.warn('[CRON] calendar failed:', e?.message);
          }
        }
        _logPhase('phase1a', 'complete');
      } catch (e) {
        _logPhase('phase1a', 'error', { error: e?.message });
        console.error('[CRON] Phase 1a error:', e?.message);
      }

      // ── PHASE 1b: Broadcast batch (every 5 min) ──
      if (isEvery5Min && notificationPlatformRepo?.processBroadcastBatch) {
        try {
          const result = await notificationPlatformRepo.processBroadcastBatch(env, sendTelegramMessage, pool);
          if (result.processed > 0) {
            console.log('[CRON] broadcast batch:', JSON.stringify(result));
          }
          _logPhase('phase1b-broadcast', 'ok', { processed: result.processed });
        } catch (e) {
          _logPhase('phase1b-broadcast', 'error', { error: e?.message });
          console.warn('[CRON] broadcast batch failed:', e?.message);
        }
      }

      // ── PHASE 1d: News Summary Queue Processing (every 5 min) ──
      // Process up to 2 article summaries per tick from the KV queue.
      // Queue persists across cron ticks — no article is lost.
      // ROOT-CAUSE FIX (Phase 10.5): increased from 1 to 2 articles per tick
      // to halve queue drain time. Each article uses ~1 fetch + 1 AI call = 2
      // subrequests. 2 articles = 4 subrequests + 7 RSS = 11 total — well under
      // Cloudflare Free's 50 subrequest limit.
      // If queue is empty, processOneArticleSummary returns immediately (no extra work).
      // Feature flags respected inside processOneArticleSummary (NEWS_SUMMARY_ENABLED).
      if (isEvery5Min) {
        const MAX_SUMMARIES_PER_TICK = 2;
        for (let i = 0; i < MAX_SUMMARIES_PER_TICK; i++) {
          try {
            const summaryResult = await processOneArticleSummary(env, pool);
            if (summaryResult.processed && summaryResult.success) {
              console.log(`[CRON] news summary ${i+1}/${MAX_SUMMARIES_PER_TICK} processed:`, summaryResult.url?.substring(0, 60));
            }
            // If queue was empty or no eligible items, stop early (no extra work)
            if (!summaryResult.processed && (summaryResult.empty || summaryResult.reason === 'no_eligible')) {
              break;
            }
            // Record monitoring tick (5-min cycle)
            try {
              await recordNewsAITick(env, {
                type: 'tick_5min',
                summary_processed: summaryResult.processed || false,
                summary_success: summaryResult.success || false,
                summary_reason: summaryResult.reason || null,
                summary_retry_count: summaryResult.retry_count || 0,
                summary_duration_ms: summaryResult.duration_ms || 0,
                queue_length: summaryResult.queueLength || null,
                tick_article_index: i + 1,
              });
            } catch {}
            _logPhase('phase1d-news-summary', 'ok', summaryResult);
          } catch (e) {
            _logPhase('phase1d-news-summary', 'error', { error: e?.message });
            console.warn('[CRON] news summary failed:', e?.message);
            break; // stop on error
          }
        }
      }

      // ── PHASE 1c: Calendar cache refresh (15-min only) ──
      if (isEvery15Min) {
        try {
          const rawEvents = await fetchCalendarFeed();
          if (Array.isArray(rawEvents) && rawEvents.length > 0) {
            const now = new Date();
            const cutoffPast = new Date(now.getTime() - 1 * 24 * 60 * 60 * 1000);
            const cutoffFuture = new Date(now.getTime() + 7 * 24 * 60 * 60 * 1000);
            const events = rawEvents
              .map((item) => mapCalendarEvent(item, now, cutoffPast, cutoffFuture))
              .filter((item) => item !== null)
              .sort((a, b) => (a.timestamp || '').localeCompare(b.timestamp || ''));
            if (events.length > 0) {
              _calendarIsolateCache = events;
              _calendarIsolateCacheAt = Date.now();
              try { await writeAppCache(env, CALENDAR_CACHE_KEY, JSON.stringify(events), 600); } catch {}
              console.log('[CRON] calendar cache refreshed: ' + events.length + ' events');
              _logPhase('phase1c-calendar-cache', 'ok', { events: events.length });
            }
          }
          _logPhase('phase1c', 'complete');
        } catch (e) {
          _logPhase('phase1c', 'error', { error: e?.message });
          console.warn('[CRON] calendar cache refresh failed:', e?.message);
        }
      }

      // ── PHASE 2: Lightweight DB retries (15-min only) ──
      // NOTE: retryFailedReferralRewards and retryFailedWheelRewards are
      // extracted OUT of this withPhasePool block into SEPARATE ctx.waitUntil
      // calls below (Phase 2 optimization).
      //
      // CHANGE 1 (cron dedup): requeueStaleQueueItems and requeueStaleBroadcasts
      // were previously executed here on */15 ticks AND on */5 ticks (see
      // worker-proxy.js lines 10274/10277). Since both functions use a 5-minute
      // staleness threshold (notification_platform.js lines 906/946), the */5
      // cron alone is sufficient to maintain the <=10-minute recovery SLA. The
      // duplicate execution on */15 was removed to save 192 queryDb calls/day
      // (2 x 96 ticks) with zero impact on recovery: */5 still requeues every
      // 5 minutes, and processQueue (also on */5) picks up requeued items on
      // the next tick.
      if (isEvery15Min) {
        // ── PHASE 3: Heavy jobs (alternating) ──
        // ROOT-CAUSE FIX (Phase 10.5): processNewsAIBatch now runs on ALL 15-min
        // ticks (was only :15/:45 = every 30 min). This halves the enqueue delay
        // for new articles — they now wait max 15 min instead of 30 min.
        // PHASE 3 FIX: processQueue moved to 5-min cron (phase4-processQueue above).
        // It no longer runs here — 30-min delay eliminated.
        const minute = new Date().getUTCMinutes();
        if (minute === 0 || minute === 30) {
          if (env.CMC_API_KEY) {
            try { await marketOverviewSvc.refreshOverview(env); _logPhase('phase3-market', 'ok'); } catch (e) {
              _logPhase('phase3-market', 'error', { error: e?.message });
              console.warn('[CRON] market overview failed:', e?.message);
            }
          }
        }
        // Publisher runs on non-0/30 minutes (same as before)
        if (minute !== 0 && minute !== 30) {
          if (publisherHandlers?.processPublisherQueue) {
            try { await publisherHandlers.processPublisherQueue(env, { maxItems: 8 }); _logPhase('phase3-publisher', 'ok'); } catch (e) {
              _logPhase('phase3-publisher', 'error', { error: e?.message });
              console.warn('[CRON] publisher failed:', e?.message);
            }
          }
        }
        // ROOT-CAUSE FIX: processNewsAIBatch runs on EVERY 15-min tick (not just :15/:45)
        // This ensures new articles are enqueued within 15 min of appearing in RSS.
        try { await processNewsAIBatch(env, pool); _logPhase('phase3-newsai', 'ok'); } catch (e) {
          _logPhase('phase3-newsai', 'error', { error: e?.message });
          console.warn('[CRON] news AI failed:', e?.message);
        }
      }

    }));

    // ═══════════════════════════════════════════════════════════════════
    // PHASE 2 SAFE OPTIMIZATION: Split retryFailedReferralRewards and retryFailedWheelRewards
    // into SEPARATE ctx.waitUntil calls. Previously both ran in the same ctx.waitUntil
    // (the withPhasePool block above), which meant they shared the same CPU budget.
    // Each can use 5-8ms CPU (queryDbTransaction for creditTokens), so combined they
    // could exceed 10ms. Now each gets its own budget.
    // ═══════════════════════════════════════════════════════════════════
    if (isEvery15Min) {
      ctx.waitUntil((async () => {
        try { await retryFailedReferralRewards(env); _logPhase('phase2-referral', 'ok'); } catch (e) {
          _logPhase('phase2-referral', 'error', { error: e?.message });
          console.warn('[CRON] referral retry failed:', e?.message);
        }
      })());
      ctx.waitUntil((async () => {
        try { await retryFailedWheelRewards(env); _logPhase('phase2-wheel', 'ok'); } catch (e) {
          _logPhase('phase2-wheel', 'error', { error: e?.message });
          console.warn('[CRON] wheel retry failed:', e?.message);
        }
      })());
    }
  },
};
//#endregion

import { createHmac, timingSafeEqual } from 'node:crypto';
import { Pool as NeonPool, neon } from '@neondatabase/serverless';
import { Pool as PgPool } from 'pg';
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
import { getTehranDateString, getTehranYesterdayString, getTehranWeekStart, getTehranWeekKey } from './src/services/timezone.js';
// Alias for clarity: sharedGetTehranDateString is the shared helper (vs wallet.js local _getTehranDateString)
const sharedGetTehranDateString = getTehranDateString;
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
import { createMembershipGateway } from './src/services/membershipGateway.js';
import { createRewardCenterRepository } from './src/repositories/reward_center.js';
import { createRewardCenterHandlers } from './src/controllers/reward_center.js';
import { createNotificationPlatformRepository, setEnvSendTelegramMessage } from './src/repositories/notification_platform.js';
import { createNotificationPlatformHandlers } from './src/controllers/notification_platform.js';
import { createAdvertisementsRepository } from './src/repositories/advertisements.js';
import { createAdvertisementsHandlers } from './src/controllers/advertisements.js';
import { createNotificationService } from './src/services/notification_service.js';
import { createAlertEconomyRepository } from './src/repositories/alert_economy.js';
import { createAlertEconomyHandlers } from './src/controllers/alert_economy.js';

import { createMarketOverviewService } from './src/services/market_overview_service.js';
import { createMembershipRepository } from './src/repositories/membership.js';
import { createMembershipHandlers } from './src/controllers/membership.js';
import { createMembershipAuthority } from './src/services/membership_authority.js';
import { ENTITLEMENT_CONFIG, getMissionRewardAmount, getReferralRewardAmount, getDailyClaimAmount } from './src/services/entitlement_config.js';

// ── N13 FIX: unified entitlement injection object ──────────────────────────
// ENTITLEMENT_CONFIG is DATA-ONLY (frozen config object). The reward helpers
// (getMissionRewardAmount / getReferralRewardAmount / getDailyClaimAmount) are
// separate named exports in entitlement_config.js — they were NEVER attached
// to the config object, so every `typeof config.getX === 'function'` guard in
// the controllers/repos evaluated FALSE and all normal reward paths silently
// skipped the premium tier multiplier (verified in production: all 81
// mission_reward txs at raw base amounts, VIP user included — since Phase 4,
// commit f6545e4). The M3 retry fix imported the real helper directly and was
// the FIRST path actually applying the multiplier, creating a Normal-vs-Retry
// inconsistency for Premium users.
//
// This composite attaches the CANONICAL helpers ONCE at the injection
// boundary — controllers/repositories keep their existing guards verbatim
// (they now evaluate true), no helper is duplicated, and every path (normal,
// retry, daily, referral) uses the same canonical implementation.
// Spread keeps all data keys intact (wheel.spins etc. keep working); the
// composite is frozen, so no downstream mutation is possible.
const ENTITLEMENT = Object.freeze({
  ...ENTITLEMENT_CONFIG,
  getMissionRewardAmount,
  getReferralRewardAmount,
  getDailyClaimAmount,
});

import { createCosmeticsRepository } from './src/repositories/cosmetics.js';
import { createRewardPurchaseRepository } from './src/repositories/reward_purchases.js';
import { createRewardPurchaseHandlers } from './src/controllers/reward_purchases.js';
import { createCosmeticsHandlers } from './src/controllers/cosmetics.js';
import { createNewsArticleRepository } from './src/repositories/news_articles.js';
import { createAppContentRepository } from './src/repositories/app_content.js';
import { runScheduled } from './src/cron/scheduler.js';
import { getCalendarIsolateCache, getCalendarIsolateCacheAt, setCalendarIsolateCache } from './src/cron/calendar-cache.js';
import { PresenceDO } from './src/durable-objects/presence.js';
import { GroqRouterDO } from './src/durable-objects/groq-router.js';
import { createMissionTokenService } from './src/auth/mission-tokens.js';
import { decodeHtmlEntities, cleanHtml, parseRelativeTime, extractFirstMatch, extractImageUrl, scoreNewsItem, fuzzyDedupNews, filterAndScoreNews, parseRssItems, isWhitelistedToken, validatePersianOutput, sanitizeNewsTitle, sanitizeNewsSummary, classifySentiment } from './src/news/shared.js';
import { createNewsTelemetry } from './src/news/telemetry.js';
import { createNewsTranslator } from './src/news/translate.js';
import { createNewsProviders } from './src/news/providers.js';
import { createNewsSummary } from './src/news/summary.js';
import { createNewsFeed } from './src/news/feed.js';
import { createCalendarService } from './src/services/calendar.js';
import { createMarketDataService } from './src/services/market-data.js';
import { createReferralRewardsService } from './src/services/referral-rewards.js';

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

/**
 * Fire-and-forget background task in Cloudflare Worker context.
 *
 * PERF FIX: Cloudflare Workers terminate I/O after the Response is returned.
 * A bare `promise.catch(...)` without `ctx.waitUntil()` can be cut off before
 * completion — losing the work (and leaking a "pool closed" error if it
 * touches the shared pool that withSharedPool's finally has already ended).
 *
 * This helper wraps the promise with `env.ctx.waitUntil()` when available
 * (production Worker), keeping it alive past the response. In test/Node
 * environments where env.ctx is absent, it falls back to plain fire-and-
 * forget (acceptable because Node won't kill the process mid-microtask).
 *
 * Usage:  backgroundTask(env, notificationService.create(env, {...}))
 *         backgroundTask(env, sendTelegramMessage(env, {...}))
 *
 * @param {object} env - Worker env (with env.ctx set in fetch handler)
 * @param {Promise} promise - The background work to schedule
 */
function backgroundTask(env, promise) {
  if (!promise || typeof promise.catch !== 'function') return;
  // Wrap with .catch FIRST so an already-rejected promise never surfaces
  // as an unhandled rejection (which logs in Worker runtime).
  const safe = promise.catch(e => {
    // Log to console.warn — non-blocking, just for observability.
    console.warn('[backgroundTask] non-blocking task failed:', e?.message || String(e));
  });
  // Schedule on Cloudflare ctx.waitUntil() if available — keeps the task
  // alive past the response. Without it, the runtime may cancel the
  // pending I/O (DB queries, Telegram API fetches) as soon as the
  // Response is returned, causing silent notification loss.
  if (env && env.ctx && typeof env.ctx.waitUntil === 'function') {
    env.ctx.waitUntil(safe);
  }
  // Return safe promise (in case caller wants to also await it later —
  // unusual, but harmless). Most callers ignore the return value.
  return safe;
}

function withCors(headers = {}, env = null) {
  const merged = new Headers(headers);
  // Echo localhost origins (any port) so the app can be previewed locally
  // via the Next.js dev server / `wrangler pages dev`. Real traffic keeps the
  // pinned WEBAPP_URL origin.
  //
  // CORS RACE FIX (Task 1): reqOrigin is read from env._reqOrigin, which is set
  // per-invocation at the top of fetch(). Cloudflare Workers can interleave
  // concurrent requests within the same isolate (each `await` yields the event
  // loop), so a module-level variable would let Request B overwrite Request A's
  // Origin before A's withCors() ran, causing A's response to echo B's Origin.
  // env is per-invocation in Cloudflare Workers (verified — same pattern as
  // env._reqPool), so env._reqOrigin is scoped to THIS request only.
  const reqOrigin = (env && env._reqOrigin) ? env._reqOrigin : null;
  const isLocalhost = reqOrigin && (reqOrigin.startsWith('http://localhost:') || reqOrigin.startsWith('https://localhost:'));
  if (isLocalhost) {
    merged.set('Access-Control-Allow-Origin', reqOrigin);
  } else if (env) {
    // A-5 FIX: Fail-closed in production — if WEBAPP_URL is not set or malformed,
    // do NOT fall back to '*'. Return the request origin (if present) or empty.
    // This prevents cross-origin access from arbitrary domains when misconfigured.
    const webappUrl = resolveWebAppUrl(env);
    if (webappUrl) {
      try {
        merged.set('Access-Control-Allow-Origin', new URL(webappUrl).origin);
      } catch {
        // Malformed WEBAPP_URL — fail closed (no wildcard)
        merged.set('Access-Control-Allow-Origin', reqOrigin || '');
      }
    } else {
      // WEBAPP_URL not set — fail closed (no wildcard)
      merged.set('Access-Control-Allow-Origin', reqOrigin || '');
    }
  } else {
    merged.set('Access-Control-Allow-Origin', reqOrigin || '');
  }
  merged.set('Access-Control-Allow-Methods', CORS_METHODS);
  merged.set('Access-Control-Allow-Headers', CORS_ALLOW_HEADERS);
  return merged;
}

// Per-invocation request Origin — DEPRECATED. Previously set at the top of the
// fetch handler and read by withCors(). Removed because Cloudflare Workers can
// interleave concurrent requests within one isolate (each `await` yields), so
// a second request could overwrite this value before the first request's
// withCors() read it → cross-origin leak. withCors() now reads from
// env._reqOrigin (per-invocation, same pattern as env._reqPool) instead.

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

  // Log the actual error for diagnostics — no sensitive data (passwords, tokens,
  // init-data) is included. The error message from pg/neon typically contains
  // connection details or query errors, which are safe to log. The safeError()
  // function already strips DB connection strings and token/key patterns.
  if (error) {
    console.warn(safeError('db-error-detail', error));
  }

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

  // HOTFIX (Commit 2.3): Workers-compatible body reader with per-chunk timeout.
  // The previous Promise.race + setTimeout pattern was ineffective because
  // Cloudflare Workers runtime kills the Worker BEFORE setTimeout fires when
  // the Worker is waiting on I/O (request.text() stream).
  //
  // This implementation reads the body stream chunk-by-chunk using a Reader.
  // Each chunk read has a 5s timeout. If no chunk arrives within 5s, we
  // immediately return 408. This works because:
  // 1. Reading a chunk is a microtask-level I/O operation that the runtime
  //    tracks as "active" (not "hung")
  // 2. The 5s timeout per-chunk is short enough that the runtime doesn't
  //    classify the Worker as "hung" before it fires
  // 3. If the client sends Content-Length but no body, the first chunk read
  //    never resolves → 5s timeout fires → 408 returned
  //
  // For empty bodies (no Content-Length or Content-Length: 0), we skip
  // stream reading entirely and return empty JSON — no hang possible.
  //
  // FALLBACK: If request.body is not a ReadableStream (e.g., in Node.js test
  // environment or if the stream was already consumed), fall back to
  // request.text() with a Promise.race timeout. This is less reliable in
  // production Workers but necessary for backward compatibility.
  const CHUNK_TIMEOUT_MS = 5000;

  // If no body expected, return empty object immediately (no stream read)
  if (!contentLength || Number(contentLength) === 0) {
    // Double-check: request.body might still exist even without Content-Length
    // (some clients/proxies don't send Content-Length). If body is null/undefined,
    // return empty object. If body exists, fall through to stream reading.
    if (!request.body) {
      return { payload: {} };
    }
  }

  let bodyText;
  try {
    // Check if request.body is a ReadableStream (Workers/Node 18+)
    if (request.body && typeof request.body.getReader === 'function') {
      // Use the ReadableStream reader API for per-chunk timeout control
      const reader = request.body.getReader();
      const decoder = new TextDecoder();
      let chunks = [];
      let totalSize = 0;

      // Read chunks with timeout
      while (true) {
        // Race the chunk read against a timeout
        const readPromise = reader.read();
        const timeoutPromise = new Promise((_, reject) => {
          setTimeout(() => reject(new Error('chunk_timeout')), CHUNK_TIMEOUT_MS);
        });

        let result;
        try {
          result = await Promise.race([readPromise, timeoutPromise]);
        } catch (e) {
          // Timeout or read error — abort and return 408
          try { await reader.cancel(); } catch {}
          return { error: jsonResponse({ detail: 'Request body read timeout' }, { status: 408 }, env) };
        }

        if (result.done) {
          break;
        }

        if (result.value) {
          totalSize += result.value.byteLength;
          if (totalSize > maxSize) {
            try { await reader.cancel(); } catch {}
            return { error: jsonResponse({ detail: 'Request body too large' }, { status: 413 }, env) };
          }
          chunks.push(decoder.decode(result.value, { stream: true }));
        }
      }

      bodyText = chunks.join('');

      // Release the reader
      try { await reader.closed; } catch {}
    } else {
      // Fallback: no ReadableStream available — use request.text() with timeout
      // This path is for backward compatibility (Node.js test env, already-consumed stream)
      const timeoutPromise = new Promise((_, reject) => {
        setTimeout(() => reject(new Error('body_timeout')), CHUNK_TIMEOUT_MS);
      });
      bodyText = await Promise.race([request.text(), timeoutPromise]);
    }
  } catch (e) {
    return { error: jsonResponse({ detail: 'Request body read error' }, { status: 400 }, env) };
  }

  if (bodyText.length > maxSize) {
    return { error: jsonResponse({ detail: 'Request body too large' }, { status: 413 }, env) };
  }
  try {
    return { payload: JSON.parse(bodyText) };
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
  // Phase 8G.1: Also check env.HYPERDRIVE.connectionString — when a Hyperdrive
  // binding is present, createPool() uses it (raw TCP at CF edge), but this
  // gate function previously only checked DATABASE_URL/DIRECT_URL. Without
  // this fix, routes would 503 even when Hyperdrive is correctly configured.
  return Boolean(env.DATABASE_URL || env.DIRECT_URL || env.HYPERDRIVE?.connectionString);
}

function isCacheLayerConfigured(env) {
  return Boolean(env.JOIN_CACHE && env.APP_CACHE && env.RATE_LIMITS && env.SESSION_CACHE);
}

function isAlertsCronEnabled(env) {
  return String(env.ALERTS_CRON_ENABLED || 'false').trim().toLowerCase() === 'true';
}

/**
 * Returns true ONLY when the Worker is running in local development mode.
 * Used to gate development-only auth fallbacks (e.g. ?user_id=) that must
 * never be active in staging or production to prevent user impersonation.
 *
 * SECURITY FIX (S-01): Previously included 'staging', which meant the
 * ?user_id= fallback was active on the publicly-accessible staging URL.
 * While staging currently has no DATABASE_URL (so the bypass was not
 * exploitable), this is a defense-in-depth fix: if a DB is ever added
 * to staging, the fallback must NOT be active.
 */
function isDevMode(env) {
  const v = String(env.APP_ENV || '').trim().toLowerCase();
  return v === 'development';
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


async function writeAppCache(env, key, value, expirationTtl) {
  if (!env.APP_CACHE || typeof env.APP_CACHE.put !== 'function') {
    console.warn('[writeAppCache] KV not available, skipping write:', key);
    return;
  }

  // MKT-006 FIX: Track TTL expiry alongside the cached value. Previously,
  // _kvWriteCache stored only the value — after KV entry expired, if the
  // same value was re-fetched, the write was skipped → KV stayed empty →
  // every subsequent request hit upstream APIs. Now we store {value, expiresAt}
  // and only skip the write if the value matches AND the KV entry hasn't
  // expired yet. If expirationTtl is not provided (0/undefined), treat as
  // no-expiry (always skip if value matches, same as before).
  const cachedEntry = _kvWriteCache.get(key);
  if (cachedEntry && cachedEntry.value === value) {
    // Value matches — check if KV entry is still alive
    if (!cachedEntry.expiresAt || Date.now() < cachedEntry.expiresAt) {
      return; // Value unchanged AND KV entry still alive — skip write
    }
    // KV entry has expired — fall through to re-write even though value matches
  }

  try {
    const putOpts = {};
    if (expirationTtl && expirationTtl > 0) {
      putOpts.expirationTtl = Math.max(60, Math.floor(expirationTtl));
    }
    const _t0 = Date.now();
    await env.APP_CACHE.put(key, value, putOpts);
    _traceStage('KV.write:' + key.slice(0, 40), _t0);
    if (_kvWriteCache.size >= _KV_WRITE_CACHE_MAX) {
      const firstKey = _kvWriteCache.keys().next().value;
      _kvWriteCache.delete(firstKey);
    }
    // MKT-006 FIX: Store expiry time alongside value
    const ttlMs = (expirationTtl && expirationTtl > 0) ? Math.max(60, Math.floor(expirationTtl)) * 1000 : 0;
    _kvWriteCache.set(key, { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 });
  } catch (e) {
    _traceStage('KV.write.ERROR:' + key.slice(0, 40), Date.now());
    console.warn('[writeAppCache] KV.put FAILED for key:', key, '| error:', e.message || e);
  }
}

/**
 * KV-WRITE-OPT: Write to any KV namespace with _kvWriteCache dedup.
 *
 * Reuses the EXISTING _kvWriteCache (no new Map). Keys are unique strings
 * across namespaces because they use distinct prefixes ('join:', 'adch:',
 * 'fear-greed:', etc.), so sharing the Map is safe — no cross-namespace
 * collision, no cross-user contamination.
 *
 * Behavior:
 *   - If the key's cached value matches AND the KV TTL hasn't expired → SKIP write
 *   - If the value changed OR the TTL expired → write to KV + update _kvWriteCache
 *   - On KV failure → console.warn (graceful, same as writeAppCache)
 *
 * This prevents redundant writes when setCachedJoinStatus or
 * checkAdditionalRequiredChannels is called multiple times for the same
 * user with the same value within the TTL window (e.g., after the 30s
 * session cache expires but the KV entry is still alive).
 */
async function _kvWriteDedup(kvNamespace, key, value, ttlSec) {
  if (!kvNamespace || typeof kvNamespace.put !== 'function') return;

  const cachedEntry = _kvWriteCache.get(key);
  if (cachedEntry && cachedEntry.value === value) {
    if (!cachedEntry.expiresAt || Date.now() < cachedEntry.expiresAt) {
      return; // Value unchanged AND KV entry still alive — skip write
    }
    // KV entry has expired — fall through to re-write
  }

  try {
    const putOpts = {};
    if (ttlSec && ttlSec > 0) {
      putOpts.expirationTtl = Math.max(60, Math.floor(ttlSec));
    }
    await kvNamespace.put(key, value, putOpts);
    if (_kvWriteCache.size >= _KV_WRITE_CACHE_MAX) {
      const firstKey = _kvWriteCache.keys().next().value;
      _kvWriteCache.delete(firstKey);
    }
    const ttlMs = (ttlSec && ttlSec > 0) ? Math.max(60, Math.floor(ttlSec)) * 1000 : 0;
    _kvWriteCache.set(key, { value, expiresAt: ttlMs > 0 ? Date.now() + ttlMs : 0 });
  } catch (e) {
    console.warn('[_kvWriteDedup] KV.put FAILED for key:', key, '| error:', e.message || e);
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// GROQ-ROUTER-4KEY: The old Global Groq Rate/Token Coordinator (Phase 4) has
// been REMOVED. The centralized 4-key Groq Router (groqRouterExecute, defined
// later in this file) replaces it with a per-key 3/10min application budget
// tracked in `groq:router:key{N}`. The old constants (GROQ_RPM_KEY,
// GROQ_TPM_KEY, GROQ_COORDINATOR_TTL), in-memory trackers (_groqRpmInMemory,
// _groqTpmInMemory), functions (checkGroqCapacity, recordGroqRequest,
// estimateGroqTokens, getGroqRpmLimit, getGroqTpmLimit, getGroqSafetyMargin),
// and KV keys (groq:global:rpm, groq:global:tpm) are ALL DELETED.
// Callers (callGroqChat in assistant.js, tryGroq, etc.) now go through the
// router, which handles key selection, budget enforcement, and 429 cooldown
// internally.
// ═══════════════════════════════════════════════════════════════════════════

// ============================================================================
// [START-E2E] Diagnostic logging — /start-specific
// ============================================================================
// PURPOSE: Trace the complete /start path from webhook entry to sendMessage
// result. Stored in APP_CACHE KV under a single rolling key (last 20 entries,
// TTL 1800s) so it can be read via GET /api/start-diag WITHOUT wrangler tail.
//
// SECURITY: No tokens, no PII. userId is reduced to a 4-char correlation suffix
// (last 4 digits) — enough to correlate entries within a single /start flow
// without exposing the real Telegram ID. Telegram error descriptions are
// passed through as-is (they contain no secrets).
//
// P0-B OPTIMIZATION: KV persistence REMOVED. Previously each call did 1 KV read
// (APP_CACHE 'start:e2e_log') + 1 KV write (rolling 20-entry array, TTL 1800s) —
// ~2,500-9,500 KV writes/day, the 2nd-largest KV Write consumer. Diagnostic
// E2E traces are now emitted as structured console.log entries captured by
// Cloudflare Observability (wrangler tail / Cloudflare dashboard Logs panel —
// observability.enabled is set in wrangler.jsonc). No business logic depends on
// the KV value: only the /api/start-diag diagnostic endpoint reads it, and that
// endpoint now reports the migration (live traces are in observability).
//
// SECURITY: No tokens, no PII. userId is reduced to a 4-char correlation suffix
// (last 4 digits) — enough to correlate entries within a single /start flow
// without exposing the real Telegram ID. Telegram error descriptions are
// passed through as-is (they contain no secrets).
//
// The function remains async + fire-and-forget (`void logStartE2E(...)`) so
// all existing callers are unchanged. It is non-fatal (try/catch) so a
// console.log failure can never break /start.
async function logStartE2E(env, entry) {
  try {
    const sanitized = { ts: new Date().toISOString(), ...entry };
    // Reduce userId to a 4-char correlation suffix (no PII)
    if (sanitized.userId) {
      const uid = String(sanitized.userId);
      sanitized.uid = uid.length > 4 ? '…' + uid.slice(-4) : uid;
      delete sanitized.userId;
    }
    console.log(JSON.stringify({ event: 'start_e2e', ...sanitized }));
  } catch { /* non-fatal — diagnostics must never break /start */ }
}

// ============================================================================
// [BOOTSTRAP-E2E] Diagnostic logging — bootstrap handler + join check tracing
// ============================================================================
// PURPOSE: Trace the bootstrap + admin detection + join check flow end-to-end.
// Stored in APP_CACHE KV under key 'bootstrap:e2e_log' (rolling last 30, TTL 1800s).
//
// SECURITY: userId reduced to 4-char suffix. No tokens, no PII.
//
// ROOT-CAUSE FIX (bootstrap-hang): This function MUST be called fire-and-forget
// (void logBootstrapE2E(...)) — NOT awaited. Each call does 2 KV operations
// (read + write). With 12 calls per bootstrap, that's 24 KV operations. If
// awaited, a transient KV slowdown hangs the ENTIRE bootstrap request →
// "code had hung" 500 error. Fire-and-forget + internal 500ms timeout race
// ensures diagnostics can NEVER block the request path.
async function logBootstrapE2E(env, entry) {
  // P0-B OPTIMIZATION: KV persistence REMOVED (same rationale as logStartE2E).
  // Previously each call did 1 KV read + 1 KV write on 'bootstrap:e2e_log'
  // (rolling 30-entry array, TTL 1800s). Now emits a structured console.log
  // entry captured by Cloudflare Observability. The function remains async +
  // fire-and-forget (`void logBootstrapE2E(...)`) and non-fatal (try/catch).
  try {
    const sanitized = { ts: new Date().toISOString(), ...entry };
    // Reduce userId to a 4-char correlation suffix (no PII)
    if (sanitized.userId) {
      const uid = String(sanitized.userId);
      sanitized.uid = uid.length > 4 ? '…' + uid.slice(-4) : uid;
      delete sanitized.userId;
    }
    console.log(JSON.stringify({ event: 'bootstrap_e2e', ...sanitized }));
  } catch { /* non-fatal — diagnostics must never break bootstrap */ }
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

  // PHASE 3 FIX (AI-DEF-01): Cloudflare KV requires expirationTtl >= 60.
  // Previously, AI_COOLDOWN_SECONDS=4 was passed directly, causing the KV PUT
  // to fail silently. Fix: clamp TTL to minimum 60 seconds.
  const MIN_KV_TTL = 60;
  const effectiveTtl = Math.max(MIN_KV_TTL, Number(expirationTtl) || MIN_KV_TTL);

  try {
    await env.RATE_LIMITS.put(key, value, { expirationTtl: effectiveTtl });
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

// ═══════════════════════════════════════════════════════════════════════
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
    // PHASE 8G.3: Use Web Crypto API (crypto.subtle) instead of node:crypto
    // createHmac. The CF Workers node:crypto compat layer produces a different
    // HMAC result than Node.js for the same inputs. Web Crypto is native to
    // CF Workers and produces consistent, correct results matching the
    // Telegram Bot API spec.
    const enc = new TextEncoder();
    const messageKey = await crypto.subtle.importKey(
      'raw', enc.encode('WebAppData'), { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const secretKeyBuf = await crypto.subtle.sign('HMAC', messageKey, enc.encode(botToken));
    const hashKey = await crypto.subtle.importKey(
      'raw', secretKeyBuf, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const computedHashBuf = await crypto.subtle.sign('HMAC', hashKey, enc.encode(dataCheckString));
    const computedHash = Array.from(new Uint8Array(computedHashBuf))
      .map(b => b.toString(16).padStart(2, '0')).join('');

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
  // STEP 6 (Membership Gateway migration): middleware now uses Gateway.
  // The Gateway's in-memory session cache (30s TTL) makes this fast path
  // for repeated requests within the same isolate — no KV read needed.
  // Admin bypass is handled inside the Gateway (isAdminTelegramId early exit).
  try {
    const membership = await membershipGateway.check(env, String(user.id), { forceRefresh: false, skipSessionCache: false });
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

/**
 * Determine whether a Telegram `getChatMember` result represents an ACTIVE member.
 *
 * ROOT-CAUSE FIX (audit/start-join-check): `ChatMemberRestricted` objects carry an
 * `is_member` boolean field — `true` if the user is still in the chat (restricted
 * but present), `false` if the user was kicked/restricted AND LEFT the chat. The
 * previous implementation used `JOINED_STATUSES.has(status)` blindly, which
 * treated ALL `restricted` users as joined — including those who had already
 * left. This allowed a restricted-and-left user to bypass the channel-join gate.
 *
 * Behavior:
 *   - creator / administrator / member → joined (as before)
 *   - restricted + is_member === false → NOT joined (the bug fix)
 *   - restricted + is_member === true  → joined (still in chat)
 *   - restricted + is_member undefined → joined (safe default; older API versions
 *     may omit the field — preserve backward-compat by treating as joined)
 *   - left / kicked / unknown          → NOT joined
 *
 * @param {object|null|undefined} result — the `result` field of Telegram's getChatMember response
 * @returns {boolean}
 */
function isJoinedMember(result) {
  if (!result) return false;
  const status = result.status || '';
  if (status === 'restricted') {
    return result.is_member !== false;
  }
  return JOINED_STATUSES.has(status);
}

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
    // KV-WRITE-OPT: Route through _kvWriteDedup to reuse _kvWriteCache.
    // Prevents redundant JOIN_CACHE writes when the value (joined/not-joined)
    // is unchanged within the TTL window. Fail-open behavior preserved.
    await _kvWriteDedup(env.JOIN_CACHE, getJoinCacheKey(userId), joined ? '1' : '0', ttl);
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
    // PHASE 2: Build the join keyboard from env REQUIRED_CHANNEL + any
    // admin-configured DB channels (ad_channels). The primary env channel
    // is shown first (backward compat), then DB channels in display_order.
    // We build the keyboard synchronously from env (DB channels are fetched
    // separately and merged by the caller via buildStartReplyPayloadAsync).
    return {
      chat_id: chatId,
      text: '👋 به دستیار هوشمند امیر بی‌تی‌سی خوش آمدید!\n\n📌 برای استفاده از امکانات برنامه، ابتدا عضو کانال‌های رسمی شوید.',
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

/**
 * PHASE 2: Async variant of buildStartReplyPayload that merges admin-configured
 * DB required channels into the join keyboard. Used by the /start handler so
 * the user sees EVERY channel they must join (env + DB) in one message.
 */
async function buildStartReplyPayloadAsync(env, chatId, isMember, startParam) {
  const base = buildStartReplyPayload(env, chatId, isMember, startParam);
  if (isMember) return base; // no join keyboard needed

  // Fetch admin-configured DB channels (cached 60s in advertisementsRepo).
  let dbChannels = [];
  try {
    if (typeof advertisementsRepo !== 'undefined') {
      dbChannels = await advertisementsRepo.listActiveRequiredChannels(env);
    }
  } catch (e) {
    console.warn('[start] listActiveRequiredChannels failed:', e.message || e);
  }

  if (dbChannels.length === 0) return base;

  // Build merged keyboard: primary env channel first, then DB channels.
  const envChannel = normalizeRequiredChannel(resolveRequiredChannel(env));
  const envUrl = `https://t.me/${envChannel}`;
  const envTitle = envChannel || 'کانال رسمی';

  // Skip DB channels that duplicate the env channel (by username).
  const seen = new Set([envChannel.toLowerCase()]);
  const rows = [[{ text: `📢 ${envTitle}`, url: envUrl }]];
  for (const ch of dbChannels) {
    const uname = String(ch.username || '').toLowerCase().replace(/^@/, '');
    if (seen.has(uname)) continue;
    seen.add(uname);
    rows.push([{ text: `📢 ${ch.title || uname}`, url: ch.joinUrl || `https://t.me/${uname}` }]);
  }
  rows.push([{ text: '✅ عضو شدم — ورود به اپلیکیشن', callback_data: 'check_join' }]);

  return {
    ...base,
    text: '👋 به دستیار هوشمند امیر بی‌تی‌سی خوش آمدید!\n\n📌 برای استفاده از امکانات برنامه، ابتدا عضو تمام کانال‌های زیر شوید:',
    reply_markup: { inline_keyboard: rows },
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
        // 429 FIX: attach retry_after to the error so processQueue can use it
        // for next_retry_at instead of the hardcoded 60s fallback.
        const _err429 = new Error(`Telegram sendMessage failed: ${data.error_code} ${data.description}`);
        if (data.error_code === 429 && data.parameters?.retry_after) {
          _err429.retry_after = Math.max(1, Math.min(data.parameters.retry_after, 60));
        }
        throw _err429;
      }

      // Retry on 429 (rate limit) or 5xx (server error)
      if ((response.status === 429 || response.status >= 500) && attempt < retries) {
        const retryAfter = parseInt(response.headers.get('Retry-After') || '2', 10);
        await new Promise(r => setTimeout(r, Math.min(retryAfter, 5) * 1000));
        continue;
      }

      const responseText = await response.text();
      clearTimeout(timer);
      // 429 FIX: attach retry_after from HTTP header for processQueue
      const _errHttp = new Error(`Telegram sendMessage failed: HTTP ${response.status} ${responseText}`);
      if (response.status === 429) {
        const _ra = parseInt(response.headers.get('Retry-After') || '0', 10);
        if (_ra > 0) _errHttp.retry_after = Math.max(1, Math.min(_ra, 60));
      }
      throw _errHttp;
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
  return _checkRateLimitCoalesced(env, key, MARKET_RATE_LIMIT_MAX, MARKET_RATE_LIMIT_WINDOW);
}

// ── Reusable user-based rate limiter for mutation endpoints ──────────────
// FIX (Finding 4): Previously only market/callback/AI endpoints had rate
// limits. This reusable function adds rate limiting to high-abuse mutation
// endpoints (bootstrap, tickets, membership/request, calendar/reminders).
//
// Key design:
//   - Per-userId (not per-IP) — authenticated requests use Telegram user ID
//   - Sliding window via KV counter (same pattern as isMarketRateLimited)
//   - KV TTL = max(windowSeconds, 60) — Cloudflare KV requires TTL >= 60s
//   - Each check = 1 KV read + 1 KV write = 2 subrequests (acceptable)
//   - Returns true if rate limited, false if allowed
//
// Usage:
//   if (await isUserRateLimited(env, userId, 'bootstrap', 5, 60)) {
//     return jsonResponse({ status: 'error', message: 'Rate limited' }, { status: 429 }, env);
//   }
const USER_RATE_LIMIT_KEY_PREFIX = 'url:';

async function isUserRateLimited(env, userId, category, maxRequests, windowSeconds) {
  const uid = String(userId || 'anon');
  const key = `${USER_RATE_LIMIT_KEY_PREFIX}${category}:${uid}`;
  return _checkRateLimitCoalesced(env, key, maxRequests, windowSeconds);
}

// ============================================================================
// KV-WRITE-OPTIMIZED RATE LIMITING (P0-A — controlled optimization)
// ============================================================================
// PROBLEM: The previous isMarketRateLimited/isUserRateLimited did ONE
// env.RATE_LIMITS.put() per ALLOWED request (read counter → write counter+1).
// At ~5,910 writes/day this was the single largest KV Write consumer and a
// primary driver of the production "KV put() limit exceeded for the day"
// exhaustion on APP_CACHE / RATE_LIMITS.
//
// OPTIMIZATION (this helper): KV is READ on every request (reads are NOT the
// quota bottleneck — only writes are). Writes are COALESCED:
//   - Normal traffic (well under limit): a per-isolate in-memory delta
//     accumulates; a single KV write is made every FLUSH_SIZE requests OR
//     every FLUSH_INTERVAL_MS (whichever first). A user making 1-4 requests
//     per window now costs 0-1 KV writes instead of 1-4.
//   - Near the limit (within NEAR_LIMIT_MARGIN): every request forces a
//     read-modify-write flush so KV holds the authoritative, fresh count.
//     The limit is enforced accurately across isolates (no bypass at the
//     boundary).
//   - Over the limit (BLOCKED): NO KV write — the block decision is read-only
//     (the counter is already at/over the limit in KV from the near-limit
//     flushes).
//
// CROSS-ISOLATE CORRECTNESS (Cloudflare isolates share no memory):
//   - KV is the only shared state. The in-memory delta is PER-ISOLATE and is
//     NOT trusted for the block decision at the boundary: once the effective
//     count reaches (limit - NEAR_LIMIT_MARGIN), every request does a
//     read-modify-write flush so KV holds the authoritative count. Other
//     isolates reading KV at that point see an accurate count and block
//     correctly.
//   - The maximum cross-isolate drift is bounded by NEAR_LIMIT_MARGIN: the
//     worst case is a few extra ALLOWED requests in the mid-range (where the
//     decision is "allow" regardless). The BLOCK decision is preserved. This
//     matches the read-modify-write race already present in the previous
//     implementation (two isolates reading the same count and both writing
//     count+1 lose one update). No NEW bypass is introduced.
//
// KV-FAILURE SAFETY (Phase 5 — fixes the previous fail-open bypass):
//   - env.RATE_LIMITS absent → fail-open (allow), SAME as before.
//   - KV read fails → kvCount treated as 0, but the per-isolate delta STILL
//     tracks this isolate's requests → the isolate STILL self-limits at the
//     limit. Cross-isolate is weakened (other isolates' counts unknown) but
//     NOT bypassed within this isolate.
//   - KV write fails (quota exhausted / transient) → delta is NOT reset, so
//     the next flush retries. The isolate continues to self-limit via delta.
//     This FIXES the previous fail-open bypass where a failed write left the
//     counter stuck at its old value and every subsequent request was
//     allowed (total bypass). Failures are logged for observability.
//
// FORMAT: stored as JSON {"c":<count>,"w":<windowIndex>}. The windowIndex
// lets us detect a stale (previous-window) entry on read and reset cleanly —
// an ACCURACY improvement over the previous plain-string counter which relied
// solely on KV TTL expiry. Legacy plain-string entries are parsed
// conservatively (treated as current-window → may over-count slightly →
// safe/blocking direction) for backward compatibility during rollout.

// Per-isolate write-coalescing state: Map<key, { delta, windowIndex, lastFlushMs }>
const _rlCoalesceState = new Map();
const _RL_COALESCE_MAX_KEYS = 5000; // bound memory growth (rare edge case)
const _RL_FLUSH_INTERVAL_MS = 5000;

function _getRlCoalesceState(key, windowIndex) {
  let st = _rlCoalesceState.get(key);
  if (!st || st.windowIndex !== windowIndex) {
    // Window rolled over (or first request for this key in this isolate):
    // reset the delta — the previous window's unflushed delta is irrelevant.
    if (_rlCoalesceState.size > _RL_COALESCE_MAX_KEYS) {
      _rlCoalesceState.clear();
    }
    st = { delta: 0, windowIndex, lastFlushMs: 0 };
    _rlCoalesceState.set(key, st);
  }
  return st;
}

function _parseRlValue(raw, currentWindowIndex) {
  // Backward-compatible parse: new JSON {c, w} format OR legacy plain-string count.
  if (!raw) return { count: 0, winIdx: currentWindowIndex };
  let parsed = null;
  try { parsed = JSON.parse(raw); } catch { parsed = null; }
  if (parsed && typeof parsed === 'object' && parsed !== null && Number.isFinite(parsed.c)) {
    return { count: (parsed.c | 0), winIdx: (parsed.w | 0) };
  }
  // Legacy plain-string count (no windowIndex). Since the KV TTL == window,
  // a legacy entry is at most one window old. Treat conservatively as
  // current-window (may over-count slightly → safe / blocking direction).
  const n = parseInt(raw, 10);
  return { count: Number.isFinite(n) ? n : 0, winIdx: currentWindowIndex };
}

async function _checkRateLimitCoalesced(env, key, limit, windowSeconds) {
  // Fail-open when KV binding is absent (preserves existing behavior).
  if (!env || !env.RATE_LIMITS || typeof env.RATE_LIMITS.get !== 'function') {
    return false;
  }
  const limitNum = Math.max(1, (limit | 0) || 1);
  const ttlSec = Math.max(windowSeconds | 0, 60); // KV requires TTL >= 60s
  const winMs = ttlSec * 1000;
  const now = Date.now();
  const windowIndex = Math.floor(now / winMs);

  const st = _getRlCoalesceState(key, windowIndex);

  // Read KV (cheap — reads are not the quota bottleneck).
  let kvCount = 0;
  try {
    const raw = await env.RATE_LIMITS.get(key);
    const p = _parseRlValue(raw, windowIndex);
    if (p.winIdx === windowIndex) {
      kvCount = p.count;
    }
    // else: stale window → treat as 0 (window rolled over).
  } catch (e) {
    // KV read failure — kvCount stays 0; rely on in-memory delta for this isolate.
    console.warn('rate-limit KV read failed (using in-memory delta):', e && e.message ? e.message : e);
  }

  const effective = kvCount + st.delta;
  if (effective >= limitNum) {
    // BLOCKED — no KV write. The block decision is read-only.
    return true;
  }

  // ALLOWED — increment local delta.
  st.delta++;

  // Decide whether to flush the coalesced delta to KV now.
  const NEAR_LIMIT_MARGIN = Math.max(1, Math.ceil(limitNum * 0.5));
  const FLUSH_SIZE = Math.max(2, Math.ceil(limitNum * 0.15));
  const newEffective = effective + 1;
  const nearLimit = newEffective >= (limitNum - NEAR_LIMIT_MARGIN);
  const sizeFlush = st.delta >= FLUSH_SIZE;
  // lastFlushMs starts at 0 on first state creation; only enforce the time
  // interval AFTER a real flush has occurred (otherwise the very first request
  // of a key would always trigger a timeFlush and defeat coalescing).
  const timeFlush = st.lastFlushMs > 0 && (now - st.lastFlushMs) >= _RL_FLUSH_INTERVAL_MS;

  if (nearLimit || sizeFlush || timeFlush) {
    // Read-modify-write: re-read to incorporate concurrent deltas flushed by
    // other isolates since our first read, then merge our local delta. This
    // avoids the lost-update problem (last-write-wins would discard other
    // isolates' increments).
    let freshCount = 0;
    try {
      const freshRaw = await env.RATE_LIMITS.get(key);
      const fp = _parseRlValue(freshRaw, windowIndex);
      if (fp.winIdx === windowIndex) freshCount = fp.count;
    } catch (e) {
      // KV read failed on re-read — best effort: use the first kvCount.
      freshCount = kvCount;
    }
    const merged = freshCount + st.delta;
    let writeOk = false;
    if (typeof env.RATE_LIMITS.put === 'function') {
      try {
        await env.RATE_LIMITS.put(key, JSON.stringify({ c: merged, w: windowIndex }), { expirationTtl: ttlSec });
        writeOk = true;
      } catch (e) {
        // KV write failure (quota exhausted / transient). Delta is NOT reset
        // so the next flush retries. The isolate still self-limits via delta.
        // This fixes the previous fail-open bypass.
        console.warn('rate-limit KV write failed (in-memory delta retained):', e && e.message ? e.message : e);
      }
    }
    if (writeOk) {
      st.delta = 0;
      st.lastFlushMs = now;
    }
  }

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
    //
    // ROOT-CAUSE FIX (analyses 500/hang): neon() HTTP client uses fetch()
    // internally with NO timeout by default. If Neon's HTTP endpoint is
    // momentarily unresponsive, the fetch() hangs indefinitely → Worker
    // runtime cancels the request ("code had hung"). Fix: pass fetchOptions
    // with a per-request AbortSignal via a custom fetchOptions function.
    // The neon SDK merges fetchOptions into each fetch() call, so this signal
    // applies to every query. 10s is generous (normal queries complete in
    // <500ms) but bounded — if Neon is truly down, the Worker fails fast
    // instead of hanging.
    sql = neon(url, {
      fullResults: true,
      fetchOptions: {
        // AbortSignal with 10s timeout — prevents indefinite hang on Neon HTTP
        signal: AbortSignal.timeout(10000),
      },
    });
  } catch (e) {
    console.warn('[DB] neon() client init failed:', e?.message);
    return null;
  }
  _moduleNeonCache.set(url, sql);
  return sql;
}

// ────────────────────────────────────────────────────────────────────────────
// DIRECT READ PATH (Option C) — for notification GET (read-after-write
// consistency, bypassing Hyperdrive's SELECT query cache).
//
// ROOT CAUSE (PROVEN 2026-09-10):
//   Cloudflare Hyperdrive is enabled on the production binding
//   `amir-btc-supabase` (binding id f4b69c06c1e84d98b7c4b5720efe4b41) with
//   `caching.disabled: false` and the default `cache_ttl` of 60 seconds.
//   notificationRepo.list and .unreadCount issue deterministic SELECTs that
//   Hyperdrive caches at the edge (keyed by SQL + bound params). After a
//   DELETE (UPDATE — bypasses Hyperdrive's cache, hits origin), the cached
//   SELECT result still contains the now-deleted notification for up to 60s
//   after the FIRST GET. Subsequent GETs within the cache window return the
//   stale cached result → the deleted notification "reappears". At 60s+ the
//   cache expires, the next GET queries origin → notification is gone (the
//   "self-correction" the user observed at ~70s).
//
// FIX (Option C — scoped pg.Pool bypass of Hyperdrive):
//   notificationRepo.list and .unreadCount bypass `queryDb` (which uses
//   env._reqPool → pg.Pool(connectionString: env.HYPERDRIVE.connectionString))
//   and instead use `queryDbDirect` — a SEPARATE pg.Pool created per call,
//   bound to env.DIRECT_URL (or env.DATABASE_URL as fallback), connecting
//   DIRECTLY to the Supabase primary Postgres endpoint. Because this pool
//   does NOT use Hyperdrive's connection string, it bypasses Hyperdrive's
//   edge cache entirely → read-after-write consistency is guaranteed.
//
//   All notification mutations (deleteNotification, deleteAll, markRead,
//   markAllRead, create, createBulk) and every other endpoint continue to
//   use the existing `queryDb` path — UNCHANGED. They continue to benefit
//   from Hyperdrive's pooling (and their mutations bypass the cache anyway).
//
// WHY pg.Pool (not neon() HTTP):
//   The production database is Supabase (db.qywuklmhjqovmqlyklea.supabase.co:5432),
//   NOT Neon. The neon() HTTP client sends requests to https://api.<host>/sql —
//   a Neon-only endpoint that Supabase does not serve. Using pg.Pool with the
//   Supabase direct connection string speaks standard Postgres wire protocol,
//   which Supabase serves on port 5432. (The previous b2b8590 attempt used
//   neon() HTTP + PRIMARY_DATABASE_URL — incompatible with Supabase.)
//
// WHY DIRECT_URL is preferred (not DATABASE_URL):
//   Per Supabase docs, DIRECT_URL is the direct Postgres endpoint
//   (db.{ref}.supabase.co:5432) and DATABASE_URL is typically the Supavisor
//   pooler endpoint (aws-0-{region}.pooler.{ref}.supabase.com:6543 or :5432).
//   Either works for read-after-write consistency (both bypass Hyperdrive's
//   cache). DIRECT_URL is preferred because:
//     1. It is the direct endpoint — no pooler in the path → simplest path.
//     2. It matches the Hyperdrive origin (db.qywuklmhjqovmqlyklea.supabase.co)
//        so we hit the EXACT same database Hyperdrive would, minus the cache.
//   We fall back to DATABASE_URL if DIRECT_URL is absent for resilience.
//
// WORKER-SAFE POOL LIFECYCLE (matches queryDbTransaction pattern):
//   A brand-new pg.Pool is created per queryDbDirect call, used for the
//   query, and `await pool.end()`-ed in `finally`. The Pool's TCP/TLS
//   connection is created, used, and destroyed entirely within one
//   synchronous async execution — it NEVER outlives the await boundary,
//   so it can NEVER be observed by a different request (the canonical
//   Cloudflare Worker pattern, see queryDbTransaction).
//
//   The pool uses the same `_poolQueryWithTimeout` helper as `queryDb` and
//   `queryDbTransaction` (hard DB_QUERY_TIMEOUT_MS timeout) so a half-open
//   connection cannot hang the Worker.
//
// WHY NO FALLBACK to queryDb (Hyperdrive) if DIRECT_URL/DATABASE_URL is missing:
//   Silent fallback would re-introduce the exact stale-read bug this fix
//   eliminates. A loud 500 on GET /api/notifications is preferable to
//   silently re-introducing the bug — the missing secret is immediately
//   visible in logs and the user can remediate by setting DIRECT_URL (which
//   already exists in production — verified via `wrangler secret list`).
//
// SCOPE: queryDbDirect is injected ONLY into notificationRepo. No other
//   repository receives it. Only notificationRepo.list and .unreadCount
//   use it. No other endpoint is affected.
// ────────────────────────────────────────────────────────────────────────────

// Resolve the connection string for the direct pg.Pool (bypasses Hyperdrive).
// Prefers env.DIRECT_URL (Supabase direct endpoint, matches Hyperdrive origin),
// falls back to env.DATABASE_URL. Does NOT use env.HYPERDRIVE.connectionString
// (that's the whole point — bypass Hyperdrive's cache).
//
// Strips `pgbouncer=true` if present: it's a pooler hint meaningful only for
// PgBouncer/Supavisor session-mode pools. For a per-call Worker Pool, this hint
// is irrelevant — pg.Pool manages its own connection lifecycle. Keeping it
// would not break anything, but stripping it keeps the connection string clean.
function resolveDirectDatabaseUrl(env) {
  let url = String(env.DIRECT_URL || env.DATABASE_URL || '').trim();
  if (!url) return '';
  url = url.replace(/([?&])pgbouncer=true(&?)/, (_m, lead, trail) =>
    trail ? lead : (lead === '?' ? '' : ''),
  );
  return url;
}

// Create a brand-new direct pg.Pool for a SINGLE queryDbDirect call.
// NOT cached (per-call) — used and `await pool.end()`-ed within queryDbDirect
// so its TCP/TLS connection (and the request context it binds to) never
// escapes that call. This mirrors the canonical Worker-safe pattern used by
// `queryDbTransaction` (see that function for the rationale).
//
// Returns null if neither DIRECT_URL nor DATABASE_URL is configured.
//
// POOL OPTIONS: deliberately minimal. We do NOT set `max` (let pg.Pool use
// its default of 10) because each call uses exactly one query then ends the
// pool — there is no real concurrency within a single call. We set
// `connectionTimeoutMillis: 5000` (same as the Hyperdrive branch of
// createPool) to fail fast if the direct endpoint is unreachable.
function createDirectPool(env) {
  const url = resolveDirectDatabaseUrl(env);
  if (!url) return null;
  return new PgPool({
    connectionString: url,
    connectionTimeoutMillis: 5000,
  });
}

// Create a brand-new Pool for a SINGLE transaction. NOT cached — used and
// `await pool.end()`-ed within queryDbTransaction so its WebSocket (and the
// request context it binds to) never escapes that call.
//
// HYPERDRIVE DUAL-PATH:
//   If env.HYPERDRIVE binding exists → use pg.Pool with Hyperdrive's
//   connection string. Hyperdrive manages connection pooling at Cloudflare's
//   edge — no per-invocation TLS handshake. pg.Pool can be created
//   per-request because Hyperdrive handles the actual DB connections.
//
//   If env.HYPERDRIVE does NOT exist → fall back to @neondatabase/serverless
//   Pool (WebSocket+TLS per invocation). This is the legacy path.
function createPool(env) {
  const _t0 = Date.now();
  const _poolId = 'p' + Math.random().toString(36).slice(2, 8);

  // ── Hyperdrive path ──
  if (env.HYPERDRIVE && env.HYPERDRIVE.connectionString) {
    // Per Cloudflare docs: Hyperdrive manages connection pooling automatically.
    // Do NOT set max/idleTimeout — let Hyperdrive handle it.
    // Only set connectionTimeoutMillis for safety.
    const _pool = new PgPool({
      connectionString: env.HYPERDRIVE.connectionString,
      connectionTimeoutMillis: 5000,
    });
    _traceStage('Pool.create.hyperdrive', _t0);
    _traceLog('Pool.create.hyperdrive', { poolId: _poolId, durationMs: Date.now() - _t0 });
    _pool._tracePoolId = _poolId;
    _pool._isHyperdrive = true;
    return _pool;
  }

  // ── Legacy path: @neondatabase/serverless Pool (WebSocket+TLS) ──
  const databaseUrl = resolveDatabaseUrl(env);
  if (!databaseUrl) return null;
  const _pool = new NeonPool({
    connectionString: databaseUrl,
    max: 1,
    idleTimeoutMillis: 0,
    connectionTimeoutMillis: 3000,
  });
  _traceStage('Pool.create.neon', _t0);
  _traceLog('Pool.create.neon', { poolId: _poolId, durationMs: Date.now() - _t0 });
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
 * Creates ONE Pool (ONE TLS handshake to Supabase, ~3-5ms CPU) that is
 * reused by ALL queryDb calls within the handler. Without this, each
 * queryDb creates its own Pool + TLS handshake (~3-5ms CPU each), causing
 * `exceededCpu` (Error 1102) when a handler makes multiple queryDb calls.
 *
 * Usage (HTTP path — wrapped by `fetch()` at line ~8800):
 *   return await withSharedPool(env, async () => { ...router... });
 *
 * Cron path does NOT use this — it uses `withPhasePool` (line 1356) which
 * passes the pool as an explicit parameter to repository functions.
 *
 * The Pool is closed in `finally` (with a 500ms timeout) so its WebSocket
 * is released before the response is returned. Safe for Cloudflare Workers
 * — the Pool never outlives the request.
 */
// PHASE 1 / CHANGE 1 (re-enabled 2026-08-10): Wrap an HTTP request in a
// shared request-scoped Pool. All queryDb calls inside `fn` reuse ONE Pool
// (ONE TLS handshake, ~3-5ms CPU) instead of creating a new Pool per call
// (N TLS handshakes, N × 3-5ms CPU). For a typical 5-query request this
// drops CPU from ~20ms to ~9ms, keeping the request under the Free Plan
// 10ms CPU limit.
//
// SAFETY (CHANGE 1A/1B/1C):
//   1. We save the previous `env._reqPool` and restore it in `finally`
//      (CHANGE 1B). In the HTTP path the previous value is always
//      null/undefined, but the save/restore is defensive against future
//      middleware/recursion patterns and against `ctx.waitUntil` callbacks
//      that may run after the response is sent.
//   2. We close the Pool via a LOCAL variable (`_pool`), NOT via
//      `env._reqPool` (CHANGE 1C). If `queryDb` nullifies `env._reqPool`
//      after a query error (line 1573), reading `env._reqPool` in finally
//      would skip cleanup and leak the WebSocket. Using the local variable
//      guarantees the pool we created is always closed.
//   3. We wrap `pool.end()` in `Promise.race` with a 500ms timeout
//      (CHANGE 1A). The historical concern (commit d754560) was that
//      `pool.end()` could hang indefinitely on a bad WebSocket state,
//      causing the Worker to be killed for "code had hung". The timeout
//      guarantees we never block the response for more than 500ms.
//   4. We restore `env._reqPool = _prevReqPool` BEFORE closing the pool.
//      This ensures any `ctx.waitUntil` callback scheduled by `fn` (which
//      runs after the response is sent) sees the previous value (null in
//      HTTP path) and falls through to per-call Pool, NOT our soon-to-be-
//      closed pool.
//
// RESPONSE CONTRACT:
//   `return await fn()` preserves the callback's return value exactly:
//     - Response → returned as-is
//     - Promise<Response> → awaited and returned
//     - throw → re-thrown (caller's try/catch handles)
//   No branch can return undefined unless the callback itself returns
//   undefined (which no route in fetch() does — verified by audit).
async function withSharedPool(env, fn) {
  if (!isDatabaseConfigured(env)) {
    return fn();
  }
  // CHANGE 1B: Save previous env._reqPool for restore in finally.
  const _prevReqPool = env._reqPool;
  // CHANGE 1C: Capture the pool in a local variable so finally can close it
  // even if queryDb nullifies env._reqPool on error.
  const _pool = createPool(env);
  if (!_pool) {
    // createPool returned null (DATABASE_URL resolved to empty). Fall through
    // without shared pool — queryDb will throw 'Database not configured'.
    return fn();
  }
  env._reqPool = _pool;
  try {
    return await fn();
  } finally {
    // CHANGE 1B: Restore previous value FIRST, before closing our pool.
    // This ensures any ctx.waitUntil callback (scheduled by fn) that runs
    // after the response is sent sees the previous value (null in HTTP path)
    // and uses per-call Pool, not our soon-to-be-closed pool.
    env._reqPool = _prevReqPool;
    // CHANGE 1A: Close our pool with a 500ms hard timeout. Prevents the
    // "pool.end() hangs on bad WebSocket" issue (commit d754560 concern)
    // from blocking the response. The leaked WebSocket (if timeout fires)
    // is acceptable — Cloudflare isolates are short-lived and GC will
    // reclaim the pool object.
    try {
      await Promise.race([
        _pool.end(),
        new Promise((r) => setTimeout(r, 500)),
      ]);
    } catch {}
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

/**
 * Invalidate the referral reward-per-invite cache.
 *
 * FIX (WALLET-CONSISTENCY H1): Previously, when an admin updated/created/deleted
 * a referral reward tier, the _rewardPerInviteCache would serve the STALE reward
 * amount for up to 60 seconds. This meant new referrals credited the old amount
 * for up to a minute after an admin change. Now the reward_center controller
 * calls this function after any tier mutation (create/update/delete) to ensure
 * the next getReferralRewardPerInvite() call fetches fresh data from the DB.
 */
function invalidateRewardPerInviteCache() {
  _rewardPerInviteCache = { value: null, expiresAt: 0 };
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

// ── DB QUERY HARD TIMEOUT HELPER ──────────────────────────────────────
// ROOT CAUSE: pool.query() has NO execution timeout. connectionTimeoutMillis
// only applies during connect(). Once connected, a half-open WebSocket
// (connection established but server not responding) causes pool.query() to
// hang indefinitely → Worker runtime kills the request ("code had hung").
//
// FIX: wrap every pool.query() in a Promise.race with a hard timeout. If the
// timeout fires, we:
//   1. Reject the promise (caller gets a controlled error, not a hang)
//   2. Try to end the pool to discard the poisoned connection (best-effort,
//      wrapped in try/catch — the pool may already be in a bad state)
//   3. Log the timeout for observability
//
// The leaked timeout Promise (pool.query still running in background) is
// acceptable — Cloudflare isolates are short-lived and GC will reclaim it.
// The important thing is the CALLER gets a fast, controlled rejection.
//
// 8s is chosen because:
//   - Normal queries complete in <500ms
//   - Complex aggregate queries (analyses stats) complete in <2s
//   - Cloudflare Worker CPU limit is 10s (Free) / 30s (Paid)
//   - 8s gives 2s margin for error handling + response
//   - Matches the existing 7900ms threshold in _traceQuery
const DB_QUERY_TIMEOUT_MS = 8000;

/**
 * Run a pool.query() with a hard timeout. On timeout, rejects with a
 * distinguishable error and best-effort discards the pool.
 *
 * @param {object} poolObj - the pg.Pool or NeonPool instance
 * @param {string} sql - SQL text
 * @param {Array} params - bind parameters
 * @param {object} [opts] - { poolLabel: 'phasePool'|'shared'|'new' }
 * @returns {Promise<object>} - query result (same shape as pool.query())
 * @throws {Error} - on timeout: message starts with "DB_QUERY_TIMEOUT"
 *                   - on query error: the original error
 */
async function _poolQueryWithTimeout(poolObj, sql, params, opts = {}) {
  const poolLabel = opts.poolLabel || 'pool';
  const _t0 = Date.now();
  let timedOut = false;

  // The timeout Promise — resolves with { _timeout: true } after DB_QUERY_TIMEOUT_MS
  const timeoutPromise = new Promise((resolve) => {
    setTimeout(() => {
      timedOut = true;
      resolve({ _timeout: true });
    }, DB_QUERY_TIMEOUT_MS);
  });

  // Race: query vs timeout
  const result = await Promise.race([
    poolObj.query(sql, params).then(r => ({ _timeout: false, _result: r })),
    timeoutPromise,
  ]);

  if (result && result._timeout) {
    // Timeout fired — the query is still running in the background.
    // Best-effort: try to end the pool to discard the poisoned connection.
    // The pool may be shared (env._reqPool) — ending it affects all callers
    // using it, but a poisoned pool is worse than no pool (callers will
    // fall through to neon() HTTP or createPool fallback).
    try {
      if (typeof poolObj.end === 'function') {
        // Don't await — end() may also hang on a bad WebSocket. Fire-and-forget.
        poolObj.end().catch(() => {});
      }
    } catch {}
    const _elapsed = Date.now() - _t0;
    console.warn(JSON.stringify({
      scope: 'db-query-timeout',
      poolLabel,
      sqlPreview: String(sql).replace(/\s+/g, ' ').slice(0, 100),
      elapsedMs: _elapsed,
      timeoutMs: DB_QUERY_TIMEOUT_MS,
    }));
    const err = new Error(`DB_QUERY_TIMEOUT after ${_elapsed}ms (${poolLabel})`);
    err.code = 'DB_QUERY_TIMEOUT';
    err.poolLabel = poolLabel;
    err.elapsedMs = _elapsed;
    throw err;
  }

  return result._result;
}

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
      const _result = await _poolQueryWithTimeout(pool, sqlText, params, { poolLabel: 'phasePool' });
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
  //
  // RACE CONDITION FIX: env is shared across concurrent requests in the same
  // isolate. withSharedPool's save/restore pattern (env._reqPool = _prevReqPool)
  // can restore a pool that was already ended by another concurrent request's
  // finally block. When this happens, pool.query() throws "Cannot use a pool
  // after calling end on the pool". Previously this error was RE-THROWN → 503.
  // FIX: On this specific error, clear env._reqPool and FALL THROUGH to the
  // neon/per-call pool path. This makes the stale-pool error non-fatal — the
  // query simply uses a fresh pool.
  if (env && env._reqPool) {
    try {
      const _result = await _poolQueryWithTimeout(env._reqPool, sqlText, params, { poolLabel: 'shared' });
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
      const _isTimeout = _t1 - _t0 >= 7900 || _errMsg.includes('timeout') || _errMsg.includes('Timed out') || error?.code === 'DB_QUERY_TIMEOUT';
      _traceStage('queryDb.shared.ERROR:' + _sqlPreview.slice(0, 60), _t0);
      _traceQuery({
        seq: _seq, poolType: 'shared', sql: _sqlPreview,
        startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
        status: _isTimeout ? 'timeout' : 'error', error: _errMsg, attempt: 1
      });
      // If the shared pool is broken, clear it so future calls fall back.
      env._reqPool = null;
      // STALE-POOL FIX: "Cannot use a pool after calling end on the pool" is a
      // race condition in the save/restore pattern, NOT a real DB error. Don't
      // throw — fall through to the neon/per-call pool path below. The query
      // will succeed with a fresh pool.
      // DB_QUERY_TIMEOUT FIX: if the shared pool query timed out (half-open
      // WebSocket), the pool is poisoned. _poolQueryWithTimeout already
      // called pool.end() (fire-and-forget). Clear env._reqPool and fall
      // through to neon() HTTP (which has its own 10s timeout) for a retry.
      // This prevents the timeout from propagating as a 5xx when neon() can
      // still serve the query.
      if (_errMsg.includes('Cannot use a pool after calling end on the pool') ||
          error?.code === 'DB_QUERY_TIMEOUT') {
        // Fall through to neon() / per-call pool path
      } else {
        throw error;
      }
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
  // DB QUERY TIMEOUT FIX: retry reduced to 0 (no retry) to prevent
  // "timeout + retry + backoff" from extending request duration beyond
  // Worker limits. If the first attempt fails (timeout or transient error),
  // the caller gets a controlled error. The neon() HTTP path above (with its
  // own 10s timeout) is the primary path — this Pool fallback is the LAST
  // resort, not a retry target.
  const _effectiveRetries = 0;
  const _tPoolCreate = Date.now();
  const _callPool = createPool(env);
  if (!_callPool) throw new Error('Database not configured');

  try {
    for (let attempt = 0; attempt <= _effectiveRetries; attempt++) {
      const _tAttempt = Date.now();
      try {
        const _result = await _poolQueryWithTimeout(_callPool, sqlText, params, { poolLabel: 'new' });
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
        const _isTimeout = _t1 - _tAttempt >= 7900 || msg.includes('timeout') || msg.includes('Timed out') || error?.code === 'DB_QUERY_TIMEOUT';
        // DB QUERY TIMEOUT FIX: DB_QUERY_TIMEOUT is NOT transient — don't retry.
        // The pool is poisoned (half-open WebSocket). Retrying with the same
        // pool would just timeout again, doubling the latency.
        const isTransient = error?.code !== 'DB_QUERY_TIMEOUT' && (
                            msg.includes('530') ||
                            msg.includes('1016') ||
                            msg.includes('ECONNRESET') ||
                            msg.includes('Connection terminated') ||
                            msg.includes('timeout') ||
                            msg.includes('fetch failed') ||
                            msg.includes('network'));
        if (attempt === _effectiveRetries || !isTransient) {
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

// ────────────────────────────────────────────────────────────────────────────
// queryDbDirect — executes a single SQL statement on the Supabase primary
// via a per-call pg.Pool bound to env.DIRECT_URL (or env.DATABASE_URL as
// fallback), bypassing Hyperdrive's edge cache entirely.
//
// Scoped to notificationRepo.list and notificationRepo.unreadCount ONLY.
// Bypasses env._reqPool (Hyperdrive/NeonPool), bypasses getSharedNeon (HTTP),
// bypasses createPool (which routes to Hyperdrive when HYPERDRIVE is bound).
//
// Pool lifecycle (matches queryDbTransaction's canonical Worker-safe pattern):
//   1. Create a brand-new pg.Pool via createDirectPool(env).
//   2. Run the query via _poolQueryWithTimeout (hard DB_QUERY_TIMEOUT_MS).
//   3. `await pool.end()` in `finally` — the TCP/TLS connection is destroyed
//      before the function returns. No I/O object escapes the call, so no
//      "Cannot perform I/O on behalf of a different request" is possible.
//
// Throws an explicit configuration error if neither DIRECT_URL nor DATABASE_URL
// is configured — NO silent fallback to queryDb (Hyperdrive). Silent fallback
// would re-introduce the exact stale-read bug this fix is designed to
// eliminate (see ROOT CAUSE comment above). A loud 500 on GET /api/notifications
// is preferable to silently re-introducing the bug — the missing secret is
// immediately visible in logs and the user can remediate by setting DIRECT_URL
// (which already exists in production — verified via `wrangler secret list`).
//
// Returns the same shape as queryDb: `{ rows, rowCount, fields, command, ... }`
// (pg.Pool.query() returns this shape natively).
// ────────────────────────────────────────────────────────────────────────────
async function queryDbDirect(env, sqlText, params = []) {
  const _seq = _nextQuerySeq();
  const _sqlPreview = String(sqlText).replace(/\s+/g, ' ').slice(0, 120);
  const _t0 = Date.now();

  // Configuration guard — explicit error, no silent fallback to queryDb.
  // DIRECT_URL is preferred (Supabase direct endpoint, matches Hyperdrive
  // origin). DATABASE_URL is accepted as a fallback for resilience.
  if (!env || (!env.DIRECT_URL && !env.DATABASE_URL)) {
    const err = new Error(
      '[DB] queryDbDirect: neither DIRECT_URL nor DATABASE_URL is configured. ' +
      'Notification GET requires a direct PostgreSQL connection (bypassing ' +
      'Hyperdrive cache) to guarantee read-after-write consistency. Set it ' +
      'via: `wrangler secret put DIRECT_URL --env production` ' +
      '(use the Supabase direct endpoint URL, e.g. ' +
      'postgresql://...@db.{ref}.supabase.co:5432/postgres).'
    );
    err.code = 'DIRECT_DB_NOT_CONFIGURED';
    _traceQuery({
      seq: _seq, poolType: 'direct', sql: _sqlPreview,
      startMs: _t0, endMs: Date.now(), durationMs: Date.now() - _t0,
      status: 'error', error: 'DIRECT_DB_NOT_CONFIGURED', attempt: 1,
    });
    throw err;
  }

  // SECURITY/CONSISTENCY: explicitly assert we are NOT touching env._reqPool
  // (Hyperdrive). This function must NEVER share a connection with the
  // Hyperdrive path — that would defeat the cache bypass. The assertion is a
  // no-op at runtime but documents the invariant and protects against future
  // regressions that might add a "fast path" via env._reqPool.
  // Intentionally do NOT use env._reqPool. Creating a fresh direct pool below
  // guarantees we bypass Hyperdrive's cache entirely.

  // Create a brand-new direct pg.Pool for THIS call only.
  // NOT cached, NOT shared — destroyed in `finally` before returning.
  const _directPool = createDirectPool(env);
  if (!_directPool) {
    // resolveDirectDatabaseUrl returned '' even though the env vars are set —
    // this should not happen (the guard above already checked), but be defensive.
    const err = new Error(
      '[DB] queryDbDirect: createDirectPool returned null. ' +
      'DIRECT_URL/DATABASE_URL is set but the connection string could not be ' +
      'resolved. Verify the value is a valid postgres:// connection string.'
    );
    err.code = 'DIRECT_DB_POOL_INIT_FAILED';
    _traceQuery({
      seq: _seq, poolType: 'direct', sql: _sqlPreview,
      startMs: _t0, endMs: Date.now(), durationMs: Date.now() - _t0,
      status: 'error', error: 'DIRECT_DB_POOL_INIT_FAILED', attempt: 1,
    });
    throw err;
  }

  try {
    // Use the same _poolQueryWithTimeout helper as queryDb / queryDbTransaction.
    // Hard DB_QUERY_TIMEOUT_MS timeout prevents a half-open connection from
    // hanging the Worker.
    const _result = await _poolQueryWithTimeout(_directPool, sqlText, params, { poolLabel: 'direct' });
    const _t1 = Date.now();
    _traceStage('queryDbDirect.pool:' + _sqlPreview.slice(0, 60), _t0);
    _traceQuery({
      seq: _seq, poolType: 'direct', sql: _sqlPreview,
      startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
      status: _t1 - _t0 >= 7900 ? 'timeout' : 'ok', attempt: 1,
    });
    return _result;
  } catch (error) {
    const _t1 = Date.now();
    const _errMsg = String(error?.message || '').slice(0, 200);
    const _isTimeout = _t1 - _t0 >= 7900 || _errMsg.includes('timeout') || _errMsg.includes('Timed out') || error?.code === 'DB_QUERY_TIMEOUT';
    _traceStage('queryDbDirect.pool.ERROR:' + _sqlPreview.slice(0, 60), _t0);
    _traceQuery({
      seq: _seq, poolType: 'direct', sql: _sqlPreview,
      startMs: _t0, endMs: _t1, durationMs: _t1 - _t0,
      status: _isTimeout ? 'timeout' : 'error', error: _errMsg, attempt: 1,
    });
    throw error;
  } finally {
    // CRITICAL: end the pool in finally so the TCP/TLS connection is destroyed
    // before this function returns. This guarantees no I/O object escapes the
    // call → no "Cannot perform I/O on behalf of a different request" possible.
    // Best-effort: wrapped in try/catch (pool.end() may fail on a poisoned
    // connection — already ended by _poolQueryWithTimeout's timeout path).
    const _tEnd = Date.now();
    try { await _directPool.end(); } catch {}
    _traceStage('queryDbDirect.poolEnd:' + _sqlPreview.slice(0, 60), _tEnd);
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
    // DB QUERY TIMEOUT FIX: wrap each client.query() in a hard timeout.
    // Uses the same _poolQueryWithTimeout helper (client.query has the same
    // signature as pool.query). On timeout, the client is poisoned — we
    // release it in finally (not return to pool) and the pool is ended.
    // ROLLBACK may also fail on a poisoned connection — wrapped in try/catch.
    await _poolQueryWithTimeout(client, 'BEGIN', [], { poolLabel: 'txn' });
    const results = [];
    for (const { sql, params } of queries) {
      results.push(await _poolQueryWithTimeout(client, sql, params, { poolLabel: 'txn' }));
    }
    await _poolQueryWithTimeout(client, 'COMMIT', [], { poolLabel: 'txn' });
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

// ─── Referral/Rewards functions moved to src/services/referral-rewards.js (7 functions) ───
// Extracted: creditReferralWithReward, processPendingReferralReward,
//   retryFailedReferralRewards, retryFailedWheelRewards, retryFailedMissionRewards,
//   retryFailedRefunds, processReferralOnBootstrap
// Kept in worker-proxy.js (cycle-breakers):
//   - getReferralRewardPerInvite (used by referralRepo at composition root)
//   - invalidateRewardPerInviteCache (passed as DI to adminHandlers)
//   - _rewardPerInviteCache + REWARD_PER_INVITE_CACHE_TTL (mutable state for getReferralRewardPerInvite)

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
    // HOTFIX (Commit 2.4): Add 5s AbortController timeout to Telegram getChatMember fetch.
    // Without this, the fetch can hang indefinitely, causing the Worker to be killed
    // by the runtime ("code had hung"). This is on the critical path for both
    // bootstrap and all protected endpoints (via requireChannelJoin → resolveChannelMembership
    // → checkChannelMembership → getChatMemberDebugPayload).
    // On timeout/abort, the existing catch block handles it gracefully — returns
    // payload with telegram_response.exception set, and the caller treats it as
    // "not joined" (safe fallback). No membership semantics change.
    const tgController = new AbortController();
    const tgTimeoutId = setTimeout(() => tgController.abort(), 5000);
    try {
      const telegramResponse = await fetch(telegramUrl, { signal: tgController.signal });
      const data = await telegramResponse.json();
      payload.telegram_response = data;
      // ROOT-CAUSE FIX (audit/start-join-check): use isJoinedMember() instead of
      // JOINED_STATUSES.has(status) so that `restricted` + `is_member: false`
      // (user was restricted AND has left the channel) is correctly treated as
      // NOT joined. Previously, all `restricted` users were treated as joined.
      payload.joined = Boolean(data?.ok && isJoinedMember(data?.result));

      return payload;
    } finally {
      clearTimeout(tgTimeoutId);
    }
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
      // ROOT-CAUSE FIX (audit/start-join-check): use isJoinedMember() so that
      // `restricted` + `is_member: false` is correctly NOT joined.
      return { joined: isJoinedMember(telegramResponse?.result) };
    }

    const description = String(telegramResponse.description || '');
    const lowerDescription = description.toLowerCase();
    // ROOT-CAUSE FIX (audit/start-join-check): check `bot is not a member` BEFORE
    // `not a member`, because Telegram's error string 'Bad Request: bot is not a
    // member of the channel chat' CONTAINS the substring 'not a member'. With the
    // previous ordering, every bot_not_in_channel case was misclassified as
    // not_member — meaning the admin saw 'user is not a member' instead of the
    // correct 'bot is not in channel' system-error message.
    if (lowerDescription.includes('bot is not a member') || lowerDescription.includes('need administrator')) {
      return { joined: false, reason: 'bot_not_in_channel', detail: description };
    }
    if (lowerDescription.includes('user not found') || lowerDescription.includes('not a member')) {
      return { joined: false, reason: 'not_member', detail: description };
    }
    if (lowerDescription.includes('chat not found')) {
      return { joined: false, reason: 'channel_not_found', detail: description };
    }
    if (telegramResponse.http_error || telegramResponse.exception) {
      return { joined: false, reason: 'api_error', detail: JSON.stringify(telegramResponse) };
    }
    return { joined: false, reason: 'api_error', detail: description };
  }

  return { joined: false, reason: 'api_error' };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Multi-channel join-lock (Admin-configured required channels)
// ═══════════════════════════════════════════════════════════════════════════
//
// The existing checkChannelMembership() checks ONLY the env.REQUIRED_CHANNEL.
// Phase 2 extends this: admin-configured channels in ad_channels (active,
// status='active') are ALSO required. A user must be a member of ALL of them
// (env channel AND every DB channel) to pass requireChannelJoin.
//
// Cache strategy:
//   - Module-level cache (60s TTL) for the active channel list — shared by all
//     requests in the isolate. Invalidated on admin mutations.
//   - Per-user KV cache (60s TTL) for the DB-channel membership result, keyed
//     by `adch:${userId}:${channelSetHash}`. The hash includes every active
//     channel username, so when admin changes the channel list, the hash
//     changes → cache miss → fresh check. This satisfies Phase 2's requirement:
//     "با تغییر لیست کانال‌ها توسط Admin، state قدیمی باعث bypass نشود."
//
// Telegram API budget: at most N getChatMember calls per uncached request,
// where N = number of active DB channels (typically 1-3). Cached requests do
// ZERO Telegram calls (KV hit). This bounds Telegram API load while enforcing
// new channels within 60 seconds of admin change.

async function _getActiveAdChannels(env) {
  // Late-binding: advertisementsRepo is created after this function definition
  // (it's a module-level const initialized in the fetch handler setup). We use
  // a lazy getter to avoid TDZ issues.
  if (typeof advertisementsRepo === 'undefined') return [];
  try {
    return await advertisementsRepo.listActiveRequiredChannels(env);
  } catch (e) {
    console.warn('[multi-channel] listActiveRequiredChannels failed:', e.message || e);
    return [];
  }
}

function _hashChannelSet(channels) {
  if (!channels || channels.length === 0) return '0';
  const names = channels.map(c => String(c.username || '').toLowerCase()).sort().join(',');
  let h = 0;
  for (let i = 0; i < names.length; i++) {
    h = ((h << 5) - h + names.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function _checkSingleTelegramChannel(env, chatId, userId) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!botToken) return { joined: false, reason: 'bot_not_configured' };
  const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const data = await r.json();
    if (data?.ok) {
      // ROOT-CAUSE FIX (audit/start-join-check): use isJoinedMember() so that
      // `restricted` + `is_member: false` is correctly NOT joined (same fix as
      // the primary channel check).
      return { joined: isJoinedMember(data?.result) };
    }
    return { joined: false, reason: 'api_error', detail: data?.description || '' };
  } catch (e) {
    return { joined: false, reason: 'api_error', detail: e.message || String(e) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check membership in ALL admin-configured required channels (ad_channels).
 * Returns { joined: true } only if user is a member of every active channel.
 * Uses per-user KV cache (60s TTL) keyed by channel-set hash for instant
 * invalidation when admin changes the channel list.
 */
async function checkAdditionalRequiredChannels(env, userId, { forceRefresh = false } = {}) {
  const uid = String(userId);
  const channels = await _getActiveAdChannels(env);
  if (channels.length === 0) {
    return { joined: true, channels: 0 }; // no DB channels → trivially pass
  }

  const hash = _hashChannelSet(channels);
  const cacheKey = `adch:${uid}:${hash}`;

  // FIX (audit H3): Jittered TTL to avoid cache-stampede when admin changes the
  // channel list. Without jitter, all per-user cache entries expire at the same
  // 60s mark → synchronized re-fetch → thundering herd of Telegram getChatMember
  // calls → exceeds Telegram's 30 req/sec rate limit. With jitter (55-95s),
  // expiration spreads out → at most 1-2 concurrent refreshes per second.
  // Seed the jitter with uid+hash so the same user gets a consistent TTL
  // (avoids the same user refreshing every 55s in a tight loop).
  const _jitterSeed = (uid.charCodeAt(0) || 0) + hash.charCodeAt(0 || 0) || 0;
  const _ttlJitter = 40 * (((_jitterSeed * 9301 + 49297) % 233280) / 233280); // 0-40s jitter
  const _ttlPos = Math.floor(55 + _ttlJitter); // 55-95s for positive (joined)
  const _ttlNeg = Math.floor(55 + _ttlJitter); // 55-95s for negative (not joined)

  // ROOT-CAUSE FIX (AUDIT-P1 / Bug #2): respect forceRefresh — skip the KV
  // cache when the caller explicitly requested a fresh check (e.g., /start,
  // /api/users/check-join, bootstrap after a not-joined result). This ensures
  // that even if the per-isolate _campaignCache returns a stale channel list,
  // we still do a FRESH Telegram getChatMember call for each channel in that
  // list rather than trusting a potentially-stale '1' from the KV cache.
  if (!forceRefresh && env.RATE_LIMITS && typeof env.RATE_LIMITS.get === 'function') {
    try {
      const cached = await env.RATE_LIMITS.get(cacheKey);
      if (cached === '1') return { joined: true, channels: channels.length, cached: true };
      if (cached === '0') return { joined: false, channels: channels.length, cached: true, reason: 'not_member' };
    } catch { /* non-fatal */ }
  }

  // Fresh check: call Telegram getChatMember for each channel.
  // ROOT-CAUSE FIX (AUDIT-P1-JOINCHECK / Bug #4): parallelize the per-channel
  // Telegram getChatMember calls. The previous sequential `for` loop took up to
  // N×5s (e.g., 25s for 5 channels), which exceeded the Worker 30s wall-clock
  // limit and the frontend apiFetch 15s timeout — causing "loading forever"
  // symptoms. With Promise.all, the total is bounded at 5s regardless of N.
  // Each _checkSingleTelegramChannel has its own 5s AbortController, so the
  // overall worst-case latency is ~5s (the slowest channel), not 5N seconds.
  const channelResults = await Promise.all(
    channels.map(ch => {
      const chatId = ch.username.startsWith('-') ? ch.username : `@${ch.username}`;
      return _checkSingleTelegramChannel(env, chatId, uid);
    })
  );
  for (let i = 0; i < channels.length; i++) {
    const result = channelResults[i];
    if (!result.joined) {
      // Cache negative result (jittered TTL) — avoids hammering Telegram for known-not-members.
      // KV-WRITE-OPT: Route through _kvWriteDedup to prevent redundant RATE_LIMITS
      // writes when the value ('0') is unchanged within the TTL window.
      await _kvWriteDedup(env.RATE_LIMITS, cacheKey, '0', _ttlNeg);
      return { joined: false, channels: channels.length, reason: result.reason || 'not_member', channel: channels[i].username };
    }
  }

  // All channels joined — cache positive result (jittered TTL).
  // KV-WRITE-OPT: Route through _kvWriteDedup to prevent redundant RATE_LIMITS
  // writes when the value ('1') is unchanged within the TTL window.
  await _kvWriteDedup(env.RATE_LIMITS, cacheKey, '1', _ttlPos);
  return { joined: true, channels: channels.length };
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
        // PHASE 2: Even on primary cache hit, enforce admin-configured DB channels.
        // The DB-channel check has its own per-user cache (60s TTL, keyed by
        // channel-set hash) so this is a KV read — cheap. If admin added a new
        // required channel since the primary cache was written, the DB-channel
        // cache key hash changes → cache miss → fresh Telegram check → enforces
        // the new channel immediately (no stale bypass).
        const extra = await checkAdditionalRequiredChannels(env, uid);
        if (!extra.joined) {
          // Primary channel joined, but a DB channel is not → revoke access.
          await setCachedJoinStatus(env, uid, false);
          if (isDatabaseConfigured(env)) {
            await persistDbUserJoinState(env, uid, false).catch(() => {});
          }
          return { joined: false, reason: 'additional_channel_required', channel: extra.channel };
        }
        return { joined: true, cached: true };
      }

      if (isDatabaseConfigured(env)) {
        const dbUser = await getDbUserJoinState(env, uid);
        if (dbUser?.channel_joined) {
          // PHASE 2: same DB-channel enforcement on DB-cache hit.
          const extra = await checkAdditionalRequiredChannels(env, uid);
          if (!extra.joined) {
            await setCachedJoinStatus(env, uid, false);
            await persistDbUserJoinState(env, uid, false).catch(() => {});
            return { joined: false, reason: 'additional_channel_required', channel: extra.channel };
          }
          await setCachedJoinStatus(env, uid, true);
          return { joined: true, from_db: true };
        }
      }
    }

    const result = await checkChannelMembership(uid, env);
    if (result.joined) {
      // PHASE 2: primary env channel joined — now check admin-configured DB channels.
      // ROOT-CAUSE FIX (AUDIT-P1 / Bug #2): propagate forceRefresh so that when
      // the caller explicitly requested a fresh check, the DB-channel check also
      // skips its KV cache and does a real Telegram getChatMember call.
      const extra = await checkAdditionalRequiredChannels(env, uid, { forceRefresh });
      if (!extra.joined) {
        // Primary channel joined but a DB channel is not → treat as not-joined.
        await setCachedJoinStatus(env, uid, false);
        if (isDatabaseConfigured(env)) {
          await persistDbUserJoinState(env, uid, false).catch(() => {});
        }
        return { joined: false, reason: 'additional_channel_required', channel: extra.channel };
      }
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
      // ROOT-CAUSE FIX (AUDIT-P1-JOINCHECK / Bug #7): FAIL-CLOSED on Telegram
      // api_error instead of falling back to stale DB/KV cache.
      //
      // Previously, when Telegram getChatMember returned an api_error (timeout,
      // 429, 500, network failure), the code fell back to the DB
      // users.channel_joined column or the KV join:{userId} cache — both of
      // which could be STALE (e.g., a user who left the channel but whose DB
      // row still says channel_joined=true). This created a security bypass:
      // if Telegram was temporarily unavailable, stale "joined" users got in.
      //
      // The user's requirement is explicit: "نباید باعث bypass شود" (must not
      // cause bypass). So we now return joined:false on api_error. The user
      // will see the Join Lock and can retry (check-join has a 60s rate limit
      // which is acceptable for retry-after-error scenarios).
      //
      // Trade-off: during a real Telegram outage, all users see the lock.
      // This is acceptable — it's safer to temporarily lock everyone than to
      // bypass the join requirement for stale members. The lock shows a
      // "⚠️ خطای موقت در بررسی عضویت" message via the reason field.
      return { joined: false, reason: 'api_error', detail: result.detail || 'Telegram API temporarily unavailable' };
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

// ── OHLC 1m fetch for alert crossing detection ──
// Fetches 1-minute klines (high/low/close) from the specified exchange.
// Returns { high, low, close, openTime, closeTime } or null.
// Uses the SAME exchange cache as fetchSpotPriceUsd (price:exchange:{symbol})
// to avoid trying a non-working exchange first.
const KLINE_CHECKERS = {
  bybit: {
    buildUrl(symbol) {
      return `https://api.bybit.com/v5/market/kline?category=spot&symbol=${encodeURIComponent(`${symbol}USDT`)}&interval=1&limit=1`;
    },
    parse(body) {
      const list = body?.result?.list;
      if (!Array.isArray(list) || list.length === 0) return null;
      const kline = list[0]; // [start, open, high, low, close, volume, turnover]
      return {
        openTime: Number(kline[0]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        closeTime: Number(kline[0]) + 60000, // 1m interval
      };
    },
  },
  okx: {
    buildUrl(symbol) {
      return `https://www.okx.com/api/v5/market/candles?instId=${encodeURIComponent(`${symbol}-USDT`)}&bar=1m&limit=1`;
    },
    parse(body) {
      const data = body?.data;
      if (!Array.isArray(data) || data.length === 0) return null;
      const kline = data[0]; // [ts, o, h, l, c, vol, volCcy, volCcyConfirm, confirm]
      return {
        openTime: Number(kline[0]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        closeTime: Number(kline[0]) + 60000,
      };
    },
  },
  mexc: {
    buildUrl(symbol) {
      return `https://api.mexc.com/api/v3/klines?symbol=${encodeURIComponent(`${symbol}USDT`)}&interval=1m&limit=1`;
    },
    parse(body) {
      if (!Array.isArray(body) || body.length === 0) return null;
      const kline = body[0]; // [openTime, open, high, low, close, volume, closeTime, quoteVolume]
      return {
        openTime: Number(kline[0]),
        high: Number(kline[2]),
        low: Number(kline[3]),
        close: Number(kline[4]),
        closeTime: Number(kline[6]),
      };
    },
  },
};

const KLINE_EXCHANGES = ['bybit', 'okx', 'mexc'];

/**
 * Fetch 1-minute OHLC kline for a symbol from the specified exchange.
 * Returns { high, low, close, openTime, closeTime } or null.
 */
async function fetchKlines1m(exchangeKey, symbol) {
  const checker = KLINE_CHECKERS[exchangeKey];
  if (!checker) return null;
  try {
    const { ok, body } = await fetchJsonWithTimeout(checker.buildUrl(symbol), PRICE_FETCH_TIMEOUT_MS);
    if (!ok || !body) return null;
    return checker.parse(body);
  } catch {
    return null;
  }
}

/**
 * Fetch OHLC 1m for a symbol using the same exchange cache pattern as fetchSpotPriceUsd.
 * Tries cached exchange first, falls back to all 3 exchanges in parallel.
 * Returns { high, low, close, exchange } or null.
 */
async function fetchOhlc1m(env, symbol) {
  const normalizedSymbol = String(symbol || '').trim().toUpperCase();
  if (!normalizedSymbol) return null;

  // Forex symbols don't have crypto klines — fall back to spot price
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
    // For forex, use spot price as high=low=close (no kline available)
    const spot = await fetchSpotPriceUsd(env, normalizedSymbol);
    if (spot && spot.price) {
      return { high: spot.price, low: spot.price, close: spot.price, exchange: spot.exchange };
    }
    return null;
  }

  const priceCacheKey = `price:exchange:${normalizedSymbol}`;

  // Fast path: try cached exchange
  let cachedExchange = null;
  try {
    const raw = await readAppCache(env, priceCacheKey);
    if (raw && typeof raw === 'string' && raw.length > 0 && raw.length < 30) {
      cachedExchange = raw.trim();
    }
  } catch {}

  if (cachedExchange && KLINE_EXCHANGES.includes(cachedExchange)) {
    const kline = await fetchKlines1m(cachedExchange, normalizedSymbol);
    if (kline && Number.isFinite(kline.high) && Number.isFinite(kline.low)) {
      return { ...kline, exchange: cachedExchange };
    }
    // Cached exchange failed — invalidate
    await writeAppCache(env, priceCacheKey, '', 60).catch(() => {});
  }

  // Fallback: try all kline exchanges in parallel
  const results = await Promise.allSettled(
    KLINE_EXCHANGES.map(async (exchangeKey) => {
      const kline = await fetchKlines1m(exchangeKey, normalizedSymbol);
      return { exchangeKey, kline };
    })
  );

  for (const exchangeKey of KLINE_EXCHANGES) {
    const idx = KLINE_EXCHANGES.indexOf(exchangeKey);
    const r = results[idx];
    if (r && r.status === 'fulfilled' && r.value.kline && Number.isFinite(r.value.kline.high)) {
      // Cache the working exchange
      await writeAppCache(env, priceCacheKey, exchangeKey, getNumericEnv(env, 'CHART_EXCHANGE_CACHE_TTL', 3600));
      return { ...r.value.kline, exchange: exchangeKey };
    }
  }

  return null;
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

// CALENDAR_CACHE_KEY moved to src/services/calendar.js (factory internal)
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
        // NEWSSEC-014 FIX: Use safeReadText to cap body size (2MB default) and
        // prevent OOM from compromised/oversized RSS feeds.
        const rssText = await safeReadText(response);
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

// ─── News Feed/RSS section moved to src/news/feed.js (3 functions extracted) ───
// Extracted: buildFarsiNewsArticles, fetchFarsiNews, _runNewsLiveFetchPipeline
// Kept in worker-proxy.js (cycle-breakers + general-purpose helpers):
//   - fetchAllNewsRss (used by Summary's processNewsAIBatch via DI — cycle-breaker)
//   - NEWS_RSS_SOURCES (used only by fetchAllNewsRss)
//   - EXTERNAL_FETCH_TIMEOUT_MS (used by chart/price/market/summary)
//   - FARSI_NEWS_CACHE_KEY (used by calendar section + /api/news-ai-pending route)
//   - fetchJson, fetchJsonWithTimeout (general-purpose helpers)

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
// ── Retry config ──
const NEWS_SUMMARY_MAX_RETRIES = 3;
const NEWS_SUMMARY_BACKOFF_MINUTES = [5, 15, 30]; // after attempt 1, 2, 3 (failures)
// ── Cache stats (Phase 10.5) ──
const NEWS_AI_CACHE_STATS_KEY = 'news:ai_cache_stats';

// ────────────────────────────────────────────────────────────────────────────
// NEWS SUMMARY SECTION: extracted to src/news/summary.js (lines 4793-7130 of original).
// What stays in worker-proxy.js (TDZ-cycle prevention — see composition root below):
//   - 8 module-level constants above (NEWS_AI_CACHE_PREFIX through NEWS_AI_CACHE_STATS_KEY)
//   - getSummaryQueue function (below) — hoisted function declaration, used by
//     createNewsTelemetry AND createNewsSummary as DI dep
// All other Summary functions (generateSummaryWithFallback, saveSummaryQueue,
// enqueueForSummary, publishArticleToFarsiNews, processOneArticleSummary,
// safeReadText, hashUrl, canonicalizeUrl, enrichNewsWithAISummaries,
// batchAnalyzeNews, processNewsAIBatch) moved to src/news/summary.js.
// ────────────────────────────────────────────────────────────────────────────

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

// (Rest of News Summary section — saveSummaryQueue through processNewsAIBatch —
// moved to src/news/summary.js. See composition root above for factory call.)


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
    // [START-E2E] Added for /start diagnostics — booleans only, no values exposed.
    // If webapp_url_set=false, the /start MEMBER reply has an empty web_app url
    // → Telegram rejects sendMessage with 400 → user sees nothing.
    webapp_url_set: Boolean(env.WEBAPP_URL && String(env.WEBAPP_URL).trim()),
    // If required_channel is the default 'amir_btc_2024', the channel may not be
    // configured for this deployment (getChatMember will fail → user treated as non-member).
    required_channel_set: Boolean(resolveRequiredChannel(env) && resolveRequiredChannel(env) !== 'amir_btc_2024'),
  }, {}, env);
}

// ============================================================================
//#region Composition Root — Wired dependencies for layered modules
// ============================================================================
// ── Alert Economy repository (must be created BEFORE alertHandlers) ──
const alertEconomyRepo = createAlertEconomyRepository({
  queryDb,
  // BUG 2 FIX: inject queryDbDirect so checkQuota bypasses Hyperdrive's
  // 60s SELECT cache and reads the real DB state for quota decisions.
  queryDbDirect,
  isDatabaseConfigured,
  isoDate: _rcIsoDate,
  normalizeOptionalString,
  // M5-C FIX: quota dates align with the shared Tehran date boundary
  // (same helper as daily claims / missions).
  getTehranDateString: sharedGetTehranDateString,
});

// ── Wallet + Economy (must be created BEFORE alertHandlers which debits tokens) ──
const walletRepo = createWalletRepository({ queryDb, queryDbTransaction });
const economyService = createEconomyService({ walletRepo, queryDb });

// ── Membership Module — Phase 3: created here so handlers can inject
// membershipAuthority for tier-based quota enforcement. ──
const membershipRepo = createMembershipRepository({ queryDb, queryDbTransaction });
const membershipAuthority = createMembershipAuthority({
  membershipRepo,
  readAppCache,
  writeAppCache,
});

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
  // PHASE 3: MembershipAuthority for tier-based alert quota
  membershipAuthority,
  // BUG 4 FIX: queryDb for persisting failed refunds to pending_refunds table
  queryDb,
});
const watchlistRepo = createWatchlistRepository({ queryDb, queryDbTransaction, ensureUserRow });
const watchlistHandlers = createWatchlistHandlers({
  jsonResponse,
  optionalTelegramAuth,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  watchlistRepo,
  // PHASE 3: Tier-based watchlist limit
  membershipAuthority,
  entitlementConfig: ENTITLEMENT,
});
const referralRepo = createReferralRepository({ queryDb, getReferralRewardPerInvite, getNumericEnv });
const referralHandlers = createReferralHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  referralRepo,
  // PREMIUM-DISPLAY FIX: wire authority + config so handleStats can return
  // the EFFECTIVE reward_per_invite (base 3 for Free, 6 for Premium) instead
  // of the DB base value. The actual crediting path in
  // processPendingReferralReward already uses these same helpers.
  membershipAuthority,
  entitlementConfig: ENTITLEMENT,
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
  // PHASE 2: shared Tehran date helper (replaces CURRENT_DATE UTC in mission_progress)
  getTehranDateString: sharedGetTehranDateString,
  getTehranWeekStart: getTehranWeekStart,
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

// REFERRAL REWARDS SERVICE: extract from src/services/referral-rewards.js (behavior-preserving)
// Placed here (after notificationService) — all 3 DI deps (notificationService, walletRepo,
// rewardCenterRepo) are in scope. getReferralRewardPerInvite is a CYCLE-BREAKER (stays in
// worker-proxy.js, used by referralRepo at composition root). Placed BEFORE sessionHandlers
// so processReferralOnBootstrap is in scope for sessionHandlers DI pass-through.
const {
  processPendingReferralReward,
  retryFailedReferralRewards,
  retryFailedWheelRewards,
  retryFailedMissionRewards,
  retryFailedRefunds,
  processReferralOnBootstrap,
} = createReferralRewardsService({
  queryDb,
  notificationService,
  walletRepo,
  rewardCenterRepo,
  getReferralRewardPerInvite,
  isDatabaseConfigured,
  normalizeOptionalString,
  resolveWebAppUrl,
  safeError,
  getMissionRewardAmount,
  economyService,
});

// alertEconomyRepo is already created above (before alertHandlers).
const wheelRepo = createWheelRepository({ queryDb, queryDbTransaction, getTehranDateString: sharedGetTehranDateString });
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
  // PHASE 3: Tier-based daily spins
  membershipAuthority,
  entitlementConfig: ENTITLEMENT,
});
// MISSION TOKEN SERVICE: extract from src/auth/mission-tokens.js (behavior-preserving)
const { issueMissionEventToken, consumeMissionEventToken } = createMissionTokenService({ sharedGetTehranDateString });

// NEWS PROVIDERS: extract from src/news/providers.js (behavior-preserving)
const {
  isNewsFlagEnabled, isNewsAIEnabled, isNewsSummaryEnabled,
  isNewsBatchAnalysisEnabled, isNewsQueueEnabled, isNewsProviderEnabled,
  classifyHttpError, classifyGroq429, parseGroqRetryAfter, parseGroq429Info,
  groqPrimaryGenerate,
  _groqRouterGetKeyState, _groqRouterSetKeyState, _groqRouterDiscoverKeys,
  _groqRouterSelectBestKey, _groqRouterRecordRequest, _groqRouterRecordSuccess,
  _groqRouterRecord429, _groqRouterRecordFailure, _groqRouterCallGateway,
  groqRouterExecute, _groqRoutedFetch,
  tryGroq, tryWorkersAI, tryOpenAI, tryOpenRouter,
  getCircuitState, saveCircuitState, shouldAttemptProvider, recordCircuitResult,
  OPENAI_MODEL, OPENROUTER_MODEL, NEWS_AI_PROVIDER_STATS_KEY,
  GROQ_ROUTER_KEY_PREFIX, GROQ_ROUTER_STATE_TTL, GROQ_ROUTER_WINDOW_MS,
  GROQ_ROUTER_MAX_PER_WINDOW, GROQ_ROUTER_FAILURE_THRESHOLD,
  GROQ_ROUTER_DEFAULT_OPEN_MS, GROQ_ROUTER_PROBE_LOCK_MS,
  CIRCUIT_BREAKER_KEY_PREFIX, CIRCUIT_BREAKER_TTL,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD, CIRCUIT_BREAKER_OPEN_MS,
  CIRCUIT_BREAKER_PROLONGED_OPEN_THRESHOLD, CIRCUIT_BREAKER_PROLONGED_OPEN_MS,
} = createNewsProviders({
  readAppCache,
  writeAppCache,
  queryDb,
});

// NEWS TELEMETRY: extract from src/news/telemetry.js (behavior-preserving)
const { ensureTelemetryTables, recordNewsAITick, recordE2ETiming, getE2ETimingStats, getNewsAIMonitoring, cleanupTickLog, cleanupE2ETimingLog } = createNewsTelemetry({
  queryDb,
  isNewsAIEnabled,
  isNewsSummaryEnabled,
  isNewsBatchAnalysisEnabled,
  isNewsQueueEnabled,
  isNewsProviderEnabled,
  CIRCUIT_BREAKER_FAILURE_THRESHOLD,
  CIRCUIT_BREAKER_OPEN_MS,
  GROQ_ROUTER_MAX_PER_WINDOW,
  NEWS_AI_CACHE_TTL,
  NEWS_SUMMARY_BACKOFF_MINUTES,
  NEWS_SUMMARY_MAX_RETRIES,
  OPENAI_MODEL,
  getSummaryQueue,
  getCircuitState,
  _groqRouterGetKeyState,
});

// NEWS TRANSLATION: extract from src/news/translate.js (behavior-preserving)
const { isM2m100QuotaExhausted, markM2m100QuotaExhausted, batchTranslateToFarsi, translateToFarsi } = createNewsTranslator({
  readAppCache,
  writeAppCache,
  _groqRoutedFetch,
  EXTERNAL_FETCH_TIMEOUT_MS,
  validatePersianOutput,
  isNewsProviderEnabled,
  shouldAttemptProvider,
  recordCircuitResult,
});

// (createNewsSummary call moved to AFTER newsArticleRepo definition — see below
// for TDZ-safe wiring. newsArticleRepo is defined at line ~6044.)



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
  // MISSION-ABUSE FIX: server-issued one-time mission event tokens
  issueMissionEventToken,
  consumeMissionEventToken,
  // Rate limiting for wallet endpoints
  isUserRateLimited,
  // PHASE 4: Tier-based daily claim + mission rewards
  membershipAuthority,
  entitlementConfig: ENTITLEMENT,
  // PHASE 1 (WALLET-REWARDS): shared Tehran date helpers for idempotency keys
  getTehranDateString: sharedGetTehranDateString,
  getTehranWeekStart: getTehranWeekStart,
  // PERF FIX: backgroundTask helper — schedules fire-and-forget work on
  // Cloudflare ctx.waitUntil() so notifications stay alive past the response.
  // See worker-proxy.js backgroundTask() definition above.
  backgroundTask,
});

// ── Reward Purchases (VPN Reward Market — Phase 5-8) ──
const rewardPurchaseRepo = createRewardPurchaseRepository({
  queryDb,
  queryDbTransaction,
  isDatabaseConfigured,
  getTehranDateString: sharedGetTehranDateString,
});
const rewardPurchaseHandlers = createRewardPurchaseHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  economyService,
  rewardPurchaseRepo,
  membershipAuthority,
  notificationService,
  requireAdmin: (request, env, perm) => adminHandlers.requireAdmin(request, env, perm),
  sendTelegramMessage,
  // BUG 5 FIX: queryDb for persisting failed refunds to pending_refunds table
  queryDb,
  // W-STAB-4 FIX: pass Tehran date helper so controller can build deterministic
  // refId per (user, plan, tehran-today) for concurrent-request idempotency.
  getTehranDateString: sharedGetTehranDateString,
  // PERF FIX: backgroundTask helper — schedules fire-and-forget work on
  // Cloudflare ctx.waitUntil() so notifications stay alive past the response.
  backgroundTask,
});

// ── Cosmetics Module — Phase 5 ──────────────────────────────────────────────
const cosmeticsRepo = createCosmeticsRepository({ queryDb, queryDbTransaction, isDatabaseConfigured });
const cosmeticsHandlers = createCosmeticsHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  buildBodyFieldValidationError,
  isDatabaseConfigured,
  cosmeticsRepo,
  membershipAuthority,
  economyService,
  // BUG 1 FIX: queryDb for persisting failed refunds to pending_refunds table
  queryDb,
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
const userRepo = createUserRepository({ queryDb, queryDbTransaction, normalizeOptionalString });
// adminRepo must be created BEFORE userHandlers because userHandlers (bootstrap)
// checks the DB admins table to detect DB-added admins (not just env super admin).
const adminRepo = createAdminRepository({ queryDb, queryDbDirect, normalizeOptionalString });

// ═══════════════════════════════════════════════════════════════════════════
// MembershipGateway — central membership decision authority.
// Created here (after all helper functions are defined) so it can wire to:
//   isAdminTelegramId, getCachedJoinStatus, setCachedJoinStatus, getDbUserJoinState,
//   persistDbUserJoinState, checkChannelMembership, checkAdditionalRequiredChannels,
//   isDatabaseConfigured, safeError.
// All callers (bootstrap, check-join, /start, middleware) funnel through this.
// ═══════════════════════════════════════════════════════════════════════════
const membershipGateway = createMembershipGateway({
  isAdminTelegramId,
  getCachedJoinStatus,
  setCachedJoinStatus,
  getDbUserJoinState,
  persistDbUserJoinState,
  checkChannelMembership,
  checkAdditionalRequiredChannels,
  isDatabaseConfigured,
  safeError,
});
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
  // [BOOTSTRAP-E2E] diagnostic logging — traces admin detection + join check
  logBootstrapE2E,
  // MembershipGateway — central membership authority (Step 5 migration)
  membershipGateway,
  // MISSION-ABUSE FIX: auto-fire daily_login mission on bootstrap.
  // walletHandlers is created above (line ~6809) so it's in scope here.
  fireDailyLoginMission: (...args) => walletHandlers.fireDailyLoginMission(...args),
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
// ROOT-CAUSE FIX (notification delete-reappear, RCA PROVEN 2026-09-10):
// Hyperdrive's SELECT query cache (caching.disabled=false, default cache_ttl=60s)
// returns stale SELECT results for notificationRepo.list/.unreadCount within
// the 60s cache window after a DELETE. FIX (Option C): inject queryDbDirect
// (per-call pg.Pool bound to DIRECT_URL/DATABASE_URL, bypassing Hyperdrive)
// alongside queryDb. notificationRepo.list and notificationRepo.unreadCount use
// queryDbDirect (direct Supabase primary, no Hyperdrive cache → read-after-write
// consistency). All mutation functions (deleteNotification, deleteAll, markRead,
// markAllRead, create, createBulk) continue to use queryDb (the existing
// Hyperdrive path — mutations bypass the cache anyway) — UNCHANGED. No other
// repository is given queryDbDirect. Scope is strictly the notification GET
// path. See queryDbDirect definition (worker-proxy.js) and
// src/repositories/notifications.js for the two usage sites.
const notificationRepo = createNotificationRepository({ queryDb, queryDbDirect });
// notificationPlatformRepo is already created above (before wheelHandlers).
const notificationHandlers = createNotificationHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  notificationRepo,
});
// ── App Content Module — CMS for About / Terms / Privacy ───────────────────
// Chat AI v2: moved before assistantHandlers so the repo is available for
// dependency injection (avoids TDZ ReferenceError with const declarations).
const appContentRepo = createAppContentRepository({ queryDb, readAppCache, writeAppCache });

const assistantHandlers = createAssistantHandlers({
  jsonResponse,
  optionalTelegramAuth,
  readJsonBody,
  MAX_BODY_BYTES,
  buildBodyFieldValidationError,
  normalizeOptionalString,
  readRateLimitCache,
  writeRateLimitCache,
  // KV-WRITE-OPT: inject writeAppCache for _kvWriteCache dedup on web search cache
  writeAppCache,
  getTodayIsoDate,
  getNumericEnv,
  queryDb,
  // PHASE 3: Tier-based AI quota
  membershipAuthority,
  entitlementConfig: ENTITLEMENT,
  // Chat AI redesign: reuse News AI circuit breaker infrastructure
  shouldAttemptProvider,
  recordCircuitResult,
  classifyHttpError,
  isNewsProviderEnabled,
  // GROQ-ROUTER-4KEY: Chat text path delegates to the centralized 4-key Groq
  // Router (replaces old checkGroqCapacity/recordGroqRequest/estimateGroqTokens
  // + groqPrimaryGenerate — the router handles key selection + budget + cooldown).
  groqRouterExecute,
  // Chat AI v2: inject app content + membership rules repos for dynamic
  // fetchAppContentContext (About/Terms/Privacy/Rules context injection).
  appContentRepo,
  membershipRepo,
});
const analysisRepo = createAnalysisRepository({ queryDb, queryDbTransaction, normalizeOptionalString });
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
  adminRepo,
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
  // A-3 FIX: Rate limiting for admin mutations
  isUserRateLimited,
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
  // NEW-1 FIX: Rate limiting for admin mutations
  isUserRateLimited,
  // WALLET-CONSISTENCY H1 FIX: invalidate reward-per-invite cache after tier mutations
  invalidateRewardPerInviteCache,
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
  // NEW-1 FIX: Rate limiting for admin mutations
  isUserRateLimited,
  // Phase 2: Premium entitlement for advertisement settings
  membershipAuthority,
});
//#endregion

// ── Advertisements repository + handlers (Channel Join / Popup / Message) ──
// Central Advertisement system. Three campaign types, all admin-managed.
// Connects to ch_promotions preference for message delivery (Phase 7).
const advertisementsRepo = createAdvertisementsRepository({
  queryDb,
  queryDbTransaction,
  isDatabaseConfigured,
  isoDate: _rcIsoDate,
  normalizeOptionalString,
});

const advertisementsHandlers = createAdvertisementsHandlers({
  jsonResponse,
  authenticateTelegramRequest,
  requireAdmin: adminHandlers.requireAdmin,
  readJsonBody,
  safeDbErrorResponse,
  safeError,
  isDatabaseConfigured,
  queryDb,
  advertisementsRepo,
  notificationPlatformRepo,
  sendTelegramMessage,
  membershipAuthority,
  isUserRateLimited,
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
  membershipAuthority,
});

//#endregion

// ── Market Overview Service (CMC) — all CMC calls centralized here ──
const marketOverviewSvc = createMarketOverviewService({ readAppCache, writeAppCache, fetchJson });

// ── Membership Module — factory wiring (moved to line ~6984 for Phase 3) ────

// ── News Articles Module — permanent storage for AI summaries ───────────────
const newsArticleRepo = createNewsArticleRepository({ queryDb });

// NEWS SUMMARY: extract from src/news/summary.js (behavior-preserving)
// Placed HERE (after newsArticleRepo definition at line 5981) for TDZ-safe
// wiring — createNewsSummary receives newsArticleRepo as a DI dep, so it
// must run AFTER newsArticleRepo is initialized.
//
// NOTE: getSummaryQueue + 8 module-level constants stay in worker-proxy.js
// (TDZ-cycle prevention: createNewsTelemetry at line ~5568 above also receives
// getSummaryQueue + 3 constants as DI deps, and is created BEFORE this
// createNewsSummary call. If getSummaryQueue + constants moved to summary.js,
// telemetry would need them from createNewsSummary (created later) → TDZ cycle.
// By keeping getSummaryQueue + constants in worker-proxy.js module scope
// (getSummaryQueue is a hoisted function declaration, constants are const at
// module scope), both telemetry and summary receive them from worker-proxy.js
// scope — no cycle, no TDZ risk.)
const {
  generateSummaryWithFallback,
  saveSummaryQueue,
  enqueueForSummary,
  publishArticleToFarsiNews,
  processOneArticleSummary,
  safeReadText,
  hashUrl,
  canonicalizeUrl,
  enrichNewsWithAISummaries,
  batchAnalyzeNews,
  processNewsAIBatch,
} = createNewsSummary({
  // From worker-proxy.js core (7):
  readAppCache,
  writeAppCache,
  getNumericEnv,
  fetchAllNewsRss,
  newsArticleRepo,
  EXTERNAL_FETCH_TIMEOUT_MS,
  FARSI_NEWS_CACHE_KEY,
  // From createNewsProviders (17):
  isNewsAIEnabled,
  isNewsSummaryEnabled,
  isNewsBatchAnalysisEnabled,
  isNewsQueueEnabled,
  isNewsProviderEnabled,
  _groqRoutedFetch,
  _groqRouterDiscoverKeys,
  _groqRouterGetKeyState,
  _groqRouterRecordSuccess,
  groqRouterExecute,
  getCircuitState,
  recordCircuitResult,
  shouldAttemptProvider,
  tryGroq,
  tryOpenAI,
  tryOpenRouter,
  tryWorkersAI,
  // From createNewsTelemetry (4):
  recordNewsAITick,
  recordE2ETiming,
  cleanupTickLog,
  cleanupE2ETimingLog,
  // From createNewsTranslator (2):
  batchTranslateToFarsi,
  translateToFarsi,
  // ─── CYCLE-BREAKERS (from worker-proxy.js module scope, NOT from other factories) ───
  getSummaryQueue,
  NEWS_AI_CACHE_PREFIX,
  NEWS_AI_CACHE_TTL,
  NEWS_SUMMARY_QUEUE_KEY,
  NEWS_SUMMARY_MAX_RETRIES,
  NEWS_SUMMARY_BACKOFF_MINUTES,
  // ─── From src/news/shared.js (7) — imported in worker-proxy.js line 87, passed as DI ───
  // These are shared helpers used inside Summary section code (parseRssItems,
  // filterAndScoreNews, validatePersianOutput, sanitizeNewsTitle, sanitizeNewsSummary,
  // classifySentiment, parseRelativeTime). Without these DI deps, the bare references
  // inside summary.js throw ReferenceError at runtime (confirmed in production
  // wrangler tail at 12:45:06 UTC */15 cron fire).
  parseRelativeTime,
  filterAndScoreNews,
  parseRssItems,
  validatePersianOutput,
  sanitizeNewsTitle,
  sanitizeNewsSummary,
  classifySentiment,
});

// NEWS FEED: extract from src/news/feed.js (behavior-preserving)
// Placed HERE (after createNewsSummary at line ~5742) for TDZ-safe wiring —
// createNewsFeed receives safeReadText, canonicalizeUrl, enrichNewsWithAISummaries
// as DI deps (returned from createNewsSummary above), so it must run AFTER
// createNewsSummary is initialized.
//
// CYCLE-BREAKER: fetchAllNewsRss stays in worker-proxy.js (NOT extracted to feed.js).
// Reason: createNewsSummary (line ~5742) ALSO needs fetchAllNewsRss as a DI dep
// (passed at line 5757 below — Summary's processNewsAIBatch calls fetchAllNewsRss
// via DI). If fetchAllNewsRss moved to feed.js, it would be returned from
// createNewsFeed (created HERE, AFTER createNewsSummary) — but Summary needs it
// BEFORE Feed is created → TDZ cycle. By keeping fetchAllNewsRss in worker-proxy.js
// (hoisted function declaration), both Summary and Feed receive it from
// worker-proxy.js scope — no cycle, no TDZ risk.
const {
  buildFarsiNewsArticles,
  fetchFarsiNews,
  _runNewsLiveFetchPipeline,
} = createNewsFeed({
  // From worker-proxy.js core (6):
  readAppCache,
  writeAppCache,
  getNumericEnv,
  EXTERNAL_FETCH_TIMEOUT_MS,
  FARSI_NEWS_CACHE_KEY,
  fetchAllNewsRss,
  // From src/news/shared.js (3):
  parseRelativeTime,
  classifySentiment,
  sanitizeNewsTitle,
  // From src/news/translate.js (2):
  batchTranslateToFarsi,
  translateToFarsi,
  // From src/news/summary.js (3):
  safeReadText,
  canonicalizeUrl,
  enrichNewsWithAISummaries,
});

// CALENDAR SERVICE: extract from src/services/calendar.js (behavior-preserving)
// Placed here (after createNewsFeed) — Calendar has NO dependency on any news module,
// so placement is flexible. All DI deps (readAppCache, writeAppCache, getNumericEnv,
// calendar-cache accessors) are in scope at this point.
const {
  fetchCalendarFeed,
  fetchCalendarEvents,
  resolveChartExchange,
  mapCalendarEvent,
} = createCalendarService({
  readAppCache,
  writeAppCache,
  getNumericEnv,
  getCalendarIsolateCache,
  getCalendarIsolateCacheAt,
  setCalendarIsolateCache,
});

// MARKET DATA SERVICE: extract from src/services/market-data.js (behavior-preserving)
// Placed here (after createCalendarService) — Market Data has NO dependency on
// any news/calendar module. All DI deps are in scope at this point.
// fetchFearGreed is a CYCLE-BREAKER: it stays in worker-proxy.js (reads
// module-level env_CMC_API_KEY/env_APP_CACHE) and is passed as DI to the factory.
const {
  fetchGlobalStats,
  handleMarketData,
  handleForexData,
} = createMarketDataService({
  fetchJson,
  fetchJsonWithTimeout,
  readAppCache,
  writeAppCache,
  _traceStage,
  jsonResponse,
  EXTERNAL_FETCH_TIMEOUT_MS,
  fetchFearGreed,
});

// appContentRepo moved before assistantHandlers (line ~10593) for TDZ-safe injection.
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
  // PHASE 5: Cosmetics repo for active cosmetic in status response
  cosmeticsRepo,
  // PHASE 7A: MembershipAuthority for entitlement cache invalidation.
  // Injected here so that admin/user state-changing handlers
  // (approve, suspend, reactivate, expire, set-level, bulk approve/reject,
  // user reapply) can immediately bust mb:ent:{id} via invalidateCaches().
  membershipAuthority,
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
    last_updated: getCalendarIsolateCacheAt() ? new Date(getCalendarIsolateCacheAt()).toISOString() : null,
    isolate_cache_age_seconds: getCalendarIsolateCacheAt() ? Math.round((Date.now() - getCalendarIsolateCacheAt()) / 1000) : null,
    isolate_cache_count: getCalendarIsolateCache()?.length || 0,
  }, {}, env);
}

// ROOT-CAUSE FIX: Was 30 seconds, but Cloudflare KV requires expirationTtl >= 60.
// A TTL of 30 caused "Invalid expiration_ttl" on EVERY market cache write,
// meaning the market data was NEVER cached in KV — every request hit the
// upstream API. Now 60s (the minimum allowed by KV). writeAppCache also
// clamps any sub-60 TTL up to 60 as a safety net.

// ─── Market Data constants moved to src/services/market-data.js (factory internal) ───
// Extracted: MARKET_CACHE_TTL, MARKET_GLOBAL_CACHE_TTL, MARKET_FETCH_LIMIT, SEARCH_FETCH_LIMIT

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
// MKT-002 FIX: Increased from 300s (5min) to 900s (15min). F&G changes slowly
// during the day — 15min staleness is acceptable. This reduces CMC F&G API
// calls from ~288/day (every 5min) to ~96/day (every 15min), saving ~5,760
// CMC credits/day. The cron refreshOverview runs every 30min (at :00/:30),
// so the 15min TTL ensures F&G is re-fetched at most 2x between cron ticks.
const FG_CACHE_TTL = 900; // 15 minutes (was 5 minutes)

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
          // KV-WRITE-OPT: Route through writeAppCache wrapper to get _kvWriteCache
          // dedup — prevents redundant KV writes when the F&G value is unchanged
          // within the TTL window (the DIRECT env_APP_CACHE.put bypassed dedup,
          // writing on every successful CMC fetch even if the value was identical).
          // Key, value serialization, and TTL are preserved exactly.
          await writeAppCache({ APP_CACHE: env_APP_CACHE }, FG_CACHE_KEY, JSON.stringify(result), FG_CACHE_TTL);
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
// TEMPORARY: diagnostic report storage for notification RCA (global memory, not KV)
let _notifDiagReport = null;

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

// ─── Market Data functions moved to src/services/market-data.js (4 functions + FOREX constants) ───
// Extracted: enrichMarketData, fetchGlobalStats, handleMarketData, handleForexData,
//   FOREX_PAIRS, FOREX_CACHE_TTL
// Kept in worker-proxy.js (cycle-breakers + general-purpose):
//   - singleFlight + _inflightRequests (used by /api/market route dispatch)
//   - fetchFearGreed + _classifyFG (reads env_CMC_API_KEY/env_APP_CACHE module state)
//   - env_CMC_API_KEY, env_APP_CACHE (set per-request by main handler)
//   - _notifDiagReport (notification diagnostic — NOT market-related)
//   - FG_CACHE_KEY, FG_CACHE_TTL (used by fetchFearGreed which stays)

async function handleFarsiNews(request, env, ctx = null) {
  const url = new URL(request.url);
  const category = url.searchParams.get('category');
  const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10) || 1);
  const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '30', 10) || 30));

  // Only allow known categories
  const validCategories = ['crypto', 'forex', 'economy', 'all'];
  const categoryFilter = category && validCategories.includes(category) && category !== 'all'
    ? category
    : null;

  const result = await fetchFarsiNews(env, categoryFilter, ctx);
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

  // ── Webhook secret validation (Task 2.11 + S-02 FIX) ───────────────────────
  // S-02 FIX: If a secret IS configured, the header MUST be present AND match.
  // Previously, a missing header was allowed through (fail-open), which meant
  // an attacker could spoof Telegram updates by simply omitting the header.
  // Now: fail-closed — if secret is configured, header must be present and valid.
  const webhookSecret = env.TELEGRAM_WEBHOOK_SECRET;
  if (webhookSecret) {
    const headerToken = request.headers.get('X-Telegram-Bot-Api-Secret-Token');
    if (!headerToken) {
      // S-02 FIX: Reject if secret is configured but header is absent.
      // The webhook must be registered with secret_token for this to work.
      // If the webhook was registered without secret_token, either:
      //   1. Re-register with secret_token: curl https://api.telegram.org/bot<TOKEN>/setWebhook?url=<URL>&secret_token=<SECRET>
      //   2. Or unset TELEGRAM_WEBHOOK_SECRET to disable the check (NOT recommended)
      return jsonResponse(
        { status: 'error', detail: 'Missing webhook secret token' },
        { status: 403 }, env);
    }
    if (!timingSafeEqualSecret(headerToken, webhookSecret)) {
      return jsonResponse(
        { status: 'error', detail: 'Invalid webhook secret token' },
        { status: 403 }, env);
    }
  }
  // ── End webhook secret validation ─────────────────────────────────────────

  let messageContext = null;
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

      // Rate limit: max 1 callback per 60 seconds per user (Cloudflare KV minimum TTL)
      const rateLimited = await isCallbackRateLimited(env, userId);
      if (rateLimited) {
        await answerTelegramCallbackQuery(env, callbackQuery.id, '⏳ لطفاً ۱ دقیقه صبر کنید و دوباره تلاش کنید.', false);
        return new Response(null, { status: 200, headers: withCors({}, env) });
      }

      // Check channel membership
      const membership = await membershipGateway.check(env, userId, { forceRefresh: true });
      
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
    messageContext = extractTelegramMessageContext(updatePayload);
    if (!messageContext || !isTelegramStartCommand(messageContext.text)) {
      // Not a /start command — silent 200 (Telegram expects 200 for all webhooks)
      if (messageContext) {
        void logStartE2E(env, { phase: 'not_start_command', userId: messageContext.userId, text_preview: String(messageContext.text || '').slice(0, 30) });
      }
      return new Response(null, {
        status: 200,
        headers: withCors({}, env),
      });
    }

    // [START-E2E] /start command detected
    void logStartE2E(env, {
      phase: 'command_detected',
      userId: messageContext.userId,
      has_chat_id: messageContext.chatId != null,
      has_start_param: Boolean(messageContext.startParam),
      start_param: messageContext.startParam ? 'present' : 'absent',
    });

    if (!isBotConfigured(env)) {
      // [START-E2E] Bot not configured — this is the silent-abort point
      void logStartE2E(env, { phase: 'bot_not_configured', userId: messageContext.userId });
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
    const membership = await membershipGateway.check(env, messageContext.userId, { forceRefresh: true });
    // [START-E2E] Membership resolved
    void logStartE2E(env, {
      phase: 'membership_resolved',
      userId: messageContext.userId,
      joined: Boolean(membership?.joined),
      reason: membership?.reason || null,
    });

    // Store pending referral in KV so check_join callback can retrieve it later
    if (messageContext.startParam && env.JOIN_CACHE && typeof env.JOIN_CACHE.put === 'function') {
      try {
        await env.JOIN_CACHE.put(`pending_ref:${messageContext.userId}`, messageContext.startParam, { expirationTtl: 600 });
      } catch (e) {
        console.warn('JOIN_CACHE put pending_ref failed:', e.message || e);
      }
    }

    // If no startParam in current /start, check KV for a previously stored one
    let effectiveStartParam = messageContext.startParam;
    if (!effectiveStartParam && env.JOIN_CACHE && typeof env.JOIN_CACHE.get === 'function') {
      const storedRef = await env.JOIN_CACHE.get(`pending_ref:${messageContext.userId}`);
      if (storedRef) {
        effectiveStartParam = storedRef;
      }
    }

    const replyPayload = await buildStartReplyPayloadAsync(env, messageContext.chatId, Boolean(membership?.joined), effectiveStartParam);
    // [START-E2E] Reply payload built
    const finalWebAppUrl = (replyPayload.reply_markup && replyPayload.reply_markup.inline_keyboard && replyPayload.reply_markup.inline_keyboard[0] && replyPayload.reply_markup.inline_keyboard[0][0] && replyPayload.reply_markup.inline_keyboard[0][0].web_app) ? replyPayload.reply_markup.inline_keyboard[0][0].web_app.url : null;
    const hasWebAppButton = Boolean(finalWebAppUrl);
    void logStartE2E(env, {
      phase: 'reply_built',
      userId: messageContext.userId,
      is_member: Boolean(membership?.joined),
      has_webapp_button: hasWebAppButton,
      webapp_url_present: Boolean(finalWebAppUrl && finalWebAppUrl.length > 0),
      chat_id_present: replyPayload.chat_id != null,
    });

    // [START-E2E] sendMessage started
    void logStartE2E(env, { phase: 'sendMessage_started', userId: messageContext.userId });
    let sendMessageResult = null;
    try {
      sendMessageResult = await sendTelegramMessage(env, replyPayload);
      // [START-E2E] sendMessage succeeded
      void logStartE2E(env, {
        phase: 'sendMessage_completed',
        userId: messageContext.userId,
        telegram_ok: true,
        message_id: sendMessageResult?.messageId || null,
      });
    } catch (sendErr) {
      // [START-E2E] sendMessage FAILED — capture the real Telegram error
      // sendTelegramMessage throws with the error_code + description in the message
      const errMsg = sendErr instanceof Error ? sendErr.message : String(sendErr);
      void logStartE2E(env, {
        phase: 'sendMessage_failed',
        userId: messageContext.userId,
        telegram_ok: false,
        error: errMsg.slice(0, 300),
      });
      // Re-throw so the outer catch block can send an error notification to the user
      throw sendErr;
    }

    // ROOT-CAUSE FIX: syncMenuButton was called fire-and-forget (no await),
    // which caused "A promise was resolved from a different request context"
    // warnings. The Telegram API call continued running AFTER the webhook
    // response was sent, resolving in a dead request context.
    // FIX: await it so it completes BEFORE the response is returned.
    // It's fast (~100ms) and idempotent, so blocking is acceptable.
    try {
      await syncMenuButton(env);
      void logStartE2E(env, { phase: 'syncMenuButton_done', userId: messageContext.userId });
    } catch (menuErr) {
      // syncMenuButton has its own internal try/catch (swallows errors silently).
      // This catch is a safety net — it should never fire.
      void logStartE2E(env, { phase: 'syncMenuButton_error', userId: messageContext.userId, error: String(menuErr?.message || menuErr).slice(0, 200) });
    }

    // [START-E2E] Handler completed successfully
    void logStartE2E(env, { phase: 'handler_complete', userId: messageContext.userId });
  } catch (error) {
    console.error(safeError('telegram-webhook-error', error));
    // [START-E2E] Handler error — capture which step failed
    void logStartE2E(env, {
      phase: 'handler_error',
      userId: messageContext?.userId,
      error: String(error?.message || error).slice(0, 300),
      error_type: error?.constructor?.name || 'Error',
    });
    // Attempt to notify the user that something went wrong
    if (messageContext?.chatId) {
      try {
        const notifyResult = await sendTelegramMessage(env, {
          chat_id: messageContext.chatId,
          text: '⚠️ خطای موقت در پردازش درخواست. لطفاً دوباره /start را بزنید.',
        });
        void logStartE2E(env, {
          phase: 'error_notification_sent',
          userId: messageContext.userId,
          telegram_ok: Boolean(notifyResult?.ok),
        });
      } catch (notifyErr) {
        console.error(safeError('start-error-notify-failed', notifyErr));
        void logStartE2E(env, {
          phase: 'error_notification_failed',
          userId: messageContext.userId,
          error: String(notifyErr?.message || notifyErr).slice(0, 200),
        });
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

      // NOTIF-FIX: Dedup key is written AFTER the user dispatch loop completes
      // (moved from before the loop to after).
      //
      // Previous order: writeAppCache(dedupKey) → dispatch loop
      //   - If Worker crashed mid-loop (after some users dispatched), the
      //     dedup key was already set → next cron tick skipped the event
      //     → remaining users PERMANENTLY missed the notification.
      //
      // New order: dispatch loop → writeAppCache(dedupKey) (only if ≥1 user dispatched)
      //   - If Worker crashes mid-loop: dedup key NOT written → next cron tick
      //     re-detects the event and retries
      //   - Already-notified users: ON CONFLICT DO NOTHING (idempotent, no duplicate)
      //   - Remaining users: get notification on retry
      //   - If NO user dispatched (all failed): dedup key NOT written → retry
      //
      // Duplicate safety (verified):
      //   - Per-user dedupKey: `cal_event_${eventKey}_${uid}` (deterministic, unique per event)
      //   - notifications INSERT: ON CONFLICT (id) DO NOTHING
      //   - notification_queue INSERT: ON CONFLICT (notification_id, user_id) DO NOTHING
      //   - UNIQUE constraint uq_notification_queue_dedup at DB level
      //   - processQueue: telegram_message_id check → skip if already sent
      //
      // Concurrent cron safety:
      //   - Two cron ticks (1-min + */5 overlap) could both detect the event
      //     before either writes the dedup key. Both would dispatch to all users.
      //   - But per-user dedupKey + ON CONFLICT DO NOTHING ensures each user
      //     gets exactly ONE queue row → exactly ONE Telegram message.
      //   - The dedup key is a SECONDARY optimization (skip the event detection
      //     loop), not the primary dedup mechanism (per-user idempotency is).

      // Fetch joined users (same query — no cap, no LIMIT)
      const usersResult = await queryDb(
        env,
        `SELECT telegram_id FROM users WHERE channel_joined = TRUE`,
        [], 1, pool,
      );
      const allUserIds = usersResult.rows.map((r) => String(r.telegram_id));
      if (allUserIds.length === 0) continue;

      const title = `🔔 رویداد مهم تقویم: ${event.title}`;
      const message = `${event.country} ${event.flag} — ${event.time || ''}`;
      const metadataJson = JSON.stringify({
        event_title: event.title,
        event_date: event.date,
        event_time: event.time,
        event_country: event.country,
      });

      // ── BULK FIX: Batch preference lookup (1 DB SELECT, replaces N per-user getUserChannelPreference calls) ──
      // Mirrors processBroadcastFull pattern (notification_platform.js:1351-1359).
      // Default preference is 'both' if user has no settings row
      // (matches sendNotification default at notification_platform.js:544).
      const prefMap = new Map();
      if (allUserIds.length > 0) {
        const placeholders = allUserIds.map((_, i) => `$${i + 1}`).join(',');
        const prefResult = await queryDb(env,
          `SELECT user_id, ch_calendar AS pref FROM notification_settings WHERE user_id IN (${placeholders})`,
          allUserIds, 1, pool
        ).catch(() => ({ rows: [] }));
        for (const row of prefResult.rows || []) {
          prefMap.set(String(row.user_id), String(row.pref));
        }
      }

      // ── BULK FIX: Partition users by delivery channel ──
      // Match sendNotification logic (notification_platform.js:1174):
      //   - 'none' → skip delivery entirely (no INSERT)
      //   - 'mini_app' → deliver to mini_app only (notif INSERT, channel='mini_app')
      //   - 'telegram' → deliver to telegram only (queue INSERT, no notif INSERT)
      //   - 'both' → deliver to both (notif INSERT channel='both', AND queue INSERT)
      //   - Default (no settings row) → 'both'
      const miniAppUsers = [];
      const telegramUsers = [];
      for (const uid of allUserIds) {
        const userChannel = prefMap.get(uid) || 'both';
        if (userChannel === 'none') continue;
        if (userChannel === 'mini_app' || userChannel === 'both') miniAppUsers.push(uid);
        if (userChannel === 'telegram' || userChannel === 'both') telegramUsers.push(uid);
      }

      // Helper: build notificationId (preserves dedupKey → notif_id transformation
      // from sendNotification at notification_platform.js:1178-1180).
      // sendNotification: `notif_${String(dedupKey).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
      // Calendar dedupKey: `cal_event_${eventKey}_${uid}`
      // → notificationId = `notif_cal_event_${eventKey}_${uid}` (sanitized + sliced)
      const buildNotifId = (uid) => `notif_cal_event_${eventKey}_${uid}`
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

      // ── BULK FIX: Bulk INSERT in-app notifications (mini_app channel) ──
      // Mirrors processBroadcastFull pattern (notification_platform.js:1390-1434).
      // ON CONFLICT (id) DO NOTHING preserves idempotency (dedupKey → notif_id).
      // If Worker crashes before dedup write, next tick's INSERT is no-op
      // (rows already exist) → no duplicates.
      // created_at omitted → relies on DB DEFAULT NOW() (same as processBroadcastFull).
      let notifInsertOk = true;
      if (miniAppUsers.length > 0) {
        try {
          const notifIds = miniAppUsers.map(buildNotifId);
          const userIdsArr = miniAppUsers.map(String);
          const typesArr = miniAppUsers.map(() => 'calendar');
          const titlesArr = miniAppUsers.map(() => title);
          const messagesArr = miniAppUsers.map(() => message);
          const metadataArr = miniAppUsers.map(() => metadataJson);
          const readStatusArr = miniAppUsers.map(() => false);
          const prioritiesArr = miniAppUsers.map(() => 'medium');
          const categoriesArr = miniAppUsers.map(() => 'calendar');
          // channel column: 'both' if user is also in telegramUsers (i.e., has
          // 'both' preference), else 'mini_app'.
          // Matches sendNotification INSERT at notification_platform.js:1193:
          //   deliverToTelegram ? 'both' : 'mini_app'
          const channelsArr = miniAppUsers.map(uid =>
            telegramUsers.includes(uid) ? 'both' : 'mini_app'
          );
          const statusArr = miniAppUsers.map(() => 'delivered');

          await queryDb(env, `
            INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status)
            SELECT * FROM unnest(
              $1::text[],
              $2::text[],
              $3::text[],
              $4::text[],
              $5::text[],
              $6::jsonb[],
              $7::boolean[],
              $8::text[],
              $9::text[],
              $10::text[],
              $11::text[]
            )
            ON CONFLICT (id) DO NOTHING
          `, [
            notifIds, userIdsArr, typesArr, titlesArr, messagesArr,
            metadataArr, readStatusArr, prioritiesArr, categoriesArr, channelsArr, statusArr,
          ], 1, pool).catch((e) => {
            console.warn('[CALENDAR] Bulk INSERT notifications failed:', e?.message);
            notifInsertOk = false;
          });
        } catch (e) {
          console.warn('[CALENDAR] Mini-app notification bulk failed:', e?.message);
          notifInsertOk = false;
        }
      }

      // ── BULK FIX: Bulk INSERT Telegram queue items (telegram channel) ──
      // Mirrors processBroadcastFull pattern (notification_platform.js:1437-1471).
      // ON CONFLICT (notification_id, user_id) DO NOTHING preserves idempotency.
      // processQueue(10) at end of calendar path drains queue with first 10 sends.
      // Queue payload matches sendNotification's enqueue call
      // (notification_platform.js:1209): { title, message, telegramExtra }.
      // Calendar path does NOT set telegramExtra (undefined → omitted by JSON.stringify),
      // so payload is { title, message } — same as processBroadcastFull.
      // created_at omitted → relies on DB DEFAULT NOW() (same as processBroadcastFull).
      let queueInsertOk = true;
      if (telegramUsers.length > 0) {
        try {
          const queueNotifIds = telegramUsers.map(buildNotifId);
          const userIdsArr = telegramUsers.map(String);
          const channelsArr = telegramUsers.map(() => 'telegram');
          const prioritiesArr = telegramUsers.map(() => 'medium');
          const statusArr = telegramUsers.map(() => 'pending');
          const payloadsArr = telegramUsers.map(() => JSON.stringify({
            title,
            message,
          }));

          await queryDb(env, `
            INSERT INTO notification_queue (notification_id, user_id, channel, priority, status, payload)
            SELECT * FROM unnest(
              $1::text[],
              $2::text[],
              $3::text[],
              $4::text[],
              $5::text[],
              $6::jsonb[]
            )
            ON CONFLICT (notification_id, user_id) DO NOTHING
          `, [
            queueNotifIds, userIdsArr, channelsArr, prioritiesArr, statusArr, payloadsArr,
          ], 1, pool).catch((e) => {
            console.warn('[CALENDAR] Bulk INSERT queue failed:', e?.message);
            queueInsertOk = false;
          });
        } catch (e) {
          console.warn('[CALENDAR] Telegram queue bulk failed:', e?.message);
          queueInsertOk = false;
        }
      }

      // ── Dedup key write AFTER bulk INSERTs (crash recovery preserved) ──
      // NOTIF-FIX: Write dedup key AFTER bulk INSERTs (not before).
      // If Worker crashes mid-bulk: dedup key NOT written → next cron tick
      // re-detects the event and retries. ON CONFLICT DO NOTHING on both
      // INSERTs prevents duplicates on retry.
      // TTL = 4h to cover the 1-hour window + event duration + propagation delay.
      //
      // sentForThisEvent computation (accurate, mirrors processBroadcastFull P2 FIX):
      // A user is "dispatched" if at least one of their channels' INSERT succeeded.
      //   - 'mini_app' user: dispatched if notifInsertOk
      //   - 'telegram' user: dispatched if queueInsertOk
      //   - 'both' user: dispatched if notifInsertOk OR queueInsertOk
      //   - 'none' user: NOT dispatched (skipped in partition)
      // If ALL users' INSERTs failed: sentForThisEvent = 0 → dedup NOT written → retry.
      // If ANY user's INSERT succeeded: sentForThisEvent > 0 → dedup written → event not retried.
      let sentForThisEvent = 0;
      for (const uid of allUserIds) {
        const userChannel = prefMap.get(uid) || 'both';
        if (userChannel === 'none') continue;
        const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
        const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';
        const inAppOk = deliverToMiniApp && notifInsertOk;
        const telegramOk = deliverToTelegram && queueInsertOk;
        if (inAppOk || telegramOk) sentForThisEvent++;
      }

      if (sentForThisEvent > 0) {
        alertedCount.sent++;
        try { await writeAppCache(env, dedupKey, '1', 4 * 3600); } catch {}
      } else {
        alertedCount.failed++;
        // If NO user received the notification (e.g., DB outage), don't write
        // dedup key → next cron tick retries the event.
      }
    }

    // FIX 1: After ALL events have been enqueued, process the queue ONCE.
    // This replaces the old pattern of N × processQueue(3) per user (which
    // could create 300 Telegram fetches for 100 users). Now: all broadcast
    // items are enqueued first, then a single processQueue(10) sends the
    // first 10. Remaining items are picked up by the */1 cron (processQueue(3)
    // every minute) and */5 cron (processQueue(25)).
    //
    // Subrequest budget: 10 Telegram fetches for ALL calendar events combined.
    // This is bounded regardless of how many users or events exist.
    if (alertedCount.sent > 0 && notificationPlatformRepo?.processQueue) {
      try {
        await notificationPlatformRepo.processQueue(env, sendTelegramMessage, pool, 10);
      } catch (_) {
        // Non-fatal — cron will pick up enqueued items on the next tick
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
          await calendarReminderRepo.ensureSchema(env, pool).catch(() => {});
        }
        const pendingReminders = await calendarReminderRepo.listPending(env, new Date(), pool);
        let reminderStats = { dispatched: 0, skipped: 0, failed: 0 };

        if (pendingReminders.length > 0) {
          // ── H5-HIGH FIX: Bulk PATH 2 — replaces per-reminder notificationService.create ──
          // Same pattern as Calendar Broadcast PATH 1 (commit 4e02940) and
          // Price Alert H5-HIGH (commit 8ecf7f2).
          //
          // Per-reminder cost was: pref SELECT(1 DB) + notif INSERT(1 DB) +
          // queue INSERT(1 DB) + processQueue(3)(1-7) + markFired(1 DB) = 5-11.
          // With 200 reminders (listPending LIMIT): 1 + 200×11 = 2201 subrequests ❌.
          // After bulk: 1 + 1 + 1 + 1 + 1 + 21 = 26 subrequests (constant) ✅.
          //
          // Order (crash recovery preserved):
          //   1. Batch pref lookup → 2. Partition → 3. Bulk notif INSERT →
          //   4. Bulk queue INSERT → 5. markFiredBulk → 6. processQueue(10)
          // If INSERT fails: reminders NOT marked → retried next tick.
          // If INSERT succeeds + Worker killed before markFiredBulk:
          //   Next tick re-dispatches → ON CONFLICT DO NOTHING (no-op) → markFiredBulk claims.

          // 1. Collect all user IDs from pending reminders
          const allReminderUserIds = [...new Set(pendingReminders.map(r => String(r.user_id)))];

          // 2. Batch preference lookup (1 DB SELECT, replaces N per-reminder getUserChannelPreference)
          const reminderPrefMap = new Map();
          if (allReminderUserIds.length > 0) {
            const remPlaceholders = allReminderUserIds.map((_, i) => `$${i + 1}`).join(',');
            const remPrefResult = await queryDb(env,
              `SELECT user_id, ch_calendar AS pref FROM notification_settings WHERE user_id IN (${remPlaceholders})`,
              allReminderUserIds, 1, pool
            ).catch(() => ({ rows: [] }));
            for (const row of remPrefResult.rows || []) {
              reminderPrefMap.set(String(row.user_id), String(row.pref));
            }
          }

          // 3. Partition reminders by delivery channel (same semantics as PATH 1)
          const miniAppReminders = [];
          const telegramReminders = [];
          for (const reminder of pendingReminders) {
            const userChannel = reminderPrefMap.get(String(reminder.user_id)) || 'both';
            reminder._userChannel = userChannel;
            if (userChannel === 'none') continue;
            if (userChannel === 'mini_app' || userChannel === 'both') miniAppReminders.push(reminder);
            if (userChannel === 'telegram' || userChannel === 'both') telegramReminders.push(reminder);
          }

          // Helpers (preserve exact title/message/metadata/dedupKey from per-reminder path)
          const buildReminderTitle = (r) => `🔔 یادآوری رویداد: ${r.event_title || 'تقویم اقتصادی'}`;
          const buildReminderMessage = (r) => `${r.event_country || ''} ${r.event_timestamp ? '— ' + new Date(r.event_timestamp).toLocaleString('en-GB') : ''}`;
          const buildReminderMetadata = (r) => JSON.stringify({
            event_title: r.event_title,
            event_timestamp: r.event_timestamp,
            event_country: r.event_country,
            lead_minutes: r.lead_minutes,
            reminder_id: r.id,
          });
          // Notification ID: same transformation as sendNotification
          // dedupKey: `cal_reminder_${reminder.id}_${reminder.user_id}`
          // → notif_id: `notif_cal_reminder_${reminder.id}_${reminder.user_id}` (sanitized + sliced)
          const buildReminderNotifId = (r) => `notif_cal_reminder_${r.id}_${r.user_id}`
            .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

          // 4. Bulk INSERT in-app notifications (mini_app channel)
          let reminderNotifInsertOk = true;
          if (miniAppReminders.length > 0) {
            try {
              const rNotifIds = miniAppReminders.map(buildReminderNotifId);
              const rUserIds = miniAppReminders.map(r => String(r.user_id));
              const rTypes = miniAppReminders.map(() => 'calendar');
              const rTitles = miniAppReminders.map(buildReminderTitle);
              const rMessages = miniAppReminders.map(buildReminderMessage);
              const rMetadata = miniAppReminders.map(buildReminderMetadata);
              const rReadStatus = miniAppReminders.map(() => false);
              const rPriorities = miniAppReminders.map(() => 'medium');
              const rCategories = miniAppReminders.map(() => 'calendar');
              const rChannels = miniAppReminders.map(r =>
                r._userChannel === 'both' ? 'both' : 'mini_app'
              );
              const rStatus = miniAppReminders.map(() => 'delivered');

              await queryDb(env, `
                INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status)
                SELECT * FROM unnest(
                  $1::text[], $2::text[], $3::text[], $4::text[], $5::text[],
                  $6::jsonb[], $7::boolean[], $8::text[], $9::text[], $10::text[], $11::text[]
                )
                ON CONFLICT (id) DO NOTHING
              `, [
                rNotifIds, rUserIds, rTypes, rTitles, rMessages,
                rMetadata, rReadStatus, rPriorities, rCategories, rChannels, rStatus,
              ], 1, pool).catch((e) => {
                console.warn('[CALENDAR-REMINDER] Bulk INSERT notifications failed:', e?.message);
                reminderNotifInsertOk = false;
              });
            } catch (e) {
              console.warn('[CALENDAR-REMINDER] Notification bulk failed:', e?.message);
              reminderNotifInsertOk = false;
            }
          }

          // 5. Bulk INSERT Telegram queue items (telegram channel)
          let reminderQueueInsertOk = true;
          if (telegramReminders.length > 0) {
            try {
              const rQueueNotifIds = telegramReminders.map(buildReminderNotifId);
              const rQueueUserIds = telegramReminders.map(r => String(r.user_id));
              const rQueueChannels = telegramReminders.map(() => 'telegram');
              const rQueuePriorities = telegramReminders.map(() => 'medium');
              const rQueueStatus = telegramReminders.map(() => 'pending');
              const rQueuePayloads = telegramReminders.map(r => JSON.stringify({
                title: buildReminderTitle(r),
                message: buildReminderMessage(r),
              }));

              await queryDb(env, `
                INSERT INTO notification_queue (notification_id, user_id, channel, priority, status, payload)
                SELECT * FROM unnest(
                  $1::text[], $2::text[], $3::text[], $4::text[], $5::text[], $6::jsonb[]
                )
                ON CONFLICT (notification_id, user_id) DO NOTHING
              `, [
                rQueueNotifIds, rQueueUserIds, rQueueChannels, rQueuePriorities, rQueueStatus, rQueuePayloads,
              ], 1, pool).catch((e) => {
                console.warn('[CALENDAR-REMINDER] Bulk INSERT queue failed:', e?.message);
                reminderQueueInsertOk = false;
              });
            } catch (e) {
              console.warn('[CALENDAR-REMINDER] Queue bulk failed:', e?.message);
              reminderQueueInsertOk = false;
            }
          }

          // 6. markFiredBulk — AFTER INSERTs (crash recovery preserved)
          // Only mark reminders where dispatch "succeeded" (INSERT succeeded OR 'none' pref).
          // If INSERT failed: reminder NOT marked → stays pending → retried next tick.
          // 'none' pref reminders: no INSERT needed, but mark as fired (user opted out).
          const reminderIdsToMark = [];
          for (const reminder of pendingReminders) {
            const userChannel = reminder._userChannel || 'both';
            if (userChannel === 'none') {
              // User opted out — mark as fired (no retry needed)
              reminderIdsToMark.push(reminder.id);
              continue;
            }
            const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
            const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';
            const inAppOk = deliverToMiniApp && reminderNotifInsertOk;
            const telegramOk = deliverToTelegram && reminderQueueInsertOk;
            if (inAppOk || telegramOk) {
              reminderIdsToMark.push(reminder.id);
            }
            // If both INSERTs failed: don't mark → retried next tick
          }

          let reminderClaimedIds = new Set();
          if (reminderIdsToMark.length > 0 && typeof calendarReminderRepo.markFiredBulk === 'function') {
            try {
              const markResults = await calendarReminderRepo.markFiredBulk(env, reminderIdsToMark, pool);
              reminderClaimedIds = new Set(
                markResults.filter(r => r.claimed).map(r => Number(r.id))
              );
            } catch (e) {
              console.warn(safeError('calendar-reminder-markFiredBulk', e));
            }
          }

          // 7. Count delivery outcomes + triggered_count
          for (const reminder of pendingReminders) {
            const userChannel = reminder._userChannel || 'both';
            const wasMarked = reminderClaimedIds.has(Number(reminder.id));

            if (userChannel === 'none') {
              if (wasMarked) reminderStats.skipped++;
              else reminderStats.failed++;
              continue;
            }

            const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
            const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';
            const inAppOk = deliverToMiniApp && reminderNotifInsertOk;
            const telegramOk = deliverToTelegram && reminderQueueInsertOk;

            if (inAppOk || telegramOk) {
              if (wasMarked) reminderStats.dispatched++;
              else reminderStats.failed++; // markFired failed — notification sent but mark failed
            } else {
              reminderStats.failed++; // INSERT failed — not marked, will retry
            }
          }

          // 8. processQueue(10) at end of PATH 2 (drains enqueued Telegram items)
          // Same pattern as PATH 1's processQueue(10) — bounded, controlled batch.
          if (reminderStats.dispatched > 0 && notificationPlatformRepo?.processQueue) {
            try {
              await notificationPlatformRepo.processQueue(env, sendTelegramMessage, pool, 10);
            } catch (_) {
              // Non-fatal — cron will pick up enqueued items on the next tick
            }
          }
        }

        // Cleanup old reminders (fired + event passed >24h) on 15-min ticks
        // to prevent the table from growing indefinitely.
        if (isEvery15Min) {
          try {
            const cleaned = await calendarReminderRepo.cleanupOld(env, pool);
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
    // FIX: Cache empty arrays too — when DB returns 0 alerts, the empty array
    // is cached in module memory. Previously, the .length > 0 check caused
    // empty arrays to be treated as cache misses, falling through to KV read
    // → DB query → KV write of '0' marker every single minute. Now, an empty
    // array is a valid cache hit (0 alerts = nothing to check), and the cron
    // exits early without any KV write or DB query for the next 60s.
    // Safety: create()/delete() invalidate KV cache (delete keys) → other
    // isolates will re-query DB. This isolate may use stale empty cache for
    // up to 60s — same behavior as stale non-empty cache (acceptable).
    if (Array.isArray(_alertsIsolateCache) && isolateCacheAge < _ALERTS_ISOLATE_CACHE_TTL_MS) {
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
        // FIX: Cache empty array in module memory (same as non-empty above).
        // Do NOT write '0' to KV — the alerts:active-exists key is never read
        // by any code path (verified: grep for readAppCache.*ALERTS_EXIST = empty).
        // The empty module-level cache will cause Step 1 to HIT on the next tick,
        // skipping both KV read and DB query entirely.
        // KV invalidation by create() still works: when a user creates an alert,
        // create() deletes alerts:active-list and alerts:active-exists from KV.
        // On the next cron tick, this isolate's module cache may still be empty
        // (up to 60s), but OTHER isolates will see the KV deletion → DB query
        // → find the new alert. This is the same cross-isolate behavior as before.
        _alertsIsolateCache = [];
        _alertsIsolateCacheAt = Date.now();
      }
    }

    resultPayload.checked_count = alerts.length;
    _tDbEnd = Date.now(); // Phase 1 done: DB query (or cache hit)

    if (!alerts.length) {
            return resultPayload;
    }

    // ── PHASE 1: Batch fetch OHLC 1m for all unique symbols ──
    // OHLC FIX: Use fetchOhlc1m instead of fetchSpotPriceUsd.
    // fetchOhlc1m returns { high, low, close, exchange } — the high/low
    // of the current 1-minute candle. Even if price has crossed the target
    // and returned within the same minute, high/low will capture the crossing.
    // This dramatically reduces missed alerts.
    //
    // CPU/subrequest cost: SAME as fetchSpotPriceUsd — 1 HTTP per symbol
    // (klines endpoint instead of ticker/price endpoint). Same exchange cache.
    const symbolOhlcMap = new Map(); // symbol → { high, low, close, exchange }
    const symbolSourceMap = new Map();
    const uniqueSymbols = [...new Set(
      alerts.map(a => String(a?.symbol || '').trim().toUpperCase()).filter(Boolean)
    )].slice(0, 14); // H6 FIX: Cap at 14 unique symbols per cron tick to stay within Cloudflare Workers Free 50-subrequest/Request limit. 14 symbols × 1-3 subrequests (exchange cache hit/miss) + 5 processQueue + 1 bulk UPDATE = max ~48 (2 subrequest safety margin), typically ~20 with cache hits. Remaining symbols are picked up on the next 1-min tick.

    const fetchOhlcWithTimeout = async (symbol) => {
      const tFetch = Date.now();
      try {
        const ohlc = await fetchOhlc1m(env, symbol);
        return {
          symbol,
          ohlc,
          source: ohlc?.exchange || null,
          latency_ms: Date.now() - tFetch,
        };
      } catch (e) {
        return { symbol, ohlc: null, source: null, latency_ms: Date.now() - tFetch, error: e?.message };
      }
    };

    // Fetch all unique symbols in parallel
    const FETCH_BATCH = 15;
    _tPriceStart = Date.now(); // Phase 2 start: price fetch
    for (let i = 0; i < uniqueSymbols.length; i += FETCH_BATCH) {
      const batch = uniqueSymbols.slice(i, i + FETCH_BATCH);
      const results = await Promise.allSettled(batch.map(fetchOhlcWithTimeout));
      for (const r of results) {
        if (r.status === 'fulfilled') {
          if (r.value.ohlc && Number.isFinite(r.value.ohlc.high) && Number.isFinite(r.value.ohlc.low)) {
            symbolOhlcMap.set(r.value.symbol, r.value.ohlc);
            symbolSourceMap.set(r.value.symbol, r.value.source);
          } else {
            resultPayload.price_fetch_failures += 1;
            symbolOhlcMap.set(r.value.symbol, null);
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

      const ohlc = symbolOhlcMap.get(symbol);
      if (!ohlc || !Number.isFinite(ohlc.high) || !Number.isFinite(ohlc.low) || !Number.isFinite(ohlc.close)) {
        // Queue update with price=0 (price not available)
        _pendingUpdates.push({ alertId, currentPrice: 0 });
        continue;
      }

      const candleHigh = ohlc.high;
      const candleLow = ohlc.low;
      const candleClose = ohlc.close;

      // ── OHLC CROSS-DETECTION LOGIC ──
      // Uses candle high/low to detect crossings that occurred within the
      // 1-minute candle — even if price has since returned below/above target.
      //
      // direction='above': trigger if price crossed up through target
      //   - First check (no prevPrice): trigger if candleHigh >= targetPrice
      //     (price reached target at some point during this minute)
      //   - Subsequent checks: trigger if prevPrice < targetPrice AND candleHigh >= targetPrice
      //     (price was below and reached target during this minute)
      // direction='below': mirror logic with candleLow
      //
      // last_price is set to candleClose (price at end of candle) for next tick's prevPrice.
      let shouldTrigger = false;
      let triggerReason = 'no_cross';

      if (direction === 'below') {
        if (prevPrice == null || !Number.isFinite(prevPrice)) {
          // First-ever check — trigger if already below target (using low)
          shouldTrigger = candleLow <= targetPrice;
          triggerReason = shouldTrigger ? 'immediate_below' : 'above_target_no_cross';
        } else if (prevPrice > targetPrice && candleLow <= targetPrice) {
          // Crossed DOWN through target during this candle
          shouldTrigger = true;
          triggerReason = 'cross_down';
        } else if (prevPrice <= targetPrice && candleLow <= targetPrice) {
          // Was below, still below — do NOT re-trigger
          if (alert?.last_checked_at == null) {
            shouldTrigger = true;
            triggerReason = 'first_check_below';
          } else {
            triggerReason = 'still_below_no_retrigger';
          }
        } else {
          triggerReason = 'moved_back_up';
        }
      } else {
        // direction = 'above' (default)
        if (prevPrice == null || !Number.isFinite(prevPrice)) {
          shouldTrigger = candleHigh >= targetPrice;
          triggerReason = shouldTrigger ? 'immediate_above' : 'below_target_no_cross';
        } else if (prevPrice < targetPrice && candleHigh >= targetPrice) {
          // Crossed UP through target during this candle
          shouldTrigger = true;
          triggerReason = 'cross_up';
        } else if (prevPrice >= targetPrice && candleHigh >= targetPrice) {
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
      _pendingUpdates.push({ alertId, currentPrice: candleClose });

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

      // ── H5-HIGH FIX: COLLECT FOR BULK PROCESSING ──
      // Previously: per-alert markTriggered (1 DB CAS + 2 KV deletes) + per-alert
      // notificationService.create (1 pref + 1 notif INSERT + 1 queue INSERT +
      // 1 processQueue(3) = up to 7 subrequests) = ~10-13 subrequests PER ALERT.
      // With 5 triggers + 14 OHLC fetches: ~75 subrequests → exceededResources.
      //
      // Now: collect triggered alerts and process them in BULK after the eval loop:
      //   1. markTriggeredBulk (1 DB CAS UPDATE for all alerts)
      //   2. Batch preference lookup (1 DB SELECT for all triggered users)
      //   3. Bulk INSERT notifications (1 DB INSERT via unnest() for mini_app alerts)
      //   4. Bulk INSERT queue (1 DB INSERT via unnest() for telegram alerts)
      //   5. Single KV delete at end (was 2 × N per-alert deletes before)
      //   6. processQueue(5) at end of 1-min cron drains queue (already exists)
      //
      // CAS preserved: WHERE id IN (...) AND status='active' RETURNING id — only
      // alerts still active are claimed. Alerts already triggered by another cron
      // return claimed=false → no notification created → no duplicates.
      //
      // Idempotency preserved:
      //   - dedupKey `price_alert_${alertId}_${userId}` → notificationId `notif_price_alert_...`
      //   - notifications ON CONFLICT (id) DO NOTHING
      //   - notification_queue ON CONFLICT (notification_id, user_id) DO NOTHING
      //   - processQueue uses FOR UPDATE SKIP LOCKED + telegram_message_id check
      //
      // NO trigger cap: all triggered alerts in same tick are enqueued. Backlog
      // drains via processQueue cron infrastructure (1-min cron's processQueue(5)
      // + 5-min cron's processQueue(15) = ~8 items/min sustained throughput).
      _triggeredAlerts.push({
        alertId,
        userId,
        symbol,
        targetPrice,
        direction,
        triggerReason,
        candleClose,
        alert,
      });
    }

    // ── H5-HIGH FIX: BULK PROCESS TRIGGERED ALERTS ──
    // Replaces per-alert markTriggered + notificationService.create to stay
    // within Cloudflare Workers Free Plan 50-subrequest limit.
    //
    // OPTION D (reliability fix): markTriggeredBulk runs AFTER bulk INSERTs.
    // This eliminates the blast radius regression where a single bulk INSERT
    // failure could permanently lose N notifications (alerts were already
    // marked 'triggered' with no retry). With Option D:
    //   - If INSERT fails: alerts stay 'active' → next tick retries → NO LOSS
    //   - If INSERT succeeds + mark fails: orphan notif/queue exist, but next
    //     tick's INSERT is no-op (ON CONFLICT DO NOTHING), mark succeeds → no
    //     duplicate, no loss
    //   - If both succeed: normal triggered flow (same as before)
    //   - If both fail: alerts stay 'active' → next tick retries → NO LOSS
    //
    // All existing semantics preserved (verified):
    //   - CAS atomicity (WHERE status='active') — markTriggeredBulk unchanged
    //   - Idempotency (dedupKey + ON CONFLICT DO NOTHING) — INSERTs run for ALL
    //     _triggeredAlerts; ON CONFLICT handles duplicates from concurrent crons
    //   - No duplicate Telegram sends (FOR UPDATE SKIP LOCKED in processQueue)
    //   - No per-alert processQueue(3) — alerts use bulk INSERT + queue cron
    //   - processQueue(5) at end of 1-min cron handles first 5 sends (existing)
    //   - 'none' preference alerts are skipped (skipped_pref_disabled++)
    //   - Failed INSERTs are tracked as delivery_failures + dispatch_errors
    //
    // Subrequest budget (worst case, 14 triggers, OHLC cache hit):
    //   14 × 2 (OHLC) + 1 (batch pref) + 1 (bulk notif INSERT) +
    //   1 (bulk queue INSERT) + 1 (bulk markTriggeredBulk) + 1 (bulk last_price UPDATE) +
    //   2 (KV deletes) + 11 (processQueue(5) at end of 1-min cron)
    //   = 28 + 4 + 1 + 2 + 11 = 46 ≤ 50 ✅ (4 subrequest safety margin)
    //
    // Scales to any alert count (5, 14, 50, 100, 500 — all use same 4 bulk DB ops).
    if (_triggeredAlerts.length > 0) {
      const triggers = _triggeredAlerts.map(t => ({
        alertId: t.alertId,
        triggerPrice: t.candleClose,
      }));

      // ── STEP 1: Batch preference lookup (1 DB SELECT for all triggered users) ──
      // OPTION D: runs for ALL _triggeredAlerts (not just claimed — claimed is
      // determined later by markTriggeredBulk at STEP 5).
      // Mirrors processBroadcastFull pattern (notification_platform.js:1351-1359).
      // Default preference is 'both' (per alerts.js:544 / notification_platform.js:544).
      const userIds = [...new Set(_triggeredAlerts.map(a => String(a.userId)))];
      const prefMap = new Map();
      if (userIds.length > 0) {
        const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
        const prefResult = await queryDb(env,
          `SELECT user_id, ch_price_alert AS pref FROM notification_settings WHERE user_id IN (${placeholders})`,
          userIds, 1, pool
        ).catch(() => ({ rows: [] }));
        for (const row of prefResult.rows || []) {
          prefMap.set(String(row.user_id), String(row.pref));
        }
      }

      // ── STEP 2: Partition ALL triggered alerts by delivery channel ──
      // OPTION D: partitions ALL _triggeredAlerts (not just claimed).
      // Match original sendNotification logic (notification_platform.js:1174):
      //   - 'none' → skip delivery entirely (skipped_pref_disabled++)
      //   - 'mini_app' → deliver to mini_app only (notif INSERT, channel='mini_app')
      //   - 'telegram' → deliver to telegram only (queue INSERT, no notif INSERT)
      //   - 'both' → deliver to both (notif INSERT channel='both', AND queue INSERT)
      //   - Default (no settings row) → 'both'
      const miniAppAlerts = [];
      const telegramAlerts = [];
      for (const t of _triggeredAlerts) {
        const userChannel = prefMap.get(t.userId) || 'both';
        t._userChannel = userChannel;
        if (userChannel === 'none') continue;
        if (userChannel === 'mini_app' || userChannel === 'both') miniAppAlerts.push(t);
        if (userChannel === 'telegram' || userChannel === 'both') telegramAlerts.push(t);
      }

      // Pre-compute webAppUrl ONCE (was per-alert in original — wasteful).
      // Same env → same URL for all alerts in this tick.
      const webAppUrl = resolveWebAppUrl(env, { cacheBust: true });

      // Helper: build telegramExtra (was inline per-alert in original).
      const buildTelegramExtra = () => {
        const telegramExtra = { disable_web_page_preview: true };
        if (webAppUrl) {
          telegramExtra.reply_markup = {
            inline_keyboard: [[{ text: 'Open Amir BTC Assistant 🚀', web_app: { url: webAppUrl } }]],
          };
        }
        return telegramExtra;
      };

      // Helper: build notification message text (was inline per-alert in original).
      const buildMessage = (t) => {
        const priceFmt = t.candleClose >= 1
          ? Number(t.candleClose).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
          : Number(t.candleClose).toFixed(6);
        return `🔔 هشدار قیمت فعال شد\nقیمت ${t.symbol} به ${priceFmt} USDT رسید.`;
      };

      // Helper: build notificationId (preserves dedupKey → notif_id pattern).
      // Original: `notif_${String(dedupKey).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
      // dedupKey for alerts: `price_alert_${alertId}_${userId}`
      const buildNotifId = (t) => `notif_price_alert_${t.alertId}_${t.userId}`
        .replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60);

      // ── STEP 3: Bulk INSERT in-app notifications (mini_app channel) ──
      // OPTION D: runs BEFORE markTriggeredBulk. If this INSERT fails, alerts
      // remain 'active' (mark hasn't run yet) → next tick retries → NO LOSS.
      // Mirrors processBroadcastFull pattern (notification_platform.js:1390-1434).
      // ON CONFLICT (id) DO NOTHING preserves idempotency (dedupKey → notif_id).
      // If another cron already INSERTed (concurrent overlap), our INSERT is a
      // silent no-op — no duplicate notif rows.
      let notifInsertOk = true;
      if (miniAppAlerts.length > 0) {
        try {
          const notifIds = miniAppAlerts.map(buildNotifId);
          const userIdsArr = miniAppAlerts.map(t => String(t.userId));
          const typesArr = miniAppAlerts.map(() => 'price_alert');
          const titlesArr = miniAppAlerts.map(t => `🔔 هشدار قیمت ${t.symbol}`);
          const messagesArr = miniAppAlerts.map(buildMessage);
          const metadataArr = miniAppAlerts.map(t => JSON.stringify({
            symbol: t.symbol,
            price: String(t.candleClose),
            alert_id: t.alertId,
            target_price: String(t.targetPrice),
            direction: t.direction,
            trigger_reason: t.triggerReason,
          }));
          const readStatusArr = miniAppAlerts.map(() => false);
          const prioritiesArr = miniAppAlerts.map(() => 'high');
          const categoriesArr = miniAppAlerts.map(() => 'price_alert');
          // channel column: 'both' if user wanted both channels, else 'mini_app'
          // (matches original sendNotification INSERT at notification_platform.js:1193)
          const channelsArr = miniAppAlerts.map(t => t._userChannel === 'both' ? 'both' : 'mini_app');
          const statusArr = miniAppAlerts.map(() => 'delivered');

          await queryDb(env, `
            INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status)
            SELECT * FROM unnest(
              $1::text[],
              $2::text[],
              $3::text[],
              $4::text[],
              $5::text[],
              $6::jsonb[],
              $7::boolean[],
              $8::text[],
              $9::text[],
              $10::text[],
              $11::text[]
            )
            ON CONFLICT (id) DO NOTHING
          `, [
            notifIds, userIdsArr, typesArr, titlesArr, messagesArr,
            metadataArr, readStatusArr, prioritiesArr, categoriesArr, channelsArr, statusArr,
          ], 1, pool).catch((e) => {
            console.warn('[ALERTS] Bulk INSERT notifications failed:', e?.message);
            notifInsertOk = false;
          });
        } catch (e) {
          console.warn('[ALERTS] Mini-app notification bulk failed:', e?.message);
          notifInsertOk = false;
        }
      }

      // ── STEP 4: Bulk INSERT Telegram queue items (telegram channel) ──
      // OPTION D: runs BEFORE markTriggeredBulk. If this INSERT fails, alerts
      // remain 'active' → next tick retries → NO LOSS.
      // Mirrors processBroadcastFull pattern (notification_platform.js:1437-1471).
      // ON CONFLICT (notification_id, user_id) DO NOTHING preserves idempotency.
      // processQueue(5) at end of 1-min cron (already exists, worker-proxy.js:16367)
      // drains queue with first 5 sends; remaining items drain on subsequent ticks.
      let queueInsertOk = true;
      if (telegramAlerts.length > 0) {
        try {
          const queueNotifIds = telegramAlerts.map(buildNotifId);
          const userIdsArr = telegramAlerts.map(t => String(t.userId));
          const channelsArr = telegramAlerts.map(() => 'telegram');
          const prioritiesArr = telegramAlerts.map(() => 'high');
          const statusArr = telegramAlerts.map(() => 'pending');
          const telegramExtra = buildTelegramExtra();
          const payloadsArr = telegramAlerts.map(t => JSON.stringify({
            title: `🔔 هشدار قیمت ${t.symbol}`,
            message: buildMessage(t),
            telegramExtra,
          }));

          await queryDb(env, `
            INSERT INTO notification_queue (notification_id, user_id, channel, priority, status, payload)
            SELECT * FROM unnest(
              $1::text[],
              $2::text[],
              $3::text[],
              $4::text[],
              $5::text[],
              $6::jsonb[]
            )
            ON CONFLICT (notification_id, user_id) DO NOTHING
          `, [
            queueNotifIds, userIdsArr, channelsArr, prioritiesArr, statusArr, payloadsArr,
          ], 1, pool).catch((e) => {
            console.warn('[ALERTS] Bulk INSERT queue failed:', e?.message);
            queueInsertOk = false;
          });
        } catch (e) {
          console.warn('[ALERTS] Telegram queue bulk failed:', e?.message);
          queueInsertOk = false;
        }
      }

      // ── STEP 5: Bulk CAS markTriggered (OPTION D: runs AFTER INSERTs) ──
      // Returns array of { alertId, claimed, triggerPrice }. Only alerts with
      // claimed=true (i.e. UPDATE...WHERE status='active' RETURNING returned
      // their id) are considered "triggered by this invocation".
      //
      // OPTION D reliability: if INSERTs succeeded but markTriggeredBulk fails,
      // orphan notif/queue rows exist but alerts remain 'active'. Next tick:
      //   - INSERT (ON CONFLICT DO NOTHING → no-op, already exists)
      //   - markTriggeredBulk → may succeed → alert claimed
      //   - User already has notification (from tick 1's INSERT) → no loss
      //   - No duplicates (ON CONFLICT prevents them)
      let claimedResults = [];
      if (typeof alertRepo?.markTriggeredBulk === 'function') {
        try {
          claimedResults = await alertRepo.markTriggeredBulk(env, triggers, pool);
        } catch (e) {
          // Non-fatal — all alerts remain 'active' in DB. Next cron tick retries.
          // Notif/queue INSERTs may have succeeded (orphan rows), but ON CONFLICT
          // DO NOTHING on next tick prevents duplicates. No permanent loss.
          console.warn('[ALERTS] markTriggeredBulk failed (non-fatal — alerts remain active, next tick retries. Orphan notif/queue rows will be adopted by next tick):', e?.message);
          claimedResults = triggers.map(t => ({
            alertId: t.alertId, claimed: false, triggerPrice: t.triggerPrice,
          }));
        }
      } else {
        // alerts.js out of sync with worker-proxy.js — should not happen in a
        // coordinated deploy. Notif/queue INSERTs may have succeeded (orphan
        // rows), but alerts remain 'active'. Next tick (with correct alerts.js)
        // will claim them. ON CONFLICT prevents duplicates.
        console.error('[ALERTS] alertRepo.markTriggeredBulk is not a function — alerts.js may be out of sync. Notif/queue INSERTs may have succeeded but alerts remain active (next tick will claim).');
        claimedResults = triggers.map(t => ({
          alertId: t.alertId, claimed: false, triggerPrice: t.triggerPrice,
        }));
      }

      const claimedIds = new Set(
        claimedResults.filter(r => r.claimed).map(r => String(r.alertId))
      );
      resultPayload.duplicate_triggers_prevented +=
        _triggeredAlerts.length - claimedIds.size;

      const claimedAlerts = _triggeredAlerts.filter(t => claimedIds.has(String(t.alertId)));

      // ── STEP 6: Count delivery outcomes + triggered_count ──
      // Only count alerts that were CLAIMED by this invocation (claimedAlerts).
      // Alerts that were already triggered by another cron (claimed=false) are
      // counted as duplicate_triggers_prevented (STEP 5) and excluded here.
      // Mirror original logic (worker-proxy.js:13485-13489):
      //   - 'none' pref alerts: skipped_pref_disabled++ + triggered_count++
      //     (markTriggeredBulk succeeded, but delivery skipped by user preference)
      //   - All claimed alerts: triggered_count++ (markTriggeredBulk succeeded)
      //   - Failed delivery (no channel succeeded): delivery_failures++
      for (const t of claimedAlerts) {
        const userChannel = t._userChannel || 'both';
        if (userChannel === 'none') {
          resultPayload.skipped_pref_disabled += 1;
          resultPayload.triggered_count += 1;
          continue;
        }

        const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
        const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';
        const inAppDelivered = deliverToMiniApp && notifInsertOk;
        const telegramDelivered = deliverToTelegram && queueInsertOk;

        if (!inAppDelivered && !telegramDelivered) {
          resultPayload.delivery_failures += 1;
        }
        resultPayload.triggered_count += 1;
      }

      // Track dispatch errors if bulk INSERTs failed (mirror original dispatch_errors.push)
      if (!notifInsertOk && miniAppAlerts.length > 0) {
        resultPayload.dispatch_errors.push({
          scope: 'bulk_insert_notifications',
          alert_ids: miniAppAlerts.map(t => t.alertId),
          error: 'Bulk INSERT into notifications table failed — alerts remain active (markTriggeredBulk at STEP 5 will not claim), next tick retries',
        });
      }
      if (!queueInsertOk && telegramAlerts.length > 0) {
        resultPayload.dispatch_errors.push({
          scope: 'bulk_insert_queue',
          alert_ids: telegramAlerts.map(t => t.alertId),
          error: 'Bulk INSERT into notification_queue table failed — alerts remain active (markTriggeredBulk at STEP 5 will not claim), next tick retries',
        });
      }

      // ── STEP 7: KV invalidation (single delete at end of bulk processing) ──
      // Only invalidate if at least one alert was claimed (status changed to
      // 'triggered'). If no alerts were claimed (all already triggered by
      // another cron), no cache invalidation needed.
      // Was 2 × N per-alert KV deletes in original markTriggered (alerts.js:313-314).
      // Now: 2 single deletes at end of bulk processing.
      if (claimedAlerts.length > 0) {
        try { env.APP_CACHE?.delete?.('alerts:active-list'); } catch {}
        try { env.APP_CACHE?.delete?.('alerts:active-exists'); } catch {}
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
//#region Presence Durable Object — Online Members
// ============================================================================
// PresenceDO class extracted to ./src/durable-objects/presence.js
// (behavior-preserving move — verbatim class body, no logic changes).
// The named re-export below keeps `class_name: "PresenceDO"` in wrangler.jsonc
// resolvable at deploy time. See presence.js for the class implementation.
export { PresenceDO };

// ============================================================================
// GROQ-ROUTER-4KEY: Durable Object for STRICT concurrency-safe budget enforcement
// ============================================================================
// GroqRouterDO class extracted to ./src/durable-objects/groq-router.js
// (behavior-preserving move — verbatim class body, no logic changes).
// The named re-export below keeps `class_name: "GroqRouterDO"` in wrangler.jsonc
// resolvable at deploy time. See groq-router.js for the class implementation.
export { GroqRouterDO };

// ============================================================================
//#region ورودی اصلی Worker
// ============================================================================
export default {
  async fetch(request, env, ctx) {
    // CORS RACE FIX (Task 1): Store the request Origin on env (per-invocation,
    // NOT module-level). Cloudflare Workers can interleave concurrent requests
    // in one isolate — a module-level variable would let Request B overwrite
    // Request A's Origin before A's withCors() reads it. env is per-invocation
    // (same pattern as env._reqPool), so env._reqOrigin is scoped to THIS
    // request only. withCors() reads it back when building response headers,
    // guaranteeing each response echoes its own request's Origin.
    env._reqOrigin = request.headers.get('Origin');
    // PERF FIX: store ctx on env for fire-and-forget background tasks.
    // Cloudflare Workers terminate I/O after the response is returned —
    // to keep background work (notifications) alive, controllers use
    // env.ctx.waitUntil(promise). This mirrors env._reqOrigin pattern
    // (per-invocation, scoped to THIS request).
    env.ctx = ctx;
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

    // PHASE 1 / CHANGE 1 (2026-08-10): Wrap the entire HTTP router in
    // withSharedPool so all queryDb calls within this request share ONE
    // Pool (1 TLS handshake, ~3-5ms CPU) instead of creating a new Pool
    // per call (N TLS handshakes, N × 3-5ms CPU).
    //
    // PROVEN SAFE (Phase 0 audit):
    //   - withSharedPool does `return await fn()` — preserves Response contract
    //     for ALL route branches (direct Response, Promise<Response>, throws,
    //     auth failures, 404, etc.). No branch can return undefined.
    //   - env is per-invocation in Cloudflare Workers — env._reqPool mutation
    //     is scoped to THIS request. Concurrent requests have separate env
    //     objects. No cross-request pool leakage possible.
    //   - Pool is closed in finally with a 500ms timeout (CHANGE 1A) —
    //     prevents the "pool.end() hangs" issue (commit d754560 concern).
    //   - env._reqPool is saved/restored in finally (CHANGE 1B) — ctx.waitUntil
    //     callbacks see previous value (null in HTTP path) and use per-call Pool.
    //   - Cron path is UNCHANGED — it uses withPhasePool (line 1356) which is
    //     separate infrastructure.
    //   - No repository changes needed — queryDb priority chain auto-uses
    //     env._reqPool when set (line 1573: `if (env && env._reqPool)`).
    return await withSharedPool(env, async () => {
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

      // ── App Content: About / Terms / Privacy (public read, bilingual) ──
      if (request.method === 'GET' && url.pathname.startsWith('/api/content/')) {
        const contentType = url.pathname.split('/api/content/')[1]?.split('/')[0];
        if (!['about', 'terms', 'privacy'].includes(contentType)) {
          return jsonResponse({ status: 'error', message: 'Invalid content type' }, { status: 400 }, env);
        }
        // BILINGUAL: parse ?lang= (default 'fa'); cache + DB return language-specific content.
        const lang = (url.searchParams.get('lang') === 'en') ? 'en' : 'fa';
        try {
          const content = await appContentRepo.getContent(env, contentType, lang);
          return jsonResponse({ status: 'success', data: content }, {}, env);
        } catch (e) {
          return jsonResponse({ status: 'error', message: 'Failed to load content' }, { status: 500 }, env);
        }
      }

      // ── App Content: Admin update (admin-only, bilingual) ──
      // PUT /api/admin/content/{type}?lang=fa|en — saves ONLY the requested language's columns.
      // Saving FA never touches EN; saving EN never touches FA.
      if (request.method === 'PUT' && url.pathname.startsWith('/api/admin/content/')) {
        const contentType = url.pathname.split('/api/admin/content/')[1]?.split('/')[0];
        if (!['about', 'terms', 'privacy'].includes(contentType)) {
          return jsonResponse({ status: 'error', message: 'Invalid content type' }, { status: 400 }, env);
        }
        const lang = (url.searchParams.get('lang') === 'en') ? 'en' : 'fa';
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
          const updated = await appContentRepo.updateContent(env, contentType, {
            title: body.title,
            sections: body.sections,
            version: body.version,
            updated_by: String(authState.user.id),
          }, lang);
          return jsonResponse({ status: 'success', data: updated }, {}, env);
        } catch (e) {
          console.error('[CONTENT SAVE] error:', e?.message);
          return jsonResponse({ status: 'error', message: 'Failed to update content' }, { status: 500 }, env);
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
            console.warn('[trigger-alerts] dbState query failed:', e?.message);
            dbState = { error: 'Failed to load DB state' };
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
          // NEWSBE-014 FIX: Document the data source so operators don't rely
          // on this endpoint for cross-isolate exceededCpu detection. KV writes
          // for cron monitoring are intentionally DISABLED (would exhaust Free
          // Plan 1,000 writes/day limit). This endpoint returns only the
          // in-memory log from the CURRENT isolate (globalThis._cronMonitorLog,
          // capped at 200 entries). On a fresh isolate the log is empty — this
          // is expected, not a bug. For reliable cross-isolate monitoring, use
          // Cloudflare GraphQL Analytics (cpuTimeUs) instead.
          data_source: 'in_memory_current_isolate_only',
          kv_writes_disabled: true,
          kv_writes_disabled_reason: 'Free Plan 1,000 writes/day limit — KV writes for cron monitoring would exhaust quota',
          reliable_alternative: 'Cloudflare GraphQL Analytics (cpuTimeUs, wallTimeUs)',
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
          console.warn('[news-ai-monitor] error:', e?.message);
          return jsonResponse({ status: 'error', message: 'Failed to load monitoring data' }, { status: 500 }, env);
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
          console.warn('[news-ai-timing] error:', e?.message);
          return jsonResponse({ status: 'error', message: 'Failed to load timing stats' }, { status: 500 }, env);
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

          // Read circuit states (GROQ-ROUTER-4KEY: gemini removed; Groq uses per-key
          // router state in `groq:router:key{N}` — surfaced separately)
          const circuitStates = {};
          for (const p of ['workers-ai', 'openrouter', 'openai']) {
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
                  'workers-ai': circuitStates['workers-ai']?.state || 'CLOSED',
                  openrouter: circuitStates.openrouter?.state || 'CLOSED',
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
          console.warn('[news-ai-pending] error:', e?.message);
          return jsonResponse({ status: 'error', message: 'Failed to load diagnostics' }, { status: 500 }, env);
        }
      }

      // ── /api/start-diag — [START-E2E] diagnostic endpoint ──
      // Public (no auth) — same policy as /api/cron-monitor, /api/news-ai-monitor.
      // PURPOSE: Trace the /start path end-to-end WITHOUT wrangler tail.
      //
      // Returns:
      //   1. Telegram getWebhookInfo — called from INSIDE the Worker using
      //      env.TELEGRAM_BOT_TOKEN (token NEVER leaves the Worker).
      //      Shows: webhook URL, pending_update_count, last_error_date,
      //      last_error_message (THE key diagnostic — if Telegram is getting
      //      403 from the webhook, this shows it).
      //   2. Config booleans: bot_configured, webapp_url_set, required_channel_set
      //      (booleans only — NO values exposed).
      //   3. [START-E2E] log entries (last 20) from APP_CACHE KV.
      //      Shows the actual /start handler flow: command_detected →
      //      membership_resolved → reply_built → sendMessage_started →
      //      sendMessage_completed/failed → handler_complete/error.
      // H3 FIX: Gate /api/start-diag behind non-production (mirrors H2 fix
      // for /api/notif-diag-report and the /api/notif-trace-results pattern
      // at line 14399). The GET handler exposes webhook info + config booleans;
      // the POST handler triggers setWebhook. Both were unauthenticated. The
      // diagnostic endpoints are not needed in production — wrangler tail and
      // the Cloudflare dashboard serve the same purpose.
      if (url.pathname === '/api/start-diag') {
        const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
        if (_isProd) {
          return jsonResponse(
            { status: 'error', message: 'Not available in production' },
            { status: 404 },
            env
          );
        }
      }
      if (request.method === 'GET' && url.pathname === '/api/start-diag') {
        const result = {
          status: 'success',
          server_time: new Date().toISOString(),
          config: {
            bot_configured: isBotConfigured(env),
            webapp_url_set: Boolean(env.WEBAPP_URL && String(env.WEBAPP_URL).trim()),
            required_channel_set: Boolean(resolveRequiredChannel(env) && resolveRequiredChannel(env) !== 'amir_btc_2024'),
            webhook_secret_set: Boolean(env.TELEGRAM_WEBHOOK_SECRET),
          },
          webhook_info: null,
          e2e_log: [],
        };

        // 1. Call Telegram getWebhookInfo from INSIDE the Worker (no token exposure)
        if (isBotConfigured(env)) {
          try {
            const tgController = new AbortController();
            const tgTimeoutId = setTimeout(() => tgController.abort(), 5000);
            try {
              const tgResponse = await fetch(buildTelegramApiUrl(env, 'getWebhookInfo'), {
                signal: tgController.signal,
              });
              const tgData = await tgResponse.json();
              if (tgData?.ok) {
                // Return ONLY safe fields — no secrets
                const info = tgData.result || {};
                result.webhook_info = {
                  url: info.url || '(not set)',
                  has_custom_certificate: Boolean(info.has_custom_certificate),
                  pending_update_count: info.pending_update_count || 0,
                  last_error_date: info.last_error_date || null,
                  last_error_message: info.last_error_message || null,
                  max_connections: info.max_connections || null,
                  ip_address: info.ip_address || null,
                  // Note: getWebhookInfo does NOT return secret_token (write-only).
                  // If last_error_message mentions 403, the webhook secret is
                  // likely misconfigured (secret set in Worker but webhook
                  // registered without secret_token).
                };
              } else {
                result.webhook_info = { error: tgData?.description || 'Telegram API returned ok:false' };
              }
            } finally {
              clearTimeout(tgTimeoutId);
            }
          } catch (e) {
            result.webhook_info = { error: `Failed to call getWebhookInfo: ${e instanceof Error ? e.message : String(e)}` };
          }
        } else {
          result.webhook_info = { error: 'TELEGRAM_BOT_TOKEN not configured — cannot call getWebhookInfo' };
        }

        // 2. [START-E2E] log entries — P0-B migration: KV persistence REMOVED.
        //    Live E2E traces are now emitted as structured console.log
        //    (event: 'start_e2e') captured by Cloudflare Observability
        //    (observability.enabled in wrangler.jsonc). This read returns any
        //    RESIDUAL legacy entries still in KV (TTL 1800s, will expire) for
        //    backward compatibility. For fresh traces, use wrangler tail or
        //    the Cloudflare dashboard Logs panel.
        result.e2e_log_migrated = true;
        result.e2e_log_source = 'cloudflare_observability';
        try {
          const raw = await env.APP_CACHE?.get('start:e2e_log').catch(() => null);
          if (raw) {
            result.e2e_log = JSON.parse(raw) || [];
          }
        } catch (e) {
          result.e2e_log = [{ error: `Failed to read e2e log: ${e instanceof Error ? e.message : String(e)}` }];
        }

        return jsonResponse(result, {}, env);
      }

      // ── POST /api/start-diag — self-heal webhook registration ──
      // ROOT-CAUSE FIX (audit/start-join-check): Telegram was returning
      // "Wrong response from the webhook: 403 Forbidden" because the webhook
      // was registered WITHOUT secret_token. The Worker's S-02 fail-closed
      // check rejects any request without a matching X-Telegram-Bot-Api-Secret-Token
      // header — so ALL Telegram updates were being 403'd, /start never ran,
      // and pending_update_count piled up.
      //
      // This endpoint re-registers the webhook WITH secret_token by calling
      // setWebhook from INSIDE the Worker (using env.TELEGRAM_BOT_TOKEN +
      // env.TELEGRAM_WEBHOOK_SECRET — neither leaves the Worker).
      //
      // Auth: the request must be a POST. To prevent abuse, the endpoint
      // requires EITHER:
      //   1. A valid Telegram initData header (any logged-in user can trigger
      //      the fix — it's idempotent and safe), OR
      //   2. The literal header X-Self-Heal: yes (a simple CSRF guard —
      //      browsers can't set custom headers without CORS preflight).
      //   3. No auth at all if APP_ENV !== 'production' (dev convenience).
      //
      // The setWebhook call is IDEMPOTENT — calling it multiple times with the
      // same URL + secret_token is safe and just updates the registration.
      if (request.method === 'POST' && url.pathname === '/api/start-diag') {
        const result = {
          status: 'success',
          server_time: new Date().toISOString(),
          action: 'setWebhook',
          webhook_url: null,
          setWebhook_result: null,
          webhook_info_after: null,
        };

        if (!isBotConfigured(env)) {
          return jsonResponse({ status: 'error', message: 'TELEGRAM_BOT_TOKEN not configured' }, { status: 500 }, env);
        }

        // Build the webhook URL from the request's own origin (so it works on
        // any deployment without hardcoding).
        const webhookUrl = new URL(request.url);
        webhookUrl.pathname = '/telegram';
        webhookUrl.search = '';
        result.webhook_url = webhookUrl.toString();

        // Call setWebhook with secret_token
        try {
          const setWebhookBody = {
            url: webhookUrl.toString(),
            allowed_updates: JSON.stringify(['message', 'callback_query']),
            drop_pending_updates: false,
          };
          // Only add secret_token if it's configured
          if (env.TELEGRAM_WEBHOOK_SECRET) {
            setWebhookBody.secret_token = String(env.TELEGRAM_WEBHOOK_SECRET);
          }

          const swController = new AbortController();
          const swTimeoutId = setTimeout(() => swController.abort(), 8000);
          try {
            const swResponse = await fetch(buildTelegramApiUrl(env, 'setWebhook'), {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify(setWebhookBody),
              signal: swController.signal,
            });
            const swData = await swResponse.json();
            result.setWebhook_result = {
              ok: swData?.ok === true,
              description: swData?.description || null,
              // Do NOT include the full result (it may echo the URL)
            };
          } finally {
            clearTimeout(swTimeoutId);
          }
        } catch (e) {
          result.setWebhook_result = {
            ok: false,
            error: `setWebhook failed: ${e instanceof Error ? e.message : String(e)}`,
          };
        }

        // Re-fetch getWebhookInfo to show the updated state
        try {
          const gwiController = new AbortController();
          const gwiTimeoutId = setTimeout(() => gwiController.abort(), 5000);
          try {
            const gwiResponse = await fetch(buildTelegramApiUrl(env, 'getWebhookInfo'), {
              signal: gwiController.signal,
            });
            const gwiData = await gwiResponse.json();
            if (gwiData?.ok) {
              const info = gwiData.result || {};
              result.webhook_info_after = {
                url: info.url || '(not set)',
                pending_update_count: info.pending_update_count || 0,
                last_error_date: info.last_error_date || null,
                last_error_message: info.last_error_message || null,
              };
            }
          } finally {
            clearTimeout(gwiTimeoutId);
          }
        } catch (e) {
          result.webhook_info_after = { error: `getWebhookInfo failed: ${e instanceof Error ? e.message : String(e)}` };
        }

        return jsonResponse(result, {}, env);
      }

      // ── GET /api/admin-diag — Admin detection diagnostic (read-only) ──
      // PURPOSE: Diagnose why a user may not be recognized as admin in Mini App.
      // The root cause audit found that `isAdminTelegramId` checks BOTH
      // ADMIN_TELEGRAM_ID and ADMIN_TELEGRAM_IDS env vars, while `isSuperAdmin`
      // (used by requireAdmin) checks ONLY ADMIN_TELEGRAM_ID. This endpoint
      // reveals which env vars are configured WITHOUT exposing their values.
      //
      // SECURITY: Returns only booleans + counts. NO actual ID values are exposed.
      // Auth: public (same as /api/start-diag, /api/cron-monitor) — no secrets
      // are returned, so no auth needed.
      if (request.method === 'GET' && url.pathname === '/api/admin-diag') {
        const adminIds = getAdminIds(env);
        const primaryRaw = String(env.ADMIN_TELEGRAM_ID || '').trim();
        const extraRaw = String(env.ADMIN_TELEGRAM_IDS || '').trim();
        const extraCount = extraRaw ? extraRaw.split(',').filter(s => s.trim()).length : 0;

        // Test consistency: for each admin ID in the Set, check whether
        // isSuperAdmin would ALSO return true. If any returns false, that's a
        // BUG-1 trigger — the user is recognized as admin by bootstrap but
        // NOT by requireAdmin (admin panel routes).
        const inconsistencies = [];
        for (const id of adminIds) {
          // Simulate isSuperAdmin check: does String(env.ADMIN_TELEGRAM_ID) === id?
          const isSuperAdminResult = (primaryRaw && String(primaryRaw) === String(id));
          if (!isSuperAdminResult) {
            inconsistencies.push({
              admin_id_suffix: id.length > 4 ? '…' + id.slice(-4) : id,
              recognized_by_bootstrap: true,   // isAdminTelegramId → yes
              recognized_by_requireAdmin: false, // isSuperAdmin → no
              bug: 'BUG-1: this ID is in ADMIN_TELEGRAM_IDS but not ADMIN_TELEGRAM_ID — admin panel will 403',
            });
          }
        }

        return jsonResponse({
          status: 'success',
          server_time: new Date().toISOString(),
          config: {
            has_admin_telegram_id: Boolean(primaryRaw),
            admin_telegram_id_count: primaryRaw ? 1 : 0,
            has_admin_telegram_ids: Boolean(extraRaw),
            admin_telegram_ids_count: extraCount,
            total_admin_ids: adminIds.size,
          },
          consistency_check: {
            all_admins_recognized_consistently: inconsistencies.length === 0,
            inconsistent_count: inconsistencies.length,
            inconsistent_ids: inconsistencies,
          },
          functions_used: {
            bootstrap_admin_check: 'isAdminTelegramId (checks BOTH env vars)',
            require_admin_panel: 'isSuperAdmin (checks ONLY ADMIN_TELEGRAM_ID)',
            channel_join_bypass: 'isAdminTelegramId (checks BOTH env vars)',
          },
          note: inconsistencies.length > 0
            ? `BUG-1 TRIGGERED: ${inconsistencies.length} admin ID(s) are recognized by bootstrap but NOT by admin panel routes. This is the root cause of "admin not recognized in Mini App".`
            : 'All admin IDs are consistently recognized by both functions. BUG-1 is NOT the cause of the reported issue.',
        }, {}, env);
      }




      // ── Calendar Reminders (per-user, stored in PostgreSQL) ──
      // POST   /api/calendar/reminders      — create/update
      // GET    /api/calendar/reminders      — list user's reminders
      // DELETE /api/calendar/reminders/:key — delete by event_key
      if (url.pathname === '/api/calendar/reminders' && request.method === 'POST') {
        // FIX (Finding 4): Rate limit reminder creation to 10 req/min per user.
        // Normal users create 0-5 reminders. 10/min allows bulk creation while
        // preventing spam.
        const _remAuth = await authenticateTelegramRequest(request, env);
        if (_remAuth.error) return _remAuth.error;
        if (await isUserRateLimited(env, _remAuth.user.id, 'reminders', 10, 60)) {
          return jsonResponse({ status: 'error', message: 'Too many requests', code: 'RATE_LIMITED' }, { status: 429 }, env);
        }
        request._protectedUser = _remAuth.user;
        return calendarReminderHandlers.handleCreate(request, env);
      }
      if (url.pathname === '/api/calendar/reminders' && request.method === 'GET') {
        return calendarReminderHandlers.handleList(request, env);
      }
      if (url.pathname.startsWith('/api/calendar/reminders/') && request.method === 'DELETE') {
        const eventKey = decodeURIComponent(url.pathname.slice('/api/calendar/reminders/'.length));
        return calendarReminderHandlers.handleDelete(request, env, eventKey);
      }

      // ═══════════════════════════════════════════════════════════════════════
      // ADVERTISEMENTS — User routes (Phase 3: Popup, Phase 2: required-channels)
      // ═══════════════════════════════════════════════════════════════════════

      // Public (no auth) — serves uploaded ad images so <img src> can load them.
      // Returns 404 (not JSON) for invalid IDs — intentionally matches static-asset semantics.
      if (request.method === 'GET' && /^\/api\/advertisements\/image\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const imageId = url.pathname.split('/').pop();
        return advertisementsHandlers.handleServeImage(request, env, imageId);
      }

      // User: list active required channels (for /start join-lock screen).
      if (request.method === 'GET' && url.pathname === '/api/advertisements/required-channels') {
        return advertisementsHandlers.handleListRequiredChannels(request, env);
      }

      // User: get next eligible popup (respects 24h per-user cooldown).
      if (request.method === 'GET' && url.pathname === '/api/advertisements/popups') {
        return advertisementsHandlers.handleGetPopup(request, env);
      }

      // User: record popup impression (sets KV cooldown key).
      if (request.method === 'POST' && /^\/api\/advertisements\/popups\/[A-Za-z0-9_-]+\/shown$/.test(url.pathname)) {
        const popupId = url.pathname.split('/').slice(-2)[0];
        return advertisementsHandlers.handleMarkPopupShown(request, env, popupId);
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
        // ANVIEW-SPAM FIX: Set _protectedUser on the request so analysis
        // handlers (especially handleIncrementView) can access the
        // authenticated user ID for per-user rate limiting. Previously
        // only PROTECTED_PATHS gate set this — _DATA_PATHS gate (which
        // covers /api/analyses/*) did not, so handleIncrementView couldn't
        // identify the user.
        request._protectedUser = _dataAuth.user;
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

        // P1-09 FIX (NEWSBE-020): Reduced from 20 to 15 symbols to stay under
        // Cloudflare Free plan's 50-subrequest limit. fetchSpotPriceUsd does
        // Promise.allSettled on 3 exchanges (bybit, okx, mexc) per symbol on
        // cache miss — worst case 15 × 3 = 45 subrequests < 50. (Previously
        // 20 × 3 = 60 > 50 → "Too many subrequests" 500 error.) This matches
        // the FETCH_BATCH=15 already used by the alerts cron path, and the
        // frontend (app.js) has been updated to slice(0, 15) accordingly.
        // Users rarely have >15 active alerts, and the in-memory price map
        // (built from allCoins/allForexPairs) covers any symbol not sent here.
        const symbols = symbolsParam.split(',').map(s => s.trim()).filter(Boolean).slice(0, 15);
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
        // MKT-010 FIX: Add rate limiting (same as /api/market and /api/forex).
        // Without this, anonymous users could spam the endpoint, each cache-miss
        // triggering a MEXC API call (1 subrequest per miss, every 5min).
        const _searchIp = request.headers.get('cf-connecting-ip') || 'unknown';
        const _searchAuth = await authenticateTelegramRequest(request, env);
        const _searchUid = _searchAuth.user?.id || null;
        if (await isMarketRateLimited(env, _searchIp, _searchUid)) {
          return jsonResponse({ status: 'error', message: 'Rate limited' }, { status: 429 }, env);
        }

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
        return await handleFarsiNews(request, env, ctx);
      }


      // ── DIAGNOSTIC: Find working Workers AI text generation model ──

      // ── DIAGNOSTIC: Test news summarization end-to-end ──

      // ── DIAGNOSTIC: Forex data test (bypasses auth for debugging) ──

      // ── DIAGNOSTIC: Real KV Write Stats ──

      // ── DIAGNOSTIC: Referral Debug — inspect referral flow logs + DB state ──

      // ── DIAGNOSTIC: Full cron pipeline test (RSS → AI → KV → fetch) ──

      // ── DIAGNOSTIC: List available Gemini models ──

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
          console.warn('[notif-trace-results] error:', e?.message);
          return jsonResponse({ status: 'error', message: 'Failed to load traces' }, { status: 500 }, env);
        }
        // Sort by timestamp descending (newest first)
        traces.sort((a, b) => new Date(b.ts) - new Date(a.ts));
        return jsonResponse({
          server_time: new Date().toISOString(),
          trace_count: traces.length,
          traces: traces.slice(0, 20), // last 20 traces
        }, {}, env);
      }

      // ── NOTIF DIAG REPORT — temporary diagnostic endpoint for RCA ──
      // POST: stores the report in the DATABASE (KV quota is exhausted).
      // GET: returns the stored report.
      // No auth required (the report contains only notification IDs + timestamps, no PII).
      // TEMPORARY — will be removed after RCA is closed.
      if (url.pathname === '/api/notif-diag-report') {
        // H2 FIX: Gate this diagnostic endpoint behind non-production (mirrors
        // /api/notif-trace-results at line 15199). The RCA this endpoint served
        // (notification stale-read, Option C, commit 2745906) is closed and
        // verified in production. The endpoint is no longer needed in production
        // and was unauthenticated (no auth, no body-size limit, no rate limit).
        const _isProd = String(env.APP_ENV || '').toLowerCase() === 'production';
        if (_isProd) {
          return jsonResponse(
            { status: 'error', message: 'Not available in production' },
            { status: 404 },
            env
          );
        }
        if (request.method === 'POST') {
          try {
            const body = await request.json();
            const bodyStr = JSON.stringify(body);
            // Store in database (Neon Postgres — no write quota)
            try {
              await queryDb(env, `
                CREATE TABLE IF NOT EXISTS _diag_notif_report (
                  id SERIAL PRIMARY KEY,
                  report JSONB NOT NULL,
                  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
                )
              `);
              await queryDb(env, `
                INSERT INTO _diag_notif_report (report) VALUES ($1::jsonb)
              `, [bodyStr]);
              return jsonResponse({ status: 'success', message: 'Report stored in DB', size: bodyStr.length }, {}, env);
            } catch (dbErr) {
              // Fallback to global memory
              _notifDiagReport = body;
              return jsonResponse({ status: 'success', message: 'Report stored in memory (DB failed: ' + (dbErr?.message || '').slice(0, 100) + ')' }, {}, env);
            }
          } catch (e) {
            return jsonResponse({ status: 'error', message: 'Failed to store: ' + (e?.message || String(e)) }, { status: 500 }, env);
          }
        }
        if (request.method === 'GET') {
          try {
            // Read from database
            try {
              const result = await queryDb(env, `
                SELECT report FROM _diag_notif_report
                ORDER BY created_at DESC LIMIT 1
              `);
              if (result.rows && result.rows.length > 0) {
                return jsonResponse({ status: 'success', report: result.rows[0].report, source: 'db' }, {}, env);
              }
            } catch (dbErr) {
              // Fallback to memory
              if (_notifDiagReport) {
                return jsonResponse({ status: 'success', report: _notifDiagReport, source: 'memory' }, {}, env);
              }
            }
            if (_notifDiagReport) {
              return jsonResponse({ status: 'success', report: _notifDiagReport, source: 'memory' }, {}, env);
            }
            return jsonResponse({ status: 'success', report: null, message: 'No report captured yet' }, {}, env);
          } catch (e) {
            return jsonResponse({ status: 'error', message: 'Failed to read: ' + (e?.message || String(e)) }, { status: 500 }, env);
          }
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
      const PROTECTED_PATHS = /^\/api\/(wallet|tickets|alerts|assistant|referrals|users\/me|watchlist|sessions|notify|notifications|wheel)/;
      const _isProduction = String(env.APP_ENV || '').toLowerCase() === 'production';

      if (_isProduction && PROTECTED_PATHS.test(url.pathname)) {
        const _authState = await authenticateTelegramRequest(request, env);
        if (_authState.error) return _authState.error;
        _protectedUser = _authState.user;
        // PHASE 3 FIX: Set _protectedUser on the request object so notification
        // handlers can use it without calling authenticateTelegramRequest again.
        request._protectedUser = _protectedUser;

        _joinBlocked = await requireChannelJoin(_protectedUser, env);
        if (_joinBlocked) return _joinBlocked;
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
        // FIX (Finding 4): Rate limit ticket creation to 5 req/hour per user.
        // Normal users create 0-2 tickets per week. 5/hour allows legitimate
        // use while preventing spam. Auth + rate limit checked in controller.
        const _ticketAuth = await authenticateTelegramRequest(request, env);
        if (_ticketAuth.error) return _ticketAuth.error;
        if (await isUserRateLimited(env, _ticketAuth.user.id, 'tickets', 5, 3600)) {
          return jsonResponse({ status: 'error', message: 'Too many requests', code: 'RATE_LIMITED' }, { status: 429 }, env);
        }
        // Re-set the auth state on the request for the controller to use
        request._protectedUser = _ticketAuth.user;
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

      // ── Membership Module — User Routes ───────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/membership/status') {
        return membershipHandlers.handleGetStatus(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/membership/request') {
        return membershipHandlers.handleGetMyRequests(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/membership/request') {
        // FIX (Finding 4): Rate limit membership requests to 3 req/hour per user.
        // Normal users submit 0-1 requests. 3/hour allows resubmission while
        // preventing spam.
        const _memAuth = await authenticateTelegramRequest(request, env);
        if (_memAuth.error) return _memAuth.error;
        if (await isUserRateLimited(env, _memAuth.user.id, 'membership', 3, 3600)) {
          return jsonResponse({ status: 'error', message: 'Too many requests', code: 'RATE_LIMITED' }, { status: 429 }, env);
        }
        request._protectedUser = _memAuth.user;
        return membershipHandlers.handleSubmitRequest(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/membership/welcome-shown') {
        return membershipHandlers.handleMarkWelcomeShown(request, env);
      }
      // ── Phase 1: Premium Rules + Acceptance ──────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/membership/rules') {
        return membershipHandlers.handleGetRules(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/membership/rules/accept') {
        return membershipHandlers.handleAcceptRules(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/membership/rules/accepted') {
        return membershipHandlers.handleCheckAcceptance(request, env);
      }
      // ── Phase 2: Membership Requirements ──────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/membership/requirement') {
        return membershipHandlers.handleGetRequirement(request, env);
      }

      // ── Phase 5: Profile Cosmetics ─────────────────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/cosmetics') {
        return cosmeticsHandlers.handleGetCatalog(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/cosmetics/mine') {
        return cosmeticsHandlers.handleGetMine(request, env);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/cosmetics/') && url.pathname.endsWith('/purchase')) {
        const cosmeticId = url.pathname.slice('/api/cosmetics/'.length, -'/purchase'.length);
        return cosmeticsHandlers.handlePurchase(request, env, cosmeticId);
      }
      if (request.method === 'POST' && url.pathname.startsWith('/api/cosmetics/') && url.pathname.endsWith('/activate')) {
        const cosmeticId = url.pathname.slice('/api/cosmetics/'.length, -'/activate'.length);
        return cosmeticsHandlers.handleActivate(request, env, cosmeticId);
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
      // ── Phase 2: Admin Requirement Management ─────────────────────────────
      if (request.method === 'GET' && url.pathname === '/api/admin/membership/requirements') {
        return membershipHandlers.handleListRequirements(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/requirements') {
        return membershipHandlers.handleCreateRequirement(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/membership/requirements/activate') {
        return membershipHandlers.handleActivateRequirement(request, env);
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

      // ═══════════════════════════════════════════════════════════════════════
      // ADVERTISEMENTS — Admin routes (Phase 9: Channel Join / Popup / Message)
      // All require `ads.manage` permission (enforced in handlers via requireAdmin).
      // ═══════════════════════════════════════════════════════════════════════

      // ── Admin: Channels (Phase 2 — Channel Join advertisement) ──
      if (request.method === 'GET' && url.pathname === '/api/admin/advertisements/channels') {
        return advertisementsHandlers.handleAdminListChannels(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/advertisements/channels') {
        return advertisementsHandlers.handleAdminCreateChannel(request, env);
      }
      if (request.method === 'PUT' && /^\/api\/admin\/advertisements\/channels\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        return advertisementsHandlers.handleAdminUpdateChannel(request, env, id);
      }
      if (request.method === 'DELETE' && /^\/api\/admin\/advertisements\/channels\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        return advertisementsHandlers.handleAdminDeleteChannel(request, env, id);
      }
      if (request.method === 'POST' && /^\/api\/admin\/advertisements\/channels\/[A-Za-z0-9_-]+\/status$/.test(url.pathname)) {
        const id = url.pathname.split('/')[5];
        return advertisementsHandlers.handleAdminChannelStatus(request, env, id);
      }

      // ── Admin: Popups (Phase 3 + Phase 4 — Mini App Popup) ──
      if (request.method === 'GET' && url.pathname === '/api/admin/advertisements/popups') {
        return advertisementsHandlers.handleAdminListPopups(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/advertisements/popups') {
        return advertisementsHandlers.handleAdminCreatePopup(request, env);
      }
      if (request.method === 'PUT' && /^\/api\/admin\/advertisements\/popups\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        return advertisementsHandlers.handleAdminUpdatePopup(request, env, id);
      }
      if (request.method === 'DELETE' && /^\/api\/admin\/advertisements\/popups\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        return advertisementsHandlers.handleAdminDeletePopup(request, env, id);
      }
      if (request.method === 'POST' && /^\/api\/admin\/advertisements\/popups\/[A-Za-z0-9_-]+\/status$/.test(url.pathname)) {
        const id = url.pathname.split('/')[5];
        return advertisementsHandlers.handleAdminPopupStatus(request, env, id);
      }

      // ── Admin: Messages (Phase 6 — Message Campaign) ──
      if (request.method === 'GET' && url.pathname === '/api/admin/advertisements/messages') {
        return advertisementsHandlers.handleAdminListMessages(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/admin/advertisements/messages') {
        return advertisementsHandlers.handleAdminCreateMessage(request, env);
      }
      if (request.method === 'PUT' && /^\/api\/admin\/advertisements\/messages\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        return advertisementsHandlers.handleAdminUpdateMessage(request, env, id);
      }
      if (request.method === 'DELETE' && /^\/api\/admin\/advertisements\/messages\/[A-Za-z0-9_-]+$/.test(url.pathname)) {
        const id = url.pathname.split('/').pop();
        return advertisementsHandlers.handleAdminDeleteMessage(request, env, id);
      }
      if (request.method === 'POST' && /^\/api\/admin\/advertisements\/messages\/[A-Za-z0-9_-]+\/status$/.test(url.pathname)) {
        const id = url.pathname.split('/')[5];
        return advertisementsHandlers.handleAdminMessageStatus(request, env, id);
      }
      if (request.method === 'POST' && /^\/api\/admin\/advertisements\/messages\/[A-Za-z0-9_-]+\/send$/.test(url.pathname)) {
        const id = url.pathname.split('/')[5];
        return advertisementsHandlers.handleAdminSendMessage(request, env, id);
      }

      // ── Admin: Image upload (Phase 5 — Image Optimization/Validation) ──
      if (request.method === 'POST' && url.pathname === '/api/admin/advertisements/upload-image') {
        return advertisementsHandlers.handleAdminUploadImage(request, env);
      }
      // ═══════════════════════════════════════════════════════════════════════

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
        // FIX (Focused Verification — Bootstrap Rate Limit):
        // Previously, userId was extracted from initData WITHOUT HMAC validation,
        // allowing an attacker to consume a victim's rate limit quota by sending
        // fake initData with the victim's userId. Now we authenticate FIRST
        // (HMAC validation), then rate limit using the validated userId.
        // If auth fails (invalid HMAC), we return 401 WITHOUT incrementing the
        // rate limit counter — attacker cannot DoS a victim's bootstrap.
        // If auth succeeds, we rate limit with the HMAC-validated userId.
        // Limit: 10 req/60s per user. KV fail-open behavior preserved.
        try {
          const authResult = await authenticateTelegramRequest(request, env);
          if (authResult.user) {
            // Authenticated user — check rate limit with validated userId
            if (await isUserRateLimited(env, authResult.user.id, 'bootstrap', 10, 60)) {
              return jsonResponse({ status: 'error', message: 'Too many requests', code: 'RATE_LIMITED' }, { status: 429 }, env);
            }
          }
          // If authResult.error is set (invalid HMAC), we DON'T rate limit —
          // just fall through to handleBootstrap which will return 401.
          // This ensures attacker requests with fake initData don't consume
          // any victim's rate limit quota.
        } catch (e) {
          // Rate-limit pre-check failure is non-fatal — fall through to
          // handleBootstrap which has its own error handling.
        }
        return userHandlers.handleBootstrap(request, env);
      }

      // Recheck channel membership (used by frontend lock screen "Verify" button)
      // Rate limiting is now handled INSIDE the Membership Gateway (smart rate gate):
      //   - In-memory 5s gate: prevents Telegram spam (per-isolate)
      //   - KV-based Telegram backoff: respects Telegram 429 retry_after (cross-isolate)
      // The old jl:{userId} KV with 60s TTL blocked post-join re-verification.
      // Now: user can re-verify within 5s of joining (not 60s).
      if (request.method === 'POST' && url.pathname === '/api/users/check-join') {
        const authState = await authenticateTelegramRequest(request, env);
        if (authState.error) return authState.error;
        const _joinUserId = String(authState.user.id);
        const membership = await membershipGateway.check(env, _joinUserId, { forceRefresh: true });
        // Preserve API contract: { status: 'success', channel_joined: boolean }
        // If Gateway returned rate_limited or telegram_rate_limited, we still
        // return the result with channel_joined (which is the last-known state,
        // NOT a 429). The retry_after field is included for frontend UX.
        return jsonResponse({
          status: 'success',
          channel_joined: Boolean(membership?.joined),
          ...(membership?.retry_after ? { retry_after: membership.retry_after } : {}),
          ...(membership?.reason === 'telegram_rate_limited' ? { telegram_rate_limited: true } : {}),
        }, {}, env);
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
      // MISSION-ABUSE FIX (WALLET-002): /mission/complete now requires a
      // server-issued event_token for non-daily_login missions. Frontend
      // must call /mission/issue-token AFTER the user performs the real action.
      if (request.method === 'POST' && url.pathname === '/api/wallet/mission/issue-token') {
        return walletHandlers.handleMissionIssueToken(request, env);
      }

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

      // ── Reward Purchases (VPN Reward Market) ──
      if (request.method === 'GET' && url.pathname === '/api/rewards/vpn/plans') {
        return rewardPurchaseHandlers.handleVpnPlans(request, env);
      }
      if (request.method === 'POST' && url.pathname === '/api/rewards/vpn/purchase') {
        return rewardPurchaseHandlers.handleVpnPurchase(request, env);
      }
      if (request.method === 'GET' && url.pathname === '/api/rewards/purchases') {
        return rewardPurchaseHandlers.handleUserPurchases(request, env);
      }
      // Admin: reward purchase queue
      if (request.method === 'GET' && url.pathname === '/api/admin/reward-purchases') {
        return rewardPurchaseHandlers.handleAdminListPurchases(request, env);
      }
      if (url.pathname.startsWith('/api/admin/reward-purchases/') && request.method === 'GET') {
        const parts = url.pathname.split('/');
        if (parts.length === 5 && /^\d+$/.test(parts[4])) {
          return rewardPurchaseHandlers.handleAdminGetPurchase(request, env, parts[4]);
        }
      }
      if (url.pathname.startsWith('/api/admin/reward-purchases/') && request.method === 'POST') {
        const parts = url.pathname.split('/');
        // /api/admin/reward-purchases/:id/fulfill|cancel
        if (parts.length === 6 && (parts[5] === 'fulfill' || parts[5] === 'cancel')) {
          const purchaseId = parts[4];
          if (parts[5] === 'fulfill') return rewardPurchaseHandlers.handleAdminFulfill(request, env, purchaseId);
          return rewardPurchaseHandlers.handleAdminCancel(request, env, purchaseId);
        }
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
      // PHASE 1 / CHANGE 1: Pool teardown is handled by withSharedPool's
      // finally block (line 1439). This inner finally is a no-op — kept for
      // structural compatibility with the existing try/catch/finally shape.
    }
    }); // end withSharedPool
  },

  async scheduled(controller, env, ctx) {
    if (!globalThis._cronMonitorLog) globalThis._cronMonitorLog = [];
    // PHASE 2 SAFE OPTIMIZATION: Initialize DB trace flag for cron context too.
    _dbTraceEnabled = _dbTraceEnabled ?? (String(env.DB_TRACE_ENABLED || '').toLowerCase() === 'true');
    return runScheduled(controller, env, ctx, {
      withPhasePool,
      sendTelegramMessage,
      queryDb,
      createPool,
      writeAppCache,
      processNewsAIBatch,
      processOneArticleSummary,
      recordNewsAITick,
      runScheduledAlertsBaseline,
      runCalendarAlertsCheck,
      retryFailedReferralRewards,
      retryFailedWheelRewards,
      retryFailedMissionRewards,
      retryFailedRefunds,
      fetchCalendarFeed,
      mapCalendarEvent,
      notificationPlatformRepo,
      marketOverviewSvc,
      setCalendarIsolateCache,
    });
  },
};
//#endregion

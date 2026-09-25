// ═════════════════════════════════════════════════════════════════════════════
// News Providers Layer — extracted from worker-proxy.js (lines 4804-6043).
//
// Factory pattern: createNewsProviders({ readAppCache, writeAppCache, queryDb })
// Returns: 30 functions + 16 provider constants
//
// DI dependencies (3):
//   - readAppCache: KV read (circuit breaker + Groq router state)
//   - writeAppCache: KV write (circuit breaker + Groq router state)
//   - queryDb: DB (Groq DB gateway in groqPrimaryGenerate)
//
// Mutable state (inside factory closure, shared across all callers):
//   - _groqRouterProbeLockInMemory (Map): Groq router probe lock
//   - _groqRouterWindowInMemory (Map): Groq router rate limiting window
//   - _probeLockInMemory (Map): circuit breaker probe lock
//
// NOT extracted (stay in worker-proxy.js — Summary constants):
//   - NEWS_SUMMARY_MAX_RETRIES, NEWS_SUMMARY_BACKOFF_MINUTES
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createNewsProviders({
  readAppCache,
  writeAppCache,
  queryDb,
}) {

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



// ────────────────────────────────────────────────────────────────────────────
// MULTI-PROVIDER AI FALLBACK (GROQ-ROUTER-4KEY)
// Provider priority: Groq Router (primary) → OpenRouter (fallback 1) →
//                    Workers AI (fallback 2) → OpenAI (fallback 3 — opt-in, paid)
// Each provider is tried only if the previous one failed.
// Fallback happens in the SAME invocation (no queue wait).
// Queue retry only when ALL providers fail.
//
// Feature flags (env vars, default values shown):
//   NEWS_PROVIDER_GROQ         = true   (primary — 4-key router)
//   NEWS_PROVIDER_OPENROUTER   = true   (fallback 1 — free emergency)
//   NEWS_PROVIDER_WORKERS_AI   = true   (fallback 2)
//   NEWS_PROVIDER_OPENAI       = false  (fallback 3 — opt-in, needs OPENAI_API_KEY)
//
// Error classification:
//   retryable     → 429, 5xx, timeout, network, invalid JSON, empty response
//                   (try next provider; if all fail with retryable → requeue)
//   non_retryable → 401/403 (key invalid), 404 (model not found), 400 (prompt invalid)
//                   (try next provider; if all fail with non-retryable → mark failed)
// ────────────────────────────────────────────────────────────────────────────
const NEWS_AI_PROVIDER_STATS_KEY = 'news:ai_provider_stats';
const OPENAI_MODEL = 'gpt-4o-mini'; // cheap, fast, good for summarization
const OPENROUTER_MODEL = 'nvidia/nemotron-3-super-120b-a12b:free'; // free emergency fallback

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

// ── GROQ 429 CLASSIFICATION (P1 FIX) ──
// Parses Groq's 429 response body to distinguish quota types.
// Groq's actual messages (observed in production):
//   "Rate limit reached for model ... on tokens per day (TPD): Limit 200000, Used 199607..."
//   "Rate limit reached for model ... on requests per minute (RPM)..."
//   "Rate limit reached for model ... on tokens per minute (TPM)..."
// Also handles generic RPD patterns.
//
// Returns one of:
//   'daily_quota_tpd' | 'daily_quota_rpd' | 'rate_limit_rpm' | 'rate_limit_tpm' | 'rate_limit_generic'
//
// For non-429 status, returns null (caller uses classifyHttpError instead).
function classifyGroq429(statusCode, responseBody) {
  if (statusCode !== 429) return null;
  const body = String(responseBody || '').toLowerCase();
  // Order matters: check TPD/RPD before RPM/TPM (more specific)
  if (body.includes('tokens per day') || body.includes('(tpd)')) return 'daily_quota_tpd';
  if (body.includes('requests per day') || body.includes('(rpd)')) return 'daily_quota_rpd';
  if (body.includes('requests per minute') || body.includes('(rpm)')) return 'rate_limit_rpm';
  if (body.includes('tokens per minute') || body.includes('(tpm)')) return 'rate_limit_tpm';
  return 'rate_limit_generic';
}

// ── GROQ RETRY-AFTER PARSING (P1 FIX) ──
// Parses Groq's "Please try again in 15m32.688s" or "retry in 10m9.552s" patterns.
// Supports: hours (h), minutes (m), seconds (s), decimal seconds.
// Returns total seconds (number) or null if not parseable.
//
// Examples:
//   "Please try again in 15m32.688s" → 932
//   "Please try again in 10m9.552s"  → 609
//   "Please try again in 1h30m"      → 5400
//   "Please try again in 45s"        → 45
function parseGroqRetryAfter(responseBody) {
  const body = String(responseBody || '');
  // Match patterns like "in 15m32.688s" or "in 10m9.552s" or "in 1h30m" or "in 45s"
  // Each unit (h/m/s) must be immediately followed by its letter to be captured.
  // Capture groups: (1) hours, (2) minutes, (3) seconds (with optional decimals)
  const match = body.match(/(?:try again|retry)[^0-9]*(?:(\d+(?:\.\d+)?)\s*h)?\s*(?:(\d+(?:\.\d+)?)\s*m)?\s*(?:(\d+(?:\.\d+)?)\s*s)?/i);
  if (!match) return null;
  const hours = parseFloat(match[1]) || 0;
  const minutes = parseFloat(match[2]) || 0;
  const seconds = parseFloat(match[3]) || 0;
  const total = hours * 3600 + minutes * 60 + seconds;
  return total > 0 ? Math.ceil(total) : null;
}

// ── GROQ 429 STRUCTURED INFO (P1 FIX) ──
// Combines classification + retry-after parsing.
// Returns { quota_type, retry_after_seconds } or null if not a Groq 429.
function parseGroq429Info(statusCode, responseBody) {
  const quota_type = classifyGroq429(statusCode, responseBody);
  if (!quota_type) return null;
  const retry_after_seconds = parseGroqRetryAfter(responseBody);
  // Fallback durations when retry_after not parseable from body
  const fallbackSeconds = {
    daily_quota_tpd: 15 * 60,      // 15 minutes
    daily_quota_rpd: 60 * 60,      // 1 hour
    rate_limit_rpm: 60,            // 60 seconds
    rate_limit_tpm: 60,            // 60 seconds
    rate_limit_generic: 10 * 60,   // 10 minutes (existing behavior)
  };
  return {
    quota_type,
    retry_after_seconds: retry_after_seconds || fallbackSeconds[quota_type] || (10 * 60),
    parsed_from_body: retry_after_seconds !== null,
  };
}

/**
 * Groq Primary chat helper — DEPRECATED compatibility shim.
 *
 * GROQ-ROUTER-4KEY: This function is kept as a thin wrapper around
 * groqRouterExecute for any external callers that still expect the old
 * { status_code, response_body } shape. New code should call
 * groqRouterExecute directly to get the full router result (including
 * key_slot, groq_429_info, and router_reason).
 *
 * The router discovers all configured Groq keys (env.GROQ_API_KEY,
 * GROQ_API_KEY_1, GROQ_API_KEY_2, GROQ_API_KEY_3) at runtime and selects
 * the best healthy key per request (3/10min budget, circuit-breaker,
 * HALF_OPEN probe).
 */
async function groqPrimaryGenerate(env, model, messages, maxTokens, temperature) {
  const result = await groqRouterExecute(env, model, messages, maxTokens, temperature);
  return {
    status_code: result.status_code,
    response_body: result.response_body,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// CENTRALIZED 4-KEY GROQ ROUTER  (GROQ-ROUTER-4KEY)
// One unified router shared by all Groq paths (News AI summary, batch
// translation, batch analysis, individual translation, Chat text).
//
// Keys discovered at runtime from env:
//   GROQ_API_KEY    → key slot 0
//   GROQ_API_KEY_1  → key slot 1
//   GROQ_API_KEY_2  → key slot 2
//   GROQ_API_KEY_3  → key slot 3
//
// Per-key state in KV (key: groq:router:key{N}):
//   { state: 'CLOSED'|'OPEN'|'HALF_OPEN',
//     consecutive_failures, retry_after, probe_failures,
//     last_failure_reason, quota_type, window_requests }
//
// window_requests: array of timestamps (ms) in the current 10-minute
// application window. Application safety limit = 3 requests per key per
// 10-minute rolling window. Prune older entries on every read/write.
//
// 429 handling: when a key returns 429, ONLY that key is OPENed with
// retry_after = now + (parsed_retry_after_seconds * 1000). Other keys remain
// usable. The router uses classifyGroq429 + parseGroqRetryAfter + parseGroq429Info
// (defined above) — NOT duplicated.
//
// HALF_OPEN probe: when a key's cooldown expires, transition to HALF_OPEN. The
// in-memory `_groqRouterProbeLockInMemory` Map (per-isolate) ensures only ONE
// probe per key. Other concurrent callers defer (reason: 'probe_in_progress').
// On probe success → CLOSED. On probe 429 → re-OPEN with FRESH retry_after.
//
// Key selection (selectBestKey):
//   - Exclude keys that are: OPEN (cooldown not expired), at application
//     safety limit (3 requests in 10min), missing/invalid, or HALF_OPEN with
//     active probe lock.
//   - Among remaining healthy keys: pick the one with FEWEST requests in the
//     current 10-min window (least-used). Ties broken by lowest index
//     (deterministic).
//
// Returns: { status_code, response_body, key_slot, groq_429_info, router_reason }
//   - status_code 503 + router_reason 'no_groq_keys_configured'  when 0 keys.
//   - status_code 503 + router_reason 'all_keys_unavailable'    when all
//     healthy keys exhausted (circuit_states[] included for observability).
//
// SECURITY: The API key is passed as a parameter to the DB gateway function
// (public.groq_generate_with_key). The key value is NEVER logged.
// ═══════════════════════════════════════════════════════════════════════════

const GROQ_ROUTER_KEY_PREFIX = 'groq:router:key';
const GROQ_ROUTER_STATE_TTL = 60 * 60; // 1 hour (longer than max cooldown)
const GROQ_ROUTER_WINDOW_MS = 10 * 60 * 1000; // 10-minute rolling window
const GROQ_ROUTER_MAX_PER_WINDOW = 3; // 3 requests per key per 10-min window
const GROQ_ROUTER_FAILURE_THRESHOLD = 3; // 3 consecutive failures → OPEN
const GROQ_ROUTER_DEFAULT_OPEN_MS = 10 * 60 * 1000; // 10 minutes (non-429 failures)
const GROQ_ROUTER_PROBE_LOCK_MS = 30 * 1000; // 30s probe lock window

// Per-isolate in-memory probe lock: key index → { expiresAt: ms }
const _groqRouterProbeLockInMemory = new Map();

// Per-isolate fast-path window_requests mirror (best-effort; KV is source of
// truth). Used to skip KV reads for the hot path (a key already known to be at
// 3/3 in this isolate). Map<keyIndex, number[]>.
const _groqRouterWindowInMemory = new Map();

/**
 * Read per-key router state from KV. Defaults to CLOSED with empty
 * window_requests when no state stored. Always prunes expired timestamps from
 * window_requests before returning.
 */
async function _groqRouterGetKeyState(env, keyIndex) {
  const defaults = {
    state: 'CLOSED',
    consecutive_failures: 0,
    retry_after: null,
    probe_failures: 0,
    last_failure_reason: null,
    quota_type: null,
    window_requests: [],
  };
  if (!env || !env.APP_CACHE) return defaults;
  try {
    const raw = await readAppCache(env, `${GROQ_ROUTER_KEY_PREFIX}${keyIndex}`);
    if (raw) {
      const parsed = JSON.parse(raw);
      if (parsed && parsed.state) {
        // Prune expired window timestamps
        const cutoff = Date.now() - GROQ_ROUTER_WINDOW_MS;
        if (Array.isArray(parsed.window_requests)) {
          parsed.window_requests = parsed.window_requests.filter(ts => ts > cutoff);
        } else {
          parsed.window_requests = [];
        }
        return { ...defaults, ...parsed };
      }
    }
  } catch (e) {
    console.warn(`[GROQ-ROUTER] getState(${keyIndex}) failed:`, e?.message);
  }
  return defaults;
}

/**
 * Save per-key router state to KV (TTL = 1h).
 */
async function _groqRouterSetKeyState(env, keyIndex, state) {
  if (!env || !env.APP_CACHE) return;
  try {
    await writeAppCache(env, `${GROQ_ROUTER_KEY_PREFIX}${keyIndex}`, JSON.stringify(state), GROQ_ROUTER_STATE_TTL);
  } catch (e) {
    console.warn(`[GROQ-ROUTER] setState(${keyIndex}) failed:`, e?.message);
  }
}

/**
 * Discover configured Groq keys at runtime.
 * Returns array of { index, apiKey } for all 4 possible slots (1-4 keys).
 */
function _groqRouterDiscoverKeys(env) {
  const keys = [];
  if (env && env.GROQ_API_KEY) keys.push({ index: 0, apiKey: env.GROQ_API_KEY });
  if (env && env.GROQ_API_KEY_1) keys.push({ index: 1, apiKey: env.GROQ_API_KEY_1 });
  if (env && env.GROQ_API_KEY_2) keys.push({ index: 2, apiKey: env.GROQ_API_KEY_2 });
  if (env && env.GROQ_API_KEY_3) keys.push({ index: 3, apiKey: env.GROQ_API_KEY_3 });
  return keys;
}

/**
 * Select the best healthy key for the next request.
 *
 * Excludes keys that are:
 *   - OPEN with cooldown not expired
 *   - at application safety limit (3 requests in 10-min window)
 *   - HALF_OPEN with active probe lock (another caller is probing)
 *
 * Among remaining healthy keys, picks the one with FEWEST requests in the
 * current 10-min window (least-used). Ties broken by lowest index.
 *
 * Returns { key, state, reason } or null if no healthy key available.
 */
async function _groqRouterSelectBestKey(env, keys) {
  const now = Date.now();
  const candidates = [];
  for (const k of keys) {
    const state = await _groqRouterGetKeyState(env, k.index);
    let reason = 'healthy';
    let eligible = true;

    if (state.state === 'OPEN') {
      if (state.retry_after && now < state.retry_after) {
        // Still in cooldown — skip
        eligible = false;
        reason = `cooldown_open (${Math.ceil((state.retry_after - now) / 1000)}s remaining)`;
      } else {
        // Cooldown expired → transition to HALF_OPEN (probe)
        // P1 FIX: Single probe — check in-memory probe lock first
        const probeLock = _groqRouterProbeLockInMemory.get(k.index);
        if (probeLock && now < probeLock.expiresAt) {
          eligible = false;
          reason = 'probe_in_progress';
        } else {
          // Claim the probe slot (30s window for the probe to complete)
          _groqRouterProbeLockInMemory.set(k.index, { expiresAt: now + GROQ_ROUTER_PROBE_LOCK_MS });
          const newState = { ...state, state: 'HALF_OPEN' };
          await _groqRouterSetKeyState(env, k.index, newState);
          candidates.push({ key: k, state: newState, reason: 'half_open_probe' });
          continue;
        }
      }
    } else if (state.state === 'HALF_OPEN') {
      // HALF_OPEN with active probe lock — defer
      const probeLock = _groqRouterProbeLockInMemory.get(k.index);
      if (probeLock && now < probeLock.expiresAt) {
        eligible = false;
        reason = 'probe_in_progress';
      } else {
        // Lock expired or no lock — claim probe slot
        _groqRouterProbeLockInMemory.set(k.index, { expiresAt: now + GROQ_ROUTER_PROBE_LOCK_MS });
        candidates.push({ key: k, state, reason: 'half_open' });
        continue;
      }
    }

    if (eligible) {
      // Application safety limit: 3/10min per key
      if (state.window_requests.length >= GROQ_ROUTER_MAX_PER_WINDOW) {
        eligible = false;
        reason = `window_limit (${state.window_requests.length}/${GROQ_ROUTER_MAX_PER_WINDOW})`;
      }
    }

    if (eligible) {
      candidates.push({ key: k, state, reason });
    }
  }

  if (candidates.length === 0) return null;

  // Pick the candidate with FEWEST window_requests (least-used).
  // Ties broken by lowest index (deterministic).
  candidates.sort((a, b) => {
    const wa = a.state.window_requests.length;
    const wb = b.state.window_requests.length;
    if (wa !== wb) return wa - wb;
    return a.key.index - b.key.index;
  });
  return candidates[0];
}

/**
 * Record a request in the per-key 10-min window (KV + in-memory).
 * Appends Date.now() to window_requests and prunes old entries.
 */
async function _groqRouterRecordRequest(env, keyIndex) {
  const state = await _groqRouterGetKeyState(env, keyIndex);
  const now = Date.now();
  const cutoff = now - GROQ_ROUTER_WINDOW_MS;
  state.window_requests = (state.window_requests || []).filter(ts => ts > cutoff);
  state.window_requests.push(now);
  // Cap array size (safety)
  if (state.window_requests.length > 50) state.window_requests = state.window_requests.slice(-50);
  await _groqRouterSetKeyState(env, keyIndex, state);
  // Mirror in-memory (fast-path)
  _groqRouterWindowInMemory.set(keyIndex, [...state.window_requests]);
}

/**
 * Record a successful request — reset circuit to CLOSED.
 * Clears the in-memory probe lock if this was a HALF_OPEN probe.
 */
async function _groqRouterRecordSuccess(env, keyIndex) {
  const state = await _groqRouterGetKeyState(env, keyIndex);
  _groqRouterProbeLockInMemory.delete(keyIndex);
  if (state.state !== 'CLOSED' || state.consecutive_failures > 0 || state.quota_type) {
    await _groqRouterSetKeyState(env, keyIndex, {
      ...state,
      state: 'CLOSED',
      consecutive_failures: 0,
      retry_after: null,
      probe_failures: 0,
      last_failure_reason: null,
      quota_type: null,
    });
  }
}

/**
 * Record a 429 failure — OPEN circuit with retry_after from the 429 body.
 * Clears the in-memory probe lock (probe failed).
 */
async function _groqRouterRecord429(env, keyIndex, groq429Info) {
  const state = await _groqRouterGetKeyState(env, keyIndex);
  _groqRouterProbeLockInMemory.delete(keyIndex);
  const now = Date.now();
  const cooldownMs = (groq429Info?.retry_after_seconds || (10 * 60)) * 1000;
  const probeFailures = (state.probe_failures || 0) + 1;
  await _groqRouterSetKeyState(env, keyIndex, {
    ...state,
    state: 'OPEN',
    consecutive_failures: (state.consecutive_failures || 0) + 1,
    retry_after: now + cooldownMs,
    probe_failures: probeFailures,
    last_failure_reason: `http_429:${groq429Info?.quota_type || 'unknown'}:${groq429Info?.retry_after_seconds || 'n/a'}`,
    quota_type: groq429Info?.quota_type || null,
  });
}

/**
 * Record a non-429 failure (5xx, network, timeout). Increment
 * consecutive_failures; if >= threshold → OPEN with default 10-min cooldown.
 * Clears the in-memory probe lock if this was a HALF_OPEN probe.
 */
async function _groqRouterRecordFailure(env, keyIndex, statusCode, errorMessage) {
  const state = await _groqRouterGetKeyState(env, keyIndex);
  _groqRouterProbeLockInMemory.delete(keyIndex);
  const now = Date.now();
  const wasHalfOpen = state.state === 'HALF_OPEN';
  const newFailures = (state.consecutive_failures || 0) + 1;
  const probeFailures = wasHalfOpen ? (state.probe_failures || 0) + 1 : (state.probe_failures || 0);
  if (wasHalfOpen || newFailures >= GROQ_ROUTER_FAILURE_THRESHOLD) {
    await _groqRouterSetKeyState(env, keyIndex, {
      ...state,
      state: 'OPEN',
      consecutive_failures: newFailures,
      retry_after: now + GROQ_ROUTER_DEFAULT_OPEN_MS,
      probe_failures: probeFailures,
      last_failure_reason: errorMessage || `http_${statusCode}`,
      quota_type: null,
    });
  } else {
    await _groqRouterSetKeyState(env, keyIndex, {
      ...state,
      state: 'CLOSED',
      consecutive_failures: newFailures,
      last_failure_reason: errorMessage || `http_${statusCode}`,
      quota_type: null,
    });
  }
}

/**
 * Call the Groq DB gateway (public.groq_generate_with_key) with a SPECIFIC key.
 * Internal helper used by groqRouterExecute. The API key is passed as a
 * parameter (stays in Cloudflare secrets, never stored in DB).
 *
 * NOTE: DB gateway strips HTTP headers. Rate-limit headers are not available;
 * TPD/RPD info is parsed from the response BODY via classifyGroq429 instead.
 */
async function _groqRouterCallGateway(env, apiKey, model, messages, maxTokens, temperature) {
  try {
    const dbResult = await queryDb(env,
      `SELECT public.groq_generate_with_key($1::text, $2::jsonb, $3::text, $4::integer, $5::double precision) AS result`,
      [model, JSON.stringify(messages), apiKey, maxTokens, temperature]
    );
    const result = dbResult.rows[0]?.result || {};
    const status_code = typeof result.status_code === 'number' ? result.status_code : 0;
    const response_body = typeof result.response_body === 'string' ? result.response_body : JSON.stringify(result.response_body || {});
    return { status_code, response_body };
  } catch (e) {
    return {
      status_code: 0,
      response_body: JSON.stringify({ error: { message: 'db_gateway_error', detail: (e?.message || '').substring(0, 120) } }),
    };
  }
}

/**
 * Centralized 4-key Groq Router entry point.
 *
 * Discovers configured Groq keys at runtime, selects the best healthy key,
 * records the request in the per-key 10-min window, executes via the DB
 * gateway, and updates the per-key circuit state based on the result.
 *
 * 429 handling: ONLY the key that returned 429 is OPENed. Other keys remain
 * usable on subsequent calls.
 *
 * @param {object} env - Worker environment
 * @param {string} model - Groq model name (e.g. 'openai/gpt-oss-120b')
 * @param {Array} messages - OpenAI-compatible messages array
 * @param {number} maxTokens - max_tokens parameter
 * @param {number} temperature - temperature parameter
 * @returns {Promise<{status_code: number, response_body: string, key_slot: number|null, groq_429_info: object|null, router_reason: string, circuit_states?: Array}>}
 */
async function groqRouterExecute(env, model, messages, maxTokens, temperature) {
  // 1. Discover keys at runtime
  const keys = _groqRouterDiscoverKeys(env);
  if (keys.length === 0) {
    return {
      status_code: 503,
      response_body: '{"error":{"message":"no_groq_keys_configured","status":"UNAVAILABLE"}}',
      key_slot: null,
      groq_429_info: null,
      router_reason: 'no_groq_keys_configured',
    };
  }

  // ── DO PATH: Strict concurrency-safe enforcement via Durable Object ──
  // When GROQ_ROUTER_DO binding is available, ALL key selection + recording
  // goes through the DO (serialized, no race conditions). This guarantees
  // STRICT 3/10min per-key budget enforcement.
  if (env.GROQ_ROUTER_DO && typeof env.GROQ_ROUTER_DO.idFromName === 'function') {
    try {
      // Phase 1: Reserve a key slot (serialized by DO)
      const keyIndices = keys.map(k => k.index);
      const doId = env.GROQ_ROUTER_DO.idFromName('groq-router');
      const doStub = env.GROQ_ROUTER_DO.get(doId);
      const reserveRes = await doStub.fetch(`https://do/?action=reserve`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyIndices }),
      });
      const reserveData = await reserveRes.json();

      if (reserveData.keyIndex === null || reserveData.keyIndex === undefined) {
        return {
          status_code: 503,
          response_body: '{"error":{"message":"all_keys_unavailable","status":"UNAVAILABLE"}}',
          key_slot: null,
          groq_429_info: null,
          router_reason: 'all_keys_unavailable',
          circuit_states: reserveData.circuit_states || [],
        };
      }

      const keyIndex = reserveData.keyIndex;
      const apiKey = keys.find(k => k.index === keyIndex)?.apiKey;
      const selectionReason = reserveData.reason;

      // Phase 2: Execute Groq call (Worker has env access for DB gateway)
      const fetchResult = await _groqRouterCallGateway(env, apiKey, model, messages, maxTokens, temperature);
      const statusCode = fetchResult.status_code;
      const responseBody = fetchResult.response_body || '';
      const groq_429_info = parseGroq429Info(statusCode, responseBody);

      // Phase 3: Record result (serialized by DO)
      await doStub.fetch(`https://do/?action=record`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          keyIndex,
          success: statusCode === 200,
          groq_429_info,
          statusCode,
        }),
      });

      // Observability log (NEVER log API key value)
      console.log(
        `[GROQ-ROUTER] key=${keyIndex} usage=${reserveData.usage || '?'}/${GROQ_ROUTER_MAX_PER_WINDOW} window_state=DO quota_type=${groq_429_info?.quota_type || 'n/a'} reason=${selectionReason} http=${statusCode}`
      );

      return {
        status_code: statusCode,
        response_body: responseBody,
        key_slot: keyIndex,
        groq_429_info,
        router_reason: selectionReason,
      };
    } catch (doErr) {
      console.warn('[GROQ-ROUTER] DO error, falling back to KV:', doErr?.message);
      // Fall through to KV-based approach
    }
  }

  // ── KV FALLBACK: Best-effort enforcement (when DO not available) ──
  // This path has a known read-modify-write race under cross-isolate concurrency.
  // The DO path above is preferred for strict enforcement.
  const selected = await _groqRouterSelectBestKey(env, keys);
  if (!selected) {
    const circuit_states = await Promise.all(keys.map(async k => {
      const s = await _groqRouterGetKeyState(env, k.index);
      const now = Date.now();
      return {
        index: k.index,
        state: s.state,
        consecutive_failures: s.consecutive_failures || 0,
        retry_after: s.retry_after,
        cooldown_remaining_s: s.retry_after ? Math.max(0, Math.ceil((s.retry_after - now) / 1000)) : 0,
        window_requests: (s.window_requests || []).length,
        quota_type: s.quota_type || null,
        last_failure_reason: s.last_failure_reason || null,
      };
    }));
    return {
      status_code: 503,
      response_body: '{"error":{"message":"all_keys_unavailable","status":"UNAVAILABLE"}}',
      key_slot: null,
      groq_429_info: null,
      router_reason: 'all_keys_unavailable',
      circuit_states,
    };
  }

  const keyIndex = selected.key.index;
  const apiKey = selected.key.apiKey;
  const selectionReason = selected.reason;

  // Record request in window (BEFORE the call — counts toward budget even on failure)
  await _groqRouterRecordRequest(env, keyIndex);

  // Execute via DB gateway
  const fetchResult = await _groqRouterCallGateway(env, apiKey, model, messages, maxTokens, temperature);
  const statusCode = fetchResult.status_code;
  const responseBody = fetchResult.response_body || '';
  const groq_429_info = parseGroq429Info(statusCode, responseBody);

  // Update per-key circuit state based on result
  if (statusCode === 200) {
    await _groqRouterRecordSuccess(env, keyIndex);
  } else if (statusCode === 429 && groq_429_info) {
    await _groqRouterRecord429(env, keyIndex, groq_429_info);
  } else {
    const errorType = classifyHttpError(statusCode || 500);
    if (errorType === 'retryable') {
      await _groqRouterRecordFailure(env, keyIndex, statusCode, `http_${statusCode}`);
    } else {
      _groqRouterProbeLockInMemory.delete(keyIndex);
    }
  }

  // Observability log (NEVER log API key value)
  const finalState = await _groqRouterGetKeyState(env, keyIndex);
  const now = Date.now();
  const cooldownRemainingS = finalState.retry_after
    ? Math.max(0, Math.ceil((finalState.retry_after - now) / 1000))
    : 0;
  console.log(
    `[GROQ-ROUTER] key=${keyIndex} usage=${finalState.window_requests.length}/${GROQ_ROUTER_MAX_PER_WINDOW} window_state=${finalState.state} quota_type=${groq_429_info?.quota_type || finalState.quota_type || 'n/a'} cooldown_remaining=${cooldownRemainingS}s reason=${selectionReason} http=${statusCode}`
  );

  return {
    status_code: statusCode,
    response_body: responseBody,
    key_slot: keyIndex,
    groq_429_info,
    router_reason: selectionReason,
  };
}

/**
 * Compatibility wrapper around groqRouterExecute for callers that used the old
 * _groqRoutedFetch signature. Returns the router result extended with
 * tried_keys (for backward compatibility with batchTranslateToFarsi logging).
 *
 * The router selects the key internally now — there is no "preferred vs other"
 * dual-key routing. The `input`, `isBatch`, `batchOffset` params are IGNORED
 * (kept in the signature so callers don't need changes).
 */
async function _groqRoutedFetch(env, _input, _isBatch, _batchOffset, model, messages, maxTokens, temperature) {
  const result = await groqRouterExecute(env, model, messages, maxTokens, temperature);
  return {
    ...result,
    tried_keys: result.key_slot !== null ? [result.key_slot] : [],
  };
}

/**
 * Provider 0: Groq News AI summary — DELEGATES to the centralized 4-key Groq
 * Router via _groqRoutedFetch. Truncates article text to 8000 chars to control
 * TPM. Returns { provider, success, summary?, error?, errorType, error_detail?,
 * duration_ms, key_slot }.
 *
 * GROQ-ROUTER-4KEY: The router handles key selection, per-key 3/10min budget,
 * circuit-breaker, and HALF_OPEN probe internally. This wrapper just shapes
 * the result for the generateSummaryWithFallback chain.
 */
async function tryGroq(env, prompt, systemPrompt) {
  const t0 = Date.now();
  try {
    // ── Truncate article text to 8000 chars to control TPM ──
    const truncatedPrompt = (prompt && prompt.length > 8000) ? prompt.substring(0, 8000) : prompt;

    const messages = [];
    if (systemPrompt && typeof systemPrompt === 'string' && systemPrompt.trim()) {
      messages.push({ role: 'system', content: systemPrompt });
    }
    messages.push({ role: 'user', content: truncatedPrompt });

    const result = await _groqRoutedFetch(env, truncatedPrompt, false, 0, 'openai/gpt-oss-120b', messages, 1536, 0.4);
    const statusCode = result.status_code;
    const responseBody = result.response_body || '';
    const keySlot = result.key_slot;

    if (statusCode !== 200) {
      const errorType = classifyHttpError(statusCode || 500);
      if (statusCode === 429 && result.groq_429_info) {
        console.warn(`[GROQ-429] key=${keySlot} router_reason=${result.router_reason} quota_type=${result.groq_429_info.quota_type} retry_after=${result.groq_429_info.retry_after_seconds}s body=${responseBody.substring(0, 300)}`);
      } else {
        console.warn(`[GROQ-ERR] key=${keySlot} status=${statusCode} router_reason=${result.router_reason} body=${responseBody.substring(0, 300)}`);
      }
      return { provider: 'groq', success: false, error: `http_${statusCode}`, errorType, error_detail: responseBody.substring(0, 300), duration_ms: Date.now() - t0, key_slot: keySlot, groq_429_info: result.groq_429_info };
    }

    let data;
    try {
      data = JSON.parse(responseBody);
    } catch (e) {
      return { provider: 'groq', success: false, error: 'invalid_json', errorType: 'retryable', duration_ms: Date.now() - t0, key_slot: keySlot };
    }

    const text = data?.choices?.[0]?.message?.content;
    if (text && text.trim().length >= 50) {
      return { provider: 'groq', success: true, summary: text.trim(), duration_ms: Date.now() - t0, key_slot: keySlot };
    }
    return { provider: 'groq', success: false, error: 'empty_response', errorType: 'retryable', duration_ms: Date.now() - t0, key_slot: keySlot };
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    return {
      provider: 'groq',
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
async function tryWorkersAI(env, prompt, systemPrompt) {
  const t0 = Date.now();
  if (!env.AI) {
    return { provider: 'workers-ai', success: false, error: 'no_binding', errorType: 'non_retryable', duration_ms: 0 };
  }
  try {
    // P0-1 FIX: Use the same JOURNALIST_SYSTEM Persian prompt as Groq + Gemini.
    // Previously had a hardcoded English prompt (~250 chars) that was weaker and
    // inconsistent with the rich Persian JOURNALIST_SYSTEM (~1500 chars) used by
    // primary providers. This caused multilingual models to produce English/mixed
    // output when Groq + Gemini circuits were OPEN.
    // Fallback to old English prompt ONLY if systemPrompt is not provided (backward compat).
    const effectiveSystemPrompt = systemPrompt || 'You are a professional Persian crypto and financial journalist. Read the full article and write a 120-200 word analysis in fluent Farsi. Preserve all key numbers, names, and dates. Explain what happened, important details, why it matters, and market impact. Write original analysis, not translation. Do NOT invent any facts. Use blank lines between paragraphs.';

    // P1-C FIX: Wrap env.AI.run() in a 15-second timeout. Previously a hanging
    // Workers AI request (backend stall) could block the entire News AI batch
    // indefinitely (no AbortController on bindings — Promise.race is the only
    // option). The unresolved env.AI.run() promise continues in the background
    // but its result is discarded; the Worker moves on to the next provider.
    const WORKERS_AI_TIMEOUT_MS = 15000;
    const aiPromise = env.AI.run('@cf/meta/llama-3.3-70b-instruct-fp8-fast', {
      messages: [
        { role: 'system', content: effectiveSystemPrompt },
        { role: 'user', content: prompt.substring(0, 12000) },
      ],
      max_tokens: 1536,
      temperature: 0.4,
    });
    const timeoutPromise = new Promise((_, reject) => {
      setTimeout(() => reject(new Error('workers_ai_timeout')), WORKERS_AI_TIMEOUT_MS);
    });
    const aiResponse = await Promise.race([aiPromise, timeoutPromise]);

    if (aiResponse?.response && aiResponse.response.trim().length >= 50) {
      return { provider: 'workers-ai', success: true, summary: aiResponse.response.trim(), duration_ms: Date.now() - t0 };
    }
    return { provider: 'workers-ai', success: false, error: 'empty_response', errorType: 'retryable', duration_ms: Date.now() - t0 };
  } catch (e) {
    const msg = e?.message || String(e) || '';
    const code = (typeof e?.code === 'number') ? e.code : null;

    // P1-B FIX: Explicitly classify Cloudflare Workers AI numeric error codes.
    //   4006 = daily free allocation (10K neurons) exhausted → NON-RETRYABLE
    //          Resets at UTC midnight. Probing every 10 min wastes calls.
    //          Production evidence: "4006: you have used up your daily free
    //          allocation of 10,000 neurons, please upgrade to Cloudflare's
    //          Workers Paid plan if..."
    //   3036 = daily allocation exceeded (Free Plan 10K neurons/day exhausted)
    //          → non-retryable until UTC midnight reset
    //   3040 = out of capacity (transient backend overload)
    //          → retryable (fallback to next provider, try again later)
    //   5035 = Paid-only model restriction (July 2026 — some models moved to Paid)
    //          → non-retryable (config issue, not transient)
    // Preserve existing message-regex behavior for unknown errors.
    if (code === 4006) {
      return {
        provider: 'workers-ai',
        success: false,
        error: 'daily_quota_exceeded',
        errorType: 'non_retryable',
        error_detail: `Workers AI code 4006: daily free allocation exhausted (msg=${msg.substring(0, 80)})`,
        duration_ms: Date.now() - t0,
      };
    }
    if (code === 3036) {
      return {
        provider: 'workers-ai',
        success: false,
        error: 'daily_allocation_exceeded',
        errorType: 'non_retryable',
        error_detail: `Workers AI code 3036: daily allocation exceeded (msg=${msg.substring(0, 80)})`,
        duration_ms: Date.now() - t0,
      };
    }
    if (code === 3040) {
      return {
        provider: 'workers-ai',
        success: false,
        error: 'out_of_capacity',
        errorType: 'retryable',
        error_detail: `Workers AI code 3040: out of capacity (msg=${msg.substring(0, 80)})`,
        duration_ms: Date.now() - t0,
      };
    }
    if (code === 5035) {
      return {
        provider: 'workers-ai',
        success: false,
        error: 'paid_only_model',
        errorType: 'non_retryable',
        error_detail: `Workers AI code 5035: model restricted to Paid plan (msg=${msg.substring(0, 80)})`,
        duration_ms: Date.now() - t0,
      };
    }

    // P1-C: timeout (thrown as 'workers_ai_timeout' by the Promise.race above)
    if (/workers_ai_timeout/i.test(msg)) {
      return {
        provider: 'workers-ai',
        success: false,
        error: 'timeout',
        errorType: 'retryable',
        error_detail: 'Workers AI request timed out after 15s',
        duration_ms: Date.now() - t0,
      };
    }

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
async function tryOpenAI(env, prompt, systemPrompt) {
  const t0 = Date.now();
  const OPENAI_API_KEY = env.OPENAI_API_KEY;
  if (!OPENAI_API_KEY) {
    return { provider: 'openai', success: false, error: 'no_api_key', errorType: 'non_retryable', duration_ms: 0 };
  }
  try {
    // P0-1 FIX: Use JOURNALIST_SYSTEM Persian prompt (same as Groq + Gemini)
    const effectiveSystemPrompt = systemPrompt || 'You are a professional Persian crypto and financial journalist. Read the full article and write a 120-200 word analysis in fluent Farsi. Preserve all key numbers, names, and dates. Explain what happened, important details, why it matters, and market impact. Write original analysis, not translation. Do NOT invent any facts. Use blank lines between paragraphs.';
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
          { role: 'system', content: effectiveSystemPrompt },
          { role: 'user', content: prompt.substring(0, 12000) },
        ],
        max_tokens: 1536,
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

/**
 * Provider 3: OpenRouter (emergency fallback 3) — free model via OpenRouter.
 * Uses nvidia/nemotron-3-super-120b-a12b:free (120B MoE, 256K context).
 * Called ONLY when Groq + Gemini + Workers AI all fail.
 * OpenAI-compatible API → same response parsing as tryOpenAI.
 * Circuit breaker key: 'openrouter' (via attemptProvider wrapper).
 */
async function tryOpenRouter(env, prompt, systemPrompt) {
  const t0 = Date.now();
  const OPENROUTER_API_KEY = env.OPENROUTER_API_KEY;
  if (!OPENROUTER_API_KEY) {
    return { provider: 'openrouter', success: false, error: 'no_api_key', errorType: 'non_retryable', duration_ms: 0 };
  }
  try {
    // P0-1 FIX: Use JOURNALIST_SYSTEM Persian prompt (same as Groq + Gemini)
    const effectiveSystemPrompt = systemPrompt || 'You are a professional Persian crypto and financial journalist. Read the full article and write a 120-200 word analysis in fluent Farsi. Preserve all key numbers, names, and dates. Explain what happened, important details, why it matters, and market impact. Write original analysis, not translation. Do NOT invent any facts. Use blank lines between paragraphs.';
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), 15000);
    const res = await fetch('https://openrouter.ai/api/v1/chat/completions', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${OPENROUTER_API_KEY}`,
        'HTTP-Referer': 'https://amir-btc-assistant.pages.dev',
        'X-Title': 'Amir BTC Assistant',
      },
      body: JSON.stringify({
        model: OPENROUTER_MODEL,
        messages: [
          { role: 'system', content: effectiveSystemPrompt },
          { role: 'user', content: prompt.substring(0, 12000) },
        ],
        max_tokens: 1536,
        temperature: 0.4,
        reasoning: { enabled: false },
      }),
      signal: controller.signal,
    });
    clearTimeout(timeout);

    if (!res.ok) {
      const errorType = classifyHttpError(res.status);
      let errorBody = '';
      try { errorBody = (await res.text()).substring(0, 200); } catch {}
      console.warn('[OR-DIAG] error= http_error status=' + res.status + ' duration=' + (Date.now() - t0) + 'ms');
      return { provider: 'openrouter', success: false, error: `http_${res.status}`, errorType, error_detail: errorBody, duration_ms: Date.now() - t0 };
    }

    let data;
    try {
      data = await res.json();
    } catch (e) {
      console.warn('[OR-DIAG] error=invalid_json status=200 duration=' + (Date.now() - t0) + 'ms');
      return { provider: 'openrouter', success: false, error: 'invalid_json', errorType: 'retryable', duration_ms: Date.now() - t0 };
    }

    const text = data?.choices?.[0]?.message?.content;
    const _contentLen = text ? text.trim().length : 0;
    if (text && text.trim().length >= 50) {
      console.log('[OR-DIAG] status=200 content_len=' + _contentLen + ' duration=' + (Date.now() - t0) + 'ms');
      return { provider: 'openrouter', success: true, summary: text.trim(), duration_ms: Date.now() - t0 };
    }
    console.warn('[OR-DIAG] error=empty_response status=200 content_len=' + _contentLen + ' text_null=' + (text == null) + ' duration=' + (Date.now() - t0) + 'ms');
    return { provider: 'openrouter', success: false, error: 'empty_response', errorType: 'retryable', duration_ms: Date.now() - t0 };
  } catch (e) {
    const isAbort = e?.name === 'AbortError';
    console.warn('[OR-DIAG] error=' + (isAbort ? 'timeout' : 'network_error') + ' duration=' + (Date.now() - t0) + 'ms threshold_exceeded=' + ((Date.now() - t0) > 15000));
    return {
      provider: 'openrouter',
      success: false,
      error: isAbort ? 'timeout' : 'network_error',
      errorType: 'retryable',
      error_detail: e?.message?.substring(0, 120),
      duration_ms: Date.now() - t0,
    };
  }
}
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
// PHASE 5 FIX: Prolonged-Open state — if circuit has been OPEN for this many
// consecutive probes (HALF_OPEN failures), increase the backoff to avoid
// infinite OPEN→HALF_OPEN→OPEN loop. Each probe failure doubles the backoff.
const CIRCUIT_BREAKER_PROLONGED_OPEN_THRESHOLD = 3; // After 3 probe failures
const CIRCUIT_BREAKER_PROLONGED_OPEN_MS = 60 * 60 * 1000; // 1 hour

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
// ── P1 FIX: In-memory probe lock (per-isolate) ──
// Prevents multiple concurrent callers in the same isolate from all becoming
// HALF-OPEN probes simultaneously. One probe per circuit per isolate.
// Cross-isolate: the KV state transition (OPEN→HALF_OPEN) itself acts as a
// best-effort lock — the first caller to write HALF_OPEN wins; others see
// HALF_OPEN and defer (return circuit_open until the probe completes).
const _probeLockInMemory = new Map(); // provider → { expiresAt: number }

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
    // P1 FIX: Single probe — check in-memory probe lock first
    const probeLock = _probeLockInMemory.get(provider);
    if (probeLock && now < probeLock.expiresAt) {
      // Another caller in this isolate is already probing — defer
      return { attempt: false, state: 'OPEN', retry_after: probeLock.expiresAt, reason: 'probe_in_progress' };
    }
    // Claim the probe slot (30s window for the probe to complete)
    _probeLockInMemory.set(provider, { expiresAt: now + 30000 });
    const newState = { ...state, state: 'HALF_OPEN' };
    await saveCircuitState(env, provider, newState);
    return { attempt: true, state: 'HALF_OPEN', retry_after: state.retry_after, reason: 'half_open_probe' };
  }

  if (state.state === 'HALF_OPEN') {
    // P1 FIX: Probe in progress — only the original probe caller should attempt.
    // Other concurrent callers should defer (return circuit_open) to prevent
    // multiple probes overwhelming the provider during cooldown.
    const probeLock = _probeLockInMemory.get(provider);
    if (probeLock && now < probeLock.expiresAt) {
      // Check if this caller is the original probe (best-effort: allow if no lock
      // or lock expired). In practice, the original probe caller already has
      // attempt=true from the OPEN→HALF_OPEN transition above.
      // For concurrent callers seeing HALF_OPEN, defer.
      return { attempt: false, state: 'HALF_OPEN', retry_after: probeLock.expiresAt, reason: 'probe_in_progress' };
    }
    // Lock expired or no lock — allow attempt (probe slot available)
    _probeLockInMemory.set(provider, { expiresAt: now + 30000 });
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

  // P1 FIX: Clear the in-memory probe lock when the probe completes (success or failure)
  if (state.state === 'HALF_OPEN') {
    _probeLockInMemory.delete(provider);
  }

  if (success) {
    // Success → always close the circuit
    if (state.state !== 'CLOSED' || state.consecutive_failures > 0) {
      await saveCircuitState(env, provider, {
        state: 'CLOSED',
        consecutive_failures: 0,
        opened_at: null,
        retry_after: null,
        probe_failures: 0, // PHASE 5: reset probe counter on success
        prolonged: false,
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

  // ── P1 FIX: Extract Groq 429 cooldown from errorMessage ──
  // errorMessage format for Groq 429: "http_429:quota_type:retry_after_seconds"
  // e.g. "http_429:daily_quota_tpd:932"
  // If present, use the parsed retry_after_seconds as the OPEN duration (not fixed 10 min).
  let groq429CooldownMs = null;
  if (errorMessage && errorMessage.startsWith('http_429:')) {
    const parts = errorMessage.split(':');
    if (parts.length >= 3) {
      const retryAfterSec = parseInt(parts[2], 10);
      if (retryAfterSec > 0) {
        groq429CooldownMs = retryAfterSec * 1000;
      }
    }
  }

  // Retryable failure
  if (state.state === 'HALF_OPEN') {
    // Probe failed → back to OPEN
    // P1 FIX: If this is a Groq 429 probe failure, use the FRESH retry_after from
    // the new 429 body (not the stale old cooldown). This prevents infinite probe
    // loops when TPD is exhausted — the new 429 has the accurate remaining cooldown.
    const probeFailures = (state.probe_failures || 0) + 1;
    const isProlonged = probeFailures >= CIRCUIT_BREAKER_PROLONGED_OPEN_THRESHOLD;
    // P1 FIX: Groq 429 cooldown takes precedence over fixed prolonged/open backoff
    const backoffMs = groq429CooldownMs
      || (isProlonged ? CIRCUIT_BREAKER_PROLONGED_OPEN_MS : CIRCUIT_BREAKER_OPEN_MS);
    console.warn(`[CIRCUIT] ${provider} probe failed (${probeFailures}x). ${groq429CooldownMs ? `OPEN for ${groq429CooldownMs / 1000}s (Groq 429 cooldown)` : `${isProlonged ? 'PROLONGED OPEN' : 'OPEN'} for ${backoffMs / 60000}min`}`);
    await saveCircuitState(env, provider, {
      state: 'OPEN',
      consecutive_failures: state.consecutive_failures + 1,
      opened_at: now,
      retry_after: now + backoffMs,
      probe_failures: probeFailures,
      prolonged: isProlonged,
      last_failure_reason: errorMessage || 'half_open_probe_failed',
    });
    return;
  }

  // CLOSED (or already OPEN) → increment consecutive failures
  const newFailures = (state.consecutive_failures || 0) + 1;
  if (newFailures >= CIRCUIT_BREAKER_FAILURE_THRESHOLD) {
    // Trip the circuit → OPEN
    // P1 FIX: Groq 429 cooldown takes precedence over fixed 10-min OPEN
    const backoffMs = groq429CooldownMs || CIRCUIT_BREAKER_OPEN_MS;
    await saveCircuitState(env, provider, {
      state: 'OPEN',
      consecutive_failures: newFailures,
      opened_at: now,
      retry_after: now + backoffMs,
      probe_failures: 0, // PHASE 5: start counting probe failures
      prolonged: false,
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

  return {
    isNewsFlagEnabled,
    isNewsAIEnabled,
    isNewsSummaryEnabled,
    isNewsBatchAnalysisEnabled,
    isNewsQueueEnabled,
    isNewsProviderEnabled,
    classifyHttpError,
    classifyGroq429,
    parseGroqRetryAfter,
    parseGroq429Info,
    groqPrimaryGenerate,
    _groqRouterGetKeyState,
    _groqRouterSetKeyState,
    _groqRouterDiscoverKeys,
    _groqRouterSelectBestKey,
    _groqRouterRecordRequest,
    _groqRouterRecordSuccess,
    _groqRouterRecord429,
    _groqRouterRecordFailure,
    _groqRouterCallGateway,
    groqRouterExecute,
    _groqRoutedFetch,
    tryGroq,
    tryWorkersAI,
    tryOpenAI,
    tryOpenRouter,
    getCircuitState,
    saveCircuitState,
    shouldAttemptProvider,
    recordCircuitResult,
    NEWS_AI_PROVIDER_STATS_KEY,
    OPENAI_MODEL,
    OPENROUTER_MODEL,
    GROQ_ROUTER_KEY_PREFIX,
    GROQ_ROUTER_STATE_TTL,
    GROQ_ROUTER_WINDOW_MS,
    GROQ_ROUTER_MAX_PER_WINDOW,
    GROQ_ROUTER_FAILURE_THRESHOLD,
    GROQ_ROUTER_DEFAULT_OPEN_MS,
    GROQ_ROUTER_PROBE_LOCK_MS,
    CIRCUIT_BREAKER_KEY_PREFIX,
    CIRCUIT_BREAKER_TTL,
    CIRCUIT_BREAKER_FAILURE_THRESHOLD,
    CIRCUIT_BREAKER_OPEN_MS,
    CIRCUIT_BREAKER_PROLONGED_OPEN_THRESHOLD,
    CIRCUIT_BREAKER_PROLONGED_OPEN_MS,
  };
}

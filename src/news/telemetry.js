// ═════════════════════════════════════════════════════════════════════════════
// News AI Telemetry — extracted from worker-proxy.js (lines 7960-8524).
//
// Factory pattern: createNewsTelemetry({ queryDb, ...flags, ...config })
// Returns: { ensureTelemetryTables, recordNewsAITick, recordE2ETiming,
//            getE2ETimingStats, getNewsAIMonitoring, cleanupTickLog,
//            cleanupE2ETimingLog, insertNewsAITickLog, insertNewsAIE2ELog }
//
// DI dependencies:
//   - queryDb: DB query helper (for Postgres INSERT/SELECT on telemetry tables)
//   - isNewsAIEnabled, isNewsSummaryEnabled, etc.: feature flag helpers
//     (used by getNewsAIMonitoring to report flag states)
//   - CIRCUIT_BREAKER_*, GROQ_ROUTER_*, NEWS_AI_CACHE_TTL, etc.: config constants
//     (used by getNewsAIMonitoring to report current configuration)
//
// Mutable state (inside factory closure, shared across all calls):
//   - _telemetryTablesEnsured: prevents redundant CREATE TABLE calls
//
// Behavior-preserving extraction: no logic, SQL, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createNewsTelemetry({
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
}) {

let _telemetryTablesEnsured = false;

async function ensureTelemetryTables(env) {
  if (_telemetryTablesEnsured) return;
  try {
    await queryDb(env, `
      CREATE TABLE IF NOT EXISTS news_ai_tick_log (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        tick_type VARCHAR(16) NOT NULL,
        stats JSONB NOT NULL
      )
    `);
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_news_ai_tick_log_created ON news_ai_tick_log (created_at DESC)`).catch(() => {});
    await queryDb(env, `
      CREATE TABLE IF NOT EXISTS news_ai_e2e_log (
        id SERIAL PRIMARY KEY,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        url TEXT,
        provider VARCHAR(32),
        timing JSONB NOT NULL
      )
    `);
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_news_ai_e2e_log_created ON news_ai_e2e_log (created_at DESC)`).catch(() => {});
    _telemetryTablesEnsured = true;
  } catch (e) {
    // Non-fatal — table creation is best-effort. News AI must NOT fail.
    // Next isolate cold start resets _telemetryTablesEnsured and retries.
    console.warn('[TELEMETRY-DB] ensureTelemetryTables failed:', e?.message);
  }
}

async function insertNewsAITickLog(env, tickType, stats) {
  try {
    await queryDb(env, `
      INSERT INTO news_ai_tick_log (tick_type, stats)
      VALUES ($1, $2::jsonb)
    `, [String(tickType), JSON.stringify(stats)]);
  } catch (e) {
    // Non-fatal — telemetry failure must NOT break News AI.
    console.warn('[TELEMETRY-DB] insertNewsAITickLog failed:', e?.message);
  }
}

async function insertNewsAIE2ELog(env, url, provider, timing) {
  try {
    await queryDb(env, `
      INSERT INTO news_ai_e2e_log (url, provider, timing)
      VALUES ($1, $2, $3::jsonb)
    `, [String(url || ''), String(provider || ''), JSON.stringify(timing)]);
  } catch (e) {
    // Non-fatal — telemetry failure must NOT break News AI.
    console.warn('[TELEMETRY-DB] insertNewsAIE2ELog failed:', e?.message);
  }
}

async function cleanupTickLog(env, days) {
  if (days === undefined) days = 4;
  try {
    const result = await queryDb(env, `
      DELETE FROM news_ai_tick_log
      WHERE created_at < NOW() - ($1::text)::interval
    `, [`${parseInt(days, 10) || 4} days`]);
    return (result.rows || []).length;
  } catch (e) {
    // Non-fatal — cleanup failure must NOT break News AI.
    console.warn('[TELEMETRY-DB] cleanupTickLog failed:', e?.message);
    return 0;
  }
}

async function cleanupE2ETimingLog(env, days) {
  if (days === undefined) days = 4;
  try {
    const result = await queryDb(env, `
      DELETE FROM news_ai_e2e_log
      WHERE created_at < NOW() - ($1::text)::interval
    `, [`${parseInt(days, 10) || 4} days`]);
    return (result.rows || []).length;
  } catch (e) {
    // Non-fatal — cleanup failure must NOT break News AI.
    console.warn('[TELEMETRY-DB] cleanupE2ETimingLog failed:', e?.message);
    return 0;
  }
}

/**
 * Record News AI tick stats to Postgres for monitoring.
 * Called after each processNewsAIBatch / processOneArticleSummary tick.
 * OPTION 1 MIGRATION: KV (news:ai_monitor read-modify-write) → Postgres INSERT (news_ai_tick_log).
 * The rolling 20-entry window is enforced by SELECT LIMIT 20 in getNewsAIMonitoring;
 * 4-day retention by cleanupTickLog (called from processNewsAIBatch STEP 11).
 * Failure is best-effort (catch + warn) — telemetry must NOT break News AI.
 */
async function recordNewsAITick(env, stats) {
  try {
    await ensureTelemetryTables(env);
    const tickType = (stats && stats.type) || 'batch';
    // Store stats WITHOUT type (it's in the tick_type column) and WITHOUT ts
    // (created_at is the authoritative timestamp, read back as ts on SELECT).
    const { type, ts, ...statsPayload } = stats || {};
    await insertNewsAITickLog(env, tickType, statsPayload);
  } catch (e) {
    console.warn('[NEWS-AI-MONITOR] recordTick failed:', e?.message);
  }
}

// ── E2E Timing History (Phase 10.5 final validation) ──
const NEWS_AI_E2E_TIMING_KEY = 'news:ai_e2e_timing';
const NEWS_AI_E2E_TIMING_TTL = 24 * 60 * 60; // 24h

/**
 * Record E2E timing for a completed summary to Postgres.
 * OPTION 1 MIGRATION: KV (news:ai_e2e_timing read-modify-write) → Postgres INSERT (news_ai_e2e_log).
 * The rolling 50-entry window is enforced by SELECT LIMIT 50 in getE2ETimingStats;
 * 4-day retention by cleanupE2ETimingLog (called from processNewsAIBatch STEP 11).
 * Failure is best-effort (catch + warn) — telemetry must NOT break News AI.
 */
async function recordE2ETiming(env, timing) {
  try {
    await ensureTelemetryTables(env);
    // Store url + provider in dedicated columns (for the by_provider breakdown);
    // the rest of the timing fields go in the JSONB. ts comes from created_at on read.
    const { ts, url, provider, ...timingPayload } = timing || {};
    await insertNewsAIE2ELog(env, url, provider, timingPayload);
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
    await ensureTelemetryTables(env);
    const result = await queryDb(env, `
      SELECT url, provider, timing,
             EXTRACT(EPOCH FROM created_at) * 1000 AS ts
      FROM news_ai_e2e_log
      ORDER BY created_at DESC
      LIMIT 50
    `);
    if (result.rows && result.rows.length > 0) {
      // DB returns newest-first (DESC); reverse to oldest→newest to match the prior KV array order.
      history = result.rows.reverse().map(function (r) {
        return {
          ts: Math.round(Number(r.ts)),
          url: r.url,
          provider: r.provider,
          ...((r.timing && typeof r.timing === 'object') ? r.timing : {}),
        };
      });
    }
  } catch (e) {
    console.warn('[NEWS-AI-TIMING] E2E history DB read failed:', e?.message);
  }

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

  // Read tick history from Postgres (Option 1: migrated from KV news:ai_monitor).
  // SELECT newest 20, then reverse to oldest→newest (to match the prior KV array order).
  let history = [];
  try {
    await ensureTelemetryTables(env);
    const result = await queryDb(env, `
      SELECT tick_type, stats,
             EXTRACT(EPOCH FROM created_at) * 1000 AS ts
      FROM news_ai_tick_log
      ORDER BY created_at DESC
      LIMIT 20
    `);
    if (result.rows && result.rows.length > 0) {
      history = result.rows.reverse().map(function (r) {
        return {
          ts: Math.round(Number(r.ts)),
          type: r.tick_type,
          ...((r.stats && typeof r.stats === 'object') ? r.stats : {}),
        };
      });
    }
  } catch (e) {
    console.warn('[NEWS-AI-MONITOR] tick history DB read failed:', e?.message);
  }

  const lastTick = history.length > 0 ? history[history.length - 1] : null;

  // ── H4 FIX: Provider stats from Postgres (news_ai_tick_log) instead of KV RMW ──
  let providerStats = null;
  try {
    await ensureTelemetryTables(env);
    // Query per-provider stats from provider_attempts JSONB array
    const providerResult = await queryDb(env, `
      SELECT
        attempt->>'provider' AS provider,
        COUNT(*) FILTER (WHERE (attempt->>'success')::boolean) AS success,
        COUNT(*) FILTER (WHERE NOT (attempt->>'success')::boolean) AS failed,
        COALESCE(SUM((attempt->>'duration_ms')::int), 0) AS total_ms
      FROM news_ai_tick_log,
        jsonb_array_elements(stats->'provider_attempts') AS attempt
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND tick_type = 'tick_5min'
        AND stats ? 'provider_attempts'
      GROUP BY attempt->>'provider'
    `).catch(() => ({ rows: [] }));

    // Query fallback stats
    const fallbackResult = await queryDb(env, `
      SELECT
        COUNT(*) AS fallback_count,
        stats->>'final_provider' AS provider
      FROM news_ai_tick_log
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND tick_type = 'tick_5min'
        AND (stats->>'fallback_used')::boolean = true
        AND stats->>'final_provider' IS NOT NULL
      GROUP BY stats->>'final_provider'
    `).catch(() => ({ rows: [] }));

    // Query total summaries + avg time + updated_at
    const summaryResult = await queryDb(env, `
      SELECT
        COUNT(*) AS total_summaries,
        COALESCE(AVG((stats->>'summary_duration_ms')::int), 0) AS avg_duration_ms,
        EXTRACT(EPOCH FROM MAX(created_at)) * 1000 AS updated_at
      FROM news_ai_tick_log
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND tick_type = 'tick_5min'
        AND (stats->>'summary_success')::boolean = true
    `).catch(() => ({ rows: [] }));

    // Build providerStats object matching the OLD KV shape for backward compat
    providerStats = {
      groq: { success: 0, failed: 0, total_ms: 0 },
      'workers-ai': { success: 0, failed: 0, total_ms: 0 },
      'openrouter': { success: 0, failed: 0, total_ms: 0 },
      openai: { success: 0, failed: 0, total_ms: 0 },
      fallback_count: 0,
      fallback_to: {},
      total_summaries: 0,
      total_duration_ms: 0,
      updated_at: null,
    };

    for (const row of providerResult.rows || []) {
      const p = row.provider;
      if (providerStats[p]) {
        providerStats[p].success = Number(row.success) || 0;
        providerStats[p].failed = Number(row.failed) || 0;
        providerStats[p].total_ms = Number(row.total_ms) || 0;
      }
    }

    let totalFallback = 0;
    for (const row of fallbackResult.rows || []) {
      const p = row.provider;
      const count = Number(row.fallback_count) || 0;
      totalFallback += count;
      if (p) providerStats.fallback_to[p] = count;
    }
    providerStats.fallback_count = totalFallback;

    const summaryRow = summaryResult.rows?.[0];
    if (summaryRow) {
      providerStats.total_summaries = Number(summaryRow.total_summaries) || 0;
      // Reconstruct total_duration_ms from avg * count (for backward compat with avgSummaryTimeMs calculation)
      providerStats.total_duration_ms = Math.round(Number(summaryRow.avg_duration_ms) || 0) * providerStats.total_summaries;
      providerStats.updated_at = Number(summaryRow.updated_at) || null;
    }
  } catch (e) {
    console.warn('[NEWS-AI-MONITOR] provider stats DB query failed:', e?.message);
  }

  // Calculate "Average Provider" = the provider used most often for SUCCESSFUL summaries
  let avgProvider = null;
  let avgSummaryTimeMs = 0;
  if (providerStats) {
    // GROQ-ROUTER-4KEY: gemini removed; 'groq' aggregates all router successes.
    const providers = ['groq', 'workers-ai', 'openrouter', 'openai'];
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

  // ── Phase 10.5: Circuit Breaker state per non-Groq provider ──
  // GROQ-ROUTER-4KEY: Groq does NOT use the standard circuit breaker — the
  // router manages per-key state in `groq:router:key{N}`. We surface router
  // state separately in `groq_router_keys` below. Only non-Groq providers are
  // included in `provider_status` here.
  const providerNames = ['workers-ai', 'openrouter', 'openai'];
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

  // ── GROQ-ROUTER-4KEY: Per-key router state (groq:router:key{0..3}) ──
  // Surface all 4 potential key slots so operators can see which key is
  // OPEN/cooldown and which is healthy.
  //
  // MONITORING FIX: When GROQ_ROUTER_DO is available, read key states from
  // the DO (authoritative — the DO maintains its own SQLite state that the
  // KV path does NOT update when the DO path is active). Falls back to KV
  // when DO is unavailable or the getStates call fails.
  let groq_router_source = 'kv_fallback';
  let groqRouterKeys = [];

  // Try DO path first (authoritative when DO binding is active in production)
  if (env.GROQ_ROUTER_DO && typeof env.GROQ_ROUTER_DO.idFromName === 'function') {
    try {
      const keyIndices = [0, 1, 2, 3];
      const doId = env.GROQ_ROUTER_DO.idFromName('groq-router');
      const doStub = env.GROQ_ROUTER_DO.get(doId);
      const statesRes = await doStub.fetch('https://do/?action=getStates', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ keyIndices }),
      });
      if (!statesRes.ok) throw new Error(`DO getStates HTTP ${statesRes.status}`);
      const statesData = await statesRes.json();
      if (statesData.states && Array.isArray(statesData.states) && statesData.states.length > 0) {
        groq_router_source = 'durable_object';
        for (const s of statesData.states) {
          const cooldownRemainingS = s.retry_after ? Math.max(0, Math.ceil((s.retry_after - now) / 1000)) : 0;
          groqRouterKeys.push({
            index: s.index,
            configured: s.index === 0 ? Boolean(env.GROQ_API_KEY)
              : s.index === 1 ? Boolean(env.GROQ_API_KEY_1)
              : s.index === 2 ? Boolean(env.GROQ_API_KEY_2)
              : Boolean(env.GROQ_API_KEY_3),
            state: s.state,
            consecutive_failures: s.consecutive_failures || 0,
            retry_after: s.retry_after,
            cooldown_remaining_s: cooldownRemainingS,
            probe_failures: s.probe_failures || 0,
            quota_type: s.quota_type || null,
            last_failure_reason: s.last_failure_reason || null,
            window_requests_count: s.window_requests || 0,
            window_max: GROQ_ROUTER_MAX_PER_WINDOW,
          });
        }
      }
    } catch (e) {
      console.warn('[NEWS-AI-MONITOR] DO getStates failed, falling back to KV:', e?.message);
    }
  }

  // KV fallback: if DO path failed, was unavailable, or returned empty results
  if (groqRouterKeys.length === 0) {
    for (let i = 0; i < 4; i++) {
      const s = await _groqRouterGetKeyState(env, i);
      const cooldownRemainingS = s.retry_after ? Math.max(0, Math.ceil((s.retry_after - now) / 1000)) : 0;
      groqRouterKeys.push({
        index: i,
        configured: i === 0 ? Boolean(env.GROQ_API_KEY)
          : i === 1 ? Boolean(env.GROQ_API_KEY_1)
          : i === 2 ? Boolean(env.GROQ_API_KEY_2)
          : Boolean(env.GROQ_API_KEY_3),
        state: s.state,
        consecutive_failures: s.consecutive_failures || 0,
        retry_after: s.retry_after,
        cooldown_remaining_s: cooldownRemainingS,
        probe_failures: s.probe_failures || 0,
        quota_type: s.quota_type || null,
        last_failure_reason: s.last_failure_reason || null,
        window_requests_count: (s.window_requests || []).length,
        window_max: GROQ_ROUTER_MAX_PER_WINDOW,
      });
    }
  }

  // ── H4 FIX: Cache stats from Postgres (news_ai_tick_log) instead of KV RMW ──
  let cacheHits = 0, cacheMisses = 0, cacheHitRate = 0;
  try {
    await ensureTelemetryTables(env);
    const cacheResult = await queryDb(env, `
      SELECT
        COUNT(*) FILTER (WHERE
          (stats ? 'cache_hit' AND (stats->>'cache_hit')::boolean = true)
          OR (NOT stats ? 'cache_hit' AND stats->>'summary_reason' = 'cache_hit')
        ) AS hits,
        COUNT(*) FILTER (WHERE
          (stats ? 'cache_hit' AND (stats->>'cache_hit')::boolean = false)
          OR (NOT stats ? 'cache_hit' AND stats->>'summary_reason' IS NOT NULL AND stats->>'summary_reason' != 'cache_hit' AND (stats->>'summary_processed')::boolean = true)
        ) AS misses
      FROM news_ai_tick_log
      WHERE created_at >= NOW() - INTERVAL '24 hours'
        AND tick_type = 'tick_5min'
    `).catch(() => ({ rows: [] }));
    const cacheRow = cacheResult.rows?.[0];
    if (cacheRow) {
      cacheHits = Number(cacheRow.hits) || 0;
      cacheMisses = Number(cacheRow.misses) || 0;
      const total = cacheHits + cacheMisses;
      cacheHitRate = total > 0 ? Math.round((cacheHits / total) * 1000) / 10 : 0;
    }
  } catch (e) {
    console.warn('[NEWS-AI-MONITOR] cache stats DB query failed:', e?.message);
  }

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
      NEWS_PROVIDER_GROQ: isNewsProviderEnabled(env, 'NEWS_PROVIDER_GROQ', true),
      GROQ_API_KEY_0_CONFIGURED: Boolean(env.GROQ_API_KEY),
      GROQ_API_KEY_1_CONFIGURED: Boolean(env.GROQ_API_KEY_1),
      GROQ_API_KEY_2_CONFIGURED: Boolean(env.GROQ_API_KEY_2),
      GROQ_API_KEY_3_CONFIGURED: Boolean(env.GROQ_API_KEY_3),
      NEWS_PROVIDER_WORKERS_AI: isNewsProviderEnabled(env, 'NEWS_PROVIDER_WORKERS_AI', true),
      NEWS_PROVIDER_OPENROUTER: isNewsProviderEnabled(env, 'NEWS_PROVIDER_OPENROUTER', true),
      NEWS_PROVIDER_OPENAI: isNewsProviderEnabled(env, 'NEWS_PROVIDER_OPENAI', false),
    },
    config: {
      max_retries: NEWS_SUMMARY_MAX_RETRIES,
      backoff_minutes: NEWS_SUMMARY_BACKOFF_MINUTES,
      summary_ttl_days: NEWS_AI_CACHE_TTL / (24 * 3600),
      news_list_ttl_minutes: 30,
      // Phase 10: provider config
      openai_model: OPENAI_MODEL,
      providers_priority: ['groq', 'openrouter', 'workers-ai', 'openai'],
      // Phase 10.5: circuit breaker config
      circuit_breaker_threshold: CIRCUIT_BREAKER_FAILURE_THRESHOLD,
      circuit_breaker_open_ms: CIRCUIT_BREAKER_OPEN_MS,
    },
    // Phase 10: per-provider stats (GROQ-ROUTER-4KEY: gemini removed)
    providers: {
      groq: providerStats?.groq || { success: 0, failed: 0, total_ms: 0 },
      'workers-ai': providerStats?.['workers-ai'] || { success: 0, failed: 0, total_ms: 0 },
      'openrouter': providerStats?.openrouter || { success: 0, failed: 0, total_ms: 0 },
      'openai': providerStats?.openai || { success: 0, failed: 0, total_ms: 0 },
    },
    fallback_count: providerStats?.fallback_count || 0,
    fallback_to: providerStats?.fallback_to || {},
    average_provider: avgProvider,
    average_summary_time_ms: avgSummaryTimeMs,
    total_summaries_generated: providerStats?.total_summaries || 0,
    provider_stats_updated_at: providerStats?.updated_at || null,
    // Phase 10.5: Circuit Breaker status (non-Groq providers)
    provider_status: providerStatus,
    circuit_breaker_open_count: circuitOpenCount,
    // GROQ-ROUTER-4KEY: Per-key Groq router state (replaces old groq-key0/groq-key1 circuits)
    groq_router_keys: groqRouterKeys,
    // MONITORING FIX: Source of groq_router_keys — 'durable_object' (authoritative)
    // or 'kv_fallback' (may be stale when DO path is active in production).
    groq_router_source: groq_router_source,
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

  return {
    ensureTelemetryTables,
    insertNewsAITickLog,
    insertNewsAIE2ELog,
    cleanupTickLog,
    cleanupE2ETimingLog,
    recordNewsAITick,
    recordE2ETiming,
    getE2ETimingStats,
    getNewsAIMonitoring,
  };
}

// ═════════════════════════════════════════════════════════════════════════════
// Scheduled (Cron) Handler — extracted from worker-proxy.js
// Behavior-preserving extraction: the body of `scheduled()` moved verbatim.
// worker-proxy.js `scheduled()` shell retains: _dbTraceEnabled lazy init + this call.
// ═════════════════════════════════════════════════════════════════════════════

export async function runScheduled(controller, env, ctx, deps) {
  const {
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
  } = deps;

    const _cronTickId = Date.now() + '_' + Math.random().toString(36).slice(2, 8);
    const _cronTickStart = Date.now();
    const _cronTickMinute = new Date().getUTCMinutes();
    const _cronTickExpr = controller.cron || '* * * * *';

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
    //   Phase 3b (minute 15/45): news AI (~8ms CPU with batching)
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

        // NOTIF-FIX: Process notification queue on EVERY 1-min tick (not just */5).
        // This reduces average notification delivery delay from ~2.5 min to ~30 sec.
        //
        // CPU budget (worst case: 5 alerts trigger + 3 queue items):
        //   withPhasePool: ~1ms
        //   runScheduledAlertsBaseline (5 triggers): ~7ms
        //   processQueue (3 items): ~1.5ms (0.5ms claim + 3 × 0.5ms per item)
        //   Total: ~9.5ms — under 10ms Free Plan limit (0.5ms margin)
        //
        // LIMIT 3 chosen over LIMIT 5 for CPU safety margin:
        //   - LIMIT 5 worst case: 10.5ms — EXCEEDS 10ms limit
        //   - LIMIT 3 worst case: 9.5ms — SAFE (marginal but under limit)
        //   - LIMIT 2 worst case: 9ms — safer but slower drain
        //   - Typical case (0 alerts + empty queue): 2.5ms regardless of LIMIT
        //
        // Throttle strategy (gradual drain, NO burst):
        //   - LIMIT 3 per 1-min tick = max 3 Telegram messages per minute
        //   - */5 cron also processes LIMIT 10 (backwards compatible)
        //   - Combined throughput: 3/min + 10/5min = 5 items/min average
        //   - 100 items backlog: drained in ~20 minutes (gradual, no burst)
        //   - FOR UPDATE SKIP LOCKED prevents concurrent 1-min + */5 overlap
        //   - Empty queue: 1 queryDb (~0.5ms) — fast exit, negligible CPU
        //
        // Telegram rate limit: ~30 msg/sec globally. 3 msg/min = 0.05 msg/sec
        // — far under the limit. No rate limit risk.
        // FIX 3: limit increased from 3 to 5 (67% improvement). Subrequest budget:
        //   Worst case: 15 price fetches + 15 alert Telegram sends + 5 processQueue = 35 ≤ 50 ✅
        //   Not increasing to 8+ because price alerts can have >15 unique symbols
        //   (multiple FETCH_BATCH rounds) and >5 triggered alerts (maxAlerts=500).
        //   The 1-min cron is the most frequent — conservative is correct.
        if (notificationPlatformRepo?.processQueue) {
          try {
            const queueResult = await notificationPlatformRepo.processQueue(env, sendTelegramMessage, pool, 5);
            if (queueResult.processed > 0) {
              console.log('[CRON] processQueue (1min, limit=5):', JSON.stringify(queueResult));
            }
            _logPhase('processQueue-1min', 'ok', queueResult);
          } catch (e) {
            _logPhase('processQueue-1min', 'error', { error: e?.message });
            console.warn('[CRON] processQueue (1min) failed:', e?.message);
          }
        }
      }).catch((e) => {
        console.error(JSON.stringify({ scope: 'cron-unhandled', cron: '* * * * *', errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 300), stack: String(e?.stack || '').slice(0, 500) }));
      }));

      // ── HOURLY RETRY (inside 1-min cron, gated to UTC minute === 0) ──
      // CPU FIX: These retry jobs were previously on the */15 cron, where they
      // competed with processNewsAIBatch for CPU/subrequest budget and caused
      // exceededResources on Workers Free plan. They are now run from the
      // every-minute cron but ONLY at the top of each hour (UTC minute 0).
      // This gives them their own invocation with a full CPU budget, without
      // needing a 4th cron trigger (Free Plan limit: 3 triggers).
      //
      // Idempotency: Each retry function uses LIMIT 20 + per-item idempotency
      // (ON CONFLICT DO NOTHING for token_transactions). Running hourly is
      // safe — backlogs drain at 20 items per function per hour (60 total).
      //
      // Failure isolation: Each retry runs in its own ctx.waitUntil — a failure
      // in one does NOT cancel the alerts/queue work above (already committed
      // via its own ctx.waitUntil). env._reqPool is nulled before each retry
      // to prevent stale-pool I/O errors.
      const _hourlyMinute = new Date().getUTCMinutes();
      if (_hourlyMinute === 0) {
        const _savedReqPoolForRetry = env._reqPool;
        env._reqPool = null;
        ctx.waitUntil((async () => {
          try {
            await retryFailedReferralRewards(env);
            _logPhase('hourly-referral', 'ok');
          } catch (e) {
            _logPhase('hourly-referral', 'error', { error: e?.message });
            console.warn('[CRON] referral retry failed:', e?.message);
          } finally {
            env._reqPool = _savedReqPoolForRetry;
          }
        })().catch((e) => {
          console.error(JSON.stringify({ scope: 'cron-unhandled', cron: _cronTickExpr, source: 'retryFailedReferral', errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 300), stack: String(e?.stack || '').slice(0, 500) }));
        }));
        const _savedReqPoolForWheel = env._reqPool;
        env._reqPool = null;
        ctx.waitUntil((async () => {
          try {
            await retryFailedWheelRewards(env);
            _logPhase('hourly-wheel', 'ok');
          } catch (e) {
            _logPhase('hourly-wheel', 'error', { error: e?.message });
            console.warn('[CRON] wheel retry failed:', e?.message);
          } finally {
            env._reqPool = _savedReqPoolForWheel;
          }
        })().catch((e) => {
          console.error(JSON.stringify({ scope: 'cron-unhandled', cron: _cronTickExpr, source: 'retryFailedWheel', errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 300), stack: String(e?.stack || '').slice(0, 500) }));
        }));
        const _savedReqPoolForMission = env._reqPool;
        env._reqPool = null;
        ctx.waitUntil((async () => {
          try {
            await retryFailedMissionRewards(env);
            _logPhase('hourly-mission', 'ok');
          } catch (e) {
            _logPhase('hourly-mission', 'error', { error: e?.message });
            console.warn('[CRON] mission reward retry failed:', e?.message);
          } finally {
            env._reqPool = _savedReqPoolForMission;
          }
        })().catch((e) => {
          console.error(JSON.stringify({ scope: 'cron-unhandled', cron: _cronTickExpr, source: 'retryFailedMission', errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 300), stack: String(e?.stack || '').slice(0, 500) }));
        }));
        // BUG 4+5 FIX: Retry failed refunds (same hourly slot as other retry crons)
        const _savedReqPoolForRefunds = env._reqPool;
        env._reqPool = null;
        ctx.waitUntil((async () => {
          try {
            await retryFailedRefunds(env);
            _logPhase('hourly-refunds', 'ok');
          } catch (e) {
            _logPhase('hourly-refunds', 'error', { error: e?.message });
            console.warn('[CRON] refund retry failed:', e?.message);
          } finally {
            env._reqPool = _savedReqPoolForRefunds;
          }
        })().catch((e) => {
          console.error(JSON.stringify({ scope: 'cron-unhandled', cron: _cronTickExpr, source: 'retryFailedRefunds', errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 300), stack: String(e?.stack || '').slice(0, 500) }));
        }));
      }

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
        // - Items capped at LIMIT 15 per tick (FIX 2: was 10, now 15 — 50% throughput increase)
        // - 1-min cron uses LIMIT 5 (FIX 3: was 3, now 5)
        // FIX 2 REVISED: Subrequest budget analysis (worst case */5 WITH calendar event):
        //   processQueue(15): 15 Telegram + broadcast PQ(10): 10 Telegram
        //   + calendar price fetches: 15 + news summary: 8 = 48 ≤ 50 ✅
        //   On */15 tick: + 1 (cal cache) + 1 (market) + 8 (news AI) = 58 > 50 ❌
        //   BUT: calendar alerts RARELY fire on the SAME tick as */15-only jobs.
        //   Calendar alerts fire on ANY */5 tick when a high-impact event is within 1h.
        //   News AI + market + calendar cache only run on */15.
        //   Worst REALISTIC case (*/5 + calendar event, NOT */15): 15+10+15+8 = 48 ≤ 50 ✅
        //   batch=20 would give 20+10+15+8 = 53 > 50 — UNSAFE. batch=15 is the safe maximum.
        if (notificationPlatformRepo?.processQueue) {
          try {
            const queueResult = await notificationPlatformRepo.processQueue(env, sendTelegramMessage, pool, 15);
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
      // Process up to 4 article summaries per tick from the KV queue.
      // Queue persists across cron ticks — no article is lost.
      //
      // FIX B (Summary queue throughput): increased from 2 to 4 articles per tick.
      // Previous: 2 × 12 ticks/hour = 24 summaries/hour (queue could grow when AI
      // providers had intermittent failures). New: 4 × 12 = 48/hour — drains queue
      // 2× faster, reducing the window where articles lack AI summaries.
      //
      // Resource budget verification (5-min cron ONLY runs this + calendar + broadcast,
      // NOT the heavy 15-min processNewsAIBatch):
      //   - Subrequests: 4 articles × (1 HTML fetch + 1 AI call) = 8 subrequests
      //     + calendar (1-2) + broadcast (1-2) = ~12 total — well under 50 limit
      //   - CPU: 4 × ~3ms (AI fetch+parse) = ~12ms — within 5-min cron's CPU budget
      //     (5-min cron doesn't run alerts baseline or RSS fetches)
      //   - Early break: if queue empty or no eligible items, loop breaks immediately
      //     (no wasted subrequests)
      // If queue is empty, processOneArticleSummary returns immediately (no extra work).
      // Feature flags respected inside processOneArticleSummary (NEWS_SUMMARY_ENABLED).
      // OPTION A: Skip on */15 overlap to avoid Groq burst. At :00/:15/:30/:45, the */15 cron
      // already runs processNewsAIBatch (batchTranslate + batchAnalyze = 2 Groq calls). Running
      // processOneArticleSummary (up to 4 more Groq calls) in the same instant creates a 6-request
      // burst that trips Groq's 30 RPM limit. Skipping here reduces the burst to 2 requests on
      // overlap minutes. Articles stay in the KV queue (TTL 24h) and are processed on the next
      // non-overlap */5 tick (max 5-minute delay).
      //
      // FIX (Priority 3): isEvery15Min is derived from controller.cron (per-invocation), so it
      // is ALWAYS false on a */5 invocation. The original condition `isEvery5Min && !isEvery15Min`
      // was always true on */5, causing Phase 1d to run at :00/:15/:30/:45 (overlap minutes).
      // Now we check the current UTC minute to detect overlap with */15.
      const _phase1dCurrentMinute = new Date().getUTCMinutes();
      const _phase1dIsOverlapWith15Min = _phase1dCurrentMinute % 15 === 0;
      if (isEvery5Min && !_phase1dIsOverlapWith15Min) {
        const MAX_SUMMARIES_PER_TICK = 2; // H5-5min FIX: was 4, reduced to stay within 50-subrequest Free Plan limit (4×14=56 over 50, 2×14=28 safe with ~22 margin for other phases)
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
                // H4 FIX: telemetry fields (previously KV RMW via recordCacheStat/recordProviderAttempt/recordFallbackEvent)
                cache_hit: summaryResult.cache_hit || false,
                provider_attempts: summaryResult.provider_attempts || [],
                fallback_used: summaryResult.fallback_used || false,
                final_provider: summaryResult.provider || null,
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
        // ROOT-CAUSE FIX: processNewsAIBatch runs on EVERY 15-min tick (not just :15/:45)
        // This ensures new articles are enqueued within 15 min of appearing in RSS.
        try { await processNewsAIBatch(env, pool); _logPhase('phase3-newsai', 'ok'); } catch (e) {
          _logPhase('phase3-newsai', 'error', { error: e?.message });
          console.warn('[CRON] news AI failed:', e?.message);
        }
      }

    }).catch((e) => {
      console.error(JSON.stringify({ scope: 'cron-unhandled', cron: _cronTickExpr, errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 300), stack: String(e?.stack || '').slice(0, 500) }));
    }));
}

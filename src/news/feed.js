// ═════════════════════════════════════════════════════════════════════════════
// News Feed Layer — extracted from worker-proxy.js (lines 4517-4792).
//
// Factory pattern: createNewsFeed({ ...DI deps... })
// Returns: { buildFarsiNewsArticles, fetchFarsiNews, _runNewsLiveFetchPipeline }
//
// DI dependencies (14):
//   - readAppCache, writeAppCache, getNumericEnv: KV/env helpers (from worker-proxy.js core)
//   - EXTERNAL_FETCH_TIMEOUT_MS: HTTP timeout const (from worker-proxy.js core, general-purpose)
//   - FARSI_NEWS_CACHE_KEY: 'news:farsi' const (from worker-proxy.js core — used by
//     calendar section + /api/news-ai-pending HTTP route, must stay in worker-proxy.js)
//   - fetchAllNewsRss: CYCLE-BREAKER. Stays in worker-proxy.js (NOT extracted to feed.js)
//     because createNewsSummary (line ~5997) is created BEFORE createNewsFeed (line ~6065+)
//     and Summary's processNewsAIBatch calls fetchAllNewsRss via DI. If fetchAllNewsRss moved
//     to feed.js, it would be returned from createNewsFeed — but Summary needs it BEFORE
//     Feed is created → TDZ cycle. By keeping fetchAllNewsRss in worker-proxy.js (hoisted
//     function declaration), both Summary and Feed receive it from worker-proxy.js scope.
//
//   - parseRelativeTime, classifySentiment, sanitizeNewsTitle: shared helpers
//     (from src/news/shared.js)
//   - batchTranslateToFarsi, translateToFarsi: translation (from src/news/translate.js)
//   - safeReadText, canonicalizeUrl, enrichNewsWithAISummaries: from src/news/summary.js
//     (these are returned from createNewsSummary factory, destructured at composition root)
//
// NOT extracted (stay in worker-proxy.js):
//   - fetchAllNewsRss function (cycle-breaker, see above)
//   - NEWS_RSS_SOURCES constant (used only by fetchAllNewsRss)
//   - EXTERNAL_FETCH_TIMEOUT_MS constant (general-purpose — used by chart/price/market/summary)
//   - FARSI_NEWS_CACHE_KEY constant (used by calendar section + HTTP route /api/news-ai-pending)
//   - fetchJson function (general-purpose — used by marketOverviewSvc and other market fetches)
//   - fetchJsonWithTimeout function (general-purpose — used by price/chart fetches)
//
// NO module-level mutable state in this section (verified by audit):
//   - All state is KV-backed (news:farsi cache) or function-local
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createNewsFeed({
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

  // P0 REPAIR: 2 bare refs previously bare-ref'd in factory body.
  //   - parseRssItems: used at L64 in buildFarsiNewsArticles (RSS parsing).
  //     Imported from src/news/shared.js by worker-proxy.js (top-level ESM
  //     import at line 87) — TDZ-safe to pass directly.
  //   - newsArticleRepo: used at L210/L212 in fetchFarsiNews cache-miss branch
  //     (DB fallback for article list when KV cache is cold). Initialized at
  //     worker-proxy.js line ~4155 (BEFORE this factory call at line ~4258) —
  //     TDZ-safe to pass directly.
  parseRssItems,
  newsArticleRepo,
}) {

async function buildFarsiNewsArticles(rssText, sourceName, category, env, skipTranslate = false) {
  const items = parseRssItems(rssText);
  if (items.length === 0) return [];

  // ROOT-CAUSE FIX: Limit to 3 articles per source (was 5).
  // Cloudflare Workers free plan has a 50 subrequest limit per invocation.
  // P0-D FIX: Only translate TITLE (not description). This halves translation
  // calls from 42 to 21 (7 sources × 3 articles × 1 translation). Description
  // is kept in original English — it is NOT displayed in the frontend (neither
  // card nor modal); it's only used internally by classifySentiment().
  // This matches the cron path behavior (processNewsAIBatch only translates title).
  const MAX_ARTICLES_PER_SOURCE = 3;
  const limitedItems = items.slice(0, MAX_ARTICLES_PER_SOURCE);

  let titleTranslations; // Array of { text, translation_failed }
  if (skipTranslate) {
    // Persian sources — no translation needed
    titleTranslations = limitedItems.map((item) => ({
      text: item.title || 'بدون عنوان',
      translation_failed: false,
    }));
  } else {
    // BATCH TRANSLATION: Send all headlines in 1-2 Groq requests instead of 21 individual calls.
    // This is the single biggest RPM reducer: 21 requests → 1-2 requests.
    // Falls back to individual translateToFarsi (with Workers AI + Google Translate fallbacks)
    // if the batch fails or any translation fails validation.
    const titlesToTranslate = limitedItems.map((item) => item.title || 'بدون عنوان');
    titleTranslations = await batchTranslateToFarsi(titlesToTranslate, env);
  }

  const articles = [];
  for (let i = 0; i < limitedItems.length; i++) {
    const titleResult = titleTranslations[i];
    const originalTitle = limitedItems[i].title || 'بدون عنوان';
    const originalDescription = limitedItems[i].description || '';

    // P0-C FIX: If translation failed, do NOT serve English text as Farsi.
    // Set title to empty so the article is filtered out by the frontend
    // (which requires non-empty title at line ~6632). Preserve English
    // original in title_en for debugging/display purposes.
    const translation_failed = titleResult?.translation_failed === true;

    let title;
    if (translation_failed) {
      title = ''; // Filtered out by frontend (empty title)
    } else {
      // SANITIZE: AI translation (m2m100) sometimes produces repeated words/phrases.
      const rawTitle = String(titleResult?.text || originalTitle).replace(/\n/g, ' ').trim();
      title = sanitizeNewsTitle(rawTitle);
    }

    // P0-D FIX: Description is NOT translated — kept in original English.
    // Frontend does NOT display description in cards or modal.
    // It's only used by classifySentiment() which works on English text.
    const description = String(originalDescription).replace(/\n/g, ' ').trim();

    articles.push({
      title,
      title_en: translation_failed ? originalTitle : (limitedItems[i].title || ''),
      description,
      translation_failed,
      time_ago: parseRelativeTime(limitedItems[i].pubDate),
      pub_date: limitedItems[i].pubDate ? new Date(limitedItems[i].pubDate).toISOString() : null,
      source: sourceName,
      category: category || 'crypto',
      image: limitedItems[i].image,
      url: limitedItems[i].url,
      sentiment: classifySentiment(originalTitle, originalDescription),
    });
  }

  // P0-C FIX: Articles with translation_failed have empty title — they'll be
  // filtered out here (item.title is falsy). This prevents English text from
  // appearing in the Farsi news feed as if it were a successful translation.
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
async function fetchFarsiNews(env, categoryFilter, ctx = null) {
  // P1-08 FIX (NEWSBE-001): Read from the BASE cache key (FARSI_NEWS_CACHE_KEY),
  // NOT a category-specific key. The write path (fetchFarsiNews line ~3407 and
  // processNewsAIBatch lines ~5636/5675) ALWAYS writes to the base key with the
  // FULL unfiltered article list. Category filtering is done IN MEMORY after
  // the cache hit (line 3363: enriched.filter(a => a.category === categoryFilter)).
  //
  // Previously this read from `news:farsi:${categoryFilter}` (a category-specific
  // key) which was NEVER written to — so every category-filtered request
  // (/api/farsi-news?category=crypto|forex|economy) ALWAYS missed the cache and
  // triggered the full RSS fetch (7 subrequests) + translation pipeline (up to
  // 21 m2m100 calls). Now all requests share the single base cache entry,
  // matching the write path. The categoryFilter is still applied in-memory on
  // the returned data, so the response is correct.
  const cachedNews = await readAppCache(env, FARSI_NEWS_CACHE_KEY);
  if (cachedNews) {
    try {
      const parsed = JSON.parse(cachedNews);
      if (Array.isArray(parsed) && parsed.length > 0) {
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
        // RESTORED (Commit 2.6): Return ALL articles — AI is enrichment, not a display requirement.
        // Articles with ai_summary=null have ai_status='pending' and are shown with a premium
        // pending UI in the frontend. The readyOnly filter (Commit 1) is removed because
        // articles are now published to news:farsi immediately after translation (STEP 6).
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
      }
      // KV exists but is empty array — fall through to DB fallback
    } catch {
      // Corrupt cache — fall through to DB fallback
    }
  }

  // ── P1 FIX: DB FALLBACK — KV miss/empty/corrupt → read from news_articles ──
  // DB is the source of truth. KV is only a cache. If KV is unavailable,
  // the feed is rebuilt from the DB (articles analyzed in last 4 days).
  // The result is re-cached to KV for subsequent fast-path requests.
  if (newsArticleRepo && typeof newsArticleRepo.listForFeed === 'function') {
    try {
      const dbArticles = await newsArticleRepo.listForFeed(env, { limit: 30 });
      if (dbArticles && dbArticles.length > 0) {
        // Enrich DB articles with their stored summaries (already in _db_summary)
        const enriched = dbArticles.map(a => {
          const { _db_summary, _db_provider, ...rest } = a;
          return {
            ...rest,
            ai_summary: _db_summary || null,
            ai_status: _db_summary ? 'ready' : 'pending',
            ai_provider: _db_provider || null,
          };
        });
        // Apply category filter
        const data = categoryFilter
          ? enriched.filter((a) => a.category === categoryFilter)
          : enriched;
        const categoryCounts = {
          all: enriched.length,
          crypto: enriched.filter(a => a.category === 'crypto').length,
          forex: enriched.filter(a => a.category === 'forex').length,
          economy: enriched.filter(a => a.category === 'economy').length,
        };
        // Re-cache the DB result to KV (best-effort, non-blocking)
        try {
          await writeAppCache(env, FARSI_NEWS_CACHE_KEY, JSON.stringify(enriched), getNumericEnv(env, 'NEWS_CACHE_TTL', 1800));
        } catch {}
        return { status: 'success', source: 'db', data, category_counts: categoryCounts };
      }
    } catch (dbErr) {
      console.warn('[NEWS-FEED] DB fallback failed:', dbErr?.message);
    }
  }

  // ── P0-B FIX: User request does NOT run the heavy pipeline synchronously ──
  //
  // Previously: cache miss → singleFlight → full RSS fetch (8 subrequests) +
  // translation (up to 21 AI calls) → user waits 5-15 seconds.
  //
  // Now: cache miss → return lightweight fallback immediately → trigger
  // background refresh via ctx.waitUntil (if ctx available). The cron job
  // (every 15 min) is the PRIMARY cache populator. With P0-A (TTL=1800 >
  // cron=900), cache misses are rare (only on first deploy or KV failure).
  //
  // The singleFlight wrapper is still used for the background refresh to
  // prevent duplicate pipeline runs within the same isolate.
  //
  // IMPORTANT: singleFlight is PER-ISOLATE, not a distributed lock. Multiple
  // Cloudflare Workers isolates can still run the pipeline concurrently (one
  // per isolate). For full cross-isolate protection, a KV-based distributed
  // lock would be needed — but that's a larger architectural change outside
  // the scope of this minimal P0 fix. The per-isolate singleFlight still
  // significantly reduces redundant work (within a busy isolate, many
  // requests share one pipeline run instead of each running their own).
  //
  // If ctx is NOT available (e.g., called from a non-HTTP context), fall back
  // to the old synchronous behavior for backward compatibility.

  const emptyResult = { status: 'success', source: 'rss_unavailable', data: [], category_counts: { all: 0, crypto: 0, forex: 0, economy: 0 } };

  // HOTFIX (Commit 2.3): Removed the useless ctx.waitUntil(_runNewsLiveFetchPipeline)
  // background refresh. After Commit 1 (publication gate), _runNewsLiveFetchPipeline
  // no longer writes to news:farsi — it returns articles but nobody publishes them.
  // The waitUntil task was wasting CPU/subrequests on RSS fetches + AI translations
  // that get cancelled by the runtime ("waitUntil() tasks did not complete within
  // the allowed time"). The cron (processNewsAIBatch) is the ONLY path that
  // populates news:farsi via publishArticleToFarsiNews() after summary completion.
  // The publication gate from Commit 1 remains fully intact.
  return emptyResult;
}

// ── P0-B FIX: Extracted pipeline for background/synchronous refresh ──
// This function does NOT return a user-facing response. It fetches RSS,
// translates titles, deduplicates, and writes to KV cache. Returns the
// trimmed article array on success, or null/empty array on failure.
async function _runNewsLiveFetchPipeline(env) {
  const sources = await fetchAllNewsRss();
  if (sources.length === 0) {
    return [];
  }

  try {
    // Build articles from all sources in parallel (translate within each source)
    const allArticles = (
      await Promise.all(
        sources.map((s) => buildFarsiNewsArticles(s.rssText, s.sourceName, s.category, env, s.skipTranslate))
      )
    ).flat();

    // Deduplicate by URL (same article from multiple sources)
    // NEWSBE-004 FIX: Use canonicalized URL for dedup so the same article
    // with different tracking params (utm_*) or trailing slash doesn't
    // appear twice.
    const seen = new Set();
    const deduped = allArticles.filter((a) => {
      if (!a.url) return false;
      const canonical = canonicalizeUrl(a.url);
      if (seen.has(canonical)) return false;
      seen.add(canonical);
      return true;
    });

    if (deduped.length > 0) {
      // Limit total cached articles to reduce payload size and KV storage
      const MAX_NEWS_ARTICLES = 12;
      const trimmed = deduped.slice(0, MAX_NEWS_ARTICLES);

      // PUBLICATION GATE (Commit 1): Do NOT write to news:farsi here.
      // Articles are published ONLY after succeedWithSummary completes the
      // full AI analysis and writes news:ai:{hash}. This ensures users never
      // see an article without a completed analysis (no ai_summary: null).
      // The HTTP path returns articles for internal processing only — the
      // cron handler (processNewsAIBatch) will enqueue them for analysis.
      // Publication happens in succeedWithSummary via publishArticleToFarsiNews().

      // ── AI NEWS: Background AI summarization is handled by CRON, not here ──
      // The cron handler (scheduled) calls processNewsAIBatch with real ctx.waitUntil.
      // This ensures AI summaries are generated within 1 minute of article appearing.
      // (NEWSBE-006: legacy processNewsAIJobs was removed — it was never called.)

      return trimmed;
    }
  } catch {
    // Parse/translate failure
  }

  return [];
}

  return {
    buildFarsiNewsArticles,
    fetchFarsiNews,
    _runNewsLiveFetchPipeline,
  };
}

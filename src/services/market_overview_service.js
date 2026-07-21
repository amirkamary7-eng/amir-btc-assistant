/**
 * Market Overview Service — CoinMarketCap Integration
 *
 * ALL CoinMarketCap API calls are centralized here.
 * No other route or module may call CMC directly.
 *
 * Endpoints used:
 *   1. /v1/global-metrics/quotes/latest  (30 credits/call)
 *   2. /v2/cryptocurrency/fear-and-greed/latest (30 credits/call)
 *   3. /v1/key-info                      (0 credits, usage monitoring)
 *
 * Credit budget: <6000/month → 15-min cron = 96 refreshes/day * 60 credits = 5760/month ✅
 */

const CACHE_KEY = 'market:overview:cmc';
const USAGE_LOG_KEY = 'market:overview:usage_log';
const CACHE_TTL = 900; // 15 minutes — matches cron interval

// CMC endpoint costs (credits per call)
const CMC_CREDITS = {
  globalMetrics: 30,
  fearAndGreed: 30,
  keyInfo: 0,
};

export function createMarketOverviewService(deps) {
  const { readAppCache, writeAppCache, fetchJson } = deps;

  /**
   * Fetch global metrics from CMC.
   * Returns { totalMarketCap, totalVolume, btcDominance, ethDominance, source, timestamp }
   * or null on failure.
   */
  async function fetchCMCGlobalMetrics(apiKey) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://pro-api.coinmarketcap.com/v1/global-metrics/quotes/latest', {
        headers: {
          Accept: 'application/json',
          'X-CMC_PRO_API_KEY': apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) {
        console.warn('[CMC] Global metrics failed — HTTP', res.status);
        return null;
      }
      const body = await res.json();
      const q = body?.data;
      if (!q?.quote?.USD) return null;
      return {
        totalMarketCap: q.quote.USD.total_market_cap || 0,
        totalVolume: q.quote.USD.total_volume_24h || 0,
        btcDominance: q.btc_dominance || 0,
        ethDominance: q.eth_dominance || 0,
        source: 'coinmarketcap',
        timestamp: new Date().toISOString(),
      };
    } catch (e) {
      clearTimeout(tid);
      console.warn('[CMC] Global metrics error:', e.message || e);
      return null;
    }
  }

  /**
   * Fetch Fear & Greed Index from CMC.
   * Returns { fearGreedValue, fearGreedClassification, timestamp } or null.
   */
  async function fetchCMCFearAndGreed(apiKey) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://pro-api.coinmarketcap.com/v2/cryptocurrency/fear-and-greed/latest', {
        headers: {
          Accept: 'application/json',
          'X-CMC_PRO_API_KEY': apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) {
        console.warn('[CMC] Fear & Greed failed — HTTP', res.status);
        return null;
      }
      const body = await res.json();
      const d = body?.data;
      if (!d) return null;
      return {
        fearGreedValue: d.value || 0,
        fearGreedClassification: d.value_classification || 'Neutral',
        fearGreedTimestamp: d.timestamp || null,
        source: 'coinmarketcap',
      };
    } catch (e) {
      clearTimeout(tid);
      console.warn('[CMC] Fear & Greed error:', e.message || e);
      return null;
    }
  }

  /**
   * Fetch CMC Key Info for usage monitoring (0 credits).
   * Returns { credits_used, credits_limit, reset_date } or null.
   */
  async function fetchCMCKeyInfo(apiKey) {
    const controller = new AbortController();
    const tid = setTimeout(() => controller.abort(), 10000);
    try {
      const res = await fetch('https://pro-api.coinmarketcap.com/v1/key/info', {
        headers: {
          Accept: 'application/json',
          'X-CMC_PRO_API_KEY': apiKey,
        },
        signal: controller.signal,
      });
      clearTimeout(tid);
      if (!res.ok) return null;
      const body = await res.json();
      const d = body?.data;
      if (!d) return null;
      return {
        credits_used_month: d.usage?.current_month?.credits_used || 0,
        credits_limit_month: d.plan?.credit_limit_monthly || 0,
        reset_date: d.usage?.current_month?.reset_date || null,
      };
    } catch (e) {
      clearTimeout(tid);
      return null;
    }
  }

  /**
   * Log monthly API usage to KV.
   * Key format: "YYYY-MM" → { calls, credits_used, last_updated }
   */
  async function logUsage(env, endpointName, creditsUsed) {
    try {
      const monthKey = new Date().toISOString().slice(0, 7); // "2026-07"
      const logKey = `${USAGE_LOG_KEY}:${monthKey}`;
      const raw = await readAppCache(env, logKey);
      let entry = { calls: 0, credits_used: 0, last_updated: null };
      if (raw) {
        try { entry = JSON.parse(raw); } catch {}
      }
      entry.calls += 1;
      entry.credits_used += creditsUsed;
      entry.last_updated = new Date().toISOString();
      await writeAppCache(env, logKey, JSON.stringify(entry), 86400 * 35); // ~35 days
    } catch (e) {
      console.warn('[CMC] Usage log failed:', e.message || e);
    }
  }

  /**
   * Get cached overview data. Returns parsed object or null.
   */
  async function getCachedOverview(env) {
    try {
      const raw = await readAppCache(env, CACHE_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        if (parsed && (parsed.totalMarketCap > 0 || parsed.fearGreedValue > 0)) {
          return parsed;
        }
      }
    } catch {}
    return null;
  }

  /**
   * Get current month's usage log.
   */
  async function getUsageLog(env) {
    try {
      const monthKey = new Date().toISOString().slice(0, 7);
      const logKey = `${USAGE_LOG_KEY}:${monthKey}`;
      const raw = await readAppCache(env, logKey);
      if (raw) return JSON.parse(raw);
    } catch {}
    return { calls: 0, credits_used: 0, last_updated: null };
  }

  /**
   * Refresh market overview data from CMC.
   * Called by cron job every 15 minutes.
   * Only overwrites cache if new data is valid.
   * Preserves last good cache on failure.
   *
   * Returns { success, source, credits_used }
   */
  async function refreshOverview(env) {
    const apiKey = env.CMC_API_KEY;
    if (!apiKey) {
      return { success: false, source: null, credits_used: 0, error: 'no_api_key' };
    }

    let totalCredits = 0;

    // Only fetch global metrics from CMC — F&G is fetched from Alternative.me
    // in fetchGlobalStats() (worker-proxy.js). CMC does not have a F&G endpoint.
    const metrics = await fetchCMCGlobalMetrics(apiKey);

    if (metrics) {
      totalCredits += CMC_CREDITS.globalMetrics;
    }

    // Log usage
    await logUsage(env, 'refresh', totalCredits);

    if (metrics) {
      const merged = {
        ...metrics,
        source: 'coinmarketcap',
      };

      // Only overwrite cache with valid data
      if (merged.totalMarketCap > 0) {
        await writeAppCache(env, CACHE_KEY, JSON.stringify(merged), CACHE_TTL);
      }

      return { success: true, source: merged.source, credits_used: totalCredits };
    }

    return { success: false, source: null, credits_used: 0, error: 'metrics_failed' };
  }

  return Object.freeze({
    getCachedOverview,
    getUsageLog,
    refreshOverview,
    fetchCMCKeyInfo,
  });
}
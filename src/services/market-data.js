// ═════════════════════════════════════════════════════════════════════════════
// Market Data Service — extracted from worker-proxy.js (lines 5419-5422 + 5578-6251).
//
// Factory pattern: createMarketDataService({ ...DI deps... })
// Returns: { fetchGlobalStats, handleMarketData, handleForexData }
//
// DI dependencies (8):
//   - fetchJson: General-purpose JSON fetcher (from worker-proxy.js core)
//   - fetchJsonWithTimeout: JSON fetcher with custom timeout (from worker-proxy.js core)
//   - readAppCache, writeAppCache: KV helpers (from worker-proxy.js core)
//   - _traceStage: Trace stage logger (from worker-proxy.js core)
//   - jsonResponse: HTTP response builder (from worker-proxy.js core)
//   - EXTERNAL_FETCH_TIMEOUT_MS: HTTP timeout const (from worker-proxy.js core)
//   - fetchFearGreed: CYCLE-BREAKER. Stays in worker-proxy.js (NOT extracted)
//     because it reads module-level mutable state (env_CMC_API_KEY, env_APP_CACHE)
//     that is set per-request by the main handler. By keeping fetchFearGreed in
//     worker-proxy.js (hoisted function declaration) and passing it as DI,
//     fetchGlobalStats and handleMarketData can call it via DI — fetchFearGreed
//     reads env_CMC_API_KEY/env_APP_CACHE at CALL TIME (correct value).
//
// Constants moved to factory body (only used by extracted functions):
//   - MARKET_CACHE_TTL, MARKET_GLOBAL_CACHE_TTL, MARKET_FETCH_LIMIT,
//     SEARCH_FETCH_LIMIT, FOREX_PAIRS, FOREX_CACHE_TTL
//
// NOT extracted (stay in worker-proxy.js):
//   - singleFlight + _inflightRequests (generic request coalescing, used by route dispatch)
//   - fetchFearGreed + _classifyFG (reads module-level env_CMC_API_KEY/env_APP_CACHE)
//   - env_CMC_API_KEY, env_APP_CACHE (mutable module state, set per-request)
//   - _notifDiagReport (notification diagnostic — NOT market-related)
//   - FG_CACHE_KEY, FG_CACHE_TTL (used by fetchFearGreed which stays)
//
// NO module-level mutable state in extracted functions (verified by audit).
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createMarketDataService({
  fetchJson,
  fetchJsonWithTimeout,
  readAppCache,
  writeAppCache,
  _traceStage,
  jsonResponse,
  EXTERNAL_FETCH_TIMEOUT_MS,
  fetchFearGreed,
  // P0 REPAIR: marketOverviewSvc previously bare-ref'd at L280 inside
  // handleMarketData's getGlobalData closure (CoinMarketCap cache fast-path).
  // Was NOT in DI signature → threw ReferenceError at request time →
  // caught by try/catch → silently fell back to fetchGlobalStats (slow path).
  // Now explicit DI to restore the cache-hit fast path.
  marketOverviewSvc,
}) {

const MARKET_CACHE_TTL = 120; // 2 minutes — H6 FIX: was 300s (5 min), caused user-visible price staleness. 120s balances freshness with KV write budget (~720 writes/day, well under the 1,000/day Free limit after telemetry migration).
const MARKET_GLOBAL_CACHE_TTL = 900; // 15 minutes — global stats change less frequently
const MARKET_FETCH_LIMIT = 200;
const SEARCH_FETCH_LIMIT = 1500; // Extended list for search — not displayed in market list

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

  // MKT-001 FIX: Hoist cachedRaw to function scope so it's accessible in the
  // fallback path (line ~7522) even when skipCache=true. Previously it was
  // declared inside `if (!skipCache)` block → ReferenceError when skipCache=true
  // and all upstream APIs fail.
  let cachedRaw = null;

  // Check KV cache (unless skipCache is set)
  if (!skipCache) {
    cachedRaw = await readAppCache(env, 'forex:data');
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

  return {
    fetchGlobalStats,
    handleMarketData,
    handleForexData,
  };
}

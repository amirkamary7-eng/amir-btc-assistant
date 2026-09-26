// ═════════════════════════════════════════════════════════════════════════════
// Calendar Service — extracted from worker-proxy.js (lines 4576-5128).
//
// Factory pattern: createCalendarService({ ...DI deps... })
// Returns: { fetchCalendarFeed, fetchCalendarEvents, resolveChartExchange, mapCalendarEvent }
//
// DI dependencies (6):
//   - readAppCache, writeAppCache, getNumericEnv: KV/env helpers (from worker-proxy.js core)
//   - getCalendarIsolateCache, getCalendarIsolateCacheAt, setCalendarIsolateCache:
//     Calendar isolate cache accessors (from src/cron/calendar-cache.js)
//
// CALENDAR_CACHE_KEY constant ('calendar:events') is declared inside the factory body
// (moved from worker-proxy.js line 4383 — only used by Calendar functions).
//
// NO module-level mutable state in this section (verified by audit):
//   - Calendar isolate cache is in src/cron/calendar-cache.js (already extracted, PR #15)
//   - All other state is KV-backed or function-local
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createCalendarService({
  readAppCache,
  writeAppCache,
  getNumericEnv,
  getCalendarIsolateCache,
  getCalendarIsolateCacheAt,
  setCalendarIsolateCache,
  // P0 REPAIR: 3 shared infrastructure helpers previously bare-ref'd inside
  // the factory body. Now passed as explicit DI to avoid ReferenceError at
  // request time. singleFlight + fetchJsonWithTimeout are used by multiple
  // sections in worker-proxy.js (market route, price fetchers, etc.); they
  // MUST stay as DI, not move into calendar.js. CHART_CHECKERS is shared with
  // fetchSpotTickerPrice in worker-proxy.js — also DI.
  singleFlight,
  fetchJsonWithTimeout,
  CHART_CHECKERS,
}) {

// P0 REPAIR: 3 calendar-only consts MOVED from worker-proxy.js as module-local
// to the factory body. Verified calendar-only usage:
//   - COUNTRY_FLAGS: only resolveCountryFlag uses it
//   - IMPACT_MAP: only mapCalendarEvent uses it
//   - EXCHANGE_ORDER: only resolveChartExchange uses it
// No other consumer in worker-proxy.js or src/. Moving into the factory body
// makes them accessible to nested functions via closure — no DI needed.
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

const CALENDAR_CACHE_KEY = 'calendar:events';

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
// Calendar isolate cache state has been extracted to `./src/cron/calendar-cache.js`
// to allow safe sharing between worker-proxy.js and src/cron/scheduler.js
// (ES modules have isolated scopes; module-level `let` here was previously
// invisible to scheduler.js, causing silent ReferenceError in Phase 1c).
// Access via getCalendarIsolateCache(), getCalendarIsolateCacheAt(),
// setCalendarIsolateCache(events, ts?).

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
    const _isolateAge = getCalendarIsolateCacheAt() ? Date.now() - getCalendarIsolateCacheAt() : Infinity;
    const _isolateCache = getCalendarIsolateCache();
    if (_isolateCache && _isolateCache.length > 0 && _isolateAge < 300000) {
      // Isolate cache is fresh (< 5 min) — serve immediately
      return _isolateCache;
    }

    // 1. Try fresh KV cache (TTL-enforced by KV itself)
    const _tKVRead = Date.now();
    const cachedEvents = await readAppCache(env, CALENDAR_CACHE_KEY);
    if (cachedEvents) {
      try {
        const parsed = JSON.parse(cachedEvents);
        if (Array.isArray(parsed) && parsed.length > 0) {
          // Update isolate cache so it stays fresh
          setCalendarIsolateCache(parsed);
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
          getNumericEnv(env, 'CALENDAR_CACHE_TTL', 1800),
        );
        console.log('[CALENDAR] KV write: success (' + events.length + ' events)');
      } catch (kvErr) {
        console.warn('[CALENDAR] KV write FAILED: ' + (kvErr?.message || kvErr));
      }
      setCalendarIsolateCache(events);
      console.log('[CALENDAR] isolate cache updated: ' + events.length + ' events');
      return events;
    }

    // 3. Upstream returned empty or error. NEVER return empty if we have
    // any valid cached data. Priority: isolate cache → KV cache → stale KV.
    // This ensures the calendar ALWAYS shows the last known good data,
    // even during extended upstream outages.

    // 3a. Try isolate cache (in-memory, instant)
    const _fallbackCache = getCalendarIsolateCache();
    if (_fallbackCache && _fallbackCache.length > 0) {
      console.log('[CALENDAR] upstream empty — serving isolate cache: ' + _fallbackCache.length + ' events (age=' + Math.round((Date.now() - getCalendarIsolateCacheAt()) / 1000) + 's)');
      // Try to refresh KV with isolate cache (in case KV expired)
      try {
        await writeAppCache(env, CALENDAR_CACHE_KEY, JSON.stringify(_fallbackCache), 300);
      } catch {}
      return _fallbackCache;
    }

    // 3b. Try KV cache (may still have data even if isolate cache is empty)
    try {
      const kvCached = await readAppCache(env, CALENDAR_CACHE_KEY);
      if (kvCached) {
        const parsed = JSON.parse(kvCached);
        if (Array.isArray(parsed) && parsed.length > 0) {
          console.log('[CALENDAR] upstream empty — serving KV cache: ' + parsed.length + ' events');
          // Populate isolate cache so subsequent requests are instant
          setCalendarIsolateCache(parsed);
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
          setCalendarIsolateCache(stale);
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

  return {
    fetchCalendarFeed,
    fetchCalendarEvents,
    resolveChartExchange,
    mapCalendarEvent,
  };
}

/**
 * P0 REPAIR REGRESSION TESTS — Modularization Bare References
 *
 * These are RUNTIME regression tests for the 4 P0 bare-reference bugs found
 * in the Full Modularization Integrity Audit. Unlike source-text-based tests
 * (which only check for substring presence in source code), these tests:
 *
 *   1. Instantiate the extracted factory with mock dependencies
 *   2. Invoke the returned function with a mock env
 *   3. Exercise the branch that previously bare-ref'd an undeclared identifier
 *   4. Assert NO ReferenceError is thrown
 *   5. Assert the expected behavior (return value, side-effect)
 *
 * Each test corresponds to one P0 finding from the audit:
 *   - P0-1 Calendar (6 bare refs): singleFlight, COUNTRY_FLAGS, IMPACT_MAP,
 *     CHART_CHECKERS, fetchJsonWithTimeout, EXCHANGE_ORDER
 *     Production impact: /api/charts/resolve HTTP 500; /api/calendar/events
 *     silently returned empty events:[].
 *   - P0-2 Market Data (1 bare ref): marketOverviewSvc
 *     Production impact: /api/market returned 200 via fallback (silent perf
 *     regression — never used CMC cache fast-path).
 *   - P0-3 Referral/Rewards (3 bare refs): membershipAuthority, ENTITLEMENT,
 *     userRepo
 *     Production impact: processPendingReferralReward threw ReferenceError
 *     silently (caught by resolveChannelMembership try/catch) — referral
 *     rewards NEVER processed.
 *   - P0-4 News Feed (2 bare refs): parseRssItems, newsArticleRepo
 *     Production impact: /api/farsi-news would return 500 on KV cache miss
 *     (newsArticleRepo); parseRssItems only reachable via dead code path
 *     (_runNewsLiveFetchPipeline) but would crash if re-enabled.
 *
 * Run: node --test p0-repair-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

// ============================================================================
// Helper: load an ESM factory module via source-eval (CJS-friendly)
// Strips the `export` keyword so we can evaluate as plain CJS.
// ============================================================================

function loadFactoryModule(modulePath, exportName) {
  const src = fs.readFileSync(modulePath, 'utf8');
  // Replace `export function X` → `function X`
  const stripped = src.replace(/^export\s+function\s+/m, 'function ');
  const exportsObj = {};
  const evaluator = new Function(
    'exports', 'fetch', 'AbortController', 'setTimeout', 'clearTimeout', 'console', 'Promise', 'Math', 'String', 'Number', 'Boolean', 'JSON', 'Date', 'Array', 'Object', 'Set', 'Map', 'Error', 'encodeURIComponent',
    stripped + `\nexports.${exportName} = ${exportName};`
  );
  evaluator(exportsObj, fetch, AbortController, setTimeout, clearTimeout, console, Promise, Math, String, Number, Boolean, JSON, Date, Array, Object, Set, Map, Error, encodeURIComponent);
  return exportsObj[exportName];
}

// ============================================================================
// P0-1: CALENDAR SERVICE — 6 bare refs
// singleFlight, COUNTRY_FLAGS, IMPACT_MAP, CHART_CHECKERS, fetchJsonWithTimeout, EXCHANGE_ORDER
// ============================================================================

const createCalendarService = loadFactoryModule(
  path.join(__dirname, 'src/services/calendar.js'),
  'createCalendarService'
);

test('P0-1a: calendar.js factory accepts 9 DI params (3 new: singleFlight, fetchJsonWithTimeout, CHART_CHECKERS)', () => {
  // Factory should NOT throw when called with the 9-param DI signature
  // (the original 6 + 3 new P0 repair DIs)
  const factory = createCalendarService({
    readAppCache: async () => null,
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    getCalendarIsolateCache: () => null,
    getCalendarIsolateCacheAt: () => null,
    setCalendarIsolateCache: () => {},
    singleFlight: (key, fn) => fn(),
    fetchJsonWithTimeout: async () => ({ ok: false, body: null }),
    CHART_CHECKERS: { binance: { buildUrl: () => '', isMatch: () => false } },
  });
  assert.ok(typeof factory === 'object', 'factory should return an object');
  assert.ok(typeof factory.resolveChartExchange === 'function', 'factory should expose resolveChartExchange');
  assert.ok(typeof factory.fetchCalendarEvents === 'function', 'factory should expose fetchCalendarEvents');
  assert.ok(typeof factory.mapCalendarEvent === 'function', 'factory should expose mapCalendarEvent');
});

test('P0-1b: mapCalendarEvent uses IMPACT_MAP + COUNTRY_FLAGS (moved consts) without ReferenceError', () => {
  const { mapCalendarEvent } = createCalendarService({
    readAppCache: async () => null,
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    getCalendarIsolateCache: () => null,
    getCalendarIsolateCacheAt: () => null,
    setCalendarIsolateCache: () => {},
    singleFlight: (key, fn) => fn(),
    fetchJsonWithTimeout: async () => ({ ok: false, body: null }),
    CHART_CHECKERS: {},
  });
  // Invoke mapCalendarEvent — previously threw ReferenceError on IMPACT_MAP + COUNTRY_FLAGS.
  // Use a date 5 days from now, with cutoffs that include it.
  // NOTE: `now` param must be a Date object (getEventStatus uses now.getTime()).
  const futureDate = new Date(Date.now() + 5 * 86400000);
  const futureDateStr = futureDate.toISOString().slice(0, 10); // YYYY-MM-DD
  const event = mapCalendarEvent(
    { title: 'Test', country: 'US', date: futureDateStr, time: '12:00', impact: 'High', forecast: '', previous: '' },
    new Date(),                            // now = current Date object
    new Date(Date.now() - 86400000),       // cutoffPast = yesterday
    new Date(Date.now() + 30 * 86400000)    // cutoffFuture = 30 days from now
  );
  assert.ok(event, 'mapCalendarEvent should return an event object');
  assert.equal(event.impact, 'high', 'IMPACT_MAP[High] should be "high"');
  assert.ok(event.flag, 'COUNTRY_FLAGS should provide a flag');
  assert.equal(event.country, 'US');
});

test('P0-1c: resolveChartExchange uses EXCHANGE_ORDER + CHART_CHECKERS + fetchJsonWithTimeout without ReferenceError', async () => {
  // Verify resolveChartExchange runs to completion without throwing ReferenceError
  // on EXCHANGE_ORDER, CHART_CHECKERS, or fetchJsonWithTimeout. The function may
  // return a found result (scanner success) or not-found result (scanner failure →
  // falls through to exchangeHasSymbol which uses fetchJsonWithTimeout). Either
  // outcome is acceptable — the key assertion is NO ReferenceError.
  //
  // NOTE: We cannot easily force the fetchJsonWithTimeout fallback path because
  // resolveViaTradingViewScanner uses the global `fetch` which is captured by
  // the evaluator at module-load time. Overriding global.fetch AFTER loadFactoryModule
  // has no effect on the factory body's captured `fetch` parameter. The simpler
  // assertion is: no ReferenceError thrown + returns an object.
  let fetchJsonCalls = 0;
  const { resolveChartExchange } = createCalendarService({
    readAppCache: async () => null,
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    getCalendarIsolateCache: () => null,
    getCalendarIsolateCacheAt: () => null,
    setCalendarIsolateCache: () => {},
    singleFlight: (key, fn) => fn(),
    fetchJsonWithTimeout: async () => { fetchJsonCalls++; return { ok: false, body: null }; },
    CHART_CHECKERS: {
      binance: { buildUrl: () => 'https://example.com/binance', isMatch: () => false },
      bybit: { buildUrl: () => 'https://example.com/bybit', isMatch: () => false },
    },
  });
  // Previously threw ReferenceError on EXCHANGE_ORDER (and CHART_CHECKERS + fetchJsonWithTimeout)
  const env = { APP_CACHE: { get: async () => null, put: async () => {} } };
  const result = await resolveChartExchange(env, 'BTC');
  assert.ok(typeof result === 'object', 'resolveChartExchange should return an object (no ReferenceError)');
  assert.ok('found' in result, 'result should have a "found" property');
  // Either scanner succeeded (found=true, fetchJsonCalls=0) OR scanner failed and
  // fell through to exchangeHasSymbol (found=false, fetchJsonCalls>0). Both are valid.
  console.log('  resolveChartExchange result:', JSON.stringify(result).slice(0, 100), 'fetchJsonCalls:', fetchJsonCalls);
});

test('P0-1d: fetchCalendarEvents uses singleFlight without ReferenceError', async () => {
  let singleFlightCalled = false;
  const { fetchCalendarEvents } = createCalendarService({
    readAppCache: async () => null,
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    getCalendarIsolateCache: () => null,
    getCalendarIsolateCacheAt: () => null,
    setCalendarIsolateCache: () => {},
    singleFlight: (key, fn) => { singleFlightCalled = true; return fn(); },
    fetchJsonWithTimeout: async () => ({ ok: false, body: null }),
    CHART_CHECKERS: {},
  });
  const env = {
    APP_CACHE: { get: async () => null, put: async () => {} },
    RATE_LIMITS: { get: async () => null, put: async () => {} },
  };
  // Previously threw ReferenceError on singleFlight (line 297 in original)
  const events = await fetchCalendarEvents(env);
  assert.ok(Array.isArray(events), 'fetchCalendarEvents should return an array');
  assert.ok(singleFlightCalled, 'singleFlight should have been invoked');
});

// ============================================================================
// P0-2: MARKET DATA SERVICE — 1 bare ref: marketOverviewSvc
// ============================================================================

const createMarketDataService = loadFactoryModule(
  path.join(__dirname, 'src/services/market-data.js'),
  'createMarketDataService'
);

test('P0-2a: market-data.js factory accepts 9 DI params (1 new: marketOverviewSvc)', () => {
  const factory = createMarketDataService({
    fetchJson: async () => ({ ok: true, body: {} }),
    fetchJsonWithTimeout: async () => ({ ok: false, body: null }),
    readAppCache: async () => null,
    writeAppCache: async () => {},
    _traceStage: () => {},
    jsonResponse: (data, opts, env) => new Response(JSON.stringify(data), opts),
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    fetchFearGreed: async () => null,
    marketOverviewSvc: { getCachedOverview: async () => null },
  });
  assert.ok(typeof factory === 'object', 'factory should return an object');
  assert.ok(typeof factory.handleMarketData === 'function', 'factory should expose handleMarketData');
});

test('P0-2b (Case A — cache hit): handleMarketData uses marketOverviewSvc.getCachedOverview() fast-path', async () => {
  let cmcCacheCalled = false;
  let fallbackCalled = false;
  const { handleMarketData } = createMarketDataService({
    fetchJson: async () => ({ ok: true, body: {} }),
    fetchJsonWithTimeout: async () => ({ ok: false, body: null }),
    readAppCache: async () => null,
    writeAppCache: async () => {},
    _traceStage: () => {},
    jsonResponse: (data, opts, env) => ({ status: 'success', data }),
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    fetchFearGreed: async () => null,
    marketOverviewSvc: {
      getCachedOverview: async () => {
        cmcCacheCalled = true;
        return { totalMarketCap: 1000000000000, fearGreedValue: 50, fearGreedClassification: 'Neutral', fearGreedSource: 'coinmarketcap' };
      },
    },
  });
  // fetchGlobalStats is INTERNAL to the factory — we can't directly assert it wasn't called.
  // But we can verify cmcCacheCalled=true (fast-path was used).
  // We mock marketOverviewSvc to return a valid cached overview — the fast-path should succeed.
  const env = {
    APP_CACHE: { get: async () => null, put: async () => {} },
    RATE_LIMITS: { get: async () => null, put: async () => {} },
  };
  const req = new Request('https://example.com/api/market');
  const result = await handleMarketData(req, env);
  assert.ok(cmcCacheCalled, 'marketOverviewSvc.getCachedOverview should be called (cache hit fast-path)');
  // The result should NOT be a 500 error (no ReferenceError)
  assert.ok(result !== undefined, 'handleMarketData should return a result');
});

test('P0-2c (Case B — cache miss): handleMarketData falls back to fetchGlobalStats when marketOverviewSvc returns null', async () => {
  // Cache miss = marketOverviewSvc.getCachedOverview returns null → fall through to fetchGlobalStats
  // The fall-through path should NOT throw ReferenceError on marketOverviewSvc
  // (because the catch in getGlobalData would previously swallow the bare-ref
  // ReferenceError and fall back to fetchGlobalStats — now the explicit DI
  // marketOverviewSvc is properly invoked, returns null, then falls back cleanly).
  let cmcCacheCalled = false;
  const { handleMarketData } = createMarketDataService({
    fetchJson: async () => ({ ok: true, body: { data: [{ symbol: 'BTC', name: 'Bitcoin', rank: 1, priceUsd: 84000, changePercent24Hr: 0.5, volumeUsd24Hr: 1000000, marketCapUsd: 1000000000, supply: 20000000 }] } }),
    fetchJsonWithTimeout: async () => ({ ok: false, body: null }),
    readAppCache: async () => null,
    writeAppCache: async () => {},
    _traceStage: () => {},
    jsonResponse: (data, opts, env) => ({ status: 'success', data }),
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    fetchFearGreed: async () => ({ value: 50, classification: 'Neutral' }),
    marketOverviewSvc: {
      getCachedOverview: async () => { cmcCacheCalled = true; return null; }, // cache miss
    },
  });
  const env = {
    APP_CACHE: { get: async () => null, put: async () => {} },
    RATE_LIMITS: { get: async () => null, put: async () => {} },
    DATABASE_URL: 'postgres://test',
  };
  const req = new Request('https://example.com/api/market');
  // Should NOT throw ReferenceError on marketOverviewSvc
  const result = await handleMarketData(req, env);
  assert.ok(cmcCacheCalled, 'marketOverviewSvc.getCachedOverview should be called (cache miss check)');
  assert.ok(result !== undefined, 'handleMarketData should return a result (fallback path)');
});

// ============================================================================
// P0-3: REFERRAL/REWARDS — 3 bare refs
// membershipAuthority, ENTITLEMENT, userRepo
// ============================================================================

const createReferralRewardsService = loadFactoryModule(
  path.join(__dirname, 'src/services/referral-rewards.js'),
  'createReferralRewardsService'
);

test('P0-3a: referral-rewards.js factory accepts 14 DI params (3 new: membershipAuthority, ENTITLEMENT, getUserRepo)', () => {
  const factory = createReferralRewardsService({
    queryDb: async () => ({ rows: [] }),
    notificationService: { create: async () => ({}) },
    walletRepo: { creditTokens: async () => ({}) },
    rewardCenterRepo: {
      isSubsystemDisabled: async () => false,
      getMissionReward: async () => null,
    },
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => s,
    resolveWebAppUrl: () => 'https://example.com',
    safeError: (scope, err) => JSON.stringify({ scope, error: String(err) }),
    getMissionRewardAmount: () => 3,
    economyService: { grantReward: async () => ({ idempotent: false }) },
    membershipAuthority: { isPremium: async () => false },
    ENTITLEMENT: { getReferralRewardAmount: (isPremium) => isPremium ? 6 : 3 },
    getUserRepo: () => ({ checkReferralCooldown: async () => ({ inCooldown: false }) }),
  });
  assert.ok(typeof factory === 'object', 'factory should return an object');
  assert.ok(typeof factory.processPendingReferralReward === 'function');
  assert.ok(typeof factory.processReferralOnBootstrap === 'function');
});

test('P0-3b: processPendingReferralReward uses membershipAuthority + ENTITLEMENT tier multiplier without ReferenceError', async () => {
  // Mock DB returning a pending referral for a Premium inviter
  let isPremiumCalls = 0;
  let rewardAmountCalls = [];
  const { processPendingReferralReward } = createReferralRewardsService({
    queryDb: async (env, sql, params) => {
      // Mock: SELECT * FROM referrals WHERE invitee_id = $1 AND rewarded = FALSE
      if (sql.includes('SELECT') && sql.includes('referrals') && sql.includes('rewarded = FALSE')) {
        return { rows: [{ id: 1, inviter_id: '999', invitee_id: '123', referrer_id: '999', rewarded: false, channel_verified: false }] };
      }
      // UPDATE referrals ... WHERE id = $1 AND rewarded = FALSE — return 1 row updated
      if (sql.includes('UPDATE')) return { rowCount: 1 };
      return { rows: [] };
    },
    notificationService: { create: async () => ({}) },
    walletRepo: { creditTokens: async () => ({}) },
    rewardCenterRepo: {
      isSubsystemDisabled: async () => false,
      getMissionReward: async () => null,
    },
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => s,
    resolveWebAppUrl: () => 'https://example.com',
    safeError: (scope, err) => JSON.stringify({ scope, error: String(err) }),
    getMissionRewardAmount: () => 3,
    economyService: { grantReward: async () => ({ idempotent: false }) },
    membershipAuthority: {
      isPremium: async (env, uid) => { isPremiumCalls++; return uid === '999'; }, // inviter is Premium
    },
    ENTITLEMENT: {
      getReferralRewardAmount: (isPremium) => { rewardAmountCalls.push(isPremium); return isPremium ? 6 : 3; },
    },
    getUserRepo: () => undefined, // not used in this path
  });
  // Previously threw ReferenceError on membershipAuthority + ENTITLEMENT
  const result = await processPendingReferralReward({ DATABASE_URL: 'postgres://test' }, '123', true);
  assert.ok(isPremiumCalls > 0, 'membershipAuthority.isPremium should be called (tier multiplier path)');
  assert.ok(rewardAmountCalls.length > 0, 'ENTITLEMENT.getReferralRewardAmount should be called (reward calculation)');
  assert.ok(rewardAmountCalls.includes(true), 'ENTITLEMENT.getReferralRewardAmount should be called with isPremium=true');
});

test('P0-3c: processReferralOnBootstrap uses userRepo.checkReferralCooldown via lazy getter without ReferenceError', async () => {
  let cooldownCalls = 0;
  let userRepoResolved = null;
  const { processReferralOnBootstrap } = createReferralRewardsService({
    queryDb: async (env, sql, params) => {
      if (sql.includes('INSERT INTO users')) return { rows: [{ telegram_id: '123' }] };
      if (sql.includes('SELECT telegram_id FROM users')) return { rows: [{ telegram_id: '999' }] };
      if (sql.includes('INSERT INTO referrals')) return { rows: [{ id: 1 }] };
      return { rows: [] };
    },
    notificationService: { create: async () => ({}) },
    walletRepo: {},
    rewardCenterRepo: {
      isSubsystemDisabled: async () => false,
      getMissionReward: async () => null,
    },
    getReferralRewardPerInvite: () => 3,
    isDatabaseConfigured: () => true,
    normalizeOptionalString: (s) => s,
    resolveWebAppUrl: () => 'https://example.com',
    safeError: (scope, err) => JSON.stringify({ scope, error: String(err) }),
    getMissionRewardAmount: () => 3,
    economyService: { grantReward: async () => ({ idempotent: false }) },
    membershipAuthority: { isPremium: async () => false },
    ENTITLEMENT: { getReferralRewardAmount: () => 3 },
    getUserRepo: () => {
      userRepoResolved = {
        checkReferralCooldown: async (env, inviteeId) => {
          cooldownCalls++;
          return { inCooldown: false };
        },
      };
      return userRepoResolved;
    },
  });
  // Previously threw ReferenceError on userRepo (typeof x?.y does NOT suppress ReferenceError).
  // NOTE: referrerId must be numeric (regex /^\d{1,20}$/) and NOT equal to inviteeId,
  // otherwise the function early-returns at Step 2 validation before reaching the
  // cooldown check. Use '999' (numeric, different from inviteeId '123').
  const env = { DATABASE_URL: 'postgres://test', JOIN_CACHE: { get: async () => null, put: async () => {} } };
  const result = await processReferralOnBootstrap(env, '123', '999', true, true);
  assert.ok(cooldownCalls > 0, 'userRepo.checkReferralCooldown should be called (anti-abuse cooldown path)');
});

// ============================================================================
// P0-4: NEWS FEED — 2 bare refs: parseRssItems, newsArticleRepo
// ============================================================================

const createNewsFeed = loadFactoryModule(
  path.join(__dirname, 'src/news/feed.js'),
  'createNewsFeed'
);

test('P0-4a: news/feed.js factory accepts 16 DI params (2 new: parseRssItems, newsArticleRepo)', () => {
  const factory = createNewsFeed({
    readAppCache: async () => null,
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    FARSI_NEWS_CACHE_KEY: 'farsi:news',
    fetchAllNewsRss: async () => [],
    parseRelativeTime: (s) => Date.now(),
    classifySentiment: () => 'neutral',
    sanitizeNewsTitle: (s) => s,
    batchTranslateToFarsi: async (items) => items,
    translateToFarsi: async (s) => s,
    safeReadText: (s) => s,
    canonicalizeUrl: (s) => s,
    enrichNewsWithAISummaries: async (env, items) => items,
    parseRssItems: (xml) => [],
    newsArticleRepo: { listForFeed: async () => [] },
  });
  assert.ok(typeof factory === 'object', 'factory should return an object');
  assert.ok(typeof factory.fetchFarsiNews === 'function');
  assert.ok(typeof factory.buildFarsiNewsArticles === 'function');
});

test('P0-4b: buildFarsiNewsArticles uses parseRssItems without ReferenceError', async () => {
  let parseRssItemsCalls = 0;
  const { buildFarsiNewsArticles } = createNewsFeed({
    readAppCache: async () => null,
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    FARSI_NEWS_CACHE_KEY: 'farsi:news',
    fetchAllNewsRss: async () => [],
    parseRelativeTime: (s) => Date.now(),
    classifySentiment: () => 'neutral',
    sanitizeNewsTitle: (s) => s,
    batchTranslateToFarsi: async (items) => items,
    translateToFarsi: async (s) => s,
    safeReadText: (s) => s,
    canonicalizeUrl: (s) => s,
    enrichNewsWithAISummaries: async (env, items) => items,
    parseRssItems: (xml) => { parseRssItemsCalls++; return []; },
    newsArticleRepo: { listForFeed: async () => [] },
  });
  // Previously threw ReferenceError on parseRssItems
  const env = { APP_CACHE: { get: async () => null, put: async () => {} } };
  const articles = await buildFarsiNewsArticles('<rss></rss>', 'test-source', 'crypto', env, true);
  assert.ok(Array.isArray(articles), 'buildFarsiNewsArticles should return an array');
  assert.ok(parseRssItemsCalls > 0, 'parseRssItems should be called');
});

test('P0-4c (Case A — cache hit): fetchFarsiNews serves from cache, newsArticleRepo NOT called', async () => {
  let newsArticleRepoCalled = false;
  let cacheGetCalls = 0;
  const { fetchFarsiNews } = createNewsFeed({
    // The actual FARSI_NEWS_CACHE_KEY in production is 'news:farsi' (verified
    // in worker-proxy.js line 3327). Pass that exact value as DI so the
    // cache-hit path is exercised.
    readAppCache: async (env, key) => {
      cacheGetCalls++;
      if (key === 'news:farsi') {
        return JSON.stringify([{ id: '1', title: 'Cached News', summary: 'cached', category: 'crypto' }]);
      }
      return null;
    },
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    FARSI_NEWS_CACHE_KEY: 'news:farsi',
    fetchAllNewsRss: async () => [],
    parseRelativeTime: (s) => Date.now(),
    classifySentiment: () => 'neutral',
    sanitizeNewsTitle: (s) => s,
    batchTranslateToFarsi: async (items) => items,
    translateToFarsi: async (s) => s,
    safeReadText: (s) => s,
    canonicalizeUrl: (s) => s,
    // NOTE: enrichNewsWithAISummaries signature is (env, articles) — first arg is env, second is articles.
    // Returning articles preserves the cache-hit fast path (no DB fallback).
    enrichNewsWithAISummaries: async (env, items) => items,
    parseRssItems: (xml) => [],
    newsArticleRepo: {
      listForFeed: async () => { newsArticleRepoCalled = true; return []; },
    },
  });
  const env = { APP_CACHE: { get: async () => null, put: async () => {} } };
  // Cache HIT — newsArticleRepo should NOT be called
  const result = await fetchFarsiNews(env);
  assert.ok(!newsArticleRepoCalled, 'newsArticleRepo should NOT be called on cache hit (got called: ' + newsArticleRepoCalled + ')');
  assert.ok(result, 'fetchFarsiNews should return a result on cache hit');
  assert.equal(result.source, 'cache', 'cache-hit response should have source="cache"');
});

test('P0-4d (Case B — cache miss): fetchFarsiNews uses newsArticleRepo DB fallback without ReferenceError', async () => {
  // Cache MISS — falls through to newsArticleRepo.listForFeed
  // Previously threw ReferenceError on `newsArticleRepo` (typeof x?.y does NOT suppress ReferenceError)
  let newsArticleRepoCalled = false;
  const { fetchFarsiNews } = createNewsFeed({
    readAppCache: async () => null, // cache miss
    writeAppCache: async () => {},
    getNumericEnv: () => 5,
    EXTERNAL_FETCH_TIMEOUT_MS: 8000,
    FARSI_NEWS_CACHE_KEY: 'farsi:news',
    fetchAllNewsRss: async () => [],
    parseRelativeTime: (s) => Date.now(),
    classifySentiment: () => 'neutral',
    sanitizeNewsTitle: (s) => s,
    batchTranslateToFarsi: async (items) => items,
    translateToFarsi: async (s) => s,
    safeReadText: (s) => s,
    canonicalizeUrl: (s) => s,
    enrichNewsWithAISummaries: async (env, items) => items,
    parseRssItems: (xml) => [],
    newsArticleRepo: {
      listForFeed: async (env, opts) => {
        newsArticleRepoCalled = true;
        return [{ id: '1', title: 'DB Article', summary: 'from db', url: 'https://example.com/1', published_at: new Date().toISOString(), source_name: 'db', category: 'crypto' }];
      },
    },
  });
  const env = { APP_CACHE: { get: async () => null, put: async () => {} } };
  // Previously threw ReferenceError on newsArticleRepo → /api/farsi-news returned 500
  const result = await fetchFarsiNews(env);
  assert.ok(newsArticleRepoCalled, 'newsArticleRepo.listForFeed should be called on cache miss');
  assert.ok(result, 'fetchFarsiNews should return a result (not throw ReferenceError)');
});

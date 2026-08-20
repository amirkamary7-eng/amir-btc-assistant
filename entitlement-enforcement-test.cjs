/**
 * Phase 3 — Quota / Entitlement Enforcement Tests
 *
 * Tests tier-based quota enforcement for alerts, AI chat/image, wheel, watchlist.
 * Uses source-inspection pattern.
 */
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const ENT_SRC = fs.readFileSync(path.join(__dirname, 'src/services/entitlement_config.js'), 'utf8');
const ALERTS_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/alerts.js'), 'utf8');
const ASSISTANT_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/assistant.js'), 'utf8');
const WHEEL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wheel.js'), 'utf8');
const WATCH_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/watchlist.js'), 'utf8');
const ALERT_ECON_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/alert_economy.js'), 'utf8');

// Load entitlement config
function loadEntitlementConfig() {
  const cleaned = ENT_SRC
    .replace(/export\s+const\s+ENTITLEMENT_CONFIG/g, 'const ENTITLEMENT_CONFIG')
    .replace(/export\s+function\s+(\w+)/g, 'function $1');
  const exportsObj = {};
  const evaluator = new Function('exports', cleaned + `
    exports.ENTITLEMENT_CONFIG = ENTITLEMENT_CONFIG;
    exports.getAlertFreePerDay = typeof getAlertFreePerDay !== "undefined" ? getAlertFreePerDay : null;
    exports.getAiChatDailyLimit = typeof getAiChatDailyLimit !== "undefined" ? getAiChatDailyLimit : null;
    exports.getWheelDailySpins = typeof getWheelDailySpins !== "undefined" ? getWheelDailySpins : null;
    exports.getWatchlistMax = typeof getWatchlistMax !== "undefined" ? getWatchlistMax : null;
  `);
  evaluator(exportsObj);
  return exportsObj;
}
const EC = loadEntitlementConfig();

// ─── Tests: Config values ───────────────────────────────────────────────────

test('CFG-01: Alert quotas correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.alerts;
  assert.equal(c.normal_free_per_day, 3);
  assert.equal(c.premium_free_per_day, 10);
  assert.equal(c.token_cost_per_extra, 5);
});

test('CFG-02: AI chat quotas correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.ai_chat;
  assert.equal(c.normal_daily_limit, 50);
  assert.equal(c.premium_daily_limit, 100);
});

test('CFG-03: AI image quotas correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.ai_image;
  assert.equal(c.normal_daily_limit, 3);
  assert.equal(c.premium_daily_limit, 10);
});

test('CFG-04: Wheel quotas correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.wheel;
  assert.equal(c.normal_daily_spins, 3);
  assert.equal(c.premium_daily_spins, 5);
});

test('CFG-05: Watchlist quotas correct', () => {
  const c = EC.ENTITLEMENT_CONFIG.watchlist;
  assert.equal(c.normal_max, 7);
  assert.equal(c.premium_max, 20);
});

test('CFG-06: Helpers return correct per tier', () => {
  assert.equal(EC.getAlertFreePerDay(false), 3);
  assert.equal(EC.getAlertFreePerDay(true), 10);
  assert.equal(EC.getAiChatDailyLimit(false), 50);
  assert.equal(EC.getAiChatDailyLimit(true), 100);
  assert.equal(EC.getWheelDailySpins(false), 3);
  assert.equal(EC.getWheelDailySpins(true), 5);
  assert.equal(EC.getWatchlistMax(false), 7);
  assert.equal(EC.getWatchlistMax(true), 20);
});

// ─── Tests: KV TTL fix ──────────────────────────────────────────────────────

test('KV-TTL-01: writeRateLimitCache clamps to min 60s', () => {
  assert.ok(WORKER_SRC.includes('MIN_KV_TTL = 60'), 'MIN_KV_TTL constant');
  assert.ok(WORKER_SRC.includes('Math.max(MIN_KV_TTL'), 'TTL clamped');
  assert.ok(WORKER_SRC.includes('AI-DEF-01'), 'references fix');
});

// ─── Tests: Alert economy tier-based ────────────────────────────────────────

test('ALERT-01: alert_config has premium_free_per_day', () => {
  assert.ok(ALERT_ECON_SRC.includes('premium_free_per_day'));
  assert.ok(ALERT_ECON_SRC.includes('ALTER TABLE alert_config ADD COLUMN IF NOT EXISTS premium_free_per_day'));
});

test('ALERT-02: checkQuota accepts isPremium', () => {
  assert.ok(ALERT_ECON_SRC.includes('async function checkQuota(env, userId, alertType, isPremium)'));
  assert.ok(ALERT_ECON_SRC.includes('isPremium === true'));
});

test('ALERT-03: alertHandlers wired with membershipAuthority', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const alertHandlers = createAlertHandlers'), WORKER_SRC.indexOf('const watchlistRepo'));
  assert.ok(w.includes('membershipAuthority'));
});

test('ALERT-04: alert controller calls isPremium + passes to checkQuota', () => {
  assert.ok(ALERTS_SRC.includes('membershipAuthority.isPremium'));
  assert.ok(ALERTS_SRC.includes("checkQuota(env, payload.user_id, 'price_alert', isPremium)"));
  assert.ok(ALERTS_SRC.includes('fail-safe') || ALERTS_SRC.includes('Fail-safe') || ALERTS_SRC.includes('PHASE 3'));
});

// ─── Tests: AI tier-based ───────────────────────────────────────────────────

test('AI-01: assistant has membershipAuthority + entitlementConfig deps', () => {
  assert.ok(ASSISTANT_SRC.includes('membershipAuthority'));
  assert.ok(ASSISTANT_SRC.includes('entitlementConfig'));
});

test('AI-02: checkRateLimits uses tier-based limits', () => {
  assert.ok(ASSISTANT_SRC.includes('entitlementConfig.ai_chat.premium_daily_limit'));
  assert.ok(ASSISTANT_SRC.includes('entitlementConfig.ai_chat.normal_daily_limit'));
  assert.ok(ASSISTANT_SRC.includes('entitlementConfig.ai_image.premium_daily_limit'));
});

test('AI-03: assistantHandlers wired with authority + config', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const assistantHandlers = createAssistantHandlers'), WORKER_SRC.indexOf('const analysisRepo'));
  assert.ok(w.includes('membershipAuthority'));
  assert.ok(w.includes('ENTITLEMENT_CONFIG'));
});

// ─── Tests: Wheel tier-based ────────────────────────────────────────────────

test('WHEEL-01: wheel has tier-based maxSpins helper', () => {
  assert.ok(WHEEL_SRC.includes('_getEffectiveMaxSpins'));
  assert.ok(WHEEL_SRC.includes('entitlementConfig.wheel.premium_daily_spins'));
  assert.ok(WHEEL_SRC.includes('entitlementConfig.wheel.normal_daily_spins'));
});

test('WHEEL-02: both handlers use _getEffectiveMaxSpins', () => {
  const matches = WHEEL_SRC.match(/_getEffectiveMaxSpins\(env, authState\.user\.id\)/g) || [];
  assert.ok(matches.length >= 2, 'called in at least 2 places, found: ' + matches.length);
});

test('WHEEL-03: wheelHandlers wired with authority + config', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const wheelHandlers = createWheelHandlers'), WORKER_SRC.indexOf('const walletHandlers'));
  assert.ok(w.includes('membershipAuthority'));
  assert.ok(w.includes('ENTITLEMENT_CONFIG'));
});

// ─── Tests: Watchlist tier-based ────────────────────────────────────────────

test('WATCH-01: watchlist has tier-based limit', () => {
  assert.ok(WATCH_SRC.includes('_getEffectiveMaxWatchlist'));
  assert.ok(WATCH_SRC.includes('entitlementConfig.watchlist.premium_max'));
  assert.ok(WATCH_SRC.includes('entitlementConfig.watchlist.normal_max'));
  assert.ok(WATCH_SRC.includes('maxWatchlist'));
});

test('WATCH-02: handlePut uses maxWatchlist (not hard-coded 7)', () => {
  assert.ok(WATCH_SRC.includes('const maxWatchlist = await _getEffectiveMaxWatchlist'));
  assert.ok(!WATCH_SRC.includes('slice(0, 7)'), 'no hard-coded 7');
});

test('WATCH-03: watchlistHandlers wired with authority + config', () => {
  const w = WORKER_SRC.slice(WORKER_SRC.indexOf('const watchlistHandlers = createWatchlistHandlers'), WORKER_SRC.indexOf('const referralRepo'));
  assert.ok(w.includes('membershipAuthority'));
  assert.ok(w.includes('ENTITLEMENT_CONFIG'));
});

// ─── Tests: Fail-safe ───────────────────────────────────────────────────────

test('FAILSAFE-01: Alert fail-safe — authority error → Normal', () => {
  assert.ok(ALERTS_SRC.includes('isPremium = false'));
});

test('FAILSAFE-02: AI fail-safe — authority error → Normal', () => {
  const block = ASSISTANT_SRC.slice(ASSISTANT_SRC.indexOf('async function checkRateLimits'), ASSISTANT_SRC.indexOf('async function recordRateLimitUsage'));
  assert.ok(block.includes('isPremium = false'));
});

test('FAILSAFE-03: Wheel fail-safe — authority error → Normal', () => {
  const block = WHEEL_SRC.slice(WHEEL_SRC.indexOf('_getEffectiveMaxSpins'), WHEEL_SRC.indexOf('return 3;'));
  assert.ok(block.includes('isPremium = false'));
});

test('FAILSAFE-04: Watchlist fail-safe — authority error → Normal', () => {
  const block = WATCH_SRC.slice(WATCH_SRC.indexOf('_getEffectiveMaxWatchlist'), WATCH_SRC.indexOf('return 7;'));
  assert.ok(block.includes('isPremium = false'));
});

// ─── Tests: No behavior change for Normal ───────────────────────────────────

test('NOCHANGE-01: No premium gating (no authority.require calls)', () => {
  const calls = WORKER_SRC.match(/membershipAuthority\.require\s*\(/g) || [];
  assert.equal(calls.length, 0);
});

test('NOCHANGE-02: Alert token cost unchanged (5 AB)', () => {
  assert.ok(ALERT_ECON_SRC.includes("('price_alert', TRUE, 3, 5)"), 'alert seed unchanged');
});

test('NOCHANGE-03: Daily claim now tier-based (Phase 4: Normal 10, Premium 20)', () => {
  const w = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
  assert.ok(w.includes('_getDailyRewardAmount'), 'daily claim uses tier-based helper');
  assert.ok(!w.includes('const DAILY_REWARD = 10;'), 'no hard-coded 10');
});

test('NOCHANGE-04: Watchlist frontend uses dynamic getMaxWatchlist() (premium-aware)', () => {
  // UPDATED: previously this test pinned `MAX_WATCHLIST = 7` as a hard-coded
  // const — which was the ROOT CAUSE of the "premium user hits limit 7" bug
  // (the frontend gate at toggleWatchlist blocked the PUT before the backend,
  // which correctly supports 20 for premium, was ever reached).
  //
  // Now the frontend uses getMaxWatchlist() which returns 7 (Free) or 20
  // (Premium) based on MembershipApp.isPremiumCached(). MAX_WATCHLIST=7 is
  // kept ONLY as a backward-compat constant (the Free limit) — the dynamic
  // value is via getMaxWatchlist(). The backend remains authoritative.
  const a = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(a.includes('function getMaxWatchlist()'),
    'frontend must define getMaxWatchlist() (dynamic premium-aware limit)');
  assert.ok(a.includes('window.MembershipApp.isPremiumCached()'),
    'getMaxWatchlist must consult MembershipApp.isPremiumCached()');
  assert.ok(a.includes('return 20'),
    'getMaxWatchlist must return 20 for premium (entitlement_config.premium_max)');
  assert.ok(a.includes('return 7'),
    'getMaxWatchlist must return 7 for Free (entitlement_config.normal_max)');
  // toggleWatchlist must use the dynamic function, not the hard-coded const
  assert.ok(a.includes('watchlist.length >= getMaxWatchlist()'),
    'toggleWatchlist gate must use getMaxWatchlist() (dynamic, premium-aware)');
});

// ─── Tests: Wiring ──────────────────────────────────────────────────────────

test('WIRE-01: membershipAuthority created before alertHandlers', () => {
  const authIdx = WORKER_SRC.indexOf('const membershipAuthority = createMembershipAuthority');
  const alertIdx = WORKER_SRC.indexOf('const alertHandlers = createAlertHandlers');
  assert.ok(authIdx > -1 && alertIdx > -1);
  assert.ok(authIdx < alertIdx, 'authority before alertHandlers');
});

test('WIRE-02: No duplicate membershipAuthority definition', () => {
  const matches = WORKER_SRC.match(/const membershipAuthority = createMembershipAuthority/g) || [];
  assert.equal(matches.length, 1);
});

test('WIRE-03: ENTITLEMENT_CONFIG imported', () => {
  assert.ok(WORKER_SRC.includes("import { ENTITLEMENT_CONFIG }"));
});

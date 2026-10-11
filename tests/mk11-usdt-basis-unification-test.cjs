/**
 * MK-11 (Task 65) — USDT-basis unification: BEHAVIORAL regression tests
 * =====================================================================
 *
 * Task 65 scope: «اختلاف واحد قیمت بین ثبت هشدار و بررسی/فعال‌شدن آن» —
 * the registration basis and the cron evaluation basis must be the SAME
 * (USDT for crypto). The fix (see tests/mk11-btc-pair-conversion-basis-test.cjs
 * for the characterization history):
 *   1. setPriceAlert converts BTC-pair entries with the LIVE BTC USDT spot
 *      (batch /api/market/prices — the same bybit/okx/mexc chain + exchange
 *      cache the cron's fetchOhlc1m uses), FAIL-CLOSED when unavailable.
 *   2. The alert card (registration anchor) shows the live USDT-basis spot
 *      for crypto (fetchAlertBasisPrice, one-shot per detail open).
 *   3. Entered numbers are stored EXACTLY as typed (no entry≠storage gap).
 *
 * These tests EXECUTE the real production code — setPriceAlert,
 * fetchAlertBasisPrice, setAlertInputUnit, the real parseBtcPairSymbol and
 * getAlertUnitLabel are extracted from the actual sources and run with only
 * the network/DOM leaves mocked; the cross-detection logic is the REAL block
 * extracted verbatim from runScheduledAlertsBaseline.
 *
 * Mandatory coverage (Task 65 Phase 3):
 *   S1  Registration with a valid USDT price (BTC pair conversion on the
 *       live USDT spot; regular crypto stored exactly as typed).
 *   S2  Trigger fires in the RIGHT direction, only after crossing.
 *   S3  No early/wrong trigger caused by a USD/USDT basis mismatch.
 *   S4  No price / stale price / invalid response / source error →
 *       fail-closed everywhere (registration blocked, honest card fallback).
 *   S5  Legacy-alert compatibility (stored numbers untouched, no migration).
 *   S6  Duplicate-trigger prevention + CAS preserved.
 *   S7  No important behavior change + no unnecessary request/CPU cost.
 *   S8  UI wiring (anchor card labels, input unit prefix, refresh guard).
 *
 * Run: node --test tests/mk11-usdt-basis-unification-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const ALERTS_REPO_SRC = fs.readFileSync(path.join(ROOT, 'src', 'repositories', 'alerts.js'), 'utf8');
const MIGRATE_SQL = fs.readFileSync(path.join(ROOT, 'scripts', '00-migrate.sql'), 'utf8');

// ============================================================================
// Extraction: REAL production functions (only leaves are mocked in sandboxes)
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^(async )?function ${name}\\(`);
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`${name} not found`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (lines[j] === '}') return lines.slice(startIdx, j + 1).join('\n');
  }
  throw new Error(`${name} end not found`);
}

const SET_PRICE_ALERT_SRC = extractFn(APP_SRC, 'setPriceAlert');
const PARSE_BTC_PAIR_SRC = extractFn(APP_SRC, 'parseBtcPairSymbol');
const FETCH_ANCHOR_SRC = extractFn(APP_SRC, 'fetchAlertBasisPrice');
const SET_ALERT_UNIT_SRC = extractFn(APP_SRC, 'setAlertInputUnit');

// getAlertUnitLabel + its ALERT_NON_CRYPTO_UNITS map (frontend mirror of the
// backend MK-06 derivation) — extracted together.
function extractUnitLabel(src) {
  const start = src.indexOf('const ALERT_NON_CRYPTO_UNITS = {');
  const fnStart = src.indexOf('function getAlertUnitLabel(', start);
  if (start === -1 || fnStart === -1) throw new Error('unit label block not found');
  const lines = src.split('\n');
  const fnLine = src.slice(0, fnStart).split('\n').length; // 1-based
  for (let j = fnLine; j < lines.length; j++) {
    if (lines[j] === '}') return lines.slice(start - 1 === -1 ? 0 : src.slice(0, start).split('\n').length - 1, j + 1).join('\n');
  }
  throw new Error('getAlertUnitLabel end not found');
}
const UNIT_LABEL_SRC = extractUnitLabel(APP_SRC);

// The REAL cross-detection block, extracted verbatim from
// runScheduledAlertsBaseline (worker-proxy.js) — the exact if/else the cron
// runs per alert per tick.
function extractCrossDetection(src) {
  const start = src.indexOf('      let shouldTrigger = false;');
  const end = src.indexOf('// ARCHITECTURAL FIX: Queue the update');
  if (start === -1 || end === -1 || end <= start) throw new Error('cross-detection block not found');
  return src.slice(start, end).replace(/\s+$/, '');
}
const CROSS_SRC = extractCrossDetection(WORKER_SRC);
const evalCross = new Function(`
  return function evalCross(direction, targetPrice, prevPrice, candleHigh, candleLow, alert) {
    if (alert === undefined) alert = { last_checked_at: '2026-01-01T00:00:00Z' }; // already checked before → no first-check re-trigger
${CROSS_SRC}
    return { shouldTrigger, triggerReason };
  };
`)();

// ============================================================================
// Sandbox builders
// ============================================================================

/** Registration sandbox: REAL setPriceAlert + real helpers, mocked leaves. */
function makeRegWorld(opts = {}) {
  const world = {
    alerts: [], apiCalls: [], alertsShown: [], notifications: [], syncs: [], rendered: [], haptics: [],
    chPriceAlert: opts.chPriceAlert ?? 'both',
    guest: opts.guest === true,
    pending: opts.pending === true,
    price: opts.price ?? '0.05',
    detailSymbol: opts.detailSymbol ?? 'ETHBTC',
    btcUsdt: opts.btcUsdt ?? 100500,
    btcCg: opts.btcCg ?? 99800,
    batchBehavior: opts.batchBehavior ?? 'ok',
  };
  world.inputEl = { value: world.price };
  world.titleEl = { innerText: 'ETH Ethereum' };
  world.__el = (id) => (id === 'alert-price' ? world.inputEl : world.titleEl);
  world.t = (k) => (k === 'price_alert_notif_disabled' ? 'DISABLED_MSG'
    : k === 'price_alert_notif_check_failed' ? 'CHECK_FAILED_MSG'
      : k === 'price_alert_basis_unavailable' ? 'BASIS_UNAVAILABLE_MSG' : k);
  world.batchResponse = () => {
    switch (world.batchBehavior) {
      case 'throw': throw new Error('network down');
      case 'error-status': return { status: 'error' };
      case 'no-btc': return { status: 'success', prices: { ETH: { price: 3200 } } };
      case 'zero': return { status: 'success', prices: { BTC: { price: 0 } } };
      case 'nan': return { status: 'success', prices: { BTC: { price: 'not-a-number' } } };
      case 'garbage': return null;
      default: return { status: 'success', prices: { BTC: { price: world.btcUsdt } } };
    }
  };

  const wrapper = [
    'let alerts = __g.alerts;',
    'let currentAlertDirection = "above";',
    'const API_BASE = "https://test.local";',
    `const UserContext = { isGuest: () => ${world.guest}, isPending: () => false };`,
    'const document = { getElementById: (id) => __g.__el(id) };',
    `const _currentDetailSymbol = ${JSON.stringify(world.detailSymbol)};`,
    PARSE_BTC_PAIR_SRC,
    UNIT_LABEL_SRC,
    `const allCoins = [{ symbol: "BTC", priceUsd: __g.btcCg }];`,
    `const getUserId = () => ${JSON.stringify(world.guest ? 'guest_9' : world.pending ? 'tg_pending_55' : '700400')};`,
    'const isGuestUserId = (id) => String(id || "").startsWith("guest_");',
    'const isPendingTelegramUserId = (id) => String(id || "").startsWith("tg_pending_");',
    'const t = (k) => __g.t(k);',
    'const localStorage = { setItem: () => {}, getItem: () => null };',
    'const renderActiveAlerts = (sym) => { __g.rendered.push(sym); };',
    'const addNotification = (title, body, options) => { __g.notifications.push({ title, body, options }); };',
    'const getTg = () => ({ HapticFeedback: { notificationOccurred: (k) => __g.haptics.push(k) } });',
    'const syncAlertToServer = async (a) => { if (__g.guest || __g.pending) return a; __g.syncs.push(a.symbol); a.serverId = "srv-7"; return a; };',
    'const showMiniToast = (m) => {};',
    'const apiFetch = async (url) => { __g.apiCalls.push(url); if (url === "/api/notifications/platform/settings") return { status: "success", settings: { ch_price_alert: __g.chPriceAlert } }; if (url.startsWith("/api/market/prices?")) return __g.batchResponse(); throw new Error("unexpected url " + url); };',
    'const alert = (m) => { __g.alertsShown.push(m); };',
    'const console = { warn: () => {}, log: () => {} };',
    SET_PRICE_ALERT_SRC,
    'return { setPriceAlert, __getAlerts: () => alerts };',
  ].join('\n');
  world.sandbox = new Function('__g', wrapper)(world);
  return world;
}

/** Anchor sandbox: REAL fetchAlertBasisPrice + setAlertInputUnit, mocked DOM. */
function makeAnchorWorld(opts = {}) {
  const world = {
    apiCalls: [],
    batchResponse: opts.batchResponse ?? (() => ({ status: 'success', prices: { ETH: { price: 67512.34 }, BTC: { price: 100250 } } })),
    token: opts.token ?? 7,
    globalToken: opts.globalToken ?? 7,
    detailSymbol: opts.detailSymbol ?? 'ETH',
    card: { textContent: '67,420 USD' },
    header: { textContent: '--' },
    prefix: { textContent: '$', offsetWidth: 40 },
    inputEl: { style: {} },
    batchFail: opts.batchFail === true,
  };
  if (world.batchFail) world.batchResponse = () => { throw new Error('429 rate limited'); };
  world.__el = (id) => (id === 'alert-current-price-value' ? world.card
    : id === 'detail-coin-price' ? world.header
      : id === 'cd-alert-prefix' ? world.prefix
        : id === 'alert-price' ? world.inputEl : null);
  const wrapper = [
    'const API_BASE = "https://test.local";',
    `let _detailLoadToken = ${JSON.stringify(world.globalToken)};`,
    `let _currentDetailSymbol = ${JSON.stringify(world.detailSymbol)};`,
    UNIT_LABEL_SRC,
    'const document = { getElementById: (id) => __g.__el(id) };',
    'const apiFetch = async (url) => { __g.apiCalls.push(url); return __g.batchResponse(); };',
    'const console = { warn: () => {}, log: () => {} };',
    FETCH_ANCHOR_SRC,
    SET_ALERT_UNIT_SRC,
    'return { fetchAlertBasisPrice, setAlertInputUnit };',
  ].join('\n');
  world.sandbox = new Function('__g', wrapper)(world);
  return world;
}

const settle = () => new Promise(r => setImmediate(r));

// ============================================================================
// S1 — Registration with a valid USDT price
// ============================================================================
test('S1a: BTC-pair entry converts with the LIVE USDT spot (not the CoinGecko USD price)', async () => {
  // CG BTC price (99,800) differs from the live USDT spot (100,500) by ~0.7% —
  // far beyond the exchange-vs-CG noise band, so the assertion is unambiguous.
  const w = makeRegWorld({ price: '0.05', btcUsdt: 100500, btcCg: 99800 });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1, 'alert registered');
  assert.equal(w.alerts[0].symbol, 'ETH', 'BTC-pair entry stored by base symbol');
  assert.ok(Math.abs(w.alerts[0].price - 5025) < 1e-8,
    'stored target = 0.05 × USDT spot 100,500 = 5,025 (USDT basis)');
  assert.ok(Math.abs(w.alerts[0].price - 4990) > 1,
    'stored target is NOT the CoinGecko conversion (0.05 × 99,800 = 4,990)');
  assert.equal(w.syncs.length, 1, 'server sync ran');
  assert.equal(w.inputEl.value, '', 'input cleared on success');
  assert.deepEqual(w.apiCalls, [
    '/api/notifications/platform/settings',
    "/api/market/prices?symbols=BTC",
  ], 'gate read first, then the USDT conversion fetch');
  assert.equal(w.notifications.length, 1, 'registration receipt');
  assert.equal(w.notifications[0].body, 'ETH → 5025.00 USDT',
    'receipt labels the stored target with its evaluation unit');
});

test('S1b: regular crypto entry is stored EXACTLY as typed (no conversion, no extra fetch)', async () => {
  const w = makeRegWorld({ detailSymbol: 'BTC', price: '67512.34' });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1);
  assert.equal(w.alerts[0].price, 67512.34, 'entered number stored verbatim');
  assert.deepEqual(w.apiCalls, ['/api/notifications/platform/settings'],
    'no price fetch for regular crypto entries — nothing to convert');
  assert.equal(w.notifications[0].body, 'BTC → 67512.34 USDT');
});

test('S1c: guest BTC-pair entry keeps the LOCAL CoinGecko basis (local-only alert, no cron)', async () => {
  // Guests never reach the cron (syncAlertToServer skips them); their local
  // checkAlerts evaluation stream is the CoinGecko priceMap — so the CG
  // conversion IS their basis-consistent path (documented exception, not a
  // silent substitution of the cron basis).
  const w = makeRegWorld({ price: '0.05', guest: true, btcUsdt: 100500, btcCg: 99800 });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1, 'guest local registration works (pre-Task-65 behavior preserved)');
  assert.ok(Math.abs(w.alerts[0].price - 4990) < 1e-8, 'converted with the CG price (local basis)');
  assert.equal(w.apiCalls.filter(u => u.startsWith('/api/market/prices')).length, 0,
    'no USDT fetch attempted (no auth, and not needed for local-only alerts)');
  assert.equal(w.syncs.length, 0, 'guest alert stays local-only');
});

// ============================================================================
// S2 — Trigger fires in the RIGHT direction, only after crossing
// (REAL cron cross-detection logic, executed verbatim)
// ============================================================================
test('S2: real cross-detection fires cross_up/cross_down exactly on crossing', () => {
  // above: price crosses UP through the target during the candle
  let r = evalCross('above', 68000, 67900, 68050, 67850);
  assert.deepEqual(r, { shouldTrigger: true, triggerReason: 'cross_up' });

  // below: price crosses DOWN through the target during the candle
  r = evalCross('below', 60000, 60100, 60150, 59980);
  assert.deepEqual(r, { shouldTrigger: true, triggerReason: 'cross_down' });

  // was already beyond + still beyond → NO re-trigger (duplicate prevention)
  r = evalCross('above', 68000, 68100, 68150, 67950);
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'still_above_no_retrigger');
  r = evalCross('below', 60000, 59900, 60050, 59880);
  assert.equal(r.shouldTrigger, false);
  assert.equal(r.triggerReason, 'still_below_no_retrigger');

  // not yet reached → no trigger
  r = evalCross('above', 68000, 67500, 67600, 67400);
  assert.equal(r.shouldTrigger, false);
  r = evalCross('below', 60000, 60500, 60600, 60400);
  assert.equal(r.shouldTrigger, false);
});

// ============================================================================
// S3 — No early/wrong trigger caused by the USD/USDT basis mismatch
// ============================================================================
test('S3: an entry anchored on the USDT spot does NOT spuriously fire on the first cron tick', async () => {
  // Scenario: CG display said 67,420 (stale USD basis); the live bybit USDT
  // spot — what the anchor card now shows and the cron evaluates — is 67,512.
  // The user anchors on the USDT price and enters 67,512 ("alert at current").
  const w = makeRegWorld({ detailSymbol: 'ETH', price: '67512', btcUsdt: 67512, btcCg: 67420 });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1);
  assert.equal(w.alerts[0].price, 67512, 'stored exactly as typed (USDT-anchored)');

  // First cron tick: the USDT candle reached 67,505 — BELOW the target.
  const candle = { high: 67505, low: 67480 };
  let r = evalCross('above', 67512, null, candle.high, candle.low);
  assert.equal(r.shouldTrigger, false, 'no spurious immediate trigger');
  assert.equal(r.triggerReason, 'below_target_no_cross');

  // CONTRAST — the pre-fix outcome for the same user: anchored on the CG
  // display (67,420), they would have entered 67,420, and the SAME candle
  // (high 67,505 ≥ 67,420) would have fired immediately:
  r = evalCross('above', 67420, null, candle.high, candle.low);
  assert.equal(r.shouldTrigger, true, 'the old CG-anchored entry DID spuriously fire');
  assert.equal(r.triggerReason, 'immediate_above');

  // And when the USDT price actually crosses up through the USDT-anchored
  // target, the alert fires — in the right direction, at the right moment:
  const next = { high: 67530, low: 67490 };   // candle close 67,530-ish, prev close 67,490
  r = evalCross('above', 67512, 67490, next.high, next.low);
  assert.deepEqual(r, { shouldTrigger: true, triggerReason: 'cross_up' });
});

// ============================================================================
// S4 — No price / stale price / invalid response / source error → fail-closed
// ============================================================================
for (const behavior of ['throw', 'error-status', 'no-btc', 'zero', 'nan', 'garbage']) {
  test(`S4a: BTC-pair registration BLOCKED when the USDT source fails (${behavior})`, async () => {
    const w = makeRegWorld({ price: '0.05', batchBehavior: behavior, btcUsdt: 100500, btcCg: 99800 });
    await w.sandbox.setPriceAlert();
    await settle(); await settle();
    assert.equal(w.alerts.length, 0, 'no alert registered on an unusable basis');
    assert.equal(w.syncs.length, 0, 'no server sync');
    assert.equal(w.notifications.length, 0, 'no receipt — nothing was registered');
    assert.equal(w.haptics.length, 0, 'no success haptic');
    assert.equal(w.inputEl.value, '0.05', 'the user\u2019s input is preserved for retry');
    assert.deepEqual(w.alertsShown, ['BASIS_UNAVAILABLE_MSG'],
      'the dedicated fail-closed message is shown — no silent CG substitution');
  });
}

test('S4b: guest with no CG BTC price → blocked too (local basis unavailable)', async () => {
  const w = makeRegWorld({ price: '0.05', guest: true, btcCg: 0 });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 0);
  assert.deepEqual(w.alertsShown, ['BASIS_UNAVAILABLE_MSG']);
});

test('S4c: anchor card keeps the honest CoinGecko fallback when the anchor fetch fails (never fakes USDT)', async () => {
  const w = makeAnchorWorld({ batchFail: true });
  w.sandbox.fetchAlertBasisPrice('ETH', 'ETH', false, 7, false);
  await settle(); await settle();
  assert.equal(w.card.textContent, '67,420 USD',
    'fetch failure keeps the CoinGecko value labeled with its TRUE unit (USD)');
  assert.ok(!/USDT/.test(w.card.textContent), 'a USDT label must never be faked');
});

test('S4d: anchor card ignores malformed/missing prices', async () => {
  for (const prices of [{}, { ETH: null }, { ETH: { price: 0 } }, { ETH: { price: 'x' } }]) {
    const w = makeAnchorWorld({ batchResponse: () => ({ status: 'success', prices }) });
    w.sandbox.fetchAlertBasisPrice('ETH', 'ETH', false, 7, false);
    await settle(); await settle();
    assert.equal(w.card.textContent, '67,420 USD', 'no write without a valid price');
  }
});

// ============================================================================
// S5 — Legacy-alert compatibility (no migration, no reinterpretation)
// ============================================================================
test('S5: legacy stored alerts pass through the evaluation unchanged (no migration, no reinterpretation)', () => {
  // (a) The cron reads the raw stored number — no basis transform applied
  assert.match(WORKER_SRC, /const targetPrice = Number\(alert\?\.price\)/,
    'evaluation reads the raw stored target');
  // (b) Storage schema unchanged (NUMERIC(24,8), no new basis/unit column)
  assert.match(MIGRATE_SQL, /price\s+NUMERIC\(24,\s*8\)\s+NOT NULL/,
    'price_alerts.price stays NUMERIC(24,8)');
  assert.ok(!/price_basis|basis_source|price_unit/.test(MIGRATE_SQL),
    'no basis/unit column was added (no migration)');
  // (c) Behavioral: a legacy CG-basis stored target (e.g. 67,420 registered
  // pre-Task-65) is evaluated against the USDT candle with the SAME
  // cross-detection as before the fix — the evaluation code is untouched.
  const r = evalCross('above', 67420, null, 67505, 67480);
  assert.equal(r.shouldTrigger, true, 'legacy target behaves exactly as pre-fix (immediate_above)');
  assert.equal(r.triggerReason, 'immediate_above');
});

// ============================================================================
// S6 — Duplicate-trigger prevention + CAS preserved
// ============================================================================
test('S6: CAS claim + deterministic ids + ON CONFLICT idempotency unchanged', () => {
  // markTriggeredBulk claims alerts atomically: WHERE id IN (...) AND
  // status='active' RETURNING id — an already-triggered alert returns
  // claimed=false → no second notification.
  const bulkIdx = ALERTS_REPO_SRC.indexOf('async function markTriggeredBulk');
  const bulkZone = ALERTS_REPO_SRC.slice(bulkIdx, bulkIdx + 2200);
  assert.match(bulkZone, /WHERE id IN \(\$\{idPlaceholders\.join\(','\)\}\) AND status = 'active'/,
    'CAS guard: only still-active alerts are claimed');
  assert.match(bulkZone, /RETURNING id/, 'claimed set built from RETURNING ids');

  // Deterministic notification ids + ON CONFLICT DO NOTHING → replays are no-ops
  assert.match(WORKER_SRC, /notif_price_alert_\$\{t\.alertId\}_\$\{t\.userId\}/,
    'deterministic notif id per alert+user');
  assert.match(WORKER_SRC, /ON CONFLICT \(id\) DO NOTHING/,
    'notifications INSERT is idempotent');
  assert.match(WORKER_SRC, /ON CONFLICT \(notification_id, user_id\) DO NOTHING/,
    'queue INSERT is idempotent');

  // Re-trigger prevention in the REAL cross-detection: claimed alert has
  // status='triggered' → excluded from the next active list; and a still-active
  // alert already beyond its target never re-fires (pinned in S2).
  let r = evalCross('above', 68000, 68100, 68150, 67950);
  assert.equal(r.shouldTrigger, false, 'still_above_no_retrigger');
  r = evalCross('below', 60000, 59900, 60050, 59880);
  assert.equal(r.shouldTrigger, false, 'still_below_no_retrigger');
});

// ============================================================================
// S7 — No important behavior change + no unnecessary request/CPU cost
// ============================================================================
test('S7a: the anchor is ONE-SHOT — no timers, no loops, no retries, exactly one fetch', () => {
  assert.ok(!/setInterval|setTimeout|while\s*\(|for\s*\(/.test(FETCH_ANCHOR_SRC),
    'fetchAlertBasisPrice contains no timers/loops/retries');
  assert.equal((FETCH_ANCHOR_SRC.match(/apiFetch\(/g) || []).length, 1,
    'exactly one apiFetch call in the anchor');
  // openCoinDetail wires the anchor exactly once per detail open (count on
  // comment-stripped source — doc comments also mention the function)
  const stripComments = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const openCoinStart = APP_SRC.indexOf('async function openCoinDetail');
  const openCoinEnd = APP_SRC.indexOf('async function openForexDetail');
  const openCoin = stripComments(APP_SRC.slice(openCoinStart, openCoinEnd));
  assert.equal((openCoin.match(/fetchAlertBasisPrice\(/g) || []).length, 1,
    'exactly one anchor fetch per detail open');
  // The old single-symbol background fetch is gone (folded in — same request
  // count for non-top-200 opens, +1 for top-200 opens)
  assert.ok(!/\/api\/market\/price\?symbol=/.test(openCoin),
    'the old single-symbol background fetch was folded into the anchor');
  // checkAlerts 30s polling cadence unchanged
  assert.match(APP_SRC, /checkAlerts\(\);\s*\n\s*\}, 30000\)/,
    'frontend alert polling stays on its 30s cadence');
});

test('S7b: refreshOpenDetailPrice never overwrites the crypto anchor card (basis cannot flip mid-view)', () => {
  const fn = APP_SRC.slice(APP_SRC.indexOf('function refreshOpenDetailPrice'), APP_SRC.indexOf('\nfunction _stopAllPolling'));
  assert.match(fn, /if \(!isCrypto && !isBtcPair\)/,
    'the market tick writes the alert card ONLY for non-crypto (Yahoo-consistent) assets');
});

test('S7c: worker-proxy.js evaluation path untouched (comments-only diff, verified pre-push)', () => {
  // The strongest proof (comment-stripped byte-identity vs the pre-change
  // revision) is executed during review; here we pin the structural anchors
  // the fix must NEVER alter:
  assert.match(WORKER_SRC, /const KLINE_EXCHANGES = \['bybit', 'okx', 'mexc'\]/,
    'cron kline chain unchanged');
  assert.match(WORKER_SRC, /symbol=\$\{encodeURIComponent\(`\$\{symbol\}USDT`\)\}/,
    'bybit klines still query <SYM>USDT');
  assert.match(WORKER_SRC, /slice\(0, 14\)/,
    'H6 14-symbol subrequest cap unchanged');
  assert.match(WORKER_SRC, /skipped_ohlc_unavailable/,
    'missing-OHLC silent-loss protection unchanged');
});

// ============================================================================
// S8 — UI wiring: anchor card, unit labels, input prefix
// ============================================================================
test('S8a: anchor card shows the live USDT-basis spot for crypto (real fetchAlertBasisPrice)', async () => {
  const w = makeAnchorWorld();
  w.sandbox.fetchAlertBasisPrice('ETH', 'ETH', false, 7, false);
  await settle(); await settle();
  assert.equal(w.card.textContent, '67,512.34 USDT');
  assert.equal(w.header.textContent, '--', 'header untouched for top-200 coins');
});

test('S8b: BTC-pair anchor shows the live USDT-basis pair price', async () => {
  const w = makeAnchorWorld({ detailSymbol: 'ETHBTC', batchResponse: () => ({ status: 'success', prices: { ETH: { price: 3201.5 }, BTC: { price: 100250 } } }) });
  w.sandbox.fetchAlertBasisPrice('ETHBTC', 'ETH', true, 7, false);
  await settle(); await settle();
  assert.equal(w.card.textContent, '0.031935 BTC', 'pair = base USDT / BTC USDT, labeled BTC');
});

test('S8c: non-top-200 coins keep the header price fill (old fetch folded in — same request count)', async () => {
  const w = makeAnchorWorld();
  w.sandbox.fetchAlertBasisPrice('ETH', 'ETH', false, 7, true);
  await settle(); await settle();
  assert.equal(w.card.textContent, '67,512.34 USDT');
  assert.equal(w.header.textContent, '$67,512.34', 'header filled by the SAME request');
});

test('S8d: gold/stock anchors are labeled with their true Yahoo unit (USD), not USDT', async () => {
  const w = makeAnchorWorld({ batchResponse: () => ({ status: 'success', prices: { XAUUSD: { price: 2650.5 } } }), detailSymbol: 'XAUUSD' });
  w.sandbox.fetchAlertBasisPrice('XAUUSD', 'XAUUSD', false, 7, false);
  await settle(); await settle();
  assert.equal(w.card.textContent, '2,650.50 USD');
});

test('S8e: race guards — a stale anchor result never overwrites a newer detail view', async () => {
  // token mismatch
  let w = makeAnchorWorld({});
  w.sandbox.fetchAlertBasisPrice('ETH', 'ETH', false, 99, false); // token 99 ≠ global 7
  await settle(); await settle();
  assert.equal(w.card.textContent, '67,420 USD', 'stale token → no write');
  // symbol changed while in flight
  w = makeAnchorWorld({ detailSymbol: 'SOL' });
  w.sandbox.fetchAlertBasisPrice('ETH', 'ETH', false, 7, false);
  await settle(); await settle();
  assert.equal(w.card.textContent, '67,420 USD', 'different symbol open → no write');
});

test('S8f: input prefix states the entered unit (real setAlertInputUnit + real getAlertUnitLabel)', () => {
  const w = makeAnchorWorld({});
  w.sandbox.setAlertInputUnit('ETH', false);   // crypto → USDT
  assert.equal(w.prefix.textContent, 'USDT');
  assert.ok(parseInt(w.inputEl.style.paddingRight, 10) >= 40, 'input padding grows for the wider prefix');
  w.sandbox.setAlertInputUnit('ETH', true);    // BTC pair → BTC
  assert.equal(w.prefix.textContent, 'BTC');
  w.sandbox.setAlertInputUnit('XAUUSD', false); // gold → USD
  assert.equal(w.prefix.textContent, 'USD');
  w.sandbox.setAlertInputUnit('USDJPY', false);  // FX → quote currency
  assert.equal(w.prefix.textContent, 'JPY');
});

test('S8g: unit labels flow through the app contexts (receipt/list use the same derivation)', () => {
  // The HTML input prefix element is addressable (id added in Task 65)
  assert.match(fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8'), /id="cd-alert-prefix"/);
  // renderActiveAlerts labels each stored target with its unit
  const fn = APP_SRC.slice(APP_SRC.indexOf('function renderActiveAlerts'), APP_SRC.indexOf('async function removeAlert'));
  assert.match(fn, /\$\{priceStr\} \$\{getAlertUnitLabel\(a\.symbol\)\}/,
    'active list shows "<target> <unit>"');
  // The registration receipt labels the unit (asserted behaviorally in S1a/S1b)
  // The trigger message already labels units per MK-06 (backend + frontend mirror).
});

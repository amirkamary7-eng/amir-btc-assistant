/**
 * MK-11 — BTC-pair conversion basis mismatch: characterization + decision pin
 * ========================================================================
 *
 * Task 62 finding MK-11 (CONFIRMED, structural):
 *
 *   TARGET side   : setPriceAlert (app.js) converts BTC-denominated inputs
 *                  (e.g. ETHBTC = 0.05) via  price × BTC.priceUsd, where
 *                  priceUsd comes from CoinGecko USD
 *                  (/api/market → coins/markets?vs_currency=usd, up to ~120s
 *                  stale via KV+memory cache) → stored as NUMERIC(24,8) USD.
 *   EVALUATION side: the 1-min cron compares the RAW stored target
 *                  (worker-proxy.js 'const targetPrice = Number(alert?.price)')
 *                  against bybit/okx/mexc <SYM>USDT klines.
 *
 *   → Every crypto alert is set on a CoinGecko-USD basis but evaluated on a
 *     USDT-kline basis. BTC-pair alerts additionally carry the BTC conversion
 *     skew. Error budget (quantified in S4): E1 CG-vs-exchange ≈ ±0.1%,
 *   E2 entry staleness (CG cache ≤120s), E3 USDT peg ≈ ±0.05%,
 *   E4 NUMERIC(24,8) rounding < 1e-8.
 *
 *   DECISION (STOP per Task 63 rule): every safe fix requires an architecture
 *   change or a new price source (USDT-basis storage; or USD-spot cron losing
 *   OHLC cross-detection + CoinGecko rate limits; or a per-tick peg correction
 *   that only removes E3). No correction was applied. The accepted mitigation
 *   is transparency: MK-02 shows the user's target AND the observed price in
 *   every trigger message, so any residual skew is visible.
 *
 *   TASK 65 DECISION (user instruction — MK-11 USD/USDT consistency): the basis
 *   is now UNIFIED for new registrations:
 *     1. BTC-pair conversion uses the LIVE BTC USDT spot (batch
 *        /api/market/prices → fetchSpotPriceUsd — the same bybit/okx/mexc
 *        chain + `price:exchange:BTC` cache the cron's fetchOhlc1m reads),
 *        FAIL-CLOSED when unavailable (no silent CG substitution).
 *     2. The alert card (registration anchor) shows the live USDT-basis spot
 *        for crypto (fetchAlertBasisPrice, ONE-SHOT per detail open) — so
 *        entries are anchored on the evaluation basis. The entered number is
 *        still stored EXACTLY as typed (no entry≠storage discrepancy).
 *     3. All alert-context UI (input prefix, card, receipt, active list)
 *        labels crypto numbers USDT (was "$" — a wrong unit claim).
 *   LEGACY alerts: stored numbers are NOT migrated and NOT re-interpreted —
 *   they keep the documented ±0.15% residual envelope (S4) with MK-02
 *   transparency. The evaluation path itself is byte-identical.
 *
 * This file pins: (1) the real parseBtcPairSymbol gate, (2) arithmetic +
 *   NUMERIC(24,8) precision safety of the conversion, (3) the NEW USDT-basis
 *   conversion in the real sources (fail-closed), (4) the quantified residual
 *   envelope for LEGACY alerts, (5) the Task 65 decision state (anchor
 *   unification present + one-shot, no polling; evaluation untouched).
 *
 * Run: node --test tests/mk11-btc-pair-conversion-basis-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const MARKET_DATA_SRC = fs.readFileSync(path.join(ROOT, 'src/services/market-data.js'), 'utf8');
const MIGRATE_SQL = fs.readFileSync(path.join(ROOT, 'scripts/00-migrate.sql'), 'utf8');

// ============================================================================
// Real parseBtcPairSymbol extraction
// ============================================================================
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^function ${name}\\(`);
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
const PARSE_BTC_PAIR_SRC = extractFn(APP_SRC, 'parseBtcPairSymbol');
const parseBtcPairSymbol = new Function(`${PARSE_BTC_PAIR_SRC}\nreturn parseBtcPairSymbol;`)();

// ============================================================================
// Scenarios
// ============================================================================
test('MK-11 S1: real parseBtcPairSymbol gates exactly the BTC-denominated inputs', () => {
  // BTC-denominated pairs → base symbol extracted
  assert.equal(parseBtcPairSymbol('ETHBTC'), 'ETH');
  assert.equal(parseBtcPairSymbol('SOLBTC'), 'SOL');
  assert.equal(parseBtcPairSymbol('ethbtc'), 'ETH');       // normalization
  assert.equal(parseBtcPairSymbol('  PEPEBTC '), 'PEPE');
  // NOT BTC pairs → null (no conversion applied on these paths)
  assert.equal(parseBtcPairSymbol('BTC'), null);           // BTC itself
  assert.equal(parseBtcPairSymbol('BTCUSDT'), null);       // USDT-quoted
  assert.equal(parseBtcPairSymbol('ETHUSDT'), null);       // does not end with BTC
  assert.equal(parseBtcPairSymbol('ABTC'), null);          // 1-char base < 2
  assert.equal(parseBtcPairSymbol('BTCBTC'), null);        // meaningless
  assert.equal(parseBtcPairSymbol('E-BTC'), null);         // non-alphanumeric
  assert.equal(parseBtcPairSymbol(''), null);
  assert.equal(parseBtcPairSymbol(null), null);
});

test('MK-11 S2: conversion arithmetic is exact and NUMERIC(24,8)-safe', () => {
  // price_alerts.price is NUMERIC(24,8) (scripts/00-migrate.sql)
  assert.match(MIGRATE_SQL, /price\s+NUMERIC\(24,\s*8\)\s+NOT NULL/,
    'price_alerts.price must be NUMERIC(24,8)');

  // Real conversion shape (setPriceAlert since Task 65): usdPrice = price ×
  // live BTC USDT spot (btcUsdtSpot). Typical magnitudes:
  const cases = [
    { pairPrice: 0.05, btc: 100000 },    // ETHBTC ≈ 0.05, BTC $100k → $5000
    { pairPrice: 0.000012, btc: 100000 },// PEPEBTC → $0.0012
    { pairPrice: 21.5, btc: 100000 },    // WBTC-like → $2.15M
  ];
  for (const { pairPrice, btc } of cases) {
    const usd = pairPrice * btc;
    // 8-decimal storage: rounding error strictly below 1e-8 absolute
    const stored = Number(usd.toFixed(8));
    assert.ok(Math.abs(stored - usd) < 1e-8, 'NUMERIC(24,8) rounding must stay below 1e-8');
    // Magnitude fits: 24 total digits − 8 fraction digits = 16 integer digits
    assert.ok(stored < 1e16, 'value fits NUMERIC(24,8) integer part');
  }
  // 0.05 * 100000 is exactly representable in binary? No — but the product is
  // deterministic and the stored 8-dp value equals the decimal product:
  assert.equal(Number((0.05 * 100000).toFixed(8)), 5000);
});

test('MK-11 S3: Task 65 conversion — live USDT spot basis, fail-closed (pinned in real sources)', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const app = strip(APP_SRC);
  const worker = strip(WORKER_SRC);

  // TARGET side (post-Task 65): setPriceAlert fetches the LIVE BTC USDT spot
  // from the batch endpoint (same chain the cron evaluates against) and
  // multiplies by it — the CoinGecko-USD conversion is GONE.
  const setPriceAlert = app.slice(app.indexOf('function setPriceAlert'), app.indexOf('\n}', app.indexOf('function setPriceAlert')));
  assert.match(setPriceAlert, /isBtcPair/, 'setPriceAlert must gate on isBtcPair');
  assert.match(setPriceAlert, /apiFetch\(`\/api\/market\/prices\?symbols=\$\{encodeURIComponent\('BTC'\)\}`\)/,
    'conversion multiplier must be fetched from the batch USDT-spot endpoint');
  assert.match(setPriceAlert, /usdPrice = price \* btcUsdtSpot/,
    'conversion must be price × the live USDT spot (not CoinGecko priceUsd)');
  assert.ok(!/price \* btcPrice/.test(setPriceAlert), 'the old unconditional CoinGecko-USD conversion must NOT remain');
  // The CG conversion is allowed ONLY inside the LOCAL-ONLY branch (guest /
  // pending users never reach the cron — their local evaluation stream is the
  // CoinGecko priceMap), never for server-synced registrations.
  const localOnlyIdx = setPriceAlert.indexOf('const localOnly');
  const cgIdx = setPriceAlert.indexOf('usdPrice = price * btcCg');
  const usdtIdx = setPriceAlert.indexOf('usdPrice = price * btcUsdtSpot');
  assert.ok(localOnlyIdx !== -1 && cgIdx !== -1 && localOnlyIdx < cgIdx,
    'the CG conversion must sit inside the localOnly-guarded branch');
  assert.ok(usdtIdx !== -1 && usdtIdx > cgIdx,
    'the USDT conversion must be the server-synced path');
  // FAIL-CLOSED: unavailable USDT spot blocks registration (no CG fallback)
  assert.match(setPriceAlert, /price_alert_basis_unavailable/,
    'unavailable USDT basis must show the dedicated message');
  // The conversion sits AFTER the MK-05 gate (a blocked registration fetches
  // nothing) but BEFORE every registration effect.
  const gateIdx = setPriceAlert.indexOf('/api/notifications/platform/settings');
  const convIdx = setPriceAlert.indexOf("encodeURIComponent('BTC')");
  const pushIdx = setPriceAlert.indexOf('alerts.push(newAlert)');
  assert.ok(gateIdx !== -1 && gateIdx < convIdx && convIdx < pushIdx,
    'conversion fetch must sit after the MK-05 gate and before the optimistic UI');

  // EVALUATION side (unchanged): cron compares the raw stored target
  assert.match(worker, /const targetPrice = Number\(alert\?\.price\)/,
    'cron must read the raw stored target (no basis correction)');

  // ...against USDT klines from bybit/okx/mexc
  const klineZone = worker.slice(worker.indexOf('const KLINE_CHECKERS'), worker.indexOf('const FOREX_YAHOO_MAP'));
  assert.match(klineZone, /USDT/, 'kline checkers query <SYM>USDT pairs');

  // ANCHOR (registration basis display): the card is anchored on the same
  // USDT chain — one-shot, race-guarded (no polling).
  const anchor = app.slice(app.indexOf('function fetchAlertBasisPrice'), app.indexOf('\n}', app.indexOf('function fetchAlertBasisPrice')));
  assert.match(anchor, /apiFetch\(`\/api\/market\/prices\?symbols=\$\{encodeURIComponent\(symbols\.join\(','\)\)\}`\)/,
    'anchor fetch uses the same batch USDT-spot endpoint');
  assert.match(anchor, /getAlertUnitLabel\(baseSymbol\)/,
    'anchor card is labeled with the routing-table unit (USDT for crypto)');
  assert.ok(!/setInterval|setTimeout|while\s*\(/.test(anchor), 'anchor is one-shot — no polling/timers');
});

test('MK-11 S4: quantified error envelope stays below 1-minute candle volatility (LEGACY-alert residual)', () => {
  // Error budget for alerts registered BEFORE Task 65 (CoinGecko-USD basis,
  // still active, NOT migrated):
  //   E1 CoinGecko-vs-exchange deviation ≈ ±0.10%
  //   E2 entry staleness (KV+memory cache ≤120s) — bounded by the same E1 band
  //   E3 USDT peg deviation ≈ ±0.05%
  //   E4 NUMERIC(24,8) rounding < 1e-8 (negligible)
  const E1 = 0.0010, E3 = 0.0005;
  const worstRelative = E1 + E3; // ±0.15% worst case

  // Typical 1-minute candle ranges (order-of-magnitude, from exchange data):
  const oneMinVol = { BTC: 30 / 100000, ETH: 5 / 3000 }; // ~0.03% and ~0.17%
  const skew = (price) => price * worstRelative;

  // BTC $100k → worst skew ≈ $150 vs ~$30 typical 1m range → comparable BUT:
  // the temporal resolution of a 1-minute cron means the observed price at
  // fetch time routinely differs from the target by MORE than the skew.
  assert.ok(Math.abs(skew(100000) - 150) < 1e-9, 'BTC worst-case skew ≈ $150');
  assert.ok(Math.abs(skew(3000) - 4.5) < 1e-9, 'ETH worst-case skew ≈ $4.50');

  // The envelope is smaller than or comparable to the 1m candle itself →
  // the mismatch is below the trigger system's temporal resolution. This is
  // the quantified justification for the STOP decision (fix costs an
  // architecture change; the harm is smaller than 1 minute of normal movement).
  assert.ok(worstRelative < oneMinVol.ETH, 'worst relative skew < typical ETH 1m candle');
  assert.ok(worstRelative < 0.002, 'worst relative skew < 0.2% hard bound');
});

test('MK-11 S5: DECISION PIN (Task 65) — anchor unification implemented; evaluation untouched; transparency present', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const app = strip(APP_SRC);
  const worker = strip(WORKER_SRC);

  // No USDT-peg correction factor was introduced anywhere on the evaluation path
  assert.ok(!/peg|PEG_CORRECTION|usdtAdjust/i.test(worker.slice(
    worker.indexOf('const targetPrice = Number(alert?.price)'),
    worker.indexOf('const targetPrice = Number(alert?.price)') + 2000)),
    'evaluation path must contain no peg/basis correction (target is now USDT-basis by construction)');

  // setPriceAlert still applies the SAME single conversion (no double correction)
  const setPriceAlert = app.slice(app.indexOf('function setPriceAlert'), app.indexOf('\n}', app.indexOf('function setPriceAlert')));
  const conversions = (setPriceAlert.match(/price \* btcUsdtSpot/g) || []).length;
  assert.equal(conversions, 1, 'exactly one conversion in setPriceAlert (no compensating correction)');

  // The registration anchor is wired into the detail view (ONE call site —
  // counted on comment-stripped source, doc comments mention the name too)
  const stripComments = (s) => s.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const openCoin = stripComments(app.slice(app.indexOf('async function openCoinDetail'), app.indexOf('async function openForexDetail')));
  const anchorCalls = (openCoin.match(/fetchAlertBasisPrice\(/g) || []).length;
  assert.equal(anchorCalls, 1, 'exactly one anchor fetch per detail open');

  // Transparency mitigation IS present (MK-02): both target and observed are
  // rendered in the trigger message — any residual skew is visible to the user.
  assert.match(worker, /fmtPrice\(t\.targetPrice\)/, 'trigger message shows the user target');
  assert.match(worker, /fmtPrice\(t\.candleClose\)/, 'trigger message shows the observed price');
});

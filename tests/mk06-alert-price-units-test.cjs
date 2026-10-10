/**
 * MK-06 — Correct price unit label for forex / gold / stock alerts
 * ===============================================================
 *
 * Task 62 audit finding MK-06: the trigger message hardcoded "USDT" for EVERY
 * symbol, so a gold alert showed "XAUUSD به 4,050.00 USDT رسید" (gold is quoted
 * in USD), a EURGBP alert labeled the price USDT (it is GBP), and stock alerts
 * (AAPL …) also claimed USDT. Additionally the non-crypto routing table
 * (FOREX_YAHOO_MAP) was duplicated as local consts inside fetchOhlc1m AND
 * fetchSpotPriceUsd — two copies that could drift independently.
 *
 * FIX:
 *  - worker-proxy.js: FOREX_YAHOO_MAP hoisted to module scope (single source);
 *    getAlertUnitLabel() derives the unit FROM THE ROUTING TABLE (yahoo '=X'
 *    → quote currency, futures/stocks → USD, default → USDT); buildMessage
 *    uses it instead of the hardcode.
 *  - app.js: ALERT_NON_CRYPTO_UNITS + frontend getAlertUnitLabel mirror;
 *    triggerAlert passes {unit}.
 *  - i18n.js fa/en: "{observed} {unit}" (no hardcoded USDT).
 *
 * This test pins the REAL backend getAlertUnitLabel + FOREX_YAHOO_MAP (extracted
 * from worker-proxy.js) and the REAL frontend mirror (extracted from app.js),
 * and proves both sides classify EVERY routed symbol identically.
 *
 * Run: node --test tests/mk06-alert-price-units-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');

// ============================================================================
// Extraction
// ============================================================================
function extractLines(src, startRe, endPred) {
  const lines = src.split('\n');
  let startIdx = -1;
  for (let i = 0; i < lines.length; i++) {
    if (startRe.test(lines[i])) { startIdx = i; break; }
  }
  if (startIdx === -1) throw new Error(`start not found for ${startRe}`);
  for (let j = startIdx + 1; j < lines.length; j++) {
    if (endPred(lines[j])) return lines.slice(startIdx, j + 1).join('\n');
  }
  throw new Error(`end not found for ${startRe}`);
}

// Real backend: module-scope FOREX_YAHOO_MAP + getAlertUnitLabel
const WORKER_MAP_AND_LABEL_SRC = extractLines(
  WORKER_SRC,
  /^const FOREX_YAHOO_MAP = \{$/,
  (l) => l === '}'
);
const WORKER_GET_LABEL_SRC = extractLines(
  WORKER_SRC,
  /^function getAlertUnitLabel\(symbol\) \{$/,
  (l) => l === '}'
);

// Real frontend: ALERT_NON_CRYPTO_UNITS + getAlertUnitLabel
const APP_MAP_AND_LABEL_SRC = extractLines(
  APP_SRC,
  /^const ALERT_NON_CRYPTO_UNITS = \{$/,
  (l) => l === '}'
);

function createBackendSandbox() {
  const wrapper = [
    WORKER_MAP_AND_LABEL_SRC,
    WORKER_GET_LABEL_SRC,
    'return { FOREX_YAHOO_MAP, getAlertUnitLabel };',
  ].join('\n');
  return new Function(wrapper)();
}

function createFrontendSandbox() {
  const wrapper = [
    APP_MAP_AND_LABEL_SRC,
    extractLines(APP_SRC, /^function getAlertUnitLabel\(symbol\) \{$/, (l) => l === '}'),
    'return { ALERT_NON_CRYPTO_UNITS, getAlertUnitLabel };',
  ].join('\n');
  return new Function(wrapper)();
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-06 S1: gold (XAUUSD) and silver (XAGUSD) are labeled USD, not USDT', () => {
  const backend = createBackendSandbox();
  assert.equal(backend.getAlertUnitLabel('XAUUSD'), 'USD');
  assert.equal(backend.getAlertUnitLabel('XAGUSD'), 'USD');
});

test('MK-06 S2: FX pairs are labeled with their QUOTE currency', () => {
  const backend = createBackendSandbox();
  assert.equal(backend.getAlertUnitLabel('EURUSD'), 'USD');
  assert.equal(backend.getAlertUnitLabel('USDJPY'), 'JPY');
  assert.equal(backend.getAlertUnitLabel('EURGBP'), 'GBP');
  assert.equal(backend.getAlertUnitLabel('USDCHF'), 'CHF');
  assert.equal(backend.getAlertUnitLabel('AUDNZD'), 'NZD');
  assert.equal(backend.getAlertUnitLabel('GBPCAD'), 'CAD');
});

test('MK-06 S3: stocks are labeled USD', () => {
  const backend = createBackendSandbox();
  for (const s of ['AAPL', 'MSFT', 'NVDA', 'AMZN', 'GOOGL', 'META', 'TSLA', 'NFLX', 'AMD', 'INTC', 'COIN', 'MSTR']) {
    assert.equal(backend.getAlertUnitLabel(s), 'USD', `${s} must be USD`);
  }
});

test('MK-06 S4: crypto symbols remain USDT', () => {
  const backend = createBackendSandbox();
  for (const s of ['BTC', 'ETH', 'SOL', 'PEPE', 'DOGE']) {
    assert.equal(backend.getAlertUnitLabel(s), 'USDT', `${s} must stay USDT`);
  }
});

test('MK-06 S5: symbol normalization (case/whitespace) does not change the unit', () => {
  const backend = createBackendSandbox();
  assert.equal(backend.getAlertUnitLabel('xauusd'), 'USD');
  assert.equal(backend.getAlertUnitLabel('  USDJPY  '), 'JPY');
  assert.equal(backend.getAlertUnitLabel('btc'), 'USDT');
  assert.equal(backend.getAlertUnitLabel(''), 'USDT');
  assert.equal(backend.getAlertUnitLabel(null), 'USDT');
});

test('MK-06 S6: unit derivation reads the SAME routing table the evaluation path uses', () => {
  // getAlertUnitLabel is defined AFTER FOREX_YAHOO_MAP at module scope and
  // references it (single source) — pin the wiring.
  assert.ok(WORKER_GET_LABEL_SRC.includes('FOREX_YAHOO_MAP[s]'),
    'backend getAlertUnitLabel must derive from FOREX_YAHOO_MAP');
  // The map is module-scope (NOT a local inside fetchOhlc1m/fetchSpotPriceUsd)
  const stripComments = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = stripComments(WORKER_SRC);
  const mapDeclarations = (code.match(/^const FOREX_YAHOO_MAP = \{$/gm) || []).length;
  assert.equal(mapDeclarations, 1, 'exactly ONE FOREX_YAHOO_MAP declaration (module scope)');
  // Both consumers route through the shared map
  const ohlc = code.slice(code.indexOf('async function fetchOhlc1m'), code.indexOf('async function fetchSpotPriceUsd'));
  assert.ok(ohlc.includes('FOREX_YAHOO_MAP[normalizedSymbol]'), 'fetchOhlc1m uses the shared map');
  const spot = code.slice(code.indexOf('async function fetchSpotPriceUsd'), code.indexOf('async function fetchSpotPriceUsd') + 12000);
  assert.ok(spot.includes('FOREX_YAHOO_MAP[normalizedSymbol]'), 'fetchSpotPriceUsd uses the shared map');
});

test('MK-06 S7: FRONTEND and BACKEND classify every routed symbol IDENTICALLY', () => {
  const backend = createBackendSandbox();
  const frontend = createFrontendSandbox();
  const symbols = Object.keys(backend.FOREX_YAHOO_MAP)
    .concat(['BTC', 'ETH', 'PEPE', 'SOL', '', 'UNKNOWNXYZ']);
  for (const sym of symbols) {
    const b = backend.getAlertUnitLabel(sym);
    const f = frontend.getAlertUnitLabel(sym);
    assert.equal(f, b, `frontend/backend unit mismatch for ${JSON.stringify(sym)}: ${f} vs ${b}`);
  }
});

test('MK-06 S8: buildMessage renders the derived unit (no USDT hardcode)', () => {
  const stripComments = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = stripComments(WORKER_SRC);
  const bmStart = code.indexOf('const buildMessage = (t) =>');
  const bmEnd = code.indexOf(';', code.indexOf('`', bmStart)) + 1;
  const bm = code.slice(bmStart, bmEnd);
  assert.ok(bm.includes('${getAlertUnitLabel(t.symbol)}'),
    'buildMessage must call getAlertUnitLabel(t.symbol)');
  assert.ok(!/USDT/.test(bm), 'buildMessage must not hardcode USDT');
});

test('MK-06 S9: i18n fa+en templates carry {unit} and no hardcoded USDT', () => {
  const faBlock = I18N_SRC.slice(I18N_SRC.indexOf('    fa: {'), I18N_SRC.indexOf('    en: {'));
  const enBlock = I18N_SRC.slice(I18N_SRC.indexOf('    en: {'));
  const faTpl = faBlock.match(/alert_trigger_msg:\s*'((?:[^'\\]|\\.)*)'/)[1];
  const enTpl = enBlock.match(/alert_trigger_msg:\s*'((?:[^'\\]|\\.)*)'/)[1];
  for (const [lang, tpl] of [['fa', faTpl], ['en', enTpl]]) {
    assert.ok(tpl.includes('{unit}'), `${lang} template must contain {unit}`);
    assert.ok(!tpl.includes('USDT'), `${lang} template must not hardcode USDT`);
  }
});

test('MK-06 S10: frontend triggerAlert passes the derived unit to t()', async () => {
  const stripComments = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = stripComments(APP_SRC);
  const taStart = code.indexOf('async function triggerAlert(');
  const ta = code.slice(taStart, code.indexOf('\n}', taStart));
  assert.ok(ta.includes('unit: getAlertUnitLabel(alert.symbol)'),
    'triggerAlert must pass unit: getAlertUnitLabel(alert.symbol)');
  assert.ok(ta.includes('target: fmtTriggerPrice(alert.price)'), 'target param preserved (MK-02)');
  assert.ok(ta.includes('observed: fmtTriggerPrice(currentPrice)'), 'observed param preserved (MK-02)');
});

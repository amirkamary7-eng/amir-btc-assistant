/**
 * MK-02 — Alert trigger message shows target AND observed price distinctly
 * =====================================================================
 *
 * Task 62 audit (user Bug 2): the trigger message rendered ONLY the observed
 * candle close ("قیمت BTC به 62,200 USDT رسید") while the user set 62,000.
 * With the 1-minute cron latency + intraminute movement, the observed value
 * legitimately differs from the target — but the message presented the
 * observed value as if it were the price the user asked for, with no
 * distinction and no way to see the actual target.
 *
 * FIX (message semantics only — trigger logic untouched):
 *  - worker-proxy.js buildMessage: renders BOTH the target (t.targetPrice)
 *    and the observed (t.candleClose), distinctly labeled. Same source used
 *    for in-app notifications AND telegram queue payloads.
 *  - app.js triggerAlert: passes target (alert.price) + observed
 *    (currentPrice) to t('alert_trigger_msg', ...).
 *  - i18n.js fa/en: alert_trigger_msg now has {target} + {observed}.
 *
 * NOT changed (verified by this test where possible): cross-detection,
 * candleHigh/candleLow usage, CAS markTriggeredBulk, idempotency
 * (ON CONFLICT), retry, processing order, metadata shape.
 *
 * Run: node --test tests/mk02-alert-target-observed-price-test.cjs
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

// Real buildMessage + fmtPrice (arrow consts inside runScheduledAlertsBaseline).
// MK-06 note: buildMessage now derives the unit via getAlertUnitLabel — that
// dependency is INJECTED here as a stub (units are pinned separately by
// tests/mk06-alert-price-units-test.cjs); the extraction stops at the closing
// backtick of the template literal.
const BUILD_MESSAGE_SRC = extractLines(
  WORKER_SRC,
  /const fmtPrice = \(v\) =>/,
  (l) => /`\s*;\s*$/.test(l)
);

// Real triggerAlert (top-level async function in app.js)
function extractFn(src, name) {
  const lines = src.split('\n');
  const startRe = new RegExp(`^async function ${name}\\(`);
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
const TRIGGER_ALERT_SRC = extractFn(APP_SRC, 'triggerAlert');

// Real t() from i18n.js + the real fa/en template values
const T_SRC = extractLines(I18N_SRC, /^function t\(key, params\) \{$/, (l) => l === '}');
function extractTemplate(lang) {
  // First match inside the requested language block (fa block precedes en block)
  const blockStart = I18N_SRC.indexOf(`    ${lang}: {`);
  const blockEnd = I18N_SRC.indexOf('    en: {') > blockStart && lang === 'fa'
    ? I18N_SRC.indexOf('    en: {') : I18N_SRC.length;
  const block = I18N_SRC.slice(blockStart, blockEnd);
  const m = block.match(/alert_trigger_msg:\s*'((?:[^'\\]|\\.)*)'/);
  if (!m) throw new Error(`alert_trigger_msg (${lang}) not found`);
  return m[1];
}
const FA_TEMPLATE = extractTemplate('fa');
const EN_TEMPLATE = extractTemplate('en');

// ============================================================================
// Sandbox builders
// ============================================================================
function createBackendSandbox() {
  const wrapper = [
    'const console = { warn: () => {} };',
    'const getAlertUnitLabel = (sym) => "USDT";', // injected stub (units pinned by mk06 test)
    BUILD_MESSAGE_SRC,
    'return { buildMessage, fmtPrice };',
  ].join('\n');
  return new Function(wrapper)();
}

function createFrontendSandbox(alertObj, currentPrice) {
  const captured = { tCalls: [], addNotification: [], popup: null };
  const storage = new Map();
  const wrapper = [
    'let alerts = __g.alerts;',
    'let _lastAlertSyncTs = 0;',
    'const localStorage = __g.localStorage;',
    'const getAlertUnitLabel = (sym) => "USDT";', // injected stub (units pinned by mk06 test)
    'const t = (key, params) => { __g.captured.tCalls.push({ key, params }); return "T(" + key + ")"; };',
    'const getTg = () => ({ HapticFeedback: { notificationOccurred: () => {} }, showPopup: (p) => { __g.captured.popup = p; } });',
    'const addNotification = (title, body, opts) => { __g.captured.addNotification.push({ title, body, opts }); };',
    'const loadNotificationsFromServer = async () => {};',
    'const renderActiveAlerts = () => {};',
    'let _currentDetailSymbol = __g.alerts[0]?.symbol || null;',
    TRIGGER_ALERT_SRC,
    'return { triggerAlert, captured: __g.captured };',
  ].join('\n');
  const sandbox = new Function('__g', wrapper)({
    alerts: [alertObj],
    localStorage: { setItem: (k, v) => storage.set(k, v), getItem: (k) => storage.get(k) ?? null },
    captured,
  });
  return { ...sandbox, _storage: storage };
}

// Real t() evaluation with the real templates injected
function createI18nSandbox(lang) {
  const templates = { fa: FA_TEMPLATE, en: EN_TEMPLATE };
  const wrapper = [
    `const i18n = { fa: { alert_trigger_msg: ${JSON.stringify(templates.fa)} }, en: { alert_trigger_msg: ${JSON.stringify(templates.en)} } };`,
    `let currentLang = '${lang}';`,
    T_SRC,
    'return { t };',
  ].join('\n');
  return new Function(wrapper)();
}

// ============================================================================
// Scenarios
// ============================================================================
test('MK-02 S1 (repro): target 62000 / observed 62200 — BOTH shown, distinctly labeled', () => {
  const sb = createBackendSandbox();
  const msg = sb.buildMessage({
    symbol: 'BTC', targetPrice: 62000, candleClose: 62200,
  });
  // The TARGET the user set is rendered and labeled as the target level
  assert.match(msg, /62,000\.00/, 'target 62000 must appear (formatted)');
  assert.match(msg, /سطح هدف/, 'target must be labeled as target level');
  // The OBSERVED price is rendered and labeled as observed-at-trigger
  assert.match(msg, /62,200\.00/, 'observed 62200 must appear (formatted)');
  assert.match(msg, /مشاهده‌شده/, 'observed must be labeled as observed-at-trigger');
  // Both on separate lines (readable on Telegram)
  const targetLine = msg.split('\n').find(l => l.includes('62,000.00'));
  const observedLine = msg.split('\n').find(l => l.includes('62,200.00'));
  assert.ok(targetLine && observedLine && targetLine !== observedLine, 'target and observed must be distinct lines');
});

test('MK-02 S2: exact hit (target == observed) shows both, equal and honest', () => {
  const sb = createBackendSandbox();
  const msg = sb.buildMessage({ symbol: 'ETH', targetPrice: 3000, candleClose: 3000 });
  assert.match(msg, /سطح هدف 3,000\.00/);
  assert.match(msg, /3,000\.00 USDT/);
  const occurrences = msg.split('3,000.00').length - 1;
  assert.equal(occurrences, 2, 'both target and observed show the same honest value');
});

test('MK-02 S3: below-direction sub-1 crypto price uses fixed(6) for BOTH numbers', () => {
  const sb = createBackendSandbox();
  const msg = sb.buildMessage({ symbol: 'PEPE', targetPrice: 0.000012, candleClose: 0.0000115 });
  assert.match(msg, /0\.000012/);
  assert.match(msg, /0\.000012\b.*\n/); // sanity: line-based
  assert.match(msg, /0\.000012/, 'target rendered');
  // 0.0000115 → toFixed(6) rounds to 0.000012 too — verify no crash + template complete
  assert.match(msg, /مشاهده‌شده/);
  assert.match(msg, /USDT/);
});

test('MK-02 S4 (source): buildMessage is the SINGLE message source for in-app AND telegram', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const code = strip(WORKER_SRC);
  // In-app path
  assert.match(code, /messagesArr = miniAppAlerts\.map\(buildMessage\)/,
    'in-app notifications must map buildMessage');
  // Telegram path
  assert.match(code, /message: buildMessage\(t\)/,
    'telegram queue payloads must use buildMessage');
  // fmtPrice used by buildMessage (not ad-hoc formatting)
  const bmBlock = strip(BUILD_MESSAGE_SRC);
  assert.match(bmBlock, /fmtPrice\(t\.targetPrice\)/);
  assert.match(bmBlock, /fmtPrice\(t\.candleClose\)/);
});

test('MK-02 S5: i18n fa+en templates use {target}+{observed} and no legacy {price}', () => {
  for (const [lang, tpl] of [['fa', FA_TEMPLATE], ['en', EN_TEMPLATE]]) {
    assert.ok(tpl.includes('{target}'), `${lang} template must contain {target}`);
    assert.ok(tpl.includes('{observed}'), `${lang} template must contain {observed}`);
    assert.ok(!tpl.includes('{price}'), `${lang} template must NOT contain legacy {price}`);
  }
  // Real t() renders both values through the real interpolation
  // (unit param provided by getAlertUnitLabel — pinned separately by the mk06 test)
  const sbFa = createI18nSandbox('fa');
  const out = sbFa.t('alert_trigger_msg', { symbol: 'BTC', target: '62,000.00', observed: '62,200.00', unit: 'USDT' });
  assert.match(out, /62,000\.00/);
  assert.match(out, /62,200\.00/);
  assert.ok(!out.includes('{target}') && !out.includes('{observed}'), 'placeholders fully interpolated');
  const sbEn = createI18nSandbox('en');
  const outEn = sbEn.t('alert_trigger_msg', { symbol: 'BTC', target: '62,000.00', observed: '62,200.00', unit: 'USDT' });
  assert.match(outEn, /target price of 62,000\.00/);
  assert.match(outEn, /Observed price at trigger time: 62,200\.00 USDT/);
});

test('MK-02 S6: frontend triggerAlert passes alert.price as target and currentPrice as observed', async () => {
  const alertObj = { id: 'a1', symbol: 'BTC', price: 62000, direction: 'above' };
  const sb = createFrontendSandbox(alertObj, 62200);
  await sb.triggerAlert(alertObj, 62200);
  const call = sb.captured.tCalls.find(c => c.key === 'alert_trigger_msg');
  assert.ok(call, 'triggerAlert must call t(alert_trigger_msg, ...)');
  assert.equal(call.params.symbol, 'BTC');
  assert.equal(call.params.target, '62,000.00', 'target must come from alert.price');
  assert.equal(call.params.observed, '62,200.00', 'observed must come from currentPrice');
  // In-app notification + popup still wired with the same message source
  assert.equal(sb.captured.addNotification.length, 1);
  assert.ok(sb.captured.popup, 'Telegram popup must still be shown');
});

test('MK-02 S7: formatting rules preserved (>=1 → 2-dp locale, <1 → fixed(6))', () => {
  const sb = createBackendSandbox();
  assert.equal(sb.fmtPrice(62000), '62,000.00');
  assert.equal(sb.fmtPrice(1234.5), '1,234.50');
  assert.equal(sb.fmtPrice(0.5), '0.500000');
  assert.equal(sb.fmtPrice(0.00001234), '0.000012');
  // Backend trigger-detection logic untouched (source pin)
  const strip = WORKER_SRC.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  assert.match(strip, /const targetPrice = Number\(alert\?\.price\)/, 'target extraction unchanged');
  assert.match(strip, /candleHigh >= targetPrice/, 'cross detection via candleHigh unchanged');
  assert.match(strip, /candleLow <= targetPrice/, 'cross detection via candleLow unchanged');
});

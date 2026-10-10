/**
 * MK-05 — Price-alert registration gate on notification settings (user decision)
 * ============================================================================
 *
 * Product decision (final): if the user has disabled price-alert notifications
 * and tries to register a new price alert:
 *   - the alert must NOT be registered without the user's knowledge;
 *   - a clear message is shown BEFORE registration:
 *     «اعلان‌های هشدار قیمت را غیرفعال کرده‌اید. در این حالت، اعلان فعال‌شدن
 *      قیمت برای شما ارسال نمی‌شود. ابتدا اعلان‌ها را فعال کنید و سپس هشدار
 *      قیمت را ثبت کنید.»
 *   - while notifications are disabled, registration is STOPPED;
 *   - the user can re-enable via the EXISTING settings path, then re-register;
 *   - the REAL settings state is read from the authoritative current source —
 *     never from a cache or defaults;
 *   - if notifications are enabled, registration behaves exactly as before;
 *   - the alert execution logic, cron, target price, membership and quotas are
 *     unchanged;
 *   - no Telegram confirmation is sent for a blocked registration (nothing is
 *     registered).
 *
 * Implementation: a gate at the top of the registration effect window in
 * setPriceAlert — after input validation, BEFORE the optimistic UI, the local
 * list mutation, syncAlertToServer and any notification/receipt. State is read
 * via GET /api/notifications/platform/settings (the same channel-preference
 * source the settings UI writes and the trigger cron reads: ch_price_alert ∈
 * {mini_app, telegram, both, none}). Unknown state (fetch failed / malformed)
 * fails CLOSED — a registration requires a known-enabled state.
 *
 * Run: node --test tests/mk05-alert-registration-notif-gate-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = path.join(__dirname, '..');
const APP_SRC = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
const I18N_SRC = fs.readFileSync(path.join(ROOT, 'i18n.js'), 'utf8');

// ============================================================================
// Extraction: REAL setPriceAlert
// ============================================================================
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
const SET_PRICE_ALERT_SRC = extractFn(APP_SRC, 'setPriceAlert');

// Sandbox: the REAL setPriceAlert with mocked leaves. The world object is
// built FIRST and captured by the sandbox so state stays shared.
function makeWorld(opts = {}) {
  const world = {
    alerts: [],
    apiCalls: [],
    alertsShown: [],
    notifications: [],
    syncs: [],
    rendered: [],
    haptics: [],
    chPriceAlert: opts.chPriceAlert,
    guest: opts.guest === true,
    serverId: 'srv-42',
    price: opts.price ?? '62000',
  };
  world.__el = (id) => (id === 'alert-price' ? { value: world.price } : { innerText: 'BTC Bitcoin' });
  world.t = (k) => (k === 'price_alert_notif_disabled' ? 'DISABLED_MSG'
    : k === 'price_alert_notif_check_failed' ? 'CHECK_FAILED_MSG' : k);
  world.settingsResponse = () => {
    if (world.chPriceAlert === null) throw new Error('network down');
    return { status: 'success', settings: { ch_price_alert: world.chPriceAlert, ch_analysis: 'both' } };
  };
  world.localStorage = { setItem: () => {}, getItem: () => null };

  const wrapper = [
    'let alerts = __g.alerts;',
    'let currentAlertDirection = "above";',
    'const API_BASE = "https://test.local";',
    'const UserContext = { isGuest: () => __g.guest };',
    'const document = { getElementById: (id) => __g.__el(id) };',
    'const _currentDetailSymbol = "BTC";',
    'const parseBtcPairSymbol = (s) => null;',
    'const allCoins = [{ symbol: "BTC", priceUsd: 100000 }];',
    'const getUserId = () => __g.guest ? "guest_1" : "700400";',
    'const t = (k) => __g.t(k);',
    'const localStorage = __g.localStorage;',
    'const renderActiveAlerts = (sym) => { __g.rendered.push(sym); };',
    'const addNotification = (title, body, options) => { __g.notifications.push({ title, body, options }); };',
    'const getTg = () => ({ HapticFeedback: { notificationOccurred: (k) => __g.haptics.push(k) }, showPopup: (p) => {} });',
    'const syncAlertToServer = async (a) => { if (__g.guest) return a; __g.syncs.push(a.symbol); a.serverId = __g.serverId; return a; };',
    'const showMiniToast = (m) => {};',
    'const apiFetch = async (url) => { __g.apiCalls.push(url); if (url === "/api/notifications/platform/settings") return __g.settingsResponse(); throw new Error("unexpected url " + url); };',
    'const alert = (m) => { __g.alertsShown.push(m); };',
    'const console = { warn: () => {}, log: () => {} };',
    SET_PRICE_ALERT_SRC,
    'return { setPriceAlert, __getAlerts: () => alerts };',
  ].join('\n');
  const sandbox = new Function('__g', wrapper)(world);
  world.sandbox = sandbox;
  return world;
}

const settle = () => new Promise(r => setImmediate(r));

// ============================================================================
// Scenarios
// ============================================================================
test('MK-05 S1: ENABLED (ch_price_alert=both) → registration proceeds per current behavior', async () => {
  const w = makeWorld({ chPriceAlert: 'both' });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1, 'alert registered');
  assert.equal(w.alerts[0].symbol, 'BTC');
  assert.equal(w.alerts[0].price, 62000);
  assert.equal(w.alerts[0].direction, 'above');
  assert.equal(w.apiCalls.filter(u => u === '/api/notifications/platform/settings').length, 1,
    'the gate read the authoritative source');
  assert.equal(w.syncs.length, 1, 'server sync ran (current behavior)');
  assert.equal(w.notifications.length, 1, 'registration receipt notification (in-app) added');
  assert.equal(w.alertsShown.length, 0, 'no blocking message');
});

test('MK-05 S2: DISABLED (ch_price_alert=none) → registration STOPPED with the decision message', async () => {
  const w = makeWorld({ chPriceAlert: 'none' });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 0, 'NO alert registered (no optimistic UI)');
  assert.equal(w.syncs.length, 0, 'NO server sync');
  assert.equal(w.notifications.length, 0, 'NO notification/receipt — nothing was registered');
  assert.equal(w.haptics.length, 0, 'no success haptic');
  assert.deepEqual(w.alertsShown, ['DISABLED_MSG'], 'the exact decision message is shown');
});

test('MK-05 S3: settings read fresh on EVERY attempt — a just-disabled setting blocks immediately', async () => {
  const w = makeWorld({ chPriceAlert: 'both' });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1, 'first attempt (enabled) registered');
  // User disables notifications, then tries again
  w.chPriceAlert = 'none';
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 1, 'second attempt (now disabled) blocked — no new alert');
  assert.equal(w.apiCalls.filter(u => u === '/api/notifications/platform/settings').length, 2,
    'the state was re-read — not served from any cache');
  assert.deepEqual(w.alertsShown, ['DISABLED_MSG']);
  // And re-enabling restores registration
  w.chPriceAlert = 'telegram';
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 2, 're-enabled (telegram channel) → registration works again');
});

test('MK-05 S4: UNKNOWN state (settings fetch failed) → fail CLOSED, nothing registered', async () => {
  const w = makeWorld({ chPriceAlert: null }); // settings endpoint unreachable
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.alerts.length, 0, 'no registration on an unverifiable state');
  assert.equal(w.syncs.length, 0);
  assert.deepEqual(w.alertsShown, ['CHECK_FAILED_MSG'], 'honest failure message, not silence');
});

test('MK-05 S5: guest flow unchanged (gate does not apply — no server settings exist)', async () => {
  const w = makeWorld({ chPriceAlert: 'irrelevant', guest: true });
  await w.sandbox.setPriceAlert();
  await settle(); await settle();
  assert.equal(w.apiCalls.filter(u => u === '/api/notifications/platform/settings').length, 0,
    'no settings fetch for guests');
  assert.equal(w.alerts.length, 1, 'guest registration proceeds (current behavior)');
  assert.equal(w.syncs.length, 0, 'guest sync still skipped by syncAlertToServer semantics (mocked)');
});

test('MK-05 S6 (source pins): gate placement, authoritative source, exact message, cron untouched', () => {
  const strip = (src) => src.split('\n').map(l => l.replace(/^\s*\/\/.*$/, '')).join('\n');
  const fn = strip(SET_PRICE_ALERT_SRC);
  // 1. Gate reads the AUTHORITATIVE platform settings endpoint (not the cache)
  assert.ok(fn.includes("apiFetch('/api/notifications/platform/settings')"),
    'gate must read /api/notifications/platform/settings');
  assert.ok(!fn.includes('_nsSettingsCache'), 'must NOT use the in-memory settings cache');
  assert.ok(!fn.includes('getNotifPrefs'), 'must NOT use the legacy prefs getter');
  assert.ok(!fn.includes('localStorage.getItem'), 'must NOT use localStorage for the decision');
  // 2. Gate sits BEFORE every registration effect
  const gateIdx = fn.indexOf('/api/notifications/platform/settings');
  const optimisticIdx = fn.indexOf('alerts.push(newAlert)');
  const syncIdx = fn.indexOf('syncAlertToServer(newAlert)');
  const notifIdx = fn.indexOf('addNotification(t(\'price_alert\')');
  assert.ok(gateIdx !== -1 && gateIdx < optimisticIdx, 'gate precedes the optimistic list mutation');
  assert.ok(gateIdx < syncIdx, 'gate precedes the server sync');
  assert.ok(gateIdx < notifIdx, 'gate precedes the registration notification');
  // 3. i18n: the EXACT fa decision text + en translation
  const faBlock = I18N_SRC.slice(I18N_SRC.indexOf('    fa: {'), I18N_SRC.indexOf('    en: {'));
  const enBlock = I18N_SRC.slice(I18N_SRC.indexOf('    en: {'));
  const exactFa = 'اعلان‌های هشدار قیمت را غیرفعال کرده‌اید. در این حالت، اعلان فعال‌شدن قیمت برای شما ارسال نمی‌شود. ابتدا اعلان‌ها را فعال کنید و سپس هشدار قیمت را ثبت کنید.';
  assert.ok(faBlock.includes(exactFa), 'fa message must be the exact decision text');
  assert.ok(faBlock.includes('price_alert_notif_check_failed'), 'fa unknown-state message present');
  const enVal = enBlock.match(/price_alert_notif_disabled: '([^']*)'/)?.[1];
  assert.ok(enVal && enVal.length > 40, 'en translation present and meaningful');
  // 4. Backend trigger partition logic untouched
  const worker = strip(fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8'));
  assert.match(worker, /ch_price_alert AS pref FROM notification_settings/,
    'cron partition query unchanged');
  assert.match(worker, /userChannel === 'none'\) continue/, "'none' still skips delivery (cron unchanged)");
  // 5. The settings save path is untouched (no other setting modified)
  assert.ok(!fn.includes('saveNotifPrefs'), 'the gate must not modify any settings');
});

/**
 * M1+M2 Auth Defense-in-Depth Regression Test
 *
 * Verifies that the PROTECTED_PATHS regex in worker-proxy.js correctly:
 * - Matches newly-protected routes (calendar/reminders, cosmetics/mine,
 *   cosmetics/:id/(purchase|activate), membership/*, rewards/*)
 * - Does NOT match intentionally public routes (cosmetics catalog,
 *   membership/rules, membership/requirement, calendar/events)
 *
 * This is a SOURCE-LEVEL test (reads worker-proxy.js source text).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, '..', 'worker-proxy.js'), 'utf8');

// Extract the PROTECTED_PATHS regex from source
const regexMatch = WORKER_SRC.match(/const PROTECTED_PATHS = (\/\^.*\/);/);
assert.ok(regexMatch, 'PROTECTED_PATHS regex must exist in worker-proxy.js');
const PROTECTED_PATHS = new RegExp(regexMatch[1].slice(1, -1));

// ===== M1: Calendar reminders GET + DELETE now protected =====
test('M1: calendar/reminders is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/calendar/reminders'),
    'GET /api/calendar/reminders must be protected');
  assert.ok(PROTECTED_PATHS.test('/api/calendar/reminders/some-event-key'),
    'DELETE /api/calendar/reminders/:eventKey must be protected');
});

test('M1: calendar/events remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/calendar/events'),
    'GET /api/calendar/events must remain public');
});

// ===== M2: Cosmetics routes =====
test('M2: cosmetics/mine is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/cosmetics/mine'),
    'GET /api/cosmetics/mine must be protected');
});

test('M2: cosmetics/:id/purchase is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/cosmetics/abc123/purchase'),
    'POST /api/cosmetics/:id/purchase must be protected');
});

test('M2: cosmetics/:id/activate is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/cosmetics/abc123/activate'),
    'POST /api/cosmetics/:id/activate must be protected');
});

test('M2: cosmetics catalog (GET /api/cosmetics) remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/cosmetics'),
    'GET /api/cosmetics (catalog) must remain public');
});

// ===== M2: Membership routes =====
test('M2: membership/status is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/membership/status'),
    'GET /api/membership/status must be protected');
});

test('M2: membership/request is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/membership/request'),
    'GET+POST /api/membership/request must be protected');
});

test('M2: membership/welcome-shown is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/membership/welcome-shown'),
    'POST /api/membership/welcome-shown must be protected');
});

test('M2: membership/rules/accept is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/membership/rules/accept'),
    'POST /api/membership/rules/accept must be protected');
});

test('M2: membership/rules/accepted is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/membership/rules/accepted'),
    'GET /api/membership/rules/accepted must be protected');
});

test('M2: membership/rules remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/membership/rules'),
    'GET /api/membership/rules (rules document) must remain public');
});

test('M2: membership/requirement remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/membership/requirement'),
    'GET /api/membership/requirement must remain public');
});

// ===== M2: Rewards routes =====
test('M2: rewards/vpn/plans is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/rewards/vpn/plans'),
    'GET /api/rewards/vpn/plans must be protected');
});

test('M2: rewards/vpn/purchase is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/rewards/vpn/purchase'),
    'POST /api/rewards/vpn/purchase must be protected');
});

test('M2: rewards/purchases is protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/rewards/purchases'),
    'GET /api/rewards/purchases must be protected');
});

// ===== Existing protected routes still work =====
test('Existing: wallet is still protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/wallet'));
  assert.ok(PROTECTED_PATHS.test('/api/wallet/balance'));
});

test('Existing: notifications is still protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/notifications'));
});

test('Existing: alerts is still protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/alerts'));
  assert.ok(PROTECTED_PATHS.test('/api/alerts/quota'));
});

test('Existing: tickets is still protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/tickets'));
});

test('Existing: wheel is still protected', () => {
  assert.ok(PROTECTED_PATHS.test('/api/wheel/status'));
  assert.ok(PROTECTED_PATHS.test('/api/wheel/spin'));
});

// ===== Public routes remain public =====
test('Public: health remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/health'));
});

test('Public: market remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/market'));
  assert.ok(!PROTECTED_PATHS.test('/api/market/price'));
});

test('Public: analyses remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/analyses'));
});

test('Public: content remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/content/about'));
});

test('Public: advertisements/popups remains public', () => {
  assert.ok(!PROTECTED_PATHS.test('/api/advertisements/popups'));
});

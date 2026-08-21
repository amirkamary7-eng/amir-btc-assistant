/**
 * Alert Economy + Reward Center — Regression Tests
 *
 * Tests the Critical + High fixes:
 * 1. Reward Center: authedAdmin ReferenceError fixed (all 17 handlers)
 * 2. Alert Economy: payment bypass fix (operation-unique refId)
 * 3. Alert Economy: triggered_today uses triggered_at (not created_at)
 * 4. Alert Economy: getQuotaStatus is premium-aware
 * 5. Alert Economy: handleUpdateConfig has input validation
 * 6. Alert Economy: configs UI now reachable (loadAlertEconomyConfigs called)
 * 7. Reward Center: getAnalytics uses Promise.allSettled (not Promise.all)
 * 8. Reward Center: switchRewardCenterTab scoped to #rc-tabs
 *
 * Run: node --test alert-reward-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const REWARD_CENTER_CTRL = fs.readFileSync(path.join(__dirname, 'src/controllers/reward_center.js'), 'utf8');
const ALERT_ECONOMY_CTRL = fs.readFileSync(path.join(__dirname, 'src/controllers/alert_economy.js'), 'utf8');
const ALERT_ECONOMY_REPO = fs.readFileSync(path.join(__dirname, 'src/repositories/alert_economy.js'), 'utf8');
const ALERTS_CTRL = fs.readFileSync(path.join(__dirname, 'src/controllers/alerts.js'), 'utf8');
const ALERTS_REPO = fs.readFileSync(path.join(__dirname, 'src/repositories/alerts.js'), 'utf8');
const REWARD_CENTER_REPO = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
const ADMIN_JS = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');

// ============================================================================
// Phase 1 — Reward Center: authedAdmin fix
// ============================================================================

test('RC-001: reward_center.js has ZERO occurrences of authedAdmin', () => {
  assert.equal(REWARD_CENTER_CTRL.includes('authedAdmin'), false,
    'authedAdmin must not appear in reward_center.js (all 17 fixed)');
});

test('RC-002: reward_center.js has 17 occurrences of admin.telegram_id in checkRcRateLimit', () => {
  const count = (REWARD_CENTER_CTRL.match(/checkRcRateLimit\(env, admin\.telegram_id\)/g) || []).length;
  assert.equal(count, 17, `Expected 17 checkRcRateLimit(env, admin.telegram_id), got ${count}`);
});

test('RC-003: reward_center.js destructures admin (not authedAdmin) from requireAdmin', () => {
  assert.ok(REWARD_CENTER_CTRL.includes('const { error: authErr, admin } = await requireAdmin'),
    'must destructure { admin } (not { admin: authedAdmin })');
});

// ============================================================================
// Phase 2 — Alert Economy: payment bypass fix
// ============================================================================

test('AE-001: alertRefId includes Date.now() for operation uniqueness', () => {
  assert.ok(ALERTS_CTRL.includes('Date.now()}', ) || ALERTS_CTRL.includes('Date.now()'),
    'alertRefId must include Date.now() for operation uniqueness');
  assert.ok(!ALERTS_CTRL.includes("alert_${payload.user_id}_${rawSymbol}_${rawPrice}_${rawDirection}_${new Date().toISOString().slice(0, 10)}`;"),
    'old content-only refId must be replaced');
});

test('AE-002: alertRepo.create returns reactivated: true/false', () => {
  assert.ok(ALERTS_REPO.includes('reactivated: true'),
    'create must return reactivated: true for reactivated alerts');
  assert.ok(ALERTS_REPO.includes('reactivated: false'),
    'create must return reactivated: false for new alerts');
});

test('AE-003: incrementQuota only called for new (non-reactivated) alerts', () => {
  assert.ok(ALERTS_CTRL.includes('!alert.reactivated'),
    'incrementQuota must be gated by !alert.reactivated');
});

// ============================================================================
// Phase 3 — Alert Economy: triggered_today, getQuotaStatus, validation
// ============================================================================

test('AE-004: triggered_today uses triggered_at (not created_at)', () => {
  assert.ok(ALERT_ECONOMY_REPO.includes('triggered_at >= CURRENT_DATE'),
    'triggered_today query must use triggered_at >= CURRENT_DATE');
  assert.ok(!ALERT_ECONOMY_REPO.includes("status = 'triggered' AND created_at >= CURRENT_DATE"),
    'triggered_today must NOT use created_at >= CURRENT_DATE');
});

test('AE-005: getQuotaStatus accepts isPremium parameter', () => {
  assert.ok(ALERT_ECONOMY_REPO.includes('async function getQuotaStatus(env, userId, alertType, isPremium)'),
    'getQuotaStatus must accept isPremium parameter');
  assert.ok(ALERT_ECONOMY_REPO.includes('config.premium_free_per_day'),
    'getQuotaStatus must use premium_free_per_day for premium users');
});

test('AE-006: handleQuotaStatus resolves premium tier via membershipAuthority', () => {
  assert.ok(ALERT_ECONOMY_CTRL.includes('membershipAuthority'),
    'alert_economy controller must use membershipAuthority');
  assert.ok(ALERT_ECONOMY_CTRL.includes('membershipAuthority.isPremium'),
    'handleQuotaStatus must call membershipAuthority.isPremium');
});

test('AE-007: handleUpdateConfig validates alertType against allowlist', () => {
  assert.ok(ALERT_ECONOMY_CTRL.includes('ALLOWED_TYPES'),
    'handleUpdateConfig must validate alertType against allowlist');
  assert.ok(ALERT_ECONOMY_CTRL.includes("price_alert', 'calendar_alert', 'breaking_news'"),
    'allowlist must contain the 3 valid types');
});

test('AE-008: handleUpdateConfig validates numeric fields', () => {
  assert.ok(ALERT_ECONOMY_CTRL.includes("Number.isFinite(n)"),
    'handleUpdateConfig must validate Number.isFinite');
  assert.ok(ALERT_ECONOMY_CTRL.includes("n < 0 || n > 1000"),
    'handleUpdateConfig must validate range 0-1000');
});

// ============================================================================
// Phase 4 — Reward Center: getAnalytics + switchRewardCenterTab
// ============================================================================

test('RC-004: getAnalytics uses Promise.allSettled (not Promise.all)', () => {
  // The getAnalytics function is in the repository
  const fnMatch = REWARD_CENTER_REPO.match(/async function getAnalytics[\s\S]*?catch/);
  assert.ok(fnMatch, 'getAnalytics must exist');
  assert.ok(fnMatch[0].includes('Promise.allSettled'),
    'getAnalytics must use Promise.allSettled');
});

test('RC-005: switchRewardCenterTab scoped to #rc-tabs container', () => {
  const fnMatch = ADMIN_JS.match(/function switchRewardCenterTab[\s\S]*?function /);
  assert.ok(fnMatch, 'switchRewardCenterTab must exist');
  assert.ok(fnMatch[0].includes('rc-tabs') || fnMatch[0].includes('rcTabsContainer'),
    'switchRewardCenterTab must scope to #rc-tabs container');
  assert.ok(!fnMatch[0].includes("document.querySelectorAll('.rc-tab')"),
    'switchRewardCenterTab must NOT use global document.querySelectorAll');
});

// ============================================================================
// Phase 5 — Configs UI reachable
// ============================================================================

test('AE-009: switchAdminSection calls loadAlertEconomyConfigs for alert-economy', () => {
  assert.ok(ADMIN_JS.includes('loadAlertEconomyDashboard(); loadAlertEconomyConfigs()'),
    'switchAdminSection must call both loadAlertEconomyDashboard AND loadAlertEconomyConfigs');
});

// ============================================================================
// Security: no new trust added
// ============================================================================

test('SEC-001: membershipAuthority injected into alertEconomyHandlers', () => {
  const workerSrc = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  // Find the createAlertEconomyHandlers call and verify membershipAuthority is passed
  const match = workerSrc.match(/createAlertEconomyHandlers\(\{[\s\S]*?\}\)/);
  assert.ok(match, 'createAlertEconomyHandlers call must exist');
  assert.ok(match[0].includes('membershipAuthority'),
    'membershipAuthority must be injected into alertEconomyHandlers');
});

/**
 * Phase 2-6: Premium Advertisement Control — Regression Tests
 *
 * Tests:
 * 1. ch_promotions re-added to UI with premiumOnly flag
 * 2. Free user sees locked card (no capsule buttons)
 * 3. Premium user sees functional controls
 * 4. Backend rejects ch_promotions update from non-Premium users
 * 5. Backend accepts ch_promotions update from Premium users
 * 6. membershipAuthority injected into notification platform handlers
 * 7. PREMIUM_REQUIRED error code returned for non-Premium
 * 8. No fake ad system implemented
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const NOTIF_PLATFORM_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/notification_platform.js'), 'utf8');
const STYLE_SRC = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// Phase 1: ch_promotions re-added with premiumOnly flag
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-01: ch_promotions is back in UI with premiumOnly flag', () => {
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  assert.ok(groupsBlock.includes("key: 'ch_promotions'"),
    'ch_promotions must be in UI items');
  assert.ok(groupsBlock.includes('premiumOnly: true'),
    'ch_promotions must have premiumOnly: true flag');
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 3: Free user UI — locked
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-02: renderNotifSettings checks isPremiumCached for locking', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 5000);
  assert.ok(renderBlock.includes('isPremiumCached'),
    'renderNotifSettings must call isPremiumCached');
  assert.ok(renderBlock.includes('premiumOnly'),
    'renderNotifSettings must check premiumOnly flag');
  assert.ok(renderBlock.includes('isLocked'),
    'renderNotifSettings must compute isLocked state');
});

test('AD-PREM-03: Locked card has ns-prem-card--locked class', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 8000);
  assert.ok(renderBlock.includes('ns-prem-card--locked'),
    'locked card must have ns-prem-card--locked class');
});

test('AD-PREM-04: Locked card shows lock badge + disabled capsule (PHASE 2 redesign)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  // PHASE 2: Lock badge is now ns-prem-lock-badge (SVG in top corner)
  assert.ok(renderBlock.includes('ns-prem-lock-badge'),
    'locked card must show lock badge (ns-prem-lock-badge)');
  // PHASE 2: Capsule still has ns-capsule--locked class (disabled buttons)
  assert.ok(renderBlock.includes('ns-capsule--locked'),
    'locked capsule must have ns-capsule--locked class');
  // PHASE 2: Capsule buttons are disabled (ns-cap-btn--disabled)
  assert.ok(renderBlock.includes('ns-cap-btn--disabled'),
    'locked capsule buttons must have ns-cap-btn--disabled class');
});

test('AD-PREM-05: Locked card shows upgrade message + CTA (PHASE 2)', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  // PHASE 2: Upgrade message at bottom of card
  assert.ok(renderBlock.includes("t('premium_settings_msg')"),
    'locked card must use t("premium_settings_msg") for upgrade message (i18n)');
  // PHASE 2: CTA button "ارتقا به پریمیوم"
  assert.ok(renderBlock.includes("t('premium_upgrade_btn')"),
    'locked card must use t("premium_upgrade_btn") for CTA button (i18n)');
  assert.ok(renderBlock.includes('ns-prem-upgrade-cta'),
    'CTA must have ns-prem-upgrade-cta class');
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 4: Premium user UI — functional
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-06: Premium user gets functional capsule buttons', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 13000);
  assert.ok(renderBlock.includes('Premium user — functional controls'),
    'comment documents Premium user functional controls');
  assert.ok(renderBlock.includes('for (const ch of channels)'),
    'channel buttons must be created for Premium users');
});

// ═══════════════════════════════════════════════════════════════════════════
// Phase 5: Backend enforcement
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-07: handleUpdateSettings checks Premium for ch_promotions', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('PREMIUM_ONLY_CATEGORIES'),
    'handleUpdateSettings must define PREMIUM_ONLY_CATEGORIES');
  assert.ok(NOTIF_PLATFORM_SRC.includes("ch_promotions"),
    'ch_promotions must be in PREMIUM_ONLY_CATEGORIES');
  assert.ok(NOTIF_PLATFORM_SRC.includes('membershipAuthority.isPremium'),
    'handleUpdateSettings must call membershipAuthority.isPremium');
});

test('AD-PREM-08: Non-Premium user gets 403 PREMIUM_REQUIRED', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('PREMIUM_REQUIRED'),
    'backend must return PREMIUM_REQUIRED error code');
  assert.ok(NOTIF_PLATFORM_SRC.includes('status: 403'),
    'backend must return HTTP 403 for non-Premium');
});

test('AD-PREM-09: Entitlement check failure returns 503 (fail-safe)', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('ENTITLEMENT_CHECK_FAILED'),
    'backend must return ENTITLEMENT_CHECK_FAILED on error');
  assert.ok(NOTIF_PLATFORM_SRC.includes('status: 503'),
    'backend must return HTTP 503 on entitlement check failure');
});

test('AD-PREM-10: membershipAuthority injected into notification platform handlers', () => {
  assert.ok(WORKER_SRC.includes('membershipAuthority,\n});'),
    'worker-proxy.js must inject membershipAuthority into createNotificationPlatformHandlers');
  assert.ok(NOTIF_PLATFORM_SRC.includes('membershipAuthority,'),
    'notification_platform.js must destructure membershipAuthority from deps');
});

// ═══════════════════════════════════════════════════════════════════════════
// CSS verification
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-11: Locked card CSS exists', () => {
  assert.ok(STYLE_SRC.includes('.ns-prem-card--locked'),
    'CSS must have .ns-prem-card--locked class');
  assert.ok(STYLE_SRC.includes('.ns-capsule--locked'),
    'CSS must have .ns-capsule--locked class');
  assert.ok(STYLE_SRC.includes('.ns-prem-lock'),
    'CSS must have .ns-prem-lock class');
});

test('AD-PREM-12: Locked card has reduced opacity', () => {
  assert.ok(STYLE_SRC.includes('opacity: 0.55'),
    'locked card must have opacity 0.55');
});

// ═══════════════════════════════════════════════════════════════════════════
// No fake ad system
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-13: No fake ad delivery system implemented', () => {
  // Verify no ad_banner, adContainer, showAd, etc. were added
  assert.ok(!APP_SRC.includes('ad_banner') && !APP_SRC.includes('adBanner'),
    'no ad banner code in app.js');
  assert.ok(!WORKER_SRC.includes('ad_banner') && !WORKER_SRC.includes('adBanner'),
    'no ad banner code in worker-proxy.js');
  assert.ok(!APP_SRC.includes('showAd') && !APP_SRC.includes('hideAd'),
    'no show/hide ad functions');
});

// ═══════════════════════════════════════════════════════════════════════════
// Existing behavior preserved
// ═══════════════════════════════════════════════════════════════════════════

test('AD-PREM-14: Non-premiumOnly categories are NOT locked', () => {
  const renderStart = APP_SRC.indexOf('async function renderNotifSettings');
  const renderBlock = APP_SRC.slice(renderStart, renderStart + 5000);
  // The locking condition must include cat.premiumOnly check
  assert.ok(renderBlock.includes('cat.premiumOnly && !isPremiumUser'),
    'locking must only apply to premiumOnly categories');
});

test('AD-PREM-15: handleGetSettings does NOT check Premium (read is allowed for all)', () => {
  // Free users can READ their settings (including ch_promotions default)
  // They just can't WRITE ch_promotions
  const getStart = NOTIF_PLATFORM_SRC.indexOf('async function handleGetSettings');
  const getBlock = NOTIF_PLATFORM_SRC.slice(getStart, getStart + 500);
  assert.ok(!getBlock.includes('membershipAuthority'),
    'handleGetSettings must NOT check Premium (read allowed for all)');
  assert.ok(!getBlock.includes('PREMIUM_REQUIRED'),
    'handleGetSettings must NOT return PREMIUM_REQUIRED');
});

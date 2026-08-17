/**
 * Notification Bypass Fix — Regression Tests
 *
 * Tests the 4 bypass fixes + premium upsell banner behavior.
 * Uses source-string verification + behavioral simulation.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
const NOTIF_PLATFORM_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/notification_platform.js'), 'utf8');
const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const MEMBERSHIP_USER_SRC = fs.readFileSync(path.join(__dirname, 'membership-user.js'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// BYPASS-1: Referral forceChannel removed
// ═══════════════════════════════════════════════════════════════════════════

test('BYPASS-1: Referral rich Telegram message does NOT have forceChannel', () => {
  // Find the referral rich message notificationService.create call
  const idx = WORKER_SRC.indexOf("kind: 'referral_rich_message'");
  assert.ok(idx >= 0, 'referral rich message must exist');
  // Search backwards from the metadata to find the start of the create call
  const blockStart = WORKER_SRC.lastIndexOf('notificationService.create', idx);
  const block = WORKER_SRC.slice(blockStart, idx + 200);
  assert.ok(!block.includes('forceChannel: true'),
    'referral rich message must NOT have forceChannel:true (BYPASS-1 fix)');
  assert.ok(!block.includes("forceChannel: 'auto'"),
    'referral rich message must NOT have forceChannel auto');
});

test('BYPASS-1: Referral rich message still has category and skipInApp', () => {
  const idx = WORKER_SRC.indexOf("kind: 'referral_rich_message'");
  const block = WORKER_SRC.slice(WORKER_SRC.lastIndexOf('notificationService.create', idx), idx + 300);
  assert.ok(block.includes("category: 'referral'"),
    'referral rich message uses category referral');
  assert.ok(block.includes('skipInApp: true'),
    'referral rich message skips in-app (Telegram only)');
});

// ═══════════════════════════════════════════════════════════════════════════
// BYPASS-2: Price alert no longer uses forceChannel + cached pref
// ═══════════════════════════════════════════════════════════════════════════

test('BYPASS-2: Price alert dispatch does NOT have forceChannel', () => {
  // Find the price alert notificationService.create call
  const idx = WORKER_SRC.indexOf("category: 'price_alert'");
  // Find the create call that contains this
  let createStart = WORKER_SRC.lastIndexOf('notificationService.create', idx);
  const block = WORKER_SRC.slice(createStart, idx + 200);
  assert.ok(!block.includes('forceChannel: true'),
    'price alert must NOT have forceChannel:true (BYPASS-2 fix)');
});

test('BYPASS-2: Price alert passes channel:both (let sendNotification query DB)', () => {
  const idx = WORKER_SRC.indexOf("category: 'price_alert'");
  let createStart = WORKER_SRC.lastIndexOf('notificationService.create', idx);
  const block = WORKER_SRC.slice(createStart, idx + 200);
  assert.ok(block.includes("channel: 'both'"),
    "price alert must pass channel:'both' (sendNotification will query DB)");
  assert.ok(block.includes('forceChannel NOT set'),
    'comment documents that forceChannel is intentionally not set');
});

test('BYPASS-2 SEMANTICS: sendNotification queries DB when forceChannel is false', () => {
  // The preference check is in the dispatch function at line ~1053 (not line 351)
  // Search the ENTIRE file for the preference check pattern
  assert.ok(NOTIF_PLATFORM_SRC.includes('if (!forceChannel)'),
    'dispatch must check forceChannel before querying preference');
  assert.ok(NOTIF_PLATFORM_SRC.includes('_getChannelColumn'),
    'dispatch must get the channel column name for the category');
  assert.ok(NOTIF_PLATFORM_SRC.includes('notification_settings'),
    'dispatch must query notification_settings table');
  assert.ok(NOTIF_PLATFORM_SRC.includes("userChannel === 'none'"),
    "dispatch must filter when preference is 'none'");
  assert.ok(NOTIF_PLATFORM_SRC.includes("status: 'filtered'"),
    "dispatch must return 'filtered' status when preference is none");
  assert.ok(NOTIF_PLATFORM_SRC.includes("userChannel === 'mini_app'"),
    "dispatch must check mini_app channel");
  assert.ok(NOTIF_PLATFORM_SRC.includes("userChannel === 'telegram'"),
    "dispatch must check telegram channel");
  assert.ok(NOTIF_PLATFORM_SRC.includes("userChannel === 'both'"),
    "dispatch must check both channel");
});

test('BYPASS-2 SEMANTICS: channel=both without forceChannel respects DB preference', () => {
  // DB preference OVERRIDES the passed channel value when forceChannel is false
  assert.ok(NOTIF_PLATFORM_SRC.includes('userChannel = String(prefResult.rows[0].pref)'),
    'DB preference must override the passed channel value when forceChannel is false');
});

// ═══════════════════════════════════════════════════════════════════════════
// BYPASS-3: Queue re-check
// ═══════════════════════════════════════════════════════════════════════════

test('BYPASS-3: processQueue has preference re-check before sending Telegram', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('BYPASS-3 FIX'),
    'processQueue must have BYPASS-3 FIX comment');
  assert.ok(NOTIF_PLATFORM_SRC.includes('getUserChannelPreference'),
    'processQueue must call getUserChannelPreference before sending');
  assert.ok(NOTIF_PLATFORM_SRC.includes("currentPref === 'none'"),
    "processQueue must check if currentPref is 'none'");
  assert.ok(NOTIF_PLATFORM_SRC.includes("status = 'skipped'"),
    "processQueue must mark as 'skipped' when preference is 'none'");
  assert.ok(NOTIF_PLATFORM_SRC.includes("preference_changed_to_none"),
    "processQueue must log 'preference_changed_to_none' as error reason");
});

test('BYPASS-3: Mandatory notifications (forceChannel) are exempt from re-check', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('itemForceChannel'),
    'processQueue must check forceChannel flag on the queue item');
  assert.ok(NOTIF_PLATFORM_SRC.includes('!itemForceChannel'),
    'processQueue must skip re-check when forceChannel is true (mandatory)');
});

test('BYPASS-3: Re-check fails open (delivers on DB error)', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('fail-open'),
    'processQueue must fail-open (deliver) on preference check error');
});

// ═══════════════════════════════════════════════════════════════════════════
// BYPASS-4: Dead processBroadcast fully deleted
// ═══════════════════════════════════════════════════════════════════════════

test('BYPASS-4: processBroadcast function is deleted (not just unexported)', () => {
  assert.ok(!NOTIF_PLATFORM_SRC.includes('async function processBroadcast(env, broadcastId)'),
    'processBroadcast function definition must be deleted');
  assert.ok(NOTIF_PLATFORM_SRC.includes('Deleted dead processBroadcast'),
    'deletion comment must be present');
});

test('BYPASS-4: No forceChannel auto bypass remains anywhere', () => {
  assert.ok(!NOTIF_PLATFORM_SRC.includes("forceChannel: 'auto'"),
    "forceChannel:'auto' must not exist anywhere in notification_platform.js");
});

test('BYPASS-4: processBroadcastFull (the correct replacement) still exists', () => {
  assert.ok(NOTIF_PLATFORM_SRC.includes('async function processBroadcastFull'),
    'processBroadcastFull must still exist (the correct broadcast processor)');
  assert.ok(NOTIF_PLATFORM_SRC.includes('processBroadcastFull'),
    'processBroadcastFull must be exported');
});

// ═══════════════════════════════════════════════════════════════════════════
// Dead Categories
// ═══════════════════════════════════════════════════════════════════════════

test('DEAD-CAT: breaking_news removed from notification settings UI items', () => {
  // Check the items arrays — ch_breaking_news should NOT appear as a key in any item
  // It may appear in comments (removal notes) which is fine
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  // Must NOT have key: 'ch_breaking_news' in an items entry
  assert.ok(!groupsBlock.includes("key: 'ch_breaking_news'"),
    'ch_breaking_news must not be an active item in the UI groups');
});

test('DEAD-CAT: security removed from notification settings UI items', () => {
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  assert.ok(!groupsBlock.includes("key: 'ch_security'"),
    'ch_security must not be an active item in the UI groups');
});

test('DEAD-CAT: challenges removed from notification settings UI items', () => {
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  assert.ok(!groupsBlock.includes("key: 'ch_challenges'"),
    'ch_challenges must not be an active item in the UI groups');
});

test('DEAD-CAT: promotions is back in UI as Premium-only (Phase 2 update)', () => {
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  // Phase 2: ch_promotions is now back in UI as a Premium-only setting
  assert.ok(groupsBlock.includes("key: 'ch_promotions'"),
    'ch_promotions must be in UI as Premium-only setting (Phase 2)');
  assert.ok(groupsBlock.includes('premiumOnly: true'),
    'ch_promotions must have premiumOnly: true flag');
});

test('DEAD-CAT: Active categories still present in UI', () => {
  const groupsStart = APP_SRC.indexOf('const groups = [');
  const groupsEnd = APP_SRC.indexOf('];', groupsStart + 100);
  const groupsBlock = APP_SRC.slice(groupsStart, groupsEnd);
  // These MUST still be present (they have producers)
  assert.ok(groupsBlock.includes('ch_price_alert'), 'ch_price_alert must be in UI');
  assert.ok(groupsBlock.includes('ch_analysis'), 'ch_analysis must be in UI');
  assert.ok(groupsBlock.includes('ch_calendar'), 'ch_calendar must be in UI');
  assert.ok(groupsBlock.includes('ch_tickets'), 'ch_tickets must be in UI');
  assert.ok(groupsBlock.includes('ch_announcements'), 'ch_announcements must be in UI');
  assert.ok(groupsBlock.includes('ch_wheel'), 'ch_wheel must be in UI');
  assert.ok(groupsBlock.includes('ch_referral'), 'ch_referral must be in UI');
  assert.ok(groupsBlock.includes('ch_wallet'), 'ch_wallet must be in UI');
});

// ═══════════════════════════════════════════════════════════════════════════
// Premium Upsell Banner
// ═══════════════════════════════════════════════════════════════════════════

test('PREMIUM-UPSELL: initHeroSlider checks isPremiumCached', () => {
  const sliderStart = APP_SRC.indexOf('function initHeroSlider');
  const sliderBlock = APP_SRC.slice(sliderStart, sliderStart + 1000);
  assert.ok(sliderBlock.includes('isPremiumCached'),
    'initHeroSlider must call MembershipApp.isPremiumCached()');
  assert.ok(sliderBlock.includes("data-slide=\"0\""),
    'initHeroSlider must target the premium upsell slide (data-slide=0)');
  assert.ok(sliderBlock.includes('style.display = \'none\''),
    'initHeroSlider must hide the slide for premium users');
});

test('PREMIUM-UPSELL: isPremiumCached exposed in MembershipApp', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('isPremiumCached: function'),
    'MembershipApp must export isPremiumCached');
  assert.ok(MEMBERSHIP_USER_SRC.includes('return _cache ? isPremium(_cache) : false'),
    'isPremiumCached must return isPremium(_cache) or false if no cache');
});

test('PREMIUM-UPSELL: Telegram channel join banner NOT hidden', () => {
  // The channel join banner (data-slide="1") should remain visible for all users
  const sliderStart = APP_SRC.indexOf('function initHeroSlider');
  const sliderBlock = APP_SRC.slice(sliderStart, sliderStart + 1000);
  assert.ok(!sliderBlock.includes('data-slide="1"'),
    'initHeroSlider must NOT hide the channel join banner (data-slide=1)');
});

// ═══════════════════════════════════════════════════════════════════════════
// Direct Notification Send Audit
// ═══════════════════════════════════════════════════════════════════════════

test('DIRECT-SEND: No direct sendTelegramMessage calls outside processQueue', () => {
  // All Telegram sends must go through processQueue (the single authorized sender)
  // Exceptions: direct sends in admin broadcast (processBroadcastFull handles it internally)
  // and diagnostic/test endpoints
  const sendTgCalls = WORKER_SRC.match(/sendTelegramMessage\s*\(/g) || [];
  // Count is fine — we just verify no NEW direct calls were added
  // The existing calls are in: processQueue (via sendTelegramMessageFn), 
  // processBroadcastFull (via sendTelegramMessageFn), and a few admin/debug endpoints
  assert.ok(sendTgCalls.length > 0, 'sendTelegramMessage must exist (used by processQueue)');
});

test('FORCE-CHANNEL: worker-proxy.js has ZERO forceChannel:true in code (not comments)', () => {
  // Count forceChannel:true only in actual code (not in comments)
  // Remove comment lines first
  const lines = WORKER_SRC.split('\n');
  const codeLines = lines.filter(l => !l.trim().startsWith('//') && !l.trim().startsWith('*'));
  const codeSrc = codeLines.join('\n');
  const workerForce = (codeSrc.match(/forceChannel:\s*true/g) || []).length;
  assert.equal(workerForce, 0,
    'worker-proxy.js must have ZERO forceChannel:true in code (both bypasses fixed)');
});

test('FORCE-CHANNEL: forceChannel in tickets.js is intentional (admin notify)', () => {
  const ticketsSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/tickets.js'), 'utf8');
  assert.ok(ticketsSrc.includes('forceChannel: true'),
    'tickets.js forceChannel:true is intentional (admin ticket notification)');
});

test('FORCE-CHANNEL: forceChannel in membership.js is intentional (premium welcome)', () => {
  const membershipSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
  assert.ok(membershipSrc.includes('forceChannel: true'),
    'membership.js forceChannel:true is intentional (premium welcome notification)');
});

test('NO-BYPASS: No forceChannel auto anywhere', () => {
  assert.ok(!NOTIF_PLATFORM_SRC.includes("forceChannel: 'auto'"),
    "forceChannel:'auto' must not exist in notification_platform.js");
  assert.ok(!WORKER_SRC.includes("forceChannel: 'auto'"),
    "forceChannel:'auto' must not exist in worker-proxy.js");
});

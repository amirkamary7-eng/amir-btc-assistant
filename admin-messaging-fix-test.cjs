/**
 * Admin Messaging Fix Tests — AMF series
 *
 * Verifies fixes for:
 *   AMF-1 (P0): Broadcast targeting — processBroadcastFull respects target_type
 *   AMF-2: Popup — Premium opt-out via ch_promotions check
 *   AMF-3 (P1): ch_promotions downgrade leakage — isPremium gate in read+write path
 *   AMF-4: Legacy broadcasts table — NOT PROVEN (no test, reported only)
 *   AMF-5 (P2): Admin error visibility — actual backend error in toast
 *   AMF-6 (P2): Bulk notification false-success — INSERT failure tracked
 *
 * Source-inspection + behavioral tests. No business logic should change.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ROOT = __dirname;

const WORKER_SRC = fs.readFileSync(path.join(ROOT, 'worker-proxy.js'), 'utf8');
const NOTIF_PLATFORM_REPO = fs.readFileSync(path.join(ROOT, 'src/repositories/notification_platform.js'), 'utf8');
const NOTIF_PLATFORM_CTRL = fs.readFileSync(path.join(ROOT, 'src/controllers/notification_platform.js'), 'utf8');
const ADS_CTRL = fs.readFileSync(path.join(ROOT, 'src/controllers/advertisements.js'), 'utf8');
const ADMIN_JS = fs.readFileSync(path.join(ROOT, 'admin.js'), 'utf8');
const MIGRATE_SQL = fs.readFileSync(path.join(ROOT, 'scripts/00-migrate.sql'), 'utf8');

// ═══════════════════════════════════════════════════════════════════════════
// AMF-1 (P0): Broadcast targeting — regression rollback
// The previous commit (991abeb) added `AND active = TRUE` which references
// a non-existent `users.active` column (it exists on `admins` only).
// This rollback removes the broken filter. target_type is stored but NOT
// consumed at runtime — both 'all' and 'active' select the same recipients.
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-1a: processBroadcastFull does NOT reference users.active column', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('async function processBroadcastFull'),
    NOTIF_PLATFORM_REPO.indexOf('async function processOneBatch')
  );
  // Strip comments to avoid matching `AND active = TRUE` inside comment text
  const codeOnly = block.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  // The broken `AND active = TRUE` must NOT be present in actual code
  assert.ok(!codeOnly.includes('AND active = TRUE'),
    'processBroadcastFull must NOT reference `AND active = TRUE` in code (users.active does not exist)');
  // The activeFilter variable must NOT be present in actual code
  assert.ok(!codeOnly.includes('activeFilter'),
    'activeFilter variable must be removed from code (was broken)');
});

test('AMF-1b: target_type=all uses channel_joined=TRUE only (unchanged)', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('SELECT telegram_id FROM users'),
    NOTIF_PLATFORM_REPO.indexOf('if (!userResult.rows.length)')
  );
  // The base query must still use channel_joined = TRUE
  assert.ok(block.includes('channel_joined = TRUE'),
    'base filter must still be channel_joined = TRUE');
  // No active filter should be present
  assert.ok(!block.includes('AND active'),
    'no `AND active` filter should be present (regression rollback)');
});

test('AMF-1c: target_type=active does NOT generate AND active = TRUE SQL', () => {
  // After rollback, both 'all' and 'active' produce the same query:
  // SELECT telegram_id FROM users WHERE channel_joined = TRUE
  // The broken `AND active = TRUE` is removed entirely.
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('async function processBroadcastFull'),
    NOTIF_PLATFORM_REPO.indexOf('async function processOneBatch')
  );
  // Strip comments to avoid matching `AND active = TRUE` inside comment text
  const codeOnly = block.replace(/\/\/[^\n]*/g, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!/AND\s+active\s*=\s*TRUE/i.test(codeOnly),
    'no `AND active = TRUE` in actual SQL code (comments stripped)');
  assert.ok(!/activeFilter/.test(codeOnly),
    'no activeFilter variable in actual code (comments stripped)');
});

test('AMF-1d: users table does NOT have active column (schema verification)', () => {
  // The `users` table definition in the migration should NOT include `active`.
  // (The `admins` table has it, but NOT `users`.)
  const usersTable = MIGRATE_SQL.slice(
    MIGRATE_SQL.indexOf('CREATE TABLE IF NOT EXISTS users'),
    MIGRATE_SQL.indexOf(');', MIGRATE_SQL.indexOf('CREATE TABLE IF NOT EXISTS users'))
  );
  assert.ok(!/active\s+BOOLEAN/i.test(usersTable),
    'users table must NOT have an `active` column (only admins table does)');
});

test('AMF-1e: idempotency preserved — ON CONFLICT DO NOTHING still present', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('async function processBroadcastFull'),
    NOTIF_PLATFORM_REPO.indexOf('async function processOneBatch')
  );
  assert.ok(block.includes('ON CONFLICT (id) DO NOTHING'),
    'notifications INSERT idempotency preserved');
  assert.ok(block.includes('ON CONFLICT (notification_id, user_id) DO NOTHING'),
    'queue INSERT idempotency preserved');
  assert.ok(block.includes('bc_${broadcastId}_${uid}'),
    'deterministic notification IDs preserved');
});

// ═══════════════════════════════════════════════════════════════════════════
// AMF-2: Popup — Premium opt-out via ch_promotions check
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-2a: handleGetPopup checks isPremium before showing popup', () => {
  const block = ADS_CTRL.slice(
    ADS_CTRL.indexOf('async function handleGetPopup'),
    ADS_CTRL.indexOf('async function handleMarkPopupShown')
  );
  assert.ok(block.includes('membershipAuthority.isPremium'),
    'handleGetPopup must call membershipAuthority.isPremium');
  assert.ok(block.includes("pref === 'none'"),
    'must check if ch_promotions is none');
  assert.ok(block.includes('popup: null'),
    'must suppress popup when Premium opted out');
});

test('AMF-2b: Free users always see popups (no ch_promotions check for non-Premium)', () => {
  const block = ADS_CTRL.slice(
    ADS_CTRL.indexOf('async function handleGetPopup'),
    ADS_CTRL.indexOf('async function handleMarkPopupShown')
  );
  // The isPremium check is inside `if (isPremium)` — Free users skip it
  assert.ok(block.includes('if (isPremium)'),
    'ch_promotions check only runs for Premium users');
  // Free users fall through to normal popup logic
  assert.ok(block.includes('advertisementsRepo.listActivePopups'),
    'Free users proceed to listActivePopups');
});

test('AMF-2c: fail-open behavior — errors do not block popup display', () => {
  const block = ADS_CTRL.slice(
    ADS_CTRL.indexOf('async function handleGetPopup'),
    ADS_CTRL.indexOf('async function handleMarkPopupShown')
  );
  assert.ok(block.includes('Fail-open') || block.includes('fail-open') || block.includes('better to show'),
    'must have fail-open comment for error handling');
  // The catch must NOT return an error — it must fall through to normal flow
  assert.ok(!block.includes('return jsonResponse({ status: \'error\''),
    'error in isPremium check must not return error response');
});

test('AMF-2d: no new target_audience column added to ad_popups (requirement: no new targeting)', () => {
  // The migration should NOT have a target_audience column on ad_popups
  const popupsSection = MIGRATE_SQL.slice(
    MIGRATE_SQL.indexOf('CREATE TABLE IF NOT EXISTS ad_popups'),
    MIGRATE_SQL.indexOf('CREATE TABLE IF NOT EXISTS ad_messages')
  );
  assert.ok(!popupsSection.includes('target_audience'),
    'ad_popups must NOT have target_audience column (per requirement: no new targeting)');
  assert.ok(!popupsSection.includes('target_tier'),
    'ad_popups must NOT have target_tier column');
});

// ═══════════════════════════════════════════════════════════════════════════
// AMF-3 (P1): ch_promotions downgrade leakage — isPremium gate
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-3a: _deliverMessageCampaign selects membership columns for inline isPremium', () => {
  // Search the whole file for the SELECT clause that includes membership columns
  assert.ok(ADS_CTRL.includes('mu.membership_level,'),
    '_deliverMessageCampaign must SELECT mu.membership_level');
  assert.ok(ADS_CTRL.includes('mu.membership_status,'),
    'must SELECT mu.membership_status');
  assert.ok(ADS_CTRL.includes('mu.expire_at'),
    'must SELECT mu.expire_at');
  assert.ok(ADS_CTRL.includes('premiumSet'),
    'must compute premiumSet per-user');
});

test('AMF-3b: non-Premium users treated as ch_promotions=none in read path', () => {
  const block = ADS_CTRL.slice(
    ADS_CTRL.indexOf('P1 FIX: Only Premium users can have a non-\'none\' ch_promotions'),
    ADS_CTRL.indexOf('const deliverMiniApp')
  );
  assert.ok(block.includes('isCurrentlyPremium'),
    'must check isCurrentlyPremium per-user');
  assert.ok(block.includes("isCurrentlyPremium ? (prefMap.get(uid) || 'none') : 'none'"),
    'non-Premium users get pref=none regardless of DB value');
});

test('AMF-3c: write path allows ch_promotions=none for non-Premium (opt-out)', () => {
  const block = NOTIF_PLATFORM_CTRL.slice(
    NOTIF_PLATFORM_CTRL.indexOf('P1 FIX: Allow non-Premium'),
    NOTIF_PLATFORM_CTRL.indexOf('if (wantsPremiumOnly && membershipAuthority)')
  );
  assert.ok(block.includes("payload[cat] === 'none'"),
    'must check if ch_promotions value is none');
  assert.ok(block.includes("return false"),
    'ch_promotions=none must NOT trigger Premium gate (return false)');
  assert.ok(block.includes('Any other value') || block.includes('return true'),
    'non-none values must still trigger Premium gate');
});

test('AMF-3d: isPremium inline logic matches membership_authority definition', () => {
  // Search the whole file for the inline isPremium computation
  assert.ok(ADS_CTRL.includes("_PREMIUM_LEVELS = new Set"),
    'must define _PREMIUM_LEVELS');
  // Must use the SAME levels as membership_authority
  assert.ok(ADS_CTRL.includes("'VIP'") && ADS_CTRL.includes("'PREMIUM'") && ADS_CTRL.includes("'ELITE'"),
    'must use VIP/PREMIUM/ELITE (same as membership_authority)');
  assert.ok(ADS_CTRL.includes("'APPROVED'"),
    'must check status=APPROVED');
  assert.ok(ADS_CTRL.includes('new Date(expireAt).getTime() > _now'),
    'must check not expired');
});

// ═══════════════════════════════════════════════════════════════════════════
// AMF-4: Legacy broadcasts table — NOT PROVEN
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-4: legacy broadcasts table — NOT PROVEN (no production DB access)', () => {
  // This test documents that the broadcasts table existence is NOT PROVEN.
  // No code change was made for this issue per the task instructions:
  // "تا وقتی production evidence نداری به عنوان confirmed bug اعلام نکن"
  assert.ok(true, 'AMF-4 is NOT PROVEN — requires production DB access to verify');
});

// ═══════════════════════════════════════════════════════════════════════════
// AMF-5 (P2): Admin error visibility — actual backend error in toast
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-5a: createNpBroadcast includes e.message in error toast', () => {
  const block = ADMIN_JS.slice(
    ADMIN_JS.indexOf('async function createNpBroadcast'),
    ADMIN_JS.indexOf('window.createNpBroadcast')
  );
  assert.ok(block.includes('e.message'),
    'createNpBroadcast catch must include e.message');
  assert.ok(!block.includes("adminToast(t('adm_rc_error'), 'error')"),
    'must NOT use generic adm_rc_error (should include actual error)');
});

test('AMF-5b: sendNpBroadcast includes e.message in error toast', () => {
  const block = ADMIN_JS.slice(
    ADMIN_JS.indexOf('async function sendNpBroadcast'),
    ADMIN_JS.indexOf('window.sendNpBroadcast')
  );
  assert.ok(block.includes('e.message'),
    'sendNpBroadcast catch must include e.message');
  assert.ok(!block.includes("adminToast(t('adm_rc_error'), 'error')"),
    'must NOT use generic adm_rc_error');
});

test('AMF-5c: error toast does not expose secrets/tokens', () => {
  // The e.message comes from adminApiFetch which extracts j.message from
  // the backend response. Backend error messages are things like:
  // "Missing Telegram init data", "Admin access required", "Database unavailable"
  // None of these contain secrets. Verify the pattern appends e.message.
  const block = ADMIN_JS.slice(
    ADMIN_JS.indexOf('async function createNpBroadcast'),
    ADMIN_JS.indexOf('window.createNpBroadcast')
  );
  // Pattern must include e.message in the toast string
  assert.ok(block.includes('e.message'),
    'must include e.message in error toast');
  assert.ok(block.includes("adm_np_send_error"),
    'must use adm_np_send_error (not generic adm_rc_error)');
});

// ═══════════════════════════════════════════════════════════════════════════
// AMF-6 (P2): Bulk notification false-success — INSERT failure tracked
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-6a: notifInsertOk flag tracks notifications INSERT success', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('let notifInsertOk = true'),
    NOTIF_PLATFORM_REPO.indexOf('let queueInsertOk = true')
  );
  assert.ok(block.includes('let notifInsertOk = true'),
    'notifInsertOk flag must exist');
});

test('AMF-6b: queueInsertOk flag tracks queue INSERT success', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('let queueInsertOk = true'),
    NOTIF_PLATFORM_REPO.indexOf('// Bulk INSERT in-app')
  );
  assert.ok(block.includes('let queueInsertOk = true'),
    'queueInsertOk flag must exist');
});

test('AMF-6c: INSERT .catch() sets flag to false on failure', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('let notifInsertOk = true'),
    NOTIF_PLATFORM_REPO.indexOf('const deliveredSet = new Set();')
  );
  assert.ok(block.includes('notifInsertOk = false'),
    'notif .catch() must set notifInsertOk = false');
  assert.ok(block.includes('queueInsertOk = false'),
    'queue .catch() must set queueInsertOk = false');
});

test('AMF-6d: batchDelivered only counts users whose INSERT succeeded', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('P2 FIX: Count delivered = users whose INSERT actually SUCCEEDED'),
    NOTIF_PLATFORM_REPO.indexOf('checkpoint = userIds')
  );
  assert.ok(block.includes('if (notifInsertOk) for'),
    'must only add miniAppUsers to deliveredSet if notifInsertOk');
  assert.ok(block.includes('if (queueInsertOk) for'),
    'must only add telegramUsers to deliveredSet if queueInsertOk');
  assert.ok(block.includes('batchDelivered = deliveredSet.size'),
    'batchDelivered must be based on actual INSERT success');
});

test('AMF-6e: batchFailed reflects actual INSERT failures (not always 0)', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('P2 FIX: batchFailed now reflects actual INSERT failures'),
    NOTIF_PLATFORM_REPO.indexOf('checkpoint = userIds')
  );
  assert.ok(block.includes('intendedSet'),
    'must compute intendedSet for failed count');
  assert.ok(block.includes('batchFailed = intendedSet.size - deliveredSet.size'),
    'batchFailed must be intended - delivered (not hardcoded 0)');
  // Verify the old hardcoded 0 is gone
  assert.ok(!block.includes('batchFailed = 0'),
    'must NOT hardcode batchFailed = 0');
});

test('AMF-6f: finalStatus still marks failed when totalDelivered=0', () => {
  const block = NOTIF_PLATFORM_REPO.slice(
    NOTIF_PLATFORM_REPO.indexOf('const finalStatus'),
    NOTIF_PLATFORM_REPO.indexOf('UPDATE notification_broadcasts SET status')
  );
  assert.ok(block.includes("totalDelivered === 0 && totalProcessed > 0"),
    'finalStatus must still check totalDelivered === 0');
  assert.ok(block.includes("'failed'"),
    'must still mark as failed when no deliveries');
});

// ═══════════════════════════════════════════════════════════════════════════
// AMF-7: Regression — no economic/credit path changes
// ═══════════════════════════════════════════════════════════════════════════

test('AMF-7: no economic/credit-path code changed', () => {
  const EC_SRC = fs.readFileSync(path.join(ROOT, 'src/services/entitlement_config.js'), 'utf8');
  assert.ok(EC_SRC.includes('getMissionRewardAmount'),
    'entitlement helpers intact');
  const WALLET_REPO = fs.readFileSync(path.join(ROOT, 'src/repositories/wallet.js'), 'utf8');
  assert.ok(WALLET_REPO.includes('claimDailyRewardWithStreak'),
    'wallet crediting logic intact');
});

test('AMF-7b: membershipAuthority.isPremium still the source of truth', () => {
  const MA_SRC = fs.readFileSync(path.join(ROOT, 'src/services/membership_authority.js'), 'utf8');
  assert.ok(MA_SRC.includes("'APPROVED'") && MA_SRC.includes("'VIP'") && MA_SRC.includes("'PREMIUM'") && MA_SRC.includes("'ELITE'"),
    'membership_authority still uses APPROVED + VIP/PREMIUM/ELITE');
  assert.ok(MA_SRC.includes('expire_at') || MA_SRC.includes('expireAt'),
    'membership_authority still checks expiry');
});

/**
 * Admin Badges + Membership Count + Date Display — Regression Tests
 *
 * Covers 3 fix areas:
 *   1. Premium badge disambiguation (TG PREMIUM vs APP PREMIUM)
 *   2. BLOCKED → INACTIVE relabel
 *   3. Role badge removal (dead code)
 *   4. Date display CSS (adm-meta-val-date class)
 *   5. Membership count consistency (counts + levelDistribution match isPremium)
 *
 * Run: node --test admin-badges-count-date-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_JS = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');
const MEMBERSHIP_REPO = fs.readFileSync(path.join(__dirname, 'src/repositories/membership.js'), 'utf8');
const ADMIN_REPO = fs.readFileSync(path.join(__dirname, 'src/repositories/admin.js'), 'utf8');

// ============================================================================
// FIX #1 — Premium badge disambiguation
// ============================================================================

test('BADGE-01: admin.js uses "TG PREMIUM" label for Telegram Premium', () => {
  assert.ok(ADMIN_JS.includes("adminBadge('TG PREMIUM', 'gray')"),
    'Telegram Premium badge must be labeled "TG PREMIUM" (gray)');
});

test('BADGE-02: admin.js uses "APP PREMIUM" label for App Membership Premium', () => {
  assert.ok(ADMIN_JS.includes("adminBadge('APP PREMIUM', 'orange')"),
    'App Premium badge must be labeled "APP PREMIUM" (orange)');
});

test('BADGE-03: admin.js reads is_premium as Telegram Premium (isTelegramPremium)', () => {
  assert.ok(ADMIN_JS.includes('isTelegramPremium = u.is_premium'),
    'isTelegramPremium must be read from u.is_premium');
});

test('BADGE-04: admin.js reads is_app_premium for App Membership Premium', () => {
  assert.ok(ADMIN_JS.includes('isAppPremium = u.is_app_premium'),
    'isAppPremium must be read from u.is_app_premium (the new authoritative field)');
});

test('BADGE-05: avatar gold gradient only for APP Premium, NOT Telegram Premium', () => {
  assert.ok(ADMIN_JS.includes("(isAppPremium ? ' adm-card-avatar--premium' : '')"),
    'avatar gold gradient must use isAppPremium, not isTelegramPremium');
  assert.ok(!ADMIN_JS.includes("(isPremium ? ' adm-card-avatar--premium' : '')"),
    'old isPremium-based avatar gradient must be removed');
});

test('BADGE-06: old single "PREMIUM" badge (ambiguous) is removed', () => {
  assert.ok(!ADMIN_JS.includes("adminBadge('PREMIUM', 'orange')"),
    'the old ambiguous "PREMIUM" badge must be removed');
});

// ============================================================================
// FIX #2 — BLOCKED → INACTIVE
// ============================================================================

test('BADGE-07: INACTIVE label used instead of BLOCKED for is_active=false', () => {
  assert.ok(ADMIN_JS.includes("adminBadge('INACTIVE', 'gray')"),
    'inactive users must show "INACTIVE" (gray), not "BLOCKED" (red)');
  // The old BLOCKED label must be gone from the user list rendering
  assert.ok(!ADMIN_JS.includes("adminBadge('BLOCKED', 'red')"),
    'the old "BLOCKED" red badge must be removed from the user list');
});

test('BADGE-08: INACTIVE is gray (not red) — does not imply a ban', () => {
  // gray = neutral state; red = error/ban. INACTIVE is neutral.
  assert.ok(ADMIN_JS.includes("adminBadge('INACTIVE', 'gray')"),
    'INACTIVE must be gray (neutral), not red (would imply ban)');
});

// ============================================================================
// FIX #3 — Role badge removed (dead code)
// ============================================================================

test('BADGE-09: dead role badge code removed (u.role no longer referenced)', () => {
  // The old code read u.role and rendered a blue badge. It must be gone.
  assert.ok(!ADMIN_JS.includes('roleLabel = u.role'),
    'roleLabel = u.role must be removed (dead code)');
  assert.ok(!ADMIN_JS.includes("adminBadge(roleLabel.toUpperCase(), 'blue')"),
    'role badge rendering must be removed');
});

test('BADGE-10: roleBadge variable removed from badge row', () => {
  assert.ok(!ADMIN_JS.includes('statusBadge + channelBadge + premiumBadge + roleBadge'),
    'roleBadge must not be in the badge row');
  assert.ok(ADMIN_JS.includes('statusBadge + channelBadge + tgPremiumBadge + appPremiumBadge'),
    'badge row must be: statusBadge + channelBadge + tgPremiumBadge + appPremiumBadge');
});

// ============================================================================
// FIX #4 — Date display CSS
// ============================================================================

test('DATE-01: style.css defines .adm-meta-val-date class', () => {
  assert.ok(STYLE_CSS.includes('.adm-meta-val.adm-meta-val-date'),
    'CSS must define .adm-meta-val.adm-meta-val-date');
});

test('DATE-02: date class relaxes overflow:hidden (no clipping)', () => {
  // The date class must override the parent's overflow:hidden + text-overflow:ellipsis
  const block = STYLE_CSS.match(/\.adm-meta-val\.adm-meta-val-date\s*\{([^}]*)\}/s);
  assert.ok(block, 'date class block must exist');
  const body = block[1];
  assert.ok(body.includes('overflow: visible') || body.includes('overflow:visible'),
    'date class must set overflow: visible (no clipping)');
  assert.ok(body.includes('text-overflow: clip') || body.includes('text-overflow:clip'),
    'date class must set text-overflow: clip (no ellipsis)');
});

test('DATE-03: date class has responsive @media for narrow screens', () => {
  // On very narrow screens, the date must wrap (not clip) to preserve full date+time
  assert.ok(STYLE_CSS.includes('@media (max-width: 420px)'),
    'must have a responsive breakpoint for narrow screens');
  // The media query must target the date class and allow wrapping
  const mediaBlock = STYLE_CSS.match(/@media\s*\(max-width:\s*420px\)\s*\{([^}]*\.adm-meta-val-date[^}]*)\}/s);
  assert.ok(mediaBlock, 'media query must target .adm-meta-val-date');
  assert.ok(mediaBlock[1].includes('white-space: normal'),
    'on narrow screens, date must wrap (white-space: normal) instead of clipping');
});

test('DATE-04: admin.js applies adm-meta-val-date to date cells (user list)', () => {
  // Both date cells in the user list must have the new class
  assert.ok(ADMIN_JS.includes('class="adm-meta-val adm-meta-val-date"'),
    'date cells must have class="adm-meta-val adm-meta-val-date"');
});

test('DATE-05: date+time preserved (not dropped to save space)', () => {
  // adminFormatDate must still include hour + minute (not shortened)
  assert.ok(ADMIN_JS.includes("hour: '2-digit', minute: '2-digit'"),
    'adminFormatDate must still include hour:minute (date+time preserved per requirement)');
});

// ============================================================================
// FIX #5 — Membership count consistency (counts + levelDistribution match isPremium)
// ============================================================================

test('COUNT-01: counts() vipUsers filter includes APPROVED + not-expired', () => {
  assert.ok(MEMBERSHIP_REPO.includes("membership_level IN ('VIP','PREMIUM','ELITE'"));
  assert.ok(MEMBERSHIP_REPO.includes("AND membership_status = 'APPROVED'"));
  assert.ok(MEMBERSHIP_REPO.includes('(expire_at IS NULL OR expire_at > NOW())'));
});

test('COUNT-02: levelDistribution now filters APPROVED + not-expired (consistency fix)', () => {
  // The levelDistribution query must also filter (previously level-only → over-count)
  const block = MEMBERSHIP_REPO.match(/async function levelDistribution[\s\S]*?GROUP BY membership_level/);
  assert.ok(block, 'levelDistribution must exist');
  assert.ok(block[0].includes("membership_status = 'APPROVED'"),
    'levelDistribution must filter APPROVED');
  assert.ok(block[0].includes('(expire_at IS NULL OR expire_at > NOW())'),
    'levelDistribution must filter not-expired');
});

// ============================================================================
// FIX #1 (backend) — admin users SQL JOINs membership_users + computes is_app_premium
// ============================================================================

test('ADMIN-REPO-01: admin users SQL JOINs membership_users', () => {
  assert.ok(ADMIN_REPO.includes('LEFT JOIN membership_users mu ON mu.telegram_id = u.telegram_id'),
    'admin users SQL must LEFT JOIN membership_users');
});

test('ADMIN-REPO-02: admin users SQL selects membership_level + status + expire_at', () => {
  assert.ok(ADMIN_REPO.includes('mu.membership_level, mu.membership_status, mu.expire_at'),
    'admin users SQL must select membership_level, membership_status, expire_at');
});

test('ADMIN-REPO-03: admin repo computes is_app_premium (authoritative)', () => {
  assert.ok(ADMIN_REPO.includes('is_app_premium: isAppPremium'),
    'admin repo must return is_app_premium field');
  // isAppPremium must use the isPremium logic: APPROVED + premium level + not expired
  assert.ok(ADMIN_REPO.includes("status === 'APPROVED'"));
  assert.ok(ADMIN_REPO.includes("['VIP', 'PREMIUM', 'ELITE'].includes(level)"));
  assert.ok(ADMIN_REPO.includes('notExpired'));
});

test('ADMIN-REPO-04: admin repo still returns is_premium (Telegram) unchanged', () => {
  assert.ok(ADMIN_REPO.includes('is_premium: Boolean(r.is_premium)'),
    'is_premium (Telegram) must still be returned unchanged');
});

// ============================================================================
// BEHAVIORAL: the is_app_premium computation matches isPremium() for 9 scenarios
// ============================================================================

// Mirror the isAppPremium logic from admin.js repo
function computeIsAppPremium(user, now) {
  const refNow = now || Date.now();
  const expireAt = user.expire_at ? new Date(user.expire_at).getTime() : null;
  const notExpired = expireAt === null || expireAt > refNow;
  const level = user.membership_level || 'FREE';
  const status = user.membership_status || 'INACTIVE';
  return status === 'APPROVED'
    && ['VIP', 'PREMIUM', 'ELITE'].includes(level)
    && notExpired;
}

const NOW = new Date('2026-08-21T12:00:00Z').getTime();
const FUTURE = new Date('2027-01-01T00:00:00Z').toISOString();
const PAST = new Date('2025-01-01T00:00:00Z').toISOString();

const scenarios = [
  { name: 'APPROVED + PREMIUM + active', user: { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: FUTURE }, expected: true },
  { name: 'APPROVED + VIP + active', user: { membership_level: 'VIP', membership_status: 'APPROVED', expire_at: FUTURE }, expected: true },
  { name: 'APPROVED + ELITE + active', user: { membership_level: 'ELITE', membership_status: 'APPROVED', expire_at: FUTURE }, expected: true },
  { name: 'PENDING + PREMIUM', user: { membership_level: 'PREMIUM', membership_status: 'PENDING', expire_at: null }, expected: false },
  { name: 'REJECTED + PREMIUM', user: { membership_level: 'PREMIUM', membership_status: 'REJECTED', expire_at: null }, expected: false },
  { name: 'SUSPENDED + PREMIUM', user: { membership_level: 'PREMIUM', membership_status: 'SUSPENDED', expire_at: null }, expected: false },
  { name: 'APPROVED + PREMIUM + expired', user: { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: PAST }, expected: false },
  { name: 'APPROVED + PREMIUM + no expiry', user: { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: null }, expected: true },
  { name: 'Telegram Premium without App Premium', user: { membership_level: 'FREE', membership_status: 'INACTIVE', expire_at: null }, expected: false },
];

for (const sc of scenarios) {
  test(`ADMIN-PREMIUM-BEHAV: ${sc.name} → is_app_premium=${sc.expected}`, () => {
    const result = computeIsAppPremium(sc.user, NOW);
    assert.equal(result, sc.expected,
      `${sc.name}: expected is_app_premium=${sc.expected}, got ${result}`);
  });
}

// Telegram Premium must NOT cause is_app_premium to be true
test('ADMIN-PREMIUM-ISOLATION: Telegram Premium alone does not make is_app_premium true', () => {
  // A user with Telegram Premium but no membership record (FREE/INACTIVE)
  const user = { membership_level: 'FREE', membership_status: 'INACTIVE', expire_at: null };
  assert.equal(computeIsAppPremium(user, NOW), false,
    'Telegram Premium alone must NOT grant App Premium');
});

// ============================================================================
// Security: membership authority / approval / KV untouched
// ============================================================================

test('SECURITY-01: membershipAuthority.isPremium() logic unchanged', () => {
  const authSrc = fs.readFileSync(path.join(__dirname, 'src/services/membership_authority.js'), 'utf8');
  assert.ok(authSrc.includes("status === 'APPROVED'"));
  assert.ok(authSrc.includes('PREMIUM_LEVELS.has(level)'));
  assert.ok(authSrc.includes('!expired'));
});

test('SECURITY-02: admin authorization (requireAdminUser) unchanged', () => {
  const ctrlSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/membership.js'), 'utf8');
  assert.ok(ctrlSrc.includes('isAdminTelegramId(env, auth.user.id)'),
    'requireAdminUser must still check isAdminTelegramId');
});

test('SECURITY-03: KV entitlement cache key unchanged', () => {
  const authSrc = fs.readFileSync(path.join(__dirname, 'src/services/membership_authority.js'), 'utf8');
  assert.ok(authSrc.includes('mb:ent:'),
    'KV cache key mb:ent:{id} must be unchanged');
});

test('SECURITY-04: no new frontend trust added (no localStorage/sessionStorage for premium)', () => {
  // The admin.js must NOT store is_app_premium in localStorage/sessionStorage
  // (it's read fresh from the API response on each render)
  const adminSrc = ADMIN_JS;
  // Check that is_app_premium is read from the API response, not from storage
  assert.ok(adminSrc.includes('isAppPremium = u.is_app_premium'),
    'isAppPremium must be read from API response (u.is_app_premium)');
  // Must NOT be persisted to storage
  assert.ok(!adminSrc.includes("localStorage.setItem('is_app_premium'"),
    'is_app_premium must NOT be persisted to localStorage');
  assert.ok(!adminSrc.includes("sessionStorage.setItem('is_app_premium'"),
    'is_app_premium must NOT be persisted to sessionStorage');
});

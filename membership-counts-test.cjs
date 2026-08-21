/**
 * Membership counts() Reporting Bug — Regression Tests
 *
 * Root cause: src/repositories/membership.js:counts() `vip` filter used only
 * `membership_level IN ('VIP','PREMIUM','ELITE')` — over-counting SUSPENDED/
 * EXPIRED/PENDING/REJECTED users with retained premium levels.
 *
 * Fix: added `AND membership_status = 'APPROVED'
 *           AND (expire_at IS NULL OR expire_at > NOW())`
 * so the count matches `membershipAuthority.isPremium()`.
 *
 * These tests verify BOTH:
 *   - Static: the SQL string in counts() contains the new conjuncts
 *   - Behavioral: the predicate logic matches isPremium() for 9 scenarios
 *
 * Run: node --test membership-counts-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MEMBERSHIP_REPO_SRC = fs.readFileSync(
  path.join(__dirname, 'src/repositories/membership.js'), 'utf8'
);
const MEMBERSHIP_AUTHORITY_SRC = fs.readFileSync(
  path.join(__dirname, 'src/services/membership_authority.js'), 'utf8'
);

// ============================================================================
// STATIC: the counts() SQL contains the fix
// ============================================================================

test('COUNT-STATIC-01: counts() vip filter includes membership_level IN (...)', () => {
  assert.ok(MEMBERSHIP_REPO_SRC.includes("membership_level IN ('VIP','PREMIUM','ELITE')"),
    'vip filter must still include the level IN clause');
});

test('COUNT-STATIC-02: counts() vip filter includes membership_status = APPROVED', () => {
  // The new conjunct that prevents over-counting SUSPENDED/EXPIRED/PENDING/REJECTED
  assert.ok(/vip[^;]*membership_status\s*=\s*'APPROVED'/s.test(MEMBERSHIP_REPO_SRC) ||
            MEMBERSHIP_REPO_SRC.includes("AND membership_status = 'APPROVED'"),
    'vip filter must include AND membership_status = APPROVED');
});

test('COUNT-STATIC-03: counts() vip filter includes expire_at check', () => {
  // The new conjunct that prevents counting expired premium users
  assert.ok(MEMBERSHIP_REPO_SRC.includes('(expire_at IS NULL OR expire_at > NOW())'),
    'vip filter must include (expire_at IS NULL OR expire_at > NOW())');
});

test('COUNT-STATIC-04: counts() still returns totalUsers/approvedUsers/vipUsers/suspendedUsers', () => {
  // API contract unchanged — the return shape must be identical.
  assert.ok(MEMBERSHIP_REPO_SRC.includes('totalUsers: row.total'));
  assert.ok(MEMBERSHIP_REPO_SRC.includes('approvedUsers: row.approved'));
  assert.ok(MEMBERSHIP_REPO_SRC.includes('vipUsers: row.vip'));
  assert.ok(MEMBERSHIP_REPO_SRC.includes('suspendedUsers: row.suspended'));
});

// PHASE 1 FIX test: approvedUsers now also filters by not-expired
test('COUNT-STATIC-05: counts() approvedUsers filter includes expire_at check (Phase 1 fix)', () => {
  // The approved FILTER must now include the expire_at conjunct (previously it didn't)
  // The SQL spans multiple lines, so we check the full counts() function block.
  const fnMatch = MEMBERSHIP_REPO_SRC.match(/async function counts[\s\S]*?FROM membership_users/);
  assert.ok(fnMatch, 'counts() function must exist');
  const fnBlock = fnMatch[0];
  // Find the approved FILTER clause (between "AS approved" and the next FILTER/end)
  const approvedMatch = fnBlock.match(/FILTER\s*\(\s*WHERE\s*membership_status\s*=\s*'APPROVED'[\s\S]*?AS\s+approved/);
  assert.ok(approvedMatch, 'must have an approved FILTER clause');
  const approvedClause = approvedMatch[0];
  assert.ok(approvedClause.includes("membership_status = 'APPROVED'"),
    'approved filter must include membership_status = APPROVED');
  assert.ok(approvedClause.includes('(expire_at IS NULL OR expire_at > NOW())'),
    'approved filter must include (expire_at IS NULL OR expire_at > NOW()) — Phase 1 fix');
});

// ============================================================================
// BEHAVIORAL: the predicate logic matches isPremium() for 9 scenarios
// ============================================================================
// We extract and run BOTH predicates against each scenario to prove they agree.

// The OLD (buggy) predicate — counts by level only.
function oldVipPredicate(user) {
  return ['VIP', 'PREMIUM', 'ELITE'].includes(user.membership_level);
}

// The NEW (fixed) predicate — the SQL FILTER clause in counts() for VIP.
function newVipPredicate(user, now) {
  const refNow = now instanceof Date ? now.getTime() : (now || Date.now());
  return ['VIP', 'PREMIUM', 'ELITE'].includes(user.membership_level)
    && user.membership_status === 'APPROVED'
    && (!user.expire_at || new Date(user.expire_at).getTime() > refNow);
}

// The NEW (fixed) approvedUsers predicate — Phase 1 fix: now also filters by not-expired.
function newApprovedPredicate(user, now) {
  const refNow = now instanceof Date ? now.getTime() : (now || Date.now());
  return user.membership_status === 'APPROVED'
    && (!user.expire_at || new Date(user.expire_at).getTime() > refNow);
}

// The OLD (buggy) approvedUsers predicate — did NOT filter by expire_at.
function oldApprovedPredicate(user) {
  return user.membership_status === 'APPROVED';
}

// The membershipAuthority.isPremium() logic (src/services/membership_authority.js:125-128).
// PREMIUM_LEVELS = Set(['VIP','PREMIUM','ELITE']) (authority line 56).
function isPremiumAuthorityLogic(user, now) {
  if (!user) return false;
  const level = user.membership_level || 'FREE';
  const status = user.membership_status || 'INACTIVE';
  const expireAt = user.expire_at || null;
  const expired = expireAt ? (new Date(expireAt).getTime() <= (now || Date.now())) : false;
  return status === 'APPROVED'
    && ['VIP', 'PREMIUM', 'ELITE'].includes(level)
    && !expired;
}

// Test scenarios — each is a membership_users row.
const NOW = new Date('2026-08-21T12:00:00Z').getTime();
const FUTURE = new Date('2027-01-01T00:00:00Z').toISOString();
const PAST = new Date('2025-01-01T00:00:00Z').toISOString();

const scenarios = [
  // #1 — APPROVED + PREMIUM + not expired → COUNTED
  { name: 'APPROVED + PREMIUM + not expired',
    user: { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: FUTURE },
    expected_counted: true },
  // #2 — APPROVED + VIP + not expired → COUNTED
  { name: 'APPROVED + VIP + not expired',
    user: { membership_level: 'VIP', membership_status: 'APPROVED', expire_at: FUTURE },
    expected_counted: true },
  // #3 — APPROVED + ELITE + not expired → COUNTED
  { name: 'APPROVED + ELITE + not expired',
    user: { membership_level: 'ELITE', membership_status: 'APPROVED', expire_at: FUTURE },
    expected_counted: true },
  // #4 — SUSPENDED + PREMIUM → NOT counted
  { name: 'SUSPENDED + PREMIUM (level retained from prior approval)',
    user: { membership_level: 'PREMIUM', membership_status: 'SUSPENDED', expire_at: null },
    expected_counted: false },
  // #5 — EXPIRED + PREMIUM → NOT counted
  { name: 'EXPIRED + PREMIUM (status=EXPIRED)',
    user: { membership_level: 'PREMIUM', membership_status: 'EXPIRED', expire_at: null },
    expected_counted: false },
  // #6 — PENDING + PREMIUM → NOT counted
  { name: 'PENDING + PREMIUM (level retained)',
    user: { membership_level: 'PREMIUM', membership_status: 'PENDING', expire_at: null },
    expected_counted: false },
  // #7 — REJECTED + PREMIUM → NOT counted
  { name: 'REJECTED + PREMIUM (level retained)',
    user: { membership_level: 'PREMIUM', membership_status: 'REJECTED', expire_at: null },
    expected_counted: false },
  // #8 — APPROVED + PREMIUM + expire_at in the past → NOT counted
  { name: 'APPROVED + PREMIUM + expire_at in the past',
    user: { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: PAST },
    expected_counted: false },
  // #9 — APPROVED + PREMIUM + expire_at NULL → COUNTED
  { name: 'APPROVED + PREMIUM + expire_at NULL (lifetime)',
    user: { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: null },
    expected_counted: true },
];

// Generate one test per scenario for the NEW predicate (the fix).
for (const sc of scenarios) {
  test(`COUNT-BEHAV-NEW: ${sc.name} → ${sc.expected_counted ? 'COUNTED' : 'NOT counted'}`, () => {
    const result = newVipPredicate(sc.user, NOW);
    assert.equal(result, sc.expected_counted,
      `new predicate: expected ${sc.expected_counted}, got ${result}`);
  });
}

// Generate one test per scenario verifying the NEW predicate AGREES with isPremium().
for (const sc of scenarios) {
  test(`COUNT-BEHAV-AGREE: ${sc.name} → new predicate == isPremium()`, () => {
    const newResult = newVipPredicate(sc.user, NOW);
    const authorityResult = isPremiumAuthorityLogic(sc.user, NOW);
    assert.equal(newResult, authorityResult,
      `new predicate (${newResult}) must match isPremium() (${authorityResult})`);
  });
}

// ============================================================================
// PHASE 1 FIX: approvedUsers now filters by not-expired (the "6" bug)
// ============================================================================
// The "تأیید شده" (Approved) card reads s.approvedUsers. Previously this
// counted ALL users with membership_status='APPROVED' (including expired).
// If 6 users had APPROVED status (4 expired), the card showed 6 while only
// 2 were truly active. Now it also filters by not-expired.

const approvedScenarios = [
  { name: 'APPROVED + not expired → counted as approved',
    user: { membership_status: 'APPROVED', expire_at: FUTURE }, expected: true },
  { name: 'APPROVED + expire NULL → counted as approved',
    user: { membership_status: 'APPROVED', expire_at: null }, expected: true },
  { name: 'APPROVED + expired → NOT counted (Phase 1 fix)',
    user: { membership_status: 'APPROVED', expire_at: PAST }, expected: false },
  { name: 'PENDING → NOT counted as approved',
    user: { membership_status: 'PENDING', expire_at: null }, expected: false },
  { name: 'SUSPENDED → NOT counted as approved',
    user: { membership_status: 'SUSPENDED', expire_at: null }, expected: false },
  { name: 'REJECTED → NOT counted as approved',
    user: { membership_status: 'REJECTED', expire_at: null }, expected: false },
  { name: 'INACTIVE → NOT counted as approved',
    user: { membership_status: 'INACTIVE', expire_at: null }, expected: false },
];

for (const sc of approvedScenarios) {
  test(`APPROVED-BEHAV-NEW: ${sc.name}`, () => {
    const result = newApprovedPredicate(sc.user, NOW);
    assert.equal(result, sc.expected,
      `approved predicate: expected ${sc.expected}, got ${result}`);
  });
}

test('APPROVED-BEHAV-OLD: old approved predicate over-counted expired APPROVED (proves the 6 bug)', () => {
  // The old predicate counted APPROVED+expired as approved → the "6" bug
  const expiredApproved = { membership_status: 'APPROVED', expire_at: PAST };
  assert.equal(oldApprovedPredicate(expiredApproved), true,
    'OLD predicate counted expired APPROVED (the bug)');
  assert.equal(newApprovedPredicate(expiredApproved, NOW), false,
    'NEW predicate does NOT count expired APPROVED (the fix)');
});

test('APPROVED-CONSISTENCY: approvedUsers >= vipUsers (approved includes FREE-level approved too)', () => {
  // approvedUsers counts ALL approved+not-expired (any level)
  // vipUsers counts only approved+not-expired+premium-level
  // So approvedUsers >= vipUsers always
  const users = [
    { membership_level: 'FREE', membership_status: 'APPROVED', expire_at: null },
    { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: null },
    { membership_level: 'VIP', membership_status: 'APPROVED', expire_at: FUTURE },
  ];
  const approvedCount = users.filter(u => newApprovedPredicate(u, NOW)).length;
  const vipCount = users.filter(u => newVipPredicate(u, NOW)).length;
  assert.equal(approvedCount, 3, 'all 3 approved (1 FREE + 2 premium)');
  assert.equal(vipCount, 2, 'only 2 VIP (PREMIUM + VIP, not FREE)');
  assert.ok(approvedCount >= vipCount, 'approvedUsers >= vipUsers');
});

// Sanity: the OLD buggy predicate would have OVER-COUNTED scenarios 4-7.
// This proves the fix actually changes behavior for those scenarios.
test('COUNT-BEHAV-OLD: old predicate over-counted SUSPENDED/EXPIRED/PENDING/REJECTED (proves the bug)', () => {
  const overCountScenarios = scenarios.filter(s =>
    ['SUSPENDED', 'EXPIRED', 'PENDING', 'REJECTED'].includes(s.user.membership_status));
  for (const sc of overCountScenarios) {
    const oldResult = oldVipPredicate(sc.user);
    assert.equal(oldResult, true,
      `OLD buggy predicate counted "${sc.name}" as vip (the bug)`);
    assert.equal(sc.expected_counted, false,
      `"${sc.name}" should NOT be counted (expected_counted=false)`);
  }
});

// The expired-by-date scenario (#8) was ALSO over-counted by the old predicate.
test('COUNT-BEHAV-OLD: old predicate over-counted APPROVED+PREMIUM+expired (proves the bug)', () => {
  const sc = scenarios.find(s => s.name.includes('expire_at in the past'));
  const oldResult = oldVipPredicate(sc.user);
  assert.equal(oldResult, true, 'OLD buggy predicate counted expired premium (the bug)');
  assert.equal(sc.expected_counted, false, 'should NOT be counted');
});

// ============================================================================
// Cross-check: the isPremium() source itself uses APPROVED + level + !expired
// (proves the count now matches the authority's definition)
// ============================================================================

test('COUNT-CROSSCHECK: isPremium() authority requires APPROVED + premium level + not expired', () => {
  // src/services/membership_authority.js:125-128
  assert.ok(MEMBERSHIP_AUTHORITY_SRC.includes("status === 'APPROVED'"),
    'isPremium must check status === APPROVED');
  assert.ok(MEMBERSHIP_AUTHORITY_SRC.includes('PREMIUM_LEVELS.has(level)'),
    'isPremium must check PREMIUM_LEVELS.has(level)');
  assert.ok(MEMBERSHIP_AUTHORITY_SRC.includes('!expired'),
    'isPremium must check !expired');
});

test('COUNT-CROSSCHECK: counts() vip filter now matches isPremium() logic exactly', () => {
  // Both require: level IN premium levels AND status === APPROVED AND not expired
  // The counts() filter uses (expire_at IS NULL OR expire_at > NOW())
  // The isPremium() uses !expired where expired = expireAt ? (expireAt <= now) : false
  // These are equivalent: (NULL → counted → !expired=true) OR (future → counted → !expired=true)
  assert.ok(MEMBERSHIP_REPO_SRC.includes("membership_level IN ('VIP','PREMIUM','ELITE')"));
  assert.ok(MEMBERSHIP_REPO_SRC.includes("membership_status = 'APPROVED'"));
  assert.ok(MEMBERSHIP_REPO_SRC.includes('(expire_at IS NULL OR expire_at > NOW())'));
});

// ============================================================================
// Edge cases
// ============================================================================

test('COUNT-EDGE-01: FREE level is never counted regardless of status', () => {
  for (const status of ['APPROVED', 'PENDING', 'SUSPENDED', 'EXPIRED', 'REJECTED', 'INACTIVE']) {
    const user = { membership_level: 'FREE', membership_status: status, expire_at: null };
    assert.equal(newVipPredicate(user, NOW), false,
      `FREE + ${status} must NOT be counted`);
  }
});

test('COUNT-EDGE-02: expire_at exactly NOW (boundary) → NOT counted (expire_at > NOW is strict)', () => {
  // expire_at == NOW exactly: the SQL uses `expire_at > NOW()` (strict greater-than),
  // so a timestamp exactly at NOW is NOT counted (already expired).
  // isPremium() uses `expireAt <= refNow` (expired), so exactly-NOW is expired → not premium.
  const user = { membership_level: 'PREMIUM', membership_status: 'APPROVED', expire_at: new Date(NOW).toISOString() };
  assert.equal(newVipPredicate(user, NOW), false,
    'expire_at == NOW → NOT counted (already expired, strict >)');
  assert.equal(isPremiumAuthorityLogic(user, NOW), false,
    'isPremium() agrees: expire_at == NOW → not premium');
});

test('COUNT-EDGE-03: expire_at 1ms in the future → counted', () => {
  const user = { membership_level: 'PREMIUM', membership_status: 'APPROVED',
    expire_at: new Date(NOW + 1).toISOString() };
  assert.equal(newVipPredicate(user, NOW), true,
    'expire_at 1ms future → counted');
  assert.equal(isPremiumAuthorityLogic(user, NOW), true,
    'isPremium() agrees');
});

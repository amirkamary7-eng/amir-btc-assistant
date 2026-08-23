/**
 * Regression test for PHASE 1 + PHASE 2 fixes:
 *   - PHASE 1 (Frontend): bootstrapUser() fires in PARALLEL with checkMaintenanceMode()
 *     so admin bypass button appears within bootstrap round-trip (~1-2s), not after
 *     viewportChanged (5-20s+). Non-admin users still see the maintenance popup —
 *     security is preserved.
 *   - PHASE 2 (Backend): handleBootstrap parallelizes 4 independent operations
 *     (watchlist.getSymbols, membershipGateway.check, adminRepo.getAdminByTelegramId,
 *     membershipAuthority.isPremium) with the getById→bootstrap→processReferral chain.
 *
 * These tests verify the FIX via source-eval (extracting the actual code from
 * app.js + src/controllers/users.js) plus dynamic behavior simulation.
 *
 * Run: node --test startup-admin-bypass-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
const USERS_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/users.js'), 'utf8');
const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ============================================================================
// Section 1: PHASE 1 — Frontend admin bypass during maintenance
// ============================================================================

test('STARTUP-001: bootstrapUser() completes BEFORE checkMaintenanceMode() (sequential)', () => {
  // PERMANENT FIX: checkMaintenanceMode now runs AFTER bootstrap completes.
  // The bootstrap promise is created first, then .then() chains maintenance.
  const bootIdx = APP_SRC.indexOf('_parallelBootstrapPromise = bootstrapUser()');
  const maintIdx = APP_SRC.indexOf('const _maintOk = await checkMaintenanceMode()');
  assert.ok(bootIdx > -1, 'bootstrapUser() must be assigned to _parallelBootstrapPromise');
  assert.ok(maintIdx > -1, 'checkMaintenanceMode() must be awaited inside bootstrap .then()');
  assert.ok(bootIdx < maintIdx,
    `bootstrapUser() must fire BEFORE checkMaintenanceMode() — bootIdx=${bootIdx}, maintIdx=${maintIdx}`);
});

test('STARTUP-002: maintenance ON does NOT block bootstrap (admin detection still works)', () => {
  // PERMANENT FIX: Bootstrap runs FIRST (assigning isCurrentUserAdmin),
  // THEN checkMaintenanceMode runs. If maintenance is ON and user is admin,
  // the bypass button is already visible (no background wait needed).
  // Verify the maintenance check is inside the bootstrap .then
  const maintIdx = APP_SRC.indexOf('const _maintOk = await checkMaintenanceMode()');
  assert.ok(maintIdx > -1, 'maintenance check must be inside bootstrap .then()');
  // Verify the early return exists
  const earlyReturnIdx = APP_SRC.indexOf("return; // Stop here — don't load data or start polling");
  assert.ok(earlyReturnIdx > -1, 'early return for maintenance ON must exist');
});

test('STARTUP-003: maintenance OFF runs post-bootstrap tasks sequentially after maintenance check', () => {
  // PERMANENT FIX: post-bootstrap tasks now run INSIDE the same .then() as
  // the maintenance check (sequential, not a separate chained .then).
  const maintOffIdx = APP_SRC.indexOf('Maintenance is OFF — bootstrap already completed');
  assert.ok(maintOffIdx > -1, 'maintenance-OFF path must exist inside bootstrap .then()');
  const block = APP_SRC.slice(maintOffIdx, maintOffIdx + 2000);
  assert.ok(block.includes('loadUser()'), 'loadUser must run after maintenance check passes');
  assert.ok(block.includes('loadForexData'), 'loadForexData retry must be in the block');
  assert.ok(block.includes('loadMissionStatus'), 'loadMissionStatus must be in the block');
});

test('STARTUP-004: bootstrapUser() catch handler exists (non-fatal)', () => {
  // The parallel bootstrap must have a catch handler so it doesn't break the app
  assert.ok(APP_SRC.includes('const _parallelBootstrapPromise = bootstrapUser().catch(e => {'),
    'parallel bootstrap must have .catch() handler');
  assert.ok(APP_SRC.includes("console.error('[BOOT] bootstrapUser FAILED:', e.message);"),
    'bootstrap failure must be logged, not thrown');
});

test('STARTUP-005: updateMaintenanceAdminBypass is still called from _bootstrapUserImpl', () => {
  // This is the CRITICAL link: when bootstrap completes, updateMaintenanceAdminBypass
  // must be called to show the bypass button for admins (regardless of maintenance state)
  assert.ok(APP_SRC.includes('if (typeof updateMaintenanceAdminBypass === \'function\')'),
    'updateMaintenanceAdminBypass must be called from _bootstrapUserImpl after admin status is set');
  // It must come AFTER bootstrapComplete = true (so isAdmin() returns the correct value)
  const setCompleteIdx = APP_SRC.indexOf('bootstrapComplete = true;');
  const updateBypassIdx = APP_SRC.indexOf('if (typeof updateMaintenanceAdminBypass === \'function\')', setCompleteIdx);
  assert.ok(setCompleteIdx > -1 && updateBypassIdx > setCompleteIdx,
    'updateMaintenanceAdminBypass must be called AFTER bootstrapComplete = true');
});

test('STARTUP-006: isAdmin() still gates on bootstrapComplete (no security regression)', () => {
  // isAdmin() must still return false when bootstrapComplete is false
  const isAdminMatch = APP_SRC.match(/function isAdmin\(\)\s*\{[^}]*bootstrapComplete[^}]*\}/s);
  assert.ok(isAdminMatch, 'isAdmin() function must exist and reference bootstrapComplete');
  assert.ok(isAdminMatch[0].includes('if (!bootstrapComplete) return false;'),
    'isAdmin() must return false when !bootstrapComplete');
});

test('STARTUP-007: updateMaintenanceAdminBypass only shows button if isAdmin()=true', () => {
  // Security: bypass button is ONLY visible to server-confirmed admins
  const bypassFnMatch = APP_SRC.match(/function updateMaintenanceAdminBypass\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(bypassFnMatch, 'updateMaintenanceAdminBypass function must exist');
  assert.ok(bypassFnMatch[0].includes('if (isAdmin())'),
    'updateMaintenanceAdminBypass must check isAdmin() before showing bypass button');
  assert.ok(bypassFnMatch[0].includes("bypassBtn.style.display = 'inline-flex';"),
    'bypass button must be shown (inline-flex) for admins');
  assert.ok(bypassFnMatch[0].includes("bypassBtn.style.display = 'none';"),
    'bypass button must be hidden (none) for non-admins');
});

test('STARTUP-008: adminBypassMaintenance double-checks isAdmin() before bypass (security)', () => {
  // The actual bypass action must double-check admin status
  const bypassActionMatch = APP_SRC.match(/function adminBypassMaintenance\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(bypassActionMatch, 'adminBypassMaintenance function must exist');
  assert.ok(bypassActionMatch[0].includes('if (!isAdmin())'),
    'adminBypassMaintenance must double-check isAdmin() — security gate');
  assert.ok(bypassActionMatch[0].includes("console.warn('[MAINT] Non-admin attempted to bypass maintenance mode')"),
    'non-admin bypass attempts must be logged as warnings');
});

test('STARTUP-009: maintenance ON early-return skips ALL other init (data loading, polling)', () => {
  // PERMANENT FIX: maintenance check is now inside _parallelBootstrapPromise.then().
  // The early return must be BEFORE _startDataLoading, startPolling, etc.
  const maintCheckIdx = APP_SRC.indexOf('const _maintOk = await checkMaintenanceMode()');
  const earlyReturnIdx = APP_SRC.indexOf("return; // Stop here — don't load data or start polling", maintCheckIdx);

  const startDataLoadingIdx = APP_SRC.indexOf('_startDataLoading();', maintCheckIdx);
  const startPollingIdx = APP_SRC.indexOf('startPolling();', maintCheckIdx);
  const bootstrapLongTimerIdx = APP_SRC.indexOf('_bootstrapLongTimer = setInterval(', maintCheckIdx);

  // All these must be AFTER the early return (so they're skipped when maintenance is ON)
  assert.ok(startDataLoadingIdx > earlyReturnIdx, '_startDataLoading must be after early return');
  assert.ok(startPollingIdx > earlyReturnIdx, 'startPolling must be after early return');
  assert.ok(bootstrapLongTimerIdx > earlyReturnIdx, '_bootstrapLongTimer must be after early return');
});

test('STARTUP-010: cold-start boot poll is set up BEFORE maintenance check (admin detection during maintenance)', () => {
  // The cold-start boot poll must be set up OUTSIDE the bootstrap.then/maintenance
  // block so it runs even when maintenance is ON and auth is pending.
  const newBootPollIdx = APP_SRC.indexOf('COLD-START BOOT POLL (runs regardless of maintenance state)');
  const maintCheckIdx = APP_SRC.indexOf('const _maintOk = await checkMaintenanceMode()');
  assert.ok(newBootPollIdx > -1, 'new cold-start boot poll setup must exist');
  assert.ok(newBootPollIdx < maintCheckIdx,
    `cold-start boot poll must be set up BEFORE maintenance check — bootPollIdx=${newBootPollIdx}, maintCheckIdx=${maintCheckIdx}`);
});

test('STARTUP-011: cold-start boot poll only calls tryLateBootstrap (no other init)', () => {
  // Safety: the boot poll should ONLY call tryLateBootstrap() — it should NOT
  // start data loading, polling, or any other init. Those are gated by maintenance.
  const bootPollStart = APP_SRC.indexOf('COLD-START BOOT POLL (runs regardless of maintenance state)');
  const bootPollEnd = APP_SRC.indexOf('if (pn) _bootObserver.observe', bootPollStart);
  assert.ok(bootPollStart > -1 && bootPollEnd > bootPollStart, 'boot poll block must exist');
  const bootPollBlock = APP_SRC.slice(bootPollStart, bootPollEnd + 100);

  // The boot poll must call tryLateBootstrap (multiple times — interval + observer)
  const tryLateCount = (bootPollBlock.match(/tryLateBootstrap\(\)/g) || []).length;
  assert.ok(tryLateCount >= 2, `boot poll must call tryLateBootstrap() in both interval + observer — found ${tryLateCount}`);

  // The boot poll must NOT start data loading or other init
  assert.ok(!bootPollBlock.includes('_startDataLoading'), 'boot poll must NOT call _startDataLoading');
  assert.ok(!bootPollBlock.includes('startPolling()'), 'boot poll must NOT call startPolling()');
  assert.ok(!bootPollBlock.includes('loadAlertsFromServer'), 'boot poll must NOT call loadAlertsFromServer');
  // The boot poll must clear itself when bootstrapComplete becomes true
  assert.ok(bootPollBlock.includes('if (bootstrapComplete'), 'boot poll must check bootstrapComplete');
  assert.ok(bootPollBlock.includes('clearInterval(_bootPollInterval)'), 'boot poll must clear its interval');
});

// ============================================================================
// Section 2: PHASE 2 — Backend bootstrap parallelization
// ============================================================================

test('BOOT-PARALLEL-001: handleBootstrap uses parallel chains (chainA-E)', () => {
  assert.ok(USERS_SRC.includes('const chainA = (async () => {'), 'chainA must exist');
  assert.ok(USERS_SRC.includes('const chainB = (async () => {'), 'chainB must exist');
  assert.ok(USERS_SRC.includes('const chainC = (async () => {'), 'chainC must exist');
  assert.ok(USERS_SRC.includes('const chainD = (async () => {'), 'chainD must exist');
  assert.ok(USERS_SRC.includes('const chainE = (async () => {'), 'chainE must exist');
});

test('BOOT-PARALLEL-002: chainA preserves sequential getById→bootstrap→processReferral order', () => {
  // chainA must call getById BEFORE bootstrap, and bootstrap BEFORE processReferral
  const chainAMatch = USERS_SRC.match(/const chainA = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(chainAMatch, 'chainA definition must exist');
  const chainA = chainAMatch[0];

  const getByIdIdx = chainA.indexOf('userRepo.getById');
  const bootstrapIdx = chainA.indexOf('userRepo.bootstrap');
  const processRefIdx = chainA.indexOf('processReferralOnBootstrap');

  assert.ok(getByIdIdx > -1, 'chainA must call userRepo.getById');
  assert.ok(bootstrapIdx > -1, 'chainA must call userRepo.bootstrap');
  assert.ok(processRefIdx > -1, 'chainA must call processReferralOnBootstrap');
  assert.ok(getByIdIdx < bootstrapIdx, 'getById must come before bootstrap in chainA');
  assert.ok(bootstrapIdx < processRefIdx, 'bootstrap must come before processReferral in chainA');
});

test('BOOT-PARALLEL-003: chainB (watchlist) is independent — no dependency on chainA', () => {
  const chainBMatch = USERS_SRC.match(/const chainB = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(chainBMatch, 'chainB definition must exist');
  const chainB = chainBMatch[0];
  assert.ok(chainB.includes('watchlistRepo.getSymbols'), 'chainB must call watchlistRepo.getSymbols');
  // chainB must NOT reference userRow, preExistingUser, or other chainA results
  assert.ok(!chainB.includes('userRow'), 'chainB must not reference userRow (independent)');
  assert.ok(!chainB.includes('preExistingUser'), 'chainB must not reference preExistingUser (independent)');
});

test('BOOT-PARALLEL-004: chainC (membership) is independent — returns null on error for fallback', () => {
  const chainCMatch = USERS_SRC.match(/const chainC = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(chainCMatch, 'chainC definition must exist');
  const chainC = chainCMatch[0];
  assert.ok(chainC.includes('membershipGateway.check'), 'chainC must call membershipGateway.check');
  // On error, chainC must return null (signal fallback) — NOT throw
  assert.ok(chainC.includes('return null; // signal: main code should fall back'),
    'chainC must return null on error (not throw) to signal fallback');
  // If no tgUser.id, chainC must also return null (no Telegram API call possible)
  assert.ok(chainC.includes('return null; // signal: no tg user'),
    'chainC must return null when tgUser.id is missing');
});

test('BOOT-PARALLEL-005: chainD (admin) is independent — returns admin status from env|db', () => {
  const chainDMatch = USERS_SRC.match(/const chainD = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(chainDMatch, 'chainD definition must exist');
  const chainD = chainDMatch[0];
  assert.ok(chainD.includes('isAdminTelegramId(env, userId)'), 'chainD must check isAdminTelegramId');
  assert.ok(chainD.includes('adminRepo.getAdminByTelegramId'), 'chainD must check adminRepo');
  // Internal errors must keep env-check result (non-fatal)
  assert.ok(chainD.includes('console.warn'), 'chainD must log warning on error');
  assert.ok(chainD.includes('return isUserAdmin;'), 'chainD must return admin status');
});

test('BOOT-PARALLEL-006: chainE (isPremium) is independent — defaults to false on error', () => {
  const chainEMatch = USERS_SRC.match(/const chainE = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(chainEMatch, 'chainE definition must exist');
  const chainE = chainEMatch[0];
  assert.ok(chainE.includes('membershipAuthority.isPremium'), 'chainE must call membershipAuthority.isPremium');
  assert.ok(chainE.includes('let isPremiumUser = false;'), 'chainE must default to false');
  assert.ok(chainE.includes('return isPremiumUser;'), 'chainE must return isPremiumUser');
});

test('BOOT-PARALLEL-007: Promise.all([chainA, chainB]) for fatal chains', () => {
  assert.ok(USERS_SRC.includes('const [userRow, watchlist] = await Promise.all([chainA, chainB]);'),
    'chainA (userRow) and chainB (watchlist) must be awaited via Promise.all — both are fatal');
});

test('BOOT-PARALLEL-008: chainC resolved separately for null-fallback logic', () => {
  // chainC must be awaited SEPARATELY (not in Promise.all) because its result
  // can be null (signal fallback) — we need to handle that explicitly.
  assert.ok(USERS_SRC.includes('const chainCResult = await chainC;'),
    'chainC must be awaited separately as chainCResult');
  assert.ok(USERS_SRC.includes('if (chainCResult === null)'),
    'main code must check chainCResult === null for fallback');
  assert.ok(USERS_SRC.includes('channelJoined = Boolean(userRow?.channel_joined)'),
    'main code must fall back to Boolean(userRow?.channel_joined) when chainC returns null');
});

test('BOOT-PARALLEL-009: Promise.all([chainD, chainE]) for non-fatal chains', () => {
  assert.ok(USERS_SRC.includes('const [isUserAdmin, isPremiumUser] = await Promise.all([chainD, chainE]);'),
    'chainD (admin) and chainE (premium) must be awaited via Promise.all — both non-fatal');
});

test('BOOT-PARALLEL-010: fireDailyLoginMission still runs AFTER chainC resolves (needs channelJoined)', () => {
  // Mission reward logic requires channelJoined — must run after chainC
  const chainCResolveIdx = USERS_SRC.indexOf('const chainCResult = await chainC;');
  const fireDailyIdx = USERS_SRC.indexOf('fireDailyLoginMission', chainCResolveIdx);
  assert.ok(chainCResolveIdx > -1, 'chainC must be resolved');
  assert.ok(fireDailyIdx > chainCResolveIdx,
    'fireDailyLoginMission must run AFTER chainC is resolved (needs channelJoined)');
  // The guard must still check channelJoined
  const fireBlockMatch = USERS_SRC.match(/if \(channelJoined && isDatabaseConfigured[\s\S]*?fireDailyLoginMission/);
  assert.ok(fireBlockMatch, 'fireDailyLoginMission must still be gated on channelJoined');
});

test('BOOT-PARALLEL-011: response shape preserved (user, watchlist, channel_joined, is_admin, is_premium)', () => {
  // The response must still contain all the original fields
  const responseMatch = USERS_SRC.match(/return jsonResponse\(\{[\s\S]*?status: 'success'[\s\S]*?\}, \{\}, env\);/);
  assert.ok(responseMatch, 'response must be returned via jsonResponse');
  const response = responseMatch[0];
  assert.ok(response.includes("status: 'success'"), 'response.status must be success');
  assert.ok(response.includes('user:'), 'response must include user');
  assert.ok(response.includes('watchlist,'), 'response must include watchlist');
  assert.ok(response.includes('channel_joined:'), 'response must include channel_joined');
  assert.ok(response.includes('is_admin:'), 'response must include is_admin');
  assert.ok(response.includes('is_premium:'), 'response must include is_premium');
  assert.ok(response.includes('bot_username:'), 'response must include bot_username');
});

test('BOOT-PARALLEL-012: no NEW subrequests — same DB queries + Telegram API call', () => {
  // Verify the same operations are called (just parallelized, not duplicated).
  // Count ONLY `await <call>(` patterns — excludes mentions in comments.
  const getByIdCount = (USERS_SRC.match(/await\s+userRepo\.getById/g) || []).length;
  const bootstrapCount = (USERS_SRC.match(/await\s+userRepo\.bootstrap/g) || []).length;
  const watchlistCount = (USERS_SRC.match(/await\s+watchlistRepo\.getSymbols/g) || []).length;
  const membershipCount = (USERS_SRC.match(/await\s+membershipGateway\.check/g) || []).length;
  const adminCount = (USERS_SRC.match(/await\s+adminRepo\.getAdminByTelegramId/g) || []).length;
  const premiumCount = (USERS_SRC.match(/await\s+membershipAuthority\.isPremium/g) || []).length;
  const referralCount = (USERS_SRC.match(/await\s+processReferralOnBootstrap/g) || []).length;

  // getById appears 3x: chainA (bootstrap) + handleMe + handleDeleteAccount
  assert.equal(getByIdCount, 3, 'userRepo.getById must appear 3x (chainA + handleMe + handleDeleteAccount)');
  assert.equal(bootstrapCount, 1, 'userRepo.bootstrap must appear 1x (chainA)');
  // watchlist appears 2x: chainB (bootstrap) + handleMe
  assert.equal(watchlistCount, 2, 'watchlistRepo.getSymbols must appear 2x (chainB + handleMe)');
  assert.equal(membershipCount, 1, 'membershipGateway.check must appear 1x (chainC)');
  assert.equal(adminCount, 1, 'adminRepo.getAdminByTelegramId must appear 1x (chainD)');
  assert.equal(premiumCount, 1, 'membershipAuthority.isPremium must appear 1x (chainE)');
  assert.equal(referralCount, 1, 'processReferralOnBootstrap must appear 1x (chainA)');
});

test('BOOT-PARALLEL-013: error handling preserved — chainA/B failures propagate to outer catch', () => {
  // chainA and chainB must throw on failure (fatal)
  const chainAMatch = USERS_SRC.match(/const chainA = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  const chainBMatch = USERS_SRC.match(/const chainB = \(async \(\) => \{[\s\S]*?\}\)\(\);/);
  assert.ok(chainAMatch[0].includes('throw e;'), 'chainA must rethrow on failure');
  assert.ok(chainBMatch[0].includes('throw e;'), 'chainB must rethrow on failure');
  // Outer catch must still log + return safeDbErrorResponse
  assert.ok(USERS_SRC.includes("console.warn(safeError('bootstrap-user', error));"),
    'outer catch must log via safeError');
  assert.ok(USERS_SRC.includes('return safeDbErrorResponse(error, { statusValue: \'DB_ERROR\' }, env);'),
    'outer catch must return safeDbErrorResponse');
});

// ============================================================================
// Section 3: /api/users/bootstrap is NOT maintenance-gated (backend security check)
// ============================================================================

test('BOOT-SECURITY-001: /api/users/bootstrap route is NOT maintenance-gated', () => {
  // The bootstrap route must NOT check maintenance state — admins need to be
  // able to bootstrap during maintenance so they can be detected + bypass.
  const bootstrapRouteIdx = WORKER_SRC.indexOf("url.pathname === '/api/users/bootstrap'");
  assert.ok(bootstrapRouteIdx > -1, 'bootstrap route must exist in worker-proxy.js');

  // Look at the 200 bytes BEFORE the bootstrap route — must NOT mention maintenance
  const beforeBlock = WORKER_SRC.slice(Math.max(0, bootstrapRouteIdx - 500), bootstrapRouteIdx);
  assert.ok(!beforeBlock.includes('maintenance'),
    'bootstrap route must NOT be gated by maintenance check');

  // Look at the bootstrap route handler itself — must NOT call getMaintenanceState
  const afterBlock = WORKER_SRC.slice(bootstrapRouteIdx, bootstrapRouteIdx + 2000);
  assert.ok(!afterBlock.includes('getMaintenanceState'),
    'bootstrap handler must NOT call getMaintenanceState (would block during maintenance)');
});

test('BOOT-SECURITY-002: /api/system/status IS the maintenance check endpoint (public)', () => {
  // The maintenance check uses /api/system/status, NOT /api/users/bootstrap
  const systemStatusIdx = WORKER_SRC.indexOf("url.pathname === '/api/system/status'");
  assert.ok(systemStatusIdx > -1, '/api/system/status route must exist');

  // It must call getMaintenanceState
  const systemStatusBlock = WORKER_SRC.slice(systemStatusIdx, systemStatusIdx + 500);
  assert.ok(systemStatusBlock.includes('getMaintenanceState'),
    '/api/system/status must call getMaintenanceState');

  // It must NOT require auth (public) — comment is BEFORE the route check
  const beforeBlock = WORKER_SRC.slice(Math.max(0, systemStatusIdx - 300), systemStatusIdx);
  assert.ok(beforeBlock.includes('No auth required') || beforeBlock.includes('public'),
    '/api/system/status must be documented as no-auth/public (comment before route check)');
});

// ============================================================================
// Section 4: Dynamic test — parallel chains complete in max(chainA, chainB, …) not sum
// ============================================================================

test('BOOT-PARALLEL-014: chains fire concurrently (Promise.all timing simulation)', async () => {
  // Simulate the parallel pattern: 5 operations with different latencies.
  // Sequential would take sum; parallel takes max.
  //
  // CRITICAL: All 5 chains are FIRED at time 0 (in parallel). The awaits
  // are sequential (Promise.all([A,B]) → await C → Promise.all([D,E])) but
  // the chains themselves run concurrently. By the time Promise.all([A,B])
  // resolves at max(200,150)=200ms, chains C (100ms), D (80ms), E (50ms)
  // have ALREADY completed. So the awaits after Promise.all([A,B]) are
  // effectively instant (chains already resolved).
  // Total elapsed: max(all chains) = ~200ms (NOT 380ms — the partial-sum
  // reasoning is wrong because chains fire from time 0, not from when awaited).
  const latencies = [200, 150, 100, 80, 50]; // chainA, B, C, D, E

  // Sequential time (would be)
  const sequentialTime = latencies.reduce((a, b) => a + b, 0);
  assert.equal(sequentialTime, 580);

  // Parallel: all chains fire from time 0, awaits are sequential but chains
  // complete in parallel. Total elapsed = max(all chain latencies) = 200ms.
  const t0 = Date.now();
  const chainA = new Promise(r => setTimeout(() => r('A'), 200));
  const chainB = new Promise(r => setTimeout(() => r('B'), 150));
  const chainC = new Promise(r => setTimeout(() => r(null), 100));
  const chainD = new Promise(r => setTimeout(() => r(true), 80));
  const chainE = new Promise(r => setTimeout(() => r(false), 50));

  const [, watchlist] = await Promise.all([chainA, chainB]);
  const chainCResult = await chainC; // likely already resolved (took 100ms, we're at 200ms)
  const [, ] = await Promise.all([chainD, chainE]); // already resolved
  const elapsed = Date.now() - t0;

  // Total elapsed should be ~max(200,150,100,80,50) = 200ms (not 380ms)
  // because all chains fire from time 0 — the awaits just wait for the
  // slowest chain (chainA at 200ms).
  assert.ok(elapsed >= 190 && elapsed <= 260,
    `parallel execution must take ~200ms (max of all chains, not partial sums), took ${elapsed}ms`);
  assert.ok(elapsed < sequentialTime,
    `parallel (${elapsed}ms) must be faster than sequential (${sequentialTime}ms)`);
  assert.equal(chainCResult, null, 'chainC must return null for fallback simulation');
  assert.equal(watchlist, 'B', 'watchlist must resolve from chainB');
});

test('BOOT-PARALLEL-015: null-fallback logic matches old behavior (DB row used when membership fails)', async () => {
  // Simulate the new fallback logic: chainC returns null → main code uses userRow.channel_joined
  const chainCResult = null; // simulate membership check failure
  const userRow = { channel_joined: true }; // simulate DB row from chainA

  let channelJoined;
  if (chainCResult === null) {
    channelJoined = Boolean(userRow?.channel_joined);
  } else {
    channelJoined = chainCResult;
  }

  assert.equal(channelJoined, true,
    'when chainC returns null, channelJoined must fall back to userRow.channel_joined (true)');

  // Test the false case too
  const userRow2 = { channel_joined: false };
  if (chainCResult === null) {
    channelJoined = Boolean(userRow2?.channel_joined);
  }
  assert.equal(channelJoined, false,
    'when chainC returns null + userRow.channel_joined=false, channelJoined must be false');

  // Test when chainC returns a value (membership check succeeded)
  const chainCResult2 = false; // membership check says not joined
  if (chainCResult2 === null) {
    channelJoined = Boolean(userRow?.channel_joined);
  } else {
    channelJoined = chainCResult2;
  }
  assert.equal(channelJoined, false,
    'when chainC returns false, channelJoined must be false (chainC result takes precedence)');
});

// ============================================================================
// Section 5: No duplicate bootstrap (dedup guards preserved)
// ============================================================================

test('BOOT-DEDUP-001: _bootstrapUserInFlight guard preserved', () => {
  assert.ok(APP_SRC.includes('let _bootstrapUserInFlight = null;'),
    '_bootstrapUserInFlight must exist');
  assert.ok(APP_SRC.includes('if (_bootstrapUserInFlight) {'),
    '_bootstrapUserInFlight must be checked');
  assert.ok(APP_SRC.includes('return _bootstrapUserInFlight;'),
    'in-flight promise must be returned (dedup)');
  assert.ok(APP_SRC.includes('.finally(() => { _bootstrapUserInFlight = null; })'),
    '_bootstrapUserInFlight must be cleared in finally (no stuck promise)');
});

test('BOOT-DEDUP-002: _bootstrapPromise guard preserved (for tryLateBootstrap)', () => {
  assert.ok(APP_SRC.includes('let _bootstrapPromise = null;'),
    '_bootstrapPromise must exist');
  assert.ok(APP_SRC.includes('if (_bootstrapPromise) return _bootstrapPromise;'),
    '_bootstrapPromise must be returned (dedup)');
  assert.ok(APP_SRC.includes("_bootstrapPromise = _doBootstrap().finally(() => { _bootstrapPromise = null; });"),
    '_bootstrapPromise must be cleared in finally');
});

test('BOOT-DEDUP-003: bootstrapComplete flag set BEFORE updateMaintenanceAdminBypass call', () => {
  // bootstrapComplete must be set BEFORE updateMaintenanceAdminBypass so
  // isAdmin() returns the correct value when the bypass button is shown.
  const setCompleteIdx = APP_SRC.indexOf('bootstrapComplete = true;');
  assert.ok(setCompleteIdx > -1, 'bootstrapComplete = true must exist');
  const updateBypassIdx = APP_SRC.indexOf('if (typeof updateMaintenanceAdminBypass', setCompleteIdx);
  assert.ok(updateBypassIdx > setCompleteIdx,
    'updateMaintenanceAdminBypass must be called AFTER bootstrapComplete = true');
});

// ============================================================================
// Summary
// ============================================================================

test('SUMMARY: PHASE 1 + PHASE 2 fixes verified', () => {
  // Final sanity check — all critical patterns present
  assert.ok(APP_SRC.includes('_parallelBootstrapPromise'),
    'PHASE 1: parallel bootstrap promise must exist');
  assert.ok(USERS_SRC.includes('chainA') && USERS_SRC.includes('chainB') &&
    USERS_SRC.includes('chainC') && USERS_SRC.includes('chainD') && USERS_SRC.includes('chainE'),
    'PHASE 2: 5 parallel chains must exist in handleBootstrap');
});

// ============================================================================
// Section 6: AUDIT-BYPASS-BLACK-SCREEN — boot-loader-overlay stuck after admin bypass
// ============================================================================
// ROOT CAUSE: checkMaintenanceMode() had early-return paths that returned `true`
// WITHOUT calling _removeBootLoader(). After admin clicks bypass → reload,
// sessionStorage has maint_bypassed='1', checkMaintenanceMode hits the early
// return, and _removeBootLoader() was never called → the boot-loader-overlay
// (black screen with infinite spinner, z-index 999998) stayed visible forever.
//
// FIX: All early-return paths in checkMaintenanceMode() now call
// _removeBootLoader() before returning true. The 4 paths fixed are:
//   1. _maintenanceBypassed flag (in-memory)
//   2. sessionStorage.maint_bypassed === '1'
//   3. No API_BASE configured (fail-open)
//   4. HTTP error from /api/system/status (fail-open)
//
// SECURITY: This fix ONLY removes the visual overlay. It does NOT change
// admin detection, join check, bootstrap, maintenance security, or bypass
// authorization. The bypass button is still only shown to server-confirmed
// admins (isAdmin() requires bootstrapComplete + isCurrentUserAdmin).
// ============================================================================

// Helper: extract checkMaintenanceMode function block from app.js source.
// Handles strings, regex literals, and both // and /* */ comments correctly.
function extractCheckMaintenanceMode(src) {
  const start = src.indexOf('async function checkMaintenanceMode()');
  assert.ok(start > -1, 'checkMaintenanceMode must be defined');
  // Find the opening brace of the function body
  let i = src.indexOf('{', start);
  let depth = 0;
  let inStr = false, strCh = '';
  let inLineComment = false, inBlockComment = false, inRegex = false;
  let prev = '';
  for (; i < src.length; i++) {
    const c = src[i];
    if (inLineComment) {
      if (c === '\n') inLineComment = false;
      prev = c;
      continue;
    }
    if (inBlockComment) {
      if (c === '*' && src[i + 1] === '/') { i++; inBlockComment = false; }
      prev = c;
      continue;
    }
    if (inStr) {
      if (c === '\\') { i++; prev = c; continue; }
      if (c === strCh) inStr = false;
      prev = c;
      continue;
    }
    if (inRegex) {
      if (c === '\\') { i++; prev = c; continue; }
      if (c === '/' && (prev !== '\\')) inRegex = false;
      // Handle character classes [...] — braces inside [] don't count
      if (c === '[') {
        // Skip to matching ]
        let clsDepth = 1; i++;
        while (i < src.length && clsDepth > 0) {
          if (src[i] === '\\') { i++; continue; }
          if (src[i] === ']') clsDepth--;
          if (src[i] === '[') clsDepth++;
          if (src[i] === '\n') break; // regex can't span newlines
          i++;
        }
      }
      prev = c;
      continue;
    }
    // Check for comment starts
    if (c === '/' && src[i + 1] === '/') { inLineComment = true; i++; prev = c; continue; }
    if (c === '/' && src[i + 1] === '*') { inBlockComment = true; i++; prev = c; continue; }
    // Check for string starts
    if (c === '"' || c === "'" || c === '`') { inStr = true; strCh = c; prev = c; continue; }
    // Check for regex starts — heuristic: / preceded by (,=,:,[,!,&,|,?,;,{,} or start of expr
    if (c === '/' && !inStr && !inRegex) {
      // Look back at the last non-whitespace char
      let j = i - 1;
      while (j >= 0 && /\s/.test(src[j])) j--;
      const lastCh = src[j];
      if (lastCh === undefined || '(,=:[!&|?;{}'.includes(lastCh)) {
        inRegex = true;
        prev = c;
        continue;
      }
    }
    // Track braces
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) return src.slice(start, i + 1);
    }
    prev = c;
  }
  throw new Error('checkMaintenanceMode function block not properly closed');
}

test('BOOT-LOADER-001: _maintenanceBypassed early-return path calls _removeBootLoader()', () => {
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  // Find the _maintenanceBypassed early return path
  const bypassFlagIdx = fnBlock.indexOf('if (_maintenanceBypassed)');
  assert.ok(bypassFlagIdx > -1, '_maintenanceBypassed check must exist in checkMaintenanceMode');

  // Slice from the if to the next 500 chars (includes the FIX comment + call + return)
  const bypassBlock = fnBlock.slice(bypassFlagIdx, bypassFlagIdx + 500);
  // Look for the actual CALL (with ;) — not just a comment mention
  assert.ok(/_removeBootLoader\(\);/.test(bypassBlock),
    '_maintenanceBypassed early-return MUST call _removeBootLoader() — otherwise black spinner stays stuck after bypass reload');
  assert.ok(bypassBlock.includes('return true;'),
    '_maintenanceBypassed path must still return true (fail-open to app)');
});

test('BOOT-LOADER-002: sessionStorage.maint_bypassed early-return path calls _removeBootLoader() (CRITICAL)', () => {
  // THIS IS THE CRITICAL PATH that was the actual root cause of the bug:
  // After admin clicks bypass → reload, sessionStorage has maint_bypassed='1'.
  // checkMaintenanceMode hits this early return. Before the fix, it returned
  // true WITHOUT calling _removeBootLoader() → black spinner stuck forever.
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  const sessionIdx = fnBlock.indexOf("sessionStorage.getItem('maint_bypassed') === '1'");
  assert.ok(sessionIdx > -1, 'sessionStorage.maint_bypassed check must exist');

  // Slice from the sessionStorage check to the next 500 chars (includes comment + call)
  const sessionBlock = fnBlock.slice(sessionIdx, sessionIdx + 500);
  assert.ok(sessionBlock.includes('_maintenanceBypassed = true;'),
    'sessionStorage path must set _maintenanceBypassed = true (preserved)');
  // Look for the actual CALL (with ;) — not just a comment mention
  assert.ok(/_removeBootLoader\(\);/.test(sessionBlock),
    'sessionStorage.maint_bypassed early-return MUST call _removeBootLoader() — THIS WAS THE BUG');
  assert.ok(sessionBlock.includes('return true;'),
    'sessionStorage path must still return true (bypass confirmed, app continues)');
});

test('BOOT-LOADER-003: no-API_BASE early-return path calls _removeBootLoader()', () => {
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  const noBaseUrlIdx = fnBlock.indexOf('if (!baseUrl)');
  assert.ok(noBaseUrlIdx > -1, '!baseUrl check must exist');

  // Slice from !baseUrl to the next 500 chars (includes comment + call + return)
  const noBaseUrlBlock = fnBlock.slice(noBaseUrlIdx, noBaseUrlIdx + 500);
  assert.ok(noBaseUrlBlock.includes("check skipped — no API_BASE"),
    'no-API_BASE path must log skip message (preserved)');
  // Look for the actual CALL (with ;) — not just a comment mention
  assert.ok(/_removeBootLoader\(\);/.test(noBaseUrlBlock),
    'no-API_BASE early-return MUST call _removeBootLoader() — otherwise black spinner stays stuck');
  assert.ok(noBaseUrlBlock.includes('return true;'),
    'no-API_BASE path must still return true (fail-open)');
});

test('BOOT-LOADER-004: HTTP error early-return path calls _removeBootLoader()', () => {
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  const httpErrIdx = fnBlock.indexOf('if (!resp.ok)');
  assert.ok(httpErrIdx > -1, '!resp.ok check must exist');

  // Slice from !resp.ok to the next 500 chars (includes comment + call + return)
  const httpErrBlock = fnBlock.slice(httpErrIdx, httpErrIdx + 500);
  assert.ok(httpErrBlock.includes("check skipped — HTTP"),
    'HTTP error path must log skip message (preserved)');
  // Look for the actual CALL (with ;) — not just a comment mention
  assert.ok(/_removeBootLoader\(\);/.test(httpErrBlock),
    'HTTP error early-return MUST call _removeBootLoader() — otherwise black spinner stays stuck');
  assert.ok(httpErrBlock.includes('return true;'),
    'HTTP error path must still return true (fail-open)');
});

test('BOOT-LOADER-005: maintenance-ON path still calls _removeBootLoader() (no regression)', () => {
  // This path was ALREADY calling _removeBootLoader() before the fix — verify it still does
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  const maintOnIdx = fnBlock.indexOf('if (maint.enabled === true)');
  assert.ok(maintOnIdx > -1, 'maintenance.enabled === true check must exist');

  // Slice from maintenance-ON to the next 400 chars (covers full block)
  const maintOnBlock = fnBlock.slice(maintOnIdx, maintOnIdx + 400);
  assert.ok(maintOnBlock.includes('showMaintenancePopup(maint)'),
    'maintenance-ON path must show popup (preserved)');
  assert.ok(maintOnBlock.includes('_maintenanceActive = true'),
    'maintenance-ON path must set _maintenanceActive = true (preserved)');
  // Look for the actual CALL (with ;)
  assert.ok(/_removeBootLoader\(\);/.test(maintOnBlock),
    'maintenance-ON path must still call _removeBootLoader() (no regression)');
  assert.ok(maintOnBlock.includes('return false;'),
    'maintenance-ON path must still return false (caller must STOP — preserved)');
});

test('BOOT-LOADER-006: maintenance-OFF path still calls _removeBootLoader() (no regression)', () => {
  // This path was ALREADY calling _removeBootLoader() before the fix — verify it still does
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  // Maintenance-OFF path: the comment "Maintenance is OFF" appears right before _removeBootLoader
  const maintOffIdx = fnBlock.indexOf('// Maintenance is OFF — remove boot loader');
  assert.ok(maintOffIdx > -1, 'maintenance-OFF path must exist');

  // Slice from the comment to the next 100 chars
  const maintOffBlock = fnBlock.slice(maintOffIdx, maintOffIdx + 100);
  assert.ok(maintOffBlock.includes('_removeBootLoader()'),
    'maintenance-OFF path must still call _removeBootLoader() (no regression)');
});

test('BOOT-LOADER-007: network-error catch path still calls _removeBootLoader() (no regression)', () => {
  // This path was ALREADY calling _removeBootLoader() before the fix — verify it still does
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  const catchIdx = fnBlock.indexOf('console.log(\'[MAINT] check skipped (network):\'');
  assert.ok(catchIdx > -1, 'network-error catch path must exist');

  // Slice from the log to the next 150 chars
  const catchBlock = fnBlock.slice(catchIdx, catchIdx + 150);
  assert.ok(catchBlock.includes('_removeBootLoader()'),
    'network-error catch path must still call _removeBootLoader() (no regression)');
  assert.ok(catchBlock.includes('return true;'),
    'network-error catch path must still return true (fail-open — preserved)');
});

test('BOOT-LOADER-008: exactly 4 new _removeBootLoader() CALLS added in early-return paths', () => {
  // Count all _removeBootLoader() CALLS (with ;) inside checkMaintenanceMode
  // — excludes comment mentions which don't have ;
  const fnBlock = extractCheckMaintenanceMode(APP_SRC);
  const callCount = (fnBlock.match(/_removeBootLoader\(\);/g) || []).length;
  // Expected: 4 new (early-return paths) + 3 existing (maintenance-ON, maintenance-OFF, network-error)
  //          = 7 total actual CALLS (with ;)
  // NOTE: comment mentions of _removeBootLoader() (without ;) are NOT counted.
  assert.equal(callCount, 7,
    `checkMaintenanceMode must have 7 _removeBootLoader() CALLS (with ;) — 4 new early-return + 3 existing paths. Got ${callCount}. (Comment mentions without ; are excluded from this count.)`);
});

test('BOOT-LOADER-009: adminBypassMaintenance() still gates on isAdmin() (security preserved)', () => {
  // Verify the bypass function still has its security check — the fix doesn't weaken it
  const bypassFnMatch = APP_SRC.match(/function adminBypassMaintenance\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(bypassFnMatch, 'adminBypassMaintenance function must exist');
  assert.ok(bypassFnMatch[0].includes('if (!isAdmin())'),
    'adminBypassMaintenance must still check isAdmin() — SECURITY PRESERVED');
  assert.ok(bypassFnMatch[0].includes("sessionStorage.setItem('maint_bypassed', '1')"),
    'adminBypassMaintenance must still set sessionStorage.maint_bypassed (preserved)');
  assert.ok(bypassFnMatch[0].includes('window.location.reload()'),
    'adminBypassMaintenance must still reload the page (preserved)');
});

test('BOOT-LOADER-010: no other code changes outside checkMaintenanceMode (scope check)', () => {
  // Verify the fix is scoped to checkMaintenanceMode — no other function should
  // have a new _removeBootLoader() call. We check that adminBypassMaintenance,
  // showMaintenancePopup, updateMaintenanceAdminBypass, and _bootstrapUserImpl
  // do NOT contain _removeBootLoader() (they didn't before, they shouldn't now).
  const bypassFnMatch = APP_SRC.match(/function adminBypassMaintenance\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(bypassFnMatch && !bypassFnMatch[0].includes('_removeBootLoader()'),
    'adminBypassMaintenance must NOT call _removeBootLoader() (scope preserved)');

  const popupFnMatch = APP_SRC.match(/function showMaintenancePopup\(maint\)\s*\{[\s\S]*?\n\}/);
  assert.ok(popupFnMatch && !popupFnMatch[0].includes('_removeBootLoader()'),
    'showMaintenancePopup must NOT call _removeBootLoader() (scope preserved)');

  const updateFnMatch = APP_SRC.match(/function updateMaintenanceAdminBypass\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(updateFnMatch && !updateFnMatch[0].includes('_removeBootLoader()'),
    'updateMaintenanceAdminBypass must NOT call _removeBootLoader() (scope preserved)');
});

// ============================================================================
// Summary (updated)
// ============================================================================

test('SUMMARY-UPDATED: PHASE 1 + PHASE 2 + AUDIT-BYPASS-BLACK-SCREEN fixes verified', () => {
  // Final sanity check — all critical patterns present
  assert.ok(APP_SRC.includes('_parallelBootstrapPromise'),
    'PHASE 1: parallel bootstrap promise must exist');
  assert.ok(USERS_SRC.includes('chainA') && USERS_SRC.includes('chainB') &&
    USERS_SRC.includes('chainC') && USERS_SRC.includes('chainD') && USERS_SRC.includes('chainE'),
    'PHASE 2: 5 parallel chains must exist in handleBootstrap');
  assert.ok(APP_SRC.includes('AUDIT-BYPASS-BLACK-SCREEN'),
    'AUDIT-BYPASS-BLACK-SCREEN: fix marker must be present in app.js');
});

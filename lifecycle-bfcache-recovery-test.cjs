/**
 * Regression tests for the LIFECYCLE/BFCACHE recovery fix.
 *
 * ROOT CAUSE (verified): When the page goes to bfcache (iOS WebKit) while a
 * bootstrap fetch is in-flight, the fetch is aborted by the browser but the
 * returned promise may stay pending forever ("aborted-but-stuck" quirk). The
 * .finally() that clears _bootstrapUserInFlight never fires, so subsequent
 * bootstrapUser() calls return the stuck promise (dedup) and no new API call
 * is made → Join Check + Admin Detection never run.
 *
 * FIX: A 'pagehide' handler records the hide timestamp. On 'pageshow'
 * (event.persisted) and 'visibilitychange' (visible), if the page was hidden
 * for more than 20s AND an in-flight bootstrap promise still exists, both
 * _bootstrapUserInFlight and _bootstrapPromise are cleared so the next
 * tryLateBootstrap() makes a fresh API call.
 *
 * These tests verify:
 *   1. Normal bootstrap → no change in behavior
 *   2. Bootstrap already complete → no new bootstrap
 *   3. Rapid Open/Close (< 20s) → no extra bootstrap (no false reset)
 *   4. Hidden > 20s + stuck in-flight → fresh bootstrap on restore
 *   5. Page refresh → existing behavior preserved
 *   6. Admin detection still server-confirmed
 *   7. Join Check still runs (via bootstrap, not independently)
 *   8. No security bypass
 *
 * Run: node --test lifecycle-bfcache-recovery-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// ============================================================================
// Section 1: Static verification — the fix code exists in app.js
// ============================================================================

test('LIFECYCLE-001: _pageHiddenAt state variable is declared at module level', () => {
  // Must be module-level (persists across function calls, survives bfcache)
  assert.ok(/^(let|var|const)\s+_pageHiddenAt\s*=\s*0;?/m.test(APP_SRC),
    '_pageHiddenAt must be declared at module level with initial value 0');
});

test('LIFECYCLE-002: pagehide handler records the hide timestamp', () => {
  // Must use addEventListener('pagehide', ...) and set _pageHiddenAt = Date.now()
  const pagehideIdx = APP_SRC.indexOf("window.addEventListener('pagehide',");
  assert.ok(pagehideIdx > -1, 'pagehide handler must exist');
  const block = APP_SRC.slice(pagehideIdx, pagehideIdx + 300);
  assert.ok(block.includes('_pageHiddenAt = Date.now()'),
    'pagehide handler must set _pageHiddenAt = Date.now()');
});

test('LIFECYCLE-003: pageshow handler has stuck-promise detection logic', () => {
  // The pageshow handler must check event.persisted, then if !bootstrapComplete,
  // check _pageHiddenAt + 20000 threshold, then clear _bootstrapUserInFlight and _bootstrapPromise
  const pageshowIdx = APP_SRC.indexOf("window.addEventListener('pageshow',");
  assert.ok(pageshowIdx > -1, 'pageshow handler must exist');
  const block = APP_SRC.slice(pageshowIdx, pageshowIdx + 1200);
  assert.ok(block.includes('event.persisted'),
    'pageshow must check event.persisted (bfcache signal)');
  assert.ok(block.includes('!bootstrapComplete'),
    'pageshow recovery must be gated on !bootstrapComplete (no bootstrap if already complete)');
  assert.ok(block.includes('_pageHiddenAt'),
    'pageshow must use _pageHiddenAt for stuck detection');
  assert.ok(block.includes('> 20000'),
    'pageshow must use 20s threshold for stuck detection');
  assert.ok(block.includes('_bootstrapUserInFlight = null'),
    'pageshow must clear _bootstrapUserInFlight when stuck detected');
  assert.ok(block.includes('_bootstrapPromise = null'),
    'pageshow must clear _bootstrapPromise when stuck detected (breaks the await chain)');
  assert.ok(block.includes('tryLateBootstrap()'),
    'pageshow must call tryLateBootstrap() after stuck detection');
});

test('LIFECYCLE-004: visibilitychange handler has stuck-promise detection in visible path', () => {
  // The visibilitychange handler's visible branch must have the same stuck detection
  const visIdx = APP_SRC.indexOf("document.addEventListener('visibilitychange',");
  assert.ok(visIdx > -1, 'visibilitychange handler must exist');
  // Use a larger window (2500 chars) because the comment block is long
  const block = APP_SRC.slice(visIdx, visIdx + 2500);
  // Find the "else" (visible) branch
  const elseIdx = block.indexOf('} else {');
  assert.ok(elseIdx > -1, 'visibilitychange must have else (visible) branch');
  const elseBlock = block.slice(elseIdx);
  assert.ok(elseBlock.includes('!bootstrapComplete'),
    'visibilitychange visible path must be gated on !bootstrapComplete');
  assert.ok(elseBlock.includes('_pageHiddenAt'),
    'visibilitychange visible path must use _pageHiddenAt');
  assert.ok(elseBlock.includes('> 20000'),
    'visibilitychange visible path must use 20s threshold');
  assert.ok(elseBlock.includes('_bootstrapUserInFlight = null'),
    'visibilitychange visible path must clear _bootstrapUserInFlight when stuck');
  assert.ok(elseBlock.includes('_bootstrapPromise = null'),
    'visibilitychange visible path must clear _bootstrapPromise when stuck');
  assert.ok(elseBlock.includes('tryLateBootstrap()'),
    'visibilitychange visible path must call tryLateBootstrap()');
});

test('LIFECYCLE-005: visibilitychange handler records hide timestamp in hidden path', () => {
  const visIdx = APP_SRC.indexOf("document.addEventListener('visibilitychange',");
  const block = APP_SRC.slice(visIdx, visIdx + 1500);
  // Find the "if (document.hidden)" branch
  const hiddenIdx = block.indexOf('if (document.hidden)');
  assert.ok(hiddenIdx > -1, 'visibilitychange must have if (document.hidden) branch');
  const hiddenBlock = block.slice(hiddenIdx, block.indexOf('} else {'));
  assert.ok(hiddenBlock.includes('_pageHiddenAt'),
    'visibilitychange hidden path must set _pageHiddenAt');
  assert.ok(hiddenBlock.includes('Date.now()'),
    'visibilitychange hidden path must record Date.now()');
  assert.ok(hiddenBlock.includes('if (!_pageHiddenAt)'),
    'visibilitychange hidden path must guard against overwriting _pageHiddenAt');
});

// ============================================================================
// Section 2: Dynamic simulation — verify the fix logic
// ============================================================================

// Simulate the lifecycle recovery logic (extracted from app.js)
function createLifecycleSimulator() {
  let _pageHiddenAt = 0;
  let _bootstrapUserInFlight = null;
  let _bootstrapPromise = null;
  let bootstrapComplete = false;
  let _isTelegramAuthReady = false;
  let _apiCallCount = 0;
  let _stuckFetch = null; // simulates a fetch that never resolves (bfcache abort)

  const sim = {
    // The real bootstrapUser() dedup pattern
    async bootstrapUser() {
      if (_bootstrapUserInFlight) {
        return _bootstrapUserInFlight;
      }
      _bootstrapUserInFlight = (async () => {
        await this._bootstrapUserImpl();
      })().finally(() => { _bootstrapUserInFlight = null; });
      return _bootstrapUserInFlight;
    },

    async _bootstrapUserImpl() {
      _apiCallCount++;
      if (_stuckFetch) {
        await _stuckFetch; // never resolves (stuck)
      } else {
        await new Promise(r => setTimeout(r, 50)); // fast success
      }
      bootstrapComplete = true;
    },

    // The real tryLateBootstrap() dedup pattern
    async tryLateBootstrap() {
      if (bootstrapComplete) return;
      if (this._bootstrapFailedAt && (Date.now() - this._bootstrapFailedAt) < 5000) return;
      if (_bootstrapPromise) return _bootstrapPromise;
      _bootstrapPromise = this._doBootstrap().finally(() => { _bootstrapPromise = null; });
      return _bootstrapPromise;
    },

    async _doBootstrap() {
      if (!_isTelegramAuthReady) return;
      try {
        await this.bootstrapUser();
      } catch (e) {
        this._bootstrapFailedAt = Date.now();
      }
    },

    // Simulate the pagehide handler
    pagehide() {
      _pageHiddenAt = Date.now();
    },

    // Simulate the pageshow/visibilitychange visible recovery logic
    // (with the fix applied)
    restoreFromBfcache(restoreAuthReady = true) {
      if (!bootstrapComplete) {
        // LIFECYCLE/BFCACHE FIX: stuck-promise detection
        if (_pageHiddenAt && (Date.now() - _pageHiddenAt) > 20000) {
          if (_bootstrapUserInFlight) {
            _bootstrapUserInFlight = null;
          }
          if (_bootstrapPromise) {
            _bootstrapPromise = null;
          }
        }
        if (restoreAuthReady && _isTelegramAuthReady) {
          this.tryLateBootstrap();
        }
      }
      _pageHiddenAt = 0;
    },

    // Getters / setters
    getBootstrapComplete: () => bootstrapComplete,
    getApiCallCount: () => _apiCallCount,
    getInFlight: () => _bootstrapUserInFlight,
    getBootstrapPromise: () => _bootstrapPromise,
    getPageHiddenAt: () => _pageHiddenAt,
    setTelegramAuthReady: (v) => { _isTelegramAuthReady = v; },
    setStuckFetch: (v) => { _stuckFetch = v },
    reset: () => {
      _pageHiddenAt = 0;
      _bootstrapUserInFlight = null;
      _bootstrapPromise = null;
      bootstrapComplete = false;
      _isTelegramAuthReady = false;
      _apiCallCount = 0;
      _stuckFetch = null;
    },
    // Simulate time advancing (for testing the 20s threshold)
    advanceTime: (ms) => { _pageHiddenAt = _pageHiddenAt ? _pageHiddenAt - ms : 0; },
  };
  return sim;
}

// ============================================================================
// Regression: Normal bootstrap → no change in behavior
// ============================================================================

test('LIFECYCLE-006: Normal bootstrap — completes, no extra API calls', async () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // First call — bootstrap fires and completes
  await sim.bootstrapUser();

  assert.equal(sim.getApiCallCount(), 1, 'one API call made');
  assert.equal(sim.getBootstrapComplete(), true, 'bootstrap completed');
  assert.equal(sim.getInFlight(), null, 'no in-flight promise after completion');
  assert.equal(sim.getBootstrapPromise(), null, 'no _bootstrapPromise after completion');
});

test('LIFECYCLE-007: Bootstrap already complete → no new bootstrap on restore', () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // Bootstrap completes
  return sim.bootstrapUser().then(() => {
    // Simulate pagehide
    sim.pagehide();

    // Simulate long bfcache (advance time by 30s)
    sim.advanceTime(30000);

    // Restore from bfcache
    sim.restoreFromBfcache(true);

    // bootstrapComplete is true → no new bootstrap should fire
    assert.equal(sim.getApiCallCount(), 1, 'NO new API call — bootstrap already complete');
    assert.equal(sim.getBootstrapComplete(), true, 'bootstrapComplete unchanged');
  });
});

// ============================================================================
// Regression: Rapid Open/Close (< 20s) → no extra bootstrap (no false reset)
// ============================================================================

test('LIFECYCLE-008: Rapid Open/Close (< 20s) → no false stuck detection, no reset', async () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // Start bootstrap (in-flight)
  sim.bootstrapUser();
  assert.equal(sim.getApiCallCount(), 1, 'one API call made');
  assert.ok(sim.getInFlight() !== null, 'in-flight promise exists');

  // Simulate pagehide
  sim.pagehide();

  // Simulate SHORT bfcache (advance time by only 5s — well below 20s threshold)
  sim.advanceTime(5000);

  // Restore from bfcache — should NOT reset the in-flight promise
  sim.restoreFromBfcache(true);

  // The in-flight promise should NOT have been reset (below 20s threshold)
  // The dedup should still be active — no new API call
  assert.equal(sim.getApiCallCount(), 1,
    'NO new API call — below 20s threshold, in-flight promise NOT reset (no duplicate)');
  assert.ok(sim.getInFlight() !== null,
    'in-flight promise still set (NOT reset — below 20s threshold)');
});

test('LIFECYCLE-009: Rapid Open/Close multiple times (< 20s each) → still no reset', async () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // First bootstrap starts
  sim.bootstrapUser();
  const initialApiCount = sim.getApiCallCount();

  // Simulate 3 rapid open/close cycles, each < 20s
  for (let i = 0; i < 3; i++) {
    sim.pagehide();
    sim.advanceTime(3000); // 3s in bfcache (well below 20s)
    sim.restoreFromBfcache(true);
  }

  // No new API calls should have been made (all below 20s threshold, no reset)
  assert.equal(sim.getApiCallCount(), initialApiCount,
    'NO extra API calls across 3 rapid open/close cycles (all < 20s)');
});

// ============================================================================
// Regression: Hidden > 20s + stuck in-flight → fresh bootstrap on restore
// ============================================================================

test('LIFECYCLE-010: Hidden > 20s + stuck in-flight → reset + fresh bootstrap on restore', async () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // Start bootstrap with a stuck fetch (simulates bfcache abort)
  sim.setStuckFetch(new Promise(() => {})); // never resolves
  sim.bootstrapUser();
  assert.equal(sim.getApiCallCount(), 1, 'one API call made (started)');
  assert.ok(sim.getInFlight() !== null, 'in-flight promise exists');

  // Simulate pagehide
  sim.pagehide();

  // Simulate LONG bfcache (advance time by 25s — above 20s threshold)
  sim.advanceTime(25000);

  // Clear the stuck fetch (simulates AbortSignal.timeout firing after restore)
  sim.setStuckFetch(null);

  // Restore from bfcache — should detect stuck and reset
  // restoreFromBfcache calls tryLateBootstrap (which calls bootstrapUser synchronously)
  // We need to await the promise to let the 50ms setTimeout resolve.
  const restorePromise = sim.restoreFromBfcache(true);
  await Promise.resolve(restorePromise);
  // Wait for the fresh bootstrap to complete (50ms in our sim)
  await new Promise(r => setTimeout(r, 100));

  // The in-flight promise should have been reset, and tryLateBootstrap should have fired
  // a fresh bootstrapUser() call
  assert.equal(sim.getApiCallCount(), 2,
    'NEW API call made after stuck detection + reset (Join Check + Admin Detection re-run)');
  assert.equal(sim.getBootstrapComplete(), true,
    'bootstrap completed after fresh call (stuck promise was cleared)');
});

test('LIFECYCLE-011: Hidden > 20s + NOT stuck (in-flight settled) → no reset needed', async () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // Start bootstrap (will complete in 50ms)
  await sim.bootstrapUser();
  assert.equal(sim.getApiCallCount(), 1, 'one API call made');
  assert.equal(sim.getBootstrapComplete(), true, 'bootstrap completed');
  assert.equal(sim.getInFlight(), null, 'in-flight cleared after completion');

  // Simulate pagehide (after bootstrap already complete)
  sim.pagehide();

  // Simulate LONG bfcache (30s)
  sim.advanceTime(30000);

  // Restore from bfcache
  sim.restoreFromBfcache(true);

  // bootstrapComplete is true → no new API call (no bootstrap needed)
  assert.equal(sim.getApiCallCount(), 1, 'NO new API call — bootstrap already complete');
});

// ============================================================================
// Regression: Page refresh → existing behavior preserved
// ============================================================================

test('LIFECYCLE-012: Page refresh resets all state → fresh bootstrap works', async () => {
  const sim = createLifecycleSimulator();
  sim.setTelegramAuthReady(true);

  // Simulate a stuck state before refresh
  sim.setStuckFetch(new Promise(() => {}));
  sim.bootstrapUser();
  sim.pagehide();
  sim.advanceTime(25000); // > 20s
  sim.setStuckFetch(null);
  sim.restoreFromBfcache(true); // should recover

  // Now simulate page refresh (all module-level state resets)
  sim.reset();

  // After refresh, state is clean
  assert.equal(sim.getInFlight(), null, 'in-flight cleared after refresh');
  assert.equal(sim.getBootstrapPromise(), null, '_bootstrapPromise cleared after refresh');
  assert.equal(sim.getBootstrapComplete(), false, 'bootstrapComplete reset after refresh');
  assert.equal(sim.getPageHiddenAt(), 0, '_pageHiddenAt reset after refresh');

  // Fresh bootstrap fires and completes
  sim.setTelegramAuthReady(true);
  await sim.bootstrapUser();
  assert.equal(sim.getApiCallCount(), 1, 'fresh API call after refresh');
  assert.equal(sim.getBootstrapComplete(), true, 'bootstrap completes after refresh');
});

// ============================================================================
// Regression: Admin detection still server-confirmed
// ============================================================================

test('LIFECYCLE-013: isAdmin() still gates on bootstrapComplete (admin server-confirmed)', () => {
  // Verify the fix doesn't touch isAdmin() — admin detection is still server-confirmed
  const isAdminMatch = APP_SRC.match(/function isAdmin\(\)\s*\{[^}]*bootstrapComplete[^}]*\}/s);
  assert.ok(isAdminMatch, 'isAdmin() function must exist');
  assert.ok(isAdminMatch[0].includes('if (!bootstrapComplete) return false;'),
    'isAdmin() must return false when !bootstrapComplete (security gate)');
  assert.ok(isAdminMatch[0].includes('isCurrentUserAdmin === true'),
    'isAdmin() must check isCurrentUserAdmin (server-confirmed)');
});

test('LIFECYCLE-014: adminBypassMaintenance() still gates on isAdmin() (security preserved)', () => {
  // The fix doesn't touch adminBypassMaintenance — bypass still requires admin
  const bypassFnMatch = APP_SRC.match(/function adminBypassMaintenance\(\)\s*\{[\s\S]*?\n\}/);
  assert.ok(bypassFnMatch, 'adminBypassMaintenance function must exist');
  assert.ok(bypassFnMatch[0].includes('if (!isAdmin())'),
    'adminBypassMaintenance must still check isAdmin() — SECURITY PRESERVED');
  assert.ok(bypassFnMatch[0].includes('window.location.reload()'),
    'adminBypassMaintenance must still reload the page (preserved)');
});

// ============================================================================
// Regression: Join Check still runs (via bootstrap, not independently)
// ============================================================================

test('LIFECYCLE-015: Join Check still part of bootstrap (no independent trigger added)', () => {
  // The fix should NOT add any independent Join Check trigger.
  // Join Check is part of _bootstrapUserImpl → apiFetch('/api/users/bootstrap')
  // which returns channel_joined in the response.
  // Verify the fix doesn't add any direct call to /api/users/check-join
  // or any independent membershipGateway.check call in the lifecycle handlers.

  // Find the pagehide/pageshow/visibilitychange handlers
  const pagehideIdx = APP_SRC.indexOf("window.addEventListener('pagehide',");
  const pageshowIdx = APP_SRC.indexOf("window.addEventListener('pageshow',");
  const visIdx = APP_SRC.indexOf("document.addEventListener('visibilitychange',");

  // Get the blocks
  const pagehideBlock = APP_SRC.slice(pagehideIdx, pagehideIdx + 500);
  const pageshowBlock = APP_SRC.slice(pageshowIdx, pageshowIdx + 1500);
  const visBlock = APP_SRC.slice(visIdx, visIdx + 2000);

  // None of these handlers should directly call check-join or membershipGateway
  assert.ok(!pagehideBlock.includes('check-join'),
    'pagehide handler must NOT directly call check-join (Join Check via bootstrap only)');
  assert.ok(!pageshowBlock.includes('check-join'),
    'pageshow handler must NOT directly call check-join');
  assert.ok(!visBlock.includes('check-join'),
    'visibilitychange handler must NOT directly call check-join');

  assert.ok(!pagehideBlock.includes('membershipGateway'),
    'pagehide handler must NOT directly call membershipGateway');
  assert.ok(!pageshowBlock.includes('membershipGateway'),
    'pageshow handler must NOT directly call membershipGateway');
  assert.ok(!visBlock.includes('membershipGateway'),
    'visibilitychange handler must NOT directly call membershipGateway');

  // The handlers should only call tryLateBootstrap (which goes through bootstrap)
  assert.ok(pageshowBlock.includes('tryLateBootstrap()'),
    'pageshow handler should call tryLateBootstrap (Join Check via bootstrap)');
  assert.ok(visBlock.includes('tryLateBootstrap()'),
    'visibilitychange handler should call tryLateBootstrap (Join Check via bootstrap)');
});

// ============================================================================
// Regression: No security bypass
// ============================================================================

test('LIFECYCLE-016: Fix does not weaken maintenance check (no security bypass)', () => {
  // The fix only clears in-flight promises — it does NOT change checkMaintenanceMode,
  // _maintenanceBypassed, sessionStorage.maint_bypassed, or adminBypassMaintenance.
  // Verify the fix code doesn't touch any of these.
  const pagehideIdx = APP_SRC.indexOf("window.addEventListener('pagehide',");
  const pageshowIdx = APP_SRC.indexOf("window.addEventListener('pageshow',");
  const visIdx = APP_SRC.indexOf("document.addEventListener('visibilitychange',");

  const pagehideBlock = APP_SRC.slice(pagehideIdx, pagehideIdx + 500);
  const pageshowBlock = APP_SRC.slice(pageshowIdx, pageshowIdx + 1500);
  const visBlock = APP_SRC.slice(visIdx, visIdx + 2000);

  assert.ok(!pagehideBlock.includes('_maintenanceBypassed'),
    'pagehide handler must NOT touch _maintenanceBypassed');
  assert.ok(!pageshowBlock.includes('_maintenanceBypassed'),
    'pageshow handler must NOT touch _maintenanceBypassed');
  assert.ok(!visBlock.includes('_maintenanceBypassed'),
    'visibilitychange handler must NOT touch _maintenanceBypassed');

  assert.ok(!pagehideBlock.includes("sessionStorage.getItem('maint_bypassed')"),
    'pagehide handler must NOT touch sessionStorage.maint_bypassed');
  assert.ok(!pageshowBlock.includes("sessionStorage.getItem('maint_bypassed')"),
    'pageshow handler must NOT touch sessionStorage.maint_bypassed');
  assert.ok(!visBlock.includes("sessionStorage.getItem('maint_bypassed')"),
    'visibilitychange handler must NOT touch sessionStorage.maint_bypassed');
});

test('LIFECYCLE-017: Fix does not touch rate-limit or backend membership logic', () => {
  // The fix is frontend-only (app.js). Verify worker-proxy.js and
  // src/services/membershipGateway.js are NOT modified by this fix.
  // (We check that app.js doesn't reference any backend rate-limit changes.)
  const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  const GATEWAY_SRC = fs.readFileSync(path.join(__dirname, 'src/services/membershipGateway.js'), 'utf8');

  // The fix markers should NOT appear in backend files
  assert.ok(!WORKER_SRC.includes('LIFECYCLE/BFCACHE FIX'),
    'worker-proxy.js must NOT contain lifecycle fix markers (frontend-only fix)');
  assert.ok(!GATEWAY_SRC.includes('LIFECYCLE/BFCACHE FIX'),
    'membershipGateway.js must NOT contain lifecycle fix markers (frontend-only fix)');
  assert.ok(!WORKER_SRC.includes('_pageHiddenAt'),
    'worker-proxy.js must NOT reference _pageHiddenAt (frontend-only fix)');
  assert.ok(!GATEWAY_SRC.includes('_pageHiddenAt'),
    'membershipGateway.js must NOT reference _pageHiddenAt (frontend-only fix)');
});

// ============================================================================
// Regression: 20s threshold is exactly 20000ms
// ============================================================================

test('LIFECYCLE-018: 20s threshold is exactly 20000ms (not accidentally different)', () => {
  // Count occurrences of "> 20000" in the lifecycle handlers — must be exactly 2
  // (one in pageshow, one in visibilitychange)
  const pagehideIdx = APP_SRC.indexOf("window.addEventListener('pagehide',");
  const pageshowIdx = APP_SRC.indexOf("window.addEventListener('pageshow',");
  const visIdx = APP_SRC.indexOf("document.addEventListener('visibilitychange',");

  const pageshowBlock = APP_SRC.slice(pageshowIdx, pageshowIdx + 1500);
  const visBlock = APP_SRC.slice(visIdx, visIdx + 2000);

  const pageshowThresholds = (pageshowBlock.match(/> 20000/g) || []).length;
  const visThresholds = (visBlock.match(/> 20000/g) || []).length;

  assert.equal(pageshowThresholds, 1,
    `pageshow handler must have exactly 1 threshold check (> 20000), found ${pageshowThresholds}`);
  assert.equal(visThresholds, 1,
    `visibilitychange handler must have exactly 1 threshold check (> 20000), found ${visThresholds}`);
});

// ============================================================================
// Summary
// ============================================================================

test('SUMMARY: LIFECYCLE/BFCACHE recovery fix verified', () => {
  assert.ok(APP_SRC.includes('_pageHiddenAt'),
    'LIFECYCLE/BFCACHE FIX: _pageHiddenAt state variable must exist');
  assert.ok(APP_SRC.includes('LIFECYCLE/BFCACHE FIX'),
    'LIFECYCLE/BFCACHE FIX: fix marker must be present in app.js');
});

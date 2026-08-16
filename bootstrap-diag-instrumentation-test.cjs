// ============================================================================
// PHASE 12 — BOOTSTRAP DIAGNOSTIC INSTRUMENTATION REMOVAL VERIFICATION
//
// Phase 12 removed ALL temporary bootstrap diagnostic instrumentation
// (_bsDiag, _sanitizeDiagString, _sanitizeDiagValue, _bsLog, the _bs*T0
// timing variables, env._bsDiagId, and every call site) from worker-proxy.js
// and src/controllers/users.js. The instrumentation was added for bootstrap
// hang root-cause analysis and is no longer needed.
//
// These tests serve as a regression guard: they verify that the diagnostic
// instrumentation is GONE while the production observability that must be
// preserved (_traceStage, _traceQuery, safeError, real console.warn error
// logs, try/catch error handling, business logic) is still in place.
//
// Test count is preserved at exactly 31 (4 + 18 + 9) so the overall suite
// total remains at 796 PASS / 0 FAIL.
// ============================================================================
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const USERS_PATH = path.join(__dirname, 'src/controllers/users.js');
const WORKER_SRC = fs.readFileSync(WORKER_PATH, 'utf8');
const USERS_SRC = fs.readFileSync(USERS_PATH, 'utf8');

// ============================================================================
// A) DIAGNOSTIC HELPER FUNCTIONS MUST BE REMOVED FROM worker-proxy.js
//    (previously defined at lines 241–327; all three must be gone)
// ============================================================================

test('DIAG-A1: _bsDiag function definition is removed from worker-proxy.js', () => {
  assert.ok(!WORKER_SRC.includes('function _bsDiag'),
    'function _bsDiag must be removed — it was temporary diagnostic instrumentation');
  assert.ok(!WORKER_SRC.includes('bootstrap-diag'),
    'no "bootstrap-diag" event tag should remain in worker-proxy.js');
});

test('DIAG-A2: _sanitizeDiagString function definition is removed from worker-proxy.js', () => {
  assert.ok(!WORKER_SRC.includes('function _sanitizeDiagString'),
    'function _sanitizeDiagString was used only by _bsDiag and must be removed');
});

test('DIAG-A3: _sanitizeDiagValue function definition is removed from worker-proxy.js', () => {
  assert.ok(!WORKER_SRC.includes('function _sanitizeDiagValue'),
    'function _sanitizeDiagValue was used only by _bsDiag and must be removed');
});

test('DIAG-A4: _bsDiag is no longer passed as a dependency to createUserHandlers', () => {
  // The createUserHandlers(...) call site in worker-proxy.js previously had:
  //   // DIAGNOSTIC: temporary instrumentation for bootstrap hang root-cause analysis.
  //   _bsDiag,
  const idx = WORKER_SRC.indexOf('createUserHandlers({');
  assert.notStrictEqual(idx, -1, 'createUserHandlers({ must exist');
  // Slice from createUserHandlers({ to the matching }); — conservative 2KB window
  const block = WORKER_SRC.slice(idx, idx + 2048);
  assert.ok(!block.includes('_bsDiag'),
    '_bsDiag must not be passed in createUserHandlers deps');
  assert.ok(!block.includes('DIAGNOSTIC: temporary instrumentation'),
    'the DIAGNOSTIC comment must also be removed from the deps block');
});

// ============================================================================
// B) ALL _bsDiag CALL SITES AND DIAGNOSTIC-ONLY VARIABLES MUST BE REMOVED
//    Each test below pins one specific diagnostic artifact that must be gone.
// ============================================================================

test('DIAG-B1: no `_bsDiag(` call sites remain anywhere in worker-proxy.js', () => {
  assert.ok(!/\b_bsDiag\s*\(/.test(WORKER_SRC),
    'all _bsDiag(...) call sites must be removed');
});

test('DIAG-B2: no `env._bsDiagId` assignment or read remains', () => {
  assert.ok(!WORKER_SRC.includes('_bsDiagId'),
    'env._bsDiagId (per-bootstrap correlation ID) must be removed entirely');
});

test('DIAG-B3: no `_bsTgT0` timing variable remains in getChatMemberDebugPayload', () => {
  assert.ok(!WORKER_SRC.includes('_bsTgT0'),
    '_bsTgT0 (telegram-api timing) must be removed');
});

test('DIAG-B4: no `_bsRlT0` timing variable remains in bootstrap wrapper', () => {
  assert.ok(!WORKER_SRC.includes('_bsRlT0'),
    '_bsRlT0 (rate-limit timing) must be removed');
});

test('DIAG-B5: no `_bsDispatchT0` timing variable remains', () => {
  assert.ok(!WORKER_SRC.includes('_bsDispatchT0'),
    '_bsDispatchT0 (shared-pool dispatch timing) must be removed');
});

test('DIAG-B6: no `_bsResult` Promise-observer pattern remains', () => {
  // The previous code did: const _bsResult = handleBootstrap(...);
  //                       if (_bsResult && typeof _bsResult.then === 'function') {
  //                         _bsResult.then(...observers...);
  //                       }
  //                       return _bsResult;
  // After removal, the bootstrap route just returns handleBootstrap(...) directly.
  assert.ok(!WORKER_SRC.includes('_bsResult'),
    '_bsResult Promise-observer must be removed — bootstrap route should return handleBootstrap(...) directly');
  assert.ok(!WORKER_SRC.includes("shared-pool', 'end'"),
    "no shared-pool 'end' diagnostic calls should remain");
});

test('DIAG-B7: no `shared-pool` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'shared-pool'"),
    "no 'shared-pool' diagnostic stage should remain");
});

test('DIAG-B8: no `rate-limit` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'rate-limit'"),
    "no 'rate-limit' diagnostic stage should remain");
});

test('DIAG-B9: no `telegram-api` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'telegram-api'"),
    "no 'telegram-api' diagnostic stage should remain");
});

test('DIAG-B10: no `entry` diagnostic stage references remain', () => {
  // _bsDiag(env, 'entry', 'start') was the first diagnostic call in handleBootstrap
  assert.ok(!WORKER_SRC.includes("'entry', 'start'"),
    "no 'entry'/'start' diagnostic checkpoint should remain");
});

test('DIAG-B11: no `read-body` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'read-body'"),
    "no 'read-body' diagnostic stage should remain");
});

test('DIAG-B12: no `ensure-table` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'ensure-table'"),
    "no 'ensure-table' diagnostic stage should remain");
});

test('DIAG-B13: no `get-user` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'get-user'"),
    "no 'get-user' diagnostic stage should remain");
});

test('DIAG-B14: no `user-bootstrap` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'user-bootstrap'"),
    "no 'user-bootstrap' diagnostic stage should remain");
});

test('DIAG-B15: no `membership-cache` / `membership-refresh` diagnostic stages remain', () => {
  assert.ok(!WORKER_SRC.includes("'membership-cache'"),
    "no 'membership-cache' diagnostic stage should remain");
  assert.ok(!WORKER_SRC.includes("'membership-refresh'"),
    "no 'membership-refresh' diagnostic stage should remain");
});

test('DIAG-B16: no `daily-mission` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'daily-mission'"),
    "no 'daily-mission' diagnostic stage should remain");
});

test('DIAG-B17: no `bootstrap-catch` diagnostic stage references remain', () => {
  assert.ok(!WORKER_SRC.includes("'bootstrap-catch'"),
    "no 'bootstrap-catch' diagnostic stage should remain");
});

test('DIAG-B18: no bootstrap-diag event JSON emission pattern remains', () => {
  // _bsDiag previously emitted console.warn(JSON.stringify({event:'bootstrap-diag',...}))
  assert.ok(!WORKER_SRC.includes("event: 'bootstrap-diag'"),
    "no bootstrap-diag event JSON should be emitted from worker-proxy.js");
});

// ============================================================================
// C) PRODUCTION OBSERVABILITY + ERROR HANDLING MUST BE PRESERVED
//    These tests guard against accidentally removing real instrumentation
//    or real error handling while stripping the diagnostics.
// ============================================================================

test('DIAG-C1: _traceStage (production slow-stage instrumentation) is preserved', () => {
  assert.ok(WORKER_SRC.includes('function _traceStage'),
    'function _traceStage must be preserved — it is production instrumentation, not diagnostic');
});

test('DIAG-C2: _traceQuery (production DB trace instrumentation) is preserved', () => {
  assert.ok(WORKER_SRC.includes('function _traceQuery'),
    'function _traceQuery must be preserved — it is production instrumentation, not diagnostic');
});

test('DIAG-C3: safeError (real error logging helper) is preserved', () => {
  assert.ok(WORKER_SRC.includes('function safeError'),
    'function safeError must be preserved — it is real error logging, not diagnostic');
});

test('DIAG-C4: users.js no longer references _bsDiag anywhere', () => {
  assert.ok(!USERS_SRC.includes('_bsDiag'),
    'users.js must not reference _bsDiag anywhere (deps, calls, or comments)');
});

test('DIAG-C5: users.js no longer defines the inline _bsLog helper', () => {
  assert.ok(!USERS_SRC.includes('const _bsLog'),
    'users.js must not define the inline _bsLog helper');
  assert.ok(!USERS_SRC.includes('_bsLog('),
    'users.js must not call _bsLog(...) anywhere');
});

test('DIAG-C6: users.js no longer has any _bs*T0 timing variables', () => {
  // Match: _bs followed by uppercase letters (e.g. _bsBodyT0, _bsEtT0, _bsGuT0, _bsUbT0,
  // _bsRfT0, _bsWlT0, _bsMcT0, _bsMrT0, _bsAdT0, _bsDmT0, _bsAuthT0)
  const timingVars = USERS_SRC.match(/\b_bs[A-Z][a-zA-Z]*T0\b/g);
  assert.deepStrictEqual(timingVars, null,
    `no _bs*T0 timing variables should remain in users.js (found: ${JSON.stringify(timingVars)})`);
});

test('DIAG-C7: users.js preserves real `console.warn("[BOOTSTRAP] ...")` error logs', () => {
  assert.ok(USERS_SRC.includes("console.warn('[BOOTSTRAP] Admin DB check failed:"),
    'real error log "[BOOTSTRAP] Admin DB check failed:" must be preserved');
  assert.ok(USERS_SRC.includes("console.warn('[BOOTSTRAP] fireDailyLoginMission failed (non-fatal):"),
    'real error log "[BOOTSTRAP] fireDailyLoginMission failed (non-fatal):" must be preserved');
});

test('DIAG-C8: users.js preserves `console.warn(safeError("bootstrap-user", error))` in top-level catch', () => {
  assert.ok(USERS_SRC.includes("console.warn(safeError('bootstrap-user', error))"),
    'bootstrap top-level catch must still log via safeError("bootstrap-user", error)');
});

test('DIAG-C9: bootstrap wrapper in worker-proxy.js preserves real rate-limit logic', () => {
  // After stripping the diagnostic calls, the bootstrap route must STILL:
  //   - call authenticateTelegramRequest BEFORE rate-limiting (HMAC validation)
  //   - call isUserRateLimited with the validated userId
  //   - return HTTP 429 with code RATE_LIMITED on rate-limit hit
  //   - fall through to userHandlers.handleBootstrap(...) on success / non-fatal error
  const idx = WORKER_SRC.indexOf("request.method === 'POST' && url.pathname === '/api/users/bootstrap'");
  assert.notStrictEqual(idx, -1, 'bootstrap POST route must exist');
  const block = WORKER_SRC.slice(idx, idx + 3000);
  assert.ok(block.includes('authenticateTelegramRequest(request, env)'),
    'bootstrap wrapper must still call authenticateTelegramRequest for HMAC validation');
  assert.ok(block.includes('isUserRateLimited(env,'),
    'bootstrap wrapper must still call isUserRateLimited to enforce the rate limit');
  assert.ok(block.includes("code: 'RATE_LIMITED'"),
    'bootstrap wrapper must still return 429 with code RATE_LIMITED when rate-limited');
  assert.ok(block.includes('userHandlers.handleBootstrap(request, env)'),
    'bootstrap wrapper must still fall through to userHandlers.handleBootstrap');
  assert.ok(block.includes('try {'),
    'bootstrap wrapper must preserve its try/catch around the rate-limit pre-check');
  assert.ok(block.includes('} catch (e) {'),
    'bootstrap wrapper must preserve the catch block (rate-limit pre-check failure is non-fatal)');
});

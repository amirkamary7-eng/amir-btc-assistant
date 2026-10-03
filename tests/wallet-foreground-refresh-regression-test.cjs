/**
 * Wallet Foreground & Profile-Refresh Regression Test
 *
 * Verifies the frontend (app.js) refreshes the wallet balance immediately on:
 *   1. visibilitychange → visible (foreground return)
 *   2. pageshow → event.persisted (bfcache restore)
 *   3. Profile tab revisit (when tabLoaded.profile is already true)
 *
 * ROOT CAUSE (F-FE-01, F-FE-02): server-side cron credits (referral/wheel/
 * mission/refund retries) have NO push mechanism. The 60s wallet poller was
 * the ONLY way the frontend learned about them. visibilitychange/pageshow
 * only restarted the poller (next tick 60s away); Profile tab revisit did
 * nothing. Users saw a stale balance for up to 60s after returning to the app
 * or revisiting Profile.
 *
 * FIX: add an immediate `window.WalletApp.refreshWalletBalance()` call in
 * each of the 3 paths (after _startAllPolling for the lifecycle handlers;
 * in the Profile-tab else branch for revisits). Dedup'd by apiFetch
 * GET-by-path + _walletMutationSeq — no duplicate-request risk.
 *
 * This is a SOURCE-LEVEL test (string matching on app.js), mirroring the
 * online-count-zero-suppression-test.cjs pattern.
 *
 * Run: node --test tests/wallet-foreground-refresh-regression-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_SRC = fs.readFileSync(path.join(__dirname, '..', 'app.js'), 'utf8');

// ============================================================================
// F-FE-01: visibilitychange → visible must immediately refresh wallet balance
// ============================================================================

test('F-FE-01a: visibilitychange visible branch calls refreshWalletBalance after _startAllPolling', () => {
  // Locate the visibilitychange listener.
  const vcStart = APP_SRC.indexOf("document.addEventListener('visibilitychange'");
  assert.ok(vcStart > -1, 'visibilitychange listener must exist');
  // Find the visible (else) branch and the wallet refresh within it.
  const vcEnd = APP_SRC.indexOf('});', vcStart);
  const vcBody = APP_SRC.slice(vcStart, vcEnd > vcStart ? vcEnd : APP_SRC.length);
  assert.match(vcBody, /else\s*\{/, 'visibilitychange must have a visible (else) branch');
  assert.match(vcBody, /_startAllPolling\(\)/, 'visible branch must restart polling');
  assert.match(vcBody, /window\.WalletApp.*refreshWalletBalance/s,
    'visible branch must call window.WalletApp.refreshWalletBalance');
  assert.match(vcBody, /F-FE-01/,
    'visible branch must reference the F-FE-01 fix comment for traceability');
});

test('F-FE-01a-order: refreshWalletBalance comes AFTER _startAllPolling in visible branch', () => {
  const vcStart = APP_SRC.indexOf("document.addEventListener('visibilitychange'");
  const vcEnd = APP_SRC.indexOf('});', vcStart);
  const vcBody = APP_SRC.slice(vcStart, vcEnd > vcStart ? vcEnd : APP_SRC.length);
  const pollingIdx = vcBody.indexOf('_startAllPolling()');
  const refreshIdx = vcBody.indexOf('refreshWalletBalance');
  assert.ok(pollingIdx > -1 && refreshIdx > -1, 'both _startAllPolling and refreshWalletBalance must exist');
  assert.ok(refreshIdx > pollingIdx,
    'refreshWalletBalance must come AFTER _startAllPolling (polling restart first, then immediate balance refresh)');
});

// ============================================================================
// F-FE-01: pageshow (bfcache restore) must immediately refresh wallet balance
// ============================================================================

test('F-FE-01b: pageshow persisted branch calls refreshWalletBalance after _startAllPolling', () => {
  const psStart = APP_SRC.indexOf("window.addEventListener('pageshow'");
  assert.ok(psStart > -1, 'pageshow listener must exist');
  const psEnd = APP_SRC.indexOf('});', psStart);
  // The pageshow listener is longer; find a generous window.
  const psBody = APP_SRC.slice(psStart, Math.min(psStart + 3000, APP_SRC.length));
  assert.match(psBody, /event\.persisted/, 'pageshow must check event.persisted (bfcache)');
  assert.match(psBody, /_startAllPolling\(\)/, 'pageshow persisted branch must restart polling');
  assert.match(psBody, /window\.WalletApp.*refreshWalletBalance/s,
    'pageshow persisted branch must call window.WalletApp.refreshWalletBalance');
});

test('F-FE-01b-order: refreshWalletBalance comes AFTER _startAllPolling in pageshow branch', () => {
  const psStart = APP_SRC.indexOf("window.addEventListener('pageshow'");
  const psBody = APP_SRC.slice(psStart, Math.min(psStart + 3000, APP_SRC.length));
  const pollingIdx = psBody.indexOf('_startAllPolling()');
  const refreshIdx = psBody.indexOf('refreshWalletBalance');
  assert.ok(pollingIdx > -1 && refreshIdx > -1, 'both _startAllPolling and refreshWalletBalance must exist');
  assert.ok(refreshIdx > pollingIdx,
    'refreshWalletBalance must come AFTER _startAllPolling in pageshow (polling restart first)');
});

// ============================================================================
// F-FE-02: Profile tab revisit must call refreshWalletBalance (lightweight)
// ============================================================================

test('F-FE-02: Profile tab revisit (else branch) calls refreshWalletBalance', () => {
  // Locate the Profile tab branch in switchTab.
  const profileIdx = APP_SRC.indexOf("} else if (pageId === 'profile-page')");
  assert.ok(profileIdx > -1, 'Profile tab branch must exist in switchTab');
  const profileBody = APP_SRC.slice(profileIdx, Math.min(profileIdx + 1500, APP_SRC.length));
  assert.match(profileBody, /if\s*\(\s*!tabLoaded\.profile\s*\)/, 'first-visit guard must exist');
  assert.match(profileBody, /else\s*\{/, 'else branch (revisit) must exist');
  assert.match(profileBody, /window\.WalletApp.*refreshWalletBalance/s,
    'Profile revisit else branch must call window.WalletApp.refreshWalletBalance');
  assert.match(profileBody, /F-FE-02/,
    'Profile revisit must reference the F-FE-02 fix comment for traceability');
});

test('F-FE-02-no-full-reload: Profile revisit does NOT call loadProfileCard or loadUser again', () => {
  const profileIdx = APP_SRC.indexOf("} else if (pageId === 'profile-page')");
  const profileBody = APP_SRC.slice(profileIdx, Math.min(profileIdx + 1500, APP_SRC.length));
  // The else (revisit) branch is between the first `else {` and the closing `}` of the page branch.
  const elseIdx = profileBody.indexOf('else {');
  assert.ok(elseIdx > -1, 'else branch must exist');
  // Slice the else body up to the matching close (next '    }' at the page-branch indent level).
  const elseBody = profileBody.slice(elseIdx, Math.min(elseIdx + 600, profileBody.length));
  // Check for actual METHOD CALLS (`.loadProfileCard(`), not prose in comments.
  assert.doesNotMatch(elseBody, /\.loadProfileCard\(/,
    'Profile revisit must NOT call .loadProfileCard() (full reload) — use lightweight refreshWalletBalance instead');
  assert.doesNotMatch(elseBody, /\bloadUser\(\)/,
    'Profile revisit must NOT call loadUser() again (already loaded on first visit)');
});

// ============================================================================
// Dedup guard: the refresh calls are protected against duplicate requests
// ============================================================================

test('dedup: refreshWalletBalance calls use the standard WalletApp guard pattern', () => {
  // All 3 refresh call sites must use the safe-call guard:
  //   if (window.WalletApp && typeof window.WalletApp.refreshWalletBalance === 'function') { try { ... } catch (_) {} }
  // This prevents errors if WalletApp isn't loaded yet.
  const guardPattern = /window\.WalletApp && typeof window\.WalletApp\.refreshWalletBalance === 'function'/g;
  const matches = APP_SRC.match(guardPattern) || [];
  // At least 3: visibilitychange + pageshow + profile revisit. (The 60s poller
  // uses a slightly different guard `window.WalletApp && typeof ...` but without
  // the === 'function' — that's fine, this test counts the strict-guard call sites.)
  assert.ok(matches.length >= 3,
    `expected >=3 strict-guard refreshWalletBalance call sites (visibility + pageshow + profile revisit), found ${matches.length}`);
});

/**
 * Phase 7B (B1) — Rules Acceptance UI Tests
 *
 * Tests the frontend Rules Acceptance UI implementation in membership-user.js:
 *   - Rules loading (GET /api/membership/rules) + caching (no duplicate fetches)
 *   - Rules rendering in the activation popup (text, version, checkbox)
 *   - Checkbox state gating the submit button
 *   - Acceptance API call ordering (POST /accept BEFORE /request)
 *   - Duplicate-click protection (_submitInFlight flag)
 *   - RULES_NOT_ACCEPTED graceful recovery (refresh rules, reset checkbox,
 *     actionable Persian message)
 *   - Missing/invalid rules response (FAIL-OPEN mode)
 *   - Existing activation flow preserved (requirement, exchange validation,
 *     UID validation, register button, quota preview, timeline, pending state)
 *   - Mobile/narrow WebView CSS (responsive breakpoints)
 *   - RTL/Persian rendering correctness
 *
 * Uses the source-string assertion pattern (same as premium-ui-test.cjs).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const MEMBERSHIP_USER_SRC = fs.readFileSync(path.join(__dirname, '..', 'membership-user.js'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, '..', 'style.css'), 'utf8');
// Phase 8: The membership rules CSS (.mb-rules-section, .mb-rules-version,
// .mb-rules-checkbox, .mb-uid-submit--disabled, etc.) was extracted from
// style.css into a dedicated membership.css stylesheet. The 6 CSS assertions
// below (B1-CSS-01 .. B1-CSS-06) now read from MEMBERSHIP_CSS instead of
// STYLE_CSS so they keep matching the rules-section selectors after the
// Phase 8 extraction. No assertion logic or expected values are changed —
// only the source-file path is repointed.
const MEMBERSHIP_CSS = fs.readFileSync(path.join(__dirname, '..', 'membership.css'), 'utf8');

// Helper: extract a function body by name (between its definition and the
// next function definition at the same indentation level).
function fnBody(src, fnName) {
  const start = src.indexOf('function ' + fnName);
  if (start < 0) return '';
  // Find the next "  function " (sibling) or "  // ───" section marker.
  const rest = src.slice(start + 1);
  const nextFn = rest.indexOf('\n  function ');
  const nextSection = rest.indexOf('\n  // ───');
  const ends = [nextFn, nextSection].filter(i => i >= 0);
  const end = ends.length ? Math.min(...ends) : rest.length;
  return src.slice(start, start + 1 + end);
}

// Helper: extract the activation popup block (between openActivationPopup
// and the next major section).
function activationPopupBlock() {
  return fnBody(MEMBERSHIP_USER_SRC, 'openActivationPopup');
}

// Helper: extract the submitUid block.
function submitUidBlock() {
  // submitUid is now split into submitUid + _submitUidInternal; grab both.
  const start = MEMBERSHIP_USER_SRC.indexOf('async function submitUid');
  const end = MEMBERSHIP_USER_SRC.indexOf('  // ─── Helpers');
  return MEMBERSHIP_USER_SRC.slice(start, end);
}

// ─── Tests: Rules loading + caching ────────────────────────────────────────

test('B1-LOAD-01: loadRules() function exists and calls /api/membership/rules', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('async function loadRules'),
    'loadRules() must be defined');
  // Phase i18n: loadRules() now passes ?lang=fa|en so the backend returns
  // language-appropriate content (mb:rules:active:fa / :en cache keys).
  assert.ok(MEMBERSHIP_USER_SRC.includes("apiFetch('/api/membership/rules?lang=' + langParam)"),
    'loadRules must fetch /api/membership/rules?lang=<langParam>');
});

test('B1-LOAD-02: loadRules() caches in module-level _rules variable (no duplicate fetches)', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('var _rules = null;'),
    '_rules cache variable must exist');
  // The loadRules function must early-return if _rules is already set.
  const loadRulesBody = fnBody(MEMBERSHIP_USER_SRC, 'loadRules');
  assert.ok(loadRulesBody.includes('if (_rules) return _rules;'),
    'loadRules must early-return cached value (no duplicate fetch)');
});

test('B1-LOAD-03: getRules() synchronous getter mirrors getRequirement() pattern', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function getRules()'),
    'getRules() must be defined');
  const body = fnBody(MEMBERSHIP_USER_SRC, 'getRules');
  assert.ok(body.includes('return _rules || FALLBACK_RULES'),
    'getRules returns cached or FALLBACK_RULES');
});

test('B1-LOAD-04: FALLBACK_RULES defined with active:false (FAIL-OPEN)', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('var FALLBACK_RULES'),
    'FALLBACK_RULES must be defined');
  assert.ok(MEMBERSHIP_USER_SRC.includes('active: false'),
    'FALLBACK_RULES must have active:false (FAIL-OPEN mode)');
});

test('B1-LOAD-05: loadRules() pre-fetched in loadCard() (non-blocking)', () => {
  const loadCardBody = fnBody(MEMBERSHIP_USER_SRC, 'loadCard');
  assert.ok(loadCardBody.includes('loadRules().catch'),
    'loadCard must kick off loadRules() in the background (non-blocking)');
});

test('B1-LOAD-06: refreshRules() force-refreshes the cache (resets _rules + _rulesAcceptedVersion)', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('async function refreshRules'),
    'refreshRules() must be defined');
  const body = fnBody(MEMBERSHIP_USER_SRC, 'refreshRules');
  assert.ok(body.includes('_rules = null'),
    'refreshRules must clear _rules');
  assert.ok(body.includes('_rulesAcceptedVersion = null'),
    'refreshRules must clear _rulesAcceptedVersion');
});

// ─── Tests: Rules rendering in the activation popup ────────────────────────

test('B1-RENDER-01: openActivationPopup is async and awaits loadRules()', () => {
  // Check the async keyword directly in the source (fnBody helper starts at
  // 'function' and misses the 'async' prefix).
  assert.ok(MEMBERSHIP_USER_SRC.includes('async function openActivationPopup'),
    'openActivationPopup must be async');
  const block = activationPopupBlock();
  assert.ok(block.includes('await loadRules()'),
    'must await loadRules() before rendering');
});

test('B1-RENDER-02: buildRulesSectionHtml() renders the rules section', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function buildRulesSectionHtml'),
    'buildRulesSectionHtml() must be defined');
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  assert.ok(body.includes('mb-rules-section'),
    'renders .mb-rules-section container');
  assert.ok(body.includes('mb-rules-title'),
    'renders rules title');
  // Phase 8M: Version badge removed from UI (backend logic unchanged)
  assert.ok(body.includes('mb-rules-view-btn'),
    'renders view rules button (Phase 8L)');
  assert.ok(body.includes('mb-rules-accept'),
    'renders acceptance checkbox');
});

// Phase 8M: Version removed from rules UI (backend acceptance logic unchanged)
test('B1-RENDER-03: Version removed from rules UI (Phase 8M)', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  assert.ok(!body.includes('mb-rules-version'),
    'version badge removed from UI (Phase 8M)');
  assert.ok(body.includes("versionBadge = ''"),
    'versionBadge is empty string (Phase 8M)');
});

// Phase 8L: Rules summary text no longer displayed in card — moved to modal
test('B1-RENDER-04: Rules summary NOT in card (moved to modal, Phase 8L)', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  assert.ok(!body.includes('rules.summary'),
    'summary no longer displayed in card (Phase 8L)');
  assert.ok(!body.includes('stripMarkdownHeaders'),
    'body_markdown no longer in card (Phase 8L)');
  assert.ok(body.includes('_rulesDataForModal = rules'),
    'rules data stored for modal');
});

test('B1-RENDER-05: Explicit acceptance checkbox with Persian label (Phase 8L)', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  assert.ok(body.includes('type="checkbox"'),
    'checkbox input rendered');
  assert.ok(body.includes('id="mb-rules-checkbox"'),
    'checkbox has stable id');
  assert.ok(body.includes('mb-rules-accept-label'),
    'acceptance label element rendered');
  // Phase i18n: acceptance label now via t('mem_rules_accept_label')
  assert.ok(body.includes("t('mem_rules_accept_label')"),
    'acceptance label uses t(\'mem_rules_accept_label\') (Phase i18n)');
});

test('B1-RENDER-06: Rules section inserted into activation popup HTML', () => {
  const block = activationPopupBlock();
  assert.ok(block.includes('rulesSectionHtml'),
    'rules section HTML variable used in popup');
  assert.ok(block.includes('PHASE 7B (B1): Rules + Acceptance section'),
    'rules section insertion point marked');
});

// Phase 8L: Effective date no longer in card (moved to modal)
test('B1-RENDER-07: Effective date NOT in card (moved to modal, Phase 8L)', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  assert.ok(!body.includes('formatFaDate(rules.effective_at)'),
    'effective date no longer in card (Phase 8L)');
  assert.ok(!body.includes('mb-rules-effective'),
    'effective date element removed from card');
});

test('B1-RENDER-08: FAIL-OPEN rendering when rules.active === false', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  assert.ok(body.includes('mb-rules-section--inactive'),
    'inactive variant class applied');
  assert.ok(body.includes('mb-rules-body--empty'),
    'empty-body class applied in FAIL-OPEN mode');
  // Phase i18n: FAIL-OPEN notice text now via t('mem_rules_unavailable')
  assert.ok(body.includes("t('mem_rules_unavailable')"),
    'FAIL-OPEN notice uses t(\'mem_rules_unavailable\') (Phase i18n)');
});

// ─── Tests: Checkbox state gating ──────────────────────────────────────────

test('B1-CHECK-01: Submit button starts disabled when rules.active === true', () => {
  const block = activationPopupBlock();
  // The button HTML must conditionally include 'disabled' when rules.active.
  assert.ok(block.includes("(rules.active ? ' disabled' : '')"),
    'submit button disabled attribute conditional on rules.active');
  assert.ok(block.includes('mb-uid-submit--disabled'),
    'disabled hint class applied when rules.active');
});

test('B1-CHECK-02: wireRulesCheckbox() sets initial disabled state', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function wireRulesCheckbox'),
    'wireRulesCheckbox() must be defined');
  const body = fnBody(MEMBERSHIP_USER_SRC, 'wireRulesCheckbox');
  assert.ok(body.includes('updateSubmitButtonState(submitBtn, false)'),
    'initial state is disabled (unchecked)');
});

test('B1-CHECK-03: onRulesCheckboxChange() toggles submit button state', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function onRulesCheckboxChange'),
    'onRulesCheckboxChange() must be defined');
  const body = fnBody(MEMBERSHIP_USER_SRC, 'onRulesCheckboxChange');
  assert.ok(body.includes('checkbox.checked'),
    'reads checkbox.checked');
  assert.ok(body.includes('updateSubmitButtonState(submitBtn, checkbox.checked)'),
    'updates submit button based on checkbox state');
});

test('B1-CHECK-04: updateSubmitButtonState() swaps label + icon on disable', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'updateSubmitButtonState');
  // Phase i18n: disabled hint now via t('mem_submit_accept_first'); the
  // enabled label is restored via t('mem_submit_btn').
  assert.ok(body.includes("t('mem_submit_accept_first')"),
    'disabled hint label uses t(\'mem_submit_accept_first\') (Phase i18n)');
  assert.ok(body.includes('aria-disabled'),
    'aria-disabled updated for accessibility');
  assert.ok(body.includes("t('mem_submit_btn')"),
    'enabled label restored via t(\'mem_submit_btn\') (Phase i18n)');
});

test('B1-CHECK-05: onRulesCheckboxChange exposed via MembershipApp for inline onchange', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('onRulesCheckboxChange: onRulesCheckboxChange'),
    'onRulesCheckboxChange must be exposed in window.MembershipApp');
  assert.ok(MEMBERSHIP_USER_SRC.includes('onchange="MembershipApp.onRulesCheckboxChange(this)"'),
    'inline onchange handler wired to MembershipApp.onRulesCheckboxChange');
});

// ─── Tests: Acceptance API call ordering ───────────────────────────────────

test('B1-ORDER-01: submitUid calls /accept BEFORE /request', () => {
  const block = submitUidBlock();
  const acceptIdx = block.indexOf("/api/membership/rules/accept");
  const requestIdx = block.indexOf("/api/membership/request");
  assert.ok(acceptIdx >= 0, '/accept call must exist in submitUid');
  assert.ok(requestIdx >= 0, '/request call must exist in submitUid');
  assert.ok(acceptIdx < requestIdx,
    '/accept must appear BEFORE /request in the source (call ordering)');
});

test('B1-ORDER-02: /accept called with rules_version in the payload', () => {
  const block = submitUidBlock();
  assert.ok(block.includes('rules_version: rules.version'),
    'accept payload includes rules_version');
});

test('B1-ORDER-03: /accept only called once per version (idempotent session tracking)', () => {
  const block = submitUidBlock();
  assert.ok(block.includes("if (_rulesAcceptedVersion !== rules.version)"),
    'accept only called when version not yet accepted in this session');
  assert.ok(block.includes('_rulesAcceptedVersion = rules.version'),
    'accepted version recorded after success');
});

test('B1-ORDER-04: /request NOT called if /accept fails', () => {
  const block = submitUidBlock();
  // The accept-failure path must `return` before reaching /request.
  const acceptFailureReturn = block.indexOf("// Acceptance failed");
  assert.ok(acceptFailureReturn >= 0, 'accept-failure handling block exists');
  // After the accept block, before /request, there must be a `return`.
  const requestCall = block.indexOf("// ── Submit the membership request");
  const segment = block.slice(acceptFailureReturn, requestCall);
  assert.ok(segment.includes('return;'),
    'accept-failure path returns before /request is reached');
});

test('B1-ORDER-05: Acceptance skipped when checkbox not checked (actionable message)', () => {
  const block = submitUidBlock();
  // Phase i18n: actionable message now via t('mem_err_rules_required')
  assert.ok(block.includes("t('mem_err_rules_required')"),
    'actionable message uses t(\'mem_err_rules_required\') when checkbox unchecked (Phase i18n)');
  // The unchecked path must return before /accept.
  const uncheckedCheck = block.indexOf('if (!checkbox || !checkbox.checked)');
  const acceptCall = block.indexOf("/api/membership/rules/accept");
  const segment = block.slice(uncheckedCheck, acceptCall);
  assert.ok(segment.includes('return;'),
    'unchecked-checkbox path returns before /accept');
});

// ─── Tests: Duplicate-click protection ─────────────────────────────────────

test('B1-DUP-01: _submitInFlight flag prevents concurrent submissions', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('var _submitInFlight = false'),
    '_submitInFlight flag must be defined');
  const block = submitUidBlock();
  assert.ok(block.includes('if (_submitInFlight) return'),
    'submitUid early-returns if _submitInFlight is true');
  assert.ok(block.includes('_submitInFlight = true'),
    '_submitInFlight set to true at start');
  assert.ok(block.includes('_submitInFlight = false'),
    '_submitInFlight reset to false in finally block');
});

test('B1-DUP-02: submitUid uses try/finally to always reset _submitInFlight', () => {
  const block = submitUidBlock();
  // The outer submitUid must wrap _submitUidInternal in try/finally.
  const outerStart = block.indexOf('async function submitUid');
  const internalStart = block.indexOf('async function _submitUidInternal');
  const outerBody = block.slice(outerStart, internalStart);
  assert.ok(outerBody.includes('try {'),
    'submitUid wraps call in try');
  assert.ok(outerBody.includes('finally {'),
    'submitUid uses finally to reset flag');
});

// ─── Tests: RULES_NOT_ACCEPTED graceful recovery ───────────────────────────

test('B1-RECOVER-01: RULES_NOT_ACCEPTED code detected and handled', () => {
  const block = submitUidBlock();
  assert.ok(block.includes("res.code === 'RULES_NOT_ACCEPTED'"),
    'RULES_NOT_ACCEPTED code checked in /request response handling');
});

test('B1-RECOVER-02: On RULES_NOT_ACCEPTED, rules cache is refreshed', () => {
  const block = submitUidBlock();
  assert.ok(block.includes('await refreshRulesAndRerenderSection()'),
    'refreshRulesAndRerenderSection() called on RULES_NOT_ACCEPTED');
});

test('B1-RECOVER-03: On RULES_NOT_ACCEPTED, checkbox reset to unchecked', () => {
  const block = submitUidBlock();
  // Find the RULES_NOT_ACCEPTED handling block and verify checkbox reset.
  const recoverIdx = block.indexOf("res.code === 'RULES_NOT_ACCEPTED'");
  const afterRecover = block.slice(recoverIdx, recoverIdx + 600);
  assert.ok(afterRecover.includes('checkboxReset') && afterRecover.includes('.checked = false'),
    'checkbox reset to unchecked on RULES_NOT_ACCEPTED');
});

test('B1-RECOVER-04: On RULES_NOT_ACCEPTED, actionable Persian message shown', () => {
  const block = submitUidBlock();
  const recoverIdx = block.indexOf("res.code === 'RULES_NOT_ACCEPTED'");
  const afterRecover = block.slice(recoverIdx, recoverIdx + 800);
  // Phase i18n: actionable message now via t('mem_err_rules_updated_request')
  assert.ok(afterRecover.includes("t('mem_err_rules_updated_request')"),
    'actionable message uses t(\'mem_err_rules_updated_request\') (Phase i18n)');
  assert.ok(afterRecover.includes('admToast(rulesMsg') || afterRecover.includes('alert(rulesMsg'),
    'message displayed to user via admToast/alert (read + re-accept prompt)');
});

test('B1-RECOVER-05: refreshRulesAndRerenderSection() re-renders section in-place', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('async function refreshRulesAndRerenderSection'),
    'refreshRulesAndRerenderSection() must be defined');
  const body = fnBody(MEMBERSHIP_USER_SRC, 'refreshRulesAndRerenderSection');
  assert.ok(body.includes('await refreshRules()'),
    'refreshes rules cache');
  assert.ok(body.includes("document.querySelector('.mb-rules-section')"),
    'finds existing rules section element');
  assert.ok(body.includes('replaceWith'),
    'replaces the section in-place (no full popup rebuild)');
});

test('B1-RECOVER-06: No opaque "HTTP 403" message anywhere in submitUid', () => {
  const block = submitUidBlock();
  // The old code showed "خطا: HTTP 403" — verify that pattern is gone.
  assert.ok(!block.includes("'خطا: HTTP ' + res.status"),
    'no opaque HTTP status throw (apiFetch now returns parsed JSON)');
  assert.ok(!block.includes("'خطا: HTTP 403'"),
    'no hard-coded HTTP 403 string');
});

test('B1-RECOVER-07: /accept failure handling for RULES_NOT_FOUND + RULES_NOT_ACTIVE', () => {
  const block = submitUidBlock();
  assert.ok(block.includes("acceptRes.code === 'RULES_NOT_FOUND'"),
    'RULES_NOT_FOUND handled in /accept response');
  assert.ok(block.includes("acceptRes.code === 'RULES_NOT_ACTIVE'"),
    'RULES_NOT_ACTIVE handled in /accept response');
  // Both paths must refresh rules + re-render.
  const notFoundIdx = block.indexOf("acceptRes.code === 'RULES_NOT_FOUND'");
  const afterNotFound = block.slice(notFoundIdx, notFoundIdx + 400);
  assert.ok(afterNotFound.includes('refreshRulesAndRerenderSection'),
    'RULES_NOT_FOUND triggers rules refresh');
});

// ─── Tests: apiFetch structured error handling ─────────────────────────────

test('B1-APIFETCH-01: apiFetch returns parsed JSON even on non-2xx (no throw)', () => {
  // The new apiFetch must NOT throw on non-2xx — it must return the parsed body.
  const body = fnBody(MEMBERSHIP_USER_SRC, 'apiFetch');
  assert.ok(!body.includes("if (!res.ok) throw new Error"),
    'apiFetch must NOT throw on non-2xx');
  assert.ok(body.includes('return res.json()'),
    'apiFetch parses JSON body');
  assert.ok(body.includes('_httpStatus'),
    'apiFetch enriches response with _httpStatus');
  assert.ok(body.includes('enriched.ok = res.ok'),
    'apiFetch sets .ok field on response');
});

test('B1-APIFETCH-02: apiFetch handles JSON parse failure gracefully', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'apiFetch');
  assert.ok(body.includes('.catch(function ()'),
    'apiFetch has a catch for JSON parse failure');
  assert.ok(body.includes("'HTTP ' + res.status"),
    'fallback returns HTTP status string');
});

// ─── Tests: Existing activation flow preserved ─────────────────────────────

test('B1-PRESERVE-01: Requirement flow intact (loadRequirement, getRequirement, FALLBACK_REQUIREMENT)', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('async function loadRequirement'),
    'loadRequirement still exists');
  assert.ok(MEMBERSHIP_USER_SRC.includes('function getRequirement'),
    'getRequirement still exists');
  // Phase i18n: FALLBACK_REQUIREMENT was converted from a `var` to a
  // `function` so t() is only called at use-time (after app.js loaded).
  assert.ok(MEMBERSHIP_USER_SRC.includes('function FALLBACK_REQUIREMENT'),
    'FALLBACK_REQUIREMENT still exists (now a function — Phase i18n)');
  assert.ok(MEMBERSHIP_USER_SRC.includes("exchange_name: 'Bitunix'"),
    'Bitunix fallback intact');
});

test('B1-PRESERVE-02: UID validation unchanged (4-64 alphanumeric)', () => {
  const block = submitUidBlock();
  assert.ok(block.includes("uid.length < 4 || uid.length > 64"),
    'UID length validation preserved');
  assert.ok(block.includes("!/^[A-Za-z0-9_-]+$/.test(uid)"),
    'UID character validation preserved');
  // Phase i18n: invalid-UID message now via t('mem_err_invalid_uid')
  assert.ok(block.includes("t('mem_err_invalid_uid')"),
    'UID invalid message uses t(\'mem_err_invalid_uid\') (Phase i18n)');
});

test('B1-PRESERVE-03: Register button + openBitunix/openRegisterUrl preserved', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function openBitunix'),
    'openBitunix preserved');
  assert.ok(MEMBERSHIP_USER_SRC.includes('function openRegisterUrl'),
    'openRegisterUrl preserved');
  const block = activationPopupBlock();
  assert.ok(block.includes('mb-cta-register'),
    'register button class preserved');
  assert.ok(block.includes('MembershipApp.openBitunix()'),
    'register button onclick preserved');
});

// Phase 8M: Quota preview removed from activation popup (duplicate benefits removed)
test('B1-PRESERVE-04: Quota preview removed from activation popup (Phase 8M)', () => {
  const block = activationPopupBlock();
  assert.ok(!block.includes('mb-quota-preview'),
    'quota preview container removed (Phase 8M)');
  assert.ok(!block.includes('mb-quota-preview-grid'),
    'quota preview grid removed (Phase 8M)');
});

test('B1-PRESERVE-05: Activation timeline (6 steps) preserved', () => {
  const block = activationPopupBlock();
  assert.ok(block.includes('mb-timeline'),
    'timeline container preserved');
  assert.ok(block.includes('timelineStep(1,'),
    'timeline step 1 preserved');
  assert.ok(block.includes('timelineStep(6,'),
    'timeline step 6 preserved');
  // Phase i18n: step 6 text now via t('mem_timeline_step6')
  assert.ok(block.includes("t('mem_timeline_step6')"),
    'step 6 text uses t(\'mem_timeline_step6\') (Phase i18n)');
});

test('B1-PRESERVE-06: Pending popup + openPendingPopup preserved', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function openPendingPopup'),
    'openPendingPopup preserved');
  // checkPendingAndOpenPopup still routes to openActivationPopup for non-pending.
  assert.ok(MEMBERSHIP_USER_SRC.includes('function checkPendingAndOpenPopup'),
    'checkPendingAndOpenPopup preserved');
});

test('B1-PRESERVE-07: Success popup + openSuccessPopup preserved', () => {
  assert.ok(MEMBERSHIP_USER_SRC.includes('function openSuccessPopup'),
    'openSuccessPopup preserved');
});

test('B1-PRESERVE-08: /api/membership/request payload unchanged', () => {
  const block = submitUidBlock();
  assert.ok(block.includes("JSON.stringify({ exchange: exchangeName, uid: uid })"),
    'request payload shape preserved (exchange + uid)');
});

test('B1-PRESERVE-09: Exchange validation via getRequirement() preserved', () => {
  const block = submitUidBlock();
  assert.ok(block.includes('var req = getRequirement()'),
    'getRequirement() called for exchange name');
  assert.ok(block.includes("req.exchange_name || 'Bitunix'"),
    'exchange fallback preserved');
});

test('B1-PRESERVE-10: closePopup resets _rulesAcceptedVersion (per-popup session)', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'closePopup');
  assert.ok(body.includes('_rulesAcceptedVersion = null'),
    'closePopup resets rules acceptance state');
});

test('B1-PRESERVE-11: MembershipApp.refresh() clears rules cache too', () => {
  // The refresh() method on MembershipApp must clear _rules + _rulesAcceptedVersion.
  const refreshIdx = MEMBERSHIP_USER_SRC.indexOf('refresh: function ()');
  assert.ok(refreshIdx >= 0, 'refresh() exists on MembershipApp');
  const refreshBody = MEMBERSHIP_USER_SRC.slice(refreshIdx, refreshIdx + 200);
  assert.ok(refreshBody.includes('_rules = null'),
    'refresh() clears _rules');
  assert.ok(refreshBody.includes('_rulesAcceptedVersion = null'),
    'refresh() clears _rulesAcceptedVersion');
});

// ─── Tests: CSS for the rules section ──────────────────────────────────────

test('B1-CSS-01: .mb-rules-section base styles defined', () => {
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-section'),
    '.mb-rules-section CSS rule exists');
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-section--inactive'),
    'inactive variant CSS exists');
});

test('B1-CSS-02: .mb-rules-version badge styled with gold accent', () => {
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-version'),
    '.mb-rules-version CSS exists');
  // Must use the gold/amber accent color (matching the existing premium theme).
  const rule = MEMBERSHIP_CSS.slice(
    MEMBERSHIP_CSS.indexOf('.mb-rules-version'),
    MEMBERSHIP_CSS.indexOf('.mb-rules-effective')
  );
  assert.ok(rule.includes('#F5A623') || rule.includes('245, 158, 11'),
    'version badge uses gold accent color');
});

test('B1-CSS-03: .mb-rules-body has max-height + scroll overflow', () => {
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-body'),
    '.mb-rules-body CSS exists');
  const rule = MEMBERSHIP_CSS.slice(
    MEMBERSHIP_CSS.indexOf('.mb-rules-body {'),
    MEMBERSHIP_CSS.indexOf('.mb-rules-body::-webkit-scrollbar')
  );
  assert.ok(rule.includes('max-height'),
    'rules body has max-height');
  assert.ok(rule.includes('overflow-y: auto'),
    'rules body scrolls when overflow');
});

test('B1-CSS-04: Custom checkbox styling (.mb-rules-checkbox + .mb-rules-checkbox-custom)', () => {
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-checkbox'),
    'native checkbox hidden');
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-checkbox-custom'),
    'custom checkbox visual element styled');
  assert.ok(MEMBERSHIP_CSS.includes('.mb-rules-checkbox:checked + .mb-rules-checkbox-custom'),
    'checked state styled with sibling selector');
});

test('B1-CSS-05: Mobile/narrow WebView responsive breakpoints', () => {
  assert.ok(MEMBERSHIP_CSS.includes('@media (max-width: 380px)'),
    '380px breakpoint for narrow phones');
  assert.ok(MEMBERSHIP_CSS.includes('@media (max-width: 320px)'),
    '320px breakpoint for very narrow phones');
  // Find the 380px breakpoint that contains our rules-section adjustments.
  // (membership.css has many 380px breakpoints; we need the one we added.)
  let rules380 = -1;
  let searchFrom = 0;
  while (true) {
    const found = MEMBERSHIP_CSS.indexOf('@media (max-width: 380px)', searchFrom);
    if (found < 0) break;
    const slice = MEMBERSHIP_CSS.slice(found, found + 400);
    if (slice.includes('.mb-rules-section')) {
      rules380 = found;
      break;
    }
    searchFrom = found + 1;
  }
  assert.ok(rules380 >= 0,
    'a 380px breakpoint must adjust .mb-rules-section');
  const after380 = MEMBERSHIP_CSS.slice(rules380, rules380 + 400);
  assert.ok(after380.includes('.mb-rules-body'),
    'rules body adjusted at 380px');
  assert.ok(after380.includes('.mb-rules-accept'),
    'rules accept row adjusted at 380px');
  // Verify the 320px breakpoint follows shortly after (within 600 chars).
  const after380toEnd = MEMBERSHIP_CSS.slice(rules380, rules380 + 600);
  assert.ok(after380toEnd.includes('@media (max-width: 320px)'),
    '320px breakpoint follows the 380px one');
});

test('B1-CSS-06: Disabled submit button hint state styled (.mb-uid-submit--disabled)', () => {
  assert.ok(MEMBERSHIP_CSS.includes('.mb-uid-submit--disabled'),
    'disabled hint class CSS exists');
  const rule = MEMBERSHIP_CSS.slice(
    MEMBERSHIP_CSS.indexOf('.mb-uid-submit--disabled {'),
    MEMBERSHIP_CSS.indexOf('.mb-uid-submit--disabled:hover')
  );
  assert.ok(rule.includes('cursor: not-allowed'),
    'not-allowed cursor');
  assert.ok(rule.includes('#8B96A8'),
    'muted text color');
});

// ─── Tests: RTL / Persian rendering ────────────────────────────────────────

test('B1-RTL-01: Persian text present in rules section (RTL content, Phase 8L)', () => {
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  // Phase i18n: Persian phrases now resolved via t('mem_*') calls.
  const persianKeys = [
    "t('mem_rules_title')",        // section title
    "t('mem_rules_accept_label')", // acceptance label (Phase 8L)
    "t('mem_rules_view_full')",    // view full rules button (Phase 8L)
  ];
  for (const k of persianKeys) {
    assert.ok(body.includes(k), 'i18n key present: ' + k);
  }
});

test('B1-RTL-02: UID input keeps dir="ltr" (exchange UIDs are Latin)', () => {
  const block = activationPopupBlock();
  assert.ok(block.includes('dir="ltr"'),
    'UID input retains dir=ltr (Latin text direction)');
});

test('B1-RTL-03: Rules body text uses natural RTL (inherits from popup)', () => {
  // The rules body must NOT force dir=ltr (it contains Persian text).
  const body = fnBody(MEMBERSHIP_USER_SRC, 'buildRulesSectionHtml');
  const rulesBodyLine = body.slice(body.indexOf('mb-rules-body'), body.indexOf('mb-rules-body') + 200);
  assert.ok(!rulesBodyLine.includes('dir="ltr"'),
    'rules body does NOT force LTR (allows natural RTL for Persian)');
});

/**
 * Ticket Tab Selection Bug — Regression Test
 *
 * Root cause: HTML buttons use class "adm-filter-btn" but the JS
 * filterAdminTickets() and filterAdminRewards() queried for
 * ".admin-filter-btn" (different name) → querySelectorAll found 0
 * elements → active was never removed from siblings → ALL tabs
 * appeared selected simultaneously.
 *
 * Fix: changed querySelectorAll('.admin-filter-btn') → '.adm-filter-btn'
 * in both filterAdminTickets (admin.js:1612) and filterAdminRewards
 * (admin.js:1796) to match the HTML class name.
 *
 * Run: node --test ticket-tab-fix-test.cjs
 */
'use strict';
const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_JS = fs.readFileSync(path.join(__dirname, 'admin.js'), 'utf8');
const INDEX_HTML = fs.readFileSync(path.join(__dirname, 'index.html'), 'utf8');
const STYLE_CSS = fs.readFileSync(path.join(__dirname, 'style.css'), 'utf8');

// ============================================================================
// HTML uses "adm-filter-btn" (NOT "admin-filter-btn")
// ============================================================================

test('TAB-01: index.html ticket filter buttons use class "adm-filter-btn"', () => {
  assert.ok(INDEX_HTML.includes('class="adm-filter-btn'), 
    'HTML must use "adm-filter-btn" class');
});

test('TAB-02: index.html does NOT use "admin-filter-btn" for ticket tabs', () => {
  // The old buggy class name should not appear in the HTML for filter buttons
  const ticketSection = INDEX_HTML.match(/filterAdminTickets[\s\S]*?همه[\s\S]*?بسته شده/);
  assert.ok(ticketSection, 'ticket filter section must exist');
  assert.ok(!ticketSection[0].includes('admin-filter-btn'),
    'HTML must NOT use "admin-filter-btn" (the mismatched class)');
});

// ============================================================================
// JS querySelectorAll uses ".adm-filter-btn" (matching the HTML)
// ============================================================================

test('TAB-03: filterAdminTickets uses .adm-filter-btn in querySelectorAll', () => {
  // Find the function and verify the querySelectorAll call uses .adm-filter-btn
  const fnStart = ADMIN_JS.indexOf('function filterAdminTickets');
  assert.notEqual(fnStart, -1, 'filterAdminTickets must exist');
  // Take a 500-char window to capture the full function
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 500);
  assert.ok(fnBlock.includes("querySelectorAll('.adm-filter-btn')"),
    'filterAdminTickets must querySelectorAll(\'.adm-filter-btn\') to match HTML');
  // Verify the old buggy selector is NOT in actual code (only in comments is OK)
  // Remove comment lines before checking
  const codeOnly = fnBlock.split('\n').filter(l => !l.trim().startsWith('//')).join('\n');
  assert.ok(!codeOnly.includes("querySelectorAll('.admin-filter-btn')"),
    'filterAdminTickets must NOT use the old mismatched ".admin-filter-btn" in code');
});

test('TAB-04: filterAdminRewards uses .adm-filter-btn in querySelectorAll', () => {
  const fnMatch = ADMIN_JS.match(/function filterAdminRewards[\s\S]*?^}/m);
  assert.ok(fnMatch, 'filterAdminRewards must exist');
  assert.ok(fnMatch[0].includes("querySelectorAll('.adm-filter-btn')"),
    'filterAdminRewards must querySelectorAll(\'.adm-filter-btn\') to match HTML');
});

// ============================================================================
// CSS has .adm-filter-btn.active (matching the HTML class)
// ============================================================================

test('TAB-05: style.css has .adm-filter-btn.active rule', () => {
  assert.ok(STYLE_CSS.includes('.adm-filter-btn.active'),
    'CSS must have .adm-filter-btn.active rule');
});

// ============================================================================
// Behavioral: simulating the tab selection logic
// ============================================================================

// Simulate the filterAdminTickets logic with a mock DOM
function simulateTabSelection(clickedBtnClass, querySelector) {
  // Mock: 4 buttons, all with class "adm-filter-btn", first one has "active"
  const buttons = [
    { classList: { contains: (c) => c === 'adm-filter-btn' || (c === 'active' && true), remove: () => {}, add: () => {} }, _active: clickedBtnClass === 0 },
    { classList: { contains: (c) => c === 'adm-filter-btn', remove: () => {}, add: () => {} }, _active: false },
    { classList: { contains: (c) => c === 'adm-filter-btn', remove: () => {}, add: () => {} }, _active: false },
    { classList: { contains: (c) => c === 'adm-filter-btn', remove: () => {}, add: () => {} }, _active: false },
  ];
  
  // Track active state
  buttons.forEach(b => {
    b.classList.remove = (c) => { if (c === 'active') b._active = false; };
    b.classList.add = (c) => { if (c === 'active') b._active = true; };
  });
  
  // Set initial active on button 0
  buttons[0]._active = true;
  
  // Simulate clicking button 1
  const parent = { querySelectorAll: (sel) => {
    if (sel === '.adm-filter-btn') return buttons; // CORRECT: matches HTML class
    if (sel === '.admin-filter-btn') return [];  // BUG: doesn't match HTML class
    return [];
  }};
  
  // Run the logic
  parent.querySelectorAll(querySelector).forEach(b => b.classList.remove('active'));
  buttons[1].classList.add('active');
  
  return buttons.map(b => b._active);
}

test('TAB-06: with CORRECT selector (.adm-filter-btn), only clicked tab is active', () => {
  const result = simulateTabSelection(1, '.adm-filter-btn');
  assert.deepEqual(result, [false, true, false, false],
    'only button 1 should be active, button 0 deactivated');
});

test('TAB-07: with BUGGY selector (.admin-filter-btn), ALL tabs become active (the bug)', () => {
  const result = simulateTabSelection(1, '.admin-filter-btn');
  // The buggy selector finds 0 elements → never removes active from button 0
  // Button 0 still active + button 1 gets active → BOTH active (the bug)
  assert.deepEqual(result, [true, true, false, false],
    'with buggy selector: button 0 stays active + button 1 gets active = BOTH active');
});

test('TAB-08: clicking tab 2 deactivates tabs 0 and 1 (with correct selector)', () => {
  // Simulate: click tab 1, then click tab 2
  let result = simulateTabSelection(1, '.adm-filter-btn');
  assert.deepEqual(result, [false, true, false, false], 'after clicking tab 1');
  
  // Now click tab 2 — need to simulate on the result of clicking tab 1
  // Reset with tab 1 active, then click tab 2
  const buttons = [
    { _active: false, classList: { remove: () => {}, add: () => {} } },
    { _active: true, classList: { remove: () => {}, add: () => {} } },
    { _active: false, classList: { remove: () => {}, add: () => {} } },
    { _active: false, classList: { remove: () => {}, add: () => {} } },
  ];
  buttons.forEach(b => {
    b.classList.remove = (c) => { if (c === 'active') b._active = false; };
    b.classList.add = (c) => { if (c === 'active') b._active = true; };
  });
  const parent = { querySelectorAll: (sel) => sel === '.adm-filter-btn' ? buttons : [] };
  parent.querySelectorAll('.adm-filter-btn').forEach(b => b.classList.remove('active'));
  buttons[2].classList.add('active');
  result = buttons.map(b => b._active);
  assert.deepEqual(result, [false, false, true, false],
    'after clicking tab 2: only tab 2 active');
});

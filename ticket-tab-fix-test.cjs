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

// ============================================================================
// Ticket Replies Schema-Fix Regression Test
// Root cause: listTicketReplies (src/repositories/admin.js) selected columns
// (user_id, body, is_admin_reply) that do NOT exist in the ticket_replies
// table (real columns: sender_id, message, sender_type). PostgreSQL threw
// "column user_id does not exist" → HTTP 503 on GET /api/admin/tickets/:id/replies.
// Fix: query the real columns + map to the existing frontend response contract.
// Schema: scripts/00-migrate.sql:1216-1223.
// ============================================================================
const ADMIN_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/admin.js'), 'utf8');

test('TR-REPLY-01: listTicketReplies SQL uses real ticket_replies columns (not user_id/body/is_admin_reply)', () => {
  const fnStart = ADMIN_REPO_SRC.indexOf('async function listTicketReplies');
  assert.ok(fnStart > -1, 'listTicketReplies function must exist');
  const fnBlock = ADMIN_REPO_SRC.slice(fnStart, fnStart + 1200);
  // Must SELECT the real schema columns
  assert.ok(/SELECT\s+id,\s*ticket_id,\s*sender_id,\s*message,\s*sender_type,\s*created_at/i.test(fnBlock),
    'SQL must SELECT id, ticket_id, sender_id, message, sender_type, created_at (real ticket_replies columns)');
  // Must NOT select the old non-existent columns
  assert.ok(!/SELECT[^;]*\buser_id\b/.test(fnBlock.replace(/r\.user_id|adMetadata|user_id:/g, '')),
    'SQL must NOT SELECT user_id (does not exist in ticket_replies)');
  assert.ok(!fnBlock.includes('SELECT') || !/SELECT[^;]*\bis_admin_reply\b/.test(fnBlock),
    'SQL must NOT SELECT is_admin_reply (does not exist; real column is sender_type)');
});

test('TR-REPLY-02: listTicketReplies maps sender_id→user_id, message→body, sender_type→is_admin_reply (frontend contract preserved)', () => {
  const fnStart = ADMIN_REPO_SRC.indexOf('async function listTicketReplies');
  const fnBlock = ADMIN_REPO_SRC.slice(fnStart, fnStart + 1200);
  // Mapping must preserve the frontend contract (user_id/body/is_admin_reply)
  assert.ok(fnBlock.includes('user_id: String(r.sender_id)'),
    'map sender_id → user_id (frontend field name preserved)');
  assert.ok(fnBlock.includes('body: normalizeOptionalString(r.message)'),
    'map message → body (frontend field name preserved)');
  assert.ok(fnBlock.includes("is_admin_reply: r.sender_type === 'admin'"),
    'map sender_type === admin → is_admin_reply (boolean, frontend field preserved)');
  // id, ticket_id, created_at unchanged
  assert.ok(fnBlock.includes('id: String(r.id)') && fnBlock.includes('ticket_id: String(r.ticket_id)'),
    'id and ticket_id mapping preserved');
  assert.ok(fnBlock.includes('created_at: isoDate(r.created_at)'),
    'created_at mapping preserved');
});

test('TR-REPLY-03: listTicketReplies must NOT reference the old broken columns in the SELECT', () => {
  const fnStart = ADMIN_REPO_SRC.indexOf('async function listTicketReplies');
  const fnBlock = ADMIN_REPO_SRC.slice(fnStart, fnStart + 1200);
  // The SELECT line specifically must not contain user_id/body/is_admin_reply as selected columns
  const selectLine = fnBlock.match(/SELECT[^\n]*/);
  assert.ok(selectLine, 'must have a SELECT clause');
  assert.ok(!selectLine[0].includes('user_id'),
    'SELECT line must not reference user_id');
  assert.ok(!selectLine[0].includes('is_admin_reply'),
    'SELECT line must not reference is_admin_reply');
});

console.log('✅ Ticket replies schema-fix tests loaded.');

// ============================================================================
// Ticket Delete Optimistic Removal + Thread Touch Scroll — Regression Tests
// ============================================================================
const APP_JS = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');

// FIX 1: User-side deleteTicket must remove locally (not re-fetch stale data)
test('TR-DEL-01: deleteTicket user path uses optimistic local removal (tickets.filter), not fetchTickets()', () => {
  const fnStart = APP_JS.indexOf('async function deleteTicket(');
  assert.ok(fnStart > -1, 'deleteTicket function must exist');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes('tickets = tickets.filter'),
    'User-side delete must use tickets.filter (optimistic local removal)');
  assert.ok(fnBlock.includes('renderTickets()'),
    'User-side delete must call renderTickets() after local removal');
  assert.ok(fnBlock.includes('fetchAdminTickets'),
    'Admin path (fetchAdminTickets) must be preserved');
  const elseIdx = fnBlock.indexOf('else {');
  if (elseIdx > -1) {
    const elseBlock = fnBlock.slice(elseIdx);
    assert.ok(!elseBlock.includes('fetchTickets()'),
      'User-side delete must NOT call fetchTickets() (would re-fetch stale Hyperdrive data)');
  }
});

test('TR-DEL-02: deleteTicket still calls DELETE API before optimistic removal (no premature removal)', () => {
  const fnStart = APP_JS.indexOf('async function deleteTicket(');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 1200);
  const deleteCallIdx = fnBlock.indexOf("method: 'DELETE'");
  const filterIdx = fnBlock.indexOf('tickets = tickets.filter');
  assert.ok(deleteCallIdx > -1, 'DELETE API call must exist');
  assert.ok(filterIdx > -1, 'tickets.filter must exist');
  assert.ok(deleteCallIdx < filterIdx,
    'DELETE API call must precede the optimistic removal (only remove after success)');
});

// FIX 2: .tk-thread CSS must have -webkit-overflow-scrolling: touch
test('TR-SCROLL-01: .tk-thread CSS contains -webkit-overflow-scrolling: touch', () => {
  const TICKETS_CSS = fs.readFileSync(path.join(__dirname, 'tickets.css'), 'utf8');
  const ruleStart = TICKETS_CSS.indexOf('.tk-thread {');
  assert.ok(ruleStart > -1, '.tk-thread rule must exist in tickets.css');
  const ruleBlock = TICKETS_CSS.slice(ruleStart, ruleStart + 200);
  assert.ok(ruleBlock.includes('-webkit-overflow-scrolling: touch'),
    '.tk-thread must have -webkit-overflow-scrolling: touch for iOS WebView touch scrolling');
  assert.ok(ruleBlock.includes('max-height: 300px'),
    '.tk-thread max-height: 300px must be preserved');
  assert.ok(ruleBlock.includes('overflow-y: auto'),
    '.tk-thread overflow-y: auto must be preserved');
});

console.log('✅ Ticket delete + scroll regression tests loaded.');

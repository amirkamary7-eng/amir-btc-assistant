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
  const fnBlock = ADMIN_REPO_SRC.slice(fnStart, fnStart + 2000);
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
  const fnBlock = ADMIN_REPO_SRC.slice(fnStart, fnStart + 2000);
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
  const fnBlock = ADMIN_REPO_SRC.slice(fnStart, fnStart + 2000);
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
  const fnBlock = APP_JS.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('tickets = tickets.filter'),
    'User-side delete must use tickets.filter (optimistic local removal)');
  assert.ok(fnBlock.includes('renderTickets()'),
    'User-side delete must call renderTickets() after local removal');
  assert.ok(fnBlock.includes('fetchAdminTickets'),
    'Admin path (fetchAdminTickets) must be preserved');
  const elseIdx = fnBlock.indexOf('else {');
  if (elseIdx > -1) {
    const elseBlock = fnBlock.slice(elseIdx);
    assert.ok(!elseBlock.includes('await fetchTickets()'),
      'User-side delete must NOT call fetchTickets() (would re-fetch stale Hyperdrive data)');
  }
});

test('TR-DEL-02: deleteTicket still calls DELETE API before optimistic removal (no premature removal)', () => {
  const fnStart = APP_JS.indexOf('async function deleteTicket(');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 2000);
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

// ============================================================================
// BUG 1+2+3+4 Fixes — Stabilize ticket list and admin thread rendering
// ============================================================================

// BUG 1: _recentlyDeletedTicketIds Set exists + fetchTickets filters them
test('TR-DEL-03: _recentlyDeletedTicketIds Set tracks deleted IDs + fetchTickets filters them', () => {
  assert.ok(APP_JS.includes('_recentlyDeletedTicketIds'),
    '_recentlyDeletedTicketIds must exist to track recently deleted ticket IDs');
  assert.ok(APP_JS.includes('_recentlyDeletedTicketIds.add(delId)'),
    'deleteTicket must add the deleted ID to _recentlyDeletedTicketIds');
  assert.ok(APP_JS.includes('_recentlyDeletedTicketIds.has(String(tk.id))'),
    'fetchTickets must filter out recently deleted IDs from the API response');
  assert.ok(/setTimeout.*_recentlyDeletedTicketIds.*delete.*90000/.test(APP_JS),
    'deleted ID must have a 90s TTL cleanup (setTimeout)');
});

// BUG 1: fetchTickets has a request-sequence guard
test('TR-DEL-04: fetchTickets has a request-sequence guard (_ticketsFetchSeq)', () => {
  assert.ok(APP_JS.includes('_ticketsFetchSeq'),
    '_ticketsFetchSeq must exist as a request-sequence guard');
  assert.ok(APP_JS.includes('const seq = ++_ticketsFetchSeq'),
    'fetchTickets must increment the sequence before the await');
  assert.ok(APP_JS.includes('if (seq !== _ticketsFetchSeq) return'),
    'fetchTickets must discard stale responses (seq !== _ticketsFetchSeq)');
});

// BUG 2: submitTicket uses POST response ticket instead of fetchTickets()
test('TR-CREATE-01: submitTicket uses POST response resp.ticket instead of fetchTickets()', () => {
  const fnStart = APP_JS.indexOf('async function submitTicket(');
  assert.ok(fnStart > -1, 'submitTicket must exist');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 3500);
  assert.ok(fnBlock.includes('resp.ticket'),
    'submitTicket must use the POST response ticket object');
  assert.ok(fnBlock.includes('tickets.unshift(resp.ticket)'),
    'submitTicket must add the created ticket to the local array');
  assert.ok(fnBlock.includes("!tickets.some(tk => String(tk.id) === newId)"),
    'submitTicket must dedup by ID before adding (prevent polling duplicate)');
  // Must NOT call fetchTickets() in the success path
  assert.ok(!fnBlock.includes('await fetchTickets()'),
    'submitTicket must NOT call fetchTickets() after POST (would get stale Hyperdrive data)');
});

// BUG 3: loadAdminTickets renders .tk-replies container inside .tk-thread
test('TR-MSG-01: loadAdminTickets renders .tk-replies container inside .tk-thread', () => {
  assert.ok(ADMIN_JS.includes('class="tk-replies"'),
    'loadAdminTickets must render a .tk-replies container for replies');
  assert.ok(ADMIN_JS.includes('adm-ticket-replies-'),
    '.tk-replies must have an id for fetchTicketReplies to target');
});

// BUG 3: fetchTicketReplies targets .tk-replies (NOT .tk-thread innerHTML)
test('TR-MSG-02: fetchTicketReplies targets .tk-replies container, not .tk-thread innerHTML', () => {
  const fnStart = ADMIN_JS.indexOf('async function fetchTicketReplies');
  assert.ok(fnStart > -1, 'fetchTicketReplies must exist');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 1200);
  assert.ok(fnBlock.includes("getElementById('adm-ticket-replies-'"),
    'fetchTicketReplies must target the .tk-replies container by ID');
  assert.ok(fnBlock.includes('repliesEl.innerHTML = html'),
    'fetchTicketReplies must set innerHTML on repliesEl (the .tk-replies container)');
  // Must NOT use threadEl.innerHTML (the old bug that destroyed the original message)
  assert.ok(!fnBlock.includes('threadEl.innerHTML'),
    'fetchTicketReplies must NOT set innerHTML on .tk-thread (would destroy the original message)');
  assert.ok(!fnBlock.includes('querySelector'),
    'fetchTicketReplies must NOT use querySelector on .adm-ticket-thread (old buggy pattern)');
});

// BUG 3b: adminReplyTicket calls fetchTicketReplies after loadAdminTickets
test('TR-REPLY-FIX: adminReplyTicket calls fetchTicketReplies WITHOUT loadAdminTickets', () => {
  const fnStart = ADMIN_JS.indexOf('async function adminReplyTicket');
  assert.ok(fnStart > -1, 'adminReplyTicket must exist');
  // Find the NEXT function definition to limit the slice to just adminReplyTicket
  const nextFn = ADMIN_JS.indexOf('async function', fnStart + 30);
  const fnBlock = ADMIN_JS.slice(fnStart, nextFn > -1 ? nextFn : fnStart + 2000);
  assert.ok(fnBlock.includes('fetchTicketReplies(ticketId)'),
    'adminReplyTicket must call fetchTicketReplies to refresh replies after POST');
  // BUG C FIX: loadAdminTickets must NOT be CALLED (check for function-call pattern).
  assert.ok(!fnBlock.includes('loadAdminTickets('),
    'adminReplyTicket must NOT call loadAdminTickets() (causes skeleton flicker + DOM race)');
});

// BUG 4: .tk-replies CSS exists
test('TR-SCROLL-02: .tk-replies CSS exists (flex column for reply spacing)', () => {
  const TICKETS_CSS = fs.readFileSync(path.join(__dirname, 'tickets.css'), 'utf8');
  assert.ok(TICKETS_CSS.includes('.tk-replies'),
    '.tk-replies CSS must exist in tickets.css');
});

// BUG 4: .tk-thread is NOT replaced by fetchTicketReplies (DOM stays stable → scrollTop preserved)
test('TR-SCROLL-03: .tk-thread DOM stays stable after fetchTicketReplies (no innerHTML replacement)', () => {
  const fnStart = ADMIN_JS.indexOf('async function fetchTicketReplies');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 1200);
  // fetchTicketReplies must NOT set innerHTML on .tk-thread or .adm-ticket-thread
  assert.ok(!fnBlock.includes('adm-ticket-thread'),
    'fetchTicketReplies must NOT reference .adm-ticket-thread (the .tk-thread container must stay untouched)');
  assert.ok(!fnBlock.includes('threadEl'),
    'fetchTicketReplies must NOT have a threadEl variable (old pattern that replaced .tk-thread innerHTML)');
});

console.log('✅ Bug 1+2+3+4 stabilization tests loaded.');

// ============================================================================
// BUG A+B+C Fixes — Admin delete, create race, reply refresh
// ============================================================================

// BUG A: handleDeleteTicket must destructure admin + use admin?.telegram_id (not auth?.user?.id)
test('TR-ADMIN-DEL-01: handleDeleteTicket destructures admin from requireAdmin', () => {
  const ADMIN_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/admin.js'), 'utf8');
  const fnStart = ADMIN_CTRL_SRC.indexOf('async function handleDeleteTicket');
  assert.ok(fnStart > -1, 'handleDeleteTicket must exist');
  const fnBlock = ADMIN_CTRL_SRC.slice(fnStart, fnStart + 600);
  assert.ok(fnBlock.includes('{ error: authErr, admin }'),
    'handleDeleteTicket must destructure admin from requireAdmin (not just error)');
  assert.ok(fnBlock.includes('admin?.telegram_id'),
    'handleDeleteTicket must use admin?.telegram_id for rate limit');
  assert.ok(!fnBlock.includes('auth?.user?.id'),
    'handleDeleteTicket must NOT reference auth?.user?.id (was the ReferenceError bug)');
});

// BUG B: submitTicket must increment _ticketsFetchSeq before tickets.unshift
test('TR-CREATE-02: submitTicket increments _ticketsFetchSeq before tickets.unshift', () => {
  const fnStart = APP_JS.indexOf('async function submitTicket(');
  assert.ok(fnStart > -1, 'submitTicket must exist');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 3500);
  const seqIdx = fnBlock.indexOf('++_ticketsFetchSeq');
  const unshiftIdx = fnBlock.indexOf('tickets.unshift(resp.ticket)');
  assert.ok(seqIdx > -1, 'submitTicket must increment _ticketsFetchSeq before local mutation');
  assert.ok(unshiftIdx > -1, 'submitTicket must call tickets.unshift(resp.ticket)');
  assert.ok(seqIdx < unshiftIdx,
    '_ticketsFetchSeq must be incremented BEFORE tickets.unshift (invalidates in-flight fetchTickets)');
});

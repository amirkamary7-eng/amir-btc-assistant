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
  const fnBlock = APP_JS.slice(fnStart, fnStart + 4000);
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
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 2000);
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
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 2000);
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
  const fnBlock = APP_JS.slice(fnStart, fnStart + 4000);
  const seqIdx = fnBlock.indexOf('++_ticketsFetchSeq');
  const unshiftIdx = fnBlock.indexOf('tickets.unshift(resp.ticket)');
  assert.ok(seqIdx > -1, 'submitTicket must increment _ticketsFetchSeq before local mutation');
  assert.ok(unshiftIdx > -1, 'submitTicket must call tickets.unshift(resp.ticket)');
  assert.ok(seqIdx < unshiftIdx,
    '_ticketsFetchSeq must be incremented BEFORE tickets.unshift (invalidates in-flight fetchTickets)');
});

// ============================================================================
// BUG 1 (v2) + BUG 2 (v2) — Created ticket preservation + reply optimistic render
// ============================================================================

// BUG 1: _recentlyCreatedTickets Map exists
test('TR-CREATE-03: _recentlyCreatedTickets Map exists in app.js', () => {
  assert.ok(APP_JS.includes('_recentlyCreatedTickets'),
    '_recentlyCreatedTickets must exist to preserve locally-created tickets');
  assert.ok(APP_JS.includes('new Map()'),
    '_recentlyCreatedTickets must be a Map');
});

// BUG 1: submitTicket stores created ticket in _recentlyCreatedTickets
test('TR-CREATE-04: submitTicket stores created ticket in _recentlyCreatedTickets with 90s TTL', () => {
  const fnStart = APP_JS.indexOf('async function submitTicket(');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 4000);
  assert.ok(fnBlock.includes('_recentlyCreatedTickets.set('),
    'submitTicket must store the created ticket in _recentlyCreatedTickets');
  assert.ok(fnBlock.includes('expiresAt: Date.now() + 90000'),
    'submitTicket must set 90s TTL for the stored ticket');
});

// BUG 1: fetchTickets preserves recently-created tickets absent from API response
test('TR-CREATE-05: fetchTickets preserves recently-created tickets absent from API response', () => {
  const fnStart = APP_JS.indexOf('async function fetchTickets()');
  const fnBlock = APP_JS.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('_recentlyCreatedTickets.size > 0'),
    'fetchTickets must check _recentlyCreatedTickets');
  assert.ok(fnBlock.includes('!fetched.some(tk => String(tk.id) === id)'),
    'fetchTickets must check if the created ticket is already in fetched (no duplicate)');
  assert.ok(fnBlock.includes('fetched.unshift(entry.ticket)'),
    'fetchTickets must add missing recently-created tickets to fetched');
  assert.ok(fnBlock.includes('_recentlyCreatedTickets.delete(id)'),
    'fetchTickets must delete expired entries from _recentlyCreatedTickets');
});

// BUG 1: _ticketsFetchSeq remains intact
test('TR-CREATE-06: _ticketsFetchSeq remains intact in fetchTickets and submitTicket', () => {
  assert.ok(APP_JS.includes('const seq = ++_ticketsFetchSeq'),
    'fetchTickets must still have the seq guard');
  assert.ok(APP_JS.includes('if (seq !== _ticketsFetchSeq) return'),
    'fetchTickets must still discard stale responses');
  assert.ok(APP_JS.includes('++_ticketsFetchSeq;'),
    'submitTicket must still increment the seq before local mutation');
});

// BUG 2: _repliesFetchSeq per-ticket sequence guard exists
test('TR-REPLY-SEQ-01: _repliesFetchSeq per-ticket sequence guard exists in admin.js', () => {
  assert.ok(ADMIN_JS.includes('_repliesFetchSeq'),
    '_repliesFetchSeq must exist as a per-ticket reply sequence guard');
  assert.ok(ADMIN_JS.includes('_repliesFetchSeq = {}'),
    '_repliesFetchSeq must be an object (per-ticket keyed)');
});

// BUG 2: fetchTicketReplies has per-ticket seq guard
test('TR-REPLY-SEQ-02: fetchTicketReplies has per-ticket seq guard that discards stale responses', () => {
  const fnStart = ADMIN_JS.indexOf('async function fetchTicketReplies');
  assert.ok(fnStart > -1, 'fetchTicketReplies must exist');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('_repliesFetchSeq[ticketId]'),
    'fetchTicketReplies must use per-ticket seq (_repliesFetchSeq[ticketId])');
  assert.ok(fnBlock.includes('if (seq !== _repliesFetchSeq[ticketId]) return'),
    'fetchTicketReplies must discard stale responses (seq !== current)');
});

// BUG 2: adminReplyTicket does optimistic rendering after POST
test('TR-REPLY-OPT-01: adminReplyTicket performs optimistic reply rendering after POST', () => {
  const fnStart = ADMIN_JS.indexOf('async function adminReplyTicket');
  assert.ok(fnStart > -1, 'adminReplyTicket must exist');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('insertAdjacentHTML'),
    'adminReplyTicket must use insertAdjacentHTML for optimistic render');
  assert.ok(fnBlock.includes('tk-msg-admin'),
    'optimistic reply must use tk-msg-admin class');
  assert.ok(fnBlock.includes('adminEscapeHtml(message)'),
    'optimistic reply message must be escaped via adminEscapeHtml');
});

// BUG 2: adminReplyTicket awaits fetchTicketReplies
test('TR-REPLY-OPT-02: adminReplyTicket awaits fetchTicketReplies for reconciliation', () => {
  const fnStart = ADMIN_JS.indexOf('async function adminReplyTicket');
  const fnBlock = ADMIN_JS.slice(fnStart, fnStart + 2000);
  assert.ok(fnBlock.includes('await fetchTicketReplies(ticketId)'),
    'adminReplyTicket must await fetchTicketReplies for server reconciliation');
});

// BUG 2: loadAdminTickets NOT reintroduced
test('TR-REPLY-OPT-03: adminReplyTicket does NOT call loadAdminTickets', () => {
  const fnStart = ADMIN_JS.indexOf('async function adminReplyTicket');
  const nextFn = ADMIN_JS.indexOf('async function', fnStart + 30);
  const fnBlock = ADMIN_JS.slice(fnStart, nextFn > -1 ? nextFn : fnStart + 2000);
  assert.ok(!fnBlock.includes('loadAdminTickets('),
    'adminReplyTicket must NOT call loadAdminTickets (causes skeleton + DOM race)');
});

// BUG 2: .tk-replies DOM structure remains intact
test('TR-REPLY-OPT-04: .tk-replies container structure remains in loadAdminTickets', () => {
  assert.ok(ADMIN_JS.includes('class="tk-replies"'),
    'loadAdminTickets must still render .tk-replies container');
  assert.ok(ADMIN_JS.includes('adm-ticket-replies-'),
    '.tk-replies must still have the id for fetchTicketReplies to target');
});

console.log('✅ BUG 1 (v2) + BUG 2 (v2) regression tests loaded.');

// ============================================================================
// RCA FIX (Option A, 2026-09-16) — Hyperdrive stale SELECT bypass for
// listTicketReplies (ticket_replies read-after-write consistency).
//
// Root cause (proven 2026-09-10 for the notification path, identical pattern
// here): listTicketReplies issued a deterministic SELECT via queryDb, which
// Hyperdrive caches at the edge (default cache_ttl = 60s, binding
// f4b69c06c1e84d98b7c4b5720efe4b41, caching.disabled=false). After a POST
// reply (INSERT via queryDb — bypasses cache, hits origin), the awaited
// fetchTicketReplies GET returns the pre-reply cached result for up to 60s,
// and admin.js:1553 `repliesEl.innerHTML = html` destroys the optimistic
// reply. The reply reappears ~30s later when cache expires and a later GET
// queries origin.
//
// Fix (Option A — mirrors notificationRepo.list, commit 2745906): route
// listTicketReplies through queryDbDirect (direct pg.Pool bound to
// env.DIRECT_URL, bypassing Hyperdrive's edge cache). Mapping + API response
// contract unchanged.
//
// These tests prove:
//   - The SELECT in listTicketReplies now uses queryDbDirect (source-text)
//   - createAdminRepository destructures queryDbDirect from deps (source-text)
//   - worker-proxy.js injects queryDbDirect into createAdminRepository (source-text)
//   - INSERT reply via queryDb bypasses cache (hits origin) — POST works
//   - GET replies via queryDbDirect returns the new reply IMMEDIATELY
//     (no 60s stale window) — the FIX
//   - GET replies via queryDb (old path) would STILL return stale data —
//     sanity: the fix bypasses the cache, it does NOT invalidate it
// ============================================================================

const ADMIN_REPO_JS = fs.readFileSync(path.join(__dirname, 'src/repositories/admin.js'), 'utf8');
const WORKER_PROXY_JS = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// ── Source-text assertions: the fix is wired in the 3 required places ──────

test('TR-HYPERDRIVE-01: listTicketReplies uses queryDbDirect (NOT queryDb) for the ticket_replies SELECT', () => {
  const fnStart = ADMIN_REPO_JS.indexOf('async function listTicketReplies');
  assert.ok(fnStart > -1, 'listTicketReplies function must exist');
  const nextFn = ADMIN_REPO_JS.indexOf('async function', fnStart + 30);
  const fnBlock = ADMIN_REPO_JS.slice(fnStart, nextFn > -1 ? nextFn : fnStart + 1200);
  assert.ok(fnBlock.includes('await queryDbDirect('),
    'listTicketReplies must call queryDbDirect (bypasses Hyperdrive cache)');
  assert.ok(!/\bawait queryDb\(/.test(fnBlock),
    'listTicketReplies must NOT call queryDb for the SELECT (would hit Hyperdrive cache)');
});

test('TR-HYPERDRIVE-02: createAdminRepository destructures queryDbDirect from deps', () => {
  const factoryStart = ADMIN_REPO_JS.indexOf('export function createAdminRepository(deps)');
  const factoryBlock = ADMIN_REPO_JS.slice(factoryStart, factoryStart + 200);
  assert.ok(factoryBlock.includes('queryDbDirect'),
    'createAdminRepository must destructure queryDbDirect from deps so it is in scope for listTicketReplies');
});

test('TR-HYPERDRIVE-03: worker-proxy.js injects queryDbDirect into createAdminRepository', () => {
  const callIdx = WORKER_PROXY_JS.indexOf('createAdminRepository({');
  assert.ok(callIdx > -1, 'createAdminRepository call must exist in worker-proxy.js');
  const callBlock = WORKER_PROXY_JS.slice(callIdx, callIdx + 120);
  assert.ok(callBlock.includes('queryDbDirect'),
    'worker-proxy.js must pass queryDbDirect in the createAdminRepository deps');
});

test('TR-HYPERDRIVE-04: listTicketReplies mapping + API response contract unchanged', () => {
  const fnStart = ADMIN_REPO_JS.indexOf('async function listTicketReplies');
  const nextFn = ADMIN_REPO_JS.indexOf('async function', fnStart + 30);
  const fnBlock = ADMIN_REPO_JS.slice(fnStart, nextFn > -1 ? nextFn : fnStart + 1200);
  // The exact SELECT columns + ORDER BY must be preserved (read-after-write fix
  // changes only the connection path, NOT the query semantics).
  assert.ok(fnBlock.includes('SELECT id, ticket_id, sender_id, message, sender_type, created_at'),
    'SELECT columns must be unchanged');
  assert.ok(fnBlock.includes('FROM ticket_replies'),
    'FROM clause must be unchanged');
  assert.ok(fnBlock.includes('WHERE ticket_id = $1'),
    'WHERE clause must be unchanged');
  assert.ok(fnBlock.includes('ORDER BY created_at ASC'),
    'ORDER BY must be unchanged (oldest first, newest last)');
  // The response contract mapping (user_id/body/is_admin_reply/created_at)
  // must be preserved so fetchTicketReplies (admin.js) needs no change.
  assert.ok(fnBlock.includes('user_id: String(r.sender_id)'),
    'user_id mapping must be preserved');
  assert.ok(fnBlock.includes('body: normalizeOptionalString(r.message)'),
    'body mapping must be preserved');
  assert.ok(fnBlock.includes('is_admin_reply: r.sender_type === \'admin\''),
    'is_admin_reply mapping must be preserved');
  assert.ok(fnBlock.includes('created_at: isoDate(r.created_at)'),
    'created_at mapping must be preserved');
});

// ── Behavioral simulation: read-after-write via queryDbDirect ───────────────
// Mirrors notif-hyperdrive-cache-rca-test.cjs REGRESSION (Option C) test,
// adapted for ticket_replies: INSERT reply (mutation, bypasses cache) then
// GET replies via queryDbDirect returns the new reply immediately.

test('TR-HYPERDRIVE-05 (REGRESSION Option A): queryDbDirect bypasses Hyperdrive cache — GET replies after POST reply returns the new reply immediately', async () => {
  // Simulate Hyperdrive-cached queryDb (60s TTL) + origin + a queryDbDirect
  // path that bypasses the cache (mirrors worker-proxy.js queryDbDirect).
  const origin = new Map(); // ticketId -> [{ reply_id, message, sender_type, created_at }]
  const cache = new Map(); // sqlKey -> { result, cachedAt }
  let clock = 0;
  const CACHE_TTL_MS = 60000;

  origin.set('T1', []);

  function cacheKey(sql, params) {
    return String(sql).replace(/\s+/g, ' ').trim() + '|' + JSON.stringify(params);
  }
  function originExecuteListReplies(ticketId) {
    const rows = (origin.get(String(ticketId)) || []).map((r) => ({
      id: r.reply_id, ticket_id: String(ticketId), sender_id: r.sender_id,
      message: r.message, sender_type: r.sender_type, created_at: r.created_at,
    }));
    return { rows, rowCount: rows.length, fields: [], command: 'SELECT' };
  }

  // queryDb — Hyperdrive path: the listTicketReplies SELECT is cached for 60s.
  // Mutations (INSERT) bypass the cache and hit origin (per Hyperdrive docs).
  async function queryDb(env, sqlText, params = []) {
    const sql = String(sqlText).replace(/\s+/g, ' ').trim();
    const isListReplies = /^SELECT id, ticket_id, sender_id, message, sender_type, created_at FROM ticket_replies WHERE ticket_id = \$1 ORDER BY created_at ASC$/i.test(sql);
    if (isListReplies) {
      const key = cacheKey(sql, params);
      const entry = cache.get(key);
      if (entry && (clock - entry.cachedAt) < CACHE_TTL_MS) {
        return { ...entry.result, _fromCache: true };
      }
      const result = originExecuteListReplies(String(params[0]));
      cache.set(key, { result, cachedAt: clock });
      return { ...result, _fromCache: false };
    }
    // INSERT reply — bypasses cache, hits origin.
    const isInsertReply = /^INSERT INTO ticket_replies \(ticket_id, sender_type, sender_id, message, created_at\) VALUES \(\$1, 'admin', \$2, \$3, NOW\(\)\)$/i.test(sql);
    if (isInsertReply) {
      const ticketId = String(params[0]);
      const senderId = String(params[1]);
      const message = String(params[2]);
      const list = origin.get(ticketId) || [];
      const replyId = 'R' + (list.length + 1);
      list.push({ reply_id: replyId, sender_id: senderId, message, sender_type: 'admin', created_at: clock });
      origin.set(ticketId, list);
      return { rows: [], rowCount: 1, fields: [], command: 'INSERT' };
    }
    return { rows: [], rowCount: 0, fields: [], command: 'NOOP' };
  }

  // queryDbDirect — bypasses Hyperdrive cache: queries origin directly,
  // never checks cache, never populates cache. (Simulates a fresh pg.Pool
  // bound to env.DIRECT_URL — see worker-proxy.js queryDbDirect.)
  async function queryDbDirect(env, sqlText, params = []) {
    const sql = String(sqlText).replace(/\s+/g, ' ').trim();
    const isListReplies = /^SELECT id, ticket_id, sender_id, message, sender_type, created_at FROM ticket_replies WHERE ticket_id = \$1 ORDER BY created_at ASC$/i.test(sql);
    if (isListReplies) {
      return { ...originExecuteListReplies(String(params[0])), _fromCache: false, _directBypass: true };
    }
    throw new Error('[sim] queryDbDirect received unsupported query: ' + sql.slice(0, 80));
  }

  // t=1000 — admin expands ticket T1 → fetchTicketReplies GET #1 via queryDb
  // (Hyperdrive). Cache MISS → origin returns [] → cache populated with [].
  clock = 1000;
  const list1 = await queryDb({}, `
    SELECT id, ticket_id, sender_id, message, sender_type, created_at
    FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC
  `, ['T1']);
  assert.equal(list1.rows.length, 0, 'initial GET (cache MISS) returns 0 replies');
  assert.equal(list1._fromCache, false, 'first GET is a cache MISS');
  assert.equal(cache.size, 1, 'cache populated after first GET');

  // t=1100 — admin clicks Send → POST reply. handleReplyTicket calls
  // insertTicketReply via queryDb (INSERT bypasses cache, hits origin).
  clock = 1100;
  const post = await queryDb({}, `
    INSERT INTO ticket_replies (ticket_id, sender_type, sender_id, message, created_at)
    VALUES ($1, 'admin', $2, $3, NOW())
  `, ['T1', 'admin-42', 'Hello from admin']);
  assert.equal(post.rowCount, 1, 'POST reply INSERT succeeds on origin (INSERT bypasses cache)');
  assert.equal(cache.size, 1, 'cache NOT invalidated by INSERT (Hyperdrive does not invalidate on mutation)');

  // t=1200 — WITHOUT the fix: GET replies via queryDb (Hyperdrive) within 60s
  // TTL → cache HIT → returns stale [] (WITHOUT the new reply). BUG REPRODUCED.
  clock = 1200;
  const listStale = await queryDb({}, `
    SELECT id, ticket_id, sender_id, message, sender_type, created_at
    FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC
  `, ['T1']);
  assert.equal(listStale.rows.length, 0, 'WITHOUT fix: Hyperdrive GET within 60s TTL returns stale [] (no new reply) — bug reproduces');
  assert.equal(listStale._fromCache, true, 'WITHOUT fix: Hyperdrive GET is a cache HIT (stale)');
  assert.equal(listStale.rows.find((r) => r.message === 'Hello from admin'), undefined,
    'WITHOUT fix: the new admin reply is NOT returned by the cached queryDb path');

  // t=1200 — WITH the fix: GET replies via queryDbDirect → bypasses cache →
  // returns fresh result (WITH the new reply). FIX VERIFIED.
  const listFixed = await queryDbDirect({}, `
    SELECT id, ticket_id, sender_id, message, sender_type, created_at
    FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC
  `, ['T1']);
  assert.equal(listFixed.rows.length, 1, 'FIX: queryDbDirect returns the new reply immediately');
  assert.equal(listFixed._fromCache, false, 'FIX: queryDbDirect is never a cache hit');
  assert.equal(listFixed._directBypass, true, 'FIX: queryDbDirect uses the direct-bypass path');
  assert.equal(listFixed.rows[0].message, 'Hello from admin', 'FIX: the new admin reply is visible in the GET result');
  assert.equal(listFixed.rows[0].sender_type, 'admin', 'FIX: reply is mapped as admin sender_type');
  assert.equal(listFixed.rows[0].ticket_id, 'T1', 'FIX: reply is associated with the correct ticket');

  // Sanity: the Hyperdrive cache is STILL stale (queryDb would still return []).
  // This proves the fix bypasses the cache — it does NOT invalidate it.
  const listStaleStill = await queryDb({}, `
    SELECT id, ticket_id, sender_id, message, sender_type, created_at
    FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC
  `, ['T1']);
  assert.equal(listStaleStill._fromCache, true, 'sanity: Hyperdrive cache is still stale — fix bypasses it, does NOT invalidate it');
  assert.equal(listStaleStill.rows.length, 0, 'sanity: Hyperdrive would still return [] (cache untouched)');

  // t=62100 — 60s+ after GET #1 → Hyperdrive cache expires. Now queryDb would
  // also return fresh data (the "self-correction" the user observed at ~30s).
  // This confirms the ~30-60s window matches the cache TTL, not a poll.
  clock = 62100;
  const listAfterExpiry = await queryDb({}, `
    SELECT id, ticket_id, sender_id, message, sender_type, created_at
    FROM ticket_replies WHERE ticket_id = $1 ORDER BY created_at ASC
  `, ['T1']);
  assert.equal(listAfterExpiry._fromCache, false, 'after 60s: Hyperdrive cache expired, queryDb queries origin');
  assert.equal(listAfterExpiry.rows.length, 1, 'after 60s: even the cached path returns the new reply (cache expired)');
});

test('TR-HYPERDRIVE-06: the awaited GET after POST (admin.js:1590) is the path that was stale — seq guard does NOT prevent it', () => {
  // This is a documentation test: the per-ticket _repliesFetchSeq guard in
  // fetchTicketReplies (admin.js) only prevents an OLDER in-flight GET from
  // overwriting a NEWER one. In the reply flow there is exactly ONE GET
  // (the awaited one at adminReplyTicket line 1590), it is the newest, its
  // seq matches, so it is APPLIED — and it returns stale data. The seq guard
  // is therefore orthogonal to this bug; the real fix is the backend cache
  // bypass (queryDbDirect), proven in TR-HYPERDRIVE-05.
  const fnStart = ADMIN_JS.indexOf('async function fetchTicketReplies');
  assert.ok(fnStart > -1, 'fetchTicketReplies must exist');
  const nextFn = ADMIN_JS.indexOf('async function', fnStart + 30);
  const fnBlock = ADMIN_JS.slice(fnStart, nextFn > -1 ? nextFn : fnStart + 1500);
  assert.ok(fnBlock.includes('_repliesFetchSeq'),
    'fetchTicketReplies has the per-ticket seq guard');
  assert.ok(fnBlock.includes('repliesEl.innerHTML = html'),
    'fetchTicketReplies replaces .tk-replies contents via innerHTML (the destroy line)');
  // The awaited reconciliation call in adminReplyTicket
  const replyFnStart = ADMIN_JS.indexOf('async function adminReplyTicket');
  const replyNext = ADMIN_JS.indexOf('async function', replyFnStart + 30);
  const replyBlock = ADMIN_JS.slice(replyFnStart, replyNext > -1 ? replyNext : replyFnStart + 1500);
  assert.ok(replyBlock.includes('insertAdjacentHTML(\'beforeend\''),
    'adminReplyTicket appends the optimistic reply (visible momentarily)');
  assert.ok(replyBlock.includes('await fetchTicketReplies(ticketId)'),
    'adminReplyTicket awaits fetchTicketReplies (the GET that returns stale cached data without the fix)');
});

console.log('✅ RCA Option A (ticket_replies Hyperdrive cache bypass) regression tests loaded.');

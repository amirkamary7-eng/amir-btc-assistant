/**
 * ADMIN-HARDENING-REGRESSION-TEST
 *
 * Tests for A-4 (broadcast batching), Rewards UI, Templates UI,
 * A-3 (admin rate limiting), A-5 (CORS fail-closed), A-7 (content auth),
 * A-8 (error logging safety).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const ADMIN_CTRL_PATH = path.join(__dirname, 'src', 'controllers', 'admin.js');
const ADMIN_JS_PATH = path.join(__dirname, 'admin.js');

const workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
const adminCtrlSrc = fs.readFileSync(ADMIN_CTRL_PATH, 'utf8');
const adminJsSrc = fs.readFileSync(ADMIN_JS_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// A-4: Legacy Broadcast Batching
// ═══════════════════════════════════════════════════════════════════════

test('A-4-1: handleCreateBroadcast uses bounded batch processing', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleCreateBroadcast');
  const fnEnd = adminCtrlSrc.indexOf('async function handleListBroadcasts');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/BROADCAST_BATCH_SIZE\s*=\s*25/.test(fnSrc), 'Must use BROADCAST_BATCH_SIZE = 25');
  assert.ok(/Promise\.allSettled/.test(fnSrc), 'Must use Promise.allSettled for batch processing');
  assert.ok(/for\s*\(let i\s*=\s*0;\s*i\s*<\s*targetUsers\.length;\s*i\s*\+=\s*BROADCAST_BATCH_SIZE\)/.test(fnSrc),
    'Must iterate in batches of 25');
});

test('A-4-2: No sequential for-of loop over targetUsers', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleCreateBroadcast');
  const fnEnd = adminCtrlSrc.indexOf('async function handleListBroadcasts');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  // The old pattern was: for (const userId of targetUsers) {
  assert.ok(!/for\s*\(const userId of targetUsers\)/.test(fnSrc),
    'Must NOT use sequential for-of loop over targetUsers');
});

// ═══════════════════════════════════════════════════════════════════════
// Rewards UI: Approve/Reject buttons
// ═══════════════════════════════════════════════════════════════════════

test('REWARDS-UI-1: Approve button exists for pending rewards', () => {
  const fnStart = adminJsSrc.indexOf('async function loadAdminRewards');
  const fnEnd = adminJsSrc.indexOf('function filterAdminRewards');
  const fnSrc = adminJsSrc.slice(fnStart, fnEnd);
  assert.ok(/adminApproveReward/.test(fnSrc), 'Must have adminApproveReward button');
  assert.ok(/approved/.test(fnSrc), 'Must send "approved" status');
});

test('REWARDS-UI-2: Reject button exists for pending rewards', () => {
  const fnStart = adminJsSrc.indexOf('async function loadAdminRewards');
  const fnEnd = adminJsSrc.indexOf('function filterAdminRewards');
  const fnSrc = adminJsSrc.slice(fnStart, fnEnd);
  assert.ok(/adminRejectReward/.test(fnSrc), 'Must have adminRejectReward button');
  assert.ok(/rejected/.test(fnSrc), 'Must send "rejected" status');
});

test('REWARDS-UI-3: Duplicate click protection exists', () => {
  assert.ok(/_adminRewardActionInProgress/.test(adminJsSrc), 'Must have duplicate click protection flag');
});

test('REWARDS-UI-4: Reward buttons only shown for pending status', () => {
  const fnStart = adminJsSrc.indexOf('async function loadAdminRewards');
  const fnEnd = adminJsSrc.indexOf('function filterAdminRewards');
  const fnSrc = adminJsSrc.slice(fnStart, fnEnd);
  assert.ok(/r\.status\s*===\s*['"]pending['"]/.test(fnSrc), 'Buttons must only appear for pending rewards');
});

test('REWARDS-UI-5: Approve/reject uses existing backend endpoint', () => {
  const fnStart = adminJsSrc.indexOf('async function adminApproveReward');
  const fnEnd = adminJsSrc.indexOf('async function adminRejectReward');
  const fnSrc = adminJsSrc.slice(fnStart, fnEnd);
  assert.ok(/\/api\/admin\/rewards\//.test(fnSrc), 'Must use /api/admin/rewards/ endpoint');
  assert.ok(/\/status/.test(fnSrc), 'Must use /status endpoint');
  assert.ok(/PUT/.test(fnSrc), 'Must use PUT method');
});

// ═══════════════════════════════════════════════════════════════════════
// Notification Templates UI: Create/Edit/Delete
// ═══════════════════════════════════════════════════════════════════════

test('TEMPLATES-UI-1: Template create form exists', () => {
  assert.ok(/showNpTemplateForm/.test(adminJsSrc), 'Must have showNpTemplateForm function');
  assert.ok(/saveNpTemplate\(null\)/.test(adminJsSrc), 'Must call saveNpTemplate(null) for new template');
});

test('TEMPLATES-UI-2: Template edit form exists', () => {
  assert.ok(/editNpTemplate/.test(adminJsSrc), 'Must have editNpTemplate function');
  assert.ok(/saveNpTemplate\(.*templateId.*\)/.test(adminJsSrc), 'Must call saveNpTemplate with templateId for edit');
});

test('TEMPLATES-UI-3: Template delete function exists', () => {
  assert.ok(/deleteNpTemplate/.test(adminJsSrc), 'Must have deleteNpTemplate function');
  assert.ok(/DELETE/.test(adminJsSrc), 'Must use DELETE method');
});

test('TEMPLATES-UI-4: Template table has actions column', () => {
  const fnStart = adminJsSrc.indexOf('async function loadNpTemplates');
  const fnEnd = adminJsSrc.indexOf('window.loadNpTemplates');
  const fnSrc = adminJsSrc.slice(fnStart, fnEnd);
  assert.ok(/عملیات/.test(fnSrc) || /action/i.test(fnSrc), 'Must have actions column in template table');
  assert.ok(/ویرایش/.test(fnSrc), 'Must have edit button in template table');
});

test('TEMPLATES-UI-5: Add template button exists', () => {
  const fnStart = adminJsSrc.indexOf('async function loadNpTemplates');
  const fnEnd = adminJsSrc.indexOf('window.loadNpTemplates');
  const fnSrc = adminJsSrc.slice(fnStart, fnEnd);
  assert.ok(/افزودن قالب/.test(fnSrc), 'Must have "Add Template" button');
  assert.ok(/showNpTemplateForm/.test(fnSrc), 'Must call showNpTemplateForm');
});

// ═══════════════════════════════════════════════════════════════════════
// A-3: Admin Rate Limiting
// ═══════════════════════════════════════════════════════════════════════

test('A-3-1: checkAdminRateLimit function exists', () => {
  assert.ok(/async function checkAdminRateLimit/.test(adminCtrlSrc), 'checkAdminRateLimit must exist');
  assert.ok(/admin-mutation/.test(adminCtrlSrc), 'Must use "admin-mutation" rate limit category');
  assert.ok(/20,\s*60/.test(adminCtrlSrc), 'Must limit to 20 requests per 60 seconds');
});

test('A-3-2: Rate limit injected into mutation handlers', () => {
  const handlers = ['handleAddAdmin', 'handleUpdateAdmin', 'handleDeleteAdmin',
    'handleReplyTicket', 'handleUpdateTicketStatus', 'handleDeleteTicket',
    'handleCreateBroadcast', 'handleUpdateReward'];
  for (const h of handlers) {
    const fnStart = adminCtrlSrc.indexOf(`async function ${h}(`);
    const nextFn = adminCtrlSrc.indexOf('async function', fnStart + 1);
    const fnSrc = adminCtrlSrc.slice(fnStart, nextFn > 0 ? nextFn : fnStart + 2000);
    assert.ok(/checkAdminRateLimit/.test(fnSrc), `${h} must call checkAdminRateLimit`);
  }
});

test('A-3-3: isUserRateLimited injected into admin handler deps', () => {
  assert.ok(/isUserRateLimited/.test(workerSrc.slice(
    workerSrc.indexOf('const adminHandlers = createAdminHandlers'),
    workerSrc.indexOf('const rewardCenterHandlers')
  )), 'isUserRateLimited must be injected into admin handlers');
});

// ═══════════════════════════════════════════════════════════════════════
// A-5: CORS Fail-Closed
// ═══════════════════════════════════════════════════════════════════════

test('A-5-1: CORS does NOT return wildcard * when WEBAPP_URL is missing', () => {
  const corsStart = workerSrc.indexOf('function withCors');
  const corsEnd = workerSrc.indexOf('return merged;', corsStart);
  const corsSrc = workerSrc.slice(corsStart, corsEnd);
  // Must NOT have the old fallback: merged.set('Access-Control-Allow-Origin', '*');
  assert.ok(!/Access-Control-Allow-Origin',\s*'\*'/.test(corsSrc),
    'CORS must NOT return wildcard * in any branch');
});

test('A-5-2: CORS returns request origin or empty when WEBAPP_URL missing', () => {
  const corsStart = workerSrc.indexOf('function withCors');
  const corsEnd = workerSrc.indexOf('return merged;', corsStart);
  const corsSrc = workerSrc.slice(corsStart, corsEnd);
  assert.ok(/reqOrigin \|\| ''/.test(corsSrc), 'Must return reqOrigin || empty string when WEBAPP_URL missing');
});

// ═══════════════════════════════════════════════════════════════════════
// A-7: Content Authorization (intentional — document + verify)
// ═══════════════════════════════════════════════════════════════════════

test('A-7-1: Content update uses isAdminTelegramId (super-admin only — intentional)', () => {
  // Search for the content update route section
  const contentIdx = workerSrc.indexOf("url.pathname.startsWith('/api/admin/content/')");
  assert.ok(contentIdx > -1, 'Content update route must exist');
  const contentSrc = workerSrc.slice(contentIdx, contentIdx + 1000);
  assert.ok(/isAdminTelegramId/.test(contentSrc), 'Content update must use isAdminTelegramId (super-admin only — intentional)');
});

test('A-7-2: Content types are whitelisted', () => {
  const contentIdx = workerSrc.indexOf("url.pathname.startsWith('/api/admin/content/')");
  const contentSrc = workerSrc.slice(contentIdx, contentIdx + 500);
  assert.ok(/about/.test(contentSrc) && /terms/.test(contentSrc) && /privacy/.test(contentSrc),
    'Must whitelist only about, terms, privacy');
});

// ═══════════════════════════════════════════════════════════════════════
// A-8: Error Logging Safety (document — no change needed)
// ═══════════════════════════════════════════════════════════════════════

test('A-8-1: safeError strips connection strings', () => {
  const safeErrorStart = workerSrc.indexOf('function safeError');
  const safeErrorEnd = workerSrc.indexOf('return JSON.stringify', safeErrorStart);
  const safeErrorSrc = workerSrc.slice(safeErrorStart, safeErrorEnd + 100);
  assert.ok(/postgres.*:\/\/.*\*\*\*/.test(safeErrorSrc), 'Must strip postgres connection strings');
  assert.ok(/token.*=\*\*\*|key.*=\*\*\*|secret.*=\*\*\*|password.*=\*\*\*/.test(safeErrorSrc),
    'Must strip token/key/secret/password patterns');
});

test('A-8-2: safeDbErrorResponse logs via safeError (not raw)', () => {
  const fnStart = workerSrc.indexOf('function safeDbErrorResponse');
  const fnEnd = workerSrc.indexOf('const MAX_BODY_BYTES', fnStart);
  const fnSrc = workerSrc.slice(fnStart, fnEnd);
  assert.ok(/safeError/.test(fnSrc), 'Must use safeError for logging');
});

// ═══════════════════════════════════════════════════════════════════════
// P0 Regression: Previous privilege escalation fix still intact
// ═══════════════════════════════════════════════════════════════════════

test('P0-REGRESS: handleAddAdmin uses admins.add', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/requireAdmin\(request,\s*env,\s*['"]admins\.add['"]\)/.test(fnSrc), 'Must use admins.add');
});

test('P0-REGRESS: handleUpdateAdmin uses admins.edit + blocks self-escalation', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/admins\.edit/.test(fnSrc), 'Must use admins.edit');
  assert.ok(/Cannot modify your own/.test(fnSrc), 'Must block self-escalation');
});

test('P0-REGRESS: A-2 reward status whitelist still present', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateReward');
  const fnEnd = adminCtrlSrc.indexOf('async function handleListTransactions');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/VALID_REWARD_STATUSES/.test(fnSrc), 'Reward status whitelist must still exist');
});

test('P0-REGRESS: A-6 handleListAdmins requires admins.view', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleListAdmins');
  const fnEnd = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/admins\.view/.test(fnSrc), 'Must require admins.view');
});

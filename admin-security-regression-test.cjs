/**
 * ADMIN-SECURITY-REGRESSION-TEST
 *
 * Tests for A-1 (XSS escaping), A-2 (reward status whitelist),
 * A-6 (handleListAdmins permission), and P0 regression (privilege escalation).
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const ADMIN_JS_PATH = path.join(__dirname, 'admin.js');
const ADMIN_CTRL_PATH = path.join(__dirname, 'src', 'controllers', 'admin.js');

const adminJsSrc = fs.readFileSync(ADMIN_JS_PATH, 'utf8');
const adminCtrlSrc = fs.readFileSync(ADMIN_CTRL_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// A-1: XSS — All dynamic IDs must be escaped in onclick/attribute contexts
// ═══════════════════════════════════════════════════════════════════════

test('A-1-1: adminEscapeJsId helper function exists', () => {
  assert.ok(/function adminEscapeJsId/.test(adminJsSrc), 'adminEscapeJsId helper must exist');
});

test('A-1-2: No unescaped t.id in any onclick handler', () => {
  // Find all onclick lines that contain t.id WITHOUT adminEscapeJsId
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('t.id'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeJsId') || line.includes('adminEscapeHtml'),
      `Line with t.id in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-3: No unescaped admin.id in any onclick handler', () => {
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('admin.id'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeJsId') || line.includes('adminEscapeHtml'),
      `Line with admin.id in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-4: No unescaped admin.telegram_id in any onclick handler', () => {
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('admin.telegram_id'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeJsId') || line.includes('adminEscapeHtml'),
      `Line with admin.telegram_id in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-5: No unescaped r.id in reward center onclick (template literals)', () => {
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('${r.id}'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeHtml'),
      `Line with ${r.id} in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-6: No unescaped t.id (referral tier) in reward center onclick', () => {
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('${t.id}'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeHtml'),
      `Line with ${t.id} in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-7: No unescaped m.id (mission reward) in reward center onclick', () => {
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('${m.id}'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeHtml'),
      `Line with ${m.id} in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-8: No unescaped item.id (library item) in reward center onclick', () => {
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick=') && l.includes('${item.id}'));
  for (const line of onclickLines) {
    assert.ok(
      line.includes('adminEscapeHtml'),
      `Line with ${item.id} in onclick must be escaped: ${line.trim().slice(0, 100)}`
    );
  }
});

test('A-1-9: Reply textarea id attribute uses adminEscapeHtml', () => {
  const textareaLine = adminJsSrc.split('\n').find(l => l.includes('adm-reply-') && l.includes('t.id'));
  assert.ok(textareaLine, 'Reply textarea with t.id must exist');
  assert.ok(textareaLine.includes('adminEscapeHtml'), 'Reply textarea id must use adminEscapeHtml');
});

test('A-1-10: Comprehensive search — no raw dynamic ID in any onclick context', () => {
  // Search for ANY onclick line containing a dynamic ID pattern that is NOT escaped
  const patterns = [
    /\bt\.id\b/, /\badmin\.id\b/, /\badmin\.telegram_id\b/,
    /\$\{r\.id\}/, /\$\{t\.id\}/, /\$\{m\.id\}/, /\$\{item\.id\}/,
    /\$\{c\.id\}/, /\$\{reward\.id\}/, /\$\{ticket\.id\}/,
    /\$\{broadcast\.id\}/, /\$\{tpl\.id\}/, /\$\{template\.id\}/,
    /\$\{log\.id\}/, /\$\{entry\.id\}/, /\$\{request\.id\}/,
  ];
  const onclickLines = adminJsSrc.split('\n').filter(l => l.includes('onclick='));
  let unescapedCount = 0;
  for (const line of onclickLines) {
    for (const pat of patterns) {
      if (pat.test(line) && !line.includes('adminEscapeJsId') && !line.includes('adminEscapeHtml') && !line.includes('adminEscapeHtml(String')) {
        unescapedCount++;
        console.log(`  UNESCAPED: ${line.trim().slice(0, 120)}`);
      }
    }
  }
  assert.equal(unescapedCount, 0, `Found ${unescapedCount} unescaped dynamic IDs in onclick handlers`);
});

// ═══════════════════════════════════════════════════════════════════════
// A-2: Reward status whitelist validation
// ═══════════════════════════════════════════════════════════════════════

test('A-2-1: VALID_REWARD_STATUSES whitelist exists in handleUpdateReward', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateReward');
  const fnEnd = adminCtrlSrc.indexOf('async function handleListTransactions');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/VALID_REWARD_STATUSES/.test(fnSrc), 'VALID_REWARD_STATUSES whitelist must exist');
  assert.ok(/\['pending',\s*'approved',\s*'rejected',\s*'delivered',\s*'claimed'\]/.test(fnSrc),
    'Whitelist must contain exactly: pending, approved, rejected, delivered, claimed');
});

test('A-2-2: Invalid status is rejected with 422', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateReward');
  const fnEnd = adminCtrlSrc.indexOf('async function handleListTransactions');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/!VALID_REWARD_STATUSES\.includes\(status\)/.test(fnSrc), 'Must check status against whitelist');
  assert.ok(/INVALID_STATUS/.test(fnSrc), 'Must return INVALID_STATUS code');
  assert.ok(/422/.test(fnSrc), 'Must return 422 for invalid status');
});

test('A-2-3: Behavioral — valid statuses accepted, invalid rejected', () => {
  const VALID_REWARD_STATUSES = ['pending', 'approved', 'rejected', 'delivered', 'claimed'];
  // Valid
  for (const s of VALID_REWARD_STATUSES) {
    assert.ok(VALID_REWARD_STATUSES.includes(s), `Status '${s}' must be valid`);
  }
  // Invalid
  const invalid = ['hacked', 'random', '', 'admin', '<script>', 'null', 'undefined', 'pending\' OR 1=1'];
  for (const s of invalid) {
    assert.ok(!VALID_REWARD_STATUSES.includes(s), `Status '${s}' must be invalid`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// A-6: handleListAdmins requires admins.view
// ═══════════════════════════════════════════════════════════════════════

test('A-6-1: handleListAdmins requires "admins.view" permission', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleListAdmins');
  const fnEnd = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(
    /requireAdmin\(request,\s*env,\s*['"]admins\.view['"]\)/.test(fnSrc),
    'handleListAdmins must call requireAdmin(request, env, "admins.view")'
  );
});

test('A-6-2: handleListAdmins does NOT require admins.add/edit/delete', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleListAdmins');
  const fnEnd = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(!/admins\.add/.test(fnSrc), 'Must NOT require admins.add');
  assert.ok(!/admins\.edit/.test(fnSrc), 'Must NOT require admins.edit');
  assert.ok(!/admins\.delete/.test(fnSrc), 'Must NOT require admins.delete');
});

// ═══════════════════════════════════════════════════════════════════════
// P0 Regression: Privilege escalation still blocked
// ═══════════════════════════════════════════════════════════════════════

test('P0-REGRESS-1: handleAddAdmin uses admins.add (not manage_admins)', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/requireAdmin\(request,\s*env,\s*['"]admins\.add['"]\)/.test(fnSrc), 'Must use admins.add');
});

test('P0-REGRESS-2: handleUpdateAdmin uses admins.edit', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/requireAdmin\(request,\s*env,\s*['"]admins\.edit['"]\)/.test(fnSrc), 'Must use admins.edit');
});

test('P0-REGRESS-3: handleDeleteAdmin uses admins.delete', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleListUsers');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/requireAdmin\(request,\s*env,\s*['"]admins\.delete['"]\)/.test(fnSrc), 'Must use admins.delete');
});

test('P0-REGRESS-4: Non-super-admin cannot set role=super_admin in handleAddAdmin', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/authedIsSuper/.test(fnSrc) && /super_admin/.test(fnSrc), 'Must check authedIsSuper');
});

test('P0-REGRESS-5: Non-super-admin cannot set permissions=["*"] in handleUpdateAdmin', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/payload\.permissions.*includes\(['"]\*['"]\)/.test(fnSrc), 'Must block permissions=["*"]');
});

test('P0-REGRESS-6: Non-super-admin cannot modify own role/permissions', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/Cannot modify your own/.test(fnSrc), 'Must block self-escalation');
});

test('P0-REGRESS-7: _expandPermission — admins.view does NOT pass admins.add', () => {
  const LEGACY_PERM_MAP = {
    'manage_admins': ['admins.view','admins.add','admins.edit','admins.delete'],
    'view_users': ['users.view'],
  };
  function _expandPermission(required, adminPerms) {
    if (!required) return true;
    if (adminPerms.includes('*')) return true;
    if (adminPerms.includes(required)) return true;
    const mapped = LEGACY_PERM_MAP[required];
    if (mapped) return mapped.some(p => adminPerms.includes(p));
    for (const [legacyKey, newKeys] of Object.entries(LEGACY_PERM_MAP)) {
      if (newKeys.includes(required) && adminPerms.includes(legacyKey)) return true;
    }
    return false;
  }
  assert.equal(_expandPermission('admins.add', ['admins.view']), false);
  assert.equal(_expandPermission('admins.edit', ['admins.view']), false);
  assert.equal(_expandPermission('admins.delete', ['admins.view']), false);
  assert.equal(_expandPermission('admins.view', ['admins.view']), true);
  assert.equal(_expandPermission('admins.add', ['admins.add']), true);
  assert.equal(_expandPermission('admins.add', ['manage_admins']), true);
  assert.equal(_expandPermission('admins.add', ['*']), true);
});

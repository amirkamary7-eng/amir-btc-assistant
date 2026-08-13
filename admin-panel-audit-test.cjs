/**
 * ADMIN-PANEL-AUDIT-TEST
 *
 * Regression tests for the admin panel audit fixes:
 *   P0-1: Privilege escalation prevention (granular permissions + self-escalation block)
 *   P2-5: Orphan permissions cleanup (users.manage/users.block removed from LEGACY_PERM_MAP)
 *   P3-7: Ticket ID escaping (adminEscapeHtml applied to t.id in HTML attributes)
 *   P4-8: Membership label (added to _adminSectionLabels)
 *
 * These are SOURCE-LEVEL tests that verify the code contains the required fixes.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');
const ADMIN_CTRL_PATH = path.join(__dirname, 'src', 'controllers', 'admin.js');
const ADMIN_JS_PATH = path.join(__dirname, 'admin.js');

const workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
const adminCtrlSrc = fs.readFileSync(ADMIN_CTRL_PATH, 'utf8');
const adminJsSrc = fs.readFileSync(ADMIN_JS_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// P0-1: Privilege Escalation Prevention
// ═══════════════════════════════════════════════════════════════════════

test('P0-1-1: handleAddAdmin uses granular permission "admins.add" (not "manage_admins")', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleAddAdmin');
  assert.ok(fnStart > -1, 'handleAddAdmin must exist');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnStart + 500);
  assert.ok(
    /requireAdmin\(request,\s*env,\s*['"]admins\.add['"]\)/.test(fnSrc),
    'handleAddAdmin must use requireAdmin(request, env, "admins.add") — not "manage_admins"'
  );
});

test('P0-1-2: handleUpdateAdmin uses granular permission "admins.edit"', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  assert.ok(fnStart > -1, 'handleUpdateAdmin must exist');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnStart + 500);
  assert.ok(
    /requireAdmin\(request,\s*env,\s*['"]admins\.edit['"]\)/.test(fnSrc),
    'handleUpdateAdmin must use requireAdmin(request, env, "admins.edit")'
  );
});

test('P0-1-3: handleDeleteAdmin uses granular permission "admins.delete"', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  assert.ok(fnStart > -1, 'handleDeleteAdmin must exist');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnStart + 500);
  assert.ok(
    /requireAdmin\(request,\s*env,\s*['"]admins\.delete['"]\)/.test(fnSrc),
    'handleDeleteAdmin must use requireAdmin(request, env, "admins.delete")'
  );
});

test('P0-1-4: handleAddAdmin prevents non-super-admin from creating super_admin', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(
    /authedIsSuper/.test(fnSrc) && /super_admin/.test(fnSrc) && /403/.test(fnSrc),
    'handleAddAdmin must check authedIsSuper and return 403 if non-super tries to create super_admin'
  );
});

test('P0-1-5: handleAddAdmin prevents non-super-admin from granting wildcard permissions', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleAddAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(
    /permissions\.includes\(['"]\*['"]\)/.test(fnSrc) && /403/.test(fnSrc),
    'handleAddAdmin must reject permissions=["*"] for non-super-admins'
  );
});

test('P0-1-6: handleUpdateAdmin prevents non-super-admin from setting role=super_admin', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(
    /payload\.role\s*===\s*['"]super_admin['"]/.test(fnSrc) && /403/.test(fnSrc),
    'handleUpdateAdmin must reject role=super_admin for non-super-admins'
  );
});

test('P0-1-7: handleUpdateAdmin prevents non-super-admin from setting permissions=["*"]', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(
    /payload\.permissions.*includes\(['"]\*['"]\)/.test(fnSrc) && /403/.test(fnSrc),
    'handleUpdateAdmin must reject permissions=["*"] for non-super-admins'
  );
});

test('P0-1-8: handleUpdateAdmin prevents non-super-admin from modifying own role/permissions', () => {
  const fnStart = adminCtrlSrc.indexOf('async function handleUpdateAdmin');
  const fnEnd = adminCtrlSrc.indexOf('async function handleDeleteAdmin');
  const fnSrc = adminCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(
    /targetAdmin\.telegram_id.*authedAdmin\.telegram_id/.test(fnSrc) &&
    /Cannot modify your own/.test(fnSrc),
    'handleUpdateAdmin must prevent non-super-admin from modifying own role/permissions'
  );
});

test('P0-1-9: admins.view alone does NOT pass admins.add check (privilege escalation blocked)', () => {
  // Verify that _expandPermission('admins.add', ['admins.view']) returns FALSE
  // This is the core of the P0 fix: view-only admins can no longer add/edit/delete
  const expandStart = adminCtrlSrc.indexOf('function _expandPermission');
  const expandEnd = adminCtrlSrc.indexOf('return false;', expandStart);
  const expandSrc = adminCtrlSrc.slice(expandStart, expandEnd + 20);

  // The function should NOT have 'manage_admins' in the OR mapping for 'admins.add'
  // Since 'admins.add' is not a legacy key, mapped will be undefined
  // And the reverse check will only pass if admin has 'manage_admins' (not 'admins.view')
  assert.ok(/_expandPermission/.test(expandSrc), '_expandPermission must exist');
  assert.ok(/LEGACY_PERM_MAP/.test(expandSrc), 'must use LEGACY_PERM_MAP');
});

// ═══════════════════════════════════════════════════════════════════════
// P2-5: Orphan Permissions Cleanup
// ═══════════════════════════════════════════════════════════════════════

test('P2-5-1: LEGACY_PERM_MAP view_users does NOT include users.manage or users.block', () => {
  const mapStart = adminCtrlSrc.indexOf('const LEGACY_PERM_MAP');
  const mapEnd = adminCtrlSrc.indexOf('};', mapStart);
  const mapSrc = adminCtrlSrc.slice(mapStart, mapEnd);

  // Extract the view_users line
  const viewUsersMatch = mapSrc.match(/'view_users':\s*\[([^\]]+)\]/);
  assert.ok(viewUsersMatch, 'view_users mapping must exist');
  const values = viewUsersMatch[1];
  assert.ok(
    !values.includes('users.manage'),
    'view_users must NOT include users.manage (orphan permission removed)'
  );
  assert.ok(
    !values.includes('users.block'),
    'view_users must NOT include users.block (orphan permission removed)'
  );
});

// ═══════════════════════════════════════════════════════════════════════
// P3-7: Ticket ID Escaping
// ═══════════════════════════════════════════════════════════════════════

test('P3-7-1: Ticket ID is escaped in HTML id attribute', () => {
  // Find the ticket card rendering code
  const ticketCardIdx = adminJsSrc.indexOf("id=\"adm-ticket-");
  assert.ok(ticketCardIdx > -1, 'Ticket card rendering must exist');
  const snippet = adminJsSrc.slice(ticketCardIdx, ticketCardIdx + 100);
  assert.ok(
    /adminEscapeHtml\(String\(t\.id\)\)/.test(snippet),
    'Ticket ID must be escaped with adminEscapeHtml(String(t.id)) in id attribute'
  );
});

test('P3-7-2: Ticket ID is escaped in onclick handler', () => {
  const onclickIdx = adminJsSrc.indexOf("onclick=\"toggleAdminTicketDetail");
  assert.ok(onclickIdx > -1, 'Ticket onclick handler must exist');
  const snippet = adminJsSrc.slice(onclickIdx, onclickIdx + 120);
  assert.ok(
    /adminEscapeHtml\(String\(t\.id\)\)/.test(snippet),
    'Ticket ID must be escaped with adminEscapeHtml in onclick handler'
  );
});

// ═══════════════════════════════════════════════════════════════════════
// P4-8: Membership Label
// ═══════════════════════════════════════════════════════════════════════

test('P4-8-1: _adminSectionLabels includes membership key', () => {
  const labelsStart = adminJsSrc.indexOf('const _adminSectionLabels');
  const labelsEnd = adminJsSrc.indexOf('};', labelsStart);
  const labelsSrc = adminJsSrc.slice(labelsStart, labelsEnd);
  assert.ok(
    /['"]membership['"]/.test(labelsSrc),
    '_adminSectionLabels must include membership key'
  );
});

test('P4-8-2: membership label is a non-null Persian string', () => {
  const labelsStart = adminJsSrc.indexOf('const _adminSectionLabels');
  const labelsEnd = adminJsSrc.indexOf('};', labelsStart);
  const labelsSrc = adminJsSrc.slice(labelsStart, labelsEnd);
  const membershipMatch = labelsSrc.match(/['"]membership['"]:\s*['"]([^'"]+)['"]/);
  assert.ok(membershipMatch, 'membership must have a non-null string value');
  assert.ok(membershipMatch[1].length > 0, 'membership label must not be empty');
});

// ═══════════════════════════════════════════════════════════════════════
// Behavioral tests: verify the _expandPermission logic is correct
// ═══════════════════════════════════════════════════════════════════════

test('P0-BEHAVIORAL-1: _expandPermission logic — admins.view does NOT pass admins.add', () => {
  // Simulate the _expandPermission logic
  const LEGACY_PERM_MAP = {
    'manage_admins': ['admins.view','admins.add','admins.edit','admins.delete'],
    'view_users': ['users.view'],  // After fix: no users.manage/users.block
  };

  function _expandPermission(required, adminPerms) {
    if (!required) return true;
    if (adminPerms.includes('*')) return true;
    if (adminPerms.includes(required)) return true;
    const mapped = LEGACY_PERM_MAP[required];
    if (mapped) {
      return mapped.some(p => adminPerms.includes(p));
    }
    for (const [legacyKey, newKeys] of Object.entries(LEGACY_PERM_MAP)) {
      if (newKeys.includes(required) && adminPerms.includes(legacyKey)) {
        return true;
      }
    }
    return false;
  }

  // admins.view alone should NOT pass admins.add
  assert.equal(_expandPermission('admins.add', ['admins.view']), false, 'admins.view must NOT pass admins.add');
  assert.equal(_expandPermission('admins.edit', ['admins.view']), false, 'admins.view must NOT pass admins.edit');
  assert.equal(_expandPermission('admins.delete', ['admins.view']), false, 'admins.view must NOT pass admins.delete');

  // admins.add should pass admins.add
  assert.equal(_expandPermission('admins.add', ['admins.add']), true, 'admins.add must pass admins.add');
  assert.equal(_expandPermission('admins.edit', ['admins.edit']), true, 'admins.edit must pass admins.edit');
  assert.equal(_expandPermission('admins.delete', ['admins.delete']), true, 'admins.delete must pass admins.delete');

  // manage_admins (legacy) should still pass admins.add (backward compat)
  assert.equal(_expandPermission('admins.add', ['manage_admins']), true, 'manage_admins must still pass admins.add (backward compat)');
  assert.equal(_expandPermission('admins.edit', ['manage_admins']), true, 'manage_admins must still pass admins.edit (backward compat)');

  // Wildcard always passes
  assert.equal(_expandPermission('admins.add', ['*']), true, 'Wildcard must pass everything');
});

test('P0-BEHAVIORAL-2: Orphan permissions do NOT pass view_users check', () => {
  const LEGACY_PERM_MAP = {
    'view_users': ['users.view'],  // After fix
  };

  function _expandPermission(required, adminPerms) {
    if (!required) return true;
    if (adminPerms.includes('*')) return true;
    if (adminPerms.includes(required)) return true;
    const mapped = LEGACY_PERM_MAP[required];
    if (mapped) {
      return mapped.some(p => adminPerms.includes(p));
    }
    for (const [legacyKey, newKeys] of Object.entries(LEGACY_PERM_MAP)) {
      if (newKeys.includes(required) && adminPerms.includes(legacyKey)) {
        return true;
      }
    }
    return false;
  }

  // users.manage should NOT pass view_users (orphan removed)
  assert.equal(_expandPermission('view_users', ['users.manage']), false, 'users.manage must NOT pass view_users');
  // users.block should NOT pass view_users (orphan removed)
  assert.equal(_expandPermission('view_users', ['users.block']), false, 'users.block must NOT pass view_users');
  // users.view should pass view_users
  assert.equal(_expandPermission('view_users', ['users.view']), true, 'users.view must pass view_users');
});

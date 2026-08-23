/**
 * WALLET-SYSTEM-REGRESSION-TEST
 *
 * Tests for P0 (mission loading gate), P1 (marketplace UI),
 * and rate limiting on wallet endpoints.
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const APP_JS_PATH = path.join(__dirname, 'app.js');
const WALLET_JS_PATH = path.join(__dirname, 'wallet.js');
const WALLET_CTRL_PATH = path.join(__dirname, 'src', 'controllers', 'wallet.js');
const WORKER_PATH = path.join(__dirname, 'worker-proxy.js');

const appJsSrc = fs.readFileSync(APP_JS_PATH, 'utf8');
const walletJsSrc = fs.readFileSync(WALLET_JS_PATH, 'utf8');
const walletCtrlSrc = fs.readFileSync(WALLET_CTRL_PATH, 'utf8');
const workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');

// ═══════════════════════════════════════════════════════════════════════
// P0: Mission loading not gated on _joinLockShown
// ═══════════════════════════════════════════════════════════════════════

test('P0-1: Mission loading NOT gated on _joinLockShown', () => {
  // Find the block after bootstrapUser().then() that loads missions
  const idx = appJsSrc.indexOf('loadMissionStatus().then');
  assert.ok(idx > -1, 'loadMissionStatus call must exist');
  // Get surrounding context (500 chars before to capture the if condition)
  const before = appJsSrc.slice(Math.max(0, idx - 500), idx);
  assert.ok(!/_joinLockShown/.test(before), 'Mission loading must NOT be gated on _joinLockShown');
});

test('P0-2: Mission loading runs for members (not just non-members)', () => {
  // The old code had: if (_joinLockShown && !_maintenanceBlocked)
  // _joinLockShown is FALSE for members → missions never loaded
  // The fix should have: if (!_maintenanceBlocked)
  // Search for the P0 FIX comment which is right after the if condition
  const fixIdx = appJsSrc.indexOf('P0 FIX: Mission loading was gated on _joinLockShown');
  assert.ok(fixIdx > -1, 'P0 FIX comment must exist');
  const before = appJsSrc.slice(Math.max(0, fixIdx - 100), fixIdx);
  assert.ok(/!_maintenanceBlocked/.test(before), 'Must check !_maintenanceBlocked');
  assert.ok(!/_joinLockShown\s*&&/.test(before), 'Must NOT have _joinLockShown && condition');
});

// ═══════════════════════════════════════════════════════════════════════
// P1: Marketplace "available" → "coming_soon"
// ═══════════════════════════════════════════════════════════════════════

test('P1-1: Marketplace cards do NOT show "available" status', () => {
  // No card should have status-available class
  const cards = walletJsSrc.split('wallet-marketplace-card');
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i].split('</div>\n          </div>')[0];
    assert.ok(!/status-available/.test(card), `Marketplace card ${i} must NOT have status-available class`);
  }
});

test('P1-2: All marketplace cards show "coming_soon" or "locked"', () => {
  // All cards should have status-coming or status-locked
  const cards = walletJsSrc.split('wallet-marketplace-card');
  for (let i = 1; i < cards.length; i++) {
    const card = cards[i].split('</div>\n          </div>')[0];
    assert.ok(/status-coming|status-locked/.test(card), `Marketplace card ${i} must have status-coming or status-locked`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// Rate Limiting on wallet endpoints
// ═══════════════════════════════════════════════════════════════════════

test('RATE-1: checkWalletRateLimit function exists in wallet controller', () => {
  assert.ok(/async function checkWalletRateLimit/.test(walletCtrlSrc), 'checkWalletRateLimit must exist');
});

test('RATE-2: handleClaimDaily has rate limiting', () => {
  const fnStart = walletCtrlSrc.indexOf('async function handleClaimDaily');
  const fnEnd = walletCtrlSrc.indexOf('async function handleMissionIssueToken');
  const fnSrc = walletCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/checkWalletRateLimit/.test(fnSrc), 'handleClaimDaily must call checkWalletRateLimit');
  assert.ok(/wallet_claim/.test(fnSrc), 'Must use wallet_claim rate limit category');
  assert.ok(/5,\s*60/.test(fnSrc), 'Must limit to 5 requests per 60 seconds');
});

test('RATE-3: handleMissionIssueToken has rate limiting', () => {
  const fnStart = walletCtrlSrc.indexOf('async function handleMissionIssueToken');
  const fnEnd = walletCtrlSrc.indexOf('async function handleMissionComplete');
  const fnSrc = walletCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/checkWalletRateLimit/.test(fnSrc), 'handleMissionIssueToken must call checkWalletRateLimit');
  assert.ok(/wallet_mission_token/.test(fnSrc), 'Must use wallet_mission_token rate limit category');
});

test('RATE-4: handleMissionComplete has rate limiting', () => {
  const fnStart = walletCtrlSrc.indexOf('async function handleMissionComplete');
  const fnEnd = walletCtrlSrc.indexOf('async function handleGetMissions');
  const fnSrc = walletCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/checkWalletRateLimit/.test(fnSrc), 'handleMissionComplete must call checkWalletRateLimit');
  assert.ok(/wallet_mission_complete/.test(fnSrc), 'Must use wallet_mission_complete rate limit category');
});

test('RATE-5: isUserRateLimited injected into wallet handler deps', () => {
  const idx = workerSrc.indexOf('const walletHandlers = createWalletHandlers');
  const fnSrc = workerSrc.slice(idx, idx + 500);
  assert.ok(/isUserRateLimited/.test(fnSrc), 'isUserRateLimited must be injected into wallet handlers');
});

// ═══════════════════════════════════════════════════════════════════════════
// P2: Reverse Transaction — REMOVED as dead code (M6 deletion)
// ═══════════════════════════════════════════════════════════════════════════
// M6 audit (fix/wallet-m6-delete): 0 production callers, 0 routes, 0 dynamic
// references, 0 production reversals across the entire git history; latent
// bugs LB1-LB4 (double-reverse double-deduction, cross-user amount injection,
// unguarded negative balance, no reversal history row) made keeping the dead
// writer a liability. Read-side 'reversed' status handling is intentionally
// kept and functional.

test('P2-1: reverseTransaction is REMOVED from the codebase (M6 dead-code deletion)', () => {
  // The function must be gone from the repo AND the economy service wrapper
  for (const rel of ['src/repositories/wallet.js', 'src/services/economy.js']) {
    const src = fs.readFileSync(path.join(__dirname, rel), 'utf8');
    assert.ok(!/async function reverseTransaction/.test(src),
      rel + ' must not define reverseTransaction (dead code removed - M6)');
    // Outside the removal tombstone comment, no references may remain
    const withoutTombstone = src.replace(/\/\*[\s\S]*?\*\//g, '').replace(/\/\/[^\n]*/g, '');
    assert.ok(!/reverseTransaction/.test(withoutTombstone),
      rel + ' must not reference reverseTransaction outside comments');
  }
});

test('P2-2: NO reversal route/API is exposed anywhere in the Worker', () => {
  const workerSrc = fs.readFileSync(WORKER_PATH, 'utf8');
  // No reversal path segment in ANY registered route
  assert.ok(!/\/api\/[a-z-]+\/?[a-z-]*revers/i.test(workerSrc),
    'no API route may contain a reversal path segment');
  // No reversal handler dispatch
  assert.ok(!/handleReverse\w*/.test(workerSrc),
    'no reversal handler may be dispatched');
  // The economy service must not expose a reversal entry point anymore
  const ecoSrc = fs.readFileSync(path.join(__dirname, 'src', 'services', 'economy.js'), 'utf8');
  assert.ok(!/reverseTransaction/.test(ecoSrc),
    'economy service must not expose reverseTransaction');
});

// ═══════════════════════════════════════════════════════════════════════
// Regression: Previous fixes still intact
// ═══════════════════════════════════════════════════════════════════════

test('REGRESS-1: Mission event_token system still intact (issue-token endpoint exists)', () => {
  const fnStart = walletCtrlSrc.indexOf('async function handleMissionIssueToken');
  assert.ok(fnStart > -1, 'handleMissionIssueToken must still exist');
});

test('REGRESS-2: Mission complete still requires event_token for non-daily_login', () => {
  const fnStart = walletCtrlSrc.indexOf('async function handleMissionComplete');
  const fnEnd = walletCtrlSrc.indexOf('async function handleGetMissions');
  const fnSrc = walletCtrlSrc.slice(fnStart, fnEnd);
  assert.ok(/event_token/.test(fnSrc), 'Mission complete must still require event_token');
  assert.ok(/MISSING_EVENT_TOKEN/.test(fnSrc), 'Must still return MISSING_EVENT_TOKEN error');
});

test('REGRESS-3: creditTokens UPSERT fix (WALLET-001) still intact', () => {
  const walletRepoSrc = fs.readFileSync(path.join(__dirname, 'src/repositories/wallet.js'), 'utf8');
  assert.ok(/balance_upsert/.test(walletRepoSrc), 'balance_upsert CTE must still exist');
  assert.ok(/ON CONFLICT.*DO UPDATE/.test(walletRepoSrc), 'UPSERT ON CONFLICT DO UPDATE must still exist');
});

test('REGRESS-4: Wheel reward type mapping still intact', () => {
  const wheelCtrlSrc = fs.readFileSync(path.join(__dirname, 'src/controllers/wheel.js'), 'utf8');
  assert.ok(/rewardType:\s*['"]wheel_reward['"]/.test(wheelCtrlSrc), 'Wheel reward type must still be mapped to wheel_reward');
});

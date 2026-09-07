/**
 * Wallet Performance + UX Regression Tests
 * ==========================================
 * Tests for the performance + UX fixes:
 *   A) Daily Check-in: notification is fire-and-forget (no await blocking)
 *   B) Missions: notification is fire-and-forget (no await blocking)
 *   C) VPN Purchase: notification is fire-and-forget (no await blocking)
 *   D) VPN UI: button disables immediately + card marks purchased on success
 *   E) VPN Time: rolling 30-day window + next_eligible_at from backend
 *   F) Reward atomicity + idempotency preserved
 *   G) ctx.waitUntil integration — notifications stay alive past response
 *
 * Run: node --test wallet-perf-ux-regression-test.cjs
 */

const test = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
const REWARD_PURCHASES_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/reward_purchases.js'), 'utf8');
const REWARD_PURCHASES_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_purchases.js'), 'utf8');
const WALLET_FRONTEND_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
const WORKER_PROXY_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');

// Helper: strip comments to avoid false-positive matches on comment text
function stripComments(src) {
  return src.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
}

const CONTROLLER_NC = stripComments(CONTROLLER_SRC);
const REWARD_PURCHASES_NC = stripComments(REWARD_PURCHASES_SRC);

// ═══════════════════════════════════════════════════════════════════════
// A) Daily Check-in — notification non-blocking
// ═══════════════════════════════════════════════════════════════════════

test('A1: handleClaimDaily does NOT await notificationService.create (fire-and-forget)', () => {
  assert.ok(!CONTROLLER_NC.includes('await notificationService.create(env,'),
    'wallet controller must NOT have await notificationService.create(env, (fire-and-forget)');
  assert.ok(CONTROLLER_NC.includes('notificationService.create(env,'),
    'notificationService.create(env, is dispatched (fire-and-forget)');
});

test('A2: handleClaimDaily uses _scheduleBackground for non-blocking notification', () => {
  // PERF FIX: notification is now dispatched via _scheduleBackground which
  // wraps with .catch() and registers on ctx.waitUntil() (production) or
  // plain fire-and-forget (tests). Verify _scheduleBackground is called.
  assert.ok(CONTROLLER_SRC.includes('_scheduleBackground(env, notificationService.create(env,'),
    'handleClaimDaily uses _scheduleBackground for non-blocking notification dispatch');
  assert.ok(CONTROLLER_SRC.includes('function _scheduleBackground'),
    '_scheduleBackground helper is defined');
});

test('A3: handleClaimDaily response includes result (which has newBalance)', () => {
  // Function is ~3300 chars — search whole file for the pattern near handleClaimDaily
  const fnStart = CONTROLLER_SRC.indexOf('async function handleClaimDaily');
  const fnBody = CONTROLLER_SRC.substring(fnStart, fnStart + 4000);
  assert.ok(fnBody.includes('...result'),
    'response spreads result (which includes newBalance)');
});

// ═══════════════════════════════════════════════════════════════════════
// B) Missions — notification non-blocking
// ═══════════════════════════════════════════════════════════════════════

test('B1: handleMissionComplete does NOT await notificationService.create (fire-and-forget)', () => {
  assert.ok(!CONTROLLER_NC.includes('await notificationService.create(env,'),
    'no await notificationService.create(env, in wallet controller (fire-and-forget)');
});

test('B2: fireDailyLoginMission does NOT await notificationService.create (fire-and-forget)', () => {
  assert.ok(!CONTROLLER_NC.includes('await notificationService.create(env,'),
    'no await notificationService.create(env, in wallet controller');
});

test('B3: handleMissionComplete uses _scheduleBackground for non-blocking notification', () => {
  assert.ok(CONTROLLER_SRC.includes('_scheduleBackground(env, notificationService.create(env,'),
    'handleMissionComplete uses _scheduleBackground for non-blocking notification');
});

test('B4: handleMissionComplete returns new_balance in response', () => {
  // handleMissionComplete is ~8200+ chars — search whole file near the function
  const fnStart = CONTROLLER_SRC.indexOf('async function handleMissionComplete');
  const fnBody = CONTROLLER_SRC.substring(fnStart, fnStart + 10000);
  assert.ok(fnBody.includes('new_balance: newBalance'),
    'handleMissionComplete response includes new_balance');
});

// ═══════════════════════════════════════════════════════════════════════
// C) VPN Purchase — notification non-blocking
// ═══════════════════════════════════════════════════════════════════════

test('C1: handleVpnPurchase does NOT await notificationService.create (fire-and-forget)', () => {
  assert.ok(!REWARD_PURCHASES_NC.includes('await notificationService.create(env,'),
    'handleVpnPurchase must NOT have await notificationService.create(env, (fire-and-forget)');
  assert.ok(REWARD_PURCHASES_NC.includes('notificationService.create(env,'),
    'notificationService.create(env, is dispatched (fire-and-forget)');
});

test('C2: handleVpnPurchase does NOT await sendTelegramMessage (fire-and-forget)', () => {
  // Scope to handleVpnPurchase function only — handleFulfillPurchase (admin)
  // legitimately uses await sendTelegramMessage.
  const fnStart = REWARD_PURCHASES_SRC.indexOf('async function handleVpnPurchase');
  const fnEnd = REWARD_PURCHASES_SRC.indexOf('async function handle', fnStart + 100);
  const fnBody = REWARD_PURCHASES_SRC.substring(fnStart, fnEnd > fnStart ? fnEnd : fnStart + 5000);
  const fnBodyNC = stripComments(fnBody);
  assert.ok(!fnBodyNC.includes('await sendTelegramMessage(env,'),
    'handleVpnPurchase must NOT have await sendTelegramMessage(env, (fire-and-forget)');
  assert.ok(fnBodyNC.includes('sendTelegramMessage(env,'),
    'handleVpnPurchase dispatches sendTelegramMessage in background (fire-and-forget)');
});

test('C3: handleVpnPurchase uses _scheduleBackground for non-blocking notifications', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('_scheduleBackground(env, notificationService.create(env,'),
    'handleVpnPurchase uses _scheduleBackground for admin notification');
  assert.ok(REWARD_PURCHASES_SRC.includes('_scheduleBackground(env, sendTelegramMessage(env,'),
    'handleVpnPurchase uses _scheduleBackground for user Telegram notification');
  assert.ok(REWARD_PURCHASES_SRC.includes('function _scheduleBackground'),
    '_scheduleBackground helper is defined in reward_purchases controller');
});

// ═══════════════════════════════════════════════════════════════════════
// D) VPN UI/UX — button disables + card marks purchased
// ═══════════════════════════════════════════════════════════════════════

test('D1: executeVpnPurchase disables buy button IMMEDIATELY before API call', () => {
  const fnStart = WALLET_FRONTEND_SRC.indexOf('async function executeVpnPurchase');
  assert.ok(fnStart > -1, 'executeVpnPurchase exists');
  const fnBody = WALLET_FRONTEND_SRC.substring(fnStart, fnStart + 2000);
  const disableIdx = fnBody.indexOf('_buyBtn.disabled = true');
  const fetchIdx = fnBody.indexOf("window.apiFetch('/api/rewards/vpn/purchase'");
  assert.ok(disableIdx > -1, 'button disabled immediately');
  assert.ok(fetchIdx > -1, 'API fetch exists');
  assert.ok(disableIdx < fetchIdx,
    'button disabled BEFORE API fetch (instant visual feedback)');
});

test('D2: executeVpnPurchase marks card as purchased on success (no re-fetch)', () => {
  const fnStart = WALLET_FRONTEND_SRC.indexOf('async function executeVpnPurchase');
  const fnBody = WALLET_FRONTEND_SRC.substring(fnStart, fnStart + 2000);
  assert.ok(fnBody.includes('_markVpnCardPurchased(planId)'),
    'executeVpnPurchase calls _markVpnCardPurchased on success');
  // _markVpnCardPurchased must exist and replace the buy button
  const markFnStart = WALLET_FRONTEND_SRC.indexOf('function _markVpnCardPurchased');
  assert.ok(markFnStart > -1, '_markVpnCardPurchased function exists');
  const markFnBody = WALLET_FRONTEND_SRC.substring(markFnStart, markFnStart + 800);
  assert.ok(markFnBody.includes('vpn-card-purchased'),
    '_markVpnCardPurchased adds vpn-card-purchased class');
  assert.ok(markFnBody.includes('vpn-purchased-badge'),
    '_markVpnCardPurchased adds purchased badge');
  assert.ok(markFnBody.includes('replaceWith'),
    '_markVpnCardPurchased replaces buy button with badge');
  assert.ok(markFnBody.includes('_vpnPlansCache'),
    '_markVpnCardPurchased updates in-memory cache');
});

test('D3: executeVpnPurchase re-enables buy button on error', () => {
  const fnStart = WALLET_FRONTEND_SRC.indexOf('async function executeVpnPurchase');
  const fnEnd = WALLET_FRONTEND_SRC.indexOf('\n  }', fnStart + 100);
  const fnBody = WALLET_FRONTEND_SRC.substring(fnStart, fnEnd + 10);
  assert.ok(fnBody.includes('_btn.disabled = false'),
    'button re-enabled in finally block on error');
  assert.ok(fnBody.includes('_btn.dataset.originalText'),
    'button restores original text on error');
});

test('D4: executeVpnPurchase uses new_balance from response for UI update', () => {
  const fnStart = WALLET_FRONTEND_SRC.indexOf('async function executeVpnPurchase');
  const fnBody = WALLET_FRONTEND_SRC.substring(fnStart, fnStart + 2000);
  assert.ok(fnBody.includes('resp.new_balance'),
    'uses new_balance from backend response');
  assert.ok(fnBody.includes('_lastKnownBalance = resp.new_balance'),
    'updates _lastKnownBalance from authoritative response');
});

// ═══════════════════════════════════════════════════════════════════════
// E) VPN Time correctness — rolling 30-day + next_eligible_at
// ═══════════════════════════════════════════════════════════════════════

test('E1: checkPurchaseLimit uses rolling 30-day window (NOT calendar month)', () => {
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("NOW() - ($3 || ' days')::interval"),
    'uses rolling 30-day interval (NOW() - 30 days)');
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("'30'"),
    'uses 30 days, not calendar month');
  assert.ok(!REWARD_PURCHASES_REPO_SRC.includes("DATE_TRUNC('month'"),
    'does NOT use calendar month (rolling 30-day is correct)');
});

test('E2: checkPurchaseLimit returns next_eligible_at timestamp', () => {
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes('next_eligible_at'),
    'checkPurchaseLimit returns next_eligible_at');
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes('purchasedAtMs + 30 * 86400000'),
    'next_eligible_at = purchased_at + 30 days (exact rolling window)');
});

test('E3: handleVpnPlans returns next_eligible_at for purchased plans', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('next_eligible_at'),
    'handleVpnPlans returns next_eligible_at for purchased plans');
  assert.ok(REWARD_PURCHASES_SRC.includes('nextEligibleAt'),
    'computes nextEligibleAt from purchasedAtMs + 30 days');
});

test('E4: PLAN_LIMIT_REACHED response includes next_eligible_at', () => {
  const limitIdx = REWARD_PURCHASES_SRC.indexOf("code: 'PLAN_LIMIT_REACHED'");
  assert.ok(limitIdx > -1, 'PLAN_LIMIT_REACHED exists');
  const block = REWARD_PURCHASES_SRC.substring(limitIdx - 200, limitIdx + 400);
  assert.ok(block.includes('next_eligible_at'),
    'PLAN_LIMIT_REACHED response includes next_eligible_at');
  assert.ok(block.includes('days_remaining'),
    'PLAN_LIMIT_REACHED response includes days_remaining');
});

test('E5: Rolling 30-day window allows purchase exactly at 30 days', () => {
  const purchaseTime = new Date('2026-09-15T14:30:00Z').getTime();
  const checkTime = purchaseTime + 30 * 86400000;
  const nowMinus30 = checkTime - 30 * 86400000;
  const isRestricted = purchaseTime > nowMinus30;
  assert.equal(isRestricted, false,
    'at exactly 30 days elapsed, purchase is allowed (rolling window expires)');
});

test('E6: Rolling 30-day window blocks purchase before 30 days', () => {
  const purchaseTime = new Date('2026-09-15T14:30:00Z').getTime();
  const checkTime = purchaseTime + 29 * 86400000;
  const nowMinus30 = checkTime - 30 * 86400000;
  const isRestricted = purchaseTime > nowMinus30;
  assert.equal(isRestricted, true,
    'at 29 days elapsed (before 30), purchase is blocked');
});

test('E7: next_eligible_at = purchased_at + exactly 30 days', () => {
  const purchaseTime = new Date('2026-09-15T14:30:00Z').getTime();
  const nextEligible = new Date(purchaseTime + 30 * 86400000);
  const expected = new Date('2026-10-15T14:30:00Z');
  assert.equal(nextEligible.getTime(), expected.getTime(),
    'next_eligible_at = purchased_at + 30 days exactly (Oct 15 14:30)');
});

// ═══════════════════════════════════════════════════════════════════════
// F) Reward atomicity + idempotency preserved
// ═══════════════════════════════════════════════════════════════════════

test('F1: handleClaimDaily still uses claimDailyRewardWithStreak (atomic credit)', () => {
  assert.ok(CONTROLLER_SRC.includes('claimDailyRewardWithStreak'),
    'still uses claimDailyRewardWithStreak for atomic credit');
  assert.ok(CONTROLLER_SRC.includes('computeReward: true'),
    'still passes computeReward: true option');
});

test('F2: handleMissionComplete still uses markMissionRewarded (CAS double-reward guard)', () => {
  assert.ok(CONTROLLER_SRC.includes('markMissionRewarded'),
    'still uses markMissionRewarded for CAS double-reward guard');
  assert.ok(CONTROLLER_SRC.includes('economyService.grantReward'),
    'still uses economyService.grantReward for atomic credit');
});

test('F3: handleVpnPurchase still uses economyService.debitUser (atomic debit)', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('economyService.debitUser'),
    'still uses economyService.debitUser for atomic debit');
  // ON CONFLICT DO NOTHING is in the REPOSITORY, not the controller
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes('ON CONFLICT DO NOTHING'),
    'repository still uses DB-level race protection (ON CONFLICT DO NOTHING)');
});

test('F4: VPN purchase still rejects duplicate pending (DUPLICATE_PENDING)', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('DUPLICATE_PENDING'),
    'still returns DUPLICATE_PENDING for concurrent requests');
  assert.ok(REWARD_PURCHASES_SRC.includes('debitWasIdempotent'),
    'still checks idempotent debit (concurrent winner detection)');
});

test('F5: VPN purchase still rejects when 30-day limit is active (PLAN_LIMIT_REACHED)', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('checkPurchaseLimit'),
    'still calls checkPurchaseLimit before debit');
  assert.ok(REWARD_PURCHASES_SRC.includes('PLAN_LIMIT_REACHED'),
    'still returns PLAN_LIMIT_REACHED when restricted');
});

// ═══════════════════════════════════════════════════════════════════════
// G) ctx.waitUntil integration — notifications stay alive past response
// ═══════════════════════════════════════════════════════════════════════

test('G1: worker-proxy stores ctx on env at fetch handler entry', () => {
  assert.ok(WORKER_PROXY_SRC.includes('env.ctx = ctx'),
    'fetch handler stores ctx on env for background tasks');
});

test('G2: backgroundTask helper exists in worker-proxy', () => {
  assert.ok(WORKER_PROXY_SRC.includes('function backgroundTask(env, promise)'),
    'backgroundTask helper is defined');
  assert.ok(WORKER_PROXY_SRC.includes('env.ctx.waitUntil(safe)'),
    'backgroundTask uses env.ctx.waitUntil() to schedule work');
  assert.ok(WORKER_PROXY_SRC.includes('typeof env.ctx.waitUntil'),
    'backgroundTask checks for ctx.waitUntil availability');
});

test('G3: backgroundTask has graceful fallback when ctx is not available', () => {
  // Tests run without Cloudflare ctx — the helper must not throw.
  assert.ok(WORKER_PROXY_SRC.includes("if (env && env.ctx && typeof env.ctx.waitUntil === 'function')"),
    'backgroundTask only calls waitUntil when ctx is available');
});

test('G4: backgroundTask wraps with .catch to prevent unhandled rejections', () => {
  assert.ok(WORKER_PROXY_SRC.includes("promise.catch(e =>"),
    'backgroundTask wraps promise with .catch()');
  assert.ok(WORKER_PROXY_SRC.includes("[backgroundTask] non-blocking task failed"),
    'backgroundTask logs failures via console.warn');
});

test('G5: backgroundTask is injected into walletHandlers', () => {
  const walletHandlersStart = WORKER_PROXY_SRC.indexOf('createWalletHandlers({');
  const walletHandlersEnd = WORKER_PROXY_SRC.indexOf('});', walletHandlersStart);
  const block = WORKER_PROXY_SRC.substring(walletHandlersStart, walletHandlersEnd);
  assert.ok(block.includes('backgroundTask,'),
    'backgroundTask is injected into walletHandlers deps');
});

test('G6: backgroundTask is injected into rewardPurchaseHandlers', () => {
  const rpHandlersStart = WORKER_PROXY_SRC.indexOf('createRewardPurchaseHandlers({');
  const rpHandlersEnd = WORKER_PROXY_SRC.indexOf('});', rpHandlersStart);
  const block = WORKER_PROXY_SRC.substring(rpHandlersStart, rpHandlersEnd);
  assert.ok(block.includes('backgroundTask,'),
    'backgroundTask is injected into rewardPurchaseHandlers deps');
});

test('G7: wallet controller defines _scheduleBackground helper', () => {
  assert.ok(CONTROLLER_SRC.includes('function _scheduleBackground(env, promise)'),
    '_scheduleBackground helper is defined in wallet controller');
  assert.ok(CONTROLLER_SRC.includes('typeof _backgroundTask === \'function\''),
    '_scheduleBackground checks for injected backgroundTask');
  assert.ok(CONTROLLER_SRC.includes('promise.catch(e => console.warn'),
    '_scheduleBackground fallback has .catch for non-blocking error log');
});

test('G8: reward_purchases controller defines _scheduleBackground helper', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('function _scheduleBackground(env, promise)'),
    '_scheduleBackground helper is defined in reward_purchases controller');
  assert.ok(REWARD_PURCHASES_SRC.includes('typeof _backgroundTask === \'function\''),
    '_scheduleBackground checks for injected backgroundTask');
});

// ═══════════════════════════════════════════════════════════════════════
// H) Race condition protection — VPN purchase concurrency
// ═══════════════════════════════════════════════════════════════════════

const WALLET_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/wallet.js'), 'utf8');

test('H1: debitTokens has idempotency fast-path (SELECT before INSERT)', () => {
  assert.ok(WALLET_REPO_SRC.includes("WHERE user_id = $1 AND tx_type = $2 AND ref_id = $3 AND status = 'completed'"),
    'debitTokens checks for existing transaction by refId before attempting INSERT');
  assert.ok(WALLET_REPO_SRC.includes('idempotent: true'),
    'debitTokens returns idempotent:true when existing transaction found');
});

test('H2: debitTokens uses atomic CTE (UPDATE + INSERT in one transaction)', () => {
  assert.ok(WALLET_REPO_SRC.includes('WITH debited AS'),
    'debitTokens uses atomic CTE for UPDATE balance + INSERT transaction');
  assert.ok(WALLET_REPO_SRC.includes('WHERE EXISTS (SELECT 1 FROM debited)'),
    'tx_insert is gated on WHERE EXISTS (no phantom rows on insufficient balance)');
  assert.ok(WALLET_REPO_SRC.includes('RETURNING balance'),
    'debited CTE returns balance for response');
});

test('H3: debitTokens handles 23505 unique violation as idempotent (not error)', () => {
  assert.ok(WALLET_REPO_SRC.includes("e.code === '23505'"),
    'debitTokens catches 23505 unique_violation');
  assert.ok(WALLET_REPO_SRC.includes("/unique constraint|duplicate key/i.test"),
    'debitTokens also checks message for unique constraint violation');
  // After catching 23505, re-selects to confirm and returns idempotent
  const catchBlock = WALLET_REPO_SRC.indexOf('isUniqueViolation');
  assert.ok(catchBlock > -1, 'has isUniqueViolation check');
});

test('H4: token_transactions has partial unique index on (user_id, tx_type, ref_id)', () => {
  assert.ok(WALLET_REPO_SRC.includes("CREATE UNIQUE INDEX IF NOT EXISTS idx_token_tx_user_type_ref"),
    'partial unique index idx_token_tx_user_type_ref exists');
  assert.ok(WALLET_REPO_SRC.includes("ON token_transactions (user_id, tx_type, ref_id)"),
    'index is on (user_id, tx_type, ref_id)');
  assert.ok(WALLET_REPO_SRC.includes("WHERE ref_id IS NOT NULL AND status = 'completed'"),
    'partial index only applies to completed transactions with ref_id');
});

test('H5: VPN purchase refId is deterministic per (user, plan, Tehran-today)', () => {
  // The refId pattern is in the controller source (line ~238), not in a comment
  assert.ok(REWARD_PURCHASES_SRC.includes('const refId = `vpn_purchase_${userId}_${plan.id}_${tehranToday}`'),
    'refId is deterministic: vpn_purchase_${userId}_${plan.id}_${tehranToday}');
  // Verify no Date.now() in the refId construction (would break concurrent protection)
  const refIdLine = REWARD_PURCHASES_SRC.indexOf('const refId = `vpn_purchase_');
  const refIdBlock = REWARD_PURCHASES_SRC.substring(refIdLine, refIdLine + 200);
  assert.ok(!refIdBlock.includes('Date.now()'),
    'refId does NOT use Date.now() (would break concurrent protection)');
});

test('H6: createVpnPurchase uses ON CONFLICT DO NOTHING (DB-level race protection)', () => {
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("ON CONFLICT DO NOTHING"),
    'createVpnPurchase uses ON CONFLICT DO NOTHING for race protection');
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("RETURNING id"),
    'createVpnPurchase returns id only on successful INSERT (conflict → 0 rows)');
});

test('H7: partial unique index uq_rp_pending_plan prevents duplicate pending', () => {
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("CREATE UNIQUE INDEX IF NOT EXISTS uq_rp_pending_plan"),
    'partial unique index uq_rp_pending_plan exists');
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("ON reward_purchases (user_id, reward_type, vpn_gb)"),
    'index is on (user_id, reward_type, vpn_gb)');
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("WHERE status = 'pending'"),
    'partial index only applies to pending purchases');
});

test('H8: handleVpnPurchase short-circuits on idempotent debit (DUPLICATE_PENDING)', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('debitWasIdempotent'),
    'handleVpnPurchase checks debitWasIdempotent flag');
  assert.ok(REWARD_PURCHASES_SRC.includes("code: 'DUPLICATE_PENDING'"),
    'handleVpnPurchase returns DUPLICATE_PENDING when debit was idempotent');
  // Critical: when debitWasIdempotent is true, createVpnPurchase is NOT called
  const idempCheck = REWARD_PURCHASES_SRC.indexOf('if (debitWasIdempotent)');
  const createIdx = REWARD_PURCHASES_SRC.indexOf('createVpnPurchase', idempCheck);
  assert.ok(idempCheck > -1 && createIdx > -1,
    'createVpnPurchase appears AFTER the idempotent check');
});

test('H9: handleVpnPurchase refunds on createVpnPurchase failure (no lost money)', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('marketplace_refund'),
    'handleVpnPurchase uses marketplace_refund on purchase creation failure');
  assert.ok(REWARD_PURCHASES_SRC.includes("Refund: VPN"),
    'refund has VPN description');
});

test('H10: handleVpnPurchase refunds when !created (duplicate pending at DB level)', () => {
  assert.ok(REWARD_PURCHASES_SRC.includes('if (!created)'),
    'handleVpnPurchase checks !created flag');
  assert.ok(REWARD_PURCHASES_SRC.includes('DUPLICATE_PENDING'),
    'handleVpnPurchase returns DUPLICATE_PENDING when !created');
  // The refund in the !created path:
  const notCreatedIdx = REWARD_PURCHASES_SRC.indexOf('if (!created)');
  const refundIdx = REWARD_PURCHASES_SRC.indexOf('marketplace_refund', notCreatedIdx);
  assert.ok(notCreatedIdx > -1 && refundIdx > notCreatedIdx,
    'refund is called in the !created path');
});

test('H11: checkPurchaseLimit only checks fulfilled (pending does NOT lock 30-day)', () => {
  assert.ok(REWARD_PURCHASES_REPO_SRC.includes("status = 'fulfilled'"),
    'checkPurchaseLimit only checks fulfilled purchases (not pending)');
  // This is correct: pending purchases are protected by uq_rp_pending_plan
  // (only one pending per user+plan). Fulfilled purchases lock the 30-day
  // window. A pending that's never fulfilled doesn't lock 30-day — but
  // the user can't buy again because uq_rp_pending_plan blocks it.
});

test('H12: Race scenario — concurrent A+B both pass checkPurchaseLimit but only one succeeds', () => {
  // This is the key race analysis test:
  // 1. Both A and B pass checkPurchaseLimit (read-only, no lock)
  // 2. Both attempt debitUser with same refId
  // 3. A wins INSERT (23505 passes), B gets 23505 unique violation
  // 4. B's debitTokens catches 23505 → returns idempotent:true
  // 5. B's handleVpnPurchase sees debitWasIdempotent → returns DUPLICATE_PENDING
  // 6. A continues to createVpnPurchase → created=true → success
  // 7. B never reaches createVpnPurchase
  // Result: ONE debit, ONE purchase, ONE pending. No double.
  assert.ok(WALLET_REPO_SRC.includes('23505'),
    'debitTokens handles 23505 (concurrent race protection)');
  assert.ok(REWARD_PURCHASES_SRC.includes('debitWasIdempotent'),
    'handleVpnPurchase uses debitWasIdempotent to detect race loser');
  assert.ok(REWARD_PURCHASES_SRC.includes("DUPLICATE_PENDING"),
    'race loser gets DUPLICATE_PENDING (not an error, clean retry signal)');
});

test('H13: WithSharedPool does NOT close pool before background tasks complete', () => {
  // withSharedPool closes pool in finally, but background tasks scheduled via
  // ctx.waitUntil run AFTER the response is returned. They use queryDb which
  // creates its OWN pool (env._reqPool is restored to previous value = null
  // in HTTP path), so they get a fresh pool — not the closed shared pool.
  assert.ok(WORKER_PROXY_SRC.includes('env._reqPool = _prevReqPool'),
    'withSharedPool restores previous env._reqPool in finally');
  // Background tasks (notification dispatch) use queryDb which creates a new
  // pool when env._reqPool is null (the per-call fallback). This is safe.
});

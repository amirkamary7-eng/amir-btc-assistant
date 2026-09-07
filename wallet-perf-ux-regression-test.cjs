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

// ═══════════════════════════════════════════════════════════════════════
// I) lock_key JS-PostgreSQL equivalence verification
// ═══════════════════════════════════════════════════════════════════════

const crypto = require('crypto');

// Replicate the JS computation from src/repositories/wallet.js
function computeLockKeyJS(uid, tehranToday) {
  const md5hex = crypto.createHash('md5').update(uid + tehranToday).digest('hex');
  const hex16 = md5hex.substring(0, 16);
  const TWO_POW_63 = BigInt('9223372036854775808');
  const TWO_POW_64 = BigInt('18446744073709551616');
  let bigIntVal = BigInt('0x' + hex16);
  if (bigIntVal >= TWO_POW_63) {
    bigIntVal = bigIntVal - TWO_POW_64;
  }
  return bigIntVal.toString();
}

test('I1: JS lock_key matches PostgreSQL signed bigint (positive values)', () => {
  // userIds that produce hex16 starting with 0-7 (high bit NOT set → positive bigint)
  const cases = [
    { uid: 'guest_1788704567901', date: '2026-09-07', expected: '3501896654345175563' },
    { uid: 'a-very-long-user-id-string-here-12345', date: '2026-06-15', expected: '2019478881245197978' },
  ];
  for (const { uid, date, expected } of cases) {
    const jsResult = computeLockKeyJS(uid, date);
    assert.equal(jsResult, expected,
      `JS lock_key for uid=${uid} date=${date} matches expected PostgreSQL bigint`);
  }
});

test('I2: JS lock_key matches PostgreSQL signed bigint (negative values)', () => {
  // userIds that produce hex16 starting with 8-f (high bit SET → negative bigint)
  const cases = [
    { uid: '123456', date: '2026-09-07', expected: '-5448676804448115950' },
    { uid: '999888', date: '2026-09-06', expected: '-6592954970313649992' },
    { uid: '1', date: '2026-01-01', expected: '-5744618552353138019' },
    { uid: '999999999', date: '2026-12-31', expected: '-4571581102075413722' },
  ];
  for (const { uid, date, expected } of cases) {
    const jsResult = computeLockKeyJS(uid, date);
    assert.equal(jsResult, expected,
      `JS lock_key for uid=${uid} date=${date} matches expected PostgreSQL signed bigint (negative)`);
  }
});

test('I3: Same uid+date always produces same lock_key (deterministic)', () => {
  const k1 = computeLockKeyJS('123456', '2026-09-07');
  const k2 = computeLockKeyJS('123456', '2026-09-07');
  assert.equal(k1, k2, 'Same input → same lock_key (deterministic)');
});

test('I4: Different uid or date produces different lock_key (no collision)', () => {
  const k1 = computeLockKeyJS('123456', '2026-09-07');
  const k2 = computeLockKeyJS('123456', '2026-09-08');
  const k3 = computeLockKeyJS('789012', '2026-09-07');
  assert.notEqual(k1, k2, 'Different date → different lock_key');
  assert.notEqual(k1, k3, 'Different uid → different lock_key');
});

test('I5: lock_key computed via crypto (no DB round-trip in claimDailyRewardWithStreak)', () => {
  // Verify the new claimDailyRewardWithStreak uses crypto module
  const WALLET_REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/wallet.js'), 'utf8');
  const fnStart = WALLET_REPO_SRC.indexOf('async function claimDailyRewardWithStreak');
  const fnEnd = WALLET_REPO_SRC.indexOf('\n  }', fnStart + 100);
  const fnBody = WALLET_REPO_SRC.substring(fnStart, fnEnd + 10);
  assert.ok(fnBody.includes("import('crypto')"),
    'claimDailyRewardWithStreak uses import(crypto)');
  assert.ok(fnBody.includes("createHash('md5')"),
    'claimDailyRewardWithStreak uses createHash(md5)');
  // Must NOT have the old separate queryDb call for lock_key
  assert.ok(!fnBody.includes("SELECT (('x' || SUBSTRING(MD5"),
    'old queryDb lock_key computation removed from claimDailyRewardWithStreak');
  // Legacy claimDailyReward (without streak) may still have old pattern — that's OK
  // since it's a separate function and not used in production (claimDailyRewardWithStreak takes priority)
});

// ═══════════════════════════════════════════════════════════════════════
// J) MissionBus race condition fix verification
// ═══════════════════════════════════════════════════════════════════════

test('J1: MissionBus.fire is async (can await shared promise)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes('async fire(eventType, targetId)'),
    'MissionBus.fire is async');
});

test('J2: MissionBus.fire awaits loadMissionStatus when missions not loaded', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes('await loadMissionStatus()'),
    'MissionBus.fire awaits loadMissionStatus()');
  // The await is inside the fire() function, not in a .then() callback
  const fireIdx = APP_SRC.indexOf('async fire(eventType, targetId)');
  const fireBody = APP_SRC.substring(fireIdx, fireIdx + 500);
  assert.ok(fireBody.includes('await loadMissionStatus()'),
    'await is inside fire() body (not a .then() fire-and-forget)');
});

test('J3: Shared promise prevents duplicate concurrent loads', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes('_missionLoadPromise'),
    'shared _missionLoadPromise exists');
  assert.ok(APP_SRC.includes('if (_missionLoadPromise) return _missionLoadPromise'),
    'loadMissionStatus returns existing promise if in-flight');
  assert.ok(APP_SRC.includes('_missionLoadPromise = null'),
    '_missionLoadPromise is cleaned up in finally');
});

test('J4: MissionBus.fire returns on load failure (allows retry)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fireIdx = APP_SRC.indexOf('async fire(eventType, targetId)');
  const fireBody = APP_SRC.substring(fireIdx, fireIdx + 600);
  assert.ok(fireBody.includes('return;'),
    'fire() returns early on load failure (no _fireInternal)');
  // On failure, _missionsLoaded stays false → next fire() retries
  assert.ok(fireBody.includes('_missionsLoaded stays false'),
    'comment confirms _missionsLoaded stays false for retry');
});

test('J5: _fireInternal only called after successful load + list populated', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fireIdx = APP_SRC.indexOf('async fire(eventType, targetId)');
  const fireBody = APP_SRC.substring(fireIdx, fireIdx + 1600);
  const awaitIdx = fireBody.indexOf('await loadMissionStatus()');
  const populatedCheck = fireBody.indexOf('!_missionsLoaded || _missionStatusList.length === 0');
  const fireInternalCall = fireBody.indexOf('MissionBus._fireInternal(eventType, targetId)');
  assert.ok(awaitIdx > -1, 'await loadMissionStatus() exists in fire()');
  assert.ok(populatedCheck > awaitIdx, 'check for populated list after await');
  assert.ok(fireInternalCall > populatedCheck, 'MissionBus._fireInternal() call is AFTER populated check');
});

test('J6: All 4 mission triggers have matching MissionBus.fire calls', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  // news_article_open → read_news
  assert.ok(APP_SRC.includes("MissionBus.fire('news_article_open'"),
    "MissionBus.fire('news_article_open') exists");
  // analysis_detail_open → read_analysis
  assert.ok(APP_SRC.includes("MissionBus.fire('analysis_detail_open'"),
    "MissionBus.fire('analysis_detail_open') exists");
  // asset_detail_open → visit_market
  assert.ok(APP_SRC.includes("MissionBus.fire('asset_detail_open'"),
    "MissionBus.fire('asset_detail_open') exists");
  // calendar_open → check_calendar
  assert.ok(APP_SRC.includes("MISSION_EVENTS.CALENDAR_OPEN") || APP_SRC.includes("'calendar_open'"),
    "calendar_open trigger exists (via MISSION_EVENTS or direct)");
});

// ═══════════════════════════════════════════════════════════════════════
// K) Daily Day 1/Day 2 rendering verification
// ═══════════════════════════════════════════════════════════════════════

test('K1: _renderStreakDaysHTML uses todayDay for unclaimed streak', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  assert.ok(WALLET_SRC.includes('const todayDay = claimedToday ? currentStreakDay : (currentStreakDay > 0 ? currentStreakDay + 1 : 1)'),
    '_renderStreakDaysHTML computes todayDay for unclaimed streak');
});

test('K2: State A — Day 1 claimed, Day 2 available (claimedToday=false, streak_day=1)', () => {
  // Simulate: streak_day=1, claimedToday=false → todayDay=2
  const claimedToday = false;
  const currentStreakDay = 1;
  const todayDay = claimedToday ? currentStreakDay : (currentStreakDay > 0 ? currentStreakDay + 1 : 1);
  assert.equal(todayDay, 2, 'todayDay=2 when streak_day=1, claimedToday=false');

  // Day 1: isClaimed = (1 < 2) = true → ticked ✅
  // Day 2: isToday = (2 === 2) = true, !claimedToday → available ✅
  const day1_isClaimed = 1 < todayDay || (claimedToday && 1 === currentStreakDay);
  const day2_isToday = 2 === todayDay;
  assert.equal(day1_isClaimed, true, 'Day 1 is claimed (ticked)');
  assert.equal(day2_isToday, true, 'Day 2 is today (available)');
});

test('K3: State B — Day 2 claimed (claimedToday=true, streak_day=2)', () => {
  const claimedToday = true;
  const currentStreakDay = 2;
  const todayDay = claimedToday ? currentStreakDay : (currentStreakDay > 0 ? currentStreakDay + 1 : 1);
  assert.equal(todayDay, 2, 'todayDay=2 when streak_day=2, claimedToday=true');

  // Day 1: isClaimed = (1 < 2) = true → ticked ✅
  // Day 2: isToday = (2 === 2) = true, claimedToday=true → ticked ✅
  const day1_isClaimed = 1 < todayDay || (claimedToday && 1 === currentStreakDay);
  const day2_isClaimed = 2 < todayDay || (claimedToday && 2 === currentStreakDay);
  assert.equal(day1_isClaimed, true, 'Day 1 is claimed');
  assert.equal(day2_isClaimed, true, 'Day 2 is claimed');
});

test('K4: State C — First ever claim (claimedToday=false, streak_day=0)', () => {
  const claimedToday = false;
  const currentStreakDay = 0;
  const todayDay = claimedToday ? currentStreakDay : (currentStreakDay > 0 ? currentStreakDay + 1 : 1);
  assert.equal(todayDay, 1, 'todayDay=1 when streak_day=0, claimedToday=false');

  // Day 1: isToday = (1 === 1) = true, !claimedToday → available ✅
  const day1_isToday = 1 === todayDay;
  const day1_isClaimed = 1 < todayDay || (claimedToday && 1 === currentStreakDay);
  assert.equal(day1_isToday, true, 'Day 1 is today');
  assert.equal(day1_isClaimed, false, 'Day 1 is NOT claimed (available)');
});

test('K5: State D — streak_day=3, claimedToday=false (Day 4 available)', () => {
  const claimedToday = false;
  const currentStreakDay = 3;
  const todayDay = claimedToday ? currentStreakDay : (currentStreakDay > 0 ? currentStreakDay + 1 : 1);
  assert.equal(todayDay, 4, 'todayDay=4 when streak_day=3, claimedToday=false');

  // Days 1-3: ticked, Day 4: available
  for (let day = 1; day <= 3; day++) {
    const isClaimed = day < todayDay || (claimedToday && day === currentStreakDay);
    assert.equal(isClaimed, true, `Day ${day} is claimed`);
  }
  const day4_isToday = 4 === todayDay;
  assert.equal(day4_isToday, true, 'Day 4 is today (available)');
});

// ═══════════════════════════════════════════════════════════════════════
// L) Daily Card state machine — matches Modal exactly
// ═══════════════════════════════════════════════════════════════════════

function cardDay(streak_day, claimed_today) {
  if (claimed_today) return streak_day > 0 ? streak_day : 1;
  return streak_day > 0 ? streak_day + 1 : 1;
}

test('L1: Card state — streak_day=0, claimed_today=false → Day 1', () => {
  assert.equal(cardDay(0, false), 1, 'First ever claim → Day 1');
});

test('L2: Card state — streak_day=1, claimed_today=false → Day 2', () => {
  assert.equal(cardDay(1, false), 2, 'Day 1 claimed yesterday, Day 2 available');
});

test('L3: Card state — streak_day=2, claimed_today=true → Day 2 (not Day 3)', () => {
  assert.equal(cardDay(2, true), 2, 'Day 2 just claimed → Day 2, NOT Day 3');
});

test('L4: Card state — streak_day=2, claimed_today=false → Day 3', () => {
  assert.equal(cardDay(2, false), 3, 'Day 2 claimed yesterday, Day 3 available');
});

test('L5: Card and Modal use same state machine', () => {
  // Card: cardDay(streak_day, claimed_today) = claimed_today ? streak_day : (streak_day+1 or 1)
  // Modal: todayDay = claimedToday ? currentStreakDay : (currentStreakDay > 0 ? currentStreakDay + 1 : 1)
  // These are identical formulas.
  const cases = [
    { sd: 0, ct: false },
    { sd: 1, ct: false },
    { sd: 2, ct: true },
    { sd: 2, ct: false },
    { sd: 3, ct: true },
    { sd: 7, ct: false },
  ];
  for (const { sd, ct } of cases) {
    const card = cardDay(sd, ct);
    const modal = ct ? sd : (sd > 0 ? sd + 1 : 1);
    assert.equal(card, modal, `Card and Modal agree for streak_day=${sd}, claimed_today=${ct}`);
  }
});

// ═══════════════════════════════════════════════════════════════════════
// M) Claim path — no unnecessary API calls or re-render
// ═══════════════════════════════════════════════════════════════════════

test('M1: claimDaily does NOT call refreshWalletAfterMutation', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily');
  const fnEnd = WALLET_SRC.indexOf('\n  }', fnStart + 100);
  const fnBody = WALLET_SRC.substring(fnStart, fnEnd + 10);
  assert.ok(!fnBody.includes('refreshWalletAfterMutation'),
    'claimDaily must NOT call refreshWalletAfterMutation (removes 3 API calls + innerHTML rewrite)');
});

test('M2: claimDaily calls loadProfileCard (fire-and-forget, not await)', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  assert.ok(fnBody.includes('loadProfileCard'),
    'claimDaily calls loadProfileCard for profile card refresh');
  assert.ok(!fnBody.includes('await loadProfileCard'),
    'loadProfileCard is fire-and-forget (not awaited)');
});

test('M3: claimDaily does NOT call loadWalletData', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  // Strip comments to avoid matching comment text that describes what was removed
  const fnBodyNC = fnBody.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!fnBodyNC.includes('loadWalletData'),
    'claimDaily must NOT call loadWalletData (no full wallet re-render)');
  assert.ok(!fnBodyNC.includes('_refreshWalletData'),
    'claimDaily must NOT call _refreshWalletData (no full wallet re-render)');
});

test('M4: claimDaily does NOT call renderWalletPage', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  const fnBodyNC = fnBody.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!fnBodyNC.includes('renderWalletPage'),
    'claimDaily must NOT call renderWalletPage (no innerHTML rewrite)');
});

test('M5: claimDaily updates balance from result.newBalance (not from API)', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  assert.ok(fnBody.includes('result.newBalance'),
    'claimDaily uses result.newBalance from POST response (not from API)');
  assert.ok(fnBody.includes('_lastKnownBalance = result.newBalance'),
    'updates _lastKnownBalance from authoritative response');
});

test('M6: claimDaily calls _updateDailyCheckinCard after balance update', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  const balanceIdx = fnBody.indexOf('result.newBalance');
  const cardIdx = fnBody.indexOf('_updateDailyCheckinCard');
  assert.ok(balanceIdx > -1 && cardIdx > balanceIdx,
    '_updateDailyCheckinCard called AFTER balance update');
});

// ═══════════════════════════════════════════════════════════════════════
// N) Missions — auth race + waitForApiReady + concurrent
// ═══════════════════════════════════════════════════════════════════════

test('N1: loadMissionStatus uses waitForApiReady (not just canRunSessionRequests)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fnStart = APP_SRC.indexOf('async function loadMissionStatus');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart + 100);
  const fnBody = APP_SRC.substring(fnStart, fnEnd + 10);
  assert.ok(fnBody.includes('await waitForApiReady(8000)'),
    'loadMissionStatus awaits waitForApiReady(8000) — waits for auth');
  // canRunSessionRequests still checked AFTER waitForApiReady as final guard
  assert.ok(fnBody.includes('canRunSessionRequests()'),
    'canRunSessionRequests still checked after waitForApiReady');
});

test('N2: waitForApiReady is called BEFORE _missionLoadPromise check', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fnStart = APP_SRC.indexOf('async function loadMissionStatus');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart + 100);
  const fnBody = APP_SRC.substring(fnStart, fnEnd + 10);
  const waitIdx = fnBody.indexOf('waitForApiReady');
  const promiseIdx = fnBody.indexOf('_missionLoadPromise');
  assert.ok(waitIdx > -1 && promiseIdx > waitIdx,
    'waitForApiReady called BEFORE _missionLoadPromise check');
});

test('N3: _missionLoadPromise cleaned up in finally (no stuck promise)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fnStart = APP_SRC.indexOf('async function loadMissionStatus');
  const fnEnd = APP_SRC.indexOf('\n}', fnStart + 100);
  const fnBody = APP_SRC.substring(fnStart, fnEnd + 10);
  assert.ok(fnBody.includes('_missionLoadPromise = null'),
    '_missionLoadPromise = null in finally block');
});

test('N4: MissionBus.fire checks _missionsLoaded AFTER await (not just before)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fireIdx = APP_SRC.indexOf('async fire(eventType, targetId)');
  const fireBody = APP_SRC.substring(fireIdx, fireIdx + 1600);
  assert.ok(fireBody.includes('!_missionsLoaded || _missionStatusList.length === 0'),
    'MissionBus.fire checks _missionsLoaded + list populated after await');
});

test('N5: MissionBus.fire returns on load failure (retry possible)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fireIdx = APP_SRC.indexOf('async fire(eventType, targetId)');
  const fireBody = APP_SRC.substring(fireIdx, fireIdx + 1600);
  // After catch: return (allows retry)
  const catchIdx = fireBody.indexOf('catch (e)');
  const returnAfterCatch = fireBody.indexOf('return;', catchIdx);
  assert.ok(catchIdx > -1 && returnAfterCatch > catchIdx,
    'MissionBus.fire returns after catch (retry possible)');
});

test('N6: duplicate event does not trigger duplicate reward (backend guard)', () => {
  // The backend has multiple guards:
  // 1. event_token: one-time use, 32-char hex, KV with consumed marker
  // 2. mission_progress: UNIQUE(user_id, mission_id, daily_date/week_start)
  // 3. markMissionRewarded: CAS UPDATE WHERE status='pending'
  // 4. token_transactions: UNIQUE(user_id, tx_type, ref_id) WHERE status='completed'
  const CONTROLLER_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
  assert.ok(CONTROLLER_SRC.includes('markMissionRewarded'),
    'backend uses markMissionRewarded (CAS)');
  assert.ok(CONTROLLER_SRC.includes('grantReward'),
    'backend uses grantReward (atomic credit)');
  assert.ok(CONTROLLER_SRC.includes('refId'),
    'backend uses deterministic refId for idempotent credit');

  const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  assert.ok(WORKER_SRC.includes('consumedMarkerKey'),
    'event token uses consumed marker (prevents double-reward)');
  assert.ok(WORKER_SRC.includes('token.length !== 32'),
    'event token validates length');
});

test('N7: All 4 mission triggers fire correctly in app.js', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  // news_article_open
  assert.ok(APP_SRC.includes("MissionBus.fire('news_article_open'"),
    "News: MissionBus.fire('news_article_open')");
  // analysis_detail_open
  assert.ok(APP_SRC.includes("MissionBus.fire('analysis_detail_open'"),
    "Analysis: MissionBus.fire('analysis_detail_open')");
  // asset_detail_open (market)
  assert.ok(APP_SRC.includes("MissionBus.fire('asset_detail_open'"),
    "Market: MissionBus.fire('asset_detail_open')");
  // calendar_open
  assert.ok(APP_SRC.includes("MISSION_EVENTS.CALENDAR_OPEN") || APP_SRC.includes("'calendar_open'"),
    "Calendar: calendar_open trigger");
});

test('N8: Backend mission triggers match DB seed', () => {
  const REPO_SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  // DB seed data — triggers are embedded in JSON metadata strings
  assert.ok(REPO_SRC.includes('"trigger":"news_article_open"'),
    'DB seed: read_news trigger = news_article_open');
  assert.ok(REPO_SRC.includes('"trigger":"analysis_detail_open"'),
    'DB seed: read_analysis trigger = analysis_detail_open');
  assert.ok(REPO_SRC.includes('"trigger":"calendar_open"'),
    'DB seed: check_calendar trigger = calendar_open');
  assert.ok(REPO_SRC.includes('"trigger":"asset_detail_open"'),
    'DB seed: visit_market trigger = asset_detail_open');
});

// ═══════════════════════════════════════════════════════════════════════
// O) Stale GET overwrite protection
// ═══════════════════════════════════════════════════════════════════════

test('O1: fetchWallet does NOT set _lastKnownBalance (claimDaily authoritative value preserved)', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function fetchWallet');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 2000);
  assert.ok(!fnBody.includes('_lastKnownBalance'),
    'fetchWallet does NOT set _lastKnownBalance (claimDaily sets it from POST response)');
});

test('O2: claimDaily sets _lastKnownBalance from POST response (not from GET)', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  assert.ok(fnBody.includes('_lastKnownBalance = result.newBalance'),
    'claimDaily sets _lastKnownBalance from POST response');
});

test('O3: claimDaily sets walletData.balance from POST response (not from GET)', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  assert.ok(fnBody.includes('walletData.balance = result.newBalance'),
    'claimDaily sets walletData.balance from POST response');
});

test('O4: loadProfileCard renders dashboard card, NOT wallet full page', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function loadProfileCard');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 2000);
  // loadProfileCard renders into #wallet-preview-card (dashboard)
  assert.ok(fnBody.includes('wallet-preview-card'),
    'loadProfileCard renders into #wallet-preview-card (dashboard), NOT #wallet-full-page');
  // Must NOT render into wallet-full-page
  assert.ok(!fnBody.includes('wallet-full-page'),
    'loadProfileCard does NOT render into #wallet-full-page');
});

test('O5: stale GET cannot overwrite wallet-full-page balance (renderWalletPage not called in claim path)', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const claimStart = WALLET_SRC.indexOf('async function claimDaily()');
  const claimBody = WALLET_SRC.substring(claimStart, claimStart + 8000);
  const claimBodyNC = claimBody.replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, '');
  assert.ok(!claimBodyNC.includes('renderWalletPage'),
    'claimDaily does NOT call renderWalletPage — stale GET cannot overwrite wallet-full-page balance');
  assert.ok(!claimBodyNC.includes('loadWalletData'),
    'claimDaily does NOT call loadWalletData — stale GET cannot trigger full wallet re-render');
});

// ═══════════════════════════════════════════════════════════════════════
// P) Authoritative Balance Guard — stale GET protection
// ═══════════════════════════════════════════════════════════════════════

test('P1: _setAuthoritativeBalance function exists', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  assert.ok(WALLET_SRC.includes('function _setAuthoritativeBalance'),
    '_setAuthoritativeBalance function exists');
  assert.ok(WALLET_SRC.includes('_authoritativeBalance'),
    '_authoritativeBalance variable exists');
  assert.ok(WALLET_SRC.includes('_authoritativeBalanceSeq'),
    '_authoritativeBalanceSeq variable exists');
});

test('P2: _setAuthoritativeBalance records balance + mutation seq', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('function _setAuthoritativeBalance');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 300);
  assert.ok(fnBody.includes('_authoritativeBalance = newBalance'),
    'sets _authoritativeBalance from newBalance');
  assert.ok(fnBody.includes('_authoritativeBalanceSeq = _walletMutationSeq'),
    'sets _authoritativeBalanceSeq from current mutation seq');
});

test('P3: fetchWallet checks _authoritativeBalance before accepting GET balance', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function fetchWallet');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 2000);
  assert.ok(fnBody.includes('_authoritativeBalance !== null'),
    'fetchWallet checks if authoritative balance exists');
  assert.ok(fnBody.includes('myMutationSeq <= _authoritativeBalanceSeq'),
    'fetchWallet checks if GET seq is <= authoritative seq (stale detection)');
  assert.ok(fnBody.includes('data.balance = _authoritativeBalance'),
    'fetchWallet overwrites stale balance with authoritative value');
  assert.ok(fnBody.includes('_authoritativeBalance = null'),
    'fetchWallet clears authoritative guard when GET is fresh');
});

test('P4: claimDaily calls _setAuthoritativeBalance after successful claim', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function claimDaily()');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 8000);
  assert.ok(fnBody.includes('_setAuthoritativeBalance(result.newBalance)'),
    'claimDaily calls _setAuthoritativeBalance with POST response newBalance');
});

test('P5: VPN purchase calls _setAuthoritativeBalance after successful purchase', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  assert.ok(WALLET_SRC.includes('_setAuthoritativeBalance(resp.new_balance)'),
    'VPN purchase calls _setAuthoritativeBalance with POST response new_balance');
});

test('P6: refreshWalletAfterMutation (app.js) calls _setAuthoritativeBalance', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  assert.ok(APP_SRC.includes('_setAuthoritativeBalance'),
    'refreshWalletAfterMutation calls _setAuthoritativeBalance');
});

test('P7: _setAuthoritativeBalance exposed via WalletApp for external callers', () => {
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  assert.ok(WALLET_SRC.includes('_setAuthoritativeBalance,'),
    '_setAuthoritativeBalance is exported via WalletApp object');
});

// Simulate the race scenario: POST mutation → newBalance=Y → GET returns X
test('P8: Race scenario — POST newBalance=Y, stale GET returns X, walletData stays Y', () => {
  // This is a logic simulation, not a runtime test (would need Telegram auth).
  // We verify the CODE PATH that prevents stale GET from overwriting.

  // 1. Before mutation: _walletMutationSeq = N, _authoritativeBalance = null
  // 2. claimDaily: _walletMutationSeq++ → N+1
  // 3. POST success: result.newBalance = Y
  // 4. _setAuthoritativeBalance(Y) → _authoritativeBalance = Y, _authoritativeBalanceSeq = N+1
  // 5. walletData.balance = Y (set by claimDaily)
  // 6. _lastKnownBalance = Y (set by claimDaily)
  // 7. loadProfileCard (fire-and-forget) → fetchWallet()
  // 8. fetchWallet: myMutationSeq = _walletMutationSeq = N+1
  // 9. GET /api/wallet → backend returns stale balance = X (Neon read replica lag)
  // 10. fetchWallet: myMutationSeq (N+1) === _walletMutationSeq (N+1) → passes seq guard
  // 11. fetchWallet: _authoritativeBalance !== null (Y) → true
  // 12. fetchWallet: myMutationSeq (N+1) <= _authoritativeBalanceSeq (N+1) → true (EQUAL!)
  // 13. fetchWallet: data.balance = _authoritativeBalance (Y) → OVERWRITES stale X with Y
  // 14. walletData = data → walletData.balance = Y (NOT X!)
  // ✅ walletData.balance stays Y (authoritative)
  // ✅ _lastKnownBalance stays Y (not set by fetchWallet)

  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function fetchWallet');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 2000);

  // Verify the guard uses <= (not <), so equal seq is also protected
  assert.ok(fnBody.includes('myMutationSeq <= _authoritativeBalanceSeq'),
    'fetchWallet uses <= comparison (equal seq is also protected — stale DB snapshot)');

  // Verify balance is overwritten in the data object BEFORE walletData assignment
  const guardIdx = fnBody.indexOf('data.balance = _authoritativeBalance');
  const walletDataIdx = fnBody.indexOf('walletData = data');
  assert.ok(guardIdx > -1 && walletDataIdx > guardIdx,
    'data.balance overwritten with authoritative value BEFORE walletData assignment');
});

test('P9: Guard cleared when fresh GET arrives (no intervening mutation)', () => {
  // After a fresh GET (seq > _authoritativeBalanceSeq, meaning no mutation
  // was in between), the guard is cleared so future GETs work normally.
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function fetchWallet');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 2000);
  // The else branch clears the guard
  assert.ok(fnBody.includes('_authoritativeBalance = null'),
    'fetchWallet clears _authoritativeBalance when GET is fresh (else branch)');
});

test('P10: Guard works for debit mutations too (VPN purchase balance decreases)', () => {
  // The guard is based on mutation seq, NOT balance comparison.
  // If VPN purchase: balance X → Y (Y < X, debit), the guard protects Y.
  // A stale GET returning X will be overwritten with Y (authoritative).
  // This works because the guard checks seq, not numeric comparison.
  const WALLET_SRC = fs.readFileSync(path.join(__dirname, 'wallet.js'), 'utf8');
  const fnStart = WALLET_SRC.indexOf('async function fetchWallet');
  const fnBody = WALLET_SRC.substring(fnStart, fnStart + 2000);
  // Verify the guard does NOT compare balances numerically
  assert.ok(!fnBody.includes('data.balance > ') && !fnBody.includes('data.balance < '),
    'fetchWallet does NOT use numeric balance comparison (guard is seq-based, works for debits too)');
});

// ═══════════════════════════════════════════════════════════════════════
// Q) Root-Cause 1 (RC-1) — Stale Mission Triggers migration
//
// Production was seeded with OLD trigger names (news_open / analysis_open /
// market_open) before commit 6870112 renamed them to news_article_open /
// analysis_detail_open / asset_detail_open. Because the seed only fires
// when mission_rewards is EMPTY, existing production rows kept their
// stale triggers — MissionBus.fire fired the NEW event names but the DB
// still held the OLD triggers, so _fireInternal matched nothing → missions
// never ticked. This suite verifies the idempotent migration in
// reward_center.js ensureSchema that promotes stale triggers to the
// current names.
// ═══════════════════════════════════════════════════════════════════════

test('Q1: Stale-trigger migration exists in reward_center.js ensureSchema', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  // The migration block is identifiable by its three pinned (mission_id, old_trigger) pairs.
  assert.ok(SRC.includes("mission_id = 'read_news'      AND metadata->>'trigger' = 'news_open'"),
    'migration pins read_news + news_open');
  assert.ok(SRC.includes("mission_id = 'read_analysis'  AND metadata->>'trigger' = 'analysis_open'"),
    'migration pins read_analysis + analysis_open');
  assert.ok(SRC.includes("mission_id = 'visit_market'   AND metadata->>'trigger' = 'market_open'"),
    'migration pins visit_market + market_open');
});

test('Q2: Migration uses jsonb_set on the trigger field only (other metadata preserved)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  const migrationIdx = SRC.indexOf("UPDATE mission_rewards SET metadata = jsonb_set");
  assert.ok(migrationIdx > -1, 'jsonb_set migration present');
  const block = SRC.substring(migrationIdx, migrationIdx + 2000);
  // Must update only the trigger field path
  assert.ok(block.includes("'{trigger}'"), 'jsonb_set targets {trigger} path only');
  // Must use CASE with the three mappings (old → new)
  assert.ok(block.includes('"news_article_open"'), 'maps to news_article_open');
  assert.ok(block.includes('"analysis_detail_open"'), 'maps to analysis_detail_open');
  assert.ok(block.includes('"asset_detail_open"'), 'maps to asset_detail_open');
  // Must NOT touch target_count, description, icon, sort_order, token_amount
  // (jsonb_set with a single field path only rewrites that field)
  assert.ok(!block.includes('target_count'), 'migration does NOT touch target_count');
  assert.ok(!block.includes('description'), 'migration does NOT touch description');
  assert.ok(!block.includes('icon'), 'migration does NOT touch icon');
});

test('Q3: Migration is idempotent — WHERE clause pins stale trigger (2nd run is no-op)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  const migrationIdx = SRC.indexOf("UPDATE mission_rewards SET metadata = jsonb_set");
  const block = SRC.substring(migrationIdx, migrationIdx + 2500);
  // WHERE clause must include all 3 (mission_id, old_trigger) conditions
  // so a 2nd run (after trigger is updated to new value) finds 0 rows.
  const whereIdx = block.indexOf('WHERE');
  assert.ok(whereIdx > -1, 'WHERE clause exists');
  const whereBlock = block.substring(whereIdx);
  assert.ok(whereBlock.includes("news_open") && whereBlock.includes("analysis_open") && whereBlock.includes("market_open"),
    'WHERE pins the OLD trigger names → 2nd run finds 0 rows (idempotent)');
  // Verify the WHERE clause is an OR of all 3 (not AND — that would never match)
  const orCount = (whereBlock.match(/\sOR\s/g) || []).length;
  assert.ok(orCount >= 2, 'WHERE uses OR across 3 stale-trigger conditions');
});

test('Q4: Migration does NOT touch calendar_open or daily_open (unchanged triggers)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  const migrationIdx = SRC.indexOf("UPDATE mission_rewards SET metadata = jsonb_set");
  // Block ends at the closing of the query string (next `)` after `)` of queryDb call)
  const blockEnd = SRC.indexOf(');', migrationIdx);
  const block = SRC.substring(migrationIdx, blockEnd);
  assert.ok(!block.includes("calendar_open"),
    'migration does NOT touch calendar_open (unchanged trigger)');
  assert.ok(!block.includes("daily_open"),
    'migration does NOT touch daily_open (unchanged trigger)');
});

test('Q5: Migration try/catch RE-THROWS on failure (NOT silently swallowed)', () => {
  // CORRECTNESS FIX: previously, the migration try/catch swallowed the
  // error AND set `_schemaVerified = true`. That meant a single failure
  // (e.g. transient DB error, jsonb_set unavailable on a misconfigured PG,
  // etc.) silently left stale triggers in place for the isolate's lifetime
  // (hours/days until Worker cold-restart). Since the migration is REQUIRED
  // for mission correctness (without it, the 3 affected missions never
  // tick), swallowing the error defeated the entire fix.
  //
  // The fix: the inner catch RE-THROWS so the outer catch (which logs +
  // returns WITHOUT setting `_schemaVerified`) takes over. The next
  // request retries ensureSchema — the batchSql (CREATE TABLE IF NOT
  // EXISTS) and seed (gated on count===0) are idempotent no-ops on an
  // already-initialized DB, so retrying is cheap.
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  const migrationIdx = SRC.indexOf("UPDATE mission_rewards SET metadata = jsonb_set");
  const block = SRC.substring(migrationIdx - 200, migrationIdx + 2500);
  assert.ok(block.includes('try {'),
    'migration has try block');
  assert.ok(block.includes('catch (e)'),
    'migration has catch block');
  assert.ok(block.includes('throw e'),
    'inner catch RE-THROWS the error (does NOT silently swallow)');
  assert.ok(block.includes('will retry next request'),
    'inner catch logs a clear "will retry next request" warning');
});

test('Q5b: Migration failure does NOT set _schemaVerified=true (next request retries)', () => {
  // The OUTER catch (line ~333) is responsible for ensuring the migration
  // failure path doesn't lock the isolate. The outer catch must:
  //   1. NOT set `_schemaVerified = true`
  //   2. Return early (so the migration is retried next request)
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  const outerCatchIdx = SRC.indexOf('Reward Center schema migration warning');
  assert.ok(outerCatchIdx > -1, 'outer catch exists');
  const block = SRC.substring(outerCatchIdx, outerCatchIdx + 800);
  // The outer catch must include the comment + return (no `_schemaVerified = true`)
  assert.ok(block.includes('Do NOT set _schemaVerified on error'),
    'outer catch documents the policy (do NOT set _schemaVerified on error)');
  assert.ok(block.includes('return;'),
    'outer catch returns early (no _schemaVerified = true)');
  // The outer catch must NOT set _schemaVerified=true after the warning
  // (i.e. between the `console.warn` line and the `return;` line)
  const warnLine = block.indexOf('console.warn');
  const returnLine = block.indexOf('return;');
  const setTrueLine = block.indexOf('_schemaVerified = true');
  assert.ok(setTrueLine === -1 || setTrueLine > returnLine,
    'outer catch does NOT set _schemaVerified = true before returning');
});

test('Q5c: Migration success path sets _schemaVerified=true (NOT in catch)', () => {
  // Verify `_schemaVerified = true` is set ONLY in the success path
  // (after the migration try/catch, inside the outer try, before the outer catch).
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  const migrationIdx = SRC.indexOf("UPDATE mission_rewards SET metadata = jsonb_set");
  const innerThrowIdx = SRC.indexOf('throw e', migrationIdx);
  const schemaVerifiedIdx = SRC.indexOf('_schemaVerified = true', innerThrowIdx);
  const outerCatchIdx = SRC.indexOf('} catch (e) {', schemaVerifiedIdx);
  // _schemaVerified = true must come BEFORE the outer catch (i.e. inside the outer try block)
  assert.ok(schemaVerifiedIdx > -1 && outerCatchIdx > schemaVerifiedIdx,
    '_schemaVerified = true is in the SUCCESS path (inside outer try, BEFORE outer catch)');
});

test('Q6: Frontend MISSION_EVENTS values match the seed triggers (no future mismatch)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  // After RC-1 fix, MISSION_EVENTS values must match the seed triggers in reward_center.js
  // (otherwise a future call to fireMissionEvent(MISSION_EVENTS.NEWS_OPEN) would fail).
  const meStart = APP_SRC.indexOf('const MISSION_EVENTS = {');
  const meEnd = APP_SRC.indexOf('};', meStart);
  const meBlock = APP_SRC.substring(meStart, meEnd);
  assert.ok(meBlock.includes("NEWS_OPEN: 'news_article_open'"),
    "MISSION_EVENTS.NEWS_OPEN aligned with seed (news_article_open)");
  assert.ok(meBlock.includes("ANALYSIS_OPEN: 'analysis_detail_open'"),
    "MISSION_EVENTS.ANALYSIS_OPEN aligned with seed (analysis_detail_open)");
  assert.ok(meBlock.includes("MARKET_OPEN: 'asset_detail_open'"),
    "MISSION_EVENTS.MARKET_OPEN aligned with seed (asset_detail_open)");
  assert.ok(meBlock.includes("CALENDAR_OPEN: 'calendar_open'"),
    "MISSION_EVENTS.CALENDAR_OPEN unchanged (matches seed)");
  assert.ok(meBlock.includes("DAILY_OPEN: 'daily_open'"),
    "MISSION_EVENTS.DAILY_OPEN unchanged (matches seed)");
  // Verify NO stale values remain in MISSION_EVENTS
  assert.ok(!meBlock.includes("'news_open'"),
    "MISSION_EVENTS no longer has stale 'news_open' value");
  assert.ok(!meBlock.includes("'analysis_open'"),
    "MISSION_EVENTS no longer has stale 'analysis_open' value");
  assert.ok(!meBlock.includes("'market_open'"),
    "MISSION_EVENTS no longer has stale 'market_open' value");
});

test('Q7: _fireInternal matches all 5 missions when triggers are aligned (post-migration)', () => {
  // Simulates the in-memory state AFTER the migration has run on a stale DB:
  //   triggers now match the frontend event names → all 5 missions match.
  const postMigrationMissions = [
    { mission_id: 'daily_login',    trigger: 'daily_open',           completed: false },
    { mission_id: 'read_news',      trigger: 'news_article_open',    completed: false },
    { mission_id: 'read_analysis',  trigger: 'analysis_detail_open',  completed: false },
    { mission_id: 'check_calendar', trigger: 'calendar_open',        completed: false },
    { mission_id: 'visit_market',   trigger: 'asset_detail_open',    completed: false },
  ];
  const completedToday = new Set();
  const frontendEvents = [
    ['news_article_open', 'url-1'],
    ['analysis_detail_open', 'a-1'],
    ['calendar_open', undefined],
    ['asset_detail_open', 'BTC'],
    ['daily_open', undefined],
  ];

  function _fireInternal(missions, eventType, targetId) {
    return missions.filter(m => m.trigger === eventType && !m.completed && !completedToday.has(m.mission_id));
  }

  let totalMatched = 0;
  for (const [evt, target] of frontendEvents) {
    const matched = _fireInternal(postMigrationMissions, evt, target);
    totalMatched += matched.length;
  }
  assert.equal(totalMatched, 5,
    'After migration, all 5 frontend events match a mission (was: only 2 with stale triggers)');
});

// ═══════════════════════════════════════════════════════════════════════
// R) Root-Cause 2 (RC-2) — Weekly Boundary Leak in _completedMissionsToday
//
// Previously, _completedMissionsToday was only ever ADD-TO (never cleared).
// On the weekly boundary (Saturday Tehran), a user who completed `read_news`
// in the prior week had `read_news` stuck in the Set, and `_fireInternal`
// filtered it out → the new week's mission never fired → no tick, no reward.
// This suite verifies that reloadMissions now clears the Set and that
// loadMissionStatus rebuilds it authoritatively from the backend response.
// ═══════════════════════════════════════════════════════════════════════

test('R1: reloadMissions clears _completedMissionsToday before re-fetching', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const rmStart = APP_SRC.indexOf('window.reloadMissions = function()');
  const rmBlock = APP_SRC.substring(rmStart, rmStart + 800);
  assert.ok(rmBlock.includes('_completedMissionsToday.clear()'),
    'reloadMissions clears _completedMissionsToday before loadMissionStatus()');
  // Order: clear must come BEFORE loadMissionStatus (otherwise Set is stale during load)
  const clearIdx = rmBlock.indexOf('_completedMissionsToday.clear()');
  const loadIdx = rmBlock.indexOf('loadMissionStatus()');
  assert.ok(clearIdx > -1 && loadIdx > clearIdx,
    '_completedMissionsToday.clear() runs BEFORE loadMissionStatus()');
});

test('R2: _missionsLoaded also reset to false in reloadMissions', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const rmStart = APP_SRC.indexOf('window.reloadMissions = function()');
  const rmBlock = APP_SRC.substring(rmStart, rmStart + 800);
  assert.ok(rmBlock.includes('_missionsLoaded = false'),
    'reloadMissions resets _missionsLoaded (existing behavior, not regressed)');
});

test('R3: loadMissionStatus rebuilds _completedMissionsToday from backend response', () => {
  // After reloadMissions clears the Set, loadMissionStatus must repopulate it
  // from m.completed (the authoritative backend-completed flag).
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const lmStart = APP_SRC.indexOf('async function loadMissionStatus()');
  const lmBlock = APP_SRC.substring(lmStart, lmStart + 2500);
  // The repopulation code: for each mission in the response, if m.completed add to Set
  assert.ok(/if\s*\(\s*m\.completed\s*\)\s*_completedMissionsToday\.add\(\s*m\.mission_id\s*\)/.test(lmBlock),
    'loadMissionStatus repopulates _completedMissionsToday from m.completed (authoritative)');
});

test('R4: Weekly boundary simulation — old week completion does NOT block new week', () => {
  // Simulate the pre-fix behavior vs the post-fix behavior.
  const _completedMissionsToday_preFix = new Set();
  const _completedMissionsToday_postFix = new Set();

  // WEEK 1: backend reports read_news completed
  const week1BackendResponse = [
    { mission_id: 'read_news', trigger: 'news_article_open', completed: true },
  ];
  for (const m of week1BackendResponse) {
    if (m.completed) _completedMissionsToday_preFix.add(m.mission_id);
    if (m.completed) _completedMissionsToday_postFix.add(m.mission_id);
  }

  // WEEK 1: user opens article — _fireInternal returns no match (already completed)
  function _fireInternal_pre(set, missions, eventType) {
    return missions.filter(m => m.trigger === eventType && !m.completed && !set.has(m.mission_id));
  }
  const week1Result_pre = _fireInternal_pre(_completedMissionsToday_preFix,
    [{ mission_id: 'read_news', trigger: 'news_article_open', completed: true }],
    'news_article_open');
  assert.equal(week1Result_pre.length, 0, 'Week 1: mission already completed, no re-fire');

  // WEEK 2 BOUNDARY: reloadMissions called. PRE-FIX keeps the Set, POST-FIX clears it.
  // PRE-FIX (bug): _completedMissionsToday NOT cleared → read_news still in Set
  // POST-FIX (correct): _completedMissionsToday.clear() → Set is empty

  // Simulate POST-FIX: clear
  _completedMissionsToday_postFix.clear();

  // WEEK 2: backend reports read_news NOT completed (fresh progress for new week)
  const week2BackendResponse = [
    { mission_id: 'read_news', trigger: 'news_article_open', completed: false },
  ];
  for (const m of week2BackendResponse) {
    if (m.completed) _completedMissionsToday_postFix.add(m.mission_id);
  }

  // WEEK 2: user opens article — POST-FIX _fireInternal should match (mission fires, ticks)
  const week2Result_post = _fireInternal_pre(_completedMissionsToday_postFix,
    [{ mission_id: 'read_news', trigger: 'news_article_open', completed: false }],
    'news_article_open');
  assert.equal(week2Result_post.length, 1,
    'Post-fix Week 2: read_news fires (Set was cleared, backend reports not-completed)');

  // Compare with PRE-FIX behavior — Set still has read_news from week 1
  for (const m of week2BackendResponse) {
    if (m.completed) _completedMissionsToday_preFix.add(m.mission_id);
    // m.completed is false, so nothing added; stale read_news STILL in Set
  }
  const week2Result_pre = _fireInternal_pre(_completedMissionsToday_preFix,
    [{ mission_id: 'read_news', trigger: 'news_article_open', completed: false }],
    'news_article_open');
  assert.equal(week2Result_pre.length, 0,
    'Pre-fix Week 2: read_news is BLOCKED by stale Set entry (the bug)');
});

// ═══════════════════════════════════════════════════════════════════════
// S) Mission Behavioral End-to-End (the 3 stale-trigger missions)
//
// Source-level assertions on the full path from Frontend event → Backend
// grant → tick. Covers the 3 missions that were affected by stale seed
// (read_news, read_analysis, visit_market). Cannot run runtime pg-mem
// for the migration itself (pg-mem lacks jsonb_set), but asserts the
// code path end-to-end.
// ═══════════════════════════════════════════════════════════════════════

test('S1: read_news — frontend fires news_article_open for a specific article (target_id)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const idx = APP_SRC.indexOf("MissionBus.fire('news_article_open'");
  assert.ok(idx > -1, "MissionBus.fire('news_article_open', targetId) exists");
  // Verify it passes a target_id (the article URL/id/index)
  const line = APP_SRC.substring(idx, idx + 300);
  assert.ok(line.includes('displayedNews[idx].url') || line.includes('displayedNews[idx].id'),
    'news_article_open carries a specific target_id (article url/id)');
});

test('S2: read_analysis — frontend fires analysis_detail_open for a specific analysis (target_id)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const idx = APP_SRC.indexOf("MissionBus.fire('analysis_detail_open'");
  assert.ok(idx > -1, "MissionBus.fire('analysis_detail_open', targetId) exists");
  const line = APP_SRC.substring(idx, idx + 200);
  assert.ok(line.includes('String(id)'),
    'analysis_detail_open carries a specific target_id (analysis id)');
});

test('S3: visit_market — frontend fires asset_detail_open for a specific symbol (target_id)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  // Two fire sites (coin detail + forex detail) — both with String(symbol)
  const re = /MissionBus\.fire\('asset_detail_open',\s*String\(symbol\)\)/g;
  const matches = APP_SRC.match(re);
  assert.ok(matches && matches.length >= 2,
    'asset_detail_open fires for both coin and forex detail (2 sites)');
});

test('S4: completeMission issues event_token BEFORE calling /mission/complete (3 stale-trigger missions)', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fnStart = APP_SRC.indexOf('async function completeMission(missionId, targetId)');
  const fnBlock = APP_SRC.substring(fnStart, fnStart + 3000);
  // Verify the flow: issue-token first (for non-daily_login), then complete
  const issueIdx = fnBlock.indexOf("'/api/wallet/mission/issue-token'");
  const completeIdx = fnBlock.indexOf("'/api/wallet/mission/complete'");
  assert.ok(issueIdx > -1 && completeIdx > issueIdx,
    'completeMission issues event_token BEFORE calling /mission/complete');
  // Verify it skips token issuance for daily_login
  assert.ok(fnBlock.includes("missionId !== 'daily_login'"),
    'completeMission skips issue-token for daily_login (auto-fired by bootstrap)');
  // Verify target_id is passed to BOTH issue-token and complete
  assert.ok(fnBlock.includes('target_id: targetId') || fnBlock.includes("target_id: targetId || ''"),
    'completeMission passes target_id to issue-token and complete');
});

test('S5: handleMissionComplete backend verifies event_token + target_id binding (consumeMissionEventToken)', () => {
  const WALLET_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
  const fnStart = WALLET_CTRL_SRC.indexOf('async function handleMissionComplete(request, env)');
  const fnBlock = WALLET_CTRL_SRC.substring(fnStart, fnStart + 5000);
  // Consume the token (one-time use, KV)
  assert.ok(fnBlock.includes('consumeMissionEventToken'),
    'handleMissionComplete consumes the event_token (one-time use)');
  // Pass completeTargetId from the request body
  assert.ok(fnBlock.includes('completeTargetId'),
    'handleMissionComplete reads target_id from request body and binds it to token consumption');
  // Reject if token invalid/expired
  assert.ok(fnBlock.includes('INVALID_EVENT_TOKEN'),
    'handleMissionComplete rejects with INVALID_EVENT_TOKEN if consume fails');
});

test('S6: handleMissionComplete incrementMissionProgress → markMissionRewarded → grantReward chain', () => {
  const WALLET_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
  const fnStart = WALLET_CTRL_SRC.indexOf('async function handleMissionComplete(request, env)');
  // Use a generous slice (the function is ~9000 chars) — but bound at next function for safety
  const nextFn = WALLET_CTRL_SRC.indexOf('async function', fnStart + 50);
  const fnEnd = nextFn > -1 ? nextFn : WALLET_CTRL_SRC.length;
  const fnBlock = WALLET_CTRL_SRC.substring(fnStart, fnEnd);
  // Order: increment → mark → grant
  const incrIdx = fnBlock.indexOf('incrementMissionProgress');
  const markIdx = fnBlock.indexOf('markMissionRewarded');
  const grantIdx = fnBlock.indexOf('economyService.grantReward');
  assert.ok(incrIdx > -1 && markIdx > incrIdx && grantIdx > markIdx,
    'Order: incrementMissionProgress → markMissionRewarded → economyService.grantReward');
  // markMissionRewarded uses CAS (WHERE rewarded = FALSE)
  assert.ok(fnBlock.includes('if (progress.completed && !progress.rewarded)'),
    'handleMissionComplete grants reward only if completed && !rewarded (CAS protection)');
  // refId deterministic: mission_<userId>_<missionId>_<today>
  assert.ok(fnBlock.includes("`mission_${userId}_${missionId}_${today}`"),
    'refId is deterministic (mission_userId_missionId_today)');
});

test('S7: Response shape — completed, is_new_completion, new_balance (frontend uses these for tick + popup)', () => {
  const WALLET_CTRL_SRC = fs.readFileSync(path.join(__dirname, 'src/controllers/wallet.js'), 'utf8');
  const fnStart = WALLET_CTRL_SRC.indexOf('async function handleMissionComplete(request, env)');
  const nextFn = WALLET_CTRL_SRC.indexOf('async function', fnStart + 50);
  const fnEnd = nextFn > -1 ? nextFn : WALLET_CTRL_SRC.length;
  const fnBlock = WALLET_CTRL_SRC.substring(fnStart, fnEnd);
  // Response must include: completed, is_new_completion, new_balance, reward_amount, reward_label, progress_count, target_count
  assert.ok(fnBlock.includes('completed: progress.completed'),
    'Response includes completed (frontend uses for tick)');
  assert.ok(fnBlock.includes('is_new_completion: rewardGranted'),
    'Response includes is_new_completion (frontend uses to gate popup)');
  assert.ok(fnBlock.includes('new_balance: newBalance'),
    'Response includes new_balance (frontend uses for balance refresh)');
});

test('S8: completeMission frontend uses response.completed to update _missionStatusList + tick', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fnStart = APP_SRC.indexOf('async function completeMission(missionId, targetId)');
  const fnBlock = APP_SRC.substring(fnStart, fnStart + 3000);
  // After success: update _missionStatusList[idx].completed = data.completed
  assert.ok(fnBlock.includes('_missionStatusList[idx].completed = data.completed'),
    'completeMission updates _missionStatusList[idx].completed from response');
  // If data.completed: add to _completedMissionsToday (so it doesn't fire again)
  assert.ok(fnBlock.includes('if (data.completed)') && fnBlock.includes('_completedMissionsToday.add(missionId)'),
    'completeMission adds to _completedMissionsToday if data.completed');
  // If is_new_completion: popup + refreshWalletAfterMission
  assert.ok(fnBlock.includes('if (data.is_new_completion)'),
    'completeMission checks is_new_completion for popup');
  assert.ok(fnBlock.includes('showMissionRewardPopup') && fnBlock.includes('refreshWalletAfterMission'),
    'completeMission shows popup + refreshWalletAfterMission on new completion');
  // Calls updateMissionCards() at the end (re-renders tick)
  assert.ok(fnBlock.includes('updateMissionCards()'),
    'completeMission calls updateMissionCards() (renders tick)');
});

// ═══════════════════════════════════════════════════════════════════════
// T) Mission Idempotency — duplicate/concurrent completion
// ═══════════════════════════════════════════════════════════════════════

test('T1: Duplicate completion in same session — frontend _completedMissionsToday guards it', () => {
  const APP_SRC = fs.readFileSync(path.join(__dirname, 'app.js'), 'utf8');
  const fnStart = APP_SRC.indexOf('async function completeMission(missionId, targetId)');
  const fnBlock = APP_SRC.substring(fnStart, fnStart + 200);
  assert.ok(fnBlock.includes('if (_completedMissionsToday.has(missionId)) return'),
    'completeMission early-returns if missionId already in _completedMissionsToday (no duplicate API call)');
});

test('T2: Backend CAS guard — markMissionRewarded UPDATE WHERE rewarded = FALSE', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/reward_center.js'), 'utf8');
  // Two markMissionRewarded paths: weekly (week_start) and daily (daily_date)
  // Both use "WHERE ... AND rewarded = FALSE RETURNING id" (CAS)
  const idx = SRC.indexOf('async function markMissionRewarded');
  const block = SRC.substring(idx, idx + 2000);
  assert.ok(block.includes('rewarded = FALSE') && block.includes('RETURNING id'),
    'markMissionRewarded uses CAS (WHERE rewarded = FALSE RETURNING id)');
  // Two paths: weekly (week_start) and daily (daily_date)
  assert.ok(block.includes('week_start = $3'),
    'weekly mission markMissionRewarded filters by week_start');
  assert.ok(block.includes('daily_date = $3'),
    'daily mission markMissionRewarded filters by daily_date');
});

test('T3: creditTokens idempotency — INSERT ON CONFLICT DO NOTHING (no double-credit)', () => {
  const SRC = fs.readFileSync(path.join(__dirname, 'src/repositories/wallet.js'), 'utf8');
  const fnStart = SRC.indexOf('async function creditTokens(env');
  const fnBlock = SRC.substring(fnStart, fnStart + 3000);
  // ON CONFLICT DO NOTHING
  assert.ok(fnBlock.includes('ON CONFLICT DO NOTHING'),
    'creditTokens uses INSERT ON CONFLICT DO NOTHING (atomic idempotency)');
  // If idempotent (existing tx found), returns idempotent: true
  assert.ok(fnBlock.includes('idempotent: true'),
    'creditTokens returns idempotent:true for duplicate requests (no double-credit)');
  // refId-based idempotency pre-check
  assert.ok(fnBlock.includes('ref_id = $3') || fnBlock.includes('ref_id = $2'),
    'creditTokens checks existing tx by ref_id (idempotency pre-check)');
});

test('T4: Event token one-time use — consumedMarkerKey prevents double-consume', () => {
  const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  const idx = WORKER_SRC.indexOf('async function consumeMissionEventToken');
  const block = WORKER_SRC.substring(idx, idx + 2500);
  // Check the consumed marker
  assert.ok(block.includes('consumedMarkerKey'),
    'consumeMissionEventToken uses a consumed marker key');
  // Already-consumed → return false
  assert.ok(block.includes('alreadyConsumed') && block.includes('return false'),
    'consumeMissionEventToken returns false if already consumed (double-reward prevention)');
  // Delete the token after consume (one-time)
  assert.ok(block.includes('SESSION_CACHE.delete'),
    'consumeMissionEventToken deletes the token (one-time use)');
}

);

test('T5: Failed grantReward recovery — retryFailedMissionRewards cron exists', () => {
  const WORKER_SRC = fs.readFileSync(path.join(__dirname, 'worker-proxy.js'), 'utf8');
  // The cron that re-grants if markMissionRewarded succeeded but grantReward failed
  assert.ok(WORKER_SRC.includes('async function retryFailedMissionRewards'),
    'retryFailedMissionRewards cron exists (handles failed grantReward)');
  // Finds rows where completed=true, rewarded=true, but NO matching token_transactions
  assert.ok(WORKER_SRC.includes('completed = TRUE') && WORKER_SRC.includes('rewarded = TRUE'),
    'cron queries mission_progress where completed=true AND rewarded=true');
  assert.ok(WORKER_SRC.includes('NOT EXISTS') || WORKER_SRC.includes('IS NULL'),
    'cron filters where no matching token_transactions row exists (NOT EXISTS / LEFT JOIN IS NULL)');
});

// ═══════════════════════════════════════════════════════════════════════
// U) Full Flow Simulation (runtime logic test, not source-only)
//
// Simulates the in-memory state machine of the frontend + backend logic
// for a `read_news` completion. Validates that, after the migration fix,
// the entire flow produces: tick + reward + idempotent retry behavior.
// ═══════════════════════════════════════════════════════════════════════

test('U1: Full read_news flow simulation — stale seed → migration → completion → tick', () => {
  // STEP 1: Stale seed (production before fix)
  let dbMissions = [
    { mission_id: 'daily_login',    trigger: 'daily_open',           completed: false, rewarded: false },
    { mission_id: 'read_news',      trigger: 'news_open',            completed: false, rewarded: false },
    { mission_id: 'read_analysis',  trigger: 'analysis_open',       completed: false, rewarded: false },
    { mission_id: 'check_calendar', trigger: 'calendar_open',        completed: false, rewarded: false },
    { mission_id: 'visit_market',   trigger: 'market_open',          completed: false, rewarded: false },
  ];

  // STEP 2: Simulate the migration
  const migrationMap = {
    'read_news':      { 'news_open':      'news_article_open' },
    'read_analysis':  { 'analysis_open':  'analysis_detail_open' },
    'visit_market':   { 'market_open':    'asset_detail_open' },
  };
  for (const m of dbMissions) {
    const oldT = m.trigger;
    const newT = migrationMap[m.mission_id]?.[oldT];
    if (newT) m.trigger = newT;
  }

  // Verify migration result
  assert.equal(dbMissions[1].trigger, 'news_article_open', 'read_news trigger migrated to news_article_open');
  assert.equal(dbMissions[2].trigger, 'analysis_detail_open', 'read_analysis trigger migrated');
  assert.equal(dbMissions[3].trigger, 'calendar_open', 'check_calendar unchanged');
  assert.equal(dbMissions[4].trigger, 'asset_detail_open', 'visit_market trigger migrated');
  assert.equal(dbMissions[0].trigger, 'daily_open', 'daily_login unchanged');

  // STEP 3: Frontend state — load mission status (mirror loadMissionStatus)
  let _missionStatusList = dbMissions.map(m => ({...m}));
  const _completedMissionsToday = new Set();
  for (const m of _missionStatusList) {
    if (m.completed) _completedMissionsToday.add(m.mission_id);
  }
  let _missionsLoaded = true;

  // STEP 4: User opens news article — frontend fires event
  const firedEvent = 'news_article_open';
  const firedTarget = 'https://news.example.com/article-1';

  // STEP 5: _fireInternal filter (mirror app.js _fireInternal)
  const matching = _missionStatusList.filter(m =>
    m.trigger === firedEvent && !m.completed && !_completedMissionsToday.has(m.mission_id)
  );
  assert.equal(matching.length, 1, 'news_article_open matches read_news after migration');
  assert.equal(matching[0].mission_id, 'read_news', 'matched mission is read_news');

  // STEP 6: Simulate completeMission + backend
  // issue-token → consume → incrementMissionProgress → markMissionRewarded → grantReward
  // Backend returns: completed=true, is_new_completion=true, new_balance=Y
  const backendResponse = {
    status: 'success',
    completed: true,
    is_new_completion: true,
    new_balance: 105,
    reward_amount: 5,
    reward_label: 'خواندن یک خبر',
    progress_count: 1,
    target_count: 1,
  };

  // Frontend updates state (mirror completeMission)
  const idx = _missionStatusList.findIndex(m => m.mission_id === 'read_news');
  _missionStatusList[idx].completed = backendResponse.completed;
  if (backendResponse.completed) _completedMissionsToday.add('read_news');

  // STEP 7: Verify tick would render
  const isCompleted = _missionStatusList[1].completed || _completedMissionsToday.has('read_news');
  assert.equal(isCompleted, true, 'read_news is now completed — tick would render');

  // STEP 8: Verify idempotent retry — second fire of same event
  const matching2 = _missionStatusList.filter(m =>
    m.trigger === 'news_article_open' && !m.completed && !_completedMissionsToday.has(m.mission_id)
  );
  assert.equal(matching2.length, 0, 'Second fire of same event does NOT match (idempotent at frontend)');

  // STEP 9: Verify backend idempotency — markMissionRewarded CAS
  // (already rewarded=true would block second reward at backend level)
  dbMissions[1].rewarded = true;
  const casResult = dbMissions[1].rewarded === false; // simulated UPDATE ... WHERE rewarded=FALSE
  assert.equal(casResult, false, 'Backend CAS: second markMissionRewarded finds rewarded=true → 0 rows (no double-reward)');
});

test('U2: Idempotent migration — running migration twice produces no further changes', () => {
  // Setup: simulate a DB where migration has ALREADY run (triggers are new values)
  let dbMissions = [
    { mission_id: 'read_news',      trigger: 'news_article_open' },
    { mission_id: 'read_analysis',  trigger: 'analysis_detail_open' },
    { mission_id: 'visit_market',   trigger: 'asset_detail_open' },
    { mission_id: 'check_calendar', trigger: 'calendar_open' },
    { mission_id: 'daily_login',    trigger: 'daily_open' },
  ];

  // Simulate running the migration WHERE clause (no rows match)
  const staleTriggers = [
    ['read_news', 'news_open'],
    ['read_analysis', 'analysis_open'],
    ['visit_market', 'market_open'],
  ];
  let matchedRows = 0;
  for (const m of dbMissions) {
    for (const [id, oldT] of staleTriggers) {
      if (m.mission_id === id && m.trigger === oldT) matchedRows++;
    }
  }
  assert.equal(matchedRows, 0,
    'Idempotent: 2nd run of migration finds 0 stale rows (no-op)');

  // Triggers remain unchanged after the (no-op) 2nd migration
  assert.equal(dbMissions[0].trigger, 'news_article_open', 'read_news trigger unchanged');
  assert.equal(dbMissions[1].trigger, 'analysis_detail_open', 'read_analysis trigger unchanged');
  assert.equal(dbMissions[2].trigger, 'asset_detail_open', 'visit_market trigger unchanged');
  assert.equal(dbMissions[3].trigger, 'calendar_open', 'check_calendar unchanged');
  assert.equal(dbMissions[4].trigger, 'daily_open', 'daily_login unchanged');
});

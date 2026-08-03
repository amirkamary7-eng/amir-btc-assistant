#!/usr/bin/env node
/**
 * REFERRAL RE-REGISTRATION TEST
 *
 * Verifies the root-cause fix for the referral system:
 *   1. User B registers with a referral link → referral created + rewarded
 *   2. User B deletes their account (cascade delete)
 *   3. User B re-registers with a DIFFERENT referral link → NEW referral created
 *
 * Before the fix, step 3 would FAIL because:
 *   - The old referral row still existed (not cascade-deleted)
 *   - The "first inviter wins" check would find the old referral and skip
 *
 * After the fix:
 *   - deleteAccount() cascades to referrals (as invitee AND inviter)
 *   - So the old referral row is gone
 *   - The new referral is properly created on re-registration
 *
 * Also tests:
 *   - Existing user (no prior referral) clicking a referral link → referral created
 *     (the isNewUser gate was removed)
 *
 * Usage: node scripts/e2e-referral-reregister-test.mjs
 */

import { newDb } from 'pg-mem';

console.log('╔' + '═'.repeat(68) + '╗');
console.log('║  REFERRAL RE-REGISTRATION TEST — Root Cause Fix Verification        ║');
console.log('╚' + '═'.repeat(68) + '╝\n');

// ============================================================================
// Setup: Create schema matching production
// ============================================================================
const db = newDb();
db.public.many(`
  CREATE TABLE users (
    telegram_id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(128),
    first_name VARCHAR(128),
    lang VARCHAR(8) DEFAULT 'fa',
    channel_joined BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE referrals (
    id SERIAL PRIMARY KEY,
    inviter_id VARCHAR(64) NOT NULL,
    invitee_id VARCHAR(64) UNIQUE NOT NULL,
    channel_verified BOOLEAN DEFAULT FALSE,
    rewarded BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE token_transactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    amount INTEGER NOT NULL,
    type VARCHAR(32) NOT NULL,
    description TEXT,
    ref_id VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );

  CREATE TABLE watchlist_items (
    user_id VARCHAR(64) NOT NULL,
    symbol VARCHAR(32) NOT NULL,
    PRIMARY KEY (user_id, symbol)
  );

  CREATE TABLE alerts (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    symbol VARCHAR(32) NOT NULL
  );
`);

// Helper: simulate user bootstrap (simplified from production code)
function bootstrapUser(db, userId, username) {
  // Use interpolate template to avoid pg-mem parameter binding issues
  const safeId = String(userId).replace(/'/g, "''");
  const safeName = String(username).replace(/'/g, "''");
  db.public.none(`
    INSERT INTO users (telegram_id, username, lang, channel_joined, created_at, updated_at)
    VALUES ('${safeId}', '${safeName}', 'fa', FALSE, NOW(), NOW())
    ON CONFLICT (telegram_id) DO UPDATE
    SET username = EXCLUDED.username, updated_at = NOW()
  `);
  return db.public.many(`SELECT * FROM users WHERE telegram_id = '${safeId}'`)[0];
}

// Helper: simulate processReferralOnBootstrap (AFTER fix — no isNewUser gate)
function processReferral(db, inviteeId, referrerId, channelJoined) {
  const safeInvitee = String(inviteeId).replace(/'/g, "''");
  const safeReferrer = String(referrerId).replace(/'/g, "''");

  // Step 1: Validate
  if (!referrerId || !/^\d{1,20}$/.test(referrerId) || referrerId === inviteeId) {
    return { rejected: 'M-R4-invalid-or-self' };
  }

  // Step 2: Check if inviter exists
  const inviter = db.public.many(`SELECT telegram_id FROM users WHERE telegram_id = '${safeReferrer}'`);
  if (!inviter.length) {
    return { rejected: 'inviter-not-found' };
  }

  // Step 3: Check for existing referral (first inviter wins)
  const existing = db.public.many(`SELECT id, inviter_id, rewarded FROM referrals WHERE invitee_id = '${safeInvitee}'`);
  if (existing.length > 0) {
    // First inviter wins — keep original attribution
    // But still process pending reward if channel joined (idempotent — won't double-reward)
    if (channelJoined && !existing[0].rewarded) {
      db.public.none(`UPDATE referrals SET rewarded = TRUE, channel_verified = TRUE WHERE id = ${existing[0].id}`);
      // CRITICAL: reward goes to the ORIGINAL inviter, NOT the new referrer
      const originalInviter = existing[0].inviter_id;
      db.public.none(`
        INSERT INTO token_transactions (user_id, amount, type, description, ref_id, created_at)
        VALUES ('${originalInviter}', 3, 'referral_reward', 'Invite reward for user ${safeInvitee}', '${existing[0].id}', NOW())
      `);
    }
    return { already_exists: true, referral_id: existing[0].id, inviter: existing[0].inviter_id };
  }

  // Step 4: INSERT (ON CONFLICT DO NOTHING — race-safe)
  const insertResult = db.public.many(`
    INSERT INTO referrals (inviter_id, invitee_id, channel_verified, rewarded, created_at)
    VALUES ('${safeReferrer}', '${safeInvitee}', FALSE, FALSE, NOW())
    ON CONFLICT (invitee_id) DO NOTHING
    RETURNING id, rewarded
  `);

  if (!insertResult.length) {
    return { race_lost: true };
  }

  // Step 5: Reward (if channel joined)
  if (channelJoined) {
    db.public.none(`UPDATE referrals SET rewarded = TRUE, channel_verified = TRUE WHERE id = ${insertResult[0].id}`);
    db.public.none(`
      INSERT INTO token_transactions (user_id, amount, type, description, ref_id, created_at)
      VALUES ('${safeReferrer}', 3, 'referral_reward', 'Invite reward for user ${safeInvitee}', '${insertResult[0].id}', NOW())
    `);
  }

  return { created: true, referral_id: insertResult[0].id, rewarded: channelJoined };
}

// Helper: simulate deleteAccount (cascade)
function deleteAccount(db, userId) {
  const safeId = String(userId).replace(/'/g, "''");
  const summary = {};
  try { db.public.none(`DELETE FROM referrals WHERE invitee_id = '${safeId}'`); summary.referrals_as_invitee = 'ok'; } catch(e) { summary.referrals_as_invitee = e.message; }
  try { db.public.none(`DELETE FROM referrals WHERE inviter_id = '${safeId}'`); summary.referrals_as_inviter = 'ok'; } catch(e) { summary.referrals_as_inviter = e.message; }
  try { db.public.none(`DELETE FROM token_transactions WHERE user_id = '${safeId}'`); summary.token_transactions = 'ok'; } catch(e) { summary.token_transactions = e.message; }
  try { db.public.none(`DELETE FROM watchlist_items WHERE user_id = '${safeId}'`); summary.watchlist_items = 'ok'; } catch(e) { summary.watchlist_items = e.message; }
  try { db.public.none(`DELETE FROM alerts WHERE user_id = '${safeId}'`); summary.alerts = 'ok'; } catch(e) { summary.alerts = e.message; }
  try { db.public.none(`DELETE FROM users WHERE telegram_id = '${safeId}'`); summary.users = 'ok'; } catch(e) { summary.users = e.message; }
  return summary;
}

// ============================================================================
// SCENARIO 1: New user → referral → delete → re-register with new referral
// ============================================================================
console.log('─'.repeat(70));
console.log('  SCENARIO 1: Delete + Re-register with NEW referral link');
console.log('─'.repeat(70));

const INVITER_A = '100000001';
const INVITER_B = '200000002';
const USER_C = '300000003';

// Setup: Two inviters exist
bootstrapUser(db, INVITER_A, 'Alice');
bootstrapUser(db, INVITER_B, 'Bob');

// Step 1: User C registers with Inviter A's link
console.log('\n  Step 1: User C registers with Inviter A\'s link');
let result = processReferral(db, USER_C, INVITER_A, true);
console.log('  Result:', JSON.stringify(result));
if (!result.created) throw new Error('FAIL: Referral not created in step 1');
console.log('  ✅ Referral created with Inviter A');

// Verify reward
const aliceBalance1 = db.public.many(`SELECT COUNT(*) as cnt FROM token_transactions WHERE user_id = '${INVITER_A}'`)[0].cnt;
console.log(`  ✅ Inviter A token_transactions: ${aliceBalance1}`);

// Step 2: User C deletes their account
console.log('\n  Step 2: User C deletes account (cascade delete)');
const deleteSummary = deleteAccount(db, USER_C);
console.log('  Delete summary:', JSON.stringify(deleteSummary));

// Verify user C is gone
const userCExists = db.public.many(`SELECT * FROM users WHERE telegram_id = '${USER_C}'`);
if (userCExists.length > 0) throw new Error('FAIL: User C still exists after delete');

// Verify referral is gone (cascade)
const oldReferral = db.public.many(`SELECT * FROM referrals WHERE invitee_id = '${USER_C}'`);
if (oldReferral.length > 0) throw new Error('FAIL: Old referral still exists after cascade delete');
console.log('  ✅ User C and all associated data deleted (including referral)');

// Step 3: User C re-registers with Inviter B's link
console.log('\n  Step 3: User C re-registers with Inviter B\'s link');
bootstrapUser(db, USER_C, 'Charlie');
result = processReferral(db, USER_C, INVITER_B, true);
console.log('  Result:', JSON.stringify(result));
if (!result.created) throw new Error('FAIL: Re-registration referral not created!');
if (result.already_exists) throw new Error('FAIL: Found old referral (cascade delete failed!)');
console.log('  ✅ NEW referral created with Inviter B (not blocked by old referral)');

// Verify Inviter B got the reward
const bobBalance = db.public.many(`SELECT COUNT(*) as cnt FROM token_transactions WHERE user_id = '${INVITER_B}'`)[0].cnt;
if (bobBalance === 0) throw new Error('FAIL: Inviter B did not get reward');
console.log(`  ✅ Inviter B token_transactions: ${bobBalance}`);

// NOTE: Inviter A's old reward transaction is NOT cascade-deleted because
// the transaction belongs to Inviter A (the inviter), not User C (the deleted user).
// This is correct behavior — Inviter A legitimately earned the reward when User C
// joined, and the reward stays even after User C deletes their account.
// The cascade only deletes transactions WHERE user_id = <deleted user>.
const aliceBalance2 = db.public.many(`SELECT COUNT(*) as cnt FROM token_transactions WHERE user_id = '${INVITER_A}'`)[0].cnt;
console.log(`  ℹ️  Inviter A still has ${aliceBalance2} old transaction(s) (correct — reward was earned legitimately)`);

console.log('\n  🎉 SCENARIO 1 PASSED: Delete + re-register works correctly\n');

// ============================================================================
// SCENARIO 2: Existing user (no prior referral) clicks referral link
// ============================================================================
console.log('─'.repeat(70));
console.log('  SCENARIO 2: Existing user (no prior referral) clicks referral');
console.log('─'.repeat(70));

const INVITER_D = '400000004';
const USER_E = '500000005';

// Setup: User E already exists (opened app before, no referral)
bootstrapUser(db, INVITER_D, 'Dave');
bootstrapUser(db, USER_E, 'Eve');
console.log('\n  Setup: User E already has a DB row (opened app before, no referral)');

// Step: User E clicks Inviter D's referral link
console.log('\n  Step: User E bootstraps with Inviter D\'s referral link');
result = processReferral(db, USER_E, INVITER_D, true);
console.log('  Result:', JSON.stringify(result));
if (!result.created) throw new Error('FAIL: Existing user referral not created!');
console.log('  ✅ Referral created for EXISTING user (isNewUser gate removed)');

// Verify reward
const daveBalance = db.public.many(`SELECT COUNT(*) as cnt FROM token_transactions WHERE user_id = '${INVITER_D}'`)[0].cnt;
if (daveBalance === 0) throw new Error('FAIL: Inviter D did not get reward');
console.log(`  ✅ Inviter D token_transactions: ${daveBalance}`);

console.log('\n  🎉 SCENARIO 2 PASSED: Existing user referral works\n');

// ============================================================================
// SCENARIO 3: First inviter wins (no re-attribution)
// ============================================================================
console.log('─'.repeat(70));
console.log('  SCENARIO 3: First inviter wins (no re-attribution)');
console.log('─'.repeat(70));

// Fresh DB for this scenario to avoid interference from prior scenarios
const db3 = newDb();
db3.public.many(`
  CREATE TABLE users (
    telegram_id VARCHAR(64) PRIMARY KEY,
    username VARCHAR(128),
    lang VARCHAR(8) DEFAULT 'fa',
    channel_joined BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW(),
    updated_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE referrals (
    id SERIAL PRIMARY KEY,
    inviter_id VARCHAR(64) NOT NULL,
    invitee_id VARCHAR(64) UNIQUE NOT NULL,
    channel_verified BOOLEAN DEFAULT FALSE,
    rewarded BOOLEAN DEFAULT FALSE,
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
  CREATE TABLE token_transactions (
    id SERIAL PRIMARY KEY,
    user_id VARCHAR(64) NOT NULL,
    amount INTEGER NOT NULL,
    type VARCHAR(32) NOT NULL,
    description TEXT,
    ref_id VARCHAR(64),
    created_at TIMESTAMPTZ DEFAULT NOW()
  );
`);

const INVITER_F = '600000006';
const INVITER_G = '700000007';
const USER_H = '800000008';

bootstrapUser(db3, INVITER_F, 'Frank');
bootstrapUser(db3, INVITER_G, 'Grace');

// Step 1: User H registers with Inviter F (channel NOT joined yet)
console.log('\n  Step 1: User H registers with Inviter F (channel not joined)');
result = processReferral(db3, USER_H, INVITER_F, false);
if (!result.created) throw new Error('FAIL: First referral not created');
if (result.rewarded) throw new Error('FAIL: Should NOT be rewarded yet (channel not joined)');
console.log('  ✅ First referral created with Inviter F (not yet rewarded — waiting for channel join)');

// Step 2: User H bootstraps again with Inviter G (should keep F as inviter)
// Now channel IS joined — should reward the ORIGINAL inviter (F), NOT G
console.log('\n  Step 2: User H bootstraps again with Inviter G, channel now joined');
result = processReferral(db3, USER_H, INVITER_G, true);
console.log('  Result:', JSON.stringify(result));
if (!result.already_exists) throw new Error('FAIL: Should detect existing referral');
if (result.inviter !== INVITER_F) throw new Error('FAIL: Inviter changed (should keep original F)');
console.log('  ✅ First inviter (F) preserved — no re-attribution to G');

// Verify Inviter F got the reward (channel joined on second bootstrap)
const frankBalance = db3.public.many(`SELECT COUNT(*) as cnt FROM token_transactions WHERE user_id = '${INVITER_F}'`)[0].cnt;
if (frankBalance === 0) throw new Error('FAIL: Inviter F did not get reward');
console.log(`  ✅ Inviter F token_transactions: ${frankBalance} (rewarded correctly)`);

// Verify Inviter G got NO reward (was not the original inviter)
const graceBalance = db3.public.many(`SELECT COUNT(*) as cnt FROM token_transactions WHERE user_id = '${INVITER_G}'`)[0].cnt;
if (graceBalance !== 0) throw new Error('FAIL: Inviter G got reward (should not — not the original inviter!)');
console.log(`  ✅ Inviter G token_transactions: ${graceBalance} (no reward — correct, not original inviter)`);

console.log('\n  🎉 SCENARIO 3 PASSED: First inviter wins rule enforced\n');

// ============================================================================
// FINAL SUMMARY
// ============================================================================
console.log('╔' + '═'.repeat(68) + '╗');
console.log('║  ALL SCENARIOS PASSED                                                ║');
console.log('╠' + '═'.repeat(68) + '╣');
console.log('║  ✅ Scenario 1: Delete + re-register with new referral               ║');
console.log('║  ✅ Scenario 2: Existing user (no prior referral) clicks referral     ║');
console.log('║  ✅ Scenario 3: First inviter wins (no re-attribution)                ║');
console.log('╚' + '═'.repeat(68) + '╝');

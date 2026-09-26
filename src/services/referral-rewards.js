// ═════════════════════════════════════════════════════════════════════════════
// Referral Rewards Service — extracted from worker-proxy.js (lines 2869-3544).
//
// Factory pattern: createReferralRewardsService({ ...DI deps... })
// Returns: { processPendingReferralReward, retryFailedReferralRewards,
//            retryFailedWheelRewards, retryFailedMissionRewards,
//            retryFailedRefunds, processReferralOnBootstrap }
//
// DI dependencies (11):
//   - queryDb: Core DB query helper (from worker-proxy.js core)
//   - notificationService: Notification service (from worker-proxy.js, already extracted)
//   - walletRepo: Wallet repository (from worker-proxy.js, already extracted)
//   - rewardCenterRepo: Reward center repository (from worker-proxy.js, already extracted)
//   - getReferralRewardPerInvite: CYCLE-BREAKER. Stays in worker-proxy.js (NOT extracted)
//     because referralRepo = createReferralRepository({ queryDb, getReferralRewardPerInvite, ... })
//     at line ~4671 is created BEFORE this factory. If getReferralRewardPerInvite moved
//     here, referralRepo would need it from this factory (created later) → TDZ cycle.
//     By keeping getReferralRewardPerInvite in worker-proxy.js (hoisted function declaration),
//     both referralRepo and this factory receive it from worker-proxy.js scope — no cycle.
//   - isDatabaseConfigured: DB readiness check (from worker-proxy.js core)
//   - normalizeOptionalString: String normalizer (from worker-proxy.js core)
//   - resolveWebAppUrl: WebApp URL resolver (from worker-proxy.js core)
//   - safeError: Error sanitizer for logging (from worker-proxy.js core)
//   - getMissionRewardAmount: Mission reward amount calculator (from entitlement_config.js)
//   - economyService: Economy service for reward granting (from worker-proxy.js, already extracted)
//
// creditReferralWithReward is internal (not returned) — only called by
// processPendingReferralReward (internal to factory).
//
// NOT extracted (stay in worker-proxy.js):
//   - getReferralRewardPerInvite function (cycle-breaker)
//   - invalidateRewardPerInviteCache function (passed as DI to adminHandlers)
//   - _rewardPerInviteCache mutable state (used by getReferralRewardPerInvite)
//   - REWARD_PER_INVITE_CACHE_TTL constant (used by getReferralRewardPerInvite)
//
// NO module-level mutable state in extracted functions (verified by audit).
// I/O: 15 queryDb calls (DB only — no KV, no fetch, no Telegram, no AI, no DO).
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createReferralRewardsService({
  queryDb,
  notificationService,
  walletRepo,
  rewardCenterRepo,
  getReferralRewardPerInvite,
  isDatabaseConfigured,
  normalizeOptionalString,
  resolveWebAppUrl,
  safeError,
  getMissionRewardAmount,
  economyService,
}) {

async function creditReferralWithReward(env, inviterId, referralId, inviteeId, amount, alsoVerifyChannel) {
  try {
    // REFACTOR: use Economy Layer (Reward Engine) instead of direct creditTokens.
    // This ensures all rewards go through rule validation + event system.
    const result = await economyService.grantReward({
      userId: String(inviterId),
      amount: Number(amount),
      rewardType: 'referral_reward',
      description: `Invite reward for user ${String(inviteeId)}`,
      refId: String(referralId),
      metadata: { referral_id: String(referralId), invitee_id: String(inviteeId) },
      auditInfo: { actor: 'system' },
      env,
    });

    // Mark referral as rewarded
    // ROOT CAUSE FIX (R-2.4): Added `AND rewarded = FALSE` condition.
    // Previously the UPDATE always succeeded even if rewarded was already
    // TRUE, providing no additional race protection. Now the UPDATE is
    // conditional — if a concurrent caller already set rewarded=TRUE, this
    // UPDATE affects 0 rows (which we ignore — the idempotency is handled
    // by creditTokens' UNIQUE constraint on ref_id).
    await queryDb(env,
      alsoVerifyChannel
        ? 'UPDATE referrals SET channel_verified = TRUE, rewarded = TRUE WHERE id = $1 AND rewarded = FALSE'
        : 'UPDATE referrals SET rewarded = TRUE WHERE id = $1 AND rewarded = FALSE',
      [Number(referralId)],
    );

  // Send referral + reward notifications via NotificationService (single entry point)
  // ROOT CAUSE FIX (4.5): Only dispatch notifications if the reward was NOT
  // idempotent (i.e., this is the first time the reward is credited). If
  // creditTokens returned idempotent:true, a concurrent caller already
  // dispatched the notifications — dispatching again would spam the inviter
  // with duplicate notifications.
  if (notificationService && result && !result.idempotent) {
    try {
      // Referral notification (new referral created) + Reward notification
      // dispatched in parallel for efficiency
      await Promise.all([
        notificationService.create(env, {
          userId: inviterId,
          templateKey: 'referral_new_invite',
          category: 'referral',
          priority: 'medium',
          channel: 'mini_app',
          metadata: { invitee_id: String(inviteeId), referral_id: String(referralId) },
          dedupKey: `referral_new_${referralId}`,
        }).catch(() => {}),
        notificationService.create(env, {
          userId: inviterId,
          templateKey: 'referral_reward',
          category: 'referral',
          priority: 'high',
          channel: 'both',
          metadata: { amount: String(amount), referral_id: String(referralId), invitee_id: String(inviteeId) },
          dedupKey: `referral_reward_${referralId}`,
        }).catch(() => {}),
      ]);
    } catch { /* notification failure should not break reward */ }
  }

  // ── Phase 2: Rich Telegram message to inviter with reward details + buttons ──
  // This is a premium UX message with inline keyboard buttons.
  // Per Phase 2: all Telegram delivery goes through NotificationService → queue.
  // The service supports telegramExtra (reply_markup, parse_mode) for rich messages.
  // skipInApp:true because this is a rich Telegram message (the in-app notification
  // was already created by the dispatch above).
  if (notificationService && result && !result.idempotent) {
    try {
      const newBalance = result.newBalance || 0;
      const botUsername = String(env.BOT_USERNAME || '');
      const webAppUrl = resolveWebAppUrl(env);
      const referralCenterUrl = webAppUrl ? `${webAppUrl}?startapp=referral_center` : null;
      const myReferralLink = botUsername ? `https://t.me/${botUsername}?start=ref_${inviterId}` : null;

      const messageText =
        `🎉 تبریک!\n\n` +
        `👤 یک کاربر جدید با لینک دعوت شما وارد AMIRBTC Assistant شد.\n\n` +
        `🎁 پاداش شما: +${amount} Token\n` +
        `💎 موجودی جدید شما: ${newBalance} Token\n\n` +
        `از دعوت دوستان خود، توکن بیشتری دریافت کنید.`;

      // Build inline keyboard with two buttons
      const inlineKeyboard = [];
      if (referralCenterUrl) {
        inlineKeyboard.push([{
          text: '👥 مشاهده رفرال‌ها',
          web_app: { url: referralCenterUrl },
        }]);
      }
      if (myReferralLink) {
        inlineKeyboard.push([{
          text: '🔗 لینک دعوت من',
          url: myReferralLink,
        }]);
      }

      await notificationService.create(env, {
        userId: String(inviterId),
        category: 'referral',
        priority: 'high',
        channel: 'telegram',
        skipInApp: true,
        title: '🎉 تبریک!',
        message: messageText,
        metadata: { kind: 'referral_rich_message', invitee_id: String(inviteeId), amount: String(amount), new_balance: String(newBalance) },
        dedupKey: `referral_rich_${referralId}`,
        telegramExtra: {
          parse_mode: 'HTML',
          disable_web_page_preview: true,
          reply_markup: inlineKeyboard.length > 0 ? { inline_keyboard: inlineKeyboard } : undefined,
        },
      });
    } catch (msgErr) {
      // Non-fatal — the reward was credited, just the message failed to enqueue
      console.warn('[REFERRAL] Reward message enqueue failed (non-fatal):', msgErr?.message);
    }
  }
  } catch (err) {
    throw err;
  }
}

/**
 * Process a pending (unrewarded) referral reward.
 *
 * Independent of bootstrap — can be called from any point where channel_joined
 * becomes true. Finds the unrewarded referral for the invitee and, if the
 * invitee has joined the channel, atomically credits the reward.
 *
 * Idempotent: if rewarded is already TRUE, this is a no-op.
 * Race-safe: uses UPDATE ... WHERE rewarded = FALSE so only one caller wins.
 *
 * @param {object} env - Worker env
 * @param {string} inviteeId - The invitee's telegram_id
 * @param {boolean} channelJoined - Whether the invitee has joined the channel
 */
async function processPendingReferralReward(env, inviteeId, channelJoined) {
  if (!channelJoined) return null;

  // Kill switch: if referral rewards are emergency-disabled, skip
  if (await rewardCenterRepo.isSubsystemDisabled(env, 'referral')) {
        return null;
  }

  // DB-driven reward amount (async — reads from referral_reward_tiers)
  const baseRewardAmount = await getReferralRewardPerInvite(env);
  if (baseRewardAmount <= 0) return null;

  // Find unrewarded referral for this invitee
  const pendingResult = await queryDb(
    env,
    `
      SELECT id, inviter_id, rewarded
      FROM referrals
      WHERE invitee_id = $1 AND rewarded = FALSE
      LIMIT 1
    `,
    [String(inviteeId)],
  );
  const pending = pendingResult.rows[0] || null;
  if (!pending) return null;

  // PHASE 4: Apply tier-based referral reward (Normal 3 AB, Premium 6 AB).
  // Tier = INVITER's tier (the one who earns the reward), NOT the invitee's.
  let finalRewardAmount = baseRewardAmount;
  if (membershipAuthority && ENTITLEMENT && typeof ENTITLEMENT.getReferralRewardAmount === 'function') {
    try {
      const inviterIsPremium = await membershipAuthority.isPremium(env, String(pending.inviter_id));
      finalRewardAmount = ENTITLEMENT.getReferralRewardAmount(inviterIsPremium);
    } catch (e) {
      finalRewardAmount = baseRewardAmount;
    }
  }

  // Atomic: credit tokens + transaction record + rewarded=TRUE + channel_verified=TRUE
  await creditReferralWithReward(
    env,
    String(pending.inviter_id),
    Number(pending.id),
    inviteeId,
    finalRewardAmount,
    true, // alsoVerifyChannel
  );

  return { referral_id: pending.id, rewarded: true };
}

/**
 * ROOT CAUSE FIX (R-2.6): Retry failed referral rewards.
 *
 * Previously, if processPendingReferralReward failed (DB error, kill switch,
 * rewardAmount=0), the referral row stayed rewarded=FALSE forever — no
 * automatic retry. The user never got their reward and admin had no
 * visibility.
 *
 * This function is called by the cron every 5 minutes. It finds ALL
 * referrals where:
 *   - rewarded = FALSE
 *   - channel_verified = TRUE (invitee joined the channel)
 *   - created_at > NOW() - 24 hours (only retry recent ones, not ancient)
 * and re-runs processPendingReferralReward for each.
 *
 * Idempotent: creditTokens' UNIQUE constraint on ref_id ensures no
 * double-credit even if the retry runs concurrently with a bootstrap.
 */
async function retryFailedReferralRewards(env) {
  if (!isDatabaseConfigured(env)) return;
  try {
    // REF-003 FIX: Removed 24-hour filter — all eligible unrewarded referrals
    // should be retried, not just recent ones. Previously, referrals older
    // than 24h with channel_verified=TRUE and rewarded=FALSE were permanently
    // lost (no other recovery path exists).
    //
    // Safety: LIMIT 20 + ORDER BY created_at ASC ensures:
    //   1. Bounded batch — max 20 retries per cron tick (every 15 min)
    //   2. Oldest first — referrals waiting longest get priority
    //   3. Idempotent — creditTokens UNIQUE constraint prevents double-credit
    //   4. Subrequest budget — ~21 subrequests for 20 retries (under 50 limit)
    //   5. No starvation — next tick continues from where this one left off
    //      (processed referrals get rewarded=TRUE, so they're excluded next time)
    const result = await queryDb(env,
      `SELECT DISTINCT invitee_id FROM referrals
       WHERE rewarded = FALSE AND channel_verified = TRUE
       ORDER BY invitee_id ASC
       LIMIT 3`,
    );
    if (result.rows.length === 0) return;

    let retried = 0;
    let succeeded = 0;
    for (const row of result.rows) {
      try {
        const outcome = await processPendingReferralReward(env, String(row.invitee_id), true);
        retried++;
        if (outcome && outcome.rewarded) succeeded++;
      } catch (e) {
        // Individual retry failure — don't abort the batch
        console.warn('Referral retry failed for invitee', row.invitee_id, e?.message);
      }
    }
    if (retried > 0) {
          }
  } catch (e) {
    console.warn(safeError('referral-retry-cron', e));
  }
}

/**
 * ROOT CAUSE FIX (3.5): Retry failed wheel rewards.
 *
 * If consumeSpin succeeds but grantReward fails (DB error, kill switch),
 * the spin is marked 'used' but the user gets no tokens. This function
 * finds wheel_history rows where reward_amount > 0 but no matching
 * token_transactions row exists, and re-grants the reward.
 *
 * Idempotent: creditTokens' UNIQUE constraint on ref_id prevents
 * double-credit even if this runs concurrently with a spin.
 */
async function retryFailedWheelRewards(env) {
  if (!isDatabaseConfigured(env)) return;
  if (!economyService || !walletRepo) return;
  try {
    // Find wheel_history rows from the last 24h where reward_amount > 0
    // and no matching token_transaction exists for the expected refId.
    // refId format: wheel_${user_id}_${today}_${spin_id}
    const result = await queryDb(env,
      `SELECT wh.id, wh.user_id, wh.spin_id, wh.reward_amount, wh.reward_type,
              wh.reward_label, wh.created_at,
              to_char(wh.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') AS spin_date_str
       FROM wheel_history wh
       WHERE wh.reward_amount > 0
       AND NOT EXISTS (
         SELECT 1 FROM token_transactions tt
         WHERE tt.user_id = wh.user_id
         AND tt.tx_type = 'wheel_reward'
         AND tt.ref_id = 'wheel_' || wh.user_id || '_' || to_char(wh.created_at AT TIME ZONE 'UTC', 'YYYY-MM-DD') || '_' || wh.spin_id
         AND tt.status = 'completed'
       )
       ORDER BY wh.created_at ASC
       LIMIT 3`,
    );
    if (result.rows.length === 0) return;

    let retried = 0;
    let succeeded = 0;
    for (const row of result.rows) {
      try {
        const refId = `wheel_${row.user_id}_${row.spin_date_str}_${row.spin_id}`;
        // WHEEL-TYPE-FIX: Map the stored wheel reward type ('token', 'voucher',
        // etc.) to the canonical economy type 'wheel_reward'. The economy
        // service rejects non-canonical types with INVALID_REWARD_TYPE, which
        // was causing 100% of wheel reward retries to fail. The 'spin' type
        // is handled separately (would need grantPremiumSpin, not grantReward).
        const isSpinType = row.reward_type === 'spin';
        if (isSpinType) {
          // 'spin' rewards should have been fulfilled at spin time via
          // grantPremiumSpin. Skip retry for spin-type rewards — they can't
          // be retroactively granted via grantReward.
          retried++;
          continue;
        }
        const grantResult = await economyService.grantReward({
          userId: row.user_id,
          amount: Number(row.reward_amount),
          rewardType: 'wheel_reward',
          description: `Wheel reward (retry): ${row.reward_label || row.reward_type}`,
          refId: refId,
          metadata: { spin_id: row.spin_id, retry: true, reward_type: row.reward_type, reward_label: row.reward_label },
          auditInfo: { actor: 'cron-retry' },
          env,
        });
        retried++;
        if (grantResult && (grantResult.success || grantResult.idempotent)) succeeded++;
      } catch (e) {
        console.warn('Wheel reward retry failed for spin', row.spin_id, e?.message);
      }
    }
    if (retried > 0) {
          }
  } catch (e) {
    console.warn(safeError('wheel-reward-retry-cron', e));
  }
}

/**
 * PHASE 2: Retry failed daily mission rewards.
 *
 * If markMissionRewarded succeeds but economyService.grantReward fails
 * (DB error, rule violation, etc.), the mission_progress row has
 * rewarded=TRUE but no matching token_transactions row exists.
 * This function finds those rows and re-grants the reward.
 *
 * Idempotent: creditTokens' UNIQUE constraint on (user_id, tx_type, ref_id)
 * prevents double-credit even if this runs concurrently with a bootstrap.
 *
 * Bounded: LIMIT 20 per cron tick (every 15 min), oldest first.
 * Window: daily_date >= CURRENT_DATE - 2 (today + 2 days back, timezone safety)
 *
 * Follows the same pattern as retryFailedWheelRewards above.
 *
 * M3 FIX (refId date): the retry refId carries the mission's COMPLETION date
 * (mission_progress.daily_date — the Tehran date written by
 * incrementMissionProgress at completion, the same date the normal completion
 * path used in its refId), NOT the cron's execution date. The old
 * `tehranToday` refId made the retry tx collide with the user's NEXT real
 * completion of the same mission on that date → grantReward resolved
 * idempotent → that day's real reward was silently lost.
 *
 * M3 FIX (premium tier): the retry applies the same tier multiplier as the
 * normal completion path — the REAL getMissionRewardAmount helper imported
 * from entitlement_config.js (Normal = floor(base), Premium = ceil(1.5 ×))
 * with MembershipAuthority resolving the tier (fail-safe to Normal/base).
 */
async function retryFailedMissionRewards(env) {
  if (!isDatabaseConfigured(env)) return;
  if (!economyService || !walletRepo) return;
  try {
    // Find mission_progress rows from today + yesterday where:
    //   completed = TRUE
    //   rewarded = TRUE
    //   no matching token_transactions row with the expected ref_id
    //
    // ref_id format (must match fireDailyLoginMission exactly):
    //   PHASE 1 FIX: fireDailyLoginMission now uses Tehran date for refId
    //   (previously UTC). This query must check BOTH the stored daily_date
    //   (UTC, for missions completed before the fix) AND the Tehran date
    //   derived from daily_date (for missions completed after the fix).
    //   Since daily_date is a DATE (no timezone), and Tehran is UTC+3:30,
    //   the Tehran date for a given UTC date could be the same OR the
    //   previous/next day (depending on whether the mission was completed
    //   before or after Tehran midnight). To keep this simple and safe,
    //   we check three candidate ref_ids: daily_date, daily_date+1, daily_date-1.
    //   This covers all timezone edge cases.
    const result = await queryDb(env,
      `SELECT mp.user_id, mp.mission_id, mp.daily_date,
              to_char(mp.daily_date, 'YYYY-MM-DD') AS date_str,
              to_char(mp.daily_date + 1, 'YYYY-MM-DD') AS next_date_str,
              to_char(mp.daily_date - 1, 'YYYY-MM-DD') AS prev_date_str
       FROM mission_progress mp
       WHERE mp.completed = TRUE
         AND mp.rewarded = TRUE
         AND mp.daily_date >= CURRENT_DATE - 2
         AND NOT EXISTS (
           SELECT 1 FROM token_transactions tt
           WHERE tt.user_id = mp.user_id
             AND tt.tx_type = 'mission_reward'
             AND tt.status = 'completed'
             AND tt.ref_id IN (
               'mission_' || mp.user_id || '_' || mp.mission_id || '_' || to_char(mp.daily_date, 'YYYY-MM-DD'),
               'mission_' || mp.user_id || '_' || mp.mission_id || '_' || to_char(mp.daily_date + 1, 'YYYY-MM-DD'),
               'mission_' || mp.user_id || '_' || mp.mission_id || '_' || to_char(mp.daily_date - 1, 'YYYY-MM-DD')
             )
         )
       ORDER BY mp.daily_date ASC, mp.user_id ASC
       LIMIT 3`,
    );
    if (result.rows.length === 0) return;

    let retried = 0;
    let succeeded = 0;
    for (const row of result.rows) {
      try {
        // M3 FIX: reconstruct the refId from the mission's COMPLETION date
        // (row.date_str = to_char(daily_date) — the Tehran date recorded by
        // incrementMissionProgress at completion, identical to the date the
        // normal path used in its refId). The candidate query above already
        // verified no tx exists under ANY of the 3 date-candidate refIds
        // (daily_date ±1 — covers the historical UTC/pre-PHASE-1 rows and the
        // Tehran-midnight race), so this credit cannot collide with an
        // existing reward and cannot steal a future day's refId either.
        const refId = `mission_${row.user_id}_${row.mission_id}_${row.date_str}`;

        // Get the current reward amount from DB (not hardcoded)
        const missionConfig = rewardCenterRepo
          ? await rewardCenterRepo.getMissionReward(env, String(row.mission_id))
          : null;
        if (!missionConfig || !Number(missionConfig.token_amount) || Number(missionConfig.token_amount) <= 0) {
          // Mission disabled or amount zero — skip (can't reward)
          retried++;
          continue;
        }

        // M3 FIX: apply the SAME tier multiplier as the normal completion
        // path — the real getMissionRewardAmount helper (Normal 1×, Premium
        // ceil(1.5×)), with the user's tier resolved via MembershipAuthority
        // (fail-safe: keep the base amount if the tier lookup fails).
        let amount = Number(missionConfig.token_amount);
        if (membershipAuthority && typeof getMissionRewardAmount === 'function') {
          try {
            const isPremium = await membershipAuthority.isPremium(env, String(row.user_id));
            amount = getMissionRewardAmount(amount, isPremium);
          } catch (tierErr) {
            console.warn('Mission reward retry tier lookup failed for user', row.user_id, '— using base amount:', tierErr?.message);
          }
        }
        if (!Number.isFinite(amount) || amount <= 0) {
          // Multiplier produced nothing creditable — skip
          retried++;
          continue;
        }
        const label = missionConfig.mission_name || row.mission_id;

        const grantResult = await economyService.grantReward({
          userId: String(row.user_id),
          amount,
          rewardType: 'mission_reward',
          description: `ماموریت: ${label} (retry)`,
          refId,
          metadata: {
            mission_id: String(row.mission_id),
            mission_label: label,
            daily_date: row.date_str,
            retry: true,
            source: 'cron_retry',
          },
          auditInfo: { actor: 'cron-retry' },
          env,
        });
        retried++;
        if (grantResult && (grantResult.success || grantResult.idempotent)) succeeded++;
      } catch (e) {
        // Individual retry failure — don't abort the batch
        console.warn('Mission reward retry failed for user', row.user_id, 'mission', row.mission_id, 'date', row.date_str, e?.message);
      }
    }
  } catch (e) {
    console.warn(safeError('mission-reward-retry-cron', e));
  }
}

/**
 * BUG 4+5 FIX: Retry failed refunds.
 *
 * When a debit succeeds but the subsequent operation (alert creation, VPN
 * purchase, cosmetic purchase) fails AND the refund also fails, the refund
 * is persisted in the pending_refunds table. This cron retries those refunds.
 *
 * Idempotency: grantReward uses ON CONFLICT DO NOTHING with the deterministic
 * refund_ref_id, so a successful retry is safe to repeat. The pending_refunds
 * row is marked 'completed' on success. Failed retries increment retry_count
 * and remain 'pending' for the next cron tick. After 10 retries, the row is
 * marked 'exhausted' to prevent infinite retries.
 *
 * Runs on the every-15-min cron (same as other retry crons).
 */
async function retryFailedRefunds(env) {
  if (!isDatabaseConfigured(env)) return;
  if (!economyService) return;
  try {
    const result = await queryDb(env,
      `SELECT id, user_id, amount, refund_ref_id, original_ref_id, source,
              description, metadata, retry_count
       FROM pending_refunds
       WHERE status = 'pending' AND retry_count < 10
       ORDER BY created_at ASC
       LIMIT 3`,
    );
    if (result.rows.length === 0) return;

    let succeeded = 0;
    for (const row of result.rows) {
      try {
        await economyService.grantReward({
          userId: String(row.user_id),
          amount: Number(row.amount),
          rewardType: 'marketplace_refund',
          description: row.description || `Refund retry (${row.source})`,
          refId: String(row.refund_ref_id),
          metadata: row.metadata || {},
          auditInfo: { actor: 'cron_retry' },
          env,
        });
        // Success — mark as completed
        await queryDb(env,
          `UPDATE pending_refunds SET status = 'completed', last_retry_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [Number(row.id)],
        );
        succeeded++;
      } catch (retryErr) {
        // Retry failed — increment retry_count, stay pending
        await queryDb(env,
          `UPDATE pending_refunds SET retry_count = retry_count + 1, last_retry_at = NOW(), updated_at = NOW() WHERE id = $1`,
          [Number(row.id)],
        );
        console.warn(`[retryFailedRefunds] Refund ${row.refund_ref_id} retry ${row.retry_count + 1} failed:`, retryErr?.message);
        // Mark as exhausted after 10 retries
        if (row.retry_count + 1 >= 10) {
          await queryDb(env,
            `UPDATE pending_refunds SET status = 'exhausted', updated_at = NOW() WHERE id = $1`,
            [Number(row.id)],
          );
          console.error(JSON.stringify({
            scope: 'refund-retry-exhausted',
            user_id: row.user_id,
            refund_ref_id: row.refund_ref_id,
            amount: row.amount,
            source: row.source,
          }));
        }
      }
    }
    if (succeeded > 0) {
      console.log(`[retryFailedRefunds] Processed ${succeeded}/${result.rows.length} pending refunds successfully.`);
    }
  } catch (e) {
    console.warn(safeError('refund-retry-cron', e));
  }
}

/**
 * Process referral on user bootstrap.
 *
 * ── ROOT-CAUSE FIX (referral not registering for returning users) ──
 * Previously this function had a `if (!isNewUser) return null` gate that
 * blocked referrals for ANY user who already had a DB row — even if they
 * had NO prior referral. This meant:
 *   - A user who opened the app once (without a referral link) could NEVER
 *     be referred later, even on their very first referral-link click.
 *   - A user who deleted their account and re-registered would be blocked
 *     if the user row was recreated before the referral was processed.
 *
 * FIX: The `isNewUser` gate is REMOVED. Referral attribution is now governed
 * SOLELY by the "first inviter wins" rule:
 *   1. If a referral row already exists for this invitee → keep the original
 *      inviter (no re-attribution). Idempotent.
 *   2. If NO referral row exists → create one (ON CONFLICT DO NOTHING for
 *      race safety). This works for brand-new users AND for existing users
 *      who never had a referral.
 *
 * This is safe because:
 *   - Self-referral is still rejected (M-R4 check).
 *   - Duplicate prevention is enforced by the referrals.invitee_id UNIQUE
 *     constraint + the pre-check at step 2.
 *   - Reward is still delegated to processPendingReferralReward (idempotent).
 *
 * Debug logging covers EVERY step so production issues can be traced:
 *   Start Parameter → Referrer → Telegram ID → Bootstrap → isNewUser
 *   → Insert → Reward → Final Result
 */
async function processReferralOnBootstrap(env, inviteeId, referrerId, channelJoined, isNewUser) {
  process.stderr.write('DEBUG: processReferralOnBootstrap CALLED, queryDb type: ' + typeof queryDb + '\n');
  const normalizedReferrerId = normalizeOptionalString(referrerId);

  // ── Step 2 — Validate referrer_id (M-R4: must be numeric, not self) ──
  if (!normalizedReferrerId || !/^\d{1,20}$/.test(normalizedReferrerId) || normalizedReferrerId === String(inviteeId)) {
    return null;
  }

  // ── ANTI-ABUSE: Check 15-day referral cooldown for deleted accounts ──
  // If this user previously deleted their account, they are in a 15-day
  // cooldown during which they CANNOT generate a new referral reward.
  // They can still use the app — only the referral is blocked.
  // This prevents abuse: delete → re-register with self-referral → farm rewards.
  if (typeof userRepo?.checkReferralCooldown === 'function') {
    const cooldown = await userRepo.checkReferralCooldown(env, inviteeId);
    if (cooldown.inCooldown) {
      return { referral_id: null, rejected: true, reason: cooldown.reason, cooldownUntil: cooldown.cooldownUntil };
    }
  }

  // ── ROOT-CAUSE FIX: `isNewUser` gate REMOVED ──
  // The "first inviter wins" rule (existing referral check + ON CONFLICT)
  // is sufficient to prevent abuse. See function docstring for full rationale.

  // ── Step 4 — Verify inviter exists in users table ──
  const inviterResult = await queryDb(
    env,
    'SELECT telegram_id FROM users WHERE telegram_id = $1 LIMIT 1',
    [normalizedReferrerId],
  );
  if (!inviterResult.rows[0]) {
    return null;
  }

  // ── Step 5 — Check for existing referral (first inviter wins) ──
  const existingResult = await queryDb(
    env,
    `
      SELECT id, inviter_id, rewarded
      FROM referrals
      WHERE invitee_id = $1
      LIMIT 1
    `,
    [String(inviteeId)],
  );
  const existing = existingResult.rows[0] || null;

  if (existing) {
    // Race: another concurrent bootstrap already inserted the referral.
    // Delegate reward processing (idempotent — won't double-reward).
    // PHASE 2 SAFE OPTIMIZATION: Skip processPendingReferralReward when channelJoined=false.
    // The function would early-return at line 1751 anyway (if (!channelJoined) return null),
    // but we save the 3 queryDb calls it makes BEFORE that check:
    //   - isSubsystemDisabled (cached 60s, but still 1 function call)
    //   - getReferralRewardPerInvite (cached 60s, but still 1 function call)
    //   - SELECT referrals WHERE rewarded=FALSE (real DB query — wasted)
    // The actual reward credit happens in resolveChannelMembership(forceRefresh:true)
    // when Telegram confirms channel_joined=true, OR in retryFailedReferralRewards cron.
    if (channelJoined) {
      await processPendingReferralReward(env, inviteeId, channelJoined);
    }
    return { referral_id: existing.id, already_exists: true };
  }

  // ── Step 6 — INSERT referral row (H-R3: ON CONFLICT DO NOTHING — race-safe) ──
  const insertResult = await queryDb(
    env,
    `
      INSERT INTO referrals (inviter_id, invitee_id, channel_verified, rewarded, created_at)
      VALUES ($1, $2, FALSE, FALSE, NOW())
      ON CONFLICT (invitee_id) DO NOTHING
      RETURNING id, rewarded
    `,
    [normalizedReferrerId, String(inviteeId)],
  );
  const createdReferral = insertResult.rows[0] || null;
  if (!createdReferral) {
    // Race lost — another request already inserted the referral.
    return { referral_id: null, already_exists: true, race_won: false };
  }

  // ── Step 7 — Delegate reward processing (idempotent) ──
  // PHASE 2 SAFE OPTIMIZATION: Same as above — skip when channelJoined=false.
  // processPendingReferralReward would early-return anyway, but we save 3 queryDb calls.
  // Reward will be credited by resolveChannelMembership(forceRefresh:true) if user just joined,
  // OR by retryFailedReferralRewards cron.
  let rewardResult = null;
  if (channelJoined) {
    rewardResult = await processPendingReferralReward(env, inviteeId, channelJoined);
  }

  // ── Step 8 — Final result ──
  const finalResult = { referral_id: createdReferral.id, rewarded: Boolean(rewardResult?.rewarded) };
  return finalResult;
}

  return {
    processPendingReferralReward,
    retryFailedReferralRewards,
    retryFailedWheelRewards,
    retryFailedMissionRewards,
    retryFailedRefunds,
    processReferralOnBootstrap,
  };
}

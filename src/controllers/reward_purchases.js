/**
 * Reward Purchase Controllers — VPN purchase + admin fulfillment + Telegram delivery
 *
 * User endpoints:
 *   GET  /api/rewards/vpn/plans      — catalog with premium_only + duration
 *   POST /api/rewards/vpn/purchase   — atomic debit + purchase (30-day limit)
 *   GET  /api/rewards/purchases      — user's purchase history
 *
 * Admin endpoints:
 *   GET   /api/admin/reward-purchases              — queue
 *   GET   /api/admin/reward-purchases/:id          — single purchase detail
 *   POST  /api/admin/reward-purchases/:id/fulfill  — send VPN link to user
 *   POST  /api/admin/reward-purchases/:id/cancel   — cancel
 *
 * Security:
 *   - Premium check: server-side MembershipAuthority per plan
 *   - Price: from backend catalog ONLY (never from request body)
 *   - Duration: from backend catalog ONLY
 *   - 30-day limit: server-enforced, only fulfilled purchases lock
 *   - Atomic debit with race protection (partial unique index)
 *   - If purchase fails after debit → automatic refund
 *   - Telegram messages sent directly to the purchase's user_id
 */

export function createRewardPurchaseHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    economyService,
    rewardPurchaseRepo,
    membershipAuthority,
    notificationService,
    requireAdmin,
    sendTelegramMessage,
    // W-STAB-4 FIX: Tehran date helper for deterministic refId.
    // Previously refId used Date.now() — each concurrent request got a unique
    // refId, so the wallet's unique index on (user_id, tx_type, ref_id) did
    // NOT protect against double-debit. The only protection was the
    // uq_rp_pending_plan index (which W-STAB-3 may have silently failed to
    // create). Now refId is deterministic per (user, plan, tehran-today) so
    // concurrent requests share the same refId → wallet unique index rejects
    // the second debit idempotently (debitTokens handles 23505 unique
    // violation by returning { idempotent: true }).
    getTehranDateString,
  } = deps;

  function _getTehranDateSafe() {
    try { return (typeof getTehranDateString === 'function') ? getTehranDateString() : new Date().toISOString().slice(0, 10); }
    catch { return new Date().toISOString().slice(0, 10); }
  }

  async function _isPremiumSafe(env, userId) {
    if (!membershipAuthority) return false;
    try {
      return await membershipAuthority.isPremium(env, String(userId));
    } catch {
      return false;
    }
  }

  // ── GET /api/rewards/vpn/plans ─────────────────────────────────────────
  // FIX 5: Returns per-plan eligibility + purchased state from backend.
  // The frontend just renders this — it never decides who is Premium or
  // what's purchased. Server-authoritative for every field.
  async function handleVpnPlans(request, env) {
    const plans = rewardPurchaseRepo.getVpnPlans();

    // Try to authenticate (plans are viewable without auth, but eligibility
    // and purchased state require knowing who the user is)
    const authState = await authenticateTelegramRequest(request, env);
    const userId = authState.error ? null : String(authState.user.id);

    let isPremium = false;
    let userPurchases = [];

    if (userId) {
      // Get premium status from MembershipAuthority (server-side, fail-safe)
      isPremium = await _isPremiumSafe(env, userId);

      // Get user's purchase history for purchased/eligibility state
      if (isDatabaseConfigured(env)) {
        try {
          userPurchases = await rewardPurchaseRepo.listUserPurchases(env, userId, 50);
        } catch (_) {}
      }
    }

    const now = Date.now();
    const plansWithState = plans.map(plan => {
      // Check if user has a recent fulfilled purchase for this plan (30-day cooldown)
      const recentPurchase = userPurchases.find(p =>
        p.plan_id === plan.id && p.status === 'fulfilled' &&
        p.created_at && (now - new Date(p.created_at).getTime()) < 30 * 86400000
      );

      const purchased = Boolean(recentPurchase);
      const daysRemaining = purchased
        ? Math.max(0, Math.ceil(30 - (now - new Date(recentPurchase.created_at).getTime()) / 86400000))
        : null;
      const eligible = !purchased && (!plan.premiumOnly || isPremium);

      return {
        id: plan.id,
        gb: plan.gb,
        cost_ab: plan.costAb,
        premium_only: plan.premiumOnly,
        duration_days: plan.durationDays,
        duration_fa: plan.durationFa,
        duration_en: plan.durationEn,
        // Server-authoritative state for this user
        eligible,
        purchased,
        ...(purchased ? {
          purchased_tracking_id: recentPurchase.tracking_id,
          purchased_at: recentPurchase.created_at,
          purchased_expires_at: recentPurchase.expires_at,
          days_remaining: daysRemaining,
        } : {}),
      };
    });

    return jsonResponse({
      status: 'success',
      is_premium: isPremium,
      authenticated: Boolean(userId),
      plans: plansWithState,
    }, {}, env);
  }

  // ── POST /api/rewards/vpn/purchase ─────────────────────────────────────
  async function handleVpnPurchase(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const userId = String(authState.user.id);

    const bodyResult = await readJsonBody(request, 10240, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload;
    const planId = String(payload?.plan_id || '').trim();
    if (!planId) {
      return jsonResponse({ status: 'error', message: 'plan_id required', code: 'MISSING_PLAN_ID' }, { status: 422 }, env);
    }

    const plan = rewardPurchaseRepo.getVpnPlan(planId);
    if (!plan) {
      return jsonResponse({ status: 'error', message: 'Invalid plan', code: 'INVALID_PLAN' }, { status: 422 }, env);
    }

    // Per-plan Premium check (server-side, fail-safe to deny)
    if (plan.premiumOnly) {
      const isPremium = await _isPremiumSafe(env, userId);
      if (!isPremium) {
        return jsonResponse({
          status: 'error',
          message: 'Premium membership required to purchase this plan',
          code: 'PREMIUM_REQUIRED',
        }, { status: 403 }, env);
      }
    }

    // FIX 7: 30-day purchase limit check (only fulfilled purchases lock)
    const limitCheck = await rewardPurchaseRepo.checkPurchaseLimit(env, userId, planId);
    if (limitCheck.restricted) {
      return jsonResponse({
        status: 'error',
        message: `You already purchased this plan. ${limitCheck.daysRemaining} days until next purchase.`,
        code: 'PLAN_LIMIT_REACHED',
        days_remaining: limitCheck.daysRemaining,
        last_tracking_id: limitCheck.lastPurchase?.tracking_id || null,
      }, { status: 429 }, env);
    }

    try {
      // 1. Atomic wallet debit — price from backend catalog (plan.costAb)
      // W-STAB-4 FIX: deterministic refId per (user, plan, tehran-today).
      // Previously: `vpn_purchase_${userId}_${plan.id}_${Date.now()}` — each
      // concurrent request got a unique refId, so the wallet's unique index
      // on (user_id, tx_type, ref_id) could NOT reject the second debit.
      // Now: `vpn_purchase_${userId}_${plan.id}_${tehranToday}` — concurrent
      // requests in the same Tehran day share the same refId. If a duplicate
      // debit hits the unique constraint, debitTokens handles 23505 by
      // returning { idempotent: true, newBalance: null } (see wallet.js:858).
      // The controller then treats idempotent debit as a duplicate-pending
      // case (DUPLICATE_PENDING response, no refund issued because the
      // winner's debit already paid for the purchase).
      // Note: 30-day purchase limit (checkPurchaseLimit above) prevents the
      // same user+plan from being purchased twice within 30 days after
      // fulfillment, so a same-day refId reuse can only happen when the
      // first purchase is still pending (which is exactly the duplicate
      // case we want to reject).
      const tehranToday = _getTehranDateSafe();
      const refId = `vpn_purchase_${userId}_${plan.id}_${tehranToday}`;
      let debitResult;
      let debitWasIdempotent = false;
      try {
        debitResult = await economyService.debitUser({
          userId,
          amount: plan.costAb,
          debitType: 'vpn_purchase',
          description: `VPN ${plan.gb}GB — ${plan.durationFa}`,
          refId,
          metadata: { plan_id: plan.id, vpn_gb: plan.gb, duration_days: plan.durationDays },
          env,
        });
        debitWasIdempotent = Boolean(debitResult && debitResult.idempotent);
      } catch (e) {
        return jsonResponse({
          status: 'error',
          message: e?.code === 'RULE_VIOLATION' ? 'Insufficient AB balance' : 'Payment failed',
          code: 'PAYMENT_FAILED',
          required_tokens: plan.costAb,
        }, { status: 402 }, env);
      }

      // W-STAB-4: if debit was idempotent (a concurrent winner already debited
      // for the same refId), this request is a duplicate. Skip the purchase
      // creation — the winner already created it. Return DUPLICATE_PENDING so
      // the frontend shows the right message (no refund needed because no
      // new debit happened on this request).
      if (debitWasIdempotent) {
        // Look up the existing pending purchase for this user+plan
        let existingPurchase = null;
        try {
          const userPurchases = await rewardPurchaseRepo.listUserPurchases(env, userId, 50);
          existingPurchase = userPurchases.find(p => p.plan_id === plan.id && p.status === 'pending') || null;
        } catch (_) {}
        return jsonResponse({
          status: 'error',
          message: 'You already have a pending purchase for this plan. Please wait for fulfillment.',
          code: 'DUPLICATE_PENDING',
          purchase_id: existingPurchase?.id || null,
        }, { status: 409 }, env);
      }

      // 2. Create purchase record
      let purchase;
      let created;
      try {
        const result = await rewardPurchaseRepo.createVpnPurchase(env, userId, plan.id, plan.costAb, refId);
        purchase = result.purchase;
        created = result.created;
      } catch (e) {
        // Purchase record failed after debit → REFUND
        try {
          await economyService.grantReward({
            userId,
            amount: plan.costAb,
            rewardType: 'marketplace_refund',
            description: `Refund: VPN ${plan.gb}GB purchase failed`,
            refId: `${refId}_refund`,
            metadata: { reason: 'purchase_record_failure', plan_id: plan.id },
            auditInfo: { actor: 'system' },
            env,
          });
        } catch (refundErr) {
          console.error('[vpn-purchase] CRITICAL: debit succeeded but purchase failed AND refund failed:', refundErr?.message);
        }
        throw e;
      }

      // Duplicate-pending: refund this debit
      if (!created) {
        try {
          await economyService.grantReward({
            userId,
            amount: plan.costAb,
            rewardType: 'marketplace_refund',
            description: `Refund: VPN ${plan.gb}GB already pending`,
            refId: `${refId}_refund`,
            metadata: { reason: 'duplicate_pending_purchase', plan_id: plan.id },
            auditInfo: { actor: 'system' },
            env,
          });
        } catch (refundErr) {
          console.warn('[vpn-purchase] duplicate refund failed:', refundErr?.message);
        }
        return jsonResponse({
          status: 'error',
          message: 'You already have a pending purchase for this plan. Please wait for fulfillment.',
          code: 'DUPLICATE_PENDING',
          purchase_id: purchase?.id,
        }, { status: 409 }, env);
      }

      // 3. Notify admin via internal notification system
      if (notificationService) {
        try {
          const username = authState.user?.username || null;
          const displayName = [authState.user?.first_name, authState.user?.last_name].filter(Boolean).join(' ') || username || userId;
          await notificationService.create(env, {
            userId: userId,
            templateKey: 'vpn_purchase_pending',
            category: 'system',
            priority: 'high',
            channel: 'both',
            title: 'VPN Reward Purchase — Action Needed',
            message: `NEW VPN PURCHASE\n\nUser: ${displayName} (${username ? '@' + username : 'ID: ' + userId})\nProduct: VPN ${plan.gb}GB (${plan.durationFa})\nCost: ${plan.costAb} AB\nTracking: ${purchase.tracking_id}\nStatus: Pending — send subscription link to user`,
            metadata: {
              purchase_id: purchase.id,
              tracking_id: purchase.tracking_id,
              user_id: userId,
              username: username,
              display_name: displayName,
              reward: 'VPN',
              vpn_gb: plan.gb,
              cost_ab: plan.costAb,
              duration_days: plan.durationDays,
              status: 'pending',
              admin_action: 'Send VPN subscription link to user',
            },
            dedupKey: `vpn_purchase_${purchase.id}`,
          }).catch(() => {});
        } catch (notifErr) {
          console.warn('[vpn-purchase] admin notification failed:', notifErr?.message);
        }
      }

      // FIX 5: Send Telegram message to USER about successful purchase
      if (sendTelegramMessage) {
        try {
          const trackingId = purchase.tracking_id;
          // Dynamic duration label: 7 → «۷ روز», 30 → «۱ ماه»
          const durationLabel = plan.durationDays >= 30 ? '۱ ماه' : '۷ روز';
          const msg = `🎉 درخواست شما با موفقیت ثبت شد!\n\n📦 بسته: ${purchase.plan_name || `VPN ${plan.gb}GB`}\n💎 هزینه: ${plan.costAb} AB\n⏳ اعتبار: ${durationLabel}\n🆔 کد رهگیری: ${trackingId}\n\n⏳ لینک سرویس پس از آماده‌سازی برای شما ارسال خواهد شد.\n\n💙 ممنون که همراه Amir BTC هستید.`;
          await sendTelegramMessage(env, { chat_id: String(userId), text: msg });
        } catch (tgErr) {
          console.warn('[vpn-purchase] Telegram purchase notification failed (non-blocking):', tgErr?.message);
        }
      }

      // AUDIT LOG
      console.log(JSON.stringify({
        scope: 'vpn-purchase',
        user_id: userId,
        purchase_id: purchase.id,
        tracking_id: purchase.tracking_id,
        plan_id: plan.id,
        vpn_gb: plan.gb,
        cost_ab: plan.costAb,
        duration_days: plan.durationDays,
        status: 'pending',
        timestamp: new Date().toISOString(),
      }));

      // PART 10: return the AUTHORITATIVE new balance from the debit result
      // (never let frontend guess — this eliminates stale-balance issues)
      const newBalance = debitResult && typeof debitResult.newBalance === 'number'
        ? debitResult.newBalance
        : null;

      return jsonResponse({
        status: 'success',
        message: 'Purchase created. Your VPN subscription link will be sent to you shortly.',
        purchase: {
          id: purchase.id,
          tracking_id: purchase.tracking_id,
          plan_id: purchase.plan_id || plan.id,
          plan_name: purchase.plan_name || `VPN ${plan.gb}GB`,
          vpn_gb: purchase.vpn_gb || plan.gb,
          cost_ab: purchase.cost_ab || plan.costAb,
          duration_days: purchase.duration_days || plan.durationDays,
          status: purchase.status || 'pending',
          expires_at: purchase.expires_at,
          created_at: purchase.created_at,
        },
        new_balance: newBalance,
      }, { status: 201 }, env);
    } catch (e) {
      console.warn(safeError('vpn-purchase', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/rewards/purchases ─────────────────────────────────────────
  async function handleUserPurchases(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'success', purchases: [] }, {}, env);
    }
    try {
      const purchases = await rewardPurchaseRepo.listUserPurchases(env, authState.user.id);
      return jsonResponse({ status: 'success', purchases }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/admin/reward-purchases ────────────────────────────────────
  async function handleAdminListPurchases(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'wallet.view');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const status = url.searchParams.get('status') || null;
      const purchases = await rewardPurchaseRepo.listPurchases(env, { status });
      return jsonResponse({ status: 'success', ...purchases }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/admin/reward-purchases/:id ────────────────────────────────
  async function handleAdminGetPurchase(request, env, purchaseId) {
    const { error: authErr } = await requireAdmin(request, env, 'wallet.view');
    if (authErr) return authErr;
    if (!purchaseId) {
      return jsonResponse({ status: 'error', message: 'purchase id required' }, { status: 422 }, env);
    }
    try {
      const purchase = await rewardPurchaseRepo.getPurchaseById(env, purchaseId);
      if (!purchase) {
        return jsonResponse({ status: 'error', message: 'Purchase not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', purchase }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── POST /api/admin/reward-purchases/:id/fulfill ───────────────────────
  async function handleAdminFulfill(request, env, purchaseId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'wallet.manage');
    if (authErr) return authErr;
    if (!purchaseId) {
      return jsonResponse({ status: 'error', message: 'purchase id required' }, { status: 422 }, env);
    }

    const bodyResult = await readJsonBody(request, 10240, env);
    if (bodyResult.error) return bodyResult.error;
    const vpnLink = String(bodyResult.payload?.vpn_link || '').trim();
    if (!vpnLink || vpnLink.length < 10) {
      return jsonResponse({
        status: 'error',
        message: 'vpn_link required (minimum 10 characters)',
        code: 'MISSING_VPN_LINK',
      }, { status: 422 }, env);
    }

    try {
      // Get the purchase first (to build the Telegram message)
      const purchase = await rewardPurchaseRepo.getPurchaseById(env, purchaseId);
      if (!purchase) {
        return jsonResponse({ status: 'error', message: 'Purchase not found' }, { status: 404 }, env);
      }
      if (purchase.status !== 'pending') {
        return jsonResponse({
          status: 'error',
          message: `Purchase is already ${purchase.status}`,
          code: 'ALREADY_PROCESSED',
        }, { status: 409 }, env);
      }

      // Build the delivery message
      const plan = rewardPurchaseRepo.getVpnPlan(purchase.plan_id);
      const trackingId = purchase.tracking_id;
      // Dynamic duration label from actual duration_days
      const durationLabel = purchase.duration_days >= 30 ? '۱ ماه' : '۷ روز';
      const deliveryMsg = `🎉 اشتراک VPN شما آماده است\n\n📦 بسته: ${purchase.plan_name || `VPN ${purchase.vpn_gb}GB`}\n⏳ اعتبار: ${durationLabel}\n🆔 کد رهگیری: ${trackingId}\n\n🔗 لینک دریافت:\n${vpnLink}\n\n💙 از همراهی شما با Amir BTC ممنونیم.`;

      // FIX 12: Send Telegram message FIRST, then mark fulfilled.
      // If Telegram fails, purchase stays pending → admin can retry.
      let telegramSent = false;
      let telegramError = null;
      if (sendTelegramMessage) {
        try {
          const result = await sendTelegramMessage(env, { chat_id: String(purchase.user_id), text: deliveryMsg, parse_mode: 'HTML' });
          if (!result || !result.ok) {
            throw new Error(result?.description || 'Telegram send returned not-ok');
          }
          telegramSent = true;
        } catch (tgErr) {
          telegramError = tgErr.message;
          console.error('[vpn-fulfill] Telegram send FAILED:', tgErr.message);
          // Do NOT mark as fulfilled — admin can retry
          return jsonResponse({
            status: 'error',
            message: `Telegram message failed to send: ${telegramError}. Purchase remains pending. Please try again.`,
            code: 'TELEGRAM_SEND_FAILED',
          }, { status: 502 }, env);
        }
      }

      // Mark as fulfilled (only after Telegram succeeded)
      const fulfilled = await rewardPurchaseRepo.fulfillPurchase(env, purchaseId, admin.telegram_id, vpnLink);
      if (!fulfilled) {
        // Race: another admin fulfilled between our check and update
        return jsonResponse({
          status: 'error',
          message: 'Purchase was already fulfilled by another admin',
          code: 'ALREADY_FULFILLED',
        }, { status: 409 }, env);
      }

      console.log(JSON.stringify({
        scope: 'vpn-purchase-fulfilled',
        purchase_id: fulfilled.id,
        user_id: fulfilled.user_id,
        tracking_id: fulfilled.tracking_id,
        fulfilled_by: admin.telegram_id,
        telegram_sent: telegramSent,
        timestamp: new Date().toISOString(),
      }));

      return jsonResponse({
        status: 'success',
        message: 'VPN link sent to user successfully.',
        purchase: {
          id: fulfilled.id,
          tracking_id: fulfilled.tracking_id,
          plan_name: fulfilled.plan_name,
          vpn_gb: fulfilled.vpn_gb,
          cost_ab: fulfilled.cost_ab,
          status: fulfilled.status,
          fulfilled_at: fulfilled.fulfilled_at,
          expires_at: fulfilled.expires_at,
        },
        telegram_sent: telegramSent,
      }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── POST /api/admin/reward-purchases/:id/cancel ────────────────────────
  async function handleAdminCancel(request, env, purchaseId) {
    const { error: authErr } = await requireAdmin(request, env, 'wallet.manage');
    if (authErr) return authErr;
    if (!purchaseId) {
      return jsonResponse({ status: 'error', message: 'purchase id required' }, { status: 422 }, env);
    }
    try {
      const cancelled = await rewardPurchaseRepo.cancelPurchase(env, purchaseId);
      if (!cancelled) {
        return jsonResponse({ status: 'error', message: 'Purchase not found or not pending' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', cancelled: true }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  return Object.freeze({
    handleVpnPlans,
    handleVpnPurchase,
    handleUserPurchases,
    handleAdminListPurchases,
    handleAdminGetPurchase,
    handleAdminFulfill,
    handleAdminCancel,
  });
}

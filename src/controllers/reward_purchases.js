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
  } = deps;

  async function _isPremiumSafe(env, userId) {
    if (!membershipAuthority) return false;
    try {
      return await membershipAuthority.isPremium(env, String(userId));
    } catch {
      return false;
    }
  }

  // ── GET /api/rewards/vpn/plans ─────────────────────────────────────────
  async function handleVpnPlans(request, env) {
    const plans = rewardPurchaseRepo.getVpnPlans();
    return jsonResponse({
      status: 'success',
      plans: plans.map(p => ({
        id: p.id,
        gb: p.gb,
        cost_ab: p.costAb,
        premium_only: p.premiumOnly,
        duration_days: p.durationDays,
        duration_fa: p.durationFa,
        duration_en: p.durationEn,
      })),
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
      const refId = `vpn_purchase_${userId}_${plan.id}_${Date.now()}`;
      let debitResult;
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
      } catch (e) {
        return jsonResponse({
          status: 'error',
          message: e?.code === 'RULE_VIOLATION' ? 'Insufficient AB balance' : 'Payment failed',
          code: 'PAYMENT_FAILED',
          required_tokens: plan.costAb,
        }, { status: 402 }, env);
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
          const durationFa = plan.durationFa;
          const trackingId = purchase.tracking_id;
          const msg = `🎉 تبریک! خرید شما با موفقیت ثبت شد.\n\n📦 پلن:\nVPN ${plan.gb}GB (${durationFa})\n\n💰 مبلغ:\n${plan.costAb} AB\n\n🎫 کد رهگیری:\n${trackingId}\n\n⏳ وضعیت:\nدر انتظار ارسال\n\nلینک اشتراک VPN پس از آماده‌سازی برای شما ارسال خواهد شد.`;
          await sendTelegramMessage(env, { chat_id: String(userId), text: msg, parse_mode: 'HTML' });
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
      const durationFa = plan ? plan.durationFa : `${purchase.duration_days} روز`;
      const trackingId = purchase.tracking_id;
      const deliveryMsg = `🎉 تبریک! خرید شما با موفقیت تأیید شد.\n\n🔐 سرویس: VPN\n📦 پلن: ${purchase.plan_name || `VPN ${purchase.vpn_gb}GB`}\n⏳ مدت اشتراک: ${durationFa}\n💰 مبلغ: ${purchase.cost_ab} AB\n\n🎫 کد رهگیری:\n${trackingId}\n\n🔗 لینک اتصال:\n${vpnLink}\n\nاز خرید شما متشکریم ❤️\nدر صورت وجود مشکل، با پشتیبانی در ارتباط باشید.`;

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

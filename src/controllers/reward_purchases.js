/**
 * Reward Purchase Controllers — VPN purchase flow + admin queue
 *
 * User endpoints:
 *   GET  /api/rewards/vpn/plans      — catalog (always shows; purchase is Premium-only)
 *   POST /api/rewards/vpn/purchase   — atomic debit + purchase record (Premium only)
 *   GET  /api/rewards/purchases      — user's own purchase history
 *
 * Admin endpoints:
 *   GET  /api/admin/reward-purchases           — queue (filterable)
 *   POST /api/admin/reward-purchases/:id/fulfill — mark fulfilled
 *   POST /api/admin/reward-purchases/:id/cancel  — cancel a pending purchase
 *
 * Security:
 *   - Premium check via MembershipAuthority (server-side, fail-safe to Normal)
 *   - Wallet debit via economyService.debitUser (atomic CTE — FIX C1 pattern)
 *   - Duplicate-pending prevention in the repository
 *   - If the purchase record fails after a successful debit, the debit is
 *     refunded (idempotent via _refund refId + unique index)
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
    // Public catalog — no auth needed to VIEW plans (Premium gate is on purchase)
    const plans = rewardPurchaseRepo.getVpnPlans();
    return jsonResponse({
      status: 'success',
      plans: plans.map(p => ({ id: p.id, gb: p.gb, cost_ab: p.costAb, premium_only: p.premiumOnly })),
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

    // PHASE 5: Premium check is PER-PLAN (server-side MembershipAuthority).
    // The 1GB plan (premiumOnly=false) is available to ALL users.
    // 2GB-10GB plans are Premium-only. Fail-safe to deny.
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

    try {
      // 1. Atomic wallet debit (economyService → debitTokens with the C1
      //    atomic CTE). Insufficient balance → 402 with zero side effects.
      const refId = `vpn_purchase_${userId}_${plan.id}_${Date.now()}`;
      try {
        await economyService.debitUser({
          userId,
          amount: plan.costAb,
          debitType: 'vpn_purchase',
          description: `VPN ${plan.gb}GB — Reward Market`,
          refId,
          metadata: { plan_id: plan.id, vpn_gb: plan.gb },
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

      // 2. Record the purchase (AFTER the debit succeeded).
      //    If the user already has a PENDING purchase of the same plan →
      //    refund this debit (idempotent) and return the existing purchase.
      let purchase;
      let created;
      try {
        const result = await rewardPurchaseRepo.createVpnPurchase(env, userId, plan.id, plan.costAb, refId);
        purchase = result.purchase;
        created = result.created;
      } catch (e) {
        // Purchase record failed after a successful debit → REFUND
        // (PHASE 7 rule 5: "اگر purchase ثبت نشد، token از بین نرود")
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

      // Duplicate-pending: the debit just happened but a pending purchase
      // already existed → refund this debit (the user was charged for nothing)
      if (!created) {
        try {
          await economyService.grantReward({
            userId,
            amount: plan.costAb,
            rewardType: 'marketplace_refund',
            description: `Refund: VPN ${plan.gb}GB already pending`,
            refId: `${refId}_refund`,
            metadata: { reason: 'duplicate_pending_purchase', plan_id: plan.id, existing_purchase_id: purchase.id },
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
          purchase_id: purchase.id,
        }, { status: 409 }, env);
      }

      // 3. Notify admins about the pending VPN purchase (PHASE 7)
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
            message: `NEW VPN PURCHASE\n\nUser: ${displayName} (${username ? '@' + username : 'ID: ' + userId})\nProduct: VPN ${plan.gb}GB\nCost: ${plan.costAb} AB\nTracking: VPN-${String(purchase.id).padStart(8, '0')}\nStatus: Pending — send subscription link to user`,
            metadata: {
              purchase_id: purchase.id,
              tracking_id: 'VPN-' + String(purchase.id).padStart(8, '0'),
              user_id: userId,
              username: username,
              display_name: displayName,
              reward: 'VPN',
              vpn_gb: plan.gb,
              cost_ab: plan.costAb,
              status: 'pending',
              admin_action: 'Send VPN subscription link to user',
            },
            dedupKey: `vpn_purchase_${purchase.id}`,
          }).catch(() => {});
        } catch (notifErr) {
          console.warn('[vpn-purchase] admin notification failed:', notifErr?.message);
        }
      }

      // AUDIT LOG
      console.log(JSON.stringify({
        scope: 'vpn-purchase',
        user_id: userId,
        purchase_id: purchase.id,
        plan_id: plan.id,
        vpn_gb: plan.gb,
        cost_ab: plan.costAb,
        status: 'pending',
        timestamp: new Date().toISOString(),
      }));

      // Generate a human-friendly tracking ID from the purchase ID
      const trackingId = 'VPN-' + String(purchase.id).padStart(8, '0');

      return jsonResponse({
        status: 'success',
        message: 'Purchase created. Your VPN subscription link will be sent to you shortly.',
        purchase: {
          id: purchase.id,
          tracking_id: trackingId,
          plan_id: plan.id,
          vpn_gb: plan.gb,
          cost_ab: plan.costAb,
          status: 'pending',
          created_at: purchase.created_at,
        },
      }, { status: 201 }, env);
    } catch (e) {
      console.warn(safeError('vpn-purchase', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/rewards/purchases (user's own) ────────────────────────────
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

  // ── GET /api/admin/reward-purchases (admin queue) ──────────────────────
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

  // ── POST /api/admin/reward-purchases/:id/fulfill ───────────────────────
  async function handleAdminFulfill(request, env, purchaseId) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'wallet.manage');
    if (authErr) return authErr;
    if (!purchaseId) {
      return jsonResponse({ status: 'error', message: 'purchase id required' }, { status: 422 }, env);
    }
    try {
      const purchase = await rewardPurchaseRepo.fulfillPurchase(env, purchaseId, admin.telegram_id);
      if (!purchase) {
        return jsonResponse({ status: 'error', message: 'Purchase not found or not pending' }, { status: 404 }, env);
      }
      console.log(JSON.stringify({
        scope: 'vpn-purchase-fulfilled',
        purchase_id: purchase.id,
        user_id: purchase.user_id,
        fulfilled_by: admin.telegram_id,
        timestamp: new Date().toISOString(),
      }));
      return jsonResponse({ status: 'success', purchase }, {}, env);
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
    handleAdminFulfill,
    handleAdminCancel,
  });
}

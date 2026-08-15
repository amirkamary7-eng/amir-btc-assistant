/**
 * Cosmetics Controllers — HTTP Layer
 *
 * Handles:
 *   GET  /api/cosmetics           — catalog (locked for Normal, purchasable for Premium)
 *   GET  /api/cosmetics/mine      — user's owned cosmetics
 *   POST /api/cosmetics/:id/purchase  — purchase (Premium only)
 *   POST /api/cosmetics/:id/activate  — activate owned cosmetic (Premium only)
 *
 * Security:
 *   - Premium check via MembershipAuthority (server-side, fail-safe to Normal)
 *   - Purchase: atomic AB debit via economyService + ownership insert (UNIQUE prevents double-purchase)
 *   - Activate: atomic transaction (deactivate old + activate new)
 */

export function createCosmeticsHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    cosmeticsRepo,
    membershipAuthority,
    economyService,
  } = deps;

  async function _isPremiumSafe(env, userId) {
    if (!membershipAuthority) return false;
    try {
      return await membershipAuthority.isPremium(env, String(userId));
    } catch (e) {
      return false;
    }
  }

  /** GET /api/cosmetics — catalog with ownership status for current user */
  async function handleGetCatalog(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    const userId = String(authState.user.id);
    try {
      const [catalog, owned, active] = await Promise.all([
        cosmeticsRepo.getCatalog(env),
        cosmeticsRepo.getOwned(env, userId),
        cosmeticsRepo.getActive(env, userId),
      ]);

      const ownedIds = new Set(owned.map(o => o.cosmetic_id));
      const isPremium = await _isPremiumSafe(env, userId);

      const items = catalog.map(c => ({
        id: c.id,
        cosmetic_key: c.cosmetic_key,
        title: c.title,
        description: c.description,
        rarity: c.rarity,
        type: c.type,
        token_cost: c.token_cost,
        metadata: c.metadata || {},
        owned: ownedIds.has(c.id),
        locked: !ownedIds.has(c.id) && !isPremium,
      }));

      return jsonResponse({
        status: 'success',
        items,
        is_premium: isPremium,
        active_cosmetic: active ? {
          cosmetic_id: active.cosmetic_id,
          cosmetic_key: active.cosmetic_key,
          title: active.title,
          rarity: active.rarity,
          metadata: active.metadata,
        } : null,
      }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** GET /api/cosmetics/mine — user's owned cosmetics */
  async function handleGetMine(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    const userId = String(authState.user.id);
    try {
      const [owned, active] = await Promise.all([
        cosmeticsRepo.getOwned(env, userId),
        cosmeticsRepo.getActive(env, userId),
      ]);

      const activeId = active?.cosmetic_id || null;
      const items = owned.map(o => ({
        cosmetic_id: o.cosmetic_id,
        cosmetic_key: o.cosmetic_key,
        title: o.title,
        rarity: o.rarity,
        type: o.type,
        metadata: o.metadata || {},
        tokens_spent: o.tokens_spent,
        is_active: o.is_active,
        purchased_at: o.purchased_at,
        activated_at: o.activated_at,
      }));

      return jsonResponse({
        status: 'success',
        items,
        active_cosmetic_id: activeId,
      }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** POST /api/cosmetics/:id/purchase — purchase a cosmetic (Premium only) */
  async function handlePurchase(request, env, cosmeticId) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    const userId = String(authState.user.id);

    const isPremium = await _isPremiumSafe(env, userId);
    if (!isPremium) {
      return jsonResponse({
        status: 'error',
        message: 'Premium membership required to purchase cosmetics',
        code: 'PREMIUM_REQUIRED',
      }, { status: 403 }, env);
    }

    if (!cosmeticId) {
      return buildBodyFieldValidationError([{ field: 'id', message: 'Cosmetic ID required' }], env);
    }

    try {
      const cosmetic = await cosmeticsRepo.getById(env, cosmeticId);
      if (!cosmetic) {
        return jsonResponse({ status: 'error', message: 'Cosmetic not found', code: 'NOT_FOUND' }, { status: 404 }, env);
      }

      const existing = await cosmeticsRepo.getOwnership(env, userId, cosmeticId);
      if (existing) {
        return jsonResponse({ status: 'error', message: 'Cosmetic already owned', code: 'ALREADY_OWNED' }, { status: 409 }, env);
      }

      // Atomic AB debit (via economyService — uses WHERE balance >= $2, no negative)
      const refId = `cosmetic_purchase_${userId}_${cosmeticId}`;
      try {
        await economyService.debitUser({
          userId,
          amount: cosmetic.token_cost,
          debitType: 'cosmetic_purchase',
          description: `Purchase: ${cosmetic.title} (${cosmetic.rarity})`,
          refId,
          metadata: { cosmetic_id: cosmeticId, cosmetic_key: cosmetic.cosmetic_key, rarity: cosmetic.rarity },
          env,
        });
      } catch (e) {
        return jsonResponse({
          status: 'error',
          message: e?.code === 'RULE_VIOLATION' ? 'Insufficient AB balance' : 'Payment failed',
          code: 'PAYMENT_FAILED',
          required_tokens: cosmetic.token_cost,
        }, { status: 402 }, env);
      }

      // Record ownership (ON CONFLICT DO NOTHING — idempotent)
      const { ownership, created } = await cosmeticsRepo.createOwnership(env, userId, cosmeticId, cosmetic.token_cost);

      if (!created) {
        // Race condition: another concurrent purchase created ownership first.
        // Refund the debit (idempotent via _refund suffix).
        try {
          await economyService.grantReward({
            userId,
            amount: cosmetic.token_cost,
            rewardType: 'bonus_reward',
            description: `Refund: cosmetic already owned (${cosmetic.title})`,
            refId: `${refId}_refund`,
            metadata: { reason: 'race_condition_already_owned', cosmetic_id: cosmeticId },
            auditInfo: { actor: 'system' },
            env,
          });
        } catch (refundErr) {
          console.warn('[cosmetics] Race refund failed:', refundErr?.message);
        }
        return jsonResponse({ status: 'error', message: 'Cosmetic already owned', code: 'ALREADY_OWNED' }, { status: 409 }, env);
      }

      return jsonResponse({
        status: 'success',
        message: 'Cosmetic purchased successfully',
        ownership: {
          cosmetic_id: ownership.cosmetic_id,
          tokens_spent: ownership.tokens_spent,
          purchased_at: ownership.purchased_at,
        },
      }, { status: 201 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** POST /api/cosmetics/:id/activate — activate an owned cosmetic (Premium only) */
  async function handleActivate(request, env, cosmeticId) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    const userId = String(authState.user.id);

    const isPremium = await _isPremiumSafe(env, userId);
    if (!isPremium) {
      return jsonResponse({
        status: 'error',
        message: 'Premium membership required to activate cosmetics',
        code: 'PREMIUM_REQUIRED',
      }, { status: 403 }, env);
    }

    if (!cosmeticId) {
      return buildBodyFieldValidationError([{ field: 'id', message: 'Cosmetic ID required' }], env);
    }

    try {
      const ownership = await cosmeticsRepo.getOwnership(env, userId, cosmeticId);
      if (!ownership) {
        return jsonResponse({ status: 'error', message: 'Cosmetic not owned. Purchase it first.', code: 'NOT_OWNED' }, { status: 403 }, env);
      }

      const activated = await cosmeticsRepo.activate(env, userId, cosmeticId);
      if (!activated) {
        return jsonResponse({ status: 'error', message: 'Activation failed', code: 'ACTIVATION_FAILED' }, { status: 500 }, env);
      }

      return jsonResponse({
        status: 'success',
        message: 'Cosmetic activated',
        active_cosmetic_id: cosmeticId,
      }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  return Object.freeze({
    handleGetCatalog,
    handleGetMine,
    handlePurchase,
    handleActivate,
  });
}

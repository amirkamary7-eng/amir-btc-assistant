/**
 * Entitlement Configuration — Single source of truth for Normal vs Premium quotas.
 *
 * Phase 3: Centralizes all quota numbers so feature handlers don't hard-code
 * them. Every feature reads its quota from here, parameterized by tier.
 *
 * PRINCIPLE: Premium ≠ Unlimited. Premium gets a HIGHER quota, not infinite.
 * For high-cost features (alerts, AI), Token Economy still applies beyond
 * the Premium quota.
 *
 * FAIL-SAFE: If MembershipAuthority lookup fails, the Normal quota is used.
 * A user is never accidentally granted Premium privileges on error.
 *
 * This is a pure config object — no I/O, no side effects. Fully testable.
 */

export const ENTITLEMENT_CONFIG = Object.freeze({
  // ─── Price Alerts ──────────────────────────────────────────────────────────
  // Existing alert_config table has free_per_day=3, cost_per_extra=5.
  // Phase 3 adds premium_free_per_day=10. Token extension preserved beyond both.
  alerts: {
    normal_free_per_day: 3,
    premium_free_per_day: 10,
    token_cost_per_extra: 5,   // AB per extra alert (beyond free quota)
    debit_type: 'alert_debit',
  },

  // ─── AI Assistant Chat ─────────────────────────────────────────────────────
  // KV-backed daily counters. Phase 3: tier-based limit.
  ai_chat: {
    normal_daily_limit: 50,
    premium_daily_limit: 100,
  },

  // ─── AI Assistant Images ───────────────────────────────────────────────────
  ai_image: {
    normal_daily_limit: 3,
    premium_daily_limit: 10,
  },

  // ─── Wheel Spins ───────────────────────────────────────────────────────────
  // DB-driven via wheel_config.max_spins_per_user (default 3).
  // Phase 3: tier-based max spins. No token extension for wheel (spin IS reward).
  wheel: {
    normal_daily_spins: 3,
    premium_daily_spins: 5,
  },

  // ─── Watchlist ─────────────────────────────────────────────────────────────
  // Currently MAX_WATCHLIST=7 frontend-only + backend slice.
  // Phase 3: tier-based limit, backend-enforced.
  watchlist: {
    normal_max: 7,
    premium_max: 20,
  },

  // ─── Daily Claim (Phase 4) ────────────────────────────────────────────────
  // Normal = 10 AB, Premium = 20 AB.
  daily_claim: {
    normal_amount: 10,
    premium_amount: 20,
  },

  // ─── Mission Rewards (Phase 4) ────────────────────────────────────────────
  // Normal = 1× base, Premium = 1.5× base.
  // token_transactions.amount is INTEGER → must round.
  // Rounding: Math.ceil (Premium always gets AT LEAST the multiplier value).
  missions: {
    normal_multiplier: 1.0,
    premium_multiplier: 1.5,
  },

  // ─── Referral Rewards (Phase 4) ───────────────────────────────────────────
  // Normal = 3 AB per invite, Premium = 6 AB per invite (inviter tier).
  referral: {
    normal_reward: 3,
    premium_reward: 6,
  },
});

/**
 * Get the effective free quota for alerts, given tier.
 */
export function getAlertFreePerDay(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.alerts.premium_free_per_day
    : ENTITLEMENT_CONFIG.alerts.normal_free_per_day;
}

/**
 * Get AI chat daily limit for tier.
 */
export function getAiChatDailyLimit(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.ai_chat.premium_daily_limit
    : ENTITLEMENT_CONFIG.ai_chat.normal_daily_limit;
}

/**
 * Get AI image daily limit for tier.
 */
export function getAiImageDailyLimit(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.ai_image.premium_daily_limit
    : ENTITLEMENT_CONFIG.ai_image.normal_daily_limit;
}

/**
 * Get wheel daily spins for tier.
 */
export function getWheelDailySpins(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.wheel.premium_daily_spins
    : ENTITLEMENT_CONFIG.wheel.normal_daily_spins;
}

/**
 * Get watchlist max for tier.
 */
export function getWatchlistMax(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.watchlist.premium_max
    : ENTITLEMENT_CONFIG.watchlist.normal_max;
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 4: REWARD HELPERS
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Get daily claim reward amount for tier.
 * Normal = 10 AB, Premium = 20 AB.
 */
export function getDailyClaimAmount(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.daily_claim.premium_amount
    : ENTITLEMENT_CONFIG.daily_claim.normal_amount;
}

/**
 * Get referral reward amount for tier (inviter's tier).
 * Normal = 3 AB, Premium = 6 AB.
 */
export function getReferralRewardAmount(isPremium) {
  return isPremium
    ? ENTITLEMENT_CONFIG.referral.premium_reward
    : ENTITLEMENT_CONFIG.referral.normal_reward;
}

/**
 * Apply mission reward multiplier based on tier.
 * Normal = 1× base, Premium = 1.5× base.
 * Rounding: Math.ceil (Premium users always get AT LEAST the multiplier value).
 * token_transactions.amount is INTEGER, so we must round.
 *
 * Examples: base=5 → Premium=8 (ceil 7.5), base=10 → Premium=15 (exact).
 */
export function getMissionRewardAmount(baseAmount, isPremium) {
  const base = Math.abs(Number(baseAmount) || 0);
  if (base <= 0) return 0;
  if (!isPremium) return Math.floor(base);
  const multiplier = ENTITLEMENT_CONFIG.missions.premium_multiplier;
  return Math.ceil(base * multiplier);
}

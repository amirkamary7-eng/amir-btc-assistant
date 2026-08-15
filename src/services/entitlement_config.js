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

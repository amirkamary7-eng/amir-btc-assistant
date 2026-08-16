/**
 * MembershipAuthority — Single Source of Truth for Premium entitlement.
 *
 * PHASE 0 — FOUNDATION. This service is wired into the Worker deps but is NOT
 * yet called by any feature handler. It provides the API that future phases
 * will use to gate Premium features. No existing behavior changes.
 *
 * ARCHITECTURE
 *   Every feature that needs to know "is this user Premium?" MUST call
 *   MembershipAuthority.isPremium(env, telegramId). No feature may read
 *   membership_users.membership_status directly.
 *
 * ENTITLEMENT COMPUTATION
 *   isPremium(user, now) =
 *       user.membership_status = 'APPROVED'
 *     AND user.membership_level IN ('VIP','PREMIUM','ELITE')   // non-FREE level
 *     AND (user.expire_at IS NULL OR user.expire_at > now)
 *
 *   This derives a boolean from the existing 4-level enum (FREE/VIP/PREMIUM/ELITE)
 *   without destroying legacy data.
 *
 * CACHE POLICY
 *   - Positive cache: 60s TTL (KV key `mb:ent:{telegramId}`)
 *   - Negative cache: NEVER (a non-premium user always re-checks; cheap index scan)
 *   - Invalidation: explicit invalidate() on every state change (approve/suspend/
 *     reactivate/expire/set-level). Synchronous (awaited) so revocation is immediate.
 *   - Stale-window bound: ≤60s worst case if invalidate fails.
 *
 * SECURITY
 *   - Never trusts client state. Reads from DB via membershipRepo.
 *   - Telegram ID is the only identifier (HMAC-validated upstream).
 *   - No sensitive data logged (Telegram ID is NOT logged in full; only a hash
 *     prefix for correlation in diagnostics).
 *
 * PERFORMANCE
 *   - Single DB query on cache miss (membershipRepo.findByTelegramId).
 *   - Single-flight per user: concurrent isPremium() calls for the same user
 *     share one DB query via an in-flight Promise map.
 *   - Cache hit = 1 KV read, 0 DB queries.
 *
 * DEPENDENCIES (injected)
 *   - membershipRepo: findByTelegramId (existing)
 *   - readAppCache / writeAppCache: KV helpers (existing)
 */

export function createMembershipAuthority(deps) {
  const { membershipRepo, readAppCache, writeAppCache } = deps;

  // ─── Constants ────────────────────────────────────────────────────────────

  const CACHE_KEY_PREFIX = 'mb:ent:';
  const CACHE_TTL_POSITIVE = 60; // seconds — Business Spec §5.1

  // Levels that grant Premium when status is APPROVED.
  // FREE is excluded. VIP/PREMIUM/ELITE all grant Premium.
  const PREMIUM_LEVELS = new Set(['VIP', 'PREMIUM', 'ELITE']);

  // In-flight Promise map for single-flight deduplication.
  // Key: telegramId. Value: Promise<PremiumEntitlement>.
  // Prevents N concurrent isPremium() calls from issuing N DB queries.
  const _inFlight = new Map();

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function _cacheKey(telegramId) {
    return CACHE_KEY_PREFIX + String(telegramId);
  }

  /**
   * Privacy-safe Telegram ID hash prefix for diagnostics.
   * Returns first 8 chars of a simple hash — enough for correlation, not for lookup.
   */
  function _safeIdPrefix(telegramId) {
    try {
      const id = String(telegramId || '');
      if (id.length === 0) return 'unknown';
      let h = 0;
      for (let i = 0; i < id.length; i++) {
        h = ((h << 5) - h + id.charCodeAt(i)) | 0;
      }
      return ('00000000' + (h >>> 0).toString(16)).slice(-8);
    } catch {
      return 'unknown';
    }
  }

  /**
   * Core entitlement computation from a membership_users row.
   * Pure function — no I/O, no side effects. Fully testable.
   *
   * @param {object|null} user - membership_users row, or null if not found
   * @param {Date|number|string} [now=Date.now()] - reference time
   * @returns {PremiumEntitlement}
   */
  function _computeEntitlement(user, now) {
    const refNow = now instanceof Date ? now.getTime() :
                   typeof now === 'number' ? now :
                   Date.now();

    // Default: a user with no membership record is FREE + INACTIVE.
    if (!user) {
      return {
        isPremium: false,
        level: 'FREE',
        status: 'INACTIVE',
        source: 'MANUAL',
        approvedAt: null,
        expireAt: null,
        eligible: false,
        graceUntil: null,
        computedAt: new Date(refNow).toISOString(),
      };
    }

    const level = user.membership_level || 'FREE';
    const status = user.membership_status || 'INACTIVE';
    const source = user.membership_source || 'MANUAL';
    const approvedAt = user.approved_at || null;
    const expireAt = user.expire_at || null;

    // Expire check: if expire_at is set and in the past, not premium.
    const expired = expireAt ? (new Date(expireAt).getTime() <= refNow) : false;

    // Premium = APPROVED + non-FREE level + not expired.
    const isPremium =
      status === 'APPROVED' &&
      PREMIUM_LEVELS.has(level) &&
      !expired;

    return {
      isPremium,
      level,
      status,
      source,
      approvedAt,
      expireAt,
      eligible: isPremium,
      graceUntil: null,
      computedAt: new Date(refNow).toISOString(),
    };
  }

  // ─── Cache Read/Write ─────────────────────────────────────────────────────

  async function _readCached(env, telegramId) {
    try {
      const raw = await readAppCache(env, _cacheKey(telegramId));
      if (!raw) return null;
      const parsed = JSON.parse(raw);
      if (!parsed || typeof parsed.isPremium !== 'boolean') return null;
      return parsed;
    } catch {
      return null;
    }
  }

  async function _writeCached(env, telegramId, entitlement) {
    try {
      // Only cache POSITIVE results.
      // Negative results are never cached — a non-premium user always re-checks.
      if (!entitlement.isPremium) return;
      await writeAppCache(
        env,
        _cacheKey(telegramId),
        JSON.stringify(entitlement),
        CACHE_TTL_POSITIVE
      );
    } catch (e) {
      // Non-fatal — cache write failure just means next request hits DB.
      console.warn('[MembershipAuthority] cache write failed (id=' +
        _safeIdPrefix(telegramId) + '):', e?.message || e);
    }
  }

  // ─── DB Query ─────────────────────────────────────────────────────────────

  async function _fetchUser(env, telegramId) {
    try {
      return await membershipRepo.findByTelegramId(env, String(telegramId));
    } catch (e) {
      console.warn('[MembershipAuthority] DB fetch failed (id=' +
        _safeIdPrefix(telegramId) + '):', e?.message || e);
      return null;
    }
  }

  // ─── Public API ───────────────────────────────────────────────────────────

  /**
   * Is this user Premium right now?
   *
   * This is THE single source of truth. No feature should read
   * membership_users.membership_status directly.
   *
   * @param {object} env - Worker env
   * @param {string} telegramId - Telegram user ID (HMAC-validated upstream)
   * @returns {Promise<boolean>}
   */
  async function isPremium(env, telegramId) {
    const ent = await getEntitlement(env, telegramId);
    return ent.isPremium;
  }

  /**
   * Get the full entitlement object for a user.
   *
   * Flow:
   *   1. Check positive cache (KV, 60s TTL). If hit, return.
   *   2. Single-flight: if another call for the same user is in-flight, await it.
   *   3. Query DB (membershipRepo.findByTelegramId).
   *   4. Compute entitlement (pure function).
   *   5. Cache if positive (never cache negative).
   *   6. Return.
   *
   * @param {object} env
   * @param {string} telegramId
   * @returns {Promise<PremiumEntitlement>}
   */
  async function getEntitlement(env, telegramId) {
    const id = String(telegramId || '');

    // 1. Positive cache check
    const cached = await _readCached(env, id);
    if (cached) return cached;

    // 2. Single-flight deduplication
    const existing = _inFlight.get(id);
    if (existing) return existing;

    // 3. Issue the DB query + compute + cache
    const promise = (async () => {
      try {
        const user = await _fetchUser(env, id);
        const entitlement = _computeEntitlement(user, Date.now());
        await _writeCached(env, id, entitlement);
        return entitlement;
      } finally {
        _inFlight.delete(id);
      }
    })();

    _inFlight.set(id, promise);
    return promise;
  }

  /**
   * Invalidate the entitlement cache for a user.
   *
   * MUST be called on every membership state change:
   *   - approve, reject, suspend, reactivate, expire (admin actions)
   *   - set-level (admin)
   *   - submit / reapply (user actions — status → PENDING)
   *   - cron expiry sweep (per user)
   *
   * Synchronous (awaited) so revocation is immediate.
   * Also busts the status-response cache (mb:status:{id}) for consistency.
   *
   * @param {object} env
   * @param {string} telegramId
   */
  async function invalidate(env, telegramId) {
    const id = String(telegramId || '');
    try {
      await env.APP_CACHE?.delete?.(_cacheKey(id));
      await env.APP_CACHE?.delete?.('mb:status:' + id);
    } catch (e) {
      console.warn('[MembershipAuthority] invalidate failed (id=' +
        _safeIdPrefix(id) + '):', e?.message || e);
    }
  }

  // ─── Export ───────────────────────────────────────────────────────────────

  return Object.freeze({
    isPremium,
    getEntitlement,
    invalidate,
    // Pure function exposed for unit testing
    _computeEntitlement,
    // Constants exposed for tests
    _constants: Object.freeze({
      CACHE_TTL_POSITIVE,
      PREMIUM_LEVELS: new Set(PREMIUM_LEVELS),
    }),
  });
}

/**
 * @typedef {Object} PremiumEntitlement
 * @property {boolean} isPremium - THE boolean. Single source of truth.
 * @property {'FREE'|'VIP'|'PREMIUM'|'ELITE'} level - raw DB level
 * @property {'INACTIVE'|'PENDING'|'APPROVED'|'REJECTED'|'SUSPENDED'|'EXPIRED'} status - raw DB status
 * @property {string} source - membership_source
 * @property {string|null} approvedAt - ISO timestamp
 * @property {string|null} expireAt - ISO timestamp
 * @property {boolean} eligible - mirrors isPremium (Phase 2+ will add requirement check)
 * @property {string|null} graceUntil - null in Phase 0
 * @property {string} computedAt - ISO timestamp of this computation
 */

/**
 * MembershipGateway — Central membership decision authority.
 *
 * PURPOSE:
 *   Single source of truth for "is this user a member of all required channels?"
 *   All membership checks funnel through `membershipGateway.check()`.
 *
 * WHAT'S INSIDE (membership concerns only):
 *   - Admin bypass (sync, no Telegram)
 *   - Guest bypass (sync)
 *   - KV cache (join:{userId} + adch:{userId}:{hash})
 *   - In-memory request cache (30s, per-isolate) — middleware hot path
 *   - In-flight deduplication (same user+forceRefresh → reuse promise)
 *   - Parallel Telegram checks via Promise.allSettled (primary + required channels)
 *   - Per-call 5s AbortController timeout
 *   - 8s overall gateway timeout
 *   - isJoinedMember status interpretation (restricted+is_member=false handled)
 *   - DB persistence (fire-and-forget via ctx.waitUntil when available)
 *   - Structured observability (elapsed_ms, reason, channels)
 *
 * WHAT'S OUTSIDE (not membership concerns):
 *   - Referral processing (processReferralOnBootstrap, processPendingReferralReward)
 *   - Daily missions (fireDailyLoginMission)
 *   - Admin ROLE/permissions (requireAdmin, isSuperAdmin — admin BYPASS is inside, admin ROLE is outside)
 *   - Premium business logic (MembershipAuthority)
 *   - UI logic (Join Lock rendering — frontend)
 *   - Menu sync (syncMenuButton — Telegram side-effect)
 *   - Advertisement logic, Notification logic
 *
 * SECURITY:
 *   - Fail-closed: on Telegram api_error/timeout/429/500 → { joined: false, reason: 'api_error' }
 *   - Admin bypass: isAdminTelegramId → { joined: true, admin: true } (no Telegram call)
 *   - Guest bypass: guest_* userId → { joined: false, reason: 'guest_user' }
 *
 * PERFORMANCE:
 *   - Parallel: primary + required channels run via Promise.allSettled (5s max, not 5s+5s)
 *   - Dedup: same user+forceRefresh → single in-flight promise (no duplicate Telegram calls)
 *   - In-memory cache: 30s TTL for middleware hot path (avoids KV read on every request)
 *
 * API CONTRACT PRESERVATION:
 *   - bootstrap.channel_joined (boolean) — preserved
 *   - check-join.channel_joined (boolean) — preserved
 *   - /start reply (join keyboard or Mini App button) — preserved
 *   - requireChannelJoin middleware (403 if not member) — preserved
 */

/**
 * Create the MembershipGateway.
 *
 * @param {object} deps — Injected dependencies (same pattern as other controllers)
 * @param {function} deps.isAdminTelegramId
 * @param {function} deps.getCachedJoinStatus
 * @param {function} deps.setCachedJoinStatus
 * @param {function} deps.getDbUserJoinState
 * @param {function} deps.persistDbUserJoinState
 * @param {function} deps.checkChannelMembership
 * @param {function} deps.checkAdditionalRequiredChannels
 * @param {function} deps.isDatabaseConfigured
 * @param {function} deps.safeError
 * @returns {{ check: function }}
 */
export function createMembershipGateway(deps) {
  const {
    isAdminTelegramId,
    getCachedJoinStatus,
    setCachedJoinStatus,
    getDbUserJoinState,
    persistDbUserJoinState,
    checkChannelMembership,
    checkAdditionalRequiredChannels,
    isDatabaseConfigured,
    safeError,
  } = deps;

  // ==========================================================================
  // In-flight deduplication map.
  //
  // Key: `${telegramId}:${forceRefresh}`
  // Value: Promise<MembershipResult>
  //
  // When multiple callers request membership for the same user with the same
  // forceRefresh flag within the same request lifecycle, they all reuse the
  // SAME promise. This prevents duplicate Telegram API calls.
  //
  // Cross-user safety: the key includes telegramId, so different users get
  // different entries. No leakage.
  //
  // The map is per-isolate (module-level). Entries are removed in finally()
  // so a completed check doesn't hold the promise.
  // ==========================================================================
  const _inFlightChecks = new Map();

  // ==========================================================================
  // In-memory session cache (per-isolate).
  //
  // Key: `session:${telegramId}`
  // Value: { joined: boolean, ts: number }
  // TTL: 30 seconds
  //
  // This is a FAST cache that sits in front of the KV cache. It exists because
  // requireChannelJoin middleware runs on EVERY protected API request, and
  // reading KV on every request adds latency. The 30s TTL is short enough that
  // a user who leaves the channel is detected within 30s on the next request
  // that misses this cache and hits KV (60s TTL for not-joined).
  //
  // forceRefresh:true skips this cache entirely.
  // ==========================================================================
  const _SESSION_CACHE_TTL_MS = 30 * 1000;
  const _sessionCache = new Map(); // key: `session:${telegramId}` → { joined, ts }

  function _getSessionCache(telegramId) {
    const key = `session:${telegramId}`;
    const entry = _sessionCache.get(key);
    if (!entry) return null;
    if (Date.now() - entry.ts > _SESSION_CACHE_TTL_MS) {
      _sessionCache.delete(key);
      return null;
    }
    return entry;
  }

  function _setSessionCache(telegramId, joined) {
    const key = `session:${telegramId}`;
    _sessionCache.set(key, { joined, ts: Date.now() });
    // Cap the cache size to prevent unbounded growth in a long-lived isolate
    if (_sessionCache.size > 1000) {
      // Evict oldest 100 entries (simple LRU-ish)
      const keys = _sessionCache.keys();
      for (let i = 0; i < 100; i++) {
        const k = keys.next().value;
        if (k) _sessionCache.delete(k);
      }
    }
  }

  /**
   * Check channel membership for a Telegram user.
   *
   * @param {object} env - Cloudflare Worker env
   * @param {string} telegramId - Telegram user ID (string)
   * @param {object} opts
   * @param {boolean} [opts.forceRefresh=false] - Skip all caches, force fresh Telegram check
   * @param {boolean} [opts.skipSessionCache=false] - Skip in-memory session cache only (KV still checked)
   * @param {number} [opts.timeout=8000] - Overall gateway timeout in ms
   * @returns {Promise<{joined: boolean, reason: string, channels: {checked: number, failed: string[]}, admin: boolean, cached: boolean, elapsed_ms: number}>}
   */
  async function check(env, telegramId, opts = {}) {
    const t0 = Date.now();
    const forceRefresh = Boolean(opts.forceRefresh);
    const skipSessionCache = Boolean(opts.skipSessionCache);
    const overallTimeout = opts.timeout || 8000;
    const uid = String(telegramId);

    // ── 1. Guest bypass ──
    if (uid.startsWith('guest_')) {
      return { joined: false, reason: 'guest_user', channels: { checked: 0, failed: [] }, admin: false, cached: false, elapsed_ms: Date.now() - t0 };
    }

    // ── 2. Admin bypass (sync, no Telegram, no DB, no KV) ──
    if (isAdminTelegramId(env, uid)) {
      return { joined: true, reason: 'admin_bypass', channels: { checked: 0, failed: [] }, admin: true, cached: false, elapsed_ms: Date.now() - t0 };
    }

    // ── 3. In-flight deduplication ──
    // If another caller is already checking this user with the same forceRefresh,
    // reuse the same promise. This prevents duplicate Telegram calls when
    // bootstrap + middleware run concurrently.
    const dedupKey = `${uid}:${forceRefresh}`;
    if (_inFlightChecks.has(dedupKey)) {
      return _inFlightChecks.get(dedupKey);
    }

    // ── 4. Execute the real check, wrapped in dedup + overall timeout ──
    const work = _doCheck(env, uid, { forceRefresh, skipSessionCache, t0 })
      .finally(() => { _inFlightChecks.delete(dedupKey); });

    _inFlightChecks.set(dedupKey, work);

    // Race against overall gateway timeout
    const timeoutPromise = new Promise(resolve => {
      setTimeout(() => {
        resolve({ joined: false, reason: 'timeout', channels: { checked: 0, failed: [] }, admin: false, cached: false, elapsed_ms: Date.now() - t0 });
      }, overallTimeout);
    });

    return Promise.race([work, timeoutPromise]);
  }

  /**
   * Internal: the actual membership check logic.
   * Separated from check() so dedup + timeout can wrap it.
   */
  async function _doCheck(env, uid, { forceRefresh, skipSessionCache, t0 }) {
    // ── Session cache (in-memory, 30s) — only when not forceRefresh ──
    if (!forceRefresh && !skipSessionCache) {
      const session = _getSessionCache(uid);
      if (session !== null) {
        return { joined: session.joined, reason: 'cached', channels: { checked: 0, failed: [] }, admin: false, cached: true, elapsed_ms: Date.now() - t0 };
      }
    }

    // ── KV cache (join:{userId}) ──
    if (!forceRefresh) {
      const cached = await getCachedJoinStatus(env, uid);
      if (cached === true) {
        // KV says joined — enforce additional channels (hash-based cache)
        const extra = await checkAdditionalRequiredChannels(env, uid);
        if (!extra.joined) {
          // A required channel was added since this cache entry was written
          await setCachedJoinStatus(env, uid, false);
          if (isDatabaseConfigured(env)) {
            await persistDbUserJoinState(env, uid, false).catch(() => {});
          }
          _setSessionCache(uid, false);
          return { joined: false, reason: 'additional_channel_required', channels: { checked: 1, failed: [extra.channel].filter(Boolean) }, admin: false, cached: false, elapsed_ms: Date.now() - t0 };
        }
        _setSessionCache(uid, true);
        return { joined: true, reason: 'cached', channels: { checked: 0, failed: [] }, admin: false, cached: true, elapsed_ms: Date.now() - t0 };
      }
      if (cached === false) {
        _setSessionCache(uid, false);
        return { joined: false, reason: 'cached', channels: { checked: 0, failed: [] }, admin: false, cached: true, elapsed_ms: Date.now() - t0 };
      }

      // ── DB cache (users.channel_joined) ──
      if (isDatabaseConfigured(env)) {
        const dbUser = await getDbUserJoinState(env, uid);
        if (dbUser?.channel_joined) {
          const extra = await checkAdditionalRequiredChannels(env, uid);
          if (!extra.joined) {
            await setCachedJoinStatus(env, uid, false);
            await persistDbUserJoinState(env, uid, false).catch(() => {});
            _setSessionCache(uid, false);
            return { joined: false, reason: 'additional_channel_required', channels: { checked: 1, failed: [extra.channel].filter(Boolean) }, admin: false, cached: false, elapsed_ms: Date.now() - t0 };
          }
          await setCachedJoinStatus(env, uid, true);
          _setSessionCache(uid, true);
          return { joined: true, reason: 'from_db', channels: { checked: 0, failed: [] }, admin: false, cached: true, elapsed_ms: Date.now() - t0 };
        }
      }
    }

    // ── Fresh Telegram check — PARALLEL: primary + required channels ──
    // ROOT-CAUSE FIX (ISSUE-003): previously sequential (5s + 5s = 10s).
    // Now Promise.allSettled runs them in parallel (max 5s).
    //
    // We use allSettled (not all) because:
    // - If primary channel check times out but required channels succeed,
    //   Promise.all would reject and we'd lose the required channels result.
    // - allSettled waits for ALL, lets us aggregate.
    //
    // SECURITY: fail-closed. If EITHER check errors, user is NOT joined.
    // The only exception: if primary says joined AND required says joined,
    // user is joined. Any other combination → not joined.
    const [primarySettled, extraSettled] = await Promise.allSettled([
      checkChannelMembership(uid, env),
      checkAdditionalRequiredChannels(env, uid, { forceRefresh }),
    ]);

    const primaryResult = primarySettled.status === 'fulfilled'
      ? primarySettled.value
      : { joined: false, reason: 'api_error', detail: String(primarySettled.reason?.message || primarySettled.reason) };
    const extraResult = extraSettled.status === 'fulfilled'
      ? extraSettled.value
      : { joined: false, reason: 'api_error', detail: String(extraSettled.reason?.message || extraSettled.reason) };

    // ── Aggregate results ──
    const failedChannels = [];
    if (!extraResult.joined && extraResult.channel) {
      failedChannels.push(extraResult.channel);
    }

    if (primaryResult.joined && extraResult.joined) {
      // Both joined — cache + persist + return joined:true
      await setCachedJoinStatus(env, uid, true);
      if (isDatabaseConfigured(env)) {
        await persistDbUserJoinState(env, uid, true).catch(() => {});
      }
      _setSessionCache(uid, true);
      return { joined: true, reason: 'member', channels: { checked: 1 + (extraResult.channels || 0), failed: [] }, admin: false, cached: false, elapsed_ms: Date.now() - t0 };
    }

    // ── Not joined — classify the reason ──
    let reason = 'not_member';
    if (primaryResult.reason === 'api_error' || extraResult.reason === 'api_error') {
      // Fail-closed on Telegram error
      return { joined: false, reason: 'api_error', channels: { checked: 1 + (extraResult.channels || 0), failed: failedChannels }, admin: false, cached: false, elapsed_ms: Date.now() - t0 };
    }
    if (primaryResult.reason === 'bot_not_in_channel' || extraResult.reason === 'bot_not_in_channel') {
      reason = 'bot_not_in_channel';
    } else if (primaryResult.reason === 'channel_not_found' || extraResult.reason === 'channel_not_found') {
      reason = 'channel_not_found';
    } else if (primaryResult.joined && !extraResult.joined) {
      reason = 'additional_channel_required';
    } else if (!primaryResult.joined) {
      reason = primaryResult.reason || 'not_member';
    }

    // Cache negative result
    await setCachedJoinStatus(env, uid, false);
    if (isDatabaseConfigured(env)) {
      await persistDbUserJoinState(env, uid, false).catch(() => {});
    }
    _setSessionCache(uid, false);
    return { joined: false, reason, channels: { checked: 1 + (extraResult.channels || 0), failed: failedChannels }, admin: false, cached: false, elapsed_ms: Date.now() - t0 };
  }

  return { check };
}

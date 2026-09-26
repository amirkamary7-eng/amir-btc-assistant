// ═════════════════════════════════════════════════════════════════════════════
// Channel Membership Service — extracted from worker-proxy.js (lines 2860-3250).
//
// Factory pattern: createChannelMembershipService({ ...DI deps... })
// Returns: { getChatMemberDebugPayload, checkChannelMembership,
//            _getActiveAdChannels, _hashChannelSet,
//            _checkSingleTelegramChannel, checkAdditionalRequiredChannels,
//            resolveChannelMembership }
//
// DI dependencies (13 user-identified + 1 discovered):
//   1.  setCachedJoinStatus: Persist KV join-status (from worker-proxy.js core)
//   2.  getCachedJoinStatus: Read KV join-status (from worker-proxy.js core)
//   3.  isDatabaseConfigured: DB readiness check (from worker-proxy.js core)
//   4.  isBotConfigured: Bot token readiness check (from worker-proxy.js core)
//   5.  persistDbUserJoinState: Persist DB user join-state (from worker-proxy.js core)
//   6.  getDbUserJoinState: Read DB user join-state (from worker-proxy.js core)
//   7.  isAdminTelegramId: Admin ID check (from worker-proxy.js core)
//   8.  _kvWriteDedup: Dedup KV writes (from worker-proxy.js core)
//   9.  resolveRequiredChannel: Resolve env REQUIRED_CHANNEL (from worker-proxy.js core)
//   10. getTelegramChatId: Resolve Telegram chat_id (from worker-proxy.js core)
//   11. isJoinedMember: Interpret getChatMember result (from worker-proxy.js core)
//   12. safeError: Error sanitizer for logging (from worker-proxy.js core)
//   13. processPendingReferralReward: CYCLE-BREAKER from createReferralRewardsService
//       (factory must be initialized AFTER referral-rewards service so this DI is
//       in scope). Used inside resolveChannelMembership when a user joins and
//       skipRewardProcessing is false.
//   14. getAdvertisementsRepo: DISCOVERED DI (lazy getter).
//       advertisementsRepo is initialized in worker-proxy.js composition root
//       (line ~4456, AFTER this factory call at line ~4058). To preserve the
//       original late-binding pattern (`typeof advertisementsRepo === 'undefined'`)
//       while keeping DI explicit, we pass a getter closure that returns the
//       module-level advertisementsRepo at runtime (always defined by the time
//       any request handler runs). This avoids TDZ without introducing a bare
//       reference in the extracted module.
//
// All 7 functions are returned from the factory (none internal-only).
//
// NOT extracted (stay in worker-proxy.js as core helpers / infrastructure):
//   - isJoinedMember (line 1167) — used by this service via DI; also kept for
//     other potential callers
//   - JOINED_STATUSES constant (line 1143) — used by isJoinedMember
//   - requireChannelJoin middleware (line 1084) — calls membershipGateway.check,
//     not these functions directly
//   - advertisementsRepo composition root (line 4456) — initialized AFTER this
//     factory; accessed via getAdvertisementsRepo getter (DI #14)
//
// NO module-level mutable state in extracted functions (verified by audit).
// I/O: Telegram getChatMember (max N parallel calls per fresh check, N = active
//       DB channel count), KV reads (RATE_LIMITS), KV writes (via _kvWriteDedup),
//       DB queries (getDbUserJoinState, persistDbUserJoinState via worker-proxy.js
//       core helpers), referral processing (processPendingReferralReward).
//
// Behavior-preserving extraction: no logic, I/O, or error handling changes.
// ═══════════════════════════════════════════════════════════════════════════

export function createChannelMembershipService({
  setCachedJoinStatus,
  getCachedJoinStatus,
  isDatabaseConfigured,
  isBotConfigured,
  persistDbUserJoinState,
  getDbUserJoinState,
  isAdminTelegramId,
  _kvWriteDedup,
  resolveRequiredChannel,
  getTelegramChatId,
  isJoinedMember,
  safeError,
  processPendingReferralReward,
  getAdvertisementsRepo,
}) {

async function getChatMemberDebugPayload(userId, env) {
  const uid = String(userId);
  const requiredChannel = resolveRequiredChannel(env);
  const chatId = getTelegramChatId(env);
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '');
  const botConfigured = isBotConfigured(env);
  const isAdmin = isAdminTelegramId(env, uid);
  const payload = {
    required_channel: requiredChannel,
    chat_id_used: chatId,
    user_id: uid,
    bot_configured: botConfigured,
    is_admin: isAdmin,
    telegram_response: null,
    joined: false,
  };

  if (uid.startsWith('guest_')) {
    payload.telegram_response = { reason: 'guest_user' };
    return payload;
  }

  if (isAdmin) {
    payload.telegram_response = { admin: true, reason: 'admin_bypass' };
    payload.joined = true;
    return payload;
  }

  if (!botConfigured) {
    payload.telegram_response = { reason: 'bot_not_configured' };
    return payload;
  }

  if (!/^\d+$/.test(uid)) {
    payload.telegram_response = { reason: 'invalid_user_id', value: uid };
    return payload;
  }

  try {
    const telegramUrl = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(uid)}`;
    // HOTFIX (Commit 2.4): Add 5s AbortController timeout to Telegram getChatMember fetch.
    // Without this, the fetch can hang indefinitely, causing the Worker to be killed
    // by the runtime ("code had hung"). This is on the critical path for both
    // bootstrap and all protected endpoints (via requireChannelJoin → resolveChannelMembership
    // → checkChannelMembership → getChatMemberDebugPayload).
    // On timeout/abort, the existing catch block handles it gracefully — returns
    // payload with telegram_response.exception set, and the caller treats it as
    // "not joined" (safe fallback). No membership semantics change.
    const tgController = new AbortController();
    const tgTimeoutId = setTimeout(() => tgController.abort(), 5000);
    try {
      const telegramResponse = await fetch(telegramUrl, { signal: tgController.signal });
      const data = await telegramResponse.json();
      payload.telegram_response = data;
      // ROOT-CAUSE FIX (audit/start-join-check): use isJoinedMember() instead of
      // JOINED_STATUSES.has(status) so that `restricted` + `is_member: false`
      // (user was restricted AND has left the channel) is correctly treated as
      // NOT joined. Previously, all `restricted` users were treated as joined.
      payload.joined = Boolean(data?.ok && isJoinedMember(data?.result));

      return payload;
    } finally {
      clearTimeout(tgTimeoutId);
    }
  } catch (error) {
    payload.telegram_response = {
      exception: error instanceof Error ? error.name : 'Error',
      message: error instanceof Error ? error.message : String(error),
    };
    return payload;
  }
}

async function checkChannelMembership(userId, env) {
  const debugPayload = await getChatMemberDebugPayload(userId, env);
  const telegramResponse = debugPayload.telegram_response;

  if (telegramResponse && typeof telegramResponse === 'object') {
    if (telegramResponse.reason === 'guest_user') {
      return { joined: false, reason: 'guest_user' };
    }
    if (telegramResponse.reason === 'admin_bypass') {
      return { joined: true, admin: true };
    }
    if (telegramResponse.reason === 'bot_not_configured') {
      return { joined: false, reason: 'bot_not_configured' };
    }
    if (telegramResponse.ok) {
      // ROOT-CAUSE FIX (audit/start-join-check): use isJoinedMember() so that
      // `restricted` + `is_member: false` is correctly NOT joined.
      return { joined: isJoinedMember(telegramResponse?.result) };
    }

    const description = String(telegramResponse.description || '');
    const lowerDescription = description.toLowerCase();
    // ROOT-CAUSE FIX (audit/start-join-check): check `bot is not a member` BEFORE
    // `not a member`, because Telegram's error string 'Bad Request: bot is not a
    // member of the channel chat' CONTAINS the substring 'not a member'. With the
    // previous ordering, every bot_not_in_channel case was misclassified as
    // not_member — meaning the admin saw 'user is not a member' instead of the
    // correct 'bot is not in channel' system-error message.
    if (lowerDescription.includes('bot is not a member') || lowerDescription.includes('need administrator')) {
      return { joined: false, reason: 'bot_not_in_channel', detail: description };
    }
    if (lowerDescription.includes('user not found') || lowerDescription.includes('not a member')) {
      return { joined: false, reason: 'not_member', detail: description };
    }
    if (lowerDescription.includes('chat not found')) {
      return { joined: false, reason: 'channel_not_found', detail: description };
    }
    if (telegramResponse.http_error || telegramResponse.exception) {
      return { joined: false, reason: 'api_error', detail: JSON.stringify(telegramResponse) };
    }
    return { joined: false, reason: 'api_error', detail: description };
  }

  return { joined: false, reason: 'api_error' };
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 2 — Multi-channel join-lock (Admin-configured required channels)
// ═══════════════════════════════════════════════════════════════════════════
//
// The existing checkChannelMembership() checks ONLY the env.REQUIRED_CHANNEL.
// Phase 2 extends this: admin-configured channels in ad_channels (active,
// status='active') are ALSO required. A user must be a member of ALL of them
// (env channel AND every DB channel) to pass requireChannelJoin.
//
// Cache strategy:
//   - Module-level cache (60s TTL) for the active channel list — shared by all
//     requests in the isolate. Invalidated on admin mutations.
//   - Per-user KV cache (60s TTL) for the DB-channel membership result, keyed
//     by `adch:${userId}:${channelSetHash}`. The hash includes every active
//     channel username, so when admin changes the channel list, the hash
//     changes → cache miss → fresh check. This satisfies Phase 2's requirement:
//     "با تغییر لیست کانال‌ها توسط Admin، state قدیمی باعث bypass نشود."
//
// Telegram API budget: at most N getChatMember calls per uncached request,
// where N = number of active DB channels (typically 1-3). Cached requests do
// ZERO Telegram calls (KV hit). This bounds Telegram API load while enforcing
// new channels within 60 seconds of admin change.

async function _getActiveAdChannels(env) {
  // Late-binding: advertisementsRepo is created after this function definition
  // (it's a module-level const initialized in the fetch handler setup). We use
  // a lazy getter to avoid TDZ issues.
  const advertisementsRepo = getAdvertisementsRepo ? getAdvertisementsRepo() : undefined;
  if (typeof advertisementsRepo === 'undefined' || !advertisementsRepo) return [];
  try {
    return await advertisementsRepo.listActiveRequiredChannels(env);
  } catch (e) {
    console.warn('[multi-channel] listActiveRequiredChannels failed:', e.message || e);
    return [];
  }
}

function _hashChannelSet(channels) {
  if (!channels || channels.length === 0) return '0';
  const names = channels.map(c => String(c.username || '').toLowerCase()).sort().join(',');
  let h = 0;
  for (let i = 0; i < names.length; i++) {
    h = ((h << 5) - h + names.charCodeAt(i)) | 0;
  }
  return Math.abs(h).toString(36);
}

async function _checkSingleTelegramChannel(env, chatId, userId) {
  const botToken = String(env.TELEGRAM_BOT_TOKEN || '');
  if (!botToken) return { joined: false, reason: 'bot_not_configured' };
  const url = `https://api.telegram.org/bot${botToken}/getChatMember?chat_id=${encodeURIComponent(chatId)}&user_id=${encodeURIComponent(userId)}`;
  const controller = new AbortController();
  const timeoutId = setTimeout(() => controller.abort(), 5000);
  try {
    const r = await fetch(url, { signal: controller.signal });
    const data = await r.json();
    if (data?.ok) {
      // ROOT-CAUSE FIX (audit/start-join-check): use isJoinedMember() so that
      // `restricted` + `is_member: false` is correctly NOT joined (same fix as
      // the primary channel check).
      return { joined: isJoinedMember(data?.result) };
    }
    return { joined: false, reason: 'api_error', detail: data?.description || '' };
  } catch (e) {
    return { joined: false, reason: 'api_error', detail: e.message || String(e) };
  } finally {
    clearTimeout(timeoutId);
  }
}

/**
 * Check membership in ALL admin-configured required channels (ad_channels).
 * Returns { joined: true } only if user is a member of every active channel.
 * Uses per-user KV cache (60s TTL) keyed by channel-set hash for instant
 * invalidation when admin changes the channel list.
 */
async function checkAdditionalRequiredChannels(env, userId, { forceRefresh = false } = {}) {
  const uid = String(userId);
  const channels = await _getActiveAdChannels(env);
  if (channels.length === 0) {
    return { joined: true, channels: 0 }; // no DB channels → trivially pass
  }

  const hash = _hashChannelSet(channels);
  const cacheKey = `adch:${uid}:${hash}`;

  // FIX (audit H3): Jittered TTL to avoid cache-stampede when admin changes the
  // channel list. Without jitter, all per-user cache entries expire at the same
  // 60s mark → synchronized re-fetch → thundering herd of Telegram getChatMember
  // calls → exceeds Telegram's 30 req/sec rate limit. With jitter (55-95s),
  // expiration spreads out → at most 1-2 concurrent refreshes per second.
  // Seed the jitter with uid+hash so the same user gets a consistent TTL
  // (avoids the same user refreshing every 55s in a tight loop).
  const _jitterSeed = (uid.charCodeAt(0) || 0) + hash.charCodeAt(0 || 0) || 0;
  const _ttlJitter = 40 * (((_jitterSeed * 9301 + 49297) % 233280) / 233280); // 0-40s jitter
  const _ttlPos = Math.floor(55 + _ttlJitter); // 55-95s for positive (joined)
  const _ttlNeg = Math.floor(55 + _ttlJitter); // 55-95s for negative (not joined)

  // ROOT-CAUSE FIX (AUDIT-P1 / Bug #2): respect forceRefresh — skip the KV
  // cache when the caller explicitly requested a fresh check (e.g., /start,
  // /api/users/check-join, bootstrap after a not-joined result). This ensures
  // that even if the per-isolate _campaignCache returns a stale channel list,
  // we still do a FRESH Telegram getChatMember call for each channel in that
  // list rather than trusting a potentially-stale '1' from the KV cache.
  if (!forceRefresh && env.RATE_LIMITS && typeof env.RATE_LIMITS.get === 'function') {
    try {
      const cached = await env.RATE_LIMITS.get(cacheKey);
      if (cached === '1') return { joined: true, channels: channels.length, cached: true };
      if (cached === '0') return { joined: false, channels: channels.length, cached: true, reason: 'not_member' };
    } catch { /* non-fatal */ }
  }

  // Fresh check: call Telegram getChatMember for each channel.
  // ROOT-CAUSE FIX (AUDIT-P1-JOINCHECK / Bug #4): parallelize the per-channel
  // Telegram getChatMember calls. The previous sequential `for` loop took up to
  // N×5s (e.g., 25s for 5 channels), which exceeded the Worker 30s wall-clock
  // limit and the frontend apiFetch 15s timeout — causing "loading forever"
  // symptoms. With Promise.all, the total is bounded at 5s regardless of N.
  // Each _checkSingleTelegramChannel has its own 5s AbortController, so the
  // overall worst-case latency is ~5s (the slowest channel), not 5N seconds.
  const channelResults = await Promise.all(
    channels.map(ch => {
      const chatId = ch.username.startsWith('-') ? ch.username : `@${ch.username}`;
      return _checkSingleTelegramChannel(env, chatId, uid);
    })
  );
  for (let i = 0; i < channels.length; i++) {
    const result = channelResults[i];
    if (!result.joined) {
      // Cache negative result (jittered TTL) — avoids hammering Telegram for known-not-members.
      // KV-WRITE-OPT: Route through _kvWriteDedup to prevent redundant RATE_LIMITS
      // writes when the value ('0') is unchanged within the TTL window.
      await _kvWriteDedup(env.RATE_LIMITS, cacheKey, '0', _ttlNeg);
      return { joined: false, channels: channels.length, reason: result.reason || 'not_member', channel: channels[i].username };
    }
  }

  // All channels joined — cache positive result (jittered TTL).
  // KV-WRITE-OPT: Route through _kvWriteDedup to prevent redundant RATE_LIMITS
  // writes when the value ('1') is unchanged within the TTL window.
  await _kvWriteDedup(env.RATE_LIMITS, cacheKey, '1', _ttlPos);
  return { joined: true, channels: channels.length };
}

async function resolveChannelMembership(env, userId, { forceRefresh = false, skipRewardProcessing = false } = {}) {
  const uid = String(userId);

  if (uid.startsWith('guest_')) {
    return { joined: false, reason: 'guest_user' };
  }

  if (isAdminTelegramId(env, uid)) {
    return { joined: true, admin: true };
  }

  try {
    if (!forceRefresh) {
      const cached = await getCachedJoinStatus(env, uid);
      if (cached === true) {
        // PHASE 2: Even on primary cache hit, enforce admin-configured DB channels.
        // The DB-channel check has its own per-user cache (60s TTL, keyed by
        // channel-set hash) so this is a KV read — cheap. If admin added a new
        // required channel since the primary cache was written, the DB-channel
        // cache key hash changes → cache miss → fresh Telegram check → enforces
        // the new channel immediately (no stale bypass).
        const extra = await checkAdditionalRequiredChannels(env, uid);
        if (!extra.joined) {
          // Primary channel joined, but a DB channel is not → revoke access.
          await setCachedJoinStatus(env, uid, false);
          if (isDatabaseConfigured(env)) {
            await persistDbUserJoinState(env, uid, false).catch(() => {});
          }
          return { joined: false, reason: 'additional_channel_required', channel: extra.channel };
        }
        return { joined: true, cached: true };
      }

      if (isDatabaseConfigured(env)) {
        const dbUser = await getDbUserJoinState(env, uid);
        if (dbUser?.channel_joined) {
          // PHASE 2: same DB-channel enforcement on DB-cache hit.
          const extra = await checkAdditionalRequiredChannels(env, uid);
          if (!extra.joined) {
            await setCachedJoinStatus(env, uid, false);
            await persistDbUserJoinState(env, uid, false).catch(() => {});
            return { joined: false, reason: 'additional_channel_required', channel: extra.channel };
          }
          await setCachedJoinStatus(env, uid, true);
          return { joined: true, from_db: true };
        }
      }
    }

    const result = await checkChannelMembership(uid, env);
    if (result.joined) {
      // PHASE 2: primary env channel joined — now check admin-configured DB channels.
      // ROOT-CAUSE FIX (AUDIT-P1 / Bug #2): propagate forceRefresh so that when
      // the caller explicitly requested a fresh check, the DB-channel check also
      // skips its KV cache and does a real Telegram getChatMember call.
      const extra = await checkAdditionalRequiredChannels(env, uid, { forceRefresh });
      if (!extra.joined) {
        // Primary channel joined but a DB channel is not → treat as not-joined.
        await setCachedJoinStatus(env, uid, false);
        if (isDatabaseConfigured(env)) {
          await persistDbUserJoinState(env, uid, false).catch(() => {});
        }
        return { joined: false, reason: 'additional_channel_required', channel: extra.channel };
      }
      await setCachedJoinStatus(env, uid, true);
      if (isDatabaseConfigured(env)) {
        await persistDbUserJoinState(env, uid, true);
        // ROOT-CAUSE FIX for CPU exhaustion:
        //
        // processPendingReferralReward is ONLY called when skipRewardProcessing
        // is false. This flag is true for requireChannelJoin (the middleware that
        // gates every protected API endpoint: /api/wallet, /api/referrals/stats,
        // /api/sessions/online, etc.). Previously, EVERY protected endpoint
        // triggered the full referral reward chain (up to 6 queryDb calls:
        // isSubsystemDisabled + getReferralRewardPerInvite + SELECT referrals +
        // validateRules + creditTokens(ensureSchema + SELECT + INSERT) +
        // UPDATE referrals) = ~18-30ms CPU → exceededCpu.
        //
        // Reward processing belongs in bootstrap (once per app open) and
        // check-join (user explicitly clicked "Verify"), NOT in every API call.
        // The cron retryFailedReferralRewards() catches any missed rewards.
        if (!skipRewardProcessing) {
          try {
            await processPendingReferralReward(env, uid, true);
          } catch (refErr) {
            console.warn(safeError('referral-reward-failed', refErr));
          }
        }
      }
      return result;
    }

    if (result.reason === 'api_error') {
      // ROOT-CAUSE FIX (AUDIT-P1-JOINCHECK / Bug #7): FAIL-CLOSED on Telegram
      // api_error instead of falling back to stale DB/KV cache.
      //
      // Previously, when Telegram getChatMember returned an api_error (timeout,
      // 429, 500, network failure), the code fell back to the DB
      // users.channel_joined column or the KV join:{userId} cache — both of
      // which could be STALE (e.g., a user who left the channel but whose DB
      // row still says channel_joined=true). This created a security bypass:
      // if Telegram was temporarily unavailable, stale "joined" users got in.
      //
      // The user's requirement is explicit: "نباید باعث bypass شود" (must not
      // cause bypass). So we now return joined:false on api_error. The user
      // will see the Join Lock and can retry (check-join has a 60s rate limit
      // which is acceptable for retry-after-error scenarios).
      //
      // Trade-off: during a real Telegram outage, all users see the lock.
      // This is acceptable — it's safer to temporarily lock everyone than to
      // bypass the join requirement for stale members. The lock shows a
      // "⚠️ خطای موقت در بررسی عضویت" message via the reason field.
      return { joined: false, reason: 'api_error', detail: result.detail || 'Telegram API temporarily unavailable' };
    }

    await setCachedJoinStatus(env, uid, false);
    if (isDatabaseConfigured(env)) {
      await persistDbUserJoinState(env, uid, false);
    }
    return result;
  } catch (error) {
    return {
      status: 'DB_ERROR',
      joined: false,
      reason: 'database_unavailable',
      detail: error instanceof Error ? error.message : String(error),
    };
  }
}

return {
  getChatMemberDebugPayload,
  checkChannelMembership,
  _getActiveAdChannels,
  _hashChannelSet,
  _checkSingleTelegramChannel,
  checkAdditionalRequiredChannels,
  resolveChannelMembership,
};

}

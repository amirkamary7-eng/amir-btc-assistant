/**
 * User Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, body parsing,
 * validation, response building, and cross-domain orchestration (referrals, watchlist).
 *
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createUserHandlers(deps) {
  const {
    jsonResponse,
    optionalTelegramAuth,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    normalizeOptionalString,
    isDevMode,
    isAdminTelegramId,
    processReferralOnBootstrap,
    resolveChannelMembership,
    userRepo,
    watchlistRepo,
    adminRepo,
    // [BOOTSTRAP-E2E] diagnostic logging — traces admin detection + join check
    logBootstrapE2E,
    // MISSION-ABUSE FIX: auto-fire daily_login mission on bootstrap
    fireDailyLoginMission,
  } = deps;

  /**
   * POST /api/users/bootstrap — Create or update user profile on first launch.
   * Also processes referral and returns the watchlist.
   *
   * Auth: prefers X-Telegram-Init-Data header; falls back to body.user_id
   * for development/testing outside Telegram Webview.
   */
  async function handleBootstrap(request, env) {
    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'DB_ERROR',
          message: 'Database not configured',
        },
        { status: 503 }, env);
    }

    // Parse body first — readJsonBody consumes the stream, so it must run
    // before any subsequent reads.  authenticateTelegramRequest only reads
    // headers, so calling it after body parsing is safe.
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    // Auth: prefer initData, fall back to ?user_id= query param, then body.user_id
    let userId;
    let tgUser = null;
    let auth = null;

    auth = await optionalTelegramAuth(request, env);
    if (auth.user) {
      userId = String(auth.user.id);
      tgUser = auth.user;
    } else {
      if (isDevMode(env)) {
        const fallbackId = payload.user_id;
        if (fallbackId && /^\d+$/.test(String(fallbackId).trim())) {
          userId = String(fallbackId).trim();
        }
      }
      if (!userId) {
        void logBootstrapE2E(env, { phase: 'auth_failed', userId: payload.user_id, authError: auth.error ? 'present' : 'absent' });
        return auth.error;
      }
    }

    // [BOOTSTRAP-E2E] Log auth success
    void logBootstrapE2E(env, { phase: 'auth_ok', userId, authMethod: auth.authMethod || 'initData', has_tg_user: Boolean(tgUser) });

    payload.user_id = userId;
    try {
      if (typeof userRepo.ensureTable === 'function') {
        try { await userRepo.ensureTable(env); } catch (e) {
          // ensureTable is best-effort — fall through so subsequent operations
          // can surface the real error if the table truly is missing.
        }
      }

      let preExistingUser;
      try {
        preExistingUser = await userRepo.getById(env, userId);
      } catch (e) {
        throw e;
      }

      const isNewUser = !preExistingUser;

      let userRow;
      try {
        userRow = await userRepo.bootstrap(env, userId, {
          username: normalizeOptionalString(payload.username) || normalizeOptionalString(tgUser?.username),
          first_name: normalizeOptionalString(payload.first_name) || normalizeOptionalString(tgUser?.first_name),
          last_name: normalizeOptionalString(payload.last_name) || normalizeOptionalString(tgUser?.last_name),
          lang: normalizeOptionalString(payload.lang) || normalizeOptionalString(tgUser?.language_code),
          is_premium: Boolean(tgUser?.is_premium),
        }, preExistingUser);
      } catch (e) {
        throw e;
      }
      let signedReferrerId = normalizeOptionalString(payload.referrer_id);
      if (auth?.startParam && typeof auth.startParam === 'string') {
        const match = auth.startParam.match(/^ref_(\d+)$/);
        if (match) signedReferrerId = match[1];
      }

      try {
        await processReferralOnBootstrap(env, userId, signedReferrerId, Boolean(userRow?.channel_joined), isNewUser);
      } catch (e) {
        throw e;
      }

      // PHASE 1 SAFE OPTIMIZATION: Removed redundant getById call (was line 105).
      // bootstrap() returns the full 13-column row via RETURNING clause — identical
      // to what getById returns. No mutation of the users table happens between
      // bootstrap() and the old getById #3 (processReferralOnBootstrap only touches
      // referrals + token_transactions + token_balances, not users). Using userRow
      // directly saves 1 DB round-trip per bootstrap with zero behavior change.
      const freshUserRow = userRow;
      let watchlist;
      try {
        watchlist = await watchlistRepo.getSymbols(env, userId);
      } catch (e) {
        throw e;
      }

      let channelJoined = false;
      if (tgUser?.id) {
        try {
          // [BOOTSTRAP-E2E] Log membership check start
          void logBootstrapE2E(env, { phase: 'membership_check_start', userId, forceRefresh: false });
          let membership = await resolveChannelMembership(env, String(tgUser?.id || userId), { forceRefresh: false });
          // [BOOTSTRAP-E2E] Log membership check result (forceRefresh:false)
          void logBootstrapE2E(env, { phase: 'membership_check_1', userId, joined: Boolean(membership?.joined), reason: membership?.reason || null, admin: Boolean(membership?.admin) });
          if (membership?.joined) {
            channelJoined = true;
          } else {
            // ROOT-CAUSE FIX (AUDIT-P1 / Bug #1):
            // The previous "PHASE 2 SAFE OPTIMIZATION" trusted freshUserRow.channel_joined
            // (a DB column from bootstrap() RETURNING) to skip the forceRefresh:true call.
            // This was WRONG: freshUserRow.channel_joined reflects the user's join state
            // AT SOME POINT IN THE PAST — it does NOT reflect channels that were added by
            // an admin AFTER the user last joined. When admin adds a new required channel,
            // the user's users.channel_joined column is still 'true' (stale), so bootstrap
            // incorrectly returned channel_joined=true → frontend skipped Join Lock → user
            // entered Mini App → API calls 403'd.
            //
            // FIX: Always do a forceRefresh:true check when forceRefresh:false returns
            // joined:false. The cost is +1 Telegram getChatMember call per bootstrap when
            // the cache says not-joined (rare — only when KV '0' or DB channel_joined=false).
            // This is acceptable: bootstrap runs once per Mini App open, not per API call.
            membership = await resolveChannelMembership(env, String(tgUser?.id || userId), { forceRefresh: true });
            channelJoined = Boolean(membership?.joined);
            // [BOOTSTRAP-E2E] Log membership check result (forceRefresh:true)
            void logBootstrapE2E(env, { phase: 'membership_check_2', userId, joined: channelJoined, reason: membership?.reason || null });
          }
        } catch (e) {
          // On error, fall back to the DB row (best-effort). This is safe because
          // requireChannelJoin middleware will re-check on every protected API call.
          channelJoined = Boolean(freshUserRow?.channel_joined);
          // [BOOTSTRAP-E2E] Log membership check error
          void logBootstrapE2E(env, { phase: 'membership_error', userId, error: String(e?.message || e).slice(0, 200), fallback_channel_joined: channelJoined });
        }
      } else {
        channelJoined = Boolean(freshUserRow?.channel_joined);
        void logBootstrapE2E(env, { phase: 'no_tg_user_id', userId, fallback_channel_joined: channelJoined });
      }

      // [BOOTSTRAP-E2E] Log admin check start
      let isUserAdmin = isAdminTelegramId(env, userId);
      void logBootstrapE2E(env, { phase: 'admin_env_check', userId, is_admin_env: isUserAdmin });
      if (!isUserAdmin && isDatabaseConfigured(env) && adminRepo) {
        try {
          await adminRepo.ensureSchema(env).catch(() => {});
          const dbAdmin = await adminRepo.getAdminByTelegramId(env, userId);
          if (dbAdmin && dbAdmin.active) isUserAdmin = true;
          // [BOOTSTRAP-E2E] Log admin DB check result
          void logBootstrapE2E(env, { phase: 'admin_db_check', userId, db_admin_found: Boolean(dbAdmin), db_admin_active: Boolean(dbAdmin?.active), is_admin_final: isUserAdmin });
        } catch (e) {
          console.warn('[BOOTSTRAP] Admin DB check failed:', e?.message);
          void logBootstrapE2E(env, { phase: 'admin_db_error', userId, error: String(e?.message || e).slice(0, 200) });
        }
      }

      // MISSION-ABUSE FIX (WALLET-002): auto-fire the daily_login mission.
      // Bootstrap itself IS proof of login — no event_token needed for this mission.
      // Only fire for channel members (missions are for members) and when DB is configured.
      // Idempotency: mission_progress UNIQUE(user_id, mission_id, daily_date) + rewarded flag
      // + token_transactions UNIQUE(user_id, tx_type, ref_id) ensure no double-reward across
      // multiple bootstrap calls in the same day.
      if (channelJoined && isDatabaseConfigured(env) && typeof fireDailyLoginMission === 'function') {
        try {
          await fireDailyLoginMission(env, userId);
        } catch (e) {
          // Non-fatal — bootstrap must succeed even if mission reward fails.
          console.warn('[BOOTSTRAP] fireDailyLoginMission failed (non-fatal):', e?.message);
        }
      }

      // [BOOTSTRAP-E2E] Log final response
      void logBootstrapE2E(env, { phase: 'response', userId, channel_joined: channelJoined, is_admin: isUserAdmin });
      return jsonResponse({
        status: 'success',
        user: userRepo.normalizeRow(freshUserRow || userRow || { telegram_id: userId, lang: 'fa', channel_joined: false }, watchlist),
        watchlist, bot_username: String(env.BOT_USERNAME || ''), channel_joined: channelJoined, is_admin: isUserAdmin,
      }, {}, env);
    } catch (error) {
      console.warn(safeError('bootstrap-user', error));
      // [BOOTSTRAP-E2E] Log bootstrap failure
      void logBootstrapE2E(env, { phase: 'handler_error', userId, error: String(error?.message || error).slice(0, 300), error_type: error?.constructor?.name || 'Error' });
      return safeDbErrorResponse(error, { statusValue: 'DB_ERROR' }, env);
    }
  }

  /**
   * GET /api/users/me — Return the authenticated user's profile with watchlist.
   */
  async function handleMe(request, env) {
    const auth = await optionalTelegramAuth(request, env);
    if (!auth.user) {
      return auth.error;
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'error',
          message: 'Database not configured',
        },
        { status: 503 }, env);
    }
    const userId = String(auth.user.id);
    try {
      const userRow = await userRepo.getById(env, userId);
      if (!userRow) {
        return jsonResponse(
          {
            status: 'error',
            message: 'User not found',
          },
          { status: 404 }, env);
      }
      const watchlist = await watchlistRepo.getSymbols(env, userId);
      return jsonResponse({
        status: 'success',
        user: userRepo.normalizeRow(userRow, watchlist),
        watchlist,
      }, {}, env);
    } catch (error) {
      console.warn(safeError('get-current-user', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * PUT /api/users/me/settings — Update the authenticated user's language setting.
   */
  async function handleMeSettings(request, env) {
    const auth = await optionalTelegramAuth(request, env);
    if (!auth.user) {
      return auth.error;
    }

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'error',
          message: 'Database not configured',
        },
        { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    const userId = String(auth.user.id);
    payload.user_id = userId;
    try {
      const userRow = await userRepo.updateSettings(env, userId, payload);
      if (!userRow) {
        return jsonResponse(
          {
            status: 'error',
            message: 'User not found',
          },
          { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', user: userRepo.normalizeRow(userRow) }, {}, env);
    } catch (error) {
      console.warn(safeError('update-user-settings', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/users/me — Permanently delete the authenticated user's account.
   *
   * ── ROOT-CAUSE FIX: Delete Account with full cascade ──
   *
   * This endpoint allows a user to permanently delete their account and ALL
   * associated data. After deletion, the user can re-register via a referral
   * link and the referral will be properly registered (because the old
   * referral row is cascade-deleted, so the "first inviter wins" check
   * won't block the new referral).
   *
   * Security:
   *   - Requires cryptographic initData authentication (no body.user_id fallback)
   *   - Requires a confirmation payload: { confirm: "DELETE" } to prevent
   *     accidental deletion via CSRF or misclick.
   *
   * Flow:
   *   1. Authenticate user via initData
   *   2. Parse body — require { confirm: "DELETE" }
   *   3. Call userRepo.deleteAccount(env, userId) — cascades to all tables
   *   4. Return summary of what was deleted
   */
  async function handleDeleteAccount(request, env) {
    // ── DEBUG: Log every step of the delete-account flow ──
    const t0 = Date.now();

    const auth = await optionalTelegramAuth(request, env);
    if (!auth.user) {
      return auth.error;
    }

    const userId = String(auth.user.id);

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    // Parse body — require confirmation
    const bodyResult = await readJsonBody(request, 10240, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload;

    if (!payload || payload.confirm !== 'DELETE') {
      return jsonResponse({
        status: 'error',
        message: 'Confirmation required. Send { "confirm": "DELETE" } in the request body to confirm account deletion.',
      }, { status: 400 }, env);
    }


    try {
      // Verify user exists before deleting
      const existingUser = await userRepo.getById(env, userId);
      if (!existingUser) {
        return jsonResponse({ status: 'error', message: 'User not found' }, { status: 404 }, env);
      }


      // ── CASCADE DELETE ──
      const summary = await userRepo.deleteAccount(env, userId);


      return jsonResponse({
        status: 'success',
        message: 'Account permanently deleted. You can re-register anytime via the Telegram bot.',
        deleted: summary,
      }, {}, env);
    } catch (error) {
      return safeDbErrorResponse(error, { statusValue: 'DB_ERROR' }, env);
    }
  }

  return Object.freeze({ handleBootstrap, handleMe, handleMeSettings, handleDeleteAccount });
}
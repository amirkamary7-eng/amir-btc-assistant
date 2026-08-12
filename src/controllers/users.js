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
    diagLog,
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
        return auth.error;
      }
    }

    payload.user_id = userId;
    try {
      // INSTRUMENTATION: Per-operation error logging for root-cause analysis.
      const _bsLog = (op, status, extra) => {
        const entry = { scope: 'bootstrap-op', op, status, ts: Date.now(), ...extra };
        console.warn(JSON.stringify(entry));
      };

      if (typeof userRepo.ensureTable === 'function') {
        try { await userRepo.ensureTable(env); _bsLog('ensureTable', 'ok'); } catch (e) {
          _bsLog('ensureTable', 'error', { errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 200) });
        }
      }

      let preExistingUser;
      try {
        preExistingUser = await userRepo.getById(env, userId);
        _bsLog('getById', 'ok');
      } catch (e) {
        _bsLog('getById', 'error', { errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 200) });
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
        _bsLog('bootstrap', 'ok');
      } catch (e) {
        _bsLog('bootstrap', 'error', { errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 200) });
        throw e;
      }
      let signedReferrerId = normalizeOptionalString(payload.referrer_id);
      if (auth?.startParam && typeof auth.startParam === 'string') {
        const match = auth.startParam.match(/^ref_(\d+)$/);
        if (match) signedReferrerId = match[1];
      }

      await processReferralOnBootstrap(env, userId, signedReferrerId, Boolean(userRow?.channel_joined), isNewUser);

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
        _bsLog('getSymbols', 'ok');
      } catch (e) {
        _bsLog('getSymbols', 'error', { errType: e?.constructor?.name, errMsg: String(e?.message || '').slice(0, 200) });
        throw e;
      }

      let channelJoined = false;
      if (tgUser?.id) {
        try {
          let membership = await resolveChannelMembership(env, String(tgUser?.id || userId), { forceRefresh: false });
          if (membership?.joined) {
            channelJoined = true;
          } else {
            // PHASE 2 SAFE OPTIMIZATION: Only call resolveChannelMembership(forceRefresh:true)
            // if the DB row doesn't already say channel_joined=true. If the user already
            // joined (per bootstrap() RETURNING), there's no need to re-check Telegram API
            // — the user is joined, we just have a stale KV/DB cache.
            //
            // Side effects of 2nd call that we SKIP when freshUserRow.channel_joined=true:
            //   - Telegram API fetch (unnecessary — we know user joined)
            //   - persistDbUserJoinState (unnecessary — already set)
            //   - processPendingReferralReward (already handled by processReferralOnBootstrap
            //     at line 103, OR will be caught by retryFailedReferralRewards cron)
            //
            // When freshUserRow.channel_joined=false, we MUST do the 2nd call — the user
            // may have just joined the channel and the DB hasn't been updated yet.
            if (freshUserRow?.channel_joined) {
              channelJoined = true;
            } else {
              membership = await resolveChannelMembership(env, String(tgUser?.id || userId), { forceRefresh: true });
              channelJoined = Boolean(membership?.joined);
            }
          }
        } catch (e) {
          channelJoined = Boolean(freshUserRow?.channel_joined);
        }
      } else {
        channelJoined = Boolean(freshUserRow?.channel_joined);
      }

      let isUserAdmin = isAdminTelegramId(env, userId);
      if (!isUserAdmin && isDatabaseConfigured(env) && adminRepo) {
        try {
          await adminRepo.ensureSchema(env).catch(() => {});
          const dbAdmin = await adminRepo.getAdminByTelegramId(env, userId);
          if (dbAdmin && dbAdmin.active) isUserAdmin = true;
        } catch (e) {
          console.warn('[BOOTSTRAP] Admin DB check failed:', e?.message);
        }
      }

      return jsonResponse({
        status: 'success',
        user: userRepo.normalizeRow(freshUserRow || userRow || { telegram_id: userId, lang: 'fa', channel_joined: false }, watchlist),
        watchlist, bot_username: String(env.BOT_USERNAME || ''), channel_joined: channelJoined, is_admin: isUserAdmin,
      }, {}, env);
    } catch (error) {
      console.warn(safeError('bootstrap-user', error));
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
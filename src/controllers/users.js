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
    const _t0 = Date.now();
    const _log = (name) => console.log(JSON.stringify({ scope: 'boot-trace', step: name, ms: Date.now() - _t0 }));

    _log('entry');
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
    const auth = await optionalTelegramAuth(request, env);
    let userId;
    let tgUser = null; // Telegram user object (may have username, first_name, …)

    if (auth.user) {
      userId = String(auth.user.id);
      tgUser = auth.user;
    } else {
      // Security (C-3): body.user_id fallback ONLY in development.
      // In production, only cryptographically-verified initData is accepted.
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
      _log('auth-ok');
      if (typeof userRepo.ensureTable === 'function') {
        try { await userRepo.ensureTable(env); } catch {}
      }
      _log('ensureTable');
      const preExistingUser = await userRepo.getById(env, userId);
      _log('getById-1');
      const isNewUser = !preExistingUser;

      const userRow = await userRepo.bootstrap(env, userId, {
        username: normalizeOptionalString(payload.username) || normalizeOptionalString(tgUser?.username),
        first_name: normalizeOptionalString(payload.first_name) || normalizeOptionalString(tgUser?.first_name),
        last_name: normalizeOptionalString(payload.last_name) || normalizeOptionalString(tgUser?.last_name),
        lang: normalizeOptionalString(payload.lang) || normalizeOptionalString(tgUser?.language_code),
        is_premium: Boolean(tgUser?.is_premium),
      });
      _log('bootstrap-user');
      let signedReferrerId = normalizeOptionalString(payload.referrer_id);
      if (auth.startParam && typeof auth.startParam === 'string') {
        const match = auth.startParam.match(/^ref_(\d+)$/);
        if (match) signedReferrerId = match[1];
      }

      _log('before-referral');
      await processReferralOnBootstrap(env, userId, signedReferrerId, Boolean(userRow?.channel_joined), isNewUser);
      _log('after-referral');

      const freshUserRow = await userRepo.getById(env, userId);
      _log('getById-2');
      const watchlist = await watchlistRepo.getSymbols(env, userId);
      _log('watchlist');

      let channelJoined = false;
      if (tgUser?.id) {
        try {
          let membership = await resolveChannelMembership(env, String(tgUser.id), { forceRefresh: false });
          _log('membership-cached');
          if (membership?.joined) {
            channelJoined = true;
          } else {
            membership = await resolveChannelMembership(env, String(tgUser.id), { forceRefresh: true });
            _log('membership-force');
            channelJoined = Boolean(membership?.joined);
          }
        } catch (e) {
          channelJoined = Boolean(freshUserRow?.channel_joined);
        }
      } else {
        channelJoined = Boolean(freshUserRow?.channel_joined);
      }

      let isUserAdmin = isAdminTelegramId(env, userId);
      _log('isAdmin-check');
      if (!isUserAdmin && isDatabaseConfigured(env) && adminRepo) {
        try {
          await adminRepo.ensureSchema(env).catch(() => {});
          const dbAdmin = await adminRepo.getAdminByTelegramId(env, userId);
          if (dbAdmin && dbAdmin.active) isUserAdmin = true;
        } catch (e) {
          console.warn('[BOOTSTRAP] Admin DB check failed:', e?.message);
        }
      }
      _log('admin-done');

      return jsonResponse({
        status: 'success',
        user: userRepo.normalizeRow(freshUserRow || userRow || { telegram_id: userId, lang: 'fa', channel_joined: false }, watchlist),
        watchlist, bot_username: String(env.BOT_USERNAME || ''), channel_joined: channelJoined, is_admin: isUserAdmin,
      }, {}, env);
    } catch (error) {
      _log('catch');
      console.log(JSON.stringify({ scope: 'boot-trace-ERROR', ms: Date.now() - _t0, error: error?.message }));
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
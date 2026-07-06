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
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    normalizeOptionalString,
    processReferralOnBootstrap,
    userRepo,
    watchlistRepo,
  } = deps;

  /**
   * POST /api/users/bootstrap — Create or update user profile on first launch.
   * Also processes referral and returns the watchlist.
   */
  async function handleBootstrap(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'DB_ERROR',
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
    const userId = String(authState.user.id);
    payload.user_id = userId;
    try {
      const userRow = await userRepo.bootstrap(env, userId, {
        username: normalizeOptionalString(payload.username) || normalizeOptionalString(authState.user.username),
        first_name: normalizeOptionalString(payload.first_name) || normalizeOptionalString(authState.user.first_name),
        last_name: normalizeOptionalString(payload.last_name) || normalizeOptionalString(authState.user.last_name),
        lang: normalizeOptionalString(payload.lang) || normalizeOptionalString(authState.user.language_code),
      });
      await processReferralOnBootstrap(
        env,
        userId,
        normalizeOptionalString(payload.referrer_id),
        Boolean(userRow?.channel_joined),
      );
      const freshUserRow = await userRepo.getById(env, userId);
      const watchlist = await watchlistRepo.getSymbols(env, userId);
      return jsonResponse({
        status: 'success',
        user: userRepo.normalizeRow(freshUserRow || userRow || { telegram_id: userId, lang: 'fa', channel_joined: false }, watchlist),
        watchlist,
      }, {}, env);
    } catch (error) {
      console.warn('bootstrap user failed:', error);
      return safeDbErrorResponse(error, { statusValue: 'DB_ERROR' }, env);
    }
  }

  /**
   * GET /api/users/me — Return the authenticated user's profile with watchlist.
   */
  async function handleMe(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'error',
          message: 'Database not configured',
        },
        { status: 503 }, env);
    }
    const userId = String(authState.user.id);
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
      console.warn('get current user failed:', error);
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * PUT /api/users/me/settings — Update the authenticated user's language setting.
   */
  async function handleMeSettings(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
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

    const userId = String(authState.user.id);
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
      console.warn('update user settings failed:', error);
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleBootstrap, handleMe, handleMeSettings });
}
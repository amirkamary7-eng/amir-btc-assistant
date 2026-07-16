/**
 * Watchlist Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, body parsing,
 * validation, and response building.
 *
 * Data normalization (symbol dedup, uppercase, truncation) is inline here
 * because it's tightly coupled to the HTTP request payload.
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createWatchlistHandlers(deps) {
  const {
    jsonResponse,
    optionalTelegramAuth,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    watchlistRepo,
  } = deps;

  /**
   * GET /api/watchlist — Return the authenticated user's watchlist symbols.
   */
  async function handleGet(request, env) {
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
      const symbols = await watchlistRepo.getSymbols(env, userId);
      return jsonResponse({ status: 'success', symbols, watchlist: symbols }, {}, env);
    } catch (error) {
      console.warn(safeError('get-watchlist', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * PUT /api/watchlist — Replace the authenticated user's watchlist.
   * Accepts { symbols: string[] } and stores up to 7 deduplicated, uppercase symbols.
   */
  async function handlePut(request, env) {
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

    payload.user_id = String(auth.user.id);
    const symbols = Array.isArray(payload.symbols)
      ? [...new Set(payload.symbols.map((value) => String(value).toUpperCase().trim()).filter(Boolean))].slice(0, 7)
      : [];
    try {
      const storedSymbols = await watchlistRepo.replace(env, payload.user_id, symbols);
      return jsonResponse({ status: 'success', symbols: storedSymbols }, {}, env);
    } catch (error) {
      console.warn(safeError('update-watchlist', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleGet, handlePut });
}
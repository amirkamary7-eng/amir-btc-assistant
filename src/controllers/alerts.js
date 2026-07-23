/**
 * Alert Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, body parsing,
 * validation, and response building.
 *
 * Business logic (ownership checks, data normalization) is inline here
 * because it's tightly coupled to the HTTP request context.
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createAlertHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    alertRepo,
  } = deps;

  /**
   * POST /api/alerts — Create or reactivate a price alert.
   */
  async function handleCreate(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
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

    // AUDIT-002 FIX: Validate symbol + price + direction before DB write
    const rawSymbol = typeof payload.symbol === 'string' ? payload.symbol.trim().toUpperCase() : '';
    if (!rawSymbol || rawSymbol.length > 20 || !/^[A-Z0-9]{2,20}$/.test(rawSymbol)) {
      return jsonResponse(
        { status: 'error', message: 'Invalid symbol. Must be 2-20 alphanumeric characters (A-Z, 0-9).' },
        { status: 422 }, env);
    }

    const rawPrice = Number(payload.price);
    if (!Number.isFinite(rawPrice) || rawPrice <= 0 || rawPrice > 1e12) {
      return jsonResponse(
        { status: 'error', message: 'Invalid price. Must be a positive number between 0 and 1 trillion.' },
        { status: 422 }, env);
    }

    const rawDirection = typeof payload.direction === 'string' ? payload.direction.trim().toLowerCase() : 'above';
    if (rawDirection !== 'above' && rawDirection !== 'below') {
      return jsonResponse(
        { status: 'error', message: 'Invalid direction. Must be "above" or "below".' },
        { status: 422 }, env);
    }

    payload.symbol = rawSymbol;
    payload.price = rawPrice;
    payload.direction = rawDirection;
    payload.user_id = String(authState.user.id);
    try {
      const alert = await alertRepo.create(env, payload.user_id, payload);
      return jsonResponse({ status: 'success', alert }, {}, env);
    } catch (error) {
      console.warn(safeError('create-alert', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/alerts — List active price alerts for the authenticated user.
   */
  async function handleList(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
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
      const alerts = await alertRepo.list(env, userId);
      return jsonResponse({ status: 'success', alerts }, {}, env);
    } catch (error) {
      console.warn(safeError('list-alerts', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/alerts/:id — Remove a price alert (ownership-enforced).
   */
  async function handleDelete(request, env, alertId) {
    const authState = await authenticateTelegramRequest(request, env);
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
      const alert = await alertRepo.findById(env, alertId);
      if (!alert) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      if (String(alert.user_id) !== userId) {
        return jsonResponse({ status: 'error', message: 'Forbidden' }, { status: 403 }, env);
      }
      await alertRepo.remove(env, alertId, userId);
      return jsonResponse({ status: 'success', deleted: true }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-alert', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleCreate, handleList, handleDelete });
}
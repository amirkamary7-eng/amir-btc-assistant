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
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    alertRepo,
  } = deps;

  /**
   * POST /api/alerts — Create or reactivate a price alert.
   */
  async function handleCreate(request, env) {
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

    payload.user_id = String(authState.user.id);
    try {
      const alert = await alertRepo.create(env, payload.user_id, payload);
      return jsonResponse({ status: 'success', alert }, {}, env);
    } catch (error) {
      console.warn('create alert failed:', error);
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/alerts — List active price alerts for the authenticated user.
   */
  async function handleList(request, env) {
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
      const alerts = await alertRepo.list(env, userId);
      return jsonResponse({ status: 'success', alerts }, {}, env);
    } catch (error) {
      console.warn('list alerts failed:', error);
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/alerts/:id — Remove a price alert (ownership-enforced).
   */
  async function handleDelete(request, env, alertId) {
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
      const alert = await alertRepo.findById(env, alertId);
      if (!alert) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      if (String(alert.user_id) !== userId) {
        return jsonResponse({ status: 'error', message: 'Forbidden' }, { status: 403 }, env);
      }
      await alertRepo.remove(env, alertId);
      return jsonResponse({ status: 'success', deleted: true }, {}, env);
    } catch (error) {
      console.warn('delete alert failed:', error);
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleCreate, handleList, handleDelete });
}
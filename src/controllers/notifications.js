/**
 * Notification Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, response building.
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 *
 * PHASE 3 FIX: All handlers now use _protectedUser from global middleware
 * (set at worker-proxy.js:9292) instead of calling authenticateTelegramRequest
 * again. This eliminates the redundant 2x HMAC authentication that was costing
 * 2-3ms CPU per request. Fallback auth only runs when _protectedUser is not set
 * (non-production environments where global middleware doesn't run).
 */
export function createNotificationHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    notificationRepo,
  } = deps;

  /**
   * Helper: Get authenticated user ID from request._protectedUser (set by global
   * middleware in production) or fallback to authenticateTelegramRequest (for
   * non-production where global middleware doesn't run).
   * Returns { userId, error } — if error is set, return it as the HTTP response.
   */
  async function _getUserId(request, env) {
    // PHASE 3 FIX: Use _protectedUser from global middleware — NO redundant HMAC!
    if (request._protectedUser && request._protectedUser.id) {
      return { userId: String(request._protectedUser.id), error: null };
    }
    // Fallback for non-production (global middleware doesn't run)
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) {
      return { userId: null, error: authState.error };
    }
    return { userId: String(authState.user.id), error: null };
  }

  /**
   * GET /api/notifications — List notifications for the authenticated user.
   * Query params: ?limit=N (default 50, max 100)
   */
  async function handleList(request, env) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit') || '50', 10) || 50;

    try {
      const [notifications, unread] = await Promise.all([
        notificationRepo.list(env, userId, limit),
        notificationRepo.unreadCount(env, userId),
      ]);
      return jsonResponse({
        status: 'success',
        notifications,
        unread_count: unread,
      }, {}, env);
    } catch (error) {
      console.warn(safeError('list-notifications', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/notifications/read-all — Mark all notifications as read.
   */
  async function handleMarkAllRead(request, env) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    try {
      const updated = await notificationRepo.markAllRead(env, userId);
      return jsonResponse({ status: 'success', marked_read: updated }, {}, env);
    } catch (error) {
      console.warn(safeError('mark-all-read-notifications', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/notifications/:id/read — Mark a single notification as read.
   */
  async function handleMarkRead(request, env, notificationId) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    try {
      const updated = await notificationRepo.markRead(env, notificationId, userId);
      if (!updated) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', marked_read: true }, {}, env);
    } catch (error) {
      console.warn(safeError('mark-read-notification', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/notifications/:id — Delete a single notification.
   * ROOT CAUSE FIX: previously no delete endpoint existed. Frontend only
   * cleared local state → notifications reappeared on next poll.
   */
  async function handleDelete(request, env, notificationId) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    try {
      const deleted = await notificationRepo.deleteNotification(env, notificationId, userId);
      if (!deleted) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', deleted: true }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-notification', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/notifications — Delete ALL notifications for the user.
   * ROOT CAUSE FIX: previously clearAllNotifications() in frontend only cleared
   * the local array. No API call → notifications reappeared on next poll.
   */
  async function handleDeleteAll(request, env) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    try {
      const deleted = await notificationRepo.deleteAll(env, userId);
      return jsonResponse({ status: 'success', deleted_count: deleted }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-all-notifications', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleList, handleMarkAllRead, handleMarkRead, handleDelete, handleDeleteAll });
}

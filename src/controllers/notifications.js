/**
 * Notification Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, response building.
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
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
   * GET /api/notifications — List notifications for the authenticated user.
   * Query params: ?limit=N (default 50, max 100)
   */
  async function handleList(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    const userId = String(authState.user.id);
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
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    const userId = String(authState.user.id);
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
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        { status: 'error', message: 'Database not configured' },
        { status: 503 }, env);
    }

    const userId = String(authState.user.id);
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

  return Object.freeze({ handleList, handleMarkAllRead, handleMarkRead });
}
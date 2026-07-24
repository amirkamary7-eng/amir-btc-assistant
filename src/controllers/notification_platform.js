/**
 * Notification Platform Controller — HTTP Layer
 *
 * User endpoints: list, mark read, archive, delete, settings, unread count
 * Admin endpoints: templates CRUD, broadcasts CRUD, analytics, queue status
 */

export function createNotificationPlatformHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    requireAdmin,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    buildBodyFieldValidationError,
    notificationPlatformRepo,
    sendTelegramMessage,
    adminRepo,
  } = deps;

  // ═══════════════════════════════════════════════════════════
  // USER ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  async function handleList(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const url = new URL(request.url);
      const limit = Math.min(parseInt(url.searchParams.get('limit') || '20', 10), 50);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const category = url.searchParams.get('category') || null;
      const unreadOnly = url.searchParams.get('unread') === 'true';
      const archived = url.searchParams.get('archived') === 'true';
      const result = await notificationPlatformRepo.listForUser(env, authState.user.id, { limit, offset, category, unreadOnly, archived });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUnreadCount(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const count = await notificationPlatformRepo.getUnreadCount(env, authState.user.id);
      return jsonResponse({ status: 'success', count }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleMarkRead(request, env, notificationId) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const ok = await notificationPlatformRepo.markRead(env, authState.user.id, notificationId);
      return jsonResponse({ status: ok ? 'success' : 'error' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleMarkAllRead(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const count = await notificationPlatformRepo.markAllRead(env, authState.user.id);
      return jsonResponse({ status: 'success', count }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleArchive(request, env, notificationId) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const ok = await notificationPlatformRepo.archive(env, authState.user.id, notificationId);
      return jsonResponse({ status: ok ? 'success' : 'error' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDelete(request, env, notificationId) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const ok = await notificationPlatformRepo.deleteNotification(env, authState.user.id, notificationId);
      return jsonResponse({ status: ok ? 'success' : 'error' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleGetSettings(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    try {
      const settings = await notificationPlatformRepo.getSettings(env, authState.user.id);
      return jsonResponse({ status: 'success', settings }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateSettings(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return authState.error;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const settings = await notificationPlatformRepo.updateSettings(env, authState.user.id, bodyResult.payload);
      return jsonResponse({ status: 'success', settings }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ═══════════════════════════════════════════════════════════
  // ADMIN ENDPOINTS
  // ═══════════════════════════════════════════════════════════

  async function handleAdminAnalytics(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const range = url.searchParams.get('range') || '7d';
      const analytics = await notificationPlatformRepo.getAnalytics(env, { range });
      return jsonResponse({ status: 'success', analytics }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleListTemplates(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    try {
      const templates = await notificationPlatformRepo.listTemplates(env);
      return jsonResponse({ status: 'success', templates, total: templates.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateTemplate(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const template = await notificationPlatformRepo.createTemplate(env, bodyResult.payload);
      return jsonResponse({ status: 'success', template }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleUpdateTemplate(request, env, templateId) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const template = await notificationPlatformRepo.updateTemplate(env, templateId, bodyResult.payload);
      if (!template) return jsonResponse({ status: 'error', message: 'Template not found' }, { status: 404 }, env);
      return jsonResponse({ status: 'success', template }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleDeleteTemplate(request, env, templateId) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    try {
      const ok = await notificationPlatformRepo.deleteTemplate(env, templateId);
      if (!ok) return jsonResponse({ status: 'error', message: 'Template not found' }, { status: 404 }, env);
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleListBroadcasts(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    try {
      const url = new URL(request.url);
      const limit = parseInt(url.searchParams.get('limit') || '20', 10);
      const offset = parseInt(url.searchParams.get('offset') || '0', 10);
      const result = await notificationPlatformRepo.listBroadcasts(env, { limit, offset });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleCreateBroadcast(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const payload = { ...bodyResult.payload, admin_id: admin.telegram_id };
      const broadcast = await notificationPlatformRepo.createBroadcast(env, payload);
      // If not scheduled, send immediately
      if (broadcast && !broadcast.scheduled_at) {
        const result = await notificationPlatformRepo.processBroadcast(env, broadcast.id);
        return jsonResponse({ status: 'success', broadcast, sent: result.sent }, {}, env);
      }
      return jsonResponse({ status: 'success', broadcast }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleProcessBroadcast(request, env, broadcastId) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;
    try {
      const result = await notificationPlatformRepo.processBroadcast(env, broadcastId);
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  return Object.freeze({
    handleList, handleUnreadCount, handleMarkRead, handleMarkAllRead,
    handleArchive, handleDelete, handleGetSettings, handleUpdateSettings,
    handleAdminAnalytics, handleListTemplates, handleCreateTemplate,
    handleUpdateTemplate, handleDeleteTemplate,
    handleListBroadcasts, handleCreateBroadcast, handleProcessBroadcast,
  });
}

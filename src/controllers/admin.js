/**
 * Admin Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, body parsing,
 * validation, admin authorization, Telegram notifications, and response building.
 *
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createAdminHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    optionalTelegramAuth,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    isAdminTelegramId,
    getAdminIds,
    sendTelegramMessage,
    normalizeOptionalString,
    adminRepo,
    diagLog,
  } = deps;

  // ---------------------------------------------------------------------------
  // Shared admin auth middleware
  // ---------------------------------------------------------------------------

  async function requireAdmin(request, env, requiredPermission = null) {
    // 1. Authenticate via Telegram
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) return { error: authState.error, admin: null };

    // 2. Check admin status in DATABASE (admins table)
    const admin = await adminRepo.getAdminByTelegramId(env, String(authState.user.id));
    if (!admin || !admin.active) {
      return { error: jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env), admin: null };
    }

    // 3. Determine super admin status: env var OR DB role
    const isSuper = adminRepo.isSuperAdmin(env, String(authState.user.id)) || admin.role === 'super_admin';
    if (isSuper) return { error: null, admin: { ...admin, is_super: true } };

    // 4. Check permission if required
    if (requiredPermission && admin.permissions && !admin.permissions.includes(requiredPermission) && !admin.permissions.includes('*')) {
      return { error: jsonResponse({ detail: 'Insufficient permissions' }, { status: 403 }, env), admin: null };
    }

    return { error: null, admin };
  }

  /**
   * Helper: auto-create the env-configured super admin row if the admins table is empty.
   * This allows first-time setup without manual SQL.
   */
  async function ensureSuperAdminExists(env) {
    try {
      const envAdminId = normalizeOptionalString(env.ADMIN_TELEGRAM_ID);
      if (!envAdminId) return;
      const existing = await adminRepo.getAdminByTelegramId(env, envAdminId);
      if (!existing) {
        await adminRepo.addAdmin(env, {
          telegram_id: envAdminId,
          role: 'super_admin',
          permissions: ['*'],
          created_by: envAdminId,
        });
      }
    } catch (err) {
      console.warn(safeError('ensure-super-admin', err));
    }
  }

  /**
   * Helper: parse pagination from URL search params.
   */
  function getPagination(url, defaultLimit = 20) {
    return {
      page: url.searchParams.get('page') || '1',
      limit: url.searchParams.get('limit') || String(defaultLimit),
    };
  }

  /**
   * Helper: get client IP from request.
   */
  function getClientIp(request) {
    return request.headers.get('cf-connecting-ip') || request.headers.get('x-forwarded-for') || 'unknown';
  }

  // ---------------------------------------------------------------------------
  // 1. handleIsAdmin — GET /api/admin/is-admin
  // ---------------------------------------------------------------------------

  async function handleIsAdmin(request, env) {
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ is_admin: false, reason: 'no_database', role: null, permissions: [], is_super: false }, {}, env);
    }

    const _rawInit = request.headers.get('X-Telegram-Init-Data') || '';
    const auth = await optionalTelegramAuth(request, env);
    if (!auth.user) {
      console.log('[IS-ADMIN-DIAG] auth failed — authMethod:', auth.authMethod, 'initDataLen:', _rawInit.length, 'initDataStart40:', _rawInit.substring(0, 40));
      const diag = {
        is_admin: false,
        reason: auth.authMethod === null ? 'no_init_data' : 'auth_failed',
        auth_method: auth.authMethod,
        role: null,
        permissions: [],
        is_super: false,
      };
      return jsonResponse(diag, {}, env);
    }

    console.log('[IS-ADMIN-DIAG] auth OK — userId:', auth.user.id, 'authMethod:', auth.authMethod);

    try {
      // Ensure super admin row exists for first-time setup
      await ensureSuperAdminExists(env);

      const admin = await adminRepo.getAdminByTelegramId(env, String(auth.user.id));
      console.log('[IS-ADMIN-DIAG] DB query result — admin:', admin ? JSON.stringify({ id: admin.id, telegram_id: admin.telegram_id, role: admin.role, active: admin.active, permissions: admin.permissions }) : 'null');

      const isSuperEnv = adminRepo.isSuperAdmin(env, String(auth.user.id));
      console.log('[IS-ADMIN-DIAG] isSuperEnv:', isSuperEnv, 'isSuperFinal:', isSuperEnv || (admin && admin.role === 'super_admin'));

      // Super admin: either from env var OR from DB role
      const isSuper = isSuperEnv || (admin && admin.role === 'super_admin');

      // ─── TEMPORARY BYPASS FOR 831704732 — REVERT AFTER TEST ───
      if (String(auth.user.id) === '831704732') {
        console.log('[IS-ADMIN-DIAG] BYPASS ACTIVE for 831704732 — returning forced is_admin:true');
        return jsonResponse({ is_admin: true, role: 'super_admin', is_super: true, permissions: ['*'], reason: 'bypass_test' }, {}, env);
      }
      // ─── END TEMPORARY BYPASS ───────────────────────────────────

      // If user is env super admin but not in DB yet, treat as admin
      if (!admin && isSuperEnv) {
        console.log('[IS-ADMIN-DIAG] RETURN — env_super_admin (no DB row)');
        return jsonResponse({
          is_admin: true,
          reason: 'env_super_admin',
          role: 'super_admin',
          permissions: ['*'],
          is_super: true,
        }, {}, env);
      }

      const finalResult = {
        is_admin: Boolean(admin && admin.active),
        reason: admin ? (admin.active ? 'db_admin' : 'admin_inactive') : 'not_in_admins_table',
        role: admin ? admin.role : null,
        permissions: admin ? admin.permissions : [],
        is_super: Boolean(isSuper),
      };
      console.log('[IS-ADMIN-DIAG] RETURN —', JSON.stringify(finalResult));
      return jsonResponse(finalResult, {}, env);
    } catch (error) {
      console.log('[IS-ADMIN-DIAG] DB ERROR —', error instanceof Error ? error.message : String(error));
      console.warn(safeError('is-admin-check', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 2. handleDashboard — GET /api/admin/dashboard
  // ---------------------------------------------------------------------------

  async function handleDashboard(request, env) {
    const { error: authErr } = await requireAdmin(request, env);
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      const [stats, activity] = await Promise.all([
        adminRepo.getDashboardStats(env),
        adminRepo.getRecentActivity(env, 10),
      ]);
      return jsonResponse({ status: 'success', stats, recent_activity: activity }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-dashboard', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 3. handleListAdmins — GET /api/admin/admins
  // ---------------------------------------------------------------------------

  async function handleListAdmins(request, env) {
    const { error: authErr } = await requireAdmin(request, env);
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      const admins = await adminRepo.listAdmins(env);
      return jsonResponse({ status: 'success', admins }, {}, env);
    } catch (error) {
      console.warn(safeError('list-admins', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 4. handleAddAdmin — POST /api/admin/admins
  // ---------------------------------------------------------------------------

  async function handleAddAdmin(request, env) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'manage_admins');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    const telegram_id = normalizeOptionalString(payload.telegram_id);
    if (!telegram_id) {
      return jsonResponse(
        buildBodyFieldValidationError('telegram_id', 'string_too_short', 'telegram_id is required', telegram_id, { min_length: 1 }),
        { status: 422 }, env);
    }

    const role = normalizeOptionalString(payload.role) || 'admin';
    const permissions = Array.isArray(payload.permissions) ? payload.permissions : [];

    try {
      const newAdmin = await adminRepo.addAdmin(env, {
        telegram_id,
        role,
        permissions,
        created_by: String(authedAdmin.telegram_id),
      });

      if (!newAdmin) {
        return jsonResponse({ status: 'error', message: 'Admin already exists' }, { status: 409 }, env);
      }

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'add_admin',
        target_type: 'admin',
        target_id: String(newAdmin.id),
        details: { telegram_id, role, permissions },
        ip: getClientIp(request),
      });

      return jsonResponse({ status: 'success', admin: newAdmin }, {}, env);
    } catch (error) {
      console.warn(safeError('add-admin', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 5. handleUpdateAdmin — PUT /api/admin/admins/:id
  // ---------------------------------------------------------------------------

  async function handleUpdateAdmin(request, env, adminId) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'manage_admins');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    try {
      // Fetch the target admin to check super admin status
      const allAdmins = await adminRepo.listAdmins(env);
      const targetAdmin = allAdmins.find((a) => String(a.id) === String(adminId));

      if (!targetAdmin) {
        return jsonResponse({ status: 'error', message: 'Admin not found' }, { status: 404 }, env);
      }

      // Cannot modify super admin (env var or DB role)
      const targetIsSuper = adminRepo.isSuperAdmin(env, String(targetAdmin.telegram_id)) || targetAdmin.role === 'super_admin';
      if (targetIsSuper) {
        return jsonResponse({ detail: 'Cannot modify super admin' }, { status: 403 }, env);
      }

      const updates = {};
      if (payload.role !== undefined) updates.role = payload.role;
      if (payload.permissions !== undefined) updates.permissions = payload.permissions;
      if (payload.active !== undefined) updates.active = payload.active;

      const updated = await adminRepo.updateAdmin(env, adminId, updates);

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'update_admin',
        target_type: 'admin',
        target_id: String(adminId),
        details: updates,
        ip: getClientIp(request),
      });

      return jsonResponse({ status: 'success', admin: updated }, {}, env);
    } catch (error) {
      console.warn(safeError('update-admin', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 6. handleDeleteAdmin — DELETE /api/admin/admins/:id
  // ---------------------------------------------------------------------------

  async function handleDeleteAdmin(request, env, adminId) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'manage_admins');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      // Fetch the target admin to check super admin status
      const allAdmins = await adminRepo.listAdmins(env);
      const targetAdmin = allAdmins.find((a) => String(a.id) === String(adminId));

      if (!targetAdmin) {
        return jsonResponse({ status: 'error', message: 'Admin not found' }, { status: 404 }, env);
      }

      // Cannot delete super admin (env var or DB role)
      const targetIsSuper = adminRepo.isSuperAdmin(env, String(targetAdmin.telegram_id)) || targetAdmin.role === 'super_admin';
      if (targetIsSuper) {
        return jsonResponse({ detail: 'Cannot delete super admin' }, { status: 403 }, env);
      }

      const deleted = await adminRepo.deleteAdmin(env, adminId);
      if (!deleted) {
        return jsonResponse({ status: 'error', message: 'Admin not found' }, { status: 404 }, env);
      }

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'delete_admin',
        target_type: 'admin',
        target_id: String(adminId),
        details: { deleted_telegram_id: targetAdmin.telegram_id },
        ip: getClientIp(request),
      });

      return jsonResponse({ status: 'success' }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-admin', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 7. handleListUsers — GET /api/admin/users
  // ---------------------------------------------------------------------------

  async function handleListUsers(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'view_users');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);
    const search = url.searchParams.get('search') || '';

    try {
      const result = await adminRepo.searchUsers(env, { search, page, limit });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-list-users', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 8. handleUserDetail — GET /api/admin/users/:id/stats
  // ---------------------------------------------------------------------------

  async function handleUserDetail(request, env, userId) {
    const { error: authErr } = await requireAdmin(request, env, 'view_users');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      const user = await adminRepo.getUserDetail(env, userId);
      if (!user) {
        return jsonResponse({ status: 'error', message: 'User not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', user }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-user-detail', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 9. handleListTickets — GET /api/admin/tickets
  // ---------------------------------------------------------------------------

  async function handleListTickets(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_tickets');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);
    const status = url.searchParams.get('status') || '';

    try {
      const result = await adminRepo.listTicketsAdmin(env, { status: status || undefined, page, limit });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-list-tickets', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 10. handleReplyTicket — POST /api/admin/tickets/:id/reply
  // ---------------------------------------------------------------------------

  async function handleReplyTicket(request, env, ticketId) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'manage_tickets');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    const message = normalizeOptionalString(payload.message) || '';
    if (!message) {
      return jsonResponse(
        buildBodyFieldValidationError('message', 'string_too_short', 'String should have at least 1 character', message, { min_length: 1 }),
        { status: 422 }, env);
    }

    try {
      // Get ticket info for notification
      const ticketInfo = await adminRepo.findTicketById(env, ticketId);
      if (!ticketInfo) {
        return jsonResponse({ status: 'error', message: 'Ticket not found' }, { status: 404 }, env);
      }

      // Insert reply via adminRepo
      await adminRepo.insertTicketReply(env, ticketId, String(authedAdmin.telegram_id), message);
      await adminRepo.updateTicketStatus(env, ticketId, 'answered');

      // Notify ticket owner
      try {
        const ownerId = Number(ticketInfo.user_id);
        if (Number.isFinite(ownerId)) {
          await sendTelegramMessage(env, {
            chat_id: ownerId,
            text: `💬 پاسخ تیکت: ${ticketInfo.title || ''}\n\n${message}`,
            disable_web_page_preview: true,
          });
        }
      } catch (notifyErr) {
        console.warn(safeError('admin-ticket-reply-notify', notifyErr));
      }

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'reply_ticket',
        target_type: 'ticket',
        target_id: String(ticketId),
        details: { message },
        ip: getClientIp(request),
      });

      return jsonResponse({ status: 'success', message: 'Reply sent' }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-reply-ticket', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 11. handleUpdateTicketStatus — PUT /api/admin/tickets/:id/status
  // ---------------------------------------------------------------------------

  async function handleUpdateTicketStatus(request, env, ticketId) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'manage_tickets');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    const status = normalizeOptionalString(payload.status);
    if (!status) {
      return jsonResponse(
        buildBodyFieldValidationError('status', 'string_too_short', 'status is required', status, { min_length: 1 }),
        { status: 422 }, env);
    }

    try {
      const updated = await adminRepo.updateTicketStatus(env, ticketId, status);
      if (!updated) {
        return jsonResponse({ status: 'error', message: 'Ticket not found' }, { status: 404 }, env);
      }

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'update_ticket_status',
        target_type: 'ticket',
        target_id: String(ticketId),
        details: { status },
        ip: getClientIp(request),
      });

      return jsonResponse({ status: 'success', ticket: updated }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-update-ticket-status', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 12. handleCreateBroadcast — POST /api/admin/broadcasts
  // ---------------------------------------------------------------------------

  async function handleCreateBroadcast(request, env) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    const content = normalizeOptionalString(payload.content);
    if (!content) {
      return jsonResponse(
        buildBodyFieldValidationError('content', 'string_too_short', 'content is required', content, { min_length: 1 }),
        { status: 422 }, env);
    }

    const target_type = normalizeOptionalString(payload.target_type) || 'all';
    const target_value = normalizeOptionalString(payload.target_value);
    const message_type = normalizeOptionalString(payload.message_type) || 'text';

    try {
      const broadcast = await adminRepo.createBroadcast(env, {
        sender_id: String(authedAdmin.telegram_id),
        target_type,
        target_value,
        message_type,
        content,
      });

      // Fetch target users via adminRepo
      const targetUsers = await adminRepo.getBroadcastTargetUsers(env, target_type, target_value);

      let sentCount = 0;
      let failedCount = 0;

      // Send to each user
      for (const userId of targetUsers) {
        try {
          const chatId = Number(userId);
          if (!Number.isFinite(chatId)) {
            failedCount++;
            continue;
          }
          await sendTelegramMessage(env, {
            chat_id: chatId,
            text: content,
            disable_web_page_preview: true,
          });
          sentCount++;
        } catch (sendErr) {
          failedCount++;
          console.warn(safeError('broadcast-send-fail', sendErr));
        }
      }

      // Update broadcast status
      await adminRepo.updateBroadcastStatus(env, broadcast.id, {
        status: 'completed',
        sent_count: sentCount,
        failed_count: failedCount,
      });

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'create_broadcast',
        target_type: 'broadcast',
        target_id: String(broadcast.id),
        details: { target_type, target_value, sent_count: sentCount, failed_count: failedCount },
        ip: getClientIp(request),
      });

      return jsonResponse({
        status: 'success',
        broadcast: { ...broadcast, status: 'completed', sent_count: sentCount, failed_count: failedCount },
      }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-create-broadcast', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 13. handleListBroadcasts — GET /api/admin/broadcasts
  // ---------------------------------------------------------------------------

  async function handleListBroadcasts(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'broadcast');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);

    try {
      const result = await adminRepo.listBroadcasts(env, { page, limit });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-list-broadcasts', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 14. handleListRewards — GET /api/admin/rewards
  // ---------------------------------------------------------------------------

  async function handleListRewards(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);
    const status = url.searchParams.get('status') || '';

    try {
      const result = await adminRepo.listRewards(env, { status: status || undefined, page, limit });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-list-rewards', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 15. handleUpdateReward — PUT /api/admin/rewards/:id/status
  // ---------------------------------------------------------------------------

  async function handleUpdateReward(request, env, rewardId) {
    const { error: authErr, admin: authedAdmin } = await requireAdmin(request, env, 'manage_rewards');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    let payload = bodyResult.payload;

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(
        buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
        { status: 422 }, env);
    }

    const status = normalizeOptionalString(payload.status);
    if (!status) {
      return jsonResponse(
        buildBodyFieldValidationError('status', 'string_too_short', 'status is required', status, { min_length: 1 }),
        { status: 422 }, env);
    }

    try {
      const updated = await adminRepo.updateRewardStatus(env, rewardId, status);
      if (!updated) {
        return jsonResponse({ status: 'error', message: 'Reward not found' }, { status: 404 }, env);
      }

      await adminRepo.logAdminAction(env, {
        admin_id: String(authedAdmin.telegram_id),
        action: 'update_reward_status',
        target_type: 'reward',
        target_id: String(rewardId),
        details: { status },
        ip: getClientIp(request),
      });

      return jsonResponse({ status: 'success', reward: updated }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-update-reward', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 16. handleListTransactions — GET /api/admin/transactions
  // ---------------------------------------------------------------------------

  async function handleListTransactions(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'view_transactions');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);
    const user_id = url.searchParams.get('user_id') || '';
    const tx_type = url.searchParams.get('type') || '';

    try {
      const result = await adminRepo.listTransactions(env, {
        page,
        limit,
        user_id: user_id || undefined,
        tx_type: tx_type || undefined,
      });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-list-transactions', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 17. handleListReferrals — GET /api/admin/referrals
  // ---------------------------------------------------------------------------

  async function handleListReferrals(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'view_referrals');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);
    const search = url.searchParams.get('search') || '';

    try {
      const result = await adminRepo.listReferrals(env, { search, page, limit });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-list-referrals', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 18. handleSystemHealth — GET /api/admin/system-health
  // ---------------------------------------------------------------------------

  async function handleSystemHealth(request, env) {
    const { error: authErr } = await requireAdmin(request, env);
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      const health = await adminRepo.getSystemHealth(env);
      return jsonResponse({ status: 'success', ...health }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-system-health', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ---------------------------------------------------------------------------
  // 19. handleLogs — GET /api/admin/logs
  // ---------------------------------------------------------------------------

  async function handleLogs(request, env) {
    const { error: authErr } = await requireAdmin(request, env);
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const url = new URL(request.url);
    const { page, limit } = getPagination(url);
    const action = url.searchParams.get('action') || '';

    try {
      const result = await adminRepo.getAdminLogs(env, { action: action || undefined, page, limit });
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (error) {
      console.warn(safeError('admin-logs', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({
    handleIsAdmin,
    handleDashboard,
    handleListAdmins,
    handleAddAdmin,
    handleUpdateAdmin,
    handleDeleteAdmin,
    handleListUsers,
    handleUserDetail,
    handleListTickets,
    handleReplyTicket,
    handleUpdateTicketStatus,
    handleCreateBroadcast,
    handleListBroadcasts,
    handleListRewards,
    handleUpdateReward,
    handleListTransactions,
    handleListReferrals,
    handleSystemHealth,
    handleLogs,
  });
}
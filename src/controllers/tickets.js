/**
 * Ticket Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, body parsing,
 * validation, admin authorization, Telegram notifications, and response building.
 *
 * Database operations are fully delegated to the repository.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createTicketHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    isAdminTelegramId,
    getAdminIds,
    sendTelegramMessage,
    normalizeOptionalString,
    ticketRepo,
  } = deps;

  /**
   * POST /api/tickets — Create a new support ticket.
   * Notifies all admins and the ticket owner via Telegram.
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
      const ticket = await ticketRepo.create(env, authState.user, payload);

      // Notify all admins via Telegram (Task 2.13 + 3.2)
      try {
        for (const adminStr of getAdminIds(env)) {
          const adminId = Number(adminStr);
          if (Number.isFinite(adminId)) {
            await sendTelegramMessage(env, {
              chat_id: adminId,
              text: `🎫 تیکت جدید\nاز: ${ticket.user_name || ''} (${ticket.user_id})\nعنوان: ${ticket.title}\n\n${ticket.body}`,
              disable_web_page_preview: true,
            });
          }
        }
      } catch (notifyErr) {
        console.warn(safeError('create-ticket-admin-notify', notifyErr));
      }
      try {
        const userId = Number(authState.user.id);
        if (Number.isFinite(userId)) {
          await sendTelegramMessage(env, {
            chat_id: userId,
            text: `✅ تیکت شما ثبت شد\nعنوان: ${ticket.title}\nبه زودی پاسخ داده می‌شود.`,
            disable_web_page_preview: true,
          });
        }
      } catch (notifyErr) {
        console.warn(safeError('create-ticket-user-notify', notifyErr));
      }

      return jsonResponse({ status: 'success', ticket }, {}, env);
    } catch (error) {
      console.warn(safeError('create-ticket', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/tickets — List tickets for the authenticated user.
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
      const tickets = await ticketRepo.list(env, userId);
      return jsonResponse({ status: 'success', tickets }, {}, env);
    } catch (error) {
      console.warn(safeError('list-tickets', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * GET /api/tickets/all — List all tickets (admin only).
   */
  async function handleListAll(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!isAdminTelegramId(env, authState.user.id)) {
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'error',
          message: 'Database not configured',
        },
        { status: 503 }, env);
    }
    try {
      const tickets = await ticketRepo.list(env);
      return jsonResponse({ status: 'success', tickets }, {}, env);
    } catch (error) {
      console.warn(safeError('list-all-tickets', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/tickets/:id/reply — Admin replies to a ticket.
   * Notifies the ticket owner via Telegram.
   */
  async function handleReply(request, env, ticketId) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    if (!isAdminTelegramId(env, authState.user.id)) {
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
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

    const message = normalizeOptionalString(payload.message) || '';
    if (!message) {
      return jsonResponse(
        buildBodyFieldValidationError('message', 'string_too_short', 'String should have at least 1 character', message, { min_length: 1 }),
        { status: 422 }, env);
    }
    try {
      const ticket = await ticketRepo.reply(env, ticketId, authState.user.id, message);
      if (!ticket) {
        return jsonResponse({ status: 'error', message: 'ticket not found' }, { status: 404 }, env);
      }

      // Notify ticket owner via Telegram (Task 2.14)
      try {
        const ownerId = Number(ticket.user_id);
        if (Number.isFinite(ownerId)) {
          await sendTelegramMessage(env, {
            chat_id: ownerId,
            text: `💬 پاسخ تیکت: ${ticket.title}\n\n${message}`,
            disable_web_page_preview: true,
          });
        }
      } catch (notifyErr) {
        console.warn(safeError('ticket-reply-user-notify', notifyErr));
      }

      return jsonResponse({ status: 'success', ticket }, {}, env);
    } catch (error) {
      console.warn(safeError('reply-ticket', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/tickets/:id — Delete a ticket (owner or admin).
   */
  async function handleDelete(request, env, ticketId) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }
    const userId = String(authState.user.id);
    const isAdmin = isAdminTelegramId(env, authState.user.id);
    if (!isDatabaseConfigured(env)) {
      return jsonResponse(
        {
          status: 'error',
          message: 'Database not configured',
        },
        { status: 503 }, env);
    }
    try {
      const ticket = await ticketRepo.findById(env, ticketId);
      if (!ticket) {
        return jsonResponse({ status: 'error', message: 'ticket not found' }, { status: 404 }, env);
      }
      if (!isAdmin && String(ticket.user_id) !== userId) {
        return jsonResponse({ detail: 'Forbidden' }, { status: 403 }, env);
      }
      await ticketRepo.remove(env, ticketId);
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-ticket', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleCreate, handleList, handleListAll, handleReply, handleDelete });
}
/**
 * Calendar Reminders Controllers — HTTP Layer
 *
 * Endpoints:
 *   POST   /api/calendar/reminders      — create/update a reminder
 *   GET    /api/calendar/reminders      — list user's reminders
 *   DELETE /api/calendar/reminders/:id  — delete a reminder (by event_key)
 *
 * All endpoints require Telegram auth. Reminders are per-user.
 */
export function createCalendarReminderHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeError,
    buildBodyFieldValidationError,
    isDatabaseConfigured,
    calendarReminderRepo,
  } = deps;

  /**
   * POST /api/calendar/reminders
   * Body: { event_key, event_title, event_country, event_timestamp, lead_minutes }
   * lead_minutes must be 15, 60, or 1440.
   */
  async function handleCreate(request, env) {
    const authResult = await authenticateTelegramRequest(request, env);
    if (authResult.error) return authResult.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    let payload;
    try {
      payload = JSON.parse(await request.text());
    } catch {
      return jsonResponse(buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null), { status: 422 }, env);
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return jsonResponse(buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null), { status: 422 }, env);
    }

    const eventKey = String(payload.event_key || '').slice(0, 255);
    if (!eventKey) {
      return jsonResponse(buildBodyFieldValidationError('event_key', 'string_too_short', 'event_key is required', payload.event_key), { status: 422 }, env);
    }

    const leadMinutes = Number(payload.lead_minutes);
    if (![15, 60, 1440].includes(leadMinutes)) {
      return jsonResponse(buildBodyFieldValidationError('lead_minutes', 'value_error', 'lead_minutes must be 15, 60, or 1440', payload.lead_minutes), { status: 422 }, env);
    }

    if (!payload.event_timestamp) {
      return jsonResponse(buildBodyFieldValidationError('event_timestamp', 'missing', 'event_timestamp is required', null), { status: 422 }, env);
    }

    try {
      await calendarReminderRepo.ensureSchema(env);
      const reminder = await calendarReminderRepo.upsert(env, authResult.user.id, {
        event_key: eventKey,
        event_title: String(payload.event_title || '').slice(0, 256),
        event_country: String(payload.event_country || '').slice(0, 16),
        event_timestamp: payload.event_timestamp,
        lead_minutes: leadMinutes,
      });
      return jsonResponse({ status: 'success', reminder }, {}, env);
    } catch (error) {
      console.warn(safeError('create-calendar-reminder', error));
      return jsonResponse({ status: 'error', message: error.message || 'Failed to create reminder' }, { status: 500 }, env);
    }
  }

  /**
   * GET /api/calendar/reminders — list current user's reminders.
   */
  async function handleList(request, env) {
    const authResult = await authenticateTelegramRequest(request, env);
    if (authResult.error) return authResult.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      await calendarReminderRepo.ensureSchema(env);
      const reminders = await calendarReminderRepo.listByUser(env, authResult.user.id);
      return jsonResponse({ status: 'success', reminders }, {}, env);
    } catch (error) {
      console.warn(safeError('list-calendar-reminders', error));
      return jsonResponse({ status: 'error', message: error.message || 'Failed to list reminders' }, { status: 500 }, env);
    }
  }

  /**
   * DELETE /api/calendar/reminders/:eventKey — delete by event_key.
   * We use event_key (not id) because the frontend identifies reminders
   * by event_key (title|date|country), not by numeric id.
   */
  async function handleDelete(request, env, eventKey) {
    const authResult = await authenticateTelegramRequest(request, env);
    if (authResult.error) return authResult.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      await calendarReminderRepo.ensureSchema(env);
      const deleted = await calendarReminderRepo.remove(env, authResult.user.id, decodeURIComponent(eventKey));
      if (!deleted) {
        return jsonResponse({ status: 'error', message: 'Reminder not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-calendar-reminder', error));
      return jsonResponse({ status: 'error', message: error.message || 'Failed to delete reminder' }, { status: 500 }, env);
    }
  }

  return Object.freeze({
    handleCreate,
    handleList,
    handleDelete,
  });
}

/**
 * Notify Controller — HTTP Layer
 *
 * Handles POST /api/notify: sends a Telegram message to the authenticated user
 * with per-day rate limiting (max 5 per user per day).
 *
 * No repository layer needed — no database operations.
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createNotifyHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    readJsonBody,
    normalizeOptionalString,
    buildBodyFieldValidationError,
    getTodayIsoDate,
    readRateLimitCache,
    writeRateLimitCache,
    isBotConfigured,
    sendTelegramMessage,
  } = deps;

  /**
   * POST /api/notify — Send a Telegram message to the authenticated user.
   * Rate limited to 5 sends per user per day.
   */
  async function handlePost(request, env) {
    const authState = authenticateTelegramRequest(request, env);
    if (authState.error) {
      return authState.error;
    }

    // Rate limit: max 5 notifies per user per day
    const notifyKey = `notify:${authState.user.id}:${getTodayIsoDate()}`;
    const rawNotifyCount = await readRateLimitCache(env, notifyKey);
    const notifyCount = rawNotifyCount && /^\d+$/.test(String(rawNotifyCount)) ? Number(rawNotifyCount) : 0;
    if (notifyCount >= 5) {
      return jsonResponse({ status: 'error', reason: 'rate_limited', retry_after: 86400 }, { status: 429 }, env);
    }
    await writeRateLimitCache(env, notifyKey, String(notifyCount + 1), 86400);

    const bodyResult = await readJsonBody(request, env);
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
    if (message.length > 4096) {
      return jsonResponse(
        buildBodyFieldValidationError('message', 'string_too_long', 'String should have at most 4096 characters', message, { max_length: 4096 }),
        { status: 422 }, env);
    }

    if (!isBotConfigured(env)) {
      return jsonResponse({ status: 'skipped', sent: false, reason: 'bot_not_configured' }, { status: 200 }, env);
    }

    try {
      await sendTelegramMessage(env, {
        chat_id: Number(authState.user.id),
        text: message,
        disable_web_page_preview: true,
      });
      return jsonResponse({ status: 'success', sent: true }, {}, env);
    } catch {
      return jsonResponse({ status: 'skipped', sent: false }, { status: 200 }, env);
    }
  }

  return Object.freeze({ handlePost });
}
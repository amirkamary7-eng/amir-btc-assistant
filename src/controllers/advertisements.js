/**
 * Advertisements Controller — HTTP Layer
 *
 * User endpoints (authenticated via Telegram init data):
 *   GET    /api/advertisements/required-channels   → list active required channels for /start
 *   GET    /api/advertisements/popups                → next active popup (respects 24h cooldown)
 *   POST   /api/advertisements/popups/:id/shown      → record popup impression
 *   GET    /api/advertisements/image/:id             → serve uploaded image bytes (public)
 *
 * Admin endpoints (require `ads.manage` permission):
 *   Channels:
 *     GET    /api/admin/advertisements/channels
 *     POST   /api/admin/advertisements/channels
 *     PUT    /api/admin/advertisements/channels/:id
 *     DELETE /api/admin/advertisements/channels/:id
 *     POST   /api/admin/advertisements/channels/:id/status
 *   Popups:
 *     GET    /api/admin/advertisements/popups
 *     POST   /api/admin/advertisements/popups
 *     PUT    /api/admin/advertisements/popups/:id
 *     DELETE /api/admin/advertisements/popups/:id
 *     POST   /api/admin/advertisements/popups/:id/status
 *   Messages:
 *     GET    /api/admin/advertisements/messages
 *     POST   /api/admin/advertisements/messages
 *     PUT    /api/admin/advertisements/messages/:id
 *     DELETE /api/admin/advertisements/messages/:id
 *     POST   /api/admin/advertisements/messages/:id/status
 *     POST   /api/admin/advertisements/messages/:id/send   → trigger delivery
 *   Images:
 *     POST   /api/admin/advertisements/upload-image        → store base64 image, return URL
 *
 * Delivery (Phase 6 + Phase 7):
 *   Message campaigns route through the existing notification_platform pipeline
 *   with category='promotions'. Audience (free/premium/all) is enforced at the
 *   SQL layer (JOIN membership_users). Destination (mini_app/telegram/both) is
 *   filtered per-user via ch_promotions preference (premium-gated; free users
 *   default to 'none' so they never receive promotional pushes unless they
 *   upgrade — which matches Phase 7's requirement).
 */

export function createAdvertisementsHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    requireAdmin,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    queryDb,                    // for audience-filtered user queries during delivery
    advertisementsRepo,
    notificationPlatformRepo,   // for dispatch (mini_app delivery)
    sendTelegramMessage,        // for telegram delivery
    membershipAuthority,        // for per-user premium check (fallback)
    isUserRateLimited,          // admin mutation rate limit
  } = deps;

  // ═══════════════════════════════════════════════════════════════════════
  // HELPERS
  // ═══════════════════════════════════════════════════════════════════════

  async function _getUserId(request, env) {
    if (request._protectedUser && request._protectedUser.id) {
      return { userId: String(request._protectedUser.id), error: null };
    }
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return { userId: null, error: authState.error };
    return { userId: String(authState.user.id), error: null };
  }

  async function _checkAdRateLimit(env, adminId) {
    if (!isUserRateLimited || !env.RATE_LIMITS) return null;
    if (await isUserRateLimited(env, String(adminId), 'admin-mutation', 20, 60)) {
      return jsonResponse({ status: 'error', message: 'Too many admin actions. Please wait.', code: 'RATE_LIMITED' }, { status: 429 }, env);
    }
    return null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // USER ENDPOINTS
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * GET /api/advertisements/required-channels
   * Returns the active required channels for the Mini App's join-lock screen.
   * Falls back to env.REQUIRED_CHANNEL if no DB channels configured (backward compat).
   */
  async function handleListRequiredChannels(request, env) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;
    try {
      const channels = await advertisementsRepo.listActiveRequiredChannels(env);
      return jsonResponse({ status: 'success', channels, count: channels.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /**
   * GET /api/advertisements/popups
   * Returns the highest-priority active popup that the user hasn't seen in the
   * last `cooldown_seconds` (default 24h). Per-user, independent.
   *
   * Flow (Phase 3):
   *   User opens Mini App
   *     → GET /api/advertisements/popups
   *     → backend iterates active popups (sorted by display_order)
   *     → for each: check KV `adp:${userId}:${popupId}`
   *     → first one NOT in cooldown → return it
   *     → none eligible → return { popup: null }
   */
  async function handleGetPopup(request, env) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;
    try {
      const popups = await advertisementsRepo.listActivePopups(env);
      if (!popups.length) {
        return jsonResponse({ status: 'success', popup: null }, {}, env);
      }
      // Iterate in priority order; return first eligible (not shown in cooldown).
      for (const p of popups) {
        const shown = await advertisementsRepo.hasPopupBeenShown(env, userId, p.id, p.cooldown_seconds || 86400);
        if (!shown) {
          return jsonResponse({
            status: 'success',
            popup: {
              id: p.id,
              title: p.title,
              body_text: p.body_text,
              button_label: p.button_label,
              button_url: p.button_url,
              image_url: p.image_url,
              cooldown_seconds: p.cooldown_seconds || 86400,
            },
          }, {}, env);
        }
      }
      // All popups in cooldown — suppress.
      return jsonResponse({ status: 'success', popup: null }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /**
   * POST /api/advertisements/popups/:id/shown
   * Records that the user saw this popup. Sets the KV cooldown key.
   */
  async function handleMarkPopupShown(request, env, popupId) {
    const { userId, error } = await _getUserId(request, env);
    if (error) return error;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(popupId || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid popup id' }, { status: 400 }, env);
    }
    try {
      // Verify popup exists + is active (don't record impressions for inactive popups).
      const popups = await advertisementsRepo.listActivePopups(env);
      const popup = popups.find(p => p.id === popupId);
      if (!popup) {
        return jsonResponse({ status: 'error', message: 'Popup not found or inactive' }, { status: 404 }, env);
      }
      await advertisementsRepo.markPopupShown(env, userId, popupId, popup.cooldown_seconds || 86400);
      return jsonResponse({ status: 'success' }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /**
   * GET /api/advertisements/image/:id
   * Serves an uploaded image from KV. Public (no auth) so <img src> can load it.
   * Returns 404 for invalid IDs or missing images.
   */
  async function handleServeImage(request, env, imageId) {
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(imageId || ''))) {
      return new Response('Not Found', { status: 404 });
    }
    try {
      const img = await advertisementsRepo.getImage(env, imageId);
      if (!img) return new Response('Not Found', { status: 404 });
      // Decode base64 → bytes
      let bytes;
      try { bytes = atob(img.base64); } catch { return new Response('Not Found', { status: 404 }); }
      const buf = new Uint8Array(bytes.length);
      for (let i = 0; i < bytes.length; i++) buf[i] = bytes.charCodeAt(i);
      return new Response(buf, {
        status: 200,
        headers: {
          'Content-Type': img.contentType,
          'Cache-Control': 'public, max-age=86400, immutable',
          'X-Content-Type-Options': 'nosniff',
          'Access-Control-Allow-Origin': String(env.WEBAPP_URL || '*'),
        },
      });
    } catch (e) {
      return new Response('Not Found', { status: 404 });
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — CHANNEL JOIN (Phase 2)
  // ═══════════════════════════════════════════════════════════════════════

  async function handleAdminListChannels(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    try {
      const channels = await advertisementsRepo.listAllChannelsForAdmin(env);
      return jsonResponse({ status: 'success', channels, count: channels.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleAdminCreateChannel(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const channel = await advertisementsRepo.createChannel(env, bodyResult.payload || {});
      return jsonResponse({ status: 'success', channel }, {}, env);
    } catch (e) {
      return jsonResponse({ status: 'error', message: e.message || 'Create failed', code: 'VALIDATION_ERROR' }, { status: 422 }, env);
    }
  }

  async function handleAdminUpdateChannel(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    const bodyResult = await readJsonBody(request, 102400, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const channel = await advertisementsRepo.updateChannel(env, id, bodyResult.payload || {});
      return jsonResponse({ status: 'success', channel }, {}, env);
    } catch (e) {
      const status = e.message.includes('not found') ? 404 : 422;
      return jsonResponse({ status: 'error', message: e.message || 'Update failed', code: 'VALIDATION_ERROR' }, { status }, env);
    }
  }

  async function handleAdminDeleteChannel(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    try {
      const ok = await advertisementsRepo.deleteChannel(env, id);
      return jsonResponse({ status: ok ? 'success' : 'error' }, ok ? {} : { status: 404 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleAdminChannelStatus(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    const bodyResult = await readJsonBody(request, 10240, env);
    if (bodyResult.error) return bodyResult.error;
    const status = String(bodyResult.payload?.status || '').toLowerCase();
    try {
      const channel = await advertisementsRepo.setChannelStatus(env, id, status);
      return jsonResponse({ status: 'success', channel }, {}, env);
    } catch (e) {
      const code = e.message.includes('Invalid status') ? 422 : 404;
      return jsonResponse({ status: 'error', message: e.message || 'Status update failed' }, { status: code }, env);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — POPUP (Phase 3 + Phase 4)
  // ═══════════════════════════════════════════════════════════════════════

  async function handleAdminListPopups(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    try {
      const popups = await advertisementsRepo.listAllPopupsForAdmin(env);
      return jsonResponse({ status: 'success', popups, count: popups.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleAdminCreatePopup(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    const bodyResult = await readJsonBody(request, 204800, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const popup = await advertisementsRepo.createPopup(env, bodyResult.payload || {});
      return jsonResponse({ status: 'success', popup }, {}, env);
    } catch (e) {
      return jsonResponse({ status: 'error', message: e.message || 'Create failed', code: 'VALIDATION_ERROR' }, { status: 422 }, env);
    }
  }

  async function handleAdminUpdatePopup(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    const bodyResult = await readJsonBody(request, 204800, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const popup = await advertisementsRepo.updatePopup(env, id, bodyResult.payload || {});
      return jsonResponse({ status: 'success', popup }, {}, env);
    } catch (e) {
      const status = e.message.includes('not found') ? 404 : 422;
      return jsonResponse({ status: 'error', message: e.message || 'Update failed', code: 'VALIDATION_ERROR' }, { status }, env);
    }
  }

  async function handleAdminDeletePopup(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    try {
      const ok = await advertisementsRepo.deletePopup(env, id);
      return jsonResponse({ status: ok ? 'success' : 'error' }, ok ? {} : { status: 404 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleAdminPopupStatus(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    const bodyResult = await readJsonBody(request, 10240, env);
    if (bodyResult.error) return bodyResult.error;
    const status = String(bodyResult.payload?.status || '').toLowerCase();
    try {
      const popup = await advertisementsRepo.setPopupStatus(env, id, status);
      return jsonResponse({ status: 'success', popup }, {}, env);
    } catch (e) {
      const code = e.message.includes('Invalid status') ? 422 : 404;
      return jsonResponse({ status: 'error', message: e.message || 'Status update failed' }, { status: code }, env);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — MESSAGE (Phase 6)
  // ═══════════════════════════════════════════════════════════════════════

  async function handleAdminListMessages(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    try {
      const messages = await advertisementsRepo.listAllMessagesForAdmin(env);
      return jsonResponse({ status: 'success', messages, count: messages.length }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleAdminCreateMessage(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    const bodyResult = await readJsonBody(request, 204800, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const message = await advertisementsRepo.createMessage(env, bodyResult.payload || {});
      return jsonResponse({ status: 'success', message }, {}, env);
    } catch (e) {
      return jsonResponse({ status: 'error', message: e.message || 'Create failed', code: 'VALIDATION_ERROR' }, { status: 422 }, env);
    }
  }

  async function handleAdminUpdateMessage(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    const bodyResult = await readJsonBody(request, 204800, env);
    if (bodyResult.error) return bodyResult.error;
    try {
      const message = await advertisementsRepo.updateMessage(env, id, bodyResult.payload || {});
      return jsonResponse({ status: 'success', message }, {}, env);
    } catch (e) {
      const status = e.message.includes('not found') ? 404 : 422;
      return jsonResponse({ status: 'error', message: e.message || 'Update failed', code: 'VALIDATION_ERROR' }, { status }, env);
    }
  }

  async function handleAdminDeleteMessage(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    try {
      const ok = await advertisementsRepo.deleteMessage(env, id);
      return jsonResponse({ status: ok ? 'success' : 'error' }, ok ? {} : { status: 404 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleAdminMessageStatus(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    const bodyResult = await readJsonBody(request, 10240, env);
    if (bodyResult.error) return bodyResult.error;
    const status = String(bodyResult.payload?.status || '').toLowerCase();
    try {
      const message = await advertisementsRepo.setMessageStatus(env, id, status);
      return jsonResponse({ status: 'success', message }, {}, env);
    } catch (e) {
      const code = e.message.includes('Invalid status') ? 422 : 404;
      return jsonResponse({ status: 'error', message: e.message || 'Status update failed' }, { status: code }, env);
    }
  }

  /**
   * POST /api/admin/advertisements/messages/:id/send
   * Triggers delivery of an active message campaign.
   *
   * Flow (Phase 6 + Phase 7):
   *   1. Verify message exists + campaign status='active' + is_active=true
   *   2. Build user query with audience filter (free/premium/all) via JOIN membership_users
   *   3. For each batch of users:
   *      a. Bulk-fetch ch_promotions preference
   *      b. For each user:
   *         - audience=free → skip if premium
   *         - audience=premium → skip if not premium
   *         - pref='none' → skip (premium user opted out)
   *         - pref='mini_app' or 'both' → dispatch notification (category='promotions')
   *         - pref='telegram' or 'both' → sendTelegramMessage
   *   4. Update ad_messages.broadcast_id + last_processed_at
   *
   * NOTE: This reuses notificationPlatformRepo.dispatch for mini_app delivery
   * (which inserts into notifications + notification_queue). For telegram,
   * we call sendTelegramMessage directly (the queue is the backup, not primary).
   */
  async function handleAdminSendMessage(request, env, id) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) {
      return jsonResponse({ status: 'error', message: 'Invalid id' }, { status: 400 }, env);
    }
    try {
      const message = await advertisementsRepo.getMessage(env, id);
      if (!message) {
        return jsonResponse({ status: 'error', message: 'Message not found' }, { status: 404 }, env);
      }
      // Only active campaigns deliver. draft/paused/archived are silently skipped.
      if (message.campaign_status !== 'active' || !message.is_active) {
        return jsonResponse({
          status: 'error',
          message: `Campaign is ${message.campaign_status} (not active). Activate it first.`,
          code: 'CAMPAIGN_NOT_ACTIVE',
        }, { status: 422 }, env);
      }

      // FIX (audit H1): Atomic CAS claim to prevent concurrent double-delivery.
      // Two concurrent POST /send requests would both pass the above check and
      // both deliver to all users. claimMessageForDelivery atomically sets
      // last_processed_at = NOW() and only succeeds if the message hasn't been
      // processed in the last 5 minutes. This prevents double-clicks AND
      // prevents re-delivery within 5 min (admin must wait to re-send).
      const claimed = await advertisementsRepo.claimMessageForDelivery(env, id, 5);
      if (!claimed) {
        return jsonResponse({
          status: 'error',
          message: 'This campaign was sent recently. Please wait 5 minutes before sending again.',
          code: 'CAMPAIGN_RECENTLY_SENT',
          retry_after_seconds: 300,
        }, { status: 409 }, env);
      }

      let result;
      try {
        result = await _deliverMessageCampaign(env, message);
      } catch (deliveryErr) {
        // Release the claim on failure so admin can retry sooner than 5 min.
        await advertisementsRepo.releaseMessageClaim(env, id);
        throw deliveryErr;
      }
      return jsonResponse({ status: 'success', ...result }, {}, env);
    } catch (e) {
      console.error('[advertisements] deliver failed:', e);
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MESSAGE DELIVERY (Phase 6 + Phase 7)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * Delivers a message campaign to its target audience via the chosen destinations.
   * Reuses the existing notification_platform pipeline for mini_app delivery and
   * sendTelegramMessage for telegram delivery. Per-user ch_promotions preference
   * is enforced (premium-gated; free users default to 'none').
   */
  async function _deliverMessageCampaign(env, message) {
    if (!isDatabaseConfigured(env)) {
      return { delivered: 0, skipped: 0, reason: 'db_not_configured' };
    }

    const BATCH_SIZE = 25;
    let delivered = 0;
    let skipped = 0;
    let checkpoint = null;
    const audience = message.target_audience || 'all';
    const destinations = message.destinations || 'both';

    // Audience filter SQL fragment (Phase 6: free/premium/all).
    // Premium = membership_level IN (VIP,PREMIUM,ELITE) AND status=APPROVED AND not expired.
    // Free = everyone else (including users with no membership row — LEFT JOIN).
    let audienceClause = '';
    if (audience === 'premium') {
      audienceClause = `AND mu.membership_level IN ('VIP','PREMIUM','ELITE')
                        AND mu.membership_status = 'APPROVED'
                        AND (mu.expire_at IS NULL OR mu.expire_at > NOW())`;
    } else if (audience === 'free') {
      audienceClause = `AND (
        mu.membership_level IS NULL
        OR mu.membership_level = 'FREE'
        OR mu.membership_status IS NULL
        OR mu.membership_status != 'APPROVED'
        OR (mu.expire_at IS NOT NULL AND mu.expire_at <= NOW())
      )`;
    }
    // 'all' → no filter

    while (true) {
      const params = checkpoint ? [BATCH_SIZE, checkpoint] : [BATCH_SIZE];
      const userResult = await queryDb(env, `
        SELECT u.telegram_id
        FROM users u
        LEFT JOIN membership_users mu ON mu.telegram_id = u.telegram_id
        WHERE u.channel_joined = TRUE
        ${audienceClause}
        ${checkpoint ? "AND u.telegram_id > $2" : ""}
        ORDER BY u.telegram_id ASC
        LIMIT $1
      `, params);

      if (!userResult.rows || userResult.rows.length === 0) break;
      const userIds = userResult.rows.map(r => String(r.telegram_id));

      // Bulk-fetch ch_promotions preference for this batch.
      const prefMap = new Map();
      if (userIds.length > 0) {
        const placeholders = userIds.map((_, i) => `$${i + 1}`).join(',');
        const prefResult = await queryDb(env,
          `SELECT user_id, ch_promotions AS pref FROM notification_settings WHERE user_id IN (${placeholders})`,
          userIds
        ).catch(() => ({ rows: [] }));
        for (const row of prefResult.rows || []) {
          prefMap.set(String(row.user_id), String(row.pref));
        }
      }

      for (const uid of userIds) {
        const pref = prefMap.get(uid) || 'none'; // free users default 'none' → skipped
        if (pref === 'none') { skipped++; continue; }

        const deliverMiniApp = (destinations === 'mini_app' || destinations === 'both') &&
                               (pref === 'mini_app' || pref === 'both');
        const deliverTelegram = (destinations === 'telegram' || destinations === 'both') &&
                                (pref === 'telegram' || pref === 'both');

        if (!deliverMiniApp && !deliverTelegram) { skipped++; continue; }

        // Build message text
        const textParts = [message.body_text];
        if (message.button_label && message.button_url) {
          textParts.push(`\n\n${message.button_label}: ${message.button_url}`);
        }
        const fullText = textParts.join('');

        if (deliverMiniApp && notificationPlatformRepo?.dispatch) {
          try {
            await notificationPlatformRepo.dispatch(env, {
              userId: uid,
              category: 'promotions',
              type: 'advertisement',
              title: message.title,
              message: fullText,
              metadata: { campaign_id: message.campaign_id, ad_message_id: message.id },
            });
            delivered++;
          } catch (e) {
            console.warn('[advertisements] mini_app dispatch failed for', uid, e.message);
            skipped++;
          }
        }

        if (deliverTelegram && sendTelegramMessage) {
          try {
            await sendTelegramMessage(env, {
              chat_id: uid,
              text: fullText,
              parse_mode: 'HTML',
            });
            // Avoid double-counting if both channels delivered
            if (!deliverMiniApp) delivered++;
          } catch (e) {
            console.warn('[advertisements] telegram send failed for', uid, e.message);
            skipped++;
          }
        }
      }

      checkpoint = userIds[userIds.length - 1];
      // Safety cap: 1000 users per send invocation (Workers CPU limit).
      // FIX (audit H2): Was 5000 — at ~50ms per user (DB query + dispatch + TG send),
      // 5000 users = 250s wall-clock, FAR exceeding Workers Paid plan 30s CPU limit.
      // 1000 users = ~50s wall-clock — still risky but survivable with ctx.waitUntil.
      // For larger audiences, admin should split into multiple sends (different
      // audience filters) or use the notification_queue cron for async delivery.
      if (delivered + skipped >= 1000) break;
    }

    // Record delivery metadata.
    try {
      await queryDb(env,
        `UPDATE ad_messages SET last_processed_at = NOW(), updated_at = NOW() WHERE id = $1`,
        [message.id]
      );
    } catch { /* non-fatal */ }

    return { delivered, skipped, audience, destinations };
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ADMIN — IMAGE UPLOAD (Phase 5)
  // ═══════════════════════════════════════════════════════════════════════

  async function handleAdminUploadImage(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'ads.manage');
    if (authErr) return authErr;
    const rl = await _checkAdRateLimit(env, admin?.telegram_id || 'unknown');
    if (rl) return rl;
    // Allow up to 1MB for the JSON body (base64 of a 500KB image ≈ 670KB + overhead).
    const bodyResult = await readJsonBody(request, 1024 * 1024, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload || {};
    const dataUri = payload.data_uri || payload.image || '';
    const contentType = payload.content_type || '';
    if (!dataUri) {
      return jsonResponse({ status: 'error', message: 'data_uri is required', code: 'VALIDATION_ERROR' }, { status: 422 }, env);
    }
    try {
      const url = await advertisementsRepo.storeImage(env, dataUri, contentType);
      return jsonResponse({ status: 'success', url }, {}, env);
    } catch (e) {
      return jsonResponse({ status: 'error', message: e.message || 'Upload failed', code: 'VALIDATION_ERROR' }, { status: 422 }, env);
    }
  }

  return {
    // User
    handleListRequiredChannels,
    handleGetPopup,
    handleMarkPopupShown,
    handleServeImage,
    // Admin — Channels
    handleAdminListChannels,
    handleAdminCreateChannel,
    handleAdminUpdateChannel,
    handleAdminDeleteChannel,
    handleAdminChannelStatus,
    // Admin — Popups
    handleAdminListPopups,
    handleAdminCreatePopup,
    handleAdminUpdatePopup,
    handleAdminDeletePopup,
    handleAdminPopupStatus,
    // Admin — Messages
    handleAdminListMessages,
    handleAdminCreateMessage,
    handleAdminUpdateMessage,
    handleAdminDeleteMessage,
    handleAdminMessageStatus,
    handleAdminSendMessage,
    // Admin — Image
    handleAdminUploadImage,
  };
}

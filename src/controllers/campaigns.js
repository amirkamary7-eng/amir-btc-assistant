/**
 * Campaigns Controller — User API (Exchange Campaigns, Stage 5B)
 * ==============================================================
 *
 * Routes (wired in worker-proxy.js):
 *   GET  /api/campaigns            → handleList
 *   GET  /api/campaigns/:id        → handleGetDetail
 *   POST /api/campaigns/:id/register → handleRegister (one-tap, NO body)
 *
 * Auth: authenticateTelegramRequest (signed Telegram initData). The
 * telegram_id used for every query comes ONLY from the validated initData
 * user object — client-supplied user ids are never trusted. The router-level
 * PROTECTED_PATHS gate additionally enforces auth + channel membership in
 * non-dev environments; each handler still authenticates on its own
 * (defense-in-depth, wallet.js pattern).
 *
 * Status model:
 *   Stored status: DRAFT | PUBLISHED | STOPPED | DELETED (admin-managed,
 *   Stage 6). DRAFT/DELETED are invisible to users (404).
 *   Effective status (computed server-side, UTC): STOPPED > UPCOMING > ENDED
 *   > ACTIVE — intentionally the SAME formula the Stage 4 frontend uses
 *   (campaigns.js effectiveStatus) so client and server can never disagree.
 *
 * Error mapping:
 *   400 INVALID_CAMPAIGN_ID        — malformed id segment
 *   401 (from authenticateTelegramRequest)
 *   403 CHANNEL_JOIN_REQUIRED      — router-level gate (requireChannelJoin)
 *   404 CAMPAIGN_NOT_FOUND         — nonexistent / DRAFT / DELETED
 *   409 CAMPAIGN_NOT_STARTED       — PUBLISHED but starts_at in the future
 *   409 CAMPAIGN_ENDED              — PUBLISHED and window has passed
 *   409 CAMPAIGN_STOPPED           — STOPPED
 *   409 CAMPAIGN_STATE_CHANGED     — publish-race anomaly (retryable)
 *   429 RATE_LIMITED               — too many register attempts
 *   503 (safeDbErrorResponse)      — DB unavailable
 *
 * Success is reported ONLY after the database confirms it: handleRegister
 * returns registered:true exclusively from a RETURNING row (new insert) or a
 * pre-existing registration row — never from an optimistic assumption.
 */

export function createCampaignsHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    campaignsRepo,
    isUserRateLimited,
    ensureUserRow,
  } = deps;

  // Campaign ids are uuid::text (gen_random_uuid) — safe charset only.
  const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  // Register endpoint rate limit: generous for legitimate one-per-campaign
  // use, tight enough to stop hammering (tickets use 5/hour for creation).
  const REGISTER_RATE_MAX = 10;
  const REGISTER_RATE_WINDOW_SECONDS = 60;

  // ── Effective status (mirrors campaigns.js frontend formula) ──────────────

  function _effectiveStatus(status, startsAtIso, endsAtIso, nowMs) {
    if (status === 'STOPPED' || status === 'DELETED') return 'STOPPED';
    const start = startsAtIso ? Date.parse(startsAtIso) : null;
    const end = endsAtIso ? Date.parse(endsAtIso) : null;
    if (start !== null && !Number.isNaN(start) && nowMs < start) return 'UPCOMING';
    if (end !== null && !Number.isNaN(end) && nowMs > end) return 'ENDED';
    return 'ACTIVE';
  }

  /** DB row → public API shape (adds server-computed effective_status). */
  function _toPublic(campaign, nowMs = Date.now()) {
    return {
      id: campaign.id,
      title_fa: campaign.title_fa,
      title_en: campaign.title_en,
      summary_fa: campaign.summary_fa,
      summary_en: campaign.summary_en,
      body_fa: campaign.body_fa,
      body_en: campaign.body_en,
      image_url: campaign.image_url,
      // Optional admin-specified external registration destination. The
      // client re-validates the scheme before navigating (defense in depth);
      // null = in-app one-tap registration (unchanged legacy behavior).
      registration_url: campaign.registration_url || null,
      starts_at: campaign.starts_at,
      ends_at: campaign.ends_at,
      status: campaign.status,
      effective_status: _effectiveStatus(campaign.status, campaign.starts_at, campaign.ends_at, nowMs),
      registered: Boolean(campaign.registered),
    };
  }

  function _errorResponse(status, code, message, env) {
    return jsonResponse({ status: 'error', code, message }, { status }, env);
  }

  /** 400 for malformed ids. */
  function _invalidId(env) {
    return _errorResponse(400, 'INVALID_CAMPAIGN_ID', 'Invalid campaign id', env);
  }

  /** Shared pre-handler: auth (401 on failure). */
  async function _authenticate(request, env) {
    const authState = await authenticateTelegramRequest(request, env);
    if (authState.error) return { error: authState.error, user: null };
    return { error: null, user: authState.user };
  }

  // ── GET /api/campaigns ────────────────────────────────────────────────────

  async function handleList(request, env) {
    const { error, user } = await _authenticate(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return safeDbErrorResponse(null, {}, env);
    }

    try {
      await campaignsRepo.ensureSchema(env).catch(() => { /* dev DDL failure surfaces via the query below */ });
      const campaigns = await campaignsRepo.listVisibleCampaigns(env, user.id);
      return jsonResponse(
        { status: 'ok', count: campaigns.length, campaigns: campaigns.map((c) => _toPublic(c)) },
        {},
        env,
      );
    } catch (e) {
      console.warn(safeError('campaigns-list', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/campaigns/:id ────────────────────────────────────────────────

  async function handleGetDetail(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error, user } = await _authenticate(request, env);
    if (error) return error;

    if (!isDatabaseConfigured(env)) {
      return safeDbErrorResponse(null, {}, env);
    }

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});
      const campaign = await campaignsRepo.getVisibleCampaignById(env, campaignId, user.id);
      if (!campaign) {
        // Nonexistent, DRAFT and DELETED are indistinguishable on purpose.
        return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      }
      return jsonResponse({ status: 'ok', campaign: _toPublic(campaign) }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-detail', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── POST /api/campaigns/:id/register (one-tap, no body) ───────────────────

  async function handleRegister(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error, user } = await _authenticate(request, env);
    if (error) return error;
    const telegramId = String(user.id);

    // Rate limit BEFORE any DB write (spam should not even reach ensureUserRow).
    if (await isUserRateLimited(env, telegramId, 'campaign_register', REGISTER_RATE_MAX, REGISTER_RATE_WINDOW_SECONDS)) {
      return _errorResponse(429, 'RATE_LIMITED', 'Too many requests', env);
    }

    if (!isDatabaseConfigured(env)) {
      return safeDbErrorResponse(null, {}, env);
    }

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      // FK safety: users row must exist (ON CONFLICT no-op when it does).
      // Same pattern as tickets creation.
      await ensureUserRow(env, telegramId);

      const attempt = await campaignsRepo.registerUser(env, campaignId, telegramId);
      if (attempt.inserted) {
        // Database confirmed the insert — safe to announce success.
        return jsonResponse(
          {
            status: 'ok',
            registered: true,
            already_registered: false,
            campaign_id: String(campaignId),
            registered_at: attempt.row ? attempt.row.registered_at : null,
          },
          {},
          env,
        );
      }

      // Nothing inserted → either already registered or campaign not
      // registerable. Disambiguate (registration first — the happy path).
      const existing = await campaignsRepo.isRegistered(env, campaignId, telegramId);
      if (existing) {
        return jsonResponse(
          {
            status: 'ok',
            registered: true,
            already_registered: true,
            campaign_id: String(campaignId),
            registered_at: existing.registered_at,
          },
          {},
          env,
        );
      }

      // Not registered, nothing inserted → campaign-side gate.
      const gate = await campaignsRepo.getCampaignForGate(env, campaignId);
      if (!gate || gate.status === 'DRAFT' || gate.status === 'DELETED') {
        return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      }
      if (gate.status === 'STOPPED') {
        return _errorResponse(409, 'CAMPAIGN_STOPPED', 'Registration for this campaign is closed', env);
      }

      // PUBLISHED — decide by window (UTC, server clock).
      const nowMs = Date.now();
      const effective = _effectiveStatus(gate.status, gate.starts_at, gate.ends_at, nowMs);
      if (effective === 'UPCOMING') {
        return _errorResponse(409, 'CAMPAIGN_NOT_STARTED', 'Registration has not started yet', env);
      }
      if (effective === 'ENDED') {
        return _errorResponse(409, 'CAMPAIGN_ENDED', 'This campaign has ended', env);
      }

      // PUBLISHED + ACTIVE + no row + no insert: the only way here is a
      // snapshot race (campaign was not registerable at the INSERT snapshot
      // but is now — e.g. it was JUST published). Retry the atomic insert
      // ONCE on a fresh snapshot before giving up.
      const retry = await campaignsRepo.registerUser(env, campaignId, telegramId);
      if (retry.inserted) {
        return jsonResponse(
          {
            status: 'ok',
            registered: true,
            already_registered: false,
            campaign_id: String(campaignId),
            registered_at: retry.row ? retry.row.registered_at : null,
          },
          {},
          env,
        );
      }
      const existingAfterRetry = await campaignsRepo.isRegistered(env, campaignId, telegramId);
      if (existingAfterRetry) {
        return jsonResponse(
          {
            status: 'ok',
            registered: true,
            already_registered: true,
            campaign_id: String(campaignId),
            registered_at: existingAfterRetry.registered_at,
          },
          {},
          env,
        );
      }

      // Still nothing on a fresh snapshot → the campaign state genuinely
      // changed under us (e.g. STOPPED between the two reads). Retryable.
      return _errorResponse(409, 'CAMPAIGN_STATE_CHANGED', 'Campaign state changed, please retry', env);
    } catch (e) {
      console.warn(safeError('campaigns-register', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  return {
    handleList,
    handleGetDetail,
    handleRegister,
  };
}

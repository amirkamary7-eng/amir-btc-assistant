/**
 * Campaigns Admin Controller — HTTP Layer (Exchange Campaigns, Stage 6B)
 * =====================================================================
 *
 * Admin panel backend for the promo campaign tables owned by
 * src/repositories/campaigns.js (promo_campaigns / promo_campaign_registrations).
 * Distinct from reward_center's `campaigns` config CRUD.
 *
 * Routes (wired in worker-proxy.js):
 *   GET    /api/admin/campaigns                        → handleAdminListCampaigns
 *   POST   /api/admin/campaigns                        → handleAdminCreateCampaign
 *   GET    /api/admin/campaigns/:id                    → handleAdminGetCampaign
 *   PUT    /api/admin/campaigns/:id                     → handleAdminUpdateCampaign (PATCH alias)
 *   PUT    /api/admin/campaigns/:id/status             → handleAdminSetCampaignStatus (POST alias)
 *   DELETE /api/admin/campaigns/:id                     → handleAdminDeleteCampaign (SOFT)
 *   GET    /api/admin/campaigns/:id/registrations       → handleAdminListRegistrations
 *   GET    /api/admin/campaigns/:id/registrations/export → handleAdminExportRegistrations (CSV)
 *
 * Permissions (requireAdmin granular keys — plain JSONB strings, no
 * LEGACY_PERM_MAP entry needed; '*' super admins pass everything):
 *   - Reads  (list/detail/registrations/export): 'campaigns.view'
 *   - Writes (create/update/status/delete):       'campaigns.manage'
 *
 * Status model:
 *   DRAFT → PUBLISHED → STOPPED → PUBLISHED (resume) — plus SOFT delete
 *   (any non-DELETED → DELETED). DELETED is TERMINAL everywhere: enforced
 *   in SQL by `status <> 'DELETED'` guards (see repository), and rejected
 *   here with 409 before any mutation reaches a deleted row's content.
 *
 * Mutations are rate-limited ('admin-mutation' 20/60s, reward_center
 * pattern) and audited into admin_logs via adminRepo.logAdminAction
 * (actions: campaigns_admin.create / .update / .status / .delete).
 *
 * Server-side validation (defense against a compromised admin client):
 *   title_fa/en required ≤200, summary_fa/en ≤500, body_fa/en ≤5000,
 *   image_url must pass the advertisements.js validator (HTTPS-only,
 *   SSRF-safe — closes 5C-L4), starts_at required ISO 8601 WITH timezone,
 *   ends_at optional ISO 8601 and strictly after starts_at, status only
 *   via the dedicated endpoint with a whitelisted target.
 *
 * CSV export (membership.js pattern + hardening): BOM + quoted/escaped
 * cells (quote/comma/CR/LF all force quoting), formula-injection
 * neutralized (leading =, +, -, @, tab, CR get a single quote prefix),
 * attachment + no-store + nosniff security headers.
 */

export function createCampaignsAdminHandlers(deps) {
  const {
    jsonResponse,
    requireAdmin,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    isUserRateLimited,
    campaignsRepo,
    adminRepo,
    advertisementsRepo,
    withCors,
    isValidImageUrl,
  } = deps;

  // Campaign ids are uuid::text — same safe charset as the user API.
  const CAMPAIGN_ID_RE = /^[A-Za-z0-9_-]{1,64}$/;

  const MAX_TITLE = 200;
  const MAX_SUMMARY = 500;
  const MAX_BODY = 5000;
  const MAX_SEARCH = 100;
  const MAX_REGISTRATION_URL = 2048;

  // Strict ISO 8601 with mandatory timezone (Z or ±HH:MM) — Date.parse alone
  // would also accept ambiguous locale formats like 02/01/2026.
  const ISO_8601_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,3})?(?:Z|[+-]\d{2}:\d{2})$/;

  const STATUSES = new Set(['DRAFT', 'PUBLISHED', 'STOPPED', 'DELETED']);
  // Create may go straight to PUBLISHED (direct publish) — never STOPPED/DELETED.
  const CREATE_STATUSES = new Set(['DRAFT', 'PUBLISHED']);
  // The /status endpoint only performs publish / stop / resume.
  const STATUS_TARGETS = new Set(['PUBLISHED', 'STOPPED']);

  // registration_url — optional EXTERNAL link the user-side register button
  // opens instead of the in-app one-tap POST. Security mirror of the shared
  // advertisements.js button-URL policy (sanitizeUrl):
  //   • http(s) ONLY — the URL() protocol check structurally rejects
  //     javascript:, data:, vbscript:, file:, and every other scheme;
  //   • no embedded credentials (user:pass@host);
  //   • no localhost / IPv4-literal hosts (SSRF-style targets);
  //   • length-bounded.
  // The Mini App client re-validates before navigating (defense in depth).
  function _isValidRegistrationUrl(raw) {
    if (typeof raw !== 'string') return false;
    const s = raw.trim();
    if (!s || s.length > MAX_REGISTRATION_URL) return false;
    let u;
    try {
      u = new URL(s);
    } catch {
      return false;
    }
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return false;
    if (u.username || u.password) return false;
    const host = u.hostname.toLowerCase();
    if (!host) return false;
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
    if (host.startsWith('[') && host.endsWith(']')) return false; // IPv6 literal
    return true;
  }

  // Lifecycle: DRAFT→PUBLISHED→STOPPED→PUBLISHED; delete from any live state.
  // DELETED is terminal (also enforced atomically in the repository SQL).
  const ALLOWED_TRANSITIONS = {
    DRAFT: ['PUBLISHED', 'DELETED'],
    PUBLISHED: ['STOPPED', 'DELETED'],
    STOPPED: ['PUBLISHED', 'DELETED'],
    DELETED: [],
  };

  // ── Shared helpers ────────────────────────────────────────────────────────

  function _errorResponse(status, code, message, env) {
    return jsonResponse({ status: 'error', code, message }, { status }, env);
  }

  function _validationError(errors, env) {
    return jsonResponse(
      { status: 'error', code: 'VALIDATION_ERROR', message: 'Invalid campaign payload', errors },
      { status: 400 },
      env,
    );
  }

  function _invalidId(env) {
    return _errorResponse(400, 'INVALID_CAMPAIGN_ID', 'Invalid campaign id', env);
  }

  /** Admin mutation rate limit (reward_center.js checkRcRateLimit pattern). */
  async function _checkRateLimit(env, adminId) {
    if (!isUserRateLimited || !env.RATE_LIMITS) return null;
    if (await isUserRateLimited(env, String(adminId), 'admin-mutation', 20, 60)) {
      return jsonResponse({ status: 'error', message: 'Too many admin actions. Please wait.', code: 'RATE_LIMITED' }, { status: 429 }, env);
    }
    return null;
  }

  /** Best-effort audit log (reward_center.js _log pattern — never blocks the response). */
  function _log(env, admin, action, targetId, details) {
    if (!adminRepo?.logAdminAction) return Promise.resolve();
    return adminRepo.logAdminAction(env, {
      admin_id: String(admin.telegram_id),
      action,
      target_type: 'promo_campaign',
      target_id: String(targetId),
      details: details || {},
      ip: null,
    }).catch(() => {});
  }

  /** Bounded integer query param with clamping; garbage falls back to default. */
  function _intParam(url, name, dflt, min, max) {
    const raw = url.searchParams.get(name);
    if (raw === null || raw === '') return dflt;
    const n = parseInt(raw, 10);
    if (!Number.isFinite(n)) return dflt;
    return Math.max(min, Math.min(max, n));
  }

  async function _readJsonObject(request, env, maxSize = 102400) {
    const bodyResult = await readJsonBody(request, maxSize, env);
    if (bodyResult.error) return { error: bodyResult.error };
    const payload = bodyResult.payload;
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { error: _errorResponse(400, 'INVALID_BODY', 'Request body must be a JSON object', env) };
    }
    return { payload };
  }

  // ── Validation ────────────────────────────────────────────────────────────

  /**
   * Validates the campaign payload fields present on `body`.
   * partial=false (create): title_fa/title_en and starts_at are required.
   * partial=true  (update): only the provided fields are validated; absent
   * fields are left untouched. `status` is NEVER part of the result — it is
   * handled exclusively by the dedicated status endpoint.
   * Returns { errors: [{field, message}], fields: {...} } — `fields` contains
   * only keys that validated OK; callers must not use it when errors exist.
   */
  function _validatePayload(body, { partial = false } = {}) {
    const errors = [];
    const fields = {};

    const textSpec = [
      { key: 'title_fa', max: MAX_TITLE, required: true },
      { key: 'title_en', max: MAX_TITLE, required: true },
      { key: 'summary_fa', max: MAX_SUMMARY, required: false },
      { key: 'summary_en', max: MAX_SUMMARY, required: false },
      { key: 'body_fa', max: MAX_BODY, required: false },
      { key: 'body_en', max: MAX_BODY, required: false },
    ];
    for (const spec of textSpec) {
      if (!Object.prototype.hasOwnProperty.call(body, spec.key)) {
        if (!partial && spec.required) errors.push({ field: spec.key, message: `${spec.key} is required` });
        continue;
      }
      const raw = body[spec.key];
      if (raw === null || raw === undefined) {
        // Explicit null on a REQUIRED field is rejected in create AND partial
        // mode alike — letting it through on update would surface later as a
        // DB NOT NULL violation (503) instead of a clean 400 (audit M-1).
        // Optional text fields still clear to their empty form
        // (summary → NULL, body → '').
        if (spec.required) {
          errors.push({ field: spec.key, message: `${spec.key} is required and cannot be null` });
        } else {
          fields[spec.key] = spec.key.startsWith('body_') ? '' : null;
        }
        continue;
      }
      if (typeof raw !== 'string') {
        errors.push({ field: spec.key, message: `${spec.key} must be a string` });
        continue;
      }
      const trimmed = raw.trim();
      if (spec.required && trimmed === '') {
        errors.push({ field: spec.key, message: `${spec.key} is required` });
        continue;
      }
      if (trimmed.length > spec.max) {
        errors.push({ field: spec.key, message: `${spec.key} must be at most ${spec.max} characters` });
        continue;
      }
      fields[spec.key] = trimmed;
    }

    // image_url — optional; validated with the shared advertisements.js
    // validator (HTTPS-only external URLs with SSRF guards, or the internal
    // /api/advertisements/image/:id form). Closes 5C finding L4.
    if (Object.prototype.hasOwnProperty.call(body, 'image_url')) {
      const raw = body.image_url;
      if (raw === null || raw === undefined || raw === '') {
        fields.image_url = null;
      } else if (typeof raw !== 'string') {
        errors.push({ field: 'image_url', message: 'image_url must be a string' });
      } else {
        const trimmed = raw.trim();
        if (!isValidImageUrl(trimmed)) {
          errors.push({ field: 'image_url', message: 'image_url must be a valid HTTPS image URL' });
        } else {
          fields.image_url = trimmed;
        }
      }
    }

    // registration_url — optional external registration destination. Empty/
    // null clears it (back to the in-app one-tap flow); a non-empty value
    // must pass the http(s)-only validator above.
    if (Object.prototype.hasOwnProperty.call(body, 'registration_url')) {
      const raw = body.registration_url;
      if (raw === null || raw === undefined || String(raw).trim() === '') {
        fields.registration_url = null;
      } else if (typeof raw !== 'string') {
        errors.push({ field: 'registration_url', message: 'registration_url must be a string' });
      } else if (!_isValidRegistrationUrl(raw)) {
        errors.push({ field: 'registration_url', message: 'registration_url must be a valid http(s) URL' });
      } else {
        fields.registration_url = raw.trim();
      }
    }

    // starts_at — required on create, optional on update, strict ISO 8601.
    if (Object.prototype.hasOwnProperty.call(body, 'starts_at') || !partial) {
      const raw = body.starts_at;
      if (raw === null || raw === undefined || raw === '') {
        errors.push({ field: 'starts_at', message: 'starts_at is required (ISO 8601 with timezone)' });
      } else if (typeof raw !== 'string' || !ISO_8601_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
        errors.push({ field: 'starts_at', message: 'starts_at must be a valid ISO 8601 timestamp with timezone' });
      } else {
        fields.starts_at = raw;
      }
    }

    // ends_at — optional, strict ISO 8601; null clears the deadline.
    if (Object.prototype.hasOwnProperty.call(body, 'ends_at')) {
      const raw = body.ends_at;
      if (raw === null || raw === undefined || raw === '') {
        fields.ends_at = null;
      } else if (typeof raw !== 'string' || !ISO_8601_RE.test(raw) || !Number.isFinite(Date.parse(raw))) {
        errors.push({ field: 'ends_at', message: 'ends_at must be a valid ISO 8601 timestamp with timezone' });
      } else {
        fields.ends_at = raw;
      }
    }

    return { errors, fields };
  }

  /** Cross-field window check on the FINAL merged values. */
  function _validateWindow(mergedStart, mergedEnd, errors) {
    if (!mergedStart || !mergedEnd) return;
    if (Date.parse(mergedEnd) <= Date.parse(mergedStart)) {
      errors.push({ field: 'ends_at', message: 'ends_at must be after starts_at' });
    }
  }

  // ── GET /api/admin/campaigns (list) ──────────────────────────────────────

  async function handleAdminListCampaigns(request, env) {
    const { error: authErr } = await requireAdmin(request, env, 'campaigns.view');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});
      const url = new URL(request.url);
      const status = url.searchParams.get('status') || null;
      if (status && !STATUSES.has(status)) {
        return _errorResponse(400, 'INVALID_STATUS_FILTER', `status must be one of ${[...STATUSES].join(', ')}`, env);
      }
      const search = (url.searchParams.get('search') || '').trim().slice(0, MAX_SEARCH) || null;
      const page = _intParam(url, 'page', 1, 1, 10000);
      const limit = _intParam(url, 'limit', 20, 1, 100);
      const result = await campaignsRepo.listCampaignsAdmin(env, { status, search, page, limit });
      // status goes LAST so a repo-level `status` key can never clobber the envelope.
      return jsonResponse({ ...result, status: 'success' }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-list', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/admin/campaigns/:id (detail) ────────────────────────────────

  async function handleAdminGetCampaign(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error: authErr } = await requireAdmin(request, env, 'campaigns.view');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});
      const campaign = await campaignsRepo.getCampaignById(env, campaignId);
      if (!campaign) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      return jsonResponse({ status: 'success', campaign }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-detail', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── POST /api/admin/campaigns (create) ───────────────────────────────────

  async function handleAdminCreateCampaign(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'campaigns.manage');
    if (authErr) return authErr;

    const rlErr = await _checkRateLimit(env, admin.telegram_id); if (rlErr) return rlErr;
    const { error: bodyErr, payload } = await _readJsonObject(request, env);
    if (bodyErr) return bodyErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      const { errors, fields } = _validatePayload(payload, { partial: false });

      let status = 'DRAFT';
      if (payload.status !== undefined && payload.status !== null && payload.status !== '') {
        if (typeof payload.status !== 'string' || !CREATE_STATUSES.has(payload.status)) {
          errors.push({ field: 'status', message: 'status must be DRAFT or PUBLISHED' });
        } else {
          status = payload.status;
        }
      }

      _validateWindow(fields.starts_at, fields.ends_at === undefined ? null : fields.ends_at, errors);

      if (errors.length) return _validationError(errors, env);

      const campaign = await campaignsRepo.createCampaign(env, {
        ...fields,
        ends_at: fields.ends_at === undefined ? null : fields.ends_at,
        status,
      });
      await _log(env, admin, 'campaigns_admin.create', campaign.id, {
        title_en: campaign.title_en,
        status: campaign.status,
        starts_at: campaign.starts_at,
        ends_at: campaign.ends_at,
      });
      return jsonResponse({ status: 'success', campaign }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-create', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── PUT/PATCH /api/admin/campaigns/:id (update) ──────────────────────────

  async function handleAdminUpdateCampaign(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error: authErr, admin } = await requireAdmin(request, env, 'campaigns.manage');
    if (authErr) return authErr;

    const rlErr = await _checkRateLimit(env, admin.telegram_id); if (rlErr) return rlErr;
    const { error: bodyErr, payload } = await _readJsonObject(request, env);
    if (bodyErr) return bodyErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      const { errors, fields } = _validatePayload(payload, { partial: true });

      // Status is deliberately NOT updatable here — one audited code path.
      if (payload.status !== undefined) {
        errors.push({ field: 'status', message: 'status cannot be changed here — use the status endpoint' });
      }
      if (!Object.keys(fields).length) {
        errors.push({ field: 'body', message: 'no updatable fields provided' });
      }

      const existing = await campaignsRepo.getCampaignById(env, campaignId);
      if (!existing) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      if (existing.status === 'DELETED') {
        return _errorResponse(409, 'CAMPAIGN_ALREADY_DELETED', 'Campaign is deleted and cannot be modified', env);
      }

      // Window check on the MERGED values (patch vs. stored starts_at/ends_at).
      const mergedStart = fields.starts_at !== undefined ? fields.starts_at : existing.starts_at;
      const mergedEnd = fields.ends_at !== undefined ? fields.ends_at : existing.ends_at;
      _validateWindow(mergedStart, mergedEnd, errors);

      if (errors.length) return _validationError(errors, env);

      const campaign = await campaignsRepo.updateCampaign(env, campaignId, fields);
      if (!campaign) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      await _log(env, admin, 'campaigns_admin.update', campaignId, {
        fields: Object.keys(fields),
        title_en: campaign.title_en,
      });
      return jsonResponse({ status: 'success', campaign }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-update', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── PUT/POST /api/admin/campaigns/:id/status (publish / stop / resume) ────

  async function handleAdminSetCampaignStatus(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error: authErr, admin } = await requireAdmin(request, env, 'campaigns.manage');
    if (authErr) return authErr;

    const rlErr = await _checkRateLimit(env, admin.telegram_id); if (rlErr) return rlErr;
    const { error: bodyErr, payload } = await _readJsonObject(request, env);
    if (bodyErr) return bodyErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      const target = payload.status;
      if (typeof target !== 'string' || !STATUS_TARGETS.has(target)) {
        return _errorResponse(400, 'INVALID_STATUS', 'status must be PUBLISHED or STOPPED', env);
      }

      const existing = await campaignsRepo.getCampaignById(env, campaignId);
      if (!existing) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      if (existing.status === 'DELETED') {
        return _errorResponse(409, 'CAMPAIGN_ALREADY_DELETED', 'Campaign is deleted and cannot be modified', env);
      }
      if (existing.status === target) {
        // Idempotent no-op (double-click safe) — current state returned as-is.
        return jsonResponse({ status: 'success', campaign: existing }, {}, env);
      }
      if (!ALLOWED_TRANSITIONS[existing.status].includes(target)) {
        return _errorResponse(
          409,
          'INVALID_STATUS_TRANSITION',
          `cannot transition campaign from ${existing.status} to ${target}`,
          env,
        );
      }

      const campaign = await campaignsRepo.setCampaignStatus(env, campaignId, target);
      if (!campaign) {
        // Lost a race with a concurrent delete (DELETED is terminal in SQL).
        return _errorResponse(409, 'CAMPAIGN_STATE_CHANGED', 'Campaign state changed, please retry', env);
      }
      await _log(env, admin, 'campaigns_admin.status', campaignId, { from: existing.status, to: target });
      return jsonResponse({ status: 'success', campaign }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-status', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── DELETE /api/admin/campaigns/:id (SOFT delete) ────────────────────────

  async function handleAdminDeleteCampaign(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error: authErr, admin } = await requireAdmin(request, env, 'campaigns.manage');
    if (authErr) return authErr;

    const rlErr = await _checkRateLimit(env, admin.telegram_id); if (rlErr) return rlErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      const existing = await campaignsRepo.getCampaignById(env, campaignId);
      if (!existing) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);
      if (existing.status === 'DELETED') {
        return _errorResponse(409, 'CAMPAIGN_ALREADY_DELETED', 'Campaign is already deleted', env);
      }

      const ok = await campaignsRepo.softDeleteCampaign(env, campaignId);
      if (!ok) {
        // Lost a race with a concurrent delete.
        return _errorResponse(409, 'CAMPAIGN_STATE_CHANGED', 'Campaign state changed, please retry', env);
      }
      await _log(env, admin, 'campaigns_admin.delete', campaignId, {
        title_en: existing.title_en,
        registration_count: existing.registration_count,
      });
      return jsonResponse({ status: 'success', deleted: true, id: String(campaignId) }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-delete', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── GET /api/admin/campaigns/:id/registrations (paginated list) ──────────

  async function handleAdminListRegistrations(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error: authErr } = await requireAdmin(request, env, 'campaigns.view');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      const campaign = await campaignsRepo.getCampaignById(env, campaignId);
      if (!campaign) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);

      const url = new URL(request.url);
      const page = _intParam(url, 'page', 1, 1, 10000);
      const limit = _intParam(url, 'limit', 20, 1, 100);
      const result = await campaignsRepo.listRegistrations(env, campaignId, { page, limit });
      return jsonResponse(
        { campaign_id: String(campaignId), registration_count: campaign.registration_count, ...result, status: 'success' },
        {},
        env,
      );
    } catch (e) {
      console.warn(safeError('campaigns-admin-registrations', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  // ── POST /api/admin/campaigns/upload-image (WebP-only upload) ────────────
  //
  // Campaign image upload with server-side WebP enforcement. The image is
  // converted to WebP in the ADMIN PANEL (browser canvas — Workers have no
  // native image libraries, see advertisements.js storeImage notes); this
  // endpoint is the trust boundary: it accepts ONLY WebP payloads so a
  // legacy/compromised client can never store a JPG/PNG/SVG as the final
  // campaign image. Storage reuses the advertisements KV path (adimg:<id>)
  // and returns the internal URL `/api/advertisements/image/:id`, which the
  // campaigns image_url validator already accepts. Old HTTPS image URLs keep
  // working unchanged (backward compatibility).
  async function handleAdminUploadCampaignImage(request, env) {
    const { error: authErr, admin } = await requireAdmin(request, env, 'campaigns.manage');
    if (authErr) return authErr;

    const rlErr = await _checkRateLimit(env, admin.telegram_id); if (rlErr) return rlErr;

    // 1MB JSON cap (base64 of a ≤500KB image ≈ 670KB + overhead).
    const { error: bodyErr, payload } = await _readJsonObject(request, env, 1024 * 1024);
    if (bodyErr) return bodyErr;

    const dataUri = payload.data_uri || '';
    if (typeof dataUri !== 'string' || !dataUri) {
      return _errorResponse(422, 'IMAGE_REQUIRED', 'data_uri is required', env);
    }
    // WebP-ONLY: accept "data:image/webp" data URIs. Everything else —
    // including SVG (no safe server-side conversion exists) — is explicitly
    // rejected. The client is expected to convert JPG/PNG first.
    const m = /^data:([^;]+);base64,/i.exec(dataUri);
    const declared = m ? m[1].toLowerCase() : '';
    if (declared !== 'image/webp') {
      return _errorResponse(
        422,
        'WEBP_REQUIRED',
        'Campaign images must be uploaded as WebP (convert the image in the admin panel first)',
        env,
      );
    }

    try {
      // storeImage re-verifies the WebP magic bytes (defense in depth) and
      // enforces the ≤500KB decoded size cap before writing to KV.
      const url = await advertisementsRepo.storeImage(env, dataUri, 'image/webp');
      await _log(env, admin, 'campaigns_admin.upload_image', 'image', { url });
      return jsonResponse({ status: 'success', url }, {}, env);
    } catch (e) {
      console.warn(safeError('campaigns-admin-upload-image', e));
      return _errorResponse(422, 'UPLOAD_FAILED', e.message || 'Upload failed', env);
    }
  }

  // ── GET /api/admin/campaigns/:id/registrations/export (CSV) ──────────────

  // CSV cell escaping (membership.js csvEscape) PLUS formula-injection
  // neutralization: a leading =, +, -, @, tab or CR makes spreadsheet apps
  // treat the cell as a formula — prefixing a single quote forces text.
  // Quoting triggers on quote/comma AND any line break (\n, \r): a bare CR
  // inside an unquoted field would split the record in spreadsheet apps and
  // could smuggle a post-CR "=..." fragment as a formula (audit M-3).
  function _csvEscape(v) {
    if (v === null || v === undefined) return '';
    let s = String(v);
    if (/^[=+\-@\t\r]/.test(s)) s = `'${s}`;
    s = s.replace(/"/g, '""');
    return /[",\n\r]/.test(s) ? `"${s}"` : s;
  }

  // Security headers for the CSV download (membership.js csvSecurityHeaders):
  // withCors (cross-origin admin fetch), attachment, no-store, nosniff —
  // the file carries PII (Telegram IDs, names).
  function _csvSecurityHeaders(filename, env) {
    const headers = withCors({ 'Content-Type': 'text/csv; charset=utf-8' }, env);
    headers.set('Content-Disposition', `attachment; filename="${filename}"`);
    headers.set('Cache-Control', 'no-store, no-cache, must-revalidate');
    headers.set('X-Content-Type-Options', 'nosniff');
    return headers;
  }

  async function handleAdminExportRegistrations(request, env, campaignId) {
    if (!CAMPAIGN_ID_RE.test(String(campaignId || ''))) return _invalidId(env);

    const { error: authErr } = await requireAdmin(request, env, 'campaigns.view');
    if (authErr) return authErr;

    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    try {
      await campaignsRepo.ensureSchema(env).catch(() => {});

      const campaign = await campaignsRepo.getCampaignById(env, campaignId);
      if (!campaign) return _errorResponse(404, 'CAMPAIGN_NOT_FOUND', 'Campaign not found', env);

      const url = new URL(request.url);
      const page = _intParam(url, 'page', 1, 1, 10000);
      const limit = _intParam(url, 'limit', 1000, 1, 1000);
      const result = await campaignsRepo.listRegistrations(env, campaignId, { page, limit });

      const header = ['Registration ID', 'Telegram ID', 'Username', 'First Name', 'Last Name', 'Registered At'].join(',');
      const rows = result.items.map((r) =>
        [r.id, r.telegram_id, r.username, r.first_name, r.last_name, r.registered_at].map(_csvEscape).join(','));
      const csv = '\ufeff' + [header, ...rows].join('\n');
      return new Response(csv, {
        status: 200,
        headers: _csvSecurityHeaders(`campaign-registrations-${campaignId}.csv`, env),
      });
    } catch (e) {
      console.warn(safeError('campaigns-admin-export', e));
      return safeDbErrorResponse(e, {}, env);
    }
  }

  return Object.freeze({
    handleAdminListCampaigns,
    handleAdminGetCampaign,
    handleAdminCreateCampaign,
    handleAdminUpdateCampaign,
    handleAdminSetCampaignStatus,
    handleAdminDeleteCampaign,
    handleAdminListRegistrations,
    handleAdminExportRegistrations,
    handleAdminUploadCampaignImage,
  });
}

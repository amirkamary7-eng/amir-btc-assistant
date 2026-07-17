/**
 * Analysis Controllers — HTTP Layer
 *
 * Endpoints:
 *   GET  /api/analyses              — list with featured, stats, pagination
 *   GET  /api/analyses/:id          — single analysis detail
 *   POST /api/analyses/:id/view     — increment view count
 *   POST /api/admin/analyses        — create (admin only)
 *   PUT  /api/admin/analyses/:id    — update (admin only)
 *   DELETE /api/admin/analyses/:id  — delete (admin only)
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createAnalysisHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    safeDbErrorResponse,
    safeError,
    buildBodyFieldValidationError,
    buildQueryFieldValidationError,
    isDatabaseConfigured,
    isAdminTelegramId,
    readAppCache,
    writeAppCache,
    analysisRepo,
    notificationRepo,
    sendTelegramMessage,
    resolveWebAppUrl,
    queryDb,
  } = deps;

  const ANALYSES_LIST_KEY = 'analyses:list';
  const ANALYSES_VERSION_KEY = 'analyses:version';
  const ANALYSES_FEATURED_KEY = 'analyses:featured';
  const DETAIL_CACHE_PREFIX = 'analysis:detail:';

  function generateVersion() {
    return Math.floor(Date.now() / 1000);
  }

  // ── Cache helpers ──────────────────────────────────────────────────────

  async function readCachedAnalysesState(env) {
    const [cachedVersion, cachedList] = await Promise.all([
      readAppCache(env, ANALYSES_VERSION_KEY),
      readAppCache(env, ANALYSES_LIST_KEY),
    ]);
    let version = null;
    let analyses = null;
    if (cachedVersion !== null) {
      const n = Number(cachedVersion);
      if (Number.isFinite(n)) version = n;
    }
    if (cachedList) {
      try {
        const parsed = JSON.parse(cachedList);
        if (Array.isArray(parsed)) analyses = parsed;
      } catch { analyses = null; }
    }
    return { version, analyses };
  }

  async function updateAnalysesCache(env, analyses, version) {
    const ttl = 86400 * 7;
    await Promise.all([
      writeAppCache(env, ANALYSES_VERSION_KEY, String(version), ttl),
      writeAppCache(env, ANALYSES_LIST_KEY, JSON.stringify(analyses), ttl),
    ]);
  }

  async function invalidateAnalysesCache(env) {
    const version = generateVersion();
    // Write a tombstone version so all clients know to refetch
    await writeAppCache(env, ANALYSES_VERSION_KEY, String(version), 86400 * 7);
    // Delete list cache so next request hits DB
    try { await env.APP_CACHE?.delete?.(ANALYSES_LIST_KEY); } catch {}
    // Delete featured cache
    try { await env.APP_CACHE?.delete?.(ANALYSES_FEATURED_KEY); } catch {}
    return version;
  }

  // ── Validation ─────────────────────────────────────────────────────────

  function parseAnalysisPayload(originalBody, options = {}, env) {
    const { requireAuthor = false } = options;
    let payload;
    try {
      payload = JSON.parse(originalBody);
    } catch {
      return { error: jsonResponse(buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null), { status: 422 }, env) };
    }
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return { error: jsonResponse(buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null), { status: 422 }, env) };
    }

    const validated = {};
    const fieldSpecs = [
      { name: 'coin', required: true, minLength: 1, maxLength: 16 },
      { name: 'timeframe', required: false, defaultValue: '1d', maxLength: 16 },
      { name: 'image', required: false, defaultValue: '', maxLength: 512 },
      { name: 'text', required: true, minLength: 1, maxLength: 50000 },
      { name: 'title', required: false, defaultValue: '', maxLength: 256 },
      { name: 'support_level', required: false, defaultValue: '', maxLength: 64 },
      { name: 'current_price', required: false, defaultValue: '', maxLength: 64 },
      { name: 'resistance_level', required: false, defaultValue: '', maxLength: 64 },
      ...(requireAuthor ? [{ name: 'author', required: true, minLength: 1, maxLength: 128 }] : []),
    ];

    for (const spec of fieldSpecs) {
      const rawValue = Object.prototype.hasOwnProperty.call(payload, spec.name) ? payload[spec.name] : spec.defaultValue;
      if (typeof rawValue !== 'string') {
        return { error: jsonResponse(buildBodyFieldValidationError(spec.name, 'string_type', 'Input should be a valid string', rawValue ?? null), { status: 422 }, env) };
      }
      if (spec.minLength && rawValue.length < spec.minLength) {
        return { error: jsonResponse(buildBodyFieldValidationError(spec.name, 'string_too_short', `String should have at least ${spec.minLength} character${spec.minLength === 1 ? '' : 's'}`, rawValue, { min_length: spec.minLength }), { status: 422 }, env) };
      }
      if (spec.maxLength && rawValue.length > spec.maxLength) {
        return { error: jsonResponse(buildBodyFieldValidationError(spec.name, 'string_too_long', `String should have at most ${spec.maxLength} characters`, rawValue, { max_length: spec.maxLength }), { status: 422 }, env) };
      }
      validated[spec.name] = rawValue;
    }

    // Handle boolean featured field
    validated.featured = Boolean(payload.featured);

    return { payload: validated };
  }

  // ── Admin auth helper ──────────────────────────────────────────────────

  function requireAdmin(request, env) {
    // Must await the auth result
    return authenticateTelegramRequest(request, env);
  }

  // ── Public HTTP Handlers ───────────────────────────────────────────────

  /**
   * GET /api/analyses — List with featured, stats, pagination.
   */
  async function handleList(request, env) {
    const url = new URL(request.url);
    const rawVersion = url.searchParams.get('version');
    let requestedVersion = null;

    if (rawVersion !== null && rawVersion !== '') {
      const n = Number(rawVersion);
      if (!Number.isInteger(n)) {
        return jsonResponse(buildQueryFieldValidationError('version', 'int_parsing', 'Input should be a valid integer', rawVersion), { status: 422 }, env);
      }
      requestedVersion = n;
    }

    const page = Math.max(1, parseInt(url.searchParams.get('page') || '1', 10));
    const limit = Math.min(50, Math.max(1, parseInt(url.searchParams.get('limit') || '20', 10)));

    const cachedState = await readCachedAnalysesState(env);

    // Version match → unchanged (but always return featured + stats fresh for accuracy)
    if (requestedVersion !== null && cachedState.version !== null && requestedVersion === cachedState.version) {
      // Still fetch fresh featured + stats
      let featured = null;
      let stats = { active: 0, today: 0, total: 0 };
      if (isDatabaseConfigured(env)) {
        try {
          const cachedFeatured = await readAppCache(env, ANALYSES_FEATURED_KEY);
          if (cachedFeatured) {
            try { featured = JSON.parse(cachedFeatured); } catch { featured = null; }
          }
          if (!featured) {
            featured = await analysisRepo.getFeatured(env);
            if (featured) await writeAppCache(env, ANALYSES_FEATURED_KEY, JSON.stringify(featured), 300);
          }
          stats = await analysisRepo.getStats(env);
        } catch {}
      }
      return jsonResponse({
        status: 'success',
        analyses: null,
        version: cachedState.version,
        unchanged: true,
        featured,
        stats,
        pagination: null,
      }, {}, env);
    }

    // Need fresh data from DB
    if (isDatabaseConfigured(env)) {
      try {
        // Ensure schema on first request
        await analysisRepo.ensureSchema(env).catch(() => {});

        const [listResult, featured, stats] = await Promise.all([
          analysisRepo.list(env, page, limit),
          analysisRepo.getFeatured(env),
          analysisRepo.getStats(env),
        ]);

        // Cache featured separately (short TTL)
        if (featured) {
          await writeAppCache(env, ANALYSES_FEATURED_KEY, JSON.stringify(featured), 300);
        }

        // For the full-list cache (used by dashboard slider), update it
        const allAnalyses = await analysisRepo.listAll(env);
        const dataUnchanged = cachedState.analyses !== null &&
          cachedState.version !== null &&
          JSON.stringify(allAnalyses) === JSON.stringify(cachedState.analyses);
        const version = dataUnchanged ? cachedState.version : generateVersion();
        await updateAnalysesCache(env, allAnalyses, version);

        return jsonResponse({
          status: 'success',
          featured,
          stats,
          analyses: listResult.analyses,
          pagination: listResult.pagination,
          version,
          unchanged: false,
        }, {}, env);
      } catch (error) {
        console.warn(safeError('list-analyses', error));
        return safeDbErrorResponse(error, {}, env);
      }
    }

    // DB not configured
    if (cachedState.analyses === null) {
      return jsonResponse({ status: 'error', message: 'Database unavailable', analyses: null }, { status: 503 }, env);
    }
    return jsonResponse({
      status: 'success',
      featured: null,
      stats: { active: cachedState.analyses.length, today: 0, total: cachedState.analyses.length },
      analyses: cachedState.analyses,
      version: cachedState.version ?? 0,
      pagination: null,
      unchanged: false,
    }, {}, env);
  }

  /**
   * GET /api/analyses/:id — Single analysis detail.
   */
  async function handleGetDetail(request, env, analysisId) {
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database unavailable' }, { status: 503 }, env);
    }
    try {
      // Try cache first (short TTL)
      const cacheKey = `${DETAIL_CACHE_PREFIX}${analysisId}`;
      const cached = await readAppCache(env, cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached);
          return jsonResponse({ status: 'success', analysis: parsed }, {}, env);
        } catch {}
      }

      const analysis = await analysisRepo.getById(env, analysisId);
      if (!analysis) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }

      // Cache for 60 seconds
      await writeAppCache(env, cacheKey, JSON.stringify(analysis), 60);

      return jsonResponse({ status: 'success', analysis }, {}, env);
    } catch (error) {
      console.warn(safeError('get-analysis-detail', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * POST /api/analyses/:id/view — Increment view count.
   */
  async function handleIncrementView(request, env, analysisId) {
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database unavailable' }, { status: 503 }, env);
    }
    try {
      const views = await analysisRepo.incrementViews(env, analysisId);
      if (views === null) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      return jsonResponse({ status: 'success', views_count: views }, {}, env);
    } catch (error) {
      console.warn(safeError('increment-view', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ── Admin HTTP Handlers ────────────────────────────────────────────────

  /**
   * POST /api/admin/analyses — Create (admin only).
   */
  async function handleCreate(request, env, ctx) {
    const authResult = await requireAdmin(request, env);
    if (authResult.error) return authResult.error;
    if (!isAdminTelegramId(env, authResult.user.id)) {
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const parsed = parseAnalysisPayload(await request.text(), { requireAuthor: true }, env);
    if (parsed.error) return parsed.error;

    try {
      await analysisRepo.ensureSchema(env);
      const analysis = await analysisRepo.create(env, authResult.user.id, parsed.payload);
      const version = await invalidateAnalysesCache(env);

      // Notify joined users (non-blocking)
      const notify = notifyNewAnalysis(env, analysis, ctx);
      if (ctx?.waitUntil) ctx.waitUntil(notify.catch(() => {}));
      else notify.catch(() => {});

      return jsonResponse({ status: 'success', analysis, version }, {}, env);
    } catch (error) {
      console.warn(safeError('create-analysis', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * PUT /api/admin/analyses/:id — Update (admin only).
   */
  async function handleUpdate(request, env, analysisId) {
    const authResult = await requireAdmin(request, env);
    if (authResult.error) return authResult.error;
    if (!isAdminTelegramId(env, authResult.user.id)) {
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const parsed = parseAnalysisPayload(await request.text(), { requireAuthor: false }, env);
    if (parsed.error) return parsed.error;

    try {
      const analysis = await analysisRepo.update(env, analysisId, parsed.payload);
      if (!analysis) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      const version = await invalidateAnalysesCache(env);
      return jsonResponse({ status: 'success', analysis, version }, {}, env);
    } catch (error) {
      console.warn(safeError('update-analysis', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/admin/analyses/:id — Delete (admin only, double-confirm in frontend).
   */
  async function handleDelete(request, env, analysisId) {
    const authResult = await requireAdmin(request, env);
    if (authResult.error) return authResult.error;
    if (!isAdminTelegramId(env, authResult.user.id)) {
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env);
    }
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      const deleted = await analysisRepo.remove(env, analysisId);
      if (!deleted) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      const version = await invalidateAnalysesCache(env);
      return jsonResponse({ status: 'success', version }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-analysis', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  // ── Notification ───────────────────────────────────────────────────────

  async function notifyNewAnalysis(env, analysis, ctx) {
    if (!notificationRepo || !sendTelegramMessage || !queryDb) return;
    const coinLabel = String(analysis.coin || '').toUpperCase() || 'Crypto';
    const title = `📊 تحلیل جدید: ${coinLabel}`;
    const message = analysis.title || `تحلیل ${coinLabel} (${analysis.timeframe}) منتشر شد.`;

    try {
      const usersResult = await queryDb(env, `SELECT telegram_id FROM users WHERE channel_joined = TRUE`);
      const userIds = usersResult.rows.map((r) => String(r.telegram_id));
      if (userIds.length === 0) return;

      await notificationRepo.createBulk(env, userIds, 'analysis', title, message, {
        analysis_id: analysis.id,
        coin: analysis.coin,
      });

      const webAppUrl = resolveWebAppUrl ? resolveWebAppUrl(env, { cacheBust: true }) : '';
      if (!webAppUrl) return;

      for (const uid of userIds) {
        try {
          await sendTelegramMessage(env, {
            chat_id: Number(uid),
            text: `${title}\n${message}`,
            disable_web_page_preview: true,
            reply_markup: {
              inline_keyboard: [[{
                text: 'مشاهده تحلیل 🚀',
                web_app: { url: webAppUrl },
              }]],
            },
          });
        } catch { /* skip */ }
      }
    } catch (err) {
      console.warn(safeError('notify-new-analysis', err));
    }
  }

  // ── Legacy compatibility wrappers (old routes) ─────────────────────────
  // These keep the old POST/PUT/DELETE /api/analyses paths working.

  async function handleCreateLegacy(request, env, ctx) {
    return handleCreate(request, env, ctx);
  }
  async function handleUpdateLegacy(request, env, analysisId) {
    return handleUpdate(request, env, analysisId);
  }
  async function handleDeleteLegacy(request, env, analysisId) {
    return handleDelete(request, env, analysisId);
  }

  return Object.freeze({
    handleList,
    handleGetDetail,
    handleIncrementView,
    handleCreate,
    handleUpdate,
    handleDelete,
    // Legacy — old routes still call these
    handleCreateLegacy,
    handleUpdateLegacy,
    handleDeleteLegacy,
  });
}
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
    adminRepo,
    notificationRepo,
    notificationPlatformRepo,
    sendTelegramMessage,
    resolveWebAppUrl,
    queryDb,
  } = deps;

  const ANALYSES_LIST_KEY = 'analyses:list';
  const ANALYSES_VERSION_KEY = 'analyses:version';
  const ANALYSES_FEATURED_KEY = 'analyses:featured';
  const ANALYSES_STATS_KEY = 'analyses:stats';
  const DETAIL_CACHE_PREFIX = 'analysis:detail:';

  function generateVersion() {
    // FIX 2: millisecond precision (was second-granularity Date.now()/1000).
    // Two CRUDs in the same second produced the same version → client saw
    // unchanged:true and missed the second update. ms precision makes collisions
    // virtually impossible.
    return Date.now();
  }

  /**
   * ANVERSION-FLIP FIX: Compute a content signature for the analyses list.
   *
   * The signature is a hash of (id + updated_at + featured) for each analysis.
   * It changes ONLY when data actually changes (create/update/delete/featured
   * toggle). Unlike Date.now()-based version, it does NOT change just because
   * time passed.
   *
   * Used by handleList to decide whether to keep the cached version (data
   * unchanged) or generate a new one (data changed). This makes the
   * ?version= cache-check mechanism actually work: a client that sends the
   * correct version gets unchanged:true even after the cache TTL expires,
   * as long as no CRUD has occurred.
   */
  function computeContentSignature(analyses) {
    if (!Array.isArray(analyses) || analyses.length === 0) return 'empty';
    // Build a compact string: id|updated_at|featured for each analysis
    const parts = analyses.map(a =>
      `${a.id}|${a.updated_at || ''}|${a.featured ? '1' : '0'}`
    );
    const combined = parts.join(';;');
    // Simple hash (djb2) — fast, no crypto needed, collision risk negligible
    // for ~50 items
    let hash = 5381;
    for (let i = 0; i < combined.length; i++) {
      hash = ((hash << 5) + hash) + combined.charCodeAt(i);
      hash = hash & hash; // Convert to 32-bit int
    }
    return Math.abs(hash).toString(36);
  }

  // ── Cache helpers ──────────────────────────────────────────────────────

  async function readCachedAnalysesState(env) {
    const [cachedVersion, cachedList, cachedSignature] = await Promise.all([
      readAppCache(env, ANALYSES_VERSION_KEY),
      readAppCache(env, ANALYSES_LIST_KEY),
      readAppCache(env, 'analyses:signature'),
    ]);
    let version = null;
    let analyses = null;
    let signature = null;
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
    if (cachedSignature !== null) {
      signature = cachedSignature;
    }
    return { version, analyses, signature };
  }

  async function updateAnalysesCache(env, analyses, version, signature) {
    const ttl = 86400 * 7;
    await Promise.all([
      writeAppCache(env, ANALYSES_VERSION_KEY, String(version), ttl),
      writeAppCache(env, ANALYSES_LIST_KEY, JSON.stringify(analyses), ttl),
      writeAppCache(env, 'analyses:signature', signature, ttl),
    ]);
  }

  /**
   * Invalidate analyses list/featured/stats/version caches.
   * FIX 1: optionally also invalidate the per-analysis detail cache
   * (analysis:detail:<id>) so GET /:id never returns a stale or deleted record.
   * Pass analysisId on update and delete to purge that specific detail entry.
   */
  async function invalidateAnalysesCache(env, analysisId = null) {
    const version = generateVersion();
    // Write a tombstone version so all clients know to refetch
    await writeAppCache(env, ANALYSES_VERSION_KEY, String(version), 86400 * 7);
    // Delete list cache so next request hits DB
    try { await env.APP_CACHE?.delete?.(ANALYSES_LIST_KEY); } catch {}
    // Delete featured cache
    try { await env.APP_CACHE?.delete?.(ANALYSES_FEATURED_KEY); } catch {}
    // Delete stats cache
    try { await env.APP_CACHE?.delete?.(ANALYSES_STATS_KEY); } catch {}
    // ANVERSION-FLIP FIX: Delete the content signature so the next fresh
    // fetch generates a new signature (matching the new data).
    try { await env.APP_CACHE?.delete?.('analyses:signature'); } catch {}
    // FIX 1: delete the per-analysis detail cache so stale data doesn't linger
    if (analysisId) {
      try { await env.APP_CACHE?.delete?.(`${DETAIL_CACHE_PREFIX}${analysisId}`); } catch {}
    }
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
      { name: 'category', required: false, defaultValue: 'crypto', maxLength: 16 },
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

    // ANSEC-XSS-IMG FIX: Validate image URL scheme at storage time.
    // Reject non-http(s) schemes (javascript:, data:, vbscript:, file:, etc.)
    // to prevent stored XSS via admin-created analysis images. Empty string
    // is allowed (means no image). Defense-in-depth: frontend also validates
    // via sanitizeNewsUrl before rendering, but this catches it at the source.
    if (validated.image && validated.image.trim()) {
      if (!/^https?:\/\//i.test(validated.image.trim())) {
        return { error: jsonResponse(buildBodyFieldValidationError('image', 'url_scheme', 'Image URL must use http: or https: scheme', validated.image, null), { status: 422 }, env) };
      }
    }

    // Handle boolean featured field
    validated.featured = Boolean(payload.featured);

    // Handle force_featured flag (not a DB field, used for featured limit override)
    validated.force_featured = Boolean(payload.force_featured);

    return { payload: validated };
  }

  // ── Admin auth helper ──────────────────────────────────────────────────

  function requireAdmin(request, env) {
    // Must await the auth result
    return authenticateTelegramRequest(request, env);
  }

  /**
   * ANSEC-PERM FIX: Check if the authenticated admin has a specific permission.
   *
   * Permission hierarchy:
   *   1. Super admin (env ADMIN_TELEGRAM_ID/IDS) → ALL permissions granted
   *   2. DB-registered admin (admins table) → check role.permissions array
   *   3. Not an admin at all → deny
   *
   * This connects the backend to the EXISTING permission model in the admins
   * table (role + permissions JSONB column). The frontend (admin.js) already
   * has ADMIN_ROLES/ADMIN_PERMISSIONS for UI visibility — this makes the
   * backend enforce the same permissions at the API level.
   *
   * @param {object} env - Worker env
   * @param {string} userId - Telegram user ID
   * @param {string} permission - Permission key (e.g. 'analysis.publish')
   * @returns {Promise<{allowed: boolean, error: object|null}>}
   */
  async function checkAnalysisPermission(env, userId, permission) {
    // Super admins (env-configured) have ALL permissions
    if (isAdminTelegramId(env, userId)) {
      return { allowed: true, error: null };
    }

    // Not a super admin — check the admins table for role + permissions
    if (!adminRepo?.getAdminByTelegramId) {
      // adminRepo not available — deny (fail closed)
      return {
        allowed: false,
        error: jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env),
      };
    }

    try {
      const admin = await adminRepo.getAdminByTelegramId(env, String(userId));
      if (!admin || !admin.active) {
        return {
          allowed: false,
          error: jsonResponse({ detail: 'Admin access required' }, { status: 403 }, env),
        };
      }
      // Check if the admin has the required permission
      const perms = Array.isArray(admin.permissions) ? admin.permissions : [];
      const hasPermission = perms.includes('*') || perms.includes(permission);
      if (!hasPermission) {
        return {
          allowed: false,
          error: jsonResponse({ detail: `Permission denied: ${permission} required` }, { status: 403 }, env),
        };
      }
      return { allowed: true, error: null };
    } catch (e) {
      // DB error — fail closed (deny)
      console.warn('[analysis-perm] Permission check failed:', e?.message);
      return {
        allowed: false,
        error: jsonResponse({ detail: 'Permission verification failed' }, { status: 403 }, env),
      };
    }
  }

  // ── Public HTTP Handlers ───────────────────────────────────────────────

  /**
   * GET /api/analyses — List with featured, stats, pagination.
   */
  async function handleList(request, env) {
    const _t0 = Date.now();
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

    const _tCacheStart = Date.now();
    const cachedState = await readCachedAnalysesState(env);
    console.log('[ANALYSES] readCachedAnalysesState: ' + (Date.now() - _tCacheStart) + 'ms, version=' + cachedState.version);

    // Version match → unchanged (but return cached featured + stats for accuracy)
    if (requestedVersion !== null && cachedState.version !== null && requestedVersion === cachedState.version) {
      let featured = null;
      let stats = { active: 0, today: 0, total: 0 };
      if (isDatabaseConfigured(env)) {
        try {
          // Try cached featured
          const cachedFeatured = await readAppCache(env, ANALYSES_FEATURED_KEY);
          if (cachedFeatured) {
            try { featured = JSON.parse(cachedFeatured); } catch { featured = null; }
          }
          if (!featured) {
            featured = await analysisRepo.getFeatured(env);
            if (featured) await writeAppCache(env, ANALYSES_FEATURED_KEY, JSON.stringify(featured), 300);
          }
          // Try cached stats
          const cachedStats = await readAppCache(env, ANALYSES_STATS_KEY);
          if (cachedStats) {
            try { stats = JSON.parse(cachedStats); } catch { stats = { active: 0, today: 0, total: 0 }; }
          }
          if (!cachedStats) {
            stats = await analysisRepo.getStats(env);
            await writeAppCache(env, ANALYSES_STATS_KEY, JSON.stringify(stats), 60);
          }
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
        const _tSchema = Date.now();
        await analysisRepo.ensureSchema(env).catch(() => {});
        console.log('[ANALYSES] ensureSchema: ' + (Date.now() - _tSchema) + 'ms');

        const _tQuery = Date.now();
        const pageData = await analysisRepo.listWithStatsAndFeatured(env, page, limit);
        console.log('[ANALYSES] listWithStatsAndFeatured: ' + (Date.now() - _tQuery) + 'ms, items=' + (pageData.analyses?.length || 0));

        // Cache featured separately (short TTL)
        if (pageData.featured) {
          await writeAppCache(env, ANALYSES_FEATURED_KEY, JSON.stringify(pageData.featured), 300);
        }

        // Cache stats (short TTL — invalidated on CRUD)
        await writeAppCache(env, ANALYSES_STATS_KEY, JSON.stringify(pageData.stats), 60);

        // ANVERSION-FLIP FIX: Compute content signature and compare with cached.
        // If the signature matches (data unchanged), keep the cached version so
        // clients sending ?version=<cached> get unchanged:true. If the signature
        // differs (data changed), generate a new version.
        const newSignature = computeContentSignature(pageData.analyses);
        let version;
        if (cachedState.signature && cachedState.signature === newSignature && cachedState.version) {
          // Data unchanged — keep the existing version
          version = cachedState.version;
        } else {
          // Data changed (or first load) — generate new version
          version = generateVersion();
        }
        // Cache the paginated list with version + signature
        await updateAnalysesCache(env, pageData.analyses, version, newSignature);

        console.log('[ANALYSES] total: ' + (Date.now() - _t0) + 'ms (success)');
        return jsonResponse({
          status: 'success',
          featured: pageData.featured,
          stats: pageData.stats,
          analyses: pageData.analyses,
          pagination: pageData.pagination,
          version,
          unchanged: false,
        }, {}, env);
      } catch (error) {
        console.warn('[ANALYSES] ERROR after ' + (Date.now() - _t0) + 'ms:', error?.message || error);
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
   *
   * ANVIEW-CACHE FIX: After incrementing views_count in DB, update the
   * analysis:detail:<id> cache so the next GET /:id returns the fresh
   * count immediately (instead of waiting 60s for the cache TTL to expire).
   *
   * ANVIEW-SPAM FIX: Per-user rate limit — one increment per user per
   * analysis per 24h. Uses KV key analysis_viewed:<userId>:<analysisId>
   * with 24h TTL. If the key exists, the user already viewed this analysis
   * today → return current count WITHOUT incrementing. Different users
   * can still increment independently. This prevents artificial view
   * count inflation via rapid repeated requests.
   */
  async function handleIncrementView(request, env, analysisId) {
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database unavailable' }, { status: 503 }, env);
    }
    try {
      // ANVIEW-SPAM FIX: Extract userId from the auth state (set by
      // _DATA_PATHS gate in production). In dev mode, _protectedUser may
      // be null — skip rate limiting (dev mode is trusted).
      const userId = request._protectedUser?.id ? String(request._protectedUser.id) : null;
      const viewedKey = userId ? `analysis_viewed:${userId}:${analysisId}` : null;

      // Check if this user already viewed this analysis today
      if (viewedKey) {
        const alreadyViewed = await readAppCache(env, viewedKey);
        if (alreadyViewed) {
          // User already viewed — return current count WITHOUT incrementing.
          // Still return success so the frontend doesn't show an error.
          const analysis = await analysisRepo.getById(env, analysisId);
          if (!analysis) {
            return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
          }
          return jsonResponse({ status: 'success', views_count: analysis.views_count, already_viewed: true }, {}, env);
        }
      }

      const views = await analysisRepo.incrementViews(env, analysisId);
      if (views === null) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }

      // Mark this user as having viewed this analysis (24h TTL)
      if (viewedKey) {
        try {
          await writeAppCache(env, viewedKey, '1', 86400); // 24 hours
        } catch {
          // Non-fatal — if KV write fails, the user might increment again,
          // but that's acceptable (worst case: 1 extra view).
        }
      }

      // ANVIEW-CACHE FIX: Update the detail cache for THIS analysis only.
      const cacheKey = `${DETAIL_CACHE_PREFIX}${analysisId}`;
      try {
        const cached = await readAppCache(env, cacheKey);
        if (cached) {
          const parsed = JSON.parse(cached);
          parsed.views_count = views;
          await writeAppCache(env, cacheKey, JSON.stringify(parsed), 60);
        }
      } catch {
        // Non-fatal — cache update failed, but DB increment succeeded.
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
    // ANSEC-PERM FIX: Check granular permission instead of just isAdminTelegramId.
    // Super admins (env) pass automatically. DB-registered admins need
    // 'analysis.publish' permission.
    const permCheck = await checkAnalysisPermission(env, authResult.user.id, 'analysis.publish');
    if (!permCheck.allowed) return permCheck.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const parsed = parseAnalysisPayload(await request.text(), { requireAuthor: true }, env);
    if (parsed.error) return parsed.error;

    try {
      await analysisRepo.ensureSchema(env);

      // ANFEAT-RACE FIX: Use atomic createWithFeaturedLimit instead of
      // separate countFeatured + create. The old code had a TOCTOU race:
      // concurrent requests all read count=4 (under limit) then all INSERT,
      // exceeding the max-5 business rule. The new atomic function uses
      // pg_advisory_xact_lock + a single CTE that counts, conditionally
      // un-features oldest (if force_featured), and inserts — all in one
      // statement under the lock. No concurrent request can sneak in.
      const result = await analysisRepo.createWithFeaturedLimit(env, authResult.user.id, parsed.payload);

      if (result.limitReached) {
        return jsonResponse({ status: 'FEATURED_LIMIT_REACHED', count: result.featuredCountBefore, max: result.max }, {}, env);
      }

      const analysis = result.analysis;
      const version = await invalidateAnalysesCache(env);

      // PRODUCTION-GRADE BROADCAST NOTIFICATION SYSTEM
      //
      // Instead of N+1 loop (201 queryDb, exceededCpu), we create a SINGLE
      // broadcast job record. The cron processBroadcastBatch runs every minute,
      // processes 5 users per tick with checkpoint/resume, respects notification
      // settings, and handles Telegram rate limits (429 backoff).
      //
      // handleCreate: 3 queryDb total (ensureSchema + create + createBroadcastJob)
      // All use shared Pool from withSharedPool. No ctx.waitUntil needed.
      const coinLabel = String(analysis.coin || '').toUpperCase() || 'Crypto';
      const notifTitle = `📊 تحلیل جدید: ${coinLabel}`;
      const notifMessage = analysis.title || `تحلیل ${coinLabel} (${analysis.timeframe}) منتشر شد.`;

      // Create broadcast job (1 queryDb, shared Pool) then immediately start
      // processing it in ctx.waitUntil. Response is already being sent —
      // the broadcast runs in background with batch+checkpoint.
      let broadcastId = null;
      if (notificationPlatformRepo && notificationPlatformRepo.createBroadcastJob) {
        try {
          broadcastId = await notificationPlatformRepo.createBroadcastJob(env, {
            adminId: authResult.user.id,
            title: notifTitle,
            message: notifMessage,
            category: 'analysis',
            priority: 'medium',
            channel: 'both',
            metadata: { coin: analysis.coin, analysisId: analysis.id },
          });
        } catch (e) {
          console.warn('[analysis-create] broadcast job creation failed (non-fatal):', e?.message);
        }
      }

      // Start processing IMMEDIATELY in ctx.waitUntil (not waiting for cron)
      // CRITICAL: Detach env._reqPool BEFORE ctx.waitUntil so processBroadcastFull
      // creates independent per-call Pools (not the request's shared Pool which
      // will be closed by withSharedPool's finally block after response is sent).
      // Without this, processBroadcastFull would try to use env._reqPool after
      // it's been closed → "Cannot perform I/O on behalf of a different request".
      if (broadcastId && ctx?.waitUntil && notificationPlatformRepo?.processBroadcastFull) {
        const _savedPool = env._reqPool;
        const _savedReqId = env._poolReqId;
        env._reqPool = null;
        env._poolReqId = null;

        ctx.waitUntil(
          notificationPlatformRepo.processBroadcastFull(env, sendTelegramMessage, broadcastId)
            .catch((e) => console.warn('[analysis-create] broadcast processing failed:', e?.message))
        );

        // Restore the Pool for any remaining queries in this request
        env._reqPool = _savedPool;
        env._poolReqId = _savedReqId;
      }

      // ANRESP-ASYM FIX: Return stats + featured (same shape as PUT) so the
      // frontend can update all sections without a background refetch.
      // Previously POST returned only {analysis, version} while PUT returned
      // {analysis, version, stats, featured}. The frontend already handles
      // both shapes via conditional checks (if result.stats, if Array.isArray
      // (result.featured)), so this is a safe additive change.
      const [createStats, createFeatured] = await Promise.all([
        analysisRepo.getStats(env),
        analysisRepo.getFeatured(env),
      ]);

      return jsonResponse({ status: 'success', analysis, version, stats: createStats, featured: createFeatured }, {}, env);
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
    // ANSEC-PERM FIX: Check 'analysis.edit' permission
    const permCheck = await checkAnalysisPermission(env, authResult.user.id, 'analysis.edit');
    if (!permCheck.allowed) return permCheck.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    const parsed = parseAnalysisPayload(await request.text(), { requireAuthor: false }, env);
    if (parsed.error) return parsed.error;

    try {
      // ANFEAT-RACE FIX: Use atomic updateWithFeaturedLimit instead of
      // separate countFeatured + getById + unsetOldestFeatured + update.
      // Same TOCTOU race as create — fixed with advisory lock + CTE.
      const result = await analysisRepo.updateWithFeaturedLimit(env, analysisId, parsed.payload);

      if (result.notFound) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      if (result.limitReached) {
        return jsonResponse({ status: 'FEATURED_LIMIT_REACHED', count: result.featuredCountBefore, max: result.max }, {}, env);
      }

      const analysis = result.analysis;
      // FIX 1: pass analysisId so the detail cache for this analysis is purged too
      const version = await invalidateAnalysesCache(env, analysisId);

      // Fetch fresh stats + featured (KV may be stale on other instances)
      const [stats, featured] = await Promise.all([
        analysisRepo.getStats(env),
        analysisRepo.getFeatured(env),
      ]);

      return jsonResponse({ status: 'success', analysis, version, stats, featured }, {}, env);
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
    // ANSEC-PERM FIX: Check 'analysis.delete' permission
    const permCheck = await checkAnalysisPermission(env, authResult.user.id, 'analysis.delete');
    if (!permCheck.allowed) return permCheck.error;
    if (!isDatabaseConfigured(env)) {
      return jsonResponse({ status: 'error', message: 'Database not configured' }, { status: 503 }, env);
    }

    try {
      const deleted = await analysisRepo.remove(env, analysisId);
      if (!deleted) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }

      const version = await invalidateAnalysesCache(env, analysisId);

      // ANRESP-ASYM FIX: Return stats + featured (same shape as PUT) so the
      // frontend can update all sections without a background refetch.
      // Previously DELETE returned only {version} (no analysis/stats/featured).
      // The frontend's executeDeleteAnalysis already checks for result.stats
      // and result.featured via conditionals, so this is a safe additive change.
      // analysis is null (the analysis was deleted).
      const [deleteStats, deleteFeatured] = await Promise.all([
        analysisRepo.getStats(env),
        analysisRepo.getFeatured(env),
      ]);

      return jsonResponse({ status: 'success', analysis: null, version, stats: deleteStats, featured: deleteFeatured }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-analysis', error));
      return safeDbErrorResponse(error, {}, env);
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
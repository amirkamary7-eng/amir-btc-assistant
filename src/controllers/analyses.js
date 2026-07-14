/**
 * Analysis Controllers — HTTP Layer
 *
 * Responsible ONLY for HTTP concerns: authentication, body parsing,
 * validation, cache versioning, and response building.
 *
 * Cache versioning logic (version → list → DB fallback) is preserved
 * byte-for-byte from the original inline implementation.
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
  } = deps;

  const ANALYSES_LIST_KEY = 'analyses:list';
  const ANALYSES_VERSION_KEY = 'analyses:version';

  /**
   * Generate a monotonically increasing version number.
   * Uses wall-clock seconds so it survives KV expiration, Worker restarts,
   * and concurrent requests — no shared mutable counter needed.
   */
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
      const numericVersion = Number(cachedVersion);
      if (Number.isFinite(numericVersion)) {
        version = numericVersion;
      }
    }

    if (cachedList) {
      try {
        const parsed = JSON.parse(cachedList);
        if (Array.isArray(parsed)) {
          analyses = parsed;
        }
      } catch {
        analyses = null;
      }
    }

    return { version, analyses };
  }

  async function updateAnalysesCache(env, analyses, version) {
    const cacheTtlSeconds = 86400 * 7;
    await Promise.all([
      writeAppCache(env, ANALYSES_VERSION_KEY, String(version), cacheTtlSeconds),
      writeAppCache(env, ANALYSES_LIST_KEY, JSON.stringify(analyses), cacheTtlSeconds),
    ]);
  }

  // ── Validation ─────────────────────────────────────────────────────────

  function parseAnalysisPayload(originalBody, options = {}, env) {
    const { requireAuthor = false } = options;
    let payload;
    try {
      payload = JSON.parse(originalBody);
    } catch {
      return {
        error: jsonResponse(
          buildBodyFieldValidationError('body', 'json_invalid', 'JSON decode error', null),
          { status: 422 }, env),
      };
    }

    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) {
      return {
        error: jsonResponse(
          buildBodyFieldValidationError('body', 'type_error', 'Input should be a valid object', payload ?? null),
          { status: 422 }, env),
      };
    }

    const validated = {};
    const fieldSpecs = [
      { name: 'coin', required: true, minLength: 1, maxLength: 16 },
      { name: 'timeframe', required: false, defaultValue: '1d', maxLength: 16 },
      { name: 'image', required: false, defaultValue: '', maxLength: 512 },
      { name: 'text', required: true, minLength: 1 },
      ...(requireAuthor ? [{ name: 'author', required: true, minLength: 1, maxLength: 128 }] : []),
    ];

    for (const spec of fieldSpecs) {
      const rawValue = Object.prototype.hasOwnProperty.call(payload, spec.name) ? payload[spec.name] : spec.defaultValue;
      if (typeof rawValue !== 'string') {
        return {
          error: jsonResponse(
            buildBodyFieldValidationError(spec.name, 'string_type', 'Input should be a valid string', rawValue ?? null),
            { status: 422 }, env),
        };
      }
      if (spec.minLength && rawValue.length < spec.minLength) {
        return {
          error: jsonResponse(
            buildBodyFieldValidationError(
              spec.name,
              'string_too_short',
              `String should have at least ${spec.minLength} character${spec.minLength === 1 ? '' : 's'}`,
              rawValue,
              { min_length: spec.minLength },
            ),
            { status: 422 }, env),
        };
      }
      if (spec.maxLength && rawValue.length > spec.maxLength) {
        return {
          error: jsonResponse(
            buildBodyFieldValidationError(
              spec.name,
              'string_too_long',
              `String should have at most ${spec.maxLength} characters`,
              rawValue,
              { max_length: spec.maxLength },
            ),
            { status: 422 }, env),
        };
      }
      validated[spec.name] = rawValue;
    }

    return { payload: validated };
  }

  // ── HTTP Handlers ──────────────────────────────────────────────────────

  /**
   * GET /api/analyses — List analyses with cache versioning.
   *
   * Flow:
   * 1. Parse optional ?version= query param
   * 2. If version provided and matches cache → 304-like (analyses: null, unchanged: true)
   * 3. Otherwise (no version or stale version) → query DB, update cache, return fresh data
   * 4. If DB not configured → return cache or empty fallback
   */
  async function handleList(request, env) {
    const url = new URL(request.url);
    const rawVersion = url.searchParams.get('version');
    let requestedVersion = null;

    if (rawVersion !== null && rawVersion !== '') {
      const numericVersion = Number(rawVersion);
      if (!Number.isInteger(numericVersion)) {
        return jsonResponse(
          buildQueryFieldValidationError('version', 'int_parsing', 'Input should be a valid integer', rawVersion),
          { status: 422 }, env);
      }
      requestedVersion = numericVersion;
    }

    const cachedState = await readCachedAnalysesState(env);

    // ── Path A: Client has a version and it matches cache → unchanged ──
    if (requestedVersion !== null && cachedState.version !== null && requestedVersion === cachedState.version) {
      return jsonResponse({
        status: 'success',
        analyses: null,
        version: cachedState.version,
        unchanged: true,
      }, {}, env);
    }

    // ── Path B: Stale client version (or no version) → must verify against DB ──
    // When requestedVersion is null (fresh app open), we MUST query the DB.
    // KV is eventually consistent (up to 60s propagation). Serving stale KV data
    // on cold open causes analyses to disappear after close+reopen.
    // When requestedVersion is provided but doesn't match, the client has stale
    // data and needs a fresh response from DB.
    if (isDatabaseConfigured(env)) {
      try {
        const analyses = await analysisRepo.list(env);

        // Stable version: reuse cached version when data is unchanged to prevent
        // cascading cache invalidations across concurrent users. Each concurrent
        // fresh-open that generates a new timestamp would invalidate every other
        // client's cached version, forcing redundant DB queries on their next poll.
        const dataUnchanged = cachedState.analyses !== null &&
          cachedState.version !== null &&
          JSON.stringify(analyses) === JSON.stringify(cachedState.analyses);
        const version = dataUnchanged ? cachedState.version : generateVersion();

        await updateAnalysesCache(env, analyses, version);
        return jsonResponse({
          status: 'success',
          analyses,
          version,
        }, {}, env);
      } catch (error) {
        console.warn(safeError('list-analyses', error));
        return safeDbErrorResponse(error, {}, env);
      }
    }

    // DB not configured AND no cache — return error so frontend preserves its cache
    if (cachedState.analyses === null) {
      return jsonResponse(
        { status: 'error', message: 'Database unavailable', analyses: null },
        { status: 503 }, env);
    }
    return jsonResponse({
      status: 'success',
      analyses: cachedState.analyses,
      version: cachedState.version ?? 0,
    }, {}, env);
  }

  /**
   * POST /api/analyses — Create a new analysis (admin only).
   */
  async function handleCreate(request, env) {
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

    const parsed = parseAnalysisPayload(await request.text(), { requireAuthor: true }, env);
    if (parsed.error) {
      return parsed.error;
    }

    try {
      const analysis = await analysisRepo.create(env, authState.user.id, parsed.payload);
      const analyses = await analysisRepo.list(env);
      const version = generateVersion();
      await updateAnalysesCache(env, analyses, version);
      return jsonResponse({ status: 'success', analysis, version }, {}, env);
    } catch (error) {
      console.warn(safeError('create-analysis', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * PUT /api/analyses/:id — Update an analysis (admin only).
   */
  async function handleUpdate(request, env, analysisId) {
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

    const parsed = parseAnalysisPayload(await request.text(), { requireAuthor: false }, env);
    if (parsed.error) {
      return parsed.error;
    }

    try {
      const analysis = await analysisRepo.update(env, analysisId, parsed.payload);
      if (!analysis) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      const analyses = await analysisRepo.list(env);
      const version = generateVersion();
      await updateAnalysesCache(env, analyses, version);
      return jsonResponse({ status: 'success', analysis, version }, {}, env);
    } catch (error) {
      console.warn(safeError('update-analysis', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  /**
   * DELETE /api/analyses/:id — Delete an analysis (admin only).
   */
  async function handleDelete(request, env, analysisId) {
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
      const deleted = await analysisRepo.remove(env, analysisId);
      if (!deleted) {
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, env);
      }
      const analyses = await analysisRepo.list(env);
      const version = generateVersion();
      await updateAnalysesCache(env, analyses, version);
      return jsonResponse({ status: 'success', version }, {}, env);
    } catch (error) {
      console.warn(safeError('delete-analysis', error));
      return safeDbErrorResponse(error, {}, env);
    }
  }

  return Object.freeze({ handleList, handleCreate, handleUpdate, handleDelete });
}
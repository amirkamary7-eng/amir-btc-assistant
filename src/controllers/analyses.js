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

  async function readCurrentAnalysesVersion(env) {
    const cachedState = await readCachedAnalysesState(env);
    return Number.isInteger(cachedState.version) ? cachedState.version : null;
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
   * 3. If no version and cache is warm → return cache directly
   * 4. Otherwise → query DB, update cache, return fresh data
   * 5. If DB not configured → return cache or empty fallback
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
    if (requestedVersion !== null && cachedState.version !== null && requestedVersion === cachedState.version) {
      return jsonResponse({
        status: 'success',
        analyses: null,
        version: cachedState.version,
        unchanged: true,
      }, env);
    }

    if (requestedVersion === null && cachedState.version !== null && cachedState.analyses !== null) {
      return jsonResponse({
        status: 'success',
        analyses: cachedState.analyses,
        version: cachedState.version,
      }, env);
    }

    if (isDatabaseConfigured(env)) {
      try {
        const analyses = await analysisRepo.list(env);
        const version = cachedState.version !== null ? cachedState.version : (analyses.length > 0 ? 1 : 0);
        await updateAnalysesCache(env, analyses, version);
        return jsonResponse({
          status: 'success',
          analyses,
          version,
        }, env);
      } catch (error) {
        console.warn('list analyses failed:', error);
        return safeDbErrorResponse(error, env);
      }
    }

    return jsonResponse({
      status: 'success',
      analyses: cachedState.analyses ?? [],
      version: cachedState.version ?? 0,
    }, env);
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
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, {}, env);
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
      const version = ((await readCurrentAnalysesVersion(env)) ?? 0) + 1;
      await updateAnalysesCache(env, analyses, version);
      return jsonResponse({ status: 'success', analysis, version }, env);
    } catch (error) {
      console.warn('create analysis failed:', error);
      return safeDbErrorResponse(error, env);
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
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, {}, env);
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
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, {}, env);
      }
      const analyses = await analysisRepo.list(env);
      const version = ((await readCurrentAnalysesVersion(env)) ?? 0) + 1;
      await updateAnalysesCache(env, analyses, version);
      return jsonResponse({ status: 'success', analysis, version }, env);
    } catch (error) {
      console.warn('update analysis failed:', error);
      return safeDbErrorResponse(error, env);
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
      return jsonResponse({ detail: 'Admin access required' }, { status: 403 }, {}, env);
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
        return jsonResponse({ status: 'error', message: 'Not found' }, { status: 404 }, {}, env);
      }
      const analyses = await analysisRepo.list(env);
      const version = ((await readCurrentAnalysesVersion(env)) ?? 0) + 1;
      await updateAnalysesCache(env, analyses, version);
      return jsonResponse({ status: 'success', version }, env);
    } catch (error) {
      console.warn('delete analysis failed:', error);
      return safeDbErrorResponse(error, env);
    }
  }

  return Object.freeze({ handleList, handleCreate, handleUpdate, handleDelete });
}
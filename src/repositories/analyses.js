/**
 * Analysis Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to analyses.
 * No HTTP concerns, no cache logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createAnalysisRepository(deps) {
  const { queryDb, normalizeOptionalString } = deps;

  /**
   * Serialize a raw DB row into the API response shape.
   */
  function serializeAnalysisRow(row) {
    const createdAt = row?.created_at ? new Date(row.created_at) : null;
    const updatedAt = row?.updated_at ? new Date(row.updated_at) : null;
    return {
      id: String(row?.id || ''),
      title: normalizeOptionalString(row?.title) || '',
      coin: String(row?.coin || '').toUpperCase(),
      timeframe: normalizeOptionalString(row?.timeframe) || '1d',
      content: String(row?.text || ''),
      image: normalizeOptionalString(row?.image) || '',
      support_level: normalizeOptionalString(row?.support_level) || '',
      current_price: normalizeOptionalString(row?.current_price) || '',
      resistance_level: normalizeOptionalString(row?.resistance_level) || '',
      views_count: Number(row?.views_count || 0),
      featured: Boolean(row?.featured),
      category: normalizeOptionalString(row?.category) || 'crypto',
      author: normalizeOptionalString(row?.author) || '',
      author_id: normalizeOptionalString(row?.author_id),
      date: createdAt ? createdAt.toISOString().slice(0, 10) : '',
      created_at: createdAt ? createdAt.toISOString() : null,
      updated_at: updatedAt ? updatedAt.toISOString() : null,
    };
  }

  /**
   * Ensure new columns exist. Idempotent — safe to call on every Worker startup.
   * NOTE: Schema migrations run ONCE per Worker isolate (cached via _schemaVerified).
   * Running 7 ALTER TABLE queries on every /api/analyses request caused database
   * timeouts because each query needs a fresh connection from the pool, and Neon
   * serverless has cold-start latency on new connections.
   * If the isolate is evicted (cold start), _schemaVerified resets and migration
   * runs again — which is the correct behavior.
   */
  let _schemaVerified = false;
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    // Run ALL ALTER TABLEs in a SINGLE query to avoid 7 separate Pool creations
    const batchSql = `
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS title VARCHAR(256) DEFAULT '';
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS support_level VARCHAR(64) DEFAULT '';
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS current_price VARCHAR(64) DEFAULT '';
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS resistance_level VARCHAR(64) DEFAULT '';
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS views_count INTEGER DEFAULT 0 NOT NULL;
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS featured BOOLEAN DEFAULT FALSE NOT NULL;
      ALTER TABLE analyses ADD COLUMN IF NOT EXISTS category VARCHAR(16) DEFAULT 'crypto' NOT NULL;
    `;
    try {
      await queryDb(env, batchSql);
    } catch (e) {
      console.warn('Analysis schema migration warning:', e.message);
    }
    _schemaVerified = true;
  }

  /**
   * Get featured analyses (up to 5).
   */
  async function getFeatured(env) {
    const result = await queryDb(
      env,
      `SELECT id, coin, timeframe, image, LEFT(text, 250) AS text, title, support_level, current_price, resistance_level, views_count, featured, category, author, author_id, created_at, updated_at
       FROM analyses WHERE featured = TRUE ORDER BY created_at DESC LIMIT 5`,
    );
    return result.rows.length ? result.rows.map(serializeAnalysisRow) : [];
  }

  /**
   * Get stats: active count, today count, total count.
   */
  async function getStats(env) {
    const [totalRes, activeRes, todayRes] = await Promise.all([
      queryDb(env, `SELECT COUNT(*)::int AS cnt FROM analyses`),
      queryDb(env, `SELECT COUNT(*)::int AS cnt FROM analyses WHERE featured IS NOT TRUE OR featured = FALSE`),
      queryDb(env, `SELECT COUNT(*)::int AS cnt FROM analyses WHERE created_at >= CURRENT_DATE`),
    ]);
    const total = Number(totalRes.rows[0]?.cnt || 0);
    const active = Number(activeRes.rows[0]?.cnt || 0);
    const today = Number(todayRes.rows[0]?.cnt || 0);
    return { active, today, total };
  }

  /**
   * List analyses with pagination. Excludes the featured analysis from the list
   * (it's returned separately to avoid duplication).
   */
  async function list(env, page = 1, limit = 20) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.max(1, Math.min(50, Number(limit) || 20));
    const offset = (p - 1) * l;

    const [countRes, dataRes] = await Promise.all([
      queryDb(env, `SELECT COUNT(*)::int AS cnt FROM analyses WHERE featured IS NOT TRUE OR featured = FALSE`),
      queryDb(
        env,
        `SELECT id, coin, timeframe, image, text, title, support_level, current_price, resistance_level, views_count, featured, category, author, author_id, created_at, updated_at
         FROM analyses
         WHERE featured IS NOT TRUE OR featured = FALSE
         ORDER BY created_at DESC
         LIMIT $1 OFFSET $2`,
        [l, offset],
      ),
    ]);

    const total = Number(countRes.rows[0]?.cnt || 0);
    return {
      analyses: dataRes.rows.map((row) => serializeAnalysisRow(row)),
      pagination: { page: p, limit: l, total, hasMore: offset + l < total },
    };
  }

  /**
   * Get a single analysis by ID.
   */
  async function getById(env, analysisId) {
    const result = await queryDb(
      env,
      `SELECT id, coin, timeframe, image, text, title, support_level, current_price, resistance_level, views_count, featured, category, author, author_id, created_at, updated_at
       FROM analyses WHERE id = $1`,
      [String(analysisId)],
    );
    return result.rows.length ? serializeAnalysisRow(result.rows[0]) : null;
  }

  /**
   * Increment views_count for an analysis. Returns new count or null.
   */
  async function incrementViews(env, analysisId) {
    const result = await queryDb(
      env,
      `UPDATE analyses SET views_count = COALESCE(views_count, 0) + 1 WHERE id = $1 RETURNING views_count`,
      [String(analysisId)],
    );
    return result.rows.length ? Number(result.rows[0].views_count) : null;
  }

  /**
   * Set an analysis as featured (up to 5 allowed — controller enforces the limit).
   */
  async function setFeatured(env, analysisId) {
    const result = await queryDb(
      env,
      `UPDATE analyses SET featured = TRUE, updated_at = NOW() WHERE id = $1 RETURNING id`,
      [String(analysisId)],
    );
    return Boolean(result.rows.length);
  }

  /**
   * Unset featured from an analysis.
   */
  async function unsetFeatured(env, analysisId) {
    const result = await queryDb(
      env,
      `UPDATE analyses SET featured = FALSE, updated_at = NOW() WHERE id = $1 AND featured = TRUE RETURNING id`,
      [String(analysisId)],
    );
    return Boolean(result.rows.length);
  }

  /**
   * List ALL analyses (for cache / dashboard slider). No pagination.
   */
  async function listAll(env) {
    const result = await queryDb(
      env,
      `SELECT id, coin, timeframe, image, text, title, support_level, current_price, resistance_level, views_count, featured, category, author, author_id, created_at, updated_at
       FROM analyses ORDER BY created_at DESC`,
    );
    return result.rows.map((row) => serializeAnalysisRow(row));
  }

  /**
   * Insert a new analysis and return the serialized row.
   */
  async function create(env, adminUserId, payload) {
    // NOTE: Featured limit (max 5) is enforced by the controller.
    // The controller may call unsetOldestFeatured() before this if force_featured=true.
    // NOTE: 15 columns, 15 values ($1..$13 + NOW() + NOW())
    const result = await queryDb(
      env,
      `INSERT INTO analyses (id, title, coin, timeframe, image, text, support_level, current_price, resistance_level, featured, category, author, author_id, created_at, updated_at)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, NOW(), NOW())
       RETURNING id, coin, timeframe, image, text, title, support_level, current_price, resistance_level, views_count, featured, category, author, author_id, created_at, updated_at`,
      [
        String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 12),
        normalizeOptionalString(payload.title) || '',
        (normalizeOptionalString(payload.coin) || '').toUpperCase(),
        normalizeOptionalString(payload.timeframe) || '1d',
        normalizeOptionalString(payload.image) || '',
        String(payload.text || ''),
        normalizeOptionalString(payload.support_level) || '',
        normalizeOptionalString(payload.current_price) || '',
        normalizeOptionalString(payload.resistance_level) || '',
        Boolean(payload.featured) ? true : false,
        normalizeOptionalString(payload.category) || 'crypto',
        normalizeOptionalString(payload.author) || '',
        String(adminUserId),
      ],
    );
    return serializeAnalysisRow(result.rows[0]);
  }

  /**
   * Update an existing analysis by ID. Returns null if not found.
   */
  async function update(env, analysisId, payload) {
    // NOTE: Featured limit (max 5) is enforced by the controller.
    const result = await queryDb(
      env,
      `UPDATE analyses
       SET title = $2, coin = $3, timeframe = $4, image = $5, text = $6,
           support_level = $7, current_price = $8, resistance_level = $9,
           featured = COALESCE($10, featured), category = COALESCE($11, category), updated_at = NOW()
       WHERE id = $1
       RETURNING id, coin, timeframe, image, text, title, support_level, current_price, resistance_level, views_count, featured, category, author, author_id, created_at, updated_at`,
      [
        String(analysisId),
        normalizeOptionalString(payload.title) || '',
        (normalizeOptionalString(payload.coin) || '').toUpperCase(),
        normalizeOptionalString(payload.timeframe) || '1d',
        normalizeOptionalString(payload.image) || '',
        String(payload.text || ''),
        normalizeOptionalString(payload.support_level) || '',
        normalizeOptionalString(payload.current_price) || '',
        normalizeOptionalString(payload.resistance_level) || '',
        payload.featured === true ? true : payload.featured === false ? false : null,
        normalizeOptionalString(payload.category) || null,
      ],
    );
    if (!result.rows[0]) return null;
    return serializeAnalysisRow(result.rows[0]);
  }

  /**
   * Delete an analysis by ID. Returns true if a row was deleted.
   */
  async function remove(env, analysisId) {
    const result = await queryDb(
      env,
      `DELETE FROM analyses WHERE id = $1 RETURNING id`,
      [String(analysisId)],
    );
    return Boolean(result.rows[0]);
  }

  /**
   * Count currently featured analyses.
   */
  async function countFeatured(env) {
    const result = await queryDb(env, `SELECT COUNT(*)::int AS cnt FROM analyses WHERE featured = TRUE`);
    return Number(result.rows[0]?.cnt || 0);
  }

  /**
   * Un-feature the oldest featured analysis. Returns the un-featured row or null.
   */
  async function unsetOldestFeatured(env) {
    const result = await queryDb(
      env,
      `UPDATE analyses SET featured = FALSE, updated_at = NOW() WHERE id = (
          SELECT id FROM analyses WHERE featured = TRUE ORDER BY created_at ASC LIMIT 1
        ) AND featured = TRUE RETURNING id`,
    );
    return result.rows.length > 0;
  }

  return Object.freeze({
    ensureSchema,
    getFeatured,
    getStats,
    list,
    listAll,
    getById,
    incrementViews,
    setFeatured,
    unsetFeatured,
    countFeatured,
    unsetOldestFeatured,
    create,
    update,
    remove,
    serializeAnalysisRow,
  });
}
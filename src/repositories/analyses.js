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
      coin: String(row?.coin || '').toUpperCase(),
      timeframe: normalizeOptionalString(row?.timeframe) || '1d',
      image: normalizeOptionalString(row?.image) || '',
      text: String(row?.text || ''),
      author: normalizeOptionalString(row?.author) || '',
      author_id: normalizeOptionalString(row?.author_id),
      date: createdAt ? createdAt.toISOString().slice(0, 10) : '',
      created_at: createdAt ? createdAt.toISOString() : null,
      updated_at: updatedAt ? updatedAt.toISOString() : null,
    };
  }

  /**
   * List all analyses ordered by creation date descending.
   */
  async function list(env) {
    const result = await queryDb(
      env,
      `
        SELECT id, coin, timeframe, image, text, author, author_id, created_at, updated_at
        FROM analyses
        ORDER BY created_at DESC
      `,
    );
    return result.rows.map((row) => serializeAnalysisRow(row));
  }

  /**
   * Insert a new analysis and return the serialized row.
   */
  async function create(env, adminUserId, payload) {
    const result = await queryDb(
      env,
      `
        INSERT INTO analyses (id, coin, timeframe, image, text, author, author_id, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, NOW(), NOW())
        RETURNING id, coin, timeframe, image, text, author, author_id, created_at, updated_at
      `,
      [
        String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 12),
        (normalizeOptionalString(payload.coin) || '').toUpperCase(),
        normalizeOptionalString(payload.timeframe) || '1d',
        normalizeOptionalString(payload.image) || '',
        String(payload.text),
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
    const result = await queryDb(
      env,
      `
        UPDATE analyses
        SET
          coin = $2,
          timeframe = $3,
          image = $4,
          text = $5,
          updated_at = NOW()
        WHERE id = $1
        RETURNING id, coin, timeframe, image, text, author, author_id, created_at, updated_at
      `,
      [
        String(analysisId),
        (normalizeOptionalString(payload.coin) || '').toUpperCase(),
        normalizeOptionalString(payload.timeframe) || '1d',
        normalizeOptionalString(payload.image) || '',
        String(payload.text),
      ],
    );
    if (!result.rows[0]) {
      return null;
    }
    return serializeAnalysisRow(result.rows[0]);
  }

  /**
   * Delete an analysis by ID. Returns true if a row was deleted.
   */
  async function remove(env, analysisId) {
    const result = await queryDb(
      env,
      `
        DELETE FROM analyses
        WHERE id = $1
        RETURNING id
      `,
      [String(analysisId)],
    );
    return Boolean(result.rows[0]);
  }

  return Object.freeze({ list, create, update, remove, serializeAnalysisRow });
}
/**
 * Alert Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to price alerts.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createAlertRepository(deps) {
  const { queryDb, ensureUserRow, normalizeOptionalString } = deps;

  /**
   * Serialize a raw DB row into the API response shape.
   */
  function serializeRow(row) {
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      symbol: String(row.symbol).toUpperCase(),
      price: Number(row.price),
      direction: row.direction,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /**
   * Create a new price alert, or reactivate an existing identical one.
   * Returns the (re)activated alert row.
   */
  async function create(env, userId, payload) {
    const normalizedUserId = String(userId);
    const symbol = (normalizeOptionalString(payload.symbol) || '').toUpperCase();
    const direction = (normalizeOptionalString(payload.direction) || 'above').toLowerCase();
    await ensureUserRow(env, normalizedUserId);

    const existingResult = await queryDb(
      env,
      `
        SELECT id, user_id, symbol, price, direction, created_at
        FROM price_alerts
        WHERE user_id = $1 AND symbol = $2 AND price = $3 AND direction = $4
        LIMIT 1
      `,
      [normalizedUserId, symbol, Number(payload.price), direction],
    );
    const existingRow = existingResult.rows[0] || null;

    if (existingRow) {
      await queryDb(
        env,
        `
          UPDATE price_alerts
          SET status = 'active', triggered_at = NULL, created_at = NOW()
          WHERE id = $1
        `,
        [String(existingRow.id)],
      );
      const refreshedResult = await queryDb(
        env,
        `
          SELECT id, user_id, symbol, price, direction, created_at
          FROM price_alerts
          WHERE id = $1
          LIMIT 1
        `,
        [String(existingRow.id)],
      );
      return serializeRow(refreshedResult.rows[0] || existingRow);
    }

    const insertResult = await queryDb(
      env,
      `
        INSERT INTO price_alerts (id, user_id, symbol, price, direction, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'active', NOW())
        RETURNING id, user_id, symbol, price, direction, created_at
      `,
      [
        String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16),
        normalizedUserId,
        symbol,
        Number(payload.price),
        direction,
      ],
    );
    return serializeRow(insertResult.rows[0]);
  }

  /**
   * List all active price alerts for a user.
   */
  async function list(env, userId) {
    const result = await queryDb(
      env,
      `
        SELECT id, user_id, symbol, price, direction, created_at
        FROM price_alerts
        WHERE user_id = $1 AND status = 'active'
        ORDER BY created_at DESC
      `,
      [String(userId)],
    );
    return result.rows.map((row) => serializeRow(row));
  }

  /**
   * Get a single alert row by ID (for ownership checks).
   */
  async function findById(env, alertId) {
    const result = await queryDb(
      env,
      `
        SELECT id, user_id, symbol, price, direction, created_at
        FROM price_alerts
        WHERE id = $1
        LIMIT 1
      `,
      [String(alertId)],
    );
    return result.rows[0] || null;
  }

  /**
   * Delete an alert by ID — SECURITY: requires user_id ownership check.
   * No user can delete another user's alerts.
   */
  async function remove(env, alertId, userId) {
    await queryDb(env, 'DELETE FROM price_alerts WHERE id = $1 AND user_id = $2', [String(alertId), String(userId)]);
  }

  return Object.freeze({ create, list, findById, remove, serializeRow });
}
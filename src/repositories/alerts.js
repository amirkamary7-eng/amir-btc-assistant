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
   * Ensure price_alerts table + indexes exist.
   * Idempotent — runs CREATE INDEX IF NOT EXISTS on every call.
   *
   * Schema v2 (2026-07-25):
   *   - last_price NUMERIC: last price seen by cron (for cross-detection)
   *   - last_checked_at TIMESTAMPTZ: when cron last checked this alert
   *   - last_trigger_price NUMERIC: price at which alert fired (audit trail)
   *   - triggered_at TIMESTAMPTZ: when alert fired (already existed)
   *
   * Cross-detection works by comparing last_price to current_price against target:
   *   - direction='above': trigger if last_price < target AND current_price >= target
   *     OR (no last_price yet) current_price >= target
   *   - direction='below': trigger if last_price > target AND current_price <= target
   *     OR (no last_price yet) current_price <= target
   *
   * This catches cases where price JUMPED over target between cron runs (gap),
   * and prevents re-triggering when price stays above/below target after first fire.
   *
   * AUDIT-002 FIX: Added idx_price_alerts_status_created for cron query optimization.
   */
  async function ensureTable(env) {
    await queryDb(env, `
      CREATE TABLE IF NOT EXISTS price_alerts (
        id VARCHAR(64) PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        symbol VARCHAR(32) NOT NULL,
        price NUMERIC(24,8) NOT NULL,
        direction VARCHAR(16) NOT NULL DEFAULT 'above',
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        triggered_at TIMESTAMPTZ,
        last_price NUMERIC(24,8),
        last_checked_at TIMESTAMPTZ,
        last_trigger_price NUMERIC(24,8)
      )
    `, []);

    // Schema v2 migration: add new columns if missing (idempotent)
    await queryDb(env, `ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS last_price NUMERIC(24,8)`).catch(() => {});
    await queryDb(env, `ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS last_checked_at TIMESTAMPTZ`).catch(() => {});
    await queryDb(env, `ALTER TABLE price_alerts ADD COLUMN IF NOT EXISTS last_trigger_price NUMERIC(24,8)`).catch(() => {});

    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_price_alerts_user_status ON price_alerts (user_id, status)`, []);
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_price_alerts_dedup ON price_alerts (user_id, symbol, price, direction)`, []);
    // AUDIT-002 FIX: index for the cron query (status='active' ORDER BY created_at DESC)
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_price_alerts_status_created ON price_alerts (status, created_at DESC)`, []);
    // Index for fast lookup by symbol (cron fetches prices per unique symbol)
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_price_alerts_status_symbol ON price_alerts (status, symbol)`, []);
  }

  /**
   * Create a new price alert, or reactivate an existing identical one.
   * Returns the (re)activated alert row.
   */
  async function create(env, userId, payload) {
    await ensureTable(env);
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
    await ensureTable(env);
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

  /**
   * Update last_price + last_checked_at for an alert (called by cron every cycle).
   * Used by cross-detection logic to know what price was seen on the previous run.
   *
   * Atomic UPDATE — no race conditions even with overlapping cron runs.
   */
  async function updateLastChecked(env, alertId, lastPrice) {
    await queryDb(env, `
      UPDATE price_alerts
      SET last_price = $2, last_checked_at = NOW()
      WHERE id = $1
    `, [String(alertId), Number(lastPrice)]);
  }

  /**
   * Mark an alert as triggered (atomic). Sets status, triggered_at, last_trigger_price.
   * This is the "duplicate trigger prevention" — once status='triggered',
   * the cron query (WHERE status='active') will no longer return this alert.
   *
   * Returns true if the row was actually updated (i.e. it was still active),
   * false if another cron run already triggered it (race-condition safe).
   */
  async function markTriggered(env, alertId, triggerPrice) {
    const result = await queryDb(env, `
      UPDATE price_alerts
      SET status = 'triggered',
          triggered_at = NOW(),
          last_trigger_price = $2,
          last_price = $2
      WHERE id = $1 AND status = 'active'
      RETURNING id
    `, [String(alertId), Number(triggerPrice)]);
    return result.rows.length > 0;
  }

  /**
   * Bulk fetch active alerts for cron processing.
   * Selects ONLY the columns the cron needs (no user PII).
   * Returns rows ordered by created_at DESC so newer alerts are checked first.
   */
  async function listActiveForCron(env, limit = 500) {
    await ensureTable(env);
    const result = await queryDb(env, `
      SELECT id, user_id, symbol, price, direction, last_price, last_checked_at
      FROM price_alerts
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT $1
    `, [Number(limit)]);
    return result.rows;
  }

  return Object.freeze({
    create, list, findById, remove, serializeRow, ensureTable,
    updateLastChecked, markTriggered, listActiveForCron,
  });
}
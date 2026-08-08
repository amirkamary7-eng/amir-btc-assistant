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

  // ROOT-CAUSE FIX: _tableEnsured cache — same pattern as notifications.js and
  // users.js. Without this, ensureTable ran 7 queryDb calls on EVERY alertRepo.list()
  // and alertRepo.create() call. Since frontend polls /api/alerts every 15s,
  // this was 7 × 3-5ms = 21-35ms CPU every 15s → exceededResources.
  // With cache: 7 queryDb on first call (cold isolate), 0 on every subsequent call.
  let _tableEnsured = false;

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
    if (_tableEnsured) return;
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

    _tableEnsured = true;
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
    // ROOT-CAUSE FIX: invalidate the 'active alerts exist' cache so the next
    // cron tick knows to query the DB (instead of skipping via cache='0').
    try {
      env.APP_CACHE?.delete?.('alerts:active-exists');
      env.APP_CACHE?.delete?.('alerts:active-list');
    } catch {}

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
      // ROOT CAUSE FIX (Bug 1): When reactivating an existing alert, we MUST
      // reset last_price and last_checked_at to NULL. Previously, these were
      // NOT reset — so if the alert had previously triggered (setting
      // last_price to a value above target), the cross-detection logic on the
      // next cron run would see:
      //   prevPrice >= targetPrice && currentPrice >= targetPrice
      //   && last_checked_at != null
      // → triggerReason = 'still_above_no_retrigger' → NO TRIGGER
      // This caused alerts with targets below current price to NEVER fire
      // when reactivated, even though they should trigger immediately.
      await queryDb(
        env,
        `
          UPDATE price_alerts
          SET status = 'active',
              triggered_at = NULL,
              created_at = NOW(),
              last_price = NULL,
              last_checked_at = NULL,
              last_trigger_price = NULL
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
   *
   * CPU ROOT-CAUSE FIX: ensureTable(env) removed from this hot path.
   * Previously, on a cold isolate, this fired 7 DDL queries
   * (CREATE TABLE + 3 ALTER + 4 CREATE INDEX) costing ~140-245ms CPU,
   * which directly caused `exceededCpu` errors on GET /api/alerts
   * (frontend polls this every 15s).
   *
   * Safety: the price_alerts table is guaranteed to exist in production
   * because:
   *   1. `create()` still calls ensureTable() — first alert creation
   *      ensures schema (idempotent + cached per-isolate via _tableEnsured).
   *   2. Cron's `listActiveForCron()` already runs WITHOUT ensureTable
   *      (see worker-proxy.js:8091-8100) and has been working in production.
   *   3. One-time migration creates the table/indexes.
   *
   * If the table somehow does not exist, the SELECT throws and is caught
   * by safeDbErrorResponse() — graceful 500, no crash.
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
    // ROOT-CAUSE FIX: invalidate the 'active alerts exist' cache.
    try {
      env.APP_CACHE?.delete?.('alerts:active-exists');
      env.APP_CACHE?.delete?.('alerts:active-list');
    } catch {}
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
  async function markTriggered(env, alertId, triggerPrice, pool = null) {
    const result = await queryDb(env, `
      UPDATE price_alerts
      SET status = 'triggered',
          triggered_at = NOW(),
          last_trigger_price = $2,
          last_price = $2
      WHERE id = $1 AND status = 'active'
      RETURNING id
    `, [String(alertId), Number(triggerPrice)], 1, pool);
    // Invalidate alert list cache so next cron tick gets fresh data
    // (triggered alert is no longer 'active' → should be excluded)
    if (result.rows.length > 0) {
      try {
        env.APP_CACHE?.delete?.('alerts:active-exists');
        env.APP_CACHE?.delete?.('alerts:active-list');
      } catch {}
    }
    return result.rows.length > 0;
  }

  /**
   * Bulk fetch active alerts for cron processing.
   * Selects ONLY the columns the cron needs (no user PII).
   * Returns rows ordered by created_at DESC so newer alerts are checked first.
   *
   * NOTE: Does NOT call ensureTable (cron caller is responsible for that).
   * This avoids redundant DDL queries on every 5-min cron tick.
   */
  async function listActiveForCron(env, limit = 500, pool = null) {
    const result = await queryDb(env, `
      SELECT id, user_id, symbol, price, direction, last_price, last_checked_at
      FROM price_alerts
      WHERE status = 'active'
      ORDER BY created_at DESC
      LIMIT $1
    `, [Number(limit)], 1, pool);
    return result.rows;
  }

  return Object.freeze({
    create, list, findById, remove, serializeRow, ensureTable,
    updateLastChecked, markTriggered, listActiveForCron,
  });
}
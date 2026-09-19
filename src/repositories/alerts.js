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

    // BUG 3 FIX (TOCTOU): Replaced the SELECT-then-INSERT pattern with a
    // single atomic INSERT ... ON CONFLICT DO UPDATE. This eliminates the
    // race condition where two concurrent requests both pass the SELECT
    // (no existing) and both INSERT (creating duplicate alerts + double-charge).
    //
    // The ON CONFLICT clause targets the unique partial index
    // idx_price_alerts_dedup_unique ON (user_id, symbol, price, direction)
    // WHERE status = 'active'. If a conflict occurs (another request already
    // created the same active alert), the existing row is reactivated instead
    // of creating a duplicate.
    //
    // The reactivation UPDATE preserves the ROOT CAUSE FIX (Bug 1): it resets
    // last_price and last_checked_at to NULL so reactivated alerts fire
    // immediately if the target has already been crossed.
    //
    // If the unique index doesn't exist yet (pre-migration DB), ON CONFLICT
    // will throw (no unique constraint to conflict on). In that case, we fall
    // back to the old SELECT-then-INSERT pattern (with its known TOCTOU race)
    // to avoid breaking the app before the migration runs.
    const newId = String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
    try {
      const upsertResult = await queryDb(
        env,
        `
          INSERT INTO price_alerts (id, user_id, symbol, price, direction, status, created_at)
          VALUES ($1, $2, $3, $4, $5, 'active', NOW())
          ON CONFLICT (user_id, symbol, price, direction) WHERE status = 'active' DO UPDATE
          SET status = 'active',
              triggered_at = NULL,
              created_at = NOW(),
              last_price = NULL,
              last_checked_at = NULL,
              last_trigger_price = NULL
          RETURNING id, user_id, symbol, price, direction, created_at, (xmax = 0) AS inserted
        `,
        [newId, normalizedUserId, symbol, Number(payload.price), direction],
      );
      const row = upsertResult.rows[0];
      const wasInserted = row?.inserted === true || row?.inserted === 't' || row?.inserted === 1;
      return { ...serializeRow(row), reactivated: !wasInserted };
    } catch (conflictErr) {
      // ON CONFLICT ON CONSTRAINT failed — the unique index may not exist yet
      // (pre-migration). Fall back to the old pattern. This is safe for single
      // requests but retains the TOCTOU race for concurrent requests until the
      // migration runs. Log prominently so the operator knows to run the migration.
      if (String(conflictErr?.message || '').includes('idx_price_alerts_dedup_unique') ||
          String(conflictErr?.message || '').includes('ON CONFLICT') ||
          String(conflictErr?.message || '').includes('no unique') ||
          String(conflictErr?.message || '').includes('conflict target')) {
        console.warn('[alerts] ON CONFLICT failed — unique index may not exist yet. Falling back to SELECT-INSERT (TOCTOU race possible). Run migration to create idx_price_alerts_dedup_unique.');
      } else {
        throw conflictErr; // Re-throw unexpected errors
      }
    }

    // Fallback: old SELECT-then-INSERT pattern (pre-migration)
    const existingResult = await queryDb(
      env,
      `
        SELECT id, user_id, symbol, price, direction, created_at
        FROM price_alerts
        WHERE user_id = $1 AND symbol = $2 AND price = $3 AND direction = $4
          AND status = 'active'
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
      return { ...serializeRow(refreshedResult.rows[0] || existingRow), reactivated: true };
    }

    const insertResult = await queryDb(
      env,
      `
        INSERT INTO price_alerts (id, user_id, symbol, price, direction, status, created_at)
        VALUES ($1, $2, $3, $4, $5, 'active', NOW())
        RETURNING id, user_id, symbol, price, direction, created_at
      `,
      [newId, normalizedUserId, symbol, Number(payload.price), direction],
    );
    return { ...serializeRow(insertResult.rows[0]), reactivated: false };
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
   * H5-HIGH FIX: Bulk CAS markTriggered — claim multiple alerts in a SINGLE
   * DB UPDATE, preserving all per-alert semantics of markTriggered:
   *   - status = 'triggered' (atomic transition)
   *   - triggered_at = NOW()
   *   - last_trigger_price = per-alert (preserved via CASE WHEN)
   *   - last_price = per-alert (preserved via CASE WHEN, same as last_trigger_price)
   *   - CAS: WHERE id IN (...) AND status = 'active' (only alerts still active
   *     are claimed; alerts already triggered by another cron are NOT claimed)
   *
   * RETURNS: array of { alertId, claimed, triggerPrice }
   *   - claimed: true if this invocation's UPDATE returned the alert's id
   *     (i.e. it was still 'active' and we won the CAS race)
   *   - claimed: false if the alert was already triggered by another invocation
   *     (caller must skip notification creation for this alert to prevent duplicates)
   *
   * NO per-alert KV deletes (consolidated to a single delete at end of cron by
   * the caller — see runScheduledAlertsBaseline). The original markTriggered's
   * 2 KV deletes per alert would amplify to 2N KV ops for N triggers; this bulk
   * version eliminates that, with the trade-off that the alerts:active-list KV
   * cache may be stale by ~60s (until next tick's TTL expiry or caller's
   * explicit delete). This is safe — CAS in DB still prevents duplicate
   * triggers; the staleness only means cached alerts:active-list may include
   * the triggered alert for ≤60s, but the next cron tick's markTriggeredBulk
   * will return claimed=false for it (CAS guard).
   *
   * Mirrors the bulk UPDATE pattern at worker-proxy.js:13531 (CASE WHEN for
   * per-row last_price), adapted for triggered_at + last_trigger_price +
   * last_price + status in a single UPDATE.
   */
  async function markTriggeredBulk(env, triggers, pool = null) {
    if (!triggers || triggers.length === 0) return [];

    try {
      // Build CASE WHEN for last_trigger_price (and last_price, which mirrors it)
      // Pattern matches worker-proxy.js:13521-13531 bulk last_price UPDATE.
      const caseParts = [];
      const params = [];
      const idPlaceholders = [];
      for (const { alertId, triggerPrice } of triggers) {
        const idIdx = params.length + 1;
        const priceIdx = params.length + 2;
        caseParts.push(`WHEN $${idIdx} THEN $${priceIdx}::numeric`);
        params.push(String(alertId), Number(triggerPrice));
        idPlaceholders.push(`$${idIdx}`);
      }
      const caseWhen = `CASE id ${caseParts.join(' ')} END`;
      const bulkSql = `
        UPDATE price_alerts
        SET status = 'triggered',
            triggered_at = NOW(),
            last_trigger_price = ${caseWhen},
            last_price = ${caseWhen}
        WHERE id IN (${idPlaceholders.join(',')}) AND status = 'active'
        RETURNING id
      `;
      const result = await queryDb(env, bulkSql, params, 1, pool);

      // Build claimed set from RETURNING ids
      const claimedIds = new Set((result.rows || []).map(r => String(r.id)));
      return triggers.map(t => ({
        alertId: t.alertId,
        claimed: claimedIds.has(String(t.alertId)),
        triggerPrice: t.triggerPrice,
      }));
    } catch (e) {
      console.warn('[ALERTS] markTriggeredBulk failed:', e?.message);
      // On failure, return ALL as not-claimed so caller skips notification creation.
      // This is fail-safe: no duplicate notifications, no notifications on a failed
      // CAS. The alerts remain 'active' in DB; the next cron tick will retry.
      return triggers.map(t => ({
        alertId: t.alertId,
        claimed: false,
        triggerPrice: t.triggerPrice,
      }));
    }
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
    markTriggered, markTriggeredBulk, listActiveForCron,
  });
}
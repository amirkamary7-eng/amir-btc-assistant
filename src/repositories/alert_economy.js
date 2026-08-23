/**
 * Alert Economy Repository — Quota System + Service Config
 *
 * Manages:
 * - alert_quota: per-user daily quota tracking (UTC reset)
 * - alert_config: global alert service configuration (free alerts, cost, enabled)
 *
 * Quota model:
 *   Each user gets N free alerts per day per alert type.
 *   After free quota exhausted, each extra alert costs M AB tokens.
 *   Quota resets at Tehran midnight (M5-C FIX — was UTC, resetting at 03:30
 *   Tehran; now uses the shared getTehranDateString helper).
 *
 * M5-A FIX: claimFreeSlot() atomically decides free-vs-paid at the DB level
 * (conditional upsert) so concurrent requests cannot all pass as free.
 * releaseFreeSlot() gives back a claimed slot when creation fails or the
 * alert turns out to be a reactivation.
 */

export function createAlertEconomyRepository(deps) {
  const {
    queryDb,
    isDatabaseConfigured,
    isoDate,
    normalizeOptionalString,
    // M5-C FIX: quota dates use the shared Tehran date helper (same boundary
    // as daily claims / missions). Fallback = UTC for standalone callers that
    // don't inject it (worker-proxy injects the real helper).
    getTehranDateString: _getTehranDateString = () => new Date().toISOString().slice(0, 10),
  } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    if (_schemaVerified) return;
    if (!isDatabaseConfigured(env)) { _schemaVerified = true; return; }

    try {
      // Alert quota table — per-user daily usage tracking
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS alert_quota (
          id SERIAL PRIMARY KEY,
          user_id TEXT NOT NULL,
          alert_type VARCHAR(32) NOT NULL DEFAULT 'price_alert',
          used_count INTEGER NOT NULL DEFAULT 0,
          quota_date DATE NOT NULL DEFAULT CURRENT_DATE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          UNIQUE(user_id, alert_type, quota_date)
        )
      `);

      // Alert config table — global settings (single row per alert_type)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS alert_config (
          alert_type VARCHAR(32) PRIMARY KEY,
          is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
          free_per_day INTEGER NOT NULL DEFAULT 3,
          cost_per_extra INTEGER NOT NULL DEFAULT 5,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // PHASE 3: Add premium_free_per_day column (idempotent).
      await queryDb(env, `ALTER TABLE alert_config ADD COLUMN IF NOT EXISTS premium_free_per_day INTEGER NOT NULL DEFAULT 10`).catch(() => {});

      // Indexes
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_alert_quota_user_date ON alert_quota (user_id, alert_type, quota_date)`).catch(() => {});

      // Seed default configs
      await queryDb(env, `
        INSERT INTO alert_config (alert_type, is_enabled, free_per_day, cost_per_extra) VALUES
          ('price_alert', TRUE, 3, 5),
          ('calendar_alert', FALSE, 3, 5),
          ('breaking_news', FALSE, 3, 5)
        ON CONFLICT (alert_type) DO NOTHING
      `);

      _schemaVerified = true;
    } catch (e) {
      console.warn('Alert Economy schema migration warning:', e.message);
      _schemaVerified = true;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CONFIG (admin-managed)
  // ═══════════════════════════════════════════════════════════

  async function getConfig(env, alertType) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultConfig(alertType);
    try {
      const result = await queryDb(env, `SELECT * FROM alert_config WHERE alert_type = $1`, [String(alertType)]);
      return result.rows[0] ? _mapConfig(result.rows[0]) : _defaultConfig(alertType);
    } catch { return _defaultConfig(alertType); }
  }

  async function getAllConfigs(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [_defaultConfig('price_alert'), _defaultConfig('calendar_alert'), _defaultConfig('breaking_news')];
    try {
      const result = await queryDb(env, `SELECT * FROM alert_config ORDER BY alert_type`);
      // Ensure all 3 types exist
      const types = ['price_alert', 'calendar_alert', 'breaking_news'];
      for (const t of types) {
        if (!result.rows.find(r => r.alert_type === t)) {
          await queryDb(env, `INSERT INTO alert_config (alert_type) VALUES ($1) ON CONFLICT DO NOTHING`, [t]);
        }
      }
      const result2 = await queryDb(env, `SELECT * FROM alert_config ORDER BY alert_type`);
      return result2.rows.map(_mapConfig);
    } catch {
      return [_defaultConfig('price_alert'), _defaultConfig('calendar_alert'), _defaultConfig('breaking_news')];
    }
  }

  async function updateConfig(env, alertType, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultConfig(alertType);
    const fields = ['is_enabled', 'free_per_day', 'cost_per_extra'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(f === 'is_enabled' ? !!updates[f] : Number(updates[f]));
      }
    }
    // Upsert
    await queryDb(env, `INSERT INTO alert_config (alert_type) VALUES ($${idx}) ON CONFLICT (alert_type) DO NOTHING`, [String(alertType)]);
    params.push(String(alertType));
    const result = await queryDb(env, `UPDATE alert_config SET ${setClauses.join(', ')} WHERE alert_type = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapConfig(result.rows[0]) : _defaultConfig(alertType);
  }

  function _defaultConfig(alertType) {
    return { alert_type: alertType, is_enabled: alertType === 'price_alert', free_per_day: 3, premium_free_per_day: 10, cost_per_extra: 5 };
  }

  function _mapConfig(r) {
    return {
      alert_type: r.alert_type,
      is_enabled: r.is_enabled,
      free_per_day: Number(r.free_per_day),
      premium_free_per_day: Number(r.premium_free_per_day != null ? r.premium_free_per_day : 10),
      cost_per_extra: Number(r.cost_per_extra),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // QUOTA (per-user daily)
  // ═══════════════════════════════════════════════════════════

  /**
   * Check if user can create an alert, and how much it costs.
   * PHASE 3: Now accepts optional isPremium parameter. When true, uses
   * premium_free_per_day instead of free_per_day.
   * FAIL-SAFE: If isPremium is not true, Normal quota is used.
   *
   * @param {object} env
   * @param {string} userId
   * @param {string} alertType
   * @param {boolean} [isPremium=false]
   */
  async function checkQuota(env, userId, alertType, isPremium) {
    await ensureSchema(env);
    const config = await getConfig(env, alertType);

    if (!config.is_enabled) {
      return { allowed: false, reason: 'SERVICE_DISABLED', config };
    }

    // PHASE 3: Pick the effective free quota based on tier.
    const effectiveFreePerDay = (isPremium === true)
      ? (config.premium_free_per_day || config.free_per_day)
      : config.free_per_day;

    if (!isDatabaseConfigured(env)) {
      return { allowed: true, isFree: true, costInTokens: 0, usedToday: 0, freeRemaining: effectiveFreePerDay, effectiveFreePerDay, config };
    }

    try {
      const today = _getTehranDateString();
      const result = await queryDb(env, `
        SELECT used_count FROM alert_quota
        WHERE user_id = $1 AND alert_type = $2 AND quota_date = $3
      `, [String(userId), String(alertType), today]);

      const usedToday = Number(result.rows[0]?.used_count || 0);
      const freeRemaining = Math.max(0, effectiveFreePerDay - usedToday);
      const isFree = freeRemaining > 0;
      const costInTokens = isFree ? 0 : config.cost_per_extra;

      return {
        allowed: true,
        isFree,
        costInTokens,
        usedToday,
        freeRemaining,
        effectiveFreePerDay,
        config,
      };
    } catch {
      return { allowed: true, isFree: true, costInTokens: 0, usedToday: 0, freeRemaining: config.free_per_day, effectiveFreePerDay, config };
    }
  }

  /**
   * M5-A FIX: Atomically claim one free quota slot.
   *
   * The conditional upsert increments used_count ONLY when a free slot is
   * still available (used_count < freeLimit). This is the single decision
   * point for free-vs-paid — concurrent requests serialize at the row level,
   * so with one slot left exactly ONE request claims it and the others must
   * pay. Compare: the old checkQuota→create→incrementQuota chain let every
   * concurrent request read the stale free-remaining and all pass as free.
   *
   * INSERT path: first usage of the day (claims when freeLimit > 0).
   * CONFLICT path: used_count < freeLimit → +1 (claimed); otherwise the
   * WHERE fails, no row is returned → NOT claimed (paid path).
   *
   * @returns {Promise<{claimed: boolean, usedNow: number}>}
   */
  async function claimFreeSlot(env, userId, alertType, freeLimit) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { claimed: true, usedNow: 0 };
    const limit = Math.max(0, Number(freeLimit) || 0);
    try {
      const today = _getTehranDateString();
      const result = await queryDb(env, `
        INSERT INTO alert_quota (user_id, alert_type, quota_date, used_count, updated_at)
        SELECT $1, $2, $3::date, 1, NOW() WHERE $4::int > 0
        ON CONFLICT (user_id, alert_type, quota_date) DO UPDATE
          SET used_count = alert_quota.used_count + 1, updated_at = NOW()
          WHERE alert_quota.used_count < $4::int
        RETURNING used_count
      `, [String(userId), String(alertType), today, limit]);
      const usedNow = Number(result.rows[0]?.used_count || 0);
      return { claimed: result.rows.length > 0, usedNow };
    } catch {
      // Fail-open to free: mirrors checkQuota's read-failure behavior
      // (DB unavailable → don't block or charge the user).
      return { claimed: true, usedNow: 0 };
    }
  }

  /**
   * M5-A FIX: Give back a claimed free slot (failed creation / reactivation).
   * Conditional decrement — can never take used_count below zero.
   */
  async function releaseFreeSlot(env, userId, alertType) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return;
    try {
      const today = _getTehranDateString();
      await queryDb(env, `
        UPDATE alert_quota SET used_count = used_count - 1, updated_at = NOW()
        WHERE user_id = $1 AND alert_type = $2 AND quota_date = $3::date AND used_count > 0
      `, [String(userId), String(alertType), today]);
    } catch (e) {
      console.warn('Alert quota release error:', e.message);
    }
  }

  /**
   * Increment quota usage after successful alert creation.
   * Called AFTER the alert is created and (if needed) tokens are debited.
   */
  async function incrementQuota(env, userId, alertType) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return;
    try {
      const today = _getTehranDateString();
      await queryDb(env, `
        INSERT INTO alert_quota (user_id, alert_type, used_count, quota_date, updated_at)
        VALUES ($1, $2, 1, $3::date, NOW())
        ON CONFLICT (user_id, alert_type, quota_date)
        DO UPDATE SET used_count = alert_quota.used_count + 1, updated_at = NOW()
      `, [String(userId), String(alertType), today]);
    } catch (e) {
      console.warn('Alert quota increment error:', e.message);
    }
  }

  /**
   * Get quota status for a user (for UI display).
   * FIX: now accepts isPremium parameter to compute the correct free quota
   * (premium_free_per_day for premium users, free_per_day for normal).
   */
  async function getQuotaStatus(env, userId, alertType, isPremium) {
    await ensureSchema(env);
    const config = await getConfig(env, alertType);
    const effectiveFreePerDay = (isPremium === true)
      ? (config.premium_free_per_day || config.free_per_day)
      : config.free_per_day;
    if (!isDatabaseConfigured(env)) return { usedToday: 0, freeRemaining: effectiveFreePerDay, config };
    try {
      const today = _getTehranDateString();
      const result = await queryDb(env, `SELECT used_count FROM alert_quota WHERE user_id = $1 AND alert_type = $2 AND quota_date = $3`, [String(userId), String(alertType), today]);
      const usedToday = Number(result.rows[0]?.used_count || 0);
      return { usedToday, freeRemaining: Math.max(0, effectiveFreePerDay - usedToday), config };
    } catch {
      return { usedToday: 0, freeRemaining: effectiveFreePerDay, config };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYTICS (admin dashboard)
  // ═══════════════════════════════════════════════════════════

  async function getDashboard(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _emptyDashboard();
    try {
      const [activeAlerts, triggeredToday, quotaUsed, paidAlerts, abSpent] = await Promise.all([
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM price_alerts WHERE status = 'active'`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM price_alerts WHERE status = 'triggered' AND triggered_at >= CURRENT_DATE`),
        queryDb(env, `SELECT COALESCE(SUM(used_count), 0)::int AS cnt FROM alert_quota WHERE quota_date = CURRENT_DATE`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM token_transactions WHERE tx_type = 'alert_debit' AND created_at >= CURRENT_DATE`),
        queryDb(env, `SELECT COALESCE(SUM(amount), 0)::int AS total FROM token_transactions WHERE tx_type = 'alert_debit' AND created_at >= CURRENT_DATE`),
      ]);
      const configs = await getAllConfigs(env);

      return {
        active_alerts: Number(activeAlerts.rows[0]?.cnt || 0),
        triggered_today: Number(triggeredToday.rows[0]?.cnt || 0),
        quota_used_today: Number(quotaUsed.rows[0]?.cnt || 0),
        paid_alerts_today: Number(paidAlerts.rows[0]?.cnt || 0),
        ab_spent_today: Math.abs(Number(abSpent.rows[0]?.total || 0)),
        services: configs,
      };
    } catch {
      return _emptyDashboard();
    }
  }

  function _emptyDashboard() {
    return { active_alerts: 0, triggered_today: 0, quota_used_today: 0, paid_alerts_today: 0, ab_spent_today: 0, services: [] };
  }

  return Object.freeze({
    ensureSchema,
    getConfig,
    getAllConfigs,
    updateConfig,
    checkQuota,
    claimFreeSlot,
    releaseFreeSlot,
    incrementQuota,
    getQuotaStatus,
    getDashboard,
  });
}

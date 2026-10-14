/**
 * Campaigns Repository — Database Layer (Exchange Campaigns, Stage 5B)
 * =====================================================================
 *
 * Owns the two user-facing promo campaign tables:
 *   - promo_campaigns: bilingual campaign content + lifecycle status + window
 *   - promo_campaign_registrations: one row per (campaign_id, telegram_id)
 *
 * NAMING (deliberate — do NOT reuse or touch):
 *   - `campaigns` is the reward_center config table (wheel/referral/mission
 *     boosters) owned by src/repositories/reward_center.js — never read or
 *     written here.
 *   - `exchange_campaigns` is a dead legacy table (zero code references) —
 *     never read, written, or migrated here.
 *
 * Concurrency contract (registerUser):
 *   A single atomic statement guarantees, with NO read-then-write gap:
 *     1. A registration row can only be inserted while the campaign row
 *        snapshot is PUBLISHED and inside [starts_at, ends_at) at DB time
 *        (NOW() — UTC on the Postgres server).
 *     2. The UNIQUE (campaign_id, telegram_id) constraint + ON CONFLICT DO
 *        NOTHING makes duplicate registration impossible, including two
 *        concurrent register requests from the same user (race-safe without
 *        any advisory lock).
 *   A STOP/END that commits AFTER our statement snapshot may still allow the
 *   insert (read-committed semantics) — acceptable by design: the user
 *   registered while the campaign was live, within one atomic statement, and
 *   no second row can ever exist.
 *
 * There is NO KV cache in this module (Stage 5B decision): campaign rows are
 * read via one indexed SELECT per request; the per-user `registered` flag
 * makes shared-response caching incorrect anyway.
 */

export function createCampaignsRepository(deps) {
  const { queryDb, isDatabaseConfigured } = deps;

  let _schemaVerified = false;

  // Mirrors scripts/00-migrate.sql (SECTION 3 + FK section + trigger) so that
  // a dev environment without the migration applied self-provisions. In
  // production runtime DDL is skipped — tables are provisioned by the
  // migration file only (production DDL-skip pattern, see the regression suites).
  const SCHEMA_SQL = `
    CREATE TABLE IF NOT EXISTS promo_campaigns (
      id          TEXT PRIMARY KEY DEFAULT gen_random_uuid()::text,
      title_fa    TEXT NOT NULL,
      title_en    TEXT NOT NULL,
      summary_fa  TEXT,
      summary_en  TEXT,
      body_fa     TEXT NOT NULL DEFAULT '',
      body_en     TEXT NOT NULL DEFAULT '',
      image_url   TEXT,
      starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at     TIMESTAMPTZ,
      status      TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'PUBLISHED', 'STOPPED', 'DELETED')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    CREATE INDEX IF NOT EXISTS idx_promo_campaigns_list
      ON promo_campaigns (starts_at DESC) WHERE status IN ('PUBLISHED', 'STOPPED');

    CREATE TABLE IF NOT EXISTS promo_campaign_registrations (
      id            SERIAL PRIMARY KEY,
      campaign_id   TEXT NOT NULL REFERENCES promo_campaigns(id),
      telegram_id   VARCHAR(64) NOT NULL REFERENCES users(telegram_id),
      registered_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      UNIQUE (campaign_id, telegram_id)
    );

    CREATE INDEX IF NOT EXISTS idx_pcr_user
      ON promo_campaign_registrations (telegram_id);
  `;

  /**
   * Dev/self-provision only. Never runs runtime DDL in production
   * (production DDL-skip pattern — see tests/batch-prod-ddl-skip-test.cjs).
   * The flag is set ONLY on success (schema-verified-regression-test pattern).
   */
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    // PROD-DDL-SKIP: tables provisioned by migrations; skip runtime DDL in production.
    if (env && String(env.APP_ENV || '').toLowerCase() === 'production') {
      _schemaVerified = true;
      return;
    }
    if (!isDatabaseConfigured(env)) { _schemaVerified = true; return; }
    await queryDb(env, SCHEMA_SQL); // errors propagate; flag stays false → retry next call
    _schemaVerified = true;
  }

  // ── Row mapping ───────────────────────────────────────────────────────────

  /** TIMESTAMPTZ values arrive as Date (pg Pool) or ISO string (neon HTTP). */
  function _iso(value) {
    if (value === null || value === undefined) return null;
    if (value instanceof Date) return value.toISOString();
    const s = String(value);
    return s ? s : null;
  }

  function _rowToCampaign(row) {
    return {
      id: String(row.id),
      title_fa: row.title_fa || '',
      title_en: row.title_en || '',
      summary_fa: row.summary_fa || null,
      summary_en: row.summary_en || null,
      body_fa: row.body_fa || '',
      body_en: row.body_en || '',
      image_url: row.image_url || null,
      starts_at: _iso(row.starts_at),
      ends_at: _iso(row.ends_at),
      status: row.status,
      registered: Boolean(row.registered),
      registered_at: _iso(row.registered_at),
    };
  }

  // ── User-facing reads ─────────────────────────────────────────────────────

  const _SELECT_COLUMNS = `
    c.id, c.title_fa, c.title_en, c.summary_fa, c.summary_en,
    c.body_fa, c.body_en, c.image_url, c.starts_at, c.ends_at,
    c.status, (r.id IS NOT NULL) AS registered, r.registered_at
  `;

  /**
   * List visible campaigns (PUBLISHED + STOPPED only — DRAFT/DELETED never
   * leave the server), newest first, with the caller's registration flag.
   */
  async function listVisibleCampaigns(env, telegramId, limit = 50) {
    const result = await queryDb(
      env,
      `
        SELECT ${_SELECT_COLUMNS}
          FROM promo_campaigns c
          LEFT JOIN promo_campaign_registrations r
                 ON r.campaign_id = c.id AND r.telegram_id = $1
         WHERE c.status IN ('PUBLISHED', 'STOPPED')
         ORDER BY c.starts_at DESC, c.created_at DESC
         LIMIT $2
      `,
      [String(telegramId), Math.max(1, Math.min(200, Number(limit) || 50))],
    );
    return (result.rows || []).map(_rowToCampaign);
  }

  /** Detail for one visible campaign + the caller's registration flag. */
  async function getVisibleCampaignById(env, campaignId, telegramId) {
    const result = await queryDb(
      env,
      `
        SELECT ${_SELECT_COLUMNS}
          FROM promo_campaigns c
          LEFT JOIN promo_campaign_registrations r
                 ON r.campaign_id = c.id AND r.telegram_id = $2
         WHERE c.id = $1
           AND c.status IN ('PUBLISHED', 'STOPPED')
         LIMIT 1
      `,
      [String(campaignId), String(telegramId)],
    );
    const row = (result.rows || [])[0];
    return row ? _rowToCampaign(row) : null;
  }

  // ── Registration (atomic) ──────────────────────────────────────────────────

  /**
   * ATOMIC registration. Single statement — no read-then-write race:
   *   - the EXISTS subquery gates on PUBLISHED + in-window at DB time (UTC);
   *   - ON CONFLICT (campaign_id, telegram_id) DO NOTHING collapses duplicate
   *     or concurrent requests into a no-op;
   *   - RETURNING gives the inserted row when this call created it.
   *
   * Returns { inserted: true, row: { id, registered_at } } on insert,
   *         { inserted: false, row: null } when nothing was inserted
   *         (duplicate OR campaign not registerable — caller disambiguates
   *         via isRegistered + getCampaignForGate).
   */
  async function registerUser(env, campaignId, telegramId) {
    const result = await queryDb(
      env,
      `
        INSERT INTO promo_campaign_registrations (campaign_id, telegram_id)
        SELECT $1, $2
         WHERE EXISTS (
               SELECT 1
                 FROM promo_campaigns c
                WHERE c.id = $1
                  AND c.status = 'PUBLISHED'
                  AND c.starts_at <= NOW()
                  AND (c.ends_at IS NULL OR c.ends_at > NOW())
         )
        ON CONFLICT (campaign_id, telegram_id) DO NOTHING
        RETURNING id, registered_at
      `,
      [String(campaignId), String(telegramId)],
    );
    const row = (result.rows || [])[0];
    return row
      ? { inserted: true, row: { id: row.id, registered_at: _iso(row.registered_at) } }
      : { inserted: false, row: null };
  }

  /** Existing registration row for (campaign, user) or null. */
  async function isRegistered(env, campaignId, telegramId) {
    const result = await queryDb(
      env,
      `
        SELECT id, registered_at
          FROM promo_campaign_registrations
         WHERE campaign_id = $1
           AND telegram_id = $2
         LIMIT 1
      `,
      [String(campaignId), String(telegramId)],
    );
    const row = (result.rows || [])[0];
    return row ? { id: row.id, registered_at: _iso(row.registered_at) } : null;
  }

  /**
   * Campaign row in ANY status (for error mapping after a no-op insert).
   * Never returned to the client — used only to map to the right error code.
   */
  async function getCampaignForGate(env, campaignId) {
    const result = await queryDb(
      env,
      `
        SELECT id, status, starts_at, ends_at
          FROM promo_campaigns
         WHERE id = $1
         LIMIT 1
      `,
      [String(campaignId)],
    );
    const row = (result.rows || [])[0];
    return row
      ? { id: String(row.id), status: row.status, starts_at: _iso(row.starts_at), ends_at: _iso(row.ends_at) }
      : null;
  }

  return {
    ensureSchema,
    listVisibleCampaigns,
    getVisibleCampaignById,
    registerUser,
    isRegistered,
    getCampaignForGate,
  };
}

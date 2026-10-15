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
      registration_url TEXT,
      starts_at   TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      ends_at     TIMESTAMPTZ,
      status      TEXT NOT NULL DEFAULT 'DRAFT'
                  CHECK (status IN ('DRAFT', 'PUBLISHED', 'STOPPED', 'DELETED')),
      created_at  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
      updated_at  TIMESTAMPTZ NOT NULL DEFAULT NOW()
    );

    ALTER TABLE promo_campaigns ADD COLUMN IF NOT EXISTS registration_url TEXT;

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
      registration_url: row.registration_url || null,
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
    c.body_fa, c.body_en, c.image_url, c.registration_url,
    c.starts_at, c.ends_at,
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

  // ── Admin operations (Stage 6B) ───────────────────────────────────────────
  //
  // Contract notes:
  //   - Admin reads see ALL statuses (incl. DRAFT/DELETED) — the user-facing
  //     functions above are the ONLY paths that can leak rows to users, and
  //     they hard-filter to PUBLISHED/STOPPED.
  //   - DELETE is SOFT only (status → 'DELETED'); registrations are never
  //     cascade-removed (FKs have no CASCADE) and the terminal DELETED state
  //     is enforced atomically in SQL (`AND status <> 'DELETED'` guards).
  //   - Every dynamic value is parameterized ($n); the only literals ever
  //     interpolated into SQL are hard-coded column names from a fixed
  //     whitelist (UPDATABLE_COLUMNS below) and the NOW()/NULL literals
  //     allowed by _newSetBuilder.
  //   - The status CHECK constraint on the table remains the final authority:
  //     only DRAFT/PUBLISHED/STOPPED/DELETED can ever be stored.

  const _ADMIN_SELECT_COLUMNS = `
    c.id, c.title_fa, c.title_en, c.summary_fa, c.summary_en,
    c.body_fa, c.body_en, c.image_url, c.registration_url,
    c.starts_at, c.ends_at,
    c.status, c.created_at, c.updated_at,
    (SELECT COUNT(*)::int FROM promo_campaign_registrations r
      WHERE r.campaign_id = c.id) AS registration_count
  `;

  function _rowToAdminCampaign(row) {
    return {
      id: String(row.id),
      title_fa: row.title_fa || '',
      title_en: row.title_en || '',
      summary_fa: row.summary_fa || null,
      summary_en: row.summary_en || null,
      body_fa: row.body_fa || '',
      body_en: row.body_en || '',
      image_url: row.image_url || null,
      registration_url: row.registration_url || null,
      starts_at: _iso(row.starts_at),
      ends_at: _iso(row.ends_at),
      status: row.status,
      created_at: _iso(row.created_at),
      updated_at: _iso(row.updated_at),
      registration_count: Number(row.registration_count || 0),
    };
  }

  /**
   * Paginated admin list across ALL statuses with per-campaign registration
   * counts. `status` is optional (controller whitelists it before we see it;
   * it is bound as a parameter regardless). `search` matches title_fa/title_en
   * case-insensitively (LIKE-wildcards inside the term are matched literally
   * enough for an admin search box; the term is bound, never concatenated).
   */
  async function listCampaignsAdmin(env, { status, search, page, limit } = {}) {
    const pg = Math.max(1, Math.min(10000, Number(page) || 1));
    const lim = Math.max(1, Math.min(100, Number(limit) || 20));
    const where = [];
    const values = [];
    if (status) {
      values.push(String(status));
      where.push(`c.status = $${values.length}`);
    }
    if (search) {
      values.push(`%${String(search).slice(0, 100)}%`);
      where.push(`(c.title_fa ILIKE $${values.length} OR c.title_en ILIKE $${values.length})`);
    }
    const whereClause = where.length ? `WHERE ${where.join(' AND ')}` : '';
    const offset = (pg - 1) * lim;
    const countSql = `SELECT COUNT(*)::int AS total FROM promo_campaigns c ${whereClause}`;
    const dataSql = `
      SELECT ${_ADMIN_SELECT_COLUMNS}
        FROM promo_campaigns c
        ${whereClause}
       ORDER BY c.created_at DESC, c.id DESC
       LIMIT $${values.length + 1} OFFSET $${values.length + 2}
    `;
    const [countResult, dataResult] = await Promise.all([
      queryDb(env, countSql, values.slice()),
      queryDb(env, dataSql, values.concat([lim, offset])),
    ]);
    const total = Number(countResult.rows[0]?.total || 0);
    return {
      items: (dataResult.rows || []).map(_rowToAdminCampaign),
      total,
      page: pg,
      limit: lim,
      totalPages: Math.max(1, Math.ceil(total / lim)),
    };
  }

  /** Campaign in ANY status (admin view) + registration count, or null. */
  async function getCampaignById(env, campaignId) {
    const result = await queryDb(
      env,
      `
        SELECT ${_ADMIN_SELECT_COLUMNS}
          FROM promo_campaigns c
         WHERE c.id = $1
         LIMIT 1
      `,
      [String(campaignId)],
    );
    const row = (result.rows || [])[0];
    return row ? _rowToAdminCampaign(row) : null;
  }

  /**
   * INSERT a new campaign. All values parameterized. Returns the created row
   * (registration_count is 0 by construction — the id is a fresh uuid, and a
   * registration cannot reference the row before the INSERT commits).
   */
  async function createCampaign(env, data) {
    const result = await queryDb(
      env,
      `
        INSERT INTO promo_campaigns
          (title_fa, title_en, summary_fa, summary_en, body_fa, body_en,
           image_url, registration_url, starts_at, ends_at, status)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
        RETURNING id, title_fa, title_en, summary_fa, summary_en,
                  body_fa, body_en, image_url, registration_url,
                  starts_at, ends_at,
                  status, created_at, updated_at
      `,
      [
        String(data.title_fa),
        String(data.title_en),
        data.summary_fa ?? null,
        data.summary_en ?? null,
        data.body_fa ?? '',
        data.body_en ?? '',
        data.image_url ?? null,
        data.registration_url ?? null,
        String(data.starts_at),
        data.ends_at ?? null,
        String(data.status),
      ],
    );
    const row = (result.rows || [])[0];
    return row ? _rowToAdminCampaign(row) : null;
  }

  // Fixed whitelist of columns the admin UPDATE may touch. `status` is
  // deliberately NOT here — status changes go exclusively through
  // setCampaignStatus / softDeleteCampaign so every transition passes the
  // same audited code path.
  const UPDATABLE_COLUMNS = [
    'title_fa', 'title_en', 'summary_fa', 'summary_en',
    'body_fa', 'body_en', 'image_url', 'registration_url', 'starts_at', 'ends_at',
  ];

  // Parameterized SET-clause builder (membership.js newSetBuilder pattern):
  // values are bound as $n; literals are restricted to NOW().
  function _newSetBuilder() {
    const params = [];
    const sets = [];
    return {
      params,
      addParam(column, value) {
        params.push(value);
        sets.push(`${column} = $${params.length}`);
      },
      addLiteral(column, literal) {
        if (literal !== 'NOW()') {
          throw new Error(`_newSetBuilder: SQL literal not allowed: ${literal}`);
        }
        sets.push(`${column} = ${literal}`);
      },
      sql() { return sets.join(', '); },
    };
  }

  /**
   * Partial UPDATE of the whitelisted content columns. `fields` keys outside
   * UPDATABLE_COLUMNS are ignored (never interpolated). Returns the updated
   * row or null (not found / empty update / concurrent delete). The content of
   * a row that gets soft-deleted between the controller's read and this UPDATE
   * may still be written — harmless by design: DELETED rows never surface in
   * any user or admin list again except through this admin module itself.
   *
   * The response is re-read via getCampaignById (canonical _ADMIN_SELECT_COLUMNS)
   * because PostgreSQL cannot compute the registration_count subquery inside
   * RETURNING — the RETURNING row is only a fallback (audit M-2).
   */
  async function updateCampaign(env, campaignId, fields) {
    const b = _newSetBuilder();
    for (const column of UPDATABLE_COLUMNS) {
      if (Object.prototype.hasOwnProperty.call(fields, column)) {
        b.addParam(column, fields[column]);
      }
    }
    if (!b.params.length) return null;
    b.addLiteral('updated_at', 'NOW()'); // belt-and-suspenders; trigger also maintains it
    const result = await queryDb(
      env,
      `
        UPDATE promo_campaigns
           SET ${b.sql()}
         WHERE id = $${b.params.length + 1}
        RETURNING id, title_fa, title_en, summary_fa, summary_en,
                  body_fa, body_en, image_url, registration_url,
                  starts_at, ends_at,
                  status, created_at, updated_at
      `,
      [...b.params, String(campaignId)],
    );
    const row = (result.rows || [])[0];
    if (!row) return null;
    return (await getCampaignById(env, campaignId)) || _rowToAdminCampaign(row);
  }

  /**
   * Status transition (publish / stop / resume). The `status <> 'DELETED'`
   * guard makes DELETED terminal AT THE DATABASE LEVEL — a zombie resurrection
   * is impossible even under a concurrent race. Returns the updated row or
   * null (missing, already deleted, or raced delete).
   *
   * The response is re-read via getCampaignById (canonical _ADMIN_SELECT_COLUMNS)
   * because PostgreSQL cannot compute the registration_count subquery inside
   * RETURNING — the RETURNING row is only a fallback (audit M-2).
   */
  async function setCampaignStatus(env, campaignId, status) {
    const result = await queryDb(
      env,
      `
        UPDATE promo_campaigns
           SET status = $2, updated_at = NOW()
         WHERE id = $1
           AND status <> 'DELETED'
        RETURNING id, title_fa, title_en, summary_fa, summary_en,
                  body_fa, body_en, image_url, registration_url,
                  starts_at, ends_at,
                  status, created_at, updated_at
      `,
      [String(campaignId), String(status)],
    );
    const row = (result.rows || [])[0];
    if (!row) return null;
    return (await getCampaignById(env, campaignId)) || _rowToAdminCampaign(row);
  }

  /**
   * SOFT delete (status → 'DELETED'). Registrations are preserved (FK
   * RESTRICT, no CASCADE). Returns true only when this call performed the
   * transition; false when the campaign is missing or already DELETED.
   */
  async function softDeleteCampaign(env, campaignId) {
    const result = await queryDb(
      env,
      `
        UPDATE promo_campaigns
           SET status = 'DELETED', updated_at = NOW()
         WHERE id = $1
           AND status <> 'DELETED'
         RETURNING id
      `,
      [String(campaignId)],
    );
    return (result.rows || []).length > 0;
  }

  /**
   * Paginated registrations for one campaign, newest first, joined with the
   * users table for display names. Used by BOTH the JSON list and the CSV
   * export (export passes a larger `limit`).
   */
  async function listRegistrations(env, campaignId, { page, limit } = {}) {
    const pg = Math.max(1, Math.min(10000, Number(page) || 1));
    const lim = Math.max(1, Math.min(1000, Number(limit) || 20));
    const offset = (pg - 1) * lim;
    const [countResult, dataResult] = await Promise.all([
      queryDb(
        env,
        `SELECT COUNT(*)::int AS total FROM promo_campaign_registrations WHERE campaign_id = $1`,
        [String(campaignId)],
      ),
      queryDb(
        env,
        `
          SELECT r.id, r.telegram_id, r.registered_at,
                 u.username, u.first_name, u.last_name
            FROM promo_campaign_registrations r
            LEFT JOIN users u ON u.telegram_id = r.telegram_id
           WHERE r.campaign_id = $1
           ORDER BY r.registered_at DESC, r.id DESC
           LIMIT $2 OFFSET $3
        `,
        [String(campaignId), lim, offset],
      ),
    ]);
    const total = Number(countResult.rows[0]?.total || 0);
    return {
      items: (dataResult.rows || []).map((row) => ({
        id: row.id,
        telegram_id: String(row.telegram_id),
        username: row.username || null,
        first_name: row.first_name || null,
        last_name: row.last_name || null,
        registered_at: _iso(row.registered_at),
      })),
      total,
      page: pg,
      limit: lim,
      totalPages: Math.max(1, Math.ceil(total / lim)),
    };
  }

  return {
    ensureSchema,
    listVisibleCampaigns,
    getVisibleCampaignById,
    registerUser,
    isRegistered,
    getCampaignForGate,
    // Admin (Stage 6B)
    listCampaignsAdmin,
    getCampaignById,
    createCampaign,
    updateCampaign,
    setCampaignStatus,
    softDeleteCampaign,
    listRegistrations,
  };
}

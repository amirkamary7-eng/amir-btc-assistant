/**
 * User Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to user profiles.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createUserRepository(deps) {
  const { queryDb, queryDbTransaction, normalizeOptionalString } = deps;

  let _tableEnsured = false;
  let _ensureTablePromise = null;
  // PHASE 1 SAFE OPTIMIZATION: Module-level flag for deleted_users table.
  // Previously checkReferralCooldown ran CREATE TABLE IF NOT EXISTS on EVERY
  // bootstrap with a valid referrer. Now it runs only once per isolate (matching
  // the pattern of _tableEnsured above). The DDL is idempotent so there's no
  // correctness issue — just a wasted DB round-trip eliminated.
  let _deletedUsersTableEnsured = false;

  /**
   * Ensure the users table has all required columns (idempotent).
   * Called once at module init. Adds new tracking columns if missing.
   *
   * Phase 5 optimization: Merged 9 sequential DDL round-trips into a single
   * multi-statement queryDb call (same pattern as admin.js batchSql).
   * Uses a Promise singleton to prevent concurrent cold-isolate initialization
   * from piling up — all concurrent callers await the same in-flight promise.
   * On failure, the promise is cleared so the next request can retry.
   */
  async function ensureTable(env) {
    if (_tableEnsured) return;
    // Phase 5: Promise singleton — concurrent callers await the same initialization.
    // On failure, _ensureTablePromise is cleared so the next request can retry.
    if (!_ensureTablePromise) {
      _ensureTablePromise = (async () => {
        try {
          // Single multi-statement DDL call (9 statements merged into 1 round-trip).
          // All statements are idempotent (IF NOT EXISTS). Each ALTER/CREATE has
          // its own catch in the original code — here we rely on IF NOT EXISTS
          // for idempotency. If any statement fails, the whole batch fails and
          // _ensureTablePromise is cleared for retry.
          await queryDb(env, `
            CREATE TABLE IF NOT EXISTS users (
              telegram_id VARCHAR(64) PRIMARY KEY,
              username VARCHAR(128),
              first_name VARCHAR(128),
              last_name VARCHAR(128),
              lang VARCHAR(8) DEFAULT 'fa',
              channel_joined BOOLEAN DEFAULT FALSE,
              channel_verified_at TIMESTAMPTZ,
              created_at TIMESTAMPTZ DEFAULT NOW(),
              updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_joined_at TIMESTAMPTZ;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS mini_app_opened_at TIMESTAMPTZ;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_popup_seen BOOLEAN NOT NULL DEFAULT FALSE;
            CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_channel_joined ON users (channel_joined) WHERE channel_joined = TRUE;
          `);
          _tableEnsured = true;
        } catch (e) {
          // Clear the promise so the next request can retry.
          _ensureTablePromise = null;
          console.warn('ensureTable users:', e?.message);
        }
      })();
    }
    return _ensureTablePromise;
  }

  /**
   * Normalize a language code to 'fa' or 'en'.
   */
  function normalizeLanguage(value, fallbackValue = 'fa') {
    const normalized = normalizeOptionalString(value);
    if (normalized === 'fa' || normalized === 'en') {
      return normalized;
    }
    return fallbackValue === 'en' ? 'en' : 'fa';
  }

  /**
   * Serialize a raw DB user row into the API response shape.
   * Includes the new tracking columns (last_active_at, bot_joined_at, etc.)
   */
  function normalizeRow(row, watchlist = []) {
    return {
      user_id: String(row.telegram_id),
      username: normalizeOptionalString(row.username),
      first_name: normalizeOptionalString(row.first_name),
      last_name: normalizeOptionalString(row.last_name),
      lang: normalizeLanguage(row.lang),
      channel_joined: Boolean(row.channel_joined),
      channel_verified_at: row.channel_verified_at ? new Date(row.channel_verified_at).toISOString() : null,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      last_active_at: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
      bot_joined_at: row.bot_joined_at ? new Date(row.bot_joined_at).toISOString() : null,
      mini_app_opened_at: row.mini_app_opened_at ? new Date(row.mini_app_opened_at).toISOString() : null,
      is_premium: Boolean(row.is_premium),
      beta_popup_seen: Boolean(row.beta_popup_seen),
      watchlist,
    };
  }

  /**
   * Get a raw user row by telegram_id.
   */
  async function getById(env, userId) {
    const result = await queryDb(
      env,
      `
        SELECT
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at,
          last_active_at,
          bot_joined_at,
          mini_app_opened_at,
          is_premium
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
      `,
      [String(userId)],
    );
    return result.rows[0] || null;
  }

  /**
   * Upsert a user profile (bootstrap). Preserves existing channel_joined status.
   * ROOT CAUSE FIX: Now tracks last_active_at on every bootstrap (Mini App open)
   * and sets mini_app_opened_at on first Mini App open.
   */
  async function bootstrap(env, userId, payload, existingUser = null) {
    // If existingUser is not provided, fetch it (backward compatible).
    // When the controller already has it from a prior getById() call,
    // passing it here avoids a duplicate DB query.
    if (!existingUser) {
      existingUser = await getById(env, userId);
    }
    const fallbackLang = existingUser?.lang || 'fa';
    const lang = normalizeLanguage(payload.lang, fallbackLang);
    const isPremium = Boolean(payload.is_premium);
    const result = await queryDb(
      env,
      `
        INSERT INTO users (
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          is_premium,
          bot_joined_at,
          mini_app_opened_at,
          last_active_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), $7, $8, NOW(), NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE
        SET
          username = COALESCE(EXCLUDED.username, users.username),
          first_name = COALESCE(EXCLUDED.first_name, users.first_name),
          last_name = COALESCE(EXCLUDED.last_name, users.last_name),
          -- BILINGUAL PERSISTENCE FIX: preserve the EXISTING DB lang over the
          -- request's lang. This prevents a fresh device (whose localStorage
          -- defaults to 'fa') from overwriting a user's stored 'en' preference
          -- in the DB on multi-device use. The explicit language switch path
          -- (PUT /api/users/me/settings) unconditionally updates lang, which
          -- is the correct channel for changing the user's language choice.
          lang = COALESCE(users.lang, EXCLUDED.lang),
          is_premium = COALESCE(EXCLUDED.is_premium, users.is_premium),
          last_active_at = NOW(),
          mini_app_opened_at = COALESCE(users.mini_app_opened_at, NOW()),
          updated_at = NOW()
        RETURNING
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at,
          last_active_at,
          bot_joined_at,
          mini_app_opened_at,
          is_premium,
          beta_popup_seen
      `,
      [
        String(userId),
        normalizeOptionalString(payload.username),
        normalizeOptionalString(payload.first_name),
        normalizeOptionalString(payload.last_name),
        lang,
        existingUser ? Boolean(existingUser.channel_joined) : false,
        existingUser?.channel_verified_at ? new Date(existingUser.channel_verified_at).toISOString() : null,
        isPremium,
      ],
    );
    return result.rows[0] || null;
  }

  /**
   * Update user settings (language and beta_popup_seen).
   */
  async function updateSettings(env, userId, payload) {
    const lang = normalizeLanguage(payload.lang);
    const betaPopupSeen = payload.beta_popup_seen === true || payload.beta_popup_seen === 'true';
    const result = await queryDb(
      env,
      `
        UPDATE users
        SET
          lang = $2,
          beta_popup_seen = CASE WHEN $3 THEN TRUE ELSE beta_popup_seen END,
          updated_at = NOW()
        WHERE telegram_id = $1
        RETURNING
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at,
          last_active_at,
          bot_joined_at,
          mini_app_opened_at,
          is_premium,
          beta_popup_seen
      `,
      [String(userId), lang, betaPopupSeen],
    );
    return result.rows[0] || null;
  }

  /**
   * ── ROOT-CAUSE FIX: Delete Account with full cascade ──
   *
   * Permanently deletes a user and ALL their associated data across every
   * table in the database. This is required so that:
   *   1. Users can exercise their right to erasure (GDPR / privacy).
   *   2. A user who deletes their account can re-register via a referral link
   *      and have the referral registered (the old referral row must be gone
   *      so the "first inviter wins" check doesn't block the new referral).
   *
   * ANTI-ABUSE: Before deleting, records the user in a `deleted_users`
   * cooldown table with a 15-day cooldown. If the same Telegram ID re-registers
   * within 15 days, they CAN use the app but CANNOT generate a new referral
   * reward. This prevents abuse where a user deletes + re-registers repeatedly
   * to farm referral rewards for themselves.
   *
   * Cascade order (child → parent to avoid FK violations):
   *   1. referrals (as invitee AND as inviter)
   *   2. token_transactions
   *   3. token_balances (if table exists)
   *   4. watchlist_items
   *   5. alerts
   *   6. notifications
   *  6b. notification_queue (no FK to users — manual cleanup, SETTINGS-002)
   *   7. tickets
   *   8. mission_progress
   *   9. calendar_reminders (if table exists)
   *  10. users (the root row)
   *
   * Each DELETE is wrapped in its own try/catch so that a missing table or
   * transient error doesn't abort the cascade — the user row is still deleted.
   *
   * @returns {Object} summary of what was deleted (for debug logging)
   */
  async function deleteAccount(env, userId) {
    const uid = String(userId);
    const summary = { userId: uid, tables: {}, errors: [] };

    // ── ANTI-ABUSE: Record in deleted_users cooldown table BEFORE cascade ──
    // This must happen BEFORE the user row is deleted, so we can look up
    // their existing referral data (to store the referral_hash).
    try {
      // Get the user's existing referral (if any) to store the inviter
      const existingRef = await queryDb(env,
        'SELECT inviter_id FROM referrals WHERE invitee_id = $1 LIMIT 1',
        [uid]);
      const previousInviterId = existingRef.rows[0]?.inviter_id || null;

      // Create the deleted_users table if it doesn't exist (idempotent).
      // SETTINGS-001 FIX: telegram_id MUST be UNIQUE so that the
      // INSERT ... ON CONFLICT (telegram_id) below works. Previously this DDL
      // omitted UNIQUE (while checkReferralCooldown's DDL included it), so if
      // deleteAccount ran first the ON CONFLICT would error with
      // "there is no unique or exclusion constraint matching the ON CONFLICT
      // specification". The two DDLs are now identical.
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS deleted_users (
          id SERIAL PRIMARY KEY,
          telegram_id VARCHAR(64) NOT NULL UNIQUE,
          previous_inviter_id VARCHAR(64),
          deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          cooldown_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days')
        )
      `);
      // Defensive idempotent migration: if the table was created by an older
      // version of deleteAccount (without UNIQUE), add the unique index now.
      // CREATE UNIQUE INDEX IF NOT EXISTS is a no-op if the index already
      // exists (either from the UNIQUE column constraint above or a prior run).
      // Safe because telegram_id logically identifies one cooldown record.
      await queryDb(env,
        `CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_users_telegram_id_uniq ON deleted_users (telegram_id)`
      ).catch(() => {});
      // Insert the cooldown record (ON CONFLICT updates cooldown if already exists)
      await queryDb(env, `
        INSERT INTO deleted_users (telegram_id, previous_inviter_id, deleted_at, cooldown_until)
        VALUES ($1, $2, NOW(), NOW() + INTERVAL '15 days')
        ON CONFLICT (telegram_id) DO UPDATE
        SET deleted_at = NOW(), cooldown_until = NOW() + INTERVAL '15 days'
      `, [uid, previousInviterId]);
      summary.cooldownRecorded = true;
      console.log('[DELETE-ACCOUNT] Cooldown recorded for', uid, 'until', new Date(Date.now() + 15*24*60*60*1000).toISOString());
    } catch (e) {
      summary.cooldownRecorded = false;
      summary.cooldownError = e?.message;
      console.warn('[DELETE-ACCOUNT] Failed to record cooldown (non-fatal):', e?.message);
    }

    // DB-001 FIX: Wrap ALL cascade DELETEs in a single transaction.
    // Previously, each DELETE was a separate queryDb call with its own
    // try/catch. If any middle DELETE failed, the remaining DELETEs still
    // ran, potentially leaving orphan rows (user deleted but child rows remain).
    // Now: ALL DELETEs run in one queryDbTransaction. If any fails, the
    // entire transaction ROLLBACKs — no partial deletion.
    //
    // Note: The deleted_users cooldown INSERT (above) is intentionally
    // OUTSIDE this transaction — it must persist even if the cascade fails,
    // so the user is blocked from re-registering during cooldown regardless.
    //
    // Order matters: wheel_history before wheel_spins (FK), users last.
    const cascadeQueries = [
      { sql: 'DELETE FROM referrals WHERE invitee_id = $1', params: [uid] },
      { sql: 'DELETE FROM referrals WHERE inviter_id = $1', params: [uid] },
      { sql: 'DELETE FROM token_transactions WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM token_balances WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM watchlist_items WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM alerts WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM notifications WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM notification_queue WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM tickets WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM mission_progress WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM calendar_reminders WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM wheel_history WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM wheel_spins WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM support_messages WHERE user_id = $1', params: [uid] },
      { sql: 'DELETE FROM admins WHERE telegram_id = $1', params: [uid] },
      { sql: 'DELETE FROM users WHERE telegram_id = $1', params: [uid] },
    ];

    const results = await queryDbTransaction(env, cascadeQueries);
    const tableNames = [
      'referrals_as_invitee', 'referrals_as_inviter', 'token_transactions',
      'token_balances', 'watchlist_items', 'alerts', 'notifications',
      'notification_queue', 'tickets', 'mission_progress', 'calendar_reminders',
      'wheel_history', 'wheel_spins', 'support_messages', 'admins', 'users',
    ];
    for (let i = 0; i < tableNames.length; i++) {
      summary.tables[tableNames[i]] = results[i]?.rowCount || 0;
    }

    console.log('[DELETE-ACCOUNT] Cascade complete (transactional):', JSON.stringify(summary));
    return summary;
  }

  /**
   * Check if a Telegram ID is in the 15-day referral cooldown period.
   * Returns { inCooldown: boolean, cooldownUntil: string|null, reason: string }
   *
   * Used by processReferralOnBootstrap to reject referrals from recently
   * deleted accounts. The user CAN still use the app — they just can't
   * generate a new referral reward for 15 days after deletion.
   */
  async function checkReferralCooldown(env, userId) {
    const uid = String(userId);
    try {
      // PHASE 1 SAFE OPTIMIZATION: Gate the DDL behind a module-level flag.
      // The CREATE TABLE IF NOT EXISTS is idempotent, but running it on every
      // call wastes a DB round-trip. Now it only runs once per isolate.
      if (!_deletedUsersTableEnsured) {
        await queryDb(env, `
          CREATE TABLE IF NOT EXISTS deleted_users (
            id SERIAL PRIMARY KEY,
            telegram_id VARCHAR(64) NOT NULL UNIQUE,
            previous_inviter_id VARCHAR(64),
            deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            cooldown_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days')
          )
        `);
        _deletedUsersTableEnsured = true;
      }
      const result = await queryDb(env,
        `SELECT telegram_id, deleted_at, cooldown_until
         FROM deleted_users
         WHERE telegram_id = $1 AND cooldown_until > NOW()
         LIMIT 1`,
        [uid]);
      if (result.rows[0]) {
        return {
          inCooldown: true,
          cooldownUntil: result.rows[0].cooldown_until,
          reason: 'Deleted account cooldown (15 days)',
          deletedAt: result.rows[0].deleted_at,
        };
      }
      return { inCooldown: false, reason: null };
    } catch (e) {
      console.warn('[COOLDOWN] Check failed (non-fatal, allowing referral):', e?.message);
      return { inCooldown: false, reason: null, error: e?.message };
    }
  }

  return Object.freeze({ ensureTable, normalizeLanguage, normalizeRow, getById, bootstrap, updateSettings, deleteAccount, checkReferralCooldown });
}
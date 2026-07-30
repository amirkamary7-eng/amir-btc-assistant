/**
 * User Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to user profiles.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createUserRepository(deps) {
  const { queryDb, normalizeOptionalString } = deps;

  let _tableEnsured = false;

  /**
   * Ensure the users table has all required columns (idempotent).
   * Called once at module init. Adds new tracking columns if missing.
   *
   * Schema additions (Phase 2 — Users redesign):
   *   - last_active_at TIMESTAMPTZ: updated on every bootstrap (Mini App open)
   *   - bot_joined_at TIMESTAMPTZ: set when user first interacts with the bot
   *   - mini_app_opened_at TIMESTAMPTZ: set when user first opens the Mini App
   *   - is_premium BOOLEAN: Telegram premium status (from initData)
   *
   * These allow the admin dashboard to show REAL activity metrics:
   *   - Active Today: WHERE last_active_at >= CURRENT_DATE
   *   - Joined Bot: WHERE bot_joined_at IS NOT NULL
   *   - Opened Mini App: WHERE mini_app_opened_at IS NOT NULL
   */
  async function ensureTable(env) {
    if (_tableEnsured) return;
    try {
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
        )
      `);
      // Add new columns if missing (idempotent)
      await queryDb(env, `ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ`).catch(() => {});
      await queryDb(env, `ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_joined_at TIMESTAMPTZ`).catch(() => {});
      await queryDb(env, `ALTER TABLE users ADD COLUMN IF NOT EXISTS mini_app_opened_at TIMESTAMPTZ`).catch(() => {});
      await queryDb(env, `ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE`).catch(() => {});
      // Indexes for the new columns (for dashboard query performance)
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_users_channel_joined ON users (channel_joined) WHERE channel_joined = TRUE`).catch(() => {});
      _tableEnsured = true;
    } catch (e) {
      console.warn('ensureTable users:', e?.message);
    }
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
  async function bootstrap(env, userId, payload) {
    const existingUser = await getById(env, userId);
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
          lang = COALESCE(EXCLUDED.lang, users.lang),
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
          is_premium
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
   * Update user language setting.
   */
  async function updateSettings(env, userId, payload) {
    const lang = normalizeLanguage(payload.lang);
    const result = await queryDb(
      env,
      `
        UPDATE users
        SET
          lang = $2,
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
          is_premium
      `,
      [String(userId), lang],
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
   * Cascade order (child → parent to avoid FK violations):
   *   1. referrals (as invitee AND as inviter)
   *   2. token_transactions
   *   3. token_balances (if table exists)
   *   4. watchlist_items
   *   5. alerts
   *   6. notifications
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

    // Helper: run a DELETE and record rowCount
    const cascadeDelete = async (tableName, sql, params) => {
      try {
        const result = await queryDb(env, sql, params);
        summary.tables[tableName] = result.rowCount || 0;
      } catch (e) {
        // Table might not exist yet, or FK constraint — log and continue
        summary.tables[tableName] = -1;
        summary.errors.push({ table: tableName, error: e?.message });
      }
    };

    // 1. referrals (as invitee — this is the critical one for re-registration)
    await cascadeDelete('referrals_as_invitee',
      'DELETE FROM referrals WHERE invitee_id = $1', [uid]);
    // 1b. referrals (as inviter — remove their invite records)
    await cascadeDelete('referrals_as_inviter',
      'DELETE FROM referrals WHERE inviter_id = $1', [uid]);

    // 2. token_transactions
    await cascadeDelete('token_transactions',
      'DELETE FROM token_transactions WHERE user_id = $1', [uid]);

    // 3. token_balances (may not exist — some setups use a single row per user)
    await cascadeDelete('token_balances',
      'DELETE FROM token_balances WHERE user_id = $1', [uid]);

    // 4. watchlist_items
    await cascadeDelete('watchlist_items',
      'DELETE FROM watchlist_items WHERE user_id = $1', [uid]);

    // 5. alerts
    await cascadeDelete('alerts',
      'DELETE FROM alerts WHERE user_id = $1', [uid]);

    // 6. notifications
    await cascadeDelete('notifications',
      'DELETE FROM notifications WHERE user_id = $1', [uid]);

    // 7. tickets
    await cascadeDelete('tickets',
      'DELETE FROM tickets WHERE user_id = $1', [uid]);

    // 8. mission_progress
    await cascadeDelete('mission_progress',
      'DELETE FROM mission_progress WHERE user_id = $1', [uid]);

    // 9. calendar_reminders (if table exists)
    await cascadeDelete('calendar_reminders',
      'DELETE FROM calendar_reminders WHERE user_id = $1', [uid]);

    // 10. wheel_spins (if table exists — some setups track per-user spin history)
    await cascadeDelete('wheel_spins',
      'DELETE FROM wheel_spins WHERE user_id = $1', [uid]);

    // 11. support_messages (if separate from tickets)
    await cascadeDelete('support_messages',
      'DELETE FROM support_messages WHERE user_id = $1', [uid]);

    // 12. admin records (if user was an admin)
    await cascadeDelete('admins',
      'DELETE FROM admins WHERE telegram_id = $1', [uid]);

    // 13. FINALLY — delete the user row itself
    await cascadeDelete('users',
      'DELETE FROM users WHERE telegram_id = $1', [uid]);

    console.log('[DELETE-ACCOUNT] Cascade complete:', JSON.stringify(summary));
    return summary;
  }

  return Object.freeze({ ensureTable, normalizeLanguage, normalizeRow, getById, bootstrap, updateSettings, deleteAccount });
}
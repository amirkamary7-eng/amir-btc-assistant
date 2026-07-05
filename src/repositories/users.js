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
          updated_at
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
   */
  async function bootstrap(env, userId, payload) {
    const existingUser = await getById(env, userId);
    const fallbackLang = existingUser?.lang || 'fa';
    const lang = normalizeLanguage(payload.lang, fallbackLang);
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
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), $7, NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE
        SET
          username = COALESCE(EXCLUDED.username, users.username),
          first_name = COALESCE(EXCLUDED.first_name, users.first_name),
          last_name = COALESCE(EXCLUDED.last_name, users.last_name),
          lang = COALESCE(EXCLUDED.lang, users.lang),
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
          updated_at
      `,
      [
        String(userId),
        normalizeOptionalString(payload.username),
        normalizeOptionalString(payload.first_name),
        normalizeOptionalString(payload.last_name),
        lang,
        existingUser ? Boolean(existingUser.channel_joined) : false,
        existingUser?.channel_verified_at ? new Date(existingUser.channel_verified_at).toISOString() : null,
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
          updated_at
      `,
      [String(userId), lang],
    );
    return result.rows[0] || null;
  }

  return Object.freeze({ normalizeLanguage, normalizeRow, getById, bootstrap, updateSettings });
}
/**
 * Notification Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to user notifications.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createNotificationRepository(deps) {
  const { queryDb } = deps;

  /**
   * Ensure the notifications table exists (idempotent).
   * Called once at module init; safe to call multiple times.
   */
  let _tableEnsured = false;
  async function ensureTable(env) {
    if (_tableEnsured) return;
    try {
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS notifications (
          id TEXT PRIMARY KEY,
          user_id TEXT NOT NULL REFERENCES users(telegram_id) ON DELETE CASCADE,
          type TEXT NOT NULL,
          title TEXT NOT NULL DEFAULT '',
          message TEXT NOT NULL DEFAULT '',
          metadata JSONB,
          read_status BOOLEAN NOT NULL DEFAULT FALSE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      _tableEnsured = true;
    } catch (error) {
      // If table already exists (race condition), that's fine
      if (error?.code === '42P07') {
        _tableEnsured = true;
        return;
      }
      throw error;
    }
  }

  /**
   * Serialize a raw DB row into the API response shape.
   */
  function serializeRow(row) {
    return {
      id: String(row.id),
      type: String(row.type),
      title: String(row.title || ''),
      message: String(row.message || ''),
      metadata: row.metadata || null,
      read: Boolean(row.read_status),
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /**
   * Create a notification for a specific user.
   * Returns the created notification row.
   */
  async function create(env, userId, type, title, message, metadata = null) {
    await ensureTable(env);
    const result = await queryDb(
      env,
      `
        INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, FALSE, NOW())
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, type, title, message, metadata, read_status, created_at
      `,
      [
        String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16),
        String(userId),
        String(type).slice(0, 50),
        String(title || '').slice(0, 200),
        String(message || '').slice(0, 2000),
        metadata ? JSON.stringify(metadata) : null,
      ],
    );
    return result.rows[0] ? serializeRow(result.rows[0]) : null;
  }

  /**
   * Create notifications for multiple users in a single query.
   * Returns the number of rows inserted.
   */
  async function createBulk(env, userIds, type, title, message, metadata = null) {
    await ensureTable(env);
    if (!Array.isArray(userIds) || userIds.length === 0) return 0;
    const values = [];
    const params = [];
    let paramIndex = 1;
    for (const uid of userIds) {
      const id = String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16);
      values.push(`($${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, $${paramIndex++}, FALSE, NOW())`);
      params.push(id, String(uid), String(type).slice(0, 50), String(title || '').slice(0, 200), String(message || '').slice(0, 2000), metadata ? JSON.stringify(metadata) : null);
    }
    const sql = `
      INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, created_at)
      VALUES ${values.join(', ')}
      ON CONFLICT DO NOTHING
    `;
    const result = await queryDb(env, sql, params);
    return result.rowCount || 0;
  }

  /**
   * List notifications for a user, ordered by newest first.
   * Supports pagination via limit (default 50).
   */
  async function list(env, userId, limit = 50) {
    const safeLimit = Math.min(Math.max(Number(limit) || 50, 1), 100);
    const result = await queryDb(
      env,
      `
        SELECT id, user_id, type, title, message, metadata, read_status, created_at
        FROM notifications
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2
      `,
      [String(userId), safeLimit],
    );
    return result.rows.map((row) => serializeRow(row));
  }

  /**
   * Count unread notifications for a user.
   */
  async function unreadCount(env, userId) {
    const result = await queryDb(
      env,
      `
        SELECT COUNT(*)::int AS count
        FROM notifications
        WHERE user_id = $1 AND read_status = FALSE
      `,
      [String(userId)],
    );
    return result.rows[0]?.count || 0;
  }

  /**
   * Mark a single notification as read.
   */
  async function markRead(env, notificationId, userId) {
    const result = await queryDb(
      env,
      `
        UPDATE notifications
        SET read_status = TRUE
        WHERE id = $1 AND user_id = $2
        RETURNING id
      `,
      [String(notificationId), String(userId)],
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * Mark all notifications for a user as read.
   * Returns the number of rows updated.
   */
  async function markAllRead(env, userId) {
    const result = await queryDb(
      env,
      `
        UPDATE notifications
        SET read_status = TRUE
        WHERE user_id = $1 AND read_status = FALSE
      `,
      [String(userId)],
    );
    return result.rowCount || 0;
  }

  return Object.freeze({ create, createBulk, list, unreadCount, markRead, markAllRead, serializeRow, ensureTable });
}
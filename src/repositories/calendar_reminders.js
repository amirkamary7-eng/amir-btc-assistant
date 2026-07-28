/**
 * Calendar Reminders Repository — Data Access Layer
 *
 * Stores per-user reminders for economic calendar events. Unlike the old
 * frontend-only localStorage approach, this persists reminders in PostgreSQL
 * so they survive across devices and actually fire via the cron job.
 *
 * Schema:
 *   calendar_reminders (
 *     id SERIAL PRIMARY KEY,
 *     user_id VARCHAR(64) NOT NULL,
 *     event_key VARCHAR(255) NOT NULL,        -- title|date|country
 *     event_title VARCHAR(256),
 *     event_country VARCHAR(16),
 *     event_timestamp TIMESTAMPTZ,             -- when the event happens
 *     lead_minutes INTEGER NOT NULL DEFAULT 60, -- 15, 60, or 1440
 *     fired_at TIMESTAMPTZ,                    -- NULL = not yet fired
 *     created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
 *     UNIQUE(user_id, event_key)               -- one reminder per event per user
 *   )
 */
export function createCalendarReminderRepository(deps) {
  const { queryDb } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    if (_schemaVerified) return;
    const sql = `
      CREATE TABLE IF NOT EXISTS calendar_reminders (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        event_key VARCHAR(255) NOT NULL,
        event_title VARCHAR(256) DEFAULT '',
        event_country VARCHAR(16) DEFAULT '',
        event_timestamp TIMESTAMPTZ,
        lead_minutes INTEGER NOT NULL DEFAULT 60,
        fired_at TIMESTAMPTZ,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        UNIQUE(user_id, event_key)
      );
      CREATE INDEX IF NOT EXISTS idx_cal_reminders_user ON calendar_reminders (user_id);
      CREATE INDEX IF NOT EXISTS idx_cal_reminders_pending ON calendar_reminders (event_timestamp) WHERE fired_at IS NULL;
    `;
    try {
      await queryDb(env, sql);
    } catch (e) {
      console.warn('Calendar reminder schema migration warning:', e.message);
    }
    _schemaVerified = true;
  }

  /**
   * Create or update a reminder (upsert).
   * If a reminder for (user_id, event_key) already exists, update its
   * lead_minutes, event details, and reset fired_at to NULL.
   */
  async function upsert(env, userId, reminder) {
    const result = await queryDb(
      env,
      `INSERT INTO calendar_reminders (user_id, event_key, event_title, event_country, event_timestamp, lead_minutes)
       VALUES ($1, $2, $3, $4, $5, $6)
       ON CONFLICT (user_id, event_key)
       DO UPDATE SET
         event_title = EXCLUDED.event_title,
         event_country = EXCLUDED.event_country,
         event_timestamp = EXCLUDED.event_timestamp,
         lead_minutes = EXCLUDED.lead_minutes,
         fired_at = NULL,
         created_at = NOW()
       RETURNING id, user_id, event_key, event_title, event_country, event_timestamp, lead_minutes, fired_at, created_at`,
      [
        String(userId),
        String(reminder.event_key || '').slice(0, 255),
        String(reminder.event_title || '').slice(0, 256),
        String(reminder.event_country || '').slice(0, 16),
        reminder.event_timestamp ? new Date(reminder.event_timestamp).toISOString() : null,
        Number(reminder.lead_minutes) || 60,
      ],
    );
    return result.rows[0] ? serializeRow(result.rows[0]) : null;
  }

  /**
   * Delete a reminder by user_id and event_key.
   * Returns true if a row was deleted.
   */
  async function remove(env, userId, eventKey) {
    const result = await queryDb(
      env,
      `DELETE FROM calendar_reminders WHERE user_id = $1 AND event_key = $2 RETURNING id`,
      [String(userId), String(eventKey)],
    );
    return result.rows.length > 0;
  }

  /**
   * List all reminders for a user.
   */
  async function listByUser(env, userId) {
    const result = await queryDb(
      env,
      `SELECT id, user_id, event_key, event_title, event_country, event_timestamp, lead_minutes, fired_at, created_at
       FROM calendar_reminders WHERE user_id = $1 ORDER BY event_timestamp ASC`,
      [String(userId)],
    );
    return result.rows.map(serializeRow);
  }

  /**
   * List reminders that should fire now (for the cron job).
   * A reminder fires when: now >= event_timestamp - lead_minutes AND
   * event_timestamp > now (event hasn't passed yet) AND fired_at IS NULL.
   *
   * Returns rows with user_id for per-user dispatch.
   */
  async function listPending(env, now = new Date()) {
    const result = await queryDb(
      env,
      `SELECT id, user_id, event_key, event_title, event_country, event_timestamp, lead_minutes, fired_at, created_at
       FROM calendar_reminders
       WHERE fired_at IS NULL
         AND event_timestamp IS NOT NULL
         AND event_timestamp <= NOW() + (lead_minutes || ' minutes')::interval
         AND event_timestamp > NOW()
       ORDER BY event_timestamp ASC
       LIMIT 200`,
    );
    return result.rows.map(serializeRow);
  }

  /**
   * Mark a reminder as fired. Prevents duplicate notifications.
   */
  async function markFired(env, reminderId) {
    const result = await queryDb(
      env,
      `UPDATE calendar_reminders SET fired_at = NOW() WHERE id = $1 AND fired_at IS NULL RETURNING id`,
      [Number(reminderId)],
    );
    return result.rows.length > 0;
  }

  function serializeRow(row) {
    return {
      id: Number(row?.id || 0),
      user_id: String(row?.user_id || ''),
      event_key: String(row?.event_key || ''),
      event_title: String(row?.event_title || ''),
      event_country: String(row?.event_country || ''),
      event_timestamp: row?.event_timestamp ? new Date(row.event_timestamp).toISOString() : null,
      lead_minutes: Number(row?.lead_minutes || 60),
      fired_at: row?.fired_at ? new Date(row.fired_at).toISOString() : null,
      created_at: row?.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  return Object.freeze({
    ensureSchema,
    upsert,
    remove,
    listByUser,
    listPending,
    markFired,
    serializeRow,
  });
}

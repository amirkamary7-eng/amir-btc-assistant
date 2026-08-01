/**
 * Publisher Repository — Data Access Layer
 *
 * Database operations for the Telegram Publisher system:
 *   - tg_publisher_queue (pending / sent / failed / cancelled)
 *   - tg_publisher_log (full send history)
 *
 * No HTTP concerns, no Telegram API calls — just SQL + row serialization.
 */
export function createPublisherRepository(deps) {
  const { queryDb, normalizeOptionalString } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    // DIAGNOSTIC TEST: NO-OP MODE
    _schemaVerified = true;
    return;
    /* eslint-disable no-unreachable */
    if (_schemaVerified) return;
    const batchSql = `
      CREATE TABLE IF NOT EXISTS tg_publisher_queue (
        id BIGSERIAL PRIMARY KEY,
        type VARCHAR(24) NOT NULL,
        ref_id VARCHAR(128) NOT NULL,
        payload JSONB NOT NULL DEFAULT '{}'::jsonb,
        status VARCHAR(16) NOT NULL DEFAULT 'pending',
        priority INTEGER NOT NULL DEFAULT 100,
        attempts INTEGER NOT NULL DEFAULT 0,
        max_attempts INTEGER NOT NULL DEFAULT 3,
        scheduled_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        sent_at TIMESTAMPTZ,
        error TEXT,
        tg_message_id BIGINT,
        tg_chat_id VARCHAR(64),
        final_text TEXT,
        final_payload JSONB,
        created_by VARCHAR(64),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tgpq_status_scheduled ON tg_publisher_queue (status, scheduled_at) WHERE status = 'pending';
      CREATE INDEX IF NOT EXISTS idx_tgpq_type_ref ON tg_publisher_queue (type, ref_id);
      CREATE INDEX IF NOT EXISTS idx_tgpq_sent_at ON tg_publisher_queue (sent_at DESC) WHERE status = 'sent';
      CREATE INDEX IF NOT EXISTS idx_tgpq_created ON tg_publisher_queue (created_at DESC);

      CREATE TABLE IF NOT EXISTS tg_publisher_log (
        id BIGSERIAL PRIMARY KEY,
        queue_id BIGINT,
        type VARCHAR(24) NOT NULL,
        ref_id VARCHAR(128) NOT NULL,
        status VARCHAR(16) NOT NULL,
        error TEXT,
        telegram_response JSONB,
        duration_ms INTEGER,
        message_text TEXT,
        tg_message_id BIGINT,
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_tgpl_created ON tg_publisher_log (created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_tgpl_queue ON tg_publisher_log (queue_id);
    `;
    try {
      await queryDb(env, batchSql, []);
      _schemaVerified = true;
    } catch (e) {
      console.warn('[publisher] ensureSchema failed:', e?.message || e);
      // Non-fatal — table may already exist, or DB unavailable. Queries below will fail loudly.
    }
  }

  function serializeQueueRow(row) {
    if (!row) return null;
    return {
      id: String(row.id),
      type: row.type,
      ref_id: row.ref_id,
      payload: row.payload || {},
      status: row.status,
      priority: Number(row.priority || 100),
      attempts: Number(row.attempts || 0),
      max_attempts: Number(row.max_attempts || 3),
      scheduled_at: row.scheduled_at ? new Date(row.scheduled_at).toISOString() : null,
      sent_at: row.sent_at ? new Date(row.sent_at).toISOString() : null,
      error: normalizeOptionalString(row.error) || '',
      tg_message_id: row.tg_message_id != null ? Number(row.tg_message_id) : null,
      tg_chat_id: normalizeOptionalString(row.tg_chat_id) || '',
      final_text: normalizeOptionalString(row.final_text) || '',
      final_payload: row.final_payload || null,
      created_by: normalizeOptionalString(row.created_by) || '',
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  function serializeLogRow(row) {
    if (!row) return null;
    return {
      id: String(row.id),
      queue_id: row.queue_id != null ? String(row.queue_id) : null,
      type: row.type,
      ref_id: row.ref_id,
      status: row.status,
      error: normalizeOptionalString(row.error) || '',
      telegram_response: row.telegram_response || null,
      duration_ms: Number(row.duration_ms || 0),
      message_text: normalizeOptionalString(row.message_text) || '',
      tg_message_id: row.tg_message_id != null ? Number(row.tg_message_id) : null,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  async function enqueue(env, item) {
    await ensureSchema(env);
    const sql = `
      INSERT INTO tg_publisher_queue
        (type, ref_id, payload, status, priority, max_attempts, scheduled_at, created_by)
      VALUES ($1, $2, $3::jsonb, 'pending', $4, $5, $6, $7)
      RETURNING *;
    `;
    const params = [
      item.type,
      String(item.ref_id || '').slice(0, 128),
      JSON.stringify(item.payload || {}),
      Number(item.priority ?? 100),
      Number(item.max_attempts ?? 3),
      item.scheduled_at || new Date().toISOString(),
      normalizeOptionalString(item.created_by) || null,
    ];
    const res = await queryDb(env, sql, params);
    return serializeQueueRow(res.rows[0]);
  }

  async function listByStatus(env, status, { page = 1, limit = 50 } = {}) {
    await ensureSchema(env);
    const offset = Math.max(0, (Number(page) - 1) * Number(limit));
    const sql = `
      SELECT * FROM tg_publisher_queue
      WHERE status = $1
      ORDER BY ${status === 'pending' ? 'priority ASC, scheduled_at ASC' : 'sent_at DESC NULLS LAST, created_at DESC'}
      LIMIT $2 OFFSET $3;
    `;
    const res = await queryDb(env, sql, [status, Number(limit), offset]);
    return res.rows.map(serializeQueueRow);
  }

  async function listSent(env, { page = 1, limit = 50 } = {}) {
    return listByStatus(env, 'sent', { page, limit });
  }
  async function listFailed(env, { page = 1, limit = 50 } = {}) {
    return listByStatus(env, 'failed', { page, limit });
  }
  async function listPending(env, { page = 1, limit = 50 } = {}) {
    return listByStatus(env, 'pending', { page, limit });
  }

  async function listLogs(env, { page = 1, limit = 50, queueId = null } = {}) {
    await ensureSchema(env);
    const offset = Math.max(0, (Number(page) - 1) * Number(limit));
    let sql, params;
    if (queueId) {
      sql = `SELECT * FROM tg_publisher_log WHERE queue_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3;`;
      params = [queueId, Number(limit), offset];
    } else {
      sql = `SELECT * FROM tg_publisher_log ORDER BY created_at DESC LIMIT $1 OFFSET $2;`;
      params = [Number(limit), offset];
    }
    const res = await queryDb(env, sql, params);
    return res.rows.map(serializeLogRow);
  }

  async function getById(env, id) {
    await ensureSchema(env);
    const res = await queryDb(env, `SELECT * FROM tg_publisher_queue WHERE id = $1;`, [String(id)]);
    return serializeQueueRow(res.rows[0]);
  }

  async function markSent(env, id, { tgMessageId, tgChatId, finalText, finalPayload }) {
    await ensureSchema(env);
    const sql = `
      UPDATE tg_publisher_queue
      SET status = 'sent', sent_at = NOW(), tg_message_id = $2, tg_chat_id = $3,
          final_text = $4, final_payload = $5::jsonb, error = NULL
      WHERE id = $1
      RETURNING *;
    `;
    const res = await queryDb(env, sql, [
      String(id),
      tgMessageId != null ? Number(tgMessageId) : null,
      normalizeOptionalString(tgChatId) || null,
      finalText || '',
      JSON.stringify(finalPayload || {}),
    ]);
    return serializeQueueRow(res.rows[0]);
  }

  async function markFailed(env, id, errorMessage, { finalAttempts = null } = {}) {
    await ensureSchema(env);
    const sql = `
      UPDATE tg_publisher_queue
      SET status = CASE WHEN attempts >= max_attempts THEN 'failed' ELSE 'pending' END,
          attempts = attempts + 1,
          error = $2,
          scheduled_at = CASE WHEN attempts < max_attempts THEN NOW() + INTERVAL '30 seconds' ELSE scheduled_at END
      WHERE id = $1
      RETURNING *;
    `;
    const res = await queryDb(env, sql, [String(id), String(errorMessage || '').slice(0, 1000)]);
    return serializeQueueRow(res.rows[0]);
  }

  async function cancel(env, id) {
    await ensureSchema(env);
    const res = await queryDb(env, `
      UPDATE tg_publisher_queue SET status = 'cancelled' WHERE id = $1 AND status = 'pending' RETURNING *;
    `, [String(id)]);
    return serializeQueueRow(res.rows[0]);
  }

  async function retry(env, id) {
    await ensureSchema(env);
    // Reset a failed item back to pending with fresh attempts
    const res = await queryDb(env, `
      UPDATE tg_publisher_queue
      SET status = 'pending', attempts = 0, error = NULL, scheduled_at = NOW()
      WHERE id = $1 AND status IN ('failed', 'cancelled')
      RETURNING *;
    `, [String(id)]);
    return serializeQueueRow(res.rows[0]);
  }

  async function deleteLogEntry(env, id) {
    await ensureSchema(env);
    await queryDb(env, `DELETE FROM tg_publisher_queue WHERE id = $1 AND status IN ('sent', 'cancelled');`, [String(id)]);
    return true;
  }

  async function insertLog(env, entry) {
    await ensureSchema(env);
    const sql = `
      INSERT INTO tg_publisher_log
        (queue_id, type, ref_id, status, error, telegram_response, duration_ms, message_text, tg_message_id)
      VALUES ($1, $2, $3, $4, $5, $6::jsonb, $7, $8, $9)
      RETURNING *;
    `;
    const params = [
      entry.queue_id ? Number(entry.queue_id) : null,
      entry.type || '',
      String(entry.ref_id || ''),
      entry.status || '',
      normalizeOptionalString(entry.error) || null,
      JSON.stringify(entry.telegram_response || {}),
      Number(entry.duration_ms || 0),
      normalizeOptionalString(entry.message_text) || null,
      entry.tg_message_id != null ? Number(entry.tg_message_id) : null,
    ];
    const res = await queryDb(env, sql, params);
    return serializeLogRow(res.rows[0]);
  }

  async function claimPendingBatch(env, batchSize = 10) {
    // Atomically claim pending items ready to send.
    // Uses SKIP LOCKED so multiple cron ticks never grab the same items.
    await ensureSchema(env);
    const sql = `
      WITH claimed AS (
        SELECT id FROM tg_publisher_queue
        WHERE status = 'pending' AND scheduled_at <= NOW()
        ORDER BY priority ASC, scheduled_at ASC
        LIMIT $1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE tg_publisher_queue
      SET status = 'processing'
      FROM claimed
      WHERE tg_publisher_queue.id = claimed.id
      RETURNING tg_publisher_queue.*;
    `;
    const res = await queryDb(env, sql, [Number(batchSize)]);
    return res.rows.map(serializeQueueRow);
  }

  async function checkDedup(env, type, refId) {
    // Has this (type, ref_id) been sent in the last 24h?
    await ensureSchema(env);
    const sql = `
      SELECT id, sent_at, tg_message_id, tg_chat_id
      FROM tg_publisher_queue
      WHERE type = $1 AND ref_id = $2 AND status = 'sent'
        AND sent_at >= NOW() - INTERVAL '24 hours'
      ORDER BY sent_at DESC
      LIMIT 1;
    `;
    const res = await queryDb(env, sql, [type, String(refId).slice(0, 128)]);
    return res.rows[0] ? {
      published: true,
      lastSentAt: res.rows[0].sent_at ? new Date(res.rows[0].sent_at).toISOString() : null,
      messageId: res.rows[0].tg_message_id != null ? Number(res.rows[0].tg_message_id) : null,
      chatId: res.rows[0].tg_chat_id || '',
    } : { published: false };
  }

  async function getStats(env) {
    await ensureSchema(env);
    const sql = `
      SELECT
        COUNT(*) FILTER (WHERE status = 'pending') AS pending,
        COUNT(*) FILTER (WHERE status = 'sent' AND sent_at >= NOW() - INTERVAL '24 hours') AS sent_24h,
        COUNT(*) FILTER (WHERE status = 'failed' AND created_at >= NOW() - INTERVAL '24 hours') AS failed_24h,
        COUNT(*) FILTER (WHERE status = 'processing') AS processing
      FROM tg_publisher_queue;
    `;
    const res = await queryDb(env, sql, []);
    const r = res.rows[0] || {};
    return {
      pending: Number(r.pending || 0),
      sent_24h: Number(r.sent_24h || 0),
      failed_24h: Number(r.failed_24h || 0),
      processing: Number(r.processing || 0),
    };
  }

  return {
    ensureSchema,
    enqueue,
    listByStatus,
    listSent,
    listFailed,
    listPending,
    listLogs,
    getById,
    markSent,
    markFailed,
    cancel,
    retry,
    deleteLogEntry,
    insertLog,
    claimPendingBatch,
    checkDedup,
    getStats,
  };
}

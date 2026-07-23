/**
 * Ticket Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to support tickets.
 * No HTTP concerns, no notification logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createTicketRepository(deps) {
  const { queryDb, ensureUserRow, normalizeOptionalString } = deps;

  /**
   * Serialize a raw ticket_replies row.
   */
  function serializeReplyRow(row) {
    const senderType = String(row.sender_type || 'user').trim().toLowerCase();
    return {
      message: row.message,
      from: senderType === 'admin' ? 'admin' : 'user',
      at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /**
   * Serialize a raw tickets row with its replies.
   */
  function serializeRow(row, replies = []) {
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      user_name: row.user_name,
      title: row.title,
      body: row.body,
      status: row.status,
      replies,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /**
   * Load replies for a single ticket from DB.
   */
  async function getReplies(env, ticketId) {
    const result = await queryDb(
      env,
      `
        SELECT sender_type, message, created_at
        FROM ticket_replies
        WHERE ticket_id = $1
        ORDER BY created_at ASC, id ASC
      `,
      [String(ticketId)],
    );
    return result.rows.map((row) => serializeReplyRow(row));
  }

  /**
   * Hydrate a ticket row by attaching its replies.
   */
  async function hydrateRow(env, row) {
    const replies = await getReplies(env, row.id);
    return serializeRow(row, replies);
  }

  /**
   * Create a new ticket and return the hydrated row.
   */
  async function create(env, user, payload) {
    const userId = String(user.id);
    const displayName =
      normalizeOptionalString(user.username)
      || normalizeOptionalString(user.first_name)
      || normalizeOptionalString(payload.user_name)
      || userId;
    await ensureUserRow(env, userId);
    const result = await queryDb(
      env,
      `
        INSERT INTO tickets (id, user_id, user_name, title, body, status, created_at, updated_at)
        VALUES ($1, $2, $3, $4, $5, 'open', NOW(), NOW())
        RETURNING id, user_id, user_name, title, body, status, created_at
      `,
      [
        String(globalThis.crypto?.randomUUID?.() || `${Date.now()}${Math.random()}`).replace(/-/g, '').slice(0, 16),
        userId,
        displayName,
        normalizeOptionalString(payload.title) || '',
        normalizeOptionalString(payload.body) || '',
      ],
    );
    return hydrateRow(env, result.rows[0]);
  }

  /**
   * List tickets, optionally filtered by userId.
   * Uses a batch reply query for efficiency.
   */
  async function list(env, userId = null) {
    const ticketRows = userId
      ? await queryDb(
        env,
        `
          SELECT id, user_id, user_name, title, body, status, created_at
          FROM tickets
          WHERE user_id = $1
          ORDER BY created_at DESC
        `,
        [String(userId)],
      )
      : await queryDb(
        env,
        `
          SELECT id, user_id, user_name, title, body, status, created_at
          FROM tickets
          ORDER BY created_at DESC
        `,
      );
    if (ticketRows.rows.length === 0) return [];
    const ticketIds = ticketRows.rows.map((r) => String(r.id));
    const replyResult = await queryDb(
      env,
      `
        SELECT ticket_id, sender_type, message, created_at
        FROM ticket_replies
        WHERE ticket_id = ANY($1)
        ORDER BY ticket_id, created_at ASC, id ASC
      `,
      [ticketIds],
    );
    const repliesByTicket = new Map();
    for (const row of replyResult.rows) {
      const tid = String(row.ticket_id);
      if (!repliesByTicket.has(tid)) repliesByTicket.set(tid, []);
      repliesByTicket.get(tid).push(serializeReplyRow(row));
    }
    return ticketRows.rows.map((row) =>
      serializeRow(row, repliesByTicket.get(String(row.id)) || []),
    );
  }

  /**
   * Get a raw ticket row by ID (no replies).
   */
  async function findById(env, ticketId) {
    const result = await queryDb(
      env,
      `
        SELECT id, user_id, user_name, title, body, status, created_at
        FROM tickets
        WHERE id = $1
        LIMIT 1
      `,
      [String(ticketId)],
    );
    return result.rows[0] || null;
  }

  /**
   * Add an admin reply to a ticket and return the hydrated ticket.
   * Returns null if the ticket doesn't exist.
   */
  async function reply(env, ticketId, adminId, message) {
    const ticketRow = await findById(env, ticketId);
    if (!ticketRow) {
      return null;
    }
    await queryDb(
      env,
      `
        INSERT INTO ticket_replies (ticket_id, sender_type, sender_id, message, created_at)
        VALUES ($1, 'admin', $2, $3, NOW())
      `,
      [String(ticketId), String(adminId), message],
    );
    await queryDb(
      env,
      `
        UPDATE tickets
        SET status = 'answered', updated_at = NOW()
        WHERE id = $1
      `,
      [String(ticketId)],
    );
    const updatedTicketRow = await findById(env, ticketId);
    return hydrateRow(env, updatedTicketRow || ticketRow);
  }

  /**
   * Delete a ticket by ID.
   */
  async function remove(env, ticketId) {
    await queryDb(env, 'DELETE FROM tickets WHERE id = $1', [String(ticketId)]);
  }

  return Object.freeze({ create, list, findById, reply, remove, hydrateRow });
}
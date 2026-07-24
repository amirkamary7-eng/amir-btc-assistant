/**
 * Admin Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to the admin panel.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createAdminRepository(deps) {
  const { queryDb, normalizeOptionalString } = deps;

  // ---------------------------------------------------------------------------
  // Helpers
  // ---------------------------------------------------------------------------

  function isoDate(val) {
    return val ? new Date(val).toISOString() : null;
  }

  function paginate(page, limit) {
    const p = Math.max(1, Number(page) || 1);
    const l = Math.max(1, Math.min(100, Number(limit) || 20));
    return { offset: (p - 1) * l, limit: l, page: p };
  }

  /**
   * Normalize permissions from DB JSONB to a flat string array.
   * Handles both formats:
   *   - Array:  ["*", "manage_admins"]
   *   - Object: {"all": true} or {"manage_admins": true}
   */
  function normalizePermissions(raw) {
    if (Array.isArray(raw)) return raw;
    if (raw && typeof raw === 'object') {
      // Object like {"all": true} → treat as full access
      if (raw.all === true || raw['*'] === true) return ['*'];
      // Object like {"manage_admins": true, "view_users": true} → extract keys
      const keys = Object.keys(raw).filter((k) => raw[k] === true);
      return keys.length > 0 ? keys : ['*'];
    }
    return [];
  }

  // ---------------------------------------------------------------------------
  // 1. getAdminByTelegramId
  // ---------------------------------------------------------------------------

  async function getAdminByTelegramId(env, telegramId) {
    const result = await queryDb(
      env,
      `
        SELECT id, telegram_id, role, permissions, active, created_at, created_by
        FROM admins
        WHERE telegram_id = $1
        LIMIT 1
      `,
      [String(telegramId)],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      telegram_id: String(row.telegram_id),
      role: normalizeOptionalString(row.role) || 'admin',
      permissions: normalizePermissions(row.permissions),
      active: Boolean(row.active),
      created_at: isoDate(row.created_at),
      created_by: normalizeOptionalString(row.created_by),
    };
  }

  // ---------------------------------------------------------------------------
  // 2. listAdmins
  // ---------------------------------------------------------------------------

  async function listAdmins(env) {
    const result = await queryDb(
      env,
      `
        SELECT
          a.id, a.telegram_id, a.role, a.permissions, a.active,
          a.created_at, a.created_by,
          u.username, u.first_name, u.last_name
        FROM admins a
        LEFT JOIN users u ON u.telegram_id = a.telegram_id
        ORDER BY a.created_at ASC
      `,
    );
    return result.rows.map((row) => ({
      id: row.id,
      telegram_id: String(row.telegram_id),
      role: normalizeOptionalString(row.role) || 'admin',
      permissions: normalizePermissions(row.permissions),
      active: Boolean(row.active),
      created_at: isoDate(row.created_at),
      created_by: normalizeOptionalString(row.created_by),
      username: normalizeOptionalString(row.username),
      first_name: normalizeOptionalString(row.first_name),
      last_name: normalizeOptionalString(row.last_name),
    }));
  }

  // ---------------------------------------------------------------------------
  // 3. addAdmin
  // ---------------------------------------------------------------------------

  async function addAdmin(env, { telegram_id, role, permissions, created_by }) {
    const result = await queryDb(
      env,
      `
        INSERT INTO admins (telegram_id, role, permissions, created_by)
        VALUES ($1, $2, $3, $4)
        ON CONFLICT (telegram_id) DO NOTHING
        RETURNING id, telegram_id, role, permissions, active, created_at, created_by
      `,
      [
        String(telegram_id),
        normalizeOptionalString(role) || 'admin',
        JSON.stringify(Array.isArray(permissions) ? permissions : []),
        normalizeOptionalString(created_by),
      ],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      telegram_id: String(row.telegram_id),
      role: normalizeOptionalString(row.role) || 'admin',
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
      active: Boolean(row.active),
      created_at: isoDate(row.created_at),
      created_by: normalizeOptionalString(row.created_by),
    };
  }

  // ---------------------------------------------------------------------------
  // 4. updateAdmin
  // ---------------------------------------------------------------------------

  async function updateAdmin(env, id, { role, permissions, active }) {
    const parts = [];
    const values = [];
    let paramIdx = 1;

    if (role !== undefined) {
      parts.push(`role = $${paramIdx++}`);
      values.push(normalizeOptionalString(role) || 'admin');
    }
    if (permissions !== undefined) {
      parts.push(`permissions = $${paramIdx++}`);
      values.push(JSON.stringify(Array.isArray(permissions) ? permissions : []));
    }
    if (active !== undefined) {
      parts.push(`active = $${paramIdx++}`);
      values.push(Boolean(active));
    }

    if (parts.length === 0) {
      return getAdminByTelegramId(env, String(id));
    }

    values.push(Number(id));
    const result = await queryDb(
      env,
      `
        UPDATE admins
        SET ${parts.join(', ')}
        WHERE id = $${paramIdx}
        RETURNING id, telegram_id, role, permissions, active, created_at, created_by
      `,
      values,
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      telegram_id: String(row.telegram_id),
      role: normalizeOptionalString(row.role) || 'admin',
      permissions: Array.isArray(row.permissions) ? row.permissions : [],
      active: Boolean(row.active),
      created_at: isoDate(row.created_at),
      created_by: normalizeOptionalString(row.created_by),
    };
  }

  // ---------------------------------------------------------------------------
  // 5. deleteAdmin
  // ---------------------------------------------------------------------------

  async function deleteAdmin(env, id) {
    const result = await queryDb(
      env,
      'DELETE FROM admins WHERE id = $1 RETURNING id',
      [Number(id)],
    );
    return result.rows.length > 0;
  }

  // ---------------------------------------------------------------------------
  // 6. isSuperAdmin
  // ---------------------------------------------------------------------------

  function isSuperAdmin(env, telegramId) {
    const envAdmin = normalizeOptionalString(env.ADMIN_TELEGRAM_ID);
    if (!envAdmin) return false;
    return String(envAdmin) === String(telegramId);
  }

  // ---------------------------------------------------------------------------
  // 7. getDashboardStats
  // ---------------------------------------------------------------------------

  async function getDashboardStats(env) {
    // BUG FIX: Use Promise.allSettled — if ANY query fails (missing table, DB error),
    // the other queries still return data. Previously Promise.all caused the ENTIRE
    // dashboard to fail if one table didn't exist or one query timed out.
    const results = await Promise.allSettled([
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users'),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM users WHERE created_at >= CURRENT_DATE"),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM analyses'),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM tickets WHERE status = 'open'"),
      queryDb(env, 'SELECT COALESCE(SUM(balance), 0) AS total FROM token_balances'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM token_transactions'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users WHERE channel_joined = TRUE'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM admins'),
    ]);

    const val = (r, fallback = 0) => r.status === 'fulfilled' ? Number(r.value?.rows?.[0]?.cnt || r.value?.rows?.[0]?.total || fallback) : fallback;

    return {
      total_users: val(results[0]),
      users_today: val(results[1]),
      total_analyses: val(results[2]),
      open_tickets: val(results[3]),
      total_token_balances: val(results[4]),
      total_transactions: val(results[5]),
      active_today: val(results[6]),
      admins_count: val(results[7]),
    };
  }

  // ---------------------------------------------------------------------------
  // 8. searchUsers
  // ---------------------------------------------------------------------------

  async function searchUsers(env, { search, page, limit }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const term = (normalizeOptionalString(search) || '').trim();
    const whereClause = term
      ? `WHERE u.telegram_id ILIKE $1 OR u.username ILIKE $1 OR u.first_name ILIKE $1 OR u.last_name ILIKE $1`
      : '';
    const pattern = `%${term}%`;

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM users u ${whereClause}`,
      term ? [pattern] : [],
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT
          u.telegram_id, u.username, u.first_name, u.last_name,
          u.channel_joined, u.created_at,
          tb.balance
        FROM users u
        LEFT JOIN token_balances tb ON tb.user_id = u.telegram_id
        ${whereClause}
        ORDER BY u.created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
      term ? [pattern] : [],
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      users: dataResult.rows.map((r) => ({
        telegram_id: String(r.telegram_id),
        username: normalizeOptionalString(r.username),
        first_name: normalizeOptionalString(r.first_name),
        last_name: normalizeOptionalString(r.last_name),
        channel_joined: Boolean(r.channel_joined),
        token_balance: Number(r.balance || 0),
        created_at: isoDate(r.created_at),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 9. getUserDetail
  // ---------------------------------------------------------------------------

  async function getUserDetail(env, telegramId) {
    const userResult = await queryDb(
      env,
      `
        SELECT telegram_id, username, first_name, last_name, lang,
               channel_joined, channel_verified_at, created_at, updated_at
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
      `,
      [String(telegramId)],
    );
    if (!userResult.rows[0]) return null;
    const u = userResult.rows[0];

    const [balRes, refRes] = await Promise.all([
      queryDb(env, 'SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1', [String(telegramId)]),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM referrals WHERE inviter_id = $1', [String(telegramId)]),
    ]);

    return {
      telegram_id: String(u.telegram_id),
      username: normalizeOptionalString(u.username),
      first_name: normalizeOptionalString(u.first_name),
      last_name: normalizeOptionalString(u.last_name),
      lang: normalizeOptionalString(u.lang),
      channel_joined: Boolean(u.channel_joined),
      channel_verified_at: isoDate(u.channel_verified_at),
      created_at: isoDate(u.created_at),
      updated_at: isoDate(u.updated_at),
      token_balance: Number(balRes.rows[0]?.balance || 0),
      referral_count: Number(refRes.rows[0]?.cnt || 0),
    };
  }

  // ---------------------------------------------------------------------------
  // 10. listTicketsAdmin
  // ---------------------------------------------------------------------------

  async function listTicketsAdmin(env, { status, page, limit }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const statusFilter = normalizeOptionalString(status);
    const whereClause = statusFilter ? 'WHERE t.status = $1' : '';
    const countParams = statusFilter ? [statusFilter] : [];

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM tickets t ${whereClause}`,
      countParams,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataParams = statusFilter ? [statusFilter] : [];
    const dataResult = await queryDb(
      env,
      `
        SELECT
          t.id, t.user_id, t.user_name, t.title, t.body, t.status,
          t.created_at, t.updated_at,
          u.username, u.first_name, u.last_name
        FROM tickets t
        LEFT JOIN users u ON u.telegram_id = t.user_id
        ${whereClause}
        ORDER BY t.created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
      dataParams,
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      tickets: dataResult.rows.map((r) => ({
        id: String(r.id),
        user_id: String(r.user_id),
        user_name: normalizeOptionalString(r.user_name),
        title: normalizeOptionalString(r.title),
        body: normalizeOptionalString(r.body),
        status: normalizeOptionalString(r.status),
        created_at: isoDate(r.created_at),
        updated_at: isoDate(r.updated_at),
        username: normalizeOptionalString(r.username),
        first_name: normalizeOptionalString(r.first_name),
        last_name: normalizeOptionalString(r.last_name),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 11. updateTicketStatus
  // ---------------------------------------------------------------------------

  async function updateTicketStatus(env, ticketId, status) {
    const result = await queryDb(
      env,
      `
        UPDATE tickets
        SET status = $1, updated_at = NOW()
        WHERE id = $2
        RETURNING id, user_id, user_name, title, body, status, created_at, updated_at
      `,
      [String(status), String(ticketId)],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      user_name: normalizeOptionalString(row.user_name),
      title: normalizeOptionalString(row.title),
      body: normalizeOptionalString(row.body),
      status: normalizeOptionalString(row.status),
      created_at: isoDate(row.created_at),
      updated_at: isoDate(row.updated_at),
    };
  }

  // ---------------------------------------------------------------------------
  // 12. listBroadcasts
  // ---------------------------------------------------------------------------

  async function listBroadcasts(env, { page, limit }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);

    const countResult = await queryDb(env, 'SELECT COUNT(*) AS cnt FROM broadcasts');
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT id, sender_id, target_type, target_value, message_type,
               content, status, sent_count, failed_count, created_at
        FROM broadcasts
        ORDER BY created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      broadcasts: dataResult.rows.map((r) => ({
        id: r.id,
        sender_id: String(r.sender_id),
        target_type: normalizeOptionalString(r.target_type) || 'all',
        target_value: normalizeOptionalString(r.target_value),
        message_type: normalizeOptionalString(r.message_type) || 'text',
        content: normalizeOptionalString(r.content) || '',
        status: normalizeOptionalString(r.status) || 'pending',
        sent_count: Number(r.sent_count || 0),
        failed_count: Number(r.failed_count || 0),
        created_at: isoDate(r.created_at),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 13. createBroadcast
  // ---------------------------------------------------------------------------

  async function createBroadcast(env, { sender_id, target_type, target_value, message_type, content }) {
    const result = await queryDb(
      env,
      `
        INSERT INTO broadcasts (sender_id, target_type, target_value, message_type, content)
        VALUES ($1, $2, $3, $4, $5)
        RETURNING id, sender_id, target_type, target_value, message_type,
                  content, status, sent_count, failed_count, created_at
      `,
      [
        String(sender_id),
        normalizeOptionalString(target_type) || 'all',
        normalizeOptionalString(target_value),
        normalizeOptionalString(message_type) || 'text',
        normalizeOptionalString(content) || '',
      ],
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      sender_id: String(r.sender_id),
      target_type: normalizeOptionalString(r.target_type) || 'all',
      target_value: normalizeOptionalString(r.target_value),
      message_type: normalizeOptionalString(r.message_type) || 'text',
      content: normalizeOptionalString(r.content) || '',
      status: normalizeOptionalString(r.status) || 'pending',
      sent_count: Number(r.sent_count || 0),
      failed_count: Number(r.failed_count || 0),
      created_at: isoDate(r.created_at),
    };
  }

  // ---------------------------------------------------------------------------
  // 14. updateBroadcastStatus
  // ---------------------------------------------------------------------------

  async function updateBroadcastStatus(env, id, { status, sent_count, failed_count }) {
    const parts = [];
    const values = [];
    let paramIdx = 1;

    if (status !== undefined) {
      parts.push(`status = $${paramIdx++}`);
      values.push(String(status));
    }
    if (sent_count !== undefined) {
      parts.push(`sent_count = $${paramIdx++}`);
      values.push(Number(sent_count));
    }
    if (failed_count !== undefined) {
      parts.push(`failed_count = $${paramIdx++}`);
      values.push(Number(failed_count));
    }

    if (parts.length === 0) return null;

    values.push(Number(id));
    const result = await queryDb(
      env,
      `
        UPDATE broadcasts
        SET ${parts.join(', ')}
        WHERE id = $${paramIdx}
        RETURNING id, sender_id, target_type, target_value, message_type,
                  content, status, sent_count, failed_count, created_at
      `,
      values,
    );
    if (!result.rows[0]) return null;
    const r = result.rows[0];
    return {
      id: r.id,
      sender_id: String(r.sender_id),
      target_type: normalizeOptionalString(r.target_type) || 'all',
      target_value: normalizeOptionalString(r.target_value),
      message_type: normalizeOptionalString(r.message_type) || 'text',
      content: normalizeOptionalString(r.content) || '',
      status: normalizeOptionalString(r.status) || 'pending',
      sent_count: Number(r.sent_count || 0),
      failed_count: Number(r.failed_count || 0),
      created_at: isoDate(r.created_at),
    };
  }

  // ---------------------------------------------------------------------------
  // 15. listRewards
  // ---------------------------------------------------------------------------

  async function listRewards(env, { page, limit, status }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const statusFilter = normalizeOptionalString(status);
    const whereClause = statusFilter ? 'WHERE r.status = $1' : '';
    const params = statusFilter ? [statusFilter] : [];

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM rewards r ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT
          r.id, r.user_id, r.prize_type, r.prize_value, r.status,
          r.claimed_at, r.created_at,
          u.username, u.first_name, u.last_name
        FROM rewards r
        LEFT JOIN users u ON u.telegram_id = r.user_id
        ${whereClause}
        ORDER BY r.created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
      params,
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      rewards: dataResult.rows.map((row) => ({
        id: row.id,
        user_id: String(row.user_id),
        prize_type: normalizeOptionalString(row.prize_type),
        prize_value: normalizeOptionalString(row.prize_value),
        status: normalizeOptionalString(row.status) || 'pending',
        claimed_at: isoDate(row.claimed_at),
        created_at: isoDate(row.created_at),
        username: normalizeOptionalString(row.username),
        first_name: normalizeOptionalString(row.first_name),
        last_name: normalizeOptionalString(row.last_name),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 16. updateRewardStatus
  // ---------------------------------------------------------------------------

  async function updateRewardStatus(env, id, status) {
    const updates = status === 'claimed'
      ? "SET status = $1, claimed_at = NOW()"
      : "SET status = $1";
    const result = await queryDb(
      env,
      `
        UPDATE rewards ${updates}
        WHERE id = $2
        RETURNING id, user_id, prize_type, prize_value, status, claimed_at, created_at
      `,
      [String(status), Number(id)],
    );
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: row.id,
      user_id: String(row.user_id),
      prize_type: normalizeOptionalString(row.prize_type),
      prize_value: normalizeOptionalString(row.prize_value),
      status: normalizeOptionalString(row.status) || 'pending',
      claimed_at: isoDate(row.claimed_at),
      created_at: isoDate(row.created_at),
    };
  }

  // ---------------------------------------------------------------------------
  // 17. listTransactions
  // ---------------------------------------------------------------------------

  async function listTransactions(env, { page, limit, user_id, tx_type }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const conditions = [];
    const params = [];
    let paramIdx = 1;

    if (normalizeOptionalString(user_id)) {
      conditions.push(`t.user_id = $${paramIdx++}`);
      params.push(String(user_id));
    }
    if (normalizeOptionalString(tx_type)) {
      conditions.push(`t.tx_type = $${paramIdx++}`);
      params.push(String(tx_type));
    }
    const whereClause = conditions.length > 0 ? `WHERE ${conditions.join(' AND ')}` : '';

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM token_transactions t ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT
          t.id, t.user_id, t.amount, t.tx_type, t.description, t.ref_id, t.created_at,
          u.username, u.first_name, u.last_name
        FROM token_transactions t
        LEFT JOIN users u ON u.telegram_id = t.user_id
        ${whereClause}
        ORDER BY t.created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
      params,
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      transactions: dataResult.rows.map((r) => ({
        id: r.id,
        user_id: String(r.user_id),
        amount: Number(r.amount),
        tx_type: normalizeOptionalString(r.tx_type),
        description: normalizeOptionalString(r.description),
        ref_id: normalizeOptionalString(r.ref_id),
        created_at: isoDate(r.created_at),
        username: normalizeOptionalString(r.username),
        first_name: normalizeOptionalString(r.first_name),
        last_name: normalizeOptionalString(r.last_name),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 18. listReferrals
  // ---------------------------------------------------------------------------

  async function listReferrals(env, { page, limit, search }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const term = (normalizeOptionalString(search) || '').trim();
    const whereClause = term
      ? `WHERE inv.username ILIKE $1 OR inv.first_name ILIKE $1
            OR inv.telegram_id ILIKE $1
            OR invi.username ILIKE $1 OR invi.first_name ILIKE $1
            OR invi.telegram_id ILIKE $1`
      : '';
    const pattern = `%${term}%`;
    const params = term ? [pattern] : [];

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM referrals rf
       LEFT JOIN users inv ON inv.telegram_id = rf.inviter_id
       LEFT JOIN users invi ON invi.telegram_id = rf.invitee_id
       ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT
          rf.inviter_id, rf.invitee_id, rf.channel_verified, rf.rewarded, rf.created_at,
          inv.username AS inviter_username, inv.first_name AS inviter_first_name,
          invi.username AS invitee_username, invi.first_name AS invitee_first_name
        FROM referrals rf
        LEFT JOIN users inv ON inv.telegram_id = rf.inviter_id
        LEFT JOIN users invi ON invi.telegram_id = rf.invitee_id
        ${whereClause}
        ORDER BY rf.created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
      params,
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      referrals: dataResult.rows.map((r) => ({
        inviter_id: String(r.inviter_id),
        invitee_id: String(r.invitee_id),
        channel_verified: Boolean(r.channel_verified),
        rewarded: Boolean(r.rewarded),
        created_at: isoDate(r.created_at),
        inviter_username: normalizeOptionalString(r.inviter_username),
        inviter_first_name: normalizeOptionalString(r.inviter_first_name),
        invitee_username: normalizeOptionalString(r.invitee_username),
        invitee_first_name: normalizeOptionalString(r.invitee_first_name),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 19. getRecentActivity
  // ---------------------------------------------------------------------------

  async function getRecentActivity(env, limit = 20) {
    const lim = Math.max(1, Math.min(50, Number(limit) || 20));

    // BUG FIX: Use Promise.allSettled — if admin_logs table doesn't exist,
    // still return analyses + tickets activity instead of failing everything.
    const results = await Promise.allSettled([
      queryDb(env, `SELECT id, admin_id, action, target_type, target_id, created_at FROM admin_logs ORDER BY created_at DESC LIMIT $1`, [lim]),
      queryDb(env, `SELECT id, coin, author, created_at FROM analyses ORDER BY created_at DESC LIMIT $1`, [lim]),
      queryDb(env, `SELECT id, user_id, title, status, created_at FROM tickets ORDER BY created_at DESC LIMIT $1`, [lim]),
    ]);

    const rows = (r) => r.status === 'fulfilled' ? r.value.rows : [];
    const logsRes = rows(results[0]);
    const analysesRes = rows(results[1]);
    const ticketsRes = rows(results[2]);

    return {
      admin_logs: logsRes.map((r) => ({
        id: r.id,
        admin_id: String(r.admin_id),
        action: normalizeOptionalString(r.action),
        target_type: normalizeOptionalString(r.target_type),
        target_id: normalizeOptionalString(r.target_id),
        created_at: isoDate(r.created_at),
      })),
      analyses: analysesRes.map((r) => ({
        id: String(r.id),
        coin: normalizeOptionalString(r.coin),
        author: normalizeOptionalString(r.author),
        created_at: isoDate(r.created_at),
      })),
      tickets: ticketsRes.map((r) => ({
        id: String(r.id),
        user_id: String(r.user_id),
        title: normalizeOptionalString(r.title),
        status: normalizeOptionalString(r.status),
        created_at: isoDate(r.created_at),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 20. logAdminAction
  // ---------------------------------------------------------------------------

  async function logAdminAction(env, { admin_id, action, target_type, target_id, details, ip }) {
    const result = await queryDb(
      env,
      `
        INSERT INTO admin_logs (admin_id, action, target_type, target_id, details, ip)
        VALUES ($1, $2, $3, $4, $5, $6)
        RETURNING id
      `,
      [
        String(admin_id),
        String(action),
        normalizeOptionalString(target_type),
        normalizeOptionalString(target_id),
        details ? JSON.stringify(details) : null,
        normalizeOptionalString(ip),
      ],
    );
    return result.rows[0]?.id || null;
  }

  // ---------------------------------------------------------------------------
  // 21. getAdminLogs
  // ---------------------------------------------------------------------------

  async function getAdminLogs(env, { page, limit, action }) {
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const actionFilter = normalizeOptionalString(action);
    const whereClause = actionFilter ? 'WHERE action = $1' : '';
    const params = actionFilter ? [actionFilter] : [];

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM admin_logs ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT id, admin_id, action, target_type, target_id, details, ip, created_at
        FROM admin_logs
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT ${lim} OFFSET ${offset}
      `,
      params,
    );

    return {
      total,
      page: pg,
      limit: lim,
      has_more: offset + lim < total,
      logs: dataResult.rows.map((r) => ({
        id: r.id,
        admin_id: String(r.admin_id),
        action: normalizeOptionalString(r.action),
        target_type: normalizeOptionalString(r.target_type),
        target_id: normalizeOptionalString(r.target_id),
        details: typeof r.details === 'object' ? r.details : null,
        ip: normalizeOptionalString(r.ip),
        created_at: isoDate(r.created_at),
      })),
    };
  }

  // ---------------------------------------------------------------------------
  // 22. getSystemHealth
  // ---------------------------------------------------------------------------

  async function getSystemHealth(env) {
    const [
      usersRes, adminsRes, ticketsRes, analysesRes, broadcastsRes,
      rewardsRes, logsRes, balancesRes, txRes, referralsRes,
    ] = await Promise.all([
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM admins WHERE active = TRUE'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM tickets'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM analyses'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM broadcasts'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM rewards'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM admin_logs'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM token_balances'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM token_transactions'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM referrals'),
    ]);

    return {
      users: Number(usersRes.rows[0]?.cnt || 0),
      active_admins: Number(adminsRes.rows[0]?.cnt || 0),
      tickets: Number(ticketsRes.rows[0]?.cnt || 0),
      analyses: Number(analysesRes.rows[0]?.cnt || 0),
      broadcasts: Number(broadcastsRes.rows[0]?.cnt || 0),
      rewards: Number(rewardsRes.rows[0]?.cnt || 0),
      admin_logs: Number(logsRes.rows[0]?.cnt || 0),
      token_holders: Number(balancesRes.rows[0]?.cnt || 0),
      transactions: Number(txRes.rows[0]?.cnt || 0),
      referrals: Number(referralsRes.rows[0]?.cnt || 0),
    };
  }

  // ---------------------------------------------------------------------------
  // findTicketById — get ticket row (for reply handler)
  // ---------------------------------------------------------------------------

  async function findTicketById(env, ticketId) {
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
    if (!result.rows[0]) return null;
    const row = result.rows[0];
    return {
      id: String(row.id),
      user_id: String(row.user_id),
      user_name: normalizeOptionalString(row.user_name),
      title: normalizeOptionalString(row.title),
    };
  }

  // ---------------------------------------------------------------------------
  // insertTicketReply — insert a reply into ticket_replies
  // ---------------------------------------------------------------------------

  async function insertTicketReply(env, ticketId, adminId, message) {
    await queryDb(
      env,
      `
        INSERT INTO ticket_replies (ticket_id, sender_type, sender_id, message, created_at)
        VALUES ($1, 'admin', $2, $3, NOW())
      `,
      [String(ticketId), String(adminId), String(message)],
    );
  }

  // ---------------------------------------------------------------------------
  // getBroadcastTargetUsers — resolve target user IDs for a broadcast
  // ---------------------------------------------------------------------------

  async function getBroadcastTargetUsers(env, targetType, targetValue) {
    const type = String(targetType || 'all').trim().toLowerCase();

    if (type === 'all') {
      const result = await queryDb(env, 'SELECT telegram_id FROM users');
      return result.rows.map((r) => String(r.telegram_id));
    }

    if (type === 'channel_joined') {
      const result = await queryDb(env, "SELECT telegram_id FROM users WHERE channel_joined = TRUE");
      return result.rows.map((r) => String(r.telegram_id));
    }

    if (type === 'single' && targetValue) {
      return [String(targetValue)];
    }

    // Unknown target type — return empty
    return [];
  }

  return Object.freeze({
    getAdminByTelegramId,
    listAdmins,
    addAdmin,
    updateAdmin,
    deleteAdmin,
    isSuperAdmin,
    getDashboardStats,
    searchUsers,
    getUserDetail,
    listTicketsAdmin,
    updateTicketStatus,
    listBroadcasts,
    createBroadcast,
    updateBroadcastStatus,
    listRewards,
    updateRewardStatus,
    listTransactions,
    listReferrals,
    getRecentActivity,
    logAdminAction,
    getAdminLogs,
    getSystemHealth,
    findTicketById,
    insertTicketReply,
    getBroadcastTargetUsers,
  });
}
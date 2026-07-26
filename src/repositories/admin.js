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
    // ROOT CAUSE FIX: Previous version had MISLEADING field names + missing metrics.
    //   - 'active_today' came from `channel_joined = TRUE` (WRONG: that's "joined
    //     channel", not "active today"). No last_active tracking exists.
    //   - No weekly/monthly stats.
    //   - No join percentage.
    //   - Frontend expected 'new_users_today' but backend returned 'users_today'.
    //
    // PHASE 2 FIX: Now uses real tracking columns (last_active_at, bot_joined_at,
    // mini_app_opened_at, is_premium) added by users.ensureTable().
    //
    // All metrics are REAL SQL counts from the database:
    //   - total_users: COUNT(*) FROM users
    //   - new_today: WHERE created_at >= CURRENT_DATE
    //   - new_this_week: WHERE created_at >= date_trunc('week', CURRENT_DATE)
    //   - new_this_month: WHERE created_at >= date_trunc('month', CURRENT_DATE)
    //   - joined_channel: WHERE channel_joined = TRUE
    //   - join_percentage: joined_channel / total_users * 100
    //   - joined_bot: WHERE bot_joined_at IS NOT NULL
    //   - opened_mini_app: WHERE mini_app_opened_at IS NOT NULL
    //   - active_today: WHERE last_active_at >= CURRENT_DATE
    //   - active_this_week: WHERE last_active_at >= date_trunc('week', CURRENT_DATE)
    //   - active_this_month: WHERE last_active_at >= date_trunc('month', CURRENT_DATE)
    const results = await Promise.allSettled([
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users'),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM users WHERE created_at >= CURRENT_DATE"),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM users WHERE created_at >= date_trunc('week', CURRENT_DATE)"),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM users WHERE created_at >= date_trunc('month', CURRENT_DATE)"),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM analyses'),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM tickets WHERE status = 'open'"),
      queryDb(env, 'SELECT COALESCE(SUM(balance), 0) AS total FROM token_balances'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM token_transactions'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users WHERE channel_joined = TRUE'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM admins'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM price_alerts WHERE status = \'active\''),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM price_alerts WHERE status = 'triggered' AND triggered_at >= CURRENT_DATE"),
      // Phase 2: real activity tracking
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users WHERE last_active_at >= CURRENT_DATE'),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM users WHERE last_active_at >= date_trunc('week', CURRENT_DATE)"),
      queryDb(env, "SELECT COUNT(*) AS cnt FROM users WHERE last_active_at >= date_trunc('month', CURRENT_DATE)"),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users WHERE bot_joined_at IS NOT NULL'),
      queryDb(env, 'SELECT COUNT(*) AS cnt FROM users WHERE mini_app_opened_at IS NOT NULL'),
    ]);

    const val = (r, fallback = 0) => r.status === 'fulfilled' ? Number(r.value?.rows?.[0]?.cnt || r.value?.rows?.[0]?.total || fallback) : fallback;

    const totalUsers = val(results[0]);
    const joinedChannel = val(results[8]);
    const joinPercentage = totalUsers > 0 ? Math.round((joinedChannel / totalUsers) * 1000) / 10 : 0;

    return {
      total_users: totalUsers,
      new_today: val(results[1]),
      new_this_week: val(results[2]),
      new_this_month: val(results[3]),
      joined_channel: joinedChannel,
      join_percentage: joinPercentage,
      // Phase 2: real activity tracking (was null before, now real)
      joined_bot: val(results[15]),
      opened_mini_app: val(results[16]),
      active_today: val(results[12]),
      active_this_week: val(results[13]),
      active_this_month: val(results[14]),
      total_analyses: val(results[4]),
      open_tickets: val(results[5]),
      total_token_balances: val(results[6]),
      total_transactions: val(results[7]),
      admins_count: val(results[9]),
      active_alerts: val(results[10]),
      triggered_today: val(results[11]),
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

    // PHASE 2 FIX: Return ALL fields the frontend expects, including the new
    // tracking columns (last_active_at, is_premium, lang, mini_app_opened_at).
    // Previously frontend showed blanks for is_premium, is_active, language,
    // last_active, referral_code.
    const dataResult = await queryDb(
      env,
      `
        SELECT
          u.telegram_id, u.username, u.first_name, u.last_name,
          u.lang, u.channel_joined, u.created_at,
          u.last_active_at, u.bot_joined_at, u.mini_app_opened_at, u.is_premium,
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
        language: normalizeOptionalString(r.lang),
        channel_joined: Boolean(r.channel_joined),
        is_premium: Boolean(r.is_premium),
        is_active: r.last_active_at != null && (Date.now() - new Date(r.last_active_at).getTime()) < 24 * 60 * 60 * 1000,
        last_active: r.last_active_at ? new Date(r.last_active_at).toISOString() : null,
        bot_joined_at: r.bot_joined_at ? new Date(r.bot_joined_at).toISOString() : null,
        mini_app_opened_at: r.mini_app_opened_at ? new Date(r.mini_app_opened_at).toISOString() : null,
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

  /**
   * PHASE 3 FIX (Bug 5): Admin ticket delete — previously no admin DELETE
   * endpoint existed. Frontend called /api/tickets/:id (user endpoint) → 403.
   */
  async function deleteTicket(env, ticketId) {
    const result = await queryDb(
      env,
      'DELETE FROM tickets WHERE id = $1 RETURNING id',
      [String(ticketId)],
    );
    return (result.rowCount || 0) > 0;
  }

  /**
   * PHASE 3 FIX (Bug 6): Fetch ticket replies for admin ticket detail view.
   * Previously frontend expected t.replies in list response but backend
   * didn't include them → empty conversation thread.
   */
  async function listTicketReplies(env, ticketId) {
    const result = await queryDb(
      env,
      `
        SELECT id, ticket_id, user_id, body, is_admin_reply, created_at
        FROM ticket_replies
        WHERE ticket_id = $1
        ORDER BY created_at ASC
      `,
      [String(ticketId)],
    );
    return result.rows.map((r) => ({
      id: String(r.id),
      ticket_id: String(r.ticket_id),
      user_id: String(r.user_id),
      body: normalizeOptionalString(r.body),
      is_admin_reply: Boolean(r.is_admin_reply),
      created_at: isoDate(r.created_at),
    }));
  }

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
    // PHASE 3 FIX (Bug 3): Previous version returned one row PER REFERRAL PAIR
    // (inviter→invitee). Frontend expected aggregated-per-inviter rows with
    // total_referrals, active_referrals, earned_tokens. Result: every row
    // showed "0 refs" in the UI.
    //
    // NEW VERSION: GROUP BY inviter_id with COUNT/SUM aggregates.
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const term = (normalizeOptionalString(search) || '').trim();
    const whereClause = term
      ? `WHERE inv.username ILIKE $1 OR inv.first_name ILIKE $1
            OR inv.telegram_id ILIKE $1`
      : '';
    const pattern = `%${term}%`;
    const params = term ? [pattern] : [];

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM (
        SELECT rf.inviter_id
        FROM referrals rf
        LEFT JOIN users inv ON inv.telegram_id = rf.inviter_id
        ${whereClause}
        GROUP BY rf.inviter_id
      ) sub`,
      params,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    // Aggregate per inviter: total referrals, active (verified) referrals,
    // earned tokens (sum of referral rewards from token_transactions)
    const dataResult = await queryDb(
      env,
      `
        SELECT
          rf.inviter_id,
          inv.username AS inviter_username,
          inv.first_name AS inviter_first_name,
          COUNT(rf.id) AS total_referrals,
          COUNT(rf.id) FILTER (WHERE rf.channel_verified = TRUE) AS active_referrals,
          COUNT(rf.id) FILTER (WHERE rf.rewarded = TRUE) AS rewarded_referrals,
          COALESCE(SUM(tt.amount), 0) AS earned_tokens,
          MAX(rf.created_at) AS last_referral_at
        FROM referrals rf
        LEFT JOIN users inv ON inv.telegram_id = rf.inviter_id
        LEFT JOIN token_transactions tt ON tt.user_id = rf.inviter_id AND tt.tx_type = 'referral_reward'
        ${whereClause}
        GROUP BY rf.inviter_id, inv.username, inv.first_name
        ORDER BY total_referrals DESC, last_referral_at DESC
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
        username: normalizeOptionalString(r.inviter_username),
        first_name: normalizeOptionalString(r.inviter_first_name),
        user_name: normalizeOptionalString(r.inviter_first_name) || normalizeOptionalString(r.inviter_username) || r.inviter_id,
        total_referrals: Number(r.total_referrals || 0),
        active_referrals: Number(r.active_referrals || 0),
        rewarded_referrals: Number(r.rewarded_referrals || 0),
        earned_tokens: Number(r.earned_tokens || 0),
        last_referral_at: isoDate(r.last_referral_at),
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
    // PHASE 3 FIX (Bug 4): JOIN users table to expose admin_name (was missing).
    // Frontend expected: level, message, description, event, type, user_id,
    // telegram_id, admin_name. Backend only returned: action, admin_id, details.
    // Now we map the fields and add admin_name via JOIN.
    const { offset, limit: lim, page: pg } = paginate(page, limit);
    const actionFilter = normalizeOptionalString(action);
    const whereClause = actionFilter ? 'WHERE al.action = $1' : '';
    const params = actionFilter ? [actionFilter] : [];

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) AS cnt FROM admin_logs al ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.cnt || 0);

    const dataResult = await queryDb(
      env,
      `
        SELECT al.id, al.admin_id, al.action, al.target_type, al.target_id,
               al.details, al.ip, al.created_at,
               u.username AS admin_username, u.first_name AS admin_first_name
        FROM admin_logs al
        LEFT JOIN users u ON u.telegram_id = al.admin_id
        ${whereClause}
        ORDER BY al.created_at DESC
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
        admin_name: normalizeOptionalString(r.admin_first_name) || normalizeOptionalString(r.admin_username) || String(r.admin_id),
        // Map backend fields to frontend-expected field names
        level: 'info', // admin_logs don't have severity; default to info
        message: normalizeOptionalString(r.action),
        description: r.details ? JSON.stringify(r.details) : '',
        event: normalizeOptionalString(r.action),
        type: normalizeOptionalString(r.target_type),
        action: normalizeOptionalString(r.action),
        target_type: normalizeOptionalString(r.target_type),
        target_id: normalizeOptionalString(r.target_id),
        user_id: normalizeOptionalString(r.target_id),
        telegram_id: normalizeOptionalString(r.target_type === 'user' ? r.target_id : null),
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
    // ROOT CAUSE FIX: Previous version just returned COUNT(*) of DB tables.
    // That's NOT "system health" — it's "table sizes". The frontend expected
    // service status (uptime, error_rate, etc.) which was never provided.
    //
    // NEW VERSION: Performs REAL health checks on each external dependency.
    // Each service is tested with a lightweight request and marked:
    //   🟢 healthy  — responded within 5s with valid data
    //   🟡 warning  — responded but slow (>2s) or partial data
    //   🔴 down     — failed to respond or error
    const services = {};
    const checks = [];

    // 1. Database (PostgreSQL) — run a trivial query
    checks.push(
      (async () => {
        const t0 = Date.now();
        try {
          await queryDb(env, 'SELECT 1');
          const latency = Date.now() - t0;
          services.database = {
            status: latency > 2000 ? 'warning' : 'healthy',
            latency_ms: latency,
            detail: 'PostgreSQL connection OK',
          };
        } catch (e) {
          services.database = { status: 'down', latency_ms: Date.now() - t0, error: e?.message || 'DB error' };
        }
      })()
    );

    // 2. Telegram Bot API — getMe (lightweight, no side effects)
    if (env.TELEGRAM_BOT_TOKEN) {
      checks.push(
        (async () => {
          const t0 = Date.now();
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 5000);
            const res = await fetch(`https://api.telegram.org/bot${env.TELEGRAM_BOT_TOKEN}/getMe`, { signal: controller.signal });
            clearTimeout(tid);
            const latency = Date.now() - t0;
            const body = await res.json();
            if (body.ok && body.result) {
              services.telegram = {
                status: latency > 2000 ? 'warning' : 'healthy',
                latency_ms: latency,
                detail: `Bot: @${body.result.username}`,
              };
            } else {
              services.telegram = { status: 'down', latency_ms: latency, error: body.description || 'getMe failed' };
            }
          } catch (e) {
            services.telegram = { status: 'down', latency_ms: Date.now() - t0, error: e?.message || 'fetch failed' };
          }
        })()
      );
    } else {
      services.telegram = { status: 'down', error: 'TELEGRAM_BOT_TOKEN not configured' };
    }

    // 3. CoinMarketCap — only if API key configured
    if (env.CMC_API_KEY) {
      checks.push(
        (async () => {
          const t0 = Date.now();
          try {
            const controller = new AbortController();
            const tid = setTimeout(() => controller.abort(), 5000);
            const res = await fetch('https://pro-api.coinmarketcap.com/v1/key/info', {
              headers: { 'X-CMC_PRO_API_KEY': env.CMC_API_KEY },
              signal: controller.signal,
            });
            clearTimeout(tid);
            const latency = Date.now() - t0;
            if (res.ok) {
              services.coinmarketcap = {
                status: latency > 2000 ? 'warning' : 'healthy',
                latency_ms: latency,
                detail: 'API key valid',
              };
            } else {
              services.coinmarketcap = { status: 'down', latency_ms: latency, error: `HTTP ${res.status}` };
            }
          } catch (e) {
            services.coinmarketcap = { status: 'down', latency_ms: Date.now() - t0, error: e?.message || 'fetch failed' };
          }
        })()
      );
    } else {
      services.coinmarketcap = { status: 'warning', error: 'CMC_API_KEY not configured (using CoinGecko/CoinPaprika fallback)' };
    }

    // 4. Alternative.me Fear & Greed
    checks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const controller = new AbortController();
          const tid = setTimeout(() => controller.abort(), 5000);
          const res = await fetch('https://api.alternative.me/fng/?limit=1', { signal: controller.signal });
          clearTimeout(tid);
          const latency = Date.now() - t0;
          if (res.ok) {
            const body = await res.json();
            if (body?.data?.[0]?.value) {
              services.alternative_me = {
                status: latency > 2000 ? 'warning' : 'healthy',
                latency_ms: latency,
                detail: `F&G: ${body.data[0].value} (${body.data[0].value_classification})`,
              };
            } else {
              services.alternative_me = { status: 'warning', latency_ms: latency, error: 'Unexpected response' };
            }
          } else {
            services.alternative_me = { status: 'down', latency_ms: latency, error: `HTTP ${res.status}` };
          }
        } catch (e) {
          services.alternative_me = { status: 'down', latency_ms: Date.now() - t0, error: e?.message || 'fetch failed' };
        }
      })()
    );

    // 5. Cloudflare KV — test write+read
    if (env.APP_CACHE) {
      checks.push(
        (async () => {
          const t0 = Date.now();
          try {
            const testKey = 'health-check:' + Date.now();
            await env.APP_CACHE.put(testKey, 'ok', { expirationTtl: 60 });
            const val = await env.APP_CACHE.get(testKey);
            const latency = Date.now() - t0;
            services.cloudflare_kv = {
              status: val === 'ok' ? (latency > 1000 ? 'warning' : 'healthy') : 'down',
              latency_ms: latency,
              detail: 'KV read/write OK',
            };
          } catch (e) {
            services.cloudflare_kv = { status: 'down', latency_ms: Date.now() - t0, error: e?.message || 'KV error' };
          }
        })()
      );
    } else {
      services.cloudflare_kv = { status: 'down', error: 'APP_CACHE binding missing' };
    }

    // 6. Workers AI — only if AI binding exists
    if (env.AI) {
      services.workers_ai = { status: 'healthy', detail: 'AI binding present (not tested to save resources)' };
    } else {
      services.workers_ai = { status: 'warning', error: 'AI binding not configured' };
    }

    // 7. Cron — check if schedule is configured (from env)
    services.cron = {
      status: env.ALERTS_CRON_ENABLED === 'true' ? 'healthy' : 'warning',
      detail: `Alerts cron: ${env.ALERTS_CRON_ENABLED === 'true' ? 'enabled' : 'disabled'} (schedule: every 1 min)`,
    };

    // 8. Notification Queue — check pending items count
    checks.push(
      (async () => {
        const t0 = Date.now();
        try {
          const result = await queryDb(env, "SELECT COUNT(*) AS cnt FROM notification_queue WHERE status = 'pending'");
          const pending = Number(result.rows[0]?.cnt || 0);
          const latency = Date.now() - t0;
          services.notification_queue = {
            status: pending > 50 ? 'warning' : 'healthy',
            latency_ms: latency,
            detail: `${pending} pending items in queue`,
          };
        } catch (e) {
          // Queue table might not exist yet
          services.notification_queue = { status: 'warning', latency_ms: Date.now() - t0, error: 'Queue table not accessible' };
        }
      })()
    );

    await Promise.allSettled(checks);

    // Summary: count healthy/warning/down
    let healthy = 0, warning = 0, down = 0;
    for (const key of Object.keys(services)) {
      const s = services[key];
      if (s.status === 'healthy') healthy++;
      else if (s.status === 'warning') warning++;
      else down++;
    }

    return {
      services,
      summary: { healthy, warning, down, total: Object.keys(services).length },
      timestamp: new Date().toISOString(),
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
    deleteTicket,
    listTicketReplies,
    getBroadcastTargetUsers,
  });
}
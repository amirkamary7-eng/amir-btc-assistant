/**
 * Membership Repository — Cloudflare Worker / Neon Postgres.
 *
 * Factory pattern: createMembershipRepository(deps) returns an object with
 * all membership DB queries. Uses queryDb / queryDbTransaction from the host
 * Worker for connection management + retry + transaction support.
 *
 * All mutations that touch multiple tables use queryDbTransaction for atomicity.
 */
export function createMembershipRepository(deps) {
  const { queryDb, queryDbTransaction } = deps;

  // ─── Schema ──────────────────────────────────────────────────────────────

  let _welcomeColumnEnsured = false;
  // PHASE 1 SAFE OPTIMIZATION: Module-level flag to skip the existence check
  // (SELECT 1) after the first successful call per isolate. Previously this
  // ran on every ensureSchema() call. Now matches the pattern used by other
  // repositories (admin.js, wallet.js, reward_center.js, etc.).
  let _schemaVerified = false;

  /** Idempotent schema check (tables created via membership-schema.sql). */
  async function ensureSchema(env) {
    // PHASE 1 SAFE OPTIMIZATION: Skip entirely after first successful verification.
    if (_schemaVerified) return;

    // Lightweight existence check — if the tables don't exist, the queries
    // will error with a clear message telling the operator to run the SQL migration.
    try {
      await queryDb(env, 'SELECT 1 FROM membership_users LIMIT 1');
      // Ensure welcome_shown column exists (Phase 4 — added after initial deploy).
      // Runs once per isolate, then cached. Safe for existing deployments.
      if (!_welcomeColumnEnsured) {
        await queryDb(env, `ALTER TABLE membership_users ADD COLUMN IF NOT EXISTS welcome_shown BOOLEAN NOT NULL DEFAULT FALSE`);
        _welcomeColumnEnsured = true;
      }
      _schemaVerified = true;
    } catch (e) {
      console.warn('[membership] schema check failed — run scripts/membership-schema.sql:', e.message || e);
    }
  }

  /** Mark the one-time Premium welcome popup as shown for a user. */
  async function markWelcomeShown(env, telegramId) {
    const result = await queryDb(env,
      `UPDATE membership_users SET welcome_shown = TRUE, updated_at = NOW()
       WHERE telegram_id = $1 AND welcome_shown = FALSE
       RETURNING id`,
      [String(telegramId)]
    );
    return (result.rowCount || 0) > 0;
  }

  // ─── Membership Users ────────────────────────────────────────────────────

  function findByTelegramId(env, telegramId) {
    return queryDb(env,
      'SELECT * FROM membership_users WHERE telegram_id = $1 LIMIT 1',
      [String(telegramId)]
    ).then(r => r.rows[0] || null);
  }

  async function upsertByTelegramId(env, input) {
    const rows = await queryDb(env,
      `INSERT INTO membership_users (telegram_id, username, first_name, last_name)
       VALUES ($1, $2, $3, $4)
       ON CONFLICT (telegram_id) DO UPDATE SET
         username = COALESCE($2, membership_users.username),
         first_name = COALESCE($3, membership_users.first_name),
         last_name = COALESCE($4, membership_users.last_name),
         updated_at = NOW()
       RETURNING *`,
      [String(input.telegramId), input.username || null, input.firstName || null, input.lastName || null]
    );
    return rows.rows[0];
  }

  function update(env, telegramId, data) {
    const sets = [];
    const params = [String(telegramId)];
    let idx = 2;
    if (data.membershipLevel !== undefined) { sets.push(`membership_level = $${idx++}`); params.push(data.membershipLevel); }
    if (data.membershipStatus !== undefined) { sets.push(`membership_status = $${idx++}`); params.push(data.membershipStatus); }
    if (data.membershipSource !== undefined) { sets.push(`membership_source = $${idx++}`); params.push(data.membershipSource); }
    if (data.approvedBy !== undefined) { sets.push(`approved_by = $${idx++}`); params.push(data.approvedBy); }
    if (data.approvedAt !== undefined) { sets.push(`approved_at = $${idx++}`); params.push(data.approvedAt); }
    if (data.expireAt !== undefined) { sets.push(`expire_at = $${idx++}`); params.push(data.expireAt); }
    if (sets.length === 0) return Promise.resolve(null);
    sets.push('updated_at = NOW()');
    return queryDb(env,
      `UPDATE membership_users SET ${sets.join(', ')} WHERE telegram_id = $1 RETURNING *`,
      params
    ).then(r => r.rows[0] || null);
  }

  // ─── Membership Requests ─────────────────────────────────────────────────

  function createRequest(env, input) {
    return queryDb(env,
      `INSERT INTO membership_requests (telegram_id, exchange_name, exchange_uid, note)
       VALUES ($1, $2, $3, $4) RETURNING *`,
      [String(input.telegramId), input.exchangeName, input.exchangeUid, input.note || null]
    ).then(r => r.rows[0]);
  }

  function findRequestById(env, id) {
    return queryDb(env, 'SELECT * FROM membership_requests WHERE id = $1 LIMIT 1', [id])
      .then(r => r.rows[0] || null);
  }

  function findRequestsByTelegramId(env, telegramId) {
    return queryDb(env,
      'SELECT * FROM membership_requests WHERE telegram_id = $1 ORDER BY submitted_at DESC LIMIT 20',
      [String(telegramId)]
    ).then(r => r.rows);
  }

  function findRequestByExchangeUid(env, uid) {
    return queryDb(env,
      'SELECT * FROM membership_requests WHERE exchange_uid = $1 ORDER BY submitted_at DESC LIMIT 1',
      [uid]
    ).then(r => r.rows[0] || null);
  }

  function findPendingRequestByTelegramId(env, telegramId) {
    return queryDb(env,
      'SELECT * FROM membership_requests WHERE telegram_id = $1 AND status = $2 LIMIT 1',
      [String(telegramId), 'PENDING']
    ).then(r => r.rows[0] || null);
  }

  function updateRequest(env, id, data) {
    const sets = [];
    const params = [id];
    let idx = 2;
    if (data.status !== undefined) { sets.push(`status = $${idx++}`); params.push(data.status); }
    if (data.adminNote !== undefined) { sets.push(`admin_note = $${idx++}`); params.push(data.adminNote); }
    if (data.reviewedAt !== undefined) { sets.push(`reviewed_at = $${idx++}`); params.push(data.reviewedAt); }
    if (data.reviewedBy !== undefined) { sets.push(`reviewed_by = $${idx++}`); params.push(data.reviewedBy); }
    if (sets.length === 0) return Promise.resolve(null);
    sets.push('updated_at = NOW()');
    return queryDb(env,
      `UPDATE membership_requests SET ${sets.join(', ')} WHERE id = $1 RETURNING *`,
      params
    ).then(r => r.rows[0] || null);
  }

  function findManyByIds(env, ids) {
    if (!ids.length) return Promise.resolve([]);
    const placeholders = ids.map((_, i) => `$${i + 1}`).join(',');
    return queryDb(env,
      `SELECT * FROM membership_requests WHERE id IN (${placeholders})`,
      ids
    ).then(r => r.rows);
  }

  /** Paginated, filtered list joined with user data. */
  async function listRequestsWithUser(env, params) {
    const where = [];
    const values = [];
    let idx = 1;
    if (params.status) { where.push(`mr.status = $${idx++}`); values.push(params.status); }
    if (params.exchange) { where.push(`mr.exchange_name = $${idx++}`); values.push(params.exchange); }
    if (params.search) {
      where.push(`(
        mr.telegram_id ILIKE $${idx} OR
        mr.exchange_uid ILIKE $${idx} OR
        mr.exchange_name ILIKE $${idx} OR
        mr.note ILIKE $${idx} OR
        mu.username ILIKE $${idx} OR
        mu.first_name ILIKE $${idx} OR
        mu.last_name ILIKE $${idx}
      )`);
      values.push(`%${params.search}%`);
      idx++;
    }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderBy = params.sort === 'oldest' ? 'ASC' : 'DESC';
    const offset = (params.page - 1) * params.pageSize;

    // Count query uses the same WHERE clause but not LIMIT/OFFSET params.
    // values at this point = [status?, exchange?, search?] — the filter params only.
    const countSql = `SELECT COUNT(*)::int AS total FROM membership_requests mr LEFT JOIN membership_users mu ON mu.telegram_id = mr.telegram_id ${whereClause}`;
    const dataSql = `
      SELECT mr.*, mu.username, mu.first_name, mu.last_name,
             mu.membership_level, mu.membership_status
      FROM membership_requests mr
      LEFT JOIN membership_users mu ON mu.telegram_id = mr.telegram_id
      ${whereClause}
      ORDER BY mr.submitted_at ${orderBy}
      LIMIT $${idx++} OFFSET $${idx++}`;

    // Run count + data in parallel with correct param sets.
    const countParams = values.slice();
    const dataParams = values.concat([params.pageSize, offset]);

    const [countResult, dataResult] = await Promise.all([
      queryDb(env, countSql, countParams),
      queryDb(env, dataSql, dataParams),
    ]);
    const total = countResult.rows[0]?.total || 0;
    const items = dataResult.rows;
    return {
      items,
      page: params.page,
      pageSize: params.pageSize,
      total,
      totalPages: Math.max(1, Math.ceil(total / params.pageSize)),
    };
  }

  // ─── Audit Logs ──────────────────────────────────────────────────────────

  function createAuditLog(env, input) {
    return queryDb(env,
      `INSERT INTO membership_audit_logs
        (admin_id, admin_username, target_telegram_id, request_id, action,
         level_before, level_after, status_before, status_after, detail, ip)
       VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11) RETURNING *`,
      [
        String(input.adminId),
        input.adminUsername || null,
        input.targetTelegramId || null,
        input.requestId || null,
        input.action,
        input.levelBefore || null,
        input.levelAfter || null,
        input.statusBefore || null,
        input.statusAfter || null,
        input.detail || null,
        input.ip || null,
      ]
    ).then(r => r.rows[0]);
  }

  function listAuditLogs(env, params) {
    const where = [];
    const values = [];
    let idx = 1;
    if (params.adminId) { where.push(`admin_id = $${idx++}`); values.push(String(params.adminId)); }
    if (params.action) { where.push(`action = $${idx++}`); values.push(params.action); }
    if (params.targetTelegramId) { where.push(`target_telegram_id = $${idx++}`); values.push(String(params.targetTelegramId)); }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const offset = (params.page - 1) * params.pageSize;
    const countSql = `SELECT COUNT(*)::int AS total FROM membership_audit_logs ${whereClause}`;
    const dataSql = `SELECT * FROM membership_audit_logs ${whereClause} ORDER BY created_at DESC LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(params.pageSize, offset);
    return Promise.all([
      queryDb(env, countSql, values.slice(0, values.length - 2)),
      queryDb(env, dataSql, values),
    ]).then(([c, d]) => ({
      items: d.rows,
      page: params.page,
      pageSize: params.pageSize,
      total: c.rows[0]?.total || 0,
      totalPages: Math.max(1, Math.ceil((c.rows[0]?.total || 0) / params.pageSize)),
    }));
  }

  // ─── Admin Users ─────────────────────────────────────────────────────────

  function findAdminByTelegramId(env, telegramId) {
    return queryDb(env,
      'SELECT * FROM membership_admins WHERE telegram_id = $1 AND active = TRUE LIMIT 1',
      [String(telegramId)]
    ).then(r => r.rows[0] || null);
  }

  /** Paginated, filtered list of membership users with denormalized request stats. */
  async function listUsers(env, params) {
    const where = [];
    const values = [];
    let idx = 1;
    if (params.level) { where.push(`membership_level = $${idx++}`); values.push(params.level); }
    if (params.status) { where.push(`membership_status = $${idx++}`); values.push(params.status); }
    if (params.source) { where.push(`membership_source = $${idx++}`); values.push(params.source); }
    if (params.search) {
      where.push(`(telegram_id ILIKE $${idx} OR username ILIKE $${idx} OR first_name ILIKE $${idx} OR last_name ILIKE $${idx})`);
      values.push(`%${params.search}%`);
      idx++;
    }
    const whereClause = where.length ? 'WHERE ' + where.join(' AND ') : '';
    const orderBy = params.sort === 'oldest' ? 'created_at ASC'
      : params.sort === 'level-desc' ? 'membership_level DESC'
      : params.sort === 'level-asc' ? 'membership_level ASC'
      : 'created_at DESC';
    const offset = (params.page - 1) * params.pageSize;

    const countSql = `SELECT COUNT(*)::int AS total FROM membership_users ${whereClause}`;
    const dataSql = `
      SELECT mu.*,
        COALESCE(req.cnt, 0) AS request_count,
        req.last_status AS last_request_status
      FROM membership_users mu
      LEFT JOIN LATERAL (
        SELECT COUNT(*)::int AS cnt,
          (SELECT status FROM membership_requests WHERE telegram_id = mu.telegram_id ORDER BY submitted_at DESC LIMIT 1) AS last_status
        FROM membership_requests WHERE telegram_id = mu.telegram_id
      ) req ON TRUE
      ${whereClause}
      ORDER BY ${orderBy}
      LIMIT $${idx++} OFFSET $${idx++}`;
    values.push(params.pageSize, offset);

    const [countRes, dataRes] = await Promise.all([
      queryDb(env, countSql, values.slice(0, values.length - 2)),
      queryDb(env, dataSql, values),
    ]);
    return {
      items: dataRes.rows,
      page: params.page,
      pageSize: params.pageSize,
      total: countRes.rows[0]?.total || 0,
      totalPages: Math.max(1, Math.ceil((countRes.rows[0]?.total || 0) / params.pageSize)),
    };
  }

  async function getUserDetail(env, telegramId) {
    const [user, requests, audit] = await Promise.all([
      queryDb(env, 'SELECT * FROM membership_users WHERE telegram_id = $1 LIMIT 1', [String(telegramId)]).then(r => r.rows[0] || null),
      queryDb(env, 'SELECT * FROM membership_requests WHERE telegram_id = $1 ORDER BY submitted_at DESC LIMIT 20', [String(telegramId)]).then(r => r.rows),
      queryDb(env, 'SELECT * FROM membership_audit_logs WHERE target_telegram_id = $1 OR admin_id = $1 ORDER BY created_at DESC LIMIT 10', [String(telegramId)]).then(r => r.rows),
    ]);
    return { user, requests, recentAudit: audit };
  }

  // ─── Stats ───────────────────────────────────────────────────────────────

  async function counts(env) {
    // Single query with conditional aggregation — 1 DB round-trip instead of 4.
    const row = await queryDb(env,
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE membership_status = 'APPROVED')::int AS approved,
        COUNT(*) FILTER (WHERE membership_level IN ('VIP','PREMIUM','ELITE'))::int AS vip,
        COUNT(*) FILTER (WHERE membership_status = 'SUSPENDED')::int AS suspended
       FROM membership_users`
    ).then(r => r.rows[0]);
    return { totalUsers: row.total, approvedUsers: row.approved, vipUsers: row.vip, suspendedUsers: row.suspended };
  }

  async function requestCounts(env) {
    // Single query with conditional aggregation — 1 DB round-trip instead of 3.
    const row = await queryDb(env,
      `SELECT
        COUNT(*)::int AS total,
        COUNT(*) FILTER (WHERE status = 'PENDING')::int AS pending,
        COUNT(*) FILTER (WHERE status = 'REJECTED')::int AS rejected
       FROM membership_requests`
    ).then(r => r.rows[0]);
    return { totalRequests: row.total, pendingRequests: row.pending, rejectedRequests: row.rejected };
  }

  function exchangeBreakdown(env) {
    return queryDb(env,
      'SELECT exchange_name AS exchange, COUNT(*)::int AS count FROM membership_requests GROUP BY exchange_name ORDER BY count DESC'
    ).then(r => r.rows);
  }

  async function levelDistribution(env) {
    const rows = await queryDb(env,
      'SELECT membership_level AS level, COUNT(*)::int AS count FROM membership_users GROUP BY membership_level'
    ).then(r => r.rows);
    const total = rows.reduce((s, r) => s + r.count, 0);
    return rows.map(r => ({ ...r, percent: total > 0 ? Math.round((r.count / total) * 1000) / 10 : 0 }));
  }

  function last7Days(env) {
    return queryDb(env,
      `SELECT to_char(submitted_at::date, 'YYYY-MM-DD') AS date,
              COUNT(*)::int AS requests,
              COUNT(*) FILTER (WHERE status = 'APPROVED' AND reviewed_at IS NOT NULL)::int AS approvals
       FROM membership_requests
       WHERE submitted_at >= NOW() - INTERVAL '6 days'
       GROUP BY date ORDER BY date`
    ).then(r => r.rows);
  }

  function countRequestsSince(env, since) {
    return queryDb(env, 'SELECT COUNT(*)::int AS c FROM membership_requests WHERE submitted_at >= $1', [since]).then(r => r.rows[0].c);
  }

  function countApprovalsSince(env, since) {
    return queryDb(env, "SELECT COUNT(*)::int AS c FROM membership_requests WHERE status = 'APPROVED' AND reviewed_at >= $1", [since]).then(r => r.rows[0].c);
  }

  function newUsersCountSince(env, since) {
    return queryDb(env, 'SELECT COUNT(*)::int AS c FROM membership_users WHERE created_at >= $1', [since]).then(r => r.rows[0].c);
  }

  async function avgApprovalHours(env) {
    const row = await queryDb(env,
      `SELECT AVG(EXTRACT(EPOCH FROM (reviewed_at - submitted_at)) / 3600)::float AS avg
       FROM membership_requests WHERE status = 'APPROVED' AND reviewed_at IS NOT NULL`
    ).then(r => r.rows[0]);
    if (!row || row.avg === null) return null;
    return Math.round(row.avg * 10) / 10;
  }

  // ─── Premium Rules (Phase 1) ──────────────────────────────────────────────

  /** Get the currently ACTIVE rules version, or null if none. */
  async function getActiveRules(env) {
    try {
      const result = await queryDb(env,
        `SELECT id, version, title, body_markdown, summary, status, effective_at, created_at
         FROM membership_rules
         WHERE status = 'ACTIVE'
         ORDER BY version DESC
         LIMIT 1`
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[membership] getActiveRules failed:', e.message || e);
      return null;
    }
  }

  /** Get a specific rules version by version number. */
  async function getRulesByVersion(env, version) {
    try {
      const result = await queryDb(env,
        `SELECT id, version, title, body_markdown, summary, status, effective_at, created_at
         FROM membership_rules
         WHERE version = $1
         LIMIT 1`,
        [Number(version)]
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[membership] getRulesByVersion failed:', e.message || e);
      return null;
    }
  }

  /** Check if a user has accepted a specific rules version. */
  async function getAcceptance(env, telegramId, rulesVersion) {
    try {
      const result = await queryDb(env,
        `SELECT id, telegram_id, rules_version, request_id, accepted_at, ip, user_agent, metadata
         FROM membership_rule_acceptances
         WHERE telegram_id = $1 AND rules_version = $2
         LIMIT 1`,
        [String(telegramId), Number(rulesVersion)]
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[membership] getAcceptance failed:', e.message || e);
      return null;
    }
  }

  /** Record a user's acceptance (idempotent via ON CONFLICT). */
  async function recordAcceptance(env, input) {
    try {
      const result = await queryDb(env,
        `INSERT INTO membership_rule_acceptances
           (telegram_id, rules_version, request_id, ip, user_agent, metadata)
         VALUES ($1, $2, $3, $4, $5, $6)
         ON CONFLICT (telegram_id, rules_version) DO UPDATE
           SET accepted_at = membership_rule_acceptances.accepted_at
         RETURNING id, telegram_id, rules_version, request_id, accepted_at`,
        [String(input.telegramId), Number(input.rulesVersion), input.requestId || null,
         input.ip || null, input.userAgent || null, JSON.stringify(input.metadata || {})]
      );
      return result.rows[0] || null;
    } catch (e) {
      console.warn('[membership] recordAcceptance failed:', e.message || e);
      throw e;
    }
  }

  /** Stamp a membership request with the rules version active at submission time. */
  async function stampRequestRulesVersion(env, requestId, rulesVersion) {
    if (!requestId || !rulesVersion) return null;
    try {
      await queryDb(env,
        `UPDATE membership_requests SET rules_version = $2, updated_at = NOW() WHERE id = $1`,
        [String(requestId), Number(rulesVersion)]
      );
    } catch (e) {
      console.warn('[membership] stampRequestRulesVersion failed:', e.message || e);
    }
    return null;
  }

  return {
    ensureSchema,
    markWelcomeShown,
    findByTelegramId,
    upsertByTelegramId,
    update,
    createRequest,
    findRequestById,
    findRequestsByTelegramId,
    findRequestByExchangeUid,
    findPendingRequestByTelegramId,
    updateRequest,
    findManyByIds,
    listRequestsWithUser,
    createAuditLog,
    listAuditLogs,
    findAdminByTelegramId,
    listUsers,
    getUserDetail,
    counts,
    requestCounts,
    exchangeBreakdown,
    levelDistribution,
    last7Days,
    countRequestsSince,
    countApprovalsSince,
    newUsersCountSince,
    avgApprovalHours,
    // Phase 1: Rules + Acceptance
    getActiveRules,
    getRulesByVersion,
    getAcceptance,
    recordAcceptance,
    stampRequestRulesVersion,
    // expose transaction helper for service layer
    _queryDbTransaction: queryDbTransaction,
  };
};

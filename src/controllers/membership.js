/**
 * Membership Controllers — Cloudflare Worker.
 *
 * Factory pattern: createMembershipHandlers(deps) returns route handler functions.
 * Each handler: (request, env, ctx) => Response.
 *
 * Auth: uses authenticateTelegramRequest + isAdminTelegramId (admin routes).
 * Cache: uses readAppCache / writeAppCache (KV with skip-write optimization).
 * Transactions: uses queryDbTransaction for atomic mutations.
 * State machine: enforced on all status transitions.
 */
export function createMembershipHandlers(deps) {
  const {
    jsonResponse,
    authenticateTelegramRequest,
    isAdminTelegramId,
    isDatabaseConfigured,
    readAppCache,
    writeAppCache,
    safeDbErrorResponse,
    buildBodyFieldValidationError,
    readJsonBody,
    membershipRepo,
    queryDbTransaction,
  } = deps;

  // ─── Constants ────────────────────────────────────────────────────────────

  const SUPPORTED_EXCHANGES = ['Bitunix', 'Bybit', 'Binance', 'OKX', 'MEXC', 'Gate', 'KuCoin', 'Bitget', 'Coinex', 'Other'];
  const MAX_PAGE_SIZE = 20;
  const CACHE_TTL = {
    STATUS: 300,        // 5 min
    REQUESTS: 30,       // 30 sec
    STATS: 60,          // 1 min
  };

  const ALLOWED_TRANSITIONS = {
    INACTIVE: ['PENDING'],
    PENDING: ['APPROVED', 'REJECTED'],
    APPROVED: ['SUSPENDED', 'EXPIRED'],
    REJECTED: ['PENDING'],
    SUSPENDED: ['APPROVED'],
    EXPIRED: ['PENDING'],
  };

  function canTransition(from, to) {
    return (ALLOWED_TRANSITIONS[from] || []).includes(to);
  }

  // ─── Cache helpers ────────────────────────────────────────────────────────

  function ckStatus(tgId) { return `mb:status:${tgId}`; }
  function ckUserReqs(tgId) { return `mb:req:user:${tgId}`; }
  function ckAdminReqs(p) { return `mb:admin:req:${p}`; }
  function ckAdminUsers(p) { return `mb:admin:users:${p}`; }
  function ckStats() { return 'mb:stats'; }
  function ckLogs(p) { return `mb:audit:${p}`; }

  function serializeParams(obj) {
    return Object.keys(obj).sort().map(k => `${k}=${obj[k] == null ? '' : obj[k]}`).join('|');
  }

  async function invalidateCaches(env, telegramId) {
    try {
      if (telegramId) {
        await env.APP_CACHE?.delete?.(ckStatus(telegramId));
        await env.APP_CACHE?.delete?.(ckUserReqs(telegramId));
      }
      // Invalidate prefixes by deleting known keys — KV doesn't support prefix delete,
      // so we use a version tombstone for list caches (lightweight approach).
      await writeAppCache(env, 'mb:admin:req:version', String(Date.now()), CACHE_TTL.STATS);
      await writeAppCache(env, 'mb:admin:users:version', String(Date.now()), CACHE_TTL.STATS);
      await env.APP_CACHE?.delete?.(ckStats());
    } catch (e) {
      // non-fatal
    }
  }

  // ─── Validation ──────────────────────────────────────────────────────────

  function validateCreateRequest(body) {
    const errors = [];
    if (!body.exchange || !SUPPORTED_EXCHANGES.includes(body.exchange)) {
      errors.push({ field: 'exchange', message: 'Invalid exchange' });
    }
    const uid = String(body.uid || '').trim();
    if (uid.length < 4 || uid.length > 64 || !/^[A-Za-z0-9_-]+$/.test(uid)) {
      errors.push({ field: 'uid', message: 'UID must be 4-64 alphanumeric chars' });
    }
    if (body.note && String(body.note).length > 500) {
      errors.push({ field: 'note', message: 'Note too long' });
    }
    return { valid: errors.length === 0, errors, uid, exchange: body.exchange, note: body.note };
  }

  function parsePagination(url) {
    const sp = url.searchParams;
    const page = Math.max(1, parseInt(sp.get('page') || '1', 10) || 1);
    const pageSize = Math.min(MAX_PAGE_SIZE, Math.max(1, parseInt(sp.get('pageSize') || '20', 10) || 20));
    const search = sp.get('search') || undefined;
    const sort = sp.get('sort') || 'newest';
    return { page, pageSize, search, sort };
  }

  // ─── Auth helpers ─────────────────────────────────────────────────────────

  async function requireUser(request, env) {
    const auth = await authenticateTelegramRequest(request, env);
    if (auth.error) return { error: auth.error };
    return { user: auth.user };
  }

  async function requireAdminUser(request, env) {
    const auth = await authenticateTelegramRequest(request, env);
    if (auth.error) return { error: auth.error };
    if (!isAdminTelegramId(env, auth.user.id)) {
      return { error: jsonResponse({ error: 'Admin access required', code: 'FORBIDDEN' }, { status: 403 }, env) };
    }
    return { user: auth.user };
  }

  function ipFrom(request) {
    return request.headers.get('cf-connecting-ip') ||
           (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() ||
           null;
  }

  // ─── Handlers: User ──────────────────────────────────────────────────────

  /** GET /api/membership/status — cached 5 min */
  async function handleGetStatus(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);

    const tgId = String(auth.user.id);
    const cacheKey = ckStatus(tgId);
    const cached = await readAppCache(env, cacheKey);
    if (cached) {
      return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    }

    try {
      await membershipRepo.ensureSchema(env);
      // Upsert user row on first visit
      await membershipRepo.upsertByTelegramId(env, {
        telegramId: tgId,
        username: auth.user.username || null,
        firstName: auth.user.first_name || null,
        lastName: auth.user.last_name || null,
      });
      const user = await membershipRepo.findByTelegramId(env, tgId);
      const dto = user ? {
        level: user.membership_level,
        status: user.membership_status,
        source: user.membership_source,
        lifetime: user.membership_status === 'APPROVED' && !user.expire_at,
        approvedAt: user.approved_at,
        expireAt: user.expire_at,
      } : {
        level: 'FREE', status: 'INACTIVE', source: 'MANUAL',
        lifetime: false, approvedAt: null, expireAt: null,
      };
      await writeAppCache(env, cacheKey, JSON.stringify(dto), CACHE_TTL.STATUS);
      return jsonResponse({ ok: true, data: dto }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  /** GET /api/membership/request — user's own requests, cached 30s */
  async function handleGetMyRequests(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const tgId = String(auth.user.id);
    const cacheKey = ckUserReqs(tgId);
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const rows = await membershipRepo.findRequestsByTelegramId(env, tgId);
      await writeAppCache(env, cacheKey, JSON.stringify(rows), CACHE_TTL.REQUESTS);
      return jsonResponse({ ok: true, data: rows }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** POST /api/membership/request — submit new request */
  async function handleSubmitRequest(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const { payload, error } = await readJsonBody(request);
    if (error) return error;
    const v = validateCreateRequest(payload);
    if (!v.valid) return buildBodyFieldValidationError(v.errors, env);

    const tgId = String(auth.user.id);
    try {
      await membershipRepo.ensureSchema(env);
      // Duplicate UID check
      const existingUid = await membershipRepo.findRequestByExchangeUid(env, v.uid);
      if (existingUid) {
        return jsonResponse({ error: 'Exchange UID already registered', code: 'DUPLICATE_UID' }, { status: 409 }, env);
      }
      // Pending request check
      const pending = await membershipRepo.findPendingRequestByTelegramId(env, tgId);
      if (pending) {
        return jsonResponse({ error: 'Duplicate pending request', code: 'DUPLICATE_REQUEST' }, { status: 409 }, env);
      }
      // Upsert user
      await membershipRepo.upsertByTelegramId(env, {
        telegramId: tgId,
        username: auth.user.username || null,
        firstName: auth.user.first_name || null,
        lastName: auth.user.last_name || null,
      });

      // Transactional: create request + update user status + audit log
      const txQueries = [
        {
          sql: `INSERT INTO membership_requests (telegram_id, exchange_name, exchange_uid, note)
                VALUES ($1, $2, $3, $4) RETURNING *`,
          params: [tgId, v.exchange, v.uid, v.note || null],
        },
        {
          sql: `UPDATE membership_users SET membership_status = 'PENDING', updated_at = NOW() WHERE telegram_id = $1`,
          params: [tgId],
        },
      ];
      await deps.queryDbTransaction(env, txQueries);

      // Audit log (separate — non-fatal if it fails)
      try {
        await membershipRepo.createAuditLog(env, {
          adminId: 'system',
          targetTelegramId: tgId,
          action: 'REQUEST',
          statusBefore: 'INACTIVE',
          statusAfter: 'PENDING',
          detail: `Exchange: ${v.exchange}, UID: ${v.uid}`,
        });
      } catch (e) { /* non-fatal */ }

      await invalidateCaches(env, tgId);
      return jsonResponse({ ok: true, data: { status: 'PENDING', exchange: v.exchange, uid: v.uid } }, { status: 201 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── Handlers: Admin Stats ───────────────────────────────────────────────

  /** GET /api/admin/membership/stats — cached 1 min, enriched with funnel + trends */
  async function handleGetStats(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const cacheKey = ckStats();
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const now = new Date();
      const last7 = new Date(now.getTime() - 7 * 86400000);
      const prev7 = new Date(now.getTime() - 14 * 86400000);

      const [uCounts, rCounts, byExchange, last7Data, levelDist, req7d, reqPrev7d, appr7d, apprPrev7d, newU7d, newUprev7d, avgHrs] = await Promise.all([
        membershipRepo.counts(env),
        membershipRepo.requestCounts(env),
        membershipRepo.exchangeBreakdown(env),
        membershipRepo.last7Days(env),
        membershipRepo.levelDistribution(env),
        membershipRepo.countRequestsSince(env, last7),
        membershipRepo.countRequestsSince(env, prev7),
        membershipRepo.countApprovalsSince(env, last7),
        membershipRepo.countApprovalsSince(env, prev7),
        membershipRepo.newUsersCountSince(env, last7),
        membershipRepo.newUsersCountSince(env, prev7),
        membershipRepo.avgApprovalHours(env),
      ]);

      const total = uCounts.totalUsers;
      const pct = n => total > 0 ? Math.round((n / total) * 1000) / 10 : 0;
      const funnel = [
        { stage: 'TOTAL_USERS', label: 'کل کاربران', count: total, percent: 100 },
        { stage: 'SUBMITTED_REQUEST', label: 'ثبت درخواست', count: rCounts.totalRequests, percent: pct(rCounts.totalRequests) },
        { stage: 'PENDING', label: 'در انتظار', count: rCounts.pendingRequests, percent: pct(rCounts.pendingRequests) },
        { stage: 'APPROVED', label: 'تأیید شده', count: uCounts.approvedUsers, percent: pct(uCounts.approvedUsers) },
        { stage: 'VIP', label: 'VIP+', count: uCounts.vipUsers, percent: pct(uCounts.vipUsers) },
      ];
      const trend = (cur, prev) => {
        if (prev === 0) return { current: cur, previous: prev, deltaPercent: cur > 0 ? 100 : null, direction: cur > 0 ? 'up' : 'flat' };
        const d = Math.round(((cur - prev) / prev) * 1000) / 10;
        return { current: cur, previous: prev, deltaPercent: d, direction: d > 0 ? 'up' : d < 0 ? 'down' : 'flat' };
      };

      const dto = {
        totalUsers: total,
        totalRequests: rCounts.totalRequests,
        pendingRequests: rCounts.pendingRequests,
        approvedUsers: uCounts.approvedUsers,
        vipUsers: uCounts.vipUsers,
        suspendedUsers: uCounts.suspendedUsers,
        rejectedRequests: rCounts.rejectedRequests,
        byExchange,
        last7Days: last7Data,
        funnel,
        levelDistribution: levelDist,
        trends: {
          requests7d: trend(req7d, reqPrev7d),
          approvals7d: trend(appr7d, apprPrev7d),
          newUsers7d: trend(newU7d, newUprev7d),
        },
        avgApprovalHours: avgHrs,
      };
      await writeAppCache(env, cacheKey, JSON.stringify(dto), CACHE_TTL.STATS);
      return jsonResponse({ ok: true, data: dto }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── Handlers: Admin Requests ────────────────────────────────────────────

  /** GET /api/admin/membership/requests — paginated, filtered, cached 30s */
  async function handleListRequests(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const url = new URL(request.url);
    const sp = url.searchParams;
    const params = {
      ...parsePagination(url),
      status: sp.get('status') || undefined,
      exchange: sp.get('exchange') || undefined,
    };
    const cacheKey = ckAdminReqs(serializeParams(params));
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const result = await membershipRepo.listRequestsWithUser(env, params);
      await writeAppCache(env, cacheKey, JSON.stringify(result), CACHE_TTL.REQUESTS);
      return jsonResponse({ ok: true, data: result }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** GET /api/admin/membership/request/:id — single request detail */
  async function handleGetRequest(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const id = new URL(request.url).pathname.split('/').pop();
    try {
      const req = await membershipRepo.findRequestById(env, id);
      if (!req) return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }, env);
      const user = await membershipRepo.findByTelegramId(env, req.telegram_id);
      return jsonResponse({ ok: true, data: { ...req, user: user ? {
        username: user.username, first_name: user.first_name, last_name: user.last_name,
        membership_level: user.membership_level, membership_status: user.membership_status,
        membership_source: user.membership_source, approved_at: user.approved_at, expire_at: user.expire_at,
      } : null } }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── Admin Action (approve/reject/suspend/reactivate) ────────────────────

  function makeActionHandler(action, newStatus, newLevel, newSource) {
    return async function handleAction(request, env) {
      const auth = await requireAdminUser(request, env);
      if (auth.error) return auth.error;
      if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
      const { payload, error } = await readJsonBody(request);
      if (error) return error;
      const requestId = payload.requestId;
      const adminNote = payload.adminNote || null;
      if (!requestId) return buildBodyFieldValidationError([{ field: 'requestId', message: 'Required' }], env);
      const ip = ipFrom(request);

      try {
        const req = await membershipRepo.findRequestById(env, requestId);
        if (!req) return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }, env);

        // State machine validation
        const user = await membershipRepo.findByTelegramId(env, req.telegram_id);
        const statusBefore = user?.membership_status || 'INACTIVE';
        const levelBefore = user?.membership_level || 'FREE';

        // For approve/reject: request must be PENDING
        if ((action === 'approve' || action === 'reject') && req.status !== 'PENDING') {
          return jsonResponse({ error: `Request is ${req.status}, not PENDING`, code: 'INVALID_TRANSITION' }, { status: 409 }, env);
        }
        // For suspend: user must be APPROVED
        if (action === 'suspend' && !canTransition(statusBefore, 'SUSPENDED')) {
          return jsonResponse({ error: 'Invalid state transition', code: 'INVALID_TRANSITION', details: { from: statusBefore, to: 'SUSPENDED' } }, { status: 409 }, env);
        }
        // For reactivate: user must be SUSPENDED
        if (action === 'reactivate' && !canTransition(statusBefore, 'APPROVED')) {
          return jsonResponse({ error: 'Invalid state transition', code: 'INVALID_TRANSITION', details: { from: statusBefore, to: 'APPROVED' } }, { status: 409 }, env);
        }

        const now = new Date().toISOString();
        const txQueries = [];

        // Update user
        const userSets = [`membership_status = '${newStatus}'`, 'updated_at = NOW()'];
        if (newLevel) userSets.unshift(`membership_level = '${newLevel}'`);
        if (newSource) userSets.unshift(`membership_source = '${newSource}'`);
        if (action === 'approve') { userSets.push(`approved_by = '${auth.user.id}'`); userSets.push(`approved_at = '${now}'`); userSets.push('expire_at = NULL'); }
        if (action === 'expire') userSets.push(`expire_at = '${now}'`);
        txQueries.push({
          sql: `UPDATE membership_users SET ${userSets.join(', ')} WHERE telegram_id = $1`,
          params: [req.telegram_id],
        });

        // Update request (for approve/reject/suspend/reactivate)
        if (action === 'approve' || action === 'reject') {
          txQueries.push({
            sql: `UPDATE membership_requests SET status = $1, admin_note = $2, reviewed_at = $3, reviewed_by = $4, updated_at = NOW() WHERE id = $5`,
            params: [newStatus === 'APPROVED' ? 'APPROVED' : 'REJECTED', adminNote, now, String(auth.user.id), req.id],
          });
        }

        // Audit log
        txQueries.push({
          sql: `INSERT INTO membership_audit_logs (admin_id, admin_username, target_telegram_id, request_id, action, level_before, level_after, status_before, status_after, detail, ip)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
          params: [
            String(auth.user.id), auth.user.username || null, req.telegram_id, req.id, action.toUpperCase(),
            levelBefore, newLevel || levelBefore, statusBefore, newStatus, adminNote, ip,
          ],
        });

        await deps.queryDbTransaction(env, txQueries);
        await invalidateCaches(env, req.telegram_id);
        return jsonResponse({ ok: true, data: { ok: true, requestId: req.id } }, {}, env);
      } catch (e) { return safeDbErrorResponse(e, {}, env); }
    };
  }

  const handleApprove = makeActionHandler('approve', 'APPROVED', 'VIP', 'EXCHANGE');
  const handleReject = makeActionHandler('reject', 'REJECTED', null, null);
  const handleSuspend = makeActionHandler('suspend', 'SUSPENDED', null, null);
  const handleReactivate = makeActionHandler('reactivate', 'APPROVED', null, null);

  // ─── Bulk Actions ────────────────────────────────────────────────────────

  function makeBulkHandler(action) {
    return async function handleBulk(request, env) {
      const auth = await requireAdminUser(request, env);
      if (auth.error) return auth.error;
      if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
      const { payload, error } = await readJsonBody(request);
      if (error) return error;
      const ids = payload.requestIds;
      const adminNote = payload.adminNote || (action === 'approve' ? 'Bulk approve' : 'Bulk reject');
      if (!Array.isArray(ids) || ids.length === 0 || ids.length > 50) {
        return buildBodyFieldValidationError([{ field: 'requestIds', message: '1-50 IDs required' }], env);
      }
      const ip = ipFrom(request);
      try {
        const reqs = await membershipRepo.findManyByIds(env, ids);
        const succeeded = [];
        const failed = [];
        const now = new Date().toISOString();

        for (const req of reqs) {
          if (req.status !== 'PENDING') {
            failed.push({ requestId: req.id, reason: `Request is ${req.status}`, code: 'INVALID_STATE' });
            continue;
          }
          try {
            const user = await membershipRepo.findByTelegramId(env, req.telegram_id);
            const statusBefore = user?.membership_status || 'INACTIVE';
            const levelBefore = user?.membership_level || 'FREE';
            const newStatus = action === 'approve' ? 'APPROVED' : 'REJECTED';
            const newLevel = action === 'approve' ? 'VIP' : levelBefore;
            const newSource = action === 'approve' ? 'EXCHANGE' : (user?.membership_source || 'MANUAL');

            const txQueries = [];
            const userSets = [`membership_status = '${newStatus}'`, 'updated_at = NOW()'];
            if (action === 'approve') {
              userSets.unshift(`membership_level = 'VIP'`);
              userSets.unshift(`membership_source = 'EXCHANGE'`);
              userSets.push(`approved_by = '${auth.user.id}'`);
              userSets.push(`approved_at = '${now}'`);
              userSets.push('expire_at = NULL');
            }
            txQueries.push({
              sql: `UPDATE membership_users SET ${userSets.join(', ')} WHERE telegram_id = $1`,
              params: [req.telegram_id],
            });
            txQueries.push({
              sql: `UPDATE membership_requests SET status = $1, admin_note = $2, reviewed_at = $3, reviewed_by = $4, updated_at = NOW() WHERE id = $5`,
              params: [newStatus, adminNote, now, String(auth.user.id), req.id],
            });
            txQueries.push({
              sql: `INSERT INTO membership_audit_logs (admin_id, admin_username, target_telegram_id, request_id, action, level_before, level_after, status_before, status_after, detail, ip)
                    VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11)`,
              params: [String(auth.user.id), auth.user.username || null, req.telegram_id, req.id, action.toUpperCase(),
                       levelBefore, newLevel, statusBefore, newStatus, adminNote, ip],
            });
            await deps.queryDbTransaction(env, txQueries);
            await invalidateCaches(env, req.telegram_id);
            succeeded.push({ requestId: req.id });
          } catch (e) {
            failed.push({ requestId: req.id, reason: e.message || 'Error', code: 'ERROR' });
          }
        }
        // Report not-found IDs
        const foundIds = new Set(reqs.map(r => r.id));
        for (const id of ids) if (!foundIds.has(id)) failed.push({ requestId: id, reason: 'Not found', code: 'NOT_FOUND' });

        return jsonResponse({ ok: true, data: { succeeded, failed } }, {}, env);
      } catch (e) { return safeDbErrorResponse(e, {}, env); }
    };
  }

  const handleBulkApprove = makeBulkHandler('approve');
  const handleBulkReject = makeBulkHandler('reject');

  // ─── Admin Users Management ───────────────────────────────────────────────

  /** GET /api/admin/membership/users */
  async function handleListUsers(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const url = new URL(request.url);
    const sp = url.searchParams;
    const params = {
      ...parsePagination(url),
      level: sp.get('level') || undefined,
      status: sp.get('status') || undefined,
      source: sp.get('source') || undefined,
    };
    const cacheKey = ckAdminUsers(serializeParams(params));
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const result = await membershipRepo.listUsers(env, params);
      await writeAppCache(env, cacheKey, JSON.stringify(result), CACHE_TTL.REQUESTS);
      return jsonResponse({ ok: true, data: result }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** GET /api/admin/membership/users/:telegramId */
  async function handleGetUserDetail(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const tgId = new URL(request.url).pathname.split('/').pop();
    try {
      const detail = await membershipRepo.getUserDetail(env, tgId);
      if (!detail.user) return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }, env);
      return jsonResponse({ ok: true, data: detail }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── Manual User Actions (suspend/reactivate/expire/set-level) ────────────

  function makeManualActionHandler(action) {
    return async function handleManualAction(request, env) {
      const auth = await requireAdminUser(request, env);
      if (auth.error) return auth.error;
      if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
      const { payload, error } = await readJsonBody(request);
      if (error) return error;
      const tgId = payload.telegramId;
      const adminNote = payload.adminNote || null;
      const newLevel = payload.level;
      if (!tgId) return buildBodyFieldValidationError([{ field: 'telegramId', message: 'Required' }], env);
      if (action === 'set-level' && !['FREE', 'VIP', 'PREMIUM', 'ELITE'].includes(newLevel)) {
        return buildBodyFieldValidationError([{ field: 'level', message: 'Invalid level' }], env);
      }
      const ip = ipFrom(request);
      try {
        const user = await membershipRepo.findByTelegramId(env, tgId);
        if (!user) return jsonResponse({ error: 'Not found', code: 'NOT_FOUND' }, { status: 404 }, env);
        const statusBefore = user.membership_status;
        const levelBefore = user.membership_level;

        let newStatus, finalLevel = levelBefore, finalSource = user.membership_source;
        if (action === 'suspend') { newStatus = 'SUSPENDED'; if (!canTransition(statusBefore, 'SUSPENDED')) return jsonResponse({ error: 'Invalid transition', code: 'INVALID_TRANSITION' }, { status: 409 }, env); }
        else if (action === 'reactivate') { newStatus = 'APPROVED'; if (!canTransition(statusBefore, 'APPROVED')) return jsonResponse({ error: 'Invalid transition', code: 'INVALID_TRANSITION' }, { status: 409 }, env); }
        else if (action === 'expire') { newStatus = 'EXPIRED'; if (!canTransition(statusBefore, 'EXPIRED')) return jsonResponse({ error: 'Invalid transition', code: 'INVALID_TRANSITION' }, { status: 409 }, env); }
        else if (action === 'set-level') { finalLevel = newLevel; newStatus = newLevel === 'FREE' ? 'INACTIVE' : 'APPROVED'; }

        const now = new Date().toISOString();
        const txQueries = [];
        const userSets = [`membership_status = '${newStatus}'`, `membership_level = '${finalLevel}'`, 'updated_at = NOW()'];
        if (action === 'set-level') {
          userSets.push(`approved_by = '${auth.user.id}'`);
          if (levelBefore === 'FREE' && newLevel !== 'FREE') userSets.push(`approved_at = '${now}'`);
          userSets.push(newLevel === 'FREE' ? `expire_at = '${now}'` : 'expire_at = NULL');
        }
        if (action === 'expire') userSets.push(`expire_at = '${now}'`);
        txQueries.push({
          sql: `UPDATE membership_users SET ${userSets.join(', ')} WHERE telegram_id = $1`,
          params: [tgId],
        });
        txQueries.push({
          sql: `INSERT INTO membership_audit_logs (admin_id, admin_username, target_telegram_id, action, level_before, level_after, status_before, status_after, detail, ip)
                VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)`,
          params: [String(auth.user.id), auth.user.username || null, tgId, action.toUpperCase(),
                   levelBefore, finalLevel, statusBefore, newStatus, adminNote || `Manual ${action}`, ip],
        });
        await deps.queryDbTransaction(env, txQueries);
        await invalidateCaches(env, tgId);
        return jsonResponse({ ok: true, data: { ok: true, telegramId: tgId, level: finalLevel } }, {}, env);
      } catch (e) { return safeDbErrorResponse(e, {}, env); }
    };
  }

  const handleManualSuspend = makeManualActionHandler('suspend');
  const handleManualReactivate = makeManualActionHandler('reactivate');
  const handleManualExpire = makeManualActionHandler('expire');
  const handleSetLevel = makeManualActionHandler('set-level');

  // ─── Audit Logs ──────────────────────────────────────────────────────────

  /** GET /api/admin/membership/logs */
  async function handleListLogs(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const url = new URL(request.url);
    const sp = url.searchParams;
    const params = {
      ...parsePagination(url),
      action: sp.get('action') || undefined,
      adminId: sp.get('adminId') || undefined,
      targetTelegramId: sp.get('targetTelegramId') || undefined,
    };
    const cacheKey = ckLogs(serializeParams(params));
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const result = await membershipRepo.listAuditLogs(env, params);
      await writeAppCache(env, cacheKey, JSON.stringify(result), CACHE_TTL.STATS);
      return jsonResponse({ ok: true, data: result }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── CSV Export ──────────────────────────────────────────────────────────

  function csvEscape(v) {
    if (v == null) return '';
    const s = String(v).replace(/"/g, '""');
    return /[",\n]/.test(s) ? `"${s}"` : s;
  }

  async function handleExportRequests(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const url = new URL(request.url);
    const params = { ...parsePagination(url), pageSize: 1000, status: url.searchParams.get('status') || undefined, exchange: url.searchParams.get('exchange') || undefined };
    try {
      const result = await membershipRepo.listRequestsWithUser(env, params);
      const header = ['ID','Telegram ID','Username','Name','Exchange','Exchange UID','Status','Level','Submitted At','Reviewed At','Reviewed By','Note','Admin Note'].join(',');
      const rows = result.items.map(r => [r.id, r.telegram_id, r.username, [r.first_name, r.last_name].filter(Boolean).join(' '), r.exchange_name, r.exchange_uid, r.status, r.membership_level, r.submitted_at, r.reviewed_at, r.reviewed_by, r.note, r.admin_note].map(csvEscape).join(','));
      const csv = '\ufeff' + [header, ...rows].join('\n');
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="membership-requests.csv"' } });
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleExportUsers(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const url = new URL(request.url);
    const params = { ...parsePagination(url), pageSize: 1000, level: url.searchParams.get('level') || undefined, status: url.searchParams.get('status') || undefined, source: url.searchParams.get('source') || undefined };
    try {
      const result = await membershipRepo.listUsers(env, params);
      const header = ['ID','Telegram ID','Username','First Name','Last Name','Level','Status','Source','Approved At','Expire At','Created At','Request Count'].join(',');
      const rows = result.items.map(u => [u.id, u.telegram_id, u.username, u.first_name, u.last_name, u.membership_level, u.membership_status, u.membership_source, u.approved_at, u.expire_at, u.created_at, u.request_count].map(csvEscape).join(','));
      const csv = '\ufeff' + [header, ...rows].join('\n');
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="membership-users.csv"' } });
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  async function handleExportLogs(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    try {
      const result = await membershipRepo.listAuditLogs(env, { page: 1, pageSize: 1000 });
      const header = ['ID','Created At','Action','Admin ID','Admin Username','Target Telegram ID','Request ID','Level Before','Level After','Status Before','Status After','Detail','IP'].join(',');
      const rows = result.items.map(l => [l.id, l.created_at, l.action, l.admin_id, l.admin_username, l.target_telegram_id, l.request_id, l.level_before, l.level_after, l.status_before, l.status_after, l.detail, l.ip].map(csvEscape).join(','));
      const csv = '\ufeff' + [header, ...rows].join('\n');
      return new Response(csv, { status: 200, headers: { 'content-type': 'text/csv; charset=utf-8', 'content-disposition': 'attachment; filename="membership-audit-logs.csv"' } });
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  return {
    handleGetStatus,
    handleGetMyRequests,
    handleSubmitRequest,
    handleGetStats,
    handleListRequests,
    handleGetRequest,
    handleApprove,
    handleReject,
    handleSuspend,
    handleReactivate,
    handleBulkApprove,
    handleBulkReject,
    handleListUsers,
    handleGetUserDetail,
    handleManualSuspend,
    handleManualReactivate,
    handleManualExpire,
    handleSetLevel,
    handleListLogs,
    handleExportRequests,
    handleExportUsers,
    handleExportLogs,
  };
};

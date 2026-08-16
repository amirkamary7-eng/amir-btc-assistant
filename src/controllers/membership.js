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
    notificationRepo,
    notificationPlatformRepo,
    notificationService,
    sendTelegramMessage,
    resolveWebAppUrl,
    // PHASE 5: Optional cosmetics repo for active cosmetic in status response
    cosmeticsRepo,
    // PHASE 7A: MembershipAuthority — entitlement cache invalidation.
    // Required so that admin/user state-changing paths (approve, suspend,
    // reactivate, expire, set-level, bulk approve/reject, user reapply)
    // can immediately bust the mb:ent:{id} positive entitlement cache.
    // See invalidateCaches() below. Optional for backwards compatibility
    // with existing tests that don't supply it (skipped if absent).
    membershipAuthority,
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
        // PHASE 7A (I1 fix): invalidate the MembershipAuthority entitlement
        // cache (mb:ent:{id}) on every membership state change so that
        // isPremium() / getEntitlement() cannot return a stale POSITIVE
        // result for up to CACHE_TTL_POSITIVE (60s) after an admin
        // suspend / expire / set-level→FREE.
        //
        // membershipAuthority.invalidate() also clears mb:status:{id}
        // (same key as ckStatus above) — calling both is idempotent and
        // harmless. We keep the explicit ckStatus delete above so the
        // behavior is preserved even if membershipAuthority is not
        // injected (backwards compatibility with older test harnesses).
        if (membershipAuthority && typeof membershipAuthority.invalidate === 'function') {
          await membershipAuthority.invalidate(env, telegramId);
        } else {
          // Fallback: direct KV delete of the entitlement cache key.
          // Mirrors membership_authority.js _cacheKey() prefix 'mb:ent:'.
          await env.APP_CACHE?.delete?.('mb:ent:' + telegramId);
        }
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
    // Phase 2: Exchange validation is now data-driven (checked against the active
    // requirement in handleSubmitRequest via isExchangeMatchingActive). Here we
    // only validate that exchange is a non-empty string of reasonable length.
    const rawExchange = typeof body.exchange === 'string' ? body.exchange.trim() : '';
    if (!rawExchange || rawExchange.length > 64) {
      errors.push({ field: 'exchange', message: 'Invalid exchange' });
    }
    const uid = String(body.uid || '').trim();
    if (uid.length < 4 || uid.length > 64 || !/^[A-Za-z0-9_-]+$/.test(uid)) {
      errors.push({ field: 'uid', message: 'UID must be 4-64 alphanumeric chars' });
    }
    if (body.note && String(body.note).length > 500) {
      errors.push({ field: 'note', message: 'Note too long' });
    }
    return { valid: errors.length === 0, errors, uid, exchange: rawExchange, note: body.note };
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
      // PHASE 5: Fetch active cosmetic (if cosmeticsRepo available)
      let activeCosmetic = null;
      if (cosmeticsRepo) {
        try {
          activeCosmetic = await cosmeticsRepo.getActive(env, tgId);
        } catch (e) {
          activeCosmetic = null;
        }
      }
      const dto = user ? {
        level: user.membership_level,
        status: user.membership_status,
        source: user.membership_source,
        lifetime: user.membership_status === 'APPROVED' && !user.expire_at,
        approvedAt: user.approved_at,
        expireAt: user.expire_at,
        welcomeShown: Boolean(user.welcome_shown),
        active_cosmetic: activeCosmetic ? {
          cosmetic_id: activeCosmetic.cosmetic_id,
          cosmetic_key: activeCosmetic.cosmetic_key,
          title: activeCosmetic.title,
          rarity: activeCosmetic.rarity,
          metadata: activeCosmetic.metadata || {},
        } : null,
      } : {
        level: 'FREE', status: 'INACTIVE', source: 'MANUAL',
        lifetime: false, approvedAt: null, expireAt: null,
        welcomeShown: true,
        active_cosmetic: null,
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

      // ── Phase 7C-B (H2 fix): State machine validation ──────────────────────
      // A user whose current membership_status is SUSPENDED (or APPROVED /
      // PENDING) must NOT be able to transition to PENDING by submitting a new
      // request. This closes the suspension-bypass: previously a SUSPENDED user
      // could submit a new request → status set to PENDING → admin approves →
      // user returns to APPROVED/VIP, bypassing the suspension entirely.
      //
      // ALLOWED_TRANSITIONS only permits: INACTIVE→PENDING, REJECTED→PENDING,
      // EXPIRED→PENDING. We reuse the existing canTransition() + 409
      // INVALID_TRANSITION response format used by the admin action handlers.
      const currentUser = await membershipRepo.findByTelegramId(env, tgId);
      const currentStatus = currentUser?.membership_status || 'INACTIVE';
      if (!canTransition(currentStatus, 'PENDING')) {
        return jsonResponse({
          error: `Cannot submit request from status ${currentStatus}`,
          code: 'INVALID_TRANSITION',
          details: { from: currentStatus, to: 'PENDING' },
        }, { status: 409 }, env);
      }

      // ── Phase 1: Rules Acceptance Validation ──────────────────────────────
      // FAIL-OPEN: if the rules table doesn't exist, has no active version, or
      // the query errors, the request proceeds WITHOUT requiring acceptance.
      let activeRulesVersion = null;
      try {
        const activeRules = await membershipRepo.getActiveRules(env);
        if (activeRules && activeRules.version) {
          activeRulesVersion = activeRules.version;
          const acceptance = await membershipRepo.getAcceptance(env, tgId, activeRules.version);
          if (!acceptance) {
            return jsonResponse({ error: 'Premium rules must be accepted before submitting a request', code: 'RULES_NOT_ACCEPTED', active_version: activeRules.version }, { status: 403 }, env);
          }
        }
      } catch (rulesErr) {
        console.warn('[membership] rules check failed, fail-open:', rulesErr?.message || rulesErr);
      }

      // ── Phase 2: Requirement Exchange Validation ──────────────────────────
      // FAIL-OPEN: if the requirements table doesn't exist, has no active version,
      // or the query errors, the request proceeds with the legacy validation.
      let activeRequirement = null;
      try {
        const check = await membershipRepo.isExchangeMatchingActive(env, v.exchange);
        if (check.requirement) {
          activeRequirement = check.requirement;
          if (!check.matches) {
            return jsonResponse({
              error: `Exchange must be ${check.requirement.exchange_name} (current active requirement)`,
              code: 'EXCHANGE_NOT_MATCHING_REQUIREMENT',
              active_exchange: check.requirement.exchange_name,
              active_version: check.requirement.version,
            }, { status: 403 }, env);
          }
        }
      } catch (reqErr) {
        console.warn('[membership] requirement check failed, fail-open:', reqErr?.message || reqErr);
      }

      // Upsert user
      await membershipRepo.upsertByTelegramId(env, {
        telegramId: tgId,
        username: auth.user.username || null,
        firstName: auth.user.first_name || null,
        lastName: auth.user.last_name || null,
      });

      // Transactional: create request + update user status + audit log
      const hasRulesVersion = activeRulesVersion !== null;
      const txQueries = [
        hasRulesVersion
          ? {
              sql: `INSERT INTO membership_requests (telegram_id, exchange_name, exchange_uid, note, rules_version)
                    VALUES ($1, $2, $3, $4, $5) RETURNING *`,
              params: [tgId, v.exchange, v.uid, v.note || null, activeRulesVersion],
            }
          : {
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
      return jsonResponse({ ok: true, data: { status: 'PENDING', exchange: v.exchange, uid: v.uid, rules_version: activeRulesVersion, requirement_version: activeRequirement ? activeRequirement.version : null } }, { status: 201 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── Handlers: Premium Rules (Phase 1) ────────────────────────────────────

  /** GET /api/membership/rules — get current active rules (cached 5 min) */
  async function handleGetRules(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const cacheKey = 'mb:rules:active';
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const rules = await membershipRepo.getActiveRules(env);
      if (!rules) {
        return jsonResponse({ ok: true, data: { version: null, title: null, body_markdown: null, summary: null, active: false } }, {}, env);
      }
      const dto = {
        version: rules.version, title: rules.title,
        body_markdown: rules.body_markdown, summary: rules.summary,
        effective_at: rules.effective_at, created_at: rules.created_at,
        active: rules.status === 'ACTIVE',
      };
      await writeAppCache(env, cacheKey, JSON.stringify(dto), CACHE_TTL.STATUS);
      return jsonResponse({ ok: true, data: dto }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** POST /api/membership/rules/accept — record user's acceptance of active rules */
  async function handleAcceptRules(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const { payload, error } = await readJsonBody(request);
    if (error) return error;
    const submittedVersion = Number(payload?.rules_version);
    if (!Number.isFinite(submittedVersion) || submittedVersion < 1) {
      return buildBodyFieldValidationError([{ field: 'rules_version', message: 'rules_version must be a positive integer' }], env);
    }
    const tgId = String(auth.user.id);
    const ip = request.headers.get('cf-connecting-ip') || (request.headers.get('x-forwarded-for') || '').split(',')[0].trim() || null;
    const userAgent = request.headers.get('user-agent') || null;
    try {
      const rules = await membershipRepo.getRulesByVersion(env, submittedVersion);
      if (!rules) return jsonResponse({ error: 'Rules version not found', code: 'RULES_NOT_FOUND' }, { status: 404 }, env);
      if (rules.status !== 'ACTIVE') {
        return jsonResponse({ error: 'Cannot accept a non-active rules version', code: 'RULES_NOT_ACTIVE' }, { status: 409 }, env);
      }
      const acceptance = await membershipRepo.recordAcceptance(env, {
        telegramId: tgId, rulesVersion: submittedVersion,
        requestId: payload?.request_id || null, ip, userAgent,
        metadata: { source: payload?.source || 'membership_page' },
      });
      if (!acceptance) return jsonResponse({ error: 'Failed to record acceptance', code: 'ACCEPTANCE_FAILED' }, { status: 500 }, env);
      return jsonResponse({ ok: true, data: { accepted: true, rules_version: acceptance.rules_version, accepted_at: acceptance.accepted_at } }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** GET /api/membership/rules/accepted — check if current user has accepted active rules */
  async function handleCheckAcceptance(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const tgId = String(auth.user.id);
    try {
      const rules = await membershipRepo.getActiveRules(env);
      if (!rules) return jsonResponse({ ok: true, data: { has_accepted: false, rules_version: null, active: false } }, {}, env);
      const acceptance = await membershipRepo.getAcceptance(env, tgId, rules.version);
      return jsonResponse({ ok: true, data: { has_accepted: !!acceptance, rules_version: rules.version, active: true, accepted_at: acceptance?.accepted_at || null } }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  // ─── Handlers: Membership Requirements (Phase 2) ──────────────────────────

  /** GET /api/membership/requirement — get current active requirement (cached 5 min) */
  async function handleGetRequirement(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const cacheKey = 'mb:req:active';
    const cached = await readAppCache(env, cacheKey);
    if (cached) return jsonResponse({ ok: true, data: JSON.parse(cached) }, {}, env);
    try {
      const req = await membershipRepo.getActiveRequirement(env);
      if (!req) {
        return jsonResponse({ ok: true, data: { active: false, exchange_name: null, version: null } }, {}, env);
      }
      const dto = {
        active: true, id: req.id, version: req.version, label: req.label,
        exchange_name: req.exchange_name, exchange_register_url: req.exchange_register_url,
        uid_label: req.uid_label, referral_code: req.referral_code,
        requires_first_trade: req.requires_first_trade,
        required_volume: Number(req.required_volume) || 0,
        reward_level: req.reward_level, grace_period_days: req.grace_period_days,
        metadata: req.metadata || {},
      };
      await writeAppCache(env, cacheKey, JSON.stringify(dto), CACHE_TTL.STATUS);
      return jsonResponse({ ok: true, data: dto }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** GET /api/admin/membership/requirements — list all requirements (admin) */
  async function handleListRequirements(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    try {
      const requirements = await membershipRepo.listAllRequirements(env);
      return jsonResponse({ ok: true, data: requirements }, {}, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** POST /api/admin/membership/requirements — create a new requirement (DRAFT) */
  async function handleCreateRequirement(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const { payload, error } = await readJsonBody(request);
    if (error) return error;
    if (!payload?.exchange_name || !payload?.exchange_register_url) {
      return buildBodyFieldValidationError([{ field: 'exchange_name', message: 'exchange_name and exchange_register_url required' }], env);
    }
    try {
      const req = await membershipRepo.createRequirement(env, payload);
      await env.APP_CACHE?.delete?.('mb:req:active');
      try {
        await membershipRepo.createAuditLog(env, {
          adminId: String(auth.user.id), adminUsername: auth.user.username || null,
          action: 'REQUIREMENT_CREATED',
          detail: `Exchange: ${payload.exchange_name}, Label: ${payload.label || payload.exchange_name}`,
        });
      } catch (e) { /* non-fatal */ }
      return jsonResponse({ ok: true, data: req }, { status: 201 }, env);
    } catch (e) { return safeDbErrorResponse(e, {}, env); }
  }

  /** POST /api/admin/membership/requirements/activate — switch active requirement */
  async function handleActivateRequirement(request, env) {
    const auth = await requireAdminUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const { payload, error } = await readJsonBody(request);
    if (error) return error;
    const version = Number(payload?.version);
    if (!Number.isFinite(version) || version < 1) {
      return buildBodyFieldValidationError([{ field: 'version', message: 'version must be a positive integer' }], env);
    }
    try {
      const target = await membershipRepo.getRequirementByVersion(env, version);
      if (!target) return jsonResponse({ error: 'Requirement version not found', code: 'NOT_FOUND' }, { status: 404 }, env);
      if (target.status === 'ACTIVE') return jsonResponse({ ok: true, data: target, message: 'Already active' }, {}, env);
      const activated = await membershipRepo.activateRequirement(env, version, String(auth.user.id));
      if (!activated) return jsonResponse({ error: 'Activation failed', code: 'ACTIVATION_FAILED' }, { status: 500 }, env);
      await env.APP_CACHE?.delete?.('mb:req:active');
      try {
        await membershipRepo.createAuditLog(env, {
          adminId: String(auth.user.id), adminUsername: auth.user.username || null,
          action: 'REQUIREMENT_ACTIVATED',
          detail: `Activated requirement v${version} (${target.exchange_name})`,
        });
      } catch (e) { /* non-fatal */ }
      return jsonResponse({ ok: true, data: activated }, {}, env);
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

        // ── Phase 2: Premium welcome notification (only on approve) ──
        // Phase 2: Direct INSERT removed — moved OUT of transaction.
        // After commit, NotificationService.create() handles both in-app
        // notification AND Telegram delivery (with rich message support).
        // welcome_shown reset stays in transaction (membership state).
        if (action === 'approve') {
          txQueries.push({
            sql: `UPDATE membership_users SET welcome_shown = FALSE WHERE telegram_id = $1`,
            params: [req.telegram_id],
          });
        }

        await deps.queryDbTransaction(env, txQueries);
        await invalidateCaches(env, req.telegram_id);

        // Phase 2: Send premium welcome notification via NotificationService
        // (single entry point). Handles in-app INSERT + Telegram enqueue with
        // rich message (inline keyboard). No direct sendTelegramMessage.
        // dedupKey ensures idempotency: re-approving won't duplicate.
        if (action === 'approve' && notificationService) {
          try {
            const webAppUrl = typeof resolveWebAppUrl === 'function' ? resolveWebAppUrl(env) : '';
            const levelLabel = { VIP: 'VIP', PREMIUM: 'Premium', ELITE: 'Elite' }[newLevel || 'VIP'] || 'VIP';
            const inAppMessage = 'تبریک! عضویت ویژه شما با موفقیت فعال شد. تمام امکانات اختصاصی اکنون در دسترس شماست. Mini App را باز کنید و از تجربه Premium لذت ببرید.';
            const telegramMessage = [
              `🎉 تبریک! عضویت ${levelLabel} شما فعال شد.`,
              ``,
              `✨ مزایای عضویت ویژه شما:`,
              `• دسترسی به چارت‌ها و تحلیل‌های اختصاصی`,
              `• نشان Premium در پروفایل شما`,
              `• اولویت در دریافت قابلیت‌های جدید`,
              `• شرکت در کمپین‌ها و جوایز ویژه`,
              ``,
              `🚀 برای استفاده از تمام امکانات، Mini App را باز کنید:`,
            ].join('\n');

            const telegramExtra = {
              parse_mode: 'HTML',
              disable_web_page_preview: true,
            };
            if (webAppUrl) {
              telegramExtra.reply_markup = {
                inline_keyboard: [[
                  { text: '📱 باز کردن Mini App', web_app: { url: webAppUrl } },
                ]],
              };
            }

            // Await — ensures notification completes BEFORE withSharedPool closes the DB pool.
            // Fire-and-forget would cause "Cannot perform I/O on behalf of a different request"
            // because the Promise would outlive the request's env._reqPool.
            await notificationService.create(env, {
              userId: String(req.telegram_id),
              category: 'membership',
              priority: 'high',
              channel: 'both',
              forceChannel: true, // premium welcome is always delivered
              title: '🎉 عضویت Premium فعال شد',
              message: inAppMessage,
              metadata: { level: newLevel || 'VIP', approvedAt: now, source: 'exchange' },
              dedupKey: `premium_${req.telegram_id}`,
              telegramExtra,
            }).catch((tgErr) => {
              console.warn('[membership] Notification enqueue failed for premium approval:', tgErr?.message || tgErr);
            });
          } catch (tgErr) {
            console.warn('[membership] Notification setup failed:', tgErr?.message || tgErr);
          }
        }

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

  // ─── Phase 4: Mark Welcome Popup as Shown ────────────────────────────────

  /** POST /api/membership/welcome-shown — mark the one-time welcome popup as shown. */
  async function handleMarkWelcomeShown(request, env) {
    const auth = await requireUser(request, env);
    if (auth.error) return auth.error;
    if (!isDatabaseConfigured(env)) return safeDbErrorResponse(new Error('DB not configured'), {}, env);
    const tgId = String(auth.user.id);
    try {
      await membershipRepo.ensureSchema(env);
      const updated = await membershipRepo.markWelcomeShown(env, tgId);
      // Invalidate status cache so subsequent reads reflect welcomeShown=true
      await env.APP_CACHE?.delete?.(ckStatus(tgId));
      return jsonResponse({ ok: true, data: { marked: updated } }, {}, env);
    } catch (e) {
      return safeDbErrorResponse(e, {}, env);
    }
  }

  return {
    handleGetStatus,
    handleGetMyRequests,
    handleSubmitRequest,
    handleMarkWelcomeShown,
    // Phase 1: Rules + Acceptance
    handleGetRules,
    handleAcceptRules,
    handleCheckAcceptance,
    // Phase 2: Requirements + Exchange Decoupling
    handleGetRequirement,
    handleListRequirements,
    handleCreateRequirement,
    handleActivateRequirement,
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

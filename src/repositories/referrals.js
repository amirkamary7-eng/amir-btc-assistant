/**
 * Referral Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to referrals.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * IMPORTANT: This module NEVER writes to token_balances or token_transactions
 * directly. All reward credits go through walletRepo.creditTokens().
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createReferralRepository(deps) {
  const { queryDb, getReferralRewardPerInvite, getNumericEnv } = deps;

  let _schemaVerified = false;

  // ── REFERRAL LEVEL (independent from Wallet tier) ─────────────────────────
  // Canonical Referral Level ladder. Basis: ACTIVE successful referrals
  // (referrals with channel_verified = TRUE — the invitee actually joined).
  // Deliberately independent from the Wallet tier ladder (Bronze/Silver/Gold/
  // Diamond by AB balance in src/repositories/wallet.js TIERS): the two
  // systems must never share a source. Platinum exists ONLY here (and in the
  // shared display palette); the Wallet ladder stays 4-tier.
  const REFERRAL_LEVELS = [
    { name: 'Starter',  min: 0 },
    { name: 'Bronze',   min: 3 },
    { name: 'Silver',   min: 10 },
    { name: 'Gold',    min: 25 },
    { name: 'Platinum', min: 50 },
    { name: 'Diamond',  min: 100 },
  ];

  /**
   * Pure function: map an ACTIVE referral count to a Referral Level
   * ({ current, next, progress, remaining }). Mirrors the trusted
   * getTierForBalance shape/contract from the wallet repository — runtime
   * calculation only, nothing persisted, no DB access.
   *
   *   Starter 0–2 · Bronze 3–9 · Silver 10–24 · Gold 25–49
   *   Platinum 50–99 · Diamond 100+
   */
  function getReferralLevelForCount(activeCount) {
    const count = Math.max(0, Math.floor(Number(activeCount) || 0));
    for (let i = REFERRAL_LEVELS.length - 1; i >= 0; i--) {
      if (count >= REFERRAL_LEVELS[i].min) {
        const current = REFERRAL_LEVELS[i];
        const next = REFERRAL_LEVELS[i + 1] || null;
        return {
          current: current.name,
          next: next ? next.name : null,
          progress: next ? Math.min(100, ((count - current.min) / (next.min - current.min)) * 100) : 100,
          remaining: next ? Math.max(0, next.min - count) : 0,
        };
      }
    }
    return { current: 'Starter', next: 'Bronze', progress: 0, remaining: 3 };
  }

  /**
   * Ensure referrals table has all required columns for future features.
   * Adds: status, metadata, updated_at, source, campaign_id.
   * Also creates indexes for leaderboard and history queries.
   */
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    // PROD-DDL-SKIP: tables provisioned by migrations; skip runtime DDL in production.
    if (env && String(env.APP_ENV || '').toLowerCase() === 'production') {
      _schemaVerified = true;
      return;
    }
    // ROOT-CAUSE FIX: Merge ALL schema migrations into a SINGLE queryDb call.
    // Previously this was 2 separate queryDb calls (batch SQL + DO block),
    // each creating a new Pool + TLS handshake (~3-5ms CPU each).
    // 2 calls × 5ms = 10ms → exceededCpu on /api/referrals/stats.
    // Now 1 call = 1 Pool = ~3-5ms CPU.
    const batchSql = `
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'direct';
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(64);
      CREATE INDEX IF NOT EXISTS idx_referrals_inviter_created ON referrals (inviter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status);
      CREATE INDEX IF NOT EXISTS idx_referrals_campaign ON referrals (campaign_id);
      DO $$
      BEGIN
        IF NOT EXISTS (
          SELECT 1 FROM pg_constraint
          WHERE conname = 'uq_referral_invitee'
            AND conrelid = 'referrals'::regclass
        ) THEN
          ALTER TABLE referrals ADD CONSTRAINT uq_referral_invitee UNIQUE (invitee_id);
        END IF;
      END $$;
    `;
    try {
      await queryDb(env, batchSql);
    } catch (e) {
      console.warn('Referral schema migration warning:', e.message);
      return; // P2 FIX: don't set _schemaVerified on error — allow retry
    }
    _schemaVerified = true;
  }

  /**
   * Serialize a referral row.
   */
  function serializeReferralRow(row) {
    let metadata = {};
    try {
      if (row.metadata) {
        metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      }
    } catch {}
    return {
      id: row.id,
      inviter_id: row.inviter_id,
      invitee_id: row.invitee_id,
      channel_verified: Boolean(row.channel_verified),
      rewarded: Boolean(row.rewarded),
      status: row.status || 'active',
      source: row.source || 'direct',
      campaign_id: row.campaign_id || null,
      metadata,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  /**
   * Get aggregated referral stats for a user.
   * Does NOT read token_balances directly — returns referral-specific counts only.
   * Wallet balance should be fetched from the wallet service.
   */
  async function getStats(env, userId) {
    await ensureSchema(env).catch(() => {});
    // ROOT-CAUSE FIX: Merge reward_per_invite query into the main stats query
    // via CTE. Previously getStats made 2 queryDb calls (stats + getReferralRewardPerInvite),
    // each creating a separate Pool + TLS handshake (~3-5ms CPU each).
    // Now 1 queryDb call = 1 Pool = ~3-5ms CPU. Halves the CPU cost.
    const result = await queryDb(
      env,
      `
        WITH stats AS (
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE channel_verified = true)::int AS active,
            COUNT(*) FILTER (WHERE rewarded = true)::int AS rewarded,
            COUNT(*) FILTER (WHERE status = 'active')::int AS active_status,
            COUNT(*) FILTER (WHERE status = 'flagged')::int AS flagged,
            COUNT(*) FILTER (WHERE status = 'reversed')::int AS reversed
          FROM referrals
          WHERE inviter_id = $1
        ),
        reward AS (
          SELECT token_amount FROM referral_reward_tiers
          WHERE is_enabled = TRUE AND invite_count <= 1
          ORDER BY invite_count DESC LIMIT 1
        )
        SELECT
          s.total, s.active, s.rewarded, s.active_status, s.flagged, s.reversed,
          COALESCE(r.token_amount, 0)::int AS reward_per_invite
        FROM stats s
        LEFT JOIN reward r ON true
      `,
      [String(userId)],
    );
    const row = result.rows[0] || {};
    const rewardPerInvite = Number(row.reward_per_invite || 0);
    // REFERRAL LEVEL: derived at runtime from THIS query's active count
    // (channel_verified = TRUE) via the canonical ladder above — zero extra
    // queries, zero persistence. Independent from the wallet balance tier.
    const activeCount = Number(row.active || 0);
    return {
      total: Number(row.total || 0),
      active: activeCount,
      rewarded: Number(row.rewarded || 0),
      flagged: Number(row.flagged || 0),
      reversed: Number(row.reversed || 0),
      pending: Number(row.total || 0) - Number(row.rewarded || 0),
      level: getReferralLevelForCount(activeCount),
      // Use DB value if > 0, otherwise fall back to env var (no extra query)
      reward_per_invite: rewardPerInvite > 0 ? rewardPerInvite : Math.max(getNumericEnv(env, 'REFERRAL_TOKENS_PER_INVITE', 3), 0),
    };
  }

  /**
   * Get referral history — list of all invitees with full details.
   * Supports pagination.
   */
  async function getHistory(env, userId, offset = 0, limit = 20) {
    await ensureSchema(env).catch(() => {});
    const countResult = await queryDb(
      env,
      'SELECT COUNT(*)::int AS total FROM referrals WHERE inviter_id = $1',
      [String(userId)],
    );
    const total = Number(countResult.rows[0]?.total || 0);

    const historyResult = await queryDb(
      env,
      `
        SELECT r.id, r.inviter_id, r.invitee_id, r.channel_verified, r.rewarded,
               r.status, r.source, r.campaign_id, r.metadata, r.created_at, r.updated_at,
               u.username AS invitee_username, u.first_name AS invitee_first_name
        FROM referrals r
        LEFT JOIN users u ON r.invitee_id = u.telegram_id
        WHERE r.inviter_id = $1
        ORDER BY r.created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [String(userId), Number(limit), Number(offset)],
    );

    return {
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      referrals: historyResult.rows.map(serializeReferralRow),
    };
  }

  /**
   * Get leaderboard — top referrers by total invitees.
   * @param {number} limit - number of top users to return
   */
  async function getLeaderboard(env, limit = 50) {
    await ensureSchema(env).catch(() => {});
    const result = await queryDb(
      env,
      `
        SELECT
          r.inviter_id,
          COUNT(*)::int AS total_invites,
          COUNT(*) FILTER (WHERE r.channel_verified = true)::int AS active_invites,
          COUNT(*) FILTER (WHERE r.rewarded = true)::int AS rewarded_invites,
          u.username, u.first_name
        FROM referrals r
        LEFT JOIN users u ON r.inviter_id = u.telegram_id
        WHERE r.status = 'active'
        GROUP BY r.inviter_id, u.username, u.first_name
        ORDER BY total_invites DESC
        LIMIT $1
      `,
      [Number(limit)],
    );

    return {
      leaderboard: result.rows.map((row, idx) => ({
        rank: idx + 1,
        user_id: row.inviter_id,
        username: row.username || null,
        first_name: row.first_name || null,
        total_invites: Number(row.total_invites || 0),
        active_invites: Number(row.active_invites || 0),
        rewarded_invites: Number(row.rewarded_invites || 0),
      })),
    };
  }

  /**
   * Flag a referral as suspicious (for anti-abuse).
   */

  return Object.freeze({
    ensureSchema,
    getStats,
    getHistory,
    getLeaderboard,
    getReferralLevelForCount,
  });
}

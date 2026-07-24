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
  const { queryDb, getReferralRewardPerInvite } = deps;

  let _schemaVerified = false;

  /**
   * Ensure referrals table has all required columns for future features.
   * Adds: status, metadata, updated_at, source, campaign_id.
   * Also creates indexes for leaderboard and history queries.
   */
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    const batchSql = `
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'active';
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'direct';
      ALTER TABLE referrals ADD COLUMN IF NOT EXISTS campaign_id VARCHAR(64);
      CREATE INDEX IF NOT EXISTS idx_referrals_inviter_created ON referrals (inviter_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_referrals_status ON referrals (status);
      CREATE INDEX IF NOT EXISTS idx_referrals_campaign ON referrals (campaign_id);
    `;
    try {
      await queryDb(env, batchSql);
    } catch (e) {
      console.warn('Referral schema migration warning:', e.message);
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
    const result = await queryDb(
      env,
      `
        SELECT
          COUNT(*)::int AS total,
          COUNT(*) FILTER (WHERE channel_verified = true)::int AS active,
          COUNT(*) FILTER (WHERE rewarded = true)::int AS rewarded,
          COUNT(*) FILTER (WHERE status = 'active')::int AS active_status,
          COUNT(*) FILTER (WHERE status = 'flagged')::int AS flagged,
          COUNT(*) FILTER (WHERE status = 'reversed')::int AS reversed
        FROM referrals
        WHERE inviter_id = $1
      `,
      [String(userId)],
    );
    const row = result.rows[0] || {};
    return {
      total: Number(row.total || 0),
      active: Number(row.active || 0),
      rewarded: Number(row.rewarded || 0),
      flagged: Number(row.flagged || 0),
      reversed: Number(row.reversed || 0),
      pending: Number(row.total || 0) - Number(row.rewarded || 0),
      reward_per_invite: await getReferralRewardPerInvite(env),
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
  async function flagReferral(env, referralId, reason) {
    await ensureSchema(env).catch(() => {});
    await queryDb(
      env,
      `UPDATE referrals SET status = 'flagged', updated_at = NOW(),
       metadata = metadata || $3::jsonb
       WHERE id = $1 AND status = 'active'`,
      [Number(referralId), null, JSON.stringify({ flag_reason: reason, flagged_at: new Date().toISOString() })],
    );
    return { success: true };
  }

  return Object.freeze({
    ensureSchema,
    getStats,
    getHistory,
    getLeaderboard,
    flagReferral,
  });
}

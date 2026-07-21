/**
 * Referral Repository — Data Access Layer
 *
 * Responsible ONLY for database read operations related to referrals.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createReferralRepository(deps) {
  const { queryDb, getReferralRewardPerInvite } = deps;

  /**
   * Serialize a raw token_transactions row into the API response shape.
   */
  function serializeTokenRow(row) {
    return {
      id: row.id,
      amount: Number(row.amount),
      type: row.tx_type,
      description: row.description,
      ref_id: row.ref_id,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
    };
  }

  /**
   * Get aggregated referral stats for a user:
   * total referrals, active (channel_verified), rewarded count, token balance.
   * Uses a SINGLE query with CTE to avoid multiple Pool creations (CPU limit).
   */
  async function getStats(env, userId) {
    const result = await queryDb(
      env,
      `
        WITH ref_stats AS (
          SELECT
            COUNT(*)::int AS total,
            COUNT(*) FILTER (WHERE channel_verified = true)::int AS active,
            COUNT(*) FILTER (WHERE rewarded = true)::int AS rewarded
          FROM referrals
          WHERE inviter_id = $1
        ),
        bal AS (
          SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1
        )
        SELECT r.total, r.active, r.rewarded, COALESCE(b.balance, 0) AS balance
        FROM ref_stats r, bal b
      `,
      [String(userId)],
    );
    const row = result.rows[0] || {};
    return {
      total: Number(row.total || 0),
      active: Number(row.active || 0),
      rewarded: Number(row.rewarded || 0),
      tokens: Number(row.balance || 0),
      reward_per_invite: getReferralRewardPerInvite(env),
    };
  }

  /**
   * Get token balance and recent transaction history for a user.
   * Uses a SINGLE query with CTE to avoid multiple Pool creations (CPU limit).
   */
  async function getTokens(env, userId) {
    const result = await queryDb(
      env,
      `
        WITH bal AS (
          SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1
        ),
        tx AS (
          SELECT id, amount, tx_type, description, ref_id, created_at
          FROM token_transactions
          WHERE user_id = $1
          ORDER BY created_at DESC
          LIMIT 50
        )
        SELECT
          COALESCE((SELECT balance FROM bal), 0) AS balance,
          COALESCE(json_agg(
            json_build_object(
              'id', tx.id, 'amount', tx.amount, 'tx_type', tx.tx_type,
              'description', tx.description, 'ref_id', tx.ref_id, 'created_at', tx.created_at
            )
          ) FILTER (WHERE tx.id IS NOT NULL), '[]') AS history
        FROM tx
      `,
      [String(userId)],
    );
    const row = result.rows[0] || {};
    let history = [];
    try {
      if (row.history && typeof row.history === 'string') {
        history = JSON.parse(row.history);
      } else if (Array.isArray(row.history)) {
        history = row.history;
      }
    } catch {}
    return {
      balance: Number(row.balance || 0),
      history: history.map((row) => serializeTokenRow(row)),
    };
  }

  return Object.freeze({ getStats, getTokens });
}
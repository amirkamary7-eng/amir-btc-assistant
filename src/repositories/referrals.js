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
   */
  async function getStats(env, userId) {
    const referralsResult = await queryDb(
      env,
      `
        SELECT channel_verified, rewarded
        FROM referrals
        WHERE inviter_id = $1
      `,
      [String(userId)],
    );
    const balanceResult = await queryDb(
      env,
      'SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1',
      [String(userId)],
    );
    const referrals = referralsResult.rows;
    return {
      total: referrals.length,
      active: referrals.filter((row) => Boolean(row.channel_verified)).length,
      rewarded: referrals.filter((row) => Boolean(row.rewarded)).length,
      tokens: Number(balanceResult.rows[0]?.balance || 0),
      reward_per_invite: getReferralRewardPerInvite(env),
    };
  }

  /**
   * Get token balance and recent transaction history for a user.
   */
  async function getTokens(env, userId) {
    const balanceResult = await queryDb(
      env,
      'SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1',
      [String(userId)],
    );
    const historyResult = await queryDb(
      env,
      `
        SELECT id, amount, tx_type, description, ref_id, created_at
        FROM token_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT 50
      `,
      [String(userId)],
    );
    return {
      balance: Number(balanceResult.rows[0]?.balance || 0),
      history: historyResult.rows.map((row) => serializeTokenRow(row)),
    };
  }

  return Object.freeze({ getStats, getTokens });
}
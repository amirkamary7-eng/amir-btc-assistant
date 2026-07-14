/**
 * Wallet Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to AB Token wallet.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createWalletRepository(deps) {
  const { queryDb } = deps;

  /**
   * Membership tier thresholds (AB tokens)
   */
  const TIERS = [
    { name: 'Bronze', min: 0, max: 999 },
    { name: 'Silver', min: 1000, max: 4999 },
    { name: 'Gold', min: 5000, max: 19999 },
    { name: 'Diamond', min: 20000, max: Infinity },
  ];

  /**
   * Get the user's current tier based on balance.
   */
  function getTierForBalance(balance) {
    for (let i = TIERS.length - 1; i >= 0; i--) {
      if (balance >= TIERS[i].min) {
        const current = TIERS[i];
        const next = TIERS[i + 1] || null;
        return {
          current: current.name,
          next: next ? next.name : null,
          progress: next ? Math.min(100, ((balance - current.min) / (next.min - current.min)) * 100) : 100,
          remaining: next ? Math.max(0, next.min - balance) : 0,
        };
      }
    }
    return { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };
  }

  /**
   * Serialize a token_transactions row.
   */
  function serializeTxRow(row) {
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
   * Get full wallet state: balance, tier info, and recent transactions.
   */
  async function getWalletState(env, userId) {
    const balanceResult = await queryDb(
      env,
      'SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1',
      [String(userId)],
    );
    const balance = Number(balanceResult.rows[0]?.balance || 0);
    const tierInfo = getTierForBalance(balance);

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
      balance,
      tier: tierInfo,
      history: historyResult.rows.map(serializeTxRow),
    };
  }

  /**
   * Get paginated transaction history.
   */
  async function getTransactionHistory(env, userId, offset = 0, limit = 20) {
    const countResult = await queryDb(
      env,
      'SELECT COUNT(*) as total FROM token_transactions WHERE user_id = $1',
      [String(userId)],
    );
    const total = Number(countResult.rows[0]?.total || 0);

    const historyResult = await queryDb(
      env,
      `
        SELECT id, amount, tx_type, description, ref_id, created_at
        FROM token_transactions
        WHERE user_id = $1
        ORDER BY created_at DESC
        LIMIT $2 OFFSET $3
      `,
      [String(userId), Number(limit), Number(offset)],
    );

    return {
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      transactions: historyResult.rows.map(serializeTxRow),
    };
  }

  /**
   * Check if user has already claimed daily reward today.
   */
  async function getDailyClaimStatus(env, userId) {
    const result = await queryDb(
      env,
      `
        SELECT id FROM token_transactions
        WHERE user_id = $1 AND tx_type = 'daily_claim'
        AND created_at >= CURRENT_DATE
        LIMIT 1
      `,
      [String(userId)],
    );
    return result.rows.length > 0;
  }

  /**
   * Claim daily reward: atomically check + insert in a single transaction.
   * Uses a conditional CTE to prevent double-claim without needing a UNIQUE constraint.
   */
  async function claimDailyReward(env, userId, amount) {
    const result = await queryDb(env, `
      WITH claim_check AS (
        SELECT 1 AS already_claimed
        FROM token_transactions
        WHERE user_id = $1 AND tx_type = 'daily_claim'
        AND created_at >= CURRENT_DATE
        LIMIT 1
      ),
      inserted AS (
        INSERT INTO token_balances (user_id, balance, updated_at)
        SELECT $1, $2, NOW()
        WHERE NOT EXISTS (SELECT 1 FROM claim_check)
        ON CONFLICT (user_id) DO UPDATE
        SET balance = token_balances.balance + EXCLUDED.balance, updated_at = NOW()
        RETURNING 1
      )
      INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id, created_at)
      SELECT $1, $2, 'daily_claim', 'Daily check-in reward', $3, NOW()
      WHERE NOT EXISTS (SELECT 1 FROM claim_check)
      RETURNING id
    `, [String(userId), Number(amount), `daily_${new Date().toISOString().slice(0, 10)}`]);

    // If no row returned, either already claimed or another issue
    if (!result.rows.length || !result.rows[0]?.id) {
      // Re-check if it was because already claimed
      const alreadyClaimed = await getDailyClaimStatus(env, userId);
      if (alreadyClaimed) {
        throw Object.assign(new Error('ALREADY_CLAIMED'), { code: 'ALREADY_CLAIMED' });
      }
      throw new Error('Failed to claim daily reward');
    }

    return { claimed: true, amount };
  }

  /**
   * Get referral stats for the wallet page (reuses referral data).
   */
  async function getReferralStats(env, userId) {
    const result = await queryDb(
      env,
      'SELECT channel_verified, rewarded FROM referrals WHERE inviter_id = $1',
      [String(userId)],
    );
    const referrals = result.rows;
    return {
      invited: referrals.length,
      active: referrals.filter(r => Boolean(r.channel_verified)).length,
      earned: referrals.filter(r => Boolean(r.rewarded)).length,
    };
  }

  return Object.freeze({
    getWalletState,
    getTransactionHistory,
    getDailyClaimStatus,
    claimDailyReward,
    getReferralStats,
  });
}
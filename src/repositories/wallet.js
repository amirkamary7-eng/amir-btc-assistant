/**
 * Wallet Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to AB Token wallet.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createWalletRepository(deps) {
  const { queryDb, queryDbTransaction } = deps;

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
    // Single query with CTE to avoid multiple Pool creations (CPU limit)
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
              'id', tx.id,
              'amount', tx.amount,
              'tx_type', tx.tx_type,
              'description', tx.description,
              'ref_id', tx.ref_id,
              'created_at', tx.created_at
            )
          ) FILTER (WHERE tx.id IS NOT NULL), '[]') AS history
        FROM tx
      `,
      [String(userId)],
    );
    const row = result.rows[0] || {};
    const balance = Number(row.balance || 0);
    const tierInfo = getTierForBalance(balance);
    let history = [];
    try {
      if (row.history && typeof row.history === 'string') {
        history = JSON.parse(row.history);
      } else if (Array.isArray(row.history)) {
        history = row.history;
      }
    } catch {}

    return {
      balance,
      tier: tierInfo,
      history: history.map(serializeTxRow),
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
   * Claim daily reward: fully atomic via advisory lock inside a single transaction.
   *
   * Uses pg_advisory_xact_lock(key) to serialize concurrent claims for the
   * *same user on the same day*. The lock key is derived from user_id + date
   * so different users or different days never block each other.
   *
   * The advisory lock is automatically released when the transaction ends
   * (COMMIT or ROLLBACK), so no manual cleanup is needed.
   *
   * All 4 steps run inside a single BEGIN...COMMIT via queryDbTransaction:
   *   1. Acquire advisory lock (blocks if another claim for same user+date is in progress)
   *   2. Check if already claimed today
   *   3. UPSERT balance (conditional: only if not already claimed)
   *   4. INSERT transaction record (conditional: only if not already claimed, RETURNING id)
   *
   * Steps 3 and 4 use WHERE NOT EXISTS as a safety net, even though the advisory
   * lock guarantees no concurrent modification can occur between steps.
   */
  async function claimDailyReward(env, userId, amount) {
    if (!queryDbTransaction) {
      throw new Error('queryDbTransaction not available');
    }

    const uid = String(userId);
    const refId = `daily_${new Date().toISOString().slice(0, 10)}`;

    // Compute a stable 64-bit advisory lock key from user_id + today's date.
    // md5 produces a 32-char hex string; we take the first 16 chars as a bigint.
    const lockKeyResult = await queryDb(env,
      `SELECT (('x' || SUBSTRING(MD5($1 || CURRENT_DATE::text), 1, 16))::bit(64)::bigint) AS lock_key`,
      [uid],
    );
    const lockKey = lockKeyResult.rows[0]?.lock_key;
    if (lockKey == null) {
      throw new Error('Failed to compute advisory lock key');
    }

    // Single transaction: lock -> check -> upsert balance -> insert tx record
    const results = await queryDbTransaction(env, [
      // Step 1: Acquire per-user, per-day advisory lock
      {
        sql: `SELECT pg_advisory_xact_lock($1)`,
        params: [lockKey],
      },
      // Step 2: Check if already claimed today
      {
        sql: `SELECT id FROM token_transactions
              WHERE user_id = $1 AND tx_type = 'daily_claim'
              AND created_at >= CURRENT_DATE
              LIMIT 1`,
        params: [uid],
      },
      // Step 3: UPSERT balance — conditional on not already claimed
      {
        sql: `INSERT INTO token_balances (user_id, balance, updated_at)
              SELECT $1, $2, NOW()
              WHERE NOT EXISTS (
                SELECT 1 FROM token_transactions
                WHERE user_id = $1 AND tx_type = 'daily_claim'
                AND created_at >= CURRENT_DATE
              )
              ON CONFLICT (user_id) DO UPDATE
              SET balance = token_balances.balance + EXCLUDED.balance, updated_at = NOW()`,
        params: [uid, Number(amount)],
      },
      // Step 4: INSERT transaction record — conditional, returns id on success
      {
        sql: `INSERT INTO token_transactions (user_id, amount, tx_type, description, ref_id, created_at)
              SELECT $1, $2, 'daily_claim', 'Daily check-in reward', $3, NOW()
              WHERE NOT EXISTS (
                SELECT 1 FROM token_transactions
                WHERE user_id = $1 AND tx_type = 'daily_claim'
                AND created_at >= CURRENT_DATE
              )
              RETURNING id`,
        params: [uid, Number(amount), refId],
      },
    ]);

    // Step 2 result: if rows exist, already claimed before this transaction
    if (results[1].rows.length > 0) {
      throw Object.assign(new Error('ALREADY_CLAIMED'), { code: 'ALREADY_CLAIMED' });
    }

    // Step 4 result: if RETURNING returned rows, insert succeeded
    if (!results[3].rows.length || !results[3].rows[0]?.id) {
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
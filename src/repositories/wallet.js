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

  let _schemaVerified = false;

  /**
   * Ensure wallet tables have all required columns. Idempotent — safe to call
   * on every cold start. Adds: status, source, metadata, updated_at to
   * token_transactions; created_at to token_balances. Also creates indexes.
   */
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    const batchSql = `
      ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'completed';
      ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS source VARCHAR(32) NOT NULL DEFAULT 'system';
      ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}';
      ALTER TABLE token_transactions ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      ALTER TABLE token_balances ADD COLUMN IF NOT EXISTS created_at TIMESTAMPTZ NOT NULL DEFAULT NOW();
      CREATE INDEX IF NOT EXISTS idx_token_tx_user_created ON token_transactions (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_token_tx_type ON token_transactions (user_id, tx_type);
      CREATE INDEX IF NOT EXISTS idx_token_tx_status ON token_transactions (user_id, status);
    `;
    try {
      await queryDb(env, batchSql);
    } catch (e) {
      console.warn('Wallet schema migration warning:', e.message);
    }
    _schemaVerified = true;
  }

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
   * Serialize a token_transactions row with ALL fields.
   */
  function serializeTxRow(row) {
    let metadata = {};
    try {
      if (row.metadata) {
        metadata = typeof row.metadata === 'string' ? JSON.parse(row.metadata) : row.metadata;
      }
    } catch {}
    return {
      id: row.id,
      amount: Number(row.amount),
      type: row.tx_type,
      source: row.source || 'system',
      status: row.status || 'completed',
      description: row.description,
      ref_id: row.ref_id,
      metadata,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
    };
  }

  /**
   * Get full wallet state: balance, tier info, and recent transactions.
   */
  async function getWalletState(env, userId) {
    await ensureSchema(env).catch(() => {});
    // Single query with CTE to avoid multiple Pool creations (CPU limit)
    const result = await queryDb(
      env,
      `
        WITH bal AS (
          SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1
        ),
        tx AS (
          SELECT id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at
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
              'source', tx.source,
              'status', tx.status,
              'description', tx.description,
              'ref_id', tx.ref_id,
              'metadata', tx.metadata,
              'created_at', tx.created_at,
              'updated_at', tx.updated_at
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
   * Get paginated transaction history with optional filtering.
   * @param {string} userId
   * @param {number} offset
   * @param {number} limit
   * @param {object} filters - { type: string|null, status: string|null }
   */
  async function getTransactionHistory(env, userId, offset = 0, limit = 20, filters = {}) {
    await ensureSchema(env).catch(() => {});
    const params = [String(userId)];
    let whereClause = 'WHERE user_id = $1';
    let paramIdx = 2;

    if (filters.type) {
      whereClause += ` AND tx_type = $${paramIdx++}`;
      params.push(filters.type);
    }
    if (filters.status) {
      whereClause += ` AND status = $${paramIdx++}`;
      params.push(filters.status);
    }

    const countResult = await queryDb(
      env,
      `SELECT COUNT(*) as total FROM token_transactions ${whereClause}`,
      params,
    );
    const total = Number(countResult.rows[0]?.total || 0);

    params.push(Number(limit), Number(offset));
    const historyResult = await queryDb(
      env,
      `
        SELECT id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at
        FROM token_transactions
        ${whereClause}
        ORDER BY created_at DESC
        LIMIT $${paramIdx++} OFFSET $${paramIdx++}
      `,
      params,
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

  /**
   * CENTRAL TOKEN SERVICE — creditTokens
   * ALL balance increases in the app MUST go through this function.
   * This ensures: atomic balance update + transaction record in a single DB transaction.
   *
   * Future features (referral, mission, daily reward, airdrop, marketplace) call this.
   *
   * @param {object} env
   * @param {string} userId - Telegram user ID
   * @param {number} amount - positive number
   * @param {string} txType - 'referral_reward' | 'daily_claim' | 'mission_reward' | 'airdrop' | 'purchase' | 'admin_credit'
   * @param {string} description - human-readable description
   * @param {string} refId - optional reference ID (e.g. referral ID, mission ID)
   * @returns {Promise<{success: boolean, newBalance: number, txId: string}>}
   */
  async function creditTokens(env, userId, amount, txType, description, refId, metadata = {}) {
    if (!queryDbTransaction) throw new Error('queryDbTransaction not available');
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);
    const amt = Math.abs(Number(amount)); // always positive
    if (amt <= 0) throw new Error('Amount must be positive');

    // source is derived from txType for standardization
    const source = txType.split('_')[0]; // 'referral_reward' → 'referral'
    const metadataJson = JSON.stringify(metadata);

    const results = await queryDbTransaction(env, [
      {
        sql: `INSERT INTO token_balances (user_id, balance, updated_at)
              VALUES ($1, $2, NOW())
              ON CONFLICT (user_id) DO UPDATE
              SET balance = token_balances.balance + EXCLUDED.balance, updated_at = NOW()
              RETURNING balance`,
        params: [uid, amt],
      },
      {
        sql: `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at)
              VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, NOW(), NOW())
              RETURNING id`,
        params: [uid, amt, txType, source, description || txType, refId || null, metadataJson],
      },
    ]);

    const newBalance = Number(results[0].rows[0]?.balance || 0);
    const txId = results[1].rows[0]?.id;
    if (!txId) throw new Error('Failed to record transaction');

    return { success: true, newBalance, txId };
  }

  /**
   * CENTRAL TOKEN SERVICE — debitTokens
   * ALL balance decreases in the app MUST go through this function.
   * Checks for sufficient balance before debiting.
   *
   * @returns {Promise<{success: boolean, newBalance: number, txId: string}>}
   * @throws Error if insufficient balance
   */
  async function debitTokens(env, userId, amount, txType, description, refId, metadata = {}) {
    if (!queryDbTransaction) throw new Error('queryDbTransaction not available');
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);
    const amt = Math.abs(Number(amount)); // always positive
    if (amt <= 0) throw new Error('Amount must be positive');

    const source = txType.split('_')[0];
    const metadataJson = JSON.stringify(metadata);

    const results = await queryDbTransaction(env, [
      {
        sql: `UPDATE token_balances
              SET balance = balance - $2, updated_at = NOW()
              WHERE user_id = $1 AND balance >= $2
              RETURNING balance`,
        params: [uid, amt],
      },
      {
        sql: `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at)
              SELECT $1, -$2, $3, $4, 'completed', $5, $6, $7, NOW(), NOW()
              WHERE EXISTS (SELECT 1 FROM token_balances WHERE user_id = $1 AND balance >= 0)
              RETURNING id`,
        params: [uid, amt, txType, source, description || txType, refId || null, metadataJson],
      },
    ]);

    if (!results[0].rows.length) {
      throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE' });
    }
    const newBalance = Number(results[0].rows[0]?.balance || 0);
    const txId = results[1].rows[0]?.id;
    if (!txId) throw new Error('Failed to record transaction');

    return { success: true, newBalance, txId };
  }

  /**
   * Get a single transaction by ID.
   */
  async function getTransactionById(env, userId, txId) {
    await ensureSchema(env).catch(() => {});
    const result = await queryDb(
      env,
      `SELECT id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at
       FROM token_transactions WHERE id = $1 AND user_id = $2 LIMIT 1`,
      [Number(txId), String(userId)],
    );
    return result.rows[0] ? serializeTxRow(result.rows[0]) : null;
  }

  /**
   * Reverse a completed transaction (mark as reversed + reverse the balance change).
   * Only completed transactions can be reversed. The reversal is atomic.
   */
  async function reverseTransaction(env, userId, txId, reason) {
    if (!queryDbTransaction) throw new Error('queryDbTransaction not available');
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);
    const tid = Number(txId);

    const results = await queryDbTransaction(env, [
      // Get the original transaction (must be completed)
      {
        sql: `SELECT amount, tx_type, status FROM token_transactions
              WHERE id = $1 AND user_id = $2 AND status = 'completed' FOR UPDATE`,
        params: [tid, uid],
      },
      // Reverse the balance (subtract if original was credit, add if debit)
      {
        sql: `UPDATE token_balances
              SET balance = balance - (SELECT amount FROM token_transactions WHERE id = $1),
                  updated_at = NOW()
              WHERE user_id = $2
              RETURNING balance`,
        params: [tid, uid],
      },
      // Mark original as reversed
      {
        sql: `UPDATE token_transactions SET status = 'reversed', updated_at = NOW(),
              metadata = metadata || $3::jsonb
              WHERE id = $1 AND user_id = $2 AND status = 'completed'
              RETURNING id`,
        params: [tid, uid, JSON.stringify({ reversed_reason: reason || 'admin_reversal', reversed_at: new Date().toISOString() })],
      },
    ]);

    if (!results[0].rows.length) {
      throw new Error('Transaction not found or not reversible');
    }
    const newBalance = Number(results[1].rows[0]?.balance || 0);
    return { success: true, newBalance, txId: tid };
  }

  return Object.freeze({
    ensureSchema,
    getWalletState,
    getTransactionHistory,
    getTransactionById,
    getDailyClaimStatus,
    claimDailyReward,
    getReferralStats,
    creditTokens,
    debitTokens,
    reverseTransaction,
    getTierForBalance,
  });
}
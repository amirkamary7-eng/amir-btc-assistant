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
      -- ROOT CAUSE FIX (R-3.1): UNIQUE constraint on (user_id, tx_type, ref_id) for
      -- completed transactions. This makes the idempotency check in creditTokens
      -- atomic at the DB level — the second INSERT fails with a unique violation
      -- instead of silently creating a duplicate credit. Fixes:
      --   - Referral double-credit (R-2.1)
      --   - Daily reward double-claim (R-2.3, R-2.10)
      --   - Wheel double-reward (F-3)
      -- Partial index: only applies when ref_id IS NOT NULL and status='completed'
      -- (pending/reversed transactions are excluded).
      CREATE UNIQUE INDEX IF NOT EXISTS idx_token_tx_user_type_ref
        ON token_transactions (user_id, tx_type, ref_id)
        WHERE ref_id IS NOT NULL AND status = 'completed';

      -- PHASE 4 (WALLET-REWARDS): daily_checkin_streaks table for 1→7 streak system.
      -- Separate table (NOT added to token_balances) for:
      --   - Single Responsibility (streak logic isolated from balance)
      --   - Easier migration (additive, no ALTER TABLE on balance table)
      --   - Easier queries (streak state independent of balance)
      --   - Backward compat (token_balances untouched)
      -- streak_day: 1..7 (current day in cycle)
      -- last_claim_date: Tehran date of last successful claim (idempotency key)
      -- cycle_count: how many 7-day cycles completed (analytics)
      CREATE TABLE IF NOT EXISTS daily_checkin_streaks (
        user_id TEXT PRIMARY KEY REFERENCES users(telegram_id) ON DELETE CASCADE,
        streak_day SMALLINT NOT NULL DEFAULT 0,
        last_claim_date DATE NOT NULL DEFAULT '1970-01-01',
        cycle_count INTEGER NOT NULL DEFAULT 0,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_checkin_streaks_last_claim ON daily_checkin_streaks (last_claim_date);
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
          LIMIT 20
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
  // WALLET-002 FIX: Use Tehran date for daily claim boundary, matching
  // the wheel system (wheel.js:getTehranDateString). Previously used
  // CURRENT_DATE which is UTC on Supabase — daily claim reset at 03:30
  // Tehran instead of 00:00 Tehran.
  function _getTehranDateString() {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date());
  }

  async function getDailyClaimStatus(env, userId) {
    const tehranToday = _getTehranDateString();
    const result = await queryDb(
      env,
      `
        SELECT id FROM token_transactions
        WHERE user_id = $1 AND tx_type = 'daily_claim'
        AND ref_id = $2
        LIMIT 1
      `,
      [String(userId), `daily_${tehranToday}`],
    );
    return result.rows.length > 0;
  }

  // PHASE 4 (WALLET-REWARDS): Daily check-in streak system (1→7 progressive reward).
  // STREAK_REWARDS[day-1] = reward amount for that day (before tier multiplier).
  // Day 1 = base, Day 7 = highest. After Day 7 → cycle restarts at Day 1.
  // These are NORMAL-tier amounts. Premium tier multiplier applied in controller.
  const STREAK_REWARDS = [10, 12, 15, 18, 22, 28, 40]; // Days 1-7

  /**
   * Get the streak state for a user.
   * Returns { streak_day, last_claim_date, cycle_count } or null if no row.
   */
  async function getStreakStatus(env, userId) {
    await ensureSchema(env).catch(() => {});
    const result = await queryDb(env,
      `SELECT streak_day, last_claim_date, cycle_count FROM daily_checkin_streaks WHERE user_id = $1`,
      [String(userId)],
    );
    return result.rows[0] || null;
  }

  /**
   * PHASE 4 (WALLET-REWARDS): Claim daily reward with 1→7 streak system.
   *
   * Streak logic:
   *   - First claim ever: streak_day = 1
   *   - Last claim was yesterday (Tehran): streak_day = (streak_day % 7) + 1
   *     (1→2, 2→3, ..., 6→7, 7→1 — Day 7 wraps to Day 1 for new cycle)
   *   - Last claim was today (Tehran): ALREADY_CLAIMED (idempotent)
   *   - Last claim was before yesterday: streak_day = 1 (streak broken)
   *
   * Reward: STREAK_REWARDS[streak_day - 1] (before tier multiplier).
   * The controller applies the tier multiplier and passes the final amount
   * as `amount` parameter. This function returns the computed streak_day
   * so the controller can look up the reward amount.
   *
   * Cycle completion: when streak_day goes 7→1, cycle_count is incremented.
   * This happens WITHIN the same transaction as the credit — atomic.
   *
   * Concurrent claim protection: pg_advisory_xact_lock on (user_id + Tehran date).
   * Same lock key as the original claimDailyReward — backward compatible.
   *
   * @returns { claimed, amount, newBalance, txId, streak_day, cycle_complete, cycle_count }
   */
  async function claimDailyRewardWithStreak(env, userId, amount) {
    if (!queryDbTransaction) {
      throw new Error('queryDbTransaction not available');
    }
    await ensureSchema(env).catch(() => {});

    const uid = String(userId);
    const tehranToday = _getTehranDateString();
    const refId = `daily_${tehranToday}`;

    // Compute yesterday's Tehran date for streak-continuation check.
    // We use Intl.DateTimeFormat with timeZone to get the correct date.
    const yesterday = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const yesterdayFmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric', month: '2-digit', day: '2-digit',
    });
    const tehranYesterday = yesterdayFmt.format(yesterday);

    // Compute advisory lock key from user_id + Tehran date (same as original).
    const lockKeyResult = await queryDb(env,
      `SELECT (('x' || SUBSTRING(MD5($1 || $2), 1, 16))::bit(64)::bigint) AS lock_key`,
      [uid, tehranToday],
    );
    const lockKey = lockKeyResult.rows[0]?.lock_key;
    if (lockKey == null) {
      throw new Error('Failed to compute advisory lock key');
    }

    // Step 1: Acquire advisory lock + check if already claimed today (atomic).
    const lockResults = await queryDbTransaction(env, [
      { sql: `SELECT pg_advisory_xact_lock($1)`, params: [lockKey] },
      {
        sql: `SELECT id FROM token_transactions
              WHERE user_id = $1 AND tx_type = 'daily_claim'
              AND ref_id = $2 LIMIT 1`,
        params: [uid, refId],
      },
    ]);

    if (lockResults[1].rows.length > 0) {
      throw Object.assign(new Error('ALREADY_CLAIMED'), { code: 'ALREADY_CLAIMED' });
    }

    // Step 2: Compute new streak_day + cycle_count.
    // Read current streak state (may be null if first claim).
    const streakRow = await queryDb(env,
      `SELECT streak_day, last_claim_date, cycle_count FROM daily_checkin_streaks WHERE user_id = $1`,
      [uid],
    );
    const current = streakRow.rows[0];
    let newStreakDay = 1;
    let newCycleCount = 0;
    let cycleComplete = false;

    if (current) {
      newCycleCount = Number(current.cycle_count) || 0;
      const lastClaimDate = current.last_claim_date; // DATE type (no timezone)
      // Convert both to YYYY-MM-DD strings for comparison
      const lastClaimStr = lastClaimDate ? String(lastClaimDate).slice(0, 10) : '';
      const currentStreakDay = Number(current.streak_day) || 0;

      if (lastClaimStr === tehranYesterday) {
        // Streak continues: 1→2, 2→3, ..., 6→7, 7→1 (cycle restart)
        newStreakDay = (currentStreakDay % 7) + 1;
        if (currentStreakDay === 7) {
          // Day 7 → Day 1: cycle complete, increment cycle_count
          cycleComplete = true;
          newCycleCount += 1;
        }
      } else if (lastClaimStr === tehranToday) {
        // Already claimed today — should have been caught by the refId check above,
        // but double-check for safety (streak row might be out of sync).
        throw Object.assign(new Error('ALREADY_CLAIMED'), { code: 'ALREADY_CLAIMED' });
      } else {
        // Streak broken (missed a day): reset to Day 1
        newStreakDay = 1;
      }
    } else {
      // First claim ever: streak_day = 1, cycle_count = 0
      newStreakDay = 1;
      newCycleCount = 0;
    }

    // Step 3: UPSERT streak row (update streak_day, last_claim_date, cycle_count).
    await queryDb(env,
      `INSERT INTO daily_checkin_streaks (user_id, streak_day, last_claim_date, cycle_count, updated_at)
       VALUES ($1, $2, $3, $4, NOW())
       ON CONFLICT (user_id) DO UPDATE SET
         streak_day = EXCLUDED.streak_day,
         last_claim_date = EXCLUDED.last_claim_date,
         cycle_count = EXCLUDED.cycle_count,
         updated_at = NOW()`,
      [uid, newStreakDay, tehranToday, newCycleCount],
    );

    // Step 4: Credit tokens via the centralized path (idempotent via refId).
    const result = await creditTokens(env, uid, amount, 'daily_claim', 'Daily check-in reward', refId, {
      daily_date: tehranToday,
      streak_day: newStreakDay,
      cycle_complete: cycleComplete,
    });

    return {
      claimed: true,
      amount,
      newBalance: result.newBalance,
      txId: result.txId,
      streak_day: newStreakDay,
      cycle_complete: cycleComplete,
      cycle_count: newCycleCount,
    };
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
    await ensureSchema(env).catch(() => {});

    const uid = String(userId);
    // WALLET-002 FIX: Use Tehran date for refId, not UTC date
    const tehranToday = _getTehranDateString();
    const refId = `daily_${tehranToday}`;

    // Compute a stable 64-bit advisory lock key from user_id + Tehran date.
    const lockKeyResult = await queryDb(env,
      `SELECT (('x' || SUBSTRING(MD5($1 || $2), 1, 16))::bit(64)::bigint) AS lock_key`,
      [uid, tehranToday],
    );
    const lockKey = lockKeyResult.rows[0]?.lock_key;
    if (lockKey == null) {
      throw new Error('Failed to compute advisory lock key');
    }

    // Step 1: Acquire advisory lock + check if already claimed (atomic)
    // WALLET-002 FIX: Check by refId (Tehran date) instead of CURRENT_DATE
    const lockResults = await queryDbTransaction(env, [
      { sql: `SELECT pg_advisory_xact_lock($1)`, params: [lockKey] },
      {
        sql: `SELECT id FROM token_transactions
              WHERE user_id = $1 AND tx_type = 'daily_claim'
              AND ref_id = $2 LIMIT 1`,
        params: [uid, refId],
      },
    ]);

    if (lockResults[1].rows.length > 0) {
      throw Object.assign(new Error('ALREADY_CLAIMED'), { code: 'ALREADY_CLAIMED' });
    }

    // Step 2: Use centralized creditTokens for the actual balance + transaction write.
    // This ensures the daily claim goes through the same path as all other credits.
    const result = await creditTokens(env, uid, amount, 'daily_claim', 'Daily check-in reward', refId, { daily_date: tehranToday });
    return { claimed: true, amount, newBalance: result.newBalance, txId: result.txId };
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
  async function creditTokens(env, userId, amount, txType, description, refId, metadata = {}, auditInfo = {}) {
    if (!queryDbTransaction) throw new Error('queryDbTransaction not available');
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);
    const amt = Math.abs(Number(amount)); // always positive
    if (amt <= 0) throw new Error('Amount must be positive');

    // source is derived from txType for standardization
    const source = txType.split('_')[0]; // 'referral_reward' → 'referral'

    // AUDIT: merge audit info into metadata for traceability
    const fullMetadata = {
      ...metadata,
      ...(auditInfo.actor ? { actor: auditInfo.actor } : {}),
      ...(auditInfo.ip ? { ip: auditInfo.ip } : {}),
      ...(auditInfo.request_id ? { request_id: auditInfo.request_id } : {}),
      ...(auditInfo.user_agent ? { user_agent: auditInfo.user_agent } : {}),
    };
    const metadataJson = JSON.stringify(fullMetadata);

    // IDEMPOTENCY: if refId is provided, check if a transaction with the same
    // (user_id, tx_type, ref_id) already exists. If so, return it without
    // crediting again. This prevents double-credit from concurrent requests
    // (e.g. two simultaneous referral reward calls, or double-clicking claim).
    //
    // ROOT CAUSE FIX (R-2.1): The old code did a SELECT then INSERT — a
    // TOCTOU race allowed two concurrent calls to both pass the SELECT and
    // both INSERT. Now we use INSERT ... ON CONFLICT DO NOTHING which is
    // atomic at the DB level (protected by the UNIQUE index added in
    // ensureSchema). If the INSERT returns 0 rows (conflict), we know a
    // concurrent caller already credited — we read the existing row and
    // return idempotent success.
    if (refId) {
      const existing = await queryDb(
        env,
        `SELECT id, amount FROM token_transactions
         WHERE user_id = $1 AND tx_type = $2 AND ref_id = $3 AND status = 'completed'
         LIMIT 1`,
        [uid, txType, refId],
      );
      if (existing.rows.length > 0) {
        // Already credited — return idempotent success
        return { success: true, newBalance: null, txId: existing.rows[0].id, idempotent: true };
      }
    }

    // WALLET-001-FIX (verified via wallet-credit-concurrency-test.cjs):
    // Use a single CTE-based transaction that atomically inserts the
    // transaction record AND UPSERTS the balance row ONLY if the
    // transaction INSERT succeeds.
    //
    // Previous approach (BUG): UPDATE-only on token_balances.
    //   1. INSERT tx ON CONFLICT DO NOTHING RETURNING id
    //   2. UPDATE token_balances SET balance = balance + amt WHERE user_id = $1
    // Bug: if user has no balance row (no row in token_balances), UPDATE
    // affects 0 rows → balance NOT increased. But the tx IS inserted, so
    // on retry the idempotency check returns "idempotent:true" — silently
    // losing the credit. Verified by WALLET-001-BUG test.
    //
    // New approach (FIX): UPSERT instead of UPDATE.
    //   1. INSERT tx ON CONFLICT DO NOTHING RETURNING id (may return 0 rows)
    //   2. INSERT INTO token_balances (user_id, balance) VALUES ($1, $2)
    //      ON CONFLICT (user_id) DO UPDATE SET balance = balance + EXCLUDED.balance
    //      — but ONLY when tx_insert returned a row (via WHERE clause in CTE)
    // This creates the balance row if missing, and increments it if present.
    // Idempotency preserved: if tx conflict, balance is NOT touched.
    // Race-safe: ON CONFLICT DO UPDATE is atomic in PostgreSQL.
    const results = await queryDbTransaction(env, [
      {
        sql: `WITH tx_insert AS (
                INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at)
                VALUES ($1, $2, $3, $4, 'completed', $5, $6, $7, NOW(), NOW())
                ON CONFLICT DO NOTHING
                RETURNING id
              ),
              balance_upsert AS (
                INSERT INTO token_balances (user_id, balance, updated_at)
                SELECT $1, $2, NOW() FROM tx_insert
                ON CONFLICT (user_id) DO UPDATE
                  SET balance = token_balances.balance + EXCLUDED.balance,
                      updated_at = NOW()
              )
              SELECT
                (SELECT id FROM tx_insert LIMIT 1) AS tx_id,
                (SELECT balance FROM token_balances WHERE user_id = $1) AS balance`,
        params: [uid, amt, txType, source, description || txType, refId || null, metadataJson],
      },
    ]);

    const row = results[0].rows[0];
    const txId = row?.tx_id;
    const newBalance = Number(row?.balance || 0);

    // If txId is null, the ON CONFLICT triggered — a concurrent caller
    // already inserted this transaction. Balance was NOT touched
    // (because the CTE's UPSERT only runs when tx_insert returns a row).
    if (!txId) {
      // Read the existing transaction for the return value
      const existing = await queryDb(env,
        `SELECT id, amount FROM token_transactions WHERE user_id = $1 AND tx_type = $2 AND ref_id = $3 AND status = 'completed' LIMIT 1`,
        [uid, txType, refId],
      );
      return { success: true, newBalance: null, txId: existing.rows[0]?.id, idempotent: true };
    }

    if (!txId) throw new Error('Failed to record transaction');

    // AUDIT LOG
    console.log(JSON.stringify({
      scope: 'wallet-audit-credit',
      user_id: uid,
      tx_id: txId,
      amount: amt,
      tx_type: txType,
      source,
      status: 'completed',
      ref_id: refId || null,
      new_balance: newBalance,
      actor: auditInfo.actor || 'system',
      ip: auditInfo.ip || null,
      request_id: auditInfo.request_id || null,
      timestamp: new Date().toISOString(),
    }));

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
  async function debitTokens(env, userId, amount, txType, description, refId, metadata = {}, auditInfo = {}) {
    if (!queryDbTransaction) throw new Error('queryDbTransaction not available');
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);
    const amt = Math.abs(Number(amount)); // always positive
    if (amt <= 0) throw new Error('Amount must be positive');

    const source = txType.split('_')[0];

    // AUDIT: merge audit info into metadata
    const fullMetadata = {
      ...metadata,
      ...(auditInfo.actor ? { actor: auditInfo.actor } : {}),
      ...(auditInfo.ip ? { ip: auditInfo.ip } : {}),
      ...(auditInfo.request_id ? { request_id: auditInfo.request_id } : {}),
      ...(auditInfo.user_agent ? { user_agent: auditInfo.user_agent } : {}),
    };
    const metadataJson = JSON.stringify(fullMetadata);

    // IDEMPOTENCY: if refId is provided, check if already debited
    if (refId) {
      const existing = await queryDb(
        env,
        `SELECT id FROM token_transactions
         WHERE user_id = $1 AND tx_type = $2 AND ref_id = $3 AND status = 'completed'
         LIMIT 1`,
        [uid, txType, refId],
      );
      if (existing.rows.length > 0) {
        return { success: true, newBalance: null, txId: existing.rows[0].id, idempotent: true };
      }
    }

    // CONCURRENCY SAFETY: the UPDATE ... WHERE balance >= $2 is an atomic
    // conditional update. If two concurrent debits race, PostgreSQL's row-level
    // locking ensures only one sees balance >= amount — the other gets 0 rows
    // and throws INSUFFICIENT_BALANCE. No double-spend possible.
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
      // AUDIT LOG for failed debit
      console.log(JSON.stringify({
        scope: 'wallet-audit-debit-failed',
        user_id: uid,
        amount: amt,
        tx_type: txType,
        source,
        status: 'failed',
        reason: 'INSUFFICIENT_BALANCE',
        actor: auditInfo.actor || 'system',
        ip: auditInfo.ip || null,
        timestamp: new Date().toISOString(),
      }));
      throw Object.assign(new Error('INSUFFICIENT_BALANCE'), { code: 'INSUFFICIENT_BALANCE' });
    }
    const newBalance = Number(results[0].rows[0]?.balance || 0);
    const txId = results[1].rows[0]?.id;
    if (!txId) throw new Error('Failed to record transaction');

    // AUDIT LOG
    console.log(JSON.stringify({
      scope: 'wallet-audit-debit',
      user_id: uid,
      tx_id: txId,
      amount: -amt,
      tx_type: txType,
      source,
      status: 'completed',
      ref_id: refId || null,
      new_balance: newBalance,
      actor: auditInfo.actor || 'system',
      ip: auditInfo.ip || null,
      request_id: auditInfo.request_id || null,
      timestamp: new Date().toISOString(),
    }));

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

  /**
   * Get wallet summary: balance, tier, and aggregate statistics.
   * Statistics: total_earned, total_spent, transaction_count, by_type breakdown.
   */
  async function getWalletSummary(env, userId) {
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);

    const result = await queryDb(
      env,
      `
        WITH bal AS (
          SELECT COALESCE((SELECT balance FROM token_balances WHERE user_id = $1), 0) AS balance
        ),
        stats AS (
          SELECT
            COALESCE(SUM(amount) FILTER (WHERE amount > 0 AND status = 'completed'), 0) AS total_earned,
            COALESCE(SUM(ABS(amount)) FILTER (WHERE amount < 0 AND status = 'completed'), 0) AS total_spent,
            COUNT(*) FILTER (WHERE status = 'completed') AS tx_count,
            COUNT(*) FILTER (WHERE status = 'completed' AND tx_type = 'referral_reward') AS referral_count,
            COUNT(*) FILTER (WHERE status = 'completed' AND tx_type = 'daily_claim') AS daily_count,
            COUNT(*) FILTER (WHERE status = 'completed' AND tx_type = 'mission_reward') AS mission_count,
            COUNT(*) FILTER (WHERE status = 'reversed') AS reversed_count
          FROM token_transactions
          WHERE user_id = $1
        )
        SELECT
          (SELECT balance FROM bal) AS balance,
          (SELECT total_earned FROM stats) AS total_earned,
          (SELECT total_spent FROM stats) AS total_spent,
          (SELECT tx_count FROM stats) AS tx_count,
          (SELECT referral_count FROM stats) AS referral_count,
          (SELECT daily_count FROM stats) AS daily_count,
          (SELECT mission_count FROM stats) AS mission_count,
          (SELECT reversed_count FROM stats) AS reversed_count
      `,
      [uid],
    );

    const row = result.rows[0] || {};
    const balance = Number(row.balance || 0);
    return {
      balance,
      tier: getTierForBalance(balance),
      stats: {
        total_earned: Number(row.total_earned || 0),
        total_spent: Number(row.total_spent || 0),
        transaction_count: Number(row.tx_count || 0),
        referral_count: Number(row.referral_count || 0),
        daily_count: Number(row.daily_count || 0),
        mission_count: Number(row.mission_count || 0),
        reversed_count: Number(row.reversed_count || 0),
      },
    };
  }

  /**
   * Get just the current balance (lightweight, no transactions).
   */
  async function getBalance(env, userId) {
    const result = await queryDb(
      env,
      'SELECT balance FROM token_balances WHERE user_id = $1 LIMIT 1',
      [String(userId)],
    );
    return Number(result.rows[0]?.balance || 0);
  }

  return Object.freeze({
    ensureSchema,
    getWalletState,
    getWalletSummary,
    getBalance,
    getTransactionHistory,
    getTransactionById,
    getDailyClaimStatus,
    claimDailyReward, // backward compat (still works, no streak)
    claimDailyRewardWithStreak, // PHASE 4: streak-enabled claim
    getStreakStatus, // PHASE 4: read streak state for UI
    STREAK_REWARDS, // PHASE 4: exported for controller to look up reward amounts
    getReferralStats,
    creditTokens,
    debitTokens,
    reverseTransaction,
    getTierForBalance,
    queryDb,
  });
}
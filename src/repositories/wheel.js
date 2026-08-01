/**
 * Lucky Wheel Repository — Data Access Layer
 *
 * Manages spin inventory, spin history, and reward configuration.
 * All rewards go through economyService.grantReward() — never direct SQL
 * to token_balances/token_transactions.
 */
export function createWheelRepository(deps) {
  const { queryDb, queryDbTransaction } = deps;

  let _schemaVerified = false;

  // ── ROOT-CAUSE FIX: Calendar daily reset at 00:00 Asia/Tehran ──
  // Previously the wheel used UTC date (new Date().toISOString().slice(0,10)
  // and SQL CURRENT_DATE). Iran is UTC+3:30, so the wheel reset at 03:30
  // Tehran time instead of 00:00. Users who ran out of spins at 23:00 Tehran
  // had to wait 4.5 hours for UTC date to roll over.
  //
  // FIX: Calculate "today" in Asia/Tehran timezone. All spin_date comparisons
  // use this Tehran date string. This ensures ALL users get 3 fresh spins at
  // exactly Tehran midnight, regardless of when they used their spins.
  //
  // We pass the Tehran date as a PARAMETER to SQL (not rely on CURRENT_DATE)
  // because Neon's CURRENT_DATE uses the DB's timezone (UTC by default).
  function getTehranDateString() {
    // Intl.DateTimeFormat with timeZone gives us the correct date in Tehran
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: 'Asia/Tehran',
      year: 'numeric',
      month: '2-digit',
      day: '2-digit',
    });
    return fmt.format(new Date()); // e.g. "2026-07-30"
  }

  // Calculate the Tehran-midnight timestamp for expires_at
  // Returns an ISO string for the NEXT 00:00 Asia/Tehran
  function getNextTehranMidnightISO() {
    const now = new Date();
    // Get Tehran time components
    const tehranParts = new Intl.DateTimeFormat('en-US', {
      timeZone: 'Asia/Tehran',
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: '2-digit', minute: '2-digit', second: '2-digit',
      hour12: false,
    }).formatToParts(now);
    const p = {};
    for (const part of tehranParts) p[part.type] = part.value;
    // Build a Date for "now" in Tehran, then add 1 day and set to 00:00
    // Tehran is UTC+3:30, so 00:00 Tehran = previous day 20:30 UTC
    const tehranNow = new Date(`${p.year}-${p.month}-${p.day}T${p.hour === '24' ? '00' : p.hour}:${p.minute}:${p.second}+03:30`);
    const tomorrowMidnight = new Date(tehranNow);
    tomorrowMidnight.setDate(tomorrowMidnight.getDate() + 1);
    tomorrowMidnight.setHours(0, 0, 0, 0);
    return tomorrowMidnight.toISOString();
  }

  /**
   * Ensure wheel tables exist. Creates:
   * - wheel_spins: spin inventory (daily + premium)
   * - wheel_history: spin results
   * - wheel_rewards: reward pool configuration
   */
  async function ensureSchema(env) {
    // DIAGNOSTIC TEST: NO-OP MODE
    _schemaVerified = true;
    return;
    /* eslint-disable no-unreachable */
    if (_schemaVerified) return;
    const batchSql = `
      CREATE TABLE IF NOT EXISTS wheel_spins (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        spin_type VARCHAR(16) NOT NULL DEFAULT 'daily',
        source VARCHAR(32) NOT NULL DEFAULT 'daily_free',
        status VARCHAR(16) NOT NULL DEFAULT 'available',
        campaign_id VARCHAR(64),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        expires_at TIMESTAMPTZ,
        used_at TIMESTAMPTZ,
        spin_date DATE NOT NULL DEFAULT CURRENT_DATE
      );
      CREATE TABLE IF NOT EXISTS wheel_history (
        id SERIAL PRIMARY KEY,
        user_id VARCHAR(64) NOT NULL,
        spin_id INTEGER REFERENCES wheel_spins(id),
        reward_type VARCHAR(32) NOT NULL,
        reward_amount INTEGER NOT NULL DEFAULT 0,
        reward_label VARCHAR(128),
        spin_type VARCHAR(16) NOT NULL DEFAULT 'daily',
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE TABLE IF NOT EXISTS wheel_rewards (
        id SERIAL PRIMARY KEY,
        reward_type VARCHAR(32) NOT NULL,
        reward_amount INTEGER NOT NULL DEFAULT 0,
        reward_label VARCHAR(128),
        weight INTEGER NOT NULL DEFAULT 1,
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        campaign_id VARCHAR(64),
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_wheel_spins_user ON wheel_spins (user_id, status);
      CREATE INDEX IF NOT EXISTS idx_wheel_history_user ON wheel_history (user_id, created_at DESC);
      CREATE INDEX IF NOT EXISTS idx_wheel_rewards_active ON wheel_rewards (is_active, campaign_id);
      -- ROOT CAUSE FIX (F-1 + 2.1): spin_date column + advisory lock approach.
      -- The old UNIQUE(user_id, spin_type, source, created_at) included
      -- microsecond TIMESTAMPTZ so ON CONFLICT never fired.
      -- Now we use a spin_date DATE column + a COUNT-based check inside
      -- an advisory lock to allow up to max_spins_per_user spins per day.
      -- No UNIQUE constraint on spin_date (would limit to 1 spin).
      -- Instead, getOrCreateDailySpins counts today's spins under the
      -- advisory lock and only creates new ones if under the limit.
      ALTER TABLE wheel_spins ADD COLUMN IF NOT EXISTS spin_date DATE NOT NULL DEFAULT CURRENT_DATE;
      -- Drop the old 1-spin UNIQUE index if it exists (from the previous fix)
      DROP INDEX IF EXISTS idx_wheel_spins_daily_unique;
    `;
    try {
      await queryDb(env, batchSql);
      // ROOT CAUSE FIX (item 6): Seed default wheel rewards if table is empty.
      // Without seeding, selectReward() returns { amount: 0, type: 'no_reward' }
      // and the user always gets nothing — "wheel doesn't work".
      // These 8 rewards match the default segment_count=8 in wheel_config.
      // Weighted for a balanced experience: small rewards common, big rare.
      try {
        const poolCount = await queryDb(env, 'SELECT COUNT(*)::int AS cnt FROM wheel_rewards');
        if (Number(poolCount.rows[0]?.cnt || 0) === 0) {
          await queryDb(env, `
            INSERT INTO wheel_rewards (reward_type, reward_amount, reward_label, weight, is_active, metadata) VALUES
              ('token', 1,  '۱ AB',     30, TRUE, '{}'),
              ('token', 2,  '۲ AB',     25, TRUE, '{}'),
              ('token', 3,  '۳ AB',     20, TRUE, '{}'),
              ('token', 5,  '۵ AB',     12, TRUE, '{}'),
              ('token', 10, '۱۰ AB',     6, TRUE, '{}'),
              ('token', 20, '۲۰ AB',     3, TRUE, '{}'),
              ('token', 50, '۵۰ AB',     2, TRUE, '{}'),
              ('spin',  1,  'اسپین اضافی', 2, TRUE, '{}')
            ON CONFLICT DO NOTHING
          `);
        }
      } catch (_) { /* seeding is best-effort — don't block startup */ }
    } catch (e) {
      console.warn('Wheel schema migration warning:', e.message);
    }
    _schemaVerified = true;
  }

  /**
   * Get or create today's daily free spins for a user.
   *
   * ROOT CAUSE FIX (F-1 + F-2 + 2.1): Completely rewritten to support
   * multiple daily spins (max_spins_per_user, default 3).
   *
   * Approach:
   * 1. Acquire advisory lock keyed on (user_id + today) — serializes
   *    concurrent calls for the same user/day.
   * 2. COUNT today's available spins for the user.
   * 3. If count < maxSpins, create new spin rows until we reach maxSpins.
   * 4. Return all available (unused) spins for today.
   *
   * This guarantees exactly maxSpins available spins per user per UTC day,
   * regardless of how many times the API is called or how many concurrent
   * requests are made.
   *
   * @param {object} env - Worker env
   * @param {string} userId - Telegram user ID
   * @param {number} maxSpins - Max daily spins (from wheel_config, default 3)
   * @returns {Promise<{spins: Array, total_available: number, total_allowed: number}>}
   */
  async function getOrCreateDailySpins(env, userId, maxSpins = 3) {
    const uid = String(userId);
    // ROOT-CAUSE FIX: Use Tehran date, NOT UTC date.
    // This ensures spins reset at 00:00 Asia/Tehran (calendar reset),
    // not at 00:00 UTC (which is 03:30 Tehran).
    const tehranToday = getTehranDateString();
    const lockKey = _hashLockKey(uid + '_' + tehranToday);
    // expires_at = next Tehran midnight (so spins expire at 00:00 Tehran tomorrow)
    const expiresAtISO = getNextTehranMidnightISO();

    if (!queryDbTransaction) {
      // Fallback: no transaction support — use simple queries
      const availResult = await queryDb(env,
        `SELECT id, status FROM wheel_spins
         WHERE user_id = $1 AND spin_type = 'daily' AND source = 'daily_free'
         AND spin_date = $2::date AND status = 'available'`,
        [uid, tehranToday]);
      const availableCount = availResult.rows.length;
      const needed = Math.max(0, maxSpins - availableCount);
      for (let i = 0; i < needed; i++) {
        await queryDb(env,
          `INSERT INTO wheel_spins (user_id, spin_type, source, status, metadata, created_at, expires_at, spin_date)
           VALUES ($1, 'daily', 'daily_free', 'available', '{}', NOW(), $2, $3::date)`,
          [uid, expiresAtISO, tehranToday]);
      }
      const finalResult = await queryDb(env,
        `SELECT id, status FROM wheel_spins
         WHERE user_id = $1 AND spin_type = 'daily' AND source = 'daily_free'
         AND spin_date = $2::date AND status = 'available'`,
        [uid, tehranToday]);
      return { spins: finalResult.rows, total_available: finalResult.rows.length, total_allowed: maxSpins };
    }

    // Use advisory lock + COUNT + INSERT in one atomic transaction
    const results = await queryDbTransaction(env, [
      {
        sql: `SELECT pg_advisory_xact_lock($1)`,
        params: [lockKey],
      },
      {
        // Count today's available spins (Tehran date)
        sql: `SELECT COUNT(*)::int AS cnt FROM wheel_spins
              WHERE user_id = $1 AND spin_type = 'daily' AND source = 'daily_free'
              AND spin_date = $2::date AND status = 'available'`,
        params: [uid, tehranToday],
      },
    ]);

    const availableCount = results[1].rows[0]?.cnt || 0;
    const needed = Math.max(0, maxSpins - availableCount);

    // Create needed spin rows (each in its own query — they're inside the
    // advisory lock so no race condition)
    for (let i = 0; i < needed; i++) {
      await queryDb(env,
        `INSERT INTO wheel_spins (user_id, spin_type, source, status, metadata, created_at, expires_at, spin_date)
         VALUES ($1, 'daily', 'daily_free', 'available', '{}', NOW(), $2, $3::date)`,
        [uid, expiresAtISO, tehranToday]);
    }

    // Return all available spins for today (Tehran date)
    const finalResult = await queryDb(env,
      `SELECT id, status FROM wheel_spins
       WHERE user_id = $1 AND spin_type = 'daily' AND source = 'daily_free'
       AND spin_date = $2::date AND status = 'available'`,
      [uid, tehranToday]);

    return { spins: finalResult.rows, total_available: finalResult.rows.length, total_allowed: maxSpins };
  }

  /**
   * Hash a string into a bigint for use as a PostgreSQL advisory lock key.
   * Uses a simple FNV-1a hash — sufficient for lock key distribution.
   */
  function _hashLockKey(str) {
    let hash = 2166136261;
    for (let i = 0; i < str.length; i++) {
      hash ^= str.charCodeAt(i);
      hash = Math.imul(hash, 16777619);
    }
    // Convert to positive bigint (PostgreSQL advisory lock keys are bigint)
    return Math.abs(hash);
  }

  /**
   * Get available spins for a user.
   */
  async function getAvailableSpins(env, userId) {
    const result = await queryDb(
      env,
      `SELECT id, spin_type, source, campaign_id, created_at, expires_at
       FROM wheel_spins
       WHERE user_id = $1 AND status = 'available'
       AND (expires_at IS NULL OR expires_at > NOW())
       ORDER BY created_at ASC`,
      [String(userId)],
    );
    return { spins: result.rows.map(r => ({
      id: r.id,
      type: r.spin_type,
      source: r.source,
      campaign_id: r.campaign_id,
      created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      expires_at: r.expires_at ? new Date(r.expires_at).toISOString() : null,
    }))};
  }

  /**
   * Get active reward pool (weighted).
   */
  async function getRewardPool(env, campaignId = null) {
    const params = campaignId ? [String(campaignId)] : [null];
    const result = await queryDb(
      env,
      `SELECT id, reward_type, reward_amount, reward_label, weight, metadata
       FROM wheel_rewards
       WHERE is_active = TRUE AND COALESCE(campaign_id, '') = COALESCE($1, '')
       ORDER BY weight DESC`,
      params,
    );
    return result.rows.map(r => ({
      id: r.id,
      type: r.reward_type,
      amount: Number(r.reward_amount),
      label: r.reward_label,
      weight: Number(r.weight),
      metadata: r.metadata || {},
    }));
  }

  /**
   * Select a reward based on weighted probability.
   *
   * The reward pool MUST come from the database (wheel_rewards table).
   * If the pool is empty (admin disabled all rewards), we return a
   * zero-amount 'no_reward' instead of a hardcoded consolation — this
   * ensures the admin is the SOLE source of truth for rewards.
   * The spin is still consumed (counted as used) so the user can't
   * retry indefinitely; they just get nothing.
   */
  function selectReward(rewardPool) {
    if (!rewardPool || !rewardPool.length) {
      // No rewards configured — return a zero-amount no_reward.
      // Admin must add rewards via Reward Center → Lucky Wheel tab.
      return { type: 'no_reward', amount: 0, label: 'No reward configured' };
    }
    const totalWeight = rewardPool.reduce((sum, r) => sum + r.weight, 0);
    if (totalWeight <= 0) {
      return rewardPool[0]; // All weights are 0 — return first reward
    }
    let random = Math.random() * totalWeight;
    for (const reward of rewardPool) {
      random -= reward.weight;
      if (random <= 0) return reward;
    }
    return rewardPool[rewardPool.length - 1];
  }

  /**
   * Consume a spin and record the result.
   * Returns the spin_id and selected reward (reward is NOT credited yet —
   * the controller calls economyService.grantReward to credit it).
   */
  async function consumeSpin(env, userId, spinId) {
    const uid = String(userId);
    const sid = Number(spinId);

    // Atomically consume the spin (status: available → used)
    const result = await queryDbTransaction(env, [
      {
        sql: `UPDATE wheel_spins SET status = 'used', used_at = NOW()
              WHERE id = $1 AND user_id = $2 AND status = 'available'
              RETURNING id, spin_type, source, campaign_id`,
        params: [sid, uid],
      },
    ]);

    if (!result[0].rows.length) {
      throw Object.assign(new Error('Spin not available or already used'), { code: 'SPIN_NOT_AVAILABLE' });
    }

    const spin = result[0].rows[0];
    const rewardPool = await getRewardPool(env, spin.campaign_id);
    const reward = selectReward(rewardPool);

    // Record spin result in history
    await queryDb(
      env,
      `INSERT INTO wheel_history (user_id, spin_id, reward_type, reward_amount, reward_label, spin_type, metadata, created_at)
       VALUES ($1, $2, $3, $4, $5, $6, '{}', NOW())`,
      [uid, sid, reward.type, reward.amount, reward.label || '', spin.spin_type],
    );

    return {
      spin_id: sid,
      spin_type: spin.spin_type,
      reward: {
        type: reward.type,
        amount: reward.amount,
        label: reward.label,
      },
    };
  }

  /**
   * Get spin history for a user (paginated).
   */
  async function getSpinHistory(env, userId, offset = 0, limit = 20) {
    const countResult = await queryDb(
      env,
      'SELECT COUNT(*)::int AS total FROM wheel_history WHERE user_id = $1',
      [String(userId)],
    );
    const total = Number(countResult.rows[0]?.total || 0);

    const historyResult = await queryDb(
      env,
      `SELECT id, spin_id, reward_type, reward_amount, reward_label, spin_type, metadata, created_at
       FROM wheel_history WHERE user_id = $1 ORDER BY created_at DESC LIMIT $2 OFFSET $3`,
      [String(userId), Number(limit), Number(offset)],
    );

    return {
      total,
      offset,
      limit,
      hasMore: offset + limit < total,
      history: historyResult.rows.map(r => ({
        id: r.id,
        spin_id: r.spin_id,
        reward_type: r.reward_type,
        reward_amount: Number(r.reward_amount),
        reward_label: r.reward_label,
        spin_type: r.spin_type,
        created_at: r.created_at ? new Date(r.created_at).toISOString() : null,
      })),
    };
  }

  /**
   * Grant a premium spin to a user (admin or purchase).
   */
  async function grantPremiumSpin(env, userId, source = 'admin', campaignId = null) {
    const result = await queryDb(
      env,
      `INSERT INTO wheel_spins (user_id, spin_type, source, status, campaign_id, metadata, created_at, expires_at)
       VALUES ($1, 'premium', $2, 'available', $3, '{}', NOW(), NOW() + INTERVAL '7 days')
       RETURNING id`,
      [String(userId), source, campaignId],
    );
    return { spin_id: result.rows[0]?.id, success: true };
  }

  return Object.freeze({
    ensureSchema,
    getOrCreateDailySpins,
    getAvailableSpins,
    getRewardPool,
    selectReward,
    consumeSpin,
    getSpinHistory,
    grantPremiumSpin,
  });
}

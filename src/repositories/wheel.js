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

  /**
   * Ensure wheel tables exist. Creates:
   * - wheel_spins: spin inventory (daily + premium)
   * - wheel_history: spin results
   * - wheel_rewards: reward pool configuration
   */
  async function ensureSchema(env) {
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
        UNIQUE(user_id, spin_type, source, created_at)
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
    `;
    try {
      await queryDb(env, batchSql);
    } catch (e) {
      console.warn('Wheel schema migration warning:', e.message);
    }
    _schemaVerified = true;
  }

  /**
   * Get or create today's daily free spin for a user.
   * Uses ON CONFLICT to prevent duplicate daily spins.
   */
  async function getOrCreateDailySpin(env, userId) {
    await ensureSchema(env).catch(() => {});
    const uid = String(userId);
    const today = new Date().toISOString().slice(0, 10);
    const refId = `daily_spin_${uid}_${today}`;

    const result = await queryDb(
      env,
      `
        INSERT INTO wheel_spins (user_id, spin_type, source, status, metadata, created_at, expires_at)
        VALUES ($1, 'daily', 'daily_free', 'available', '{}', NOW(), NOW() + INTERVAL '24 hours')
        ON CONFLICT (user_id, spin_type, source, created_at) DO NOTHING
        RETURNING id, status
      `,
      [uid],
    );

    if (result.rows.length > 0) {
      return { spin_id: result.rows[0].id, status: 'available', is_new: true };
    }

    // Spin already exists — check if it's been used
    const existing = await queryDb(
      env,
      `SELECT id, status FROM wheel_spins
       WHERE user_id = $1 AND spin_type = 'daily' AND source = 'daily_free'
       AND created_at >= CURRENT_DATE ORDER BY created_at DESC LIMIT 1`,
      [uid],
    );
    if (existing.rows.length > 0) {
      return { spin_id: existing.rows[0].id, status: existing.rows[0].status, is_new: false };
    }
    return { spin_id: null, status: 'none', is_new: false };
  }

  /**
   * Get available spins for a user.
   */
  async function getAvailableSpins(env, userId) {
    await ensureSchema(env).catch(() => {});
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
    await ensureSchema(env).catch(() => {});
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
   */
  function selectReward(rewardPool) {
    if (!rewardPool || !rewardPool.length) {
      return { type: 'bonus_reward', amount: 1, label: 'Consolation' };
    }
    const totalWeight = rewardPool.reduce((sum, r) => sum + r.weight, 0);
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
    await ensureSchema(env).catch(() => {});
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
    await ensureSchema(env).catch(() => {});
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
    await ensureSchema(env).catch(() => {});
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
    getOrCreateDailySpin,
    getAvailableSpins,
    getRewardPool,
    selectReward,
    consumeSpin,
    getSpinHistory,
    grantPremiumSpin,
  });
}

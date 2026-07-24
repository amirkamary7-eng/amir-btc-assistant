/**
 * Reward Center Repository — Database Layer
 *
 * Manages all reward configuration tables:
 * - reward_library: master list of all reward definitions
 * - referral_reward_tiers: invite count → reward mapping
 * - mission_rewards: mission → reward mapping
 * - campaigns: campaign management
 * - wheel_config: wheel settings (enable/disable, segments, version)
 *
 * This replaces hardcoded reward values with DB-driven configuration.
 * The Economy Layer reads from these tables via getReferralRewardForTier(),
 * getMissionReward(), getActiveWheelRewards(), etc.
 */

export function createRewardCenterRepository(deps) {
  const { queryDb, queryDbTransaction, isDatabaseConfigured, isoDate, normalizeOptionalString } = deps;

  let _schemaVerified = false;

  /**
   * Ensure all Reward Center tables exist. Called lazily on first access.
   * Uses CREATE TABLE IF NOT EXISTS so it's safe to run multiple times.
   */
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    if (!isDatabaseConfigured(env)) { _schemaVerified = true; return; }

    const batchSql = `
      -- Master reward library — defines all possible rewards in the system
      CREATE TABLE IF NOT EXISTS reward_library (
        id SERIAL PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        reward_type VARCHAR(32) NOT NULL DEFAULT 'token',
        amount INTEGER NOT NULL DEFAULT 0,
        icon VARCHAR(64),
        image_url TEXT,
        description TEXT,
        category VARCHAR(32) DEFAULT 'general',
        is_active BOOLEAN NOT NULL DEFAULT TRUE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Referral reward tiers — maps invite count milestones to rewards
      CREATE TABLE IF NOT EXISTS referral_reward_tiers (
        id SERIAL PRIMARY KEY,
        invite_count INTEGER NOT NULL UNIQUE,
        reward_library_id INTEGER REFERENCES reward_library(id),
        token_amount INTEGER NOT NULL DEFAULT 0,
        bonus_spins INTEGER NOT NULL DEFAULT 0,
        campaign_id VARCHAR(64),
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Mission rewards — maps mission IDs to rewards
      CREATE TABLE IF NOT EXISTS mission_rewards (
        id SERIAL PRIMARY KEY,
        mission_id VARCHAR(64) NOT NULL UNIQUE,
        mission_name VARCHAR(128) NOT NULL,
        reward_library_id INTEGER REFERENCES reward_library(id),
        token_amount INTEGER NOT NULL DEFAULT 0,
        bonus_spins INTEGER NOT NULL DEFAULT 0,
        campaign_id VARCHAR(64),
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        sort_order INTEGER NOT NULL DEFAULT 0,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Campaigns — time-bounded reward events
      CREATE TABLE IF NOT EXISTS campaigns (
        id VARCHAR(64) PRIMARY KEY,
        name VARCHAR(128) NOT NULL,
        description TEXT,
        start_date TIMESTAMPTZ,
        end_date TIMESTAMPTZ,
        status VARCHAR(16) NOT NULL DEFAULT 'active',
        priority INTEGER NOT NULL DEFAULT 0,
        applies_to_wheel BOOLEAN NOT NULL DEFAULT FALSE,
        applies_to_referral BOOLEAN NOT NULL DEFAULT FALSE,
        applies_to_mission BOOLEAN NOT NULL DEFAULT FALSE,
        metadata JSONB DEFAULT '{}',
        created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
      );

      -- Wheel configuration — global settings (single row, id=1)
      CREATE TABLE IF NOT EXISTS wheel_config (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        is_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        daily_spin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        referral_spin_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        mission_spin_enabled BOOLEAN NOT NULL DEFAULT FALSE,
        premium_spin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        campaign_spin_enabled BOOLEAN NOT NULL DEFAULT TRUE,
        maintenance_mode BOOLEAN NOT NULL DEFAULT FALSE,
        segment_count SMALLINT NOT NULL DEFAULT 8,
        version VARCHAR(32) NOT NULL DEFAULT '1.0.0',
        theme VARCHAR(32) NOT NULL DEFAULT 'default',
        max_spins_per_user INTEGER NOT NULL DEFAULT 1,
        cooldown_seconds INTEGER NOT NULL DEFAULT 0,
        max_reward_per_day INTEGER NOT NULL DEFAULT 1000,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT wheel_config_single_row CHECK (id = 1)
      );

      -- Emergency controls — global kill switches (single row, id=1)
      CREATE TABLE IF NOT EXISTS reward_emergency_controls (
        id SMALLINT PRIMARY KEY DEFAULT 1,
        disable_wheel BOOLEAN NOT NULL DEFAULT FALSE,
        disable_referral_rewards BOOLEAN NOT NULL DEFAULT FALSE,
        disable_mission_rewards BOOLEAN NOT NULL DEFAULT FALSE,
        disable_campaigns BOOLEAN NOT NULL DEFAULT FALSE,
        disable_reward_engine BOOLEAN NOT NULL DEFAULT FALSE,
        updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
        CONSTRAINT reward_emergency_single_row CHECK (id = 1)
      );

      -- Indexes
      CREATE INDEX IF NOT EXISTS idx_reward_library_active ON reward_library (is_active, category);
      CREATE INDEX IF NOT EXISTS idx_referral_tiers_count ON referral_reward_tiers (invite_count, is_enabled);
      CREATE INDEX IF NOT EXISTS idx_mission_rewards_enabled ON mission_rewards (is_enabled, sort_order);
      CREATE INDEX IF NOT EXISTS idx_campaigns_status ON campaigns (status, priority);
    `;

    try {
      await queryDb(env, batchSql);
      // Seed default wheel_config if not exists
      await queryDb(env, `
        INSERT INTO wheel_config (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING
      `);
      // Seed default emergency controls if not exists
      await queryDb(env, `
        INSERT INTO reward_emergency_controls (id) VALUES (1)
        ON CONFLICT (id) DO NOTHING
      `);
      // Seed default referral reward tiers if table is empty
      const tierCount = await queryDb(env, 'SELECT COUNT(*)::int AS cnt FROM referral_reward_tiers');
      if (Number(tierCount.rows[0]?.cnt || 0) === 0) {
        await queryDb(env, `
          INSERT INTO referral_reward_tiers (invite_count, token_amount, bonus_spins, sort_order, is_enabled) VALUES
            (1, 3, 1, 1, TRUE),
            (5, 20, 2, 2, TRUE),
            (10, 50, 3, 3, TRUE),
            (25, 150, 6, 4, TRUE),
            (50, 400, 12, 5, TRUE),
            (100, 1200, 30, 6, TRUE)
          ON CONFLICT (invite_count) DO NOTHING
        `);
      }
      // Seed default reward library if empty
      const libCount = await queryDb(env, 'SELECT COUNT(*)::int AS cnt FROM reward_library');
      if (Number(libCount.rows[0]?.cnt || 0) === 0) {
        await queryDb(env, `
          INSERT INTO reward_library (name, reward_type, amount, category, is_active) VALUES
            ('3 AB Token', 'token', 3, 'token', TRUE),
            ('5 AB Token', 'token', 5, 'token', TRUE),
            ('10 AB Token', 'token', 10, 'token', TRUE),
            ('50 AB Token', 'token', 50, 'token', TRUE),
            ('100 AB Token', 'token', 100, 'token', TRUE),
            ('500 AB Token', 'token', 500, 'token', TRUE),
            ('1000 AB Token', 'token', 1000, 'token', TRUE),
            ('1 Free Spin', 'spin', 1, 'spin', TRUE),
            ('2 Free Spins', 'spin', 2, 'spin', TRUE),
            ('VPN Access', 'voucher', 1, 'voucher', TRUE),
            ('Discount Coupon', 'coupon', 1, 'coupon', TRUE),
            ('NFT Badge', 'nft', 1, 'nft', TRUE),
            ('Premium Status', 'premium', 1, 'premium', TRUE),
            ('Custom Avatar', 'avatar', 1, 'avatar', TRUE),
            ('Achievement Badge', 'badge', 1, 'badge', TRUE)
          ON CONFLICT DO NOTHING
        `);
      }
      _schemaVerified = true;
    } catch (e) {
      console.warn('Reward Center schema migration warning:', e.message);
      _schemaVerified = true; // Don't retry on every call — log and proceed
    }
  }

  // ═══════════════════════════════════════════════════════════
  // OVERVIEW / ANALYTICS
  // ═══════════════════════════════════════════════════════════

  async function getOverview(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _emptyOverview();

    try {
      // BUG FIX: Use Promise.allSettled — if 'rewards' table doesn't exist,
      // or wheel_history is empty, still return partial data instead of failing entirely.
      const results = await Promise.allSettled([
        getWheelConfig(env),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM wheel_history WHERE created_at >= CURRENT_DATE`),
        queryDb(env, `SELECT COALESCE(SUM(reward_amount), 0)::int AS total FROM wheel_history WHERE created_at >= CURRENT_DATE`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM campaigns WHERE status = 'active' AND (end_date IS NULL OR end_date > NOW())`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM wheel_rewards WHERE is_active = TRUE`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM referral_reward_tiers WHERE is_enabled = TRUE`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM mission_rewards WHERE is_enabled = TRUE`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM rewards WHERE status = 'pending'`),
        queryDb(env, `SELECT reward_label, reward_amount, COUNT(*)::int AS win_count FROM wheel_history WHERE reward_amount > 0 GROUP BY reward_label, reward_amount ORDER BY win_count DESC LIMIT 1`),
        queryDb(env, `SELECT COALESCE(MAX(reward_amount), 0)::int AS highest FROM wheel_history`),
      ]);

      const val = (r, fallback = 0) => r.status === 'fulfilled' ? Number(r.value?.rows?.[0]?.cnt || r.value?.rows?.[0]?.total || r.value?.rows?.[0]?.highest || fallback) : fallback;
      const wheelCfg = results[0].status === 'fulfilled' ? results[0].value : null;
      const todaySpins = val(results[1]);
      const totalDistributed = val(results[2]);
      const activeCampaigns = val(results[3]);
      const activeWheelRewards = val(results[4]);
      const activeTiers = val(results[5]);
      const activeMissions = val(results[6]);
      const pendingRewards = val(results[7]);
      const mostWonRow = results[8].status === 'fulfilled' ? results[8].value?.rows?.[0] : null;
      const highestReward = val(results[9]);

      return {
        wheel_status: wheelCfg?.is_enabled && !wheelCfg?.maintenance_mode ? 'active' : (wheelCfg?.maintenance_mode ? 'maintenance' : 'disabled'),
        total_spins_today: todaySpins,
        rewards_given_today: todaySpins,
        total_ab_distributed: totalDistributed,
        active_campaigns: activeCampaigns,
        active_wheel_rewards: activeWheelRewards,
        active_referral_tiers: activeTiers,
        active_missions: activeMissions,
        pending_rewards: pendingRewards,
        most_won_reward: mostWonRow ? { label: mostWonRow.reward_label, amount: Number(mostWonRow.reward_amount), count: Number(mostWonRow.win_count) } : null,
        highest_reward: highestReward,
        wheel_version: wheelCfg?.version || '1.0.0',
      };
    } catch (e) {
      console.warn('reward_center getOverview error:', e.message);
      return _emptyOverview();
    }
  }

  function _emptyOverview() {
    return {
      wheel_status: 'unknown', total_spins_today: 0, rewards_given_today: 0,
      total_ab_distributed: 0, active_campaigns: 0, active_wheel_rewards: 0,
      active_referral_tiers: 0, active_missions: 0, pending_rewards: 0,
      most_won_reward: null, highest_reward: 0, wheel_version: '1.0.0',
    };
  }

  async function getAnalytics(env, { range = '7d' } = {}) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _emptyAnalytics();

    const rangeCondition = range === '30d' ? "created_at >= NOW() - INTERVAL '30 days'"
      : range === '90d' ? "created_at >= NOW() - INTERVAL '90 days'"
      : "created_at >= NOW() - INTERVAL '7 days'";

    try {
      const [todaySpins, weeklySpins, monthlySpins, avgReward, mostWon, highest, distribution, totalTokens, totalSpins, topWinners, dailyTrend] = await Promise.all([
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM wheel_history WHERE created_at >= CURRENT_DATE`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM wheel_history WHERE created_at >= DATE_TRUNC('week', NOW())`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM wheel_history WHERE created_at >= DATE_TRUNC('month', NOW())`),
        queryDb(env, `SELECT COALESCE(AVG(reward_amount), 0)::float AS avg FROM wheel_history WHERE ${rangeCondition} AND reward_amount > 0`),
        queryDb(env, `SELECT reward_label, COUNT(*)::int AS cnt FROM wheel_history WHERE ${rangeCondition} GROUP BY reward_label ORDER BY cnt DESC LIMIT 5`),
        queryDb(env, `SELECT COALESCE(MAX(reward_amount), 0)::int AS highest FROM wheel_history WHERE ${rangeCondition}`),
        queryDb(env, `SELECT reward_type, reward_label, COUNT(*)::int AS cnt, SUM(reward_amount)::int AS total FROM wheel_history WHERE ${rangeCondition} GROUP BY reward_type, reward_label ORDER BY cnt DESC`),
        queryDb(env, `SELECT COALESCE(SUM(reward_amount), 0)::int AS total FROM wheel_history WHERE ${rangeCondition}`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM wheel_history WHERE ${rangeCondition}`),
        queryDb(env, `SELECT h.user_id, COUNT(*)::int AS spins, SUM(h.reward_amount)::int AS total_won, u.username, u.first_name FROM wheel_history h LEFT JOIN users u ON u.telegram_id = h.user_id WHERE ${rangeCondition} GROUP BY h.user_id, u.username, u.first_name ORDER BY total_won DESC LIMIT 10`),
        queryDb(env, `SELECT DATE(created_at) AS date, COUNT(*)::int AS spins, SUM(reward_amount)::int AS tokens FROM wheel_history WHERE ${rangeCondition} GROUP BY DATE(created_at) ORDER BY date`),
      ]);

      return {
        today_spins: Number(todaySpins.rows[0]?.cnt || 0),
        weekly_spins: Number(weeklySpins.rows[0]?.cnt || 0),
        monthly_spins: Number(monthlySpins.rows[0]?.cnt || 0),
        average_reward: Math.round(Number(avgReward.rows[0]?.avg || 0) * 100) / 100,
        most_won: mostWon.rows.map(r => ({ label: r.reward_label, count: Number(r.cnt) })),
        highest_reward: Number(highest.rows[0]?.highest || 0),
        reward_distribution: distribution.rows.map(r => ({ type: r.reward_type, label: r.reward_label, count: Number(r.cnt), total: Number(r.total) })),
        total_tokens: Number(totalTokens.rows[0]?.total || 0),
        total_spins: Number(totalSpins.rows[0]?.cnt || 0),
        top_winners: topWinners.rows.map(r => ({ user_id: String(r.user_id), username: r.username, first_name: r.first_name, spins: Number(r.spins), total_won: Number(r.total_won) })),
        spin_trend: dailyTrend.rows.map(r => ({ date: isoDate(r.date), spins: Number(r.spins), tokens: Number(r.tokens) })),
      };
    } catch (e) {
      console.warn('reward_center getAnalytics error:', e.message);
      return _emptyAnalytics();
    }
  }

  function _emptyAnalytics() {
    return { today_spins: 0, weekly_spins: 0, monthly_spins: 0, average_reward: 0, most_won: [], highest_reward: 0, reward_distribution: [], total_tokens: 0, total_spins: 0, top_winners: [], spin_trend: [] };
  }

  // ═══════════════════════════════════════════════════════════
  // WHEEL CONFIG (Settings)
  // ═══════════════════════════════════════════════════════════

  async function getWheelConfig(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultWheelConfig();
    try {
      const result = await queryDb(env, `SELECT * FROM wheel_config WHERE id = 1 LIMIT 1`);
      return result.rows[0] ? _mapWheelConfig(result.rows[0]) : _defaultWheelConfig();
    } catch { return _defaultWheelConfig(); }
  }

  async function updateWheelConfig(env, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultWheelConfig();
    const fields = ['is_enabled', 'daily_spin_enabled', 'referral_spin_enabled', 'mission_spin_enabled', 'premium_spin_enabled', 'campaign_spin_enabled', 'maintenance_mode', 'segment_count', 'version', 'theme', 'max_spins_per_user', 'cooldown_seconds', 'max_reward_per_day'];
    const setClauses = [];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(updates[f]);
      }
    }
    if (setClauses.length === 0) return getWheelConfig(env);
    setClauses.push(`updated_at = NOW()`);
    params.push(1); // id
    const result = await queryDb(env, `UPDATE wheel_config SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapWheelConfig(result.rows[0]) : _defaultWheelConfig();
  }

  function _defaultWheelConfig() {
    return { is_enabled: true, daily_spin_enabled: true, referral_spin_enabled: false, mission_spin_enabled: false, premium_spin_enabled: true, campaign_spin_enabled: true, maintenance_mode: false, segment_count: 8, version: '1.0.0', theme: 'default', max_spins_per_user: 1, cooldown_seconds: 0, max_reward_per_day: 1000 };
  }

  function _mapWheelConfig(r) {
    return {
      is_enabled: r.is_enabled, daily_spin_enabled: r.daily_spin_enabled,
      referral_spin_enabled: r.referral_spin_enabled, mission_spin_enabled: r.mission_spin_enabled,
      premium_spin_enabled: r.premium_spin_enabled, campaign_spin_enabled: r.campaign_spin_enabled,
      maintenance_mode: r.maintenance_mode, segment_count: Number(r.segment_count),
      version: r.version, theme: r.theme, max_spins_per_user: Number(r.max_spins_per_user),
      cooldown_seconds: Number(r.cooldown_seconds), max_reward_per_day: Number(r.max_reward_per_day),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // WHEEL REWARDS (CRUD — uses existing wheel_rewards table)
  // ═══════════════════════════════════════════════════════════

  async function listWheelRewards(env, { campaignId = null, activeOnly = false } = {}) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [];
    const conditions = [];
    const params = [];
    let idx = 1;
    if (campaignId) { conditions.push(`campaign_id = $${idx++}`); params.push(campaignId); }
    if (activeOnly) { conditions.push(`is_active = TRUE`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await queryDb(env, `SELECT * FROM wheel_rewards ${where} ORDER BY weight DESC, id ASC`, params);
    return result.rows.map(_mapWheelReward);
  }

  async function createWheelReward(env, data) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO wheel_rewards (reward_type, reward_amount, reward_label, weight, is_active, campaign_id, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7)
      RETURNING *
    `, [data.reward_type || 'token', Number(data.reward_amount || 0), normalizeOptionalString(data.reward_label), Number(data.weight || 1), data.is_active !== false, normalizeOptionalString(data.campaign_id) || null, JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapWheelReward(result.rows[0]) : null;
  }

  async function updateWheelReward(env, id, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const fields = ['reward_type', 'reward_amount', 'reward_label', 'weight', 'is_active', 'campaign_id', 'metadata'];
    const setClauses = [];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(f === 'metadata' ? JSON.stringify(updates[f]) : updates[f]);
      }
    }
    if (setClauses.length === 0) return null;
    params.push(Number(id));
    const result = await queryDb(env, `UPDATE wheel_rewards SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapWheelReward(result.rows[0]) : null;
  }

  async function deleteWheelReward(env, id) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM wheel_rewards WHERE id = $1 RETURNING id`, [Number(id)]);
    return result.rows.length > 0;
  }

  function _mapWheelReward(r) {
    return {
      id: Number(r.id), reward_type: r.reward_type, reward_amount: Number(r.reward_amount),
      reward_label: r.reward_label, weight: Number(r.weight), is_active: r.is_active,
      campaign_id: r.campaign_id, metadata: r.metadata || {},
    };
  }

  // ═══════════════════════════════════════════════════════════
  // REWARD LIBRARY (CRUD)
  // ═══════════════════════════════════════════════════════════

  async function listRewardLibrary(env, { category = null, activeOnly = false } = {}) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [];
    const conditions = [];
    const params = [];
    let idx = 1;
    if (category) { conditions.push(`category = $${idx++}`); params.push(category); }
    if (activeOnly) { conditions.push(`is_active = TRUE`); }
    const where = conditions.length ? `WHERE ${conditions.join(' AND ')}` : '';
    const result = await queryDb(env, `SELECT * FROM reward_library ${where} ORDER BY category, amount ASC, name ASC`, params);
    return result.rows.map(_mapLibraryItem);
  }

  async function createLibraryItem(env, data) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO reward_library (name, reward_type, amount, icon, image_url, description, category, is_active, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      RETURNING *
    `, [data.name, data.reward_type || 'token', Number(data.amount || 0), normalizeOptionalString(data.icon), normalizeOptionalString(data.image_url), normalizeOptionalString(data.description), data.category || 'general', data.is_active !== false, JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapLibraryItem(result.rows[0]) : null;
  }

  async function updateLibraryItem(env, id, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const fields = ['name', 'reward_type', 'amount', 'icon', 'image_url', 'description', 'category', 'is_active', 'metadata'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(f === 'metadata' ? JSON.stringify(updates[f]) : updates[f]);
      }
    }
    params.push(Number(id));
    const result = await queryDb(env, `UPDATE reward_library SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapLibraryItem(result.rows[0]) : null;
  }

  async function deleteLibraryItem(env, id) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM reward_library WHERE id = $1 RETURNING id`, [Number(id)]);
    return result.rows.length > 0;
  }

  function _mapLibraryItem(r) {
    return {
      id: Number(r.id), name: r.name, reward_type: r.reward_type, amount: Number(r.amount),
      icon: r.icon, image_url: r.image_url, description: r.description, category: r.category,
      is_active: r.is_active, metadata: r.metadata || {}, created_at: isoDate(r.created_at),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // REFERRAL REWARD TIERS (CRUD)
  // ═══════════════════════════════════════════════════════════

  async function listReferralTiers(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `SELECT * FROM referral_reward_tiers ORDER BY invite_count ASC`);
    return result.rows.map(_mapReferralTier);
  }

  async function createReferralTier(env, data) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO referral_reward_tiers (invite_count, reward_library_id, token_amount, bonus_spins, campaign_id, is_enabled, sort_order, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
      ON CONFLICT (invite_count) DO UPDATE SET token_amount = EXCLUDED.token_amount, bonus_spins = EXCLUDED.bonus_spins, updated_at = NOW()
      RETURNING *
    `, [Number(data.invite_count), data.reward_library_id || null, Number(data.token_amount || 0), Number(data.bonus_spins || 0), normalizeOptionalString(data.campaign_id), data.is_enabled !== false, Number(data.sort_order || data.invite_count), JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapReferralTier(result.rows[0]) : null;
  }

  async function updateReferralTier(env, id, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const fields = ['invite_count', 'reward_library_id', 'token_amount', 'bonus_spins', 'campaign_id', 'is_enabled', 'sort_order', 'metadata'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(f === 'metadata' ? JSON.stringify(updates[f]) : updates[f]);
      }
    }
    params.push(Number(id));
    const result = await queryDb(env, `UPDATE referral_reward_tiers SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapReferralTier(result.rows[0]) : null;
  }

  async function deleteReferralTier(env, id) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM referral_reward_tiers WHERE id = $1 RETURNING id`, [Number(id)]);
    return result.rows.length > 0;
  }

  /**
   * Get the reward for a specific invite count milestone.
   * Returns the highest tier where invite_count >= tier.invite_count.
   * Used by Economy Layer when processing referral rewards.
   */
  async function getReferralRewardForInvites(env, totalInvites) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { token_amount: 3, bonus_spins: 0 };
    try {
      const result = await queryDb(env, `
        SELECT token_amount, bonus_spins FROM referral_reward_tiers
        WHERE is_enabled = TRUE AND invite_count <= $1
        ORDER BY invite_count DESC LIMIT 1
      `, [Number(totalInvites)]);
      if (result.rows[0]) {
        return { token_amount: Number(result.rows[0].token_amount), bonus_spins: Number(result.rows[0].bonus_spins) };
      }
      return { token_amount: 3, bonus_spins: 0 }; // fallback default
    } catch { return { token_amount: 3, bonus_spins: 0 }; }
  }

  function _mapReferralTier(r) {
    return {
      id: Number(r.id), invite_count: Number(r.invite_count),
      reward_library_id: r.reward_library_id ? Number(r.reward_library_id) : null,
      token_amount: Number(r.token_amount), bonus_spins: Number(r.bonus_spins),
      campaign_id: r.campaign_id, is_enabled: r.is_enabled, sort_order: Number(r.sort_order),
      metadata: r.metadata || {}, created_at: isoDate(r.created_at),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // MISSION REWARDS (CRUD)
  // ═══════════════════════════════════════════════════════════

  async function listMissionRewards(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `SELECT * FROM mission_rewards ORDER BY sort_order ASC`);
    return result.rows.map(_mapMissionReward);
  }

  async function createMissionReward(env, data) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO mission_rewards (mission_id, mission_name, reward_library_id, token_amount, bonus_spins, campaign_id, is_enabled, sort_order, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
      ON CONFLICT (mission_id) DO UPDATE SET mission_name = EXCLUDED.mission_name, token_amount = EXCLUDED.token_amount, bonus_spins = EXCLUDED.bonus_spins, updated_at = NOW()
      RETURNING *
    `, [data.mission_id, data.mission_name, data.reward_library_id || null, Number(data.token_amount || 0), Number(data.bonus_spins || 0), normalizeOptionalString(data.campaign_id), data.is_enabled !== false, Number(data.sort_order || 0), JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapMissionReward(result.rows[0]) : null;
  }

  async function updateMissionReward(env, id, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const fields = ['mission_id', 'mission_name', 'reward_library_id', 'token_amount', 'bonus_spins', 'campaign_id', 'is_enabled', 'sort_order', 'metadata'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(f === 'metadata' ? JSON.stringify(updates[f]) : updates[f]);
      }
    }
    params.push(Number(id));
    const result = await queryDb(env, `UPDATE mission_rewards SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapMissionReward(result.rows[0]) : null;
  }

  async function deleteMissionReward(env, id) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM mission_rewards WHERE id = $1 RETURNING id`, [Number(id)]);
    return result.rows.length > 0;
  }

  async function getMissionReward(env, missionId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { token_amount: 0, bonus_spins: 0 };
    try {
      const result = await queryDb(env, `SELECT token_amount, bonus_spins FROM mission_rewards WHERE mission_id = $1 AND is_enabled = TRUE LIMIT 1`, [String(missionId)]);
      if (result.rows[0]) return { token_amount: Number(result.rows[0].token_amount), bonus_spins: Number(result.rows[0].bonus_spins) };
      return { token_amount: 0, bonus_spins: 0 };
    } catch { return { token_amount: 0, bonus_spins: 0 }; }
  }

  function _mapMissionReward(r) {
    return {
      id: Number(r.id), mission_id: r.mission_id, mission_name: r.mission_name,
      reward_library_id: r.reward_library_id ? Number(r.reward_library_id) : null,
      token_amount: Number(r.token_amount), bonus_spins: Number(r.bonus_spins),
      campaign_id: r.campaign_id, is_enabled: r.is_enabled, sort_order: Number(r.sort_order),
      metadata: r.metadata || {}, created_at: isoDate(r.created_at),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // CAMPAIGNS (CRUD)
  // ═══════════════════════════════════════════════════════════

  async function listCampaigns(env, { activeOnly = false } = {}) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [];
    const where = activeOnly ? `WHERE status = 'active' AND (end_date IS NULL OR end_date > NOW())` : '';
    const result = await queryDb(env, `SELECT * FROM campaigns ${where} ORDER BY priority DESC, created_at DESC`);
    return result.rows.map(_mapCampaign);
  }

  async function getCampaign(env, id) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `SELECT * FROM campaigns WHERE id = $1 LIMIT 1`, [String(id)]);
    return result.rows[0] ? _mapCampaign(result.rows[0]) : null;
  }

  async function createCampaign(env, data) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const id = data.id || `camp_${Date.now()}`;
    const result = await queryDb(env, `
      INSERT INTO campaigns (id, name, description, start_date, end_date, status, priority, applies_to_wheel, applies_to_referral, applies_to_mission, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [id, data.name, normalizeOptionalString(data.description), data.start_date || null, data.end_date || null, data.status || 'active', Number(data.priority || 0), !!data.applies_to_wheel, !!data.applies_to_referral, !!data.applies_to_mission, JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapCampaign(result.rows[0]) : null;
  }

  async function updateCampaign(env, id, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const fields = ['name', 'description', 'start_date', 'end_date', 'status', 'priority', 'applies_to_wheel', 'applies_to_referral', 'applies_to_mission', 'metadata'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(f === 'metadata' ? JSON.stringify(updates[f]) : updates[f]);
      }
    }
    params.push(String(id));
    const result = await queryDb(env, `UPDATE campaigns SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapCampaign(result.rows[0]) : null;
  }

  async function deleteCampaign(env, id) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM campaigns WHERE id = $1 RETURNING id`, [String(id)]);
    return result.rows.length > 0;
  }

  function _mapCampaign(r) {
    return {
      id: r.id, name: r.name, description: r.description,
      start_date: isoDate(r.start_date), end_date: isoDate(r.end_date),
      status: r.status, priority: Number(r.priority),
      applies_to_wheel: r.applies_to_wheel, applies_to_referral: r.applies_to_referral,
      applies_to_mission: r.applies_to_mission, metadata: r.metadata || {},
      created_at: isoDate(r.created_at),
    };
  }

  // ═══════════════════════════════════════════════════════════
  // EMERGENCY CONTROLS
  // ═══════════════════════════════════════════════════════════

  async function getEmergencyControls(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultEmergency();
    try {
      const result = await queryDb(env, `SELECT * FROM reward_emergency_controls WHERE id = 1 LIMIT 1`);
      return result.rows[0] ? _mapEmergency(result.rows[0]) : _defaultEmergency();
    } catch { return _defaultEmergency(); }
  }

  async function updateEmergencyControls(env, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultEmergency();
    const fields = ['disable_wheel', 'disable_referral_rewards', 'disable_mission_rewards', 'disable_campaigns', 'disable_reward_engine'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(!!updates[f]);
      }
    }
    params.push(1);
    const result = await queryDb(env, `UPDATE reward_emergency_controls SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapEmergency(result.rows[0]) : _defaultEmergency();
  }

  function _defaultEmergency() {
    return { disable_wheel: false, disable_referral_rewards: false, disable_mission_rewards: false, disable_campaigns: false, disable_reward_engine: false };
  }

  function _mapEmergency(r) {
    return {
      disable_wheel: r.disable_wheel, disable_referral_rewards: r.disable_referral_rewards,
      disable_mission_rewards: r.disable_mission_rewards, disable_campaigns: r.disable_campaigns,
      disable_reward_engine: r.disable_reward_engine,
    };
  }

  /**
   * Check if a specific reward subsystem is emergency-disabled.
   * Used by Economy Layer before granting any reward.
   */
  async function isSubsystemDisabled(env, subsystem) {
    const ctrl = await getEmergencyControls(env);
    if (ctrl.disable_reward_engine) return true; // global kill switch
    if (subsystem === 'wheel' && ctrl.disable_wheel) return true;
    if (subsystem === 'referral' && ctrl.disable_referral_rewards) return true;
    if (subsystem === 'mission' && ctrl.disable_mission_rewards) return true;
    if (subsystem === 'campaign' && ctrl.disable_campaigns) return true;
    return false;
  }

  return Object.freeze({
    ensureSchema,
    getOverview,
    getAnalytics,
    getWheelConfig,
    updateWheelConfig,
    listWheelRewards,
    createWheelReward,
    updateWheelReward,
    deleteWheelReward,
    listRewardLibrary,
    createLibraryItem,
    updateLibraryItem,
    deleteLibraryItem,
    listReferralTiers,
    createReferralTier,
    updateReferralTier,
    deleteReferralTier,
    getReferralRewardForInvites,
    listMissionRewards,
    createMissionReward,
    updateMissionReward,
    deleteMissionReward,
    getMissionReward,
    listCampaigns,
    getCampaign,
    createCampaign,
    updateCampaign,
    deleteCampaign,
    getEmergencyControls,
    updateEmergencyControls,
    isSubsystemDisabled,
  });
}

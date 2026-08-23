/**
 * Reward Purchases Repository — VPN rewards + fulfillment queue
 *
 * Manages the reward_purchases table:
 * - VPN plan purchases (atomic with wallet debit)
 * - 30-day per-plan purchase limit (server-enforced)
 * - Admin fulfillment with VPN link delivery via Telegram
 * - Tracking IDs (VPN-YYYYMMDD-XXXXXX format)
 *
 * Purchase lifecycle:
 *   pending → fulfilled (admin sends VPN link)
 *   pending → cancelled
 *   pending → failed (debit refunded, no 30-day lock)
 *
 * 30-day limit: only SUCCESSFUL (fulfilled) purchases lock the plan.
 * Failed/cancelled purchases do NOT create restrictions.
 */

export function createRewardPurchaseRepository(deps) {
  const { queryDb, isDatabaseConfigured } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    if (_schemaVerified) return;
    if (!isDatabaseConfigured(env)) { _schemaVerified = true; return; }
    try {
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS reward_purchases (
          id SERIAL PRIMARY KEY,
          user_id VARCHAR(64) NOT NULL,
          reward_type VARCHAR(32) NOT NULL DEFAULT 'vpn',
          plan_id VARCHAR(64),
          plan_name VARCHAR(128),
          vpn_gb INTEGER,
          cost_ab INTEGER NOT NULL,
          duration_days INTEGER NOT NULL DEFAULT 7,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          tracking_id VARCHAR(64),
          tx_ref_id VARCHAR(128),
          vpn_link TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          fulfilled_at TIMESTAMPTZ,
          fulfilled_by VARCHAR(64),
          expires_at TIMESTAMPTZ,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      // Schema v2 migrations (idempotent)
      await queryDb(env, `ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS plan_id VARCHAR(64)`).catch(() => {});
      await queryDb(env, `ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS plan_name VARCHAR(128)`).catch(() => {});
      await queryDb(env, `ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS duration_days INTEGER NOT NULL DEFAULT 7`).catch(() => {});
      await queryDb(env, `ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS tracking_id VARCHAR(64)`).catch(() => {});
      await queryDb(env, `ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS vpn_link TEXT`).catch(() => {});
      await queryDb(env, `ALTER TABLE reward_purchases ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ`).catch(() => {});

      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_rp_user ON reward_purchases (user_id, created_at DESC)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_rp_status ON reward_purchases (status, created_at ASC)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_rp_tracking ON reward_purchases (tracking_id)`).catch(() => {});
      // Index for the 30-day limit query
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_rp_user_plan_status ON reward_purchases (user_id, plan_id, status, created_at DESC)`).catch(() => {});
      // Partial unique index: at most ONE pending purchase per user+plan
      await queryDb(env, `CREATE UNIQUE INDEX IF NOT EXISTS uq_rp_pending_plan
        ON reward_purchases (user_id, reward_type, vpn_gb)
        WHERE status = 'pending'`).catch(() => {});
      _schemaVerified = true;
    } catch (e) {
      console.warn('[reward-purchases] schema migration warning:', e.message);
      _schemaVerified = true;
    }
  }

  // ─── VPN Plan Catalog ───────────────────────────────────────────────────

  // FIX 8: Duration is part of the catalog (backend authoritative).
  // 1-4GB = 1 week (7 days), 6-10GB = 1 month (30 days).
  const VPN_PLANS = Object.freeze([
    { id: 'vpn_1gb',  gb: 1,  costAb: 200, premiumOnly: false, durationDays: 7,  durationFa: '۱ هفته',  durationEn: '1 week'  },
    { id: 'vpn_2gb',  gb: 2,  costAb: 200, premiumOnly: true,  durationDays: 7,  durationFa: '۱ هفته',  durationEn: '1 week'  },
    { id: 'vpn_4gb',  gb: 4,  costAb: 200, premiumOnly: true,  durationDays: 7,  durationFa: '۱ هفته',  durationEn: '1 week'  },
    { id: 'vpn_6gb',  gb: 6,  costAb: 300, premiumOnly: true,  durationDays: 30, durationFa: '۱ ماه',   durationEn: '1 month' },
    { id: 'vpn_8gb',  gb: 8,  costAb: 400, premiumOnly: true,  durationDays: 30, durationFa: '۱ ماه',   durationEn: '1 month' },
    { id: 'vpn_10gb', gb: 10, costAb: 500, premiumOnly: true,  durationDays: 30, durationFa: '۱ ماه',   durationEn: '1 month' },
  ]);

  function getVpnPlans() {
    return VPN_PLANS;
  }

  function getVpnPlan(planId) {
    return VPN_PLANS.find(p => p.id === planId) || null;
  }

  // ─── Tracking ID ────────────────────────────────────────────────────────

  /**
   * FIX 10: Generate a unique tracking ID: VPN-YYYYMMDD-XXXXXX
   */
  function generateTrackingId() {
    const now = new Date();
    const dateStr = now.toISOString().slice(0, 10).replace(/-/g, '');
    const random = Math.random().toString(36).substring(2, 8).toUpperCase();
    return `VPN-${dateStr}-${random}`;
  }

  // ─── 30-Day Purchase Limit ──────────────────────────────────────────────

  /**
   * FIX 7: Check if user purchased this plan within the last 30 days.
   * Only counts SUCCESSFUL (fulfilled) purchases — failed/cancelled don't lock.
   *
   * @returns {Promise<{restricted: boolean, daysRemaining?: number, lastPurchase?: object}>}
   */
  async function checkPurchaseLimit(env, userId, planId) {
    await ensureSchema(env);
    const plan = getVpnPlan(planId);
    if (!plan) return { restricted: false };

    // Find the most recent fulfilled purchase for this user+plan
    const result = await queryDb(env,
      `SELECT id, tracking_id, created_at, expires_at
       FROM reward_purchases
       WHERE user_id = $1 AND plan_id = $2 AND status = 'fulfilled'
         AND created_at > NOW() - ($3 || ' days')::interval
       ORDER BY created_at DESC
       LIMIT 1`,
      [String(userId), String(planId), '30'],
    );

    if (result.rows.length === 0) {
      return { restricted: false };
    }

    const row = result.rows[0];
    const purchasedAt = new Date(row.created_at);
    const elapsedDays = (Date.now() - purchasedAt.getTime()) / 86400000;
    const daysRemaining = Math.max(0, Math.ceil(30 - elapsedDays));
    return {
      restricted: true,
      daysRemaining,
      lastPurchase: {
        id: Number(row.id),
        tracking_id: row.tracking_id,
        created_at: row.created_at,
        expires_at: row.expires_at,
      },
    };
  }

  // ─── Purchase Creation ──────────────────────────────────────────────────

  /**
   * Create a VPN purchase — MUST be called AFTER the wallet debit has
   * succeeded. The caller (controller) performs the atomic debit first,
   * then calls this to record the purchase.
   *
   * Race protection: partial unique index uq_rp_pending_plan ensures
   * at most one pending purchase per user+plan at the DB level.
   *
   * @returns {Promise<{purchase, created}>}
   */
  async function createVpnPurchase(env, userId, planId, costAb, txRefId) {
    await ensureSchema(env);
    const uid = String(userId);
    const plan = getVpnPlan(planId);
    if (!plan) throw new Error('INVALID_PLAN');

    const trackingId = generateTrackingId();
    const expiresAt = new Date(Date.now() + plan.durationDays * 24 * 3600 * 1000).toISOString();

    const result = await queryDb(env,
      `INSERT INTO reward_purchases (user_id, reward_type, plan_id, plan_name, vpn_gb, cost_ab, duration_days, status, tracking_id, tx_ref_id, expires_at, created_at)
       VALUES ($1, 'vpn', $2, $3, $4, $5, $6, 'pending', $7, $8, $9::timestamptz, NOW())
       ON CONFLICT DO NOTHING
       RETURNING id, user_id, reward_type, plan_id, plan_name, vpn_gb, cost_ab, duration_days, status, tracking_id, expires_at, created_at`,
      [uid, plan.id, `VPN ${plan.gb}GB`, plan.gb, Number(costAb), plan.durationDays, trackingId, String(txRefId || ''), expiresAt],
    );

    if (result.rows.length > 0) {
      return { purchase: result.rows[0], created: true };
    }

    // Conflict — a pending purchase already exists
    const existing = await queryDb(env,
      `SELECT id, user_id, reward_type, plan_id, plan_name, vpn_gb, cost_ab, duration_days, status, tracking_id, expires_at, created_at
       FROM reward_purchases
       WHERE user_id = $1 AND reward_type = 'vpn' AND vpn_gb = $2 AND status = 'pending'
       LIMIT 1`,
      [uid, plan.gb],
    );
    return { purchase: existing.rows[0] || null, created: false };
  }

  // ─── Fulfillment ────────────────────────────────────────────────────────

  /**
   * Cancel a purchase. Only pending purchases can be cancelled.
   */
  async function cancelPurchase(env, purchaseId) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `UPDATE reward_purchases SET status = 'cancelled', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [Number(purchaseId)],
    );
    return result.rows.length > 0;
  }

  /**
   * Mark a purchase as failed (used when the debit needs to be refunded).
   * Failed purchases do NOT lock the 30-day limit.
   */
  async function failPurchase(env, purchaseId) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `UPDATE reward_purchases SET status = 'failed', updated_at = NOW()
       WHERE id = $1 AND status = 'pending' RETURNING id`,
      [Number(purchaseId)],
    );
    return result.rows.length > 0;
  }

  /**
   * FIX 3+11: Fulfill a purchase with a VPN link.
   * Records WHO fulfilled it, WHEN, and the VPN link.
   * Only pending → fulfilled (state machine, no double-fulfillment).
   */
  async function fulfillPurchase(env, purchaseId, adminId, vpnLink) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `UPDATE reward_purchases
       SET status = 'fulfilled',
           fulfilled_at = NOW(),
           fulfilled_by = $2,
           vpn_link = $3,
           updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, user_id, reward_type, plan_id, plan_name, vpn_gb, cost_ab,
                 duration_days, status, tracking_id, vpn_link, created_at,
                 fulfilled_at, fulfilled_by, expires_at`,
      [Number(purchaseId), String(adminId), String(vpnLink || '')],
    );
    return result.rows[0] || null;
  }

  /**
   * Get a single purchase by ID (for admin fulfillment detail).
   */
  async function getPurchaseById(env, purchaseId) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `SELECT rp.*, u.username, u.first_name, u.last_name
       FROM reward_purchases rp
       LEFT JOIN users u ON u.telegram_id = rp.user_id
       WHERE rp.id = $1 LIMIT 1`,
      [Number(purchaseId)],
    );
    if (!result.rows[0]) return null;
    return _mapPurchaseRow(result.rows[0]);
  }

  // ─── Listing ────────────────────────────────────────────────────────────

  function _mapPurchaseRow(r) {
    return {
      id: Number(r.id),
      user_id: r.user_id,
      username: r.username || null,
      display_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || r.user_id,
      reward_type: r.reward_type,
      plan_id: r.plan_id,
      plan_name: r.plan_name,
      vpn_gb: r.vpn_gb ? Number(r.vpn_gb) : null,
      cost_ab: Number(r.cost_ab),
      duration_days: Number(r.duration_days) || 7,
      status: r.status,
      tracking_id: r.tracking_id,
      vpn_link: r.vpn_link,
      tx_ref_id: r.tx_ref_id,
      created_at: r.created_at,
      fulfilled_at: r.fulfilled_at,
      fulfilled_by: r.fulfilled_by,
      expires_at: r.expires_at,
    };
  }

  async function listPurchases(env, { status = null, limit = 50, offset = 0 } = {}) {
    await ensureSchema(env);
    const params = [];
    let where = '';
    let idx = 1;
    if (status) {
      where = `WHERE rp.status = $${idx++}`;
      params.push(String(status));
    }
    params.push(Number(limit), Number(offset));

    const countResult = await queryDb(env,
      `SELECT COUNT(*)::int AS cnt FROM reward_purchases rp ${where}`, params.slice(0, idx - 1));
    const total = Number(countResult.rows[0]?.cnt || 0);

    const result = await queryDb(env,
      `SELECT rp.id, rp.user_id, rp.reward_type, rp.plan_id, rp.plan_name, rp.vpn_gb,
              rp.cost_ab, rp.duration_days, rp.status, rp.tracking_id, rp.vpn_link,
              rp.tx_ref_id, rp.created_at, rp.fulfilled_at, rp.fulfilled_by, rp.expires_at,
              u.username, u.first_name, u.last_name
       FROM reward_purchases rp
       LEFT JOIN users u ON u.telegram_id = rp.user_id
       ${where}
       ORDER BY rp.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params);

    return {
      total,
      purchases: result.rows.map(_mapPurchaseRow),
    };
  }

  async function listUserPurchases(env, userId, limit = 20) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `SELECT id, reward_type, plan_id, plan_name, vpn_gb, cost_ab, duration_days,
              status, tracking_id, vpn_link, created_at, fulfilled_at, expires_at
       FROM reward_purchases
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [String(userId), Number(limit)]);
    return result.rows.map(r => ({
      id: Number(r.id),
      reward_type: r.reward_type,
      plan_id: r.plan_id,
      plan_name: r.plan_name,
      vpn_gb: r.vpn_gb ? Number(r.vpn_gb) : null,
      cost_ab: Number(r.cost_ab),
      duration_days: Number(r.duration_days) || 7,
      status: r.status,
      tracking_id: r.tracking_id,
      vpn_link: r.vpn_link,
      created_at: r.created_at,
      fulfilled_at: r.fulfilled_at,
      expires_at: r.expires_at,
    }));
  }

  return Object.freeze({
    ensureSchema,
    getVpnPlans,
    getVpnPlan,
    generateTrackingId,
    checkPurchaseLimit,
    createVpnPurchase,
    cancelPurchase,
    failPurchase,
    fulfillPurchase,
    getPurchaseById,
    listPurchases,
    listUserPurchases,
  });
}

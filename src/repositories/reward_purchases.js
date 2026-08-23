/**
 * Reward Purchases Repository — VPN rewards + fulfillment queue
 *
 * Manages the reward_purchases table:
 * - VPN plan purchases by Premium users (atomic with wallet debit)
 * - Admin fulfillment queue (pending → fulfilled)
 *
 * Purchase model:
 *   A Premium user spends AB tokens on a VPN plan (e.g., 200 AB → 4GB).
 *   The purchase is created with status='pending' AFTER the atomic wallet
 *   debit succeeds. An admin fulfills it manually (sends the VPN link to
 *   the user via Telegram) and marks it fulfilled.
 *
 * Duplicate protection:
 *   - A user cannot have TWO pending purchases of the same VPN plan
 *     (must wait for fulfillment or cancellation).
 *   - The atomic debit + insert transaction prevents double-charge on
 *     double-click (idempotency via the wallet's unique refId).
 */

export function createRewardPurchaseRepository(deps) {
  const { queryDb, queryDbTransaction, isDatabaseConfigured, getTehranDateString } = deps;

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
          vpn_gb INTEGER,
          cost_ab INTEGER NOT NULL,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          tx_ref_id VARCHAR(128),
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          fulfilled_at TIMESTAMPTZ,
          fulfilled_by VARCHAR(64),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_rp_user ON reward_purchases (user_id, created_at DESC)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_rp_status ON reward_purchases (status, created_at ASC)`).catch(() => {});
      // P2-FIX: DB-level race protection — a user can have AT MOST ONE pending
      // purchase per VPN plan. If two concurrent requests both pass the
      // SELECT check, the unique index makes the second INSERT fail with
      // 23505, which we catch and treat as "already pending".
      await queryDb(env, `CREATE UNIQUE INDEX IF NOT EXISTS uq_rp_pending_plan
        ON reward_purchases (user_id, reward_type, vpn_gb)
        WHERE status = 'pending'`).catch(() => {});
      _schemaVerified = true;
    } catch (e) {
      console.warn('[reward-purchases] schema migration warning:', e.message);
      _schemaVerified = true;
    }
  }

  /**
   * VPN plan catalog — the ONLY purchasable rewards in this release.
   * (PHASE 6: exactly 5 plans, 100–500 AB.)
   */
  const VPN_PLANS = Object.freeze([
    { id: 'vpn_2gb',  gb: 2,  costAb: 100 },
    { id: 'vpn_4gb',  gb: 4,  costAb: 200 },
    { id: 'vpn_6gb',  gb: 6,  costAb: 300 },
    { id: 'vpn_8gb',  gb: 8,  costAb: 400 },
    { id: 'vpn_10gb', gb: 10, costAb: 500 },
  ]);

  function getVpnPlans() {
    return VPN_PLANS;
  }

  function getVpnPlan(planId) {
    return VPN_PLANS.find(p => p.id === planId) || null;
  }

  /**
   * Create a VPN purchase — MUST be called AFTER the wallet debit has
   * succeeded. The caller (controller) performs the atomic debit first,
   * then calls this to record the purchase.
   *
   * Duplicate protection: rejects if the user already has a PENDING
   * purchase for the same plan (must be fulfilled/cancelled first).
   *
   * @returns {Promise<{purchase, created}>}
   */
  async function createVpnPurchase(env, userId, planId, costAb, txRefId) {
    await ensureSchema(env);
    const uid = String(userId);
    const plan = getVpnPlan(planId);
    if (!plan) throw new Error('INVALID_PLAN');

    // P2-FIX: race-safe creation. The partial unique index
    // uq_rp_pending_plan (user_id, reward_type, vpn_gb) WHERE status='pending'
    // guarantees AT MOST ONE pending purchase per user+plan at the DB level.
    // The INSERT ... ON CONFLICT DO NOTHING atomically:
    //   - succeeds (returns a row) → this request created the purchase
    //   - conflicts (returns 0 rows) → a concurrent request already created
    //     one → read the existing row and return created=false
    // NOTE: plain ON CONFLICT DO NOTHING (no constraint target) is used
    // because it works on both real PostgreSQL (catches the partial index
    // violation) and pg-mem (which doesn't support constraint-name targets
    // with partial indexes). The fallback SELECT handles the PK-conflict
    // edge case identically.
    const result = await queryDb(env,
      `INSERT INTO reward_purchases (user_id, reward_type, vpn_gb, cost_ab, status, tx_ref_id, created_at)
       VALUES ($1, 'vpn', $2, $3, 'pending', $4, NOW())
       ON CONFLICT DO NOTHING
       RETURNING id, user_id, reward_type, vpn_gb, cost_ab, status, created_at`,
      [uid, plan.gb, Number(costAb), String(txRefId || '')],
    );

    if (result.rows.length > 0) {
      return { purchase: result.rows[0], created: true };
    }

    // Conflict — a pending purchase already exists (concurrent or retry).
    // Read it and return created=false so the controller refunds the debit.
    const existing = await queryDb(env,
      `SELECT id, user_id, reward_type, vpn_gb, cost_ab, status, created_at
       FROM reward_purchases
       WHERE user_id = $1 AND reward_type = 'vpn' AND vpn_gb = $2 AND status = 'pending'
       LIMIT 1`,
      [uid, plan.gb],
    );
    return { purchase: existing.rows[0] || null, created: false };
  }

  /**
   * Cancel a purchase (admin action or auto-cancel on debit-refund failure).
   * Only pending purchases can be cancelled.
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
   * Fulfill a purchase (admin action). Records WHO fulfilled it and WHEN.
   * Changing status from 'pending' to 'fulfilled' automatically frees the
   * partial unique index slot (uq_rp_pending_plan) — the user can then
   * purchase the same plan again if needed.
   */
  async function fulfillPurchase(env, purchaseId, adminId) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `UPDATE reward_purchases
       SET status = 'fulfilled', fulfilled_at = NOW(), fulfilled_by = $2, updated_at = NOW()
       WHERE id = $1 AND status = 'pending'
       RETURNING id, user_id, reward_type, vpn_gb, cost_ab, status, fulfilled_at, fulfilled_by`,
      [Number(purchaseId), String(adminId)],
    );
    return result.rows[0] || null;
  }

  /**
   * List purchases for the admin queue. Filterable by status.
   */
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
      `SELECT rp.id, rp.user_id, rp.reward_type, rp.vpn_gb, rp.cost_ab, rp.status,
              rp.tx_ref_id, rp.created_at, rp.fulfilled_at, rp.fulfilled_by,
              u.username, u.first_name, u.last_name
       FROM reward_purchases rp
       LEFT JOIN users u ON u.telegram_id = rp.user_id
       ${where}
       ORDER BY rp.created_at DESC
       LIMIT $${idx++} OFFSET $${idx++}`,
      params);

    return {
      total,
      purchases: result.rows.map(r => ({
        id: Number(r.id),
        user_id: r.user_id,
        username: r.username || null,
        display_name: [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || r.user_id,
        reward_type: r.reward_type,
        vpn_gb: r.vpn_gb ? Number(r.vpn_gb) : null,
        cost_ab: Number(r.cost_ab),
        status: r.status,
        tx_ref_id: r.tx_ref_id,
        created_at: r.created_at,
        fulfilled_at: r.fulfilled_at,
        fulfilled_by: r.fulfilled_by,
      })),
    };
  }

  /**
   * Get a user's own purchases (for the user's purchase history UI).
   */
  async function listUserPurchases(env, userId, limit = 20) {
    await ensureSchema(env);
    const result = await queryDb(env,
      `SELECT id, reward_type, vpn_gb, cost_ab, status, created_at, fulfilled_at
       FROM reward_purchases
       WHERE user_id = $1
       ORDER BY created_at DESC
       LIMIT $2`,
      [String(userId), Number(limit)]);
    return result.rows.map(r => ({
      id: Number(r.id),
      reward_type: r.reward_type,
      vpn_gb: r.vpn_gb ? Number(r.vpn_gb) : null,
      cost_ab: Number(r.cost_ab),
      status: r.status,
      created_at: r.created_at,
      fulfilled_at: r.fulfilled_at,
    }));
  }

  return Object.freeze({
    ensureSchema,
    getVpnPlans,
    getVpnPlan,
    createVpnPurchase,
    cancelPurchase,
    fulfillPurchase,
    listPurchases,
    listUserPurchases,
  });
}

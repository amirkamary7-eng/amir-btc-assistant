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
  const { queryDb, queryDbTransaction, isDatabaseConfigured } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    if (_schemaVerified) return;
    // PROD-DDL-SKIP: tables provisioned by migrations; skip runtime DDL in production.
    if (env && String(env.APP_ENV || '').toLowerCase() === 'production') {
      _schemaVerified = true;
      return;
    }
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
      // Partial unique index: at most ONE pending purchase per user+plan.
      // This is the critical idempotency guard for the VPN purchase flow.
      // If this fails (e.g. pre-existing duplicate pending rows), we MUST NOT
      // mark schema as verified — otherwise the isolate will silently run
      // forever without DB-level race protection (W-STAB-3).
      await queryDb(env, `CREATE UNIQUE INDEX IF NOT EXISTS uq_rp_pending_plan
        ON reward_purchases (user_id, reward_type, vpn_gb)
        WHERE status = 'pending'`);
      // FIN-001: Ensure pending_refunds Outbox table and partial unique index exist
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS pending_refunds (
          id              SERIAL PRIMARY KEY,
          user_id         VARCHAR(64) NOT NULL,
          amount          INTEGER NOT NULL,
          refund_ref_id   VARCHAR(64) NOT NULL,
          original_ref_id VARCHAR(64),
          source          VARCHAR(32) NOT NULL DEFAULT 'vpn',
          description     VARCHAR(256),
          metadata        JSONB DEFAULT '{}',
          status          VARCHAR(16) NOT NULL DEFAULT 'pending',
          retry_count     INTEGER NOT NULL DEFAULT 0,
          last_retry_at   TIMESTAMPTZ,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch(() => {});
      await queryDb(env, `
        CREATE UNIQUE INDEX IF NOT EXISTS idx_pending_refunds_ref_id
          ON pending_refunds (refund_ref_id)
          WHERE status = 'pending'
      `).catch(() => {});
      // W-STAB-3 FIX (mirrors wallet.js M4 fix): only mark schema as verified
      // on SUCCESS. Previously _schemaVerified was set to true in BOTH try and
      // catch blocks — meaning a failed unique-index creation (e.g. due to
      // pre-existing duplicate rows) was permanently swallowed for the
      // isolate's lifetime, silently disabling the DB-level idempotency that
      // the VPN purchase flow depends on. Now: on failure, log loudly and
      // rethrow so the next invocation retries the migration. Call sites use
      // .catch(() => {}) where a schema failure must not block the operation.
      _schemaVerified = true;
    } catch (e) {
      console.error('[reward-purchases] Schema migration FAILED (will retry on next invocation):', e?.message || e);
      throw e;
    }
  }

  // ─── VPN Plan Catalog ───────────────────────────────────────────────────

  // FIX 8: Duration is part of the catalog (backend authoritative).
  // 1-4GB = 1 week (7 days), 6-10GB = 1 month (30 days).
  // PRICING UPDATE (2026-08-24): revised per business request.
  //   vpn_4gb  200 → 300 (+100)
  //   vpn_6gb  300 → 400 (+100)
  //   vpn_8gb  400 → 500 (+100)
  //   vpn_10gb 500 → 600 (+100)
  //   vpn_1gb / vpn_2gb unchanged (200 AB)
  // Frontend (wallet.js) renders cost_ab from /api/rewards/vpn/plans — no
  // hardcoded prices anywhere. This catalog is the SINGLE source of truth.
  const VPN_PLANS = Object.freeze([
    { id: 'vpn_1gb',  gb: 1,  costAb: 200, premiumOnly: false, durationDays: 7,  durationFa: '۱ هفته',  durationEn: '1 week'  },
    { id: 'vpn_2gb',  gb: 2,  costAb: 200, premiumOnly: true,  durationDays: 7,  durationFa: '۱ هفته',  durationEn: '1 week'  },
    { id: 'vpn_4gb',  gb: 4,  costAb: 300, premiumOnly: true,  durationDays: 7,  durationFa: '۱ هفته',  durationEn: '1 week'  },
    { id: 'vpn_6gb',  gb: 6,  costAb: 400, premiumOnly: true,  durationDays: 30, durationFa: '۱ ماه',   durationEn: '1 month' },
    { id: 'vpn_8gb',  gb: 8,  costAb: 500, premiumOnly: true,  durationDays: 30, durationFa: '۱ ماه',   durationEn: '1 month' },
    { id: 'vpn_10gb', gb: 10, costAb: 600, premiumOnly: true,  durationDays: 30, durationFa: '۱ ماه',   durationEn: '1 month' },
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
    await ensureSchema(env).catch(() => {});
    const plan = getVpnPlan(planId);
    if (!plan) return { restricted: false };

    // PERF/E Time correctness: rolling 30-day window from the most recent
    // FULFILLED purchase. The purchase is restricted if there exists a
    // fulfilled purchase whose created_at is within the last 30 days.
    // Exactly at 30 days elapsed, the WHERE clause (> NOW() - 30 days)
    // no longer matches, so the user becomes eligible automatically.
    // 30 days is NOT a calendar month — it is a strict rolling window.
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
    const purchasedAtMs = new Date(row.created_at).getTime();
    const elapsedDays = (Date.now() - purchasedAtMs) / 86400000;
    const daysRemaining = Math.max(0, Math.ceil(30 - elapsedDays));
    // E: precise next-eligible timestamp = purchased_at + 30 days.
    // Frontend can use this for an accurate countdown independent of
    // client clock skew. days_remaining remains a display hint only.
    const nextEligibleAt = new Date(purchasedAtMs + 30 * 86400000).toISOString();
    return {
      restricted: true,
      daysRemaining,
      next_eligible_at: nextEligibleAt,
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
    await ensureSchema(env).catch(() => {});
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
   * FIN-001 FIX: Atomic VPN purchase cancellation + Ledger verification + Refund / Outbox reconciliation.
   *
   * Invariants enforced BOTH in SQL (single CTE data dependency) AND in queryDbTransaction's
   * pre-commit validate(res, results) hook BEFORE COMMIT:
   *   1. Purchase not found -> ROLLBACK before COMMIT, returns { cancelled: false, status: 'not_found', code: 'PURCHASE_NOT_FOUND' }
   *   2. Purchase already fulfilled (or non-pending/non-cancelled) -> ROLLBACK before COMMIT, returns { cancelled: false, status: 'already_fulfilled', code: 'PURCHASE_ALREADY_FULFILLED' }
   *   3. Missing or mismatched debit row in token_transactions -> ROLLBACK before COMMIT, returns { cancelled: false, status: 'ledger_mismatch', code: 'LEDGER_MISMATCH' }
   *   4. Purchase already cancelled:
   *      - If valid refund already completed -> idempotent return (no double refund), reconciles any lingering pending Outbox row
   *      - If legacy cancelled row lacked refund and valid debit exists -> reconciles refund atomically
   *   5. Refund already completed while purchase still pending -> transitions purchase to 'cancelled' without double-crediting balance (idempotent_refund)
   *   6. Duplicate/existing row in Outbox (pending_refunds):
   *      - Verified against purchase user_id and cost_ab (mismatched Outbox row triggers LEDGER_MISMATCH rollback)
   *      - In direct refund mode: atomically marked status = 'completed' so retryFailedRefunds cron never double-credits
   *      - In outboxOnly fallback mode: deduplicated via WHERE NOT EXISTS + ON CONFLICT DO NOTHING
   *   7. Purchase status NEVER transitions to 'cancelled' without a valid completed refund or valid pending Outbox record.
   */
  async function cancelPurchase(env, purchaseId, options = {}) {
    if (typeof queryDbTransaction !== 'function') {
      throw new Error('queryDbTransaction not available');
    }
    await ensureSchema(env).catch(() => {});
    const numericId = Number(purchaseId);
    if (!Number.isInteger(numericId) || numericId <= 0) {
      return {
        cancelled: false,
        status: 'not_found',
        code: 'PURCHASE_NOT_FOUND',
        refunded: false,
        idempotent: false,
      };
    }

    const outboxOnly = Boolean(options && options.outboxOnly);
    const metadataJson = JSON.stringify({
      reason: (options && options.reason) ? String(options.reason) : 'admin_cancelled',
      purchase_id: numericId,
      ...(options && options.adminId ? { actor: String(options.adminId) } : {}),
    });

    const directRefundCteSql = `
      WITH target_rp AS (
        SELECT
          id, user_id, reward_type, plan_id, plan_name, vpn_gb, cost_ab, duration_days,
          status, tracking_id, tx_ref_id,
          CASE
            WHEN tx_ref_id IS NOT NULL AND tx_ref_id <> '' THEN tx_ref_id || '_refund'
            ELSE 'vpn_cancel_refund_' || id::text
          END AS refund_ref_id,
          'Refund: ' || COALESCE(plan_name, 'VPN') || ' cancelled' AS refund_desc
        FROM reward_purchases
        WHERE id = $1
        FOR UPDATE
      ),
      valid_debit AS (
        SELECT tt.id AS debit_tx_id, tt.amount AS debit_amount
        FROM token_transactions tt
        INNER JOIN target_rp rp ON tt.user_id = rp.user_id
        WHERE tt.tx_type = 'vpn_purchase'
          AND rp.tx_ref_id IS NOT NULL
          AND rp.tx_ref_id <> ''
          AND tt.ref_id = rp.tx_ref_id
          AND tt.status = 'completed'
          AND rp.cost_ab > 0
          AND tt.amount = -rp.cost_ab
        LIMIT 1
      ),
      existing_refund AS (
        SELECT tt.id AS refund_tx_id, tt.amount AS refund_amount
        FROM token_transactions tt
        INNER JOIN target_rp rp ON tt.user_id = rp.user_id
        WHERE tt.tx_type = 'marketplace_refund'
          AND tt.ref_id = rp.refund_ref_id
          AND tt.status = 'completed'
        LIMIT 1
      ),
      existing_valid_refund AS (
        SELECT er.refund_tx_id, er.refund_amount
        FROM existing_refund er
        INNER JOIN target_rp rp ON rp.cost_ab > 0 AND er.refund_amount = rp.cost_ab
        LIMIT 1
      ),
      existing_outbox AS (
        SELECT pr.id AS outbox_id, pr.user_id AS outbox_user_id, pr.amount AS outbox_amount
        FROM pending_refunds pr
        INNER JOIN target_rp rp ON (
          pr.refund_ref_id = rp.refund_ref_id
          OR (rp.tx_ref_id IS NOT NULL AND rp.tx_ref_id <> '' AND pr.original_ref_id = rp.tx_ref_id AND pr.source = 'vpn')
        )
        WHERE pr.status = 'pending'
        LIMIT 1
      ),
      existing_valid_outbox AS (
        SELECT eo.outbox_id, eo.outbox_amount
        FROM existing_outbox eo
        INNER JOIN target_rp rp ON eo.outbox_user_id = rp.user_id AND rp.cost_ab > 0 AND eo.outbox_amount = rp.cost_ab
        LIMIT 1
      ),
      refund_insert AS (
        INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at, updated_at)
        SELECT rp.user_id, rp.cost_ab, 'marketplace_refund', 'reward', 'completed', rp.refund_desc, rp.refund_ref_id, $2, NOW(), NOW()
        FROM target_rp rp
        WHERE rp.status IN ('pending', 'cancelled')
          AND EXISTS (SELECT 1 FROM valid_debit)
          AND NOT EXISTS (SELECT 1 FROM existing_refund)
          AND (NOT EXISTS (SELECT 1 FROM existing_outbox) OR EXISTS (SELECT 1 FROM existing_valid_outbox))
        ON CONFLICT DO NOTHING
        RETURNING id, user_id, amount
      ),
      balance_upsert AS (
        INSERT INTO token_balances (user_id, balance, updated_at)
        SELECT ri.user_id, ri.amount, NOW()
        FROM refund_insert ri
        ON CONFLICT (user_id) DO UPDATE
          SET balance = token_balances.balance + EXCLUDED.balance,
              updated_at = NOW()
        RETURNING balance
      ),
      cancelled_rp AS (
        UPDATE reward_purchases
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1
          AND status = 'pending'
          AND EXISTS (SELECT 1 FROM valid_debit)
          AND (NOT EXISTS (SELECT 1 FROM existing_outbox) OR EXISTS (SELECT 1 FROM existing_valid_outbox))
          AND (
            (EXISTS (SELECT 1 FROM refund_insert) AND EXISTS (SELECT 1 FROM balance_upsert))
            OR EXISTS (SELECT 1 FROM existing_valid_refund)
          )
        RETURNING id, status
      ),
      outbox_reconcile AS (
        UPDATE pending_refunds
        SET status = 'completed', last_retry_at = NOW(), updated_at = NOW()
        WHERE (
            refund_ref_id IN (SELECT refund_ref_id FROM target_rp)
            OR (
              original_ref_id IN (SELECT tx_ref_id FROM target_rp WHERE tx_ref_id IS NOT NULL AND tx_ref_id <> '')
              AND source = 'vpn'
            )
          )
          AND status = 'pending'
          AND (NOT EXISTS (SELECT 1 FROM existing_outbox) OR EXISTS (SELECT 1 FROM existing_valid_outbox))
          AND (
            (EXISTS (SELECT 1 FROM refund_insert) AND EXISTS (SELECT 1 FROM balance_upsert))
            OR EXISTS (SELECT 1 FROM existing_valid_refund)
          )
        RETURNING id
      )
      SELECT
        (SELECT id FROM target_rp) AS rp_id,
        (SELECT user_id FROM target_rp) AS user_id,
        (SELECT status FROM target_rp) AS prev_status,
        (SELECT cost_ab FROM target_rp) AS cost_ab,
        (SELECT tx_ref_id FROM target_rp) AS tx_ref_id,
        (SELECT refund_ref_id FROM target_rp) AS refund_ref_id,
        (SELECT debit_tx_id FROM valid_debit) AS debit_tx_id,
        (SELECT refund_tx_id FROM existing_refund) AS existing_refund_tx_id,
        (SELECT refund_tx_id FROM existing_valid_refund) AS existing_valid_refund_tx_id,
        (SELECT outbox_id FROM existing_outbox) AS existing_outbox_id,
        (SELECT outbox_id FROM existing_valid_outbox) AS existing_valid_outbox_id,
        (SELECT id FROM cancelled_rp) AS cancelled_rp_id,
        (SELECT id FROM refund_insert) AS new_refund_tx_id,
        NULL::int AS new_outbox_id,
        (SELECT COUNT(*)::int FROM outbox_reconcile) AS reconciled_outbox_count,
        (SELECT balance FROM balance_upsert LIMIT 1) AS upserted_balance,
        (SELECT tb.balance FROM token_balances tb INNER JOIN target_rp rp ON tb.user_id = rp.user_id LIMIT 1) AS current_balance
    `;

    const outboxFallbackCteSql = `
      WITH target_rp AS (
        SELECT
          id, user_id, reward_type, plan_id, plan_name, vpn_gb, cost_ab, duration_days,
          status, tracking_id, tx_ref_id,
          CASE
            WHEN tx_ref_id IS NOT NULL AND tx_ref_id <> '' THEN tx_ref_id || '_refund'
            ELSE 'vpn_cancel_refund_' || id::text
          END AS refund_ref_id,
          'Refund: ' || COALESCE(plan_name, 'VPN') || ' cancelled' AS refund_desc
        FROM reward_purchases
        WHERE id = $1
        FOR UPDATE
      ),
      valid_debit AS (
        SELECT tt.id AS debit_tx_id, tt.amount AS debit_amount
        FROM token_transactions tt
        INNER JOIN target_rp rp ON tt.user_id = rp.user_id
        WHERE tt.tx_type = 'vpn_purchase'
          AND rp.tx_ref_id IS NOT NULL
          AND rp.tx_ref_id <> ''
          AND tt.ref_id = rp.tx_ref_id
          AND tt.status = 'completed'
          AND rp.cost_ab > 0
          AND tt.amount = -rp.cost_ab
        LIMIT 1
      ),
      existing_refund AS (
        SELECT tt.id AS refund_tx_id, tt.amount AS refund_amount
        FROM token_transactions tt
        INNER JOIN target_rp rp ON tt.user_id = rp.user_id
        WHERE tt.tx_type = 'marketplace_refund'
          AND tt.ref_id = rp.refund_ref_id
          AND tt.status = 'completed'
        LIMIT 1
      ),
      existing_valid_refund AS (
        SELECT er.refund_tx_id, er.refund_amount
        FROM existing_refund er
        INNER JOIN target_rp rp ON rp.cost_ab > 0 AND er.refund_amount = rp.cost_ab
        LIMIT 1
      ),
      existing_outbox AS (
        SELECT pr.id AS outbox_id, pr.user_id AS outbox_user_id, pr.amount AS outbox_amount
        FROM pending_refunds pr
        INNER JOIN target_rp rp ON (
          pr.refund_ref_id = rp.refund_ref_id
          OR (rp.tx_ref_id IS NOT NULL AND rp.tx_ref_id <> '' AND pr.original_ref_id = rp.tx_ref_id AND pr.source = 'vpn')
        )
        WHERE pr.status = 'pending'
        LIMIT 1
      ),
      existing_valid_outbox AS (
        SELECT eo.outbox_id, eo.outbox_amount
        FROM existing_outbox eo
        INNER JOIN target_rp rp ON eo.outbox_user_id = rp.user_id AND rp.cost_ab > 0 AND eo.outbox_amount = rp.cost_ab
        LIMIT 1
      ),
      outbox_insert AS (
        INSERT INTO pending_refunds (user_id, amount, refund_ref_id, original_ref_id, source, description, metadata, status, created_at, updated_at)
        SELECT rp.user_id, rp.cost_ab, rp.refund_ref_id, rp.tx_ref_id, 'vpn', rp.refund_desc, $2, 'pending', NOW(), NOW()
        FROM target_rp rp
        WHERE rp.status IN ('pending', 'cancelled')
          AND EXISTS (SELECT 1 FROM valid_debit)
          AND NOT EXISTS (SELECT 1 FROM existing_refund)
          AND NOT EXISTS (SELECT 1 FROM existing_outbox)
        ON CONFLICT DO NOTHING
        RETURNING id
      ),
      cancelled_rp AS (
        UPDATE reward_purchases
        SET status = 'cancelled', updated_at = NOW()
        WHERE id = $1
          AND status = 'pending'
          AND EXISTS (SELECT 1 FROM valid_debit)
          AND (NOT EXISTS (SELECT 1 FROM existing_outbox) OR EXISTS (SELECT 1 FROM existing_valid_outbox))
          AND (
            EXISTS (SELECT 1 FROM outbox_insert)
            OR EXISTS (SELECT 1 FROM existing_valid_outbox)
            OR EXISTS (SELECT 1 FROM existing_valid_refund)
          )
        RETURNING id, status
      ),
      outbox_reconcile AS (
        UPDATE pending_refunds
        SET status = 'completed', last_retry_at = NOW(), updated_at = NOW()
        WHERE (
            refund_ref_id IN (SELECT refund_ref_id FROM target_rp)
            OR (
              original_ref_id IN (SELECT tx_ref_id FROM target_rp WHERE tx_ref_id IS NOT NULL AND tx_ref_id <> '')
              AND source = 'vpn'
            )
          )
          AND status = 'pending'
          AND EXISTS (SELECT 1 FROM existing_valid_refund)
          AND (NOT EXISTS (SELECT 1 FROM existing_outbox) OR EXISTS (SELECT 1 FROM existing_valid_outbox))
        RETURNING id
      )
      SELECT
        (SELECT id FROM target_rp) AS rp_id,
        (SELECT user_id FROM target_rp) AS user_id,
        (SELECT status FROM target_rp) AS prev_status,
        (SELECT cost_ab FROM target_rp) AS cost_ab,
        (SELECT tx_ref_id FROM target_rp) AS tx_ref_id,
        (SELECT refund_ref_id FROM target_rp) AS refund_ref_id,
        (SELECT debit_tx_id FROM valid_debit) AS debit_tx_id,
        (SELECT refund_tx_id FROM existing_refund) AS existing_refund_tx_id,
        (SELECT refund_tx_id FROM existing_valid_refund) AS existing_valid_refund_tx_id,
        (SELECT outbox_id FROM existing_outbox) AS existing_outbox_id,
        (SELECT outbox_id FROM existing_valid_outbox) AS existing_valid_outbox_id,
        (SELECT id FROM cancelled_rp) AS cancelled_rp_id,
        NULL::int AS new_refund_tx_id,
        (SELECT id FROM outbox_insert) AS new_outbox_id,
        (SELECT COUNT(*)::int FROM outbox_reconcile) AS reconciled_outbox_count,
        NULL::int AS upserted_balance,
        (SELECT tb.balance FROM token_balances tb INNER JOIN target_rp rp ON tb.user_id = rp.user_id LIMIT 1) AS current_balance
    `;

    let results;
    try {
      results = await queryDbTransaction(env, [
        {
          sql: outboxOnly ? outboxFallbackCteSql : directRefundCteSql,
          params: [numericId, metadataJson],
          validate: async (res) => {
            const r = res && res.rows ? res.rows[0] : null;
            if (!r || r.rp_id === null || r.rp_id === undefined) {
              throw Object.assign(new Error('PURCHASE_NOT_FOUND'), {
                code: 'PURCHASE_NOT_FOUND',
              });
            }
            if (r.prev_status !== 'pending' && r.prev_status !== 'cancelled') {
              throw Object.assign(new Error('PURCHASE_ALREADY_FULFILLED'), {
                code: 'PURCHASE_ALREADY_FULFILLED',
                currentStatus: String(r.prev_status),
              });
            }
            if (r.debit_tx_id === null || r.debit_tx_id === undefined) {
              throw Object.assign(
                new Error('Ledger mismatch: original completed vpn_purchase debit transaction is missing or amount does not match cost_ab'),
                { code: 'LEDGER_MISMATCH', reason: 'missing_or_mismatched_debit' },
              );
            }
            if (r.existing_refund_tx_id !== null && r.existing_refund_tx_id !== undefined &&
                (r.existing_valid_refund_tx_id === null || r.existing_valid_refund_tx_id === undefined)) {
              throw Object.assign(
                new Error('Ledger mismatch: existing marketplace_refund amount does not match purchase cost_ab'),
                { code: 'LEDGER_MISMATCH', reason: 'mismatched_existing_refund' },
              );
            }
            if (r.existing_outbox_id !== null && r.existing_outbox_id !== undefined &&
                (r.existing_valid_outbox_id === null || r.existing_valid_outbox_id === undefined)) {
              throw Object.assign(
                new Error('Ledger mismatch: existing pending_refunds Outbox row does not match purchase user_id or cost_ab'),
                { code: 'LEDGER_MISMATCH', reason: 'mismatched_pending_outbox' },
              );
            }

            if (outboxOnly) {
              const hasValidOutboxOrRefund =
                r.new_outbox_id != null ||
                r.existing_valid_outbox_id != null ||
                r.existing_valid_refund_tx_id != null;
              const statusTransitionOk =
                r.prev_status === 'cancelled' || r.cancelled_rp_id != null;
              if (!hasValidOutboxOrRefund || !statusTransitionOk) {
                throw Object.assign(
                  new Error('Refund invariant violation: purchase cannot be cancelled without valid Outbox entry or completed refund'),
                  { code: 'REFUND_INVARIANT_VIOLATION' },
                );
              }
            } else {
              const hasValidRefund =
                (r.new_refund_tx_id != null && r.upserted_balance != null) ||
                r.existing_valid_refund_tx_id != null;
              const statusTransitionOk =
                r.prev_status === 'cancelled' || r.cancelled_rp_id != null;
              if (!hasValidRefund || !statusTransitionOk) {
                throw Object.assign(
                  new Error('Refund invariant violation: purchase cannot be cancelled without valid refund credit'),
                  { code: 'REFUND_INVARIANT_VIOLATION' },
                );
              }
            }
          },
        },
      ]);
    } catch (err) {
      if (err && err.code === 'PURCHASE_NOT_FOUND') {
        return {
          cancelled: false,
          status: 'not_found',
          code: 'PURCHASE_NOT_FOUND',
          refunded: false,
          idempotent: false,
        };
      }
      if (err && err.code === 'PURCHASE_ALREADY_FULFILLED') {
        return {
          cancelled: false,
          status: 'already_fulfilled',
          code: 'PURCHASE_ALREADY_FULFILLED',
          currentStatus: err.currentStatus || 'fulfilled',
          refunded: false,
          idempotent: false,
        };
      }
      if (err && err.code === 'LEDGER_MISMATCH') {
        return {
          cancelled: false,
          status: 'ledger_mismatch',
          code: 'LEDGER_MISMATCH',
          reason: err.reason || 'debit_ledger_mismatch',
          message: err.message,
          refunded: false,
          idempotent: false,
        };
      }
      throw err;
    }

    const r = results[0].rows[0];
    const wasAlreadyCancelled = r.prev_status === 'cancelled';
    const refundWasAlreadyCompleted = r.existing_valid_refund_tx_id != null && r.new_refund_tx_id == null;
    const outboxWasAlreadyQueued = Boolean(outboxOnly && r.existing_valid_outbox_id != null && r.new_outbox_id == null);
    const idempotent =
      (wasAlreadyCancelled && refundWasAlreadyCompleted) ||
      (!wasAlreadyCancelled && refundWasAlreadyCompleted) ||
      (wasAlreadyCancelled && outboxWasAlreadyQueued);

    let status = 'cancelled';
    let code = 'CANCELLED_AND_REFUNDED';
    if (wasAlreadyCancelled && refundWasAlreadyCompleted) {
      status = 'already_cancelled';
      code = 'ALREADY_CANCELLED';
    } else if (wasAlreadyCancelled && r.new_refund_tx_id != null) {
      status = 'cancelled';
      code = 'REFUND_RECONCILED';
    } else if (!wasAlreadyCancelled && refundWasAlreadyCompleted) {
      status = 'cancelled';
      code = 'IDEMPOTENT_REFUND';
    } else if (outboxOnly) {
      status = wasAlreadyCancelled ? 'already_cancelled' : 'cancelled';
      code = outboxWasAlreadyQueued ? 'OUTBOX_ALREADY_QUEUED' : 'CANCELLED_OUTBOX_QUEUED';
    }

    return {
      cancelled: true,
      status,
      code,
      refunded: Boolean(r.new_refund_tx_id != null || r.existing_valid_refund_tx_id != null),
      outboxQueued: Boolean(r.new_outbox_id != null || r.existing_valid_outbox_id != null),
      reconciledOutboxCount: Number(r.reconciled_outbox_count || 0),
      idempotent,
      purchaseId: Number(r.rp_id),
      userId: String(r.user_id),
      costAb: Number(r.cost_ab),
      txRefId: r.tx_ref_id || null,
      refundRefId: r.refund_ref_id || null,
      debitTxId: Number(r.debit_tx_id),
      txId: r.new_refund_tx_id != null
        ? Number(r.new_refund_tx_id)
        : (r.existing_valid_refund_tx_id != null ? Number(r.existing_valid_refund_tx_id) : null),
      outboxId: r.new_outbox_id != null
        ? Number(r.new_outbox_id)
        : (r.existing_valid_outbox_id != null ? Number(r.existing_valid_outbox_id) : null),
      newBalance: r.upserted_balance != null
        ? Number(r.upserted_balance)
        : (r.current_balance != null ? Number(r.current_balance) : null),
    };
  }

  /**
   * FIX 3+11: Fulfill a purchase with a VPN link.
   * Records WHO fulfilled it, WHEN, and the VPN link.
   * Only pending → fulfilled (state machine, no double-fulfillment).
   */
  async function fulfillPurchase(env, purchaseId, adminId, vpnLink) {
    await ensureSchema(env).catch(() => {});
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
    await ensureSchema(env).catch(() => {});
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
    await ensureSchema(env).catch(() => {});
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
    await ensureSchema(env).catch(() => {});
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
    fulfillPurchase,
    getPurchaseById,
    listPurchases,
    listUserPurchases,
  });
}

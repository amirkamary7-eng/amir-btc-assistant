/**
 * User Repository — Data Access Layer
 *
 * Responsible ONLY for database operations related to user profiles.
 * No HTTP concerns, no business logic — just SQL queries and row serialization.
 *
 * Dependencies are injected via the factory function to avoid circular imports.
 */
export function createUserRepository(deps) {
  const { queryDb, queryDbTransaction, normalizeOptionalString } = deps;

  let _tableEnsured = false;
  let _ensureTablePromise = null;
  // PHASE 1 SAFE OPTIMIZATION: Module-level flag for deleted_users table.
  // Previously checkReferralCooldown ran CREATE TABLE IF NOT EXISTS on EVERY
  // bootstrap with a valid referrer. Now it runs only once per isolate (matching
  // the pattern of _tableEnsured above). The DDL is idempotent so there's no
  // correctness issue — just a wasted DB round-trip eliminated.
  let _deletedUsersTableEnsured = false;

  /**
   * Ensure the users table has all required columns (idempotent).
   * Called once at module init. Adds new tracking columns if missing.
   *
   * Phase 5 optimization: Merged 9 sequential DDL round-trips into a single
   * multi-statement queryDb call (same pattern as admin.js batchSql).
   * Uses a Promise singleton to prevent concurrent cold-isolate initialization
   * from piling up — all concurrent callers await the same in-flight promise.
   * On failure, the promise is cleared so the next request can retry.
   */
  async function ensureTable(env) {
    if (_tableEnsured) return;
    // PROD-DDL-SKIP: tables provisioned by migrations; skip runtime DDL in production.
    if (env && String(env.APP_ENV || '').toLowerCase() === 'production') {
      _tableEnsured = true;
      return;
    }
    // Phase 5: Promise singleton — concurrent callers await the same initialization.
    // On failure, _ensureTablePromise is cleared so the next request can retry.
    if (!_ensureTablePromise) {
      _ensureTablePromise = (async () => {
        try {
          // Single multi-statement DDL call (9 statements merged into 1 round-trip).
          // All statements are idempotent (IF NOT EXISTS). Each ALTER/CREATE has
          // its own catch in the original code — here we rely on IF NOT EXISTS
          // for idempotency. If any statement fails, the whole batch fails and
          // _ensureTablePromise is cleared for retry.
          await queryDb(env, `
            CREATE TABLE IF NOT EXISTS users (
              telegram_id VARCHAR(64) PRIMARY KEY,
              username VARCHAR(128),
              first_name VARCHAR(128),
              last_name VARCHAR(128),
              lang VARCHAR(8) DEFAULT 'fa',
              channel_joined BOOLEAN DEFAULT FALSE,
              channel_verified_at TIMESTAMPTZ,
              created_at TIMESTAMPTZ DEFAULT NOW(),
              updated_at TIMESTAMPTZ DEFAULT NOW()
            );
            ALTER TABLE users ADD COLUMN IF NOT EXISTS last_active_at TIMESTAMPTZ;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS bot_joined_at TIMESTAMPTZ;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS mini_app_opened_at TIMESTAMPTZ;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS is_premium BOOLEAN DEFAULT FALSE;
            ALTER TABLE users ADD COLUMN IF NOT EXISTS beta_popup_seen BOOLEAN NOT NULL DEFAULT FALSE;
            CREATE INDEX IF NOT EXISTS idx_users_last_active ON users (last_active_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_created_at ON users (created_at DESC);
            CREATE INDEX IF NOT EXISTS idx_users_channel_joined ON users (channel_joined) WHERE channel_joined = TRUE;
          `);
          _tableEnsured = true;
        } catch (e) {
          // Clear the promise so the next request can retry.
          _ensureTablePromise = null;
          console.warn('ensureTable users:', e?.message);
        }
      })();
    }
    return _ensureTablePromise;
  }

  /**
   * Normalize a language code to 'fa' or 'en'.
   */
  function normalizeLanguage(value, fallbackValue = 'fa') {
    const normalized = normalizeOptionalString(value);
    if (normalized === 'fa' || normalized === 'en') {
      return normalized;
    }
    return fallbackValue === 'en' ? 'en' : 'fa';
  }

  /**
   * Serialize a raw DB user row into the API response shape.
   * Includes the new tracking columns (last_active_at, bot_joined_at, etc.)
   */
  function normalizeRow(row, watchlist = []) {
    return {
      user_id: String(row.telegram_id),
      username: normalizeOptionalString(row.username),
      first_name: normalizeOptionalString(row.first_name),
      last_name: normalizeOptionalString(row.last_name),
      lang: normalizeLanguage(row.lang),
      channel_joined: Boolean(row.channel_joined),
      channel_verified_at: row.channel_verified_at ? new Date(row.channel_verified_at).toISOString() : null,
      created_at: row.created_at ? new Date(row.created_at).toISOString() : null,
      updated_at: row.updated_at ? new Date(row.updated_at).toISOString() : null,
      last_active_at: row.last_active_at ? new Date(row.last_active_at).toISOString() : null,
      bot_joined_at: row.bot_joined_at ? new Date(row.bot_joined_at).toISOString() : null,
      mini_app_opened_at: row.mini_app_opened_at ? new Date(row.mini_app_opened_at).toISOString() : null,
      is_premium: Boolean(row.is_premium),
      beta_popup_seen: Boolean(row.beta_popup_seen),
      watchlist,
    };
  }

  /**
   * Get a raw user row by telegram_id.
   */
  async function getById(env, userId) {
    const result = await queryDb(
      env,
      `
        SELECT
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at,
          last_active_at,
          bot_joined_at,
          mini_app_opened_at,
          is_premium
        FROM users
        WHERE telegram_id = $1
        LIMIT 1
      `,
      [String(userId)],
    );
    return result.rows[0] || null;
  }

  /**
   * Upsert a user profile (bootstrap). Preserves existing channel_joined status.
   * ROOT CAUSE FIX: Now tracks last_active_at on every bootstrap (Mini App open)
   * and sets mini_app_opened_at on first Mini App open.
   */
  async function bootstrap(env, userId, payload, existingUser = null) {
    // If existingUser is not provided, fetch it (backward compatible).
    // When the controller already has it from a prior getById() call,
    // passing it here avoids a duplicate DB query.
    if (!existingUser) {
      existingUser = await getById(env, userId);
    }
    const fallbackLang = existingUser?.lang || 'fa';
    const lang = normalizeLanguage(payload.lang, fallbackLang);
    const isPremium = Boolean(payload.is_premium);
    const result = await queryDb(
      env,
      `
        INSERT INTO users (
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          is_premium,
          bot_joined_at,
          mini_app_opened_at,
          last_active_at,
          created_at,
          updated_at
        )
        VALUES ($1, $2, $3, $4, $5, COALESCE($6, FALSE), $7, $8, NOW(), NOW(), NOW(), NOW(), NOW())
        ON CONFLICT (telegram_id) DO UPDATE
        SET
          username = COALESCE(EXCLUDED.username, users.username),
          first_name = COALESCE(EXCLUDED.first_name, users.first_name),
          last_name = COALESCE(EXCLUDED.last_name, users.last_name),
          -- BILINGUAL PERSISTENCE FIX: preserve the EXISTING DB lang over the
          -- request's lang. This prevents a fresh device (whose localStorage
          -- defaults to 'fa') from overwriting a user's stored 'en' preference
          -- in the DB on multi-device use. The explicit language switch path
          -- (PUT /api/users/me/settings) unconditionally updates lang, which
          -- is the correct channel for changing the user's language choice.
          lang = COALESCE(users.lang, EXCLUDED.lang),
          is_premium = COALESCE(EXCLUDED.is_premium, users.is_premium),
          last_active_at = NOW(),
          mini_app_opened_at = COALESCE(users.mini_app_opened_at, NOW()),
          updated_at = NOW()
        RETURNING
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at,
          last_active_at,
          bot_joined_at,
          mini_app_opened_at,
          is_premium,
          beta_popup_seen
      `,
      [
        String(userId),
        normalizeOptionalString(payload.username),
        normalizeOptionalString(payload.first_name),
        normalizeOptionalString(payload.last_name),
        lang,
        existingUser ? Boolean(existingUser.channel_joined) : false,
        existingUser?.channel_verified_at ? new Date(existingUser.channel_verified_at).toISOString() : null,
        isPremium,
      ],
    );
    return result.rows[0] || null;
  }

  /**
   * Update user settings (language and beta_popup_seen).
   */
  async function updateSettings(env, userId, payload) {
    const lang = normalizeLanguage(payload.lang);
    const betaPopupSeen = payload.beta_popup_seen === true || payload.beta_popup_seen === 'true';
    const result = await queryDb(
      env,
      `
        UPDATE users
        SET
          lang = $2,
          beta_popup_seen = CASE WHEN $3 THEN TRUE ELSE beta_popup_seen END,
          updated_at = NOW()
        WHERE telegram_id = $1
        RETURNING
          telegram_id,
          username,
          first_name,
          last_name,
          lang,
          channel_joined,
          channel_verified_at,
          created_at,
          updated_at,
          last_active_at,
          bot_joined_at,
          mini_app_opened_at,
          is_premium,
          beta_popup_seen
      `,
      [String(userId), lang, betaPopupSeen],
    );
    return result.rows[0] || null;
  }

  /**
   * ── ROOT-CAUSE FIX: Delete Account with full cascade ──
   *
   * Permanently deletes a user and ALL their associated data across every
   * table in the database. This is required so that:
   *   1. Users can exercise their right to erasure (GDPR / privacy).
   *   2. A user who deletes their account can re-register via a referral link
   *      and have the referral registered (the old referral row must be gone
   *      so the "first inviter wins" check doesn't block the new referral).
   *
   * ANTI-ABUSE: Before deleting, records the user in a `deleted_users`
   * cooldown table with a 15-day cooldown. If the same Telegram ID re-registers
   * within 15 days, they CAN use the app but CANNOT generate a new referral
   * reward. This prevents abuse where a user deletes + re-registers repeatedly
   * to farm referral rewards for themselves.
   *
   * OPTION B ANTI-FARMING (P0 REMEDIATION NEW-DB-01):
   * Quota and reward state (wheel_spins, wheel_history, mission_progress,
   * alert_quota) are intentionally NOT deleted. These tables do NOT have
   * foreign keys to users. Retaining them prevents an attacker from cycling
   * account deletion to reset daily free wheel spins or replay completed
   * daily missions for infinite token farming.
   *
   * Cascade order (child → parent to avoid FK violations):
   *   1. referrals (as invitee AND as inviter)
   *   2. token_transactions
   *   3. token_balances
   *   4. pending_refunds
   *   5. watchlist_items
   *   6. promo_campaign_registrations
   *   7. price_alerts
   *   8. notifications
   *  8b. notification_queue (no FK to users — manual cleanup, SETTINGS-002)
   *   9. notification_settings
   *  10. daily_checkin_streaks
   *  11. calendar_reminders
   *  12. ticket_replies (child of tickets)
   *  13. tickets
   *  14. admins
   *  15. users (the root row)
   *
   * Each DELETE is wrapped in its own try/catch so that a missing table or
   * transient error doesn't abort the cascade — the user row is still deleted.
   *
   * @returns {Object} summary of what was deleted (for debug logging)
   */
  
/**
 * P0 NEW-DB-01: Scrub PII from a token_transactions row for financial archiving.
 * Masks raw Telegram IDs in ref_id and description, and strips PII keys from metadata.
 */
/**
 * P0 NEW-DB-01: Scrub PII from a token_transactions row for financial archiving.
 * Deep recursive scrubbing for nested JSON objects/arrays, ref_id, description, and metadata.
 */

function jsonMetadataEquals(meta1, meta2) {
  try {
    const o1 = typeof meta1 === "string" ? JSON.parse(meta1) : (meta1 || {});
    const o2 = typeof meta2 === "string" ? JSON.parse(meta2) : (meta2 || {});
    return JSON.stringify(o1, Object.keys(o1).sort()) === JSON.stringify(o2, Object.keys(o2).sort());
  } catch {
    return String(meta1 || "") === String(meta2 || "");
  }
}

function scrubTransactionForArchive(tx, tombstoneId) {
  const piiKeys = new Set(["invitee_id", "inviter_id", "telegram_id", "user_id", "username", "first_name", "last_name", "telegramid", "userid"]);

  function deepScrub(val) {
    if (val === null || val === undefined) return val;
    if (typeof val === "string") {
      return val.replace(/(?<=^|[^0-9])\d{5,15}(?=[^0-9]|$)/g, "ANON");
    }
    if (typeof val === "number") {
      if (val >= 10000 && val <= 99999999995) return "ANON";
      return val;
    }
    if (Array.isArray(val)) {
      return val.map(item => deepScrub(item));
    }
    if (typeof val === "object") {
      const scrubbed = {};
      for (const [k, v] of Object.entries(val)) {
        if (piiKeys.has(k.toLowerCase())) continue;
        scrubbed[k] = deepScrub(v);
      }
      return scrubbed;
    }
    return val;
  }

  const scrubbedRef = tx.ref_id ? String(tx.ref_id).replace(/(?<=^|[^0-9])\d{5,15}(?=[^0-9]|$)/g, "ANON") : null;
  const scrubbedDesc = tx.description ? String(tx.description).replace(/(?<=^|[^0-9])\d{5,15}(?=[^0-9]|$)/g, "[SCRUBBED]") : null;

  let scrubbedMeta = {};
  if (tx.metadata) {
    try {
      const raw = typeof tx.metadata === "string" ? JSON.parse(tx.metadata) : tx.metadata;
      scrubbedMeta = deepScrub(raw);
    } catch {
      scrubbedMeta = {};
    }
  }

  return {
    original_tx_id: Number(tx.id),
    account_tombstone_id: String(tombstoneId),
    amount: Number(tx.amount),
    tx_type: String(tx.tx_type || "unknown"),
    source: String(tx.source || "system"),
    status: String(tx.status || "completed"),
    description: scrubbedDesc,
    ref_id: scrubbedRef,
    metadata: JSON.stringify(scrubbedMeta),
    original_created_at: tx.created_at || new Date().toISOString()
  };
}

  async function deleteAccount(env, userId) {
    const uid = String(userId);
    const summary = { userId: uid, tables: {}, errors: [] };

    const { createHmac, randomUUID } = await import("node:crypto");

    // ── H3 FIX: Validate REFERRAL_SECRET_SALT configuration ──
    const salt = env?.REFERRAL_SECRET_SALT;
    const isProd = String(env?.APP_ENV || "").toLowerCase() === "production";
    if (isProd && (!salt || salt === "amir-btc-referral-secret-default-salt")) {
      console.error("[DELETE-ACCOUNT] Fail-Closed: REFERRAL_SECRET_SALT is not configured in production");
      throw new Error("REFERRAL_SECRET_SALT must be securely configured in production environment");
    }
    const activeSalt = salt || "amir-btc-referral-secret-default-salt";

    // Ensure auxiliary tables exist in non-production environments before opening transaction
    if (!isProd) {
      try {
        await queryDb(env, `
          CREATE TABLE IF NOT EXISTS deleted_users (
            id SERIAL PRIMARY KEY,
            telegram_id VARCHAR(64) NOT NULL UNIQUE,
            previous_inviter_id VARCHAR(64),
            deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
            cooldown_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days')
          )
        `);
        await queryDb(env, `
          CREATE UNIQUE INDEX IF NOT EXISTS idx_deleted_users_telegram_id_uniq ON deleted_users (telegram_id)
        `);
        await queryDb(env, `
          CREATE TABLE IF NOT EXISTS token_transactions_archive (
            id BIGSERIAL PRIMARY KEY,
            original_tx_id INTEGER NOT NULL UNIQUE,
            account_tombstone_id TEXT NOT NULL,
            amount INTEGER NOT NULL,
            tx_type VARCHAR(32) NOT NULL,
            source VARCHAR(32) NOT NULL DEFAULT 'system',
            status VARCHAR(16) NOT NULL DEFAULT 'completed',
            description VARCHAR(256),
            ref_id VARCHAR(128),
            metadata JSONB DEFAULT '{}',
            original_created_at TIMESTAMPTZ NOT NULL,
            archived_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `);
        await queryDb(env, `
          CREATE TABLE IF NOT EXISTS claimed_referral_pairs (
            pair_hash VARCHAR(64) PRIMARY KEY,
            claim_type VARCHAR(32) NOT NULL DEFAULT 'pair',
            created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
          )
        `).catch(() => {});
      } catch (e) {
        console.warn("[DELETE-ACCOUNT] Table ensure failed (non-fatal):", e?.message);
      }
    }

    const tombstoneId = randomUUID();
    summary.tombstoneId = tombstoneId;

    // ── PHASE 5P: Single Interactive Atomic Transaction ──
    // Lock order: 1. users -> 2. token_balances -> 3. pending_refunds -> 4. token_transactions
    try {
      await queryDbTransaction(env, async (txQuery) => {
        // 1. Lock user row (Lock Order #1)
        const userLockRes = await txQuery(
          "SELECT telegram_id FROM users WHERE telegram_id = $1 FOR UPDATE",
          [uid]
        );
        if (!userLockRes.rows || userLockRes.rows.length === 0) {
          const alreadyDeletedRes = await txQuery(
            "SELECT telegram_id FROM deleted_users WHERE telegram_id = $1 LIMIT 1",
            [uid]
          );
          if (alreadyDeletedRes.rows && alreadyDeletedRes.rows.length > 0) {
            summary.alreadyDeleted = true;
            summary.cooldownRecorded = true;
            summary.openPendingRefunds = 0;
            summary.burnedBalance = 0;
            summary.archivedCount = 0;
            return;
          }
        }

        // 2. Lock wallet balance row (Lock Order #2)
        await txQuery(
          "SELECT balance FROM token_balances WHERE user_id = $1 FOR UPDATE",
          [uid]
        );

        // 3. Lock unresolved pending_refunds rows (Lock Order #3)
        const pendingRefundsRes = await txQuery(
          "SELECT id, user_id, amount, refund_ref_id, status, source, description, metadata FROM pending_refunds WHERE user_id = $1 AND status IN ('pending', 'processing') ORDER BY id ASC FOR UPDATE",
          [uid]
        );
        const pendingRows = pendingRefundsRes.rows || [];
        summary.openPendingRefunds = pendingRows.length;

        // 4. Settle each pending refund using canonical refund_ref_id
        for (const pref of pendingRows) {
          const refAmount = Number(pref.amount || 0);
          const canonicalRefId = String(pref.refund_ref_id || "").trim();
          if (!canonicalRefId || refAmount <= 0) {
            throw new Error(`Invalid pending refund record id=${pref.id}: missing canonical refund_ref_id or non-positive amount`);
          }

          const validateExistingRefundTx = (exTx) => {
            if (
              String(exTx.user_id) !== uid ||
              Number(exTx.amount) !== refAmount ||
              String(exTx.tx_type) !== "marketplace_refund" ||
              String(exTx.status || "completed") !== "completed"
            ) {
              throw new Error(
                `Refund ref_id conflict mismatch for ${canonicalRefId}: expected user=${uid} amount=${refAmount} type=marketplace_refund, got user=${exTx.user_id} amount=${exTx.amount} type=${exTx.tx_type} status=${exTx.status}`
              );
            }
          };

          // Check for any existing transactions with the canonical ref_id before crediting (Lock Order #4 — no LIMIT 1)
          const existingTxRes = await txQuery(
            "SELECT id, user_id, amount, tx_type, status FROM token_transactions WHERE ref_id = $1 FOR UPDATE",
            [canonicalRefId]
          );
          if (existingTxRes.rows && existingTxRes.rows.length > 0) {
            for (const exTx of existingTxRes.rows) {
              validateExistingRefundTx(exTx);
            }
            if (existingTxRes.rows.length > 1) {
              throw new Error(`Refund ref_id conflict mismatch for ${canonicalRefId}: multiple transactions found`);
            }
            const balCheckRes = await txQuery(
              "SELECT balance FROM token_balances WHERE user_id = $1",
              [uid]
            );
            if (!balCheckRes.rows || balCheckRes.rows.length === 0) {
              throw new Error(`Refund transaction ${canonicalRefId} exists without token_balances row for user ${uid}`);
            }
            // Valid idempotent match already exists in token_transactions and token_balances; do not double-credit
          } else {
            const refundDesc = pref.description || "Account deletion auto-settled refund";
            const refundMeta = typeof pref.metadata === "string"
              ? pref.metadata
              : JSON.stringify(pref.metadata || {});
            const insTxRes = await txQuery(
              `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at)
               VALUES ($1, $2, 'marketplace_refund', 'marketplace', 'completed', $3, $4, $5, NOW())
               ON CONFLICT DO NOTHING
               RETURNING id`,
              [uid, refAmount, refundDesc, canonicalRefId, refundMeta]
            );
            if (insTxRes.rows && insTxRes.rows.length === 1) {
              const postInsTxRes = await txQuery(
                "SELECT id, user_id, amount, tx_type, status FROM token_transactions WHERE ref_id = $1 FOR UPDATE",
                [canonicalRefId]
              );
              for (const pTx of (postInsTxRes.rows || [])) {
                validateExistingRefundTx(pTx);
              }
              if (!postInsTxRes.rows || postInsTxRes.rows.length !== 1) {
                throw new Error(`Refund ref_id conflict mismatch for ${canonicalRefId}: concurrent conflicting row detected`);
              }
              const balUpdRes = await txQuery(
                `INSERT INTO token_balances (user_id, balance, updated_at)
                 VALUES ($1, $2, NOW())
                 ON CONFLICT (user_id) DO UPDATE
                 SET balance = token_balances.balance + EXCLUDED.balance, updated_at = NOW()
                 RETURNING balance`,
                [uid, refAmount]
              );
              if (!balUpdRes.rows || balUpdRes.rows.length !== 1) {
                throw new Error(`Failed to credit wallet balance for refund ${canonicalRefId}`);
              }
            } else {
              // Concurrent insert occurred between SELECT and INSERT; verify all rows matching canonicalRefId
              const raceTxRes = await txQuery(
                "SELECT id, user_id, amount, tx_type, status FROM token_transactions WHERE ref_id = $1 FOR UPDATE",
                [canonicalRefId]
              );
              if (!raceTxRes.rows || raceTxRes.rows.length === 0) {
                throw new Error(`Failed to insert refund transaction for canonical ref_id ${canonicalRefId}`);
              }
              for (const rTx of raceTxRes.rows) {
                validateExistingRefundTx(rTx);
              }
              if (raceTxRes.rows.length > 1) {
                throw new Error(`Refund ref_id conflict mismatch for ${canonicalRefId}: multiple transactions found`);
              }
              const raceBalRes = await txQuery(
                "SELECT balance FROM token_balances WHERE user_id = $1",
                [uid]
              );
              if (!raceBalRes.rows || raceBalRes.rows.length === 0) {
                throw new Error(`Refund transaction ${canonicalRefId} exists without token_balances row for user ${uid}`);
              }
            }
          }

          const settleRes = await txQuery(
            "UPDATE pending_refunds SET status = 'settled', updated_at = NOW() WHERE id = $1 AND status IN ('pending', 'processing') RETURNING id",
            [pref.id]
          );
          if (!settleRes.rows || settleRes.rows.length !== 1) {
            throw new Error(`Failed to mark pending_refund id=${pref.id} as settled`);
          }
        }

        // 5. Compute and execute token burn from actual post-settlement wallet balance
        const postRefundBalRes = await txQuery(
          "SELECT balance FROM token_balances WHERE user_id = $1 FOR UPDATE",
          [uid]
        );
        const balanceToBurn = Number(postRefundBalRes.rows?.[0]?.balance || 0);
        if (balanceToBurn < 0) {
          throw new Error(`Invalid negative wallet balance (${balanceToBurn}) during account deletion for user ${uid}`);
        }
        summary.burnedBalance = balanceToBurn;

        if (balanceToBurn > 0) {
          const burnRefId = `burn_${uid}_${tombstoneId}`;
          const burnInsRes = await txQuery(
            `INSERT INTO token_transactions (user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at)
             VALUES ($1, $2, 'account_deletion_burn', 'system', 'completed', 'Account deletion token burn', $3, '{}', NOW())
             RETURNING id`,
            [uid, -balanceToBurn, burnRefId]
          );
          if (!burnInsRes.rows || burnInsRes.rows.length !== 1) {
            throw new Error(`Failed to insert account_deletion_burn transaction for user ${uid}`);
          }
          const zeroBalRes = await txQuery(
            "UPDATE token_balances SET balance = 0, updated_at = NOW() WHERE user_id = $1 RETURNING balance",
            [uid]
          );
          if (!zeroBalRes.rows || zeroBalRes.rows.length !== 1 || Number(zeroBalRes.rows[0].balance) !== 0) {
            throw new Error(`Failed to zero wallet balance during burn for user ${uid}`);
          }
        }

        // 6. Build archive directly from actual token_transactions rows (with real PostgreSQL SERIAL IDs)
        const txsResult = await txQuery(
          "SELECT id, user_id, amount, tx_type, source, status, description, ref_id, metadata, created_at FROM token_transactions WHERE user_id = $1 ORDER BY id ASC FOR UPDATE",
          [uid]
        );
        const rawTxs = txsResult.rows || [];
        const scrubbedRows = rawTxs.map(tx => scrubTransactionForArchive(tx, tombstoneId));

        for (const s of scrubbedRows) {
          if (!Number.isInteger(s.original_tx_id) || s.original_tx_id <= 0) {
            throw new Error(`Invalid original_tx_id (${s.original_tx_id}) for archive`);
          }
          await txQuery(
            `INSERT INTO token_transactions_archive
             (original_tx_id, account_tombstone_id, amount, tx_type, source, status, description, ref_id, metadata, original_created_at, archived_at)
             VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, NOW())
             ON CONFLICT (original_tx_id) DO NOTHING`,
            [
              s.original_tx_id, s.account_tombstone_id, s.amount, s.tx_type, s.source,
              s.status, s.description, s.ref_id, s.metadata, s.original_created_at
            ]
          );
        }

        // 7. Pre-delete Archive Completeness & 8-Field Verification (MUST pass before DELETE FROM token_transactions)
        const missingArchRes = await txQuery(
          `SELECT s.id AS missing_id
           FROM token_transactions s
           LEFT JOIN token_transactions_archive a ON a.original_tx_id = s.id
           WHERE s.user_id = $1 AND a.original_tx_id IS NULL`,
          [uid]
        );
        if (missingArchRes.rows && missingArchRes.rows.length > 0) {
          throw new Error(
            `Archive verification failed: missing archive record(s) for original_tx_id=${missingArchRes.rows.map(r => r.missing_id).join(",")}`
          );
        }

        const extraArchRes = await txQuery(
          `SELECT a.original_tx_id AS extra_id
           FROM token_transactions_archive a
           LEFT JOIN token_transactions s ON s.id = a.original_tx_id AND s.user_id = $1
           WHERE a.account_tombstone_id = $2 AND s.id IS NULL`,
          [uid, tombstoneId]
        );
        if (extraArchRes.rows && extraArchRes.rows.length > 0) {
          throw new Error(
            `Archive verification failed: extra archive record(s) found for tombstone=${tombstoneId} original_tx_id=${extraArchRes.rows.map(r => r.extra_id).join(",")}`
          );
        }

        const dupArchRes = await txQuery(
          `SELECT a1.original_tx_id
           FROM token_transactions_archive a1
           INNER JOIN token_transactions_archive a2
             ON a1.original_tx_id = a2.original_tx_id AND a1.id <> a2.id
           INNER JOIN token_transactions s ON s.id = a1.original_tx_id
           WHERE s.user_id = $1`,
          [uid]
        );
        if (dupArchRes.rows && dupArchRes.rows.length > 0) {
          throw new Error(
            `Archive verification failed: duplicate archive record(s) for original_tx_id=${dupArchRes.rows.map(r => r.original_tx_id).join(",")}`
          );
        }

        if (scrubbedRows.length > 0) {
          const countVerifyRes = await txQuery(
            `SELECT COUNT(*)::int AS cnt
             FROM token_transactions_archive a
             INNER JOIN token_transactions s ON s.id = a.original_tx_id
             WHERE s.user_id = $1`,
            [uid]
          );
          const matchedCnt = Number(countVerifyRes.rows?.[0]?.cnt || 0);
          if (matchedCnt !== scrubbedRows.length) {
            throw new Error(
              `Archive verification failed: expected ${scrubbedRows.length} archived rows, found ${matchedCnt}`
            );
          }
        }

        for (const s of scrubbedRows) {
          const fieldMismatchRes = await txQuery(
            `SELECT a.original_tx_id
             FROM token_transactions_archive a
             INNER JOIN token_transactions src ON src.id = a.original_tx_id AND src.user_id = $1
             WHERE a.original_tx_id = $2
               AND (
                 a.amount IS DISTINCT FROM $3
                 OR a.tx_type IS DISTINCT FROM $4
                 OR a.source IS DISTINCT FROM $5
                 OR a.status IS DISTINCT FROM $6
                 OR a.description IS DISTINCT FROM $7
                 OR a.ref_id IS DISTINCT FROM $8
                 OR a.metadata::jsonb IS DISTINCT FROM $9::jsonb
                 OR a.original_created_at IS DISTINCT FROM src.created_at
               )`,
            [
              uid,
              s.original_tx_id,
              s.amount,
              s.tx_type,
              s.source,
              s.status,
              s.description,
              s.ref_id,
              s.metadata
            ]
          );
          if (fieldMismatchRes.rows && fieldMismatchRes.rows.length > 0) {
            throw new Error(`Archive duplicate content mismatch across fields for original_tx_id ${s.original_tx_id}`);
          }
        }

        summary.archivedCount = scrubbedRows.length;

        // 8. Permanent Anti-Fraud Referral Pair Records
        const existingRef = await txQuery(
          "SELECT inviter_id, rewarded FROM referrals WHERE invitee_id = $1 LIMIT 1",
          [uid]
        );
        const previousInviterId = existingRef.rows?.[0]?.inviter_id || null;
        if (previousInviterId) {
          const pairHash = createHmac("sha256", activeSalt).update(`${previousInviterId}:${uid}`).digest("hex");
          const inviteeHash = createHmac("sha256", activeSalt).update(`INVITEE:${uid}`).digest("hex");
          await txQuery(
            "INSERT INTO claimed_referral_pairs (pair_hash, claim_type) VALUES ($1, 'pair') ON CONFLICT (pair_hash) DO NOTHING",
            [pairHash]
          );
          await txQuery(
            "INSERT INTO claimed_referral_pairs (pair_hash, claim_type) VALUES ($1, 'invitee') ON CONFLICT (pair_hash) DO NOTHING",
            [inviteeHash]
          );
          summary.permanentReferralLockRecorded = true;
        }

        // 9. deleted_users cooldown record
        await txQuery(
          `INSERT INTO deleted_users (telegram_id, previous_inviter_id, deleted_at, cooldown_until)
           VALUES ($1, $2, NOW(), NOW() + INTERVAL '15 days')
           ON CONFLICT (telegram_id) DO UPDATE
           SET deleted_at = NOW(), cooldown_until = NOW() + INTERVAL '15 days'`,
          [uid, previousInviterId]
        );
        summary.cooldownRecorded = true;

        // 10. Cascade DELETEs (ONLY after all archive and financial integrity checks pass)
        const cascadeDeletes = [
          { sql: "DELETE FROM referrals WHERE invitee_id = $1", params: [uid] },
          { sql: "DELETE FROM referrals WHERE inviter_id = $1", params: [uid] },
          { sql: "DELETE FROM token_transactions WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM token_balances WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM pending_refunds WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM watchlist_items WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM promo_campaign_registrations WHERE telegram_id = $1", params: [uid] },
          { sql: "DELETE FROM price_alerts WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM notifications WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM notification_queue WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM notification_settings WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM daily_checkin_streaks WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM calendar_reminders WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM ticket_replies WHERE ticket_id IN (SELECT id FROM tickets WHERE user_id = $1)", params: [uid] },
          { sql: "DELETE FROM tickets WHERE user_id = $1", params: [uid] },
          { sql: "DELETE FROM admins WHERE telegram_id = $1", params: [uid] },
          { sql: "DELETE FROM users WHERE telegram_id = $1", params: [uid] }
        ];
        for (const q of cascadeDeletes) {
          await txQuery(q.sql, q.params);
        }
      });
    } catch (atomicErr) {
      console.error("[DELETE-ACCOUNT] Single atomic transaction failed and rolled back:", atomicErr?.message);
      throw atomicErr;
    }

    console.log("[DELETE-ACCOUNT] Atomic cascade complete with financial archive:", JSON.stringify(summary));
    return summary;
  }

  async function checkReferralCooldown(env, userId) {
    const uid = String(userId);
    try {
      // PHASE 1 SAFE OPTIMIZATION: Gate the DDL behind a module-level flag.
      // The CREATE TABLE IF NOT EXISTS is idempotent, but running it on every
      // call wastes a DB round-trip. Now it only runs once per isolate.
      if (!_deletedUsersTableEnsured) {
        // PROD-DDL-SKIP: tables provisioned by migrations; skip runtime DDL in production.
        if (env && String(env.APP_ENV || '').toLowerCase() === 'production') {
          _deletedUsersTableEnsured = true;
        } else {
          await queryDb(env, `
            CREATE TABLE IF NOT EXISTS deleted_users (
              id SERIAL PRIMARY KEY,
              telegram_id VARCHAR(64) NOT NULL UNIQUE,
              previous_inviter_id VARCHAR(64),
              deleted_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
              cooldown_until TIMESTAMPTZ NOT NULL DEFAULT (NOW() + INTERVAL '15 days')
            )
          `);
          _deletedUsersTableEnsured = true;
        }
      }
      const result = await queryDb(env,
        `SELECT telegram_id, deleted_at, cooldown_until
         FROM deleted_users
         WHERE telegram_id = $1 AND cooldown_until > NOW()
         LIMIT 1`,
        [uid]);
      if (result.rows[0]) {
        return {
          inCooldown: true,
          cooldownUntil: result.rows[0].cooldown_until,
          reason: 'Deleted account cooldown (15 days)',
          deletedAt: result.rows[0].deleted_at,
        };
      }
      return { inCooldown: false, reason: null };
    } catch (e) {
      console.warn('[COOLDOWN] Check failed (non-fatal, allowing referral):', e?.message);
      return { inCooldown: false, reason: null, error: e?.message };
    }
  }

  return Object.freeze({ ensureTable, normalizeLanguage, normalizeRow, getById, bootstrap, updateSettings, deleteAccount, checkReferralCooldown });
}
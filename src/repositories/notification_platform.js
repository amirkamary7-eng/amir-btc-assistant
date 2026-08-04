/**
 * Notification Platform Repository — Database Layer
 *
 * Central notification system that ALL project messages must go through.
 * Replaces scattered sendTelegramMessage calls with a unified dispatch.
 *
 * Tables:
 * - notifications: user-facing notification inbox (extended with priority, channel, category, status)
 * - notification_templates: reusable message templates (FA/EN, RTL/LTR, variables)
 * - notification_queue: batch/retry queue for broadcasts
 * - notification_broadcasts: admin broadcast records with targeting
 *
 * This extends the existing notifications table (adds columns if missing).
 */

// Module-level env accessors (set in fetch handler, used by processBroadcast)
let env_sendTelegramMessage = null;

export function setEnvSendTelegramMessage(fn) {
  env_sendTelegramMessage = fn;
}

export function createNotificationPlatformRepository(deps) {
  const { queryDb, isDatabaseConfigured, isoDate, normalizeOptionalString } = deps;

  let _schemaVerified = false;

  async function ensureSchema(env) {
    if (_schemaVerified) return;
    if (!isDatabaseConfigured(env)) { _schemaVerified = true; return; }

    try {
      // Extend existing notifications table with new columns (ADD COLUMN IF NOT EXISTS)
      await queryDb(env, `
        ALTER TABLE notifications
          ADD COLUMN IF NOT EXISTS priority VARCHAR(16) NOT NULL DEFAULT 'medium',
          ADD COLUMN IF NOT EXISTS category VARCHAR(32) NOT NULL DEFAULT 'system',
          ADD COLUMN IF NOT EXISTS channel VARCHAR(32) NOT NULL DEFAULT 'mini_app',
          ADD COLUMN IF NOT EXISTS status VARCHAR(16) NOT NULL DEFAULT 'delivered',
          ADD COLUMN IF NOT EXISTS archived BOOLEAN NOT NULL DEFAULT FALSE,
          ADD COLUMN IF NOT EXISTS action_url TEXT,
          ADD COLUMN IF NOT EXISTS icon VARCHAR(64),
          ADD COLUMN IF NOT EXISTS read_at TIMESTAMPTZ,
          ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ
      `).catch(() => {}); // Columns might already exist

      // ── Channel preference columns on notification_settings ──
      // Each category gets a VARCHAR column: 'none', 'mini_app', 'telegram', 'both'
      // This replaces the old boolean model with a 4-way channel selector.
      // Migration is additive (ALTER TABLE ADD COLUMN IF NOT EXISTS) — no data loss.
      const channelCategories = [
        'referral', 'wallet', 'price_alert', 'analysis', 'breaking_news',
        'announcements', 'promotions', 'challenges', 'tickets',
        'calendar', 'news', 'market', 'wheel', 'mission', 'security', 'system'
      ];
      const defaultChannels = {
        referral: 'mini_app', wallet: 'mini_app', price_alert: 'both',
        analysis: 'both', breaking_news: 'both', announcements: 'mini_app',
        promotions: 'none', challenges: 'mini_app', tickets: 'both',
        calendar: 'both', news: 'both', market: 'both',
        wheel: 'mini_app', mission: 'mini_app', security: 'both', system: 'mini_app',
      };
      for (const cat of channelCategories) {
        const colName = `ch_${cat}`;
        const defVal = defaultChannels[cat] || 'mini_app';
        await queryDb(env, `ALTER TABLE notification_settings ADD COLUMN IF NOT EXISTS ${colName} VARCHAR(16) NOT NULL DEFAULT '${defVal}'`).catch(() => {});
      }

      // Notification templates table
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS notification_templates (
          id SERIAL PRIMARY KEY,
          key VARCHAR(64) NOT NULL UNIQUE,
          category VARCHAR(32) NOT NULL DEFAULT 'system',
          title_fa TEXT, title_en TEXT,
          body_fa TEXT, body_en TEXT,
          icon VARCHAR(64),
          action_url TEXT,
          priority VARCHAR(16) NOT NULL DEFAULT 'medium',
          channel VARCHAR(32) NOT NULL DEFAULT 'mini_app',
          variables JSONB DEFAULT '[]',
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

      // Notification broadcasts table (admin campaigns + analysis publish)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS notification_broadcasts (
          id SERIAL PRIMARY KEY,
          admin_id TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          category VARCHAR(32) NOT NULL DEFAULT 'announcement',
          priority VARCHAR(16) NOT NULL DEFAULT 'medium',
          channel VARCHAR(32) NOT NULL DEFAULT 'both',
          target_type VARCHAR(32) NOT NULL DEFAULT 'all',
          target_value JSONB DEFAULT '{}',
          scheduled_at TIMESTAMPTZ,
          sent_at TIMESTAMPTZ,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          total_sent INTEGER NOT NULL DEFAULT 0,
          total_delivered INTEGER NOT NULL DEFAULT 0,
          total_read INTEGER NOT NULL DEFAULT 0,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          last_processed_user_id TEXT,
          batch_size INTEGER NOT NULL DEFAULT 5,
          batch_delay_ms INTEGER NOT NULL DEFAULT 500
        )
      `);
      // Add checkpoint columns if they don't exist (idempotent)
      await queryDb(env, `ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS last_processed_user_id TEXT`).catch(() => {});
      await queryDb(env, `ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS batch_size INTEGER NOT NULL DEFAULT 5`).catch(() => {});
      await queryDb(env, `ALTER TABLE notification_broadcasts ADD COLUMN IF NOT EXISTS batch_delay_ms INTEGER NOT NULL DEFAULT 500`).catch(() => {});

      // Notification queue table (for batch processing + retry)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS notification_queue (
          id SERIAL PRIMARY KEY,
          notification_id TEXT,
          user_id TEXT NOT NULL,
          channel VARCHAR(32) NOT NULL DEFAULT 'mini_app',
          priority VARCHAR(16) NOT NULL DEFAULT 'medium',
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          attempts INTEGER NOT NULL DEFAULT 0,
          max_attempts INTEGER NOT NULL DEFAULT 3,
          next_retry_at TIMESTAMPTZ,
          payload JSONB DEFAULT '{}',
          error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          processed_at TIMESTAMPTZ
        )
      `);

      // ── Phase 3: Idempotency migration for notification_queue ──
      // UNIQUE constraint on (notification_id, user_id) ensures that duplicate
      // enqueue calls (e.g., from concurrent requests or broadcast processing)
      // don't create duplicate queue rows → no duplicate Telegram messages.
      //
      // Migration steps (all idempotent, all data-safe):
      //   1. Backfill NULL notification_id with deterministic unique ID
      //   2. Remove duplicate rows (keep newest by id)
      //   3. Set notification_id NOT NULL
      //   4. Add UNIQUE constraint (if not exists)
      try {
        // Step 1: Backfill NULL notification_id with deterministic unique ID
        // Don't delete — these may be legitimate pending TG messages
        await queryDb(env, `
          UPDATE notification_queue
          SET notification_id = 'legacy_' || id::text
          WHERE notification_id IS NULL
        `).catch(() => {});

        // Step 2: Remove duplicates — keep only the newest row per (notification_id, user_id)
        await queryDb(env, `
          DELETE FROM notification_queue
          WHERE id NOT IN (
            SELECT MAX(id) FROM notification_queue
            GROUP BY notification_id, user_id
          )
        `).catch(() => {});

        // Step 3: Set NOT NULL (safe — step 1 eliminated all NULLs)
        await queryDb(env, `ALTER TABLE notification_queue ALTER COLUMN notification_id SET NOT NULL`).catch(() => {});

        // Step 4: Add UNIQUE constraint (idempotent via DO block)
        await queryDb(env, `
          DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conname = 'uq_notification_queue_dedup'
            ) THEN
              ALTER TABLE notification_queue
                ADD CONSTRAINT uq_notification_queue_dedup
                UNIQUE (notification_id, user_id);
            END IF;
          END $$
        `).catch(() => {});
      } catch (e) {
        console.warn('[Phase 3] Queue idempotency migration (non-fatal):', e?.message);
      }

      // Indexes
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_notif_queue_pending ON notification_queue (status, priority, next_retry_at) WHERE status = 'pending'`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_notif_broadcasts_status ON notification_broadcasts (status, scheduled_at)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_notif_category ON notifications (category)`).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_notif_priority ON notifications (priority)`).catch(() => {});

      // Seed default templates
      const tplCount = await queryDb(env, 'SELECT COUNT(*)::int AS cnt FROM notification_templates').catch(() => ({ rows: [{ cnt: 0 }] }));
      if (Number(tplCount.rows[0]?.cnt || 0) === 0) {
        await queryDb(env, `
          INSERT INTO notification_templates (key, category, title_fa, title_en, body_fa, body_en, icon, priority, channel) VALUES
            ('referral_new_invite', 'referral', 'دعوت جدید!', 'New Invite!', 'کاربری با لینک شما عضو شد.', 'A user joined via your link.', 'user-plus', 'medium', 'mini_app'),
            ('referral_reward', 'referral', 'پاداش رفرال', 'Referral Reward', 'شما +{amount} AB دریافت کردید.', 'You earned +{amount} AB.', 'gift', 'high', 'mini_app'),
            ('wheel_reward', 'wheel', 'برداشت گردونه!', 'Wheel Reward!', 'شما +{amount} AB بردید!', 'You won +{amount} AB!', 'star', 'high', 'mini_app'),
            ('wheel_spin_available', 'wheel', 'اسپین رایگان آماده است', 'Free Spin Available', 'اسپین روزانه شما آماده است.', 'Your daily spin is ready.', 'zap', 'medium', 'mini_app'),
            ('mission_completed', 'mission', 'ماموریت تکمیل شد', 'Mission Completed', 'ماموریت "{name}" تکمیل شد. پاداش: +{amount} AB', 'Mission "{name}" completed. Reward: +{amount} AB', 'check-circle', 'medium', 'mini_app'),
            ('wallet_received', 'wallet', 'دریافت توکن', 'Tokens Received', 'موجودی شما +{amount} AB افزایش یافت.', 'Your balance increased by +{amount} AB.', 'arrow-down-circle', 'low', 'mini_app'),
            ('price_alert_hit', 'market', 'هشدار قیمت', 'Price Alert', '{symbol} به {price} رسید.', '{symbol} reached {price}.', 'trending-up', 'high', 'both'),
            ('news_important', 'news', 'خبر مهم', 'Important News', '{title}', '{title}', 'alert-circle', 'high', 'both'),
            ('analysis_published', 'analysis', 'تحلیل جدید', 'New Analysis', 'تحلیل جدید {coin} منتشر شد.', 'New {coin} analysis published.', 'bar-chart', 'medium', 'both'),
            ('security_login', 'security', 'ورود جدید', 'New Login', 'ورود از دستگاه جدید.', 'Login from new device.', 'shield', 'critical', 'both'),
            ('announcement', 'system', 'اطلاعیه', 'Announcement', '{message}', '{message}', 'megaphone', 'high', 'both')
          ON CONFLICT (key) DO UPDATE SET
            category = EXCLUDED.category,
            default_channel = EXCLUDED.default_channel
        `);
      }

      _schemaVerified = true;
    } catch (e) {
      console.warn('Notification Platform schema migration warning:', e.message);
      _schemaVerified = true;
    }
  }

  // ═══════════════════════════════════════════════════════════
  // CENTRAL DISPATCH — the ONE function all systems must call
  // ═══════════════════════════════════════════════════════════

  /**
   * Create and dispatch a notification.
   * This is the SINGLE ENTRY POINT for all notifications.
   *
   * @param {object} params - { userId, templateKey, category, title, message, priority, channel, metadata, actionUrl, icon }
   * @param {object} env - Worker env
   * @returns {Promise<object>} - { id, status }
   */
  async function dispatch(env, params) {
    // UNIFIED: dispatch() is now a thin wrapper around sendNotification().
    // All callers (wallet, wheel, tickets, admin, alerts, referral) go through
    // the same path: sendNotification → check settings → INSERT notif → enqueue TG.
    return sendNotification(env, params);
  }

  // ═══════════════════════════════════════════════════════════
  // USER-FACING: list, mark read, archive, delete, settings
  // ═══════════════════════════════════════════════════════════

  async function listForUser(env, userId, { limit = 20, offset = 0, category = null, unreadOnly = false, archived = false } = {}) {
    if (!isDatabaseConfigured(env)) return { notifications: [], total: 0, hasMore: false };

    const conditions = ['user_id = $1'];
    const params = [String(userId)];
    let idx = 2;

    if (category && category !== 'all') { conditions.push(`category = $${idx++}`); params.push(category); }
    if (unreadOnly) { conditions.push(`read_status = FALSE`); }
    if (!archived) { conditions.push(`archived = FALSE`); }

    const where = `WHERE ${conditions.join(' AND ')}`;
    const countResult = await queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications ${where}`, params);
    const total = Number(countResult.rows[0]?.cnt || 0);

    params.push(Number(limit), Number(offset));
    const result = await queryDb(env, `
      SELECT * FROM notifications ${where}
      ORDER BY created_at DESC
      LIMIT $${idx++} OFFSET $${idx++}
    `, params);

    return {
      notifications: result.rows.map(_mapNotification),
      total,
      hasMore: offset + limit < total,
    };
  }

  async function getUnreadCount(env, userId) {
    if (!isDatabaseConfigured(env)) return 0;
    const result = await queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE user_id = $1 AND read_status = FALSE AND archived = FALSE`, [String(userId)]);
    return Number(result.rows[0]?.cnt || 0);
  }

  async function markRead(env, userId, notificationId) {
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `UPDATE notifications SET read_status = TRUE, read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id`, [notificationId, String(userId)]);
    return result.rows.length > 0;
  }

  async function markAllRead(env, userId) {
    if (!isDatabaseConfigured(env)) return 0;
    const result = await queryDb(env, `UPDATE notifications SET read_status = TRUE, read_at = NOW() WHERE user_id = $1 AND read_status = FALSE RETURNING id`, [String(userId)]);
    return result.rows.length;
  }

  async function archive(env, userId, notificationId) {
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `UPDATE notifications SET archived = TRUE WHERE id = $1 AND user_id = $2 RETURNING id`, [notificationId, String(userId)]);
    return result.rows.length > 0;
  }

  async function deleteNotification(env, userId, notificationId) {
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`, [notificationId, String(userId)]);
    return result.rows.length > 0;
  }

  async function getSettings(env, userId) {
    if (!isDatabaseConfigured(env)) return _defaultSettings();
    try {
      const result = await queryDb(env, `SELECT * FROM notification_settings WHERE user_id = $1`, [String(userId)]);
      return result.rows[0] ? _mapSettings(result.rows[0]) : _defaultSettings();
    } catch { return _defaultSettings(); }
  }

  async function updateSettings(env, userId, updates) {
    if (!isDatabaseConfigured(env)) return _defaultSettings();

    // Upsert: ensure row exists
    await queryDb(env, `
      INSERT INTO notification_settings (user_id, updated_at)
      VALUES ($1, NOW())
      ON CONFLICT (user_id) DO NOTHING
    `, [String(userId)]);

    // Build SET clauses — support both old boolean fields AND new ch_* channel fields
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;

    // Old boolean fields (backward compat)
    const boolFields = ['analysis', 'calendar', 'price_alert', 'market', 'news', 'referral', 'reward', 'ticket', 'system', 'marketing'];
    for (const f of boolFields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(!!updates[f]);
      }
    }

    // New channel preference fields (ch_*)
    const channelCategories = [
      'referral', 'wallet', 'price_alert', 'analysis', 'breaking_news',
      'announcements', 'promotions', 'challenges', 'tickets',
      'calendar', 'news', 'market', 'wheel', 'mission', 'security', 'system'
    ];
    for (const cat of channelCategories) {
      const colName = `ch_${cat}`;
      if (updates[colName] !== undefined) {
        const val = String(updates[colName]);
        if (['none', 'mini_app', 'telegram', 'both'].includes(val)) {
          setClauses.push(`${colName} = $${idx++}`);
          params.push(val);
        }
      }
    }

    params.push(String(userId));
    const result = await queryDb(env, `UPDATE notification_settings SET ${setClauses.join(', ')} WHERE user_id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapSettings(result.rows[0]) : _defaultSettings();
  }

  /**
   * Get user's channel preference for a specific category.
   * Returns 'none', 'mini_app', 'telegram', or 'both'.
   * Falls back to default if not set.
   */
  async function getUserChannelPreference(env, userId, category) {
    // PERF: Do NOT call ensureSchema here — it adds 3+ seconds of latency.
    // Schema is already verified in production.
    if (!isDatabaseConfigured(env)) return 'mini_app'; // default
    try {
      // Map dispatch category to ch_* column
      const catMap = {
        'referral': 'ch_referral', 'wallet': 'ch_wallet', 'wheel': 'ch_wheel',
        'mission': 'ch_mission', 'market': 'ch_market', 'news': 'ch_news',
        'calendar': 'ch_calendar', 'security': 'ch_security', 'system': 'ch_system',
        'announcement': 'ch_announcements', 'announcements': 'ch_announcements',
        'price_alert': 'ch_price_alert', 'analysis': 'ch_analysis',
        'breaking_news': 'ch_breaking_news', 'promotions': 'ch_promotions',
        'challenges': 'ch_challenges', 'tickets': 'ch_tickets',
      };
      const col = catMap[category] || 'ch_system';
      const result = await queryDb(env, `SELECT ${col} AS pref FROM notification_settings WHERE user_id = $1`, [String(userId)]);
      if (result.rows[0] && result.rows[0].pref) {
        return String(result.rows[0].pref);
      }
      // Return default based on category
      const defaults = {
        referral: 'mini_app', wallet: 'mini_app', price_alert: 'both',
        analysis: 'both', breaking_news: 'both', announcements: 'mini_app',
        promotions: 'none', challenges: 'mini_app', tickets: 'both',
        calendar: 'both', news: 'both', market: 'both',
        wheel: 'mini_app', mission: 'mini_app', security: 'both', system: 'mini_app',
      };
      return defaults[category] || 'mini_app';
    } catch { return 'mini_app'; }
  }

  async function isCategoryDisabled(env, userId, category) {
    const pref = await getUserChannelPreference(env, userId, category);
    return pref === 'none';
  }

  // ═══════════════════════════════════════════════════════════
  // TEMPLATES
  // ═══════════════════════════════════════════════════════════

  async function listTemplates(env) {
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `SELECT * FROM notification_templates ORDER BY category, key ASC`);
    return result.rows.map(_mapTemplate);
  }

  async function getTemplate(env, key) {
    // PERF: Do NOT call ensureSchema here — it adds 3+ seconds of latency.
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `SELECT * FROM notification_templates WHERE key = $1 LIMIT 1`, [String(key)]);
    return result.rows[0] ? _mapTemplate(result.rows[0]) : null;
  }

  async function createTemplate(env, data) {
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO notification_templates (key, category, title_fa, title_en, body_fa, body_en, icon, action_url, priority, channel, variables, is_active)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12)
      ON CONFLICT (key) DO UPDATE SET title_fa = EXCLUDED.title_fa, title_en = EXCLUDED.title_en, body_fa = EXCLUDED.body_fa, body_en = EXCLUDED.body_en, updated_at = NOW()
      RETURNING *
    `, [data.key, data.category || 'system', data.title_fa || '', data.title_en || '', data.body_fa || '', data.body_en || '', data.icon || null, data.action_url || null, data.priority || 'medium', data.channel || 'mini_app', JSON.stringify(data.variables || []), data.is_active !== false]);
    return result.rows[0] ? _mapTemplate(result.rows[0]) : null;
  }

  async function updateTemplate(env, id, updates) {
    if (!isDatabaseConfigured(env)) return null;
    const fields = ['key', 'category', 'title_fa', 'title_en', 'body_fa', 'body_en', 'icon', 'action_url', 'priority', 'channel', 'is_active'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) { setClauses.push(`${f} = $${idx++}`); params.push(updates[f]); }
    }
    params.push(Number(id));
    const result = await queryDb(env, `UPDATE notification_templates SET ${setClauses.join(', ')} WHERE id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapTemplate(result.rows[0]) : null;
  }

  async function deleteTemplate(env, id) {
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM notification_templates WHERE id = $1 RETURNING id`, [Number(id)]);
    return result.rows.length > 0;
  }

  // ═══════════════════════════════════════════════════════════
  // BROADCASTS (admin)
  // ═══════════════════════════════════════════════════════════

  async function listBroadcasts(env, { limit = 20, offset = 0 } = {}) {
    if (!isDatabaseConfigured(env)) return { broadcasts: [], total: 0 };
    const countResult = await queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notification_broadcasts`);
    const total = Number(countResult.rows[0]?.cnt || 0);
    const result = await queryDb(env, `SELECT * FROM notification_broadcasts ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [Number(limit), Number(offset)]);
    return { broadcasts: result.rows.map(_mapBroadcast), total };
  }

  async function createBroadcast(env, data) {
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO notification_broadcasts (admin_id, title, message, category, priority, channel, target_type, target_value, scheduled_at, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [String(data.admin_id), data.title, data.message, data.category || 'announcement', data.priority || 'medium', data.channel || 'mini_app', data.target_type || 'all', JSON.stringify(data.target_value || {}), data.scheduled_at || null, data.scheduled_at ? 'scheduled' : 'pending', JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapBroadcast(result.rows[0]) : null;
  }

  async function processBroadcast(env, broadcastId) {
    if (!isDatabaseConfigured(env)) return { sent: 0, failed: 0 };
    const bResult = await queryDb(env, `SELECT * FROM notification_broadcasts WHERE id = $1`, [Number(broadcastId)]);
    const b = bResult.rows[0];
    if (!b) return { sent: 0, failed: 0 };

    // Get target users
    let userQuery = `SELECT telegram_id FROM users WHERE 1=1`;
    if (b.target_type === 'active') { userQuery += ` AND channel_joined = TRUE`; }
    else if (b.target_type === 'specific' && b.target_value) { userQuery += ` AND telegram_id = '${b.target_value}'`; }
    const users = await queryDb(env, userQuery);
    let sent = 0;
    let failed = 0;

    // ROOT CAUSE FIX (notification settings compliance):
    // Previously this function directly INSERTed into notifications and
    // called sendTelegramMessage, BYPASSING getUserChannelPreference entirely.
    // Users who set ch_<category>='none' still received broadcasts.
    //
    // Now we route through dispatch() which internally checks
    // getUserChannelPreference(env, userId, b.category). Users with
    // ch_<category>='none' are filtered out. channel:'both' with
    // forceChannel:'auto' lets dispatch respect the user's per-category
    // channel preference (mini_app / telegram / both).
    for (const u of users.rows) {
      try {
        const result = await dispatch(env, {
          userId: String(u.telegram_id),
          category: b.category || 'announcement',
          channel: 'both',
          forceChannel: 'auto',
          title: b.title,
          message: b.message,
          priority: b.priority || 'medium',
          icon: 'megaphone',
          metadata: { broadcast_id: String(b.id) },
        });
        if (result && result.status && result.status !== 'filtered' && result.status !== 'error') {
          sent++;
        } else if (result && result.status === 'filtered') {
          // User opted out of this category — don't count as failed
        } else {
          failed++;
        }
      } catch (e) {
        failed++;
        console.warn('Broadcast dispatch failed for user', u.telegram_id, e.message);
      }
    }

    // Update broadcast status
    await queryDb(env, `UPDATE notification_broadcasts SET status = 'sent', sent_at = NOW(), total_sent = $1 WHERE id = $2`, [sent, Number(broadcastId)]);
    return { sent, failed };
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════

  async function getAnalytics(env, { range = '7d' } = {}) {
    if (!isDatabaseConfigured(env)) return _emptyAnalytics();
    const rangeCondition = range === '30d' ? "created_at >= NOW() - INTERVAL '30 days'" : "created_at >= NOW() - INTERVAL '7 days'";
    try {
      // BUG FIX: Use Promise.allSettled — if notifications table doesn't have
      // priority/channel columns yet (pre-migration), still return partial data.
      const results = await Promise.allSettled([
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition}`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} AND read_status = FALSE`),
        queryDb(env, `SELECT category, COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} GROUP BY category ORDER BY cnt DESC`),
        queryDb(env, `SELECT priority, COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} GROUP BY priority ORDER BY cnt DESC`),
        queryDb(env, `SELECT channel, COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} GROUP BY channel ORDER BY cnt DESC`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE created_at >= CURRENT_DATE`),
      ]);
      const val = (r, fallback = 0) => r.status === 'fulfilled' ? Number(r.value?.rows?.[0]?.cnt || fallback) : fallback;
      const rows = (r) => r.status === 'fulfilled' ? r.value.rows : [];
      return {
        total_sent: val(results[0]),
        total_unread: val(results[1]),
        today_count: val(results[5]),
        by_category: rows(results[2]).map(r => ({ category: r.category, count: Number(r.cnt) })),
        by_priority: rows(results[3]).map(r => ({ priority: r.priority, count: Number(r.cnt) })),
        by_channel: rows(results[4]).map(r => ({ channel: r.channel, count: Number(r.cnt) })),
      };
    } catch { return _emptyAnalytics(); }
  }

  function _emptyAnalytics() { return { total_sent: 0, total_unread: 0, today_count: 0, by_category: [], by_priority: [], by_channel: [] }; }

  // ═══════════════════════════════════════════════════════════
  // QUEUE
  // ═══════════════════════════════════════════════════════════

  async function enqueue(env, { notificationId, userId, channel, priority, payload }) {
    // PERF: Do NOT call ensureSchema here — it adds 3+ seconds of latency.
    if (!isDatabaseConfigured(env)) return;
    if (!notificationId) {
      console.warn('Notification enqueue error: notificationId is required for idempotency');
      return;
    }
    try {
      // Phase 3: ON CONFLICT (notification_id, user_id) DO NOTHING
      // Prevents duplicate queue rows from concurrent enqueue calls.
      // The UNIQUE constraint (added in ensureSchema migration) enforces this at DB level.
      await queryDb(env, `
        INSERT INTO notification_queue (notification_id, user_id, channel, priority, status, payload, created_at)
        VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
        ON CONFLICT (notification_id, user_id) DO NOTHING
      `, [String(notificationId), String(userId), channel, priority, JSON.stringify(payload || {})]);
    } catch (e) { console.warn('Notification enqueue error:', e.message); }
  }

  async function processQueue(env, sendTelegramMessageFn) {
    // PERF: Do NOT call ensureSchema here — it runs 16+ ALTER TABLE queries
    // (one per channel column) which adds 3+ seconds of latency.
    // ensureSchema is called by dispatch() on first use, which is enough.
    if (!isDatabaseConfigured(env)) return { processed: 0 };

    // Phase 3: Atomic claim with FOR UPDATE SKIP LOCKED
    // Prevents concurrent processQueue ticks from processing the same items.
    // UPDATE...SET status='processing'...RETURNING atomically claims items
    // so concurrent ticks get disjoint sets.
    let queue;
    try {
      queue = await queryDb(env, `
        UPDATE notification_queue
        SET status = 'processing', processed_at = NOW()
        WHERE id IN (
          SELECT id FROM notification_queue
          WHERE status = 'pending' AND attempts < max_attempts
          AND (next_retry_at IS NULL OR next_retry_at <= NOW())
          ORDER BY priority DESC, created_at ASC
          LIMIT 50
          FOR UPDATE SKIP LOCKED
        )
        RETURNING *
      `);
    } catch (e) {
      // Table might not exist yet — skip silently
      return { processed: 0, error: 'queue_table_missing' };
    }
    if (!queue.rows || queue.rows.length === 0) {
      return { processed: 0 }; // No pending items — fast exit
    }
    let processed = 0;
    let failed = 0;
    for (const item of queue.rows) {
      try {
        const payload = item.payload || {};
        const text = `${payload.title ? payload.title + '\n' : ''}${payload.message || ''}`;
        if (item.channel === 'telegram' && sendTelegramMessageFn) {
          // Phase 2: Build Telegram payload with rich message fields
          const tgPayload = {
            chat_id: item.user_id,
            text,
          };
          const tx = payload.telegramExtra;
          if (tx && typeof tx === 'object') {
            if (tx.reply_markup) tgPayload.reply_markup = tx.reply_markup;
            if (tx.parse_mode) tgPayload.parse_mode = tx.parse_mode;
            if (tx.disable_web_page_preview !== undefined) tgPayload.disable_web_page_preview = tx.disable_web_page_preview;
            else tgPayload.disable_web_page_preview = true;
          } else {
            tgPayload.disable_web_page_preview = true;
          }
          await sendTelegramMessageFn(env, tgPayload);
        }
        // Success → mark as processed
        await queryDb(env, `UPDATE notification_queue SET status = 'processed', processed_at = NOW() WHERE id = $1`, [item.id]);
        processed++;
      } catch (e) {
        // Failure → revert to 'pending' for retry, increment attempts.
        // If max_attempts exceeded, mark as 'failed' (no more retries).
        await queryDb(env, `
          UPDATE notification_queue
          SET status = CASE WHEN attempts + 1 >= max_attempts THEN 'failed' ELSE 'pending' END,
              attempts = attempts + 1,
              error = $2,
              next_retry_at = NOW() + INTERVAL '60 seconds'
          WHERE id = $1
        `, [item.id, String(e.message || '').substring(0, 200)]).catch(() => {});
        failed++;
      }
    }
    return { processed, failed };
  }

  // ═══════════════════════════════════════════════════════════
  // Phase 4: CRASH RECOVERY
  // ═══════════════════════════════════════════════════════════

  /**
   * Phase 4: Requeue stale queue items stuck in 'processing'.
   *
   * When processQueue claims items (status→'processing') and the worker
   * crashes before marking them 'processed', these items are stuck forever
   * — processQueue only selects 'pending'. This function resets items
   * stuck in 'processing' for more than 5 minutes back to 'pending' so
   * they can be retried.
   *
   * Uses processed_at as the claim timestamp (set to NOW() when claimed).
   * 5-minute timeout matches broadcast recovery.
   *
   * Called from cron every 5 minutes.
   */
  async function requeueStaleQueueItems(env) {
    if (!isDatabaseConfigured(env)) return { requeued: 0 };
    try {
      const result = await queryDb(env, `
        UPDATE notification_queue
        SET status = 'pending'
        WHERE status = 'processing'
          AND processed_at < NOW() - INTERVAL '5 minutes'
      `);
      const requeued = result.rowCount || 0;
      if (requeued > 0) {
        console.log(`[Phase 4] Requeued ${requeued} stale queue items`);
      }
      return { requeued };
    } catch (e) {
      console.warn('[Phase 4] requeueStaleQueueItems error:', e?.message);
      return { requeued: 0 };
    }
  }

  /**
   * Phase 4: Requeue stale broadcasts stuck in 'sending'.
   *
   * When processBroadcastFull claims a broadcast (status→'sending') and
   * the worker crashes before marking it 'sent', the broadcast is stuck.
   * processBroadcastBatch selects 'pending' and 'sending', but without
   * CAS claim (Phase 5), two isolates could process it simultaneously.
   *
   * This function resets broadcasts stuck in 'sending' for more than 5
   * minutes back to 'pending' so processBroadcastBatch can resume them.
   * The checkpoint (last_processed_user_id) ensures resume from where
   * it left off — dedupKey prevents duplicate notifications.
   *
   * Called from cron every 5 minutes.
   */
  async function requeueStaleBroadcasts(env) {
    if (!isDatabaseConfigured(env)) return { requeued: 0 };
    try {
      // Reset broadcasts stuck in 'sending' for more than 5 minutes.
      // Uses created_at as proxy for staleness (broadcasts are usually
      // processed within minutes). Phase 8 will add claimed_at for precision.
      const result = await queryDb(env, `
        UPDATE notification_broadcasts
        SET status = 'pending'
        WHERE status = 'sending'
          AND created_at < NOW() - INTERVAL '5 minutes'
      `);
      const requeued = result.rowCount || 0;
      if (requeued > 0) {
        console.log(`[Phase 4] Requeued ${requeued} stale broadcasts`);
      }
      return { requeued };
    } catch (e) {
      console.warn('[Phase 4] requeueStaleBroadcasts error:', e?.message);
      return { requeued: 0 };
    }
  }

  // ═══════════════════════════════════════════════════════════
  // MAPPERS
  // ═══════════════════════════════════════════════════════════

  function _mapNotification(r) {
    return {
      id: r.id, user_id: String(r.user_id), type: r.type,
      title: r.title || '', message: r.message || '',
      metadata: r.metadata || {}, read_status: r.read_status,
      priority: r.priority || 'medium', category: r.category || 'system',
      channel: r.channel || 'mini_app', status: r.status || 'delivered',
      archived: r.archived || false, action_url: r.action_url, icon: r.icon,
      created_at: isoDate(r.created_at), read_at: isoDate(r.read_at),
    };
  }

  function _mapTemplate(r) {
    return {
      id: Number(r.id), key: r.key, category: r.category,
      title_fa: r.title_fa, title_en: r.title_en,
      body_fa: r.body_fa, body_en: r.body_en,
      icon: r.icon, action_url: r.action_url,
      priority: r.priority, channel: r.channel,
      variables: r.variables || [], is_active: r.is_active,
    };
  }

  function _mapBroadcast(r) {
    return {
      id: Number(r.id), admin_id: String(r.admin_id),
      title: r.title, message: r.message,
      category: r.category, priority: r.priority, channel: r.channel,
      target_type: r.target_type, target_value: r.target_value || {},
      scheduled_at: isoDate(r.scheduled_at), sent_at: isoDate(r.sent_at),
      status: r.status, total_sent: Number(r.total_sent || 0),
      total_delivered: Number(r.total_delivered || 0), total_read: Number(r.total_read || 0),
    };
  }

  function _mapSettings(r) {
    return {
      // Old boolean fields (backward compat)
      analysis: r.analysis, calendar: r.calendar, price_alert: r.price_alert,
      market: r.market, news: r.news, referral: r.referral,
      reward: r.reward, ticket: r.ticket, system: r.system, marketing: r.marketing,
      // New channel preference fields
      ch_referral: r.ch_referral || 'mini_app',
      ch_wallet: r.ch_wallet || 'mini_app',
      ch_price_alert: r.ch_price_alert || 'both',
      ch_analysis: r.ch_analysis || 'both',
      ch_breaking_news: r.ch_breaking_news || 'both',
      ch_announcements: r.ch_announcements || 'mini_app',
      ch_promotions: r.ch_promotions || 'none',
      ch_challenges: r.ch_challenges || 'mini_app',
      ch_tickets: r.ch_tickets || 'both',
      ch_calendar: r.ch_calendar || 'both',
      ch_news: r.ch_news || 'both',
      ch_market: r.ch_market || 'both',
      ch_wheel: r.ch_wheel || 'mini_app',
      ch_mission: r.ch_mission || 'mini_app',
      ch_security: r.ch_security || 'both',
      ch_system: r.ch_system || 'mini_app',
    };
  }

  function _defaultSettings() {
    return {
      analysis: true, calendar: false, price_alert: false, market: true, news: true, referral: true, reward: true, ticket: true, system: true, marketing: false,
      ch_referral: 'mini_app', ch_wallet: 'mini_app', ch_price_alert: 'both',
      ch_analysis: 'both', ch_breaking_news: 'both', ch_announcements: 'mini_app',
      ch_promotions: 'none', ch_challenges: 'mini_app', ch_tickets: 'both',
      ch_calendar: 'both', ch_news: 'both', ch_market: 'both',
      ch_wheel: 'mini_app', ch_mission: 'mini_app', ch_security: 'both', ch_system: 'mini_app',
    };
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // PRODUCTION-GRADE BROADCAST SYSTEM
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // Architecture:
  //   1. handleCreate inserts ONE broadcast record (1 queryDb, immediate response)
  //   2. Cron processBroadcastQueue runs every minute
  //   3. Each cron tick processes ONE batch (5 users by default)
  //   4. Checkpoint (last_processed_user_id) saved after each batch
  //   5. Resumes from checkpoint on next tick
  //   6. Respects user notification settings (ch_analysis column)
  //   7. Rate-limit aware (429 → backoff)
  //
  // CPU per cron tick: 1 queryDb (SELECT batch) + 5×2 queryDb (INSERT notif +
  //   optional enqueue) = ~11 queryDb. But each is per-call Pool (~5ms TLS),
  //   so 11×5 = 55ms. This runs in cron (ctx.waitUntil), NOT in HTTP request.
  //   Cron has 10ms CPU limit too, but can use ctx.waitUntil for I/O work.

  function _getChannelColumn(category) {
    const map = {
      'referral': 'ch_referral', 'wallet': 'ch_wallet', 'wheel': 'ch_wheel',
      'mission': 'ch_mission', 'market': 'ch_market', 'news': 'ch_news',
      'calendar': 'ch_calendar', 'security': 'ch_security', 'system': 'ch_system',
      'announcement': 'ch_announcements', 'announcements': 'ch_announcements',
      'price_alert': 'ch_price_alert', 'analysis': 'ch_analysis',
      'breaking_news': 'ch_breaking_news', 'promotions': 'ch_promotions',
      'challenges': 'ch_challenges', 'tickets': 'ch_tickets',
    };
    return map[category] || 'ch_system';
  }

  // ═══════════════════════════════════════════════════════════════════════════
  // UNIFIED NOTIFICATION API — single entry point for ALL notifications
  // ═══════════════════════════════════════════════════════════════════════════
  //
  // sendNotification(env, opts) — replaces dispatch() for single-user notifications
  // createBroadcastJob(env, opts) — for multi-user broadcasts (analysis publish, admin broadcast)
  //
  // Both paths:
  //   1. Respect user notification settings (ch_<category> column)
  //   2. Are idempotent (ON CONFLICT DO NOTHING on notification id)
  //   3. Support in-app (INSERT notifications) + Telegram (sendTelegramMessage)
  //   4. Handle 429 rate limit with retry
  //
  // dispatch() is kept as a thin wrapper for backward compatibility.

  /**
   * UNIFIED single-user notification send.
   * Replaces dispatch() — same interface, cleaner implementation.
   *
   * @param {object} env
   * @param {object} opts - { userId, title, message, category, priority, channel, metadata, templateKey }
   * @returns {Promise<{id, status}>}
   */
  async function sendNotification(env, opts) {
    if (!isDatabaseConfigured(env)) return { id: null, status: 'skipped' };
    const {
      userId, templateKey, category, title, message,
      priority = 'medium', channel = 'both',
      metadata = {},
      telegramExtra,    // Phase 2: rich message fields (reply_markup, parse_mode, disable_web_page_preview)
      skipInApp = false, // Phase 2: skip in-app INSERT (for rich Telegram-only messages)
      dedupKey,          // Phase 2: deterministic notification ID (for idempotency)
      forceChannel = false, // Phase 2: ignore user preference (admin/system critical)
    } = opts;

    if (!userId) return { id: null, status: 'error', error: 'userId required' };

    // Resolve template if provided
    let finalTitle = title || '';
    let finalMessage = message || '';
    let finalCategory = category || 'system';
    let finalPriority = priority;
    let finalChannel = channel;

    if (templateKey) {
      const template = await getTemplate(env, templateKey);
      if (template) {
        finalCategory = template.category;
        finalPriority = template.priority;
        finalChannel = template.channel;
        finalTitle = finalTitle || template.title_fa || template.title_en || '';
        finalMessage = finalMessage || template.body_fa || template.body_en || '';
        if (metadata && typeof metadata === 'object') {
          for (const [key, value] of Object.entries(metadata)) {
            finalTitle = finalTitle.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
            finalMessage = finalMessage.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
          }
        }
      }
    }

    // Check user's notification preference (unless forceChannel)
    let userChannel = finalChannel;
    if (!forceChannel) {
      const channelPrefCol = _getChannelColumn(finalCategory);
      const prefResult = await queryDb(env,
        `SELECT ${channelPrefCol} AS pref FROM notification_settings WHERE user_id = $1`,
        [String(userId)]
      ).catch(() => ({ rows: [] }));
      if (prefResult.rows[0]?.pref) {
        userChannel = String(prefResult.rows[0].pref);
      }
      if (userChannel === 'none') return { id: null, status: 'filtered' };
    }

    const deliverToMiniApp = (userChannel === 'mini_app' || userChannel === 'both') && !skipInApp;
    const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';

    // Phase 2: deterministic notification ID if dedupKey provided
    const notificationId = dedupKey
      ? `notif_${String(dedupKey).replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 60)}`
      : `notif_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    // Insert in-app notification (idempotent)
    if (deliverToMiniApp) {
      try {
        await queryDb(env, `
          INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status, created_at)
          VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, 'delivered', NOW())
          ON CONFLICT (id) DO NOTHING
        `, [
          notificationId, String(userId), finalCategory,
          finalTitle, finalMessage, JSON.stringify(metadata),
          finalPriority, finalCategory,
          deliverToTelegram ? 'both' : 'mini_app',
        ]);
      } catch (e) {
        console.warn('sendNotification INSERT error:', e.message);
      }
    }

    // Phase 2: Enqueue Telegram delivery with rich message support.
    // ALL Telegram sends go through the queue — processQueue is the single
    // authorized caller of sendTelegramMessage.
    if (deliverToTelegram) {
      await enqueue(env, {
        notificationId: notificationId, // Phase 2: always non-null (for future idempotency)
        userId: String(userId),
        channel: 'telegram',
        priority: finalPriority,
        payload: { title: finalTitle, message: finalMessage, telegramExtra },
      });
    }

    return { id: notificationId, status: 'delivered' };
  }

  /**
   * Create a broadcast job — called from handleCreate (1 queryDb, immediate).
   */
  async function createBroadcastJob(env, { adminId, title, message, category, priority, channel, metadata }) {
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO notification_broadcasts (admin_id, title, message, category, priority, channel, target_type, status, metadata, created_at)
      VALUES ($1, $2, $3, $4, $5, $6, 'all', 'pending', $7, NOW())
      RETURNING id
    `, [
      String(adminId),
      title || '',
      message || '',
      category || 'analysis',
      priority || 'medium',
      channel || 'both',
      JSON.stringify(metadata || {}),
    ]);
    return result.rows[0]?.id || null;
  }

  /**
   * Process a broadcast FULLY — called from ctx.waitUntil (NOT cron).
   *
   * Processes ALL users in batches of BATCH_SIZE, with BATCH_DELAY_MS between
   * users. Continues until all users are processed or a 429 rate limit is hit.
   * Checkpoint is saved after each batch so cron can resume if this is killed.
   *
   * This runs in ctx.waitUntil — the HTTP response is already sent.
   * CPU per user: ~0ms (all I/O: queryDb + fetch, no TLS in ctx.waitUntil
   * because env._reqPool is closed, but per-call Pool is I/O-bound, not CPU).
   *
   * @param {object} env - Worker env
   * @param {function} sendTelegramMessageFn - Telegram send function
   * @param {number} broadcastId - ID of the broadcast to process
   */
  async function processBroadcastFull(env, sendTelegramMessageFn, broadcastId) {
    if (!isDatabaseConfigured(env)) return { processed: 0 };
    const BATCH_SIZE = 25;
    let totalDelivered = 0;
    let totalFailed = 0;
    let totalProcessed = 0;

    // Get broadcast details
    const broadcastResult = await queryDb(env, `SELECT * FROM notification_broadcasts WHERE id = $1`, [broadcastId]);
    if (!broadcastResult.rows.length) return { processed: 0 };
    const broadcast = broadcastResult.rows[0];
    const category = broadcast.category || 'analysis';
    const channelPrefCol = _getChannelColumn(category);

    // Mark as 'sending'
    await queryDb(env, `UPDATE notification_broadcasts SET status = 'sending' WHERE id = $1 AND status = 'pending'`, [broadcastId]);

    let checkpoint = broadcast.last_processed_user_id || null;

    // Process in batches until all users done
    // eslint-disable-next-line no-constant-condition
    while (true) {
      // Get next batch of users (after checkpoint)
      const userResult = await queryDb(env, `
        SELECT telegram_id FROM users
        WHERE channel_joined = TRUE
        ${checkpoint ? "AND telegram_id > $2" : ""}
        ORDER BY telegram_id ASC
        LIMIT $1
      `, checkpoint ? [BATCH_SIZE, checkpoint] : [BATCH_SIZE]);

      if (!userResult.rows.length) break; // All users processed

      const userIds = userResult.rows.map(r => String(r.telegram_id));
      let batchDelivered = 0;
      let batchFailed = 0;

      for (const uid of userIds) {
        try {
          // Check user's notification preference
          const prefResult = await queryDb(env,
            `SELECT ${channelPrefCol} AS pref FROM notification_settings WHERE user_id = $1`,
            [uid]
          ).catch(() => ({ rows: [] }));

          let userChannel = 'both';
          if (prefResult.rows[0]?.pref) {
            userChannel = String(prefResult.rows[0].pref);
          }

          if (userChannel === 'none') continue;

          const deliverToMiniApp = userChannel === 'mini_app' || userChannel === 'both';
          const deliverToTelegram = userChannel === 'telegram' || userChannel === 'both';

          // Phase 2: Insert in-app notification (idempotent via deterministic ID)
          if (deliverToMiniApp) {
            const notifId = `bc_${broadcastId}_${uid}`;
            await queryDb(env, `
              INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status, created_at)
              VALUES ($1, $2, 'broadcast', $3, $4, $5, FALSE, $6, $7, $8, 'delivered', NOW())
              ON CONFLICT (id) DO NOTHING
            `, [
              notifId, uid, broadcast.title, broadcast.message,
              JSON.stringify({ broadcastId, ...(broadcast.metadata || {}) }),
              broadcast.priority, broadcast.category,
              deliverToTelegram ? 'both' : 'mini_app',
            ]).catch(() => {});
          }

          // Phase 2: Enqueue Telegram delivery (NO direct sendTelegramMessage)
          // The queue processor (processQueue, cron) is the single authorized
          // Telegram sender. It handles retry via max_attempts.
          if (deliverToTelegram) {
            const notifId = `bc_${broadcastId}_${uid}`;
            await enqueue(env, {
              notificationId: notifId,
              userId: uid,
              channel: 'telegram',
              priority: broadcast.priority || 'medium',
              payload: {
                title: broadcast.title,
                message: broadcast.message,
              },
            });
          }

          batchDelivered++;
        } catch (e) {
          console.warn(`[broadcast] User ${uid} failed: ${e?.message || e}`);
          batchFailed++;
        }
      }

      checkpoint = userIds[userIds.length - 1];
      totalProcessed += userIds.length;
      totalDelivered += batchDelivered;
      totalFailed += batchFailed;

      // Save checkpoint after each batch
      await queryDb(env, `
        UPDATE notification_broadcasts
        SET total_sent = total_sent + $2,
            total_delivered = total_delivered + $3,
            last_processed_user_id = $4
        WHERE id = $1
      `, [broadcastId, userIds.length, batchDelivered, checkpoint]);
    }

    // Mark broadcast as completed
    await queryDb(env, `UPDATE notification_broadcasts SET status = 'sent', sent_at = NOW() WHERE id = $1`, [broadcastId]);

    console.log(`[broadcast] Completed broadcast ${broadcastId}: processed=${totalProcessed}, delivered=${totalDelivered}, failed=${totalFailed}`);
    return { processed: totalProcessed, delivered: totalDelivered, failed: totalFailed, broadcastId, status: 'completed' };
  }

  /**
   * Process ONE batch — called from cron as fallback/resume.
   * Used when processBroadcastFull was killed (e.g. Worker eviction).
   */
  async function processBroadcastBatch(env, sendTelegramMessageFn) {
    if (!isDatabaseConfigured(env)) return { processed: 0 };
    // Find a 'sending' broadcast that was interrupted, or a 'pending' one
    const broadcastResult = await queryDb(env, `
      SELECT * FROM notification_broadcasts
      WHERE status IN ('pending', 'sending')
      ORDER BY created_at ASC
      LIMIT 1
    `);
    if (!broadcastResult.rows.length) return { processed: 0, remaining: 0 };
    const broadcast = broadcastResult.rows[0];
    return processBroadcastFull(env, sendTelegramMessageFn, broadcast.id);
  }


  return Object.freeze({
    ensureSchema,
    dispatch,
    sendNotification,
    listForUser,
    getUnreadCount,
    markRead,
    markAllRead,
    archive,
    deleteNotification,
    getSettings,
    updateSettings,
    getUserChannelPreference,
    isCategoryDisabled,
    listTemplates,
    getTemplate,
    createTemplate,
    updateTemplate,
    deleteTemplate,
    listBroadcasts,
    createBroadcast,
    processBroadcast,
    getAnalytics,
    enqueue,
    processQueue,
    createBroadcastJob,
    processBroadcastBatch,
    processBroadcastFull,
    // Phase 4: Crash Recovery
    requeueStaleQueueItems,
    requeueStaleBroadcasts,
  });
}

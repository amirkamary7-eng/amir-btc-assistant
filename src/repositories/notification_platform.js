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

      // Notification broadcasts table (admin campaigns)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS notification_broadcasts (
          id SERIAL PRIMARY KEY,
          admin_id TEXT NOT NULL,
          title TEXT NOT NULL,
          message TEXT NOT NULL,
          category VARCHAR(32) NOT NULL DEFAULT 'announcement',
          priority VARCHAR(16) NOT NULL DEFAULT 'medium',
          channel VARCHAR(32) NOT NULL DEFAULT 'mini_app',
          target_type VARCHAR(32) NOT NULL DEFAULT 'all',
          target_value JSONB DEFAULT '{}',
          scheduled_at TIMESTAMPTZ,
          sent_at TIMESTAMPTZ,
          status VARCHAR(16) NOT NULL DEFAULT 'pending',
          total_sent INTEGER NOT NULL DEFAULT 0,
          total_delivered INTEGER NOT NULL DEFAULT 0,
          total_read INTEGER NOT NULL DEFAULT 0,
          metadata JSONB DEFAULT '{}',
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `);

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
            ('analysis_published', 'news', 'تحلیل جدید', 'New Analysis', 'تحلیل جدید {coin} منتشر شد.', 'New {coin} analysis published.', 'bar-chart', 'medium', 'mini_app'),
            ('security_login', 'security', 'ورود جدید', 'New Login', 'ورود از دستگاه جدید.', 'Login from new device.', 'shield', 'critical', 'both'),
            ('announcement', 'system', 'اطلاعیه', 'Announcement', '{message}', '{message}', 'megaphone', 'high', 'both')
          ON CONFLICT (key) DO NOTHING
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
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { id: null, status: 'skipped' };

    const {
      userId, templateKey, category, title, message,
      priority = 'medium', channel = 'mini_app',
      metadata = {}, actionUrl, icon,
    } = params;

    if (!userId) return { id: null, status: 'error', error: 'userId required' };

    // If templateKey provided, load template and fill variables
    let finalTitle = title || '';
    let finalMessage = message || '';
    let finalCategory = category || 'system';
    let finalPriority = priority;
    let finalChannel = channel;
    let finalIcon = icon;
    let finalActionUrl = actionUrl;

    if (templateKey) {
      const template = await getTemplate(env, templateKey);
      if (template) {
        finalCategory = template.category;
        finalPriority = template.priority;
        finalChannel = template.channel;
        finalIcon = template.icon || finalIcon;
        finalActionUrl = template.action_url || finalActionUrl;
        // Fill variables in title/message
        const lang = 'fa'; // Default to FA for now
        finalTitle = finalTitle || (lang === 'fa' ? template.title_fa : template.title_en) || '';
        finalMessage = finalMessage || (lang === 'fa' ? template.body_fa : template.body_en) || '';
        // Replace {variable} placeholders
        if (metadata && typeof metadata === 'object') {
          for (const [key, value] of Object.entries(metadata)) {
            finalTitle = finalTitle.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
            finalMessage = finalMessage.replace(new RegExp(`\\{${key}\\}`, 'g'), String(value));
          }
        }
      }
    }

    // Check user notification settings — skip if category is disabled
    if (await isCategoryDisabled(env, userId, finalCategory)) {
      return { id: null, status: 'filtered' };
    }

    const notificationId = `notif_${Date.now()}_${Math.random().toString(36).substring(2, 10)}`;

    try {
      await queryDb(env, `
        INSERT INTO notifications (id, user_id, type, title, message, metadata, read_status, priority, category, channel, status, action_url, icon, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, FALSE, $7, $8, $9, 'delivered', $10, $11, NOW())
      `, [
        notificationId, String(userId), finalCategory,
        finalTitle, finalMessage, JSON.stringify(metadata),
        finalPriority, finalCategory, finalChannel,
        finalActionUrl || null, finalIcon || null,
      ]);
    } catch (e) {
      console.warn('Notification dispatch error:', e.message);
      return { id: null, status: 'error', error: e.message };
    }

    // If channel includes telegram, queue for bot delivery
    if (finalChannel === 'telegram' || finalChannel === 'both') {
      await enqueue(env, {
        notificationId, userId: String(userId),
        channel: 'telegram', priority: finalPriority,
        payload: { title: finalTitle, message: finalMessage, actionUrl: finalActionUrl },
      });
    }

    return { id: notificationId, status: 'delivered' };
  }

  // ═══════════════════════════════════════════════════════════
  // USER-FACING: list, mark read, archive, delete, settings
  // ═══════════════════════════════════════════════════════════

  async function listForUser(env, userId, { limit = 20, offset = 0, category = null, unreadOnly = false, archived = false } = {}) {
    await ensureSchema(env);
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
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return 0;
    const result = await queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE user_id = $1 AND read_status = FALSE AND archived = FALSE`, [String(userId)]);
    return Number(result.rows[0]?.cnt || 0);
  }

  async function markRead(env, userId, notificationId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `UPDATE notifications SET read_status = TRUE, read_at = NOW() WHERE id = $1 AND user_id = $2 RETURNING id`, [notificationId, String(userId)]);
    return result.rows.length > 0;
  }

  async function markAllRead(env, userId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return 0;
    const result = await queryDb(env, `UPDATE notifications SET read_status = TRUE, read_at = NOW() WHERE user_id = $1 AND read_status = FALSE RETURNING id`, [String(userId)]);
    return result.rows.length;
  }

  async function archive(env, userId, notificationId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `UPDATE notifications SET archived = TRUE WHERE id = $1 AND user_id = $2 RETURNING id`, [notificationId, String(userId)]);
    return result.rows.length > 0;
  }

  async function deleteNotification(env, userId, notificationId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM notifications WHERE id = $1 AND user_id = $2 RETURNING id`, [notificationId, String(userId)]);
    return result.rows.length > 0;
  }

  async function getSettings(env, userId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultSettings();
    try {
      const result = await queryDb(env, `SELECT * FROM notification_settings WHERE user_id = $1`, [String(userId)]);
      return result.rows[0] ? _mapSettings(result.rows[0]) : _defaultSettings();
    } catch { return _defaultSettings(); }
  }

  async function updateSettings(env, userId, updates) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _defaultSettings();
    const fields = ['analysis', 'calendar', 'price_alert', 'market', 'news', 'referral', 'reward', 'ticket', 'system', 'marketing'];
    const setClauses = ['updated_at = NOW()'];
    const params = [];
    let idx = 1;
    for (const f of fields) {
      if (updates[f] !== undefined) {
        setClauses.push(`${f} = $${idx++}`);
        params.push(!!updates[f]);
      }
    }
    params.push(String(userId));
    // Upsert
    await queryDb(env, `
      INSERT INTO notification_settings (user_id, updated_at)
      VALUES ($${idx}, NOW())
      ON CONFLICT (user_id) DO NOTHING
    `, [String(userId)]);
    const result = await queryDb(env, `UPDATE notification_settings SET ${setClauses.join(', ')} WHERE user_id = $${idx} RETURNING *`, params);
    return result.rows[0] ? _mapSettings(result.rows[0]) : _defaultSettings();
  }

  async function isCategoryDisabled(env, userId, category) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    try {
      const settings = await getSettings(env, userId);
      // Map category to settings field
      const fieldMap = {
        'market': 'market', 'news': 'news', 'referral': 'referral',
        'wallet': 'reward', 'wheel': 'reward', 'mission': 'reward',
        'security': 'system', 'system': 'system', 'announcement': 'marketing',
      };
      const field = fieldMap[category] || 'system';
      return settings[field] === false;
    } catch { return false; }
  }

  // ═══════════════════════════════════════════════════════════
  // TEMPLATES
  // ═══════════════════════════════════════════════════════════

  async function listTemplates(env) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `SELECT * FROM notification_templates ORDER BY category, key ASC`);
    return result.rows.map(_mapTemplate);
  }

  async function getTemplate(env, key) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `SELECT * FROM notification_templates WHERE key = $1 LIMIT 1`, [String(key)]);
    return result.rows[0] ? _mapTemplate(result.rows[0]) : null;
  }

  async function createTemplate(env, data) {
    await ensureSchema(env);
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
    await ensureSchema(env);
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
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return false;
    const result = await queryDb(env, `DELETE FROM notification_templates WHERE id = $1 RETURNING id`, [Number(id)]);
    return result.rows.length > 0;
  }

  // ═══════════════════════════════════════════════════════════
  // BROADCASTS (admin)
  // ═══════════════════════════════════════════════════════════

  async function listBroadcasts(env, { limit = 20, offset = 0 } = {}) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { broadcasts: [], total: 0 };
    const countResult = await queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notification_broadcasts`);
    const total = Number(countResult.rows[0]?.cnt || 0);
    const result = await queryDb(env, `SELECT * FROM notification_broadcasts ORDER BY created_at DESC LIMIT $1 OFFSET $2`, [Number(limit), Number(offset)]);
    return { broadcasts: result.rows.map(_mapBroadcast), total };
  }

  async function createBroadcast(env, data) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env, `
      INSERT INTO notification_broadcasts (admin_id, title, message, category, priority, channel, target_type, target_value, scheduled_at, status, metadata)
      VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
      RETURNING *
    `, [String(data.admin_id), data.title, data.message, data.category || 'announcement', data.priority || 'medium', data.channel || 'mini_app', data.target_type || 'all', JSON.stringify(data.target_value || {}), data.scheduled_at || null, data.scheduled_at ? 'scheduled' : 'pending', JSON.stringify(data.metadata || {})]);
    return result.rows[0] ? _mapBroadcast(result.rows[0]) : null;
  }

  async function processBroadcast(env, broadcastId) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { sent: 0 };
    const bResult = await queryDb(env, `SELECT * FROM notification_broadcasts WHERE id = $1`, [Number(broadcastId)]);
    const b = bResult.rows[0];
    if (!b) return { sent: 0 };

    // Get target users
    let userQuery = `SELECT telegram_id FROM users WHERE 1=1`;
    const params = [];
    if (b.target_type === 'active') { userQuery += ` AND channel_joined = TRUE`; }
    // Add more targeting as needed
    const users = await queryDb(env, userQuery);
    let sent = 0;
    for (const u of users.rows) {
      await dispatch(env, {
        userId: u.telegram_id,
        title: b.title, message: b.message,
        category: b.category, priority: b.priority, channel: b.channel,
      });
      sent++;
    }
    await queryDb(env, `UPDATE notification_broadcasts SET status = 'sent', sent_at = NOW(), total_sent = $1 WHERE id = $2`, [sent, Number(broadcastId)]);
    return { sent };
  }

  // ═══════════════════════════════════════════════════════════
  // ANALYTICS
  // ═══════════════════════════════════════════════════════════

  async function getAnalytics(env, { range = '7d' } = {}) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return _emptyAnalytics();
    const rangeCondition = range === '30d' ? "created_at >= NOW() - INTERVAL '30 days'" : "created_at >= NOW() - INTERVAL '7 days'";
    try {
      const [total, unread, byCategory, byPriority, byChannel, todayCount] = await Promise.all([
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition}`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} AND read_status = FALSE`),
        queryDb(env, `SELECT category, COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} GROUP BY category ORDER BY cnt DESC`),
        queryDb(env, `SELECT priority, COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} GROUP BY priority ORDER BY cnt DESC`),
        queryDb(env, `SELECT channel, COUNT(*)::int AS cnt FROM notifications WHERE ${rangeCondition} GROUP BY channel ORDER BY cnt DESC`),
        queryDb(env, `SELECT COUNT(*)::int AS cnt FROM notifications WHERE created_at >= CURRENT_DATE`),
      ]);
      return {
        total_sent: Number(total.rows[0]?.cnt || 0),
        total_unread: Number(unread.rows[0]?.cnt || 0),
        today_count: Number(todayCount.rows[0]?.cnt || 0),
        by_category: byCategory.rows.map(r => ({ category: r.category, count: Number(r.cnt) })),
        by_priority: byPriority.rows.map(r => ({ priority: r.priority, count: Number(r.cnt) })),
        by_channel: byChannel.rows.map(r => ({ channel: r.channel, count: Number(r.cnt) })),
      };
    } catch { return _emptyAnalytics(); }
  }

  function _emptyAnalytics() { return { total_sent: 0, total_unread: 0, today_count: 0, by_category: [], by_priority: [], by_channel: [] }; }

  // ═══════════════════════════════════════════════════════════
  // QUEUE
  // ═══════════════════════════════════════════════════════════

  async function enqueue(env, { notificationId, userId, channel, priority, payload }) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return;
    try {
      await queryDb(env, `
        INSERT INTO notification_queue (notification_id, user_id, channel, priority, status, payload, created_at)
        VALUES ($1, $2, $3, $4, 'pending', $5, NOW())
      `, [notificationId, String(userId), channel, priority, JSON.stringify(payload || {})]);
    } catch (e) { console.warn('Notification enqueue error:', e.message); }
  }

  async function processQueue(env, sendTelegramMessageFn) {
    await ensureSchema(env);
    if (!isDatabaseConfigured(env)) return { processed: 0 };
    const queue = await queryDb(env, `
      SELECT * FROM notification_queue
      WHERE status = 'pending' AND attempts < max_attempts
      AND (next_retry_at IS NULL OR next_retry_at <= NOW())
      ORDER BY priority DESC, created_at ASC
      LIMIT 50
    `);
    let processed = 0;
    for (const item of queue.rows) {
      try {
        const payload = item.payload || {};
        const text = `${payload.title ? payload.title + '\n' : ''}${payload.message || ''}`;
        if (item.channel === 'telegram' && sendTelegramMessageFn) {
          await sendTelegramMessageFn(env, {
            chat_id: item.user_id,
            text,
            parse_mode: 'HTML',
          });
        }
        await queryDb(env, `UPDATE notification_queue SET status = 'processed', processed_at = NOW() WHERE id = $1`, [item.id]);
        processed++;
      } catch (e) {
        await queryDb(env, `UPDATE notification_queue SET attempts = attempts + 1, error = $2, next_retry_at = NOW() + INTERVAL '60 seconds' WHERE id = $1`, [item.id, e.message?.substring(0, 200)]);
      }
    }
    return { processed };
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
      analysis: r.analysis, calendar: r.calendar, price_alert: r.price_alert,
      market: r.market, news: r.news, referral: r.referral,
      reward: r.reward, ticket: r.ticket, system: r.system, marketing: r.marketing,
    };
  }

  function _defaultSettings() {
    return { analysis: true, calendar: false, price_alert: false, market: true, news: true, referral: true, reward: true, ticket: true, system: true, marketing: false };
  }

  return Object.freeze({
    ensureSchema,
    dispatch,
    listForUser,
    getUnreadCount,
    markRead,
    markAllRead,
    archive,
    deleteNotification,
    getSettings,
    updateSettings,
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
  });
}

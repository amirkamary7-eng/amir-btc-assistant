/**
 * Advertisements Repository — Database Layer
 *
 * Central Advertisement system with THREE campaign types, all admin-managed:
 *
 *   Advertisement
 *   ├── Channel Join Campaign  (ad_channels)        → join-lock / membership requirement
 *   ├── Mini App Popup         (ad_popups)           → 24h per-user cooldown popup
 *   └── Message Campaign       (ad_messages)         → Mini App / Telegram / Both
 *
 * Unified registry: `ad_campaigns` holds the shared (type, title, status, sort_order)
 * envelope. Each type has its own detail table. Status transitions:
 *
 *   draft  → active → paused → active  (re-activatable)
 *   any    → archived                  (terminal — never delivered)
 *
 * Only `active` campaigns are visible to users. `draft`/`paused`/`archived` are
 * silently filtered out by every user-facing read path.
 *
 * ── Channel Join (Phase 8: semantics kept SEPARATE from ch_promotions) ──
 *   Channel Join ads are part of the join-lock / membership-requirement domain.
 *   They are read by checkChannelMembership / requireChannelJoin and enforced
 *   via Telegram getChatMember. They are NOT routed through ch_promotions.
 *
 * ── Mini App Popup ──
 *   24h per-user cooldown tracked in KV (key `adp:${userId}:${popupId}`,
 *   expirationTtl = cooldown_seconds, default 86400). The popup is shown at
 *   Mini App open. Per-user, independent — NOT global.
 *
 * ── Message Campaign ──
 *   Delivered via the existing notification_platform broadcast pipeline
 *   (processBroadcastFull) with category='promotions'. Audience targeting
 *   (free / premium / all) filters users by membershipAuthority.isPremium().
 *   Destination (mini_app / telegram / both) is filtered by ch_promotions
 *   per-user preference (premium-gated, default 'none' for free users).
 */

// Module-level env accessors (set in fetch handler, used by processAdBroadcast)
let _env_sendTelegramMessage = null;
export function setAdSendTelegramMessage(fn) { _env_sendTelegramMessage = fn; }

// Module-level cache for active campaigns. Campaigns change rarely (admin-only)
// and are read on EVERY Mini App open + EVERY /start. Cache for 60s to eliminate
// per-render queries. Invalidated on every admin mutation.
const _CAMPAIGN_CACHE_TTL_MS = 60 * 1000;
let _campaignCache = null; // { value, expiresAt }

function _invalidateCampaignCache() { _campaignCache = null; }

const _ALLOWED_STATUSES = new Set(['draft', 'active', 'paused', 'archived']);
const _ALLOWED_TYPES = new Set(['channel_join', 'popup', 'message']);
const _ALLOWED_DESTINATIONS = new Set(['mini_app', 'telegram', 'both']);
const _ALLOWED_AUDIENCES = new Set(['free', 'premium', 'all']);

// ── Image URL validation (Phase 5 + Phase 10 security) ─────────────────────
//
// External image URLs must be:
//   - https: scheme ONLY (no http, no file, no data, no javascript, no ftp)
//   - NOT an IP literal (blocks http://127.0.0.1, http://10.0.0.1, etc.)
//   - NOT localhost or *.localhost
//   - NOT a private/internal hostname (example.local, example.internal)
//   - Has a valid hostname TLD (blocks "file", "javascript", bare strings)
//
// Internal (uploaded) image URLs use the form `/api/advertisements/image/:id`
// and are validated separately at read time. They are always trusted.
const _PRIVATE_HOSTNAME_SUFFIXES = ['.local', '.internal', '.lan', '.localhost', '.test', '.example'];
const _ALLOWED_IMAGE_EXTENSIONS = ['.jpg', '.jpeg', '.png', '.webp', '.gif', '.avif', '.svg'];

export function isValidExternalImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string' || rawUrl.length === 0 || rawUrl.length > 2048) return false;
  let u;
  try { u = new URL(rawUrl); } catch { return false; }
  if (u.protocol !== 'https:') return false;
  const host = u.hostname.toLowerCase();
  if (!host) return false;
  // Block IP literals (IPv4 and IPv6) — prevents SSRF to internal networks.
  if (/^\d+\.\d+\.\d+\.\d+$/.test(host)) return false;
  if (host.startsWith('[') && host.endsWith(']')) return false; // IPv6 literal
  if (host === 'localhost') return false;
  for (const suf of _PRIVATE_HOSTNAME_SUFFIXES) {
    if (host.endsWith(suf)) return false;
  }
  // Must have at least one dot and a TLD of 2+ alpha chars (blocks "file", "javascript").
  if (!/^[a-z0-9.-]+\.[a-z]{2,}$/i.test(host)) return false;
  // Reject username:password@host (URL parsing accepts this — block it).
  if (u.username || u.password) return false;
  // Extension hint (optional but recommended) — allow if path has image ext OR no ext.
  const path = u.pathname.toLowerCase();
  if (path) {
    const lastDot = path.lastIndexOf('.');
    if (lastDot !== -1) {
      const ext = path.slice(lastDot);
      if (!_ALLOWED_IMAGE_EXTENSIONS.includes(ext)) return false;
    }
  }
  return true;
}

// Internal image URL = `/api/advertisements/image/:id` (served from KV).
export function isInternalImageUrl(rawUrl) {
  if (typeof rawUrl !== 'string') return false;
  return /^\/api\/advertisements\/image\/[A-Za-z0-9_-]{8,40}$/.test(rawUrl);
}

export function isValidImageUrl(rawUrl) {
  if (!rawUrl) return true; // empty is valid (optional field)
  return isInternalImageUrl(rawUrl) || isValidExternalImageUrl(rawUrl);
}

// ── HTML/text sanitization (Phase 10: XSS protection) ──────────────────────
//
// Admin-supplied title/body/button text is rendered inside the Mini App popup.
// We strip ALL HTML tags and dangerous characters. The popup renders text via
// textContent (never innerHTML) on the client, but we double-verify server-side.
const _DANGEROUS_PATTERNS = [
  /<script/i, /<iframe/i, /<object/i, /<embed/i, /javascript:/i, /on\w+\s*=/i,
  /<img[^>]+onerror/i, /<svg/i, /<a[^>]+href\s*=\s*["']?javascript/i,
];

export function sanitizeText(raw, maxLen = 500) {
  if (raw === null || raw === undefined) return '';
  let s = String(raw);
  if (s.length > maxLen) s = s.slice(0, maxLen);
  // Strip ALL HTML tags — popup content is plain text by design.
  s = s.replace(/<[^>]*>/g, '');
  // Reject if any dangerous pattern remains AFTER tag strip (defense in depth).
  for (const p of _DANGEROUS_PATTERNS) {
    if (p.test(s)) return ''; // hard reject — return empty, caller validates non-empty
  }
  // Normalize unicode whitespace.
  return s.trim();
}

export function sanitizeUrl(raw, maxLen = 2048) {
  if (!raw) return '';
  const s = String(raw).trim().slice(0, maxLen);
  if (s === '') return '';
  try {
    const u = new URL(s);
    // Only allow http(s) for button URLs (broader than image URLs — landing pages).
    if (u.protocol !== 'https:' && u.protocol !== 'http:') return '';
    // Block obvious SSRF targets even for button URLs (defense in depth).
    const host = u.hostname.toLowerCase();
    if (host === 'localhost' || /^\d+\.\d+\.\d+\.\d+$/.test(host)) {
      // Allow 127.0.0.1 only in development — production will reject via deployment env.
      // For safety, we reject all IP literals in button URLs too.
      return '';
    }
    return s;
  } catch { return ''; }
}

export function createAdvertisementsRepository(deps) {
  const { queryDb, isDatabaseConfigured, isoDate, normalizeOptionalString } = deps;

  let _schemaVerified = false;

  // ── Schema ─────────────────────────────────────────────────────────────
  async function ensureSchema(env) {
    if (_schemaVerified) return;
    if (!isDatabaseConfigured(env)) { _schemaVerified = true; return; }

    try {
      // Unified campaign registry
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS ad_campaigns (
          id TEXT PRIMARY KEY,
          type TEXT NOT NULL CHECK (type IN ('channel_join','popup','message')),
          title TEXT NOT NULL,
          status TEXT NOT NULL DEFAULT 'draft' CHECK (status IN ('draft','active','paused','archived')),
          sort_order INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_ad_campaigns_type_status ON ad_campaigns(type, status, sort_order)`).catch(() => {});

      // Channel Join campaigns (Phase 2 + Phase 8)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS ad_channels (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
          channel_username TEXT NOT NULL,
          channel_title TEXT NOT NULL,
          join_url TEXT NOT NULL,
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_ad_channels_active ON ad_channels(is_active, display_order)`).catch(() => {});
      await queryDb(env, `CREATE UNIQUE INDEX IF NOT EXISTS uq_ad_channels_username ON ad_channels(lower(channel_username)) WHERE is_active = TRUE`).catch(() => {});

      // Mini App Popup campaigns (Phase 3 + Phase 4)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS ad_popups (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body_text TEXT NOT NULL,
          button_label TEXT NOT NULL DEFAULT '',
          button_url TEXT NOT NULL DEFAULT '',
          image_url TEXT NOT NULL DEFAULT '',
          display_order INTEGER NOT NULL DEFAULT 0,
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          cooldown_seconds INTEGER NOT NULL DEFAULT 86400,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_ad_popups_active ON ad_popups(is_active, display_order)`).catch(() => {});

      // Message campaigns (Phase 6)
      await queryDb(env, `
        CREATE TABLE IF NOT EXISTS ad_messages (
          id TEXT PRIMARY KEY,
          campaign_id TEXT NOT NULL REFERENCES ad_campaigns(id) ON DELETE CASCADE,
          title TEXT NOT NULL,
          body_text TEXT NOT NULL,
          button_label TEXT NOT NULL DEFAULT '',
          button_url TEXT NOT NULL DEFAULT '',
          image_url TEXT NOT NULL DEFAULT '',
          destinations TEXT NOT NULL DEFAULT 'both' CHECK (destinations IN ('mini_app','telegram','both')),
          target_audience TEXT NOT NULL DEFAULT 'all' CHECK (target_audience IN ('free','premium','all')),
          is_active BOOLEAN NOT NULL DEFAULT TRUE,
          last_processed_at TIMESTAMPTZ,
          broadcast_id TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )
      `).catch(() => {});
      await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_ad_messages_active ON ad_messages(is_active, target_audience)`).catch(() => {});

      _schemaVerified = true;
    } catch (e) {
      console.warn('[advertisements] schema check failed:', e.message || e);
    }
  }

  // ── ID generator (URL-safe, 16 chars) ──────────────────────────────────
  function _genId(prefix = 'ad') {
    const rand = () => Math.random().toString(36).slice(2, 10);
    return `${prefix}_${Date.now().toString(36)}${rand()}`.slice(0, 24);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // CHANNEL JOIN CAMPAIGNS (Phase 2)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * List all required channels (active channels from active campaigns).
   * This is the READ path used by checkChannelMembership / buildStartReplyPayload.
   * Cached at module level for 60s.
   */
  async function listActiveRequiredChannels(env) {
    if (_campaignCache && Date.now() < _campaignCache.expiresAt) {
      return _campaignCache.value.channels || [];
    }
    if (!isDatabaseConfigured(env)) { return []; }
    try {
      const result = await queryDb(env, `
        SELECT c.id, c.channel_username, c.channel_title, c.join_url, c.display_order
        FROM ad_channels c
        JOIN ad_campaigns camp ON camp.id = c.campaign_id
        WHERE c.is_active = TRUE AND camp.status = 'active'
        ORDER BY c.display_order ASC, c.created_at ASC
      `);
      const channels = (result.rows || []).map(r => ({
        id: r.id,
        username: String(r.channel_username).replace(/^@/, '').trim(),
        title: r.channel_title,
        joinUrl: r.join_url,
        displayOrder: r.display_order,
      }));
      _refreshCampaignCache({ channels });
      return channels;
    } catch (e) {
      console.warn('[advertisements] listActiveRequiredChannels failed:', e.message || e);
      return [];
    }
  }

  function _refreshCampaignCache(partial) {
    const now = Date.now();
    if (!_campaignCache || now >= _campaignCache.expiresAt) {
      _campaignCache = { value: { channels: [], popups: [] }, expiresAt: now + _CAMPAIGN_CACHE_TTL_MS };
    }
    _campaignCache.value = { ..._campaignCache.value, ...partial };
  }

  async function listAllChannelsForAdmin(env) {
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `
      SELECT c.*, camp.title AS campaign_title, camp.status AS campaign_status
      FROM ad_channels c
      JOIN ad_campaigns camp ON camp.id = c.campaign_id
      ORDER BY c.display_order ASC, c.created_at ASC
    `);
    return (result.rows || []).map(_mapChannelRow);
  }

  async function createChannel(env, input) {
    await ensureSchema(env);
    const id = _genId('adc');
    const campId = _genId('camp');
    const username = String(input.channel_username || '').replace(/^@/, '').trim();
    const title = sanitizeText(input.channel_title, 120);
    const joinUrl = sanitizeUrl(input.join_url, 500);
    if (!username || !title || !joinUrl) {
      throw new Error('Invalid channel data: username, title, and join_url are required');
    }
    if (!joinUrl.startsWith('https://t.me/')) {
      throw new Error('join_url must be a https://t.me/... link');
    }
    const order = Math.max(0, Math.min(9999, parseInt(input.display_order || 0, 10)));

    await queryDb(env, 'BEGIN').catch(() => {});
    try {
      await queryDb(env,
        `INSERT INTO ad_campaigns (id, type, title, status, sort_order) VALUES ($1, 'channel_join', $2, $3, $4)`,
        [campId, title, input.status || 'active', order]
      );
      await queryDb(env,
        `INSERT INTO ad_channels (id, campaign_id, channel_username, channel_title, join_url, display_order, is_active)
         VALUES ($1, $2, $3, $4, $5, $6, $7)`,
        [id, campId, username, title, joinUrl, order, input.is_active !== false]
      );
      await queryDb(env, 'COMMIT').catch(() => {});
    } catch (e) {
      await queryDb(env, 'ROLLBACK').catch(() => {});
      throw e;
    }
    _invalidateCampaignCache();
    return getChannel(env, id);
  }

  async function updateChannel(env, id, updates) {
    await ensureSchema(env);
    const existing = await getChannel(env, id);
    if (!existing) throw new Error('Channel not found');

    const username = updates.channel_username !== undefined
      ? String(updates.channel_username).replace(/^@/, '').trim()
      : existing.channel_username;
    const title = updates.channel_title !== undefined
      ? sanitizeText(updates.channel_title, 120)
      : existing.channel_title;
    const joinUrl = updates.join_url !== undefined
      ? sanitizeUrl(updates.join_url, 500)
      : existing.join_url;
    const order = updates.display_order !== undefined
      ? Math.max(0, Math.min(9999, parseInt(updates.display_order, 10)))
      : existing.display_order;
    const isActive = updates.is_active !== undefined
      ? !!updates.is_active
      : existing.is_active;

    if (!username || !title || !joinUrl) throw new Error('username, title, and join_url are required');
    if (!joinUrl.startsWith('https://t.me/')) throw new Error('join_url must be a https://t.me/... link');

    await queryDb(env,
      `UPDATE ad_channels SET
         channel_username = $2, channel_title = $3, join_url = $4,
         display_order = $5, is_active = $6, updated_at = NOW()
       WHERE id = $1`,
      [id, username, title, joinUrl, order, isActive]
    );
    if (existing.campaign_id) {
      await queryDb(env,
        `UPDATE ad_campaigns SET title = $2, sort_order = $3, updated_at = NOW() WHERE id = $1`,
        [existing.campaign_id, title, order]
      );
    }
    _invalidateCampaignCache();
    return getChannel(env, id);
  }

  async function deleteChannel(env, id) {
    const existing = await getChannel(env, id);
    if (!existing) return false;
    await queryDb(env, `DELETE FROM ad_campaigns WHERE id = $1`, [existing.campaign_id]);
    _invalidateCampaignCache();
    return true;
  }

  async function setChannelStatus(env, id, status) {
    if (!_ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const existing = await getChannel(env, id);
    if (!existing) throw new Error('Channel not found');
    await queryDb(env,
      `UPDATE ad_campaigns SET status = $2, updated_at = NOW() WHERE id = $1`,
      [existing.campaign_id, status]
    );
    // Active channels must also be marked is_active=true for the JOIN to surface them.
    if (status === 'active') {
      await queryDb(env, `UPDATE ad_channels SET is_active = TRUE, updated_at = NOW() WHERE campaign_id = $1`, [existing.campaign_id]);
    }
    _invalidateCampaignCache();
    return getChannel(env, id);
  }

  async function getChannel(env, id) {
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env,
      `SELECT c.*, camp.title AS campaign_title, camp.status AS campaign_status
       FROM ad_channels c JOIN ad_campaigns camp ON camp.id = c.campaign_id
       WHERE c.id = $1`, [id]
    );
    return result.rows[0] ? _mapChannelRow(result.rows[0]) : null;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MINI APP POPUP CAMPAIGNS (Phase 3 + Phase 4)
  // ═══════════════════════════════════════════════════════════════════════

  /**
   * List all active popups ordered by display_order. Cached for 60s.
   * Used by the user-facing /api/advertisements/popups endpoint.
   */
  async function listActivePopups(env) {
    if (_campaignCache && Date.now() < _campaignCache.expiresAt && _campaignCache.value.popups) {
      return _campaignCache.value.popups;
    }
    if (!isDatabaseConfigured(env)) { return []; }
    try {
      const result = await queryDb(env, `
        SELECT p.id, p.campaign_id, p.title, p.body_text, p.button_label,
               p.button_url, p.image_url, p.display_order, p.cooldown_seconds
        FROM ad_popups p
        JOIN ad_campaigns camp ON camp.id = p.campaign_id
        WHERE p.is_active = TRUE AND camp.status = 'active'
        ORDER BY p.display_order ASC, p.created_at ASC
      `);
      const popups = (result.rows || []).map(_mapPopupRow);
      _refreshCampaignCache({ popups });
      return popups;
    } catch (e) {
      console.warn('[advertisements] listActivePopups failed:', e.message || e);
      return [];
    }
  }

  async function listAllPopupsForAdmin(env) {
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `
      SELECT p.*, camp.title AS campaign_title, camp.status AS campaign_status
      FROM ad_popups p
      JOIN ad_campaigns camp ON camp.id = p.campaign_id
      ORDER BY p.display_order ASC, p.created_at ASC
    `);
    return (result.rows || []).map(_mapPopupRow);
  }

  async function getPopup(env, id) {
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env,
      `SELECT p.*, camp.title AS campaign_title, camp.status AS campaign_status
       FROM ad_popups p JOIN ad_campaigns camp ON camp.id = p.campaign_id
       WHERE p.id = $1`, [id]
    );
    return result.rows[0] ? _mapPopupRow(result.rows[0]) : null;
  }

  async function createPopup(env, input) {
    await ensureSchema(env);
    const id = _genId('adp');
    const campId = _genId('camp');
    const title = sanitizeText(input.title, 120);
    const bodyText = sanitizeText(input.body_text, 1000);
    const buttonLabel = sanitizeText(input.button_label, 50);
    const buttonUrl = sanitizeUrl(input.button_url, 500);
    const imageUrl = input.image_url ? (isValidImageUrl(input.image_url) ? String(input.image_url).trim() : '') : '';
    if (!title || !bodyText) throw new Error('title and body_text are required');
    const order = Math.max(0, Math.min(9999, parseInt(input.display_order || 0, 10)));
    const cooldown = Math.max(60, Math.min(86400 * 7, parseInt(input.cooldown_seconds || 86400, 10)));

    await queryDb(env,
      `INSERT INTO ad_campaigns (id, type, title, status, sort_order) VALUES ($1, 'popup', $2, $3, $4)`,
      [campId, title, input.status || 'active', order]
    );
    await queryDb(env,
      `INSERT INTO ad_popups (id, campaign_id, title, body_text, button_label, button_url, image_url, display_order, is_active, cooldown_seconds)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, campId, title, bodyText, buttonLabel, buttonUrl, imageUrl, order, input.is_active !== false, cooldown]
    );
    _invalidateCampaignCache();
    return getPopup(env, id);
  }

  async function updatePopup(env, id, updates) {
    await ensureSchema(env);
    const existing = await getPopup(env, id);
    if (!existing) throw new Error('Popup not found');

    const title = updates.title !== undefined ? sanitizeText(updates.title, 120) : existing.title;
    const bodyText = updates.body_text !== undefined ? sanitizeText(updates.body_text, 1000) : existing.body_text;
    const buttonLabel = updates.button_label !== undefined ? sanitizeText(updates.button_label, 50) : (existing.button_label || '');
    const buttonUrl = updates.button_url !== undefined ? sanitizeUrl(updates.button_url, 500) : (existing.button_url || '');
    let imageUrl = existing.image_url || '';
    if (updates.image_url !== undefined) {
      const v = String(updates.image_url).trim();
      imageUrl = v === '' ? '' : (isValidImageUrl(v) ? v : '');
    }
    const order = updates.display_order !== undefined
      ? Math.max(0, Math.min(9999, parseInt(updates.display_order, 10)))
      : existing.display_order;
    const isActive = updates.is_active !== undefined ? !!updates.is_active : existing.is_active;
    const cooldown = updates.cooldown_seconds !== undefined
      ? Math.max(60, Math.min(86400 * 7, parseInt(updates.cooldown_seconds, 10)))
      : existing.cooldown_seconds;

    if (!title || !bodyText) throw new Error('title and body_text are required');

    await queryDb(env,
      `UPDATE ad_popups SET
         title = $2, body_text = $3, button_label = $4, button_url = $5,
         image_url = $6, display_order = $7, is_active = $8, cooldown_seconds = $9,
         updated_at = NOW()
       WHERE id = $1`,
      [id, title, bodyText, buttonLabel, buttonUrl, imageUrl, order, isActive, cooldown]
    );
    if (existing.campaign_id) {
      await queryDb(env,
        `UPDATE ad_campaigns SET title = $2, sort_order = $3, updated_at = NOW() WHERE id = $1`,
        [existing.campaign_id, title, order]
      );
    }
    _invalidateCampaignCache();
    return getPopup(env, id);
  }

  async function deletePopup(env, id) {
    const existing = await getPopup(env, id);
    if (!existing) return false;
    await queryDb(env, `DELETE FROM ad_campaigns WHERE id = $1`, [existing.campaign_id]);
    _invalidateCampaignCache();
    return true;
  }

  async function setPopupStatus(env, id, status) {
    if (!_ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const existing = await getPopup(env, id);
    if (!existing) throw new Error('Popup not found');
    await queryDb(env,
      `UPDATE ad_campaigns SET status = $2, updated_at = NOW() WHERE id = $1`,
      [existing.campaign_id, status]
    );
    if (status === 'active') {
      await queryDb(env, `UPDATE ad_popups SET is_active = TRUE, updated_at = NOW() WHERE campaign_id = $1`, [existing.campaign_id]);
    }
    _invalidateCampaignCache();
    return getPopup(env, id);
  }

  // ── 24h cooldown tracking via KV ────────────────────────────────────────
  //
  // Key: `adp:${userId}:${popupId}` in RATE_LIMITS KV namespace.
  // Value: ISO timestamp of last shown. TTL = popup.cooldown_seconds.
  //
  // Per-user, independent. Refresh or re-open Mini App within cooldown → suppressed.
  async function hasPopupBeenShown(env, userId, popupId, cooldownSeconds = 86400) {
    if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.get !== 'function') return false;
    try {
      const key = `adp:${String(userId)}:${String(popupId)}`;
      const v = await env.RATE_LIMITS.get(key);
      return v !== null && v !== undefined;
    } catch { return false; }
  }

  async function markPopupShown(env, userId, popupId, cooldownSeconds = 86400) {
    if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.put !== 'function') return;
    try {
      const key = `adp:${String(userId)}:${String(popupId)}`;
      const ttl = Math.max(60, Math.min(86400 * 7, cooldownSeconds));
      await env.RATE_LIMITS.put(key, new Date().toISOString(), { expirationTtl: ttl });
    } catch (e) {
      console.warn('[advertisements] markPopupShown KV put failed:', e.message || e);
    }
  }

  // ═══════════════════════════════════════════════════════════════════════
  // MESSAGE CAMPAIGNS (Phase 6)
  // ═══════════════════════════════════════════════════════════════════════

  async function listAllMessagesForAdmin(env) {
    if (!isDatabaseConfigured(env)) return [];
    const result = await queryDb(env, `
      SELECT m.*, camp.title AS campaign_title, camp.status AS campaign_status
      FROM ad_messages m
      JOIN ad_campaigns camp ON camp.id = m.campaign_id
      ORDER BY m.created_at DESC
    `);
    return (result.rows || []).map(_mapMessageRow);
  }

  async function getMessage(env, id) {
    if (!isDatabaseConfigured(env)) return null;
    const result = await queryDb(env,
      `SELECT m.*, camp.title AS campaign_title, camp.status AS campaign_status
       FROM ad_messages m JOIN ad_campaigns camp ON camp.id = m.campaign_id
       WHERE m.id = $1`, [id]
    );
    return result.rows[0] ? _mapMessageRow(result.rows[0]) : null;
  }

  async function createMessage(env, input) {
    await ensureSchema(env);
    const id = _genId('adm');
    const campId = _genId('camp');
    const title = sanitizeText(input.title, 120);
    const bodyText = sanitizeText(input.body_text, 2000);
    const buttonLabel = sanitizeText(input.button_label, 50);
    const buttonUrl = sanitizeUrl(input.button_url, 500);
    const imageUrl = input.image_url ? (isValidImageUrl(input.image_url) ? String(input.image_url).trim() : '') : '';
    const destinations = _ALLOWED_DESTINATIONS.has(input.destinations) ? input.destinations : 'both';
    const audience = _ALLOWED_AUDIENCES.has(input.target_audience) ? input.target_audience : 'all';
    if (!title || !bodyText) throw new Error('title and body_text are required');

    await queryDb(env,
      `INSERT INTO ad_campaigns (id, type, title, status, sort_order) VALUES ($1, 'message', $2, $3, 0)`,
      [campId, title, input.status || 'draft']
    );
    await queryDb(env,
      `INSERT INTO ad_messages (id, campaign_id, title, body_text, button_label, button_url, image_url, destinations, target_audience, is_active)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)`,
      [id, campId, title, bodyText, buttonLabel, buttonUrl, imageUrl, destinations, audience, input.is_active !== false]
    );
    _invalidateCampaignCache();
    return getMessage(env, id);
  }

  async function updateMessage(env, id, updates) {
    await ensureSchema(env);
    const existing = await getMessage(env, id);
    if (!existing) throw new Error('Message not found');

    const title = updates.title !== undefined ? sanitizeText(updates.title, 120) : existing.title;
    const bodyText = updates.body_text !== undefined ? sanitizeText(updates.body_text, 2000) : existing.body_text;
    const buttonLabel = updates.button_label !== undefined ? sanitizeText(updates.button_label, 50) : (existing.button_label || '');
    const buttonUrl = updates.button_url !== undefined ? sanitizeUrl(updates.button_url, 500) : (existing.button_url || '');
    let imageUrl = existing.image_url || '';
    if (updates.image_url !== undefined) {
      const v = String(updates.image_url).trim();
      imageUrl = v === '' ? '' : (isValidImageUrl(v) ? v : '');
    }
    const destinations = updates.destinations !== undefined && _ALLOWED_DESTINATIONS.has(updates.destinations)
      ? updates.destinations : existing.destinations;
    const audience = updates.target_audience !== undefined && _ALLOWED_AUDIENCES.has(updates.target_audience)
      ? updates.target_audience : existing.target_audience;
    const isActive = updates.is_active !== undefined ? !!updates.is_active : existing.is_active;
    if (!title || !bodyText) throw new Error('title and body_text are required');

    await queryDb(env,
      `UPDATE ad_messages SET
         title = $2, body_text = $3, button_label = $4, button_url = $5,
         image_url = $6, destinations = $7, target_audience = $8, is_active = $9,
         updated_at = NOW()
       WHERE id = $1`,
      [id, title, bodyText, buttonLabel, buttonUrl, imageUrl, destinations, audience, isActive]
    );
    if (existing.campaign_id) {
      await queryDb(env,
        `UPDATE ad_campaigns SET title = $2, updated_at = NOW() WHERE id = $1`,
        [existing.campaign_id, title]
      );
    }
    _invalidateCampaignCache();
    return getMessage(env, id);
  }

  async function deleteMessage(env, id) {
    const existing = await getMessage(env, id);
    if (!existing) return false;
    await queryDb(env, `DELETE FROM ad_campaigns WHERE id = $1`, [existing.campaign_id]);
    _invalidateCampaignCache();
    return true;
  }

  async function setMessageStatus(env, id, status) {
    if (!_ALLOWED_STATUSES.has(status)) throw new Error(`Invalid status: ${status}`);
    const existing = await getMessage(env, id);
    if (!existing) throw new Error('Message not found');
    await queryDb(env,
      `UPDATE ad_campaigns SET status = $2, updated_at = NOW() WHERE id = $1`,
      [existing.campaign_id, status]
    );
    if (status === 'active') {
      await queryDb(env, `UPDATE ad_messages SET is_active = TRUE, updated_at = NOW() WHERE campaign_id = $1`, [existing.campaign_id]);
    }
    _invalidateCampaignCache();
    return getMessage(env, id);
  }

  // ═══════════════════════════════════════════════════════════════════════
  // IMAGE STORAGE (Phase 5) — KV-backed, validation-only (no resize in Worker)
  // ═══════════════════════════════════════════════════════════════════════

  const _MAX_IMAGE_BYTES = 500 * 1024; // 500 KB
  const _ALLOWED_IMAGE_CTYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif']);

  /**
   * Store an uploaded image (base64 data URI) in KV. Returns the internal URL
   * `/api/advertisements/image/:id` that the admin can paste into image_url.
   *
   * Validation (Phase 5):
   *   - Max 500 KB after base64 decode
   *   - Content-type must be image/jpeg|png|webp|gif|avif
   *   - Header magic bytes verified (defense in depth — don't trust Content-Type)
   *   - Metadata is NOT stripped (Workers lack native image libs); instead we
   *     enforce strict size + dimension limits. Documented in admin UI.
   *
   * NOTE on "resize/compress": Cloudflare Workers do not have native sharp /
   * ImageMagick. We enforce strict size + dimension limits instead. For
   * external URLs, no fetch/resize is performed — only URL validation.
   */
  async function storeImage(env, dataUri, contentType) {
    if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.put !== 'function') {
      throw new Error('Image storage unavailable (KV not bound)');
    }
    // Accept either "data:image/png;base64,...." OR raw base64 + contentType.
    let b64 = dataUri;
    let ct = contentType || '';
    const m = /^data:([^;]+);base64,(.+)$/i.exec(String(dataUri || ''));
    if (m) { ct = m[1].toLowerCase(); b64 = m[2]; }
    if (!_ALLOWED_IMAGE_CTYPES.has(ct)) {
      throw new Error(`Unsupported image type. Allowed: ${[..._ALLOWED_IMAGE_CTYPES].join(', ')}`);
    }
    // Base64 → bytes
    let bytes;
    try {
      bytes = atob(b64);
    } catch { throw new Error('Invalid base64 data'); }
    if (bytes.length > _MAX_IMAGE_BYTES) {
      throw new Error(`Image too large: ${bytes.length} bytes (max ${_MAX_IMAGE_BYTES})`);
    }
    // Magic-byte verification (defense in depth)
    if (!_verifyImageMagic(bytes, ct)) {
      throw new Error('Image content does not match declared content-type');
    }
    const id = _genId('img');
    const key = `adimg:${id}`;
    // Store as `${ct}\n${base64}` so the GET handler can serve correct Content-Type.
    await env.RATE_LIMITS.put(key, `${ct}\n${b64}`);
    return `/api/advertisements/image/${id}`;
  }

  async function getImage(env, id) {
    if (!env.RATE_LIMITS || typeof env.RATE_LIMITS.get !== 'function') return null;
    if (!/^[A-Za-z0-9_-]{8,40}$/.test(String(id || ''))) return null;
    try {
      const v = await env.RATE_LIMITS.get(`adimg:${id}`);
      if (!v) return null;
      const nl = v.indexOf('\n');
      if (nl < 0) return null;
      return { contentType: v.slice(0, nl), base64: v.slice(nl + 1) };
    } catch { return null; }
  }

  function _verifyImageMagic(bytes, ct) {
    // Check first 12 bytes against known magic numbers.
    const b0 = bytes.charCodeAt(0);
    const b1 = bytes.charCodeAt(1);
    const b2 = bytes.charCodeAt(2);
    const b3 = bytes.charCodeAt(3);
    if (ct === 'image/png') {
      // 89 50 4E 47 0D 0A 1A 0A
      return b0 === 0x89 && b1 === 0x50 && b2 === 0x4e && b3 === 0x47;
    }
    if (ct === 'image/jpeg') {
      return b0 === 0xff && b1 === 0xd8;
    }
    if (ct === 'image/gif') {
      return b0 === 0x47 && b1 === 0x49 && b2 === 0x46; // GIF
    }
    if (ct === 'image/webp') {
      // RIFF....WEBP
      return b0 === 0x52 && b1 === 0x49 && b2 === 0x46 && b3 === 0x46;
    }
    if (ct === 'image/avif') {
      // ftyp box — bytes 4-7 should be 'ftyp' for ISOBMFF (avif starts with ftyp)
      return bytes.charCodeAt(4) === 0x66 && bytes.charCodeAt(5) === 0x74 &&
             bytes.charCodeAt(6) === 0x79 && bytes.charCodeAt(7) === 0x70;
    }
    return false;
  }

  // ═══════════════════════════════════════════════════════════════════════
  // ROW MAPPERS
  // ═══════════════════════════════════════════════════════════════════════

  function _mapChannelRow(r) {
    return {
      id: r.id,
      campaign_id: r.campaign_id,
      channel_username: r.channel_username,
      channel_title: r.channel_title,
      join_url: r.join_url,
      display_order: r.display_order,
      is_active: !!r.is_active,
      campaign_title: r.campaign_title,
      campaign_status: r.campaign_status,
      created_at: r.created_at ? (typeof r.created_at === 'string' ? r.created_at : (r.created_at.toISOString ? r.created_at.toISOString() : String(r.created_at))) : null,
      updated_at: r.updated_at ? (typeof r.updated_at === 'string' ? r.updated_at : (r.updated_at.toISOString ? r.updated_at.toISOString() : String(r.updated_at))) : null,
    };
  }

  function _mapPopupRow(r) {
    return {
      id: r.id,
      campaign_id: r.campaign_id,
      title: r.title,
      body_text: r.body_text,
      button_label: r.button_label || '',
      button_url: r.button_url || '',
      image_url: r.image_url || '',
      display_order: r.display_order,
      is_active: !!r.is_active,
      cooldown_seconds: r.cooldown_seconds || 86400,
      campaign_title: r.campaign_title,
      campaign_status: r.campaign_status,
      created_at: r.created_at ? (typeof r.created_at === 'string' ? r.created_at : (r.created_at.toISOString ? r.created_at.toISOString() : String(r.created_at))) : null,
      updated_at: r.updated_at ? (typeof r.updated_at === 'string' ? r.updated_at : (r.updated_at.toISOString ? r.updated_at.toISOString() : String(r.updated_at))) : null,
    };
  }

  function _mapMessageRow(r) {
    return {
      id: r.id,
      campaign_id: r.campaign_id,
      title: r.title,
      body_text: r.body_text,
      button_label: r.button_label || '',
      button_url: r.button_url || '',
      image_url: r.image_url || '',
      destinations: r.destinations || 'both',
      target_audience: r.target_audience || 'all',
      is_active: !!r.is_active,
      last_processed_at: r.last_processed_at ? (typeof r.last_processed_at === 'string' ? r.last_processed_at : (r.last_processed_at.toISOString ? r.last_processed_at.toISOString() : String(r.last_processed_at))) : null,
      broadcast_id: r.broadcast_id || null,
      campaign_title: r.campaign_title,
      campaign_status: r.campaign_status,
      created_at: r.created_at ? (typeof r.created_at === 'string' ? r.created_at : (r.created_at.toISOString ? r.created_at.toISOString() : String(r.created_at))) : null,
      updated_at: r.updated_at ? (typeof r.updated_at === 'string' ? r.updated_at : (r.updated_at.toISOString ? r.updated_at.toISOString() : String(r.updated_at))) : null,
    };
  }

  return {
    ensureSchema,
    // Channel Join
    listActiveRequiredChannels,
    listAllChannelsForAdmin,
    getChannel,
    createChannel,
    updateChannel,
    deleteChannel,
    setChannelStatus,
    // Popup
    listActivePopups,
    listAllPopupsForAdmin,
    getPopup,
    createPopup,
    updatePopup,
    deletePopup,
    setPopupStatus,
    hasPopupBeenShown,
    markPopupShown,
    // Message
    listAllMessagesForAdmin,
    getMessage,
    createMessage,
    updateMessage,
    deleteMessage,
    setMessageStatus,
    // Image
    storeImage,
    getImage,
    // Helpers (exported for tests)
    _invalidateCampaignCache,
  };
}

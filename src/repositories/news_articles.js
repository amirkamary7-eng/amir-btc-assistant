/**
 * News Articles Repository — Permanent Storage Layer
 *
 * Stores AI-generated news summaries permanently in PostgreSQL.
 * This prevents duplicate AI processing: once an article is analyzed,
 * its summary is stored forever in the DB (no TTL expiry like KV).
 *
 * KV (news:ai:{hash}) is still used as a fast-read cache (7-day TTL),
 * but the DB is the source of truth. If KV expires, the DB is checked
 * before calling AI.
 *
 * Table: news_articles
 *   id          = fingerprint (hash of source + normalized_title + url)
 *   url         = original article URL
 *   title       = translated/processed title
 *   title_en    = original English title
 *   source      = RSS source name
 *   category    = crypto/forex/economy
 *   summary     = AI-generated Persian summary
 *   sentiment   = bullish/bearish/neutral
 *   impact      = high/medium/low
 *   impact_reason = AI-generated reason (Persian)
 *   coins       = related coin symbols (JSON array)
 *   provider    = gemini/workers-ai
 *   analyzed_at = timestamp of AI analysis
 *   created_at  = timestamp of DB insert
 *
 * Dependencies: queryDb (from worker-proxy.js)
 */
export function createNewsArticleRepository(deps) {
  const { queryDb } = deps;

  let _tableEnsured = false;

  /**
   * Create the news_articles table if it doesn't exist.
   * Called once per isolate (cached by _tableEnsured flag).
   * NOT called from cron — only from the first HTTP request that needs it,
   * or manually via migration script.
   */
  async function ensureTable(env) {
    if (_tableEnsured) return;
    await queryDb(env, `
      CREATE TABLE IF NOT EXISTS news_articles (
        id VARCHAR(64) PRIMARY KEY,
        url TEXT NOT NULL,
        title TEXT NOT NULL,
        title_en TEXT,
        source VARCHAR(64),
        category VARCHAR(32) DEFAULT 'crypto',
        summary TEXT,
        sentiment VARCHAR(32) DEFAULT 'neutral',
        impact VARCHAR(32) DEFAULT 'low',
        impact_reason TEXT,
        coins TEXT,
        provider VARCHAR(32),
        analyzed_at TIMESTAMPTZ DEFAULT NOW(),
        created_at TIMESTAMPTZ DEFAULT NOW(),
        UNIQUE(url)
      )
    `, []);
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_news_articles_url ON news_articles (url)`, []).catch(() => {});
    await queryDb(env, `CREATE INDEX IF NOT EXISTS idx_news_articles_created ON news_articles (created_at DESC)`, []).catch(() => {});
    _tableEnsured = true;
  }

  /**
   * Generate a stable fingerprint for a news article.
   * Uses: source + normalized title + url
   * This ensures the same article from the same RSS feed always gets
   * the same fingerprint, even if KV cache expires.
   */
  function fingerprint(url, title, source) {
    const normalizedTitle = String(title || '')
      .toLowerCase()
      .replace(/[^a-z0-9\u0600-\u06FF\s]/gi, ' ')
      .replace(/\s+/g, ' ')
      .trim();
    const raw = `${String(source || '')}|${normalizedTitle}|${String(url || '')}`;
    // Same hash algorithm as hashUrl in worker-proxy.js
    let hash = 0;
    for (let i = 0; i < raw.length; i++) {
      const char = raw.charCodeAt(i);
      hash = ((hash << 5) - hash) + char;
      hash = hash & hash;
    }
    return 'na_' + Math.abs(hash).toString(36);
  }

  /**
   * Check if an article has already been analyzed (by fingerprint).
   * Returns the stored summary if found, null otherwise.
   *
   * @param {object} env - Worker env
   * @param {string} id - fingerprint
   * @returns {Promise<object|null>} - { summary, provider, sentiment, impact, impact_reason, coins } or null
   */
  async function findById(env, id) {
    try {
      const result = await queryDb(env, `
        SELECT id, url, title, summary, sentiment, impact, impact_reason, coins, provider, analyzed_at
        FROM news_articles
        WHERE id = $1
        LIMIT 1
      `, [String(id)], 1);
      return result.rows[0] || null;
    } catch (e) {
      // Table might not exist yet — return null (will be created on first write)
      return null;
    }
  }

  /**
   * Check if an article has already been analyzed (by URL).
   * Used as a fallback if fingerprint doesn't match (e.g., title changed slightly).
   *
   * @param {object} env - Worker env
   * @param {string} url - article URL
   * @returns {Promise<object|null>}
   */
  async function findByUrl(env, url) {
    try {
      const result = await queryDb(env, `
        SELECT id, url, title, summary, sentiment, impact, impact_reason, coins, provider, analyzed_at
        FROM news_articles
        WHERE url = $1
        LIMIT 1
      `, [String(url)], 1);
      return result.rows[0] || null;
    } catch (e) {
      return null;
    }
  }

  /**
   * Save an AI-generated summary permanently to the DB.
   * Uses INSERT ... ON CONFLICT DO UPDATE to handle re-analysis gracefully.
   *
   * @param {object} env - Worker env
   * @param {object} data - { id, url, title, title_en, source, category, summary, sentiment, impact, impact_reason, coins, provider }
   */
  async function saveAnalysis(env, data) {
    const {
      id, url, title, title_en, source, category,
      summary, sentiment, impact, impact_reason, coins, provider
    } = data;

    try {
      await queryDb(env, `
        INSERT INTO news_articles (id, url, title, title_en, source, category, summary, sentiment, impact, impact_reason, coins, provider, analyzed_at, created_at)
        VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, NOW(), NOW())
        ON CONFLICT (id) DO UPDATE SET
          summary = EXCLUDED.summary,
          sentiment = EXCLUDED.sentiment,
          impact = EXCLUDED.impact,
          impact_reason = EXCLUDED.impact_reason,
          coins = EXCLUDED.coins,
          provider = EXCLUDED.provider,
          analyzed_at = NOW()
      `, [
        String(id),
        String(url || ''),
        String(title || ''),
        String(title_en || ''),
        String(source || ''),
        String(category || 'crypto'),
        String(summary || ''),
        String(sentiment || 'neutral'),
        String(impact || 'low'),
        String(impact_reason || ''),
        Array.isArray(coins) ? JSON.stringify(coins) : String(coins || '[]'),
        String(provider || 'unknown'),
      ], 1);
      return true;
    } catch (e) {
      console.warn('[NEWS-ARTICLES] saveAnalysis failed:', e?.message);
      return false;
    }
  }

  /**
   * Get recent analyzed articles (for frontend display).
   *
   * @param {object} env - Worker env
   * @param {number} limit - max articles to return
   */
  async function listRecent(env, limit = 12) {
    try {
      const result = await queryDb(env, `
        SELECT id, url, title, title_en, source, category, summary, sentiment, impact, impact_reason, coins, provider, analyzed_at
        FROM news_articles
        ORDER BY analyzed_at DESC
        LIMIT $1
      `, [Number(limit)], 1);
      return result.rows.map(row => ({
        ...row,
        coins: (() => { try { return JSON.parse(row.coins || '[]'); } catch { return []; } })(),
      }));
    } catch (e) {
      return [];
    }
  }

  return Object.freeze({
    ensureTable,
    fingerprint,
    findById,
    findByUrl,
    saveAnalysis,
    listRecent,
  });
}

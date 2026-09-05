/**
 * App Content Repository — CMS for About / Terms / Privacy
 *
 * Stores section-based JSON content in PostgreSQL (app_content table).
 * KV cache (app_content:{type}:{lang}) provides fast reads with 1-hour TTL.
 *
 * BILINGUAL (FA/EN):
 *   Each row stores BOTH Persian and English content in separate columns:
 *     title / title_en
 *     sections / sections_en
 *   getContent(env, type, lang) returns the requested language's content.
 *   updateContent(env, type, data, lang) updates ONLY the requested language's
 *   columns — saving FA never touches EN, and vice versa.
 *
 * EN FALLBACK RULE (per spec):
 *   "Fallback برای EN باید انگلیسی باشد، نه فارسی."
 *   If EN columns are NULL/empty in the DB, return the English SEED_DATA
 *   (never the Persian content). This guarantees EN users never see Persian.
 *
 * Table: app_content
 *   id          = 'about' | 'terms' | 'privacy'
 *   title       = display title (Persian)
 *   sections    = JSON array of { heading, body } (Persian)
 *   title_en    = display title (English)
 *   sections_en = JSON array of { heading, body } (English)
 *   version     = app version string (separate from content)
 *   updated_at  = last modification timestamp
 *   updated_by  = admin Telegram ID
 *
 * Seeding: On first access, default content is inserted if table is empty.
 * This ensures About/Terms/Privacy are never blank.
 */
export function createAppContentRepository(deps) {
  const { queryDb, readAppCache, writeAppCache } = deps;

  let _tableEnsured = false;
  let _seeded = false;

  const CACHE_PREFIX = 'app_content:';
  const CACHE_TTL = 3600; // 1 hour

  // ── Default seed content (section-based JSON) — Persian ──
  const SEED_DATA = {
    about: {
      title: 'درباره ما',
      sections: [
        {
          heading: 'AmirBTC Assistant',
          body: 'دستیار هوشمند بازارهای مالی است که با هدف ارائه اطلاعات سریع، تحلیل‌های هوشمند و ابزارهای کاربردی برای فعالان بازار طراحی شده است.\n\nاین پلتفرم تلاش می‌کند داده‌های بازار، اخبار مهم، تحلیل هوشمند و ابزارهای مورد نیاز کاربران بازاری مالی را در یک محیط سریع، ساده و حرفه‌ای ارائه دهد.',
        },
        {
          heading: 'قابلیت‌ها',
          body: '• تحلیل هوشمند اخبار بازار\n• بررسی تاثیر اخبار روی بازار\n• دسترسی سریع به اطلاعات مهم بازار\n• ابزارهای مدیریت و پیگیری بازار\n• تجربه کاربری سریع و مدرن',
        },
        {
          heading: 'ماموریت',
          body: 'هدف ما ساخت یک ابزار حرفه‌ای برای کمک به کاربران است تا در فضای سریع و پیچیده بازارهای مالی، تصمیم‌های آگاهانه‌تری بگیرند.',
        },
      ],
      title_en: 'About Us',
      sections_en: [
        {
          heading: 'AmirBTC Assistant',
          body: 'AmirBTC Assistant is an intelligent financial markets assistant designed to provide fast information, smart analysis, and practical tools for market participants.\n\nThis platform aims to deliver market data, important news, smart analysis, and the tools financial market participants need in a fast, simple, and professional environment.',
        },
        {
          heading: 'Features',
          body: '• Smart analysis of market news\n• Assessing the impact of news on the market\n• Quick access to important market information\n• Market management and tracking tools\n• Fast and modern user experience',
        },
        {
          heading: 'Mission',
          body: 'Our goal is to build a professional tool that helps users make more informed decisions in the fast and complex environment of financial markets.',
        },
      ],
    },
    terms: {
      title: 'قوانین و شرایط استفاده',
      sections: [
        {
          heading: '۱. اطلاعات ارائه‌شده',
          body: 'اطلاعات ارائه شده در برنامه صرفاً جهت اطلاع‌رسانی و آموزش است و نباید به عنوان توصیه مالی، سرمایه‌گذاری یا تضمین سود در نظر گرفته شود.',
        },
        {
          heading: '۲. ریسک بازار',
          body: 'بازارهای مالی دارای ریسک بالا هستند و کاربران مسئول تصمیم‌های معاملاتی خود هستند.',
        },
        {
          heading: '۳. دقت تحلیل‌ها',
          body: 'تحلیل‌ها و اطلاعات تولیدشده توسط هوش مصنوعی ممکن است دارای خطا باشند و کاربران باید قبل از هر تصمیم بررسی مستقل انجام دهند.',
        },
        {
          heading: '۴. استفاده قانونی',
          body: 'استفاده از خدمات اپ باید مطابق قوانین و مقررات انجام شود.',
        },
        {
          heading: '۵. ممنوعیت سوءاستفاده',
          body: 'هرگونه سوءاستفاده، تلاش برای اختلال در سرویس یا استفاده غیرمجاز از امکانات برنامه ممنوع است.',
        },
        {
          heading: '۶. مسئولیت',
          body: 'تیم AmirBTC تلاش می‌کند اطلاعات دقیق و به‌روز ارائه دهد، اما مسئولیت تغییرات بازار یا نتایج تصمیم‌های کاربران را برعهده ندارد.',
        },
      ],
      title_en: 'Terms & Conditions',
      sections_en: [
        {
          heading: '1. Information Provided',
          body: 'The information provided in the app is for informational and educational purposes only and should not be considered as financial advice, investment recommendation, or profit guarantee.',
        },
        {
          heading: '2. Market Risk',
          body: 'Financial markets carry high risk, and users are responsible for their own trading decisions.',
        },
        {
          heading: '3. Analysis Accuracy',
          body: 'Analyses and information generated by AI may contain errors, and users should conduct independent research before making any decisions.',
        },
        {
          heading: '4. Legal Use',
          body: 'Use of the app services must comply with applicable laws and regulations.',
        },
        {
          heading: '5. Prohibition of Abuse',
          body: 'Any abuse, attempt to disrupt the service, or unauthorized use of the app features is prohibited.',
        },
        {
          heading: '6. Liability',
          body: 'The AmirBTC team strives to provide accurate and up-to-date information but is not responsible for market changes or the results of user decisions.',
        },
      ],
    },
    privacy: {
      title: 'حریم خصوصی',
      sections: [
        {
          heading: '۱. اطلاعات حساب',
          body: 'اطلاعات مورد نیاز برای ارائه خدمات و شخصی‌سازی تجربه کاربر استفاده می‌شود.',
        },
        {
          heading: '۲. اطلاعات استفاده',
          body: 'ممکن است داده‌های مربوط به نحوه استفاده از برنامه برای بهبود عملکرد و رفع مشکلات فنی بررسی شود.',
        },
        {
          heading: '۳. اطلاعات شخصی',
          body: 'اطلاعات کاربران بدون اجازه آن‌ها به اشخاص ثالث فروخته یا ارائه نمی‌شود.',
        },
        {
          heading: '۴. امنیت',
          body: 'ما تلاش می‌کنیم با استفاده از روش‌های امنیتی مناسب از اطلاعات کاربران محافظت کنیم.',
        },
        {
          heading: '۵. سرویس‌های خارجی',
          body: 'برخی سرویس‌ها مانند APIهای داده بازار یا سرویس‌های هوش مصنوعی ممکن است برای ارائه قابلیت‌های برنامه استفاده شوند.',
        },
        {
          heading: '۶. تغییرات',
          body: 'ممکن است این سیاست در آینده برای بهبود خدمات تغییر کند و نسخه جدید آن در برنامه نمایش داده شود.',
        },
      ],
      title_en: 'Privacy Policy',
      sections_en: [
        {
          heading: '1. Account Information',
          body: 'Information required to provide services and personalize the user experience is used.',
        },
        {
          heading: '2. Usage Information',
          body: 'Data related to app usage may be reviewed to improve performance and resolve technical issues.',
        },
        {
          heading: '3. Personal Information',
          body: 'User information is not sold or provided to third parties without their consent.',
        },
        {
          heading: '4. Security',
          body: 'We strive to protect user information using appropriate security methods.',
        },
        {
          heading: '5. External Services',
          body: 'Some services such as market data APIs or AI services may be used to provide app features.',
        },
        {
          heading: '6. Changes',
          body: 'This policy may change in the future to improve services, and the new version will be displayed in the app.',
        },
      ],
    },
  };

  /** Normalize lang to 'fa' | 'en' (default 'fa'). */
  function normalizeLang(lang) {
    return lang === 'en' ? 'en' : 'fa';
  }

  async function ensureTable(env) {
    if (_tableEnsured) return;
    await queryDb(env, `
      CREATE TABLE IF NOT EXISTS app_content (
        id VARCHAR(64) PRIMARY KEY,
        title TEXT NOT NULL,
        sections JSONB NOT NULL DEFAULT '[]',
        title_en TEXT,
        sections_en JSONB NOT NULL DEFAULT '[]',
        version VARCHAR(32) DEFAULT '1.0.0',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by VARCHAR(64)
      )
    `, []);
    // Idempotent column add for existing deployments (pre-bilingual)
    await queryDb(env, `ALTER TABLE app_content ADD COLUMN IF NOT EXISTS title_en TEXT`, []).catch(() => {});
    await queryDb(env, `ALTER TABLE app_content ADD COLUMN IF NOT EXISTS sections_en JSONB NOT NULL DEFAULT '[]'`, []).catch(() => {});
    _tableEnsured = true;
  }

  async function seedIfEmpty(env) {
    if (_seeded) return;
    try {
      for (const [type, data] of Object.entries(SEED_DATA)) {
        const existing = await queryDb(env, `SELECT id FROM app_content WHERE id = $1`, [type], 1);
        if (!existing.rows || existing.rows.length === 0) {
          await queryDb(env, `
            INSERT INTO app_content (id, title, sections, title_en, sections_en, version, updated_at)
            VALUES ($1, $2, $3, $4, $5, '1.0.0', NOW())
            ON CONFLICT (id) DO NOTHING
          `, [
            type,
            data.title,
            JSON.stringify(data.sections),
            data.title_en || null,
            JSON.stringify(data.sections_en || []),
          ], 1);
        }
      }
      _seeded = true;
    } catch (e) {
      // Table might not exist yet — ignore
    }
  }

  /**
   * Get content by type ('about' | 'terms' | 'privacy') in the requested language.
   * lang: 'fa' | 'en' (default 'fa').
   *
   * EN FALLBACK RULE: If EN columns are NULL/empty in DB, return the English
   * SEED_DATA — never the Persian content. FA always returns Persian.
   *
   * Returns { type, title, sections, version, updated_at }
   */
  async function getContent(env, type, lang) {
    const lng = normalizeLang(lang);
    const cacheKey = CACHE_PREFIX + String(type) + ':' + lng;

    // Layer 1: KV cache (per-language isolated)
    const cached = await readAppCache(env, cacheKey).catch(() => null);
    if (cached) {
      try {
        const parsed = JSON.parse(cached);
        if (parsed && parsed.title && Array.isArray(parsed.sections)) {
          return parsed;
        }
      } catch {}
    }

    // Layer 2: DB
    try {
      await ensureTable(env);
      await seedIfEmpty(env);
      const result = await queryDb(env, `
        SELECT id, title, sections, title_en, sections_en, version, updated_at
        FROM app_content
        WHERE id = $1
        LIMIT 1
      `, [String(type)], 1);

      if (result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        let sections, title;
        if (lng === 'en') {
          // EN requested — use EN columns; fall back to SEED_DATA EN if NULL/empty
          title = (row.title_en && String(row.title_en).trim()) ? row.title_en : (SEED_DATA[type]?.title_en || row.title_en || '');
          let sectionsEn = row.sections_en;
          if (typeof sectionsEn === 'string') {
            try { sectionsEn = JSON.parse(sectionsEn); } catch { sectionsEn = []; }
          }
          if (!Array.isArray(sectionsEn) || sectionsEn.length === 0) {
            sectionsEn = SEED_DATA[type]?.sections_en || [];
          }
          sections = sectionsEn;
        } else {
          // FA requested — use FA columns (default behavior, unchanged)
          title = row.title;
          let sectionsFa = row.sections;
          if (typeof sectionsFa === 'string') {
            try { sectionsFa = JSON.parse(sectionsFa); } catch { sectionsFa = []; }
          }
          sections = Array.isArray(sectionsFa) ? sectionsFa : [];
        }
        const data = {
          type: row.id,
          title,
          sections,
          version: row.version || '1.0.0',
          updated_at: row.updated_at,
        };
        // Refresh KV cache (per-language key)
        await writeAppCache(env, cacheKey, JSON.stringify(data), CACHE_TTL).catch(() => {});
        return data;
      }
    } catch (e) {
      console.warn('[APP-CONTENT] getContent DB error:', e?.message);
    }

    // Layer 3: Seed fallback (no DB available) — language-appropriate
    const seed = SEED_DATA[type];
    if (seed) {
      if (lng === 'en') {
        return {
          type,
          title: seed.title_en || seed.title,
          sections: seed.sections_en || seed.sections,
          version: '1.0.0',
          updated_at: null,
        };
      }
      return {
        type,
        title: seed.title,
        sections: seed.sections,
        version: '1.0.0',
        updated_at: null,
      };
    }

    return null;
  }

  /**
   * Update content (admin only) for the requested language ONLY.
   * lang: 'fa' | 'en' (default 'fa').
   *
   * CRITICAL: Saving FA only updates title/sections. Saving EN only updates
   * title_en/sections_en. The other language's columns are NEVER touched.
   * Version is shared (not language-specific) — matches existing behavior.
   *
   * Cache: invalidates ONLY the saved language's cache key (app_content:{type}:{lang}).
   */
  async function updateContent(env, type, data, lang) {
    await ensureTable(env);
    const lng = normalizeLang(lang);
    const { title, sections, version } = data;

    console.log('[APP_CONTENT] UPDATE START — type:', type, 'lang:', lng, 'title:', title, 'version:', version);

    let result;
    if (lng === 'en') {
      // EN save — only touch title_en / sections_en. Use upsert with COALESCE
      // to preserve existing FA columns when the row already exists.
      result = await queryDb(env, `
        INSERT INTO app_content (id, title, sections, title_en, sections_en, version, updated_at, updated_by)
        VALUES ($1, '', '[]', $2, $3, $4, NOW(), $5)
        ON CONFLICT (id) DO UPDATE SET
          title_en = EXCLUDED.title_en,
          sections_en = EXCLUDED.sections_en,
          version = EXCLUDED.version,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
      `, [
        String(type),
        String(title || ''),
        JSON.stringify(sections || []),
        String(version || '1.0.0'),
        String(data.updated_by || 'admin'),
      ], 1);
    } else {
      // FA save — only touch title / sections (preserves existing EN columns).
      result = await queryDb(env, `
        INSERT INTO app_content (id, title, sections, version, updated_at, updated_by)
        VALUES ($1, $2, $3, $4, NOW(), $5)
        ON CONFLICT (id) DO UPDATE SET
          title = EXCLUDED.title,
          sections = EXCLUDED.sections,
          version = EXCLUDED.version,
          updated_at = NOW(),
          updated_by = EXCLUDED.updated_by
      `, [
        String(type),
        String(title || ''),
        JSON.stringify(sections || []),
        String(version || '1.0.0'),
        String(data.updated_by || 'admin'),
      ], 1);
    }
    console.log('[APP_CONTENT] UPDATE DB RESULT — rowCount:', result.rowCount);

    // Invalidate ONLY the saved language's cache key (per-language isolation)
    const cacheKey = CACHE_PREFIX + String(type) + ':' + lng;
    const cacheData = { type, title, sections, version, updated_at: new Date().toISOString() };
    try {
      await env.APP_CACHE?.delete?.(cacheKey).catch(() => {});
      await writeAppCache(env, cacheKey, JSON.stringify(cacheData), CACHE_TTL);
      console.log('[APP_CONTENT] KV CACHE REFRESHED — key:', cacheKey);
    } catch (e) {
      console.warn('[APP_CONTENT] KV cache refresh failed:', e?.message);
    }

    // Return the saved-language view (re-read to ensure consistency)
    return cacheData;
  }

  /**
   * Get app version (separate from content).
   * Reads from 'about' content's version field, or returns '1.0.0' as fallback.
   */
  async function getVersion(env) {
    const about = await getContent(env, 'about', 'fa');
    return about?.version || '1.0.0';
  }

  return Object.freeze({
    ensureTable,
    seedIfEmpty,
    getContent,
    updateContent,
    getVersion,
    SEED_DATA,
  });
}

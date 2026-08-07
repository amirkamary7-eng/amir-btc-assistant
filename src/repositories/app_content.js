/**
 * App Content Repository — CMS for About / Terms / Privacy
 *
 * Stores section-based JSON content in PostgreSQL (app_content table).
 * KV cache (app_content:{type}) provides fast reads with 1-hour TTL.
 *
 * Table: app_content
 *   id          = 'about' | 'terms' | 'privacy'
 *   title       = display title (Persian)
 *   sections    = JSON array of { heading, body }
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

  // ── Default seed content (section-based JSON) ──
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
    },
  };

  async function ensureTable(env) {
    if (_tableEnsured) return;
    await queryDb(env, `
      CREATE TABLE IF NOT EXISTS app_content (
        id VARCHAR(64) PRIMARY KEY,
        title TEXT NOT NULL,
        sections JSONB NOT NULL DEFAULT '[]',
        version VARCHAR(32) DEFAULT '1.0.0',
        updated_at TIMESTAMPTZ DEFAULT NOW(),
        updated_by VARCHAR(64)
      )
    `, []);
    _tableEnsured = true;
  }

  async function seedIfEmpty(env) {
    if (_seeded) return;
    try {
      for (const [type, data] of Object.entries(SEED_DATA)) {
        const existing = await queryDb(env, `SELECT id FROM app_content WHERE id = $1`, [type], 1);
        if (!existing.rows || existing.rows.length === 0) {
          await queryDb(env, `
            INSERT INTO app_content (id, title, sections, version, updated_at)
            VALUES ($1, $2, $3, '1.0.0', NOW())
            ON CONFLICT (id) DO NOTHING
          `, [type, data.title, JSON.stringify(data.sections)], 1);
        }
      }
      _seeded = true;
    } catch (e) {
      // Table might not exist yet — ignore
    }
  }

  /**
   * Get content by type ('about' | 'terms' | 'privacy').
   * Checks KV cache first, falls back to DB, then seed data.
   * Returns { title, sections, version, updated_at }
   */
  async function getContent(env, type) {
    const cacheKey = CACHE_PREFIX + type;

    // Layer 1: KV cache
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
        SELECT id, title, sections, version, updated_at
        FROM app_content
        WHERE id = $1
        LIMIT 1
      `, [String(type)], 1);

      if (result.rows && result.rows.length > 0) {
        const row = result.rows[0];
        let sections = row.sections;
        if (typeof sections === 'string') {
          try { sections = JSON.parse(sections); } catch { sections = []; }
        }
        const data = {
          type: row.id,
          title: row.title,
          sections: Array.isArray(sections) ? sections : [],
          version: row.version || '1.0.0',
          updated_at: row.updated_at,
        };
        // Refresh KV cache
        await writeAppCache(env, cacheKey, JSON.stringify(data), CACHE_TTL).catch(() => {});
        return data;
      }
    } catch (e) {
      console.warn('[APP-CONTENT] getContent DB error:', e?.message);
    }

    // Layer 3: Seed fallback (no DB available)
    const seed = SEED_DATA[type];
    if (seed) {
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
   * Update content (admin only).
   * Saves to DB + refreshes KV cache.
   */
  async function updateContent(env, type, data) {
    await ensureTable(env);
    const { title, sections, version } = data;

    console.log('[APP_CONTENT] UPDATE START — type:', type, 'title:', title, 'version:', version);
    const result = await queryDb(env, `
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
    console.log('[APP_CONTENT] UPDATE DB RESULT — rowCount:', result.rowCount);

    // Refresh KV cache — delete old + write new to avoid stale reads
    const cacheKey = CACHE_PREFIX + type;
    const cacheData = { type, title, sections, version, updated_at: new Date().toISOString() };
    try {
      await env.APP_CACHE?.delete?.(cacheKey).catch(() => {});
      await writeAppCache(env, cacheKey, JSON.stringify(cacheData), CACHE_TTL);
      console.log('[APP_CONTENT] KV CACHE REFRESHED — key:', cacheKey);
    } catch (e) {
      console.warn('[APP_CONTENT] KV cache refresh failed:', e?.message);
    }

    return cacheData;
  }

  /**
   * Get app version (separate from content).
   * Reads from 'about' content's version field, or returns '1.0.0' as fallback.
   */
  async function getVersion(env) {
    const about = await getContent(env, 'about');
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

/**
 * Publisher Controllers — HTTP + Telegram Layer
 *
 * Responsibilities:
 *   - Settings (KV) read/write
 *   - Message templates (HTML) for news / calendar / analysis / announcement
 *   - Deep-link generation (startapp param)
 *   - Preview generation + validation
 *   - Queue API endpoints (enqueue, list, retry, cancel, logs, stats)
 *   - Queue processor (called from cron) with rate limit + dedup + retry
 *
 * Database ops are delegated to publisherRepo.
 * Telegram sending is delegated to sendTelegramMessage (injected).
 */
export function createPublisherHandlers(deps) {
  const {
    jsonResponse,
    requireAdmin,
    readJsonBody,
    safeDbErrorResponse,
    safeError,
    isDatabaseConfigured,
    buildBodyFieldValidationError,
    normalizeOptionalString,
    publisherRepo,
    sendTelegramMessage,
    readAppCache,
    writeAppCache,
    resolveWebAppUrl,
    fetchFarsiNews,
    fetchCalendarEvents,
    analysisRepo,
  } = deps;

  const SETTINGS_KV_KEY = 'tg:pub:settings';

  // Stable short hash for news URLs (mirrors worker-proxy.js hashUrl)
  function hashUrl(url) {
    let hash = 0;
    const s = String(url || '');
    for (let i = 0; i < s.length; i++) {
      const ch = s.charCodeAt(i);
      hash = ((hash << 5) - hash) + ch;
      hash = hash & hash;
    }
    return Math.abs(hash).toString(36);
  }

  const DEFAULT_SETTINGS = {
    enabled: false,
    channel_id: '',
    rate_limit_ms: 3000,
    auto_publish_news: false,
    news_filters: {
      breaking: true,
      important: true,
      high: true,
      featured: true,
      normal: false,
      low: false,
    },
    auto_publish_calendar: false,
    calendar_impacts: { high: true, medium: false, low: false },
    auto_publish_analysis: false,
  };

  // ── Settings ────────────────────────────────────────────────────────────

  async function readSettings(env) {
    try {
      const raw = await readAppCache(env, SETTINGS_KV_KEY);
      if (raw) {
        const parsed = JSON.parse(raw);
        return { ...DEFAULT_SETTINGS, ...parsed, news_filters: { ...DEFAULT_SETTINGS.news_filters, ...(parsed.news_filters || {}) }, calendar_impacts: { ...DEFAULT_SETTINGS.calendar_impacts, ...(parsed.calendar_impacts || {}) } };
      }
    } catch (e) {
      console.warn('[publisher] readSettings KV parse failed:', e?.message || e);
    }
    return { ...DEFAULT_SETTINGS };
  }

  async function writeSettings(env, settings) {
    // writeAppCache(env, key, value, expirationTtl) — TTL 0 = no expiration
    await writeAppCache(env, SETTINGS_KV_KEY, JSON.stringify(settings), 0);
    return settings;
  }

  async function handleGetSettings(request, env) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const settings = await readSettings(env);
    return jsonResponse({ status: 'success', settings }, {}, env);
  }

  async function handleUpdateSettings(request, env) {
    const { error, admin } = await requireAdmin(request, env);
    if (error) return error;
    const bodyResult = await readJsonBody(request, 32768, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload || {};

    const current = await readSettings(env);
    const next = { ...current };
    if (typeof payload.enabled === 'boolean') next.enabled = payload.enabled;
    if (typeof payload.channel_id === 'string') next.channel_id = String(payload.channel_id).trim().slice(0, 64);
    if (payload.rate_limit_ms != null) {
      const v = Number(payload.rate_limit_ms);
      if (!Number.isFinite(v)) return buildBodyFieldValidationError(env, 'rate_limit_ms', 'must be a number');
      next.rate_limit_ms = Math.max(1000, Math.min(10000, Math.round(v)));
    }
    if (typeof payload.auto_publish_news === 'boolean') next.auto_publish_news = payload.auto_publish_news;
    if (typeof payload.auto_publish_calendar === 'boolean') next.auto_publish_calendar = payload.auto_publish_calendar;
    if (typeof payload.auto_publish_analysis === 'boolean') next.auto_publish_analysis = payload.auto_publish_analysis;
    if (payload.news_filters && typeof payload.news_filters === 'object') {
      next.news_filters = { ...next.news_filters };
      for (const k of Object.keys(DEFAULT_SETTINGS.news_filters)) {
        if (typeof payload.news_filters[k] === 'boolean') next.news_filters[k] = payload.news_filters[k];
      }
    }
    if (payload.calendar_impacts && typeof payload.calendar_impacts === 'object') {
      next.calendar_impacts = { ...next.calendar_impacts };
      for (const k of Object.keys(DEFAULT_SETTINGS.calendar_impacts)) {
        if (typeof payload.calendar_impacts[k] === 'boolean') next.calendar_impacts[k] = payload.calendar_impacts[k];
      }
    }

    await writeSettings(env, next);
    return jsonResponse({ status: 'success', settings: next }, {}, env);
  }

  // ── Deep Link ───────────────────────────────────────────────────────────

  function buildDeepLink(env, type, refId) {
    const base = resolveWebAppUrl(env, { cacheBust: false });
    if (!base) return null;
    const param = `${type}_${String(refId || '').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 64)}`;
    try {
      const u = new URL(base);
      u.searchParams.set('startapp', param);
      return u.toString();
    } catch {
      return `${base}${base.includes('?') ? '&' : '?'}startapp=${encodeURIComponent(param)}`;
    }
  }

  // ── Telegram HTML escaping ──────────────────────────────────────────────

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;');
  }

  function truncate(s, max) {
    s = String(s || '');
    if (s.length <= max) return s;
    return s.slice(0, Math.max(0, max - 1)).trimEnd() + '…';
  }

  // ── Message Templates ───────────────────────────────────────────────────
  // Returns: { text, imageUrl, buttons: [{text, url}], parseMode: 'HTML' }

  function buildNewsMessage(env, article, overrides = {}) {
    const settings = null; // fetched by caller; not needed here
    const title = (overrides.title != null ? overrides.title : article.title) || '';
    const summaryRaw = (overrides.summary != null ? overrides.summary : (article.ai_summary || article.body || ''));
    const summary = summaryRaw || '';
    const source = (overrides.source != null ? overrides.source : (article.source_name || article.source || ''));
    const showSource = overrides.show_source !== false;
    const isBreaking = overrides.is_breaking != null ? overrides.is_breaking : (article.is_breaking || article.priority === 'breaking');
    const headerEmoji = isBreaking ? '🚨' : '📰';
    const headerLabel = isBreaking ? 'خبر فوری' : 'خبر';

    const refId = article.url_hash || hashUrl(article.url);
    const deepLink = buildDeepLink(env, 'news', refId);
    const customNote = overrides.custom_note ? `\n\n⚠️ ${escapeHtml(overrides.custom_note)}\n` : '';

    const lines = [];
    lines.push(`<b>${headerEmoji} ${escapeHtml(headerLabel)}</b>`);
    lines.push('');
    lines.push(`<b>${escapeHtml(title)}</b>`);
    if (summary) lines.push(`\n${escapeHtml(truncate(summary, 1500))}`);
    if (showSource && source) {
      lines.push('');
      lines.push('──────────────');
      lines.push(`📰 <b>منبع:</b> ${escapeHtml(truncate(source, 80))}`);
      lines.push('──────────────');
    }
    lines.push('');
    lines.push('👇 مطالعه متن کامل در Mini App');
    if (customNote) lines.push(customNote);

    const text = lines.join('\n');
    const buttons = deepLink
      ? [[{ text: '📲 مشاهده خبر در Mini App', url: deepLink }]]
      : [];

    return {
      text,
      imageUrl: null,
      buttons,
      parseMode: 'HTML',
      deepLink,
      refId,
      type: 'news',
    };
  }

  function buildCalendarMessage(env, event, overrides = {}) {
    const country = (overrides.country != null ? overrides.country : (event.country || ''));
    const eventName = (overrides.title != null ? overrides.title : (event.title || event.event || ''));
    const impact = (overrides.impact != null ? overrides.impact : (event.impact || ''));
    const impactLower = String(impact).toLowerCase();
    const impactEmoji = impactLower === 'high' ? '🔴' : impactLower === 'medium' ? '🟡' : '🟢';
    const impactLabel = impactLower === 'high' ? 'High' : impactLower === 'medium' ? 'Medium' : 'Low';
    const time = (overrides.time != null ? overrides.time : (event.time || ''));
    const forecast = (overrides.forecast != null ? overrides.forecast : (event.forecast || ''));
    const previous = (overrides.previous != null ? overrides.previous : (event.previous || ''));
    const actual = (overrides.actual != null ? overrides.actual : (event.actual || ''));

    const refId = String(event.id || event.event_id || '').slice(0, 64) || String(eventName).slice(0, 64);
    const deepLink = buildDeepLink(env, 'calendar', refId);
    const customNote = overrides.custom_note ? `\n⚠️ ${escapeHtml(overrides.custom_note)}\n` : '';

    const lines = [];
    lines.push('<b>📅 رویداد اقتصادی</b>');
    lines.push('');
    if (country) lines.push(`${escapeHtml(country)}`);
    if (eventName) lines.push(`\n<b>${escapeHtml(eventName)}</b>`);
    if (impact) lines.push(`\nImpact: ${impactEmoji} <b>${escapeHtml(impactLabel)}</b>`);
    if (time) lines.push(`\nزمان: <b>${escapeHtml(time)}</b>`);
    if (forecast) lines.push(`Forecast: <code>${escapeHtml(forecast)}</code>`);
    if (previous) lines.push(`Previous: <code>${escapeHtml(previous)}</code>`);
    if (actual) lines.push(`Actual: <code>${escapeHtml(actual)}</code>`);
    lines.push('');
    lines.push('👇 مشاهده در Mini App');
    if (customNote) lines.push(customNote);

    const text = lines.join('\n');
    const buttons = deepLink ? [[{ text: '📊 مشاهده در Mini App', url: deepLink }]] : [];

    return { text, imageUrl: null, buttons, parseMode: 'HTML', deepLink, refId, type: 'calendar' };
  }

  function buildAnalysisMessage(env, analysis, overrides = {}) {
    const coin = (overrides.coin != null ? overrides.coin : (analysis.coin || '')).toUpperCase();
    const title = (overrides.title != null ? overrides.title : (analysis.title || ''));
    const summary = (overrides.summary != null ? overrides.summary : (analysis.summary || analysis.content || ''));
    const marketState = (overrides.market_state != null ? overrides.market_state : (analysis.market_state || analysis.trend || ''));
    const symbol = (overrides.symbol != null ? overrides.symbol : coin);
    const imageUrl = (overrides.image_url != null ? overrides.image_url : (analysis.image || '')) || '';

    const refId = String(analysis.id || '').slice(0, 64);
    const deepLink = buildDeepLink(env, 'analysis', refId);
    const customNote = overrides.custom_note ? `\n\n⚠️ ${escapeHtml(overrides.custom_note)}\n` : '';

    const lines = [];
    lines.push(`<b>📈 تحلیل ${escapeHtml(coin || 'بازار')}</b>`);
    lines.push('');
    if (title) lines.push(`<b>${escapeHtml(title)}</b>`);
    if (summary) lines.push(`\n${escapeHtml(truncate(summary, 1200))}`);
    if (marketState) {
      lines.push('');
      lines.push(`📊 وضعیت بازار: <b>${escapeHtml(marketState)}</b>`);
    }
    if (symbol) lines.push(`🏷 نماد: <code>${escapeHtml(symbol)}</code>`);
    lines.push('');
    lines.push('👇 مطالعه تحلیل کامل در Mini App');
    if (customNote) lines.push(customNote);

    const text = lines.join('\n');
    const buttons = deepLink ? [[{ text: '📖 مطالعه تحلیل کامل', url: deepLink }]] : [];

    return { text, imageUrl, buttons, parseMode: 'HTML', deepLink, refId, type: 'analysis' };
  }

  function buildAnnouncementMessage(env, ann, overrides = {}) {
    const title = (overrides.title != null ? overrides.title : (ann.title || ''));
    const body = (overrides.body != null ? overrides.body : (ann.body || ann.content || ''));
    const imageUrl = (overrides.image_url != null ? overrides.image_url : (ann.image || '')) || '';
    const refId = String(ann.id || 'a').slice(0, 64);
    const deepLink = buildDeepLink(env, 'announcement', refId);
    const customNote = overrides.custom_note ? `\n\n⚠️ ${escapeHtml(overrides.custom_note)}\n` : '';

    const lines = [];
    lines.push('<b>📢 اطلاعیه</b>');
    lines.push('');
    if (title) lines.push(`<b>${escapeHtml(title)}</b>`);
    if (body) lines.push(`\n${escapeHtml(truncate(body, 2000))}`);
    lines.push('');
    lines.push('👇 مشاهده در Mini App');
    if (customNote) lines.push(customNote);

    const text = lines.join('\n');
    const buttons = deepLink ? [[{ text: '📲 مشاهده در Mini App', url: deepLink }]] : [];
    return { text, imageUrl, buttons, parseMode: 'HTML', deepLink, refId, type: 'announcement' };
  }

  // ── Validation ──────────────────────────────────────────────────────────

  function validateMessage(built) {
    const issues = [];
    if (!built.text || !built.text.trim()) issues.push('متن پیام خالی است');
    if (built.text.length > 4096) issues.push(`متن پیام از حد تلگرام (4096) بلندتر است — ${built.text.length} کاراکتر`);
    if (built.imageUrl) {
      try { new URL(built.imageUrl); } catch { issues.push('آدرس تصویر نامعتبر است'); }
    }
    if (!built.deepLink) issues.push('ساخت لینک Mini App ناموفق بود (WEBAPP_URL تنظیم نشده)');
    if (built.buttons.length && !built.buttons[0][0].url) issues.push('دکمه شیشه‌ای بدون URL است');
    return { valid: issues.length === 0, issues };
  }

  // ── Fetch item from source ──────────────────────────────────────────────
  // Resolves a (type, refId) into the source object used to build the message.

  async function resolveSourceItem(env, type, refId) {
    if (type === 'news') {
      const newsData = await fetchFarsiNews(env, null).catch(() => null);
      const list = (newsData && (newsData.data || newsData)) || [];
      const arr = Array.isArray(list) ? list : [];
      const found = arr.find((a) => (a.url_hash || hashUrl(a.url)) === refId) || null;
      return found;
    }
    if (type === 'calendar') {
      const events = await fetchCalendarEvents(env).catch(() => null);
      const list = (events && (events.events || events.data || events)) || [];
      const arr = Array.isArray(list) ? list : [];
      return arr.find((e) => String(e.id || e.event_id || '') === refId) || null;
    }
    if (type === 'analysis') {
      // Try direct lookup by ID first (more reliable than list)
      const byId = await analysisRepo.getById(env, refId).catch(() => null);
      if (byId) return byId;
      // Fallback: scan recent list
      const listRes = await analysisRepo.list(env, 1, 50).catch(() => ({ analyses: [] }));
      const arr = (listRes && (listRes.analyses || listRes.items)) || [];
      return arr.find((a) => String(a.id) === String(refId)) || null;
    }
    if (type === 'announcement') {
      return { id: refId };
    }
    return null;
  }

  function buildMessageForType(env, type, item, overrides = {}) {
    if (type === 'news') return buildNewsMessage(env, item, overrides);
    if (type === 'calendar') return buildCalendarMessage(env, item, overrides);
    if (type === 'analysis') return buildAnalysisMessage(env, item, overrides);
    if (type === 'announcement') return buildAnnouncementMessage(env, item, overrides);
    throw new Error('Unknown publish type: ' + type);
  }

  // ── Preview endpoint ────────────────────────────────────────────────────

  async function handlePreview(request, env) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const bodyResult = await readJsonBody(request, 32768, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload || {};
    const type = String(payload.type || '').trim();
    const refId = String(payload.ref_id || payload.refId || '').trim();
    const overrides = payload.overrides || payload.payload || {};

    if (!['news', 'calendar', 'analysis', 'announcement'].includes(type)) {
      return buildBodyFieldValidationError(env, 'type', 'must be news | calendar | analysis | announcement');
    }
    if (!refId) return buildBodyFieldValidationError(env, 'ref_id', 'is required');

    const item = await resolveSourceItem(env, type, refId);
    if (!item) {
      return jsonResponse({ status: 'error', message: 'مورد یافت نشد — ممکن است حذف شده یا منقضی شده باشد' }, { status: 404 }, env);
    }

    const built = buildMessageForType(env, type, item, overrides);
    const validation = validateMessage(built);
    const dedup = await publisherRepo.checkDedup(env, type, built.refId).catch(() => ({ published: false }));

    return jsonResponse({
      status: 'success',
      preview: {
        type: built.type,
        ref_id: built.refId,
        text: built.text,
        text_length: built.text.length,
        image_url: built.imageUrl,
        buttons: built.buttons,
        parse_mode: built.parseMode,
        deep_link: built.deepLink,
        source_item: {
          title: item.title || item.event || item.name || '',
          ...(type === 'news' ? { url: item.url, source: item.source_name || item.source } : {}),
          ...(type === 'analysis' ? { coin: item.coin, image: item.image } : {}),
          ...(type === 'calendar' ? { country: item.country, impact: item.impact, time: item.time, forecast: item.forecast, previous: item.previous } : {}),
        },
        validation,
        dedup,
      },
    }, {}, env);
  }

  // ── Enqueue ─────────────────────────────────────────────────────────────

  async function handleEnqueue(request, env) {
    const { error, admin } = await requireAdmin(request, env);
    if (error) return error;
    const bodyResult = await readJsonBody(request, 32768, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload || {};
    const type = String(payload.type || '').trim();
    const refId = String(payload.ref_id || payload.refId || '').trim();
    const overrides = payload.overrides || payload.payload || {};
    const priority = Number(payload.priority ?? 100);
    const scheduledAt = payload.scheduled_at || null;

    if (!['news', 'calendar', 'analysis', 'announcement'].includes(type)) {
      return buildBodyFieldValidationError(env, 'type', 'must be news | calendar | analysis | announcement');
    }
    if (!refId) return buildBodyFieldValidationError(env, 'ref_id', 'is required');

    const item = await resolveSourceItem(env, type, refId);
    if (!item) {
      return jsonResponse({ status: 'error', message: 'مورد یافت نشد' }, { status: 404 }, env);
    }
    const built = buildMessageForType(env, type, item, overrides);
    const validation = validateMessage(built);
    if (!validation.valid) {
      return jsonResponse({ status: 'error', message: 'اعتبارسنجی ناموفق', issues: validation.issues }, { status: 422 }, env);
    }

    const queueItem = await publisherRepo.enqueue(env, {
      type,
      ref_id: built.refId,
      payload: { item_snapshot: item, overrides, built },
      priority,
      scheduled_at: scheduledAt,
      created_by: admin?.telegram_id || admin?.id || null,
    });

    return jsonResponse({ status: 'success', queue: queueItem }, {}, env);
  }

  // ── List endpoints ──────────────────────────────────────────────────────

  async function handleListQueue(request, env, status) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 50);
    let items;
    if (status === 'sent') items = await publisherRepo.listSent(env, { page, limit });
    else if (status === 'failed') items = await publisherRepo.listFailed(env, { page, limit });
    else items = await publisherRepo.listPending(env, { page, limit });
    return jsonResponse({ status: 'success', items, page, limit }, {}, env);
  }

  async function handleListLogs(request, env) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const url = new URL(request.url);
    const page = Number(url.searchParams.get('page') || 1);
    const limit = Number(url.searchParams.get('limit') || 50);
    const queueId = url.searchParams.get('queue_id') || null;
    const items = await publisherRepo.listLogs(env, { page, limit, queueId });
    return jsonResponse({ status: 'success', items, page, limit }, {}, env);
  }

  async function handleRetry(request, env, id) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const item = await publisherRepo.retry(env, id);
    if (!item) return jsonResponse({ status: 'error', message: 'آیتم یافت نشد یا قابل ارسال مجدد نیست' }, { status: 404 }, env);
    return jsonResponse({ status: 'success', queue: item }, {}, env);
  }

  async function handleCancel(request, env, id) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const item = await publisherRepo.cancel(env, id);
    if (!item) return jsonResponse({ status: 'error', message: 'آیتم یافت نشد یا در صف نیست' }, { status: 404 }, env);
    return jsonResponse({ status: 'success', queue: item }, {}, env);
  }

  async function handleDeleteSent(request, env, id) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    await publisherRepo.deleteLogEntry(env, id);
    return jsonResponse({ status: 'success' }, {}, env);
  }

  async function handleStats(request, env) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const stats = await publisherRepo.getStats(env);
    const settings = await readSettings(env);
    return jsonResponse({ status: 'success', stats, settings_enabled: settings.enabled, channel_id: settings.channel_id }, {}, env);
  }

  async function handleCheckDedup(request, env, type, refId) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const dedup = await publisherRepo.checkDedup(env, type, refId);
    return jsonResponse({ status: 'success', dedup }, {}, env);
  }

  // ── Manual process trigger (diag) ───────────────────────────────────────

  async function handleProcessNow(request, env) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const result = await processPublisherQueue(env, { maxItems: 5, manual: true });
    return jsonResponse({ status: 'success', result }, {}, env);
  }

  // ── Channel connection test ─────────────────────────────────────────────
  // Tests whether the bot can send messages to the configured channel.
  // Uses getChat API to check bot membership + permissions without sending.

  async function handleTestConnection(request, env) {
    const { error } = await requireAdmin(request, env);
    if (error) return error;
    const settings = await readSettings(env);
    if (!settings.channel_id) {
      return jsonResponse({ status: 'error', message: 'شناسه کانال تنظیم نشده' }, { status: 400 }, env);
    }
    const botToken = String(env.TELEGRAM_BOT_TOKEN || '');
    if (!botToken || botToken === 'REPLACE_WITH_TOKEN') {
      return jsonResponse({ status: 'error', message: 'TELEGRAM_BOT_TOKEN تنظیم نشده' }, { status: 400 }, env);
    }
    try {
      const apiUrl = `https://api.telegram.org/bot${botToken}/getChat`;
      const res = await fetch(apiUrl, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ chat_id: settings.channel_id }),
        signal: AbortSignal.timeout(8000),
      });
      const data = await res.json();
      if (!data.ok) {
        return jsonResponse({
          status: 'error',
          ok: false,
          message: 'بات نمی‌تواند به کانال دسترسی پیدا کند',
          error_code: data.error_code,
          description: data.description,
        }, { status: 200 }, env);
      }
      const chat = data.result || {};
      const chatType = chat.type || 'unknown';
      // For channels, check if bot is admin
      const isChannel = chatType === 'channel';
      let canPost = true;
      let botStatus = null;
      if (isChannel) {
        try {
          // ROOT CAUSE FIX: env.BOT_USER_ID may not be set. Get the bot's
          // user ID dynamically via getMe API instead of relying on env var.
          let botUserId = env.BOT_USER_ID;
          if (!botUserId) {
            const meRes = await fetch(`https://api.telegram.org/bot${botToken}/getMe`, {
              signal: AbortSignal.timeout(5000),
            }).catch(() => null);
            if (meRes && meRes.ok) {
              const meData = await meRes.json();
              botUserId = meData.result?.id;
            }
          }
          if (!botUserId) {
            // Can't determine bot's user ID — assume can post (getChat succeeded)
            canPost = true;
            botStatus = 'unknown';
          } else {
            const memberRes = await fetch(`https://api.telegram.org/bot${botToken}/getChatMember`, {
              method: 'POST',
              headers: { 'Content-Type': 'application/json' },
              body: JSON.stringify({ chat_id: settings.channel_id, user_id: botUserId }),
              signal: AbortSignal.timeout(8000),
            }).catch(() => null);
            if (memberRes && memberRes.ok) {
              const memberData = await memberRes.json();
              botStatus = memberData.result?.status || 'unknown';
              canPost = ['administrator', 'creator'].includes(botStatus);
            }
          }
        } catch {}
      }
      return jsonResponse({
        status: 'success',
        ok: true,
        chat: {
          id: chat.id,
          type: chatType,
          title: chat.title || chat.username || '—',
          username: chat.username || null,
        },
        bot_status: botStatus,
        can_post: canPost,
        message: canPost
          ? '✅ اتصال موفق — بات می‌تواند به کانال پیام ارسال کند'
          : '⚠️ بات عضو کانال است اما دسترسی ارسال ندارد — بات را ادمین کنید',
      }, {}, env);
    } catch (e) {
      return jsonResponse({
        status: 'error',
        ok: false,
        message: 'خطا در ارتباط با Telegram API',
        error: e?.message || String(e),
      }, { status: 200 }, env);
    }
  }

  // ── Send-now (skip queue) ───────────────────────────────────────────────

  async function handleSendNow(request, env) {
    const { error, admin } = await requireAdmin(request, env);
    if (error) return error;
    const bodyResult = await readJsonBody(request, 32768, env);
    if (bodyResult.error) return bodyResult.error;
    const payload = bodyResult.payload || {};
    const type = String(payload.type || '').trim();
    const refId = String(payload.ref_id || payload.refId || '').trim();
    const overrides = payload.overrides || {};

    if (!['news', 'calendar', 'analysis', 'announcement'].includes(type)) {
      return buildBodyFieldValidationError(env, 'type', 'must be news | calendar | analysis | announcement');
    }
    if (!refId) return buildBodyFieldValidationError(env, 'ref_id', 'is required');

    const item = await resolveSourceItem(env, type, refId);
    if (!item) return jsonResponse({ status: 'error', message: 'مورد یافت نشد' }, { status: 404 }, env);

    const built = buildMessageForType(env, type, item, overrides);
    const validation = validateMessage(built);
    if (!validation.valid) {
      return jsonResponse({ status: 'error', message: 'اعتبارسنجی ناموفق', issues: validation.issues }, { status: 422 }, env);
    }

    const settings = await readSettings(env);
    if (!settings.channel_id) return jsonResponse({ status: 'error', message: 'شناسه کانال تنظیم نشده' }, { status: 400 }, env);

    const tgPayload = buildTelegramPayload(settings.channel_id, built);
    const t0 = Date.now();
    let result, sendError;
    try {
      result = await sendTelegramMessage(env, tgPayload, { retries: 1, timeoutMs: 12000 });
    } catch (e) {
      sendError = e;
    }
    const durationMs = Date.now() - t0;

    // Persist as sent/failed in queue + log
    const queueItem = await publisherRepo.enqueue(env, {
      type,
      ref_id: built.refId,
      payload: { item_snapshot: item, overrides, built, send_now: true },
      priority: 0,
      created_by: admin?.telegram_id || admin?.id || null,
    }).catch(() => null);

    if (sendError || !result || !result.ok) {
      const errMsg = sendError?.message || result?.description || 'send failed';
      if (queueItem) {
        await publisherRepo.markFailed(env, queueItem.id, errMsg).catch(() => {});
        await publisherRepo.insertLog(env, {
          queue_id: queueItem.id, type, ref_id: built.refId,
          status: 'failed', error: errMsg, telegram_response: null,
          duration_ms: durationMs, message_text: built.text, tg_message_id: null,
        }).catch(() => {});
      }
      return jsonResponse({ status: 'error', message: errMsg }, { status: 502 }, env);
    }

    if (queueItem) {
      await publisherRepo.markSent(env, queueItem.id, {
        tgMessageId: result.messageId,
        tgChatId: settings.channel_id,
        finalText: built.text,
        finalPayload: built,
      }).catch(() => {});
      await publisherRepo.insertLog(env, {
        queue_id: queueItem.id, type, ref_id: built.refId,
        status: 'sent', error: null, telegram_response: { ok: true, message_id: result.messageId },
        duration_ms: durationMs, message_text: built.text, tg_message_id: result.messageId,
      }).catch(() => {});
    }

    return jsonResponse({
      status: 'success',
      message_id: result.messageId,
      duration_ms: durationMs,
      text_length: built.text.length,
    }, {}, env);
  }

  // ── Build Telegram payload from a "built" message ───────────────────────

  function buildTelegramPayload(chatId, built) {
    const replyMarkup = built.buttons && built.buttons.length
      ? { inline_keyboard: built.buttons }
      : undefined;
    if (built.imageUrl) {
      return {
        chat_id: chatId,
        photo: built.imageUrl,
        caption: built.text,
        parse_mode: built.parseMode || 'HTML',
        reply_markup: replyMarkup,
      };
    }
    return {
      chat_id: chatId,
      text: built.text,
      parse_mode: built.parseMode || 'HTML',
      disable_web_page_preview: true,
      reply_markup: replyMarkup,
    };
  }

  // ── Queue Processor (called from cron) ──────────────────────────────────

  async function processPublisherQueue(env, { maxItems = 10, manual = false } = {}) {
    if (!isDatabaseConfigured(env)) return { processed: 0, reason: 'db_unavailable' };
    const settings = await readSettings(env);
    if (!settings.enabled && !manual) return { processed: 0, reason: 'disabled' };
    if (!settings.channel_id) return { processed: 0, reason: 'no_channel' };

    const claimed = await publisherRepo.claimPendingBatch(env, maxItems).catch((e) => {
      console.warn('[publisher] claimPendingBatch failed:', e?.message || e);
      return [];
    });
    if (!claimed.length) return { processed: 0, reason: 'empty' };

    let sent = 0, failed = 0, skipped = 0;
    for (const item of claimed) {
      const t0 = Date.now();
      try {
        // Reconstruct the built message. If payload has a pre-built snapshot, use it.
        const built = item.payload?.built;
        if (!built || !built.text) {
          throw new Error('payload missing built message');
        }

        // Dedup check — skip if already sent today
        const dedup = await publisherRepo.checkDedup(env, item.type, item.ref_id).catch(() => ({ published: false }));
        if (dedup.published) {
          skipped++;
          await publisherRepo.markSent(env, item.id, {
            tgMessageId: dedup.messageId,
            tgChatId: dedup.chatId,
            finalText: built.text,
            finalPayload: built,
          }).catch(() => {});
          await publisherRepo.insertLog(env, {
            queue_id: item.id, type: item.type, ref_id: item.ref_id,
            status: 'skipped_dedup', error: null, telegram_response: null,
            duration_ms: Date.now() - t0, message_text: built.text, tg_message_id: dedup.messageId,
          }).catch(() => {});
          continue;
        }

        const tgPayload = buildTelegramPayload(settings.channel_id, built);
        let result, sendError;
        try {
          result = await sendTelegramMessage(env, tgPayload, { retries: 1, timeoutMs: 12000 });
        } catch (e) { sendError = e; }
        const durationMs = Date.now() - t0;

        if (sendError || !result || !result.ok) {
          const errMsg = sendError?.message || result?.description || 'send failed';
          failed++;
          await publisherRepo.markFailed(env, item.id, errMsg).catch(() => {});
          await publisherRepo.insertLog(env, {
            queue_id: item.id, type: item.type, ref_id: item.ref_id,
            status: 'failed', error: errMsg, telegram_response: result || null,
            duration_ms: durationMs, message_text: built.text, tg_message_id: null,
          }).catch(() => {});
        } else {
          sent++;
          await publisherRepo.markSent(env, item.id, {
            tgMessageId: result.messageId,
            tgChatId: settings.channel_id,
            finalText: built.text,
            finalPayload: built,
          }).catch(() => {});
          await publisherRepo.insertLog(env, {
            queue_id: item.id, type: item.type, ref_id: item.ref_id,
            status: 'sent', error: null, telegram_response: { ok: true, message_id: result.messageId },
            duration_ms: durationMs, message_text: built.text, tg_message_id: result.messageId,
          }).catch(() => {});
        }

        // Rate limit between sends (2-5s)
        if (settings.rate_limit_ms > 0) {
          await new Promise((r) => setTimeout(r, Math.min(10000, Math.max(1000, settings.rate_limit_ms))));
        }
      } catch (e) {
        failed++;
        const errMsg = e?.message || String(e);
        await publisherRepo.markFailed(env, item.id, errMsg).catch(() => {});
        await publisherRepo.insertLog(env, {
          queue_id: item.id, type: item.type, ref_id: item.ref_id,
          status: 'failed', error: errMsg, telegram_response: null,
          duration_ms: Date.now() - t0, message_text: null, tg_message_id: null,
        }).catch(() => {});
      }
    }

    return { processed: claimed.length, sent, failed, skipped };
  }

  // ── Auto-publish hook (called when new content arrives) ─────────────────
  // Returns nothing; safe to call fire-and-forget from cron contexts.

  async function autoPublishCheck(env, type, items) {
    if (!items || !items.length) return;
    const settings = await readSettings(env).catch(() => null);
    if (!settings || !settings.enabled) return;

    if (type === 'news' && settings.auto_publish_news) {
      const filters = settings.news_filters || {};
      for (const article of items) {
        const priority = String(article.priority || article.ai_priority || '').toLowerCase();
        const isBreaking = article.is_breaking || priority === 'breaking';
        const isImportant = priority === 'important' || article.important;
        const isHigh = priority === 'high';
        const isFeatured = article.featured;
        const isNormal = !priority || priority === 'normal' || priority === 'low';
        const isLow = priority === 'low';

        const shouldPublish =
          (isBreaking && filters.breaking) ||
          (isImportant && filters.important) ||
          (isHigh && filters.high) ||
          (isFeatured && filters.featured) ||
          (isNormal && filters.normal) ||
          (isLow && filters.low);

        if (!shouldPublish) continue;

        const refId = article.url_hash || hashUrl(article.url);
        if (!refId) continue;
        // Dedup — don't enqueue if already sent/queued today
        const dedup = await publisherRepo.checkDedup(env, 'news', refId).catch(() => ({ published: false }));
        if (dedup.published) continue;
        try {
          await publisherRepo.enqueue(env, {
            type: 'news',
            ref_id: refId,
            payload: { item_snapshot: article, overrides: {}, built: buildNewsMessage(env, article, {}) },
            priority: isBreaking ? 10 : isImportant ? 20 : 50,
            created_by: 'auto-publish',
          });
        } catch (e) {
          console.warn('[publisher] autoPublish news enqueue failed:', e?.message || e);
        }
      }
    }

    if (type === 'calendar' && settings.auto_publish_calendar) {
      const impacts = settings.calendar_impacts || {};
      for (const event of items) {
        const impact = String(event.impact || '').toLowerCase();
        const shouldPublish =
          (impact === 'high' && impacts.high) ||
          (impact === 'medium' && impacts.medium) ||
          (impact === 'low' && impacts.low);
        if (!shouldPublish) continue;
        const refId = String(event.id || event.event_id || '').slice(0, 64);
        if (!refId) continue;
        const dedup = await publisherRepo.checkDedup(env, 'calendar', refId).catch(() => ({ published: false }));
        if (dedup.published) continue;
        try {
          await publisherRepo.enqueue(env, {
            type: 'calendar',
            ref_id: refId,
            payload: { item_snapshot: event, overrides: {}, built: buildCalendarMessage(env, event, {}) },
            priority: impact === 'high' ? 10 : 50,
            created_by: 'auto-publish',
          });
        } catch (e) {
          console.warn('[publisher] autoPublish calendar enqueue failed:', e?.message || e);
        }
      }
    }

    if (type === 'analysis' && settings.auto_publish_analysis) {
      for (const analysis of items) {
        const refId = String(analysis.id || '').slice(0, 64);
        if (!refId) continue;
        const dedup = await publisherRepo.checkDedup(env, 'analysis', refId).catch(() => ({ published: false }));
        if (dedup.published) continue;
        try {
          await publisherRepo.enqueue(env, {
            type: 'analysis',
            ref_id: refId,
            payload: { item_snapshot: analysis, overrides: {}, built: buildAnalysisMessage(env, analysis, {}) },
            priority: 50,
            created_by: 'auto-publish',
          });
        } catch (e) {
          console.warn('[publisher] autoPublish analysis enqueue failed:', e?.message || e);
        }
      }
    }
  }

  return {
    handleGetSettings,
    handleUpdateSettings,
    handlePreview,
    handleEnqueue,
    handleListQueue,
    handleListLogs,
    handleRetry,
    handleCancel,
    handleDeleteSent,
    handleStats,
    handleCheckDedup,
    handleProcessNow,
    handleTestConnection,
    handleSendNow,
    processPublisherQueue,
    autoPublishCheck,
    readSettings,
    buildMessageForType,
    validateMessage,
    buildDeepLink,
  };
}

// ============================================================
// campaigns.js — Exchange Campaigns: user-facing UI (Stage 4)
// ------------------------------------------------------------
// Fullscreen list + detail pages for exchange campaigns, opened
// from the 3rd hero slider slide (assets/banner-campian.webp).
//
// STAGE 4 SCOPE (UI only):
//   - No backend exists yet. The module first tries the real API;
//     until Stage 5/6 ship it, ANY failure falls back to clearly
//     labeled DEMO data (badge on every card + notice bar +
//     detail note). Demo data is NEVER presented as real.
//   - Registration is NOT simulated: the join button only shows
//     an honest "opens once the server is live" toast. No POST is
//     ever sent to a registration endpoint.
//
// Expected Stage 5/6 API contract (documented for the backend phase):
//   GET {API_BASE}/api/campaigns
//     → 200 { status: 'ok', campaigns: [{
//          id, title_fa, title_en, summary_fa, summary_en,
//          body_fa, body_en, image_url (optional),
//          starts_at (ISO), ends_at (ISO),
//          status ('PUBLISHED'|'DRAFT'|'STOPPED'|'DELETED'),
//          effective_status ('ACTIVE'|'UPCOMING'|'ENDED'|'STOPPED'),
//          registered (bool, optional)
//        }] }
//   Anything else (non-ok, wrong shape, network error, timeout)
//   → demo mode with visible labeling.
//
// Integration (zero changes to app.js / dashboard.css):
//   - Script order: i18n.js → campaigns.js → app.js (defer), so
//     the global t() from i18n.js is available here.
//   - Telegram BackButton via window.tgBackPush / window.tgBackPop
//     exposed by app.js (referral.js pattern, stale-entry guards).
//   - Fullscreen overlay + scroll lock follow the wallet.js /
//     referral.js pattern (classList 'open' + body overflow hidden).
//   - The hero slider (app.js initHeroSlider) discovers slides
//     dynamically via .hero-slide / .hero-dot, so the 3rd slide
//     added in index.html needs no JS changes.
// ============================================================

(function () {
  'use strict';

  // ── State ──────────────────────────────────────────────────
  var _listOpen = false;          // list overlay open
  var _detailOpen = false;        // detail overlay open
  var _closingListFromBack = false;   // Back button already popped our entry
  var _closingDetailFromBack = false;
  var _campaigns = null;          // normalized campaign list
  var _demoMode = false;          // true → showing clearly-labeled demo data
  var _loadGeneration = 0;        // stale-response guard (referral F-8 pattern)
  var _detailElement = null;      // lazily created detail overlay
  var _escListenerInstalled = false;

  var LIST_PAGE_ID = 'campaigns-full-page';
  var DETAIL_CLASS = 'cmp-detail-overlay';
  var FETCH_TIMEOUT_MS = 6000;

  // ── Small utilities ───────────────────────────────────────
  function esc(str) {
    if (str === null || str === undefined) return '';
    return String(str)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;')
      .replace(/'/g, '&#39;');
  }

  function applyDir(el) {
    var lang = 'fa';
    try {
      if (typeof window !== 'undefined' && typeof window.currentLang === 'string' && window.currentLang) {
        lang = window.currentLang;
      } else if (typeof currentLang === 'string' && currentLang) {
        lang = currentLang;
      }
    } catch (e) { /* keep default */ }
    el.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');
  }

  function isFa() {
    try {
      var lang = null;
      if (typeof window !== 'undefined' && typeof window.currentLang === 'string' && window.currentLang) {
        lang = window.currentLang;
      } else if (typeof currentLang === 'string' && currentLang) {
        lang = currentLang;
      }
      return lang !== 'en';
    } catch (e) { return true; }
  }

  function formatDate(iso) {
    try {
      return new Date(iso).toLocaleDateString(isFa() ? 'fa-IR' : 'en-US', {
        year: 'numeric', month: 'short', day: 'numeric'
      });
    } catch (e) {
      return '';
    }
  }

  function toast(msg) {
    try {
      if (typeof showToast === 'function') showToast(msg);
    } catch (e) { /* non-fatal */ }
  }

  // ── Icons (inline SVG, wallet.js/referral.js convention) ──
  var ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    chevron: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    listIcon: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>'
  };

  // ── Effective status (mirrors the approved server state machine) ──
  // STOPPED wins over dates — a stopped campaign is never shown as
  // active even if its window says otherwise.
  function effectiveStatus(c, now) {
    if (!c) return 'STOPPED';
    if (c.status === 'STOPPED' || c.status === 'DELETED') return 'STOPPED';
    var start = c.starts_at ? Date.parse(c.starts_at) : null;
    var end = c.ends_at ? Date.parse(c.ends_at) : null;
    if (start !== null && !isNaN(start) && now < start) return 'UPCOMING';
    if (end !== null && !isNaN(end) && now > end) return 'ENDED';
    return 'ACTIVE';
  }

  // ── Demo data (clearly labeled — never presented as real) ──
  // Dates are relative to load time so all three states render
  // correctly whenever the page is opened.
  function buildDemoCampaigns() {
    var now = Date.now();
    var DAY = 24 * 60 * 60 * 1000;
    var iso = function (offsetDays) {
      return new Date(now + offsetDays * DAY).toISOString();
    };
    return [
      {
        id: 'demo-active-1',
        demo: true,
        status: 'PUBLISHED',
        starts_at: iso(-3),
        ends_at: iso(11),
        title_fa: 'کمپین نمایشی ۱ — در حال اجرا',
        title_en: 'Demo Campaign 1 — Active',
        summary_fa: 'این کارت نمایشی است و کمپین واقعی نیست. پس از راه‌اندازی سرور، کمپین‌های واقعی صرافی با عنوان، خلاصه، تصویر و دکمه ثبت‌نام در همین صفحه نمایش داده می‌شوند.',
        summary_en: 'This card is a demo, not a real campaign. Once the server goes live, real exchange campaigns will appear here with title, summary, image and a join button.',
        body_fa: 'این صفحه صرفاً برای نمایش ظاهر و رفتار بخش کمپین‌ها ساخته شده است.\n\nدر نسخه نهایی، هر کمپین شامل شرایط کامل، بازه زمانی دقیق و دکمه ثبت‌نام یک‌مرحله‌ای خواهد بود. ثبت‌نام واقعی پس از فعال‌سازی سرور در مرحله بعدی امکان‌پذیر می‌شود و در این نسخه نمایشی به هیچ وجه شبیه‌سازی نشده است.',
        body_en: 'This page exists purely to demonstrate the look and behavior of the campaigns section.\n\nIn the final version, every campaign will include full terms, an exact time window, and a one-tap join button. Real registration will be possible after the server is enabled in the next phase — it is deliberately NOT simulated in this demo.',
        image_url: null,
        registered: false
      },
      {
        id: 'demo-upcoming-2',
        demo: true,
        status: 'PUBLISHED',
        starts_at: iso(5),
        ends_at: iso(26),
        title_fa: 'کمپین نمایشی ۲ — به‌زودی',
        title_en: 'Demo Campaign 2 — Upcoming',
        summary_fa: 'نمونه‌ای از کمپینی که هنوز آغاز نشده است. تا پیش از شروع، وضعیت آن «به‌زودی» نمایش داده می‌شود و دکمه ثبت‌نام غیرفعال می‌ماند.',
        summary_en: 'Sample of a campaign that has not started yet. Until it begins, it shows the Upcoming status and the join button stays disabled.',
        body_fa: 'کمپین‌های پیش‌رو پس از رسیدن تاریخ آغاز، به‌صورت خودکار به وضعیت «در حال اجرا» تغییر می‌کنند.\n\nاین محتوا نمایشی است و هیچ داده واقعی در آن وجود ندارد.',
        body_en: 'Upcoming campaigns automatically switch to the Active state once their start date arrives.\n\nThis content is a demo and contains no real data.',
        image_url: null,
        registered: false
      },
      {
        id: 'demo-ended-3',
        demo: true,
        status: 'PUBLISHED',
        starts_at: iso(-20),
        ends_at: iso(-4),
        title_fa: 'کمپین نمایشی ۳ — پایان‌یافته',
        title_en: 'Demo Campaign 3 — Ended',
        summary_fa: 'نمونه‌ای از کمپینی که بازه آن به پایان رسیده است. پس از پایان، ثبت‌نام برای همیشه بسته می‌شود.',
        summary_en: 'Sample of a campaign whose window has closed. After it ends, registration stays permanently closed.',
        body_fa: 'کمپین‌های پایان‌یافته برای مرور و مشاهده نتایج در فهرست باقی می‌مانند اما دکمه ثبت‌نام آن‌ها غیرفعال است.\n\nاین کارت داده واقعی ندارد و فقط نمایشی است.',
        body_en: 'Ended campaigns stay in the list for review, but their join button is disabled.\n\nThis card holds no real data — demo only.',
        image_url: null,
        registered: false
      }
    ];
  }

  // ── API (real) — any failure falls back to demo mode ──
  function normalizeCampaign(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.id === undefined || raw.id === null) return null;
    return {
      id: String(raw.id),
      demo: false,
      status: typeof raw.status === 'string' ? raw.status : 'PUBLISHED',
      starts_at: raw.starts_at || null,
      ends_at: raw.ends_at || null,
      title_fa: raw.title_fa || raw.title_en || '',
      title_en: raw.title_en || raw.title_fa || '',
      summary_fa: raw.summary_fa || raw.summary_en || '',
      summary_en: raw.summary_en || raw.summary_fa || '',
      body_fa: raw.body_fa || raw.body_en || '',
      body_en: raw.body_en || raw.body_fa || '',
      image_url: raw.image_url || null,
      registered: !!raw.registered
    };
  }

  function fetchRealCampaigns() {
    return new Promise(function (resolve, reject) {
      var ctrl = null;
      var timer = null;
      try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
      var base = '';
      try { base = (typeof window.API_BASE === 'string' && window.API_BASE) ? window.API_BASE : ''; } catch (e) { base = ''; }
      var url = base + '/api/campaigns';
      var opts = { method: 'GET', headers: { 'Accept': 'application/json' } };
      if (ctrl) {
        opts.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* noop */ } }, FETCH_TIMEOUT_MS);
      }
      fetch(url, opts).then(function (res) {
        if (timer) clearTimeout(timer);
        if (!res.ok) { reject(new Error('HTTP ' + res.status)); return; }
        return res.json();
      }).then(function (data) {
        if (!data || data.status !== 'ok' || !Array.isArray(data.campaigns)) {
          reject(new Error('bad shape')); return;
        }
        var list = [];
        for (var i = 0; i < data.campaigns.length; i++) {
          var c = normalizeCampaign(data.campaigns[i]);
          if (c) list.push(c);
        }
        resolve(list);
      }).catch(function (err) {
        if (timer) clearTimeout(timer);
        reject(err);
      });
    });
  }

  // Resolves with { demoMode, campaigns } — callers apply the result ONLY
  // after their generation check, so a stale response can never overwrite
  // newer data (open→close→open quickly).
  function loadCampaigns() {
    return fetchRealCampaigns().then(function (list) {
      return { demoMode: false, campaigns: list };
    }).catch(function () {
      // Backend not live yet (expected until Stage 5/6) → clearly-labeled demo data.
      return { demoMode: true, campaigns: buildDemoCampaigns() };
    });
  }

  // ── Rendering helpers ─────────────────────────────────────
  function badgeClass(status) {
    if (status === 'ACTIVE') return 'cmp-badge cmp-badge--active';
    if (status === 'UPCOMING') return 'cmp-badge cmp-badge--upcoming';
    if (status === 'ENDED') return 'cmp-badge cmp-badge--ended';
    return 'cmp-badge cmp-badge--stopped';
  }

  function statusLabel(status) {
    if (status === 'ACTIVE') return t('cmp_status_active');
    if (status === 'UPCOMING') return t('cmp_status_upcoming');
    if (status === 'ENDED') return t('cmp_status_ended');
    return t('cmp_status_stopped');
  }

  function localized(c, field) {
    return isFa() ? (c[field + '_fa'] || c[field + '_en'] || '') : (c[field + '_en'] || c[field + '_fa'] || '');
  }

  function dateRange(c) {
    var parts = [];
    if (c.starts_at) parts.push(formatDate(c.starts_at));
    if (c.ends_at) parts.push(formatDate(c.ends_at));
    return parts.join(' → ');
  }

  function demoChip() {
    return '<span class="cmp-demo-chip">' + esc(t('cmp_demo_badge')) + '</span>';
  }

  function buildListSkeleton() {
    return '' +
      '<div class="cmp-header">' +
        '<button class="cmp-back-btn" data-action="close-list" type="button" aria-label="' + esc(t('cmp_back')) + '">' + ICONS.back + '</button>' +
        '<div class="cmp-header-text">' +
          '<h2>' + esc(t('cmp_page_title')) + '</h2>' +
          '<span class="cmp-header-sub">' + esc(t('cmp_page_subtitle')) + '</span>' +
        '</div>' +
      '</div>' +
      '<div class="cmp-body" id="cmp-list-body">' +
        '<div class="cmp-skel-card"><div class="cmp-skel-cover"></div><div class="cmp-skel-lines"><div class="cmp-skel-line cmp-skel-line--w60"></div><div class="cmp-skel-line cmp-skel-line--w90"></div><div class="cmp-skel-line cmp-skel-line--w40"></div></div></div>' +
        '<div class="cmp-skel-card"><div class="cmp-skel-cover"></div><div class="cmp-skel-lines"><div class="cmp-skel-line cmp-skel-line--w60"></div><div class="cmp-skel-line cmp-skel-line--w90"></div><div class="cmp-skel-line cmp-skel-line--w40"></div></div></div>' +
      '</div>';
  }

  function buildDemoNotice() {
    return '<div class="cmp-demo-notice" role="note">' + ICONS.info +
      '<span>' + esc(t('cmp_demo_notice')) + '</span></div>';
  }

  function buildCard(c, status) {
    var cover = c.image_url
      ? '<img src="' + esc(c.image_url) + '" alt="' + esc(localized(c, 'title')) + '" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' +
        (c.demo ? demoChip() : '')
      : '<div class="cmp-card-cover-icon">' + ICONS.gift + '</div>' +
        (c.demo ? demoChip() : '');
    return '' +
      '<article class="cmp-card" data-id="' + esc(c.id) + '" role="button" tabindex="0">' +
        '<div class="cmp-card-cover' + (c.image_url ? '' : ' cmp-card-cover--placeholder') + '">' + cover + '</div>' +
        '<div class="cmp-card-content">' +
          '<div class="cmp-card-title-row">' +
            '<h3 class="cmp-card-title">' + esc(localized(c, 'title')) + '</h3>' +
            '<span class="' + badgeClass(status) + '">' + esc(statusLabel(status)) + '</span>' +
          '</div>' +
          '<p class="cmp-card-summary">' + esc(localized(c, 'summary')) + '</p>' +
          '<div class="cmp-card-meta">' +
            '<span class="cmp-card-dates">' + ICONS.calendar + '<span>' + esc(dateRange(c)) + '</span></span>' +
            (c.registered && !c.demo
              ? '<span class="cmp-card-cta">' + esc(t('cmp_registered')) + '</span>'
              : '<span class="cmp-card-cta">' + esc(t('cmp_view_details')) + ICONS.chevron + '</span>') +
          '</div>' +
        '</div>' +
      '</article>';
  }

  function buildEmptyState() {
    return '' +
      '<div class="cmp-state">' + ICONS.listIcon +
        '<div class="cmp-state-title">' + esc(t('cmp_list_empty')) + '</div>' +
        '<div class="cmp-state-desc">' + esc(t('cmp_list_empty_desc')) + '</div>' +
      '</div>';
  }

  function buildErrorState() {
    return '' +
      '<div class="cmp-state">' + ICONS.info +
        '<div class="cmp-state-title">' + esc(t('cmp_list_error')) + '</div>' +
        '<div class="cmp-state-desc">' + esc(t('cmp_list_error_desc')) + '</div>' +
        '<button class="cmp-retry-btn" type="button" data-action="retry">' + esc(t('cmp_retry')) + '</button>' +
      '</div>';
  }

  function renderList() {
    var page = document.getElementById(LIST_PAGE_ID);
    if (!page) return;
    var body = document.getElementById('cmp-list-body');
    if (!body) return;
    if (!_campaigns || !_campaigns.length) {
      body.innerHTML = buildEmptyState();
      return;
    }
    var now = Date.now();
    var html = _demoMode ? buildDemoNotice() : '';
    for (var i = 0; i < _campaigns.length; i++) {
      var c = _campaigns[i];
      html += buildCard(c, effectiveStatus(c, now));
    }
    body.innerHTML = html;
  }

  // ── Detail page ────────────────────────────────────────────
  function findCampaign(id) {
    if (!_campaigns) return null;
    for (var i = 0; i < _campaigns.length; i++) {
      if (String(_campaigns[i].id) === String(id)) return _campaigns[i];
    }
    return null;
  }

  function buildDetail(c) {
    var status = effectiveStatus(c, Date.now());
    var joinable = (status === 'ACTIVE') && !c.registered;
    var btn;
    if (c.registered && !c.demo) {
      btn = '<button class="cmp-register-btn" type="button" disabled>' + esc(t('cmp_registered')) + '</button>';
    } else if (status === 'UPCOMING') {
      btn = '<button class="cmp-register-btn cmp-register-btn--closed" type="button" disabled>' + esc(t('cmp_registration_not_started')) + '</button>';
    } else if (status !== 'ACTIVE') {
      btn = '<button class="cmp-register-btn cmp-register-btn--closed" type="button" disabled>' + esc(t('cmp_registration_closed')) + '</button>';
    } else {
      // ACTIVE + not registered. Real registration is out of scope for
      // Stage 4 — the button only shows an honest "server not live" toast.
      // No POST is sent; nothing is simulated.
      btn = '<button class="cmp-register-btn" type="button" data-action="register-info">' + ICONS.gift + '<span>' + esc(t('cmp_register')) + '</span></button>';
    }
    var cover = c.image_url
      ? '<img src="' + esc(c.image_url) + '" alt="' + esc(localized(c, 'title')) + '" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">' +
        (c.demo ? demoChip() : '')
      : '<div class="cmp-card-cover-icon">' + ICONS.gift + '</div>' +
        (c.demo ? demoChip() : '');
    return '' +
      '<div class="cmp-header">' +
        '<button class="cmp-back-btn" data-action="close-detail" type="button" aria-label="' + esc(t('cmp_back')) + '">' + ICONS.back + '</button>' +
        '<div class="cmp-header-text">' +
          '<h2>' + esc(t('cmp_detail_title')) + '</h2>' +
        '</div>' +
      '</div>' +
      '<div class="cmp-detail-body">' +
        '<div class="cmp-detail-cover' + (c.image_url ? '' : ' cmp-card-cover--placeholder') + '">' + cover + '</div>' +
        '<div class="cmp-detail-title-row">' +
          '<h1 class="cmp-detail-title">' + esc(localized(c, 'title')) + '</h1>' +
          '<span class="' + badgeClass(status) + '">' + esc(statusLabel(status)) + '</span>' +
        '</div>' +
        '<div class="cmp-detail-period">' + ICONS.clock +
          '<span>' + esc(t('cmp_campaign_period')) + ': <span class="cmp-period-range">' + esc(dateRange(c)) + '</span></span>' +
        '</div>' +
        '<p class="cmp-detail-summary">' + esc(localized(c, 'summary')) + '</p>' +
        '<div class="cmp-detail-section-title">' + ICONS.listIcon + '<span>' + esc(t('cmp_terms')) + '</span></div>' +
        '<p class="cmp-detail-body-text">' + esc(localized(c, 'body')) + '</p>' +
        (c.demo ? '<div class="cmp-demo-notice" role="note">' + ICONS.info + '<span>' + esc(t('cmp_demo_detail_note')) + '</span></div>' : '') +
      '</div>' +
      '<div class="cmp-detail-bar">' +
        btn +
      '</div>';
  }

  function ensureDetailElement() {
    if (_detailElement && _detailElement.isConnected) return _detailElement;
    var el = document.createElement('div');
    el.className = DETAIL_CLASS;
    el.setAttribute('role', 'dialog');
    el.setAttribute('aria-modal', 'true');
    document.body.appendChild(el);
    _detailElement = el;
    return el;
  }

  // ── List overlay: open / close (wallet + referral patterns) ──
  function open() {
    var page = document.getElementById(LIST_PAGE_ID);
    if (!page) return;
    if (_listOpen) return; // double-tap guard
    _listOpen = true;

    applyDir(page);
    page.innerHTML = buildListSkeleton();
    page.classList.add('open');
    document.body.style.overflow = 'hidden'; // background scroll lock
    installEscListener();

    // Telegram Back button: Back closes the list (stale-entry guard).
    if (typeof window.tgBackPush === 'function') {
      window.tgBackPush(function () {
        if (!_listOpen) return; // stale entry — already closed
        _closingListFromBack = true;
        close();
      });
    }

    var generation = ++_loadGeneration;
    page.scrollTop = 0;
    loadCampaigns().then(function (result) {
      if (generation !== _loadGeneration) return; // stale response — page was closed
      _demoMode = result.demoMode;
      _campaigns = result.campaigns;
      renderList();
    }).catch(function () {
      if (generation !== _loadGeneration) return;
      var body = document.getElementById('cmp-list-body');
      if (body) body.innerHTML = buildErrorState();
    });
  }

  function close() {
    if (!_listOpen) return; // already closed (Back + in-page button double-fire)
    _listOpen = false;

    // If NOT closed via Telegram Back, pop our own entry; tgBackPop calls
    // our closeFn again but _listOpen is already false → harmless no-op.
    if (!_closingListFromBack && typeof window.tgBackPop === 'function') {
      window.tgBackPop();
    }
    _closingListFromBack = false;

    _loadGeneration++; // invalidate any in-flight response
    if (_detailOpen) closeDetail(); // safety: never orphan the detail overlay

    var page = document.getElementById(LIST_PAGE_ID);
    if (!page) return;
    page.classList.remove('open');
    document.body.style.overflow = ''; // release scroll lock
  }

  // Retry from the error state — the list overlay stays open, only the
  // body swaps back to a skeleton while the load re-runs.
  function retryLoad() {
    if (!_listOpen) return;
    var body = document.getElementById('cmp-list-body');
    if (body) {
      body.innerHTML =
        '<div class="cmp-skel-card"><div class="cmp-skel-cover"></div></div>' +
        '<div class="cmp-skel-card"><div class="cmp-skel-cover"></div></div>';
    }
    var generation = ++_loadGeneration; // invalidate any earlier in-flight load
    loadCampaigns().then(function (result) {
      if (generation !== _loadGeneration) return; // page closed / superseded
      _demoMode = result.demoMode;
      _campaigns = result.campaigns;
      renderList();
    }).catch(function () {
      if (generation !== _loadGeneration) return;
      var b = document.getElementById('cmp-list-body');
      if (b) b.innerHTML = buildErrorState();
    });
  }

  // ── Detail overlay: open / close ───────────────────────────
  function openDetail(id) {
    if (!_listOpen) return; // detail only opens from the list
    var c = findCampaign(id);
    if (!c) return;
    if (_detailOpen) return; // double-tap guard
    _detailOpen = true;

    var el = ensureDetailElement();
    applyDir(el);
    el.innerHTML = buildDetail(c);
    el.classList.add('open');
    el.scrollTop = 0;

    if (typeof window.tgBackPush === 'function') {
      window.tgBackPush(function () {
        if (!_detailOpen) return; // stale entry — already closed
        _closingDetailFromBack = true;
        closeDetail();
      });
    }
  }

  function closeDetail() {
    if (!_detailOpen) return;
    _detailOpen = false;

    if (!_closingDetailFromBack && typeof window.tgBackPop === 'function') {
      window.tgBackPop();
    }
    _closingDetailFromBack = false;

    if (!_detailElement) return;
    _detailElement.classList.remove('open');
    _detailElement.innerHTML = '';
  }

  // ── Event delegation (list cards, retry, close buttons) ────
  document.addEventListener('click', function (ev) {
    var target = ev.target;
    if (!target || !(target instanceof Element)) return;

    var actionEl = target.closest('[data-action]');
    if (actionEl) {
      var action = actionEl.getAttribute('data-action');
      if (action === 'close-list') { close(); return; }
      if (action === 'close-detail') { closeDetail(); return; }
      if (action === 'retry') {
        retryLoad();
        return;
      }
      if (action === 'register-info') {
        // Honest notice — registration is NOT simulated in Stage 4.
        toast(t('cmp_register_soon'));
        return;
      }
    }

    var card = target.closest('.cmp-card');
    if (card && card.dataset && card.dataset.id) {
      openDetail(card.dataset.id);
    }
  });

  // Keyboard: cards are focusable (Enter/Space open the detail).
  document.addEventListener('keydown', function (ev) {
    if (ev.key !== 'Enter' && ev.key !== ' ') return;
    var target = ev.target;
    if (!target || !(target instanceof Element)) return;
    var card = target.closest('.cmp-card');
    if (card && card.dataset && card.dataset.id && target === card) {
      ev.preventDefault();
      openDetail(card.dataset.id);
    }
  });

  // Escape closes the topmost campaigns overlay (desktop browsers).
  function installEscListener() {
    if (_escListenerInstalled) return;
    _escListenerInstalled = true;
    document.addEventListener('keydown', function (ev) {
      if (ev.key !== 'Escape') return;
      if (_detailOpen) { closeDetail(); return; }
      if (_listOpen) { close(); }
    });
  }

  // ── Public API (hero slide onclick + console debugging) ───
  window.CampaignsApp = {
    open: open,
    close: close,
    openDetail: openDetail,
    closeDetail: closeDetail
  };
})();

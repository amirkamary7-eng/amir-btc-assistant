// ============================================================
// campaigns.js — Exchange Campaigns: user-facing UI (Stage 4)
// ------------------------------------------------------------
// Fullscreen list + detail pages for exchange campaigns, opened
// from the 3rd hero slider slide (assets/banner-campian.webp).
//
// AUTH-WAIT + HONEST-ERRORS FIX (published-campaign visibility):
//   - Every authenticated request waits for Telegram auth readiness FIRST
//     (same waitForApiReady gate app.js apiFetch uses). On cold-open the
//     SDK may not have populated initData yet — a premature fetch answered
//     401 and the old demo fallback masked the failure, so published
//     campaigns looked like they were missing for users.
//   - API failures are NEVER masked as demo data or an empty list — the
//     list shows a real error state with a retry button. The demo-data
//     fallback (Stage 4 pre-backend artifact) was removed.
//   - Registration is a one-tap POST to the real endpoint; success is only
//     ever reported when the SERVER confirms it (registered === true).
//
// Live API contract (Stage 5B backend, src/controllers/campaigns.js):
//   GET {API_BASE}/api/campaigns
//     → 200 { status: 'ok', count, campaigns: [{
//          id, title_fa, title_en, summary_fa, summary_en,
//          body_fa, body_en, image_url (optional),
//          starts_at (ISO), ends_at (ISO|null),
//          status ('PUBLISHED'|'STOPPED'),
//          effective_status ('ACTIVE'|'UPCOMING'|'ENDED'|'STOPPED'),
//          registered (bool)
//        }] }
//   POST {API_BASE}/api/campaigns/:id/register (one-tap, no body)
//     → 200 { status:'ok', registered:true, already_registered:bool,
//           campaign_id, registered_at }
//     → 400 INVALID_CAMPAIGN_ID | 404 CAMPAIGN_NOT_FOUND |
//       409 CAMPAIGN_NOT_STARTED | CAMPAIGN_ENDED | CAMPAIGN_STOPPED |
//       CAMPAIGN_STATE_CHANGED | 429 RATE_LIMITED | 503 DB
//   Anything else (non-ok, wrong shape, network error, timeout)
//   → honest error state with a retry button (never demo/empty masking).
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
  var _campaigns = null;          // normalized campaign list (null until a successful load)
  var _loadGeneration = 0;        // stale-response guard (referral F-8 pattern)
  var _detailElement = null;      // lazily created detail overlay
  var _escListenerInstalled = false;

  var LIST_PAGE_ID = 'campaigns-full-page';
  var DETAIL_CLASS = 'cmp-detail-overlay';
  var FETCH_TIMEOUT_MS = 6000;
  var REGISTER_TIMEOUT_MS = 8000;
  var _registeringId = null;       // campaign id with an in-flight register POST
  var _detailCampaignId = null;    // campaign shown in the detail overlay

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

  // AUTH-WAIT FIX: apiFetch() (app.js) awaits waitForApiReady() before every
  // authenticated request because on cold-open the Telegram SDK may not have
  // populated initData yet (documented app.js race). This module must do the
  // SAME - a fetch sent before auth is ready answers 401 and used to fall into
  // the old demo fallback ("published campaigns don't show"). Resolves even
  // when the helper is absent/failing (older app.js builds): never blocks.
  function _cmpWaitAuthReady() {
    return new Promise(function (resolve) {
      try {
        if (typeof window.waitForApiReady === 'function') {
          Promise.resolve(window.waitForApiReady(8000)).then(resolve, resolve);
          return;
        }
      } catch (e) { /* non-fatal */ }
      resolve();
    });
  }

  // Internal image URLs (uploaded via the admin WebP upload - served by the
  // API worker as /api/advertisements/image/:id) are RELATIVE. The Mini App
  // is served from a DIFFERENT origin (Pages) than the API worker, so a
  // relative <img src> would 404 against the Pages origin. Prefix the API
  // base at RENDER time - the stored image_url stays exactly as the server
  // returned it (no data change). External http(s) URLs pass through as-is.
  function resolveImgUrl(u) {
    if (!u) return u;
    if (/^https?:\/\//i.test(u)) return u;
    if (u.charAt(0) === '/') {
      var base = '';
      try { base = (typeof window.API_BASE === 'string' && window.API_BASE) ? window.API_BASE : ''; } catch (e) { base = ''; }
      return base ? base.replace(/\/$/, '') + u : u;
    }
    return u;
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

  // ── API (real) — failures surface as the honest error state ──
  // Signed Telegram initData header — the same header app.js apiFetch sends.
  // Guarded: outside the Telegram WebApp (or before app.js has run) it is
  // simply absent and the server answers 401 → honest error state + retry.
  function apiHeaders(withJson) {
    var h = { 'Accept': 'application/json' };
    if (withJson) h['Content-Type'] = 'application/json';
    try {
      if (typeof window.getTelegramInitData === 'function') {
        var d = window.getTelegramInitData();
        if (d) h['X-Telegram-Init-Data'] = d;
      }
    } catch (e) { /* non-fatal — server 401 → honest error state */ }
    return h;
  }

  function normalizeCampaign(raw) {
    if (!raw || typeof raw !== 'object') return null;
    if (raw.id === undefined || raw.id === null) return null;
    return {
      id: String(raw.id),
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

  async function fetchRealCampaigns() {
    // AUTH-WAIT FIRST (visibility fix): never send the request before the
    // Telegram auth is ready - a premature fetch gets 401 and the campaign
    // list would fail for users who just cold-opened the Mini App.
    await _cmpWaitAuthReady();
    var ctrl = null;
    var timer = null;
    try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
    var base = '';
    try { base = (typeof window.API_BASE === 'string' && window.API_BASE) ? window.API_BASE : ''; } catch (e) { base = ''; }
    var url = base + '/api/campaigns';
    var opts = { method: 'GET', headers: apiHeaders(false) };
    if (ctrl) {
      opts.signal = ctrl.signal;
      timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* noop */ } }, FETCH_TIMEOUT_MS);
    }
    try {
      var res = await fetch(url, opts);
      if (timer) clearTimeout(timer);
      if (!res.ok) { throw new Error('HTTP ' + res.status); }
      var data = await res.json();
      if (!data || data.status !== 'ok' || !Array.isArray(data.campaigns)) {
        throw new Error('bad shape');
      }
      var list = [];
      for (var i = 0; i < data.campaigns.length; i++) {
        var c = normalizeCampaign(data.campaigns[i]);
        if (c) list.push(c);
      }
      return list;
    } catch (err) {
      if (timer) clearTimeout(timer);
      throw err;
    }
  }

  // One-tap registration (Stage 5B). ALWAYS resolves with
  // { ok, status, code, body } — never rejects. `ok` mirrors HTTP 200;
  // success is only ever reported when the SERVER confirmed it
  // (body.registered === true after a DB-verified insert).
  function registerCampaign(id) {
    return new Promise(function (resolve) {
      var ctrl = null;
      var timer = null;
      try { ctrl = new AbortController(); } catch (e) { ctrl = null; }
      var base = '';
      try { base = (typeof window.API_BASE === 'string' && window.API_BASE) ? window.API_BASE : ''; } catch (e) { base = ''; }
      var url = base + '/api/campaigns/' + encodeURIComponent(String(id)) + '/register';
      var opts = { method: 'POST', headers: apiHeaders(true) };
      if (ctrl) {
        opts.signal = ctrl.signal;
        timer = setTimeout(function () { try { ctrl.abort(); } catch (e) { /* noop */ } }, REGISTER_TIMEOUT_MS);
      }
      fetch(url, opts).then(function (res) {
        if (timer) clearTimeout(timer);
        return res.json().catch(function () { return null; }).then(function (data) {
          resolve({ ok: res.ok, status: res.status, code: (data && data.code) || '', body: data || null });
        });
      }).catch(function () {
        if (timer) clearTimeout(timer);
        resolve({ ok: false, status: 0, code: 'NETWORK', body: null });
      });
    });
  }

  // Register button click in the detail overlay (real data mode only).
  // Demo mode never reaches this path — the honest not-live toast is shown
  // instead, and no POST is sent.
  function handleRegisterClick(btn) {
    var c = _detailCampaignId ? findCampaign(_detailCampaignId) : null;
    if (!c || c.registered) return;
    if (_registeringId) return; // one in-flight registration at a time
    _registeringId = c.id;

    // In-flight visual state (button disabled + loading label).
    if (btn) btn.disabled = true;
    var label = btn && btn.querySelector ? btn.querySelector('span') : null;
    if (label) label.textContent = t('cmp_register_in_progress');

    registerCampaign(c.id).then(function (res) {
      _registeringId = null;
      var serverConfirmed = res && res.ok && res.body && res.body.registered === true;
      if (serverConfirmed) {
        // Server (database) confirmed the registration — safe to announce.
        c.registered = true;
        toast(t(res.body.already_registered ? 'cmp_register_already' : 'cmp_register_success'));
        if (_detailOpen && _detailElement) _detailElement.innerHTML = buildDetail(c);
        renderList();
        return;
      }

      // Failure — map the server code to an honest message. The detail bar
      // is re-rendered fresh so the user can retry (unless the campaign
      // state itself makes the button permanently closed).
      var code = res && res.code ? res.code : '';
      if (code === 'CAMPAIGN_STOPPED') c.status = 'STOPPED';
      if (_detailOpen && _detailElement) _detailElement.innerHTML = buildDetail(c);

      if (code === 'CAMPAIGN_NOT_STARTED') toast(t('cmp_registration_not_started'));
      else if (code === 'CAMPAIGN_ENDED' || code === 'CAMPAIGN_STOPPED' || code === 'CAMPAIGN_STATE_CHANGED') toast(t('cmp_register_stopped'));
      else if (code === 'RATE_LIMITED' || res.status === 429) toast(t('cmp_register_rate_limited'));
      else toast(t('cmp_register_error'));
    });
  }

  // Resolves with { campaigns } — callers apply the result ONLY after their
  // generation check, so a stale response can never overwrite newer data
  // (open→close→open quickly). REJECTS on failure — the caller renders the
  // honest error state with a retry button. Failures are never masked as
  // demo data or an empty list (published campaigns must never silently
  // disappear behind a "demo" or empty state).
  function loadCampaigns() {
    return fetchRealCampaigns().then(function (list) {
      return { campaigns: list };
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

  function buildCard(c, status) {
    var cover = c.image_url
      ? '<img src="' + esc(resolveImgUrl(c.image_url)) + '" alt="' + esc(localized(c, 'title')) + '" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">'
      : '<div class="cmp-card-cover-icon">' + ICONS.gift + '</div>';
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
            (c.registered
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

  function buildErrorState(err) {
    // Real error message (visibility fix): the failure reason is surfaced to
    // the user — never masked as demo data or an empty list.
    var detail = '';
    try {
      var msg = err && err.message ? String(err.message) : '';
      if (msg) detail = msg.slice(0, 60);
    } catch (e) { /* non-fatal */ }
    return '' +
      '<div class="cmp-state">' + ICONS.info +
        '<div class="cmp-state-title">' + esc(t('cmp_list_error')) + '</div>' +
        '<div class="cmp-state-desc">' + esc(t('cmp_list_error_desc')) +
          (detail ? '<br><span style="opacity:.55;font-size:12px">' + esc(detail) + '</span>' : '') + '</div>' +
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
    var html = '';
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
    if (c.registered) {
      btn = '<button class="cmp-register-btn" type="button" disabled>' + esc(t('cmp_registered')) + '</button>';
    } else if (status === 'UPCOMING') {
      btn = '<button class="cmp-register-btn cmp-register-btn--closed" type="button" disabled>' + esc(t('cmp_registration_not_started')) + '</button>';
    } else if (status !== 'ACTIVE') {
      btn = '<button class="cmp-register-btn cmp-register-btn--closed" type="button" disabled>' + esc(t('cmp_registration_closed')) + '</button>';
    } else {
      // ACTIVE + not registered: one-tap registration POST (Stage 5B).
      btn = '<button class="cmp-register-btn" type="button" data-action="register-info">' + ICONS.gift + '<span>' + esc(t('cmp_register')) + '</span></button>';
    }
    var cover = c.image_url
      ? '<img src="' + esc(resolveImgUrl(c.image_url)) + '" alt="' + esc(localized(c, 'title')) + '" loading="lazy" decoding="async" onerror="this.style.display=\'none\'">'
      : '<div class="cmp-card-cover-icon">' + ICONS.gift + '</div>';
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
      _campaigns = result.campaigns;
      renderList();
    }).catch(function (err) {
      if (generation !== _loadGeneration) return; // stale response — page was closed
      _campaigns = null; // never keep stale data behind a failed load
      var body = document.getElementById('cmp-list-body');
      if (body) body.innerHTML = buildErrorState(err);
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
      _campaigns = result.campaigns;
      renderList();
    }).catch(function (err) {
      if (generation !== _loadGeneration) return; // page closed / superseded
      _campaigns = null; // never keep stale data behind a failed load
      var b = document.getElementById('cmp-list-body');
      if (b) b.innerHTML = buildErrorState(err);
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
    _detailCampaignId = c.id;
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
    _detailCampaignId = null;
    _registeringId = null; // a closed overlay cancels any pending UI update

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
        // One-tap POST to the live endpoint. (Demo mode removed — the
        // backend is live and failures now surface as honest error states.)
        handleRegisterClick(actionEl);
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

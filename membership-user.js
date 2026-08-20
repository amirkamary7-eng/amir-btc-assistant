/**
 * MembershipApp — Premium badge for the Mini App profile card.
 *
 * Renders a 3D diamond badge INSIDE the existing .profile-card (top-left corner).
 * Also applies premium effects to the entire .profile-card when VIP.
 *
 * VIP/PREMIUM/ELITE → gold diamond with strong glow + halo + shimmer + spark.
 *   Profile card gets gold border + breathing halo + periodic border shine.
 * FREE → locked dim metallic badge with lock icon + subtle glow.
 * Click → opens premium popup with 6-step timeline + status display.
 */
(function () {
  'use strict';

  var API_BASE = window.API_BASE || '';
  var _cache = null;
  var _loading = false;
  var _popupOpen = false;
  var _requirement = null;
  // PHASE 7B (B1): Active Premium Rules cache. Mirrors the _requirement pattern
  // (load once, cache for the session). The backend also KV-caches the rules
  // payload for 5 min under 'mb:rules:active', so repeated frontend fetches
  // are cheap — but we avoid even that by caching in-memory per session.
  var _rules = null;
  // PHASE 7B (B1): Tracks whether the user has accepted the currently-active
  // rules version in the current popup session. Reset when popup closes.
  var _rulesAcceptedVersion = null;

  // Fallback values used if the requirement API is unavailable (pre-migration
  // or network error). These match the EXACT current hard-coded behavior so
  // there is zero user-visible change in the fallback path.
  var FALLBACK_REQUIREMENT = {
    active: true,
    exchange_name: 'Bitunix',
    exchange_register_url: 'https://www.bitunix.com/register?vipCode=AMIRBTC',
    uid_label: 'شناسه کاربری Bitunix خود را وارد کنید',
    referral_code: 'AMIRBTC',
    label: 'Bitunix + First Trade',
    metadata: {
      timeline_step_1: 'ثبت‌نام از طریق لینک رسمی Bitunix',
      button_text: 'ثبت‌نام در Bitunix',
    },
  };

  // PHASE 7B (B1): Fallback when /api/membership/rules is unavailable or
  // returns no active version. active:false tells the popup to render the
  // rules section in a soft "rules currently unavailable" mode that does
  // NOT block submission (mirrors the backend FAIL-OPEN behavior at
  // src/controllers/membership.js:242-256 — if the rules table is missing
  // or has no ACTIVE version, /request succeeds without acceptance).
  var FALLBACK_RULES = { active: false, version: null, title: null, body_markdown: null, summary: null };

  function getInitData() {
    return window.Telegram?.WebApp?.initData || '';
  }

  /**
   * PHASE 7B (B1): apiFetch now returns parsed JSON even on non-2xx responses
   * so callers can read structured error fields like `code` and `active_version`
   * (e.g. RULES_NOT_ACCEPTED). The returned object gains an `_httpStatus` field.
   *
   * Backward compatibility: callers that only check `res.ok` still work.
   * Callers that previously relied on the throw-on-non-2xx behavior must now
   * check `res.ok` explicitly (the only such caller was the old submitUid,
   * which is updated below to use the structured payload).
   *
   * Network errors (fetch() rejection) still throw — those are not HTTP
   * responses and cannot carry a JSON body.
   */
  function apiFetch(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-Telegram-Init-Data'] = getInitData();
    options.headers['Cache-Control'] = 'no-store';
    return fetch(API_BASE + path, options).then(function (res) {
      // Always parse JSON if possible, even on error responses, so callers
      // can read structured error fields (code, active_version, details, etc.).
      return res.json().then(function (body) {
        var enriched = body || {};
        enriched._httpStatus = res.status;
        enriched.ok = res.ok;
        return enriched;
      }).catch(function () {
        // JSON parse failed (e.g. empty body) — return a minimal object.
        return { ok: res.ok, _httpStatus: res.status, error: 'HTTP ' + res.status };
      });
    });
  }

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  /** Phase 2: Load the active exchange requirement from the API. */
  async function loadRequirement() {
    if (_requirement) return _requirement;
    try {
      var res = await apiFetch('/api/membership/requirement');
      if (res && res.ok && res.data && res.data.active) {
        _requirement = res.data;
      } else {
        _requirement = FALLBACK_REQUIREMENT;
      }
    } catch (e) {
      _requirement = FALLBACK_REQUIREMENT;
    }
    return _requirement;
  }

  /** Synchronous getter — returns cached requirement or fallback. */
  function getRequirement() {
    return _requirement || FALLBACK_REQUIREMENT;
  }

  /**
   * PHASE 7B (B1): Load the active Premium Rules from the API.
   * Mirrors the loadRequirement() pattern: load once, cache for the session.
   * The backend KV-caches the rules payload for 5 min, so even the first
   * fetch is cheap. On any error or non-active response, falls back to
   * FALLBACK_RULES (active:false) which renders the rules section in a
   * soft non-blocking mode — matching the backend FAIL-OPEN behavior.
   */
  async function loadRules() {
    if (_rules) return _rules;
    try {
      var res = await apiFetch('/api/membership/rules');
      if (res && res.ok && res.data && res.data.active) {
        _rules = res.data;
      } else if (res && res.ok && res.data && res.data.active === false) {
        // Backend returned a valid response but no active rules version.
        _rules = FALLBACK_RULES;
      } else {
        _rules = FALLBACK_RULES;
      }
    } catch (e) {
      _rules = FALLBACK_RULES;
    }
    return _rules;
  }

  /** PHASE 7B (B1): Synchronous getter — returns cached rules or fallback. */
  function getRules() {
    return _rules || FALLBACK_RULES;
  }

  /**
   * PHASE 7B (B1): Force-refresh the rules cache. Used when the backend
   * returns RULES_NOT_ACCEPTED with a new active_version (e.g. admin
   * published a new rules version while the user had the popup open).
   * Resets _rulesAcceptedVersion so the user must re-accept.
   */
  async function refreshRules() {
    _rules = null;
    _rulesAcceptedVersion = null;
    return loadRules();
  }

  function formatFaDate(iso) {
    if (!iso) return '—';
    try {
      return new Intl.DateTimeFormat('fa-IR', { year: 'numeric', month: 'long', day: 'numeric' }).format(new Date(iso));
    } catch (e) { return iso.slice(0, 10); }
  }

  function isPremium(status) {
    return status && status.level !== 'FREE' && status.status === 'APPROVED';
  }

  // 3D Diamond SVG icon
  var DIAMOND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3h12l4 6-10 13L2 9z"/>' +
    '<path d="M11 3 8 9l4 13 4-13-3-6"/>' +
    '<path d="M2 9h20"/>' +
    '</svg>';

  // Lock icon SVG
  var LOCK_SVG = '<svg width="7" height="7" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V7a4 4 0 0 1 8 0v4"/></svg>';

  /** Render the badge + apply profile card effects. */
  function renderBadge(status) {
    var badge = document.getElementById('membership-badge');
    var profileCard = document.querySelector('.profile-card');
    if (!badge) return;

    var premium = isPremium(status);
    badge.className = 'membership-badge ' + (premium ? 'membership-badge--premium' : 'membership-badge--free');
    badge.innerHTML =
      '<div class="mb-diamond mb-diamond-float">' +
        (premium ? '<div class="mb-diamond-halo"></div>' : '') +
        '<div class="mb-diamond-glow"></div>' +
        '<div class="mb-diamond-svg">' + DIAMOND_SVG + '</div>' +
        '<div class="mb-diamond-shimmer"></div>' +
        (!premium ? '<div class="mb-lock-icon">' + LOCK_SVG + '</div>' : '') +
      '</div>' +
      '<span class="mb-badge-text">' + (premium ? 'PREMIUM' : 'فعال‌سازی Premium') + '</span>';
    badge.title = premium ? 'عضو ویژه AMIRBTC' : 'ارتقا به عضویت ویژه';

    // Apply/remove premium effects on profile card
    if (profileCard) {
      // PHASE 5: Remove all previous cosmetic classes
      var classesToRemove = [];
      profileCard.classList.forEach(function (cls) {
        if (cls.indexOf('profile-cosmetic--') === 0) classesToRemove.push(cls);
      });
      classesToRemove.forEach(function (cls) { profileCard.classList.remove(cls); });

      if (premium) {
        profileCard.classList.add('profile-card--premium');
        // PHASE 5: Apply active cosmetic class if present
        if (status && status.active_cosmetic && status.active_cosmetic.metadata) {
          var cssClass = status.active_cosmetic.metadata.css_class;
          if (cssClass) profileCard.classList.add(cssClass);
        }
      } else {
        profileCard.classList.remove('profile-card--premium');
      }
    }
  }

  function renderSkeleton() {
    var badge = document.getElementById('membership-badge');
    if (badge) {
      badge.className = 'membership-badge membership-badge--loading';
      badge.innerHTML = '<div class="mb-badge-skeleton"></div>';
    }
  }

  function renderError() {
    var badge = document.getElementById('membership-badge');
    if (badge) {
      badge.className = 'membership-badge';
      badge.innerHTML = '';
    }
  }

  var _welcomeChecked = false;

  async function loadCard() {
    if (_cache || _loading) return;
    _loading = true;
    renderSkeleton();
    try {
      loadRequirement().catch(function () { /* fallback handles it */ });
      // PHASE 7B (B1): Pre-fetch active rules in the background so the
      // activation popup renders instantly when opened. Non-blocking —
      // the popup's own openActivationPopup() will await loadRules() if
      // the pre-fetch hasn't completed yet.
      loadRules().catch(function () { /* fallback handles it */ });
      var res = await apiFetch('/api/membership/status');
      if (res && res.ok && res.data) {
        _cache = res.data;
        renderBadge(res.data);
        // Phase 4: Auto-show one-time Premium welcome popup.
        // Only shows if: user is premium AND welcomeShown === false AND not already checked this session.
        if (isPremium(res.data) && res.data.welcomeShown === false && !_welcomeChecked) {
          _welcomeChecked = true;
          setTimeout(function () { openWelcomePopup(res.data); }, 600);
        }
      } else {
        renderError();
      }
    } catch (e) {
      renderError();
    } finally {
      _loading = false;
    }
  }

  /** Mark welcome popup as shown in backend (fire-and-forget, one-time). */
  function markWelcomeShownInBackend() {
    try {
      apiFetch('/api/membership/welcome-shown', { method: 'POST' }).catch(function () {});
    } catch (e) { /* non-critical */ }
    if (_cache) { _cache.welcomeShown = true; }
  }

  /** Open membership detail. */
  function open() {
    if (!_cache) { loadCard(); return; }
    if (_popupOpen) return;
    _popupOpen = true;

    if (isPremium(_cache)) {
      openVipStatusPopup(_cache);
    } else {
      checkPendingAndOpenPopup();
    }
  }

  async function checkPendingAndOpenPopup() {
    try {
      var res = await apiFetch('/api/membership/request');
      var requests = (res && res.ok && res.data) ? res.data : [];
      var pending = requests.find(function (r) { return r.status === 'PENDING'; });
      var rejected = requests.find(function (r) { return r.status === 'REJECTED'; });

      if (pending) {
        openPendingPopup(pending);
      } else {
        openActivationPopup(rejected);
      }
    } catch (e) {
      openActivationPopup(null);
    }
  }

  function closePopup() {
    var overlay = document.querySelector('.mb-popup-overlay');
    if (overlay) {
      overlay.style.animation = 'mb-fade-in 0.2s ease reverse';
      setTimeout(function () { overlay.remove(); }, 200);
    }
    _popupOpen = false;
    // PHASE 7B (B1): Reset per-popup rules acceptance state so re-opening
    // the activation popup requires fresh acceptance. The rules payload
    // itself (_rules) stays cached for the session to avoid duplicate fetches.
    _rulesAcceptedVersion = null;
  }

  // ─── Phase 4: Premium Welcome Popup (one-time, auto-show) ────────────────
  // Full-screen, glassmorphism, particle/sparkle animations, diamond glow.
  // Shows exactly once per Premium activation — controlled by welcome_shown flag.

  function openWelcomePopup(status) {
    closePopup();
    _popupOpen = true;

    var levelLabel = { VIP: 'VIP', PREMIUM: 'پرمیوم', ELITE: 'الیت' }[status.level] || status.level;

    // Build sparkle particles (12 floating dots)
    var sparkles = '';
    for (var i = 0; i < 12; i++) {
      sparkles += '<span class="mb-welcome-sparkle" style="animation-delay:' + (i * 0.3) + 's;left:' + (5 + Math.random() * 90) + '%;top:' + (5 + Math.random() * 90) + '%"></span>';
    }

    // Build ring particles (6 orbiting dots)
    var ringDots = '';
    for (var r = 0; r < 6; r++) {
      ringDots += '<span class="mb-welcome-ring-dot" style="animation-delay:' + (r * 0.5) + 's;transform:rotate(' + (r * 60) + 'deg) translateY(-50px)"></span>';
    }

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay mb-welcome-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closeWelcomePopup(); };
    overlay.innerHTML =
      '<div class="mb-welcome-card">' +
        '<div class="mb-welcome-bg-blur"></div>' +
        sparkles +
        '<div class="mb-welcome-content">' +
          '<div class="mb-welcome-diamond-wrap">' +
            '<div class="mb-welcome-ring">' + ringDots + '</div>' +
            '<div class="mb-welcome-ring mb-welcome-ring-2"></div>' +
            '<div class="mb-welcome-diamond-halo"></div>' +
            '<div class="mb-welcome-diamond-glow"></div>' +
            '<div class="mb-welcome-diamond-pulse"></div>' +
            '<div class="mb-welcome-diamond-icon">' + DIAMOND_SVG + '</div>' +
            '<div class="mb-welcome-diamond-shimmer"></div>' +
          '</div>' +
          '<div class="mb-welcome-badge">PREMIUM</div>' +
          '<h2 class="mb-welcome-title">تبریک!</h2>' +
          '<p class="mb-welcome-subtitle">عضویت ' + esc(levelLabel) + ' شما با موفقیت فعال شد</p>' +
          '<div class="mb-welcome-divider"></div>' +
          '<p class="mb-welcome-desc">اکنون تمام امکانات ویژه برای شما فعال است.<br>از تجربه اختصاصی AmirBTC Assistant لذت ببرید.</p>' +
          '<div class="mb-welcome-benefits">' +
            '<div class="mb-welcome-benefit"><span class="mb-welcome-b-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v18h18"/><path d="M7 14l4-4 4 3 5-6"/><polyline points="18 3 21 3 21 6"/></svg>' +
            '</span><span>چارت‌ها و تحلیل‌های اختصاصی</span></div>' +
            '<div class="mb-welcome-benefit"><span class="mb-welcome-b-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>' +
            '</span><span>نشان Premium در پروفایل</span></div>' +
            '<div class="mb-welcome-benefit"><span class="mb-welcome-b-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>' +
            '</span><span>اولویت در قابلیت‌های جدید</span></div>' +
            '<div class="mb-welcome-benefit"><span class="mb-welcome-b-icon">' +
              '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>' +
            '</span><span>کمپین‌ها و جوایز ویژه</span></div>' +
          '</div>' +
          '<button class="mb-welcome-cta" onclick="MembershipApp.closeWelcomePopup()">' +
            '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' +
            'شروع استفاده' +
          '</button>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Mark popup as shown in backend immediately after display
    markWelcomeShownInBackend();
  }

  function closeWelcomePopup() {
    var overlay = document.querySelector('.mb-welcome-overlay');
    if (overlay) {
      overlay.classList.add('mb-welcome-closing');
      setTimeout(function () { overlay.remove(); }, 400);
    }
    _popupOpen = false;
  }

  // ─── Compute step status from request data ───────────────────────────────
  // Steps: 1=register, 2=UID, 3=deposit, 4=first_trade, 5=review, 6=activation
  function computeStepStatus(request, status) {
    if (!request) {
      // No request submitted yet — only step 1 might be done (user exists)
      return ['pending', 'todo', 'todo', 'todo', 'todo', 'todo'];
    }
    if (request.status === 'APPROVED' || (status && isPremium(status))) {
      return ['done', 'done', 'done', 'done', 'done', 'done'];
    }
    if (request.status === 'PENDING') {
      // Request submitted → steps 1+2 done, 3+4 unknown (pending), 5 in review, 6 todo
      return ['done', 'done', 'pending', 'todo', 'pending', 'todo'];
    }
    if (request.status === 'REJECTED') {
      return ['done', 'done', 'todo', 'todo', 'rejected', 'todo'];
    }
    return ['pending', 'todo', 'todo', 'todo', 'todo', 'todo'];
  }

  // ─── VIP Status Popup ────────────────────────────────────────────────────

  function openVipStatusPopup(status) {
    closePopup();
    _popupOpen = true;
    var levelLabel = { VIP: 'VIP', PREMIUM: 'پرمیوم', ELITE: 'الیت' }[status.level] || status.level;

    // Phase 8M: Removed cosmetic display from VIP popup — cosmetics will be
    // accessed from the Shop/Cosmetics area, not the Premium info page.
    var cosmeticHtml = '';

    // Phase 8M: Removed redundant quota rows — benefits are unified below
    var quotaHtml = '';

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closePopup(); };
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<button class="mb-popup-close" onclick="MembershipApp.closePopup()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="mb-popup-header">' +
          '<div class="mb-popup-diamond">' +
            '<div class="mb-popup-diamond-halo"></div>' +
            '<div class="mb-popup-diamond-glow"></div>' +
            '<div class="mb-popup-diamond-icon">' + DIAMOND_SVG + '</div>' +
            '<div class="mb-popup-diamond-shimmer"></div>' +
          '</div>' +
          '<h2 class="mb-popup-title">PREMIUM</h2>' +
          '<p class="mb-popup-subtitle">عضویت شما فعال است. تمام امکانات اختصاصی با سهمیه بالاتر در دسترس شماست.</p>' +
        '</div>' +
        '<div class="mb-vip-status">' +
          '<div class="mb-vip-badge">' +
            '<div class="mb-diamond-svg" style="width:14px;height:14px">' + DIAMOND_SVG + '</div>' +
            '<span class="mb-vip-badge-text">عضویت فعال</span>' +
          '</div>' +
          '<div class="mb-vip-info">' +
            '<div class="mb-vip-info-item">' +
              '<div class="mb-vip-info-label">سطح</div>' +
              '<div class="mb-vip-info-val">' + esc(levelLabel) + '</div>' +
            '</div>' +
            '<div class="mb-vip-info-item">' +
              '<div class="mb-vip-info-label">تاریخ فعال‌سازی</div>' +
              '<div class="mb-vip-info-val">' + esc(formatFaDate(status.approvedAt)) + '</div>' +
            '</div>' +
            (status.lifetime
              ? '<div class="mb-vip-info-item mb-vip-lifetime">' +
                  '<div class="mb-vip-info-label">نوع عضویت</div>' +
                  '<div class="mb-vip-info-val">بدون تاریخ انقضا</div>' +
                '</div>'
              : '<div class="mb-vip-info-item">' +
                  '<div class="mb-vip-info-label">انقضا</div>' +
                  '<div class="mb-vip-info-val">' + esc(formatFaDate(status.expireAt)) + '</div>' +
                '</div>'
            ) +
          '</div>' +
          cosmeticHtml +
          quotaHtml +
          // Phase 8M: Unified benefits structure — same as activation popup
          '<div class="mb-benefits">' +
            '<div class="mb-benefits-section-title">مزایای Premium</div>' +
            benefitRow('ai', 'چت هوش مصنوعی', '۱۰۰ پیام در روز با مدل‌های پیشرفته') +
            benefitRow('bell', 'هشدارهای قیمتی', '۱۰ هشدار رایگان در روز') +
            benefitRow('wheel', 'چرخ شانس', '۵ اسپین در روز با جوایز ویژه') +
            benefitRow('star', 'واچ‌لیست', '۲۰ نماد در واچ‌لیست') +
            benefitRow('gift', 'پاداش روزانه', '۲۰ AB Token رایگان هر روز') +
            benefitRow('badge', 'دسترسی به Badge حرفه‌ای', 'نمایش نشان اختصاصی Premium در پروفایل شما') +
            benefitRow('megaphone', 'کنترل تبلیغات', 'مدیریت و غیرفعال‌سازی تبلیغات و اعلان‌های تبلیغاتی') +
            '<div class="mb-benefits-divider"></div>' +
            '<div class="mb-benefits-section-title">دسترسی‌های اختصاصی</div>' +
            benefitRow('bolt', 'اولویت دریافت قابلیت‌های جدید', 'دسترسی زودهنگام به امکانات جدید') +
            benefitRow('shield', 'اولویت پشتیبانی', 'پاسخگویی اولویت‌دار تیم پشتیبانی') +
            benefitRow('diamond', 'دسترسی دائمی Premium', 'بدون تاریخ انقضا • مطابق شرایط و قوانین عضویت') +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  // ─── Activation Popup (FREE user) ─────────────────────────────────────────

  /**
   * PHASE 7B (B1): Activation popup is now async — it awaits loadRules()
   * so the rules section renders with the active version + summary text
   * before the user can interact. The rest of the popup structure is
   * preserved exactly (quota preview, benefits, timeline, register CTA,
   * UID form, rejected-note).
   *
   * The rules section is inserted between the timeline-note and the
   * register button. It includes:
   *   - A version badge (e.g. "قوانین v1")
   *   - The rules summary text (or body_markdown fallback)
   *   - An explicit acceptance checkbox (Persian label)
   *   - The submit button is disabled until the checkbox is checked
   *     (only when rules.active === true; when inactive/missing, the
   *      checkbox is hidden and submission is allowed — matching the
   *      backend FAIL-OPEN behavior).
   */
  async function openActivationPopup(rejectedRequest) {
    closePopup();
    _popupOpen = true;

    // PHASE 7B (B1): Ensure rules are loaded before rendering the popup.
    // loadRules() is idempotent (returns cached _rules if already fetched).
    await loadRules();
    var rules = getRules();

    // Compute step status
    var steps = computeStepStatus(null, _cache);

    // Phase 2: Data-driven exchange requirement values.
    var req = getRequirement();
    var uidLabel = req.uid_label || ('شناسه کاربری ' + (req.exchange_name || 'Bitunix') + ' خود را وارد کنید');
    var buttonText = (req.metadata && req.metadata.button_text) || ('ثبت‌نام در ' + (req.exchange_name || 'Bitunix'));
    var timelineStep1Text = (req.metadata && req.metadata.timeline_step_1) || ('ثبت‌نام از طریق لینک رسمی ' + (req.exchange_name || 'Bitunix'));

    // PHASE 7B (B1): Build the rules section HTML.
    var rulesSectionHtml = buildRulesSectionHtml(rules);

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closePopup(); };
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<button class="mb-popup-close" onclick="MembershipApp.closePopup()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="mb-popup-header">' +
          '<div class="mb-popup-diamond">' +
            '<div class="mb-popup-diamond-halo"></div>' +
            '<div class="mb-popup-diamond-glow"></div>' +
            '<div class="mb-popup-diamond-icon">' + DIAMOND_SVG + '</div>' +
            '<div class="mb-popup-diamond-shimmer"></div>' +
          '</div>' +
          '<h2 class="mb-popup-title">PREMIUM</h2>' +
          '<p class="mb-popup-subtitle">با فعال‌سازی عضویت Premium، سهمیه بالاتر، امکانات اختصاصی و مزایای دائمی حساب شما فعال خواهد شد.</p>' +
        '</div>' +
        // Phase 8M: Removed duplicate quota preview grid — benefits are listed below
        // Phase 8L: Clean benefits structure — Premium Benefits + Exclusive Access
        '<div class="mb-benefits">' +
          '<div class="mb-benefits-section-title">مزایای Premium</div>' +
          benefitRow('ai', 'چت هوش مصنوعی', '۱۰۰ پیام در روز با مدل‌های پیشرفته') +
          benefitRow('bell', 'هشدارهای قیمتی', '۱۰ هشدار رایگان در روز') +
          benefitRow('wheel', 'چرخ شانس', '۵ اسپین در روز با جوایز ویژه') +
          benefitRow('star', 'واچ‌لیست', '۲۰ نماد در واچ‌لیست') +
          benefitRow('gift', 'پاداش روزانه', '۲۰ AB Token رایگان هر روز') +
          benefitRow('badge', 'دسترسی به Badge حرفه‌ای', 'نمایش نشان اختصاصی Premium در پروفایل شما') +
          benefitRow('megaphone', 'کنترل تبلیغات', 'مدیریت و غیرفعال‌سازی تبلیغات و اعلان‌های تبلیغاتی') +
          '<div class="mb-benefits-divider"></div>' +
          '<div class="mb-benefits-section-title">دسترسی‌های اختصاصی</div>' +
          benefitRow('bolt', 'اولویت دریافت قابلیت‌های جدید', 'دسترسی زودهنگام به امکانات جدید') +
          benefitRow('shield', 'اولویت پشتیبانی', 'پاسخگویی اولویت‌دار تیم پشتیبانی') +
          benefitRow('diamond', 'دسترسی دائمی Premium', 'بدون تاریخ انقضا • مطابق شرایط و قوانین عضویت') +
        '</div>' +
        // Timeline — 6 steps
        '<ul class="mb-timeline">' +
          timelineStep(1, timelineStep1Text, steps[0]) +
          timelineStep(2, 'ثبت UID صرافی', steps[1]) +
          timelineStep(3, 'واریز اولیه به حساب صرافی', steps[2]) +
          timelineStep(4, 'انجام اولین معامله (First Trade)', steps[3]) +
          timelineStep(5, 'بررسی اطلاعات توسط تیم', steps[4]) +
          timelineStep(6, 'فعال‌سازی پریمیوم', steps[5]) +
        '</ul>' +
        '<div class="mb-timeline-note">عضویت Premium پس از تکمیل تمام مراحل و تأیید اطلاعات توسط تیم فعال خواهد شد.</div>' +
        // PHASE 7B (B1): Rules + Acceptance section
        rulesSectionHtml +
        // Register button
        '<button class="mb-cta-register" onclick="MembershipApp.openBitunix()">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
          esc(buttonText) +
        '</button>' +
        // UID form — submit button starts disabled when rules.active is true
        '<div class="mb-uid-form">' +
          '<label class="mb-uid-label">ثبت درخواست عضویت</label>' +
          '<input type="text" class="mb-uid-input" id="mb-uid-input" placeholder="' + esc(uidLabel) + '" dir="ltr" />' +
          '<button class="mb-uid-submit' + (rules.active ? ' mb-uid-submit--disabled' : '') + '" id="mb-uid-submit" onclick="MembershipApp.submitUid()"' + (rules.active ? ' disabled' : '') + ' aria-disabled="' + (rules.active ? 'true' : 'false') + '">' +
            '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>' +
            'ارسال درخواست عضویت' +
          '</button>' +
        '</div>' +
        (rejectedRequest && rejectedRequest.admin_note
          ? '<div style="margin-top:12px;padding:10px 12px;border-radius:11px;background:rgba(255,77,77,0.06);border:1px solid rgba(255,77,77,0.15);font-size:11px;color:#ff8080;text-align:right"><strong>دلیل رد قبلی:</strong> ' + esc(rejectedRequest.admin_note) + '</div>'
          : ''
        ) +
      '</div>';
    document.body.appendChild(overlay);

    // PHASE 7B (B1): If rules are active, wire up the checkbox to enable/disable
    // the submit button. When rules are inactive (FAIL-OPEN), the checkbox is
    // not rendered and the submit button starts enabled.
    if (rules.active) {
      wireRulesCheckbox(rules);
    }
  }

  /**
   * PHASE 7B (B1): Build the HTML for the rules + acceptance section.
   * Renders a polished card with:
   *   - Header row: "قوانین عضویت Premium" title + version badge (e.g. "v1")
   *   - Rules body text (summary, or body_markdown stripped of # headers)
   *   - Custom checkbox row with Persian acceptance label
   *
   * When rules.active === false, renders a minimal non-blocking notice
   * (matching backend FAIL-OPEN: submission proceeds without acceptance).
   */
  /**
   * PHASE 8L: Rewritten rules section — clean card with "مشاهده کامل قوانین" button.
   * Full rules text is moved to a scrollable modal (openRulesModal) instead of
   * cluttering the activation card. The acceptance checkbox is preserved.
   */
  function buildRulesSectionHtml(rules) {
    if (!rules || !rules.active) {
      // FAIL-OPEN mode: no active rules version. Don't block submission.
      return '<div class="mb-rules-section mb-rules-section--inactive">' +
        '<div class="mb-rules-header">' +
          '<div class="mb-rules-title-row">' +
            '<span class="mb-rules-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-left:4px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="10" y1="9" x2="12" y2="9"/></svg> قوانین عضویت</span>' +
          '</div>' +
        '</div>' +
        '<div class="mb-rules-body mb-rules-body--empty">قوانین فعال در حال حاضر در دسترس نیست. می‌توانید درخواست خود را ارسال کنید؛ در صورت نیاز، تیم پس از بررسی با شما تماس خواهد گرفت.</div>' +
      '</div>';
    }

    var versionBadge = ''; // Phase 8M: Version removed from UI (backend acceptance logic unchanged)
    var titleText = rules.title || 'قوانین عضویت Premium';
    // Phase 8L: Store rules data for the modal — don't display full text in the card
    _rulesDataForModal = rules;

    return '<div class="mb-rules-section">' +
      '<div class="mb-rules-header">' +
        '<div class="mb-rules-title-row">' +
          '<span class="mb-rules-title"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" style="vertical-align:-2px;margin-left:4px"><path d="M14 2H6a2 2 0 0 0-2 2v16a2 2 0 0 0 2 2h12a2 2 0 0 0 2-2V8z"/><polyline points="14 2 14 8 20 8"/><line x1="8" y1="13" x2="16" y2="13"/><line x1="8" y1="17" x2="16" y2="17"/><line x1="10" y1="9" x2="12" y2="9"/></svg> ' + esc(titleText) + '</span>' +
          versionBadge +
        '</div>' +
      '</div>' +
      // Phase 8L: Short explanation + "مشاهده کامل قوانین" button (replaces full text)
      '<div class="mb-rules-summary">برای ادامه، قوانین عضویت Premium را مطالعه و تأیید کنید.</div>' +
      '<button class="mb-rules-view-btn" onclick="MembershipApp.openRulesModal()" type="button">' +
        '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>' +
        'مشاهده کامل قوانین' +
      '</button>' +
      // Custom checkbox — accessible, RTL-friendly, polished
      '<label class="mb-rules-accept" for="mb-rules-checkbox">' +
        '<input type="checkbox" id="mb-rules-checkbox" class="mb-rules-checkbox" onchange="MembershipApp.onRulesCheckboxChange(this)" />' +
        '<span class="mb-rules-checkbox-custom" aria-hidden="true">' +
          '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>' +
        '</span>' +
        '<span class="mb-rules-accept-label">قوانین عضویت Premium را مطالعه کرده‌ام و با آن موافقم.</span>' +
      '</label>' +
    '</div>';
  }

  // Phase 8L: Store rules data for the modal
  var _rulesDataForModal = null;

  /**
   * PHASE 8N: Full rules modal — accordion-based premium rules viewer.
   * Sections are extracted from markdown headings (#, ##). Each section
   * is a collapsible accordion item matching the Settings/Terms UI.
   */
  function openRulesModal() {
    var rules = _rulesDataForModal;
    if (!rules) return;

    var titleText = rules.title || 'قوانین عضویت Premium';
    var bodyText = rules.body_markdown || rules.summary || 'متن قوانین در دسترس نیست.';
    // Phase 8N: Build accordion sections from markdown headings
    var accordionHtml = buildRulesAccordion(bodyText);

    var overlay = document.createElement('div');
    overlay.className = 'mb-rules-modal-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closeRulesModal(); };
    overlay.innerHTML =
      '<div class="mb-rules-modal">' +
        '<button class="mb-rules-modal-close" onclick="MembershipApp.closeRulesModal()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="mb-rules-modal-header">' +
          '<h3 class="mb-rules-modal-title">' + esc(titleText) + '</h3>' +
        '</div>' +
        '<div class="mb-rules-modal-body">' + accordionHtml + '</div>' +
        '<button class="mb-rules-modal-ok" onclick="MembershipApp.closeRulesModal()">متوجه شدم</button>' +
      '</div>';
    document.body.appendChild(overlay);

    // Phase 8N: Wire accordion toggle handlers
    var headers = overlay.querySelectorAll('.mb-ra-header');
    for (var i = 0; i < headers.length; i++) {
      headers[i].addEventListener('click', function() {
        var item = this.parentElement;
        var body = item.querySelector('.mb-ra-body');
        var isOpen = item.classList.contains('open');
        if (isOpen) {
          item.classList.remove('open');
          body.style.maxHeight = '0';
        } else {
          item.classList.add('open');
          body.style.maxHeight = body.scrollHeight + 'px';
        }
      });
    }
  }

  function closeRulesModal() {
    var modal = document.querySelector('.mb-rules-modal-overlay');
    if (modal) {
      modal.style.animation = 'mb-fade-in 0.2s ease reverse';
      setTimeout(function () { modal.remove(); }, 200);
    }
  }

  /**
   * PHASE 8N: Build accordion sections from markdown.
   * Splits the rules markdown by headings (#, ##) into sections.
   * Each section becomes a collapsible accordion item.
   * Content within each section (paragraphs, lists) is rendered as HTML.
   */
  function buildRulesAccordion(md) {
    if (!md) return '<p>متن قوانین در دسترس نیست.</p>';
    var lines = String(md).split('\n');
    var sections = [];
    var currentTitle = null;
    var currentContent = [];

    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      // Phase 8O: Only ## headings create accordion sections.
      // # heading is the document title (already shown in modal header) — skip it.
      var headingMatch = line.match(/^##\s+(.+)$/);
      if (headingMatch) {
        // Save previous section
        if (currentTitle !== null) {
          sections.push({ title: currentTitle, content: currentContent });
        }
        currentTitle = headingMatch[1];
        currentContent = [];
      } else if (/^#\s/.test(line)) {
        // Phase 8O: Skip # level heading (document title) — it's the modal title
        continue;
      } else {
        if (currentTitle !== null) {
          currentContent.push(line);
        }
        // Content before first ## heading is skipped (it's the intro under # title)
      }
    }
    // Save last section
    if (currentTitle !== null) {
      sections.push({ title: currentTitle, content: currentContent });
    }

    // If no sections found (no ## headings), render as single block
    if (sections.length === 0) {
      return '<div class="mb-ra-body-inner">' + renderMarkdownLines(lines.filter(function(l) { return !/^#\s/.test(l); }), 0) + '</div>';
    }

    // Build accordion HTML
    var html = '';
    for (var s = 0; s < sections.length; s++) {
      var sec = sections[s];
      var contentHtml = renderMarkdownLines(sec.content, 0);
      html +=
        '<div class="mb-ra-item">' +
          '<div class="mb-ra-header">' +
            '<span class="mb-ra-header-text">' + esc(sec.title) + '</span>' +
            '<svg class="mb-ra-chevron" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="6 9 12 15 18 9"/></svg>' +
          '</div>' +
          '<div class="mb-ra-body">' +
            '<div class="mb-ra-body-inner">' + contentHtml + '</div>' +
          '</div>' +
        '</div>';
    }
    return html;
  }

  /**
   * PHASE 8N: Render markdown lines as HTML (paragraphs, lists, sub-headings).
   */
  function renderMarkdownLines(lines, startIdx) {
    var html = '';
    var inList = false;
    for (var i = 0; i < lines.length; i++) {
      var line = lines[i];
      if (/^###\s/.test(line)) {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<h4>' + esc(line.replace(/^###\s*/, '')) + '</h4>';
      } else if (/^[-*]\s/.test(line)) {
        if (!inList) { html += '<ul>'; inList = true; }
        html += '<li>' + esc(line.replace(/^[-*]\s*/, '')) + '</li>';
      } else if (line.trim() === '') {
        if (inList) { html += '</ul>'; inList = false; }
      } else {
        if (inList) { html += '</ul>'; inList = false; }
        html += '<p>' + esc(line) + '</p>';
      }
    }
    if (inList) html += '</ul>';
    return html;
  }

  /**
   * PHASE 7B (B1): Wire the checkbox change handler to enable/disable the
   * submit button. Called once after the popup is appended to the DOM.
   */
  function wireRulesCheckbox(rules) {
    var checkbox = document.getElementById('mb-rules-checkbox');
    var submitBtn = document.getElementById('mb-uid-submit');
    if (!checkbox || !submitBtn) return;
    // Initial state: unchecked → submit disabled.
    updateSubmitButtonState(submitBtn, false);
  }

  /**
   * PHASE 7B (B1): Checkbox onchange handler. Updates the submit button
   * enabled/disabled state and the visual styling.
   */
  function onRulesCheckboxChange(checkbox) {
    var submitBtn = document.getElementById('mb-uid-submit');
    if (!submitBtn) return;
    updateSubmitButtonState(submitBtn, checkbox.checked);
  }

  /**
   * PHASE 7B (B1): Update the submit button's disabled state + visual class.
   * When disabled, the button shows a "قوانین را بپذیرید" hint instead of
   * the normal "ارسال درخواست عضویت" label.
   */
  function updateSubmitButtonState(submitBtn, enabled) {
    if (!submitBtn) return;
    if (enabled) {
      submitBtn.disabled = false;
      submitBtn.setAttribute('aria-disabled', 'false');
      submitBtn.classList.remove('mb-uid-submit--disabled');
      submitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ارسال درخواست عضویت';
    } else {
      submitBtn.disabled = true;
      submitBtn.setAttribute('aria-disabled', 'true');
      submitBtn.classList.add('mb-uid-submit--disabled');
      submitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg> ابتدا قوانین را بپذیرید';
    }
  }

  /**
   * PHASE 7B (B1): Strip leading markdown # headers from rules body for
   * plain-text display. Preserves paragraph breaks. The backend stores rules
   * as body_markdown; we display the summary when available, but fall back
   * to a cleaned version of body_markdown if summary is empty.
   */
  function stripMarkdownHeaders(text) {
    if (!text) return '';
    return String(text)
      .split('\n')
      .map(function (line) { return line.replace(/^#{1,6}\s*/, ''); })
      .join('\n')
      .trim();
  }

  // ─── Pending Popup ────────────────────────────────────────────────────────

  function openPendingPopup(request) {
    closePopup();
    _popupOpen = true;

    // Compute step status for pending request
    var steps = computeStepStatus(request, _cache);

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closePopup(); };
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<button class="mb-popup-close" onclick="MembershipApp.closePopup()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="mb-popup-header">' +
          '<div class="mb-popup-diamond">' +
            '<div class="mb-popup-diamond-halo"></div>' +
            '<div class="mb-popup-diamond-glow"></div>' +
            '<div class="mb-popup-diamond-icon">' + DIAMOND_SVG + '</div>' +
            '<div class="mb-popup-diamond-shimmer"></div>' +
          '</div>' +
          '<h2 class="mb-popup-title">درخواست شما در حال بررسی است</h2>' +
          '<p class="mb-popup-subtitle">درخواست عضویت شما ثبت شده و در حال بررسی توسط تیم مدیریت است.</p>' +
        '</div>' +
        // Timeline with current status
        '<ul class="mb-timeline">' +
          timelineStep(1, (getRequirement().metadata && getRequirement().metadata.timeline_step_1) || ('ثبت‌نام از طریق لینک رسمی ' + (getRequirement().exchange_name || 'Bitunix')), steps[0]) +
          timelineStep(2, 'ثبت UID صرافی', steps[1]) +
          timelineStep(3, 'واریز اولیه به حساب صرافی', steps[2]) +
          timelineStep(4, 'انجام اولین معامله (First Trade)', steps[3]) +
          timelineStep(5, 'بررسی اطلاعات توسط تیم', steps[4]) +
          timelineStep(6, 'فعال‌سازی پریمیوم', steps[5]) +
        '</ul>' +
        '<div class="mb-timeline-note">عضویت Premium پس از تکمیل تمام مراحل و تأیید اطلاعات توسط تیم فعال خواهد شد.</div>' +
        '<div class="mb-pending">' +
          '<div class="mb-pending-progress"><div class="mb-pending-progress-bar"></div></div>' +
          '<div style="margin-top:14px;font-size:11px;color:#6B7A8D">صرافی: ' + esc(request.exchange_name) + ' · UID: <span dir="ltr">' + esc(request.exchange_uid) + '</span></div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  // ─── Success Popup ────────────────────────────────────────────────────────

  function openSuccessPopup() {
    closePopup();
    _popupOpen = true;

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closePopup(); };
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<button class="mb-popup-close" onclick="MembershipApp.closePopup()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="mb-success">' +
          '<div class="mb-success-icon">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' +
          '</div>' +
          '<div class="mb-success-title">درخواست شما با موفقیت ثبت شد</div>' +
          '<div class="mb-success-msg">پس از بررسی توسط تیم، وضعیت عضویت شما به Premium تغییر خواهد کرد.</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);

    // Refresh status after closing
    setTimeout(function () {
      _cache = null;
      loadCard();
    }, 3000);
  }

  // ─── Actions ──────────────────────────────────────────────────────────────

  function openBitunix() {
    return openRegisterUrl();
  }

  function openRegisterUrl() {
    var req = getRequirement();
    var url = req.exchange_register_url || FALLBACK_REQUIREMENT.exchange_register_url;
    if (window.Telegram?.WebApp?.openLink) {
      window.Telegram.WebApp.openLink(url);
    } else {
      window.open(url, '_blank');
    }
  }

  /**
   * PHASE 7B (B1): Rewritten submitUid to enforce the accept→request ordering.
   *
   * Flow:
   *   1. Validate UID format (unchanged).
   *   2. If rules.active === true:
   *      a. Verify the checkbox is checked. If not, show actionable message.
   *      b. If not already accepted in this session (_rulesAcceptedVersion),
   *         call POST /api/membership/rules/accept with the active version.
   *      c. Only proceed if acceptance succeeds.
   *   3. Call POST /api/membership/request (unchanged payload).
   *   4. On 403 RULES_NOT_ACCEPTED:
   *      - Refresh the rules cache (admin may have published a new version).
   *      - Re-render the rules section with the new version.
   *      - Reset the checkbox to unchecked.
   *      - Show a clear Persian message: "قوانین به‌روزرسانی شده‌اند. لطفاً نسخه جدید را مطالعه و تأیید کنید."
   *   5. Duplicate-click protection: _submitInFlight flag prevents concurrent submissions.
   */
  var _submitInFlight = false;

  async function submitUid() {
    // PHASE 7B (B1): Duplicate-click protection.
    if (_submitInFlight) return;
    _submitInFlight = true;

    try {
      await _submitUidInternal();
    } finally {
      _submitInFlight = false;
    }
  }

  async function _submitUidInternal() {
    var input = document.getElementById('mb-uid-input');
    if (!input) return;
    var uid = input.value.trim();

    if (!uid || uid.length < 4 || uid.length > 64 || !/^[A-Za-z0-9_-]+$/.test(uid)) {
      if (window.admToast) admToast('شناسه نامعتبر است', 'error');
      else alert('شناسه نامعتبر است');
      return;
    }

    var rules = getRules();

    // PHASE 7B (B1): If rules are active, require explicit acceptance.
    if (rules && rules.active) {
      var checkbox = document.getElementById('mb-rules-checkbox');
      if (!checkbox || !checkbox.checked) {
        if (window.admToast) admToast('برای ارسال درخواست، ابتدا قوانین عضویت را مطالعه و تأیید کنید.', 'error');
        else alert('برای ارسال درخواست، ابتدا قوانین عضویت را مطالعه و تأیید کنید.');
        return;
      }

      // PHASE 7B (B1): Call POST /api/membership/rules/accept BEFORE /request,
      // but only if we haven't already accepted this exact version in this
      // popup session (avoids redundant accept calls on re-submits after a
      // non-rules error, e.g. UID already exists).
      if (_rulesAcceptedVersion !== rules.version) {
        var btn = document.getElementById('mb-uid-submit');
        if (btn) {
          btn.disabled = true;
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round" stroke-dasharray="40" stroke-dashoffset="20"/></svg> در حال ثبت پذیرش قوانین...';
        }

        try {
          var acceptRes = await apiFetch('/api/membership/rules/accept', {
            method: 'POST',
            body: JSON.stringify({ rules_version: rules.version, source: 'activation_popup' }),
          });
          if (!acceptRes || !acceptRes.ok) {
            // Acceptance failed — show structured error, re-enable button, abort.
            var acceptMsg = (acceptRes && acceptRes.error) ? acceptRes.error : 'خطا در ثبت پذیرش قوانین. لطفاً دوباره تلاش کنید.';
            if (acceptRes && acceptRes.code === 'RULES_NOT_FOUND') {
              // The version we have is stale — refresh rules and re-render.
              await refreshRulesAndRerenderSection();
              acceptMsg = 'نسخه قوانین به‌روزرسانی شده است. لطفاً نسخه جدید را مطالعه و تأیید کنید.';
            } else if (acceptRes && acceptRes.code === 'RULES_NOT_ACTIVE') {
              await refreshRulesAndRerenderSection();
              acceptMsg = 'نسخه قوانین فعال تغییر کرده است. لطفاً نسخه جدید را تأیید کنید.';
            }
            if (window.admToast) admToast(acceptMsg, 'error');
            else alert(acceptMsg);
            // Restore the button to the "accept rules" hint state (unchecked).
            var checkboxAfter = document.getElementById('mb-rules-checkbox');
            if (checkboxAfter) { checkboxAfter.checked = false; }
            updateSubmitButtonState(document.getElementById('mb-uid-submit'), false);
            return;
          }
          // Acceptance succeeded — record the version so we don't re-accept on retry.
          _rulesAcceptedVersion = rules.version;
        } catch (e) {
          if (window.admToast) admToast('خطا در ارتباط با سرور. لطفاً دوباره تلاش کنید.', 'error');
          else alert('خطا در ارتباط با سرور. لطفاً دوباره تلاش کنید.');
          var checkboxErr = document.getElementById('mb-rules-checkbox');
          if (checkboxErr) { checkboxErr.checked = false; }
          updateSubmitButtonState(document.getElementById('mb-uid-submit'), false);
          return;
        }
      }
    }

    // ── Submit the membership request ────────────────────────────────────
    var btn = document.getElementById('mb-uid-submit');
    if (btn) {
      btn.disabled = true;
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21 12a9 9 0 1 1-6.219-8.56" stroke-linecap="round" stroke-dasharray="40" stroke-dashoffset="20"/></svg> در حال ارسال...';
    }

    try {
      var req = getRequirement();
      var exchangeName = req.exchange_name || 'Bitunix';
      var res = await apiFetch('/api/membership/request', {
        method: 'POST',
        body: JSON.stringify({ exchange: exchangeName, uid: uid }),
      });
      if (res && res.ok) {
        openSuccessPopup();
        return;
      }

      // PHASE 7B (B1): Handle RULES_NOT_ACCEPTED gracefully.
      if (res && res.code === 'RULES_NOT_ACCEPTED') {
        // Admin published a new rules version, or our acceptance wasn't recorded.
        // Refresh the rules cache, re-render the section, reset the checkbox,
        // and show an actionable Persian message.
        await refreshRulesAndRerenderSection();
        var checkboxReset = document.getElementById('mb-rules-checkbox');
        if (checkboxReset) { checkboxReset.checked = false; }
        updateSubmitButtonState(document.getElementById('mb-uid-submit'), false);
        var rulesMsg = 'قوانین عضویت به‌روزرسانی شده‌اند. لطفاً نسخه جدید را مطالعه کرده و دوباره تأیید کنید.';
        if (window.admToast) admToast(rulesMsg, 'error');
        else alert(rulesMsg);
        return;
      }

      // Other errors — show structured message.
      var msg = (res && res.error) ? res.error : 'خطا در ثبت درخواست';
      if (window.admToast) admToast(msg, 'error');
      else alert(msg);
      // Restore button to appropriate state based on rules acceptance.
      restoreSubmitButtonState();
    } catch (e) {
      // Network error (fetch() rejected) — not an HTTP response.
      if (window.admToast) admToast('خطا در ارتباط با سرور. لطفاً اتصال اینترنت خود را بررسی کنید.', 'error');
      else alert('خطا در ارتباط با سرور. لطفاً اتصال اینترنت خود را بررسی کنید.');
      restoreSubmitButtonState();
    }
  }

  /**
   * PHASE 7B (B1): Refresh the rules cache and re-render the rules section
   * in-place (without rebuilding the whole popup). Used when the backend
   * returns RULES_NOT_ACCEPTED or RULES_NOT_FOUND, indicating the active
   * version changed while the user had the popup open.
   */
  async function refreshRulesAndRerenderSection() {
    await refreshRules();
    var newRules = getRules();
    var sectionEl = document.querySelector('.mb-rules-section');
    if (sectionEl) {
      // Replace the section's outerHTML with the fresh rendering.
      var tmp = document.createElement('div');
      tmp.innerHTML = buildRulesSectionHtml(newRules);
      var newSection = tmp.firstElementChild;
      if (newSection) {
        sectionEl.replaceWith(newSection);
      }
    }
    // Also update the submit button's initial disabled state.
    var submitBtn = document.getElementById('mb-uid-submit');
    if (submitBtn) {
      if (newRules.active) {
        updateSubmitButtonState(submitBtn, false);
      } else {
        // Rules became inactive (FAIL-OPEN) — enable submission.
        submitBtn.disabled = false;
        submitBtn.setAttribute('aria-disabled', 'false');
        submitBtn.classList.remove('mb-uid-submit--disabled');
        submitBtn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ارسال درخواست عضویت';
      }
    }
  }

  /**
   * PHASE 7B (B1): Restore the submit button to the appropriate state after
   * a non-fatal error (re-enable if rules already accepted, else show hint).
   */
  function restoreSubmitButtonState() {
    var btn = document.getElementById('mb-uid-submit');
    if (!btn) return;
    var rules = getRules();
    if (rules && rules.active && _rulesAcceptedVersion === rules.version) {
      // Already accepted — re-enable the submit button.
      updateSubmitButtonState(btn, true);
    } else if (rules && rules.active) {
      // Not yet accepted — show the "accept rules" hint.
      updateSubmitButtonState(btn, false);
    } else {
      // FAIL-OPEN — no acceptance required.
      btn.disabled = false;
      btn.setAttribute('aria-disabled', 'false');
      btn.classList.remove('mb-uid-submit--disabled');
      btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ارسال درخواست عضویت';
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  // Phase 8L: Professional premium SVG icon set — consistent stroke, gold accent
  function benefitRow(iconKey, title, desc) {
    var icons = {
      // Premium diamond — permanent access
      diamond: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/><path d="M2 9h20"/></svg>',
      // Bolt — early access / future features
      bolt: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      // AI / brain — AI chat
      ai: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2a4 4 0 0 0-4 4v1a3 3 0 0 0-3 3v1a3 3 0 0 0 1 5 3 3 0 0 0 3 3 4 4 0 0 0 6 0 3 3 0 0 0 3-3 3 3 0 0 0 1-5v-1a3 3 0 0 0-3-3V6a4 4 0 0 0-4-4z"/><circle cx="9" cy="11" r="1"/><circle cx="15" cy="11" r="1"/><path d="M9 15c1 1 2 1 3 1s2 0 3-1"/></svg>',
      // Bell — price alerts
      bell: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M6 8a6 6 0 0 1 12 0c0 7 3 9 3 9H3s3-2 3-9"/><path d="M10.3 21a1.94 1.94 0 0 0 3.4 0"/></svg>',
      // Wheel / radial — spin
      wheel: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9"/><circle cx="12" cy="12" r="3"/><path d="M12 3v6M12 15v6M3 12h6M15 12h6"/></svg>',
      // Star — watchlist
      star: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>',
      // Gift — daily rewards
      gift: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="8" width="18" height="4" rx="1"/><path d="M12 8v13M5 12v7a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-7"/><path d="M7.5 8a2.5 2.5 0 0 1 0-5C11 3 12 8 12 8s1-5 4.5-5a2.5 2.5 0 0 1 0 5"/></svg>',
      // Shield / badge — professional badge
      badge: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L4 5v6c0 5 3.5 9.5 8 11 4.5-1.5 8-6 8-11V5l-8-3z"/><path d="M9 12l2 2 4-4"/></svg>',
      // Chart — priority features (kept for compatibility)
      chart: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 18 12 15 21 9 3 6 12 2 12"/></svg>',
      // Shield (generic) — support / protection
      shield: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
      // Megaphone — advertisement control (Phase 9: Premium Features card)
      megaphone: '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/><path d="M3 11v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z"/></svg>',
    };
    return '<div class="mb-benefit">' +
      '<div class="mb-benefit-icon">' + (icons[iconKey] || icons.diamond) + '</div>' +
      '<div class="mb-benefit-text">' +
        '<div class="mb-benefit-title">' + esc(title) + '</div>' +
        '<div class="mb-benefit-desc">' + esc(desc) + '</div>' +
      '</div>' +
    '</div>';
  }

  // Phase 8L: timelineStep — use Latin digits for clean stepper rendering
  function timelineStep(num, text, stepStatus) {
    var cls = 'mb-timeline-item';
    if (stepStatus === 'done') cls += ' mb-timeline-item--done';
    else if (stepStatus === 'pending') cls += ' mb-timeline-item--pending';

    // Phase 8L: Force Latin digits in stepper for consistent rendering
    var stepContent = String(num);
    if (stepStatus === 'done') {
      stepContent = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
    }

    return '<li class="' + cls + '">' +
      '<div class="mb-timeline-step">' + stepContent + '</div>' +
      '<div class="mb-timeline-text">' + esc(text) + '</div>' +
    '</li>';
  }

  // Expose globally
  window.MembershipApp = {
    loadCard: loadCard,
    open: open,
    closePopup: closePopup,
    closeWelcomePopup: closeWelcomePopup,
    openBitunix: openBitunix,
    openRegisterUrl: openRegisterUrl,
    submitUid: submitUid,
    // PHASE 7B (B1): Exposed for the inline onchange handler on the checkbox.
    onRulesCheckboxChange: onRulesCheckboxChange,
    // PHASE 8L: Exposed for the rules modal
    openRulesModal: openRulesModal,
    closeRulesModal: closeRulesModal,
    // Phase 8: Exposed for hero banner — check cached Premium status
    isPremiumCached: function () { return _cache ? isPremium(_cache) : false; },
    // Watchlist premium fix: eagerly set the premium cache from the bootstrap
    // response so getMaxWatchlist() returns the correct limit (7 vs 20) from
    // the FIRST render — no waiting for the lazy loadCard() call on profile open.
    // The bootstrap is_premium flag comes from the authoritative backend
    // (membershipAuthority.isPremium). loadCard() will later refresh with the
    // full DTO (level, status, expireAt, etc.) when the user opens their profile.
    setPremiumFromBootstrap: function (isPremiumFlag) {
      if (isPremiumFlag) {
        // Set a cache shape that isPremium() returns true for.
        // isPremium(s): s.level !== 'FREE' && s.status === 'APPROVED'
        _cache = _cache || {};
        _cache.level = _cache.level || 'PREMIUM';
        _cache.status = 'APPROVED';
      } else if (!_cache) {
        // Only seed the Free cache if we don't already have one — a real
        // loadCard() result is authoritative and shouldn't be overwritten by
        // a bootstrap "not premium" (which could be stale if membership was
        // just upgraded between bootstrap and loadCard).
        _cache = { level: 'FREE', status: 'APPROVED' };
      }
    },
    refresh: function () { _cache = null; _requirement = null; _rules = null; _rulesAcceptedVersion = null; return loadCard(); },
  };

  // ─── Ripple animation for both CTA buttons ──────────────────────────────
  function addRipple(e) {
    var btn = e.currentTarget;
    if (!btn) return;
    var rect = btn.getBoundingClientRect();
    var ripple = document.createElement('span');
    ripple.className = 'ripple';
    var size = Math.max(rect.width, rect.height);
    ripple.style.width = ripple.style.height = size + 'px';
    ripple.style.left = (e.clientX - rect.left - size / 2) + 'px';
    ripple.style.top = (e.clientY - rect.top - size / 2) + 'px';
    btn.appendChild(ripple);
    setTimeout(function () { ripple.remove(); }, 600);
  }

  function initRipple() {
    var btns = document.querySelectorAll('.hero-cta--premium-v2, .hero-cta--channel-v2');
    btns.forEach(function (btn) { btn.addEventListener('click', addRipple); });
  }

  // Auto-load on DOMContentLoaded (also called from loadUser in app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', function () { loadCard(); initRipple(); });
  } else {
    loadCard();
    initRipple();
  }
})();

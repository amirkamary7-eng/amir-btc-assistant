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

  function getInitData() {
    return window.Telegram?.WebApp?.initData || '';
  }

  function apiFetch(path, options) {
    options = options || {};
    options.headers = options.headers || {};
    options.headers['Content-Type'] = 'application/json';
    options.headers['X-Telegram-Init-Data'] = getInitData();
    options.headers['Cache-Control'] = 'no-store';
    return fetch(API_BASE + path, options).then(function (res) {
      if (!res.ok) throw new Error('HTTP ' + res.status);
      return res.json();
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
      '<span class="mb-badge-text">' + (premium ? 'Premium Member' : 'فعال‌سازی Premium') + '</span>';
    badge.title = premium ? 'عضو ویژه AMIRBTC' : 'ارتقا به عضویت ویژه';

    // Apply/remove premium effects on profile card
    if (profileCard) {
      if (premium) {
        profileCard.classList.add('profile-card--premium');
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
          '<h2 class="mb-popup-title">عضویت ویژه AMIRBTC Premium</h2>' +
          '<p class="mb-popup-subtitle">عضویت شما فعال است. تمام امکانات اختصاصی بدون محدودیت در دسترس شماست.</p>' +
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
                  '<div class="mb-vip-info-val">∞ مادام‌العمر</div>' +
                '</div>'
              : '<div class="mb-vip-info-item">' +
                  '<div class="mb-vip-info-label">انقضا</div>' +
                  '<div class="mb-vip-info-val">' + esc(formatFaDate(status.expireAt)) + '</div>' +
                '</div>'
            ) +
          '</div>' +
          '<div class="mb-benefits">' +
            benefitRow('diamond', 'دسترسی دائمی Premium', 'تمام امکانات ویژه برای همیشه') +
            benefitRow('bolt', 'امکانات اختصاصی آینده', 'دسترسی زودهنگام به قابلیت‌های جدید') +
            benefitRow('shield', 'نشان Premium در پروفایل', 'badge ویژه در پروفایل شما') +
          '</div>' +
        '</div>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  // ─── Activation Popup (FREE user) ─────────────────────────────────────────

  function openActivationPopup(rejectedRequest) {
    closePopup();
    _popupOpen = true;

    // Compute step status
    var steps = computeStepStatus(null, _cache);

    // Phase 2: Data-driven exchange requirement values.
    var req = getRequirement();
    var uidLabel = req.uid_label || ('شناسه کاربری ' + (req.exchange_name || 'Bitunix') + ' خود را وارد کنید');
    var buttonText = (req.metadata && req.metadata.button_text) || ('ثبت‌نام در ' + (req.exchange_name || 'Bitunix'));
    var timelineStep1Text = (req.metadata && req.metadata.timeline_step_1) || ('ثبت‌نام از طریق لینک رسمی ' + (req.exchange_name || 'Bitunix'));

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
          '<h2 class="mb-popup-title">عضویت ویژه AMIRBTC Premium</h2>' +
          '<p class="mb-popup-subtitle">با فعال‌سازی عضویت Premium، امکانات اختصاصی، دسترسی‌های ویژه و مزایای دائمی حساب شما فعال خواهد شد.</p>' +
        '</div>' +
        // Benefits
        '<div class="mb-benefits">' +
          benefitRow('diamond', 'دسترسی دائمی Premium', 'تمام امکانات ویژه برای همیشه') +
          benefitRow('bolt', 'امکانات اختصاصی آینده', 'دسترسی زودهنگام به قابلیت‌های جدید') +
          benefitRow('chart', 'اولویت دریافت قابلیت‌ها', 'اولویت در دریافت امکانات جدید') +
          benefitRow('gift', 'جوایز و کمپین‌های ویژه', 'شرکت در کمپین‌های اختصاصی') +
          benefitRow('shield', 'نشان Premium در پروفایل', 'badge ویژه در پروفایل شما') +
        '</div>' +
        // Timeline — 6 steps
        '<ul class="mb-timeline">' +
          timelineStep(1, timelineStep1Text, steps[0]) +
          timelineStep(2, 'ثبت UID صرافی', steps[1]) +
          timelineStep(3, 'واریز اولیه به حساب صرافی', steps[2]) +
          timelineStep(4, 'انجام اولین معامله (First Trade)', steps[3]) +
          timelineStep(5, 'بررسی اطلاعات توسط تیم', steps[4]) +
          timelineStep(6, 'فعال‌سازی دائمی Premium', steps[5]) +
        '</ul>' +
        '<div class="mb-timeline-note">عضویت Premium پس از تکمیل تمام مراحل و تأیید اطلاعات توسط تیم فعال خواهد شد.</div>' +
        // Register button
        '<button class="mb-cta-register" onclick="MembershipApp.openBitunix()">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
          esc(buttonText) +
        '</button>' +
        // UID form
        '<div class="mb-uid-form">' +
          '<label class="mb-uid-label">ثبت درخواست عضویت</label>' +
          '<input type="text" class="mb-uid-input" id="mb-uid-input" placeholder="' + esc(uidLabel) + '" dir="ltr" />' +
          '<button class="mb-uid-submit" onclick="MembershipApp.submitUid()">' +
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
          timelineStep(6, 'فعال‌سازی دائمی Premium', steps[5]) +
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

  async function submitUid() {
    var input = document.getElementById('mb-uid-input');
    if (!input) return;
    var uid = input.value.trim();

    if (!uid || uid.length < 4 || uid.length > 64 || !/^[A-Za-z0-9_-]+$/.test(uid)) {
      if (window.admToast) admToast('شناسه نامعتبر است', 'error');
      else alert('شناسه نامعتبر است');
      return;
    }

    var btn = document.querySelector('.mb-uid-submit');
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
      } else {
        var msg = (res && res.error) ? res.error : 'خطا در ثبت درخواست';
        if (window.admToast) admToast(msg, 'error');
        else alert(msg);
        if (btn) {
          btn.disabled = false;
          btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ارسال درخواست عضویت';
        }
      }
    } catch (e) {
      if (window.admToast) admToast('خطا: ' + e.message, 'error');
      else alert('خطا: ' + e.message);
      if (btn) {
        btn.disabled = false;
        btn.innerHTML = '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ارسال درخواست عضویت';
      }
    }
  }

  // ─── Helpers ──────────────────────────────────────────────────────────────

  function benefitRow(iconKey, title, desc) {
    var icons = {
      diamond: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M6 3h12l4 6-10 13L2 9z"/><path d="M11 3 8 9l4 13 4-13-3-6"/></svg>',
      bolt: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
      chart: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
      gift: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
      shield: '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    };
    return '<div class="mb-benefit">' +
      '<div class="mb-benefit-icon">' + (icons[iconKey] || icons.diamond) + '</div>' +
      '<div class="mb-benefit-text">' +
        '<div class="mb-benefit-title">' + esc(title) + '</div>' +
        '<div class="mb-benefit-desc">' + esc(desc) + '</div>' +
      '</div>' +
    '</div>';
  }

  function timelineStep(num, text, stepStatus) {
    var cls = 'mb-timeline-item';
    if (stepStatus === 'done') cls += ' mb-timeline-item--done';
    else if (stepStatus === 'pending') cls += ' mb-timeline-item--pending';

    var stepContent = num;
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
    refresh: function () { _cache = null; _requirement = null; return loadCard(); },
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

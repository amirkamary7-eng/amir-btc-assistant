/**
 * MembershipApp — Premium badge for the Mini App profile card.
 *
 * Renders a 3D diamond badge INSIDE the existing .profile-card (top-left corner).
 * NO separate membership card is added to the profile page.
 *
 * VIP/PREMIUM/ELITE → gold diamond badge with glow + shimmer + float.
 * FREE/other → locked dim badge.
 * Click → opens premium popup (feature intro, NOT banner).
 */
(function () {
  'use strict';

  var API_BASE = window.API_BASE || '';
  var _cache = null;
  var _loading = false;
  var _popupOpen = false;

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
  var DIAMOND_SVG = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
    '<path d="M6 3h12l4 6-10 13L2 9z"/>' +
    '<path d="M11 3 8 9l4 13 4-13-3-6"/>' +
    '<path d="M2 9h20"/>' +
    '</svg>';

  /** Render the badge INTO the existing profile card's #membership-badge slot. */
  function renderBadge(status) {
    var badge = document.getElementById('membership-badge');
    if (!badge) return;

    var premium = isPremium(status);
    badge.className = 'membership-badge ' + (premium ? 'membership-badge--premium' : 'membership-badge--free');
    badge.innerHTML =
      '<div class="mb-diamond mb-diamond-float">' +
        '<div class="mb-diamond-glow"></div>' +
        '<div class="mb-diamond-svg">' + DIAMOND_SVG + '</div>' +
        (premium ? '<div class="mb-diamond-shimmer"></div>' : '') +
      '</div>' +
      '<span class="mb-badge-text">' + (premium ? 'Premium Member' : 'فعال‌سازی Premium') + '</span>';
    badge.title = premium ? 'عضو ویژه AMIRBTC' : 'ارتقا به عضویت ویژه';
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

  async function loadCard() {
    if (_cache || _loading) return;
    _loading = true;
    renderSkeleton();
    try {
      var res = await apiFetch('/api/membership/status');
      if (res && res.ok && res.data) {
        _cache = res.data;
        renderBadge(res.data);
      } else {
        renderError();
      }
    } catch (e) {
      renderError();
    } finally {
      _loading = false;
    }
  }

  /** Open membership detail. */
  function open() {
    if (!_cache) { loadCard(); return; }
    if (_popupOpen) return;
    _popupOpen = true;

    if (isPremium(_cache)) {
      openVipStatusPopup(_cache);
    } else {
      // Check if there's a pending request
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
        // Timeline
        '<ul class="mb-timeline">' +
          '<li class="mb-timeline-item"><div class="mb-timeline-num">۱</div><div class="mb-timeline-text">ثبت‌نام از طریق لینک رسمی Bitunix</div></li>' +
          '<li class="mb-timeline-item"><div class="mb-timeline-num">۲</div><div class="mb-timeline-text">ثبت UID صرافی</div></li>' +
          '<li class="mb-timeline-item"><div class="mb-timeline-num">۳</div><div class="mb-timeline-text">بررسی توسط تیم</div></li>' +
          '<li class="mb-timeline-item"><div class="mb-timeline-num">۴</div><div class="mb-timeline-text">فعال‌سازی دائمی Premium</div></li>' +
        '</ul>' +
        // Register button
        '<button class="mb-cta-register" onclick="MembershipApp.openBitunix()">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M18 13v6a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V8a2 2 0 0 1 2-2h6"/><polyline points="15 3 21 3 21 9"/><line x1="10" y1="14" x2="21" y2="3"/></svg>' +
          'ثبت‌نام در Bitunix' +
        '</button>' +
        // UID form
        '<div class="mb-uid-form">' +
          '<label class="mb-uid-label">ثبت درخواست عضویت</label>' +
          '<input type="text" class="mb-uid-input" id="mb-uid-input" placeholder="شناسه کاربری Bitunix خود را وارد کنید" dir="ltr" />' +
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

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closePopup(); };
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<button class="mb-popup-close" onclick="MembershipApp.closePopup()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="mb-pending">' +
          '<div class="mb-pending-icon">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>' +
          '</div>' +
          '<div class="mb-pending-title">درخواست شما در حال بررسی است</div>' +
          '<div class="mb-pending-msg">درخواست عضویت شما با موفقیت ثبت شده و در حال بررسی توسط تیم مدیریت است. این فرآیند معمولاً چند ساعت طول می‌کشد.</div>' +
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
    // Open Bitunix registration referral link
    var url = 'https://www.bitunix.com/register?vipCode=AMIRBTC';
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
      var res = await apiFetch('/api/membership/request', {
        method: 'POST',
        body: JSON.stringify({ exchange: 'Bitunix', uid: uid }),
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

  // Benefit row helper
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

  // Expose globally
  window.MembershipApp = {
    loadCard: loadCard,
    open: open,
    closePopup: closePopup,
    openBitunix: openBitunix,
    submitUid: submitUid,
    refresh: function () { _cache = null; return loadCard(); },
  };

  // Auto-load on DOMContentLoaded (also called from loadUser in app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCard);
  } else {
    loadCard();
  }
})();

/**
 * MembershipApp — User-facing membership card for the Mini App profile.
 *
 * Renders the #membership-card element on the profile page.
 * Uses the existing adminApiFetch pattern (X-Telegram-Init-Data header).
 *
 * NO polling. Single fetch on profile load. Cache in-memory.
 */
(function () {
  'use strict';

  const API_BASE = window.API_BASE || '';
  let _cache = null;
  let _loading = false;

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

  function renderCard(status) {
    var card = document.getElementById('membership-card');
    if (!card) return;
    var content = card.querySelector('.mb-card-content');
    if (!content) return;

    card.classList.remove('skeleton-loading');

    if (isPremium(status)) {
      // Premium VIP card
      card.classList.add('mb-card-vip');
      var levelLabel = { VIP: 'VIP', PREMIUM: 'پرمیوم', ELITE: 'الیت' }[status.level] || status.level;
      content.innerHTML =
        '<div class="mb-card-top">' +
          '<div class="mb-card-icon">' +
            '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/></svg>' +
          '</div>' +
          '<div class="mb-card-info">' +
            '<div class="mb-card-label">عضویت ویژه</div>' +
            '<div class="mb-card-level">' + esc(levelLabel) + '</div>' +
          '</div>' +
          '<div class="mb-card-badge">★</div>' +
        '</div>' +
        (status.lifetime
          ? '<div class="mb-card-lifetime">∞ مادام‌العمر</div>'
          : '<div class="mb-card-expire">انقضا: ' + esc(formatFaDate(status.expireAt)) + '</div>'
        );
    } else {
      // Free user upsell card
      card.classList.remove('mb-card-vip');
      card.classList.add('mb-card-free');
      content.innerHTML =
        '<div class="mb-card-top">' +
          '<div class="mb-card-icon mb-card-icon-free">' +
            '<svg width="24" height="24" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/></svg>' +
          '</div>' +
          '<div class="mb-card-info">' +
            '<div class="mb-card-label">ارتقا به Premium</div>' +
            '<div class="mb-card-sub">عضویت ویژه صرافی را فعال کنید</div>' +
          '</div>' +
          '<div class="mb-card-arrow">›</div>' +
        '</div>';
    }
  }

  function renderSkeleton() {
    var card = document.getElementById('membership-card');
    if (card) card.classList.add('skeleton-loading');
  }

  function renderError() {
    var card = document.getElementById('membership-card');
    if (!card) return;
    var content = card.querySelector('.mb-card-content');
    if (content) {
      content.innerHTML = '<div class="mb-card-label">عضویت</div><div class="mb-card-sub">خطا در بارگذاری</div>';
    }
    card.classList.remove('skeleton-loading');
  }

  async function loadCard() {
    if (_cache || _loading) return;
    _loading = true;
    renderSkeleton();
    try {
      var res = await apiFetch('/api/membership/status');
      if (res && res.ok && res.data) {
        _cache = res.data;
        renderCard(res.data);
      } else {
        renderError();
      }
    } catch (e) {
      renderError();
    } finally {
      _loading = false;
    }
  }

  /** Open the membership detail (popup for VIP, activation page for FREE). */
  function open() {
    if (!_cache) { loadCard(); return; }
    if (isPremium(_cache)) {
      openPremiumPopup(_cache);
    } else {
      openActivationPage();
    }
  }

  function openPremiumPopup(status) {
    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    var levelLabel = { VIP: 'VIP', PREMIUM: 'پرمیوم', ELITE: 'الیت' }[status.level] || status.level;
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<div class="mb-popup-badge">★</div>' +
        '<div class="mb-popup-title">عضو ویژه AMIRBTC</div>' +
        '<div class="mb-popup-level">' + esc(levelLabel) + '</div>' +
        (status.lifetime ? '<div class="mb-popup-lifetime">∞ مادام‌العمر</div>' : '') +
        '<div class="mb-popup-date">تاریخ فعال‌سازی: ' + esc(formatFaDate(status.approvedAt)) + '</div>' +
        '<p class="mb-popup-msg">شما عضو ویژه AMIRBTC هستید. تمام امکانات بدون محدودیت برای شما فعال است. عضویت شما دائمی است.</p>' +
        '<button class="mb-popup-btn" onclick="this.closest(\'.mb-popup-overlay\').remove()">متوجه شدم</button>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  function openActivationPage() {
    // Simple alert-style activation page (can be enhanced with a full page later)
    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML =
      '<div class="mb-popup mb-popup-activation">' +
        '<div class="mb-popup-badge mb-popup-badge-gold">★</div>' +
        '<div class="mb-popup-title">عضویت Premium</div>' +
        '<p class="mb-popup-msg">با ثبت‌نام در صرافی از طریق لینک ما و ثبت شناسه کاربری (UID)، به عضویت دائمی Premium دست پیدا کنید.</p>' +
        '<div class="mb-steps">' +
          '<div class="mb-step"><span class="mb-step-num">۱</span> ثبت‌نام در صرافی</div>' +
          '<div class="mb-step"><span class="mb-step-num">۲</span> ثبت شناسه کاربری</div>' +
          '<div class="mb-step"><span class="mb-step-num">۳</span> اولین معامله</div>' +
        '</div>' +
        '<div class="mb-step-final">Premium دائمی فعال می‌شود</div>' +
        '<button class="mb-popup-btn" onclick="this.closest(\'.mb-popup-overlay\').remove()">متوجه شدم</button>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  // Expose globally
  window.MembershipApp = {
    loadCard: loadCard,
    open: open,
    refresh: function () { _cache = null; return loadCard(); },
  };

  // Auto-load on DOMContentLoaded (called from loadUser in app.js too)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCard);
  } else {
    loadCard();
  }
})();

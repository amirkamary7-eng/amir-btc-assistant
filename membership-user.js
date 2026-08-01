/**
 * MembershipApp — Premium badge for the Mini App profile card.
 *
 * Renders the #membership-badge element INSIDE the existing .profile-card
 * (top-left corner). NO separate membership card is added to the profile page.
 *
 * VIP/PREMIUM/ELITE → gold glass badge with Crown icon + "عضو ویژه" text.
 *   Click → opens Premium popup (badge, level, lifetime, date, message).
 * FREE/other → subtle "فعال‌سازی Premium" badge.
 *   Click → opens activation popup (3 steps + benefits).
 *
 * NO polling. Single fetch on profile load. In-memory cache.
 */
(function () {
  'use strict';

  var API_BASE = window.API_BASE || '';
  var _cache = null;
  var _loading = false;

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

  /** Render the badge INTO the existing profile card's #membership-badge slot. */
  function renderBadge(status) {
    var badge = document.getElementById('membership-badge');
    if (!badge) return;

    if (isPremium(status)) {
      // Premium badge — glass + gold gradient + glow + hover animation
      var levelLabel = { VIP: 'VIP', PREMIUM: 'پرمیوم', ELITE: 'الیت' }[status.level] || status.level;
      badge.className = 'membership-badge membership-badge--premium';
      badge.innerHTML =
        '<div class="mb-badge-glow"></div>' +
        '<div class="mb-badge-body">' +
          '<svg class="mb-badge-icon" width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/>' +
            '<path d="M5 20h14"/>' +
          '</svg>' +
          '<span class="mb-badge-text">عضو ویژه</span>' +
        '</div>' +
        '<div class="mb-badge-shimmer"></div>';
      badge.title = 'سطح: ' + levelLabel + (status.lifetime ? ' · مادام‌العمر' : '');
    } else {
      // Free user — subtle activation badge
      badge.className = 'membership-badge membership-badge--free';
      badge.innerHTML =
        '<div class="mb-badge-body">' +
          '<svg class="mb-badge-icon" width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/>' +
          '</svg>' +
          '<span class="mb-badge-text">فعال‌سازی Premium</span>' +
        '</div>';
      badge.title = 'ارتقا به عضویت ویژه';
    }
  }

  function renderSkeleton() {
    var badge = document.getElementById('membership-badge');
    if (badge) {
      badge.className = 'membership-badge membership-badge--loading';
      badge.innerHTML = '<div class="mb-badge-body"><div class="mb-badge-skeleton"></div></div>';
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

  /** Open membership detail (popup for VIP, activation for FREE). */
  function open() {
    if (!_cache) { loadCard(); return; }
    if (isPremium(_cache)) {
      openPremiumPopup(_cache);
    } else {
      openActivationPopup();
    }
  }

  function openPremiumPopup(status) {
    // Remove any existing popup
    var existing = document.querySelector('.mb-popup-overlay');
    if (existing) existing.remove();

    var levelLabel = { VIP: 'VIP', PREMIUM: 'پرمیوم', ELITE: 'الیت' }[status.level] || status.level;
    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML =
      '<div class="mb-popup">' +
        '<div class="mb-popup-glow"></div>' +
        '<div class="mb-popup-badge">' +
          '<svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>' +
          '</svg>' +
        '</div>' +
        '<div class="mb-popup-title">عضو ویژه AMIRBTC</div>' +
        '<div class="mb-popup-level">' + esc(levelLabel) + '</div>' +
        (status.lifetime
          ? '<div class="mb-popup-lifetime">∞ مادام‌العمر</div>'
          : '<div class="mb-popup-date">انقضا: ' + esc(formatFaDate(status.expireAt)) + '</div>'
        ) +
        '<div class="mb-popup-date">تاریخ فعال‌سازی: ' + esc(formatFaDate(status.approvedAt)) + '</div>' +
        '<p class="mb-popup-msg">شما عضو ویژه AMIRBTC هستید. تمام امکانات بدون محدودیت برای شما فعال است. عضویت شما دائمی است.</p>' +
        '<button class="mb-popup-btn" onclick="this.closest(\'.mb-popup-overlay\').remove()">متوجه شدم</button>' +
      '</div>';
    document.body.appendChild(overlay);
  }

  function openActivationPopup() {
    var existing = document.querySelector('.mb-popup-overlay');
    if (existing) existing.remove();

    var overlay = document.createElement('div');
    overlay.className = 'mb-popup-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) overlay.remove(); };
    overlay.innerHTML =
      '<div class="mb-popup mb-popup--activation">' +
        '<div class="mb-popup-glow"></div>' +
        '<div class="mb-popup-badge mb-popup-badge--gold">' +
          '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">' +
            '<path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/>' +
          '</svg>' +
        '</div>' +
        '<div class="mb-popup-title">عضویت Premium</div>' +
        '<p class="mb-popup-msg">با ثبت‌نام در صرافی از طریق لینک ما و ثبت شناسه کاربری (UID)، به عضویت دائمی Premium دست پیدا کنید.</p>' +
        '<div class="mb-steps">' +
          '<div class="mb-step"><span class="mb-step-num">۱</span><span>ثبت‌نام در صرافی</span></div>' +
          '<div class="mb-step"><span class="mb-step-num">۲</span><span>ثبت شناسه کاربری</span></div>' +
          '<div class="mb-step"><span class="mb-step-num">۳</span><span>اولین معامله</span></div>' +
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

  // Auto-load on DOMContentLoaded (also called from loadUser in app.js)
  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', loadCard);
  } else {
    loadCard();
  }
})();

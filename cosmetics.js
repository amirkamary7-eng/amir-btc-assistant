/**
 * Cosmetics Shop — Profile Cosmetics frontend module (Phase 5)
 *
 * Renders the cosmetics catalog:
 *   - Normal users: see locked cards (blurred, "Premium Only")
 *   - Premium users: see purchasable cards, can buy with AB + activate
 */
(function () {
  'use strict';

  var API_BASE = window.API_BASE || '';
  var _shopOpen = false;
  var _catalog = null;

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

  function formatNumber(n) {
    return Number(n || 0).toLocaleString('en-US');
  }

  var RARITY_LABELS = { common: 'معمولی', rare: 'کمیاب', epic: 'حماسی', legendary: 'افسانه‌ای', mythic: 'اسطوره‌ای' };
  var RARITY_COLORS = { common: '#9ca3af', rare: '#3b82f6', epic: '#a855f7', legendary: '#f59e0b', mythic: '#ef4444' };

  async function openShop() {
    if (_shopOpen) return;
    _shopOpen = true;
    closeShop();

    var overlay = document.createElement('div');
    overlay.className = 'cosmetics-shop-overlay';
    overlay.id = 'cosmetics-shop-overlay';
    overlay.onclick = function (e) { if (e.target === overlay) closeShop(); };
    document.body.appendChild(overlay);

    overlay.innerHTML =
      '<div class="cosmetics-shop">' +
        '<button class="cosmetics-shop-close" onclick="CosmeticsApp.closeShop()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="cosmetics-shop-header">' +
          '<h2 class="cosmetics-shop-title">🎨 ظاهر پروفایل</h2>' +
          '<p class="cosmetics-shop-subtitle">سبک‌های بصری پروفایل را با AB Token خریداری و فعال کنید</p>' +
        '</div>' +
        '<div class="cosmetics-shop-loading"><div class="cosmetics-shop-spinner"></div><p>در حال بارگذاری...</p></div>' +
      '</div>';

    try {
      var res = await apiFetch('/api/cosmetics');
      if (res && res.status === 'success' && res.items) {
        _catalog = res;
        renderShop(res);
      } else {
        renderShopError('خطا در بارگذاری کاتالوگ');
      }
    } catch (e) {
      renderShopError('خطا: ' + (e.message || 'نامشخص'));
    }
  }

  function renderShop(data) {
    var overlay = document.getElementById('cosmetics-shop-overlay');
    if (!overlay) return;

    var items = data.items || [];
    var isPremium = data.is_premium;
    var activeCosmetic = data.active_cosmetic;

    var itemsHtml = items.map(function (item) {
      var rarityColor = RARITY_COLORS[item.rarity] || '#9ca3af';
      var rarityLabel = RARITY_LABELS[item.rarity] || item.rarity;
      var isActive = activeCosmetic && activeCosmetic.cosmetic_id === item.id;
      var isLocked = item.locked;
      var isOwned = item.owned;

      var actionBtn = '';
      if (isActive) {
        actionBtn = '<button class="cosmetic-card-btn cosmetic-card-btn--active" disabled>فعال</button>';
      } else if (isOwned) {
        actionBtn = '<button class="cosmetic-card-btn cosmetic-card-btn--activate" onclick="CosmeticsApp.activate(\'' + esc(item.id) + '\')">فعال‌سازی</button>';
      } else if (isLocked) {
        actionBtn = '<button class="cosmetic-card-btn cosmetic-card-btn--locked" disabled>🔒 فقط Premium</button>';
      } else {
        actionBtn = '<button class="cosmetic-card-btn cosmetic-card-btn--purchase" onclick="CosmeticsApp.purchase(\'' + esc(item.id) + '\', ' + item.token_cost + ')">خرید با ' + formatNumber(item.token_cost) + ' AB</button>';
      }

      var cardClass = 'cosmetic-card cosmetic-card--' + item.rarity;
      if (isActive) cardClass += ' cosmetic-card--active';
      if (isLocked) cardClass += ' cosmetic-card--locked';

      return '<div class="' + cardClass + '">' +
        '<div class="cosmetic-card-preview" style="--cosmetic-color: ' + rarityColor + ';">' +
          '<div class="cosmetic-card-glow"></div>' +
          '<div class="cosmetic-card-icon">🎨</div>' +
        '</div>' +
        '<div class="cosmetic-card-info">' +
          '<div class="cosmetic-card-title">' + esc(item.title) + '</div>' +
          '<div class="cosmetic-card-rarity" style="color: ' + rarityColor + ';">' + esc(rarityLabel) + '</div>' +
          (item.description ? '<div class="cosmetic-card-desc">' + esc(item.description) + '</div>' : '') +
          '<div class="cosmetic-card-cost">' + formatNumber(item.token_cost) + ' AB</div>' +
        '</div>' +
        actionBtn +
      '</div>';
    }).join('');

    overlay.innerHTML =
      '<div class="cosmetics-shop">' +
        '<button class="cosmetics-shop-close" onclick="CosmeticsApp.closeShop()" aria-label="بستن">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="cosmetics-shop-header">' +
          '<h2 class="cosmetics-shop-title">🎨 ظاهر پروفایل</h2>' +
          '<p class="cosmetics-shop-subtitle">' + (isPremium ? 'سبک‌های بصری پروفایل را با AB Token خریداری و فعال کنید' : 'برای خرید سبک‌ها، ابتدا عضویت Premium را فعال کنید') + '</p>' +
        '</div>' +
        '<div class="cosmetics-shop-grid">' + itemsHtml + '</div>' +
      '</div>';
  }

  function renderShopError(msg) {
    var overlay = document.getElementById('cosmetics-shop-overlay');
    if (!overlay) return;
    overlay.innerHTML =
      '<div class="cosmetics-shop">' +
        '<button class="cosmetics-shop-close" onclick="CosmeticsApp.closeShop()">' +
          '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
        '</button>' +
        '<div class="cosmetics-shop-error"><p>' + esc(msg) + '</p><button class="cosmetics-shop-retry" onclick="CosmeticsApp.openShop()">تلاش مجدد</button></div>' +
      '</div>';
  }

  function closeShop() {
    var overlay = document.getElementById('cosmetics-shop-overlay');
    if (overlay) overlay.remove();
    _shopOpen = false;
  }

  async function purchase(cosmeticId, cost) {
    if (!cosmeticId) return;
    if (!confirm('خرید این ظاهر با ' + formatNumber(cost) + ' AB؟')) return;
    try {
      var res = await apiFetch('/api/cosmetics/' + cosmeticId + '/purchase', { method: 'POST' });
      if (res && res.status === 'success') {
        if (window.admToast) admToast('خرید موفق!', 'success');
        openShop();
      } else {
        var msg = (res && res.message) ? res.message : 'خطا در خرید';
        if (res && res.code === 'PREMIUM_REQUIRED') msg = 'برای خرید، عضویت Premium لازم است';
        if (res && res.code === 'ALREADY_OWNED') msg = 'این ظاهر قبلاً خریداری شده';
        if (res && res.code === 'PAYMENT_FAILED') msg = 'موجودی AB کافی نیست';
        if (window.admToast) admToast(msg, 'error'); else alert(msg);
      }
    } catch (e) {
      if (window.admToast) admToast('خطا: ' + e.message, 'error'); else alert('خطا: ' + e.message);
    }
  }

  async function activate(cosmeticId) {
    if (!cosmeticId) return;
    try {
      var res = await apiFetch('/api/cosmetics/' + cosmeticId + '/activate', { method: 'POST' });
      if (res && res.status === 'success') {
        if (window.admToast) admToast('ظاهر فعال شد!', 'success');
        if (window.MembershipApp) window.MembershipApp.refresh();
        openShop();
      } else {
        var msg = (res && res.message) ? res.message : 'خطا در فعال‌سازی';
        if (window.admToast) admToast(msg, 'error'); else alert(msg);
      }
    } catch (e) {
      if (window.admToast) admToast('خطا: ' + e.message, 'error'); else alert('خطا: ' + e.message);
    }
  }

  window.CosmeticsApp = {
    openShop: openShop,
    closeShop: closeShop,
    purchase: purchase,
    activate: activate,
  };
})();

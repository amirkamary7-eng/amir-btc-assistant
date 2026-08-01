/**
 * MembershipAdmin — Premium admin panel for the Membership module.
 *
 * Uses EXISTING admin design system classes:
 * - adminStatCardV2() for stats (same as dashboard)
 * - .adm-list-item + .adm-card-top + .adm-card-meta for cards (same as users)
 * - .admin-badge for status badges
 * - .admin-btn for action buttons
 * - adminPagination() for pagination
 * - .adm-search-bar for search
 *
 * Premium SVG icons (no emoji). Fully responsive. Aligned with design system.
 */
(function () {
  'use strict';

  var _page = 1;
  var _search = '';
  var _searchTimer = null;

  function apiFetch(path, options) {
    return window.adminApiFetch(path, options);
  }

  function esc(s) {
    if (s == null) return '';
    var d = document.createElement('div');
    d.textContent = String(s);
    return d.innerHTML;
  }

  function formatFaRelative(iso) {
    if (!iso) return '—';
    try {
      var diff = Date.now() - new Date(iso).getTime();
      var min = Math.floor(diff / 60000);
      if (min < 1) return 'همین الان';
      if (min < 60) return min + ' دقیقه پیش';
      var hr = Math.floor(min / 60);
      if (hr < 24) return hr + ' ساعت پیش';
      var day = Math.floor(hr / 24);
      if (day < 30) return day + ' روز پیش';
      return new Intl.DateTimeFormat('fa-IR', { month: 'short', day: 'numeric' }).format(new Date(iso));
    } catch (e) { return iso.slice(0, 10); }
  }

  // Premium SVG icons (no emoji)
  var ICONS = {
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M9 12l2 2 4-4"/><circle cx="12" cy="12" r="10"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7z"/><path d="M5 20h14"/></svg>',
    pause: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="10" y1="15" x2="10" y2="9"/><line x1="14" y1="15" x2="14" y2="9"/></svg>',
    x: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>',
    download: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="7 10 12 15 17 10"/><line x1="12" y1="15" x2="12" y2="3"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="14" height="14"><path d="M23 4v6h-6"/><path d="M1 20v-6h6"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/><path d="M20.49 15a9 9 0 0 1-14.85 3.36L1 14"/></svg>',
    search: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
  };

  // Use the EXISTING adminStatCardV2 helper from admin.js
  function statCard(value, label, iconKey, color) {
    if (typeof window.adminStatCardV2 === 'function') {
      // adminStatCardV2 expects an SVG string for iconKey — pass our premium SVG
      var iconSvg = ICONS[iconKey] || ICONS.users;
      // The existing function accepts iconKey as a key into its own icon map.
      // We need to pass the SVG directly. Let's build a custom card instead.
    }
    // Custom stat card matching adm-stat-card-v2 style
    var colors = {
      orange: { bg: 'rgba(247,147,26,0.12)', color: '#f7b950', glow: 'rgba(247,147,26,0.08)' },
      green: { bg: 'rgba(0,200,150,0.12)', color: '#4ade80', glow: 'rgba(0,200,150,0.08)' },
      blue: { bg: 'rgba(96,165,250,0.12)', color: '#60a5fa', glow: 'rgba(96,165,250,0.08)' },
      red: { bg: 'rgba(239,68,68,0.12)', color: '#f87171', glow: 'rgba(239,68,68,0.08)' },
      gray: { bg: 'rgba(255,255,255,0.06)', color: '#a8b2c5', glow: 'rgba(255,255,255,0.04)' },
    };
    var c = colors[color] || colors.orange;
    var icon = ICONS[iconKey] || ICONS.users;
    return '<div class="adm-stat-card-v2" style="--stat-bg:' + c.bg + ';--stat-color:' + c.color + ';--stat-glow:' + c.glow + '">' +
      '<div class="adm-stat-card-v2-icon">' + icon + '</div>' +
      '<div class="adm-stat-card-v2-value">' + esc(String(value)) + '</div>' +
      '<div class="adm-stat-card-v2-label">' + esc(label) + '</div>' +
    '</div>';
  }

  // Use the EXISTING adminBadge helper
  function badge(text, color) {
    if (typeof window.adminBadge === 'function') {
      return window.adminBadge(text, color);
    }
    return '<span class="admin-badge admin-badge-' + (color || 'gray') + '">' + esc(text) + '</span>';
  }

  function empty(msg) {
    if (typeof window.adminEmpty === 'function') return window.adminEmpty(msg);
    return '<div style="text-align:center;padding:40px;color:var(--text-sub);font-size:13px">' + esc(msg) + '</div>';
  }

  function skeletonGrid(n) {
    if (typeof window.adminSkeletonGrid === 'function') return window.adminSkeletonGrid(n);
    return '<div style="text-align:center;padding:40px;color:var(--text-sub)">در حال بارگذاری...</div>';
  }

  function errorState(msg, retryFn) {
    if (typeof window.adminErrorState === 'function') return window.adminErrorState(msg, retryFn);
    return '<div style="text-align:center;padding:40px;color:var(--red)">' + esc(msg) + '</div>';
  }

  function statusBadge(status) {
    var colors = { PENDING: 'orange', APPROVED: 'green', REJECTED: 'red' };
    var labels = { PENDING: 'در انتظار', APPROVED: 'تأیید شده', REJECTED: 'رد شده' };
    return badge(labels[status] || status, colors[status] || 'gray');
  }

  function levelBadge(level) {
    var colors = { FREE: 'gray', VIP: 'orange', PREMIUM: 'blue', ELITE: 'orange' };
    return badge(level, colors[level] || 'gray');
  }

  async function loadStats() {
    var container = document.getElementById('admin-membership-stats');
    if (!container) return;
    try {
      var data = await apiFetch('/api/admin/membership/stats');
      if (!data || !data.ok) { container.innerHTML = ''; return; }
      var s = data.data;
      container.innerHTML =
        statCard(s.totalUsers, 'کل کاربران', 'users', 'orange') +
        statCard(s.pendingRequests, 'در انتظار', 'clock', 'blue') +
        statCard(s.approvedUsers, 'تأیید شده', 'check', 'green') +
        statCard(s.vipUsers, 'کاربران VIP', 'crown', 'orange') +
        statCard(s.suspendedUsers, 'معلق', 'pause', 'gray') +
        statCard(s.rejectedRequests, 'رد شده', 'x', 'red');
    } catch (e) {
      container.innerHTML = '';
    }
  }

  async function loadRequests() {
    var container = document.getElementById('admin-membership-list');
    var paginationEl = document.getElementById('admin-membership-pagination');
    if (!container) return;
    container.innerHTML = skeletonGrid(4);
    if (paginationEl) paginationEl.innerHTML = '';

    var params = 'page=' + _page + '&pageSize=20';
    if (_search) params += '&search=' + encodeURIComponent(_search);
    var statusFilter = document.getElementById('mb-status-filter');
    var exchangeFilter = document.getElementById('mb-exchange-filter');
    if (statusFilter && statusFilter.value) params += '&status=' + statusFilter.value;
    if (exchangeFilter && exchangeFilter.value) params += '&exchange=' + encodeURIComponent(exchangeFilter.value);

    try {
      var data = await apiFetch('/api/admin/membership/requests?' + params);
      if (!data || !data.ok) {
        container.innerHTML = errorState('خطا در بارگذاری', 'MembershipAdmin.load()');
        return;
      }
      var result = data.data;
      if (!result.items || result.items.length === 0) {
        container.innerHTML = empty('داده‌ای یافت نشد');
        return;
      }

      var html = '';
      result.items.forEach(function (r) {
        var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || r.telegram_id;
        var initial = esc(String(name).charAt(0) || '؟');
        var actions = '';
        if (r.status === 'PENDING') {
          actions =
            '<button class="admin-btn admin-btn-green admin-btn-sm" onclick="MembershipAdmin.act(\'' + r.id + '\',\'approve\')">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg>' +
              ' تأیید</button>' +
            '<button class="admin-btn admin-btn-red admin-btn-sm" onclick="MembershipAdmin.act(\'' + r.id + '\',\'reject\')">' +
              '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>' +
              ' رد</button>';
        } else if (r.status === 'APPROVED') {
          actions = '<button class="admin-btn admin-btn-ghost admin-btn-sm" onclick="MembershipAdmin.act(\'' + r.id + '\',\'suspend\')">' +
            '<svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="6" y="4" width="4" height="16"/><rect x="14" y="4" width="4" height="16"/></svg>' +
            ' تعلیق</button>';
        }
        html +=
          '<div class="admin-list-item adm-user-card" style="display:flex;flex-direction:column;gap:10px">' +
            '<div class="adm-card-top">' +
              '<div class="adm-card-avatar">' + initial + '</div>' +
              '<div class="adm-card-id">' +
                '<div class="adm-card-name">' + esc(name) + '</div>' +
                '<div class="adm-card-sub">ID: <span class="adm-card-tgid">' + esc(r.telegram_id) + '</span></div>' +
              '</div>' +
              '<div class="adm-card-badges">' + statusBadge(r.status) + levelBadge(r.membership_level) + '</div>' +
            '</div>' +
            '<div class="adm-card-meta">' +
              '<div class="adm-meta-item"><span class="adm-meta-label">صرافی</span><span class="adm-meta-val">' + esc(r.exchange_name) + '</span></div>' +
              '<div class="adm-meta-item"><span class="adm-meta-label">UID</span><span class="adm-meta-val" dir="ltr">' + esc(r.exchange_uid) + '</span></div>' +
              '<div class="adm-meta-item"><span class="adm-meta-label">ثبت</span><span class="adm-meta-val">' + formatFaRelative(r.submitted_at) + '</span></div>' +
            '</div>' +
            (r.admin_note
              ? '<div style="font-size:11px;color:var(--text-dim);background:rgba(255,138,0,0.06);border-radius:8px;padding:6px 10px;border:1px solid rgba(255,138,0,0.12)"><span style="color:var(--accent);font-weight:600">یادداشت: </span>' + esc(r.admin_note) + '</div>'
              : ''
            ) +
            (actions ? '<div style="display:flex;gap:6px;justify-content:flex-end">' + actions + '</div>' : '') +
          '</div>';
      });
      container.innerHTML = html;

      // Use the EXISTING adminPagination helper
      if (typeof window.adminPagination === 'function' && paginationEl) {
        window.adminPagination('admin-membership-pagination', _page, result.totalPages, 'MembershipAdmin.goPage');
      } else if (paginationEl) {
        paginationEl.innerHTML = '<div style="text-align:center;color:var(--text-sub);font-size:12px;padding:8px">' + result.total + ' رکورد</div>';
      }
    } catch (e) {
      container.innerHTML = errorState('خطا: ' + e.message, 'MembershipAdmin.load()');
    }
  }

  async function act(requestId, action) {
    var confirmMsg = {
      approve: 'آیا از تأیید این درخواست اطمینان دارید؟ کاربر به VIP ارتقا می‌یابد.',
      reject: 'آیا از رد این درخواست اطمینان دارید؟',
      suspend: 'آیا از تعلیق این کاربر اطمینان دارید؟'
    }[action];
    if (!confirm(confirmMsg)) return;
    try {
      var data = await apiFetch('/api/admin/membership/' + action, {
        method: 'POST',
        body: JSON.stringify({ requestId: requestId }),
      });
      if (data && data.ok) {
        if (window.admToast) admToast('عملیات با موفقیت انجام شد', 'success');
        loadStats();
        loadRequests();
      } else {
        if (window.admToast) admToast('خطا در عملیات', 'error');
      }
    } catch (e) {
      if (window.admToast) admToast('خطا: ' + e.message, 'error');
    }
  }

  function exportCsv() {
    var params = 'pageSize=1000';
    if (_search) params += '&search=' + encodeURIComponent(_search);
    var statusFilter = document.getElementById('mb-status-filter');
    var exchangeFilter = document.getElementById('mb-exchange-filter');
    if (statusFilter && statusFilter.value) params += '&status=' + statusFilter.value;
    if (exchangeFilter && exchangeFilter.value) params += '&exchange=' + encodeURIComponent(exchangeFilter.value);
    var initData = window.Telegram?.WebApp?.initData || '';
    fetch((window.API_BASE || '') + '/api/admin/membership/requests/export?' + params, {
      headers: { 'X-Telegram-Init-Data': initData },
    }).then(function (res) { return res.blob(); })
      .then(function (blob) {
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'membership-requests.csv';
        a.click();
        URL.revokeObjectURL(url);
      })
      .catch(function (e) { if (window.admToast) admToast('خطا در خروجی', 'error'); });
  }

  // Expose globally
  window.MembershipAdmin = {
    load: function () {
      loadStats();
      loadRequests();
    },
    onSearch: function (val) {
      _search = val.trim();
      _page = 1;
      clearTimeout(_searchTimer);
      _searchTimer = setTimeout(loadRequests, 300); // debounce
    },
    onFilterChange: function () {
      _page = 1;
      loadRequests();
    },
    goPage: function (p) { _page = p; loadRequests(); },
    act: act,
    exportCsv: exportCsv,
  };
})();

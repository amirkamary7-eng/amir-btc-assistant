/**
 * MembershipAdmin — Admin panel for the Membership module.
 *
 * REDESIGNED to match the existing admin design system:
 * - Uses adminStatCardV2() for stats (same as dashboard)
 * - Uses .admin-list-item + .adm-card-top + .adm-card-meta (same as users)
 * - Uses admin-badge classes (same as everywhere)
 * - Uses adminPagination() helper
 * - Uses adminApiFetch() wrapper
 *
 * NO custom CSS classes that don't exist in the existing design system.
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

  // Use the EXISTING adminStatCardV2 helper from admin.js (exposed globally)
  function statCard(value, label, iconKey, color) {
    if (typeof window.adminStatCardV2 === 'function') {
      return window.adminStatCardV2(value, label, iconKey, color);
    }
    // Fallback if not available yet
    return '<div class="adm-stat-card-v2">' +
      '<div class="adm-stat-card-v2-value">' + esc(String(value)) + '</div>' +
      '<div class="adm-stat-card-v2-label">' + esc(label) + '</div>' +
    '</div>';
  }

  // Use the EXISTING adminBadge helper from admin.js
  function badge(text, color) {
    if (typeof window.adminBadge === 'function') {
      return window.adminBadge(text, color);
    }
    return '<span class="admin-badge admin-badge-' + (color || 'gray') + '">' + esc(text) + '</span>';
  }

  // Use the EXISTING adminEmpty helper
  function empty(msg) {
    if (typeof window.adminEmpty === 'function') return window.adminEmpty(msg);
    return '<div style="text-align:center;padding:40px;color:var(--text-sub);font-size:13px">' + esc(msg) + '</div>';
  }

  // Use the EXISTING adminSkeletonGrid helper
  function skeletonGrid(n) {
    if (typeof window.adminSkeletonGrid === 'function') return window.adminSkeletonGrid(n);
    return '<div style="text-align:center;padding:40px;color:var(--text-sub)">در حال بارگذاری...</div>';
  }

  // Use the EXISTING adminErrorState helper
  function errorState(msg, retryFn) {
    if (typeof window.adminErrorState === 'function') return window.adminErrorState(msg, retryFn);
    return '<div style="text-align:center;padding:40px;color:var(--red)">' + esc(msg) + '</div>';
  }

  // Status badge mapping (uses existing admin-badge classes)
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
        statCard(s.pendingRequests, 'در انتظار', 'tickets', 'blue') +
        statCard(s.approvedUsers, 'تأیید شده', 'rewards', 'green') +
        statCard(s.vipUsers, 'کاربران VIP', 'admins', 'orange') +
        statCard(s.suspendedUsers, 'معلق', 'users', 'gray') +
        statCard(s.rejectedRequests, 'رد شده', 'tickets', 'red');
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

      // Render using the EXISTING .admin-list-item + .adm-card-top pattern
      var html = '';
      result.items.forEach(function (r) {
        var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || r.telegram_id;
        var initial = esc(String(name).charAt(0) || '؟');
        var actions = '';
        if (r.status === 'PENDING') {
          actions =
            '<button class="admin-btn admin-btn-green admin-btn-sm" onclick="MembershipAdmin.act(\'' + r.id + '\',\'approve\')">تأیید</button>' +
            '<button class="admin-btn admin-btn-red admin-btn-sm" onclick="MembershipAdmin.act(\'' + r.id + '\',\'reject\')">رد</button>';
        } else if (r.status === 'APPROVED') {
          actions = '<button class="admin-btn admin-btn-ghost admin-btn-sm" onclick="MembershipAdmin.act(\'' + r.id + '\',\'suspend\')">تعلیق</button>';
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
        if (result.totalPages > 1) {
          paginationEl.innerHTML += '<span style="color:var(--text-sub);font-size:11px;display:block;text-align:center;margin-top:4px">' + result.total + ' رکورد</span>';
        }
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

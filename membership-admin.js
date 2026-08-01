/**
 * MembershipAdmin — Admin panel for the Membership module.
 *
 * Rendered into #admin-section-membership when the admin switches to the
 * "عضویت ویژه" sidebar tab. Uses the existing adminApiFetch wrapper.
 *
 * Features: stats dashboard, requests table with filters + pagination,
 * approve/reject/suspend/reactivate actions, CSV export.
 */
(function () {
  'use strict';

  var _page = 1;
  var _search = '';
  var _searchTimer = null;
  var _statsCache = null;

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

  function statusBadge(status) {
    var colors = { PENDING: 'orange', APPROVED: 'green', REJECTED: 'red' };
    var labels = { PENDING: 'در انتظار', APPROVED: 'تأیید شده', REJECTED: 'رد شده' };
    var c = colors[status] || 'gray';
    var l = labels[status] || status;
    return '<span class="admin-badge admin-badge-' + c + '">' + esc(l) + '</span>';
  }

  function levelBadge(level) {
    var colors = { FREE: 'gray', VIP: 'orange', PREMIUM: 'purple', ELITE: 'gold' };
    var c = colors[level] || 'gray';
    return '<span class="admin-badge admin-badge-' + c + '">' + esc(level) + '</span>';
  }

  function statCard(value, label, icon) {
    return '<div class="adm-stat-card">' +
      '<div class="adm-stat-icon">' + (icon || '◆') + '</div>' +
      '<div class="adm-stat-val">' + esc(String(value)) + '</div>' +
      '<div class="adm-stat-lbl">' + esc(label) + '</div>' +
    '</div>';
  }

  async function loadStats() {
    var container = document.getElementById('admin-membership-stats');
    if (!container) return;
    try {
      var data = await apiFetch('/api/admin/membership/stats');
      if (!data || !data.ok) { container.innerHTML = ''; return; }
      var s = data.data;
      _statsCache = s;
      container.innerHTML =
        statCard(s.totalUsers, 'کل کاربران', '👥') +
        statCard(s.pendingRequests, 'در انتظار', '⏳') +
        statCard(s.approvedUsers, 'تأیید شده', '✓') +
        statCard(s.vipUsers, 'VIP+', '★') +
        statCard(s.suspendedUsers, 'معلق', '⏸') +
        statCard(s.rejectedRequests, 'رد شده', '✗');
    } catch (e) {
      container.innerHTML = '<div class="admin-empty">خطا در بارگذاری آمار</div>';
    }
  }

  async function loadRequests() {
    var container = document.getElementById('admin-membership-list');
    var paginationEl = document.getElementById('admin-membership-pagination');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    if (paginationEl) paginationEl.innerHTML = '';

    var params = 'page=' + _page + '&pageSize=20';
    if (_search) params += '&search=' + encodeURIComponent(_search);
    var statusFilter = document.getElementById('mb-status-filter');
    var exchangeFilter = document.getElementById('mb-exchange-filter');
    if (statusFilter && statusFilter.value) params += '&status=' + statusFilter.value;
    if (exchangeFilter && exchangeFilter.value) params += '&exchange=' + encodeURIComponent(exchangeFilter.value);

    try {
      var data = await apiFetch('/api/admin/membership/requests?' + params);
      if (!data || !data.ok) { container.innerHTML = '<div class="admin-empty">خطا در بارگذاری</div>'; return; }
      var result = data.data;
      if (!result.items || result.items.length === 0) {
        container.innerHTML = '<div class="admin-empty">داده‌ای یافت نشد</div>';
        return;
      }

      var html = '';
      result.items.forEach(function (r) {
        var name = [r.first_name, r.last_name].filter(Boolean).join(' ') || r.username || r.telegram_id;
        var actions = '';
        if (r.status === 'PENDING') {
          actions = '<button class="adm-btn adm-btn-sm adm-btn-green" onclick="MembershipAdmin.act(\'' + r.id + '\',\'approve\')">تأیید</button>' +
                    '<button class="adm-btn adm-btn-sm adm-btn-red" onclick="MembershipAdmin.act(\'' + r.id + '\',\'reject\')">رد</button>';
        } else if (r.status === 'APPROVED') {
          actions = '<button class="adm-btn adm-btn-sm adm-btn-orange" onclick="MembershipAdmin.act(\'' + r.id + '\',\'suspend\')">تعلیق</button>';
        }
        html += '<div class="admin-list-item adm-user-card">' +
          '<div class="adm-card-top">' +
            '<div class="adm-card-avatar">' + esc(String(name).charAt(0)) + '</div>' +
            '<div class="adm-card-id">' +
              '<div class="adm-card-name">' + esc(name) + '</div>' +
              '<div class="adm-card-sub">ID: <span class="adm-card-tgid">' + esc(r.telegram_id) + '</span></div>' +
              '<div class="adm-card-sub">' + esc(r.exchange_name) + ' · <span dir="ltr">' + esc(r.exchange_uid) + '</span></div>' +
            '</div>' +
            '<div class="adm-card-badges">' + statusBadge(r.status) + levelBadge(r.membership_level) + '</div>' +
          '</div>' +
          '<div class="adm-card-meta">' +
            '<span class="adm-meta-item"><span class="adm-meta-label">ثبت</span><span class="adm-meta-val">' + formatFaRelative(r.submitted_at) + '</span></span>' +
            (r.admin_note ? '<span class="adm-meta-item"><span class="adm-meta-label">یادداشت</span><span class="adm-meta-val">' + esc(r.admin_note) + '</span></span>' : '') +
            '<span class="adm-meta-item adm-card-actions">' + actions + '</span>' +
          '</div>' +
        '</div>';
      });
      container.innerHTML = html;

      // Pagination
      if (paginationEl && result.totalPages > 1) {
        var phtml = '';
        if (_page > 1) phtml += '<button class="adm-page-btn" onclick="MembershipAdmin.goPage(' + (_page - 1) + ')">قبلی</button>';
        phtml += '<span class="adm-page-info">صفحه ' + _page + ' از ' + result.totalPages + ' · ' + result.total + ' رکورد</span>';
        if (_page < result.totalPages) phtml += '<button class="adm-page-btn" onclick="MembershipAdmin.goPage(' + (_page + 1) + ')">بعدی</button>';
        paginationEl.innerHTML = phtml;
      } else {
        paginationEl.innerHTML = '<div class="adm-page-info">' + result.total + ' رکورد</div>';
      }
    } catch (e) {
      container.innerHTML = '<div class="admin-empty">خطا: ' + esc(e.message) + '</div>';
    }
  }

  async function act(requestId, action) {
    if (!confirm('آیا از ' + action + ' این درخواست اطمینان دارید؟')) return;
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
    // Use adminApiFetch to get authed CSV, then download as blob
    apiFetch('/api/admin/membership/requests/export?' + params).then(function (data) {
      // adminApiFetch returns JSON — but export returns CSV text. Handle both.
      // Actually export returns raw CSV. Let's fetch directly with the auth header.
    }).catch(function () {});
    // Direct fetch with auth header for CSV download
    fetch((window.API_BASE || '') + '/api/admin/membership/requests/export?' + params, {
      headers: { 'X-Telegram-Init-Data': getTelegramInitData() },
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

  function getTelegramInitData() {
    return window.Telegram?.WebApp?.initData || '';
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

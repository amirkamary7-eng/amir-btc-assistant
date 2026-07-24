/* ============================================================
   Admin Control Center — Frontend Logic (Vanilla JS)
   Uses global apiFetch() and API_BASE from app.js
   ============================================================ */

// ─── State ──────────────────────────────────────────────────
let _adminPanelOpen = false;
let _currentAdminSection = 'dashboard';
let _adminUserSearchTimeout = null;
let _adminReferralSearchTimeout = null;
let _adminTicketsFilter = 'all';
let _adminRewardsFilter = 'all';
let _adminData = { is_admin: false, role: '', permissions: [] };
let _adminUsersPage = 1;
let _adminTicketsPage = 1;
let _adminTransactionsPage = 1;
let _adminLogsPage = 1;

// ─── Helpers ────────────────────────────────────────────────

function adminEscapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
}

function adminFormatDate(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleDateString('en-US', {
            month: 'short', day: 'numeric', year: 'numeric',
            hour: '2-digit', minute: '2-digit'
        });
    } catch (e) {
        return String(iso);
    }
}

function adminFormatNumber(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString('en-US');
}

function showAdminToast(message, type) {
    const existing = document.querySelector('.admin-toast');
    if (existing) existing.remove();

    const toast = document.createElement('div');
    toast.className = 'admin-toast admin-toast-' + (type || 'success');
    toast.textContent = message;
    document.body.appendChild(toast);
    setTimeout(() => { if (toast.parentNode) toast.remove(); }, 2500);
}

function adminEmpty(message) {
    return '<div class="admin-empty">' + adminEscapeHtml(message || 'No data found') + '</div>';
}

/**
 * Show a toast notification in the admin panel.
 * @param {string} message - The message to display
 * @param {string} type - 'success' | 'error' | 'info'
 */
function adminToast(message, type) {
    var t = document.createElement('div');
    t.className = 'admin-toast admin-toast-' + (type || 'info');
    t.textContent = message || '';
    t.style.cssText = 'position:fixed;bottom:20px;left:50%;transform:translateX(-50%);z-index:99999;padding:10px 20px;border-radius:10px;font-size:13px;font-weight:700;font-family:inherit;transition:opacity 0.3s ease,transform 0.3s ease;opacity:0;transform:translateX(-50%) translateY(10px);';
    if (type === 'success') { t.style.background = 'rgba(0,200,150,0.95)'; t.style.color = '#020611'; }
    else if (type === 'error') { t.style.background = 'rgba(255,77,77,0.95)'; t.style.color = '#FFF'; }
    else { t.style.background = 'rgba(245,166,35,0.95)'; t.style.color = '#020611'; }
    document.body.appendChild(t);
    requestAnimationFrame(function() {
        t.style.opacity = '1';
        t.style.transform = 'translateX(-50%) translateY(0)';
    });
    setTimeout(function() {
        t.style.opacity = '0';
        t.style.transform = 'translateX(-50%) translateY(10px)';
        setTimeout(function() { if (t.parentNode) t.parentNode.removeChild(t); }, 300);
    }, 2500);
}

function adminBadge(text, color) {
    const cls = {
        green: 'admin-badge-green',
        red: 'admin-badge-red',
        orange: 'admin-badge-orange',
        blue: 'admin-badge-blue',
        gray: 'admin-badge-gray'
    };
    return '<span class="admin-badge ' + (cls[color] || cls.gray) + '">' + adminEscapeHtml(text) + '</span>';
}

function adminStatCard(value, label) {
    return '<div class="admin-stat-card"><div class="admin-stat-value">' +
        adminEscapeHtml(String(value)) +
        '</div><div class="admin-stat-label">' + adminEscapeHtml(label) + '</div></div>';
}

/**
 * Enhanced stat card with icon and color theming.
 * @param {string} value - The stat value
 * @param {string} label - The stat label
 * @param {string} iconKey - Key in _adminStatIcons
 * @param {string} color - Color theme: 'orange'|'green'|'blue'|'red'|'purple'|'gray'
 */
function adminStatCardV2(value, label, iconKey, color) {
    const icons = {
        users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/></svg>',
        active: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
        new: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
        tickets: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>',
        open: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
        tx: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><rect x="2" y="5" width="20" height="14" rx="2"/><line x1="2" y1="10" x2="22" y2="10"/></svg>',
        rewards: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><circle cx="12" cy="8" r="6"/><path d="M8.21 13.89 7 23l5-3 5 3-1.21-9.12"/></svg>',
        admins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" width="18" height="18"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    };
    const colors = {
        orange: { bg: 'rgba(247,147,26,0.12)', color: '#f7b950', glow: 'rgba(247,147,26,0.08)' },
        green: { bg: 'rgba(0,200,150,0.12)', color: '#4ade80', glow: 'rgba(0,200,150,0.08)' },
        blue: { bg: 'rgba(96,165,250,0.12)', color: '#60a5fa', glow: 'rgba(96,165,250,0.08)' },
        red: { bg: 'rgba(239,68,68,0.12)', color: '#f87171', glow: 'rgba(239,68,68,0.08)' },
        purple: { bg: 'rgba(167,139,250,0.12)', color: '#a78bfa', glow: 'rgba(167,139,250,0.08)' },
        gray: { bg: 'rgba(255,255,255,0.06)', color: '#a8b2c5', glow: 'rgba(255,255,255,0.04)' },
    };
    const c = colors[color] || colors.orange;
    const icon = icons[iconKey] || icons.users;
    return '<div class="adm-stat-card-v2" style="--stat-bg:' + c.bg + ';--stat-color:' + c.color + ';--stat-glow:' + c.glow + '">' +
        '<div class="adm-stat-card-v2-icon">' + icon + '</div>' +
        '<div class="adm-stat-card-v2-value">' + adminEscapeHtml(String(value)) + '</div>' +
        '<div class="adm-stat-card-v2-label">' + adminEscapeHtml(label) + '</div>' +
        '</div>';
}

function adminPagination(containerId, currentPage, totalPages, loadFn) {
    const container = document.getElementById(containerId);
    if (!container || totalPages <= 1) {
        if (container) container.innerHTML = '';
        return;
    }
    let html = '';
    html += '<button ' + (currentPage <= 1 ? 'disabled' : '') +
        ' onclick="' + loadFn + '(' + (currentPage - 1) + ')">Prev</button>';
    html += '<span style="color:var(--text-secondary);font-size:13px;padding:6px 8px;">' +
        currentPage + ' / ' + totalPages + '</span>';
    html += '<button ' + (currentPage >= totalPages ? 'disabled' : '') +
        ' onclick="' + loadFn + '(' + (currentPage + 1) + ')">Next</button>';
    container.innerHTML = html;
}

// ─── Initialize ─────────────────────────────────────────────

async function initAdminPanel() {
    // Admin detection is unified: isCurrentUserAdmin (set by bootstrapUser) is the
    // single source of truth. No separate /api/admin/is-admin call needed.
    // Admin entry button visibility is managed by updateAdminEntryButton() in app.js.
    _adminPanelInitialized = true;
}

// ─── Panel Open / Close ─────────────────────────────────────

// Section labels (Persian) for the header subtitle
const _adminSectionLabels = {
    'dashboard': 'داشبورد',
    'users': 'کاربران',
    'admins': 'مدیران',
    'tickets': 'تیکت‌ها',
    'broadcast': 'پیام همگانی',
    'rewards': 'پاداش‌ها',
    'transactions': 'تراکنش‌ها',
    'referrals': 'رفرال',
    'reward-center': 'مرکز پاداش',
    'notification-center': 'مرکز اعلانات',
    'alert-economy': 'اقتصاد هشدارها',
    'system-controls': 'کنترل سیستم',
    'system-health': 'سلامت سیستم',
    'logs': 'لاگ‌ها',
};

function openAdminPanel() {
    const panel = document.getElementById('admin-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    _adminPanelOpen = true;
    document.body.style.overflow = 'hidden';
    // Update admin sidebar user info
    _updateAdminSidebarUser();
    // Load dashboard by default
    if (_currentAdminSection === 'dashboard') {
        loadAdminDashboard();
    } else {
        switchAdminSection(_currentAdminSection, null);
    }
    // On mobile, start with sidebar closed (content visible).
    // On desktop, sidebar is always visible via CSS.
    closeAdminSidebar();
}

function closeAdminPanel() {
    const panel = document.getElementById('admin-panel');
    if (!panel) return;
    panel.style.display = 'none';
    _adminPanelOpen = false;
    document.body.style.overflow = '';
    closeAdminSidebar();
}

// ─── Sidebar Toggle (hamburger menu) ────────────────────────

function toggleAdminSidebar() {
    const sidebar = document.getElementById('adm-sidebar');
    const backdrop = document.getElementById('adm-sidebar-backdrop');
    if (!sidebar) return;
    const isOpen = sidebar.classList.contains('open');
    if (isOpen) {
        closeAdminSidebar();
    } else {
        openAdminSidebar();
    }
}

function openAdminSidebar() {
    const sidebar = document.getElementById('adm-sidebar');
    const backdrop = document.getElementById('adm-sidebar-backdrop');
    if (sidebar) sidebar.classList.add('open');
    if (backdrop) backdrop.classList.add('open');
}

function closeAdminSidebar() {
    const sidebar = document.getElementById('adm-sidebar');
    const backdrop = document.getElementById('adm-sidebar-backdrop');
    if (sidebar) sidebar.classList.remove('open');
    if (backdrop) backdrop.classList.remove('open');
}

// ─── Update admin sidebar user info from current user ───────

function _updateAdminSidebarUser() {
    try {
        // Try to read from getTelegramUser() if available (defined in app.js)
        const tg = (typeof getTg === 'function') ? getTg() : null;
        const u = tg?.initDataUnsafe?.user || (typeof getTelegramUser === 'function' ? getTelegramUser() : null);
        const nameEl = document.querySelector('.adm-sidebar-username');
        const roleEl = document.querySelector('.adm-sidebar-userrole');
        const avatarEl = document.querySelector('.adm-sidebar-avatar');
        if (u) {
            const fullName = ((u.first_name || '') + ' ' + (u.last_name || '')).trim();
            if (nameEl) nameEl.textContent = fullName || 'مدیر';
            if (avatarEl) avatarEl.textContent = (u.first_name || 'A').charAt(0).toUpperCase();
        }
    } catch (e) { /* ignore */ }
}

function switchAdminSection(section, btn) {
    _currentAdminSection = section;

    // Update nav buttons (both new .adm-nav-item and legacy .admin-nav-item)
    const navItems = document.querySelectorAll('.adm-nav-item, .admin-nav-item');
    navItems.forEach(function (item) { item.classList.remove('active'); });
    if (btn) {
        btn.classList.add('active');
    } else {
        const target = document.querySelector('.adm-nav-item[data-admin-section="' + section + '"], .admin-nav-item[data-admin-section="' + section + '"]');
        if (target) target.classList.add('active');
    }

    // Update content sections (both .adm-section and legacy .admin-section)
    const sections = document.querySelectorAll('.adm-section, .admin-section');
    sections.forEach(function (s) { s.classList.remove('active'); });
    const activeSection = document.getElementById('admin-section-' + section);
    if (activeSection) activeSection.classList.add('active');

    // Update header subtitle label
    const labelEl = document.getElementById('adm-section-label');
    if (labelEl) labelEl.textContent = _adminSectionLabels[section] || section;

    // Scroll sidebar item into view
    if (btn && btn.scrollIntoView) {
        try { btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' }); } catch (e) {}
    }

    // On mobile, close sidebar after selection
    if (window.matchMedia && window.matchMedia('(max-width: 899px)').matches) {
        closeAdminSidebar();
    }

    // Load section data
    switch (section) {
        case 'dashboard': loadAdminDashboard(); break;
        case 'admins': loadAdminList(); break;
        case 'users': loadAdminUsers(1); break;
        case 'tickets': loadAdminTickets(1); break;
        case 'broadcast': loadAdminBroadcasts(); break;
        case 'rewards': loadAdminRewards(); break;
        case 'transactions': loadAdminTransactions(1); break;
        case 'referrals': loadAdminReferrals(); break;
        case 'reward-center': loadRewardCenterOverview(); break;
        case 'notification-center': loadNpOverview(); break;
        case 'alert-economy': loadAlertEconomyDashboard(); break;
        case 'system-controls': loadMaintenanceSettings(); break;
        case 'system-health': loadAdminSystemHealth(); break;
        case 'logs': loadAdminLogs(1); break;
    }

    // Scroll content to top
    const content = document.getElementById('admin-content');
    if (content) content.scrollTop = 0;
}

// ─── Maintenance Mode Admin Controls ─────────────────────────

async function loadMaintenanceSettings() {
    const statusEl = document.getElementById('adm-maint-status');
    try {
        const data = await apiFetch('/api/system/status');
        if (!data) throw new Error('No data');
        const maint = data.maintenance || {};
        const toggle = document.getElementById('adm-maint-toggle');
        const body = document.getElementById('adm-maint-body');
        const titleInput = document.getElementById('adm-maint-title-input');
        const descInput = document.getElementById('adm-maint-desc-input');
        const progressInput = document.getElementById('adm-maint-progress');
        const progressVal = document.getElementById('adm-progress-val');
        const progressFill = document.getElementById('adm-progress-fill');
        const statStatus = document.getElementById('adm-stat-maint-status');
        const statProgress = document.getElementById('adm-stat-maint-progress');
        const statUpdated = document.getElementById('adm-stat-maint-updated');

        if (toggle) toggle.checked = Boolean(maint.enabled);
        if (body) body.style.display = Boolean(maint.enabled) ? 'flex' : 'none';
        if (titleInput) titleInput.value = maint.title || '';
        if (descInput) descInput.value = maint.description || '';
        const pct = Math.max(0, Math.min(100, Number(maint.progress) || 0));
        if (progressInput) progressInput.value = pct;
        if (progressVal) progressVal.textContent = pct + '%';
        if (progressFill) progressFill.style.width = pct + '%';
        if (statStatus) {
            statStatus.textContent = maint.enabled ? 'فعال' : 'غیرفعال';
            statStatus.style.color = maint.enabled ? '#f7b950' : '#a8b2c5';
        }
        if (statProgress) statProgress.textContent = pct + '%';
        if (statUpdated) statUpdated.textContent = maint.updated_at ? adminFormatDate(maint.updated_at) : '—';
    } catch (e) {
        if (statusEl) {
            statusEl.className = 'adm-maint-status error';
            statusEl.textContent = 'خطا در بارگذاری وضعیت: ' + (e.message || 'نامشخص');
        }
        console.error('loadMaintenanceSettings:', e);
    }
}

function onMaintenanceToggleChange(checked) {
    const body = document.getElementById('adm-maint-body');
    if (body) body.style.display = checked ? 'flex' : 'none';
}

function onMaintenanceProgressChange(val) {
    const pct = Math.max(0, Math.min(100, Number(val) || 0));
    const valEl = document.getElementById('adm-progress-val');
    const fillEl = document.getElementById('adm-progress-fill');
    if (valEl) valEl.textContent = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';
}

async function saveMaintenanceSettings() {
    const statusEl = document.getElementById('adm-maint-status');
    const toggle = document.getElementById('adm-maint-toggle');
    const titleInput = document.getElementById('adm-maint-title-input');
    const descInput = document.getElementById('adm-maint-desc-input');
    const progressInput = document.getElementById('adm-maint-progress');

    const payload = {
        enabled: Boolean(toggle && toggle.checked),
        title: (titleInput && titleInput.value.trim()) || 'در حال ساخت آینده‌ای بهتر!',
        description: (descInput && descInput.value.trim()) || 'در حال ارتقاء سیستم‌ها و اضافه کردن قابلیت‌های جدید هستیم. به‌زودی با تجربه‌ای فوق‌العاده بازمی‌گردیم.',
        progress: Math.max(0, Math.min(100, Number(progressInput && progressInput.value) || 0)),
    };

    try {
        const data = await apiFetch('/api/admin/maintenance', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });

        // CRITICAL FIX: Use the response data to update the UI immediately,
        // rather than re-fetching from /api/system/status which might return
        // stale data if KV write failed but in-memory fallback is active.
        if (data && data.maintenance) {
            const m = data.maintenance;
            // Update the form to reflect the saved state
            if (toggle) toggle.checked = Boolean(m.enabled);
            const body = document.getElementById('adm-maint-body');
            if (body) body.style.display = Boolean(m.enabled) ? 'flex' : 'none';
            const statStatus = document.getElementById('adm-stat-maint-status');
            if (statStatus) {
                statStatus.textContent = m.enabled ? 'فعال' : 'غیرفعال';
                statStatus.style.color = m.enabled ? '#f7b950' : '#a8b2c5';
            }
            const statProgress = document.getElementById('adm-stat-maint-progress');
            if (statProgress) statProgress.textContent = (m.progress || 0) + '%';
            const statUpdated = document.getElementById('adm-stat-maint-updated');
            if (statUpdated) statUpdated.textContent = m.updated_at ? adminFormatDate(m.updated_at) : '—';
        }

        if (statusEl) {
            statusEl.className = 'adm-maint-status success';
            if (data && data.warning) {
                statusEl.textContent = '⚠ تنظیمات ذخیره شد (حافظه موقت) — ' + data.warning;
            } else {
                statusEl.textContent = '✓ تنظیمات با موفقیت ذخیره شد';
            }
        }
        showAdminToast(data && data.warning ? 'ذخیره شد (حافظه موقت)' : 'تنظیمات نگهداری ذخیره شد', 'success');

        // Reload to confirm state persisted (but the UI already shows the correct state)
        loadMaintenanceSettings();
    } catch (e) {
        if (statusEl) {
            statusEl.className = 'adm-maint-status error';
            statusEl.textContent = '✗ خطا در ذخیره: ' + (e.message || 'نامشخص');
        }
        showAdminToast('خطا در ذخیره تنظیمات', 'error');
        console.error('saveMaintenanceSettings:', e);
    }
}

/**
 * Quick Maintenance Presets — one-click scenarios for common maintenance situations.
 * Each preset fills the form fields with appropriate values + saves automatically.
 * @param {string} presetKey - 'deploy'|'upgrade'|'database'|'emergency'|'end'
 */
const MAINT_PRESETS = {
    deploy: {
        enabled: true,
        title: 'در حال استقرار نسخه جدید',
        description: 'در حال انتشار نسخه جدید اپلیکیشن با قابلیت‌های بهتر هستیم. به‌زودی بازمی‌گردیم!',
        progress: 25,
    },
    upgrade: {
        enabled: true,
        title: 'ارتقای سیستم در حال انجام است',
        description: 'در حال ارتقاء زیرساخت و بهبود عملکرد سیستم هستیم. چند دقیقه دیگر بازمی‌گردیم.',
        progress: 50,
    },
    database: {
        enabled: true,
        title: 'مهاجرت دیتابیس',
        description: 'در حال مهاجرت دیتابیس برای بهبود سرعت و پایداری هستیم. این عملیات کمی طول می‌کشد.',
        progress: 75,
    },
    emergency: {
        enabled: true,
        title: 'اصلاح فوری سیستم',
        description: 'متأسفیم! یک مشکل فوری شناسایی کردیم که در حال رفع آن هستیم. به‌زودی بازمی‌گردیم.',
        progress: 10,
    },
    end: {
        enabled: false,
        title: 'در حال ساخت آینده‌ای بهتر!',
        description: 'در حال ارتقاء سیستم‌ها و اضافه کردن قابلیت‌های جدید هستیم. به‌زودی با تجربه‌ای فوق‌العاده بازمی‌گردیم.',
        progress: 100,
    },
};

async function applyMaintenancePreset(presetKey) {
    const preset = MAINT_PRESETS[presetKey];
    if (!preset) {
        showAdminToast('سناریو نامشخص', 'error');
        return;
    }

    // Confirm before enabling maintenance (not for 'end' preset)
    if (preset.enabled) {
        const confirmed = confirm(
            '⚠️ فعال‌سازی حالت نگهداری؟\n\n' +
            'تمام کاربران عادی قفل خواهند شد و فقط ادمین‌ها می‌توانند وارد شوند.\n\n' +
            'سناریو: ' + preset.title
        );
        if (!confirmed) return;
    } else {
        const confirmed = confirm('✓ پایان حالت نگهداری؟\n\nکاربران دوباره می‌توانند وارد شوند.');
        if (!confirmed) return;
    }

    // Fill form fields
    const toggle = document.getElementById('adm-maint-toggle');
    const titleInput = document.getElementById('adm-maint-title-input');
    const descInput = document.getElementById('adm-maint-desc-input');
    const progressInput = document.getElementById('adm-maint-progress');
    const body = document.getElementById('adm-maint-body');

    if (toggle) toggle.checked = preset.enabled;
    if (titleInput) titleInput.value = preset.title;
    if (descInput) descInput.value = preset.description;
    if (progressInput) progressInput.value = preset.progress;
    if (body) body.style.display = preset.enabled ? 'flex' : 'none';

    // Update progress display
    onMaintenanceProgressChange(preset.progress);

    // Save automatically
    await saveMaintenanceSettings();

    // Reload dashboard banner to reflect new state
    if (typeof loadDashboardMaintenanceBanner === 'function') {
        loadDashboardMaintenanceBanner();
    }
}

// ─── Dashboard ──────────────────────────────────────────────

async function loadAdminDashboard() {
    const grid = document.getElementById('admin-stats-grid');
    const activityList = document.getElementById('admin-activity-list');
    if (!grid) return;

    // Load maintenance status banner (independent of dashboard API)
    loadDashboardMaintenanceBanner();

    grid.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (activityList) activityList.innerHTML = '';

    try {
        const data = await apiFetch('/api/admin/dashboard');
        if (!data) throw new Error('No data');

        // Stats — use enhanced v2 cards with icons + colors
        let statsHtml = '';
        if (data.stats) {
            const s = data.stats;
            if (s.total_users != null) statsHtml += adminStatCardV2(adminFormatNumber(s.total_users), 'کل کاربران', 'users', 'blue');
            if (s.active_today != null) statsHtml += adminStatCardV2(adminFormatNumber(s.active_today), 'فعال امروز', 'active', 'green');
            if (s.new_users_today != null) statsHtml += adminStatCardV2(adminFormatNumber(s.new_users_today), 'کاربران جدید', 'new', 'purple');
            if (s.total_tickets != null) statsHtml += adminStatCardV2(adminFormatNumber(s.total_tickets), 'کل تیکت‌ها', 'tickets', 'gray');
            if (s.open_tickets != null) statsHtml += adminStatCardV2(adminFormatNumber(s.open_tickets), 'تیکت‌های باز', 'open', 'red');
            if (s.total_transactions != null) statsHtml += adminStatCardV2(adminFormatNumber(s.total_transactions), 'تراکنش‌ها', 'tx', 'orange');
            if (s.total_rewards != null) statsHtml += adminStatCardV2(adminFormatNumber(s.total_rewards), 'پاداش‌ها', 'rewards', 'orange');
            if (s.admins_count != null) statsHtml += adminStatCardV2(adminFormatNumber(s.admins_count), 'مدیران', 'admins', 'purple');
        }
        grid.innerHTML = statsHtml || adminEmpty('آماری موجود نیست');

        // Activity
        if (activityList && data.recent_activity) {
            if (data.recent_activity.length === 0) {
                activityList.innerHTML = adminEmpty('فعالیتی اخیر وجود ندارد');
            } else {
                let actHtml = '';
                data.recent_activity.forEach(function (act) {
                    const dotColor = act.type === 'admin' ? 'orange' :
                        act.type === 'error' ? 'red' :
                            act.type === 'user' ? 'blue' : 'green';
                    actHtml += '<div class="admin-activity-item">' +
                        '<div class="admin-activity-dot ' + dotColor + '"></div>' +
                        '<div style="flex:1;min-width:0;">' + adminEscapeHtml(act.message || act.description || act.action || '') + '</div>' +
                        '<div class="admin-activity-time">' + adminFormatDate(act.created_at || act.timestamp || act.date) + '</div>' +
                        '</div>';
                });
                activityList.innerHTML = actHtml;
            }
        }
    } catch (e) {
        grid.innerHTML = adminEmpty('بارگذاری داشبورد ناموفق بود');
        console.error('loadAdminDashboard:', e);
    }
}

/**
 * Load maintenance status into the dashboard banner.
 * This is independent of the main dashboard API so the banner always works
 * even if /api/admin/dashboard fails.
 */
async function loadDashboardMaintenanceBanner() {
    const banner = document.getElementById('adm-maint-banner');
    const titleEl = document.getElementById('adm-maint-banner-title');
    const subEl = document.getElementById('adm-maint-banner-sub');
    if (!banner) return;

    try {
        const data = await apiFetch('/api/system/status');
        if (!data || !data.maintenance) {
            titleEl.textContent = 'وضعیت نگهداری: غیرفعال';
            subEl.textContent = 'سیستم در حالت عادی';
            banner.classList.remove('is-active');
            return;
        }
        const m = data.maintenance;
        if (m.enabled) {
            titleEl.textContent = 'وضعیت نگهداری: فعال ⚠';
            const pct = Math.max(0, Math.min(100, Number(m.progress) || 0));
            subEl.textContent = 'پیشرفت: ' + pct + '% — کاربران قفل شده‌اند';
            banner.classList.add('is-active');
        } else {
            titleEl.textContent = 'وضعیت نگهداری: غیرفعال ✓';
            subEl.textContent = 'سیستم در حالت عادی';
            banner.classList.remove('is-active');
        }
    } catch (e) {
        titleEl.textContent = 'وضعیت نگهداری: نامشخص';
        subEl.textContent = 'خطا در دریافت وضعیت';
        banner.classList.remove('is-active');
    }
}

// ─── Admin Management ───────────────────────────────────────

async function loadAdminList() {
    const container = document.getElementById('admin-list');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';

    try {
        const data = await apiFetch('/api/admin/admins');
        if (!data || !Array.isArray(data.admins) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No admins found');
            return;
        }

        const admins = Array.isArray(data.admins) ? data.admins : (Array.isArray(data) ? data : []);
        if (admins.length === 0) {
            container.innerHTML = adminEmpty('No admins found');
            return;
        }

        let html = '';
        admins.forEach(function (admin) {
            const isActive = admin.active !== false && admin.is_active !== false;
            const role = admin.role || 'admin';
            const perms = admin.permissions || [];
            const permBadges = perms.map(function (p) {
                return adminBadge(p, 'blue');
            }).join(' ');

            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(admin.name || admin.username || 'Admin') +
                ' <span style="color:var(--text-sub);font-weight:400;font-size:12px;">ID: ' + adminEscapeHtml(String(admin.telegram_id || admin.id || '')) + '</span></span>' +
                adminBadge(role, role === 'super' ? 'red' : role === 'admin' ? 'orange' : 'gray') +
                (isActive ? adminBadge('Active', 'green') : adminBadge('Inactive', 'red')) +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'Role: ' + adminEscapeHtml(role) +
                (admin.last_active ? ' &bull; Last active: ' + adminFormatDate(admin.last_active) : '') +
                (admin.created_at ? ' &bull; Added: ' + adminFormatDate(admin.created_at) : '') +
                '</div>' +
                (perms.length > 0 ? '<div style="margin-top:6px;display:flex;flex-wrap:wrap;gap:4px;">' + permBadges + '</div>' : '') +
                '<div style="margin-top:8px;display:flex;gap:6px;">' +
                '<button class="admin-btn admin-btn-sm admin-btn-' + (isActive ? 'ghost' : 'green') +
                '" onclick="toggleAdminActive(\'' + (admin.id || '') + '\', ' + isActive + ')">' +
                (isActive ? 'Deactivate' : 'Activate') + '</button>' +
                (role !== 'super' ? '<button class="admin-btn admin-btn-sm admin-btn-red" onclick="removeAdmin(\'' + (admin.id || '') + '\', \'' + (admin.telegram_id || '') + '\')">Remove</button>' : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load admins');
        console.error('loadAdminList:', e);
    }
}

function openAddAdminForm() {
    const form = document.getElementById('admin-add-form');
    if (form) form.style.display = 'flex';
}

function closeAddAdminForm() {
    const form = document.getElementById('admin-add-form');
    if (form) form.style.display = 'none';
}

async function submitAddAdmin() {
    const telegramId = document.getElementById('admin-new-telegram-id');
    const role = document.getElementById('admin-new-role');
    const permChecks = document.querySelectorAll('#admin-new-permissions input[type="checkbox"]');

    if (!telegramId || !telegramId.value.trim()) {
        showAdminToast('Please enter a Telegram ID', 'error');
        return;
    }

    const permissions = [];
    permChecks.forEach(function (cb) {
        if (cb.checked) permissions.push(cb.value);
    });

    try {
        await apiFetch('/api/admin/admins', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({
                telegram_id: telegramId.value.trim(),
                role: role ? role.value : 'admin',
                permissions: permissions
            })
        });
        showAdminToast('Admin added successfully', 'success');
        closeAddAdminForm();
        if (telegramId) telegramId.value = '';
        permChecks.forEach(function (cb) { cb.checked = false; });
        loadAdminList();
    } catch (e) {
        showAdminToast('Failed to add admin: ' + (e.message || 'Unknown error'), 'error');
        console.error('submitAddAdmin:', e);
    }
}

async function toggleAdminActive(id, currentActive) {
    try {
        await apiFetch('/api/admin/admins/' + id, {
            method: 'PUT',
            body: JSON.stringify({ active: !currentActive })
        });
        showAdminToast('Admin status updated', 'success');
        loadAdminList();
    } catch (e) {
        showAdminToast('Failed to update status', 'error');
        console.error('toggleAdminActive:', e);
    }
}

function removeAdmin(id, telegramId) {
    if (!confirm('Remove this admin? This action cannot be undone.')) return;
    apiFetch('/api/admin/admins/' + id, { method: 'DELETE' })
        .then(function () {
            showAdminToast('Admin removed', 'success');
            loadAdminList();
        })
        .catch(function (e) {
            showAdminToast('Failed to remove admin', 'error');
            console.error('removeAdmin:', e);
        });
}

// ─── Users ──────────────────────────────────────────────────

async function loadAdminUsers(page) {
    const container = document.getElementById('admin-users-list');
    const paginationEl = document.getElementById('admin-users-pagination');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (paginationEl) paginationEl.innerHTML = '';
    _adminUsersPage = page || 1;

    const searchInput = document.getElementById('admin-user-search');
    const search = searchInput ? searchInput.value.trim() : '';

    try {
        let url = '/api/admin/users?page=' + _adminUsersPage;
        if (search) url += '&search=' + encodeURIComponent(search);
        const data = await apiFetch(url);

        if (!data || !Array.isArray(data.users) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No users found');
            return;
        }

        const users = Array.isArray(data.users) ? data.users : (Array.isArray(data) ? data : []);
        const totalPages = data.total_pages || Math.ceil((data.total || users.length) / 20) || 1;

        if (users.length === 0) {
            container.innerHTML = adminEmpty('No users found');
            return;
        }

        let html = '';
        users.forEach(function (u) {
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(u.first_name || u.name || 'User') +
                (u.last_name ? ' ' + adminEscapeHtml(u.last_name) : '') + '</span>' +
                (u.is_premium ? adminBadge('Premium', 'orange') : '') +
                (u.is_active ? adminBadge('Active', 'green') : adminBadge('Inactive', 'gray')) +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                (u.username ? '@' + adminEscapeHtml(u.username) + ' &bull; ' : '') +
                'ID: ' + adminEscapeHtml(String(u.telegram_id || u.id || '')) +
                (u.language ? ' &bull; Lang: ' + adminEscapeHtml(u.language) : '') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'Joined: ' + adminFormatDate(u.created_at || u.join_date) +
                (u.last_active ? ' &bull; Last seen: ' + adminFormatDate(u.last_active) : '') +
                (u.referral_code ? ' &bull; Ref: ' + adminEscapeHtml(u.referral_code) : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-users-pagination', _adminUsersPage, totalPages, 'loadAdminUsers');
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load users');
        console.error('loadAdminUsers:', e);
    }
}

function debounceAdminUserSearch() {
    if (_adminUserSearchTimeout) clearTimeout(_adminUserSearchTimeout);
    _adminUserSearchTimeout = setTimeout(function () {
        loadAdminUsers(1);
    }, 400);
}

// ─── Tickets ────────────────────────────────────────────────

let _adminTicketsExpanded = {}; // ticket IDs that are expanded to show detail + reply form

async function loadAdminTickets(page) {
    const container = document.getElementById('admin-tickets-list');
    const paginationEl = document.getElementById('admin-tickets-pagination');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (paginationEl) paginationEl.innerHTML = '';
    _adminTicketsPage = page || 1;

    try {
        let url = '/api/admin/tickets?page=' + _adminTicketsPage;
        if (_adminTicketsFilter && _adminTicketsFilter !== 'all') {
            url += '&status=' + _adminTicketsFilter;
        }
        const data = await apiFetch(url);

        if (!data || !Array.isArray(data.tickets) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No tickets found');
            return;
        }

        const tickets = Array.isArray(data.tickets) ? data.tickets : (Array.isArray(data) ? data : []);
        const totalPages = data.total_pages || Math.ceil((data.total || tickets.length) / 20) || 1;

        if (tickets.length === 0) {
            container.innerHTML = adminEmpty('No tickets found');
            return;
        }

        let html = '';
        tickets.forEach(function (t) {
            const statusBadge = t.status === 'open' ? adminBadge('Open', 'red') :
                t.status === 'answered' ? adminBadge('Answered', 'orange') :
                    t.status === 'closed' ? adminBadge('Closed', 'gray') :
                        adminBadge(String(t.status || ''), 'gray');
            const isExpanded = !!_adminTicketsExpanded[t.id];
            const replies = (t.replies && t.replies.length) ? t.replies : [];

            html += '<div class="admin-list-item admin-ticket-item" id="adm-ticket-' + t.id + '">' +
                '<div class="admin-list-item-header" style="cursor:pointer" onclick="toggleAdminTicketDetail(\'' + t.id + '\')">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(t.subject || t.title || 'Ticket #' + (t.id || '')) + '</span>' +
                statusBadge +
                '<span class="admin-list-item-arrow" style="margin-left:auto;color:#6B7A8D">›</span>' +
                '</div>' +
                '<div class="admin-list-item-meta">From: ' + adminEscapeHtml(t.user_name || t.username || 'User') +
                ' (ID: ' + adminEscapeHtml(String(t.telegram_id || t.user_id || '')) + ')</div>' +
                '<div class="admin-list-item-meta" style="margin-top:4px;white-space:pre-wrap;overflow:hidden;max-height:60px;">' +
                adminEscapeHtml(t.message || t.last_message || '') +
                '</div>' +
                '<div class="admin-list-item-meta" style="margin-top:4px;">' +
                adminFormatDate(t.created_at || t.date) +
                (t.updated_at ? ' &bull; Updated: ' + adminFormatDate(t.updated_at) : '') +
                '</div>';

            // Expanded detail: conversation history + reply form + status controls
            if (isExpanded) {
                html += '<div class="adm-ticket-detail" style="margin-top:12px;padding-top:12px;border-top:1px solid rgba(255,255,255,0.06);">';

                // Conversation thread
                if (replies.length) {
                    html += '<div class="adm-ticket-thread" style="display:flex;flex-direction:column;gap:8px;margin-bottom:12px;">';
                    // Original message
                    html += '<div style="background:rgba(255,255,255,0.03);border-radius:10px;padding:10px 12px;">' +
                        '<div style="font-size:11px;color:#6B7A8D;margin-bottom:4px;">' + adminEscapeHtml(t.user_name || 'User') + ' • ' + adminFormatDate(t.created_at) + '</div>' +
                        '<div style="white-space:pre-wrap;font-size:13px;color:#A5B4C7;">' + adminEscapeHtml(t.message || t.body || '') + '</div>' +
                        '</div>';
                    // Replies
                    replies.forEach(function (r) {
                        var isAdmin = r.from === 'admin' || r.is_admin;
                        html += '<div style="background:' + (isAdmin ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.03)') + ';border-radius:10px;padding:10px 12px;' + (isAdmin ? 'border:1px solid rgba(245,166,35,0.15);' : '') + '">' +
                            '<div style="font-size:11px;color:' + (isAdmin ? '#F5A623' : '#6B7A8D') + ';margin-bottom:4px;">' + (isAdmin ? 'Admin' : adminEscapeHtml(t.user_name || 'User')) + ' • ' + adminFormatDate(r.at || r.created_at) + '</div>' +
                            '<div style="white-space:pre-wrap;font-size:13px;color:#A5B4C7;">' + adminEscapeHtml(r.message || r.text || '') + '</div>' +
                            '</div>';
                    });
                    html += '</div>';
                }

                // Reply form
                html += '<div style="margin-bottom:10px;">' +
                    '<textarea id="adm-reply-' + t.id + '" class="adm-input" placeholder="Type a reply..." style="width:100%;min-height:70px;font-size:13px;padding:10px 12px;border-radius:10px;background:rgba(0,0,0,0.3);border:1px solid rgba(255,255,255,0.08);color:#fff;font-family:inherit;resize:vertical;box-sizing:border-area;"></textarea>' +
                    '<button class="admin-btn admin-btn-gold" style="margin-top:6px;padding:8px 18px;font-size:12px;" onclick="adminReplyTicket(\'' + t.id + '\')">Send Reply</button>' +
                    '</div>';

                // Status controls
                html += '<div style="display:flex;flex-wrap:wrap;gap:6px;margin-top:8px;">';
                if (t.status !== 'closed') {
                    html += '<button class="admin-btn" style="padding:6px 14px;font-size:11px;" onclick="adminSetTicketStatus(\'' + t.id + '\',\'closed\')">Close</button>';
                }
                if (t.status !== 'open') {
                    html += '<button class="admin-btn" style="padding:6px 14px;font-size:11px;" onclick="adminSetTicketStatus(\'' + t.id + '\',\'open\')">Reopen</button>';
                }
                if (t.status !== 'answered') {
                    html += '<button class="admin-btn" style="padding:6px 14px;font-size:11px;" onclick="adminSetTicketStatus(\'' + t.id + '\',\'answered\')">Mark Answered</button>';
                }
                html += '<button class="admin-btn admin-btn-danger" style="padding:6px 14px;font-size:11px;" onclick="adminDeleteTicket(\'' + t.id + '\')">Delete</button>';
                html += '</div>';

                html += '</div>';
            }

            html += '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-tickets-pagination', _adminTicketsPage, totalPages, 'loadAdminTickets');
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load tickets');
        console.error('loadAdminTickets:', e);
    }
}

function toggleAdminTicketDetail(ticketId) {
    _adminTicketsExpanded[ticketId] = !_adminTicketsExpanded[ticketId];
    loadAdminTickets(_adminTicketsPage);
}

async function adminReplyTicket(ticketId) {
    var textarea = document.getElementById('adm-reply-' + ticketId);
    if (!textarea) return;
    var message = textarea.value.trim();
    if (!message) { showAdminToast('Reply cannot be empty', 'error'); return; }
    if (message.length > 1500) { showAdminToast('Reply too long (max 1500 chars)', 'error'); return; }
    try {
        await apiFetch('/api/admin/tickets/' + ticketId + '/reply', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ message: message })
        });
        showAdminToast('Reply sent', 'success');
        _adminTicketsExpanded[ticketId] = true;
        loadAdminTickets(_adminTicketsPage);
    } catch (e) {
        showAdminToast('Failed to send reply', 'error');
        console.error('adminReplyTicket:', e);
    }
}

async function adminSetTicketStatus(ticketId, status) {
    try {
        await apiFetch('/api/admin/tickets/' + ticketId + '/status', {
            method: 'PUT',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify({ status: status })
        });
        showAdminToast('Status updated to ' + status, 'success');
        _adminTicketsExpanded[ticketId] = true;
        loadAdminTickets(_adminTicketsPage);
    } catch (e) {
        showAdminToast('Failed to update status', 'error');
        console.error('adminSetTicketStatus:', e);
    }
}

async function adminDeleteTicket(ticketId) {
    if (!confirm('Delete this ticket permanently?')) return;
    try {
        await apiFetch('/api/tickets/' + ticketId, { method: 'DELETE' });
        showAdminToast('Ticket deleted', 'success');
        delete _adminTicketsExpanded[ticketId];
        loadAdminTickets(_adminTicketsPage);
    } catch (e) {
        showAdminToast('Failed to delete ticket', 'error');
        console.error('adminDeleteTicket:', e);
    }
}

function filterAdminTickets(status, btn) {
    _adminTicketsFilter = status;
    // Update active filter button
    const parent = btn ? btn.parentElement : null;
    if (parent) {
        parent.querySelectorAll('.admin-filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
    }
    loadAdminTickets(1);
}

// ─── Broadcast ──────────────────────────────────────────────

function toggleBroadcastTargetId() {
    const select = document.getElementById('admin-broadcast-target');
    const input = document.getElementById('admin-broadcast-target-id');
    if (!select || !input) return;
    input.style.display = select.value === 'specific' ? 'block' : 'none';
}

async function sendBroadcast() {
    const targetSelect = document.getElementById('admin-broadcast-target');
    const targetIdInput = document.getElementById('admin-broadcast-target-id');
    const contentInput = document.getElementById('admin-broadcast-content');

    if (!contentInput || !contentInput.value.trim()) {
        showAdminToast('Please enter a message', 'error');
        return;
    }

    const payload = {
        target: targetSelect ? targetSelect.value : 'all',
        content: contentInput.value.trim()
    };

    if (payload.target === 'specific') {
        if (!targetIdInput || !targetIdInput.value.trim()) {
            showAdminToast('Please enter a Telegram ID', 'error');
            return;
        }
        payload.telegram_id = targetIdInput.value.trim();
    }

    try {
        await apiFetch('/api/admin/broadcasts', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json' },
            body: JSON.stringify(payload)
        });
        showAdminToast('Broadcast sent successfully', 'success');
        if (contentInput) contentInput.value = '';
        if (targetIdInput) targetIdInput.value = '';
        loadAdminBroadcasts();
    } catch (e) {
        showAdminToast('Failed to send broadcast', 'error');
        console.error('sendBroadcast:', e);
    }
}

async function loadAdminBroadcasts() {
    const container = document.getElementById('admin-broadcasts-list');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';

    try {
        const data = await apiFetch('/api/admin/broadcasts');
        if (!data || !Array.isArray(data.broadcasts) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No broadcasts yet');
            return;
        }

        const broadcasts = Array.isArray(data.broadcasts) ? data.broadcasts : (Array.isArray(data) ? data : []);

        if (broadcasts.length === 0) {
            container.innerHTML = adminEmpty('No broadcasts yet');
            return;
        }

        let html = '';
        broadcasts.forEach(function (b) {
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(b.content || b.message || '').substring(0, 60) +
                (String(b.content || b.message || '').length > 60 ? '...' : '') + '</span>' +
                adminBadge(b.target || 'all', 'blue') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'Sent by: ' + adminEscapeHtml(b.sent_by || b.admin_name || 'Admin') +
                (b.recipients != null ? ' &bull; Recipients: ' + adminFormatNumber(b.recipients) : '') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                adminFormatDate(b.created_at || b.sent_at || b.date) +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load broadcasts');
        console.error('loadAdminBroadcasts:', e);
    }
}

// ─── Rewards ────────────────────────────────────────────────

async function loadAdminRewards() {
    const container = document.getElementById('admin-rewards-list');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';

    try {
        let url = '/api/admin/rewards';
        if (_adminRewardsFilter && _adminRewardsFilter !== 'all') {
            url += '?status=' + _adminRewardsFilter;
        }
        const data = await apiFetch(url);

        if (!data || !Array.isArray(data.rewards) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No rewards found');
            return;
        }

        const rewards = Array.isArray(data.rewards) ? data.rewards : (Array.isArray(data) ? data : []);

        if (rewards.length === 0) {
            container.innerHTML = adminEmpty('No rewards found');
            return;
        }

        let html = '';
        rewards.forEach(function (r) {
            const statusBadge = r.status === 'pending' ? adminBadge('Pending', 'orange') :
                r.status === 'approved' ? adminBadge('Approved', 'blue') :
                    r.status === 'delivered' ? adminBadge('Delivered', 'green') :
                        r.status === 'rejected' ? adminBadge('Rejected', 'red') :
                            adminBadge(String(r.status || ''), 'gray');

            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(r.type || r.reward_type || 'Reward') + '</span>' +
                statusBadge +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'User: ' + adminEscapeHtml(r.user_name || r.username || 'User') +
                ' (ID: ' + adminEscapeHtml(String(r.telegram_id || r.user_id || '')) + ')' +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'Amount: ' + adminEscapeHtml(String(r.amount || r.tokens || '')) + ' AB' +
                (r.tx_hash ? ' &bull; TX: ' + adminEscapeHtml(String(r.tx_hash).substring(0, 16)) + '...' : '') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                adminFormatDate(r.created_at || r.date) +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load rewards');
        console.error('loadAdminRewards:', e);
    }
}

function filterAdminRewards(status, btn) {
    _adminRewardsFilter = status;
    const parent = btn ? btn.parentElement : null;
    if (parent) {
        parent.querySelectorAll('.admin-filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
    }
    loadAdminRewards();
}

// ─── Transactions ───────────────────────────────────────────

async function loadAdminTransactions(page) {
    const container = document.getElementById('admin-transactions-list');
    const paginationEl = document.getElementById('admin-transactions-pagination');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (paginationEl) paginationEl.innerHTML = '';
    _adminTransactionsPage = page || 1;

    const userIdInput = document.getElementById('admin-tx-user-id');
    const typeSelect = document.getElementById('admin-tx-type');
    const userId = userIdInput ? userIdInput.value.trim() : '';
    const txType = typeSelect ? typeSelect.value : '';

    try {
        let url = '/api/admin/transactions?page=' + _adminTransactionsPage;
        if (userId) url += '&user_id=' + encodeURIComponent(userId);
        if (txType) url += '&type=' + encodeURIComponent(txType);
        const data = await apiFetch(url);

        if (!data || !Array.isArray(data.transactions) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No transactions found');
            return;
        }

        const txs = Array.isArray(data.transactions) ? data.transactions : (Array.isArray(data) ? data : []);
        const totalPages = data.total_pages || Math.ceil((data.total || txs.length) / 20) || 1;

        if (txs.length === 0) {
            container.innerHTML = adminEmpty('No transactions found');
            return;
        }

        let html = '';
        txs.forEach(function (tx) {
            const typeLabel = {
                daily_claim: 'Daily Claim',
                referral: 'Referral',
                admin_grant: 'Admin Grant',
                wheel: 'Wheel',
                deposit: 'Deposit',
                withdrawal: 'Withdrawal'
            };
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(typeLabel[tx.type] || tx.type || 'Transaction') + '</span>' +
                adminBadge(String(tx.amount || tx.tokens || 0) + ' AB', 'green') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'User: ' + adminEscapeHtml(tx.user_name || tx.username || 'User') +
                ' (ID: ' + adminEscapeHtml(String(tx.telegram_id || tx.user_id || '')) + ')' +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                adminFormatDate(tx.created_at || tx.date) +
                (tx.tx_hash ? ' &bull; TX: ' + adminEscapeHtml(String(tx.tx_hash).substring(0, 16)) + '...' : '') +
                (tx.description ? ' &bull; ' + adminEscapeHtml(tx.description) : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-transactions-pagination', _adminTransactionsPage, totalPages, 'loadAdminTransactions');
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load transactions');
        console.error('loadAdminTransactions:', e);
    }
}

// ─── Referrals ──────────────────────────────────────────────

async function loadAdminReferrals() {
    const container = document.getElementById('admin-referrals-list');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';

    const searchInput = document.getElementById('admin-referral-search');
    const search = searchInput ? searchInput.value.trim() : '';

    try {
        let url = '/api/admin/referrals';
        if (search) url += '?search=' + encodeURIComponent(search);
        const data = await apiFetch(url);

        if (!data || !Array.isArray(data.referrals) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No referral data found');
            return;
        }

        const referrals = Array.isArray(data.referrals) ? data.referrals : (Array.isArray(data) ? data : []);

        if (referrals.length === 0) {
            container.innerHTML = adminEmpty('No referral data found');
            return;
        }

        let html = '';
        referrals.forEach(function (r) {
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(r.user_name || r.name || 'User') + '</span>' +
                adminBadge(String(r.total_referrals || r.referral_count || 0) + ' refs', 'blue') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'ID: ' + adminEscapeHtml(String(r.telegram_id || r.user_id || '')) +
                (r.username ? ' &bull; @' + adminEscapeHtml(r.username) : '') +
                (r.referral_code ? ' &bull; Code: ' + adminEscapeHtml(r.referral_code) : '') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'Total: ' + adminFormatNumber(r.total_referrals || r.referral_count || 0) +
                (r.active_referrals != null ? ' &bull; Active: ' + adminFormatNumber(r.active_referrals) : '') +
                (r.earned_tokens != null ? ' &bull; Earned: ' + adminFormatNumber(r.earned_tokens) + ' AB' : '') +
                (r.reward_pending != null ? ' &bull; Pending: ' + adminFormatNumber(r.reward_pending) + ' AB' : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load referrals');
        console.error('loadAdminReferrals:', e);
    }
}

function debounceAdminReferralSearch() {
    if (_adminReferralSearchTimeout) clearTimeout(_adminReferralSearchTimeout);
    _adminReferralSearchTimeout = setTimeout(function () {
        loadAdminReferrals();
    }, 400);
}

// ─── System Health ──────────────────────────────────────────

async function loadAdminSystemHealth() {
    const grid = document.getElementById('admin-health-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="admin-empty">Loading...</div>';

    try {
        const data = await apiFetch('/api/admin/system-health');
        if (!data) throw new Error('No data');

        let html = '';
        if (data.stats) {
            const s = data.stats;
            if (s.uptime != null) html += adminStatCard(s.uptime, 'Uptime');
            if (s.requests_today != null) html += adminStatCard(adminFormatNumber(s.requests_today), 'Requests Today');
            if (s.avg_response_time != null) html += adminStatCard(s.avg_response_time + 'ms', 'Avg Response');
            if (s.error_rate != null) html += adminStatCard(s.error_rate + '%', 'Error Rate');
            if (s.memory_usage != null) html += adminStatCard(s.memory_usage, 'Memory Usage');
            if (s.cpu_usage != null) html += adminStatCard(s.cpu_usage + '%', 'CPU Usage');
            if (s.db_size != null) html += adminStatCard(s.db_size, 'DB Size');
            if (s.cache_hit_rate != null) html += adminStatCard(s.cache_hit_rate + '%', 'Cache Hit');
            if (s.active_connections != null) html += adminStatCard(adminFormatNumber(s.active_connections), 'Active Conn');
            if (s.total_requests != null) html += adminStatCard(adminFormatNumber(s.total_requests), 'Total Requests');
        }

        // Also render any status checks
        if (data.services) {
            Object.keys(data.services).forEach(function (key) {
                const svc = data.services[key];
                const statusColor = svc.status === 'healthy' || svc.healthy === true ? 'green' : 'red';
                html += adminStatCard(
                    (svc.status === 'healthy' || svc.healthy === true) ? 'OK' : 'DOWN',
                    (svc.name || key)
                );
            });
        }

        grid.innerHTML = html || adminEmpty('No health data available');
    } catch (e) {
        grid.innerHTML = adminEmpty('Failed to load system health');
        console.error('loadAdminSystemHealth:', e);
    }
}

// ─── Security Logs ──────────────────────────────────────────

async function loadAdminLogs(page) {
    const container = document.getElementById('admin-logs-list');
    const paginationEl = document.getElementById('admin-logs-pagination');
    if (!container) return;
    container.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (paginationEl) paginationEl.innerHTML = '';
    _adminLogsPage = page || 1;

    try {
        const url = '/api/admin/logs?page=' + _adminLogsPage;
        const data = await apiFetch(url);

        if (!data || !Array.isArray(data.logs) && !Array.isArray(data)) {
            container.innerHTML = adminEmpty('No logs found');
            return;
        }

        const logs = Array.isArray(data.logs) ? data.logs : (Array.isArray(data) ? data : []);
        const totalPages = data.total_pages || Math.ceil((data.total || logs.length) / 20) || 1;

        if (logs.length === 0) {
            container.innerHTML = adminEmpty('No logs found');
            return;
        }

        let html = '';
        logs.forEach(function (log) {
            const levelColor = log.level === 'error' ? 'red' :
                log.level === 'warn' || log.level === 'warning' ? 'orange' :
                    log.level === 'info' ? 'blue' : 'green';

            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(log.action || log.event || log.type || 'Log Entry') + '</span>' +
                adminBadge(log.level || 'info', levelColor) +
                '</div>' +
                (log.message || log.description ?
                    '<div class="admin-list-item-meta" style="white-space:pre-wrap;overflow:hidden;max-height:60px;">' +
                    adminEscapeHtml(log.message || log.description) + '</div>' : '') +
                '<div class="admin-list-item-meta">' +
                adminFormatDate(log.created_at || log.timestamp || log.date) +
                (log.ip ? ' &bull; IP: ' + adminEscapeHtml(log.ip) : '') +
                (log.user_id || log.telegram_id ? ' &bull; User: ' + adminEscapeHtml(String(log.user_id || log.telegram_id)) : '') +
                (log.admin_name ? ' &bull; By: ' + adminEscapeHtml(log.admin_name) : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-logs-pagination', _adminLogsPage, totalPages, 'loadAdminLogs');
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load logs');
        console.error('loadAdminLogs:', e);
    }
}

// ─── Register all functions on window for inline onclick ────

window.openAdminPanel = openAdminPanel;
window.closeAdminPanel = closeAdminPanel;
window.switchAdminSection = switchAdminSection;
window.initAdminPanel = initAdminPanel;
window.toggleAdminSidebar = toggleAdminSidebar;
window.openAdminSidebar = openAdminSidebar;
window.closeAdminSidebar = closeAdminSidebar;
window.openAddAdminForm = openAddAdminForm;
window.closeAddAdminForm = closeAddAdminForm;
window.submitAddAdmin = submitAddAdmin;
window.toggleAdminActive = toggleAdminActive;
window.removeAdmin = removeAdmin;
window.debounceAdminUserSearch = debounceAdminUserSearch;
window.filterAdminTickets = filterAdminTickets;
window.toggleBroadcastTargetId = toggleBroadcastTargetId;
window.sendBroadcast = sendBroadcast;
window.filterAdminRewards = filterAdminRewards;
window.debounceAdminReferralSearch = debounceAdminReferralSearch;
window.loadAdminUsers = loadAdminUsers;
window.loadAdminTickets = loadAdminTickets;
window.loadAdminTransactions = loadAdminTransactions;
window.loadAdminLogs = loadAdminLogs;
// Maintenance Mode
window.loadMaintenanceSettings = loadMaintenanceSettings;
window.onMaintenanceToggleChange = onMaintenanceToggleChange;
window.onMaintenanceProgressChange = onMaintenanceProgressChange;
window.saveMaintenanceSettings = saveMaintenanceSettings;
window.applyMaintenancePreset = applyMaintenancePreset;
// ════════════════════════════════════════════════════════════════════
// REWARD CENTER — Full reward management system
// ════════════════════════════════════════════════════════════════════

let _rcCurrentTab = 'overview';
let _rcWheelConfig = null;
let _rcEmergencyControls = null;

function switchRewardCenterTab(tab, btn) {
    _rcCurrentTab = tab;
    // Update tab buttons
    document.querySelectorAll('.rc-tab').forEach(function (t) { t.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    else {
        const target = document.querySelector('.rc-tab[data-rc-tab="' + tab + '"]');
        if (target) target.classList.add('active');
    }
    // Update content visibility
    document.querySelectorAll('.rc-tab-content').forEach(function (c) { c.style.display = 'none'; });
    const activeContent = document.getElementById('rc-tab-' + tab);
    if (activeContent) activeContent.style.display = '';
    // Load tab data
    switch (tab) {
        case 'overview': loadRewardCenterOverview(); break;
        case 'wheel': loadRcWheelConfig(); loadRcWheelRewards(); break;
        case 'referral': loadRcReferralTiers(); break;
        case 'mission': loadRcMissionRewards(); break;
        case 'campaigns': loadRcCampaigns(); break;
        case 'library': loadRcLibrary(); break;
        case 'analytics': loadRcAnalytics(); break;
        case 'settings': loadRcSettings(); break;
    }
}
window.switchRewardCenterTab = switchRewardCenterTab;

// ─── Overview ───────────────────────────────────────────────

async function loadRewardCenterOverview() {
    const grid = document.getElementById('rc-overview-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/overview');
        if (data && data.status === 'success' && data.overview) {
            const o = data.overview;
            const statusColor = o.wheel_status === 'active' ? 'green' : (o.wheel_status === 'maintenance' ? 'orange' : 'red');
            const statusText = o.wheel_status === 'active' ? 'فعال' : (o.wheel_status === 'maintenance' ? 'تعمیرات' : 'غیرفعال');
            grid.innerHTML = `
                <div class="rc-stat-card"><div class="rc-stat-icon green">●</div><div class="rc-stat-val">${statusText}</div><div class="rc-stat-lbl">وضعیت گردونه</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.total_spins_today)}</div><div class="rc-stat-lbl">اسپین امروز</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.rewards_given_today)}</div><div class="rc-stat-lbl">پاداش امروز</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.total_ab_distributed)} AB</div><div class="rc-stat-lbl">توکن توزیع شده امروز</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.active_campaigns)}</div><div class="rc-stat-lbl">کمپین‌های فعال</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.active_wheel_rewards)}</div><div class="rc-stat-lbl">پاداش‌های فعال گردونه</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.active_referral_tiers)}</div><div class="rc-stat-lbl">طبقات رفرال فعال</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.active_missions)}</div><div class="rc-stat-lbl">ماموریت‌های فعال</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.pending_rewards)}</div><div class="rc-stat-lbl">پاداش‌های در انتظار</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${o.most_won_reward ? adminEscapeHtml(o.most_won_reward.label || '') : '--'}</div><div class="rc-stat-lbl">پرتکرارترین پاداش</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(o.highest_reward)} AB</div><div class="rc-stat-lbl">بزرگ‌ترین پاداش</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminEscapeHtml(o.wheel_version || '1.0.0')}</div><div class="rc-stat-lbl">نسخه گردونه</div></div>
            `;
        } else {
            grid.innerHTML = '<div class="admin-empty">داده‌ای موجود نیست</div>';
        }
    } catch (e) {
        grid.innerHTML = '<div class="admin-empty">خطا در بارگذاری</div>';
        console.error('loadRewardCenterOverview:', e);
    }
}

// ─── Wheel Config ───────────────────────────────────────────

async function loadRcWheelConfig() {
    const section = document.getElementById('rc-wheel-config-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/wheel/config');
        if (data && data.status === 'success' && data.config) {
            _rcWheelConfig = data.config;
            const c = data.config;
            section.innerHTML = `
                <div class="rc-card">
                    <h4 class="rc-card-title">تنظیمات عمومی گردونه</h4>
                    <div class="rc-form-grid">
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-enabled" ${c.is_enabled ? 'checked' : ''}><span>فعال‌سازی گردونه</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-daily" ${c.daily_spin_enabled ? 'checked' : ''}><span>اسپین روزانه</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-referral" ${c.referral_spin_enabled ? 'checked' : ''}><span>اسپین رفرال</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-mission" ${c.mission_spin_enabled ? 'checked' : ''}><span>اسپین ماموریت</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-premium" ${c.premium_spin_enabled ? 'checked' : ''}><span>اسپین ویژه</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-campaign" ${c.campaign_spin_enabled ? 'checked' : ''}><span>اسپین کمپین</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-wc-maintenance" ${c.maintenance_mode ? 'checked' : ''}><span>حالت تعمیرات</span></label>
                    </div>
                    <div class="rc-form-grid" style="margin-top:12px;">
                        <div class="rc-field"><label>تعداد بخش‌ها</label><select id="rc-wc-segments"><option value="6" ${c.segment_count==6?'selected':''}>۶</option><option value="8" ${c.segment_count==8?'selected':''}>۸</option><option value="10" ${c.segment_count==10?'selected':''}>۱۰</option><option value="12" ${c.segment_count==12?'selected':''}>۱۲</option><option value="16" ${c.segment_count==16?'selected':''}>۱۶</option></select></div>
                        <div class="rc-field"><label>نسخه</label><input type="text" id="rc-wc-version" value="${adminEscapeHtml(c.version||'1.0.0')}"></div>
                        <div class="rc-field"><label>تم</label><input type="text" id="rc-wc-theme" value="${adminEscapeHtml(c.theme||'default')}"></div>
                        <div class="rc-field"><label>حداکثر اسپین/کاربر</label><input type="number" id="rc-wc-maxspins" value="${c.max_spins_per_user||1}" min="1"></div>
                        <div class="rc-field"><label>کوپل‌داون (ثانیه)</label><input type="number" id="rc-wc-cooldown" value="${c.cooldown_seconds||0}" min="0"></div>
                        <div class="rc-field"><label>حداکثر پاداش/روز</label><input type="number" id="rc-wc-maxreward" value="${c.max_reward_per_day||1000}" min="0"></div>
                    </div>
                    <button class="adm-btn adm-btn-primary" onclick="saveRcWheelConfig()" style="margin-top:12px;">ذخیره تنظیمات</button>
                </div>
            `;
        } else {
            section.innerHTML = '<div class="admin-empty">خطا در بارگذاری تنظیمات</div>';
        }
    } catch (e) {
        section.innerHTML = '<div class="admin-empty">خطا در بارگذاری</div>';
        console.error('loadRcWheelConfig:', e);
    }
}
window.loadRcWheelConfig = loadRcWheelConfig;

async function saveRcWheelConfig() {
    const payload = {
        is_enabled: document.getElementById('rc-wc-enabled')?.checked,
        daily_spin_enabled: document.getElementById('rc-wc-daily')?.checked,
        referral_spin_enabled: document.getElementById('rc-wc-referral')?.checked,
        mission_spin_enabled: document.getElementById('rc-wc-mission')?.checked,
        premium_spin_enabled: document.getElementById('rc-wc-premium')?.checked,
        campaign_spin_enabled: document.getElementById('rc-wc-campaign')?.checked,
        maintenance_mode: document.getElementById('rc-wc-maintenance')?.checked,
        segment_count: Number(document.getElementById('rc-wc-segments')?.value || 8),
        version: document.getElementById('rc-wc-version')?.value,
        theme: document.getElementById('rc-wc-theme')?.value,
        max_spins_per_user: Number(document.getElementById('rc-wc-maxspins')?.value || 1),
        cooldown_seconds: Number(document.getElementById('rc-wc-cooldown')?.value || 0),
        max_reward_per_day: Number(document.getElementById('rc-wc-maxreward')?.value || 1000),
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/wheel/config', { method: 'PUT', body: JSON.stringify(payload) });
        if (data && data.status === 'success') {
            adminToast('تنظیمات ذخیره شد', 'success');
        } else {
            adminToast('خطا در ذخیره', 'error');
        }
    } catch (e) { adminToast('خطا در ذخیره', 'error'); console.error(e); }
}
window.saveRcWheelConfig = saveRcWheelConfig;

// ─── Wheel Rewards ──────────────────────────────────────────

async function loadRcWheelRewards() {
    const section = document.getElementById('rc-wheel-rewards-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/wheel/rewards');
        if (data && data.status === 'success' && Array.isArray(data.rewards)) {
            let rows = data.rewards.map(function (r) {
                return `<tr>
                    <td>${adminEscapeHtml(r.reward_label || r.reward_type)}</td>
                    <td>${adminEscapeHtml(r.reward_type)}</td>
                    <td>${adminFormatNumber(r.reward_amount)}</td>
                    <td>${adminFormatNumber(r.weight)}</td>
                    <td>${adminEscapeHtml(r.campaign_id || '--')}</td>
                    <td>${r.is_active ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>'}</td>
                    <td>
                        <button class="adm-btn-sm" onclick="toggleRcWheelReward(${r.id}, ${!r.is_active})">${r.is_active ? 'غیرفعال' : 'فعال'}</button>
                        <button class="adm-btn-sm adm-btn-danger" onclick="deleteRcWheelReward(${r.id})">حذف</button>
                    </td>
                </tr>`;
            }).join('');
            section.innerHTML = `
                <div class="rc-card">
                    <h4 class="rc-card-title">پاداش‌های گردونه</h4>
                    <div class="adm-table-wrap">
                        <table class="adm-table">
                            <thead><tr><th>نام</th><th>نوع</th><th>مقدار</th><th>وزن</th><th>کمپین</th><th>وضعیت</th><th>عملیات</th></tr></thead>
                            <tbody>${rows || '<tr><td colspan="7" class="admin-empty">پاداشی موجود نیست</td></tr>'}</tbody>
                        </table>
                    </div>
                    <button class="adm-btn adm-btn-primary" onclick="showRcWheelRewardForm()" style="margin-top:12px;">افزودن پاداش</button>
                    <div id="rc-wheel-reward-form" style="display:none;margin-top:12px;"></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا در بارگذاری</div>'; console.error(e); }
}
window.loadRcWheelRewards = loadRcWheelRewards;

function showRcWheelRewardForm() {
    const form = document.getElementById('rc-wheel-reward-form');
    if (!form) return;
    form.style.display = form.style.display === 'none' ? '' : 'none';
    form.innerHTML = `
        <div class="rc-card" style="border-color:rgba(245,166,35,0.3);">
            <h4 class="rc-card-title">پاداش جدید</h4>
            <div class="rc-form-grid">
                <div class="rc-field"><label>نام پاداش</label><input type="text" id="rc-wr-label" placeholder="+5 AB"></div>
                <div class="rc-field"><label>نوع</label><select id="rc-wr-type"><option value="token">توکن</option><option value="spin">اسپین</option><option value="voucher">ووچر</option><option value="nft">NFT</option><option value="premium">ویژه</option><option value="coupon">کوپن</option><option value="external">خارجی</option></select></div>
                <div class="rc-field"><label>مقدار</label><input type="number" id="rc-wr-amount" value="1" min="0"></div>
                <div class="rc-field"><label>وزن</label><input type="number" id="rc-wr-weight" value="1" min="1"></div>
                <div class="rc-field"><label>کمپین (اختیاری)</label><input type="text" id="rc-wr-campaign" placeholder="camp_id"></div>
                <div class="rc-field"><label>فعال</label><select id="rc-wr-active"><option value="true">بله</option><option value="false">خیر</option></select></div>
            </div>
            <button class="adm-btn adm-btn-primary" onclick="createRcWheelReward()" style="margin-top:10px;">ایجاد</button>
        </div>
    `;
}
window.showRcWheelRewardForm = showRcWheelRewardForm;

async function createRcWheelReward() {
    const payload = {
        reward_label: document.getElementById('rc-wr-label')?.value,
        reward_type: document.getElementById('rc-wr-type')?.value,
        reward_amount: Number(document.getElementById('rc-wr-amount')?.value || 0),
        weight: Number(document.getElementById('rc-wr-weight')?.value || 1),
        campaign_id: document.getElementById('rc-wr-campaign')?.value || null,
        is_active: document.getElementById('rc-wr-active')?.value === 'true',
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/wheel/rewards', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('پاداش ایجاد شد', 'success'); loadRcWheelRewards(); }
        else { adminToast('خطا در ایجاد', 'error'); }
    } catch (e) { adminToast('خطا در ایجاد', 'error'); console.error(e); }
}
window.createRcWheelReward = createRcWheelReward;

async function toggleRcWheelReward(id, makeActive) {
    try {
        const data = await apiFetch('/api/admin/reward-center/wheel/rewards/' + id, { method: 'PUT', body: JSON.stringify({ is_active: makeActive }) });
        if (data && data.status === 'success') { adminToast('وضعیت تغییر کرد', 'success'); loadRcWheelRewards(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.toggleRcWheelReward = toggleRcWheelReward;

async function deleteRcWheelReward(id) {
    if (!confirm('حذف این پاداش؟')) return;
    try {
        const data = await apiFetch('/api/admin/reward-center/wheel/rewards/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcWheelRewards(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcWheelReward = deleteRcWheelReward;

// ─── Referral Tiers ─────────────────────────────────────────

async function loadRcReferralTiers() {
    const section = document.getElementById('rc-referral-tiers-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/referral-tiers');
        if (data && data.status === 'success' && Array.isArray(data.tiers)) {
            let rows = data.tiers.map(function (t) {
                return `<tr>
                    <td>${adminFormatNumber(t.invite_count)}</td>
                    <td>${adminFormatNumber(t.token_amount)} AB</td>
                    <td>${adminFormatNumber(t.bonus_spins)}</td>
                    <td>${adminEscapeHtml(t.campaign_id || '--')}</td>
                    <td>${t.is_enabled ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>'}</td>
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcReferralTier(${t.id})">حذف</button></td>
                </tr>`;
            }).join('');
            section.innerHTML = `
                <div class="rc-card">
                    <h4 class="rc-card-title">طبقات پاداش رفرال</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>تعداد دعوت</th><th>توکن</th><th>اسپین رایگان</th><th>کمپین</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="admin-empty">طبقه‌ای موجود نیست</td></tr>'}</tbody></table></div>
                    <button class="adm-btn adm-btn-primary" onclick="showRcReferralTierForm()" style="margin-top:12px;">افزودن طبقه</button>
                    <div id="rc-referral-tier-form" style="display:none;margin-top:12px;"></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadRcReferralTiers = loadRcReferralTiers;

function showRcReferralTierForm() {
    const form = document.getElementById('rc-referral-tier-form');
    if (!form) return;
    form.style.display = form.style.display === 'none' ? '' : 'none';
    form.innerHTML = `
        <div class="rc-card" style="border-color:rgba(245,166,35,0.3);">
            <h4 class="rc-card-title">طبقه جدید</h4>
            <div class="rc-form-grid">
                <div class="rc-field"><label>تعداد دعوت</label><input type="number" id="rc-rt-invites" value="1" min="1"></div>
                <div class="rc-field"><label>توکن</label><input type="number" id="rc-rt-tokens" value="3" min="0"></div>
                <div class="rc-field"><label>اسپین رایگان</label><input type="number" id="rc-rt-spins" value="0" min="0"></div>
                <div class="rc-field"><label>فعال</label><select id="rc-rt-enabled"><option value="true">بله</option><option value="false">خیر</option></select></div>
            </div>
            <button class="adm-btn adm-btn-primary" onclick="createRcReferralTier()" style="margin-top:10px;">ایجاد</button>
        </div>
    `;
}
window.showRcReferralTierForm = showRcReferralTierForm;

async function createRcReferralTier() {
    const payload = {
        invite_count: Number(document.getElementById('rc-rt-invites')?.value || 1),
        token_amount: Number(document.getElementById('rc-rt-tokens')?.value || 0),
        bonus_spins: Number(document.getElementById('rc-rt-spins')?.value || 0),
        is_enabled: document.getElementById('rc-rt-enabled')?.value === 'true',
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/referral-tiers', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcReferralTiers(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcReferralTier = createRcReferralTier;

async function deleteRcReferralTier(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await apiFetch('/api/admin/reward-center/referral-tiers/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcReferralTiers(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcReferralTier = deleteRcReferralTier;

// ─── Mission Rewards ────────────────────────────────────────

async function loadRcMissionRewards() {
    const section = document.getElementById('rc-mission-rewards-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/mission-rewards');
        if (data && data.status === 'success' && Array.isArray(data.missions)) {
            let rows = data.missions.map(function (m) {
                return `<tr>
                    <td>${adminEscapeHtml(m.mission_name)}</td>
                    <td>${adminFormatNumber(m.token_amount)} AB</td>
                    <td>${adminFormatNumber(m.bonus_spins)}</td>
                    <td>${m.is_enabled ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>'}</td>
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcMissionReward(${m.id})">حذف</button></td>
                </tr>`;
            }).join('');
            section.innerHTML = `
                <div class="rc-card">
                    <h4 class="rc-card-title">پاداش ماموریت‌ها</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>ماموریت</th><th>توکن</th><th>اسپین</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows || '<tr><td colspan="5" class="admin-empty">ماموریتی موجود نیست</td></tr>'}</tbody></table></div>
                    <button class="adm-btn adm-btn-primary" onclick="showRcMissionForm()" style="margin-top:12px;">افزودن ماموریت</button>
                    <div id="rc-mission-form" style="display:none;margin-top:12px;"></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadRcMissionRewards = loadRcMissionRewards;

function showRcMissionForm() {
    const form = document.getElementById('rc-mission-form');
    if (!form) return;
    form.style.display = form.style.display === 'none' ? '' : 'none';
    form.innerHTML = `
        <div class="rc-card" style="border-color:rgba(245,166,35,0.3);">
            <h4 class="rc-card-title">ماموریت جدید</h4>
            <div class="rc-form-grid">
                <div class="rc-field"><label>ID ماموریت</label><input type="text" id="rc-mr-id" placeholder="invite_5"></div>
                <div class="rc-field"><label>نام</label><input type="text" id="rc-mr-name" placeholder="۵ دعوت موفق"></div>
                <div class="rc-field"><label>توکن</label><input type="number" id="rc-mr-tokens" value="15" min="0"></div>
                <div class="rc-field"><label>اسپین</label><input type="number" id="rc-mr-spins" value="0" min="0"></div>
            </div>
            <button class="adm-btn adm-btn-primary" onclick="createRcMissionReward()" style="margin-top:10px;">ایجاد</button>
        </div>
    `;
}
window.showRcMissionForm = showRcMissionForm;

async function createRcMissionReward() {
    const payload = {
        mission_id: document.getElementById('rc-mr-id')?.value,
        mission_name: document.getElementById('rc-mr-name')?.value,
        token_amount: Number(document.getElementById('rc-mr-tokens')?.value || 0),
        bonus_spins: Number(document.getElementById('rc-mr-spins')?.value || 0),
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/mission-rewards', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcMissionRewards(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcMissionReward = createRcMissionReward;

async function deleteRcMissionReward(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await apiFetch('/api/admin/reward-center/mission-rewards/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcMissionRewards(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcMissionReward = deleteRcMissionReward;

// ─── Campaigns ──────────────────────────────────────────────

async function loadRcCampaigns() {
    const section = document.getElementById('rc-campaigns-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/campaigns');
        if (data && data.status === 'success' && Array.isArray(data.campaigns)) {
            let rows = data.campaigns.map(function (c) {
                return `<tr>
                    <td>${adminEscapeHtml(c.name)}</td>
                    <td>${c.start_date || '--'}</td>
                    <td>${c.end_date || '--'}</td>
                    <td>${c.status === 'active' ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>'}</td>
                    <td>${adminFormatNumber(c.priority)}</td>
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcCampaign('${adminEscapeHtml(c.id)}')">حذف</button></td>
                </tr>`;
            }).join('');
            section.innerHTML = `
                <div class="rc-card">
                    <h4 class="rc-card-title">کمپین‌ها</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>نام</th><th>شروع</th><th>پایان</th><th>وضعیت</th><th>اولویت</th><th>عملیات</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="admin-empty">کمپینی موجود نیست</td></tr>'}</tbody></table></div>
                    <button class="adm-btn adm-btn-primary" onclick="showRcCampaignForm()" style="margin-top:12px;">افزودن کمپین</button>
                    <div id="rc-campaign-form" style="display:none;margin-top:12px;"></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadRcCampaigns = loadRcCampaigns;

function showRcCampaignForm() {
    const form = document.getElementById('rc-campaign-form');
    if (!form) return;
    form.style.display = form.style.display === 'none' ? '' : 'none';
    form.innerHTML = `
        <div class="rc-card" style="border-color:rgba(245,166,35,0.3);">
            <h4 class="rc-card-title">کمپین جدید</h4>
            <div class="rc-form-grid">
                <div class="rc-field"><label>نام</label><input type="text" id="rc-cm-name" placeholder="تابستان ۲۰۲۶"></div>
                <div class="rc-field"><label>تاریخ شروع</label><input type="datetime-local" id="rc-cm-start"></div>
                <div class="rc-field"><label>تاریخ پایان</label><input type="datetime-local" id="rc-cm-end"></div>
                <div class="rc-field"><label>اولویت</label><input type="number" id="rc-cm-priority" value="0"></div>
            </div>
            <div class="rc-form-grid" style="margin-top:8px;">
                <label class="rc-toggle-row"><input type="checkbox" id="rc-cm-wheel" checked><span>اعمال روی گردونه</span></label>
                <label class="rc-toggle-row"><input type="checkbox" id="rc-cm-referral"><span>اعمال روی رفرال</span></label>
                <label class="rc-toggle-row"><input type="checkbox" id="rc-cm-mission"><span>اعمال روی ماموریت</span></label>
            </div>
            <button class="adm-btn adm-btn-primary" onclick="createRcCampaign()" style="margin-top:10px;">ایجاد</button>
        </div>
    `;
}
window.showRcCampaignForm = showRcCampaignForm;

async function createRcCampaign() {
    const payload = {
        name: document.getElementById('rc-cm-name')?.value,
        start_date: document.getElementById('rc-cm-start')?.value || null,
        end_date: document.getElementById('rc-cm-end')?.value || null,
        priority: Number(document.getElementById('rc-cm-priority')?.value || 0),
        applies_to_wheel: document.getElementById('rc-cm-wheel')?.checked,
        applies_to_referral: document.getElementById('rc-cm-referral')?.checked,
        applies_to_mission: document.getElementById('rc-cm-mission')?.checked,
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/campaigns', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcCampaigns(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcCampaign = createRcCampaign;

async function deleteRcCampaign(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await apiFetch('/api/admin/reward-center/campaigns/' + encodeURIComponent(id), { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcCampaigns(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcCampaign = deleteRcCampaign;

// ─── Reward Library ─────────────────────────────────────────

async function loadRcLibrary() {
    const section = document.getElementById('rc-library-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/library');
        if (data && data.status === 'success' && Array.isArray(data.library)) {
            let rows = data.library.map(function (item) {
                return `<tr>
                    <td>${adminEscapeHtml(item.name)}</td>
                    <td>${adminEscapeHtml(item.reward_type)}</td>
                    <td>${adminFormatNumber(item.amount)}</td>
                    <td>${adminEscapeHtml(item.category)}</td>
                    <td>${item.is_active ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>'}</td>
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcLibraryItem(${item.id})">حذف</button></td>
                </tr>`;
            }).join('');
            section.innerHTML = `
                <div class="rc-card">
                    <h4 class="rc-card-title">کتابخانه پاداش</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>نام</th><th>نوع</th><th>مقدار</th><th>دسته</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="admin-empty">آیتمی موجود نیست</td></tr>'}</tbody></table></div>
                    <button class="adm-btn adm-btn-primary" onclick="showRcLibraryForm()" style="margin-top:12px;">افزودن پاداش</button>
                    <div id="rc-library-form" style="display:none;margin-top:12px;"></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadRcLibrary = loadRcLibrary;

function showRcLibraryForm() {
    const form = document.getElementById('rc-library-form');
    if (!form) return;
    form.style.display = form.style.display === 'none' ? '' : 'none';
    form.innerHTML = `
        <div class="rc-card" style="border-color:rgba(245,166,35,0.3);">
            <h4 class="rc-card-title">پاداش جدید</h4>
            <div class="rc-form-grid">
                <div class="rc-field"><label>نام</label><input type="text" id="rc-lib-name" placeholder="50 AB Token"></div>
                <div class="rc-field"><label>نوع</label><select id="rc-lib-type"><option value="token">توکن</option><option value="spin">اسپین</option><option value="voucher">ووچر</option><option value="nft">NFT</option><option value="premium">ویژه</option><option value="coupon">کوپن</option><option value="avatar">آواتار</option><option value="badge">بج</option></select></div>
                <div class="rc-field"><label>مقدار</label><input type="number" id="rc-lib-amount" value="1" min="0"></div>
                <div class="rc-field"><label>دسته</label><input type="text" id="rc-lib-category" value="token"></div>
            </div>
            <button class="adm-btn adm-btn-primary" onclick="createRcLibraryItem()" style="margin-top:10px;">ایجاد</button>
        </div>
    `;
}
window.showRcLibraryForm = showRcLibraryForm;

async function createRcLibraryItem() {
    const payload = {
        name: document.getElementById('rc-lib-name')?.value,
        reward_type: document.getElementById('rc-lib-type')?.value,
        amount: Number(document.getElementById('rc-lib-amount')?.value || 0),
        category: document.getElementById('rc-lib-category')?.value || 'general',
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/library', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcLibrary(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcLibraryItem = createRcLibraryItem;

async function deleteRcLibraryItem(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await apiFetch('/api/admin/reward-center/library/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcLibrary(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcLibraryItem = deleteRcLibraryItem;

// ─── Analytics ──────────────────────────────────────────────

async function loadRcAnalytics() {
    const section = document.getElementById('rc-analytics-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/analytics?range=30d');
        if (data && data.status === 'success' && data.analytics) {
            const a = data.analytics;
            const distRows = (a.reward_distribution || []).map(function (d) {
                return `<tr><td>${adminEscapeHtml(d.label || d.type)}</td><td>${adminFormatNumber(d.count)}</td><td>${adminFormatNumber(d.total)}</td></tr>`;
            }).join('');
            const winnersRows = (a.top_winners || []).map(function (w, i) {
                return `<tr><td>${i + 1}</td><td>${adminEscapeHtml(w.first_name || w.username || w.user_id)}</td><td>${adminFormatNumber(w.spins)}</td><td>${adminFormatNumber(w.total_won)} AB</td></tr>`;
            }).join('');
            section.innerHTML = `
                <div class="rc-overview-grid">
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.today_spins)}</div><div class="rc-stat-lbl">اسپین امروز</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.weekly_spins)}</div><div class="rc-stat-lbl">اسپین هفته</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.monthly_spins)}</div><div class="rc-stat-lbl">اسپین ماه</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${a.average_reward}</div><div class="rc-stat-lbl">میانگین پاداش</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.highest_reward)} AB</div><div class="rc-stat-lbl">بزرگ‌ترین پاداش</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.total_tokens)} AB</div><div class="rc-stat-lbl">کل توکن توزیع شده</div></div>
                </div>
                <div class="rc-card" style="margin-top:16px;">
                    <h4 class="rc-card-title">توزیع پاداش‌ها</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>پاداش</th><th>تعداد</th><th>کل</th></tr></thead><tbody>${distRows || '<tr><td colspan="3" class="admin-empty">داده‌ای نیست</td></tr>'}</tbody></table></div>
                </div>
                <div class="rc-card" style="margin-top:16px;">
                    <h4 class="rc-card-title">برترین برندگان</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>#</th><th>کاربر</th><th>اسپین</th><th>کل پاداش</th></tr></thead><tbody>${winnersRows || '<tr><td colspan="4" class="admin-empty">داده‌ای نیست</td></tr>'}</tbody></table></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadRcAnalytics = loadRcAnalytics;

// ─── Settings (Emergency Controls) ──────────────────────────

async function loadRcSettings() {
    const section = document.getElementById('rc-settings-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/reward-center/emergency');
        if (data && data.status === 'success' && data.controls) {
            _rcEmergencyControls = data.controls;
            const c = data.controls;
            section.innerHTML = `
                <div class="rc-card" style="border-color:rgba(255,77,77,0.3);">
                    <h4 class="rc-card-title">کنترل‌های اضطراری</h4>
                    <p style="font-size:12px;color:var(--admin-text-dim);margin-bottom:12px;">این کنترل‌ها فوراً اعمال می‌شوند و تمام سیستم پاداش را متوقف می‌کنند.</p>
                    <div class="rc-form-grid">
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-em-wheel" ${c.disable_wheel ? 'checked' : ''}><span>غیرفعال کردن گردونه</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-em-referral" ${c.disable_referral_rewards ? 'checked' : ''}><span>غیرفعال کردن پاداش رفرال</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-em-mission" ${c.disable_mission_rewards ? 'checked' : ''}><span>غیرفعال کردن پاداش ماموریت</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-em-campaign" ${c.disable_campaigns ? 'checked' : ''}><span>غیرفعال کردن کمپین‌ها</span></label>
                        <label class="rc-toggle-row"><input type="checkbox" id="rc-em-engine" ${c.disable_reward_engine ? 'checked' : ''}><span>غیرفعال کردن کل موتور پاداش</span></label>
                    </div>
                    <button class="adm-btn adm-btn-primary" onclick="saveRcEmergency()" style="margin-top:12px;">ذخیره</button>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadRcSettings = loadRcSettings;

async function saveRcEmergency() {
    const payload = {
        disable_wheel: document.getElementById('rc-em-wheel')?.checked,
        disable_referral_rewards: document.getElementById('rc-em-referral')?.checked,
        disable_mission_rewards: document.getElementById('rc-em-mission')?.checked,
        disable_campaigns: document.getElementById('rc-em-campaign')?.checked,
        disable_reward_engine: document.getElementById('rc-em-engine')?.checked,
    };
    try {
        const data = await apiFetch('/api/admin/reward-center/emergency', { method: 'PUT', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ذخیره شد', 'success'); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.saveRcEmergency = saveRcEmergency;

window.loadRewardCenterOverview = loadRewardCenterOverview;

// ════════════════════════════════════════════════════════════════════
// NOTIFICATION PLATFORM — Admin notification management
// ════════════════════════════════════════════════════════════════════

function switchNotificationTab(tab, btn) {
    document.querySelectorAll('#np-tabs .rc-tab').forEach(function (t) { t.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    else { const t = document.querySelector('#np-tabs .rc-tab[data-np-tab="' + tab + '"]'); if (t) t.classList.add('active'); }
    document.querySelectorAll('#admin-section-notification-center .rc-tab-content').forEach(function (c) { c.style.display = 'none'; });
    const active = document.getElementById('np-tab-' + tab);
    if (active) active.style.display = '';
    switch (tab) {
        case 'overview': loadNpOverview(); break;
        case 'broadcast': loadNpBroadcast(); break;
        case 'templates': loadNpTemplates(); break;
        case 'analytics': loadNpAnalytics(); break;
    }
}
window.switchNotificationTab = switchNotificationTab;

async function loadNpOverview() {
    const grid = document.getElementById('np-overview-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/notifications/analytics?range=7d');
        if (data && data.status === 'success' && data.analytics) {
            const a = data.analytics;
            const catRows = (a.by_category || []).map(function (c) { return '<div class="rc-stat-card"><div class="rc-stat-val">' + adminFormatNumber(c.count) + '</div><div class="rc-stat-lbl">' + adminEscapeHtml(c.category) + '</div></div>'; }).join('');
            grid.innerHTML = `
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.total_sent)}</div><div class="rc-stat-lbl">کل اعلان‌ها (۷ روز)</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.total_unread)}</div><div class="rc-stat-lbl">خوانده نشده</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.today_count)}</div><div class="rc-stat-lbl">اعلان امروز</div></div>
                ${catRows || '<div class="rc-stat-card"><div class="rc-stat-val">--</div><div class="rc-stat-lbl">داده‌ای نیست</div></div>'}
            `;
        } else { grid.innerHTML = '<div class="admin-empty">داده‌ای موجود نیست</div>'; }
    } catch (e) { grid.innerHTML = '<div class="admin-empty">خطا در بارگذاری</div>'; console.error(e); }
}
window.loadNpOverview = loadNpOverview;

async function loadNpBroadcast() {
    const section = document.getElementById('np-broadcast-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/notifications/broadcasts?limit=20');
        let rows = '';
        if (data && data.status === 'success' && Array.isArray(data.broadcasts)) {
            rows = data.broadcasts.map(function (b) {
                return '<tr><td>' + adminEscapeHtml(b.title) + '</td><td>' + adminEscapeHtml(b.category) + '</td><td>' + adminEscapeHtml(b.priority) + '</td><td>' + adminFormatNumber(b.total_sent) + '</td><td>' + adminEscapeHtml(b.status) + '</td><td>' + (b.status === 'pending' ? '<button class="adm-btn-sm" onclick="sendNpBroadcast(' + b.id + ')">ارسال</button>' : '--') + '</td></tr>';
            }).join('');
        }
        section.innerHTML = `
            <div class="rc-card">
                <h4 class="rc-card-title">ارسال همگانی جدید</h4>
                <div class="rc-form-grid">
                    <div class="rc-field"><label>عنوان</label><input type="text" id="np-bc-title" placeholder="اطلاعیه مهم"></div>
                    <div class="rc-field"><label>دسته</label><select id="np-bc-category"><option value="announcement">اطلاعیه</option><option value="system">سیستم</option><option value="market">بازار</option><option value="news">خبر</option></select></div>
                    <div class="rc-field"><label>اولویت</label><select id="np-bc-priority"><option value="low">پایین</option><option value="medium" selected>متوسط</option><option value="high">بالا</option><option value="critical">بحرانی</option></select></div>
                    <div class="rc-field"><label>کانال</label><select id="np-bc-channel"><option value="mini_app">Mini App</option><option value="telegram">Telegram Bot</option><option value="both">هر دو</option></select></div>
                    <div class="rc-field"><label>هدف</label><select id="np-bc-target"><option value="all">همه</option><option value="active">فعال</option></select></div>
                </div>
                <div class="rc-field" style="margin-top:10px;"><label>پیام</label><textarea id="np-bc-message" rows="3" style="width:100%;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:9px;padding:8px 10px;color:#FFF;font-size:13px;font-family:inherit;" placeholder="متن پیام..."></textarea></div>
                <button class="adm-btn adm-btn-primary" onclick="createNpBroadcast()" style="margin-top:10px;">ارسال</button>
            </div>
            <div class="rc-card" style="margin-top:16px;">
                <h4 class="rc-card-title">تاریخچه ارسال‌ها</h4>
                <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>عنوان</th><th>دسته</th><th>اولویت</th><th>ارسال شده</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>${rows || '<tr><td colspan="6" class="admin-empty">رکوردی موجود نیست</td></tr>'}</tbody></table></div>
            </div>
        `;
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadNpBroadcast = loadNpBroadcast;

async function createNpBroadcast() {
    const payload = {
        title: document.getElementById('np-bc-title')?.value,
        message: document.getElementById('np-bc-message')?.value,
        category: document.getElementById('np-bc-category')?.value,
        priority: document.getElementById('np-bc-priority')?.value,
        channel: document.getElementById('np-bc-channel')?.value,
        target_type: document.getElementById('np-bc-target')?.value,
    };
    try {
        const data = await apiFetch('/api/admin/notifications/broadcasts', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ارسال شد: ' + (data.sent || 0) + ' کاربر', 'success'); loadNpBroadcast(); }
        else { adminToast('خطا در ارسال', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createNpBroadcast = createNpBroadcast;

async function sendNpBroadcast(id) {
    try {
        const data = await apiFetch('/api/admin/notifications/broadcasts/' + id + '/send', { method: 'POST' });
        if (data && data.status === 'success') { adminToast('ارسال شد: ' + (data.sent || 0) + ' کاربر', 'success'); loadNpBroadcast(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.sendNpBroadcast = sendNpBroadcast;

async function loadNpTemplates() {
    const section = document.getElementById('np-templates-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/notifications/templates');
        let rows = '';
        if (data && data.status === 'success' && Array.isArray(data.templates)) {
            rows = data.templates.map(function (t) {
                return '<tr><td>' + adminEscapeHtml(t.key) + '</td><td>' + adminEscapeHtml(t.category) + '</td><td>' + adminEscapeHtml(t.priority) + '</td><td>' + adminEscapeHtml(t.channel) + '</td><td>' + (t.is_active ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>') + '</td></tr>';
            }).join('');
        }
        section.innerHTML = '<div class="rc-card"><h4 class="rc-card-title">قالب‌های اعلان</h4><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>کلید</th><th>دسته</th><th>اولویت</th><th>کانال</th><th>وضعیت</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="admin-empty">قالبی موجود نیست</td></tr>') + '</tbody></table></div></div>';
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadNpTemplates = loadNpTemplates;

async function loadNpAnalytics() {
    const section = document.getElementById('np-analytics-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/notifications/analytics?range=30d');
        if (data && data.status === 'success' && data.analytics) {
            const a = data.analytics;
            const catRows = (a.by_category || []).map(function (c) { return '<tr><td>' + adminEscapeHtml(c.category) + '</td><td>' + adminFormatNumber(c.count) + '</td></tr>'; }).join('');
            const priRows = (a.by_priority || []).map(function (p) { return '<tr><td>' + adminEscapeHtml(p.priority) + '</td><td>' + adminFormatNumber(p.count) + '</td></tr>'; }).join('');
            section.innerHTML = `
                <div class="rc-overview-grid">
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.total_sent)}</div><div class="rc-stat-lbl">کل (۳۰ روز)</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.total_unread)}</div><div class="rc-stat-lbl">خوانده نشده</div></div>
                    <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(a.today_count)}</div><div class="rc-stat-lbl">امروز</div></div>
                </div>
                <div class="rc-card" style="margin-top:16px;">
                    <h4 class="rc-card-title">بر اساس دسته</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>دسته</th><th>تعداد</th></tr></thead><tbody>${catRows || '<tr><td colspan="2" class="admin-empty">داده‌ای نیست</td></tr>'}</tbody></table></div>
                </div>
                <div class="rc-card" style="margin-top:16px;">
                    <h4 class="rc-card-title">بر اساس اولویت</h4>
                    <div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>اولویت</th><th>تعداد</th></tr></thead><tbody>${priRows || '<tr><td colspan="2" class="admin-empty">داده‌ای نیست</td></tr>'}</tbody></table></div>
                </div>
            `;
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadNpAnalytics = loadNpAnalytics;

// ════════════════════════════════════════════════════════════════════
// ALERT ECONOMY — Admin alert management (quota, config, dashboard)
// ════════════════════════════════════════════════════════════════════

async function loadAlertEconomyDashboard() {
    const grid = document.getElementById('ae-dashboard-grid');
    if (!grid) return;
    grid.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/alert-economy/dashboard');
        if (data && data.status === 'success' && data.dashboard) {
            const d = data.dashboard;
            const svcHtml = (d.services || []).map(function (s) {
                return '<div class="rc-stat-card"><div class="rc-stat-val">' + (s.is_enabled ? '✅ فعال' : '⛔ غیرفعال') + '</div><div class="rc-stat-lbl">' + adminEscapeHtml(s.alert_type) + ' (' + s.free_per_day + ' رایگان / ' + s.cost_per_extra + ' AB)</div></div>';
            }).join('');
            grid.innerHTML = `
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(d.active_alerts)}</div><div class="rc-stat-lbl">هشدارهای فعال</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(d.triggered_today)}</div><div class="rc-stat-lbl">اجراشده امروز</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(d.quota_used_today)}</div><div class="rc-stat-lbl">سهمیه استفاده شده</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(d.paid_alerts_today)}</div><div class="rc-stat-lbl">هشدارهای پولی</div></div>
                <div class="rc-stat-card"><div class="rc-stat-val">${adminFormatNumber(d.ab_spent_today)} AB</div><div class="rc-stat-lbl">AB مصرف شده</div></div>
                ${svcHtml}
            `;
        } else { grid.innerHTML = '<div class="admin-empty">داده‌ای موجود نیست</div>'; }
    } catch (e) { grid.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadAlertEconomyDashboard = loadAlertEconomyDashboard;

async function loadAlertEconomyConfigs() {
    const section = document.getElementById('ae-configs-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    try {
        const data = await apiFetch('/api/admin/alert-economy/configs');
        if (data && data.status === 'success' && Array.isArray(data.configs)) {
            const rows = data.configs.map(function (c) {
                return '<tr><td>' + adminEscapeHtml(c.alert_type) + '</td><td>' + (c.is_enabled ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>') + '</td><td>' + c.free_per_day + '</td><td>' + c.cost_per_extra + ' AB</td><td><button class="adm-btn-sm" onclick="toggleAlertService(\'' + c.alert_type + '\', ' + !c.is_enabled + ')">' + (c.is_enabled ? 'غیرفعال' : 'فعال') + '</button></td></tr>';
            }).join('');
            section.innerHTML = '<div class="rc-card"><h4 class="rc-card-title">تنظیمات هشدارها</h4><div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>نوع هشدار</th><th>وضعیت</th><th>رایگان/روز</th><th>هزینه اضافه</th><th>عملیات</th></tr></thead><tbody>' + (rows || '<tr><td colspan="5" class="admin-empty">داده‌ای نیست</td></tr>') + '</tbody></table></div></div>';
        }
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadAlertEconomyConfigs = loadAlertEconomyConfigs;

async function toggleAlertService(alertType, enable) {
    try {
        const data = await apiFetch('/api/admin/alert-economy/configs/' + encodeURIComponent(alertType), {
            method: 'PUT',
            body: JSON.stringify({ is_enabled: enable }),
        });
        if (data && data.status === 'success') { adminToast('تغییر وضعیت', 'success'); loadAlertEconomyConfigs(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.toggleAlertService = toggleAlertService;

// ── Missing window exports for ticket admin functions ──
window.adminReplyTicket = adminReplyTicket;
window.adminSetTicketStatus = adminSetTicketStatus;
window.adminDeleteTicket = adminDeleteTicket;
window.toggleAdminTicketDetail = toggleAdminTicketDetail;

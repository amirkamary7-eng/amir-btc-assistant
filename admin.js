/* ============================================================
   Admin Control Center — Frontend Logic (Vanilla JS)
   ROOT CAUSE FIX: Uses dedicated adminApiFetch() instead of app.js apiFetch().
   This avoids waitForApiReady blocking, request deduplication cascade failures,
   and adds built-in retry with exponential backoff + longer timeout.
   ============================================================ */

// ─── State ──────────────────────────────────────────────────
let _adminPanelOpen = false;
let _currentAdminSection = 'dashboard';
let _adminUserSearchTimeout = null;
let _adminReferralSearchTimeout = null;
// Request cancellation token — increments on each section switch.
// When a loader finishes, it checks if its token matches the current one.
// If not, the response is stale and the loader silently discards it.
let _adminLoadToken = 0;
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

/**
 * @deprecated Use adminToast() instead. Kept as a thin alias so legacy call
 *   sites (admin settings, tickets, broadcasts) keep working without edits.
 */
function showAdminToast(message, type) {
    adminToast(message, type);
}

function adminEmpty(message) {
    return '<div class="admin-empty">' + adminEscapeHtml(message || 'No data found') + '</div>';
}

/**
 * Generate a loading skeleton grid (premium loading state).
 * @param {number} count - Number of skeleton cards
 * @returns {string} HTML for skeleton cards
 */
function adminSkeletonGrid(count) {
    count = count || 6;
    let html = '';
    for (let i = 0; i < count; i++) {
        html += '<div class="adm-skeleton adm-skeleton-card"></div>';
    }
    return html;
}

/**
 * Generate an error state with retry button.
 * @param {string} message - Error message
 * @param {string} retryFn - Function name to call on retry (e.g. 'loadAdminUsers')
 * @returns {string} HTML for error state
 */
function adminErrorState(message, retryFn) {
    return '<div class="admin-empty" style="color:#f87171;border-color:rgba(239,68,68,0.20);">' +
        adminEscapeHtml(message || 'خطا در بارگذاری') +
        (retryFn ? '<button class="adm-retry-btn" onclick="' + adminEscapeHtml(retryFn) + '()">تلاش مجدد</button>' : '') +
        '</div>';
}

/**
 * Check if the current load token is still valid.
 * Use at the start of async loaders: const token = _adminLoadToken;
 * Then after await: if (token !== _adminLoadToken) return;
 * This prevents stale responses from overwriting current section content.
 */
function _isLoadTokenStale(token) {
    return token !== _adminLoadToken;
}

/**
 * ROOT CAUSE FIX: Dedicated admin API fetch with retry + backoff + longer timeout.
 *
 * Previous version used app.js apiFetch() which had 3 critical problems:
 *   1. waitForApiReady(8000) — every admin request waited up to 8s for Telegram auth
 *   2. Request deduplication — two calls to same path shared one promise; if it
 *      failed, BOTH failed (cascade failure)
 *   3. No retry — one network hiccup → "Failed to load" → user must refresh
 *
 * adminApiFetch fixes all 3:
 *   - No waitForApiReady (admin has its own auth via X-Telegram-Init-Data header)
 *   - No deduplication (each call is independent)
 *   - 3 retry attempts with exponential backoff (1s, 2s, 4s)
 *   - 30s timeout (was 15s — too short for system-health with 8 service checks)
 *   - Cache-Control: no-store (never use browser cache for admin data)
 *
 * @param {string} path - API path (e.g. '/api/admin/dashboard')
 * @param {object} options - fetch options
 * @returns {Promise<object>} parsed JSON response
 */
async function adminApiFetch(path, options = {}) {
    const method = (options.method || 'GET').toUpperCase();
    const initData = (typeof getTelegramInitData === 'function') ? getTelegramInitData() : '';
    const headers = {
        'Content-Type': 'application/json',
        'Cache-Control': 'no-store',
        ...(initData ? { 'X-Telegram-Init-Data': initData } : {}),
        ...options.headers,
    };
    const url = `${API_BASE}${path}`;
    const maxRetries = 3;
    const baseDelay = 1000; // 1s, 2s, 4s

    let lastError = null;
    for (let attempt = 0; attempt < maxRetries; attempt++) {
        try {
            const controller = new AbortController();
            const timeoutId = setTimeout(() => controller.abort(), 30000); // 30s timeout
            const fetchOpts = { ...options, method, headers, signal: controller.signal };
            const res = await fetch(url, fetchOpts);
            clearTimeout(timeoutId);

            if (!res.ok) {
                let detail = '';
                try { detail = await res.text(); } catch (_) {}
                let errMsg = detail || `HTTP ${res.status}`;
                try { const j = JSON.parse(detail); if (j.detail) errMsg = j.detail; } catch (_) {}
                const err = new Error(errMsg);
                err.status = res.status;
                // Don't retry on 401/403/422 — these are auth/validation errors
                if (res.status === 401 || res.status === 403 || res.status === 422) {
                    throw err;
                }
                // Retry on 500/502/503/504 and network errors
                throw err;
            }

            // Parse JSON — if response is HTML (CF error page), throw
            try {
                return await res.json();
            } catch (parseErr) {
                throw new Error(`Invalid JSON response from ${path}`);
            }
        } catch (e) {
            lastError = e;
            // Don't retry on auth errors
            if (e.status === 401 || e.status === 403 || e.status === 422) {
                throw e;
            }
            // Last attempt — throw
            if (attempt === maxRetries - 1) {
                throw e;
            }
            // Wait before retry (exponential backoff: 1s, 2s, 4s)
            const delay = baseDelay * Math.pow(2, attempt);
            await new Promise(r => setTimeout(r, delay));
        }
    }
    throw lastError || new Error('Request failed after ' + maxRetries + ' attempts');
}
// Make adminApiFetch available globally
window.adminApiFetch = adminApiFetch;

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
    'publisher': 'انتشار تلگرام',
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
    // Increment load token — any in-flight loader from a previous section
    // will see a stale token and discard its response.
    _adminLoadToken++;

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
        case 'rewards': loadAdminRewards(); break;
        case 'transactions': loadAdminTransactions(1); break;
        case 'referrals': loadAdminReferrals(); break;
        case 'reward-center': loadRewardCenterOverview(); break;
        case 'notification-center': loadNpOverview(); break;
        case 'alert-economy': loadAlertEconomyDashboard(); break;
        case 'publisher': loadPublisherOverview(); break;
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
        const data = await adminApiFetch('/api/system/status');
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
        const data = await adminApiFetch('/api/admin/maintenance', {
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

    const token = _adminLoadToken;

    // Load maintenance status banner (independent of dashboard API)
    loadDashboardMaintenanceBanner();

    grid.innerHTML = adminSkeletonGrid(8);
    if (activityList) activityList.innerHTML = '<div class="adm-skeleton" style="height:60px;margin-bottom:8px;"></div><div class="adm-skeleton" style="height:60px;margin-bottom:8px;"></div><div class="adm-skeleton" style="height:60px;"></div>';

    try {
        const data = await adminApiFetch('/api/admin/dashboard');
        if (_isLoadTokenStale(token)) return; // Section switched, discard stale response
        if (!data) throw new Error('No data');

        // Stats — ROOT CAUSE FIX: match new backend field names exactly.
        // Previous version expected 'new_users_today' (didn't exist) and
        // 'total_rewards' (didn't exist) → those cards showed nothing.
        let statsHtml = '';
        if (data.stats) {
            const s = data.stats;
            // Helper: show '--' for null values (metrics we can't compute)
            const fmt = function (v) { return (v == null) ? '--' : adminFormatNumber(v); };
            // User metrics (top row — most important)
            statsHtml += adminStatCardV2(fmt(s.total_users), 'کل کاربران', 'users', 'blue');
            statsHtml += adminStatCardV2(fmt(s.new_today), 'جدید امروز', 'new', 'green');
            statsHtml += adminStatCardV2(fmt(s.new_this_week), 'جدید این هفته', 'week', 'purple');
            statsHtml += adminStatCardV2(fmt(s.new_this_month), 'جدید این ماه', 'month', 'purple');
            statsHtml += adminStatCardV2(fmt(s.joined_channel), 'عضو کانال', 'channel', 'green');
            statsHtml += adminStatCardV2(fmt(s.join_percentage) + '%', 'درصد عضویت', 'percent', 'orange');
            statsHtml += adminStatCardV2(fmt(s.joined_bot), 'کاربران بات', 'bot', 'blue');
            statsHtml += adminStatCardV2(fmt(s.opened_mini_app), 'بازکردن Mini App', 'app', 'blue');
            // Alert metrics
            statsHtml += adminStatCardV2(fmt(s.active_alerts), 'هشدارهای فعال', 'alerts', 'orange');
            statsHtml += adminStatCardV2(fmt(s.triggered_today), 'هشدارهای فعال‌شده امروز', 'triggered', 'green');
            // Other metrics
            statsHtml += adminStatCardV2(fmt(s.open_tickets), 'تیکت‌های باز', 'open', 'red');
            statsHtml += adminStatCardV2(fmt(s.total_transactions), 'تراکنش‌ها', 'tx', 'orange');
            statsHtml += adminStatCardV2(fmt(s.admins_count), 'مدیران', 'admins', 'purple');
        }
        grid.innerHTML = statsHtml || adminEmpty('آماری موجود نیست');

        // Activity
        if (activityList && data.recent_activity) {
            // PHASE 3 FIX (Bug 2): Backend returns an OBJECT {admin_logs, analyses, tickets},
            // not an array. Previous code called .forEach on the object → activity feed
            // was always empty. Now we flatten the object into a single activity array.
            const ra = data.recent_activity;
            const activities = [];
            if (Array.isArray(ra.admin_logs)) {
                ra.admin_logs.forEach(function (a) {
                    activities.push({
                        type: 'admin',
                        message: 'Admin ' + adminEscapeHtml(a.admin_id) + ': ' + adminEscapeHtml(a.action) +
                            (a.target_type ? ' → ' + adminEscapeHtml(a.target_type) : ''),
                        created_at: a.created_at,
                    });
                });
            }
            if (Array.isArray(ra.analyses)) {
                ra.analyses.forEach(function (a) {
                    activities.push({
                        type: 'analysis',
                        message: 'تحلیل جدید: ' + adminEscapeHtml(a.coin || '') + (a.author ? ' توسط ' + adminEscapeHtml(a.author) : ''),
                        created_at: a.created_at,
                    });
                });
            }
            if (Array.isArray(ra.tickets)) {
                ra.tickets.forEach(function (t) {
                    activities.push({
                        type: 'user',
                        message: 'تیکت: ' + adminEscapeHtml(t.title || '') + ' (' + adminEscapeHtml(t.status || '') + ')',
                        created_at: t.created_at,
                    });
                });
            }
            // Sort by created_at DESC
            activities.sort(function (a, b) {
                return new Date(b.created_at || 0) - new Date(a.created_at || 0);
            });
            const topActivities = activities.slice(0, 10);

            if (topActivities.length === 0) {
                activityList.innerHTML = adminEmpty('فعالیتی اخیر وجود ندارد');
            } else {
                let actHtml = '';
                topActivities.forEach(function (act) {
                    const dotColor = act.type === 'admin' ? 'orange' :
                        act.type === 'error' ? 'red' :
                            act.type === 'user' ? 'blue' : 'green';
                    actHtml += '<div class="admin-activity-item">' +
                        '<div class="admin-activity-dot ' + dotColor + '"></div>' +
                        '<div style="flex:1;min-width:0;">' + act.message + '</div>' +
                        '<div class="admin-activity-time">' + adminFormatDate(act.created_at) + '</div>' +
                        '</div>';
                });
                activityList.innerHTML = actHtml;
            }
        }
    } catch (e) {
        grid.innerHTML = adminErrorState('بارگذاری داشبورد ناموفق بود', 'loadAdminDashboard');
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
        const data = await adminApiFetch('/api/system/status');
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
    container.innerHTML = adminSkeletonGrid(4);

    try {
        const data = await adminApiFetch('/api/admin/admins');
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
        container.innerHTML = adminErrorState('Failed to load admins', 'loadAdminList');
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
        await adminApiFetch('/api/admin/admins', {
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
        await adminApiFetch('/api/admin/admins/' + id, {
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
    adminApiFetch('/api/admin/admins/' + id, { method: 'DELETE' })
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
    container.innerHTML = adminSkeletonGrid(4);
    if (paginationEl) paginationEl.innerHTML = '';
    _adminUsersPage = page || 1;

    const token = _adminLoadToken;

    const searchInput = document.getElementById('admin-user-search');
    const search = searchInput ? searchInput.value.trim() : '';

    // PHASE 2: Load user stats cards at top of Users section.
    // Uses /api/admin/dashboard which returns all user metrics in one call.
    // No separate endpoint needed — reuses dashboard stats.
    loadUsersStats();

    try {
        let url = '/api/admin/users?page=' + _adminUsersPage;
        if (search) url += '&search=' + encodeURIComponent(search);
        const data = await adminApiFetch(url);
        if (_isLoadTokenStale(token)) return;

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
            // PHASE 2: Display real fields from backend (is_premium, is_active, language,
            // last_active, mini_app_opened_at, bot_joined_at). Previously these were blank.
            const statusBadge = u.is_active ? adminBadge('فعال', 'green') : adminBadge('غیرفعال', 'gray');
            const premiumBadge = u.is_premium ? adminBadge('Premium', 'orange') : '';
            const channelBadge = u.channel_joined ? adminBadge('عضو کانال', 'green') : '';
            const miniAppBadge = u.mini_app_opened_at ? adminBadge('Mini App', 'blue') : '';
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(u.first_name || u.name || 'User') +
                (u.last_name ? ' ' + adminEscapeHtml(u.last_name) : '') + '</span>' +
                premiumBadge + statusBadge + channelBadge + miniAppBadge +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                (u.username ? '@' + adminEscapeHtml(u.username) + ' &bull; ' : '') +
                'ID: ' + adminEscapeHtml(String(u.telegram_id || u.id || '')) +
                (u.language ? ' &bull; Lang: ' + adminEscapeHtml(u.language) : '') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'Joined: ' + adminFormatDate(u.created_at || u.join_date) +
                (u.last_active ? ' &bull; Last active: ' + adminFormatDate(u.last_active) : ' &bull; Last active: --') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-users-pagination', _adminUsersPage, totalPages, 'loadAdminUsers');
    } catch (e) {
        container.innerHTML = adminErrorState('Failed to load users', 'loadAdminUsers');
        console.error('loadAdminUsers:', e);
    }
}

/**
 * PHASE 2: Load user stats cards at top of Users section.
 * Fetches dashboard stats (which include all user metrics) and renders
 * 11 stat cards: Total, New Today/Week/Month, Joined Bot/Channel, Opened
 * Mini App, Join %, Active Today/Week/Month.
 */
async function loadUsersStats() {
    const grid = document.getElementById('admin-users-stats-grid');
    if (!grid) return;
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/dashboard');
        if (_isLoadTokenStale(token)) return; // Section switched, discard stale response
        if (!data || !data.stats) {
            // Show retry button instead of empty grid
            grid.innerHTML = '<div class="admin-empty" style="grid-column:1/-1;">داده آماری موجود نیست. <button onclick="loadUsersStats()" class="admin-btn" style="padding:4px 12px;font-size:11px;margin-right:8px;">تلاش مجدد</button></div>';
            return;
        }
        const s = data.stats;
        const fmt = function (v) { return (v == null) ? '--' : adminFormatNumber(v); };
        let html = '';
        html += adminStatCardV2(fmt(s.total_users), 'کل کاربران', 'users', 'blue');
        html += adminStatCardV2(fmt(s.new_today), 'جدید امروز', 'new', 'green');
        html += adminStatCardV2(fmt(s.new_this_week), 'جدید این هفته', 'week', 'purple');
        html += adminStatCardV2(fmt(s.new_this_month), 'جدید این ماه', 'month', 'purple');
        html += adminStatCardV2(fmt(s.joined_bot), 'بات را استارت زده‌اند', 'bot', 'blue');
        html += adminStatCardV2(fmt(s.joined_channel), 'عضو کانال', 'channel', 'green');
        html += adminStatCardV2(fmt(s.opened_mini_app), 'Mini App را باز کرده‌اند', 'app', 'blue');
        html += adminStatCardV2(fmt(s.join_percentage) + '%', 'درصد عضویت کانال', 'percent', 'orange');
        html += adminStatCardV2(fmt(s.active_today), 'فعال امروز', 'active-today', 'green');
        html += adminStatCardV2(fmt(s.active_this_week), 'فعال این هفته', 'active-week', 'green');
        html += adminStatCardV2(fmt(s.active_this_month), 'فعال این ماه', 'active-month', 'green');
        grid.innerHTML = html;
    } catch (e) {
        if (_isLoadTokenStale(token)) return; // Section switched, don't render error
        console.warn('loadUsersStats:', e);
        // Show retry button instead of empty grid
        grid.innerHTML = '<div class="admin-empty" style="grid-column:1/-1;color:#ef4444;">خطا در بارگذاری آمار. <button onclick="loadUsersStats()" class="admin-btn" style="padding:4px 12px;font-size:11px;margin-right:8px;">تلاش مجدد</button></div>';
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
    container.innerHTML = adminSkeletonGrid(4);
    if (paginationEl) paginationEl.innerHTML = '';
    _adminTicketsPage = page || 1;

    const token = _adminLoadToken;
    try {
        let url = '/api/admin/tickets?page=' + _adminTicketsPage;
        if (_adminTicketsFilter && _adminTicketsFilter !== 'all') {
            url += '&status=' + _adminTicketsFilter;
        }
        const data = await adminApiFetch(url);
        if (_isLoadTokenStale(token)) return;

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
        container.innerHTML = adminErrorState('Failed to load tickets', 'loadAdminTickets');
        console.error('loadAdminTickets:', e);
    }
}

function toggleAdminTicketDetail(ticketId) {
    _adminTicketsExpanded[ticketId] = !_adminTicketsExpanded[ticketId];
    loadAdminTickets(_adminTicketsPage);
    // PHASE 3 FIX (Bug 6): Fetch replies when expanding a ticket.
    // Previously replies were expected in the list response but never included
    // → conversation thread was always empty.
    if (_adminTicketsExpanded[ticketId]) {
        fetchTicketReplies(ticketId);
    }
}

/**
 * PHASE 3 FIX (Bug 6): Fetch ticket replies and render them into the
 * expanded ticket detail view. Called when a ticket is expanded.
 */
async function fetchTicketReplies(ticketId) {
    try {
        const data = await adminApiFetch('/api/admin/tickets/' + ticketId + '/replies');
        if (!data || !data.replies) return;
        const threadEl = document.querySelector('#adm-ticket-' + ticketId + ' .adm-ticket-thread');
        if (!threadEl) return; // ticket may have been collapsed
        let html = '';
        data.replies.forEach(function (r) {
            const isAdmin = r.is_admin_reply;
            html += '<div style="background:' + (isAdmin ? 'rgba(245,166,35,0.08)' : 'rgba(255,255,255,0.03)') + ';border-radius:10px;padding:10px 12px;' + (isAdmin ? 'border:1px solid rgba(245,166,35,0.15);' : '') + '">' +
                '<div style="font-size:11px;color:' + (isAdmin ? '#F5A623' : '#6B7A8D') + ';margin-bottom:4px;">' + (isAdmin ? 'Admin' : 'User') + ' • ' + adminFormatDate(r.created_at) + '</div>' +
                '<div style="white-space:pre-wrap;font-size:13px;color:#A5B4C7;">' + adminEscapeHtml(r.body || '') + '</div>' +
                '</div>';
        });
        threadEl.innerHTML = html;
    } catch (e) {
        console.warn('fetchTicketReplies:', e);
    }
}
window.fetchTicketReplies = fetchTicketReplies;

async function adminReplyTicket(ticketId) {
    var textarea = document.getElementById('adm-reply-' + ticketId);
    if (!textarea) return;
    var message = textarea.value.trim();
    if (!message) { showAdminToast('Reply cannot be empty', 'error'); return; }
    if (message.length > 1500) { showAdminToast('Reply too long (max 1500 chars)', 'error'); return; }
    try {
        await adminApiFetch('/api/admin/tickets/' + ticketId + '/reply', {
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
        await adminApiFetch('/api/admin/tickets/' + ticketId + '/status', {
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
        // PHASE 3 FIX (Bug 5): Use admin endpoint, not user endpoint.
        // Previous: /api/tickets/:id (user endpoint, no admin DELETE) → 403
        // Now: /api/admin/tickets/:id (admin DELETE)
        await adminApiFetch('/api/admin/tickets/' + ticketId, { method: 'DELETE' });
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

    // PHASE 3 FIX (Bug 1 — CRITICAL): Backend expects 'target_type' + 'target_value',
    // not 'target' + 'telegram_id'. Previous version sent wrong field names →
    // target_type was always undefined → defaulted to 'all' → ALL broadcasts
    // went to ALL users regardless of the dropdown selection.
    const targetType = targetSelect ? targetSelect.value : 'all';
    const payload = {
        target_type: targetType,
        target_value: null,
        message_type: 'text',
        content: contentInput.value.trim()
    };

    if (targetType === 'specific') {
        if (!targetIdInput || !targetIdInput.value.trim()) {
            showAdminToast('Please enter a Telegram ID', 'error');
            return;
        }
        payload.target_value = targetIdInput.value.trim();
    }

    try {
        await adminApiFetch('/api/admin/broadcasts', {
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
    container.innerHTML = adminSkeletonGrid(4);

    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/broadcasts');
        if (_isLoadTokenStale(token)) return;
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
            // PHASE 3 FIX (Bug 1): Read correct backend field names.
            // Backend returns: sender_id, sent_count, target_type, content, created_at
            // (was reading sent_by, recipients, target, message → all blank)
            const targetLabel = b.target_type === 'specific' ? ('→ ' + adminEscapeHtml(b.target_value || '')) :
                                b.target_type === 'channel_joined' ? 'عضو کانال' :
                                b.target_type === 'all' ? 'همه' : adminEscapeHtml(b.target_type || 'all');
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(b.content || b.message || '').substring(0, 60) +
                (String(b.content || b.message || '').length > 60 ? '...' : '') + '</span>' +
                adminBadge(targetLabel, 'blue') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'ارسال توسط: ' + adminEscapeHtml(b.sender_id || b.sent_by || b.admin_name || 'Admin') +
                (b.sent_count != null ? ' &bull; گیرندگان: ' + adminFormatNumber(b.sent_count) : '') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                adminFormatDate(b.created_at || b.sent_at || b.date) +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
    } catch (e) {
        container.innerHTML = adminErrorState('Failed to load broadcasts', 'loadAdminBroadcasts');
        console.error('loadAdminBroadcasts:', e);
    }
}

// ─── Rewards ────────────────────────────────────────────────

async function loadAdminRewards() {
    const container = document.getElementById('admin-rewards-list');
    if (!container) return;
    container.innerHTML = adminSkeletonGrid(4);

    const token = _adminLoadToken;
    try {
        let url = '/api/admin/rewards';
        if (_adminRewardsFilter && _adminRewardsFilter !== 'all') {
            url += '?status=' + _adminRewardsFilter;
        }
        const data = await adminApiFetch(url);
        if (_isLoadTokenStale(token)) return;

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
        container.innerHTML = adminErrorState('Failed to load rewards', 'loadAdminRewards');
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
    container.innerHTML = adminSkeletonGrid(4);
    if (paginationEl) paginationEl.innerHTML = '';
    _adminTransactionsPage = page || 1;

    const userIdInput = document.getElementById('admin-tx-user-id');
    const typeSelect = document.getElementById('admin-tx-type');
    const userId = userIdInput ? userIdInput.value.trim() : '';
    const txType = typeSelect ? typeSelect.value : '';

    const token = _adminLoadToken;
    try {
        let url = '/api/admin/transactions?page=' + _adminTransactionsPage;
        if (userId) url += '&user_id=' + encodeURIComponent(userId);
        if (txType) url += '&type=' + encodeURIComponent(txType);
        const data = await adminApiFetch(url);
        if (_isLoadTokenStale(token)) return;

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
            // PHASE 3 FIX: Backend returns 'tx_type' (not 'type') and 'ref_id' (not 'tx_hash').
            // Map both for compatibility.
            const txType = tx.tx_type || tx.type || '';
            const typeLabel = {
                daily_claim: 'Daily Claim',
                referral: 'Referral',
                referral_reward: 'Referral Reward',
                admin_grant: 'Admin Grant',
                wheel: 'Wheel',
                wheel_reward: 'Wheel Reward',
                deposit: 'Deposit',
                withdrawal: 'Withdrawal',
                mission: 'Mission',
                mission_reward: 'Mission Reward',
            };
            const displayType = typeLabel[txType] || txType || 'Transaction';
            const refId = tx.ref_id || tx.tx_hash || '';
            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(displayType) + '</span>' +
                adminBadge(String(tx.amount || tx.tokens || 0) + ' AB', 'green') +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'کاربر: ' + adminEscapeHtml(tx.user_name || tx.username || 'User') +
                ' (ID: ' + adminEscapeHtml(String(tx.telegram_id || tx.user_id || '')) + ')' +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                adminFormatDate(tx.created_at || tx.date) +
                (refId ? ' &bull; Ref: ' + adminEscapeHtml(String(refId).substring(0, 16)) : '') +
                (tx.description ? ' &bull; ' + adminEscapeHtml(tx.description) : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-transactions-pagination', _adminTransactionsPage, totalPages, 'loadAdminTransactions');
    } catch (e) {
        container.innerHTML = adminErrorState('Failed to load transactions', 'loadAdminTransactions');
        console.error('loadAdminTransactions:', e);
    }
}

// ─── Referrals ──────────────────────────────────────────────

async function loadAdminReferrals() {
    const container = document.getElementById('admin-referrals-list');
    if (!container) return;
    container.innerHTML = adminSkeletonGrid(4);

    const searchInput = document.getElementById('admin-referral-search');
    const search = searchInput ? searchInput.value.trim() : '';

    const token = _adminLoadToken;
    try {
        let url = '/api/admin/referrals';
        if (search) url += '?search=' + encodeURIComponent(search);
        const data = await adminApiFetch(url);
        if (_isLoadTokenStale(token)) return;

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
        container.innerHTML = adminErrorState('Failed to load referrals', 'loadAdminReferrals');
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
    grid.innerHTML = '<div class="admin-empty">در حال بررسی سرویس‌ها...</div>';

    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/system-health');
        if (_isLoadTokenStale(token)) return;
        if (!data) throw new Error('No data');

        let html = '';

        // Summary card at top
        if (data.summary) {
            const sum = data.summary;
            const overallStatus = sum.down > 0 ? '🔴' : (sum.warning > 0 ? '🟡' : '🟢');
            const overallText = sum.down > 0 ? 'سیستم دارای مشکل' : (sum.warning > 0 ? 'سیستم با هشدار' : 'سیستم سالم');
            html += '<div class="adm-health-summary" style="grid-column:1/-1;padding:16px;border-radius:12px;background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);margin-bottom:8px;">' +
                '<div style="font-size:24px;">' + overallStatus + '</div>' +
                '<div style="font-size:18px;font-weight:700;margin-top:4px;">' + overallText + '</div>' +
                '<div style="font-size:13px;color:#a0aec0;margin-top:4px;">' +
                '🟢 ' + sum.healthy + ' سالم &nbsp; • &nbsp; ' +
                '🟡 ' + sum.warning + ' هشدار &nbsp; • &nbsp; ' +
                '🔴 ' + sum.down + ' از کار افتاده' +
                '</div>' +
                '<div style="font-size:11px;color:#718096;margin-top:8px;">آخرین بررسی: ' + adminFormatDate(data.timestamp) + '</div>' +
                '</div>';
        }

        // Service cards
        if (data.services) {
            const labels = {
                database: 'دیتابیس PostgreSQL',
                telegram: 'Telegram Bot API',
                coinmarketcap: 'CoinMarketCap',
                alternative_me: 'Alternative.me (Fear & Greed)',
                cloudflare_kv: 'Cloudflare KV',
                workers_ai: 'Cloudflare Workers AI',
                cron: 'Cron Scheduler',
                notification_queue: 'صف اعلان‌ها',
            };
            const statusIcon = { healthy: '🟢', warning: '🟡', down: '🔴' };
            const statusText = { healthy: 'سالم', warning: 'هشدار', down: 'از کار افتاده' };
            const statusColor = { healthy: '#22c55e', warning: '#f59e0b', down: '#ef4444' };

            Object.keys(data.services).forEach(function (key) {
                const svc = data.services[key];
                const icon = statusIcon[svc.status] || '⚪';
                const color = statusColor[svc.status] || '#a0aec0';
                const label = labels[key] || key;
                const latency = svc.latency_ms != null ? svc.latency_ms + 'ms' : '';
                const detail = svc.detail || svc.error || '';

                html += '<div class="adm-health-card" style="padding:12px;border-radius:10px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">' +
                    '<div style="display:flex;align-items:center;gap:8px;margin-bottom:6px;">' +
                        '<span style="font-size:18px;">' + icon + '</span>' +
                        '<span style="font-weight:600;font-size:14px;">' + adminEscapeHtml(label) + '</span>' +
                    '</div>' +
                    '<div style="font-size:12px;color:' + color + ';font-weight:600;">' + (statusText[svc.status] || svc.status) + '</div>' +
                    (latency ? '<div style="font-size:11px;color:#a0aec0;margin-top:4px;">latency: ' + latency + '</div>' : '') +
                    (detail ? '<div style="font-size:11px;color:#718096;margin-top:2px;">' + adminEscapeHtml(detail) + '</div>' : '') +
                    '</div>';
            });
        }

        grid.innerHTML = html || adminEmpty('داده‌ای موجود نیست');
    } catch (e) {
        grid.innerHTML = adminEmpty('بارگذاری وضعیت سیستم ناموفق بود');
        console.error('loadAdminSystemHealth:', e);
    }
}

// ─── Security Logs ──────────────────────────────────────────

async function loadAdminLogs(page) {
    const container = document.getElementById('admin-logs-list');
    const paginationEl = document.getElementById('admin-logs-pagination');
    if (!container) return;
    container.innerHTML = adminSkeletonGrid(4);
    if (paginationEl) paginationEl.innerHTML = '';
    _adminLogsPage = page || 1;

    const token = _adminLoadToken;
    try {
        const url = '/api/admin/logs?page=' + _adminLogsPage;
        const data = await adminApiFetch(url);
        if (_isLoadTokenStale(token)) return;

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
        container.innerHTML = adminErrorState('Failed to load logs', 'loadAdminLogs');
        console.error('loadAdminLogs:', e);
    }
}

// ─── Register all functions on window for inline onclick ────
// PERFORMANCE: Use _realOpenAdminPanel instead of openAdminPanel so that
// app.js's lazy loader (openAdminPanelLazy) can call the real function
// after admin.js is dynamically loaded.
window._realOpenAdminPanel = openAdminPanel;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/overview');
        if (_isLoadTokenStale(token)) return;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/wheel/config');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/wheel/config', { method: 'PUT', body: JSON.stringify(payload) });
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/wheel/rewards');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/wheel/rewards', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('پاداش ایجاد شد', 'success'); loadRcWheelRewards(); }
        else { adminToast('خطا در ایجاد', 'error'); }
    } catch (e) { adminToast('خطا در ایجاد', 'error'); console.error(e); }
}
window.createRcWheelReward = createRcWheelReward;

async function toggleRcWheelReward(id, makeActive) {
    try {
        const data = await adminApiFetch('/api/admin/reward-center/wheel/rewards/' + id, { method: 'PUT', body: JSON.stringify({ is_active: makeActive }) });
        if (data && data.status === 'success') { adminToast('وضعیت تغییر کرد', 'success'); loadRcWheelRewards(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.toggleRcWheelReward = toggleRcWheelReward;

async function deleteRcWheelReward(id) {
    if (!confirm('حذف این پاداش؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/wheel/rewards/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcWheelRewards(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcWheelReward = deleteRcWheelReward;

// ─── Referral Tiers ─────────────────────────────────────────

async function loadRcReferralTiers() {
    const section = document.getElementById('rc-referral-tiers-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/referral-tiers');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/referral-tiers', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcReferralTiers(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcReferralTier = createRcReferralTier;

async function deleteRcReferralTier(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/referral-tiers/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcReferralTiers(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcReferralTier = deleteRcReferralTier;

// ─── Mission Rewards ────────────────────────────────────────

async function loadRcMissionRewards() {
    const section = document.getElementById('rc-mission-rewards-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/mission-rewards');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/mission-rewards', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcMissionRewards(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcMissionReward = createRcMissionReward;

async function deleteRcMissionReward(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/mission-rewards/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcMissionRewards(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcMissionReward = deleteRcMissionReward;

// ─── Campaigns ──────────────────────────────────────────────

async function loadRcCampaigns() {
    const section = document.getElementById('rc-campaigns-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/campaigns');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/campaigns', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcCampaigns(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcCampaign = createRcCampaign;

async function deleteRcCampaign(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/campaigns/' + encodeURIComponent(id), { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcCampaigns(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcCampaign = deleteRcCampaign;

// ─── Reward Library ─────────────────────────────────────────

async function loadRcLibrary() {
    const section = document.getElementById('rc-library-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/library');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/library', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ایجاد شد', 'success'); loadRcLibrary(); }
        else { adminToast('خطا', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createRcLibraryItem = createRcLibraryItem;

async function deleteRcLibraryItem(id) {
    if (!confirm('حذف؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/library/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('حذف شد', 'success'); loadRcLibrary(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.deleteRcLibraryItem = deleteRcLibraryItem;

// ─── Analytics ──────────────────────────────────────────────

async function loadRcAnalytics() {
    const section = document.getElementById('rc-analytics-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/analytics?range=30d');
        if (_isLoadTokenStale(token)) return;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/reward-center/emergency');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/reward-center/emergency', { method: 'PUT', body: JSON.stringify(payload) });
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/notifications/analytics?range=7d');
        if (_isLoadTokenStale(token)) return;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/notifications/broadcasts?limit=20');
        if (_isLoadTokenStale(token)) return;
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
        const data = await adminApiFetch('/api/admin/notifications/broadcasts', { method: 'POST', body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('ارسال شد: ' + (data.sent || 0) + ' کاربر', 'success'); loadNpBroadcast(); }
        else { adminToast('خطا در ارسال', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.createNpBroadcast = createNpBroadcast;

async function sendNpBroadcast(id) {
    try {
        const data = await adminApiFetch('/api/admin/notifications/broadcasts/' + id + '/send', { method: 'POST' });
        if (data && data.status === 'success') { adminToast('ارسال شد: ' + (data.sent || 0) + ' کاربر', 'success'); loadNpBroadcast(); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.sendNpBroadcast = sendNpBroadcast;

async function loadNpTemplates() {
    const section = document.getElementById('np-templates-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty">در حال بارگذاری...</div>';
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/notifications/templates');
        if (_isLoadTokenStale(token)) return;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/notifications/analytics?range=30d');
        if (_isLoadTokenStale(token)) return;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/alert-economy/dashboard');
        if (_isLoadTokenStale(token)) return;
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
    const token = _adminLoadToken;
    try {
        const data = await adminApiFetch('/api/admin/alert-economy/configs');
        if (_isLoadTokenStale(token)) return;
        if (data && data.status === 'success' && Array.isArray(data.configs)) {
            // PHASE 5: Full config UI — each alert type has a card with toggle + inputs
            const labels = {
                price_alert: 'هشدار قیمت',
                calendar_alert: 'هشدار تقویم اقتصادی',
                breaking_news: 'هشدار اخبار فوری',
            };
            const cards = data.configs.map(function (c) {
                const label = labels[c.alert_type] || c.alert_type;
                const enabledChecked = c.is_enabled ? 'checked' : '';
                return '<div class="rc-config-card" style="padding:16px;border-radius:14px;background:rgba(255,255,255,0.03);border:1px solid rgba(255,255,255,0.06);">' +
                    '<div style="display:flex;align-items:center;justify-content:space-between;margin-bottom:12px;">' +
                        '<div style="font-weight:700;font-size:14px;">' + adminEscapeHtml(label) + '</div>' +
                        '<label class="adm-switch" style="position:relative;display:inline-block;width:44px;height:24px;">' +
                            '<input type="checkbox" id="ae-cfg-enabled-' + adminEscapeHtml(c.alert_type) + '" ' + enabledChecked + ' style="opacity:0;width:0;height:0;">' +
                            '<span class="adm-slider" style="position:absolute;cursor:pointer;top:0;left:0;right:0;bottom:0;background:' + (c.is_enabled ? '#22c55e' : '#475569') + ';border-radius:24px;transition:0.3s;">' +
                                '<span style="position:absolute;height:18px;width:18px;left:3px;top:3px;background:white;border-radius:50%;transition:0.3s;' + (c.is_enabled ? 'transform:translateX(20px);' : '') + '"></span>' +
                            '</span>' +
                        '</label>' +
                    '</div>' +
                    '<div style="display:grid;grid-template-columns:1fr 1fr;gap:12px;">' +
                        '<div><label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">رایگان در روز</label>' +
                            '<input type="number" id="ae-cfg-free-' + adminEscapeHtml(c.alert_type) + '" value="' + c.free_per_day + '" min="0" class="adm-input" style="padding:8px;border-radius:8px;">' +
                        '</div>' +
                        '<div><label style="font-size:12px;color:#94a3b8;display:block;margin-bottom:4px;">هزینه اضافه (AB)</label>' +
                            '<input type="number" id="ae-cfg-cost-' + adminEscapeHtml(c.alert_type) + '" value="' + c.cost_per_extra + '" min="0" class="adm-input" style="padding:8px;border-radius:8px;">' +
                        '</div>' +
                    '</div>' +
                    '<button class="adm-btn adm-btn-primary" onclick="saveAlertConfig(\'' + adminEscapeHtml(c.alert_type) + '\')" style="margin-top:12px;padding:8px 20px;font-size:12px;">ذخیره</button>' +
                '</div>';
            }).join('');
            section.innerHTML = '<div style="display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px;">' + (cards || '<div class="admin-empty">داده‌ای نیست</div>') + '</div>';
        }
    } catch (e) { section.innerHTML = adminErrorState('خطا در بارگذاری', 'loadAlertEconomyConfigs'); console.error(e); }
}
window.loadAlertEconomyConfigs = loadAlertEconomyConfigs;

async function saveAlertConfig(alertType) {
    const isEnabled = document.getElementById('ae-cfg-enabled-' + alertType)?.checked;
    const freePerDay = Number(document.getElementById('ae-cfg-free-' + alertType)?.value || 0);
    const costPerExtra = Number(document.getElementById('ae-cfg-cost-' + alertType)?.value || 0);
    try {
        const data = await adminApiFetch('/api/admin/alert-economy/configs/' + encodeURIComponent(alertType), {
            method: 'PUT',
            body: JSON.stringify({
                is_enabled: isEnabled,
                free_per_day: freePerDay,
                cost_per_extra: costPerExtra,
            }),
        });
        if (data && data.status === 'success') { adminToast('تنظیمات ذخیره شد', 'success'); loadAlertEconomyConfigs(); }
        else { adminToast('خطا در ذخیره', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error(e); }
}
window.saveAlertConfig = saveAlertConfig;

// ── Missing window exports for ticket admin functions ──
window.adminReplyTicket = adminReplyTicket;
window.adminSetTicketStatus = adminSetTicketStatus;
window.adminDeleteTicket = adminDeleteTicket;
window.toggleAdminTicketDetail = toggleAdminTicketDetail;

// ════════════════════════════════════════════════════════════════════
// TELEGRAM PUBLISHER — channel publishing system
// All UI logic for the Publisher admin section.
// ════════════════════════════════════════════════════════════════════

let _pubCurrentTab = 'news';
let _pubNewsCache = [];
let _pubCalendarCache = [];
let _pubAnalysisCache = [];
let _pubLastPreview = null;
let _pubSelectedNews = new Set();
let _pubQueueCache = [];
let _pubSentCache = [];
let _pubFailedCache = [];
let _pubLogsCache = [];
let _pubAutoRefreshTimer = null;
let _pubStatsLastError = null;
let _pubSmartFilters = { news: new Set(), calendar: new Set(), analysis: new Set() };

// Smart filter toggle — adds/removes filter from active set, re-renders list
function toggleSmartFilter(tab, filter, btn) {
    const activeSet = _pubSmartFilters[tab];
    if (!activeSet) return;
    if (activeSet.has(filter)) {
        activeSet.delete(filter);
        btn.classList.remove('active');
    } else {
        activeSet.add(filter);
        btn.classList.add('active');
    }
    // Re-apply filters to the cached list
    if (tab === 'news' && _pubNewsCache.length) {
        const searchQ = document.getElementById('tgpub-news-search')?.value || '';
        if (searchQ) filterPubNews(searchQ);
        else renderPublisherNewsList(_pubNewsCache);
    } else if (tab === 'calendar' && _pubCalendarCache.length) {
        renderPublisherCalendarList(_pubCalendarCache);
    } else if (tab === 'analysis' && _pubAnalysisCache.length) {
        const searchQ = document.getElementById('tgpub-analysis-search')?.value || '';
        if (searchQ) filterPubAnalysis(searchQ);
        else renderPublisherAnalysisList(_pubAnalysisCache);
    }
}
window.toggleSmartFilter = toggleSmartFilter;

// Apply smart filters to news items
function applyNewsSmartFilters(items) {
    const filters = _pubSmartFilters.news;
    if (!filters.size) return items;
    const now = new Date();
    const todayStr = now.toDateString();
    return items.filter(a => {
        for (const f of filters) {
            if (f === 'breaking' && !(a.is_breaking || a.priority === 'breaking')) return false;
            if (f === 'important' && !(a.priority === 'important' || a.important)) return false;
            if (f === 'ai-ready' && !(a.ai_summary && a.ai_summary.length > 50)) return false;
            if (f === 'unpublished' && a.published) return false;
            if (f === 'today') {
                const aDate = a.published_at || a.created_at;
                if (!aDate || new Date(aDate).toDateString() !== todayStr) return false;
            }
        }
        return true;
    });
}

// Apply smart filters to calendar items
function applyCalendarSmartFilters(items) {
    const filters = _pubSmartFilters.calendar;
    if (!filters.size) return items;
    const now = new Date();
    const todayStr = now.toDateString();
    return items.filter(e => {
        for (const f of filters) {
            if (f === 'high' && String(e.impact || '').toLowerCase() !== 'high') return false;
            if (f === 'medium' && String(e.impact || '').toLowerCase() !== 'medium') return false;
            if (f === 'low' && String(e.impact || '').toLowerCase() !== 'low') return false;
            if (f === 'today') {
                const eDate = e.timestamp || e.time;
                if (!eDate || new Date(eDate).toDateString() !== todayStr) return false;
            }
            if (f === 'future') {
                const eDate = e.timestamp || e.time;
                if (!eDate || new Date(eDate) <= now) return false;
            }
        }
        return true;
    });
}

// Apply smart filters to analysis items
function applyAnalysisSmartFilters(items) {
    const filters = _pubSmartFilters.analysis;
    if (!filters.size) return items;
    const now = Date.now();
    const dayAgo = now - 24 * 60 * 60 * 1000;
    return items.filter(a => {
        for (const f of filters) {
            if (f === 'btc' && String(a.coin || '').toUpperCase() !== 'BTC') return false;
            if (f === 'eth' && String(a.coin || '').toUpperCase() !== 'ETH') return false;
            if (f === 'buy' && !/buy|خرید|long|صعود/i.test(a.title + ' ' + (a.content || ''))) return false;
            if (f === 'sell' && !/sell|فروش|short|نزول/i.test(a.title + ' ' + (a.content || ''))) return false;
            if (f === 'new') {
                const cDate = a.created_at ? new Date(a.created_at).getTime() : 0;
                if (cDate < dayAgo) return false;
            }
            if (f === 'featured' && !a.featured) return false;
        }
        return true;
    });
}

// Skeleton loader HTML generator (card-shaped shimmer placeholders)
function pubSkeleton(rows) {
    rows = rows || 3;
    let html = '';
    for (let i = 0; i < rows; i++) {
        html += '<div class="pub-card tgpub-skeleton">' +
            '<div class="pub-card-top">' +
                '<div class="pub-sk-media"></div>' +
                '<div class="pub-card-body">' +
                    '<div class="pub-sk-line" style="width:' + (50 + Math.random() * 30) + '%"></div>' +
                    '<div class="pub-sk-line" style="width:80%;margin-top:8px"></div>' +
                    '<div class="pub-sk-line" style="width:60%;margin-top:6px"></div>' +
                '</div>' +
            '</div>' +
            '<div class="pub-card-actions">' +
                '<div class="pub-sk-btn"></div>' +
                '<div class="pub-sk-btn"></div>' +
                '<div class="pub-sk-btn"></div>' +
            '</div>' +
        '</div>';
    }
    return html;
}

function pubShowEmpty(tabName, hasItems) {
    const emptyEl = document.getElementById('tgpub-' + tabName + '-empty');
    if (emptyEl) emptyEl.style.display = hasItems ? 'none' : 'flex';
}

function pubShowListEmpty(tabName, hasItems, emptyMsg) {
    // For tabs without dedicated empty state element (queue/sent/failed/logs)
    const listEl = document.getElementById('tgpub-' + tabName + '-list');
    if (!listEl) return;
    if (!hasItems) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline">' + (emptyMsg || 'موردی یافت نشد') + '</div>';
    }
}

function faNum(n) {
    try { return String(Number(n) || 0).replace(/\d/g, d => '۰۱۲۳۴۵۶۷۸۹'[+d]); } catch { return '۰'; }
}

function adminFormatDatePub(iso) {
    if (!iso) return '—';
    try {
        const d = new Date(iso);
        return d.toLocaleString('fa-IR', { year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
    } catch { return iso; }
}

// ── Entry point: called by switchAdminSection when 'publisher' is selected ──
async function loadPublisherOverview() {
    await loadPublisherStats();
    // Don't auto-load heavy lists — wait for user to click load buttons.
    // But if news tab is active, auto-load news (most common entry point).
    if (_pubCurrentTab === 'news') {
        loadPublisherNews(1);
    }
}
window.loadPublisherOverview = loadPublisherOverview;

async function loadPublisherStats() {
    // Avoid spamming console with the same auth error — only log once
    try {
        const data = await adminApiFetch('/api/admin/publisher/stats');
        _pubStatsLastError = null;
        if (data && data.status === 'success' && data.stats) {
            const el = (id) => document.getElementById(id);
            if (el('tgpub-stat-pending')) el('tgpub-stat-pending').textContent = faNum(data.stats.pending || 0);
            if (el('tgpub-stat-sent')) el('tgpub-stat-sent').textContent = faNum(data.stats.sent_24h || 0);
            if (el('tgpub-stat-failed')) el('tgpub-stat-failed').textContent = faNum(data.stats.failed_24h || 0);
        }
    } catch (e) {
        const msg = e?.message || String(e);
        if (_pubStatsLastError !== msg) {
            _pubStatsLastError = msg;
            console.warn('loadPublisherStats failed:', msg);
        }
    }
}
window.loadPublisherStats = loadPublisherStats;

function switchPublisherTab(tab, btn) {
    _pubCurrentTab = tab;
    document.querySelectorAll('.pub-tab').forEach(t => t.classList.remove('active'));
    if (btn) btn.classList.add('active');
    else {
        const target = document.querySelector('.pub-tab[data-pub-tab="' + tab + '"]');
        if (target) target.classList.add('active');
    }
    document.querySelectorAll('.tgpub-panel').forEach(c => c.classList.remove('active'));
    const content = document.getElementById('tgpub-panel-' + tab);
    if (content) content.classList.add('active');

    // Auto-load when entering a tab
    if (tab === 'settings') loadPublisherSettings();
    if (tab === 'queue') loadPublisherQueue();
    if (tab === 'sent') loadPublisherSent();
    if (tab === 'failed') loadPublisherFailed();
    if (tab === 'logs') loadPublisherLogs();
    loadPublisherStats();
}
window.switchPublisherTab = switchPublisherTab;

// ── News tab ──
async function loadPublisherNews(page) {
    page = page || 1;
    const listEl = document.getElementById('tgpub-news-list');
    const emptyEl = document.getElementById('tgpub-news-empty');
    if (!listEl) return;
    // Show skeleton during load
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = pubSkeleton(5);
    try {
        const data = await adminApiFetch('/api/farsi-news?page=1&limit=50');
        const items = (data && data.data) || [];
        _pubNewsCache = items;
        _pubSelectedNews = new Set();
        renderPublisherNewsList(items);
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="64" height="64"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<h4>خطا در بارگذاری اخبار</h4>' +
            '<p>' + adminEscapeHtml((e.message || 'خطای ناشناخته').slice(0, 200)) + '</p>' +
            '<button class="adm-btn adm-btn-primary" onclick="loadPublisherNews(1)">تلاش مجدد</button>' +
        '</div>';
        console.error(e);
    }
}
window.loadPublisherNews = loadPublisherNews;

let _pubNewsSearchDebounce = null;
function debounceFilterNews(q) {
    // Show/hide clear button
    const clearBtn = document.getElementById('pub-news-clear');
    if (clearBtn) clearBtn.style.display = q ? 'flex' : 'none';
    // Debounce 250ms
    if (_pubNewsSearchDebounce) clearTimeout(_pubNewsSearchDebounce);
    _pubNewsSearchDebounce = setTimeout(() => filterPubNews(q), 250);
}
window.debounceFilterNews = debounceFilterNews;

function clearPubSearch(tab) {
    const input = document.getElementById('tgpub-' + tab + '-search');
    if (input) { input.value = ''; input.focus(); }
    const clearBtn = document.getElementById('pub-' + tab + '-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    if (tab === 'news') filterPubNews('');
    else if (tab === 'analysis') filterPubAnalysis('');
}
window.clearPubSearch = clearPubSearch;

function filterPubNews(q) {
    if (!_pubNewsCache.length) return;
    // First apply smart filters
    let items = applyNewsSmartFilters(_pubNewsCache);
    const qq = String(q || '').toLowerCase().trim();
    if (qq) {
        items = items.filter(a =>
            (a.title || '').toLowerCase().includes(qq) || (a.body || '').toLowerCase().includes(qq)
        );
    }
    renderPublisherNewsList(items);
}
window.filterPubNews = filterPubNews;

function renderPublisherNewsList(items) {
    // Apply smart filters if any are active
    items = applyNewsSmartFilters(items);
    const listEl = document.getElementById('tgpub-news-list');
    const emptyEl = document.getElementById('tgpub-news-empty');
    if (!listEl) return;
    if (!items || !items.length) {
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = items.slice(0, 30).map(a => {
        let h = 0; const s = String(a.url || '');
        for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h = ((h << 5) - h) + ch; h = h & h; }
        const refId = a.url_hash || Math.abs(h).toString(36);
        const isSelected = _pubSelectedNews.has(refId);
        const hasAi = !!(a.ai_summary && a.ai_summary.length > 50);
        const aiSvg = hasAi
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
        const aiBadge = '<span class="pub-badge ' + (hasAi ? 'tgpub-badge-ai' : 'tgpub-badge-pending') + '">' + aiSvg + '<span>' + (hasAi ? 'AI' : 'در انتظار') + '</span></span>';
        const img = a.image
            ? '<div class="pub-card-media"><img src="' + adminEscapeHtml(a.image) + '" loading="lazy" onerror="this.parentElement.style.display=\'none\'"></div>'
            : '<div class="pub-card-media tgpub-card-media-placeholder"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg></div>';
        const title = adminEscapeHtml((a.title || '').slice(0, 120));
        const summary = adminEscapeHtml((a.ai_summary || a.body || '').slice(0, 150));
        const source = adminEscapeHtml(a.source_name || a.source || '—');
        const newsIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/></svg>';
        const previewIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        const queueIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/><line x1="3" y1="6" x2="3.01" y2="6"/><line x1="3" y1="12" x2="3.01" y2="12"/><line x1="3" y1="18" x2="3.01" y2="18"/></svg>';
        const sendIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        return '<div class="pub-card' + (isSelected ? ' tgpub-card-selected' : '') + '" data-ref-id="' + adminEscapeHtml(refId) + '">' +
            '<div class="pub-card-header">' +
                '<div class="pub-card-badges">' +
                    '<span class="pub-badge tgpub-badge-type">' + newsIcon + '<span>خبر</span></span>' +
                    aiBadge +
                '</div>' +
                '<label class="pub-card-checkbox">' +
                    '<input type="checkbox" ' + (isSelected ? 'checked' : '') + ' onchange="toggleNewsSelect(\'' + adminEscapeHtml(refId) + '\', this.checked)">' +
                    '<span class="pub-card-checkbox-box"></span>' +
                '</label>' +
            '</div>' +
            '<div class="pub-card-content">' +
                img +
                '<div class="pub-card-body">' +
                    '<div class="pub-card-title">' + title + '</div>' +
                    (summary ? '<div class="pub-card-summary">' + summary + '</div>' : '') +
                    '<div class="pub-card-meta">' +
                        '<span class="pub-badge tgpub-badge-src">' + source + '</span>' +
                        '<span class="pub-badge tgpub-badge-ref">' + adminEscapeHtml(refId) + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="pub-card-actions">' +
                '<button class="adm-btn adm-btn-ghost" onclick="openPublisherPreview(\'news\',\'' + adminEscapeHtml(refId) + '\')">' + previewIcon + '<span>پیش‌نمایش</span></button>' +
                '<button class="adm-btn adm-btn-ghost" onclick="enqueuePublisher(\'news\',\'' + adminEscapeHtml(refId) + '\')">' + queueIcon + '<span>به صف</span></button>' +
                '<button class="adm-btn adm-btn-primary" onclick="sendNowPublisher(\'news\',\'' + adminEscapeHtml(refId) + '\')">' + sendIcon + '<span>ارسال فوری</span></button>' +
            '</div>' +
        '</div>';
    }).join('');
    updateNewsBulkButton();
}

function toggleNewsSelect(refId, checked) {
    if (checked) _pubSelectedNews.add(refId);
    else _pubSelectedNews.delete(refId);
    // Update visual state
    const item = document.querySelector('.pub-card[data-ref-id="' + refId + '"]');
    if (item) item.classList.toggle('tgpub-card-selected', checked);
    updateNewsBulkButton();
    // Update "select all" checkbox state
    const selectAll = document.getElementById('tgpub-news-select-all');
    if (selectAll) {
        const visibleItems = _pubNewsCache.slice(0, 30);
        selectAll.checked = visibleItems.length > 0 && visibleItems.every(a => {
            let h = 0; const s = String(a.url || '');
            for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h = ((h << 5) - h) + ch; h = h & h; }
            return _pubSelectedNews.has(a.url_hash || Math.abs(h).toString(36));
        });
    }
}
window.toggleNewsSelect = toggleNewsSelect;

function toggleSelectAllNews(checked) {
    if (checked) {
        _pubNewsCache.slice(0, 30).forEach(a => {
            let h = 0; const s = String(a.url || '');
            for (let i = 0; i < s.length; i++) { const ch = s.charCodeAt(i); h = ((h << 5) - h) + ch; h = h & h; }
            _pubSelectedNews.add(a.url_hash || Math.abs(h).toString(36));
        });
    } else {
        _pubSelectedNews.clear();
    }
    renderPublisherNewsList(_pubNewsCache);
}
window.toggleSelectAllNews = toggleSelectAllNews;

function updateNewsBulkButton() {
    const btn = document.getElementById('tgpub-news-bulk-btn');
    const cnt = document.getElementById('tgpub-news-sel-count');
    const bar = document.getElementById('tgpub-news-bulk-bar');
    const count = _pubSelectedNews.size;
    if (cnt) cnt.textContent = faNum(count);
    if (btn) btn.disabled = count === 0;
    // Show/hide bulk bar based on selection
    if (bar) bar.classList.toggle('pub-bulk-bar-active', count > 0);
}

function clearNewsSelection() {
    _pubSelectedNews.clear();
    renderPublisherNewsList(_pubNewsCache);
    updateNewsBulkButton();
}
window.clearNewsSelection = clearNewsSelection;

async function bulkPublishNews() {
    if (!_pubSelectedNews.size) return;
    if (!confirm('انتخاب ' + _pubSelectedNews.size + ' خبر به صف انتشار اضافه شود؟')) return;
    let success = 0, failed = 0;
    for (const refId of _pubSelectedNews) {
        try {
            const data = await adminApiFetch('/api/admin/publisher/queue', {
                method: 'POST',
                body: JSON.stringify({ type: 'news', ref_id: refId }),
            });
            if (data && data.status === 'success') success++;
            else failed++;
        } catch { failed++; }
    }
    adminToast('✅ ' + faNum(success) + ' اضافه شد' + (failed ? '، ❌ ' + faNum(failed) + ' ناموفق' : ''), failed ? 'error' : 'success');
    _pubSelectedNews.clear();
    renderPublisherNewsList(_pubNewsCache);
    loadPublisherStats();
}
window.bulkPublishNews = bulkPublishNews;

// ── Calendar tab ──
async function loadPublisherCalendar() {
    const listEl = document.getElementById('tgpub-calendar-list');
    const emptyEl = document.getElementById('tgpub-calendar-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = pubSkeleton(4);
    try {
        const data = await adminApiFetch('/api/calendar/events');
        const items = (data && data.events) || data || [];
        _pubCalendarCache = items;
        renderPublisherCalendarList(items);
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="64" height="64"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<h4>خطا در بارگذاری</h4>' +
            '<p>' + adminEscapeHtml((e.message || 'خطای ناشناخته').slice(0, 200)) + '</p>' +
            '<button class="adm-btn adm-btn-primary" onclick="loadPublisherCalendar()">تلاش مجدد</button>' +
        '</div>';
        console.error(e);
    }
}
window.loadPublisherCalendar = loadPublisherCalendar;

function filterPubCalendar() {
    if (!_pubCalendarCache.length) return;
    renderPublisherCalendarList(_pubCalendarCache);
}
window.filterPubCalendar = filterPubCalendar;

function renderPublisherCalendarList(items) {
    // Apply smart filters if any are active
    items = applyCalendarSmartFilters(items);
    const listEl = document.getElementById('tgpub-calendar-list');
    const emptyEl = document.getElementById('tgpub-calendar-empty');
    if (!listEl) return;
    if (!items || !items.length) {
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = items.slice(0, 30).map(e => {
        const refId = String(e.id || e.event_id || '').slice(0, 64) || String(e.title || '').slice(0, 64);
        const impact = String(e.impact || '').toLowerCase();
        const impactClass = 'tgpub-badge-impact-' + (impact || 'low');
        const impactLabel = impact === 'high' ? 'High' : impact === 'medium' ? 'Medium' : 'Low';
        const impactDot = impact === 'high' ? '#ef4444' : impact === 'medium' ? '#f5a623' : '#22c55e';
        const calIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>';
        const impactBadge = '<span class="pub-badge ' + impactClass + '"><span class="pub-impact-dot" style="background:' + impactDot + '"></span><span>' + adminEscapeHtml(impactLabel) + '</span></span>';
        const country = adminEscapeHtml(e.country || '');
        const title = adminEscapeHtml((e.title || e.event || '').slice(0, 120));
        const time = adminEscapeHtml(e.time || '—');
        const forecast = e.forecast ? adminEscapeHtml(e.forecast) : '—';
        const previous = e.previous ? adminEscapeHtml(e.previous) : '—';
        const previewIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        const queueIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg>';
        const sendIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        const timeIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
        return '<div class="pub-card" data-ref-id="' + adminEscapeHtml(refId) + '">' +
            '<div class="pub-card-body">' +
                '<div class="pub-card-badges">' +
                    '<span class="pub-badge tgpub-badge-type">' + calIcon + '<span>تقویم</span></span>' +
                    impactBadge +
                    (country ? '<span class="pub-badge tgpub-badge-src">' + country + '</span>' : '') +
                '</div>' +
                '<div class="pub-card-title">' + title + '</div>' +
                '<div class="pub-card-meta">' +
                    '<span class="pub-badge tgpub-badge-ref">' + timeIcon + '<span>' + time + '</span></span>' +
                    (e.forecast ? '<span class="pub-badge tgpub-badge-forecast">Forecast: ' + forecast + '</span>' : '') +
                    (e.previous ? '<span class="pub-badge tgpub-badge-forecast">Previous: ' + previous + '</span>' : '') +
                '</div>' +
            '</div>' +
            '<div class="pub-card-actions">' +
                '<button class="adm-btn adm-btn-ghost" onclick="openPublisherPreview(\'calendar\',\'' + adminEscapeHtml(refId) + '\')">' + previewIcon + '<span>پیش‌نمایش</span></button>' +
                '<button class="adm-btn adm-btn-ghost" onclick="enqueuePublisher(\'calendar\',\'' + adminEscapeHtml(refId) + '\')">' + queueIcon + '<span>به صف</span></button>' +
                '<button class="adm-btn adm-btn-primary" onclick="sendNowPublisher(\'calendar\',\'' + adminEscapeHtml(refId) + '\')">' + sendIcon + '<span>ارسال فوری</span></button>' +
            '</div>' +
        '</div>';
    }).join('');
}

// ── Analysis tab ──
async function loadPublisherAnalysis() {
    const listEl = document.getElementById('tgpub-analysis-list');
    const emptyEl = document.getElementById('tgpub-analysis-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = pubSkeleton(4);
    try {
        const data = await adminApiFetch('/api/analyses?page=1&limit=50');
        const items = (data && data.analyses) || (data && data.data) || [];
        _pubAnalysisCache = items;
        renderPublisherAnalysisList(items);
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline">' +
            '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" width="64" height="64"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>' +
            '<h4>خطا در بارگذاری</h4>' +
            '<p>' + adminEscapeHtml((e.message || 'خطای ناشناخته').slice(0, 200)) + '</p>' +
            '<button class="adm-btn adm-btn-primary" onclick="loadPublisherAnalysis()">تلاش مجدد</button>' +
        '</div>';
        console.error(e);
    }
}
window.loadPublisherAnalysis = loadPublisherAnalysis;

function filterPubAnalysis(q) {
    if (!_pubAnalysisCache.length) return;
    // First apply smart filters
    let items = applyAnalysisSmartFilters(_pubAnalysisCache);
    const qq = String(q || '').toLowerCase().trim();
    if (qq) {
        items = items.filter(a =>
            (a.title || '').toLowerCase().includes(qq) ||
            (a.coin || '').toLowerCase().includes(qq) ||
            (a.content || '').toLowerCase().includes(qq)
        );
    }
    renderPublisherAnalysisList(items);
}
window.filterPubAnalysis = filterPubAnalysis;

function renderPublisherAnalysisList(items) {
    // Apply smart filters if any are active
    items = applyAnalysisSmartFilters(items);
    const listEl = document.getElementById('tgpub-analysis-list');
    const emptyEl = document.getElementById('tgpub-analysis-empty');
    if (!listEl) return;
    if (!items || !items.length) {
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = items.slice(0, 30).map(a => {
        const refId = String(a.id || '').slice(0, 64);
        const coin = adminEscapeHtml((a.coin || '—').toUpperCase());
        const title = adminEscapeHtml((a.title || '').slice(0, 120));
        const summary = adminEscapeHtml((a.content || '').slice(0, 150));
        const hasImg = !!a.image;
        const analysisIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>';
        const imgBadge = hasImg ? '<span class="pub-badge tgpub-badge-ai"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="2"/><circle cx="8.5" cy="8.5" r="1.5"/><polyline points="21 15 16 10 5 21"/></svg><span>تصویر</span></span>' : '';
        const previewIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
        const queueIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/></svg>';
        const sendIcon = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>';
        const imgHtml = hasImg
            ? '<div class="pub-card-media"><img src="' + adminEscapeHtml(a.image) + '" loading="lazy" onerror="this.parentElement.style.display=\'none\'"></div>'
            : '';
        return '<div class="pub-card" data-ref-id="' + adminEscapeHtml(refId) + '">' +
            '<div class="pub-card-top">' +
                imgHtml +
                '<div class="pub-card-body">' +
                    '<div class="pub-card-badges">' +
                        '<span class="pub-badge tgpub-badge-type">' + analysisIcon + '<span>تحلیل</span></span>' +
                        '<span class="pub-badge tgpub-badge-src">' + coin + '</span>' +
                        imgBadge +
                    '</div>' +
                    '<div class="pub-card-title">' + title + '</div>' +
                    (summary ? '<div class="pub-card-summary">' + summary + '</div>' : '') +
                    '<div class="pub-card-meta">' +
                        '<span class="pub-badge tgpub-badge-ref">' + adminEscapeHtml(refId) + '</span>' +
                    '</div>' +
                '</div>' +
            '</div>' +
            '<div class="pub-card-actions">' +
                '<button class="adm-btn adm-btn-ghost" onclick="openPublisherPreview(\'analysis\',\'' + adminEscapeHtml(refId) + '\')">' + previewIcon + '<span>پیش‌نمایش</span></button>' +
                '<button class="adm-btn adm-btn-ghost" onclick="enqueuePublisher(\'analysis\',\'' + adminEscapeHtml(refId) + '\')">' + queueIcon + '<span>به صف</span></button>' +
                '<button class="adm-btn adm-btn-primary" onclick="sendNowPublisher(\'analysis\',\'' + adminEscapeHtml(refId) + '\')">' + sendIcon + '<span>ارسال فوری</span></button>' +
            '</div>' +
        '</div>';
    }).join('');
}

// ── Queue / Sent / Failed tabs ──
async function loadPublisherQueue() {
    const listEl = document.getElementById('tgpub-queue-list');
    const emptyEl = document.getElementById('tgpub-queue-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = pubSkeleton(4);
    try {
        const data = await adminApiFetch('/api/admin/publisher/queue?limit=50');
        _pubQueueCache = (data && data.items) || [];
        renderPublisherQueueList(_pubQueueCache, 'queue');
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline"><h4>خطا در بارگذاری</h4><p>' + adminEscapeHtml((e.message || '').slice(0, 200)) + '</p><button class="adm-btn adm-btn-primary" onclick="loadPublisherQueue()">تلاش مجدد</button></div>';
    }
}
window.loadPublisherQueue = loadPublisherQueue;

async function loadPublisherSent() {
    const listEl = document.getElementById('tgpub-sent-list');
    const emptyEl = document.getElementById('tgpub-sent-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = pubSkeleton(4);
    try {
        const data = await adminApiFetch('/api/admin/publisher/sent?limit=50');
        _pubSentCache = (data && data.items) || [];
        renderPublisherQueueList(_pubSentCache, 'sent');
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline"><h4>خطا در بارگذاری</h4><p>' + adminEscapeHtml((e.message || '').slice(0, 200)) + '</p><button class="adm-btn adm-btn-primary" onclick="loadPublisherSent()">تلاش مجدد</button></div>';
    }
}
window.loadPublisherSent = loadPublisherSent;

async function loadPublisherFailed() {
    const listEl = document.getElementById('tgpub-failed-list');
    const emptyEl = document.getElementById('tgpub-failed-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = pubSkeleton(4);
    try {
        const data = await adminApiFetch('/api/admin/publisher/failed?limit=50');
        _pubFailedCache = (data && data.items) || [];
        renderPublisherQueueList(_pubFailedCache, 'failed');
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline"><h4>خطا در بارگذاری</h4><p>' + adminEscapeHtml((e.message || '').slice(0, 200)) + '</p><button class="adm-btn adm-btn-primary" onclick="loadPublisherFailed()">تلاش مجدد</button></div>';
    }
}
window.loadPublisherFailed = loadPublisherFailed;

// Filter for queue/sent/failed lists (search + type filter)
function filterPubList(mode, query) {
    const cacheMap = { queue: _pubQueueCache, sent: _pubSentCache, failed: _pubFailedCache };
    const cache = cacheMap[mode] || [];
    const typeFilterEl = document.getElementById('tgpub-' + mode + '-type-filter');
    const typeFilter = typeFilterEl ? typeFilterEl.value : '';
    const qq = String(query || '').toLowerCase().trim();
    const filtered = cache.filter(item => {
        if (typeFilter && item.type !== typeFilter) return false;
        if (qq) {
            const text = (item.final_text || item.payload?.built?.text || '') + ' ' + item.ref_id + ' ' + item.id + ' ' + (item.error || '');
            if (!text.toLowerCase().includes(qq)) return false;
        }
        return true;
    });
    renderPublisherQueueList(filtered, mode);
}
window.filterPubList = filterPubList;

function renderPublisherQueueList(items, mode) {
    let listEl;
    let emptyEl;
    if (mode === 'queue') { listEl = document.getElementById('tgpub-queue-list'); emptyEl = document.getElementById('tgpub-queue-empty'); }
    else if (mode === 'sent') { listEl = document.getElementById('tgpub-sent-list'); emptyEl = document.getElementById('tgpub-sent-empty'); }
    else if (mode === 'failed') { listEl = document.getElementById('tgpub-failed-list'); emptyEl = document.getElementById('tgpub-failed-empty'); }
    if (!listEl) return;
    if (!items || !items.length) {
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'flex';
    listEl.innerHTML = items.map(item => {
        const typeIcons = {
            news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2z"/></svg>',
            calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/></svg>',
            analysis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
            announcement: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l18-5v12L3 14v-3z"/></svg>',
        };
        const typeIcon = typeIcons[item.type] || typeIcons.announcement;
        const statusBadge = '<span class="pub-badge tgpub-badge-status-' + item.status + '"><span>' + item.status + '</span></span>';
        // Priority badge (1=urgent, 10=breaking, 20=important, 50=normal, 100=low)
        const priority = Number(item.priority || 100);
        let priorityLabel = '', priorityClass = '';
        if (priority <= 10) { priorityLabel = 'فوری'; priorityClass = 'tgpub-badge-priority-urgent'; }
        else if (priority <= 20) { priorityLabel = 'مهم'; priorityClass = 'tgpub-badge-priority-high'; }
        else if (priority <= 50) { priorityLabel = 'عادی'; priorityClass = 'tgpub-badge-priority-normal'; }
        else { priorityLabel = 'کم'; priorityClass = 'tgpub-badge-priority-low'; }
        const priorityBadge = (mode === 'queue') ? '<span class="pub-badge ' + priorityClass + '"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/></svg><span>' + priorityLabel + '</span></span>' : '';
        // Scheduled time badge
        const scheduledBadge = (mode === 'queue' && item.scheduled_at && new Date(item.scheduled_at) > new Date())
            ? '<span class="pub-badge tgpub-badge-scheduled"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg><span>' + adminFormatDatePub(item.scheduled_at) + '</span></span>'
            : '';
        const ref = adminEscapeHtml(item.ref_id || '');
        const time = mode === 'sent' ? adminFormatDatePub(item.sent_at) : adminFormatDatePub(item.created_at);
        const textPreview = adminEscapeHtml((item.final_text || item.payload?.built?.text || '').slice(0, 150));
        const actions = [];
        if (mode === 'queue') {
            actions.push('<button class="adm-btn adm-btn-ghost" onclick="cancelPublisherItem(' + item.id + ')" title="لغو"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg><span>لغو</span></button>');
        }
        if (mode === 'failed') {
            actions.push('<button class="adm-btn adm-btn-primary" onclick="retryPublisherItem(' + item.id + ')" title="ارسال مجدد"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="23 4 23 10 17 10"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10"/></svg><span>ارسال مجدد</span></button>');
        }
        if (mode === 'sent') {
            actions.push('<button class="adm-btn adm-btn-ghost" onclick="deletePublisherSent(' + item.id + ')" title="حذف"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg><span>حذف</span></button>');
        }
        const errLine = (mode === 'failed' && item.error) ? '<div class="pub-card-error"><svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg><span>' + adminEscapeHtml(item.error.slice(0, 200)) + '</span></div>' : '';
        return '<div class="pub-card">' +
            '<div class="pub-card-body">' +
                '<div class="pub-card-badges">' +
                    '<span class="pub-badge tgpub-badge-type">' + typeIcon + '<span>' + adminEscapeHtml(item.type) + '</span></span>' +
                    statusBadge +
                    priorityBadge +
                    '<span class="pub-badge tgpub-badge-ref">#' + item.id + '</span>' +
                    '<span class="pub-badge tgpub-badge-src">ref: ' + ref + '</span>' +
                    (item.attempts > 0 ? '<span class="pub-badge tgpub-badge-attempts">سعی: ' + item.attempts + '/' + item.max_attempts + '</span>' : '') +
                '</div>' +
                '<div class="pub-card-summary">' + (textPreview || '—') + '</div>' +
                errLine +
                '<div class="pub-card-meta">' + scheduledBadge + '</div>' +
                '<div class="pub-card-time">' + time + (item.tg_message_id ? ' · msg #' + item.tg_message_id : '') + '</div>' +
            '</div>' +
            (actions.length ? '<div class="pub-card-actions">' + actions.join('') + '</div>' : '') +
        '</div>';
    }).join('');
}

// ── Logs tab ──
async function loadPublisherLogs() {
    const listEl = document.getElementById('tgpub-logs-list');
    const emptyEl = document.getElementById('tgpub-logs-empty');
    if (!listEl) return;
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'block';
    listEl.innerHTML = '<div style="padding:20px;color:#94a3b8;text-align:center;font-size:12px;">⏳ در حال بارگذاری...</div>';
    try {
        const data = await adminApiFetch('/api/admin/publisher/logs?limit=100');
        _pubLogsCache = (data && data.items) || [];
        renderPublisherLogs(_pubLogsCache);
    } catch (e) {
        listEl.innerHTML = '<div class="pub-empty tgpub-empty-inline"><h4>خطا در بارگذاری</h4><p>' + adminEscapeHtml((e.message || '').slice(0, 200)) + '</p><button class="adm-btn adm-btn-primary" onclick="loadPublisherLogs()">تلاش مجدد</button></div>';
    }
}
window.loadPublisherLogs = loadPublisherLogs;

function renderPublisherLogs(items) {
    const listEl = document.getElementById('tgpub-logs-list');
    const emptyEl = document.getElementById('tgpub-logs-empty');
    if (!listEl) return;
    if (!items || !items.length) {
        listEl.style.display = 'none';
        if (emptyEl) emptyEl.style.display = 'flex';
        return;
    }
    if (emptyEl) emptyEl.style.display = 'none';
    listEl.style.display = 'block';
    listEl.innerHTML = items.map(log => {
        const typeIcons = {
            news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2z"/></svg>',
            calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="4" width="18" height="18" rx="2"/></svg>',
            analysis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/></svg>',
            announcement: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 11l18-5v12L3 14v-3z"/></svg>',
        };
        const typeIcon = typeIcons[log.type] || typeIcons.announcement;
        const statusBadge = '<span class="pub-badge tgpub-badge-status-' + log.status + '"><span>' + log.status + '</span></span>';
        const err = log.error ? '<span class="pub-log-err">' + adminEscapeHtml(log.error.slice(0, 150)) + '</span>' : '';
        return '<div class="pub-log-row">' +
            '<span class="pub-log-time">' + adminFormatDatePub(log.created_at) + '</span>' +
            '<span class="pub-log-type">' + typeIcon + '</span>' +
            statusBadge +
            '<span class="pub-log-ref">#' + adminEscapeHtml(log.queue_id || '—') + ' · ' + adminEscapeHtml(log.ref_id) + '</span>' +
            '<span class="pub-log-dur">' + faNum(log.duration_ms) + 'ms</span>' +
            err +
        '</div>';
    }).join('');
}

function filterPubLogs(query) {
    if (!_pubLogsCache.length) return;
    const statusFilterEl = document.getElementById('tgpub-logs-status-filter');
    const statusFilter = statusFilterEl ? statusFilterEl.value : '';
    const qq = String(query || '').toLowerCase().trim();
    const filtered = _pubLogsCache.filter(log => {
        if (statusFilter && log.status !== statusFilter) return false;
        if (qq) {
            const text = (log.error || '') + ' ' + log.type + ' ' + log.ref_id + ' ' + (log.queue_id || '');
            if (!text.toLowerCase().includes(qq)) return false;
        }
        return true;
    });
    renderPublisherLogs(filtered);
}
window.filterPubLogs = filterPubLogs;

function exportLogsCSV() {
    if (!_pubLogsCache.length) { adminToast('لاگی برای خروجی وجود ندارد', 'error'); return; }
    const rows = [['time', 'type', 'status', 'queue_id', 'ref_id', 'duration_ms', 'error', 'message_id']];
    _pubLogsCache.forEach(log => {
        rows.push([
            log.created_at || '',
            log.type || '',
            log.status || '',
            log.queue_id || '',
            log.ref_id || '',
            log.duration_ms || 0,
            (log.error || '').replace(/"/g, '""'),
            log.tg_message_id || ''
        ]);
    });
    const csv = rows.map(r => r.map(c => '"' + String(c) + '"').join(',')).join('\n');
    const blob = new Blob(['\ufeff' + csv], { type: 'text/csv;charset=utf-8;' });
    const url = URL.createObjectURL(blob);
    const a = document.createElement('a');
    a.href = url;
    a.download = 'publisher-logs-' + new Date().toISOString().slice(0, 10) + '.csv';
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
    URL.revokeObjectURL(url);
    adminToast('✅ خروجی CSV تولید شد', 'success');
}
window.exportLogsCSV = exportLogsCSV;

// ── Actions ──
async function enqueuePublisher(type, refId) {
    try {
        const data = await adminApiFetch('/api/admin/publisher/queue', {
            method: 'POST',
            body: JSON.stringify({ type, ref_id: refId }),
        });
        if (data && data.status === 'success') {
            adminToast('✅ به صف اضافه شد #' + (data.queue && data.queue.id), 'success');
            loadPublisherStats();
        } else if (data && data.issues) {
            adminToast('❌ اعتبارسنجی: ' + data.issues.join('، '), 'error');
        } else {
            adminToast('❌ خطا', 'error');
        }
    } catch (e) {
        adminToast('❌ ' + (e.message || 'خطا'), 'error');
        console.error(e);
    }
}
window.enqueuePublisher = enqueuePublisher;

async function sendNowPublisher(type, refId) {
    if (!confirm('ارسال فوری به کانال؟ این پیام مستقیم ارسال می‌شود.')) return;
    try {
        const data = await adminApiFetch('/api/admin/publisher/send-now', {
            method: 'POST',
            body: JSON.stringify({ type, ref_id: refId }),
        });
        if (data && data.status === 'success') {
            adminToast('✅ ارسال شد! msg #' + data.message_id + ' (' + faNum(data.duration_ms) + 'ms)', 'success');
            loadPublisherStats();
        } else if (data && data.issues) {
            adminToast('❌ اعتبارسنجی: ' + data.issues.join('، '), 'error');
        } else if (data && data.message) {
            adminToast('❌ ' + data.message, 'error');
        } else {
            adminToast('❌ خطا', 'error');
        }
    } catch (e) {
        adminToast('❌ ' + (e.message || 'خطا'), 'error');
        console.error(e);
    }
}
window.sendNowPublisher = sendNowPublisher;

async function cancelPublisherItem(id) {
    try {
        const data = await adminApiFetch('/api/admin/publisher/cancel/' + id, { method: 'POST' });
        if (data && data.status === 'success') {
            adminToast('✅ لغو شد', 'success');
            loadPublisherQueue();
            loadPublisherStats();
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); }
}
window.cancelPublisherItem = cancelPublisherItem;

async function retryPublisherItem(id) {
    try {
        const data = await adminApiFetch('/api/admin/publisher/retry/' + id, { method: 'POST' });
        if (data && data.status === 'success') {
            adminToast('✅ برای ارسال مجدد آماده شد', 'success');
            loadPublisherFailed();
            loadPublisherStats();
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); }
}
window.retryPublisherItem = retryPublisherItem;

async function deletePublisherSent(id) {
    if (!confirm('حذف این رکورد از تاریخچه؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/publisher/sent/' + id, { method: 'DELETE' });
        if (data && data.status === 'success') {
            adminToast('✅ حذف شد', 'success');
            loadPublisherSent();
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); }
}
window.deletePublisherSent = deletePublisherSent;

async function processPublisherNow() {
    try {
        adminToast('⏳ در حال پردازش صف...', 'info');
        const data = await adminApiFetch('/api/admin/publisher/process', { method: 'POST' });
        if (data && data.status === 'success' && data.result) {
            const r = data.result;
            adminToast('✅ پردازش: ' + faNum(r.sent) + ' ارسال، ' + faNum(r.failed) + ' ناموفق، ' + faNum(r.skipped) + ' رد شده', 'success');
            loadPublisherQueue();
            loadPublisherStats();
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); }
}
window.processPublisherNow = processPublisherNow;

// ── Settings tab ──
async function loadPublisherSettings() {
    try {
        const data = await adminApiFetch('/api/admin/publisher/settings');
        if (!data || !data.settings) return;
        const s = data.settings;
        const el = (id) => document.getElementById(id);
        if (el('tgpub-channel-id')) el('tgpub-channel-id').value = s.channel_id || '';
        if (el('tgpub-rate-limit')) el('tgpub-rate-limit').value = s.rate_limit_ms || 3000;
        if (el('tgpub-enabled')) el('tgpub-enabled').checked = !!s.enabled;
        if (el('tgpub-auto-news')) el('tgpub-auto-news').checked = !!s.auto_publish_news;
        if (el('tgpub-auto-calendar')) el('tgpub-auto-calendar').checked = !!s.auto_publish_calendar;
        if (el('tgpub-auto-analysis')) el('tgpub-auto-analysis').checked = !!s.auto_publish_analysis;
        const nf = s.news_filters || {};
        document.querySelectorAll('[data-news-filter]').forEach(cb => {
            const k = cb.getAttribute('data-news-filter');
            cb.checked = !!nf[k];
        });
        const ci = s.calendar_impacts || {};
        document.querySelectorAll('[data-cal-impact]').forEach(cb => {
            const k = cb.getAttribute('data-cal-impact');
            cb.checked = !!ci[k];
        });
    } catch (e) { console.error(e); adminToast('خطا در بارگذاری تنظیمات', 'error'); }
}
window.loadPublisherSettings = loadPublisherSettings;

async function savePublisherSettings() {
    const el = (id) => document.getElementById(id);
    const news_filters = {};
    document.querySelectorAll('[data-news-filter]').forEach(cb => { news_filters[cb.getAttribute('data-news-filter')] = !!cb.checked; });
    const calendar_impacts = {};
    document.querySelectorAll('[data-cal-impact]').forEach(cb => { calendar_impacts[cb.getAttribute('data-cal-impact')] = !!cb.checked; });
    const payload = {
        enabled: !!(el('tgpub-enabled') && el('tgpub-enabled').checked),
        channel_id: (el('tgpub-channel-id') && el('tgpub-channel-id').value || '').trim(),
        rate_limit_ms: Number(el('tgpub-rate-limit') && el('tgpub-rate-limit').value) || 3000,
        auto_publish_news: !!(el('tgpub-auto-news') && el('tgpub-auto-news').checked),
        auto_publish_calendar: !!(el('tgpub-auto-calendar') && el('tgpub-auto-calendar').checked),
        auto_publish_analysis: !!(el('tgpub-auto-analysis') && el('tgpub-auto-analysis').checked),
        news_filters,
        calendar_impacts,
    };
    try {
        const data = await adminApiFetch('/api/admin/publisher/settings', {
            method: 'PUT',
            body: JSON.stringify(payload),
        });
        if (data && data.status === 'success') {
            adminToast('✅ تنظیمات ذخیره شد', 'success');
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); console.error(e); }
}
window.savePublisherSettings = savePublisherSettings;

// ── Preview tab ──
function onPreviewTypeChange() {
    // Clear preview when type changes
    const bubble = document.getElementById('tgpub-preview-bubble');
    if (bubble) bubble.innerHTML = '<div class="pub-empty">پیش‌نمایش اینجا نمایش داده می‌شود</div>';
    _pubLastPreview = null;
    updatePublishButtons();
}
window.onPreviewTypeChange = onPreviewTypeChange;

function openPublisherPreview(type, refId) {
    // Switch to preview tab and pre-fill
    switchPublisherTab('preview', document.querySelector('.pub-tab[data-pub-tab="preview"]'));
    const typeEl = document.getElementById('tgpub-preview-type');
    const refEl = document.getElementById('tgpub-preview-ref');
    if (typeEl) typeEl.value = type;
    if (refEl) refEl.value = refId;
    setTimeout(() => generatePreview(), 300);
}
window.openPublisherPreview = openPublisherPreview;

async function generatePreview() {
    const type = document.getElementById('tgpub-preview-type')?.value;
    const refId = document.getElementById('tgpub-preview-ref')?.value.trim();
    const title = document.getElementById('tgpub-preview-title')?.value.trim();
    const summary = document.getElementById('tgpub-preview-summary')?.value.trim();
    const note = document.getElementById('tgpub-preview-note')?.value.trim();
    const showSource = document.getElementById('tgpub-preview-source')?.checked;
    if (!type || !refId) {
        adminToast('نوع و شناسه را پر کنید', 'error');
        return;
    }
    const overrides = {};
    if (title) overrides.title = title;
    if (summary) overrides.summary = summary;
    if (note) overrides.custom_note = note;
    overrides.show_source = showSource;

    try {
        const data = await adminApiFetch('/api/admin/publisher/preview', {
            method: 'POST',
            body: JSON.stringify({ type, ref_id: refId, overrides }),
        });
        if (data && data.status === 'success' && data.preview) {
            _pubLastPreview = { type, ref_id: refId, overrides, preview: data.preview };
            renderTelegramPreview(data.preview);
            renderValidation(data.preview.validation, data.preview.dedup, data.preview.text_length);
            updatePublishButtons();
        } else if (data && data.message) {
            adminToast('❌ ' + data.message, 'error');
        } else {
            adminToast('❌ خطا', 'error');
        }
    } catch (e) {
        adminToast('❌ ' + (e.message || 'خطا'), 'error');
        console.error(e);
    }
}
window.generatePreview = generatePreview;

function renderTelegramPreview(preview) {
    const bubble = document.getElementById('tgpub-preview-bubble');
    if (!bubble) return;
    // Strip <b> tags for display — show as bold via CSS instead
    let html = adminEscapeHtml(preview.text || '')
        .replace(/&lt;b&gt;/g, '<strong>').replace(/&lt;\/b&gt;/g, '</strong>')
        .replace(/&lt;code&gt;/g, '<code class="pub-tg-code">').replace(/&lt;\/code&gt;/g, '</code>')
        .replace(/\n/g, '<br>');
    let imgHtml = '';
    if (preview.image_url) {
        imgHtml = '<img src="' + adminEscapeHtml(preview.image_url) + '" class="pub-tg-img" onerror="this.style.display=\'none\'">';
    }
    let buttonsHtml = '';
    if (preview.buttons && preview.buttons.length) {
        buttonsHtml = '<div class="pub-tg-buttons">' +
            preview.buttons.map(row => row.map(b => '<a href="' + adminEscapeHtml(b.url) + '" target="_blank" class="pub-tg-btn">' + adminEscapeHtml(b.text) + '</a>').join('')).join('') +
        '</div>';
    }
    bubble.innerHTML = imgHtml + '<div class="pub-tg-text">' + html + '</div>' + buttonsHtml +
        '<div class="pub-tg-meta">' + faNum(preview.text_length) + ' / ۴۰۹۶ کاراکتر</div>';
}

function renderValidation(validation, dedup, textLen) {
    const el = document.getElementById('tgpub-validation');
    if (!el) return;
    let html = '';
    if (validation && validation.valid) {
        const checkSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
        html += '<div class="pub-valid">' + checkSvg + '<span>همه بررسی‌ها گذشتند (' + faNum(textLen) + ' کاراکتر)</span></div>';
    } else if (validation && validation.issues) {
        const xSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
        html += '<div class="pub-invalid">' + xSvg + '<span>مشکلات:</span></div><ul class="pub-issues">' +
            validation.issues.map(i => '<li>' + adminEscapeHtml(i) + '</li>').join('') + '</ul>';
    }
    if (dedup && dedup.published) {
        const warnSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
        html += '<div class="pub-warn">' + warnSvg + '<span>این مورد قبلاً ارسال شده (' + adminFormatDatePub(dedup.lastSentAt) + ' · msg #' + dedup.messageId + ')</span></div>';
    }
    el.innerHTML = html;
}

function updatePublishButtons() {
    const ok = !!(_pubLastPreview && _pubLastPreview.preview && _pubLastPreview.preview.validation && _pubLastPreview.preview.validation.valid);
    const publishBtn = document.getElementById('tgpub-publish-btn');
    const sendNowBtn = document.getElementById('tgpub-sendnow-btn');
    if (publishBtn) publishBtn.disabled = !ok;
    if (sendNowBtn) sendNowBtn.disabled = !ok;
}

async function publishFromPreview() {
    if (!_pubLastPreview) return;
    try {
        const data = await adminApiFetch('/api/admin/publisher/queue', {
            method: 'POST',
            body: JSON.stringify({ type: _pubLastPreview.type, ref_id: _pubLastPreview.ref_id, overrides: _pubLastPreview.overrides }),
        });
        if (data && data.status === 'success') {
            adminToast('✅ به صف اضافه شد #' + (data.queue && data.queue.id), 'success');
            loadPublisherStats();
        } else if (data && data.issues) {
            adminToast('❌ ' + data.issues.join('، '), 'error');
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); }
}
window.publishFromPreview = publishFromPreview;

async function sendNowFromPreview() {
    if (!_pubLastPreview) return;
    if (!confirm('ارسال فوری به کانال؟')) return;
    try {
        const data = await adminApiFetch('/api/admin/publisher/send-now', {
            method: 'POST',
            body: JSON.stringify({ type: _pubLastPreview.type, ref_id: _pubLastPreview.ref_id, overrides: _pubLastPreview.overrides }),
        });
        if (data && data.status === 'success') {
            adminToast('✅ ارسال شد! msg #' + data.message_id, 'success');
            loadPublisherStats();
        } else if (data && data.issues) {
            adminToast('❌ ' + data.issues.join('، '), 'error');
        } else if (data && data.message) {
            adminToast('❌ ' + data.message, 'error');
        } else { adminToast('❌ خطا', 'error'); }
    } catch (e) { adminToast('❌ ' + (e.message || 'خطا'), 'error'); }
}
window.sendNowFromPreview = sendNowFromPreview;

// ── Connection test (tests if bot can post to channel) ──
async function testChannelConnection() {
    const resultEl = document.getElementById('tgpub-conn-test-result');
    if (resultEl) {
        resultEl.innerHTML = '<div class="pub-conn-testing">⏳ در حال تست اتصال...</div>';
        resultEl.style.display = 'block';
    }
    try {
        const data = await adminApiFetch('/api/admin/publisher/test-connection', { method: 'POST' });
        if (!resultEl) return;
        if (data && data.ok && data.can_post) {
            const chat = data.chat || {};
            const okSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
            resultEl.innerHTML = '<div class="pub-conn-success">' +
                '<div class="pub-conn-icon">' + okSvg + '</div>' +
                '<div>' +
                    '<div class="pub-conn-title">اتصال موفق</div>' +
                    '<div class="pub-conn-detail">کانال: <b>' + adminEscapeHtml(chat.title || chat.username || '—') + '</b> · نوع: ' + adminEscapeHtml(chat.type || '—') + '</div>' +
                    '<div class="pub-conn-detail">وضعیت بات: <b>' + adminEscapeHtml(data.bot_status || 'admin') + '</b></div>' +
                '</div>' +
            '</div>';
        } else if (data && data.ok && !data.can_post) {
            const warnSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>';
            resultEl.innerHTML = '<div class="pub-conn-warn">' +
                '<div class="pub-conn-icon">' + warnSvg + '</div>' +
                '<div>' +
                    '<div class="pub-conn-title">بات ادمین نیست</div>' +
                    '<div class="pub-conn-detail">' + adminEscapeHtml(data.message || '') + '</div>' +
                    '<div class="pub-conn-detail">بات را در کانال ادمین کنید با دسترسی ارسال پیام</div>' +
                '</div>' +
            '</div>';
        } else {
            const errSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
            resultEl.innerHTML = '<div class="pub-conn-error">' +
                '<div class="pub-conn-icon">' + errSvg + '</div>' +
                '<div>' +
                    '<div class="pub-conn-title">اتصال ناموفق</div>' +
                    '<div class="pub-conn-detail">' + adminEscapeHtml(data.message || data.description || 'خطای ناشناخته') + '</div>' +
                    (data.error_code ? '<div class="pub-conn-detail">کد: ' + data.error_code + '</div>' : '') +
                '</div>' +
            '</div>';
        }
    } catch (e) {
        if (resultEl) {
            const errSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';
            resultEl.innerHTML = '<div class="pub-conn-error">' +
                '<div class="pub-conn-icon">' + errSvg + '</div>' +
                '<div><div class="pub-conn-title">خطا</div><div class="pub-conn-detail">' + adminEscapeHtml((e.message || '').slice(0, 200)) + '</div></div>' +
            '</div>';
        }
    }
}
window.testChannelConnection = testChannelConnection;

// ── Retry all failed items ──
async function retryAllFailed() {
    if (!_pubFailedCache.length) { adminToast('مورد ناموفقی وجود ندارد', 'info'); return; }
    if (!confirm('ارسال مجدد ' + _pubFailedCache.length + ' مورد ناموفق؟')) return;
    let success = 0, failed = 0;
    for (const item of _pubFailedCache) {
        try {
            const data = await adminApiFetch('/api/admin/publisher/retry/' + item.id, { method: 'POST' });
            if (data && data.status === 'success') success++;
            else failed++;
        } catch { failed++; }
    }
    adminToast('✅ ' + faNum(success) + ' آماده ارسال مجدد' + (failed ? '، ❌ ' + faNum(failed) + ' ناموفق' : ''), failed ? 'error' : 'success');
    loadPublisherFailed();
    loadPublisherStats();
}
window.retryAllFailed = retryAllFailed;

// ── Auto-refresh toggle (refreshes stats every 30s when on) ──
function toggleAutoRefresh() {
    const cb = document.getElementById('tgpub-queue-autorefresh');
    if (!cb) return;
    if (cb.checked) {
        if (_pubAutoRefreshTimer) clearInterval(_pubAutoRefreshTimer);
        _pubAutoRefreshTimer = setInterval(() => {
            loadPublisherStats();
            if (_pubCurrentTab === 'queue') loadPublisherQueue();
        }, 30000);
        adminToast('🔄 به‌روزرسانی خودکار فعال شد (هر ۳۰ ثانیه)', 'success');
    } else {
        if (_pubAutoRefreshTimer) {
            clearInterval(_pubAutoRefreshTimer);
            _pubAutoRefreshTimer = null;
        }
        adminToast('⏸ به‌روزرسانی خودکار غیرفعال شد', 'info');
    }
}
window.toggleAutoRefresh = toggleAutoRefresh;

// ── Keyboard shortcuts for publisher section ──
document.addEventListener('keydown', function (e) {
    // Only when admin panel is open AND publisher section is active
    if (!_adminPanelOpen || _currentAdminSection !== 'publisher') return;
    // Ignore if user is typing in input/textarea
    const tag = (e.target.tagName || '').toLowerCase();
    if (tag === 'input' || tag === 'textarea' || tag === 'select') return;
    // Esc closes admin panel (handled globally too)
    if (e.key === 'Escape') {
        if (typeof closeAdminPanel === 'function') closeAdminPanel();
        return;
    }
    // "/" focuses the search input of current tab
    if (e.key === '/' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const searchInput = document.querySelector('#tgpub-panel-' + _pubCurrentTab + ' .tgpub-search-input');
        if (searchInput) { searchInput.focus(); searchInput.select(); }
        return;
    }
    // "r" refreshes current tab
    if (e.key === 'r' && !e.ctrlKey && !e.metaKey) {
        e.preventDefault();
        const loaders = {
            news: () => loadPublisherNews(1),
            calendar: loadPublisherCalendar,
            analysis: loadPublisherAnalysis,
            queue: loadPublisherQueue,
            sent: loadPublisherSent,
            failed: loadPublisherFailed,
            logs: loadPublisherLogs,
        };
        if (loaders[_pubCurrentTab]) loaders[_pubCurrentTab]();
        return;
    }
    // Number keys 1-9 switch tabs
    const tabMap = { '1': 'news', '2': 'calendar', '3': 'analysis', '4': 'queue', '5': 'sent', '6': 'failed', '7': 'logs', '8': 'preview', '9': 'settings' };
    if (tabMap[e.key]) {
        e.preventDefault();
        const target = document.querySelector('.pub-tab[data-pub-tab="' + tabMap[e.key] + '"]');
        if (target) switchPublisherTab(tabMap[e.key], target);
    }
});

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

// ─── Permission & Role System (single source of truth) ───────────────────
// These mirror the backend requireAdmin() permission checks. Each sidebar
// section maps to one or more permissions. The sidebar is built dynamically
// from the admin's actual permissions (fetched from /api/admin/is-admin).
//
// Permission keys MUST match the strings passed to requireAdmin(request, env, '<key>')
// in src/controllers/admin.js — otherwise enforcement and UI will disagree.

const ADMIN_PERMISSIONS = {
    // Analysis
    'analysis.publish':  { label: 'انتشار تحلیل', group: 'تحلیل' },
    'analysis.edit':     { label: 'ویرایش تحلیل', group: 'تحلیل' },
    'analysis.delete':   { label: 'حذف تحلیل', group: 'تحلیل' },
    // News
    'news.publish':      { label: 'انتشار خبر', group: 'اخبار' },
    'news.edit':         { label: 'ویرایش خبر', group: 'اخبار' },
    'news.delete':       { label: 'حذف خبر', group: 'اخبار' },
    // Users
    'users.view':        { label: 'مشاهده کاربران', group: 'کاربران' },
    'users.manage':      { label: 'مدیریت کاربران', group: 'کاربران' },
    'users.block':       { label: 'مسدودسازی کاربران', group: 'کاربران' },
    // Admins
    'admins.view':       { label: 'مشاهده مدیران', group: 'مدیران' },
    'admins.add':        { label: 'افزودن مدیر', group: 'مدیران' },
    'admins.edit':       { label: 'ویرایش مدیر', group: 'مدیران' },
    'admins.delete':     { label: 'حذف مدیر', group: 'مدیران' },
    // Wallet
    'wallet.view':       { label: 'مشاهده کیف پول', group: 'کیف پول' },
    'wallet.manage':     { label: 'مدیریت موجودی', group: 'کیف پول' },
    'wallet.reward':     { label: 'ثبت پاداش', group: 'کیف پول' },
    // Referral
    'referral.manage':   { label: 'مدیریت ریفرال', group: 'ریفرال' },
    'referral.reward':   { label: 'ثبت پاداش ریفرال', group: 'ریفرال' },
    // Tickets
    'tickets.view':      { label: 'مشاهده تیکت', group: 'تیکت' },
    'tickets.reply':     { label: 'پاسخ به تیکت', group: 'تیکت' },
    'tickets.close':     { label: 'بستن تیکت', group: 'تیکت' },
    // Notifications
    'notifications.send':    { label: 'ارسال اعلان', group: 'اعلان‌ها' },
    'notifications.manage':  { label: 'مدیریت اعلان', group: 'اعلان‌ها' },
    // Market
    'market.manage':     { label: 'مدیریت وضعیت بازار', group: 'بازار' },
    'market.alerts':     { label: 'مدیریت هشدارها', group: 'بازار' },
    // System
    'system.logs':       { label: 'مشاهده لاگ', group: 'سیستم' },
    'system.settings':   { label: 'تنظیمات سیستم', group: 'سیستم' },
    'system.maintenance':{ label: 'حالت نگهداری', group: 'سیستم' },
    // Advertisement
    'ads.banners':       { label: 'مدیریت بنرها', group: 'تبلیغات' },
    'ads.manage':        { label: 'مدیریت تبلیغات', group: 'تبلیغات' },
};

// Each role maps to a fixed set of permissions. Super Admin always gets ['*'].
const ADMIN_ROLES = {
    'super_admin':       { label: 'Super Admin', permissions: ['*'] },
    'administrator':     { label: 'Administrator', permissions: [
        'analysis.publish','analysis.edit','analysis.delete',
        'news.publish','news.edit','news.delete',
        'users.view','users.manage','users.block',
        'admins.view',
        'wallet.view','wallet.manage','wallet.reward',
        'referral.manage','referral.reward',
        'tickets.view','tickets.reply','tickets.close',
        'notifications.send','notifications.manage',
        'market.manage','market.alerts',
        'system.logs','system.settings','system.maintenance',
        'ads.banners','ads.manage',
    ]},
    'content_manager':   { label: 'Content Manager', permissions: [
        'analysis.publish','analysis.edit','analysis.delete',
        'news.publish','news.edit','news.delete',
    ]},
    'market_analyst':    { label: 'Market Analyst', permissions: [
        'analysis.publish','analysis.edit',
        'market.manage','market.alerts',
    ]},
    'news_editor':       { label: 'News Editor', permissions: [
        'news.publish','news.edit','news.delete',
    ]},
    'support_manager':   { label: 'Support Manager', permissions: [
        'tickets.view','tickets.reply','tickets.close',
        'users.view',
    ]},
    'support_agent':     { label: 'Support Agent', permissions: [
        'tickets.view','tickets.reply',
    ]},
    'wallet_manager':    { label: 'Wallet Manager', permissions: [
        'wallet.view','wallet.manage','wallet.reward',
        'referral.manage','referral.reward',
    ]},
    'marketing_manager': { label: 'Marketing Manager', permissions: [
        'notifications.send','notifications.manage',
        'ads.banners','ads.manage',
    ]},
    'moderator':         { label: 'Moderator', permissions: [
        'users.view','users.block',
        'tickets.view','tickets.close',
    ]},
};

// Map sidebar sections → required permission(s). A section is shown if the
// admin has ANY of the listed permissions (or '*' / is_super).
const ADMIN_SECTION_PERMS = {
    'dashboard':           null,  // all admins see the dashboard
    'users':               ['users.view','users.manage','users.block'],
    'admins':              ['admins.view','admins.add','admins.edit','admins.delete'],
    'tickets':             ['tickets.view','tickets.reply','tickets.close'],
    'rewards':             ['wallet.reward','referral.reward'],
    'transactions':        ['wallet.view','wallet.manage'],
    'referrals':           ['referral.manage','referral.reward'],
    'reward-center':       ['wallet.reward','referral.reward'],
    'notification-center': ['notifications.send','notifications.manage'],
    'alert-economy':       ['market.alerts'],
    'advertisements':      ['ads.banners','ads.manage'],
    'membership':          null,  // all admins can manage membership
    'system-controls':     ['system.settings','system.maintenance'],
    'system-health':       ['system.settings'],
    'logs':                ['system.logs'],
};

// Check if current admin has a permission (or '*' / is_super).
function _adminHasPerm(perm) {
    if (!_adminData) return false;
    if (_adminData.is_super) return true;
    const perms = _adminData.permissions || [];
    if (perms.includes('*')) return true;
    if (perm && perms.includes(perm)) return true;
    return false;
}

// Check if current admin can access a section (any of its required perms).
function _adminCanAccessSection(section) {
    const required = ADMIN_SECTION_PERMS[section];
    if (!required) return true; // no permission required (e.g. dashboard)
    if (_adminData && _adminData.is_super) return true;
    const perms = _adminData ? (_adminData.permissions || []) : [];
    if (perms.includes('*')) return true;
    return required.some(p => perms.includes(p));
}

// ─── Helpers ────────────────────────────────────────────────

function adminEscapeHtml(str) {
    if (!str) return '';
    const div = document.createElement('div');
    div.appendChild(document.createTextNode(String(str)));
    return div.innerHTML;
}

// A-1 FIX: Escape a value for safe use inside a JavaScript string literal
// within an HTML onclick attribute. This handles BOTH contexts:
//   1. HTML attribute context (quotes, angle brackets)
//   2. JavaScript string context (single quotes, backslashes)
// Use this for ANY dynamic value placed inside onclick="fn('VALUE')"
// or onclick="fn(\"VALUE\")" or template-literal onclick.
function adminEscapeJsId(value) {
    // First: HTML-escape for attribute context
    var htmlEscaped = adminEscapeHtml(String(value || ''));
    // Then: escape single quotes and backslashes for JS string context
    // adminEscapeHtml already converts ' to &#39; and " to &quot;,
    // but within onclick="..." the browser decodes HTML entities BEFORE
    // parsing the JS. So &#39; becomes ' again in the JS engine.
    // We need to prevent the ' from terminating the JS string.
    // Solution: replace &#39; (which decodes to ') with \\' (JS-escaped quote)
    // and replace &quot; (which decodes to ") with \\" (JS-escaped quote)
    // and backslash with \\\\
    return htmlEscaped
        .replace(/&#39;/g, '\\&#39;')   // &#39; → \' (prevent JS string termination)
        .replace(/&quot;/g, '\\&quot;')  // &quot; → \" (prevent JS string termination)
        .replace(/\\/g, '\\\\');          // \ → \\ (prevent JS escape sequence injection)
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

function _formatCooldownHuman(seconds) {
    seconds = Number(seconds) || 0;
    if (seconds <= 0) return 'بدون کوپل‌داون';
    var hours = Math.floor(seconds / 3600);
    var days = Math.floor(hours / 24);
    if (days >= 7) return (days / 7) + ' هفته';
    if (days >= 1) return days + ' روز';
    if (hours >= 1) return hours + ' ساعت';
    return seconds + ' ثانیه';
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
                let errorBody = null;
                try { const j = JSON.parse(detail); errorBody = j; if (j.detail) errMsg = j.detail; if (j.message) errMsg = j.message; } catch (_) {}
                const err = new Error(errMsg);
                err.status = res.status;
                err.body = errorBody;
                // Don't retry on 401/403/422 — auth/validation errors
                // Don't retry on 404 — resource already deleted (double-click)
                // Don't retry on 409 — conflict (CAMPAIGN_RECENTLY_SENT, already exists)
                // These are permanent client errors — retrying won't help.
                if (res.status === 401 || res.status === 403 || res.status === 422 || res.status === 404 || res.status === 409) {
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
            // Don't retry on auth/validation/client errors
            if (e.status === 401 || e.status === 403 || e.status === 422 || e.status === 404 || e.status === 409) {
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
    // Fetch the current admin's role + permissions from the backend.
    // This is the SINGLE source of truth for sidebar visibility + permission
    // checks. Without this, a newly-added admin sees all sidebar items but
    // gets 403 on every click (the "new admin can't access panel" bug).
    await _fetchAdminData();
    _adminPanelInitialized = true;
}

// Fetch the current admin's role + permissions from /api/admin/is-admin.
// Stores the result in _adminData and rebuilds the sidebar accordingly.
// Called on panel open AND after any role/permission change (add/edit/remove admin).
async function _fetchAdminData() {
    try {
        const data = await adminApiFetch('/api/admin/is-admin');
        if (data && data.is_admin) {
            _adminData = {
                is_admin: true,
                role: data.role || '',
                permissions: data.permissions || [],
                is_super: Boolean(data.is_super),
            };
        } else {
            _adminData = { is_admin: false, role: '', permissions: [], is_super: false };
        }
    } catch (e) {
        console.warn('[ADMIN] _fetchAdminData failed:', e?.message);
        _adminData = { is_admin: false, role: '', permissions: [], is_super: false };
    }
    // Rebuild sidebar based on actual permissions
    _applySidebarPermissions();
    _updateAdminSidebarUser();
    return _adminData;
}

// Show/hide sidebar nav items based on _adminData permissions.
// Items the admin can't access are hidden (display:none) — NOT removed — so
// the DOM structure stays stable. This runs on every panel open.
function _applySidebarPermissions() {
    const navItems = document.querySelectorAll('.adm-nav-item, .admin-nav-item');
    navItems.forEach(function (item) {
        const section = item.getAttribute('data-admin-section');
        if (!section) return;
        const canAccess = _adminCanAccessSection(section);
        item.style.display = canAccess ? '' : 'none';
    });
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
    'advertisements': 'تبلیغات',
    'system-controls': 'کنترل سیستم',
    'system-health': 'سلامت سیستم',
    'logs': 'لاگ‌ها',
    'membership': 'عضویت ویژه',
};

function openAdminPanel() {
    const panel = document.getElementById('admin-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    _adminPanelOpen = true;
    document.body.style.overflow = 'hidden';
    // Fetch admin data (role + permissions) BEFORE building sidebar / loading
    // any section. This ensures the sidebar reflects the admin's real access.
    _fetchAdminData().then(function () {
        // If the current section is not accessible, fall back to dashboard.
        if (!_adminCanAccessSection(_currentAdminSection)) {
            _currentAdminSection = 'dashboard';
        }
        // Update admin sidebar user info
        _updateAdminSidebarUser();
        // Load dashboard by default (or the current section if accessible)
        if (_currentAdminSection === 'dashboard') {
            loadAdminDashboard();
        } else {
            switchAdminSection(_currentAdminSection, null);
        }
    });
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
        // Show the admin's real role + permission count from _adminData
        if (roleEl) {
            const role = _adminData.role || '';
            const roleLabel = ADMIN_ROLES[role] ? ADMIN_ROLES[role].label : (role || 'مدیر');
            const permCount = _adminData.is_super ? '∞' : (_adminData.permissions || []).length;
            roleEl.textContent = roleLabel + ' · ' + permCount + ' دسترسی';
        }
    } catch (e) { /* ignore */ }
}

function switchAdminSection(section, btn) {
    // Permission guard: if the admin can't access this section, refuse + toast
    if (!_adminCanAccessSection(section)) {
        showAdminToast('شما به این بخش دسترسی ندارید', 'error');
        return;
    }
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
        case 'advertisements': loadAdvertisementsOverview(); break;
        case 'membership': loadAdminMembership(); break;
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
            const isSuper = role === 'super_admin' || admin.is_super;
            const perms = admin.permissions || [];
            const roleLabel = ADMIN_ROLES[role] ? ADMIN_ROLES[role].label : (isSuper ? 'Super Admin' : role);
            const displayName = admin.name || admin.username || (admin.first_name ? (admin.first_name + (admin.last_name ? ' ' + admin.last_name : '')) : 'مدیر');
            const tgId = String(admin.telegram_id || admin.id || '');
            const username = admin.username ? '@' + admin.username : null;
            const permCount = perms.includes('*') ? Object.keys(ADMIN_PERMISSIONS).length : perms.length;

            // Role badge color: super=red, administrator=orange, others=blue
            const roleBadgeColor = isSuper ? 'red' : (role === 'administrator' ? 'orange' : 'blue');
            // Status badge — FIX #2: "INACTIVE" (gray) instead of "BLOCKED" (red).
            // is_active=false means "no activity in 24h", NOT a ban/suspension.
            const statusBadge = isActive ? adminBadge('ACTIVE', 'green') : adminBadge('INACTIVE', 'gray');

            // Permission summary: show count + up to 3 badges, then "+N"
            let permBadgesHtml = '';
            if (perms.includes('*') || isSuper) {
                permBadgesHtml = adminBadge('FULL ACCESS', 'red');
            } else if (permCount > 0) {
                const shown = perms.slice(0, 3).map(function (p) {
                    const def = ADMIN_PERMISSIONS[p];
                    return adminBadge(def ? def.label : p, 'blue');
                }).join(' ');
                const extra = permCount > 3 ? ' <span class="admin-badge admin-badge-gray">+' + (permCount - 3) + '</span>' : '';
                permBadgesHtml = shown + extra;
            } else {
                permBadgesHtml = adminBadge('بدون دسترسی', 'gray');
            }

            html += '<div class="admin-list-item adm-user-card">' +
                // Row 1: avatar + name + role badge + status badge
                '<div class="adm-card-top">' +
                    '<div class="adm-card-avatar">' + adminEscapeHtml((displayName || 'م').charAt(0)) + '</div>' +
                    '<div class="adm-card-id">' +
                        '<div class="adm-card-name">' + adminEscapeHtml(displayName) + '</div>' +
                        '<div class="adm-card-sub">' +
                            (username ? adminEscapeHtml(username) + ' · ' : '') +
                            'ID: <span class="adm-card-tgid">' + adminEscapeHtml(tgId) + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="adm-card-badges">' +
                        adminBadge(roleLabel, roleBadgeColor) +
                        statusBadge +
                    '</div>' +
                '</div>' +
                // Row 2: meta info (joined, last active, perm count)
                '<div class="adm-card-meta">' +
                    '<span class="adm-meta-item"><span class="adm-meta-label">عضویت</span><span class="adm-meta-val adm-meta-val-date">' + adminFormatDate(admin.created_at) + '</span></span>' +
                    '<span class="adm-meta-item"><span class="adm-meta-label">آخرین ورود</span><span class="adm-meta-val adm-meta-val-date">' + (admin.last_active ? adminFormatDate(admin.last_active) : '—') + '</span></span>' +
                    '<span class="adm-meta-item"><span class="adm-meta-label">دسترسی‌ها</span><span class="adm-meta-val">' + permCount + '</span></span>' +
                '</div>' +
                // Row 3: permission badges
                '<div class="adm-card-perms">' + permBadgesHtml + '</div>' +
                // Row 4: action buttons (fixed position)
                '<div class="adm-card-actions">' +
                    '<button class="admin-btn admin-btn-sm admin-btn-' + (isActive ? 'ghost' : 'green') +
                    '" onclick="toggleAdminActive(\'' + adminEscapeJsId(admin.id) + '\', ' + isActive + ')">' +
                    (isActive ? 'غیرفعال‌سازی' : 'فعال‌سازی') + '</button>' +
                    (!isSuper ? '<button class="admin-btn admin-btn-sm admin-btn-red" onclick="removeAdmin(\'' + adminEscapeJsId(admin.id) + '\', \'' + adminEscapeJsId(admin.telegram_id) + '\')">حذف</button>' : '<span class="adm-card-protected">حفاظت‌شده</span>') +
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
    // Render permission checkboxes grouped by category, pre-filled from the
    // default role (support_agent). Changing the role updates the checkboxes.
    _renderAdminPermChecks();
}

function closeAddAdminForm() {
    const form = document.getElementById('admin-add-form');
    if (form) form.style.display = 'none';
}

// Render permission checkboxes grouped by ADMIN_PERMISSIONS.group.
// Pre-checks the permissions of the currently selected role.
function _renderAdminPermChecks() {
    const container = document.getElementById('admin-new-permissions');
    if (!container) return;
    const roleSelect = document.getElementById('admin-new-role');
    const roleKey = roleSelect ? roleSelect.value : 'support_agent';
    const roleDef = ADMIN_ROLES[roleKey] || { permissions: [] };
    const rolePerms = roleDef.permissions.includes('*') ? Object.keys(ADMIN_PERMISSIONS) : roleDef.permissions;

    // Group permissions by their .group field
    const groups = {};
    for (const [key, def] of Object.entries(ADMIN_PERMISSIONS)) {
        if (!groups[def.group]) groups[def.group] = [];
        groups[def.group].push({ key, label: def.label });
    }

    let html = '';
    for (const [groupName, perms] of Object.entries(groups)) {
        html += '<div class="adm-perm-group"><div class="adm-perm-group-label">' + adminEscapeHtml(groupName) + '</div><div class="adm-perm-group-items">';
        for (const p of perms) {
            const checked = rolePerms.includes(p.key) ? 'checked' : '';
            html += '<label class="adm-chip"><input type="checkbox" value="' + adminEscapeHtml(p.key) + '" ' + checked + '> ' + adminEscapeHtml(p.label) + '</label>';
        }
        html += '</div></div>';
    }
    container.innerHTML = html;
}

// When the role <select> changes, re-render the permission checkboxes with
// the new role's default permissions pre-checked. Existing manual edits are
// overwritten — this is intentional (selecting a role = applying its template).
function _onAdminRoleChange() {
    _renderAdminPermChecks();
}

async function submitAddAdmin() {
    const telegramId = document.getElementById('admin-new-telegram-id');
    const role = document.getElementById('admin-new-role');
    const permChecks = document.querySelectorAll('#admin-new-permissions input[type="checkbox"]');

    if (!telegramId || !telegramId.value.trim()) {
        showAdminToast('لطفاً شناسه تلگرام را وارد کنید', 'error');
        return;
    }
    if (!/^\d{5,20}$/.test(telegramId.value.trim())) {
        showAdminToast('شناسه تلگرام باید عدد معتبر باشد', 'error');
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
                role: role ? role.value : 'support_agent',
                permissions: permissions
            })
        });
        showAdminToast('مدیر با موفقیت افزوده شد', 'success');
        closeAddAdminForm();
        if (telegramId) telegramId.value = '';
        loadAdminList();
    } catch (e) {
        showAdminToast('خطا در افزودن مدیر: ' + (e.message || 'Unknown error'), 'error');
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
            // Build a modern, uniform user card with aligned badges + meta grid.
            const isActive = u.is_active !== false;
            const isTelegramPremium = u.is_premium;       // Telegram messenger Premium ($5/mo Telegram subscription)
            const isAppPremium = u.is_app_premium;        // App Membership Premium (authoritative: membershipAuthority.isPremium logic)
            const membershipLevel = u.membership_level || 'FREE';
            const membershipStatus = u.membership_status || 'INACTIVE';
            const channelJoined = u.channel_joined;
            const displayName = (u.first_name || u.name || 'کاربر') + (u.last_name ? ' ' + u.last_name : '');
            const tgId = String(u.telegram_id || u.id || '');
            const username = u.username ? '@' + u.username : null;
            const tokens = (u.token_balance !== undefined && u.token_balance !== null) ? u.token_balance : (u.tokens || 0);

            // Badges — all same size, aligned in one row.
            //
            // FIX #2 (BLOCKED → INACTIVE): the previous "BLOCKED" label implied
            // the user was banned/suspended/deleted, but is_active=false actually
            // only means "no activity in the last 24h". Renamed to "INACTIVE" to
            // reflect the true meaning without implying a ban.
            const statusBadge = isActive ? adminBadge('ACTIVE', 'green') : adminBadge('INACTIVE', 'gray');
            const channelBadge = channelJoined ? adminBadge('JOINED', 'green') : adminBadge('NOT JOINED', 'gray');
            // FIX #1 (Premium badge disambiguation): previously the badge showed
            // just "PREMIUM" for users.is_premium (Telegram messenger Premium),
            // which admins misread as App Membership Premium. Now:
            //   - Telegram Premium → "TG PREMIUM" (gray, distinct from App Premium)
            //   - App Membership Premium → "APP PREMIUM" (orange + gold avatar)
            // App Premium is the authoritative entitlement (membershipAuthority.isPremium
            // logic: APPROVED + VIP/PREMIUM/ELITE + not expired).
            const tgPremiumBadge = isTelegramPremium ? adminBadge('TG PREMIUM', 'gray') : '';
            const appPremiumBadge = isAppPremium ? adminBadge('APP PREMIUM', 'orange') : '';
            // FIX #3 (Role badge removed): the previous role badge read u.role,
            // but the API never returned a `role` field — it was dead code that
            // always rendered as an empty string. Removed to avoid confusion.

            // Avatar gold gradient only for APP Premium (the real entitlement),
            // NOT for Telegram messenger Premium.
            html += '<div class="admin-list-item adm-user-card">' +
                // Row 1: avatar + name + badges
                '<div class="adm-card-top">' +
                    '<div class="adm-card-avatar' + (isAppPremium ? ' adm-card-avatar--premium' : '') + '">' + adminEscapeHtml((displayName || 'ک').charAt(0)) + '</div>' +
                    '<div class="adm-card-id">' +
                        '<div class="adm-card-name">' + adminEscapeHtml(displayName) + '</div>' +
                        '<div class="adm-card-sub">' +
                            (username ? adminEscapeHtml(username) + ' · ' : '') +
                            'ID: <span class="adm-card-tgid">' + adminEscapeHtml(tgId) + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="adm-card-badges">' +
                        statusBadge + channelBadge + tgPremiumBadge + appPremiumBadge +
                    '</div>' +
                '</div>' +
                // Row 2: meta grid — uniform columns
                '<div class="adm-card-meta">' +
                    '<span class="adm-meta-item"><span class="adm-meta-label">عضویت</span><span class="adm-meta-val adm-meta-val-date">' + adminFormatDate(u.created_at || u.join_date) + '</span></span>' +
                    '<span class="adm-meta-item"><span class="adm-meta-label">آخرین فعالیت</span><span class="adm-meta-val adm-meta-val-date">' + (u.last_active ? adminFormatDate(u.last_active) : '—') + '</span></span>' +
                    '<span class="adm-meta-item"><span class="adm-meta-label">توکن</span><span class="adm-meta-val">' + adminEscapeHtml(String(tokens)) + '</span></span>' +
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
            const statusInfo = {
                open: { label: 'باز', cls: 'tk-status-open', icon: '🔵' },
                answered: { label: 'پاسخ داده شده', cls: 'tk-status-answered', icon: '🟡' },
                closed: { label: 'بسته شده', cls: 'tk-status-closed', icon: '⚫' },
            };
            const si = statusInfo[t.status] || { label: String(t.status || ''), cls: 'tk-status-closed', icon: '⚪' };
            const isExpanded = !!_adminTicketsExpanded[t.id];
            const replies = (t.replies && t.replies.length) ? t.replies : [];
            const priorityCls = t.priority === 'high' ? 'tk-priority-high' : (t.priority === 'medium' ? 'tk-priority-medium' : 'tk-priority-low');

            html += '<div class="tk-card ' + (isExpanded ? 'tk-expanded' : '') + '" id="adm-ticket-' + adminEscapeHtml(String(t.id)) + '">' +
                '<div class="tk-card-header" onclick="toggleAdminTicketDetail(\'' + adminEscapeHtml(String(t.id)).replace(/'/g, '&#39;') + '\')">' +
                    '<div class="tk-card-header-left">' +
                        '<span class="tk-card-icon ' + si.cls + '">' + si.icon + '</span>' +
                        '<div class="tk-card-header-text">' +
                            '<span class="tk-card-subject">' + adminEscapeHtml(t.subject || t.title || 'تیکت #' + (t.id || '')) + '</span>' +
                            '<span class="tk-card-user">' + adminEscapeHtml(t.user_name || t.username || 'کاربر') + ' · ID: ' + adminEscapeHtml(String(t.telegram_id || t.user_id || '')) + '</span>' +
                        '</div>' +
                    '</div>' +
                    '<div class="tk-card-header-right">' +
                        '<span class="tk-badge ' + si.cls + '">' + si.label + '</span>' +
                        '<span class="tk-card-arrow ' + (isExpanded ? 'tk-arrow-open' : '') + '"><svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><polyline points="6 9 12 15 18 9"/></svg></span>' +
                    '</div>' +
                '</div>' +
                '<div class="tk-card-preview">' + adminEscapeHtml((t.message || t.last_message || '').substring(0, 120)) + (t.message && t.message.length > 120 ? '…' : '') + '</div>' +
                '<div class="tk-card-footer">' +
                    '<span class="tk-card-date">' + adminFormatDate(t.created_at || t.date) + '</span>' +
                    (t.updated_at ? '<span class="tk-card-updated">· به‌روزرسانی: ' + adminFormatDate(t.updated_at) + '</span>' : '') +
                    (replies.length ? '<span class="tk-card-replies">💬 ' + replies.length + ' پاسخ</span>' : '') +
                '</div>';

            // Expanded detail: conversation history + reply form + status controls
            if (isExpanded) {
                html += '<div class="tk-detail">';

                // Conversation thread
                html += '<div class="tk-thread adm-ticket-thread">';
                // Original message
                html += '<div class="tk-msg tk-msg-user">' +
                    '<div class="tk-msg-header"><span class="tk-msg-author">' + adminEscapeHtml(t.user_name || 'کاربر') + '</span><span class="tk-msg-time">' + adminFormatDate(t.created_at) + '</span></div>' +
                    '<div class="tk-msg-body">' + adminEscapeHtml(t.message || t.body || '') + '</div>' +
                    '</div>';
                // Replies
                replies.forEach(function (r) {
                    var isAdmin = r.from === 'admin' || r.is_admin;
                    html += '<div class="tk-msg ' + (isAdmin ? 'tk-msg-admin' : 'tk-msg-user') + '">' +
                        '<div class="tk-msg-header"><span class="tk-msg-author">' + (isAdmin ? 'مدیر' : adminEscapeHtml(t.user_name || 'کاربر')) + '</span><span class="tk-msg-time">' + adminFormatDate(r.at || r.created_at) + '</span></div>' +
                        '<div class="tk-msg-body">' + adminEscapeHtml(r.message || r.text || '') + '</div>' +
                        '</div>';
                });
                html += '</div>';

                // Reply form
                html += '<div class="tk-reply-form">' +
                    '<textarea id="adm-reply-' + adminEscapeHtml(String(t.id)) + '" class="tk-reply-input" placeholder="پاسخ خود را بنویسید..." rows="3"></textarea>' +
                    '<button class="tk-btn tk-btn-primary" onclick="adminReplyTicket(\'' + adminEscapeJsId(t.id) + '\')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg> ارسال پاسخ</button>' +
                    '</div>';

                // Status controls
                html += '<div class="tk-actions">';
                if (t.status !== 'closed') {
                    html += '<button class="tk-btn tk-btn-ghost" onclick="adminSetTicketStatus(\'' + adminEscapeJsId(t.id) + '\',\'closed\')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M18 6L6 18M6 6l12 12"/></svg> بستن</button>';
                }
                if (t.status !== 'open') {
                    html += '<button class="tk-btn tk-btn-ghost" onclick="adminSetTicketStatus(\'' + adminEscapeJsId(t.id) + '\',\'open\')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg> باز کردن</button>';
                }
                if (t.status !== 'answered') {
                    html += '<button class="tk-btn tk-btn-ghost" onclick="adminSetTicketStatus(\'' + adminEscapeJsId(t.id) + '\',\'answered\')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="20 6 9 17 4 12"/></svg> پاسخ داده شده</button>';
                }
                html += '<button class="tk-btn tk-btn-danger" onclick="adminDeleteTicket(\'' + adminEscapeJsId(t.id) + '\')"><svg width="13" height="13" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> حذف</button>';
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
            html += '<div class="tk-msg ' + (isAdmin ? 'tk-msg-admin' : 'tk-msg-user') + '">' +
                '<div class="tk-msg-header"><span class="tk-msg-author">' + (isAdmin ? 'مدیر' : 'کاربر') + '</span><span class="tk-msg-time">' + adminFormatDate(r.created_at) + '</span></div>' +
                '<div class="tk-msg-body">' + adminEscapeHtml(r.body || '') + '</div>' +
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
    // FIX: the HTML uses class "adm-filter-btn" (not "admin-filter-btn").
    // Previously querySelectorAll('.admin-filter-btn') found 0 elements →
    // active was never removed from siblings → ALL tabs appeared selected.
    const parent = btn ? btn.parentElement : null;
    if (parent) {
        parent.querySelectorAll('.adm-filter-btn').forEach(function (b) { b.classList.remove('active'); });
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
                (r.status === 'pending' ?
                    '<div class="admin-list-item-actions" style="margin-top:8px;display:flex;gap:6px;">' +
                        '<button class="admin-btn admin-btn-sm admin-btn-green" onclick="adminApproveReward(\'' + adminEscapeJsId(r.id) + '\')">تأیید</button>' +
                        '<button class="admin-btn admin-btn-sm admin-btn-red" onclick="adminRejectReward(\'' + adminEscapeJsId(r.id) + '\')">رد</button>' +
                    '</div>'
                : '') +
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
        // FIX: same class name mismatch as filterAdminTickets — HTML uses "adm-filter-btn".
        parent.querySelectorAll('.adm-filter-btn').forEach(function (b) { b.classList.remove('active'); });
        btn.classList.add('active');
    }
    loadAdminRewards();
}

// A-4 Rewards UI: Approve/Reject actions for pending rewards
var _adminRewardActionInProgress = false;

async function adminApproveReward(rewardId) {
    if (_adminRewardActionInProgress) return;
    _adminRewardActionInProgress = true;
    try {
        const data = await adminApiFetch('/api/admin/rewards/' + encodeURIComponent(rewardId) + '/status', {
            method: 'PUT',
            body: JSON.stringify({ status: 'approved' }),
        });
        if (data && data.status === 'success') {
            adminToast('پاداش تأیید شد', 'success');
            loadAdminRewards();
        } else {
            adminToast(data?.message || 'خطا در تأیید پاداش', 'error');
        }
    } catch (e) {
        adminToast('خطا در ارتباط با سرور', 'error');
        console.error('adminApproveReward:', e);
    } finally {
        _adminRewardActionInProgress = false;
    }
}

async function adminRejectReward(rewardId) {
    if (_adminRewardActionInProgress) return;
    _adminRewardActionInProgress = true;
    try {
        const data = await adminApiFetch('/api/admin/rewards/' + encodeURIComponent(rewardId) + '/status', {
            method: 'PUT',
            body: JSON.stringify({ status: 'rejected' }),
        });
        if (data && data.status === 'success') {
            adminToast('پاداش رد شد', 'success');
            loadAdminRewards();
        } else {
            adminToast(data?.message || 'خطا در رد پاداش', 'error');
        }
    } catch (e) {
        adminToast('خطا در ارتباط با سرور', 'error');
        console.error('adminRejectReward:', e);
    } finally {
        _adminRewardActionInProgress = false;
    }
}
window.adminApproveReward = adminApproveReward;
window.adminRejectReward = adminRejectReward;

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
                        <div class="rc-field"><label>کوپل‌داون</label><select id="rc-wc-cooldown" onchange="document.getElementById('rc-wc-cooldown-custom').style.display = this.value === 'custom' ? '' : 'none'"><option value="0">بدون کوپل‌داون</option><option value="3600">۱ ساعت</option><option value="21600">۶ ساعت</option><option value="43200">۱۲ ساعت</option><option value="86400">۲۴ ساعت</option><option value="151200">۴۲ ساعت</option><option value="259200">۷۲ ساعت</option><option value="604800">هفتگی</option><option value="custom">سفارشی</option></select><input type="number" id="rc-wc-cooldown-custom" style="display:none;" placeholder="ثانیه" min="60"></div>
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
        cooldown_seconds: (() => {
            const sel = document.getElementById('rc-wc-cooldown')?.value || '0';
            if (sel === 'custom') return Number(document.getElementById('rc-wc-cooldown-custom')?.value || 0);
            return Number(sel);
        })(),
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
                        <button class="adm-btn-sm" onclick="toggleRcWheelReward(${adminEscapeHtml(String(r.id))}, ${!r.is_active})">${r.is_active ? 'غیرفعال' : 'فعال'}</button>
                        <button class="adm-btn-sm adm-btn-danger" onclick="deleteRcWheelReward(${adminEscapeHtml(String(r.id))})">حذف</button>
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
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcReferralTier(${adminEscapeHtml(String(t.id))})">حذف</button></td>
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
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcMissionReward(${adminEscapeHtml(String(m.id))})">حذف</button></td>
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
                    <td><button class="adm-btn-sm adm-btn-danger" onclick="deleteRcLibraryItem(${adminEscapeHtml(String(item.id))})">حذف</button></td>
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
            _npTemplateCache = data.templates;
            rows = data.templates.map(function (t) {
                return '<tr>' +
                    '<td>' + adminEscapeHtml(t.key) + '</td>' +
                    '<td>' + adminEscapeHtml(t.category) + '</td>' +
                    '<td>' + adminEscapeHtml(t.priority) + '</td>' +
                    '<td>' + adminEscapeHtml(t.channel) + '</td>' +
                    '<td>' + (t.is_active ? '<span class="admin-badge green">فعال</span>' : '<span class="admin-badge gray">غیرفعال</span>') + '</td>' +
                    '<td><button class="adm-btn-sm" onclick="editNpTemplate(\'' + adminEscapeJsId(t.id) + '\')">ویرایش</button></td>' +
                '</tr>';
            }).join('');
        }
        section.innerHTML = '<div class="rc-card"><h4 class="rc-card-title">قالب‌های اعلان</h4>' +
            '<button class="adm-btn adm-btn-primary" onclick="showNpTemplateForm()" style="margin-bottom:10px;">افزودن قالب</button>' +
            '<div class="adm-table-wrap"><table class="adm-table"><thead><tr><th>کلید</th><th>دسته</th><th>اولویت</th><th>کانال</th><th>وضعیت</th><th>عملیات</th></tr></thead><tbody>' + (rows || '<tr><td colspan="6" class="admin-empty">قالبی موجود نیست</td></tr>') + '</tbody></table></div></div>';
    } catch (e) { section.innerHTML = '<div class="admin-empty">خطا</div>'; console.error(e); }
}
window.loadNpTemplates = loadNpTemplates;

// Notification Templates UI: Create/Edit form
var _npTemplateCache = [];

function showNpTemplateForm() {
    var section = document.getElementById('np-templates-section');
    if (!section) return;
    section.innerHTML = '<div class="rc-card"><h4 class="rc-card-title">قالب جدید</h4>' +
        '<div class="rc-form-grid">' +
        '<div class="rc-field"><label>کلید</label><input type="text" id="np-tpl-key" placeholder="wheel_reward"></div>' +
        '<div class="rc-field"><label>دسته</label><input type="text" id="np-tpl-category" value="system"></div>' +
        '<div class="rc-field"><label>اولویت</label><select id="np-tpl-priority"><option value="low">low</option><option value="medium" selected>medium</option><option value="high">high</option></select></div>' +
        '<div class="rc-field"><label>کانال</label><select id="np-tpl-channel"><option value="mini_app">mini_app</option><option value="telegram">telegram</option><option value="both" selected>both</option></select></div>' +
        '<div class="rc-field"><label>عنوان</label><input type="text" id="np-tpl-title" placeholder="عنوان اعلان"></div>' +
        '<div class="rc-field"><label>فعال</label><select id="np-tpl-active"><option value="true">بله</option><option value="false">خیر</option></select></div>' +
        '</div>' +
        '<div class="rc-field" style="margin-top:10px;"><label>متن پیام</label><textarea id="np-tpl-message" rows="4" placeholder="متن اعلان..."></textarea></div>' +
        '<button class="adm-btn adm-btn-primary" onclick="saveNpTemplate(null)" style="margin-top:10px;">ذخیره</button> ' +
        '<button class="adm-btn" onclick="loadNpTemplates()">انصراف</button>' +
        '</div>';
}

function editNpTemplate(templateId) {
    var tpl = _npTemplateCache.find(function (t) { return String(t.id) === String(templateId); });
    if (!tpl) { adminToast('قالب یافت نشد', 'error'); return; }
    var section = document.getElementById('np-templates-section');
    if (!section) return;
    section.innerHTML = '<div class="rc-card"><h4 class="rc-card-title">ویرایش قالب: ' + adminEscapeHtml(tpl.key) + '</h4>' +
        '<div class="rc-form-grid">' +
        '<div class="rc-field"><label>دسته</label><input type="text" id="np-tpl-category" value="' + adminEscapeHtml(tpl.category || '') + '"></div>' +
        '<div class="rc-field"><label>اولویت</label><select id="np-tpl-priority"><option value="low"' + (tpl.priority === 'low' ? ' selected' : '') + '>low</option><option value="medium"' + (tpl.priority === 'medium' ? ' selected' : '') + '>medium</option><option value="high"' + (tpl.priority === 'high' ? ' selected' : '') + '>high</option></select></div>' +
        '<div class="rc-field"><label>کانال</label><select id="np-tpl-channel"><option value="mini_app"' + (tpl.channel === 'mini_app' ? ' selected' : '') + '>mini_app</option><option value="telegram"' + (tpl.channel === 'telegram' ? ' selected' : '') + '>telegram</option><option value="both"' + (tpl.channel === 'both' ? ' selected' : '') + '>both</option></select></div>' +
        '<div class="rc-field"><label>عنوان</label><input type="text" id="np-tpl-title" value="' + adminEscapeHtml(tpl.title || '') + '"></div>' +
        '<div class="rc-field"><label>فعال</label><select id="np-tpl-active"><option value="true"' + (tpl.is_active ? ' selected' : '') + '>بله</option><option value="false"' + (!tpl.is_active ? ' selected' : '') + '>خیر</option></select></div>' +
        '</div>' +
        '<div class="rc-field" style="margin-top:10px;"><label>متن پیام</label><textarea id="np-tpl-message" rows="4">' + adminEscapeHtml(tpl.message || '') + '</textarea></div>' +
        '<button class="adm-btn adm-btn-primary" onclick="saveNpTemplate(\'' + adminEscapeJsId(templateId) + '\')" style="margin-top:10px;">به‌روزرسانی</button> ' +
        '<button class="adm-btn" onclick="loadNpTemplates()">انصراف</button> ' +
        '<button class="adm-btn adm-btn-red" onclick="deleteNpTemplate(\'' + adminEscapeJsId(templateId) + '\')">حذف</button>' +
        '</div>';
}

async function saveNpTemplate(templateId) {
    var payload = {
        key: document.getElementById('np-tpl-key') ? document.getElementById('np-tpl-key').value : undefined,
        category: document.getElementById('np-tpl-category') ? document.getElementById('np-tpl-category').value : 'system',
        priority: document.getElementById('np-tpl-priority') ? document.getElementById('np-tpl-priority').value : 'medium',
        channel: document.getElementById('np-tpl-channel') ? document.getElementById('np-tpl-channel').value : 'both',
        title: document.getElementById('np-tpl-title') ? document.getElementById('np-tpl-title').value : '',
        message: document.getElementById('np-tpl-message') ? document.getElementById('np-tpl-message').value : '',
        is_active: document.getElementById('np-tpl-active') ? document.getElementById('np-tpl-active').value === 'true' : true,
    };
    // Remove undefined fields
    Object.keys(payload).forEach(function (k) { if (payload[k] === undefined) delete payload[k]; });
    try {
        var url = '/api/admin/notifications/templates';
        var method = 'POST';
        if (templateId) { url = '/api/admin/notifications/templates/' + encodeURIComponent(templateId); method = 'PUT'; }
        var data = await adminApiFetch(url, { method: method, body: JSON.stringify(payload) });
        if (data && data.status === 'success') { adminToast('قالب ذخیره شد', 'success'); loadNpTemplates(); }
        else { adminToast(data?.message || 'خطا در ذخیره', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error('saveNpTemplate:', e); }
}

async function deleteNpTemplate(templateId) {
    if (!confirm('از حذف این قالب مطمئن هستید؟')) return;
    try {
        var data = await adminApiFetch('/api/admin/notifications/templates/' + encodeURIComponent(templateId), { method: 'DELETE' });
        if (data && data.status === 'success') { adminToast('قالب حذف شد', 'success'); loadNpTemplates(); }
        else { adminToast(data?.message || 'خطا در حذف', 'error'); }
    } catch (e) { adminToast('خطا', 'error'); console.error('deleteNpTemplate:', e); }
}
window.showNpTemplateForm = showNpTemplateForm;
window.editNpTemplate = editNpTemplate;
window.saveNpTemplate = saveNpTemplate;
window.deleteNpTemplate = deleteNpTemplate;

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
// ADVERTISEMENTS — Admin UI for Channel Join / Popup / Message campaigns
// Backend: src/controllers/advertisements.js + src/repositories/advertisements.js
// Three sub-tabs (channels / popups / messages) follow the reward-center
// and notification-center pattern (.rc-tabs + .rc-tab-content).
// ════════════════════════════════════════════════════════════════════

var _adsCurrentTab = 'channels';
var _adsChannelCache = [];
var _adsPopupCache = [];
var _adsMessageCache = [];

// ════════════════════════════════════════════════════════════════════
// PHASE 3 — SVG icon set for Advertisement Admin UI.
// Uses the SAME icon style as the rest of the admin panel:
//   viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"
//   stroke-linecap="round" stroke-linejoin="round"
// No icon library added — pure inline SVG, consistent with sidebar nav
// and ticket buttons. Icons sized via CSS (.adm-btn svg, .rc-tab svg).
// ════════════════════════════════════════════════════════════════════
var _ADS_ICONS = {
    megaphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/><path d="M3 11v3a2 2 0 0 0 2 2h1v-7H5a2 2 0 0 0-2 2z"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    layout: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="2"/><line x1="3" y1="9" x2="21" y2="9"/><line x1="9" y1="21" x2="9" y2="9"/></svg>',
    mail: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16c1.1 0 2 .9 2 2v12c0 1.1-.9 2-2 2H4c-1.1 0-2-.9-2-2V6c0-1.1.9-2 2-2z"/><polyline points="22,6 12,13 2,6"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    pencil: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M17 3a2.85 2.83 0 1 1 4 4L7.5 20.5 2 22l1.5-5.5L17 3z"/></svg>',
    upload: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4"/><polyline points="17 8 12 3 7 8"/><line x1="12" y1="3" x2="12" y2="15"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    smartphone: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2" ry="2"/><line x1="12" y1="18" x2="12.01" y2="18"/></svg>',
    send: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    trash: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>',
    close: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>',
    inbox: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11L2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/></svg>',
    alertCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    refresh: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><polyline points="1 20 1 14 7 14"/><path d="M3.51 9a9 9 0 0 1 14.85-3.36L23 10M1 14l4.64 4.36A9 9 0 0 0 20.49 15"/></svg>',
};

// Helper: render an icon by key with optional CSS class.
function _adsIcon(key, className) {
    var svg = _ADS_ICONS[key] || '';
    if (className && svg) {
        return svg.replace('<svg ', '<svg class="' + className + '" ');
    }
    return svg;
}

// Helper: icon + label span (for buttons / tabs).
function _adsIconLabel(iconKey, label) {
    return '<span class="adm-icon-wrap">' + _adsIcon(iconKey, 'adm-btn-icon') + '</span><span>' + adminEscapeHtml(label) + '</span>';
}

// ════════════════════════════════════════════════════════════════════
// PHASE 5 — Premium empty + error states with SVG icons + CTA.
// Replaces the old plain "کانالی موجود نیست" / "خطا در بارگذاری" text.
// ════════════════════════════════════════════════════════════════════
function _adsEmptyState(iconKey, message, ctaFn, ctaLabel) {
    var cta = (ctaFn && ctaLabel)
        ? '<button class="adm-btn adm-btn-primary ads-empty-cta" onclick="' + adminEscapeHtml(ctaFn) + '">' + _adsIcon('plus', 'adm-btn-icon') + adminEscapeHtml(ctaLabel) + '</button>'
        : '';
    return '<div class="ads-empty-state">' +
        '<div class="ads-empty-icon">' + _adsIcon(iconKey || 'inbox', 'ads-empty-svg') + '</div>' +
        '<div class="ads-empty-text">' + adminEscapeHtml(message || 'موردی موجود نیست') + '</div>' +
        cta +
    '</div>';
}

function _adsErrorState(message, retryFn) {
    return '<div class="ads-error-state">' +
        '<div class="ads-error-icon">' + _adsIcon('alertCircle', 'ads-error-svg') + '</div>' +
        '<div class="ads-error-text">' + adminEscapeHtml(message || 'بارگذاری اطلاعات انجام نشد') + '</div>' +
        '<button class="adm-btn ads-retry-btn" onclick="' + adminEscapeHtml(retryFn) + '()">' + _adsIcon('refresh', 'adm-btn-icon') + 'تلاش مجدد</button>' +
    '</div>';
}

// ════════════════════════════════════════════════════════════════════
// PHASE 2 UI FIX — Compact card-based layout for advertisement items.
// Replaces the old table layout (status badge in own column, text falling
// below each other, excessive whitespace, no hierarchy).
//
// Card structure:
//   ┌───────────────────────────────────────────────────────┐
//   │ [icon] Title                    [STATUS BADGE]         │  ← header
//   │ @username · destination · cooldown                    │  ← meta
//   │ ───────────────────────────────────────────────────── │  ← divider
//   │ [Edit] [Send] [Status▾] [Delete]                      │  ← actions
//   └───────────────────────────────────────────────────────┘
//
// CSS classes: .ads-item-card, .ads-item-head, .ads-item-title,
// .ads-item-meta, .ads-item-divider, .ads-item-actions
// ════════════════════════════════════════════════════════════════════
function _adsItemCard(opts) {
    // opts: { icon, title, titleIcon, statusBadge, metaParts (array), actions (html), thumbnail }
    var metaHtml = (opts.metaParts && opts.metaParts.filter(Boolean).length > 0)
        ? '<div class="ads-item-meta">' + opts.metaParts.filter(Boolean).join(' <span class="ads-meta-sep">·</span> ') + '</div>'
        : '';
    var thumbHtml = opts.thumbnail
        ? '<img class="ads-item-thumb" src="' + adminEscapeHtml(opts.thumbnail) + '" alt="">'
        : '';
    var iconHtml = opts.titleIcon
        ? '<span class="ads-item-icon">' + _adsIcon(opts.titleIcon, 'ads-item-svg') + '</span>'
        : '';
    return '<div class="ads-item-card">' +
        '<div class="ads-item-head">' +
            '<div class="ads-item-title-wrap">' +
                thumbHtml + iconHtml +
                '<div class="ads-item-title-group">' +
                    '<div class="ads-item-title">' + (opts.title || '—') + '</div>' +
                    (opts.subtitle ? '<div class="ads-item-subtitle">' + opts.subtitle + '</div>' : '') +
                '</div>' +
            '</div>' +
            (opts.statusBadge ? '<div class="ads-item-status">' + opts.statusBadge + '</div>' : '') +
        '</div>' +
        metaHtml +
        (opts.actions ? '<div class="ads-item-divider"></div><div class="ads-item-actions">' + opts.actions + '</div>' : '') +
    '</div>';
}

// Build a compact status dropdown styled as a small pill button (not a raw select)
function _adsStatusPill(setterFnName, id, currentStatus) {
    var meta = _adStatusMeta(currentStatus);
    var opts = [
        { value: 'draft', label: 'پیش‌نویس' },
        { value: 'active', label: 'فعال' },
        { value: 'paused', label: 'متوقف' },
        { value: 'archived', label: 'بایگانی' },
    ];
    var html = '<select class="ads-status-pill ads-status-' + meta.color + '" onchange="' + adminEscapeHtml(setterFnName) +
        '(\'' + adminEscapeJsId(String(id)) + '\', this.value)" title="تغییر وضعیت">';
    opts.forEach(function (o) {
        html += '<option value="' + adminEscapeHtml(o.value) + '"' + (currentStatus === o.value ? ' selected' : '') + '>' + adminEscapeHtml(o.label) + '</option>';
    });
    html += '</select>';
    return html;
}

// FIX (audit H3): Submit button loading state to prevent double-clicks.
// Disables the button + shows "..." text during the API call. Re-enables on
// completion (success or error). Used by saveAdChannel/saveAdPopup/saveAdMessage.
function _adsSetBtnLoading(btnSelector, loading, loadingText) {
    var btn = document.querySelector(btnSelector);
    if (!btn) return;
    if (loading) {
        if (!btn.dataset._origText) btn.dataset._origText = btn.textContent;
        btn.disabled = true;
        btn.style.opacity = '0.65';
        btn.style.pointerEvents = 'none';
        btn.textContent = loadingText || '...';
    } else {
        btn.disabled = false;
        btn.style.opacity = '';
        btn.style.pointerEvents = '';
        if (btn.dataset._origText) btn.textContent = btn.dataset._origText;
    }
}

// Persian labels + color classes for campaign statuses
// FIX (audit H2): archived and draft were both 'gray' — visually indistinguishable.
// Now archived uses a distinct dark-gray with strikethrough styling (see CSS).
function _adStatusMeta(status) {
    switch (status) {
        case 'active':   return { label: 'فعال',    color: 'green' };
        case 'paused':   return { label: 'متوقف',   color: 'orange' };
        case 'archived': return { label: 'بایگانی', color: 'gray-dark' };
        case 'draft': default: return { label: 'پیش‌نویس', color: 'gray' };
    }
}

function _adStatusBadge(status) {
    var meta = _adStatusMeta(status);
    return '<span class="admin-badge admin-badge-' + meta.color + '">' + adminEscapeHtml(meta.label) + '</span>';
}

// Build a small inline status dropdown for a campaign row
function _adStatusSelect(setterFnName, id, currentStatus) {
    var opts = [
        { value: 'draft', label: 'پیش‌نویس' },
        { value: 'active', label: 'فعال' },
        { value: 'paused', label: 'متوقف' },
        { value: 'archived', label: 'بایگانی' },
    ];
    var html = '<select class="adm-input adm-input-sm" onchange="' + adminEscapeHtml(setterFnName) +
        '(\'' + adminEscapeJsId(String(id)) + '\', this.value)" style="padding:5px 8px;font-size:11px;min-width:96px;">';
    opts.forEach(function (o) {
        html += '<option value="' + adminEscapeHtml(o.value) + '"' + (currentStatus === o.value ? ' selected' : '') + '>' + adminEscapeHtml(o.label) + '</option>';
    });
    html += '</select>';
    return html;
}

// Persian labels + color classes for destinations (mini_app/telegram/both)
function _adsDestinationMeta(dest) {
    switch (dest) {
        case 'mini_app': return { iconKey: 'smartphone', label: 'مینی‌اپ', color: 'blue' };
        case 'telegram': return { iconKey: 'send', label: 'تلگرام', color: 'blue' };
        case 'both': default: return { iconKey: 'both', label: 'هر دو', color: 'blue' };
    }
}

// Persian labels + color classes for target audience (free/premium/all)
// FIX (audit H1): colors now match spec — free=blue, premium=amber/gold (using
// the existing 'orange' badge which is the amber accent), all=gray.
function _adsAudienceMeta(aud) {
    switch (aud) {
        case 'free':    return { label: 'رایگان',  color: 'blue' };
        case 'premium': return { label: 'ویژه',    color: 'orange' };
        case 'all': default: return { label: 'همه', color: 'gray' };
    }
}

// ─── Tab Switcher ────────────────────────────────────────────

function switchAdsTab(tab, btn) {
    _adsCurrentTab = tab;
    document.querySelectorAll('#ads-tabs .rc-tab').forEach(function (t) { t.classList.remove('active'); });
    if (btn) btn.classList.add('active');
    else {
        var target = document.querySelector('#ads-tabs .rc-tab[data-ads-tab="' + tab + '"]');
        if (target) target.classList.add('active');
    }
    document.querySelectorAll('#admin-section-advertisements .rc-tab-content').forEach(function (c) { c.style.display = 'none'; });
    var active = document.getElementById('ads-tab-' + tab);
    if (active) active.style.display = '';
    switch (tab) {
        case 'channels': loadAdChannels(); break;
        case 'popups':   loadAdPopups();   break;
        case 'messages': loadAdMessages(); break;
    }
}
window.switchAdsTab = switchAdsTab;

// Entry point — called when the parent "advertisements" nav item is clicked.
function loadAdvertisementsOverview() {
    switchAdsTab('channels', null);
}
window.loadAdvertisementsOverview = loadAdvertisementsOverview;

// ─── Shared Image Upload Widget ──────────────────────────────
// Converts a file → base64 data URI via FileReader.readAsDataURL,
// then POSTs to /api/admin/advertisements/upload-image and fills
// the target input with the returned URL. Shows a live preview.

async function uploadAdImage(file, targetInputId, previewImgId) {
    if (!file) return;
    if (file.size > 500 * 1024) {
        adminToast('حجم تصویر باید کمتر از ۵۰۰ کیلوبایت باشد', 'error');
        return;
    }
    var allowed = ['image/jpeg', 'image/png', 'image/webp', 'image/gif', 'image/avif'];
    if (allowed.indexOf(file.type) === -1) {
        adminToast('فرمت تصویر پشتیبانی نمی‌شود (JPEG/PNG/WEBP/GIF/AVIF)', 'error');
        return;
    }
    var reader = new FileReader();
    reader.onload = async function (e) {
        var dataUri = e.target.result;
        // Show local preview immediately (before upload completes)
        var preview = document.getElementById(previewImgId);
        if (preview) {
            preview.src = dataUri;
            preview.style.display = 'block';
        }
        try {
            adminToast('در حال آپلود تصویر...', 'info');
            var data = await adminApiFetch('/api/admin/advertisements/upload-image', {
                method: 'POST',
                body: JSON.stringify({ data_uri: dataUri, content_type: file.type })
            });
            if (data && data.status === 'success' && data.url) {
                var input = document.getElementById(targetInputId);
                if (input) input.value = data.url;
                adminToast('تصویر آپلود شد', 'success');
            } else {
                adminToast((data && data.message) || 'خطا در آپلود تصویر', 'error');
            }
        } catch (err) {
            console.error('uploadAdImage:', err);
            adminToast('خطا در آپلود: ' + (err.message || ''), 'error');
        }
    };
    reader.onerror = function () {
        adminToast('خطا در خواندن فایل تصویر', 'error');
    };
    reader.readAsDataURL(file);
}
window.uploadAdImage = uploadAdImage;

// ════════════════════════════════════════════════════════════════════
// CHANNELS — /api/admin/advertisements/channels
// ════════════════════════════════════════════════════════════════════

async function loadAdChannels() {
    var section = document.getElementById('ads-channels-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty"><span class="ads-spinner"></span> در حال بارگذاری...</div>';
    var token = _adminLoadToken;
    try {
        var data = await adminApiFetch('/api/admin/advertisements/channels');
        if (_isLoadTokenStale(token)) return;
        if (data && data.status === 'success' && Array.isArray(data.channels)) {
            _adsChannelCache = data.channels;
            var cards = data.channels.map(function (c) {
                var username = c.channel_username ? '@' + adminEscapeHtml(c.channel_username) : '—';
                var title = c.channel_title ? adminEscapeHtml(c.channel_title) : '—';
                var status = c.campaign_status || c.status || 'draft';
                var statusBadge = _adStatusBadge(status);
                var isActive = c.is_active ? '<span class="ads-meta-tag">نمایش: بله</span>' : '<span class="ads-meta-tag muted">نمایش: خیر</span>';
                var order = '<span class="ads-meta-tag">ترتیب: ' + adminFormatNumber(c.display_order || 0) + '</span>';
                var joinUrl = c.join_url ? '<span class="ads-meta-tag ltr">' + adminEscapeHtml(c.join_url) + '</span>' : '';
                var statusPill = _adsStatusPill('setAdChannelStatus', c.id, status);
                var actions =
                    '<button class="adm-btn-sm" onclick="showAdChannelForm(\'' + adminEscapeJsId(String(c.id)) + '\')">' + _adsIcon('edit', 'adm-btn-icon') + 'ویرایش</button>' +
                    statusPill +
                    '<button class="adm-btn-sm adm-btn-danger" onclick="deleteAdChannel(\'' + adminEscapeJsId(String(c.id)) + '\')">' + _adsIcon('trash', 'adm-btn-icon') + 'حذف</button>';
                return _adsItemCard({
                    titleIcon: 'link',
                    title: title,
                    subtitle: username,
                    statusBadge: statusBadge,
                    metaParts: [isActive, order, joinUrl],
                    actions: actions
                });
            }).join('');
            section.innerHTML =
                '<div class="ads-help-banner">' +
                    _adsIcon('info', 'ads-help-icon') +
                    '<span>این کانال‌ها به عنوان کانال‌های موردنیاز عضویت تنظیم می‌شوند. کاربر باید عضو همه کانال‌های فعال باشد.</span>' +
                '</div>' +
                '<div class="rc-card">' +
                    '<div class="ads-card-head-row">' +
                        '<h4 class="rc-card-title">' + _adsIcon('link', 'rc-card-icon') + 'کانال‌های عضویت</h4>' +
                        '<button class="adm-btn adm-btn-primary" onclick="showAdChannelForm(null)">' + _adsIcon('plus', 'adm-btn-icon') + 'افزودن کانال</button>' +
                    '</div>' +
                    '<div id="ads-channel-form" style="display:none;margin-bottom:14px;"></div>' +
                    '<div class="ads-item-list">' +
                        (cards || _adsEmptyState('link', 'هنوز کانالی اضافه نشده است', 'showAdChannelForm(null)', 'افزودن اولین کانال')) +
                    '</div>' +
                '</div>';
        } else {
            _adsChannelCache = [];
            section.innerHTML = _adsEmptyState('link', 'داده‌ای دریافت نشد', 'loadAdChannels', 'تلاش مجدد');
        }
    } catch (e) {
        _adsChannelCache = [];
        section.innerHTML = _adsErrorState('بارگذاری کانال‌ها انجام نشد', 'loadAdChannels');
        console.error('loadAdChannels:', e);
    }
}
window.loadAdChannels = loadAdChannels;

function showAdChannelForm(channelId) {
    var form = document.getElementById('ads-channel-form');
    if (!form) return;
    // Create mode (channelId is null/undefined)
    if (channelId === null || channelId === undefined) {
        form.style.display = form.style.display === 'none' ? '' : 'none';
        if (form.style.display === 'none') return;
        form.innerHTML =
            '<div class="rc-card" style="border-color:rgba(245,166,35,0.3);">' +
                '<h4 class="rc-card-title">' + _adsIcon('plus', 'rc-card-icon') + 'کانال جدید</h4>' +
                '<div class="rc-form-grid">' +
                    '<div class="rc-field"><label>یوزرنیم کانال (بدون @)</label><input type="text" id="ads-ch-username" placeholder="amirbtc"></div>' +
                    '<div class="rc-field"><label>عنوان کانال</label><input type="text" id="ads-ch-title" placeholder="کانال امیر بیت‌کوین"></div>' +
                    '<div class="rc-field"><label>لینک عضویت</label><input type="text" id="ads-ch-joinurl" placeholder="https://t.me/amirbtc" dir="ltr"></div>' +
                    '<div class="rc-field"><label>ترتیب نمایش</label><input type="number" id="ads-ch-order" value="0" min="0"></div>' +
                    '<div class="rc-field"><label>وضعیت کمپین</label><select id="ads-ch-status"><option value="draft">پیش‌نویس</option><option value="active" selected>فعال</option><option value="paused">متوقف</option><option value="archived">بایگانی</option></select></div>' +
                    '<div class="rc-field"><label>نمایش</label><label class="rc-toggle-row"><input type="checkbox" id="ads-ch-active" checked><span>فعال برای نمایش</span></label></div>' +
                '</div>' +
                '<button class="adm-btn adm-btn-primary" onclick="saveAdChannel(null)" style="margin-top:10px;">ایجاد کانال</button> ' +
                '<button class="adm-btn" onclick="document.getElementById(\'ads-channel-form\').style.display=\'none\'" style="margin-top:10px;">انصراف</button>' +
            '</div>';
        return;
    }
    // Edit mode — find in cache
    var ch = _adsChannelCache.find(function (c) { return String(c.id) === String(channelId); });
    if (!ch) { adminToast('کانال یافت نشد', 'error'); return; }
    var currentStatus = ch.campaign_status || ch.status || 'draft';
    form.style.display = '';
    form.innerHTML =
        '<div class="rc-card" style="border-color:rgba(245,166,35,0.3);">' +
            '<h4 class="rc-card-title">' + _adsIcon('pencil', 'rc-card-icon') + 'ویرایش کانال: @' + adminEscapeHtml(ch.channel_username || '') + '</h4>' +
            '<div class="rc-form-grid">' +
                '<div class="rc-field"><label>یوزرنیم کانال (بدون @)</label><input type="text" id="ads-ch-username" value="' + adminEscapeHtml(ch.channel_username || '') + '"></div>' +
                '<div class="rc-field"><label>عنوان کانال</label><input type="text" id="ads-ch-title" value="' + adminEscapeHtml(ch.channel_title || '') + '"></div>' +
                '<div class="rc-field"><label>لینک عضویت</label><input type="text" id="ads-ch-joinurl" value="' + adminEscapeHtml(ch.join_url || '') + '" dir="ltr"></div>' +
                '<div class="rc-field"><label>ترتیب نمایش</label><input type="number" id="ads-ch-order" value="' + adminFormatNumber(ch.display_order || 0) + '" min="0"></div>' +
                '<div class="rc-field"><label>وضعیت کمپین</label><select id="ads-ch-status">' +
                    '<option value="draft"' + (currentStatus === 'draft' ? ' selected' : '') + '>پیش‌نویس</option>' +
                    '<option value="active"' + (currentStatus === 'active' ? ' selected' : '') + '>فعال</option>' +
                    '<option value="paused"' + (currentStatus === 'paused' ? ' selected' : '') + '>متوقف</option>' +
                    '<option value="archived"' + (currentStatus === 'archived' ? ' selected' : '') + '>بایگانی</option>' +
                '</select></div>' +
                '<div class="rc-field"><label>نمایش</label><label class="rc-toggle-row"><input type="checkbox" id="ads-ch-active" ' + (ch.is_active ? 'checked' : '') + '><span>فعال برای نمایش</span></label></div>' +
            '</div>' +
            '<button class="adm-btn adm-btn-primary" onclick="saveAdChannel(\'' + adminEscapeJsId(String(channelId)) + '\')" style="margin-top:10px;">به‌روزرسانی</button> ' +
            '<button class="adm-btn" onclick="document.getElementById(\'ads-channel-form\').style.display=\'none\'" style="margin-top:10px;">انصراف</button>' +
        '</div>';
}
window.showAdChannelForm = showAdChannelForm;

async function saveAdChannel(channelId) {
    var joinUrl = (document.getElementById('ads-ch-joinurl') ? document.getElementById('ads-ch-joinurl').value : '').trim();
    if (joinUrl.indexOf('https://t.me/') !== 0) {
        adminToast('لینک عضویت باید با https://t.me/ شروع شود', 'error');
        return;
    }
    var payload = {
        channel_username: (document.getElementById('ads-ch-username') ? document.getElementById('ads-ch-username').value : '').trim().replace(/^@/, ''),
        channel_title:    (document.getElementById('ads-ch-title') ? document.getElementById('ads-ch-title').value : '').trim(),
        join_url:         joinUrl,
        display_order:    Number(document.getElementById('ads-ch-order') ? document.getElementById('ads-ch-order').value : 0) || 0,
        is_active:        document.getElementById('ads-ch-active') ? document.getElementById('ads-ch-active').checked : false,
        status:           document.getElementById('ads-ch-status') ? document.getElementById('ads-ch-status').value : 'draft',
    };
    // FIX (audit H3): Disable submit button during API call to prevent double-clicks
    _adsSetBtnLoading('#ads-channel-form .adm-btn-primary', true, 'در حال ذخیره...');
    try {
        var url = channelId
            ? '/api/admin/advertisements/channels/' + encodeURIComponent(channelId)
            : '/api/admin/advertisements/channels';
        var method = channelId ? 'PUT' : 'POST';
        var data = await adminApiFetch(url, { method: method, body: JSON.stringify(payload) });
        if (data && data.status === 'success') {
            adminToast(channelId ? 'کانال به‌روزرسانی شد' : 'کانال ایجاد شد', 'success');
            var form = document.getElementById('ads-channel-form');
            if (form) form.style.display = 'none';
            loadAdChannels();
        } else {
            adminToast((data && data.message) || 'خطا در ذخیره', 'error');
        }
    } catch (e) {
        console.error('saveAdChannel:', e);
        adminToast('خطا در ذخیره: ' + (e.message || ''), 'error');
    } finally {
        _adsSetBtnLoading('#ads-channel-form .adm-btn-primary', false);
    }
}
window.saveAdChannel = saveAdChannel;

async function deleteAdChannel(channelId) {
    if (!confirm('از حذف این کانال مطمئن هستید؟')) return;
    var delBtn = document.querySelector('button[onclick*="deleteAdChannel(\'' + channelId + '\')"]');
    var cardEl = delBtn ? delBtn.closest('.ads-item-card') : null;
    if (delBtn) { delBtn.disabled = true; }
    try {
        var data = await adminApiFetch('/api/admin/advertisements/channels/' + encodeURIComponent(channelId), { method: 'DELETE' });
        if (data && data.status === 'success') {
            adminToast('کانال حذف شد', 'success');
            if (cardEl && cardEl.parentNode) { cardEl.parentNode.removeChild(cardEl); }
            if (typeof _adsChannelCache !== 'undefined' && Array.isArray(_adsChannelCache)) {
                _adsChannelCache = _adsChannelCache.filter(function(c) { return String(c.id) !== String(channelId); });
            }
            loadAdChannels().catch(function() {});
        } else {
            adminToast((data && data.message) || 'خطا در حذف', 'error');
            if (delBtn) { delBtn.disabled = false; }
        }
    } catch (e) {
        console.error('deleteAdChannel:', e);
        adminToast('خطا در حذف', 'error');
        if (delBtn) { delBtn.disabled = false; }
    }
}
window.deleteAdChannel = deleteAdChannel;

async function setAdChannelStatus(channelId, status) {
    try {
        var data = await adminApiFetch('/api/admin/advertisements/channels/' + encodeURIComponent(channelId) + '/status', {
            method: 'POST',
            body: JSON.stringify({ status: status })
        });
        if (data && data.status === 'success') {
            adminToast('وضعیت تغییر کرد', 'success');
            loadAdChannels();
        } else {
            adminToast((data && data.message) || 'خطا در تغییر وضعیت', 'error');
        }
    } catch (e) {
        console.error('setAdChannelStatus:', e);
        adminToast('خطا در تغییر وضعیت', 'error');
    }
}
window.setAdChannelStatus = setAdChannelStatus;

// ════════════════════════════════════════════════════════════════════
// POPUPS — /api/admin/advertisements/popups
// ════════════════════════════════════════════════════════════════════

async function loadAdPopups() {
    var section = document.getElementById('ads-popups-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty"><span class="ads-spinner"></span> در حال بارگذاری...</div>';
    var token = _adminLoadToken;
    try {
        var data = await adminApiFetch('/api/admin/advertisements/popups');
        if (_isLoadTokenStale(token)) return;
        if (data && data.status === 'success' && Array.isArray(data.popups)) {
            _adsPopupCache = data.popups;
            var cards = data.popups.map(function (p) {
                var title = p.title ? adminEscapeHtml(p.title) : '—';
                var status = p.campaign_status || p.status || 'draft';
                var statusBadge = _adStatusBadge(status);
                var cooldown = p.cooldown_seconds ? _formatCooldownHuman(p.cooldown_seconds) : '—';
                var updated = p.updated_at ? adminFormatDate(p.updated_at) : '—';
                var statusPill = _adsStatusPill('setAdPopupStatus', p.id, status);
                var cooldownTag = '<span class="ads-meta-tag">کوئل‌داون: ' + adminEscapeHtml(cooldown) + '</span>';
                var updatedTag = '<span class="ads-meta-tag muted">آخرین تغییر: ' + adminEscapeHtml(updated) + '</span>';
                var idTag = '<span class="ads-meta-tag muted ltr">#' + adminEscapeHtml(p.id) + '</span>';
                var actions =
                    '<button class="adm-btn-sm" onclick="showAdPopupForm(\'' + adminEscapeJsId(String(p.id)) + '\')">' + _adsIcon('edit', 'adm-btn-icon') + 'ویرایش</button>' +
                    statusPill +
                    '<button class="adm-btn-sm adm-btn-danger" onclick="deleteAdPopup(\'' + adminEscapeJsId(String(p.id)) + '\')">' + _adsIcon('trash', 'adm-btn-icon') + 'حذف</button>';
                return _adsItemCard({
                    titleIcon: 'layout',
                    title: title,
                    subtitle: idTag,
                    statusBadge: statusBadge,
                    thumbnail: p.image_url || null,
                    metaParts: [cooldownTag, updatedTag],
                    actions: actions
                });
            }).join('');
            section.innerHTML =
                '<div class="ads-help-banner">' +
                    _adsIcon('info', 'ads-help-icon') +
                    '<span>قالب پاپ‌آپ ثابت است: تصویر ← عنوان ← متن ← دکمه. فقط محتوا قابل تغییر است. کوئل‌داون به معنای مدت زمانی است که پس از نمایش پاپ‌آپ به یک کاربر، تا آن مدت دوباره نمایش داده نمی‌شود.</span>' +
                '</div>' +
                '<div class="rc-card">' +
                    '<div class="ads-card-head-row">' +
                        '<h4 class="rc-card-title">' + _adsIcon('layout', 'rc-card-icon') + 'پاپ‌آپ مینی‌اپ</h4>' +
                        '<button class="adm-btn adm-btn-primary" onclick="showAdPopupForm(null)">' + _adsIcon('plus', 'adm-btn-icon') + 'افزودن پاپ‌آپ</button>' +
                    '</div>' +
                    '<div id="ads-popup-form" style="display:none;margin-bottom:14px;"></div>' +
                    '<div class="ads-item-list">' +
                        (cards || _adsEmptyState('layout', 'هنوز پاپ‌آپی ساخته نشده است', 'showAdPopupForm(null)', 'افزودن اولین پاپ‌آپ')) +
                    '</div>' +
                '</div>';
        } else {
            _adsPopupCache = [];
            section.innerHTML = _adsEmptyState('layout', 'داده‌ای دریافت نشد', 'loadAdPopups', 'تلاش مجدد');
        }
    } catch (e) {
        _adsPopupCache = [];
        section.innerHTML = _adsErrorState('بارگذاری پاپ‌آپ‌ها انجام نشد', 'loadAdPopups');
        console.error('loadAdPopups:', e);
    }
}
window.loadAdPopups = loadAdPopups;

function _adsPopupFormHtml(p) {
    // p === null → create mode; otherwise edit existing popup
    var isEdit = (p !== null && p !== undefined);
    var currentStatus = isEdit ? (p.campaign_status || p.status || 'draft') : 'active';
    var headTitle = isEdit ? ('ویرایش پاپ‌آپ: ' + adminEscapeHtml(p.title || '')) : 'پاپ‌آپ جدید';
    var saveArg = isEdit ? ('\'' + adminEscapeJsId(String(p.id)) + '\'') : 'null';
    var saveLabel = isEdit ? 'به‌روزرسانی' : 'ایجاد پاپ‌آپ';
    var titleVal   = isEdit ? adminEscapeHtml(p.title || '') : '';
    var bodyVal    = isEdit ? adminEscapeHtml(p.body_text || '') : '';
    var btnLabel   = isEdit ? adminEscapeHtml(p.button_label || '') : '';
    var btnUrl     = isEdit ? adminEscapeHtml(p.button_url || '') : '';
    var orderVal   = isEdit ? adminFormatNumber(p.display_order || 0) : '0';
    var cooldown   = isEdit ? (p.cooldown_seconds || 86400) : 86400;
    var cooldownOpts = '<option value="3600">۱ ساعت</option><option value="21600">۶ ساعت</option><option value="43200">۱۲ ساعت</option><option value="86400">۲۴ ساعت</option><option value="151200">۴۲ ساعت</option><option value="259200">۷۲ ساعت</option><option value="604800">هفتگی</option><option value="custom">سفارشی</option>';
    var cooldownMatch = false;
    var cooldownOptsHtml = cooldownOpts.replace(/value="(\d+)"/g, function(m, val) {
        if (Number(val) === Number(cooldown)) { cooldownMatch = true; return m + ' selected'; }
        return m;
    });
    if (!cooldownMatch && cooldown > 0) {
        cooldownOptsHtml = '<option value="' + cooldown + '" selected>' + _formatCooldownHuman(cooldown) + '</option>' + cooldownOptsHtml;
    }
    var activeChk  = isEdit ? (p.is_active ? 'checked' : '') : 'checked';
    var imgUrl     = isEdit ? (p.image_url || '') : '';
    // Image preview — show if URL exists
    var previewInit = imgUrl
        ? '<img id="ads-pp-preview" class="ads-img-preview" src="' + adminEscapeHtml(imgUrl) + '" alt="preview">'
        : '<img id="ads-pp-preview" class="ads-img-preview" style="display:none;" alt="preview">';
    return '<div class="rc-card" style="border-color:rgba(245,166,35,0.3);">' +
        '<h4 class="rc-card-title">' + headTitle + '</h4>' +
        '<div class="rc-form-grid">' +
            '<div class="rc-field" style="grid-column:1/-1;"><label>عنوان</label><input type="text" id="ads-pp-title" value="' + titleVal + '" placeholder="عنوان پاپ‌آپ"></div>' +
            '<div class="rc-field" style="grid-column:1/-1;"><label>متن پیام</label><textarea id="ads-pp-body" rows="4" placeholder="متن پیام پاپ‌آپ...">' + bodyVal + '</textarea></div>' +
            '<div class="rc-field"><label>متن دکمه</label><input type="text" id="ads-pp-btnlabel" value="' + btnLabel + '" placeholder="مشاهده"></div>' +
            '<div class="rc-field"><label>لینک دکمه</label><input type="text" id="ads-pp-btnurl" value="' + btnUrl + '" placeholder="https://..." dir="ltr"></div>' +
            '<div class="rc-field"><label>ترتیب نمایش</label><input type="number" id="ads-pp-order" value="' + orderVal + '" min="0"></div>' +
            '<div class="rc-field"><label>کوپل‌داون</label><select id="ads-pp-cooldown" onchange="document.getElementById(\'ads-pp-cooldown-custom\').style.display = this.value === \'custom\' ? \'\' : \'none\'">' + cooldownOptsHtml + '</select><input type="number" id="ads-pp-cooldown-custom" style="display:none;" placeholder="ثانیه" min="60"></div>' +
            '<div class="rc-field"><label>وضعیت کمپین</label><select id="ads-pp-status">' +
                '<option value="draft"' + (currentStatus === 'draft' ? ' selected' : '') + '>پیش‌نویس</option>' +
                '<option value="active"' + (currentStatus === 'active' ? ' selected' : '') + '>فعال</option>' +
                '<option value="paused"' + (currentStatus === 'paused' ? ' selected' : '') + '>متوقف</option>' +
                '<option value="archived"' + (currentStatus === 'archived' ? ' selected' : '') + '>بایگانی</option>' +
            '</select></div>' +
            '<div class="rc-field"><label>نمایش</label><label class="rc-toggle-row"><input type="checkbox" id="ads-pp-active" ' + activeChk + '><span>فعال برای نمایش</span></label></div>' +
            '<div class="rc-field" style="grid-column:1/-1;"><label>تصویر</label>' +
                '<input type="text" id="ads-pp-imgurl" value="' + adminEscapeHtml(imgUrl) + '" placeholder="https://..." dir="ltr" style="margin-bottom:8px;">' +
                '<label class="ads-img-upload-btn"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" ' +
                    'onchange="uploadAdImage(this.files[0], \'ads-pp-imgurl\', \'ads-pp-preview\')" style="display:none;"><span>' + _adsIcon('upload', 'adm-btn-icon') + 'انتخاب تصویر</span></label> ' +
                previewInit +
                '<div class="ads-img-hint">می‌توانید یک URL تصویر https وارد کنید یا تصویر را آپلود کنید (حداکثر ۵۰۰KB).</div>' +
            '</div>' +
        '</div>' +
        '<button class="adm-btn adm-btn-primary" onclick="saveAdPopup(' + saveArg + ')" style="margin-top:10px;">' + saveLabel + '</button> ' +
        '<button class="adm-btn" onclick="document.getElementById(\'ads-popup-form\').style.display=\'none\'" style="margin-top:10px;">انصراف</button>' +
    '</div>';
}

function showAdPopupForm(popupId) {
    var form = document.getElementById('ads-popup-form');
    if (!form) return;
    if (popupId === null || popupId === undefined) {
        form.style.display = form.style.display === 'none' ? '' : 'none';
        if (form.style.display === 'none') return;
        form.innerHTML = _adsPopupFormHtml(null);
        return;
    }
    var pp = _adsPopupCache.find(function (c) { return String(c.id) === String(popupId); });
    if (!pp) { adminToast('پاپ‌آپ یافت نشد', 'error'); return; }
    form.style.display = '';
    form.innerHTML = _adsPopupFormHtml(pp);
}
window.showAdPopupForm = showAdPopupForm;

async function saveAdPopup(popupId) {
    var payload = {
        title:            (document.getElementById('ads-pp-title') ? document.getElementById('ads-pp-title').value : '').trim(),
        body_text:        (document.getElementById('ads-pp-body') ? document.getElementById('ads-pp-body').value : '').trim(),
        button_label:     (document.getElementById('ads-pp-btnlabel') ? document.getElementById('ads-pp-btnlabel').value : '').trim(),
        button_url:       (document.getElementById('ads-pp-btnurl') ? document.getElementById('ads-pp-btnurl').value : '').trim(),
        image_url:        (document.getElementById('ads-pp-imgurl') ? document.getElementById('ads-pp-imgurl').value : '').trim(),
        display_order:    Number(document.getElementById('ads-pp-order') ? document.getElementById('ads-pp-order').value : 0) || 0,
        cooldown_seconds: (() => {
            const sel = document.getElementById('ads-pp-cooldown')?.value || '86400';
            if (sel === 'custom') return Number(document.getElementById('ads-pp-cooldown-custom')?.value || 86400);
            return Number(sel);
        })(),
        is_active:        document.getElementById('ads-pp-active') ? document.getElementById('ads-pp-active').checked : false,
        status:           document.getElementById('ads-pp-status') ? document.getElementById('ads-pp-status').value : 'draft',
    };
    if (!payload.title) { adminToast('عنوان پاپ‌آپ الزامی است', 'error'); return; }
    _adsSetBtnLoading('#ads-popup-form .adm-btn-primary', true, 'در حال ذخیره...');
    try {
        var url = popupId
            ? '/api/admin/advertisements/popups/' + encodeURIComponent(popupId)
            : '/api/admin/advertisements/popups';
        var method = popupId ? 'PUT' : 'POST';
        var data = await adminApiFetch(url, { method: method, body: JSON.stringify(payload) });
        if (data && data.status === 'success') {
            adminToast(popupId ? 'پاپ‌آپ به‌روزرسانی شد' : 'پاپ‌آپ ایجاد شد', 'success');
            var form = document.getElementById('ads-popup-form');
            if (form) form.style.display = 'none';
            loadAdPopups();
        } else {
            adminToast((data && data.message) || 'خطا در ذخیره', 'error');
        }
    } catch (e) {
        console.error('saveAdPopup:', e);
        adminToast('خطا در ذخیره: ' + (e.message || ''), 'error');
    } finally {
        _adsSetBtnLoading('#ads-popup-form .adm-btn-primary', false);
    }
}
window.saveAdPopup = saveAdPopup;

async function deleteAdPopup(popupId) {
    if (!confirm('از حذف این پاپ‌آپ مطمئن هستید؟')) return;
    // Find the card element to remove optimistically after API success
    var delBtn = document.querySelector('button[onclick*="deleteAdPopup(\'' + popupId + '\')"]');
    var cardEl = delBtn ? delBtn.closest('.ads-item-card') : null;
    if (delBtn) { delBtn.disabled = true; }
    try {
        var data = await adminApiFetch('/api/admin/advertisements/popups/' + encodeURIComponent(popupId), { method: 'DELETE' });
        if (data && data.status === 'success') {
            adminToast('پاپ‌آپ حذف شد', 'success');
            // Optimistic removal: remove the card from DOM immediately
            if (cardEl && cardEl.parentNode) { cardEl.parentNode.removeChild(cardEl); }
            // Also remove from in-memory cache
            if (typeof _adsPopupCache !== 'undefined' && Array.isArray(_adsPopupCache)) {
                _adsPopupCache = _adsPopupCache.filter(function(p) { return String(p.id) !== String(popupId); });
            }
            // Background refresh for synchronization (non-blocking)
            loadAdPopups().catch(function() {});
        } else {
            adminToast((data && data.message) || 'خطا در حذف', 'error');
            if (delBtn) { delBtn.disabled = false; }
        }
    } catch (e) {
        console.error('deleteAdPopup:', e);
        adminToast('خطا در حذف', 'error');
        if (delBtn) { delBtn.disabled = false; }
    }
}
window.deleteAdPopup = deleteAdPopup;

async function setAdPopupStatus(popupId, status) {
    try {
        var data = await adminApiFetch('/api/admin/advertisements/popups/' + encodeURIComponent(popupId) + '/status', {
            method: 'POST',
            body: JSON.stringify({ status: status })
        });
        if (data && data.status === 'success') {
            adminToast('وضعیت تغییر کرد', 'success');
            loadAdPopups();
        } else {
            adminToast((data && data.message) || 'خطا در تغییر وضعیت', 'error');
        }
    } catch (e) {
        console.error('setAdPopupStatus:', e);
        adminToast('خطا در تغییر وضعیت', 'error');
    }
}
window.setAdPopupStatus = setAdPopupStatus;

// ════════════════════════════════════════════════════════════════════
// MESSAGES — /api/admin/advertisements/messages
// ════════════════════════════════════════════════════════════════════

function _adsDestinationBadge(dest) {
    var meta = _adsDestinationMeta(dest);
    var iconHtml = '';
    if (meta.iconKey === 'both') {
        iconHtml = _adsIcon('smartphone', 'ads-badge-icon') + _adsIcon('send', 'ads-badge-icon');
    } else if (meta.iconKey) {
        iconHtml = _adsIcon(meta.iconKey, 'ads-badge-icon');
    }
    return '<span class="admin-badge admin-badge-' + meta.color + '">' + iconHtml + adminEscapeHtml(meta.label) + '</span>';
}

function _adsAudienceBadge(aud) {
    var meta = _adsAudienceMeta(aud);
    return '<span class="admin-badge admin-badge-' + meta.color + '">' + adminEscapeHtml(meta.label) + '</span>';
}

async function loadAdMessages() {
    var section = document.getElementById('ads-messages-section');
    if (!section) return;
    section.innerHTML = '<div class="admin-empty"><span class="ads-spinner"></span> در حال بارگذاری...</div>';
    var token = _adminLoadToken;
    try {
        var data = await adminApiFetch('/api/admin/advertisements/messages');
        if (_isLoadTokenStale(token)) return;
        if (data && data.status === 'success' && Array.isArray(data.messages)) {
            _adsMessageCache = data.messages;
            var cards = data.messages.map(function (m) {
                var title = m.title ? adminEscapeHtml(m.title) : '—';
                var status = m.campaign_status || m.status || 'draft';
                var destBadge = _adsDestinationBadge(m.destinations);
                var audBadge = _adsAudienceBadge(m.target_audience);
                var statusBadge = _adStatusBadge(status);
                var createdAt = m.created_at ? adminFormatDate(m.created_at) : '—';
                var statusPill = _adsStatusPill('setAdMessageStatus', m.id, status);
                var sendBtn = (status === 'active')
                    ? '<button class="adm-btn-sm adm-btn-primary" onclick="sendAdMessage(\'' + adminEscapeJsId(String(m.id)) + '\')">' + _adsIcon('send', 'adm-btn-icon') + 'ارسال</button>'
                    : '';
                var destTag = '<span class="ads-meta-tag">' + destBadge + '</span>';
                var audTag = '<span class="ads-meta-tag">' + audBadge + '</span>';
                var dateTag = '<span class="ads-meta-tag muted">' + adminEscapeHtml(createdAt) + '</span>';
                var idTag = '<span class="ads-meta-tag muted ltr">#' + adminEscapeHtml(m.id) + '</span>';
                var actions =
                    sendBtn +
                    '<button class="adm-btn-sm" onclick="showAdMessageForm(\'' + adminEscapeJsId(String(m.id)) + '\')">' + _adsIcon('edit', 'adm-btn-icon') + 'ویرایش</button>' +
                    statusPill +
                    '<button class="adm-btn-sm adm-btn-danger" onclick="deleteAdMessage(\'' + adminEscapeJsId(String(m.id)) + '\')">' + _adsIcon('trash', 'adm-btn-icon') + 'حذف</button>';
                return _adsItemCard({
                    titleIcon: 'mail',
                    title: title,
                    subtitle: idTag,
                    statusBadge: statusBadge,
                    thumbnail: m.image_url || null,
                    metaParts: [destTag, audTag, dateTag],
                    actions: actions
                });
            }).join('');
            section.innerHTML =
                '<div class="ads-help-banner">' +
                    _adsIcon('info', 'ads-help-icon') +
                    '<span>فقط کمپین‌های فعال ارسال می‌شوند. Draft/Paused/Archived ارسال نمی‌شوند. دکمه «ارسال» پیام را به مخاطبان هدف (بر اساس کانال و مخاطب انتخابی) تحویل می‌دهد. کاربران رایگان فقط در صورت انتخاب «همه» یا «رایگان» پیام را دریافت می‌کنند.</span>' +
                '</div>' +
                '<div class="rc-card">' +
                    '<div class="ads-card-head-row">' +
                        '<h4 class="rc-card-title">' + _adsIcon('mail', 'rc-card-icon') + 'پیام‌های تبلیغاتی</h4>' +
                        '<button class="adm-btn adm-btn-primary" onclick="showAdMessageForm(null)">' + _adsIcon('plus', 'adm-btn-icon') + 'افزودن پیام</button>' +
                    '</div>' +
                    '<div id="ads-message-form" style="display:none;margin-bottom:14px;"></div>' +
                    '<div class="ads-item-list">' +
                        (cards || _adsEmptyState('mail', 'هنوز پیامی ساخته نشده است', 'showAdMessageForm(null)', 'افزودن اولین پیام')) +
                    '</div>' +
                '</div>';
        } else {
            _adsMessageCache = [];
            section.innerHTML = _adsEmptyState('mail', 'داده‌ای دریافت نشد', 'loadAdMessages', 'تلاش مجدد');
        }
    } catch (e) {
        _adsMessageCache = [];
        section.innerHTML = _adsErrorState('بارگذاری پیام‌ها انجام نشد', 'loadAdMessages');
        console.error('loadAdMessages:', e);
    }
}
window.loadAdMessages = loadAdMessages;

function _adsMessageFormHtml(m) {
    var isEdit = (m !== null && m !== undefined);
    var currentStatus = isEdit ? (m.campaign_status || m.status || 'draft') : 'active';
    var currentDest = isEdit ? (m.destinations || 'both') : 'both';
    var currentAud = isEdit ? (m.target_audience || 'all') : 'all';
    var headTitle = isEdit ? ('ویرایش پیام: ' + adminEscapeHtml(m.title || '')) : 'پیام جدید';
    var saveArg = isEdit ? ('\'' + adminEscapeJsId(String(m.id)) + '\'') : 'null';
    var saveLabel = isEdit ? 'به‌روزرسانی' : 'ایجاد پیام';
    var titleVal   = isEdit ? adminEscapeHtml(m.title || '') : '';
    var bodyVal    = isEdit ? adminEscapeHtml(m.body_text || '') : '';
    var btnLabel   = isEdit ? adminEscapeHtml(m.button_label || '') : '';
    var btnUrl     = isEdit ? adminEscapeHtml(m.button_url || '') : '';
    var activeChk  = isEdit ? (m.is_active ? 'checked' : '') : 'checked';
    var imgUrl     = isEdit ? (m.image_url || '') : '';
    var previewInit = imgUrl
        ? '<img id="ads-msg-preview" class="ads-img-preview" src="' + adminEscapeHtml(imgUrl) + '" alt="preview">'
        : '<img id="ads-msg-preview" class="ads-img-preview" style="display:none;" alt="preview">';
    function radioChecked(val, current) { return val === current ? 'checked' : ''; }
    return '<div class="rc-card" style="border-color:rgba(245,166,35,0.3);">' +
        '<h4 class="rc-card-title">' + headTitle + '</h4>' +
        '<div class="rc-form-grid">' +
            '<div class="rc-field" style="grid-column:1/-1;"><label>عنوان</label><input type="text" id="ads-msg-title" value="' + titleVal + '" placeholder="عنوان پیام"></div>' +
            '<div class="rc-field" style="grid-column:1/-1;"><label>متن پیام</label><textarea id="ads-msg-body" rows="6" placeholder="متن پیام...">' + bodyVal + '</textarea></div>' +
            '<div class="rc-field"><label>متن دکمه</label><input type="text" id="ads-msg-btnlabel" value="' + btnLabel + '" placeholder="مشاهده"></div>' +
            '<div class="rc-field"><label>لینک دکمه</label><input type="text" id="ads-msg-btnurl" value="' + btnUrl + '" placeholder="https://..." dir="ltr"></div>' +
            '<div class="rc-field"><label>مقصد ارسال</label>' +
                '<label class="rc-toggle-row"><input type="radio" name="ads-msg-dest" value="mini_app" ' + radioChecked('mini_app', currentDest) + '><span>' + _adsIcon('smartphone', 'rc-radio-icon') + 'مینی‌اپ</span></label>' +
                '<label class="rc-toggle-row"><input type="radio" name="ads-msg-dest" value="telegram" ' + radioChecked('telegram', currentDest) + '><span>' + _adsIcon('send', 'rc-radio-icon') + 'تلگرام</span></label>' +
                '<label class="rc-toggle-row"><input type="radio" name="ads-msg-dest" value="both" ' + radioChecked('both', currentDest) + '><span>' + _adsIcon('smartphone', 'rc-radio-icon') + _adsIcon('send', 'rc-radio-icon') + 'هر دو</span></label>' +
            '</div>' +
            '<div class="rc-field"><label>مخاطب هدف</label>' +
                '<label class="rc-toggle-row"><input type="radio" name="ads-msg-aud" value="free" ' + radioChecked('free', currentAud) + '><span>کاربران رایگان</span></label>' +
                '<label class="rc-toggle-row"><input type="radio" name="ads-msg-aud" value="premium" ' + radioChecked('premium', currentAud) + '><span>کاربران ویژه</span></label>' +
                '<label class="rc-toggle-row"><input type="radio" name="ads-msg-aud" value="all" ' + radioChecked('all', currentAud) + '><span>همه کاربران</span></label>' +
            '</div>' +
            '<div class="rc-field"><label>وضعیت کمپین</label><select id="ads-msg-status">' +
                '<option value="draft"' + (currentStatus === 'draft' ? ' selected' : '') + '>پیش‌نویس</option>' +
                '<option value="active"' + (currentStatus === 'active' ? ' selected' : '') + '>فعال</option>' +
                '<option value="paused"' + (currentStatus === 'paused' ? ' selected' : '') + '>متوقف</option>' +
                '<option value="archived"' + (currentStatus === 'archived' ? ' selected' : '') + '>بایگانی</option>' +
            '</select></div>' +
            '<div class="rc-field"><label>نمایش</label><label class="rc-toggle-row"><input type="checkbox" id="ads-msg-active" ' + activeChk + '><span>فعال</span></label></div>' +
            '<div class="rc-field" style="grid-column:1/-1;"><label>تصویر (اختیاری)</label>' +
                '<input type="text" id="ads-msg-imgurl" value="' + adminEscapeHtml(imgUrl) + '" placeholder="https://..." dir="ltr" style="margin-bottom:8px;">' +
                '<label class="ads-img-upload-btn"><input type="file" accept="image/jpeg,image/png,image/webp,image/gif,image/avif" ' +
                    'onchange="uploadAdImage(this.files[0], \'ads-msg-imgurl\', \'ads-msg-preview\')" style="display:none;"><span>' + _adsIcon('upload', 'adm-btn-icon') + 'انتخاب تصویر</span></label> ' +
                previewInit +
                '<div class="ads-img-hint">می‌توانید یک URL تصویر https وارد کنید یا تصویر را آپلود کنید (حداکثر ۵۰۰KB).</div>' +
            '</div>' +
        '</div>' +
        '<button class="adm-btn adm-btn-primary" onclick="saveAdMessage(' + saveArg + ')" style="margin-top:10px;">' + saveLabel + '</button> ' +
        '<button class="adm-btn" onclick="document.getElementById(\'ads-message-form\').style.display=\'none\'" style="margin-top:10px;">انصراف</button>' +
    '</div>';
}

function showAdMessageForm(messageId) {
    var form = document.getElementById('ads-message-form');
    if (!form) return;
    if (messageId === null || messageId === undefined) {
        form.style.display = form.style.display === 'none' ? '' : 'none';
        if (form.style.display === 'none') return;
        form.innerHTML = _adsMessageFormHtml(null);
        return;
    }
    var msg = _adsMessageCache.find(function (c) { return String(c.id) === String(messageId); });
    if (!msg) { adminToast('پیام یافت نشد', 'error'); return; }
    form.style.display = '';
    form.innerHTML = _adsMessageFormHtml(msg);
}
window.showAdMessageForm = showAdMessageForm;

async function saveAdMessage(messageId) {
    var destEl = document.querySelector('input[name="ads-msg-dest"]:checked');
    var audEl = document.querySelector('input[name="ads-msg-aud"]:checked');
    var payload = {
        title:          (document.getElementById('ads-msg-title') ? document.getElementById('ads-msg-title').value : '').trim(),
        body_text:      (document.getElementById('ads-msg-body') ? document.getElementById('ads-msg-body').value : '').trim(),
        button_label:   (document.getElementById('ads-msg-btnlabel') ? document.getElementById('ads-msg-btnlabel').value : '').trim(),
        button_url:     (document.getElementById('ads-msg-btnurl') ? document.getElementById('ads-msg-btnurl').value : '').trim(),
        image_url:      (document.getElementById('ads-msg-imgurl') ? document.getElementById('ads-msg-imgurl').value : '').trim(),
        destinations:   destEl ? destEl.value : 'both',
        target_audience: audEl ? audEl.value : 'all',
        is_active:      document.getElementById('ads-msg-active') ? document.getElementById('ads-msg-active').checked : false,
        status:         document.getElementById('ads-msg-status') ? document.getElementById('ads-msg-status').value : 'draft',
    };
    if (!payload.title) { adminToast('عنوان پیام الزامی است', 'error'); return; }
    if (!payload.body_text) { adminToast('متن پیام الزامی است', 'error'); return; }
    _adsSetBtnLoading('#ads-message-form .adm-btn-primary', true, 'در حال ذخیره...');
    try {
        var url = messageId
            ? '/api/admin/advertisements/messages/' + encodeURIComponent(messageId)
            : '/api/admin/advertisements/messages';
        var method = messageId ? 'PUT' : 'POST';
        var data = await adminApiFetch(url, { method: method, body: JSON.stringify(payload) });
        if (data && data.status === 'success') {
            adminToast(messageId ? 'پیام به‌روزرسانی شد' : 'پیام ایجاد شد', 'success');
            var form = document.getElementById('ads-message-form');
            if (form) form.style.display = 'none';
            loadAdMessages();
        } else {
            adminToast((data && data.message) || 'خطا در ذخیره', 'error');
        }
    } catch (e) {
        console.error('saveAdMessage:', e);
        adminToast('خطا در ذخیره: ' + (e.message || ''), 'error');
    } finally {
        _adsSetBtnLoading('#ads-message-form .adm-btn-primary', false);
    }
}
window.saveAdMessage = saveAdMessage;

async function deleteAdMessage(messageId) {
    if (!confirm('از حذف این پیام مطمئن هستید؟')) return;
    var delBtn = document.querySelector('button[onclick*="deleteAdMessage(\'' + messageId + '\')"]');
    var cardEl = delBtn ? delBtn.closest('.ads-item-card') : null;
    if (delBtn) { delBtn.disabled = true; }
    try {
        var data = await adminApiFetch('/api/admin/advertisements/messages/' + encodeURIComponent(messageId), { method: 'DELETE' });
        if (data && data.status === 'success') {
            adminToast('پیام حذف شد', 'success');
            if (cardEl && cardEl.parentNode) { cardEl.parentNode.removeChild(cardEl); }
            if (typeof _adsMessageCache !== 'undefined' && Array.isArray(_adsMessageCache)) {
                _adsMessageCache = _adsMessageCache.filter(function(m) { return String(m.id) !== String(messageId); });
            }
            loadAdMessages().catch(function() {});
        } else {
            adminToast((data && data.message) || 'خطا در حذف', 'error');
            if (delBtn) { delBtn.disabled = false; }
        }
    } catch (e) {
        console.error('deleteAdMessage:', e);
        adminToast('خطا در حذف', 'error');
        if (delBtn) { delBtn.disabled = false; }
    }
}
window.deleteAdMessage = deleteAdMessage;

async function setAdMessageStatus(messageId, status) {
    try {
        var data = await adminApiFetch('/api/admin/advertisements/messages/' + encodeURIComponent(messageId) + '/status', {
            method: 'POST',
            body: JSON.stringify({ status: status })
        });
        if (data && data.status === 'success') {
            adminToast('وضعیت تغییر کرد', 'success');
            loadAdMessages();
        } else {
            adminToast((data && data.message) || 'خطا در تغییر وضعیت', 'error');
        }
    } catch (e) {
        console.error('setAdMessageStatus:', e);
        adminToast('خطا در تغییر وضعیت', 'error');
    }
}
window.setAdMessageStatus = setAdMessageStatus;

async function sendAdMessage(messageId) {
    if (!confirm('ارسال این پیام به مخاطبان هدف؟ این عملیات ممکن است چند ثانیه طول بکشد.')) return;
    // PHASE 6: Disable the send button during API call to prevent double-clicks.
    // CAS protection (claimMessageForDelivery, 5-min cooldown) also exists backend-side.
    var sendBtn = document.querySelector('button[onclick*="sendAdMessage(\'' + adminEscapeJsId(String(messageId)) + '\')"]');
    if (sendBtn) {
        sendBtn.disabled = true;
        sendBtn.style.opacity = '0.65';
        sendBtn.style.pointerEvents = 'none';
        if (!sendBtn.dataset._origText) sendBtn.dataset._origText = sendBtn.innerHTML;
        sendBtn.innerHTML = _adsIcon('refresh', 'adm-btn-icon') + 'در حال ارسال...';
    }
    try {
        var data = await adminApiFetch('/api/admin/advertisements/messages/' + encodeURIComponent(messageId) + '/send', {
            method: 'POST',
            body: JSON.stringify({})
        });
        if (data && data.status === 'success') {
            var delivered = adminFormatNumber(data.delivered || 0);
            var skipped = adminFormatNumber(data.skipped || 0);
            if (Number(delivered) === 0) {
                adminToast('هیچ کاربری پیام را دریافت نکرد. تحویل: 0 / رد شده: ' + skipped + '. ممکن است تنظیمات اعلان کاربران مانع ارسال باشد.', 'error');
            } else {
                adminToast('ارسال شد — تحویل: ' + delivered + ' / رد شده: ' + skipped, 'success');
            }
            loadAdMessages();
        } else {
            adminToast((data && data.message) || 'خطا در ارسال', 'error');
        }
    } catch (e) {
        console.error('sendAdMessage:', e);
        // Read retry_after from 409 error body if available
        var retryAfter = e.body && e.body.retry_after_seconds ? e.body.retry_after_seconds : null;
        var errorCode = e.body && e.body.code ? e.body.code : null;
        if (errorCode === 'CAMPAIGN_RECENTLY_SENT' && retryAfter) {
            adminToast('این کمپین اخیراً ارسال شده. ' + retryAfter + ' ثانیه صبر کنید.', 'error');
        } else if (e.status === 409 && retryAfter) {
            adminToast('عملیات تکراری. ' + retryAfter + ' ثانیه صبر کنید.', 'error');
        } else {
            adminToast('خطا در ارسال: ' + (e.message || ''), 'error');
        }
    } finally {
        // Re-enable the send button (only if campaign is still active — loadAdMessages may re-render)
        if (sendBtn && sendBtn.dataset._origText) {
            sendBtn.disabled = false;
            sendBtn.style.opacity = '';
            sendBtn.style.pointerEvents = '';
            sendBtn.innerHTML = sendBtn.dataset._origText;
        }
    }
}
window.sendAdMessage = sendAdMessage;

// ════════════════════════════════════════════════════════════════════
async function loadAdminMembership() {
    if (window.MembershipAdmin && typeof window.MembershipAdmin.load === 'function') {
        await window.MembershipAdmin.load();
    } else {
        const container = document.getElementById('admin-membership-list');
        if (container) container.innerHTML = '<div class="admin-empty">در حال بارگذاری ماژول عضویت...</div>';
    }
}

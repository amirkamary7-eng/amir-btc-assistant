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
    try {
        // Skip if no Telegram user is available yet (cold-open scenario)
        if (typeof getTelegramUser === 'function' && !getTelegramUser()?.id) {
            return;
        }

        const data = await apiFetch('/api/admin/is-admin');
        _adminData = data || { is_admin: false, role: '', permissions: [] };
        if (data && data.is_admin) {
            const btn = document.getElementById('admin-entry-btn');
            if (btn) {
                btn.style.display = 'inline-flex';
            }
        }
    } catch (e) {
        console.warn('[ADMIN] initAdminPanel error:', e.message || e);
    }
}

// ─── Panel Open / Close ─────────────────────────────────────

function openAdminPanel() {
    const panel = document.getElementById('admin-panel');
    if (!panel) return;
    panel.style.display = 'flex';
    _adminPanelOpen = true;
    document.body.style.overflow = 'hidden';
    // Load dashboard by default
    if (_currentAdminSection === 'dashboard') {
        loadAdminDashboard();
    } else {
        switchAdminSection(_currentAdminSection, null);
    }
}

function closeAdminPanel() {
    const panel = document.getElementById('admin-panel');
    if (!panel) return;
    panel.style.display = 'none';
    _adminPanelOpen = false;
    document.body.style.overflow = '';
}

function switchAdminSection(section, btn) {
    _currentAdminSection = section;

    // Update nav buttons
    const navItems = document.querySelectorAll('.admin-nav-item');
    navItems.forEach(function (item) { item.classList.remove('active'); });
    if (btn) {
        btn.classList.add('active');
    } else {
        const target = document.querySelector('.admin-nav-item[data-admin-section="' + section + '"]');
        if (target) target.classList.add('active');
    }

    // Update content sections
    const sections = document.querySelectorAll('.admin-section');
    sections.forEach(function (s) { s.classList.remove('active'); });
    const activeSection = document.getElementById('admin-section-' + section);
    if (activeSection) activeSection.classList.add('active');

    // Scroll sidebar item into view
    if (btn) btn.scrollIntoView({ behavior: 'smooth', inline: 'center', block: 'nearest' });

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
        case 'system-health': loadAdminSystemHealth(); break;
        case 'logs': loadAdminLogs(1); break;
    }

    // Scroll content to top
    const content = document.getElementById('admin-content');
    if (content) content.scrollTop = 0;
}

// ─── Dashboard ──────────────────────────────────────────────

async function loadAdminDashboard() {
    const grid = document.getElementById('admin-stats-grid');
    const activityList = document.getElementById('admin-activity-list');
    if (!grid) return;

    grid.innerHTML = '<div class="admin-empty">Loading...</div>';
    if (activityList) activityList.innerHTML = '';

    try {
        const data = await apiFetch('/api/admin/dashboard');
        if (!data) throw new Error('No data');

        // Stats
        let statsHtml = '';
        if (data.stats) {
            const s = data.stats;
            if (s.total_users != null) statsHtml += adminStatCard(adminFormatNumber(s.total_users), 'Total Users');
            if (s.active_today != null) statsHtml += adminStatCard(adminFormatNumber(s.active_today), 'Active Today');
            if (s.new_users_today != null) statsHtml += adminStatCard(adminFormatNumber(s.new_users_today), 'New Today');
            if (s.total_tickets != null) statsHtml += adminStatCard(adminFormatNumber(s.total_tickets), 'Total Tickets');
            if (s.open_tickets != null) statsHtml += adminStatCard(adminFormatNumber(s.open_tickets), 'Open Tickets');
            if (s.total_transactions != null) statsHtml += adminStatCard(adminFormatNumber(s.total_transactions), 'Transactions');
            if (s.total_rewards != null) statsHtml += adminStatCard(adminFormatNumber(s.total_rewards), 'Rewards');
            if (s.admins_count != null) statsHtml += adminStatCard(adminFormatNumber(s.admins_count), 'Admins');
        }
        grid.innerHTML = statsHtml || adminEmpty('No stats available');

        // Activity
        if (activityList && data.recent_activity) {
            if (data.recent_activity.length === 0) {
                activityList.innerHTML = adminEmpty('No recent activity');
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
        grid.innerHTML = adminEmpty('Failed to load dashboard');
        console.error('loadAdminDashboard:', e);
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

            html += '<div class="admin-list-item">' +
                '<div class="admin-list-item-header">' +
                '<span class="admin-list-item-title">' + adminEscapeHtml(t.subject || t.title || 'Ticket #' + (t.id || '')) + '</span>' +
                statusBadge +
                '</div>' +
                '<div class="admin-list-item-meta">' +
                'From: ' + adminEscapeHtml(t.user_name || t.username || 'User') +
                ' (ID: ' + adminEscapeHtml(String(t.telegram_id || t.user_id || '')) + ')' +
                '</div>' +
                '<div class="admin-list-item-meta" style="margin-top:4px;white-space:pre-wrap;overflow:hidden;max-height:60px;">' +
                adminEscapeHtml(t.message || t.last_message || '') +
                '</div>' +
                '<div class="admin-list-item-meta" style="margin-top:4px;">' +
                adminFormatDate(t.created_at || t.date) +
                (t.updated_at ? ' &bull; Updated: ' + adminFormatDate(t.updated_at) : '') +
                '</div>' +
                '</div>';
        });
        container.innerHTML = html;
        adminPagination('admin-tickets-pagination', _adminTicketsPage, totalPages, 'loadAdminTickets');
    } catch (e) {
        container.innerHTML = adminEmpty('Failed to load tickets');
        console.error('loadAdminTickets:', e);
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
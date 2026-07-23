// ============================================================
// Referral Center — Premium Frontend Logic
// IIFE pattern; matches WalletApp structure.
// Full FA/EN localization via RT(key). RTL aware.
// All API calls lazy (only when Referral Center opens).
// ============================================================

const ReferralApp = (() => {
  let referralData = null;
  let leaderboardData = null;
  let historyOffset = 0;
  let historyLoading = false;
  let wheelStatus = null;

  function esc(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  function formatNumber(n) {
    if (n == null) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    const now = new Date();
    const diff = now - d;
    if (diff < 60000) return RT('just_now');
    if (diff < 3600000) return Math.floor(diff / 60000) + ' ' + RT('m_ago');
    if (diff < 86400000) return Math.floor(diff / 3600000) + ' ' + RT('h_ago');
    if (diff < 604800000) return Math.floor(diff / 86400000) + ' ' + RT('d_ago');
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  // ═══════════════════════════════════════════════════════════
  // LOCALIZATION
  // ═══════════════════════════════════════════════════════════
  const FA = {
    referral_center: 'مرکز دعوت',
    brand_quote: 'دوستان خود را دعوت کنید، با هم کسب درآمد کنید',
    total_earned: 'کل پاداش‌ها',
    total_invites: 'کل دعوت‌ها',
    share_link: 'اشتراک‌گذاری لینک',
    copy_link: 'کپی لینک',
    referral_link: 'لینک دعوت',
    scan_qr: 'اسکن کنید تا عضو شوید',
    copy: 'کپی',
    share: 'اشتراک‌گذاری',
    copied: 'کپی شد!',
    link_copied: 'لینک دعوت کپی شد!',
    total_invite_count: 'کل دعوت‌ها',
    active_invites: 'دعوت‌های فعال',
    rewards_earned: 'پاداش‌های دریافتی',
    pending_rewards: 'پاداش‌های در انتظار',
    lucky_wheel: 'گردونه شانس',
    available_spins: 'اسپین‌های موجود',
    daily_spin: 'اسپین روزانه',
    open_wheel: 'باز کردن گردونه',
    claimed: 'دریافت شده',
    available: 'آماده',
    leaderboard: 'جدول رتبه‌بندی',
    view_full: 'مشاهده کامل',
    rank: 'رتبه',
    invites: 'دعوت',
    referral_history: 'تاریخچه دعوت‌ها',
    no_referrals: 'هنوز دعوتی ثبت نشده',
    start_inviting: 'شروع به دعوت از دوستان کنید!',
    load_more: 'باز کردن بیشتر',
    joined: 'عضو شده',
    not_joined: 'هنوز عضو نشده',
    rewarded: 'پاداش داده شده',
    pending: 'در انتظار',
    back: 'بازگشت',
    loading: 'در حال بارگذاری...',
    invite_friend: 'دعوت دوست',
    reward_per_invite: 'پاداش هر دعوت',
    ab_tokens: 'توکن AB',
    spin_available: 'آماده چرخش',
    spin_claimed: 'امروز چرخانده شد',
    no_spins: 'اسپینی موجود نیست',
    wheel_coming: 'گردونه شانس به‌زودی فعال می‌شود',
    just_now: 'لحظاتی پیش',
    m_ago: 'دقیقه پیش',
    h_ago: 'ساعت پیش',
    d_ago: 'روز پیش',
    missions: 'مأموریت‌ها',
    missions_coming: 'مأموریت‌های دعوت به‌زودی',
    achievements: 'دستاوردها',
    achievements_coming: 'سیستم دستاوردها به‌زودی',
    conversion_rate: 'نرخ تبدیل',
    invite_status: 'وضعیت دعوت',
    join_date: 'تاریخ عضویت',
  };

  const EN = {
    referral_center: 'Referral Center',
    brand_quote: 'Invite Friends, Earn Together',
    total_earned: 'Total Earned',
    total_invites: 'Total Invites',
    share_link: 'Share Link',
    copy_link: 'Copy Link',
    referral_link: 'Referral Link',
    scan_qr: 'Scan to join',
    copy: 'Copy',
    share: 'Share',
    copied: 'Copied!',
    link_copied: 'Referral link copied!',
    total_invite_count: 'Total Invites',
    active_invites: 'Active Invites',
    rewards_earned: 'Rewards Earned',
    pending_rewards: 'Pending Rewards',
    lucky_wheel: 'Lucky Wheel',
    available_spins: 'Available Spins',
    daily_spin: 'Daily Spin',
    open_wheel: 'Open Wheel',
    claimed: 'Claimed',
    available: 'Available',
    leaderboard: 'Leaderboard',
    view_full: 'View Full',
    rank: 'Rank',
    invites: 'invites',
    referral_history: 'Referral History',
    no_referrals: 'No referrals yet',
    start_inviting: 'Start inviting your friends!',
    load_more: 'Load More',
    joined: 'Joined',
    not_joined: 'Not joined yet',
    rewarded: 'Rewarded',
    pending: 'Pending',
    back: 'Back',
    loading: 'Loading...',
    invite_friend: 'Invite Friend',
    reward_per_invite: 'Reward per invite',
    ab_tokens: 'AB Tokens',
    spin_available: 'Ready to spin',
    spin_claimed: 'Spun today',
    no_spins: 'No spins available',
    wheel_coming: 'Lucky Wheel coming soon',
    just_now: 'Just now',
    m_ago: 'm ago',
    h_ago: 'h ago',
    d_ago: 'd ago',
    missions: 'Missions',
    missions_coming: 'Referral missions coming soon',
    achievements: 'Achievements',
    achievements_coming: 'Achievement system coming soon',
    conversion_rate: 'Conversion Rate',
    invite_status: 'Invite Status',
    join_date: 'Join Date',
  };

  function RT(key) {
    const lang = (typeof window !== 'undefined' && (window.currentLang || (window.UserContext && window.UserContext.lang))) || 'en';
    const dict = lang === 'fa' ? FA : EN;
    return dict[key] || key;
  }

  function applyDir(el) {
    const lang = (typeof window !== 'undefined' && window.currentLang) || 'en';
    el.setAttribute('dir', lang === 'fa' ? 'rtl' : 'ltr');
  }

  // ═══════════════════════════════════════════════════════════
  // SVG ICONS
  // ═══════════════════════════════════════════════════════════
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M9 11l3 3L22 4"/><path d="M21 12v7a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2V5a2 2 0 0 1 2-2h11"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 2L9.09 8.26 2 9.27l5.18 5.11L6 21.02 12 17.77l6 3.25-1.18-6.64L22 9.27l-7.09-1.01L12 2z"/></svg>',
    wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><line x1="14" y1="14" x2="14" y2="17"/><line x1="14" y1="20" x2="17" y2="20"/><line x1="20" y1="14" x2="20" y2="20"/><line x1="17" y1="14" x2="20" y2="14"/><line x1="14" y1="17" x2="17" y2="17"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════
  // API CALLS (lazy — only when Referral Center opens)
  // ═══════════════════════════════════════════════════════════
  async function fetchStats() {
    try {
      const data = await window.apiFetch('/api/referrals/stats');
      if (data.status === 'success') { referralData = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchStats error', e); }
    return null;
  }

  async function fetchLeaderboard() {
    try {
      const data = await window.apiFetch('/api/referrals/leaderboard?limit=3');
      if (data.status === 'success') { leaderboardData = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchLeaderboard error', e); }
    return null;
  }

  async function fetchHistory(offset = 0) {
    try {
      const data = await window.apiFetch(`/api/referrals/history?offset=${offset}&limit=20`);
      if (data.status === 'success') return data;
    } catch (e) { console.warn('ReferralApp: fetchHistory error', e); }
    return null;
  }

  async function fetchWheelStatus() {
    try {
      const data = await window.apiFetch('/api/wheel/status');
      if (data.status === 'success') { wheelStatus = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchWheelStatus error', e); }
    return null;
  }

  async function fetchBalance() {
    try {
      const data = await window.apiFetch('/api/wallet/balance');
      if (data.status === 'success') return data.balance || 0;
    } catch (e) { console.warn('ReferralApp: fetchBalance error', e); }
    return 0;
  }

  // ═══════════════════════════════════════════════════════════
  // BUILD HTML
  // ═══════════════════════════════════════════════════════════
  function getReferralLink() {
    const user = window.UserContext?.user || window.getTelegramUser?.();
    const botUsername = window.BOT_USERNAME || '';
    return user?.id ? `https://t.me/${botUsername}?start=ref_${user.id}` : '';
  }

  function buildSkeleton() {
    return `
      <div class="rc-header">
        <button class="rc-back-btn" onclick="ReferralApp.closeReferral()" aria-label="${esc(RT('back'))}">${ICONS.back}</button>
        <div class="rc-header-text"><h2>${esc(RT('referral_center'))}</h2></div>
      </div>
      <div class="rc-skeleton">
        <div class="rc-skel-card"><div class="rc-skel-line h-lg w-60"></div><div class="rc-skel-line w-40"></div></div>
        <div class="rc-skel-grid"><div class="rc-skel-card"></div><div class="rc-skel-card"></div><div class="rc-skel-card"></div><div class="rc-skel-card"></div></div>
        <div class="rc-skel-card"><div class="rc-skel-line w-50"></div></div>
        <div class="rc-skel-card"><div class="rc-skel-line w-70"></div></div>
      </div>
    `;
  }

  function buildPage(stats, balance, leaderboard, wheel, history, historyHasMore) {
    const link = getReferralLink();
    const totalInvites = stats?.total || 0;
    const activeInvites = stats?.active || 0;
    const rewarded = stats?.rewarded || 0;
    const pending = stats?.pending || 0;
    const rewardPerInvite = stats?.reward_per_invite || 3;
    const totalEarned = rewarded * rewardPerInvite;
    const conversionRate = totalInvites > 0 ? Math.round((activeInvites / totalInvites) * 100) : 0;

    return `
      <!-- Header -->
      <div class="rc-header">
        <button class="rc-back-btn" onclick="ReferralApp.closeReferral()" aria-label="${esc(RT('back'))}">${ICONS.back}</button>
        <div class="rc-header-text">
          <h2>${esc(RT('referral_center'))}</h2>
        </div>
      </div>

      <!-- Brand Quote -->
      <div class="rc-brand-quote">${esc(RT('brand_quote'))}</div>

      <!-- Hero Card -->
      <div class="rc-hero-card">
        <div class="rc-hero-glow"></div>
        <div class="rc-hero-top">
          <div class="rc-hero-icon">${ICONS.users}</div>
          <div class="rc-hero-info">
            <div class="rc-hero-earned-label">${esc(RT('total_earned'))}</div>
            <div class="rc-hero-earned-value">${formatNumber(totalEarned)} <span>AB</span></div>
          </div>
          <div class="rc-hero-ring">
            <svg viewBox="0 0 80 80" width="64" height="64">
              <circle cx="40" cy="40" r="34" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="6"/>
              <circle cx="40" cy="40" r="34" fill="none" stroke="#F5A623" stroke-width="6" stroke-linecap="round"
                stroke-dasharray="${2 * Math.PI * 34}" stroke-dashoffset="${2 * Math.PI * 34 * (1 - Math.min(conversionRate, 100) / 100)}"
                transform="rotate(-90 40 40)" style="transition:stroke-dashoffset 0.8s ease"/>
            </svg>
            <div class="rc-hero-ring-text">${conversionRate}%</div>
          </div>
        </div>
        <div class="rc-hero-invites">
          <span class="rc-hero-invites-value">${formatNumber(totalInvites)}</span>
          <span class="rc-hero-invites-label">${esc(RT('total_invites'))}</span>
        </div>
        <div class="rc-hero-actions">
          <button class="rc-hero-btn rc-hero-btn-primary" onclick="ReferralApp.shareLink()">
            ${ICONS.share}<span>${esc(RT('share_link'))}</span>
          </button>
          <button class="rc-hero-btn rc-hero-btn-secondary" onclick="ReferralApp.copyLink()">
            ${ICONS.copy}<span>${esc(RT('copy_link'))}</span>
          </button>
        </div>
      </div>

      <!-- Referral Link Card -->
      <div class="rc-section">
        <div class="rc-link-card">
          <div class="rc-link-qr">${ICONS.qr}</div>
          <div class="rc-link-info">
            <div class="rc-link-label">${esc(RT('referral_link'))}</div>
            <input type="text" id="rc-ref-link" class="rc-link-input" readonly value="${esc(link)}">
          </div>
          <button class="rc-link-copy" onclick="ReferralApp.copyLink()" aria-label="${esc(RT('copy'))}">${ICONS.copy}</button>
        </div>
      </div>

      <!-- Stats Grid -->
      <div class="rc-section">
        <div class="rc-stats-grid">
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-blue">${ICONS.users}</div>
            <div class="rc-stat-value">${formatNumber(totalInvites)}</div>
            <div class="rc-stat-label">${esc(RT('total_invite_count'))}</div>
          </div>
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-green">${ICONS.check}</div>
            <div class="rc-stat-value">${formatNumber(activeInvites)}</div>
            <div class="rc-stat-label">${esc(RT('active_invites'))}</div>
          </div>
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-gold">${ICONS.gift}</div>
            <div class="rc-stat-value">${formatNumber(rewarded)}</div>
            <div class="rc-stat-label">${esc(RT('rewards_earned'))}</div>
          </div>
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-orange">${ICONS.clock}</div>
            <div class="rc-stat-value">${formatNumber(pending)}</div>
            <div class="rc-stat-label">${esc(RT('pending_rewards'))}</div>
          </div>
        </div>
      </div>

      <!-- Lucky Wheel Entry -->
      <div class="rc-section">
        <div class="rc-wheel-card" onclick="ReferralApp.openWheel()" role="button" tabindex="0">
          <div class="rc-wheel-icon-spin">${ICONS.wheel}</div>
          <div class="rc-wheel-info">
            <div class="rc-wheel-title">${esc(RT('lucky_wheel'))}</div>
            <div class="rc-wheel-status">
              ${wheel?.daily_spin?.available ? `<span class="rc-wheel-dot rc-wheel-dot-active"></span>${esc(RT('spin_available'))}` :
                wheel?.daily_spin ? `<span class="rc-wheel-dot"></span>${esc(RT('spin_claimed'))}` :
                `<span class="rc-wheel-dot"></span>${esc(RT('wheel_coming'))}`}
            </div>
          </div>
          <div class="rc-wheel-spins">
            ${wheel?.total_available || 0}
            <small>${esc(RT('available_spins'))}</small>
          </div>
        </div>
      </div>

      <!-- Leaderboard Preview -->
      ${leaderboard?.leaderboard?.length ? `
      <div class="rc-section">
        <div class="rc-section-header">
          <h3>${ICONS.trophy} ${esc(RT('leaderboard'))}</h3>
        </div>
        <div class="rc-leaderboard-preview">
          ${leaderboard.leaderboard.slice(0, 3).map((u, i) => `
            <div class="rc-lb-item rc-lb-rank-${i + 1}">
              <div class="rc-lb-rank-badge">${i + 1}</div>
              <div class="rc-lb-avatar">${esc((u.first_name || u.username || '?').charAt(0).toUpperCase())}</div>
              <div class="rc-lb-info">
                <div class="rc-lb-name">${esc(u.first_name || u.username || 'User')}</div>
                <div class="rc-lb-invites">${formatNumber(u.total_invites)} ${esc(RT('invites'))}</div>
              </div>
              ${i === 0 ? '<div class="rc-lb-crown">' + ICONS.star + '</div>' : ''}
            </div>
          `).join('')}
        </div>
      </div>` : ''}

      <!-- Missions (coming soon) -->
      <div class="rc-section">
        <div class="rc-section-header"><h3>${ICONS.target} ${esc(RT('missions'))}</h3></div>
        <div class="rc-coming-soon">
          <div class="rc-coming-icon">${ICONS.target}</div>
          <p>${esc(RT('missions_coming'))}</p>
        </div>
      </div>

      <!-- Achievements (coming soon) -->
      <div class="rc-section">
        <div class="rc-section-header"><h3>${ICONS.rocket} ${esc(RT('achievements'))}</h3></div>
        <div class="rc-coming-soon">
          <div class="rc-coming-icon">${ICONS.rocket}</div>
          <p>${esc(RT('achievements_coming'))}</p>
        </div>
      </div>

      <!-- Referral History -->
      <div class="rc-section">
        <div class="rc-section-header"><h3>${ICONS.clock} ${esc(RT('referral_history'))}</h3></div>
        <div id="rc-history-list" class="rc-history-list">
          ${history && history.length > 0 ? history.map(buildHistoryItem).join('') : buildEmptyState()}
        </div>
        ${historyHasMore ? `
          <div id="rc-load-more" style="text-align:center;padding:12px;">
            <button class="rc-load-more-btn" onclick="ReferralApp.loadMoreHistory()">${esc(RT('load_more'))}</button>
          </div>` : ''}
      </div>
    `;
  }

  function buildHistoryItem(ref) {
    const avatar = (ref.invitee_first_name || ref.invitee_username || '?').charAt(0).toUpperCase();
    const name = ref.invitee_first_name || ref.invitee_username || 'User ' + (ref.invitee_id || '');
    const isJoined = ref.channel_verified;
    const isRewarded = ref.rewarded;
    const rewardPerInvite = referralData?.reward_per_invite || 3;

    return `
      <div class="rc-hist-item">
        <div class="rc-hist-avatar">${esc(avatar)}</div>
        <div class="rc-hist-info">
          <div class="rc-hist-name">${esc(name)}</div>
          <div class="rc-hist-date">${esc(formatTime(ref.created_at))}</div>
        </div>
        <div class="rc-hist-badges">
          ${isJoined ? `<span class="rc-hist-badge rc-hist-badge-joined">${esc(RT('joined'))}</span>` : `<span class="rc-hist-badge rc-hist-badge-pending">${esc(RT('not_joined'))}</span>`}
          ${isRewarded ? `<span class="rc-hist-badge rc-hist-badge-rewarded">+${rewardPerInvite} AB</span>` : `<span class="rc-hist-badge rc-hist-badge-pending">${esc(RT('pending'))}</span>`}
        </div>
      </div>
    `;
  }

  function buildEmptyState() {
    return `
      <div class="rc-empty-state">
        <div class="rc-empty-icon">${ICONS.users}</div>
        <h4>${esc(RT('no_referrals'))}</h4>
        <p>${esc(RT('start_inviting'))}</p>
      </div>
    `;
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  function renderPage(data) {
    const page = document.getElementById('referral-full-page');
    if (!page) return;
    page.innerHTML = buildPage(
      data.stats, data.balance, data.leaderboard, data.wheel, data.history, data.historyHasMore
    );
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC ACTIONS
  // ═══════════════════════════════════════════════════════════
  function openReferral() {
    const page = document.getElementById('referral-full-page');
    if (!page) return;
    applyDir(page);
    page.innerHTML = buildSkeleton();
    page.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Load all data in parallel
    (async () => {
      const [stats, balance, leaderboard, wheel, historyRes] = await Promise.all([
        fetchStats(), fetchBalance(), fetchLeaderboard(), fetchWheelStatus(), fetchHistory(0)
      ]);

      const data = {
        stats: stats || { total: 0, active: 0, rewarded: 0, pending: 0, reward_per_invite: 3 },
        balance: balance || 0,
        leaderboard: leaderboard || { leaderboard: [] },
        wheel: wheel || { daily_spin: { available: false }, total_available: 0 },
        history: historyRes?.referrals || [],
        historyHasMore: historyRes?.hasMore || false,
      };
      historyOffset = (historyRes?.referrals?.length) || 0;
      renderPage(data);
    })();
  }

  function closeReferral() {
    const page = document.getElementById('referral-full-page');
    if (!page) return;
    page.classList.remove('open');
    document.body.style.overflow = '';
  }

  function copyLink() {
    const input = document.getElementById('rc-ref-link');
    if (!input || !input.value) {
      const link = getReferralLink();
      if (!link) return;
      try { navigator.clipboard.writeText(link); } catch (e) { document.execCommand('copy'); }
    } else {
      input.select();
      try { navigator.clipboard.writeText(input.value); } catch (e) { document.execCommand('copy'); }
    }
    const tg = window.getTg?.();
    tg?.showPopup?.({ title: RT('copied'), message: RT('link_copied'), buttons: [{ type: 'ok' }] });
  }

  function shareLink() {
    const link = getReferralLink();
    if (!link) return;
    const text = encodeURIComponent(RT('brand_quote'));
    const tg = window.getTg?.();
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
  }

  function openWheel() {
    // For now, show a popup — wheel UI will be built in next phase
    const tg = window.getTg?.();
    tg?.showPopup?.({
      title: RT('lucky_wheel'),
      message: wheelStatus?.daily_spin?.available ? RT('spin_available') : RT('spin_claimed'),
      buttons: [{ type: 'ok' }]
    });
  }

  async function loadMoreHistory() {
    if (historyLoading) return;
    historyLoading = true;
    const btn = document.querySelector('#rc-load-more button');
    if (btn) btn.textContent = RT('loading');

    const result = await fetchHistory(historyOffset);
    if (result && result.referrals?.length > 0) {
      const list = document.getElementById('rc-history-list');
      const empty = list?.querySelector('.rc-empty-state');
      if (empty) empty.remove();
      const html = result.referrals.map(buildHistoryItem).join('');
      list?.insertAdjacentHTML('beforeend', html);
      historyOffset += result.referrals.length;

      if (!result.hasMore) {
        const loadMore = document.getElementById('rc-load-more');
        if (loadMore) loadMore.remove();
      }
    }

    if (btn) btn.textContent = RT('load_more');
    historyLoading = false;
  }

  function viewFullLeaderboard() {
    // Will be implemented with full leaderboard view
    const tg = window.getTg?.();
    tg?.showPopup?.({ title: RT('leaderboard'), message: RT('loading'), buttons: [{ type: 'ok' }] });
  }

  return {
    openReferral,
    closeReferral,
    copyLink,
    shareLink,
    openWheel,
    loadMoreHistory,
    viewFullLeaderboard,
  };
})();

window.ReferralApp = ReferralApp;

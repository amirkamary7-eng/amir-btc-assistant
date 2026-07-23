// ============================================================
// AB Token Wallet — Premium Frontend Logic (W-UI redesign)
// IIFE pattern preserved; public interface preserved.
// Full FA/EN localization via WT(key). Tier-aware accents.
// RTL aware via dir="rtl|ltr" on containers.
// ============================================================

const WalletApp = (() => {
  // =============================================
  // Localization (FA / EN)
  // =============================================
  const WT_FA = {
    wallet_title: 'کیف پول توکن AB',
    wallet_subtitle: 'دستیار امیر بیت‌کوین',
    ab_token_wallet: 'کیف پول توکن AB',
    current_balance: 'موجودی فعلی',
    available_balance: 'موجودی قابل استفاده',
    member_tier: 'سطح عضویت',
    progress_to: 'پیشرفت تا سطح',
    remaining: 'باقی‌مانده',
    ab_remaining: 'AB باقی‌مانده',
    earn_tokens: 'کسب توکن AB',
    daily_checkin: 'چک‌این روزانه',
    claim: 'دریافت',
    claimed: 'دریافت شد',
    claiming: 'در حال دریافت...',
    claim_success: 'جایزه روزانه با موفقیت دریافت شد!',
    claim_error: 'دریافت جایزه ناموفق بود',
    referral_program: 'برنامه دعوت دوستان',
    ref_link: 'لینک دعوت',
    invited_users: 'دعوت‌شده‌ها',
    active: 'فعال',
    total_earned: 'مجموع درآمد',
    pending_rewards: 'جایزه‌های در انتظار',
    rewards_marketplace: 'بازار جایزه‌ها',
    view_all: 'مشاهده همه',
    transaction_history: 'تاریخچه تراکنش‌ها',
    load_more: 'بارگذاری بیشتر',
    loading: 'در حال بارگذاری...',
    no_transactions: 'هنوز تراکنشی ثبت نشده',
    start_earning: 'اولین توکن‌های AB خود را کسب کنید',
    complete_tasks: 'وظایف را تکمیل کنید و دوستان را دعوت کنید تا جایزه بگیرید',
    premium_analysis: 'تحلیل ویژه',
    unlock_premium: 'دسترسی به تحلیل‌های اختصاصی بازار',
    vip_features: 'امکانات VIP',
    vip_status: 'دریافت وضعیت VIP با امکانات اختصاصی',
    exclusive_reports: 'گزارش‌های اختصاصی',
    future_utilities: 'کاربردهای آینده',
    available: 'در دسترس',
    locked: 'قفل شده',
    coming_soon: 'به‌زودی',
    copied: 'کپی شد',
    ref_copied: 'لینک دعوت کپی شد!',
    join_amir: 'به دستیار امیر بیت‌کوین بپیوندید و توکن AB کسب کنید!',
    open_wallet: 'باز کردن کیف پول',
    login_to_view: 'برای مشاهده کیف پول وارد شوید',
    build_future: 'آینده را بسازید',
    just_now: 'همین حالا',
    m_ago: 'دقیقه پیش',
    h_ago: 'ساعت پیش',
    d_ago: 'روز پیش',
    referral_reward: 'جایزه دعوت',
    daily_claim: 'چک‌این روزانه',
    mission_reward: 'جایزه ماموریت',
    purchase: 'خرید',
    airdrop: 'ایردراپ',
    admin_credit: 'افزایش اعتبار',
    reversed: 'برگشت خورده',
    completed: 'تکمیل شد',
    pending: 'در انتظار',
    failed: 'ناموفق',
    summary: 'خلاصه',
    total_earned_ab: 'مجموع دریافتی',
    total_spent_ab: 'مجموع خرج شده',
    tx_count: 'تعداد تراکنش',
    earn: 'کسب',
    referral: 'دعوت',
    rewards: 'جایزه‌ها',
    history: 'تاریخچه',
    brand_quote: 'AMIRBTC — جایی که هر توکن ارزش دارد',
    token_slogan: 'توکن AB — ارزشی بی‌نهایت، رشدی بی‌پایان.',
    tier_bronze: 'برنز',
    tier_silver: 'نقره',
    tier_gold: 'طلایی',
    tier_platinum: 'پلاتین',
    tier_diamond: 'الماس',
    max_tier: 'به بالاترین سطح رسیدید',
    read_analysis: 'مطالعه تحلیل',
    view_news: 'مشاهده اخبار',
    open_app_daily: 'باز کردن روزانه',
    invite_friend: 'دعوت دوست',
    view_premium_reports: 'مشاهده گزارش‌های ویژه بازار',
    stay_updated: 'با آخرین اخبار بازار به‌روز بمانید',
    active_daily: 'پاداش استفاده روزانه از برنامه',
    earn_per_referral: 'از هر دعوت موفق پاداش بگیرید',
    success: 'موفقیت',
    error: 'خطا',
    loading_wallet: 'در حال بارگذاری...',
    staking_discounts: 'استیکینگ، تخفیف معاملات و بیشتر',
  };

  const WT_EN = {
    wallet_title: 'AB Token Wallet',
    wallet_subtitle: 'Amir BTC Assistant',
    ab_token_wallet: 'AB Token Wallet',
    current_balance: 'Current Balance',
    available_balance: 'Available Balance',
    member_tier: 'Member Tier',
    progress_to: 'Progress To',
    remaining: 'remaining',
    ab_remaining: 'AB Remaining',
    earn_tokens: 'Earn AB Tokens',
    daily_checkin: 'Daily Check-in',
    claim: 'Claim',
    claimed: 'Claimed',
    claiming: 'Claiming...',
    claim_success: 'Daily reward claimed successfully!',
    claim_error: 'Failed to claim daily reward',
    referral_program: 'Referral Program',
    ref_link: 'Referral Link',
    invited_users: 'Invited Users',
    active: 'Active',
    total_earned: 'Total Earned',
    pending_rewards: 'Pending Rewards',
    rewards_marketplace: 'Rewards Marketplace',
    view_all: 'View All',
    transaction_history: 'Transaction History',
    load_more: 'Load More',
    loading: 'Loading...',
    no_transactions: 'No transactions yet',
    start_earning: 'Start earning your first AB Tokens',
    complete_tasks: 'Complete tasks and invite friends to unlock rewards',
    premium_analysis: 'Premium Analysis',
    unlock_premium: 'Unlock access to exclusive market analysis',
    vip_features: 'VIP Features',
    vip_status: 'Get VIP status with exclusive features',
    exclusive_reports: 'Exclusive Reports',
    future_utilities: 'Future Utilities',
    available: 'Available',
    locked: 'Locked',
    coming_soon: 'Coming Soon',
    copied: 'Copied',
    ref_copied: 'Referral link copied!',
    join_amir: 'Join Amir BTC Assistant and earn AB Tokens!',
    open_wallet: 'Open Wallet',
    login_to_view: 'Login to view wallet',
    build_future: 'Build the Future',
    just_now: 'Just now',
    m_ago: 'm ago',
    h_ago: 'h ago',
    d_ago: 'd ago',
    referral_reward: 'Referral Reward',
    daily_claim: 'Daily Check-in',
    mission_reward: 'Mission Reward',
    purchase: 'Purchase',
    airdrop: 'Airdrop',
    admin_credit: 'Admin Credit',
    reversed: 'Reversed',
    completed: 'Completed',
    pending: 'Pending',
    failed: 'Failed',
    summary: 'Summary',
    total_earned_ab: 'Total Earned AB',
    total_spent_ab: 'Total Spent AB',
    tx_count: 'Transactions',
    earn: 'Earn',
    referral: 'Referral',
    rewards: 'Rewards',
    history: 'History',
    brand_quote: 'AMIRBTC — Where Every Token Has Value',
    token_slogan: 'AB Token — Infinite Value, Endless Growth.',
    tier_bronze: 'Bronze',
    tier_silver: 'Silver',
    tier_gold: 'Gold',
    tier_platinum: 'Platinum',
    tier_diamond: 'Diamond',
    max_tier: 'You have reached the highest tier',
    read_analysis: 'Read Analysis',
    view_news: 'View News',
    open_app_daily: 'Open App Daily',
    invite_friend: 'Invite Friend',
    view_premium_reports: 'View premium market analysis reports',
    stay_updated: 'Stay updated with market news',
    active_daily: 'Active daily usage reward',
    earn_per_referral: 'Earn from each successful referral',
    success: 'Success',
    error: 'Error',
    loading_wallet: 'Loading...',
    staking_discounts: 'Staking, trading discounts, and more',
  };

  function detectLang() {
    try {
      if (typeof window !== 'undefined' && typeof window.currentLang === 'string' && window.currentLang) {
        return window.currentLang;
      }
    } catch (e) {}
    try {
      if (typeof currentLang === 'string' && currentLang) return currentLang;
    } catch (e) {}
    return 'en';
  }

  /**
   * Wallet-local translation function.
   * Returns FA string when currentLang === 'fa', EN otherwise.
   * Falls back to app's window.t(key) if key is not in our dictionary.
   */
  function WT(key) {
    const lang = detectLang();
    const dict = (lang === 'fa') ? WT_FA : WT_EN;
    if (dict[key] != null) return dict[key];
    if (WT_EN[key] != null) return WT_EN[key];
    try {
      if (typeof window !== 'undefined' && typeof window.t === 'function') {
        const v = window.t(key);
        if (v && v !== key) return v;
      }
    } catch (e) {}
    return key;
  }

  // =============================================
  // Tier System
  // =============================================
  const TIER_DATA = {
    bronze:   { hex: '#CD7F32', rgb: '205, 127, 50' },
    silver:   { hex: '#C0C0C0', rgb: '192, 192, 192' },
    gold:     { hex: '#FFD700', rgb: '255, 215, 0' },
    platinum: { hex: '#6CB4EE', rgb: '108, 180, 238' },
    diamond:  { hex: '#00CED1', rgb: '0, 206, 209' },
  };

  function getTierKey(name) {
    if (!name) return 'bronze';
    const n = String(name).toLowerCase().trim();
    if (n.includes('diamond')) return 'diamond';
    if (n.includes('platinum')) return 'platinum';
    if (n.includes('gold')) return 'gold';
    if (n.includes('silver')) return 'silver';
    if (n.includes('bronze')) return 'bronze';
    return 'bronze';
  }

  function getTierColor(name) {
    return TIER_DATA[getTierKey(name)].hex;
  }

  function getTierRgb(name) {
    return TIER_DATA[getTierKey(name)].rgb;
  }

  function displayTier(name) {
    return WT('tier_' + getTierKey(name));
  }

  function applyTierVars(el, name) {
    if (!el) return;
    el.style.setProperty('--tier-color', getTierColor(name));
    el.style.setProperty('--tier-rgb', getTierRgb(name));
  }

  // =============================================
  // State
  // =============================================
  let walletData = null;
  let claimStatus = null;
  let walletSummary = null;
  let historyLoading = false;
  let historyOffset = 0;
  let _tokenLogo = 'assets/token-logo.png';
  const DAILY_REWARD = 10;

  /** Escape HTML to prevent XSS when rendering dynamic content. */
  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  /**
   * Get the token logo URL from the DOM (already hash-replaced by build script),
   * falling back to the default path.
   */
  function getTokenLogo() {
    if (_tokenLogo !== 'assets/token-logo.png') return _tokenLogo;
    const img = document.querySelector('#wallet-preview-card .wallet-watermark img');
    if (img && img.src) {
      _tokenLogo = img.src;
    }
    return _tokenLogo;
  }

  // SVG icons (inline, no emojis)
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.09 8.26 2 9.27l5.18 5.11L6 21.02 12 17.77l6 3.25-1.18-6.64L22 9.27l-7.09-1.01L12 2z"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.912 5.813L20 10l-5.18 2.18L12 18l-2.82-5.82L4 10l6.088-1.187L12 3z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    plus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>',
    info: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>',
    airdrop: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2v2"/><path d="M5 5l1.5 1.5"/><path d="M19 5l-1.5 1.5"/><circle cx="12" cy="14" r="6"/><path d="M8 20l-2 2"/><path d="M16 20l2 2"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8V6z"/></svg>',
    trending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
  };

  function formatNumber(n) {
    if (n == null || isNaN(n)) return '0';
    return Number(n).toLocaleString('en-US');
  }

  function formatTime(isoStr) {
    if (!isoStr) return '';
    const d = new Date(isoStr);
    if (isNaN(d.getTime())) return '';
    const now = new Date();
    const diff = now - d;
    if (diff < 0) return WT('just_now');
    if (diff < 60000) return WT('just_now');
    if (diff < 3600000) return `${Math.floor(diff / 60000)} ${WT('m_ago')}`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${WT('h_ago')}`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} ${WT('d_ago')}`;
    try {
      return d.toLocaleDateString(detectLang() === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric' });
    } catch (e) {
      return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
    }
  }

  function getTxIcon(type) {
    const map = {
      daily_claim: 'claim',
      claim: 'claim',
      referral_reward: 'referral',
      mission_reward: 'mission',
      mission: 'mission',
      purchase: 'purchase',
      redeem: 'redeem',
      airdrop: 'airdrop',
      admin_credit: 'admin',
    };
    return map[type] || 'other';
  }

  function getTxIconSvg(type) {
    const iconType = getTxIcon(type);
    const svgMap = {
      claim: ICONS.gift,
      referral: ICONS.users,
      mission: ICONS.target,
      purchase: ICONS.chart,
      redeem: ICONS.rocket,
      airdrop: ICONS.airdrop,
      admin: ICONS.shield,
      other: ICONS.info,
    };
    return svgMap[iconType] || ICONS.info;
  }

  function getTxLabel(type) {
    const map = {
      daily_claim: WT('daily_claim'),
      claim: WT('daily_claim'),
      referral_reward: WT('referral_reward'),
      mission_reward: WT('mission_reward'),
      purchase: WT('purchase'),
      redeem: WT('purchase'),
      airdrop: WT('airdrop'),
      admin_credit: WT('admin_credit'),
    };
    return map[type] || type;
  }

  function getTxStatusLabel(status) {
    const map = {
      completed: WT('completed'),
      pending: WT('pending'),
      failed: WT('failed'),
      reversed: WT('reversed'),
    };
    return map[status] || status;
  }

  function applyDir(root) {
    const dir = detectLang() === 'fa' ? 'rtl' : 'ltr';
    if (root) root.setAttribute('dir', dir);
    const page = document.getElementById('wallet-full-page');
    if (page) page.setAttribute('dir', dir);
    const card = document.getElementById('wallet-preview-card');
    if (card) card.setAttribute('dir', dir);
  }

  // =============================================
  // Profile Card Rendering
  // =============================================
  function renderProfileCard(data) {
    const card = document.getElementById('wallet-preview-card');
    if (!card) return;
    applyDir(card);

    const tier = data.tier || { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };
    const balance = data.balance || 0;
    applyTierVars(card, tier.current);

    const progressPct = tier.progress != null ? Number(tier.progress).toFixed(0) : '0';
    const progressText = tier.next
      ? `${progressPct}% ${WT('progress_to')} ${displayTier(tier.next)}`
      : WT('max_tier');

    card.classList.remove('skeleton-loading');
    card.innerHTML = `
      <div class="wallet-watermark"><img src="${getTokenLogo()}" alt=""></div>
      <div class="wallet-preview-top">
        <div class="wallet-preview-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
        <div class="wallet-preview-info">
          <div class="wallet-preview-title">
            ${esc(WT('ab_token_wallet'))}
            <span class="tier-badge">${esc(displayTier(tier.current))}</span>
          </div>
          <div class="wallet-preview-subtitle">${esc(WT('wallet_subtitle'))}</div>
        </div>
      </div>
      <div class="wallet-preview-balance">
        <div class="balance-label">${esc(WT('current_balance'))}</div>
        <div class="balance-value">${formatNumber(balance)} <span class="balance-ticker">AB</span></div>
      </div>
      <div class="wallet-preview-progress">
        <div class="progress-info">
          <span>${esc(progressText)}</span>
          <span class="progress-pct">${progressPct}%</span>
        </div>
        <div class="wallet-progress-bar">
          <div class="wallet-progress-fill" style="width: 0%"></div>
        </div>
      </div>
      <button class="wallet-open-btn" onclick="event.stopPropagation(); WalletApp.openWallet()">
        ${esc(WT('open_wallet'))}
        ${ICONS.arrowRight}
      </button>
    `;

    // Animate progress bar
    requestAnimationFrame(() => {
      const fill = card.querySelector('.wallet-progress-fill');
      if (fill) fill.style.width = `${tier.progress || 0}%`;
    });
  }

  function renderProfileCardSkeleton() {
    const card = document.getElementById('wallet-preview-card');
    if (!card) return;
    applyDir(card);
    card.classList.add('skeleton-loading');
    card.innerHTML = `
      <div class="wallet-watermark"><img src="${getTokenLogo()}" alt=""></div>
      <div class="wallet-preview-top">
        <div class="wallet-preview-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
        <div class="wallet-preview-info">
          <div class="wallet-preview-title">${esc(WT('ab_token_wallet'))}</div>
          <div class="wallet-preview-subtitle">${esc(WT('wallet_subtitle'))}</div>
        </div>
      </div>
      <div class="wallet-preview-balance">
        <div class="balance-label">${esc(WT('current_balance'))}</div>
        <div class="balance-value skeleton-text" style="width:160px;height:34px;">&nbsp;</div>
      </div>
      <div class="wallet-preview-progress">
        <div class="progress-info">
          <span class="skeleton-text" style="width:55%;">&nbsp;</span>
          <span class="skeleton-text" style="width:34px;">&nbsp;</span>
        </div>
        <div class="wallet-progress-bar">
          <div class="wallet-progress-fill" style="width:0%"></div>
        </div>
      </div>
      <button class="wallet-open-btn" disabled>${esc(WT('open_wallet'))} ${ICONS.arrowRight}</button>
    `;
  }

  // =============================================
  // Full Wallet Page
  // =============================================
  function renderWalletPage(data) {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;
    applyDir(page);

    const tier = data.tier || { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };
    const balance = data.balance || 0;
    const history = data.history || [];
    applyTierVars(page, tier.current);

    page.innerHTML = buildWalletHTML(tier, balance, history);

    // Animate elements (tier progress bar + ring)
    requestAnimationFrame(() => {
      const heroFill = page.querySelector('.tier-bar-fill');
      if (heroFill) heroFill.style.width = `${tier.progress || 0}%`;
      const ring = page.querySelector('.tier-progress-ring-fill');
      if (ring) {
        const r = parseFloat(ring.getAttribute('r')) || 26;
        const c = 2 * Math.PI * r;
        ring.style.strokeDasharray = c;
        ring.style.strokeDashoffset = c * (1 - (tier.progress || 0) / 100);
      }
    });
  }

  function buildWalletHTML(tier, balance, history) {
    const tierColor = getTierColor(tier.current);

    return `
      <!-- Header -->
      <div class="wallet-page-header">
        <button class="wallet-back-btn" onclick="WalletApp.closeWallet()" aria-label="Back">${ICONS.back}</button>
        <div class="wallet-page-header-info">
          <div class="wallet-page-header-logo"><img src="${getTokenLogo()}" alt="AB"></div>
          <div class="wallet-page-header-text">
            <h2>${esc(WT('ab_token_wallet'))}</h2>
            <span><span class="tier-dot"></span> ${esc(displayTier(tier.current))}</span>
          </div>
        </div>
      </div>

      <!-- Brand Quote + Token Slogan -->
      <div class="wallet-brand-quote">${esc(WT('brand_quote'))}</div>
      <div class="wallet-token-slogan">${esc(WT('token_slogan'))}</div>

      <!-- Hero Balance Card -->
      <div class="wallet-hero-card">
        <div class="hero-watermark"><img src="${getTokenLogo()}" alt=""></div>
        <div class="hero-reflection"></div>
        <div class="wallet-hero-top">
          <div class="wallet-hero-token">
            <div class="wallet-hero-token-img"><img src="${getTokenLogo()}" alt="AB"></div>
            <div class="wallet-hero-token-meta">
              <div class="hero-token-name">AB Token</div>
              <div class="hero-tier-badge">${esc(displayTier(tier.current))}</div>
            </div>
          </div>
          ${tier.next ? `
          <div class="wallet-hero-ring" aria-hidden="true">
            <svg viewBox="0 0 60 60" width="56" height="56">
              <circle cx="30" cy="30" r="26" fill="none" stroke="rgba(255,255,255,0.06)" stroke-width="4"/>
              <circle class="tier-progress-ring-fill" cx="30" cy="30" r="26" fill="none" stroke="${tierColor}" stroke-width="4" stroke-linecap="round" transform="rotate(-90 30 30)" style="transition: stroke-dashoffset 1.2s cubic-bezier(0.16,1,0.3,1);"/>
            </svg>
            <span class="ring-pct">${Number(tier.progress || 0).toFixed(0)}%</span>
          </div>` : ''}
        </div>
        <div class="wallet-hero-balance-label">${esc(WT('available_balance'))}</div>
        <div class="wallet-hero-balance-value">${formatNumber(balance)} <span class="hero-ticker">AB</span></div>
        <div class="wallet-hero-divider"></div>
        <div class="wallet-hero-details">
          <div class="wallet-hero-detail-item">
            <div class="detail-label">${esc(WT('member_tier'))}</div>
            <div class="detail-value"><span class="mini-tier-badge">${esc(displayTier(tier.current))}</span></div>
          </div>
          <div class="wallet-hero-detail-item">
            <div class="detail-label">${esc(WT('available_balance'))}</div>
            <div class="detail-value">${formatNumber(balance)} <span class="detail-unit">AB</span></div>
          </div>
          ${tier.next ? `
          <div class="wallet-hero-tier-progress">
            <div class="tier-progress-header">
              <span>${esc(WT('progress_to'))} ${esc(displayTier(tier.next))}</span>
              <span class="tier-remaining">${formatNumber(tier.remaining)} ${esc(WT('ab_remaining'))}</span>
            </div>
            <div class="wallet-hero-tier-bar">
              <div class="tier-bar-fill" style="width: 0%"></div>
            </div>
          </div>` : ''}
        </div>
      </div>

      <!-- Smart Banner -->
      <div class="wallet-smart-banner">
        ${ICONS.sparkles}
        <p>${tier.next
          ? `${esc(WT('ab_remaining'))}: <strong>${formatNumber(tier.remaining)} AB</strong>`
          : esc(WT('max_tier'))}</p>
      </div>

      <!-- Summary Strip -->
      ${buildSummaryStrip()}

      <!-- Quick Actions -->
      <div class="wallet-quick-actions">
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-earn-section')">
          <div class="wallet-action-icon earn-icon">${ICONS.gift}</div>
          <span>${esc(WT('earn'))}</span>
        </button>
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-referral-section')">
          <div class="wallet-action-icon referral-icon">${ICONS.users}</div>
          <span>${esc(WT('referral'))}</span>
        </button>
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-marketplace-section')">
          <div class="wallet-action-icon rewards-icon">${ICONS.star}</div>
          <span>${esc(WT('rewards'))}</span>
        </button>
        <button class="wallet-action-btn" onclick="WalletApp.scrollToSection('wallet-history-section')">
          <div class="wallet-action-icon history-icon">${ICONS.clock}</div>
          <span>${esc(WT('history'))}</span>
        </button>
      </div>

      <!-- Earn Section -->
      <div class="wallet-section" id="wallet-earn-section">
        <div class="wallet-section-header">
          <h3>${esc(WT('earn_tokens'))}</h3>
        </div>
        <div class="wallet-earn-grid">
          <div class="wallet-earn-card daily-checkin" id="daily-checkin-card">
            <div class="checkin-icon">${ICONS.calendar}</div>
            <div class="checkin-info">
              <div class="checkin-title">${esc(WT('daily_checkin'))}</div>
              <div class="checkin-reward">+${DAILY_REWARD} AB</div>
            </div>
            <button class="checkin-btn" id="daily-claim-btn" onclick="WalletApp.claimDaily()">${esc(WT('claim'))}</button>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+5 AB</div>
            <div class="earn-title">${esc(WT('read_analysis'))}</div>
            <div class="earn-desc">${esc(WT('view_premium_reports'))}</div>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+3 AB</div>
            <div class="earn-title">${esc(WT('view_news'))}</div>
            <div class="earn-desc">${esc(WT('stay_updated'))}</div>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+10 AB</div>
            <div class="earn-title">${esc(WT('open_app_daily'))}</div>
            <div class="earn-desc">${esc(WT('active_daily'))}</div>
          </div>
          <div class="wallet-earn-card">
            <div class="earn-reward">+50 AB</div>
            <div class="earn-title">${esc(WT('invite_friend'))}</div>
            <div class="earn-desc">${esc(WT('earn_per_referral'))}</div>
          </div>
        </div>
      </div>

      <!-- Referral Section -->
      <div class="wallet-section" id="wallet-referral-section">
        <div class="wallet-section-header">
          <h3>${esc(WT('referral_program'))}</h3>
        </div>
        <div class="wallet-referral-box">
          <div class="wallet-ref-link-row">
            <input type="text" id="wallet-ref-link" readonly aria-label="${esc(WT('ref_link'))}">
            <button class="ref-copy-btn" onclick="WalletApp.copyRefLink()" aria-label="${esc(WT('copied'))}">${ICONS.copy}</button>
            <button class="ref-share-btn-sm" onclick="WalletApp.shareRefLink()" aria-label="Share">${ICONS.share}</button>
          </div>
          <div class="wallet-ref-stats-grid">
            <div class="wallet-ref-stat">
              <div class="stat-label">${esc(WT('invited_users'))}</div>
              <div class="stat-value" id="wallet-ref-invited">0</div>
            </div>
            <div class="wallet-ref-stat">
              <div class="stat-label">${esc(WT('active'))}</div>
              <div class="stat-value" id="wallet-ref-active">0</div>
            </div>
            <div class="wallet-ref-stat">
              <div class="stat-label">${esc(WT('total_earned'))}</div>
              <div class="stat-value" id="wallet-ref-earned">0</div>
            </div>
            <div class="wallet-ref-stat">
              <div class="stat-label">${esc(WT('pending_rewards'))}</div>
              <div class="stat-value" id="wallet-ref-pending">0</div>
            </div>
          </div>
        </div>
      </div>

      <!-- Rewards Marketplace -->
      <div class="wallet-section" id="wallet-marketplace-section">
        <div class="wallet-section-header">
          <h3>${esc(WT('rewards_marketplace'))}</h3>
          <button class="section-action">${esc(WT('view_all'))}</button>
        </div>
        <div class="wallet-marketplace-scroll">
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-analysis">${ICONS.chart}</div>
            <div class="reward-name">${esc(WT('premium_analysis'))}</div>
            <div class="reward-desc">${esc(WT('unlock_premium'))}</div>
            <div class="reward-footer">
              <span class="reward-cost">500 AB</span>
              <span class="reward-status status-available">${esc(WT('available'))}</span>
            </div>
          </div>
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-vip">${ICONS.shield}</div>
            <div class="reward-name">${esc(WT('vip_features'))}</div>
            <div class="reward-desc">${esc(WT('vip_status'))}</div>
            <div class="reward-footer">
              <span class="reward-cost">2,000 AB</span>
              <span class="reward-status status-locked">${esc(WT('locked'))}</span>
            </div>
          </div>
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-report">${ICONS.star}</div>
            <div class="reward-name">${esc(WT('exclusive_reports'))}</div>
            <div class="reward-desc">${esc(WT('unlock_premium'))}</div>
            <div class="reward-footer">
              <span class="reward-cost">1,000 AB</span>
              <span class="reward-status status-coming">${esc(WT('coming_soon'))}</span>
            </div>
          </div>
          <div class="wallet-marketplace-card">
            <div class="reward-icon icon-future">${ICONS.rocket}</div>
            <div class="reward-name">${esc(WT('future_utilities'))}</div>
            <div class="reward-desc">${esc(WT('staking_discounts'))}</div>
            <div class="reward-footer">
              <span class="reward-cost">TBA</span>
              <span class="reward-status status-coming">${esc(WT('coming_soon'))}</span>
            </div>
          </div>
        </div>
      </div>

      <!-- Transaction History -->
      <div class="wallet-section" id="wallet-history-section">
        <div class="wallet-section-header">
          <h3>${esc(WT('transaction_history'))}</h3>
        </div>
        <div id="wallet-tx-list" class="wallet-tx-list">
          ${history.length > 0
            ? history.map(tx => buildTxItemHTML(tx)).join('')
            : buildEmptyStateHTML()
          }
        </div>
        ${history.length > 0 && history.length >= 20 ? `
          <div id="wallet-load-more" class="wallet-load-more-wrap">
            <button class="wallet-load-more-btn" onclick="WalletApp.loadMoreHistory()">${esc(WT('load_more'))}</button>
          </div>
        ` : ''}
      </div>
    `;
  }

  function buildSummaryStrip() {
    if (!walletSummary || !walletSummary.stats) return '';
    const s = walletSummary.stats || {};
    return `
      <div class="wallet-summary-strip">
        <div class="summary-item">
          <div class="summary-label">${esc(WT('total_earned_ab'))}</div>
          <div class="summary-value positive">+${formatNumber(s.total_earned || 0)}</div>
        </div>
        <div class="summary-divider"></div>
        <div class="summary-item">
          <div class="summary-label">${esc(WT('total_spent_ab'))}</div>
          <div class="summary-value negative">−${formatNumber(s.total_spent || 0)}</div>
        </div>
        <div class="summary-divider"></div>
        <div class="summary-item">
          <div class="summary-label">${esc(WT('tx_count'))}</div>
          <div class="summary-value neutral">${formatNumber(s.transaction_count || 0)}</div>
        </div>
      </div>
    `;
  }

  function buildEmptyStateHTML() {
    return `
      <div class="wallet-empty-state">
        <div class="empty-orb">
          <div class="empty-orb-glow"></div>
          <img src="${getTokenLogo()}" alt="AB">
        </div>
        <h4>${esc(WT('no_transactions'))}</h4>
        <p class="empty-title">${esc(WT('start_earning'))}</p>
        <p class="empty-sub">${esc(WT('complete_tasks'))}</p>
        <button class="empty-cta" onclick="WalletApp.scrollToSection('wallet-earn-section')">${esc(WT('earn'))}</button>
      </div>
    `;
  }

  function buildTxItemHTML(tx) {
    const isPositive = Number(tx.amount) > 0;
    const status = tx.status ? `<span class="tx-status status-${esc(tx.status)}">${esc(getTxStatusLabel(tx.status))}</span>` : '';
    return `
      <div class="wallet-tx-item">
        <div class="wallet-tx-icon tx-${getTxIcon(tx.type)}">${getTxIconSvg(tx.type)}</div>
        <div class="wallet-tx-info">
          <div class="tx-type">${esc(getTxLabel(tx.type))}</div>
          <div class="tx-desc">${esc(tx.description || '')}</div>
          ${status ? `<div class="tx-status-row">${status}</div>` : ''}
        </div>
        <div class="wallet-tx-right">
          <div class="tx-amount ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : '−'}${formatNumber(Math.abs(tx.amount))} <span class="tx-unit">AB</span></div>
          <div class="tx-time">${esc(formatTime(tx.created_at))}</div>
        </div>
      </div>
    `;
  }

  function buildWalletSkeleton() {
    return `
      <div class="wallet-page-header">
        <button class="wallet-back-btn" onclick="WalletApp.closeWallet()" aria-label="Back">${ICONS.back}</button>
        <div class="wallet-page-header-info">
          <div class="wallet-page-header-logo"><img src="${getTokenLogo()}" alt="AB"></div>
          <div class="wallet-page-header-text">
            <h2>${esc(WT('ab_token_wallet'))}</h2>
            <span>${esc(WT('loading_wallet'))}</span>
          </div>
        </div>
      </div>
      <div class="wallet-skeleton">
        <div class="wallet-skeleton-hero">
          <div class="wallet-skeleton-row">
            <div class="sk-circle"></div>
            <div class="sk-stack">
              <div class="sk-line w-30"></div>
              <div class="sk-line w-50"></div>
            </div>
            <div class="sk-circle"></div>
          </div>
          <div class="sk-line w-40 h-sm"></div>
          <div class="sk-line w-80 h-xl"></div>
          <div class="sk-line w-100 h-sm"></div>
          <div class="sk-bar"></div>
        </div>
        <div class="wallet-skeleton-strip">
          <div class="sk-pill"></div>
          <div class="sk-pill"></div>
          <div class="sk-pill"></div>
          <div class="sk-pill"></div>
        </div>
        <div class="wallet-skeleton-card">
          <div class="sk-line w-40"></div>
          <div class="wallet-skeleton-tx">
            <div class="sk-circle sm"></div>
            <div class="sk-stack grow">
              <div class="sk-line w-50"></div>
              <div class="sk-line w-30"></div>
            </div>
            <div class="sk-line w-20"></div>
          </div>
          <div class="wallet-skeleton-tx">
            <div class="sk-circle sm"></div>
            <div class="sk-stack grow">
              <div class="sk-line w-50"></div>
              <div class="sk-line w-30"></div>
            </div>
            <div class="sk-line w-20"></div>
          </div>
          <div class="wallet-skeleton-tx">
            <div class="sk-circle sm"></div>
            <div class="sk-stack grow">
              <div class="sk-line w-50"></div>
              <div class="sk-line w-30"></div>
            </div>
            <div class="sk-line w-20"></div>
          </div>
        </div>
      </div>
    `;
  }

  // =============================================
  // API Calls
  // =============================================
  async function fetchWallet() {
    try {
      const data = await window.apiFetch('/api/wallet');
      if (data.status === 'success') {
        walletData = data;
        return data;
      }
    } catch (e) {
      console.warn('WalletApp: fetchWallet error', e);
    }
    return null;
  }

  async function fetchClaimStatus() {
    try {
      const data = await window.apiFetch('/api/wallet/claim');
      if (data.status === 'success') {
        claimStatus = data;
        return data;
      }
    } catch (e) {
      console.warn('WalletApp: fetchClaimStatus error', e);
    }
    return null;
  }

  async function fetchSummary() {
    try {
      const data = await window.apiFetch('/api/wallet/summary');
      if (data && data.status === 'success') {
        walletSummary = data;
        return data;
      }
    } catch (e) {
      // silent fail — summary is optional
    }
    return null;
  }

  async function claimDailyRewardAPI() {
    try {
      const data = await window.apiFetch('/api/wallet/claim', { method: 'POST' });
      return data;
    } catch (e) {
      console.warn('WalletApp: claimDailyRewardAPI error', e);
      try { return JSON.parse(e.message); } catch (_) {}
      return { status: 'error', message: 'Network error' };
    }
  }

  async function fetchHistory(offset = 0) {
    try {
      const data = await window.apiFetch(`/api/wallet/history?offset=${offset}&limit=20`);
      if (data.status === 'success') return data;
    } catch (e) {
      console.warn('WalletApp: fetchHistory error', e);
    }
    return null;
  }

  // =============================================
  // Public Actions
  // =============================================
  async function loadProfileCard() {
    const card = document.getElementById('wallet-preview-card');
    if (!card) return;
    applyDir(card);

    // Guest or pending users — show access-denied state, not skeleton
    const uid = window.getUserId?.();
    if (window.isGuestUserId?.(uid) || window.isPendingTelegramUserId?.(uid) || window.UserContext?.isPending?.()) {
      card.classList.remove('skeleton-loading');
      card.innerHTML = `
        <div class="wallet-watermark"><img src="${getTokenLogo()}" alt=""></div>
        <div class="wallet-preview-top">
          <div class="wallet-preview-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
          <div class="wallet-preview-info">
            <div class="wallet-preview-title">${esc(WT('ab_token_wallet'))}</div>
            <div class="wallet-preview-subtitle">${esc(WT('wallet_subtitle'))}</div>
          </div>
        </div>
        <div class="wallet-preview-balance">
          <div class="balance-label">${esc(WT('current_balance'))}</div>
          <div class="balance-value login-prompt">${esc(WT('login_to_view'))}</div>
        </div>
        <button class="wallet-open-btn" disabled>${esc(WT('open_wallet'))} ${ICONS.arrowRight}</button>
      `;
      return;
    }

    renderProfileCardSkeleton();
    const data = await fetchWallet();
    if (data) {
      renderProfileCard(data);
    } else {
      // API error or transient failure — show fallback with safe defaults
      card.classList.remove('skeleton-loading');
      const fallbackData = { balance: 0, tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 } };
      renderProfileCard(fallbackData);
    }
  }

  function openWallet() {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;
    // Guard removed: skeleton-loading on profile card should not block opening
    // the wallet page. The user may click the card before data loads.
    applyDir(page);
    page.innerHTML = buildWalletSkeleton();
    page.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Load wallet data
    loadWalletData();
  }

  function closeWallet() {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;
    page.classList.remove('open');
    document.body.style.overflow = '';
    // Refresh profile card
    loadProfileCard();
  }

  async function loadWalletData() {
    walletSummary = null;
    const [walletRes, claimRes, summaryRes] = await Promise.all([
      fetchWallet(),
      fetchClaimStatus(),
      fetchSummary(),
    ]);

    if (walletRes) {
      renderWalletPage(walletRes);
      walletData = walletRes;
      // Set referral link
      const user = window.UserContext?.user || window.getTelegramUser?.();
      if (user?.id) {
        const botUsername = window.BOT_USERNAME || '';
        const refInput = document.getElementById('wallet-ref-link');
        if (refInput) refInput.value = `https://t.me/${botUsername}?start=ref_${user.id}`;
      }
      // Load referral stats
      loadWalletReferralStats();
    } else {
      // API error — show fallback with safe defaults instead of permanent error state
      const fallbackData = {
        balance: 0,
        tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 },
        history: [],
      };
      renderWalletPage(fallbackData);
    }

    if (claimRes) {
      updateClaimButton(claimRes.claimed_today);
    }
  }

  async function loadWalletReferralStats() {
    try {
      const data = await window.apiFetch('/api/wallet/referral-stats');
      if (data.status === 'success') {
        const invited = document.getElementById('wallet-ref-invited');
        const active = document.getElementById('wallet-ref-active');
        const earned = document.getElementById('wallet-ref-earned');
        const pending = document.getElementById('wallet-ref-pending');
        if (invited) invited.textContent = data.invited || 0;
        if (active) active.textContent = data.active || 0;
        if (earned) earned.textContent = data.earned || 0;
        if (pending) pending.textContent = Math.max(0, (data.invited || 0) - (data.earned || 0));
      }
    } catch (e) {
      // silent fail
    }
  }

  function updateClaimButton(claimed) {
    const btn = document.getElementById('daily-claim-btn');
    const card = document.getElementById('daily-checkin-card');
    if (!btn || !card) return;

    if (claimed) {
      btn.disabled = true;
      btn.textContent = WT('claimed');
      if (!card.querySelector('.earn-claimed-badge')) {
        const badge = document.createElement('span');
        badge.className = 'earn-claimed-badge';
        badge.textContent = WT('claimed').toUpperCase();
        card.appendChild(badge);
      }
    } else {
      btn.disabled = false;
      btn.textContent = WT('claim');
    }
  }

  async function claimDaily() {
    const btn = document.getElementById('daily-claim-btn');
    if (!btn || btn.disabled) return;

    btn.disabled = true;
    btn.textContent = WT('claiming');

    const result = await claimDailyRewardAPI();

    if (result.status === 'success') {
      btn.textContent = WT('claimed');
      const card = document.getElementById('daily-checkin-card');
      if (card) card.classList.add('wallet-claim-success');
      setTimeout(() => {
        if (card) card.classList.remove('wallet-claim-success');
      }, 500);
      if (!card?.querySelector('.earn-claimed-badge')) {
        const badge = document.createElement('span');
        badge.className = 'earn-claimed-badge';
        badge.textContent = WT('claimed').toUpperCase();
        card?.appendChild(badge);
      }
      // Refresh wallet data
      const walletRes = await fetchWallet();
      if (walletRes) renderWalletPage(walletRes);
      // Show success popup
      const tg = window.getTg?.();
      tg?.showPopup?.({ title: WT('success'), message: `+${DAILY_REWARD} AB — ${WT('claim_success')}`, buttons: [{ type: 'ok' }] });
    } else {
      btn.disabled = false;
      btn.textContent = WT('claim');
      const tg = window.getTg?.();
      tg?.showPopup?.({ title: WT('error'), message: result.message || WT('claim_error'), buttons: [{ type: 'ok' }] });
    }
  }

  async function loadMoreHistory() {
    if (historyLoading) return;
    historyLoading = true;
    const btn = document.querySelector('#wallet-load-more button');
    if (btn) btn.textContent = WT('loading');

    historyOffset += 20;
    const result = await fetchHistory(historyOffset);

    if (result && result.transactions && result.transactions.length > 0) {
      const list = document.getElementById('wallet-tx-list');
      // Remove empty state if present
      const empty = list?.querySelector('.wallet-empty-state');
      if (empty) empty.remove();

      const html = result.transactions.map(tx => buildTxItemHTML(tx)).join('');
      list?.insertAdjacentHTML('beforeend', html);

      if (!result.hasMore) {
        const loadMore = document.getElementById('wallet-load-more');
        if (loadMore) loadMore.remove();
      }
    } else {
      historyOffset -= 20;
    }

    if (btn) btn.textContent = WT('load_more');
    historyLoading = false;
  }

  function copyRefLink() {
    const input = document.getElementById('wallet-ref-link');
    if (!input || !input.value) return;
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch (e) { document.execCommand('copy'); }
    const tg = window.getTg?.();
    tg?.showPopup?.({ title: WT('copied'), message: WT('ref_copied'), buttons: [{ type: 'ok' }] });
  }

  function shareRefLink() {
    const input = document.getElementById('wallet-ref-link');
    if (!input || !input.value) return;
    const link = input.value;
    const text = encodeURIComponent(WT('join_amir'));
    const tg = window.getTg?.();
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
  }

  function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  return {
    loadProfileCard,
    openWallet,
    closeWallet,
    claimDaily,
    loadMoreHistory,
    copyRefLink,
    shareRefLink,
    scrollToSection,
    getTokenLogo,
  };
})();

// Expose globally
window.WalletApp = WalletApp;

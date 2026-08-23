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
    wallet_subtitle: 'مرکز مدیریت دارایی‌های شما',
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
    join_amir: 'به AmirBTC بپیوندید و توکن AB کسب کنید!',
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
    brand_quote: 'امیر بیت‌کوین — دستیار حرفه‌ای بازار',
    token_slogan: 'توکن AB، واحد پاداش داخلی اپ — برای دسترسی به خدمات ویژه، جوایز و امکانات اختصاصی.',
    token_info_title: 'توکن AB چیست؟',
    token_info_body: 'توکن AB یک دارایی دیجیتال داخلی مینی‌اپ است که جایزه فعالیت‌های شماست. این توکن فقط در محیط اپ کاربرد دارد و قابلیت برداشت یا انتقال به کیف پول خارجی را ندارد. از توکن AB برای استفاده از خدمات ویژه، دریافت جوایز و دسترسی به امکانات اختصاصی مینی‌اپ استفاده کنید.',
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
    brand_quote: 'AmirBTC — Your Professional Market Assistant',
    token_slogan: 'AB Token is the in-app reward unit — for premium features, rewards, and exclusive access.',
    token_info_title: 'What is AB Token?',
    token_info_body: 'AB Token is an internal mini-app digital asset that rewards your activity. It can only be used within the app and cannot be withdrawn or transferred to external wallets. Use AB Token to access premium features, claim rewards, and unlock exclusive in-app capabilities.',
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
  // PHASE UX-V2.1: removed dead constant DAILY_REWARD = 10.
  // Reward amount is server-authoritative (result.amount from API response).

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
      wheel_reward: detectLang() === 'fa' ? 'پاداش چرخ شانس' : 'Wheel Reward',
      bonus_reward: detectLang() === 'fa' ? 'پاداش تشویقی' : 'Bonus Reward',
      cosmetic_purchase: detectLang() === 'fa' ? 'خرید کازمتیک' : 'Cosmetic Purchase',
      alert_debit: detectLang() === 'fa' ? 'هشدار اضافه' : 'Extra Alert',
      vpn_purchase: detectLang() === 'fa' ? 'خرید VPN' : 'VPN Purchase',
      marketplace_refund: detectLang() === 'fa' ? 'بازگشت مبلغ' : 'Refund',
      campaign_reward: detectLang() === 'fa' ? 'پاداش کمپین' : 'Campaign Reward',
      event_reward: detectLang() === 'fa' ? 'پاداش رویداد' : 'Event Reward',
    };
    // FIX 4: never show raw type/undefined/null — always a human label
    return map[type] || (detectLang() === 'fa' ? 'تراکنش توکن' : 'Token Transaction');
  }

  function getTxStatusLabel(status) {
    const map = {
      completed: WT('completed'),
      pending: WT('pending'),
      failed: WT('failed'),
      reversed: WT('reversed'),
    };
    return map[status] || (detectLang() === 'fa' ? 'نامشخص' : 'Unknown');
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
      <button class="wallet-info-btn" onclick="event.stopPropagation(); WalletApp.showTokenInfo()" aria-label="AB Token info">
        <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
      </button>
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

    // Re-render mission cards into the new grid (the page innerHTML was
    // completely replaced, so any previously rendered cards are gone —
    // updateMissionCards is a global from app.js that rebuilds the
    // #wallet-earn-grid from cached backend mission data)
    if (typeof window.updateMissionCards === 'function') {
      try { window.updateMissionCards(); } catch (_) {}
    }
    // VPN market also needs re-rendering (the grid container was replaced)
    // — but isPremium is not known here; it will be re-rendered by
    // loadWalletData's vpnPromise after fetchClaimStatus resolves.

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

      <!-- PHASE 3 FIX: removed brand_quote + token_slogan (decorative, no UX value).
           Token info is available via showTokenInfo() popup if user taps the info icon. -->

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
          <span class="weekly-reset-countdown" id="weekly-reset-countdown"></span>
        </div>
        <div class="wallet-earn-grid" id="wallet-earn-grid">
          <!-- Compact Daily Check-in card (opens the 7-day streak modal) -->
          <div class="wallet-earn-card daily-checkin" id="daily-checkin-card" onclick="WalletApp.openDailyCheckinModal()">
            <div class="checkin-icon">${ICONS.calendar}</div>
            <div class="checkin-info">
              <div class="checkin-title">${esc(WT('daily_checkin'))}</div>
              <div class="checkin-subtitle">${detectLang() === 'fa' ? 'هر روز وارد شو و پاداش بگیر' : 'Come back daily for rewards'}</div>
              <div class="checkin-reward" id="daily-reward-amount">—</div>
            </div>
            <div class="checkin-arrow">
              <svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><polyline points="9 18 15 12 9 6"/></svg>
            </div>
          </div>
          <!-- Mission cards are rendered dynamically by updateMissionCards()
               from backend data (mission_id, reward, status, trigger) -->
        </div>
      </div>

      <!-- Reward Market (VPN) -->
      <div class="wallet-section" id="wallet-marketplace-section">
        <div class="wallet-section-header">
          <h3>${esc(WT('rewards_marketplace'))}</h3>
        </div>
        <div id="reward-market-premium-banner" class="reward-market-premium-banner" style="display:none;">
          <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          <span>${detectLang() === 'fa' ? 'ویژه اعضای Premium — برای خرید ارتقا دهید' : 'Premium members only — upgrade to purchase'}</span>
        </div>
        <div class="vpn-market-grid" id="vpn-market-grid">
          <!-- VPN plan cards rendered dynamically by WalletApp.renderVpnMarket() -->
        </div>
      </div>

            <!-- Transaction History — PHASE 3 UI: compact (first 5 by default) -->
      <div class="wallet-section" id="wallet-history-section">
        <div class="wallet-section-header">
          <h3>${esc(WT('transaction_history'))}</h3>
          ${history.length > 5 ? `<span class="tx-count-badge">${history.length}</span>` : ''}
        </div>
        <div id="wallet-tx-list" class="wallet-tx-list">
          ${history.length > 0
            ? history.slice(0, 5).map(tx => buildTxItemHTML(tx)).join('')
            : buildEmptyStateHTML()
          }
        </div>
        ${history.length > 5 ? `
          <div class="wallet-load-more-wrap">
            <button class="wallet-load-more-btn" onclick="WalletApp.showFullHistory()">
              ${detectLang() === 'fa' ? 'مشاهده تاریخچه کامل' : 'View Full History'}
              <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" style="margin-inline-start:4px;"><polyline points="9 18 15 12 9 6"/></svg>
            </button>
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
    // FIX 4: guard against null/undefined/NaN — always show clean values
    const amount = Number(tx.amount) || 0;
    const isPositive = amount > 0;
    const type = tx.type || 'unknown';
    const desc = (tx.description && String(tx.description).trim()) || '';
    const time = tx.created_at ? formatTime(tx.created_at) : '';
    const status = tx.status
      ? `<span class="tx-status status-${esc(tx.status)}">${esc(getTxStatusLabel(tx.status))}</span>`
      : '';
    return `
      <div class="wallet-tx-item">
        <div class="wallet-tx-icon tx-${getTxIcon(type)}">${getTxIconSvg(type)}</div>
        <div class="wallet-tx-info">
          <div class="tx-type">${esc(getTxLabel(type))}</div>
          ${desc ? `<div class="tx-desc">${esc(desc)}</div>` : ''}
          ${status ? `<div class="tx-status-row">${status}</div>` : ''}
        </div>
        <div class="wallet-tx-right">
          <div class="tx-amount ${isPositive ? 'positive' : 'negative'}">${isPositive ? '+' : '−'}${formatNumber(Math.abs(amount))} <span class="tx-unit">AB</span></div>
          ${time ? `<div class="tx-time">${esc(time)}</div>` : ''}
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
  // ── DASHBOARD SPEED OPTIMIZATION: In-memory cache for wallet responses ──
  // Wallet data changes rarely (only on claim/transaction). Caching eliminates
  // redundant API calls on openWallet/closeWallet, cutting latency from
  // ~250-600ms to ~0-30ms for repeat opens within the TTL window.
  const _walletCache = {
    wallet: null,      // /api/wallet response
    claim: null,       // /api/wallet/claim response
    summary: null,     // /api/wallet/summary response
    walletAt: 0,
    claimAt: 0,
    summaryAt: 0,
  };
  // PHASE 6 FIX: reduced WALLET_CACHE_TTL from 30s to 15s.
  // 30s was too long — after a reward credit (e.g., daily_login on bootstrap),
  // the cached balance could be stale for up to 30s if invalidateWalletCache
  // wasn't called. 15s is a better balance: still eliminates redundant API
  // calls on rapid wallet open/close, but reduces stale window by 50%.
  // The bootstrap wallet_changed flag (Phase 1 fix) + refreshWalletAfterMission
  // (Phase 3 fix) already invalidate cache on explicit reward events — the TTL
  // is just a safety net for cases where no explicit event fires.
  const WALLET_CACHE_TTL = 15;   // seconds — wallet balance/history
  const CLAIM_CACHE_TTL = 60;    // seconds — daily claim status (changes once/day)
  const SUMMARY_CACHE_TTL = 60;  // seconds — aggregate stats

  function invalidateWalletCache() {
    _walletCache.wallet = null;
    _walletCache.claim = null;
    _walletCache.summary = null;
    _walletCache.walletAt = 0;
    _walletCache.claimAt = 0;
    _walletCache.summaryAt = 0;
  }

  async function fetchWallet() {
    // Cache-first: if we have fresh data, return it without a network call
    if (_walletCache.wallet && (Date.now() - _walletCache.walletAt < WALLET_CACHE_TTL * 1000)) {
      return _walletCache.wallet;
    }
    try {
      const data = await window.apiFetch('/api/wallet');
      if (data.status === 'success') {
        walletData = data;
        _walletCache.wallet = data;
        _walletCache.walletAt = Date.now();
        return data;
      }
    } catch (e) {
      console.warn('WalletApp: fetchWallet error', e);
    }
    return null;
  }

  async function fetchClaimStatus() {
    if (_walletCache.claim && (Date.now() - _walletCache.claimAt < CLAIM_CACHE_TTL * 1000)) {
      return _walletCache.claim;
    }
    try {
      const data = await window.apiFetch('/api/wallet/claim');
      if (data.status === 'success') {
        claimStatus = data;
        _walletCache.claim = data;
        _walletCache.claimAt = Date.now();
        return data;
      }
    } catch (e) {
      console.warn('WalletApp: fetchClaimStatus error', e);
    }
    return null;
  }

  async function fetchSummary() {
    if (_walletCache.summary && (Date.now() - _walletCache.summaryAt < SUMMARY_CACHE_TTL * 1000)) {
      return _walletCache.summary;
    }
    try {
      const data = await window.apiFetch('/api/wallet/summary');
      if (data && data.status === 'success') {
        walletSummary = data;
        _walletCache.summary = data;
        _walletCache.summaryAt = Date.now();
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

    // ROOT CAUSE FIX (wallet P0): Hydrate from localStorage BEFORE fetching.
    // Other dashboard sections (Market, News, Analysis, Calendar) all hydrate
    // from localStorage and render instantly. Wallet was the only section
    // that showed skeleton until the API responded (150-300ms).
    // Now we render from cached wallet data immediately, then refresh in
    // background — matching the perceived speed of other sections.
    try {
      const cachedStr = localStorage.getItem('wallet_state_cache');
      if (cachedStr) {
        const cached = JSON.parse(cachedStr);
        if (cached && cached.data && cached.data.status === 'success') {
          // Render from cache immediately — no skeleton
          renderProfileCard(cached.data);
        }
      }
    } catch (_) { /* bad cache — fall through to skeleton + fetch */ }

    // If cache didn't render, show skeleton
    if (card.classList.contains('skeleton-loading') || !card.querySelector('.wallet-preview-balance')) {
      renderProfileCardSkeleton();
    }

    const data = await fetchWallet();
    if (data) {
      renderProfileCard(data);
      // Persist to localStorage for instant render on next open
      try {
        localStorage.setItem('wallet_state_cache', JSON.stringify({ data, ts: Date.now() }));
      } catch (_) {}
    } else {
      // API error — show fallback only if no cached data was rendered
      if (!card.querySelector('.wallet-preview-balance')) {
        card.classList.remove('skeleton-loading');
        const fallbackData = { balance: 0, tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 } };
        renderProfileCard(fallbackData);
      }
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

    // FIX 3: Trigger mission status reload so mission cards render into
    // the fresh #wallet-earn-grid. reloadMissions resets the loaded flag
    // and re-fetches, then calls updateMissionCards() which finds the
    // new #wallet-earn-grid in the re-rendered page.
    if (typeof window.reloadMissions === 'function') {
      window.reloadMissions();
    } else if (typeof window.loadMissionStatus === 'function') {
      window.loadMissionStatus();
    }
  }

  function closeWallet() {
    const page = document.getElementById('wallet-full-page');
    if (!page) return;
    page.classList.remove('open');
    document.body.style.overflow = '';
    // PHASE UX-V2.1 FIX: stop weekly countdown timer to prevent memory leak.
    // Without this, the setInterval continues running after the wallet page
    // is closed, consuming battery/CPU on mobile devices.
    _stopWeeklyCountdown();
    // ROOT CAUSE FIX (O3): Previously closeWallet always called loadProfileCard()
    // which fires GET /api/wallet — a redundant call since the wallet data was
    // just fetched on openWallet. Now we skip the re-fetch if walletData is
    // fresh (< 30s old). The profile card re-renders synchronously from the
    // cached data, eliminating 1 API round-trip on every wallet close.
    if (walletData && _walletCache.wallet && (Date.now() - _walletCache.walletAt < WALLET_CACHE_TTL * 1000)) {
      // Render profile card from cached walletData — no API call needed
      try { renderProfileCard(walletData); } catch (_) { loadProfileCard(); }
    } else {
      loadProfileCard();
    }
  }

  async function loadWalletData() {
    walletSummary = null;

    // ROOT CAUSE FIX (wallet P1): Progressive rendering.
    // Previously, Promise.all waited for ALL 3 API calls before rendering
    // anything. The slowest call (usually fetchSummary with its aggregate
    // SQL query) blocked the entire wallet page.
    //
    // Now we fire all 3 in parallel but render each section independently
    // as soon as it resolves:
    //   1. fetchWallet resolves first (often cached) → render full page immediately
    //   2. fetchClaimStatus resolves → update claim button
    //   3. fetchSummary resolves → update summary strip
    //
    // This cuts perceived time-to-content from max(call1,call2,call3)
    // to just call1 (typically 30-50ms from in-memory cache).

    // Fire all 3 in parallel
    const walletPromise = fetchWallet();
    const claimPromise = fetchClaimStatus();
    // PHASE 5-7: render the VPN market (needs isPremium from claim status)
    const vpnPromise = fetchClaimStatus().then(claimRes => {
      renderVpnMarket(claimRes?.is_premium || false);
    }).catch(() => renderVpnMarket(false));
    const summaryPromise = fetchSummary();

    // Render wallet page as soon as wallet data arrives (don't wait for others)
    walletPromise.then(walletRes => {
      if (walletRes) {
        renderWalletPage(walletRes);
        walletData = walletRes;
        _lastKnownBalance = Number(walletRes.balance) || 0;
        // Persist to localStorage for instant render on next open
        try {
          localStorage.setItem('wallet_state_cache', JSON.stringify({ data: walletRes, ts: Date.now() }));
        } catch (_) {}
      } else {
        // API error — show fallback
        const fallbackData = {
          balance: 0,
          tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 },
          history: [],
        };
        renderWalletPage(fallbackData);
      }
    }).catch(() => {
      const fallbackData = {
        balance: 0,
        tier: { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 },
        history: [],
      };
      renderWalletPage(fallbackData);
    });

    // Update claim button when claim status arrives
    // PHASE UX-V2.1: cache streak state for Daily Check-in modal
    claimPromise.then(claimRes => {
      if (claimRes) {
        // Cache state for modal + card rendering
        _dailyCheckinState = {
          streak_day: claimRes.streak_day || 0,
          streak_rewards: claimRes.streak_rewards || [1, 3, 6, 10, 18, 30, 50],
          claimed_today: claimRes.claimed_today || false,
          last_claim_date: claimRes.last_claim_date || null,
        };
        // Update the compact card summary
        _updateDailyCheckinCard();
      }
    }).catch(() => {});

    // PHASE UX-V2.1: Start weekly countdown timer
    _startWeeklyCountdown();

    // Update summary strip when summary arrives (optional — buildSummaryStrip
    // handles null walletSummary gracefully)
    summaryPromise.then(summaryRes => {
      if (summaryRes) {
        walletSummary = summaryRes;
        // Re-render just the summary strip if the page is open
        const summaryStrip = document.querySelector('.wallet-summary-strip');
        if (summaryStrip && walletData) {
          // Only update if the wallet page is already rendered
          const newHtml = buildSummaryStrip(summaryRes.tier || walletData.tier);
          if (newHtml) {
            const temp = document.createElement('div');
            temp.innerHTML = newHtml;
            const newStrip = temp.firstElementChild;
            if (newStrip) summaryStrip.replaceWith(newStrip);
          }
        }
      }
    }).catch(() => {});
  }

  // loadWalletReferralStats removed — referral moved to Referral Center module

  // PHASE UX-V2.1: Old _renderStreakUI removed — 7-day streak now rendered
  // inside the Daily Check-in Modal (see _renderStreakDaysHTML below).
  // PHASE UX-V2.1 FIX: removed dead function updateClaimButton (never called
  // after _dailyCheckinState + _updateDailyCheckinCard replaced it).

  async function claimDaily() {
    const btn = document.getElementById('daily-claim-btn');
    // PHASE UX-V2.1: btn may be in modal OR in card. If in modal, disable it.
    if (btn) { btn.disabled = true; btn.textContent = WT('claiming'); }

    const result = await claimDailyRewardAPI();

    if (result.status === 'success') {
      // Update cached state from claim response
      _dailyCheckinState = {
        streak_day: result.streak_day || 1,
        streak_rewards: result.streak_rewards || [1, 3, 6, 10, 18, 30, 50],
        claimed_today: true,
        last_claim_date: _getTehranDateString(),
      };

      // PHASE UX-V2.1: Update balance immediately from API response — no extra fetchWallet.
      invalidateWalletCache();
      if (typeof result.newBalance === 'number' && result.newBalance >= 0) {
        const balanceEl = document.querySelector('.wallet-balance-value, .hero-balance');
        if (balanceEl) {
          const currentBalance = parseFloat(balanceEl.textContent?.replace(/[^0-9.]/g, '')) || 0;
          if (typeof animateBalanceChange === 'function') {
            animateBalanceChange(balanceEl, currentBalance, result.newBalance);
          } else {
            balanceEl.textContent = result.newBalance.toLocaleString('en-US');
          }
        }
        if (walletData) {
          walletData.balance = result.newBalance;
          _walletCache.wallet = walletData;
          _walletCache.walletAt = Date.now();
        }
      }

      // PHASE UX-V2.1: Update daily check-in card summary
      _updateDailyCheckinCard();

      // PHASE UX-V2.1: If modal is open, re-render streak days to show ✓ on today
      const daysGrid = document.getElementById('dcm-days-grid');
      if (daysGrid) {
        daysGrid.innerHTML = _renderStreakDaysHTML(
          result.streak_day || 1,
          result.streak_rewards || [1, 3, 6, 10, 18, 30, 50],
          true
        );
        // Update reward display + hint
        const rewardDisplay = daysGrid.parentElement.querySelector('.dcm-reward-display');
        if (rewardDisplay) {
          rewardDisplay.innerHTML = `<span class="dcm-claimed"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> ${detectLang() === 'fa' ? 'دریافت شد' : 'Claimed'}</span>`;
        }
        const hintEl = daysGrid.parentElement.querySelector('.dcm-hint');
        if (!hintEl) {
          const hint = document.createElement('div');
          hint.className = 'dcm-hint';
          hint.textContent = detectLang() === 'fa' ? 'فردا برگرد و ادامه بده!' : 'Come back tomorrow!';
          daysGrid.parentElement.appendChild(hint);
        }
        // Remove claim button from modal
        const claimBtn = daysGrid.parentElement.querySelector('.dcm-claim-btn');
        if (claimBtn) claimBtn.remove();
      }

      // PHASE UX-V2.1: Update notification badge immediately
      if (typeof updateNotifBadge === 'function') {
        try { updateNotifBadge(); } catch (_) {}
      }

      // Show success popup — use actual amount from API
      const tg = window.getTg?.();
      try { tg?.HapticFeedback?.notificationOccurred?.('success'); } catch (_) {}
      const rewardAmount = result.amount || result.daily_reward || 0;
      tg?.showPopup?.({ title: WT('success'), message: `+${rewardAmount} AB — ${WT('claim_success')}`, buttons: [{ type: 'ok' }] });
    } else {
      btn.disabled = false;
      btn.textContent = WT('claim');
      const tg = window.getTg?.();
      try { tg?.HapticFeedback?.notificationOccurred?.('error'); } catch (_) {}
      tg?.showPopup?.({ title: WT('error'), message: result.message || WT('claim_error'), buttons: [{ type: 'ok' }] });
    }
  }

  // PHASE 3 UI: Show full history — expands to show ALL cached transactions
  // and starts pagination for more (Load More)
  function showFullHistory() {
    const list = document.getElementById('wallet-tx-list');
    if (!list || !walletData?.history) return;

    // Render all transactions from the initial wallet data (up to 20 from API)
    list.innerHTML = walletData.history.map(tx => buildTxItemHTML(tx)).join('');

    // Replace the "view full" button with Load More (if more pages exist)
    const btnWrap = document.querySelector('#wallet-history-section .wallet-load-more-wrap');
    if (walletData.history.length >= 20 && btnWrap) {
      btnWrap.innerHTML = `<button class="wallet-load-more-btn" onclick="WalletApp.loadMoreHistory()">${esc(WT('load_more'))}</button>`;
      btnWrap.id = 'wallet-load-more';
    } else if (btnWrap) {
      btnWrap.remove();
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

  // copyRefLink and shareRefLink removed — referral moved to Referral Center module

  function scrollToSection(id) {
    const el = document.getElementById(id);
    if (el) el.scrollIntoView({ behavior: 'smooth', block: 'start' });
  }

  /**
   * Show a popup explaining what AB Token is.
   * Called when the user taps the info icon on the wallet card.
   */
  function showTokenInfo() {
    // Remove any existing popup
    const existing = document.getElementById('token-info-popup');
    if (existing) { existing.remove(); return; }

    const popup = document.createElement('div');
    popup.id = 'token-info-popup';
    popup.className = 'token-info-popup';
    popup.setAttribute('dir', detectLang() === 'fa' ? 'rtl' : 'ltr');
    popup.innerHTML = `
      <div class="token-info-popup-overlay" onclick="WalletApp.closeTokenInfo()"></div>
      <div class="token-info-popup-card">
        <div class="token-info-popup-header">
          <div class="token-info-popup-icon">
            <svg viewBox="0 0 24 24" width="24" height="24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="16" x2="12" y2="12"/><line x1="12" y1="8" x2="12.01" y2="8"/></svg>
          </div>
          <h3>${esc(WT('token_info_title'))}</h3>
          <button class="token-info-popup-close" onclick="WalletApp.closeTokenInfo()" aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="token-info-popup-body">${esc(WT('token_info_body'))}</div>
      </div>
    `;
    document.body.appendChild(popup);
    requestAnimationFrame(() => popup.classList.add('visible'));
    // Haptic feedback
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light'); } catch (_) {}
  }

  function closeTokenInfo() {
    const popup = document.getElementById('token-info-popup');
    if (!popup) return;
    popup.classList.remove('visible');
    setTimeout(() => popup.remove(), 250);
  }

  // ════════════════════════════════════════════════════════════════════
  // PHASE UX-V2.1: Daily Check-in Modal + Weekly Countdown
  // ════════════════════════════════════════════════════════════════════

  // State for daily check-in modal (cached from GET /api/wallet/claim)
  let _dailyCheckinState = null; // { streak_day, streak_rewards, claimed_today, last_claim_date }
  let _weeklyCountdownTimer = null;

  function openDailyCheckinModal() {
    // Remove existing modal
    const existing = document.getElementById('daily-checkin-modal');
    if (existing) { existing.remove(); return; }

    // Use cached state if available, otherwise show loading
    const state = _dailyCheckinState;
    const streakDay = state?.streak_day || 0;
    const streakRewards = state?.streak_rewards || [1, 3, 6, 10, 18, 30, 50];
    const claimedToday = state?.claimed_today || false;

    // Build modal
    const modal = document.createElement('div');
    modal.id = 'daily-checkin-modal';
    modal.className = 'daily-checkin-modal';
    modal.setAttribute('dir', detectLang() === 'fa' ? 'rtl' : 'ltr');
    modal.innerHTML = `
      <div class="dcm-overlay" onclick="WalletApp.closeDailyCheckinModal()"></div>
      <div class="dcm-sheet">
        <div class="dcm-header">
          <h3>${esc(WT('daily_checkin'))}</h3>
          <button class="dcm-close" onclick="WalletApp.closeDailyCheckinModal()" aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="dcm-streak-summary">
          ${streakDay > 0 ? `<span class="dcm-streak-flame"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg> ${streakDay} ${detectLang() === 'fa' ? 'روز پشت سر هم' : 'days in a row'}</span>` : ''}
        </div>
        <div class="dcm-days-grid" id="dcm-days-grid">
          ${_renderStreakDaysHTML(streakDay, streakRewards, claimedToday)}
        </div>
        <div class="dcm-reward-display">
          ${claimedToday
            ? `<span class="dcm-claimed"><svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg> ${detectLang() === 'fa' ? 'دریافت شد' : 'Claimed'}</span>`
            : `<span class="dcm-today-reward">+${streakRewards[Math.max(0, Math.min(6, (streakDay > 0 ? streakDay : 0)))]} AB</span>`
          }
        </div>
        ${claimedToday
          ? `<div class="dcm-hint">${detectLang() === 'fa' ? 'فردا برگرد و ادامه بده!' : 'Come back tomorrow to continue!'}</div>`
          : `<button class="dcm-claim-btn" onclick="WalletApp.claimDaily()">
              ${esc(WT('claim'))}
            </button>`
        }
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('light'); } catch (_) {}
  }

  function closeDailyCheckinModal() {
    const modal = document.getElementById('daily-checkin-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 250);
  }

  // Render 7-day streak HTML — PHASE 1: explicit rewards + clear statuses
  function _renderStreakDaysHTML(currentStreakDay, streakRewards, claimedToday) {
    const days = (streakRewards && streakRewards.length >= 7) ? streakRewards.slice(0, 7) : [1, 3, 6, 10, 18, 30, 50];
    const fa = detectLang() === 'fa';
    let html = '';
    for (let i = 0; i < 7; i++) {
      const day = i + 1;
      const reward = days[i] || 0;
      const isClaimed = day < currentStreakDay || (claimedToday && day === currentStreakDay);
      const isToday = day === currentStreakDay;
      const isDay7 = day === 7;

      let stateClass = '';
      let stateLabel = '';
      let stateSvg = '';
      if (isClaimed) {
        stateClass = 'dcm-day-claimed';
        stateLabel = fa ? 'دریافت شد' : 'Claimed';
        stateSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      } else if (isToday && !claimedToday) {
        stateClass = 'dcm-day-today';
        stateLabel = fa ? 'قابل دریافت' : 'Available';
        stateSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>';
      } else if (isToday && claimedToday) {
        stateClass = 'dcm-day-claimed';
        stateLabel = fa ? 'دریافت شد' : 'Claimed';
        stateSvg = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
      } else {
        stateClass = 'dcm-day-locked';
        stateLabel = fa ? 'قفل' : 'Locked';
        stateSvg = '<svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
      }

      html += `
        <div class="dcm-day ${stateClass} ${isDay7 ? 'dcm-day-7' : ''}" title="${fa ? 'روز ' + day : 'Day ' + day}: +${reward} AB">
          <div class="dcm-day-label">${fa ? 'روز' : 'Day'} ${day}</div>
          <div class="dcm-day-reward">+${reward} AB</div>
          <div class="dcm-day-state">${stateSvg}<span>${stateLabel}</span></div>
        </div>`;
    }
    return html;
  }

  // Update daily check-in card summary in wallet page
  function _updateDailyCheckinCard() {
    const state = _dailyCheckinState;
    if (!state) return;
    const rewardEl = document.getElementById('daily-reward-amount');
    if (rewardEl) {
      const rewards = state.streak_rewards || [1, 3, 6, 10, 18, 30, 50];
      if (state.claimed_today) {
        rewardEl.textContent = `Day ${state.streak_day}/7 · ✓`;
        rewardEl.style.color = '#22C55E';
      } else {
        const day = state.streak_day > 0 ? state.streak_day : 1;
        const nextReward = rewards[Math.max(0, Math.min(6, day - 1))] || 1;
        rewardEl.textContent = `Day ${day}/7 · +${nextReward} AB`;
        rewardEl.style.color = '#f5a623';
      }
    }
  }

  // Weekly countdown to Saturday 00:00 Tehran
  function _startWeeklyCountdown() {
    if (_weeklyCountdownTimer) clearInterval(_weeklyCountdownTimer);
    const el = document.getElementById('weekly-reset-countdown');
    if (!el) return;

    function update() {
      // Calculate next Saturday 00:00 Tehran
      const now = new Date();
      const fmt = new Intl.DateTimeFormat('en-CA', {
        timeZone: 'Asia/Tehran', weekday: 'short',
        year: 'numeric', month: '2-digit', day: '2-digit',
        hour: '2-digit', minute: '2-digit', hour12: false,
      });
      const parts = fmt.formatToParts(now);
      const weekday = parts.find(p => p.type === 'weekday')?.value || 'Sat';
      const weekdayMap = { 'Sat': 0, 'Sun': 1, 'Mon': 2, 'Tue': 3, 'Wed': 4, 'Thu': 5, 'Fri': 6 };
      const daysToSaturday = (7 - (weekdayMap[weekday] ?? 0)) % 7;

      // Target: next Saturday 00:00 Tehran = Saturday minus current time in Tehran
      const target = new Date(now);
      target.setDate(target.getDate() + daysToSaturday);
      target.setHours(0, 0, 0, 0);
      if (daysToSaturday === 0) {
        // Today is Saturday — check if already past midnight Tehran
        // If current Tehran time is past midnight, next Saturday is 7 days away
        const tehranHour = parseInt(parts.find(p => p.type === 'hour')?.value || '0', 10);
        const tehranMinute = parseInt(parts.find(p => p.type === 'minute')?.value || '0', 10);
        if (tehranHour > 0 || tehranMinute > 0) {
          // Already past midnight — next Saturday is 7 days away
          target.setDate(target.getDate() + 7);
        }
      }

      const diff = target.getTime() - now.getTime();
      if (diff <= 0) {
        el.textContent = '';
        _startWeeklyCountdown(); // Recalculate
        return;
      }

      const days = Math.floor(diff / 86400000);
      const hours = Math.floor((diff % 86400000) / 3600000);
      const mins = Math.floor((diff % 3600000) / 60000);

      if (days > 0) {
        el.textContent = `⟳ ${days}d ${String(hours).padStart(2, '0')}h`;
      } else if (hours > 0) {
        el.textContent = `⟳ ${hours}h ${String(mins).padStart(2, '0')}m`;
      } else {
        el.textContent = `⟳ ${mins}m`;
      }
    }

    update();
    _weeklyCountdownTimer = setInterval(update, 60000); // Update every 1 min
  }

  function _stopWeeklyCountdown() {
    if (_weeklyCountdownTimer) { clearInterval(_weeklyCountdownTimer); _weeklyCountdownTimer = null; }
  }

  // ═══════════════════════════════════════════════════════════════════
  // PHASE 5-7: VPN Reward Market (Premium-only purchase)
  // ═══════════════════════════════════════════════════════════════════

  let _vpnPlansCache = null;
  let _isPremiumUser = false;
  let _lastKnownBalance = 0;
  let _purchaseInFlight = false;

  function _vpnIconSvg(size) {
    return `<svg viewBox="0 0 24 24" width="${size}" height="${size}" fill="none" stroke="currentColor" stroke-width="1.8"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/><path d="M9 12l2 2 4-4"/></svg>`;
  }

  async function renderVpnMarket(isPremium) {
    // FIX 5: isPremium is used only as fallback — the actual plan states
    // (eligible, purchased, premium_only) come from the backend API response.
    const grid = document.getElementById('vpn-market-grid');
    const banner = document.getElementById('reward-market-premium-banner');
    if (!grid) return;
    if (banner) banner.style.display = 'none';

    // Always fetch fresh plans (server-authoritative, includes eligibility)
    let plansData = null;
    try {
      const resp = await window.apiFetch('/api/rewards/vpn/plans');
      if (resp?.status === 'success' && Array.isArray(resp.plans)) {
        plansData = resp;
      }
    } catch (_) {}
    if (!plansData || plansData.plans.length === 0) {
      grid.innerHTML = `<div class="vpn-market-empty">${detectLang() === 'fa' ? 'به‌زودی' : 'Coming soon'}</div>`;
      return;
    }

    _vpnPlansCache = plansData.plans;
    const fa = detectLang() === 'fa';

    grid.innerHTML = plansData.plans.map(plan => {
      // FIX 3+9: Server-authoritative states with priority:
      // Purchased > Eligible > Premium Locked > Available
      const isPurchased = plan.purchased === true;
      const isEligible = plan.eligible === true;
      const isPremiumLocked = !isPurchased && !isEligible && plan.premium_only;

      // FIX 8: Duration text from backend catalog
      const durText = fa
        ? (plan.duration_days >= 30 ? 'اشتراک یک ماهه' : 'اشتراک یک هفته‌ای')
        : (plan.duration_days >= 30 ? '1-month subscription' : '1-week subscription');

      let cardClass = 'vpn-card';
      let badgeHtml = '';
      let actionHtml = '';

      if (isPurchased) {
        // State C — Purchased (FIX 2+9: subdued, badge, no buy button)
        cardClass += ' vpn-card-purchased';
        badgeHtml = `<span class="vpn-purchased-badge">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>
          ${fa ? 'خریداری شده' : 'Purchased'}
        </span>`;
        if (plan.days_remaining > 0) {
          actionHtml = `<span class="vpn-purchased-days">${fa ? plan.days_remaining + ' روز دیگر' : plan.days_remaining + ' days left'}</span>`;
        }
      } else if (isPremiumLocked) {
        // State B — Premium Locked
        cardClass += ' vpn-card-locked';
        badgeHtml = `<span class="vpn-premium-badge">
          <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
          PREMIUM
        </span>`;
        actionHtml = `<span class="vpn-locked-badge">
          <svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="11" width="18" height="11" rx="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>
          ${fa ? 'مخصوص Premium' : 'Premium only'}
        </span>`;
      } else {
        // State A — Available (also State D — eligible again after cooldown)
        if (plan.premium_only) {
          badgeHtml = `<span class="vpn-premium-badge active">
            <svg viewBox="0 0 24 24" width="10" height="10" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87L18.18 22 12 18.56 5.82 22 7 14.14l-5-4.87 6.91-1.01L12 2z"/></svg>
            PREMIUM
          </span>`;
        }
        actionHtml = `<button class="vpn-buy-btn" onclick="WalletApp.purchaseVpn('${plan.id}')">${fa ? 'خرید' : 'Buy'}</button>`;
      }

      return `
      <div class="${cardClass}" data-plan="${plan.id}">
        ${badgeHtml}
        <div class="vpn-card-icon">${_vpnIconSvg(28)}</div>
        <div class="vpn-card-info">
          <div class="vpn-card-title">VPN ${plan.gb}GB</div>
          <div class="vpn-card-desc">${durText}</div>
        </div>
        <div class="vpn-card-footer">
          <span class="vpn-card-cost">${plan.cost_ab} AB</span>
          ${actionHtml}
        </div>
      </div>`;
    }).join('');
  }

  // FIX 6: Two-step purchase flow — Confirmation Modal → Purchase → Success Modal
  let _confirmModalPlan = null;

  function showVpnConfirmModal(plan) {
    _confirmModalPlan = plan;
    const fa = detectLang() === 'fa';
    const existing = document.getElementById('vpn-confirm-modal');
    if (existing) existing.remove();
    const currentBalance = _lastKnownBalance || 0;
    const costAb = plan.cost_ab || plan.costAb || 0;
    const afterBalance = currentBalance - costAb;
    const dur = plan.duration_fa || plan.duration_en || '';
    const modal = document.createElement('div');
    modal.id = 'vpn-confirm-modal';
    modal.className = 'daily-checkin-modal';
    modal.setAttribute('dir', fa ? 'rtl' : 'ltr');
    modal.innerHTML = `
      <div class="dcm-overlay" onclick="WalletApp.closeVpnConfirmModal()"></div>
      <div class="dcm-sheet vpn-confirm-sheet">
        <div class="dcm-header">
          <h3>${fa ? 'تأیید خرید' : 'Confirm Purchase'}</h3>
          <button class="dcm-close" onclick="WalletApp.closeVpnConfirmModal()" aria-label="Close">
            <svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
          </button>
        </div>
        <div class="vpn-confirm-body">
          <div class="vpn-confirm-icon">${_vpnIconSvg(36)}</div>
          <div class="vpn-confirm-title">VPN ${plan.gb}GB</div>
          ${dur ? `<div class="vpn-confirm-desc">${dur}</div>` : ''}
          <div class="vpn-confirm-row"><span>${fa ? 'قیمت:' : 'Price:'}</span><strong>${costAb} AB</strong></div>
          ${dur ? `<div class="vpn-confirm-row"><span>${fa ? 'مدت:' : 'Duration:'}</span><strong>${dur}</strong></div>` : ''}
          <div class="vpn-confirm-row"><span>${fa ? 'موجودی فعلی:' : 'Current:'}</span><strong>${formatNumber(currentBalance)} AB</strong></div>
          <div class="vpn-confirm-row ${afterBalance < 0 ? 'vpn-insufficient' : ''}"><span>${fa ? 'پس از خرید:' : 'After:'}</span><strong>${formatNumber(Math.max(0, afterBalance))} AB</strong></div>
          ${afterBalance < 0 ? `<div class="vpn-insufficient-warning">${fa ? 'موجودی کافی نیست' : 'Insufficient balance'}</div>` : ''}
        </div>
        <div class="vpn-confirm-actions">
          <button class="vpn-cancel-btn" onclick="WalletApp.closeVpnConfirmModal()">${fa ? 'انصراف' : 'Cancel'}</button>
          <button class="vpn-confirm-btn ${afterBalance < 0 ? 'disabled' : ''}" ${afterBalance < 0 ? 'disabled' : ''} onclick="WalletApp.executeVpnPurchase('${plan.id}')">${fa ? 'تأیید و خرید' : 'Confirm'}</button>
        </div>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));
    try { window.Telegram?.WebApp?.HapticFeedback?.impactOccurred('medium'); } catch (_) {}
  }

  function closeVpnConfirmModal() {
    const modal = document.getElementById('vpn-confirm-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 250);
  }

  async function purchaseVpn(planId) {
    // Step 1: show confirmation modal (NOT the purchase itself)
    const plan = _vpnPlansCache ? _vpnPlansCache.find(p => p.id === planId) : null;
    if (!plan) return;
    showVpnConfirmModal(plan);
  }

  async function executeVpnPurchase(planId) {
    closeVpnConfirmModal();
    if (_purchaseInFlight) return;
    _purchaseInFlight = true;
    const fa = detectLang() === 'fa';
    try {
      // FIX 5: Frontend sends ONLY plan_id — price/eligibility are
      // server-side authoritative (backend uses its own catalog price).
      const resp = await window.apiFetch('/api/rewards/vpn/purchase', {
        method: 'POST',
        body: JSON.stringify({ plan_id: planId }),
      });
      if (resp?.status === 'success' && resp.purchase) {
        showVpnSuccessModal(resp.purchase);
        // PART 10: use the AUTHORITATIVE balance from the server response
        // (not a frontend guess). Falls back to refreshWalletBalance() if
        // the server didn't return new_balance (e.g., idempotent path).
        if (typeof resp.new_balance === 'number') {
          _lastKnownBalance = resp.new_balance;
          const balEl = document.getElementById('wallet-balance-amount');
          if (balEl) balEl.textContent = resp.new_balance.toLocaleString('en-US');
        }
        // Always refresh from server as final source of truth
        refreshWalletBalance();
      } else if (resp?.code === 'DUPLICATE_PENDING') {
        showToast(fa ? 'شما یک درخواست در انتظار برای این پلن دارید. لطفاً منتظر بمانید.' : 'You already have a pending purchase for this plan.');
      } else if (resp?.code === 'PAYMENT_FAILED') {
        showToast(fa ? 'موجودی AB کافی نیست. ' + (resp.required_tokens || '') + ' AB لازم است.' : 'Insufficient AB balance.');
      } else if (resp?.code === 'PREMIUM_REQUIRED') {
        showToast(fa ? 'این پلن ویژه اعضای Premium است. لطفاً ابتدا ارتقا دهید.' : 'This plan requires Premium membership.');
      } else if (resp?.code === 'INVALID_PLAN') {
        showToast(fa ? 'پلن نامعتبر است.' : 'Invalid plan.');
      } else {
        showToast(resp?.message || (fa ? 'خطا در خرید. لطفاً دوباره تلاش کنید.' : 'Purchase failed. Please try again.'));
      }
    } catch (e) {
      showToast(fa ? 'خطا در برقراری ارتباط. لطفاً دوباره تلاش کنید.' : 'Connection error. Please try again.');
    } finally {
      _purchaseInFlight = false;
    }
  }

  function showVpnSuccessModal(purchase) {
    const fa = detectLang() === 'fa';
    const existing = document.getElementById('vpn-success-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'vpn-success-modal';
    modal.className = 'daily-checkin-modal';
    modal.setAttribute('dir', fa ? 'rtl' : 'ltr');
    modal.innerHTML = `
      <div class="dcm-overlay" onclick="WalletApp.closeVpnSuccessModal()"></div>
      <div class="dcm-sheet vpn-success-sheet">
        <div class="vpn-success-icon">
          <svg viewBox="0 0 24 24" width="48" height="48" fill="none" stroke="#22C55E" stroke-width="2.5">
            <circle cx="12" cy="12" r="10"/>
            <polyline points="8 12 11 15 16 9" stroke-width="3"/>
          </svg>
        </div>
        <div class="vpn-success-title">${fa ? 'خرید با موفقیت انجام شد' : 'Purchase Successful'}</div>
        <div class="vpn-success-product">
          <div class="vpn-success-product-icon">${_vpnIconSvg(24)}</div>
          <div>
            <div class="vpn-success-product-name">VPN ${purchase.vpn_gb}GB</div>
            <div class="vpn-success-product-cost">${purchase.cost_ab} AB ${fa ? 'پرداخت شد' : 'paid'}</div>
          </div>
        </div>
        <div class="vpn-success-tracking">
          <span class="tracking-label">${fa ? 'شماره پیگیری:' : 'Tracking ID:'}</span>
          <span class="tracking-value">${purchase.tracking_id || 'VPN-' + String(purchase.id).padStart(8, '0')}</span>
        </div>
        <div class="vpn-success-note">${fa ? 'درخواست شما ثبت شد. لینک اشتراک پس از آماده‌سازی ارسال می‌شود.' : 'Your request has been submitted. The subscription link will be sent after preparation.'}</div>
        <button class="vpn-success-close-btn" onclick="WalletApp.closeVpnSuccessModal()">${fa ? 'متوجه شدم' : 'Got it'}</button>
      </div>
    `;
    document.body.appendChild(modal);
    requestAnimationFrame(() => modal.classList.add('visible'));
    try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch (_) {}
  }

  function closeVpnSuccessModal() {
    const modal = document.getElementById('vpn-success-modal');
    if (!modal) return;
    modal.classList.remove('visible');
    setTimeout(() => modal.remove(), 250);
  }

  async function refreshWalletBalance() {
    try {
      const resp = await window.apiFetch('/api/wallet/balance');
      if (resp?.status === 'success') {
        _lastKnownBalance = Number(resp.balance) || 0;
        const el = document.getElementById('wallet-balance-amount');
        if (el) el.textContent = Number(resp.balance).toLocaleString('en-US');
      }
    } catch (_) {}
  }

  return {
    loadProfileCard,
    openWallet,
    closeWallet,
    refresh: loadWalletData,
    openDailyCheckinModal,
    renderVpnMarket,
    purchaseVpn,
    executeVpnPurchase,
    closeVpnConfirmModal,
    closeVpnSuccessModal,
    refreshWalletBalance,
    claimDaily: claimDailyRewardAPI,
    closeDailyCheckinModal,
    scrollToSection,
    _invalidateCache: invalidateWalletCache,
    _refreshWalletData: loadWalletData,
    _updateDailyCheckinCard,
    _startWeeklyCountdown,
    _stopWeeklyCountdown,
  };
})();

// Expose globally
window.WalletApp = WalletApp;

// Expose globally
window.WalletApp = WalletApp;

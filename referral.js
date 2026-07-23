// ============================================================
// Referral Center — Premium Frontend Logic (W-UI Quality Pass)
// IIFE pattern; mirrors WalletApp structure.
// Full FA/EN localization via RT(key). RTL aware.
// All API calls lazy (only when Referral Center opens).
// Design System: same as wallet.css (Dark + Gold + Tier-aware).
// ============================================================

const ReferralApp = (() => {
  // =============================================
  // State
  // =============================================
  let referralData = null;
  let leaderboardData = null;
  let historyOffset = 0;
  let historyLoading = false;
  let wheelStatus = null;
  let walletSummary = null; // for tier + league progress
  let _tokenLogo = null;

  // =============================================
  // Tier System (mirror of WalletApp — keeps single source of truth for colors)
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
  function getTierColor(name) { return TIER_DATA[getTierKey(name)].hex; }
  function getTierRgb(name) { return TIER_DATA[getTierKey(name)].rgb; }
  function displayTier(name) { return RT('tier_' + getTierKey(name)); }
  function applyTierVars(el, name) {
    if (!el) return;
    el.style.setProperty('--tier-color', getTierColor(name));
    el.style.setProperty('--tier-rgb', getTierRgb(name));
  }

  // =============================================
  // Helpers
  // =============================================
  function esc(str) {
    if (str == null) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

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
    if (diff < 0) return RT('just_now');
    if (diff < 60000) return RT('just_now');
    if (diff < 3600000) return `${Math.floor(diff / 60000)} ${RT('m_ago')}`;
    if (diff < 86400000) return `${Math.floor(diff / 3600000)} ${RT('h_ago')}`;
    if (diff < 604800000) return `${Math.floor(diff / 86400000)} ${RT('d_ago')}`;
    return d.toLocaleDateString('en-US', { month: 'short', day: 'numeric' });
  }

  function getTokenLogo() {
    if (_tokenLogo) return _tokenLogo;
    const img = document.querySelector('#wallet-preview-card .wallet-watermark img');
    if (img && img.src) { _tokenLogo = img.src; return _tokenLogo; }
    _tokenLogo = 'assets/token-logo.png';
    return _tokenLogo;
  }

  // ═══════════════════════════════════════════════════════════
  // LOCALIZATION (FA / EN)
  // ═══════════════════════════════════════════════════════════
  const FA = {
    referral_center: 'مرکز دعوت',
    brand_quote: 'AB Token Infinity — هر دعوت، آینده تو را می‌سازد',
    total_earned: 'کل پاداش‌های دریافتی',
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
    pending_rewards: 'در انتظار',
    lucky_wheel: 'گردونه شانس',
    available_spins: 'اسپین موجود',
    daily_spin: 'اسپین روزانه',
    premium_spin: 'اسپین ویژه',
    open_wheel: 'ورود به گردونه',
    claimed: 'دریافت شده',
    available: 'آماده',
    leaderboard: 'جدول رتبه‌بندی',
    view_full: 'مشاهده کامل',
    rank: 'رتبه',
    invites: 'دعوت',
    referral_history: 'تاریخچه دعوت‌ها',
    no_referrals: 'هنوز دعوتی ثبت نشده',
    start_inviting: 'با اشتراک لینک، دوستان خود را دعوت کنید',
    load_more: 'باز کردن بیشتر',
    joined: 'عضو شده',
    not_joined: 'در انتظار عضویت',
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
    wheel_coming: 'گردونه به‌زودی فعال می‌شود',
    last_prize: 'آخرین جایزه',
    just_now: 'لحظاتی پیش',
    m_ago: 'دقیقه پیش',
    h_ago: 'ساعت پیش',
    d_ago: 'روز پیش',
    missions: 'مأموریت‌های دعوت',
    achievements: 'دستاوردها',
    conversion_rate: 'نرخ تبدیل',
    invite_status: 'وضعیت دعوت',
    join_date: 'تاریخ عضویت',
    // League / Tier
    tier_bronze: 'برنز',
    tier_silver: 'نقره',
    tier_gold: 'طلایی',
    tier_platinum: 'پلاتین',
    tier_diamond: 'الماس',
    your_league: 'لیگ شما',
    progress_to: 'پیشرفت تا',
    max_tier: 'به بالاترین لیگ رسیدید',
    next_league: 'لیگ بعدی',
    // Missions
    mission_invite_first: 'اولین دعوت',
    mission_invite_first_desc: 'اولین دوست خود را دعوت کنید',
    mission_invite_5: '۵ دعوت موفق',
    mission_invite_5_desc: 'پنج دوست را دعوت کنید',
    mission_invite_10: '۱۰ دعوت موفق',
    mission_invite_10_desc: 'ده دوست را دعوت کنید',
    mission_earn_100: '۱۰۰ AB اول را کسب کنید',
    mission_earn_100_desc: 'از دعوت دوستان ۱۰۰ توکن کسب کنید',
    mission_locked: 'قفل شده',
    mission_progress: 'پیشرفت',
    mission_reward: 'پاداش',
    // Achievements
    ach_bronze_referrer: 'ارجاع‌دهنده برنزی',
    ach_bronze_referrer_desc: '۳ دعوت موفق',
    ach_silver_referrer: 'ارجاع‌دهنده نقره‌ای',
    ach_silver_referrer_desc: '۱۰ دعوت موفق',
    ach_gold_referrer: 'ارجاع‌دهنده طلایی',
    ach_gold_referrer_desc: '۲۵ دعوت موفق',
    ach_elite_ambassador: 'سفیر ویژه',
    ach_elite_ambassador_desc: '۱۰۰ دعوت موفق',
    // Empty states
    no_history_title: 'تاریخچه خالی است',
    no_history_desc: 'با اشتراک لینک دعوت، دوستان خود را به جمع ما اضافه کنید و پاداش بگیرید',
    no_leaderboard_title: 'هنوز رتبه‌ای ثبت نشده',
    no_leaderboard_desc: 'با دعوت بیشتر دوستان، خود را در صدر جدول قرار دهید',
    start_now: 'همین حالا شروع کنید',
    // Production-ready additions
    next_free_spin: 'اسپین رایگان بعدی',
    next_spin_in: 'اسپین بعدی در',
    hours: 'ساعت',
    minutes: 'دقیقه',
    seconds: 'ثانیه',
    spin_now: 'همین حالا بچرخان',
    no_spins_available: 'اسپینی موجود نیست',
    come_back_tomorrow: 'فردا برای اسپین رایگان برگردید',
    last_used: 'آخرین استفاده',
    link_uses: 'استفاده از لینک',
    never_used: 'هنوز استفاده نشده',
    show_qr: 'نمایش QR',
    hide_qr: 'پنهان کردن QR',
    invite_source: 'منبع دعوت',
    source_direct: 'مستقیم',
    source_campaign: 'کمپین',
    source_seasonal: 'فصلی',
    top_referrers: 'برترین ارجاع‌دهندگان',
    your_rank: 'رتبه شما',
    not_ranked: 'رتبه‌بندی نشده',
    reward_earned: 'پاداش کسب شده',
    view_all: 'مشاهده همه',
    spin_disabled: 'اسپین غیرفعال',
    premium_spins: 'اسپین‌های ویژه',
  };

  const EN = {
    referral_center: 'Referral Center',
    brand_quote: 'AB Token Infinity — Every Invite Builds Your Future',
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
    pending_rewards: 'Pending',
    lucky_wheel: 'Lucky Wheel',
    available_spins: 'Spins',
    daily_spin: 'Daily Spin',
    premium_spin: 'Premium Spin',
    open_wheel: 'Open Wheel',
    claimed: 'Claimed',
    available: 'Available',
    leaderboard: 'Leaderboard',
    view_full: 'View Full',
    rank: 'Rank',
    invites: 'invites',
    referral_history: 'Referral History',
    no_referrals: 'No referrals yet',
    start_inviting: 'Share your link to invite friends',
    load_more: 'Load More',
    joined: 'Joined',
    not_joined: 'Not joined',
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
    last_prize: 'Last prize',
    just_now: 'Just now',
    m_ago: 'm ago',
    h_ago: 'h ago',
    d_ago: 'd ago',
    missions: 'Referral Missions',
    achievements: 'Achievements',
    conversion_rate: 'Conversion Rate',
    invite_status: 'Invite Status',
    join_date: 'Join Date',
    tier_bronze: 'Bronze',
    tier_silver: 'Silver',
    tier_gold: 'Gold',
    tier_platinum: 'Platinum',
    tier_diamond: 'Diamond',
    your_league: 'Your League',
    progress_to: 'Progress to',
    max_tier: 'Max tier reached',
    next_league: 'Next League',
    mission_invite_first: 'First Invite',
    mission_invite_first_desc: 'Invite your first friend',
    mission_invite_5: '5 Successful Invites',
    mission_invite_5_desc: 'Invite five friends',
    mission_invite_10: '10 Successful Invites',
    mission_invite_10_desc: 'Invite ten friends',
    mission_earn_100: 'Earn First 100 AB',
    mission_earn_100_desc: 'Earn 100 tokens from referrals',
    mission_locked: 'Locked',
    mission_progress: 'Progress',
    mission_reward: 'Reward',
    ach_bronze_referrer: 'Bronze Referrer',
    ach_bronze_referrer_desc: '3 successful invites',
    ach_silver_referrer: 'Silver Referrer',
    ach_silver_referrer_desc: '10 successful invites',
    ach_gold_referrer: 'Gold Referrer',
    ach_gold_referrer_desc: '25 successful invites',
    ach_elite_ambassador: 'Elite Ambassador',
    ach_elite_ambassador_desc: '100 successful invites',
    no_history_title: 'History is empty',
    no_history_desc: 'Share your referral link, invite friends and start earning rewards',
    no_leaderboard_title: 'No rankings yet',
    no_leaderboard_desc: 'Invite more friends to climb the leaderboard',
    start_now: 'Start now',
    // Production-ready additions
    next_free_spin: 'Next free spin',
    next_spin_in: 'Next spin in',
    hours: 'h',
    minutes: 'm',
    seconds: 's',
    spin_now: 'Spin Now',
    no_spins_available: 'No spins available',
    come_back_tomorrow: 'Come back tomorrow for your free spin',
    last_used: 'Last used',
    link_uses: 'Link uses',
    never_used: 'Never used',
    show_qr: 'Show QR',
    hide_qr: 'Hide QR',
    invite_source: 'Invite Source',
    source_direct: 'Direct',
    source_campaign: 'Campaign',
    source_seasonal: 'Seasonal',
    top_referrers: 'Top Referrers',
    your_rank: 'Your Rank',
    not_ranked: 'Not ranked yet',
    reward_earned: 'Reward Earned',
    view_all: 'View All',
    spin_disabled: 'Spin Disabled',
    premium_spins: 'Premium Spins',
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
  // SVG ICONS (inline, consistent stroke width, matches wallet.js)
  // ═══════════════════════════════════════════════════════════
  const ICONS = {
    back: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 18 9 12 15 6"/></svg>',
    arrowRight: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>',
    users: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M17 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="9" cy="7" r="4"/><path d="M23 21v-2a4 4 0 0 0-3-3.87"/><path d="M16 3.13a4 4 0 0 1 0 7.75"/></svg>',
    gift: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    copy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="9" y="9" width="13" height="13" rx="2" ry="2"/><path d="M5 15H4a2 2 0 0 1-2-2V4a2 2 0 0 1 2-2h9a2 2 0 0 1 2 2v1"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    trophy: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M6 9H4.5a2.5 2.5 0 0 1 0-5H6"/><path d="M18 9h1.5a2.5 2.5 0 0 0 0-5H18"/><path d="M4 22h16"/><path d="M10 14.66V17c0 .55-.47.98-.97 1.21C7.85 18.75 7 20.24 7 22"/><path d="M14 14.66V17c0 .55.47.98.97 1.21C16.15 18.75 17 20.24 17 22"/><path d="M18 2H6v7a6 6 0 0 0 12 0V2Z"/></svg>',
    chart: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    checkCircle: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>',
    star: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 2L9.09 8.26 2 9.27l5.18 5.11L6 21.02 12 17.77l6 3.25-1.18-6.64L22 9.27l-7.09-1.01L12 2z"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 3l1.912 5.813L20 10l-5.18 2.18L12 18l-2.82-5.82L4 10l6.088-1.187L12 3z"/></svg>',
    wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>',
    qr: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="7" height="7" rx="1"/><rect x="14" y="3" width="7" height="7" rx="1"/><rect x="3" y="14" width="7" height="7" rx="1"/><line x1="14" y1="14" x2="14" y2="17"/><line x1="14" y1="20" x2="17" y2="20"/><line x1="20" y1="14" x2="20" y2="20"/><line x1="17" y1="14" x2="20" y2="14"/><line x1="14" y1="17" x2="17" y2="17"/></svg>',
    target: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    rocket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M4.5 16.5c-1.5 1.26-2 5-2 5s3.74-.5 5-2c.71-.84.7-2.13-.09-2.91a2.18 2.18 0 0 0-2.91-.09z"/><path d="M12 15l-3-3a22 22 0 0 1 2-3.95A12.88 12.88 0 0 1 22 2c0 2.72-.78 7.5-6 11a22.35 22.35 0 0 1-4 2z"/><path d="M9 12H4s.55-3.03 2-4c1.62-1.08 5 0 5 0"/><path d="M12 15v5s3.03-.55 4-2c1.08-1.62 0-5 0-5"/></svg>',
    shield: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M2 4l3 12h14l3-12-6 7-4-7-4 7-6-7zm3 16h14"/></svg>',
    medal: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="15" r="6"/><path d="M7 3l3 6 2-3 2 3 3-6"/></svg>',
    flame: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M8.5 14.5A2.5 2.5 0 0 0 11 12c0-1.38-.5-2-1-3-1.072-2.143-.224-4.054 2-6 .5 2.5 2 4.9 4 6.5 2 1.6 3 3.5 3 5.5a7 7 0 1 1-14 0c0-1.153.433-2.294 1-3a2.5 2.5 0 0 0 2.5 2.5z"/></svg>',
    userPlus: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M16 21v-2a4 4 0 0 0-4-4H5a4 4 0 0 0-4 4v2"/><circle cx="8.5" cy="7" r="4"/><line x1="20" y1="8" x2="20" y2="14"/><line x1="23" y1="11" x2="17" y2="11"/></svg>',
    coins: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="8" cy="8" r="6"/><path d="M18.09 10.37A6 6 0 1 1 10.34 18"/><path d="M7 6h1v4"/><path d="m16.71 13.88.7.71-2.82 2.82"/></svg>',
    trending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    eye: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>',
    qrExpand: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="15 3 21 3 21 9"/><polyline points="9 21 3 21 3 15"/><line x1="21" y1="3" x2="14" y2="10"/><line x1="3" y1="21" x2="10" y2="14"/></svg>',
    history: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M3 3v5h5"/><path d="M3.05 13A9 9 0 1 0 6 5.3L3 8"/><path d="M12 7v5l4 2"/></svg>',
    link: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M10 13a5 5 0 0 0 7.54.54l3-3a5 5 0 0 0-7.07-7.07l-1.72 1.71"/><path d="M14 11a5 5 0 0 0-7.54-.54l-3 3a5 5 0 0 0 7.07 7.07l1.71-1.71"/></svg>',
    hashtag: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><line x1="4" y1="9" x2="20" y2="9"/><line x1="4" y1="15" x2="20" y2="15"/><line x1="10" y1="3" x2="8" y2="21"/><line x1="16" y1="3" x2="14" y2="21"/></svg>',
    bolt: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><polygon points="13 2 3 14 12 14 11 22 21 10 12 10 13 2"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    spinDisabled: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="4.93" y1="4.93" x2="19.07" y2="19.07"/></svg>',
  };

  // ═══════════════════════════════════════════════════════════
  // API CALLS (lazy — only when Referral Center opens)
  // ═══════════════════════════════════════════════════════════
  async function fetchStats() {
    try {
      const data = await window.apiFetch('/api/referrals/stats');
      if (data && data.status === 'success') { referralData = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchStats error', e); }
    return null;
  }

  async function fetchLeaderboard() {
    try {
      const data = await window.apiFetch('/api/referrals/leaderboard?limit=10');
      if (data && data.status === 'success') { leaderboardData = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchLeaderboard error', e); }
    return null;
  }

  async function fetchHistory(offset = 0) {
    try {
      const data = await window.apiFetch(`/api/referrals/history?offset=${offset}&limit=20`);
      if (data && data.status === 'success') return data;
    } catch (e) { console.warn('ReferralApp: fetchHistory error', e); }
    return null;
  }

  async function fetchWheelStatus() {
    try {
      const data = await window.apiFetch('/api/wheel/status');
      if (data && data.status === 'success') { wheelStatus = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchWheelStatus error', e); }
    return null;
  }

  async function fetchBalance() {
    try {
      const data = await window.apiFetch('/api/wallet/balance');
      if (data && data.status === 'success') return data.balance || 0;
    } catch (e) { console.warn('ReferralApp: fetchBalance error', e); }
    return 0;
  }

  async function fetchWalletSummary() {
    try {
      const data = await window.apiFetch('/api/wallet/summary');
      if (data && data.status === 'success') { walletSummary = data; return data; }
    } catch (e) { console.warn('ReferralApp: fetchWalletSummary error', e); }
    return null;
  }

  async function fetchWheelHistory() {
    try {
      const data = await window.apiFetch('/api/wheel/history?offset=0&limit=1');
      if (data && data.status === 'success' && data.history?.length) return data.history[0];
    } catch (e) { /* silent */ }
    return null;
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
        <button class="rc-back-btn" aria-label="${esc(RT('back'))}">${ICONS.back}</button>
        <div class="rc-header-text"><h2>${esc(RT('referral_center'))}</h2></div>
      </div>
      <div class="rc-skeleton">
        <div class="rc-skel-hero">
          <div class="rc-skel-line h-xl w-50"></div>
          <div class="rc-skel-line w-30"></div>
          <div class="rc-skel-row"><div class="rc-skel-circle"></div><div class="rc-skel-line h-lg w-40"></div></div>
        </div>
        <div class="rc-skel-grid">
          <div class="rc-skel-card"></div><div class="rc-skel-card"></div>
          <div class="rc-skel-card"></div><div class="rc-skel-card"></div>
        </div>
        <div class="rc-skel-card h-tall"></div>
        <div class="rc-skel-grid">
          <div class="rc-skel-card h-tall"></div><div class="rc-skel-card h-tall"></div>
        </div>
        <div class="rc-skel-card h-tall"></div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // HERO (Premium — illustration, glow, gradient, animated bg, league badge, token icon, league progress)
  // ─────────────────────────────────────────────
  function buildHero(stats, balance, tierData) {
    const totalInvites = stats?.total || 0;
    const activeInvites = stats?.active || 0;
    const rewarded = stats?.rewarded || 0;
    const rewardPerInvite = stats?.reward_per_invite || 3;
    const totalEarned = (stats?.total_earned != null) ? stats.total_earned : (rewarded * rewardPerInvite);
    const conversionRate = totalInvites > 0 ? Math.round((activeInvites / totalInvites) * 100) : 0;

    const tier = tierData || { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };
    const tierKey = getTierKey(tier.current);
    const progressPct = tier.progress != null ? Math.max(0, Math.min(100, Number(tier.progress))) : 0;
    const progressText = tier.next
      ? `${Math.round(progressPct)}% ${RT('progress_to')} ${displayTier(tier.next)}`
      : RT('max_tier');

    return `
      <div class="rc-hero" data-tier="${tierKey}">
        <!-- Animated Background Layers -->
        <div class="rc-hero-bg-1"></div>
        <div class="rc-hero-bg-2"></div>
        <div class="rc-hero-orb rc-hero-orb-1"></div>
        <div class="rc-hero-orb rc-hero-orb-2"></div>
        <div class="rc-hero-grid"></div>

        <!-- Top Row: League Badge + Brand Mark -->
        <div class="rc-hero-top">
          <div class="rc-hero-league">
            <div class="rc-hero-league-icon" style="background:rgba(var(--tier-rgb),0.15);border-color:rgba(var(--tier-rgb),0.35);color:var(--tier-color)">
              ${ICONS.medal}
            </div>
            <div class="rc-hero-league-info">
              <div class="rc-hero-league-label">${esc(RT('your_league'))}</div>
              <div class="rc-hero-league-name" style="color:var(--tier-color)">${esc(displayTier(tier.current))}</div>
            </div>
          </div>
          <div class="rc-hero-illustration" aria-hidden="true">
            <svg viewBox="0 0 120 120" width="92" height="92" fill="none">
              <defs>
                <linearGradient id="rcHeroGrad" x1="0" y1="0" x2="1" y2="1">
                  <stop offset="0%" stop-color="#F5A623" stop-opacity="0.9"/>
                  <stop offset="100%" stop-color="#FFCC4D" stop-opacity="0.6"/>
                </linearGradient>
                <radialGradient id="rcHeroGlow" cx="50%" cy="50%" r="50%">
                  <stop offset="0%" stop-color="#F5A623" stop-opacity="0.4"/>
                  <stop offset="100%" stop-color="#F5A623" stop-opacity="0"/>
                </radialGradient>
              </defs>
              <circle cx="60" cy="60" r="58" fill="url(#rcHeroGlow)"/>
              <circle cx="60" cy="60" r="42" stroke="url(#rcHeroGrad)" stroke-width="1.5" stroke-dasharray="3 5" opacity="0.5">
                <animateTransform attributeName="transform" type="rotate" from="0 60 60" to="360 60 60" dur="40s" repeatCount="indefinite"/>
              </circle>
              <circle cx="60" cy="60" r="30" stroke="url(#rcHeroGrad)" stroke-width="1" opacity="0.4"/>
              <path d="M60 30 L67 50 L88 50 L71 63 L77 84 L60 72 L43 84 L49 63 L32 50 L53 50 Z" fill="url(#rcHeroGrad)" opacity="0.85"/>
              <circle cx="60" cy="60" r="6" fill="#FFF8E1"/>
            </svg>
          </div>
        </div>

        <!-- Total Earned with Token Icon -->
        <div class="rc-hero-earned">
          <div class="rc-hero-earned-label">${esc(RT('total_earned'))}</div>
          <div class="rc-hero-earned-row">
            <div class="rc-hero-token-logo"><img src="${getTokenLogo()}" alt="AB Token"></div>
            <div class="rc-hero-earned-value" data-countup="${totalEarned}">0</div>
            <div class="rc-hero-earned-ticker">AB</div>
          </div>
        </div>

        <!-- Stats Row -->
        <div class="rc-hero-stats">
          <div class="rc-hero-stat">
            <div class="rc-hero-stat-icon" style="color:var(--tier-color)">${ICONS.users}</div>
            <div class="rc-hero-stat-value" data-countup="${totalInvites}">0</div>
            <div class="rc-hero-stat-label">${esc(RT('total_invites'))}</div>
          </div>
          <div class="rc-hero-stat-divider"></div>
          <div class="rc-hero-stat">
            <div class="rc-hero-stat-icon rc-color-green">${ICONS.checkCircle}</div>
            <div class="rc-hero-stat-value" data-countup="${activeInvites}">0</div>
            <div class="rc-hero-stat-label">${esc(RT('active_invites'))}</div>
          </div>
          <div class="rc-hero-stat-divider"></div>
          <div class="rc-hero-stat">
            <div class="rc-hero-stat-icon rc-color-gold">${ICONS.trending}</div>
            <div class="rc-hero-stat-value">${conversionRate}%</div>
            <div class="rc-hero-stat-label">${esc(RT('conversion_rate'))}</div>
          </div>
        </div>

        <!-- League Progress -->
        <div class="rc-hero-progress">
          <div class="rc-hero-progress-info">
            <span class="rc-hero-progress-text">${esc(progressText)}</span>
            ${tier.next ? `<span class="rc-hero-progress-next">${esc(displayTier(tier.next))} ${ICONS.arrowRight}</span>` : ''}
          </div>
          <div class="rc-hero-progress-bar">
            <div class="rc-hero-progress-fill" style="width:0%;background:linear-gradient(90deg,var(--tier-color),var(--rc-accent-2))" data-target="${progressPct}"></div>
          </div>
        </div>

        <!-- Actions -->
        <div class="rc-hero-actions">
          <button class="rc-hero-btn rc-hero-btn-primary" onclick="ReferralApp.shareLink()">
            ${ICONS.share}<span>${esc(RT('share_link'))}</span>
          </button>
          <button class="rc-hero-btn rc-hero-btn-secondary" onclick="ReferralApp.copyLink()">
            ${ICONS.copy}<span>${esc(RT('copy_link'))}</span>
          </button>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // LINK CARD
  // ─────────────────────────────────────────────
  function buildLinkCard(link, stats) {
    const linkUses = stats?.total || 0;
    const lastUsed = stats?.last_referral_at;
    const hasActivity = linkUses > 0;

    return `
      <div class="rc-section">
        <div class="rc-link-card">
          <div class="rc-link-main">
            <div class="rc-link-icon-wrap">
              <div class="rc-link-icon-glow"></div>
              <div class="rc-link-icon">${ICONS.link}</div>
            </div>
            <div class="rc-link-info">
              <div class="rc-link-label">${esc(RT('referral_link'))}</div>
              <input type="text" id="rc-ref-link" class="rc-link-input" readonly value="${esc(link)}">
              <div class="rc-link-meta">
                <span class="rc-link-meta-item ${hasActivity ? 'rc-link-meta-active' : ''}">
                  ${ICONS.eye}<span>${formatNumber(linkUses)} ${esc(RT('link_uses'))}</span>
                </span>
                <span class="rc-link-meta-divider"></span>
                <span class="rc-link-meta-item">
                  ${ICONS.clock}<span>${hasActivity ? esc(formatTime(lastUsed)) : esc(RT('never_used'))}</span>
                </span>
              </div>
            </div>
          </div>
          <div class="rc-link-actions">
            <button class="rc-link-action-btn" onclick="ReferralApp.copyLink()" aria-label="${esc(RT('copy'))}" title="${esc(RT('copy'))}">
              ${ICONS.copy}
            </button>
            <button class="rc-link-action-btn" onclick="ReferralApp.shareLink()" aria-label="${esc(RT('share'))}" title="${esc(RT('share'))}">
              ${ICONS.share}
            </button>
            <button class="rc-link-action-btn rc-link-action-qr" onclick="ReferralApp.toggleQR()" aria-label="${esc(RT('show_qr'))}" title="${esc(RT('show_qr'))}">
              ${ICONS.qr}
            </button>
          </div>
        </div>
        <div id="rc-qr-panel" class="rc-qr-panel">
          <div class="rc-qr-card">
            <div class="rc-qr-header">
              <div class="rc-qr-title">${ICONS.qr}<span>${esc(RT('scan_qr'))}</span></div>
              <button class="rc-qr-close" onclick="ReferralApp.toggleQR()" aria-label="${esc(RT('hide_qr'))}">${ICONS.back}</button>
            </div>
            <div class="rc-qr-image" id="rc-qr-image"></div>
            <div class="rc-qr-desc">${esc(RT('scan_qr'))}</div>
          </div>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // STATS GRID
  // ─────────────────────────────────────────────
  function buildStatsGrid(stats) {
    const total = stats?.total || 0;
    const active = stats?.active || 0;
    const rewarded = stats?.rewarded || 0;
    const pending = stats?.pending || 0;

    return `
      <div class="rc-section">
        <div class="rc-stats-grid">
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-blue">${ICONS.users}</div>
            <div class="rc-stat-value" data-countup="${total}">0</div>
            <div class="rc-stat-label">${esc(RT('total_invite_count'))}</div>
          </div>
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-green">${ICONS.checkCircle}</div>
            <div class="rc-stat-value" data-countup="${active}">0</div>
            <div class="rc-stat-label">${esc(RT('active_invites'))}</div>
          </div>
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-gold">${ICONS.gift}</div>
            <div class="rc-stat-value" data-countup="${rewarded}">0</div>
            <div class="rc-stat-label">${esc(RT('rewards_earned'))}</div>
          </div>
          <div class="rc-stat-card">
            <div class="rc-stat-icon rc-stat-icon-orange">${ICONS.clock}</div>
            <div class="rc-stat-value" data-countup="${pending}">0</div>
            <div class="rc-stat-label">${esc(RT('pending_rewards'))}</div>
          </div>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // LUCKY WHEEL (Premium special card — production ready)
  // ─────────────────────────────────────────────
  function buildWheelCard(wheel, lastPrize) {
    const totalAvailable = wheel?.total_available || 0;
    const dailyAvail = wheel?.daily_spin?.available;
    const premiumCount = wheel?.premium_spins || 0;
    const hasSpins = totalAvailable > 0;

    let statusHtml = '';
    if (dailyAvail) {
      statusHtml = `<span class="rc-wheel-dot rc-wheel-dot-active"></span>${esc(RT('spin_available'))}`;
    } else if (hasSpins) {
      statusHtml = `<span class="rc-wheel-dot rc-wheel-dot-premium"></span>${esc(RT('premium_spins'))}: ${premiumCount}`;
    } else {
      statusHtml = `<span class="rc-wheel-dot rc-wheel-dot-claimed"></span>${esc(RT('no_spins_available'))}`;
    }

    const enterBtnHtml = hasSpins
      ? `<button class="rc-wheel-enter-btn">${ICONS.bolt}<span>${esc(RT('spin_now'))}</span></button>`
      : `<button class="rc-wheel-enter-btn rc-wheel-enter-disabled" disabled>${ICONS.spinDisabled}<span>${esc(RT('spin_disabled'))}</span></button>`;

    const cardClasses = hasSpins ? 'rc-wheel-card' : 'rc-wheel-card rc-wheel-card-disabled';

    return `
      <div class="rc-section">
        <div class="${cardClasses}" onclick="${hasSpins ? "ReferralApp.openWheel()" : "event.preventDefault()"}" role="button" tabindex="${hasSpins ? '0' : '-1'}" aria-disabled="${!hasSpins}">
          <div class="rc-wheel-glow"></div>
          <div class="rc-wheel-left">
            <div class="rc-wheel-icon-spin">${hasSpins ? ICONS.wheel : ICONS.spinDisabled}</div>
          </div>
          <div class="rc-wheel-info">
            <div class="rc-wheel-title">${esc(RT('lucky_wheel'))}</div>
            <div class="rc-wheel-status">${statusHtml}</div>
            <div class="rc-wheel-chips">
              <span class="rc-wheel-chip ${dailyAvail ? 'rc-chip-active' : ''}">
                ${ICONS.clock}<span>${esc(RT('daily_spin'))}</span>
              </span>
              <span class="rc-wheel-chip ${premiumCount > 0 ? 'rc-chip-premium' : ''}">
                ${ICONS.sparkles}<span>${esc(RT('premium_spin'))}: ${premiumCount}</span>
              </span>
            </div>
            ${lastPrize ? `
              <div class="rc-wheel-last-prize">
                ${ICONS.gift}<span>${esc(RT('last_prize'))}: <strong>+${formatNumber(lastPrize.reward_amount || 0)} AB</strong></span>
              </div>` : ''}
            ${!hasSpins ? `
              <div class="rc-wheel-countdown" id="rc-wheel-countdown">
                ${ICONS.clock}<span>${esc(RT('next_free_spin'))}:</span>
                <span class="rc-wheel-countdown-time" id="rc-wheel-countdown-time">--:--:--</span>
              </div>` : ''}
          </div>
          <div class="rc-wheel-right">
            <div class="rc-wheel-spins">
              <span class="rc-wheel-spins-num">${totalAvailable}</span>
              <small>${esc(RT('available_spins'))}</small>
            </div>
            ${enterBtnHtml}
          </div>
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // LEADERBOARD — Top 10 with special top-3 styling
  // ─────────────────────────────────────────────
  function buildLeaderboard(leaderboard) {
    if (!leaderboard?.leaderboard?.length) {
      return `
        <div class="rc-section">
          <div class="rc-section-header"><h3>${ICONS.trophy} ${esc(RT('leaderboard'))}</h3></div>
          ${buildEmptyState('leaderboard', ICONS.trophy, RT('no_leaderboard_title'), RT('no_leaderboard_desc'))}
        </div>
      `;
    }

    const all = leaderboard.leaderboard;
    const top3 = all.slice(0, 3);
    const rest = all.slice(3, 10);
    const crownColors = ['#FFD700', '#C0C0C0', '#CD7F32'];
    const currentUserId = String(window.UserContext?.user?.id || window.getTelegramUser?.()?.id || '');

    // Check if current user is in the list
    const currentUserEntry = all.find(u => String(u.user_id) === currentUserId);

    return `
      <div class="rc-section">
        <div class="rc-section-header">
          <h3>${ICONS.trophy} ${esc(RT('top_referrers'))}</h3>
        </div>

        ${top3.length > 0 ? `
        <div class="rc-lb-podium">
          ${[1, 0, 2].map(podiumIdx => {
            if (!top3[podiumIdx]) return '<div class="rc-lb-podium-slot rc-lb-podium-empty"></div>';
            const u = top3[podiumIdx];
            const rank = podiumIdx + 1;
            const color = crownColors[podiumIdx];
            const isCurrentUser = String(u.user_id) === currentUserId;
            return `
              <div class="rc-lb-podium-slot rc-lb-podium-${rank} ${isCurrentUser ? 'rc-lb-podium-me' : ''}" style="--rank-color:${color}">
                ${rank === 1 ? `<div class="rc-lb-podium-crown">${ICONS.crown}</div>` : ''}
                <div class="rc-lb-podium-avatar" style="border-color:${color}">${esc((u.first_name || u.username || '?').charAt(0).toUpperCase())}</div>
                <div class="rc-lb-podium-name">${esc((u.first_name || u.username || 'User').substring(0, 12))}</div>
                <div class="rc-lb-podium-count" style="color:${color}">${formatNumber(u.total_invites)}</div>
                <div class="rc-lb-podium-label">${esc(RT('invites'))}</div>
                <div class="rc-lb-podium-rank" style="background:${color}">${rank}</div>
              </div>
            `;
          }).join('')}
        </div>` : ''}

        ${rest.length > 0 ? `
        <div class="rc-lb-list">
          ${rest.map((u, i) => {
            const rank = i + 4;
            const isCurrentUser = String(u.user_id) === currentUserId;
            return `
              <div class="rc-lb-row ${isCurrentUser ? 'rc-lb-row-me' : ''}">
                <div class="rc-lb-row-rank">${rank}</div>
                <div class="rc-lb-row-avatar">${esc((u.first_name || u.username || '?').charAt(0).toUpperCase())}</div>
                <div class="rc-lb-row-info">
                  <div class="rc-lb-row-name">${esc(u.first_name || u.username || 'User')}</div>
                  <div class="rc-lb-row-sub">${formatNumber(u.total_invites)} ${esc(RT('invites'))} · ${formatNumber(u.rewarded_invites || 0)} ${esc(RT('rewarded'))}</div>
                </div>
                <div class="rc-lb-row-badge">${formatNumber(u.total_invites)}</div>
              </div>
            `;
          }).join('')}
        </div>` : ''}

        ${!currentUserEntry ? `
        <div class="rc-lb-your-rank">
          ${ICONS.target}
          <div class="rc-lb-your-rank-info">
            <div class="rc-lb-your-rank-label">${esc(RT('your_rank'))}</div>
            <div class="rc-lb-your-rank-value">${esc(RT('not_ranked'))}</div>
          </div>
          <button class="rc-lb-share-btn" onclick="ReferralApp.shareLink()">${ICONS.share}<span>${esc(RT('share_link'))}</span></button>
        </div>` : ''}
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // MISSIONS (real mission cards — locked state)
  // ─────────────────────────────────────────────
  function buildMissions(stats) {
    const totalInvites = stats?.total || 0;
    const totalEarned = stats?.total_earned || 0;
    const rewardPerInvite = stats?.reward_per_invite || 3;

    const missions = [
      { id: 'first', icon: ICONS.userPlus, title: RT('mission_invite_first'), desc: RT('mission_invite_first_desc'),
        current: Math.min(totalInvites, 1), target: 1, reward: rewardPerInvite * 1 },
      { id: 'five', icon: ICONS.users, title: RT('mission_invite_5'), desc: RT('mission_invite_5_desc'),
        current: Math.min(totalInvites, 5), target: 5, reward: rewardPerInvite * 5 },
      { id: 'ten', icon: ICONS.rocket, title: RT('mission_invite_10'), desc: RT('mission_invite_10_desc'),
        current: Math.min(totalInvites, 10), target: 10, reward: rewardPerInvite * 10 },
      { id: 'earn100', icon: ICONS.coins, title: RT('mission_earn_100'), desc: RT('mission_earn_100_desc'),
        current: Math.min(totalEarned, 100), target: 100, reward: 50 },
    ];

    return `
      <div class="rc-section">
        <div class="rc-section-header"><h3>${ICONS.target} ${esc(RT('missions'))}</h3></div>
        <div class="rc-missions-grid">
          ${missions.map((m, idx) => {
            const isComplete = m.current >= m.target;
            const progressPct = Math.min(100, (m.current / m.target) * 100);
            return `
              <div class="rc-mission-card ${isComplete ? 'rc-mission-done' : ''}" style="animation-delay:${0.05 * idx}s">
                <div class="rc-mission-top">
                  <div class="rc-mission-icon ${isComplete ? 'rc-mission-icon-done' : 'rc-mission-icon-locked'}">
                    ${isComplete ? ICONS.checkCircle : m.icon}
                  </div>
                  ${isComplete ? '' : `<div class="rc-mission-lock">${ICONS.lock}</div>`}
                </div>
                <div class="rc-mission-title">${esc(m.title)}</div>
                <div class="rc-mission-desc">${esc(m.desc)}</div>
                <div class="rc-mission-progress">
                  <div class="rc-mission-progress-bar">
                    <div class="rc-mission-progress-fill" style="width:${progressPct}%;background:${isComplete ? 'linear-gradient(90deg,#22C55E,#16A34A)' : 'linear-gradient(90deg,#F5A623,#FFCC4D)'}"></div>
                  </div>
                  <div class="rc-mission-progress-text">
                    <span>${m.current}/${m.target}</span>
                    <span class="rc-mission-reward">${ICONS.gift} +${m.reward} AB</span>
                  </div>
                </div>
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // ACHIEVEMENTS (real badges — locked/unlocked state)
  // ─────────────────────────────────────────────
  function buildAchievements(stats) {
    const totalInvites = stats?.total || 0;

    const badges = [
      { id: 'bronze', tier: 'bronze', icon: ICONS.medal,
        title: RT('ach_bronze_referrer'), desc: RT('ach_bronze_referrer_desc'), threshold: 3 },
      { id: 'silver', tier: 'silver', icon: ICONS.shield,
        title: RT('ach_silver_referrer'), desc: RT('ach_silver_referrer_desc'), threshold: 10 },
      { id: 'gold', tier: 'gold', icon: ICONS.crown,
        title: RT('ach_gold_referrer'), desc: RT('ach_gold_referrer_desc'), threshold: 25 },
      { id: 'elite', tier: 'diamond', icon: ICONS.flame,
        title: RT('ach_elite_ambassador'), desc: RT('ach_elite_ambassador_desc'), threshold: 100 },
    ];

    return `
      <div class="rc-section">
        <div class="rc-section-header"><h3>${ICONS.sparkles} ${esc(RT('achievements'))}</h3></div>
        <div class="rc-achievements-grid">
          ${badges.map((b, idx) => {
            const isUnlocked = totalInvites >= b.threshold;
            const tierColor = getTierColor(b.tier);
            const tierRgb = getTierRgb(b.tier);
            return `
              <div class="rc-ach-card ${isUnlocked ? 'rc-ach-unlocked' : 'rc-ach-locked'}"
                   style="--ach-color:${tierColor};--ach-rgb:${tierRgb};animation-delay:${0.05 * idx}s">
                <div class="rc-ach-medal-wrap">
                  <div class="rc-ach-medal-glow"></div>
                  <div class="rc-ach-medal">${b.icon}</div>
                  ${isUnlocked ? '' : `<div class="rc-ach-lock">${ICONS.lock}</div>`}
                </div>
                <div class="rc-ach-title">${esc(b.title)}</div>
                <div class="rc-ach-desc">${esc(b.desc)}</div>
                ${isUnlocked
                  ? `<div class="rc-ach-status rc-ach-unlocked-text">${ICONS.check} ${esc(RT('claimed'))}</div>`
                  : `<div class="rc-ach-status rc-ach-locked-text">${esc(RT('mission_locked'))} · ${b.threshold}+</div>`}
              </div>
            `;
          }).join('')}
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // HISTORY ITEM (rich: avatar, username, join date, reward, status badge, invite source, animation)
  // ─────────────────────────────────────────────
  function buildHistoryItem(ref, idx) {
    const avatar = (ref.invitee_first_name || ref.invitee_username || '?').charAt(0).toUpperCase();
    const name = ref.invitee_first_name || ref.invitee_username || ('User ' + (ref.invitee_id || ''));
    const username = ref.invitee_username ? '@' + ref.invitee_username : null;
    const isJoined = ref.channel_verified;
    const isRewarded = ref.rewarded;
    const rewardPerInvite = referralData?.reward_per_invite || 3;
    const source = ref.source || 'direct';
    const sourceLabel = RT('source_' + source) || RT('source_direct');

    let statusBadge = '';
    let statusClass = '';
    if (isRewarded) {
      statusBadge = `<span class="rc-hist-badge rc-hist-badge-rewarded">${ICONS.check} ${esc(RT('rewarded'))}</span>`;
      statusClass = 'rc-hist-state-rewarded';
    } else if (isJoined) {
      statusBadge = `<span class="rc-hist-badge rc-hist-badge-pending">${ICONS.clock} ${esc(RT('pending'))}</span>`;
      statusClass = 'rc-hist-state-pending';
    } else {
      statusBadge = `<span class="rc-hist-badge rc-hist-badge-notjoined">${ICONS.clock} ${esc(RT('not_joined'))}</span>`;
      statusClass = 'rc-hist-state-notjoined';
    }

    const rewardBadge = isRewarded
      ? `<div class="rc-hist-reward"><img src="${getTokenLogo()}" alt="" class="rc-hist-reward-logo">+${rewardPerInvite} <span>AB</span></div>`
      : `<div class="rc-hist-reward rc-hist-reward-pending">+${rewardPerInvite} <span>AB</span></div>`;

    return `
      <div class="rc-hist-item ${statusClass}" style="animation-delay:${Math.min(idx * 0.04, 0.4)}s">
        <div class="rc-hist-avatar">${esc(avatar)}</div>
        <div class="rc-hist-info">
          <div class="rc-hist-name-row">
            <span class="rc-hist-name">${esc(name)}</span>
            ${username ? `<span class="rc-hist-username">${esc(username)}</span>` : ''}
          </div>
          <div class="rc-hist-meta">
            <span class="rc-hist-date">${ICONS.clock}<span>${esc(formatTime(ref.created_at))}</span></span>
            <span class="rc-hist-source">${ICONS.hashtag}<span>${esc(sourceLabel)}</span></span>
          </div>
        </div>
        <div class="rc-hist-badges">
          ${statusBadge}
          ${rewardBadge}
        </div>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // EMPTY STATE (with custom illustration)
  // ─────────────────────────────────────────────
  function buildEmptyState(type, icon, title, desc) {
    return `
      <div class="rc-empty-state rc-empty-${type}">
        <div class="rc-empty-illustration">
          <div class="rc-empty-orb"></div>
          <div class="rc-empty-orb rc-empty-orb-2"></div>
          <div class="rc-empty-icon">${icon}</div>
        </div>
        <h4>${esc(title)}</h4>
        <p>${esc(desc)}</p>
        <button class="rc-empty-cta" onclick="ReferralApp.copyLink()">${ICONS.share} ${esc(RT('start_now'))}</button>
      </div>
    `;
  }

  // ─────────────────────────────────────────────
  // MAIN PAGE BUILD
  // ─────────────────────────────────────────────
  function buildPage(data) {
    const { stats, balance, leaderboard, wheel, history, historyHasMore, lastPrize, tier } = data;
    const link = getReferralLink();

    return `
      <!-- Header -->
      <div class="rc-header">
        <button class="rc-back-btn" onclick="ReferralApp.closeReferral()" aria-label="${esc(RT('back'))}">${ICONS.back}</button>
        <div class="rc-header-text">
          <h2>${esc(RT('referral_center'))}</h2>
        </div>
        <div class="rc-header-spacer"></div>
      </div>

      <!-- Brand Quote (official AB Token Infinity slogan) -->
      <div class="rc-brand-quote">
        <div class="rc-brand-quote-line"></div>
        <p>${esc(RT('brand_quote'))}</p>
        <div class="rc-brand-quote-line"></div>
      </div>

      <!-- Hero -->
      ${buildHero(stats, balance, tier)}

      <!-- Link -->
      ${buildLinkCard(link, stats)}

      <!-- Stats Grid -->
      ${buildStatsGrid(stats)}

      <!-- Lucky Wheel -->
      ${buildWheelCard(wheel, lastPrize)}

      <!-- Leaderboard -->
      ${buildLeaderboard(leaderboard)}

      <!-- Missions -->
      ${buildMissions(stats)}

      <!-- Achievements -->
      ${buildAchievements(stats)}

      <!-- History -->
      <div class="rc-section">
        <div class="rc-section-header"><h3>${ICONS.clock} ${esc(RT('referral_history'))}</h3></div>
        <div id="rc-history-list" class="rc-history-list">
          ${history && history.length > 0
            ? history.map((r, i) => buildHistoryItem(r, i)).join('')
            : buildEmptyState('history', ICONS.userPlus, RT('no_history_title'), RT('no_history_desc'))}
        </div>
        ${historyHasMore ? `
          <div id="rc-load-more" class="rc-load-more-wrap">
            <button class="rc-load-more-btn" onclick="ReferralApp.loadMoreHistory()">${esc(RT('load_more'))}</button>
          </div>` : ''}
      </div>

      <!-- Footer Spacer for safe area -->
      <div class="rc-footer-spacer"></div>
    `;
  }

  // ═══════════════════════════════════════════════════════════
  // MICRO ANIMATIONS
  // ═══════════════════════════════════════════════════════════
  function animateCountUp(el, target, duration = 900) {
    if (!el) return;
    const start = 0;
    const startTime = performance.now();
    const isInt = Number.isInteger(target);

    function step(now) {
      const elapsed = now - startTime;
      const t = Math.min(1, elapsed / duration);
      // easeOutCubic
      const eased = 1 - Math.pow(1 - t, 3);
      const value = start + (target - start) * eased;
      el.textContent = isInt ? formatNumber(Math.round(value)) : value.toFixed(2);
      if (t < 1) requestAnimationFrame(step);
      else el.textContent = formatNumber(target);
    }
    requestAnimationFrame(step);
  }

  function runEntryAnimations() {
    // Count-up numbers
    document.querySelectorAll('[data-countup]').forEach(el => {
      const target = Number(el.getAttribute('data-countup')) || 0;
      if (target > 0) animateCountUp(el, target);
      else el.textContent = '0';
    });

    // Progress bars
    requestAnimationFrame(() => {
      document.querySelectorAll('[data-target]').forEach(el => {
        const pct = Number(el.getAttribute('data-target')) || 0;
        el.style.width = `${pct}%`;
      });
    });
  }

  // ═══════════════════════════════════════════════════════════
  // RENDER
  // ═══════════════════════════════════════════════════════════
  let _wheelCountdownTimer = null;

  function startWheelCountdown() {
    if (_wheelCountdownTimer) clearInterval(_wheelCountdownTimer);
    const timeEl = document.getElementById('rc-wheel-countdown-time');
    if (!timeEl) return;

    function updateCountdown() {
      // Next free spin = midnight local time (24h cycle for daily spin)
      const now = new Date();
      const tomorrow = new Date(now);
      tomorrow.setHours(24, 0, 0, 0);
      const diff = tomorrow - now;

      const h = Math.floor(diff / 3600000);
      const m = Math.floor((diff % 3600000) / 60000);
      const s = Math.floor((diff % 60000) / 1000);

      timeEl.textContent = `${String(h).padStart(2, '0')}:${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
    }
    updateCountdown();
    _wheelCountdownTimer = setInterval(updateCountdown, 1000);
  }

  function stopWheelCountdown() {
    if (_wheelCountdownTimer) {
      clearInterval(_wheelCountdownTimer);
      _wheelCountdownTimer = null;
    }
  }

  function renderPage(data) {
    const page = document.getElementById('referral-full-page');
    if (!page) return;

    // Apply tier vars on the page wrapper for tier-aware coloring
    applyTierVars(page, data.tier?.current || 'Bronze');

    page.innerHTML = buildPage(data);

    // Run entry animations after paint
    requestAnimationFrame(() => {
      runEntryAnimations();
      // Start countdown timer if wheel has no spins
      const wheelCountdown = document.getElementById('rc-wheel-countdown');
      if (wheelCountdown) startWheelCountdown();
    });
  }

  // ═══════════════════════════════════════════════════════════
  // PUBLIC ACTIONS
  // ═══════════════════════════════════════════════════════════
  function openReferral() {
    const page = document.getElementById('referral-full-page');
    if (!page) return;
    applyDir(page);
    applyTierVars(page, 'Bronze'); // default until summary loads
    page.innerHTML = buildSkeleton();
    page.classList.add('open');
    document.body.style.overflow = 'hidden';

    // Load all data in parallel
    (async () => {
      const [stats, balance, leaderboard, wheel, historyRes, summary, lastPrize] = await Promise.all([
        fetchStats(),
        fetchBalance(),
        fetchLeaderboard(),
        fetchWheelStatus(),
        fetchHistory(0),
        fetchWalletSummary(),
        fetchWheelHistory(),
      ]);

      const tier = summary?.tier || { current: 'Bronze', next: 'Silver', progress: 0, remaining: 1000 };

      const data = {
        stats: stats || { total: 0, active: 0, rewarded: 0, pending: 0, reward_per_invite: 3, total_earned: 0 },
        balance: balance || 0,
        leaderboard: leaderboard || { leaderboard: [] },
        wheel: wheel || { daily_spin: { available: false }, total_available: 0, premium_spins: 0 },
        history: historyRes?.referrals || [],
        historyHasMore: historyRes?.hasMore || false,
        lastPrize: lastPrize || null,
        tier,
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
    // Stop countdown to prevent memory leak
    stopWheelCountdown();
  }

  function copyLink() {
    const input = document.getElementById('rc-ref-link');
    let link = input?.value || getReferralLink();
    if (!link) return;
    try { navigator.clipboard.writeText(link); } catch (e) {
      if (input) { input.select(); document.execCommand('copy'); }
    }
    // Visual feedback on copy button (first action button in link card)
    const copyBtn = document.querySelector('.rc-link-actions .rc-link-action-btn');
    if (copyBtn) {
      const originalHTML = copyBtn.innerHTML;
      copyBtn.classList.add('rc-link-action-success');
      copyBtn.innerHTML = ICONS.check;
      setTimeout(() => {
        copyBtn.classList.remove('rc-link-action-success');
        copyBtn.innerHTML = originalHTML;
      }, 1400);
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

  function toggleQR() {
    const panel = document.getElementById('rc-qr-panel');
    if (!panel) return;
    const isOpen = panel.classList.toggle('open');
    if (isOpen) {
      // Generate QR code using an inline SVG approach (lightweight, no external service)
      const link = getReferralLink();
      const qrImage = document.getElementById('rc-qr-image');
      if (qrImage && link) {
        // Use a public QR API via img tag (no external script dependency)
        qrImage.innerHTML = `<img src="https://api.qrserver.com/v1/create-qr-code/?size=200x200&bgcolor=0B1220&color=F5A623&data=${encodeURIComponent(link)}" alt="QR Code" onerror="this.style.display='none'">`;
      }
    }
  }

  function openWheel() {
    // Wheel UI will open in next phase — for now show informative popup
    const tg = window.getTg?.();
    const available = wheelStatus?.daily_spin?.available;
    const totalAvail = wheelStatus?.total_available || 0;
    let msg;
    if (available) msg = RT('spin_available');
    else if (totalAvail > 0) msg = `${RT('premium_spins')}: ${totalAvail}`;
    else msg = RT('come_back_tomorrow');
    tg?.showPopup?.({
      title: RT('lucky_wheel'),
      message: msg,
      buttons: [{ type: 'ok' }],
    });
  }

  async function loadMoreHistory() {
    if (historyLoading) return;
    historyLoading = true;
    const btn = document.querySelector('#rc-load-more button');
    if (btn) { btn.textContent = RT('loading'); btn.disabled = true; }

    const result = await fetchHistory(historyOffset);
    if (result && result.referrals?.length > 0) {
      const list = document.getElementById('rc-history-list');
      const empty = list?.querySelector('.rc-empty-state');
      if (empty) empty.remove();
      const html = result.referrals.map((r, i) => buildHistoryItem(r, i + historyOffset)).join('');
      list?.insertAdjacentHTML('beforeend', html);
      historyOffset += result.referrals.length;

      if (!result.hasMore) {
        const loadMore = document.getElementById('rc-load-more');
        if (loadMore) loadMore.remove();
      }
    } else {
      // No more results — remove load more
      const loadMore = document.getElementById('rc-load-more');
      if (loadMore) loadMore.remove();
    }

    if (btn) { btn.textContent = RT('load_more'); btn.disabled = false; }
    historyLoading = false;
  }

  function viewFullLeaderboard() {
    const tg = window.getTg?.();
    tg?.showPopup?.({ title: RT('leaderboard'), message: RT('loading'), buttons: [{ type: 'ok' }] });
  }

  return {
    openReferral,
    closeReferral,
    copyLink,
    shareLink,
    toggleQR,
    openWheel,
    loadMoreHistory,
    viewFullLeaderboard,
  };
})();

window.ReferralApp = ReferralApp;

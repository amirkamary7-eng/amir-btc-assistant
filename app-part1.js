// =========================================================================
// بخش ۱: راه‌اندازی ابزارهای اولیه و تلگرام (Telegram WebApp Init)
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

// =========================================================================
// بخش ۲: متغیرهای ثابت، آدرس‌ها و ارایه‌ها (Constants & States)
// =========================================================================
const MY_TELEGRAM_CHANNEL = "amir_btc_2024"; 
const BACKEND_URL = "https://amir-btc-assistant-production.up.railway.app";
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";

// ارتقای آرایه به ۱۰۰ ارز برتر بازار طبق نیازمندی سند ساختاری V1
const POPULAR_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT",
    "LINK", "MATIC", "TRX", "UNI", "LTC", "NEAR", "APT", "SUI", "FET", "ICP",
    "FIL", "RNDR", "HBAR", "ATOM", "STX", "IMX", "GRT", "LDO", "TAO", "INJ",
    "OP", "ARB", "WIF", "PEPE", "FLOKI", "BONK", "JUP", "PYTH", "TIA", "SEI",
    "MKR", "RUNE", "AAVE", "EGLD", "FLOW", "THETA", "FTM", "SAND", "MANA", "AXS",
    "GALA", "BEAM", "JTO", "PENDLE", "ENS", "CRV", "COMP", "1INCH", "LRC", "ANKR",
    "WOO", "STRK", "ZK", "ZK", "IO", "ATH", "NOT", "TON", "PEPE", "MNT",
    "KAS", "ORDI", "SATS", "ASTR", "MINA", "CORE", "BGB", "GT", "CHZ", "OKB",
    "ZEX", "OM", "ZRO", "W", "BLUR", "DYDX", "GMX", "BOND", "WAVES", "QTUM",
    "ALGO", "XLM", "VET", "ICP", "EGLD", "FLOW", "MKR", "AAVE", "RUNE", "LDO"
];

window.newsArticlesStorage = {};
let allMarketCoins = [];
let newsSliderInterval = null;
let currentSliderIndex = 0;
let cachedNewsArticles = [];

// =========================================================================
// بخش ۳: موتور کش مرکزی ارتقایافته (Enhanced Cache Engine)
// =========================================================================
const AppCache = {
    storage: {},
    set(key, data, ttlSeconds) {
        this.storage[key] = {
            data: data,
            expiry: Date.now() + (ttlSeconds * 1000)
        };
    },
    get(key) {
        const cached = this.storage[key];
        if (!cached) return null;
        if (Date.now() > cached.expiry) {
            delete this.storage[key];
            return null;
        }
        return cached.data;
    }
};

// =========================================================================
// بخش ۴: روتر و سیستم ناوبری هوشمند (Lazy-Load Tab Router)
// =========================================================================
function switchTab(pageId, element) {
    // مخفی‌سازی تمام صفحات و منوهای فرعی
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    closeReferralPage();
    closeSettingsPage();
    
    // فعال‌سازی صفحه مورد نظر
    const activePage = document.getElementById(pageId);
    if (activePage) activePage.classList.add('active');

    // مدیریت وضعیت فعال منوی پایینی
    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    if (element) {
        element.classList.add('active');
    } else {
        const navMap = {
            'dashboard-page': 'nav-dashboard',
            'market-page': 'nav-market',
            'news-page': 'nav-news',
            'analysis-page': 'nav-analysis',
            'profile-page': 'nav-profile'
        };
        document.getElementById(navMap[pageId])?.classList.add('active');
    }

    // ریست کردن اسلایدر برای بهینه‌سازی مصرف پردازنده
    clearInterval(newsSliderInterval); 
    // show lightweight skeleton for the target tab to improve perceived performance
    showTabSkeleton(pageId);
    
    if (pageId === 'dashboard-page') {
        loadTelegramUser(); // به‌روزرسانی هدر خوشامدگویی داشبورد
        loadMarketAndPrices();
        loadExtraMetrics();
        fetchDashboardNews();
        loadLiquidationData();
    } else if (pageId === 'market-page') {
        loadMarketAndPrices();
        loadLiquidationData();
        loadExtraMetrics();
    } else if (pageId === 'news-page') {
        switchNewsTab('all-news');
    } else if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'profile-page') {
        loadTelegramUser();
    }
}

// نمایش و مخفی‌سازی skeleton برای تب‌ها
function showTabSkeleton(pageId) {
    try {
        if (pageId === 'dashboard-page') {
            const watch = document.getElementById('watchlist-container');
            if (watch) watch.innerHTML = Array(4).fill('<div class="watchlist-card skeleton-block skeleton-card"></div>').join('');
            const slider = document.getElementById('news-slider-content');
            if (slider) slider.innerHTML = '<div class="slide-item skeleton-block skeleton-image"></div>';
        } else if (pageId === 'market-page') {
            const marketList = document.getElementById('market-coin-list');
            if (marketList) marketList.innerHTML = Array(6).fill('<div class="coin-row skeleton-block" style="height:72px; border-radius:12px;"></div>').join('');
        } else if (pageId === 'news-page') {
            const container = document.getElementById('news-tab-content-area');
            if (container) container.innerHTML = Array(6).fill('<div class="news-card skeleton-block" style="height:95px; margin-bottom:12px;"></div>').join('');
        } else if (pageId === 'analysis-page') {
            const container = document.getElementById('telegram-feed-container');
            if (container) container.innerHTML = '<div class="card skeleton-block skeleton-card" style="height:140px;"></div>';
        } else if (pageId === 'profile-page') {
            const profile = document.getElementById('profile-main-view');
            if (profile) profile.innerHTML = '<div class="glass-card skeleton-block" style="height:120px;"></div>';
        }
    } catch (e) { console.warn('skeleton render error', e); }
}

function removeSkeletons() {
    document.querySelectorAll('.skeleton-block').forEach(el => el.classList.remove('skeleton-block'));
}

// =========================================================================
// بخش ۵: دریافت قیمت‌ها و دسته‌بندی بازار (Binance Fetcher & Bull/Bear)

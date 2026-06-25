// ============================================================
// Amir BTC Assistant - Core Application v3.4
// با پاپ‌آپ جوین اجباری، ۱۰۰ ارز، تقویم اقتصادی، حذف همه نوتیف‌ها، و رفع تنظیمات
// ============================================================

const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const ADMIN_ID = '831704732';
const CHANNEL = 'amir_btc_2024';
const MAX_WATCHLIST = 7;
const PROXY = 'https://proxyserveramirbtc.amirkamary7.workers.dev/?url=';
const API_BASE = (window.API_BASE || '').replace(/\/$/, '');

// لیست ارزهای محبوب برای Fallback
const POPULAR_SYMBOLS = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT", "LINK", "MATIC", "TRX", "UNI", "LTC", "NEAR", "APT", "SUI", "FET", "ICP", "FIL", "RNDR", "HBAR", "ATOM", "STX", "IMX", "GRT", "LDO", "TAO", "INJ"];

const COIN_NAMES = {
    BTC: 'Bitcoin', ETH: 'Ethereum', SOL: 'Solana', BNB: 'BNB', XRP: 'Ripple',
    ADA: 'Cardano', DOGE: 'Dogecoin', AVAX: 'Avalanche', SHIB: 'Shiba Inu',
    DOT: 'Polkadot', LINK: 'Chainlink', MATIC: 'Polygon', TRX: 'TRON',
    UNI: 'Uniswap', LTC: 'Litecoin', NEAR: 'NEAR Protocol', APT: 'Aptos',
    SUI: 'Sui', FET: 'Fetch.ai', ICP: 'Internet Computer', FIL: 'Filecoin',
    RNDR: 'Render', HBAR: 'Hedera', ATOM: 'Cosmos', STX: 'Stacks',
    IMX: 'Immutable X', GRT: 'The Graph', LDO: 'Lido DAO', TAO: 'Bittensor', INJ: 'Injective'
};
function getCoinFullName(sym) { return COIN_NAMES[sym] || sym; }

let currentLang = 'fa';
let watchlist = [];
let analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
let tickets = [];
let notifications = JSON.parse(localStorage.getItem('notifications') || '[]');
let alerts = JSON.parse(localStorage.getItem('price_alerts') || '[]');
let allCoins = [];
let currentMarketTab = 'overview';
let searchTerm = '';
let sliderInterval = null;
let currentSlide = 0;
let editingAnalysisId = null;
let hasChannelAccess = false;
let joinCheckDone = false;

// ---------- ترجمه‌ها ----------
const i18n = {
    fa: {
        welcome: 'خوش آمدید،', dashboard: 'داشبورد', market: 'مارکت', analysis: 'تحلیل', news: 'اخبار',
        profile: 'پروفایل', watchlist: 'واچ‌لیست', settings: 'تنظیمات', referral: 'دعوت و پاداش',
        support: 'پشتیبانی و تیکت', about: 'درباره ما', language: 'زبان', search: 'جستجوی ارز...',
        no_data: 'داده‌ای موجود نیست', join_channel: 'عضویت در کانال', copy: 'کپی', share: 'اشتراک‌گذاری',
        share_direct: 'اشتراک‌گذاری مستقیم', delete: 'حذف', mark_all_read: 'همه خوانده شد',
        price_alert: 'هشدار قیمت', set_alert: 'ثبت هشدار', alert_target: 'قیمت هدف (USD)',
        alert_bot_hint: 'اعلان در اپ + پیام تلگرام', alert_empty: 'هیچ هشدار فعالی نیست',
        alert_registered: 'هشدار ثبت شد',
        tab_overview: 'برترین‌ها', tab_trending: 'پرحجم', tab_gainers: 'رشد', tab_losers: 'ریزش',
        analysis_title: 'تحلیل‌های بازار', new_analysis: 'تحلیل جدید',
        news_all: 'همه', news_crypto: 'کریپتو', news_economy: 'اقتصادی', news_forex: 'فارکس', news_calendar: 'تقویم',
        hero_badge: 'کانال تحلیلی', hero_desc: 'سیگنال‌ها، تحلیل‌ها و آموزش‌های روز بازار', hero_cta: 'عضویت رایگان',
        section_analysis: 'تحلیل‌های جدید', section_watchlist: 'واچ‌لیست من', section_news: 'اخبار مهم و فوری',
        view_all: 'مشاهده همه', watchlist_empty: 'واچ‌لیست خالی است',
        watchlist_limit: 'حداکثر ۷ ارز می‌توانید به واچ‌لیست اضافه کنید.', no_analysis: 'تحلیلی موجود نیست',
        no_analysis_list: 'هیچ تحلیلی ثبت نشده است.', no_news: 'خبری وجود ندارد', news_error: 'خطا در دریافت اخبار',
        news_unavailable: 'متن کامل خبر در دسترس نیست.', notif_center: 'مرکز اعلانات', clear_all_notif: 'پاک کردن همه اعلانات',
        no_notif: 'هیچ اعلانی وجود ندارد.', confirm_clear_notif: 'آیا از پاک کردن تمامی اعلانات مطمئن هستید؟',
        join_vip_title: 'عضویت در کانال VIP',
        join_vip_desc: 'برای دسترسی به چارت‌های لحظه‌ای، تحلیل‌های اختصاصی و 100 ارز برتر، ابتدا در کانال رسمی ما عضو شوید.',
        join_vip_btn: 'عضویت در کانال', join_vip_hint: 'بعد از عضویت، دکمه «بررسی عضویت» را بزنید.',
        join_verify_btn: 'بررسی عضویت', join_not_verified: 'هنوز عضو کانال نشده‌اید. ابتدا در کانال عضو شوید.',
        join_verified: 'عضویت تایید شد', join_welcome: 'به اپلیکیشن امیر BTC خوش آمدید!',
        join_guest_hint: 'لطفاً اپ را از داخل تلگرام باز کنید.',
        edit_analysis: 'ویرایش تحلیل', update_analysis: 'ذخیره تغییرات',
        share_ref_text: 'به Amir BTC Assistant بپیوندید و از تحلیل‌های حرفه‌ای بازار استفاده کنید!',
        chart_unavailable: 'نمودار در دسترس نیست', close: 'بستن',
        ref_title: 'دعوت دوستان و دریافت پاداش', ref_desc: 'لینک دعوت خود را به اشتراک بگذارید.',
        ref_total: 'کل دعوت‌ها', ref_active: 'فعال', ref_reward: 'پاداش', coming_soon: 'بزودی',
        ref_wheel: 'گردونه شانس و جوایز', ref_wheel_desc: 'سیستم پاداش در آپدیت بعدی فعال می‌شود.',
        ticket_title: 'عنوان تیکت', ticket_body: 'متن پیام...', ticket_send: 'ارسال تیکت', my_tickets: 'تیکت‌های من',
        ticket_empty: 'تیکتی ثبت نشده است', ticket_pending: 'در انتظار', ticket_answered: 'پاسخ داده شده',
        ticket_reply_btn: 'ارسال پاسخ', ticket_delete: 'حذف تیکت', admin_tickets: 'مدیریت تیکت‌ها',
        ticket_error: 'خطا در ارسال تیکت. لطفاً دوباره تلاش کنید.',
        ticket_reply_error: 'خطا در ارسال پاسخ. لطفاً دوباره تلاش کنید.',
        ticket_sent: 'تیکت با موفقیت ارسال شد', ticket_admin: 'ادمین', ticket_you: 'شما',
        cal_today: 'امروز', cal_tomorrow: 'فردا', cal_impact_high: 'بالا', cal_impact_med: 'متوسط',
        cal_cpi: 'نرخ تورم (CPI)', cal_fed: 'سخنرانی رئیس فدرال رزرو', cal_pmi: 'شاخص مدیران خرید (PMI)',
        about_version: 'نسخه 1.0.0', about_desc: 'دستیار هوشمند معاملاتی متصل به API صرافی‌های معتبر.',
        official_channel: 'کانال رسمی', market_error: 'خطا در دریافت قیمت‌ها. لطفاً دوباره تلاش کنید.',
        price: 'قیمت', change_24h: 'تغییر ۲۴h', mcap: 'مارکت‌کپ', volume_24h: 'حجم ۲۴h',
        view_source: 'مشاهده منبع', guest: 'کاربر میهمان', required_fields: 'فیلدهای الزامی را پر کنید',
        invalid_price: 'قیمت معتبر وارد کنید', copied: 'کپی شد!', copy_ref_msg: 'لینک دعوت کپی شد.'
    },
    en: {
        welcome: 'Welcome,', dashboard: 'Dashboard', market: 'Market', analysis: 'Analysis', news: 'News',
        profile: 'Profile', watchlist: 'Watchlist', settings: 'Settings', referral: 'Referral & Earn',
        support: 'Support & Tickets', about: 'About', language: 'Language', search: 'Search coin...',
        no_data: 'No data available', join_channel: 'Join Channel', copy: 'Copy', share: 'Share',
        share_direct: 'Share Link', delete: 'Delete', mark_all_read: 'Mark all read',
        price_alert: 'Price Alert', set_alert: 'Set Alert', alert_target: 'Target price (USD)',
        alert_bot_hint: 'In-app + Telegram message', alert_empty: 'No active alerts',
        alert_registered: 'Alert registered',
        tab_overview: 'Overview', tab_trending: 'Trending', tab_gainers: 'Gainers', tab_losers: 'Losers',
        analysis_title: 'Market Analysis', new_analysis: 'New Analysis',
        news_all: 'All', news_crypto: 'Crypto', news_economy: 'Economy', news_forex: 'Forex', news_calendar: 'Calendar',
        hero_badge: 'Analysis Channel', hero_desc: 'Daily signals, analysis & market education', hero_cta: 'Join Free',
        section_analysis: 'Latest Analysis', section_watchlist: 'My Watchlist', section_news: 'Breaking News',
        view_all: 'View all', watchlist_empty: 'Watchlist is empty',
        watchlist_limit: 'You can add up to 7 coins to your watchlist.', no_analysis: 'No analysis available',
        no_analysis_list: 'No analysis posted yet.', no_news: 'No news available', news_error: 'Failed to load news',
        news_unavailable: 'Full article text is not available.', notif_center: 'Notification Center',
        clear_all_notif: 'Clear all notifications', no_notif: 'No notifications yet.',
        confirm_clear_notif: 'Clear all notifications?', join_vip_title: 'Join VIP Channel',
        join_vip_desc: 'To access live charts, exclusive analysis and top 100 coins, join our official channel first.',
        join_vip_btn: 'Join Channel', join_vip_hint: 'After joining, tap "Verify Membership".',
        join_verify_btn: 'Verify Membership', join_not_verified: 'You are not a channel member yet. Please join first.',
        join_verified: 'Membership verified', join_welcome: 'Welcome to Amir BTC Assistant!',
        join_guest_hint: 'Please open the app from inside Telegram.',
        edit_analysis: 'Edit Analysis', update_analysis: 'Save Changes',
        share_ref_text: 'Join Amir BTC Assistant and get professional market analysis!',
        chart_unavailable: 'Chart unavailable', close: 'Close',
        ref_title: 'Invite Friends & Earn Rewards', ref_desc: 'Share your referral link with friends.',
        ref_total: 'Total Invites', ref_active: 'Active', ref_reward: 'Reward', coming_soon: 'Coming Soon',
        ref_wheel: 'Spin Wheel & Prizes', ref_wheel_desc: 'Reward system coming in next update.',
        ticket_title: 'Ticket subject', ticket_body: 'Your message...', ticket_send: 'Submit Ticket',
        my_tickets: 'My Tickets', ticket_empty: 'No tickets yet', ticket_pending: 'Pending',
        ticket_answered: 'Answered', ticket_reply_btn: 'Send Reply', ticket_delete: 'Delete ticket',
        admin_tickets: 'Manage Tickets',
        ticket_error: 'Failed to submit ticket. Please try again.',
        ticket_reply_error: 'Failed to send reply. Please try again.',
        ticket_sent: 'Ticket submitted successfully', ticket_admin: 'Admin', ticket_you: 'You',
        cal_today: 'Today', cal_tomorrow: 'Tomorrow', cal_impact_high: 'High', cal_impact_med: 'Medium',
        cal_cpi: 'Inflation Rate (CPI)', cal_fed: 'Fed Chair Speech', cal_pmi: 'Purchasing Managers Index (PMI)',
        about_version: 'Version 1.0.0',
        about_desc: 'Smart trading assistant connected to global exchange APIs.',
        official_channel: 'Official channel', market_error: 'Failed to load prices. Please try again.',
        price: 'Price', change_24h: '24h Change', mcap: 'Market Cap', volume_24h: '24h Volume',
        view_source: 'View source', guest: 'Guest User', required_fields: 'Please fill required fields',
        invalid_price: 'Enter a valid price', copied: 'Copied!', copy_ref_msg: 'Referral link copied.'
    }
};
function t(key) { return i18n[currentLang]?.[key] || i18n.fa[key] || key; }

function getUserId() {
    const uid = tg?.initDataUnsafe?.user?.id;
    if (uid) return String(uid);
    let guestId = localStorage.getItem('guest_id');
    if (!guestId) { guestId = 'guest_' + Date.now(); localStorage.setItem('guest_id', guestId); }
    return guestId;
}
function getUserName() {
    const u = tg?.initDataUnsafe?.user;
    if (!u) return t('guest');
    return `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username || t('guest');
}

function userStorageKey(base) {
    return `${base}_${getUserId()}`;
}

function loadLangFromStorage() {
    const scoped = localStorage.getItem(userStorageKey('app_lang'));
    if (scoped === 'fa' || scoped === 'en') return scoped;
    const legacy = localStorage.getItem('app_lang');
    if (legacy === 'fa' || legacy === 'en') return legacy;
    return 'fa';
}

function loadWatchlistFromStorage() {
    const key = userStorageKey('watchlist');
    let stored = JSON.parse(localStorage.getItem(key) || '[]');
    if (!stored.length) {
        const legacy = JSON.parse(localStorage.getItem('watchlist') || '[]');
        if (legacy.length) {
            stored = legacy.slice(0, MAX_WATCHLIST);
            localStorage.setItem(key, JSON.stringify(stored));
        }
    }
    watchlist = stored.slice(0, MAX_WATCHLIST);
}

function saveLangToStorage() {
    localStorage.setItem(userStorageKey('app_lang'), currentLang);
    localStorage.setItem('app_lang', currentLang);
}

function getJoinCacheKey() {
    return userStorageKey('has_joined_channel');
}

function getJoinCache() {
    return localStorage.getItem(getJoinCacheKey()) === 'true';
}

function setJoinCache(value) {
    localStorage.setItem(getJoinCacheKey(), value ? 'true' : 'false');
}

async function persistWatchlist() {
    localStorage.setItem(userStorageKey('watchlist'), JSON.stringify(watchlist));
    if (!API_BASE || String(getUserId()).startsWith('guest_')) return;
    try {
        await apiFetch('/api/watchlist', {
            method: 'PUT',
            body: JSON.stringify({ user_id: getUserId(), symbols: watchlist })
        });
    } catch (e) {
        console.warn('persistWatchlist:', e);
    }
}

async function saveLangToServer() {
    if (!API_BASE || String(getUserId()).startsWith('guest_')) return;
    try {
        await apiFetch('/api/users/me/settings', {
            method: 'PUT',
            body: JSON.stringify({ user_id: getUserId(), lang: currentLang })
        });
    } catch (e) {
        console.warn('saveLangToServer:', e);
    }
}

async function bootstrapUser() {
    currentLang = loadLangFromStorage();
    loadWatchlistFromStorage();

    if (!API_BASE || String(getUserId()).startsWith('guest_')) {
        applyLanguage();
        return;
    }

    try {
        const u = tg?.initDataUnsafe?.user;
        const data = await apiFetch('/api/users/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
                user_id: getUserId(),
                username: u?.username || null,
                first_name: u?.first_name || null,
                last_name: u?.last_name || null,
                lang: currentLang
            })
        });
        if (data.user?.lang === 'fa' || data.user?.lang === 'en') {
            currentLang = data.user.lang;
        }
        if (Array.isArray(data.watchlist)) {
            if (data.watchlist.length) {
                watchlist = data.watchlist.slice(0, MAX_WATCHLIST);
            } else if (watchlist.length) {
                await persistWatchlist();
            }
            localStorage.setItem(userStorageKey('watchlist'), JSON.stringify(watchlist));
        }
        if (data.user?.channel_joined) {
            hasChannelAccess = true;
            setJoinCache(true);
        }
        saveLangToStorage();
        applyLanguage();
    } catch (e) {
        console.warn('bootstrapUser:', e);
        applyLanguage();
    }
}

async function apiFetch(path, options = {}) {
    if (!API_BASE) throw new Error('API_BASE not configured');
    const res = await fetch(`${API_BASE}${path}`, { headers: { 'Content-Type': 'application/json', ...options.headers }, ...options });
    if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch (_) {}
        throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.json();
}

async function checkBackendHealth() {
    if (!API_BASE) return false;
    try {
        const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
        return res.ok;
    } catch (_) { return false; }
}

function setAppLocked(locked) {
    document.body.classList.toggle('app-locked', locked);
}
function updateLangChecks() {
    const svg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    const fa = document.getElementById('lang-fa-check');
    const en = document.getElementById('lang-en-check');
    if (fa) fa.innerHTML = currentLang === 'fa' ? svg : '';
    if (en) en.innerHTML = currentLang === 'en' ? svg : '';
}

function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => { const key = el.dataset.i18n; if (key) el.innerText = t(key); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { const key = el.dataset.i18nPlaceholder; if (key) el.placeholder = t(key); });
    document.documentElement.lang = currentLang;
    document.documentElement.dir = currentLang === 'fa' ? 'rtl' : 'ltr';
    saveLangToStorage();
    updateLangChecks();
}
function refreshUI() {
    applyLanguage();
    loadUser();
    renderMarket();
    renderWatchlist();
    renderSummary();
    renderAnalysisSlider();
    renderAnalysisList();
    if (newsCache.length) renderNews(document.querySelector('.news-tab.active')?.dataset?.news || 'all');
    loadImportantNews();
    renderTickets();
    renderActiveAlerts(document.getElementById('detail-coin-title')?.innerText?.split(' ')[0] || '');
}
function selectLang(lang) {
    if (lang === currentLang) { closeLangModal(); return; }
    currentLang = lang;
    saveLangToStorage();
    saveLangToServer();
    delete Cache.storage['news'];
    refreshUI();
    loadNews(true);
    closeLangModal();
}
function changeLang(lang) { selectLang(lang); }

// ---------- کش ----------
const Cache = {
    storage: {},
    set(key, data, ttl) { this.storage[key] = { data, expiry: Date.now() + ttl * 1000 }; },
    get(key) {
        const c = this.storage[key];
        if (!c) return null;
        if (Date.now() > c.expiry) { delete this.storage[key]; return null; }
        return c.data;
    }
};

// ---------- API با Proxy با Fallback به CoinGecko ----------
function isRssUrl(url) {
    return url.includes('/rss') || url.endsWith('/feed/') || url.includes('outboundfeeds/rss');
}

async function fetchWithProxy(url, options = {}) {
    const opts = typeof options === 'number' ? { retries: options } : options;
    const { asText = isRssUrl(url), retries = 2 } = opts;
    const isCoinCap = url.includes('coincap.io');

    for (let i = 0; i < retries; i++) {
        try {
            const proxyUrl = PROXY + encodeURIComponent(url);
            const res = await fetch(proxyUrl);
            if (!res.ok) {
                const errorText = await res.text();
                console.warn(`⚠️ Proxy HTTP ${res.status}: ${errorText}`);
                if (isCoinCap) {
                    console.log('🔄 Switching to CoinGecko fallback...');
                    return await fetchCoinGecko();
                }
                throw new Error(`HTTP ${res.status}`);
            }
            return asText ? await res.text() : await res.json();
        } catch (e) {
            console.warn(`Attempt ${i+1} failed:`, e);
            if (i === retries - 1 && isCoinCap) {
                console.log('🔄 Final fallback to CoinGecko...');
                return await fetchCoinGecko();
            }
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
    }
}

// تابع دریافت داده از CoinGecko (بدون نیاز به Proxy)
async function fetchCoinGecko() {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false');
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    return data.map((item, index) => ({
        symbol: item.symbol.toUpperCase(),
        name: item.name,
        rank: index + 1,
        priceUsd: item.current_price || 0,
        changePercent24Hr: item.price_change_percentage_24h || 0,
        volumeUsd24Hr: item.total_volume || 0,
        marketCapUsd: item.market_cap || 0,
        supply: item.circulating_supply || 0,
        image: item.image || ''
    }));
}

// ---------- بارگذاری داده‌های بازار ----------
async function loadMarketData(force = false) {
    const listEl = document.getElementById('coin-list');
    try {
        if (!force) {
            const cached = Cache.get('market');
            if (cached?.length) {
                allCoins = cached;
                renderMarket();
                renderWatchlist();
                renderSummary();
                checkAlerts();
                return;
            }
        }
        try {
            allCoins = await fetchCoinGecko();
        } catch (e1) {
            console.warn('CoinGecko direct failed:', e1);
            const data = await fetchWithProxy('https://api.coincap.io/v2/assets?limit=200');
            const assets = data.data || data;
            if (Array.isArray(data) && data[0]?.symbol) {
                allCoins = data;
            } else if (assets?.length) {
                allCoins = assets.map((item, i) => ({
                    symbol: item.symbol, name: item.name, rank: i + 1,
                    priceUsd: parseFloat(item.priceUsd) || 0,
                    changePercent24Hr: parseFloat(item.changePercent24Hr) || 0,
                    volumeUsd24Hr: parseFloat(item.volumeUsd24Hr) || 0,
                    marketCapUsd: parseFloat(item.marketCapUsd) || 0,
                    supply: parseFloat(item.supply) || 0, image: ''
                }));
            } else throw new Error('No market data');
        }
        Cache.set('market', allCoins, 60);
        renderMarket();
        renderWatchlist();
        renderSummary();
        checkAlerts();
    } catch (e) {
        console.error('❌ Market load error:', e);
        if (listEl && !allCoins.length) {
            listEl.innerHTML = `<div class="empty-state">${t('market_error')}</div>`;
        }
    }
}

// ---------- رندر خلاصه بازار ----------
function renderSummary() {
    if (!allCoins.length) return;
    const mcapEl = document.getElementById('global-mcap');
    if (!mcapEl) return;
    const mcap = allCoins.reduce((s, c) => s + c.marketCapUsd, 0);
    const volume = allCoins.reduce((s, c) => s + c.volumeUsd24Hr, 0);
    const btc = allCoins.find(c => c.symbol === 'BTC');
    mcapEl.innerText = '$' + (mcap / 1e12).toFixed(2) + 'T';
    document.getElementById('global-volume').innerText = '$' + (volume / 1e9).toFixed(2) + 'B';
    document.getElementById('btc-dom').innerText = btc ? ((btc.marketCapUsd / mcap) * 100).toFixed(1) + '%' : '--';
}

// ---------- رندر مارکت (نمایش ۱۰۰ ارز) ----------
function renderMarket() {
    const list = document.getElementById('coin-list');
    if (!list) return;
    let filtered = [...allCoins];
    if (searchTerm) {
        filtered = filtered.filter(c =>
            c.symbol.toLowerCase().includes(searchTerm) ||
            c.name.toLowerCase().includes(searchTerm)
        ).slice(0, 50);
    } else {
        switch (currentMarketTab) {
            case 'trending':
                filtered = filtered.sort((a, b) => b.volumeUsd24Hr - a.volumeUsd24Hr).slice(0, 30);
                break;
            case 'gainers':
                filtered = filtered.filter(c => c.changePercent24Hr > 0).sort((a, b) => b.changePercent24Hr - a.changePercent24Hr).slice(0, 30);
                break;
            case 'losers':
                filtered = filtered.filter(c => c.changePercent24Hr < 0).sort((a, b) => a.changePercent24Hr - b.changePercent24Hr).slice(0, 30);
                break;
            case 'watchlist':
                filtered = filtered.filter(c => watchlist.includes(c.symbol));
                break;
            default:
                filtered = filtered.slice(0, 100);
        }
    }
    if (!filtered.length) {
        list.innerHTML = `<div class="empty-state">${t('no_data')}</div>`;
        return;
    }
    list.innerHTML = filtered.map(c => {
        const isPos = c.changePercent24Hr >= 0;
        const inWatch = watchlist.includes(c.symbol);
        const icon = c.image || `https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png`;
        return `
            <div class="coin-item" onclick="openCoinDetail('${c.symbol}')">
                <div class="coin-left">
                    <span class="coin-rank">#${c.rank}</span>
                    <img src="${icon}" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2228%22 viewBox=%220 0 24 24%22 fill=%22%2394a3b8%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%2210%22/%3E%3C/svg%3E'" class="coin-icon">
                    <div>
                        <div class="coin-sym">${c.symbol}</div>
                        <div class="coin-name">${c.name}</div>
                    </div>
                </div>
                <div class="coin-right">
                    <div class="coin-price">$${c.priceUsd > 1 ? c.priceUsd.toFixed(2) : c.priceUsd.toFixed(6)}</div>
                    <div class="coin-change ${isPos ? 'up' : 'down'}">${isPos ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</div>
                    <span class="watch-star ${inWatch ? 'active' : ''}" onclick="toggleWatchlist('${c.symbol}', event)">
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="${inWatch ? '#f7931a' : 'none'}" stroke="${inWatch ? '#f7931a' : '#555'}" stroke-width="2">
                            <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                        </svg>
                    </span>
                </div>
            </div>
        `;
    }).join('');
}
function switchMarketTab(tab, btn) {
    currentMarketTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMarket();
}
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('market-search')?.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        renderMarket();
    });
});

// ---------- واچ‌لیست ----------
function toggleWatchlist(symbol, event) {
    if (event) event.stopPropagation();
    const idx = watchlist.indexOf(symbol);
    if (idx > -1) {
        watchlist.splice(idx, 1);
    } else {
        if (watchlist.length >= MAX_WATCHLIST) {
            tg?.showPopup?.({
                title: t('watchlist'),
                message: t('watchlist_limit'),
                buttons: [{ type: 'ok' }]
            }) || alert(t('watchlist_limit'));
            return;
        }
        watchlist.push(symbol);
    }
    persistWatchlist();
    renderMarket();
    renderWatchlist();
}
function renderWatchlist() {
    const grid = document.getElementById('watchlist-grid');
    const watchCoins = allCoins.filter(c => watchlist.includes(c.symbol));
    if (!watchCoins.length) {
        grid.innerHTML = `<div class="empty-state">${t('watchlist_empty')}</div>`;
        return;
    }
    grid.innerHTML = watchCoins.map(c => `
        <div class="watch-item" onclick="openCoinDetail('${c.symbol}')">
            <span class="remove-watch" onclick="toggleWatchlist('${c.symbol}', event)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
            <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2228%22 height=%2228%22 viewBox=%220 0 24 24%22 fill=%22%2394a3b8%22%3E%3Ccircle cx=%2212%22 cy=%2212%22 r=%2210%22/%3E%3C/svg%3E'" class="watch-icon">
            <span class="watch-sym">${c.symbol}</span>
            <span class="watch-price">$${c.priceUsd.toFixed(2)}</span>
            <span class="watch-change ${c.changePercent24Hr >= 0 ? 'up' : 'down'}">${c.changePercent24Hr >= 0 ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</span>
        </div>
    `).join('');
}
function openAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'flex';
    populateCoinModal();
}
function closeAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'none';
}
function populateCoinModal() {
    const list = document.getElementById('coin-modal-list');
    if (!allCoins.length) return;
    list.innerHTML = allCoins.map(c => {
        const inList = watchlist.includes(c.symbol);
        const atLimit = !inList && watchlist.length >= MAX_WATCHLIST;
        return `
        <div class="modal-coin-item ${atLimit ? 'disabled' : ''}" onclick="${atLimit ? '' : `toggleWatchlist('${c.symbol}', event); populateCoinModal();`}">
            <span>${c.symbol} - ${c.name}</span>
            <span>${inList ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="#f7931a" stroke="#f7931a" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'}</span>
        </div>`;
    }).join('');
}
function filterCoinList() {
    const q = document.getElementById('coin-search-modal').value.toLowerCase();
    document.querySelectorAll('.modal-coin-item').forEach(el => {
        el.style.display = el.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
    });
}

// ---------- اخبار و تقویم اقتصادی ----------
let newsCache = [];

async function translateText(text, targetLang) {
    if (!text?.trim()) return text;
    const tl = targetLang || (currentLang === 'fa' ? 'fa' : 'en');
    try {
        const url = `https://translate.googleapis.com/translate_a/single?client=gtx&sl=auto&tl=${tl}&dt=t&q=${encodeURIComponent(text.substring(0, 500))}`;
        const res = await fetch(url);
        const data = await res.json();
        return data[0]?.map(x => x[0]).join('') || text;
    } catch { return text; }
}

async function translateArticles(articles) {
    if (currentLang !== 'fa') return articles;
    const translated = [];
    for (const a of articles.slice(0, 12)) {
        const title = await translateText(a.title, 'fa');
        const body = a.body ? await translateText(a.body, 'fa') : a.body;
        translated.push({ ...a, title, body });
    }
    return translated;
}

function detectNewsCategory(title, body) {
    const text = `${title} ${body}`.toLowerCase();
    if (/forex|dollar|eur\/usd|fed rate|interest rate|central bank|fx /.test(text)) return 'forex';
    if (/economy|gdp|inflation|cpi|pmi|employment|recession|stock market|wall street/.test(text)) return 'economy';
    return 'crypto';
}

function parseRssItems(rssText, sourceName) {
    const parser = new DOMParser();
    const xmlDoc = parser.parseFromString(rssText, 'text/xml');
    const items = xmlDoc.querySelectorAll('item');
    const articles = [];
    items.forEach(item => {
        const title = item.querySelector('title')?.textContent || '';
        const link = item.querySelector('link')?.textContent || '#';
        const description = item.querySelector('description')?.textContent || '';
        const imgMatch = description.match(/<img[^>]+src="([^">]+)"/);
        const image = imgMatch ? imgMatch[1] : null;
        const body = description.replace(/<[^>]*>/g, '').trim().substring(0, 200);
        articles.push({
            title: title.replace(/<[^>]*>/g, '').trim(),
            source: sourceName,
            image,
            url: link,
            body,
            category: detectNewsCategory(title, body),
            time: new Date(item.querySelector('pubDate')?.textContent || Date.now()).toLocaleString(currentLang === 'fa' ? 'fa-IR' : 'en-US')
        });
    });
    return articles;
}

async function fetchRssArticles() {
    const articles = [];
    const sources = [
        ['https://cointelegraph.com/rss', 'CoinTelegraph'],
        ['https://www.coindesk.com/arc/outboundfeeds/rss/', 'CoinDesk'],
        ['https://cryptopanic.com/feed/', 'CryptoPanic']
    ];
    for (const [url, name] of sources) {
        try {
            const rssText = await fetchWithProxy(url, { asText: true });
            articles.push(...parseRssItems(rssText, name));
        } catch (e) { console.warn(`${name} RSS error:`, e); }
    }
    return articles;
}

let displayedNews = [];
async function loadNews(force = false) {
    try {
        if (!force) {
            const cached = Cache.get('news');
            if (cached) { newsCache = cached; renderNews(document.querySelector('.news-tab.active')?.dataset?.news || 'all'); return; }
        }
        let articles = [];

        if (currentLang === 'fa' && API_BASE) {
            try {
                const res = await fetch(`${API_BASE}/api/farsi-news`);
                const json = await res.json();
                if (json.data?.length) {
                    articles = json.data.map(a => ({
                        title: a.title, body: a.description, source: a.source,
                        image: a.image, url: a.url, time: a.time_ago,
                        category: detectNewsCategory(a.title, a.description || '')
                    }));
                }
            } catch (e) { console.warn('Farsi news API error:', e); }
        }

        if (!articles.length) {
            articles = await fetchRssArticles();
            if (currentLang === 'fa' && articles.length) {
                articles = await translateArticles(articles);
            }
        }

        if (!articles.length) {
            articles = currentLang === 'fa' ? [
                { title: 'بیت‌کوین به ۷۰ هزار دلار نزدیک شد', source: 'کوین‌تلگراف', image: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop', url: '#', body: 'با افزایش حجم معاملات...', category: 'crypto', time: 'اخیراً' },
                { title: 'اتریوم ۱۵٪ رشد کرد', source: 'کوین‌دسک', image: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop', url: '#', body: 'اتریوم به سطح ۴۰۰۰ دلار رسید...', category: 'crypto', time: 'اخیراً' }
            ] : [
                { title: 'Bitcoin approaches $70K', source: 'CoinTelegraph', image: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop', url: '#', body: 'Trading volume surged...', category: 'crypto', time: 'Recently' },
                { title: 'Ethereum up 15%', source: 'CoinDesk', image: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop', url: '#', body: 'ETH reached $4000...', category: 'crypto', time: 'Recently' }
            ];
        }

        newsCache = articles.slice(0, 20);
        Cache.set('news', newsCache, 300);
        renderNews(document.querySelector('.news-tab.active')?.dataset?.news || 'all');
    } catch (e) {
        console.error('News error:', e);
        document.getElementById('news-list').innerHTML = `<div class="empty-state">${t('news_error')}</div>`;
    }
}
function renderNews(category) {
    const container = document.getElementById('news-list');
    let filtered = newsCache;
    if (category === 'crypto') filtered = filtered.filter(n => n.category === 'crypto');
    else if (category === 'economy') filtered = filtered.filter(n => n.category === 'economy');
    else if (category === 'forex') filtered = filtered.filter(n => n.category === 'forex');
    else if (category === 'calendar') {
        const ecoEvents = [
            { time: '16:00', region: 'US', title: t('cal_cpi'), impact: 'High', date: t('cal_today') },
            { time: '18:30', region: 'US', title: t('cal_fed'), impact: 'High', date: t('cal_today') },
            { time: '12:30', region: 'EU', title: t('cal_pmi'), impact: 'Medium', date: t('cal_tomorrow') }
        ];
        container.innerHTML = ecoEvents.map(e => `
            <div class="eco-event-card">
                <div class="eco-event-left">
                    <span class="eco-flag eco-flag-${e.region.toLowerCase()}">${e.region}</span>
                    <div>
                        <div class="eco-event-title">${e.title}</div>
                        <div class="eco-event-meta">${e.date} • ${e.time}</div>
                    </div>
                </div>
                <span class="eco-impact eco-impact-${e.impact.toLowerCase()}">${e.impact === 'High' ? t('cal_impact_high') : t('cal_impact_med')}</span>
            </div>
        `).join('');
        return;
    }
    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">${t('no_data')}</div>`;
        return;
    }
    displayedNews = filtered;
    container.innerHTML = filtered.map((n, i) => `
        <div class="news-item" onclick="openNewsModal(${i})">
            <img src="${n.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2270%22 height=%2270%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E'}" class="news-img">
            <div class="news-content">
                <div class="news-title">${n.title}</div>
                <div class="news-source">${n.source} • ${n.time || ''}</div>
            </div>
        </div>
    `).join('');
}
function switchNewsTab(category, btn) {
    document.querySelectorAll('.news-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderNews(category);
}
function openNewsModal(idx) {
    const n = displayedNews[idx];
    if (!n) return;
    document.getElementById('news-modal-title').innerText = n.title;
    document.getElementById('news-modal-image').src = n.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22200%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E';
    document.getElementById('news-modal-body').innerText = n.body || t('news_unavailable');
    document.getElementById('news-modal-link').href = n.url || '#';
    document.getElementById('news-modal-link').innerText = t('view_source');
    document.getElementById('news-modal').style.display = 'flex';
}
function closeNewsModal() {
    document.getElementById('news-modal').style.display = 'none';
}

// ---------- اسلایدر و لیست تحلیل‌ها ----------
function renderAnalysisSlider() {
    const track = document.getElementById('slider-track');
    const dots = document.getElementById('slider-dots');
    if (!analyses.length) {
        track.innerHTML = `<div class="slide-empty">${t('no_analysis')}</div>`;
        return;
    }
    const showSlide = (idx) => {
        const a = analyses[idx];
        track.innerHTML = `
            <div class="slide-item" onclick="openAnalysisDetail('${a.id}')">
                <img src="${a.image || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop'}" class="slide-img" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22200%22 height=%22170%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2217%22 rx=%224%22/%3E%3Ctext x=%225%22 y=%2212%22 fill=%22%2364748b%22 font-size=%228%22%3ENo Image%3C/text%3E%3C/svg%3E'">
                <div class="slide-overlay">
                    <h4>${a.coin} (${a.timeframe})</h4>
                    <p>${a.text.substring(0, 80)}...</p>
                    <span class="slide-author">${a.author} • ${a.date}</span>
                </div>
            </div>
        `;
        dots.innerHTML = analyses.map((_, i) => `<span class="dot ${i === idx ? 'active' : ''}"></span>`).join('');
    };
    if (currentSlide >= analyses.length) currentSlide = 0;
    showSlide(currentSlide);
    clearInterval(sliderInterval);
    sliderInterval = setInterval(() => {
        currentSlide = (currentSlide + 1) % analyses.length;
        showSlide(currentSlide);
    }, 5000);
}
function renderAnalysisList() {
    const grid = document.getElementById('analysis-grid');
    if (!analyses.length) {
        grid.innerHTML = `<div class="empty-state">${t('no_analysis_list')}</div>`;
        return;
    }
    const isAdminUser = isAdmin();
    grid.innerHTML = analyses.map(a => `
        <div class="analysis-card" onclick="openAnalysisDetail('${a.id}')">
            <img src="${a.image || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop'}" class="analysis-cover" onerror="this.src='data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2280%22 height=%2280%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Ctext x=%224%22 y=%2214%22 fill=%22%2364748b%22 font-size=%228%22%3ENo Image%3C/text%3E%3C/svg%3E'">
            <div class="analysis-body">
                <h4>${a.coin} <span class="tf-badge">${a.timeframe}</span></h4>
                <p>${a.text.substring(0, 100)}...</p>
                <div class="analysis-meta">${a.author} • ${a.date}</div>
                ${isAdminUser ? `<div class="analysis-admin-actions" onclick="event.stopPropagation()">
                    <button class="edit-analysis-btn" onclick="openEditAnalysisModal('${a.id}')"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg> ${t('edit_analysis')}</button>
                    <button class="delete-analysis-btn" onclick="deleteAnalysis('${a.id}', event)"><svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg> ${t('delete')}</button>
                </div>` : ''}
            </div>
        </div>
    `).join('');
}
function openAnalysisDetail(id) {
    const a = analyses.find(x => x.id === id);
    if (!a) return;
    document.getElementById('analysis-detail-title').innerText = `${a.coin} (${a.timeframe})`;
    document.getElementById('analysis-detail-image').src = a.image || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop';
    document.getElementById('analysis-detail-meta').innerText = `${a.author} • ${a.date}`;
    document.getElementById('analysis-detail-text').innerText = a.text;
    document.getElementById('analysis-detail-modal').style.display = 'flex';
}
function closeAnalysisDetail() {
    document.getElementById('analysis-detail-modal').style.display = 'none';
}

// ---------- مدیریت تحلیل (مدیر) ----------
function isAdmin() {
    const user = tg?.initDataUnsafe?.user;
    return user && String(user.id) === ADMIN_ID;
}
function openAddAnalysisModal() {
    if (!isAdmin()) { alert('فقط مدیران مجاز به افزودن تحلیل هستند.'); return; }
    editingAnalysisId = null;
    document.getElementById('analysis-modal-title').innerText = t('new_analysis');
    document.getElementById('analysis-submit-btn').innerText = t('new_analysis');
    ['analysis-coin', 'analysis-timeframe', 'analysis-image', 'analysis-text'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    document.getElementById('add-analysis-modal').style.display = 'flex';
}
function openEditAnalysisModal(id) {
    if (!isAdmin()) return;
    const a = analyses.find(x => x.id === id);
    if (!a) return;
    editingAnalysisId = id;
    document.getElementById('analysis-modal-title').innerText = t('edit_analysis');
    document.getElementById('analysis-submit-btn').innerText = t('update_analysis');
    document.getElementById('analysis-coin').value = a.coin;
    document.getElementById('analysis-timeframe').value = a.timeframe;
    document.getElementById('analysis-image').value = a.image || '';
    document.getElementById('analysis-text').value = a.text;
    document.getElementById('add-analysis-modal').style.display = 'flex';
}
function closeAddAnalysisModal() {
    document.getElementById('add-analysis-modal').style.display = 'none';
    editingAnalysisId = null;
}
function submitAnalysis() {
    const coin = document.getElementById('analysis-coin').value.trim().toUpperCase();
    const timeframe = document.getElementById('analysis-timeframe').value.trim() || '1d';
    let image = document.getElementById('analysis-image').value.trim();
    const text = document.getElementById('analysis-text').value.trim();
    if (!coin || !text) { alert('نام ارز و متن تحلیل الزامی است.'); return; }
    if (!image) image = 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop';

    if (editingAnalysisId) {
        const idx = analyses.findIndex(a => a.id === editingAnalysisId);
        if (idx >= 0) {
            analyses[idx] = { ...analyses[idx], coin, timeframe, image, text, date: new Date().toLocaleDateString('fa-IR') };
        }
        addNotification(t('edit_analysis'), `${coin} (${timeframe})`, true);
    } else {
        const newAnalysis = {
            id: Date.now().toString(),
            coin,
            timeframe,
            image,
            text,
            date: new Date().toLocaleDateString('fa-IR'),
            author: tg?.initDataUnsafe?.user?.first_name || 'مدیر'
        };
        analyses.unshift(newAnalysis);
        addNotification('تحلیل جدید', `تحلیل ${coin} منتشر شد.`, true);
    }
    localStorage.setItem('analyses', JSON.stringify(analyses));
    renderAnalysisSlider();
    renderAnalysisList();
    closeAddAnalysisModal();
    ['analysis-coin', 'analysis-timeframe', 'analysis-image', 'analysis-text'].forEach(id => document.getElementById(id).value = '');
}
function deleteAnalysis(id, event) {
    if (event) event.stopPropagation();
    if (!isAdmin()) return;
    if (confirm('آیا از حذف این تحلیل مطمئن هستید؟')) {
        analyses = analyses.filter(a => a.id !== id);
        localStorage.setItem('analyses', JSON.stringify(analyses));
        renderAnalysisSlider();
        renderAnalysisList();
        addNotification('تحلیل حذف شد', `یک تحلیل توسط مدیر حذف گردید.`);
    }
}

// ---------- جزئیات کوین و هشدار قیمت ----------
async function openCoinDetail(symbol) {
    const coin = allCoins.find(c => c.symbol === symbol);
    if (!coin) return;
    document.getElementById('detail-coin-title').innerText = `${symbol} / USDT`;
    const modal = document.getElementById('coin-detail-modal');
    modal.style.display = 'flex';

    const chartContainer = document.getElementById('detail-chart');
    chartContainer.innerHTML = '';
    if (typeof TradingView !== 'undefined') {
        new TradingView.widget({
            width: '100%',
            height: '100%',
            symbol: `BINANCE:${symbol}USDT`,
            interval: '60',
            theme: 'dark',
            style: '1',
            locale: 'en',
            container_id: 'detail-chart',
            hide_side_toolbar: true,
            disabled_features: ['header_widget_dom_node']
        });
    } else {
        chartContainer.innerHTML = `<div class="empty-state">${t('chart_unavailable')}</div>`;
    }

    document.getElementById('detail-stats').innerHTML = `
        <div><span>${t('price')}</span><strong>$${coin.priceUsd > 1 ? coin.priceUsd.toFixed(2) : coin.priceUsd.toFixed(6)}</strong></div>
        <div><span>${t('change_24h')}</span><strong class="${coin.changePercent24Hr >= 0 ? 'up' : 'down'}">${coin.changePercent24Hr >= 0 ? '+' : ''}${coin.changePercent24Hr.toFixed(2)}%</strong></div>
        <div><span>${t('mcap')}</span><strong>$${(coin.marketCapUsd / 1e9).toFixed(2)}B</strong></div>
        <div><span>${t('volume_24h')}</span><strong>$${(coin.volumeUsd24Hr / 1e6).toFixed(2)}M</strong></div>
    `;
    renderActiveAlerts(symbol);
}
function closeCoinDetail() {
    document.getElementById('coin-detail-modal').style.display = 'none';
}
function renderActiveAlerts(symbol) {
    const container = document.getElementById('active-alerts');
    if (!container || !symbol) return;
    const userAlerts = alerts.filter(a => a.symbol === symbol);
    if (!userAlerts.length) {
        container.innerHTML = `<div class="alert-empty">${t('alert_empty')}</div>`;
        return;
    }
    container.innerHTML = userAlerts.map(a => `
        <div class="alert-item">
            <div class="alert-item-info">
                <span class="alert-item-symbol">${a.symbol}</span>
                <span class="alert-item-target">≥ $${a.price}</span>
            </div>
            <button class="alert-remove-btn" onclick="removeAlert('${a.id}')">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `).join('');
}
function playAlertSound() {
    try {
        const AudioCtx = window.AudioContext || window.webkitAudioContext;
        if (!AudioCtx) return;
        const ctx = new AudioCtx();
        [880, 1100].forEach((freq, i) => {
            const osc = ctx.createOscillator();
            const gain = ctx.createGain();
            osc.connect(gain);
            gain.connect(ctx.destination);
            osc.frequency.value = freq;
            osc.type = 'sine';
            const start = ctx.currentTime + i * 0.18;
            gain.gain.setValueAtTime(0.0001, start);
            gain.gain.exponentialRampToValueAtTime(0.25, start + 0.02);
            gain.gain.exponentialRampToValueAtTime(0.0001, start + 0.35);
            osc.start(start);
            osc.stop(start + 0.36);
        });
    } catch (e) { console.warn('Alert sound failed:', e); }
}

async function syncAlertToServer(alert) {
    if (!API_BASE || String(alert.userId).startsWith('guest_')) return alert;
    try {
        const data = await apiFetch('/api/alerts', {
            method: 'POST',
            body: JSON.stringify({
                user_id: alert.userId,
                symbol: alert.symbol,
                price: alert.price,
                direction: 'above'
            })
        });
        if (data.alert?.id) alert.serverId = data.alert.id;
    } catch (e) { console.warn('syncAlertToServer:', e); }
    return alert;
}

async function removeAlertFromServer(alert) {
    if (!API_BASE || !alert.serverId || String(alert.userId).startsWith('guest_')) return;
    try {
        await apiFetch(`/api/alerts/${alert.serverId}?user_id=${encodeURIComponent(alert.userId)}`, { method: 'DELETE' });
    } catch (e) { console.warn('removeAlertFromServer:', e); }
}

async function loadAlertsFromServer() {
    if (!API_BASE || String(getUserId()).startsWith('guest_')) return;
    try {
        const data = await apiFetch(`/api/alerts?user_id=${encodeURIComponent(getUserId())}`);
        alerts = (data.alerts || []).map(a => ({
            id: a.id,
            serverId: a.id,
            symbol: a.symbol,
            price: a.price,
            userId: a.user_id,
            createdAt: a.created_at
        }));
        localStorage.setItem('price_alerts', JSON.stringify(alerts));
    } catch (e) { console.warn('loadAlertsFromServer:', e); }
}

async function notifyTelegram(message) {
    const userId = getUserId();
    if (!API_BASE || String(userId).startsWith('guest_')) return false;
    try {
        const res = await apiFetch('/api/notify', {
            method: 'POST',
            body: JSON.stringify({ user_id: userId, message })
        });
        return !!res.sent;
    } catch (e) {
        console.warn('notifyTelegram:', e);
        return false;
    }
}
async function setPriceAlert() {
    const input = document.getElementById('alert-price');
    const price = parseFloat(input.value);
    const symbol = document.getElementById('detail-coin-title').innerText.split(' ')[0];
    if (!price || price <= 0) { alert(t('invalid_price')); return; }
    const userId = getUserId();
    let newAlert = { id: Date.now().toString(), symbol, price, userId, createdAt: new Date().toISOString() };
    newAlert = await syncAlertToServer(newAlert);
    alerts.push(newAlert);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    input.value = '';
    renderActiveAlerts(symbol);
    addNotification(t('price_alert'), `${symbol} ≥ $${price}`);
    tg?.showPopup?.({ title: t('alert_registered'), message: `${symbol} — $${price}`, buttons: [{ type: 'ok' }] });
}
async function removeAlert(id) {
    const removed = alerts.find(a => a.id === id);
    if (removed) await removeAlertFromServer(removed);
    alerts = alerts.filter(a => a.id !== id);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    const symbol = document.getElementById('detail-coin-title')?.innerText?.split(' ')[0];
    if (symbol) renderActiveAlerts(symbol);
}
async function triggerAlert(alert, currentPrice) {
    await removeAlertFromServer(alert);
    alerts = alerts.filter(a => a.id !== alert.id);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    const msg = currentLang === 'fa'
        ? `🔔 هشدار قیمت!\n${alert.symbol} به $${currentPrice.toFixed(4)} رسید\nهدف: $${alert.price}`
        : `🔔 Price Alert!\n${alert.symbol} reached $${currentPrice.toFixed(4)}\nTarget: $${alert.price}`;
    playAlertSound();
    tg?.HapticFeedback?.notificationOccurred('warning');
    addNotification(t('price_alert'), msg.replace(/\n/g, ' '), false);
    tg?.showPopup?.({ title: t('price_alert'), message: msg, buttons: [{ type: 'ok' }] });
    await notifyTelegram(msg);
    const symbol = document.getElementById('detail-coin-title')?.innerText?.split(' ')[0];
    if (symbol === alert.symbol) renderActiveAlerts(symbol);
}
async function checkAlerts() {
    const userId = getUserId();
    const userAlerts = alerts.filter(a => a.userId === userId);
    if (!userAlerts.length || !allCoins.length) return;
    const priceMap = {};
    allCoins.forEach(c => { priceMap[c.symbol] = c.priceUsd; });
    for (const alert of userAlerts) {
        const current = priceMap[alert.symbol];
        if (current != null && current >= alert.price) await triggerAlert(alert, current);
    }
}

// ---------- نوتیفیکیشن ----------
function addNotification(title, body, sendToTelegram = true) {
    const notif = { id: Date.now().toString(), title, body, read: false, date: new Date().toISOString() };
    notifications.unshift(notif);
    if (notifications.length > 50) notifications = notifications.slice(0, 50);
    localStorage.setItem('notifications', JSON.stringify(notifications));
    updateNotifBadge();
    if (sendToTelegram) {
        const userId = getUserId();
        if (!String(userId).startsWith('guest_')) {
            notifyTelegram(`🔔 ${title}\n${body}`).catch(e => console.warn('notifyTelegram:', e));
        }
    }
}
function updateNotifBadge() {
    const unread = notifications.filter(n => !n.read).length;
    const badge = document.getElementById('notif-badge');
    if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread; }
    else { badge.style.display = 'none'; }
}
function toggleNotificationPanel() {
    const modal = document.getElementById('notif-modal');
    modal.style.display = modal.style.display === 'flex' ? 'none' : 'flex';
    renderNotifications();
}
function closeNotifModal() {
    document.getElementById('notif-modal').style.display = 'none';
}
function markAllRead() {
    notifications.forEach(n => n.read = true);
    localStorage.setItem('notifications', JSON.stringify(notifications));
    updateNotifBadge();
    renderNotifications();
}
function clearAllNotifications() {
    if(confirm(t('confirm_clear_notif'))) {
        notifications = [];
        localStorage.setItem('notifications', JSON.stringify(notifications));
        updateNotifBadge();
        renderNotifications();
        closeNotifModal();
    }
}
function renderNotifications() {
    const container = document.getElementById('notif-list');
    if (!notifications.length) {
        container.innerHTML = `<div class="empty-state">${t('no_notif')}</div>`;
        return;
    }
    container.innerHTML = notifications.slice(0, 20).map(n => `
        <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="markNotifRead('${n.id}')">
            <div class="notif-title">${n.title}</div>
            <div class="notif-body">${n.body}</div>
            <div class="notif-date">${new Date(n.date).toLocaleDateString('fa-IR')}</div>
        </div>
    `).join('');
}
function markNotifRead(id) {
    const n = notifications.find(x => x.id === id);
    if (n) { n.read = true; localStorage.setItem('notifications', JSON.stringify(notifications)); updateNotifBadge(); renderNotifications(); }
}

// ---------- پروفایل و رفرال ----------
function loadUser() {
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        document.getElementById('profile-name').innerText = `${user.first_name || ''} ${user.last_name || ''}`.trim() || t('guest');
        document.getElementById('profile-username').innerText = user.username ? `@${user.username}` : '@guest';
        document.getElementById('profile-id-num').innerText = user.id || '000000';
        if (user.photo_url) document.getElementById('profile-avatar').src = user.photo_url;
        document.getElementById('ref-link').value = `https://t.me/AmirBtcBot/app?startapp=ref_${user.id}`;
        const refData = JSON.parse(localStorage.getItem('ref_stats') || '{"total":0,"active":0,"reward":0}');
        document.getElementById('ref-total').innerText = refData.total;
        document.getElementById('ref-active').innerText = refData.active;
        document.getElementById('ref-reward').innerText = refData.reward + ' SAT';
    } else {
        document.getElementById('profile-name').innerText = t('guest');
        document.getElementById('profile-username').innerText = 'loading...';
        document.getElementById('profile-id-num').innerText = '000000';
        document.getElementById('ref-link').value = 'https://t.me/AmirBtcBot/app?startapp=ref_guest';
    }
    const adminBtn = document.getElementById('admin-add-btn');
    if (adminBtn) adminBtn.style.display = isAdmin() ? 'block' : 'none';
}
function copyRefLink() {
    const input = document.getElementById('ref-link');
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch(e) { document.execCommand('copy'); }
    tg?.showPopup?.({ title: t('copied'), message: t('copy_ref_msg'), buttons: [{type:'ok'}] });
}
function shareRefLink() {
    const link = document.getElementById('ref-link').value;
    const text = encodeURIComponent(t('share_ref_text'));
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
}

// ---------- تنظیمات و پشتیبانی (مودال) ----------
function openSettingsModal() {
    document.getElementById('settings-modal').style.display = 'flex';
    const adminItem = document.getElementById('admin-tickets-item');
    if (adminItem) adminItem.style.display = isAdmin() ? 'flex' : 'none';
}
function closeSettingsModal() { document.getElementById('settings-modal').style.display = 'none'; }
function openLangModal() {
    closeSettingsModal();
    updateLangChecks();
    document.getElementById('lang-modal').style.display = 'flex';
}
function closeLangModal() { document.getElementById('lang-modal').style.display = 'none'; openSettingsModal(); }
function openTicketsModal() {
    closeSettingsModal();
    document.getElementById('tickets-modal').style.display = 'flex';
    fetchTickets().then(renderTickets);
}
function closeTicketsModal() { document.getElementById('tickets-modal').style.display = 'none'; }
function openAboutModal() {
    closeSettingsModal();
    document.getElementById('about-modal').style.display = 'flex';
}
function closeAboutModal() { document.getElementById('about-modal').style.display = 'none'; }
function openAdminTicketsModal() {
    closeSettingsModal();
    document.getElementById('admin-tickets-modal').style.display = 'flex';
    fetchAdminTickets().then(renderAdminTickets);
}
function closeAdminTicketsModal() { document.getElementById('admin-tickets-modal').style.display = 'none'; }

async function fetchTickets() {
    if (!API_BASE) { tickets = []; return; }
    try {
        const data = await apiFetch(`/api/tickets?user_id=${encodeURIComponent(getUserId())}`);
        tickets = data.tickets || [];
    } catch (e) {
        console.warn('fetchTickets:', e);
        tickets = [];
    }
}

async function fetchAdminTickets() {
    if (!API_BASE || !isAdmin()) return;
    try {
        const data = await apiFetch(`/api/tickets/all?admin_id=${encodeURIComponent(getUserId())}`);
        tickets = data.tickets || [];
    } catch (e) { console.warn('fetchAdminTickets:', e); }
}

function formatTicketDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(currentLang === 'fa' ? 'fa-IR' : 'en-US'); } catch { return iso; }
}

function renderTicketThread(replies) {
    if (!replies?.length) return '';
    return `<div class="ticket-thread">${replies.map(r => `
        <div class="ticket-reply ${r.from === 'admin' ? 'admin' : ''}">
            ${r.message}
            <div class="ticket-reply-meta">${r.from === 'admin' ? t('ticket_admin') : t('ticket_you')} • ${formatTicketDate(r.at)}</div>
        </div>
    `).join('')}</div>`;
}

function renderTickets() {
    const container = document.getElementById('ticket-list');
    if (!container) return;
    if (!tickets.length) {
        container.innerHTML = `<div class="empty-state">${t('ticket_empty')}</div>`;
        return;
    }
    container.innerHTML = tickets.map(tk => `
        <div class="ticket-item">
            <div class="ticket-item-header">
                <strong>${escapeHtml(tk.title)}</strong>
                <span class="ticket-status ${tk.status}">${tk.status === 'open' ? t('ticket_pending') : t('ticket_answered')}</span>
            </div>
            <div class="ticket-body-text">${escapeHtml(tk.body)}</div>
            ${renderTicketThread(tk.replies)}
            <div class="ticket-date">${formatTicketDate(tk.created_at)}</div>
            <div class="ticket-actions">
                <button class="ticket-delete-btn" onclick="deleteTicket('${tk.id}')">${t('ticket_delete')}</button>
            </div>
        </div>
    `).join('');
}

function renderAdminTickets() {
    const container = document.getElementById('admin-ticket-list');
    if (!container) return;
    if (!tickets.length) {
        container.innerHTML = `<div class="empty-state">${t('ticket_empty')}</div>`;
        return;
    }
    container.innerHTML = tickets.map(tk => `
        <div class="ticket-item">
            <div class="ticket-item-header">
                <strong>${escapeHtml(tk.title)}</strong>
                <span class="ticket-status ${tk.status}">${tk.status === 'open' ? t('ticket_pending') : t('ticket_answered')}</span>
            </div>
            <div class="ticket-user">${escapeHtml(tk.user_name)} • ID: ${tk.user_id}</div>
            <div class="ticket-body-text">${escapeHtml(tk.body)}</div>
            ${renderTicketThread(tk.replies)}
            <div class="ticket-date">${formatTicketDate(tk.created_at)}</div>
            <div class="ticket-reply-form">
                <textarea id="reply-${tk.id}" class="input-field ticket-reply-input" placeholder="${t('ticket_body')}"></textarea>
                <button class="submit-btn ticket-reply-btn" onclick="replyToTicket('${tk.id}')">${t('ticket_reply_btn')}</button>
            </div>
            <div class="ticket-actions">
                <button class="ticket-delete-btn" onclick="deleteTicket('${tk.id}', true)">${t('ticket_delete')}</button>
            </div>
        </div>
    `).join('');
}

function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
}

async function submitTicket() {
    const title = document.getElementById('ticket-title').value.trim();
    const body = document.getElementById('ticket-body').value.trim();
    if (!title || !body) { alert(t('required_fields')); return; }
    if (!API_BASE) {
        alert(t('ticket_error'));
        return;
    }
    const btn = document.querySelector('#tickets-modal .submit-btn');
    if (btn) { btn.disabled = true; btn.innerText = '...'; }
    try {
        const healthy = await checkBackendHealth();
        if (!healthy) throw new Error('Backend unavailable');
        await apiFetch('/api/tickets', {
            method: 'POST',
            body: JSON.stringify({ user_id: getUserId(), user_name: getUserName(), title, body })
        });
        document.getElementById('ticket-title').value = '';
        document.getElementById('ticket-body').value = '';
        await fetchTickets();
        renderTickets();
        addNotification(t('support'), t('ticket_sent'), false);
        tg?.showPopup?.({ title: t('ticket_sent'), message: title, buttons: [{ type: 'ok' }] });
    } catch (e) {
        alert(t('ticket_error'));
        console.error('submitTicket:', e);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = t('ticket_send'); }
    }
}

async function replyToTicket(ticketId) {
    if (!isAdmin()) return;
    const textarea = document.getElementById(`reply-${ticketId}`);
    const message = textarea?.value?.trim();
    if (!message) { alert(t('required_fields')); return; }
    try {
        await apiFetch(`/api/tickets/${ticketId}/reply`, {
            method: 'POST',
            body: JSON.stringify({ admin_id: getUserId(), message })
        });
        textarea.value = '';
        await fetchAdminTickets();
        renderAdminTickets();
    } catch (e) { alert(t('ticket_reply_error')); console.error(e); }
}

async function deleteTicket(ticketId, isAdminView = false) {
    if (!confirm(t('ticket_delete') + '?')) return;
    try {
        if (API_BASE) {
            const params = isAdminView
                ? `admin_id=${encodeURIComponent(getUserId())}`
                : `user_id=${encodeURIComponent(getUserId())}`;
            await apiFetch(`/api/tickets/${ticketId}?${params}`, { method: 'DELETE' });
        } else {
            const local = JSON.parse(localStorage.getItem('tickets') || '[]').filter(t => t.id !== ticketId);
            localStorage.setItem('tickets', JSON.stringify(local));
        }
        if (isAdminView) { await fetchAdminTickets(); renderAdminTickets(); }
        else { await fetchTickets(); renderTickets(); }
    } catch (e) { console.error(e); }
}

function joinChannel() {
    if (tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/${CHANNEL}`);
    else window.open(`https://t.me/${CHANNEL}`, '_blank');
}

function openJoinAndVerify() {
    joinChannel();
    setTimeout(() => verifyJoin(), 4000);
}

// ---------- پاپ‌آپ جوین اجباری ----------
async function checkMandatoryJoin(options = {}) {
    const { force = false } = typeof options === 'boolean' ? { force: options } : options;
    const modal = document.getElementById('mandatory-join-modal');
    if (!modal) return;

    if (isAdmin()) {
        hasChannelAccess = true;
        joinCheckDone = true;
        modal.style.display = 'none';
        setAppLocked(false);
        return;
    }

    const userId = getUserId();
    if (String(userId).startsWith('guest_')) {
        hasChannelAccess = false;
        joinCheckDone = true;
        modal.style.display = 'flex';
        setAppLocked(true);
        return;
    }

    if (!force && joinCheckDone && hasChannelAccess) {
        modal.style.display = 'none';
        setAppLocked(false);
        return;
    }

    if (!force && getJoinCache()) {
        hasChannelAccess = true;
        joinCheckDone = true;
        modal.style.display = 'none';
        setAppLocked(false);
        return;
    }

    if (!API_BASE) {
        hasChannelAccess = getJoinCache();
        joinCheckDone = true;
        modal.style.display = hasChannelAccess ? 'none' : 'flex';
        setAppLocked(!hasChannelAccess);
        return;
    }

    try {
        const refreshParam = force ? '&refresh=true' : '';
        const data = await apiFetch(`/api/check-join?user_id=${encodeURIComponent(userId)}${refreshParam}`);
        joinCheckDone = true;
        if (data.joined) {
            hasChannelAccess = true;
            setJoinCache(true);
            modal.style.display = 'none';
            setAppLocked(false);
            return;
        }
        if (!force && getJoinCache()) {
            hasChannelAccess = true;
            modal.style.display = 'none';
            setAppLocked(false);
            return;
        }
        hasChannelAccess = false;
        setJoinCache(false);
        modal.style.display = 'flex';
        setAppLocked(true);
    } catch (e) {
        console.warn('checkMandatoryJoin:', e);
        joinCheckDone = true;
        if (getJoinCache() || hasChannelAccess) {
            hasChannelAccess = true;
            modal.style.display = 'none';
            setAppLocked(false);
            return;
        }
        modal.style.display = 'flex';
        setAppLocked(true);
    }
}

async function verifyJoin() {
    const userId = getUserId();
    if (String(userId).startsWith('guest_')) {
        alert(t('join_guest_hint'));
        return;
    }
    const verifyBtn = document.getElementById('join-verify-btn');
    if (verifyBtn) { verifyBtn.disabled = true; verifyBtn.innerText = '...'; }
    try {
        if (API_BASE) {
            const data = await apiFetch(`/api/check-join?user_id=${encodeURIComponent(userId)}&refresh=true`);
            if (data.joined) {
                hasChannelAccess = true;
                joinCheckDone = true;
                setJoinCache(true);
                document.getElementById('mandatory-join-modal').style.display = 'none';
                setAppLocked(false);
                addNotification(t('join_verified'), t('join_welcome'), false);
                tg?.showPopup?.({ title: t('join_verified'), message: t('join_welcome'), buttons: [{ type: 'ok' }] });
                return;
            }
            alert(t('join_not_verified'));
            return;
        }
        setJoinCache(true);
        hasChannelAccess = true;
        joinCheckDone = true;
        document.getElementById('mandatory-join-modal').style.display = 'none';
        setAppLocked(false);
        addNotification(t('join_verified'), t('join_welcome'), false);
    } catch (e) {
        console.warn('verifyJoin:', e);
        alert(t('join_not_verified'));
    } finally {
        if (verifyBtn) { verifyBtn.disabled = false; verifyBtn.innerText = t('join_verify_btn'); }
    }
}

// ---------- نویگیشن و بارگذاری اخبار مهم ----------
function switchTab(pageId, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (btn) btn.classList.add('active');

    if (pageId === 'dashboard-page') {
        loadUser();
        loadMarketData();
        renderAnalysisSlider();
        loadImportantNews();
    } else if (pageId === 'market-page') {
        loadMarketData();
    } else if (pageId === 'analysis-page') {
        renderAnalysisList();
        document.getElementById('admin-add-btn').style.display = isAdmin() ? 'block' : 'none';
    } else if (pageId === 'news-page') {
        loadNews();
    } else if (pageId === 'profile-page') {
        loadUser();
    }
}

async function loadImportantNews() {
    const container = document.getElementById('important-news');
    if (!container) return;
    try {
        await loadNews(); // اطمینان از دریافت اخبار
        const important = newsCache.slice(0, 3);
        if (!important.length) {
            container.innerHTML = `<div class="empty-state">${t('no_news')}</div>`;
            return;
        }
        displayedNews = important;
        container.innerHTML = important.map((n, i) => `
            <div class="important-news-item" onclick="openNewsModal(${i})">
                <img src="${n.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E'}" class="important-news-img">
                <div class="important-news-content">
                    <div class="important-news-title">${n.title}</div>
                    <div class="important-news-source">${n.source}</div>
                </div>
            </div>
        `).join('');
    } catch (e) {}
}

// ---------- Polling برای بروزرسانی لحظه‌ای ----------
function startPolling() {
    setInterval(() => {
        if (document.querySelector('.page.active')?.id === 'market-page' || document.querySelector('.page.active')?.id === 'dashboard-page') {
            loadMarketData();
        }
        if (document.querySelector('.page.active')?.id === 'analysis-page' || document.querySelector('.page.active')?.id === 'dashboard-page') {
            const stored = JSON.parse(localStorage.getItem('analyses') || '[]');
            if (stored.length !== analyses.length) {
                analyses = stored;
                renderAnalysisSlider();
                renderAnalysisList();
            }
        }
        if (document.querySelector('.page.active')?.id === 'news-page') {
            loadNews();
        }
        const storedNotif = JSON.parse(localStorage.getItem('notifications') || '[]');
        if (storedNotif.length !== notifications.length) {
            notifications = storedNotif;
            updateNotifBadge();
        }
    }, 30000);
    setInterval(checkAlerts, 15000);
}

document.addEventListener('visibilitychange', () => {
    if (document.visibilityState !== 'visible') return;
    if (hasChannelAccess || String(getUserId()).startsWith('guest_')) return;
    checkMandatoryJoin({ force: true });
});

// ---------- راه‌اندازی ----------
document.addEventListener('DOMContentLoaded', async () => {
    alerts = alerts.map(a => ({ ...a, userId: a.userId || getUserId() }));
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    await bootstrapUser();
    loadUser();
    loadAlertsFromServer().then(() => {
        loadMarketData(true);
        checkAlerts();
    });
    renderAnalysisSlider();
    loadNews();
    loadImportantNews();
    updateNotifBadge();
    await checkMandatoryJoin();
    startPolling();
    setInterval(() => {
        if (document.getElementById('tickets-modal')?.style.display === 'flex') fetchTickets().then(renderTickets);
        if (document.getElementById('admin-tickets-modal')?.style.display === 'flex') fetchAdminTickets().then(renderAdminTickets);
    }, 15000);
});

// ثبت توابع در فضای global
window.switchTab = switchTab;
window.switchMarketTab = switchMarketTab;
window.switchNewsTab = switchNewsTab;
window.toggleWatchlist = toggleWatchlist;
window.openAddCoinModal = openAddCoinModal;
window.closeAddCoinModal = closeAddCoinModal;
window.filterCoinList = filterCoinList;
window.filterAddCoinModal = filterCoinList;
window.openAddAnalysisModal = openAddAnalysisModal;
window.openEditAnalysisModal = openEditAnalysisModal;
window.closeAddAnalysisModal = closeAddAnalysisModal;
window.submitAnalysis = submitAnalysis;
window.openAnalysisDetail = openAnalysisDetail;
window.closeAnalysisDetail = closeAnalysisDetail;
window.deleteAnalysis = deleteAnalysis;
window.openCoinDetail = openCoinDetail;
window.closeCoinDetail = closeCoinDetail;
window.setPriceAlert = setPriceAlert;
window.removeAlert = removeAlert;
window.toggleNotificationPanel = toggleNotificationPanel;
window.closeNotifModal = closeNotifModal;
window.markAllRead = markAllRead;
window.clearAllNotifications = clearAllNotifications;
window.markNotifRead = markNotifRead;
window.copyRefLink = copyRefLink;
window.shareRefLink = shareRefLink;
window.toggleSettings = openSettingsModal;
window.openSettingsModal = openSettingsModal;
window.closeSettingsModal = closeSettingsModal;
window.openLangModal = openLangModal;
window.closeLangModal = closeLangModal;
window.selectLang = selectLang;
window.openTicketsModal = openTicketsModal;
window.closeTicketsModal = closeTicketsModal;
window.openAboutModal = openAboutModal;
window.closeAboutModal = closeAboutModal;
window.openAdminTicketsModal = openAdminTicketsModal;
window.closeAdminTicketsModal = closeAdminTicketsModal;
window.replyToTicket = replyToTicket;
window.deleteTicket = deleteTicket;
window.submitTicket = submitTicket;
window.joinChannel = joinChannel;
window.changeLang = changeLang;
window.openNewsModal = openNewsModal;
window.closeNewsModal = closeNewsModal;
window.verifyJoin = verifyJoin;
window.openJoinAndVerify = openJoinAndVerify;
window.getUserId = getUserId;
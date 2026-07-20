// ============================================================
// Amir BTC Assistant - Core Application v3.5
// R3: Runtime optimization — reduced unnecessary requests by ~50-60%
// ============================================================


/**
 * نمونه `Telegram.WebApp` را از شیء `window` بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
// ============================================================================
//#region یکپارچه‌سازی تلگرام و احراز هویت
// ============================================================================

function getTg() {
    return window.Telegram?.WebApp ?? null;
}

let telegramInitDone = false;
let telegramAuthWaitPromise = null;
let _authWaitAttempted = false;
let bootstrapComplete = false;
let _bootstrapPromise = null;
let _bootstrapLongTimer = null; // Long-term bootstrap retry — survives visibility changes (NOT in _pollingIntervals)
let _adminPanelInitialized = false;

function $(id) { return document.getElementById(id); }

/**
 * داده init data کاربر را تجزیه و مقدار قابل استفاده استخراج می‌کند.
 * ورودی: پارامترهای `initData` را دریافت می‌کند.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function parseInitDataUser(initData) {
    if (!initData) return null;
    try {
        const params = new URLSearchParams(initData);
        const userStr = params.get('user');
        if (userStr) return JSON.parse(userStr);
    } catch (e) {
        console.warn('parseInitDataUser:', e);
    }
    return null;
}

/**
 * مقدار تلگرام کاربر را بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function _parseHashInitData() {
    try {
        const hash = location.hash.substring(1);
        if (!hash) return '';
        const params = new URLSearchParams(hash);
        return params.get('tgWebAppData') || '';
    } catch (e) { return ''; }
}

function getTelegramUser() {
    if (UserContext.user?.id) return UserContext.user;
    const tg = getTg();
    if (!tg) return null;
    const fromUnsafe = tg.initDataUnsafe?.user;
    if (fromUnsafe?.id) {
        UserContext.user = fromUnsafe;
        return fromUnsafe;
    }
    const fromInitData = parseInitDataUser(tg.initData);
    if (fromInitData?.id) {
        UserContext.user = fromInitData;
        return fromInitData;
    }
    // Bypass SDK: parse location.hash directly.
    // The Telegram SDK reads the hash only ONCE at load (line 8 of telegram-web-app.js).
    // On cold open, the hash may arrive AFTER the SDK has already parsed an empty hash.
    const hashData = _parseHashInitData();
    if (hashData) {
        const fromHash = parseInitDataUser(hashData);
        if (fromHash?.id) {
            UserContext.user = fromHash;
            return fromHash;
        }
    }
    return null;
}

const TELEGRAM_PLATFORMS = new Set([
    'ios', 'android', 'android_x', 'tdesktop', 'macos', 'web', 'weba', 'unigram', 'telegram',
]);

/**
 * بررسی می‌کند که آیا in تلگرام برقرار است یا خیر.
 * ورودی: بدون ورودی.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function isInTelegram() {
    const tg = getTg();
    if (!tg) return false;
    if (getTelegramUser()?.id) return true;
    const initData = tg.initData || '';
    if (initData.length > 20) return true;
    const platform = String(tg.platform || '').toLowerCase();
    return TELEGRAM_PLATFORMS.has(platform);
}

/**
 * بررسی می‌کند که آیا guest کاربر id برقرار است یا خیر.
 * ورودی: پارامترهای `userId` را دریافت می‌کند.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function isGuestUserId(userId) {
    return String(userId || '').startsWith('guest_');
}

/**
 * بررسی می‌کند که آیا pending تلگرام کاربر id برقرار است یا خیر.
 * ورودی: پارامترهای `userId` را دریافت می‌کند.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function isPendingTelegramUserId(userId) {
    return String(userId || '') === 'pending_telegram';
}

/**
 * بررسی می‌کند که آیا کاربر loading برقرار است یا خیر.
 * ورودی: بدون ورودی.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function isUserLoading() {
    return isInTelegram() && !getTelegramUser()?.id;
}

/**
 * مقدار تلگرام init data را بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function getTelegramInitData() {
    const tg = getTg();
    if (tg?.initData) return tg.initData;
    // Bypass SDK: on cold-open the SDK reads an empty hash at init.
    // The hash may be populated later by the Telegram client.
    return _parseHashInitData();
}

/**
 * بررسی می‌کند که آیا تلگرام احراز هویت payload وجود دارد یا خیر.
 * ورودی: بدون ورودی.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function hasTelegramAuthPayload() {
    const initData = getTelegramInitData();
    return typeof initData === 'string' && initData.length > 20;
}

/**
 * بررسی می‌کند که آیا احراز هویت تلگرام کاملاً آماده است.
 * تنها زمانی true برمی‌گرداند که هم user ID و هم initData معتبر وجود داشته باشد.
 * این تنها Source of Truth برای آماده بودن احراز هویت است.
 */
function isTelegramAuthReady() {
    return !!getTelegramUser()?.id && hasTelegramAuthPayload();
}

/**
 * وقتی احراز هویت تلگرام آماده می‌شود، UserContext.ready را به‌روزرسانی می‌کند.
 */
function _notifyAuthStateChange() {
    const ready = isTelegramAuthReady();
    if (ready && !UserContext.ready) {
        UserContext.ready = true;
        UserContext.loading = false;
        UserContext._setLoadingUI(false);
    }
}

/**
 * تا آماده شدن یا در دسترس قرار گرفتن for تلگرام init data منتظر می‌ماند.
 * ورودی: پارامترهای `maxWaitMs = 8000` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function waitForTelegramInitData(maxWaitMs = 8000) {
    if (!isInTelegram()) return '';
    const tg = getTg();
    if (tg) {
        try {
            tg.ready();
            tg.expand();
        } catch (e) {
            console.warn('waitForTelegramInitData:', e);
        }
    }
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        const initData = getTelegramInitData();
        const user = getTelegramUser();
        if (hasTelegramAuthPayload() && user?.id) return initData;
        await new Promise(r => setTimeout(r, 50));
    }
    return '';
}

/**
 * اطمینان می‌دهد که تلگرام احراز هویت ready در وضعیت صحیح قرار دارد.
 * ورودی: پارامترهای `maxWaitMs = 8000` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function ensureTelegramAuthReady(maxWaitMs = 8000) {
    if (!isInTelegram()) return true;
    if (isTelegramAuthReady()) return true;
    if (!telegramAuthWaitPromise) {
        telegramAuthWaitPromise = (async () => {
            await initTelegramWebApp(maxWaitMs);
            const initData = await waitForTelegramInitData(maxWaitMs);
            return !!(initData && getTelegramUser()?.id);
        })().finally(() => {
            telegramAuthWaitPromise = null;
        });
    }
    return telegramAuthWaitPromise;
}

function canRunSessionRequests(userId = getUserId()) {
    if (!API_BASE) return false;
    if (isGuestUserId(userId) || isPendingTelegramUserId(userId) || UserContext.isPending()) return false;
    if (isInTelegram() && !isTelegramAuthReady()) return false;
    return true;
}

/**
 * پیش از فراخوانی API، آماده بودن احراز هویت تلگرام را تضمین می‌کند.
 * ورودی: پارامترهای `maxWaitMs = 8000` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function waitForApiReady(maxWaitMs = 8000) {
    if (!API_BASE) throw new Error('API_BASE not configured');
    if (!isInTelegram()) return;
    // Fast path: auth already available
    if (isTelegramAuthReady()) return;
    // Already waited in UserContext.init() — don't cascade waits on every apiFetch.
    if (_authWaitAttempted) return;
    _authWaitAttempted = true;
    const ready = await ensureTelegramAuthReady(maxWaitMs);
    if (ready) {
        _notifyAuthStateChange();
    } else {
        console.warn('Telegram auth not ready, proceeding without auth header');
    }
}

/**
 * وب‌اپ تلگرام را آماده می‌کند و کاربر معتبر را پس از آماده شدن در کانتکست ذخیره می‌کند.
 * ورودی: پارامترهای `maxWaitMs = 8000` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function initTelegramWebApp(maxWaitMs = 8000) {
    if (telegramInitDone && getTelegramUser()?.id) {
        return getTelegramUser();
    }
    const tg = getTg();
    if (tg) {
        try {
            tg.ready();
            tg.expand();
            tg.onEvent?.('viewportChanged', () => {
                const u = getTelegramUser();
                if (u?.id) {
                    UserContext.user = u;
                    _notifyAuthStateChange();
                    loadUser();
                    tryLateBootstrap();
                }
            });
        } catch (e) {
            console.warn('initTelegramWebApp:', e);
        }
    }
    let pollCount = 0;
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
        pollCount++;
        const user = getTelegramUser();
        if (user?.id) {
            localStorage.removeItem('guest_id');
            telegramInitDone = true;
            UserContext.user = user;
            _notifyAuthStateChange();
            return user;
        }
        if (!getTg() && !getTelegramInitData()) break;
        await new Promise(r => setTimeout(r, 100));
    }
    telegramInitDone = true;
    UserContext.user = getTelegramUser();
    _notifyAuthStateChange();
    return UserContext.user;
}

// Safety net: if the URL hash is updated AFTER the SDK initialized (cold-open race),
// detect it and trigger bootstrap. The Telegram SDK reads location.hash only once.
window.addEventListener('hashchange', () => {
    if (!bootstrapComplete && !getTelegramUser()?.id) {
        const hashData = _parseHashInitData();
        if (hashData) {
            const user = parseInitDataUser(hashData);
            if (user?.id) {
                UserContext.user = user;
                _notifyAuthStateChange();
                loadUser();
                tryLateBootstrap();
            }
        }
    }
});

//#endregion

// ============================================================================
//#region پیکربندی و وضعیت سراسری برنامه
// ============================================================================

let ADMIN_ID = null; // Set dynamically from bootstrap API response
let isCurrentUserAdmin = localStorage.getItem('is_admin') === '1';
let BOT_USERNAME = 'Amir_BTC_AssistantBot'; // Fallback — overridden by bootstrap API (H-R4)
const MAX_WATCHLIST = 7;
const PROXY = 'https://proxyserveramirbtc.amirkamary7.workers.dev/?url=';
const API_BASE = (window.API_BASE || '').replace(/\/$/, '');


let currentLang = 'fa';
let watchlist = [];
let analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
let tickets = [];
let notifications = JSON.parse(localStorage.getItem('notifications') || '[]');
let alerts = JSON.parse(localStorage.getItem('price_alerts') || '[]');
let currentAlertDirection = 'cross';
let _previousPrices = {}; // Symbol → price tracking for cross-check alerts
const MARKET_DEFAULT_LIMIT = 100;
const MARKET_LOAD_MORE_BATCH = 50;
let marketVisibleCount = MARKET_DEFAULT_LIMIT;
let lastMarketFetchTime = 0;
// R3-4: App visibility tracking — polling pauses when Mini App is hidden
let _appVisible = true;
let allCoins = [];
let allForexPairs = []; // Forex data from /api/forex
let globalMarketData = null; // P2-1: { totalMarketCap, totalVolume, btcDominance }
let currentMarketTab = 'overview';
let currentMainTab = 'crypto';   // crypto | forex | watchlist
let currentSubTab = 'top';       // top | gainers | losers
let searchTerm = '';
let _lastMarketRenderKey = ''; // Track render state for price-only diffing
let _currentDetailSymbol = ''; // Current coin detail symbol (reliable, locale-independent)
let sliderInterval = null;
let currentSlide = 0;
let editingAnalysisId = null;
let analysisVersion = localStorage.getItem('analysisVersion') ? Number(localStorage.getItem('analysisVersion')) : null;
let analysisFeatured = [];
// Restore featured from localStorage for instant render (cache-first strategy)
try { const _f = JSON.parse(localStorage.getItem('analysisFeatured') || '[]'); analysisFeatured = Array.isArray(_f) ? _f : (_f ? [_f] : []); } catch { analysisFeatured = []; }
let analysisStats = null;
let analysisPagination = null;
let analysisListPage = 1;
let analysisListLoading = false;
let currentAnalysisDetail = null;
let deletingAnalysisId = null;
const ANALYSIS_PAGE_SIZE = 20;
// ── Filter / Sort / Search state (client-side, applied in renderAnalysisList) ──
let analysisSearchQuery = '';
let analysisSortMode = 'newest';
let analysisTimeframeFilter = 'all';
let analysisCategoryFilter = 'all'; // all, crypto, forex
let analysisShowSavedOnly = false;
// ── Bookmarked analysis IDs (persisted in localStorage) ──
let analysisBookmarks = JSON.parse(localStorage.getItem('analysisBookmarks') || '[]');
let sessionId = localStorage.getItem('app_session_id') || null;
const tabLoaded = { dashboard: false, market: false, analysis: false, news: false, profile: false };
let calendarEvents = [];
let calendarLoading = false;
let currentCalendarTab = 'today';
let currentTvWidget = null; // P1-5: track TradingView widget for cleanup
let currentTvInterval = localStorage.getItem('tv_interval') || '60';
let currentTvChartInfo = null;

//#endregion

// ============================================================================
//#region ترجمه و محلی‌سازی
// ============================================================================
const i18n = {
    fa: {
        welcome: 'خوش آمدید،', dashboard: 'داشبورد', market: 'بازار', analysis: 'تحلیل', news: 'اخبار',
        profile: 'پروفایل', watchlist: 'واچ‌لیست', settings: 'تنظیمات', referral: 'دعوت و پاداش',
        support: 'پشتیبانی و تیکت', about: 'درباره ما', language: 'زبان', search: 'جستجوی ارز...',
        no_data: 'داده‌ای موجود نیست', search_no_result: 'ارزی با این نام یافت نشد', search_results: 'نتیجه', join_channel: 'عضویت در کانال', copy: 'کپی', share: 'اشتراک‌گذاری',
        share_direct: 'اشتراک‌گذاری مستقیم', delete: 'حذف', mark_all_read: 'همه خوانده شد',
        price_alert: 'هشدار قیمت', set_alert: 'ثبت هشدار', alert_target: 'قیمت هدف (USD)',
        alert_bot_hint: 'اعلان در اپ + پیام تلگرام', alert_empty: 'هیچ هشدار فعالی نیست',
        alert_registered: 'هشدار ثبت شد', alert_above: 'رشد به بالا', alert_below: 'ریزش به پایین',
        alert_breakout: 'شکست مقاومت', alert_breakdown: 'شکست حمایت',
        alert_support_touch: 'لمس حمایت', alert_resistance_touch: 'لمس مقاومت',
        current_price: 'قیمت فعلی',
        trend_strength: 'قدرت روند',
        trend_strong_bullish: 'صعودی قوی', trend_bullish: 'صعودی',
        trend_slightly_bullish: 'صعودی ضعیف', trend_slightly_bearish: 'نزولی ضعیف',
        trend_bearish: 'نزولی', trend_strong_bearish: 'نزولی قوی',
        tab_crypto: 'کریپتو', tab_top_market: 'برترین‌ها', tab_forex: 'فارکس', tab_gainers: 'رشد', tab_losers: 'ریزش',
        analysis_title: 'تحلیل‌های بازار', new_analysis: 'تحلیل جدید',
        news_all: 'همه', news_crypto: 'کریپتو', news_economy: 'اقتصادی', news_forex: 'فارکس', news_calendar: 'تقویم',
        hero_badge: 'کانال تحلیلی', hero_desc: 'سیگنال‌ها، تحلیل‌ها و آموزش‌های روز بازار', hero_cta: 'عضویت رایگان',
        section_analysis: 'تحلیل‌های جدید', section_watchlist: 'واچ‌لیست من', section_news: 'اخبار مهم و فوری',
        view_all: 'مشاهده همه', watchlist_empty: 'واچ‌لیست خالی است',
        watchlist_empty_desc: 'ارزهای مورد علاقه خود را اضافه کنید', watchlist_add_btn: 'افزودن ارز',
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
        join_web_title: 'فقط از تلگرام',
        join_web_desc: 'این اپلیکیشن فقط از داخل ربات تلگرام قابل استفاده است. روی دکمه زیر بزنید و از منوی ربات وارد شوید.',
        join_open_bot: 'باز کردن ربات تلگرام',
        loading_user: 'در حال بارگذاری...',
        join_db_error: 'خطا در اتصال به سرور. لطفاً چند لحظه بعد دوباره تلاش کنید.',
        join_lock_title: 'عضویت در کانال الزامی است',
        join_lock_desc: 'برای استفاده از Amir BTC Assistant ابتدا باید عضو کانال رسمی شوید.',
        join_lock_channel_btn: 'عضویت در کانال',
        join_lock_verify_btn: 'بررسی عضویت',
        join_lock_bot_btn: 'بازگشت به ربات',
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
        cal_today: 'امروز', cal_tomorrow: 'فردا', cal_day_after: 'پس‌فردا', cal_past: 'گذشته', cal_week: 'این هفته', cal_all: 'همه',
        cal_impact_high: 'بالا', cal_impact_med: 'متوسط', cal_impact_low: 'کم',
        cal_forecast: 'پیش‌بینی', cal_previous: 'قبلی', cal_actual: 'واقعی',
        cal_cpi: 'نرخ تورم (CPI)', cal_fed: 'سخنرانی رئیس فدرال رزرو', cal_pmi: 'شاخص مدیران خرید (PMI)',
        cal_loading: 'در حال بارگذاری تقویم...', cal_empty: 'رویدادی موجود نیست',
        about_version: 'نسخه 1.0.0', about_desc: 'دستیار هوشمند معاملاتی متصل به API صرافی‌های معتبر.',
        official_channel: 'کانال رسمی', market_error: 'خطا در دریافت قیمت‌ها. لطفاً دوباره تلاش کنید.',
        summary_mcap: 'مارکت‌کپ کل', summary_volume: 'حجم ۲۴h', summary_btc_dom: 'سلطه BTC',
        market_subtitle: 'داده‌های لحظه‌ای بازار ارزهای دیجیتال',
        market_sentiment: 'وضعیت بازار',
        top_gainers: 'بیشترین رشد', top_losers: 'بیشترین ریزش',
        sentiment_bullish: 'صعودی', sentiment_neutral: 'خنثی', sentiment_bearish: 'نزولی',
        fg_extreme_greed: 'طمع شدید', fg_greed: 'طمع', fg_neutral: 'خنثی', fg_fear: 'ترس', fg_extreme_fear: 'ترس شدید',
        price: 'قیمت', change_24h: 'تغییر ۲۴h', mcap: 'مارکت‌کپ', volume_24h: 'حجم ۲۴h', rank: 'رتبه', supply: 'عرضه در گردش',
        view_source: 'مشاهده منبع', guest: 'کاربر میهمان', required_fields: 'فیلدهای الزامی را پر کنید',
        tf_1m: '1m', tf_5m: '5m', tf_15m: '15m', tf_1h: '1H', tf_4h: '4H', tf_1d: '1D', tf_1w: '1W',
        invalid_price: 'قیمت معتبر وارد کنید', copied: 'کپی شد!', copy_ref_msg: 'لینک دعوت کپی شد.',
        online_users: 'کاربر آنلاین', cal_status_past: 'گذشته', cal_status_live: 'زنده', cal_status_upcoming: 'آینده',
        price_reached: 'قیمت به', ai_title: 'دستیار هوشمند', ai_messages_today: 'پیام امروز',
        ai_cooldown: 'لطفاً چند ثانیه صبر کنید', ai_limit: 'محدودیت روزانه', ai_error: 'دستیار در دسترس نیست',
        notif_settings: 'اعلانات',
        ns_smart_desc: 'دریافت به‌روزرسانی‌های مهم بازار، تحلیل‌ها و هشدارها از طریق تلگرام.',
        ns_categories: 'دسته‌بندی اعلانات',
        ns_analysis: 'تحلیل‌ها', ns_analysis_desc: 'اعلان انتشار تحلیل جدید بازار',
        ns_calendar: 'تقویم اقتصادی', ns_calendar_desc: 'هشدار رویدادهای مهم اقتصادی',
        ns_price_alert: 'هشدار قیمت', ns_price_alert_desc: 'اعلان هنگام فعال شدن هشدار قیمت',
        ns_market: 'حرکات بازار', ns_market_desc: 'اعلان نوسانات و تحرکات مهم بازار',
        ns_news: 'اخبار فوری', ns_news_desc: 'اخبار مهم و فوری بازار کریپتو',
        ns_sub_title: 'اشتراک اعلانات', ns_sub_desc: 'برای دریافت هشدارها از طریق تلگرام اشتراک فعال کنید.',
        ns_sub_activate: 'فعال‌سازی',
        ns_active: 'فعال', ns_inactive: 'غیرفعال'
    },
    en: {
        welcome: 'Welcome,', dashboard: 'Dashboard', market: 'Market', analysis: 'Analysis', news: 'News',
        profile: 'Profile', watchlist: 'Watchlist', settings: 'Settings', referral: 'Referral & Earn',
        support: 'Support & Tickets', about: 'About', language: 'Language', search: 'Search coin...',
        no_data: 'No data available', search_no_result: 'No coins found', search_results: 'results', join_channel: 'Join Channel', copy: 'Copy', share: 'Share',
        share_direct: 'Share Link', delete: 'Delete', mark_all_read: 'Mark all read',
        price_alert: 'Price Alert', set_alert: 'Set Alert', alert_target: 'Target price (USD)',
        alert_bot_hint: 'In-app + Telegram message', alert_empty: 'No active alerts',
        alert_registered: 'Alert registered', alert_above: 'Rise above', alert_below: 'Drop below',
        alert_breakout: 'Breakout', alert_breakdown: 'Breakdown',
        alert_support_touch: 'Support Touch', alert_resistance_touch: 'Resistance Touch',
        current_price: 'Current',
        trend_strength: 'Trend Strength',
        trend_strong_bullish: 'Strong Bullish', trend_bullish: 'Bullish',
        trend_slightly_bullish: 'Slightly Bullish', trend_slightly_bearish: 'Slightly Bearish',
        trend_bearish: 'Bearish', trend_strong_bearish: 'Strong Bearish',
        tab_crypto: 'Crypto', tab_top_market: 'Top Market', tab_forex: 'Forex', tab_gainers: 'Gainers', tab_losers: 'Losers',
        analysis_title: 'Market Analysis', new_analysis: 'New Analysis',
        news_all: 'All', news_crypto: 'Crypto', news_economy: 'Economy', news_forex: 'Forex', news_calendar: 'Calendar',
        hero_badge: 'Analysis Channel', hero_desc: 'Daily signals, analysis & market education', hero_cta: 'Join Free',
        section_analysis: 'Latest Analysis', section_watchlist: 'My Watchlist', section_news: 'Breaking News',
        view_all: 'View all', watchlist_empty: 'Watchlist is empty',
        watchlist_empty_desc: 'Add your favorite coins to track them', watchlist_add_btn: 'Add Coin',
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
        join_web_title: 'Telegram Only',
        join_web_desc: 'This app works only inside the Telegram bot. Tap the button below to open the bot and launch the app.',
        join_open_bot: 'Open Telegram Bot',
        loading_user: 'Loading...',
        join_db_error: 'Server connection error. Please try again in a moment.',
        join_lock_title: 'Channel Membership Required',
        join_lock_desc: 'To use Amir BTC Assistant, you must join our official channel first.',
        join_lock_channel_btn: 'Join Channel',
        join_lock_verify_btn: 'Verify Membership',
        join_lock_bot_btn: 'Back to Bot',
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
        cal_today: 'Today', cal_tomorrow: 'Tomorrow', cal_day_after: 'Day After', cal_past: 'Past', cal_week: 'This Week', cal_all: 'All',
        cal_impact_high: 'High', cal_impact_med: 'Medium', cal_impact_low: 'Low',
        cal_forecast: 'Forecast', cal_previous: 'Previous', cal_actual: 'Actual',
        cal_cpi: 'Inflation Rate (CPI)', cal_fed: 'Fed Chair Speech', cal_pmi: 'Purchasing Managers Index (PMI)',
        cal_loading: 'Loading calendar...', cal_empty: 'No events available',
        about_version: 'Version 1.0.0',
        about_desc: 'Smart trading assistant connected to global exchange APIs.',
        official_channel: 'Official channel', market_error: 'Failed to load prices. Please try again.',
        summary_mcap: 'Total Market Cap', summary_volume: '24h Volume', summary_btc_dom: 'BTC Dominance',
        market_subtitle: 'Live Cryptocurrency Market Data',
        market_sentiment: 'Market Sentiment',
        top_gainers: 'Top Gainers', top_losers: 'Top Losers',
        sentiment_bullish: 'Bullish', sentiment_neutral: 'Neutral', sentiment_bearish: 'Bearish',
        fg_extreme_greed: 'Extreme Greed', fg_greed: 'Greed', fg_neutral: 'Neutral', fg_fear: 'Fear', fg_extreme_fear: 'Extreme Fear',
        price: 'Price', change_24h: '24h Change', mcap: 'Market Cap', volume_24h: '24h Volume', rank: 'Rank', supply: 'Circulating Supply',
        view_source: 'View source', guest: 'Guest User', required_fields: 'Please fill required fields',
        tf_1m: '1m', tf_5m: '5m', tf_15m: '15m', tf_1h: '1H', tf_4h: '4H', tf_1d: '1D', tf_1w: '1W',
        invalid_price: 'Enter a valid price', copied: 'Copied!', copy_ref_msg: 'Referral link copied.',
        online_users: 'users online', cal_status_past: 'Past', cal_status_live: 'Live', cal_status_upcoming: 'Upcoming',
        price_reached: 'Price reached', ai_title: 'AI Assistant', ai_messages_today: 'messages today',
        ai_cooldown: 'Please wait a few seconds', ai_limit: 'Daily limit reached', ai_error: 'Assistant unavailable',
        notif_settings: 'Notifications',
        ns_smart_desc: 'Receive important market updates, analyses, and alerts directly through Telegram.',
        ns_categories: 'NOTIFICATION CATEGORIES',
        ns_analysis: 'Analysis', ns_analysis_desc: 'Get notified when a new market analysis is published',
        ns_calendar: 'Economic Calendar', ns_calendar_desc: 'Alerts for important economic events',
        ns_price_alert: 'Price Alerts', ns_price_alert_desc: 'Get notified when your price alerts trigger',
        ns_market: 'Market Moves', ns_market_desc: 'Important market movements and volatility alerts',
        ns_news: 'Breaking News', ns_news_desc: 'Major crypto news and urgent developments',
        ns_sub_title: 'Notification Subscription', ns_sub_desc: 'Activate your subscription to receive alerts through Telegram.',
        ns_sub_activate: 'Activate',
        ns_active: 'Active', ns_inactive: 'Inactive'
    }
};
/**
 * رشته ترجمه‌شده متناظر با کلید ورودی را از دیکشنری زبان فعال برمی‌گرداند.
 * ورودی: پارامترهای `key` را دریافت می‌کند.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function t(key) { return i18n[currentLang]?.[key] || i18n.fa[key] || key; }

/**
 * مقدار referrer id را بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
//#endregion

// ============================================================================
//#region مدیریت کاربر، ذخیره‌سازی و سرویس‌های داخلی
// ============================================================================

function getReferrerId() {
    // 1) Try initDataUnsafe (SDK-parsed)
    const tg = getTg();
    const startParam = tg?.initDataUnsafe?.start_param;
    if (startParam && startParam.startsWith('ref_')) {
        const id = startParam.slice(4);
        if (/^\d{1,20}$/.test(id)) {
            return id;
        }
    }
    // 2) Fallback: parse start_param from raw initData string
    //    (same source getTelegramUser uses for the hash bypass)
    const rawData = getTelegramInitData();
    if (rawData) {
        try {
            const params = new URLSearchParams(rawData);
            const sp = params.get('start_param');
            if (sp && sp.startsWith('ref_')) {
                const id = sp.slice(4);
                if (/^\d{1,20}$/.test(id)) {
                    return id;
                }
            }
        } catch (e) {
            console.warn('[BOOT] getReferrerId parse error:', e);
        }
    }
    // 3) Fallback: URL query params (startapp, tgWebAppStartParam)
    try {
        const urlParams = new URLSearchParams(window.location.search);
        for (const key of ['startapp', 'tgWebAppStartParam']) {
            const val = urlParams.get(key);
            if (val && val.startsWith('ref_')) {
                const id = val.slice(4);
                if (/^\d{1,20}$/.test(id)) {
                    return id;
                }
            }
        }
    } catch (e) {
        console.warn('[BOOT] getReferrerId URL search parse error:', e);
    }
    return null;
}
/**
 * مقدار کاربر id را بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function getUserId() {
    const user = getTelegramUser();
    if (user?.id) {
        localStorage.removeItem('guest_id');
        return String(user.id);
    }
    if (isInTelegram()) return 'pending_telegram';
    let guestId = localStorage.getItem('guest_id');
    if (!guestId) { guestId = 'guest_' + Date.now(); localStorage.setItem('guest_id', guestId); }
    return guestId;
}

/**
 * وضعیت مرکزی کاربر را برای احراز هویت و لودینگ نگه‌داری می‌کند.
 * ورودی: این ساختار به‌صورت شیء سراسری داخلی استفاده می‌شود.
 * خروجی: مجموعه‌ای از وضعیت‌ها و متدهای کمکی برای مدیریت کاربر فراهم می‌کند.
 */
const UserContext = {
    ready: false,
    loading: true,
    user: null,

    async init() {
        this.loading = true;
        this._setLoadingUI(true);
        await initTelegramWebApp();
        this.user = getTelegramUser();
        // Only mark ready when auth is actually available (user ID + valid initData)
        this.ready = isTelegramAuthReady();
        _authWaitAttempted = true;
        this.loading = false;
        this._setLoadingUI(false);
        return this.user;
    },

    isAuthenticated() {
        return !!getTelegramUser()?.id;
    },

    isGuest() {
        return !isInTelegram() && isGuestUserId(getUserId());
    },

    isPending() {
        return isInTelegram() && !this.isAuthenticated();
    },

    _setLoadingUI(show) {
        document.body.classList.toggle('user-loading', show);
        document.querySelectorAll('.profile-loading-target').forEach(el => {
            el.classList.toggle('skeleton-text', show);
        });
    },
};
/**
 * مقدار کاربر name را بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function getUserName() {
    if (UserContext.loading || isUserLoading()) return t('loading_user');
    const u = getTelegramUser();
    if (!u) return UserContext.isGuest() ? t('guest') : t('loading_user');
    return `${u.first_name || ''} ${u.last_name || ''}`.trim() || u.username || t('guest');
}

/**
 * عملیات مربوط به userStorageKey را انجام می‌دهد.
 * ورودی: پارامترهای `base` را دریافت می‌کند.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function userStorageKey(base) {
    return `${base}_${getUserId()}`;
}

/**
 * زبان from ذخیره‌سازی را بارگذاری می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function loadLangFromStorage() {
    const scoped = localStorage.getItem(userStorageKey('app_lang'));
    if (scoped === 'fa' || scoped === 'en') return scoped;
    const legacy = localStorage.getItem('app_lang');
    if (legacy === 'fa' || legacy === 'en') return legacy;
    return 'fa';
}

/**
 * واچ‌لیست from ذخیره‌سازی را بارگذاری می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
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

/**
 * زبان to ذخیره‌سازی را ذخیره می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function saveLangToStorage() {
    localStorage.setItem(userStorageKey('app_lang'), currentLang);
    localStorage.setItem('app_lang', currentLang);
}

/**
 * مقدار عضویت کش key را بازیابی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */

/**
 * واچ‌لیست را به‌صورت ماندگار ذخیره می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function persistWatchlist() {
    localStorage.setItem(userStorageKey('watchlist'), JSON.stringify(watchlist));
    if (!API_BASE || isGuestUserId(getUserId())) return;
    try {
        await apiFetch('/api/watchlist', {
            method: 'PUT',
            body: JSON.stringify({ user_id: getUserId(), symbols: watchlist })
        });
    } catch (e) {
        console.warn('persistWatchlist:', e);
    }
}

/**
 * زبان to سرور را ذخیره می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function saveLangToServer() {
    if (!API_BASE || isGuestUserId(getUserId())) return;
    try {
        await apiFetch('/api/users/me/settings', {
            method: 'PUT',
            body: JSON.stringify({ user_id: getUserId(), lang: currentLang })
        });
    } catch (e) {
        console.warn('saveLangToServer:', e);
    }
}

/**
 * اطلاعات اولیه کاربر، زبان و واچ‌لیست را بین فرانت‌اند و سرور همگام‌سازی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function bootstrapUser() {
    currentLang = loadLangFromStorage();
    loadWatchlistFromStorage();

    if (!API_BASE) {
        applyLanguage();
        return;
    }
    if (UserContext.isGuest()) {
        applyLanguage();
        return;
    }
    if (UserContext.isPending()) {
        applyLanguage();
        return;
    }
    // Guard: don't bootstrap without valid initData — request would fail auth on server
    if (isInTelegram() && !isTelegramAuthReady()) {
        applyLanguage();
        return;
    }

    try {
        const u = getTelegramUser();
        const referrerId = getReferrerId();

        const bootstrapUrl = '/api/users/bootstrap';
        const data = await apiFetch(bootstrapUrl, {
            method: 'POST',
            body: JSON.stringify({
                user_id: getUserId(),
                username: u?.username || null,
                first_name: u?.first_name || null,
                last_name: u?.last_name || null,
                lang: currentLang,
                referrer_id: referrerId
            })
        });
        if (data.bot_username) {
            BOT_USERNAME = data.bot_username;
        }
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
        saveLangToStorage();
        applyLanguage();

        // Admin status from server — persist to localStorage for session stability
        const newAdminStatus = Boolean(data.is_admin);
        const adminChanged = newAdminStatus !== isCurrentUserAdmin;
        isCurrentUserAdmin = newAdminStatus;
        localStorage.setItem('is_admin', isCurrentUserAdmin ? '1' : '0');
        if (data.user?.id) {
            ADMIN_ID = String(data.user.id);
            localStorage.setItem('admin_id', ADMIN_ID);
        }

        // ── Membership lock gate ──
        if (data.channel_joined === false) {
            showJoinLock();
        } else {
            hideJoinLock();
        }

        // CRITICAL: Set bootstrapComplete BEFORE any UI re-renders.
        // isAdmin() gates on bootstrapComplete — if set after, all UI updates
        // below would see isAdmin()=false and become no-ops (inline display:none).
        bootstrapComplete = true;
        // Stop long-term bootstrap retry — no longer needed
        if (_bootstrapLongTimer) { clearInterval(_bootstrapLongTimer); _bootstrapLongTimer = null; }
        // CSS-level admin visibility — add class AFTER bootstrap confirms admin status
        if (isCurrentUserAdmin) {
            document.body.classList.add('admin-ready');
        } else {
            document.body.classList.remove('admin-ready');
        }

        // NOW update all admin UI — isAdmin() will return correct value.
        // Update FAB visibility now that admin status is known
        updateAnalysisFabVisibility();
        // Update admin entry button (single source of truth: isCurrentUserAdmin)
        updateAdminEntryButton();
        // Always re-render analysis list when bootstrap completes.
        // The list may have been rendered before bootstrap (when isAdmin()=false),
        // so cards need edit/delete buttons added.
        // Using adminChanged would miss the returning-admin cold-open case
        // where localStorage already had is_admin=1 and API confirms it.
        renderAnalysisList();
        renderAnalysisFeatured();
        renderAnalysisStats();

        // If analysis detail page is open, update admin actions visibility.
        const adminActions = $('adp-admin-actions');
        if (adminActions && $('analysis-detail-page')?.classList.contains('active')) {
            adminActions.style.display = isCurrentUserAdmin ? '' : 'none';
        }
    } catch (e) {
        console.error('[BOOT] bootstrapUser FAILED:', e.message);
        // Do NOT set bootstrapComplete — let retry try again
        applyLanguage();
    }
}

/**
 * Retry bootstrap when Telegram user becomes available after cold open.
 * Guards: only runs once (bootstrapComplete), only when user is authenticated.
 */
async function tryLateBootstrap() {
    if (bootstrapComplete) return;
    // Don't retry if last attempt failed recently — prevent retry storm
    if (_bootstrapFailedAt && (Date.now() - _bootstrapFailedAt) < 5000) return;
    if (_bootstrapPromise) return _bootstrapPromise;
    _bootstrapPromise = _doBootstrap().finally(() => { _bootstrapPromise = null; });
    return _bootstrapPromise;
}

let _bootstrapFailedAt = 0;

async function _doBootstrap() {
    // Single readiness check: both user ID and valid initData required
    if (!API_BASE || UserContext.isGuest() || UserContext.isPending() || (isInTelegram() && !isTelegramAuthReady())) {
        console.log('[BOOT] _doBootstrap skipped — conditions not met.', {
            hasApiBase: !!API_BASE,
            isGuest: UserContext.isGuest(),
            isPending: UserContext.isPending(),
            isInTelegram: isInTelegram(),
            isTelegramAuthReady: isTelegramAuthReady(),
            userId: getTelegramUser()?.id || null,
            initDataLen: getTelegramInitData()?.length || 0
        });
        return;
    }
    try {
        await bootstrapUser();
        _bootstrapFailedAt = 0;
        loadUser();
        if (bootstrapComplete && typeof initAdminPanel === 'function' && !_adminPanelInitialized) {
            _adminPanelInitialized = true;
            initAdminPanel();
        }
    } catch (e) {
        _bootstrapFailedAt = Date.now();
        console.error('[BOOT] tryLateBootstrap FAILED:', e);
    }
}

/**
 * تحلیل‌ها را از منبع داده دریافت می‌کند.
 * ورودی: پارامترهای `force = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
// ============================================================================
//#region تحلیل‌ها — Analysis Module v2
// ============================================================================

async function fetchAnalyses(force = false, append = false) {
    if (!API_BASE) {
        analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
        return true;
    }
    // For forced fetches, briefly wait for any in-flight request to finish (max 2s)
    if (analysisListLoading) {
        if (!force) return false;
        let waited = 0;
        while (analysisListLoading && waited < 2000) {
            await new Promise(r => setTimeout(r, 100));
            waited += 100;
        }
        if (analysisListLoading) return false; // Still loading after 2s, skip
    }
    // Show skeleton on first load (no cached data yet)
    const showSkel = force && !append && !analyses.length;
    if (showSkel) showAnalysisSkeleton();
    try {
        analysisListLoading = true;
        const page = append ? analysisListPage : 1;
        let url = `/api/analyses?page=${page}&limit=${ANALYSIS_PAGE_SIZE}`;
        if (!force && !append && analysisVersion !== null) url += `&version=${analysisVersion}`;
        const data = await apiFetch(url);

        // Always update featured + stats from response (even when unchanged — they are fresh from DB)
        if (Array.isArray(data.featured)) analysisFeatured = data.featured;
        else if (force) analysisFeatured = [];
        if (data.stats) {
            analysisStats = data.stats;
            localStorage.setItem('analysisStats', JSON.stringify(analysisStats));
        }
        if (Array.isArray(data.featured) && data.featured.length) {
            localStorage.setItem('analysisFeatured', JSON.stringify(data.featured));
        } else if (force) {
            localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
        }
        analysisVersion = data.version || analysisVersion || 0;
        localStorage.setItem('analysisVersion', String(analysisVersion));

        // If list data unchanged, skip list update but still signal that stats were refreshed
        if (data.unchanged && !append) {
            hideAnalysisSkeleton();
            return true; // Return true so callers still re-render stats/featured
        }

        if (append && Array.isArray(data.analyses)) {
            analyses = analyses.concat(data.analyses);
        } else if (Array.isArray(data.analyses)) {
            if (data.analyses.length === 0 && analyses.length > 0 && !force) {
                console.warn('fetchAnalyses: API returned empty but we have cached data — preserving');
                hideAnalysisSkeleton();
                return true;
            }
            analyses = data.analyses;
        }

        if (data.pagination) analysisPagination = data.pagination;
        analysisListPage = data.pagination?.hasMore ? (data.pagination.page + 1) : page;
        localStorage.setItem('analyses', JSON.stringify(analyses));
        return true;
    } catch (e) {
        console.warn('fetchAnalyses:', e);
        if (!analyses.length) analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
        // Restore featured + stats from localStorage on API failure
        if (!analysisFeatured.length) {
            try { const _f = JSON.parse(localStorage.getItem('analysisFeatured') || '[]'); analysisFeatured = Array.isArray(_f) ? _f : (_f ? [_f] : []); } catch {}
        }
        if (!analysisStats) {
            try { analysisStats = JSON.parse(localStorage.getItem('analysisStats') || 'null'); } catch {}
        }
    } finally {
        analysisListLoading = false;
        hideAnalysisSkeleton();
    }
    return false;
}

async function saveAnalysisToServer(payload, method, analysisId) {
    // ── Step 1: Check API_BASE ──
    if (!API_BASE) {
        showToast('API در دسترس نیست.');
        return null;
    }

    // ── NOTE: Admin auth is handled by the backend (requireAdmin).
    // We NO longer check isAdmin() here because:
    //   1. The FAB button is already CSS-gated (body:not(.admin-ready))
    //   2. The backend returns 403 if not admin — we handle that below
    //   3. Checking isAdmin() here caused race conditions on cold-open
    //      where bootstrapComplete was false but user IS admin
    //   4. This eliminates the "double-click required" bug

    // ── Step 2: Build URL ──
    const basePath = '/api/admin/analyses';
    const url = method === 'DELETE' || method === 'PUT'
        ? `${basePath}/${analysisId}`
        : basePath;

    // ── Step 3: Build body & headers ──
    const body = JSON.stringify(payload);
    const headers = { 'Content-Type': 'application/json' };
    const initData = getTelegramInitData();
    if (initData) {
        headers['X-Telegram-Init-Data'] = initData;
    }

    // ── Step 4: Fetch with timeout ──
    try {
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 15000);
        const fullUrl = `${API_BASE}${url}`;
        const res = await fetch(fullUrl, {
            method,
            headers,
            body: method !== 'DELETE' ? body : undefined,
            signal: controller.signal,
        });
        clearTimeout(timeoutId);

        // ── Step 5: Handle response ──
        const responseText = await res.text();

        if (!res.ok) {
            console.error('[ANALYSIS] HTTP ERROR', res.status, responseText.substring(0, 200));
            // Handle 403 specifically — admin auth failed
            if (res.status === 403) {
                showToast('دسترسی ادمین تأیید نشده — لطفاً دوباره تلاش کنید.');
                return null;
            }
            // Handle 503 — database timeout
            if (res.status === 503) {
                showToast('سرور در حال بارگذاری است — لطفاً چند ثانیه بعد تلاش کنید.');
                return null;
            }
            throw new Error(`HTTP ${res.status}: ${responseText.substring(0, 100)}`);
        }

        const result = JSON.parse(responseText);
        return result;
    } catch (err) {
        console.error('[ANALYSIS] fetch exception:', err.name, err.message);
        // Handle abort/timeout specifically
        if (err.name === 'AbortError') {
            showToast('درخواست زمان‌بر شد — لطفاً دوباره تلاش کنید.');
            return null;
        }
        throw err;
    }
}

function isAdmin() {
    // CRITICAL: Never return true before bootstrap completes.
    // This prevents non-admin users from seeing admin UI due to stale localStorage.
    if (!bootstrapComplete) return false;
    return isCurrentUserAdmin;
}

function timeAgo(dateStr) {
    const now = Date.now();
    const d = new Date(dateStr).getTime();
    const diff = Math.floor((now - d) / 1000);
    if (diff < 60) return 'لحظاتی پیش';
    if (diff < 3600) return Math.floor(diff / 60) + ' دقیقه پیش';
    if (diff < 86400) return Math.floor(diff / 3600) + ' ساعت پیش';
    if (diff < 604800) return Math.floor(diff / 86400) + ' روز پیش';
    return new Date(dateStr).toLocaleDateString('fa-IR');
}

function truncateText(text, maxLen) {
    if (!text || text.length <= maxLen) return text || '';
    return text.substring(0, maxLen) + '...';
}

/**
 * Estimate reading time in minutes based on text length.
 * Assumes ~200 words per minute for Persian text.
 */
function estimateReadTime(text) {
    if (!text) return 1;
    const words = text.trim().split(/\s+/).length;
    return Math.max(1, Math.ceil(words / 200));
}

/**
 * Determine sentiment (bullish/bearish/neutral/decision) based on price levels.
 * Compares current_price to support and resistance.
 */
function getSentiment(a) {
    const support = parseFloat(a.support_level);
    const resistance = parseFloat(a.resistance_level);
    const current = parseFloat(a.current_price);
    if (!isFinite(support) || !isFinite(resistance) || !isFinite(current)) return null;
    const range = resistance - support;
    if (range <= 0) return null;
    const position = (current - support) / range; // 0 = at support, 1 = at resistance
    if (position <= 0.25) return 'bearish';
    if (position >= 0.75) return 'bullish';
    if (position <= 0.45 || position >= 0.55) return 'neutral';
    return 'decision';
}

// ── Sentiment Badge HTML Generator ──
const SENTIMENT_CONFIG = {
    bullish: {
        label: 'صعودی',
        cls: 'bullish',
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 20L12 4L21 20" fill="rgba(34,197,94,0.15)"/><path d="M12 4"/><path d="M7 15l5-7 5 7"/><path d="M9.5 13h5" stroke-width="2.5"/></svg>',
    },
    bearish: {
        label: 'نزولی',
        cls: 'bearish',
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 4L12 20L21 4" fill="rgba(239,68,68,0.15)"/><path d="M7 9l5 7 5-7"/><path d="M9.5 11h5" stroke-width="2.5"/></svg>',
    },
    neutral: {
        label: 'خنثی',
        cls: 'neutral',
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="3" width="18" height="18" rx="4" fill="rgba(148,163,184,0.1)"/><path d="M8 12h8" stroke-width="2.5"/><path d="M12 8v8" stroke-width="2.5"/></svg>',
    },
    decision: {
        label: 'محدوده تصمیم',
        cls: 'decision',
        icon: '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="9" fill="rgba(168,85,247,0.12)"/><path d="M12 7v5" stroke-width="2.5"/><circle cx="12" cy="15.5" r="1.5" fill="currentColor" stroke="none"/><path d="M12 3.5" stroke-dasharray="2 2" opacity="0.4"/></svg>',
    },
};

function getSentimentBadgeHTML(sentiment, badgeClass = 'acv-sentiment') {
    if (!sentiment || !SENTIMENT_CONFIG[sentiment]) return '';
    const cfg = SENTIMENT_CONFIG[sentiment];
    return `<span class="${badgeClass} ${badgeClass}-${cfg.cls}">${cfg.icon} ${cfg.label}</span>`;
}

/**
 * Toggle bookmark for an analysis ID. Persists to localStorage.
 */
function toggleAnalysisBookmark(id, event) {
    if (event) event.stopPropagation();
    if (!id) return;
    const idx = analysisBookmarks.indexOf(id);
    if (idx >= 0) {
        analysisBookmarks.splice(idx, 1);
        // Save FIRST, then notify
        localStorage.setItem('analysisBookmarks', JSON.stringify(analysisBookmarks));
        updateSavedChipCount();
        renderAnalysisList();
        if (currentAnalysisDetail && currentAnalysisDetail.id === id) {
            updateDetailBookmarkButton(id);
        }
        showToast('از ذخیره‌شده‌ها حذف شد.');
    } else {
        analysisBookmarks.push(id);
        localStorage.setItem('analysisBookmarks', JSON.stringify(analysisBookmarks));
        updateSavedChipCount();
        renderAnalysisList();
        if (currentAnalysisDetail && currentAnalysisDetail.id === id) {
            updateDetailBookmarkButton(id);
        }
        showToast('در ذخیره‌شده‌ها اضافه شد.');
    }
}

function isAnalysisBookmarked(id) {
    return analysisBookmarks.includes(id);
}

function updateSavedChipCount() {
    const chip = document.querySelector('.tf-chip[data-tf="saved"]');
    if (!chip) return;
    const count = analysisBookmarks.length;
    chip.innerHTML = count > 0 ? `🔖 ذخیره‌شده (${count})` : '🔖 ذخیره‌شده';
}

function updateDetailBookmarkButton(id) {
    const btn = document.getElementById('adp-bookmark-btn');
    if (!btn) return;
    const saved = isAnalysisBookmarked(id);
    btn.classList.toggle('saved', saved);
    btn.innerHTML = saved
        ? '<svg viewBox="0 0 24 24" width="18" height="18" fill="currentColor" stroke="currentColor" stroke-width="1.5"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
        : '<svg viewBox="0 0 24 24" width="18" height="18" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>';
}

function getAnalysisDeepLink(analysisId) {
    const tg = window.Telegram?.WebApp;
    const botName = tg?.initDataUnsafe?.user ? (window.BOT_USERNAME || 'AmirBTCAssistantBot') : 'AmirBTCAssistantBot';
    return `https://t.me/${botName}?startapp=analysis_${analysisId}`;
}

// ── SVG Icon Constants (professional, reusable) ──
const SVG_EYE = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>';
const SVG_CLOCK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>';
const SVG_BOOK = '<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg>';
const SVG_EDIT = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><path d="M11 4H4a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h14a2 2 0 0 0 2-2v-7"/><path d="M18.5 2.5a2.121 2.121 0 0 1 3 3L12 15l-4 1 1-4 9.5-9.5z"/></svg>';
const SVG_DELETE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>';
const SVG_SHARE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>';
const SVG_ARROW_LEFT = '<svg viewBox="0 0 24 24" width="22" height="22" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="15 18 9 12 15 6"/></svg>';
const SVG_CHART = '<svg viewBox="0 0 24 24" width="30" height="30" fill="none" stroke="currentColor" stroke-width="2"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 5 5-9"/></svg>';

// ── Render: Featured Slider ──
let currentFeaturedSlide = 0;
let featuredSlideInterval = null;
let featuredSlides = [];

function buildFeaturedPriceBoxes(a) {
    const sNum = parseFloat(a.support_level);
    const rNum = parseFloat(a.resistance_level);
    const cNum = parseFloat(a.current_price);
    if (!isFinite(sNum) && !isFinite(rNum) && !isFinite(cNum)) return '';
    return `
        <div class="fs-price-boxes">
            <div class="price-box price-box-resistance">
                <span class="price-box-label">مقاومت</span>
                <span class="price-box-value">${escapeHtml(a.resistance_level || '—')}</span>
            </div>
            <div class="price-box price-box-current">
                <span class="price-box-label">قیمت فعلی</span>
                <span class="price-box-value">${escapeHtml(a.current_price || '—')}</span>
            </div>
            <div class="price-box price-box-support">
                <span class="price-box-label">حمایت</span>
                <span class="price-box-value">${escapeHtml(a.support_level || '—')}</span>
            </div>
        </div>
    `;
}

function renderFeaturedSlideHTML(a) {
    const sentiment = getSentiment(a);
    const sentimentHTML = sentiment ? `<span class="fs-sentiment-badge ${sentiment}">${SENTIMENT_CONFIG[sentiment].icon} ${SENTIMENT_CONFIG[sentiment].label}</span>` : '';
    const featuredHTML = a.featured ? `<span class="fs-featured-badge">⭐ ویژه</span>` : '';

    const imageSection = a.image
        ? `<div class="fs-card-image-wrap">
                <img src="${escapeHtml(a.image)}" loading="eager" alt="${escapeHtml(a.coin)}" onerror="this.parentElement.parentElement.innerHTML='<div class=\'fs-card-no-image\'><div class=\'fs-card-no-image-text\'>${escapeHtml(a.coin)}</div></div>'">
                <div class="fs-card-image-overlay"></div>
                ${sentimentHTML}
                ${featuredHTML}
                <div class="fs-card-image-content">
                    <div class="fs-coin-row">
                        <span class="fs-coin-avatar">${escapeHtml(a.coin)}</span>
                        <span class="fs-coin-name">${escapeHtml(a.coin)}</span>
                        <span class="fs-tf-badge">${escapeHtml(a.timeframe || '1D')}</span>
                    </div>
                    ${a.title ? `<div class="fs-card-title">${escapeHtml(truncateText(a.title, 50))}</div>` : ''}
                </div>
           </div>`
        : `<div class="fs-card-no-image">
                ${sentimentHTML}
                ${featuredHTML}
                <div class="fs-card-no-image-text">${escapeHtml(a.coin)}</div>
           </div>`;

    return `
        <div class="fs-card" onclick="openAnalysisDetailPage('${escapeHtml(a.id)}')">
            ${imageSection}
            <div class="fs-card-content">
                <div class="fs-card-snippet">${escapeHtml(truncateText(a.content || a.text || '', 80))}</div>
                <div class="fs-card-meta">
                    <span class="fs-meta-item">${SVG_EYE} ${a.views_count || 0}</span>
                    <span class="fs-meta-item">${SVG_CLOCK} ${timeAgo(a.created_at)}</span>
                    <span class="fs-card-cta">مشاهده ←</span>
                </div>
            </div>
        </div>
    `;
}

function renderAnalysisFeatured() {
    const section = $('analysis-featured-section');
    const container = $('featured-slides-container');
    const dotsEl = $('featured-slider-dots');
    if (!section || !container) return;

    // Build slides: ONLY featured analyses (no regular analyses in hero)
    featuredSlides = [...analysisFeatured];

    if (!featuredSlides.length) {
        section.style.display = 'none';
        clearInterval(featuredSlideInterval);
        return;
    }

    section.style.display = '';
    if (currentFeaturedSlide >= featuredSlides.length) currentFeaturedSlide = 0;

    // Render current slide
    container.innerHTML = `<div class="featured-slide active">${renderFeaturedSlideHTML(featuredSlides[currentFeaturedSlide])}</div>`;

    // Render dots
    if (dotsEl) {
        dotsEl.innerHTML = featuredSlides.map((_, i) =>
            `<span class="fs-dot ${i === currentFeaturedSlide ? 'active' : ''}" data-idx="${i}"></span>`
        ).join('');

        // Dot click handler
        dotsEl.onclick = (e) => {
            const dot = e.target.closest('.fs-dot');
            if (!dot) return;
            const idx = parseInt(dot.dataset.idx);
            if (!isNaN(idx) && idx !== currentFeaturedSlide) {
                currentFeaturedSlide = idx;
                showFeaturedSlide();
                resetFeaturedAutoSlide();
            }
        };
    }

    // Auto-slide
    resetFeaturedAutoSlide();

    // Touch swipe support
    initFeaturedSwipe(container);
}

function showFeaturedSlide() {
    const container = $('featured-slides-container');
    const dotsEl = $('featured-slider-dots');
    if (!container || !featuredSlides.length) return;

    container.innerHTML = `<div class="featured-slide active">${renderFeaturedSlideHTML(featuredSlides[currentFeaturedSlide])}</div>`;

    // Update dots
    if (dotsEl) {
        dotsEl.querySelectorAll('.fs-dot').forEach((dot, i) => {
            dot.classList.toggle('active', i === currentFeaturedSlide);
        });
    }
}

function resetFeaturedAutoSlide() {
    clearInterval(featuredSlideInterval);
    if (featuredSlides.length > 1) {
        featuredSlideInterval = setInterval(() => {
            currentFeaturedSlide = (currentFeaturedSlide + 1) % featuredSlides.length;
            showFeaturedSlide();
        }, 8000);
    }
}

function initFeaturedSwipe(container) {
    let startX = 0;
    let startY = 0;
    let swiping = false;

    container.ontouchstart = (e) => {
        startX = e.touches[0].clientX;
        startY = e.touches[0].clientY;
        swiping = true;
    };

    container.ontouchend = (e) => {
        if (!swiping) return;
        swiping = false;
        const endX = e.changedTouches[0].clientX;
        const endY = e.changedTouches[0].clientY;
        const diffX = endX - startX;
        const diffY = endY - startY;

        // Only trigger if horizontal swipe is dominant and sufficient
        if (Math.abs(diffX) > 40 && Math.abs(diffX) > Math.abs(diffY) * 1.5) {
            if (diffX > 0) {
                // Swipe right (RTL: go to next)
                currentFeaturedSlide = (currentFeaturedSlide + 1) % featuredSlides.length;
            } else {
                // Swipe left (RTL: go to previous)
                currentFeaturedSlide = (currentFeaturedSlide - 1 + featuredSlides.length) % featuredSlides.length;
            }
            showFeaturedSlide();
            resetFeaturedAutoSlide();
        }
    };
}


// ── Render: Stats Bar ──
function renderAnalysisStats() {
    const bar = $('analysis-stats-bar');
    if (!bar) return;
    if (!analysisStats) { bar.style.display = 'none'; return; }
    bar.style.display = '';
    bar.innerHTML = `
        <div class="stats-bar">
            <div class="stat-item active">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 5 5-9"/></svg>
                </div>
                <span class="stat-value">${analysisStats.active}</span>
                <span class="stat-label">فعال</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item today">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
                </div>
                <span class="stat-value">${analysisStats.today}</span>
                <span class="stat-label">امروز</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item total">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>
                </div>
                <span class="stat-value">${analysisStats.total}</span>
                <span class="stat-label">کل</span>
            </div>
        </div>
    `;
}

// ── Render: Analysis List ──

/**
 * Apply client-side search + timeframe filter + sort to the analyses array.
 * Returns a new filtered+sorted array (does not mutate `analyses`).
 */
function getFilteredAnalyses() {
    let list = analyses.slice();

    // Saved-only filter (bookmarked items)
    if (analysisShowSavedOnly) {
        list = list.filter(a => analysisBookmarks.includes(a.id));
        // If showing saved only, also include featured analyses if bookmarked
        for (const fa of analysisFeatured) {
            if (analysisBookmarks.includes(fa.id) && !list.find(a => a.id === fa.id)) {
                list.unshift(fa);
            }
        }
    } else if (analysisCategoryFilter !== 'all') {
        // Category filter (crypto/forex)
        list = list.filter(a => (a.category || 'crypto') === analysisCategoryFilter);
    } else if (analysisTimeframeFilter !== 'all') {
        // Legacy timeframe filter (maps to category)
        list = list.filter(a => (a.category || 'crypto') === analysisTimeframeFilter);
    }

    // Search query (coin or title)
    if (analysisSearchQuery) {
        const q = analysisSearchQuery.trim().toLowerCase();
        if (q) {
            list = list.filter(a => {
                const coin = (a.coin || '').toLowerCase();
                const title = (a.title || '').toLowerCase();
                const text = (a.content || a.text || '').toLowerCase();
                return coin.includes(q) || title.includes(q) || text.includes(q);
            });
        }
    }

    // Always sort newest first (simpler, better UX)
    list.sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0));

    return list;
}

/**
 * Render 3 skeleton cards while data is loading.
 */
function showAnalysisSkeleton() {
    const skel = $('analysis-skeleton-container');
    const list = $('analysis-list-container');
    if (skel) {
        skel.innerHTML = Array(3).fill(0).map(() => `
            <div class="skel-card">
                <div class="skel-img"></div>
                <div class="skel-body">
                    <div class="skel-line short"></div>
                    <div class="skel-line long"></div>
                    <div class="skel-line medium"></div>
                    <div style="display:flex;gap:8px;margin-top:2px;">
                        <div class="skel-line xshort"></div>
                        <div class="skel-line xshort"></div>
                        <div class="skel-line xshort"></div>
                    </div>
                </div>
            </div>
        `).join('');
        skel.style.display = '';
    }
    if (list) list.innerHTML = '';
}

function hideAnalysisSkeleton() {
    const skel = $('analysis-skeleton-container');
    if (skel) skel.style.display = 'none';
}

function renderAnalysisList() {
    const container = $('analysis-list-container');
    const emptyState = $('analysis-empty-state');
    if (!container) return;

    hideAnalysisSkeleton();

    // Case 1: No analyses at all (DB is empty)
    if (!analyses.length) {
        container.innerHTML = '';
        // Hide list-container so its 120px bottom padding doesn't push empty state down
        container.style.display = 'none';
        if (emptyState) {
            const adminUser = isAdmin();
            const titleEl = $('aes-title');
            const descEl  = $('aes-desc');
            if (adminUser) {
                if (titleEl) titleEl.textContent = 'هنوز تحلیلی منتشر نشده است';
                if (descEl)  descEl.textContent  = 'برای انتشار اولین تحلیل روی دکمه + کلیک کنید';
            } else {
                if (titleEl) titleEl.textContent = 'هنوز تحلیلی منتشر نشده است';
                if (descEl)  descEl.textContent  = 'به‌زودی تحلیل‌های جدید در این بخش نمایش داده می‌شوند';
            }
            emptyState.style.display = '';
        }
        return;
    }
    // Restore list-container display (in case it was hidden when DB was empty)
    container.style.display = '';
    if (emptyState) emptyState.style.display = 'none';

    // Apply filter + sort
    const filtered = getFilteredAnalyses();

    // Case 2: Analyses exist but filter returned nothing
    if (!filtered.length) {
        container.innerHTML = `
            <div class="analysis-no-results">
                <div class="anr-icon">
                    <svg viewBox="0 0 24 24" width="28" height="28" fill="none" stroke="currentColor" stroke-width="2"><circle cx="11" cy="11" r="7"/><line x1="21" y1="21" x2="16.5" y2="16.5"/><line x1="8" y1="8" x2="8" y2="8" stroke-width="2.5"/></svg>
                </div>
                <p class="anr-title">نتیجه‌ای یافت نشد</p>
                <p class="anr-desc">با فیلترهای فعلی هیچ تحلیلی پیدا نشد. فیلترها را تغییر دهید یا همه تحلیل‌ها را ببینید.</p>
                <button type="button" class="anr-reset-btn" onclick="resetAnalysisFilters()">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M3 12a9 9 0 1 0 9-9"/><polyline points="3 4 3 12 11 12"/></svg>
                    پاک کردن فیلترها
                </button>
            </div>
        `;
        return;
    }

    const isAdminUser = isAdmin();
    container.innerHTML = filtered.map((a, i) => {
        const sentiment = getSentiment(a);
        const readTime = estimateReadTime(a.content || a.text);
        const bookmarked = isAnalysisBookmarked(a.id);
        const sentimentBadge = getSentimentBadgeHTML(sentiment, 'acv-sentiment');

        // Price boxes — REMOVED from cards (available in detail page + hero slider)
        let priceBoxes = '';

        // Image section
        const imageSection = a.image
            ? `<div class="acv-image-section">
                    <img src="${escapeHtml(a.image)}" class="acv-hero-image" loading="lazy" alt="${escapeHtml(a.coin)}" onerror="this.outerHTML='<div class=\'acv-no-image-placeholder\'>${escapeHtml(a.coin)}</div>'">
                    <div class="acv-image-overlay">
                        <div class="acv-coin-badge">${escapeHtml(a.coin)}</div>
                        <div class="acv-tf-badge">${escapeHtml(a.timeframe || '1D')}</div>
                        ${a.featured ? '<div class="acv-featured-star">⭐</div>' : ''}
                    </div>
               </div>`
            : `<div class="acv-image-section">
                    <div class="acv-no-image-placeholder">${escapeHtml(a.coin)}</div>
                    <div class="acv-image-overlay" style="background:none;">
                        <div class="acv-coin-badge" style="position:absolute;bottom:10px;">${escapeHtml(a.coin)}</div>
                        <div class="acv-tf-badge" style="position:absolute;bottom:10px;left:12px;">${escapeHtml(a.timeframe || '1D')}</div>
                        ${a.featured ? '<div class="acv-featured-star" style="position:absolute;bottom:10px;right:12px;">⭐</div>' : ''}
                    </div>
               </div>`;

        return `
        <div class="analysis-card-v2 ${bookmarked ? 'acv-bookmarked' : ''}" onclick="openAnalysisDetailPage('${escapeHtml(a.id)}')" style="animation-delay:${Math.min(i, 8) * 0.04}s">
            ${imageSection}
            <div class="acv-content-section">
                <div class="acv-title-row">
                    <span class="acv-coin-name">${escapeHtml(a.coin)}</span>
                    <span class="acv-timeframe">${escapeHtml(a.timeframe || '1D')}</span>
                    ${sentimentBadge}
                </div>
                ${a.title ? `<h3 class="acv-card-title">${escapeHtml(truncateText(a.title, 60))}</h3>` : ''}
                <p class="acv-card-snippet">${escapeHtml(truncateText(a.content || a.text || '', 250))}</p>
            </div>
            <div class="acv-footer-row">
                <div class="acv-meta-icons">
                    <span class="acv-meta-item">${SVG_EYE} ${a.views_count || 0}</span>
                    <span class="acv-meta-item">${SVG_CLOCK} ${timeAgo(a.created_at)}</span>
                    <span class="acv-meta-item">${SVG_BOOK} ${readTime} دقیقه</span>
                </div>
                <div class="acv-action-btns" onclick="event.stopPropagation()">
                    <button class="acv-bookmark-btn ${bookmarked ? 'saved' : ''}" onclick="toggleAnalysisBookmark('${escapeHtml(a.id)}', event)" aria-label="ذخیره">
                        ${bookmarked
                            ? '<svg viewBox="0 0 24 24" width="16" height="16" fill="currentColor" stroke="currentColor" stroke-width="1.5"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'
                            : '<svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>'}
                    </button>
                    ${isAdminUser
                        ? `<button class="acv-edit-btn" onclick="openEditAnalysisModal('${escapeHtml(a.id)}')">${SVG_EDIT}</button>
                           <button class="acv-delete-btn" onclick="startDeleteAnalysis('${escapeHtml(a.id)}')">${SVG_DELETE}</button>`
                        : `<button class="acv-share-btn" onclick="shareAnalysisById('${escapeHtml(a.id)}')">${SVG_SHARE}</button>`}
                </div>
            </div>
        </div>
        `;
    }).join('');

    // Setup infinite scroll
    setupAnalysisInfiniteScroll();
}

/**
 * Reset all filters (search, sort, timeframe) and re-render.
 */
function resetAnalysisFilters() {
    analysisSearchQuery = '';
    analysisTimeframeFilter = 'all';
    analysisCategoryFilter = 'all';
    analysisShowSavedOnly = false;
    const searchInput = $('analysis-search-input');
    if (searchInput) searchInput.value = '';
    const clearBtn = $('analysis-search-clear');
    if (clearBtn) clearBtn.style.display = 'none';
    document.querySelectorAll('.tf-chip').forEach(c => c.classList.toggle('active', c.dataset.tf === 'all'));
    renderAnalysisList();
}

/**
 * Initialize toolbar event listeners (search input, sort select, timeframe chips).
 * Called once on DOMContentLoaded.
 */
function initAnalysisToolbar() {
    const searchInput = $('analysis-search-input');
    const clearBtn = $('analysis-search-clear');
    const chipsContainer = $('analysis-tf-chips');

    if (searchInput) {
        let debounceTimer = null;
        searchInput.addEventListener('input', (e) => {
            const val = e.target.value;
            if (clearBtn) clearBtn.style.display = val ? '' : 'none';
            clearTimeout(debounceTimer);
            debounceTimer = setTimeout(() => {
                analysisSearchQuery = val;
                renderAnalysisList();
            }, 250);
        });
    }

    if (clearBtn) {
        clearBtn.addEventListener('click', () => {
            if (searchInput) { searchInput.value = ''; searchInput.focus(); }
            clearBtn.style.display = 'none';
            analysisSearchQuery = '';
            renderAnalysisList();
        });
    }

    if (chipsContainer) {
        chipsContainer.addEventListener('click', (e) => {
            const chip = e.target.closest('.tf-chip');
            if (!chip) return;
            document.querySelectorAll('.tf-chip').forEach(c => c.classList.remove('active'));
            chip.classList.add('active');
            const tf = chip.dataset.tf;
            if (tf === 'saved') {
                analysisShowSavedOnly = true;
                analysisCategoryFilter = 'all';
                analysisTimeframeFilter = 'all';
            } else {
                analysisShowSavedOnly = false;
                analysisCategoryFilter = tf;
                analysisTimeframeFilter = tf;
            }
            renderAnalysisList();
        });
    }
    updateSavedChipCount();
    initPullToRefresh();
}

/**
 * Initialize pull-to-refresh on the analysis page.
 * Detects when user pulls down at the top of the page and triggers a refresh.
 */
function initPullToRefresh() {
    if (window._ptrInitialized) return;
    window._ptrInitialized = true;

    let startY = 0;
    let pulling = false;
    let pullDistance = 0;
    const threshold = 70;

    const ptrEl = () => document.getElementById('analysis-ptr');
    const ptrText = () => document.getElementById('analysis-ptr-text');
    const analysisPage = () => document.getElementById('analysis-page');

    window.addEventListener('touchstart', (e) => {
        // Only trigger on analysis page, when scrolled to top
        if (!analysisPage()?.classList.contains('active')) return;
        if (window.scrollY > 0) return;
        startY = e.touches[0].clientY;
        pulling = true;
        pullDistance = 0;
    }, { passive: true });

    window.addEventListener('touchmove', (e) => {
        if (!pulling) return;
        const currentY = e.touches[0].clientY;
        pullDistance = Math.max(0, currentY - startY);
        const ptr = ptrEl();
        if (!ptr) return;
        if (pullDistance > 10) {
            ptr.classList.add('active');
            ptr.style.height = Math.min(pullDistance, threshold) + 'px';
            const text = ptrText();
            if (text) {
                text.textContent = pullDistance >= threshold ? 'رها کنید برای refresh' : 'برای refresh پایین بکشید';
            }
        }
    }, { passive: true });

    window.addEventListener('touchend', async () => {
        if (!pulling) return;
        pulling = false;
        const ptr = ptrEl();
        if (!ptr) return;

        if (pullDistance >= threshold) {
            // Trigger refresh
            ptr.classList.remove('active');
            ptr.classList.add('refreshing');
            ptr.style.height = '';
            const text = ptrText();
            if (text) text.textContent = 'در حال به‌روزرسانی...';
            try {
                await fetchAnalyses(true);
                renderAnalysisFeatured();
                renderAnalysisStats();
                renderAnalysisList();
                renderAnalysisSlider();
                showToast('تحلیل‌ها به‌روز شد.');
            } catch (e) {
                showToast('خطا در به‌روزرسانی.');
            } finally {
                setTimeout(() => {
                    ptr.classList.remove('refreshing');
                    const text2 = ptrText();
                    if (text2) text2.textContent = 'برای refresh پایین بکشید';
                }, 600);
            }
        } else {
            ptr.classList.remove('active');
            ptr.style.height = '';
        }
        pullDistance = 0;
    }, { passive: true });
}

function setupAnalysisInfiniteScroll() {
    const trigger = $('analysis-load-trigger');
    if (!trigger) return;
    if (window._analysisObserver) window._analysisObserver.disconnect();
    window._analysisObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && analysisPagination?.hasMore && !analysisListLoading) {
            loadMoreAnalyses();
        }
    }, { rootMargin: '300px' });
    window._analysisObserver.observe(trigger);
}

async function loadMoreAnalyses() {
    if (analysisListLoading || !analysisPagination?.hasMore) return;
    const changed = await fetchAnalyses(false, true);
    if (changed) renderAnalysisList();
}

// ── Analysis Detail Page ──
async function openAnalysisDetailPage(id) {
    const tg = getTg();
    if (tg?.BackButton) {
        tg.BackButton.show();
        tg.BackButton.onClick(closeAnalysisDetailPage);
    }

    currentAnalysisDetail = null;
    const cachedAnalysis = analyses.find(x => x.id === id) || analysisFeatured.find(a => a.id === id) || null;

    // Render detail page IMMEDIATELY from cached data for instant UX
    if (cachedAnalysis) {
        currentAnalysisDetail = cachedAnalysis;
        renderAnalysisDetailPage();
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const page = $('analysis-detail-page');
        if (page) page.classList.add('active');
        const nav = document.querySelector('.bottom-nav');
        if (nav) nav.style.display = 'none';
        window.scrollTo(0, 0);
    }

    // Fetch fresh detail from server in background (for full content + increment view)
    // Includes retry: if first attempt fails, waits 1.5s and retries once
    let detailFetched = false;
    for (let attempt = 0; attempt < 2 && !detailFetched; attempt++) {
        try {
            if (!API_BASE) break;
            if (attempt === 1) await new Promise(r => setTimeout(r, 1500));
            const [detailRes, viewRes] = await Promise.all([
                apiFetch(`/api/analyses/${id}`),
                apiFetch(`/api/analyses/${id}/view`, { method: 'POST' }).catch(() => null),
            ]);
            if (detailRes.analysis) {
                detailFetched = true;
                currentAnalysisDetail = detailRes.analysis;
                const localIdx = analyses.findIndex(x => x.id === id);
                if (localIdx >= 0 && detailRes.analysis.views_count !== undefined) {
                    analyses[localIdx].views_count = detailRes.analysis.views_count;
                }
                const fIdx = analysisFeatured.findIndex(a => a.id === id);
                if (fIdx >= 0 && detailRes.analysis.views_count !== undefined) {
                    analysisFeatured[fIdx].views_count = detailRes.analysis.views_count;
                }
                renderAnalysisDetailPage();
            }
        } catch (fetchErr) {
            console.warn('[ANALYSIS-DETAIL] fetch attempt', attempt + 1, 'failed:', fetchErr);
        }
    }
    if (!detailFetched && !cachedAnalysis) {
        showToast('خطا در بارگذاری تحلیل. لطفاً دوباره تلاش کنید.');
        if (tg?.BackButton) {
            tg.BackButton.offClick(closeAnalysisDetailPage);
            tg.BackButton.onClick(handleTelegramBack);
            updateTelegramBackButton();
        }
    } else if (!detailFetched && cachedAnalysis) {
        showToast('متن کامل تحلیل بارگذاری نشد. نسخه خلاصه نمایش داده می‌شود.');
    }
}

/**
 * Animate a count-up effect for the view count badge.
 * Goes from 0 to target over ~800ms using requestAnimationFrame.
 */
function animateViewCount(el, target, readTime) {
    if (!el) return;
    const duration = 800;
    const startTime = performance.now();
    const targetNum = Math.max(0, Number(target) || 0);

    function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        // Ease-out cubic for smooth deceleration
        const eased = 1 - Math.pow(1 - progress, 3);
        const current = Math.round(targetNum * eased);
        el.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;opacity:0.7"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${current} <span style="margin:0 4px;opacity:0.4">·</span> <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;opacity:0.7"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> ${readTime} دقیقه`;
        if (progress < 1) {
            requestAnimationFrame(update);
        } else {
            el.innerHTML = `<svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;opacity:0.7"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${targetNum} <span style="margin:0 4px;opacity:0.4">·</span> <svg viewBox="0 0 24 24" width="13" height="13" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-2px;opacity:0.7"><path d="M2 3h6a4 4 0 0 1 4 4v14a3 3 0 0 0-3-3H2z"/><path d="M22 3h-6a4 4 0 0 0-4 4v14a3 3 0 0 1 3-3h7z"/></svg> ${readTime} دقیقه`;
        }
    }
    requestAnimationFrame(update);
}

function renderAnalysisDetailPage() {
    const a = currentAnalysisDetail;
    if (!a) return;

    const coinEl = $('adp-coin'); if (coinEl) coinEl.innerText = a.coin;
    const tfEl = $('adp-tf'); if (tfEl) tfEl.innerText = a.timeframe || '1D';
    const readTime = estimateReadTime(a.content || a.text);
    // Animated view count (count-up effect)
    animateViewCount($('adp-views'), a.views_count || 0, readTime);

    // Coin avatar (gradient circle with coin symbol)
    const avatarEl = $('adp-coin-avatar');
    if (avatarEl) {
        avatarEl.innerHTML = escapeHtml(a.coin || '?');
    }

    // Admin actions — hidden via CSS unless body.admin-ready is set
    const adminActions = $('adp-admin-actions');
    if (adminActions) adminActions.style.display = isAdmin() ? '' : 'none';

    // Image (shown first, prominent)
    const imgWrap = $('adp-image-wrap');
    const img = $('adp-image');
    if (a.image) {
        if (imgWrap) imgWrap.style.display = '';
        if (img) { img.src = a.image; img.style.display = ''; img.onerror = function() { newsImageFallback(this); }; }
    } else {
        if (imgWrap) imgWrap.style.display = 'none';
    }

    // Title (with sentiment badge if available)
    const titleEl = $('adp-title');
    if (titleEl) {
        const sentiment = getSentiment(a);
        const sentimentHtml = getSentimentBadgeHTML(sentiment, 'adp-sentiment');
        titleEl.innerHTML = `${escapeHtml(a.title || `${a.coin} — ${a.timeframe || '1D'}`)} ${sentimentHtml}`;
    }

    // Content (escaped for XSS safety) — shown right after title
    const contentEl = $('adp-content');
    if (contentEl) {
        const text = a.content || a.text || '';
        contentEl.innerHTML = escapeHtml(text).replace(/\n/g, '<br>');
    }

    // Price levels — smaller, shown BELOW content
    const levelsEl = $('adp-levels');
    if (levelsEl) {
        if (a.support_level || a.current_price || a.resistance_level) {
            levelsEl.style.display = '';
            levelsEl.innerHTML = `
                ${a.resistance_level ? `<div class="adp-level adp-resistance"><span class="adp-level-label">مقاومت</span><span class="adp-level-value">${escapeHtml(a.resistance_level)}</span></div>` : ''}
                ${a.current_price ? `<div class="adp-level adp-current"><span class="adp-level-label">قیمت فعلی</span><span class="adp-level-value">${escapeHtml(a.current_price)}</span></div>` : ''}
                ${a.support_level ? `<div class="adp-level adp-support"><span class="adp-level-label">حمایت</span><span class="adp-level-value">${escapeHtml(a.support_level)}</span></div>` : ''}
            `;
        } else {
            levelsEl.style.display = 'none';
        }
    }

    // Price range visualizer — REMOVED (user requested removal)
    const rangeEl = $('adp-price-range');
    if (rangeEl) { rangeEl.style.display = 'none'; rangeEl.remove(); }

    // Meta
    const authorEl = $('adp-author'); if (authorEl) authorEl.innerText = a.author || '';
    const dateEl = $('adp-date'); if (dateEl) dateEl.innerText = a.date || '';

    // Update bookmark button state
    updateDetailBookmarkButton(a.id);

    // Related analyses (same coin, exclude current, max 3)
    renderRelatedAnalyses(a);

    // Reset + activate reading progress bar
    setupReadingProgress();
}

/**
 * Render the price range visualizer bar.
 * Shows a horizontal track from support to resistance with a marker at current price.
 * Only renders if all 3 values are present and numeric.
 */
function renderPriceRangeVisualizer(a) {
    const rangeEl = $('adp-price-range');
    if (!rangeEl) return;

    const support = parseFloat(a.support_level);
    const resistance = parseFloat(a.resistance_level);
    const current = parseFloat(a.current_price);

    // Hide if any value is missing or non-numeric, or if range is invalid
    if (!isFinite(support) || !isFinite(resistance) || !isFinite(current) || resistance <= support) {
        rangeEl.style.display = 'none';
        return;
    }

    // Clamp current to [support, resistance]
    const clampedCurrent = Math.max(support, Math.min(resistance, current));
    const position = ((clampedCurrent - support) / (resistance - support)) * 100; // 0-100

    rangeEl.style.display = '';

    // Update labels with actual values
    const supportLabel = $('adp-pr-support');
    const resistanceLabel = $('adp-pr-resistance');
    if (supportLabel) supportLabel.textContent = `حمایت ${formatPrice(support)}`;
    if (resistanceLabel) resistanceLabel.textContent = `مقاومت ${formatPrice(resistance)}`;

    // Set fill width and marker position (start at 0, then animate)
    const fill = $('adp-pr-fill');
    const marker = $('adp-pr-marker');
    const markerLabel = $('adp-pr-marker-label');

    if (fill) {
        fill.style.width = '0%';
        // Trigger animation on next frame
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                fill.style.width = position + '%';
            });
        });
    }
    if (marker) {
        marker.style.left = '0%';
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                marker.style.left = position + '%';
            });
        });
    }
    if (markerLabel) {
        markerLabel.textContent = formatPrice(current);
    }
}

/**
 * Format a price number with appropriate decimals.
 */
function formatPrice(n) {
    if (!isFinite(n)) return '';
    if (n >= 1000) return n.toLocaleString('en-US', { maximumFractionDigits: 0 });
    if (n >= 1) return n.toLocaleString('en-US', { maximumFractionDigits: 2 });
    return n.toLocaleString('en-US', { maximumFractionDigits: 6 });
}

function renderRelatedAnalyses(current) {
    const relatedSection = $('adp-related');
    const relatedList = $('adp-related-list');
    if (!relatedSection || !relatedList) return;

    const related = analyses
        .filter(x => x.id !== current.id && (
            x.coin === current.coin || x.timeframe === current.timeframe
        ))
        .sort((a, b) => new Date(b.created_at || 0) - new Date(a.created_at || 0))
        .slice(0, 3);

    if (!related.length) {
        relatedSection.style.display = 'none';
        return;
    }

    relatedSection.style.display = '';
    relatedList.innerHTML = related.map(r => `
        <div class="adp-related-item" onclick="openAnalysisDetailPage('${escapeHtml(r.id)}')">
            <div class="adp-related-coin">${escapeHtml(r.coin)}</div>
            <div class="adp-related-info">
                <div class="adp-related-title">${escapeHtml(r.title || `${r.coin} — ${r.timeframe || '1D'}`)}</div>
                <div class="adp-related-meta">
                    <span>${escapeHtml(r.timeframe || '1D')}</span>
                    <span>·</span>
                    <span><svg viewBox="0 0 24 24" width="12" height="12" fill="none" stroke="currentColor" stroke-width="2" style="vertical-align:-1px;opacity:0.7"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg> ${r.views_count || 0}</span>
                    <span>·</span>
                    <span>${timeAgo(r.created_at)}</span>
                </div>
            </div>
            <svg class="adp-related-arrow" viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="9 18 15 12 9 6"/></svg>
        </div>
    `).join('');
}

/**
 * Wire up scroll-based reading progress bar on the detail page.
 * Idempotent — safe to call multiple times.
 */
function setupReadingProgress() {
    const bar = $('adp-progress-bar');
    if (!bar) return;
    // Reset
    bar.style.width = '0%';
    // Remove old listener if any
    if (window._adpScrollHandler) {
        window.removeEventListener('scroll', window._adpScrollHandler, { passive: true });
    }
    const handler = () => {
        const scrollTop = window.scrollY;
        const docHeight = document.documentElement.scrollHeight - window.innerHeight;
        if (docHeight <= 0) { bar.style.width = '0%'; return; }
        const pct = Math.min(100, Math.max(0, (scrollTop / docHeight) * 100));
        bar.style.width = pct + '%';
    };
    window._adpScrollHandler = handler;
    window.addEventListener('scroll', handler, { passive: true });
    handler();
}

function closeAnalysisDetailPage() {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    const page = $('analysis-page');
    if (page) page.classList.add('active');
    // Restore bottom nav
    const nav = document.querySelector('.bottom-nav');
    if (nav) nav.style.display = '';
    // Clean up reading progress bar
    if (window._adpScrollHandler) {
        window.removeEventListener('scroll', window._adpScrollHandler, { passive: true });
        window._adpScrollHandler = null;
    }
    const bar = $('adp-progress-bar');
    if (bar) bar.style.width = '0%';
    currentAnalysisDetail = null;
    // Re-render list to update view counts
    renderAnalysisList();
}

// ── Share ──
function shareCurrentAnalysis() {
    if (!currentAnalysisDetail) return;
    shareAnalysisById(currentAnalysisDetail.id);
}

/**
 * Copy the current analysis content to clipboard.
 */
function copyAnalysisContent() {
    if (!currentAnalysisDetail) return;
    const a = currentAnalysisDetail;
    let text = `${a.coin} (${a.timeframe || '1D'})`;
    if (a.title) text += ` — ${a.title}`;
    text += '\n\n';
    text += a.content || a.text || '';
    if (a.support_level || a.current_price || a.resistance_level) {
        text += '\n\n';
        if (a.resistance_level) text += `مقاومت: ${a.resistance_level} | `;
        if (a.current_price) text += `قیمت فعلی: ${a.current_price} | `;
        if (a.support_level) text += `حمایت: ${a.support_level}`;
    }
    text += '\n\n📎 AMIRBTC';

    try {
        navigator.clipboard.writeText(text).then(() => {
            showToast('متن تحلیل کپی شد.');
        }).catch(() => {
            // Fallback for older WebViews
            const ta = document.createElement('textarea');
            ta.value = text;
            ta.style.position = 'fixed';
            ta.style.opacity = '0';
            document.body.appendChild(ta);
            ta.select();
            try { document.execCommand('copy'); showToast('متن تحلیل کپی شد.'); }
            catch { showToast('کپی ناموفق بود.'); }
            document.body.removeChild(ta);
        });
    } catch {
        showToast('کپی ناموفق بود.');
    }
}

function shareAnalysisById(id) {
    const a = analyses.find(x => x.id === id) || currentAnalysisDetail;
    if (!a) return;
    const deepLink = getAnalysisDeepLink(id);
    const text = `${a.coin} (${a.timeframe || '1D'})\n\n${truncateText(a.content || a.text || '', 200)}`;

    const tg = window.Telegram?.WebApp;
    if (tg?.openTelegramLink) {
        tg.openTelegramLink(`https://t.me/share/url?url=${encodeURIComponent(deepLink)}&text=${encodeURIComponent(text)}`);
    } else if (navigator.share) {
        navigator.share({ title: `${a.coin} Analysis`, text: text + '\n\n' + deepLink, url: deepLink }).catch(() => {});
    } else if (navigator.clipboard) {
        navigator.clipboard.writeText(text + '\n\n' + deepLink).then(() => {
            showToast('لینک تحلیل کپی شد!');
        });
    }
}

// ── Image Viewer (Fullscreen Zoom) ──
let ivScale = 1;
let ivTransX = 0, ivTransY = 0;
let ivDragging = false, ivStartX = 0, ivStartY = 0, ivStartTransX = 0, ivStartTransY = 0;

function openImageViewer() {
    if (!currentAnalysisDetail?.image) return;
    const overlay = $('image-viewer-overlay');
    const img = $('iv-image');
    if (!overlay || !img) return;
    img.src = currentAnalysisDetail.image;
    img.onerror = function() { newsImageFallback(this); };
    overlay.style.display = '';
    ivReset();
    document.body.style.overflow = 'hidden';
}

function closeImageViewer(event) {
    if (event && event.target !== event.currentTarget && !event.target.closest('.iv-close-btn')) return;
    const overlay = $('image-viewer-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
    ivReset();
}

function ivZoom(direction) {
    ivScale = direction > 0 ? Math.min(ivScale * 1.3, 5) : Math.max(ivScale / 1.3, 1);
    if (ivScale <= 1) { ivTransX = 0; ivTransY = 0; }
    applyImageViewerTransform();
}

function ivReset() {
    ivScale = 1; ivTransX = 0; ivTransY = 0;
    applyImageViewerTransform();
}

function applyImageViewerTransform() {
    const img = $('iv-image');
    if (img) {
        img.style.transform = `translate(${ivTransX}px, ${ivTransY}px) scale(${ivScale})`;
        img.style.transition = ivDragging ? 'none' : 'transform 0.2s ease';
    }
}

// Touch/drag handlers for image viewer
(function() {
    document.addEventListener('touchstart', function(e) {
        const overlay = $('image-viewer-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        if (ivScale <= 1) return;
        if (e.touches.length !== 1) return;
        ivDragging = true;
        ivStartX = e.touches[0].clientX;
        ivStartY = e.touches[0].clientY;
        ivStartTransX = ivTransX;
        ivStartTransY = ivTransY;
    }, { passive: true });

    document.addEventListener('touchmove', function(e) {
        if (!ivDragging) return;
        ivTransX = ivStartTransX + (e.touches[0].clientX - ivStartX);
        ivTransY = ivStartTransY + (e.touches[0].clientY - ivStartY);
        applyImageViewerTransform();
    }, { passive: true });

    document.addEventListener('touchend', function() { ivDragging = false; }, { passive: true });

    // Mouse drag for desktop
    document.addEventListener('mousedown', function(e) {
        const overlay = $('image-viewer-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        if (ivScale <= 1) return;
        const viewport = $('iv-viewport');
        if (!viewport || !viewport.contains(e.target)) return;
        ivDragging = true;
        ivStartX = e.clientX; ivStartY = e.clientY;
        ivStartTransX = ivTransX; ivStartTransY = ivTransY;
        e.preventDefault();
    });

    document.addEventListener('mousemove', function(e) {
        if (!ivDragging) return;
        ivTransX = ivStartTransX + (e.clientX - ivStartX);
        ivTransY = ivStartTransY + (e.clientY - ivStartY);
        applyImageViewerTransform();
    });

    document.addEventListener('mouseup', function() { ivDragging = false; });

    // Mouse wheel zoom
    document.addEventListener('wheel', function(e) {
        const overlay = $('image-viewer-overlay');
        if (!overlay || overlay.style.display === 'none') return;
        e.preventDefault();
        ivZoom(e.deltaY < 0 ? 1 : -1);
    }, { passive: false });
})();

// ── Deep Link Handler ──
function checkAnalysisDeepLink() {
    const tg = window.Telegram?.WebApp;
    let startParam = tg?.initDataUnsafe?.start_param;

    if (!startParam) {
        // Fallback: parse from URL query
        const urlParams = new URLSearchParams(window.location.search);
        startParam = urlParams.get('startapp') || urlParams.get('tgWebAppStartParam');
    }

    if (startParam && startParam.startsWith('analysis_')) {
        const analysisId = startParam.replace('analysis_', '');
        if (analysisId && /^[a-zA-Z0-9]+$/.test(analysisId)) {
            // Load analyses first, then open the detail
            fetchAnalyses(true).then(() => {
                openAnalysisDetailPage(analysisId);
            });
            return true;
        }
    }
    return false;
}

// ── Admin: Create / Edit ──
function updateAnalysisCharCounter() {
    const textEl = document.getElementById('analysis-text');
    const counterEl = document.getElementById('analysis-text-counter');
    if (!textEl || !counterEl) return;
    const len = textEl.value.length;
    const max = 5000;
    counterEl.textContent = `${len} / ${max}`;
    counterEl.classList.remove('warn', 'danger');
    if (len >= max) {
        counterEl.classList.add('danger');
    } else if (len >= max * 0.85) {
        counterEl.classList.add('warn');
    }
}

// Real-time char counter — initialized once
let _analysisCharCounterInit = false;
function initAnalysisCharCounter() {
    if (_analysisCharCounterInit) return;
    _analysisCharCounterInit = true;
    const textEl = document.getElementById('analysis-text');
    if (textEl) {
        textEl.addEventListener('input', updateAnalysisCharCounter);
    }
}

function openAddAnalysisModal() {
    if (!isAdmin()) return;
    editingAnalysisId = null;
    document.getElementById('analysis-modal-title').innerText = 'تحلیل جدید';
    document.getElementById('analysis-submit-btn').innerText = 'انتشار تحلیل';
    ['analysis-title', 'analysis-coin', 'analysis-timeframe', 'analysis-image', 'analysis-text', 'analysis-support', 'analysis-current-price', 'analysis-resistance'].forEach(id => {
        const el = document.getElementById(id);
        if (el) el.value = '';
    });
    const featuredEl = document.getElementById('analysis-featured');
    if (featuredEl) featuredEl.checked = false;
    const catEl = document.getElementById('analysis-category');
    if (catEl) catEl.value = 'crypto';
    document.getElementById('add-analysis-modal').style.display = 'flex';
    initAnalysisCharCounter();
    updateAnalysisCharCounter();
}

function openEditAnalysisModal(id) {
    if (!isAdmin()) return;
    const a = analyses.find(x => x.id === id) || (analysisFeatured?.id === id ? analysisFeatured : null);
    if (!a) return;
    editingAnalysisId = id;
    document.getElementById('analysis-modal-title').innerText = 'ویرایش تحلیل';
    document.getElementById('analysis-submit-btn').innerText = 'ذخیره تغییرات';
    document.getElementById('analysis-title').value = a.title || '';
    document.getElementById('analysis-coin').value = a.coin || '';
    document.getElementById('analysis-timeframe').value = a.timeframe || '';
    document.getElementById('analysis-image').value = a.image || '';
    document.getElementById('analysis-text').value = a.content || a.text || '';
    document.getElementById('analysis-support').value = a.support_level || '';
    document.getElementById('analysis-current-price').value = a.current_price || '';
    document.getElementById('analysis-resistance').value = a.resistance_level || '';
    const featuredEl = document.getElementById('analysis-featured');
    if (featuredEl) featuredEl.checked = Boolean(a.featured);
    const catEl = document.getElementById('analysis-category');
    if (catEl) catEl.value = a.category || 'crypto';
    document.getElementById('add-analysis-modal').style.display = 'flex';
    initAnalysisCharCounter();
    updateAnalysisCharCounter();
}

function closeAddAnalysisModal() {
    document.getElementById('add-analysis-modal').style.display = 'none';
    editingAnalysisId = null;
}

function showFeaturedLimitConfirm(onConfirm, onCancel) {
    const overlay = document.createElement('div');
    overlay.id = 'featured-limit-confirm';
    overlay.style.cssText = 'position:fixed;inset:0;z-index:10000;background:rgba(0,0,0,0.6);display:flex;align-items:center;justify-content:center;padding:20px;';
    overlay.innerHTML = `
        <div style="background:var(--bg-primary,#1a1a2e);border-radius:16px;padding:24px;max-width:340px;width:100%;text-align:center;direction:rtl;">
            <div style="font-size:32px;margin-bottom:12px;">⚠️</div>
            <p style="font-size:14px;line-height:1.8;color:var(--text-primary,#fff);margin:0 0 20px;">
                در حال حاضر ۵ تحلیل ویژه فعال دارید.<br>قدیمی‌ترین تحلیل ویژه حذف و این تحلیل جایگزین خواهد شد.<br>ادامه می‌دهید؟
            </p>
            <div style="display:flex;gap:10px;">
                <button id="fl-confirm-yes" style="flex:1;padding:10px;border:none;border-radius:10px;background:#e74c3c;color:#fff;font-size:14px;cursor:pointer;font-weight:bold;">بله، ادامه</button>
                <button id="fl-confirm-no" style="flex:1;padding:10px;border:none;border-radius:10px;background:var(--bg-secondary,#2a2a4a);color:var(--text-primary,#fff);font-size:14px;cursor:pointer;">انصراف</button>
            </div>
        </div>
    `;
    document.body.appendChild(overlay);
    overlay.querySelector('#fl-confirm-yes').onclick = () => { overlay.remove(); onConfirm(); };
    overlay.querySelector('#fl-confirm-no').onclick = () => { overlay.remove(); if (onCancel) onCancel(); };
    overlay.addEventListener('click', (e) => { if (e.target === overlay) { overlay.remove(); if (onCancel) onCancel(); } });
}

function submitAnalysis() {
    try {
        // ── Step 1: Read form elements ──
        const titleEl = document.getElementById('analysis-title');
        const coinEl  = document.getElementById('analysis-coin');
        const tfEl    = document.getElementById('analysis-timeframe');
        const imgEl   = document.getElementById('analysis-image');
        const textEl  = document.getElementById('analysis-text');
        const supEl   = document.getElementById('analysis-support');
        const priceEl = document.getElementById('analysis-current-price');
        const resEl   = document.getElementById('analysis-resistance');
        const featEl  = document.getElementById('analysis-featured');
        const catEl   = document.getElementById('analysis-category');

        // ── Step 2: Read values ──
        const title          = titleEl ? titleEl.value.trim() : '';
        const coin           = coinEl  ? coinEl.value.trim().toUpperCase() : '';
        const timeframe      = (tfEl && tfEl.value.trim()) ? tfEl.value.trim() : '1D';
        const image          = imgEl ? imgEl.value.trim() : '';
        const text           = textEl ? textEl.value.trim() : '';
        const support_level  = supEl   ? supEl.value.trim() : '';
        const current_price  = priceEl ? priceEl.value.trim() : '';
        const resistance_level = resEl  ? resEl.value.trim() : '';
        const featured       = featEl  ? featEl.checked : false;
        const category       = catEl   ? catEl.value : 'crypto';

        // ── Step 3: Validate ──
        if (!coin || !text) {
            showToast('نام ارز و متن تحلیل الزامی است.');
            return;
        }

        // ── Step 4: Build payload ──
        const author = getTelegramUser()?.first_name || 'مدیر';
        const payload = { coin, timeframe, image, text, author, title, support_level, current_price, resistance_level, featured, category };

        // ── Step 5: Disable button ──
        const btn = document.getElementById('analysis-submit-btn');
        if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerText = '⏳ در حال ارسال...'; }

        // ── Step 6: Async save with optimistic UI update ──
        const wasEditing = !!editingAnalysisId;
        (async () => {
            try {
                let result;
                if (wasEditing) {
                    result = await saveAnalysisToServer(payload, 'PUT', editingAnalysisId);
                } else {
                    result = await saveAnalysisToServer(payload, 'POST');
                }

                if (!result) {
                    showToast('خطا: پاسخی از سرور دریافت نشد.');
                    return;
                }

                if (result.status === 'FEATURED_LIMIT_REACHED') {
                    showFeaturedLimitConfirm(
                        async () => {
                            payload.force_featured = true;
                            let retryResult;
                            if (wasEditing) {
                                retryResult = await saveAnalysisToServer(payload, 'PUT', editingAnalysisId);
                            } else {
                                retryResult = await saveAnalysisToServer(payload, 'POST');
                            }
                            if (retryResult && retryResult.status === 'success') {
                                _applySaveResult(retryResult, wasEditing);
                            } else {
                                showToast(retryResult?.detail || retryResult?.message || 'خطا در ذخیره تحلیل.');
                            }
                        },
                        () => {
                            // Cancelled: retry without featured
                            payload.featured = false;
                            (async () => {
                                let retryResult;
                                if (wasEditing) {
                                    retryResult = await saveAnalysisToServer(payload, 'PUT', editingAnalysisId);
                                } else {
                                    retryResult = await saveAnalysisToServer(payload, 'POST');
                                }
                                if (retryResult && retryResult.status === 'success') {
                                    _applySaveResult(retryResult, wasEditing);
                                } else {
                                    showToast(retryResult?.detail || retryResult?.message || 'خطا در ذخیره تحلیل.');
                                }
                            })();
                        }
                    );
                    return;
                }

                if (result.status !== 'success') {
                    showToast(result.detail || result.message || 'خطا در ذخیره تحلیل.');
                    return;
                }

                _applySaveResult(result, wasEditing);
                showToast(wasEditing ? 'تحلیل ویرایش شد.' : 'تحلیل منتشر شد.');

                // Background refetch to sync with server
                fetchAnalyses(true).catch(() => {});
            } catch (e) {
                console.error('[ANALYSIS] save error:', e.message);
                showToast('خطا در ذخیره تحلیل: ' + (e.message || 'Unknown'));
            } finally {
                if (btn) { btn.disabled = false; btn.style.opacity = '1'; btn.innerText = wasEditing ? 'ذخیره تغییرات' : 'انتشار تحلیل'; }
            }
        })();
    } catch (syncErr) {
        console.error('[ANALYSIS] submit sync error:', syncErr.message);
        showToast('خطای غیرمنتظره: ' + (syncErr.message || 'Unknown'));
    }
}

function _applySaveResult(result, wasEditing) {
    if (!result.analysis) return;
    if (wasEditing) {
        const wasFeaturedBefore = analysisFeatured.some(a => a.id === result.analysis.id);
        const isFeaturedNow = result.analysis.featured;

        if (wasFeaturedBefore && !isFeaturedNow) {
            analysisFeatured = analysisFeatured.filter(a => a.id !== result.analysis.id);
            analyses.unshift(result.analysis);
        } else if (!wasFeaturedBefore && isFeaturedNow) {
            const idx = analyses.findIndex(a => a.id === result.analysis.id);
            if (idx >= 0) analyses.splice(idx, 1);
            analysisFeatured.unshift(result.analysis);
        } else if (wasFeaturedBefore && isFeaturedNow) {
            const fIdx = analysisFeatured.findIndex(a => a.id === result.analysis.id);
            if (fIdx >= 0) analysisFeatured[fIdx] = result.analysis;
            else analysisFeatured.unshift(result.analysis);
        } else {
            const idx = analyses.findIndex(a => a.id === result.analysis.id);
            if (idx >= 0) analyses[idx] = result.analysis;
        }
    } else {
        if (result.analysis.featured) {
            analysisFeatured.unshift(result.analysis);
            if (analysisFeatured.length > 5) analysisFeatured.length = 5;
        } else {
            analyses.unshift(result.analysis);
        }
    }

    if (result.version) analysisVersion = result.version;
    if (result.stats) {
        analysisStats = result.stats;
        localStorage.setItem('analysisStats', JSON.stringify(analysisStats));
    }
    if (result.featured !== undefined) {
        analysisFeatured = Array.isArray(result.featured) ? result.featured : (result.featured ? [result.featured] : []);
        localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
    } else {
        localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
    }

    closeAddAnalysisModal();
    renderAnalysisFeatured();
    renderAnalysisStats();
    renderAnalysisList();
    renderAnalysisSlider();
}

// ── Admin: Delete (Double Confirm) ──
function startDeleteAnalysis(id) {
    if (!isAdmin()) { showToast('فقط ادمین اجازه حذف تحلیل را دارد.'); return; }
    deletingAnalysisId = id;
    document.getElementById('delete-confirm-step1').style.display = '';
    document.getElementById('delete-confirm-step2').style.display = 'none';
    document.getElementById('delete-confirm-dialog').style.display = 'flex';
}

function confirmDeleteStep2() {
    document.getElementById('delete-confirm-step1').style.display = 'none';
    document.getElementById('delete-confirm-step2').style.display = '';
}

function cancelDeleteAnalysis() {
    document.getElementById('delete-confirm-dialog').style.display = 'none';
    deletingAnalysisId = null;
}

function executeDeleteAnalysis() {
    if (!deletingAnalysisId) return;
    const id = deletingAnalysisId;
    cancelDeleteAnalysis();
    (async () => {
        try {
            const result = await saveAnalysisToServer(null, 'DELETE', id);

            // ── CRITICAL: Check for null result (auth failure, network error, etc.) ──
            // Previously, null result was not caught, causing silent failure —
            // the analysis was removed from UI but never actually deleted from server.
            if (!result) {
                showToast('خطا در حذف تحلیل — لطفاً دوباره تلاش کنید.');
                return;
            }
            if (result.status !== 'success') {
                showToast(result.detail || result.message || 'خطا در حذف تحلیل.');
                return;
            }

            // ── OPTIMISTIC UI UPDATE ──
            // Remove from local array immediately
            const idx = analyses.findIndex(a => a.id === id);
            const wasFeatured = analysisFeatured.some(a => a.id === id);
            if (idx >= 0) analyses.splice(idx, 1);
            if (wasFeatured) analysisFeatured = analysisFeatured.filter(a => a.id !== id);
            // Update version from response
            if (result?.version) analysisVersion = result.version;

            // Use fresh stats + featured from CRUD response (KV-safe)
            if (result.stats) {
                analysisStats = result.stats;
                localStorage.setItem('analysisStats', JSON.stringify(analysisStats));
            }
            if (result.featured !== undefined) {
                analysisFeatured = Array.isArray(result.featured) ? result.featured : (result.featured ? [result.featured] : []);
                localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
            } else {
                localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
            }

            showToast('تحلیل حذف شد.');

            // If we're on the detail page of the deleted analysis, go back
            if (currentAnalysisDetail?.id === id) {
                closeAnalysisDetailPage();
            }

            // Re-render with updated local data (instant)
            renderAnalysisFeatured();
            renderAnalysisStats();
            renderAnalysisList();
            renderAnalysisSlider();

            // Background refetch to sync (non-blocking)
            fetchAnalyses(true).then(() => {
                renderAnalysisFeatured();
                renderAnalysisStats();
                renderAnalysisList();
                renderAnalysisSlider();
                updateAnalysisFabVisibility();
            }).catch(() => {});
        } catch (e) {
            console.error('deleteAnalysis:', e);
            showToast('خطا در حذف تحلیل.');
        }
    })();
}

function editCurrentAnalysis() {
    if (!currentAnalysisDetail?.id) return;
    openEditAnalysisModal(currentAnalysisDetail.id);
}

function deleteCurrentAnalysis() {
    if (!currentAnalysisDetail?.id) return;
    startDeleteAnalysis(currentAnalysisDetail.id);
}

// Keep old name for backward compat in dashboard
function shareAnalysis() { shareCurrentAnalysis(); }

// ── Dashboard Slider (kept for dashboard page) ──
function renderAnalysisSlider() {
    const track = document.getElementById('slider-track');
    const dots = document.getElementById('slider-dots');
    if (!track) return;
    if (!analyses.length) {
        track.innerHTML = `<div class="slide-empty">تحلیلی موجود نیست</div>`;
        if (dots) dots.innerHTML = '';
        return;
    }
    const showSlide = (idx) => {
        const a = analyses[idx];
        track.innerHTML = `
            <div class="slide-item" onclick="openAnalysisDetailPage('${escapeHtml(a.id)}')">
                <img src="${escapeHtml(a.image || '')}" class="slide-img" loading="lazy" onerror="newsImageFallback(this)">
                <div class="slide-overlay">
                    <h4>${escapeHtml(a.coin)} (${escapeHtml(a.timeframe || '1D')})</h4>
                    <p>${escapeHtml(truncateText(a.content || a.text || '', 80))}</p>
                    <span class="slide-author">${escapeHtml(a.author || '')} • ${escapeHtml(a.date || '')}</span>
                </div>
            </div>
        `;
        if (dots) dots.innerHTML = analyses.map((_, i) => `<span class="dot ${i === idx ? 'active' : ''}"></span>`).join('');
    };
    if (currentSlide >= analyses.length) currentSlide = 0;
    showSlide(currentSlide);
    clearInterval(sliderInterval);
    sliderInterval = setInterval(() => {
        currentSlide = (currentSlide + 1) % analyses.length;
        showSlide(currentSlide);
    }, 5000);
}

//#endregion

/**
 * عملیات مربوط به sendSessionHeartbeat را انجام می‌دهد.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function sendSessionHeartbeat() {
    if (!_appVisible) return;
    const uid = getUserId();
    if (!canRunSessionRequests(uid)) return;
    try {
        const params = new URLSearchParams({ user_id: uid });
        if (sessionId) params.set('session_id', sessionId);
        const data = await apiFetch(`/api/sessions/heartbeat?${params}`, { method: 'POST' });
        if (data.session_id) {
            sessionId = data.session_id;
            localStorage.setItem('app_session_id', sessionId);
        }
        updateOnlineBadge(data.online_count);
        // First successful heartbeat = auth confirmed → load alerts lazily
        if (!alerts.length || alerts.every(a => !a.serverId)) {
            loadAlertsFromServer().catch(() => {});
        }
    } catch (e) { console.warn('heartbeat:', e); }
}

/**
 * آنلاین count را از منبع داده دریافت می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function fetchOnlineCount() {
    if (!canRunSessionRequests()) return;
    try {
        const data = await apiFetch('/api/sessions/online');
        updateOnlineBadge(data.count);
    } catch (_) {}
}

/**
 * آنلاین نشان را به‌روزرسانی می‌کند.
 * ورودی: پارامترهای `count` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function updateOnlineBadge(count) {
    const badge = document.getElementById('online-badge');
    const countEl = document.getElementById('online-count');
    if (!badge || !countEl) return;
    if (count > 0) {
        badge.style.display = 'inline-flex';
        countEl.innerText = count;
    } else {
        badge.style.display = 'none';
    }
    const liveCountEl = document.getElementById('live-count');
    if (liveCountEl) liveCountEl.innerText = count > 0 ? count : '—';
}

/**
 * دعوت آمار را بارگذاری می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function loadReferralStats() {
    const uid = getUserId();
    if (!API_BASE || isGuestUserId(uid) || isPendingTelegramUserId(uid) || UserContext.isPending()) return;
    try {
        const data = await apiFetch('/api/referrals/stats');
        const rt = $('ref-total'); if (rt) rt.innerText = data.total ?? 0;
        const ra = $('ref-active'); if (ra) ra.innerText = data.active ?? 0;
        const rr = $('ref-reward'); if (rr) rr.innerText = `${data.tokens ?? 0} AB`;
    } catch (e) { console.warn('loadReferralStats:', e); }
}

/**
 * تقویم رویدادها را بارگذاری می‌کند.
 * ورودی: پارامترهای `force = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function loadCalendarEvents(force = false) {
    if (calendarEvents.length && !force) return calendarEvents;
    if (!API_BASE) return [];
    if (calendarLoading) return calendarEvents;
    calendarLoading = true;
    try {
        const data = await apiFetch('/api/calendar/events');
        calendarEvents = data.events || [];
    } catch (e) {
        console.warn('loadCalendarEvents:', e);
        calendarEvents = [];
    } finally {
        calendarLoading = false;
    }
    return calendarEvents;
}

/**
 * رویداد تقویم را به بخش‌های امروز/فردا/پس‌فردا/گذشته گروه‌بندی و مرتب می‌کند.
 * زمان‌ها به منطقه زمانی کاربر تبدیل می‌شوند.
 */
function groupCalendarEvents(events) {
    const tz = 'Asia/Tehran';
    const now = new Date();
    const todayParts = now.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
    const todayStart = new Date(Date.UTC(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2])));
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    const dayAfterStart = new Date(todayStart.getTime() + 2 * 86400000);

    const groups = { today: [], tomorrow: [], dayAfter: [], past: [] };

    events.forEach(e => {
        let eventDate = null;
        if (e.timestamp) {
            eventDate = new Date(e.timestamp);
        }
        if (!eventDate || isNaN(eventDate.getTime())) {
            groups.past.push(e);
            return;
        }

        // Convert event UTC to Tehran date for grouping
        const eventParts = eventDate.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
        const eventDay = new Date(Date.UTC(Number(eventParts[0]), Number(eventParts[1]) - 1, Number(eventParts[2])));

        if (eventDay.getTime() === todayStart.getTime()) {
            groups.today.push(e);
        } else if (eventDay.getTime() === tomorrowStart.getTime()) {
            groups.tomorrow.push(e);
        } else if (eventDay.getTime() === dayAfterStart.getTime()) {
            groups.dayAfter.push(e);
        } else if (eventDay < tomorrowStart) {
            groups.past.push(e);
        } else {
            groups.dayAfter.push(e);
        }
    });

    return groups;
}

/**
 * زمان ISO رویداد را به فرمت محلی تبدیل می‌کند.
 * خروجی مثال: "14:30" یا "8 July - 16:00"
 */
function formatCalendarTime(timestamp) {
    if (!timestamp) return '';
    const d = new Date(timestamp);
    if (isNaN(d.getTime())) return '';
    const tz = 'Asia/Tehran';
    const hh = d.toLocaleString('en-GB', { timeZone: tz, hour: '2-digit', minute: '2-digit', hour12: false });
    const day = d.toLocaleString('en-GB', { timeZone: tz, day: 'numeric' });
    const monthNames = currentLang === 'fa'
        ? ['ژانویه','فوریه','مارس','آوریل','مه','ژوئن','ژوئیه','اوت','سپتامبر','اکتبر','نوامبر','دسامبر']
        : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthIndex = Number(d.toLocaleString('en-GB', { timeZone: tz, month: 'numeric' })) - 1;
    const monthName = monthNames[monthIndex] || '';
    return { time: hh, dayStr: `${day} ${monthName}` };
}

/**
 * مقدار نهایی چارت نماد را تعیین می‌کند.
 * ورودی: پارامترهای `symbol` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function resolveChartSymbol(symbol) {
    const cacheKey = `chart_${symbol}`;
    const cached = Cache.get(cacheKey);
    if (cached) return cached;

    // FIX 2: Fully dynamic exchange resolution via backend.
    // Backend checks exchanges in STRICT priority order (sequential, not parallel):
    // Binance > Bybit > OKX > KuCoin > Gate > MEXC > CoinEx
    // Highest-priority exchange that has the symbol wins. Results cached 24h per symbol.
    if (API_BASE) {
        try {
            const data = await apiFetch(`/api/charts/resolve?symbol=${encodeURIComponent(symbol)}`);
            if (data.found && data.tv_symbol) {
                Cache.set(cacheKey, data, 3600);
                return data;
            }
            console.log('[CHART] Symbol not found on any exchange:', symbol);
        } catch (e) { console.warn('resolveChartSymbol:', e); }
    }

    // No chart available for this symbol
    const notFound = { found: false, symbol: symbol, exchange: null, tv_symbol: null };
    Cache.set(cacheKey, notFound, 300); // Short cache — retry sooner
    return notFound;
}

/**
 * درخواست HTTP داخلی را با هدر احراز هویت تلگرام و مدیریت خطا به API ارسال می‌کند.
 * ورودی: پارامترهای `path, options = {}` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
// R3-6: Request deduplication — if the same GET request is already in-flight, reuse its promise
const _requestInFlight = {};

async function apiFetch(path, options = {}) {
    // Deduplicate GET requests only (POST/PUT/DELETE must always go through)
    const method = (options.method || 'GET').toUpperCase();
    const dedupeKey = method === 'GET' ? path : null;
    if (dedupeKey && _requestInFlight[dedupeKey]) {
        return _requestInFlight[dedupeKey];
    }

    await waitForApiReady(8000);
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const initData = getTelegramInitData();
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    const url = `${API_BASE}${path}`;

    const fetchOpts = { ...options, headers };
    const doRequest = async () => {
        const res = await fetch(url, fetchOpts);
        if (!res.ok) {
            let detail = '';
            try { detail = await res.text(); } catch (_) {}
            const err = new Error(detail || `HTTP ${res.status}`);
            if (path === '/api/users/bootstrap') {
                console.error('[BOOT] apiFetch bootstrap FAILED — status:', res.status, 'detail:', detail);
            }
            throw err;
        }
        return res.json();
    };

    // Track in-flight GET request
    if (dedupeKey) {
        const promise = doRequest().finally(() => { delete _requestInFlight[dedupeKey]; });
        _requestInFlight[dedupeKey] = promise;
        return promise;
    }

    return doRequest();
}

/**
 * بک‌اند سلامت را بررسی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function checkBackendHealth() {
    if (!API_BASE) return false;
    try {
        const res = await fetch(`${API_BASE}/api/health`, { signal: AbortSignal.timeout(8000) });
        return res.ok;
    } catch (_) { return false; }
}

/**
 * آنلاین count را از منبع داده دریافت می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
function updateLangChecks() {
    const svg = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polyline points="20 6 9 17 4 12"/></svg>';
    const fa = document.getElementById('lang-fa-check');
    const en = document.getElementById('lang-en-check');
    if (fa) fa.innerHTML = currentLang === 'fa' ? svg : '';
    if (en) en.innerHTML = currentLang === 'en' ? svg : '';
}

/**
 * تنظیمات مربوط به زبان را اعمال می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
// Cached i18n element references — invalidated when new elements are rendered.
// Set to null whenever dynamic content is rendered so next applyLanguage() re-queries.
let _i18nElements = null;
let _i18nPlaceholderElements = null;

function invalidateI18nCache() {
    _i18nElements = null;
    _i18nPlaceholderElements = null;
}

function applyLanguage() {
    if (!_i18nElements) {
        _i18nElements = document.querySelectorAll('[data-i18n]');
        _i18nPlaceholderElements = document.querySelectorAll('[data-i18n-placeholder]');
    }
    _i18nElements.forEach(el => { const key = el.dataset.i18n; if (key) el.innerText = t(key); });
    _i18nPlaceholderElements.forEach(el => { const key = el.dataset.i18nPlaceholder; if (key) el.placeholder = t(key); });
    document.documentElement.lang = currentLang;
    document.documentElement.dir = currentLang === 'fa' ? 'rtl' : 'ltr';
    saveLangToStorage();
    updateLangChecks();
}
/**
 * رابط کاربری را نوسازی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function refreshUI() {
    // Critical path: language, user info, and visible market data
    invalidateI18nCache();
    applyLanguage();
    loadUser();
    renderMarket();
    renderWatchlist();
    renderSummary();
    renderMarketInsights();

    // Defer non-critical renders to next frame to reduce main thread blocking
    requestAnimationFrame(() => {
        renderAnalysisSlider();
        renderAnalysisList();
        if (newsCache.length) renderNews(document.querySelector('.news-tab.active')?.dataset?.news || 'all');
        loadImportantNews();
        renderTickets();
        renderActiveAlerts(document.getElementById('detail-coin-title')?.innerText?.split(' ')[0] || '');
    });
}
/**
 * زبان را انتخاب و اعمال می‌کند.
 * ورودی: پارامترهای `lang` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
/**
 * زبان را تغییر می‌دهد.
 * ورودی: پارامترهای `lang` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function changeLang(lang) { selectLang(lang); }

//#endregion

// ============================================================================
//#region کش درون‌حافظه‌ای
// ============================================================================
/**
 * کش درون‌حافظه‌ای ساده برنامه را برای داده‌های کوتاه‌عمر مدیریت می‌کند.
 * ورودی: کلید، داده و زمان انقضا را از متدهای داخلی خود دریافت می‌کند.
 * خروجی: داده کش‌شده را ذخیره یا بازیابی می‌کند.
 */
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

/**
 * رشته متنی را برای استفاده امن در innerHTML escape می‌کند.
 * جلوگیری از XSS — گزارش §7#6, §8.2#9
 * @param {string} str
 * @returns {string}
 */
function escapeHtml(str) {
    if (!str) return '';
    return String(str).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/**
 * Professional icon fallback: replaces broken img with first-letter badge.
 * Called via onerror="iconFallback(this)" on coin/forex images.
 */
window.iconFallback = function(imgEl) {
    const symbol = (imgEl.dataset.symbol || imgEl.alt || 'X').toUpperCase();
    const letter = symbol.charAt(0);
    // Generate a gradient index from the symbol hash
    let hash = 0;
    for (let i = 0; i < symbol.length; i++) hash = ((hash << 5) - hash) + symbol.charCodeAt(i);
    const gradIdx = Math.abs(hash) % 10;
    const size = imgEl.classList.contains('detail-coin-icon') ? '40px' : (imgEl.classList.contains('mover-icon') ? '26px' : '32px');
    const fontSize = imgEl.classList.contains('detail-coin-icon') ? '16px' : (imgEl.classList.contains('mover-icon') ? '10px' : '13px');
    const div = document.createElement('div');
    div.className = (imgEl.className || '') + ' coin-icon-fallback';
    div.dataset.symbol = imgEl.dataset.symbol || '';
    div.dataset.grad = String(gradIdx);
    div.style.cssText = 'width:' + size + ';height:' + size + ';min-width:' + size + ';border-radius:50%;display:flex;align-items:center;justify-content:center;font-size:' + fontSize + ';';
    div.textContent = letter;
    imgEl.replaceWith(div);
};

/**
 * Premium AMIRBTC fallback image — dark theme, gold accent, crypto style.
 * Used for news thumbnails, analysis images, hero images, and modal images.
 * Returns a data URI SVG string.
 */
function getAmirbtcFallbackSvg(width, height, text) {
    const w = width || 400;
    const h = height || 220;
    const label = text || 'AMIRBTC';
    return `data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='${w}' height='${h}' viewBox='0 0 ${w} ${h}'%3E%3Cdefs%3E%3ClinearGradient id='bg' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%230B0F14'/%3E%3Cstop offset='100%25' stop-color='%23151C24'/%3E%3C/linearGradient%3E%3ClinearGradient id='acc' x1='0' y1='0' x2='1' y2='1'%3E%3Cstop offset='0%25' stop-color='%23FF8A00'/%3E%3Cstop offset='100%25' stop-color='%23FFD700'/%3E%3C/linearGradient%3E%3C/defs%3E%3Crect width='${w}' height='${h}' fill='url(%23bg)' rx='12'/%3E%3Crect x='${w/2-40}' y='${h/2-40}' width='80' height='80' rx='16' fill='none' stroke='url(%23acc)' stroke-width='2' opacity='0.3'/%3E%3Ctext x='${w/2}' y='${h/2+6}' fill='url(%23acc)' font-family='sans-serif' font-size='24' font-weight='bold' text-anchor='middle'%3E₿%3C/text%3E%3Ctext x='${w/2}' y='${h/2+40}' fill='%2364748b' font-family='sans-serif' font-size='11' text-anchor='middle'%3E${encodeURIComponent(label)}%3C/text%3E%3C/svg%3E`;
}

/**
 * Global news/analysis image fallback handler.
 * Replaces broken images with the premium AMIRBTC fallback SVG.
 * Usage: onerror="newsImageFallback(this)"
 */
window.newsImageFallback = function(imgEl) {
    if (imgEl._fallbackApplied) return;
    imgEl._fallbackApplied = true;
    // Determine size from class or default
    const isHero = imgEl.classList.contains('news-hero-image');
    const isThumb = imgEl.classList.contains('news-card-thumb');
    const isSlide = imgEl.classList.contains('slide-img');
    const isFeatured = imgEl.classList.contains('featured-image');
    const isModal = imgEl.id === 'news-modal-image';
    const isAnalysisThumb = imgEl.classList.contains('acv-thumb');
    const isViewer = imgEl.id === 'iv-image';

    let w = 400, h = 220, label = 'AMIRBTC';
    if (isHero) { w = 400; h = 220; }
    else if (isThumb) { w = 220; h = 220; }
    else if (isSlide) { w = 200; h = 170; label = 'No Chart'; }
    else if (isFeatured) { w = 300; h = 200; }
    else if (isModal) { w = 400; h = 250; }
    else if (isAnalysisThumb) { w = 120; h = 120; label = (imgEl.alt || 'A').charAt(0); }
    else if (isViewer) { w = 800; h = 600; label = 'Image Unavailable'; }

    imgEl.src = getAmirbtcFallbackSvg(w, h, label);
    imgEl.style.objectFit = 'cover';
};

/**
 * Generate SVG polyline points for a mini sparkline chart.
 * Uses seeded random from symbol for deterministic output.
 */
function generateSparklinePoints(changePercent, symbol, width, height) {
    width = width || 56;
    height = height || 24;
    let seed = 0;
    for (let i = 0; i < symbol.length; i++) seed += symbol.charCodeAt(i) * (i + 1);
    function sRand() { seed = (seed * 16807) % 2147483647; return (seed - 1) / 2147483646; }

    var points = [];
    var steps = 16;
    var midY = height / 2;
    var amp = Math.min(height * 0.38, Math.abs(changePercent) * 0.6 + 1.5);
    var dir = changePercent >= 0 ? -1 : 1;

    for (var i = 0; i <= steps; i++) {
        var x = (i / steps) * width;
        var progress = i / steps;
        var trend = dir * progress * amp;
        var noise = (sRand() - 0.5) * amp * 0.5;
        var y = Math.max(2, Math.min(height - 2, midY + trend + noise));
        points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return points.join(' ');
}

//#endregion

// ============================================================================
//#region پروکسی و منابع داده بازار
// ============================================================================
/**
 * بررسی می‌کند که آیا RSS URL برقرار است یا خیر.
 * ورودی: پارامترهای `url` را دریافت می‌کند.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function isRssUrl(url) {
    return url.includes('/rss') || url.endsWith('/feed/') || url.includes('outboundfeeds/rss');
}

/**
 * درخواست داده را از مسیر پروکسی اجرا می‌کند و در صورت نیاز به مسیر جایگزین سوئیچ می‌کند.
 * ورودی: پارامترهای `url, options = {}` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function fetchWithProxy(url, options = {}) {
    const opts = typeof options === 'number' ? { retries: options } : options;
    const { asText = isRssUrl(url), retries = 2 } = opts;
    for (let i = 0; i < retries; i++) {
        try {
            const proxyUrl = PROXY + encodeURIComponent(url);
            const res = await fetch(proxyUrl);
            if (!res.ok) {
                const errorText = await res.text();
                console.warn(`⚠️ Proxy HTTP ${res.status}: ${errorText}`);
                throw new Error(`HTTP ${res.status}`);
            }
            return asText ? await res.text() : await res.json();
        } catch (e) {
            console.warn(`Attempt ${i+1} failed:`, e);
            await new Promise(resolve => setTimeout(resolve, 2000 * (i + 1)));
        }
    }
}
//#endregion

// ============================================================================
//#region بارگذاری داده‌های بازار
// ============================================================================
/**
 * داده بازار را از کش یا منبع راه‌دور دریافت می‌کند و اجزای وابسته را به‌روزرسانی می‌کند.
 * ورودی: پارامترهای `force = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
/**
 * بارگذاری داده‌های Market Overview از CMC (بدون نیاز به auth).
 * فقط totalMarketCap, totalVolume, btcDominance, ethDominance, fearGreed, marketStatus.
 * داده از کش Worker خوانده می‌شود — مستقیم به CoinMarketCap وصل نمی‌شود.
 */
async function loadMarketOverview() {
    if (!API_BASE || globalMarketData?.source === 'coinmarketcap') return; // already fresh from CMC
    try {
        const res = await apiFetch('/api/market/overview');
        if (res.status === 'success' && (res.totalMarketCap > 0 || res.fearGreedValue > 0)) {
            globalMarketData = res;
            console.log('[OVERVIEW] CMC data loaded — mcap:', res.totalMarketCap, 'fg:', res.fearGreedValue);
        }
    } catch (e) {
        console.warn('[OVERVIEW] Failed to load CMC overview:', e);
    }
}

async function loadMarketData(force = false) {
    const listEl = document.getElementById('coin-list');
    const refreshBtn = document.getElementById('market-refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');
    try {
        if (!force) {
            const cached = Cache.get('market');
            if (cached?.length) {
                allCoins = cached;
                renderMarket();
                renderWatchlist();
                renderSummary();
                return;
            }
        }
        // Show skeleton loader while fetching (P0-1)
        if (listEl && !allCoins.length) {
            listEl.innerHTML = Array(8).fill(`
                <div class="market-skeleton">
                    <div class="market-skeleton-left">
                        <div class="market-skeleton-icon"></div>
                        <div class="market-skeleton-text">
                            <div class="market-skeleton-line"></div>
                            <div class="market-skeleton-line"></div>
                        </div>
                    </div>
                    <div class="market-skeleton-right">
                        <div class="market-skeleton-block"></div>
                        <div class="market-skeleton-block"></div>
                    </div>
                </div>
            `).join('');
        }

        // Primary: backend /api/market (coin list) + CMC overview (parallel)
        if (API_BASE) {
            // Fetch CMC overview in parallel — no dependency on coin list
            const overviewPromise = loadMarketOverview();
            try {
                const res = await apiFetch('/api/market');
                await overviewPromise; // wait for overview too
                if (res.status === 'success' && Array.isArray(res.data) && res.data.length) {
                    // Backend normalizes ALL sources to percentage format:
                    // CoinGecko/Binance Futures: already percentage (direct use)
                    // CoinCap/MEXC: decimal fraction → ×100 in backend
                    // No frontend heuristic needed.
                    console.log('[MARKET] dataSource:', res.dataSource || 'unknown', 'coins:', res.data.length);
                    ['BTC','ETH','SOL','XRP','DOGE'].forEach(function(s) {
                        var c = res.data.find(function(x) { return x.symbol === s; });
                        if (c) console.log('[MARKET]', s, 'changePercent24Hr:', c.changePercent24Hr);
                    });
                    allCoins = res.data;
                    if (res.global && typeof res.global === 'object' && res.global !== null) globalMarketData = res.global;
                }
            } catch (e) {
                console.warn('Backend /api/market failed:', e);
            }
        }

        if (!allCoins.length) throw new Error('No market data');
        Cache.set('market', allCoins, 120);
        // Phase C: Persist market data to localStorage for instant watchlist render on cold start
        // Defer cache write off the critical render path (2-5ms saved per market load)
        requestIdleCallback?.(() => { try { localStorage.setItem('market_data_cache', JSON.stringify(allCoins)); localStorage.setItem('market_cache_version', String(3)); } catch(_) {} }) ?? setTimeout(() => { try { localStorage.setItem('market_data_cache', JSON.stringify(allCoins)); localStorage.setItem('market_cache_version', String(3)); } catch(_) {} }, 200);
        lastMarketFetchTime = Date.now();
        renderMarket();
        renderWatchlist();
        renderSummary();
        renderMarketInsights();
    } catch (e) {
        console.error('❌ Market load error:', e);
        if (listEl && !allCoins.length) {
            listEl.innerHTML = `<div class="empty-state">${t('market_error')}</div>`;
        }
    } finally {
        const refreshBtn = document.getElementById('market-refresh-btn');
        if (refreshBtn) refreshBtn.classList.remove('spinning');
    }
}

/**
 * Refresh market data (force reload).
 */
function refreshMarketData() {
    loadMarketData(true);
}

/**
 * Load forex pair data from backend.
 */
async function loadForexData() {
    if (!API_BASE) return;
    try {
        const cached = Cache.get('forex');
        if (cached?.length) {
            allForexPairs = cached;
            renderMarket();
            return;
        }
        const res = await apiFetch('/api/forex');
        if (res.status === 'success' && Array.isArray(res.data)) {
            allForexPairs = res.data;
            Cache.set('forex', allForexPairs, 120);
            renderMarket();
        }
    } catch (e) {
        console.warn('Forex data load failed:', e);
    }
}

//#endregion

// ============================================================================
//#region خلاصه بازار
// ============================================================================
/**
 * خلاصه بازار (مارکت‌کپ کل، حجم ۲۴h، سلطه BTC) را در summary bar رندر می‌کند.
 * داده از globalMarketData (backend /api/market response) یا محاسبه از allCoins.
 */
function renderSummary() {
    const mcapEl = document.getElementById('global-mcap');
    const volEl = document.getElementById('global-volume');
    const domEl = document.getElementById('btc-dom');
    if (!mcapEl) return;

    // Remove skeleton loading state
    mcapEl.classList.remove('loading');
    volEl?.classList.remove('loading');
    domEl?.classList.remove('loading');

    if (globalMarketData) {
        const mcapVal = globalMarketData.totalMarketCap;
        const volVal = globalMarketData.totalVolume;
        const domVal = globalMarketData.btcDominance;
        mcapEl.textContent = (mcapVal > 0) ? '$' + formatLargeNumber(mcapVal) : '--';
        volEl.textContent = (volVal > 0) ? '$' + formatLargeNumber(volVal) : '--';
        domEl.textContent = (domVal > 0) ? domVal.toFixed(1) + '%' : '--';
    } else {
        // Fallback: compute from allCoins
        let totalMcap = 0;
        let totalVol = 0;
        let btcMcap = 0;
        for (let i = 0; i < allCoins.length; i++) {
            const c = allCoins[i];
            totalMcap += (c.marketCapUsd || 0);
            totalVol += (c.volumeUsd24Hr || 0);
            if (c.symbol === 'BTC') btcMcap = c.marketCapUsd || 0;
        }
        // BUG 1 FIX: Show '--' for zero/missing data instead of $0 or fake values
        mcapEl.textContent = totalMcap > 0 ? '$' + formatLargeNumber(totalMcap) : '--';
        volEl.textContent = totalVol > 0 ? '$' + formatLargeNumber(totalVol) : '--';
        domEl.textContent = totalMcap > 0 ? ((btcMcap / totalMcap) * 100).toFixed(1) + '%' : '--';
    }
}

/**
 * Format large numbers: >1T → X.XXT, >1B → X.XXB, >1M → X.XXM
 */
function formatLargeNumber(n) {
    if (n == null || isNaN(n)) return '--';
    const abs = Math.abs(n);
    const sign = n < 0 ? '-' : '';
    if (abs >= 1e12) return sign + (abs / 1e12).toFixed(2) + 'T';
    if (abs >= 1e9) return sign + (abs / 1e9).toFixed(2) + 'B';
    if (abs >= 1e6) return sign + (abs / 1e6).toFixed(2) + 'M';
    if (abs >= 1e3) return sign + (abs / 1e3).toFixed(1) + 'K';
    return sign + abs.toFixed(0);
}

/**
 * Render market insights: sentiment bar + fear & greed gauge.
 * Called from refreshUI after market data loads.
 */
function renderMarketInsights() {
    if (!allCoins.length) return;

    // --- Sentiment ---
    var gainers = 0, losers = 0;
    for (var i = 0; i < allCoins.length; i++) {
        if (allCoins[i].changePercent24Hr > 0) gainers++;
        else if (allCoins[i].changePercent24Hr < 0) losers++;
    }
    var total = gainers + losers;
    var ratio = total > 0 ? gainers / total : 0.5;

    // Gradient fill bar (top bar width = ratio)
    var fillEl = document.getElementById('sentiment-fill');
    if (fillEl) fillEl.style.width = (ratio * 100).toFixed(1) + '%';

    // Badge
    var badgeEl = document.getElementById('sentiment-badge');
    if (badgeEl) {
        var sLabel, sClass;
        if (ratio > 0.6) { sLabel = t('sentiment_bullish'); sClass = 'bullish'; }
        else if (ratio >= 0.4) { sLabel = t('sentiment_neutral'); sClass = 'neutral'; }
        else { sLabel = t('sentiment_bearish'); sClass = 'bearish'; }
        badgeEl.textContent = sLabel;
        badgeEl.className = 'sentiment-badge ' + sClass;
    }

    // Gainers / Losers numbers (nested span inside)
    var gEl = document.getElementById('sentiment-gainers');
    if (gEl) { var gs = gEl.querySelector('span'); if (gs) gs.textContent = gainers; }
    var lEl = document.getElementById('sentiment-losers');
    if (lEl) { var ls = lEl.querySelector('span'); if (ls) ls.textContent = losers; }

    // --- Fear & Greed ---
    // FIX 4: Only show real data from Alternative.me. Hide the entire section if unavailable.
    if (globalMarketData && globalMarketData.fearGreedValue > 0) {
        var fgIndex = globalMarketData.fearGreedValue;
        var fgSource = globalMarketData.fearGreedSource || 'real';
        var fgClass = (globalMarketData.fearGreedClassification || '').toLowerCase();
        var fgLabel;
        if (fgClass === 'extreme greed' || fgClass === 'extreme_greed') fgLabel = t('fg_extreme_greed');
        else if (fgClass === 'greed') fgLabel = t('fg_greed');
        else if (fgClass === 'neutral') fgLabel = t('fg_neutral');
        else if (fgClass === 'fear') fgLabel = t('fg_fear');
        else if (fgClass === 'extreme fear' || fgClass === 'extreme_fear') fgLabel = t('fg_extreme_fear');
        else fgLabel = globalMarketData.fearGreedClassification || '--';
        console.log('[FG] Real data from', fgSource, ':', fgIndex, fgLabel);

        // Show FG section (it may have been hidden on a previous load)
        var fgCard = document.querySelector('.fear-greed-card');
        if (fgCard) fgCard.style.display = '';

        var fgValueEl = document.getElementById('fg-index-value');
        if (fgValueEl) fgValueEl.textContent = fgIndex;

        var fgArcEl = document.getElementById('fg-arc');
        if (fgArcEl) {
            var totalLen = 150.8;
            var offset = totalLen - (totalLen * fgIndex / 100);
            fgArcEl.setAttribute('stroke-dashoffset', offset.toFixed(1));
        }

        var fgTextEl = document.getElementById('fg-gauge-text');
        if (fgTextEl) fgTextEl.textContent = fgIndex;
        var fgLabelEl = document.getElementById('fg-gauge-label');
        if (fgLabelEl) fgLabelEl.textContent = fgLabel;
    } else {
        // No real F&G data available — hide the entire section
        console.log('[FG] No real data available, hiding section');
        var fgCardHide = document.querySelector('.fear-greed-card');
        if (fgCardHide) fgCardHide.style.display = 'none';
    }
}

/**
 * Render top 3 gainers and top 3 losers.
 * NOTE: This section has been removed from the UI (BUG 4).
 * Function kept as no-op for safety (no references from HTML remain).
 */
function renderTopMovers() { return; }

//#endregion

// ============================================================================
//#region فهرست و تب‌های بازار
// ============================================================================
/**
 * بازار را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function renderMarket() {
    const list = document.getElementById('coin-list');
    if (!list) return;

    // Price-only diffing: if the list is already rendered with the same tab/filter/search,
    // just update prices and change percentages — avoid full innerHTML rebuild (~30-60ms → ~3-5ms)
    const renderKey = `${currentMarketTab}|${searchTerm}|${watchlist.length}|${marketVisibleCount}`;
    if (!searchTerm && currentMarketTab !== 'forex' && _lastMarketRenderKey === renderKey && list.querySelector('.coin-item')) {
        // Update info bar timestamp
        const timeEl = list.querySelector('.coin-list-time');
        if (timeEl) {
            const now = new Date();
            timeEl.textContent = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
        }
        // Update prices in-place
        const items = list.querySelectorAll('.coin-item');
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const symbol = item.dataset.symbol;
            if (!symbol) continue;
            const coin = allCoins.find(c => c.symbol === symbol);
            if (!coin) continue;

            const priceEl = item.querySelector('.coin-price');
            if (priceEl) {
                const newPrice = '$' + (coin.priceUsd > 1 ? coin.priceUsd.toFixed(2) : coin.priceUsd.toFixed(6));
                if (priceEl.textContent !== newPrice) {
                    var oldPrice = parseFloat(priceEl.textContent.replace(/[$,]/g, '')) || 0;
                    priceEl.textContent = newPrice;
                    // Price flash animation
                    priceEl.classList.remove('flash-up', 'flash-down');
                    void priceEl.offsetWidth; // force reflow
                    if (coin.priceUsd > oldPrice) priceEl.classList.add('flash-up');
                    else if (coin.priceUsd < oldPrice) priceEl.classList.add('flash-down');
                }
            }
            const changeEl = item.querySelector('.coin-change');
            if (changeEl && !item.dataset.forex) {
                const isPos = coin.changePercent24Hr >= 0;
                const newChange = (isPos ? '+' : '') + coin.changePercent24Hr.toFixed(2) + '%';
                if (changeEl.textContent !== newChange) {
                    changeEl.textContent = newChange;
                    changeEl.className = 'coin-change ' + (isPos ? 'up' : 'down');
                }
            }
            // Update watchlist star state
            const starEl = item.querySelector('.watch-star');
            if (starEl) {
                const inWatch = watchlist.includes(symbol);
                if (inWatch !== starEl.classList.contains('active')) {
                    starEl.classList.toggle('active', inWatch);
                    const svgEl = starEl.querySelector('svg');
                    if (svgEl) svgEl.setAttribute('fill', inWatch ? 'currentColor' : 'none');
                }
            }
        }
        return;
    }
    _lastMarketRenderKey = renderKey;

    // Helper to build the info bar
    function buildInfoBar(count, label) {
        const now = new Date();
        const timeStr = now.getHours().toString().padStart(2,'0') + ':' + now.getMinutes().toString().padStart(2,'0');
        return `<div class="coin-list-info"><span class="coin-list-count">${count} ${label}</span><span class="coin-list-time">${timeStr}</span></div>`;
    }

    // Unified search: search across crypto and all market types
    if (searchTerm) {
        const cryptoResults = allCoins.filter(c =>
            c.symbol.toLowerCase().includes(searchTerm) ||
            c.name.toLowerCase().includes(searchTerm)
        ).slice(0, 50);

        const forexResults = allForexPairs.filter(f =>
            f.symbol.toLowerCase().includes(searchTerm) ||
            f.name.toLowerCase().includes(searchTerm) ||
            (f.tvSymbol && f.tvSymbol.toLowerCase().includes(searchTerm))
        ).slice(0, 30);

        const allResults = [...cryptoResults.map(c => ({...c, _type: 'crypto'})), ...forexResults.map(f => ({...f, _type: 'forex'}))];

        if (!allResults.length && (allCoins.length || allForexPairs.length)) {
            const icon = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
            list.innerHTML = `<div class="empty-state">${icon}<br>${t('search_no_result')}</div>`;
            return;
        }
        if (!allResults.length) {
            list.innerHTML = Array(8).fill(`
                <div class="market-skeleton">
                    <div class="market-skeleton-left">
                        <div class="market-skeleton-icon"></div>
                        <div class="market-skeleton-text">
                            <div class="market-skeleton-line"></div>
                            <div class="market-skeleton-line"></div>
                        </div>
                    </div>
                    <div class="market-skeleton-right">
                        <div class="market-skeleton-block"></div>
                        <div class="market-skeleton-block"></div>
                    </div>
                </div>
            `).join('');
            return;
        }
        list.innerHTML = buildInfoBar(allResults.length, t('search_results') || 'result') + allResults.map(item => renderMarketItem(item)).join('');
        return;
    }

    // Tab-based rendering (no search)
    if (currentMarketTab === 'forex') {
        if (!allForexPairs.length) {
            // Show skeleton or loading for forex
            list.innerHTML = Array(5).fill(`
                <div class="market-skeleton">
                    <div class="market-skeleton-left">
                        <div class="market-skeleton-icon"></div>
                        <div class="market-skeleton-text">
                            <div class="market-skeleton-line"></div>
                            <div class="market-skeleton-line"></div>
                        </div>
                    </div>
                    <div class="market-skeleton-right">
                        <div class="market-skeleton-block"></div>
                        <div class="market-skeleton-block"></div>
                    </div>
                </div>
            `).join('');
            return;
        }
        list.innerHTML = buildInfoBar(allForexPairs.length, t('tab_forex') || 'Forex') + allForexPairs.map(f => renderMarketItem({...f, _type: 'forex'})).join('');
        return;
    }

    // Crypto tabs (overview, gainers, losers, watchlist)
    let filtered = [...allCoins];
    switch (currentMarketTab) {
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
            // Performance: limit visible coins, show Load More button
            if (filtered.length > MARKET_DEFAULT_LIMIT) {
                const visible = filtered.slice(0, marketVisibleCount);
                const hasMore = marketVisibleCount < filtered.length;
                const totalLabel = currentMarketTab === 'watchlist' ? (t('watchlist') || 'Watchlist') : (t('tab_crypto') || 'Crypto');
                let html = buildInfoBar(filtered.length, totalLabel) + visible.map(c => renderMarketItem({...c, _type: 'crypto'})).join('');
                if (hasMore) {
                    const remaining = filtered.length - marketVisibleCount;
                    html += `<button class="load-more-btn" onclick="loadMoreCoins()">${t('load_more') || 'نمایش بیشتر'} (${remaining})</button>`;
                }
                list.innerHTML = html;
            } else {
                list.innerHTML = buildInfoBar(filtered.length, currentMarketTab === 'watchlist' ? (t('watchlist') || 'Watchlist') : (t('tab_crypto') || 'Crypto')) + filtered.map(c => renderMarketItem({...c, _type: 'crypto'})).join('');
            }
            return;
    }
    if (!filtered.length && allCoins.length) {
        const msg = t('no_data');
        const icon = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" stroke-width="1.5"><circle cx="12" cy="12" r="10"/><line x1="8" y1="15" x2="16" y2="15"/></svg>';
        list.innerHTML = `<div class="empty-state">${icon}<br>${msg}</div>`;
        return;
    }
    if (!filtered.length) {
        list.innerHTML = Array(8).fill(`
                <div class="market-skeleton">
                    <div class="market-skeleton-left">
                        <div class="market-skeleton-icon"></div>
                        <div class="market-skeleton-text">
                            <div class="market-skeleton-line"></div>
                            <div class="market-skeleton-line"></div>
                        </div>
                    </div>
                    <div class="market-skeleton-right">
                        <div class="market-skeleton-block"></div>
                        <div class="market-skeleton-block"></div>
                    </div>
                </div>
            `).join('');
        return;
    }
    list.innerHTML = buildInfoBar(filtered.length, currentMarketTab === 'watchlist' ? (t('watchlist') || 'Watchlist') : (t('tab_crypto') || 'Crypto')) + filtered.map(c => renderMarketItem({...c, _type: 'crypto'})).join('');
}

/**
 * Load more coins into the market list (appends next batch).
 */
function loadMoreCoins() {
    marketVisibleCount += MARKET_LOAD_MORE_BATCH;
    renderMarket();
    // Remove the load-more-btn after re-render (renderMarket recreates it)
}

/**
 * Render a single market item (crypto or forex).
 */
function renderMarketItem(item) {
    if (item._type === 'forex') {
        return renderForexItem(item);
    }
    return renderCryptoItem(item);
}

function renderCryptoItem(c) {
    const isPos = c.changePercent24Hr >= 0;
    const inWatch = watchlist.includes(c.symbol);
    const safeSymbol = escapeHtml(c.symbol);
    const safeName = escapeHtml(c.name);
    const icon = c.image || `https://assets.coincap.io/assets/icons/${encodeURIComponent(c.symbol).toLowerCase()}@2x.png`;
    const priceStr = c.priceUsd > 1 ? c.priceUsd.toFixed(2) : c.priceUsd.toFixed(6);
    const rankNum = Number(c.rank) || 0;
    return `
        <div class="coin-item" data-symbol="${safeSymbol}" onclick="openCoinDetail(this.dataset.symbol)" role="listitem">
            <div class="coin-left">
                <span class="coin-rank">${rankNum}</span>
                <img src="${escapeHtml(icon)}" onerror="iconFallback(this)" class="coin-icon" data-symbol="${safeSymbol}" alt="${safeSymbol}">
                <div class="coin-identity">
                    <span class="coin-sym">${safeSymbol}</span>
                    <span class="coin-name">${safeName}</span>
                </div>
            </div>
            <div class="coin-right">
                <div class="coin-price-data">
                    <div class="coin-price">$${priceStr}</div>
                    <div class="coin-change ${isPos ? 'up' : 'down'}">${isPos ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</div>
                </div>
                <span class="watch-star ${inWatch ? 'active' : ''}" data-symbol="${safeSymbol}" onclick="toggleWatchlist(this.dataset.symbol, event)" role="button" aria-label="${inWatch ? 'Remove from watchlist' : 'Add to watchlist'}" tabindex="0">
                    <svg width="14" height="14" viewBox="0 0 24 24" fill="${inWatch ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2.5" aria-hidden="true">
                        <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/>
                    </svg>
                </span>
            </div>
        </div>
    `;
}

function renderForexItem(f) {
    const safeSymbol = escapeHtml(f.symbol);
    const safeName = escapeHtml(f.name);
    const cat = f.category || 'major';
    const catConfig = {
        major:    { color: 'var(--green)',  icon: 'M',  label: 'Major' },
        cross:    { color: 'var(--accent)', icon: 'X',  label: 'Cross' },
        metal:    { color: '#ffd700',     icon: 'Au', label: 'Metal' },
        index:    { color: '#60a5fa',     icon: 'ID', label: 'Index' },
        commodity:{ color: '#f97316',     icon: 'Cm', label: 'Commodity' },
    };
    const cfg = catConfig[cat] || catConfig.major;
    const decimals = cat === 'metal' ? 2 : (cat === 'index' || cat === 'commodity' ? 0 : 4);
    const priceStr = f.price > 0 ? f.price.toFixed(decimals) : '--';
    const catLabelFa = { major: 'جفت اصلی', cross: 'کراس', metal: 'فلز', index: 'شاخص', commodity: 'کالا' };
    const catLabel = currentLang === 'fa' ? (catLabelFa[cat] || cat) : cfg.label;
    return `
        <div class="coin-item" data-symbol="${safeSymbol}" data-forex="true" data-category="${cat}" onclick="openForexDetail(this.dataset.symbol)" role="listitem">
            <div class="coin-left">
                <div class="forex-icon-wrap" style="background:${cfg.color}15; color:${cfg.color}">
                    <span class="forex-pair-icon">${cfg.icon}</span>
                </div>
                <div class="coin-identity">
                    <span class="coin-sym">${safeName}</span>
                    <span class="coin-name">${catLabel}</span>
                </div>
            </div>
            <div class="coin-right">
                <div class="coin-price-data">
                    <div class="coin-price">${priceStr}</div>
                    <div class="coin-change" style="color:${cfg.color}; background:${cfg.color}15;">${cfg.label.toUpperCase()}</div>
                </div>
            </div>
        </div>
    `;
}

/**
 * Switch between the 3 main tabs: crypto / forex / watchlist.
 */
function switchMainTab(tab, btn) {
    currentMainTab = tab;
    // Sync legacy currentMarketTab for backward compatibility
    if (tab === 'crypto') {
        currentMarketTab = currentSubTab === 'top' ? 'overview' : currentSubTab;
    } else {
        currentMarketTab = tab;
    }

    // Update main tab active states
    document.querySelectorAll('.seg-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Update segmented indicator position
    var indicator = document.getElementById('seg-indicator');
    if (indicator) {
        indicator.classList.remove('pos-0', 'pos-1', 'pos-2');
        var idx = tab === 'crypto' ? 0 : (tab === 'forex' ? 1 : 2);
        // BUG 3 FIX: Always set explicit position class, including pos-0
        indicator.classList.add('pos-' + idx);
    }

    // Show/hide crypto sub-tabs
    const subTabs = document.getElementById('market-sub-tabs');
    if (subTabs) {
        if (tab === 'crypto') {
            subTabs.classList.remove('hidden');
        } else {
            subTabs.classList.add('hidden');
        }
    }

    // Show/hide summary bar and insights (only for crypto, not forex/watchlist)
    const summaryBar = document.getElementById('market-stats-row');
    if (summaryBar) {
        summaryBar.style.display = (tab === 'crypto') ? '' : 'none';
    }
    const insightsRow = document.getElementById('market-insights-row');
    if (insightsRow) {
        insightsRow.style.display = (tab === 'crypto') ? '' : 'none';
    }

    // Show/hide FAB (only on watchlist tab)
    const fab = document.querySelector('.fab-add-watch');
    if (fab) {
        if (tab === 'watchlist') {
            fab.classList.remove('fab-hidden');
        } else {
            fab.classList.add('fab-hidden');
        }
    }

    // Load forex data on first visit
    if (tab === 'forex' && !allForexPairs.length) {
        loadForexData();
    }

    // Re-render with animation
    const list = document.getElementById('coin-list');
    if (list) {
        list.classList.remove('fade-in');
        list.classList.add('fade-out');
        setTimeout(() => {
            renderMarket();
            list.classList.remove('fade-out');
            list.classList.add('fade-in');
        }, 120);
    } else {
        renderMarket();
    }
}

/**
 * Switch between crypto sub-tabs: top / gainers / losers.
 */
function switchSubTab(tab, btn) {
    currentSubTab = tab;
    // Sync legacy currentMarketTab
    currentMarketTab = tab === 'top' ? 'overview' : tab;
    // Reset visible count when switching tabs
    marketVisibleCount = MARKET_DEFAULT_LIMIT;

    // Update sub-tab active states
    document.querySelectorAll('.sub-tab-btn').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Re-render with animation
    const list = document.getElementById('coin-list');
    if (list) {
        list.classList.remove('fade-in');
        list.classList.add('fade-out');
        setTimeout(() => {
            renderMarket();
            list.classList.remove('fade-out');
            list.classList.add('fade-in');
        }, 120);
    } else {
        renderMarket();
    }
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('market-search')?.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        renderMarket();
    });
    // Initialize analysis toolbar (search, sort, timeframe chips)
    initAnalysisToolbar();
});

//#endregion

// ============================================================================
//#region واچ‌لیست
// ============================================================================
/**
 * وضعیت واچ‌لیست را بین دو حالت جابه‌جا می‌کند.
 * ورودی: پارامترهای `symbol, event` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function toggleWatchlist(symbol, event) {
    if (event) event.stopPropagation();
    const idx = watchlist.indexOf(symbol);
    const isAdding = idx === -1;
    if (isAdding) {
        if (watchlist.length >= MAX_WATCHLIST) {
            getTg()?.showPopup?.({
                title: t('watchlist'),
                message: t('watchlist_limit'),
                buttons: [{ type: 'ok' }]
            }) || alert(t('watchlist_limit'));
            return;
        }
        watchlist.push(symbol);
    } else {
        watchlist.splice(idx, 1);
    }
    persistWatchlist();
    renderMarket();
    renderWatchlist();
    showMiniToast(isAdding ? '★ ' + symbol : '✕ ' + symbol);
}

/**
 * Show a brief inline toast notification.
 */
function showMiniToast(msg) {
    let toast = document.getElementById('mini-toast');
    if (!toast) {
        toast = document.createElement('div');
        toast.id = 'mini-toast';
        document.body.appendChild(toast);
    }
    toast.textContent = msg;
    toast.classList.remove('toast-show');
    // Force reflow to restart animation
    void toast.offsetWidth;
    toast.classList.add('toast-show');
    clearTimeout(toast._timer);
    toast._timer = setTimeout(() => toast.classList.remove('toast-show'), 1200);
}

/**
 * showToast — alias for showMiniToast. Used throughout the analysis module
 * and other sections. Shows a brief non-blocking toast at the bottom of the screen.
 */
function showToast(msg) {
    showMiniToast(msg);
    // Also trigger haptic feedback if available
    try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch {}
}
/**
 * واچ‌لیست را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function renderWatchlist() {
    const grid = $('watchlist-grid');
    if (!grid) return;
    const watchCoins = allCoins.filter(c => watchlist.includes(c.symbol));
    if (!watchCoins.length) {
        grid.innerHTML = `
            <div class="watchlist-empty-state">
                <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" stroke-width="1.5"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                <span class="watchlist-empty-title">${t('watchlist_empty')}</span>
                <span class="watchlist-empty-desc">${t('watchlist_empty_desc')}</span>
                <button class="watchlist-empty-btn" onclick="openAddCoinModal()">${t('watchlist_add_btn')}</button>
            </div>`;
        return;
    }

    // Price-only diffing: if watchlist items exist and count matches, update prices in-place
    const existingItems = grid.querySelectorAll('.watch-item');
    if (existingItems.length === watchCoins.length && !grid.querySelector('.watchlist-empty-state')) {
        for (let i = 0; i < existingItems.length; i++) {
            const item = existingItems[i];
            const coin = watchCoins[i];
            if (!coin || item.dataset.symbol !== coin.symbol) {
                // Symbols don't match — fall through to full render
                break;
            }
            const priceEl = item.querySelector('.watch-price');
            if (priceEl) {
                const newPrice = '$' + (coin.priceUsd > 1 ? coin.priceUsd.toFixed(2) : coin.priceUsd.toFixed(6));
                if (priceEl.textContent !== newPrice) priceEl.textContent = newPrice;
            }
            const changeEl = item.querySelector('.watch-change');
            if (changeEl) {
                const isPos = coin.changePercent24Hr >= 0;
                const newChange = (isPos ? '+' : '') + coin.changePercent24Hr.toFixed(2) + '%';
                if (changeEl.textContent !== newChange) {
                    changeEl.textContent = newChange;
                    changeEl.className = 'watch-change ' + (isPos ? 'up' : 'down');
                }
            }
            // All items matched — return early, no full render needed
            if (i === existingItems.length - 1) return;
        }
    }

    grid.innerHTML = watchCoins.map(c => {
        const safeSymbol = escapeHtml(c.symbol);
        const icon = c.image || `https://assets.coincap.io/assets/icons/${encodeURIComponent(c.symbol).toLowerCase()}@2x.png`;
        return `
        <div class="watch-item" data-symbol="${safeSymbol}" onclick="openCoinDetail(this.dataset.symbol)">
            <span class="remove-watch" data-symbol="${safeSymbol}" onclick="toggleWatchlist(this.dataset.symbol, event)"><svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg></span>
            <img src="${escapeHtml(icon)}" onerror="iconFallback(this)" class="watch-icon" data-symbol="${safeSymbol}">
            <span class="watch-sym">${safeSymbol}</span>
            <span class="watch-price">$${c.priceUsd > 1 ? c.priceUsd.toFixed(2) : c.priceUsd.toFixed(6)}</span>
            <span class="watch-change ${c.changePercent24Hr >= 0 ? 'up' : 'down'}">${c.changePercent24Hr >= 0 ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</span>
        </div>
    `;}).join('');
}
/**
 * add ارز مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'flex';
    populateCoinModal();
}
/**
 * add ارز مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'none';
}
/**
 * عملیات مربوط به populateCoinModal را انجام می‌دهد.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function populateCoinModal() {
    const list = document.getElementById('coin-modal-list');
    if (!allCoins.length) return;
    list.innerHTML = allCoins.map(c => {
        const inList = watchlist.includes(c.symbol);
        const atLimit = !inList && watchlist.length >= MAX_WATCHLIST;
        const safeSymbol = escapeHtml(c.symbol);
        const safeName = escapeHtml(c.name);
        return `
        <div class="modal-coin-item ${atLimit ? 'disabled' : ''}" data-symbol="${safeSymbol}" onclick="${atLimit ? '' : `toggleWatchlist(this.dataset.symbol, event); populateCoinModal();`}">
            <span>${safeSymbol} - ${safeName}</span>
            <span class="${inList ? 'star-filled' : 'star-empty'}">${inList ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'}</span>
        </div>`;
    }).join('');
}
/**
 * عملیات مربوط به filterCoinList را انجام می‌دهد.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function filterCoinList() {
    const q = document.getElementById('coin-search-modal').value.toLowerCase();
    document.querySelectorAll('.modal-coin-item').forEach(el => {
        el.style.display = el.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
    });
}

//#endregion

// ============================================================================
//#region اخبار و تقویم اقتصادی
// ============================================================================
let newsCache = [];
let newsPage = 1;
let newsHasMore = false;
let newsTotalCount = 0;
let categoryCounts = { all: 0, crypto: 0, forex: 0 };

let displayedNews = [];
let newsLoadObserver = null;
let calCountdownInterval = null;
let currentCalCountry = 'all';

// ============================================================================
// NOTE (Phase 5): translateText, translateArticles, detectNewsCategory,
// parseRssItems, fetchRssArticles — all removed.
// Backend now handles: multi-source RSS, translation (CF Workers AI), categories.
// Frontend only calls /api/farsi-news and uses the 'category' field directly.
// ============================================================================

function sentimentBadge(sentiment) {
    const s = (sentiment || '').toLowerCase();
    const map = {
        bullish: '<span class="news-card-sentiment sentiment-bullish">🟢 Bullish</span>',
        bearish: '<span class="news-card-sentiment sentiment-bearish">🔴 Bearish</span>',
        macro: '<span class="news-card-sentiment sentiment-macro">🟡 Macro</span>',
        neutral: '<span class="news-card-sentiment sentiment-neutral">⚪ Neutral</span>',
        breaking: '<span class="news-card-sentiment sentiment-breaking">🚨 Breaking</span>',
    };
    return map[s] || map.neutral;
}

function sentimentBadgeHero(sentiment) {
    const s = (sentiment || '').toLowerCase();
    const map = {
        bullish: '<span class="news-hero-sentiment sentiment-bullish">🟢 Bullish</span>',
        bearish: '<span class="news-hero-sentiment sentiment-bearish">🔴 Bearish</span>',
        macro: '<span class="news-hero-sentiment sentiment-macro">🟡 Macro</span>',
        neutral: '<span class="news-hero-sentiment sentiment-neutral">⚪ Neutral</span>',
        breaking: '<span class="news-hero-sentiment sentiment-breaking">🚨 Breaking</span>',
    };
    return map[s] || map.neutral;
}

function updateNewsBadges() {
    const el = (id) => document.getElementById(id);
    const bAll = el('badge-all'); if (bAll) bAll.textContent = categoryCounts.all || '';
    const bCrypto = el('badge-crypto'); if (bCrypto) bCrypto.textContent = categoryCounts.crypto || '';
    const bForex = el('badge-forex'); if (bForex) bForex.textContent = categoryCounts.forex || '';
    const bCal = el('badge-calendar'); if (bCal) bCal.textContent = calendarEvents.length || '';
}

function setupInfiniteScroll() {
    if (newsLoadObserver) newsLoadObserver.disconnect();
    const trigger = document.getElementById('news-load-trigger');
    if (!trigger) return;
    newsLoadObserver = new IntersectionObserver((entries) => {
        if (entries[0].isIntersecting && newsHasMore) {
            loadMoreNews();
        }
    }, { rootMargin: '200px' });
    newsLoadObserver.observe(trigger);
}

/**
 * اخبار را از کش یا منابع راه‌دور دریافت می‌کند و فهرست خبرها را برای نمایش آماده می‌سازد.
 * ورودی: پارامترهای `force = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function loadNews(force = false, append = false) {
    try {
        if (!force && !append) {
            const cached = Cache.get('news');
            if (cached) {
                newsCache = cached;
                renderNews(document.querySelector('.news-tab.active')?.dataset?.news || 'all');
                loadNews(true);
                return;
            }
        }
        const container = document.getElementById('news-list');
        if (!container) return;
        const activeTab = document.querySelector('.news-tab.active')?.dataset?.news || 'all';
        if (!append && activeTab !== 'calendar') {
            container.innerHTML = `
                <div class="skeleton-hero"></div>
                ${Array(4).fill(`
                <div class="skeleton-card">
                    <div class="skeleton-card-thumb"></div>
                    <div class="skeleton-card-body">
                        <div class="skeleton-line w-30"></div>
                        <div class="skeleton-line w-90"></div>
                        <div class="skeleton-line w-70"></div>
                        <div class="skeleton-line w-50"></div>
                    </div>
                </div>`).join('')}
            `;
        }

        const page = append ? newsPage + 1 : 1;
        let articles = [];
        let hasMore = false;
        let total = 0;

        try {
            const json = await apiFetch(`/api/farsi-news?page=${page}&limit=20`);
            if (json.data?.length) {
                articles = json.data.map(a => ({
                    title: a.title, body: a.description, source: a.source,
                    image: a.image, url: a.url, time: a.time_ago,
                    category: a.category || 'crypto',
                    sentiment: a.sentiment || 'neutral',
                    summary: a.summary || ''
                }));
            }
            hasMore = json.pagination?.hasMore || false;
            total = json.pagination?.total || 0;
            if (json.categoryCounts) {
                categoryCounts = json.categoryCounts;
                updateNewsBadges();
            }
        } catch (e) { console.warn('Farsi news API error:', e); }

        if (append) {
            newsCache = [...newsCache, ...articles];
        } else {
            newsCache = articles;
        }
        newsPage = page;
        newsHasMore = hasMore;
        newsTotalCount = total;

        // Infer counts from cache if API didn't provide
        if (!categoryCounts.all) {
            categoryCounts.all = newsCache.length;
            categoryCounts.crypto = newsCache.filter(n => n.category === 'crypto').length;
            categoryCounts.forex = newsCache.filter(n => n.category === 'forex').length;
            updateNewsBadges();
        }

        Cache.set('news', newsCache, 300);
        renderNews(activeTab);
    } catch (e) {
        console.error('News error:', e);
        const container = document.getElementById('news-list');
        if (container) container.innerHTML = `<div class="empty-state">${t('news_error')}</div>`;
    }
}

function loadMoreNews() {
    if (!newsHasMore) return;
    loadNews(false, true);
}

/**
 * اخبار را در رابط کاربری رندر می‌کند.
 * ورودی: پارامترهای `category` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function renderNews(category) {
    const container = document.getElementById('news-list');
    if (!container) return;

    // Clear any existing countdown interval
    if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }

    let filtered = newsCache;
    if (category === 'crypto') filtered = filtered.filter(n => n.category === 'crypto');
    else if (category === 'economy') filtered = filtered.filter(n => n.category === 'economy');
    else if (category === 'forex') filtered = filtered.filter(n => n.category === 'forex');
    else if (category === 'calendar') {
        renderCalendar();
        return;
    }

    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">${t('no_data')}</div>`;
        return;
    }

    displayedNews = filtered;
    const placeholderImg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22 viewBox=%220 0 24 24%22 fill=%22%23151C24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E';

    let html = '';
    const heroItem = filtered[0];
    const heroImg = heroItem.image || placeholderImg;

    // Hero card
    if (category === 'all' && heroImg && !heroImg.includes('data:image/svg')) {
        html += `
        <div class="news-hero" onclick="openNewsModal(0)">
            <img class="news-hero-image" src="${escapeHtml(heroImg)}" loading="eager" alt="" onerror="newsImageFallback(this)">
            <div class="news-hero-overlay">
                ${sentimentBadgeHero(heroItem.sentiment)}
                <div class="news-hero-title">${escapeHtml(heroItem.title)}</div>
                <div class="news-hero-meta">${escapeHtml(heroItem.source)} • ${escapeHtml(heroItem.time || '')}</div>
            </div>
        </div>`;
    }

    // News cards (skip first if used as hero)
    const startIdx = (category === 'all' && heroImg && !heroImg.includes('data:image/svg')) ? 1 : 0;
    for (let i = startIdx; i < filtered.length; i++) {
        const n = filtered[i];
        const idx = i;
        const delay = (i - startIdx) * 0.06;
        html += `
        <div class="news-card" style="animation-delay:${delay}s" onclick="openNewsModal(${idx})">
            <div class="news-card-body">
                ${sentimentBadge(n.sentiment)}
                <div class="news-card-title">${escapeHtml(n.title)}</div>
                ${n.summary ? `<div class="news-card-summary">${escapeHtml(n.summary)}</div>` : ''}
                <div class="news-card-meta">${escapeHtml(n.source)} • ${escapeHtml(n.time || '')}</div>
            </div>
            <img class="news-card-thumb" src="${escapeHtml(n.image || placeholderImg)}" loading="lazy" alt="" onerror="newsImageFallback(this)">
        </div>`;
    }

    // Infinite scroll trigger
    if (newsHasMore && (category === 'all' || category === 'crypto' || category === 'forex')) {
        html += `<div class="news-load-trigger" id="news-load-trigger"></div>`;
    }

    container.innerHTML = html;
    setupInfiniteScroll();
}

// ============================================================================
// Calendar Rendering
// ============================================================================

const MAJOR_EVENTS = ['CPI', 'NFP', 'FOMC', 'GDP', 'Retail Sales', 'PMI', 'Interest Rate', 'Employment', 'Unemployment'];

function isMajorEvent(title) {
    if (!title) return false;
    const t = title.toUpperCase();
    return MAJOR_EVENTS.some(k => t.includes(k));
}

function getTimeGroup(hour) {
    if (hour < 12) return 'morning';
    if (hour < 17) return 'afternoon';
    return 'evening';
}

const timeGroupLabels = {
    fa: { morning: 'صبح', afternoon: 'بعدازظهر', evening: 'عصر/شب' },
    en: { morning: 'Morning', afternoon: 'Afternoon', evening: 'Evening' }
};

function formatCountdown(ms) {
    if (ms <= 0) return '';
    const h = Math.floor(ms / 3600000);
    const m = Math.floor((ms % 3600000) / 60000);
    const s = Math.floor((ms % 60000) / 1000);
    if (h > 0) return `${h}h ${m}m ${s}s`;
    if (m > 0) return `${m}m ${s}s`;
    return `${s}s`;
}

function renderCalendar() {
    const container = document.getElementById('news-list');
    if (!container) return;

    // Update calendar badge
    const bCal = document.getElementById('badge-calendar');
    if (bCal) bCal.textContent = calendarEvents.length || '';

    if (calendarLoading) {
        container.innerHTML = `
            <div class="cal-nav">
                <button class="cal-nav-btn active">${t('cal_today')}</button>
                <button class="cal-nav-btn">${t('cal_tomorrow')}</button>
                <button class="cal-nav-btn">${t('cal_week')}</button>
            </div>
            ${Array(4).fill(`
                <div class="skeleton-card" style="height:100px;">
                    <div class="skeleton-card-body" style="width:100%;">
                        <div class="skeleton-line w-70"></div>
                        <div class="skeleton-line w-90"></div>
                        <div class="skeleton-line w-50"></div>
                    </div>
                </div>
            `).join('')}`;
        return;
    }

    loadCalendarEvents().then(events => {
        if (!events.length) {
            container.innerHTML = `
                <div class="cal-nav">
                    <button class="cal-nav-btn active">${t('cal_today')}</button>
                    <button class="cal-nav-btn">${t('cal_tomorrow')}</button>
                    <button class="cal-nav-btn">${t('cal_week')}</button>
                </div>
                <div class="empty-state">${t('cal_empty')}</div>`;
            return;
        }

        // Filter by tab
        const now = new Date();
        const tz = 'Asia/Tehran';
        const todayParts = now.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
        const todayStart = new Date(Date.UTC(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2])));
        const tomorrowStart = new Date(todayStart.getTime() + 86400000);
        const weekEnd = new Date(todayStart.getTime() + 7 * 86400000);

        let filteredEvents = events.filter(e => {
            if (!e.timestamp) return false;
            const eventDate = new Date(e.timestamp);
            if (isNaN(eventDate.getTime())) return false;
            const eventParts = eventDate.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
            const eventDay = new Date(Date.UTC(Number(eventParts[0]), Number(eventParts[1]) - 1, Number(eventParts[2])));
            if (currentCalendarTab === 'today') return eventDay.getTime() === todayStart.getTime();
            if (currentCalendarTab === 'tomorrow') return eventDay.getTime() === tomorrowStart.getTime();
            if (currentCalendarTab === 'week') return eventDay >= todayStart && eventDay < weekEnd;
            return true;
        });

        if (currentCalendarTab === 'past') {
            filteredEvents = events.filter(e => {
                if (!e.timestamp) return false;
                const eventDate = new Date(e.timestamp);
                if (isNaN(eventDate.getTime())) return false;
                const eventParts = eventDate.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
                const eventDay = new Date(Date.UTC(Number(eventParts[0]), Number(eventParts[1]) - 1, Number(eventParts[2])));
                return eventDay < todayStart;
            });
            filteredEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
        }

        // Country filter
        const countries = [...new Set(filteredEvents.map(e => e.country).filter(Boolean))];
        if (currentCalCountry && currentCalCountry !== 'all') {
            filteredEvents = filteredEvents.filter(e => e.country === currentCalCountry);
        }

        // Build navigation tabs
        const navHtml = `<div class="cal-nav">
            <button class="cal-nav-btn${currentCalendarTab === 'today' ? ' active' : ''}" onclick="switchCalendarTab('today', this)">${t('cal_today')}</button>
            <button class="cal-nav-btn${currentCalendarTab === 'tomorrow' ? ' active' : ''}" onclick="switchCalendarTab('tomorrow', this)">${t('cal_tomorrow')}</button>
            <button class="cal-nav-btn${currentCalendarTab === 'week' ? ' active' : ''}" onclick="switchCalendarTab('week', this)">${t('cal_week')}</button>
        </div>`;

        // Country filter buttons
        let countryHtml = '';
        if (countries.length > 1) {
            countryHtml = `<div class="cal-country-filter">
                <button class="cal-country-btn${currentCalCountry === 'all' ? ' active' : ''}" onclick="filterCalCountry('all', this)">${t('cal_all') || 'همه'}</button>
                ${countries.map(c => {
                    const flag = filteredEvents.find(e => e.country === c)?.flag || '';
                    return `<button class="cal-country-btn${currentCalCountry === c ? ' active' : ''}" onclick="filterCalCountry('${escapeHtml(c)}', this)">${flag} ${escapeHtml(c)}</button>`;
                }).join('')}
            </div>`;
        }

        if (!filteredEvents.length) {
            container.innerHTML = navHtml + countryHtml + `<div class="empty-state">${t('cal_empty')}</div>`;
            return;
        }

        // Sort by time
        filteredEvents.sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));

        // Group by time period
        const groups = {};
        filteredEvents.forEach(e => {
            const d = new Date(e.timestamp);
            const hour = Number(d.toLocaleString('en-GB', { timeZone: tz, hour: 'numeric', hour12: false }));
            const group = getTimeGroup(hour);
            if (!groups[group]) groups[group] = [];
            groups[group].push(e);
        });

        const lang = currentLang || 'fa';
        const labels = timeGroupLabels[lang] || timeGroupLabels.fa;
        const impactIcons = { high: '🔴', medium: '🟡', low: '🟢' };
        const impactLabels = { high: t('cal_impact_high'), medium: t('cal_impact_med'), low: t('cal_impact_low') };
        const statusLabel = { past: t('cal_status_past'), live: t('cal_status_live'), upcoming: t('cal_status_upcoming') };

        let eventsHtml = '';
        const groupOrder = ['morning', 'afternoon', 'evening'];
        groupOrder.forEach(g => {
            if (!groups[g]) return;
            eventsHtml += `<div class="cal-time-group-label">${labels[g]}</div>`;
            groups[g].forEach(e => {
                const ft = formatCalendarTime(e.timestamp);
                const timeText = ft.time || '';
                const isMajor = isMajorEvent(e.title);
                const isPast = e.status === 'past';
                const isLive = e.status === 'live';

                // Surprise indicator
                let surpriseHtml = '';
                if (e.actual && e.forecast) {
                    const actualVal = parseFloat(e.actual);
                    const forecastVal = parseFloat(e.forecast);
                    if (!isNaN(actualVal) && !isNaN(forecastVal)) {
                        const diff = actualVal - forecastVal;
                        // Determine better/worse based on context
                        const isPositiveGood = !e.title?.toUpperCase().includes('UNEMPLOYMENT');
                        const isBetter = isPositiveGood ? diff > 0 : diff < 0;
                        const cls = Math.abs(diff) < 0.01 ? 'surprise-expected' : (isBetter ? 'surprise-better' : 'surprise-worse');
                        const icon = Math.abs(diff) < 0.01 ? '➖' : (isBetter ? '📈' : '📉');
                        surpriseHtml = `<span class="cal-event-surprise ${cls}">${icon}</span>`;
                    }
                }

                eventsHtml += `
                <div class="cal-event${isPast ? ' past' : ''}${isLive ? ' live' : ''}">
                    ${isMajor ? '<span class="cal-event-major">🔥 Major</span>' : ''}
                    <div class="cal-event-header">
                        <span class="cal-event-impact impact-${e.impact || 'medium'}">${impactIcons[e.impact] || '🟡'} ${impactLabels[e.impact] || impactLabels.medium}</span>
                        ${e.status ? `<span class="eco-status eco-status-${e.status}">${statusLabel[e.status] || e.status}</span>` : ''}
                    </div>
                    <div class="cal-event-title">${escapeHtml(e.title)}</div>
                    <div class="cal-event-country">${e.flag || ''} ${escapeHtml(e.country || '')}</div>
                    <div class="cal-event-details">
                        ${e.forecast ? `<span class="cal-event-stat"><strong>${t('cal_forecast') || 'پیش‌بینی'}:</strong> ${escapeHtml(e.forecast)}</span>` : ''}
                        ${e.previous ? `<span class="cal-event-stat"><strong>${t('cal_previous') || 'قبلی'}:</strong> ${escapeHtml(e.previous)}</span>` : ''}
                        ${e.actual ? `<span class="cal-event-stat"><strong>${t('cal_actual') || 'واقعی'}:</strong> <span class="cal-event-actual">${escapeHtml(e.actual)}</span> ${surpriseHtml}</span>` : ''}
                    </div>
                    <div class="cal-event-footer">
                        <span class="cal-event-time">${timeText}</span>
                        ${!isPast && !isLive ? `<span class="cal-event-countdown" data-ts="${e.timestamp}">--</span>` : ''}
                        <button class="cal-event-reminder" onclick="toggleCalReminder(this)">🔔</button>
                    </div>
                </div>`;
            });
        });

        container.innerHTML = navHtml + countryHtml + eventsHtml;

        // Start countdown for nearest upcoming event
        startCalCountdown();
    });
}

function startCalCountdown() {
    if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
    const updateCountdowns = () => {
        const now = Date.now();
        document.querySelectorAll('.cal-event-countdown[data-ts]').forEach(el => {
            const ts = parseInt(el.dataset.ts);
            const diff = new Date(ts).getTime() - now;
            if (diff <= 0) {
                el.textContent = '• Live';
                el.removeAttribute('data-ts');
            } else {
                el.textContent = formatCountdown(diff);
            }
        });
    };
    updateCountdowns();
    calCountdownInterval = setInterval(updateCountdowns, 1000);
}

function toggleCalReminder(btn) {
    btn.classList.toggle('active');
    btn.textContent = btn.classList.contains('active') ? '🔔' : '🔕';
}

function filterCalCountry(country, btn) {
    currentCalCountry = country;
    document.querySelectorAll('.cal-country-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderCalendar();
}

/**
 * نمایش یا وضعیت اخبار تب را تعویض می‌کند.
 * ورودی: پارامترهای `category, btn` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function switchNewsTab(category, btn) {
    document.querySelectorAll('.news-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (category === 'calendar') {
        currentCalendarTab = 'today';
        currentCalCountry = 'all';
    }
    renderNews(category);
}

function switchCalendarTab(tab, btn) {
    currentCalendarTab = tab;
    currentCalCountry = 'all';
    document.querySelectorAll('.cal-nav-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderCalendar();
}

/**
 * اخبار مودال را باز می‌کند.
 * ورودی: پارامترهای `idx` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openNewsModal(idx) {
    const n = displayedNews[idx];
    if (!n) return;
    const el = (id) => $(id);
    const titleEl = el('news-modal-title'); if (titleEl) titleEl.innerText = n.title;
    const imgEl = el('news-modal-image'); if (imgEl) { imgEl.src = n.image || getAmirbtcFallbackSvg(400, 250, 'AMIRBTC'); imgEl.onerror = function() { newsImageFallback(this); }; }
    const bodyEl = el('news-modal-body'); if (bodyEl) bodyEl.innerText = n.body || t('news_unavailable');
    const linkEl = el('news-modal-link'); if (linkEl) { linkEl.href = n.url || '#'; linkEl.innerText = t('view_source'); }
    const modalEl = el('news-modal'); if (modalEl) modalEl.style.display = 'flex';
}
/**
 * اخبار مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeNewsModal() {
    document.getElementById('news-modal').style.display = 'none';
}

//#endregion

// ============================================================================
//#region جزئیات کوین و هشدار قیمت
// ============================================================================
/**
 * ارز جزئیات را باز می‌کند.
 * ورودی: پارامترهای `symbol` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function openCoinDetail(symbol) {
    // Lazy-load TradingView widget on first use
    if (!window.TradingView) {
        const s = document.createElement('script');
        s.src = 'https://s3.tradingview.com/tv.js';
        document.head.appendChild(s);
        await new Promise((resolve, reject) => { s.onload = resolve; s.onerror = reject; });
    }

    const coin = allCoins.find(c => c.symbol === symbol);
    if (!coin) return;

    // Update header with icon, title, price, and change
    const icon = coin.image || `https://assets.coincap.io/assets/icons/${encodeURIComponent(coin.symbol).toLowerCase()}@2x.png`;
    const iconEl = document.getElementById('detail-coin-icon');
    if (iconEl) {
        iconEl.dataset.symbol = symbol;
        iconEl.src = icon;
        iconEl.onerror = function() { iconFallback(this); };
    }

    document.getElementById('detail-coin-title').innerText = currentLang === 'fa' && coin.name ? `${coin.name} (${symbol})` : `${symbol} / USDT`;
    _currentDetailSymbol = symbol;

    // Price + change in header
    const priceEl = document.getElementById('detail-coin-price');
    const changeEl = document.getElementById('detail-coin-change');
    if (priceEl) {
        priceEl.textContent = '$' + (coin.priceUsd > 1 ? coin.priceUsd.toFixed(2) : coin.priceUsd.toFixed(6));
    }
    if (changeEl) {
        const chg = coin.changePercent24Hr || 0;
        changeEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
        changeEl.className = 'detail-coin-change ' + (chg >= 0 ? 'up' : 'down');
    }

    // Current price in alert section
    const alertPriceVal = document.getElementById('alert-current-price-value');
    if (alertPriceVal) {
        alertPriceVal.textContent = '$' + (coin.priceUsd > 1 ? coin.priceUsd.toFixed(2) : coin.priceUsd.toFixed(6));
    }

    // Update watchlist button state
    updateDetailWatchBtn(symbol);

    const modal = document.getElementById('coin-detail-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.classList.remove('slide-down');
    modal.classList.add('slide-up');
    modal.addEventListener('animationend', function handler() {
        modal.classList.remove('slide-up');
        modal.removeEventListener('animationend', handler);
    });

    // Show alert section for crypto
    const alertSection = document.querySelector('.alert-section');
    if (alertSection) alertSection.style.display = '';

    const chartContainer = document.getElementById('detail-chart');
    document.querySelector('.chart-exchange-badge')?.remove();
    chartContainer.innerHTML = '<div class="chart-loading-state"><div class="chart-spinner"></div><span>در حال بارگذاری چارت...</span></div>';

    const chartInfo = await resolveChartSymbol(symbol);
    currentTvChartInfo = chartInfo;
    currentTvInterval = '60';
    updateTvTimeframeUI();
    createTradingViewWidget(chartInfo);

    // Extra info at bottom (compact: Volume, MCap, Rank, Supply)
    const rankVal = Number(coin.rank) || 0;
    const supplyStr = coin.supply ? formatLargeNumber(coin.supply) : '--';
    document.getElementById('detail-stats').innerHTML =
        `<span class="info-item"><span class="info-label">${t('volume_24h')}</span><span class="info-value">$${formatLargeNumber(coin.volumeUsd24Hr)}</span></span>` +
        `<span class="info-item"><span class="info-label">${t('mcap')}</span><span class="info-value">$${formatLargeNumber(coin.marketCapUsd)}</span></span>` +
        `<span class="info-item"><span class="info-label">${t('rank')}</span><span class="info-value">#${rankVal}</span></span>` +
        `<span class="info-item"><span class="info-label">${t('supply')}</span><span class="info-value">${supplyStr}</span></span>`;
    renderActiveAlerts(symbol);
}
/**
 * ویجت TradingView را با تنظیمات فعلی می‌سازد.
 * ورودی: پارامترهای `chartInfo` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function createTradingViewWidget(chartInfo) {
    const chartContainer = document.getElementById('detail-chart');
    if (!chartContainer) return;

    // Clean up previous widget completely
    if (currentTvWidget) {
        try { currentTvWidget.remove(); } catch {}
        currentTvWidget = null;
    }
    document.querySelector('.chart-exchange-badge')?.remove();
    // Remove all TradingView artifacts before creating new widget
    chartContainer.querySelectorAll('iframe').forEach(iframe => {
        iframe.src = 'about:blank';
        iframe.remove();
    });
    chartContainer.querySelectorAll('script').forEach(s => s.remove());
    chartContainer.innerHTML = '';

    if (typeof TradingView !== 'undefined' && chartInfo && chartInfo.found) {
        if (chartInfo.exchange) {
            const badge = document.createElement('div');
            badge.className = 'chart-exchange-badge';
            badge.innerText = chartInfo.exchange.toUpperCase();
            chartContainer.parentNode.insertBefore(badge, chartContainer);
        }
        currentTvWidget = new TradingView.widget({
            width: '100%',
            height: '100%',
            symbol: chartInfo.tv_symbol,
            interval: currentTvInterval,
            theme: 'dark',
            style: '1',
            locale: 'en',
            container_id: 'detail-chart',
            hide_side_toolbar: true,
            disabled_features: ['header_widget_dom_node'],
            // Enable auto-resize to prevent layout issues
            autosize: true,
        });
    } else {
        chartContainer.innerHTML = '<div class="empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" stroke-width="1.5"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 5 5-9"/></svg><br>' + t('chart_unavailable') + '</div>';
    }
}
/**
 * تایم‌فریم نمودار را تغییر می‌دهد.
 * ورودی: پارامترهای `interval, btn` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function switchTvTimeframe(interval, btn) {
    currentTvInterval = interval;
    localStorage.setItem('tv_interval', interval);
    updateTvTimeframeUI();
    createTradingViewWidget(currentTvChartInfo);
}
function updateTvTimeframeUI() {
    document.querySelectorAll('.tv-tf-btn').forEach(b => {
        b.classList.toggle('active', b.dataset.interval === currentTvInterval);
    });
}
/**
 * Update the watchlist button in the detail modal.
 */
function updateDetailWatchBtn(symbol) {
    const btn = $('detail-watch-btn');
    if (!btn) return;
    const inWatch = watchlist.includes(symbol);
    btn.classList.toggle('active', inWatch);
    const svg = btn.querySelector('svg');
    if (svg) svg.setAttribute('fill', inWatch ? 'currentColor' : 'none');
    btn.dataset.symbol = symbol;
}

/**
 * Toggle watchlist from the detail modal.
 */
function toggleWatchlistFromDetail() {
    const btn = document.getElementById('detail-watch-btn');
    if (!btn || !btn.dataset.symbol) return;
    const symbol = btn.dataset.symbol;
    toggleWatchlist(symbol, null);
    updateDetailWatchBtn(symbol);
}

/**
 * ارز جزئیات را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeCoinDetail() {
    document.querySelector('.chart-exchange-badge')?.remove();
    if (currentTvWidget) {
        try {
            // TradingView creates an iframe inside the container.
            // Remove the widget, then explicitly destroy any remaining iframes.
            currentTvWidget.remove();
        } catch {}
        currentTvWidget = null;
    }
    // Ensure ALL iframes and TradingView artifacts are removed
    const chartContainer = document.getElementById('detail-chart');
    if (chartContainer) {
        // Remove all iframes (TradingView may create multiple)
        chartContainer.querySelectorAll('iframe').forEach(iframe => {
            iframe.src = 'about:blank';
            iframe.remove();
        });
        // Remove any script elements injected by TradingView
        chartContainer.querySelectorAll('script').forEach(s => s.remove());
        chartContainer.innerHTML = '';
    }
    currentTvChartInfo = null;
    const modal = document.getElementById('coin-detail-modal');
    modal.classList.remove('slide-up');
    modal.classList.add('slide-down');
    modal.addEventListener('animationend', function handler() {
        modal.style.display = 'none';
        modal.classList.remove('slide-down');
        modal.removeEventListener('animationend', handler);
    });
}

/**
 * Open forex pair detail modal with TradingView chart.
 */
function openForexDetail(symbol) {
    const pair = allForexPairs.find(f => f.symbol === symbol);
    if (!pair) return;

    const modal = document.getElementById('coin-detail-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.classList.remove('slide-down');
    modal.classList.add('slide-up');
    modal.addEventListener('animationend', function handler() {
        modal.classList.remove('slide-up');
        modal.removeEventListener('animationend', handler);
    });

    document.getElementById('detail-coin-title').innerText = pair.name || symbol;
    _currentDetailSymbol = symbol;

    // Price in header for forex
    const priceEl = document.getElementById('detail-coin-price');
    const changeEl = document.getElementById('detail-coin-change');
    if (priceEl) priceEl.textContent = pair.price > 0 ? pair.price.toFixed(pair.category === 'metal' ? 2 : (pair.category === 'index' || pair.category === 'commodity' ? 0 : 4)) : '--';
    if (changeEl) { changeEl.textContent = ''; changeEl.className = 'detail-coin-change'; }

    const chartContainer = document.getElementById('detail-chart');
    chartContainer.innerHTML = '<div class="chart-loading-state"><div class="chart-spinner"></div></div>';

    // Build chart info — extract exchange from tvSymbol prefix
    const tvSym = pair.tvSymbol || `FX:${symbol}`;
    const exchangePart = tvSym.split(':')[0] || 'FX';
    const chartInfo = {
        found: true,
        tv_symbol: tvSym,
        exchange: exchangePart,
    };
    currentTvChartInfo = chartInfo;
    currentTvInterval = '60';
    updateTvTimeframeUI();

    // Reuse centralized widget creation (fixes B3: was duplicated inline)
    createTradingViewWidget(chartInfo);

    // Extra info
    const cat = pair.category || 'major';
    const catLabels = { major: 'Major', cross: 'Cross', metal: 'Metal', index: 'Index', commodity: 'Commodity' };
    const catLabelFa = { major: 'جفت اصلی', cross: 'کراس', metal: 'فلز گران‌بها', index: 'شاخص', commodity: 'کامودیتی' };
    const catLabel = currentLang === 'fa' ? (catLabelFa[cat] || cat) : (catLabels[cat] || cat);
    const typeLabel = currentLang === 'fa'
        ? ({ major: 'فارکس', cross: 'فارکس', metal: 'فلز', index: 'شاخص', commodity: 'کامودیتی' }[cat] || 'بازار')
        : ({ major: 'Forex', cross: 'Forex', metal: 'Commodity', index: 'Index', commodity: 'Commodity' }[cat] || 'Market');
    document.getElementById('detail-stats').innerHTML =
        `<span class="info-item"><span class="info-label">Category</span><span class="info-value">${catLabel}</span></span>` +
        `<span class="info-item"><span class="info-label">Symbol</span><span class="info-value">${escapeHtml(symbol)}</span></span>` +
        `<span class="info-item"><span class="info-label">Type</span><span class="info-value">${typeLabel}</span></span>`;

    // Hide alert section for forex
    const alertSection = document.querySelector('.alert-section');
    if (alertSection) alertSection.style.display = 'none';
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        if (document.getElementById('coin-detail-modal').style.display === 'flex') closeCoinDetail();
    }
});
function selectAlertDirection(dir, btn) {
    currentAlertDirection = dir;
    document.querySelectorAll('.alert-dir-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

/**
 * قدرت روند را بر اساس تغییر ۲۴ ساعته محاسبه و نمایش می‌دهد.
 */
function updateTrendStrength(symbol) {
    const fill = document.getElementById('trend-strength-fill');
    const label = document.getElementById('trend-strength-label');
    if (!fill || !label) return;
    const coin = allCoins.find(c => c.symbol === symbol);
    if (!coin) { fill.style.width = '50%'; fill.className = 'trend-strength-fill'; label.className = 'trend-strength-label'; label.textContent = '--'; return; }
    const chg = coin.changePercent24Hr || 0;
    let pct, labelKey, side;
    if (chg > 5)       { pct = 85 + (Math.min(chg, 20) - 5) / 15 * 15; labelKey = 'trend_strong_bullish'; side = 'bullish'; }
    else if (chg > 1)  { pct = 60 + (chg - 1) / 4 * 25; labelKey = 'trend_bullish'; side = 'bullish'; }
    else if (chg > 0)  { pct = 50 + chg * 10; labelKey = 'trend_slightly_bullish'; side = 'bullish'; }
    else if (chg > -1) { pct = 50 + chg * 10; labelKey = 'trend_slightly_bearish'; side = 'bearish'; }
    else if (chg > -5) { pct = 15 + (chg + 5) / 4 * 25; labelKey = 'trend_bearish'; side = 'bearish'; }
    else               { pct = Math.max(0, 15 + (Math.max(chg, -20) + 5) / 15 * 15); labelKey = 'trend_strong_bearish'; side = 'bearish'; }
    pct = Math.round(Math.max(0, Math.min(100, pct)));
    fill.style.width = pct + '%';
    fill.className = 'trend-strength-fill ' + side;
    label.className = 'trend-strength-label ' + side;
    label.textContent = t(labelKey);
}

function renderActiveAlerts(symbol) {
    const container = document.getElementById('active-alerts');
    if (!container || !symbol) return;
    const userAlerts = alerts.filter(a => a.symbol === symbol);
    if (!userAlerts.length) {
        container.innerHTML = `<div class="alert-empty">${t('alert_empty')}</div>`;
        return;
    }
    container.innerHTML = userAlerts.map(a => {
        const priceStr = a.price >= 1 ? Number(a.price).toFixed(2) : Number(a.price).toFixed(6);
        return `
        <div class="alert-item">
            <div class="alert-item-left">
                <div class="alert-item-status-dot"></div>
                <div class="alert-item-info">
                    <div class="alert-item-top">
                        <span class="alert-item-symbol">${escapeHtml(a.symbol)}</span>
                    </div>
                    <span class="alert-item-target">$${priceStr}</span>
                </div>
            </div>
            <button class="alert-remove-btn" data-id="${escapeHtml(a.id)}" onclick="removeAlert(this.dataset.id)">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
            </button>
        </div>
    `}).join('');
}
/**
 * هشدار صدا را پخش می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
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

/**
 * عملیات مربوط به syncAlertToServer را انجام می‌دهد.
 * ورودی: پارامترهای `alert` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function syncAlertToServer(alert) {
    if (!API_BASE || isGuestUserId(String(alert.userId)) || isPendingTelegramUserId(String(alert.userId)) || UserContext.isPending()) return alert;
    try {
        const data = await apiFetch('/api/alerts', {
            method: 'POST',
            body: JSON.stringify({
                user_id: alert.userId,
                symbol: alert.symbol,
                price: alert.price,
                direction: alert.direction || 'above'
            })
        });
        if (data.alert?.id) alert.serverId = data.alert.id;
    } catch (e) { console.warn('syncAlertToServer:', e); }
    return alert;
}

/**
 * هشدار from سرور را حذف می‌کند.
 * ورودی: پارامترهای `alert` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function removeAlertFromServer(alert) {
    if (!API_BASE || !alert.serverId || isGuestUserId(String(alert.userId)) || isPendingTelegramUserId(String(alert.userId)) || UserContext.isPending()) return;
    try {
        await apiFetch(`/api/alerts/${alert.serverId}`, { method: 'DELETE' });
    } catch (e) { console.warn('removeAlertFromServer:', e); }
}

/**
 * هشدارها from سرور را بارگذاری می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function loadAlertsFromServer() {
    const uid = getUserId();
    if (!API_BASE || isGuestUserId(uid) || isPendingTelegramUserId(uid)) return;
    try {
        const data = await apiFetch('/api/alerts');
        alerts = (data.alerts || []).map(a => ({
            id: a.id,
            serverId: a.id,
            symbol: a.symbol,
            price: a.price,
            direction: a.direction || 'above',
            userId: a.user_id,
            createdAt: a.created_at
        }));
        localStorage.setItem('price_alerts', JSON.stringify(alerts));
    } catch (e) { console.warn('loadAlertsFromServer:', e); }
}

/**
 * اعلان مربوط به تلگرام را ارسال می‌کند.
 * ورودی: پارامترهای `message` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function notifyTelegram(message) {
    const userId = getUserId();
    if (!API_BASE || isGuestUserId(String(userId)) || isPendingTelegramUserId(String(userId)) || UserContext.isPending()) return false;
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
/**
 * قیمت هشدار را تنظیم می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function setPriceAlert() {
    const input = document.getElementById('alert-price');
    if (!input) return;
    const price = parseFloat(input.value);
    const symbol = _currentDetailSymbol || document.getElementById('detail-coin-title').innerText.split(' ')[0];
    if (!price || price <= 0) { alert(t('invalid_price')); return; }
    const userId = getUserId();
    let newAlert = { id: Date.now().toString(), symbol, price, direction: 'cross', userId, createdAt: new Date().toISOString() };
    newAlert = await syncAlertToServer(newAlert);
    alerts.push(newAlert);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    input.value = '';
    renderActiveAlerts(symbol);
    const priceStr = price >= 1 ? price.toFixed(2) : price.toFixed(6);
    addNotification(t('price_alert'), `${symbol} → $${priceStr}`);
    getTg()?.showPopup?.({ title: t('alert_registered'), message: `${symbol} — $${priceStr}`, buttons: [{ type: 'ok' }] });
}
/**
 * هشدار را حذف می‌کند.
 * ورودی: پارامترهای `id` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function removeAlert(id) {
    const removed = alerts.find(a => a.id === id);
    if (removed) await removeAlertFromServer(removed);
    alerts = alerts.filter(a => a.id !== id);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    const symbol = _currentDetailSymbol || document.getElementById('detail-coin-title')?.innerText?.split(' ')[0];
    if (symbol) renderActiveAlerts(symbol);
}
/**
 * هشدار را فعال می‌کند.
 * ورودی: پارامترهای `alert, currentPrice` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function triggerAlert(alert, currentPrice) {
    await removeAlertFromServer(alert);
    alerts = alerts.filter(a => a.id !== alert.id);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    const priceStr = currentPrice >= 1 ? currentPrice.toFixed(2) : currentPrice.toFixed(6);
    const msg = currentLang === 'fa'
        ? `🔔 ${alert.symbol} — ${t('price_reached')} $${priceStr}`
        : `🔔 ${alert.symbol} Price reached $${priceStr}`;
    getTg()?.HapticFeedback?.notificationOccurred('warning');
    addNotification(t('price_alert'), msg.replace('🔔 ', ''), { sendToTelegram: true, playSound: true });
    getTg()?.showPopup?.({ title: t('price_alert'), message: msg, buttons: [{ type: 'ok' }] });
    const symbol = _currentDetailSymbol;
    if (symbol === alert.symbol) renderActiveAlerts(symbol);
}
/**
 * هشدارها را بررسی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function checkAlerts() {
    const userId = getUserId();

    // Retry loading alerts from server if user is now authenticated but alerts weren't loaded yet
    if (alerts.length === 0 && !isGuestUserId(userId) && !isPendingTelegramUserId(userId) && getTelegramUser()?.id) {
        await loadAlertsFromServer().catch(() => {});
    }

    const userAlerts = alerts.filter(a => a.userId === userId);
    if (!userAlerts.length) return;

    // R3-1: Use frontend allCoins directly — NO separate /api/market call.
    // Market data is refreshed every 120s by the main polling loop. Alerts just
    // consume whatever is in memory, eliminating ~20-25% of duplicate requests.
    if (!allCoins.length) return;
    const priceMap = {};
    allCoins.forEach(c => { priceMap[c.symbol] = c.priceUsd; });
    for (const alert of userAlerts) {
        const current = priceMap[alert.symbol];
        if (current == null) continue;

        const target = alert.price;
        const prev = _previousPrices[alert.symbol];

        // Skip if no previous price — prevents false trigger on first load or after refresh
        if (prev == null) continue;

        // Tolerance: 0.01% of target (min $0.00001) to avoid floating-point noise
        const tol = Math.max(Math.abs(target) * 0.0001, 0.00001);

        // Detect actual price crossing through the target level
        const crossedUp = prev < target && current >= (target - tol);
        const crossedDown = prev > target && current <= (target + tol);

        // Handle different alert directions for backward compatibility
        const dir = (alert.direction || 'cross').toLowerCase();
        let shouldTrigger = false;

        if (dir === 'above') {
            shouldTrigger = crossedUp;
        } else if (dir === 'below') {
            shouldTrigger = crossedDown;
        } else {
            // 'cross' or any new type: trigger on either direction
            shouldTrigger = crossedUp || crossedDown;
        }

        if (shouldTrigger) await triggerAlert(alert, current);
    }

    // Update previous prices AFTER checking all alerts (prevents same-cycle re-trigger)
    Object.assign(_previousPrices, priceMap);
}

//#endregion

// ============================================================================
//#region اعلانات
// ============================================================================
/**
 * عملیات مربوط به addNotification را انجام می‌دهد.
 * ورودی: پارامترهای `title, body, options = true` را دریافت می‌کند.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function addNotification(title, body, options = true) {
    const opts = typeof options === 'boolean'
        ? { sendToTelegram: options, playSound: true }
        : { sendToTelegram: true, playSound: true, ...options };

    if (window.NotificationCenter) {
        const notif = NotificationCenter.add(title, body, opts);
        if (notif) notifications = JSON.parse(localStorage.getItem('notifications') || '[]');
        return;
    }

    const notif = { id: Date.now().toString(), title, body, read: false, date: new Date().toISOString() };
    notifications.unshift(notif);
    if (notifications.length > 50) notifications = notifications.slice(0, 50);
    localStorage.setItem('notifications', JSON.stringify(notifications));
    updateNotifBadge();
    if (opts.sendToTelegram) {
        const userId = getUserId();
        if (!String(userId).startsWith('guest_')) {
            notifyTelegram(`🔔 ${title}\n${body}`).catch(e => console.warn('notifyTelegram:', e));
        }
    }
    if (opts.playSound) playAlertSound();
}
/**
 * اعلان نشان را به‌روزرسانی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function updateNotifBadge() {
    const unread = notifications.filter(n => !n.read).length;
    const badge = $('notif-badge');
    if (!badge) return;
    if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread; }
    else { badge.style.display = 'none'; }
}
/**
 * وضعیت اعلان پنل را بین دو حالت جابه‌جا می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function toggleNotificationPanel() {
    const modal = document.getElementById('notif-modal');
    modal.style.display = modal.style.display === 'flex' ? 'none' : 'flex';
    renderNotifications();
}
/**
 * اعلان مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeNotifModal() {
    document.getElementById('notif-modal').style.display = 'none';
}
/**
 * وضعیت همه read را علامت‌گذاری می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function markAllRead() {
    notifications.forEach(n => n.read = true);
    localStorage.setItem('notifications', JSON.stringify(notifications));
    updateNotifBadge();
    renderNotifications();
}
/**
 * همه notifications را پاک‌سازی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function clearAllNotifications() {
    if(confirm(t('confirm_clear_notif'))) {
        notifications = [];
        localStorage.setItem('notifications', JSON.stringify(notifications));
        updateNotifBadge();
        renderNotifications();
        closeNotifModal();
    }
}
/**
 * notifications را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function renderNotifications() {
    const container = document.getElementById('notif-list');
    if (!container) return;
    if (!notifications.length) {
        container.innerHTML = `<div class="empty-state">${t('no_notif')}</div>`;
        return;
    }
    container.innerHTML = notifications.slice(0, 20).map(n => `
        <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="markNotifRead('${escapeHtml(n.id)}')">
            <div class="notif-title">${escapeHtml(n.title)}</div>
            <div class="notif-body">${escapeHtml(n.body)}</div>
            <div class="notif-date">${new Date(n.date).toLocaleDateString('fa-IR')}</div>
        </div>
    `).join('');
}
/**
 * وضعیت اعلان read را علامت‌گذاری می‌کند.
 * ورودی: پارامترهای `id` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function markNotifRead(id) {
    const n = notifications.find(x => x.id === id);
    if (n) { n.read = true; localStorage.setItem('notifications', JSON.stringify(notifications)); updateNotifBadge(); renderNotifications(); }
}

//#endregion

// ============================================================================
//#region پروفایل و ارجاع
// ============================================================================
/**

/**
 * اطلاعات پروفایل کاربر را بر اساس وضعیت احراز هویت در رابط کاربری نمایش می‌دهد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function loadUser() {
    if (UserContext.loading || isUserLoading()) {
        const pn = $('profile-name'); if (pn) pn.innerText = t('loading_user');
        const pu = $('profile-username'); if (pu) pu.innerText = '...';
        const pi = $('profile-id-num'); if (pi) pi.innerText = '...';
        return;
    }

    const user = getTelegramUser();
    if (user) {
        const pn = $('profile-name'); if (pn) pn.innerText = `${user.first_name || ''} ${user.last_name || ''}`.trim() || t('guest');
        const pu = $('profile-username'); if (pu) pu.innerText = user.username ? `@${user.username}` : '@guest';
        const pi = $('profile-id-num'); if (pi) pi.innerText = user.id || '000000';
        if (user.photo_url) { const pa = $('profile-avatar'); if (pa) pa.src = user.photo_url; }
        const rl = $('ref-link'); if (rl) rl.value = `https://t.me/${BOT_USERNAME}?start=ref_${user.id}`;
        loadReferralStats();
        // Fix: reload wallet card now that the user is confirmed — resolves race condition
        // where loadProfileCard() ran earlier while UserContext was still pending
        window.WalletApp?.loadProfileCard();
    } else if (UserContext.isPending()) {
        const pn = $('profile-name'); if (pn) pn.innerText = t('loading_user');
        const pu = $('profile-username'); if (pu) pu.innerText = '...';
        const pi = $('profile-id-num'); if (pi) pi.innerText = '...';
        const rl = $('ref-link'); if (rl) rl.value = `https://t.me/${BOT_USERNAME}?start=ref_`;
    } else if (UserContext.isGuest()) {
        const pn = $('profile-name'); if (pn) pn.innerText = t('guest');
        const pu = $('profile-username'); if (pu) pu.innerText = '@guest';
        const pi = $('profile-id-num'); if (pi) pi.innerText = getUserId().replace('guest_', '') || '000000';
        // M-R5: guest users should not have a working referral link
        const rl = $('ref-link'); if (rl) rl.value = '';
        const refLinkInput = $('ref-link');
        if (refLinkInput) refLinkInput.placeholder = 'Login required';
    }

    const adminFab = document.getElementById('analysis-fab');
    if (adminFab) {
        // FAB shows only when on analysis page AND user is admin
        const onAnalysisTab = (document.getElementById('analysis-page')?.classList.contains('active')) === true;
        const show = isAdmin() && onAnalysisTab;
        adminFab.style.display = show ? '' : 'none';
    }
}

// Update analysis FAB visibility based on current tab + admin status.
// Called from switchTab() and updateProfileUI().
function updateAnalysisFabVisibility() {
    const fab = document.getElementById('analysis-fab');
    if (!fab) return;
    const onAnalysisTab = (document.getElementById('analysis-page')?.classList.contains('active')) === true;
    fab.style.display = (isAdmin() && onAnalysisTab) ? '' : 'none';
}

function updateAdminEntryButton() {
    const btn = document.getElementById('admin-entry-btn');
    if (!btn) return;
    btn.style.display = (isCurrentUserAdmin && bootstrapComplete) ? 'inline-flex' : 'none';
}
/**
 * ارجاع لینک را کپی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function copyRefLink() {
    const input = document.getElementById('ref-link');
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch(e) { document.execCommand('copy'); }
    getTg()?.showPopup?.({ title: t('copied'), message: t('copy_ref_msg'), buttons: [{type:'ok'}] });
}
/**
 * ارجاع لینک را به اشتراک می‌گذارد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function shareRefLink() {
    const link = document.getElementById('ref-link').value;
    const text = encodeURIComponent(t('share_ref_text'));
    getTg()?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
}

//#endregion

// ============================================================================
//#region تنظیمات و پشتیبانی
// ============================================================================
/**
 * تنظیمات مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openSettingsModal() {
    document.getElementById('settings-modal').style.display = 'flex';
    const adminItem = document.getElementById('admin-tickets-item');
    if (adminItem) adminItem.style.display = isAdmin() ? 'flex' : 'none';
}
/**
 * تنظیمات مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeSettingsModal() { document.getElementById('settings-modal').style.display = 'none'; }
/**
 * زبان مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openLangModal() {
    closeSettingsModal();
    updateLangChecks();
    document.getElementById('lang-modal').style.display = 'flex';
}
/**
 * زبان مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeLangModal() { document.getElementById('lang-modal').style.display = 'none'; openSettingsModal(); }
/**
 * تیکت‌ها مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openTicketsModal() {
    closeSettingsModal();
    document.getElementById('tickets-modal').style.display = 'flex';
    fetchTickets().then(renderTickets);
}
/**
 * تیکت‌ها مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeTicketsModal() { document.getElementById('tickets-modal').style.display = 'none'; }
/**
 * درباره مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openAboutModal() {
    closeSettingsModal();
    document.getElementById('about-modal').style.display = 'flex';
}
/**
 * درباره مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeAboutModal() { document.getElementById('about-modal').style.display = 'none'; }

// ============================================================================
//#region Notification Settings
// ============================================================================

const NS_DEFAULT_PREFS = { analysis: true, calendar: true, price_alert: true, market: false, news: false };

function getNotifPrefs() {
    try {
        const key = 'notif_prefs_' + getUserId();
        const stored = localStorage.getItem(key);
        if (stored) return { ...NS_DEFAULT_PREFS, ...JSON.parse(stored) };
    } catch (e) { /* ignore */ }
    return { ...NS_DEFAULT_PREFS };
}

function saveNotifPrefs(prefs) {
    try {
        const key = 'notif_prefs_' + getUserId();
        localStorage.setItem(key, JSON.stringify(prefs));
    } catch (e) { /* ignore */ }
}

function openNotifSettingsModal() {
    closeSettingsModal();
    const modal = document.getElementById('notif-settings-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    renderNotifSettings();
}

function closeNotifSettingsModal() {
    document.getElementById('notif-settings-modal').style.display = 'none';
    openSettingsModal();
}

function renderNotifSettings() {
    const prefs = getNotifPrefs();
    // Set toggle states
    document.querySelectorAll('.ns-toggle-switch input[data-pref]').forEach(input => {
        const key = input.getAttribute('data-pref');
        input.checked = !!prefs[key];
    });
    // Update status badge
    const anyEnabled = Object.values(prefs).some(v => v);
    const dot = document.getElementById('ns-status-dot');
    const text = document.getElementById('ns-status-text');
    if (dot) { dot.classList.toggle('inactive', !anyEnabled); }
    if (text) {
        text.textContent = anyEnabled ? t('ns_active') : t('ns_inactive');
        text.classList.toggle('inactive', !anyEnabled);
    }
}

function handleNotifPrefChange(input) {
    const key = input.getAttribute('data-pref');
    if (!key) return;
    const prefs = getNotifPrefs();
    prefs[key] = input.checked;
    saveNotifPrefs(prefs);
    renderNotifSettings();
}

function handleNotifSubscription() {
    const tg = getTg();
    if (tg?.openTelegramLink) {
        tg.openTelegramLink('https://t.me/Amir_BTC_AssistantBot');
    } else {
        window.open('https://t.me/Amir_BTC_AssistantBot', '_blank');
    }
}

// #endregion

/**
 * مدیر تیکت‌ها مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openAdminTicketsModal() {
    closeSettingsModal();
    document.getElementById('admin-tickets-modal').style.display = 'flex';
    fetchAdminTickets().then(renderAdminTickets);
}
/**
 * مدیر تیکت‌ها مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeAdminTicketsModal() { document.getElementById('admin-tickets-modal').style.display = 'none'; }

/**
 * تیکت‌ها را از منبع داده دریافت می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function fetchTickets() {
    if (!API_BASE) { tickets = []; return; }
    try {
        const data = await apiFetch('/api/tickets');
        tickets = data.tickets || [];
    } catch (e) {
        console.warn('fetchTickets:', e);
        tickets = [];
    }
}

/**
 * مدیر تیکت‌ها را از منبع داده دریافت می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function fetchAdminTickets() {
    if (!API_BASE || !isAdmin()) return;
    try {
        const data = await apiFetch('/api/tickets/all');
        tickets = data.tickets || [];
    } catch (e) { console.warn('fetchAdminTickets:', e); }
}

/**
 * تیکت date را قالب‌بندی می‌کند.
 * ورودی: پارامترهای `iso` را دریافت می‌کند.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function formatTicketDate(iso) {
    if (!iso) return '';
    try { return new Date(iso).toLocaleString(currentLang === 'fa' ? 'fa-IR' : 'en-US'); } catch { return iso; }
}

/**
 * تیکت رشته را در رابط کاربری رندر می‌کند.
 * ورودی: پارامترهای `replies` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function renderTicketThread(replies) {
    if (!replies?.length) return '';
    return `<div class="ticket-thread">${replies.map(r => `
        <div class="ticket-reply ${r.from === 'admin' ? 'admin' : ''}">
            ${r.message}
            <div class="ticket-reply-meta">${r.from === 'admin' ? t('ticket_admin') : t('ticket_you')} • ${formatTicketDate(r.at)}</div>
        </div>
    `).join('')}</div>`;
}

/**
 * تیکت‌ها را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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

/**
 * مدیر تیکت‌ها را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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



/**
 * فرم یا داده تیکت را ارسال می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
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
        getTg()?.showPopup?.({ title: t('ticket_sent'), message: title, buttons: [{ type: 'ok' }] });
    } catch (e) {
        alert(t('ticket_error'));
        console.error('submitTicket:', e);
    } finally {
        if (btn) { btn.disabled = false; btn.innerText = t('ticket_send'); }
    }
}

/**
 * پاسخ مربوط به to تیکت را ارسال می‌کند.
 * ورودی: پارامترهای `ticketId` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
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

/**
 * تیکت را حذف می‌کند.
 * ورودی: پارامترهای `ticketId, isAdminView = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function deleteTicket(ticketId, isAdminView = false) {
    if (!confirm(t('ticket_delete') + '?')) return;
    try {
        if (API_BASE) {
            await apiFetch(`/api/tickets/${ticketId}`, { method: 'DELETE' });
        } else {
            const local = JSON.parse(localStorage.getItem('tickets') || '[]').filter(t => t.id !== ticketId);
            localStorage.setItem('tickets', JSON.stringify(local));
        }
        if (isAdminView) { await fetchAdminTickets(); renderAdminTickets(); }
        else { await fetchTickets(); renderTickets(); }
    } catch (e) { console.error(e); }
}
//#endregion



// ============================================================================
//#region نویگیشن و محتوای داشبورد
// ============================================================================
/**
 * نمایش یا وضعیت تب را تعویض می‌کند.
 * ورودی: پارامترهای `pageId, btn` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function switchTab(pageId, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (btn) btn.classList.add('active');

    // Hide analysis empty state on every tab switch; analysis-page branch re-shows it.
    const _aes = document.getElementById('analysis-empty-state');
    if (_aes) _aes.style.display = 'none';
    // FAB visibility is managed by updateAnalysisFabVisibility() — only hide when
    // leaving the analysis page. This prevents the "FAB disappears" bug.
    if (pageId !== 'analysis-page') {
        const _fab = document.getElementById('analysis-fab');
        if (_fab) _fab.style.display = 'none';
    }

    if (pageId === 'dashboard-page') {
        if (!tabLoaded.dashboard) {
            // Data is still loading from startup — just render what we have
            renderWatchlist();
            renderAnalysisSlider();
            loadImportantNews();
        } else {
            renderWatchlist();
            renderAnalysisSlider();
        }
    } else if (pageId === 'market-page') {
        if (!tabLoaded.market) {
            loadMarketData();
            tabLoaded.market = true;
        } else {
            renderMarket();
        }
    } else if (pageId === 'analysis-page') {
        if (!tabLoaded.analysis) {
            fetchAnalyses(true).then(() => {
                renderAnalysisFeatured();
                renderAnalysisStats();
                renderAnalysisList();
                // Re-assert admin UI after data load — prevents admin buttons disappearing
                updateAnalysisFabVisibility();
                updateAdminEntryButton();
            }).catch(() => {
                // Even on failure, re-assert admin UI with cached data
                renderAnalysisList();
                updateAnalysisFabVisibility();
                updateAdminEntryButton();
            });
            tabLoaded.analysis = true;
        } else {
            renderAnalysisFeatured();
            renderAnalysisStats();
            renderAnalysisList();
        }
        // Always re-assert admin UI on tab switch (idempotent, cheap)
        updateAnalysisFabVisibility();
        updateAdminEntryButton();
    } else if (pageId === 'news-page') {
        // Leaving analysis page — hide FAB and empty state
        const fab = document.getElementById('analysis-fab');
        if (fab) fab.style.display = 'none';
        const aes = document.getElementById('analysis-empty-state');
        if (aes) aes.style.display = 'none';
        if (!tabLoaded.news) {
            loadNews();
            tabLoaded.news = true;
        }
    } else if (pageId === 'profile-page') {
        // R3-5: Profile tab guard — API calls only on first visit.
        // Subsequent visits use local data already rendered.
        if (!tabLoaded.profile) {
            loadUser(); // loadUser internally calls loadReferralStats + WalletApp.loadProfileCard
            fetchOnlineCount();
            tabLoaded.profile = true;
        }
    }
}

/**
 * خلاصه اخبار مهم را برای داشبورد بارگذاری و رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
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
        // Store in a separate array for dashboard to avoid race with News page's displayedNews
        _dashboardDisplayedNews = important;
        container.innerHTML = important.map((n, i) => `
            <div class="important-news-item" style="animation-delay:${i * 0.06}s" onclick="openDashboardNewsModal(${i})">
                <img src="${n.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E'}" class="important-news-img" onerror="newsImageFallback(this)">
                <div class="important-news-content">
                    <div class="important-news-title">${escapeHtml(n.title)}</div>
                    <div class="important-news-source">${escapeHtml(n.source)}</div>
                </div>
            </div>
        `).join('');
    } catch (e) {}
}

// Separate news array for dashboard — isolated from News page's displayedNews
let _dashboardDisplayedNews = [];

function openDashboardNewsModal(idx) {
    const n = _dashboardDisplayedNews[idx];
    if (!n) return;
    openNewsModalWith(n);
}

function openNewsModalWith(n) {
    const el = (id) => $(id);
    const titleEl = el('news-modal-title'); if (titleEl) titleEl.innerText = n.title;
    const imgEl = el('news-modal-image'); if (imgEl) { imgEl.src = n.image || getAmirbtcFallbackSvg(400, 250, 'AMIRBTC'); imgEl.onerror = function() { newsImageFallback(this); }; }
    const bodyEl = el('news-modal-body'); if (bodyEl) bodyEl.innerText = n.body || n.summary || t('news_unavailable');
    const linkEl = el('news-modal-link'); if (linkEl) { linkEl.href = n.url || '#'; linkEl.innerText = t('view_source'); }
    const modalEl = el('news-modal'); if (modalEl) modalEl.style.display = 'flex';
}

//#endregion

// ============================================================================
//#region پولینگ و بروزرسانی‌های دوره‌ای
// ============================================================================
/**
 * پولینگ‌های دوره‌ای برنامه را برای بازار، تحلیل، اخبار و وضعیت کاربر فعال می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
// R3-4: App visibility tracking — all polling pauses when tab is hidden
const _pollingIntervals = [];

function _stopAllPolling() {
    _pollingIntervals.forEach(id => clearInterval(id));
    _pollingIntervals.length = 0;
}

function _startAllPolling() {
    if (_pollingIntervals.length) return; // already running

    // Main data polling (market + analyses + news) — 120s, aligned with backend cache TTL
    _pollingIntervals.push(setInterval(() => {
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'market-page' || activePage === 'dashboard-page') {
            loadMarketData();
        }
        if (activePage === 'analysis-page' || activePage === 'dashboard-page') {
            fetchAnalyses().then(changed => {
                if (changed) {
                    renderAnalysisSlider();
                    if (activePage === 'analysis-page') renderAnalysisList();
                }
            });
        }
        if (activePage === 'news-page') {
            loadNews();
            // Calendar auto-refresh (§7#7): refresh every 30s when on news page
            const activeTab = document.querySelector('.news-tab.active')?.dataset?.news;
            if (activeTab === 'calendar') {
                calendarEvents = [];
                loadCalendarEvents(true).then(events => renderNews('calendar'));
            } else {
                loadCalendarEvents(true);
            }
        }
    }, 120000));

    // R3-1: Alert checking — 15s interval, uses allCoins from memory (no /api/market call)
    _pollingIntervals.push(setInterval(checkAlerts, 15000));

    // R3-2: Session heartbeat — 120s (was 45s), skips if app not visible
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return;
        sendSessionHeartbeat();
    }, 120000));

    // R3-3: Online count — 300s (was 60s), only polls when Profile tab is active
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return;
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'profile-page') {
            fetchOnlineCount();
        }
    }, 300000));
}

document.addEventListener('visibilitychange', () => {
    _appVisible = !document.hidden;
    if (document.hidden) {
        _stopAllPolling();
        // NOTE: Do NOT clear _bootstrapLongTimer here — it must survive background cycles
    } else {
        _startAllPolling();
        // Retry bootstrap if app returned to foreground and bootstrap hasn't completed
        _notifyAuthStateChange();
        if (!bootstrapComplete) {
            // Ensure long-term retry is running
            if (!_bootstrapLongTimer) {
                _bootstrapLongTimer = setInterval(() => {
                    if (bootstrapComplete) { clearInterval(_bootstrapLongTimer); _bootstrapLongTimer = null; return; }
                    _notifyAuthStateChange();
                    if (isTelegramAuthReady()) tryLateBootstrap();
                }, 15000);
            }
            // Also try immediately if auth is ready
            if (isTelegramAuthReady()) {
                tryLateBootstrap();
            }
        }
    }
});

// Clean up all timers on page unload (refresh / close)
window.addEventListener('beforeunload', () => {
    _stopAllPolling();
    if (_bootstrapLongTimer) { clearInterval(_bootstrapLongTimer); _bootstrapLongTimer = null; }
});

function startPolling() {
    _startAllPolling();
}

//#endregion

// ============================================================================
//#region راه‌اندازی برنامه
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    // ── Phase 0: Telegram SDK init + user resolution ──
    await UserContext.init();

    // ── Phase 1: Apply language + render UI from cache immediately ──
    applyLanguage();
    loadUser();
    updateNotifBadge();
    alerts = alerts.map(a => ({ ...a, userId: a.userId || getUserId() }));
    localStorage.setItem('price_alerts', JSON.stringify(alerts));

    // Analysis slider from localStorage cache
    if (analyses.length) {
        renderAnalysisSlider();
    } else {
        const st = $('slider-track');
        if (st) st.innerHTML = '<div class="slider-skeleton"><div class="slider-skeleton-img"></div><div class="slider-skeleton-text"><div class="slider-skeleton-line"></div><div class="slider-skeleton-line"></div><div class="slider-skeleton-line"></div></div></div>';
    }

    // Phase C: Load cached market data for instant watchlist render
    const MARKET_CACHE_VERSION = 3;
    try {
        const cachedVersion = parseInt(localStorage.getItem('market_cache_version') || '0', 10);
        const cachedMarket = JSON.parse(localStorage.getItem('market_data_cache') || '[]');
        if (Array.isArray(cachedMarket) && cachedMarket.length && cachedVersion >= MARKET_CACHE_VERSION) {
            allCoins = cachedMarket;
        } else if (cachedVersion < MARKET_CACHE_VERSION) {
            localStorage.removeItem('market_data_cache');
        }
    } catch(_) {}

    // Skeletons for watchlist and news
    const watchGrid = $('watchlist-grid');
    if (watchGrid && !watchGrid.children.length) {
        watchGrid.innerHTML = '<div class="watchlist-skeleton">' + Array(4).fill('<div class="watchlist-skeleton-item"><div class="watchlist-skeleton-icon"></div><div class="watchlist-skeleton-lines"><div class="watchlist-skeleton-line"></div><div class="watchlist-skeleton-line"></div></div></div>').join('') + '</div>';
    }
    const newsContainer = $('important-news');
    if (newsContainer && !newsContainer.children.length) {
        newsContainer.innerHTML = '<div class="important-news-skeleton">' + Array(3).fill('<div class="important-news-skeleton-item"><div class="important-news-skeleton-img"></div><div class="important-news-skeleton-text"><div class="important-news-skeleton-line"></div><div class="important-news-skeleton-line"></div></div></div>').join('') + '</div>';
    }

    // tabLoaded.dashboard is set AFTER initial data loads succeed.
    // This ensures revisiting the dashboard retries if initial loads failed.
    const _dashboardReady = { market: false, analyses: false, news: false };
    function _checkDashboardReady() {
        if (_dashboardReady.market && _dashboardReady.analyses && _dashboardReady.news) {
            tabLoaded.dashboard = true;
        }
    }

    // ── Phase 2: Bootstrap (authenticated data load) ──
    // Public data (market, analyses, news) loads immediately.
    // Authenticated data (alerts, bootstrap, admin) waits for auth.
    loadMarketData(true).finally(() => { _dashboardReady.market = true; _checkDashboardReady(); });
    fetchAnalyses().then(changed => {
        if (changed) {
            renderAnalysisSlider();
            renderAnalysisFeatured();
            renderAnalysisStats();
        }
        // Check for deep link after first load
        checkAnalysisDeepLink();
    }).finally(() => { _dashboardReady.analyses = true; _checkDashboardReady(); });
    setTimeout(() => {
        loadImportantNews().finally(() => { _dashboardReady.news = true; _checkDashboardReady(); });
    }, 2000);

    // Authenticated bootstrap — runs once user is available
    await bootstrapUser();
    loadUser();

    // If user is pending (in Telegram but no initData yet), set up a robust
    // retry mechanism: polling + hashchange + MutationObserver.
    // This ensures bootstrap completes even on cold-open where initData arrives late.
    if (!bootstrapComplete && (UserContext.isPending() || (isInTelegram() && !isTelegramAuthReady()))) {
        // Method 1: Polling retry — most reliable for cold-open scenarios
        // NOTE: Not pushed to _pollingIntervals — must survive visibility changes.
        const _bootPollMax = 20000;
        const _bootPollStart = Date.now();
        const _bootPollInterval = setInterval(() => {
            if (bootstrapComplete || Date.now() - _bootPollStart > _bootPollMax) {
                clearInterval(_bootPollInterval);
                return;
            }
            _notifyAuthStateChange();
            if (isTelegramAuthReady()) {
                clearInterval(_bootPollInterval);
                tryLateBootstrap();
            }
        }, 500);

        // Method 2: MutationObserver — fires when profile-name DOM updates
        const _bootObserver = new MutationObserver(() => {
            _notifyAuthStateChange();
            if (isTelegramAuthReady() && !bootstrapComplete) {
                _bootObserver.disconnect();
                clearInterval(_bootPollInterval);
                tryLateBootstrap();
            }
        });
        const pn = $('profile-name');
        if (pn) _bootObserver.observe(pn, { childList: true });
        setTimeout(() => { _bootObserver.disconnect(); clearInterval(_bootPollInterval); }, 30000);
    }

    // ── Phase 3: Authenticated data loads ──
    // Alerts load on first successful heartbeat (after bootstrap) — no race, no polling
    if (bootstrapComplete) {
        loadAlertsFromServer().then(() => checkAlerts());
    }

    startPolling();

    // Admin panel — initAdminPanel just sets a flag; admin entry button
    // visibility is managed by updateAdminEntryButton() called from bootstrapUser().
    if (typeof initAdminPanel === 'function' && !_adminPanelInitialized) {
        initAdminPanel();
    }

    // ── Bootstrap long-term resilience ──
    // CRITICAL: NOT pushed to _pollingIntervals — must survive visibility changes.
    _bootstrapLongTimer = setInterval(() => {
        if (bootstrapComplete) {
            clearInterval(_bootstrapLongTimer);
            _bootstrapLongTimer = null;
            return;
        }
        _notifyAuthStateChange();
        if (isTelegramAuthReady()) {
            tryLateBootstrap();
        }
    }, 15000);

    // Ticket polling (only when modals are open)
    _pollingIntervals.push(setInterval(() => {
        if (document.getElementById('tickets-modal')?.style.display === 'flex') fetchTickets().then(renderTickets);
        if (document.getElementById('admin-tickets-modal')?.style.display === 'flex') fetchAdminTickets().then(renderAdminTickets);
    }, 15000));

    // Scroll-to-top button
    const scrollTopBtn = $('scroll-top-btn');
    if (scrollTopBtn) {
        let scrollTicking = false;
        window.addEventListener('scroll', () => {
            if (!scrollTicking) {
                requestAnimationFrame(() => {
                    scrollTopBtn.classList.toggle('visible', window.scrollY > 400);
                    scrollTicking = false;
                });
                scrollTicking = true;
            }
        }, { passive: true });
    }

    // Hero Banner Slider
    (function initHeroSlider() {
        const slides = document.querySelectorAll('.hero-slide');
        const dots = document.querySelectorAll('.hero-dot');
        if (slides.length < 2) return;
        let current = 0;
        function goTo(idx) {
            slides.forEach(s => s.classList.remove('active'));
            dots.forEach(d => d.classList.remove('active'));
            current = ((idx % slides.length) + slides.length) % slides.length;
            slides[current].classList.add('active');
            dots[current].classList.add('active');
        }
        dots.forEach(d => d.addEventListener('click', () => goTo(Number(d.dataset.dot) + 1)));
        _pollingIntervals.push(setInterval(() => goTo(current + 1), 3000));
    })();
});

//#endregion

// ============================================================================
//#region ثبت توابع در فضای global
// ============================================================================
// ثبت توابع در فضای global
window.switchTab = switchTab;
window.switchMainTab = switchMainTab;
window.switchSubTab = switchSubTab;
window.switchNewsTab = switchNewsTab;
window.switchCalendarTab = switchCalendarTab;
window.toggleWatchlist = toggleWatchlist;
window.showMiniToast = showMiniToast;
window.updateDetailWatchBtn = updateDetailWatchBtn;
window.toggleWatchlistFromDetail = toggleWatchlistFromDetail;
window.refreshMarketData = refreshMarketData;
window.openAddCoinModal = openAddCoinModal;
window.closeAddCoinModal = closeAddCoinModal;
window.filterCoinList = filterCoinList;
window.filterAddCoinModal = filterCoinList;
window.openAddAnalysisModal = openAddAnalysisModal;
window.openEditAnalysisModal = openEditAnalysisModal;
window.closeAddAnalysisModal = closeAddAnalysisModal;
window.submitAnalysis = submitAnalysis;
window.openAnalysisDetailPage = openAnalysisDetailPage;
window.closeAnalysisDetailPage = closeAnalysisDetailPage;
window.startDeleteAnalysis = startDeleteAnalysis;
window.resetAnalysisFilters = resetAnalysisFilters;
window.initAnalysisToolbar = initAnalysisToolbar;
window.toggleAnalysisBookmark = toggleAnalysisBookmark;
window.copyAnalysisContent = copyAnalysisContent;
window.openDashboardNewsModal = openDashboardNewsModal;
window.openNewsModalWith = openNewsModalWith;
window.openCoinDetail = openCoinDetail;
window.closeCoinDetail = closeCoinDetail;
window.setPriceAlert = setPriceAlert;
window.selectAlertDirection = selectAlertDirection;
window.removeAlert = removeAlert;
window.updateTrendStrength = updateTrendStrength;
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
window.openNotifSettingsModal = openNotifSettingsModal;
window.closeNotifSettingsModal = closeNotifSettingsModal;
window.handleNotifPrefChange = handleNotifPrefChange;
window.handleNotifSubscription = handleNotifSubscription;
window.openAdminTicketsModal = openAdminTicketsModal;
window.closeAdminTicketsModal = closeAdminTicketsModal;
window.replyToTicket = replyToTicket;
window.deleteTicket = deleteTicket;
window.submitTicket = submitTicket;
window.openNewsModal = openNewsModal;
window.closeNewsModal = closeNewsModal;
window.getUserId = getUserId;
window.isInTelegram = isInTelegram;
window.isGuestUserId = isGuestUserId;
window.apiFetch = apiFetch;
window.getTelegramInitData = getTelegramInitData;
window.getTg = getTg;
window.getTelegramUser = getTelegramUser;
window.UserContext = UserContext;
Object.defineProperty(window, 'BOT_USERNAME', { get: () => BOT_USERNAME });

// [TEMP-DIAG] Capture real initData and send to diagnostic endpoint
// Usage: window.diagInitData() — returns full diagnostic breakdown
window.diagInitData = async function() {
    const initData = getTelegramInitData();
    if (!initData) {
        console.log('[DIAG] No initData available');
        return 'No initData';
    }
    console.log('[DIAG] initData length:', initData.length);
    console.log('[DIAG] initData first 80:', initData.substring(0, 80));
    console.log('[DIAG] initData last 40:', initData.substring(initData.length - 40));
    try {
        const r = await fetch(`${API_BASE}/api/_diag/init-data`, {
            method: 'POST',
            headers: { 'X-Telegram-Init-Data': initData }
        });
        const data = await r.json();
        console.log('[DIAG] Full diagnostic result:', data);
        console.log('[DIAG] Conclusion:', data.conclusion);
        return data;
    } catch (e) {
        console.error('[DIAG] Error:', e.message);
        return e.message;
    }
};

// ============================================================================
//#region Join Lock Screen
// ============================================================================

let _joinLockShown = false;

function showJoinLock() {
    if (_joinLockShown) return;
    _joinLockShown = true;
    const overlay = document.getElementById('join-lock-overlay');
    if (overlay) {
        overlay.style.display = 'flex';
        applyLanguage();
    }
    document.getElementById('join-lock-verify-btn')?.addEventListener('click', recheckJoinMembership);
    document.getElementById('join-lock-bot-btn')?.addEventListener('click', () => {
        const tg = getTg();
        if (tg?.close) { tg.close(); }
        else { window.location.href = 'https://t.me/Amir_BTC_AssistantBot'; }
    });
}

function hideJoinLock() {
    if (!_joinLockShown) return;
    _joinLockShown = false;
    const overlay = document.getElementById('join-lock-overlay');
    if (overlay) overlay.style.display = 'none';
}

async function recheckJoinMembership() {
    const btn = document.getElementById('join-lock-verify-btn');
    const errEl = document.getElementById('join-lock-error');
    if (btn) { btn.disabled = true; btn.textContent = '...'; }
    if (errEl) errEl.style.display = 'none';
    try {
        const data = await apiFetch('/api/users/check-join', { method: 'POST' });
        if (data.channel_joined === true) {
            hideJoinLock();
            refreshUI();
            getTg()?.showPopup?.({ title: '✅', message: currentLang === 'fa' ? 'عضویت تأیید شد!' : 'Membership verified!', buttons: [{ type: 'ok' }] });
        } else {
            if (errEl) { errEl.textContent = currentLang === 'fa' ? 'هنوز عضو کانال نشده‌اید.' : 'Not a channel member yet.'; errEl.style.display = 'block'; }
        }
    } catch (e) {
        if (errEl) { errEl.textContent = currentLang === 'fa' ? 'خطا در بررسی. دوباره تلاش کنید.' : 'Error checking. Try again.'; errEl.style.display = 'block'; }
    }
    if (btn) { btn.disabled = false; applyLanguage(); }
}

window.showJoinLock = showJoinLock;
window.hideJoinLock = hideJoinLock;
window.recheckJoinMembership = recheckJoinMembership;

//#endregion

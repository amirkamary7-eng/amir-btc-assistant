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
let bootstrapComplete = false;
let _coldOpenReloadTimer = null;

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
    if (hasTelegramAuthPayload() && getTelegramUser()?.id) return true;
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
    if (isInTelegram() && (!hasTelegramAuthPayload() || !getTelegramUser()?.id)) return false;
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
    // If UserContext.init() already completed (success or timeout),
    // do NOT re-wait — this prevents cascading 16s+ waits on every apiFetch call.
    // Auth-gated endpoints will reject gracefully via their own try/catch.
    if (UserContext.ready) return;
    const ready = await ensureTelegramAuthReady(maxWaitMs);
    if (!ready) {
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
                    console.log('[BOOT] viewportChanged: user arrived, cancelling reload if pending');
                    if (_coldOpenReloadTimer) { clearTimeout(_coldOpenReloadTimer); _coldOpenReloadTimer = null; }
                    UserContext.user = u;
                    UserContext.loading = false;
                    UserContext._setLoadingUI(false);
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
            UserContext.loading = false;
            return user;
        }
        if (!getTg() && !getTelegramInitData()) break;
        await new Promise(r => setTimeout(r, 50));
    }
    telegramInitDone = true;
    UserContext.loading = false;
    UserContext.user = getTelegramUser();

    // Cold-open fix: if no user and hash is empty, the Telegram Client
    // likely opened the WebView before computing initData. Reload once
    // so the second load picks up the cached initData in the URL hash.
    // The SDK reads location.hash once at init — a reload re-runs that.
    const _RELOADED = '__tg_init_reloaded';
    if (!UserContext.user?.id && isInTelegram() && !sessionStorage.getItem(_RELOADED)) {
        sessionStorage.setItem(_RELOADED, '1');
        console.warn('[BOOT] Cold-open: no user after polling. Reload in 3s unless user arrives.');
        _coldOpenReloadTimer = setTimeout(() => {
            _coldOpenReloadTimer = null;
            console.warn('[BOOT] Cold-open reload triggered — initData never arrived');
            location.reload();
        }, 3000);
    } else if (!UserContext.user?.id && isInTelegram()) {
        sessionStorage.removeItem(_RELOADED);
    }

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
                console.log('[BOOT] hashchange: user arrived, cancelling reload if pending');
                if (_coldOpenReloadTimer) { clearTimeout(_coldOpenReloadTimer); _coldOpenReloadTimer = null; }
                UserContext.user = user;
                UserContext.loading = false;
                UserContext._setLoadingUI(false);
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

const ADMIN_ID = '831704732';
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
        cal_today: 'امروز', cal_tomorrow: 'فردا', cal_day_after: 'پس‌فردا', cal_past: 'گذشته',
        cal_impact_high: 'بالا', cal_impact_med: 'متوسط', cal_impact_low: 'کم',
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
        cal_today: 'Today', cal_tomorrow: 'Tomorrow', cal_day_after: 'Day After', cal_past: 'Past',
        cal_impact_high: 'High', cal_impact_med: 'Medium', cal_impact_low: 'Low',
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
            console.log('[BOOT] getReferrerId from initDataUnsafe:', id);
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
                    console.log('[BOOT] getReferrerId from raw initData:', id);
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
                    console.log('[BOOT] getReferrerId from URL param', key + ':', id);
                    return id;
                }
            }
        }
    } catch (e) {
        console.warn('[BOOT] getReferrerId URL search parse error:', e);
    }
    console.log('[BOOT] getReferrerId: no valid referrer found');
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
        this.ready = true;
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
        console.log('[BOOT] bootstrapUser skipped: no API_BASE');
        applyLanguage();
        return;
    }
    if (UserContext.isGuest()) {
        console.log('[BOOT] bootstrapUser skipped: guest user');
        applyLanguage();
        return;
    }
    if (UserContext.isPending()) {
        console.log('[BOOT] bootstrapUser skipped: user isPending (no Telegram ID yet)');
        applyLanguage();
        return;
    }

    try {
        const u = getTelegramUser();
        const referrerId = getReferrerId();
        console.log('[BOOT] bootstrapUser START — user_id:', u?.id, 'referrer:', referrerId, 'initData length:', getTelegramInitData().length);

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
        console.log('[BOOT] bootstrapUser SUCCESS — watchlist:', JSON.stringify(data.watchlist), 'user:', JSON.stringify(data.user));
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

        // ── Membership lock gate ──
        if (data.channel_joined === false) {
            showJoinLock();
        } else {
            hideJoinLock();
        }

        // Only mark complete if the API call actually succeeded
        bootstrapComplete = true;
    } catch (e) {
        console.error('[BOOT] bootstrapUser FAILED:', e);
        // Do NOT set bootstrapComplete — let retry try again
        applyLanguage();
    }
    console.log('[BOOT] bootstrapUser DONE — bootstrapComplete:', bootstrapComplete);
}

/**
 * Retry bootstrap when Telegram user becomes available after cold open.
 * Guards: only runs once (bootstrapComplete), only when user is authenticated.
 */
async function tryLateBootstrap() {
    if (bootstrapComplete) {
        return;
    }
    const user = getTelegramUser();
    if (!user?.id) {
        console.log('[BOOT] tryLateBootstrap: no user yet, skipping');
        return;
    }
    if (!API_BASE || UserContext.isGuest() || UserContext.isPending()) {
        console.log('[BOOT] tryLateBootstrap: blocked — API_BASE:', !!API_BASE, 'isGuest:', UserContext.isGuest(), 'isPending:', UserContext.isPending());
        return;
    }
    // Cancel any pending cold-open reload — we have the user now
    if (_coldOpenReloadTimer) {
        clearTimeout(_coldOpenReloadTimer);
        _coldOpenReloadTimer = null;
        console.log('[BOOT] tryLateBootstrap: cancelled cold-open reload');
    }
    console.log('[BOOT] tryLateBootstrap: running bootstrap for user', user.id);
    // Do NOT set bootstrapComplete here — let bootstrapUser set it on success only
    try {
        await bootstrapUser();
        loadUser();
        // R4-fix: Re-check admin status now that we have a valid user with initData
        if (bootstrapComplete && typeof initAdminPanel === 'function') {
            initAdminPanel();
        }
    } catch (e) {
        console.error('[BOOT] tryLateBootstrap FAILED:', e);
    }
}

/**
 * تحلیل‌ها را از منبع داده دریافت می‌کند.
 * ورودی: پارامترهای `force = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function fetchAnalyses(force = false) {
    if (!API_BASE) {
        analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
        return false;
    }
    try {
        const versionParam = force ? '' : (analysisVersion !== null ? `?version=${analysisVersion}` : '');
        const data = await apiFetch(`/api/analyses${versionParam}`);
        if (data.unchanged) return false;
        if (Array.isArray(data.analyses)) {
            // Preserve existing analyses if API returns empty but we had valid data
            // (e.g. DB cold start, temporary unavailability that didn't throw)
            if (data.analyses.length === 0 && analyses.length > 0) {
                console.warn('fetchAnalyses: API returned empty but we have cached data — preserving cache');
                return false;
            }
            analyses = data.analyses;
            analysisVersion = data.version || 0;
            localStorage.setItem('analyses', JSON.stringify(analyses));
            localStorage.setItem('analysisVersion', String(analysisVersion));
            return true;
        }
    } catch (e) {
        console.warn('fetchAnalyses:', e);
        if (!analyses.length) analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
    }
    return false;
}

/**
 * تحلیل to سرور را ذخیره می‌کند.
 * ورودی: پارامترهای `payload, method, analysisId` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function saveAnalysisToServer(payload, method, analysisId) {
    if (!API_BASE || !isAdmin()) return null;
    if (method === 'POST') {
        return apiFetch('/api/analyses', { method: 'POST', body: JSON.stringify(payload) });
    }
    if (method === 'PUT') {
        return apiFetch(`/api/analyses/${analysisId}`, { method: 'PUT', body: JSON.stringify(payload) });
    }
    if (method === 'DELETE') {
        return apiFetch(`/api/analyses/${analysisId}`, { method: 'DELETE' });
    }
    return null;
}

/**
 * عملیات مربوط به sendSessionHeartbeat را انجام می‌دهد.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function sendSessionHeartbeat() {
    // R3-2: Skip heartbeat when app is not visible
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
        document.getElementById('ref-total').innerText = data.total ?? 0;
        document.getElementById('ref-active').innerText = data.active ?? 0;
        document.getElementById('ref-reward').innerText = `${data.tokens ?? 0} AB`;
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
    if (path === '/api/users/bootstrap') {
        console.log('[BOOT] apiFetch bootstrap — initData length:', initData.length, 'hasAuthHeader:', !!initData, 'user_id:', getUserId());
    }

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
/**
 * زبان وضعیت انتخاب را به‌روزرسانی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
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
// Cached i18n element references — avoids repeated querySelectorAll (5-15ms → 1-3ms per call)
let _i18nElements = null;
let _i18nPlaceholderElements = null;

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
    if (gEl) gEl.querySelector('span').textContent = gainers;
    var lEl = document.getElementById('sentiment-losers');
    if (lEl) lEl.querySelector('span').textContent = losers;

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
 * واچ‌لیست را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function renderWatchlist() {
    const grid = document.getElementById('watchlist-grid');
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

let displayedNews = [];

// ============================================================================
// NOTE (Phase 5): translateText, translateArticles, detectNewsCategory,
// parseRssItems, fetchRssArticles — all removed.
// Backend now handles: multi-source RSS, translation (CF Workers AI), categories.
// Frontend only calls /api/farsi-news and uses the 'category' field directly.
// ============================================================================
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
                // Stale-While-Revalidate: show cached, refresh in background
                loadNews(true);
                return;
            }
        }
        // Show skeleton loader while fetching (§6.3) — only on initial load
        const container = document.getElementById('news-list');
        const activeTab = document.querySelector('.news-tab.active')?.dataset?.news || 'all';
        if (!append && activeTab !== 'calendar') {
            container.innerHTML = Array(4).fill(`
                <div class="news-skeleton">
                    <div class="news-skeleton-img"></div>
                    <div class="news-skeleton-content">
                        <div class="news-skeleton-line"></div>
                        <div class="news-skeleton-line"></div>
                    </div>
                </div>
            `).join('');
        }

        const page = append ? newsPage + 1 : 1;
        let articles = [];
        let hasMore = false;
        let total = 0;

        try {
            const json = await apiFetch(`/api/farsi-news?page=${page}&limit=30`);
            if (json.data?.length) {
                articles = json.data.map(a => ({
                    title: a.title, body: a.description, source: a.source,
                    image: a.image, url: a.url, time: a.time_ago,
                    category: a.category || 'crypto'
                }));
            }
            hasMore = json.pagination?.hasMore || false;
            total = json.pagination?.total || 0;
        } catch (e) { console.warn('Farsi news API error:', e); }

        if (append) {
            newsCache = [...newsCache, ...articles];
        } else {
            newsCache = articles;
        }
        newsPage = page;
        newsHasMore = hasMore;
        newsTotalCount = total;

        Cache.set('news', newsCache, 300);
        renderNews(activeTab);
    } catch (e) {
        console.error('News error:', e);
        document.getElementById('news-list').innerHTML = `<div class="empty-state">${t('news_error')}</div>`;
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
    let filtered = newsCache;
    if (category === 'crypto') filtered = filtered.filter(n => n.category === 'crypto');
    else if (category === 'economy') filtered = filtered.filter(n => n.category === 'economy');
    else if (category === 'forex') filtered = filtered.filter(n => n.category === 'forex');
    else if (category === 'calendar') {
        // Show skeleton while loading
        if (calendarLoading) {
            container.innerHTML = `<div class="cal-sub-tabs">
                <button class="cal-sub-tab active">${t('cal_today')}</button>
                <button class="cal-sub-tab">${t('cal_tomorrow')}</button>
                <button class="cal-sub-tab">${t('cal_past')}</button>
            </div>` + Array(5).fill(`
                <div class="news-skeleton" style="height:56px;">
                    <div class="news-skeleton-content" style="width:100%;">
                        <div class="news-skeleton-line" style="width:70%;"></div>
                        <div class="news-skeleton-line" style="width:50%;"></div>
                    </div>
                </div>
            `).join('');
        }
        loadCalendarEvents().then(events => {
            const subTabsHtml = `<div class="cal-sub-tabs">
                <button class="cal-sub-tab${currentCalendarTab === 'today' ? ' active' : ''}" onclick="switchCalendarTab('today', this)">${t('cal_today')}</button>
                <button class="cal-sub-tab${currentCalendarTab === 'tomorrow' ? ' active' : ''}" onclick="switchCalendarTab('tomorrow', this)">${t('cal_tomorrow')}</button>
                <button class="cal-sub-tab${currentCalendarTab === 'past' ? ' active' : ''}" onclick="switchCalendarTab('past', this)">${t('cal_past')}</button>
            </div>`;

            if (!events.length) {
                container.innerHTML = subTabsHtml + `<div class="empty-state">${t('cal_empty')}</div>`;
                return;
            }

            const statusLabel = { past: t('cal_status_past'), live: t('cal_status_live'), upcoming: t('cal_status_upcoming') };
            const impactLabel = { high: t('cal_impact_high'), medium: t('cal_impact_med'), low: t('cal_impact_low') };

            // Filter events by currentCalendarTab
            const now = new Date();
            const userTz = now.getTimezoneOffset();
            const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
            const tomorrowStart = new Date(todayStart.getTime() + 86400000);

            let filteredEvents = events.filter(e => {
                if (!e.timestamp) return false;
                const eventDate = new Date(e.timestamp);
                if (isNaN(eventDate.getTime())) return false;
                const eventLocal = new Date(eventDate.getTime() - userTz * 60000);
                const eventDay = new Date(eventLocal.getFullYear(), eventLocal.getMonth(), eventLocal.getDate());
                if (currentCalendarTab === 'today') return eventDay.getTime() === todayStart.getTime();
                if (currentCalendarTab === 'tomorrow') return eventDay.getTime() === tomorrowStart.getTime();
                if (currentCalendarTab === 'past') return eventDay < todayStart;
                return true;
            });

            if (currentCalendarTab === 'past') {
                filteredEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));
            }

            if (!filteredEvents.length) {
                container.innerHTML = subTabsHtml + `<div class="empty-state">${t('cal_empty')}</div>`;
                return;
            }

            function renderCard(e) {
                const ft = formatCalendarTime(e.timestamp);
                const timeText = ft.time || '';
                return `
                <div class="eco-event-card ${e.status || 'upcoming'}">
                    <div class="eco-event-left">
                        <span class="eco-flag-emoji">${e.flag || '🏳️'}</span>
                        <div>
                            <div class="eco-event-title">${escapeHtml(e.title)}</div>
                            <div class="eco-event-meta">${timeText} • ${e.country || ''}</div>
                        </div>
                    </div>
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                        <span class="eco-impact eco-impact-${e.impact || 'medium'}">${impactLabel[e.impact] || impactLabel.medium}</span>
                        <span class="eco-status eco-status-${e.status || 'upcoming'}">${statusLabel[e.status] || e.status}</span>
                    </div>
                </div>`;
            }

            container.innerHTML = subTabsHtml + filteredEvents.map(e => renderCard(e)).join('');
        });
        return;
    }
    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">${t('no_data')}</div>`;
        return;
    }
    displayedNews = filtered;
    container.innerHTML = filtered.map((n, i) => `
        <div class="news-item" style="animation-delay:${i * 0.06}s" onclick="openNewsModal(${i})">
            <img src="${n.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2270%22 height=%2270%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E'}" class="news-img">
            <div class="news-content">
                <div class="news-title">${escapeHtml(n.title)}</div>
                <div class="news-source">${escapeHtml(n.source)} • ${escapeHtml(n.time || '')}</div>
            </div>
        </div>
    `).join('') + (newsHasMore && category === 'all' ? `
        <button class="load-more-btn" onclick="loadMoreNews()">
            ${t('load_more') || 'نمایش بیشتر'}
        </button>
    ` : '');
}
/**
 * نمایش یا وضعیت اخبار تب را تعویض می‌کند.
 * ورودی: پارامترهای `category, btn` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function switchNewsTab(category, btn) {
    document.querySelectorAll('.news-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    if (category === 'calendar') currentCalendarTab = 'today';
    renderNews(category);
}
function switchCalendarTab(tab, btn) {
    currentCalendarTab = tab;
    document.querySelectorAll('.cal-sub-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    // Re-render calendar without re-fetching
    const container = document.getElementById('news-list');
    if (!container || !calendarEvents.length) return;
    const statusLabel = { past: t('cal_status_past'), live: t('cal_status_live'), upcoming: t('cal_status_upcoming') };
    const impactLabel = { high: t('cal_impact_high'), medium: t('cal_impact_med'), low: t('cal_impact_low') };
    const now = new Date();
    const userTz = now.getTimezoneOffset();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);

    let filteredEvents = calendarEvents.filter(e => {
        if (!e.timestamp) return false;
        const eventDate = new Date(e.timestamp);
        if (isNaN(eventDate.getTime())) return false;
        const eventLocal = new Date(eventDate.getTime() - userTz * 60000);
        const eventDay = new Date(eventLocal.getFullYear(), eventLocal.getMonth(), eventLocal.getDate());
        if (tab === 'today') return eventDay.getTime() === todayStart.getTime();
        if (tab === 'tomorrow') return eventDay.getTime() === tomorrowStart.getTime();
        if (tab === 'past') return eventDay < todayStart;
        return true;
    });
    if (tab === 'past') filteredEvents.sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp));

    if (!filteredEvents.length) {
        container.innerHTML = container.querySelector('.cal-sub-tabs')?.outerHTML + `<div class="empty-state">${t('cal_empty')}</div>`;
        return;
    }
    function renderCard(e) {
        const ft = formatCalendarTime(e.timestamp);
        const timeText = ft.time || '';
        return `
        <div class="eco-event-card ${e.status || 'upcoming'}">
            <div class="eco-event-left">
                <span class="eco-flag-emoji">${e.flag || '🏳️'}</span>
                <div>
                    <div class="eco-event-title">${escapeHtml(e.title)}</div>
                    <div class="eco-event-meta">${timeText} • ${e.country || ''}</div>
                </div>
            </div>
            <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                <span class="eco-impact eco-impact-${e.impact || 'medium'}">${impactLabel[e.impact] || impactLabel.medium}</span>
                <span class="eco-status eco-status-${e.status || 'upcoming'}">${statusLabel[e.status] || e.status}</span>
            </div>
        </div>`;
    }
    const subTabsHtml = container.querySelector('.cal-sub-tabs')?.outerHTML || `<div class="cal-sub-tabs">
        <button class="cal-sub-tab${tab === 'today' ? ' active' : ''}" onclick="switchCalendarTab('today', this)">${t('cal_today')}</button>
        <button class="cal-sub-tab${tab === 'tomorrow' ? ' active' : ''}" onclick="switchCalendarTab('tomorrow', this)">${t('cal_tomorrow')}</button>
        <button class="cal-sub-tab${tab === 'past' ? ' active' : ''}" onclick="switchCalendarTab('past', this)">${t('cal_past')}</button>
    </div>`;
    container.innerHTML = subTabsHtml + filteredEvents.map(e => renderCard(e)).join('');
}
/**
 * اخبار مودال را باز می‌کند.
 * ورودی: پارامترهای `idx` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
//#region اسلایدر و فهرست تحلیل‌ها
// ============================================================================
/**
 * تحلیل اسلایدر را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
/**
 * تحلیل list را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
/**
 * تحلیل جزئیات را باز می‌کند.
 * ورودی: پارامترهای `id` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function openAnalysisDetail(id) {
    const a = analyses.find(x => x.id === id);
    if (!a) return;
    const modal = document.getElementById('analysis-detail-modal');
    document.getElementById('analysis-detail-coin').innerText = a.coin;
    document.getElementById('analysis-detail-tf').innerText = a.timeframe || '1d';
    const img = document.getElementById('analysis-detail-image');
    img.src = a.image || '';
    img.style.display = '';
    document.getElementById('analysis-detail-author').innerText = a.author || '';
    document.getElementById('analysis-detail-date').innerText = a.date || '';
    document.getElementById('analysis-detail-text').innerText = a.text;
    modal.classList.add('bs-open');
    requestAnimationFrame(() => { modal.style.display = ''; });
}
function closeAnalysisDetail() {
    const modal = document.getElementById('analysis-detail-modal');
    modal.classList.remove('bs-open');
    setTimeout(() => { modal.style.display = 'none'; }, 350);
}
function shareAnalysis() {
    const a = analyses.find(x => x.id === document.getElementById('analysis-detail-coin')?.dataset?.id);
    const coin = document.getElementById('analysis-detail-coin')?.innerText || '';
    const text = document.getElementById('analysis-detail-text')?.innerText || '';
    const shareText = `${coin}\n\n${text}`;
    if (navigator.share) {
        navigator.share({ title: coin, text: shareText }).catch(() => {});
    } else if (navigator.clipboard) {
        navigator.clipboard.writeText(shareText).then(() => {
            const btn = document.querySelector('.bs-share-btn span');
            if (btn) { const orig = btn.innerText; btn.innerText = 'کپی شد!'; setTimeout(() => btn.innerText = orig, 1500); }
        });
    }
}

//#endregion

// ============================================================================
//#region مدیریت تحلیل مدیر
// ============================================================================
/**
 * بررسی می‌کند که آیا مدیر برقرار است یا خیر.
 * ورودی: بدون ورودی.
 * خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
 */
function isAdmin() {
    const user = getTelegramUser();
    return user && String(user.id) === ADMIN_ID;
}
/**
 * add تحلیل مودال را باز می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
/**
 * edit تحلیل مودال را باز می‌کند.
 * ورودی: پارامترهای `id` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
/**
 * add تحلیل مودال را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeAddAnalysisModal() {
    document.getElementById('add-analysis-modal').style.display = 'none';
    editingAnalysisId = null;
}
/**
 * فرم یا داده تحلیل را ارسال می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function submitAnalysis() {
    const coin = document.getElementById('analysis-coin').value.trim().toUpperCase();
    const timeframe = document.getElementById('analysis-timeframe').value.trim() || '1d';
    let image = document.getElementById('analysis-image').value.trim();
    const text = document.getElementById('analysis-text').value.trim();
    if (!coin || !text) { alert('نام ارز و متن تحلیل الزامی است.'); return; }
    if (!image) image = 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop';

    const author = getTelegramUser()?.first_name || 'مدیر';
    const payload = { coin, timeframe, image, text, author, author_id: getUserId() };

    (async () => {
        try {
            if (editingAnalysisId) {
                await saveAnalysisToServer(payload, 'PUT', editingAnalysisId);
                addNotification(t('edit_analysis'), `${coin} (${timeframe})`, { sendToTelegram: true });
            } else {
                await saveAnalysisToServer(payload, 'POST');
                addNotification('تحلیل جدید', `تحلیل ${coin} منتشر شد.`, { sendToTelegram: true });
            }
            await fetchAnalyses(true);
            renderAnalysisSlider();
            renderAnalysisList();
            closeAddAnalysisModal();
            ['analysis-coin', 'analysis-timeframe', 'analysis-image', 'analysis-text'].forEach(id => {
                const el = document.getElementById(id);
                if (el) el.value = '';
            });
        } catch (e) {
            console.error('submitAnalysis:', e);
            if (editingAnalysisId) {
                const idx = analyses.findIndex(a => a.id === editingAnalysisId);
                if (idx >= 0) analyses[idx] = { ...analyses[idx], coin, timeframe, image, text, date: new Date().toLocaleDateString('fa-IR') };
            } else {
                analyses.unshift({ id: Date.now().toString(), coin, timeframe, image, text, date: new Date().toLocaleDateString('fa-IR'), author });
            }
            localStorage.setItem('analyses', JSON.stringify(analyses));
            renderAnalysisSlider();
            renderAnalysisList();
            closeAddAnalysisModal();
        }
    })();
}
/**
 * تحلیل را حذف می‌کند.
 * ورودی: پارامترهای `id, event` را دریافت می‌کند.
 * خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت برنامه اثر می‌گذارد.
 */
function deleteAnalysis(id, event) {
    if (event) event.stopPropagation();
    if (!isAdmin()) return;
    if (confirm('آیا از حذف این تحلیل مطمئن هستید؟')) {
        (async () => {
            try {
                await saveAnalysisToServer(null, 'DELETE', id);
                await fetchAnalyses(true);
            } catch (e) {
                analyses = analyses.filter(a => a.id !== id);
                localStorage.setItem('analyses', JSON.stringify(analyses));
            }
            renderAnalysisSlider();
            renderAnalysisList();
            addNotification('تحلیل حذف شد', 'یک تحلیل توسط مدیر حذف گردید.', { sendToTelegram: false });
        })();
    }
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
    if (currentTvWidget) {
        try { currentTvWidget.remove(); } catch {}
        currentTvWidget = null;
    }
    document.querySelector('.chart-exchange-badge')?.remove();
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
            disabled_features: ['header_widget_dom_node']
        });
    } else {
        chartContainer.innerHTML = `<div class="empty-state"><svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" stroke-width="1.5"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 5 5-9"/></svg><br>${t('chart_unavailable')}</div>`;
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
    const btn = document.getElementById('detail-watch-btn');
    if (!btn) return;
    const inWatch = watchlist.includes(symbol);
    btn.classList.toggle('active', inWatch);
    btn.querySelector('svg').setAttribute('fill', inWatch ? 'currentColor' : 'none');
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
        try { currentTvWidget.remove(); } catch {}
        currentTvWidget = null;
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
/**
 * فعال هشدارها را در رابط کاربری رندر می‌کند.
 * ورودی: پارامترهای `symbol` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
/**
 * جهت هشدار را انتخاب و UI را بروزرسانی می‌کند.
 */
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
    const badge = document.getElementById('notif-badge');
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
        document.getElementById('profile-name').innerText = t('loading_user');
        document.getElementById('profile-username').innerText = '...';
        document.getElementById('profile-id-num').innerText = '...';
        return;
    }

    const user = getTelegramUser();
    if (user) {
        document.getElementById('profile-name').innerText = `${user.first_name || ''} ${user.last_name || ''}`.trim() || t('guest');
        document.getElementById('profile-username').innerText = user.username ? `@${user.username}` : '@guest';
        document.getElementById('profile-id-num').innerText = user.id || '000000';
        if (user.photo_url) document.getElementById('profile-avatar').src = user.photo_url;
        document.getElementById('ref-link').value = `https://t.me/${BOT_USERNAME}?start=ref_${user.id}`;
        loadReferralStats();
        // Fix: reload wallet card now that the user is confirmed — resolves race condition
        // where loadProfileCard() ran earlier while UserContext was still pending
        window.WalletApp?.loadProfileCard();
    } else if (UserContext.isPending()) {
        document.getElementById('profile-name').innerText = t('loading_user');
        document.getElementById('profile-username').innerText = '...';
        document.getElementById('profile-id-num').innerText = '...';
        document.getElementById('ref-link').value = `https://t.me/${BOT_USERNAME}?start=ref_`;
    } else if (UserContext.isGuest()) {
        document.getElementById('profile-name').innerText = t('guest');
        document.getElementById('profile-username').innerText = '@guest';
        document.getElementById('profile-id-num').innerText = getUserId().replace('guest_', '') || '000000';
        // M-R5: guest users should not have a working referral link
        document.getElementById('ref-link').value = '';
        const refLinkInput = document.getElementById('ref-link');
        if (refLinkInput) refLinkInput.placeholder = 'Login required';
    }

    const adminBtn = document.getElementById('admin-add-btn');
    if (adminBtn) adminBtn.style.display = isAdmin() ? 'block' : 'none';
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

    if (pageId === 'dashboard-page') {
        if (!tabLoaded.dashboard) {
            loadUser();
            loadMarketData();
            fetchAnalyses().then(() => { renderAnalysisSlider(); });
            loadImportantNews();
            tabLoaded.dashboard = true;
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
            fetchAnalyses(true).then(() => renderAnalysisList());
            tabLoaded.analysis = true;
        } else {
            renderAnalysisList();
        }
        document.getElementById('admin-add-btn').style.display = isAdmin() ? 'block' : 'none';
    } else if (pageId === 'news-page') {
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
        displayedNews = important;
        container.innerHTML = important.map((n, i) => `
            <div class="important-news-item" style="animation-delay:${i * 0.06}s" onclick="openNewsModal(${i})">
                <img src="${n.image || 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%2250%22 height=%2250%22 viewBox=%220 0 24 24%22 fill=%22%231a2332%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E'}" class="important-news-img">
                <div class="important-news-content">
                    <div class="important-news-title">${escapeHtml(n.title)}</div>
                    <div class="important-news-source">${escapeHtml(n.source)}</div>
                </div>
            </div>
        `).join('');
    } catch (e) {}
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
    } else {
        _startAllPolling();
    }
});

function startPolling() {
    _startAllPolling();
}

//#endregion

// ============================================================================
//#region راه‌اندازی برنامه
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    console.log('[BOOT] DOMContentLoaded — starting init');
    await UserContext.init();
    console.log('[BOOT] UserContext.init done — user:', UserContext.user?.id || 'null', 'ready:', UserContext.ready);

    alerts = alerts.map(a => ({ ...a, userId: a.userId || getUserId() }));
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    await bootstrapUser();
    loadUser();
    updateNotifBadge();

    // Cold-open retry: if bootstrap was skipped (isPending), poll every 500ms
    // until Telegram initData arrives, then run bootstrap exactly once.
    // 500ms ensures we fire BEFORE the 3s cold-open reload timer.
    if (!bootstrapComplete && UserContext.isPending()) {
        console.log('[BOOT] Starting retry interval (500ms) — user is pending');
        let retryCount = 0;
        const bootstrapRetry = setInterval(() => {
            retryCount++;
            if (bootstrapComplete) {
                console.log('[BOOT] Retry: bootstrapComplete, clearing interval after', retryCount, 'checks');
                clearInterval(bootstrapRetry);
                return;
            }
            console.log('[BOOT] Retry #' + retryCount + ': checking for user...');
            tryLateBootstrap();
            if (bootstrapComplete) {
                console.log('[BOOT] Retry: bootstrap succeeded on check #' + retryCount);
                clearInterval(bootstrapRetry);
            }
        }, 500);
        setTimeout(() => {
            if (!bootstrapComplete) {
                console.warn('[BOOT] Retry: 30s timeout reached, clearing interval');
            }
            clearInterval(bootstrapRetry);
        }, 30000); // stop after 30s
    } else {
        console.log('[BOOT] No retry needed — bootstrapComplete:', bootstrapComplete, 'isPending:', UserContext.isPending());
    }

    // Phase A: Render analysis slider immediately from localStorage cache
    // analyses is already populated from localStorage at module load (line 260)
    if (analyses.length) {
        renderAnalysisSlider();
    } else {
        // Show skeleton for analysis slider when no cache
        document.getElementById('slider-track').innerHTML = `
            <div class="slider-skeleton">
                <div class="slider-skeleton-img"></div>
                <div class="slider-skeleton-text">
                    <div class="slider-skeleton-line"></div>
                    <div class="slider-skeleton-line"></div>
                    <div class="slider-skeleton-line"></div>
                </div>
            </div>`;
    }

    // Phase C: Load cached market data for instant watchlist render
    // NOTE: localStorage cache with old pre-fix percentages is invalidated
    // by checking a version tag. Bump CACHE_VERSION to force fresh fetch.
    const MARKET_CACHE_VERSION = 3; // Bump when percentage normalization changes
    try {
        const cachedVersion = parseInt(localStorage.getItem('market_cache_version') || '0', 10);
        const cachedMarket = JSON.parse(localStorage.getItem('market_data_cache') || '[]');
        if (Array.isArray(cachedMarket) && cachedMarket.length && cachedVersion >= MARKET_CACHE_VERSION) {
            allCoins = cachedMarket;
            renderWatchlist();
            renderSummary();
        } else if (cachedVersion < MARKET_CACHE_VERSION) {
            // Version mismatch — bust stale cache to prevent showing wrong percentages
            localStorage.removeItem('market_data_cache');
        }
    } catch(_) {}

    // Phase B: Show skeleton for watchlist and important-news while loading (only if not already rendered by Phase C)
    const watchGrid = document.getElementById('watchlist-grid');
    if (watchGrid && !watchGrid.children.length) {
        watchGrid.innerHTML = `<div class="watchlist-skeleton">${
            Array(4).fill(`<div class="watchlist-skeleton-item">
                <div class="watchlist-skeleton-icon"></div>
                <div class="watchlist-skeleton-lines">
                    <div class="watchlist-skeleton-line"></div>
                    <div class="watchlist-skeleton-line"></div>
                </div>
            </div>`).join('')
        }</div>`;
    }
    const newsContainer = document.getElementById('important-news');
    if (newsContainer && !newsContainer.children.length) {
        newsContainer.innerHTML = `<div class="important-news-skeleton">${
            Array(3).fill(`<div class="important-news-skeleton-item">
                <div class="important-news-skeleton-img"></div>
                <div class="important-news-skeleton-text">
                    <div class="important-news-skeleton-line"></div>
                    <div class="important-news-skeleton-line"></div>
                </div>
            </div>`).join('')
        }</div>`;
    }

    tabLoaded.dashboard = true;
    loadMarketData(true);
    fetchAnalyses().then(() => renderAnalysisSlider());
    // Delay important news to reduce startup concurrent connections (news is below the fold)
    setTimeout(() => loadImportantNews(), 2000);

    loadAlertsFromServer().then(() => checkAlerts());
    startPolling();

    // R4: Initialize admin panel — check if user is admin and show entry button
    if (typeof initAdminPanel === 'function') {
        initAdminPanel();
    }

    setInterval(() => {
        if (document.getElementById('tickets-modal')?.style.display === 'flex') fetchTickets().then(renderTickets);
        if (document.getElementById('admin-tickets-modal')?.style.display === 'flex') fetchAdminTickets().then(renderAdminTickets);
    }, 15000);

    // Scroll-to-top button visibility
    const scrollTopBtn = document.getElementById('scroll-top-btn');
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
        setInterval(() => goTo(current + 1), 3000);
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
window.openAnalysisDetail = openAnalysisDetail;
window.closeAnalysisDetail = closeAnalysisDetail;
window.shareAnalysis = shareAnalysis;
window.deleteAnalysis = deleteAnalysis;
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

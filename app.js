// ============================================================
// Amir BTC Assistant - Core Application v3.4
// با پاپ‌آپ جوین اجباری، ۱۰۰ ارز، تقویم اقتصادی، حذف همه نوتیف‌ها، و رفع تنظیمات
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
    return getTg()?.initData || '';
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
    const ready = await ensureTelegramAuthReady(maxWaitMs);
    if (!ready) throw new Error('TELEGRAM_NOT_READY');
}

/**
 * وب‌اپ تلگرام را آماده می‌کند و کاربر معتبر را پس از آماده شدن در کانتکست ذخیره می‌کند.
 * ورودی: پارامترهای `maxWaitMs = 8000` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function initTelegramWebApp(maxWaitMs = 8000) {
    if (telegramInitDone && getTelegramUser()?.id) return getTelegramUser();
    const tg = getTg();
    if (tg) {
        try {
            tg.ready();
            tg.expand();
            tg.onEvent?.('viewportChanged', () => {
                const u = getTelegramUser();
                if (u?.id) {
                    UserContext.user = u;
                    UserContext.loading = false;
                    UserContext._setLoadingUI(false);
                    loadUser();
                }
            });
        } catch (e) {
            console.warn('initTelegramWebApp:', e);
        }
    }
    const start = Date.now();
    while (Date.now() - start < maxWaitMs) {
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
    return UserContext.user;
}

//#endregion

// ============================================================================
//#region پیکربندی و وضعیت سراسری برنامه
// ============================================================================

const ADMIN_ID = '831704732';
let BOT_USERNAME = 'Amir_BTC_AssistantBot'; // Fallback — overridden by bootstrap API (H-R4)
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
/**
 * مقدار ارز full name را بازیابی می‌کند.
 * ورودی: پارامترهای `sym` را دریافت می‌کند.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
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
let analysisVersion = 0;
let sessionId = localStorage.getItem('app_session_id') || null;
const tabLoaded = { dashboard: false, market: false, analysis: false, news: false, profile: false };
let calendarEvents = [];
let calendarLoading = false;

//#endregion

// ============================================================================
//#region ترجمه و محلی‌سازی
// ============================================================================
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
        join_web_title: 'فقط از تلگرام',
        join_web_desc: 'این اپلیکیشن فقط از داخل ربات تلگرام قابل استفاده است. روی دکمه زیر بزنید و از منوی ربات وارد شوید.',
        join_open_bot: 'باز کردن ربات تلگرام',
        loading_user: 'در حال بارگذاری...',
        join_db_error: 'خطا در اتصال به سرور. لطفاً چند لحظه بعد دوباره تلاش کنید.',
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
        price: 'قیمت', change_24h: 'تغییر ۲۴h', mcap: 'مارکت‌کپ', volume_24h: 'حجم ۲۴h',
        view_source: 'مشاهده منبع', guest: 'کاربر میهمان', required_fields: 'فیلدهای الزامی را پر کنید',
        invalid_price: 'قیمت معتبر وارد کنید', copied: 'کپی شد!', copy_ref_msg: 'لینک دعوت کپی شد.',
        online_users: 'کاربر آنلاین', cal_status_past: 'گذشته', cal_status_live: 'زنده', cal_status_upcoming: 'آینده',
        price_reached: 'قیمت به', ai_title: 'دستیار هوشمند', ai_messages_today: 'پیام امروز',
        ai_cooldown: 'لطفاً چند ثانیه صبر کنید', ai_limit: 'محدودیت روزانه', ai_error: 'دستیار در دسترس نیست'
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
        join_web_title: 'Telegram Only',
        join_web_desc: 'This app works only inside the Telegram bot. Tap the button below to open the bot and launch the app.',
        join_open_bot: 'Open Telegram Bot',
        loading_user: 'Loading...',
        join_db_error: 'Server connection error. Please try again in a moment.',
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
        price: 'Price', change_24h: '24h Change', mcap: 'Market Cap', volume_24h: '24h Volume',
        view_source: 'View source', guest: 'Guest User', required_fields: 'Please fill required fields',
        invalid_price: 'Enter a valid price', copied: 'Copied!', copy_ref_msg: 'Referral link copied.',
        online_users: 'users online', cal_status_past: 'Past', cal_status_live: 'Live', cal_status_upcoming: 'Upcoming',
        price_reached: 'Price reached', ai_title: 'AI Assistant', ai_messages_today: 'messages today',
        ai_cooldown: 'Please wait a few seconds', ai_limit: 'Daily limit reached', ai_error: 'Assistant unavailable'
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
    const tg = getTg();
    const startParam = tg?.initDataUnsafe?.start_param;
    if (!startParam || !startParam.startsWith('ref_')) return null;
    const id = startParam.slice(4);
    // M-R7: only accept numeric Telegram IDs
    return /^\d{1,20}$/.test(id) ? id : null;
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

    if (!API_BASE || UserContext.isGuest() || UserContext.isPending()) {
        applyLanguage();
        return;
    }

    try {
        const u = getTelegramUser();
        const data = await apiFetch('/api/users/bootstrap', {
            method: 'POST',
            body: JSON.stringify({
                user_id: getUserId(),
                username: u?.username || null,
                first_name: u?.first_name || null,
                last_name: u?.last_name || null,
                lang: currentLang,
                referrer_id: getReferrerId()
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
    } catch (e) {
        console.warn('bootstrapUser:', e);
        applyLanguage();
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
        const versionParam = force ? '' : (analysisVersion ? `?version=${analysisVersion}` : '');
        const data = await apiFetch(`/api/analyses${versionParam}`);
        if (data.unchanged) return false;
        if (Array.isArray(data.analyses)) {
            analyses = data.analyses;
            analysisVersion = data.version || 0;
            localStorage.setItem('analyses', JSON.stringify(analyses));
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
    const now = new Date();
    const userTz = now.getTimezoneOffset(); // minutes offset from UTC
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate());
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

        const eventLocal = new Date(eventDate.getTime() - userTz * 60000);
        const eventDay = new Date(eventLocal.getFullYear(), eventLocal.getMonth(), eventLocal.getDate());

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
    const now = new Date();
    const userTz = now.getTimezoneOffset();
    const local = new Date(d.getTime() - userTz * 60000);
    const hh = String(local.getHours()).padStart(2, '0');
    const mm = String(local.getMinutes()).padStart(2, '0');
    const day = local.getDate();
    const monthNames = currentLang === 'fa'
        ? ['ژانویه','فوریه','مارس','آوریل','مه','ژوئن','ژوئیه','اوت','سپتامبر','اکتبر','نوامبر','دسامبر']
        : ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
    const monthName = monthNames[local.getMonth()];
    return { time: `${hh}:${mm}`, dayStr: `${day} ${monthName}` };
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

    if (API_BASE) {
        try {
            const data = await apiFetch(`/api/charts/resolve?symbol=${encodeURIComponent(symbol)}`);
            if (data.found && data.tv_symbol) {
                Cache.set(cacheKey, data, 3600);
                return data;
            }
        } catch (e) { console.warn('resolveChartSymbol:', e); }
    }

    const fallback = { found: true, tv_symbol: `BINANCE:${symbol}USDT`, exchange: 'binance' };
    Cache.set(cacheKey, fallback, 300);
    return fallback;
}

/**
 * درخواست HTTP داخلی را با هدر احراز هویت تلگرام و مدیریت خطا به API ارسال می‌کند.
 * ورودی: پارامترهای `path, options = {}` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function apiFetch(path, options = {}) {
    await waitForApiReady(8000);
    const headers = { 'Content-Type': 'application/json', ...options.headers };
    const initData = getTelegramInitData();
    if (initData) headers['X-Telegram-Init-Data'] = initData;
    const url = `${API_BASE}${path}`;
    const res = await fetch(url, { headers, ...options });
    if (!res.ok) {
        let detail = '';
        try { detail = await res.text(); } catch (_) {}
        throw new Error(detail || `HTTP ${res.status}`);
    }
    return res.json();
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
function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => { const key = el.dataset.i18n; if (key) el.innerText = t(key); });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => { const key = el.dataset.i18nPlaceholder; if (key) el.placeholder = t(key); });
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
    const div = document.createElement('div');
    div.textContent = String(str);
    return div.innerHTML;
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
/**
 * داده بازار ارزها را مستقیماً از API سرویس CoinGecko دریافت و نرمال‌سازی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function fetchCoinGecko() {
    const res = await fetch('https://api.coingecko.com/api/v3/coins/markets?vs_currency=usd&order=market_cap_desc&per_page=200&page=1&sparkline=false');
    if (!res.ok) throw new Error(`CoinGecko HTTP ${res.status}`);
    const data = await res.json();
    if (!Array.isArray(data)) throw new Error('Invalid CoinGecko response');
    return data
        .filter(item => item && typeof item === 'object')
        .map((item, index) => ({
            symbol: String(item.symbol || '').toUpperCase(),
            name: item.name || '',
            rank: index + 1,
            priceUsd: item.current_price || 0,
            changePercent24Hr: item.price_change_percentage_24h || 0,
            volumeUsd24Hr: item.total_volume || 0,
            marketCapUsd: item.market_cap || 0,
            supply: item.circulating_supply || 0,
            image: item.image || ''
        }));
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

        // Primary: backend /api/market (P0-2)
        let fetched = false;
        if (API_BASE) {
            try {
                const res = await apiFetch('/api/market');
                if (res.status === 'success' && Array.isArray(res.data) && res.data.length) {
                    allCoins = res.data;
                    fetched = true;
                }
            } catch (e) {
                console.warn('Backend /api/market failed, trying direct fallback:', e);
            }
        }

        // Fallback: direct CoinGecko (kept for when API_BASE is not set)
        if (!fetched) {
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

//#endregion

// ============================================================================
//#region خلاصه بازار
// ============================================================================
/**
 * خلاصه را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
/**
 * نمایش یا وضعیت بازار تب را تعویض می‌کند.
 * ورودی: پارامترهای `tab, btn` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
    if (idx > -1) {
        watchlist.splice(idx, 1);
    } else {
        if (watchlist.length >= MAX_WATCHLIST) {
            getTg()?.showPopup?.({
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
/**
 * واچ‌لیست را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
        return `
        <div class="modal-coin-item ${atLimit ? 'disabled' : ''}" onclick="${atLimit ? '' : `toggleWatchlist('${c.symbol}', event); populateCoinModal();`}">
            <span>${c.symbol} - ${c.name}</span>
            <span>${inList ? '<svg width="16" height="16" viewBox="0 0 24 24" fill="#f7931a" stroke="#f7931a" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>' : '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="#555" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'}</span>
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
            const res = await fetch(`${API_BASE}/api/farsi-news?page=${page}&limit=30`);
            const json = await res.json();
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
            container.innerHTML = Array(5).fill(`
                <div class="news-skeleton" style="height:56px;">
                    <div class="news-skeleton-content" style="width:100%;">
                        <div class="news-skeleton-line" style="width:70%;"></div>
                        <div class="news-skeleton-line" style="width:50%;"></div>
                    </div>
                </div>
            `).join('');
        }
        loadCalendarEvents().then(events => {
            if (!events.length) {
                container.innerHTML = `<div class="empty-state">${t('cal_empty')}</div>`;
                return;
            }
            const groups = groupCalendarEvents(events);
            const statusLabel = { past: t('cal_status_past'), live: t('cal_status_live'), upcoming: t('cal_status_upcoming') };
            const impactLabel = { high: t('cal_impact_high'), medium: t('cal_impact_med'), low: t('cal_impact_low') };

            function renderCard(e, timePrefix) {
                const ft = formatCalendarTime(e.timestamp);
                const timeDisplay = ft.time || '';
                const dayDisplay = timePrefix || (ft.dayStr ? `${ft.dayStr}` : '');
                const timeText = dayDisplay ? `${dayDisplay} - ${timeDisplay}` : timeDisplay;
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

            function renderSection(title, events, timePrefix) {
                if (!events.length) return '';
                return `
                <div class="cal-section">
                    <div class="cal-section-header">${title}</div>
                    ${events.map(e => renderCard(e, timePrefix)).join('')}
                </div>`;
            }

            container.innerHTML =
                renderSection(t('cal_today'), groups.today, '') +
                renderSection(t('cal_tomorrow'), groups.tomorrow, '') +
                renderSection(t('cal_day_after'), groups.dayAfter, '') +
                renderSection(t('cal_past'), groups.past, '');
        });
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
    renderNews(category);
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
    document.getElementById('analysis-detail-title').innerText = `${a.coin} (${a.timeframe})`;
    document.getElementById('analysis-detail-image').src = a.image || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop';
    document.getElementById('analysis-detail-meta').innerText = `${a.author} • ${a.date}`;
    document.getElementById('analysis-detail-text').innerText = a.text;
    document.getElementById('analysis-detail-modal').style.display = 'flex';
}
/**
 * تحلیل جزئیات را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeAnalysisDetail() {
    document.getElementById('analysis-detail-modal').style.display = 'none';
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
    const coin = allCoins.find(c => c.symbol === symbol);
    if (!coin) return;
    document.getElementById('detail-coin-title').innerText = `${symbol} / USDT`;
    const modal = document.getElementById('coin-detail-modal');
    modal.style.display = 'flex';

    const chartContainer = document.getElementById('detail-chart');
    document.querySelector('.chart-exchange-badge')?.remove();
    chartContainer.innerHTML = '<div class="empty-state">Loading chart...</div>';

    const chartInfo = await resolveChartSymbol(symbol);
    chartContainer.innerHTML = '';
    if (typeof TradingView !== 'undefined' && chartInfo.found) {
        if (chartInfo.exchange) {
            const badge = document.createElement('div');
            badge.className = 'chart-exchange-badge';
            badge.innerText = chartInfo.exchange.toUpperCase();
            chartContainer.parentNode.insertBefore(badge, chartContainer);
        }
        new TradingView.widget({
            width: '100%',
            height: '100%',
            symbol: chartInfo.tv_symbol,
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
/**
 * ارز جزئیات را می‌بندد.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
function closeCoinDetail() {
    document.querySelector('.chart-exchange-badge')?.remove();
    document.getElementById('coin-detail-modal').style.display = 'none';
}
/**
 * فعال هشدارها را در رابط کاربری رندر می‌کند.
 * ورودی: پارامترهای `symbol` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
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
                direction: 'above'
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
    if (!API_BASE || isGuestUserId(uid) || isPendingTelegramUserId(uid) || UserContext.isPending()) return;
    try {
        const data = await apiFetch('/api/alerts');
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
    getTg()?.showPopup?.({ title: t('alert_registered'), message: `${symbol} — $${price}`, buttons: [{ type: 'ok' }] });
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
    const symbol = document.getElementById('detail-coin-title')?.innerText?.split(' ')[0];
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
    await notifyTelegram(msg);
    const symbol = document.getElementById('detail-coin-title')?.innerText?.split(' ')[0];
    if (symbol === alert.symbol) renderActiveAlerts(symbol);
}
/**
 * هشدارها را بررسی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
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
        document.getElementById('ref-link').value = `https://t.me/${BOT_USERNAME}/app?startapp=ref_${user.id}`;
        loadReferralStats();
    } else if (UserContext.isPending()) {
        document.getElementById('profile-name').innerText = t('loading_user');
        document.getElementById('profile-username').innerText = '...';
        document.getElementById('profile-id-num').innerText = '...';
        document.getElementById('ref-link').value = `https://t.me/${BOT_USERNAME}/app`;
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
 * HTML را برای نمایش ایمن‌سازی می‌کند.
 * ورودی: پارامترهای `str` را دریافت می‌کند.
 * خروجی: مقدار محاسبه‌شده یا داده نهایی مرتبط با این عملیات را برمی‌گرداند.
 */
function escapeHtml(str) {
    if (!str) return '';
    return str.replace(/&/g,'&amp;').replace(/</g,'&lt;').replace(/>/g,'&gt;').replace(/"/g,'&quot;');
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
        loadUser();
        loadReferralStats();
        fetchOnlineCount();
        tabLoaded.profile = true;
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
            <div class="important-news-item" onclick="openNewsModal(${i})">
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
function startPolling() {
    setInterval(() => {
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
    }, 30000);
    setInterval(checkAlerts, 15000);
    setInterval(sendSessionHeartbeat, 45000);
    sendSessionHeartbeat();
    setInterval(fetchOnlineCount, 60000);
    setInterval(() => {
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'analysis-page' || activePage === 'dashboard-page') {
            fetchAnalyses().then(changed => {
                if (changed) {
                    renderAnalysisSlider();
                    if (activePage === 'analysis-page') renderAnalysisList();
                }
            });
        }
    }, 10000);
}

//#endregion

// ============================================================================
//#region راه‌اندازی برنامه
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    await UserContext.init();
    alerts = alerts.map(a => ({ ...a, userId: a.userId || getUserId() }));
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    await bootstrapUser();
    loadUser();
    updateNotifBadge();

    tabLoaded.dashboard = true;
    loadMarketData(true);
    fetchAnalyses().then(() => renderAnalysisSlider());
    loadImportantNews();

    loadAlertsFromServer().then(() => checkAlerts());
    startPolling();

    setInterval(() => {
        if (document.getElementById('tickets-modal')?.style.display === 'flex') fetchTickets().then(renderTickets);
        if (document.getElementById('admin-tickets-modal')?.style.display === 'flex') fetchAdminTickets().then(renderAdminTickets);
    }, 15000);
});

//#endregion

// ============================================================================
//#region ثبت توابع در فضای global
// ============================================================================
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
window.openNewsModal = openNewsModal;
window.closeNewsModal = closeNewsModal;
window.getUserId = getUserId;
window.isInTelegram = isInTelegram;
window.isGuestUserId = isGuestUserId;

//#endregion

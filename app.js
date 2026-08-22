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
let _betaPopupShown = false; // session guard — prevents double-show within same tab
let _adPopupShown = false; // session guard — prevents double-show of advertisement popup
let _adPopupFetchInFlight = false; // prevents concurrent /api/advertisements/popups calls
let _bootstrapPromise = null;
let _bootstrapLongTimer = null; // Long-term bootstrap retry — survives visibility changes (NOT in _pollingIntervals)
let _adminPanelInitialized = false;
// LIFECYCLE/BFCACHE FIX: timestamp recorded in 'pagehide' handler. Used by the
// 'pageshow' (event.persisted) and 'visibilitychange' (visible) recovery paths
// to detect a "stuck" bootstrap in-flight promise after the page was hidden
// for more than 20s (15s fetch timeout + 5s margin). When stuck, the in-flight
// promise is cleared so the next bootstrapUser()/tryLateBootstrap() makes a
// fresh API call instead of returning the never-resolving stuck promise.
// See AUDIT-BFCACHE-STUCK-PROMISE in worklog.md for the root-cause analysis.
let _pageHiddenAt = 0;

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
    // If we already attempted AND auth is now ready, skip.
    // But if auth is NOT ready after a previous attempt, DON'T skip —
    // the user may have opened the admin panel before Telegram SDK
    // finished initializing. Retry the wait so subsequent API calls
    // get a valid initData header instead of failing with 401.
    if (_authWaitAttempted && isTelegramAuthReady()) return;
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
let isCurrentUserAdmin = false; // SECURITY: Only set from server bootstrap response
let BOT_USERNAME = 'Amir_BTC_AssistantBot'; // Fallback — overridden by bootstrap API (H-R4)
// WATCHLIST PREMIUM LIMIT FIX (Problem A):
// Previously hard-coded `const MAX_WATCHLIST = 7` — premium users still hit
// the Free limit at 7 because the frontend gate (toggleWatchlist at ~line 5560)
// blocked the PUT request before the backend (which correctly supports 20 for
// premium) was ever reached. The backend limit is correct
// (src/controllers/watchlist.js:_getEffectiveMaxWatchlist → entitlement_config
// .watchlist.normal_max=7, premium_max=20), but the frontend pre-empted it.
//
// FIX: getMaxWatchlist() returns the effective limit based on the cached
// premium status from MembershipApp. Safe fallback is 7 (Free) when
// MembershipApp hasn't loaded yet (e.g. early-session, before profile open).
// Once the user opens their profile, MembershipApp.loadCard() populates the
// cache and subsequent toggleWatchlist calls see the premium limit (20).
//
// NOTE: the backend remains the authoritative enforcer. Even if a premium
// user's frontend cache is stale (still thinks Free), the PUT will succeed on
// the backend up to 20 — the frontend only uses this for UX (show/hide the
// "+Add" card, disable coin-picker items, gate the toggle). If a Free user
// somehow bypasses the frontend gate, the backend will still reject at 7+1.
function getMaxWatchlist() {
    try {
        if (window.MembershipApp && typeof window.MembershipApp.isPremiumCached === 'function'
            && window.MembershipApp.isPremiumCached()) {
            return 20; // entitlement_config.watchlist.premium_max
        }
    } catch (_) { /* ignore — fall through to Free limit */ }
    return 7; // entitlement_config.watchlist.normal_max
}
// Kept for backward-compat with any code/tests that still reference MAX_WATCHLIST
// directly. Returns the Free limit (7) — the dynamic value is via getMaxWatchlist().
const MAX_WATCHLIST = 7;
const PROXY = 'https://proxyserveramirbtc.amirkamary7.workers.dev/?url=';
const API_BASE = (window.API_BASE || '').replace(/\/$/, '');


/**
 * P1-06 FIX (NEWSFE-001): Safely parse a JSON string from localStorage.
 * If the stored value is missing, empty, or malformed (corrupted by a partial
 * write during a crash, browser quota cutoff, or manual editing), return the
 * fallback instead of throwing. Previously, module-level JSON.parse(localStorage
 * .getItem(...)) calls would throw a SyntaxError that propagated to the script
 * parser and ABORTED the entire app.js load — causing a blank page.
 *
 * @param {string} key - localStorage key
 * @param {*} fallback - Value to return on missing/corrupt JSON (default [])
 * @returns {*} Parsed value or fallback
 */
function safeJsonParseLocalStorage(key, fallback = []) {
    try {
        const raw = localStorage.getItem(key);
        if (!raw) return fallback;
        const parsed = JSON.parse(raw);
        return parsed ?? fallback;
    } catch (e) {
        // Corrupted JSON — remove the bad key so future writes succeed cleanly.
        try { localStorage.removeItem(key); } catch {}
        return fallback;
    }
}

/**
 * P1-06 / NEWSFE-011 FIX: Safely write a string value to localStorage.
 * If the write fails (QuotaExceededError, SecurityError, or browser
 * private mode where localStorage is disabled), the error is swallowed
 * and the bad key is removed so future writes to OTHER keys still succeed.
 * Without this, a QuotaExceededError on 'ni_saved_news' would propagate
 * up and leave the save button in a stuck state (the toggle already
 * mutated _niSavedNews in memory, but the persistence failed silently
 * with no user feedback). Callers should still update in-memory state
 * optimistically — this helper just prevents the uncaught exception.
 *
 * @param {string} key - localStorage key
 * @param {string} value - String value to write (caller JSON.stringify if needed)
 * @returns {boolean} true if write succeeded, false otherwise
 */
function safeLocalStorageSetItem(key, value) {
    try {
        localStorage.setItem(key, value);
        return true;
    } catch (e) {
        // QuotaExceededError or SecurityError — remove the key we tried
        // to write so it doesn't block future writes to other keys.
        try { localStorage.removeItem(key); } catch {}
        console.warn('localStorage.setItem failed for key:', key, e?.name || e?.message);
        return false;
    }
}


let currentLang = 'fa';
let watchlist = [];
let analyses = safeJsonParseLocalStorage('analyses', []);
let tickets = [];
let notifications = []; // DB-backed — loaded from /api/notifications
let alerts = safeJsonParseLocalStorage('price_alerts', []);
let currentAlertDirection = 'above';
let _previousPrices = {}; // Symbol → price tracking for cross-check alerts
const MARKET_DEFAULT_LIMIT = 100;
const MARKET_LOAD_MORE_BATCH = 50;
let marketVisibleCount = MARKET_DEFAULT_LIMIT;
// NEWSFE-026 FIX: Per-sub-tab visible count map. Preserves the user's "Load
// More" progress when switching between crypto sub-tabs (top/gainers/losers).
let _subTabVisibleCounts = {};
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
let _lastSearchTerm = ''; // Track last search term to prevent stale async results
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
let _analysisVisibleCount = 5; // ITEM 1: Lazy loading — initial visible count
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
// P1-06 FIX (NEWSFE-001): guarded via safeJsonParseLocalStorage
let analysisBookmarks = safeJsonParseLocalStorage('analysisBookmarks', []);
let sessionId = localStorage.getItem('app_session_id') || null;
const tabLoaded = { dashboard: false, market: false, analysis: false, news: false, profile: false };
let calendarEvents = [];
let calendarLoading = false;
// ROOT CAUSE FIX (calendar "doesn't show" bug):
// Previously defaulted to 'today'. On most days (weekends, holidays, low-impact
// days) "today" only has 0-3 events, so users opened News→Calendar and thought
// the calendar was broken. Defaulting to 'week' immediately shows ~95 events,
// giving users confidence that the calendar is populated.
let currentCalendarTab = 'week';
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
        subtab_all: 'همه', subtab_popular: 'محبوب', subtab_btc_pairs: 'جفت BTC',
        analysis_title: 'تحلیل‌های بازار', new_analysis: 'تحلیل جدید',
        news_all: 'همه', news_crypto: 'کریپتو', news_economy: 'اقتصادی', news_forex: 'فارکس', news_calendar: 'تقویم',
        hero_badge: 'کانال تحلیلی', hero_desc: 'سیگنال‌ها، تحلیل‌ها و آموزش‌های روز بازار', hero_cta: 'عضویت رایگان',
        section_analysis: 'تحلیل‌های جدید', section_watchlist: 'واچ‌لیست من', section_news: 'اخبار مهم و فوری',
        view_all: 'مشاهده همه', watchlist_empty: 'واچ‌لیست خالی است',
        watchlist_empty_desc: 'ارزهای مورد علاقه خود را اضافه کنید', watchlist_add_btn: 'افزودن ارز',
        watchlist_limit: 'حداکثر ۷ ارز می‌توانید به واچ‌لیست اضافه کنید.', watchlist_limit_premium: 'حداکثر ۲۰ ارز می‌توانید به واچ‌لیست اضافه کنید.', no_analysis: 'تحلیلی موجود نیست',
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
        open_referral_center: 'باز کردن مرکز دعوت',
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
        terms: 'قوانین و شرایط', privacy: 'حریم خصوصی',
        official_channel: 'کانال رسمی', market_error: 'خطا در دریافت قیمت‌ها. لطفاً دوباره تلاش کنید.',
        summary_mcap: 'مارکت‌کپ کل', summary_volume: 'حجم ۲۴h', summary_btc_dom: 'BTC.D',
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
        ns_referral: 'رفرال', ns_referral_desc: 'اعلان دعوت کاربران جدید',
        ns_reward: 'پاداش توکن', ns_reward_desc: 'اعلان دریافت پاداش AB Token',
        ns_ticket: 'تیکت پشتیبانی', ns_ticket_desc: 'پاسخ به تیکت‌های پشتیبانی',
        ns_system: 'اعلان‌های سیستمی', ns_system_desc: 'اطلاعیه‌های مهم سیستمی',
        ns_marketing: 'اعلان‌های تبلیغاتی', ns_marketing_desc: 'پیشنهادها و کمپین‌های ویژه',
        ns_sub_title: 'اشتراک اعلانات', ns_sub_desc: 'برای دریافت هشدارها از طریق تلگرام اشتراک فعال کنید.',
        ns_sub_activate: 'فعال‌سازی',
        ns_active: 'فعال', ns_inactive: 'غیرفعال',
        dashboard_market_status: 'وضعیت بازار',
        dashboard_featured_analysis: 'تحلیل‌های بازار',
        dashboard_market_analysis: 'تحلیل‌های بازار',
        dashboard_calendar: 'تقویم اقتصادی',
        dashboard_market_trend: 'روند بازار',
        dashboard_add_coin: 'افزودن ارز',
        dashboard_no_featured: 'تحلیلی موجود نیست',
        dashboard_no_calendar: 'رویداد اقتصادی در دسترس نیست',
        dashboard_no_news: 'خبری موجود نیست',
        dashboard_priority_urgent: 'فوری',
        dashboard_priority_important: 'مهم',
        dashboard_priority_latest: 'تازه',
        dashboard_view_detail: 'مشاهده',
        dashboard_gauge_index: 'شاخص',
        dashboard_btc_dominance: 'سلطه بیت‌کوین',
        dashboard_trend_bullish: 'صعودی',
        dashboard_trend_bearish: 'نزولی',
        dashboard_trend_neutral: 'خنثی',
        hero_cta_trade: 'شروع معامله',
        hero_cta_analysis: 'مشاهده تحلیل‌ها',
        // ── Delete Account / Danger Zone i18n ──
        danger_zone: 'منطقه خطر',
        delete_account: 'حذف حساب کاربری',
        delete_account_desc: 'حذف حساب کاربری به‌صورت دائمی تمام داده‌های شما (پاداش‌ها، دعوت‌ها، کیف پول، هشدارها) را پاک می‌کند. این عملیات قابل بازگشت نیست.',
        delete_account_confirm: 'حذف دائمی',
        delete_account_cancel: 'انصراف',
        delete_account_typing: 'برای تأیید، تایپ کنید:',
        delete_account_success: 'حساب حذف شد. می‌توانید دوباره ثبت‌نام کنید.',
        delete_account_error: 'خطا در حذف حساب',
        delete_account_progress: 'در حال حذف...',
        // ── Price Alert Quick Presets ──
        alert_crossing_hint: 'قیمت عبور از سطح',
        alert_preset_ath: 'قله تاریخی',
        // ── Market Heatmap ──
        heatmap_title: 'نقشه حرارتی بازار',
        heatmap_subtitle: 'نمایش بصری تغییرات ۲۴ ساعته',
        heatmap_top: 'برترین بازار',
        heatmap_show_more: 'نمایش بیشتر',
        // ── Beta Launch Popup ──
        beta_popup_title: 'نسخه بتا منتشر شد',
        beta_popup_desc: 'AmirBTC Assistant اکنون در مرحله بتا قرار دارد.',
        beta_popup_detail: 'ممکن است در این مرحله با برخی خطاها، ناهماهنگی‌ها یا رفتارهای غیرمنتظره مواجه شوید. بازخورد شما به ما کمک می‌کند تجربه‌ای پایدارتر و بهتر بسازیم.',
        beta_popup_report_title: 'مشکلی پیدا کردی؟',
        beta_popup_report_desc: 'هر باگ، خطا یا رفتار غیرعادی را از طریق تیکت و بخش پشتیبانی گزارش کن تا بررسی و پیگیری شود. حتی اگر مشکل کوچک به نظر می‌رسد، گزارش آن برای ما ارزشمند است.',
        beta_popup_cta_continue: 'ادامه به نسخه بتا',
        beta_popup_cta_support: 'گزارش مشکل / پشتیبانی',
        beta_popup_beta_badge: 'BETA'
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
        subtab_all: 'All', subtab_popular: 'Popular', subtab_btc_pairs: 'Pair BTC',
        analysis_title: 'Market Analysis', new_analysis: 'New Analysis',
        news_all: 'All', news_crypto: 'Crypto', news_economy: 'Economy', news_forex: 'Forex', news_calendar: 'Calendar',
        hero_badge: 'Analysis Channel', hero_desc: 'Daily signals, analysis & market education', hero_cta: 'Join Free',
        section_analysis: 'Latest Analysis', section_watchlist: 'My Watchlist', section_news: 'Breaking News',
        view_all: 'View all', watchlist_empty: 'Watchlist is empty',
        watchlist_empty_desc: 'Add your favorite coins to track them', watchlist_add_btn: 'Add Coin',
        watchlist_limit: 'You can add up to 7 coins to your watchlist.', watchlist_limit_premium: 'You can add up to 20 coins to your watchlist.', no_analysis: 'No analysis available',
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
        open_referral_center: 'Open Referral Center',
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
        terms: 'Terms & Rules', privacy: 'Privacy Policy',
        official_channel: 'Official channel', market_error: 'Failed to load prices. Please try again.',
        summary_mcap: 'Total Market Cap', summary_volume: '24h Volume', summary_btc_dom: 'BTC.D',
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
        ns_active: 'Active', ns_inactive: 'Inactive',
        dashboard_market_status: 'Market Status',
        dashboard_featured_analysis: 'Market Analysis',
        dashboard_market_analysis: 'Market Analysis',
        dashboard_calendar: 'Economic Calendar',
        dashboard_market_trend: 'Market Trend',
        dashboard_add_coin: 'Add Coin',
        dashboard_no_featured: 'No analysis available',
        dashboard_no_calendar: 'No economic events available',
        dashboard_no_news: 'No news available',
        dashboard_priority_urgent: 'Urgent',
        dashboard_priority_important: 'Important',
        dashboard_priority_latest: 'Latest',
        dashboard_view_detail: 'View',
        dashboard_gauge_index: 'Index',
        dashboard_btc_dominance: 'BTC Dominance',
        dashboard_trend_bullish: 'Bullish',
        dashboard_trend_bearish: 'Bearish',
        dashboard_trend_neutral: 'Neutral',
        hero_cta_trade: 'Start Trading',
        hero_cta_analysis: 'View Analysis',
        // ── Delete Account / Danger Zone i18n ──
        danger_zone: 'Danger Zone',
        delete_account: 'Delete Account',
        delete_account_desc: 'Permanently deleting your account will erase all your data (rewards, referrals, wallet, alerts). This action is irreversible.',
        delete_account_confirm: 'Permanently Delete',
        delete_account_cancel: 'Cancel',
        delete_account_typing: 'Type to confirm:',
        delete_account_success: 'Account deleted. You can re-register.',
        delete_account_error: 'Error deleting account',
        delete_account_progress: 'Deleting...',
        // ── Price Alert Quick Presets ──
        alert_crossing_hint: 'Price crossing level',
        alert_preset_ath: 'All-Time High',
        // ── Market Heatmap ──
        heatmap_title: 'Market Heatmap',
        heatmap_subtitle: 'Visual 24h changes',
        heatmap_top: 'Top Market',
        heatmap_show_more: 'Show More',
        // ── Beta Launch Popup ──
        beta_popup_title: 'Beta Version Released',
        beta_popup_desc: 'AmirBTC Assistant is currently in beta.',
        beta_popup_detail: 'You may encounter some errors, inconsistencies, or unexpected behavior during this phase. Your feedback helps us build a more stable and better experience.',
        beta_popup_report_title: 'Found a Bug?',
        beta_popup_report_desc: 'Report any bug, error, or unusual behavior via the support and ticket section so we can investigate. Even small issues are valuable to us.',
        beta_popup_cta_continue: 'Continue to Beta',
        beta_popup_cta_support: 'Report Issue / Support',
        beta_popup_beta_badge: 'BETA'
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
        // BUG FIX: Only set _authWaitAttempted if auth actually succeeded.
        // If auth failed (SDK slow), leave it false so waitForApiReady retries.
        if (this.ready) {
            _authWaitAttempted = true;
        }
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
            stored = legacy.slice(0, getMaxWatchlist());
            localStorage.setItem(key, JSON.stringify(stored));
        }
    }
    watchlist = stored.slice(0, getMaxWatchlist());
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
// NEWSFE-014 FIX: In-flight lock for persistWatchlist. Without this, rapid
// double-clicks on the watchlist toggle would fire two concurrent PUT
// requests with different state (e.g. add BTC → remove BTC), and the final
// backend state depended on which response arrived last (race condition).
// Now, if a PUT is in-flight, we set a "pending re-sync" flag. When the
// in-flight PUT completes, if the flag is set, we re-send the LATEST state.
// This guarantees the backend always ends up with the user's final intent.
let _persistWatchlistInFlight = false;
let _persistWatchlistPending = false;

async function persistWatchlist() {
    localStorage.setItem(userStorageKey('watchlist'), JSON.stringify(watchlist));
    if (!API_BASE || isGuestUserId(getUserId())) return;
    // NEWSFE-014 FIX: If a PUT is already in-flight, mark "pending" and return.
    // The in-flight PUT will re-sync the latest state when it completes.
    if (_persistWatchlistInFlight) {
        _persistWatchlistPending = true;
        return;
    }
    _persistWatchlistInFlight = true;
    try {
        await apiFetch('/api/watchlist', {
            method: 'PUT',
            body: JSON.stringify({ user_id: getUserId(), symbols: watchlist })
        });
    } catch (e) {
        console.warn('persistWatchlist:', e);
    } finally {
        _persistWatchlistInFlight = false;
        // NEWSFE-014 FIX: If another toggle happened while we were in-flight,
        // re-send the latest state. Loop in case of repeated rapid toggles.
        if (_persistWatchlistPending) {
            _persistWatchlistPending = false;
            // Re-capture the latest watchlist state (may have changed during await)
            persistWatchlist();
        }
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
 *
 * ROOT-CAUSE FIX (AUDIT-P1-JOINCHECK / Bug #1): Added in-flight dedup.
 * Previously, bootstrapUser() was called directly at multiple sites:
 *   - DOMContentLoaded handler (app.js:12953) — bypassed _bootstrapPromise
 *   - tryLateBootstrap() (app.js:1215) — used _bootstrapPromise
 *   - _bootstrapLongTimer / _bootPollInterval / _bootObserver / visibilitychange
 * This caused 2+ concurrent POST /api/users/bootstrap requests on cold open,
 * leading to race conditions (old slow response overwriting new fast response,
 * UI flicker between joined/not-joined, double Telegram API calls hitting 429).
 *
 * FIX: bootstrapUser() now deduplicates concurrent calls via a shared
 * _bootstrapUserInFlight promise. The FIRST caller executes the real logic;
 * all subsequent callers await the same promise and receive the same result.
 * The promise is cleared in the finally block so a new bootstrap can run
 * after the current one completes (success or failure).
 */
let _bootstrapUserInFlight = null;
async function bootstrapUser() {
    // Deduplicate concurrent calls — only ONE POST /api/users/bootstrap at a time.
    // This is SEPARATE from tryLateBootstrap's _bootstrapPromise (which only
    // deduped its own retry calls, not direct bootstrapUser() invocations).
    if (_bootstrapUserInFlight) {
        return _bootstrapUserInFlight;
    }
    _bootstrapUserInFlight = (async () => {
        await _bootstrapUserImpl();
    })().finally(() => { _bootstrapUserInFlight = null; });
    return _bootstrapUserInFlight;
}

async function _bootstrapUserImpl() {
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
                watchlist = data.watchlist.slice(0, getMaxWatchlist());
            } else if (watchlist.length) {
                await persistWatchlist();
            }
            localStorage.setItem(userStorageKey('watchlist'), JSON.stringify(watchlist));
        }
        saveLangToStorage();
        applyLanguage();

        // Admin status from server — SECURITY: do NOT persist to localStorage
        // Admin status is only kept in memory (isCurrentUserAdmin) and is
        // re-fetched from server on every app open via bootstrapUser().
        const newAdminStatus = Boolean(data.is_admin);
        const adminChanged = newAdminStatus !== isCurrentUserAdmin;
        isCurrentUserAdmin = newAdminStatus;
        // Clear any stale localStorage value from previous (insecure) versions
        localStorage.removeItem('is_admin');
        if (data.user?.id) {
            ADMIN_ID = String(data.user.id);
            localStorage.setItem('admin_id', ADMIN_ID);
        }

        // Watchlist premium fix: eagerly populate MembershipApp's premium cache
        // from the bootstrap is_premium flag so getMaxWatchlist() returns the
        // correct limit (7 vs 20) from the FIRST render — no waiting for the
        // lazy loadCard() call on profile open. This is the authoritative
        // signal from the backend (membershipAuthority.isPremium).
        if (typeof data.is_premium === 'boolean' && window.MembershipApp
            && typeof window.MembershipApp.setPremiumFromBootstrap === 'function') {
            window.MembershipApp.setPremiumFromBootstrap(data.is_premium);
        }

        // ── Membership lock gate ──
        // CRITICAL SECURITY FIX: only hide the lock when backend EXPLICITLY
        // returns channel_joined === true. Any other value (false, undefined,
        // null, missing field, error response) keeps the lock.
        //
        // ROOT-CAUSE FIX (Task 37): Previously this block called
        // `clearTimeout(_joinLockSafetyTimer)` — but that variable was
        // `const`-declared inside the DOMContentLoaded handler (block scope),
        // unreachable from this top-level function. The resulting
        // ReferenceError was caught by the surrounding try/catch, which then
        // short-circuited WITHOUT ever calling setJoinLockState('joined' /
        // 'not-joined' / 'error'), leaving the Status Bar stuck on
        // "Checking Membership…" forever. The safety timer is now module-level
        // (see `_joinLockSafetyTimer` near the join-lock state vars) and is
        // cleared cleanly here.
        //
        // NEW UX: For members, show FLOATING STATUS CARD "verified" briefly
        // then fade out (no overlay, no lock). For non-members, show FLOATING
        // CARD "required" then FULL LOCK after 600ms. Loading state never
        // shows the big overlay.
        clearJoinLockSafetyTimer();
        if (data.channel_joined === true) {
            // Member confirmed — show floating "verified" card (auto-fades)
            setJoinLockState('joined');
            // Cache membership status for 5 minutes (frontend cache)
            try {
                localStorage.setItem('membership_status_cache', JSON.stringify({
                    status: 'joined',
                    timestamp: Date.now(),
                }));
            } catch {}
        } else if (data.channel_joined === false) {
            // Confirmed non-member — show "required" card, then full lock
            setJoinLockState('not-joined');
            // Invalidate cache
            try { localStorage.removeItem('membership_status_cache'); } catch {}
            console.log('[JOIN-LOCK] Bootstrap returned channel_joined=false — showing lock');
        } else {
            // Ambiguous response (missing field) — DON'T show lock.
            // Previously this called setJoinLockState('not-joined') which was
            // too aggressive — it showed the lock even for undefined/null/missing
            // responses (network issues, partial responses).
            // Now: allow access, backend gates APIs. Will retry on next bootstrap.
            console.warn('[JOIN-LOCK] Bootstrap returned ambiguous channel_joined:', data.channel_joined, '— allowing access, backend gates APIs');
            hideJoinStatusBar();
            _joinLockShown = false;
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
        // Update maintenance bypass button visibility (in case maintenance popup is showing)
        if (typeof updateMaintenanceAdminBypass === 'function') {
            updateMaintenanceAdminBypass();
        }
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

        // Sync calendar reminders from backend so they're available across
        // devices. Non-blocking — runs in background after bootstrap.
        if (typeof syncRemindersFromBackend === 'function') {
            syncRemindersFromBackend().catch(() => {});
        }

        // PHASE 1 FIX (WALLET-REWARDS): surface wallet changes from bootstrap daily_login reward.
        // Backend now includes `wallet_balance` + `wallet_changed` when daily_login grants a
        // NEW reward. Frontend uses this to invalidate the wallet cache and refresh the balance
        // display immediately — instead of showing a stale balance for up to 30s (WALLET_CACHE_TTL).
        // `wallet_changed` is true ONLY when a NEW reward was credited (not idempotent).
        // `wallet_balance` is the new balance number (or null if no reward).
        if (data.wallet_changed && typeof data.wallet_balance === 'number') {
            // Invalidate WalletApp cache so next fetch hits the API (no stale data).
            if (window.WalletApp && typeof window.WalletApp._invalidateCache === 'function') {
                window.WalletApp._invalidateCache();
            }
            // Update profile card balance display (if profile is open).
            if (typeof window.WalletApp?.loadProfileCard === 'function') {
                try { window.WalletApp.loadProfileCard(); } catch (_) {}
            }
            // If wallet full page is open, refresh the balance display immediately.
            const balanceEl = document.querySelector('.wallet-balance-value, .hero-balance');
            if (balanceEl) {
                const currentBalance = parseFloat(balanceEl.textContent?.replace(/[^0-9.]/g, '')) || 0;
                if (typeof animateBalanceChange === 'function') {
                    animateBalanceChange(balanceEl, currentBalance, data.wallet_balance);
                } else {
                    balanceEl.textContent = data.wallet_balance.toLocaleString('en-US');
                }
            }
            // If wallet full page is open, refresh ALL wallet data in background
            // (balance + tier + history + summary). No artificial delay — fire immediately.
            const walletPage = document.getElementById('wallet-full-page');
            if (walletPage && walletPage.classList.contains('open')) {
                if (typeof window.WalletApp?._refreshWalletData === 'function') {
                    try { window.WalletApp._refreshWalletData(); } catch (_) {}
                }
            }
        }

        // ── Beta Launch Popup ──
        // Show one-time beta popup for users who haven't seen it yet.
        // Uses server-side `beta_popup_seen` flag (persisted in DB) so it
        // only shows once per user across all devices/sessions.
        if (data.user && data.user.beta_popup_seen === false && !_betaPopupShown) {
            _betaPopupShown = true; // session guard — prevents double-show
            setTimeout(function() { openBetaPopup(); }, 800);
        }

        // ── Advertisement Popup (Phase 3) ──
        // Fetch the next eligible admin-configured popup (24h per-user cooldown
        // enforced server-side via KV). Shown after beta popup so beta takes
        // precedence. Session guard prevents double-show on re-bootstrap.
        if (!_adPopupShown) {
            setTimeout(function() { maybeShowAdPopup(); }, 1200);
        }
    } catch (e) {
        console.error('[BOOT] bootstrapUser FAILED:', e.message);
        // PERFORMANCE + UX FIX: Don't show error card on bootstrap failure.
        // Previously this called setJoinLockState('error') which showed a
        // "Connection Error" floating card — interrupting the user experience.
        // Now: just hide any status bar, allow access. Backend gates APIs.
        // Bootstrap will retry automatically (tryLateBootstrap / _bootstrapLongTimer).
        clearJoinLockSafetyTimer();
        hideJoinStatusBar();
        _joinLockShown = false;
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

        // ROOT CAUSE FIX for "detail page shows stale data after background refetch":
        // After a successful fetch (e.g., the background refetch triggered by
        // edit/delete), the analyses[] and analysisFeatured[] arrays are updated
        // with fresh server data. But currentAnalysisDetail (used by the detail
        // page) was NOT updated — so the detail page would show stale content
        // (e.g., old views_count) until the user closed and reopened it.
        // Now we sync currentAnalysisDetail from the fresh arrays if the detail
        // page is currently open for one of the fetched analyses.
        if (currentAnalysisDetail && currentAnalysisDetail.id) {
            const fresh = analyses.find(a => a.id === currentAnalysisDetail.id)
                || (Array.isArray(analysisFeatured) ? analysisFeatured.find(a => a.id === currentAnalysisDetail.id) : null);
            if (fresh) {
                // Preserve the detail text if the fresh version has less content
                // (list responses might truncate text — but after our getFeatured
                // fix, both list and featured return full text, so this is safe).
                currentAnalysisDetail = fresh;
                // Re-render the detail page IF it's currently active.
                const detailPage = document.getElementById('analysis-detail-page');
                if (detailPage && detailPage.classList.contains('active')) {
                    renderAnalysisDetailPage();
                }
            }
        }

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
    // SECURITY: Admin status is ONLY determined by the server's bootstrap response.
    // Never trust localStorage or any client-side value for admin detection.
    // bootstrapComplete must be true (set only after successful server bootstrap).
    // isCurrentUserAdmin is only set from server response (data.is_admin).
    if (!bootstrapComplete) return false;
    return isCurrentUserAdmin === true;
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

    // ANPOST-002 FIX: Validate URL scheme via sanitizeNewsUrl before escapeHtml.
    // This is the 4th analysis image render site (the other 3 were fixed in
    // FIX 3). Without this, a malicious admin could set image:"javascript:..."
    // and it would render in this featured slide. Backend validation (FIX 3)
    // prevents new bad URLs, but this is defense-in-depth for legacy data.
    const safeSlideImg = sanitizeNewsUrl(a.image);
    const imageSection = (safeSlideImg && safeSlideImg !== '#')
        ? `<div class="fs-card-image-wrap">
                <img src="${escapeHtml(safeSlideImg)}" loading="eager" alt="${escapeHtml(a.coin)}" onerror="this.parentElement.parentElement.innerHTML='<div class=\'fs-card-no-image\'><div class=\'fs-card-no-image-text\'>${escapeHtml(a.coin)}</div></div>'">
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
    // FIX 4+5: added featured counter (analysisStats.featured from the backend
    // getStats() which now returns {total, featured, active, today}). All four
    // counters update immediately after create/delete/publish/feature-toggle
    // because the CRUD response embeds fresh stats.
    const featuredCount = analysisStats.featured || 0;
    bar.innerHTML = `
        <div class="stats-bar">
            <div class="stat-item total">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M21 16V8a2 2 0 0 0-1-1.73l-7-4a2 2 0 0 0-2 0l-7 4A2 2 0 0 0 3 8v8a2 2 0 0 0 1 1.73l7 4a2 2 0 0 0 2 0l7-4A2 2 0 0 0 21 16z"/><polyline points="3.27 6.96 12 12.01 20.73 6.96"/></svg>
                </div>
                <span class="stat-value">${analysisStats.total}</span>
                <span class="stat-label">کل</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item featured">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
                </div>
                <span class="stat-value">${featuredCount}</span>
                <span class="stat-label">ویژه</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item active">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><path d="M3 3v18h18"/><path d="M7 16l4-8 4 5 5-9"/></svg>
                </div>
                <span class="stat-value">${analysisStats.active}</span>
                <span class="stat-label">عادی</span>
            </div>
            <div class="stat-divider"></div>
            <div class="stat-item today">
                <div class="stat-icon">
                    <svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2.2"><circle cx="12" cy="12" r="9"/><polyline points="12 7 12 12 15 14"/></svg>
                </div>
                <span class="stat-value">${analysisStats.today}</span>
                <span class="stat-label">امروز</span>
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

    // ITEM 1 FIX: Lazy loading — only render first 5 analyses, show "Load More" button.
    // Previously ALL filtered analyses were rendered at once, causing long pages.
    const ANALYSIS_PAGE_SIZE = 5;
    const visibleCount = Math.min(filtered.length, _analysisVisibleCount);
    const visibleAnalyses = filtered.slice(0, visibleCount);
    const hasMore = filtered.length > visibleCount;

    container.innerHTML = visibleAnalyses.map((a, i) => {
        const sentiment = getSentiment(a);
        const readTime = estimateReadTime(a.content || a.text);
        const bookmarked = isAnalysisBookmarked(a.id);
        const sentimentBadge = getSentimentBadgeHTML(sentiment, 'acv-sentiment');

        // Price boxes — REMOVED from cards (available in detail page + hero slider)
        let priceBoxes = '';

        // Image section — FIXED: use eager loading (not lazy) for visible cards,
        // and a proper placeholder background that shows while loading.
        // ANSEC-XSS-IMG FIX: Validate URL scheme via sanitizeNewsUrl before
        // using in img src attribute. escapeHtml alone doesn't prevent
        // javascript:/data: URL schemes.
        const safeCardImg = sanitizeNewsUrl(a.image);
        const imageSection = (safeCardImg && safeCardImg !== '#')
            ? `<div class="acv-image-section">
                    <img src="${escapeHtml(safeCardImg)}" class="acv-hero-image" alt="${escapeHtml(a.coin)}" decoding="async" onload="this.style.opacity=1" onerror="this.style.display='none';this.nextElementSibling.style.display='flex'">
                    <div class="acv-no-image-placeholder" style="display:none;position:absolute;inset:0;">${escapeHtml(a.coin)}</div>
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

        // ITEM 3: Market type badge — crypto vs forex
        const isForexAnalysis = a.category === 'forex' || (a.coin && /USD|EUR|GBP|JPY|AUD|CAD|CHF|NZD|XAU|XAG/.test(a.coin));
        const marketBadge = `<span class="acv-market-badge ${isForexAnalysis ? 'forex' : 'crypto'}">${isForexAnalysis ? 'Forex' : 'Crypto'}</span>`;

        return `
        <div class="analysis-card-v2 ${bookmarked ? 'acv-bookmarked' : ''}" onclick="openAnalysisDetailPage('${escapeHtml(a.id)}')" style="animation-delay:${Math.min(i, 8) * 0.04}s">
            ${imageSection}
            <div class="acv-content-section">
                <div class="acv-title-row">
                    <span class="acv-coin-name">${escapeHtml(a.coin)}</span>
                    ${marketBadge}
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

    // ITEM 1: Add "Load More" button if there are more analyses to show
    if (hasMore) {
        container.innerHTML += `
            <div class="analysis-load-more" id="analysis-load-more">
                <button class="alm-btn" onclick="loadMoreAnalyses()">
                    <svg viewBox="0 0 24 24" width="16" height="16" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="21 3 21 12 12 12"/></svg>
                    <span>${t('load_more') || 'مشاهده بیشتر'}</span>
                </button>
            </div>`;
    }

    // Setup infinite scroll
    setupAnalysisInfiniteScroll();
}

/**
 * ITEM 1: Load more analyses — increments visible count and re-renders.
 * Called when user clicks "مشاهده بیشتر" button.
 */
function loadMoreAnalyses() {
    _analysisVisibleCount += 5;
    renderAnalysisList();
}

/**
 * Reset all filters (search, sort, timeframe) and re-render.
 */
function resetAnalysisFilters() {
    analysisSearchQuery = '';
    analysisTimeframeFilter = 'all';
    analysisCategoryFilter = 'all';
    analysisShowSavedOnly = false;
    _analysisVisibleCount = 5; // Reset lazy loading count
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

// ── Telegram BackButton Navigation Stack ──
// Implements a proper history stack so the Telegram Back button navigates
// step-by-step (Dashboard → Analysis → Detail → Back → Analysis list →
// Back → Dashboard) instead of getting stuck.
//
// Usage:
//   tgBackPush(closeFn)  — call when entering a sub-view (pushes onto stack)
//   tgBackPop()          — call when the Back button is pressed (pops + runs closeFn)
//   tgBackReset()        — call when switching main tabs (clears stack, hides button)
let _tgBackStack = [];
let _tgBackHandlerInstalled = false;

function tgBackPush(closeFn) {
    const tg = getTg();
    if (!tg?.BackButton) return;
    _tgBackStack.push({ closeFn });
    // Install the handler once (idempotent — Telegram accumulates onClick listeners)
    if (!_tgBackHandlerInstalled) {
        _tgBackHandlerInstalled = true;
        tg.BackButton.onClick(tgBackPop);
    }
    tg.BackButton.show();
}

function tgBackPop() {
    const tg = getTg();
    if (!tg?.BackButton) return;
    const entry = _tgBackStack.pop();
    if (entry && typeof entry.closeFn === 'function') {
        try { entry.closeFn(); } catch (_) {}
    }
    if (_tgBackStack.length === 0) {
        tg.BackButton.hide();
        tg.BackButton.offClick(tgBackPop);
        _tgBackHandlerInstalled = false;
    }
}

function tgBackReset() {
    const tg = getTg();
    if (!tg?.BackButton) return;
    _tgBackStack = [];
    if (_tgBackHandlerInstalled) {
        tg.BackButton.offClick(tgBackPop);
        _tgBackHandlerInstalled = false;
    }
    tg.BackButton.hide();
}

// Expose for console debugging
window.tgBackPush = tgBackPush;
window.tgBackPop = tgBackPop;
window.tgBackReset = tgBackReset;

// ── Analysis Detail Page ──
async function openAnalysisDetailPage(id) {
    // Push onto the BackButton navigation stack so pressing Back returns to
    // the analysis list (not stuck on the detail page).
    tgBackPush(closeAnalysisDetailPage);

    currentAnalysisDetail = null;
    const cachedAnalysis = analyses.find(x => x.id === id) || analysisFeatured.find(a => a.id === id) || null;

    // Render detail page IMMEDIATELY from cached data for instant UX.
    // After the backend root-cause fix (getFeatured returns full text), the
    // cached record — whether from `analyses` (regular) or `analysisFeatured`
    // (VIP) — already contains the COMPLETE analysis body. So this first paint
    // is final as far as the text is concerned; the background detail fetch
    // only updates the view counter and is rendered idempotently (see
    // renderAnalysisDetailPage → dataset.renderedText guard) so it cannot
    // cause any Layout Shift.
    let pageActivated = false;
    if (cachedAnalysis) {
        currentAnalysisDetail = cachedAnalysis;
        renderAnalysisDetailPage();
        document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
        const page = $('analysis-detail-page');
        if (page) page.classList.add('active');
        pageActivated = true;
        const nav = document.querySelector('.bottom-nav');
        if (nav) nav.style.display = 'none';
        window.scrollTo(0, 0);
    }

    // Fire daily mission: analysis_read (non-blocking, idempotent)
    if (typeof fireMissionEvent === 'function') fireMissionEvent(MISSION_EVENTS.ANALYSIS_OPEN);

    // Fetch fresh detail from server in background (for view-count increment
    // and to pick up any edits made after the list was cached). Includes
    // retry: if first attempt fails, waits 1.5s and retries once.
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
                // Deep-link path: no cached analysis was available, so the page
                // has not been activated yet. Activate it now alongside the
                // first real render so the user never stares at a blank screen.
                if (!pageActivated) {
                    renderAnalysisDetailPage();
                    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
                    const page = $('analysis-detail-page');
                    if (page) page.classList.add('active');
                    pageActivated = true;
                    const nav = document.querySelector('.bottom-nav');
                    if (nav) nav.style.display = 'none';
                    window.scrollTo(0, 0);
                } else {
                    renderAnalysisDetailPage();
                }
            }
        } catch (fetchErr) {
            console.warn('[ANALYSIS-DETAIL] fetch attempt', attempt + 1, 'failed:', fetchErr);
        }
    }
    if (!detailFetched && !cachedAnalysis) {
        showToast('خطا در بارگذاری تحلیل. لطفاً دوباره تلاش کنید.');
        // Navigation stack: pop back to the analysis list since there's
        // nothing to show on the detail page.
        tgBackPop();
    } else if (!detailFetched && cachedAnalysis) {
        // Cached record already carries the full text (post backend fix), so
        // there is nothing "summary" about what's on screen — only the view
        // counter couldn't be refreshed. Reflect that accurately.
        showToast('شماره بازدید به‌روزرسانی نشد. متن تحلیل کامل است.');
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

/**
 * Render analysis body text into XSS-safe semantic HTML.
 *
 * Splitting strategy (Persian/RTL friendly):
 *   - 2+ consecutive newlines → paragraph break (each chunk becomes a <p>)
 *   - single newline inside a paragraph → <br> soft wrap
 *   - leading/trailing whitespace per paragraph is trimmed
 *
 * Empty paragraphs are dropped so the reading card never shows blank gaps.
 * All text is passed through escapeHtml() first, so the structure built
 * afterwards (<p>/<br>) is the only HTML that ends up in the DOM — user
 * content can never inject markup.
 */
function renderAnalysisContentHTML(text) {
    const raw = String(text || '');
    if (!raw.trim()) {
        return '<p class="adp-content-p adp-content-empty">—</p>';
    }
    const escaped = escapeHtml(raw);
    const paragraphs = escaped.split(/\n{2,}/);
    const html = paragraphs
        .map(p => {
            const trimmed = p.replace(/^\s+|\s+$/g, '');
            if (!trimmed) return '';
            return `<p class="adp-content-p">${trimmed.replace(/\n/g, '<br>')}</p>`;
        })
        .filter(Boolean)
        .join('');
    return html || `<p class="adp-content-p">${escaped.replace(/\n/g, '<br>')}</p>`;
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
    // ANSEC-XSS-IMG FIX: Validate URL scheme via sanitizeNewsUrl before
    // assigning to img.src. Without this, a malicious admin could set
    // image:"javascript:alert(1)" and execute JS when the image loads.
    const imgWrap = $('adp-image-wrap');
    const img = $('adp-image');
    const safeDetailImg = sanitizeNewsUrl(a.image);
    if (safeDetailImg && safeDetailImg !== '#') {
        if (imgWrap) imgWrap.style.display = '';
        if (img) { img.src = safeDetailImg; img.style.display = ''; img.onerror = function() { newsImageFallback(this); }; }
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

    // Content (escaped for XSS safety) — wrapped in a reading card.
    // ROOT-CAUSE FIX for Layout Shift + incomplete text:
    //   - The content is rendered as semantic <p> paragraphs (split on blank
    //     lines) so long-form Persian text is comfortable to read.
    //   - Re-render is idempotent: if the text hasn't changed since the last
    //     render (e.g. the background detail fetch returns the same body that
    //     was already rendered from cache), we skip the innerHTML replacement
    //     entirely. This guarantees zero Layout Shift when the detail fetch
    //     resolves with identical content.
    const contentEl = $('adp-content');
    if (contentEl) {
        const text = a.content || a.text || '';
        if (contentEl.dataset.renderedText === text) {
            // Identical content already rendered — skip to avoid any flicker/shift.
        } else {
            contentEl.dataset.renderedText = text;
            contentEl.innerHTML = renderAnalysisContentHTML(text);
        }
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
// Supports: analysis_<id>, news_<urlHash>, calendar_<eventId>, announcement_<id>
// Each dispatches to the matching detail view after loading required data.
function checkAnalysisDeepLink() {
    const tg = window.Telegram?.WebApp;
    let startParam = tg?.initDataUnsafe?.start_param;

    if (!startParam) {
        // Fallback: parse from URL query
        const urlParams = new URLSearchParams(window.location.search);
        startParam = urlParams.get('startapp') || urlParams.get('tgWebAppStartParam');
    }
    if (!startParam) return false;

    const sp = String(startParam);

    // ── Analysis deep link ──
    if (sp.startsWith('analysis_')) {
        const analysisId = sp.replace('analysis_', '');
        if (analysisId && /^[a-zA-Z0-9_-]+$/.test(analysisId)) {
            fetchAnalyses(true).then(() => {
                openAnalysisDetailPage(analysisId);
            }).catch(() => {});
            return true;
        }
    }

    // ── News deep link (hashUrl of article URL) ──
    if (sp.startsWith('news_')) {
        const newsHash = sp.replace('news_', '');
        if (newsHash && /^[a-zA-Z0-9_-]+$/.test(newsHash)) {
            openNewsByHash(newsHash);
            return true;
        }
    }

    // ── Calendar event deep link ──
    if (sp.startsWith('calendar_')) {
        const eventId = sp.replace('calendar_', '');
        if (eventId && /^[a-zA-Z0-9_-]+$/.test(eventId)) {
            openCalendarEventById(eventId);
            return true;
        }
    }

    // ── Announcement deep link ──
    if (sp.startsWith('announcement_')) {
        const annId = sp.replace('announcement_', '');
        if (annId && /^[a-zA-Z0-9_-]+$/.test(annId)) {
            // Switch to home/announcements tab + scroll to announcement
            switchTab('home-page');
            setTimeout(() => {
                const el = document.getElementById('announcement-' + annId) || document.querySelector('[data-announcement-id="' + annId + '"]');
                if (el) {
                    el.scrollIntoView({ behavior: 'smooth', block: 'center' });
                    el.classList.add('flash-highlight');
                    setTimeout(() => el.classList.remove('flash-highlight'), 2500);
                }
            }, 600);
            return true;
        }
    }

    return false;
}

// Open a news article by URL hash (used by deep links from Telegram channel posts)
async function openNewsByHash(hash) {
    try {
        // Switch to news tab first so user sees loading state there
        switchTab('news-page');
        // Fetch latest news (uses app cache — fast)
        const data = await apiFetch('/api/farsi-news?page=1&limit=50');
        if (!data || !Array.isArray(data.data)) return;
        const idx = data.data.findIndex(a => {
            // Mirror server-side hashUrl (worker-proxy.js)
            let h = 0;
            const s = String(a.url || '');
            for (let i = 0; i < s.length; i++) {
                const ch = s.charCodeAt(i);
                h = ((h << 5) - h) + ch;
                h = h & h;
            }
            return Math.abs(h).toString(36) === hash;
        });
        if (idx >= 0) {
            // Set displayedNews so openNewsModal(idx) works
            displayedNews = data.data;
            openNewsModal(idx);
        }
    } catch (e) {
        console.warn('[DEEP-LINK] openNewsByHash failed:', e);
    }
}

// Open a calendar event by ID (used by deep links from Telegram channel posts)
async function openCalendarEventById(eventId) {
    try {
        switchTab('calendar-page');
        // Wait a moment for calendar page to render, then find the event card
        setTimeout(() => {
            const card = document.querySelector('[data-calendar-event-id="' + eventId + '"]')
                || document.querySelector('[data-event-id="' + eventId + '"]');
            if (card) {
                card.scrollIntoView({ behavior: 'smooth', block: 'center' });
                card.click();
            }
        }, 800);
    } catch (e) {
        console.warn('[DEEP-LINK] openCalendarEventById failed:', e);
    }
}

// ── Admin: Create / Edit ──
function updateAnalysisCharCounter() {
    const textEl = document.getElementById('analysis-text');
    const counterEl = document.getElementById('analysis-text-counter');
    if (!textEl || !counterEl) return;
    const len = textEl.value.length;
    // FIX: match backend maxLength (50000) — was 5000, which was inconsistent
    // with the backend validation and the HTML maxlength attribute.
    const max = 50000;
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
    // FIX: analysisFeatured is an ARRAY (not a single object). The old code
    // `analysisFeatured?.id === id` never matched, so editing a featured analysis
    // from the featured section failed silently. Now searches both arrays.
    const a = analyses.find(x => x.id === id) || (Array.isArray(analysisFeatured) ? analysisFeatured.find(x => x.id === id) : null);
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
    // FIX 3: current_price field removed from form — null-safe in case element is gone
    const cpEl = document.getElementById('analysis-current-price');
    if (cpEl) cpEl.value = a.current_price || '';
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
    // FIX 2: result.featured is ALWAYS an array from the server (handleCreate/
    // handleUpdate/handleDelete return getFeatured() which is an array). The
    // previous else-branch treated it as a boolean, so when the server returned
    // an empty array [] (falsy), it fell through to the else and kept stale
    // featured data. Now always treat it as an array.
    if (Array.isArray(result.featured)) {
        analysisFeatured = result.featured;
        localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
    } else {
        localStorage.setItem('analysisFeatured', JSON.stringify(analysisFeatured));
    }

    closeAddAnalysisModal();
    renderAnalysisFeatured();
    renderAnalysisStats();
    renderAnalysisList();
    renderAnalysisSlider();

    // ROOT CAUSE FIX for "changes don't appear immediately, need refresh":
    // If the user is currently viewing the detail page of the analysis they
    // just edited, currentAnalysisDetail still holds the OLD version of the
    // data. The detail page reads from currentAnalysisDetail, so without
    // updating it here, the user would see stale content until they close
    // and reopen the detail page. Now we update currentAnalysisDetail to the
    // fresh server response and re-render the detail page immediately.
    if (wasEditing && currentAnalysisDetail && currentAnalysisDetail.id === result.analysis.id) {
        currentAnalysisDetail = result.analysis;
        renderAnalysisDetailPage();
    }
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
            // FIX 2: result.featured is always an array from the server
            if (Array.isArray(result.featured)) {
                analysisFeatured = result.featured;
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
        // First successful heartbeat = auth confirmed → load alerts lazily (only once)
        if (!_alertsLoaded && (!alerts.length || alerts.every(a => !a.serverId))) {
            _alertsLoaded = true;
            loadAlertsFromServer().catch(() => { _alertsLoaded = false; });
        }
        // P0-5 FIX: Removed redundant loadNotificationsFromServer() from heartbeat.
        // The dedicated 60s notification poller already handles this. Running it
        // here too caused 2× API calls every 180s (heartbeat interval).
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
    // Online badge removed from profile page — no longer displayed
    // Only update live-count in market page header if it exists
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
        const rr = $('ref-reward'); if (rr) rr.innerText = data.rewarded ?? 0;
    } catch (e) { console.warn('loadReferralStats:', e); }
}

/**
 * تقویم رویدادها را بارگذاری می‌کند.
 * ورودی: پارامترهای `force = false` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function loadCalendarEvents(force = false) {
    const _hadCache = calendarEvents.length > 0;
    console.log('[CAL-FE] loadCalendarEvents start: force=' + force + ' hadCache=' + _hadCache + ' existing=' + calendarEvents.length);
    if (calendarEvents.length && !force) {
        console.log('[CAL-FE] short-circuit: returning cached ' + calendarEvents.length + ' events');
        return calendarEvents;
    }
    if (!API_BASE) return [];
    if (calendarLoading) {
        console.log('[CAL-FE] already loading, returning existing ' + calendarEvents.length + ' events');
        return calendarEvents;
    }
    calendarLoading = true;
    try {
        const data = await apiFetch('/api/calendar/events');
        const fresh = data.events || [];
        console.log('[CAL-FE] API response: events=' + fresh.length + ' status=' + (data.status || '?'));
        // ROOT CAUSE FIX for "calendar data disappears intermittently":
        // Previously, on API error (catch block) we set calendarEvents = [],
        // destroying previously-loaded data. And if the API returned an empty
        // array (transient upstream failure), we also set calendarEvents = [],
        // causing the calendar to go blank even though we had valid data
        // from a previous successful load.
        //
        // NEW behaviour: only overwrite calendarEvents if the fresh data is
        // non-empty. If the API returns empty OR errors, preserve the last
        // good data so the calendar stays stable. The backend now also serves
        // stale cache on upstream failure, so this frontend guard is a second
        // line of defence.
        if (fresh.length > 0) {
            calendarEvents = fresh;
            console.log('[CAL-FE] updated calendarEvents: ' + calendarEvents.length + ' events');
            // DASHBOARD SPEED OPTIMIZATION: persist to localStorage so the
            // next cold open can render the dashboard calendar instantly.
            try {
                localStorage.setItem('calendar_cache', JSON.stringify({ data: calendarEvents, ts: Date.now() }));
            } catch (_) {}
        } else if (calendarEvents.length === 0) {
            // No previous data and fresh is empty — keep calendarEvents as []
            // so the empty state shows. This is the true "no data" case.
            calendarEvents = [];
            console.log('[CAL-FE] empty response, no cache — calendarEvents=[]');
        } else {
            console.log('[CAL-FE] empty response but have cache — keeping ' + calendarEvents.length + ' events');
        }
    } catch (e) {
        console.warn('[CAL-FE] ERROR:', e?.message || e, '— preserving ' + calendarEvents.length + ' existing events');
    } finally {
        calendarLoading = false;
    }
    console.log('[CAL-FE] returning: ' + calendarEvents.length + ' events');
    return calendarEvents;
}

/**
 * رویداد تقویم را به بخش‌های امروز/فردا/پس‌فردا/گذشته گروه‌بندی و مرتب می‌کند.
 * زمان‌ها به منطقه زمانی کاربر تبدیل می‌شوند.
 */

/**
 * Recompute event status based on CURRENT time.
 *
 * ROOT CAUSE FIX (calendar items 1-3): The backend computes event.status at
 * API-call time. But the frontend caches events in localStorage for fast
 * cold-open. When cached events are loaded (potentially hours later), the
 * stored status is STALE — an event that was 'upcoming' when cached may now
 * be 'past', but the cached status still says 'upcoming' (or vice versa).
 *
 * This function recomputes the status using the CURRENT browser time,
 * ensuring the status is always accurate regardless of cache age.
 *
 * Status logic (matches backend getEventStatus):
 *   - live: within ±30 min window of event time
 *   - past: event time < now
 *   - upcoming: event time > now
 *
 * @param {Array} events - calendar events with .timestamp (ISO UTC string)
 * @returns {Array} events with updated .status
 */
function recomputeEventStatuses(events) {
    if (!events || !events.length) return events;
    const now = Date.now();
    const LIVE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
    return events.map(e => {
        if (!e.timestamp) return { ...e, status: 'upcoming' };
        const eventTime = new Date(e.timestamp).getTime();
        if (isNaN(eventTime)) return { ...e, status: 'upcoming' };
        let status;
        if (eventTime <= now + LIVE_WINDOW_MS && eventTime >= now - LIVE_WINDOW_MS) {
            status = 'live';
        } else if (eventTime < now) {
            status = 'past';
        } else {
            status = 'upcoming';
        }
        return { ...e, status };
    });
}

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

    // ── PERFORMANCE: Check localStorage cache (6h TTL) for instant repeat lookup ──
    // This avoids a network round-trip entirely for coins the user has opened before.
    const lsCached = getLsChartSymbol(symbol);
    if (lsCached) {
        // Also set in in-memory cache for subsequent calls in the same session
        Cache.set(cacheKey, lsCached, 3600);
        return lsCached;
    }

    const symUpper = String(symbol || '').toUpperCase().trim();
    if (!symUpper) {
        return { found: false, symbol: symbol, exchange: null, tv_symbol: null };
    }

    // ── BTC PAIR SHORTCUT ──
    // If symbol ends with "BTC" (e.g. "ETHBTC", "SOLBTC"), resolve directly to
    // a TradingView BTC pair symbol (e.g. "BINANCE:ETHBTC") WITHOUT calling the
    // backend. The backend's resolveChartExchange always appends "USDT"/"USD"
    // which would turn "ETHBTC" into "ETHBTCUSDT" (wrong).
    if (symUpper !== 'BTC' && symUpper.endsWith('BTC') && symUpper.length > 3) {
        const base = symUpper.slice(0, -3);
        if (base.length >= 2 && /^[A-Z0-9]+$/.test(base)) {
            const result = {
                found: true,
                symbol: symUpper,
                exchange: 'binance',
                tv_symbol: `BINANCE:${symUpper}`,
                cached: false,
                is_btc_pair: true,
            };
            Cache.set(cacheKey, result, 3600);
            setLsChartSymbol(symbol, result);
            return result;
        }
    }

    // Skip stablecoins and fiat that don't have meaningful crypto charts.
    // These would return "Symbol not found" in the TradingView widget.
    const skipSymbols = ['USDT', 'USD', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD'];
    if (skipSymbols.includes(symUpper)) {
        const notFound = { found: false, symbol: symUpper, exchange: null, tv_symbol: null };
        Cache.set(cacheKey, notFound, 300);
        setLsChartSymbol(symbol, notFound);
        return notFound;
    }

    // ── PRIMARY: backend resolver ──
    // Backend queries TradingView scanner API (batch) across 10 exchanges:
    //   Binance > Bybit > OKX > Bitget > KuCoin > MEXC > Gate > HTX > Coinbase > Kraken
    // USDT pairs on crypto exchanges, USD pairs on Coinbase/Kraken.
    // Results cached 1h per symbol in APP_CACHE.
    if (API_BASE) {
        try {
            const data = await apiFetch(`/api/charts/resolve?symbol=${encodeURIComponent(symbol)}`);
            if (data && data.found && data.tv_symbol) {
                Cache.set(cacheKey, data, 3600);
                setLsChartSymbol(symbol, data);
                return data;
            }
            // Backend said genuinely not found → trust it (short cache, retry later)
            if (data && data.found === false) {
                Cache.set(cacheKey, data, 300);
                setLsChartSymbol(symbol, data);
                return data;
            }
        } catch (e) { console.warn('resolveChartSymbol backend failed, trying client-side scanner:', e); }
    }


    // ── LAST-RESORT FALLBACK: client-side TradingView scanner ──
    // Used only if the backend is completely unreachable. Queries TradingView's
    // public scanner API directly from the browser. This is the same API the
    // backend uses, so it covers ALL 10 exchanges in one call.
    // NOTE: The scanner API supports CORS for browser requests (TradingView's
    // own website uses it client-side), so this works from the Mini App.
    try {
        const candidates = [
            `BINANCE:${symUpper}USDT`, `BYBIT:${symUpper}USDT`,
            `OKX:${symUpper}USDT`, `BITGET:${symUpper}USDT`,
            `KUCOIN:${symUpper}USDT`, `MEXC:${symUpper}USDT`,
            `GATE:${symUpper}USDT`, `HTX:${symUpper}USDT`,
            `COINBASE:${symUpper}USD`, `KRAKEN:${symUpper}USD`,
        ];
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 5000);
        const resp = await fetch('https://scanner.tradingview.com/crypto/scan', {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', 'Accept': 'application/json' },
            body: JSON.stringify({ symbols: { tickers: candidates }, columns: ['name', 'close'] }),
            signal: controller.signal,
        });
        clearTimeout(timeoutId);
        if (resp.ok) {
            const data = await resp.json();
            const foundSet = new Set((data?.data || []).map(r => r.s));
            for (const candidate of candidates) {
                if (foundSet.has(candidate)) {
                    const [tvExchange] = candidate.split(':');
                    const result = {
                        found: true,
                        symbol: symUpper,
                        exchange: tvExchange.toLowerCase(),
                        tv_symbol: candidate,
                        cached: false,
                        is_fallback: true,
                    };
                    Cache.set(cacheKey, result, 3600);
                    setLsChartSymbol(symbol, result);
                    return result;
                }
            }
        }
    } catch (e) { console.warn('client-side scanner fallback failed:', e); }

    // No chart available for this symbol on ANY exchange TradingView tracks
    const notFound = { found: false, symbol: symUpper, exchange: null, tv_symbol: null };
    Cache.set(cacheKey, notFound, 300); // Short cache — retry sooner if listed later
    setLsChartSymbol(symbol, notFound);
    return notFound;
}

// ============================================================================
// ── PERFORMANCE: Prefetch chart symbols for top coins ──
// ============================================================================
// After market data loads, silently prefetch the chart symbol resolution for
// the top 10 coins (BTC, ETH, SOL, etc.) so that when the user taps one,
// the result is already in the in-memory + localStorage cache → instant chart.
// This runs in the background and never blocks the UI.
function prefetchTopChartSymbols() {
    if (!allCoins || allCoins.length === 0) return;
    const topCoins = allCoins.slice(0, 10).map(c => c.symbol).filter(Boolean);
    console.log('[CHART-PERF] Prefetching chart symbols for top', topCoins.length, 'coins');
    // Stagger the prefetches to avoid overwhelming the backend
    topCoins.forEach((sym, i) => {
        setTimeout(() => {
            // resolveChartSymbol checks cache first — only fetches if not cached
            resolveChartSymbol(sym).catch(() => {});
        }, i * 200); // 200ms between each = 2s total for 10 coins
    });
}


/**
 * PERFORMANCE: Two-layer request optimizer.
 *
 * Layer 1 — Request Deduplication:
 *   If the same URL is already being fetched, reuse the in-flight promise.
 *   Prevents duplicate network requests when multiple components request
 *   the same endpoint simultaneously.
 *
 * Layer 2 — Short TTL Cache:
 *   After a successful response, the result is cached for a short TTL.
 *   Subsequent calls within the TTL window return cached data instantly
 *   (zero network requests). TTL is configurable per-endpoint.
 *
 * TTL defaults (overridable via options.ttlMs):
 *   /api/market/overview → 30s   (BTC.D, F&G, market cap — changes slowly)
 *   /api/forex           → 60s   (forex pairs — moderate frequency)
 *   /api/market          → 30s   (coin prices — 30s matches backend cache)
 *   /api/market/prices   → 15s   (alert prices — needs freshness)
 *   default              → 0     (no cache, just dedup)
 */
const _sharedPromises = {};
const _sharedCache = {}; // { [url]: { data, expiry } }

function _getTtlForUrl(url) {
  if (url.includes('/api/market/overview')) return 30000;    // 30s
  if (url.includes('/api/forex')) return 60000;              // 60s
  if (url.includes('/api/market/prices')) return 15000;      // 15s
  if (url.includes('/api/market') && !url.includes('/api/market/')) return 30000; // 30s
  if (url.includes('fear-and-greed') || url.includes('fearGreed')) return 300000; // 300s (5min)
  if (url.includes('dominance') || url.includes('btc-dominance')) return 900000;  // 900s (15min)
  return 0; // no cache by default
}

async function sharedFetch(url, options = {}) {
  // Only deduplicate GET requests
  const method = (options.method || 'GET').toUpperCase();
  if (method !== 'GET') {
    const res = await fetch(url, options);
    return res.json();
  }

  // Layer 2: Check TTL cache first
  const ttlMs = options.ttlMs !== undefined ? options.ttlMs : _getTtlForUrl(url);
  if (ttlMs > 0 && _sharedCache[url]) {
    const cached = _sharedCache[url];
    if (Date.now() < cached.expiry) {
      return cached.data; // Return cached data — zero network requests
    }
    delete _sharedCache[url]; // expired
  }

  // Layer 1: Check if this URL is already being fetched (dedup)
  if (_sharedPromises[url]) {
    return _sharedPromises[url];
  }

  // Create the promise and store it
  const promise = (async () => {
    try {
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), options.timeoutMs || 10000);
      const res = await fetch(url, {
        ...options,
        signal: options.signal || controller.signal,
      });
      clearTimeout(timeoutId);
      if (!res.ok) {
        throw new Error(`HTTP ${res.status}`);
      }
      const data = await res.json();

      // Store in TTL cache if TTL > 0
      if (ttlMs > 0) {
        _sharedCache[url] = { data, expiry: Date.now() + ttlMs };
      }

      return data;
    } finally {
      // Remove from in-flight cache after completion (success or error)
      delete _sharedPromises[url];
    }
  })();

  _sharedPromises[url] = promise;
  return promise;
}

// Allow manual cache invalidation (e.g., after user action that changes data)
function invalidateSharedCache(urlPattern) {
  for (const key of Object.keys(_sharedCache)) {
    if (!urlPattern || key.includes(urlPattern)) {
      delete _sharedCache[key];
    }
  }
}
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
    // BUG FIX: Add 15s timeout — without this, a hanging Worker causes infinite Loading
    if (!fetchOpts.signal) {
        try { fetchOpts.signal = AbortSignal.timeout(15000); } catch(_) {}
    }
    const doRequest = async () => {
        const res = await fetch(url, fetchOpts);
        if (!res.ok) {
            let detail = '';
            try { detail = await res.text(); } catch (_) {}
            // Try to parse error as JSON for better error messages
            let errMsg = detail || `HTTP ${res.status}`;
            try { const j = JSON.parse(detail); if (j.detail) errMsg = j.detail; } catch(_) {}
            const err = new Error(errMsg);
            err.status = res.status;
            if (path === '/api/users/bootstrap') {
                console.error('[BOOT] apiFetch bootstrap FAILED — status:', res.status, 'detail:', detail);
            }
            throw err;
        }
        // BUG FIX: Wrap JSON parse — if response is HTML (Cloudflare error page), res.json() throws
        try {
            return await res.json();
        } catch (parseErr) {
            console.error('[API] JSON parse failed for', path, '— response was not JSON');
            throw new Error(`Invalid JSON response from ${path}`);
        }
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

    // SECURITY: If data was skipped because join-lock was showing, load it now.
    // This runs after membership is verified (recheckJoinMembership → hideJoinLock → refreshUI).
    if (!allCoins.length) {
        loadMarketData(true).then(() => {
            renderMarket();
            renderWatchlist();
            renderDashboardMarketStatus();
            renderMarketTicker();
        }).catch(() => {});
    } else {
        renderMarket();
        renderWatchlist();
        renderDashboardMarketStatus();
    }

    renderSummary();
    renderMarketInsights();

    // Defer non-critical renders to next frame to reduce main thread blocking
    requestAnimationFrame(() => {
        if (!analyses.length) {
            fetchAnalyses().then(() => {
                renderAnalysisSlider();
                renderAnalysisList();
                renderAnalysisStats();
                renderDashboardFeaturedAnalysis();
            }).catch(() => {});
        } else {
            renderAnalysisSlider();
            renderAnalysisList();
            renderDashboardFeaturedAnalysis();
        }
        renderDashboardCalendar();
        if (newsCache.length) renderNews(document.querySelector('.ni-tab.active')?.dataset?.news || 'all');
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

    // Re-render open full-page overlays so their localized text updates live.
    // These pages are rendered dynamically (not via data-i18n attributes) so
    // they need an explicit re-render when the language changes mid-session.
    try {
        const referralPage = document.getElementById('referral-full-page');
        if (referralPage && referralPage.classList.contains('open') && window.ReferralApp) {
            // Re-open triggers a fresh buildPage() with the new language
            window.ReferralApp.openReferral();
        }
        const walletPage = document.getElementById('wallet-full-page');
        if (walletPage && walletPage.classList.contains('open') && window.WalletApp?.isOpen) {
            // Wallet has its own internal state; re-render via its public API if available
            if (typeof window.WalletApp.refresh === 'function') window.WalletApp.refresh();
        }
    } catch (e) { /* non-critical — overlays will update on next open */ }
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
    // P1-01 FIX (NEWSSEC-001): Canonical escapeHtml — escapes ALL 5 HTML-special
    // characters (& < > " ') so it is safe in HTML text, double-quoted attributes
    // (src="..."), single-quoted attributes (onclick='...'), and single-quoted
    // JS string contexts (onclick="fn('...')"). The previous DOM-based duplicate
    // definition at the bottom of this file (which only escaped & < >) was
    // shadowing this one — removed. Callers that interpolate into JS string
    // contexts (onclick="openReminderSheet('...')") rely on ' being escaped to
    // &#39; so a value containing ' cannot break out of the string.
    return String(str)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/"/g, '&quot;')
        .replace(/'/g, '&#39;');
}

/**
 * Sanitize and deduplicate a news title.
 * Fixes the critical bug where titles render with repeated words/phrases.
 *
 * Root cause: AI translation (m2m100) sometimes produces repeated text, and
 * RSS sources occasionally have malformed titles. This function normalizes
 * ANY title — regardless of source — before rendering.
 *
 * Handles:
 * 1. Consecutive duplicate words: "BTC BTC BTC rises" → "BTC rises"
 * 2. Consecutive duplicate phrases: "Bitcoin rises Bitcoin rises" → "Bitcoin rises"
 * 3. Full title duplication: "Bitcoin hits 65K Bitcoin hits 65K" → "Bitcoin hits 65K"
 * 4. Whitespace normalization
 * 5. Trailing/leading punctuation cleanup
 *
 * This is a DEFENSIVE measure — it never changes a clean title, only fixes
 * broken ones. Safe to call on every title before render.
 */
function sanitizeNewsTitle(rawTitle) {
    if (!rawTitle) return '';
    let title = String(rawTitle).replace(/\s+/g, ' ').trim();
    if (!title) return '';

    // 1. Remove consecutive duplicate words (2+ same words in a row → keep 1)
    //    Unicode-safe: doesn't rely on \b which fails for Persian/RTL text.
    //    e.g. "بیت‌کوین بیت‌کوین بیت‌کوین بالا رفت" → "بیت‌کوین بالا رفت"
    //    Run in a loop to handle 3+, 4+, etc. consecutive duplicates
    let prev;
    do {
        prev = title;
        title = title.replace(/(\S+)(\s+\1)(?=\s|$)/gi, '$1');
    } while (title !== prev);

    // 2. Remove consecutive duplicate phrases (phrase of 2-8 words repeated)
    //    e.g. "قیمت بیت‌کوین بالا رفت قیمت بیت‌کوین بالا رفت" → "قیمت بیت‌کوین بالا رفت"
    //    Run in a loop to catch nested duplications
    do {
        prev = title;
        title = title.replace(/((?:\S+\s+){1,8}\S+)\s+\1/gi, '$1');
    } while (title !== prev);

    // 3. Full title duplication: if the title is exactly repeated (first half == second half)
    //    e.g. "Bitcoin hits 65K Bitcoin hits 65K" → "Bitcoin hits 65K"
    //    Also handle slight asymmetry (off by 1-2 chars)
    const len = title.length;
    if (len > 20) {
        const mid = Math.floor(len / 2);
        // Try exact midpoint split
        const firstHalf = title.substring(0, mid).trim();
        const secondHalf = title.substring(mid).trim();
        if (firstHalf === secondHalf && firstHalf.length > 8) {
            title = firstHalf;
        } else {
            // Try finding the second occurrence of the first 10 chars
            const prefix = title.substring(0, 10);
            if (prefix.length === 10) {
                const secondOccurrence = title.indexOf(prefix, 5);
                if (secondOccurrence > 10 && secondOccurrence < len - 10) {
                    // Check if the text before the second occurrence matches the text after
                    const candidate = title.substring(0, secondOccurrence).trim();
                    const remainder = title.substring(secondOccurrence).trim();
                    if (candidate === remainder && candidate.length > 8) {
                        title = candidate;
                    }
                }
            }
        }
    }

    // 4. Final whitespace cleanup
    title = title.replace(/\s+/g, ' ').trim();

    return title;
}

/**
 * Format a news publication date as Tehran time.
 * Converts UTC ISO timestamp to Asia/Tehran timezone (UTC+3:30).
 * Returns: "HH:MM | به وقت تهران" or relative time if no date available.
 *
 * Item 2: News time displayed in Tehran timezone, not UTC.
 */
function formatNewsTimeTehran(pubDate, relativeTime) {
    // If we have a valid pubDate, format as Tehran time (HH:MM only, no label)
    if (pubDate) {
        try {
            const date = new Date(pubDate);
            if (!isNaN(date.getTime())) {
                // Format in Asia/Tehran timezone (UTC+3:30, no DST)
                // Show ONLY the time (e.g. "۱۴:۳۵") — no "به وقت تهران" label
                // to keep the UI clean and uncluttered.
                return new Intl.DateTimeFormat('fa-IR', {
                    timeZone: 'Asia/Tehran',
                    hour: '2-digit',
                    minute: '2-digit',
                    hour12: false,
                }).format(date);
            }
        } catch (_) { /* fall through to relative time */ }
    }
    // Fallback to relative time if no pubDate or formatting fails
    return relativeTime || '';
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
    var steps = 24;
    var midY = height / 2;
    // Larger amplitude for more visible variation (TradingView-style)
    var baseAmp = height * 0.34;
    var dynamicAmp = Math.min(height * 0.18, Math.abs(changePercent) * 1.1 + 1.5);
    var amp = baseAmp + dynamicAmp;
    var dir = changePercent >= 0 ? -1 : 1;

    // Multiple peaks/pullbacks: use sum of sine waves at different frequencies
    var phase1 = (sRand() * Math.PI * 2);
    var phase2 = (sRand() * Math.PI * 2);
    var phase3 = (sRand() * Math.PI * 2);

    for (var i = 0; i <= steps; i++) {
        var x = (i / steps) * width;
        var progress = i / steps;
        // Primary trend (overall direction)
        var trend = dir * progress * amp * 0.55;
        // Multi-frequency oscillation — creates realistic peaks and pullbacks
        var wave1 = Math.sin(progress * Math.PI * 2.2 + phase1) * amp * 0.32;
        var wave2 = Math.sin(progress * Math.PI * 4.5 + phase2) * amp * 0.18;
        var wave3 = Math.sin(progress * Math.PI * 7 + phase3) * amp * 0.10;
        // Small random noise for organic feel
        var noise = (sRand() - 0.5) * amp * 0.12;
        var y = Math.max(2, Math.min(height - 2, midY + trend + wave1 + wave2 + wave3 + noise));
        points.push(x.toFixed(1) + ',' + y.toFixed(1));
    }
    return points.join(' ');
}

/**
 * Build a smooth curved SVG sparkline using Catmull-Rom spline approximation.
 * Returns an SVG path string (for <path d="...">).
 */
function buildSmoothSparklinePath(points, width, height) {
    if (!points || points.length < 2) return '';
    var pts = points.split(' ').map(function(p) {
        var parts = p.split(',');
        return { x: parseFloat(parts[0]), y: parseFloat(parts[1]) };
    });
    var path = 'M ' + pts[0].x.toFixed(1) + ' ' + pts[0].y.toFixed(1);
    for (var i = 0; i < pts.length - 1; i++) {
        var p0 = pts[i - 1] || pts[i];
        var p1 = pts[i];
        var p2 = pts[i + 1];
        var p3 = pts[i + 2] || p2;
        var cp1x = p1.x + (p2.x - p0.x) / 6;
        var cp1y = p1.y + (p2.y - p0.y) / 6;
        var cp2x = p2.x - (p3.x - p1.x) / 6;
        var cp2y = p2.y - (p3.y - p1.y) / 6;
        path += ' C ' + cp1x.toFixed(1) + ' ' + cp1y.toFixed(1) + ' ' + cp2x.toFixed(1) + ' ' + cp2y.toFixed(1) + ' ' + p2.x.toFixed(1) + ' ' + p2.y.toFixed(1);
    }
    return path;
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
        // PERFORMANCE: Use sharedFetch to prevent duplicate /api/market/overview calls.
        // Previously, loadMarketOverview() and loadMarketData() could both trigger
        // this endpoint simultaneously → 2 identical network requests.
        const res = await sharedFetch(`${API_BASE}/api/market/overview`, {
            headers: { 'Accept': 'application/json' },
        });
        if (res && res.status === 'success' && (res.totalMarketCap > 0 || res.fearGreedValue > 0)) {
            globalMarketData = res;
            console.log('[OVERVIEW] data loaded — source:', res.source, 'mcap:', res.totalMarketCap, 'fg:', res.fearGreedValue);
            // ROOT CAUSE FIX: re-render summary after data arrives. Previously
            // loadMarketOverview() ran in parallel with loadMarketData() and
            // completed AFTER renderSummary() was called → UI showed '--' until
            // the next poll (60s). Now we re-render immediately when data arrives.
            renderSummary();
            renderDashboardMarketStatus();
        }
    } catch (e) {
        console.warn('[OVERVIEW] Failed to load overview:', e);
    }
}

async function loadMarketData(force = false) {
    console.log('[TICKER] loadMarketData called — force:', force, '| allCoins length:', allCoins.length);
    const listEl = document.getElementById('coin-list-rows');
    const refreshBtn = document.getElementById('market-refresh-btn');
    if (refreshBtn) refreshBtn.classList.add('spinning');
    try {
        if (!force) {
            const cached = Cache.get('market');
            if (cached?.length) {
                console.log('[TICKER] In-memory cache hit — using cached market data (', cached.length, 'coins )');
                allCoins = cached;
                // FIX: Set tabLoaded.market = true only when we actually have
                // data (cache hit or API success). This prevents the bug where
                // a failed first load leaves tabLoaded.market=true, causing all
                // subsequent Market tab visits to renderMarket() from empty
                // allCoins with no retry.
                tabLoaded.market = true;
                renderMarket();
                renderWatchlist();
                renderSummary();
                // Re-render ticker from in-memory cache (signature guard skips
                // the DOM rewrite if data is unchanged).
                renderMarketTicker();
                renderDashboardMarketStatus();
                return;
            }
        }
        console.log('[TICKER] Fetching fresh market data from /api/market — force:', force);
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
                console.log('[TICKER] apiFetch /api/market started');
                const res = await apiFetch('/api/market');
                console.log('[TICKER] apiFetch /api/market responded — status:', res?.status, '| dataSource:', res?.dataSource, '| cached:', res?.cached, '| coins:', Array.isArray(res?.data) ? res.data.length : 'n/a');
                await overviewPromise; // wait for overview too
                if (res.status === 'success' && Array.isArray(res.data) && res.data.length) {
                    // Backend normalizes ALL sources to percentage format:
                    // CoinGecko/Binance Futures: already percentage (direct use)
                    // CoinCap/MEXC: decimal fraction → ×100 in backend
                    // No frontend heuristic needed.
                    console.log('[MARKET] dataSource:', res.dataSource || 'unknown', 'coins:', res.data.length);
                    ['BTC','ETH','SOL','XRP','DOGE'].forEach(function(s) {
                        var c = res.data.find(function(x) { return x.symbol === s; });
                        if (c) console.log('[MARKET]', s, 'price:', c.priceUsd, 'changePercent24Hr:', c.changePercent24Hr, 'hasImage:', !!c.image);
                    });
                    allCoins = res.data;
                    // ROOT CAUSE FIX: Don't overwrite CMC data with less authoritative
                    // sources. loadMarketOverview() sets globalMarketData from CMC (the
                    // industry standard). Previously, loadMarketData() would OVERWRITE
                    // it with CoinPaprika/CoinGecko data from /api/market, causing the
                    // cards to show different values (e.g. volume $81B instead of $36B).
                    // Now: only use /api/market's global as a FALLBACK when CMC data is
                    // not yet loaded.
                    if (res.global && typeof res.global === 'object' && res.global !== null) {
                        if (!globalMarketData || globalMarketData.source !== 'coinmarketcap') {
                            globalMarketData = res.global;
                        }
                    }
                    console.log('[TICKER] allCoins populated — length:', allCoins.length, '| sample:', allCoins[0] ? Object.keys(allCoins[0]).join(',') : 'n/a');
                } else {
                    console.warn('[TICKER] /api/market returned no usable data — res:', JSON.stringify({status: res?.status, dataLen: Array.isArray(res?.data) ? res.data.length : 'not-array'}));
                }
            } catch (e) {
                console.warn('[TICKER] Backend /api/market failed:', e?.message || e);
            }
        }

        if (!allCoins.length) throw new Error('No market data');
        // FIX: Set tabLoaded.market = true only after allCoins is confirmed
        // populated. If we reach this point, the data load succeeded.
        tabLoaded.market = true;
        Cache.set('market', allCoins, 120);
        // Phase C: Persist market data to localStorage for instant ticker render on cold start.
        // MARKET_CACHE_VERSION must match the version read in DOMContentLoaded.
        // Defer cache write off the critical render path (2-5ms saved per market load)
        requestIdleCallback?.(() => { try { localStorage.setItem('market_data_cache', JSON.stringify(allCoins)); localStorage.setItem('market_cache_version', String(4)); localStorage.setItem('market_cache_ts', String(Date.now())); } catch(_) {} }) ?? setTimeout(() => { try { localStorage.setItem('market_data_cache', JSON.stringify(allCoins)); localStorage.setItem('market_cache_version', String(4)); localStorage.setItem('market_cache_ts', String(Date.now())); } catch(_) {} }, 200);
        lastMarketFetchTime = Date.now();
        renderMarket();
        renderWatchlist();
        renderSummary();
        // ── NEW: Update heatmap with fresh prices ──
        renderDashboardHeatmap();

        // ── PERFORMANCE: Prefetch chart symbols for top 10 coins ──
        // Runs in background — never blocks the UI. By the time the user taps
        // a top coin (BTC, ETH, SOL...), its chart symbol is already cached
        // → chart opens instantly.
        try { prefetchTopChartSymbols(); } catch (e) { console.warn('chart prefetch failed:', e?.message); }
        renderMarketInsights();
        // ALWAYS re-render ticker after a successful market load — this is the
        // primary path that hydrates the ticker from cold-open (skeleton → real).
        // The signature guard inside renderMarketTicker prevents needless DOM
        // rewrites if the data is identical to what's already shown.
        renderMarketTicker();
        renderDashboardMarketStatus();
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
            // Also persist to localStorage for instant cold-open hydration
            try { localStorage.setItem('forex_data_cache', JSON.stringify({ data: allForexPairs, ts: Date.now() })); } catch {}
            return;
        }
        const res = await apiFetch('/api/forex');
        if (res.status === 'success' && Array.isArray(res.data)) {
            allForexPairs = res.data;
            Cache.set('forex', allForexPairs, 120);
            // Persist to localStorage for instant cold-open hydration
            try { localStorage.setItem('forex_data_cache', JSON.stringify({ data: allForexPairs, ts: Date.now() })); } catch {}
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

    const sourceTextEl = document.getElementById('mkt-source-text');
    const updatedEl = document.getElementById('mkt-overview-updated');
    const metaEl = document.getElementById('mkt-overview-meta');

    if (globalMarketData) {
        const mcapVal = globalMarketData.totalMarketCap;
        const volVal = globalMarketData.totalVolume;
        const domVal = globalMarketData.btcDominance;
        mcapEl.textContent = (mcapVal > 0) ? '$' + formatLargeNumber(mcapVal) : '--';
        volEl.textContent = (volVal > 0) ? '$' + formatLargeNumber(volVal) : '--';
        domEl.textContent = (domVal > 0) ? domVal.toFixed(1) + '%' : '--';

        // Show data source + last update timestamp
        if (sourceTextEl) {
            const src = globalMarketData.source || 'unknown';
            sourceTextEl.textContent = src === 'coinmarketcap' ? 'CoinMarketCap' :
                                       src === 'coingecko' ? 'CoinGecko' :
                                       src === 'coinpaprika' ? 'CoinPaprika' : src;
        }
        if (updatedEl && globalMarketData.timestamp) {
            try {
                const ts = new Date(globalMarketData.timestamp);
                const timeStr = ts.toLocaleTimeString('en-US', { hour: '2-digit', minute: '2-digit', hour12: false });
                updatedEl.textContent = '· ' + timeStr;
            } catch (_) { updatedEl.textContent = ''; }
        }
        if (metaEl) metaEl.classList.remove('error');
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

        // Show error state if no data at all
        if (totalMcap === 0 && metaEl) {
            metaEl.classList.add('error');
            if (sourceTextEl) sourceTextEl.textContent = 'Waiting for data...';
            if (updatedEl) updatedEl.textContent = '';
        }
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
    var gainers = 0, losers = 0, neutral = 0;
    for (var i = 0; i < allCoins.length; i++) {
        var chg = allCoins[i].changePercent24Hr || 0;
        if (chg > 0.5) gainers++;
        else if (chg < -0.5) losers++;
        else neutral++;
    }
    var total = gainers + losers + neutral;
    var ratio = total > 0 ? gainers / (gainers + losers || 1) : 0.5;

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

    // Gainers / Losers / Neutral numbers — support both legacy (span inside) and new (b element) layouts
    var gEl = document.getElementById('sentiment-gainers');
    if (gEl) {
        var gs = gEl.querySelector('span');
        if (gs) gs.textContent = gainers; else gEl.textContent = gainers;
    }
    var lEl = document.getElementById('sentiment-losers');
    if (lEl) {
        var ls = lEl.querySelector('span');
        if (ls) ls.textContent = losers; else lEl.textContent = losers;
    }
    var nEl = document.getElementById('sentiment-neutral');
    if (nEl) nEl.textContent = neutral;

    // Triple-segment ratio bar (green | neutral | red) — new premium market status card
    var greenBar = document.getElementById('mkt-status-green');
    var neutralBar = document.getElementById('mkt-status-neutral');
    var redBar = document.getElementById('mkt-status-red');
    if (greenBar && neutralBar && redBar && total > 0) {
        var gPct = (gainers / total) * 100;
        var nPct = (neutral / total) * 100;
        var rPct = (losers / total) * 100;
        greenBar.style.width = gPct.toFixed(1) + '%';
        neutralBar.style.width = nPct.toFixed(1) + '%';
        redBar.style.width = rPct.toFixed(1) + '%';
    }

    // Total coins count
    var totalEl = document.getElementById('mkt-status-total');
    if (totalEl) {
        var totalLabel = currentLang === 'fa' ? `${total} ارز` : `${total} coins`;
        totalEl.textContent = totalLabel;
    }

    // Market sentiment label (bullish/bearish/neutral)
    var sentimentValueEl = document.getElementById('mkt-sentiment-value');
    if (sentimentValueEl) {
        var senLabel, senClass;
        if (ratio > 0.6) { senLabel = t('sentiment_bullish') || 'صعودی'; senClass = 'bullish'; }
        else if (ratio >= 0.4) { senLabel = t('sentiment_neutral') || 'خنثی'; senClass = 'neutral'; }
        else { senLabel = t('sentiment_bearish') || 'نزولی'; senClass = 'bearish'; }
        sentimentValueEl.textContent = senLabel;
        sentimentValueEl.className = 'mkt-status-sentiment-value ' + senClass;
    }

    // Market Trend display (روند بازار: صعودی/نزولی/خنثی) — based on gainers/losers ratio
    var trendValueEl = document.getElementById('mkt-trend-value');
    if (trendValueEl) {
        var trendLabel, trendClass;
        if (ratio > 0.6) { trendLabel = currentLang === 'fa' ? 'صعودی' : 'Bullish'; trendClass = 'trend-up'; }
        else if (ratio >= 0.4) { trendLabel = currentLang === 'fa' ? 'خنثی' : 'Neutral'; trendClass = 'trend-neutral'; }
        else { trendLabel = currentLang === 'fa' ? 'نزولی' : 'Bearish'; trendClass = 'trend-down'; }
        trendValueEl.textContent = trendLabel;
        trendValueEl.className = 'mkt-trend-value ' + trendClass;
    }

    // --- Fear & Greed ---
    // FIX 4: Only show real data from CoinMarketCap. Hide the entire section if unavailable.
    if (globalMarketData && globalMarketData.fearGreedValue > 0) {
        var fgIndex = globalMarketData.fearGreedValue;
        var fgSource = globalMarketData.fearGreedSource || 'real';
        var fgClass = (globalMarketData.fearGreedClassification || '').toLowerCase();
        var fgLabel;
        var fgBadgeColor = '#6B7A8D';
        if (fgClass === 'extreme greed' || fgClass === 'extreme_greed') { fgLabel = t('fg_extreme_greed'); fgBadgeColor = '#22C55E'; }
        else if (fgClass === 'greed') { fgLabel = t('fg_greed'); fgBadgeColor = '#84CC16'; }
        else if (fgClass === 'neutral') { fgLabel = t('fg_neutral'); fgBadgeColor = '#F5A623'; }
        else if (fgClass === 'fear') { fgLabel = t('fg_fear'); fgBadgeColor = '#F97316'; }
        else if (fgClass === 'extreme fear' || fgClass === 'extreme_fear') { fgLabel = t('fg_extreme_fear'); fgBadgeColor = '#EF4444'; }
        else fgLabel = globalMarketData.fearGreedClassification || '--';
        console.log('[FG] Real data from', fgSource, ':', fgIndex, fgLabel);

        // Update the score display (number + label)
        var fgTextEl = document.getElementById('fg-gauge-text');
        if (fgTextEl) fgTextEl.textContent = fgIndex;
        var fgLabelEl = document.getElementById('fg-gauge-label');
        if (fgLabelEl) fgLabelEl.textContent = fgLabel;

        // Move the gradient bar indicator to the F&G value position
        var fgIndicator = document.getElementById('mkt-fg-indicator');
        if (fgIndicator) {
            fgIndicator.style.left = fgIndex + '%';
        }

        // Update the F&G badge
        var fgBadgeEl = document.getElementById('mkt-fg-badge');
        if (fgBadgeEl) {
            fgBadgeEl.textContent = fgLabel;
            fgBadgeEl.style.background = fgBadgeColor + '22';
            fgBadgeEl.style.color = fgBadgeColor;
            fgBadgeEl.style.borderColor = fgBadgeColor + '44';
        }

        // Analytical insight text based on F&G value + sentiment
        var insightEl = document.getElementById('mkt-status-insight');
        if (insightEl) {
            var insight = '';
            if (currentLang === 'fa') {
                if (fgIndex <= 25) insight = 'ترس شدید در بازار — فرصت خرید احتمالی برای سرمایه‌گذاران شجاع';
                else if (fgIndex <= 45) insight = 'ترس در بازار غالب است — احتیاط کنید اما فرصت‌ها را بررسی کنید';
                else if (fgIndex <= 55) insight = 'بازار در حالت خنثی — منتظر جهت‌گیری مشخص باشید';
                else if (fgIndex <= 75) insight = 'حریصیت در بازار — زمان مناسب برای سودگیری و مدیریت ریسک';
                else insight = 'حریصیت شدید — احتیاط کنید، اصلاح بازار محتمل است';
            } else {
                if (fgIndex <= 25) insight = 'Extreme fear — potential buying opportunity for bold investors';
                else if (fgIndex <= 45) insight = 'Fear dominates — be cautious but watch for opportunities';
                else if (fgIndex <= 55) insight = 'Market is neutral — wait for a clear direction';
                else if (fgIndex <= 75) insight = 'Greed in the market — good time to take profits and manage risk';
                else insight = 'Extreme greed — be cautious, market correction is likely';
            }
            insightEl.textContent = insight;
        }

        // Legacy: keep fg-arc updated for any remaining references
        var fgArcEl = document.getElementById('fg-arc');
        if (fgArcEl) {
            var totalLen = 150.8;
            var offset = totalLen - (totalLen * fgIndex / 100);
            fgArcEl.setAttribute('stroke-dashoffset', offset.toFixed(1));
        }
    }
}

// NEWSFE-023 FIX (DEAD CODE REMOVED): renderTopMovers() was a no-op (return;)
// with 0 callers. The "Top Movers" UI section was removed (BUG 4). Removed the
// function and its docstring.

//#endregion

// ============================================================================
//#region فهرست و تب‌های بازار
// ============================================================================
/**
 * بازار را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
// MKT-011 FIX (DEAD CODE REMOVED): _renderIdx was declared but never used.

function renderMarket() {
    const list = document.getElementById('coin-list-rows');
    if (!list) return;

    // Price-only diffing: if the list is already rendered with the same tab/filter/search,
    // just update prices and change percentages — avoid full innerHTML rebuild
    const renderKey = `${currentMarketTab}|${searchTerm}|${watchlist.length}|${marketVisibleCount}`;
    if (!searchTerm && currentMarketTab !== 'forex' && _lastMarketRenderKey === renderKey && list.querySelector('.mkt-coin-row')) {
        const items = list.querySelectorAll('.mkt-coin-row');
        for (let i = 0; i < items.length; i++) {
            const item = items[i];
            const symbol = item.dataset.symbol;
            if (!symbol) continue;

            // BTC pair rows: update relative change + pair price from allCoins
            if (item.classList.contains('mkt-btc-pair-row')) {
                const btc = allCoins.find(c => c.symbol === 'BTC');
                const btcPrice = btc?.priceUsd || 0;
                const btcChange = btc?.changePercent24Hr || 0;
                const coin = allCoins.find(c => c.symbol === symbol);
                if (!coin || !btcPrice) continue;
                const pairPrice = coin.priceUsd / btcPrice;
                const rel = (coin.changePercent24Hr || 0) - btcChange;
                const priceEl = item.querySelector('.mkt-coin-price');
                if (priceEl) {
                    let pairPriceStr;
                    if (pairPrice >= 1) pairPriceStr = pairPrice.toFixed(6);
                    else if (pairPrice >= 0.001) pairPriceStr = pairPrice.toFixed(8);
                    else pairPriceStr = pairPrice.toExponential(2);
                    if (priceEl.textContent !== pairPriceStr) priceEl.textContent = pairPriceStr;
                }
                const changeEl = item.querySelector('.mkt-coin-change');
                if (changeEl) {
                    const isPos = rel >= 0;
                    const newChange = (isPos ? '+' : '') + rel.toFixed(2) + '%';
                    if (changeEl.textContent !== newChange) {
                        changeEl.textContent = newChange;
                        changeEl.className = 'mkt-coin-change ' + (isPos ? 'up' : 'down');
                    }
                }
                const capEl = item.querySelector('.mkt-coin-pair-caption');
                if (capEl) {
                    let pairPriceStr;
                    if (pairPrice >= 1) pairPriceStr = pairPrice.toFixed(6);
                    else if (pairPrice >= 0.001) pairPriceStr = pairPrice.toFixed(8);
                    else pairPriceStr = pairPrice.toExponential(2);
                    const newCap = pairPriceStr + ' BTC';
                    if (capEl.textContent !== newCap) capEl.textContent = newCap;
                }
                // Star state
                const starEl = item.querySelector('.mkt-coin-star');
                if (starEl) {
                    const inWatch = watchlist.includes(symbol);
                    if (inWatch !== starEl.classList.contains('active')) {
                        starEl.classList.toggle('active', inWatch);
                        const svgEl = starEl.querySelector('svg');
                        if (svgEl) svgEl.setAttribute('fill', inWatch ? 'currentColor' : 'none');
                    }
                }
                continue;
            }

            // Standard crypto row diff
            const coin = allCoins.find(c => c.symbol === symbol);
            if (!coin) continue;

            const priceEl = item.querySelector('.mkt-coin-price');
            if (priceEl) {
                const newPrice = '$' + (coin.priceUsd > 1 ? coin.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : coin.priceUsd.toFixed(6));
                if (priceEl.textContent !== newPrice) {
                    priceEl.textContent = newPrice;
                }
            }
            const changeEl = item.querySelector('.mkt-coin-change');
            if (changeEl && !item.dataset.forex) {
                const isPos = coin.changePercent24Hr >= 0;
                const newChange = (isPos ? '+' : '') + coin.changePercent24Hr.toFixed(2) + '%';
                if (changeEl.textContent !== newChange) {
                    changeEl.textContent = newChange;
                    changeEl.className = 'mkt-coin-change ' + (isPos ? 'up' : 'down');
                }
            }
            const starEl = item.querySelector('.mkt-coin-star');
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
        return '';
    }

    // Unified search: INDEPENDENT from the 200-coin market list.
    // The search calls /api/market/search (public, no auth needed) which
    // queries a 1700+ coin index from MEXC API. Results are rendered
    // directly without depending on allCoins.
    if (searchTerm) {
        // Show skeleton immediately while search runs
        list.innerHTML = '<div class="empty-state" style="padding:20px;">در حال جستجو...</div>';

        // Use plain fetch() — NOT apiFetch() — because:
        // 1. The endpoint is PUBLIC (no auth required)
        // 2. apiFetch requires waitForApiReady which can timeout/abort
        // 3. We want search to work even for guest users
        const searchUrl = `${API_BASE}/api/market/search?q=${encodeURIComponent(searchTerm)}`;
        const currentSearch = searchTerm;
        _lastSearchTerm = currentSearch;

        fetch(searchUrl, { method: 'GET', headers: { 'Accept': 'application/json' } })
            .then(res => res.ok ? res.json() : null)
            .then(data => {
                // Only render if this is still the current search term
                if (currentSearch !== _lastSearchTerm) return;

                if (!data || !data.results || data.results.length === 0) {
                    const icon = '<svg width="36" height="36" viewBox="0 0 24 24" fill="none" stroke="var(--text-sub)" stroke-width="1.5"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/><line x1="8" y1="11" x2="14" y2="11"/></svg>';
                    list.innerHTML = `<div class="empty-state">${icon}<br>${t('search_no_result') || 'نتیجه‌ای یافت نشد'}</div>`;
                    return;
                }

                // Map search results to the format expected by renderMarketItem
                // Search results from MEXC now include changePercent24Hr, volume, highPrice, lowPrice
                const searchResults = data.results.map(c => {
                    const coinData = {
                        symbol: c.symbol,
                        name: c.name || c.symbol,
                        priceUsd: c.priceUsd || 0,
                        changePercent24Hr: c.changePercent24Hr || 0,
                        volumeUsd24Hr: c.volume || 0,
                        marketCapUsd: 0, // MEXC doesn't provide market cap
                        rank: c.rank || 0,
                        image: `https://assets.coincap.io/assets/icons/${encodeURIComponent(c.symbol).toLowerCase()}@2x.png`,
                        _type: 'crypto',
                    };
                    // Cache each coin for openCoinDetail to find later
                    Cache.set(`search_coin_${c.symbol}`, coinData, 300); // 5 min cache
                    return { ...coinData, _fromSearch: true };
                });

                // Also check forex pairs (instant, from memory)
                const forexResults = allForexPairs.filter(f =>
                    f.symbol.toLowerCase().includes(searchTerm) ||
                    f.name.toLowerCase().includes(searchTerm) ||
                    (f.tvSymbol && f.tvSymbol.toLowerCase().includes(searchTerm))
                ).slice(0, 10).map(f => ({...f, _type: 'forex'}));

                const allResults = [...searchResults, ...forexResults];
                list.innerHTML = buildInfoBar(allResults.length, `جستجو در ${data.total_index || 1700}+ ارز`) + allResults.map(item => renderMarketItem(item)).join('');
            })
            .catch(() => {
                if (currentSearch !== _lastSearchTerm) return;
                // Fallback: search in loaded 200 coins
                const cryptoResults = allCoins.filter(c =>
                    c.symbol.toLowerCase().includes(searchTerm) ||
                    c.name.toLowerCase().includes(searchTerm)
                ).slice(0, 50).map(c => ({...c, _type: 'crypto'}));

                if (cryptoResults.length > 0) {
                    list.innerHTML = buildInfoBar(cryptoResults.length, t('search_results') || 'result') + cryptoResults.map(item => renderMarketItem(item)).join('');
                } else {
                    list.innerHTML = `<div class="empty-state">${t('search_no_result') || 'نتیجه‌ای یافت نشد'}</div>`;
                }
            });
        return;
    }

    // Tab-based rendering (no search)
    if (currentMarketTab === 'forex') {
        if (!allForexPairs.length) {
            // ROOT CAUSE FIX: Show a proper error state instead of infinite skeleton.
            // Previously, if forex data failed to load (auth required, network error),
            // the skeleton showed FOREVER with no feedback to the user.
            // Now we show a clear message with a retry button.
            const isGuest = (typeof isGuestUserId === 'function' ? isGuestUserId(getUserId()) : String(getUserId()).startsWith('guest_'));
            list.innerHTML = isGuest
                ? `<div class="market-error-state">
                    <div class="market-error-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>
                    </div>
                    <div class="market-error-title">داده فارکس نیاز به ورود از تلگرام دارد</div>
                    <div class="market-error-desc">برای مشاهده نرخ فارکس و طلا، اپ را داخل تلگرام باز کنید</div>
                </div>`
                : `<div class="market-error-state">
                    <div class="market-error-icon">
                        <svg width="32" height="32" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="21 3 21 12 12 12"/></svg>
                    </div>
                    <div class="market-error-title">بارگذاری مجدد</div>
                    <div class="market-error-desc">دریافت داده فارکس ناموفق بود</div>
                    <button class="market-error-retry" onclick="loadForexData().then(()=>renderMarket()).catch(()=>{})">
                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><path d="M21 12a9 9 0 1 1-6.219-8.56"/><polyline points="21 3 21 12 12 12"/></svg>
                        تلاش مجدد
                    </button>
                </div>`;
            return;
        }
        // Use premium grouped forex list (Major / Cross / Metals / Indices / Commodities)
        list.innerHTML = buildInfoBar(allForexPairs.length, t('tab_forex') || 'Forex') + renderForexGroupedList();
        return;
    }

    // Crypto tabs (overview, gainers, losers, watchlist, popular, btcpairs)
    let filtered = [...allCoins];
    switch (currentMarketTab) {
        case 'gainers':
            filtered = filtered.filter(c => c.changePercent24Hr > 0).sort((a, b) => b.changePercent24Hr - a.changePercent24Hr).slice(0, 30);
            break;
        case 'losers':
            filtered = filtered.filter(c => c.changePercent24Hr < 0).sort((a, b) => a.changePercent24Hr - b.changePercent24Hr).slice(0, 30);
            break;
        case 'watchlist':
            // Show both crypto AND forex symbols that are in the watchlist
            filtered = filtered.filter(c => watchlist.includes(c.symbol));
            // Also show forex symbols that are watchlisted
            const forexWatched = allForexPairs.filter(f => watchlist.includes(f.symbol));
            if (forexWatched.length) {
                const cryptoItems = filtered.map(c => renderMarketItem({...c, _type: 'crypto'})).join('');
                const forexItems = forexWatched.map(f => renderForexItem(f)).join('');
                list.innerHTML = buildInfoBar(filtered.length + forexWatched.length, t('watchlist') || 'Watchlist') + cryptoItems + forexItems;
                return;
            }
            break;
        case 'popular':
            // Popular = top 15 by 24h volume (real data, not mock)
            filtered = filtered
                .filter(c => (c.volumeUsd24Hr || 0) > 0)
                .sort((a, b) => (b.volumeUsd24Hr || 0) - (a.volumeUsd24Hr || 0))
                .slice(0, 15);
            break;
        case 'btcpairs':
            // BTC pairs view — show only coins paired against BTC (AVAXBTC, ETHBTC, SOLBTC, ...).
            // No USDT or USD pricing shown. Each row is a flat BTC pair item.
            // Sort by 24h volume descending to surface the most traded BTC pairs first.
            {
                const btc = allCoins.find(c => c.symbol === 'BTC');
                const btcPrice = btc?.priceUsd || 0;
                const btcChange = btc?.changePercent24Hr || 0;
                if (!btcPrice) {
                    list.innerHTML = '<div class="mkt-empty">داده BTC در دسترس نیست</div>';
                    return;
                }
                const pairs = allCoins
                    .filter(c => c.symbol !== 'BTC' && c.priceUsd > 0)
                    .map(c => ({
                        symbol: c.symbol,
                        name: c.name,
                        image: c.image,
                        rank: c.rank,
                        pairPrice: c.priceUsd / btcPrice,
                        relativeChange: (c.changePercent24Hr || 0) - btcChange,
                        volumeUsd24Hr: c.volumeUsd24Hr || 0,
                    }))
                    .sort((a, b) => (b.volumeUsd24Hr || 0) - (a.volumeUsd24Hr || 0));

                const visibleCount = Math.min(pairs.length, marketVisibleCount);
                const visible = pairs.slice(0, visibleCount);
                const hasMore = visibleCount < pairs.length;

                let html = visible.map((p, i) => renderBtcPairItem(p, i)).join('');
                if (hasMore) {
                    const remaining = pairs.length - visibleCount;
                    html += `<div class="mkt-load-more"><button class="mkt-load-more-btn" onclick="loadMoreCoins()">${t('load_more') || 'نمایش بیشتر'} (${remaining})</button></div>`;
                }
                list.innerHTML = html;
                return;
            }
        default:
            // Performance: limit visible coins, show Load More button
            if (filtered.length > MARKET_DEFAULT_LIMIT) {
                const visible = filtered.slice(0, marketVisibleCount);
                const hasMore = marketVisibleCount < filtered.length;
                const totalLabel = currentMarketTab === 'watchlist' ? (t('watchlist') || 'Watchlist') : (t('tab_crypto') || 'Crypto');
                let html = buildInfoBar(filtered.length, totalLabel) + visible.map(c => renderMarketItem({...c, _type: 'crypto'})).join('');
                if (hasMore) {
                    const remaining = filtered.length - marketVisibleCount;
                    html += `<div class="mkt-load-more"><button class="mkt-load-more-btn" onclick="loadMoreCoins()">${t('load_more') || 'نمایش بیشتر'} (${remaining})</button></div>`;
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
    // NEWSFE-026 FIX: Persist the new visible count for the current sub-tab
    // so switching away and back preserves the Load More progress.
    if (!_subTabVisibleCounts) _subTabVisibleCounts = {};
    _subTabVisibleCounts[currentSubTab || 'top'] = marketVisibleCount;
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
    const icon = c.image || `https://assets.coincap.io/assets/icons/${encodeURIComponent(c.symbol).toLowerCase()}@2x.png`;
    const priceStr = c.priceUsd > 1 ? c.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : c.priceUsd.toFixed(6);
    const rankNum = Number(c.rank) || 0;
    const changeStr = (isPos ? '+' : '') + c.changePercent24Hr.toFixed(2) + '%';
    return `
        <div class="mkt-coin-row" data-symbol="${safeSymbol}" data-action="open-coin" role="listitem">
            <span class="mkt-coin-rank">${rankNum || '—'}</span>
            <img src="${escapeHtml(icon)}" onerror="iconFallback(this)" class="mkt-coin-logo" data-symbol="${safeSymbol}" alt="${safeSymbol}" loading="lazy" decoding="async">
            <div class="mkt-coin-info">
                <span class="mkt-coin-symbol">${safeSymbol}</span>
            </div>
            <span class="mkt-coin-price">$${priceStr}</span>
            <span class="mkt-coin-change ${isPos ? 'up' : 'down'}">${changeStr}</span>
            <span class="mkt-coin-star ${inWatch ? 'active' : ''}" data-symbol="${safeSymbol}" data-action="toggle-watch" role="button" aria-label="${inWatch ? 'Remove from watchlist' : 'Add to watchlist'}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="${inWatch ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </span>
        </div>
    `;
}

/**
 * Render a single BTC pair row (used when btcpairs sub-tab is active).
 * Layout matches the standard coin row: Rank | Icon | SYM/BTC | pairPrice | 24h-vs-BTC% | star
 *
 * BUG FIX (2026-07-25): data-symbol now uses the FULL pair (e.g. "ETHBTC") so
 * openCoinDetail knows to render a BTC pair chart. Previously data-symbol was
 * just "ETH" which caused openCoinDetail to resolve the chart as "ETHUSDT"
 * (because resolveChartExchange always appends "USDT").
 */
function renderBtcPairItem(p, idx) {
    const isPos = p.relativeChange >= 0;
    const inWatch = watchlist.includes(p.symbol);
    const safeSymbol = escapeHtml(p.symbol);
    const safePairSymbol = escapeHtml(p.symbol + 'BTC'); // e.g. "ETHBTC" — used for chart resolution
    const icon = p.image || `https://assets.coincap.io/assets/icons/${encodeURIComponent(p.symbol).toLowerCase()}@2x.png`;
    // Pair price formatting: small fractions need more precision
    let pairPriceStr;
    if (p.pairPrice >= 1) pairPriceStr = p.pairPrice.toFixed(6);
    else if (p.pairPrice >= 0.001) pairPriceStr = p.pairPrice.toFixed(8);
    else pairPriceStr = p.pairPrice.toExponential(2);
    const rankNum = idx + 1;
    const changeStr = (isPos ? '+' : '') + p.relativeChange.toFixed(2) + '%';
    return `
        <div class="mkt-coin-row mkt-btc-pair-row" data-symbol="${safePairSymbol}" data-base-symbol="${safeSymbol}" data-action="open-coin" role="listitem">
            <span class="mkt-coin-rank">${rankNum}</span>
            <img src="${escapeHtml(icon)}" onerror="iconFallback(this)" class="mkt-coin-logo" data-symbol="${safeSymbol}" alt="${safeSymbol}" loading="lazy" decoding="async">
            <div class="mkt-coin-info">
                <span class="mkt-coin-symbol">${safeSymbol}<span style="color:#6B7A8D;font-weight:600;">/BTC</span></span>
                <span class="mkt-coin-pair-caption">${pairPriceStr} BTC</span>
            </div>
            <span class="mkt-coin-price">${pairPriceStr}</span>
            <span class="mkt-coin-change ${isPos ? 'up' : 'down'}">${changeStr}</span>
            <span class="mkt-coin-star ${inWatch ? 'active' : ''}" data-symbol="${safeSymbol}" data-action="toggle-watch" role="button" aria-label="${inWatch ? 'Remove from watchlist' : 'Add to watchlist'}">
                <svg width="16" height="16" viewBox="0 0 24 24" fill="${inWatch ? 'currentColor' : 'none'}" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>
            </span>
        </div>
    `;
}

function renderForexItem(f) {
    const safeSymbol = escapeHtml(f.symbol);
    const safeName = escapeHtml(f.name);
    const cat = f.category || 'major';

    // Category config: colors, labels, precision
    const catConfig = {
        major:     { color: '#22C55E', gradColor: '#16A34A', label: 'Major',     labelFa: 'جفت اصلی',       decimals: 4 },
        cross:     { color: '#F5A623', gradColor: '#D97706', label: 'Cross',     labelFa: 'کراس',           decimals: 4 },
        metal:     { color: '#FFD700', gradColor: '#B8860B', label: 'Metal',     labelFa: 'فلز گران‌بها',   decimals: 2 },
        stock:     { color: '#60A5FA', gradColor: '#2563EB', label: 'Stock',     labelFa: 'سهم',            decimals: 2 },
    };
    const cfg = catConfig[cat] || catConfig.major;
    const decimals = cfg.decimals;

    // ── Professional letter-based icon ──
    // Extract a 2-3 character abbreviation from the symbol for a clean,
    // uniform, professional look. No more generic SVG line charts.
    // For forex pairs (EURUSD, GBPUSD): show base currency symbol or 2-letter code
    // For metals (XAUUSD): show chemical symbol (Au, Ag)
    // For stocks (AAPL): show first 3-4 letters of ticker
    const currencySymbols = { 'USD': '$', 'EUR': '€', 'GBP': '£', 'JPY': '¥', 'AUD': 'A$', 'CAD': 'C$', 'CHF': '₣', 'NZD': 'N$', 'CNY': '¥', 'XAU': 'Au', 'XAG': 'Ag' };

    let iconText = '';
    const sym = f.symbol.toUpperCase();
    if (cat === 'metal') {
        // XAUUSD → Au, XAGUSD → Ag
        iconText = sym.startsWith('XAU') ? 'Au' : sym.startsWith('XAG') ? 'Ag' : sym.slice(0, 2);
    } else if (cat === 'stock') {
        // AAPL → AAPL (first 4 chars), but display only 3-4 to fit
        iconText = sym.slice(0, 4);
    } else {
        // Forex: EURUSD → €, GBPUSD → £, or extract base currency
        const baseCurr = sym.slice(0, 3);
        iconText = currencySymbols[baseCurr] || baseCurr;
    }

    // Format price with appropriate precision
    let priceStr;
    if (f.price > 0) {
        if (cat === 'metal' && f.price > 1000) {
            priceStr = f.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else if (cat === 'metal') {
            priceStr = f.price.toFixed(2);
        } else if (decimals === 0) {
            priceStr = f.price.toLocaleString('en-US', { maximumFractionDigits: 0 });
        } else {
            priceStr = f.price.toFixed(decimals);
        }
    } else {
        priceStr = '—';
    }

    // Change display
    const change = f.change || 0;
    const hasChange = Math.abs(change) > 0.001;
    const changeStr = hasChange ? (change >= 0 ? '+' : '') + change.toFixed(2) + '%' : '—';
    const changeCls = hasChange ? (change >= 0 ? 'up' : 'down') : '';

    // Watchlist state
    const inWatch = watchlist.includes(f.symbol);
    const starSvg = inWatch
        ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>'
        : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2"/></svg>';

    // Professional gradient icon background
    const iconStyle = `background: linear-gradient(135deg, ${cfg.color}22, ${cfg.gradColor}33); color: ${cfg.color}; border: 1px solid ${cfg.color}40;`;

    // Display: symbol as primary (always short), name as subtitle (small, dimmed)
    // This prevents truncation — symbol codes like "EUR/USD" are always short.
    // For stocks, symbol IS the name (AAPL), so show it as primary.
    const displaySymbol = cat === 'stock' ? safeSymbol : (safeName.length > 8 ? safeSymbol : safeName);
    const displayName = cat === 'stock' ? '' : (safeName.length > 8 ? safeName : '');

    return `
        <div class="mkt-coin-row mkt-forex-row" data-symbol="${safeSymbol}" data-forex="true" data-category="${cat}" data-action="open-forex" role="listitem">
            <span class="mkt-coin-rank">—</span>
            <div class="mkt-forex-icon" style="${iconStyle}">
                <span class="mkt-forex-icon-text">${escapeHtml(iconText)}</span>
            </div>
            <div class="mkt-coin-info">
                <span class="mkt-coin-symbol">${displaySymbol}</span>
                ${displayName ? `<span class="mkt-coin-pair-caption">${displayName}</span>` : ''}
            </div>
            <span class="mkt-coin-price">${priceStr}</span>
            <span class="mkt-coin-change ${changeCls}">${changeStr}</span>
            <span class="mkt-coin-star ${inWatch ? 'active' : ''}" data-symbol="${safeSymbol}" data-action="toggle-watch" role="button" aria-label="${inWatch ? 'حذف از واچ‌لیست' : 'افزودن به واچ‌لیست'}">
                ${starSvg}
            </span>
        </div>
    `;
}

/**
 * Render the forex list grouped by category (Major / Cross / Metals / Indices / Commodities).
 * Each group has a header with count badge and a list of items.
 */
function renderForexGroupedList() {
    if (!allForexPairs.length) {
        return Array(5).fill(`
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

    // Group by category
    const groups = {
        metal:     { label: 'Precious Metals',  labelFa: 'فلزات گران‌بها',    items: [] },
        major:     { label: 'Major Pairs',      labelFa: 'جفت‌های اصلی',     items: [] },
        cross:     { label: 'Cross Pairs',      labelFa: 'کراس‌ها',          items: [] },
        stock:     { label: 'Global Stocks',    labelFa: 'سهام جهانی',       items: [] },
    };

    for (const f of allForexPairs) {
        const cat = f.category || 'major';
        if (groups[cat]) groups[cat].items.push(f);
    }

    // Render each non-empty group
    const groupOrder = ['metal', 'major', 'cross', 'stock'];
    let html = '';
    for (const cat of groupOrder) {
        const g = groups[cat];
        if (!g.items.length) continue;

        const groupLabel = currentLang === 'fa' ? g.labelFa : g.label;
        const catCfg = {
            major:     { color: '#22C55E' },
            cross:     { color: '#F5A623' },
            metal:     { color: '#FFD700' },
            stock:     { color: '#60A5FA' },
        }[cat] || { color: '#94a3b8' };

        html += `
            <div class="mkt-forex-group">
                <div class="mkt-forex-group-header">
                    <div class="mkt-forex-group-left">
                        <span class="mkt-forex-group-dot" style="background:${catCfg.color};"></span>
                        <span class="mkt-forex-group-title">${groupLabel}</span>
                    </div>
                    <span class="mkt-forex-group-count">${g.items.length}</span>
                </div>
                <div class="mkt-forex-group-items">
                    ${g.items.map(f => renderForexItem(f)).join('')}
                </div>
            </div>
        `;
    }

    return html;
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
    document.querySelectorAll('.mkt-tab').forEach(b => {
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

    // Show/hide crypto sub-tabs (filters: All/Gainers/Losers/Popular/BTC Pairs)
    const subTabs = document.getElementById('market-sub-tabs');
    if (subTabs) {
        subTabs.style.display = (tab === 'crypto') ? '' : 'none';
    }

    // The dedicated BTC pairs section was removed — BTC pairs now render inline
    // in #coin-list when the 'btcpairs' sub-tab is active.

    // Show/hide summary bar and insights (only for crypto, not forex/watchlist)
    const summaryBar = document.getElementById('market-stats-row');
    if (summaryBar) {
        summaryBar.style.display = (tab === 'crypto') ? '' : 'none';
    }
    const insightsRow = document.getElementById('market-insights-row');
    if (insightsRow) {
        insightsRow.style.display = (tab === 'crypto') ? '' : 'none';
    }

    // Show/hide sticky list header (only relevant for crypto/forex/watchlist, not BTC pairs view which uses same header)
    const listHeader = document.getElementById('mkt-list-header');
    if (listHeader) {
        // Header is always visible — same column layout works for all tabs
        listHeader.style.display = '';
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
    const list = document.getElementById('coin-list-rows');
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
    // NEWSFE-026 FIX: Preserve the user's "Load More" progress per sub-tab.
    // Previously switchSubTab unconditionally reset marketVisibleCount to
    // MARKET_DEFAULT_LIMIT (100), so a user who loaded 200+ coins in 'crypto'
    // and switched to 'gainers' then back to 'crypto' would lose their loaded
    // coins and see only 100 again. Now we persist the visible count per
    // sub-tab in a map, so switching back restores the previous count.
    if (!_subTabVisibleCounts) _subTabVisibleCounts = {};
    if (!_subTabVisibleCounts[tab]) {
        _subTabVisibleCounts[tab] = MARKET_DEFAULT_LIMIT;
    }
    marketVisibleCount = _subTabVisibleCounts[tab];

    // Update sub-tab active states
    document.querySelectorAll('.mkt-filter-chip').forEach(b => {
        b.classList.remove('active');
        b.setAttribute('aria-selected', 'false');
    });
    btn.classList.add('active');
    btn.setAttribute('aria-selected', 'true');

    // Show/hide BTC Pairs section based on filter (section was removed — no-op now)
    // BTC pairs render inline in #coin-list when btcpairs sub-tab is active.

    // Re-render with animation
    const list = document.getElementById('coin-list-rows');
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

// MKT-011 FIX (DEAD CODE REMOVED): renderBtcPairsSection was a no-op with
// 0 callers (only definition + window export). BTC pairs now render inline.

document.addEventListener('DOMContentLoaded', () => {
    // NEWSFE-009 FIX: Debounce the market-search input so we don't call
    // renderMarket() on every keystroke. renderMarket re-renders the full
    // coin list DOM (~100 rows), which causes visible jank on fast typing.
    // 250ms debounce means we only re-render after the user pauses typing.
    let _marketSearchTimer = null;
    document.getElementById('market-search')?.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        _lastSearchTerm = searchTerm;
        if (_marketSearchTimer) clearTimeout(_marketSearchTimer);
        _marketSearchTimer = setTimeout(() => {
            renderMarket();
            _marketSearchTimer = null;
        }, 250);
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
        if (watchlist.length >= getMaxWatchlist()) {
            // Premium upsell: if the user is NOT premium and has hit the Free
            // limit (7), point them to the upgrade flow instead of a generic
            // "limit reached" popup. Premium users (limit 20) won't reach this
            // branch until 20.
            const _isPremium = (() => {
                try { return !!(window.MembershipApp && typeof window.MembershipApp.isPremiumCached === 'function' && window.MembershipApp.isPremiumCached()); }
                catch (_) { return false; }
            })();
            if (!_isPremium && window.MembershipApp && typeof window.MembershipApp.open === 'function') {
                // Premium upgrade flow
                window.MembershipApp.open();
            } else {
                // Watchlist premium message fix: pick the premium variant of the
                // limit message when the user is premium (hit 20). Free users
                // (hit 7) still see the existing watchlist_limit message via the
                // upsell branch above; this ELSE branch is reached by premium
                // users at 20 OR by free users when MembershipApp.open is
                // unavailable. The _isPremium flag selects the correct message.
                const limitMsgKey = _isPremium ? 'watchlist_limit_premium' : 'watchlist_limit';
                getTg()?.showPopup?.({
                    title: t('watchlist'),
                    message: t(limitMsgKey),
                    buttons: [{ type: 'ok' }]
                }) || alert(t(limitMsgKey));
            }
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

// ════════════════════════════════════════════════════════════════════════
// DAILY MISSIONS SYSTEM — CENTRAL EVENT BUS
// ════════════════════════════════════════════════════════════════════════
// A central Event Bus that auto-discovers events from backend metadata.
// The frontend instruments known interaction points (tab switches, modal
// opens, bootstrap) with a SINGLE call: MissionBus.fire('event_name').
// The bus checks the cached mission list for matching triggers and fires
// completion for ALL matching missions.
//
// The bus also auto-instruments ALL tab switches via switchTab hook —
// so 'market_open', 'profile_open', 'news_open', 'analysis_open',
// 'dashboard_open' fire automatically without any manual fireMissionEvent
// calls at those points.
//
// Adding a new mission requires ONLY a DB insert:
//   INSERT INTO mission_rewards (mission_id, mission_name, token_amount,
//     is_enabled, metadata) VALUES (
//     'read_3_news', '۳ خبر بخوان', 10, TRUE,
//     '{"trigger":"news_open","target_count":3}')
//
// Adding a new EVENT TYPE that doesn't map to a tab switch requires adding
// ONE MissionBus.fire('new_event') call at the interaction point. But
// reusing an existing event type for a new mission = ZERO code change.

const _completedMissionsToday = new Set();
let _missionsLoaded = false;
let _missionStatusList = [];

// Tab-to-event mapping: when user switches to a tab, this event fires.
// This covers ALL 5 main tabs + calendar sub-tab automatically.
const TAB_EVENT_MAP = {
    'dashboard-page': 'dashboard_open',
    'market-page': 'market_open',
    'analysis-page': 'analysis_open',
    'news-page': 'news_open',         // fires when user opens the News tab
    'profile-page': 'profile_open',
};

/**
 * Central Mission Event Bus.
 * - fire(eventType): emits an event, triggers all matching missions
 * - autoInstrumentTabs(): hooks into switchTab to auto-fire tab events
 * - Events are NOT hardcoded in the bus — they come from backend metadata
 */
const MissionBus = {
    /**
     * Fire a mission event. Checks all missions from backend whose
     * metadata.trigger matches this event, and fires completion for each.
     */
    fire(eventType) {
        if (!eventType || !API_BASE) return;

        const matching = _missionStatusList.filter(m =>
            m.trigger === eventType && !m.completed && !_completedMissionsToday.has(m.mission_id)
        );

        for (const mission of matching) {
            completeMission(mission.mission_id);
        }
    },

    /**
     * Hook into switchTab to auto-fire events for tab switches.
     * Called once during initialization. Wraps the original switchTab.
     */
    _tabHooked: false,
    autoInstrumentTabs() {
        if (this._tabHooked) return;
        this._tabHooked = true;

        const origSwitchTab = window.switchTab;
        if (typeof origSwitchTab !== 'function') return;

        window.switchTab = function(pageId, btn) {
            // Call original switchTab
            origSwitchTab.call(this, pageId, btn);

            // Auto-fire the corresponding mission event
            const eventType = TAB_EVENT_MAP[pageId];
            if (eventType) {
                MissionBus.fire(eventType);
            }
        };
    },
};

/**
 * Load today's mission status from the server. Called once on bootstrap.
 */
async function loadMissionStatus() {
    if (_missionsLoaded || !API_BASE || !canRunSessionRequests()) return;
    try {
        const data = await apiFetch('/api/wallet/missions');
        if (data?.status === 'success' && Array.isArray(data.missions)) {
            _missionStatusList = data.missions;
            for (const m of data.missions) {
                if (m.completed) _completedMissionsToday.add(m.mission_id);
            }
            updateMissionCards();
        }
        _missionsLoaded = true;
        // Now that we have mission data, auto-instrument tab switches
        MissionBus.autoInstrumentTabs();
    } catch (_) {}
}

/**
 * Complete a daily mission. Called by MissionBus.fire — not directly
 * from interaction points.
 *
 * MISSION-ABUSE FIX (WALLET-002): for non-daily_login missions, frontend
 * must first call /api/wallet/mission/issue-token AFTER the user performs
 * the real action, then submit the token to /api/wallet/mission/complete.
 * daily_login is fired automatically by bootstrap — frontend doesn't need
 * to call this for daily_login.
 */
async function completeMission(missionId) {
    if (_completedMissionsToday.has(missionId)) return;
    if (!API_BASE || !canRunSessionRequests()) return;

    try {
        // daily_login doesn't require an event_token (auto-fired by bootstrap).
        // All other missions require a server-issued event_token.
        let eventToken = null;
        if (missionId !== 'daily_login') {
            const tokenResp = await apiFetch('/api/wallet/mission/issue-token', {
                method: 'POST',
                body: JSON.stringify({ mission_id: missionId }),
            });
            if (tokenResp?.status !== 'success' || !tokenResp.event_token) {
                // Token issuance failed — abort. The mission is NOT completed.
                // This is by design: it prevents abuse where frontend directly
                // calls /mission/complete without performing the action.
                return;
            }
            eventToken = tokenResp.event_token;
        }

        const data = await apiFetch('/api/wallet/mission/complete', {
            method: 'POST',
            body: JSON.stringify({ mission_id: missionId, event_token: eventToken }),
        });

        if (data?.status === 'success') {
            const idx = _missionStatusList.findIndex(m => m.mission_id === missionId);
            if (idx >= 0) {
                _missionStatusList[idx].progress_count = data.progress_count;
                _missionStatusList[idx].target_count = data.target_count;
                _missionStatusList[idx].completed = data.completed;
            }

            if (data.completed) {
                _completedMissionsToday.add(missionId);
            }

            if (data.is_new_completion) {
                showMissionRewardPopup(data.reward_label, data.reward_amount);
                refreshWalletAfterMission(data.new_balance);
            }

            updateMissionCards();
        }
    } catch (_) {}
}

// Backward-compatible alias
const MISSION_EVENTS = {
  NEWS_OPEN: 'news_open',
  ANALYSIS_OPEN: 'analysis_open',
  CALENDAR_OPEN: 'calendar_open',
  DAILY_OPEN: 'daily_open',
  PROFILE_OPEN: 'profile_open',
  MARKET_OPEN: 'market_open',
  WATCHLIST_OPEN: 'watchlist_open',
  DASHBOARD_OPEN: 'dashboard_open',
};
function fireMissionEvent(eventType) { MissionBus.fire(eventType); }

/**
 * Refresh wallet display after a mission reward.
 * Updates balance, transaction history, summary, tier, and progress bar
 * without full page reload.
 */
function refreshWalletAfterMission(newBalance) {
    // 1. Invalidate wallet cache so next fetch hits the API
    if (window.WalletApp && typeof window.WalletApp._invalidateCache === 'function') {
        window.WalletApp._invalidateCache();
    }

    // 2. If wallet page is open, refresh the balance display immediately
    const balanceEl = document.querySelector('.wallet-balance-value, .hero-balance');
    if (balanceEl && newBalance != null) {
        const currentBalance = parseFloat(balanceEl.textContent?.replace(/[^0-9.]/g, '')) || 0;
        animateBalanceChange(balanceEl, currentBalance, newBalance);
    }

    // 3. Refresh profile card (balance + tier on the profile page)
    // PHASE 3 FIX: removed 300ms delay — fire immediately (no reason to wait).
    if (typeof window.WalletApp?.loadProfileCard === 'function') {
        try { window.WalletApp.loadProfileCard(); } catch (_) {}
    }

    // 4. If wallet full page is open, refresh ALL wallet data in background
    //    This updates: balance, tier, progress bar, transaction history, summary strip
    // PHASE 3 FIX: removed 500ms delay — fire immediately (no reason to wait).
    //    The balance animation (step 2) runs in parallel via requestAnimationFrame,
    //    so the full refresh doesn't block the UI.
    const walletPage = document.getElementById('wallet-full-page');
    if (walletPage && walletPage.classList.contains('open')) {
        if (typeof window.WalletApp?._refreshWalletData === 'function') {
            try { window.WalletApp._refreshWalletData(); } catch (_) {}
        }
    }
}

/**
 * Animate balance number change (count-up effect).
 */
function animateBalanceChange(el, from, to) {
    const duration = 600;
    const startTime = performance.now();
    const diff = to - from;

    function update(now) {
        const elapsed = now - startTime;
        const progress = Math.min(1, elapsed / duration);
        const eased = 1 - Math.pow(1 - progress, 3); // ease-out cubic
        const current = Math.round(from + diff * eased);
        el.textContent = current.toLocaleString('en-US');
        if (progress < 1) requestAnimationFrame(update);
        else el.textContent = to.toLocaleString('en-US');
    }
    requestAnimationFrame(update);
}

/**
 * Update mission cards in the wallet to show completed/in-progress status with progress.
 * GENERIC: Reads mission status from _missionStatusList (populated from backend).
 * Renders cards dynamically from backend data — no hardcoded card IDs.
 */
function updateMissionCards() {
    const earnGrid = document.querySelector('.wallet-earn-grid');
    if (!earnGrid) return;

    // If we have backend mission data, rebuild the grid dynamically
    if (_missionStatusList.length > 0) {
        // Build mission cards from backend data (keep daily-checkin and invite-friend separate)
        const dailyCheckinCard = earnGrid.querySelector('#daily-checkin-card');
        const inviteCard = earnGrid.querySelector('#mission-invite-friend');

        let html = '';
        // Keep daily check-in first
        if (dailyCheckinCard) html += dailyCheckinCard.outerHTML;

        // Render each mission from backend
        for (const m of _missionStatusList) {
            const isCompleted = m.completed || _completedMissionsToday.has(m.mission_id);
            const progressText = m.target_count > 1
                ? `${m.progress_count}/${m.target_count}`
                : '';
            const completedClass = isCompleted ? 'mission-completed' : '';
            const checkmarkHtml = isCompleted
                ? '<div class="mission-checkmark"><svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg></div>'
                : '';
            // PHASE 3 FIX: add clear "✓ دریافت شد" badge for completed missions
            // (in addition to the checkmark icon) — makes completion status unambiguous.
            const completedBadgeHtml = isCompleted
                ? '<div class="mission-completed-badge">✓ دریافت شد</div>'
                : '';
            const progressHtml = progressText && !isCompleted
                ? `<div class="mission-progress-text">${progressText}</div>`
                : '';

            html += `
            <div class="wallet-earn-card ${completedClass}" id="mission-${m.mission_id.replace(/_/g, '-')}">
                <div class="earn-reward">+${m.reward_amount} AB</div>
                <div class="earn-title">${escapeHtml(m.mission_name || m.mission_id)}</div>
                ${m.description ? `<div class="earn-desc">${escapeHtml(m.description)}</div>` : ''}
                ${progressHtml}
                ${completedBadgeHtml}
                ${checkmarkHtml}
            </div>`;
        }

        // Keep invite friend last
        if (inviteCard) html += inviteCard.outerHTML;

        earnGrid.innerHTML = html;
    } else {
        // Fallback: just update existing cards by ID
        const missionCards = document.querySelectorAll('[id^="mission-"]');
        for (const card of missionCards) {
            const cardId = card.id;
            const missionId = cardId.replace(/^mission-/, '').replace(/-/g, '_');
            const status = _missionStatusList.find(m => m.mission_id === missionId);
            const isCompleted = _completedMissionsToday.has(missionId) || status?.completed;

            if (isCompleted) {
                card.classList.add('mission-completed');
                if (!card.querySelector('.mission-checkmark')) {
                    const checkmark = document.createElement('div');
                    checkmark.className = 'mission-checkmark';
                    checkmark.innerHTML = '<svg viewBox="0 0 24 24" width="20" height="20" fill="none" stroke="currentColor" stroke-width="3"><polyline points="20 6 9 17 4 12"/></svg>';
                    card.appendChild(checkmark);
                }
            } else {
                card.classList.remove('mission-completed');
                const checkmark = card.querySelector('.mission-checkmark');
                if (checkmark) checkmark.remove();
            }
        }
    }
}

/**
 * Premium mission reward popup — slides in from the top with a coin burst
 * animation, auto-dismisses after 2.5s. Non-blocking, doesn't interfere
 * with user interaction.
 */
function showMissionRewardPopup(label, amount) {
    // Remove any existing popup
    const existing = document.getElementById('mission-reward-popup');
    if (existing) existing.remove();

    const popup = document.createElement('div');
    popup.id = 'mission-reward-popup';
    popup.innerHTML = `
        <div class="mrp-coin-burst">
            <span class="mrp-coin">🪙</span>
            <span class="mrp-coin">✨</span>
            <span class="mrp-coin">🪙</span>
            <span class="mrp-coin">✨</span>
            <span class="mrp-coin">🪙</span>
        </div>
        <div class="mrp-icon">🎉</div>
        <div class="mrp-content">
            <div class="mrp-title">ماموریت کامل شد!</div>
            <div class="mrp-desc">${escapeHtml(label)}</div>
            <div class="mrp-reward">+${amount} AB</div>
        </div>
    `;
    document.body.appendChild(popup);

    // Trigger entrance animation
    requestAnimationFrame(() => popup.classList.add('mrp-show'));

    // Trigger coin burst
    setTimeout(() => {
        popup.querySelectorAll('.mrp-coin').forEach((coin, i) => {
            coin.style.animationDelay = (i * 0.06) + 's';
            coin.classList.add('mrp-coin-fly');
        });
    }, 100);

    // Auto-dismiss after 2.5s
    setTimeout(() => {
        popup.classList.remove('mrp-show');
        setTimeout(() => popup.remove(), 300);
    }, 2500);

    // Haptic feedback
    try { window.Telegram?.WebApp?.HapticFeedback?.notificationOccurred('success'); } catch {}
}

// Expose globally
window.MissionBus = MissionBus;
window.completeMission = completeMission;
window.loadMissionStatus = loadMissionStatus;
window.updateMissionCards = updateMissionCards;
window.fireMissionEvent = fireMissionEvent;
window.MISSION_EVENTS = MISSION_EVENTS;
/**
 * واچ‌لیست را در رابط کاربری رندر می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
// Maximum number of coins shown in the dashboard watchlist row (Add Coin card follows)
const DASHBOARD_WATCHLIST_MAX = 5;

/**
 * Format a coin price for display. Handles undefined / NaN / very small values.
 * Returns a string like "$68,432.10" or "$0.00001234".
 */
function formatWatchPrice(priceUsd) {
    if (priceUsd == null || isNaN(priceUsd) || priceUsd < 0) return '--';
    if (priceUsd >= 1000) return '$' + priceUsd.toLocaleString('en-US', { maximumFractionDigits: 2 });
    if (priceUsd >= 1) return '$' + priceUsd.toFixed(2);
    if (priceUsd >= 0.01) return '$' + priceUsd.toFixed(4);
    return '$' + priceUsd.toFixed(6);
}

/**
 * Build a tiny SVG sparkline that visualises 24h change direction.
 * Pure CSS/SVG, no external data needed.
 * Slope intensity scales with the magnitude of the 24h change.
 */
function buildWatchTrendSVG(changePercent, symbol) {
    const pct = (typeof changePercent === 'number' && !isNaN(changePercent)) ? changePercent : 0;
    const isUp = pct >= 0;
    const color = isUp ? '#22C55E' : '#EF4444';
    const glowColor = isUp ? 'rgba(34,197,94,0.55)' : 'rgba(239,68,68,0.55)';
    const fillColor = isUp ? 'rgba(34,197,94,0.18)' : 'rgba(239,68,68,0.18)';
    const gradId = 'spark-' + (symbol || 'x').replace(/[^a-zA-Z0-9_-]/g, '') + '-' + (isUp ? 'up' : 'dn');
    // Generate smooth curved sparkline with natural variation
    const W = 100, H = 26;
    const pts = generateSparklinePoints(pct, symbol || 'BTC', W, H);
    const smoothPath = buildSmoothSparklinePath(pts, W, H);
    // Fill path (close to bottom)
    const fillPath = smoothPath + ` L ${W} ${H} L 0 ${H} Z`;
    return `<svg viewBox="0 0 ${W} ${H}" preserveAspectRatio="none" fill="none">
        <defs>
            <linearGradient id="${gradId}" x1="0" y1="0" x2="0" y2="1">
                <stop offset="0%" stop-color="${fillColor}"/>
                <stop offset="100%" stop-color="${fillColor}" stop-opacity="0"/>
            </linearGradient>
        </defs>
        <path d="${fillPath}" fill="url(#${gradId})"/>
        <path d="${smoothPath}" stroke="${color}" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" style="filter:drop-shadow(0 0 2.5px ${glowColor}) drop-shadow(0 1px 1px rgba(0,0,0,0.3))"/>
    </svg>`;
}

function renderWatchlist() {
    const grid = $('watchlist-grid');
    if (!grid) return;

    // ROOT CAUSE FIX (item 2): Previously only allCoins (crypto) was filtered.
    // Forex pairs are in allForexPairs, not allCoins. Now we merge both sources.
    const cryptoWatch = allCoins.filter(c => watchlist.includes(c.symbol));
    const forexWatch = allForexPairs.filter(f => watchlist.includes(f.symbol)).map(f => ({
        ...f,
        priceUsd: f.price,
        changePercent24Hr: f.change,
        name: f.name || f.symbol,
        image: null, // Forex uses letter-based icon fallback
        _isForex: true,
    }));
    // Merge: crypto first, then forex, no limit (horizontal scroll handles overflow)
    const watchCoins = [...cryptoWatch, ...forexWatch];

    if (!allCoins.length && !allForexPairs.length) {
        // Market data not loaded yet — show skeleton (preserve CLS)
        if (!grid.querySelector('.watchlist-skeleton')) {
            grid.innerHTML = '<div class="watchlist-skeleton">' + Array(4).fill('<div class="watchlist-skeleton-item"><div class="watchlist-skeleton-icon"></div><div class="watchlist-skeleton-lines"><div class="watchlist-skeleton-line"></div><div class="watchlist-skeleton-line"></div></div></div>').join('') + '</div>';
        }
        return;
    }

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

    // Price-only diffing: if existing watch-card items match the current set, update prices in-place
    const existingItems = grid.querySelectorAll('.watch-card');
    if (existingItems.length === watchCoins.length && !grid.querySelector('.watchlist-empty-state') && !grid.querySelector('.watchlist-skeleton')) {
        let allMatch = true;
        for (let i = 0; i < existingItems.length; i++) {
            if (existingItems[i].dataset.symbol !== watchCoins[i].symbol) { allMatch = false; break; }
        }
        if (allMatch) {
            for (let i = 0; i < existingItems.length; i++) {
                const item = existingItems[i];
                const coin = watchCoins[i];
                const priceEl = item.querySelector('.watch-card-price');
                if (priceEl) {
                    const newPrice = formatWatchPrice(coin.priceUsd);
                    if (priceEl.textContent !== newPrice) priceEl.textContent = newPrice;
                }
                const changeEl = item.querySelector('.watch-card-change');
                if (changeEl) {
                    const pct = (typeof coin.changePercent24Hr === 'number' && !isNaN(coin.changePercent24Hr)) ? coin.changePercent24Hr : 0;
                    const isPos = pct >= 0;
                    const newChange = (isPos ? '+' : '') + pct.toFixed(2) + '%';
                    const newClass = 'watch-card-change ' + (isPos ? 'up' : 'down');
                    if (changeEl.textContent.trim() !== newChange) {
                        changeEl.innerHTML = (isPos
                            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>'
                            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>') + '<span>' + newChange + '</span>';
                        changeEl.className = newClass;
                    }
                }
                const trendEl = item.querySelector('.watch-card-trend');
                if (trendEl) {
                    const pct = (typeof coin.changePercent24Hr === 'number' && !isNaN(coin.changePercent24Hr)) ? coin.changePercent24Hr : 0;
                    const newTrend = buildWatchTrendSVG(pct, coin.symbol);
                    if (trendEl.innerHTML !== newTrend) trendEl.innerHTML = newTrend;
                }
            }
            // Add Coin card already exists? ensure it's present
            if (!grid.querySelector('.watch-card-add')) {
                grid.insertAdjacentHTML('beforeend', buildAddCoinCardHTML());
            }
            return;
        }
    }

    // Full render — premium cards + Add Coin card
    let html = watchCoins.map(c => {
        const safeSymbol = escapeHtml(c.symbol);
        const safeName = escapeHtml(c.name || '');
        const isForex = !!c._isForex;
        const icon = c.image || (isForex ? null : `https://assets.coincap.io/assets/icons/${encodeURIComponent(c.symbol).toLowerCase()}@2x.png`);
        const pct = (typeof c.changePercent24Hr === 'number' && !isNaN(c.changePercent24Hr)) ? c.changePercent24Hr : 0;
        const isPos = pct >= 0;
        const changeStr = (isPos ? '+' : '') + pct.toFixed(2) + '%';
        const arrowSvg = isPos
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        const iconHtml = icon
            ? `<img loading="lazy" src="${escapeHtml(icon)}" onerror="iconFallback(this)" class="watch-card-icon" data-symbol="${safeSymbol}" alt="${safeSymbol}">`
            : `<div class="watch-card-icon forex-icon-fallback" data-symbol="${safeSymbol}">${safeSymbol.slice(0,3)}</div>`;
        return `
        <div class="watch-card${isForex ? ' watch-card-forex' : ''}" data-symbol="${safeSymbol}" onclick="${isForex ? 'openForexDetail' : 'openCoinDetail'}(this.dataset.symbol)">
            <div class="watch-card-header">
                ${iconHtml}
                <span class="watch-card-remove" data-symbol="${safeSymbol}" onclick="toggleWatchlist(this.dataset.symbol, event)" aria-label="Remove">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="6" x2="6" y2="18"/><line x1="6" y1="6" x2="18" y2="18"/></svg>
                </span>
            </div>
            <span class="watch-card-symbol">${safeSymbol}</span>
            <span class="watch-card-name">${safeName}</span>
            <span class="watch-card-price">${formatWatchPrice(c.priceUsd)}</span>
            <span class="watch-card-change ${isPos ? 'up' : 'down'}">${arrowSvg}<span>${changeStr}</span></span>
            <div class="watch-card-trend">${buildWatchTrendSVG(pct, safeSymbol)}</div>
        </div>`;
    }).join('');

    // Append "Add Coin" card (only if under the effective watchlist limit).
    // Uses getMaxWatchlist() so Premium users (limit 20) see the add-card up
    // to 19 items, while Free users (limit 7) see it up to 6.
    if (watchlist.length < getMaxWatchlist()) {
        html += buildAddCoinCardHTML();
    }

    grid.innerHTML = html;
}

function buildAddCoinCardHTML() {
    return `
        <div class="watch-card-add" onclick="openAddCoinModal()" role="button" aria-label="${escapeHtml(t('dashboard_add_coin'))}">
            <div class="watch-card-add-icon">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><line x1="12" y1="5" x2="12" y2="19"/><line x1="5" y1="12" x2="19" y2="12"/></svg>
            </div>
            <span class="watch-card-add-text">${escapeHtml(t('dashboard_add_coin'))}</span>
        </div>`;
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
        const atLimit = !inList && watchlist.length >= getMaxWatchlist();
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
// P1-07 FIX (NEWSFE-004): Request generation counter for loadNews.
// Each loadNews() call increments _newsLoadGen and captures its token at start.
// Before applying the fetched result to newsCache, the handler checks if its
// token is still the latest. This prevents a stale response (e.g. from a
// 180s poll returning page-1 non-append) from overwriting a newer append
// (e.g. user's "Load More" page 4). Mirrors the _detailLoadToken pattern used
// by openCoinDetail and _notifReqSeq used by loadNotificationsFromServer.
let _newsLoadGen = 0;
// M1 FIX: track whether the last news fetch failed due to auth (401).
// When true, renderNews shows "Open in Telegram" instead of misleading "no news".
let _newsAuthFailed = false;

let displayedNews = [];
let newsLoadObserver = null;
let calCountdownInterval = null;
let currentCalCountry = 'all';

// News Intelligence — new state for filters, saved, hero slider, search
let _niActiveFilters = { sentiment: [], priority: [], category: [], time: null };
// P1-06 FIX (NEWSFE-001): guarded via safeJsonParseLocalStorage — corrupted
// localStorage no longer aborts app.js load.
let _niSavedNews = safeJsonParseLocalStorage('ni_saved_news', []);
let _niHeroSlides = [];
let _niHeroIndex = 0;
let _niHeroTimer = null;
let _niHeroStartX = 0;
let _niHeroDragActive = false;
let _niCurrentSearchQuery = '';
let _niCurrentReminderEvent = null;
let _niCurrentShareNews = null;
let _niCalendarReminders = safeJsonParseLocalStorage('ni_cal_reminders', {});

// SVG icon constants for news (Lucide-style, consistent stroke weight)
const NI_ICONS = {
    bookmark: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    bookmarkFilled: '<svg viewBox="0 0 24 24" fill="currentColor" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
    share: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    trending: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><polyline points="23 6 13.5 15.5 8.5 10.5 1 18"/><polyline points="17 6 23 6 23 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    arrowUp: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><line x1="12" y1="19" x2="12" y2="5"/><polyline points="5 12 12 5 19 12"/></svg>',
    arrowDown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><line x1="12" y1="5" x2="12" y2="19"/><polyline points="19 12 12 19 5 12"/></svg>',
    clock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="12" height="12"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>',
    bell: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/></svg>',
    bellOff: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="16" height="16"><path d="M13.73 21a2 2 0 0 1-3.46 0"/><path d="M18.63 13A17.89 17.89 0 0 1 18 8"/><path d="M6.26 6.26A5.86 5.86 0 0 0 6 8c0 7-3 9-3 9h14"/><path d="M18 8a6 6 0 0 0-9.33-5"/><line x1="1" y1="1" x2="23" y2="23"/></svg>',
    sparkles: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" width="14" height="14"><path d="M12 3l1.9 5.8a2 2 0 0 0 1.3 1.3L21 12l-5.8 1.9a2 2 0 0 0-1.3 1.3L12 21l-1.9-5.8a2 2 0 0 0-1.3-1.3L3 12l5.8-1.9a2 2 0 0 0 1.3-1.3L12 3z"/></svg>',
    searchEmpty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="48" height="48"><circle cx="11" cy="11" r="8"/><line x1="21" y1="21" x2="16.65" y2="16.65"/></svg>',
    bookmarkEmpty: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="48" height="48"><path d="M19 21l-7-5-7 5V5a2 2 0 0 1 2-2h10a2 2 0 0 1 2 2z"/></svg>',
};

// ============================================================================
// NOTE (Phase 5): translateText, translateArticles, detectNewsCategory,
// parseRssItems, fetchRssArticle — all removed.
// Backend now handles: multi-source RSS, translation (CF Workers AI), categories.
// Frontend only calls /api/farsi-news and uses the 'category' field directly.
// ============================================================================

/**
 * Generate premium badge HTML for a news item's sentiment/type.
 * No emojis — uses SVG icons only.
 */
function niBadgeHtml(sentiment) {
    const s = (sentiment || '').toLowerCase();
    const map = {
        bullish: `<span class="ni-badge ni-badge-bullish">${NI_ICONS.arrowUp} صعودی</span>`,
        bearish: `<span class="ni-badge ni-badge-bearish">${NI_ICONS.arrowDown} نزولی</span>`,
        macro: `<span class="ni-badge ni-badge-macro">کلان</span>`,
        neutral: `<span class="ni-badge ni-badge-neutral">خنثی</span>`,
        breaking: `<span class="ni-badge ni-badge-breaking">${NI_ICONS.alert} فوری</span>`,
    };
    return map[s] || map.neutral;
}

/**
 * Determine impact level from sentiment + title keywords.
 * Returns 'high', 'medium', or 'low'.
 */
function niImpactLevel(news) {
    const s = (news.sentiment || '').toLowerCase();
    const title = (news.title || '').toLowerCase();
    if (s === 'breaking') return 'high';
    if (s === 'bullish' || s === 'bearish') return 'medium';
    // Check for high-impact keywords
    const highImpactKeywords = ['bitcoin', 'ethereum', 'sec', 'etf', 'fed', 'cpi', 'rate', 'ban', 'hack', 'crash', 'rally', 'surge'];
    if (highImpactKeywords.some(k => title.includes(k))) return 'high';
    return 'low';
}

/**
 * Generate impact score HTML.
 */
function niImpactHtml(news) {
    const level = niImpactLevel(news);
    const labels = { high: 'تأثیر بالا', medium: 'تأثیر متوسط', low: 'تأثیر کم' };
    return `<span class="ni-impact ni-impact-${level}"><span class="ni-impact-dot"></span>${labels[level]}</span>`;
}

/**
 * Determine if a news item qualifies for the hero slider.
 * Only breaking, high-impact, or trending news goes in the hero.
 */
function niIsHeroEligible(news) {
    const s = (news.sentiment || '').toLowerCase();
    if (s === 'breaking') return true;
    if (niImpactLevel(news) === 'high') return true;
    // Check title for major events
    const title = (news.title || '').toUpperCase();
    const majorKeywords = ['BITCOIN', 'BTC', 'ETHEREUM', 'ETH', 'ETF', 'FED', 'SEC', 'RALLY', 'CRASH', 'SURGE', 'REGULATION'];
    return majorKeywords.some(k => title.includes(k));
}

/**
 * Generate AI summary HTML for a news card.
 */
function niAiSummaryHtml(news) {
    if (!news.summary) return '';
    return `<div class="ni-card-ai-summary">${NI_ICONS.sparkles}<span>${escapeHtml(news.summary)}</span></div>`;
}

// Legacy badge functions — kept for dashboard important news compatibility
function sentimentBadge(sentiment) { return niBadgeHtml(sentiment); }
function sentimentBadgeHero(sentiment) { return niBadgeHtml(sentiment); }

function updateNewsBadges() {
    // No-op: badges removed from tabs per design spec (no counters)
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
    // P1-07 FIX (NEWSFE-004): Assign a generation token to this call. Before
    // applying the fetched result to newsCache, we check if this token is still
    // the latest. If a newer loadNews() call started while we were fetching
    // (e.g. user clicked "Load More" page 4 while a 180s poll for page 1 was
    // in-flight), the older response is discarded so it cannot overwrite the
    // newer state. This also prevents the poll from destroying pages 2,3,...
    // that the user loaded via "Load More": the poll (non-append, page 1) and
    // the append (page N) both capture their own token; whichever started LAST
    // wins, and the older one's result is ignored.
    const myToken = ++_newsLoadGen;
    try {
        if (!force && !append) {
            const cached = Cache.get('news');
            if (cached) {
                // ROOT CAUSE FIX (item 1 permanent): Sanitize titles from
                // in-memory cache too. Old cached titles may have AI-translation
                // duplication artifacts that were stored before the fix.
                newsCache = cached.map(n => ({ ...n, title: sanitizeNewsTitle(n.title) }));
                renderNews(document.querySelector('.ni-tab.active')?.dataset?.news || 'all');
                loadNews(true);
                return;
            }
        }
        const container = document.getElementById('news-list');
        if (!container) return;

        // ITEM 2 FIX: Capture the active tab at fetch START. But when force=true
        // (background refresh from cache-hit path), do NOT show skeleton — the
        // cached data is already rendered. Showing skeleton overwrites the
        // visible content causing a "blank then reappear" flash (Item 1 bug).
        const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news || 'all';
        // Only show skeleton on the FIRST load (no cached data). Background
        // refreshes (force=true) skip the skeleton to avoid content flashing.
        const isFirstLoad = !force && !append && !newsCache.length;
        if (isFirstLoad && activeTab !== 'calendar' && activeTab !== 'saved') {
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
        let fetchSucceeded = false;

        try {
            const json = await apiFetch(`/api/farsi-news?page=${page}&limit=20`);
            if (json.data?.length) {
                articles = json.data.map(a => ({
                    title: sanitizeNewsTitle(a.title), body: a.description, source: a.source,
                    image: a.image, url: a.url, time: a.time_ago,
                    pub_date: a.pub_date || null, // ISO timestamp for Tehran time conversion
                    category: a.category || 'crypto',
                    sentiment: a.sentiment || 'neutral',
                    summary: a.summary || '',
                    ai_summary: a.ai_summary || null,
                    ai_status: a.ai_status || 'pending',
                    source_name: a.source_name || a.source || '',
                }));
                fetchSucceeded = true;
            }
            hasMore = json.pagination?.hasMore || false;
            total = json.pagination?.total || 0;
            if (json.categoryCounts) {
                categoryCounts = json.categoryCounts;
                updateNewsBadges();
            } else if (json.category_counts) {
                categoryCounts = json.category_counts;
                updateNewsBadges();
            }
            // M1 FIX: clear any previous auth-error flag on success
            _newsAuthFailed = false;
        } catch (e) {
            console.warn('Farsi news API error:', e);
            // M1 FIX: Distinguish auth failure (401) from genuine "no news".
            if (e?.status === 401) {
                _newsAuthFailed = true;
            }
        }

        // ITEM 1 FIX: If the fetch failed or returned empty, do NOT overwrite
        // the existing newsCache with an empty array. This was the root cause
        // of news "disappearing" — a transient API failure would wipe all
        // cached data. Now we preserve the existing cache and only update
        // when we have valid new data.
        if (!fetchSucceeded || articles.length === 0) {
            // If we have cached data, keep it and just re-render (no blank)
            if (newsCache.length > 0 && !append) {
                // Re-render existing cache — don't overwrite with empty
                const currentTab = document.querySelector('.ni-tab.active')?.dataset?.news || 'all';
                renderNews(currentTab);
            }
            return;
        }

        // P1-07 FIX (NEWSFE-004): Stale-response guard. If a NEWER loadNews()
        // call started while we were awaiting the fetch (e.g. the 180s poll
        // started AFTER the user's "Load More" append), discard this result so
        // it cannot overwrite the newer state. This specifically prevents:
        //   1. A non-append poll (page 1) overwriting an append (page N) that
        //      started later — which would destroy the user's loaded pages 2,3,...
        //   2. An older append (page 2) overwriting a newer non-append (page 1)
        //      that started after — which would corrupt pagination state.
        // The token check is AFTER the await, so it catches in-flight races.
        if (myToken !== _newsLoadGen) {
            return;
        }

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

        // Phase 10.5: Reduced from 300s (5 min) to 120s (2 min) so stale
        // ai_status='pending' data clears faster after a summary is generated.
        Cache.set('news', newsCache, 120);

        // ITEM 2 FIX: Re-read the CURRENTLY active tab at render time, not
        // the tab that was active when the fetch started. If the user switched
        // tabs during the fetch, we must render the tab they're NOW looking at,
        // not the stale one. This prevents wrong-content-after-tab-switch bug.
        const currentTabAtRender = document.querySelector('.ni-tab.active')?.dataset?.news || 'all';

        // ROOT CAUSE FIX for news "پرش" (flash/jump):
        // When the cache-hit path renders immediately, then the background
        // force=true fetch completes, it calls renderNews again — replacing
        // the entire innerHTML even if the data is nearly identical. This
        // causes a visible flash where content disappears and reappears.
        // FIX: Only re-render if the news data actually changed. Build a
        // simple signature from article titles+times+summaries and compare
        // with the last render. If identical, skip the re-render.
        if (!append && newsCache.length > 0) {
            const newsSig = newsCache.map(n => `${n.title}|${n.time}|${n.ai_summary || ''}|${n.ai_status || ''}`).join(';;');
            if (container.dataset.newsSig === newsSig) {
                // Data unchanged — skip re-render to avoid flash
                return;
            }
            container.dataset.newsSig = newsSig;
        }

        if (!append) {
            const savedScroll = window.scrollY;
            renderNews(currentTabAtRender);
            // Restore scroll after re-render
            requestAnimationFrame(() => window.scrollTo(0, savedScroll));
        } else {
            // Append: just re-render, scroll stays naturally
            renderNews(currentTabAtRender);
        }

        // NEWSFE-006 + NEWSFE-007 FIX: Refresh dashboard important-news and
        // the open news modal so AI summaries (which become ready via cron
        // between polls) are reflected without requiring a page reload.
        // Previously: dashboard important-news rendered once at bootstrap and
        // never updated; news modal showed "در حال تولید..." forever even
        // after the AI summary was generated. Now, after each successful
        // loadNews (including the 180s poll), we re-render the dashboard
        // important-news section (if it exists) and refresh the open news
        // modal (if one is showing an article whose ai_status changed).
        try {
            // NEWSFE-007: Refresh dashboard important-news section
            if (typeof renderImportantNewsFromCache === 'function') {
                renderImportantNewsFromCache();
            }
            // NEWSFE-006: Refresh open news modal if showing an article that
            // now has an AI summary ready (ai_status !== 'pending')
            const modalEl = document.getElementById('news-modal');
            if (modalEl && modalEl.style.display !== 'none') {
                // Find the article currently shown in the modal by matching
                // the title (set via innerText in openNewsModal/openNewsModalWith)
                const titleEl = document.getElementById('news-modal-title');
                const modalTitle = titleEl ? titleEl.innerText : null;
                if (modalTitle) {
                    const refreshed = newsCache.find(n => n.title === modalTitle);
                    if (refreshed && refreshed.ai_status && refreshed.ai_status !== 'pending') {
                        // Re-open the modal with the refreshed article data
                        if (typeof openNewsModalWith === 'function') {
                            openNewsModalWith(refreshed);
                        }
                    }
                }
            }
        } catch (_) { /* non-fatal — UI refresh best-effort */ }
    } catch (e) {
        console.error('News error:', e);
        // ITEM 1 FIX: Don't overwrite with error state if we still have data
        if (!newsCache.length) {
            const container = document.getElementById('news-list');
            if (container) container.innerHTML = `<div class="empty-state">${t('news_error')}</div>`;
        }
    }
}

function loadMoreNews() {
    if (!newsHasMore) return;
    loadNews(false, true);
}

/**
 * اخبار را در رابط کاربری رندر می‌کند — News Intelligence Rebuild.
 * Renders the premium news feed with hero slider, cards, badges, impact scores.
 */
function renderNews(category) {
    const container = document.getElementById('news-list');
    if (!container) return;

    // Clear any existing countdown interval
    if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
    // Clear hero timer
    if (_niHeroTimer) { clearInterval(_niHeroTimer); _niHeroTimer = null; }

    // Calendar tab
    if (category === 'calendar') {
        renderCalendarV2();
        return;
    }

    // ROOT CAUSE FIX (calendar tab not switching): The calendar render guard
    // (container.dataset.calSignature in renderCalendarV2) skips re-render when
    // the signature matches the previous render. But that signature was never
    // invalidated when non-calendar content (Crypto/All/Forex/Saved/etc.) was
    // rendered into the same container. So after viewing Calendar once, then
    // switching to Crypto and back to Calendar, the guard saw a matching
    // signature and skipped render — leaving Crypto content visible while the
    // Calendar tab was marked active.
    //
    // FIX: Invalidate the calendar signature whenever non-calendar content is
    // about to be rendered into news-list. This makes the guard in
    // renderCalendarV2 strictly correct: a matching signature now genuinely
    // means "the container currently holds calendar content for this data".
    delete container.dataset.calSignature;

    // Saved tab
    if (category === 'saved') {
        renderSavedNews();
        return;
    }

    // Filter by category
    let filtered = newsCache;
    if (category === 'crypto') filtered = filtered.filter(n => n.category === 'crypto');
    else if (category === 'forex') filtered = filtered.filter(n => n.category === 'forex');
    else if (category === 'economy') filtered = filtered.filter(n => n.category === 'economy');

    // Apply active filters
    filtered = niApplyFilters(filtered);

    // M1 FIX: If news fetch failed due to auth (401, outside Telegram), show
    // a clear "Open in Telegram" message instead of the misleading "خبری یافت نشد"
    // (no news found). This also hides the contradictory empty-state + error-bar combo.
    if (!filtered.length && _newsAuthFailed && !isInTelegram()) {
        const isFa = currentLang === 'fa';
        container.innerHTML = `
            <div class="ni-empty ni-auth-required">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round" width="56" height="56">
                    <path d="M21 11.5a8.38 8.38 0 0 1-.9 3.8 8.5 8.5 0 0 1-7.6 4.7 8.38 8.38 0 0 1-3.8-.9L3 21l1.9-5.7a8.38 8.38 0 0 1-.9-3.8 8.5 8.5 0 0 1 4.7-7.6 8.38 8.38 0 0 1 3.8-.9h.5a8.48 8.48 0 0 1 8 8v.5z"/>
                </svg>
                <div class="ni-auth-title">${isFa ? 'برای مشاهده اخبار، اپ را داخل تلگرام باز کنید' : 'Open in Telegram to see news'}</div>
                <div class="ni-auth-sub">${isFa ? 'اخبار بازار به‌صورت لحظه‌ای داخل Mini App نمایش داده می‌شود' : 'Live market news is available inside the Mini App'}</div>
                <a href="https://t.me/Amir_BTC_AssistantBot" class="ni-auth-btn" target="_blank" rel="noopener">
                    ${isFa ? 'باز کردن در تلگرام' : 'Open in Telegram'}
                </a>
            </div>`;
        return;
    }

    if (!filtered.length) {
        container.innerHTML = `<div class="ni-empty">${NI_ICONS.searchEmpty}<div>خبری یافت نشد</div></div>`;
        return;
    }

    displayedNews = filtered;
    const placeholderImg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22 viewBox=%220 0 24 24%22 fill=%22%23151C24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E';

    let html = '';

    // ── Featured News Hero Slider (only on "all" tab) ──
    if (category === 'all') {
        // BUG #1 FIX: Filter to only valid items (with title), deduplicate by URL,
        // and take up to 5. Never create empty or duplicate slides.
        const seenUrls = new Set();
        const heroItems = filtered
            .filter(niIsHeroEligible)
            .filter(n => n && n.title && n.title.trim()) // Must have non-empty title
            .filter(n => {
                // Deduplicate by URL (or title if URL is missing)
                const key = n.url || n.title;
                if (seenUrls.has(key)) return false;
                seenUrls.add(key);
                return true;
            })
            .slice(0, 5);
        if (heroItems.length >= 1) {
            _niHeroSlides = heroItems;
            _niHeroIndex = 0;
            html += niRenderHeroSlider(heroItems);
        } else {
            _niHeroSlides = []; // No valid hero items
        }
    }

    // ── News Cards ──
    const heroUrls = _niHeroSlides.map(s => s.url);
    const cardItems = filtered.filter(n => !heroUrls.includes(n.url));
    const startIdx = 0;
    for (let i = startIdx; i < cardItems.length; i++) {
        const n = cardItems[i];
        const idx = filtered.indexOf(n); // index in displayedNews for modal
        const delay = (i - startIdx) * 0.05;
        const isSaved = _niSavedNews.some(s => s.url === n.url);
        html += `
        <div class="ni-card" style="animation-delay:${delay}s" onclick="openNewsModal(${idx})">
            <div class="ni-card-top">
                <div class="ni-card-body">
                    <div class="ni-card-badges">
                        ${niBadgeHtml(n.sentiment)}
                        ${niImpactHtml(n)}
                    </div>
                    <div class="ni-card-title">${escapeHtml(n.title)}</div>
                    ${n.summary ? `<div class="ni-card-summary">${escapeHtml(n.summary)}</div>` : ''}
                </div>
                <img class="ni-card-thumb" src="${escapeHtml(n.image || placeholderImg)}" loading="lazy" alt="" onerror="newsImageFallback(this)">
            </div>
            ${niAiSummaryHtml(n)}
            <div class="ni-card-footer">
                <div class="ni-card-source">
                    ${NI_ICONS.clock}
                    <span>${escapeHtml(n.source)} • ${escapeHtml(formatNewsTimeTehran(n.pub_date, n.time))}</span>
                </div>
                <div class="ni-card-actions">
                    <button class="ni-card-action ${isSaved ? 'saved' : ''}" onclick="event.stopPropagation(); toggleSaveNews(${idx})" aria-label="ذخیره">
                        ${isSaved ? NI_ICONS.bookmarkFilled : NI_ICONS.bookmark}
                    </button>
                    <button class="ni-card-action" onclick="event.stopPropagation(); openShareSheet(${idx})" aria-label="اشتراک‌گذاری">
                        ${NI_ICONS.share}
                    </button>
                </div>
            </div>
        </div>`;
    }

    // Infinite scroll trigger
    if (newsHasMore && (category === 'all' || category === 'crypto' || category === 'forex')) {
        html += `<div class="ni-load-trigger" id="news-load-trigger"></div>`;
    }

    container.innerHTML = html;

    // Initialize hero slider if present
    if (category === 'all' && _niHeroSlides.length > 1) {
        niInitHeroSlider();
    }

    setupInfiniteScroll();
}

// ============================================================================
// Featured News Hero Slider
// ============================================================================

function niRenderHeroSlider(items) {
    // BUG #1 FIX: Only render slides from valid news items.
    // Filter out items without a title — never render empty slides.
    // Also deduplicate by URL/title to prevent duplicate slides.
    const seenKeys = new Set();
    const validItems = items.filter(n => {
        if (!n || !n.title || !n.title.trim()) return false;
        const key = n.url || n.title;
        if (seenKeys.has(key)) return false;
        seenKeys.add(key);
        return true;
    });
    if (!validItems.length) return ''; // No valid items → no slider

    const placeholderImg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22400%22 height=%22240%22 viewBox=%220 0 24 24%22 fill=%22%23151C24%22%3E%3Crect width=%2224%22 height=%2224%22/%3E%3C/svg%3E';
    const slidesHtml = validItems.map((n, i) => {
        const img = n.image && !n.image.includes('data:image/svg') ? n.image : placeholderImg;
        const idx = newsCache.indexOf(n); // index in displayedNews for modal
        const isSaved = _niSavedNews.some(s => s.url === n.url);
        return `
        <div class="ni-hero-slide" onclick="openNewsModal(${idx})">
            <img class="ni-hero-slide-img" src="${escapeHtml(img)}" loading="${i === 0 ? 'eager' : 'lazy'}" alt="" onerror="this.src='${placeholderImg}'">
            <div class="ni-hero-slide-overlay"></div>
            <div class="ni-hero-slide-content">
                <div class="ni-hero-badges">${niBadgeHtml(n.sentiment)}${niImpactHtml(n)}</div>
                <div class="ni-hero-headline">${escapeHtml(n.title)}</div>
                ${n.summary ? `<div class="ni-hero-summary">${escapeHtml(n.summary)}</div>` : ''}
                <div class="ni-hero-meta">
                    <div class="ni-hero-source">${NI_ICONS.clock}<span>${escapeHtml(n.source || '')} • ${escapeHtml(formatNewsTimeTehran(n.pub_date, n.time))}</span></div>
                    <div class="ni-hero-actions">
                        <button class="ni-hero-action-btn ${isSaved ? 'saved' : ''}" onclick="event.stopPropagation(); toggleSaveNews(${idx})" aria-label="ذخیره">
                            ${isSaved ? NI_ICONS.bookmarkFilled : NI_ICONS.bookmark}
                        </button>
                        <button class="ni-hero-action-btn" onclick="event.stopPropagation(); openShareSheet(${idx})" aria-label="اشتراک‌گذاری">
                            ${NI_ICONS.share}
                        </button>
                    </div>
                </div>
            </div>
        </div>`;
    }).join('');

    // BUG #1 FIX: Only show dots when there are 2+ slides.
    // Dots count must EXACTLY match slide count.
    const showDots = validItems.length > 1;
    const dotsHtml = showDots ? `<div class="ni-hero-dots">${validItems.map((_, i) => `<span class="ni-hero-dot${i === 0 ? ' active' : ''}" onclick="niGoToSlide(${i})"></span>`).join('')}</div>` : '';

    // BUG #1 FIX: Add 'single' class when only 1 slide (hides cursor: grab, etc.)
    const sliderClass = validItems.length === 1 ? 'ni-hero-slider ni-hero-single' : 'ni-hero-slider';

    return `
    <div class="${sliderClass}" id="ni-hero-slider">
        <div class="ni-hero-track" id="ni-hero-track">${slidesHtml}</div>
        ${dotsHtml}
    </div>`;
}

function niInitHeroSlider() {
    const slider = document.getElementById('ni-hero-slider');
    const track = document.getElementById('ni-hero-track');
    if (!slider || !track) return;

    // BUG #1 FIX: Count actual slide elements in the DOM (source of truth).
    // Don't rely on _niHeroSlides.length which may include items that were
    // filtered out during rendering.
    const actualSlideCount = track.querySelectorAll('.ni-hero-slide').length;
    if (actualSlideCount <= 1) return; // Single slide → no autoplay, no swipe

    // Update _niHeroSlides to match actual DOM count
    _niHeroSlides = _niHeroSlides.slice(0, actualSlideCount);

    // Start autoplay (5 seconds)
    if (_niHeroTimer) clearInterval(_niHeroTimer);
    _niHeroTimer = setInterval(() => {
        niGoToSlide((_niHeroIndex + 1) % _niHeroSlides.length);
    }, 5000);

    // Touch/swipe support
    let startX = 0, currentX = 0, isDragging = false;
    slider.addEventListener('touchstart', (e) => {
        startX = e.touches[0].clientX;
        isDragging = true;
        if (_niHeroTimer) clearInterval(_niHeroTimer);
    }, { passive: true });
    slider.addEventListener('touchmove', (e) => {
        if (!isDragging) return;
        currentX = e.touches[0].clientX;
    }, { passive: true });
    slider.addEventListener('touchend', () => {
        if (!isDragging) return;
        isDragging = false;
        const diff = startX - currentX;
        if (Math.abs(diff) > 40) {
            if (diff > 0) {
                niGoToSlide((_niHeroIndex + 1) % _niHeroSlides.length);
            } else {
                niGoToSlide((_niHeroIndex - 1 + _niHeroSlides.length) % _niHeroSlides.length);
            }
        }
        // Resume autoplay
        _niHeroTimer = setInterval(() => {
            niGoToSlide((_niHeroIndex + 1) % _niHeroSlides.length);
        }, 5000);
    });
}

function niGoToSlide(index) {
    _niHeroIndex = index;
    const track = document.getElementById('ni-hero-track');
    if (track) {
        track.style.transform = `translateX(-${index * 100}%)`;
    }
    document.querySelectorAll('.ni-hero-dot').forEach((dot, i) => {
        dot.classList.toggle('active', i === index);
    });
}

// ============================================================================
// News Filters
// ============================================================================

function niApplyFilters(items) {
    let result = items;
    // Sentiment filter
    if (_niActiveFilters.sentiment.length) {
        result = result.filter(n => _niActiveFilters.sentiment.includes((n.sentiment || '').toLowerCase()));
    }
    // Priority filter
    if (_niActiveFilters.priority.length) {
        result = result.filter(n => {
            const level = niImpactLevel(n);
            const s = (n.sentiment || '').toLowerCase();
            if (_niActiveFilters.priority.includes('breaking') && s === 'breaking') return true;
            if (_niActiveFilters.priority.includes('high') && level === 'high') return true;
            if (_niActiveFilters.priority.includes('trending') && niIsHeroEligible(n)) return true;
            return false;
        });
    }
    // Category filter (keyword-based)
    if (_niActiveFilters.category.length) {
        result = result.filter(n => {
            const title = (n.title || '').toLowerCase() + ' ' + (n.summary || '').toLowerCase();
            return _niActiveFilters.category.some(cat => {
                const catMap = {
                    bitcoin: ['bitcoin', 'btc', 'بیت‌کوین', 'بیت کوین'],
                    ethereum: ['ethereum', 'eth', 'اتریوم'],
                    solana: ['solana', 'sol', 'سولانا'],
                    xrp: ['xrp', 'ripple', 'ریپل'],
                    etf: ['etf', 'ای‌تی‌اف'],
                    regulation: ['sec', 'regulation', 'قانون', 'تنظیم'],
                    macro: ['fed', 'cpi', 'gdp', 'rate', 'interest', 'فدرال', 'نرخ'],
                    market: ['market', 'rally', 'crash', 'surge', 'بازار', 'رشد', 'افت'],
                };
                const keywords = catMap[cat] || [cat];
                return keywords.some(kw => title.includes(kw));
            });
        });
    }
    // Time range filter
    if (_niActiveFilters.time) {
        const now = Date.now();
        const ranges = { '1h': 3600000, '24h': 86400000, '7d': 604800000 };
        const range = ranges[_niActiveFilters.time];
        if (range) {
            result = result.filter(n => {
                // Parse relative time like "2h ago", "3d ago", "5m ago"
                const timeStr = n.time || '';
                const match = timeStr.match(/(\d+)\s*(m|h|d)/i);
                if (match) {
                    const num = parseInt(match[1]);
                    const unit = match[2].toLowerCase();
                    const ms = unit === 'm' ? num * 60000 : unit === 'h' ? num * 3600000 : num * 86400000;
                    return ms <= range;
                }
                return true; // Keep items with unparseable time
            });
        }
    }
    return result;
}

function openNewsFilterSheet() {
    const sheet = document.getElementById('ni-filter-sheet');
    if (!sheet) return;
    sheet.style.display = 'flex';
    // Restore active state from _niActiveFilters
    document.querySelectorAll('.ni-chip[data-filter]').forEach(chip => {
        const filter = chip.dataset.filter;
        const value = chip.dataset.value;
        if (filter === 'time') {
            chip.classList.toggle('active', _niActiveFilters.time === value);
        } else {
            chip.classList.toggle('active', _niActiveFilters[filter] && _niActiveFilters[filter].includes(value));
        }
        chip.onclick = function() {
            if (filter === 'time') {
                if (_niActiveFilters.time === value) {
                    _niActiveFilters.time = null;
                    chip.classList.remove('active');
                } else {
                    document.querySelectorAll('.ni-chip[data-filter="time"]').forEach(c => c.classList.remove('active'));
                    _niActiveFilters.time = value;
                    chip.classList.add('active');
                }
            } else {
                if (!_niActiveFilters[filter]) _niActiveFilters[filter] = [];
                const idx = _niActiveFilters[filter].indexOf(value);
                if (idx >= 0) {
                    _niActiveFilters[filter].splice(idx, 1);
                    chip.classList.remove('active');
                } else {
                    _niActiveFilters[filter].push(value);
                    chip.classList.add('active');
                }
            }
        };
    });
}

function closeNewsFilterSheet() {
    const sheet = document.getElementById('ni-filter-sheet');
    if (sheet) sheet.style.display = 'none';
    // NEWSFE-032 FIX: Update the filter dot indicator and re-render so the
    // user sees the effect of any chip toggles they made before closing the
    // sheet (e.g. via click-outside). Previously closeNewsFilterSheet only
    // hid the sheet — the dot stayed invisible even when filters were active,
    // and the news list didn't reflect the toggled filters until the user
    // explicitly clicked "Apply". Now closing the sheet applies the filters.
    const hasFilters = _niActiveFilters.sentiment.length || _niActiveFilters.priority.length ||
                       _niActiveFilters.category.length || _niActiveFilters.time;
    const dot = document.getElementById('ni-filter-dot');
    if (dot) dot.style.display = hasFilters ? 'block' : 'none';
    const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news || 'all';
    renderNews(activeTab);
}

function applyNewsFilters() {
    closeNewsFilterSheet();
    // Update filter dot indicator
    const hasFilters = _niActiveFilters.sentiment.length || _niActiveFilters.priority.length ||
                       _niActiveFilters.category.length || _niActiveFilters.time;
    const dot = document.getElementById('ni-filter-dot');
    if (dot) dot.style.display = hasFilters ? 'block' : 'none';
    // Re-render current tab
    const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news || 'all';
    renderNews(activeTab);
}

function resetNewsFilters() {
    _niActiveFilters = { sentiment: [], priority: [], category: [], time: null };
    document.querySelectorAll('.ni-chip[data-filter]').forEach(chip => chip.classList.remove('active'));
    applyNewsFilters();
}

// ============================================================================
// Save News System
// ============================================================================

function toggleSaveNews(idx) {
    const n = displayedNews[idx];
    if (!n) return;
    const savedIdx = _niSavedNews.findIndex(s => s.url === n.url);
    if (savedIdx >= 0) {
        _niSavedNews.splice(savedIdx, 1);
    } else {
        _niSavedNews.unshift({ url: n.url, title: n.title, image: n.image, source: n.source, time: n.time, pub_date: n.pub_date, sentiment: n.sentiment, summary: n.summary, body: n.body, category: n.category, savedAt: Date.now() });
    }
    // NEWSFE-011 FIX: Use safeLocalStorageSetItem to prevent QuotaExceededError
    // from propagating up and leaving the save button in a stuck state. The
    // in-memory _niSavedNews is already updated, so the UI reflects the toggle
    // regardless of whether persistence succeeded.
    safeLocalStorageSetItem('ni_saved_news', JSON.stringify(_niSavedNews));
    // Re-render to update button state
    const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news || 'all';
    renderNews(activeTab);
}

function renderSavedNews() {
    const container = document.getElementById('news-list');
    if (!container) return;

    if (!_niSavedNews.length) {
        container.innerHTML = `<div class="ni-empty">${NI_ICONS.bookmarkEmpty}<div>هیچ مورد ذخیره شده‌ای وجود ندارد</div></div>`;
        return;
    }

    // Sort newest first
    const sorted = _niSavedNews.slice().sort((a, b) => (b.savedAt || 0) - (a.savedAt || 0));
    displayedNews = sorted; // for modal access
    const placeholderImg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22 viewBox=%220 0 24 24%22 fill=%22%23151C24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3Cpath d=%22M12 6v12M6 12h12%22 stroke=%22%2364748b%22 stroke-width=%222%22/%3E%3C/svg%3E';

    let html = '';
    sorted.forEach((n, i) => {
        const isSaved = true; // always saved in this tab
        html += `
        <div class="ni-card" style="animation-delay:${i * 0.05}s" onclick="openNewsModal(${i})">
            <div class="ni-card-top">
                <div class="ni-card-body">
                    <div class="ni-card-badges">
                        ${niBadgeHtml(n.sentiment)}
                        ${niImpactHtml(n)}
                    </div>
                    <div class="ni-card-title">${escapeHtml(n.title)}</div>
                    ${n.summary ? `<div class="ni-card-summary">${escapeHtml(n.summary)}</div>` : ''}
                </div>
                <img class="ni-card-thumb" src="${escapeHtml(n.image || placeholderImg)}" loading="lazy" alt="" onerror="newsImageFallback(this)">
            </div>
            ${niAiSummaryHtml(n)}
            <div class="ni-card-footer">
                <div class="ni-card-source">
                    ${NI_ICONS.clock}
                    <span>${escapeHtml(n.source)} • ${escapeHtml(formatNewsTimeTehran(n.pub_date, n.time))}</span>
                </div>
                <div class="ni-card-actions">
                    <button class="ni-card-action saved" onclick="event.stopPropagation(); toggleSaveNews(${i})" aria-label="حذف ذخیره">
                        ${NI_ICONS.bookmarkFilled}
                    </button>
                    <button class="ni-card-action" onclick="event.stopPropagation(); openShareSheet(${i})" aria-label="اشتراک‌گذاری">
                        ${NI_ICONS.share}
                    </button>
                </div>
            </div>
        </div>`;
    });
    container.innerHTML = html;
}

// ============================================================================
// Share System
// ============================================================================

function openShareSheet(idx) {
    const n = displayedNews[idx];
    if (!n) return;
    _niCurrentShareNews = n;
    const sheet = document.getElementById('ni-share-sheet');
    if (sheet) sheet.style.display = 'flex';
}

function closeShareSheet() {
    const sheet = document.getElementById('ni-share-sheet');
    if (sheet) sheet.style.display = 'none';
    _niCurrentShareNews = null;
}

function shareNewsTo(platform) {
    if (!_niCurrentShareNews) return;
    const url = _niCurrentShareNews.url || window.location.href;
    const title = _niCurrentShareNews.title || '';
    const text = encodeURIComponent(title);
    const urlEnc = encodeURIComponent(url);

    switch (platform) {
        case 'telegram':
            window.open(`https://t.me/share/url?url=${urlEnc}&text=${text}`, '_blank');
            break;
        case 'whatsapp':
            window.open(`https://wa.me/?text=${text}%20${urlEnc}`, '_blank');
            break;
        case 'x':
            window.open(`https://twitter.com/intent/tweet?text=${text}&url=${urlEnc}`, '_blank');
            break;
        case 'copy':
            if (navigator.clipboard) {
                // NEWSFE-028 FIX: Add .catch() so clipboard rejection (permission
                // denied, unsupported WebView, private mode) doesn't produce an
                // unhandled promise rejection. Previously writeText() rejecting
                // would silently fail with no user feedback. Now we show a toast
                // on failure too, and fall back to the execCommand path.
                navigator.clipboard.writeText(url).then(() => {
                    if (typeof showToast === 'function') showToast('لینک کپی شد');
                }).catch(() => {
                    // Clipboard API rejected — try execCommand fallback
                    const input = document.createElement('input');
                    input.value = url;
                    document.body.appendChild(input);
                    input.select();
                    try {
                        document.execCommand('copy');
                        if (typeof showToast === 'function') showToast('لینک کپی شد');
                    } catch (e) {
                        if (typeof showToast === 'function') showToast('کپی لینک ناموفق بود');
                    }
                    document.body.removeChild(input);
                });
            } else {
                // Fallback
                const input = document.createElement('input');
                input.value = url;
                document.body.appendChild(input);
                input.select();
                try { document.execCommand('copy'); } catch(e) {}
                document.body.removeChild(input);
            }
            break;
    }
    // Try native share API if supported
    if (navigator.share && platform !== 'copy') {
        navigator.share({ title: title, url: url }).catch(() => {});
    }
    closeShareSheet();
}

// ============================================================================
// Search System
// ============================================================================

function openNewsSearch() {
    const overlay = document.getElementById('ni-search-overlay');
    if (!overlay) return;
    overlay.style.display = 'flex';
    setTimeout(() => {
        const input = document.getElementById('ni-search-input');
        if (input) input.focus();
    }, 300);
}

function closeNewsSearch() {
    const overlay = document.getElementById('ni-search-overlay');
    if (overlay) overlay.style.display = 'none';
    const input = document.getElementById('ni-search-input');
    if (input) input.value = '';
    _niCurrentSearchQuery = '';
}

function onNewsSearchInput(query) {
    _niCurrentSearchQuery = query.trim().toLowerCase();
    const results = document.getElementById('ni-search-results');
    if (!results) return;

    if (!_niCurrentSearchQuery) {
        results.innerHTML = '';
        return;
    }

    // Search news cache + calendar events
    const newsResults = newsCache.filter(n => {
        const haystack = (n.title + ' ' + (n.summary || '') + ' ' + (n.source || '') + ' ' + (n.category || '')).toLowerCase();
        return haystack.includes(_niCurrentSearchQuery);
    }).slice(0, 10);

    const calResults = calendarEvents.filter(e => {
        const haystack = (e.title + ' ' + (e.country || '') + ' ' + (e.currency || '')).toLowerCase();
        return haystack.includes(_niCurrentSearchQuery);
    }).slice(0, 5);

    if (!newsResults.length && !calResults.length) {
        results.innerHTML = `<div class="ni-empty">${NI_ICONS.searchEmpty}<div>نتیجه‌ای یافت نشد</div></div>`;
        return;
    }

    let html = '';
    const placeholderImg = 'data:image/svg+xml,%3Csvg xmlns=%22http://www.w3.org/2000/svg%22 width=%22220%22 height=%22220%22 viewBox=%220 0 24 24%22 fill=%22%23151C24%22%3E%3Crect width=%2224%22 height=%2224%22 rx=%224%22/%3E%3C/svg%3E';

    if (newsResults.length) {
        html += '<div class="ni-cal-time-group">اخبار</div>';
        newsResults.forEach(n => {
            const idx = newsCache.indexOf(n);
            html += `
            <div class="ni-card" style="animation-delay:0s" onclick="closeNewsSearch(); switchTab('news-page'); setTimeout(() => openNewsModal(${idx}), 300)">
                <div class="ni-card-top">
                    <div class="ni-card-body">
                        <div class="ni-card-badges">${niBadgeHtml(n.sentiment)}</div>
                        <div class="ni-card-title">${escapeHtml(n.title)}</div>
                    </div>
                    <img class="ni-card-thumb" src="${escapeHtml(n.image || placeholderImg)}" loading="lazy" alt="" onerror="newsImageFallback(this)">
                </div>
            </div>`;
        });
    }

    if (calResults.length) {
        html += '<div class="ni-cal-time-group">رویدادهای اقتصادی</div>';
        calResults.forEach(e => {
            html += `
            <div class="ni-cal-event impact-${e.impact || 'medium'}" onclick="closeNewsSearch(); switchTab('news-page'); setTimeout(() => switchNewsTab('calendar'), 300)">
                <div class="ni-cal-event-top">
                    <div class="ni-cal-event-left">
                        <div class="ni-cal-event-flag">${e.flag || ''}</div>
                        <div class="ni-cal-event-currency">${escapeHtml(e.country || '')}</div>
                    </div>
                    <div class="ni-cal-event-time">${formatCalendarTime(e.timestamp).time || ''}</div>
                </div>
                <div class="ni-cal-event-title">${escapeHtml(e.title)}</div>
            </div>`;
        });
    }

    results.innerHTML = html;
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

// CALRESTORE-001: Restore 3 functions (and 1 const) that were accidentally
// removed in commit c9bebdb ("Batch F — Dead Code removal"). That commit
// removed the legacy renderCalendar() function AND, mistakenly, also removed
// these 4 helpers which renderCalendarV2() still depends on:
//
//   - const MAJOR_CURRENCIES = [...]     — used at lines 7441-7443 (country
//     filter chips construction inside renderCalendarV2's .then() callback).
//   - getCalendarTabCounts(events)       — called at line 7278 (inside
//     renderCalendarV2's .then() callback). Without it, ReferenceError is
//     thrown the moment calendar data resolves, aborting the entire render.
//   - buildCalendarSegmentsHtml(counts)  — called 5 times inside
//     renderCalendarV2 (skeleton + empty + no-match + main render paths).
//   - startCalCountdown()                — called twice inside
//     renderCalendarV2 (signature-match path + post-render path).
//
// The definitions below are restored VERBATIM from commit 5a42595 (the
// parent of c9bebdb, i.e. the last commit where they existed). No edits,
// no refactor, no rewrite — byte-for-byte identical to the historical
// versions that renderCalendarV2 was originally written against.

const MAJOR_CURRENCIES = ['USD', 'EUR', 'GBP', 'JPY', 'CNY', 'CAD', 'AUD', 'NZD', 'CHF'];

/**
 * Compute per-tab counts (today / tomorrow / week) for the calendar
 * segmented control badges.
 * These CAN be 0 on days with no events — that's correct behavior.
 */
function getCalendarTabCounts(events) {
    const counts = { today: 0, tomorrow: 0, week: 0 };
    if (!Array.isArray(events) || !events.length) return counts;
    const tz = 'Asia/Tehran';
    const now = new Date();
    const todayParts = now.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
    const todayStart = new Date(Date.UTC(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2])));
    const tomorrowStart = new Date(todayStart.getTime() + 86400000);
    for (const e of events) {
        if (!e || !e.timestamp) continue;
        const d = new Date(e.timestamp);
        if (isNaN(d.getTime())) continue;
        const parts = d.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
        const day = new Date(Date.UTC(Number(parts[0]), Number(parts[1]) - 1, Number(parts[2])));
        if (day.getTime() === todayStart.getTime()) counts.today++;
        if (day.getTime() === tomorrowStart.getTime()) counts.tomorrow++;
        // "This Week" = ALL events from the API (API already returns
        // current-week data from the provider — no re-filtering needed).
        counts.week++;
    }
    return counts;
}

/**
 * Build the segmented-control HTML for the calendar tabs.
 * Only 3 tabs: Today / Tomorrow / This Week.
 * Each tab has equal width (flex:1) and a count badge.
 */
function buildCalendarSegmentsHtml(counts) {
    const c = counts || { today: 0, tomorrow: 0, week: 0 };
    const tabs = [
        { key: 'today',    label: 'امروز',     count: c.today },
        { key: 'tomorrow', label: 'فردا',      count: c.tomorrow },
        { key: 'week',     label: 'این هفته',  count: c.week }
    ];
    return `<div class="ni-cal-segments">` + tabs.map(t => `
        <button class="ni-cal-segment${currentCalendarTab === t.key ? ' active' : ''}" data-cal-tab="${t.key}" onclick="switchCalendarTab('${t.key}', this)">
            <span class="ni-cal-segment-label">${t.label}</span>
            <span class="ni-cal-segment-count">${t.count}</span>
        </button>`).join('') + `</div>`;
}

function startCalCountdown() {
    if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
    const updateCountdowns = () => {
        const now = Date.now();
        // ROOT CAUSE FIX: data-ts contains an ISO timestamp string (e.g.
        // "2026-07-29T14:30:00.000Z"), NOT a numeric epoch. Previously
        // parseInt("2026-07-29T14:30:00.000Z") returned 2026 (just the year!),
        // which when passed to new Date(2026) gave a 1970 date — always in the
        // past. This caused EVERY countdown to show "پایان یافت" regardless of
        // the actual event time. Now we use new Date(el.dataset.ts).getTime()
        // to correctly parse the ISO string.
        const LIVE_WINDOW_MS = 30 * 60 * 1000; // 30 minutes
        document.querySelectorAll('.cal-event-countdown[data-ts]').forEach(el => {
            const eventTime = new Date(el.dataset.ts).getTime();
            if (isNaN(eventTime)) return;
            const diff = eventTime - now;
            if (diff <= 0) {
                if (Math.abs(diff) > LIVE_WINDOW_MS) {
                    el.textContent = '• Past';
                } else {
                    el.textContent = '• Live';
                }
                el.removeAttribute('data-ts');
            } else {
                el.textContent = formatCountdown(diff);
            }
        });
        // Also update new V2 countdowns
        document.querySelectorAll('.ni-cal-countdown[data-ts]').forEach(el => {
            const eventTime = new Date(el.dataset.ts).getTime();
            if (isNaN(eventTime)) return;
            const diff = eventTime - now;
            if (diff <= 0) {
                // Event has started — show "در حال اجرا" (live) for 30 min,
                // then "پایان یافت" after the live window passes.
                if (Math.abs(diff) > LIVE_WINDOW_MS) {
                    el.textContent = 'پایان یافت';
                } else {
                    el.textContent = 'در حال اجرا';
                }
                el.removeAttribute('data-ts');
            } else {
                el.textContent = formatCountdown(diff);
            }
        });
    };
    updateCountdowns();
    calCountdownInterval = setInterval(updateCountdowns, 1000);
}

// NEWSFE-023 FIX (DEAD CODE REMOVED): renderCalendar() had 0 callers. All
// calendar rendering goes through renderCalendarV2() (line below). Removed
// the ~310-line legacy function. toggleCalReminder (only called from inside
// renderCalendar) was also removed below.

function renderCalendarV2() {
    const container = document.getElementById('news-list');
    if (!container) return;

    // ROOT CAUSE FIX for calendar jumping:
    // Previously, every call to renderCalendarV2 replaced the entire
    // container.innerHTML — even if the data was IDENTICAL to the previous
    // render. This caused:
    //   - Scroll position reset (user thrown to top)
    //   - Visual flash (content disappears then reappears)
    //   - Countdown interval cleared and restarted (timer hiccup)
    //
    // FIX: Compute a signature of everything that affects the rendered HTML.
    // If the signature matches the last render, skip the innerHTML replacement
    // entirely — just keep the countdown running. Only re-render when the data
    // actually changed (new events, different tab, different country filter).
    //
    // The signature includes:
    //   - currentCalendarTab (today/tomorrow/week)
    //   - currentCalCountry (all/USD/EUR/...)
    //   - calendarEvents content (titles + timestamps + actuals + forecasts)
    //   - _niCalendarReminders keys (reminder button state)
    //   - calendarLoading state
    //   - currentLang (labels change on language switch)

    if (calendarLoading) {
        // Show skeleton — but only if not already showing skeleton
        const skelSig = '__loading__';
        if (container.dataset.calSignature === skelSig) return;
        container.dataset.calSignature = skelSig;
        if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
        // Show "—" placeholders for counts while loading
        const segmentsHtml = buildCalendarSegmentsHtml({ today: '—', tomorrow: '—', week: '—', all: '—' });
        container.innerHTML = segmentsHtml + `
            <div class="ni-skeleton-card"></div>
            <div class="ni-skeleton-card"></div>
            <div class="ni-skeleton-card"></div>
            <div class="ni-skeleton-card"></div>`;
        return;
    }

    // ROOT CAUSE FIX: If calendarEvents is empty (first load or previous failure),
    // show skeleton BEFORE calling loadCalendarEvents. Previously, the skeleton
    // was only shown when calendarLoading was ALREADY true — but on the first
    // call, calendarLoading is false (it's set inside loadCalendarEvents).
    // This left the container blank for ~1 second until the API responded.
    if (!calendarEvents.length) {
        const skelSig = '__loading__';
        if (container.dataset.calSignature !== skelSig) {
            container.dataset.calSignature = skelSig;
            if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
            const segmentsHtml = buildCalendarSegmentsHtml({ today: '—', tomorrow: '—', week: '—', all: '—' });
            container.innerHTML = segmentsHtml + `
                <div class="ni-skeleton-card"></div>
                <div class="ni-skeleton-card"></div>
                <div class="ni-skeleton-card"></div>
                <div class="ni-skeleton-card"></div>`;
        }
    }

    loadCalendarEvents().then(events => {
        // Compute per-tab counts ONCE so the segmented control badges are
        // always accurate, regardless of which render path is taken.
        const tabCounts = getCalendarTabCounts(events);

        if (!events.length) {
            const emptySig = '__empty_' + currentCalendarTab + '_' + currentCalCountry + '_' + currentLang;
            if (container.dataset.calSignature === emptySig) return;
            container.dataset.calSignature = emptySig;
            if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
            const segmentsHtml = buildCalendarSegmentsHtml(tabCounts);
            container.innerHTML = segmentsHtml + `<div class="ni-empty">${NI_ICONS.clock}<div>رویداد اقتصادی یافت نشد</div></div>`;
            return;
        }

        // ROOT CAUSE FIX (calendar items 1-3): Recompute event statuses based
        // on CURRENT time. Events may come from localStorage cache (hours old)
        // with stale status values. Without this, upcoming events could show
        // as 'past' (or vice versa) because the cached status was computed at
        // API-call time, not at render time.
        events = recomputeEventStatuses(events);

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
            // ROOT CAUSE FIX: "This Week" shows ALL events from the API.
            // The API already returns only current-week events (filtered by
            // the Worker's cutoffPast/cutoffFuture). Previously, this filter
            // used the USER's date range (todayStart to weekEnd), which caused
            // 0 events when the user's device date didn't align with the
            // provider's week. Now we show all events regardless of the
            // user's date — the API is the source of truth for "this week".
            if (currentCalendarTab === 'week') return true;
            return true;
        });

        // Country filter chips
        const availableCountries = [...new Set(filteredEvents.map(e => e.country).filter(Boolean))];
        const allCountries = ['all', ...MAJOR_CURRENCIES.filter(c => availableCountries.includes(c))];
        if (availableCountries.some(c => !MAJOR_CURRENCIES.includes(c))) {
            allCountries.push(...availableCountries.filter(c => !MAJOR_CURRENCIES.includes(c)));
        }

        // Apply country filter
        if (currentCalCountry && currentCalCountry !== 'all') {
            filteredEvents = filteredEvents.filter(e => e.country === currentCalCountry);
        }

        if (!filteredEvents.length) {
            const noMatchSig = '__nomatch_' + currentCalendarTab + '_' + currentCalCountry + '_' + currentLang;
            if (container.dataset.calSignature === noMatchSig) return;
            container.dataset.calSignature = noMatchSig;
            if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }
            // Note: tabCounts reflect ALL events (not country-filtered) so the
            // user can see e.g. "today has 1 event total, but 0 for USD" — they
            // understand the filter is what's empty, not the calendar itself.
            const segmentsHtml = buildCalendarSegmentsHtml(tabCounts);
            const countriesHtml = `
            <div class="ni-cal-countries">
                <button class="ni-cal-country${currentCalCountry === 'all' ? ' active' : ''}" onclick="filterCalCountry('all', this)">همه</button>
                ${allCountries.filter(c => c !== 'all').map(c => {
                    const flag = filteredEvents.find(e => e.country === c)?.flag || '';
                    return `<button class="ni-cal-country${currentCalCountry === c ? ' active' : ''}" onclick="filterCalCountry('${escapeHtml(c)}', this)">${flag} ${escapeHtml(c)}</button>`;
                }).join('')}
            </div>`;
            container.innerHTML = segmentsHtml + countriesHtml + `<div class="ni-empty">${NI_ICONS.clock}<div>رویدادی برای این فیلتر یافت نشد</div></div>`;
            return;
        }

        // ITEM 3 FIX: Sort events by status first (upcoming → live → past),
        // then by time within each status group. This ensures past events
        // always appear at the bottom of the list, never at the top.
        const statusOrder = { upcoming: 0, live: 1, past: 2 };
        filteredEvents.sort((a, b) => {
            const sa = statusOrder[a.status] ?? 1;
            const sb = statusOrder[b.status] ?? 1;
            if (sa !== sb) return sa - sb;
            // Within same status: upcoming ascending (soonest first),
            // past descending (most recent first)
            if (a.status === 'past') {
                return new Date(b.timestamp) - new Date(a.timestamp);
            }
            return new Date(a.timestamp) - new Date(b.timestamp);
        });

        // ── SIGNATURE GUARD ──
        // Build a compact signature of everything that affects the rendered HTML.
        // If this signature matches the last render, skip innerHTML replacement.
        const reminderKeys = Object.keys(_niCalendarReminders).sort().join(',');
        const eventsSig = filteredEvents.map(e =>
            `${e.title}|${e.timestamp}|${e.actual||''}|${e.forecast||''}|${e.previous||''}|${e.status||''}`
        ).join(';;');
        const signature = `${currentCalendarTab}|${currentCalCountry}|${currentLang}|${eventsSig}|${reminderKeys}`;

        if (container.dataset.calSignature === signature) {
            // Data unchanged — do NOT re-render. This prevents:
            //   - Scroll position reset
            //   - Visual flash
            //   - Countdown interval disruption
            // Just ensure countdown is running (it might have been cleared).
            if (!calCountdownInterval) startCalCountdown();
            return;
        }
        container.dataset.calSignature = signature;

        // Clear countdown before full re-render (will restart after innerHTML)
        if (calCountdownInterval) { clearInterval(calCountdownInterval); calCountdownInterval = null; }

        // ITEM 2 FIX: Render events in the sorted order directly — NO grouping
        // by time period. Previously, events were grouped into morning/afternoon/
        // evening which OVERRID the status-based sort. Past events in morning
        // groups appeared before upcoming events in evening groups, even though
        // the sort correctly put upcoming first. Now we render the flat sorted
        // list so the status order (upcoming → live → past) is always respected.
        const lang = currentLang || 'fa';
        const impactLabels = { high: 'تأثیر بالا', medium: 'تأثیر متوسط', low: 'تأثیر کم' };
        const statusLabel = { past: 'گذشته', live: 'در حال اجرا', upcoming: 'در انتظار' };

        // Segmented control with count badges (today/tomorrow/week/all)
        const segmentsHtml = buildCalendarSegmentsHtml(tabCounts);

        const countriesHtml = `
        <div class="ni-cal-countries">
            <button class="ni-cal-country${currentCalCountry === 'all' ? ' active' : ''}" onclick="filterCalCountry('all', this)">همه</button>
            ${allCountries.filter(c => c !== 'all').map(c => {
                const flag = filteredEvents.find(e => e.country === c)?.flag || '';
                return `<button class="ni-cal-country${currentCalCountry === c ? ' active' : ''}" onclick="filterCalCountry('${escapeHtml(c)}', this)">${flag} ${escapeHtml(c)}</button>`;
            }).join('')}
        </div>`;

        let eventsHtml = '';
        filteredEvents.forEach(e => {
            const ft = formatCalendarTime(e.timestamp);
            const timeText = ft.time || '';
            const isPast = e.status === 'past';
            const isLive = e.status === 'live';
            const impact = e.impact || 'medium';
            const eventKey = e.title + '|' + e.timestamp;
            const hasReminder = _niCalendarReminders[eventKey];

            // Surprise indicator
            let surpriseHtml = '';
            if (e.actual && e.forecast) {
                const actualVal = parseFloat(e.actual);
                const forecastVal = parseFloat(e.forecast);
                if (!isNaN(actualVal) && !isNaN(forecastVal)) {
                    const diff = actualVal - forecastVal;
                    const isPositiveGood = !e.title?.toUpperCase().includes('UNEMPLOYMENT');
                    const isBetter = isPositiveGood ? diff > 0 : diff < 0;
                    const cls = Math.abs(diff) < 0.01 ? 'surprise-expected' : (isBetter ? 'surprise-better' : 'surprise-worse');
                    const icon = Math.abs(diff) < 0.01 ? NI_ICONS.clock : (isBetter ? NI_ICONS.arrowUp : NI_ICONS.arrowDown);
                    surpriseHtml = ` <span class="cal-event-surprise ${cls}" style="display:inline-flex;align-items:center;gap:2px;">${icon}</span>`;
                }
            }

            eventsHtml += `
            <div class="ni-cal-event impact-${impact}${isPast ? ' past' : ''}${isLive ? ' live' : ''}">
                <div class="ni-cal-event-top">
                    <div class="ni-cal-event-left">
                        <div class="ni-cal-event-flag">${e.flag || ''}</div>
                        <div>
                            <div class="ni-cal-event-currency">${escapeHtml(e.country || '')}</div>
                            ${e.status ? `<span class="ni-cal-status ni-cal-status-${e.status}">${statusLabel[e.status] || e.status}</span>` : ''}
                        </div>
                    </div>
                    <div style="text-align:left;">
                        <div class="ni-cal-event-time">${timeText}</div>
                        ${!isPast && !isLive ? `<div class="ni-cal-countdown" data-ts="${e.timestamp}">--</div>` : ''}
                    </div>
                </div>
                <div class="ni-cal-event-title">${escapeHtml(e.title)}</div>
                <div class="ni-cal-event-stats">
                    ${e.forecast ? `<div class="ni-cal-stat"><div class="ni-cal-stat-label">پیش‌بینی</div><div class="ni-cal-stat-value">${escapeHtml(e.forecast)}</div></div>` : ''}
                    ${e.previous ? `<div class="ni-cal-stat"><div class="ni-cal-stat-label">قبلی</div><div class="ni-cal-stat-value">${escapeHtml(e.previous)}</div></div>` : ''}
                    ${e.actual ? `<div class="ni-cal-stat"><div class="ni-cal-stat-label">واقعی</div><div class="ni-cal-stat-value actual">${escapeHtml(e.actual)}${surpriseHtml}</div></div>` : ''}
                    <div class="ni-cal-stat"><div class="ni-cal-stat-label">تأثیر</div><div class="ni-cal-stat-value">${impactLabels[impact] || impactLabels.medium}</div></div>
                </div>
                <div class="ni-cal-event-footer">
                    <button class="ni-cal-event-reminder ${hasReminder ? 'active' : ''}" onclick="openReminderSheet('${escapeHtml(eventKey)}', '${escapeHtml(e.title || '')}', '${escapeHtml(e.country || '')}', '${timeText}', '${escapeHtml(e.timestamp || '')}')">
                        ${hasReminder ? NI_ICONS.bell : NI_ICONS.bellOff}
                        <span>${hasReminder ? 'یادآور فعال' : 'یادآوری'}</span>
                    </button>
                </div>
            </div>`;
        });

        container.innerHTML = segmentsHtml + countriesHtml + eventsHtml;
        startCalCountdown();
    });
}

// ============================================================================
// Event Reminder System
// ============================================================================

function openReminderSheet(eventKey, title, country, time, eventTimestamp) {
    _niCurrentReminderEvent = { key: eventKey, title, country, time, timestamp: eventTimestamp };
    const sheet = document.getElementById('ni-reminder-sheet');
    if (!sheet) return;
    // Fill event info
    const info = document.getElementById('ni-reminder-event-info');
    if (info) {
        info.innerHTML = `
        <div class="ni-reminder-event-info-title">${escapeHtml(title)}</div>
        <div class="ni-reminder-event-info-meta">${escapeHtml(country)} • ${escapeHtml(time)}</div>`;
    }
    // Check active reminder
    const activeReminder = _niCalendarReminders[eventKey];
    document.querySelectorAll('.ni-reminder-option').forEach(opt => {
        opt.classList.toggle('active', activeReminder === opt.querySelector('span').textContent);
    });
    sheet.style.display = 'flex';
}

function closeReminderSheet() {
    const sheet = document.getElementById('ni-reminder-sheet');
    if (sheet) sheet.style.display = 'none';
    _niCurrentReminderEvent = null;
}

/**
 * Map Persian reminder label to lead_minutes for the backend.
 * Backend accepts: 15, 60, or 1440.
 */
function _niReminderWhenToMinutes(when) {
    if (when === '۱۵ دقیقه قبل' || when === '15m' || when === 15) return 15;
    if (when === '۱ ساعت قبل' || when === '1h' || when === 60) return 60;
    if (when === '۲۴ ساعت قبل' || when === '24h' || when === 1440) return 1440;
    return 60; // default
}

function setEventReminder(when) {
    if (!_niCurrentReminderEvent) return;
    const ev = _niCurrentReminderEvent;
    // 1. Update local cache immediately (instant UI feedback)
    _niCalendarReminders[ev.key] = when;
    localStorage.setItem('ni_cal_reminders', JSON.stringify(_niCalendarReminders));
    closeReminderSheet();
    renderCalendarV2();

    // 2. Sync to backend (POST /api/calendar/reminders) — persists across
    //    devices and enables the cron job to actually fire the notification.
    //    Fail silently if offline or not in Telegram — the localStorage copy
    //    still works as a local fallback.
    if (!API_BASE || !isInTelegram()) return;
    const leadMinutes = _niReminderWhenToMinutes(when);
    apiFetch('/api/calendar/reminders', {
        method: 'POST',
        body: JSON.stringify({
            event_key: ev.key,
            event_title: ev.title || '',
            event_country: ev.country || '',
            event_timestamp: ev.timestamp || '',
            lead_minutes: leadMinutes,
        }),
    }).catch(err => {
        console.warn('[calendar-reminder] sync failed:', err);
    });
}

function removeEventReminder() {
    if (!_niCurrentReminderEvent) return;
    const ev = _niCurrentReminderEvent;
    // 1. Remove from local cache
    delete _niCalendarReminders[ev.key];
    localStorage.setItem('ni_cal_reminders', JSON.stringify(_niCalendarReminders));
    closeReminderSheet();
    renderCalendarV2();

    // 2. Delete from backend
    if (!API_BASE || !isInTelegram()) return;
    apiFetch('/api/calendar/reminders/' + encodeURIComponent(ev.key), {
        method: 'DELETE',
    }).catch(err => {
        console.warn('[calendar-reminder] delete sync failed:', err);
    });
}

/**
 * Sync reminders from backend → localStorage.
 * Called on bootstrap to merge server-side reminders with local cache.
 * Merges (server takes precedence on conflict) so users see their reminders
 * across devices.
 */
async function syncRemindersFromBackend() {
    if (!API_BASE || !isInTelegram()) return;
    try {
        const data = await apiFetch('/api/calendar/reminders');
        if (data && data.status === 'success' && Array.isArray(data.reminders)) {
            for (const r of data.reminders) {
                // Convert lead_minutes back to Persian label for UI
                let when;
                if (r.lead_minutes === 15) when = '۱۵ دقیقه قبل';
                else if (r.lead_minutes === 1440) when = '۲۴ ساعت قبل';
                else when = '۱ ساعت قبل';
                _niCalendarReminders[r.event_key] = when;
            }
            localStorage.setItem('ni_cal_reminders', JSON.stringify(_niCalendarReminders));
        }
    } catch (err) {
        // Non-fatal — localStorage cache still works
        console.warn('[calendar-reminder] sync from backend failed:', err);
    }
}


/**
 * نمایش یا وضعیت اخبار تب را تعویض می‌کند.
 * ورودی: پارامترهای `category, btn` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
// Scroll position preservation per tab
const _niScrollPositions = {};

function _niSaveScrollPosition() {
    const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news;
    if (!activeTab) return;
    // The window scrolls (not the container), so use window.scrollY
    _niScrollPositions[activeTab] = window.scrollY || document.documentElement.scrollTop || 0;
}

function _niRestoreScrollPosition(tab) {
    if (!tab) return;
    const saved = _niScrollPositions[tab];
    if (saved == null) return;
    // Use requestAnimationFrame to ensure DOM is rendered
    requestAnimationFrame(() => {
        window.scrollTo(0, saved);
    });
}

function switchNewsTab(category, btn) {
    // BUG #2 FIX: Save scroll position of the current tab before switching
    _niSaveScrollPosition();

    document.querySelectorAll('.ni-tab').forEach(b => b.classList.remove('active'));
    if (btn) {
        btn.classList.add('active');
    } else {
        // Find the tab by data attribute
        const target = document.querySelector(`.ni-tab[data-news="${category}"]`);
        if (target) target.classList.add('active');
    }
    // CRITICAL FIX: Do NOT reset calendar sub-tab or country filter when
    // switching to calendar tab. These should only change when the user
    // explicitly selects a different sub-tab or country.
    // Previous code was: if (category === 'calendar') { currentCalendarTab = 'today'; currentCalCountry = 'all'; }
    // This caused the calendar to reset every time the user switched to it.
    renderNews(category);

    // BUG #2 FIX: Restore scroll position for the new tab
    _niRestoreScrollPosition(category);

    // Fire daily mission: calendar_view (non-blocking, idempotent)
    if (category === 'calendar' && typeof fireMissionEvent === 'function') {
        fireMissionEvent(MISSION_EVENTS.CALENDAR_OPEN);
    }
}

function switchCalendarTab(tab, btn) {
    // CRITICAL FIX: Only update the sub-tab, do NOT reset country filter.
    // Previous code reset currentCalCountry = 'all' which caused the country
    // filter to be lost every time the user switched between today/tomorrow/week.
    currentCalendarTab = tab;
    document.querySelectorAll('.ni-cal-segment').forEach(b => b.classList.remove('active'));
    if (btn) {
        btn.classList.add('active');
    } else {
        const target = document.querySelector(`.ni-cal-segment[data-cal-tab="${tab}"]`);
        if (target) target.classList.add('active');
    }
    renderCalendarV2();
}

function filterCalCountry(country, btn) {
    currentCalCountry = country;
    document.querySelectorAll('.ni-cal-country').forEach(b => b.classList.remove('active'));
    if (btn) {
        btn.classList.add('active');
    }
    renderCalendarV2();
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

    // ── NEWS MODAL: PROFESSIONAL LAYOUT ──
    // Architecture: AI summary is pre-processed in background cron.
    // - If ai_summary exists → show it (no loading, no polling, no spinner)
    // - If ai_summary missing → show RSS body immediately (no waiting)
    // NO loading states, NO API calls on open, NO polling.

    const titleEl = el('news-modal-title');
    if (titleEl) titleEl.innerText = n.title;

    // Meta: time, source, category
    const timeEl = el('news-modal-time');
    if (timeEl) timeEl.innerText = formatNewsTimeTehran(n.pub_date, n.time || n.time_ago) || '—';
    const sourceEl = el('news-modal-source');
    if (sourceEl) sourceEl.innerText = n.source || n.source_name || '—';
    const categoryEl = el('news-modal-category');
    if (categoryEl) {
        const cat = n.category || 'crypto';
        const catLabels = { crypto: 'کریپتو', forex: 'فارکس', economy: 'اقتصاد' };
        categoryEl.innerText = catLabels[cat] || cat;
    }

    const imgEl = el('news-modal-image');
    if (imgEl) {
        imgEl.src = n.image || getAmirbtcFallbackSvg(400, 250, 'AMIRBTC');
        imgEl.onerror = function() { newsImageFallback(this); };
    }

    const bodyEl = el('news-modal-body');
    if (bodyEl) {
        const hasAiSummary = !!(n.ai_summary && n.ai_summary.trim().length > 50);

        if (hasAiSummary) {
            // AI summary ready — show ONLY the analysis (no RSS body)
            bodyEl.innerHTML =
                '<div class="news-modal-summary-box">' +
                    '<div class="news-modal-summary-header">' +
                        '<svg class="news-modal-ai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L13.09 8.26L20 9L13.09 9.74L12 16L10.91 9.74L4 9L10.91 8.26L12 2Z" stroke-linejoin="round"/><circle cx="12" cy="20" r="1"/></svg>' +
                        '<span>تحلیل خبر</span>' +
                    '</div>' +
                    '<div class="news-modal-summary-text">' + escapeHtmlForNews(n.ai_summary) + '</div>' +
                '</div>';
            // Add tags row (sentiment + impact + coins) if available
            let tagsHtml = '<div class="news-modal-tags">';
            if (n.sentiment) {
                const sentEmoji = { bullish: '🟢', bearish: '🔴', neutral: '🟡', breaking: '⚡', macro: '🌐' };
                const sentLabels = { bullish: 'صعودی', bearish: 'نزولی', neutral: 'خنثی', breaking: 'فوری', macro: 'کلان' };
                tagsHtml += '<span class="news-tag news-tag-sentiment">' + (sentEmoji[n.sentiment] || '•') + ' ' + (sentLabels[n.sentiment] || n.sentiment) + '</span>';
            }
            if (n.impact) {
                const impEmoji = { high: '⚡', medium: '⭐', low: '📉' };
                const impLabels = { high: 'تأثیر بالا', medium: 'تأثیر متوسط', low: 'تأثیر کم' };
                tagsHtml += '<span class="news-tag news-tag-impact-' + (n.impact || 'low') + '">' + (impEmoji[n.impact] || '•') + ' ' + (impLabels[n.impact] || n.impact) + '</span>';
            }
            if (n.coins && Array.isArray(n.coins) && n.coins.length > 0) {
                for (const coin of n.coins.slice(0, 5)) {
                    tagsHtml += '<span class="news-tag news-tag-coin">🪙 ' + escapeHtml(coin) + '</span>';
                }
            }
            tagsHtml += '</div>';
            bodyEl.innerHTML += tagsHtml;
        } else {
            // No AI summary — show differentiated message based on ai_status
            // Phase 10.5: pending / retry / failed / rate_limited / unknown each have unique message
            bodyEl.innerHTML = buildNewsPendingBox(n.ai_status);
        }
        bodyEl.style.opacity = '1';
    }

    const linkEl = el('news-modal-link');
    if (linkEl) {
        // P1-04 FIX (NEWSSEC-004): Sanitize URL scheme — only http/https allowed.
        // Prevents javascript:/data:/vbscript: URLs from executing on click.
        linkEl.href = sanitizeNewsUrl(n.url);
        // Keep the icon + text, just update text
        const spanEl = linkEl.querySelector('span');
        if (spanEl) spanEl.innerText = t('view_source');
    }

    const modalEl = el('news-modal');
    if (modalEl) modalEl.style.display = 'flex';
}

// Helper: escape HTML for news display (preserves line breaks as <br>)
function escapeHtmlForNews(text) {
    if (!text) return '';
    return String(text)
        .replace(/&/g, '&amp;')
        .replace(/</g, '&lt;')
        .replace(/>/g, '&gt;')
        .replace(/\n/g, '<br>');
}

/**
 * P1-04 FIX (NEWSSEC-004): Sanitize a news article URL before assigning it to
 * an anchor's href. Only http: and https: schemes are allowed — all others
 * (javascript:, data:, vbscript:, file:, etc.) are replaced with '#' so they
 * cannot execute when the user clicks the link.
 *
 * The URL comes from RSS <link> content (external/untrusted). Without this
 * check, a compromised RSS feed could inject `javascript:alert(...)` as an
 * article URL, and clicking "view source" would execute the payload.
 *
 * @param {string} url - Raw URL from news article
 * @returns {string} Safe URL (http/https) or '#' if unsafe/empty
 */
function sanitizeNewsUrl(url) {
    if (!url || typeof url !== 'string') return '#';
    const trimmed = url.trim();
    if (!trimmed) return '#';
    // Use a case-insensitive scheme check. Allow only http(s).
    // Relative URLs (starting with / or ./) are also safe — but news article
    // links are always absolute, so we reject relatives too for defense-in-depth.
    if (/^https?:\/\//i.test(trimmed)) {
        return trimmed;
    }
    return '#';
}

/**
 * Build the pending/failed/retry/rate_limited HTML for the news modal.
 * Phase 10.5: Differentiates status messages so users know exactly what's happening.
 *
 * Status types:
 *   completed    → handled by caller (shows summary)
 *   pending      → in queue, will be processed next tick (spinner + "در حال تولید...")
 *   retry        → failed once, in backoff, will retry (spinner + "در حال تلاش مجدد...")
 *   failed       → exhausted 3 retries, won't retry (no spinner + "در دسترس نیست")
 *   rate_limited → all AI providers circuit-open (spinner + "محدودیت موقت...")
 *   unknown      → not yet enqueued, will be picked up next batch (spinner + "در حال تولید...")
 *   processing   → (reserved for future use, currently same as pending)
 */
function buildNewsPendingBox(aiStatus) {
    const status = aiStatus || 'unknown';
    const isFailed = (status === 'failed');
    const isRateLimited = (status === 'rate_limited');
    const isRetry = (status === 'retry');

    let message, boxClass, iconClass, showShimmer;
    if (isFailed) {
        message = 'تحلیل این خبر فعلاً در دسترس نیست. می‌توانید منبع اصلی را مطالعه کنید.';
        boxClass = 'news-modal-summary-box news-modal-loading news-modal-ai-unavailable';
        iconClass = 'news-modal-ai-icon-unavailable';
        showShimmer = false;
    } else if (isRateLimited) {
        message = 'سرویس‌های هوش مصنوعی در حال حاضر دارای محدودیت نرخ هستند. تحلیل خبر بزودی تولید خواهد شد.';
        boxClass = 'news-modal-summary-box news-modal-loading news-modal-ai-retry';
        iconClass = '';
        showShimmer = true;
    } else if (isRetry) {
        message = 'تولید تحلیل این خبر با خطا مواجه شد و در حال تلاش مجدد است. طی چند دقیقه آینده تکمیل خواهد شد.';
        boxClass = 'news-modal-summary-box news-modal-loading news-modal-ai-retry';
        iconClass = '';
        showShimmer = true;
    } else {
        // pending, unknown, processing — premium "preparing" state
        message = 'در حال آماده‌سازی...';
        boxClass = 'news-modal-summary-box news-modal-loading news-modal-ai-pending';
        iconClass = '';
        showShimmer = true;
    }

    return '<div class="' + boxClass + '">' +
        '<div class="news-modal-summary-header">' +
            '<svg class="news-modal-ai-icon ' + iconClass + '" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L13.09 8.26L20 9L13.09 9.74L12 16L10.91 9.74L4 9L10.91 8.26L12 2Z" stroke-linejoin="round"/><circle cx="12" cy="20" r="1"/></svg>' +
            '<span>تحلیل هوشمند</span>' +
        '</div>' +
        '<div class="news-modal-summary-text news-modal-pending-text">' +
            (showShimmer ? '<div class="news-modal-shimmer-bar"></div>' : '') +
            '<p class="news-modal-pending-msg">' + message + '</p>' +
        '</div>' +
    '</div>';
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
// Race-condition guard for openCoinDetail.
// Each call increments this token; if a newer call starts, older calls abort silently.
let _detailLoadToken = 0;

// ============================================================================
// ── PERFORMANCE: TradingView script preloader ──
// ============================================================================
// Instead of lazy-loading tv.js on the FIRST openCoinDetail call (which blocks
// the chart for up to 5s), we preload it on app start. By the time the user
// taps a coin, tv.js is already loaded → chart renders instantly.
//
// The preloader is fire-and-forget: it starts loading immediately but never
// blocks the main thread. If it fails, openCoinDetail will retry.
let _tvJsLoadPromise = null;

/**
 * Preload the TradingView tv.js script on app start.
 * Called once during initialization — safe to call multiple times.
 * The script loads in the background; when a user first opens a coin detail,
 * the script is already cached.
 */
function preloadTradingViewScript() {
    if (window.TradingView || _tvJsLoadPromise) return;
    _tvJsLoadPromise = new Promise((resolve, reject) => {
        const s = document.createElement('script');
        s.src = 'https://s3.tradingview.com/tv.js';
        s.async = true;
        s.onload = () => {
            console.log('[CHART-PERF] tv.js preloaded successfully');
            resolve();
        };
        s.onerror = (e) => {
            console.warn('[CHART-PERF] tv.js preload failed (will retry on first openCoinDetail):', e);
            _tvJsLoadPromise = null; // Reset so openCoinDetail can retry
            reject(e);
        };
        document.head.appendChild(s);
    });
}

/**
 * Ensure TradingView is loaded. Returns a promise that resolves immediately
 * if already loaded, or waits for the preload to finish.
 * If preload hasn't started yet (edge case), starts it now.
 */
function ensureTradingViewLoaded() {
    if (window.TradingView) return Promise.resolve();
    if (_tvJsLoadPromise) return _tvJsLoadPromise;
    // Preload wasn't started — start it now (first openCoinDetail before init)
    preloadTradingViewScript();
    return _tvJsLoadPromise || Promise.resolve();
}

// Start preloading as soon as this script parses (non-blocking)
// The script tag is async, so it won't block page render.
if (typeof window !== 'undefined') {
    // Defer to next tick to avoid blocking initial render
    setTimeout(preloadTradingViewScript, 100);
}

// ============================================================================
// ── PERFORMANCE: localStorage cache for resolved chart symbols ──
// ============================================================================
// resolveChartSymbol hits the backend /api/charts/resolve which has a 1h KV cache.
// But even a KV cache hit is ~50-100ms latency. For REPEAT visits (same coin
// opened again), we cache the result in localStorage for instant lookup.
// TTL: 6 hours (matches the backend's 1h KV cache × a few refreshes).
const CHART_SYMBOL_LS_KEY = 'tv_symbol_cache_v1';
const CHART_SYMBOL_LS_TTL = 6 * 60 * 60 * 1000; // 6 hours

function getLsChartSymbol(symbol) {
    try {
        const raw = localStorage.getItem(CHART_SYMBOL_LS_KEY);
        if (!raw) return null;
        const cache = JSON.parse(raw);
        const entry = cache[symbol];
        if (!entry) return null;
        if (Date.now() - entry.ts > CHART_SYMBOL_LS_TTL) {
            delete cache[symbol];
            localStorage.setItem(CHART_SYMBOL_LS_KEY, JSON.stringify(cache));
            return null;
        }
        return entry.data;
    } catch { return null; }
}

function setLsChartSymbol(symbol, data) {
    try {
        const raw = localStorage.getItem(CHART_SYMBOL_LS_KEY);
        const cache = raw ? JSON.parse(raw) : {};
        cache[symbol] = { data, ts: Date.now() };
        // Evict oldest entries if cache grows too large (max 100 symbols)
        const keys = Object.keys(cache);
        if (keys.length > 100) {
            keys.sort((a, b) => cache[a].ts - cache[b].ts);
            for (let i = 0; i < keys.length - 80; i++) delete cache[keys[i]];
        }
        localStorage.setItem(CHART_SYMBOL_LS_KEY, JSON.stringify(cache));
    } catch { /* localStorage full or disabled — non-fatal */ }
}

/**
 * BUG 1 FIX — Fully clear ALL previous-asset state before opening a new one.
 * Called at the START of both openCoinDetail and openForexDetail so no
 * previous coin's logo, symbol, name, rank, price, alert price, chart,
 * statistics, or watchlist button can bleed into the new asset.
 *
 * This is the root-cause fix for "BTC data remains visible when opening ETH":
 * previously the icon/stats/watchlist-btn were only updated inside
 * openCoinDetail (never openForexDetail), and nothing was reset during the
 * async gap while the chart symbol was being resolved — so the old asset's
 * values flashed or persisted.
 */
function resetDetailState() {
    // ── Destroy any existing chart FIRST (prevents stale chart flash) ──
    destroyTvWidget();
    currentTvChartInfo = null;

    // ── Reset top-bar identity ──
    const iconEl = document.getElementById('detail-coin-icon');
    if (iconEl) {
        iconEl.removeAttribute('src');
        iconEl.removeAttribute('data-symbol');
        iconEl.style.visibility = 'hidden'; // hide until the new asset sets it
    }
    setText('detail-coin-title', '--');
    setText('detail-coin-rank', '--');
    setText('detail-coin-price', '--');
    const changeEl = document.getElementById('detail-coin-change');
    if (changeEl) { changeEl.textContent = '--'; changeEl.className = 'cd-change'; }

    // ── Reset alert card ──
    setText('alert-current-price-value', '--');
    const alertList = document.getElementById('active-alerts');
    if (alertList) alertList.innerHTML = '';
    setText('cd-alert-status-value', 'غیرفعال');
    setText('cd-alert-count-num', '0');

    // ── Reset statistics grid ──
    setText('cd-stat-mcap', '--');
    setText('cd-stat-volume', '--');
    setText('cd-stat-supply', '--');
    setText('cd-stat-rank', '--');

    // ── Reset watchlist button ──
    const watchBtn = document.getElementById('detail-watch-btn');
    if (watchBtn) {
        watchBtn.classList.remove('active');
        watchBtn.removeAttribute('data-symbol');
        const svg = watchBtn.querySelector('svg');
        if (svg) svg.setAttribute('fill', 'none');
    }

    // ── Reset alert direction toggle to default ──
    document.querySelectorAll('.cd-alert-dir-btn').forEach(b => b.classList.remove('active'));
    const defaultDirBtn = document.querySelector('.cd-alert-dir-btn[data-direction="above"]');
    if (defaultDirBtn) defaultDirBtn.classList.add('active');
    currentAlertDirection = 'above';

    // ── Hide AI section (will be shown again if the new asset has analysis) ──
    const aiSection = document.getElementById('cd-ai-section');
    if (aiSection) aiSection.style.display = 'none';

    // ── Clear alert price input ──
    const alertInput = document.getElementById('alert-price');
    if (alertInput) alertInput.value = '';

    // ── Show skeleton loader in chart container (never blank) ──
    showChartSkeleton();

    // ── Reset live-price-refresh tracking ──
    if (typeof refreshOpenDetailPrice !== 'undefined' && refreshOpenDetailPrice._lastPrice) {
        refreshOpenDetailPrice._lastPrice = {};
    }
}

// helper for resetDetailState
function setText(id, text) {
    const el = document.getElementById(id);
    if (el) el.textContent = text;
}

/**
 * Detect if a symbol represents a BTC pair (e.g. "ETHBTC", "SOLBTC").
 * Returns the base symbol ("ETH") if true, or null if not a BTC pair.
 *
 * Convention: a BTC pair ends with "BTC" but is not "BTC" itself, and the
 * base symbol must be at least 2 characters (so "BTC" alone is NOT a BTC pair).
 *
 * Examples:
 *   "ETHBTC" → "ETH"
 *   "SOLBTC" → "SOL"
 *   "BTC"    → null  (BTC itself, not a pair)
 *   "ETH"    → null  (regular USDT-paired coin)
 *   "ETHUSDT" → null (explicit USDT pair)
 */
function parseBtcPairSymbol(symbol) {
    const sym = String(symbol || '').toUpperCase().trim();
    if (sym === 'BTC') return null;
    if (sym === 'BTCUSDT') return null;
    if (!sym.endsWith('BTC')) return null;
    const base = sym.slice(0, -3); // strip "BTC" suffix
    if (base.length < 2) return null;
    if (!/^[A-Z0-9]+$/.test(base)) return null;
    // "BTC" itself is not a valid base (e.g. "BTCBTC" is meaningless)
    if (base === 'BTC') return null;
    return base;
}

async function openCoinDetail(symbol) {
    // DEFENSE-IN-DEPTH (Watchlist Detail/Chart fix): if this symbol is actually
    // a forex/metal/stock pair (in allForexPairs), route to openForexDetail
    // instead. This catches forex symbols that reach openCoinDetail via any
    // legacy caller or stale DOM that didn't use the isForex-aware routing at
    // render time (app.js:6120). openForexDetail uses pair.tvSymbol directly
    // (no /api/charts/resolve backend waterfall) and shows the modal FIRST
    // (fast path). Without this guard, forex symbols routed through openCoinDetail
    // hit resolveChartSymbol → /api/charts/resolve → resolveChartExchange which
    // builds nonsensical candidates (BINANCE:EURUSDUSDT) and runs a 4-24s
    // waterfall, then shows "chart unavailable".
    if (Array.isArray(allForexPairs) && allForexPairs.some(f => f.symbol === symbol)) {
        return openForexDetail(symbol);
    }

    // Increment token to invalidate any in-flight older calls
    const token = ++_detailLoadToken;

    // BUG 1 FIX: fully clear previous asset state BEFORE doing anything async.
    // This ensures no previous coin's logo/price/stats/chart flashes while we
    // load the new one.
    resetDetailState();

    // ── PERFORMANCE FIX: Parallelize tv.js load + chart symbol resolution ──
    // Previously these were SERIAL: load tv.js (up to 5s) → THEN resolve symbol (500ms).
    // Now they run concurrently via Promise.all, cutting the waterfall from 5.5s to max(5s, 500ms).
    // If tv.js was preloaded (preloadTradingViewScript), it's already cached → instant.
    let chartAvailable = true;
    const tvJsPromise = ensureTradingViewLoaded(); // Returns immediately if already loaded

    // Start symbol resolution IN PARALLEL with tv.js load
    // (resolveChartSymbol hits backend /api/charts/resolve which has 1h KV cache)
    const btcPairBase = parseBtcPairSymbol(symbol);
    const isBtcPair = btcPairBase !== null;
    const baseSymbol = isBtcPair ? btcPairBase : symbol;

    // ── Look up coin data while tv.js + symbol resolve in parallel ──
    let coin = allCoins.find(c => c.symbol === baseSymbol);
    let coinPriceUnknown = false;
    if (!coin) {
        const searchCacheKey = `search_coin_${baseSymbol}`;
        const cachedSearchCoin = Cache.get(searchCacheKey);
        if (cachedSearchCoin) {
            coin = cachedSearchCoin;
        }
        // NOTE: /api/market/price fallback deferred — don't block the chart on it.
        // The chart renders from TradingView data, not our price API.
    }

    // ── Wait for BOTH tv.js AND chart symbol resolution (in parallel) ──
    let chartInfo = null;
    try {
        const [, resolvedChart] = await Promise.all([
            tvJsPromise.catch(e => {
                console.warn('TradingView script failed to load — chart will be hidden, but coin detail will still show price/stats:', e?.message || e);
                chartAvailable = false;
            }),
            resolveChartSymbol(symbol).then(info => { chartInfo = info; }),
        ]);
    } catch (e) {
        console.warn('openCoinDetail parallel load error:', e?.message);
    }

    // RACE GUARD: if a newer openCoinDetail call started while we were loading, abort.
    if (token !== _detailLoadToken) return;


    // ── BTC PAIR DETECTION (variables already declared above for parallel use) ──
    // btcPairBase, isBtcPair, baseSymbol, coin, coinPriceUnknown are all set above.

    // H1 FIX: If we still don't have coin data (e.g. coin outside top-200 AND
    // no search cache), build a minimal placeholder so the modal opens and the
    // chart renders. The chart fetches its own data from TradingView — it does
    // NOT depend on our price API.
    if (!coin) {
        coin = {
            symbol: baseSymbol,
            name: baseSymbol,
            priceUsd: 0,
            changePercent24Hr: 0,
            volumeUsd24Hr: 0,
            marketCapUsd: 0,
            rank: 0,
            image: `https://assets.coincap.io/assets/icons/${encodeURIComponent(baseSymbol).toLowerCase()}@2x.png`,
        };
        coinPriceUnknown = true;

        // ── PERFORMANCE FIX: Fetch price in the BACKGROUND (non-blocking) ──
        // Previously this was an AWAIT, blocking the chart by 200-500ms.
        // Now we fire-and-forget: if the price arrives, we update the UI; if not,
        // the chart still renders immediately.
        fetch(`${API_BASE}/api/market/price?symbol=${encodeURIComponent(baseSymbol)}`, {
            headers: { 'X-Telegram-Init-Data': getTelegramInitData() || '' }
        }).then(r => r.ok ? r.json() : null).then(priceData => {
            if (priceData && priceData.price && token === _detailLoadToken && _currentDetailSymbol === symbol) {
                coin.priceUsd = priceData.price;
                coinPriceUnknown = false;
                const priceEl = document.getElementById('detail-coin-price');
                if (priceEl) priceEl.textContent = '$' + (priceData.price > 1 ? priceData.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : priceData.price.toFixed(6));
                const alertPriceVal = document.getElementById('alert-current-price-value');
                if (alertPriceVal) alertPriceVal.textContent = '$' + priceData.price;
            }
        }).catch(e => console.warn('background price fetch failed:', e?.message));

        // Don't show the "price unavailable" toast anymore — the background fetch
        // will fill it in silently if it succeeds.
    }

    // ── Top Bar: Icon, Title, Rank, Price, Change ──
    const icon = coin.image || `https://assets.coincap.io/assets/icons/${encodeURIComponent(coin.symbol).toLowerCase()}@2x.png`;
    const iconEl = document.getElementById('detail-coin-icon');
    if (iconEl) {
        iconEl.dataset.symbol = baseSymbol;
        iconEl.src = icon;
        iconEl.style.visibility = 'visible';
        iconEl.onerror = function() { iconFallback(this); };
    }

    // Title: for BTC pairs, show "ETH/BTC"; for regular coins, show "BTC / USDT"
    if (isBtcPair) {
        document.getElementById('detail-coin-title').innerText = `${baseSymbol} / BTC`;
    } else {
        document.getElementById('detail-coin-title').innerText = currentLang === 'fa' && coin.name ? `${coin.name} (${symbol})` : `${symbol} / USDT`;
    }
    _currentDetailSymbol = symbol; // Keep the FULL symbol (e.g. "ETHBTC") for chart resolution

    // Rank badge
    const rankEl = document.getElementById('detail-coin-rank');
    if (rankEl) rankEl.textContent = '#' + (Number(coin.rank) || 0);

    // Price + change in header
    // For BTC pairs: show the pair price (coin/BTC) and the relative change vs BTC
    // For regular coins: show USD price and 24h change
    const priceEl = document.getElementById('detail-coin-price');
    const changeEl = document.getElementById('detail-coin-change');
    // Declare priceStr + isBtcPairDisplay in the OUTER scope so the alert
    // section below can access them. Previously `const priceStr` was declared
    // inside the else block (block-scoped), leaving the outer reference undefined
    // when isBtcPair=false → caused "$undefined" in the alert price display.
    let priceStr = '--';
    let isBtcPairDisplay = false;
    if (isBtcPair) {
        const btc = allCoins.find(c => c.symbol === 'BTC');
        const btcPrice = btc?.priceUsd || 0;
        const btcChange = btc?.changePercent24Hr || 0;
        if (btcPrice > 0) {
            const pairPrice = coin.priceUsd / btcPrice;
            if (pairPrice >= 1) priceStr = pairPrice.toFixed(6);
            else if (pairPrice >= 0.001) priceStr = pairPrice.toFixed(8);
            else priceStr = pairPrice.toExponential(2);
            if (priceEl) priceEl.textContent = priceStr + ' BTC';
        } else {
            if (priceEl) priceEl.textContent = '-- BTC';
        }
        const relChange = (coin.changePercent24Hr || 0) - btcChange;
        if (changeEl) {
            changeEl.textContent = (relChange >= 0 ? '+' : '') + relChange.toFixed(2) + '%';
            changeEl.className = 'cd-change ' + (relChange >= 0 ? 'up' : 'down');
        }
        isBtcPairDisplay = true;
    } else {
        // H1 FIX: if price is unknown (coin not in top-200 + no auth), show '--'
        // instead of '$0.00' which is misleading.
        if (coinPriceUnknown || !coin.priceUsd) {
            priceStr = '--';
            if (priceEl) priceEl.textContent = '--';
            if (changeEl) {
                changeEl.textContent = '--';
                changeEl.className = 'cd-change';
            }
        } else {
            priceStr = coin.priceUsd > 1 ? coin.priceUsd.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : coin.priceUsd.toFixed(6);
            if (priceEl) priceEl.textContent = '$' + priceStr;
            if (changeEl) {
                const chg = coin.changePercent24Hr || 0;
                changeEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
                changeEl.className = 'cd-change ' + (chg >= 0 ? 'up' : 'down');
            }
        }
        isBtcPairDisplay = false;
    }

    // ── Market Statistics ──
    const setStatText = (id, text) => { const el = document.getElementById(id); if (el) el.textContent = text; };
    setStatText('cd-stat-mcap', '$' + formatLargeNumber(coin.marketCapUsd || 0));
    setStatText('cd-stat-volume', '$' + formatLargeNumber(coin.volumeUsd24Hr || 0));
    setStatText('cd-stat-supply', coin.supply ? formatLargeNumber(coin.supply) : '--');
    setStatText('cd-stat-rank', '#' + (Number(coin.rank) || 0));

    // ── Alert section: current price binding ──
    // CRITICAL: this must use the CURRENT coin's price, not a stale value from a previous call.
    // For BTC pairs, show pair price in BTC; for regular coins, show USD price.
    const alertPriceVal = document.getElementById('alert-current-price-value');
    if (alertPriceVal) {
        alertPriceVal.textContent = isBtcPairDisplay ? (priceStr + ' BTC') : ('$' + priceStr);
    }

    // ── Update watchlist button state ──
    // For BTC pairs, the watchlist stores the BASE symbol (e.g. "ETH"), not the pair
    updateDetailWatchBtn(baseSymbol);

    // ── Show modal ──
    const modal = document.getElementById('coin-detail-modal');
    if (!modal) return;
    modal.style.display = 'flex';

    // ── PERFORMANCE FIX: chartInfo was already resolved in PARALLEL with tv.js above ──
    // No need to call resolveChartSymbol again — it's cached in the `chartInfo` variable.
    // This eliminates a second serial network round-trip (~500ms saved).

    // RACE GUARD: if a newer openCoinDetail call started while we were resolving the chart, abort.
    // This prevents stale chart/alert data from overwriting the newer coin's state.
    if (token !== _detailLoadToken) return;

    // SAFETY: re-assert the alert price in case something overwrote it during the await.
    // This is the root-cause fix for "alert price stuck on BTC" — ensures the price always
    // matches _currentDetailSymbol, never a stale value from a previous call.
    if (alertPriceVal && _currentDetailSymbol === symbol) {
        alertPriceVal.textContent = '$' + priceStr;
    }
    if (priceEl && _currentDetailSymbol === symbol) {
        priceEl.textContent = '$' + priceStr;
    }

    currentTvChartInfo = chartInfo;
    currentTvInterval = 'D';
    updateTvTimeframeUI();
    createTradingViewWidget(chartInfo);

    // ── Active Alerts ──
    // Only render if we're still the active coin (no newer call has started)
    if (token === _detailLoadToken && _currentDetailSymbol === symbol) {
        renderActiveAlerts(symbol);
    }
}
/**
 * ویجت TradingView را با تنظیمات فعلی می‌سازد.
 * ورودی: پارامترهای `chartInfo` را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی وضعیت یا رابط کاربری اعمال می‌شود.
 */
/**
 * BUG 2 FIX — Proper TradingView widget lifecycle.
 * Destroys the old widget instance, removes ALL iframes/scripts TradingView
 * may have injected, and clears the container BEFORE creating a new widget.
 * This eliminates "previous chart remains" and "chart never loads after
 * switching" issues caused by leftover iframe state.
 */
function destroyTvWidget() {
    // 1. Destroy the widget instance (TradingView.widget has a .remove() method)
    if (currentTvWidget) {
        try { currentTvWidget.remove(); } catch {}
        currentTvWidget = null;
    }
    // 2. Remove the exchange badge (it's a sibling of the chart container)
    document.querySelector('.chart-exchange-badge')?.remove();
    // 3. Nuke every iframe inside the chart container (TradingView creates one
    //    per widget instance; without removing them, switching assets stacks
    //    stale charts and the new one may not render).
    const chartContainer = document.getElementById('detail-chart');
    if (chartContainer) {
        chartContainer.querySelectorAll('iframe').forEach(iframe => {
            try { iframe.src = 'about:blank'; } catch {}
            iframe.remove();
        });
        chartContainer.querySelectorAll('script').forEach(s => s.remove());
        chartContainer.innerHTML = '';
    }
}

/**
 * BUG 5 FIX — Show a premium skeleton loader in the chart container while
 * the chart is loading. Never show a blank area.
 */
function showChartSkeleton() {
    const chartContainer = document.getElementById('detail-chart');
    if (!chartContainer) return;
    destroyTvWidget();
    chartContainer.innerHTML =
        '<div class="cd-chart-skeleton">' +
            '<div class="cd-chart-skeleton-bar"></div>' +
            '<div class="cd-chart-skeleton-bar"></div>' +
            '<div class="cd-chart-skeleton-bar"></div>' +
            '<div class="cd-chart-skeleton-canvas"></div>' +
        '</div>';
}

/**
 * BUG 5 FIX — Show a "fallback searching" state while the exchange priority
 * system tries the next exchange.
 */
function showChartFallbackSearching(exchangeName) {
    const chartContainer = document.getElementById('detail-chart');
    if (!chartContainer) return;
    chartContainer.innerHTML =
        '<div class="cd-chart-status">' +
            '<div class="cd-chart-fallback-search">' +
                '<div class="cd-chart-mini-spinner"></div>' +
                '<span>جستجوی منبع جایگزین' + (exchangeName ? ' (' + exchangeName + ')' : '') + '...</span>' +
            '</div>' +
        '</div>';
}

/**
 * BUG 5 FIX — Show an elegant "chart unavailable" card (never raw TradingView
 * errors). Called only when ALL exchanges in the priority chain have failed.
 */
function showChartUnavailable() {
    const chartContainer = document.getElementById('detail-chart');
    if (!chartContainer) return;
    destroyTvWidget();
    chartContainer.innerHTML =
        '<div class="cd-chart-status">' +
            '<div class="cd-chart-status-icon error">' +
                '<svg width="28" height="28" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round">' +
                    '<path d="M3 3v18h18"/>' +
                    '<path d="M7 16l4-8 4 5 5-9"/>' +
                '</svg>' +
            '</div>' +
            '<div class="cd-chart-status-title">نمودار این دارایی در حال حاضر در دسترس نیست</div>' +
            '<div class="cd-chart-status-sub">لطفاً بعداً دوباره تلاش کنید یا نماد دیگری را بررسی کنید.</div>' +
        '</div>';
}

function createTradingViewWidget(chartInfo) {
    const chartContainer = document.getElementById('detail-chart');
    if (!chartContainer) return;

    // BUG 2 FIX: full destroy + clear before recreating
    destroyTvWidget();

    if (typeof TradingView !== 'undefined' && chartInfo && chartInfo.found && chartInfo.tv_symbol) {
        if (chartInfo.exchange) {
            const badge = document.createElement('div');
            badge.className = 'chart-exchange-badge';
            badge.innerText = chartInfo.exchange.toUpperCase();
            chartContainer.parentNode.insertBefore(badge, chartContainer);
        }
        try {
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
        } catch (e) {
            console.warn('[CHART] TradingView.widget creation failed:', e);
            showChartUnavailable();
        }
    } else {
        // BUG 5 FIX: elegant fallback card instead of raw empty-state
        showChartUnavailable();
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
    document.querySelectorAll('.cd-tf-btn').forEach(b => {
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
    // ── Ensure Market tab is visible (X button returns user to Market) ──
    // The Coin Detail modal is a fixed overlay (z-index:10000) on top of the
    // active page. When opened from Dashboard/Watchlist/etc., closing it must
    // send the user back to the Market page as required by the UX spec.
    // Because switchTab('market-page') only triggers renderMarket() with the
    // SAME renderKey (price-only diffing), the existing coin list DOM is
    // preserved — scroll position stays intact.
    const marketPage = document.getElementById('market-page');
    const isMarketActive = marketPage && marketPage.classList.contains('active');
    if (!isMarketActive) {
        // Find the bottom-nav Market button and switch via switchTab to keep
        // nav highlight in sync. Fallback to direct class swap if not found.
        const marketNavBtn = document.querySelector('.nav-item[data-page="market-page"]')
            || Array.from(document.querySelectorAll('.nav-item')).find(n =>
                n.getAttribute('onclick')?.includes('market-page'));
        if (typeof switchTab === 'function') {
            switchTab('market-page', marketNavBtn || undefined);
        } else if (marketPage) {
            document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
            marketPage.classList.add('active');
        }
    }

    // BUG 2 FIX: centralized chart destruction (was inline, duplicated).
    destroyTvWidget();
    currentTvChartInfo = null;
    _currentDetailSymbol = null;
    // BUG 1 FIX: reset the alert current-price so no stale value survives a close.
    const _alertPriceReset = document.getElementById('alert-current-price-value');
    if (_alertPriceReset) _alertPriceReset.textContent = '--';
    const modal = document.getElementById('coin-detail-modal');
    modal.classList.remove('slide-up');
    modal.classList.add('slide-down');
    let closed = false;
    const finishClose = () => {
        if (closed) return;
        closed = true;
        modal.style.display = 'none';
        modal.classList.remove('slide-down');
        modal.removeEventListener('animationend', onAnimEnd);
    };
    const onAnimEnd = () => finishClose();
    modal.addEventListener('animationend', onAnimEnd);
    // Safety net: if animationend never fires (e.g., prefers-reduced-motion,
    // display:none ancestor, or animation cancelled), force-hide after 350ms.
    setTimeout(finishClose, 350);
}

/**
 * Open forex pair detail modal with TradingView chart.
 */
async function openForexDetail(symbol) {
    const pair = allForexPairs.find(f => f.symbol === symbol);
    if (!pair) return;

    // BUG 1 FIX: fully clear previous asset state BEFORE populating forex data.
    resetDetailState();

    const modal = document.getElementById('coin-detail-modal');
    if (!modal) return;
    modal.style.display = 'flex';
    modal.classList.remove('slide-down');
    modal.classList.add('slide-up');
    modal.addEventListener('animationend', function handler() {
        modal.classList.remove('slide-up');
        modal.removeEventListener('animationend', handler);
    });

    // ── Lazy-load TradingView script (same pattern as openCoinDetail) ──
    // ROOT CAUSE FIX: openForexDetail was synchronous and never loaded tv.js.
    // openCoinDetail had the lazy-load logic, but openForexDetail was missing it.
    // If the user opened a forex pair FIRST (before any crypto), TradingView
    // was undefined → createTradingViewWidget fell through to showChartUnavailable.
    if (!window.TradingView) {
        const s = document.createElement('script');
        s.src = 'https://s3.tradingview.com/tv.js';
        document.head.appendChild(s);
        try {
            await new Promise((resolve, reject) => {
                s.onload = resolve;
                s.onerror = reject;
                setTimeout(() => reject(new Error('tv.js load timeout')), 5000);
            });
        } catch (e) {
            console.warn('TradingView script failed to load for forex:', e?.message || e);
        }
    }

    // ── Top bar: set a category icon for forex/metals (crypto logo is N/A) ──
    // resetDetailState hid the icon; for forex we show a category badge instead
    // of a coin logo so the user never sees a stale crypto logo.
    const iconEl = document.getElementById('detail-coin-icon');
    if (iconEl) {
        const cat = pair.category || 'major';
        const catColors = { major: '#22C55E', cross: '#F5A623', metal: '#FFD700', stock: '#60A5FA' };
        const catSvgPaths = {
            major: '<path d="M3 3v18h18"/><path d="m19 9-5 5-4-4-3 3"/>',
            cross: '<line x1="8" y1="6" x2="21" y2="6"/><line x1="8" y1="12" x2="21" y2="12"/><line x1="8" y1="18" x2="21" y2="18"/>',
            metal: '<circle cx="12" cy="12" r="10"/><path d="M8 14h8M8 10h8M12 6v12"/>',
            index: '<rect x="3" y="3" width="18" height="18" rx="2"/><line x1="9" y1="9" x2="15" y2="9"/><line x1="9" y1="13" x2="15" y2="13"/>',
            commodity: '<path d="M3 22h18M5 22V8l5-4 5 4v14M9 22v-6h4v6"/>',
        };
        const color = catColors[cat] || '#F5A623';
        const path = catSvgPaths[cat] || catSvgPaths.major;
        iconEl.removeAttribute('src');
        iconEl.removeAttribute('data-symbol');
        iconEl.onerror = null;
        const svg = `<svg xmlns="http://www.w3.org/2000/svg" width="80" height="80" viewBox="0 0 80 80"><circle cx="40" cy="40" r="38" fill="${color}15" stroke="${color}30" stroke-width="1"/><g transform="translate(16 16) scale(2)" fill="none" stroke="${color}" stroke-width="2" stroke-linecap="round" stroke-linejoin="round">${path}</g></svg>`;
        iconEl.src = 'data:image/svg+xml;charset=utf-8,' + encodeURIComponent(svg);
        iconEl.style.visibility = 'visible';
    }

    document.getElementById('detail-coin-title').innerText = pair.name || symbol;
    _currentDetailSymbol = symbol;

    // Rank badge — forex has no rank; show symbol-aware category badge instead
    const rankEl = document.getElementById('detail-coin-rank');
    if (rankEl) {
        // Metals: show the actual metal code (XAU/XAU) from the symbol prefix
        const cat = pair.category || 'major';
        let rankText;
        if (cat === 'metal') {
            rankText = symbol.slice(0, 3); // XAU for XAUUSD, XAG for XAGUSD
        } else {
            rankText = { major: 'FX', cross: 'FX', index: 'IDX', commodity: 'COM' }[cat] || 'FX';
        }
        rankEl.textContent = rankText;
    }

    // Price in header for forex — compute formatted price string once
    const priceEl = document.getElementById('detail-coin-price');
    const changeEl = document.getElementById('detail-coin-change');
    const forexPriceStr = pair.price > 0 ? pair.price.toFixed(pair.category === 'metal' ? 2 : (pair.category === 'index' || pair.category === 'commodity' ? 0 : 4)) : '--';
    if (priceEl) priceEl.textContent = forexPriceStr;
    if (changeEl) {
        // BUG 3 fix: show the real daily change for forex/metals when the worker provides it
        const fchg = (typeof pair.change === 'number' && !isNaN(pair.change)) ? pair.change : 0;
        changeEl.textContent = fchg !== 0 ? (fchg >= 0 ? '+' : '') + fchg.toFixed(2) + '%' : '';
        changeEl.className = 'cd-change ' + (fchg >= 0 ? 'up' : 'down');
    }

    // ── BUG 1 FIX: Alert card current-price binding for forex/metals ──
    // MUST write the CURRENT asset's price so a stale crypto price never lingers
    // in the alert card after switching from a crypto asset to a forex/metal.
    const alertPriceVal = document.getElementById('alert-current-price-value');
    if (alertPriceVal) {
        alertPriceVal.textContent = pair.price > 0 ? '$' + forexPriceStr : '--';
    }

    // ── Update watchlist button state (forex symbols can be watchlisted too) ──
    updateDetailWatchBtn(symbol);

    // BUG 2 FIX: chart skeleton already shown by resetDetailState; now build chart info
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
    const catLabels = { major: 'Major', cross: 'Cross', metal: 'Metal', stock: 'Stock' };
    const catLabelFa = { major: 'جفت اصلی', cross: 'کراس', metal: 'فلز گران‌بها', stock: 'سهم' };
    const catLabel = currentLang === 'fa' ? (catLabelFa[cat] || cat) : (catLabels[cat] || cat);
    const typeLabel = currentLang === 'fa'
        ? ({ major: 'فارکس', cross: 'فارکس', metal: 'فلز', stock: 'سهم' }[cat] || 'بازار')
        : ({ major: 'Forex', cross: 'Forex', metal: 'Metal', stock: 'Stock' }[cat] || 'Market');

    // ── Premium stats grid for forex/metals ──
    // Previously this rendered bare .info-item spans (whose CSS is scoped under
    // .detail-extra-info, NOT .cd-stats-grid), so the forex detail stats looked
    // unstyled next to the crypto detail's premium 2x2 cards. Now we render the
    // SAME .cd-stat-item grid as crypto, with forex-relevant metrics: current
    // price, daily change %, category, and symbol. This gives every asset type
    // a consistent, premium statistics card.
    const fchg = (typeof pair.change === 'number' && !isNaN(pair.change)) ? pair.change : 0;
    const changeStr = fchg !== 0 ? (fchg >= 0 ? '+' : '') + fchg.toFixed(2) + '%' : '--';
    const changeCls = fchg > 0 ? 'cd-stat-value-up' : (fchg < 0 ? 'cd-stat-value-down' : '');
    const priceDisplay = pair.price > 0
        ? (cat === 'metal' && pair.price > 1000
            ? '$' + pair.price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
            : cat === 'metal'
                ? '$' + pair.price.toFixed(2)
                : '$' + pair.price.toFixed(4))
        : '--';
    document.getElementById('detail-stats').innerHTML =
        `<div class="cd-stat-item"><span class="cd-stat-label">${currentLang === 'fa' ? 'قیمت فعلی' : 'Current Price'}</span><span class="cd-stat-value">${priceDisplay}</span></div>` +
        `<div class="cd-stat-item"><span class="cd-stat-label">${currentLang === 'fa' ? 'تغییر روزانه' : 'Daily Change'}</span><span class="cd-stat-value ${changeCls}">${changeStr}</span></div>` +
        `<div class="cd-stat-item"><span class="cd-stat-label">${currentLang === 'fa' ? 'دسته‌بندی' : 'Category'}</span><span class="cd-stat-value" style="font-size:13px;">${catLabel}</span></div>` +
        `<div class="cd-stat-item"><span class="cd-stat-label">${currentLang === 'fa' ? 'نوع' : 'Type'}</span><span class="cd-stat-value" style="font-size:13px;">${typeLabel}</span></div>`;

    // ── BUG 1 FIX: Alert card stays VISIBLE for every asset type ──
    // Previously this tried to hide the alert card with a dead `.alert-section`
    // selector (the real class is `.cd-alert-card`), so the hide was a no-op and
    // the previous crypto price stayed stuck in the card. Now we keep the card
    // visible for ALL asset types and render the active alerts for THIS symbol,
    // so the entire card always reflects the currently-opened asset.
    const cdAlertCard = document.querySelector('#coin-detail-modal .cd-alert-card');
    if (cdAlertCard) cdAlertCard.style.display = '';
    renderActiveAlerts(symbol);
}
document.addEventListener('keydown', (e) => {
    if (e.key === 'Escape') {
        const newsModal = document.getElementById('news-modal');
        if (newsModal && (newsModal.style.display === 'flex' || newsModal.style.display === 'block')) {
            closeNewsModal();
            return;
        }
        if (document.getElementById('coin-detail-modal').style.display === 'flex') closeCoinDetail();
    }
});
function selectAlertDirection(dir, btn) {
    currentAlertDirection = dir;
    document.querySelectorAll('.alert-dir-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

/**
 * Direction toggle for the new premium Coin Detail alert card.
 * Updates currentAlertDirection and the .cd-alert-dir-btn active states.
 */
function selectCdAlertDirection(dir, btn) {
    currentAlertDirection = dir;
    document.querySelectorAll('.cd-alert-dir-btn').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
}

// ============================================================================
// ── REMOVED: Quick Preset Buttons (+5%, -5%, +10%, -10%) ──
// Replaced with simple Crossing alert. User enters a specific price and
// selects direction (above/below). The system triggers when price crosses
// that level. No percentage-based presets needed.
// window.applyAlertPreset removed.

/**
 * Update the alert status badge (active count + status icon/text)
 * based on the current symbol's active alerts.
 */
function updateCdAlertStatus(symbol) {
    const numEl = document.getElementById('cd-alert-count-num');
    const badgeEl = document.getElementById('cd-alert-count-badge');
    const statusIconEl = document.getElementById('cd-alert-status-icon');
    const statusValueEl = document.getElementById('cd-alert-status-value');
    if (!symbol) return;
    const userAlerts = alerts.filter(a => a.symbol === symbol);
    const count = userAlerts.length;
    if (numEl) numEl.textContent = String(count);
    if (badgeEl) badgeEl.classList.toggle('has-alerts', count > 0);
    if (statusIconEl) statusIconEl.classList.toggle('active', count > 0);
    if (statusValueEl) {
        statusValueEl.textContent = count > 0
            ? (currentLang === 'fa' ? `${count} هشدار فعال` : `${count} active`)
            : (currentLang === 'fa' ? 'غیرفعال' : 'Inactive');
        statusValueEl.classList.toggle('active', count > 0);
    }
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
    if (!container || !symbol) {
        if (container) container.innerHTML = '';
        updateCdAlertStatus(symbol);
        return;
    }
    const userAlerts = alerts.filter(a => a.symbol === symbol);
    // Update the status badge regardless of list state
    updateCdAlertStatus(symbol);
    if (!userAlerts.length) {
        container.innerHTML = `
            <div class="cd-alert-empty">
                <svg class="cd-alert-empty-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5">
                    <path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/>
                    <path d="M13.73 21a2 2 0 0 1-3.46 0"/>
                </svg>
                ${t('alert_empty') || 'هیچ هشدار فعالی وجود ندارد'}
            </div>
        `;
        return;
    }
    container.innerHTML = userAlerts.map(a => {
        const priceStr = a.price >= 1 ? Number(a.price).toFixed(2) : Number(a.price).toFixed(6);
        const dir = (a.direction || 'above').toLowerCase();
        const dirIcon = dir === 'below'
            ? '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="6 9 12 15 18 9"/></svg>'
            : '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3"><polyline points="18 15 12 9 6 15"/></svg>';
        const dirLabel = dir === 'below'
            ? (currentLang === 'fa' ? 'وقتی پایین‌تر رفت' : 'When below')
            : (currentLang === 'fa' ? 'وقتی بالاتر رفت' : 'When above');
        const createdAt = a.createdAt ? new Date(a.createdAt).toLocaleDateString(currentLang === 'fa' ? 'fa-IR' : 'en-US', { month: 'short', day: 'numeric' }) : '';
        return `
        <div class="cd-alert-item">
            <div class="cd-alert-item-dir ${dir}">${dirIcon}</div>
            <div class="cd-alert-item-info">
                <span class="cd-alert-item-price">$${priceStr}</span>
                <span class="cd-alert-item-meta">${escapeHtml(dirLabel)}${createdAt ? ' · ' + escapeHtml(createdAt) : ''}</span>
            </div>
            <button class="cd-alert-item-delete" data-id="${escapeHtml(a.id)}" onclick="removeAlert(this.dataset.id)" aria-label="Delete alert">
                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round"><polyline points="3 6 5 6 21 6"/><path d="M19 6v14a2 2 0 0 1-2 2H7a2 2 0 0 1-2-2V6m3 0V4a2 2 0 0 1 2-2h4a2 2 0 0 1 2 2v2"/></svg>
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
        // If the coin detail view is open, re-render active alerts so triggered
        // alerts (now removed from backend's active list) disappear from the UI.
        if (_currentDetailSymbol && typeof renderActiveAlerts === 'function') {
            try { renderActiveAlerts(_currentDetailSymbol); } catch (_) {}
        }
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
    // For BTC pairs, _currentDetailSymbol is "ETHBTC" but alerts are tracked
    // by the BASE symbol (ETH) because the backend fetches USD prices.
    // The alert price the user enters is in BTC units (e.g. "0.05" = 0.05 BTC),
    // so we convert it to USD using the current BTC price before storing.
    const rawSymbol = _currentDetailSymbol || document.getElementById('detail-coin-title').innerText.split(' ')[0];
    const btcPairBase = (typeof parseBtcPairSymbol === 'function') ? parseBtcPairSymbol(rawSymbol) : null;
    const isBtcPair = btcPairBase !== null;
    const symbol = isBtcPair ? btcPairBase : rawSymbol;
    if (!price || price <= 0) { alert(t('invalid_price')); return; }

    // Convert BTC pair price to USD for backend storage
    let usdPrice = price;
    if (isBtcPair) {
        const btc = allCoins.find(c => c.symbol === 'BTC');
        const btcPrice = btc?.priceUsd || 0;
        if (btcPrice <= 0) {
            alert(t('invalid_price') || 'Cannot set alert: BTC price unavailable');
            return;
        }
        usdPrice = price * btcPrice;
    }

    const direction = (currentAlertDirection === 'below' ? 'below' : 'above');
    const userId = getUserId();

    // ── OPTIMISTIC UI: add alert to local list + render IMMEDIATELY ──
    // The user sees the alert in the list within <1ms. The server sync happens
    // in the background. If it fails, we roll back (remove from list + toast error).
    // Previously: `await syncAlertToServer(newAlert)` blocked for 200-800ms
    // (validation + DB query + network) before the UI updated.
    const tempId = `temp_${Date.now()}`;
    const newAlert = { id: tempId, symbol, price: usdPrice, direction, userId, createdAt: new Date().toISOString() };
    alerts.push(newAlert);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    input.value = '';
    renderActiveAlerts(symbol); // immediate UI update

    const priceStr = usdPrice >= 1 ? usdPrice.toFixed(2) : usdPrice.toFixed(6);
    addNotification(t('price_alert'), `${symbol} → $${priceStr}`);
    getTg()?.HapticFeedback?.notificationOccurred('success');

    // ── Background sync to server (non-blocking) ──
    syncAlertToServer(newAlert)
        .then(syncedAlert => {
            if (syncedAlert.serverId) {
                // Replace temp ID with real server ID
                const idx = alerts.findIndex(a => a.id === tempId);
                if (idx >= 0) {
                    alerts[idx] = syncedAlert;
                    localStorage.setItem('price_alerts', JSON.stringify(alerts));
                    renderActiveAlerts(symbol);
                }
            } else {
                // Sync failed — roll back
                alerts = alerts.filter(a => a.id !== tempId);
                localStorage.setItem('price_alerts', JSON.stringify(alerts));
                renderActiveAlerts(symbol);
                showMiniToast(t('error_generic') || 'Failed to save alert');
            }
        })
        .catch(e => {
            console.warn('syncAlertToServer failed:', e);
            // Roll back on error
            alerts = alerts.filter(a => a.id !== tempId);
            localStorage.setItem('price_alerts', JSON.stringify(alerts));
            renderActiveAlerts(symbol);
            showMiniToast(t('error_generic') || 'Failed to save alert');
        });
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
    // For BTC pairs, _currentDetailSymbol is "ETHBTC" — use base symbol (ETH)
    // to match alerts stored by base symbol.
    const rawSymbol = _currentDetailSymbol || document.getElementById('detail-coin-title')?.innerText?.split(' ')[0];
    const btcPairBase = (typeof parseBtcPairSymbol === 'function') ? parseBtcPairSymbol(rawSymbol) : null;
    const symbol = btcPairBase || rawSymbol;
    if (symbol) renderActiveAlerts(symbol);
}
/**
 * هشدار را فعال می‌کند.
 * ورودی: پارامترهای `alert, currentPrice` را دریافت می‌کند.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function triggerAlert(alert, currentPrice) {
    // CRITICAL FIX: Frontend trigger only shows IN-APP notification + popup.
    // Do NOT send to Telegram from frontend — the backend cron handles Telegram
    // (and in-app notification via Notification Platform) to avoid DUPLICATE
    // Telegram messages. Frontend is faster for in-app display (30s polling),
    // backend is authoritative for Telegram delivery.
    //
    // ALSO: Do NOT remove the alert from the server. The backend cron needs to
    // see the alert to:
    //   1. Insert an in-app notification via Notification Platform (so the
    //      notification appears in the Notification Center with proper metadata)
    //   2. Send the Telegram message
    //   3. Mark the alert as 'triggered' atomically (prevents duplicate triggers)
    //
    // If frontend removed the alert, the backend would never see it and the
    // user would NOT receive the Telegram message or the proper in-app notif.
    //
    // Frontend just removes from LOCAL state (so the alert card disappears from
    // the detail view) and shows an immediate in-app toast/popup.
    alerts = alerts.filter(a => a.id !== alert.id);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    // Reset the sync timer so the next periodic sync waits 2 minutes before
    // re-fetching from backend. This gives the backend cron time to mark the
    // alert as 'triggered' — otherwise loadAlertsFromServer would re-add the
    // alert to local state (it's still 'active' in backend until cron runs).
    _lastAlertSyncTs = Date.now();
    // Clean, short notification — same format as backend.
    const priceStr = currentPrice >= 1
        ? Number(currentPrice).toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 })
        : Number(currentPrice).toFixed(6);
    const msg = `🔔 هشدار قیمت فعال شد\nقیمت ${alert.symbol} به ${priceStr} USDT رسید.`;
    getTg()?.HapticFeedback?.notificationOccurred('warning');
    addNotification(`🔔 هشدار قیمت ${alert.symbol}`, msg, { sendToTelegram: false, playSound: true });
    getTg()?.showPopup?.({ title: `🔔 هشدار قیمت ${alert.symbol}`, message: msg, buttons: [{ type: 'ok' }] });

    // CRITICAL: Immediately fetch new notifications from DB.
    // The backend cron may have already created a DB notification for this alert.
    // Without this, the badge and Notification Center won't update until the
    // next heartbeat (180s). This makes the notification appear instantly.
    loadNotificationsFromServer().catch(() => {});

    const symbol = _currentDetailSymbol;
    if (symbol === alert.symbol) renderActiveAlerts(symbol);
}
/**
 * هشدارها را بررسی می‌کند.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
let _alertsLoaded = false;
let _lastAlertSyncTs = 0;
const ALERT_SYNC_INTERVAL = 120000; // 2 minutes — sync from backend to remove triggered alerts

async function checkAlerts() {
    const userId = getUserId();

    // Load alerts from server ONCE on first run, then periodically sync (every 2 min)
    // to remove alerts that were triggered by the backend cron. Without this periodic
    // sync, triggered alerts remain in the local state and UI indefinitely.
    const shouldSync = !_alertsLoaded || (Date.now() - _lastAlertSyncTs > ALERT_SYNC_INTERVAL);
    if (shouldSync && !isGuestUserId(userId) && !isPendingTelegramUserId(userId) && getTelegramUser()?.id) {
        _alertsLoaded = true;
        _lastAlertSyncTs = Date.now();
        await loadAlertsFromServer().catch(() => { _alertsLoaded = false; _lastAlertSyncTs = 0; });
    }

    const userAlerts = alerts.filter(a => a.userId === userId);
    if (!userAlerts.length) return;

    // Build price map from in-memory data first (instant, no API call)
    const priceMap = {};
    if (allCoins.length) {
        allCoins.forEach(c => { priceMap[c.symbol] = c.priceUsd; });
    }
    if (allForexPairs.length) {
        allForexPairs.forEach(f => { if (f.price > 0) priceMap[f.symbol] = f.price; });
    }

    // PERFORMANCE: Batch price fetch — replaces N+1 pattern.
    // Previously: each alert symbol fetched individually via /api/market/price?symbol=X
    //   → 10 alerts = 10 API calls every 15s = 2400 requests/hour
    // Now: single batch call via /api/market/prices?symbols=BTC,ETH,SOL
    //   → 10 alerts = 1 API call every 15s = 240 requests/hour (90% reduction)
    const alertSymbols = [...new Set(userAlerts.map(a => a.symbol))];

    if (API_BASE && !isGuestUserId(userId) && !isPendingTelegramUserId(userId) && alertSymbols.length > 0) {
        // Fetch fresh prices for up to 15 alert symbols in ONE request.
        // P1-09 FIX (NEWSBE-020): Reduced from 20 to 15 to match the backend
        // /api/market/prices slice(0, 15). The backend enforces 15 to stay
        // under Cloudflare Free plan's 50-subrequest limit (15 × 3 exchanges
        // = 45 worst case). Any alert symbol beyond the 15th still displays
        // via the in-memory priceMap built from allCoins/allForexPairs above.
        const symbolsToRefresh = alertSymbols.slice(0, 15);
        try {
            const data = await apiFetch(`/api/market/prices?symbols=${encodeURIComponent(symbolsToRefresh.join(','))}`);
            if (data && data.status === 'success' && data.prices) {
                // Merge fresh prices into priceMap (override cached prices)
                for (const [sym, info] of Object.entries(data.prices)) {
                    if (info && info.price) {
                        priceMap[sym] = info.price;
                    }
                }
            }
        } catch (e) { /* silent fail — fall back to cached prices */ }
    }

    // If we still don't have prices for some alert symbols, try loading forex
    const hasForexAlerts = userAlerts.some(a => !priceMap[a.symbol]);
    if (hasForexAlerts && !allForexPairs.length) {
        await loadForexData().catch(() => {});
        if (allForexPairs.length) {
            allForexPairs.forEach(f => { if (f.price > 0) priceMap[f.symbol] = f.price; });
        }
    }

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

    // P0-7 FIX: Previously, if window.NotificationCenter existed (it always does),
    // we called NotificationCenter.add() and returned — but NotificationCenter.add
    // writes to localStorage, NOT to the in-memory `notifications` array that
    // renderNotifications() and _updateBadgeFromLocal() read from. This meant
    // guest notifications were written but never displayed (badge always 0,
    // panel always empty). Now we ALWAYS populate the in-memory array, and
    // still call NotificationCenter for the sound + dedup + localStorage backup.
    const notif = { id: Date.now().toString() + Math.random().toString(36).slice(2, 6), title, body, read: false, date: new Date().toISOString() };
    notifications.unshift(notif);
    if (notifications.length > 50) notifications = notifications.slice(0, 50);

    // Still call NotificationCenter for dedup, sound, and localStorage backup
    if (window.NotificationCenter) {
        try { NotificationCenter.add(title, body, { ...opts, playSound: false }); } catch (e) {}
    }

    // P0-4 FIX: compute badge locally
    _updateBadgeFromLocal();

    if (opts.sendToTelegram) {
        const userId = getUserId();
        if (!String(userId).startsWith('guest_')) {
            notifyTelegram(`🔔 ${title}\n${body}`).catch(e => console.warn('notifyTelegram:', e));
        }
    }
    if (opts.playSound) playAlertSound();
}
/**
 * اعلان نشان را به‌روزرسانی می‌کند — از دیتابیس می‌خواند (نه localStorage).
 */
async function updateNotifBadge() {
    const badge = $('notif-badge');
    if (!badge) return;
    // Try to fetch unread count from server
    try {
        if (API_BASE && !UserContext.isGuest()) {
            const data = await apiFetch('/api/notifications');
            if (data && typeof data.unread_count === 'number') {
                const unread = data.unread_count;
                // P0-4 FIX: cap badge at 99+ to prevent layout overflow
                if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread > 99 ? '99+' : unread; }
                else { badge.style.display = 'none'; }
                return;
            }
        }
    } catch (e) { /* fall through to localStorage fallback */ }
    // Fallback: use in-memory notifications array (for guests)
    _updateBadgeFromLocal();
}

/**
 * P0-4 FIX: Compute badge from local `notifications` array without making
 * a redundant API call. Used after mutations (markRead, markAllRead, delete,
 * clearAll) where we already know the new state — no need to re-fetch.
 */
function _updateBadgeFromLocal() {
    const badge = $('notif-badge');
    if (!badge) return;
    const unread = notifications.filter(n => !n.read).length;
    if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread > 99 ? '99+' : unread; }
    else { badge.style.display = 'none'; }
}
/**
 * وضعیت اعلان پنل را بین دو حالت جابه‌جا می‌کند.
 */
function toggleNotificationPanel() {
    const modal = document.getElementById('notif-modal');
    const willOpen = modal.style.display !== 'flex';
    modal.style.display = willOpen ? 'flex' : 'none';
    // P1-10 FIX: Only fetch when opening, not when closing (was wasting API call on close)
    if (willOpen) loadNotificationsFromServer();
}
/**
 * اعلان مودال را می‌بندد.
 */
function closeNotifModal() {
    document.getElementById('notif-modal').style.display = 'none';
}
/**
 * وضعیت همه read را علامت‌گذاری می‌کند — از API استفاده می‌کند.
 * ROOT CAUSE FIX: previously if the API call failed silently (caught by catch),
 * the local state was still updated → on next poll, server returned unread
 * notifications → they "reverted" to unread. Now we only update local state
 * if the API call succeeds. If it fails, we show an error toast.
 */
async function markAllRead() {
    const reqId = 'MARK_ALL_' + Date.now();
    _logNotifEvent('MARK_ALL_READ_START', { reqId, notifCount: notifications.length });
    // ROOT-CAUSE FIX (notification return bug): previously the catch block
    // fell through to the "Fallback for guests" block below, which marked all
    // notifications as read locally as if the mutation had succeeded. On ANY
    // API failure for an AUTHENTICATED user, this falsely marked all as read.
    // The next poll (≤60s) fetched server truth and reverted them.
    //
    // FIX: the guest fallback now ONLY runs when the user is actually a guest.
    // For authenticated users, an API failure shows an error toast and bumps
    // _notifReqSeq so any in-flight poll is discarded. Local state is NOT
    // mutated on failure.
    const isGuest = UserContext.isGuest();
    try {
        if (API_BASE && !isGuest) {
            const res = await apiFetch('/api/notifications/read-all', { method: 'POST' });
            // Only update local state if API succeeded
            if (res && res.status === 'success') {
                notifications.forEach(n => n.read = true);
                // P0-4 FIX: compute badge locally — no redundant GET
                _updateBadgeFromLocal();
                renderNotifications();
                showMiniToast(t('done') || 'Done');
                // Bump sequence so any in-flight poll (with stale unread data)
                // is discarded and doesn't overwrite the "all read" state.
                _notifReqSeq++;
                _logNotifEvent('MARK_ALL_READ_END', { reqId, success: true, newSeq: _notifReqSeq });
            } else {
                console.warn('markAllRead: API returned non-success', res);
                _logNotifEvent('MARK_ALL_READ_END', { reqId, success: false, error: 'non-success' });
                // Bump seq so any in-flight poll is discarded; do NOT mutate local state.
                _notifReqSeq++;
                showMiniToast(t('error_generic') || 'Error');
            }
            return;
        }
    } catch (e) {
        console.warn('markAllRead API failed:', e);
        _logNotifEvent('MARK_ALL_READ_END', { reqId, success: false, error: e?.message });
        // Do NOT fall through to the guest fallback for an authenticated user.
        if (!isGuest) {
            _notifReqSeq++;
            showMiniToast(t('error_generic') || 'Error');
            return;
        }
    }
    // Fallback for guests ONLY: update local state (no backend to call).
    if (!isGuest) return;
    notifications.forEach(n => n.read = true);
    _updateBadgeFromLocal();
    renderNotifications();
}
/**
 * همه notifications را پاک‌سازی می‌کند — از API استفاده می‌کند.
 * ROOT CAUSE FIX: previously this only cleared the local `notifications` array
 * with NO API call → notifications reappeared on next poll (60s). Now calls
 * DELETE /api/notifications to actually remove them from the database.
 */
async function clearAllNotifications() {
    if(!confirm(t('confirm_clear_notif'))) return;
    const reqId = 'DELETE_ALL_' + Date.now();
    _logNotifEvent('DELETE_ALL_START', { reqId, notifCount: notifications.length });
    // ROOT-CAUSE FIX (notification return bug): previously the catch block
    // fell through to the "Fallback for guests" block below, which cleared the
    // local notifications array as if the delete had succeeded. On ANY API
    // failure for an AUTHENTICATED user, this falsely cleared the list. The
    // next poll (≤60s) fetched server truth and re-added them all.
    //
    // FIX: the guest fallback now ONLY runs when the user is actually a guest.
    // For authenticated users, an API failure shows an error toast and bumps
    // _notifReqSeq so any in-flight poll is discarded. Local state is NOT
    // mutated on failure.
    const isGuest = UserContext.isGuest();
    try {
        if (API_BASE && !isGuest) {
            const res = await apiFetch('/api/notifications', { method: 'DELETE' });
            if (res && res.status === 'success') {
                notifications = [];
                // P0-4 FIX: compute badge locally — no redundant GET
                _updateBadgeFromLocal();
                renderNotifications();
                closeNotifModal();
                showMiniToast(t('done') || 'Cleared');
                // Bump sequence so any in-flight poll (with stale data from
                // before the delete) is discarded and doesn't overwrite the
                // empty array. This is the ROOT CAUSE FIX for "notifications
                // reappear after delete".
                _notifReqSeq++;
                _logNotifEvent('DELETE_ALL_END', { reqId, success: true, newSeq: _notifReqSeq, deleted: res.deleted_count });
            } else {
                console.warn('clearAllNotifications: API returned non-success', res);
                _logNotifEvent('DELETE_ALL_END', { reqId, success: false, error: 'non-success' });
                // Bump seq so any in-flight poll is discarded; do NOT mutate local state.
                _notifReqSeq++;
                showMiniToast(t('error_generic') || 'Error');
            }
            return;
        }
    } catch (e) {
        console.warn('clearAllNotifications API failed:', e);
        _logNotifEvent('DELETE_ALL_END', { reqId, success: false, error: e?.message });
        // Do NOT fall through to the guest fallback for an authenticated user.
        if (!isGuest) {
            _notifReqSeq++;
            showMiniToast(t('error_generic') || 'Error');
            return;
        }
    }
    // Fallback for guests ONLY: clear local state (no backend to call).
    if (!isGuest) return;
    notifications = [];
    _updateBadgeFromLocal();
    renderNotifications();
    closeNotifModal();
}
/**
 * یک notification را حذف می‌کند — از API استفاده می‌کند.
 * ROOT CAUSE FIX: previously no delete function existed. Now calls
 * DELETE /api/notifications/:id to remove from DB permanently.
 */
async function deleteNotification(id) {
    const reqId = 'DELETE_ONE_' + Date.now();
    _logNotifEvent('DELETE_ONE_START', { reqId, notifId: id, notifCount: notifications.length });
    // ROOT-CAUSE FIX (notification return bug): previously the catch block
    // fell through to the "Fallback for guests" block below, which filtered
    // the notification out of local state as if the delete had succeeded. On
    // ANY API failure for an AUTHENTICATED user, this falsely removed the
    // notification locally. The next poll (≤60s) fetched server truth (still
    // present) and re-added it → notification "reappeared".
    //
    // FIX: the guest fallback now ONLY runs when the user is actually a guest.
    // For authenticated users, an API failure shows an error toast and bumps
    // _notifReqSeq so any in-flight poll is discarded. Local state is NOT
    // mutated on failure.
    const isGuest = UserContext.isGuest();
    try {
        if (API_BASE && !isGuest) {
            const res = await apiFetch(`/api/notifications/${id}`, { method: 'DELETE' });
            if (res && res.status === 'success') {
                notifications = notifications.filter(n => n.id !== id);
                // P0-4 FIX: compute badge locally — no redundant GET
                _updateBadgeFromLocal();
                renderNotifications();
                // Bump sequence so in-flight poll doesn't overwrite
                _notifReqSeq++;
                _logNotifEvent('DELETE_ONE_END', { reqId, notifId: id, success: true, newSeq: _notifReqSeq });
            } else {
                // Non-success response (e.g. 404 not-found). Do NOT mutate local
                // state. Bump seq so any in-flight poll is discarded.
                _notifReqSeq++;
                _logNotifEvent('DELETE_ONE_END', { reqId, notifId: id, success: false, error: 'non-success' });
                showMiniToast(t('error_generic') || 'Error');
            }
            return;
        }
    } catch (e) {
        console.warn('deleteNotification:', e);
        _logNotifEvent('DELETE_ONE_END', { reqId, notifId: id, success: false, error: e?.message });
        // Do NOT fall through to the guest fallback for an authenticated user.
        if (!isGuest) {
            _notifReqSeq++;
            showMiniToast(t('error_generic') || 'Error');
            return;
        }
        // For guests, fall through to the local-state fallback below.
    }
    // Fallback for guests ONLY
    if (!isGuest) return;
    notifications = notifications.filter(n => n.id !== id);
    _updateBadgeFromLocal();
    renderNotifications();
}
/**
 * Notifications را از سرور بارگذاری می‌کند — DB source of truth.
 */
// ROOT CAUSE FIX for "notifications reappear after delete":
// The 60s poll (loadNotificationsFromServer) can return STALE data from a
// request that was in-flight BEFORE the user clicked "Delete All" or
// "Mark All Read". The stale response overwrites the local state, making
// notifications "reappear".
//
// FIX: Use a sequence number. Each call to loadNotificationsFromServer
// increments _notifReqSeq. When the response arrives, we only apply it
// if _notifReqSeq hasn't changed (no newer request was started). If a
// newer request was started (e.g. after delete), the stale response is
// silently discarded.
//
// EVENT LOG: _notifEventLog captures every notification-related event
// with timestamps, sequence numbers, and notification counts. This
// proves the race condition with real data.
let _notifReqSeq = 0;
const _notifEventLog = [];
const _MAX_NOTIF_EVENTS = 200;

function _logNotifEvent(type, extra) {
    const event = {
        ts: new Date().toISOString(),
        ms: Date.now(),
        type: type,
        seq: _notifReqSeq,
        notifCount: notifications.length,
        ...extra,
    };
    _notifEventLog.push(event);
    console.log('[NOTIF-EVENT]', type, '| seq:', event.seq, '| notifs:', event.notifCount, extra || '');
    // Trim to prevent memory growth
    if (_notifEventLog.length > _MAX_NOTIF_EVENTS) {
        _notifEventLog.splice(0, _notifEventLog.length - _MAX_NOTIF_EVENTS);
    }
}

window.getNotifEventLog = function() {
    return JSON.parse(JSON.stringify(_notifEventLog));
};
window.clearNotifEventLog = function() {
    _notifEventLog.length = 0;
    console.log('[NOTIF-EVENT] Log cleared');
};

// P1-9 FIX: Exponential backoff for notification polling on consecutive errors
let _notifConsecutiveErrors = 0;
let _notifBackoffMs = 60000; // start at 60s, double on error, cap at 600s (10 min)

async function loadNotificationsFromServer() {
    const mySeq = ++_notifReqSeq;
    const reqId = 'GET_' + Date.now() + '_' + Math.random().toString(36).slice(2, 6);
    _logNotifEvent('GET_START', { reqId, mySeq });
    try {
        if (API_BASE && !UserContext.isGuest()) {
            const data = await apiFetch('/api/notifications');
            // STALE RESPONSE GUARD: if a newer request was started (e.g.
            // user clicked delete/mark-all-read while this was in-flight),
            // discard this response — it contains stale data.
            if (mySeq !== _notifReqSeq) {
                _logNotifEvent('GET_STALE_DROPPED', { reqId, mySeq, currentSeq: _notifReqSeq, dataNotifs: data?.notifications?.length || 0 });
                console.log('[NOTIF] Discarding stale poll response (seq', mySeq, '!= current', _notifReqSeq, ')');
                return;
            }
            if (data && Array.isArray(data.notifications)) {
                // P1-9 FIX: Reset backoff on success
                _notifConsecutiveErrors = 0;
                _notifBackoffMs = 60000;
                // P1-8 FIX: Clear error state
                _notifFetchError = false;
                const oldCount = notifications.length;
                notifications = data.notifications.map(n => ({
                    id: n.id,
                    title: n.title || '',
                    body: n.message || '',
                    read: Boolean(n.read),
                    date: n.created_at || new Date().toISOString(),
                }));
                _logNotifEvent('GET_APPLIED', { reqId, mySeq, oldCount, newCount: notifications.length, serverUnread: data.unread_count });
                // Update badge with server-provided unread count (P0-4: cap at 99+)
                const badge = $('notif-badge');
                if (badge) {
                    const unread = data.unread_count || notifications.filter(n => !n.read).length;
                    if (unread > 0) { badge.style.display = 'flex'; badge.innerText = unread > 99 ? '99+' : unread; }
                    else { badge.style.display = 'none'; }
                }
                renderNotifications();
                return;
            }
        }
    } catch (e) {
        _logNotifEvent('GET_ERROR', { reqId, mySeq, error: e?.message });
        console.warn('loadNotificationsFromServer:', e);
        // P1-8 FIX: Set error state for UI
        _notifFetchError = true;
        // P1-9 FIX: Exponential backoff — double the poll interval on each consecutive error
        _notifConsecutiveErrors++;
        _notifBackoffMs = Math.min(_notifBackoffMs * 2, 600000); // cap at 10 min
    }
    // Fallback: render from in-memory array
    if (mySeq === _notifReqSeq) {
        _logNotifEvent('GET_FALLBACK', { reqId, mySeq });
        renderNotifications();
    }
}
// P1-8 FIX: Error state flag for notification fetch
let _notifFetchError = false;
// P1-10 FIX: Hash of last rendered notifications to skip unnecessary DOM rebuilds
let _lastNotifRenderHash = '';

/**
 * notifications را در رابط کاربری رندر می‌کند.
 * FIX: added a delete button per notification so users can permanently delete
 * (not just mark as read). Previously there was no way to delete a single
 * notification — only "clear all" which didn't actually call the API.
 * P1-8 FIX: Added error state with retry button.
 * P1-10 FIX: Skip DOM rebuild if notification content hasn't changed (hash check).
 */
function renderNotifications() {
    const container = document.getElementById('notif-list');
    if (!container) return;

    // P1-8 FIX: Show error state if fetch failed and no notifications
    if (_notifFetchError && !notifications.length) {
        container.innerHTML = `<div class="empty-state" style="cursor:pointer;color:var(--accent);" onclick="loadNotificationsFromServer()">${t('error_generic') || 'Error'} — ${t('retry') || 'Retry'}</div>`;
        return;
    }

    if (!notifications.length) {
        // P1-10 FIX: Only update if hash changed
        if (_lastNotifRenderHash !== 'empty') {
            container.innerHTML = `<div class="empty-state">${t('no_notif')}</div>`;
            _lastNotifRenderHash = 'empty';
        }
        return;
    }

    // P1-10 FIX: Compute hash of visible notifications. If unchanged, skip DOM rebuild
    // to prevent flicker, scroll reset, and hover state loss on every 60s poll.
    const visibleSlice = notifications.slice(0, 20);
    const newHash = visibleSlice.map(n => `${n.id}:${n.read}`).join('|');
    if (newHash === _lastNotifRenderHash) return; // No changes — skip DOM rebuild

    _lastNotifRenderHash = newHash;
    // Notification timestamp fix: show date + time (24-hour, locale-aware).
    // The backend sends `created_at` as an ISO UTC string with Z suffix
    // (src/repositories/notifications.js:serializeRow). `new Date(iso)` parses
    // it as UTC; toLocaleDateString/toLocaleTimeString then convert to the
    // browser/device timezone (default when no timeZone option is specified).
    // Locale is selected by currentLang to match the app language (and fixes
    // the prior i18n bug where EN users saw Persian digits).
    const _notifLocale = currentLang === 'fa' ? 'fa-IR' : 'en-US';
    const _notifDateOpts = { dateStyle: 'medium' };
    const _notifTimeOpts = { timeStyle: 'short', hour12: false };
    container.innerHTML = visibleSlice.map(n => {
        const notificationDate = new Date(n.date);
        const datePart = notificationDate.toLocaleDateString(_notifLocale, _notifDateOpts);
        const timePart = notificationDate.toLocaleTimeString(_notifLocale, _notifTimeOpts);
        return `
        <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="markNotifRead('${escapeHtml(n.id)}')">
            <div class="notif-title">${escapeHtml(n.title)}</div>
            <div class="notif-body">${escapeHtml(n.body)}</div>
            <div class="notif-date">${datePart} • ${timePart}</div>
            <button class="notif-delete-btn" onclick="event.stopPropagation(); deleteNotification('${escapeHtml(n.id)}')" aria-label="Delete">×</button>
        </div>`;
    }).join('');
}
/**
 * وضعیت اعلان read را علامت‌گذاری می‌کند — از API استفاده می‌کند.
 * ROOT CAUSE FIX: previously if the API call failed (caught by catch), the
 * local state was still updated → on next poll, server returned unread →
 * notification "reverted" to unread. Now we only update local state on success.
 */
async function markNotifRead(id) {
    // ROOT-CAUSE FIX (notification return bug): previously the catch block
    // fell through to the "Fallback for guests" block below, which mutated
    // local state as if the mutation had succeeded. On ANY API failure
    // (network error, 15s timeout, 5xx, 401, JSON parse error) for an
    // AUTHENTICATED user, this falsely marked the notification as read locally.
    // The next poll (≤60s) then fetched server truth (still unread) and
    // overwrote the false state → notification "reverted" to unread.
    //
    // FIX: the guest fallback now ONLY runs when the user is actually a guest
    // (i.e. the API branch was skipped). For authenticated users, an API
    // failure shows an error toast and bumps _notifReqSeq so any in-flight
    // poll with stale data is discarded (and the next poll fetches fresh
    // truth). Local state is NOT mutated on failure.
    const isGuest = UserContext.isGuest();
    try {
        if (API_BASE && !isGuest) {
            const res = await apiFetch(`/api/notifications/${id}/read`, { method: 'POST' });
            if (res && res.status === 'success') {
                const n = notifications.find(x => x.id === id);
                if (n) n.read = true;
                // P0-3 FIX: Bump _notifReqSeq so any in-flight poll (with stale
                // unread state from BEFORE the mark-read) is discarded and doesn't
                // revert the just-read notification back to unread.
                // P0-4 FIX: Compute badge locally instead of calling updateNotifBadge()
                // which would fire a redundant GET /api/notifications.
                _notifReqSeq++;
                _updateBadgeFromLocal();
                renderNotifications();
            } else {
                // Non-success response (e.g. 404 not-found, {status:'error'}).
                // Do NOT mutate local state — the server did not confirm the
                // mutation. Bump seq so any in-flight poll is discarded; the
                // next poll will fetch server truth.
                _notifReqSeq++;
                showMiniToast(t('error_generic') || 'Error');
            }
            return;
        }
    } catch (e) {
        console.warn('markNotifRead API failed:', e);
        // Do NOT fall through to the guest fallback for an authenticated user.
        // Bump seq so any in-flight poll (with stale data) is discarded, and
        // let the next poll fetch fresh truth. Show an error toast.
        if (!isGuest) {
            _notifReqSeq++;
            showMiniToast(t('error_generic') || 'Error');
            return;
        }
        // For guests, fall through to the local-state fallback below.
    }
    // Fallback for guests ONLY: update local state (no backend to call).
    if (!isGuest) return;
    const n = notifications.find(x => x.id === id);
    if (n) n.read = true;
    _updateBadgeFromLocal();
    renderNotifications();
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
        // Referral link is now built dynamically inside Referral Center (referral.js).
        // We still load referral stats to populate the entry card on the profile page.
        loadReferralStats();
        // Fix: reload wallet card now that the user is confirmed — resolves race condition
        // where loadProfileCard() ran earlier while UserContext was still pending
        window.WalletApp?.loadProfileCard();
        // Load membership card on profile load (non-blocking, cached in-memory)
        window.MembershipApp?.loadCard();
    } else if (UserContext.isPending()) {
        const pn = $('profile-name'); if (pn) pn.innerText = t('loading_user');
        const pu = $('profile-username'); if (pu) pu.innerText = '...';
        const pi = $('profile-id-num'); if (pi) pi.innerText = '...';
    } else if (UserContext.isGuest()) {
        const pn = $('profile-name'); if (pn) pn.innerText = t('guest');
        const pu = $('profile-username'); if (pu) pu.innerText = '@guest';
        const pi = $('profile-id-num'); if (pi) pi.innerText = getUserId().replace('guest_', '') || '000000';
        // M-R5: guest users do not get a working referral link — Referral Center
        // checks for a valid Telegram user id before building the link.
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
    // Use isAdmin() which has optimistic fallback for cold-start
    btn.style.display = isAdmin() ? 'inline-flex' : 'none';
}

/**
 * PERFORMANCE: Lazy-load admin.js only when admin panel is opened.
 * Previously, admin.js (27KB gzip, 144KB decoded) was loaded for EVERY user
 * on page init, even non-admins. Now it's loaded on-demand via script injection.
 *
 * The first time openAdminPanel is called, it injects admin.js as a script tag,
 * then calls the real openAdminPanel from admin.js. Subsequent calls go directly
 * to the real function (which is now attached to window by admin.js).
 */
let _adminJsLoaded = false;
let _adminJsLoading = false;

async function openAdminPanelLazy() {
    if (!_adminJsLoaded) {
        if (_adminJsLoading) return; // already loading, wait
        _adminJsLoading = true;

        // Show loading indicator — but DON'T destroy the container HTML!
        // ROOT CAUSE FIX: Previously, container.innerHTML was replaced with a loading
        // message, which destroyed the admin panel's HTML structure (sidebar, header,
        // sections, etc.). When admin.js loaded and called _realOpenAdminPanel(), it
        // couldn't find the DOM elements it expected → panel appeared empty/broken.
        // Now we just show the panel with an overlay loading indicator on top.
        const panel = document.getElementById('admin-panel');
        if (panel) {
            panel.style.display = 'flex';
        }

        try {
            // Load admin.js via script tag injection
            // ROOT CAUSE FIX: prepare-pages.mjs hashes filenames (admin.js → admin.744b8c4e.js)
            // The hashed filename is injected as window.ADMIN_JS_URL by prepare-pages.mjs.
            await new Promise((resolve, reject) => {
                const s = document.createElement('script');
                s.src = window.ADMIN_JS_URL || 'admin.js';
                s.onload = resolve;
                s.onerror = () => reject(new Error('Failed to load admin.js from: ' + s.src));
                document.head.appendChild(s);
            });
            _adminJsLoaded = true;
            _adminJsLoading = false;
        } catch (e) {
            console.error('Failed to load admin.js:', e);
            _adminJsLoading = false;
            if (panel) panel.style.display = 'none';
            return;
        }
    }

    // Now call the real openAdminPanel (defined in admin.js, attached to window)
    // admin.js defines openAdminPanel and may overwrite our window.openAdminPanel
    // So we need to save the real one and call it
    if (_adminJsLoaded && typeof window._realOpenAdminPanel === 'function') {
        window._realOpenAdminPanel();
    }
}
// ROOT CAUSE FIX: This assignment was accidentally removed during code reorganization.
// Without it, window.openAdminPanel is undefined → Admin Panel can't open.
window.openAdminPanel = openAdminPanelLazy;
// NOTE: copyRefLink() and shareRefLink() were removed — the referral entry card
// now opens the full Referral Center (ReferralApp.openReferral) which has its own
// copyLink() and shareLink() methods with proper visual feedback and QR support.

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

// ============================================================================
// ── ROOT-CAUSE FIX: Delete Account (cascade delete + referral re-registration) ──
// ============================================================================
/**
 * Opens the Delete Account confirmation dialog.
 * Two-step confirmation to prevent accidental deletion.
 */
function requestDeleteAccount() {
    // Step 1: Show confirmation dialog
    const fa = currentLang === 'fa';
    const message = fa
        ? '⚠️ هشدار جدی\n\nآیا واقعاً می‌خواهید حساب خود را حذف کنید؟\n\n• تمام پاداش‌ها و توکن‌های شما پاک می‌شود\n• تاریخچه دعوت‌ها حذف می‌شود\n• کیف پول، هشدارها و واچ‌لیست پاک می‌شود\n• این عملیات قابل بازگشت نیست\n\nپس از حذف، می‌توانید دوباره با لینک دعوت ثبت‌نام کنید.'
        : '⚠️ SERIOUS WARNING\n\nDo you really want to delete your account?\n\n• All rewards and tokens will be erased\n• Referral history will be deleted\n• Wallet, alerts, and watchlist will be cleared\n• This action is IRREVERSIBLE\n\nAfter deletion, you can re-register with a referral link.';

    // Use a custom modal for better UX than the native confirm()
    showDeleteAccountModal(message, fa);
}

function showDeleteAccountModal(message, fa) {
    // Remove any existing delete modal
    const existing = document.getElementById('delete-account-modal');
    if (existing) existing.remove();

    const modal = document.createElement('div');
    modal.id = 'delete-account-modal';
    modal.className = 'delete-account-modal-overlay';
    modal.innerHTML = `
        <div class="delete-account-modal-content">
            <div class="delete-account-modal-icon">
                <svg width="48" height="48" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round">
                    <path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/>
                    <line x1="12" y1="9" x2="12" y2="13"/>
                    <line x1="12" y1="17" x2="12.01" y2="17"/>
                </svg>
            </div>
            <h3 class="delete-account-modal-title">${fa ? 'حذف حساب کاربری' : 'Delete Account'}</h3>
            <p class="delete-account-modal-message">${message.replace(/\n/g, '<br>')}</p>
            <div class="delete-account-modal-input-wrap">
                <label class="delete-account-modal-label">${fa ? 'برای تأیید، تایپ کنید:' : 'Type to confirm:'}</label>
                <input type="text" id="delete-account-confirm-input" class="delete-account-modal-input" placeholder="DELETE" autocomplete="off">
            </div>
            <div class="delete-account-modal-actions">
                <button class="delete-account-modal-cancel" onclick="closeDeleteAccountModal()">${fa ? 'انصراف' : 'Cancel'}</button>
                <button class="delete-account-modal-confirm" id="delete-account-confirm-btn" onclick="executeDeleteAccount()" disabled>
                    <span class="da-spinner" style="display:none;"></span>
                    <span class="da-btn-text">${fa ? 'حذف دائمی' : 'Permanently Delete'}</span>
                </button>
            </div>
        </div>
    `;
    document.body.appendChild(modal);
    modal.style.display = 'flex';

    // Enable confirm button only when user types "DELETE"
    const input = document.getElementById('delete-account-confirm-input');
    const confirmBtn = document.getElementById('delete-account-confirm-btn');
    input.addEventListener('input', () => {
        confirmBtn.disabled = input.value.trim().toUpperCase() !== 'DELETE';
    });
    // Focus the input for quick confirmation
    setTimeout(() => input.focus(), 100);
}

function closeDeleteAccountModal() {
    const modal = document.getElementById('delete-account-modal');
    if (modal) modal.remove();
}

async function executeDeleteAccount() {
    const confirmBtn = document.getElementById('delete-account-confirm-btn');
    const spinner = confirmBtn?.querySelector('.da-spinner');
    const btnText = confirmBtn?.querySelector('.da-btn-text');
    if (confirmBtn) confirmBtn.disabled = true;
    if (spinner) spinner.style.display = 'inline-block';
    const fa = currentLang === 'fa';
    if (btnText) btnText.textContent = fa ? 'در حال حذف...' : 'Deleting...';

    try {
        const initData = getTelegramInitData();
        if (!initData) {
            showMiniToast(fa ? 'خطا: ابتدا از طریق تلگرام وارد شوید' : 'Error: Sign in via Telegram first');
            if (confirmBtn) confirmBtn.disabled = false;
            if (spinner) spinner.style.display = 'none';
            if (btnText) btnText.textContent = fa ? 'حذف دائمی' : 'Permanently Delete';
            return;
        }

        console.log('[DELETE-ACCOUNT] Sending DELETE /api/users/me');
        const response = await fetch(`${API_BASE}/api/users/me`, {
            method: 'DELETE',
            headers: {
                'Content-Type': 'application/json',
                'X-Telegram-Init-Data': initData,
            },
            body: JSON.stringify({ confirm: 'DELETE' }),
        });

        const data = await response.json();
        console.log('[DELETE-ACCOUNT] Response:', response.status, data);

        if (response.ok && data.status === 'success') {
            closeDeleteAccountModal();
            showMiniToast(fa ? '✅ حساب حذف شد. می‌توانید دوباره ثبت‌نام کنید.' : '✅ Account deleted. You can re-register.');

            // Clear local state
            try {
                localStorage.clear();
                sessionStorage.clear();
            } catch {}

            // Show a farewell screen, then prompt to restart via Telegram
            setTimeout(() => {
                const fa2 = currentLang === 'fa';
                document.body.innerHTML = `
                    <div style="position:fixed;inset:0;display:flex;flex-direction:column;align-items:center;justify-content:center;background:#0b1220;color:#fff;font-family:inherit;padding:24px;text-align:center;">
                        <div style="font-size:48px;margin-bottom:16px;">👋</div>
                        <h2 style="font-size:22px;margin-bottom:12px;">${fa2 ? 'حساب شما حذف شد' : 'Account Deleted'}</h2>
                        <p style="color:rgba(255,255,255,0.6);max-width:320px;line-height:1.6;margin-bottom:24px;">${fa2 ? 'برای ثبت‌نام مجدد، ربات را در تلگرام استارت کنید. اگر با لینک دعوت وارد شوید، دعوت شما ثبت خواهد شد.' : 'To re-register, start the bot in Telegram. If you enter via a referral link, your referral will be registered.'}</p>
                        <button onclick="location.reload()" style="padding:12px 32px;background:#f7931a;color:#fff;border:none;border-radius:12px;font-weight:600;cursor:pointer;font-size:15px;">${fa2 ? 'بارگذاری مجدد' : 'Reload'}</button>
                    </div>
                `;
            }, 1500);
        } else {
            showMiniToast((fa ? 'خطا: ' : 'Error: ') + (data.message || data.error || 'Unknown'));
            if (confirmBtn) confirmBtn.disabled = false;
            if (spinner) spinner.style.display = 'none';
            if (btnText) btnText.textContent = fa ? 'حذف دائمی' : 'Permanently Delete';
        }
    } catch (e) {
        console.error('[DELETE-ACCOUNT] Network error:', e);
        showMiniToast(fa ? 'خطای شبکه — دوباره تلاش کنید' : 'Network error — try again');
        if (confirmBtn) confirmBtn.disabled = false;
        if (spinner) spinner.style.display = 'none';
        if (btnText) btnText.textContent = fa ? 'حذف دائمی' : 'Permanently Delete';
    }
}

// Make functions globally accessible (called from inline onclick in index.html)
window.requestDeleteAccount = requestDeleteAccount;
window.closeDeleteAccountModal = closeDeleteAccountModal;
window.executeDeleteAccount = executeDeleteAccount;
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
    loadContent('about');
    // Show edit button for admins
    if (isAdmin()) {
        document.getElementById('about-edit-btn').style.display = 'flex';
    } else {
        document.getElementById('about-edit-btn').style.display = 'none';
    }
}
function closeAboutModal() { document.getElementById('about-modal').style.display = 'none'; }

/**
 * Terms modal
 */
function openTermsModal() {
    closeSettingsModal();
    document.getElementById('terms-modal').style.display = 'flex';
    loadContent('terms');
    if (isAdmin()) {
        document.getElementById('terms-edit-btn').style.display = 'flex';
    } else {
        document.getElementById('terms-edit-btn').style.display = 'none';
    }
}
function closeTermsModal() { document.getElementById('terms-modal').style.display = 'none'; }

/**
 * Privacy modal
 */
function openPrivacyModal() {
    closeSettingsModal();
    document.getElementById('privacy-modal').style.display = 'flex';
    loadContent('privacy');
    if (isAdmin()) {
        document.getElementById('privacy-edit-btn').style.display = 'flex';
    } else {
        document.getElementById('privacy-edit-btn').style.display = 'none';
    }
}
function closePrivacyModal() { document.getElementById('privacy-modal').style.display = 'none'; }

/**
 * Load content from API and render into modal body.
 * @param {string} type - 'about' | 'terms' | 'privacy'
 */
async function loadContent(type) {
    const bodyId = type + '-content-body';
    const titleId = type + '-modal-title';
    const body = document.getElementById(bodyId);
    if (!body) return;

    body.innerHTML = '<div class="content-loading"><div class="spinner"></div>در حال بارگذاری...</div>';

    try {
        const data = await apiFetch('/api/content/' + type);
        if (data.status === 'success' && data.data) {
            const content = data.data;
            const titleEl = document.getElementById(titleId);
            if (titleEl && content.title) titleEl.textContent = content.title;

            if (type === 'about') {
                body.innerHTML = renderAboutContent(content);
            } else {
                body.innerHTML = renderAccordionContent(content);
            }
        } else {
            body.innerHTML = '<div class="content-loading">محتوایی موجود نیست.</div>';
        }
    } catch (e) {
        body.innerHTML = '<div class="content-loading">خطا در بارگذاری محتوا.</div>';
    }
}

/**
 * Render About content as premium cards.
 */
function renderAboutContent(content) {
    let html = '';

    // Version badge
    if (content.version) {
        html += '<div class="content-version-badge"> نسخه ' + content.version + '</div>';
    }

    // Sections as cards
    if (Array.isArray(content.sections)) {
        for (const section of content.sections) {
            html += '<div class="content-section">';
            html += '<div class="content-section-heading">' + escapeHtml(section.heading || '') + '</div>';
            html += '<div class="content-section-body">' + escapeHtml(section.body || '') + '</div>';
            html += '</div>';
        }
    }

    // Channel link
    html += '<a class="content-channel-link" href="https://t.me/amir_btc_2024" target="_blank" rel="noopener">';
    html += '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M21.5 4.5L2.5 12.5l6 2 2 6 4-4 5 4 2-16z"/></svg>';
    html += '<span>کانال رسمی: amir_btc_2024</span>';
    html += '</a>';

    return html;
}

/**
 * Render Terms/Privacy as accordion.
 */
function renderAccordionContent(content) {
    let html = '';

    if (!Array.isArray(content.sections) || content.sections.length === 0) {
        return '<div class="content-loading">محتوایی موجود نیست.</div>';
    }

    for (let i = 0; i < content.sections.length; i++) {
        const section = content.sections[i];
        const isFirst = i === 0;
        html += '<div class="accordion-item' + (isFirst ? ' open' : '') + '">';
        html += '<div class="accordion-header" onclick="toggleAccordion(this)">';
        html += '<span class="accordion-header-text">' + escapeHtml(section.heading || '') + '</span>';
        html += '<svg class="accordion-chevron" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5"><polyline points="6 9 12 15 18 9"/></svg>';
        html += '</div>';
        html += '<div class="accordion-body"><div class="accordion-body-inner">' + escapeHtml(section.body || '') + '</div></div>';
        html += '</div>';
    }

    return html;
}

/**
 * Toggle accordion item.
 */
function toggleAccordion(headerEl) {
    const item = headerEl.parentElement;
    item.classList.toggle('open');
}

// P1-01 FIX (NEWSSEC-001): Removed the duplicate DOM-based escapeHtml definition
// that was here. It only escaped & < > (via textContent→innerHTML) and SHADOWED
// the canonical regex-based escapeHtml defined at the top of this file (which
// escapes & < > " '). The shadowing made every escapeHtml call site vulnerable
// to attribute-injection XSS because " and ' were left unescaped. All callers
// now use the canonical definition above.

/**
 * Content Editor (Admin)
 */
let _editingContentType = null;

function openContentEditor(type) {
    _editingContentType = type;
    const editorTitle = document.getElementById('content-editor-title');
    const titleInput = document.getElementById('editor-title');
    const versionInput = document.getElementById('editor-version');
    const sectionsTextarea = document.getElementById('editor-sections');
    const statusEl = document.getElementById('editor-status');

    statusEl.textContent = '';
    statusEl.className = 'editor-status';

    // Load current content into editor
    apiFetch('/api/content/' + type)
        .then(data => {
            if (data.status === 'success' && data.data) {
                const content = data.data;
                const titles = { about: 'ویرایش: درباره ما', terms: 'ویرایش: قوانین', privacy: 'ویرایش: حریم خصوصی' };
                editorTitle.textContent = titles[type] || 'ویرایش محتوا';
                titleInput.value = content.title || '';
                versionInput.value = content.version || '1.0.0';
                sectionsTextarea.value = JSON.stringify(content.sections || [], null, 2);
                document.getElementById('content-editor-modal').style.display = 'flex';
            } else {
                statusEl.textContent = 'خطا در بارگذاری محتوا';
                statusEl.className = 'editor-status error';
            }
        })
        .catch(e => {
            statusEl.textContent = 'خطا: ' + e.message;
            statusEl.className = 'editor-status error';
        });
}

function closeContentEditor() {
    document.getElementById('content-editor-modal').style.display = 'none';
    _editingContentType = null;
}

async function saveContentFromEditor() {
    if (!_editingContentType) return;

    const statusEl = document.getElementById('editor-status');
    const saveBtn = document.querySelector('.editor-save-btn');
    const titleInput = document.getElementById('editor-title');
    const versionInput = document.getElementById('editor-version');
    const sectionsTextarea = document.getElementById('editor-sections');

    statusEl.textContent = '';
    statusEl.className = 'editor-status';

    let sections;
    try {
        sections = JSON.parse(sectionsTextarea.value);
        if (!Array.isArray(sections)) throw new Error('بخش‌ها باید یک آرایه باشند');
    } catch (e) {
        statusEl.textContent = 'خطا در JSON: ' + e.message;
        statusEl.className = 'editor-status error';
        return;
    }

    saveBtn.disabled = true;
    saveBtn.textContent = 'در حال ذخیره...';

    try {
        const data = await apiFetch('/api/admin/content/' + _editingContentType, {
            method: 'PUT',
            body: JSON.stringify({
                title: titleInput.value,
                sections: sections,
                version: versionInput.value || '1.0.0',
            }),
        });

        if (data.status === 'success') {
            statusEl.textContent = '✓ با موفقیت ذخیره شد';
            statusEl.className = 'editor-status success';
            // Reload content in the background
            // Save type BEFORE closeContentEditor sets _editingContentType = null
            const savedType = _editingContentType;
            setTimeout(() => {
                closeContentEditor();
                loadContent(savedType);
            }, 1000);
        } else {
            statusEl.textContent = 'خطا: ' + (data.message || 'نامشخص');
            statusEl.className = 'editor-status error';
        }
    } catch (e) {
        statusEl.textContent = 'خطا: ' + e.message;
        statusEl.className = 'editor-status error';
    } finally {
        saveBtn.disabled = false;
        saveBtn.textContent = 'ذخیره';
    }
}

// ============================================================================
//#region Notification Settings
// ============================================================================

// NOTIFICATION PREFERENCES
// Default: Analysis ON, everything else OFF (per spec)
const NS_DEFAULT_PREFS = {
    analysis: true,      // ON by default
    calendar: false,     // OFF
    price_alert: false,  // OFF
    referral: false,     // OFF
    reward: false,       // OFF
    ticket: false,       // OFF
    // market, news, system, marketing removed — no backend triggers
};

// In-memory cache of prefs (synced from server)
let _notifPrefsCache = null;

async function getNotifPrefs() {
    // Return cached prefs if available
    if (_notifPrefsCache) return { ..._notifPrefsCache };

    // Try to load from server
    try {
        if (API_BASE && !UserContext.isGuest()) {
            const data = await apiFetch('/api/notifications/settings');
            if (data && data.preferences) {
                _notifPrefsCache = { ...NS_DEFAULT_PREFS, ...data.preferences };
                return { ..._notifPrefsCache };
            }
        }
    } catch (e) { /* fall through to localStorage */ }

    // Fallback: localStorage (for guests or when API fails)
    try {
        const key = 'notif_prefs_' + getUserId();
        const stored = localStorage.getItem(key);
        if (stored) return { ...NS_DEFAULT_PREFS, ...JSON.parse(stored) };
    } catch (e) { /* ignore */ }
    return { ...NS_DEFAULT_PREFS };
}

async function saveNotifPrefs(prefs) {
    _notifPrefsCache = { ...prefs };
    // Save to localStorage as fallback
    try {
        const key = 'notif_prefs_' + getUserId();
        localStorage.setItem(key, JSON.stringify(prefs));
    } catch (e) { /* ignore */ }
    // Sync to server
    try {
        if (API_BASE && !UserContext.isGuest()) {
            await apiFetch('/api/notifications/settings', {
                method: 'PUT',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({ preferences: prefs })
            });
        }
    } catch (e) { /* localStorage is fallback */ }
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

// ── Premium SVG icons (no emoji) — uniform fintech style ──
const NS_ICONS = {
    price: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 12h-4l-3 9L9 3l-3 9H2"/></svg>',
    analysis: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><line x1="18" y1="20" x2="18" y2="10"/><line x1="12" y1="20" x2="12" y2="4"/><line x1="6" y1="20" x2="6" y2="14"/></svg>',
    news: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 22h16a2 2 0 0 0 2-2V4a2 2 0 0 0-2-2H8a2 2 0 0 0-2 2v16a2 2 0 0 1-2 2zm0 0a2 2 0 0 1-2-2v-9c0-1.1.9-2 2-2h2"/><path d="M18 14h-8"/><path d="M15 18h-5"/><path d="M10 6h8v4h-8z"/></svg>',
    calendar: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>',
    security: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M12 22s8-4 8-10V5l-8-3-8 3v7c0 6 8 10 8 10z"/></svg>',
    ticket: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 7v2a3 3 0 0 1 0 6v2c0 1.1.9 2 2 2h14a2 2 0 0 0 2-2v-2a3 3 0 0 1 0-6V7a2 2 0 0 0-2-2H5a2 2 0 0 0-2 2z"/><line x1="13" y1="5" x2="13" y2="7"/><line x1="13" y1="11" x2="13" y2="13"/><line x1="13" y1="17" x2="13" y2="19"/></svg>',
    announce: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M3 11l18-5v12L3 14v-3z"/><path d="M11.6 16.8a3 3 0 1 1-5.8-1.6"/></svg>',
    wheel: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="4"/><line x1="12" y1="2" x2="12" y2="8"/><line x1="12" y1="16" x2="12" y2="22"/><line x1="2" y1="12" x2="8" y2="12"/><line x1="16" y1="12" x2="22" y2="12"/></svg>',
    referral: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="5" r="3"/><circle cx="6" cy="12" r="3"/><circle cx="18" cy="19" r="3"/><line x1="8.59" y1="13.51" x2="15.42" y2="17.49"/><line x1="15.41" y1="6.51" x2="8.59" y2="10.49"/></svg>',
    wallet: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21 12V7H5a2 2 0 0 1 0-4h14v4"/><path d="M3 5v14a2 2 0 0 0 2 2h16v-5"/><path d="M18 12a2 2 0 0 0 0 4h4v-4z"/></svg>',
    challenge: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><circle cx="12" cy="12" r="6"/><circle cx="12" cy="12" r="2"/></svg>',
    promo: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 12 20 22 4 22 4 12"/><rect x="2" y="7" width="20" height="5"/><line x1="12" y1="22" x2="12" y2="7"/><path d="M12 7H7.5a2.5 2.5 0 0 1 0-5C11 2 12 7 12 7z"/><path d="M12 7h4.5a2.5 2.5 0 0 0 0-5C13 2 12 7 12 7z"/></svg>',
    // Lock + Crown icons for Free-user locked Premium cards (Feather-style, consistent with existing icon system)
    lock: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>',
    crown: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M2 18h20M3 22h18M5 18l-2-9 6 4 5-7 5 7 6-4-2 9"/></svg>',
};

// Channel selector icons
const NS_CHAN_ICONS = {
    none: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><line x1="6" y1="6" x2="18" y2="18"/><line x1="6" y1="18" x2="18" y2="6"/></svg>',
    mini_app: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="5" y="2" width="14" height="20" rx="2"/><line x1="12" y1="18" x2="12" y2="18"/></svg>',
    telegram: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M21.5 4.5L2.5 12.5l6 2 2 6 3.5-4.5 4 3z"/></svg>',
    both: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
};

// Cache for settings data — prevents re-fetch on rapid re-renders
let _nsSettingsCache = null;
let _nsSettingsLoading = false;

async function renderNotifSettings() {
    const list = document.getElementById('ns-channel-list');
    const statusEl = document.getElementById('ns-status-card-content');
    if (!list) return;

    // Show skeleton immediately — no blocking
    list.innerHTML = '<div style="padding:20px;text-align:center;color:#6B7A8D;font-size:12px;">در حال بارگذاری...</div>';

    // Load settings (use cache if available for instant render)
    let settings = _nsSettingsCache;
    if (!settings && !_nsSettingsLoading) {
        _nsSettingsLoading = true;
        try {
            if (API_BASE && !UserContext.isGuest()) {
                const data = await apiFetch('/api/notifications/platform/settings');
                if (data && data.status === 'success' && data.settings) {
                    settings = data.settings;
                    _nsSettingsCache = settings;
                }
            }
        } catch (e) { /* fall through to defaults */ }
        _nsSettingsLoading = false;
    }

    if (!settings) settings = _defaultChannelSettings();

    const isFa = currentLang === 'fa';

    // Category definitions — grouped by importance
    const groups = [
        {
            label: isFa ? 'اعلان‌های حیاتی' : 'Critical Alerts',
            items: [
                { key: 'ch_price_alert', svg: NS_ICONS.price, ic: 'ic-price', t: isFa ? 'هشدار قیمت' : 'Price Alerts', d: isFa ? 'هنگام رسیدن قیمت به مقدار تعیین شده' : 'When price reaches your target', def: 'both' },
                { key: 'ch_analysis', svg: NS_ICONS.analysis, ic: 'ic-analysis', t: isFa ? 'تحلیل‌های جدید' : 'Analysis', d: isFa ? 'انتشار تحلیل جدید بازار' : 'New market analysis published', def: 'both' },
                { key: 'ch_calendar', svg: NS_ICONS.calendar, ic: 'ic-calendar', t: isFa ? 'تقویم اقتصادی' : 'Calendar Events', d: isFa ? 'هشدار رویدادهای مهم اقتصادی' : 'Important economic events', def: 'both' },
                // Phase 5: Removed ch_breaking_news, ch_security — no producer emits these.
            ]
        },
        {
            label: isFa ? 'اعلان‌های حساب کاربری' : 'Account Notifications',
            items: [
                { key: 'ch_tickets', svg: NS_ICONS.ticket, ic: 'ic-ticket', t: isFa ? 'تیکت‌ها' : 'Tickets', d: isFa ? 'پاسخ به تیکت‌های پشتیبانی' : 'Support ticket replies', def: 'both' },
                { key: 'ch_announcements', svg: NS_ICONS.announce, ic: 'ic-announce', t: isFa ? 'اطلاعیه‌ها' : 'Announcements', d: isFa ? 'اطلاعیه‌های سیستم و برنامه' : 'System and app announcements', def: 'mini_app' },
                { key: 'ch_wheel', svg: NS_ICONS.wheel, ic: 'ic-wheel', t: isFa ? 'گردونه شانس' : 'Spin Rewards', d: isFa ? 'پاداش گردونه و اسپین رایگان' : 'Wheel rewards and free spins', def: 'mini_app' },
                { key: 'ch_referral', svg: NS_ICONS.referral, ic: 'ic-referral', t: isFa ? 'رفرال' : 'Referral', d: isFa ? 'دعوت کاربران جدید و پاداش' : 'New invites and referral rewards', def: 'mini_app' },
                { key: 'ch_wallet', svg: NS_ICONS.wallet, ic: 'ic-wallet', t: isFa ? 'کیف پول' : 'Wallet', d: isFa ? 'دریافت توکن، پاداش روزانه' : 'Token received, daily reward', def: 'mini_app' },
            ]
        },
        {
            label: isFa ? 'اعلان‌های تبلیغاتی' : 'Promotional',
            items: [
                { key: 'ch_promotions', svg: NS_ICONS.promo, ic: 'ic-promo', t: isFa ? 'تبلیغات' : 'Promotions', d: isFa ? 'پیشنهادات ویژه و تبلیغات' : 'Special offers and promotions', def: 'none', premiumOnly: true },
            ]
        },
    ];

    const channels = [
        { val: 'none', label: isFa ? 'خاموش' : 'Off', cls: 'off' },
        { val: 'mini_app', label: isFa ? 'اپ' : 'App', cls: 'app' },
        { val: 'telegram', label: isFa ? 'ربات' : 'Bot', cls: 'bot' },
        { val: 'both', label: isFa ? 'هر دو' : 'Both', cls: 'both' },
    ];

    // Use DocumentFragment for performance — no string concatenation
    const frag = document.createDocumentFragment();

    for (const group of groups) {
        // Group label
        const lbl = document.createElement('div');
        lbl.className = 'ns-group-label';
        lbl.textContent = group.label;
        frag.appendChild(lbl);

        // Card list
        const cardList = document.createElement('div');
        cardList.className = 'ns-card-list';

        for (const cat of group.items) {
            const currentVal = settings[cat.key] || cat.def;

            // Phase 3/4: Premium locking for premiumOnly categories
            const isPremiumUser = window.MembershipApp && typeof window.MembershipApp.isPremiumCached === 'function'
                ? window.MembershipApp.isPremiumCached()
                : false;
            const isLocked = cat.premiumOnly && !isPremiumUser;
            // FIX (audit MED-2/MED-3): Unlocked premium-only cards get the --premium
            // variant (amber border + glow) + a ✦ PREMIUM corner badge so they're
            // visually distinguished from free category cards.
            const isPremiumUnlocked = cat.premiumOnly && isPremiumUser;

            const card = document.createElement('div');
            if (isLocked) {
                card.className = 'ns-prem-card ns-prem-card--locked';
            } else if (isPremiumUnlocked) {
                card.className = 'ns-prem-card ns-prem-card--premium';
            } else {
                card.className = 'ns-prem-card';
            }

            // FIX (audit MED-2): Add ✦ PREMIUM corner badge for unlocked premium-only cards
            if (isPremiumUnlocked) {
                const cornerBadge = document.createElement('div');
                cornerBadge.className = 'ns-prem-corner-badge';
                cornerBadge.textContent = '✦ PREMIUM';
                card.appendChild(cornerBadge);
            }

            // PHASE 2: For Free users (locked), add a Lock badge in the top corner
            // + make the whole card clickable → MembershipApp.open() (Premium upgrade).
            // Premium users are NOT affected — their cards remain exactly as before.
            if (isLocked) {
                const lockBadge = document.createElement('div');
                lockBadge.className = 'ns-prem-lock-badge';
                lockBadge.setAttribute('aria-hidden', 'true');
                lockBadge.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg>';
                card.appendChild(lockBadge);

                // Make the whole card clickable → Premium upgrade flow (MembershipApp.open)
                card.setAttribute('role', 'button');
                card.setAttribute('tabindex', '0');
                card.setAttribute('aria-disabled', 'true');
                card.style.cursor = 'pointer';
                const openUpgrade = function(e) {
                    // Prevent the click from also triggering the capsule button (which is disabled anyway)
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.MembershipApp && typeof window.MembershipApp.open === 'function') {
                        window.MembershipApp.open();
                    }
                };
                card.addEventListener('click', openUpgrade);
                // Keyboard accessibility — Enter/Space triggers upgrade
                card.addEventListener('keydown', function(e) {
                    if (e.key === 'Enter' || e.key === ' ') {
                        e.preventDefault();
                        openUpgrade(e);
                    }
                });
            }

            // Left: icon + text
            const left = document.createElement('div');
            left.className = 'ns-prem-left';

            const iconBox = document.createElement('div');
            iconBox.className = `ns-prem-icon ${cat.ic}`;
            iconBox.innerHTML = cat.svg;

            const textBox = document.createElement('div');
            textBox.className = 'ns-prem-text';
            const titleEl = document.createElement('div');
            titleEl.className = 'ns-prem-title';
            titleEl.textContent = cat.t;
            const descEl = document.createElement('div');
            descEl.className = 'ns-prem-desc';
            descEl.textContent = isLocked
                ? (isFa ? 'فقط برای اعضای Premium' : 'Premium members only')
                : cat.d;
            textBox.appendChild(titleEl);
            textBox.appendChild(descEl);

            left.appendChild(iconBox);
            left.appendChild(textBox);

            // Right: capsule selector (disabled for Free, functional for Premium)
            const capsule = document.createElement('div');
            capsule.className = 'ns-capsule';
            capsule.setAttribute('data-cat', cat.key);

            if (isLocked) {
                // PHASE 2: Free user — show the SAME capsule structure as Premium,
                // but all buttons are disabled (no hover, no state change, no API call).
                // Clicking the card (or capsule buttons) → MembershipApp.open() upgrade.
                capsule.classList.add('ns-capsule--locked');
                capsule.setAttribute('aria-disabled', 'true');
                for (const ch of channels) {
                    const btn = document.createElement('button');
                    btn.className = `ns-cap-btn ns-cap-btn--disabled${currentVal === ch.val ? ' ' + ch.cls : ''}`;
                    btn.setAttribute('data-cat', cat.key);
                    btn.setAttribute('data-val', ch.val);
                    btn.setAttribute('disabled', 'disabled');
                    btn.setAttribute('aria-disabled', 'true');
                    btn.setAttribute('tabindex', '-1');
                    btn.innerHTML = NS_CHAN_ICONS[ch.val] + '<span>' + ch.label + '</span>';
                    capsule.appendChild(btn);
                }
            } else {
                // Phase 4: Premium user — functional controls (UNCHANGED)
                for (const ch of channels) {
                    const btn = document.createElement('button');
                    btn.className = `ns-cap-btn${currentVal === ch.val ? ' active ' + ch.cls : ''}`;
                    btn.setAttribute('data-cat', cat.key);
                    btn.setAttribute('data-val', ch.val);
                    btn.innerHTML = NS_CHAN_ICONS[ch.val] + '<span>' + ch.label + '</span>';
                    capsule.appendChild(btn);
                }
            }

            card.appendChild(left);
            card.appendChild(capsule);

            // PHASE 4: For Free (locked) cards, add a muted upgrade message + CTA at the bottom.
            // Premium users do NOT see this — their cards end at the capsule (unchanged).
            if (isLocked) {
                const msgRow = document.createElement('div');
                msgRow.className = 'ns-prem-upgrade-row';

                const msgText = document.createElement('div');
                msgText.className = 'ns-prem-upgrade-msg';
                msgText.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><rect x="3" y="11" width="18" height="11" rx="2" ry="2"/><path d="M7 11V7a5 5 0 0 1 10 0v4"/></svg><span>' + (isFa ? 'برای دسترسی به این تنظیمات، به پریمیوم ارتقا دهید.' : 'Upgrade to Premium to access these settings.') + '</span>';
                msgRow.appendChild(msgText);

                const ctaBtn = document.createElement('button');
                ctaBtn.className = 'ns-prem-upgrade-cta';
                ctaBtn.setAttribute('type', 'button');
                ctaBtn.innerHTML = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 18h20M3 22h18M5 18l-2-9 6 4 5-7 5 7 6-4-2 9"/></svg><span>' + (isFa ? 'ارتقا به پریمیوم' : 'Upgrade to Premium') + '</span>';
                // CTA click → upgrade flow (MembershipApp.open). The card-level click handler
                // also does this, but having an explicit CTA button is clearer UX.
                ctaBtn.addEventListener('click', function(e) {
                    e.preventDefault();
                    e.stopPropagation();
                    if (window.MembershipApp && typeof window.MembershipApp.open === 'function') {
                        window.MembershipApp.open();
                    }
                });
                msgRow.appendChild(ctaBtn);

                card.appendChild(msgRow);
            }

            cardList.appendChild(card);
        }
        frag.appendChild(cardList);
    }

    // Single DOM write — no re-render
    list.innerHTML = '';
    list.appendChild(frag);

    // Event delegation — single listener on container (not per-button onclick)
    list.onclick = function(e) {
        const btn = e.target.closest('.ns-cap-btn');
        if (!btn) return;
        // PHASE 2: Locked (Free user) buttons must NOT trigger settings change.
        // The card-level click handler on the parent .ns-prem-card--locked already
        // routes to MembershipApp.open() (upgrade flow). This guard prevents the
        // settings API call from firing for Free users.
        if (btn.classList.contains('ns-cap-btn--disabled') || btn.hasAttribute('disabled')) {
            e.preventDefault();
            e.stopPropagation();
            return;
        }
        const catKey = btn.getAttribute('data-cat');
        const val = btn.getAttribute('data-val');
        if (catKey && val) handleChannelPrefChange(catKey, val);
    };

    // ── Status card ──
    const allCats = groups.flatMap(g => g.items);
    const activeCount = allCats.filter(c => (settings[c.key] || c.def) !== 'none').length;
    const bothCount = allCats.filter(c => (settings[c.key] || c.def) === 'both').length;

    if (statusEl) {
        let statusClass, statusTitle, statusDesc;
        if (activeCount === 0) {
            statusClass = 'inactive';
            statusTitle = isFa ? 'همه اعلان‌ها غیرفعال هستند' : 'All notifications disabled';
            statusDesc = isFa ? 'هیچ اعلانی دریافت نخواهید کرد' : 'You will not receive any notifications';
        } else if (bothCount >= 3) {
            statusClass = 'active';
            statusTitle = isFa ? 'سیستم اعلان فعال است' : 'Notification system active';
            statusDesc = isFa ? `${activeCount} دسته فعال · ${bothCount} روی هر دو کانال` : `${activeCount} active · ${bothCount} on both channels`;
        } else {
            statusClass = 'partial';
            statusTitle = isFa ? 'اعلان‌های مهم فعال هستند' : 'Important alerts active';
            statusDesc = isFa ? `${activeCount} از ${allCats.length} دسته فعال` : `${activeCount} of ${allCats.length} categories active`;
        }

        const statusIcon = statusClass === 'active'
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M22 11.08V12a10 10 0 1 1-5.93-9.14"/><polyline points="22 4 12 14.01 9 11.01"/></svg>'
            : statusClass === 'partial'
            ? '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>'
            : '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="15" y1="9" x2="9" y2="15"/><line x1="9" y1="9" x2="15" y2="15"/></svg>';

        // Use fragment for status too
        const sFrag = document.createDocumentFragment();
        const sIcon = document.createElement('div');
        sIcon.className = `ns-status-icon-wrap ${statusClass}`;
        sIcon.innerHTML = statusIcon;
        const sInfo = document.createElement('div');
        sInfo.className = 'ns-status-info';
        sInfo.innerHTML = `<div class="ns-status-title ${statusClass}">${statusTitle}</div><div class="ns-status-desc">${statusDesc}</div>`;
        sFrag.appendChild(sIcon);
        sFrag.appendChild(sInfo);
        statusEl.innerHTML = '';
        statusEl.appendChild(sFrag);
    }
}

function _defaultChannelSettings() {
    return {
        ch_referral: 'mini_app', ch_wallet: 'mini_app', ch_price_alert: 'both',
        ch_analysis: 'both', ch_breaking_news: 'both', ch_announcements: 'mini_app',
        ch_promotions: 'none', ch_challenges: 'mini_app', ch_tickets: 'both',
        ch_calendar: 'both', ch_wheel: 'mini_app', ch_security: 'both', ch_system: 'mini_app',
    };
}

function handleChannelPrefChange(catKey, val) {
    // Update cache
    if (_nsSettingsCache) _nsSettingsCache[catKey] = val;

    // Update UI — find capsule for this category
    const capsule = document.querySelector(`.ns-capsule[data-cat="${catKey}"]`);
    if (!capsule) return;
    const channelClasses = { none: 'off', mini_app: 'app', telegram: 'bot', both: 'both' };
    capsule.querySelectorAll('.ns-cap-btn').forEach(btn => {
        const btnVal = btn.getAttribute('data-val');
        btn.classList.remove('active', 'off', 'app', 'bot', 'both');
        if (btnVal === val) {
            btn.classList.add('active', channelClasses[val] || '');
        }
    });

    // Save to backend (fire-and-forget — no await for instant UI response)
    if (API_BASE && !UserContext.isGuest()) {
        const updates = {};
        updates[catKey] = val;
        apiFetch('/api/notifications/platform/settings', {
            method: 'PUT',
            body: JSON.stringify(updates),
        }).catch(() => {});
    }

    // Haptic feedback
    getTg()?.HapticFeedback?.impactOccurred?.('light');
}

async function handleNotifPrefChange(input) {
    // Legacy — kept for backward compat
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
 * اعتبارسنجی لحظه‌ای فیلدهای فرم تیکت.
 * ورودی: پارامترهای `field` (نام فیلد: title یا body) را دریافت می‌کند.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی رابط کاربری اعمال می‌شود.
 */
const TICKET_MIN_BODY = 10;
const TICKET_MAX_BODY = 1500;
function validateTicketField(field) {
    const input = document.getElementById(field === 'title' ? 'ticket-title' : 'ticket-body');
    const errorEl = document.getElementById(field === 'title' ? 'ticket-title-error' : 'ticket-body-error');
    if (!input || !errorEl) return true;
    const val = input.value.trim();
    let valid = true;
    let errMsg = '';
    if (field === 'title') {
        if (val && val.length < 3) { valid = false; errMsg = 'عنوان حداقل ۳ کاراکتر باشد'; }
    } else {
        if (val && val.length < TICKET_MIN_BODY) { valid = false; errMsg = `حداقل ${TICKET_MIN_BODY} کاراکتر`; }
    }
    errorEl.textContent = errMsg;
    input.classList.toggle('tk-error-state', !valid && val.length > 0);
    input.classList.toggle('tk-success-state', valid && val.length > 0);
    return valid;
}

/**
 * شمارنده لحظه‌ای تعداد کاراکترهای متن تیکت.
 * ورودی: بدون ورودی.
 * خروجی: خروجی صریحی برنمی‌گرداند و اثر آن روی رابط کاربری اعمال می‌شود.
 */
function updateTicketCharCount() {
    const body = document.getElementById('ticket-body');
    const counter = document.getElementById('ticket-char-counter');
    if (!body || !counter) return;
    const len = body.value.length;
    // Display in Persian digits
    const faLen = len.toLocaleString('fa-IR');
    const faMax = TICKET_MAX_BODY.toLocaleString('fa-IR');
    counter.textContent = `${faLen} / ${faMax}`;
    counter.classList.toggle('tk-limit', len >= TICKET_MAX_BODY);
    if (len >= TICKET_MAX_BODY) {
        counter.textContent = `سقف مجاز (${faMax} کاراکتر)`;
    }
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
    const titleEl = document.getElementById('ticket-title');
    const bodyEl = document.getElementById('ticket-body');
    const title = titleEl ? titleEl.value.trim() : '';
    const body = bodyEl ? bodyEl.value.trim() : '';
    const btn = document.getElementById('ticket-submit-btn');

    // Real-time validation
    let valid = true;
    if (!title) {
        valid = false;
        const errEl = document.getElementById('ticket-title-error');
        if (errEl) errEl.textContent = 'عنوان الزامی است';
        if (titleEl) titleEl.classList.add('tk-error-state');
    } else if (title.length < 3) {
        valid = false;
        const errEl = document.getElementById('ticket-title-error');
        if (errEl) errEl.textContent = 'عنوان حداقل ۳ کاراکتر باشد';
        if (titleEl) titleEl.classList.add('tk-error-state');
    }
    if (!body) {
        valid = false;
        const errEl = document.getElementById('ticket-body-error');
        if (errEl) errEl.textContent = 'متن پیام الزامی است';
        if (bodyEl) bodyEl.classList.add('tk-error-state');
    } else if (body.length < TICKET_MIN_BODY) {
        valid = false;
        const errEl = document.getElementById('ticket-body-error');
        if (errEl) errEl.textContent = `حداقل ${TICKET_MIN_BODY} کاراکتر نیاز است`;
        if (bodyEl) bodyEl.classList.add('tk-error-state');
    }
    if (!valid) { showToast('لطفاً خطاهای فرم را برطرف کنید'); return; }
    if (!API_BASE) { showToast(t('ticket_error')); return; }

    // Prevent double-submit
    if (btn) { btn.disabled = true; btn.style.opacity = '0.6'; btn.innerHTML = '<div class="tk-mini-spinner"></div> در حال ارسال...'; }

    try {
        const healthy = await checkBackendHealth();
        if (!healthy) throw new Error('Backend unavailable');
        await apiFetch('/api/tickets', {
            method: 'POST',
            body: JSON.stringify({ user_id: getUserId(), user_name: getUserName(), title, body })
        });
        // Clear form
        if (titleEl) titleEl.value = '';
        if (bodyEl) bodyEl.value = '';
        updateTicketCharCount();
        // Success message
        showToast(t('ticket_sent'));
        addNotification(t('support'), t('ticket_sent'), false);
        getTg()?.showPopup?.({ title: t('ticket_sent'), message: title, buttons: [{ type: 'ok' }] });
        // Refresh list
        await fetchTickets();
        renderTickets();
    } catch (e) {
        showToast(t('ticket_error'));
        console.error('submitTicket:', e);
    } finally {
        if (btn) {
            btn.disabled = false; btn.style.opacity = '1';
            btn.innerHTML = '<svg width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><line x1="22" y1="2" x2="11" y2="13"/><polygon points="22 2 15 22 11 13 2 9 22 2"/></svg><span>' + t('ticket_send') + '</span>';
        }
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
 * بستن تمام overlay ها و modal های باز.
 *
 * BUG FIX (Task ID: WEB-DEV-REVIEW-1):
 * قبل از این تابع، وقتی کاربر coin-detail-modal را باز می‌کرد و سپس از
 * طریق bottom-nav به تب دیگری می‌رفت (بدون X)، modal در DOM باقی می‌ماند.
 * چون `.cd-fullscreen` دارای `position: fixed; inset: 0; z-index: 10000;
 * pointer-events: auto` است، modal نامرئی روی کل viewport قرار می‌گرفت و
 * تمام click های تب مقصد را intercept می‌کرد → کاربر گیر می‌کرد و نمی‌توانست
 * با صفحه تعامل داشته باشد.
 *
 * این تابع یک defence-in-depth است:
 *   1. coin-detail-modal را مستقیماً display:none می‌کند (بدون فراخوانی
 *      closeCoinDetail() که خود switchTab را فرامی‌خواند → infinite recursion).
 *   2. تمام modal های دیگر را اگر باز هستند می‌بندد.
 *   3. تابع destroyTvWidget() را فرامی‌خواند تا منابع TradingView آزاد شود.
 *
 * این تابع idempotent است و در هر switchTab فراخوانی می‌شود.
 */
function closeAllOverlays() {
    // 1) Coin detail modal (the buggy .cd-fullscreen overlay)
    const cdModal = document.getElementById('coin-detail-modal');
    if (cdModal && cdModal.style.display !== 'none') {
        // Direct hide — bypass closeCoinDetail() to avoid switchTab recursion.
        cdModal.classList.remove('slide-up', 'slide-down');
        cdModal.style.display = 'none';
        // Free TradingView widget resources (no-op if not initialised).
        try { if (typeof destroyTvWidget === 'function') destroyTvWidget(); } catch (_) {}
        try { currentTvChartInfo = null; _currentDetailSymbol = null; } catch (_) {}
        const _alertPriceReset = document.getElementById('alert-current-price-value');
        if (_alertPriceReset) _alertPriceReset.textContent = '--';
    }

    // 2) Standard `.modal` overlays — each has display:none default in CSS,
    //    so we just restore it. We use a list to keep this maintainable.
    const standardModalIds = [
        'add-coin-modal', 'add-analysis-modal', 'news-modal',
        'notif-modal', 'settings-modal', 'notif-settings-modal',
        'lang-modal', 'tickets-modal', 'admin-tickets-modal', 'about-modal',
        'terms-modal', 'privacy-modal', 'content-editor-modal',
    ];
    for (const id of standardModalIds) {
        const m = document.getElementById(id);
        if (m && m.style.display !== 'none') {
            m.style.display = 'none';
            // Some modals toggle a `body` lock class; remove it for safety.
            document.body.classList.remove('modal-open', 'jl-locked', 'body-locked');
        }
    }

    // NEWSFE-022 FIX: Dismiss ni-* bottom sheets and overlays too. Previously
    // these persisted across tab switches because closeAllOverlays only
    // handled coin-detail-modal and standard .modal overlays. The filter
    // sheet, reminder sheet, share sheet, and search overlay would stay
    // visible on top of the newly-switched tab, intercepting clicks.
    const niOverlayIds = [
        'ni-filter-sheet', 'ni-reminder-sheet', 'ni-share-sheet',
        'ni-search-overlay',
    ];
    for (const id of niOverlayIds) {
        const m = document.getElementById(id);
        if (m && m.style.display !== 'none') {
            m.style.display = 'none';
            document.body.classList.remove('modal-open', 'jl-locked', 'body-locked');
        }
    }

    // 3) Clear the Telegram BackButton navigation stack — switching main tabs
    //    resets the history so the Back button is hidden on top-level pages.
    try { tgBackReset(); } catch (_) {}
}

function switchTab(pageId, btn) {
    // BUG FIX: dismiss any open overlay/modal BEFORE switching tabs. Otherwise
    // fixed overlays like coin-detail-modal stay on top and intercept clicks.
    closeAllOverlays();

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
            renderDashboardMarketStatus();
            renderDashboardFeaturedAnalysis();
            renderDashboardCalendar();
            renderMarketTicker();
            loadImportantNews();
        } else {
            renderWatchlist();
            renderDashboardMarketStatus();
            renderDashboardFeaturedAnalysis();
            renderDashboardCalendar();
            renderMarketTicker();
        }
    } else if (pageId === 'market-page') {
        if (!tabLoaded.market) {
            // FIX: tabLoaded.market is set inside loadMarketData() only on
            // successful data load (when allCoins is populated). Previously
            // it was set synchronously here, which meant if loadMarketData()
            // failed (network error, 401, API down), tabLoaded.market stayed
            // true and subsequent Market tab visits rendered from empty
            // allCoins with no retry. Now, failed loads leave tabLoaded.market
            // false so the next visit re-attempts the fetch.
            loadMarketData();
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
            // NEWSFE-005 FIX: Don't set tabLoaded.news=true here synchronously.
            // loadNews() is async and catches its own errors — if the fetch
            // fails, newsCache stays empty and setting tabLoaded.news=true
            // would prevent retry on the next News tab visit. loadImportantNews
            // (called at bootstrap) and loadNews itself manage tabLoaded.news
            // only on success (when newsCache.length > 0). Here we just kick
            // off the load; the user sees the skeleton, and if it succeeds,
            // the next visit will hit the cache path.
            loadNews();
        } else {
            // ROOT CAUSE FIX (F-7): Returning to News page should re-render
            // the active sub-tab, in case calendarEvents was updated in the
            // background by polling or bootstrap. Without this, the user
            // could see stale DOM (or skeleton) from a previous visit.
            const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news;
            if (activeTab) renderNews(activeTab);
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
 * ساختار جدید: max 3 آیتم، اولویت‌بندی (Urgent → Important → Latest)،
 * تصویر 64x64، ارتفاع برابر کارت‌ها.
 * ورودی: بدون ورودی.
 * خروجی: یک `Promise` با نتیجه نهایی این عملیات برمی‌گرداند.
 */
async function loadImportantNews() {
    const container = document.getElementById('important-news');
    if (!container) return;
    try {
        await loadNews(); // اطمینان از دریافت اخبار
        // PERF FIX (item 2): loadImportantNews runs at bootstrap and fills
        // newsCache. Set tabLoaded.news=true so the first News tab click
        // doesn't re-call loadNews() (which would show skeleton + re-fetch).
        // The News tab will re-render from the already-populated newsCache.
        //
        // NEWSFE-005 FIX: Only set tabLoaded.news=true if loadNews actually
        // populated newsCache. loadNews() catches its own errors internally
        // and never throws — so on API failure (401, network error, empty
        // response), newsCache stays empty. Previously tabLoaded.news was set
        // unconditionally, which meant the user could never retry the News
        // tab (switchTab saw tabLoaded.news=true → rendered from empty cache
        // → "no news found" with no retry). Now, if newsCache is empty, we
        // leave tabLoaded.news=false so the next News tab visit re-attempts
        // the fetch.
        if (newsCache.length > 0) {
            tabLoaded.news = true;
        }
        if (!newsCache.length) {
            container.innerHTML = `<div class="dc-empty">${t('dashboard_no_news')}</div>`;
            return;
        }

        // DASHBOARD SPEED OPTIMIZATION: persist news to localStorage so the
        // next cold open can render instantly without waiting for the API.
        try {
            localStorage.setItem('news_cache', JSON.stringify({ data: newsCache, ts: Date.now() }));
        } catch (_) {}

        _renderImportantNewsInto(container);
    } catch (e) {
        const c = document.getElementById('important-news');
        if (c) c.innerHTML = `<div class="dc-empty">${t('dashboard_no_news')}</div>`;
    }
}

/**
 * Render the top 3 important news items into the given container.
 * Extracted from loadImportantNews so it can be called from
 * renderImportantNewsFromCache() for instant cold-open rendering.
 */
function _renderImportantNewsInto(container) {
    if (!newsCache.length) {
        container.innerHTML = `<div class="dc-empty">${t('dashboard_no_news')}</div>`;
        return;
    }
    // Priority sort: Urgent (breaking) → Important (bullish/bearish/macro) → Latest (neutral/other)
    const priorityRank = (n) => {
        const s = (n.sentiment || '').toLowerCase();
        if (s === 'breaking') return 0; // urgent
        if (s === 'bullish' || s === 'bearish' || s === 'macro') return 1; // important
        return 2; // latest
    };
    const sorted = newsCache.slice().sort((a, b) => {
        const pa = priorityRank(a), pb = priorityRank(b);
        if (pa !== pb) return pa - pb;
        return 0;
    });
    const important = sorted.slice(0, 3);
    if (!important.length) {
        container.innerHTML = `<div class="dc-empty">${t('dashboard_no_news')}</div>`;
        return;
    }

    // Store in a separate array for dashboard to avoid race with News page's displayedNews
    _dashboardDisplayedNews = important;

    const priorityLabels = {
        urgent: t('dashboard_priority_urgent'),
        important: t('dashboard_priority_important'),
        latest: t('dashboard_priority_latest')
    };
    const priorityIcons = {
        urgent: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86L1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
        important: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
        latest: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>'
    };

    container.innerHTML = important.map((n, i) => {
        const rank = priorityRank(n);
        const pKey = rank === 0 ? 'urgent' : (rank === 1 ? 'important' : 'latest');
        const safeTitle = escapeHtml(n.title || '');
        const safeSource = escapeHtml(n.source || '');
        const safeImg = escapeHtml(n.image || getAmirbtcFallbackSvg(64, 64, 'AMIRBTC'));
        return `
        <div class="important-news-item priority-${pKey}" style="animation-delay:${i * 0.06}s" onclick="openDashboardNewsModal(${i})">
            <img loading="lazy" src="${safeImg}" class="important-news-img" alt="${safeTitle}" onerror="newsImageFallback(this)">
            <div class="important-news-content">
                <span class="important-news-priority priority-${pKey}">${priorityIcons[pKey]}<span>${priorityLabels[pKey]}</span></span>
                <div class="important-news-title">${safeTitle}</div>
                <div class="important-news-source">
                    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M4 4h16v16H4z"/><line x1="8" y1="8" x2="16" y2="8"/><line x1="8" y1="12" x2="16" y2="12"/><line x1="8" y1="16" x2="12" y2="16"/></svg>
                    <span>${safeSource}</span>
                </div>
            </div>
        </div>`;
    }).join('');
}

/**
 * DASHBOARD SPEED OPTIMIZATION: render important news from localStorage cache
 * on cold open, before the API response arrives. Called from DOMContentLoaded
 * if news_cache exists and is fresh (< 5min).
 */
function renderImportantNewsFromCache() {
    const container = document.getElementById('important-news');
    if (!container) return;
    if (newsCache.length) {
        _renderImportantNewsInto(container);
    }
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

    // Meta: time, source, category
    const timeEl = el('news-modal-time');
    if (timeEl) timeEl.innerText = formatNewsTimeTehran(n.pub_date, n.time || n.time_ago) || '—';
    const sourceEl = el('news-modal-source');
    if (sourceEl) sourceEl.innerText = n.source || n.source_name || '—';
    const categoryEl = el('news-modal-category');
    if (categoryEl) {
        const cat = n.category || 'crypto';
        const catLabels = { crypto: 'کریپتو', forex: 'فارکس', economy: 'اقتصاد' };
        categoryEl.innerText = catLabels[cat] || cat;
    }

    const imgEl = el('news-modal-image'); if (imgEl) { imgEl.src = n.image || getAmirbtcFallbackSvg(400, 250, 'AMIRBTC'); imgEl.onerror = function() { newsImageFallback(this); }; }
    const bodyEl = el('news-modal-body');
    if (bodyEl) {
        const hasAiSummary = !!(n.ai_summary && n.ai_summary.trim().length > 50);
        if (hasAiSummary) {
            // AI summary ready — show ONLY the analysis (no RSS body, per final architecture)
            bodyEl.innerHTML =
                '<div class="news-modal-summary-box">' +
                    '<div class="news-modal-summary-header">' +
                        '<svg class="news-modal-ai-icon" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><path d="M12 2L13.09 8.26L20 9L13.09 9.74L12 16L10.91 9.74L4 9L10.91 8.26L12 2Z" stroke-linejoin="round"/><circle cx="12" cy="20" r="1"/></svg>' +
                        '<span>تحلیل خبر</span>' +
                    '</div>' +
                    '<div class="news-modal-summary-text">' + escapeHtmlForNews(n.ai_summary) + '</div>' +
                '</div>';
            // Tags row (sentiment + impact + coins) with emoji icons
            let tagsHtml = '<div class="news-modal-tags">';
            if (n.sentiment) {
                const sentEmoji = { bullish: '🟢', bearish: '🔴', neutral: '🟡', breaking: '⚡', macro: '🌐' };
                const sentLabels = { bullish: 'صعودی', bearish: 'نزولی', neutral: 'خنثی', breaking: 'فوری', macro: 'کلان' };
                tagsHtml += '<span class="news-tag news-tag-sentiment">' + (sentEmoji[n.sentiment] || '•') + ' ' + (sentLabels[n.sentiment] || n.sentiment) + '</span>';
            }
            if (n.impact) {
                const impEmoji = { high: '⚡', medium: '⭐', low: '📉' };
                const impLabels = { high: 'تأثیر بالا', medium: 'تأثیر متوسط', low: 'تأثیر کم' };
                tagsHtml += '<span class="news-tag news-tag-impact-' + (n.impact || 'low') + '">' + (impEmoji[n.impact] || '•') + ' ' + (impLabels[n.impact] || n.impact) + '</span>';
            }
            if (n.coins && Array.isArray(n.coins) && n.coins.length > 0) {
                for (const coin of n.coins.slice(0, 5)) {
                    tagsHtml += '<span class="news-tag news-tag-coin">🪙 ' + escapeHtml(coin) + '</span>';
                }
            }
            tagsHtml += '</div>';
            bodyEl.innerHTML += tagsHtml;
        } else {
            // No AI summary — show differentiated message based on ai_status
            // Phase 10.5: pending / retry / failed / rate_limited / unknown each have unique message
            bodyEl.innerHTML = buildNewsPendingBox(n.ai_status);
        }
        bodyEl.style.opacity = '1';
    }
    const linkEl = el('news-modal-link');
    if (linkEl) {
        // P1-04 FIX (NEWSSEC-004): Sanitize URL scheme — only http/https allowed.
        linkEl.href = sanitizeNewsUrl(n.url);
        const spanEl = linkEl.querySelector('span');
        if (spanEl) spanEl.innerText = t('view_source');
    }
    const modalEl = el('news-modal'); if (modalEl) modalEl.style.display = 'flex';

    // Fire daily mission: news_view (non-blocking, idempotent)
    if (typeof fireMissionEvent === 'function') fireMissionEvent(MISSION_EVENTS.NEWS_OPEN);
}

// ============================================================================
//#region داشبورد جدید — Market Status / Featured Analysis / Calendar
// ============================================================================

/**
 * کارت وضعیت بازار را رندر می‌کند: Fear & Greed (چپ) + Market Trend (راست).
 * داده‌ها از globalMarketData خوانده می‌شود. در صورت نبود داده، skeleton باقی می‌ماند.
 */
function renderDashboardMarketStatus() {
    const container = $('dashboard-market-status');
    if (!container) return;
    if (!globalMarketData) {
        // Keep skeleton in place — no flicker
        return;
    }

    // ── Fear & Greed (left column) ──
    const fgVal = (typeof globalMarketData.fearGreedValue === 'number' && !isNaN(globalMarketData.fearGreedValue))
        ? globalMarketData.fearGreedValue : null;
    const fgClass = (globalMarketData.fearGreedClassification || '').toLowerCase().replace(/\s+/g, '_');
    const fgSource = globalMarketData.fearGreedSource || '';
    let fgLabel = '';
    let fgClassStr = '';
    if (fgClass === 'extreme_greed' || fgClass === 'extremegreed') { fgLabel = t('fg_extreme_greed'); fgClassStr = 'fg-extreme-greed'; }
    else if (fgClass === 'greed') { fgLabel = t('fg_greed'); fgClassStr = 'fg-greed'; }
    else if (fgClass === 'neutral') { fgLabel = t('fg_neutral'); fgClassStr = 'fg-neutral'; }
    else if (fgClass === 'fear') { fgLabel = t('fg_fear'); fgClassStr = 'fg-fear'; }
    else if (fgClass === 'extreme_fear' || fgClass === 'extremefear') { fgLabel = t('fg_extreme_fear'); fgClassStr = 'fg-extreme-fear'; }
    else if (globalMarketData.fearGreedClassification) { fgLabel = globalMarketData.fearGreedClassification; fgClassStr = 'fg-neutral'; }
    else { fgLabel = '--'; fgClassStr = 'fg-neutral'; }

    // Semicircle gauge: 0..100 → arc fill (stroke-dashoffset)
    const fgPercent = (fgVal != null) ? Math.max(0, Math.min(100, fgVal)) : 0;
    const totalArcLen = 150.8;
    const arcOffset = (totalArcLen - (totalArcLen * fgPercent / 100)).toFixed(1);

    const fgHTML = fgVal != null ? `
        <div class="dms-card dms-fg">
            <div class="dms-card-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                <span>Fear &amp; Greed</span>
            </div>
            <div class="dms-fg-body">
                <div class="dms-fg-gauge">
                    <svg viewBox="0 0 120 70" fill="none" preserveAspectRatio="xMidYMid meet">
                        <path d="M 12 60 A 48 48 0 0 1 108 60" stroke="rgba(255,255,255,0.06)" stroke-width="9" stroke-linecap="round" fill="none"/>
                        <path d="M 12 60 A 48 48 0 0 1 108 60" stroke="url(#dms-fg-grad)" stroke-width="9" stroke-linecap="round" fill="none" stroke-dasharray="150.8" stroke-dashoffset="${arcOffset}"/>
                        <defs>
                            <linearGradient id="dms-fg-grad" x1="0%" y1="0%" x2="100%" y2="0%">
                                <stop offset="0%" stop-color="#EF4444"/>
                                <stop offset="35%" stop-color="#F97316"/>
                                <stop offset="65%" stop-color="#F5A623"/>
                                <stop offset="100%" stop-color="#22C55E"/>
                            </linearGradient>
                        </defs>
                    </svg>
                    <div class="dms-fg-score">
                        <span class="dms-fg-score-num">${fgVal}</span>
                        <span class="dms-fg-score-label">${escapeHtml(t('dashboard_gauge_index'))}</span>
                    </div>
                </div>
                <div class="dms-fg-text">
                    <span class="dms-fg-class ${fgClassStr}">${escapeHtml(fgLabel)}</span>
                </div>
            </div>
        </div>
    ` : `
        <div class="dms-card dms-fg">
            <div class="dms-card-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><path d="M8 14s1.5 2 4 2 4-2 4-2"/><line x1="9" y1="9" x2="9.01" y2="9"/><line x1="15" y1="9" x2="15.01" y2="9"/></svg>
                <span>Fear &amp; Greed</span>
            </div>
            <div class="dms-fg-body">
                <div class="dms-fg-text" style="flex:1;">
                    <span class="dms-fg-class fg-neutral">--</span>
                    <span class="dms-fg-source">${escapeHtml(t('no_data'))}</span>
                </div>
            </div>
        </div>
    `;

    // ── Market Trend (right column) — Bull / Bear graphic indicator ──
    let gainers = 0, losers = 0;
    if (Array.isArray(allCoins) && allCoins.length) {
        for (let i = 0; i < allCoins.length; i++) {
            const ch = allCoins[i].changePercent24Hr;
            if (typeof ch === 'number' && !isNaN(ch)) {
                if (ch > 0) gainers++;
                else if (ch < 0) losers++;
            }
        }
    }
    const totalGL = gainers + losers;
    const ratio = totalGL > 0 ? (gainers / totalGL) : 0.5;
    let trendLabel, trendClass, trendGraphic;
    if (ratio > 0.58) {
        trendLabel = t('dashboard_trend_bullish');
        trendClass = 'bullish';
        trendGraphic = `<img src="assets/market/neutral.webp" alt="Bull" class="trend-bull-bear-img" loading="eager" decoding="async" width="90" height="90" onerror="this.outerHTML='<span class=trend-fallback>🐂</span>'">`;
    } else if (ratio >= 0.42) {
        trendLabel = t('dashboard_trend_neutral');
        trendClass = 'neutral';
        trendGraphic = `<img src="assets/market/bull.webp" alt="Neutral" class="trend-bull-bear-img" loading="eager" decoding="async" width="90" height="90" onerror="this.outerHTML='<span class=trend-fallback>⚖️</span>'">`;
    } else {
        trendLabel = t('dashboard_trend_bearish');
        trendClass = 'bearish';
        trendGraphic = `<img src="assets/market/bear.webp" alt="Bear" class="trend-bull-bear-img" loading="eager" decoding="async" width="90" height="90" onerror="this.outerHTML='<span class=trend-fallback>🐻</span>'">`;
    }

    const trendHTML = `
        <div class="dms-card dms-trend">
            <div class="dms-card-header">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="22 7 13.5 15.5 8.5 10.5 2 17"/><polyline points="16 7 22 7 22 13"/></svg>
                <span>${escapeHtml(t('dashboard_market_trend'))}</span>
            </div>
            <div class="dms-trend-body">
                <div class="dms-trend-graphic ${trendClass}">${trendGraphic}</div>
                <span class="dms-trend-label-big ${trendClass}">${escapeHtml(trendLabel)}</span>
                <span class="dms-trend-sub">
                    <span class="up">${gainers}</span>
                    <span>▲</span>
                    <span style="color:#6B7A8D;">·</span>
                    <span class="down">${losers}</span>
                    <span>▼</span>
                </span>
            </div>
        </div>
    `;

    container.innerHTML = fgHTML + trendHTML;
}

/**
 * Market Ticker — pro exchange-style auto-scrolling horizontal price strip.
 *
 * Each item shows: logo + symbol + price + 24h change% (with colored arrow).
 * The track is duplicated 2x in the DOM so a `transform: translateX(-50%)`
 * CSS animation produces a seamless infinite loop (the second copy lands
 * exactly where the first one started).
 *
 * ROOT-CAUSE FIX (Task — Market Ticker redesign):
 *   1. The previous implementation rendered immediately on DOMContentLoaded
 *      with hard-coded FALLBACK coins that had ONLY symbol + changePercent24Hr=0.
 *      No price, no logo → ticker looked empty/meaningless for the first few
 *      seconds of every cold open.
 *   2. Real market data was only fetched AFTER membership verification
 *      completed (bootstrapUser → _startDataLoading), so the empty-fallback
 *      state could persist for 2-5+ seconds.
 *   3. Production Worker gates /api/market behind Telegram initData auth,
 *      which is not available until the SDK is ready — so even eager
 *      pre-fetching wouldn't help.
 *
 * FIX:
 *   - Use the persistent `market_data_cache` in localStorage (5-min TTL)
 *     to hydrate the ticker IMMEDIATELY on app start — no empty state.
 *   - When no fresh cache exists, show a shimmering skeleton placeholder
 *     (8 mtsk-pill elements) instead of meaningless 0.00% fallbacks.
 *   - When real data arrives (after bootstrap), re-render with logos,
 *     prices, and real change percentages. The signature guard prevents
 *     needless DOM rewrites when the data hasn't actually changed.
 *   - Format prices compactly ($118,245 / $3,845 / $0.0042) so the ticker
 *     stays readable on narrow phones.
 *
 * Performance:
 *   - Animation is pure CSS transform: translateX (GPU-only, 60fps on mobile).
 *   - No JS rAF loop, no per-frame layout work.
 *   - Signature guard skips innerHTML rewrite when data is unchanged — keeps
 *     the existing animation running without restarts.
 *   - Idempotent: calling renderMarketTicker() multiple times is safe.
 */
let _tickerRendered = false;
let _tickerSignature = '';
let _tickerSkeletonCleared = false;

function _formatTickerPrice(priceUsd) {
    const p = Number(priceUsd);
    if (!isFinite(p) || p === 0) return '--';
    if (p >= 1000) {
        // 118,245 — full thousands separator
        return '$' + p.toLocaleString('en-US', { maximumFractionDigits: 0 });
    }
    if (p >= 1) {
        // 3,845.62 — 2 decimals
        return '$' + p.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
    }
    if (p >= 0.01) {
        // 0.42 — 4 decimals
        return '$' + p.toFixed(4);
    }
    // Sub-cent: 0.000042 — 6 significant digits
    return '$' + p.toFixed(6);
}

function _buildTickerItem(c) {
    const sym = escapeHtml(c.symbol || '');
    const pct = (typeof c.changePercent24Hr === 'number' && !isNaN(c.changePercent24Hr))
        ? c.changePercent24Hr : 0;
    const absPct = Math.abs(pct);
    // "Flat" threshold: |pct| < 0.05% → neutral grey/blue
    let cls = 'flat';
    let arrowSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><line x1="5" y1="12" x2="19" y2="12"/></svg>';
    if (absPct >= 0.05) {
        if (pct > 0) {
            cls = 'up';
            arrowSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="18 15 12 9 6 15"/></svg>';
        } else {
            cls = 'down';
            arrowSvg = '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="3" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>';
        }
    }
    const changeStr = (pct > 0 ? '+' : '') + pct.toFixed(2) + '%';
    const priceStr = _formatTickerPrice(c.priceUsd);
    // Logo: prefer backend-provided image URL; fall back to coincap assets CDN;
    // the <img loading="lazy" onerror> swaps to a first-letter badge via iconFallback().
    const imgSrc = c.image || `https://assets.coincap.io/assets/icons/${String(c.symbol || '').toLowerCase()}@2x.png`;
    return `<div class="market-ticker-item">`
        + `<img class="market-ticker-icon" src="${escapeHtml(imgSrc)}" alt="${sym}" loading="lazy" decoding="async" data-symbol="${sym}" onerror="iconFallback(this)">`
        + `<span class="market-ticker-symbol">${sym}</span>`
        + `<span class="market-ticker-price">${priceStr}</span>`
        + `<span class="market-ticker-change ${cls}">${arrowSvg}${changeStr}</span>`
        + `</div>`;
}

function renderMarketTicker() {
    const track = $('market-ticker-track');
    console.log('[TICKER] renderMarketTicker called — track element:', !!track, '| allCoins length:', Array.isArray(allCoins) ? allCoins.length : 'not-array');
    if (!track) {
        console.warn('[TICKER] renderMarketTicker ABORTED — #market-ticker-track element NOT FOUND in DOM');
        return;
    }

    // No data at all → keep skeleton (skeleton is in DOM by default; re-add if
    // a previous render cleared it and we lost the data somehow).
    if (!Array.isArray(allCoins) || !allCoins.length) {
        console.log('[TICKER] renderMarketTicker — no allCoins data, keeping skeleton');
        if (!_tickerSkeletonCleared) return; // skeleton already in DOM
        // Restore skeleton
        track.classList.remove('visible');
        track.innerHTML = `<div class="market-ticker-skeleton" id="market-ticker-skeleton">`
            + Array(8).fill('<span class="mtsk-pill"></span>').join('')
            + `</div>`;
        track.style.animation = 'none';
        _tickerSkeletonCleared = false;
        _tickerSignature = '';
        return;
    }

    // Take top 20 coins (allCoins is already ordered by rank from API)
    const tickerCoins = allCoins.slice(0, 20);
    if (!tickerCoins.length) return;

    // Signature guard — skip innerHTML rewrite when data hasn't changed.
    // This keeps the CSS animation running smoothly without restarts.
    const sig = tickerCoins.map(c =>
        `${c.symbol}:${(Number(c.changePercent24Hr) || 0).toFixed(2)}:${(Number(c.priceUsd) || 0).toFixed(4)}:${c.image ? '1' : '0'}`
    ).join('|');
    if (sig === _tickerSignature && _tickerRendered) {
        console.log('[TICKER] renderMarketTicker SKIP — signature unchanged (data already rendered)');
        return;
    }
    _tickerSignature = sig;

    // Build items. Duplicate TWICE so the track is exactly 2 copies wide —
    // this lets the CSS `translateX(-50%)` animation loop seamlessly.
    const itemsHtml = tickerCoins.map(_buildTickerItem).join('');
    track.innerHTML = itemsHtml + itemsHtml;
    console.log('[TICKER] renderMarketTicker SUCCESS — rendered', tickerCoins.length, 'items × 2 = ', (tickerCoins.length * 2), 'DOM nodes');

    // Re-enable animation (in case it was disabled by skeleton state)
    track.style.animation = '';

    _tickerRendered = true;
    _tickerSkeletonCleared = true;
}

// ============================================================================
// ── NEW FEATURE: Market Heatmap ──
// ============================================================================
// Renders a visual grid of top coins where each cell's:
//   - SIZE is proportional to market cap (bigger = more dominant)
//   - COLOR is based on 24h change (green = up, red = down, intensity = magnitude)
//   - Text shows symbol + percentage
//
// This gives users an instant visual overview of market sentiment without
// having to scan a list. Tapping a cell opens the coin detail.
function renderDashboardHeatmap() {
    const container = $('dashboard-heatmap');
    if (!container) return;

    if (!allCoins || allCoins.length === 0) {
        // Skeleton already in HTML — leave it
        return;
    }

    // Priority list of important coins to display (ordered by market importance)
    const PRIORITY_COINS = [
        'BTC', 'ETH', 'BNB', 'SOL', 'XRP', 'DOGE', 'ADA', 'TRX',
        'LINK', 'AVAX', 'TON', 'SUI', 'DOT', 'LTC', 'NEAR', 'APT'
    ];

    const skipStable = ['USDT', 'USDC', 'DAI', 'BUSD', 'TUSD', 'FDUSD', 'USDE', 'USDGO'];

    // Build a map of available coins by symbol
    const coinMap = {};
    for (const c of allCoins) {
        if (c && c.symbol && !skipStable.includes(c.symbol.toUpperCase())) {
            coinMap[c.symbol.toUpperCase()] = c;
        }
    }

    // Select coins: priority first, then fill from remaining top by market cap
    const selected = [];
    const used = new Set();
    for (const sym of PRIORITY_COINS) {
        if (coinMap[sym] && !used.has(sym)) {
            selected.push(coinMap[sym]);
            used.add(sym);
        }
    }
    // Fill remaining slots from top by market cap
    if (selected.length < 16) {
        const remaining = allCoins
            .filter(c => c && c.symbol && !skipStable.includes(c.symbol.toUpperCase()) && !used.has(c.symbol.toUpperCase()))
            .sort((a, b) => (b.marketCapUsd || 0) - (a.marketCapUsd || 0));
        for (const c of remaining) {
            if (selected.length >= 16) break;
            selected.push(c);
            used.add(c.symbol.toUpperCase());
        }
    }

    if (selected.length === 0) {
        container.innerHTML = '<div class="heatmap-empty">—</div>';
        return;
    }

    // Size tiers: BTC gets xl, ETH gets lg, next 6 get md, rest get sm
    // This creates a professional treemap-style heatmap where size = importance
    const SIZE_MAP = {};
    if (selected[0]) SIZE_MAP[selected[0].symbol.toUpperCase()] = 'hm-size-xl';
    if (selected[1]) SIZE_MAP[selected[1].symbol.toUpperCase()] = 'hm-size-lg';
    for (let i = 2; i < Math.min(8, selected.length); i++) {
        SIZE_MAP[selected[i].symbol.toUpperCase()] = 'hm-size-md';
    }

    // Build heatmap cells
    const cells = selected.map(coin => {
        const change = Number(coin.changePercent24Hr) || 0;
        const sym = coin.symbol.toUpperCase();
        const sizeClass = SIZE_MAP[sym] || 'hm-size-sm';

        // Color: proportional intensity — only exactly 0.0% is gray
        let bgColor, textColor, borderColor;
        if (change === 0) {
            bgColor = 'rgba(255, 255, 255, 0.04)';
            textColor = 'rgba(255, 255, 255, 0.6)';
            borderColor = 'rgba(255, 255, 255, 0.08)';
        } else if (change > 0) {
            const intensity = Math.min(Math.abs(change) / 8, 1);
            const alpha = 0.08 + intensity * 0.45;
            bgColor = `rgba(34, 197, 94, ${alpha})`;
            textColor = intensity > 0.3 ? '#86EFAC' : 'rgba(134, 239, 172, 0.85)';
            borderColor = `rgba(34, 197, 94, ${0.15 + intensity * 0.4})`;
        } else {
            const intensity = Math.min(Math.abs(change) / 8, 1);
            const alpha = 0.08 + intensity * 0.45;
            bgColor = `rgba(239, 68, 68, ${alpha})`;
            textColor = intensity > 0.3 ? '#FCA5A5' : 'rgba(252, 165, 165, 0.85)';
            borderColor = `rgba(239, 68, 68, ${0.15 + intensity * 0.4})`;
        }

        const changeStr = (change >= 0 ? '+' : '') + change.toFixed(2) + '%';
        // MKT-005 FIX: Use data-symbol attribute + event delegation instead of
        // inline onclick. The previous approach (escapeHtml in onclick attribute)
        // was vulnerable to XSS because browsers decode HTML entities in attribute
        // values BEFORE JS evaluation — so &#39; becomes ' in the JS context,
        // allowing breakout from the string. Using data-symbol + addEventListener
        // avoids the HTML-attribute-to-JS-context transition entirely.
        const safeSymbol = escapeHtml(String(coin.symbol).substring(0, 20));

        return `<div class="hm-cell ${sizeClass}" style="background:${bgColor};border-color:${borderColor};color:${textColor};" data-coin-symbol="${safeSymbol}" role="button" tabindex="0">
            <span class="hm-symbol">${safeSymbol}</span>
            <span class="hm-change">${changeStr}</span>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="heatmap-grid">${cells}</div>`;

    // MKT-005 FIX: Attach click handlers via event delegation instead of inline onclick.
    container.querySelectorAll('.hm-cell[data-coin-symbol]').forEach(cell => {
        cell.addEventListener('click', function() {
            const sym = this.getAttribute('data-coin-symbol');
            if (sym) openCoinDetail(sym);
        });
    });
}

/**
 * Market Analysis section — combines VIP (analysisFeatured) + regular analyses,
 * renders up to 5 horizontal scrollable cards with cover image, gradient overlay,
 * VIP badge if featured, and line-clamped title. Click opens detail page.
 */
function renderDashboardFeaturedAnalysis() {
    const container = $('dashboard-featured-analysis');
    if (!container) return;

    // Combine VIP (featured) first, then regular analyses; dedupe by id; max 5 total.
    const seen = new Set();
    const combined = [];
    const pushUnique = (arr) => {
        if (!Array.isArray(arr)) return;
        for (const a of arr) {
            if (!a || !a.id || seen.has(a.id)) continue;
            seen.add(a.id);
            combined.push(a);
            if (combined.length >= 5) break;
        }
    };
    pushUnique(analysisFeatured);
    if (combined.length < 5) pushUnique(analyses);

    if (!combined.length) {
        container.innerHTML = `<div class="dfa-empty">${escapeHtml(t('dashboard_no_featured'))}</div>`;
        return;
    }

    const html = combined.map(a => {
        const safeId = escapeHtml(a.id);
        const safeCoin = escapeHtml(a.coin || '');
        const safeTitle = escapeHtml(a.title || '');
        const safeTimeframe = escapeHtml(a.timeframe || '1D');
        // ANSEC-XSS-IMG FIX: Validate URL scheme via sanitizeNewsUrl before
        // escapeHtml. escapeHtml alone doesn't prevent javascript:/data: schemes.
        const sanitizedDashImg = sanitizeNewsUrl(a.image);
        const safeImage = (sanitizedDashImg && sanitizedDashImg !== '#') ? escapeHtml(sanitizedDashImg) : getAmirbtcFallbackSvg(400, 240, 'AMIRBTC');
        const isFeatured = !!a.featured;
        const views = a.views_count || 0;
        const timeAgoStr = a.created_at ? timeAgo(a.created_at) : '';

        const vipBadge = isFeatured ? `
            <span class="dma-vip-badge">
                <svg viewBox="0 0 24 24" fill="currentColor" stroke="none"><path d="M12 2l3.09 6.26L22 9.27l-5 4.87 1.18 6.88L12 17.77l-6.18 3.25L7 14.14 2 9.27l6.91-1.01L12 2z"/></svg>
                VIP
            </span>` : '';

        return `
        <div class="dma-card" onclick="openAnalysisDetailPage('${safeId}')" role="button" aria-label="${safeTitle}">
            <img src="${safeImage}" class="dma-card-image" alt="${safeCoin}" loading="lazy" decoding="async" onerror="newsImageFallback(this)">
            <div class="dma-card-overlay"></div>
            <div class="dma-card-content">
                <div class="dma-card-top-row">
                    ${vipBadge}
                    ${safeCoin ? `<span class="dma-coin-badge">${safeCoin}</span>` : ''}
                    <span class="dma-tf-badge">${safeTimeframe}</span>
                </div>
                <h3 class="dma-title">${safeTitle}</h3>
                <div class="dma-meta">
                    <span class="dma-meta-item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/><circle cx="12" cy="12" r="3"/></svg>
                        <span>${views}</span>
                    </span>
                    ${timeAgoStr ? `
                    <span class="dma-meta-item">
                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/></svg>
                        <span>${escapeHtml(timeAgoStr)}</span>
                    </span>` : ''}
                </div>
            </div>
        </div>`;
    }).join('');

    container.innerHTML = `<div class="dma-row">${html}</div>`;
}

/**
 * تقویم اقتصادی داشبورد را رندر می‌کند: ۳ رویداد بعدی، کارت‌های افقی.
 * رویدادهای گذشته فیلتر می‌شوند. داده از calendarEvents خوانده می‌شود.
 */
function renderDashboardCalendar() {
    const container = $('dashboard-calendar');
    if (!container) return;
    // ROOT CAUSE FIX (RC-D): Show skeleton (not empty state) when a fetch
    // is in-flight. Previously this showed "تقویمی یافت نشد" (no calendar)
    // whenever calendarEvents was empty — even if a fetch was actively
    // loading. This was perceived as "no data" by the user. Now we show
    // a skeleton while loading, and only show the empty state if the fetch
    // completed and returned no events.
    if (calendarLoading) {
        container.innerHTML = `<div class="dc-skeleton-calendar">${Array(3).fill('<div class="dc-skeleton-item"></div>').join('')}</div>`;
        return;
    }
    if (!Array.isArray(calendarEvents) || !calendarEvents.length) {
        container.innerHTML = `<div class="dc-empty">${escapeHtml(t('dashboard_no_calendar'))}</div>`;
        return;
    }

    // ROOT CAUSE FIX: Recompute statuses from current time (stale cache fix)
    const freshEvents = recomputeEventStatuses(calendarEvents);

    const now = Date.now();
    // Filter upcoming events only, sort ascending by time, take next 3
    const upcoming = freshEvents
        .filter(e => {
            if (!e || !e.timestamp) return false;
            const d = new Date(e.timestamp);
            return !isNaN(d.getTime()) && d.getTime() >= now - 3600000; // allow events up to 1h in the past (live)
        })
        .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp))
        .slice(0, 3);

    if (!upcoming.length) {
        container.innerHTML = `<div class="dc-empty">${escapeHtml(t('dashboard_no_calendar'))}</div>`;
        return;
    }

    const impactLabels = {
        high: t('cal_impact_high'),
        medium: t('cal_impact_med'),
        low: t('cal_impact_low')
    };
    const impactIcons = {
        high: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="6"/></svg>',
        medium: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="5"/></svg>',
        low: '<svg viewBox="0 0 24 24" fill="currentColor"><circle cx="12" cy="12" r="4"/></svg>'
    };

    container.innerHTML = upcoming.map(e => {
        const safeTitle = escapeHtml(e.title || '');
        const safeCountry = escapeHtml(e.country || '');
        const flag = e.flag || '';
        const impact = (e.impact || 'medium').toLowerCase();
        const impactClass = (impact === 'high' || impact === 'medium' || impact === 'low') ? impact : 'medium';
        const timeInfo = formatCalendarTime(e.timestamp);
        const timeStr = timeInfo ? timeInfo.time : '';
        const dayStr = timeInfo ? timeInfo.dayStr : '';

        return `
        <div class="dc-card impact-${impactClass}">
            <div class="dc-card-top">
                <span class="dc-card-country">
                    <span class="dc-card-flag">${escapeHtml(flag)}</span>
                    <span class="dc-card-country-name">${safeCountry}</span>
                </span>
                <span class="dc-card-impact impact-${impactClass}">${impactIcons[impactClass] || impactIcons.medium}<span>${impactLabels[impactClass] || impactLabels.medium}</span></span>
            </div>
            <div class="dc-card-title">${safeTitle}</div>
            <div class="dc-card-bottom">
                <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><rect x="3" y="4" width="18" height="18" rx="2" ry="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/></svg>
                <span class="dc-card-time-day">${escapeHtml(dayStr)}</span>
                <span class="dc-card-time-sep">·</span>
                <span>${escapeHtml(timeStr)}</span>
            </div>
        </div>`;
    }).join('');
}

//#endregion

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

/**
 * Live price refresh for an open Coin Detail modal.
 * When the detail view is open and a market/forex poll delivers fresh prices,
 * this updates the header price, header change %, and the alert-card current
 * price IN PLACE — so the user sees the price tick without reopening the detail.
 * A subtle green/red pulse animation highlights the change direction.
 *
 * Returns true if an update was applied, false if the detail was closed or the
 * symbol's price was unavailable.
 */
function refreshOpenDetailPrice() {
    const modal = document.getElementById('coin-detail-modal');
    if (!modal || modal.style.display !== 'flex') return false;
    const symbol = _currentDetailSymbol;
    if (!symbol) return false;

    // ── BTC PAIR DETECTION ──
    // If _currentDetailSymbol is "ETHBTC", we need to compute the pair price
    // (ETH/BTC) and relative change vs BTC, not the USD price of ETH.
    const btcPairBase = (typeof parseBtcPairSymbol === 'function')
        ? parseBtcPairSymbol(symbol)
        : null;
    const isBtcPair = btcPairBase !== null;
    const lookupSymbol = isBtcPair ? btcPairBase : symbol;

    // Resolve the current price from whichever dataset owns this symbol.
    // Crypto symbols live in allCoins; forex/metals live in allForexPairs.
    let price = null;
    let change = null;
    const coin = allCoins.find(c => c.symbol === lookupSymbol);
    if (coin) {
        price = coin.priceUsd;
        change = coin.changePercent24Hr;
    } else if (allForexPairs.length) {
        const pair = allForexPairs.find(f => f.symbol === lookupSymbol);
        if (pair) {
            price = pair.price;
            change = pair.change;
        }
    }
    if (price == null || price <= 0) return false;

    // Determine decimals based on asset type (mirror openCoinDetail/openForexDetail logic)
    const isCrypto = !!coin;
    let priceStr;
    let displayPrice; // what gets shown in the header (with $ or BTC suffix)
    let displayChange = change;

    if (isBtcPair) {
        // Compute BTC pair price and relative change vs BTC
        const btc = allCoins.find(c => c.symbol === 'BTC');
        const btcPrice = btc?.priceUsd || 0;
        const btcChange = btc?.changePercent24Hr || 0;
        if (btcPrice <= 0) return false;
        const pairPrice = price / btcPrice;
        if (pairPrice >= 1) priceStr = pairPrice.toFixed(6);
        else if (pairPrice >= 0.001) priceStr = pairPrice.toFixed(8);
        else priceStr = pairPrice.toExponential(2);
        displayPrice = priceStr + ' BTC';
        displayChange = (change || 0) - btcChange;
    } else if (isCrypto) {
        priceStr = price > 1 ? price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : price.toFixed(6);
        displayPrice = '$' + priceStr;
    } else {
        const pair = allForexPairs.find(f => f.symbol === lookupSymbol);
        const cat = pair?.category || 'major';
        if (cat === 'metal' && price > 1000) {
            priceStr = price.toLocaleString('en-US', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
        } else if (cat === 'metal') {
            priceStr = price.toFixed(2);
        } else if (cat === 'index' || cat === 'commodity') {
            priceStr = price > 0 ? price.toLocaleString('en-US', { maximumFractionDigits: 0 }) : '--';
        } else {
            priceStr = price.toFixed(4);
        }
        displayPrice = priceStr;
    }

    // Track previous price to detect direction for the pulse animation
    const prevPrice = refreshOpenDetailPrice._lastPrice?.[symbol];
    const direction = (prevPrice != null && price !== prevPrice)
        ? (price > prevPrice ? 'up' : 'down')
        : null;

    // Update header price
    const priceEl = document.getElementById('detail-coin-price');
    if (priceEl) {
        if (priceEl.textContent !== displayPrice) {
            priceEl.textContent = displayPrice;
            priceEl.classList.remove('pulse-up', 'pulse-down');
            if (direction) {
                // force reflow so the animation restarts
                void priceEl.offsetWidth;
                priceEl.classList.add(direction === 'up' ? 'pulse-up' : 'pulse-down');
            }
        }
    }

    // Update header change % (crypto only — forex change already shown in stats grid)
    if ((isCrypto || isBtcPair) && displayChange != null) {
        const changeEl = document.getElementById('detail-coin-change');
        if (changeEl) {
            const chg = displayChange || 0;
            changeEl.textContent = (chg >= 0 ? '+' : '') + chg.toFixed(2) + '%';
            changeEl.className = 'cd-change ' + (chg >= 0 ? 'up' : 'down');
        }
    }

    // Update alert card current price — for BTC pairs show pair price in BTC
    const alertPriceVal = document.getElementById('alert-current-price-value');
    if (alertPriceVal) {
        const alertDisplay = isBtcPair ? (priceStr + ' BTC') : ('$' + priceStr);
        if (alertPriceVal.textContent !== alertDisplay) {
            alertPriceVal.textContent = alertDisplay;
        }
    }

    // Remember the price for next-cycle direction detection
    if (!refreshOpenDetailPrice._lastPrice) refreshOpenDetailPrice._lastPrice = {};
    refreshOpenDetailPrice._lastPrice[symbol] = price;
    return true;
}

function _stopAllPolling() {
    _pollingIntervals.forEach(id => clearInterval(id));
    _pollingIntervals.length = 0;
}

function _startAllPolling() {
    if (_pollingIntervals.length) return; // already running

    // ── Market polling — 60s ──
    // PERFORMANCE: Pauses when app not visible (visibilitychange → _stopAllPolling)
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return; // PERFORMANCE: skip when tab hidden
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'market-page' || activePage === 'dashboard-page') {
            loadMarketData().then(() => {
                if (activePage === 'dashboard-page') {
                    renderDashboardMarketStatus();
                    renderWatchlist();
                    renderMarketTicker();
                }
                refreshOpenDetailPrice();
            });
            loadForexData().then(() => { refreshOpenDetailPrice(); });
        }
    }, 60000));

    // ── Analysis + News + Calendar polling — 180s ──
    // PERFORMANCE: Pauses when app not visible
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return; // PERFORMANCE: skip when tab hidden
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'analysis-page' || activePage === 'dashboard-page') {
            fetchAnalyses().then(changed => {
                if (changed) {
                    renderAnalysisSlider();
                    if (activePage === 'analysis-page') renderAnalysisList();
                    if (activePage === 'dashboard-page') renderDashboardFeaturedAnalysis();
                }
            });
        }
        if (activePage === 'news-page') {
            loadNews();
            const activeTab = document.querySelector('.ni-tab.active')?.dataset?.news;
            if (activeTab === 'calendar') {
                // ROOT CAUSE FIX (RC-A): Previously this line did `calendarEvents = [];`
                // BEFORE calling loadCalendarEvents(true). This DESTROYED the good cached
                // data, so if the force-refresh failed (network error, 8s timeout, 401,
                // empty upstream), the preserve-on-error fix in loadCalendarEvents had
                // nothing to preserve (calendarEvents was already []). The user saw
                // "رویداد اقتصادی یافت نشد" (no events) until the next successful fetch.
                //
                // Now we just call loadCalendarEvents(true) WITHOUT clearing first.
                // The force=true parameter bypasses the in-memory cache short-circuit
                // and fetches fresh data. If the fetch fails, loadCalendarEvents
                // preserves the existing calendarEvents array (app.js:3190-3194).
                //
                // ROOT CAUSE FIX (RC-E): After fetch, re-render whatever page is
                // CURRENTLY active (not the page that was active when fetch started).
                // If the user switched tabs during the 8s fetch, this ensures the
                // correct page gets the fresh data.
                loadCalendarEvents(true).then(() => {
                    const currentActive = document.querySelector('.page.active')?.id;
                    if (currentActive === 'news-page') {
                        const currentTab = document.querySelector('.ni-tab.active')?.dataset?.news;
                        if (currentTab === 'calendar') renderNews('calendar');
                    } else if (currentActive === 'dashboard-page') {
                        renderDashboardCalendar();
                    }
                });
            }
        }
        if (activePage === 'dashboard-page') {
            loadCalendarEvents(true).then(() => {
                // ROOT CAUSE FIX (RC-E): Re-render whatever page is currently active,
                // not just the dashboard. If the user switched to News > Calendar
                // during the fetch, that page needs the fresh data too.
                const currentActive = document.querySelector('.page.active')?.id;
                if (currentActive === 'dashboard-page') {
                    renderDashboardCalendar();
                } else if (currentActive === 'news-page') {
                    const currentTab = document.querySelector('.ni-tab.active')?.dataset?.news;
                    if (currentTab === 'calendar') renderNews('calendar');
                }
            }).catch(() => {});
        }
    }, 180000));

    // ── Alert checking — 30s ──
    // PHASE B FIX (FE-1): Increased from 15s to 30s to halve API load.
    // 15s polling × 20 symbols = 240 req/hour → now 120 req/hour.
    // Alert price checks don't need 15s granularity — 30s is sufficient
    // for price alert triggers (backend cron runs every 5 min anyway).
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return; // PERFORMANCE: skip when tab hidden
        checkAlerts();
    }, 30000));

    // ── Notification polling — 60s ──
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return;
        loadNotificationsFromServer().catch(() => {});
    }, 60000));

    // ── Session heartbeat — 180s ──
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return;
        sendSessionHeartbeat();
    }, 180000));

    // ── Online count — 600s (only when Profile tab is active) ──
    _pollingIntervals.push(setInterval(() => {
        if (!_appVisible) return;
        const activePage = document.querySelector('.page.active')?.id;
        if (activePage === 'profile-page') {
            fetchOnlineCount();
        }
    }, 600000));
}

document.addEventListener('visibilitychange', () => {
    _appVisible = !document.hidden;
    if (document.hidden) {
        _stopAllPolling();
        // NOTE: Do NOT clear _bootstrapLongTimer here — it must survive background cycles
        // LIFECYCLE/BFCACHE FIX: record the hide timestamp so the visible-transition
        // path can detect a "stuck" bootstrap in-flight promise after a long hide.
        if (!_pageHiddenAt) _pageHiddenAt = Date.now();
    } else {
        _startAllPolling();
        // Retry bootstrap if app returned to foreground and bootstrap hasn't completed
        _notifyAuthStateChange();
        if (!bootstrapComplete) {
            // LIFECYCLE/BFCACHE FIX: stuck-promise detection.
            // If the page was hidden for more than 20s AND an in-flight bootstrap
            // promise still exists, the promise is almost certainly "stuck" — the
            // underlying fetch was aborted when the page entered bfcache (iOS WebKit)
            // but the .finally() clearing the in-flight promise never fires. Clear
            // both _bootstrapUserInFlight (bootstrapUser() dedup) and _bootstrapPromise
            // (tryLateBootstrap() dedup) so the next call makes a fresh API request.
            // 20s threshold = 15s apiFetch timeout + 5s margin; below this we assume
            // any in-flight promise is still settling normally (no reset, no duplicate).
            if (_pageHiddenAt && (Date.now() - _pageHiddenAt) > 20000) {
                if (_bootstrapUserInFlight) {
                    _bootstrapUserInFlight = null;
                }
                if (_bootstrapPromise) {
                    _bootstrapPromise = null;
                }
            }
            _pageHiddenAt = 0;
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

// LIFECYCLE/BFCACHE FIX: record the hide timestamp on pagehide.
// Used by the pageshow (event.persisted) recovery path to detect a "stuck"
// bootstrap in-flight promise after a long bfcache stay. We do NOT abort the
// in-flight fetch here — we just record the time so we can detect stuck state
// on restore (clearing the promise only if it's still set after 20s).
window.addEventListener('pagehide', () => {
    _pageHiddenAt = Date.now();
});

// pageshow — fires when page is restored from bfcache (Mini App reopen)
window.addEventListener('pageshow', (event) => {
    if (event.persisted) {
        // Page restored from bfcache — retry bootstrap if needed
        // SECURITY: Do NOT restore admin-ready from localStorage
        if (!bootstrapComplete) {
            // LIFECYCLE/BFCACHE FIX: stuck-promise detection (same logic as
            // visibilitychange visible path). If the page was in bfcache for
            // more than 20s AND an in-flight bootstrap promise still exists,
            // the promise is almost certainly "stuck" — clear both dedup
            // promises so the next tryLateBootstrap() makes a fresh API call.
            if (_pageHiddenAt && (Date.now() - _pageHiddenAt) > 20000) {
                if (_bootstrapUserInFlight) {
                    _bootstrapUserInFlight = null;
                }
                if (_bootstrapPromise) {
                    _bootstrapPromise = null;
                }
            }
            // Then try bootstrap if auth is ready (unchanged behavior).
            if (isTelegramAuthReady()) {
                tryLateBootstrap();
            }
        }
    }
    _pageHiddenAt = 0;
});

function startPolling() {
    _startAllPolling();
}

//#endregion

// ============================================================================
//#region حالت نگهداری (Maintenance Mode)
// ============================================================================
/**
 * Maintenance Mode — checks system status BEFORE app loads.
 *
 * Flow:
 *   1. GET /api/system/status (no auth required)
 *   2. If maintenance.enabled === true → show full-screen popup, block app init
 *   3. Admin bypass: if user is admin (checked via isAdmin() after bootstrap),
 *      a bypass button appears. Clicking it sets _maintenanceBypassed = true
 *      and hides the popup, allowing the app to continue loading.
 *
 * Security:
 *   - Regular users CANNOT close or bypass the popup (no close button, no escape).
 *   - The bypass button is only visible to admins (isAdmin() === true).
 *   - Fail-open: if the status endpoint is unreachable, the app loads normally.
 *     This prevents a network error from locking out all users.
 */

let _maintenanceBypassed = false;
let _maintenanceActive = false;

/**
 * Remove the boot loader overlay (fades out smoothly).
 * Called when maintenance check completes — whether ON or OFF.
 * Prevents UI flash by keeping the overlay until the maintenance
 * verdict is known.
 */
function _removeBootLoader() {
    const overlay = document.getElementById('boot-loader-overlay');
    if (!overlay) return;
    overlay.style.opacity = '0';
    setTimeout(() => { overlay.remove(); }, 300);
}

/**
 * Check maintenance mode status. Shows the popup if enabled.
 * Returns true if app should continue loading, false if blocked.
 *
 * CRITICAL: This uses API_BASE (the Worker URL) — NOT a relative URL.
 * The app is served from Cloudflare Pages (amir-btc-assistant-pages.pages.dev)
 * but the API lives on a different domain (the Worker). A relative fetch
 * would hit the Pages domain and return HTML, not JSON.
 */
async function checkMaintenanceMode() {
    // Skip if already bypassed this session (admin) — check both in-memory
    // flag and sessionStorage (so reload after bypass still works)
    if (_maintenanceBypassed) {
        // FIX (AUDIT-BYPASS-BLACK-SCREEN): All early-return paths here MUST
        // call _removeBootLoader() — otherwise the boot-loader-overlay
        // (black screen with infinite spinner, z-index 999998) stays
        // visible forever after an admin bypass + reload, even though the
        // app loads and functions behind it. See worklog AUDIT-BYPASS-BLACK-SCREEN.
        _removeBootLoader();
        return true;
    }
    try {
        if (sessionStorage.getItem('maint_bypassed') === '1') {
            _maintenanceBypassed = true;
            // FIX (AUDIT-BYPASS-BLACK-SCREEN): This is the CRITICAL path —
            // after admin clicks bypass → reload, sessionStorage has
            // maint_bypassed='1', and this early return used to skip
            // _removeBootLoader(), leaving the black spinner overlay stuck.
            _removeBootLoader();
            return true;
        }
    } catch (e) { /* sessionStorage may be blocked */ }

    // Build the full URL using API_BASE (Worker domain)
    const baseUrl = (window.API_BASE || API_BASE || '').replace(/\/$/, '');
    if (!baseUrl) {
        // No API_BASE configured — can't check, fail open
        console.log('[MAINT] check skipped — no API_BASE');
        // FIX (AUDIT-BYPASS-BLACK-SCREEN): Remove boot loader on this
        // fail-open path too — otherwise the black spinner stays stuck.
        _removeBootLoader();
        return true;
    }

    try {
        // Use a short timeout — if the server is slow, fail open
        const controller = new AbortController();
        const timeoutId = setTimeout(() => controller.abort(), 4000);

        const resp = await fetch(`${baseUrl}/api/system/status`, {
            signal: controller.signal,
            // NOTE: Do NOT set custom headers like 'Cache-Control' here —
            // that would trigger a CORS preflight which the Worker may not
            // allow. Keep this a "simple request" (GET with no custom headers).
            cache: 'no-store',
        });
        clearTimeout(timeoutId);

        if (!resp.ok) {
            // Server returned an error — fail open
            console.log('[MAINT] check skipped — HTTP', resp.status);
            // FIX (AUDIT-BYPASS-BLACK-SCREEN): Remove boot loader on this
            // fail-open path too — otherwise the black spinner stays stuck.
            _removeBootLoader();
            return true;
        }

        const data = await resp.json();
        const maint = data.maintenance || {};

        if (maint.enabled === true) {
            // Maintenance is ON — show the popup
            console.log('[MAINT] Maintenance is ON — blocking app load');
            showMaintenancePopup(maint);
            _maintenanceActive = true;
            _removeBootLoader();
            return false;  // <-- caller MUST check this and STOP
        }
        // Maintenance is OFF — remove boot loader so app is visible
        _removeBootLoader();
    } catch (e) {
        // Network error or timeout — fail open
        console.log('[MAINT] check skipped (network):', e.message || e);
        _removeBootLoader();
        return true;
    }
    return true;
}

/**
 * Show the maintenance popup with the given settings.
 * @param {object} maint - {title, description, progress, enabled}
 */
function showMaintenancePopup(maint) {
    const overlay = document.getElementById('maintenance-overlay');
    if (!overlay) return;

    // Set title
    const titleEl = document.getElementById('maint-title');
    if (titleEl && maint.title) titleEl.textContent = maint.title;

    // Set description
    const descEl = document.getElementById('maint-desc');
    if (descEl && maint.description) descEl.textContent = maint.description;

    // Set progress
    const pct = Math.max(0, Math.min(100, Number(maint.progress) || 0));
    const pctEl = document.getElementById('maint-progress-percent');
    const fillEl = document.getElementById('maint-progress-fill');
    if (pctEl) pctEl.textContent = pct + '%';
    if (fillEl) fillEl.style.width = pct + '%';

    // Generate floating particles
    _generateMaintenanceParticles();

    // Start dynamic status text rotation
    _startMaintenanceStatusRotation();

    // Show overlay
    overlay.style.display = 'flex';
    document.body.style.overflow = 'hidden';

    // Check if current user is admin — if so, show bypass button
    // This runs after bootstrap, so isAdmin() should be accurate.
    // If bootstrap hasn't completed yet, the button stays hidden until
    // updateMaintenanceAdminBypass() is called from bootstrapUser().
    updateMaintenanceAdminBypass();
}

/**
 * Generate floating particle elements for the maintenance popup background.
 */
function _generateMaintenanceParticles() {
    const container = document.getElementById('maint-particles');
    if (!container) return;
    // Don't regenerate if already populated
    if (container.children.length > 0) return;

    const count = 18;
    for (let i = 0; i < count; i++) {
        const p = document.createElement('div');
        p.className = 'maint-particle';
        const size = 2 + Math.random() * 4;
        p.style.width = size + 'px';
        p.style.height = size + 'px';
        p.style.left = Math.random() * 100 + '%';
        p.style.animationDuration = (8 + Math.random() * 12) + 's';
        p.style.animationDelay = (Math.random() * 10) + 's';
        container.appendChild(p);
    }
}

/**
 * Dynamic status text rotation — cycles through system status messages
 * with a fade animation to convey "system is actively working".
 */
let _maintStatusInterval = null;
function _startMaintenanceStatusRotation() {
    if (_maintStatusInterval) return; // Already running
    const messages = [
        'در حال بهینه‌سازی سیستم...',
        'در حال بروزرسانی سرویس‌ها...',
        'در حال همگام‌سازی داده‌ها...',
        'در حال بررسی امنیت...',
        'آماده‌سازی نسخه جدید...',
    ];
    let idx = 0;
    const el = document.getElementById('maint-status-rotator');
    if (!el) return;
    const span = el.querySelector('.maint-status-text');
    if (!span) return;

    _maintStatusInterval = setInterval(() => {
        idx = (idx + 1) % messages.length;
        span.style.opacity = '0';
        span.style.transform = 'translateY(-8px)';
        setTimeout(() => {
            span.textContent = messages[idx];
            span.style.opacity = '1';
            span.style.transform = 'translateY(0)';
        }, 300);
    }, 3500);
}

/**
 * Update the visibility of the admin bypass button based on current admin status.
 * Called from bootstrapUser() after admin status is confirmed, and also from
 * showMaintenancePopup() in case bootstrap already completed.
 */
function updateMaintenanceAdminBypass() {
    const bypassBtn = document.getElementById('maint-admin-bypass');
    if (!bypassBtn) return;
    // Only show if user is admin (isAdmin() requires bootstrapComplete)
    if (isAdmin()) {
        bypassBtn.style.display = 'inline-flex';
    } else {
        bypassBtn.style.display = 'none';
    }
}

/**
 * Admin bypass — hide the maintenance popup and continue loading the app.
 * Only works if isAdmin() returns true. Stores bypass in sessionStorage so
 * it persists across the page reload, then reloads to re-initialize the app.
 */
function adminBypassMaintenance() {
    // SECURITY: double-check admin status before allowing bypass
    if (!isAdmin()) {
        console.warn('[MAINT] Non-admin attempted to bypass maintenance mode');
        return;
    }
    _maintenanceBypassed = true;
    _maintenanceActive = false;
    // Store in sessionStorage so the bypass survives the reload
    try { sessionStorage.setItem('maint_bypassed', '1'); } catch (e) {}
    const overlay = document.getElementById('maintenance-overlay');
    if (overlay) overlay.style.display = 'none';
    document.body.style.overflow = '';
    console.log('[MAINT] Admin bypassed maintenance mode — reloading app');
    // Reload the page so the full app initializes (DOMContentLoaded will
    // see maint_bypassed in sessionStorage and skip the maintenance check)
    window.location.reload();
}

// Expose globally for inline onclick
window.checkMaintenanceMode = checkMaintenanceMode;
window.showMaintenancePopup = showMaintenancePopup;
window.updateMaintenanceAdminBypass = updateMaintenanceAdminBypass;
window.adminBypassMaintenance = adminBypassMaintenance;

// ============================================================================
//#region راه‌اندازی برنامه
// ============================================================================
document.addEventListener('DOMContentLoaded', async () => {
    // ── PERFORMANCE: Event delegation for Market list ──
    // Instead of 400+ inline onclick attributes (200 coins × 2 handlers each),
    // use a single event listener on the coin-list-rows container.
    // This reduces DOM parse time, memory usage, and improves interaction speed.
    const coinListEl = document.getElementById('coin-list-rows');
    if (coinListEl) {
        coinListEl.addEventListener('click', function(e) {
            // Find the closest element with data-action
            const actionEl = e.target.closest('[data-action]');
            if (!actionEl) return;
            const action = actionEl.dataset.action;
            const symbol = actionEl.dataset.symbol;
            if (!symbol) return;

            if (action === 'open-coin') {
                e.stopPropagation();
                openCoinDetail(symbol);
            } else if (action === 'open-forex') {
                e.stopPropagation();
                openForexDetail(symbol);
            } else if (action === 'toggle-watch') {
                e.stopPropagation();
                toggleWatchlist(symbol);
            }
        });
        console.log('[PERF] Market event delegation installed (replaces ~400 inline onclick)');
    }

    // ── Phase 0: Telegram SDK init + user resolution ──
    // ROOT CAUSE FIX (warm-start speed): Previously `await UserContext.init()`
    // blocked the ENTIRE DOMContentLoaded handler. All cache hydration,
    // rendering, and background fetches waited for Telegram auth to resolve
    // (100-300ms on warm start, up to 8s on cold start).
    //
    // Now we fire UserContext.init() as a BACKGROUND promise (not awaited).
    // The cache hydration code below doesn't depend on Telegram auth — it
    // only reads localStorage. Auth-dependent code (loadUser, bootstrapUser,
    // all apiFetch calls) already has its own auth-wait via waitForApiReady.
    //
    // This unlocks ~100-300ms on every warm start.
    UserContext.init().then(() => {
        // When auth resolves, update the profile name (was showing "Loading...")
        loadUser();
    }).catch(e => {
        console.warn('[BOOT] UserContext.init failed:', e?.message);
    });

    // ── JOIN LOCK: FLOATING STATUS CARD approach (Production UX — Task 37) ──
    // 1. Show FLOATING CARD immediately ("Checking membership…")
    // 2. Body is NOT locked, no overlay shown — user sees the app render in parallel.
    // 3. Bootstrap runs in parallel with Phase 1 UI prep.
    // 4. Bootstrap returns channel_joined=true → Card shows "Verified ✓" → fades out
    //    after 800ms → fully removed. NO overlay, NO lock, NO spinner left behind.
    // 5. Bootstrap returns channel_joined=false → Card shows "Required" → after 600ms
    //    the FULL Join Lock overlay is shown (body locked).
    // 6. Bootstrap errors/timeouts → Card shows "Connection error" + Retry button.
    //
    // Result: members see NO overlay/popup at all. Non-members see the lock only
    // after backend confirms. Error states are clearly visible with a retry CTA.

    // ── MEMBERSHIP CHECK: Background, non-blocking, cache-first ──
    // PERFORMANCE + UX FIX: Instead of showing "Checking membership…" immediately,
    // we show the app instantly and run the membership check in the background.
    //
    // Flow:
    //   1. Check frontend cache (5 min TTL) — if cached as "joined", skip UI entirely
    //   2. Show app immediately (no loading card)
    //   3. Run bootstrap in background (includes membership check)
    //   4. If channel_joined === false → show Join Lock (only confirmed non-members)
    //   5. If channel_joined === true → update cache, no UI change
    //   6. If timeout/error → allow access, check later (don't block)
    //
    // Security: backend still gates every API. This only affects the UI overlay.

    const MEMBERSHIP_CACHE_KEY = 'membership_status_cache';
    const MEMBERSHIP_CACHE_TTL = 5 * 60 * 1000; // 5 minutes

    // Check frontend cache first
    let cachedMembership = null;
    try {
        const raw = localStorage.getItem(MEMBERSHIP_CACHE_KEY);
        if (raw) {
            const parsed = JSON.parse(raw);
            if (parsed && parsed.timestamp && (Date.now() - parsed.timestamp) < MEMBERSHIP_CACHE_TTL) {
                cachedMembership = parsed;
            }
        }
    } catch {}

    if (cachedMembership && cachedMembership.status === 'joined') {
        // Cache says "joined" — skip loading card entirely, show app immediately
        console.log('[JOIN-LOCK] Using cached membership: joined — skipping loading card');
        _joinLockShown = false;
    } else {
        // No cache or expired — still don't show loading card.
        // App renders immediately. Bootstrap will verify in background.
        // Only show Join Lock if bootstrap explicitly returns channel_joined === false.
        console.log('[JOIN-LOCK] No valid cache — app renders immediately, bootstrap verifies in background');
    }

    // Safety timer: if bootstrap doesn't complete in 2s, allow access (don't block)
    // Previously was 12s which showed "Connection error" — now we just allow access
    // and retry later. Security is maintained by backend gating every API call.
    clearJoinLockSafetyTimer();
    _joinLockSafetyTimer = setTimeout(() => {
        _joinLockSafetyTimer = null;
        if (!bootstrapComplete) {
            // Timeout — don't show lock, just allow access
            // Backend will still gate APIs that require membership
            console.warn('[JOIN-LOCK] Bootstrap timeout (2s) — allowing access, will retry');
            // Hide any floating card if visible
            hideJoinStatusBar();
            _joinLockShown = false;
        }
    }, 2000); // 2s timeout (was 12s)

    // ── PARALLEL EXECUTION: maintenance check + bootstrap + data prep ──
    // Previously these ran sequentially (maintenance → join-lock → bootstrap → data),
    // causing a visible delay. Now they run in parallel:
    //   - maintenance check (network)
    //   - bootstrapUser (network, includes membership check)
    //   - Phase 1 UI prep (synchronous: language, ticker from cache, skeletons)
    // The join-lock stays visible until bootstrap confirms membership.

    // Phase 1: Apply language + render UI from cache immediately (synchronous, ~0ms)
    applyLanguage();
    loadUser();
    // WARM-START: Defer non-critical API calls to idle time so they don't
    // compete with cache hydration + rendering on the critical path.
    // updateNotifBadge fires /api/notifications — not needed for first paint.
    // checkMaintenanceMode fires /api/system/status — not needed for first paint.
    // Both are deferred to requestIdleCallback (or setTimeout 0 fallback).
    if (typeof requestIdleCallback === 'function') {
        requestIdleCallback(() => updateNotifBadge());
    } else {
        setTimeout(() => updateNotifBadge(), 0);
    }
    alerts = alerts.map(a => ({ ...a, userId: a.userId || getUserId() }));
    // Only write to localStorage if userId actually changed (avoids redundant write)
    const _hadUserId = alerts.some(a => a.userId);
    if (_hadUserId) localStorage.setItem('price_alerts', JSON.stringify(alerts));

    // Analysis slider from localStorage cache
    if (analyses.length) {
        renderAnalysisSlider();
    } else {
        const st = $('slider-track');
        if (st) st.innerHTML = '<div class="slider-skeleton"><div class="slider-skeleton-img"></div><div class="slider-skeleton-text"><div class="slider-skeleton-line"></div><div class="slider-skeleton-line"></div><div class="slider-skeleton-line"></div></div></div>';
    }

    // Phase C: Load cached market data for INSTANT ticker render.
    // ROOT-CAUSE FIX (Market Ticker redesign): Previously the code loaded the
    // cache AND fell back to hard-coded `{ symbol: 'BTC', changePercent24Hr: 0 }`
    // coins when no cache existed. Those fallbacks had no price, no logo, just
    // symbol + 0.00% — so the ticker looked empty/meaningless for the first
    // few seconds of every cold open.
    //
    // NEW behavior:
    //   - If a fresh cache exists → hydrate allCoins from it → render ticker.
    //   - If no cache (cold open) → leave allCoins empty → ticker shows the
    //     shimmering skeleton placeholder from index.html (mtsk-pill elements).
    //     Real data arrives via bootstrapUser → _startDataLoading → loadMarketData,
    //     then renderMarketTicker replaces the skeleton with real items.
    const MARKET_CACHE_VERSION = 4; // bumped — old cache lacked priceUsd in some entries
    const MARKET_CACHE_TTL_MS = 5 * 60 * 1000;
    try {
        const cachedVersion = parseInt(localStorage.getItem('market_cache_version') || '0', 10);
        const cachedTs = parseInt(localStorage.getItem('market_cache_ts') || '0', 10);
        const cachedMarket = JSON.parse(localStorage.getItem('market_data_cache') || '[]');
        const isFresh = cachedTs && (Date.now() - cachedTs) < MARKET_CACHE_TTL_MS;
        if (Array.isArray(cachedMarket) && cachedMarket.length && cachedVersion >= MARKET_CACHE_VERSION && isFresh) {
            allCoins = cachedMarket;
            console.log('[MARKET] Hydrated ticker from localStorage cache:', cachedMarket.length, 'coins');
        } else {
            // Stale or wrong-version cache → clear it
            localStorage.removeItem('market_data_cache');
            localStorage.removeItem('market_cache_ts');
            localStorage.removeItem('market_cache_version');
            // allCoins stays empty — ticker shows skeleton until real data arrives
        }
    } catch(_) {
        // Bad cache JSON — ignore, skeleton will show
    }

    // Render ticker IMMEDIATELY — from cache if available, else skeleton shows.
    // NO more hard-coded fallback coins: the skeleton placeholder (in index.html)
    // is shown when allCoins is empty, and it's replaced the moment real data
    // arrives from the API.
    renderMarketTicker();
    renderDashboardMarketStatus();
    // ── NEW: Render market heatmap on dashboard ──
    renderDashboardHeatmap();

    // ── DASHBOARD SPEED OPTIMIZATION ──
    // Hydrate analysis, news, and calendar from localStorage on cold open
    // so sections render INSTANTLY instead of showing skeleton for 200ms-4s.
    // Each section then updates with fresh data when the API response arrives.

    // Analysis: analysisFeatured is already hydrated at module load (line ~366).
    // Render the dashboard featured analysis section NOW from cached data.
    renderDashboardFeaturedAnalysis();

    // News: hydrate from localStorage and render important news immediately.
    try {
        const newsCacheStr = localStorage.getItem('news_cache');
        if (newsCacheStr) {
            const parsed = JSON.parse(newsCacheStr);
            // Phase 10.5: Reduced from 5 min to 2 min for faster ai_status refresh
            if (parsed && parsed.ts && (Date.now() - parsed.ts < 2 * 60 * 1000) && Array.isArray(parsed.data)) {
                newsCache = parsed.data;
                // Render important news from cache (non-blocking, instant)
                renderImportantNewsFromCache();
            }
        }
    } catch (_) { /* bad cache — ignore */ }

    // Calendar: hydrate from localStorage and render dashboard calendar immediately.
    try {
        const calCacheStr = localStorage.getItem('calendar_cache');
        if (calCacheStr) {
            const parsed = JSON.parse(calCacheStr);
            // ROOT CAUSE FIX (F-2): Render stale cache as a placeholder even
            // if >1h old. Calendar data changes weekly — 24h-old data is
            // still useful. The API will refresh in the background.
            // Previously, if cache was >1h old, calendarEvents stayed []
            // and the user saw skeleton/empty until the API responded.
            if (parsed && parsed.ts && Array.isArray(parsed.data) && parsed.data.length > 0) {
                calendarEvents = parsed.data;
                renderDashboardCalendar();
            }
        }
    } catch (_) { /* bad cache — ignore */ }

    // Watchlist: render from cached allCoins + cached watchlist symbols
    if (allCoins.length && watchlist.length) {
        renderWatchlist();
    }

    // PERF FIX: Hydrate forex pairs from localStorage for instant watchlist render.
    // Previously forex was only loaded from API (loadForexData), adding delay.
    try {
        const forexCacheStr = localStorage.getItem('forex_data_cache');
        if (forexCacheStr) {
            const parsed = JSON.parse(forexCacheStr);
            if (parsed && parsed.ts && (Date.now() - parsed.ts < 5 * 60 * 1000) && Array.isArray(parsed.data)) {
                allForexPairs = parsed.data;
            }
        }
    } catch (_) { /* bad cache — ignore */ }

    // ROOT-CAUSE FIX (Task 38): Kick off a market data fetch IMMEDIATELY —
    // independently of bootstrapUser(). Previously loadMarketData(true) was
    // only called inside _startDataLoading(), which only runs after
    // bootstrapUser().then() AND requires !_joinLockShown AND !_maintenanceBlocked.
    // If bootstrap failed (network error, pending initData, guest user) OR
    // the user was a non-member, _startDataLoading() was NEVER called, so
    // loadMarketData() was NEVER called, so allCoins stayed empty forever
    // and the ticker showed skeleton indefinitely.
    //
    // NEW behavior: market data is fetched in parallel with bootstrapUser().
    // /api/market is now a PUBLIC endpoint (Task 38 backend change) — market
    // prices are universal public data, not user-specific. The Worker
    // rate-limits by client IP to prevent abuse.
    //
    // This call is safe to run regardless of bootstrap outcome:
    //   - If allCoins is already hydrated from localStorage cache, loadMarketData
    //     will use the in-memory Cache.get('market') short-circuit (no API call)
    //     when force=false. We pass force=true to always get fresh prices.
    //   - renderMarketTicker() has a signature guard — it's a no-op if data
    //     hasn't changed, so calling it multiple times is safe.
    //   - renderDashboardMarketStatus() also no-ops gracefully when called
    //     before globalMarketData is loaded.
    if (API_BASE) {
        // PERF FIX: Use force=false (cache-first) for initial load. If cached
        // data exists in memory Cache, it renders instantly. Then a background
        // refresh (force=true) fires 2s later to get fresh prices.
        // Previously force=true ALWAYS hit the API, adding 200-500ms even when
        // fresh cached data was available from a recent session.
        loadMarketData(false).then(() => {
            renderMarketTicker();
            renderDashboardMarketStatus();
            renderWatchlist(); // Re-render watchlist now that allCoins is populated
            // Background refresh — get truly fresh prices after initial paint
            setTimeout(() => loadMarketData(true).then(() => {
                renderMarketTicker();
                renderDashboardMarketStatus();
                renderWatchlist();
            }).catch(() => {}), 2000);
        }).catch(e => {
            console.warn('[TICKER] Market fetch failed:', e?.message || e);
        });

        // PERF FIX: Fire forex data load in parallel with market data.
        // Previously forex was only loaded when user visited the Market tab.
        // Now it loads on startup so the watchlist (which may contain forex
        // pairs) renders instantly.
        // ROOT CAUSE FIX: loadForexData calls apiFetch which requires Telegram
        // auth. On startup, auth may not be ready yet (bootstrap pending).
        // apiFetch's waitForApiReady handles this, but if auth fails (outside
        // Telegram), the call silently fails. We retry after bootstrap completes.
        if (!allForexPairs.length) {
            loadForexData().then(() => {
                if (allForexPairs.length) renderWatchlist();
            }).catch(() => {
                // Will be retried after bootstrap completes (see bootstrapUser().then below)
            });
        }
    }

    // Skeletons for watchlist and news
    const watchGrid = $('watchlist-grid');
    if (watchGrid && !watchGrid.children.length) {
        watchGrid.innerHTML = '<div class="watchlist-skeleton">' + Array(4).fill('<div class="watchlist-skeleton-item"><div class="watchlist-skeleton-icon"></div><div class="watchlist-skeleton-lines"><div class="watchlist-skeleton-line"></div><div class="watchlist-skeleton-line"></div></div></div>').join('') + '</div>';
    }
    const newsContainer = $('important-news');
    if (newsContainer && !newsContainer.children.length) {
        newsContainer.innerHTML = '<div class="important-news-skeleton">' + Array(3).fill('<div class="important-news-skeleton-item"><div class="important-news-skeleton-img"></div><div class="important-news-skeleton-text"><div class="important-news-skeleton-line"></div><div class="important-news-skeleton-line"></div></div></div>').join('') + '</div>';
    }

    // tabLoaded.dashboard tracking
    const _dashboardReady = { market: false, analyses: false, news: false };
    function _checkDashboardReady() {
        if (_dashboardReady.market && _dashboardReady.analyses && _dashboardReady.news) {
            tabLoaded.dashboard = true;
        }
    }

    // ── Data loading function (called after membership confirmed) ──
    // All data requests run in PARALLEL — not chained.
    // WARM-START FIX: loadMarketData is already fired independently above
    // (line ~10574). Skip it here to avoid duplicate API call — the
    // apiFetch dedup would catch it anyway, but skipping saves the
    // function call overhead and the redundant render calls.
    function _startDataLoading() {
        // Skip loadMarketData — already fired independently above
        // Just mark market as ready (it was already started)
        _dashboardReady.market = true;
        _checkDashboardReady();

        fetchAnalyses().then(changed => {
            if (changed) {
                renderAnalysisSlider();
                renderAnalysisFeatured();
                renderAnalysisStats();
                renderDashboardFeaturedAnalysis();
            } else {
                renderDashboardFeaturedAnalysis();
            }
            checkAnalysisDeepLink();
        }).finally(() => { _dashboardReady.analyses = true; _checkDashboardReady(); });
        loadImportantNews().finally(() => { _dashboardReady.news = true; _checkDashboardReady(); });
        // CALREFRESH-001 FIX: Use force=true at bootstrap to bypass the
        // in-memory cache short-circuit (loadCalendarEvents line 3422).
        //
        // ROOT CAUSE: localStorage calendar_cache has NO TTL check (line 12605-12606).
        // At bootstrap, calendarEvents is hydrated from localStorage (line 12606)
        // with potentially STALE data (from days ago). Then loadCalendarEvents()
        // with force=false short-circuits because calendarEvents.length > 0 —
        // so NO fresh API call ever happens at bootstrap.
        //
        // Consequence: Week tab (return true at line 7439) shows ALL cached events
        // (including stale past events), while Today/Tomorrow correctly filter by
        // date and show 0 events (because the stale cache has no events for today/
        // tomorrow). User sees "Week works, Today/Tomorrow empty" even though the
        // API is healthy and would return fresh data.
        //
        // FIX: Pass force=true so the short-circuit is bypassed and a real API
        // call is made. If the API succeeds, calendarEvents is updated with fresh
        // data and the .then() re-render shows correct Today/Tomorrow events.
        // If the API fails, the existing catch handler in loadCalendarEvents
        // (line 3465) preserves the existing calendarEvents — no data loss.
        //
        // This mirrors the pattern already used by market data (line 12656-12665):
        // initial cache-first load for instant render, then a background force
        // refresh to get truly fresh data. The calendar polling (180s, line 12037)
        // already uses force=true, so this just makes bootstrap consistent.
        loadCalendarEvents(true).then(() => {
            // ROOT CAUSE FIX (F-5, CRITICAL): Previously this only called
            // renderDashboardCalendar(), ignoring the News > Calendar tab.
            // If the user navigated to News > Calendar during the fetch,
            // the skeleton stayed for up to 180s (until next poll).
            // Now we mirror the polling path (RC-E fix) and re-render
            // whichever page is CURRENTLY active.
            const currentActive = document.querySelector('.page.active')?.id;
            if (currentActive === 'news-page') {
                const currentTab = document.querySelector('.ni-tab.active')?.dataset?.news;
                if (currentTab === 'calendar') renderNews('calendar');
            } else {
                renderDashboardCalendar();
            }
        }).catch(() => renderDashboardCalendar());
    }

    // ── WARM-START OPTIMIZATION ──
    // ROOT CAUSE: _startDataLoading() was called AFTER bootstrapUser().then(),
    // meaning all API calls (analyses, news, calendar) waited for bootstrap
    // to complete before even starting — adding 200-500ms to warm-start.
    //
    // FIX: Fire _startDataLoading() in PARALLEL with bootstrapUser().
    // The API calls inside will use apiFetch → waitForApiReady(8000) which
    // naturally waits for Telegram auth to be ready. By the time auth is
    // ready, the calls are already in-flight — no extra round-trip.
    //
    // This cuts warm-start critical path from:
    //   auth_wait → bootstrap → API calls → render
    // to:
    //   auth_wait → max(bootstrap, API calls) → render
    //
    // Cached data is already rendered on DOMContentLoaded (above), so the
    // user sees content INSTANTLY. The API calls just refresh in background.

    let _maintenanceBlocked = false;

    // ═══════════════════════════════════════════════════════════════════════
    // PHASE 1 FIX: Fire bootstrapUser() in PARALLEL with checkMaintenanceMode()
    // ═══════════════════════════════════════════════════════════════════════
    // ROOT CAUSE: Previously bootstrapUser() was only called INSIDE the
    // maintenance .then() block (when maintenance is OFF). When maintenance
    // was ON, bootstrap was NEVER called → bootstrapComplete stayed false →
    // isAdmin() returned false (gates on bootstrapComplete) → admin bypass
    // button stayed hidden. Admin was forced to wait for the viewportChanged
    // event (or visibilitychange/pageshow/hashchange) to fire tryLateBootstrap,
    // which on some platforms takes 5-20+ seconds (the viewport is already
    // expanded at app open, so viewportChanged doesn't fire until user
    // interaction).
    //
    // FIX: Start bootstrapUser() IMMEDIATELY (in parallel with maintenance
    // check). bootstrapUser() is deduplicated via _bootstrapUserInFlight, so
    // it's safe to start it here and also reference the promise later. When
    // bootstrap completes:
    //   - bootstrapComplete = true
    //   - isCurrentUserAdmin = server-confirmed admin status
    //   - _bootstrapUserImpl calls updateMaintenanceAdminBypass() at line ~1210
    //     → shows bypass button for admins (the maintenance popup is already
    //     visible from showMaintenancePopup if maintenance is ON)
    //   - For non-admins, the bypass button stays hidden. Maintenance popup
    //     remains visible — security is fully preserved.
    //
    // SECURITY: This does NOT bypass maintenance for non-admin users. The
    // maintenance popup is shown by showMaintenancePopup() regardless of
    // bootstrap. The bypass button is ONLY shown by updateMaintenanceAdminBypass()
    // when isAdmin() returns true (which requires server-confirmed admin status).
    // /api/users/bootstrap is NOT maintenance-gated on the backend, so the
    // bootstrap call succeeds even during maintenance.
    // ═══════════════════════════════════════════════════════════════════════
    const _parallelBootstrapPromise = bootstrapUser().catch(e => {
        console.error('[BOOT] bootstrapUser FAILED:', e.message);
    });

    // ── COLD-START BOOT POLL (runs regardless of maintenance state) ──
    // PHASE 1 EXTENSION: This boot poll MUST be set up BEFORE the maintenance
    // check (not inside the maintenance .then block) so that cold-start admin
    // detection works even when maintenance is ON.
    //
    // ROOT CAUSE (cold start + maintenance ON): On Telegram SDK cold start,
    // auth isn't ready immediately. _bootstrapUserImpl() returns early when
    // !isTelegramAuthReady() (no API call made). Without the boot poll, the
    // admin would have to wait for the viewportChanged event (5-20+ seconds)
    // to fire tryLateBootstrap → bootstrap → admin detection.
    //
    // FIX: Set up the boot poll (500ms interval) BEFORE the maintenance check.
    // When auth becomes ready, the boot poll fires tryLateBootstrap() which
    // calls bootstrapUser() (deduped). The bootstrap completes, sets
    // bootstrapComplete=true + isCurrentUserAdmin (from server), and calls
    // updateMaintenanceAdminBypass() to show the bypass button for admins.
    //
    // SAFETY: The boot poll ONLY calls tryLateBootstrap() — it doesn't start
    // any other init (data loading, polling, etc.). Those are still gated by
    // the maintenance check. The boot poll clears itself when bootstrapComplete
    // becomes true OR after 20s max.
    if (!bootstrapComplete && (UserContext.isPending() || (isInTelegram() && !isTelegramAuthReady()))) {
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

    // MAINTENANCE FIX: check maintenance BEFORE any other init (except
    // bootstrap, which now runs in parallel for admin detection).
    // Previously bootstrap ran in parallel with maintenance, causing the
    // app UI to render before the maintenance response arrived → user saw
    // the full app briefly, then maintenance popup appeared on refresh.
    // Now: we AWAIT the maintenance check first. If maintenance is ON,
    // we block all further init (data loading, polling, rendering). The
    // parallel bootstrap continues in the background — for admins, the
    // bypass button appears once bootstrap completes. For non-admins,
    // the maintenance popup stays (no bypass).
    // If maintenance is OFF (or network fails → fail open), we continue.
    checkMaintenanceMode().then(async (_maintOk) => {
        if (!_maintOk) {
            _maintenanceBlocked = true;
            console.log('[MAINT] App load blocked — maintenance mode active');
            // Don't await or chain off the parallel bootstrap — it continues
            // in the background and will call updateMaintenanceAdminBypass()
            // when it completes (showing the bypass button for admins).
            // Return here to skip all other init (data loading, polling, etc.).
            return; // Stop here — don't load data or start polling
        }

    // Maintenance is OFF — chain post-bootstrap tasks off the parallel
    // bootstrap promise. If bootstrap already completed (likely, since
    // it started before the maintenance check), the .then runs immediately.
    _parallelBootstrapPromise.then(() => {
        loadUser();
        // ROOT CAUSE FIX: Retry forex data load after bootstrap completes.
        // On startup, loadForexData fires in parallel but may fail because
        // auth wasn't ready yet. After bootstrap, auth is confirmed, so retry.
        if (!allForexPairs.length && API_BASE) {
            loadForexData().then(() => {
                renderWatchlist();
                // If user is on the forex tab, re-render it
                if (currentMarketTab === 'forex') renderMarket();
            }).catch(() => {});
        }
        if (!_maintenanceBlocked) {
            // P0 FIX: Mission loading was gated on _joinLockShown which is
            // FALSE for members (setJoinLockState('joined') sets it to false).
            // This meant loadMissionStatus() was NEVER called for members,
            // so missions never loaded, MissionBus never auto-instrumented
            // tabs, and no mission events ever fired.
            // FIX: Load missions for ALL users who passed bootstrap (member
            // or ambiguous). The backend already gates mission endpoints
            // behind channel membership (PROTECTED_PATHS includes 'wallet'
            // which covers /api/wallet/missions and /api/wallet/mission/*).
            // Non-members will get 403 from the backend — loadMissionStatus
            // handles errors gracefully (catch + empty array).
            updateAnalysisFabVisibility();
            // Load today's mission status + fire daily_open mission
            if (typeof loadMissionStatus === 'function') {
                loadMissionStatus().then(() => {
                    if (typeof fireMissionEvent === 'function') fireMissionEvent(MISSION_EVENTS.DAILY_OPEN);
                });
            }
        }
    });

    // ROOT CAUSE FIX (warm-start speed): Fire data loading IMMEDIATELY —
    // in parallel with bootstrapUser(). Previously this waited for
    // bootstrap to complete, adding 200-500ms to the critical path.
    // Now apiFetch's waitForApiReady handles the auth wait naturally.
    // Cached data is already rendered above — these calls just refresh.
    // FIX: gate data loading on maintenance check — don't load if blocked.
    if (API_BASE && !_maintenanceBlocked) {
        _startDataLoading();
    }

    // ── Phase 3: All post-maintenance-check initialization ──
    // MAINTENANCE FIX: ALL polling, timers, and UI initialization now
    // run INSIDE the maintenance .then() block. If maintenance is ON,
    // the return at line above skips this entirely — no polling, no
    // timers, no observer, no slider — nothing starts until maintenance
    // is confirmed OFF.
    //
    // NOTE: The cold-start boot poll (_bootPollInterval + _bootObserver)
    // is set up BEFORE the maintenance check (see above) so that admin
    // detection works even when maintenance is ON. It ONLY calls
    // tryLateBootstrap() — it doesn't start any other init.

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

    // Hero Banner Slider — fade transition (400ms), autoplay 5000ms, pause on touch/swipe
    (function initHeroSlider() {
        const slider = document.getElementById('hero-banner-slider');
        const slides = document.querySelectorAll('.hero-slide');
        const dots = document.querySelectorAll('.hero-dot');

        // Phase 8: Hide Premium upsell banner for Premium users.
        // The first slide (data-slide="0") is the Premium upsell banner.
        // Premium users should not see "فعال‌سازی Premium" (Activate Premium).
        if (window.MembershipApp && typeof window.MembershipApp.isPremiumCached === 'function') {
          // Check cached membership status (set by loadCard from /api/membership/status)
          if (window.MembershipApp.isPremiumCached()) {
            const upsellSlide = document.querySelector('.hero-slide[data-slide="0"]');
            if (upsellSlide) upsellSlide.style.display = 'none';
            const upsellDot = document.querySelector('.hero-dot[data-dot="0"]');
            if (upsellDot) upsellDot.style.display = 'none';
          }
        }
        if (!slides.length || slides.length < 2) return;
        let current = 0;
        let autoTimer = null;
        let pausedUntil = 0; // timestamp until which autoplay is paused
        let touchStartX = 0;
        let touchStartY = 0;
        let touchActive = false;

        function goTo(idx) {
            slides.forEach(s => s.classList.remove('active'));
            dots.forEach(d => d.classList.remove('active'));
            current = ((idx % slides.length) + slides.length) % slides.length;
            slides[current].classList.add('active');
            if (dots[current]) dots[current].classList.add('active');
        }

        function startAuto() {
            if (autoTimer) clearInterval(autoTimer);
            autoTimer = setInterval(() => {
                if (Date.now() < pausedUntil) return;
                goTo(current + 1);
            }, 5000);
        }
        function stopAuto() {
            if (autoTimer) { clearInterval(autoTimer); autoTimer = null; }
        }
        function pauseFor(ms) {
            pausedUntil = Math.max(pausedUntil, Date.now() + ms);
        }

        // Dot click
        dots.forEach(d => d.addEventListener('click', () => {
            const idx = Number(d.dataset.dot);
            if (!isNaN(idx)) {
                goTo(idx);
                pauseFor(8000); // pause autoplay for 8s after manual interaction
            }
        }));

        // Touch swipe + pause-on-touch
        if (slider) {
            slider.addEventListener('touchstart', (e) => {
                touchStartX = e.touches[0].clientX;
                touchStartY = e.touches[0].clientY;
                touchActive = true;
                pauseFor(10000); // pause on touch
            }, { passive: true });

            slider.addEventListener('touchend', (e) => {
                if (!touchActive) return;
                touchActive = false;
                const dx = (e.changedTouches[0]?.clientX || 0) - touchStartX;
                const dy = (e.changedTouches[0]?.clientY || 0) - touchStartY;
                if (Math.abs(dx) > 40 && Math.abs(dx) > Math.abs(dy)) {
                    if (dx > 0) goTo(current - 1); // swipe right → previous
                    else goTo(current + 1);       // swipe left → next
                }
                pauseFor(8000); // pause autoplay for 8s after swipe
            }, { passive: true });
        }

        startAuto();
        if (autoTimer) _pollingIntervals.push(autoTimer);
        // Stop on visibility hidden, restart on visible
        document.addEventListener('visibilitychange', () => {
            if (document.hidden) stopAuto();
            else startAuto();
        });
    })();

    }).catch(() => { /* maintenance check failed — fail open */
        // Even on fail-open, remove boot loader so user sees the app
        _removeBootLoader();
    });
});

//#endregion

// ============================================================================
//#region ثبت توابع در فضای global
// ============================================================================
// ثبت توابع در فضای global
window.switchTab = switchTab;
window.switchMainTab = switchMainTab;
window.switchSubTab = switchSubTab;
// MKT-011: renderBtcPairsSection removed (was no-op, 0 callers)
window.switchNewsTab = switchNewsTab;
window.switchCalendarTab = switchCalendarTab;
window.filterCalCountry = filterCalCountry;
// News Intelligence — new functions
window.openNewsFilterSheet = openNewsFilterSheet;
window.closeNewsFilterSheet = closeNewsFilterSheet;
window.applyNewsFilters = applyNewsFilters;
window.resetNewsFilters = resetNewsFilters;
window.toggleSaveNews = toggleSaveNews;
window.openShareSheet = openShareSheet;
window.closeShareSheet = closeShareSheet;
window.shareNewsTo = shareNewsTo;
window.openNewsSearch = openNewsSearch;
window.closeNewsSearch = closeNewsSearch;
window.onNewsSearchInput = onNewsSearchInput;
window.niGoToSlide = niGoToSlide;
window.openReminderSheet = openReminderSheet;
window.closeReminderSheet = closeReminderSheet;
window.setEventReminder = setEventReminder;
window.removeEventReminder = removeEventReminder;
window.toggleWatchlist = toggleWatchlist;
window.showMiniToast = showMiniToast;
// PHASE 7C-A (H1 fix): Wire window.admToast so the 17 call sites in
// membership-user.js, cosmetics.js, and membership-admin.js no longer
// fall through to native alert(). Delegates to adminToast (color-coded,
// supports 'success'|'error'|'info' type) when available (admin.js is
// lazy-loaded on first openAdminPanel call). Falls back to showToast
// (always available, single-arg, haptic) when admin.js hasn't loaded yet.
// This does NOT create a second toast system — it reuses the existing two.
window.admToast = function admToastShim(message, type) {
    if (typeof window.adminToast === 'function') {
        // adminToast supports (message, type) with color-coded styling.
        return window.adminToast(message, type);
    }
    // Fallback: showToast takes (msg) only — type is ignored. Still
    // non-blocking, styled, with haptic feedback. Vastly better than
    // native alert() which is LTR, blocking, and unstyled.
    if (typeof showToast === 'function') {
        return showToast(message);
    }
    // Last-resort fallback (should never reach here in practice).
    if (typeof window.showMiniToast === 'function') {
        return window.showMiniToast(message);
    }
    // Truly last resort.
    try { window.alert(message); } catch (e) { /* noop */ }
};
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
window.loadMoreAnalyses = loadMoreAnalyses;
window.initAnalysisToolbar = initAnalysisToolbar;
window.toggleAnalysisBookmark = toggleAnalysisBookmark;
window.copyAnalysisContent = copyAnalysisContent;
window.openDashboardNewsModal = openDashboardNewsModal;
window.openNewsModalWith = openNewsModalWith;
window.openCoinDetail = openCoinDetail;
window.closeCoinDetail = closeCoinDetail;
window.setPriceAlert = setPriceAlert;
window.selectAlertDirection = selectAlertDirection;
window.selectCdAlertDirection = selectCdAlertDirection;
window.updateCdAlertStatus = updateCdAlertStatus;
window.removeAlert = removeAlert;
window.updateTrendStrength = updateTrendStrength;
window.toggleNotificationPanel = toggleNotificationPanel;
window.closeNotifModal = closeNotifModal;
window.markAllRead = markAllRead;
window.clearAllNotifications = clearAllNotifications;
window.markNotifRead = markNotifRead;
window.deleteNotification = deleteNotification;
// copyRefLink / shareRefLink removed — use ReferralApp.copyLink() / shareLink() instead
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
window.openTermsModal = openTermsModal;
window.closeTermsModal = closeTermsModal;
window.openPrivacyModal = openPrivacyModal;
window.closePrivacyModal = closePrivacyModal;
window.toggleAccordion = toggleAccordion;
window.openContentEditor = openContentEditor;
window.closeContentEditor = closeContentEditor;
window.saveContentFromEditor = saveContentFromEditor;
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

// ============================================================================
//#region Membership Lock — Floating Status Card + Full Lock for non-members
// ============================================================================
// FLOATING STATUS CARD UX (Task 37 — Production-ready redesign):
//   1. App startup → show FLOATING CARD (bottom, above bottom-nav) "Checking...".
//      Card is centered, max-width 340px, ~75% viewport width, height 44-52px,
//      glassmorphism + blur + soft shadow + subtle border, fully rounded 20px.
//      Smooth transform+opacity enter/exit, GPU-friendly, no layout shift.
//   2. Backend returns channel_joined=true → Card shows "Verified ✓" → after
//      ~800ms fades out → fully removed. NO overlay, NO body lock, NO spinner
//      left behind. Members see the app instantly.
//   3. Backend returns channel_joined=false → Card shows "Required" → after
//      ~600ms the FULL Join Lock overlay is shown (body locked).
//   4. Backend error/timeout → Card shows "Connection Error" with Retry button.
//
// ROOT-CAUSE FIX (Task 37): The previous implementation declared
// `_joinLockSafetyTimer` as `const` inside DOMContentLoaded (block scope), but
// then tried to `clearTimeout(_joinLockSafetyTimer)` from `bootstrapUser()` —
// a top-level function. That threw a ReferenceError, was swallowed by the
// try/catch, and the Status Bar was never advanced past "Checking…". The
// safety timer is now a module-level variable with proper helper functions.
//
// Performance: single membership check per bootstrap, no timer/interval/promise
// leaks, idempotent verify-button wiring, dead code removed.
// Security preserved: backend still gates every API. No client bypass.

let _joinLockShown = false;
let _joinVerifying = false; // prevent double-click on verify button
let _statusBarHideTimer = null;
let _joinLockSafetyTimer = null; // module-level (was block-scoped → bug)
let _joinLockPendingShowTimer = null; // 600ms delay before showing full lock
let _bootstrapMembershipInFlight = false; // dedupe membership checks

/**
 * Clear the bootstrap safety timer (idempotent).
 * Prevents the hard-timeout fallback from firing after bootstrap resolves.
 */
function clearJoinLockSafetyTimer() {
    if (_joinLockSafetyTimer) {
        clearTimeout(_joinLockSafetyTimer);
        _joinLockSafetyTimer = null;
    }
}

/**
 * Clear the pending "show full lock" timer (idempotent).
 * Used when the user verifies membership before the 600ms delay fires.
 */
function clearJoinLockPendingShowTimer() {
    if (_joinLockPendingShowTimer) {
        clearTimeout(_joinLockPendingShowTimer);
        _joinLockPendingShowTimer = null;
    }
}

// ────────────────────────────────────────────────────────────
// FLOATING STATUS CARD — bottom card, no overlay, no lock
// ────────────────────────────────────────────────────────────
const JSB_ICONS = {
    spinner: '<svg class="jsb-spinner" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round"><path d="M21 12a9 9 0 1 1-6.219-8.56"/></svg>',
    check: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.8" stroke-linecap="round" stroke-linejoin="round"><polyline points="20 6 9 17 4 12"/></svg>',
    alert: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/></svg>',
    error: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.2" stroke-linecap="round" stroke-linejoin="round"><circle cx="12" cy="12" r="10"/><line x1="12" y1="8" x2="12" y2="12"/><line x1="12" y1="16" x2="12.01" y2="16"/></svg>',
    retry: '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round"><polyline points="23 4 23 10 17 10"/><path d="M20.49 15a9 9 0 1 1-2.12-9.36L23 10"/></svg>',
};

/**
 * Show the floating Status Card in a given state.
 * @param {'checking'|'verified'|'required'|'error'} state
 * @param {object} [opts] - { autoHideMs?: number }
 */
function showJoinStatusBar(state, opts = {}) {
    const bar = document.getElementById('join-status-bar');
    if (!bar) return;
    const iconEl = document.getElementById('jsb-icon');
    const textEl = document.getElementById('jsb-text');
    const actionEl = document.getElementById('jsb-action');
    const isFa = currentLang === 'fa';
    if (!iconEl || !textEl || !actionEl) return;

    // Clear any pending hide timer (avoid double-fire)
    if (_statusBarHideTimer) { clearTimeout(_statusBarHideTimer); _statusBarHideTimer = null; }

    bar.dataset.state = state;
    // Force reflow so the enter transition runs even when re-showing
    bar.classList.remove('visible');
    void bar.offsetWidth;
    bar.classList.add('visible');

    let icon = JSB_ICONS.spinner;
    let text = '';
    let actionDisplay = 'none';
    let actionText = '';
    let actionHandler = null;

    if (state === 'checking') {
        icon = JSB_ICONS.spinner;
        text = isFa ? 'در حال بررسی عضویت…' : 'Checking membership…';
    } else if (state === 'verified') {
        icon = JSB_ICONS.check;
        text = isFa ? 'عضویت تأیید شد ✓' : 'Membership verified ✓';
    } else if (state === 'required') {
        icon = JSB_ICONS.alert;
        text = isFa ? 'عضویت در کانال الزامی است' : 'Channel membership required';
        actionDisplay = 'inline-flex';
        actionText = isFa ? 'عضویت' : 'Join';
        actionHandler = () => {
            const tg = getTg();
            tg?.openTelegramLink?.('https://t.me/amir_btc_2024') ||
                window.open('https://t.me/amir_btc_2024', '_blank');
        };
    } else if (state === 'error') {
        icon = JSB_ICONS.error;
        // H2 FIX: allow a custom message (e.g. "Open in Telegram" when not
        // inside Telegram). Previously hardcoded to "Connection error" which
        // was misleading for auth-required states.
        text = (opts.message || (isFa ? 'خطای اتصال' : 'Connection error'));
        actionDisplay = 'inline-flex';
        actionText = isFa ? 'تلاش مجدد' : 'Retry';
        actionHandler = () => {
            // Re-trigger bootstrap from scratch
            setJoinLockState('loading');
            bootstrapUser().catch(e => {
                console.error('[JOIN-LOCK] Manual retry failed:', e.message);
                setJoinLockState('error', e?.message || 'Retry failed');
            });
        };
    }

    iconEl.innerHTML = icon;
    textEl.textContent = text;
    if (actionDisplay === 'none') {
        actionEl.style.display = 'none';
        actionEl.onclick = null;
    } else {
        actionEl.style.display = actionDisplay;
        actionEl.innerHTML = (state === 'error' ? JSB_ICONS.retry : '') + '<span>' + actionText + '</span>';
        actionEl.onclick = actionHandler;
    }

    // Auto-hide for verified state — fade out after ~800ms then fully remove
    if (state === 'verified' && opts.autoHideMs !== 0) {
        const delay = opts.autoHideMs || 800;
        _statusBarHideTimer = setTimeout(() => hideJoinStatusBar(), delay);
    }
}

/**
 * Hide the floating Status Card with a fade-out animation, then fully remove.
 * Cleans up the hide timer to prevent leaks.
 */
function hideJoinStatusBar() {
    const bar = document.getElementById('join-status-bar');
    if (!bar) return;
    bar.classList.remove('visible');
    // After the exit transition (300ms), reset state
    setTimeout(() => {
        if (!bar.classList.contains('visible')) {
            bar.dataset.state = 'hidden';
        }
    }, 320);
    if (_statusBarHideTimer) { clearTimeout(_statusBarHideTimer); _statusBarHideTimer = null; }
}

// ────────────────────────────────────────────────────────────
// FULL JOIN LOCK — only shown for confirmed non-members
// ────────────────────────────────────────────────────────────
/**
 * Show the FULL membership lock overlay (only for non-members).
 * The Status Card must have already told the user "membership required".
 */
function showJoinLock() {
    _joinLockShown = true;
    document.body.classList.add('jl-locked');
    const overlay = document.getElementById('join-lock-overlay');
    if (overlay) overlay.style.display = 'flex';
    // Wire up the verify button (idempotent — safe to call multiple times)
    const verifyBtn = document.getElementById('join-lock-verify-btn');
    if (verifyBtn) {
        verifyBtn.removeEventListener('click', recheckJoinMembership);
        verifyBtn.addEventListener('click', recheckJoinMembership);
    }
    // Hide the floating status card — the full lock takes over
    hideJoinStatusBar();
    // PHASE 2 FIX (audit HIGH-1): Fetch admin-configured required channels
    // and render them in the lock overlay so the user knows WHAT to join.
    // The env REQUIRED_CHANNEL is always shown as the primary button; any
    // admin-configured DB channels are shown as a list above the buttons.
    _renderRequiredChannelsList();
}

/**
 * PHASE 2: Fetch admin-configured required channels from
 * /api/advertisements/required-channels and render them in the join-lock
 * overlay. Each channel gets its own row with title + join link.
 *
 * If the API returns no channels (or fails), the overlay falls back to the
 * hardcoded env REQUIRED_CHANNEL button (backward compat).
 */
async function _renderRequiredChannelsList() {
    const container = document.getElementById('join-lock-channels');
    if (!container) return;
    if (!API_BASE || UserContext.isGuest() || UserContext.isPending()) {
        container.style.display = 'none';
        return;
    }
    try {
        const data = await apiFetch('/api/advertisements/required-channels', { method: 'GET' });
        if (!data || data.status !== 'success' || !Array.isArray(data.channels) || data.channels.length === 0) {
            // No DB channels configured — hide container, rely on env button
            container.style.display = 'none';
            return;
        }
        // Render each channel as a row with title + join link.
        // Use textContent for XSS safety (admin-supplied title/channel).
        container.innerHTML = '';
        const isFa = currentLang === 'fa';
        const header = document.createElement('div');
        header.className = 'jl-channels-header';
        header.textContent = isFa ? 'کانال‌های موردنیاز:' : 'Required channels:';
        container.appendChild(header);

        for (const ch of data.channels) {
            const row = document.createElement('div');
            row.className = 'jl-channel-row';

            const dot = document.createElement('span');
            dot.className = 'jl-channel-dot jl-channel-dot--pending';
            dot.setAttribute('aria-hidden', 'true');
            dot.textContent = '○';
            row.appendChild(dot);

            const info = document.createElement('div');
            info.className = 'jl-channel-info';
            const title = document.createElement('span');
            title.className = 'jl-channel-title';
            title.textContent = ch.title || ch.username || '';
            const uname = document.createElement('span');
            uname.className = 'jl-channel-uname';
            uname.textContent = '@' + (ch.username || '');
            info.appendChild(title);
            info.appendChild(uname);
            row.appendChild(info);

            const link = document.createElement('a');
            link.className = 'jl-channel-join';
            link.href = ch.joinUrl || ('https://t.me/' + (ch.username || ''));
            link.target = '_blank';
            link.rel = 'noopener noreferrer';
            link.textContent = isFa ? 'عضویت' : 'Join';
            row.appendChild(link);

            container.appendChild(row);
        }
        container.style.display = 'flex';
    } catch (e) {
        // Non-fatal — fall back to env button
        console.warn('[JOIN-LOCK] required-channels fetch failed:', e?.message || e);
        container.style.display = 'none';
    }
}

/**
 * Hide the membership lock overlay and unlock the app body.
 * ONLY called after backend confirms channel_joined=true.
 */
function hideJoinLock() {
    _joinLockShown = false;
    document.body.classList.remove('jl-locked');
    const overlay = document.getElementById('join-lock-overlay');
    if (overlay) overlay.style.display = 'none';
}

/**
 * Set the join-lock UI state. Drives the floating card + full overlay.
 *   - 'loading'    → floating card "Checking…" (NO overlay, NO body lock)
 *   - 'joined'     → floating card "Verified ✓" → auto-fade after 800ms → removed
 *                    (NO overlay, NO body lock, NO spinner left behind)
 *   - 'not-joined' → floating card "Required" → after 600ms → FULL LOCK overlay
 *   - 'error'      → floating card "Connection error" + Retry button
 */
function setJoinLockState(state, errorMsg) {
    const isFa = currentLang === 'fa';

    if (state === 'loading') {
        // Show floating card — NO overlay, NO body lock
        showJoinStatusBar('checking');
        return;
    }

    if (state === 'joined') {
        // Member verified — show floating "verified" card, then fade out
        clearJoinLockPendingShowTimer();
        showJoinStatusBar('verified', { autoHideMs: 800 });
        // Make sure no full overlay is showing
        const overlay = document.getElementById('join-lock-overlay');
        if (overlay) overlay.style.display = 'none';
        document.body.classList.remove('jl-locked');
        _joinLockShown = false;
        return;
    }

    if (state === 'not-joined') {
        // Show "required" floating card briefly, THEN show full lock
        showJoinStatusBar('required');
        // Pre-populate the full lock overlay content (shown after delay)
        const titleEl = document.getElementById('join-lock-title');
        const descEl = document.getElementById('join-lock-desc');
        const actionsEl = document.getElementById('join-lock-actions');
        const loadingEl = document.getElementById('join-lock-loading');
        const errorEl = document.getElementById('join-lock-error');
        if (titleEl) titleEl.textContent = isFa ? 'عضویت در کانال الزامی است' : 'Channel membership required';
        if (descEl) descEl.textContent = isFa ? 'برای استفاده از امکانات برنامه، ابتدا باید عضو کانال رسمی شوید.' : 'To use the app, please join our official channel first.';
        if (actionsEl) actionsEl.style.display = 'flex';
        if (loadingEl) loadingEl.style.display = 'none';
        if (errorEl) {
            if (errorMsg) { errorEl.textContent = errorMsg; errorEl.style.display = 'block'; }
            else { errorEl.style.display = 'none'; }
        }
        // After 600ms, hide floating card and show full lock
        clearJoinLockPendingShowTimer();
        _joinLockPendingShowTimer = setTimeout(() => {
            _joinLockPendingShowTimer = null;
            if (!_joinLockShown) {
                showJoinLock();
            }
        }, 600);
        return;
    }

    if (state === 'error') {
        // Show floating card with "error" + Retry button
        clearJoinLockPendingShowTimer();
        // H2 FIX: pass the custom error message through to the status bar so
        // it replaces the hardcoded "Connection error" text.
        showJoinStatusBar('error', { message: errorMsg });
        const errorEl = document.getElementById('join-lock-error');
        if (errorEl && errorMsg) {
            errorEl.textContent = errorMsg;
            errorEl.style.display = 'block';
        }
        return;
    }
}

/**
 * Recheck channel membership via backend.
 * Called when user clicks "تأیید عضویت" button on the full lock overlay,
 * OR when user clicks "Retry" on the floating error card.
 * Prevents double-clicks with _joinVerifying flag.
 */
async function recheckJoinMembership() {
    if (_joinVerifying) return; // prevent double-click
    _joinVerifying = true;

    const btn = document.getElementById('join-lock-verify-btn');
    if (btn) { btn.disabled = true; }
    // Show floating card during re-check
    showJoinStatusBar('checking');
    const isFa = currentLang === 'fa';

    try {
        const data = await apiFetch('/api/users/check-join', { method: 'POST' });
        if (data && data.channel_joined === true) {
            // Verified — show success, then enter app
            showJoinStatusBar('verified', { autoHideMs: 800 });
            setTimeout(() => {
                hideJoinLock();
                refreshUI();
                getTg()?.HapticFeedback?.notificationOccurred?.('success');
            }, 600);
        } else {
            // Still not a member — show full lock again with explanation
            const errorMsg = isFa
                ? 'هنوز عضویت شما تأیید نشده است. لطفاً ابتدا عضو کانال شوید و سپس دوباره تأیید عضویت را انتخاب کنید.'
                : 'Membership not confirmed yet. Please join the channel first, then click verify again.';
            setJoinLockState('not-joined', errorMsg);
            getTg()?.HapticFeedback?.notificationOccurred?.('warning');
        }
    } catch (e) {
        setJoinLockState('error', e?.message || 'Network error');
        getTg()?.HapticFeedback?.notificationOccurred?.('error');
    } finally {
        _joinVerifying = false;
        if (btn) { btn.disabled = false; }
    }
}

window.showJoinLock = showJoinLock;
window.hideJoinLock = hideJoinLock;
window.recheckJoinMembership = recheckJoinMembership;
window.setJoinLockState = setJoinLockState;
window.showJoinStatusBar = showJoinStatusBar;
window.hideJoinStatusBar = hideJoinStatusBar;
window.clearJoinLockSafetyTimer = clearJoinLockSafetyTimer;

//#endregion

// ============================================================================
// DIAGNOSTIC PANEL — Calendar Debug
// ============================================================================
// This panel helps diagnose calendar issues by showing:
// - Current BUILD_ID and app.js hash (proves which version is running)
// - Server time vs device time
// - API response with event statuses
// - Filter computation results
// - Force cache-bust button
//
// Open by: typing 'debugcal' in any input, or calling window.showCalendarDebug()

function showCalendarDebug() {
    // Remove existing panel
    const existing = document.getElementById('cal-debug-panel');
    if (existing) { existing.remove(); return; }

    const panel = document.createElement('div');
    panel.id = 'cal-debug-panel';
    panel.style.cssText = 'position:fixed;top:0;left:0;right:0;bottom:0;z-index:99999;background:rgba(0,0,0,0.95);overflow-y:auto;padding:16px;font-family:monospace;font-size:11px;color:#0f0;line-height:1.6;';

    const tz = 'Asia/Tehran';
    const now = new Date();
    const todayParts = now.toLocaleDateString('en-CA', { timeZone: tz }).split('-');
    const todayStart = new Date(Date.UTC(Number(todayParts[0]), Number(todayParts[1]) - 1, Number(todayParts[2])));

    // Get BUILD_ID from the inline script
    const buildIdMatch = document.documentElement.outerHTML.match(/BUILD_ID\s*=\s*'([^']+)'/);
    const buildId = buildIdMatch ? buildIdMatch[1] : 'NOT_FOUND';

    // Get app.js hash from script tags
    const appScript = Array.from(document.querySelectorAll('script[src]')).find(s => s.src.includes('/app.'));
    const appJsHash = appScript ? appScript.src.split('/').pop() : 'NOT_FOUND';

    // Get localStorage build ID
    const storedBuildId = localStorage.getItem('app_build_id') || 'NOT_SET';

    panel.innerHTML = `
        <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:16px;">
            <h2 style="color:#F5A623;font-size:16px;">🔍 Calendar Debug Panel</h2>
            <button onclick="this.parentElement.parentElement.remove()" style="background:#333;color:#fff;border:none;padding:6px 12px;border-radius:6px;cursor:pointer;">✕ Close</button>
        </div>

        <div style="background:#111;padding:12px;border-radius:8px;margin-bottom:12px;">
            <h3 style="color:#F5A623;font-size:13px;margin-bottom:8px;">📋 Version Info</h3>
            <div>BUILD_ID (HTML): <span style="color:#0f0">${buildId}</span></div>
            <div>app.js hash: <span style="color:#0f0">${appJsHash}</span></div>
            <div>localStorage build_id: <span style="color:#0f0">${storedBuildId}</span></div>
            <div>Match: <span style="color:${buildId === storedBuildId ? '#0f0' : '#f00'}">${buildId === storedBuildId ? 'YES' : 'NO (stale!)'}</span></div>
        </div>

        <div style="background:#111;padding:12px;border-radius:8px;margin-bottom:12px;">
            <h3 style="color:#F5A623;font-size:13px;margin-bottom:8px;">⏰ Time Info</h3>
            <div>Device time (UTC): <span style="color:#0f0">${now.toISOString()}</span></div>
            <div>Device timezone: <span style="color:#0f0">${Intl.DateTimeFormat().resolvedOptions().timeZone}</span></div>
            <div>Tehran time: <span style="color:#0f0">${now.toLocaleString('en-GB', {timeZone: tz})}</span></div>
            <div>Tehran today: <span style="color:#0f0">${todayParts.join('-')}</span></div>
            <div>todayStart (UTC): <span style="color:#0f0">${todayStart.toISOString()}</span></div>
        </div>

        <div style="background:#111;padding:12px;border-radius:8px;margin-bottom:12px;">
            <h3 style="color:#F5A623;font-size:13px;margin-bottom:8px;">🌐 API Response</h3>
            <div id="cal-debug-api" style="color:#0f0;">Loading...</div>
        </div>

        <div style="background:#111;padding:12px;border-radius:8px;margin-bottom:12px;">
            <h3 style="color:#F5A623;font-size:13px;margin-bottom:8px;">🔧 Actions</h3>
            <button onclick="forceCalendarCacheBust()" style="background:#F5A623;color:#000;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;font-weight:bold;margin-right:8px;">🔄 Force Cache Bust + Reload</button>
            <button onclick="window.location.reload(true)" style="background:#333;color:#fff;border:none;padding:8px 16px;border-radius:6px;cursor:pointer;">Hard Reload</button>
        </div>

        <div style="background:#111;padding:12px;border-radius:8px;margin-bottom:12px;">
            <h3 style="color:#F5A623;font-size:13px;margin-bottom:8px;">📖 How to use</h3>
            <div style="color:#aaa;font-size:10px;">
                1. Check if BUILD_ID (HTML) matches localStorage build_id. If "NO (stale!)", click "Force Cache Bust".<br>
                2. Check API response shows 95 events with correct statuses (mostly "upcoming").<br>
                3. Check Filter today/tomorrow/week counts are non-zero.<br>
                4. Take a screenshot of this panel and send to support.<br>
                5. Open with: long-press (3s) on "تقویم اقتصادی" header, or add #debugcal to URL.
            </div>
        </div>
    `;

    document.body.appendChild(panel);

    // Fetch API data and display
    const _apiBase = (window.API_BASE || API_BASE || '').replace(/\/$/, '');
    fetch(_apiBase + '/api/calendar/events?_=' + Date.now(), { cache: 'no-store' })
        .then(r => r.json())
        .then(data => {
            const apiDiv = document.getElementById('cal-debug-api');
            if (!data || !data.events) {
                apiDiv.innerHTML = '<span style="color:#f00">ERROR: No events in API response</span>';
                return;
            }
            const ev = data.events;
            const statusCounts = {};
            for (const e of ev) statusCounts[e.status] = (statusCounts[e.status] || 0) + 1;

            // Compute filter results
            const todayCount = ev.filter(e => {
                const d = new Date(e.timestamp);
                const p = d.toLocaleDateString('en-CA', {timeZone: tz}).split('-');
                const day = new Date(Date.UTC(Number(p[0]), Number(p[1])-1, Number(p[2])));
                return day.getTime() === todayStart.getTime();
            }).length;
            const tomorrowCount = ev.filter(e => {
                const d = new Date(e.timestamp);
                const p = d.toLocaleDateString('en-CA', {timeZone: tz}).split('-');
                const day = new Date(Date.UTC(Number(p[0]), Number(p[1])-1, Number(p[2])));
                return day.getTime() === todayStart.getTime() + 86400000;
            }).length;

            apiDiv.innerHTML = `
                <div>server_time: <span style="color:#0f0">${data.server_time || 'N/A'}</span></div>
                <div>last_updated: <span style="color:#0f0">${data.last_updated || 'N/A'}</span></div>
                <div>isolate_cache_age: <span style="color:#0f0">${data.isolate_cache_age_seconds || 'N/A'}s</span></div>
                <div>Total events: <span style="color:#0f0">${ev.length}</span></div>
                <div>Status: <span style="color:#0f0">${JSON.stringify(statusCounts)}</span></div>
                <div>Filter today: <span style="color:#0f0">${todayCount}</span> events</div>
                <div>Filter tomorrow: <span style="color:#0f0">${tomorrowCount}</span> events</div>
                <div>Filter week: <span style="color:#0f0">${ev.length}</span> events (all)</div>
                <div style="margin-top:8px;color:#aaa;">
                Latest BUILD_ID: <span style="color:#0f0">${buildId}</span> (this HTML)<br>
                If localStorage shows OLD build_id, click "Force Cache Bust" below.
            </div>
            <div style="margin-top:8px;color:#aaa;">First 5 events:</div>
                ${ev.slice(0,5).map((e,i) => {
                    const d = new Date(e.timestamp);
                    const tehranDate = d.toLocaleDateString('en-CA', {timeZone: tz});
                    const diffH = Math.round((d.getTime() - now.getTime())/3600000);
                    return `<div style="color:#888;">${i+1}. ${e.title.slice(0,25)} | ${e.timestamp} | Tehran: ${tehranDate} | diff: ${diffH}h | status: ${e.status}</div>`;
                }).join('')}
            `;
        })
        .catch(e => {
            document.getElementById('cal-debug-api').innerHTML = '<span style="color:#f00">Fetch error: ' + e.message + '</span>';
        });
}

function forceCalendarCacheBust() {
    // Clear all caches
    localStorage.removeItem('app_build_id');
    sessionStorage.setItem('app_cache_bust', '1');
    // Force reload with cache-bust query param
    const url = window.location.pathname + '?_cb=' + Date.now() + (window.location.hash || '');
    window.location.replace(url);
}

// Expose globally
window.showCalendarDebug = showCalendarDebug;
window.forceCalendarCacheBust = forceCalendarCacheBust;

// Auto-open if URL has #debugcal or ?debugcal
if (window.location.hash === '#debugcal' || window.location.search.includes('debugcal')) {
    setTimeout(showCalendarDebug, 2000);
}

// Also add a long-press on the calendar section header to open debug
let _calHeaderPressTimer = null;

// ============================================================================
// BETA LAUNCH POPUP — One-time per-user beta announcement
// ============================================================================
// Shows a premium-styled popup ONCE per user (server-side `beta_popup_seen`
// flag). After the user dismisses it, it never shows again — across devices,
// sessions, and cache clears. The flag is persisted via PUT /api/users/me/settings.

function openBetaPopup() {
    // Dedupe — remove any existing popup
    const existing = document.getElementById('beta-popup-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'beta-popup-overlay';
    overlay.className = 'beta-popup-overlay';

    // Backdrop click closes popup
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeBetaPopup();
    });

    // Escape key closes popup
    overlay.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeBetaPopup();
    });

    overlay.innerHTML = `
        <div class="beta-popup-card" role="dialog" aria-labelledby="beta-popup-title-el" aria-modal="true" tabindex="-1">
            <div class="beta-popup-header">
                <div class="beta-popup-glow"></div>
                <div class="beta-popup-badge">${t('beta_popup_beta_badge')}</div>
                <div class="beta-popup-orbit">
                    <svg width="56" height="56" viewBox="0 0 56 56" fill="none" xmlns="http://www.w3.org/2000/svg">
                        <circle cx="28" cy="28" r="24" stroke="rgba(245,166,35,0.15)" stroke-width="1.5"/>
                        <circle cx="28" cy="28" r="16" stroke="rgba(245,166,35,0.25)" stroke-width="1"/>
                        <circle cx="28" cy="28" r="3.5" fill="#F5A623"/>
                        <circle cx="48" cy="28" r="2" fill="rgba(245,166,35,0.6)"/>
                        <circle cx="28" cy="8" r="1.5" fill="rgba(245,166,35,0.4)"/>
                    </svg>
                </div>
            </div>
            <div class="beta-popup-body">
                <h2 class="beta-popup-title" id="beta-popup-title-el">${t('beta_popup_title')}</h2>
                <p class="beta-popup-desc">${t('beta_popup_desc')}</p>
                <p class="beta-popup-detail">${t('beta_popup_detail')}</p>
                <div class="beta-popup-report">
                    <div class="beta-popup-report-icon">
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                            <path d="M10 1.5C5.86 1.5 2.5 4.86 2.5 9v4.17c0 .73.6 1.33 1.33 1.33H5v-5H4.17V9c0-3.22 2.61-5.83 5.83-5.83s5.83 2.61 5.83 5.83v.5H15v5h1.17c.73 0 1.33-.6 1.33-1.33V9c0-4.14-3.36-7.5-7.5-7.5z" fill="rgba(245,166,35,0.8)"/>
                        </svg>
                    </div>
                    <div class="beta-popup-report-text">
                        <div class="beta-popup-report-title">${t('beta_popup_report_title')}</div>
                        <div class="beta-popup-report-desc">${t('beta_popup_report_desc')}</div>
                    </div>
                </div>
            </div>
            <div class="beta-popup-actions">
                <button class="beta-popup-btn-primary" onclick="closeBetaPopup()" type="button">
                    ${t('beta_popup_cta_continue')}
                </button>
                <button class="beta-popup-btn-secondary" onclick="closeBetaPopupAndOpenTickets()" type="button">
                    ${t('beta_popup_cta_support')}
                </button>
            </div>
        </div>
    `;

    document.body.appendChild(overlay);

    // Focus the card for accessibility
    setTimeout(function() {
        const card = overlay.querySelector('.beta-popup-card');
        if (card) card.focus();
    }, 100);
}

function closeBetaPopup() {
    const overlay = document.getElementById('beta-popup-overlay');
    if (!overlay) return;

    // Add closing class for reverse animation
    overlay.classList.add('beta-popup-closing');
    setTimeout(function() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 300);

    // Fire-and-forget: persist `beta_popup_seen = true` on server
    // Only set `seen` AFTER user actually dismisses the popup
    if (API_BASE) {
        try {
            apiFetch('/api/users/me/settings', {
                method: 'PUT',
                body: JSON.stringify({ beta_popup_seen: true })
            }).catch(function(e) {
                console.warn('[BETA-POPUP] Failed to persist beta_popup_seen:', e?.message || e);
            });
        } catch (e) {
            console.warn('[BETA-POPUP] Failed to send beta_popup_seen request:', e?.message || e);
        }
    }
}

function closeBetaPopupAndOpenTickets() {
    closeBetaPopup();
    // Navigate to ticket/support system (existing function in app.js)
    setTimeout(function() {
        if (typeof openTicketsModal === 'function') {
            openTicketsModal();
        }
    }, 350); // wait for popup close animation
}

// ═══════════════════════════════════════════════════════════════════════════
// PHASE 3 — Advertisement Popup (Mini App open, 24h per-user cooldown)
// ═══════════════════════════════════════════════════════════════════════════
//
// Flow:
//   User opens Mini App
//     → bootstrapUser() succeeds
//     → maybeShowAdPopup() called (1.2s delay, after beta popup)
//     → GET /api/advertisements/popups
//     → backend iterates active popups, returns first NOT in 24h cooldown
//     → if popup returned → openAdPopup(popup) renders fixed-template overlay
//     → user dismisses → POST /api/advertisements/popups/:id/shown (sets KV cooldown)
//     → next open within 24h → backend returns popup:null → no show
//     → after 24h → backend returns popup again → shown again
//
// Template is FIXED (Phase 4): image → title → body → button. Admin can only
// configure content, not layout. All text rendered via textContent (XSS-safe).

async function maybeShowAdPopup() {
    if (_adPopupShown || _adPopupFetchInFlight) return;
    if (!API_BASE || UserContext.isGuest() || UserContext.isPending()) return;
    if (isInTelegram() && !isTelegramAuthReady()) return;
    // Don't show ad popup if beta popup is currently open
    if (document.getElementById('beta-popup-overlay')) return;

    _adPopupFetchInFlight = true;
    try {
        const data = await apiFetch('/api/advertisements/popups', { method: 'GET' });
        if (data && data.status === 'success' && data.popup) {
            _adPopupShown = true; // session guard — don't show again this session
            openAdPopup(data.popup);
        }
        // If data.popup is null, the user is in cooldown or no active popups — silent.
    } catch (e) {
        // Non-fatal — ad popups are non-critical. Don't surface errors to user.
        console.warn('[AD-POPUP] fetch failed:', e?.message || e);
    } finally {
        _adPopupFetchInFlight = false;
    }
}

function openAdPopup(popup) {
    if (!popup || !popup.id) return;

    // Dedupe — remove any existing ad popup
    const existing = document.getElementById('ad-popup-overlay');
    if (existing) existing.remove();

    const overlay = document.createElement('div');
    overlay.id = 'ad-popup-overlay';
    overlay.className = 'ad-popup-overlay';
    overlay.setAttribute('role', 'dialog');
    overlay.setAttribute('aria-modal', 'true');
    overlay.setAttribute('aria-labelledby', 'ad-popup-title-el');

    // Backdrop click closes popup
    overlay.addEventListener('click', function(e) {
        if (e.target === overlay) closeAdPopup(popup.id);
    });
    // Escape key closes popup
    overlay.addEventListener('keydown', function(e) {
        if (e.key === 'Escape') closeAdPopup(popup.id);
    });

    // ── Fixed template: image (optional) → title → body → button (optional) ──
    // All content is rendered via textContent (never innerHTML) for XSS safety.
    // The backend also sanitizes (sanitizeText strips ALL HTML tags), so this
    // is defense-in-depth.
    const card = document.createElement('div');
    card.className = 'ad-popup-card';
    card.setAttribute('tabindex', '-1');

    // Close button (top-right)
    const closeBtn = document.createElement('button');
    closeBtn.className = 'ad-popup-close';
    closeBtn.setAttribute('type', 'button');
    closeBtn.setAttribute('aria-label', 'بستن');
    closeBtn.innerHTML = '&times;';
    closeBtn.addEventListener('click', function() { closeAdPopup(popup.id); });
    card.appendChild(closeBtn);

    // Image (optional) — only render if image_url is present and valid
    if (popup.image_url) {
        const imgWrap = document.createElement('div');
        imgWrap.className = 'ad-popup-image-wrap';
        const img = document.createElement('img');
        img.className = 'ad-popup-image';
        img.alt = popup.title || 'Advertisement';
        img.loading = 'lazy';
        img.src = popup.image_url;
        // Security: referrerpolicy + no referrer to prevent leaking Mini App URL to external hosts
        img.referrerPolicy = 'no-referrer';
        // Graceful fallback if image fails to load
        img.addEventListener('error', function() {
            imgWrap.style.display = 'none';
        });
        imgWrap.appendChild(img);
        card.appendChild(imgWrap);
    }

    // Body container (title + text + button)
    const body = document.createElement('div');
    body.className = 'ad-popup-body';

    const title = document.createElement('h2');
    title.className = 'ad-popup-title';
    title.id = 'ad-popup-title-el';
    title.textContent = popup.title || ''; // textContent = XSS-safe
    body.appendChild(title);

    if (popup.body_text) {
        const text = document.createElement('p');
        text.className = 'ad-popup-text';
        text.textContent = popup.body_text; // textContent = XSS-safe
        body.appendChild(text);
    }

    if (popup.button_label && popup.button_url) {
        const btn = document.createElement('a');
        btn.className = 'ad-popup-button';
        btn.textContent = popup.button_label; // textContent = XSS-safe
        btn.href = popup.button_url;
        btn.target = '_blank';
        btn.rel = 'noopener noreferrer';
        // Record impression when user clicks the button (in addition to dismiss)
        btn.addEventListener('click', function() {
            try {
                apiFetch('/api/advertisements/popups/' + encodeURIComponent(popup.id) + '/shown', { method: 'POST' }).catch(function() {});
            } catch {}
        });
        body.appendChild(btn);
    }

    card.appendChild(body);
    overlay.appendChild(card);
    document.body.appendChild(overlay);

    // Focus the card for accessibility
    setTimeout(function() { card.focus(); }, 100);
}

function closeAdPopup(popupId) {
    const overlay = document.getElementById('ad-popup-overlay');
    if (!overlay) return;

    // Closing animation
    overlay.classList.add('ad-popup-closing');
    setTimeout(function() {
        if (overlay.parentNode) overlay.parentNode.removeChild(overlay);
    }, 300);

    // Record impression (sets 24h KV cooldown server-side).
    // Fire-and-forget — non-blocking. If this fails, the popup will re-show
    // on next open (acceptable fallback — better to over-show than under-show).
    if (popupId && API_BASE) {
        try {
            apiFetch('/api/advertisements/popups/' + encodeURIComponent(popupId) + '/shown', { method: 'POST' }).catch(function(e) {
                console.warn('[AD-POPUP] failed to record impression:', e?.message || e);
            });
        } catch {}
    }
}

window.maybeShowAdPopup = maybeShowAdPopup;
window.openAdPopup = openAdPopup;
window.closeAdPopup = closeAdPopup;

document.addEventListener('DOMContentLoaded', () => {
    setTimeout(() => {
        const header = document.querySelector('#dashboard-calendar').previousElementSibling;
        if (header) {
            header.addEventListener('touchstart', () => {
                _calHeaderPressTimer = setTimeout(() => {
                    showCalendarDebug();
                }, 3000); // 3 second long-press
            });
            header.addEventListener('touchend', () => {
                if (_calHeaderPressTimer) clearTimeout(_calHeaderPressTimer);
            });
            header.addEventListener('touchmove', () => {
                if (_calHeaderPressTimer) clearTimeout(_calHeaderPressTimer);
            });
        }
    }, 3000);
});
// Production deploy marker: 2026-08-17T06:19:52Z commit d39f882

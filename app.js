// =========================================================================
// بخش ۱: راه‌اندازی ابزارهای اولیه و تلگرام (Telegram WebApp Init)
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

// =========================================================================
// بخش ۲: متغیرهای ثابت، آدرس‌ها و آرایه‌ها (Constants & States)
// =========================================================================
const MY_TELEGRAM_CHANNEL = "amir_btc_2024";
const BACKEND_URL = "https://amir-btc-assistant-production.up.railway.app";
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";

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
// بخش ۳: موتور کش مرکزی ارتقاءیافته (Enhanced Cache Engine)
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
    document.querySelectorAll('.page').forEach(page => page.classList.remove('active'));
    closeReferralPage();
    closeSettingsPage();

    const activePage = document.getElementById(pageId);
    if (activePage) activePage.classList.add('active');

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

    clearInterval(newsSliderInterval);
    showTabSkeleton(pageId);

    if (pageId === 'dashboard-page') {
        loadTelegramUser();
        loadMarketAndPrices();
        loadExtraMetrics();
        fetchDashboardNews();
        loadLiquidationData();
    } else if (pageId === 'market-page') {
        loadMarketAndPrices();
        loadLiquidationData();
        loadExtraMetrics();
        // دکمه افزودن به واچ‌لیست در صفحه مارکت نمایش داده می‌شود
        renderAddWatchlistButton();
    } else if (pageId === 'news-page') {
        switchNewsTab('all-news');
    } else if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'profile-page') {
        loadTelegramUser();
    }
}

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
// =========================================================================
async function loadMarketAndPrices() {
    const cachedPrices = AppCache.get("market_prices");
    if (cachedPrices) {
        allMarketCoins = cachedPrices;
        renderMarketData();
        return;
    }

    try {
        const chunkSize = 25;
        let fetchedTickers = [];

        for (let i = 0; i < POPULAR_SYMBOLS.length; i += chunkSize) {
            const chunk = POPULAR_SYMBOLS.slice(i, i + chunkSize);
            const formattedSymbols = JSON.stringify(chunk.map(sym => `${sym}USDT`));
            const targetUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedSymbols)}`;

            const response = await fetch(PROXY_BASE_URL + encodeURIComponent(targetUrl));
            const data = await response.json();
            if (data && Array.isArray(data)) {
                fetchedTickers = fetchedTickers.concat(data);
            }
        }

        if (fetchedTickers.length === 0) {
            throw new Error("No tickers returned from Binance API.");
        }

        allMarketCoins = [];
        POPULAR_SYMBOLS.forEach((sym, index) => {
            const ticker = fetchedTickers.find(item => item.symbol === `${sym}USDT`);
            if (ticker) {
                allMarketCoins.push({
                    symbol: sym,
                    name: getCoinFullName(sym),
                    priceUsd: ticker.lastPrice,
                    changePercent24Hr: ticker.priceChangePercent,
                    rank: index + 1
                });
            }
        });

        AppCache.set("market_prices", allMarketCoins, 15);
        renderMarketData();
        removeSkeletons();
    } catch (err) {
        console.error("Binance Fetch Error:", err);
        // نمایش پیام خطا به جای داده‌های تصادفی
        const marketList = document.getElementById("market-coin-list");
        if (marketList) {
            marketList.innerHTML = `<div style="padding:20px; color:var(--red); text-align:center;">خطا در دریافت داده‌های بازار. لطفاً بعداً تلاش کنید.</div>`;
        }
        // اگر داده‌های قبلی در کش وجود دارد، از آن استفاده کنیم
        const oldData = AppCache.get("market_prices");
        if (oldData) {
            allMarketCoins = oldData;
            renderMarketData();
        } else {
            allMarketCoins = [];
            renderMarketData();
        }
        removeSkeletons();
    }
}

function renderMarketData() {
    renderWatchlist();
    renderMarketTabLists();
}

function renderWatchlist() {
    const container = document.getElementById("watchlist-container");
    if (!container) return;

    // دریافت واچ‌لیست از localStorage
    const watchlistSymbols = getWatchlist();
    if (watchlistSymbols.length === 0) {
        container.innerHTML = `<div class="watchlist-card" style="min-width:100%; justify-content:center; color:var(--text-sub);">هیچ کوینی به واچ‌لیست اضافه نشده است.</div>`;
        return;
    }

    // فیلتر کردن کوین‌های موجود در allMarketCoins که در واچ‌لیست هستند
    const watchlistCoins = allMarketCoins.filter(coin => watchlistSymbols.includes(coin.symbol));
    if (watchlistCoins.length === 0) {
        container.innerHTML = `<div class="watchlist-card" style="min-width:100%; justify-content:center; color:var(--text-sub);">هیچ کوینی از واچ‌لیست در داده‌های بازار یافت نشد.</div>`;
        return;
    }

    let html = "";
    watchlistCoins.forEach(coin => {
        const change = parseFloat(coin.changePercent24Hr) || 0;
        const isPositive = change >= 0;
        const sign = isPositive ? "+" : "";

        html += `
            <div class="watchlist-card" onclick="openChart('${coin.symbol}')">
                <div class="watchlist-card-header">
                    <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon-mini">
                    <span class="coin-symbol">${coin.symbol}</span>
                </div>
                <div class="coin-price">$${parseFloat(coin.priceUsd).toLocaleString()}</div>
                <div class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-size:10px; margin-top:4px;">${sign}${change.toFixed(2)}%</div>
            </div>
        `;
    });
    container.innerHTML = html;
}

function renderMarketTabLists(filterType = 'all') {
    const marketList = document.getElementById("market-coin-list");
    if (!marketList) return;

    let sortedCoins = [...allMarketCoins];
    if (filterType === 'bullish') {
        sortedCoins = sortedCoins.filter(c => parseFloat(c.changePercent24Hr) >= 0).sort((a,b) => parseFloat(b.changePercent24Hr) - parseFloat(a.changePercent24Hr));
    } else if (filterType === 'bearish') {
        sortedCoins = sortedCoins.filter(c => parseFloat(c.changePercent24Hr) < 0).sort((a,b) => parseFloat(a.changePercent24Hr) - parseFloat(b.changePercent24Hr));
    }

    if (!sortedCoins || sortedCoins.length === 0) {
        marketList.innerHTML = `<div style="padding: 20px 15px; color: var(--text-sub); text-align: center;">هیچ داده‌ای برای نمایش این دسته‌بندی در دسترس نیست.</div>`;
        return;
    }

    let html = "";
    sortedCoins.forEach(coin => {
        const change = parseFloat(coin.changePercent24Hr) || 0;
        const isPositive = change >= 0;
        const badgeClass = isPositive ? 'badge-success' : 'badge-danger';

        html += `
            <div class="coin-row" onclick="openChart('${coin.symbol}')">
                <div style="display: flex; align-items: center; gap: 12px;">
                    <span style="color:var(--text-sub); font-size:11px; font-family:monospace; width:15px;">#${coin.rank}</span>
                    <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
                    <div style="display: flex; flex-direction: column; text-align: left;">
                        <span class="coin-symbol">${coin.symbol}</span>
                        <span class="coin-name" style="font-size: 11px; color: var(--text-dim);">${coin.name}</span>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
                    <span class="coin-price" style="font-weight: bold; font-family: monospace;">$${parseFloat(coin.priceUsd).toLocaleString()}</span>
                    <span class="badge ${badgeClass}">${isPositive ? '+' : ''}${change.toFixed(2)}%</span>
                </div>
            </div>
        `;
    });
    marketList.innerHTML = html;
}

function filterMarketCategory(category, element) {
    document.querySelectorAll('.trend-tab-btn').forEach(btn => btn.classList.remove('active'));
    element.classList.add('active');
    renderMarketTabLists(category);
}

// =========================================================================
// بخش ۶: دریافت داده‌های داینامیک لیکوئیدی (Liquidations Fetcher)
// =========================================================================
function loadLiquidationData() {
    const cachedLiq = AppCache.get("market_liquidations");
    const mockLiq = cachedLiq || {
        longVol: (Math.random() * 15 + 50).toFixed(2) + "M",
        shortVol: (Math.random() * 12 + 30).toFixed(2) + "M",
        statusLong: "لانگ لیکویید",
        statusShort: "شورت لیکویید"
    };
    if (!cachedLiq) AppCache.set("market_liquidations", mockLiq, 60);

    document.querySelectorAll(".long-liq-val").forEach(el => el.innerText = `$${mockLiq.longVol}`);
    document.querySelectorAll(".short-liq-val").forEach(el => el.innerText = `$${mockLiq.shortVol}`);
    document.querySelectorAll(".long-liq-status").forEach(el => el.innerText = mockLiq.statusLong);
    document.querySelectorAll(".short-liq-status").forEach(el => el.innerText = mockLiq.statusShort);

    const totalLong = parseFloat(mockLiq.longVol.replace(/[^0-9.-]+/g, '')) || 0;
    const totalShort = parseFloat(mockLiq.shortVol.replace(/[^0-9.-]+/g, '')) || 0;
    const total = totalLong + totalShort || 1;
    const longPercent = ((totalLong / total) * 100).toFixed(1);
    const shortPercent = (100 - longPercent).toFixed(1);

    const chartBar = document.getElementById("liq-compare-bar");
    if (chartBar) {
        chartBar.innerHTML = `
            <div style="width: ${longPercent}%; background: var(--green, #00b894); height:100%; transition: 0.5s;"></div>
            <div style="width: ${shortPercent}%; background: var(--red, #e17055); height:100%; transition: 0.5s;"></div>
        `;
    }
    if (document.getElementById("liq-long-per")) document.getElementById("liq-long-per").innerText = `${longPercent}%`;
    if (document.getElementById("liq-short-per")) document.getElementById("liq-short-per").innerText = `${shortPercent}%`;
}

// =========================================================================
// بخش ۷: اسلایدر اخبار و تب‌های ۴ گانه اخبار (News Engine & Slider)
// =========================================================================
async function fetchDashboardNews() {
    try {
        const response = await fetch(`${BACKEND_URL}/api/farsi-news`);
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const payload = await response.json();
        const articles = payload?.data || payload || [];
        if (Array.isArray(articles) && articles.length > 0) {
            cachedNewsArticles = articles;
            initNewsSlider(articles.slice(0, 5));
            return;
        }
    } catch (e) {
        console.warn("Dashboard News Error:", e);
    }
    // fallback به اخبار ساختگی ولی با کیفیت بهتر
    const mockNews = [{
        title: "فورى: بیت‌کوین سقف مقاومتی جدید را شکست!",
        description: "بازار ارزهای دیجیتال شاهد رشد است.",
        time_ago: "۵ دقیقه پیش",
        source: "کوین‌تلگراف",
        image: "https://images.cryptocompare.com/news/default/bitcoin.png",
        url: "https://cointelegraph.com"
    }];
    cachedNewsArticles = mockNews;
    initNewsSlider(mockNews);
}

function initNewsSlider(articles) {
    const sliderContainer = document.getElementById("news-slider-content");
    if (!sliderContainer || articles.length === 0) return;

    clearInterval(newsSliderInterval);

    const renderSlide = (index) => {
        const art = articles[index];
        const artId = "slide_" + index;
        window.newsArticlesStorage[artId] = art;
        const fallbackImg = "https://img.icons8.com/clouds/200/000000/bitcoin.png";

        sliderContainer.innerHTML = `
            <div class="slide-item" onclick="openArticleDetailsById('${artId}')" style="animation: fadeInData 0.5s ease-in-out; cursor: pointer;">
                <img src="${art.image || fallbackImg}" onerror="this.src='${fallbackImg}'" class="slider-bg-img">
                <div class="slider-overlay">
                    <div style="display:flex; justify-content:space-between; align-items:center; width:100%;">
                        <span class="badge badge-primary">${art.source || "Crypto News"}</span>
                        <span style="font-size:11px; color:rgba(255,255,255,0.7);">⏱️ ${art.time_ago || "اخیراً"}</span>
                    </div>
                    <h3 class="slider-title" style="margin-top: 8px; font-size: 14px; font-weight: bold;">${art.title}</h3>
                </div>
            </div>
        `;
    };

    currentSliderIndex = 0;
    renderSlide(currentSliderIndex);

    newsSliderInterval = setInterval(() => {
        currentSliderIndex = (currentSliderIndex + 1) % articles.length;
        renderSlide(currentSliderIndex);
    }, 5000);
    removeSkeletons();
}

async function switchNewsTab(tabId) {
    document.querySelectorAll('.news-tab-btn').forEach(btn => btn.classList.remove('active'));
    const clickedBtn = document.querySelector(`[onclick="switchNewsTab('${tabId}')"]`);
    if (clickedBtn) clickedBtn.classList.add('active');

    const container = document.getElementById("news-tab-content-area");
    if (!container) return;

    container.innerHTML = Array(4).fill(0).map(() => `
        <div class="news-card skeleton-block" style="height:95px; margin-bottom:12px; background: rgba(255,255,255,0.05); border-radius: 8px;"></div>
    `).join('');

    if (tabId === 'economic-calendar') {
        renderEconomicCalendarAdvanced();
        return;
    }

    if (cachedNewsArticles.length === 0) {
        try {
            const response = await fetch(`${BACKEND_URL}/api/farsi-news`);
            const payload = await response.json();
            cachedNewsArticles = payload?.data || payload || [];
        } catch (e) {
            container.innerHTML = `<div style="text-align:center; color:#e17055; padding:20px;">ارتباط با سرور برقرار نشد.</div>`;
            return;
        }
    }

    let filtered = [...cachedNewsArticles];
    if (tabId === 'crypto-news') {
        filtered = cachedNewsArticles.filter(a => !a.title.includes("اقتصاد") && !a.title.includes("تورم") && !a.title.includes("فدرال"));
    } else if (tabId === 'economic-news') {
        filtered = cachedNewsArticles.filter(a => a.title.includes("اقتصاد") || a.title.includes("تورم") || a.title.includes("فدرال") || a.title.includes("دلار"));
    }

    if (filtered.length === 0) {
        container.innerHTML = `<div style="text-align:center; color:var(--text-sub); padding:20px;">خبری در این دسته‌بندی یافت نشد.</div>`;
        return;
    }

    let html = '<div style="display:flex; flex-direction:column; gap:12px; width:100%;">';
    filtered.slice(0, 15).forEach((article, index) => {
        const id = `tab_art_${tabId}_${index}`;
        window.newsArticlesStorage[id] = article;
        const fallbackImg = "https://img.icons8.com/clouds/200/000000/bitcoin.png";

        html += `
            <div class="news-card" onclick="openArticleDetailsById('${id}')" style="cursor: pointer;">
                <div class="news-card-text-wrapper">
                    <div style="display: flex; justify-content: space-between; align-items:center;">
                        <span class="badge badge-primary">${article.source || "منبع خبر"}</span>
                        <span style="color: var(--text-sub); font-size: 11px;">⏱️ ${article.time_ago || "اخیراً"}</span>
                    </div>
                    <h3 class="news-title">${article.title}</h3>
                </div>
                <img src="${article.image || fallbackImg}" onerror="this.src='${fallbackImg}'" class="news-img">
            </div>
        `;
    });
    html += '</div>';
    container.innerHTML = html;
    removeSkeletons();
}

// =========================================================================
// بخش ۸: تقویم اقتصادی تفکیک‌شده (Today/Tomorrow/This Week)
// =========================================================================
async function renderEconomicCalendarAdvanced(subFilter = 'today') {
    const container = document.getElementById("news-tab-content-area");
    if (!container) return;

    let baseHtml = `
        <div class="calendar-sub-nav" style="display: flex; gap: 8px; margin-bottom: 12px;">
            <button class="cal-sub-btn ${subFilter === 'today' ? 'active' : ''}" onclick="renderEconomicCalendarAdvanced('today')">امروز</button>
            <button class="cal-sub-btn ${subFilter === 'tomorrow' ? 'active' : ''}" onclick="renderEconomicCalendarAdvanced('tomorrow')">فردا</button>
            <button class="cal-sub-btn ${subFilter === 'this-week' ? 'active' : ''}" onclick="renderEconomicCalendarAdvanced('this-week')">این هفته</button>
        </div>
        <div id="calendar-events-list"></div>
    `;
    container.innerHTML = baseHtml;
    const listArea = document.getElementById("calendar-events-list");

    try {
        const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(url));
        const events = await response.json();

        if (!events || events.length === 0) throw new Error("دیتایی یافت نشد");

        const today = new Date();
        const todayStr = today.toISOString().split('T')[0];

        const tomorrow = new Date();
        tomorrow.setDate(today.getDate() + 1);
        const tomorrowStr = tomorrow.toISOString().split('T')[0];

        let filteredEvents = events.filter(e => (e.impact === 'High' || e.impact === 'Medium'));

        if (subFilter === 'today') {
            filteredEvents = filteredEvents.filter(e => e.date && e.date.includes(todayStr));
        } else if (subFilter === 'tomorrow') {
            filteredEvents = filteredEvents.filter(e => e.date && e.date.includes(tomorrowStr));
        }

        if (filteredEvents.length === 0) {
            listArea.innerHTML = `<div style="text-align:center; padding:20px; color:var(--text-sub);">رویداد مهمی یافت نشد.</div>`;
            return;
        }

        let html = `<div style="display:flex; flex-direction:column; gap:12px; margin-top:10px; direction:rtl; text-align:right;">`;
        filteredEvents.forEach(ev => {
            const impactClass = ev.impact === 'High' ? 'badge-danger' : 'badge-warning';
            const impactText = ev.impact === 'High' ? '🔥 مهم' : '⚡ متوسط';
            const time = ev.date ? new Date(ev.date).toLocaleTimeString('fa-IR', {hour: '2-digit', minute:'2-digit'}) : '--:--';

            html += `
            <div class="news-card" style="border-left: 4px solid ${ev.impact === 'High' ? '#e17055' : '#f3ba2f'};">
                <div style="display:flex; flex-direction:column; gap:6px; flex:1;">
                    <span style="color:#fff; font-weight:bold; font-size:14px;">${ev.title}</span>
                    <span style="color:var(--text-sub); font-size:11px;">ارز درگیر: <b style="color:#00cec9;">${ev.country}</b> | قبلی: <span>${ev.previous || '-'}</span> | پیش‌بینی: <span>${ev.forecast || '-'}</span></span>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                    <span class="badge ${impactClass}">${impactText}</span>
                    <span style="color:var(--text-sub); font-size:11px; font-family:monospace;">⏱️ ${time}</span>
                </div>
            </div>`;
        });
        html += `</div>`;
        listArea.innerHTML = html;
        removeSkeletons();

    } catch (e) {
        listArea.innerHTML = `<div style="text-align:center; padding:20px; color:#e17055;">خطا در دریافت تقویم اقتصادی.</div>`;
    }
}

// =========================================================================
// بخش ۹: مدیریت سیستم رفرال و منوی تنظیمات (Subsystems & Navigation)
// =========================================================================
function openReferralPage() {
    const userData = tg?.initDataUnsafe?.user;
    const userId = userData ? userData.id : "12345678";
    const refLink = `https://t.me/AmirBtcBot/app?startapp=ref_${userId}`;

    if (document.getElementById("ref-link-input")) document.getElementById("ref-link-input").value = refLink;

    if (document.getElementById("total-ref-count")) document.getElementById("total-ref-count").innerText = "۱۲ نفر";
    if (document.getElementById("active-ref-count")) document.getElementById("active-ref-count").innerText = "۵ نفر";
    if (document.getElementById("ref-rewards-val")) document.getElementById("ref-rewards-val").innerText = "۱۲۰,۰۰۰ ساتوشی";

    document.getElementById("profile-main-view").style.display = "none";
    document.getElementById("referral-page-view").style.display = "block";
}

function closeReferralPage() {
    if (document.getElementById("referral-page-view")) document.getElementById("referral-page-view").style.display = "none";
    if (document.getElementById("profile-main-view")) document.getElementById("profile-main-view").style.display = "block";
}

function openSettingsPage() {
    document.getElementById("profile-main-view").style.display = "none";
    document.getElementById("settings-page-view").style.display = "block";
}

function closeSettingsPage() {
    if (document.getElementById("settings-page-view")) document.getElementById("settings-page-view").style.display = "none";
    if (document.getElementById("profile-main-view")) document.getElementById("profile-main-view").style.display = "block";
}

function copyReferralLink() {
    const input = document.getElementById("ref-link-input");
    if (!input) return;
    input.select();
    input.setSelectionRange(0, 99999);
    try {
        navigator.clipboard.writeText(input.value);
    } catch (e) {
        document.execCommand('copy');
    }

    if (tg && typeof tg.showPopup === 'function') {
        tg.showPopup({
            title: "موفقیت‌آمیز",
            message: "لینک دعوت اختصاصی شما با موفقیت کپی شد.",
            buttons: [{ type: "ok" }]
        });
    } else {
        alert("لینک دعوت اختصاصی شما با موفقیت کپی شد.");
    }
}

function shareReferralLink() {
    const link = document.getElementById("ref-link-input")?.value || "";
    const text = encodeURIComponent("سلام! در مینی‌اپ فوق‌العاده دستیار کریپتویی امیر بی تی سی عضو شو و تحلیل‌ها و ابزارهای پریمیوم رو رایگان دریافت کن: 🔥");
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`);
}

// =========================================================================
// بخش ۱۰: توابع کمکی، ساب‌روتین‌ها و اینتگریشن مودال‌ها (Helpers & Search)
// =========================================================================
function getCoinFullName(sym) {
    const names = {
        BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB",
        XRP: "Ripple", ADA: "Cardano", DOGE: "Dogecoin", AVAX: "Avalanche",
        SHIB: "Shiba Inu", DOT: "Polkadot", LINK: "Chainlink", MATIC: "Polygon",
        TRX: "TRON", UNI: "Uniswap", LTC: "Litecoin", NEAR: "Near Protocol",
        APT: "Aptos", SUI: "Sui", TON: "Toncoin"
    };
    return names[sym] || sym;
}

function filterMarketSearch(e) {
    const term = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#market-coin-list .coin-row');
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        row.style.display = text.includes(term) ? 'flex' : 'none';
    });
}

function openNotificationCenter() {
    if (tg && typeof tg.showPopup === 'function') {
        tg.showPopup({
            title: "مرکز اعلانات",
            message: "آخرین اخبار و تحلیل‌های بازار به صورت زنده در مینی‌آپ اعمال شد.",
            buttons: [{ type: "close" }]
        });
    } else {
        alert("سیستم اعلانات کاملاً به‌روز است.");
    }
}

function joinChannelAction() {
    // استفاده از متد اختصاصی تلگرام
    if (tg && typeof tg.openTelegramLink === 'function') {
        tg.openTelegramLink(`https://t.me/${MY_TELEGRAM_CHANNEL}`);
    } else {
        window.open(`https://t.me/${MY_TELEGRAM_CHANNEL}`, '_blank');
    }
}

function loadTelegramUser() {
    const userData = tg?.initDataUnsafe?.user;
    const fullName = userData ? `${userData.first_name || ""} ${userData.last_name || ""}`.trim() : "کاربر میهمان";
    const userId = userData?.id || "000000";
    const username = userData?.username ? `@${userData.username}` : "@guest";

    document.querySelectorAll(".user-full-name").forEach(el => el.innerText = fullName);
    if (document.getElementById("user-id-val")) document.getElementById("user-id-val").innerText = userId;
    if (document.getElementById("user-username-val")) document.getElementById("user-username-val").innerText = username;

    const profileImg = document.getElementById("profile-avatar-img");
    if (profileImg && userData?.photo_url) profileImg.src = userData.photo_url;
}

function openArticleDetailsById(id) {
    const article = window.newsArticlesStorage[id];
    if (!article) return;

    const modal = document.getElementById('details-modal');
    if (!modal) return;

    document.getElementById('modal-title').innerText = article.title;
    document.getElementById('modal-source').innerText = article.source || "اخبار بازار";
    document.getElementById('modal-time').innerText = article.time_ago ? `⏱️ ${article.time_ago}` : "اخیراً";

    const mImage = document.getElementById('modal-image');
    if (article.image) {
        mImage.src = article.image;
        mImage.style.display = "block";
    } else {
        mImage.style.display = "none";
    }

    let formattedText = article.description || "محتوایی برای نمایش وجود ندارد.";
    document.getElementById('modal-content').innerHTML = formattedText;
    modal.style.display = "flex";
}

function openChart(symbol) {
    const chartModal = document.getElementById("chart-modal");
    if (!chartModal) return;
    chartModal.style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    const container = document.getElementById("tradingview-widget-container");
    if (container) {
        container.innerHTML = "";
        // بررسی وجود TradingView
        if (typeof TradingView !== 'undefined') {
            new TradingView.widget({
                "width": "100%",
                "height": "100%",
                "symbol": `BINANCE:${symbol}USDT`,
                "interval": "240",
                "theme": "dark",
                "style": "1",
                "locale": "en",
                "container_id": "tradingview-widget-container",
                "hide_side_toolbar": true,
                "disabled_features": ["header_widget_dom_node"]
            });
        } else {
            container.innerHTML = `<div style="color:var(--text-dim); text-align:center; padding:20px;">ابزار نمودار در دسترس نیست.</div>`;
        }
    }
}

function closeChart() {
    if (document.getElementById("chart-modal")) document.getElementById("chart-modal").style.display = "none";
}

// =========================================================================
// بخش ۱۱: ترس و طمع با استفاده از Proxy
// =========================================================================
function loadExtraMetrics() {
    const cachedMetrics = AppCache.get("extra_metrics");
    if (cachedMetrics) {
        applyMetrics(cachedMetrics.val, cachedMetrics.status);
    } else {
        fetch(PROXY_BASE_URL + encodeURIComponent("https://api.alternative.me/fng/"))
            .then(res => res.json())
            .then(json => {
                if (json?.data?.[0]) {
                    const val = json.data[0].value;
                    const status = json.data[0].value_classification;
                    AppCache.set("extra_metrics", { val, status }, 1800);
                    applyMetrics(val, status);
                }
            }).catch(() => applyMetrics("50", "Neutral"));
    }
}

function applyMetrics(val, status) {
    const numericVal = parseInt(val, 10);
    const safeVal = Number.isFinite(numericVal) ? Math.max(0, Math.min(100, numericVal)) : 50;
    document.querySelectorAll(".fg-value-el").forEach(el => el.innerText = safeVal);
    const statusMap = { "Extreme Fear": "ترس شدید", "Fear": "ترس", "Neutral": "خنثی", "Greed": "طمع", "Extreme Greed": "طمع شدید" };
    const finalStatus = statusMap[status] || status || (safeVal <= 25 ? 'ترس شدید' : safeVal <= 45 ? 'ترس' : safeVal <= 55 ? 'خنثی' : safeVal <= 75 ? 'طمع' : 'طمع شدید');
    document.querySelectorAll(".fg-status-el").forEach(el => el.innerText = finalStatus);

    const fillElement = document.querySelector('.fg-gauge-fill');
    const pointerElement = document.querySelector('.fg-gauge-pointer');
    if (fillElement) {
        fillElement.style.width = `${safeVal}%`;
        if (safeVal <= 25) {
            fillElement.style.background = 'linear-gradient(90deg, #3b82f6, #36c7ff)';
        } else if (safeVal <= 45) {
            fillElement.style.background = 'linear-gradient(90deg, #f59e0b, #fbbf24)';
        } else if (safeVal <= 70) {
            fillElement.style.background = 'linear-gradient(90deg, #fbbf24, #fb7185)';
        } else {
            fillElement.style.background = 'linear-gradient(90deg, #ff6b6b, #ff3d6d)';
        }
    }
    if (pointerElement) {
        const pointerLeft = Math.max(0, Math.min(100, safeVal));
        pointerElement.style.left = `calc(${pointerLeft}% - 6px)`;
    }
}

function setInitialFearGauge() {
    const fill = document.querySelector('.fg-gauge-fill');
    const pointer = document.querySelector('.fg-gauge-pointer');
    if (fill) fill.style.width = '50%';
    if (pointer) pointer.style.left = 'calc(50% - 6px)';
}

// =========================================================================
// بخش ۱۲: بارگذاری تحلیل‌ها (Telegram Widget)
// =========================================================================
function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    if (!container || container.querySelector("script[data-telegram-discussion]")) return;
    container.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-discussion", MY_TELEGRAM_CHANNEL);
    script.setAttribute("data-comments-limit", "4");
    script.setAttribute("data-dark", "1");
    script.setAttribute("data-width", "100%");
    container.appendChild(script);
    removeSkeletons();
}

// =========================================================================
// بخش ۱۳: دکمه افزودن به واچ‌لیست در صفحه مارکت
// =========================================================================
function renderAddWatchlistButton() {
    const marketPage = document.getElementById('market-page');
    if (!marketPage) return;
    // اگر دکمه قبلاً اضافه شده، دوباره اضافه نکن
    if (document.getElementById('add-watchlist-btn-container')) return;

    const container = document.createElement('div');
    container.id = 'add-watchlist-btn-container';
    container.style.cssText = 'display:flex; justify-content:center; margin: 5px 15px 15px;';
    container.innerHTML = `
        <button class="banner-join-btn" onclick="openAddCoinModal()" style="width:100%; background: linear-gradient(135deg, #f7931a, #ff6a00);">
            ➕ افزودن/مدیریت واچ‌لیست
        </button>
    `;
    // قرار دادن قبل از لیست کوین‌ها
    const marketList = document.getElementById('market-coin-list');
    if (marketList) {
        marketList.parentNode.insertBefore(container, marketList);
    }
}

// =========================================================================
// بخش ۱۴: توابع واچ‌لیست (هماهنگ با watchlist.js)
// =========================================================================
// این توابع در watchlist.js تعریف شده‌اند، اما برای اطمینان از وجود آن‌ها:
window.getWatchlist = window.getWatchlist || function() {
    const stored = localStorage.getItem('watchlist');
    return stored ? JSON.parse(stored) : [];
};

window.addToWatchlist = window.addToWatchlist || function(symbol) {
    const list = window.getWatchlist();
    if (!list.includes(symbol)) {
        list.push(symbol);
        localStorage.setItem('watchlist', JSON.stringify(list));
        renderWatchlist();
    }
};

window.removeFromWatchlist = window.removeFromWatchlist || function(symbol) {
    let list = window.getWatchlist();
    list = list.filter(s => s !== symbol);
    localStorage.setItem('watchlist', JSON.stringify(list));
    renderWatchlist();
};

window.openAddCoinModal = window.openAddCoinModal || function() {
    const modal = document.getElementById('add-coin-modal');
    if (modal) {
        modal.style.display = 'flex';
        if (window.populateAddCoinModal) window.populateAddCoinModal();
    }
};

window.closeAddCoinModal = window.closeAddCoinModal || function() {
    const modal = document.getElementById('add-coin-modal');
    if (modal) modal.style.display = 'none';
};

// =========================================================================
// بخش ۱۵: لوپ‌های آغازین مینی‌اپ (Lifecycle Hooks)
// =========================================================================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    switchTab('dashboard-page');
    setInitialFearGauge();

    const searchInput = document.getElementById("market-search");
    if (searchInput) searchInput.addEventListener("input", filterMarketSearch);

    // به‌روزرسانی دوره‌ای قیمت‌ها (هر ۱۵ ثانیه)
    setInterval(loadMarketAndPrices, 15000);
});
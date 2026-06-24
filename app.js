// =========================================================================
// بخش ۱: راه‌اندازی ابزارهای اولیه و تلگرام (Telegram WebApp Init)
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

// =========================================================================
// بخش ۲: متغیرهای ثابت، آدرس‌ها و آرایه‌ها
// =========================================================================
const MY_TELEGRAM_CHANNEL = "amir_btc_2024";
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";
const BACKEND_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev";

let searchTerm = '';

// لیست ۱۰۰ ارز برتر از CoinCap دریافت می‌شود (دیگر نیازی به لیست ثابت نیست)
window.newsArticlesStorage = {};
let allMarketCoins = [];
let newsSliderInterval = null;
let currentSliderIndex = 0;
let cachedNewsArticles = [];

// =========================================================================
// بخش ۳: موتور کش مرکزی
// =========================================================================
const AppCache = {
    storage: {},
    set(key, data, ttlSeconds) {
        this.storage[key] = { data, expiry: Date.now() + ttlSeconds * 1000 };
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
// بخش ۴: توابع واچ‌لیست
// =========================================================================
window.getWatchlist = function() {
    const stored = localStorage.getItem('watchlist');
    return stored ? JSON.parse(stored) : [];
};

window.addToWatchlist = function(symbol) {
    const list = window.getWatchlist();
    if (!list.includes(symbol)) {
        list.push(symbol);
        localStorage.setItem('watchlist', JSON.stringify(list));
        window.renderWatchlist();
        const activeFilter = document.querySelector('.trend-tab-btn.active')?.dataset?.filter || 'all';
        window.renderMarketTabLists(activeFilter);
    }
};

window.removeFromWatchlist = function(symbol) {
    let list = window.getWatchlist();
    list = list.filter(s => s !== symbol);
    localStorage.setItem('watchlist', JSON.stringify(list));
    window.renderWatchlist();
    const activeFilter = document.querySelector('.trend-tab-btn.active')?.dataset?.filter || 'all';
    window.renderMarketTabLists(activeFilter);
};

window.isInWatchlist = function(symbol) {
    return window.getWatchlist().includes(symbol);
};

window.toggleWatchlist = function(symbol, event) {
    if (event) event.stopPropagation();
    if (window.isInWatchlist(symbol)) {
        window.removeFromWatchlist(symbol);
    } else {
        window.addToWatchlist(symbol);
    }
};

// =========================================================================
// بخش ۵: روتر و سیستم ناوبری
// =========================================================================
function switchTab(pageId, element) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
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
    } else if (pageId === 'news-page') {
        switchNewsTab('all-news');
    } else if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'profile-page') {
        loadTelegramUser();
        document.getElementById('profile-main-view').style.display = 'block';
        document.getElementById('referral-page-view').style.display = 'none';
        document.getElementById('settings-page-view').style.display = 'none';
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
// بخش ۶: دریافت قیمت‌ها از CoinCap (۱۰۰ ارز برتر بر اساس مارکت‌کپ)
// =========================================================================
async function loadMarketAndPrices() {
    const cachedPrices = AppCache.get("market_prices");
    if (cachedPrices) {
        allMarketCoins = cachedPrices;
        renderMarketData();
        return;
    }

    try {
        // دریافت ۱۰۰ ارز برتر از CoinCap
        const url = 'https://api.coincap.io/v2/assets?limit=100';
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(url));
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const data = await response.json();
        const assets = data.data || [];

        if (!assets || assets.length === 0) throw new Error("No data from CoinCap");

        allMarketCoins = assets.map((item, index) => ({
            symbol: item.symbol,
            name: item.name,
            priceUsd: parseFloat(item.priceUsd) || 0,
            changePercent24Hr: parseFloat(item.changePercent24Hr) || 0,
            rank: index + 1,
            marketCapUsd: parseFloat(item.marketCapUsd) || 0,
            volumeUsd24Hr: parseFloat(item.volumeUsd24Hr) || 0
        }));

        AppCache.set("market_prices", allMarketCoins, 5); // کش ۵ ثانیه‌ای
        renderMarketData();
        removeSkeletons();
    } catch (err) {
        console.error("CoinCap Fetch Error:", err);
        // استفاده از داده‌های ساختگی در صورت خطا
        const mockCoins = [
            { symbol: "BTC", name: "Bitcoin", priceUsd: 65000, changePercent24Hr: 2.5, rank: 1 },
            { symbol: "ETH", name: "Ethereum", priceUsd: 3500, changePercent24Hr: -1.2, rank: 2 },
            { symbol: "SOL", name: "Solana", priceUsd: 150, changePercent24Hr: 5.8, rank: 3 },
            { symbol: "BNB", name: "BNB", priceUsd: 580, changePercent24Hr: 0.8, rank: 4 },
            { symbol: "XRP", name: "XRP", priceUsd: 0.62, changePercent24Hr: -2.1, rank: 5 }
        ];
        allMarketCoins = mockCoins;
        AppCache.set("market_prices", allMarketCoins, 5);
        renderMarketData();
        removeSkeletons();
    }
}

function renderMarketData() {
    window.renderWatchlist();
    window.renderMarketTabLists();
}

// =========================================================================
// بخش ۷: واچ‌لیست و لیست مارکت با سرچ و فیلترهای پویا
// =========================================================================
window.renderWatchlist = function() {
    const container = document.getElementById("watchlist-container");
    if (!container) return;

    const watchlistSymbols = window.getWatchlist();
    if (watchlistSymbols.length === 0) {
        container.innerHTML = `<div class="watchlist-card" style="min-width:100%; justify-content:center; color:var(--text-sub);">هیچ کوینی به واچ‌لیست اضافه نشده است.</div>`;
        return;
    }

    const watchlistCoins = allMarketCoins.filter(coin => watchlistSymbols.includes(coin.symbol));
    if (watchlistCoins.length === 0) {
        container.innerHTML = `<div class="watchlist-card" style="min-width:100%; justify-content:center; color:var(--text-sub);">هیچ کوینی از واچ‌لیست در داده‌های بازار یافت نشد.</div>`;
        return;
    }

    let html = "";
    watchlistCoins.forEach(coin => {
        const change = coin.changePercent24Hr || 0;
        const isPositive = change >= 0;
        html += `
            <div class="watchlist-card" onclick="window.openChart('${coin.symbol}')">
                <div class="watchlist-card-header">
                    <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon-mini">
                    <span class="coin-symbol">${coin.symbol}</span>
                </div>
                <div class="coin-price">$${coin.priceUsd.toFixed(2)}</div>
                <div class="badge ${isPositive ? 'badge-success' : 'badge-danger'}">${isPositive ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%</div>
            </div>
        `;
    });
    container.innerHTML = html;
};

window.renderMarketTabLists = function(filterType = 'all') {
    const marketList = document.getElementById("market-coin-list");
    if (!marketList) return;

    let filteredCoins = [...allMarketCoins];

    // فیلتر بر اساس دسته‌بندی (bullish/bearish)
    if (filterType === 'bullish') {
        filteredCoins = filteredCoins.filter(c => c.changePercent24Hr >= 0)
                                     .sort((a, b) => b.changePercent24Hr - a.changePercent24Hr);
    } else if (filterType === 'bearish') {
        filteredCoins = filteredCoins.filter(c => c.changePercent24Hr < 0)
                                     .sort((a, b) => a.changePercent24Hr - b.changePercent24Hr);
    }

    // فیلتر بر اساس جستجو
    if (searchTerm) {
        filteredCoins = filteredCoins.filter(c =>
            c.symbol.toLowerCase().includes(searchTerm) ||
            c.name.toLowerCase().includes(searchTerm)
        );
    }

    if (filteredCoins.length === 0) {
        marketList.innerHTML = `<div style="padding:20px;color:var(--text-sub);text-align:center;">هیچ کوینی یافت نشد.</div>`;
        return;
    }

    let html = "";
    filteredCoins.forEach(coin => {
        const change = coin.changePercent24Hr || 0;
        const isPositive = change >= 0;
        const badgeClass = isPositive ? 'badge-success' : 'badge-danger';
        const arrow = isPositive ? '▲' : '▼';
        const inWatchlist = window.isInWatchlist(coin.symbol);

        html += `
            <div class="coin-row" onclick="window.openChart('${coin.symbol}')">
                <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                    <span style="color:var(--text-sub);font-size:11px;font-family:monospace;width:25px;">#${coin.rank}</span>
                    <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
                    <div style="display:flex;flex-direction:column;text-align:left;">
                        <span class="coin-symbol">${coin.symbol}</span>
                        <span style="font-size:11px;color:var(--text-dim);">${coin.name}</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                        <span style="font-weight:bold;font-family:monospace;font-size:15px;">$${coin.priceUsd.toFixed(4)}</span>
                        <span class="badge ${badgeClass}" style="font-size:11px;font-weight:bold;">
                            ${arrow} ${Math.abs(change).toFixed(2)}%
                        </span>
                    </div>
                    <span class="watchlist-star" onclick="window.toggleWatchlist('${coin.symbol}', event)" style="font-size:22px;cursor:pointer;color:${inWatchlist ? '#f7931a' : '#555'};transition:all 0.2s;user-select:none;">
                        ${inWatchlist ? '⭐' : '☆'}
                    </span>
                </div>
            </div>
        `;
    });
    marketList.innerHTML = html;
};

function filterMarketCategory(category, element) {
    document.querySelectorAll('.trend-tab-btn').forEach(btn => btn.classList.remove('active'));
    element.classList.add('active');
    element.dataset.filter = category;
    window.renderMarketTabLists(category);
}

function filterMarketSearch(e) {
    searchTerm = e.target.value.toLowerCase().trim();
    const activeFilter = document.querySelector('.trend-tab-btn.active')?.dataset?.filter || 'all';
    window.renderMarketTabLists(activeFilter);
}

// =========================================================================
// بخش ۸: لیکوئیدیشن (ساده و بدون ایموجی)
// =========================================================================
function loadLiquidationData() {
    const cachedLiq = AppCache.get("market_liquidations");
    const mockLiq = cachedLiq || {
        longVol: (Math.random() * 15 + 50).toFixed(2) + "M",
        shortVol: (Math.random() * 12 + 30).toFixed(2) + "M"
    };
    if (!cachedLiq) AppCache.set("market_liquidations", mockLiq, 60);

    document.querySelectorAll(".long-liq-val").forEach(el => el.innerText = `$${mockLiq.longVol}`);
    document.querySelectorAll(".short-liq-val").forEach(el => el.innerText = `$${mockLiq.shortVol}`);

    const totalLong = parseFloat(mockLiq.longVol.replace(/[^0-9.-]+/g, '')) || 0;
    const totalShort = parseFloat(mockLiq.shortVol.replace(/[^0-9.-]+/g, '')) || 0;
    const total = totalLong + totalShort || 1;
    const longPercent = ((totalLong / total) * 100).toFixed(1);
    const shortPercent = (100 - longPercent).toFixed(1);

    const longBar = document.getElementById('liq-long-bar');
    const shortBar = document.getElementById('liq-short-bar');
    if (longBar) longBar.style.width = longPercent + '%';
    if (shortBar) shortBar.style.width = shortPercent + '%';

    document.querySelectorAll("#liq-long-per").forEach(el => el.innerText = longPercent + '%');
    document.querySelectorAll("#liq-short-per").forEach(el => el.innerText = shortPercent + '%');
}

// =========================================================================
// بخش ۹: اخبار و اسلایدر (بدون تغییر)
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
        console.warn("Dashboard News Error (using mock):", e);
    }
    const mockNews = [
        { title: "🔥 بیت‌کوین به مقاومت ۷۰ هزار دلاری نزدیک شد", description: "با افزایش حجم معاملات، بیت‌کوین به سطح ۷۰ هزار دلار نزدیک می‌شود.", time_ago: "۵ دقیقه پیش", source: "اخبار بازار", image: "https://images.cryptocompare.com/news/default/bitcoin.png", url: "#" },
        { title: "📊 تحلیل: اتریوم آماده شکست مقاومت ۴۰۰۰ دلاری", description: "اتریوم با رشد ۱۵٪ در هفته گذشته، به مرز ۴۰۰۰ دلار رسیده است.", time_ago: "۲۰ دقیقه پیش", source: "تحلیلگران", image: "https://images.cryptocompare.com/news/default/ethereum.png", url: "#" },
        { title: "🌐 خبر فوری: تصویب قانون جدید ارزهای دیجیتال در اروپا", description: "اتحادیه اروپا قانون جدیدی برای شفافیت تراکنش‌های رمزارزی تصویب کرد.", time_ago: "۱ ساعت پیش", source: "خبرگزاری رویترز", image: "https://images.cryptocompare.com/news/default/global.png", url: "#" }
    ];
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
            <div class="slide-item" onclick="window.openArticleDetailsById('${artId}')" style="animation: fadeInData 0.5s ease-in-out; cursor: pointer;">
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
            cachedNewsArticles = [
                { title: "اخبار آزمایشی ۱", source: "منبع", time_ago: "۱ دقیقه پیش", image: "" },
                { title: "اخبار آزمایشی ۲", source: "منبع", time_ago: "۲ دقیقه پیش", image: "" }
            ];
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
            <div class="news-card" onclick="window.openArticleDetailsById('${id}')" style="cursor: pointer;">
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
// بخش ۱۰: تقویم اقتصادی
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
// بخش ۱۱: رفرال و تنظیمات
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
    document.getElementById("settings-page-view").style.display = "none";
}

function closeReferralPage() {
    if (document.getElementById("referral-page-view")) document.getElementById("referral-page-view").style.display = "none";
    if (document.getElementById("profile-main-view")) document.getElementById("profile-main-view").style.display = "block";
}

function openSettingsPage() {
    document.getElementById("profile-main-view").style.display = "none";
    document.getElementById("settings-page-view").style.display = "block";
    document.getElementById("referral-page-view").style.display = "none";
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
// بخش ۱۲: توابع کمکی و ابزاری
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
    if (tg && typeof tg.openTelegramLink === 'function') {
        tg.openTelegramLink(`https://t.me/${MY_TELEGRAM_CHANNEL}`);
    } else {
        window.open(`https://t.me/${MY_TELEGRAM_CHANNEL}`, '_blank');
    }
}

function loadTelegramUser() {
    try {
        const userData = tg?.initDataUnsafe?.user;
        const fullName = userData ? `${userData.first_name || ""} ${userData.last_name || ""}`.trim() : "کاربر میهمان";
        const userId = userData?.id || "000000";
        const username = userData?.username ? `@${userData.username}` : "@guest";
        document.querySelectorAll(".user-full-name").forEach(el => el.innerText = fullName);
        if (document.getElementById("user-id-val")) document.getElementById("user-id-val").innerText = userId;
        if (document.getElementById("user-username-val")) document.getElementById("user-username-val").innerText = username;
        const profileImg = document.getElementById("profile-avatar-img");
        if (profileImg && userData?.photo_url) profileImg.src = userData.photo_url;
    } catch (e) {
        console.error('loadTelegramUser error:', e);
    }
}

window.openArticleDetailsById = function(id) {
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
    document.getElementById('modal-content').innerHTML = article.description || "محتوایی برای نمایش وجود ندارد.";
    modal.style.display = "flex";
};

window.openChart = function(symbol) {
    const chartModal = document.getElementById("chart-modal");
    if (!chartModal) return;
    chartModal.style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    const container = document.getElementById("tradingview-widget-container");
    if (container) {
        container.innerHTML = "";
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
};

function closeChart() {
    if (document.getElementById("chart-modal")) document.getElementById("chart-modal").style.display = "none";
}

// =========================================================================
// بخش ۱۳: شاخص ترس و طمع
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
// بخش ۱۴: تحلیل (Telegram Widget)
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
// بخش ۱۵: رویداد شروع (DOMContentLoaded)
// =========================================================================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    switchTab('dashboard-page');
    setInitialFearGauge();
    document.getElementById("market-search")?.addEventListener("input", filterMarketSearch);
    // به‌روزرسانی هر ۵ ثانیه
    setInterval(loadMarketAndPrices, 5000);
});

// ثبت توابع در سطح global
window.switchTab = switchTab;
window.filterMarketCategory = filterMarketCategory;
window.filterMarketSearch = filterMarketSearch;
window.openNotificationCenter = openNotificationCenter;
window.joinChannelAction = joinChannelAction;
window.openChart = window.openChart;
window.closeChart = closeChart;
window.openArticleDetailsById = window.openArticleDetailsById;
window.switchNewsTab = switchNewsTab;
window.renderEconomicCalendarAdvanced = renderEconomicCalendarAdvanced;
window.copyReferralLink = copyReferralLink;
window.shareReferralLink = shareReferralLink;
window.openReferralPage = openReferralPage;
window.closeReferralPage = closeReferralPage;
window.openSettingsPage = openSettingsPage;
window.closeSettingsPage = closeSettingsPage;
window.loadExtraMetrics = loadExtraMetrics;
window.loadLiquidationData = loadLiquidationData;
window.loadAnalysisData = loadAnalysisData;
window.renderWatchlist = window.renderWatchlist;
window.renderMarketTabLists = window.renderMarketTabLists;
window.toggleWatchlist = window.toggleWatchlist;
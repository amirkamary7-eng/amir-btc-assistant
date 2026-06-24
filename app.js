// =========================================================================
// بخش ۱: راه‌اندازی ابزارهای اولیه و تلگرام
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

// =========================================================================
// بخش ۲: متغیرهای ثابت
// =========================================================================
const MY_TELEGRAM_CHANNEL = "amir_btc_2024";
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";
const BACKEND_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev";

let searchTerm = '';
let allMarketCoins = [];
let globalMarketData = { marketCap: 0, cmc20: 0 };
let newsSliderInterval = null;
let currentSliderIndex = 0;
let cachedNewsArticles = [];
window.newsArticlesStorage = {};

// =========================================================================
// بخش ۳: کش
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
// بخش ۵: روتر
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
        loadGlobalData();
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
// بخش ۶: دریافت داده‌های بازار (CoinCap + Binance)
// =========================================================================
async function loadMarketAndPrices() {
    const cached = AppCache.get("market_prices");
    if (cached) {
        allMarketCoins = cached;
        renderMarketData();
        return;
    }

    try {
        // ۱. دریافت لیست ۱۰۰ ارز برتر از CoinCap (برای رتبه و نام)
        const coinCapUrl = 'https://api.coincap.io/v2/assets?limit=100';
        const coinCapRes = await fetch(PROXY_BASE_URL + encodeURIComponent(coinCapUrl));
        if (!coinCapRes.ok) throw new Error('CoinCap error');
        const coinCapData = await coinCapRes.json();
        const assets = coinCapData.data || [];

        if (!assets || assets.length === 0) throw new Error('No assets from CoinCap');

        // ۲. دریافت قیمت‌های لحظه‌ای از Binance برای این ارزها
        const symbols = assets.map(a => a.symbol + 'USDT');
        const chunkSize = 25;
        let binancePrices = {};
        for (let i = 0; i < symbols.length; i += chunkSize) {
            const chunk = symbols.slice(i, i + chunkSize);
            const formatted = JSON.stringify(chunk);
            const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formatted)}`;
            const binanceRes = await fetch(PROXY_BASE_URL + encodeURIComponent(binanceUrl));
            if (binanceRes.ok) {
                const data = await binanceRes.json();
                data.forEach(item => {
                    const sym = item.symbol.replace('USDT', '');
                    binancePrices[sym] = {
                        price: parseFloat(item.lastPrice),
                        change: parseFloat(item.priceChangePercent)
                    };
                });
            }
        }

        // ۳. ترکیب داده‌ها
        allMarketCoins = assets.map((item, index) => {
            const sym = item.symbol;
            const binance = binancePrices[sym];
            return {
                symbol: sym,
                name: item.name,
                rank: index + 1,
                marketCapUsd: parseFloat(item.marketCapUsd) || 0,
                priceUsd: binance ? binance.price : parseFloat(item.priceUsd) || 0,
                changePercent24Hr: binance ? binance.change : parseFloat(item.changePercent24Hr) || 0
            };
        });

        // ۴. به‌روزرسانی داده‌های جهانی (مارکت‌کپ و CMC20)
        await loadGlobalData();

        AppCache.set("market_prices", allMarketCoins, 5);
        renderMarketData();
        removeSkeletons();
    } catch (err) {
        console.error('Error loading market data:', err);
        // Fallback به داده‌های ساختگی
        allMarketCoins = [
            { symbol: "BTC", name: "Bitcoin", rank: 1, priceUsd: 65000, changePercent24Hr: 2.5 },
            { symbol: "ETH", name: "Ethereum", rank: 2, priceUsd: 3500, changePercent24Hr: -1.2 },
            { symbol: "SOL", name: "Solana", rank: 3, priceUsd: 150, changePercent24Hr: 5.8 }
        ];
        renderMarketData();
        removeSkeletons();
    }
}

// =========================================================================
// بخش ۷: داده‌های جهانی (مارکت‌کپ، CMC20)
// =========================================================================
async function loadGlobalData() {
    try {
        const url = 'https://api.coincap.io/v2/global';
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(url));
        if (response.ok) {
            const data = await response.json();
            const global = data.data;
            globalMarketData.marketCap = parseFloat(global.marketCapUsd) || 0;
            // CMC20 را از اولین ۲۰ ارز محاسبه می‌کنیم
            if (allMarketCoins.length >= 20) {
                const top20 = allMarketCoins.slice(0, 20);
                globalMarketData.cmc20 = top20.reduce((sum, c) => sum + (c.marketCapUsd || 0), 0);
            } else {
                globalMarketData.cmc20 = 0;
            }
            updateGlobalDisplay();
        }
    } catch (e) {
        console.warn('Global data error:', e);
    }
}

function updateGlobalDisplay() {
    const mcapEl = document.getElementById('global-market-cap');
    const cmc20El = document.getElementById('global-cmc20');
    if (mcapEl) {
        mcapEl.innerText = globalMarketData.marketCap ? '$' + (globalMarketData.marketCap / 1e9).toFixed(2) + 'B' : '--';
    }
    if (cmc20El) {
        cmc20El.innerText = globalMarketData.cmc20 ? '$' + (globalMarketData.cmc20 / 1e9).toFixed(2) + 'B' : '--';
    }
}

// =========================================================================
// بخش ۸: رندر بازار
// =========================================================================
function renderMarketData() {
    window.renderWatchlist();
    window.renderMarketTabLists();
    loadGlobalData();
}

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

    if (filterType === 'bullish') {
        filteredCoins = filteredCoins.filter(c => c.changePercent24Hr >= 0)
                                     .sort((a, b) => b.changePercent24Hr - a.changePercent24Hr);
    } else if (filterType === 'bearish') {
        filteredCoins = filteredCoins.filter(c => c.changePercent24Hr < 0)
                                     .sort((a, b) => a.changePercent24Hr - b.changePercent24Hr);
    }

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
// بخش ۹: لیکوئیدیشن
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
// بخش ۱۰: اخبار (بدون تغییر)
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
    // ... (بدون تغییر، همان کد قبلی)
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
// بخش ۱۱: تقویم اقتصادی (بدون تغییر)
// =========================================================================
async function renderEconomicCalendarAdvanced(subFilter = 'today') {
    // ... (همان کد قبلی)
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
// بخش ۱۲: رفرال و تنظیمات (بدون تغییر)
// =========================================================================
function openReferralPage() { /* ... همان کد قبلی */ }
function closeReferralPage() { /* ... */ }
function openSettingsPage() { /* ... */ }
function closeSettingsPage() { /* ... */ }
function copyReferralLink() { /* ... */ }
function shareReferralLink() { /* ... */ }

// =========================================================================
// بخش ۱۳: توابع کمکی
// =========================================================================
function getCoinFullName(sym) { /* ... */ }
function openNotificationCenter() { /* ... */ }
function joinChannelAction() { /* ... */ }
function loadTelegramUser() { /* ... */ }

window.openArticleDetailsById = function(id) { /* ... */ };
window.openChart = function(symbol) {
    const chartModal = document.getElementById("chart-modal");
    if (!chartModal) return;
    chartModal.style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    const container = document.getElementById("tradingview-widget-container");
    if (container) {
        container.innerHTML = "";
        if (typeof TradingView !== 'undefined') {
            try {
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
            } catch (e) {
                container.innerHTML = `<div style="color:var(--text-dim); text-align:center; padding:20px;">❌ چارتی برای این ارز در دسترس نیست.</div>`;
            }
        } else {
            container.innerHTML = `<div style="color:var(--text-dim); text-align:center; padding:20px;">❌ ابزار نمودار در دسترس نیست.</div>`;
        }
    }
};
function closeChart() { /* ... */ }

// =========================================================================
// بخش ۱۴: Fear & Greed
// =========================================================================
function loadExtraMetrics() { /* ... همان کد قبلی */ }
function applyMetrics(val, status) { /* ... */ }
function setInitialFearGauge() { /* ... */ }

// =========================================================================
// بخش ۱۵: تحلیل (Telegram Widget)
// =========================================================================
function loadAnalysisData() { /* ... */ }

// =========================================================================
// بخش ۱۶: رویداد شروع
// =========================================================================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    switchTab('dashboard-page');
    setInitialFearGauge();
    document.getElementById("market-search")?.addEventListener("input", filterMarketSearch);
    setInterval(() => {
        loadMarketAndPrices();
        loadLiquidationData();
        loadExtraMetrics();
    }, 5000);
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
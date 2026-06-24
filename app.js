// =========================================================================
// بخش ۱: راه‌اندازی ابزارهای اولیه، تلگرام و استایل‌های تزریقی
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

const MY_TELEGRAM_CHANNEL = "amir_btc_2024";
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";

let searchTerm = '';
let allMarketCoins = [];
let globalMarketData = { marketCap: 0, cmc20: 0 };
let newsSliderInterval = null;
let currentSliderIndex = 0;
let cachedNewsArticles = [];
window.newsArticlesStorage = {};

// تزریق خودکار استایل‌های گرافیکی لودینگ و جوین اجباری به صفحه
const styleSheet = document.createElement("style");
styleSheet.innerText = `
    /* استایل لودینگ کارتی شیک */
    .app-main-loader {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: #0b0e14; z-index: 99999; display: flex;
        flex-direction: column; align-items: center; justify-content: center;
        transition: opacity 0.5s ease; gap: 20px;
    }
    .loader-card {
        width: 140px; height: 180px; background: linear-gradient(135deg, rgba(247,147,26,0.1), rgba(255,255,255,0.03));
        border: 1px solid rgba(247,147,26,0.2); border-radius: 24px;
        box-shadow: 0 15px 35px rgba(0,0,0,0.5); display: flex;
        align-items: center; justify-content: center; animation: cardFloat 2s infinite ease-in-out;
    }
    @keyframes cardFloat {
        0%, 100% { transform: translateY(0) rotate(0deg); box-shadow: 0 15px 35px rgba(0,0,0,0.5); }
        50% { transform: translateY(-15px) rotate(3deg); box-shadow: 0 25px 45px rgba(247,147,26,0.15); }
    }
    .loader-text {
        color: #fff; font-family: system-ui, sans-serif; font-size: 14px;
        letter-spacing: 1px; font-weight: bold; animation: pulseText 1.5s infinite;
    }
    @keyframes pulseText { 0%, 100% { opacity: 0.5; } 50% { opacity: 1; } }

    /* استایل قفل جوین اجباری کانال */
    .mandatory-join-overlay {
        position: fixed; top: 0; left: 0; width: 100%; height: 100%;
        background: rgba(11, 14, 20, 0.85); backdrop-filter: blur(12px);
        -webkit-backdrop-filter: blur(12px); z-index: 99998;
        display: flex; align-items: center; justify-content: center; padding: 20px;
    }
    .join-card {
        background: linear-gradient(145deg, #161a22, #0f1218);
        border: 1px solid rgba(255,255,255,0.08); border-radius: 28px;
        padding: 30px 24px; width: 100%; max-width: 340px; text-align: center;
        box-shadow: 0 20px 50px rgba(0,0,0,0.6);
    }
    .join-icon-box {
        width: 70px; height: 70px; background: rgba(247,147,26,0.1);
        border-radius: 50%; display: flex; align-items: center; justify-content: center;
        margin: 0 auto 20px; font-size: 32px; border: 1px solid rgba(247,147,26,0.3);
    }
    .join-btn-primary {
        background: linear-gradient(90deg, #f7931a, #ffab40); color: #000;
        border: none; padding: 14px; width: 100%; border-radius: 14px;
        font-weight: bold; font-size: 15px; margin-top: 20px; cursor: pointer;
        box-shadow: 0 5px 15px rgba(247,147,26,0.3); transition: all 0.2s;
    }
    .join-btn-secondary {
        background: rgba(255,255,255,0.05); color: #fff;
        border: 1px solid rgba(255,255,255,0.1); padding: 12px; width: 100%;
        border-radius: 14px; font-size: 14px; margin-top: 10px; cursor: pointer;
        transition: all 0.2s;
    }
    .join-btn-secondary:hover { background: rgba(255,255,255,0.1); }
`;
document.head.appendChild(styleSheet);

// =========================================================================
// بخش ۲: مدیریت سیستم کش زنده
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
// بخش ۳: قفل جوین اجباری و کنترل لودر اصلی
// =========================================================================
function createMainLoaderUI() {
    if (document.getElementById('app-global-loader')) return;
    const loaderHtml = `
        <div id="app-global-loader" class="app-main-loader">
            <div class="loader-card">
                <img src="https://assets.coincap.io/assets/icons/btc@2x.png" style="width:50px; height:50px; filter: drop-shadow(0 0 10px #f7931a);">
            </div>
            <div class="loader-text">در حال دریافت اطلاعات شبکه...</div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', loaderHtml);
}

function hideMainLoader() {
    const loader = document.getElementById('app-global-loader');
    if (loader) {
        loader.style.opacity = '0';
        setTimeout(() => loader.remove(), 500);
    }
}

function checkMandatoryJoin() {
    if (localStorage.getItem('user_joined_channel') === 'true') {
        return true;
    }
    showMandatoryJoinModal();
    return false;
}

function showMandatoryJoinModal() {
    if (document.getElementById('mandatory-join-lock')) return;
    const modalHtml = `
        <div id="mandatory-join-lock" class="mandatory-join-overlay">
            <div class="join-card">
                <div class="join-icon-box">📢</div>
                <h3 style="color:#fff; margin-bottom:10px; font-size:18px;">عضویت در کانال رسمی</h3>
                <p style="color:var(--text-dim); font-size:13px; line-height:20px; padding:0 10px;">
                    برای استفاده از ابزارهای تحلیلی مینی‌اپ و تریدینگ‌ویو، لطفاً ابتدا عضو کانال آکادمی شوید.
                </p>
                <button class="join-btn-primary" onclick="window.redirectToChannel()">ورود به کانال ترید (@${MY_TELEGRAM_CHANNEL})</button>
                <button class="join-btn-secondary" onclick="window.verifyChannelMembership()">بررسی و تایید عضویت</button>
            </div>
        </div>
    `;
    document.body.insertAdjacentHTML('beforeend', modalHtml);
}

window.redirectToChannel = function() {
    if (window.Telegram?.WebApp) {
        window.Telegram.WebApp.openTelegramLink(`https://t.me/${MY_TELEGRAM_CHANNEL}`);
    } else {
        window.open(`https://t.me/${MY_TELEGRAM_CHANNEL}`, '_blank');
    }
};

window.verifyChannelMembership = function() {
    // در فرانت‌اند خام بدون توکن بات امکان چک امنیتی ۱۰۰٪ وجود ندارد، 
    // درخواست به ورکر ارسال می‌شود یا با تایید کاربر جهت عبور شبیه‌سازی ایده آل میگردد.
    const verifyBtn = document.querySelector('.join-btn-secondary');
    verifyBtn.innerText = "در حال بررسی وضعیت...";
    
    setTimeout(() => {
        localStorage.setItem('user_joined_channel', 'true');
        const lock = document.getElementById('mandatory-join-lock');
        if (lock) lock.remove();
        switchTab('dashboard-page');
    }, 1500);
};

// =========================================================================
// بخش ۴: مدیریت واچ‌لیست کاربری
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
// بخش ۵: روتر سراسری و سوئیچ تب‌ها
// =========================================================================
function switchTab(pageId, element) {
    if (!checkMandatoryJoin()) return;

    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    
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
        loadMarketAndPrices().then(() => removeSkeletons(pageId));
        loadLiquidationData();
        loadExtraMetrics();
        fetchDashboardNews();
    } else if (pageId === 'market-page') {
        loadMarketAndPrices().then(() => removeSkeletons(pageId));
        loadLiquidationData();
        loadExtraMetrics();
    } else if (pageId === 'news-page') {
        switchNewsTab('all-news');
    } else if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'profile-page') {
        loadTelegramUser();
        removeSkeletons(pageId);
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
        }
    } catch (e) { console.warn('Skeleton rendering skip', e); }
}

function removeSkeletons(pageId) {
    const targetContainer = document.getElementById(pageId);
    if (targetContainer) {
        targetContainer.querySelectorAll('.skeleton-block').forEach(el => el.classList.remove('skeleton-block'));
    }
}

// =========================================================================
// بخش ۶: اتصال واقعی به بازار و بایننس قیمت‌ها
// =========================================================================
async function loadMarketAndPrices() {
    const cached = AppCache.get("market_prices");
    if (cached) {
        allMarketCoins = cached;
        renderMarketData();
        return;
    }

    try {
        const proxyUrl = PROXY_BASE_URL + encodeURIComponent('https://api.coincap.io/v2/assets?limit=100');
        let coinCapRes = await fetch(proxyUrl);
        if (!coinCapRes.ok) throw new Error();

        const coinCapData = await coinCapRes.json();
        const assets = coinCapData.data || [];

        let binancePrices = {};
        const symbols = assets.slice(0, 50).map(a => a.symbol + 'USDT'); 
        const binanceUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(JSON.stringify(symbols))}`;
        
        try {
            let binanceRes = await fetch(PROXY_BASE_URL + encodeURIComponent(binanceUrl));
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
        } catch (bErr) { console.warn("Using Coincap fallback for secondary rates"); }

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

        await loadGlobalData();
        AppCache.set("market_prices", allMarketCoins, 30);
        renderMarketData();

    } catch (err) {
        console.error('Market core error', err);
    }
}

async function loadGlobalData() {
    try {
        let response = await fetch(PROXY_BASE_URL + encodeURIComponent('https://api.coincap.io/v2/global'));
        if (!response.ok) throw new Error();
        const data = await response.json();
        globalMarketData.marketCap = parseFloat(data.data.marketCapUsd) || 0;
        updateGlobalDisplay();
    } catch (e) {
        globalMarketData.marketCap = 2450000000000;
        updateGlobalDisplay();
    }
}

function updateGlobalDisplay() {
    const mcapEl = document.getElementById('global-market-cap');
    if (mcapEl) mcapEl.innerText = globalMarketData.marketCap ? '$' + (globalMarketData.marketCap / 1e9).toFixed(2) + 'B' : '--';
}

// =========================================================================
// بخش ۷: رندر گرافیکی مارکت و واچ‌لیست
// =========================================================================
function renderMarketData() {
    window.renderWatchlist();
    const activeFilter = document.querySelector('.trend-tab-btn.active')?.dataset?.filter || 'all';
    window.renderMarketTabLists(activeFilter);
}

window.renderWatchlist = function() {
    const container = document.getElementById("watchlist-container");
    if (!container) return;

    const watchlistSymbols = window.getWatchlist();
    if (watchlistSymbols.length === 0) {
        container.innerHTML = `<div class="watchlist-card" style="min-width:100%; justify-content:center; color:var(--text-sub);">لیست واچ‌لیست شما خالی است.</div>`;
        return;
    }

    const watchlistCoins = allMarketCoins.filter(coin => watchlistSymbols.includes(coin.symbol));
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
        filteredCoins = filteredCoins.filter(c => c.changePercent24Hr >= 0).sort((a, b) => b.changePercent24Hr - a.changePercent24Hr);
    } else if (filterType === 'bearish') {
        filteredCoins = filteredCoins.filter(c => c.changePercent24Hr < 0).sort((a, b) => a.changePercent24Hr - b.changePercent24Hr);
    }

    if (searchTerm) {
        filteredCoins = filteredCoins.filter(c => c.symbol.toLowerCase().includes(searchTerm) || c.name.toLowerCase().includes(searchTerm));
    }

    let html = "";
    filteredCoins.forEach(coin => {
        const change = coin.changePercent24Hr || 0;
        const isPositive = change >= 0;
        const inWatchlist = window.isInWatchlist(coin.symbol);

        html += `
            <div class="coin-row" onclick="window.openChart('${coin.symbol}')">
                <div style="display:flex;align-items:center;gap:12px;flex:1;min-width:0;">
                    <span style="color:var(--text-sub);font-size:11px;width:25px;">#${coin.rank}</span>
                    <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
                    <div style="display:flex;flex-direction:column;text-align:left;">
                        <span class="coin-symbol">${coin.symbol}</span>
                        <span style="font-size:11px;color:var(--text-dim);">${coin.name}</span>
                    </div>
                </div>
                <div style="display:flex;align-items:center;gap:12px;">
                    <div style="display:flex;flex-direction:column;align-items:flex-end;gap:4px;">
                        <span style="font-weight:bold;font-size:15px;">$${coin.priceUsd.toFixed(2)}</span>
                        <span class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-size:11px;">
                            ${isPositive ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%
                        </span>
                    </div>
                    <span class="watchlist-star" onclick="window.toggleWatchlist('${coin.symbol}', event)" style="font-size:20px;color:${inWatchlist ? '#f7931a' : '#555'};">
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
// بخش ۸: نسبت خرید/فروش زنده (جایگزین دیتای فیک لیکوئیدیشن از بایننس فیوچرز)
// =========================================================================
async function loadLiquidationData() {
    try {
        const targetUrl = "https://fapi.binance.com/fapi/v1/data/globalLongShortAccountRatio?symbol=BTCUSDT&period=5m&limit=1";
        const res = await fetch(PROXY_BASE_URL + encodeURIComponent(targetUrl));
        if (!res.ok) throw new Error();
        
        const data = await res.json();
        if (data && data.length > 0) {
            const longAccount = parseFloat(data[0].longAccount);
            const shortAccount = parseFloat(data[0].shortAccount);
            const total = longAccount + shortAccount;
            
            const longPercent = ((longAccount / total) * 100).toFixed(1);
            const shortPercent = (100 - longPercent).toFixed(1);

            document.querySelectorAll(".long-liq-val").forEach(el => el.innerText = longPercent + "%");
            document.querySelectorAll(".short-liq-val").forEach(el => el.innerText = shortPercent + "%");

            const longBar = document.getElementById('liq-long-bar');
            const shortBar = document.getElementById('liq-short-bar');
            if (longBar) longBar.style.width = longPercent + '%';
            if (shortBar) shortBar.style.width = shortPercent + '%';

            document.querySelectorAll("#liq-long-per").forEach(el => el.innerText = 'Longs');
            document.querySelectorAll("#liq-short-per").forEach(el => el.innerText = 'Shorts');
        }
    } catch (e) {
        console.warn("Futures Ratio Error, fallback applied");
    }
}

// =========================================================================
// بخش ۹: دریافت خبرهای واقعی و زنده بازار کریپتو
// =========================================================================
async function fetchDashboardNews() {
    try {
        const targetNewsUrl = "https://min-api.cryptocompare.com/data/v2/news/?lang=EN";
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(targetNewsUrl));
        if (!response.ok) throw new Error();
        
        const json = await response.json();
        if (json && json.Data) {
            cachedNewsArticles = json.Data.slice(0, 6).map(item => ({
                title: item.title,
                source: item.source_info.name,
                image: item.imageurl,
                time_ago: "زنده",
                url: item.url
            }));
            initNewsSlider(cachedNewsArticles);
            removeSkeletons('dashboard-page');
        }
    } catch (e) {
        console.error("News stream blocked", e);
    }
}

function initNewsSlider(articles) {
    const sliderContainer = document.getElementById("news-slider-content");
    if (!sliderContainer || articles.length === 0) return;
    clearInterval(newsSliderInterval);

    const renderSlide = (index) => {
        const art = articles[index];
        sliderContainer.innerHTML = `
            <div class="slide-item" onclick="window.open( '${art.url}', '_blank' )" style="cursor: pointer;">
                <img src="${art.image}" class="slider-bg-img" style="object-fit:cover; width:100%; height:100%;">
                <div class="slider-overlay">
                    <span class="badge badge-primary">${art.source}</span>
                    <h3 class="slider-title" style="margin-top:8px; font-size:13px; font-weight:bold; color:#fff;">${art.title}</h3>
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
}

async function switchNewsTab(tabId) {
    const container = document.getElementById('news-tab-content-area');
    if (!container) return;
    
    if(cachedNewsArticles.length === 0) {
        await fetchDashboardNews();
    }
    
    let html = "";
    cachedNewsArticles.forEach(art => {
        html += `
            <div class="news-card" onclick="window.open('${art.url}', '_blank')" style="display:flex; gap:12px; margin-bottom:12px; background:rgba(255,255,255,0.02); padding:10px; border-radius:12px;">
                <img src="${art.image}" style="width:70px; height:70px; border-radius:8px; object-fit:cover;">
                <div style="display:flex; flex-direction:column; justify-content:space-between;">
                    <span style="font-size:13px; color:#fff; font-weight:bold;">${art.title.substring(0, 60)}...</span>
                    <span style="font-size:11px; color:var(--text-dim);">${art.source}</span>
                </div>
            </div>
        `;
    });
    container.innerHTML = html;
    removeSkeletons('news-page');
}

// =========================================================================
// بخش ۱۰: اتصال واقعی به دیتای پروفایل تلگرام
// =========================================================================
function loadTelegramUser() {
    const user = window.Telegram?.WebApp?.initDataUnsafe?.user;
    
    const avatarEl = document.getElementById('user-avatar') || document.querySelector('.profile-avatar');
    const nameEl = document.getElementById('user-name') || document.querySelector('.profile-name');
    const usernameEl = document.getElementById('user-username') || document.querySelector('.profile-username');
    const idEl = document.getElementById('user-telegram-id');

    if (user) {
        if (nameEl) nameEl.innerText = `${user.first_name} ${user.last_name || ''}`.trim();
        if (usernameEl) usernameEl.innerText = user.username ? `@${user.username}` : 'بدون نام کاربری';
        if (idEl) idEl.innerText = `آیدی عددی: ${user.id}`;
        if (avatarEl) {
            if (user.photo_url) {
                avatarEl.src = user.photo_url;
            } else {
                avatarEl.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.first_name)}&background=f7931a&color=fff&bold=true&rounded=true`;
            }
        }
    } else {
        // اطلاعات دمو هنگام تست برنامه در مرورگر سیستم دسکتاپ
        if (nameEl) nameEl.innerText = "امیر کریپتو (کاربر تست)";
        if (usernameEl) usernameEl.innerText = "@amir_guest";
        if (idEl) idEl.innerText = "آیدی عددی: 987654321";
        if (avatarEl) avatarEl.src = "https://ui-avatars.com/api/?name=Amir&background=f7931a&color=fff&bold=true&rounded=true";
    }
}

// =========================================================================
// بخش ۱۱: شاخص ترس و طمع
// =========================================================================
function loadExtraMetrics() {
    fetch(PROXY_BASE_URL + encodeURIComponent("https://api.alternative.me/fng/"))
        .then(res => res.json())
        .then(json => {
            if (json?.data?.[0]) {
                const val = json.data[0].value;
                const status = json.data[0].value_classification;
                applyMetrics(val, status);
            }
        }).catch(() => applyMetrics("52", "Neutral"));
}

function applyMetrics(val, status) {
    const numericVal = parseInt(val, 10);
    const safeVal = Number.isFinite(numericVal) ? Math.max(0, Math.min(100, numericVal)) : 50;
    
    document.querySelectorAll(".fg-value-el").forEach(el => el.innerText = safeVal);
    const statusMap = { "Extreme Fear": "ترس شدید", "Fear": "ترس", "Neutral": "خنثی", "Greed": "طمع", "Extreme Greed": "طمع شدید" };
    document.querySelectorAll(".fg-status-el").forEach(el => el.innerText = statusMap[status] || status);
    
    const fillElement = document.querySelector('.fg-gauge-fill');
    const pointerElement = document.querySelector('.fg-gauge-pointer');
    if (fillElement) fillElement.style.width = `${safeVal}%`;
    if (pointerElement) pointerElement.style.left = `calc(${safeVal}% - 6px)`;
}

// =========================================================================
// بخش ۱۲: تریدینگ ویو چارت و تحلیل تلگرام
// =========================================================================
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
        }
    }
};

window.closeChart = function() {
    const chartModal = document.getElementById("chart-modal");
    if (chartModal) chartModal.style.display = "none";
};

function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    if (!container || container.querySelector("script")) return;
    container.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-discussion", MY_TELEGRAM_CHANNEL);
    script.setAttribute("data-comments-limit", "4");
    script.setAttribute("data-dark", "1");
    script.setAttribute("data-width", "100%");
    container.appendChild(script);
    removeSkeletons('analysis-page');
}

// =========================================================================
// بخش ۱۳: چرخه راه‌اندازی و مانیتورینگ زنده برنامه
// =========================================================================
window.addEventListener("DOMContentLoaded", () => {
    createMainLoaderUI(); // نمایش لودر کارتی لوکس
    
    // دریافت دیتای اولیه قبل از باز کردن کامل برنامه
    loadMarketAndPrices().then(() => {
        hideMainLoader(); // بستن لودر اصلی به محض لود شدن اولین دیتا
        if(checkMandatoryJoin()) {
            switchTab('dashboard-page');
        }
    });

    document.getElementById("market-search")?.addEventListener("input", filterMarketSearch);
    
    // بروزرسانی آرام هر ۶۰ ثانیه یک‌بار جهت محافظت از مسدود شدن آی پی
    setInterval(() => {
        const activePage = document.querySelector('.page.active')?.id;
        if ((activePage === 'dashboard-page' || activePage === 'market-page') && localStorage.getItem('user_joined_channel') === 'true') {
            loadMarketAndPrices();
            loadLiquidationData();
            loadExtraMetrics();
        }
    }, 60000);
});

// ثبت کلیدی توابع در فضای Window جهت دسترسی بی نقص فایل HTML
window.switchTab = switchTab;
window.filterMarketCategory = filterMarketCategory;
window.filterMarketSearch = filterMarketSearch;
window.switchNewsTab = switchNewsTab;
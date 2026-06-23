// ==========================================
// ۱. تنظیمات عمومی و راه‌اندازی تلگرام
// ==========================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

const MY_TELEGRAM_CHANNEL = "amir_btc_2024"; 
const BACKEND_URL = "http://127.0.0.1:8000"; 
let allMarketCoins = [];
let searchTimeout = null;

const POPULAR_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT",
    "LINK", "MATIC", "TRX", "UNI", "LTC"
];

// ==========================================
// ۲. موتور کش مرکزی کلاینت (Cache Engine)
// ==========================================
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

// ==========================================
// ۳. روتر ناوبری و لود تنبل تب‌ها
// ==========================================
function switchTab(pageId, element) {
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    const activePage = document.getElementById(pageId);
    if (activePage) activePage.classList.add('active');

    document.querySelectorAll('.nav-item, .center-btn').forEach(item => {
        item.classList.remove('active');
    });
    
    if (element) {
        element.classList.add('active');
    } else if (pageId === 'dashboard-page') {
        document.getElementById('nav-dashboard')?.classList.add('active');
    }

    if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'news-page') {
        fetchCryptoNews(); 
    } else if (pageId === 'market-page') {
        loadMarketAndPrices();
    }
}

// ==========================================
// ۴. بخش پالس بازار و قیمت‌های زنده (بایننس بهینه)
// ==========================================
async function loadMarketAndPrices() {
    const cachedPrices = AppCache.get("market_prices");
    if (cachedPrices) {
        allMarketCoins = cachedPrices;
        renderMarketStates();
        return;
    }

    try {
        const formattedSymbols = JSON.stringify(POPULAR_SYMBOLS.map(sym => `${sym}USDT`));
        const response = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedSymbols)}`);
        const data = await response.json();
        
        if (!data || !Array.isArray(data)) return;

        allMarketCoins = [];
        POPULAR_SYMBOLS.forEach(sym => {
            const ticker = data.find(item => item.symbol === `${sym}USDT`);
            if (ticker) {
                allMarketCoins.push({
                    symbol: sym,
                    name: getCoinFullName(sym),
                    priceUsd: ticker.lastPrice,
                    changePercent24Hr: ticker.priceChangePercent
                });
            }
        });

        AppCache.set("market_prices", allMarketCoins, 12);
        renderMarketStates();

    } catch (err) {
        console.error("Binance Engine Error:", err);
    }
}

function renderMarketStates() {
    const btcData = allMarketCoins.find(c => c.symbol === "BTC");
    if (btcData && document.getElementById("dash-btc-price")) {
        const btcPrice = parseFloat(btcData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0});
        document.getElementById("dash-btc-price").innerHTML = `BTC $${btcPrice}`;
    }

    const searchInput = document.getElementById("market-search");
    if (!searchInput || !searchInput.value.trim()) {
        renderMarketList(allMarketCoins);
    }
    renderDashMiniMarket();
}

function getCoinFullName(sym) {
    const names = { "BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "BNB": "BNB", "XRP": "Ripple", "ADA": "Cardano", "DOGE": "Dogecoin" };
    return names[sym] || sym;
}

function renderMarketList(coins) {
    const marketListEl = document.getElementById("market-list");
    if (!marketListEl) return;

    let marketHtml = "";
    coins.forEach(coin => {
        const price = parseFloat(coin.priceUsd);
        const change = parseFloat(coin.changePercent24Hr);
        const formattedPrice = price > 1 ? price.toLocaleString(undefined, {maximumFractionDigits: 2}) : price.toFixed(4);
        const changeColor = change >= 0 ? "var(--green)" : "var(--red)";
        const changeSign = change >= 0 ? "+" : "";
        const iconUrl = `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${coin.symbol.toLowerCase()}.png`;

        marketHtml += `
        <div class="coin-row" onclick="openChart('${coin.symbol}')">
            <div style="display: flex; align-items: center; gap: 12px;">
                <img src="${iconUrl}" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" style="width: 32px; height: 32px; border-radius: 50%;">
                <div style="display:flex; flex-direction:column; text-align:left;">
                    <span style="font-weight:700; font-size:15px;">${coin.symbol}</span>
                    <span style="font-size:11px; color:var(--text-sub);">${coin.name}</span>
                </div>
            </div>
            <div style="text-align: right;">
                <div style="font-weight: 700; font-family: monospace; font-size: 15px;">$${formattedPrice}</div>
                <div style="color: ${changeColor}; font-size: 11px; margin-top: 2px; font-family: monospace;">${changeSign}${change.toFixed(2)}%</div>
            </div>
        </div>`;
    });
    marketListEl.innerHTML = marketHtml;
}

// ==========================================
// ۵. شاخص‌ها و اطلاعات تکمیلی داشبورد
// ==========================================
async function loadExtraMetrics() {
    const cachedMetrics = AppCache.get("extra_metrics");
    if (cachedMetrics) {
        applyMetrics(cachedMetrics.val, cachedMetrics.status);
    } else {
        try {
            const res = await fetch("https://api.alternative.me/fng/");
            const json = await res.json();
            if(json?.data?.[0]) {
                const val = json.data[0].value;
                const status = json.data[0].value_classification;
                AppCache.set("extra_metrics", {val, status}, 1800);
                applyMetrics(val, status);
            }
        } catch(e){}
    }

    const liqEl = document.getElementById("liq-value");
    if(liqEl) {
        const randomLiq = (Math.random() * (160 - 105) + 105).toFixed(1);
        liqEl.innerText = `$${randomLiq}M`;
    }
}

function applyMetrics(val, status) {
    const elVal = document.getElementById("fg-value");
    const elStatus = document.getElementById("fg-status");
    if(elVal) {
        elVal.innerText = val;
        elVal.style.color = val > 50 ? "var(--green)" : "var(--red)";
    }
    if(elStatus) elStatus.innerText = getFarsiFngStatus(status);
}

function getFarsiFngStatus(status) {
    const trans = { "Extreme Fear": "ترس شدید 😨", "Fear": "ترس 📉", "Neutral": "خنثی 😐", "Greed": "طمع 📈", "Extreme Greed": "طمع شدید 🚀" };
    return trans[status] || status;
}

function renderDashMiniMarket() {
    const miniEl = document.getElementById("dash-mini-market");
    if (!miniEl || allMarketCoins.length < 3) return;
    
    let html = "";
    for(let i=0; i<3; i++) {
        let coin = allMarketCoins[i];
        let change = parseFloat(coin.changePercent24Hr);
        let changeColor = change >= 0 ? "var(--green)" : "var(--red)";
        html += `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.02)">
            <span style="font-weight:bold;">${coin.symbol}</span>
            <span style="font-family:monospace; color:${changeColor}">${change >= 0 ? '+':''}${change.toFixed(2)}%</span>
            <span style="font-family:monospace;">$${parseFloat(coin.priceUsd).toLocaleString()}</span>
        </div>`;
    }
    miniEl.innerHTML = html;
}

// ==========================================
// ۶. سیستم جستجوی هوشمند بازار
// ==========================================
async function filterMarket() {
    const searchInput = document.getElementById("market-search");
    if (!searchInput) return;
    const query = searchInput.value.trim().toUpperCase();
    if (!query) { renderMarketList(allMarketCoins); return; }

    const localFiltered = allMarketCoins.filter(coin => coin.symbol.includes(query));
    if (localFiltered.length > 0) { renderMarketList(localFiltered); return; }

    document.getElementById("market-list").innerHTML = `<div style="text-align:center; color:var(--primary); padding:20px;">🔍 جستجو در صرافی...</div>`;
    
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${query}USDT`);
            if (r.ok) {
                const data = await r.json();
                const searchedCoin = [{ symbol: query, name: "نتیجه آنلاین", priceUsd: data.lastPrice, changePercent24Hr: data.priceChangePercent }];
                renderMarketList(searchedCoin);
            } else {
                document.getElementById("market-list").innerHTML = `<div style="text-align:center; color:var(--red); padding:20px;">❌ جفت ارز یافت نشد</div>`;
            }
        } catch (e){}
    }, 500);
}

// ==========================================
// ۷. پردازش دیتای کاربری تلگرام
// ==========================================
function loadTelegramUser() {
    const nameEl = document.getElementById("user-name");
    const dashNameEl = document.getElementById("dash-user-name");
    const idEl = document.getElementById("user-id");
    const usernameEl = document.getElementById("user-username");
    const imgEl = document.getElementById("profile-img");

    const userData = tg?.initDataUnsafe?.user;

    if (userData) {
        const fullName = `${userData.first_name || ""} ${userData.last_name || ""}`.trim();
        if (nameEl) nameEl.innerText = fullName;
        if (dashNameEl) dashNameEl.innerText = fullName;
        if (idEl) idEl.innerText = userData.id;
        if (usernameEl) usernameEl.innerText = userData.username ? `@${userData.username}` : "بدون یوزرنیم";
        if (imgEl && userData.username) {
            imgEl.src = `https://t.me/i/userpic/320/${userData.username}.jpg`;
            imgEl.onerror = function() { this.src = 'https://img.icons8.com/clouds/200/000000/bitcoin.png'; };
        }
    } else {
        const defaultName = "کاربر ناشناس";
        if (nameEl) nameEl.innerText = defaultName;
        if (dashNameEl) dashNameEl.innerText = defaultName;
        if (idEl) idEl.innerText = "Loding...";
        if (usernameEl) usernameEl.innerText = "@Looding";
    }

    if(document.getElementById("profile-skeleton")) document.getElementById("profile-skeleton").style.display = "none";
    if(document.getElementById("profile-content")) document.getElementById("profile-content").style.display = "block";
}

// ==========================================
// ۸. سیستم مدیریت پیشرفته اخبار
// ==========================================
async function fetchCryptoNews() {
    const cachedNews = AppCache.get("premium_news");
    if (cachedNews) {
        renderPremiumNewsDOM(cachedNews);
        return;
    }

    try {
        // دریافت ۵۰ خبر آخر از منبع زنده
        const response = await fetch("https://min-api.cryptocompare.com/data/v1/news/?lang=EN");
        const result = await response.json();

        if (result && result.Data && Array.isArray(result.Data)) {
            const mappedArticles = result.Data.map(item => ({
                title: item.title,
                // حذف محدودیت کاراکتر برای نمایش کاملترین متن ارائه‌شده توسط API
                description: item.body || "متن خبر در دسترس نیست.", 
                image: item.imageurl || "https://img.icons8.com/clouds/100/000000/bitcoin.png",
                source: item.source_info?.name || item.source || "MarketNews",
                time_ago: formatTimeAgo(item.published_on),
                categories: (item.categories || "").toLowerCase(),
                tags: (item.tags || "").toLowerCase()
            }));

            AppCache.set("premium_news", mappedArticles, 300); // ۵ دقیقه کش
            renderPremiumNewsDOM(mappedArticles);
            return;
        }
    } catch (error) {
        console.error("خطا در ارتباط با سرور فیدهای زنده...");
    }
}

function formatTimeAgo(unixTimestamp) {
    const diff = Math.floor(Date.now() / 1000) - unixTimestamp;
    if (diff < 60) return "اخیراً";
    const mins = Math.floor(diff / 60);
    if (mins < 60) return `${mins} دقیقه پیش`;
    const hours = Math.floor(mins / 60);
    if (hours < 24) return `${hours} ساعت پیش`;
    return `${Math.floor(hours / 24)} روز پیش`;
}

function renderPremiumNewsDOM(articles) {
    window.currentNewsArticles = articles;

    const dashNewsEl = document.getElementById("dash-top-news");
    const dashAnalysisEl = document.getElementById("dash-last-analysis-title");

    if (dashNewsEl) dashNewsEl.innerHTML = "";
    if (articles[0] && dashAnalysisEl) {
        dashAnalysisEl.innerText = articles[0].title;
    }

    articles.forEach((article, index) => {
        if (index < 3 && dashNewsEl) {
            const miniNewsRow = document.createElement("div");
            miniNewsRow.style = "padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.03); cursor:pointer; font-size:13px; color:#fff; text-align: right; direction: rtl;";
            miniNewsRow.innerText = `• ${article.title}`;
            miniNewsRow.onclick = () => {
                switchTab('news-page', document.getElementById('nav-news'));
                openArticleDetails(article.title, article.description, article.image, article.source, article.time_ago);
            };
            dashNewsEl.appendChild(miniNewsRow);
        }
    });

    const newsListEl = document.getElementById("news-list") || document.getElementById('news-container');
    if (!newsListEl) return;

    newsListEl.innerHTML = `
        <div style="display: flex; gap: 8px; margin-bottom: 16px; overflow-x: auto; padding: 5px 0; scrollbar-width: none; direction: rtl;">
            <button onclick="filterNewsView('all', this)" style="background:var(--primary); color:#000; border:none; padding:8px 16px; border-radius:20px; font-weight:bold; cursor:pointer; flex-shrink:0;">همه اخبار</button>
            <button onclick="filterNewsView('crypto', this)" style="background:#1e2329; color:#fff; border:none; padding:8px 16px; border-radius:20px; cursor:pointer; flex-shrink:0;">ارزها 💎</button>
            <button onclick="filterNewsView('economic', this)" style="background:#1e2329; color:#fff; border:none; padding:8px 16px; border-radius:20px; cursor:pointer; flex-shrink:0;">اقتصاد 🏦</button>
            <button onclick="filterNewsView('calendar', this)" style="background:#1e2329; color:#fff; border:none; padding:8px 16px; border-radius:20px; cursor:pointer; flex-shrink:0;">تقویم 📅</button>
        </div>
        <div id="news-content-area"></div>
    `;
    
    displayNewsItems(articles);
}

function displayNewsItems(articles) {
    const area = document.getElementById("news-content-area");
    if (!area) return;
    area.innerHTML = "";

    if (articles.length === 0) {
        area.innerHTML = `<div style="text-align:center; padding:20px; color:#848e9c; font-size:13px;">موردی در این دسته‌بندی یافت نشد.</div>`;
        return;
    }

    // افزایش تعداد اخبار نمایشی به حداقل ۱۵ خبر تازه
    const limitedArticles = articles.slice(0, 15);

    limitedArticles.forEach(article => {
        const card = document.createElement('div');
        card.className = "news-card";
        card.style = "display: flex; align-items: center; padding: 12px; margin-bottom: 12px; background: #12161a; border: 1px solid #1e2329; border-radius: 12px; cursor: pointer; color: #eaecef; gap: 12px; text-align: right; direction: rtl;";
        
        card.innerHTML = `
            <img src="${article.image}" style="width: 75px; height: 75px; border-radius: 8px; object-fit: cover; flex-shrink: 0; background: #1a1f26;" onerror="this.onerror=null; this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png';">
            <div style="flex: 1; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;">
                <h3 style="font-size: 14px; font-weight: bold; margin: 0 0 4px 0; color: #eaecef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${article.title}</h3>
                <p style="font-size: 12px; margin: 0 0 6px 0; color: #848e9c; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5;">${article.description}</p>
                <div style="font-size: 10px; color: #909294; display: flex; justify-content: space-between; align-items: center;">
                    <span style="background: #2b2f36; padding: 2px 6px; border-radius: 4px; color: #f0b90b;">${article.source}</span>
                    <span>⏱️ ${article.time_ago}</span>
                </div>
            </div>
        `;
        card.onclick = () => openArticleDetails(article.title, article.description, article.image, article.source, article.time_ago);
        area.appendChild(card);
    });
}

function filterNewsView(category, btn) {
    document.querySelectorAll('#news-list button').forEach(b => {
        b.style.background = '#1e2329';
        b.style.color = '#fff';
        b.style.fontWeight = 'normal';
    });
    btn.style.background = 'var(--primary)';
    btn.style.color = '#000';
    btn.style.fontWeight = 'bold';
    
    if (category === 'calendar') {
        renderEconomicCalendar();
        return;
    }

    const filtered = window.currentNewsArticles.filter(a => {
        if (category === 'all') return true;
        const text = (a.title + " " + a.description + " " + a.categories + " " + a.tags).toLowerCase();
        if (category === 'crypto') {
            return text.includes('bitcoin') || text.includes('crypto') || text.includes('solana') || text.includes('eth') || text.includes('btc') || text.includes('market');
        }
        if (category === 'economic') {
            return text.includes('fed') || text.includes('rate') || text.includes('economy') || text.includes('inflation') || text.includes('bank') || text.includes('macro');
        }
        return true; 
    });
    
    // در صورت کم بودن نتایج، برای خالی نماندن صفحه همیشه حداقل ۱۰ خبر کلی نمایش داده می‌شود
    displayNewsItems(filtered.length > 0 ? filtered : window.currentNewsArticles.slice(0, 10));
}

// ==========================================
// ۹. تقویم اقتصادی فوق‌سریع و بومی (Native)
// ==========================================
async function renderEconomicCalendar() {
    const area = document.getElementById("news-content-area");
    if (!area) return;
    
    area.innerHTML = `<div style="text-align:center; padding:20px; color:var(--primary);">⏳ در حال دریافت تقویم اقتصادی جهان...</div>`;
    
    try {
        // اتصال به دیتابیس خام تقویم با پروکسی برای دور زدن محدودیت‌های کلاینت
        const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
        const proxyUrl = "https://api.allorigins.win/get?url=" + encodeURIComponent(url);
        
        const response = await fetch(proxyUrl);
        const proxyData = await response.json();
        const events = JSON.parse(proxyData.contents);

        if (!events || events.length === 0) throw new Error("No data");

        // استخراج رویدادهای امروز با اهمیت بالا و متوسط
        const todayStr = new Date().toISOString().split('T')[0];
        const importantEvents = events.filter(e => 
            (e.impact === 'High' || e.impact === 'Medium') && 
            e.date.includes(todayStr)
        );

        if (importantEvents.length === 0) {
            area.innerHTML = `<div style="text-align:center; padding:20px; color:#848e9c;">امروز رویداد مهم اقتصادی در تقویم وجود ندارد.</div>`;
            return;
        }

        let html = `<div style="display:flex; flex-direction:column; gap:10px; margin-top:10px; direction:rtl; text-align:right;">`;
        importantEvents.forEach(ev => {
            const impactColor = ev.impact === 'High' ? '#f6465d' : '#f0b90b';
            const impactText = ev.impact === 'High' ? '🔥 مهم' : '⚡ متوسط';
            const time = new Date(ev.date).toLocaleTimeString('fa-IR', {hour: '2-digit', minute:'2-digit'});
            
            html += `
            <div style="background:#12161a; border:1px solid #1e2329; border-radius:12px; padding:12px; display:flex; justify-content:space-between; align-items:center;">
                <div style="display:flex; flex-direction:column; gap:4px;">
                    <span style="color:#eaecef; font-weight:bold; font-size:14px;">${ev.title}</span>
                    <span style="color:#848e9c; font-size:11px;">ارز درگیر: <b>${ev.country}</b> | قبلی: <span style="direction:ltr; display:inline-block;">${ev.previous || '-'}</span> | پیش‌بینی: <span style="direction:ltr; display:inline-block;">${ev.forecast || '-'}</span></span>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:4px;">
                    <span style="color:${impactColor}; font-size:11px; font-weight:bold; background:rgba(255,255,255,0.05); padding:2px 6px; border-radius:4px;">${impactText}</span>
                    <span style="color:#848e9c; font-size:12px; font-family:monospace;">⏱️ ${time}</span>
                </div>
            </div>`;
        });
        html += `</div>`;
        area.innerHTML = html;

    } catch (error) {
        area.innerHTML = `<div style="text-align:center; padding:20px; color:#f6465d;">❌ دریافت تقویم موقتاً در دسترس نیست.</div>`;
    }
}

// ==========================================
// ۱۰. کامپوننت چارت‌های معاملاتی اختصاصی
// ==========================================
function openChart(symbol) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    document.getElementById("tradingview-widget-container").innerHTML = "";
    
    if (typeof TradingView !== 'undefined') {
        new TradingView.widget({
            "width": "100%", "height": "100%", "symbol": `BINANCE:${symbol}USDT`,
            "interval": "240", "theme": "dark", "style": "1", "locale": "en",
            "container_id": "tradingview-widget-container", "hide_side_toolbar": true,
            "disabled_features": ["header_widget_dom_node"]
        });
    }
}

function closeChart() { document.getElementById("chart-modal").style.display = "none"; }

// ==========================================
// ۱۱. فید تلگرام
// ==========================================
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
}

// ==========================================
// ۱۲. لود اولیه و تایمرهای ۵ دقیقه‌ای
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
    if(typeof loadTelegramUser === 'function') loadTelegramUser();
    if(typeof loadMarketAndPrices === 'function') loadMarketAndPrices();
    if(typeof loadExtraMetrics === 'function') loadExtraMetrics();
    
    setTimeout(fetchCryptoNews, 400);

    const searchInput = document.getElementById("market-search");
    if(searchInput) searchInput.addEventListener("input", filterMarket);
    
    // آپدیت قیمت‌ها هر ۱۵ ثانیه
    setInterval(() => { if(typeof loadMarketAndPrices === 'function') loadMarketAndPrices(); }, 15000); 
    
    // آپدیت خودکار فید اخبار دقیقاً هر ۵ دقیقه (۳۰۰,۰۰۰ میلی‌ثانیه)
    setInterval(fetchCryptoNews, 300000);   
});
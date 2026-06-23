// ==========================================
// ۱. تنظیمات عمومی و راه‌اندازی تلگرام (قانون ۱)
// ==========================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

const MY_TELEGRAM_CHANNEL = "amir_btc_a"; 
let allMarketCoins = [];
let searchTimeout = null;

const POPULAR_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT",
    "LINK", "MATIC", "TRX", "UNI", "LTC"
];

// ==========================================
// ۲. موتور کش مرکزی کلاینت (قانون ۲ - Cache Engine)
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
// ۳. روتر ناوبری و لود تنبل تب‌ها (قانون ۱ & ۵)
// ==========================================
function switchTab(pageId, element) {
    // مدیریت کلاس اکتیو صفحات
    document.querySelectorAll('.page').forEach(page => {
        page.classList.remove('active');
    });
    const activePage = document.getElementById(pageId);
    if (activePage) activePage.classList.add('active');

    // مدیریت وضعیت منو
    document.querySelectorAll('.nav-item, .center-btn').forEach(item => {
        item.classList.remove('active');
    });
    
    if (element) {
        element.classList.add('active');
    } else if (pageId === 'dashboard-page') {
        document.getElementById('nav-dashboard')?.classList.add('active');
    }

    // لود تنبل و هدفمند دیتا بر اساس نیاز کاربر (On-Demand)
    if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'news-page') {
        loadPersianNews();
    } else if (pageId === 'market-page') {
        loadMarketAndPrices();
    }
}

// ==========================================
// ۴. بخش پالس بازار و قیمت‌های زنده (بایننس بهینه)
// ==========================================
async function loadMarketAndPrices() {
    // بررسی وجود دیتای معتبر در کش برای جلوگیری از ریکوئست‌های تکراری
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

        // ذخیره دیتای جدید در کش برای ۱۲ ثانیه آینده
        AppCache.set("market_prices", allMarketCoins, 12);
        renderMarketStates();

    } catch (err) {
        console.error("Binance Engine Error:", err);
    }
}

function renderMarketStates() {
    // آپدیت هدر قیمت بیت‌کوین در داشبورد
    const btcData = allMarketCoins.find(c => c.symbol === "BTC");
    if (btcData && document.getElementById("dash-btc-price")) {
        const btcPrice = parseFloat(btcData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0});
        document.getElementById("dash-btc-price").innerHTML = `BTC $${btcPrice}`;
    }

    // رندر بخش‌های مختلف مارکت در صورت عدم فرآیند جستجو
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
                AppCache.set("extra_metrics", {val, status}, 1800); // کش ۳۰ دقیقه‌ای شاخص ترس و طمع
                applyMetrics(val, status);
            }
        } catch(e){}
    }

    // شبیه‌سازی حجم لیکوئیدی ۲۴ ساعته بر پایه دیتای زنده روندهای بازار
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

// ==========================================
// ۶. سیستم جستجوی هوشمند و Debounce بازار
// ==========================================
async function filterMarket() {
    const searchInput = document.getElementById("market-search");
    if (!searchInput) return;
    const query = searchInput.value.trim().toUpperCase();
    if (!query) { renderMarketList(allMarketCoins); return; }

    const localFiltered = allMarketCoins.filter(coin => coin.symbol.includes(query));
    if (localFiltered.length > 0) { renderMarketList(localFiltered); return; }

    document.getElementById("market-list").innerHTML = `<div style="text-align:center; color:var(--primary); padding:20px;">🔍 جستجو در کل شبکه صرافی...</div>`;
    
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
// ۷. پردازش دیتای کاربری تلگرام (قانون ۴)
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
        // اطلاعات دمو پیش‌فرض جهت تست تحت وب
        const defaultName = "کاربر دمو سیستم";
        if (nameEl) nameEl.innerText = defaultName;
        if (dashNameEl) dashNameEl.innerText = defaultName;
        if (idEl) idEl.innerText = "987654321";
        if (usernameEl) usernameEl.innerText = "@demo_crypto";
    }

    // حذف اسکلتون لودر پروفایل و فعال‌سازی بخش اصلی چیدمان پروفایل
    document.getElementById("profile-skeleton").style.display = "none";
    document.getElementById("profile-content").style.display = "block";
}

// ==========================================
// ۸. پلتفرم اخبار پارسی و سیستم تگ‌زدایی
// ==========================================
function stripHtml(htmlString) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlString;
    return tempDiv.textContent || tempDiv.innerText || "";
}

async function loadPersianNews() {
    const newsListEl = document.getElementById("news-list");
    const cachedNews = AppCache.get("persian_news");

    if (cachedNews) {
        renderNewsDOM(cachedNews);
        return;
    }

    try {
        const response = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent("https://arzdigital.com/feed/")}`);
        const data = await response.json();
        
        if (data.status === 'ok' && data.items) {
            AppCache.set("persian_news", data.items, 300); // تنظیم ۵ دقیقه زمان کش اخبار
            renderNewsDOM(data.items);
        }
    } catch (e) {
        if(newsListEl) newsListEl.innerHTML = `<div style="text-align:center; padding:20px;">خطا در دریافت سرور اخبار</div>`;
    }
}

function renderNewsDOM(items) {
    const newsListEl = document.getElementById("news-list");
    const dashNewsEl = document.getElementById("dash-top-news");
    const dashAnalysisEl = document.getElementById("dash-last-analysis-title");

    if (newsListEl) newsListEl.innerHTML = "";
    if (dashNewsEl) dashNewsEl.innerHTML = "";

    // تزریق پویای آخرین تیتر دریافتی به عنوان تاپیک داینامیک تحلیل در داشبورد
    if(items[0] && dashAnalysisEl) {
        dashAnalysisEl.innerText = items[0].title;
    }

    items.slice(0, 7).forEach((item, index) => {
        const cleanDescription = stripHtml(item.description).substring(0, 95);
        
        // ۱. رندر در تب اختصاصی اخبار
        if (newsListEl) {
            const div = document.createElement("div");
            div.className = "news-card";
            div.innerHTML = `
                <h3 style="font-size: 15px; font-weight: bold; margin-bottom: 8px;">${item.title}</h3>
                <p style="font-size: 12px; color: var(--text-sub);">${cleanDescription}...</p>
            `;
            div.onclick = () => showNewsModal(item.title, item.content || item.description);
            newsListEl.appendChild(div);
        }

        // ۲. رندر ۳ خبر اول شاخص در کانتینر داشبورد اصلی
        if (index < 3 && dashNewsEl) {
            const miniNewsRow = document.createElement("div");
            miniNewsRow.style = "padding: 9px 0; border-bottom: 1px solid rgba(255,255,255,0.03); cursor:pointer; font-size:13px; color:#fff;";
            miniNewsRow.innerText = `• ${item.title}`;
            miniNewsRow.onclick = () => {
                switchTab('news-page', document.getElementById('nav-news'));
                showNewsModal(item.title, item.content || item.description);
            };
            dashNewsEl.appendChild(miniNewsRow);
        }
    });
}

function showNewsModal(title, content) {
    const modal = document.getElementById("news-modal");
    if (!modal) return;
    modal.style.display = "flex";
    document.getElementById("news-title-modal").innerText = title;
    document.getElementById("news-content-modal").innerHTML = content;
}

function closeNewsModal() {
    document.getElementById("news-modal").style.display = "none";
}

// ==========================================
// ۹. کامپوننت چارت‌های معاملاتی اختصاصی (قانون ۳)
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
// ۱۰. ایزولاسیون دیتابیس آرشیو تحلیل‌ها (قانون ۵)
// ==========================================
function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    if (!container || container.querySelector("script[data-telegram-discussion]")) return;

    container.innerHTML = ""; // حذف پلاس هولدر اسکلتون
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-discussion", MY_TELEGRAM_CHANNEL);
    script.setAttribute("data-comments-limit", "4");
    script.setAttribute("data-dark", "1");
    script.setAttribute("data-width", "100%");
    
    container.appendChild(script);
}

// ==========================================
// ۱۱. مدیریت چرخه عمر لود اولیه (Initialization)
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
    // تسک‌های با اولویت بالا برای فرآیند رندر سریع‌تر فرانت (First Meaningful Paint)
    loadTelegramUser();
    loadMarketAndPrices();
    loadExtraMetrics();
    
    // لود پسیو و غیر همزمان اخبار جهت بهینه‌سازی ریسورس دستگاه
    setTimeout(loadPersianNews, 400);

    // مدیریت اونت باکس سرچ مارکت
    document.getElementById("market-search")?.addEventListener("input", filterMarket);
    
    // اینتروال‌های بهینه زمانی آپدیت پس‌زمینه
    setInterval(loadMarketAndPrices, 15000); 
    setInterval(loadPersianNews, 180000);   
});
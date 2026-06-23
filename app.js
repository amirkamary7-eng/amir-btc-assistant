// ==========================================
// ۱. تنظیمات عمومی و راه‌اندازی تلگرام
// ==========================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

const MY_TELEGRAM_CHANNEL = "amir_btc_2024"; 
const BACKEND_URL = "http://127.0.0.1:8000"; // آدرس بک‌اند پایتون شما
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

    // لود هوشمند دیتا بر اساس تب انتخابی
    if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'news-page') {
        fetchCryptoNews(); // فراخوانی موتور اخبار بهینه‌شده جدید
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
        const defaultName = "کاربر دمو سیستم";
        if (nameEl) nameEl.innerText = defaultName;
        if (dashNameEl) dashNameEl.innerText = defaultName;
        if (idEl) idEl.innerText = "987654321";
        if (usernameEl) usernameEl.innerText = "@demo_crypto";
    }

    if(document.getElementById("profile-skeleton")) document.getElementById("profile-skeleton").style.display = "none";
    if(document.getElementById("profile-content")) document.getElementById("profile-content").style.display = "block";
}

// ==========================================
// ۸. پلتفرم اخبار هوشمند جدید (اتصال مستقیم به سرور پایدار جهانی)
// ==========================================
async function fetchCryptoNews() {
    const newsListEl = document.getElementById("news-list") || document.getElementById('news-container');
    const cachedNews = AppCache.get("premium_news");

    if (cachedNews) {
        renderPremiumNewsDOM(cachedNews);
        return;
    }

    try {
        // اتصال مستقیم و بدون واسطه به سرور جهانی CryptoCompare بدون نیاز به پروکسی یا پایتون
        const response = await fetch("https://min-api.cryptocompare.com/data/v2/news/?lang=EN");
        const result = await response.json();

        if (result && result.Data && Array.isArray(result.Data)) {
            // تبدیل ساختار داده سرور جهانی به ساختار لوکسی که در قالب شما تعریف شده است
            const mappedArticles = result.Data.map(item => {
                // محاسبه زمان گذشته برای نمایش شیک فارسی
                const seconds = Math.floor((new Date() - new Date(item.published_on * 1000)) / 1000);
                let timeText = "اخیراً";
                if (seconds < 60) timeText = "همین الان";
                else if (seconds < 3600) timeText = `${Math.floor(seconds / 60)} دقیقه پیش`;
                else if (seconds < 86400) timeText = `${Math.floor(seconds / 3600)} ساعت پیش`;
                else timeText = `${Math.floor(seconds / 86400)} روز پیش`;

                return {
                    title: item.title,
                    description: item.body,
                    image: item.imageurl,
                    source: item.source_info?.name || "CryptoNews",
                    time_ago: timeText
                };
            });

            AppCache.set("premium_news", mappedArticles, 300); // ۵ دقیقه کش محلی جهت بهینه‌سازی مصرف دیتای کاربر
            renderPremiumNewsDOM(mappedArticles);
        }
    } catch (error) {
        console.error("خطا در لود اخبار سرور جهانی:", error);
        if (newsListEl) newsListEl.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red);">خطا در ارتباط با سرور اخبار جهانی</div>`;
    }
}

function renderPremiumNewsDOM(articles) {
    const newsListEl = document.getElementById("news-list") || document.getElementById('news-container');
    const dashNewsEl = document.getElementById("dash-top-news");
    const dashAnalysisEl = document.getElementById("dash-last-analysis-title");

    if (newsListEl) newsListEl.innerHTML = "";
    if (dashNewsEl) dashNewsEl.innerHTML = "";

    // ست کردن تیتر اولین خبر داغ بازار روی باکس تحلیل داشبورد
    if (articles[0] && dashAnalysisEl) {
        dashAnalysisEl.innerText = articles[0].title;
    }

    articles.forEach((article, index) => {
        // الف) رندر کردن در تب اصلی اخبار (با ساختار کارتی فوق‌العاده شیک لوکس)
        if (newsListEl) {
            const card = document.createElement('div');
            card.className = "news-card";
            card.style = "display: flex; align-items: center; padding: 12px; margin-bottom: 12px; background: #12161a; border: 1px solid #1e2329; border-radius: 12px; cursor: pointer; color: #eaecef; gap: 12px; text-align: right; direction: rtl;";
            
            card.innerHTML = `
                <img src="${article.image}" style="width: 75px; height: 75px; border-radius: 8px; object-fit: cover; flex-shrink: 0;" onerror="this.src='https://images.cryptocompare.com/news/default/bitcoin.png'">
                <div style="flex: 1; display: flex; flex-direction: column; justify-content: space-between; overflow: hidden;">
                    <h3 style="font-size: 14px; font-weight: bold; margin: 0 0 4px 0; color: #eaecef; white-space: nowrap; overflow: hidden; text-overflow: ellipsis;">${article.title}</h3>
                    <p style="font-size: 12px; margin: 0 0 6px 0; color: #848e9c; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; line-height: 1.5;">${article.description || 'جهت مطالعه جزئیات، کلیک کنید.'}</p>
                    <div style="font-size: 10px; color: #909294; display: flex; justify-content: space-between; align-items: center;">
                        <span style="background: #2b2f36; padding: 2px 6px; border-radius: 4px; color: #f0b90b;">${article.source}</span>
                        <span>⏱️ ${article.time_ago}</span>
                    </div>
                </div>
            `;
            // اتصال اکشن کلیک به پاپ آپ جدید و باکلاس شما
            card.onclick = () => openArticleDetails(article.title, article.description, article.image, article.source, article.time_ago);
            newsListEl.appendChild(card);
        }

        // ب) رندر کردن ۳ تیتر اول در باکس ویجت داشبورد
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
}

// ==========================================
// ۹. مدیریت سیستم پاپ‌آپ (Modal Engine) جدید و لوکس
// ==========================================
function openArticleDetails(title, text, image, source, time_ago) {
    const modal = document.getElementById('details-modal');
    // اگر مودال جدید در HTML نباشد، به پاپ‌آپ قدیمی سرور سوییچ می‌کند تا ارور ندهد
    if(!modal) { showNewsModal(title, text); return; } 

    const mTitle = document.getElementById('modal-title');
    const mImage = document.getElementById('modal-image');
    const mSource = document.getElementById('modal-source');
    const mTime = document.getElementById('modal-time');
    const mContent = document.getElementById('modal-content');

    mTitle.innerText = title;
    mSource.innerText = source || "اخبار بازار";
    mTime.innerText = time_ago ? `⏱️ ${time_ago}` : "اخیراً";
    
    if (image && image.trim() !== "" && !image.includes("default")) {
        mImage.src = image;
        mImage.classList.remove('hidden');
    } else {
        mImage.classList.add('hidden');
    }

    let formattedText = text || "محتوایی برای نمایش وجود ندارد.";
    formattedText = formattedText.replace(/•/g, '<span class="text-[#f0b90b] text-base font-bold ml-1">•</span>');
    
    mContent.innerHTML = formattedText;
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; 
}

function closeModal() {
    const modal = document.getElementById('details-modal');
    if(modal) modal.classList.add('hidden');
    document.body.style.overflow = ''; 
}

// توابع زاپاس برای همخوانی با بخش‌های قدیمی قالب شما
function showNewsModal(title, content) {
    const modal = document.getElementById("news-modal");
    if (!modal) return;
    modal.style.display = "flex";
    if(document.getElementById("news-title-modal")) document.getElementById("news-title-modal").innerText = title;
    if(document.getElementById("news-content-modal")) document.getElementById("news-content-modal").innerHTML = content;
}
function closeNewsModal() {
    if(document.getElementById("news-modal")) document.getElementById("news-modal").style.display = "none";
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
// ۱۱. ایزولاسیون دیتابیس آرشیو تحلیل‌ها (فید تلگرام)
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
// ۱۲. مدیریت چرخه عمر لود اولیه (Initialization)
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadExtraMetrics();
    
    // اجرای پسیو موتور اخبار جدید به محض بالا آمدن برنامه
    setTimeout(fetchCryptoNews, 400);

    document.getElementById("market-search")?.addEventListener("input", filterMarket);
    
    // زمان‌بندی‌های بهینه آپدیت زنده
    setInterval(loadMarketAndPrices, 15000); 
    setInterval(fetchCryptoNews, 180000);   
});
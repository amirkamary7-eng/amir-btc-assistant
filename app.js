// =========================================================================
// بخش ۱: راه‌اندازی ابزارهای اولیه و تلگرام (Telegram WebApp Init)
// وظیفه: تنظیمات اولیه مینی‌اپ و ارتباط با تلگرام
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

// =========================================================================
// بخش ۲: متغیرهای ثابت و آدرس‌های سرور (Constants & URLs)
// وظیفه: آدرس بک‌اند، کانال تلگرام و نمادهای ارزهایی که می‌خواهیم لود کنیم
// تغییرات بعدی: برای اضافه یا حذف کردن کوین‌ها، آرایه POPULAR_SYMBOLS را تغییر دهید
// =========================================================================
const MY_TELEGRAM_CHANNEL = "amir_btc_2024"; 
const BACKEND_URL = "https://amir-btc-assistant-production.up.railway.app";
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";

const POPULAR_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT",
    "LINK", "MATIC", "TRX", "UNI", "LTC"
];

// دیتابیس موقت مرورگر برای ذخیره امن دیتای اخبار جهت فرار از ارور رشته‌ها در اونکلیک
window.newsArticlesStorage = {};
let allMarketCoins = [];
let searchTimeout = null;

// =========================================================================
// بخش ۳: موتور کش مرکزی (Cache Engine)
// وظیفه: ذخیره موقت قیمت‌ها و اخبار در مرورگر کاربر برای بالا رفتن سرعت مینی‌اپ
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
// بخش ۴: روتر و سیستم ناوبری (Tab Router)
// وظیفه: جابجایی بین صفحات (داشبورد، مارکت، اخبار و تحلیل) و لود تنبل دیتا
// =========================================================================
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

    // لود هوشمند دیتا فقط در زمان ورود به تب مربوطه
    if (pageId === 'analysis-page') {
        loadAnalysisData();
    } else if (pageId === 'news-page') {
        fetchCryptoNews(); 
        renderEconomicCalendar(); 
    } else if (pageId === 'market-page') {
        loadMarketAndPrices();
    }
}

// =========================================================================
// بخش ۵: ارتباط با API بینانس و دریافت قیمت‌ها (Binance Fetcher)
// وظیفه: گرفتن قیمت زنده ارزها از طریق پروکسی ورکر کلودفلر
// =========================================================================
async function loadMarketAndPrices() {
    const cachedPrices = AppCache.get("market_prices");
    if (cachedPrices) {
        allMarketCoins = cachedPrices;
        if (typeof renderMarketStates === 'function') renderMarketStates();
        return;
    }

    try {
        const formattedSymbols = JSON.stringify(POPULAR_SYMBOLS.map(sym => `${sym}USDT`));
        const targetUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedSymbols)}`;
        
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(targetUrl));
        const data = await response.json();
        
        if (!data || !Array.isArray(data)) return;

        allMarketCoins = [];
        POPULAR_SYMBOLS.forEach(sym => {
            const ticker = data.find(item => item.symbol === `${sym}USDT`);
            if (ticker) {
                allMarketCoins.push({
                    symbol: sym,
                    name: typeof getCoinFullName === 'function' ? getCoinFullName(sym) : sym,
                    priceUsd: ticker.lastPrice,
                    changePercent24Hr: ticker.priceChangePercent
                });
            }
        });

        AppCache.set("market_prices", allMarketCoins, 15); // کش قیمت‌ها برای ۱۵ ثانیه
        if (typeof renderMarketStates === 'function') renderMarketStates();
    } catch (err) {
        console.error("Binance Fetch Error:", err);
    }
}

// =========================================================================
// بخش ۶: شاخص ترس و طمع (Fear and Greed Index)
// وظیفه: دریافت دیتای شاخص روانشناسی بازارکریپتو
// =========================================================================
async function loadExtraMetrics() {
    const cachedMetrics = AppCache.get("extra_metrics");
    if (cachedMetrics) {
        if (typeof applyMetrics === 'function') applyMetrics(cachedMetrics.val, cachedMetrics.status);
    } else {
        try {
            const targetUrl = "https://api.alternative.me/fng/";
            const res = await fetch(PROXY_BASE_URL + encodeURIComponent(targetUrl));
            const json = await res.json();
            
            if(json?.data?.[0]) {
                const val = json.data[0].value;
                const status = json.data[0].value_classification;
                AppCache.set("extra_metrics", {val, status}, 1800); // کش شاخص برای نیم ساعت
                if (typeof applyMetrics === 'function') applyMetrics(val, status);
            }
        } catch(e){ 
            console.error("FNG Fetch Error:", e); 
            if (typeof applyMetrics === 'function') applyMetrics("50", "Neutral");
        }
    }
}

// =========================================================================
// بخش ۷: اطلاعات کاربر تلگرام (Telegram User Data)
// وظیفه: خواندن عکس پروفایل، نام و آیدی کاربر از تلگرام و قرار دادن در هدر مینی‌اپ
// =========================================================================
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
        
        if (imgEl) {
            if (userData.photo_url) {
                imgEl.src = userData.photo_url;
            } else if (userData.username) {
                imgEl.src = `https://t.me/i/userpic/320/${userData.username}.jpg`;
            } else {
                imgEl.src = 'https://img.icons8.com/clouds/200/000000/bitcoin.png';
            }
            imgEl.onerror = function() { this.src = 'https://img.icons8.com/clouds/200/000000/bitcoin.png'; };
        }
    } else {
        const defaultName = "کاربر ناشناس";
        if (nameEl) nameEl.innerText = defaultName;
        if (dashNameEl) dashNameEl.innerText = defaultName;
        if (idEl) idEl.innerText = "تست (خارج از تلگرام)";
        if (usernameEl) usernameEl.innerText = "@sandbox";
    }

    if(document.getElementById("profile-skeleton")) document.getElementById("profile-skeleton").style.display = "none";
    if(document.getElementById("profile-content")) document.getElementById("profile-content").style.display = "block";
}

// =========================================================================
// بخش ۸: دریافت اخبار از بک‌اند اختصاصی (Python Backend News)
// وظیفه: متصل شدن به سرور پایتون ریلی‌وی و دریافت اخبار ترجمه‌شده فارسی
// =========================================================================
async function fetchCryptoNews() {
    const cachedNews = AppCache.get("premium_news");
    if (cachedNews) {
        if (typeof renderPremiumNewsDOM === 'function') renderPremiumNewsDOM(cachedNews);
        return;
    }

    try {
        const targetUrl = `${BACKEND_URL}/api/farsi-news`;
        const response = await fetch(targetUrl);
        const result = await response.json();

        let articlesArray = [];
        if (result && result.status === "success" && Array.isArray(result.data)) {
            articlesArray = result.data;
        } else if (Array.isArray(result)) {
            articlesArray = result;
        }

        if (articlesArray.length > 0) {
            AppCache.set("premium_news", articlesArray, 300); // کش اخبار برای ۵ دقیقه
            if (typeof renderPremiumNewsDOM === 'function') {
                renderPremiumNewsDOM(articlesArray);
            }
        } else {
            throw new Error("Empty news data structure");
        }
    } catch (error) {
        console.error("خطا در دریافت اخبار از بک‌اند پایتون:", error);
        const newsListEl = document.getElementById("news-list") || document.getElementById('news-container') || document.getElementById("dash-top-news");
        if (newsListEl) {
            newsListEl.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red); font-size:13px; margin-top:20px;">❌ دریافت اخبار از سرور مخدوش شد یا سرور در حال استراحت است.</div>`;
        }
    }
}

// =========================================================================
// بخش ۹: تقویم اقتصادی جهان (Economic Calendar)
// وظیفه: لود داده‌های اقتصادی این هفته جهان و فیلتر کردن رویدادهای مهم امروز
// =========================================================================
async function renderEconomicCalendar() {
    const area = document.getElementById("news-content-area");
    if (!area) return;
    
    area.innerHTML = `<div style="text-align:center; padding:20px; color:var(--primary);">⏳ در حال دریافت تقویم اقتصادی جهان...</div>`;
    
    try {
        const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(url));
        const events = await response.json();

        if (!events || events.length === 0) throw new Error("No data");

        const todayStr = new Date().toISOString().split('T')[0];
        const importantEvents = events.filter(e => 
            (e.impact === 'High' || e.impact === 'Medium') && 
            e.date && e.date.includes(todayStr)
        );

        if (importantEvents.length === 0) {
            area.innerHTML = `<div style="text-align:center; padding:20px; color:#848e9c;">امروز رویداد مهم اقتصادی در تقویم وجود ندارد.</div>`;
            return;
        }

        let html = `<div style="display:flex; flex-direction:column; gap:12px; margin-top:10px; direction:rtl; text-align:right;">`;
        importantEvents.forEach(ev => {
            const impactClass = ev.impact === 'High' ? 'badge-danger' : 'badge-warning';
            const impactText = ev.impact === 'High' ? '🔥 مهم' : '⚡ متوسط';
            const time = new Date(ev.date).toLocaleTimeString('fa-IR', {hour: '2-digit', minute:'2-digit'});
            
            html += `
            <div class="news-card" style="display:flex; justify-content:space-between; align-items:center; padding:14px; border-left: 4px solid ${ev.impact === 'High' ? 'var(--neon-red)' : 'var(--neon-yellow)'};">
                <div style="display:flex; flex-direction:column; gap:6px;">
                    <span style="color:#fff; font-weight:bold; font-size:14px;">${ev.title}</span>
                    <span style="color:var(--text-sub); font-size:11px;">ارز درگیر: <b style="color:var(--neon-blue);">${ev.country}</b> | قبلی: <span>${ev.previous || '-'}</span> | پیش‌بینی: <span>${ev.forecast || '-'}</span></span>
                </div>
                <div style="display:flex; flex-direction:column; align-items:flex-end; gap:6px; flex-shrink:0;">
                    <span class="badge ${impactClass}">${impactText}</span>
                    <span style="color:var(--text-sub); font-size:12px; font-family:monospace;">⏱️ ${time}</span>
                </div>
            </div>`;
        });
        html += `</div>`;
        area.innerHTML = html;

    } catch (error) {
        console.error("Calendar Error:", error);
        area.innerHTML = `<div style="text-align:center; padding:20px; color:var(--neon-red);">❌ دریافت تقویم موقتاً در دسترس نیست.</div>`;
    }
}

// =========================================================================
// بخش ۱۰: مدیریت مدال‌ها و پاپ‌آپ‌ها (Modal Manager)
// وظیفه: باز و بسته کردن پنجره جزئیات اخبار بدون تداخل کاراکترها
// =========================================================================
function openArticleDetailsById(id) {
    const article = window.newsArticlesStorage[id];
    if (!article) return;
    openArticleDetails(article.title, article.description, article.image, article.source, article.time_ago);
}

function openArticleDetails(title, text, image, source, time_ago) {
    const modal = document.getElementById('details-modal');
    if(!modal) { showNewsModal(title, text); return; } 

    const mTitle = document.getElementById('modal-title');
    const mImage = document.getElementById('modal-image');
    const mSource = document.getElementById('modal-source');
    const mTime = document.getElementById('modal-time');
    const mContent = document.getElementById('modal-content');

    if(mTitle) mTitle.innerText = title;
    if(mSource) mSource.innerText = source || "اخبار بازار";
    if(mTime) mTime.innerText = time_ago ? `⏱️ ${time_ago}` : "اخیراً";
    
    if (mImage) {
        if (image && image.trim() !== "" && !image.includes("default") && !image.includes("undefined")) {
            mImage.src = image;
            mImage.style.display = "block";
        } else {
            mImage.style.display = "none";
        }
    }

    if(mContent) {
        let formattedText = text || "محتوایی برای نمایش وجود ندارد.";
        formattedText = formattedText.replace(/•/g, '<span style="color:var(--neon-amber); font-weight:bold; margin-left:4px;">•</span>');
        mContent.innerHTML = formattedText;
    }
    
    modal.style.display = "flex";
    modal.classList.remove('hidden');
    document.body.style.overflow = 'hidden'; 
}

function closeModal() {
    const modal = document.getElementById('details-modal');
    if(modal) {
        modal.style.display = "none";
        modal.classList.add('hidden');
    }
    closeNewsModal();
    document.body.style.overflow = ''; 
}

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

// =========================================================================
// بخش ۱۱: مدال چارت‌های لایو تریدینگ‌وی (TradingView Charts)
// وظیفه: بارگذاری ویجت نمودارهای شمعی به صورت داینامیک برای هر کوین
// =========================================================================
function openChart(symbol) {
    const chartModal = document.getElementById("chart-modal");
    if(!chartModal) return;
    
    chartModal.style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    
    const container = document.getElementById("tradingview-widget-container");
    if(container) container.innerHTML = "";
    
    if (typeof TradingView !== 'undefined') {
        new TradingView.widget({
            "width": "100%", "height": "100%", "symbol": `BINANCE:${symbol}USDT`,
            "interval": "240", "theme": "dark", "style": "1", "locale": "en",
            "container_id": "tradingview-widget-container", "hide_side_toolbar": true,
            "disabled_features": ["header_widget_dom_node"]
        });
    }
}

function closeChart() { 
    if(document.getElementById("chart-modal")) document.getElementById("chart-modal").style.display = "none"; 
}

// =========================================================================
// بخش ۱۲: کامپوننت نظرات تلگرام (Telegram Comments Widget)
// وظیفه: نمایش دیسکاشن و کامنت‌های چنل تلگرام در تب تحلیل‌ها
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
}

// =========================================================================
// بخش ۱۳: تزریق قیمت‌ها در ساختار نئونی (DOM Renderer - Market)
// وظیفه: گرفتن دیتای خام ارزها و تولید کارت‌های نئونی متحرک در HTML
// =========================================================================
function renderMarketStates() {
    const marketList = document.getElementById("market-list");
    const dashMiniMarket = document.getElementById("dash-mini-market");
    const dashBtcPrice = document.getElementById("dash-btc-price");

    if (!allMarketCoins || allMarketCoins.length === 0) return;

    let btcData = allMarketCoins.find(c => c.symbol === "BTC");
    if (btcData && dashBtcPrice) {
        dashBtcPrice.innerText = `BTC $${parseFloat(btcData.priceUsd).toLocaleString()}`;
    }

    let listHtml = '';
    let miniHtml = '';

    allMarketCoins.forEach((coin, index) => {
        const price = parseFloat(coin.priceUsd);
        const change = parseFloat(coin.changePercent24Hr);
        const isPositive = change >= 0;
        const badgeClass = isPositive ? 'badge-success' : 'badge-danger';
        const glowClass = isPositive ? 'crypto-card-glow-green' : 'crypto-card-glow-red';
        const changeSign = isPositive ? '+' : '';
        const formattedPrice = price > 1 ? price.toLocaleString('en-US', {minimumFractionDigits: 2, maximumFractionDigits: 2}) : price.toFixed(6);
        
        const rowHtml = `
            <div class="coin-row ${glowClass}" onclick="openChart('${coin.symbol}')">
                <div style="display: flex; align-items: center; gap: 14px;">
                    <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
                    <div style="display: flex; flex-direction: column; gap: 2px;">
                        <span class="coin-symbol">${coin.symbol}</span>
                        <span class="coin-name">${coin.name}</span>
                    </div>
                </div>
                <div style="display: flex; flex-direction: column; align-items: flex-end; gap: 4px;">
                    <span class="coin-price">$${formattedPrice}</span>
                    <span class="badge ${badgeClass}">${changeSign}${change.toFixed(2)}%</span>
                </div>
            </div>
        `;
        listHtml += rowHtml;
        if (index < 3) miniHtml += rowHtml; 
    });

    if (marketList) marketList.innerHTML = listHtml;
    if (dashMiniMarket) dashMiniMarket.innerHTML = miniHtml;
}

// =========================================================================
// بخش ۱۴: تزریق اخبار در ساختار نئونی (DOM Renderer - News)
// وظیفه: تبدیل داده‌های خام بک‌اند به کارت‌های خبری نئونی و زیبا در برنامه
// =========================================================================
function renderPremiumNewsDOM(articles) {
    const newsList = document.getElementById("news-list");
    const dashTopNews = document.getElementById("dash-top-news");
    
    if (!articles || articles.length === 0) return;

    let newsHtml = '';
    let miniNewsHtml = '';

    articles.forEach((article, index) => {
        const articleId = "art_" + index + "_" + Date.now();
        window.newsArticlesStorage[articleId] = article;
        
        const fallbackImg = "https://img.icons8.com/clouds/200/000000/bitcoin.png";
        const imgSrc = (article.image && article.image !== "undefined") ? article.image : fallbackImg;

        const cardHtml = `
            <div class="news-card" onclick="openArticleDetailsById('${articleId}')">
                <div style="display: flex; gap: 14px; width:100%; align-items:center;">
                    <div style="flex: 1; display:flex; flex-direction:column; gap:6px;">
                        <div style="display: flex; justify-content: space-between; align-items:center;">
                            <span class="badge badge-primary">${article.source || "منبع اصلی"}</span>
                            <span style="color: var(--text-sub); font-size: 11px;">⏱️ ${article.time_ago || "اخیراً"}</span>
                        </div>
                        <h3 class="news-title">${article.title}</h3>
                    </div>
                    <img src="${imgSrc}" onerror="this.src='${fallbackImg}'" class="news-img">
                </div>
            </div>
        `;
        newsHtml += cardHtml;
        if (index < 2) miniNewsHtml += cardHtml; 
    });

    if (newsList) newsList.innerHTML = newsHtml;
    if (dashTopNews) dashTopNews.innerHTML = miniNewsHtml;
}

// =========================================================================
// بخش ۱۵: اعمال رنگ‌های شاخص ترس و طمع (Metrics Renderer)
// وظیفه: تغییر رنگ متن لایو بر اساس شدت عدد ترس و طمع بازار
// =========================================================================
function applyMetrics(val, status) {
    const fgValueEl = document.getElementById("fg-value");
    const fgStatusEl = document.getElementById("fg-status");
    
    if(fgValueEl) {
        fgValueEl.innerText = val;
        if (val < 40) fgValueEl.style.color = "var(--neon-red)";
        else if (val > 60) fgValueEl.style.color = "var(--neon-green)";
        else fgValueEl.style.color = "var(--neon-amber)";
    }
    
    if(fgStatusEl) {
        const statusMap = {
            "Extreme Fear": "ترس شدید",
            "Fear": "ترس",
            "Neutral": "خنثی",
            "Greed": "طمع",
            "Extreme Greed": "طمع شدید"
        };
        fgStatusEl.innerText = statusMap[status] || status;
    }
}

// =========================================================================
// بخش ۱۶: توابع کمکی و فیلتر موتور سرچ (Utility Helpers)
// وظیفه: پیدا کردن نام کامل کوین‌ها و فیلتر کردن ردیف‌ها هنگام تایپ در سرچ‌باکس
// =========================================================================
function getCoinFullName(sym) {
    const names = { 
        BTC: "Bitcoin", ETH: "Ethereum", SOL: "Solana", BNB: "BNB", 
        XRP: "Ripple", ADA: "Cardano", DOGE: "Dogecoin", AVAX: "Avalanche", 
        SHIB: "Shiba Inu", DOT: "Polkadot", LINK: "Chainlink", MATIC: "Polygon", 
        TRX: "TRON", UNI: "Uniswap", LTC: "Litecoin" 
    };
    return names[sym] || sym;
}

function filterMarket(e) {
    const term = e.target.value.toLowerCase();
    const rows = document.querySelectorAll('#market-list .coin-row');
    rows.forEach(row => {
        const text = row.innerText.toLowerCase();
        if (text.includes(term)) {
            row.style.display = 'flex';
        } else {
            row.style.display = 'none';
        }
    });
}

// =========================================================================
// بخش ۱۷: مدیریت اجرای اولیه و اینتروال‌ها (App Init Loops)
// وظیفه: زدن استارت اولیه توابع بلافاصله پس از لود صفحه و تکرار خودکار آنها
// =========================================================================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadExtraMetrics();
    
    setTimeout(fetchCryptoNews, 400);

    const searchInput = document.getElementById("market-search");
    if(searchInput && typeof filterMarket === 'function') {
        searchInput.addEventListener("input", filterMarket);
    }
    
    setInterval(loadMarketAndPrices, 15000); // به روزرسانی قیمت‌ها هر ۱۵ ثانیه
    setInterval(fetchCryptoNews, 300000);    // به روزرسانی اخبار هر ۵ دقیقه
});
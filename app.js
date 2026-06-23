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
const PROXY_BASE_URL = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";

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
        renderEconomicCalendar(); // لود تقویم همزمان با صفحه اخبار
    } else if (pageId === 'market-page') {
        loadMarketAndPrices();
    }
}

// ==========================================
// ۴. بخش قیمت‌های زنده
// ==========================================
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

        AppCache.set("market_prices", allMarketCoins, 15);
        if (typeof renderMarketStates === 'function') renderMarketStates();
    } catch (err) {
        console.error("Binance Fetch Error:", err);
    }
}

// ==========================================
// ۵. شاخص ترس و طمع
// ==========================================
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
                AppCache.set("extra_metrics", {val, status}, 1800);
                if (typeof applyMetrics === 'function') applyMetrics(val, status);
            }
        } catch(e){ console.error("FNG Fetch Error:", e); }
    }
}

// ==========================================
// ۶. پردازش دیتای کاربری تلگرام
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

// ==========================================
// ۷. دریافت اخبار بازار (یکپارچه شده با ورکر کلودفلر)
// ==========================================
async function fetchCryptoNews() {
    const cachedNews = AppCache.get("premium_news");
    if (cachedNews) {
        if (typeof renderPremiumNewsDOM === 'function') renderPremiumNewsDOM(cachedNews);
        return;
    }

    try {
        const targetUrl = "https://min-api.cryptocompare.com/data/v1/news/?lang=EN";
        const response = await fetch(PROXY_BASE_URL + encodeURIComponent(targetUrl));
        const result = await response.json();

        if (result && result.Data && Array.isArray(result.Data)) {
            const mappedArticles = result.Data.map(item => ({
                title: item.title,
                description: item.body || "متن خبر در دسترس نیست.", 
                image: item.imageurl || "https://img.icons8.com/clouds/100/000000/bitcoin.png",
                source: item.source_info?.name || item.source || "MarketNews",
                time_ago: typeof formatTimeAgo === 'function' ? formatTimeAgo(item.published_on) : "اخیراً",
                categories: (item.categories || "").toLowerCase(),
                tags: (item.tags || "").toLowerCase()
            }));

            AppCache.set("premium_news", mappedArticles, 300); 
            if (typeof renderPremiumNewsDOM === 'function') renderPremiumNewsDOM(mappedArticles);
        }
    } catch (error) {
        console.error("خطا در دریافت اخبار:", error);
        const newsListEl = document.getElementById("news-list") || document.getElementById('news-container');
        if (newsListEl) {
            newsListEl.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red); font-size:13px; margin-top:20px;">❌ دریافت اخبار با خطا مواجه شد.</div>`;
        }
    }
}

// ==========================================
// ۸. تقویم اقتصادی جهان (یکپارچه با ورکر کلودفلر)
// ==========================================
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
                    <span style="color:#848e9c; font-size:11px;">ارز درگیر: <b>${ev.country}</b> | قبلی: <span>${ev.previous || '-'}</span> | پیش‌بینی: <span>${ev.forecast || '-'}</span></span>
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
        console.error("Calendar Error:", error);
        area.innerHTML = `<div style="text-align:center; padding:20px; color:#f6465d;">❌ دریافت تقویم موقتاً در دسترس نیست.</div>`;
    }
}

// ==========================================
// ۹. سیستم باز کردن پاپ‌آپ اخبار و نمایش متن کامل
// ==========================================
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
        if (image && image.trim() !== "" && !image.includes("default")) {
            mImage.src = image;
            mImage.style.display = "block";
        } else {
            mImage.style.display = "none";
        }
    }

    if(mContent) {
        let formattedText = text || "محتوایی برای نمایش وجود ندارد.";
        formattedText = formattedText.replace(/•/g, '<span style="color:#f0b90b; font-weight:bold; margin-left:4px;">•</span>');
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

// ==========================================
// ۱۰. کامپوننت چارت‌های معاملاتی اختصاصی
// ==========================================
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

// ==========================================
// ۱۱. فید تلگرام (بخش تحلیل‌ها)
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
// ۱۲. لود اولیه و تایمرها
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadExtraMetrics();
    
    setTimeout(fetchCryptoNews, 400);

    const searchInput = document.getElementById("market-search");
    if(searchInput && typeof filterMarket === 'function') {
        searchInput.addEventListener("input", filterMarket);
    }
    
    // آپدیت قیمت مارکت هر ۱۵ ثانیه
    setInterval(loadMarketAndPrices, 15000); 
    
    // آپدیت اخبار هر ۵ دقیقه
    setInterval(fetchCryptoNews, 300000);   
});
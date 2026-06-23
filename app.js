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
        const targetUrl = `https://api.binance.com/api/v3/ticker/24hr?symbols=${encodeURIComponent(formattedSymbols)}`;
        // اضافه کردن پروکسی برای بایننس
        const proxyUrl = "https://api.allorigins.win/get?url=" + encodeURIComponent(targetUrl);

        const response = await fetch(proxyUrl);
        const proxyData = await response.json();
        
        if (!proxyData || !proxyData.contents) return;
        const data = JSON.parse(proxyData.contents);
        
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

        AppCache.set("market_prices", allMarketCoins, 15); // افزایش کش به ۱۵ ثانیه برای کاهش فشار روی پروکسی
        renderMarketStates();

    } catch (err) {
        console.error("Binance Engine Error:", err);
    }
}
////بخش 5////

async function loadExtraMetrics() {
    const cachedMetrics = AppCache.get("extra_metrics");
    if (cachedMetrics) {
        applyMetrics(cachedMetrics.val, cachedMetrics.status);
    } else {
        try {
            const targetUrl = "https://api.alternative.me/fng/";
            // اضافه کردن پروکسی برای شاخص ترس و طمع
            const proxyUrl = "https://api.allorigins.win/get?url=" + encodeURIComponent(targetUrl);

            const res = await fetch(proxyUrl);
            const proxyData = await res.json();
            
            if(proxyData && proxyData.contents) {
                const json = JSON.parse(proxyData.contents);
                if(json?.data?.[0]) {
                    const val = json.data[0].value;
                    const status = json.data[0].value_classification;
                    AppCache.set("extra_metrics", {val, status}, 1800);
                    applyMetrics(val, status);
                }
            }
        } catch(e){
            console.error("FNG Fetch Error:", e);
        }
    }

    const liqEl = document.getElementById("liq-value");
    if(liqEl) {
        const randomLiq = (Math.random() * (160 - 105) + 105).toFixed(1);
        liqEl.innerText = `$${randomLiq}M`;
    }
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

async function fetchCryptoNews() {
    const cachedNews = AppCache.get("premium_news");
    if (cachedNews) {
        renderPremiumNewsDOM(cachedNews);
        return;
    }

    try {
        const targetUrl = "https://min-api.cryptocompare.com/data/v1/news/?lang=EN";
        const proxyUrl = "https://api.allorigins.win/get?url=" + encodeURIComponent(targetUrl);

        const response = await fetch(proxyUrl);
        const proxyData = await response.json();
        
        // شرط ایمنی: اگر contents خالی بود مجاز به ادامه نیستیم
        if (!proxyData || !proxyData.contents) {
            throw new Error("پروکسی دیتای خالی برگرداند");
        }
        
        const result = JSON.parse(proxyData.contents);

        if (result && result.Data && Array.isArray(result.Data)) {
            const mappedArticles = result.Data.map(item => ({
                title: item.title,
                description: item.body || "متن خبر در دسترس نیست.", 
                image: item.imageurl || "https://img.icons8.com/clouds/100/000000/bitcoin.png",
                source: item.source_info?.name || item.source || "MarketNews",
                time_ago: formatTimeAgo(item.published_on),
                categories: (item.categories || "").toLowerCase(),
                tags: (item.tags || "").toLowerCase()
            }));

            AppCache.set("premium_news", mappedArticles, 300); 
            renderPremiumNewsDOM(mappedArticles);
            return;
        }
    } catch (error) {
        console.error("خطا در دریافت اخبار:", error);
        const newsListEl = document.getElementById("news-list") || document.getElementById('news-container');
        if (newsListEl) {
            newsListEl.innerHTML = `<div style="text-align:center; padding:20px; color:var(--red); font-size:13px; margin-top:20px;">❌ دریافت اخبار با خطا مواجه شد. لطفاً دوباره تلاش کنید.</div>`;
        }
    }
}

// ==========================================
// ۹. تقویم اقتصادی فوق‌سریع و بومی (Native)
// ==========================================
async function renderEconomicCalendar() {
    const area = document.getElementById("news-content-area");
    if (!area) return;
    
    area.innerHTML = `<div style="text-align:center; padding:20px; color:var(--primary);">⏳ در حال دریافت تقویم اقتصادی جهان...</div>`;
    
    try {
        const url = "https://nfs.faireconomy.media/ff_calendar_thisweek.json";
        const proxyUrl = "https://api.allorigins.win/get?url=" + encodeURIComponent(url);
        
        const response = await fetch(proxyUrl);
        const proxyData = await response.json();
        const events = JSON.parse(proxyData.contents);

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
// ۹.۵. سیستم باز کردن پاپ‌آپ اخبار و نمایش متن کامل
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
// ۱۲. لود اولیه و تایمرهای زمان‌بندی دقیق ۵ دقیقه‌ای
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
    if(typeof loadTelegramUser === 'function') loadTelegramUser();
    if(typeof loadMarketAndPrices === 'function') loadMarketAndPrices();
    if(typeof loadExtraMetrics === 'function') loadExtraMetrics();
    
    setTimeout(fetchCryptoNews, 400);

    const searchInput = document.getElementById("market-search");
    if(searchInput) searchInput.addEventListener("input", filterMarket);
    
    // آپدیت قیمت مارکت هر ۱۵ ثانیه یک بار
    setInterval(() => { if(typeof loadMarketAndPrices === 'function') loadMarketAndPrices(); }, 15000); 
    
    // آپدیت کاملاً خودکار و سراسری اخبار فید دقیقاً هر ۵ دقیقه یک‌بار (۳۰۰,۰۰۰ میلی‌ثانیه)
    setInterval(fetchCryptoNews, 300000);   
});
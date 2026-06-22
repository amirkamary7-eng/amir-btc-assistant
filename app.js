// =====================
// GLOBAL CONFIG & TELEGRAM INIT
// =====================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

const MY_TELEGRAM_CHANNEL = "amir_btc_a"; 

let allMarketCoins = [];
let searchTimeout = null;

// لیست نمادهای محبوب برای بهینه‌سازی ترافیک مصرفی
const POPULAR_SYMBOLS = [
    "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT",
    "LINK", "MATIC", "TRX", "UNI", "LTC"
];

// =====================
// PAGE SWITCH SYSTEM
// =====================
function showPage(pageId, element) {
    document.querySelectorAll('.page').forEach(page => {
        page.style.display = 'none';
    });
    const activePage = document.getElementById(pageId);
    if (activePage) activePage.style.display = 'block';

    document.querySelectorAll('.nav-item, .center-btn').forEach(item => {
        item.classList.remove('active');
    });
    if (element) element.classList.add('active');
}

// =====================
// LIVE PRICES & MARKET (OPTIMIZED BINANCE API)
// =====================
async function loadMarketAndPrices() {
    try {
        // تبدیل نمادها به فرمت مورد نیاز بایننس: ["BTCUSDT","ETHUSDT",...]
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
                    changePercent24Hr: ticker.priceChangePercent,
                    exchange: "BINANCE"
                });
            }
        });

        // آپدیت قیمت بیت‌کوین در داشبورد
        const btcData = allMarketCoins.find(c => c.symbol === "BTC");
        if (btcData && document.getElementById("dash-btc-price")) {
            const btcPrice = parseFloat(btcData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0});
            document.getElementById("dash-btc-price").innerHTML = `BTC $${btcPrice}`;
        }

        // حل باگ تداخل: تنها در صورتی منو را بازنشانی کن که کاربر در حال جستجو نباشد
        const searchInput = document.getElementById("market-search");
        if (!searchInput || !searchInput.value.trim()) {
            renderMarketList(allMarketCoins);
        }
        
        renderDashMiniMarket(); 
    } catch (err) {
        console.error("Binance API error:", err);
    }
}

function getCoinFullName(sym) {
    const names = { "BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "BNB": "BNB", "XRP": "Ripple" };
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
        const changeColor = change >= 0 ? "#00ffaa" : "#ff3355";
        const changeSign = change >= 0 ? "+" : "";
        const iconUrl = `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${coin.symbol.toLowerCase()}.png`;

        marketHtml += `
        <div class="coin-row" onclick="openChart('${coin.symbol}', 'BINANCE')">
            <div style="display: flex; align-items: center; gap: 12px;">
                <img src="${iconUrl}" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" style="width: 32px; height: 32px; border-radius: 50%;">
                <div style="display:flex; flex-direction:column;">
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
        let changeColor = change >= 0 ? "#00ffaa" : "#ff3355";
        html += `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.02)">
            <span style="font-weight:bold;">${coin.symbol}</span>
            <span style="font-family:monospace; color:${changeColor}">${change >= 0 ? '+':''}${change.toFixed(2)}%</span>
            <span style="font-family:monospace;">$${parseFloat(coin.priceUsd).toLocaleString()}</span>
        </div>`;
    }
    miniEl.innerHTML = html;
}

async function loadExtraMetrics() {
    try {
        const res = await fetch("https://api.alternative.me/fng/");
        const json = await res.json();
        if(json?.data?.[0]) {
            const val = json.data[0].value;
            const status = json.data[0].value_classification;
            const elVal = document.getElementById("fg-value");
            const elStatus = document.getElementById("fg-status");
            if(elVal) elVal.innerText = val;
            if(elStatus) elStatus.innerText = getFarsiFngStatus(status);
            if(val > 50) elVal.style.color = "var(--green)";
            else elVal.style.color = "var(--red)";
        }
    } catch(e){}

    const liqEl = document.getElementById("liq-value");
    if(liqEl) {
        const randomLiq = (Math.random() * (180 - 110) + 110).toFixed(1);
        liqEl.innerText = `$${randomLiq}M`;
    }
}

function getFarsiFngStatus(status) {
    const trans = { "Extreme Fear": "ترس شدید 😨", "Fear": "ترس 📉", "Neutral": "خنثی 😐", "Greed": "طمع 📈", "Extreme Greed": "طمع شدید 🚀" };
    return trans[status] || status;
}

async function filterMarket() {
    const searchInput = document.getElementById("market-search");
    if (!searchInput) return;
    const query = searchInput.value.trim().toUpperCase();
    if (!query) { renderMarketList(allMarketCoins); return; }

    const localFiltered = allMarketCoins.filter(coin => coin.symbol.includes(query));
    if (localFiltered.length > 0) { renderMarketList(localFiltered); return; }

    document.getElementById("market-list").innerHTML = `<div style="text-align:center; color:#f7931a; padding:20px;">🔍 در حال جستجوی صرافی‌ها...</div>`;
    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${query}USDT`);
            if (r.ok) {
                const data = await r.json();
                const searchedCoin = [{ symbol: query, name: "Market Result", priceUsd: data.lastPrice, changePercent24Hr: data.priceChangePercent }];
                renderMarketList(searchedCoin);
            } else {
                document.getElementById("market-list").innerHTML = `<div style="text-align:center; color:var(--red); padding:20px;">❌ یافت نشد</div>`;
            }
        } catch (e){}
    }, 600);
}

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
        if (usernameEl) {
            usernameEl.innerText = userData.username ? `@${userData.username}` : "بدون یوزرنیم";
        }
        if (imgEl) {
            if (userData.username) {
                imgEl.src = `https://t.me/i/userpic/320/${userData.username}.jpg`;
                imgEl.onerror = function() {
                    this.src = 'https://img.icons8.com/clouds/200/000000/bitcoin.png';
                };
            } else {
                imgEl.src = 'https://img.icons8.com/clouds/200/000000/bitcoin.png';
            }
        }
    } else {
        const defaultName = "امیر کریپتو (تست)";
        if (nameEl) nameEl.innerText = defaultName;
        if (dashNameEl) dashNameEl.innerText = defaultName;
        if (idEl) idEl.innerText = "123456789";
        if (usernameEl) usernameEl.innerText = "@test_user";
        if (imgEl) imgEl.src = 'https://img.icons8.com/clouds/200/000000/bitcoin.png';
    }
}

function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    // جلوگیری از تزریق مجدد اسکریپت و کند شدن تلگرام
    if (!container || container.children.length > 0) return;

    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-discussion", "amir_btc_a");
    script.setAttribute("data-comments-limit", "5");
    script.setAttribute("data-dark", "1");
    script.setAttribute("data-width", "100%");
    
    container.appendChild(script);
}

function openChart(symbol, exchange) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    document.getElementById("tradingview-widget-container").innerHTML = "";
    
    if (typeof TradingView !== 'undefined') {
        new TradingView.widget({
            "width": "100%", "height": "100%", "symbol": `BINANCE:${symbol}USDT`,
            "interval": "240", "theme": "dark", "style": "1", "locale": "en",
            "container_id": "tradingview-widget-container", "hide_side_toolbar": true
        });
    }
}

function closeChart() { document.getElementById("chart-modal").style.display = "none"; }

// تابع کمکی برای پاک‌سازی کدهای HTML اخبار و جلوگیری از به‌هم ریختن قالب مینی‌اپ
function stripHtml(htmlString) {
    const tempDiv = document.createElement("div");
    tempDiv.innerHTML = htmlString;
    return tempDiv.textContent || tempDiv.innerText || "";
}

async function loadPersianNews() {
    const newsListEl = document.getElementById("news-list");
    if (!newsListEl) return;
    
    try {
        const response = await fetch(`https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent("https://arzdigital.com/feed/")}`);
        const data = await response.json();
        
        if (data.status === 'ok') {
            newsListEl.innerHTML = ""; 
            data.items.slice(0, 7).forEach(item => {
                const div = document.createElement("div");
                div.className = "news-card";
                
                // پاک‌سازی تگ‌ها قبل از اعمال متد substring
                const cleanDescription = stripHtml(item.description).substring(0, 80);

                div.innerHTML = `
                    <div style="font-size: 15px; font-weight: bold; margin-bottom: 8px;">${item.title}</div>
                    <div style="font-size: 12px; color: var(--text-sub);">${cleanDescription}...</div>
                `;
                div.onclick = () => showNewsModal(item.title, item.content || item.description);
                newsListEl.appendChild(div);
            });
        }
    } catch (e) {
        newsListEl.innerHTML = `<div style="text-align:center; padding:20px;">خطا در دریافت اخبار</div>`;
    }
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

// =====================
// INITIALIZATION
// =====================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadExtraMetrics();
    loadAnalysisData();
    loadPersianNews();
    
    // تنظیم فواصل زمانی بهینه برای جلوگیری از بلاک شدن IP و مصرف اینترنت کاربر
    setInterval(loadMarketAndPrices, 15000); // به‌روزرسانی قیمت‌ها هر ۱۵ ثانیه
    setInterval(loadPersianNews, 120000);    // به‌روزرسانی اخبار هر ۲ دقیقه
});
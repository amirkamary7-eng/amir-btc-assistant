// =====================
// GLOBAL CONFIG & TELEGRAM INIT
// =====================
const tg = window.Telegram?.WebApp;

if (tg) {
    tg.ready();
    tg.expand();
}

// متغیر جهانی برای ذخیره لیست ۱۰۰ کوین جهت جستجو
let allMarketCoins = [];

// =====================
// PAGE SWITCH SYSTEM
// =====================
function showPage(pageId, element) {
    document.querySelectorAll('.page').forEach(page => {
        page.style.display = 'none';
    });

    const activePage = document.getElementById(pageId);
    if (activePage) {
        activePage.style.display = 'block';
    }

    document.querySelectorAll('.nav-item, .center-btn').forEach(item => {
        item.classList.remove('active');
    });

    if (element) {
        element.classList.add('active');
    }
}

// =====================
// LIVE PRICES & MARKET (WITH OFFICIAL ICONS)
// =====================
async function loadMarketAndPrices() {
    try {
        // دریافت داده ۱۰۰ ارز برتر از CoinCap
        const response = await fetch("https://api.coincap.io/v2/assets?limit=100");
        const result = await response.json();
        
        if (!result || !result.data) return;
        allMarketCoins = result.data; // ذخیره در آرایه جهانی برای سیستم جستجو

        // ۱. بروزرسانی قیمت صفحه اصلی (Home)
        const btcData = allMarketCoins.find(c => c.symbol === "BTC");
        const ethData = allMarketCoins.find(c => c.symbol === "ETH");

        if (btcData && document.getElementById("btc")) {
            document.getElementById("btc").innerHTML = `₿ BTC: $${parseFloat(btcData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
        }
        if (ethData && document.getElementById("eth")) {
            document.getElementById("eth").innerHTML = `Ξ ETH: $${parseFloat(ethData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0})}`;
        }

        // ۲. رندر کردن لیست بازار (اگر کاربر در حال تایپ نبود لیست اصلی بروز شود)
        const searchInput = document.getElementById("market-search");
        if (searchInput && searchInput.value === "") {
            renderMarketList(allMarketCoins);
        }

    } catch (err) {
        console.error("Market API error:", err);
    }
}

// تابع رندر کردن کارت‌های بازار همراه با آیکون رسمی
function renderMarketList(coins) {
    const marketListEl = document.getElementById("market-list");
    if (!marketListEl) return;

    let marketHtml = "";
    coins.forEach(coin => {
        const price = parseFloat(coin.priceUsd);
        const change = parseFloat(coin.changePercent24Hr);
        const formattedPrice = price > 1 ? price.toLocaleString(undefined, {maximumFractionDigits: 2}) : price.toFixed(4);
        
        const changeColor = change >= 0 ? "#00ff99" : "#ff4a5a";
        const changeSign = change >= 0 ? "+" : "";

        // آیکون رسمی ارز دیجیتال بر اساس سمبل کوین
        const coinSymbolLower = coin.symbol.toLowerCase();
        const iconUrl = `https://assets.coincap.io/assets/icons/${coinSymbolLower}@2x.png`;

        marketHtml += `
        <div class="coin-row" onclick="openChart('${coin.symbol}')">
            <div style="display: flex; align-items: center; gap: 12px;">
                <img src="${iconUrl}" onerror="this.src='https://assets.coincap.io/assets/icons/generic@2x.png'" style="width: 32px; height: 32px; border-radius: 50%;">
                <div class="coin-info">
                    <span class="coin-symbol">${coin.symbol}</span>
                    <span class="coin-name">${coin.name}</span>
                </div>
            </div>
            <div style="text-align: right;">
                <div style="font-weight: 700; font-family: monospace; font-size: 16px;">$${formattedPrice}</div>
                <div style="color: ${changeColor}; font-size: 12px; margin-top: 4px; font-family: monospace;">
                    ${changeSign}${change.toFixed(2)}%
                </div>
            </div>
        </div>`;
    });

    marketListEl.innerHTML = marketHtml;
}

// =====================
// LIVE SEARCH FILTER (FIXED)
// =====================
function filterMarket() {
    const query = document.getElementById("market-search").value.trim().toUpperCase();
    if (!query) {
        renderMarketList(allMarketCoins);
        return;
    }
    const filtered = allMarketCoins.filter(coin => 
        coin.symbol.toUpperCase().includes(query) || 
        coin.name.toUpperCase().includes(query)
    );
    renderMarketList(filtered);
}

// =====================
// TRADINGVIEW CHART SYSTEM (FIXED)
// =====================
function openChart(symbol) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT Chart`;

    let tvSymbol = `BINANCE:${symbol}USDT`;
    if (symbol === "USDC") tvSymbol = "BINANCE:USDCUSDT";

    document.getElementById("tradingview-widget-container").innerHTML = "";

    // تزریق اسکریپت و لود مستقیم ویجت بدون تداخل پلتفرمی
    if (window.TradingView) {
        createTradingViewWidget(tvSymbol);
    } else {
        const script = document.createElement('script');
        script.src = 'https://s3.tradingview.com/tv.js';
        script.type = 'text/javascript';
        script.async = true;
        script.onload = () => { createTradingViewWidget(tvSymbol); };
        document.head.appendChild(script);
    }
}

function createTradingViewWidget(tvSymbol) {
    new TradingView.widget({
        "width": "100%",
        "height": "100%",
        "symbol": tvSymbol,
        "interval": "240", // تایم‌فریم ۴ ساعته برای مینی‌اپ عالی است
        "timezone": "Etc/UTC",
        "theme": "dark",
        "style": "1",
        "locale": "en",
        "toolbar_bg": "#121622",
        "enable_publishing": false,
        "hide_side_toolbar": true,
        "allow_symbol_change": false,
        "container_id": "tradingview-widget-container"
    });
}

function closeChart() {
    document.getElementById("chart-modal").style.display = "none";
    document.getElementById("tradingview-widget-container").innerHTML = "";
}

// =====================
// TELEGRAM USER DATA
// =====================
function loadTelegramUser() {
    const nameEl = document.getElementById("user-name");
    const idEl = document.getElementById("user-id");
    const usernameEl = document.getElementById("user-username");
    const imgEl = document.getElementById("profile-img");

    const user = tg?.initDataUnsafe?.user;

    if (!tg || !user) {
        if (nameEl) nameEl.innerText = "Amir (Guest)";
        if (idEl) idEl.innerText = "987654321";
        if (usernameEl) usernameEl.innerText = "@amir_crypto";
        if (imgEl) imgEl.src = "default.png";
        return;
    }

    if (nameEl) nameEl.innerText = (user.first_name || "") + " " + (user.last_name || "");
    if (idEl) idEl.innerText = user.id || "Unknown ID";
    if (usernameEl) {
        usernameEl.innerText = user.username ? "@" + user.username : "no_username";
    }

    if (imgEl) {
        if (user.username) {
            imgEl.src = `https://t.me/i/userpic/320/${user.username}.jpg`;
        } else {
            imgEl.src = "default.png";
        }
    }
}

// =====================
// NEWS SYSTEM
// =====================
async function loadCryptoNews() {
    const newsListEl = document.getElementById("news-list");
    if (!newsListEl) return;

    try {
        const response = await fetch("https://min-api.cryptocompare.com/data/v1/news/?lang=EN");
        const data = await response.json();

        if (data && data.Data && data.Data.length > 0) {
            let newsHtml = "";
            const topNews = data.Data.slice(0, 6);

            topNews.forEach(article => {
                newsHtml += `
                <div class="card" style="min-height: auto; padding: 15px; margin-bottom: 12px; cursor: pointer;" onclick="window.open('${article.url}', '_blank')">
                    <div style="display: flex; gap: 12px; align-items: center;">
                        <img src="${article.imageurl}" style="width: 55px; height: 55px; border-radius: 12px; object-fit: cover;">
                        <div style="flex: 1;">
                            <div style="font-size: 13px; font-weight: bold; line-height: 1.4; color: #fff;">${article.title.substring(0, 75)}...</div>
                            <div style="font-size: 11px; color: #8f98aa; margin-top: 5px;">📰 ${article.source_info.name}</div>
                        </div>
                    </div>
                </div>`;
            });
            newsListEl.innerHTML = newsHtml;
        }
    } catch (error) {
        console.error("Error fetching news:", error);
    }
}

// =====================
// INITIALIZATION
// =====================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadCryptoNews();

    // به‌روزرسانی قیمت‌ها هر ۸ ثانیه (برای اینکه با تایپ تداخل سنگین ایجاد نکند)
    setInterval(loadMarketAndPrices, 8000);
    setInterval(loadCryptoNews, 300000);
});
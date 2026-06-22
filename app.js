// =====================
// GLOBAL CONFIG & TELEGRAM INIT
// =====================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

let allMarketCoins = [];
let searchTimeout = null;

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
// LIVE PRICES & MARKET (BINANCE API)
// =====================
async function loadMarketAndPrices() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        const data = await response.json();
        
        if (!data || !Array.isArray(data)) return;

        const popularSymbols = [
            "BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT",
            "LINK", "MATIC", "TRX", "UNI", "LTC", "ICP", "NEAR", "APT", "FIL", "OP",
            "ARB", "INJ", "RNDR", "TIA", "SUI", "GALA", "GRT", "FTM", "STX", "THETA",
            "IMX", "LDO", "FLOW", "CRV", "SAND", "MANA", "AXS", "APE", "EGLD", "ALGO",
            "VET", "CHZ", "ZIL", "ENJ", "ONE", "MINA", "DYDX", "WOO", "JUP", "PYTH",
            "ORDI", "1INCH", "AAVE", "AGIX", "ANKR", "BAT", "COMP", "DASH", "ENS",
            "ETC", "FET", "FXS", "GMT", "HOT", "IOTX", "KAVA", "KSM", "LRC", "MKR",
            "NEO", "OCEAN", "OMG", "QTUM", "ROSE", "RUNE", "RVN", "SNX", "STORJ", "SUSHI",
            "WAVES", "XCH", "XEC", "XLM", "XMR", "XTZ", "YFI", "ZEC", "ZEN", "ZRX"
        ];

        allMarketCoins = [];

        popularSymbols.forEach(sym => {
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

        const btcData = allMarketCoins.find(c => c.symbol === "BTC");
        const ethData = allMarketCoins.find(c => c.symbol === "ETH");

        if (btcData && document.getElementById("btc")) {
            const btcPrice = parseFloat(btcData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0});
            document.getElementById("btc").innerHTML = `₿ BTC: $${btcPrice}`;
        }
        if (ethData && document.getElementById("eth")) {
            const ethPrice = parseFloat(ethData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0});
            document.getElementById("eth").innerHTML = `Ξ ETH: $${ethPrice}`;
        }

        const searchInput = document.getElementById("market-search");
        if (searchInput && searchInput.value.trim() === "") {
            renderMarketList(allMarketCoins);
        }
    } catch (err) {
        console.error("Binance API error:", err);
    }
}

function getCoinFullName(sym) {
    const names = {
        "BTC": "Bitcoin", "ETH": "Ethereum", "SOL": "Solana", "BNB": "BNB", "XRP": "Ripple",
        "ADA": "Cardano", "DOGE": "Dogecoin", "AVAX": "Avalanche", "SHIB": "Shiba Inu", "DOT": "Polkadot",
        "LINK": "Chainlink", "MATIC": "Polygon", "TRX": "TRON", "UNI": "Uniswap", "LTC": "Litecoin",
        "NEAR": "Near Protocol", "APT": "Aptos", "FIL": "Filecoin", "OP": "Optimism", "ARB": "Arbitrum",
        "SUI": "Sui", "FTM": "Fantom", "ATOM": "Cosmos", "XLM": "Stellar", "ETC": "Ethereum Classic"
    };
    return names[sym] || sym;
}

function renderMarketList(coins) {
    const marketListEl = document.getElementById("market-list");
    if (!marketListEl) return;

    let marketHtml = "";
    coins.forEach(coin => {
        const price = parseFloat(coin.priceUsd);
        const change = parseFloat(coin.changePercent24Hr);
        
        let formattedPrice = "";
        if (price > 1) {
            formattedPrice = price.toLocaleString(undefined, {maximumFractionDigits: 2});
        } else if (price > 0.0001) {
            formattedPrice = price.toFixed(4);
        } else {
            formattedPrice = price.toFixed(6);
        }
        
        const changeColor = change >= 0 ? "#00ff99" : "#ff4a5a";
        const changeSign = change >= 0 ? "+" : "";
        const iconUrl = `https://raw.githubusercontent.com/spothq/cryptocurrency-icons/master/128/color/${coin.symbol.toLowerCase()}.png`;

        marketHtml += `
        <div class="coin-row" onclick="openChart('${coin.symbol}', '${coin.exchange || ''}')">
            <div style="display: flex; align-items: center; gap: 12px;">
                <div class="coin-icon-container" style="width: 35px; height: 35px; display: flex; align-items: center; justify-content: center;">
                    <img src="${iconUrl}" 
                         onerror="this.style.display='none'; this.nextElementSibling.style.display='flex';" 
                         style="width: 100%; height: 100%; border-radius: 50%; object-fit: cover;">
                    <div class="fake-icon" style="display: none; width: 35px; height: 35px; border-radius: 50%; background: linear-gradient(135deg, #f7931a, #ff4a5a); color: white; font-weight: bold; font-size: 13px; align-items: center; justify-content: center; font-family: sans-serif;">
                        ${coin.symbol.substring(0, 2)}
                    </div>
                </div>
                <div class="coin-info">
                    <span class="coin-symbol">${coin.symbol}</span>
                    <span class="coin-name">${coin.name}</span>
                </div>
            </div>
            <div style="text-align: right;">
                <div style="font-weight: 700; font-family: monospace; font-size: 16px; color:#fff;">$${formattedPrice}</div>
                <div style="color: ${changeColor}; font-size: 12px; margin-top: 4px; font-family: monospace;">
                    ${changeSign}${change.toFixed(2)}%
                </div>
            </div>
        </div>`;
    });

    marketListEl.innerHTML = marketHtml;
}

// =====================
// GUARANTEED SEARCH FUNCTION
// =====================
async function filterMarket() {
    const searchInput = document.getElementById("market-search");
    if (!searchInput) return;

    const query = searchInput.value.trim().toUpperCase();
    
    if (!query) {
        renderMarketList(allMarketCoins);
        return;
    }

    const localFiltered = allMarketCoins.filter(coin => 
        coin.symbol.includes(query) || coin.name.toUpperCase().includes(query)
    );

    if (localFiltered.length > 0) {
        renderMarketList(localFiltered);
        return;
    }

    document.getElementById("market-list").innerHTML = `
        <div style="text-align: center; color: #f7931a; margin-top: 30px; font-size: 14px; font-family: sans-serif;">
            🔍 در حال جستجوی لایو صرافی‌ها برای "${query}"...
        </div>`;

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            try {
                const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${query}USDT`);
                if (r.ok) {
                    const data = await r.json();
                    renderSingleSearchCoin(query, data.lastPrice, data.priceChangePercent, "Binance");
                    return;
                }
            } catch(e){}

            try {
                const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${query}USDT`);
                const data = await r.json();
                if (data?.result?.list?.length > 0) {
                    const ticker = data.result.list[0];
                    renderSingleSearchCoin(query, ticker.lastPrice, parseFloat(ticker.price24hPcnt) * 100, "Bybit");
                    return;
                }
            } catch(e){}

            try {
                const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${query}-USDT`);
                const data = await r.json();
                if (data?.data?.length > 0) {
                    const ticker = data.data[0];
                    renderSingleSearchCoin(query, ticker.last, 0, "OKX");
                    return;
                }
            } catch(e){}

            try {
                const r = await fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${query}_USDT`);
                const data = await r.json();
                if (Array.isArray(data) && data.length > 0) {
                    renderSingleSearchCoin(query, data[0].last, data[0].change_percentage, "Gate.io");
                    return;
                }
            } catch(e){}

            document.getElementById("market-list").innerHTML = `
                <div style="text-align: center; color: #ff4a5a; margin-top: 30px; font-size: 14px; font-family: sans-serif;">
                    ❌ ارز "${query}" در صرافی‌های برتر بازار یافت نشد!
                </div>`;

        } catch (err) {
            console.error("Global Search Error:", err);
        }
    }, 600);
}

function renderSingleSearchCoin(symbol, price, change, exchangeName) {
    const searchedCoin = [{
        symbol: symbol,
        name: `Market: ${exchangeName}`,
        priceUsd: price,
        changePercent24Hr: String(change),
        exchange: exchangeName.toUpperCase().replace(".", "")
    }];
    renderMarketList(searchedCoin);
}

// =====================
// TELEGRAM REAL USER DETECTOR (FIXED & IMPROVED)
// =====================
function loadTelegramUser() {
    const nameEl = document.getElementById("user-name");
    const idEl = document.getElementById("user-id");
    const usernameEl = document.getElementById("user-username");
    const imgEl = document.getElementById("profile-img");

    // گرفتن دیتای زنده کاربر از لایه امنیتی تلگرام
    const userData = tg?.initDataUnsafe?.user;

    if (userData) {
        // ۱. چسباندن نام و نام خانوادگی واقعی کاربر تلگرام
        const firstName = userData.first_name || "";
        const lastName = userData.last_name || "";
        if (nameEl) nameEl.innerText = `${firstName} ${lastName}`.trim();

        // ۲. نمایش آیدی عددی دقیق تلگرام کاربر
        if (idEl) idEl.innerText = userData.id || "نامشخص";

        // ۳. نمایش یوزرنیم کاربر تلگرام
        if (usernameEl) {
            usernameEl.innerText = userData.username ? `@${userData.username}` : "بدون یوزرنیم";
        }

        // ۴. دریافت هوشمند عکس پروفایل از سرور تلگرام
        if (imgEl && userData.username) {
            imgEl.src = `https://t.me/i/userpic/320/${userData.username}.jpg`;
        }
    } else {
        // اطلاعات نمونه لوکس برای زمانی که خارج از تلگرام و در مرورگر تست میکنید
        if (nameEl) nameEl.innerText = "امیر کریپتو (تست سیستم)";
        if (idEl) idEl.innerText = "584930291";
        if (usernameEl) usernameEl.innerText = "@Amir_Crypto";
    }
}

// =====================
// CHART & OTHERS
// =====================
function openChart(symbol, exchange) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT Chart`;

    let tvSymbol = `BINANCE:${symbol}USDT`;
    if (exchange === "BYBIT") tvSymbol = `BYBIT:${symbol}USDT`;
    else if (exchange === "OKX") tvSymbol = `OKX:${symbol}USDT`;
    else if (exchange === "GATEIO" || exchange === "GATE") tvSymbol = `GATE:${symbol}USDT`;
    else if (symbol !== "BTC" && symbol !== "ETH") tvSymbol = `${symbol}USDT`;

    document.getElementById("tradingview-widget-container").innerHTML = "";

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
        "interval": "240",
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
}

async function loadCryptoNews() {
    const newsListEl = document.getElementById("news-list");
    if (!newsListEl) return;
    try {
        const response = await fetch("http://127.0.0.1:8000/api/farsi-news");
        const result = await response.json();
        if (result.status === "success" && result.data.length > 0) {
            let newsHtml = "";
            result.data.forEach(article => {
                newsHtml += `
                <div class="card" style="padding: 15px; margin-bottom: 12px; direction: rtl;" onclick="window.open('${article.url}', '_blank')">
                    <div style="display: flex; gap: 12px; align-items: center; flex-direction: row-reverse;">
                        <img src="${article.image}" style="width: 55px; height: 55px; border-radius: 12px; object-fit: cover;">
                        <div style="flex: 1; text-align: right;">
                            <div style="font-size: 14px; font-weight: bold; color: #fff;">${article.title}</div>
                            <div style="font-size: 11px; color: #8f98aa; margin-top: 6px;">📰 منبع: ${article.source}</div>
                        </div>
                    </div>
                </div>`;
            });
            newsListEl.innerHTML = newsHtml;
        }
    } catch (e) {
        newsListEl.innerHTML = `<div class="card" style="text-align:center; color:#8f98aa;">خطا در بارگذاری اخبار.</div>`;
    }
}

async function loadAnalysisData() {
    const analysisListEl = document.getElementById("analysis-list");
    if (!analysisListEl) return;
    try {
        const response = await fetch("http://127.0.0.1:8000/api/analysis");
        const result = await response.json();
        if (result.status === "success" && result.data.length > 0) {
            let analysisHtml = "";
            result.data.forEach(item => {
                analysisHtml += `
                <div class="card" style="padding: 18px; margin-bottom: 15px; direction: rtl; text-align:right;">
                    <div style="display: flex; justify-content: space-between; color: #f7931a; margin-bottom: 10px; font-weight: bold;">
                        <span>🎯 ${item.title}</span>
                        <span style="color: #8f98aa; font-weight: normal;">${item.date}</span>
                    </div>
                    <p style="color: #e1e4ea; font-size: 14px; white-space: pre-line;">${item.text}</p>
                    <div style="color: #00ff99; font-weight: bold; margin-top:10px;">${item.tag}</div>
                </div>`;
            });
            analysisListEl.innerHTML = analysisHtml;
        }
    } catch (e) {}
}

// =====================
// INITIALIZATION
// =====================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser(); // اجرای فوری موتور شناسایی کاربر تلگرام
    loadMarketAndPrices();
    loadCryptoNews();
    loadAnalysisData();
    setInterval(loadMarketAndPrices, 8000);
});
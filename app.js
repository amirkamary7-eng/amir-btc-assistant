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
// LIVE PRICES & MARKET (POWERED BY BINANCE API)
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
                    changePercent24Hr: ticker.priceChangePercent
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
        if (searchInput && searchInput.value === "") {
            renderMarketList(allMarketCoins);
        }

    } catch (err) {
        console.error("Binance API Network error:", err);
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
        <div class="coin-row" onclick="openChart('${coin.symbol}')">
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
// LIVE SEARCH FILTER (BINANCE -> GLOBAL HYBRID)
// =====================
let searchTimeout = null;

async function filterMarket() {
    const query = document.getElementById("market-search").value.trim().toUpperCase();
    
    if (!query) {
        renderMarketList(allMarketCoins);
        return;
    }

    const localFiltered = allMarketCoins.filter(coin => 
        coin.symbol.toUpperCase().includes(query) || 
        coin.name.toUpperCase().includes(query)
    );

    if (localFiltered.length > 0) {
        renderMarketList(localFiltered);
        return;
    }

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            // ۱. بررسی صرافی بایننس
            const binanceResp = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${query}USDT`);
            
            if (binanceResp.ok) {
                const ticker = await binanceResp.json();
                const searchedCoin = [{
                    symbol: query,
                    name: query,
                    priceUsd: ticker.lastPrice,
                    changePercent24Hr: ticker.priceChangePercent
                }];
                renderMarketList(searchedCoin);
                return;
            }

            // ۲. بررسی صرافی جانبی برای ارزهایی مثل HYPE
            const globalResp = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${query}USDT`);
            const globalData = await globalResp.json();
            
            if (globalData && globalData.result && globalData.result.list && globalData.result.list.length > 0) {
                const ticker = globalData.result.list[0];
                const searchedCoin = [{
                    symbol: query,
                    name: query,
                    priceUsd: ticker.lastPrice,
                    changePercent24Hr: (parseFloat(ticker.price24hPcnt) * 100).toString()
                }];
                renderMarketList(searchedCoin);
                return;
            }

            document.getElementById("market-list").innerHTML = `
                <div style="text-align: center; color: #8f98aa; margin-top: 30px; font-size: 14px;">
                    ❌ ارز "${query}" یافت نشد!
                </div>`;

        } catch (err) {
            console.error("Hybrid Search Error:", err);
        }
    }, 500);
}

// =====================
// TRADINGVIEW CHART SYSTEM (AUTO EXCHANGE)
// =====================
function openChart(symbol) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT Chart`;

    const foundCoin = allMarketCoins.find(c => c.symbol === symbol);
    let tvSymbol = `BINANCE:${symbol}USDT`;
    
    // اگر ارز در لیست ۱00 تای بایننس نبود، اجازه بده تریدینگ‌وی صرافی مناسب (مثل BYBIT یا OKX) را خودش پیدا کند
    if (!foundCoin && symbol !== "BTC" && symbol !== "ETH") {
        tvSymbol = `${symbol}USDT`; 
    }

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
    document.getElementById("tradingview-widget-container").innerHTML = "";
}

// =====================
// NEWS SYSTEM (FARSI TRANSLATED FROM PYTHON)
// =====================
async function loadCryptoNews() {
    const newsListEl = document.getElementById("news-list");
    if (!newsListEl) return;

    try {
        const YOUR_SERVER_URL = "http://127.0.0.1:8000"; 
        const response = await fetch(`${YOUR_SERVER_URL}/api/farsi-news`);
        const result = await response.json();

        if (result.status === "success" && result.data.length > 0) {
            let newsHtml = "";

            result.data.forEach(article => {
                newsHtml += `
                <div class="card" style="min-height: auto; padding: 15px; margin-bottom: 12px; cursor: pointer; direction: rtl;" onclick="window.open('${article.url}', '_blank')">
                    <div style="display: flex; gap: 12px; align-items: center; flex-direction: row-reverse;">
                        <img src="${article.image}" style="width: 55px; height: 55px; border-radius: 12px; object-fit: cover;">
                        <div style="flex: 1; text-align: right;">
                            <div style="font-size: 14px; font-weight: bold; line-height: 1.5; color: #fff; font-family: Tahoma, sans-serif;">${article.title}</div>
                            <div style="font-size: 11px; color: #8f98aa; margin-top: 6px;">📰 منبع: ${article.source}</div>
                        </div>
                    </div>
                </div>`;
            });
            newsListEl.innerHTML = newsHtml;
        }
    } catch (error) {
        console.error("Error fetching Farsi news:", error);
        newsListEl.innerHTML = `<div class="card" style="text-align:center;">خطا در بارگذاری اخبار فارسی.</div>`;
    }
}

// =====================
// ANALYSIS SYSTEM (LIVE FROM PYTHON DATABASE)
// =====================
async function loadAnalysisData() {
    const analysisListEl = document.getElementById("analysis-list");
    if (!analysisListEl) return;

    try {
        const YOUR_SERVER_URL = "http://127.0.0.1:8000"; 
        const response = await fetch(`${YOUR_SERVER_URL}/api/analysis`);
        const result = await response.json();

        if (result.status === "success" && result.data.length > 0) {
            let analysisHtml = "";

            result.data.forEach(item => {
                analysisHtml += `
                <div class="card" style="min-height: auto; padding: 18px; margin-bottom: 15px; direction: rtl;">
                    <div style="display: flex; justify-content: space-between; font-size: 13px; color: #f7931a; margin-bottom: 10px; font-weight: bold;">
                        <span>🎯 ${item.title}</span>
                        <span style="color: #8f98aa; font-weight: normal;">${item.date}</span>
                    </div>
                    <p style="font-size: 14px; line-height: 1.7; margin: 0; color: #e1e4ea; text-align: right; white-space: pre-line; font-family: Tahoma, sans-serif;">
                        ${item.text}
                    </p>
                    <div style="margin-top: 12px; font-size: 12px; color: #00ff99; font-weight: bold; text-align: right;">${item.tag}</div>
                </div>`;
            });
            analysisListEl.innerHTML = analysisHtml;
        } else {
            analysisListEl.innerHTML = `
                <div class="card" style="text-align: center; color: #8f98aa;">
                    📥 هنوز تحلیلی منتشر نشده است.
                </div>`;
        }
    } catch (error) {
        console.error("Error fetching analysis:", error);
        analysisListEl.innerHTML = `<div class="card" style="text-align: center;">خطا در دریافت تحلیل‌ها.</div>`;
    }
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

    if (imgEl && user.username) {
        imgEl.src = `https://t.me/i/userpic/320/${user.username}.jpg`;
    }
}

// =====================
// INITIALIZATION
// =====================
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadCryptoNews();
    loadAnalysisData();

    // متصل کردن فیلد سرچ به موتور جستجو
    const searchInput = document.getElementById("market-search");
    if (searchInput) {
        searchInput.addEventListener("input", filterMarket);
    }

    setInterval(loadMarketAndPrices, 5000);
    setInterval(loadCryptoNews, 300000);
    setInterval(loadAnalysisData, 15000);
});
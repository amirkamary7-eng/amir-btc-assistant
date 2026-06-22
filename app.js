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
            document.getElementById("btc").innerHTML = `₿ BTC: $${parseFloat(btcData.priceUsd).toLocaleString()}`;
        }
        if (ethData && document.getElementById("eth")) {
            document.getElementById("eth").innerHTML = `Ξ ETH: $${parseFloat(ethData.priceUsd).toLocaleString()}`;
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
        "ADA": "Cardano", "DOGE": "Dogecoin", "AVAX": "Avalanche", "SHIB": "Shiba Inu", "DOT": "Polkadot"
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
        const formattedPrice = price > 1 ? price.toLocaleString() : price.toFixed(4);
        const changeColor = change >= 0 ? "#00ff99" : "#ff4a5a";

        marketHtml += `
        <div class="coin-row" onclick="openChart('${coin.symbol}', '${coin.exchange || ''}')" style="display: flex; justify-content: space-between; align-items: center; padding: 12px; border-bottom: 1px solid #1a2235; cursor: pointer;">
            <div>
                <span class="coin-symbol" style="font-weight: bold; color: #fff;">${coin.symbol}</span>
                <span class="coin-name" style="font-size: 12px; color: #8f98aa; margin-left: 8px;">${coin.name}</span>
            </div>
            <div style="text-align: right;">
                <div style="color: #fff; font-weight: bold;">$${formattedPrice}</div>
                <div style="color: ${changeColor}; font-size: 12px;">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</div>
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
    
    // اگر کادر جستجو خالی بود، لیست اصلی را برگردان
    if (!query) {
        renderMarketList(allMarketCoins);
        return;
    }

    // ۱. سرچ فوری در لیست ۱۰۰ ارز برتر داخلی
    const localFiltered = allMarketCoins.filter(coin => 
        coin.symbol.includes(query) || coin.name.toUpperCase().includes(query)
    );

    if (localFiltered.length > 0) {
        renderMarketList(localFiltered);
        return;
    }

    // نمایش وضعیت در حال جستجو
    document.getElementById("market-list").innerHTML = `
        <div style="text-align: center; color: #f7931a; margin-top: 30px; font-size: 14px;">
            🔍 در حال جستجوی جهانی ارز "${query}"...
        </div>`;

    clearTimeout(searchTimeout);
    searchTimeout = setTimeout(async () => {
        try {
            // ۲. بررسی صرافی بایننس
            try {
                const r = await fetch(`https://api.binance.com/api/v3/ticker/24hr?symbol=${query}USDT`);
                if (r.ok) {
                    const data = await r.json();
                    renderSingleSearchCoin(query, data.lastPrice, data.priceChangePercent, "BINANCE");
                    return;
                }
            } catch(e){}

            // ۳. بررسی صرافی بای‌بیت (بهترین گزینه برای ارزهایی مثل HYPE)
            try {
                const r = await fetch(`https://api.bybit.com/v5/market/tickers?category=linear&symbol=${query}USDT`);
                const data = await r.json();
                if (data?.result?.list?.length > 0) {
                    const ticker = data.result.list[0];
                    renderSingleSearchCoin(query, ticker.lastPrice, parseFloat(ticker.price24hPcnt) * 100, "BYBIT");
                    return;
                }
            } catch(e){}

            // ۴. بررسی صرافی اوکی‌اکس
            try {
                const r = await fetch(`https://www.okx.com/api/v5/market/ticker?instId=${query}-USDT`);
                const data = await r.json();
                if (data?.data?.length > 0) {
                    const ticker = data.data[0];
                    renderSingleSearchCoin(query, ticker.last, 0, "OKX");
                    return;
                }
            } catch(e){}

            // ۵. بررسی صرافی گیت
            try {
                const r = await fetch(`https://api.gateio.ws/api/v4/spot/tickers?currency_pair=${query}_USDT`);
                const data = await r.json();
                if (Array.isArray(data) && data.length > 0) {
                    renderSingleSearchCoin(query, data[0].last, data[0].change_percentage, "GATEIO");
                    return;
                }
            } catch(e){}

            // اگر در هیچ صرافی پیدا نشد
            document.getElementById("market-list").innerHTML = `
                <div style="text-align: center; color: #ff4a5a; margin-top: 30px; font-size: 14px;">
                    ❌ ارز "${query}" در هیچ صرافی معتبری پیدا نشد.
                </div>`;

        } catch (err) {
            console.error("Global Search Error:", err);
        }
    }, 600);
}

function renderSingleSearchCoin(symbol, price, change, exchangeName) {
    const searchedCoin = [{
        symbol: symbol,
        name: `${symbol} (${exchangeName} Market)`,
        priceUsd: price,
        changePercent24Hr: String(change),
        exchange: exchangeName
    }];
    renderMarketList(searchedCoin);
}

// =====================
// CHART & OTHERS (NO CHANGE)
// =====================
function openChart(symbol, exchange) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT Chart`;

    let tvSymbol = `BINANCE:${symbol}USDT`;
    if (exchange === "BYBIT") tvSymbol = `BYBIT:${symbol}USDT`;
    else if (exchange === "OKX") tvSymbol = `OKX:${symbol}USDT`;
    else if (exchange === "GATEIO") tvSymbol = `GATE:${symbol}USDT`;
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

window.addEventListener("DOMContentLoaded", () => {
    loadMarketAndPrices();
    loadCryptoNews();
    loadAnalysisData();
    setInterval(loadMarketAndPrices, 8000);
});
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

        const popularSymbols = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT", "LINK", "MATIC", "TRX", "UNI", "LTC"];
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
        if (btcData && document.getElementById("dash-btc-price")) {
            const btcPrice = parseFloat(btcData.priceUsd).toLocaleString(undefined, {maximumFractionDigits: 0});
            document.getElementById("dash-btc-price").innerHTML = `BTC $${btcPrice}`;
        }

        renderMarketList(allMarketCoins);
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
                <div style="color: ${changeColor}; font-size: 11px; margin-top: 2px; font-family: monospace;">${change >= 0 ? '+' : ''}${change.toFixed(2)}%</div>
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
        html += `
        <div style="display:flex; justify-content:space-between; padding:8px 0; border-bottom:1px solid rgba(255,255,255,0.02)">
            <span style="font-weight:bold;">${coin.symbol}</span>
            <span style="font-family:monospace; color:${change >= 0 ? "#00ffaa" : "#ff3355"}">${change >= 0 ? '+':''}${change.toFixed(2)}%</span>
            <span style="font-family:monospace;">$${parseFloat(coin.priceUsd).toLocaleString()}</span>
        </div>`;
    }
    miniEl.innerHTML = html;
}

// =====================
// EXTRA METRICS
// =====================
async function loadExtraMetrics() {
    try {
        const res = await fetch("https://api.alternative.me/fng/");
        const json = await res.json();
        if(json?.data?.[0]) {
            const val = json.data[0].value;
            const status = json.data[0].value_classification;
            if(document.getElementById("fg-value")) document.getElementById("fg-value").innerText = val;
            if(document.getElementById("fg-status")) document.getElementById("fg-status").innerText = getFarsiFngStatus(status);
        }
    } catch(e){}
    const liqEl = document.getElementById("liq-value");
    if(liqEl) liqEl.innerText = `$${(Math.random() * (180 - 110) + 110).toFixed(1)}M`;
}

function getFarsiFngStatus(status) {
    const trans = { "Extreme Fear": "ترس شدید 😨", "Fear": "ترس 📉", "Neutral": "خنثی 😐", "Greed": "طمع 📈", "Extreme Greed": "طمع شدید 🚀" };
    return trans[status] || status;
}

// =====================
// NEWS SYSTEM (اصلاح شده)
// =====================
async function loadPersianNews() {
    const newsListEl = document.getElementById("news-list");
    if (!newsListEl) return;
    
    const rssUrl = "https://arzdigital.com/feed/"; 
    const apiUrl = `https://api.rss2json.com/v1/api.json?rss_url=${encodeURIComponent(rssUrl)}`;

    try {
        const response = await fetch(apiUrl);
        const data = await response.json();
        
        if (data.status === 'ok') {
            newsListEl.innerHTML = ""; 
            data.items.slice(0, 7).forEach(item => {
                const div = document.createElement("div");
                div.className = "glass-card";
                div.style.textAlign = "right";
                div.style.direction = "rtl";
                div.style.padding = "15px";
                div.style.marginBottom = "10px";
                div.style.cursor = "pointer";
                
                div.innerHTML = `
                    <div style="font-size: 14px; font-weight: bold; margin-bottom: 8px;">${item.title}</div>
                    <div style="font-size: 12px; color: var(--text-sub);">${item.description.substring(0, 100)}...</div>
                `;
                div.onclick = () => showNewsModal(item.title, item.description, item.content);
                newsListEl.appendChild(div);
            });
        }
    } catch (e) {
        newsListEl.innerHTML = `<div style="text-align:center; padding:20px;">خطا در دریافت اخبار</div>`;
    }
}

function showNewsModal(title, description, content) {
    const modal = document.getElementById("news-modal");
    const titleEl = document.getElementById("news-title-modal");
    const contentEl = document.getElementById("news-content-modal");

    if (modal && titleEl && contentEl) {
        titleEl.innerText = title;
        contentEl.innerHTML = content || description; 
        modal.style.display = "flex";
    }
}

// =====================
// TELEGRAM & CHART
// =====================
function loadTelegramUser() {
    const userData = tg?.initDataUnsafe?.user;
    if (userData) {
        if (document.getElementById("user-name")) document.getElementById("user-name").innerText = `${userData.first_name || ""} ${userData.last_name || ""}`;
    }
}

function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    if (!container) return;
    container.innerHTML = "";
    const script = document.createElement("script");
    script.src = "https://telegram.org/js/telegram-widget.js?22";
    script.setAttribute("data-telegram-discussion", "amir_btc_a");
    script.setAttribute("data-comments-limit", "5");
    script.setAttribute("data-dark", "1");
    script.setAttribute("data-width", "100%");
    container.appendChild(script);
}

function openChart(symbol) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    document.getElementById("tradingview-widget-container").innerHTML = "";
    new TradingView.widget({
        "width": "100%", "height": "100%", "symbol": `BINANCE:${symbol}USDT`,
        "interval": "240", "theme": "dark", "style": "1", "container_id": "tradingview-widget-container"
    });
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
    setInterval(loadMarketAndPrices, 10000);
});
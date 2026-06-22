// ==========================================
// CONFIG & INITIALIZATION
// ==========================================
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const MY_TELEGRAM_CHANNEL = "amir_btc_assistant"; 
let allMarketCoins = [];
let lastPrices = {};
let searchTimeout = null;

// ==========================================
// UX HELPERS (Haptic & Effects)
// ==========================================
function triggerHaptic(type = 'light') {
    if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred(type);
}

function applyPriceEffect(el, isUp) {
    el.classList.remove('price-up', 'price-down');
    void el.offsetWidth;
    el.classList.add(isUp ? 'price-up' : 'price-down');
}

// ==========================================
// MAIN LOGIC (Market & UI)
// ==========================================
async function loadMarketAndPrices() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        const data = await response.json();
        
        if (!data || !Array.isArray(data)) return;

        const popularSymbols = ["BTC", "ETH", "SOL", "BNB", "XRP", "ADA", "DOGE", "AVAX", "SHIB", "DOT"];
        allMarketCoins = [];

        popularSymbols.forEach(sym => {
            const ticker = data.find(item => item.symbol === `${sym}USDT`);
            if (ticker) {
                allMarketCoins.push({
                    symbol: sym,
                    name: sym === "BTC" ? "Bitcoin" : sym,
                    priceUsd: ticker.lastPrice,
                    changePercent24Hr: ticker.priceChangePercent
                });
            }
        });

        // بروزرسانی قیمت داشبورد با افکت
        const btcData = allMarketCoins.find(c => c.symbol === "BTC");
        const el = document.getElementById("dash-btc-price");
        if (btcData && el) {
            const price = parseFloat(btcData.priceUsd);
            if (lastPrices['BTC'] && price !== lastPrices['BTC']) applyPriceEffect(el, price > lastPrices['BTC']);
            el.innerText = `BTC $${price.toLocaleString(undefined, {maximumFractionDigits:0})}`;
            lastPrices['BTC'] = price;
        }

        renderMarketList(allMarketCoins);
    } catch (err) { console.error(err); }
}

function renderMarketList(coins) {
    const marketListEl = document.getElementById("market-list");
    if (!marketListEl) return;
    marketListEl.innerHTML = coins.map(coin => `
        <div class="coin-row" onclick="openChart('${coin.symbol}')">
            <div class="coin-info"><span class="coin-symbol">${coin.symbol}</span></div>
            <div style="text-align:right">
                <div style="font-weight:bold">$${parseFloat(coin.priceUsd).toLocaleString()}</div>
                <div style="font-size:11px; color:${coin.changePercent24Hr >= 0 ? '#00ffaa' : '#ff3355'}">
                    ${coin.changePercent24Hr}%
                </div>
            </div>
        </div>`).join('');
}

// ==========================================
// PAGES & CHAT
// ==========================================
function showPage(pageId, element) {
    triggerHaptic('soft');
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    document.getElementById(pageId).style.display = 'block';
    if (element) {
        document.querySelectorAll('.nav-item, .center-btn').forEach(i => i.classList.remove('active'));
        element.classList.add('active');
    }
}

function openChart(symbol) {
    triggerHaptic('medium');
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    new TradingView.widget({
        "container_id": "tradingview-widget-container",
        "symbol": `BINANCE:${symbol}USDT`,
        "theme": "dark", "width": "100%", "height": "100%", "interval": "D"
    });
}

function closeChart() { document.getElementById("chart-modal").style.display = "none"; }

// ==========================================
// INIT
// ==========================================
window.addEventListener("DOMContentLoaded", () => {
    loadMarketAndPrices();
    setInterval(loadMarketAndPrices, 10000);
});
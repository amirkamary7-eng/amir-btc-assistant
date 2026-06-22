// =====================
// GLOBAL CONFIG & TELEGRAM INIT
// =====================
const tg = window.Telegram?.WebApp;
if (tg) {
    tg.ready();
    tg.expand();
}

const MY_TELEGRAM_CHANNEL = "amir_btc_2024"; // آیدی کانال شما

// =====================
// PAGE SWITCH SYSTEM
// =====================
function showPage(pageId, element) {
    document.querySelectorAll('.page').forEach(page => page.style.display = 'none');
    document.getElementById(pageId).style.display = 'block';

    document.querySelectorAll('.nav-item').forEach(item => item.classList.remove('active'));
    if (element) element.classList.add('active');
}

// =====================
// ANALYSES & TELEGRAM FEED
// =====================
function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    if (!container) return;

    // بارگذاری ویجت کانال شما
    container.innerHTML = `<script async src="https://telegram.org/js/telegram-widget.js?22" 
        data-telegram-post="${MY_TELEGRAM_CHANNEL}/1" 
        data-width="100%" 
        data-dark="1"></script>`;
    
    // آپدیت متن عنوان در صفحه داشبورد
    const titleEl = document.getElementById("dash-last-analysis-title");
    if(titleEl) titleEl.innerText = `مشاهده تحلیل‌های جدید در کانال @${MY_TELEGRAM_CHANNEL}`;
}

// =====================
// LIVE MARKET DATA
// =====================
async function loadMarket() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        const data = await response.json();
        
        const btc = data.find(c => c.symbol === "BTCUSDT");
        if (btc) {
            document.getElementById("dash-btc-price").innerText = `BTC $${parseFloat(btc.lastPrice).toLocaleString(undefined, {maximumFractionDigits:0})}`;
        }
        
        // شبیه‌ساز داده برای صفحه مارکت (لیست اولیه)
        const popular = ["BTC", "ETH", "SOL", "BNB", "XRP"];
        let html = "";
        popular.forEach(s => {
            const coin = data.find(c => c.symbol === `${s}USDT`);
            html += `<div class="coin-row" onclick="openChart('${s}')"><span>${s}</span><span>$${parseFloat(coin.lastPrice).toLocaleString()}</span></div>`;
        });
        document.getElementById("market-list").innerHTML = html;
    } catch(e) {}
}

// =====================
// INIT
// =====================
window.addEventListener("DOMContentLoaded", () => {
    // اطلاعات کاربر
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        document.getElementById("dash-user-name").innerText = user.first_name;
        document.getElementById("user-name").innerText = `${user.first_name} ${user.last_name || ""}`;
        document.getElementById("user-username").innerText = user.username ? `@${user.username}` : "";
    }
    
    loadMarket();
    loadAnalysisData();
    // لود شاخص ترس و طمع
    fetch("https://api.alternative.me/fng/").then(r => r.json()).then(data => {
        document.getElementById("fg-value").innerText = data.data[0].value;
        document.getElementById("fg-status").innerText = data.data[0].value_classification;
    });
});

// =====================
// CHART
// =====================
function openChart(symbol) {
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    new TradingView.widget({
        "container_id": "tradingview-widget-container",
        "symbol": `BINANCE:${symbol}USDT`,
        "theme": "dark",
        "width": "100%",
        "height": "100%"
    });
}

function closeChart() { document.getElementById("chart-modal").style.display = "none"; }
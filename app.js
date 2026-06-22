const MY_TELEGRAM_CHANNEL = "amir_btc_2024";

// تنظیم اولیه تلگرام
const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

window.addEventListener("DOMContentLoaded", () => {
    // اجرای توابع در زمان لود صفحه
    loadTelegramUser();
    loadMarketAndPrices();
    loadExtraMetrics();
    loadAnalysisData();
});

// نمایش نام کاربر
function loadTelegramUser() {
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        document.getElementById("user-name") && (document.getElementById("user-name").innerText = user.first_name);
    }
}

// لود قیمت‌ها
async function loadMarketAndPrices() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        const data = await response.json();
        const btc = data.find(c => c.symbol === "BTCUSDT");
        if (btc) {
            const price = parseFloat(btc.lastPrice).toLocaleString();
            document.getElementById("btc-price") && (document.getElementById("btc-price").innerText = `$${price} BTC`);
        }
    } catch(e) { console.error("Market Load Error:", e); }
}

// لود شاخص ترس و طمع
async function loadExtraMetrics() {
    try {
        const res = await fetch("https://api.alternative.me/fng/");
        const json = await res.json();
        if (json.data) {
            document.getElementById("fg-value") && (document.getElementById("fg-value").innerText = json.data[0].value);
        }
    } catch(e) { console.error("Metrics Load Error:", e); }
}

// نمایش پست تلگرام
function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    if (container) {
        container.innerHTML = `<script async src="https://telegram.org/js/telegram-widget.js?22" 
            data-telegram-post="${MY_TELEGRAM_CHANNEL}/1" 
            data-width="100%" 
            data-dark="1"></script>`;
    }
}
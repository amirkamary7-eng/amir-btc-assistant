// ==========================================
// آیدی کانال شما (فقط این را تغییر دهید)
const MY_TELEGRAM_CHANNEL = "amir_btc_2024"; 
// ==========================================

const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

// تابع جابجایی بین صفحات
function showPage(pageId, navItem) {
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    document.getElementById(pageId).style.display = 'block';

    document.querySelectorAll('.nav-item, .center-btn').forEach(i => i.classList.remove('active'));
    if (navItem) navItem.classList.add('active');
}

// لود اطلاعات کاربر تلگرام
function loadTelegramUser() {
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        document.querySelector('.profile-name').innerText = `${user.first_name || ""} ${user.last_name || ""}`.trim();
        document.getElementById('user-id').innerText = user.id;
        document.getElementById('user-username').innerText = user.username ? `@${user.username}` : "";
        if (user.username) {
            document.querySelector('.profile-img').src = `https://t.me/i/userpic/320/${user.username}.jpg`;
        }
    }
}

// لود قیمت‌های زنده از بایننس
async function loadMarketAndPrices() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        const data = await response.json();
        const btc = data.find(c => c.symbol === "BTCUSDT");
        
        if (btc) {
            document.getElementById("btc-price-card").innerText = `$${parseFloat(btc.lastPrice).toLocaleString()}`;
        }
    } catch(e) { console.error("Error loading prices:", e); }
}

// لود فید کانال تلگرام (تحلیل‌ها)
function loadAnalysisData() {
    const container = document.getElementById("telegram-feed-container");
    container.innerHTML = `<script async src="https://telegram.org/js/telegram-widget.js?22" 
        data-telegram-post="${MY_TELEGRAM_CHANNEL}/1" 
        data-width="100%" 
        data-dark="1"></script>`;
}

// مدیریت باز کردن چارت (TradingView)
function openChart(symbol) {
    document.querySelector('.modal').style.display = 'flex';
    document.getElementById('modal-coin-title').innerText = `${symbol} / USDT`;
    
    // پاک کردن محتوای قبلی قبل از لود جدید
    document.getElementById('tradingview-widget-container').innerHTML = "";
    
    new TradingView.widget({
        "container_id": "tradingview-widget-container",
        "symbol": `BINANCE:${symbol}USDT`,
        "theme": "dark",
        "width": "100%",
        "height": "100%",
        "interval": "D"
    });
}

function closeChart() {
    document.querySelector('.modal').style.display = 'none';
}

// اجرای اولیه
window.addEventListener("DOMContentLoaded", () => {
    loadTelegramUser();
    loadMarketAndPrices();
    loadAnalysisData();
    // بروزرسانی قیمت هر ۳۰ ثانیه
    setInterval(loadMarketAndPrices, 30000);
});
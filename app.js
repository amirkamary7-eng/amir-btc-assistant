// ==========================================================
// 1. CONFIG & INITIALIZATION (ثابت‌ها)
// ==========================================================
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

let lastPrices = {}; // برای ذخیره آخرین قیمت و تشخیص تغییر
let marketInterval = null;

// ==========================================================
// 2. UX & EFFECTS (ویبره و افکت نئونی)
// ==========================================================
function triggerHaptic(type = 'light') {
    if (tg?.HapticFeedback) tg.HapticFeedback.impactOccurred(type);
}

function applyPriceEffect(el, isUp) {
    if (!el) return;
    el.classList.remove('price-up', 'price-down');
    void el.offsetWidth; // ریست کردن انیمیشن
    el.classList.add(isUp ? 'price-up' : 'price-down');
}

// ==========================================================
// 3. CORE LOGIC (بهینه‌شده برای سرعت)
// ==========================================================
async function loadMarketAndPrices() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/24hr");
        const data = await response.json();
        if (!data || !Array.isArray(data)) return;

        // لیست سکه‌های محبوب برای نمایش سریع
        const popularSymbols = ["BTC", "ETH", "SOL", "BNB", "XRP"];
        
        popularSymbols.forEach(sym => {
            const ticker = data.find(item => item.symbol === `${sym}USDT`);
            if (ticker) {
                const price = parseFloat(ticker.lastPrice);
                const elId = `price-${sym}`;
                const el = document.getElementById(elId);
                
                // اعمال افکت فقط در صورت تغییر قیمت
                if (el) {
                    if (lastPrices[sym] && price !== lastPrices[sym]) {
                        applyPriceEffect(el, price > lastPrices[sym]);
                    }
                    el.innerText = `$${price.toLocaleString()}`;
                    lastPrices[sym] = price;
                }
            }
        });
    } catch (err) { console.error("Error loading prices:", err); }
}

// ==========================================================
// 4. NAVIGATION (بدون حذفِ کدهای قبلی شما)
// ==========================================================
function showPage(pageId, element) {
    triggerHaptic('soft');
    
    // مخفی کردن همه صفحات
    document.querySelectorAll('.page').forEach(p => p.style.display = 'none');
    // نمایش صفحه فعلی
    document.getElementById(pageId).style.display = 'block';

    // مدیریت کلاس active
    if (element) {
        document.querySelectorAll('.nav-item, .center-btn').forEach(i => i.classList.remove('active'));
        element.classList.add('active');
    }
}

function openChart(symbol) {
    triggerHaptic('medium');
    document.getElementById("chart-modal").style.display = "flex";
    document.getElementById("modal-coin-title").innerText = `${symbol} / USDT`;
    
    // لود ویجت تریدینگ ویو
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
    triggerHaptic('light');
    document.getElementById("chart-modal").style.display = "none";
    // پاکسازی ویجت برای جلوگیری از هنگ کردن
    document.getElementById("tradingview-widget-container").innerHTML = "";
}

// ==========================================================
// 5. INIT (اجرای خودکار)
// ==========================================================
window.addEventListener("DOMContentLoaded", () => {
    // اجرای اولیه
    loadMarketAndPrices();
    
    // تنظیم اینتروال برای آپدیت هر 15 ثانیه (برای جلوگیری از هنگ کردن)
    marketInterval = setInterval(loadMarketAndPrices, 15000);
});
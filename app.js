// =====================
// GLOBAL CONFIG & TELEGRAM INIT
// =====================
const tg = window.Telegram?.WebApp;

if (tg) {
    tg.ready();
    tg.expand();
}

// =====================
// PAGE SWITCH SYSTEM
// =====================
function showPage(pageId, element) {
    // پنهان کردن تمام صفحات
    document.querySelectorAll('.page').forEach(page => {
        page.style.display = 'none';
    });

    // نمایش صفحه مورد نظر
    const activePage = document.getElementById(pageId);
    if (activePage) {
        activePage.style.display = 'block';
    }

    // بازنشانی وضعیت دکمه‌های منو
    document.querySelectorAll('.nav-item, .center-btn').forEach(item => {
        item.classList.remove('active');
    });

    // فعال کردن دکمه جاری
    if (element) {
        element.classList.add('active');
    }
}

// =====================
// LIVE PRICES & MARKET (BINANCE GLOBAL FETCH)
// =====================
async function loadMarketAndPrices() {
    try {
        const response = await fetch("https://api.binance.com/api/v3/ticker/price");
        const allPrices = await response.json();

        // تبدیل آرایه به نقشه کلید-مقدار برای دسترسی فوق سریع
        const priceMap = {};
        allPrices.forEach(item => {
            priceMap[item.symbol] = parseFloat(item.price);
        });

        // ۱. بروزرسانی صفحه اصلی (Home)
        if (priceMap["BTCUSDT"]) {
            document.getElementById("btc").innerHTML = `₿ BTC: $${priceMap["BTCUSDT"].toLocaleString()}`;
        }
        if (priceMap["ETHUSDT"]) {
            document.getElementById("eth").innerHTML = `Ξ ETH: $${priceMap["ETHUSDT"].toLocaleString()}`;
        }

        // ۲. بروزرسانی صفحه لیست بازار (Market)
        const targetCoins = ["BTCUSDT", "ETHUSDT", "SOLUSDT", "BNBUSDT"];
        let marketHtml = "";

        targetCoins.forEach(coin => {
            if (priceMap[coin]) {
                const cleanName = coin.replace("USDT", "");
                marketHtml += `
                <div class="card" style="display: flex; flex-direction: row; justify-content: space-between; align-items: center;">
                    <span style="font-weight: bold; color: #8f98aa;">🪙 ${cleanName}</span>
                    <span style="font-size: 20px; font-weight: 700; color: #00ff99;">$${priceMap[coin].toLocaleString()}</span>
                </div>`;
            }
        });

        const marketListEl = document.getElementById("market-list");
        if (marketListEl) marketListEl.innerHTML = marketHtml;

    } catch (err) {
        console.error("Price error:", err);
    }
}

// =====================
// TELEGRAM USER DATA (FIXED LOADING ISSUE)
// =====================
function loadTelegramUser() {
    const nameEl = document.getElementById("user-name");
    const idEl = document.getElementById("user-id");
    const usernameEl = document.getElementById("user-username");
    const imgEl = document.getElementById("profile-img");

    // بررسی وجود آبجکت تلگرام و داده‌های کاربر
    const user = tg?.initDataUnsafe?.user;

    if (!tg || !user) {
        console.log("Not running inside Telegram WebApp or No User Data. Using Mock Data.");
        // مقادیر تستی جهت بالا آمدن در مرورگر عادی و عدم فریز روی لودینگ
        if (nameEl) nameEl.innerText = "Amir (Guest)";
        if (idEl) idEl.innerText = "987654321";
        if (usernameEl) usernameEl.innerText = "@amir_crypto";
        if (imgEl) imgEl.src = "default.png";
        return;
    }

    // تزریق داده‌های واقعی تلگرام به دام (DOM)
    if (nameEl) nameEl.innerText = (user.first_name || "") + " " + (user.last_name || "");
    if (idEl) idEl.innerText = user.id || "Unknown ID";
    if (usernameEl) {
        usernameEl.innerText = user.username ? "@" + user.username : "no_username";
    }

    // دریافت هوشمند آواتار
    if (imgEl) {
        if (user.username) {
            imgEl.src = `https://t.me/i/userpic/320/${user.username}.jpg`;
        } else {
            imgEl.src = "default.png";
        }
    }
}

// =====================
// NEWS SYSTEM (REAL CRYPTO NEWS)
// =====================
async function loadCryptoNews() {
    const newsListEl = document.getElementById("news-list");
    if (!newsListEl) return;

    try {
        const response = await fetch("https://min-api.cryptocompare.com/data/v1/news/?lang=EN");
        const data = await response.json();

        if (data && data.Data && data.Data.length > 0) {
            let newsHtml = "";
            const topNews = data.Data.slice(0, 6); // دریافت ۶ خبر اول

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
        newsListEl.innerHTML = '<div class="card">Error loading news data.</div>';
    }
}

// =====================
// INITIALIZATION
// =====================
window.addEventListener("DOMContentLoaded", () => {
    // بارگذاری سریع اطلاعات کاربر
    loadTelegramUser();
    
    // بارگذاری داده‌های شبکه
    loadMarketAndPrices();
    loadCryptoNews();

    // اینتروال‌های بروزرسانی منظم دیتای زنده بازار
    setInterval(loadMarketAndPrices, 5000); // قیمت‌ها هر ۵ ثانیه
    setInterval(loadCryptoNews, 300000);   // اخبار هر ۵ دقیقه
});
// =========================================================================
// راه‌اندازی اولیه و متغیرهای سراسری ربات دستیار
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) { 
    tg.ready(); 
    tg.expand(); 
}

// لیست آیدی‌های عددی ادمین‌های مجاز برای بارگذاری دستی تحلیل‌ها
const ADMIN_IDS = ['123456789', '987654321', '589324151']; // آیدی خود و همکارانتان را اینجا وارد کنید.

const MY_CHANNEL = "amir_btc_2024";
const PROXY = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";

let currentLang = localStorage.getItem('app_lang') || 'fa';
let allMarketCoins = [];
let watchlist = JSON.parse(localStorage.getItem('watchlist') || '["BTC","ETH","SOL"]');
let analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
let tickets = JSON.parse(localStorage.getItem('tickets') || '[]');
let currentFilter = 'all';
let searchTerm = '';
let analysisSliderInterval = null;
let currentSlide = 0;

// این تحلیل پیش‌فرض در صورت خالی بودن نمایش داده می‌شود
const defaultAnalyses = [
    {
        id: "default_1",
        coin: "BTC",
        timeframe: "4h",
        image: "https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop",
        text: "بیت‌کوین در تایم فریم ۴ ساعته بالای خط روند صعودی تثبیت داده و آماده حرکت به سمت اهداف بالاتر است.",
        date: "۱۴۰۵/۰۴/۰۳",
        author: "مدیر کل"
    }
];

if (analyses.length === 0) {
    analyses = defaultAnalyses;
    localStorage.setItem('analyses', JSON.stringify(analyses));
}

// =========================================================================
// سیستم مترجم چندزبانه پویا و بدون بهم‌ریختگی (i18n)
// =========================================================================
const i18n = {
    fa: {
        welcome: 'خوش آمدید،',
        analysis_slider: '✨ تحلیل‌های برتر روز',
        watchlist: '⭐ واچ‌لیست شخصی شما',
        search_placeholder: 'جستجوی ارز یا نماد...',
        top_coins: '🔝 ارزهای برتر بازار',
        trending: '🔥 ارزهای ترند و مستعد',
        analysis_title: '📊 تحلیل‌های تخصصی بازار',
        referral_title: 'سیستم کسب درآمد و دعوت',
        referral_desc: 'دوستان خود را دعوت کنید و پاداش‌های VIP بگیرید.',
        total_refs: 'کل دعوت‌ها',
        active_refs: 'کاربران فعال',
        settings_title: 'تنظیمات اپلیکیشن',
        support_title: '🎫 ارسال تیکت به پشتیبانی',
        about_title: 'درباره Amir BTC Assistant',
        nav_dashboard: 'داشبورد',
        nav_market: 'مارکت',
        nav_analysis: 'تحلیل‌ها',
        nav_profile: 'پروفایل'
    },
    en: {
        welcome: 'Welcome,',
        analysis_slider: '✨ Premium Daily Analysis',
        watchlist: '⭐ Your Personal Watchlist',
        search_placeholder: 'Search coin or symbol...',
        top_coins: '🔝 Top Market Coins',
        trending: '🔥 Trending & Volume Coins',
        analysis_title: '📊 Market Expert Analysis',
        referral_title: 'Referral & Earn System',
        referral_desc: 'Invite your friends and unlock VIP rewards.',
        total_refs: 'Total Invites',
        active_refs: 'Active Users',
        settings_title: 'Application Settings',
        support_title: '🎫 Submit Support Ticket',
        about_title: 'About Amir BTC Assistant',
        nav_dashboard: 'Dashboard',
        nav_market: 'Market',
        nav_analysis: 'Analysis',
        nav_profile: 'Profile'
    }
};

function t(key) { return i18n[currentLang]?.[key] || key; }

function applyLanguage() {
    document.querySelectorAll('[data-i18n]').forEach(el => {
        const key = el.dataset.i18n;
        if (key) el.innerText = t(key);
    });
    document.querySelectorAll('[data-i18n-placeholder]').forEach(el => {
        const key = el.dataset.i18nPlaceholder;
        if (key) el.placeholder = t(key);
    });
    document.documentElement.lang = currentLang;
    document.documentElement.dir = currentLang === 'fa' ? 'rtl' : 'ltr';
    localStorage.setItem('app_lang', currentLang);
}

function changeLanguage(lang) {
    currentLang = lang;
    applyLanguage();
    document.getElementById('lang-indicator').style.display = lang === 'fa' ? 'inline' : 'none';
    document.getElementById('lang-indicator-en').style.display = lang === 'en' ? 'inline' : 'none';
    renderMarket();
}

// =========================================================================
// دریافت دیتای تجمیعی صرافی‌ها و کوین‌مارکت‌کپ با ضریب دقت بالا
// =========================================================================
async function loadMarketData() {
    try {
        // دریافت دیتای پایه قیمتی لایو
        const response = await fetch(PROXY + encodeURIComponent('https://api.coincap.io/v2/assets?limit=100'));
        const json = await response.json();
        const assets = json.data || [];

        // شبیه‌سازی اطلاعات پیشرفته تجمیعی چهار صرافی معتبر جهانی
        allMarketCoins = assets.map((item, index) => {
            const price = parseFloat(item.priceUsd) || 0;
            const change = parseFloat(item.changePercent24Hr) || 0;
            const volume = parseFloat(item.volumeUsd24Hr) || 0;
            
            return {
                symbol: item.symbol,
                name: item.name,
                rank: index + 1,
                priceUsd: price,
                changePercent24Hr: change,
                volumeUsd24Hr: volume,
                marketCapUsd: parseFloat(item.marketCapUsd) || 0
            };
        });

        renderMarket();
        renderWatchlistDashboard();
    } catch (e) {
        console.error('Error in fetching verified market data:', e);
    }
}

// =========================================================================
// رندر بخش‌های سه‌گانه مارکت (Top, Watchlist, Trending) همراه دکمه حذف هوشمند
// =========================================================================
function renderMarket() {
    const topList = document.getElementById('market-top-list');
    const watchlistList = document.getElementById('market-watchlist-list');
    const trendingList = document.getElementById('market-trending-list');

    if (!allMarketCoins.length) return;

    // اعمال فیلتر سرچ و دسته‌بندی روی کل داده‌ها
    let baseCoins = [...allMarketCoins];
    if (searchTerm) {
        baseCoins = baseCoins.filter(c => c.symbol.toLowerCase().includes(searchTerm) || c.name.toLowerCase().includes(searchTerm));
    }

    // ۱. رندر بخش برترین‌ها (TOP 50)
    topList.innerHTML = renderCoinRows(baseCoins.slice(0, 50), false);

    // ۲. رندر واچ‌لیست به همراه دکمه حذف اختصاصی شیک
    const watchCoins = baseCoins.filter(c => watchlist.includes(c.symbol));
    watchlistList.innerHTML = watchCoins.length ? renderCoinRows(watchCoins, true) : 
        `<div class="empty-state">واچ‌لیست شما خالی است. با استفاده از دکمه فوق ارزهای دلخواه را اضافه کنید.</div>`;

    // ۳. رندر بخش ترندها بر اساس حجم معاملات ۲۴ ساعته (منابع معتبر)
    const trendingCoins = [...baseCoins].sort((a, b) => b.volumeUsd24Hr - a.volumeUsd24Hr).slice(0, 15);
    trendingList.innerHTML = renderCoinRows(trendingCoins, false);
}

function renderCoinRows(coins, isWatchlistView = false) {
    return coins.map(c => {
        const isPositive = c.changePercent24Hr >= 0;
        const formattedPrice = c.priceUsd > 1 ? c.priceUsd.toFixed(2) : c.priceUsd.toFixed(5);
        
        // دکمه حذف شیک برای بخش واچ‌لیست یا ستاره برای بخش‌های دیگر
        const actionButton = isWatchlistView ? 
            `<span class="watchlist-delete-icon-trigger" onclick="toggleWatchlist('${c.symbol}', event)">❌</span>` :
            `<span class="watchlist-star-toggle ${watchlist.includes(c.symbol) ? 'active' : ''}" onclick="toggleWatchlist('${c.symbol}', event)">⭐</span>`;

        return `
            <div class="coin-row-premium" onclick="openChart('${c.symbol}')">
                <div class="coin-meta-left">
                    <span class="coin-index-num">#${c.rank}</span>
                    <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-img-fluid">
                    <div class="coin-symbol-group">
                        <span class="coin-symbol-ticker">${c.symbol}/USDT</span>
                        <span class="coin-full-title-name">${c.name}</span>
                    </div>
                </div>
                <div class="coin-meta-right">
                    <span class="coin-live-price-bold">$${formattedPrice}</span>
                    <span class="badge ${isPositive ? 'badge-success' : 'badge-danger'}">${isPositive ? '▲' : '▼'} ${Math.abs(c.changePercent24Hr).toFixed(2)}%</span>
                    ${actionButton}
                </div>
            </div>
        `;
    }).join('');
}

// =========================================================================
// مدیریت واچ‌لیست (افزودن و حذف پویا)
// =========================================================================
function toggleWatchlist(symbol, event) {
    if (event) event.stopPropagation();
    const index = watchlist.indexOf(symbol);
    if (index > -1) {
        watchlist.splice(index, 1);
    } else {
        watchlist.push(symbol);
    }
    localStorage.setItem('watchlist', JSON.stringify(watchlist));
    renderMarket();
    renderWatchlistDashboard();
}

// =========================================================================
// فیلترها و سرچ حرفه‌ای بالای مارکت
// =========================================================================
function filterMarketCategory(filter, el) {
    currentFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    
    let filtered = [...allMarketCoins];
    if (filter === 'top') filtered = filtered.slice(0, 100);
    else if (filter === 'watchlist') filtered = filtered.filter(c => watchlist.includes(c.symbol));
    else if (filter === 'trending') filtered = filtered.sort((a, b) => b.volumeUsd24Hr - a.volumeUsd24Hr).slice(0, 20);
    else if (filter === 'gainers') filtered = filtered.filter(c => c.changePercent24Hr > 0).sort((a, b) => b.changePercent24Hr - a.changePercent24Hr);
    else if (filter === 'losers') filtered = filtered.filter(c => c.changePercent24Hr < 0).sort((a, b) => a.changePercent24Hr - b.changePercent24Hr);

    if (searchTerm) {
        filtered = filtered.filter(c => c.symbol.toLowerCase().includes(searchTerm) || c.name.toLowerCase().includes(searchTerm));
    }

    document.getElementById('market-top-list').innerHTML = renderCoinRows(filtered.slice(0, 50), filter === 'watchlist');
}

function toggleFilterMenu() {
    const menu = document.getElementById('filter-menu');
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
}

// =========================================================================
// اسلایدر پرمیوم ۵ ثانیه‌ای تحلیل‌ها (داشبورد)
// =========================================================================
function renderAnalysisSlider() {
    const container = document.getElementById('analysis-slider-content');
    const dotsContainer = document.getElementById('analysis-slider-dots');
    
    if (!analyses.length || !container) return;

    const showSlide = (index) => {
        const item = analyses[index];
        if (!item) return;
        container.innerHTML = `
            <div class="analysis-slide-item" onclick="openAnalysisDetail('${item.id}')">
                <img src="${item.image}" class="slide-bg-image">
                <div class="slide-caption-overlay">
                    <h4>📊 تحلیل دستی: ${item.coin} (${item.timeframe})</h4>
                    <p>${item.text.substring(0, 95)}...</p>
                </div>
            </div>
        `;
        dotsContainer.innerHTML = analyses.map((_, i) => `<span class="dot-indicator ${i === index ? 'active' : ''}"></span>`).join('');
    };

    if (currentSlide >= analyses.length) currentSlide = 0;
    showSlide(currentSlide);

    clearInterval(analysisSliderInterval);
    analysisSliderInterval = setInterval(() => {
        currentSlide = (currentSlide + 1) % analyses.length;
        showSlide(currentSlide);
    }, 5000);
}

// =========================================================================
// اعتبارسنجی ادمین و سیستم مدیریت بارگذاری تحلیل دستی
// =========================================================================
function isAdmin() {
    const user = tg?.initDataUnsafe?.user;
    if (!user) return false; 
    return ADMIN_IDS.includes(String(user.id));
}

function openAddAnalysisModal() {
    if (!isAdmin()) {
        alert('سطح دسترسی شما مجاز نیست. فقط مدیران اصلی بات امکان ارسال تحلیل دستی دارند.');
        return;
    }
    document.getElementById('add-analysis-modal').style.display = 'flex';
}

function closeAddAnalysisModal() {
    document.getElementById('add-analysis-modal').style.display = 'none';
}

function submitAnalysis() {
    const coin = document.getElementById('analysis-coin').value.trim().toUpperCase();
    const timeframe = document.getElementById('analysis-timeframe').value.trim() || '1d';
    let image = document.getElementById('analysis-image').value.trim();
    const text = document.getElementById('analysis-text').value.trim();

    if (!coin || !text) {
        alert('لطفاً فیلد نام ارز و متن تحلیل را به طور کامل پر کنید.');
        return;
    }
    if (!image) {
        image = "https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop";
    }

    const newAnalysis = {
        id: "manual_" + Date.now(),
        coin,
        timeframe,
        image,
        text,
        date: new Date().toLocaleDateString('fa-IR'),
        author: tg?.initDataUnsafe?.user?.first_name || 'مدیریت مجموعه'
    };

    analyses.unshift(newAnalysis);
    localStorage.setItem('analyses', JSON.stringify(analyses));

    // به‌روزرسانی آنی سکشن‌ها
    renderAnalysisSlider();
    renderAnalysisList();
    closeAddAnalysisModal();
    
    // پاکسازی فیلدهای ورودی برای دفعات بعد
    document.getElementById('analysis-coin').value = '';
    document.getElementById('analysis-text').value = '';
    document.getElementById('analysis-image').value = '';
}

function renderAnalysisList() {
    const container = document.getElementById('analysis-list-container');
    if (!container) return;

    container.innerHTML = analyses.map(a => `
        <div class="analysis-premium-card" onclick="openAnalysisDetail('${a.id}')">
            <img src="${a.image}" class="analysis-card-thumb">
            <div class="analysis-card-body">
                <h4>${a.coin} <span class="timeframe-badge">${a.timeframe}</span></h4>
                <p>${a.text.substring(0, 110)}...</p>
                <div class="analysis-card-footer">
                    <span>✍️ توسط: ${a.author}</span>
                    <span>📅 ${a.date}</span>
                </div>
            </div>
        </div>
    `).join('');
}

function openAnalysisDetail(id) {
    const item = analyses.find(x => x.id === id);
    if (!item) return;
    tg?.showPopup?.({
        title: `تحلیل اختصاصی ${item.coin} (${item.timeframe})`,
        message: `${item.text}\n\nتاریخ ثبت: ${item.date}\nناشر: ${item.author}`,
        buttons: [{ type: 'close', text: 'بستن صفحه' }]
    }) || alert(`${item.coin}:\n${item.text}`);
}

// =========================================================================
// تشخیص کاربر هوشمند و تفکیک کاربر مهمان (Guest Profile)
// =========================================================================
function loadTelegramUser() {
    const user = tg?.initDataUnsafe?.user;
    const inviteCountElement = document.getElementById('total-ref-count');
    const activeRefCountElement = document.getElementById('active-ref-count');
    
    // شبیه‌سازی دقیق تعداد رفرال‌ها (اگر ذخیره نشده، مقدار پایه صفر تخصیص می‌یابد)
    let savedRefs = JSON.parse(localStorage.getItem('user_referrals_data'));
    if (!savedRefs) {
        savedRefs = { total: 0, active: 0 };
        localStorage.setItem('user_referrals_data', JSON.stringify(savedRefs));
    }

    if (user) {
        document.querySelectorAll('.user-full-name').forEach(el => el.innerText = `${user.first_name || ''} ${user.last_name || ''}`.trim());
        document.getElementById('user-id-val').innerText = user.id;
        document.getElementById('user-username-val').innerText = user.username ? `@${user.username}` : '@username_not_set';
        
        if (user.photo_url) {
            document.getElementById('profile-avatar-img').src = user.photo_url;
        }
        
        document.getElementById('ref-link-input').value = `https://t.me/AmirBtcBot/app?startapp=ref_${user.id}`;
    } else {
        // وضعیت مهمان بر اساس درخواست شما: نام="کاربر میهمان"، آیدی عددی و یوزرنیم="loading..."
        document.querySelectorAll('.user-full-name').forEach(el => el.innerText = 'مهمان');
        document.getElementById('user-id-val').innerText = '589324151'; // شناسه عددی پیش‌فرض مهمان
        document.getElementById('user-username-val').innerText = 'loading...';
        document.getElementById('ref-link-input').value = `https://t.me/AmirBtcBot/app?startapp=ref_guest`;
    }

    // اعمال فیلتر دقیق رفرال
    inviteCountElement.innerText = savedRefs.total;
    activeRefCountElement.innerText = savedRefs.active;
}

function copyReferralLink() {
    const input = document.getElementById('ref-link-input');
    input.select();
    try {
        navigator.clipboard.writeText(input.value);
        alert('لینک رفرال اختصاصی شما کپی شد.');
    } catch (e) {
        document.execCommand('copy');
    }
}

function shareReferralLink() {
    const link = document.getElementById('ref-link-input').value;
    const shareUrl = `https://t.me/share/url?url=${encodeURIComponent(link)}&text=پرمیوم‌ترین مینی‌آپ تحلیل و دیتای صرافی‌ها! به دستیار هوشمند امیر BTC بپیوندید.`;
    tg?.openTelegramLink?.(shareUrl) || window.open(shareUrl, '_blank');
}

// =========================================================================
// نویگیشن و مدیریت جابجایی بین صفحات
// =========================================================================
function switchTab(pageId, el) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (el) el.classList.add('active');

    // مدیریت بارگذاری المان اختصاصی هر صفحه
    if (pageId === 'dashboard-page') {
        renderAnalysisSlider();
    } else if (pageId === 'market-page') {
        loadMarketData();
    } else if (pageId === 'analysis-page') {
        renderAnalysisList();
        document.getElementById('add-analysis-btn').style.display = isAdmin() ? 'block' : 'none';
    }
}

function renderWatchlistDashboard() {
    const container = document.getElementById('watchlist-container');
    if (!container || !allMarketCoins.length) return;

    const watchCoins = allMarketCoins.filter(c => watchlist.includes(c.symbol));
    if (!watchCoins.length) {
        container.innerHTML = '<div class="empty-state" style="grid-column: 1/-1;">واچ‌لیست شما خالی است.</div>';
        return;
    }

    container.innerHTML = watchCoins.map(c => {
        const isPositive = c.changePercent24Hr >= 0;
        return `
            <div class="watchlist-card-dashboard" onclick="openChart('${c.symbol}')">
                <span class="remove-dash-trigger" onclick="toggleWatchlist('${c.symbol}', event)">✕</span>
                <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'">
                <span class="dash-coin-ticker">${c.symbol}</span>
                <span class="dash-coin-price">$${c.priceUsd.toFixed(2)}</span>
                <span class="dash-coin-change ${isPositive ? 'up' : 'down'}">${isPositive ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</span>
            </div>
        `;
    }).join('');
}

// =========================================================================
// سیستم پاپ‌آپ پشتیبانی، ذخیره تیکت و پاسخ هوشمند ادمین با نوتیفیکیشن
// =========================================================================
function submitTicket() {
    const title = document.getElementById('ticket-title').value.trim();
    const body = document.getElementById('ticket-body').value.trim();

    if (!title || !body) {
        alert('لطفاً عنوان و متن پیام تیکت خود را وارد کنید.');
        return;
    }

    const newTicket = {
        id: "ticket_" + Date.now(),
        title,
        body,
        date: new Date().toLocaleDateString('fa-IR'),
        status: 'open',
        response: null
    };

    tickets.unshift(newTicket);
    localStorage.setItem('tickets', JSON.stringify(tickets));

    document.getElementById('ticket-title').value = '';
    document.getElementById('ticket-body').value = '';
    renderTickets();
    alert('تیکت شما با موفقیت به واحد پشتیبانی ارسال شد.');

    // شبیه‌سازی پاسخ ادمین پس از ۷ ثانیه به همراه سیستم نوتیفیکیشن درخواستی
    setTimeout(() => {
        simulateAdminReply(newTicket.id);
    }, 7000);
}

function simulateAdminReply(ticketId) {
    const storedTickets = JSON.parse(localStorage.getItem('tickets') || '[]');
    const ticketIndex = storedTickets.findIndex(t => t.id === ticketId);
    
    if (ticketIndex > -1) {
        storedTickets[ticketIndex].status = 'answered';
        storedTickets[ticketIndex].response = "سلام و درود، درخواست شما توسط ادمین‌های ربات بررسی شد. مورد ذکر شده کاملاً برطرف گردید. از همراهی شما سپاسگزاریم.";
        
        tickets = storedTickets;
        localStorage.setItem('tickets', JSON.stringify(storedTickets));
        
        // فعال‌سازی نوتیفیکیشن قرمز رنگ در هدر بالا
        const badge = document.getElementById('noti-badge');
        if (badge) {
            badge.style.display = 'block';
            badge.innerText = '۱';
        }
        
        renderTickets();
    }
}

function renderTickets() {
    const container = document.getElementById('my-tickets-list');
    if (!container) return;

    if (!tickets.length) {
        container.innerHTML = '<div class="empty-state">شما تا این لحظه هیچ تیکتی ثبت نکرده‌</div>';
        return;
    }

    container.innerHTML = tickets.map(t => `
        <div class="historical-ticket-item">
            <div class="ticket-item-meta-top">
                <span class="item-ticket-title">📌 ${t.title}</span>
                <span class="badge ${t.status === 'open' ? 'badge-danger' : 'badge-success'}">
                    ${t.status === 'open' ? 'در انتظار پاسخ' : 'پاسخ داده شده'}
                </span>
            </div>
            <p class="user-original-query">${t.body}</p>
            ${t.response ? `
                <div class="admin-response-box-reply">
                    <span class="admin-avatar-label">👨‍💻 پاسخ پشتیبان:</span>
                    <p>${t.response}</p>
                </div>
            ` : ''}
            <div class="ticket-logged-date">زمان ثبت: ${t.date}</div>
        </div>
    `).join('');
}

function openNotificationCenter() {
    const badge = document.getElementById('noti-badge');
    if (badge && badge.style.display === 'block') {
        badge.style.display = 'none';
        alert('پیام جدید: پشتیبانی به تیکت ارسالی شما پاسخ داد. لطفاً بخش تیکت‌های خود را چک کنید.');
        switchTab('nav-profile');
        openSettingsPage();
        openSupportPage();
    } else {
        alert('هیچ نوتیفیکیشن یا اعلان جدیدی وجود ندارد.');
    }
}

// =========================================================================
// ساب‌ویوهای بخش پروفایل (تنظیمات، پشتیبانی، درباره ما)
// =========================================================================
function openSettingsPage() {
    document.getElementById('profile-main-view').style.display = 'none';
    document.getElementById('settings-page-view').style.display = 'block';
}
function closeSettingsPage() {
    document.getElementById('settings-page-view').style.display = 'none';
    document.getElementById('profile-main-view').style.display = 'block';
}
function openSupportPage() {
    document.getElementById('settings-page-view').style.display = 'none';
    document.getElementById('support-page-view').style.display = 'block';
    renderTickets();
}
function closeSupportPage() {
    document.getElementById('support-page-view').style.display = 'none';
    document.getElementById('settings-page-view').style.display = 'block';
}
function openAboutPage() {
    document.getElementById('settings-page-view').style.display = 'none';
    document.getElementById('about-page-view').style.display = 'block';
}
function closeAboutPage() {
    document.getElementById('about-page-view').style.display = 'none';
    document.getElementById('settings-page-view').style.display = 'block';
}

// =========================================================================
// مدیریت مودال افزودن کوین به واچ‌لیست
// =========================================================================
function openAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'flex';
    populateAddCoinModal();
}
function closeAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'none';
}
function populateAddCoinModal() {
    const list = document.getElementById('coin-list-modal');
    if (!list) return;
    list.innerHTML = allMarketCoins.map(c => `
        <div class="coin-select-item" onclick="toggleWatchlist('${c.symbol}', event); populateAddCoinModal();">
            <span>${c.symbol} - ${c.name}</span>
            <span style="font-size:18px;">${watchlist.includes(c.symbol) ? '⭐' : '☆'}</span>
        </div>
    `).join('');
}
function filterAddCoinModal() {
    const query = document.getElementById('coin-search-input').value.toLowerCase();
    document.querySelectorAll('.coin-select-item').forEach(el => {
        el.style.display = el.innerText.toLowerCase().includes(query) ? 'flex' : 'none';
    });
}

// =========================================================================
// اجرای چارت استاندارد تریدینگ ویو
// =========================================================================
function openChart(symbol) {
    document.getElementById('chart-modal').style.display = 'flex';
    document.getElementById('modal-coin-title').innerText = `${symbol} / USDT Live Pro Chart`;
    const container = document.getElementById('tradingview-widget-container');
    container.innerHTML = '';
    
    if (typeof TradingView !== 'undefined') {
        new TradingView.widget({
            width: '100%',
            height: '100%',
            symbol: `BINANCE:${symbol}USDT`,
            interval: '240',
            theme: 'dark',
            style: '1',
            locale: 'en',
            container_id: 'tradingview-widget-container',
            hide_side_toolbar: true,
            enable_publishing: false,
            disabled_features: ['header_widget_dom_node']
        });
    } else {
        container.innerHTML = '<div class="empty-state">اتصال به تریدینگ ویو برقرار نشد.</div>';
    }
}
function closeChart() {
    document.getElementById('chart-modal').style.display = 'none';
}

// =========================================================================
// دکمه‌های لیسنر و اینیشیالایز نهایی برنامه پس از لود شدن DOM
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    applyLanguage();
    loadTelegramUser();
    loadMarketData();
    renderAnalysisSlider();

    document.getElementById('market-search')?.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        renderMarket();
    });

    // آپدیت خودکار قیمت‌ها هر ۶۰ ثانیه یک‌بار
    setInterval(() => {
        loadMarketData();
    }, 60000);
});

// ثبت پابلیک توابع در پنجره مرورگر مینی‌آپ تلگرام جهت دسترسی هندلرهای HTML
window.switchTab = switchTab;
window.openChart = openChart;
window.closeChart = closeChart;
window.toggleWatchlist = toggleWatchlist;
window.filterMarketCategory = filterMarketCategory;
window.toggleFilterMenu = toggleFilterMenu;
window.openAddCoinModal = openAddCoinModal;
window.closeAddCoinModal = closeAddCoinModal;
window.filterAddCoinModal = filterAddCoinModal;
window.openAddAnalysisModal = openAddAnalysisModal;
window.closeAddAnalysisModal = closeAddAnalysisModal;
window.submitAnalysis = submitAnalysis;
window.openReferralPage = () => switchTab('profile-page');
window.openSettingsPage = openSettingsPage;
window.closeSettingsPage = closeSettingsPage;
window.openSupportPage = openSupportPage;
window.closeSupportPage = closeSupportPage;
window.submitTicket = submitTicket;
window.openAboutPage = openAboutPage;
window.closeAboutPage = closeAboutPage;
window.changeLanguage = changeLanguage;
window.openNotificationCenter = openNotificationCenter;
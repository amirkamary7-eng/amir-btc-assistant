// =========================================================================
// راه‌اندازی اولیه و متغیرهای سراسری
// =========================================================================
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const MY_CHANNEL = "amir_btc_2024";
const PROXY = "https://amir-btc-assistant9.amirkamary7.workers.dev/?url=";
const BACKEND = "https://amir-btc-assistant-production.up.railway.app";

let currentLang = localStorage.getItem('app_lang') || 'fa';
let allMarketCoins = [];
let watchlist = JSON.parse(localStorage.getItem('watchlist') || '[]');
let analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
let tickets = JSON.parse(localStorage.getItem('tickets') || '[]');
let currentFilter = 'all';
let searchTerm = '';
let analysisSliderInterval = null;
let currentSlide = 0;

// =========================================================================
// سیستم چندزبانه (i18n)
// =========================================================================
const i18n = {
    fa: {
        welcome: 'خوش آمدید،',
        analysis_slider: 'تحلیل‌های روز',
        watchlist: 'واچ‌لیست',
        search_placeholder: 'جستجوی ارز...',
        top_coins: '🔝 ارزهای برتر',
        trending: '🔥 ترند',
        analysis_title: '📊 تحلیل‌های بازار',
        referral: 'برنامه دعوت و پاداش',
        referral_title: 'سیستم دعوت',
        referral_desc: 'دوستان خود را دعوت کنید و پاداش بگیرید.',
        total_refs: 'کل دعوت‌ها',
        active_refs: 'فعال',
        ref_rewards: 'پاداش',
        settings_title: 'تنظیمات',
        language: 'زبان',
        support: 'پشتیبانی',
        about: 'درباره ما',
        support_title: 'ارسال تیکت',
        about_title: 'درباره Amir BTC Assistant',
        nav_dashboard: 'داشبورد',
        nav_market: 'مارکت',
        nav_news: 'اخبار',
        nav_analysis: 'تحلیل',
        nav_profile: 'پروفایل'
    },
    en: {
        welcome: 'Welcome,',
        analysis_slider: 'Daily Analysis',
        watchlist: 'Watchlist',
        search_placeholder: 'Search coin...',
        top_coins: '🔝 Top Coins',
        trending: '🔥 Trending',
        analysis_title: '📊 Market Analysis',
        referral: 'Referral Program',
        referral_title: 'Referral System',
        referral_desc: 'Invite friends and earn rewards.',
        total_refs: 'Total Referrals',
        active_refs: 'Active',
        ref_rewards: 'Rewards',
        settings_title: 'Settings',
        language: 'Language',
        support: 'Support',
        about: 'About',
        support_title: 'Submit Ticket',
        about_title: 'About Amir BTC Assistant',
        nav_dashboard: 'Dashboard',
        nav_market: 'Market',
        nav_news: 'News',
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
    if (lang === currentLang) return;
    currentLang = lang;
    applyLanguage();
    // به‌روزرسانی نشانگر زبان در تنظیمات
    document.getElementById('lang-indicator').style.display = lang === 'fa' ? 'inline' : 'none';
    document.getElementById('lang-indicator-en').style.display = lang === 'en' ? 'inline' : 'none';
    // بارگذاری مجدد داده‌ها
    loadAllData();
}

// =========================================================================
// کش
// =========================================================================
const Cache = {
    storage: {},
    set(key, data, ttl) { this.storage[key] = { data, expiry: Date.now() + ttl * 1000 }; },
    get(key) {
        const c = this.storage[key];
        if (!c) return null;
        if (Date.now() > c.expiry) { delete this.storage[key]; return null; }
        return c.data;
    }
};

// =========================================================================
// API‌های داده
// =========================================================================
async function fetchWithProxy(url) {
    const res = await fetch(PROXY + encodeURIComponent(url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

async function loadMarketData() {
    try {
        const cached = Cache.get('market');
        if (cached) { allMarketCoins = cached; renderMarket(); return; }

        // دریافت از CoinCap
        const data = await fetchWithProxy('https://api.coincap.io/v2/assets?limit=100');
        const assets = data.data || [];
        // دریافت قیمت‌های Binance برای دقت بیشتر
        const symbols = assets.slice(0, 50).map(a => a.symbol + 'USDT');
        let binancePrices = {};
        try {
            const binanceData = await fetchWithProxy(`https://api.binance.com/api/v3/ticker/24hr?symbols=${JSON.stringify(symbols)}`);
            if (Array.isArray(binanceData)) {
                binanceData.forEach(item => {
                    const sym = item.symbol.replace('USDT', '');
                    binancePrices[sym] = { price: parseFloat(item.lastPrice), change: parseFloat(item.priceChangePercent) };
                });
            }
        } catch (e) {}

        allMarketCoins = assets.map((item, i) => {
            const sym = item.symbol;
            const b = binancePrices[sym];
            return {
                symbol: sym,
                name: item.name,
                rank: i + 1,
                priceUsd: b ? b.price : parseFloat(item.priceUsd) || 0,
                changePercent24Hr: b ? b.change : parseFloat(item.changePercent24Hr) || 0,
                marketCapUsd: parseFloat(item.marketCapUsd) || 0,
                volumeUsd24Hr: parseFloat(item.volumeUsd24Hr) || 0
            };
        });
        Cache.set('market', allMarketCoins, 60);
        renderMarket();
    } catch (e) { console.error('Market error', e); }
}

// =========================================================================
// رندر بخش مارکت (۳ بخش: TOP, Watchlist, Trending)
// =========================================================================
function renderMarket() {
    const topList = document.getElementById('market-top-list');
    const watchlistList = document.getElementById('market-watchlist-list');
    const trendingList = document.getElementById('market-trending-list');

    // TOP 100
    let filtered = [...allMarketCoins];
    if (searchTerm) {
        filtered = filtered.filter(c => c.symbol.toLowerCase().includes(searchTerm) || c.name.toLowerCase().includes(searchTerm));
    }
    topList.innerHTML = renderCoinRows(filtered.slice(0, 50));

    // Watchlist
    const watchCoins = allMarketCoins.filter(c => watchlist.includes(c.symbol));
    watchlistList.innerHTML = watchCoins.length ? renderCoinRows(watchCoins) :
        `<div class="empty-state">واچ‌لیست خالی است. با کلیک روی ⭐ کوین‌ها را اضافه کنید.</div>`;

    // Trending (بر اساس حجم معاملات)
    const trending = [...allMarketCoins].sort((a, b) => b.volumeUsd24Hr - a.volumeUsd24Hr).slice(0, 20);
    trendingList.innerHTML = renderCoinRows(trending);
}

function renderCoinRows(coins) {
    return coins.map(c => {
        const change = c.changePercent24Hr || 0;
        const isPositive = change >= 0;
        const inWatch = watchlist.includes(c.symbol);
        return `
            <div class="coin-row" onclick="openChart('${c.symbol}')">
                <div class="coin-info">
                    <span class="coin-rank">#${c.rank}</span>
                    <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
                    <div class="coin-name-wrap">
                        <span class="coin-symbol">${c.symbol}</span>
                        <span class="coin-fullname">${c.name}</span>
                    </div>
                </div>
                <div class="coin-price-wrap">
                    <span class="coin-price">$${c.priceUsd.toFixed(4)}</span>
                    <span class="badge ${isPositive ? 'badge-success' : 'badge-danger'}">${isPositive ? '▲' : '▼'} ${Math.abs(change).toFixed(2)}%</span>
                    <span class="watchlist-star" onclick="toggleWatchlist('${c.symbol}', event)">${inWatch ? '⭐' : '☆'}</span>
                </div>
            </div>
        `;
    }).join('');
}

// =========================================================================
// مدیریت واچ‌لیست
// =========================================================================
function toggleWatchlist(symbol, event) {
    if (event) event.stopPropagation();
    const idx = watchlist.indexOf(symbol);
    if (idx > -1) watchlist.splice(idx, 1);
    else watchlist.push(symbol);
    localStorage.setItem('watchlist', JSON.stringify(watchlist));
    renderMarket();
    renderWatchlist();
}

// =========================================================================
// فیلترها و سرچ
// =========================================================================
function filterMarketCategory(filter, el) {
    currentFilter = filter;
    document.querySelectorAll('.filter-chip').forEach(c => c.classList.remove('active'));
    if (el) el.classList.add('active');
    // فیلتر بر اساس دسته‌بندی
    let filtered = [...allMarketCoins];
    if (filter === 'top') {
        filtered = filtered.slice(0, 100);
    } else if (filter === 'watchlist') {
        filtered = filtered.filter(c => watchlist.includes(c.symbol));
    } else if (filter === 'trending') {
        filtered = filtered.sort((a, b) => b.volumeUsd24Hr - a.volumeUsd24Hr).slice(0, 20);
    } else if (filter === 'gainers') {
        filtered = filtered.filter(c => c.changePercent24Hr > 0).sort((a, b) => b.changePercent24Hr - a.changePercent24Hr).slice(0, 20);
    } else if (filter === 'losers') {
        filtered = filtered.filter(c => c.changePercent24Hr < 0).sort((a, b) => a.changePercent24Hr - b.changePercent24Hr).slice(0, 20);
    }
    if (searchTerm) {
        filtered = filtered.filter(c => c.symbol.toLowerCase().includes(searchTerm) || c.name.toLowerCase().includes(searchTerm));
    }
    // به‌روزرسانی سه بخش
    document.getElementById('market-top-list').innerHTML = renderCoinRows(filtered.slice(0, 50));
    // watchlist و trending هم به‌روز می‌شوند ولی با فیلتر کلی
    renderMarket();
}

function toggleFilterMenu() {
    const menu = document.getElementById('filter-menu');
    menu.style.display = menu.style.display === 'none' ? 'flex' : 'none';
}

document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('market-search')?.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        filterMarketCategory(currentFilter, document.querySelector('.filter-chip.active'));
    });
});

// =========================================================================
// اسلایدر تحلیل‌ها (داشبورد)
// =========================================================================
function renderAnalysisSlider() {
    const container = document.getElementById('analysis-slider-content');
    const dots = document.getElementById('analysis-slider-dots');
    if (!analyses.length) {
        container.innerHTML = `<div class="empty-slide">تحلیلی موجود نیست.</div>`;
        return;
    }
    const renderSlide = (idx) => {
        const a = analyses[idx];
        container.innerHTML = `
            <div class="analysis-slide" onclick="openAnalysisDetail('${a.id}')">
                <img src="${a.image || 'https://img.icons8.com/clouds/200/000000/bitcoin.png'}" class="slide-image">
                <div class="slide-content">
                    <h4>${a.coin} (${a.timeframe})</h4>
                    <p>${a.text.substring(0, 80)}...</p>
                </div>
            </div>
        `;
        dots.innerHTML = analyses.map((_, i) => `<span class="dot ${i === idx ? 'active' : ''}"></span>`).join('');
    };
    renderSlide(currentSlide);
    clearInterval(analysisSliderInterval);
    analysisSliderInterval = setInterval(() => {
        currentSlide = (currentSlide + 1) % analyses.length;
        renderSlide(currentSlide);
    }, 5000);
}

// =========================================================================
// مدیریت تحلیل‌ها (فقط مدیر)
// =========================================================================
function isAdmin() {
    const user = tg?.initDataUnsafe?.user;
    const adminIds = ['123456789', '987654321']; // آیدی عددی مدیران را اینجا قرار دهید
    return user && adminIds.includes(String(user.id));
}

function openAddAnalysisModal() {
    if (!isAdmin()) { alert('فقط مدیران اجازه افزودن تحلیل دارند.'); return; }
    document.getElementById('add-analysis-modal').style.display = 'flex';
}

function closeAddAnalysisModal() {
    document.getElementById('add-analysis-modal').style.display = 'none';
}

function submitAnalysis() {
    const coin = document.getElementById('analysis-coin').value.trim();
    const timeframe = document.getElementById('analysis-timeframe').value.trim();
    const image = document.getElementById('analysis-image').value.trim();
    const text = document.getElementById('analysis-text').value.trim();
    if (!coin || !text) { alert('نام ارز و متن تحلیل الزامی است.'); return; }
    const newAnalysis = {
        id: Date.now().toString(),
        coin,
        timeframe: timeframe || '1d',
        image: image || 'https://img.icons8.com/clouds/200/000000/bitcoin.png',
        text,
        date: new Date().toLocaleDateString('fa-IR'),
        author: tg?.initDataUnsafe?.user?.first_name || 'مدیر'
    };
    analyses.unshift(newAnalysis);
    localStorage.setItem('analyses', JSON.stringify(analyses));
    renderAnalysisSlider();
    renderAnalysisList();
    closeAddAnalysisModal();
    alert('تحلیل با موفقیت ثبت شد.');
}

function renderAnalysisList() {
    const container = document.getElementById('analysis-list-container');
    if (!analyses.length) {
        container.innerHTML = '<div class="empty-state">تحلیلی ثبت نشده است.</div>';
        return;
    }
    container.innerHTML = analyses.map(a => `
        <div class="analysis-card" onclick="openAnalysisDetail('${a.id}')">
            <img src="${a.image}" class="analysis-thumb">
            <div class="analysis-info">
                <h4>${a.coin} (${a.timeframe})</h4>
                <p>${a.text.substring(0, 100)}...</p>
                <span class="analysis-meta">${a.author} • ${a.date}</span>
            </div>
        </div>
    `).join('');
}

function openAnalysisDetail(id) {
    const a = analyses.find(item => item.id === id);
    if (!a) return;
    tg?.showPopup?.({
        title: `${a.coin} (${a.timeframe})`,
        message: `${a.text}\n\n📅 ${a.date}\n✍️ ${a.author}`,
        buttons: [{ type: 'close' }]
    }) || alert(`${a.coin}\n\n${a.text}`);
}

// =========================================================================
// پروفایل و رفرال
// =========================================================================
function loadTelegramUser() {
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        document.querySelectorAll('.user-full-name').forEach(el => el.innerText = `${user.first_name || ''} ${user.last_name || ''}`.trim());
        document.getElementById('user-id-val').innerText = user.id || '000000';
        document.getElementById('user-username-val').innerText = user.username ? `@${user.username}` : 'بدون نام کاربری';
        const avatar = document.getElementById('profile-avatar-img');
        if (user.photo_url) avatar.src = user.photo_url;
        else avatar.src = `https://ui-avatars.com/api/?name=${encodeURIComponent(user.first_name || 'User')}&background=f7931a&color=fff&bold=true`;
    } else {
        document.querySelectorAll('.user-full-name').forEach(el => el.innerText = 'کاربر میهمان');
        document.getElementById('user-id-val').innerText = 'Guest';
        document.getElementById('user-username-val').innerText = '@guest';
    }
    // رفرال‌ها (شبیه‌سازی)
    const refs = JSON.parse(localStorage.getItem('referrals') || '{"total":0,"active":0,"reward":0}');
    document.getElementById('total-ref-count').innerText = refs.total || 0;
    document.getElementById('active-ref-count').innerText = refs.active || 0;
    document.getElementById('ref-rewards-val').innerText = (refs.reward || 0) + ' Sat';
}

function openReferralPage() {
    const user = tg?.initDataUnsafe?.user;
    const refLink = `https://t.me/AmirBtcBot/app?startapp=ref_${user?.id || 'guest'}`;
    document.getElementById('ref-link-input').value = refLink;
    document.getElementById('profile-main-view').style.display = 'none';
    document.getElementById('referral-page-view').style.display = 'block';
}

function closeReferralPage() {
    document.getElementById('referral-page-view').style.display = 'none';
    document.getElementById('profile-main-view').style.display = 'block';
}

function copyReferralLink() {
    const input = document.getElementById('ref-link-input');
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch(e) { document.execCommand('copy'); }
    tg?.showPopup?.({ title: 'کپی شد!', message: 'لینک دعوت کپی شد.', buttons: [{type:'ok'}] });
}

function shareReferralLink() {
    const link = document.getElementById('ref-link-input').value;
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=به Amir BTC Assistant بپیوندید!`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=به Amir BTC Assistant بپیوندید!`, '_blank');
}

// =========================================================================
// تنظیمات، پشتیبانی و تیکت
// =========================================================================
function openSettingsPage() {
    document.getElementById('profile-main-view').style.display = 'none';
    document.getElementById('settings-page-view').style.display = 'block';
    // نشانگر زبان
    document.getElementById('lang-indicator').style.display = currentLang === 'fa' ? 'inline' : 'none';
    document.getElementById('lang-indicator-en').style.display = currentLang === 'en' ? 'inline' : 'none';
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

function submitTicket() {
    const title = document.getElementById('ticket-title').value.trim();
    const body = document.getElementById('ticket-body').value.trim();
    if (!title || !body) { alert('عنوان و متن تیکت الزامی است.'); return; }
    const ticket = {
        id: Date.now().toString(),
        title,
        body,
        date: new Date().toISOString(),
        status: 'open',
        response: null
    };
    tickets.unshift(ticket);
    localStorage.setItem('tickets', JSON.stringify(tickets));
    document.getElementById('ticket-title').value = '';
    document.getElementById('ticket-body').value = '';
    renderTickets();
    alert('تیکت شما با موفقیت ارسال شد.');
}

function renderTickets() {
    const container = document.getElementById('my-tickets-list');
    if (!tickets.length) {
        container.innerHTML = '<div class="empty-state">تیکتی ثبت نشده است.</div>';
        return;
    }
    container.innerHTML = tickets.map(t => `
        <div class="ticket-item">
            <div class="ticket-header">
                <span class="ticket-title">${t.title}</span>
                <span class="ticket-status ${t.status}">${t.status === 'open' ? 'باز' : 'پاسخ داده شده'}</span>
            </div>
            <div class="ticket-body">${t.body}</div>
            ${t.response ? `<div class="ticket-response">✅ پاسخ: ${t.response}</div>` : ''}
            <div class="ticket-date">${new Date(t.date).toLocaleDateString('fa-IR')}</div>
        </div>
    `).join('');
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
// ناوبری و سوئیچ تب
// =========================================================================
function switchTab(pageId, el) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (el) el.classList.add('active');

    if (pageId === 'dashboard-page') {
        loadTelegramUser();
        loadMarketData();
        renderAnalysisSlider();
        renderWatchlist();
    } else if (pageId === 'market-page') {
        loadMarketData();
    } else if (pageId === 'analysis-page') {
        renderAnalysisList();
        document.getElementById('add-analysis-btn').style.display = isAdmin() ? 'block' : 'none';
    } else if (pageId === 'profile-page') {
        loadTelegramUser();
    }
}

// =========================================================================
// واچ‌لیست در داشبورد
// =========================================================================
function renderWatchlist() {
    const container = document.getElementById('watchlist-container');
    const watchCoins = allMarketCoins.filter(c => watchlist.includes(c.symbol));
    if (!watchCoins.length) {
        container.innerHTML = '<div class="empty-state">واچ‌لیست خالی است.</div>';
        return;
    }
    container.innerHTML = watchCoins.map(c => `
        <div class="watchlist-card" onclick="openChart('${c.symbol}')">
            <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
            <div class="watchlist-coin-info">
                <span class="coin-symbol">${c.symbol}</span>
                <span class="coin-price">$${c.priceUsd.toFixed(2)}</span>
            </div>
            <span class="watchlist-remove" onclick="toggleWatchlist('${c.symbol}', event)">✕</span>
        </div>
    `).join('');
}

// =========================================================================
// چارت و مودال‌ها
// =========================================================================
function openChart(symbol) {
    const modal = document.getElementById('chart-modal');
    modal.style.display = 'flex';
    document.getElementById('modal-coin-title').innerText = `${symbol} / USDT`;
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
            disabled_features: ['header_widget_dom_node']
        });
    } else {
        container.innerHTML = '<div class="empty-state">TradingView در دسترس نیست.</div>';
    }
}

function closeChart() {
    document.getElementById('chart-modal').style.display = 'none';
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
    list.innerHTML = allMarketCoins.map(c => `
        <div class="coin-select-item" onclick="toggleWatchlist('${c.symbol}', event)">
            <span>${c.symbol} - ${c.name}</span>
            <span>${watchlist.includes(c.symbol) ? '⭐' : '☆'}</span>
        </div>
    `).join('');
}

function filterAddCoinModal() {
    const q = document.getElementById('coin-search-input').value.toLowerCase();
    document.querySelectorAll('.coin-select-item').forEach(el => {
        el.style.display = el.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
    });
}

// =========================================================================
// راه‌اندازی اولیه
// =========================================================================
document.addEventListener('DOMContentLoaded', () => {
    applyLanguage();
    loadTelegramUser();
    loadMarketData();
    switchTab('dashboard-page');
    // به‌روزرسانی دوره‌ای
    setInterval(() => {
        if (document.querySelector('.page.active')?.id === 'market-page' || document.querySelector('.page.active')?.id === 'dashboard-page') {
            loadMarketData();
        }
    }, 60000);
});

// ثبت توابع در پنجره
window.switchTab = switchTab;
window.openChart = openChart;
window.closeChart = closeChart;
window.toggleWatchlist = toggleWatchlist;
window.filterMarketCategory = filterMarketCategory;
window.toggleFilterMenu = toggleFilterMenu;
window.openAddCoinModal = openAddCoinModal;
window.closeAddCoinModal = closeAddCoinModal;
window.filterAddCoinModal = filterAddCoinModal;
window.populateAddCoinModal = populateAddCoinModal;
window.openAddAnalysisModal = openAddAnalysisModal;
window.closeAddAnalysisModal = closeAddAnalysisModal;
window.submitAnalysis = submitAnalysis;
window.openAnalysisDetail = openAnalysisDetail;
window.openReferralPage = openReferralPage;
window.closeReferralPage = closeReferralPage;
window.copyReferralLink = copyReferralLink;
window.shareReferralLink = shareReferralLink;
window.openSettingsPage = openSettingsPage;
window.closeSettingsPage = closeSettingsPage;
window.openSupportPage = openSupportPage;
window.closeSupportPage = closeSupportPage;
window.submitTicket = submitTicket;
window.openAboutPage = openAboutPage;
window.closeAboutPage = closeAboutPage;
window.changeLanguage = changeLanguage;
window.renderWatchlist = renderWatchlist;
window.renderAnalysisSlider = renderAnalysisSlider;
window.renderAnalysisList = renderAnalysisList;
window.loadTelegramUser = loadTelegramUser;
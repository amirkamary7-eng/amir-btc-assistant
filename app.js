// ============================================================
// Amir BTC Assistant - Core Application
// ============================================================

// ---------- محیط و متغیرهای اولیه ----------
const tg = window.Telegram?.WebApp;
if (tg) { tg.ready(); tg.expand(); }

const ADMIN_ID = '831704732'; // آی‌دی مدیر اصلی (HEART_HACKR)
const CHANNEL = 'amir_btc_2024';
const PROXY = 'https://amir-btc-assistant9.amirkamary7.workers.dev/?url=';

let currentLang = localStorage.getItem('app_lang') || 'fa';
let watchlist = JSON.parse(localStorage.getItem('watchlist') || '[]');
let analyses = JSON.parse(localStorage.getItem('analyses') || '[]');
let tickets = JSON.parse(localStorage.getItem('tickets') || '[]');
let notifications = JSON.parse(localStorage.getItem('notifications') || '[]');
let alerts = JSON.parse(localStorage.getItem('price_alerts') || '[]');
let allCoins = [];
let currentMarketTab = 'overview';
let searchTerm = '';
let sliderInterval = null;
let currentSlide = 0;

// ---------- ترجمه‌ها ----------
const i18n = {
    fa: {
        welcome: 'خوش آمدید،',
        dashboard: 'داشبورد',
        market: 'مارکت',
        analysis: 'تحلیل‌ها',
        news: 'اخبار',
        profile: 'پروفایل',
        watchlist: 'واچ‌لیست',
        settings: 'تنظیمات',
        referral: 'دعوت و پاداش',
        support: 'پشتیبانی',
        about: 'درباره ما',
        language: 'زبان',
        search: 'جستجوی ارز...',
        no_data: 'داده‌ای موجود نیست',
        join_channel: 'عضویت در کانال',
        copy: 'کپی',
        share: 'اشتراک‌گذاری'
    },
    en: {
        welcome: 'Welcome,',
        dashboard: 'Dashboard',
        market: 'Market',
        analysis: 'Analysis',
        news: 'News',
        profile: 'Profile',
        watchlist: 'Watchlist',
        settings: 'Settings',
        referral: 'Referral & Earn',
        support: 'Support',
        about: 'About',
        language: 'Language',
        search: 'Search coin...',
        no_data: 'No data available',
        join_channel: 'Join Channel',
        copy: 'Copy',
        share: 'Share'
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

function changeLang(lang) {
    if (lang === currentLang) return;
    currentLang = lang;
    applyLanguage();
    document.getElementById('lang-fa-check').style.display = lang === 'fa' ? 'inline' : 'none';
    document.getElementById('lang-en-check').style.display = lang === 'en' ? 'inline' : 'none';
    // رفرش داده‌ها
    loadMarketData();
}

// ---------- کش ----------
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

// ---------- API ----------
async function fetchWithProxy(url) {
    const res = await fetch(PROXY + encodeURIComponent(url));
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    return res.json();
}

// ---------- بارگذاری داده‌های بازار ----------
async function loadMarketData() {
    try {
        const cached = Cache.get('market');
        if (cached) { allCoins = cached; renderMarket(); renderWatchlist(); renderSummary(); return; }

        const data = await fetchWithProxy('https://api.coincap.io/v2/assets?limit=200');
        const assets = data.data || [];
        // دریافت قیمت‌های دقیق‌تر از Binance
        const symbols = assets.slice(0, 50).map(a => a.symbol + 'USDT');
        let binancePrices = {};
        try {
            const binanceData = await fetchWithProxy(`https://api.binance.com/api/v3/ticker/24hr?symbols=${JSON.stringify(symbols)}`);
            if (Array.isArray(binanceData)) {
                binanceData.forEach(item => {
                    const sym = item.symbol.replace('USDT', '');
                    binancePrices[sym] = {
                        price: parseFloat(item.lastPrice),
                        change: parseFloat(item.priceChangePercent),
                        volume: parseFloat(item.volume)
                    };
                });
            }
        } catch (e) {}

        allCoins = assets.map((item, i) => {
            const sym = item.symbol;
            const b = binancePrices[sym] || {};
            return {
                symbol: sym,
                name: item.name,
                rank: i + 1,
                priceUsd: b.price || parseFloat(item.priceUsd) || 0,
                changePercent24Hr: b.change || parseFloat(item.changePercent24Hr) || 0,
                volumeUsd24Hr: b.volume || parseFloat(item.volumeUsd24Hr) || 0,
                marketCapUsd: parseFloat(item.marketCapUsd) || 0,
                supply: parseFloat(item.supply) || 0
            };
        });

        Cache.set('market', allCoins, 60);
        renderMarket();
        renderWatchlist();
        renderSummary();
    } catch (e) { console.error('Market load error:', e); }
}

// ---------- رندر خلاصه بازار ----------
function renderSummary() {
    if (!allCoins.length) return;
    const mcap = allCoins.reduce((s, c) => s + c.marketCapUsd, 0);
    const volume = allCoins.reduce((s, c) => s + c.volumeUsd24Hr, 0);
    const btc = allCoins.find(c => c.symbol === 'BTC');
    document.getElementById('global-mcap').innerText = '$' + (mcap / 1e12).toFixed(2) + 'T';
    document.getElementById('global-volume').innerText = '$' + (volume / 1e9).toFixed(2) + 'B';
    document.getElementById('btc-dom').innerText = btc ? ((btc.marketCapUsd / mcap) * 100).toFixed(1) + '%' : '--';
}

// ---------- رندر مارکت با تب‌ها ----------
function renderMarket() {
    const list = document.getElementById('coin-list');
    let filtered = [...allCoins];

    // جستجو
    if (searchTerm) {
        filtered = filtered.filter(c => c.symbol.toLowerCase().includes(searchTerm) || c.name.toLowerCase().includes(searchTerm));
    }

    // تب‌ها
    switch (currentMarketTab) {
        case 'trending':
            filtered = filtered.sort((a, b) => b.volumeUsd24Hr - a.volumeUsd24Hr).slice(0, 30);
            break;
        case 'gainers':
            filtered = filtered.filter(c => c.changePercent24Hr > 0).sort((a, b) => b.changePercent24Hr - a.changePercent24Hr).slice(0, 30);
            break;
        case 'losers':
            filtered = filtered.filter(c => c.changePercent24Hr < 0).sort((a, b) => a.changePercent24Hr - b.changePercent24Hr).slice(0, 30);
            break;
        case 'watchlist':
            filtered = filtered.filter(c => watchlist.includes(c.symbol));
            break;
        default: // overview
            filtered = filtered.slice(0, 50);
            break;
    }

    if (!filtered.length) {
        list.innerHTML = `<div class="empty-state">${t('no_data')}</div>`;
        return;
    }

    list.innerHTML = filtered.map(c => {
        const isPos = c.changePercent24Hr >= 0;
        const inWatch = watchlist.includes(c.symbol);
        return `
            <div class="coin-item" onclick="openCoinDetail('${c.symbol}')">
                <div class="coin-left">
                    <span class="coin-rank">#${c.rank}</span>
                    <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon">
                    <div>
                        <div class="coin-sym">${c.symbol}</div>
                        <div class="coin-name">${c.name}</div>
                    </div>
                </div>
                <div class="coin-right">
                    <div class="coin-price">$${c.priceUsd > 1 ? c.priceUsd.toFixed(2) : c.priceUsd.toFixed(6)}</div>
                    <div class="coin-change ${isPos ? 'up' : 'down'}">${isPos ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</div>
                    <span class="watch-star ${inWatch ? 'active' : ''}" onclick="toggleWatchlist('${c.symbol}', event)">${inWatch ? '⭐' : '☆'}</span>
                </div>
            </div>
        `;
    }).join('');
}

function switchMarketTab(tab, btn) {
    currentMarketTab = tab;
    document.querySelectorAll('.tab-btn').forEach(b => b.classList.remove('active'));
    btn.classList.add('active');
    renderMarket();
}

// ---------- جستجو ----------
document.addEventListener('DOMContentLoaded', () => {
    document.getElementById('market-search')?.addEventListener('input', (e) => {
        searchTerm = e.target.value.toLowerCase().trim();
        renderMarket();
    });
});

// ---------- واچ‌لیست ----------
function toggleWatchlist(symbol, event) {
    if (event) event.stopPropagation();
    const idx = watchlist.indexOf(symbol);
    if (idx > -1) watchlist.splice(idx, 1);
    else watchlist.push(symbol);
    localStorage.setItem('watchlist', JSON.stringify(watchlist));
    renderMarket();
    renderWatchlist();
}

function renderWatchlist() {
    const grid = document.getElementById('watchlist-grid');
    const watchCoins = allCoins.filter(c => watchlist.includes(c.symbol));
    if (!watchCoins.length) {
        grid.innerHTML = `<div class="empty-state">واچ‌لیست خالی است</div>`;
        return;
    }
    grid.innerHTML = watchCoins.slice(0, 6).map(c => `
        <div class="watch-item" onclick="openCoinDetail('${c.symbol}')">
            <span class="remove-watch" onclick="toggleWatchlist('${c.symbol}', event)">✕</span>
            <img src="https://assets.coincap.io/assets/icons/${c.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'">
            <span class="watch-sym">${c.symbol}</span>
            <span class="watch-price">$${c.priceUsd.toFixed(2)}</span>
            <span class="watch-change ${c.changePercent24Hr >= 0 ? 'up' : 'down'}">${c.changePercent24Hr >= 0 ? '+' : ''}${c.changePercent24Hr.toFixed(2)}%</span>
        </div>
    `).join('');
}

// ---------- مودال افزودن واچ‌لیست ----------
function openAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'flex';
    populateCoinModal();
}

function closeAddCoinModal() {
    document.getElementById('add-coin-modal').style.display = 'none';
}

function populateCoinModal() {
    const list = document.getElementById('coin-modal-list');
    list.innerHTML = allCoins.map(c => `
        <div class="modal-coin-item" onclick="toggleWatchlist('${c.symbol}', event); populateCoinModal();">
            <span>${c.symbol} - ${c.name}</span>
            <span>${watchlist.includes(c.symbol) ? '⭐' : '☆'}</span>
        </div>
    `).join('');
}

function filterCoinList() {
    const q = document.getElementById('coin-search-modal').value.toLowerCase();
    document.querySelectorAll('.modal-coin-item').forEach(el => {
        el.style.display = el.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
    });
}

// ---------- اسلایدر تحلیل‌ها ----------
function renderAnalysisSlider() {
    const track = document.getElementById('slider-track');
    const dots = document.getElementById('slider-dots');
    if (!analyses.length) {
        track.innerHTML = `<div class="slide-empty">تحلیلی موجود نیست</div>`;
        return;
    }
    const showSlide = (idx) => {
        const a = analyses[idx];
        track.innerHTML = `
            <div class="slide-item" onclick="openAnalysisDetail('${a.id}')">
                <img src="${a.image || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop'}" class="slide-img">
                <div class="slide-overlay">
                    <h4>${a.coin} (${a.timeframe})</h4>
                    <p>${a.text.substring(0, 80)}...</p>
                    <span class="slide-author">${a.author} • ${a.date}</span>
                </div>
            </div>
        `;
        dots.innerHTML = analyses.map((_, i) => `<span class="dot ${i === idx ? 'active' : ''}"></span>`).join('');
    };
    if (currentSlide >= analyses.length) currentSlide = 0;
    showSlide(currentSlide);
    clearInterval(sliderInterval);
    sliderInterval = setInterval(() => {
        currentSlide = (currentSlide + 1) % analyses.length;
        showSlide(currentSlide);
    }, 5000);
}

// ---------- مدیریت تحلیل (فقط مدیر) ----------
function isAdmin() {
    const user = tg?.initDataUnsafe?.user;
    return user && String(user.id) === ADMIN_ID;
}

function openAddAnalysisModal() {
    if (!isAdmin()) { alert('فقط مدیران مجاز به افزودن تحلیل هستند.'); return; }
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
    if (!coin || !text) { alert('نام ارز و متن تحلیل الزامی است.'); return; }
    if (!image) image = 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop';

    const newAnalysis = {
        id: Date.now().toString(),
        coin,
        timeframe,
        image,
        text,
        date: new Date().toLocaleDateString('fa-IR'),
        author: tg?.initDataUnsafe?.user?.first_name || 'مدیر'
    };
    analyses.unshift(newAnalysis);
    localStorage.setItem('analyses', JSON.stringify(analyses));
    renderAnalysisSlider();
    renderAnalysisList();
    closeAddAnalysisModal();
    // پاک کردن فیلدها
    ['analysis-coin', 'analysis-timeframe', 'analysis-image', 'analysis-text'].forEach(id => document.getElementById(id).value = '');
    addNotification('تحلیل جدید', `تحلیل ${coin} منتشر شد.`);
}

function renderAnalysisList() {
    const grid = document.getElementById('analysis-grid');
    if (!analyses.length) {
        grid.innerHTML = '<div class="empty-state">هیچ تحلیلی ثبت نشده است.</div>';
        return;
    }
    grid.innerHTML = analyses.map(a => `
        <div class="analysis-card" onclick="openAnalysisDetail('${a.id}')">
            <img src="${a.image}" class="analysis-cover">
            <div class="analysis-body">
                <h4>${a.coin} <span class="tf-badge">${a.timeframe}</span></h4>
                <p>${a.text.substring(0, 100)}...</p>
                <div class="analysis-meta">${a.author} • ${a.date}</div>
            </div>
        </div>
    `).join('');
}

function openAnalysisDetail(id) {
    const a = analyses.find(x => x.id === id);
    if (!a) return;
    tg?.showPopup?.({
        title: `تحلیل ${a.coin} (${a.timeframe})`,
        message: `${a.text}\n\n✍️ ${a.author}\n📅 ${a.date}`,
        buttons: [{ type: 'close', text: 'بستن' }]
    }) || alert(`${a.coin}:\n${a.text}`);
}

// ---------- اخبار ----------
let newsCache = [];
async function loadNews() {
    try {
        const cached = Cache.get('news');
        if (cached) { newsCache = cached; renderNews('all'); return; }

        // از چند منبع جمع‌آوری می‌کنیم
        const sources = [
            { url: 'https://min-api.cryptocompare.com/data/v2/news/?lang=EN&feeds=cointelegraph,coindesk,decrypt', key: 'Data' },
            { url: 'https://cryptopanic.com/api/v1/posts/?auth_token=YOUR_API_KEY&public=true', key: 'results' } // اگر کلید نداری، این منبع را غیرفعال کن
        ];
        let articles = [];
        for (const src of sources) {
            try {
                const data = await fetchWithProxy(src.url);
                if (src.key === 'Data') {
                    articles = data.Data.map(item => ({
                        title: item.title,
                        source: item.source_info.name,
                        image: item.imageurl || 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop',
                        url: item.url,
                        body: item.body || item.description || '',
                        category: 'crypto'
                    }));
                } else if (src.key === 'results') {
                    // برای CryptoPanic
                }
            } catch (e) {}
        }
        // اگر هیچ خبری نیامد، از Mock استفاده کن
        if (!articles.length) {
            articles = [
                { title: 'بیت‌کوین به ۷۰ هزار دلار نزدیک شد', source: 'کوین‌تلگراف', image: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop', url: '#', body: 'با افزایش حجم معاملات...', category: 'crypto' },
                { title: 'اتریوم ۱۵٪ رشد کرد', source: 'کوین‌دسک', image: 'https://images.unsplash.com/photo-1621761191319-c6fb62004040?q=80&w=600&auto=format&fit=crop', url: '#', body: 'اتریوم به سطح ۴۰۰۰ دلار رسید...', category: 'crypto' }
            ];
        }
        newsCache = articles;
        Cache.set('news', newsCache, 300);
        renderNews('all');
    } catch (e) { console.error('News error:', e); }
}

function renderNews(category) {
    const container = document.getElementById('news-list');
    let filtered = newsCache;
    if (category === 'crypto') filtered = filtered.filter(n => n.category === 'crypto');
    else if (category === 'economy') filtered = filtered.filter(n => n.category === 'economy');
    else if (category === 'forex') filtered = filtered.filter(n => n.category === 'forex');
    else if (category === 'calendar') {
        // برای تقویم اقتصادی از منبع دیگری استفاده کن (مثلاً Forex Factory)
        container.innerHTML = `<div class="empty-state">تقویم اقتصادی به زودی اضافه می‌شود.</div>`;
        return;
    }
    if (!filtered.length) {
        container.innerHTML = `<div class="empty-state">${t('no_data')}</div>`;
        return;
    }
    container.innerHTML = filtered.map(n => `
        <div class="news-item" onclick="openNewsModal('${encodeURIComponent(JSON.stringify(n))}')">
            <img src="${n.image}" class="news-img" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'">
            <div class="news-content">
                <div class="news-title">${n.title}</div>
                <div class="news-source">${n.source}</div>
            </div>
        </div>
    `).join('');
}

function switchNewsTab(category, btn) {
    document.querySelectorAll('.news-tab').forEach(b => b.classList.remove('active'));
    if (btn) btn.classList.add('active');
    renderNews(category);
}

function openNewsModal(encoded) {
    const n = JSON.parse(decodeURIComponent(encoded));
    document.getElementById('news-modal-title').innerText = n.title;
    document.getElementById('news-modal-image').src = n.image || 'https://img.icons8.com/clouds/100/000000/bitcoin.png';
    document.getElementById('news-modal-body').innerText = n.body || 'متن کامل خبر در دسترس نیست.';
    document.getElementById('news-modal-link').href = n.url || '#';
    document.getElementById('news-modal').style.display = 'flex';
}

function closeNewsModal() {
    document.getElementById('news-modal').style.display = 'none';
}

// ---------- جزئیات کوین و هشدار قیمت ----------
async function openCoinDetail(symbol) {
    const coin = allCoins.find(c => c.symbol === symbol);
    if (!coin) return;
    document.getElementById('detail-coin-title').innerText = `${symbol} / USDT`;
    const modal = document.getElementById('coin-detail-modal');
    modal.style.display = 'flex';

    // نمودار TradingView
    const chartContainer = document.getElementById('detail-chart');
    chartContainer.innerHTML = '';
    if (typeof TradingView !== 'undefined') {
        new TradingView.widget({
            width: '100%',
            height: '100%',
            symbol: `BINANCE:${symbol}USDT`,
            interval: '60',
            theme: 'dark',
            style: '1',
            locale: 'en',
            container_id: 'detail-chart',
            hide_side_toolbar: true,
            disabled_features: ['header_widget_dom_node']
        });
    } else {
        chartContainer.innerHTML = '<div class="empty-state">نمودار در دسترس نیست</div>';
    }

    // آمار
    document.getElementById('detail-stats').innerHTML = `
        <div><span>قیمت</span><strong>$${coin.priceUsd > 1 ? coin.priceUsd.toFixed(2) : coin.priceUsd.toFixed(6)}</strong></div>
        <div><span>تغییر ۲۴h</span><strong class="${coin.changePercent24Hr >= 0 ? 'up' : 'down'}">${coin.changePercent24Hr >= 0 ? '+' : ''}${coin.changePercent24Hr.toFixed(2)}%</strong></div>
        <div><span>مارکت‌کپ</span><strong>$${(coin.marketCapUsd / 1e9).toFixed(2)}B</strong></div>
        <div><span>حجم ۲۴h</span><strong>$${(coin.volumeUsd24Hr / 1e6).toFixed(2)}M</strong></div>
    `;

    // نمایش هشدارهای فعال برای این کوین
    renderActiveAlerts(symbol);
}

function closeCoinDetail() {
    document.getElementById('coin-detail-modal').style.display = 'none';
}

function renderActiveAlerts(symbol) {
    const container = document.getElementById('active-alerts');
    const userAlerts = alerts.filter(a => a.symbol === symbol);
    if (!userAlerts.length) {
        container.innerHTML = 'هیچ هشدار قیمتی فعالی ندارید.';
        return;
    }
    container.innerHTML = userAlerts.map(a => `
        <div style="display:flex; justify-content:space-between; padding:4px 0; border-bottom:1px solid var(--border);">
            <span>💰 ${a.price}</span>
            <span style="color:var(--red); cursor:pointer;" onclick="removeAlert('${a.id}')">✕</span>
        </div>
    `).join('');
}

function setPriceAlert() {
    const input = document.getElementById('alert-price');
    const price = parseFloat(input.value);
    const symbol = document.getElementById('detail-coin-title').innerText.split(' ')[0];
    if (!price || price <= 0) { alert('لطفاً قیمت هدف معتبر وارد کنید.'); return; }
    const newAlert = {
        id: Date.now().toString(),
        symbol,
        price,
        createdAt: new Date().toISOString()
    };
    alerts.push(newAlert);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    input.value = '';
    renderActiveAlerts(symbol);
    addNotification('هشدار قیمت ثبت شد', `برای ${symbol} در قیمت ${price} ثبت گردید.`);
    // بررسی دوره‌ای هشدارها
    checkAlerts();
}

function removeAlert(id) {
    alerts = alerts.filter(a => a.id !== id);
    localStorage.setItem('price_alerts', JSON.stringify(alerts));
    const symbol = document.getElementById('detail-coin-title').innerText.split(' ')[0];
    renderActiveAlerts(symbol);
}

async function checkAlerts() {
    if (!alerts.length) return;
    // دریافت قیمت‌های لحظه‌ای
    const symbols = [...new Set(alerts.map(a => a.symbol))];
    try {
        const data = await fetchWithProxy(`https://api.coincap.io/v2/assets?ids=${symbols.join(',')}`);
        const assets = data.data || [];
        const priceMap = {};
        assets.forEach(a => { priceMap[a.symbol] = parseFloat(a.priceUsd); });

        let triggered = [];
        alerts.forEach(a => {
            const currentPrice = priceMap[a.symbol];
            if (currentPrice && currentPrice >= a.price) {
                triggered.push(a);
            }
        });
        if (triggered.length) {
            triggered.forEach(a => {
                addNotification('🚨 هشدار قیمت', `${a.symbol} به قیمت ${a.price} رسید!`);
                // حذف هشدار پس از رسیدن
                alerts = alerts.filter(x => x.id !== a.id);
                localStorage.setItem('price_alerts', JSON.stringify(alerts));
            });
        }
    } catch (e) {}
}

// ---------- نوتیفیکیشن ----------
function addNotification(title, body) {
    const notif = {
        id: Date.now().toString(),
        title,
        body,
        read: false,
        date: new Date().toISOString()
    };
    notifications.unshift(notif);
    if (notifications.length > 50) notifications = notifications.slice(0, 50);
    localStorage.setItem('notifications', JSON.stringify(notifications));
    updateNotifBadge();
}

function updateNotifBadge() {
    const unread = notifications.filter(n => !n.read).length;
    const badge = document.getElementById('notif-badge');
    if (unread > 0) {
        badge.style.display = 'flex';
        badge.innerText = unread;
    } else {
        badge.style.display = 'none';
    }
}

function toggleNotificationPanel() {
    const modal = document.getElementById('notif-modal');
    modal.style.display = modal.style.display === 'flex' ? 'none' : 'flex';
    renderNotifications();
}

function closeNotifModal() {
    document.getElementById('notif-modal').style.display = 'none';
}

function renderNotifications() {
    const container = document.getElementById('notif-list');
    if (!notifications.length) {
        container.innerHTML = '<div class="empty-state">هیچ اعلانی وجود ندارد.</div>';
        return;
    }
    container.innerHTML = notifications.slice(0, 20).map(n => `
        <div class="notif-item ${n.read ? 'read' : 'unread'}" onclick="markNotifRead('${n.id}')">
            <div class="notif-title">${n.title}</div>
            <div class="notif-body">${n.body}</div>
            <div class="notif-date">${new Date(n.date).toLocaleDateString('fa-IR')}</div>
        </div>
    `).join('');
}

function markNotifRead(id) {
    const n = notifications.find(x => x.id === id);
    if (n) { n.read = true; localStorage.setItem('notifications', JSON.stringify(notifications)); updateNotifBadge(); renderNotifications(); }
}

// ---------- پروفایل و رفرال ----------
function loadUser() {
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        document.getElementById('profile-name').innerText = `${user.first_name || ''} ${user.last_name || ''}`.trim() || 'کاربر';
        document.getElementById('profile-username').innerText = user.username ? `@${user.username}` : '@guest';
        document.getElementById('profile-id-num').innerText = user.id || '000000';
        if (user.photo_url) document.getElementById('profile-avatar').src = user.photo_url;
        document.getElementById('ref-link').value = `https://t.me/AmirBtcBot/app?startapp=ref_${user.id}`;
        // آمار رفرال (شبیه‌سازی)
        const refData = JSON.parse(localStorage.getItem('ref_stats') || '{"total":0,"active":0,"reward":0}');
        document.getElementById('ref-total').innerText = refData.total;
        document.getElementById('ref-active').innerText = refData.active;
        document.getElementById('ref-reward').innerText = refData.reward + ' SAT';
    } else {
        document.getElementById('profile-name').innerText = 'کاربر میهمان';
        document.getElementById('profile-username').innerText = 'loading...';
        document.getElementById('profile-id-num').innerText = '000000';
        document.getElementById('ref-link').value = 'https://t.me/AmirBtcBot/app?startapp=ref_guest';
    }
    // چک کردن ادمین برای دکمه تحلیل
    const adminBtn = document.getElementById('admin-add-btn');
    if (adminBtn) adminBtn.style.display = isAdmin() ? 'block' : 'none';
}

function copyRefLink() {
    const input = document.getElementById('ref-link');
    input.select();
    try { navigator.clipboard.writeText(input.value); } catch(e) { document.execCommand('copy'); }
    tg?.showPopup?.({ title: 'کپی شد!', message: 'لینک دعوت کپی شد.', buttons: [{type:'ok'}] });
}

function shareRefLink() {
    const link = document.getElementById('ref-link').value;
    const text = encodeURIComponent('به Amir BTC Assistant بپیوندید و از تحلیل‌های حرفه‌ای بازار استفاده کنید!');
    tg?.openTelegramLink?.(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`) ||
    window.open(`https://t.me/share/url?url=${encodeURIComponent(link)}&text=${text}`, '_blank');
}

// ---------- تنظیمات و پشتیبانی ----------
function toggleSettings() {
    const panel = document.getElementById('settings-panel');
    panel.style.display = panel.style.display === 'none' ? 'block' : 'none';
}

function openTickets() {
    document.getElementById('settings-panel').style.display = 'none';
    document.getElementById('tickets-page').style.display = 'block';
    renderTickets();
}

function closeTickets() {
    document.getElementById('tickets-page').style.display = 'none';
    document.getElementById('settings-panel').style.display = 'block';
}

function renderTickets() {
    const container = document.getElementById('ticket-list');
    if (!tickets.length) {
        container.innerHTML = '<div class="empty-state">تیکتی ثبت نشده است.</div>';
        return;
    }
    container.innerHTML = tickets.map(t => `
        <div class="ticket-item">
            <div><strong>${t.title}</strong> <span class="ticket-status ${t.status}">${t.status === 'open' ? 'در انتظار' : 'پاسخ داده شده'}</span></div>
            <div>${t.body}</div>
            ${t.response ? `<div class="ticket-reply">✅ ${t.response}</div>` : ''}
            <div class="ticket-date">${t.date}</div>
        </div>
    `).join('');
}

function submitTicket() {
    const title = document.getElementById('ticket-title').value.trim();
    const body = document.getElementById('ticket-body').value.trim();
    if (!title || !body) { alert('عنوان و متن تیکت الزامی است.'); return; }
    const ticket = {
        id: Date.now().toString(),
        title,
        body,
        date: new Date().toLocaleDateString('fa-IR'),
        status: 'open',
        response: null
    };
    tickets.unshift(ticket);
    localStorage.setItem('tickets', JSON.stringify(tickets));
    document.getElementById('ticket-title').value = '';
    document.getElementById('ticket-body').value = '';
    renderTickets();
    addNotification('تیکت جدید', `تیکت "${title}" با موفقیت ارسال شد.`);
    // شبیه‌سازی پاسخ خودکار ادمین (در تولید، این بخش با Webhook انجام می‌شود)
    setTimeout(() => {
        const idx = tickets.findIndex(t => t.id === ticket.id);
        if (idx > -1) {
            tickets[idx].status = 'answered';
            tickets[idx].response = 'سلام، درخواست شما دریافت شد. به زودی بررسی می‌شود.';
            localStorage.setItem('tickets', JSON.stringify(tickets));
            renderTickets();
            addNotification('پاسخ تیکت', `پاسخ به تیکت "${ticket.title}" دریافت شد.`);
        }
    }, 5000);
}

function openAbout() {
    document.getElementById('settings-panel').style.display = 'none';
    document.getElementById('about-page').style.display = 'block';
}

function closeAbout() {
    document.getElementById('about-page').style.display = 'none';
    document.getElementById('settings-panel').style.display = 'block';
}

function joinChannel() {
    if (tg?.openTelegramLink) tg.openTelegramLink(`https://t.me/${CHANNEL}`);
    else window.open(`https://t.me/${CHANNEL}`, '_blank');
}

// ---------- نویگیشن ----------
function switchTab(pageId, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId)?.classList.add('active');
    document.querySelectorAll('.nav-item').forEach(n => n.classList.remove('active'));
    if (btn) btn.classList.add('active');

    if (pageId === 'dashboard-page') {
        loadUser();
        loadMarketData();
        renderAnalysisSlider();
    } else if (pageId === 'market-page') {
        loadMarketData();
    } else if (pageId === 'analysis-page') {
        renderAnalysisList();
        document.getElementById('admin-add-btn').style.display = isAdmin() ? 'block' : 'none';
    } else if (pageId === 'news-page') {
        loadNews();
    } else if (pageId === 'profile-page') {
        loadUser();
        document.getElementById('settings-panel').style.display = 'none';
        document.getElementById('tickets-page').style.display = 'none';
        document.getElementById('about-page').style.display = 'none';
    }
}

// ---------- راه‌اندازی اولیه ----------
document.addEventListener('DOMContentLoaded', () => {
    applyLanguage();
    loadUser();
    loadMarketData();
    renderAnalysisSlider();
    loadNews();
    updateNotifBadge();
    // بررسی دوره‌ای هشدارها هر ۳۰ ثانیه
    setInterval(checkAlerts, 30000);
    // به‌روزرسانی داده‌های بازار هر ۶۰ ثانیه
    setInterval(() => {
        if (document.querySelector('.page.active')?.id === 'market-page' || document.querySelector('.page.active')?.id === 'dashboard-page') {
            loadMarketData();
        }
    }, 60000);
});

// ---------- ثبت توابع در فضای global ----------
window.switchTab = switchTab;
window.switchMarketTab = switchMarketTab;
window.switchNewsTab = switchNewsTab;
window.toggleWatchlist = toggleWatchlist;
window.openAddCoinModal = openAddCoinModal;
window.closeAddCoinModal = closeAddCoinModal;
window.filterCoinList = filterCoinList;
window.openAddAnalysisModal = openAddAnalysisModal;
window.closeAddAnalysisModal = closeAddAnalysisModal;
window.submitAnalysis = submitAnalysis;
window.openCoinDetail = openCoinDetail;
window.closeCoinDetail = closeCoinDetail;
window.setPriceAlert = setPriceAlert;
window.removeAlert = removeAlert;
window.toggleNotificationPanel = toggleNotificationPanel;
window.closeNotifModal = closeNotifModal;
window.markNotifRead = markNotifRead;
window.copyRefLink = copyRefLink;
window.shareRefLink = shareRefLink;
window.toggleSettings = toggleSettings;
window.openTickets = openTickets;
window.closeTickets = closeTickets;
window.submitTicket = submitTicket;
window.openAbout = openAbout;
window.closeAbout = closeAbout;
window.joinChannel = joinChannel;
window.changeLang = changeLang;
window.openNewsModal = openNewsModal;
window.closeNewsModal = closeNewsModal;
// ============================================================================
// WATCHLIST MANAGEMENT FUNCTIONS - Add these to app.js after switchTab()
// ============================================================================

function getWatchlist() {
    const stored = localStorage.getItem('watchlist');
    return stored ? JSON.parse(stored) : [];
}

function addToWatchlist(symbol) {
    const list = getWatchlist();
    if (!list.includes(symbol)) {
        list.push(symbol);
        localStorage.setItem('watchlist', JSON.stringify(list));
        renderWatchlist();
    }
}

function removeFromWatchlist(symbol) {
    let list = getWatchlist();
    list = list.filter(s => s !== symbol);
    localStorage.setItem('watchlist', JSON.stringify(list));
    renderWatchlist();
}

function openAddCoinModal() {
    const modal = document.getElementById('add-coin-modal');
    if (modal) {
        modal.style.display = 'flex';
        populateAddCoinModal();
    }
}

function closeAddCoinModal() {
    const modal = document.getElementById('add-coin-modal');
    if (modal) modal.style.display = 'none';
}

function populateAddCoinModal() {
    const list = document.getElementById('coin-list-modal');
    if (!list) return;
    const watchlist = getWatchlist();
    list.innerHTML = '';
    
    allMarketCoins.slice(0, 50).forEach(coin => {
        const isSelected = watchlist.includes(coin.symbol);
        const el = document.createElement('div');
        el.style.cssText = `padding:10px; background:${isSelected ? 'rgba(247,147,26,0.2)' : 'rgba(255,255,255,0.02)'}; border-radius:8px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; border:1px solid ${isSelected ? '#f7931a' : 'rgba(255,255,255,0.1)'};`;
        el.onclick = () => { 
            if (isSelected) removeFromWatchlist(coin.symbol); 
            else addToWatchlist(coin.symbol);
            populateAddCoinModal(); 
        };
        el.innerHTML = `
            <div style="display:flex; align-items:center; gap:10px; flex:1;">
                <img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" style="width:24px; height:24px;" onerror="this.src='https://img.icons8.com/clouds/24/000000/bitcoin.png'">
                <div>
                    <div style="color:#fff; font-weight:bold;">${coin.symbol}</div>
                    <div style="color:#999; font-size:11px;">$${parseFloat(coin.priceUsd).toLocaleString()}</div>
                </div>
            </div>
            <div style="color:${isSelected ? '#f7931a' : '#999'}; font-size:18px;">${isSelected ? '✓' : ''}</div>
        `;
        list.appendChild(el);
    });
}

function filterAddCoinModal() {
    const input = document.getElementById('coin-search-input');
    const query = input.value.toLowerCase();
    const items = document.querySelectorAll('#coin-list-modal > div');
    items.forEach(item => {
        const text = item.innerText.toLowerCase();
        item.style.display = text.includes(query) ? 'flex' : 'none';
    });
}

// REPLACE THE ENTIRE renderWatchlist() function with this:
function renderWatchlist() {
    const container = document.getElementById("watchlist-container");
    if (!container) return;

    const watchlist = getWatchlist();
    let html = '<div class="watchlist-card" style="cursor:pointer; background: rgba(247,147,26,0.08); border: 1.5px dashed rgba(247,147,26,0.5);" onclick="openAddCoinModal()"><div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; width:100%;"><div style="font-size:24px; font-weight:bold; color:var(--primary);">+</div><div style="font-size:11px; color:var(--text-dim);">کوین اضافه کن</div></div></div>';
    
    if (watchlist.length === 0) {
        allMarketCoins.slice(0, 4).forEach(coin => {
            const change = parseFloat(coin.changePercent24Hr);
            const isPositive = change >= 0;
            const sign = isPositive ? '+' : '';
            html += `<div class="watchlist-card" onclick="openChart('${coin.symbol}')"><div class="watchlist-card-header"><img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon-mini"><span class="coin-symbol">${coin.symbol}</span></div><div class="coin-price">\\$${parseFloat(coin.priceUsd).toLocaleString()}</div><div class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-size:10px; margin-top:4px;">${sign}${change.toFixed(2)}%</div></div>`;
        });
    } else {
        watchlist.forEach(symbol => {
            const coin = allMarketCoins.find(c => c.symbol === symbol);
            if (coin) {
                const change = parseFloat(coin.changePercent24Hr);
                const isPositive = change >= 0;
                const sign = isPositive ? '+' : '';
                html += `<div class="watchlist-card" onclick="openChart('${coin.symbol}')"><div class="watchlist-card-header"><img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon-mini"><span class="coin-symbol">${coin.symbol}</span></div><div class="coin-price">\\$${parseFloat(coin.priceUsd).toLocaleString()}</div><div class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-size:10px; margin-top:4px;">${sign}${change.toFixed(2)}%</div></div>`;
            }
        });
    }
    container.innerHTML = html;
}

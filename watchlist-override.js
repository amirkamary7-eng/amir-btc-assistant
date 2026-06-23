// Override renderWatchlist to use localStorage-based watchlist
const originalRenderWatchlist = renderWatchlist;
renderWatchlist = function() {
    const container = document.getElementById("watchlist-container");
    if (!container) return;
    
    if (!window.getWatchlist) {
        originalRenderWatchlist();
        return;
    }
    
    const watchlist = window.getWatchlist();
    let html = '<div class="watchlist-card" style="cursor:pointer; background: rgba(247,147,26,0.08); border: 1.5px dashed rgba(247,147,26,0.5);" onclick="openAddCoinModal()"><div style="display:flex; flex-direction:column; align-items:center; justify-content:center; gap:8px; width:100%;"><div style="font-size:24px; font-weight:bold; color:var(--primary);">+</div><div style="font-size:11px; color:var(--text-dim);">کوین اضافه کن</div></div></div>';
    
    if (watchlist.length === 0) {
        allMarketCoins.slice(0, 4).forEach(coin => {
            const change = parseFloat(coin.changePercent24Hr);
            const isPositive = change >= 0;
            const sign = isPositive ? '+' : '';
            html += `<div class="watchlist-card" onclick="openChart('${coin.symbol}')"><div class="watchlist-card-header"><img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon-mini"><span class="coin-symbol">${coin.symbol}</span></div><div class="coin-price">$${parseFloat(coin.priceUsd).toLocaleString()}</div><div class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-size:10px; margin-top:4px;">${sign}${change.toFixed(2)}%</div></div>`;
        });
    } else {
        watchlist.forEach(symbol => {
            const coin = allMarketCoins.find(c => c.symbol === symbol);
            if (coin) {
                const change = parseFloat(coin.changePercent24Hr);
                const isPositive = change >= 0;
                const sign = isPositive ? '+' : '';
                html += `<div class="watchlist-card" onclick="openChart('${coin.symbol}')"><div class="watchlist-card-header"><img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" onerror="this.src='https://img.icons8.com/clouds/100/000000/bitcoin.png'" class="coin-icon-mini"><span class="coin-symbol">${coin.symbol}</span></div><div class="coin-price">$${parseFloat(coin.priceUsd).toLocaleString()}</div><div class="badge ${isPositive ? 'badge-success' : 'badge-danger'}" style="font-size:10px; margin-top:4px;">${sign}${change.toFixed(2)}%</div></div>`;
            }
        });
    }
    
    container.innerHTML = html;
};

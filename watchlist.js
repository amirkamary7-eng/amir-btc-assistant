// Watchlist Management Module (هماهنگ با app.js)
(function() {
    if (typeof window.getWatchlist === 'undefined') {
        window.getWatchlist = function() {
            const stored = localStorage.getItem('watchlist');
            return stored ? JSON.parse(stored) : [];
        };
    }

    if (typeof window.addToWatchlist === 'undefined') {
        window.addToWatchlist = function(symbol) {
            const list = window.getWatchlist();
            if (!list.includes(symbol)) {
                list.push(symbol);
                localStorage.setItem('watchlist', JSON.stringify(list));
                if (typeof window.renderWatchlist === 'function') window.renderWatchlist();
                if (typeof window.renderMarketTabLists === 'function') {
                    const activeFilter = document.querySelector('.trend-tab-btn.active')?.dataset?.filter || 'all';
                    window.renderMarketTabLists(activeFilter);
                }
            }
        };
    }

    if (typeof window.removeFromWatchlist === 'undefined') {
        window.removeFromWatchlist = function(symbol) {
            let list = window.getWatchlist();
            list = list.filter(s => s !== symbol);
            localStorage.setItem('watchlist', JSON.stringify(list));
            if (typeof window.renderWatchlist === 'function') window.renderWatchlist();
            if (typeof window.renderMarketTabLists === 'function') {
                const activeFilter = document.querySelector('.trend-tab-btn.active')?.dataset?.filter || 'all';
                window.renderMarketTabLists(activeFilter);
            }
        };
    }

    if (typeof window.isInWatchlist === 'undefined') {
        window.isInWatchlist = function(symbol) {
            return window.getWatchlist().includes(symbol);
        };
    }

    if (typeof window.toggleWatchlist === 'undefined') {
        window.toggleWatchlist = function(symbol, event) {
            if (event) event.stopPropagation();
            if (window.isInWatchlist(symbol)) {
                window.removeFromWatchlist(symbol);
            } else {
                window.addToWatchlist(symbol);
            }
        };
    }

    if (typeof window.populateAddCoinModal === 'undefined') {
        window.populateAddCoinModal = function() {
            const list = document.getElementById('coin-list-modal');
            if (!list || !window.allMarketCoins) return;
            const watchlist = window.getWatchlist();
            list.innerHTML = '';
            window.allMarketCoins.forEach(coin => {
                const isSelected = watchlist.includes(coin.symbol);
                const el = document.createElement('div');
                el.style.cssText = `
                    padding:10px; 
                    background: ${isSelected ? 'rgba(247,147,26,0.2)' : 'rgba(255,255,255,0.02)'}; 
                    border-radius:8px; 
                    display:flex; 
                    justify-content:space-between; 
                    align-items:center; 
                    cursor:pointer; 
                    border:1px solid ${isSelected ? '#f7931a' : 'rgba(255,255,255,0.1)'};
                    margin-bottom: 4px;
                `;
                el.onclick = () => {
                    if (isSelected) {
                        window.removeFromWatchlist(coin.symbol);
                    } else {
                        window.addToWatchlist(coin.symbol);
                    }
                    window.populateAddCoinModal();
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
        };
    }

    if (typeof window.filterAddCoinModal === 'undefined') {
        window.filterAddCoinModal = function() {
            const input = document.getElementById('coin-search-input');
            const query = input.value.toLowerCase();
            const items = document.querySelectorAll('#coin-list-modal > div');
            items.forEach(item => {
                const text = item.innerText.toLowerCase();
                item.style.display = text.includes(query) ? 'flex' : 'none';
            });
        };
    }

    if (typeof window.closeAddCoinModal === 'undefined') {
        window.closeAddCoinModal = function() {
            const modal = document.getElementById('add-coin-modal');
            if (modal) modal.style.display = 'none';
        };
    }
})();
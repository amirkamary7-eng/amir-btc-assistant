// Watchlist Management Module
(function() {
    window.getWatchlist = () => {
        const stored = localStorage.getItem('watchlist');
        return stored ? JSON.parse(stored) : [];
    };
    
    window.addToWatchlist = (symbol) => {
        const list = getWatchlist();
        if (!list.includes(symbol)) {
            list.push(symbol);
            localStorage.setItem('watchlist', JSON.stringify(list));
            if (window.renderWatchlist) renderWatchlist();
        }
    };
    
    window.removeFromWatchlist = (symbol) => {
        let list = getWatchlist();
        list = list.filter(s => s !== symbol);
        localStorage.setItem('watchlist', JSON.stringify(list));
        if (window.renderWatchlist) renderWatchlist();
    };
    
    window.openAddCoinModal = () => {
        const modal = document.getElementById('add-coin-modal');
        if (modal) {
            modal.style.display = 'flex';
            populateAddCoinModal();
        }
    };
    
    window.closeAddCoinModal = () => {
        const modal = document.getElementById('add-coin-modal');
        if (modal) modal.style.display = 'none';
    };
    
    function populateAddCoinModal() {
        const list = document.getElementById('coin-list-modal');
        if (!list || !window.allMarketCoins) return;
        const watchlist = getWatchlist();
        list.innerHTML = '';
        
        window.allMarketCoins.slice(0, 50).forEach(coin => {
            const isSelected = watchlist.includes(coin.symbol);
            const el = document.createElement('div');
            el.style.cssText = `padding:10px; background:${isSelected ? 'rgba(247,147,26,0.2)' : 'rgba(255,255,255,0.02)'}; border-radius:8px; display:flex; justify-content:space-between; align-items:center; cursor:pointer; border:1px solid ${isSelected ? '#f7931a' : 'rgba(255,255,255,0.1)'};`;
            el.onclick = () => { 
                if (isSelected) removeFromWatchlist(coin.symbol); 
                else addToWatchlist(coin.symbol);
                populateAddCoinModal(); 
            };
            el.innerHTML = `<div style="display:flex; align-items:center; gap:10px; flex:1;"><img src="https://assets.coincap.io/assets/icons/${coin.symbol.toLowerCase()}@2x.png" style="width:24px; height:24px;" onerror="this.src='https://img.icons8.com/clouds/24/000000/bitcoin.png'"><div><div style="color:#fff; font-weight:bold;">${coin.symbol}</div><div style="color:#999; font-size:11px;">$${parseFloat(coin.priceUsd).toLocaleString()}</div></div></div><div style="color:${isSelected ? '#f7931a' : '#999'}; font-size:18px;">${isSelected ? '✓' : ''}</div>`;
            list.appendChild(el);
        });
    }
    
    window.filterAddCoinModal = () => {
        const input = document.getElementById('coin-search-input');
        const query = input.value.toLowerCase();
        const items = document.querySelectorAll('#coin-list-modal > div');
        items.forEach(item => {
            const text = item.innerText.toLowerCase();
            item.style.display = text.includes(query) ? 'flex' : 'none';
        });
    };
    
    // Store populateAddCoinModal globally
    window.populateAddCoinModal = populateAddCoinModal;
})();

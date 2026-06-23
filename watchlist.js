// Watchlist Management Module
(function() {
    // توابع اصلی واچ‌لیست (اگر قبلاً در app.js تعریف شده‌اند، بازنویسی نمی‌کنیم)
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
                if (typeof window.renderMarketTabLists === 'function') window.renderMarketTabLists();
            }
        };
    }

    if (typeof window.removeFromWatchlist === 'undefined') {
        window.removeFromWatchlist = function(symbol) {
            let list = window.getWatchlist();
            list = list.filter(s => s !== symbol);
            localStorage.setItem('watchlist', JSON.stringify(list));
            if (typeof window.renderWatchlist === 'function') window.renderWatchlist();
            if (typeof window.renderMarketTabLists === 'function') window.renderMarketTabLists();
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
})();
// Watchlist Module - user-scoped helpers
(function() {
    if (typeof window.getWatchlist === 'undefined') {
        window.getWatchlist = function() {
            const userId = typeof window.getUserId === 'function' ? window.getUserId() : 'guest';
            const key = `watchlist_${userId}`;
            const scoped = localStorage.getItem(key);
            if (scoped) return JSON.parse(scoped);
            return JSON.parse(localStorage.getItem('watchlist') || '[]');
        };
    }
    if (typeof window.closeAddCoinModal === 'undefined') {
        window.closeAddCoinModal = function() {
            document.getElementById('add-coin-modal').style.display = 'none';
        };
    }
})();

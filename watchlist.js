// Watchlist Module - توابع کمکی
(function() {
    if (typeof window.getWatchlist === 'undefined') {
        window.getWatchlist = function() {
            return JSON.parse(localStorage.getItem('watchlist') || '[]');
        };
    }
    if (typeof window.closeAddCoinModal === 'undefined') {
        window.closeAddCoinModal = function() {
            document.getElementById('add-coin-modal').style.display = 'none';
        };
    }
})();

// Watchlist Module - فقط توابع کمکی
(function() {
    if (typeof window.getWatchlist === 'undefined') {
        window.getWatchlist = function() {
            return JSON.parse(localStorage.getItem('watchlist') || '[]');
        };
    }
    if (typeof window.populateAddCoinModal === 'undefined') {
        window.populateAddCoinModal = function() {
            // این تابع در app.js تعریف شده
        };
    }
    if (typeof window.filterAddCoinModal === 'undefined') {
        window.filterAddCoinModal = function() {
            const q = document.getElementById('coin-search-modal')?.value?.toLowerCase();
            document.querySelectorAll('.modal-coin-item').forEach(el => {
                el.style.display = el.innerText.toLowerCase().includes(q) ? 'flex' : 'none';
            });
        };
    }
    if (typeof window.closeAddCoinModal === 'undefined') {
        window.closeAddCoinModal = function() {
            document.getElementById('add-coin-modal').style.display = 'none';
        };
    }
})();
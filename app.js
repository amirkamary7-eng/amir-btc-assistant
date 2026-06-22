const tg = window.Telegram?.WebApp;
tg?.ready();
tg?.expand();

function showPage(pageId, btn) {
    document.querySelectorAll('.page').forEach(p => p.classList.remove('active'));
    document.getElementById(pageId).classList.add('active');
    if(btn) {
        document.querySelectorAll('.nav-item').forEach(i => i.classList.remove('active'));
        btn.classList.add('active');
    }
}

// لود کردن اطلاعات واقعی کاربر
function loadUserData() {
    const user = tg?.initDataUnsafe?.user;
    if (user) {
        const fullName = `${user.first_name || ""} ${user.last_name || ""}`.trim();
        document.getElementById('user-name').innerText = fullName;
        document.getElementById('dash-user-name').innerText = user.first_name || "کاربر";
        document.getElementById('user-username').innerText = user.username ? "@" + user.username : "بدون یوزرنیم";
        document.getElementById('user-id').innerText = user.id;
        document.getElementById('profile-img').src = `https://ui-avatars.com/api/?name=${user.first_name}&background=f7931a&color=fff&size=200`;
    } else {
        document.getElementById('user-name').innerText = "امیر کریپتو";
    }
}

// لود ویجت کانال شما
function loadAnalysis() {
    const container = document.getElementById('telegram-feed-container');
    container.innerHTML = `<script async src="https://telegram.org/js/telegram-widget.js?22" data-telegram-post="amir_btc_2024/1" data-width="100%"></script>`;
}

// لود شاخص‌ها
async function loadMetrics() {
    fetch('https://api.alternative.me/fng/').then(r => r.json()).then(data => {
        document.getElementById('fg-val').innerText = data.data[0].value;
    }).catch(() => {});
    document.getElementById('liq-val').innerText = "$" + (Math.random() * 150 + 50).toFixed(1) + "M";
}

document.addEventListener("DOMContentLoaded", () => {
    loadUserData();
    loadAnalysis();
    loadMetrics();
});
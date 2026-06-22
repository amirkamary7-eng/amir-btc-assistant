
async function loadPrices() {

    try {

        const btc = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT");
        const btcData = await btc.json();

        document.getElementById("btc").innerHTML =
            `₿ BTC: $${parseFloat(btcData.price).toLocaleString()}`;

        const eth = await fetch("https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT");
        const ethData = await eth.json();

        document.getElementById("eth").innerHTML =
            `Ξ ETH: $${parseFloat(ethData.price).toLocaleString()}`;

    } catch (err) {
        console.log("Price error", err);
    }
}

loadPrices();


// =====================
// PAGE SWITCH
// =====================
function showPage(pageId, element){

    document.querySelectorAll('.page').forEach(page=>{
        page.style.display='none';
    });

    document.getElementById(pageId).style.display='block';

    document.querySelectorAll('.nav-item').forEach(item=>{
        item.classList.remove('active');
    });

    if(element && element.classList.contains('nav-item')){
        element.classList.add('active');
    }
}


// =====================
// MARKET
// =====================
async function loadMarket() {

    const coins = ["BTCUSDT","ETHUSDT","SOLUSDT","BNBUSDT"];

    let html = "";

    for(const coin of coins){

        try {

            const response = await fetch(
                `https://api.binance.com/api/v3/ticker/price?symbol=${coin}`
            );

            const data = await response.json();

            html += `
            <div class="card">
                ${coin.replace("USDT","")}
                <br>
                $${Number(data.price).toLocaleString()}
            </div>`;

        } catch (e) {
            console.log("Market error", e);
        }
    }

    document.getElementById("market-list").innerHTML = html;
}

loadMarket();


// =====================
// TELEGRAM USER (FIXED)
// =====================
function loadTelegramUser() {

    const tg = window.Telegram?.WebApp;

    const nameEl = document.getElementById("user-name");
    const idEl = document.getElementById("user-id");
    const usernameEl = document.getElementById("user-username");
    const imgEl = document.getElementById("profile-img");

    if (!tg) {
        console.log("Not in Telegram WebApp");
        return;
    }

    tg.ready();
    tg.expand();

    const user = tg.initDataUnsafe?.user;

    console.log("Telegram User:", user);

    if (!user) {
        nameEl.innerText = "No Telegram User";
        return;
    }

    // NAME
    nameEl.innerText = user.first_name || "-";

    // ID
    idEl.innerText = user.id || "-";

    // USERNAME
    usernameEl.innerText = "@" + (user.username || "no_username");

    // AVATAR (FIXED)
    if (user.username) {
        imgEl.src = `https://t.me/i/userpic/320/${user.username}.jpg`;
    } else {
        imgEl.src = "default.png";
    }
}


// =====================
// INIT
// =====================
window.addEventListener("load", () => {

    loadTelegramUser();
    loadPrices();
    loadMarket();

});
async function loadPrices() {

    const btc = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=BTCUSDT"
    );

    const btcData = await btc.json();

    document.getElementById("btc").innerHTML =
        `₿ BTC: $${parseFloat(btcData.price).toLocaleString()}`;

    const eth = await fetch(
        "https://api.binance.com/api/v3/ticker/price?symbol=ETHUSDT"
    );

    const ethData = await eth.json();

    document.getElementById("eth").innerHTML =
        `Ξ ETH: $${parseFloat(ethData.price).toLocaleString()}`;
}

loadPrices();

function showPage(pageId, element){

    document.querySelectorAll('.page').forEach(page=>{
        page.style.display='none';
    });

    document.getElementById(pageId).style.display='block';

    document.querySelectorAll('.nav-item').forEach(item=>{
        item.classList.remove('active');
    });

    if(element.classList.contains('nav-item')){
        element.classList.add('active');
    }
}

async function loadMarket() {

    const coins = [
        "BTCUSDT",
        "ETHUSDT",
        "SOLUSDT",
        "BNBUSDT"
    ];

    let html = "";

    for(const coin of coins){

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
    }

    document.getElementById("market-list").innerHTML = html;
}

loadMarket();

function loadTelegramUser() {

    const nameEl = document.getElementById("user-name");
    const idEl = document.getElementById("user-id");
    const usernameEl = document.getElementById("user-username");

    if (!window.Telegram || !window.Telegram.WebApp) {
        nameEl.innerText = "Not in Telegram";
        idEl.innerText = "-";
        usernameEl.innerText = "-";
        return;
    }

    const tg = window.Telegram.WebApp;

    tg.ready();
    tg.expand();

    const user = tg.initDataUnsafe?.user;

    if (!user) {
        nameEl.innerText = "No User Data";
        return;
    }

    nameEl.innerText = user.first_name || "-";
    idEl.innerText = "ID: " + (user.id || "-");
    usernameEl.innerText = "@" + (user.username || "no_username");
}
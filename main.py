import os
import re
import time
import html
import json
import uuid
import asyncio
from pathlib import Path
from datetime import datetime, timezone
from typing import Optional

try:
    from dotenv import load_dotenv
    load_dotenv()
except ImportError:
    pass

import requests
import xml.etree.ElementTree as ET
from pydantic import BaseModel
from fastapi import FastAPI, Query, Request
from fastapi.middleware.cors import CORSMiddleware
from fastapi.responses import JSONResponse
from starlette.responses import Response
from deep_translator import GoogleTranslator

from backend.config import get_settings
from backend.database import database_ready, get_db_session, init_database
from backend.redis_client import init_redis, redis_ready
from backend.routers import users as users_router
from backend.routers import watchlist as watchlist_router
from backend.routers import charts as charts_router
from backend.routers import analyses as analyses_router
from backend.routers import calendar as calendar_router
from backend.routers import referrals as referrals_router
from backend.routers import sessions as sessions_router
from backend.routers import assistant as assistant_router
from backend.services.join_service import resolve_channel_membership, clear_cached_join_status
from backend.services.telegram_auth import validate_telegram_init_data
from backend.redis_client import cache_get_json, cache_set_json

# کتابخانه‌های ربات تلگرام
from telegram import Update, KeyboardButton, ReplyKeyboardMarkup, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# ==========================================
# ۱. تنظیمات و راه‌اندازی FastAPI
# ==========================================
app = FastAPI(title="Crypto Premium News & Bot Engine")

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)

app.include_router(users_router.router, prefix="/api")
app.include_router(watchlist_router.router, prefix="/api")
app.include_router(charts_router.router, prefix="/api")
app.include_router(analyses_router.router, prefix="/api")
app.include_router(calendar_router.router, prefix="/api")
app.include_router(referrals_router.router, prefix="/api")
app.include_router(sessions_router.router, prefix="/api")
app.include_router(assistant_router.router, prefix="/api")

# کش مرکزی اخبار
news_cache = {"data": None, "expiry": 0}
CACHE_TTL = 900  # ۱۵ دقیقه

telegram_app = None

# ==========================================
# ۲. مسیر ریشه برای تست سلامت سرور
# ==========================================
@app.get("/")
async def root():
    return {"status": "ok", "message": "Amir BTC Assistant Backend is running!"}

# ==========================================
# ۳. توابع بخش اخبار و ترجمه
# ==========================================
def clean_html(raw_html):
    if not raw_html: return ""
    clean_text = re.sub(r'<[^>]+>', '', raw_html)
    clean_text = html.unescape(clean_text)
    clean_text = re.sub(r'\s+', ' ', clean_text).strip()
    return clean_text[:150] + "..." if len(clean_text) > 150 else clean_text

def parse_relative_time(date_str):
    try:
        clean_date = date_str.split(" +")[0].split(" GMT")[0].strip()
        parsed_time = datetime.strptime(clean_date, "%a, %d %b %Y %H:%M:%S").replace(tzinfo=timezone.utc)
        now = datetime.now(timezone.utc)
        diff = now - parsed_time
        minutes = int(diff.total_seconds() / 60)
        if minutes < 1: return "همین الان"
        if minutes < 60: return f"{minutes} دقیقه پیش"
        hours = int(minutes / 60)
        if hours < 24: return f"{hours} ساعت پیش"
        return f"{int(hours / 24)} روز پیش"
    except Exception:
        return "اخیراً"

MOCK_NEWS = [{
    "title": "فورى: بیت‌کوین سقف مقاومتی جدید را شکست!",
    "description": "بازار ارزهای دیجیتال پس از ورود سرمایه‌گذاران سازمانی شاهد رشد شارپ فوق‌العاده‌ای در قیمت بیت‌کوین و اتریوم بوده است.",
    "time_ago": "۵ دقیقه پیش",
    "source": "کوین‌تلگراف",
    "image": "https://images.cryptocompare.com/news/default/bitcoin.png",
    "url": "https://cointelegraph.com"
}]

def fetch_raw_news_rss():
    headers = {"User-Agent": "Mozilla/5.0"}
    sources = [
        ("https://cointelegraph.com/rss", "کوین‌تلگراف"),
        ("https://www.coindesk.com/arc/outboundfeeds/rss/", "کوین‌دسک")
    ]
    for url, name in sources:
        try:
            res = requests.get(url, headers=headers, timeout=6)
            if res.status_code == 200 and "<item>" in res.text:
                return res.text, name
        except Exception as e:
            print(f"⚠️ منبع {name} در دسترس نبود: {e}")
    return None, None

@app.get("/api/farsi-news")
async def get_optimized_farsi_news():
    current_time = time.time()
    redis_cached = cache_get_json("news:farsi")
    if redis_cached:
        return JSONResponse(content={"status": "success", "source": "redis_cache", "data": redis_cached})

    if news_cache["data"] and current_time < news_cache["expiry"]:
        return JSONResponse(content={"status": "success", "source": "cache", "data": news_cache["data"]})

    rss_data, source_name = fetch_raw_news_rss()
    if not rss_data:
        if news_cache["data"]:
            return JSONResponse(content={"status": "success", "source": "expired_cache", "data": news_cache["data"]})
        return JSONResponse(content={"status": "success", "source": "mock_fallback", "data": MOCK_NEWS})

    try:
        root = ET.fromstring(rss_data)
        items = root.findall(".//item")[:6]
        optimized_articles = []
        translator = GoogleTranslator(source='en', target='fa')

        for item in items:
            title_en = item.find("title").text if item.find("title") is not None else ""
            url = item.find("link").text if item.find("link") is not None else ""
            desc_en = item.find("description").text if item.find("description") is not None else ""
            pub_date = item.find("pubDate").text if item.find("pubDate") is not None else ""

            clean_desc_en = clean_html(desc_en)
            image_url = "https://images.cryptocompare.com/news/default/bitcoin.png"
            img_match = re.search(r'src="([^"]+)"', desc_en)
            if img_match:
                image_url = img_match.group(1)

            try:
                translated_title = translator.translate(title_en) if title_en else "بدون عنوان"
                translated_desc = translator.translate(clean_desc_en) if clean_desc_en else ""
            except Exception as e:
                print(f"Translation error: {e}")
                translated_title = title_en
                translated_desc = clean_desc_en

            optimized_articles.append({
                "title": translated_title.replace("\n", " ").strip(),
                "description": translated_desc.replace("\n", " ").strip(),
                "time_ago": parse_relative_time(pub_date),
                "source": source_name,
                "image": image_url,
                "url": url
            })

        if optimized_articles:
            news_cache["data"] = optimized_articles
            news_cache["expiry"] = current_time + CACHE_TTL
            cache_set_json("news:farsi", optimized_articles, CACHE_TTL)
            return JSONResponse(content={"status": "success", "source": f"{source_name}_live", "data": optimized_articles})
    except ET.ParseError as e:
        print(f"XML Parse Error: {e}")
    except Exception as e:
        print(f"Unexpected error: {e}")

    return JSONResponse(content={"status": "success", "source": "mock_fallback", "data": MOCK_NEWS})

# ==========================================
# ۳.۵ سیستم تیکت و نوتیفیکیشن تلگرام
# ==========================================
ADMIN_TELEGRAM_ID = os.environ.get("ADMIN_TELEGRAM_ID", "831704732")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "REPLACE_WITH_TOKEN")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://amir-btc-assistant.vercel.app")
WEBHOOK_URL = os.environ.get(
    "TELEGRAM_WEBHOOK_URL",
    "https://amir-btc-assistant.onrender.com/telegram",
)
REQUIRED_CHANNEL = os.environ.get("REQUIRED_CHANNEL", "amir_btc_2024")
TICKETS_FILE = Path(__file__).parent / "data" / "tickets.json"

JOINED_STATUSES = {"creator", "administrator", "member", "restricted"}

class TicketCreate(BaseModel):
    user_id: str
    user_name: str
    title: str
    body: str

class TicketReply(BaseModel):
    admin_id: str
    message: str

class NotifyRequest(BaseModel):
    user_id: str
    message: str

def _ensure_tickets_file():
    TICKETS_FILE.parent.mkdir(exist_ok=True)
    if not TICKETS_FILE.exists():
        TICKETS_FILE.write_text("[]", encoding="utf-8")

def _read_tickets():
    _ensure_tickets_file()
    return json.loads(TICKETS_FILE.read_text(encoding="utf-8"))

def _write_tickets(tickets):
    _ensure_tickets_file()
    TICKETS_FILE.write_text(json.dumps(tickets, ensure_ascii=False, indent=2), encoding="utf-8")

def _send_telegram_http(chat_id: str, text: str) -> bool:
    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        return False
    try:
        res = requests.post(
            f"https://api.telegram.org/bot{TOKEN}/sendMessage",
            json={"chat_id": int(chat_id), "text": text},
            timeout=10,
        )
        if not res.ok:
            print(f"⚠️ Telegram HTTP {res.status_code}: {res.text}")
        return res.ok
    except Exception as e:
        print(f"⚠️ Telegram HTTP error: {e}")
        return False

def _normalize_webhook_url(url: str) -> str:
    from urllib.parse import urlparse, urlunparse

    parsed = urlparse(url.strip())
    path = re.sub(r"/+", "/", parsed.path or "/")
    if path != "/telegram":
        path = "/telegram"
    return urlunparse((parsed.scheme, parsed.netloc, path, "", "", ""))

def _set_telegram_webhook(url: str) -> bool:
    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        return False
    clean_url = _normalize_webhook_url(url)
    try:
        res = requests.post(
            f"https://api.telegram.org/bot{TOKEN}/setWebhook",
            json={"url": clean_url, "drop_pending_updates": True},
            timeout=15,
        )
        data = res.json()
        if data.get("ok"):
            print(f"✅ Telegram webhook set: {clean_url}")
            return True
        print(f"⚠️ setWebhook failed: {data.get('description', res.text)}")
    except Exception as e:
        print(f"⚠️ setWebhook error: {e}")
    return False

async def _send_telegram(chat_id: str, text: str) -> bool:
    global telegram_app
    if telegram_app and telegram_app.bot:
        try:
            await telegram_app.bot.send_message(chat_id=int(chat_id), text=text)
            return True
        except Exception as e:
            print(f"⚠️ Telegram SDK error: {e}")
    return _send_telegram_http(chat_id, text)

def _check_channel_membership(user_id: str) -> dict:
    if str(user_id).startswith("guest_"):
        return {"joined": False, "reason": "guest_user"}
    if str(user_id) == str(ADMIN_TELEGRAM_ID):
        return {"joined": True, "admin": True}
    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        return {"joined": False, "reason": "bot_not_configured"}
    try:
        res = requests.get(
            f"https://api.telegram.org/bot{TOKEN}/getChatMember",
            params={"chat_id": f"@{REQUIRED_CHANNEL}", "user_id": int(user_id)},
            timeout=10,
        )
        data = res.json()
        if not data.get("ok"):
            desc = data.get("description", "")
            print(f"⚠️ getChatMember failed for user {user_id}: {desc}")
            desc_lower = desc.lower()
            if "user not found" in desc_lower or "not a member" in desc_lower:
                return {"joined": False, "reason": "not_member"}
            if "chat not found" in desc_lower:
                return {"joined": False, "reason": "channel_not_found", "detail": desc}
            if "bot is not a member" in desc_lower or "need administrator" in desc_lower:
                return {"joined": False, "reason": "bot_not_in_channel", "detail": desc}
            return {"joined": False, "reason": "api_error", "detail": desc}
        status = data.get("result", {}).get("status", "")
        return {"joined": status in JOINED_STATUSES, "status": status}
    except Exception as e:
        print(f"⚠️ Channel check error: {e}")
        return {"joined": False, "reason": "api_error"}

@app.get("/api/health")
async def health_check():
    settings = get_settings()
    return {
        "status": "ok",
        "bot_configured": settings.bot_configured,
        "database_ready": database_ready(),
        "redis_ready": redis_ready(),
    }

def _resolve_user_id_from_request(user_id: str, init_data: Optional[str]) -> tuple[str, Optional[dict]]:
    """Prefer cryptographically verified Telegram user id when initData is present."""
    if not init_data:
        return str(user_id), None
    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        return str(user_id), None
    validated = validate_telegram_init_data(init_data, TOKEN)
    if not validated or not validated.get("id"):
        return str(user_id), {"status": "error", "joined": False, "reason": "invalid_init_data"}
    validated_id = str(validated["id"])
    if str(user_id) != validated_id:
        return validated_id, {"status": "error", "joined": False, "reason": "user_id_mismatch"}
    return validated_id, None


@app.get("/api/check-join")
async def check_join(
    request: Request,
    user_id: str = Query(...),
    refresh: bool = Query(False),
):
    init_data = request.headers.get("X-Telegram-Init-Data") or request.query_params.get("init_data")
    resolved_id, init_error = _resolve_user_id_from_request(user_id, init_data)
    if init_error:
        return init_error

    if refresh:
        clear_cached_join_status(resolved_id)

    if database_ready():
        with get_db_session() as db:
            result = resolve_channel_membership(
                resolved_id,
                _check_channel_membership,
                db=db,
                force_refresh=refresh,
            )
    else:
        result = resolve_channel_membership(
            resolved_id,
            _check_channel_membership,
            db=None,
            force_refresh=refresh,
        )
    return {"status": "success", **result}

@app.post("/api/tickets")
async def create_ticket(ticket: TicketCreate):
    tickets = _read_tickets()
    new_ticket = {
        "id": str(uuid.uuid4())[:8],
        "user_id": ticket.user_id,
        "user_name": ticket.user_name,
        "title": ticket.title,
        "body": ticket.body,
        "status": "open",
        "replies": [],
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    tickets.insert(0, new_ticket)
    _write_tickets(tickets)
    await _send_telegram(
        ADMIN_TELEGRAM_ID,
        f"🎫 تیکت جدید\nاز: {ticket.user_name} ({ticket.user_id})\nعنوان: {ticket.title}\n\n{ticket.body}"
    )
    if ticket.user_id and not str(ticket.user_id).startswith("guest_"):
        await _send_telegram(
            ticket.user_id,
            f"✅ تیکت شما ثبت شد\nعنوان: {ticket.title}\nبه زودی پاسخ داده می‌شود."
        )
    return {"status": "success", "ticket": new_ticket}

@app.get("/api/tickets")
async def get_user_tickets(user_id: str = Query(...)):
    user_tickets = [t for t in _read_tickets() if t["user_id"] == user_id]
    return {"status": "success", "tickets": user_tickets}

@app.get("/api/tickets/all")
async def get_all_tickets(admin_id: str = Query(...)):
    if str(admin_id) != str(ADMIN_TELEGRAM_ID):
        return JSONResponse(status_code=403, content={"status": "error", "message": "Unauthorized"})
    return {"status": "success", "tickets": _read_tickets()}

@app.post("/api/tickets/{ticket_id}/reply")
async def reply_ticket(ticket_id: str, reply: TicketReply):
    if str(reply.admin_id) != str(ADMIN_TELEGRAM_ID):
        return JSONResponse(status_code=403, content={"status": "error", "message": "Unauthorized"})
    tickets = _read_tickets()
    found = None
    for t in tickets:
        if t["id"] == ticket_id:
            found = t
            t.setdefault("replies", []).append({
                "message": reply.message,
                "from": "admin",
                "at": datetime.now(timezone.utc).isoformat(),
            })
            t["status"] = "answered"
            break
    if not found:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    _write_tickets(tickets)
    await _send_telegram(
        found["user_id"],
        f"💬 پاسخ تیکت: {found['title']}\n\n{reply.message}"
    )
    return {"status": "success", "ticket": found}

@app.delete("/api/tickets/{ticket_id}")
async def delete_ticket(
    ticket_id: str,
    user_id: Optional[str] = Query(None),
    admin_id: Optional[str] = Query(None),
):
    is_admin = admin_id and str(admin_id) == str(ADMIN_TELEGRAM_ID)
    tickets = _read_tickets()
    ticket = next((t for t in tickets if t["id"] == ticket_id), None)
    if not ticket:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    if not is_admin and ticket["user_id"] != user_id:
        return JSONResponse(status_code=403, content={"status": "error", "message": "Forbidden"})
    _write_tickets([t for t in tickets if t["id"] != ticket_id])
    return {"status": "success"}

@app.post("/api/notify")
async def notify_user(req: NotifyRequest):
    if str(req.user_id).startswith("guest_"):
        return {"status": "skipped", "sent": False, "reason": "guest_user"}
    sent = await _send_telegram(req.user_id, req.message)
    return {"status": "success" if sent else "skipped", "sent": sent}

# ==========================================
# ۳.۶ سیستم هشدار قیمت (سرور + پیام تلگرام)
# ==========================================
ALERTS_FILE = Path(__file__).parent / "data" / "alerts.json"

class AlertCreate(BaseModel):
    user_id: str
    symbol: str
    price: float
    direction: str = "above"

def _ensure_alerts_file():
    ALERTS_FILE.parent.mkdir(exist_ok=True)
    if not ALERTS_FILE.exists():
        ALERTS_FILE.write_text("[]", encoding="utf-8")

def _read_alerts():
    _ensure_alerts_file()
    return json.loads(ALERTS_FILE.read_text(encoding="utf-8"))

def _write_alerts(alerts):
    _ensure_alerts_file()
    ALERTS_FILE.write_text(json.dumps(alerts, ensure_ascii=False, indent=2), encoding="utf-8")

@app.post("/api/alerts")
async def create_alert(alert: AlertCreate):
    alerts = _read_alerts()
    new_alert = {
        "id": str(uuid.uuid4())[:8],
        "user_id": alert.user_id,
        "symbol": alert.symbol.upper(),
        "price": alert.price,
        "direction": alert.direction or "above",
        "created_at": datetime.now(timezone.utc).isoformat(),
    }
    alerts = [a for a in alerts if not (
        a["user_id"] == new_alert["user_id"]
        and a["symbol"] == new_alert["symbol"]
        and float(a["price"]) == float(new_alert["price"])
    )]
    alerts.insert(0, new_alert)
    _write_alerts(alerts)
    if alert.user_id and not str(alert.user_id).startswith("guest_"):
        await _send_telegram(
            alert.user_id,
            f"🔔 هشدار قیمت ثبت شد\n{new_alert['symbol']} — هدف: ${new_alert['price']}"
        )
    return {"status": "success", "alert": new_alert}

@app.get("/api/alerts")
async def get_user_alerts(user_id: str = Query(...)):
    user_alerts = [a for a in _read_alerts() if a["user_id"] == user_id]
    return {"status": "success", "alerts": user_alerts}

@app.delete("/api/alerts/{alert_id}")
async def delete_alert(alert_id: str, user_id: str = Query(...)):
    alerts = _read_alerts()
    alert = next((a for a in alerts if a["id"] == alert_id), None)
    if not alert:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    if alert["user_id"] != user_id:
        return JSONResponse(status_code=403, content={"status": "error", "message": "Forbidden"})
    _write_alerts([a for a in alerts if a["id"] != alert_id])
    return {"status": "success"}

async def _check_price_alerts_once():
    alerts = _read_alerts()
    if not alerts:
        return
    try:
        res = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={"vs_currency": "usd", "order": "market_cap_desc", "per_page": 250, "page": 1, "sparkline": "false"},
            timeout=12,
        )
        if not res.ok:
            print(f"⚠️ Alert price fetch failed: HTTP {res.status_code}")
            return
        price_map = {item["symbol"].upper(): float(item["current_price"]) for item in res.json()}
        remaining = []
        for alert in alerts:
            sym = alert["symbol"].upper()
            current = price_map.get(sym)
            if current is None:
                remaining.append(alert)
                continue
            direction = alert.get("direction", "above")
            triggered = (direction == "above" and current >= float(alert["price"])) or (
                direction == "below" and current <= float(alert["price"])
            )
            if triggered:
                uid = alert["user_id"]
                msg = f"🔔 {sym} Price reached ${current:.4f}"
                if uid and not str(uid).startswith("guest_"):
                    await _send_telegram(uid, msg)
                await _send_telegram(ADMIN_TELEGRAM_ID, f"📊 هشدار فعال شد\n{msg}\nکاربر: {uid}")
            else:
                remaining.append(alert)
        _write_alerts(remaining)
    except Exception as e:
        print(f"⚠️ Alert check error: {e}")

async def alert_polling_loop():
    await asyncio.sleep(5)
    while True:
        await _check_price_alerts_once()
        await asyncio.sleep(20)

# ==========================================
# ۴. تنظیمات و توابع ربات تلگرام (در صورت نیاز)
# ==========================================
if TOKEN == "REPLACE_WITH_TOKEN":
    print("⚠️ WARNING: TELEGRAM_BOT_TOKEN not set in environment. Telegram bot will not start until configured.")

async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    keyboard = [[
        KeyboardButton(
            text="🚀 Open App",
            web_app=WebAppInfo(url=WEBAPP_URL)
        )
    ]]
    await update.message.reply_text(
        "به Amir BTC Assistant خوش آمدی",
        reply_markup=ReplyKeyboardMarkup(
            keyboard,
            resize_keyboard=True
        )
    )

@app.post("/telegram")
async def telegram_webhook(request: Request):
    print("update received from telegram")
    if telegram_app and telegram_app.bot:
        try:
            data = await request.json()
            update = Update.de_json(data, telegram_app.bot)
            await telegram_app.process_update(update)
        except Exception as e:
            print(f"⚠️ Telegram webhook processing error: {e}")
    return Response(status_code=200)

@app.on_event("startup")
async def startup_event():
    global telegram_app
    init_database()
    init_redis()
    asyncio.create_task(alert_polling_loop())
    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        print("ℹ️ Telegram token not configured; alert polling active, webhook skipped.")
        return

    telegram_app = ApplicationBuilder().token(TOKEN).build()
    telegram_app.add_handler(CommandHandler("start", start))

    await telegram_app.initialize()
    await telegram_app.start()
    _set_telegram_webhook(WEBHOOK_URL)
    print("🚀 Telegram bot ready (webhook mode)")

@app.on_event("shutdown")
async def shutdown_event():
    global telegram_app
    if telegram_app:
        try:
            await telegram_app.stop()
            await telegram_app.shutdown()
        except Exception:
            pass
        print("🔌 ربات تلگرام متوقف شد.")

# ==========================================
# ۵. اجرای نهایی سرور
# ==========================================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)
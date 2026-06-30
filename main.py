# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `main.py` را نگه می‌دارد.
# ============================================================================
import os
import re
import time
import html
import json
import uuid
import hmac
import asyncio
from contextlib import asynccontextmanager
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
from backend.services.join_service import (
    invalidate_join_cache as invalidate_join_cache_entry,
    resolve_channel_membership,
)
from backend.services.user_service import get_user
from backend.services.telegram_auth import (
    get_authenticated_telegram_user,
    get_authenticated_telegram_user_id,
    is_admin_telegram_id,
    verify_admin_telegram_auth as _verify_admin_telegram_auth,
    verify_telegram_auth as _verify_telegram_auth,
)
from backend.redis_client import cache_get_json, cache_set_json

# کتابخانه‌های ربات تلگرام
from telegram import InlineKeyboardButton, InlineKeyboardMarkup, Update, WebAppInfo
from telegram.ext import ApplicationBuilder, CommandHandler, ContextTypes

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
telegram_app = None
alert_polling_task = None

@asynccontextmanager

# چرخه حیات برنامه FastAPI را برای راه‌اندازی و خاموش‌سازی سرویس‌ها مدیریت می‌کند.
# ورودی: پارامترهای `app: FastAPI` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
async def lifespan(app: FastAPI):
    global telegram_app, alert_polling_task

    print("🚀 Starting application...")
    try:
        init_database()
        init_redis()

        if _is_alert_polling_loop_enabled():
            if alert_polling_task is None or alert_polling_task.done():
                alert_polling_task = asyncio.create_task(alert_polling_loop())
        else:
            print(f"ℹ️ Alert polling loop skipped; mode={ALERTS_POLLING_MODE}")

        settings = get_settings()
        if settings.bot_configured:
            telegram_app = ApplicationBuilder().token(TOKEN).build()
            telegram_app.add_handler(CommandHandler("start", start))

            await telegram_app.initialize()
            await telegram_app.start()
            _set_telegram_webhook(WEBHOOK_URL)
            print("✅ Telegram bot ready (webhook mode)")
        else:
            print("ℹ️ Telegram bot startup skipped; token is not configured.")
    except Exception as e:
        print(f"⚠️ Startup failed: {e}")

    try:
        yield
    finally:
        print("🛑 Shutting down...")

        if alert_polling_task is not None:
            alert_polling_task.cancel()
            try:
                await alert_polling_task
            except asyncio.CancelledError:
                pass
            finally:
                alert_polling_task = None

        if telegram_app:
            try:
                await telegram_app.stop()
                await telegram_app.shutdown()
            except Exception as e:
                print(f"⚠️ Telegram shutdown error: {e}")
            finally:
                telegram_app = None

app = FastAPI(title="Crypto Premium News & Bot Engine", lifespan=lifespan)

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


# دکوراتور احراز هویت تلگرام را روی endpoint هدف اعمال می‌کند.
# ورودی: پارامترهای `func` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def verify_telegram_auth(func):
    return _verify_telegram_auth(func)


# دکوراتور احراز هویت مدیر تلگرام را روی endpoint هدف اعمال می‌کند.
# ورودی: پارامترهای `func` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def verify_admin_telegram_auth(func):
    return _verify_admin_telegram_auth(func)

# ==========================================
# ۲. مسیر ریشه برای تست سلامت سرور
# ==========================================

# عملیات مربوط به root را انجام می‌دهد.
# عملیات مربوط به ریشه را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/")
async def root():
    return {"status": "ok", "message": "Amir BTC Assistant Backend is running!"}

# ==========================================
# ۳. توابع بخش اخبار و ترجمه
# ==========================================

# عملیات مربوط به clean html را انجام می‌دهد.
# ورودی: پارامترهای `raw_html` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def clean_html(raw_html):
    if not raw_html: return ""
    clean_text = re.sub(r'<[^>]+>', '', raw_html)
    clean_text = html.unescape(clean_text)
    clean_text = re.sub(r'\s+', ' ', clean_text).strip()
    return clean_text[:150] + "..." if len(clean_text) > 150 else clean_text

# داده تجزیه relative time را تجزیه و آماده استفاده می‌کند.
# ورودی: پارامترهای `date_str` را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
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

# دریافت خام اخبار rss را از منبع داده دریافت می‌کند.
# ورودی: بدون ورودی.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
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


# مقدار optimized فارسی اخبار را بازیابی می‌کند.
# مقدار optimized farsi اخبار را بازیابی می‌کند.
# ورودی: بدون ورودی.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
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
ALERTS_POLLING_MODE = os.environ.get("ALERTS_POLLING_MODE", "loop").strip().lower()
ALERTS_CRON_SHARED_SECRET = os.environ.get("ALERTS_CRON_SHARED_SECRET", "").strip()
TICKETS_FILE = Path(__file__).parent / "data" / "tickets.json"

JOINED_STATUSES = {"creator", "administrator", "member", "restricted"}


def _is_alert_polling_loop_enabled() -> bool:
    return ALERTS_POLLING_MODE == "loop"


def _is_valid_alerts_cron_secret(secret_value: str) -> bool:
    if not ALERTS_CRON_SHARED_SECRET:
        return False
    return hmac.compare_digest(str(secret_value or ""), ALERTS_CRON_SHARED_SECRET)


# TicketCreate ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class TicketCreate(BaseModel):
    user_id: str
    user_name: str
    title: str
    body: str

# TicketReply ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class TicketReply(BaseModel):
    admin_id: str
    message: str

# NotifyRequest ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class NotifyRequest(BaseModel):
    user_id: str
    message: str


# عملیات مربوط به ensure تیکت‌ها فایل را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def _ensure_tickets_file():
    TICKETS_FILE.parent.mkdir(exist_ok=True)
    if not TICKETS_FILE.exists():
        TICKETS_FILE.write_text("[]", encoding="utf-8")

# عملیات مربوط به خواندن تیکت‌ها را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def _read_tickets():
    _ensure_tickets_file()
    return json.loads(TICKETS_FILE.read_text(encoding="utf-8"))

# عملیات مربوط به نوشتن تیکت‌ها را انجام می‌دهد.
# ورودی: پارامترهای `tickets` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
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

def _normalize_required_channel(raw: str) -> str:
    value = str(raw or "").strip()
    if not value:
        return ""
    value = value.split("?", 1)[0].strip()
    if value.startswith("https://") or value.startswith("http://"):
        parts = value.split("t.me/", 1)
        if len(parts) == 2:
            value = parts[1]
        else:
            value = value.rsplit("/", 1)[-1]
    value = value.strip().lstrip("@").strip()
    value = value.split("/", 1)[0].strip()
    return value

def _run_get_chat_member_debug(user_id: str) -> dict:
    uid = str(user_id)
    normalized_channel = _normalize_required_channel(REQUIRED_CHANNEL)
    chat_id = f"@{normalized_channel}" if normalized_channel else f"@{REQUIRED_CHANNEL}"
    debug_payload = {
        "required_channel": REQUIRED_CHANNEL,
        "chat_id": chat_id,
        "user_id": uid,
        "telegram_response": None,
        "joined": False,
    }

    print(f"🔎 Join Debug | REQUIRED_CHANNEL={REQUIRED_CHANNEL!r}")
    print(f"🔎 Join Debug | REQUIRED_CHANNEL_NORMALIZED={normalized_channel!r}")
    print(f"🔎 Join Debug | chat_id={chat_id!r}")
    print(f"🔎 Join Debug | user_id={uid!r}")

    if uid.startswith("guest_"):
        debug_payload["telegram_response"] = {"reason": "guest_user"}
        print("🔎 Join Debug | skipped getChatMember for guest user")
        print("🔎 Join Debug | final joined=False")
        return debug_payload

    if uid == str(ADMIN_TELEGRAM_ID):
        debug_payload["telegram_response"] = {"admin": True, "reason": "admin_bypass"}
        debug_payload["joined"] = True
        print("🔎 Join Debug | admin bypass applied")
        print("🔎 Join Debug | final joined=True")
        return debug_payload

    if not TOKEN or TOKEN == "REPLACE_WITH_TOKEN":
        debug_payload["telegram_response"] = {"reason": "bot_not_configured"}
        print("🔎 Join Debug | bot token is not configured")
        print("🔎 Join Debug | final joined=False")
        return debug_payload

    if not uid.isdigit():
        debug_payload["telegram_response"] = {"reason": "invalid_user_id", "value": uid}
        print(f"⚠️ Join Debug | invalid user_id value={uid!r}")
        print("🔎 Join Debug | final joined=False")
        return debug_payload

    try:
        response = requests.get(
            f"https://api.telegram.org/bot{TOKEN}/getChatMember",
            params={"chat_id": chat_id, "user_id": int(uid)},
            timeout=10,
        )
        response.raise_for_status()
        telegram_response = response.json()
        debug_payload["telegram_response"] = telegram_response
        status = telegram_response.get("result", {}).get("status", "")
        debug_payload["joined"] = bool(
            telegram_response.get("ok") and status in JOINED_STATUSES
        )
        print(f"🔎 Join Debug | Telegram response={json.dumps(telegram_response, ensure_ascii=False)}")
        print(f"🔎 Join Debug | final joined={debug_payload['joined']}")
        return debug_payload
    except requests.HTTPError as exc:
        response_text = exc.response.text if exc.response is not None else str(exc)
        debug_payload["telegram_response"] = {
            "http_error": str(exc),
            "response_text": response_text,
        }
        print(f"⚠️ Join Debug | HTTPError: {exc}")
        print(f"⚠️ Join Debug | HTTPError response: {response_text}")
    except Exception as exc:
        debug_payload["telegram_response"] = {
            "exception": exc.__class__.__name__,
            "message": str(exc),
        }
        print(f"⚠️ Join Debug | Exception: {exc.__class__.__name__}: {exc}")

    print("🔎 Join Debug | final joined=False")
    return debug_payload

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
    debug_payload = _run_get_chat_member_debug(user_id)
    telegram_response = debug_payload.get("telegram_response")

    if isinstance(telegram_response, dict):
        if telegram_response.get("reason") == "guest_user":
            return {"joined": False, "reason": "guest_user"}
        if telegram_response.get("reason") == "admin_bypass":
            return {"joined": True, "admin": True}
        if telegram_response.get("reason") == "bot_not_configured":
            return {"joined": False, "reason": "bot_not_configured"}
        if telegram_response.get("ok"):
            status = telegram_response.get("result", {}).get("status", "")
            return {"joined": status in JOINED_STATUSES, "status": status}

        desc = str(telegram_response.get("description", ""))
        desc_lower = desc.lower()
        if "user not found" in desc_lower or "not a member" in desc_lower:
            return {"joined": False, "reason": "not_member", "detail": desc}
        if "chat not found" in desc_lower:
            return {"joined": False, "reason": "channel_not_found", "detail": desc}
        if "bot is not a member" in desc_lower or "need administrator" in desc_lower:
            return {"joined": False, "reason": "bot_not_in_channel", "detail": desc}
        if telegram_response.get("http_error") or telegram_response.get("exception"):
            return {"joined": False, "reason": "api_error", "detail": json.dumps(telegram_response, ensure_ascii=False)}
        return {"joined": False, "reason": "api_error", "detail": desc}

    return {"joined": False, "reason": "api_error"}


# عملیات مربوط به health check را انجام می‌دهد.
# عملیات مربوط به سلامت بررسی را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/health")
async def health_check():
    settings = get_settings()
    return {
        "status": "ok",
        "bot_configured": settings.bot_configured,
        "database_ready": database_ready(),
        "redis_ready": redis_ready(),
    }

@app.get("/api/check-join")
@verify_telegram_auth
async def check_join(
    request: Request,
    user_id: Optional[str] = Query(None),
    refresh: bool = Query(False),
):
    resolved_id = get_authenticated_telegram_user_id(request)
    print(
        f"🔎 Join Debug | /api/check-join request incoming "
        f"user_id_query={user_id!r} resolved_id={resolved_id!r} refresh={refresh}"
    )

    if refresh:
        invalidate_join_cache_entry(resolved_id)

    try:
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
    except Exception as exc:
        print(f"⚠️ check-join error: {exc}")
        return {
            "status": "DB_ERROR",
            "joined": False,
            "reason": "database_unavailable",
            "detail": str(exc),
        }

    if result.get("status") == "DB_ERROR":
        print(f"🔎 Join Debug | /api/check-join final result={json.dumps(result, ensure_ascii=False)}")
        return result
    final_result = {"status": "success", **result}
    print(f"🔎 Join Debug | /api/check-join final result={json.dumps(final_result, ensure_ascii=False)}")
    return final_result

# عملیات مربوط به debug بررسی عضویت را انجام می‌دهد.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/debug/check-join")
@verify_telegram_auth
async def debug_check_join(request: Request, user_id: Optional[str] = Query(None)):
    resolved_id = get_authenticated_telegram_user_id(request)
    print(
        f"🔎 Join Debug | /api/debug/check-join request incoming "
        f"user_id_query={user_id!r} resolved_id={resolved_id!r}"
    )
    debug_payload = _run_get_chat_member_debug(resolved_id)
    response = {
        "required_channel": debug_payload["required_channel"],
        "user_id": resolved_id,
        "telegram_response": debug_payload["telegram_response"],
        "joined": debug_payload["joined"],
    }
    print(f"🔎 Join Debug | /api/debug/check-join response={json.dumps(response, ensure_ascii=False)}")
    return response

# عملیات مربوط به invalidate عضویت کش را انجام می‌دهد.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/check-join/invalidate")
@verify_telegram_auth
async def invalidate_join_cache(request: Request, user_id: Optional[str] = Query(None)):
    resolved_id = get_authenticated_telegram_user_id(request)
    invalidated = invalidate_join_cache_entry(resolved_id)
    return {"status": "success", "invalidated": invalidated, "user_id": resolved_id}

# تیکت را ایجاد می‌کند.
# ایجاد تیکت را ایجاد می‌کند.
# ورودی: پارامترهای `ticket: TicketCreate, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/tickets")
@verify_telegram_auth
async def create_ticket(ticket: TicketCreate, request: Request):
    telegram_user = get_authenticated_telegram_user(request)
    resolved_user_id = str(telegram_user["id"])
    full_name = " ".join(
        part for part in [telegram_user.get("first_name"), telegram_user.get("last_name")] if part
    ).strip()
    display_name = telegram_user.get("username") or full_name or ticket.user_name or resolved_user_id
    tickets = _read_tickets()
    new_ticket = {
        "id": str(uuid.uuid4())[:8],
        "user_id": resolved_user_id,
        "user_name": display_name,
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
        f"🎫 تیکت جدید\nاز: {display_name} ({resolved_user_id})\nعنوان: {ticket.title}\n\n{ticket.body}"
    )
    await _send_telegram(
        resolved_user_id,
        f"✅ تیکت شما ثبت شد\nعنوان: {ticket.title}\nبه زودی پاسخ داده می‌شود."
    )
    return {"status": "success", "ticket": new_ticket}

# مقدار کاربر تیکت‌ها را بازیابی می‌کند.
# مقدار کاربر تیکت‌ها را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/tickets")
@verify_telegram_auth
async def get_user_tickets(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    user_tickets = [t for t in _read_tickets() if t["user_id"] == resolved_user_id]
    return {"status": "success", "tickets": user_tickets}

# مقدار all تیکت‌ها را بازیابی می‌کند.
# مقدار all تیکت‌ها را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, admin_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/tickets/all")
@verify_admin_telegram_auth
async def get_all_tickets(request: Request, admin_id: Optional[str] = Query(None)):
    return {"status": "success", "tickets": _read_tickets()}

# عملیات مربوط به پاسخ تیکت را انجام می‌دهد.
# عملیات مربوط به reply تیکت را انجام می‌دهد.
# ورودی: پارامترهای `ticket_id: str, reply: TicketReply, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/tickets/{ticket_id}/reply")
@verify_admin_telegram_auth
async def reply_ticket(ticket_id: str, reply: TicketReply, request: Request):
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
@verify_telegram_auth
async def delete_ticket(
    request: Request,
    ticket_id: str,
    user_id: Optional[str] = Query(None),
    admin_id: Optional[str] = Query(None),
):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    is_admin = is_admin_telegram_id(resolved_user_id)
    tickets = _read_tickets()
    ticket = next((t for t in tickets if t["id"] == ticket_id), None)
    if not ticket:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    if not is_admin and ticket["user_id"] != resolved_user_id:
        return JSONResponse(status_code=403, content={"status": "error", "message": "Forbidden"})
    _write_tickets([t for t in tickets if t["id"] != ticket_id])
    return {"status": "success"}

# عملیات مربوط به اعلان کاربر را انجام می‌دهد.
# عملیات مربوط به اعلان کاربر را انجام می‌دهد.
# ورودی: پارامترهای `req: NotifyRequest, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/notify")
@verify_telegram_auth
async def notify_user(req: NotifyRequest, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    sent = await _send_telegram(resolved_user_id, req.message)
    return {"status": "success" if sent else "skipped", "sent": sent}

# ==========================================
# ۳.۶ سیستم هشدار قیمت (سرور + پیام تلگرام)
# ==========================================
ALERTS_FILE = Path(__file__).parent / "data" / "alerts.json"


# AlertCreate ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class AlertCreate(BaseModel):
    user_id: str
    symbol: str
    price: float
    direction: str = "above"


# عملیات مربوط به ensure هشدارها فایل را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def _ensure_alerts_file():
    ALERTS_FILE.parent.mkdir(exist_ok=True)
    if not ALERTS_FILE.exists():
        ALERTS_FILE.write_text("[]", encoding="utf-8")

# عملیات مربوط به خواندن هشدارها را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def _read_alerts():
    _ensure_alerts_file()
    return json.loads(ALERTS_FILE.read_text(encoding="utf-8"))

# عملیات مربوط به نوشتن هشدارها را انجام می‌دهد.
# ورودی: پارامترهای `alerts` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def _write_alerts(alerts):
    _ensure_alerts_file()
    ALERTS_FILE.write_text(json.dumps(alerts, ensure_ascii=False, indent=2), encoding="utf-8")


# هشدار را ایجاد می‌کند.
# ایجاد هشدار را ایجاد می‌کند.
# ورودی: پارامترهای `alert: AlertCreate, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/alerts")
@verify_telegram_auth
async def create_alert(alert: AlertCreate, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    alerts = _read_alerts()
    new_alert = {
        "id": str(uuid.uuid4())[:8],
        "user_id": resolved_user_id,
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
    await _send_telegram(
        resolved_user_id,
        f"🔔 هشدار قیمت ثبت شد\n{new_alert['symbol']} — هدف: ${new_alert['price']}"
    )
    return {"status": "success", "alert": new_alert}

# مقدار کاربر هشدارها را بازیابی می‌کند.
# مقدار کاربر هشدارها را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/alerts")
@verify_telegram_auth
async def get_user_alerts(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    user_alerts = [a for a in _read_alerts() if a["user_id"] == resolved_user_id]
    return {"status": "success", "alerts": user_alerts}

# هشدار را حذف می‌کند.
# حذف هشدار را حذف می‌کند.
# ورودی: پارامترهای `request: Request, alert_id: str, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.delete("/api/alerts/{alert_id}")
@verify_telegram_auth
async def delete_alert(request: Request, alert_id: str, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    alerts = _read_alerts()
    alert = next((a for a in alerts if a["id"] == alert_id), None)
    if not alert:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    if alert["user_id"] != resolved_user_id:
        return JSONResponse(status_code=403, content={"status": "error", "message": "Forbidden"})
    _write_alerts([a for a in alerts if a["id"] != alert_id])
    return {"status": "success"}


# عملیات مربوط به اجرای داخلی هشدارهای زمان‌بندی‌شده را انجام می‌دهد.
# ورودی: پارامتر `request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/internal/alerts/run")
async def run_internal_alerts(request: Request):
    if not ALERTS_CRON_SHARED_SECRET:
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": "ALERTS_CRON_SHARED_SECRET is not configured"},
        )

    provided_secret = request.headers.get("X-Alerts-Cron-Secret", "")
    if not _is_valid_alerts_cron_secret(provided_secret):
        return JSONResponse(
            status_code=403,
            content={"status": "error", "message": "Forbidden"},
        )

    result = await _check_price_alerts_once()
    status_code = 200 if result.get("status") == "success" else 500
    return JSONResponse(status_code=status_code, content=result)


# عملیات مربوط به بررسی قیمت هشدارها once را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
async def _check_price_alerts_once():
    alerts = _read_alerts()
    summary = {
        "status": "success",
        "checked_count": len(alerts),
        "triggered_count": 0,
        "remaining_count": len(alerts),
        "fetched_symbol_count": 0,
    }
    if not alerts:
        return summary
    try:
        res = requests.get(
            "https://api.coingecko.com/api/v3/coins/markets",
            params={"vs_currency": "usd", "order": "market_cap_desc", "per_page": 250, "page": 1, "sparkline": "false"},
            timeout=12,
        )
        if not res.ok:
            print(f"⚠️ Alert price fetch failed: HTTP {res.status_code}")
            summary["status"] = "error"
            summary["message"] = f"Alert price fetch failed: HTTP {res.status_code}"
            return summary
        price_map = {item["symbol"].upper(): float(item["current_price"]) for item in res.json()}
        summary["fetched_symbol_count"] = len(price_map)
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
                summary["triggered_count"] += 1
                if uid and not str(uid).startswith("guest_"):
                    await _send_telegram(uid, msg)
                await _send_telegram(ADMIN_TELEGRAM_ID, f"📊 هشدار فعال شد\n{msg}\nکاربر: {uid}")
            else:
                remaining.append(alert)
        _write_alerts(remaining)
        summary["remaining_count"] = len(remaining)
        return summary
    except Exception as e:
        print(f"⚠️ Alert check error: {e}")
        summary["status"] = "error"
        summary["message"] = str(e)
        return summary

# عملیات مربوط به هشدار polling loop را انجام می‌دهد.
# ورودی: بدون ورودی.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
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


# وضعیت عضویت کاربر را برای فلوی `/start` با fallback کامل resolve می‌کند.
# ورودی: پارامتر `user_id: int | str` شناسه تلگرام کاربر را دریافت می‌کند.
# خروجی: مقدار بولی نهایی عضویت کاربر را برمی‌گرداند.
def _resolve_start_membership(user_id: int | str) -> bool:
    uid = str(user_id)
    try:
        if database_ready():
            with get_db_session() as db:
                result = resolve_channel_membership(uid, _check_channel_membership, db=db)
        else:
            result = resolve_channel_membership(uid, _check_channel_membership, db=None)
        print(f"🔎 Start Debug | user_id={uid!r} result={json.dumps(result, ensure_ascii=False)}")
        return bool(result.get("joined"))
    except Exception as exc:
        print(f"⚠️ start membership resolve error: {exc}")
        return False

# عملیات مربوط به شروع را انجام می‌دهد.
# ورودی: پارامترهای `update: Update, context: ContextTypes.DEFAULT_TYPE` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
async def start(update: Update, context: ContextTypes.DEFAULT_TYPE):
    if not update.message or not update.effective_user:
        return

    user_id = update.effective_user.id
    is_member = _resolve_start_membership(user_id)

    if not is_member:
        keyboard = [[
            InlineKeyboardButton(
                "عضویت در کانال",
                url=f"https://t.me/{_normalize_required_channel(REQUIRED_CHANNEL)}",
            )
        ]]
        await update.message.reply_text(
            "⚠️ برای استفاده از ربات، ابتدا باید در کانال ما عضو شوید.",
            reply_markup=InlineKeyboardMarkup(keyboard),
            disable_web_page_preview=True,
        )
        return

    keyboard = [[
        InlineKeyboardButton(
            "🚀 باز کردن مینی‌اپ",
            web_app=WebAppInfo(url=WEBAPP_URL),
        )
    ]]
    await update.message.reply_text(
        "خوش آمدید! دستیار هوشمند آماده خدمت‌رسانی است.",
        reply_markup=InlineKeyboardMarkup(keyboard),
    )


# عملیات مربوط به تلگرام وبهوک را انجام می‌دهد.
# عملیات مربوط به تلگرام وبهوک را انجام می‌دهد.
# ورودی: پارامترهای `request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
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


# ==========================================
# ۵. اجرای نهایی سرور
# ==========================================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)

# endregion

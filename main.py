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
from backend.models import PriceAlert as DbPriceAlert
from backend.models import Ticket as DbTicket
from backend.models import TicketReply as DbTicketReply
from backend.models import User as DbUser
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
from backend.services.telegram_auth import (
    get_authenticated_telegram_user,
    get_authenticated_telegram_user_id,
    is_admin_telegram_id,
    verify_admin_telegram_auth as _verify_admin_telegram_auth,
    verify_telegram_auth as _verify_telegram_auth,
)
from backend.redis_client import cache_get_json, cache_set_json

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
alert_polling_task = None

@asynccontextmanager

# چرخه حیات برنامه FastAPI را برای راه‌اندازی و خاموش‌سازی سرویس‌ها مدیریت می‌کند.
# ورودی: پارامترهای `app: FastAPI` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
async def lifespan(app: FastAPI):
    global alert_polling_task

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
            print("ℹ️ Telegram webhook runtime is handled by Worker; backend bot startup is disabled.")
        else:
            print("ℹ️ Telegram outgoing notifications are skipped; token is not configured.")
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
        return JSONResponse(content={"status": "success", "source": "rss_unavailable", "data": []})

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

    return JSONResponse(content={"status": "success", "source": "rss_unavailable", "data": []})

# ==========================================
# ۳.۵ سیستم تیکت و نوتیفیکیشن تلگرام
# ==========================================
ADMIN_TELEGRAM_ID = os.environ.get("ADMIN_TELEGRAM_ID", "831704732")
TOKEN = os.environ.get("TELEGRAM_BOT_TOKEN", "REPLACE_WITH_TOKEN")
WEBAPP_URL = os.environ.get("WEBAPP_URL", "https://amir-btc-assistant.vercel.app")
REQUIRED_CHANNEL = os.environ.get("REQUIRED_CHANNEL", "amir_btc_2024")
ALERTS_POLLING_MODE = os.environ.get("ALERTS_POLLING_MODE", "loop").strip().lower()
ALERTS_CRON_SHARED_SECRET = os.environ.get("ALERTS_CRON_SHARED_SECRET", "").strip()

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


def _ensure_db_user(db, user_id: str, user_name: Optional[str] = None):
    user = db.get(DbUser, str(user_id))
    if user is None:
        now = datetime.now(timezone.utc)
        user = DbUser(
            telegram_id=str(user_id),
            first_name=user_name or None,
            lang="fa",
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        db.flush()
    elif user_name and not user.first_name:
        user.first_name = user_name
        user.updated_at = datetime.now(timezone.utc)
        db.flush()
    return user


def _serialize_ticket_reply(reply: DbTicketReply) -> dict:
    sender_type = str(reply.sender_type or "user").strip().lower()
    return {
        "message": reply.message,
        "from": "admin" if sender_type == "admin" else "user",
        "at": reply.created_at.isoformat() if reply.created_at else None,
    }


def _serialize_ticket(ticket: DbTicket) -> dict:
    replies = []
    if getattr(ticket, "replies", None):
        replies = [_serialize_ticket_reply(reply) for reply in ticket.replies]
    return {
        "id": ticket.id,
        "user_id": ticket.user_id,
        "user_name": ticket.user_name,
        "title": ticket.title,
        "body": ticket.body,
        "status": ticket.status,
        "replies": replies,
        "created_at": ticket.created_at.isoformat() if ticket.created_at else None,
    }


def _serialize_alert(alert: DbPriceAlert) -> dict:
    return {
        "id": alert.id,
        "user_id": alert.user_id,
        "symbol": alert.symbol,
        "price": float(alert.price),
        "direction": alert.direction,
        "created_at": alert.created_at.isoformat() if alert.created_at else None,
    }

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

async def _send_telegram(chat_id: str, text: str) -> bool:
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
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    with get_db_session() as db:
        _ensure_db_user(db, resolved_user_id, display_name)
        new_ticket = DbTicket(
            id=str(uuid.uuid4())[:8],
            user_id=resolved_user_id,
            user_name=display_name,
            title=ticket.title,
            body=ticket.body,
            status="open",
            created_at=datetime.now(timezone.utc),
            updated_at=datetime.now(timezone.utc),
        )
        db.add(new_ticket)
        db.flush()
        db.refresh(new_ticket)
        serialized_ticket = _serialize_ticket(new_ticket)
    await _send_telegram(
        ADMIN_TELEGRAM_ID,
        f"🎫 تیکت جدید\nاز: {display_name} ({resolved_user_id})\nعنوان: {ticket.title}\n\n{ticket.body}"
    )
    await _send_telegram(
        resolved_user_id,
        f"✅ تیکت شما ثبت شد\nعنوان: {ticket.title}\nبه زودی پاسخ داده می‌شود."
    )
    return {"status": "success", "ticket": serialized_ticket}

# مقدار کاربر تیکت‌ها را بازیابی می‌کند.
# مقدار کاربر تیکت‌ها را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/tickets")
@verify_telegram_auth
async def get_user_tickets(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    with get_db_session() as db:
        tickets = (
            db.query(DbTicket)
            .filter(DbTicket.user_id == resolved_user_id)
            .order_by(DbTicket.created_at.desc())
            .all()
        )
        return {"status": "success", "tickets": [_serialize_ticket(ticket) for ticket in tickets]}

# مقدار all تیکت‌ها را بازیابی می‌کند.
# مقدار all تیکت‌ها را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, admin_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/tickets/all")
@verify_admin_telegram_auth
async def get_all_tickets(request: Request, admin_id: Optional[str] = Query(None)):
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    with get_db_session() as db:
        tickets = db.query(DbTicket).order_by(DbTicket.created_at.desc()).all()
        return {"status": "success", "tickets": [_serialize_ticket(ticket) for ticket in tickets]}

# عملیات مربوط به پاسخ تیکت را انجام می‌دهد.
# عملیات مربوط به reply تیکت را انجام می‌دهد.
# ورودی: پارامترهای `ticket_id: str, reply: TicketReply, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/tickets/{ticket_id}/reply")
@verify_admin_telegram_auth
async def reply_ticket(ticket_id: str, reply: TicketReply, request: Request):
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    resolved_admin_id = get_authenticated_telegram_user_id(request)
    with get_db_session() as db:
        found = db.get(DbTicket, ticket_id)
        if not found:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
        found.status = "answered"
        found.updated_at = datetime.now(timezone.utc)
        db.add(
            DbTicketReply(
                ticket_id=found.id,
                sender_type="admin",
                sender_id=resolved_admin_id,
                message=reply.message,
                created_at=datetime.now(timezone.utc),
            )
        )
        db.flush()
        db.refresh(found)
        serialized_ticket = _serialize_ticket(found)
    if not found:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    await _send_telegram(
        found.user_id,
        f"💬 پاسخ تیکت: {found.title}\n\n{reply.message}"
    )
    return {"status": "success", "ticket": serialized_ticket}

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
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    with get_db_session() as db:
        ticket = db.get(DbTicket, ticket_id)
        if not ticket:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
        if not is_admin and ticket.user_id != resolved_user_id:
            return JSONResponse(status_code=403, content={"status": "error", "message": "Forbidden"})
        db.delete(ticket)
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
# AlertCreate ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class AlertCreate(BaseModel):
    user_id: str
    symbol: str
    price: float
    direction: str = "above"

# هشدار را ایجاد می‌کند.
# ایجاد هشدار را ایجاد می‌کند.
# ورودی: پارامترهای `alert: AlertCreate, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.post("/api/alerts")
@verify_telegram_auth
async def create_alert(alert: AlertCreate, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    symbol = alert.symbol.upper()
    direction = (alert.direction or "above").strip().lower()
    with get_db_session() as db:
        _ensure_db_user(db, resolved_user_id)
        existing_alert = (
            db.query(DbPriceAlert)
            .filter(
                DbPriceAlert.user_id == resolved_user_id,
                DbPriceAlert.symbol == symbol,
                DbPriceAlert.price == float(alert.price),
                DbPriceAlert.direction == direction,
            )
            .first()
        )
        if existing_alert:
            existing_alert.status = "active"
            existing_alert.triggered_at = None
            existing_alert.created_at = datetime.now(timezone.utc)
            db.flush()
            db.refresh(existing_alert)
            serialized_alert = _serialize_alert(existing_alert)
        else:
            new_alert = DbPriceAlert(
                id=str(uuid.uuid4())[:8],
                user_id=resolved_user_id,
                symbol=symbol,
                price=float(alert.price),
                direction=direction,
                status="active",
                created_at=datetime.now(timezone.utc),
            )
            db.add(new_alert)
            db.flush()
            db.refresh(new_alert)
            serialized_alert = _serialize_alert(new_alert)
    await _send_telegram(
        resolved_user_id,
        f"🔔 هشدار قیمت ثبت شد\n{serialized_alert['symbol']} — هدف: ${serialized_alert['price']}"
    )
    return {"status": "success", "alert": serialized_alert}

# مقدار کاربر هشدارها را بازیابی می‌کند.
# مقدار کاربر هشدارها را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.get("/api/alerts")
@verify_telegram_auth
async def get_user_alerts(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    with get_db_session() as db:
        alerts = (
            db.query(DbPriceAlert)
            .filter(
                DbPriceAlert.user_id == resolved_user_id,
                DbPriceAlert.status == "active",
            )
            .order_by(DbPriceAlert.created_at.desc())
            .all()
        )
        return {"status": "success", "alerts": [_serialize_alert(alert) for alert in alerts]}

# هشدار را حذف می‌کند.
# حذف هشدار را حذف می‌کند.
# ورودی: پارامترهای `request: Request, alert_id: str, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@app.delete("/api/alerts/{alert_id}")
@verify_telegram_auth
async def delete_alert(request: Request, alert_id: str, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})
    with get_db_session() as db:
        alert = db.get(DbPriceAlert, alert_id)
        if not alert:
            return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
        if alert.user_id != resolved_user_id:
            return JSONResponse(status_code=403, content={"status": "error", "message": "Forbidden"})
        db.delete(alert)
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
    if not database_ready():
        return {"status": "error", "message": "Database not configured"}
    with get_db_session() as db:
        alerts = (
            db.query(DbPriceAlert)
            .filter(DbPriceAlert.status == "active")
            .order_by(DbPriceAlert.created_at.desc())
            .all()
        )
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
        remaining_count = 0
        with get_db_session() as db:
            active_alerts = (
                db.query(DbPriceAlert)
                .filter(DbPriceAlert.status == "active")
                .order_by(DbPriceAlert.created_at.desc())
                .all()
            )
            for alert in active_alerts:
                sym = alert.symbol.upper()
                current = price_map.get(sym)
                if current is None:
                    remaining_count += 1
                    continue
                direction = alert.direction or "above"
                triggered = (direction == "above" and current >= float(alert.price)) or (
                    direction == "below" and current <= float(alert.price)
                )
                if triggered:
                    uid = alert.user_id
                    msg = f"🔔 {sym} Price reached ${current:.4f}"
                    summary["triggered_count"] += 1
                    alert.status = "triggered"
                    alert.triggered_at = datetime.now(timezone.utc)
                    if uid and not str(uid).startswith("guest_"):
                        await _send_telegram(uid, msg)
                    await _send_telegram(ADMIN_TELEGRAM_ID, f"📊 هشدار فعال شد\n{msg}\nکاربر: {uid}")
                else:
                    remaining_count += 1
        summary["remaining_count"] = remaining_count
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


# عملیات مربوط به تلگرام وبهوک را انجام می‌دهد.
# عملیات مربوط به تلگرام وبهوک را انجام می‌دهد.
# ورودی: پارامترهای `request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
# DEPRECATED — use Worker webhook only
@app.post("/telegram")
async def telegram_webhook(request: Request):
    settings = get_settings()
    secret = settings.TELEGRAM_WEBHOOK_SECRET
    if secret:
        received = request.headers.get("X-Telegram-Bot-Api-Secret-Token")
        if received != secret:
            return JSONResponse(
                {"detail": "Invalid webhook secret"},
                status_code=403,
            )
    else:
        print("⚠️ TELEGRAM_WEBHOOK_SECRET not configured — /telegram endpoint is unprotected")
    print("ℹ️ backend /telegram received a compatibility request; Worker owns the active webhook runtime.")
    return Response(status_code=200)


# ==========================================
# ۵. اجرای نهایی سرور
# ==========================================
if __name__ == "__main__":
    import uvicorn
    port = int(os.environ.get("PORT", 8000))
    uvicorn.run("main:app", host="0.0.0.0", port=port)

# endregion

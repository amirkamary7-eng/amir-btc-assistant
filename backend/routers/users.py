# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `users.py` را نگه می‌دارد.
# ============================================================================
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.database import database_ready, get_db_session
from backend.services.telegram_auth import (
    get_authenticated_telegram_user,
    get_authenticated_telegram_user_id,
    verify_telegram_auth,
)
from backend.services.user_service import bootstrap_user, get_watchlist, update_user_settings

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
router = APIRouter(prefix="/users", tags=["users"])



# BootstrapRequest ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class BootstrapRequest(BaseModel):
    user_id: str
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    lang: Optional[str] = None
    referrer_id: Optional[str] = None


# SettingsUpdateRequest ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class SettingsUpdateRequest(BaseModel):
    user_id: str
    lang: str = Field(pattern="^(fa|en)$")



# عملیات مربوط به راه‌اندازی اولیه کاربر endpoint را انجام می‌دهد.
# عملیات مربوط به bootstrap کاربر endpoint را انجام می‌دهد.
# ورودی: پارامترهای `payload: BootstrapRequest, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.post("/bootstrap")
@verify_telegram_auth
async def bootstrap_user_endpoint(payload: BootstrapRequest, request: Request):
    telegram_user = get_authenticated_telegram_user(request)
    user_id = str(telegram_user["id"])
    if not database_ready():
        return JSONResponse(
            status_code=503,
            content={"status": "DB_ERROR", "message": "Database not configured"},
        )

    try:
        with get_db_session() as db:
            lang = payload.lang if payload.lang in ("fa", "en") else telegram_user.get("language_code")
            if lang not in ("fa", "en"):
                lang = None
            user = bootstrap_user(
                db,
                telegram_id=user_id,
                username=payload.username or telegram_user.get("username"),
                first_name=payload.first_name or telegram_user.get("first_name"),
                last_name=payload.last_name or telegram_user.get("last_name"),
                lang=lang,
                referrer_id=payload.referrer_id,
            )
        return {"status": "success", "user": user, "watchlist": user["watchlist"]}
    except Exception as exc:
        print(f"⚠️ bootstrap_user error: {exc}")
        return JSONResponse(
            status_code=503,
            content={
                "status": "DB_ERROR",
                "message": "Database unavailable",
                "detail": str(exc),
            },
        )


# مقدار فعلی کاربر را بازیابی می‌کند.
# مقدار فعلی کاربر را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.get("/me")
@verify_telegram_auth
async def get_current_user(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        from backend.services.user_service import get_user as fetch_user

        user = fetch_user(db, resolved_user_id)
        if not user:
            return JSONResponse(status_code=404, content={"status": "error", "message": "User not found"})
        watchlist = get_watchlist(db, resolved_user_id)
        return {
            "status": "success",
            "user": {
                "user_id": user.telegram_id,
                "username": user.username,
                "first_name": user.first_name,
                "last_name": user.last_name,
                "lang": user.lang,
                "channel_joined": user.channel_joined,
            },
            "watchlist": watchlist,
        }


# تنظیمات را به‌روزرسانی می‌کند.
# به‌روزرسانی تنظیمات را به‌روزرسانی می‌کند.
# ورودی: پارامترهای `payload: SettingsUpdateRequest, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.put("/me/settings")
@verify_telegram_auth
async def update_settings(payload: SettingsUpdateRequest, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        user = update_user_settings(db, resolved_user_id, lang=payload.lang)
        if not user:
            return JSONResponse(status_code=404, content={"status": "error", "message": "User not found"})
    return {"status": "success", "user": user}

# endregion
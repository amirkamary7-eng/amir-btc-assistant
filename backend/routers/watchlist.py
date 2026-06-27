# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `watchlist.py` را نگه می‌دارد.
# ============================================================================
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.database import database_ready, get_db_session
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_telegram_auth
from backend.services.user_service import get_watchlist, replace_watchlist

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
router = APIRouter(prefix="/watchlist", tags=["watchlist"])



# WatchlistUpdateRequest ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class WatchlistUpdateRequest(BaseModel):
    user_id: str
    symbols: list[str] = Field(default_factory=list)



# مقدار کاربر واچ‌لیست را بازیابی می‌کند.
# مقدار کاربر watchlist را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.get("")
@verify_telegram_auth
async def get_user_watchlist(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        symbols = get_watchlist(db, resolved_user_id)
    return {"status": "success", "symbols": symbols}


# کاربر واچ‌لیست را به‌روزرسانی می‌کند.
# به‌روزرسانی کاربر watchlist را به‌روزرسانی می‌کند.
# ورودی: پارامترهای `payload: WatchlistUpdateRequest, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.put("")
@verify_telegram_auth
async def update_user_watchlist(payload: WatchlistUpdateRequest, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        symbols = replace_watchlist(db, resolved_user_id, payload.symbols)
    return {"status": "success", "symbols": symbols}

# endregion
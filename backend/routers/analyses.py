# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `analyses.py` را نگه می‌دارد.
# ============================================================================
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.database import database_ready, get_db_session
from backend.services.analysis_service import (
    create_analysis,
    delete_analysis,
    get_version,
    list_analyses,
    update_analysis,
)
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_admin_telegram_auth

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
router = APIRouter(prefix="/analyses", tags=["analyses"])



# AnalysisCreate ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class AnalysisCreate(BaseModel):
    coin: str = Field(min_length=1, max_length=16)
    timeframe: str = Field(default="1d", max_length=16)
    image: str = Field(default="", max_length=512)
    text: str = Field(min_length=1)
    author: str = Field(min_length=1, max_length=128)
    author_id: Optional[str] = None


# AnalysisUpdate ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class AnalysisUpdate(BaseModel):
    coin: str = Field(min_length=1, max_length=16)
    timeframe: str = Field(default="1d", max_length=16)
    image: str = Field(default="", max_length=512)
    text: str = Field(min_length=1)



# مقدار تحلیل‌ها را بازیابی می‌کند.
# مقدار analyses را بازیابی می‌کند.
# ورودی: پارامترهای `version: Optional[int] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.get("")
async def get_analyses(version: Optional[int] = Query(None)):
    if not database_ready():
        return {"status": "success", "analyses": [], "version": 0, "source": "no_db"}

    current_version = get_version()
    if version is not None and version == current_version:
        return {"status": "success", "analyses": None, "version": current_version, "unchanged": True}

    with get_db_session() as db:
        analyses = list_analyses(db)
    return {"status": "success", "analyses": analyses, "version": current_version}


# عملیات مربوط به post تحلیل را انجام می‌دهد.
# عملیات مربوط به post analysis را انجام می‌دهد.
# ورودی: پارامترهای `payload: AnalysisCreate, request: Request, admin_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.post("")
@verify_admin_telegram_auth
async def post_analysis(payload: AnalysisCreate, request: Request, admin_id: Optional[str] = Query(None)):
    resolved_admin_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        item = create_analysis(
            db,
            coin=payload.coin,
            timeframe=payload.timeframe,
            image=payload.image,
            text=payload.text,
            author=payload.author,
            author_id=resolved_admin_id,
        )
    return {"status": "success", "analysis": item, "version": get_version()}


# عملیات مربوط به put analysis را انجام می‌دهد.
# ورودی: پارامترهای تعریف‌شده در امضای این تابع را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.put("/{analysis_id}")
@verify_admin_telegram_auth
async def put_analysis(
    analysis_id: str,
    payload: AnalysisUpdate,
    request: Request,
    admin_id: Optional[str] = Query(None),
):
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        item = update_analysis(
            db,
            analysis_id,
            coin=payload.coin,
            timeframe=payload.timeframe,
            image=payload.image,
            text=payload.text,
        )
    if not item:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    return {"status": "success", "analysis": item, "version": get_version()}


# تحلیل را حذف می‌کند.
# analysis را حذف می‌کند.
# ورودی: پارامترهای `analysis_id: str, request: Request, admin_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.delete("/{analysis_id}")
@verify_admin_telegram_auth
async def remove_analysis(analysis_id: str, request: Request, admin_id: Optional[str] = Query(None)):
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        ok = delete_analysis(db, analysis_id)
    if not ok:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    return {"status": "success", "version": get_version()}

# endregion
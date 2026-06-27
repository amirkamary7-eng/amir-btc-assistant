# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `charts.py` را نگه می‌دارد.
# ============================================================================
from fastapi import APIRouter, Query

from backend.services.chart_service import resolve_chart_exchange

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
router = APIRouter(prefix="/charts", tags=["charts"])



# مقدار نهایی چارت را تعیین می‌کند.
# مقدار نهایی تعیین chart را تعیین می‌کند.
# ورودی: پارامترهای `symbol: str = Query(..., min_length=1, max_length=16)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.get("/resolve")
async def resolve_chart(symbol: str = Query(..., min_length=1, max_length=16)):
    result = resolve_chart_exchange(symbol)
    return {"status": "success", **result}

# endregion
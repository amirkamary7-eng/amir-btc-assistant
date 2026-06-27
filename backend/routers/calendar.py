# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `calendar.py` را نگه می‌دارد.
# ============================================================================
from fastapi import APIRouter

from backend.services.calendar_service import fetch_calendar_events

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
router = APIRouter(prefix="/calendar", tags=["calendar"])



# مقدار تقویم events را بازیابی می‌کند.
# مقدار calendar events را بازیابی می‌کند.
# ورودی: بدون ورودی.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.get("/events")
async def get_calendar_events():
    events = fetch_calendar_events()
    return {"status": "success", "events": events}

# endregion
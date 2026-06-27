# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `assistant.py` را نگه می‌دارد.
# ============================================================================
from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.services.ai_service import chat, check_rate_limits
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_telegram_auth

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
router = APIRouter(prefix="/assistant", tags=["assistant"])



# ChatMessage ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class ChatMessage(BaseModel):
    role: str = Field(default="user")
    content: str = Field(default="")


# ChatRequest ساختار داده یا کلاس اصلی این فایل را تعریف می‌کند.
# ورودی: در زمان نمونه‌سازی یا ارث‌بری، پارامترها و فیلدهای موردنیاز را دریافت می‌کند.
# خروجی: یک ساختار داده، مدل یا رفتار شی‌گرا برای استفاده در سایر بخش‌ها فراهم می‌کند.
class ChatRequest(BaseModel):
    user_id: str
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list)
    image: Optional[str] = Field(default=None, max_length=2_000_000)



# مقدار محدودیت‌ها را بازیابی می‌کند.
# مقدار limits را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request, user_id: Optional[str] = Query(None)` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.get("/limits")
@verify_telegram_auth
async def get_limits(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    return {"status": "success", **check_rate_limits(resolved_user_id)}


# عملیات مربوط به assistant chat را انجام می‌دهد.
# عملیات مربوط به assistant chat را انجام می‌دهد.
# ورودی: پارامترهای `payload: ChatRequest, request: Request` را دریافت می‌کند.
# خروجی: یک نتیجه غیرهمزمان از این عملیات برمی‌گرداند.
@router.post("/chat")
@verify_telegram_auth
async def assistant_chat(payload: ChatRequest, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    history = [{"role": m.role, "content": m.content} for m in payload.history]
    result = await chat(resolved_user_id, payload.message, history, payload.image)
    if result.get("status") == "error":
        code = 429 if result.get("reason") in ("cooldown", "daily_message_limit", "daily_image_limit") else 503
        return JSONResponse(status_code=code, content=result)
    return result

# endregion
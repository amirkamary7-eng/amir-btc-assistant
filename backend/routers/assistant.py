from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.services.ai_service import chat, check_rate_limits
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_telegram_auth

router = APIRouter(prefix="/assistant", tags=["assistant"])


class ChatMessage(BaseModel):
    role: str = Field(default="user")
    content: str = Field(default="")


class ChatRequest(BaseModel):
    user_id: str
    message: str = Field(min_length=1, max_length=4000)
    history: list[ChatMessage] = Field(default_factory=list)
    image: Optional[str] = Field(default=None, max_length=2_000_000)


@router.get("/limits")
@verify_telegram_auth
async def get_limits(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    return {"status": "success", **check_rate_limits(resolved_user_id)}


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

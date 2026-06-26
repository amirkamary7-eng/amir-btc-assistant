from typing import Optional

from fastapi import APIRouter, Query, Request

from backend.services.session_service import end_session, get_online_count, touch_session
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_telegram_auth

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("/heartbeat")
@verify_telegram_auth
async def heartbeat(request: Request, user_id: Optional[str] = Query(None), session_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    result = touch_session(resolved_user_id, session_id)
    return {"status": "success", **result, "online_count": get_online_count()}


@router.get("/online")
@verify_telegram_auth
async def online_users(request: Request):
    return {"status": "success", "count": get_online_count()}


@router.post("/end")
@verify_telegram_auth
async def session_end(request: Request, user_id: Optional[str] = Query(None)):
    end_session(get_authenticated_telegram_user_id(request))
    return {"status": "success", "online_count": get_online_count()}

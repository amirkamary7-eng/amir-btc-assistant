from typing import Optional

from fastapi import APIRouter, Query

from backend.services.session_service import end_session, get_online_count, touch_session

router = APIRouter(prefix="/sessions", tags=["sessions"])


@router.post("/heartbeat")
async def heartbeat(user_id: str = Query(...), session_id: Optional[str] = Query(None)):
    if str(user_id).startswith("guest_"):
        return {"status": "skipped", "online_count": get_online_count()}
    result = touch_session(user_id, session_id)
    return {"status": "success", **result, "online_count": get_online_count()}


@router.get("/online")
async def online_users():
    return {"status": "success", "count": get_online_count()}


@router.post("/end")
async def session_end(user_id: str = Query(...)):
    end_session(user_id)
    return {"status": "success", "online_count": get_online_count()}

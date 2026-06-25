from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.database import database_ready, get_db_session
from backend.services.user_service import bootstrap_user, get_watchlist, update_user_settings

router = APIRouter(prefix="/users", tags=["users"])


class BootstrapRequest(BaseModel):
    user_id: str
    username: Optional[str] = None
    first_name: Optional[str] = None
    last_name: Optional[str] = None
    lang: Optional[str] = None


class SettingsUpdateRequest(BaseModel):
    user_id: str
    lang: str = Field(pattern="^(fa|en)$")


@router.post("/bootstrap")
async def bootstrap_user_endpoint(payload: BootstrapRequest):
    if str(payload.user_id).startswith("guest_"):
        return JSONResponse(
            status_code=400,
            content={"status": "error", "message": "Guest users cannot be bootstrapped"},
        )
    if not database_ready():
        return JSONResponse(
            status_code=503,
            content={"status": "error", "message": "Database not configured"},
        )

    with get_db_session() as db:
        lang = payload.lang if payload.lang in ("fa", "en") else None
        user = bootstrap_user(
            db,
            telegram_id=payload.user_id,
            username=payload.username,
            first_name=payload.first_name,
            last_name=payload.last_name,
            lang=lang,
        )
    return {"status": "success", "user": user, "watchlist": user["watchlist"]}


@router.get("/me")
async def get_current_user(user_id: str = Query(...)):
    if str(user_id).startswith("guest_"):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Guest users not supported"})
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        from backend.services.user_service import get_user as fetch_user

        user = fetch_user(db, user_id)
        if not user:
            return JSONResponse(status_code=404, content={"status": "error", "message": "User not found"})
        watchlist = get_watchlist(db, user_id)
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


@router.put("/me/settings")
async def update_settings(payload: SettingsUpdateRequest):
    if str(payload.user_id).startswith("guest_"):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Guest users not supported"})
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        user = update_user_settings(db, payload.user_id, lang=payload.lang)
        if not user:
            return JSONResponse(status_code=404, content={"status": "error", "message": "User not found"})
    return {"status": "success", "user": user}

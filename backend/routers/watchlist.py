from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.database import database_ready, get_db_session
from backend.services.user_service import get_watchlist, replace_watchlist

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


class WatchlistUpdateRequest(BaseModel):
    user_id: str
    symbols: list[str] = Field(default_factory=list)


@router.get("")
async def get_user_watchlist(user_id: str = Query(...)):
    if str(user_id).startswith("guest_"):
        return {"status": "success", "symbols": [], "guest": True}
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        symbols = get_watchlist(db, user_id)
    return {"status": "success", "symbols": symbols}


@router.put("")
async def update_user_watchlist(payload: WatchlistUpdateRequest):
    if str(payload.user_id).startswith("guest_"):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Guest users not supported"})
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        symbols = replace_watchlist(db, payload.user_id, payload.symbols)
    return {"status": "success", "symbols": symbols}

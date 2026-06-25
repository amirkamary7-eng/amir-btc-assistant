from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.database import database_ready, get_db_session
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_telegram_auth
from backend.services.user_service import get_watchlist, replace_watchlist

router = APIRouter(prefix="/watchlist", tags=["watchlist"])


class WatchlistUpdateRequest(BaseModel):
    user_id: str
    symbols: list[str] = Field(default_factory=list)


@router.get("")
@verify_telegram_auth
async def get_user_watchlist(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        symbols = get_watchlist(db, resolved_user_id)
    return {"status": "success", "symbols": symbols}


@router.put("")
@verify_telegram_auth
async def update_user_watchlist(payload: WatchlistUpdateRequest, request: Request):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        symbols = replace_watchlist(db, resolved_user_id, payload.symbols)
    return {"status": "success", "symbols": symbols}

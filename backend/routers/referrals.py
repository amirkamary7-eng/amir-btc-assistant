from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse

from backend.database import database_ready, get_db_session
from backend.services.referral_service import get_referral_stats, get_token_balance, get_token_history

router = APIRouter(prefix="/referrals", tags=["referrals"])


@router.get("/stats")
async def referral_stats(user_id: str = Query(...)):
    if str(user_id).startswith("guest_"):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Guest users not supported"})
    if not database_ready():
        return {"status": "success", "total": 0, "active": 0, "rewarded": 0, "tokens": 0}

    with get_db_session() as db:
        return {"status": "success", **get_referral_stats(db, user_id)}


@router.get("/tokens")
async def token_info(user_id: str = Query(...)):
    if str(user_id).startswith("guest_"):
        return JSONResponse(status_code=400, content={"status": "error", "message": "Guest users not supported"})
    if not database_ready():
        return {"status": "success", "balance": 0, "history": []}

    with get_db_session() as db:
        balance = get_token_balance(db, user_id)
        history = get_token_history(db, user_id)
    return {"status": "success", "balance": balance, "history": history}

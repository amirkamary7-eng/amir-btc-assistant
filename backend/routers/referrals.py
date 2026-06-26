from typing import Optional

from fastapi import APIRouter, Query, Request
from fastapi.responses import JSONResponse

from backend.database import database_ready, get_db_session
from backend.services.referral_service import get_referral_stats, get_token_balance, get_token_history
from backend.services.telegram_auth import get_authenticated_telegram_user_id, verify_telegram_auth

router = APIRouter(prefix="/referrals", tags=["referrals"])


@router.get("/stats")
@verify_telegram_auth
async def referral_stats(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return {"status": "success", "total": 0, "active": 0, "rewarded": 0, "tokens": 0}

    with get_db_session() as db:
        return {"status": "success", **get_referral_stats(db, resolved_user_id)}


@router.get("/tokens")
@verify_telegram_auth
async def token_info(request: Request, user_id: Optional[str] = Query(None)):
    resolved_user_id = get_authenticated_telegram_user_id(request)
    if not database_ready():
        return {"status": "success", "balance": 0, "history": []}

    with get_db_session() as db:
        balance = get_token_balance(db, resolved_user_id)
        history = get_token_history(db, resolved_user_id)
    return {"status": "success", "balance": balance, "history": history}

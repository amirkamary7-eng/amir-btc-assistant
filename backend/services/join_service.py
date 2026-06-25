from typing import Callable, Optional

from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.redis_client import cache_delete, cache_get, cache_set
from backend.models import Referral
from backend.services.referral_service import process_referral_on_bootstrap
from backend.services.user_service import get_user, set_user_channel_joined

JOIN_CACHE_PREFIX = "join:"
DB_ERROR_STATUS = "DB_ERROR"


def _join_cache_key(user_id: str) -> str:
    return f"{JOIN_CACHE_PREFIX}{user_id}"


def get_cached_join_status(user_id: str) -> Optional[bool]:
    try:
        cached = cache_get(_join_cache_key(user_id))
        if cached == "1":
            return True
        if cached == "0":
            return False
    except Exception as exc:
        print(f"⚠️ Join cache read error: {exc}")
    return None


def set_cached_join_status(user_id: str, joined: bool) -> None:
    try:
        settings = get_settings()
        cache_set(_join_cache_key(user_id), "1" if joined else "0", settings.JOIN_CACHE_TTL)
    except Exception as exc:
        print(f"⚠️ Join cache write error: {exc}")


def clear_cached_join_status(user_id: str) -> None:
    try:
        cache_delete(_join_cache_key(user_id))
    except Exception as exc:
        print(f"⚠️ Join cache clear error: {exc}")


def _safe_db_user_joined(db: Session, uid: str) -> Optional[bool]:
    try:
        user = get_user(db, uid)
        if user and user.channel_joined:
            set_cached_join_status(uid, True)
            return True
    except Exception as exc:
        print(f"⚠️ DB read error in join check: {exc}")
    return None


def _safe_persist_join(db: Session, uid: str, joined: bool) -> None:
    try:
        set_user_channel_joined(db, uid, joined)
        if joined:
            referral = db.query(Referral).filter(Referral.invitee_id == uid).first()
            if referral and not referral.channel_verified:
                process_referral_on_bootstrap(db, uid, referral.inviter_id, channel_joined=True)
    except Exception as exc:
        print(f"⚠️ DB write error in join check: {exc}")


def resolve_channel_membership(
    user_id: str,
    telegram_check: Callable[[str], dict],
    db: Optional[Session] = None,
    *,
    force_refresh: bool = False,
) -> dict:
    uid = str(user_id)

    if uid.startswith("guest_"):
        return {"joined": False, "reason": "guest_user"}

    settings = get_settings()
    if uid == str(settings.ADMIN_TELEGRAM_ID):
        return {"joined": True, "admin": True}

    try:
        if not force_refresh:
            cached = get_cached_join_status(uid)
            if cached is True:
                return {"joined": True, "cached": True}

            if db is not None:
                from_db = _safe_db_user_joined(db, uid)
                if from_db is True:
                    return {"joined": True, "from_db": True}

        result = telegram_check(uid)
        joined = bool(result.get("joined"))
        reason = result.get("reason")

        if joined:
            set_cached_join_status(uid, True)
            if db is not None:
                _safe_persist_join(db, uid, True)
            return result

        if reason == "api_error":
            if db is not None:
                from_db = _safe_db_user_joined(db, uid)
                if from_db is True:
                    return {"joined": True, "from_db_fallback": True, "reason": reason}
            cached = get_cached_join_status(uid)
            if cached is True:
                return {"joined": True, "cached_fallback": True, "reason": reason}
            return {**result, "joined": False}

        set_cached_join_status(uid, False)
        if db is not None:
            _safe_persist_join(db, uid, False)
        return result
    except Exception as exc:
        print(f"⚠️ resolve_channel_membership error: {exc}")
        return {
            "status": DB_ERROR_STATUS,
            "joined": False,
            "reason": "database_unavailable",
            "detail": str(exc),
        }

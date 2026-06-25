from typing import Callable, Optional

from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.redis_client import cache_delete, cache_get, cache_set
from backend.models import Referral
from backend.services.referral_service import process_referral_on_bootstrap
from backend.services.user_service import get_user, set_user_channel_joined

JOIN_CACHE_PREFIX = "join:"


def _join_cache_key(user_id: str) -> str:
    return f"{JOIN_CACHE_PREFIX}{user_id}"


def get_cached_join_status(user_id: str) -> Optional[bool]:
    cached = cache_get(_join_cache_key(user_id))
    if cached == "1":
        return True
    if cached == "0":
        return False
    return None


def set_cached_join_status(user_id: str, joined: bool) -> None:
    settings = get_settings()
    cache_set(_join_cache_key(user_id), "1" if joined else "0", settings.JOIN_CACHE_TTL)


def clear_cached_join_status(user_id: str) -> None:
    cache_delete(_join_cache_key(user_id))


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

    if not force_refresh:
        cached = get_cached_join_status(uid)
        if cached is True:
            return {"joined": True, "cached": True}

        if db is not None:
            user = get_user(db, uid)
            if user and user.channel_joined:
                set_cached_join_status(uid, True)
                return {"joined": True, "from_db": True}

    result = telegram_check(uid)
    joined = bool(result.get("joined"))
    reason = result.get("reason")

    if joined:
        set_cached_join_status(uid, True)
        if db is not None:
            set_user_channel_joined(db, uid, True)
            referral = db.query(Referral).filter(Referral.invitee_id == uid).first()
            if referral and not referral.channel_verified:
                process_referral_on_bootstrap(db, uid, referral.inviter_id, channel_joined=True)
        return result

    if reason == "api_error":
        if db is not None:
            user = get_user(db, uid)
            if user and user.channel_joined:
                set_cached_join_status(uid, True)
                return {"joined": True, "from_db_fallback": True, "reason": reason}
        cached = get_cached_join_status(uid)
        if cached is True:
            return {"joined": True, "cached_fallback": True, "reason": reason}
        return {**result, "joined": False}

    set_cached_join_status(uid, False)
    if db is not None:
        set_user_channel_joined(db, uid, False)
    return result

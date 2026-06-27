"""Real online user session tracking via Redis."""

import uuid
from datetime import datetime, timezone

from backend.config import get_settings
from backend.redis_client import cache_delete, cache_get, cache_sadd, cache_set, cache_smembers, cache_srem

SESSION_PREFIX = "session:"
ONLINE_SET_KEY = "online:users"


def touch_session(user_id: str, session_id: str | None = None) -> dict:
    settings = get_settings()
    uid = str(user_id)
    sid = session_id or str(uuid.uuid4())[:16]
    now = datetime.now(timezone.utc).isoformat()

    cache_set(f"{SESSION_PREFIX}{uid}", sid, settings.SESSION_TTL)
    cache_set(f"{SESSION_PREFIX}{uid}:seen", now, settings.SESSION_TTL)
    cache_sadd(ONLINE_SET_KEY, uid, settings.SESSION_TTL * 2)

    return {"session_id": sid, "last_seen": now}


def get_online_count() -> int:
    members = cache_smembers(ONLINE_SET_KEY)
    active = 0
    for uid in members:
        if cache_get(f"{SESSION_PREFIX}{uid}"):
            active += 1
        else:
            cache_srem(ONLINE_SET_KEY, uid)
    return active


def end_session(user_id: str) -> None:
    uid = str(user_id)
    cache_delete(f"{SESSION_PREFIX}{uid}")
    cache_delete(f"{SESSION_PREFIX}{uid}:seen")
    cache_srem(ONLINE_SET_KEY, uid)

# endregion

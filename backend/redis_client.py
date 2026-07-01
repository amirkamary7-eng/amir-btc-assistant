# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `redis_client.py` را نگه می‌دارد.
# ============================================================================
import json
import time
from typing import Any, Optional

from backend.config import get_settings

# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، مدل‌ها و منطق اصلی فایل را در خود نگه می‌دارد.
# ============================================================================
_redis_ready = False
_memory_cache: dict[str, dict[str, Any]] = {}


def init_redis() -> bool:
    global _redis_ready

    settings = get_settings()
    # NOTE:
    # در مسیر مهاجرت به Cloudflare Worker + KV، backend نباید وابستگی production به Redis داشته باشد.
    # بنابراین در این repo کش backend فقط in-memory است و Redis عمداً استفاده نمی‌شود.
    if settings.redis_enabled:
        print("ℹ️ REDIS_URL is set but Redis support is disabled; using in-memory cache only.")
    else:
        print("ℹ️ REDIS_URL not set; using in-memory cache.")
    _redis_ready = False
    return False


def redis_ready() -> bool:
    return _redis_ready


def cache_get(key: str) -> Optional[str]:
    entry = _memory_cache.get(key)
    if not entry:
        return None
    if entry["expires_at"] <= time.time():
        _memory_cache.pop(key, None)
        return None
    return entry["value"]


def cache_set(key: str, value: str, ttl_seconds: int) -> None:
    _memory_cache[key] = {
        "value": value,
        "expires_at": time.time() + ttl_seconds,
    }


def cache_delete(key: str) -> None:
    _memory_cache.pop(key, None)


def cache_get_json(key: str) -> Optional[Any]:
    raw = cache_get(key)
    if raw is None:
        return None
    try:
        return json.loads(raw)
    except json.JSONDecodeError:
        return None


def cache_set_json(key: str, value: Any, ttl_seconds: int) -> None:
    cache_set(key, json.dumps(value, ensure_ascii=False), ttl_seconds)


def cache_sadd(key: str, member: str, ttl_seconds: int | None = None) -> None:
    entry = _memory_cache.setdefault(f"set:{key}", {"members": set(), "expires_at": 0})
    if ttl_seconds:
        entry["expires_at"] = time.time() + ttl_seconds
    entry["members"].add(member)


def cache_srem(key: str, member: str) -> None:
    entry = _memory_cache.get(f"set:{key}")
    if entry:
        entry["members"].discard(member)


def cache_smembers(key: str) -> set[str]:
    entry = _memory_cache.get(f"set:{key}")
    if not entry:
        return set()
    if entry.get("expires_at") and entry["expires_at"] <= time.time():
        _memory_cache.pop(f"set:{key}", None)
        return set()
    return set(entry.get("members", set()))

# endregion

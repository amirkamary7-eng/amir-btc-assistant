import json
import time
from typing import Any, Optional

from backend.config import get_settings

_redis_client = None
_redis_ready = False
_memory_cache: dict[str, dict[str, Any]] = {}


def init_redis() -> bool:
    global _redis_client, _redis_ready

    settings = get_settings()
    if not settings.redis_enabled:
        print("ℹ️ REDIS_URL not set; using in-memory cache fallback.")
        _redis_ready = False
        return False

    try:
        import redis

        _redis_client = redis.from_url(settings.REDIS_URL, decode_responses=True)
        _redis_client.ping()
        _redis_ready = True
        print("✅ Redis connected.")
        return True
    except Exception as exc:
        print(f"⚠️ Redis init failed: {exc}; using in-memory cache fallback.")
        _redis_client = None
        _redis_ready = False
        return False


def redis_ready() -> bool:
    return _redis_ready


def cache_get(key: str) -> Optional[str]:
    if _redis_client:
        try:
            return _redis_client.get(key)
        except Exception as exc:
            print(f"⚠️ Redis GET failed for {key}: {exc}")

    entry = _memory_cache.get(key)
    if not entry:
        return None
    if entry["expires_at"] <= time.time():
        _memory_cache.pop(key, None)
        return None
    return entry["value"]


def cache_set(key: str, value: str, ttl_seconds: int) -> None:
    if _redis_client:
        try:
            _redis_client.setex(key, ttl_seconds, value)
            return
        except Exception as exc:
            print(f"⚠️ Redis SET failed for {key}: {exc}")

    _memory_cache[key] = {
        "value": value,
        "expires_at": time.time() + ttl_seconds,
    }


def cache_delete(key: str) -> None:
    if _redis_client:
        try:
            _redis_client.delete(key)
        except Exception as exc:
            print(f"⚠️ Redis DELETE failed for {key}: {exc}")
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

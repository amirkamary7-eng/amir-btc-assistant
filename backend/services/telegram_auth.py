"""Validate Telegram WebApp initData and extract user identity."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from functools import wraps
from typing import Any, Awaitable, Callable, Optional, TypeVar, cast
from urllib.parse import unquote

from fastapi import HTTPException, Request

Handler = TypeVar("Handler", bound=Callable[..., Awaitable[Any]])


def _parse_init_data_pairs(init_data: str) -> list[tuple[str, str]]:
    """Split initData into key/value pairs preserving URL-encoded values (for HMAC)."""
    pairs: list[tuple[str, str]] = []
    for segment in init_data.split("&"):
        if not segment or "=" not in segment:
            continue
        key, value = segment.split("=", 1)
        pairs.append((key, value))
    return pairs


def validate_telegram_init_data(
    init_data: str,
    bot_token: str,
    *,
    max_age_seconds: int = 86400,
) -> Optional[dict[str, Any]]:
    """Return parsed user dict when initData HMAC is valid, else None."""
    if not init_data or not bot_token or bot_token == "REPLACE_WITH_TOKEN":
        return None
    try:
        pairs = _parse_init_data_pairs(init_data.strip())
        received_hash: Optional[str] = None
        check_pairs: list[tuple[str, str]] = []
        decoded: dict[str, str] = {}

        for key, value in pairs:
            decoded[key] = unquote(value)
            if key == "hash":
                received_hash = value
            else:
                check_pairs.append((key, value))

        if not received_hash:
            return None

        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(check_pairs))
        secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
        computed = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed, received_hash):
            return None

        auth_date_raw = decoded.get("auth_date")
        if auth_date_raw:
            auth_date = int(auth_date_raw)
            if time.time() - auth_date > max_age_seconds:
                return None

        user_raw = decoded.get("user")
        if not user_raw:
            return None
        user = json.loads(user_raw)
        return user if user.get("id") else None
    except Exception:
        return None


def _get_init_data(request: Request) -> Optional[str]:
    return request.headers.get("X-Telegram-Init-Data") or request.query_params.get("init_data")


def _extract_request(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Request:
    request = kwargs.get("request")
    if isinstance(request, Request):
        return request
    for arg in args:
        if isinstance(arg, Request):
            return arg
    raise RuntimeError("verify_telegram_auth requires a FastAPI Request parameter")


def get_authenticated_telegram_user(request: Request) -> dict[str, Any]:
    cached_user = getattr(request.state, "telegram_user", None)
    if isinstance(cached_user, dict) and cached_user.get("id"):
        return cached_user

    from backend.config import get_settings

    settings = get_settings()
    init_data = _get_init_data(request)
    if not init_data:
        raise HTTPException(status_code=401, detail="Missing Telegram init data")
    if not settings.bot_configured:
        raise HTTPException(status_code=401, detail="Telegram bot token is not configured")

    user = validate_telegram_init_data(init_data, settings.TELEGRAM_BOT_TOKEN)
    if not user or not user.get("id"):
        raise HTTPException(status_code=401, detail="Invalid Telegram init data")

    request.state.telegram_user = user
    request.state.telegram_user_id = str(user["id"])
    return user


def get_authenticated_telegram_user_id(request: Request) -> str:
    return str(get_authenticated_telegram_user(request)["id"])


def is_admin_telegram_id(user_id: str) -> bool:
    from backend.config import get_settings

    return str(user_id) in get_settings().admin_ids


def verify_telegram_auth(func: Handler) -> Handler:
    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        request = _extract_request(args, kwargs)
        get_authenticated_telegram_user(request)
        return await func(*args, **kwargs)

    return cast(Handler, wrapper)


def verify_admin_telegram_auth(func: Handler) -> Handler:
    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        request = _extract_request(args, kwargs)
        user_id = get_authenticated_telegram_user_id(request)
        if not is_admin_telegram_id(user_id):
            raise HTTPException(status_code=403, detail="Admin access required")
        request.state.telegram_is_admin = True
        return await func(*args, **kwargs)

    return cast(Handler, wrapper)

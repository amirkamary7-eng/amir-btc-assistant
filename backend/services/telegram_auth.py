"""Validate Telegram WebApp initData and extract user identity."""

# ============================================================================
# region Imports
# این بخش وابستگی‌ها و importهای فایل `telegram_auth.py` را نگه می‌دارد.
# ============================================================================
from __future__ import annotations

import hashlib
import hmac
import json
import time
from functools import wraps
from typing import Any, Awaitable, Callable, Optional, TypeVar, cast
from urllib.parse import unquote

from fastapi import HTTPException, Request
# endregion

# ============================================================================
# region تعاریف و منطق ماژول
# این بخش ثابت‌ها، ابزارهای کمکی و منطق احراز هویت تلگرام را نگه می‌دارد.
# ============================================================================
Handler = TypeVar("Handler", bound=Callable[..., Awaitable[Any]])


# داده init data را تجزیه و آماده استفاده می‌کند.
# ورودی: پارامترهای `init_data: str` را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
def _parse_init_data_pairs(init_data: str) -> list[tuple[str, str]]:
    """Split initData into key/value pairs preserving URL-encoded values (for HMAC)."""
    pairs: list[tuple[str, str]] = []
    for segment in init_data.split("&"):
        if not segment or "=" not in segment:
            continue
        key, value = segment.split("=", 1)
        pairs.append((key, value))
    return pairs


# درستی initData تلگرام را اعتبارسنجی می‌کند و کاربر معتبر را استخراج می‌کند.
# ورودی: پارامترهای تعریف‌شده در امضای این تابع را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
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


# مقدار init data را بازیابی می‌کند.
# ورودی: پارامترهای `request: Request` را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
def _get_init_data(request: Request) -> Optional[str]:
    return request.headers.get("X-Telegram-Init-Data") or request.query_params.get("init_data")


# درخواست فعلی را برای دکوراتورهای احراز هویت استخراج می‌کند.
# ورودی: پارامترهای `args: tuple[Any, ...], kwargs: dict[str, Any]` را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
def _extract_request(args: tuple[Any, ...], kwargs: dict[str, Any]) -> Request:
    request = kwargs.get("request")
    if isinstance(request, Request):
        return request
    for arg in args:
        if isinstance(arg, Request):
            return arg
    raise RuntimeError("verify_telegram_auth requires a FastAPI Request parameter")


# کاربر احراز هویت‌شده تلگرام را از درخواست استخراج و کش می‌کند.
# ورودی: پارامترهای `request: Request` را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
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


# شناسه کاربر احراز هویت‌شده تلگرام را از درخواست فعلی برمی‌گرداند.
# ورودی: پارامترهای `request: Request` را دریافت می‌کند.
# خروجی: مقدار نهایی یا داده محاسبه‌شده این عملیات را برمی‌گرداند.
def get_authenticated_telegram_user_id(request: Request) -> str:
    return str(get_authenticated_telegram_user(request)["id"])


# بررسی می‌کند که آیا مدیر تلگرام id برقرار است یا خیر.
# ورودی: پارامترهای `user_id: str` را دریافت می‌کند.
# خروجی: یک مقدار بولی `true/false` برمی‌گرداند.
def is_admin_telegram_id(user_id: str) -> bool:
    from backend.config import get_settings

    return str(user_id) in get_settings().admin_ids


# دکوراتور احراز هویت تلگرام را روی endpoint هدف اعمال می‌کند.
# ورودی: پارامترهای `func: Handler` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
def verify_telegram_auth(func: Handler) -> Handler:
    @wraps(func)
    async def wrapper(*args: Any, **kwargs: Any) -> Any:
        request = _extract_request(args, kwargs)
        get_authenticated_telegram_user(request)
        return await func(*args, **kwargs)

    return cast(Handler, wrapper)


# دکوراتور احراز هویت مدیر تلگرام را روی endpoint هدف اعمال می‌کند.
# ورودی: پارامترهای `func: Handler` را دریافت می‌کند.
# خروجی: نتیجه مستقیم این عملیات را برمی‌گرداند یا روی وضعیت ماژول اثر می‌گذارد.
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
# endregion

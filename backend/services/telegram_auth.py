"""Validate Telegram WebApp initData and extract user identity."""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from typing import Any, Optional
from urllib.parse import unquote


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

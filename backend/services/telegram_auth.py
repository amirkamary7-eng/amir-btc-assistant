"""Validate Telegram WebApp initData and extract user identity."""

from __future__ import annotations

import hashlib
import hmac
import json
from typing import Any, Optional
from urllib.parse import parse_qsl


def validate_telegram_init_data(init_data: str, bot_token: str) -> Optional[dict[str, Any]]:
    """Return parsed user dict when initData HMAC is valid, else None."""
    if not init_data or not bot_token or bot_token == "REPLACE_WITH_TOKEN":
        return None
    try:
        parsed = dict(parse_qsl(init_data, keep_blank_values=True))
        received_hash = parsed.pop("hash", None)
        if not received_hash:
            return None
        data_check_string = "\n".join(f"{k}={v}" for k, v in sorted(parsed.items()))
        secret_key = hmac.new(b"WebAppData", bot_token.encode(), hashlib.sha256).digest()
        computed = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        if not hmac.compare_digest(computed, received_hash):
            return None
        user_raw = parsed.get("user")
        if not user_raw:
            return None
        user = json.loads(user_raw)
        return user if user.get("id") else None
    except Exception:
        return None

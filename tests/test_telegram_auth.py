"""Tests for backend.services.telegram_auth — pure functions (Task 5.5).

Only tests _parse_init_data_pairs and validate_telegram_init_data since
those are pure functions with no external dependencies (no DB, no FastAPI
Request, no config).  The decorator-based functions (verify_telegram_auth,
verify_admin_telegram_auth) require FastAPI Request mocking and are not
covered here.
"""

from __future__ import annotations

import hashlib
import hmac
import json
import time
from urllib.parse import quote, urlencode

import pytest

from backend.services.telegram_auth import (
    _parse_init_data_pairs,
    validate_telegram_init_data,
)

BOT_TOKEN = "test-bot-token-12345"


# ---------------------------------------------------------------------------
# Helper — build a valid initData string (mirrors Telegram spec)
# ---------------------------------------------------------------------------
def _build_init_data(
    bot_token: str,
    user: dict,
    *,
    auth_date: int | None = None,
    extra_pairs: dict[str, str] | None = None,
) -> str:
    """Build a Telegram initData string with a valid HMAC hash."""
    if auth_date is None:
        auth_date = int(time.time())
    entries: list[tuple[str, str]] = [
        ("auth_date", str(auth_date)),
        ("query_id", "AAHdF6IQAAAAAN0XohDhrOrc"),
        ("user", json.dumps(user)),
    ]
    if extra_pairs:
        for k, v in extra_pairs.items():
            entries.append((k, v))

    # URL-encode values for the data-check string (Telegram spec)
    encoded_entries = [(k, quote(v, safe="")) for k, v in entries]

    data_check_string = "\n".join(
        f"{k}={v}" for k, v in sorted(encoded_entries)
    )
    secret_key = hmac.new(
        b"WebAppData", bot_token.encode(), hashlib.sha256
    ).digest()
    computed_hash = hmac.new(
        secret_key, data_check_string.encode(), hashlib.sha256
    ).hexdigest()

    all_entries = encoded_entries + [("hash", computed_hash)]
    return "&".join(f"{k}={v}" for k, v in all_entries)


# =========================================================================
# _parse_init_data_pairs
# =========================================================================
class TestParseInitDataPairs:
    def test_basic_pairs(self):
        result = _parse_init_data_pairs("a=1&b=2&c=3")
        assert result == [("a", "1"), ("b", "2"), ("c", "3")]

    def test_url_encoded_values_preserved(self):
        """Values must NOT be decoded — raw URL-encoded form is needed for HMAC."""
        result = _parse_init_data_pairs("user=%7B%22id%22%3A123%7D")
        assert result == [("user", "%7B%22id%22%3A123%7D")]

    def test_empty_segments_skipped(self):
        result = _parse_init_data_pairs("a=1&&b=2")
        assert result == [("a", "1"), ("b", "2")]

    def test_segment_without_equals_skipped(self):
        result = _parse_init_data_pairs("a=1&nonsense&b=2")
        assert result == [("a", "1"), ("b", "2")]

    def test_value_with_equals_sign(self):
        """Only the FIRST '=' is the separator (split maxsplit=1)."""
        result = _parse_init_data_pairs("key=a=b=c")
        assert result == [("key", "a=b=c")]

    def test_empty_string(self):
        assert _parse_init_data_pairs("") == []

    def test_single_pair(self):
        assert _parse_init_data_pairs("hash=abc123") == [("hash", "abc123")]


# =========================================================================
# validate_telegram_init_data
# =========================================================================
class TestValidateTelegramInitData:
    def test_valid_init_data_returns_user(self):
        user = {"id": 42, "first_name": "Test"}
        init_data = _build_init_data(BOT_TOKEN, user)
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is not None
        assert result["id"] == 42
        assert result["first_name"] == "Test"

    def test_wrong_bot_token_returns_none(self):
        user = {"id": 42, "first_name": "Test"}
        init_data = _build_init_data(BOT_TOKEN, user)
        result = validate_telegram_init_data(init_data, "wrong-token")
        assert result is None

    def test_tampered_hash_returns_none(self):
        user = {"id": 42, "first_name": "Test"}
        init_data = _build_init_data(BOT_TOKEN, user)
        # Replace hash with garbage
        init_data = init_data.split("&hash=")[0] + "&hash=deadbeef"
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is None

    def test_missing_hash_returns_none(self):
        init_data = "auth_date=1234&user=%7B%22id%22%3A42%7D"
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is None

    def test_empty_init_data_returns_none(self):
        assert validate_telegram_init_data("", BOT_TOKEN) is None

    def test_empty_bot_token_returns_none(self):
        user = {"id": 42, "first_name": "Test"}
        init_data = _build_init_data(BOT_TOKEN, user)
        assert validate_telegram_init_data(init_data, "") is None

    def test_placeholder_bot_token_returns_none(self):
        user = {"id": 42, "first_name": "Test"}
        init_data = _build_init_data(BOT_TOKEN, user)
        assert validate_telegram_init_data(init_data, "REPLACE_WITH_TOKEN") is None

    def test_expired_auth_date_returns_none(self):
        user = {"id": 42, "first_name": "Test"}
        # auth_date 2 days ago (default max_age is 86400 = 1 day)
        old_auth_date = int(time.time()) - 172800
        init_data = _build_init_data(BOT_TOKEN, user, auth_date=old_auth_date)
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is None

    def test_recent_auth_date_passes(self):
        user = {"id": 42, "first_name": "Test"}
        init_data = _build_init_data(BOT_TOKEN, user, auth_date=int(time.time()))
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is not None

    def test_custom_max_age_shorter_than_default(self):
        user = {"id": 42, "first_name": "Test"}
        # 30 minutes ago
        auth_date = int(time.time()) - 1800
        init_data = _build_init_data(BOT_TOKEN, user, auth_date=auth_date)
        # With max_age_seconds=3600 (1h), 30min should pass
        result = validate_telegram_init_data(init_data, BOT_TOKEN, max_age_seconds=3600)
        assert result is not None
        # With max_age_seconds=600 (10min), 30min should fail
        result = validate_telegram_init_data(init_data, BOT_TOKEN, max_age_seconds=600)
        assert result is None

    def test_missing_user_field_returns_none(self):
        """init_data without 'user' key → None."""
        auth_date = int(time.time())
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        data_check_string = f"auth_date={auth_date}"
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        init_data = f"auth_date={auth_date}&hash={computed_hash}"
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is None

    def test_user_without_id_returns_none(self):
        """user JSON exists but has no 'id' field → None."""
        user = {"first_name": "NoId"}
        init_data = _build_init_data(BOT_TOKEN, user)
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is None

    def test_invalid_user_json_returns_none(self):
        """user value is not valid JSON → None (caught by except)."""
        auth_date = int(time.time())
        secret_key = hmac.new(b"WebAppData", BOT_TOKEN.encode(), hashlib.sha256).digest()
        pairs = sorted([
            ("auth_date", str(auth_date)),
            ("user", "not-json"),
        ])
        data_check_string = "\n".join(f"{k}={quote(v, safe='')}" for k, v in pairs)
        computed_hash = hmac.new(secret_key, data_check_string.encode(), hashlib.sha256).hexdigest()
        user_encoded = quote("not-json", safe="")
        init_data = f"auth_date={auth_date}&user={user_encoded}&hash={computed_hash}"
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is None

    def test_extra_fields_preserved_in_hmac(self):
        """Extra initData fields (like query_id) must be part of HMAC."""
        user = {"id": 99, "first_name": "Extra"}
        init_data = _build_init_data(
            BOT_TOKEN, user, extra_pairs={"query_id": "QQQ", "chat_type": "private"}
        )
        result = validate_telegram_init_data(init_data, BOT_TOKEN)
        assert result is not None
        assert result["id"] == 99
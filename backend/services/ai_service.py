"""AI assistant with Gemini → OpenRouter Llama → DeepSeek failover."""

from datetime import date
from typing import Any, Optional

import httpx

from backend.config import get_settings
import time

COOLDOWN_PREFIX = "ai:cooldown:"
MSG_COUNT_PREFIX = "ai:msgs:"
IMG_COUNT_PREFIX = "ai:imgs:"

_memory_cache: dict[str, dict[str, Any]] = {}


def _today_key(prefix: str, user_id: str) -> str:
    return f"{prefix}{user_id}:{date.today().isoformat()}"


def _cache_get(key: str) -> Optional[str]:
    entry = _memory_cache.get(key)
    if not entry:
        return None
    if entry["expires_at"] <= time.time():
        _memory_cache.pop(key, None)
        return None
    return entry["value"]


def _cache_set(key: str, value: str, ttl_seconds: int) -> None:
    _memory_cache[key] = {
        "value": value,
        "expires_at": time.time() + ttl_seconds,
    }


def check_rate_limits(user_id: str) -> dict[str, Any]:
    settings = get_settings()
    uid = str(user_id)

    cooldown = _cache_get(f"{COOLDOWN_PREFIX}{uid}")
    if cooldown:
        return {"allowed": False, "reason": "cooldown", "retry_after": settings.AI_COOLDOWN_SECONDS}

    msg_raw = _cache_get(_today_key(MSG_COUNT_PREFIX, uid))
    msg_count = int(msg_raw) if msg_raw and msg_raw.isdigit() else 0
    if msg_count >= settings.AI_DAILY_MESSAGE_LIMIT:
        return {"allowed": False, "reason": "daily_message_limit", "used": msg_count}

    img_raw = _cache_get(_today_key(IMG_COUNT_PREFIX, uid))
    img_count = int(img_raw) if img_raw and img_raw.isdigit() else 0

    return {
        "allowed": True,
        "messages_used": msg_count,
        "messages_limit": settings.AI_DAILY_MESSAGE_LIMIT,
        "images_used": img_count,
        "images_limit": settings.AI_DAILY_IMAGE_LIMIT,
    }


def record_usage(user_id: str, has_image: bool = False) -> None:
    settings = get_settings()
    uid = str(user_id)

    _cache_set(f"{COOLDOWN_PREFIX}{uid}", "1", settings.AI_COOLDOWN_SECONDS)

    msg_key = _today_key(MSG_COUNT_PREFIX, uid)
    msg_raw = _cache_get(msg_key)
    msg_count = int(msg_raw) + 1 if msg_raw and msg_raw.isdigit() else 1
    _cache_set(msg_key, str(msg_count), 86400)

    if has_image:
        img_key = _today_key(IMG_COUNT_PREFIX, uid)
        img_raw = _cache_get(img_key)
        img_count = int(img_raw) + 1 if img_raw and img_raw.isdigit() else 1
        _cache_set(img_key, str(img_count), 86400)


def _build_prompt(message: str, history: list[dict], image_b64: Optional[str]) -> str:
    parts = [
        "You are Amir BTC Assistant, a helpful crypto trading assistant. "
        "Answer concisely in the user's language (Persian or English).",
    ]
    for h in history[-6:]:
        role = h.get("role", "user")
        content = h.get("content", "")
        parts.append(f"{role}: {content}")
    parts.append(f"user: {message}")
    if image_b64:
        parts.append("[User attached an image]")
    return "\n".join(parts)


async def _call_gemini(prompt: str, image_b64: Optional[str]) -> str:
    settings = get_settings()
    if not settings.GEMINI_API_KEY:
        raise RuntimeError("Gemini not configured")

    url = f"https://generativelanguage.googleapis.com/v1beta/models/gemini-2.0-flash:generateContent?key={settings.GEMINI_API_KEY}"
    parts: list[dict] = [{"text": prompt}]
    if image_b64:
        parts.append({"inline_data": {"mime_type": "image/jpeg", "data": image_b64}})

    payload = {"contents": [{"parts": parts}]}
    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(url, json=payload)
        res.raise_for_status()
        data = res.json()
        candidates = data.get("candidates", [])
        if not candidates:
            raise RuntimeError("Empty Gemini response")
        return candidates[0]["content"]["parts"][0]["text"]


async def _call_openrouter(prompt: str) -> str:
    settings = get_settings()
    if not settings.OPENROUTER_API_KEY:
        raise RuntimeError("OpenRouter not configured")

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            "https://openrouter.ai/api/v1/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.OPENROUTER_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "meta-llama/llama-3.3-70b-instruct:free",
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        res.raise_for_status()
        data = res.json()
        return data["choices"][0]["message"]["content"]


async def _call_deepseek(prompt: str) -> str:
    settings = get_settings()
    if not settings.DEEPSEEK_API_KEY:
        raise RuntimeError("DeepSeek not configured")

    async with httpx.AsyncClient(timeout=30) as client:
        res = await client.post(
            "https://api.deepseek.com/chat/completions",
            headers={
                "Authorization": f"Bearer {settings.DEEPSEEK_API_KEY}",
                "Content-Type": "application/json",
            },
            json={
                "model": "deepseek-chat",
                "messages": [{"role": "user", "content": prompt}],
            },
        )
        res.raise_for_status()
        data = res.json()
        return data["choices"][0]["message"]["content"]


async def chat(
    user_id: str,
    message: str,
    history: list[dict] | None = None,
    image_data: Optional[str] = None,
) -> dict[str, Any]:
    limits = check_rate_limits(user_id)
    if not limits["allowed"]:
        return {"status": "error", **limits}

    settings = get_settings()
    has_image = bool(image_data)
    if has_image:
        img_raw = _cache_get(_today_key(IMG_COUNT_PREFIX, str(user_id)))
        img_count = int(img_raw) if img_raw and img_raw.isdigit() else 0
        if img_count >= settings.AI_DAILY_IMAGE_LIMIT:
            return {"status": "error", "reason": "daily_image_limit", "allowed": False}

    image_b64 = None
    if image_data:
        if "," in image_data:
            image_b64 = image_data.split(",", 1)[1]
        else:
            image_b64 = image_data

    prompt = _build_prompt(message, history or [], image_b64)
    providers = [
        ("gemini", lambda: _call_gemini(prompt, image_b64)),
        ("openrouter", lambda: _call_openrouter(prompt)),
        ("deepseek", lambda: _call_deepseek(prompt)),
    ]

    last_error = None
    for name, fn in providers:
        try:
            reply = await fn()
            record_usage(user_id, has_image=has_image)
            return {"status": "success", "reply": reply, "provider": name}
        except Exception as exc:
            last_error = str(exc)
            continue

    return {"status": "error", "reason": "all_providers_failed", "detail": last_error}

# endregion

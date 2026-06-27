"""Live economic calendar from public ForexFactory JSON feed."""

from datetime import datetime, timedelta, timezone
from typing import Any

import requests

from backend.config import get_settings
from backend.redis_client import cache_get_json, cache_set_json

CALENDAR_CACHE_KEY = "calendar:events"

COUNTRY_FLAGS = {
    "USD": "🇺🇸", "US": "🇺🇸", "EUR": "🇪🇺", "EU": "🇪🇺", "GBP": "🇬🇧", "GB": "🇬🇧",
    "JPY": "🇯🇵", "JP": "🇯🇵", "AUD": "🇦🇺", "AU": "🇦🇺", "CAD": "🇨🇦", "CA": "🇨🇦",
    "CHF": "🇨🇭", "CH": "🇨🇭", "CNY": "🇨🇳", "CN": "🇨🇳", "NZD": "🇳🇿", "NZ": "🇳🇿",
    "All": "🌍",
}

IMPACT_MAP = {"High": "high", "Medium": "medium", "Low": "low", "Holiday": "low"}


def _parse_event_time(date_str: str, time_str: str) -> datetime | None:
    try:
        if not date_str:
            return None
        if time_str in ("All Day", "Tentative", "", None):
            dt = datetime.strptime(date_str, "%m-%d-%Y").replace(tzinfo=timezone.utc)
            return dt.replace(hour=12, minute=0)
        clean_time = time_str.replace("am", " AM").replace("pm", " PM")
        dt = datetime.strptime(f"{date_str} {clean_time}", "%m-%d-%Y %I:%M %p")
        return dt.replace(tzinfo=timezone.utc)
    except Exception:
        try:
            return datetime.strptime(date_str, "%m-%d-%Y").replace(tzinfo=timezone.utc, hour=12)
        except Exception:
            return None


def _event_status(event_dt: datetime | None, now: datetime) -> str:
    if not event_dt:
        return "upcoming"
    window = timedelta(minutes=30)
    if event_dt - window <= now <= event_dt + window:
        return "live"
    if event_dt < now:
        return "past"
    return "upcoming"


def fetch_calendar_events() -> list[dict[str, Any]]:
    settings = get_settings()
    cached = cache_get_json(CALENDAR_CACHE_KEY)
    if cached is not None:
        return cached

    events: list[dict[str, Any]] = []
    now = datetime.now(timezone.utc)
    cutoff_past = now - timedelta(days=2)
    cutoff_future = now + timedelta(days=7)

    urls = [
        "https://nfs.faireconomy.media/ff_calendar_thisweek.json",
        "https://cdn-nfs.faireconomy.media/ff_calendar_thisweek.json",
    ]

    raw = None
    for url in urls:
        try:
            res = requests.get(url, timeout=10, headers={"User-Agent": "Mozilla/5.0"})
            if res.ok:
                raw = res.json()
                break
        except Exception:
            continue

    if isinstance(raw, list):
        for item in raw:
            country = item.get("country", "US")
            event_dt = _parse_event_time(item.get("date", ""), item.get("time", ""))
            if event_dt and event_dt < cutoff_past:
                continue
            if event_dt and event_dt > cutoff_future:
                continue

            impact_raw = item.get("impact", "Medium")
            status = _event_status(event_dt, now)
            flag = COUNTRY_FLAGS.get(country, COUNTRY_FLAGS.get(country[:2], "🏳️"))

            events.append({
                "title": item.get("title", ""),
                "country": country,
                "flag": flag,
                "time": item.get("time", ""),
                "date": item.get("date", ""),
                "impact": IMPACT_MAP.get(impact_raw, "medium"),
                "impact_label": impact_raw,
                "forecast": item.get("forecast", ""),
                "previous": item.get("previous", ""),
                "actual": item.get("actual", ""),
                "status": status,
                "timestamp": event_dt.isoformat() if event_dt else None,
            })

    events.sort(key=lambda e: e.get("timestamp") or "")

    cache_set_json(CALENDAR_CACHE_KEY, events, settings.CALENDAR_CACHE_TTL)
    return events

# endregion

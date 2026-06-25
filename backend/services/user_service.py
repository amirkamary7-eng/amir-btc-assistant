from datetime import datetime, timezone
from typing import Any, Optional

from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import User, WatchlistItem, utcnow


def _user_to_dict(user: User, watchlist: Optional[list[str]] = None) -> dict[str, Any]:
    return {
        "user_id": user.telegram_id,
        "username": user.username,
        "first_name": user.first_name,
        "last_name": user.last_name,
        "lang": user.lang,
        "channel_joined": user.channel_joined,
        "channel_verified_at": user.channel_verified_at.isoformat() if user.channel_verified_at else None,
        "created_at": user.created_at.isoformat() if user.created_at else None,
        "updated_at": user.updated_at.isoformat() if user.updated_at else None,
        "watchlist": watchlist if watchlist is not None else get_watchlist_symbols(user),
    }


def get_user(db: Session, telegram_id: str) -> Optional[User]:
    return db.get(User, str(telegram_id))


def get_watchlist_symbols(user: User) -> list[str]:
    return [item.symbol for item in sorted(user.watchlist_items, key=lambda x: x.position)]


def bootstrap_user(
    db: Session,
    *,
    telegram_id: str,
    username: Optional[str] = None,
    first_name: Optional[str] = None,
    last_name: Optional[str] = None,
    lang: Optional[str] = None,
) -> dict[str, Any]:
    user = get_user(db, telegram_id)
    now = utcnow()

    if user is None:
        user = User(
            telegram_id=str(telegram_id),
            username=username,
            first_name=first_name,
            last_name=last_name,
            lang=lang if lang in ("fa", "en") else "fa",
            channel_joined=False,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        db.flush()
    else:
        if username is not None:
            user.username = username
        if first_name is not None:
            user.first_name = first_name
        if last_name is not None:
            user.last_name = last_name
        if lang in ("fa", "en"):
            user.lang = lang
        user.updated_at = now

    db.refresh(user)
    return _user_to_dict(user)


def update_user_settings(db: Session, telegram_id: str, *, lang: Optional[str] = None) -> Optional[dict[str, Any]]:
    user = get_user(db, telegram_id)
    if not user:
        return None
    if lang in ("fa", "en"):
        user.lang = lang
    user.updated_at = utcnow()
    db.flush()
    return _user_to_dict(user)


def set_user_channel_joined(db: Session, telegram_id: str, joined: bool) -> None:
    user = get_user(db, telegram_id)
    now = utcnow()
    if user is None:
        user = User(
            telegram_id=str(telegram_id),
            lang="fa",
            channel_joined=joined,
            channel_verified_at=now if joined else None,
            created_at=now,
            updated_at=now,
        )
        db.add(user)
    else:
        user.channel_joined = joined
        user.channel_verified_at = now if joined else None
        user.updated_at = now


def get_watchlist(db: Session, telegram_id: str) -> list[str]:
    user = get_user(db, telegram_id)
    if not user:
        return []
    return get_watchlist_symbols(user)


def replace_watchlist(db: Session, telegram_id: str, symbols: list[str]) -> list[str]:
    settings = get_settings()
    cleaned: list[str] = []
    seen: set[str] = set()
    for symbol in symbols:
        sym = str(symbol).upper().strip()
        if not sym or sym in seen:
            continue
        seen.add(sym)
        cleaned.append(sym)
        if len(cleaned) >= settings.MAX_WATCHLIST:
            break

    user = get_user(db, telegram_id)
    now = utcnow()
    if user is None:
        user = User(
            telegram_id=str(telegram_id),
            lang="fa",
            created_at=now,
            updated_at=now,
        )
        db.add(user)
        db.flush()

    user.watchlist_items.clear()
    db.flush()
    for index, symbol in enumerate(cleaned):
        user.watchlist_items.append(WatchlistItem(user_id=user.telegram_id, symbol=symbol, position=index))
    user.updated_at = now
    db.flush()
    return cleaned

"""Analysis CRUD with Redis cache invalidation."""

import uuid
from typing import Any, Optional

from sqlalchemy.orm import Session

from backend.config import get_settings
from backend.models import Analysis, utcnow
from backend.redis_client import cache_delete, cache_get_json, cache_set_json

ANALYSES_LIST_KEY = "analyses:list"
ANALYSES_VERSION_KEY = "analyses:version"


def _bump_version() -> int:
    from backend.redis_client import cache_get_json

    current = cache_get_json(ANALYSES_VERSION_KEY)
    try:
        version = int(current) + 1 if current is not None else 1
    except (TypeError, ValueError):
        version = 1
    cache_set_json(ANALYSES_VERSION_KEY, version, 86400 * 7)
    cache_delete(ANALYSES_LIST_KEY)
    return version


def _analysis_to_dict(a: Analysis) -> dict[str, Any]:
    return {
        "id": a.id,
        "coin": a.coin,
        "timeframe": a.timeframe,
        "image": a.image or "",
        "text": a.text,
        "author": a.author,
        "author_id": a.author_id,
        "date": a.created_at.strftime("%Y-%m-%d") if a.created_at else "",
        "created_at": a.created_at.isoformat() if a.created_at else None,
        "updated_at": a.updated_at.isoformat() if a.updated_at else None,
    }


def get_version() -> int:
    from backend.redis_client import cache_get_json

    val = cache_get_json(ANALYSES_VERSION_KEY)
    if val is None:
        return 0
    try:
        return int(val)
    except (TypeError, ValueError):
        return 0


def list_analyses(db: Session) -> list[dict[str, Any]]:
    settings = get_settings()
    cached = cache_get_json(ANALYSES_LIST_KEY)
    if cached is not None:
        return cached

    rows = db.query(Analysis).order_by(Analysis.created_at.desc()).all()
    result = [_analysis_to_dict(a) for a in rows]
    cache_set_json(ANALYSES_LIST_KEY, result, settings.ANALYSIS_CACHE_TTL)
    return result


def create_analysis(
    db: Session,
    *,
    coin: str,
    timeframe: str,
    image: str,
    text: str,
    author: str,
    author_id: Optional[str] = None,
) -> dict[str, Any]:
    now = utcnow()
    analysis = Analysis(
        id=str(uuid.uuid4())[:12],
        coin=coin.upper().strip(),
        timeframe=timeframe or "1d",
        image=image or "",
        text=text,
        author=author,
        author_id=author_id,
        created_at=now,
        updated_at=now,
    )
    db.add(analysis)
    db.flush()
    _bump_version()
    return _analysis_to_dict(analysis)


def update_analysis(
    db: Session,
    analysis_id: str,
    *,
    coin: str,
    timeframe: str,
    image: str,
    text: str,
) -> Optional[dict[str, Any]]:
    analysis = db.get(Analysis, analysis_id)
    if not analysis:
        return None
    analysis.coin = coin.upper().strip()
    analysis.timeframe = timeframe or analysis.timeframe
    analysis.image = image or analysis.image
    analysis.text = text
    analysis.updated_at = utcnow()
    db.flush()
    _bump_version()
    return _analysis_to_dict(analysis)


def delete_analysis(db: Session, analysis_id: str) -> bool:
    analysis = db.get(Analysis, analysis_id)
    if not analysis:
        return False
    db.delete(analysis)
    db.flush()
    _bump_version()
    return True

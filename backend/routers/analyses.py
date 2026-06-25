from typing import Optional

from fastapi import APIRouter, Query
from fastapi.responses import JSONResponse
from pydantic import BaseModel, Field

from backend.config import get_settings
from backend.database import database_ready, get_db_session
from backend.services.analysis_service import (
    create_analysis,
    delete_analysis,
    get_version,
    list_analyses,
    update_analysis,
)

router = APIRouter(prefix="/analyses", tags=["analyses"])


class AnalysisCreate(BaseModel):
    coin: str = Field(min_length=1, max_length=16)
    timeframe: str = Field(default="1d", max_length=16)
    image: str = Field(default="", max_length=512)
    text: str = Field(min_length=1)
    author: str = Field(min_length=1, max_length=128)
    author_id: Optional[str] = None


class AnalysisUpdate(BaseModel):
    coin: str = Field(min_length=1, max_length=16)
    timeframe: str = Field(default="1d", max_length=16)
    image: str = Field(default="", max_length=512)
    text: str = Field(min_length=1)


def _is_admin(user_id: str) -> bool:
    return str(user_id) == str(get_settings().ADMIN_TELEGRAM_ID)


@router.get("")
async def get_analyses(version: Optional[int] = Query(None)):
    if not database_ready():
        return {"status": "success", "analyses": [], "version": 0, "source": "no_db"}

    current_version = get_version()
    if version is not None and version == current_version:
        return {"status": "success", "analyses": None, "version": current_version, "unchanged": True}

    with get_db_session() as db:
        analyses = list_analyses(db)
    return {"status": "success", "analyses": analyses, "version": current_version}


@router.post("")
async def post_analysis(payload: AnalysisCreate, admin_id: str = Query(...)):
    if not _is_admin(admin_id):
        return JSONResponse(status_code=403, content={"status": "error", "message": "Unauthorized"})
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        item = create_analysis(
            db,
            coin=payload.coin,
            timeframe=payload.timeframe,
            image=payload.image,
            text=payload.text,
            author=payload.author,
            author_id=payload.author_id or admin_id,
        )
    return {"status": "success", "analysis": item, "version": get_version()}


@router.put("/{analysis_id}")
async def put_analysis(analysis_id: str, payload: AnalysisUpdate, admin_id: str = Query(...)):
    if not _is_admin(admin_id):
        return JSONResponse(status_code=403, content={"status": "error", "message": "Unauthorized"})
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        item = update_analysis(
            db,
            analysis_id,
            coin=payload.coin,
            timeframe=payload.timeframe,
            image=payload.image,
            text=payload.text,
        )
    if not item:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    return {"status": "success", "analysis": item, "version": get_version()}


@router.delete("/{analysis_id}")
async def remove_analysis(analysis_id: str, admin_id: str = Query(...)):
    if not _is_admin(admin_id):
        return JSONResponse(status_code=403, content={"status": "error", "message": "Unauthorized"})
    if not database_ready():
        return JSONResponse(status_code=503, content={"status": "error", "message": "Database not configured"})

    with get_db_session() as db:
        ok = delete_analysis(db, analysis_id)
    if not ok:
        return JSONResponse(status_code=404, content={"status": "error", "message": "Not found"})
    return {"status": "success", "version": get_version()}

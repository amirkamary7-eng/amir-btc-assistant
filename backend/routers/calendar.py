from fastapi import APIRouter

from backend.services.calendar_service import fetch_calendar_events

router = APIRouter(prefix="/calendar", tags=["calendar"])


@router.get("/events")
async def get_calendar_events():
    events = fetch_calendar_events()
    return {"status": "success", "events": events}

from fastapi import APIRouter, Query

from backend.services.chart_service import resolve_chart_exchange

router = APIRouter(prefix="/charts", tags=["charts"])


@router.get("/resolve")
async def resolve_chart(symbol: str = Query(..., min_length=1, max_length=16)):
    result = resolve_chart_exchange(symbol)
    return {"status": "success", **result}

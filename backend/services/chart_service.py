"""Multi-exchange chart symbol resolution with Redis caching."""

import requests

from backend.config import get_settings
from backend.redis_client import cache_get, cache_set

EXCHANGE_ORDER = [
    ("BINANCE", "binance"),
    ("BYBIT", "bybit"),
    ("OKX", "okx"),
    ("KUCOIN", "kucoin"),
    ("GATEIO", "gateio"),
    ("MEXC", "mexc"),
]

TV_PREFIX = {
    "binance": "BINANCE",
    "bybit": "BYBIT",
    "okx": "OKX",
    "kucoin": "KUCOIN",
    "gateio": "GATEIO",
    "mexc": "MEXC",
}


def _cache_key(symbol: str) -> str:
    return f"chart:exchange:{symbol.upper()}"


def _check_binance(symbol: str) -> bool:
    try:
        res = requests.get(
            "https://api.binance.com/api/v3/ticker/price",
            params={"symbol": f"{symbol}USDT"},
            timeout=5,
        )
        return res.ok and "price" in res.json()
    except Exception:
        return False


def _check_bybit(symbol: str) -> bool:
    try:
        res = requests.get(
            "https://api.bybit.com/v5/market/tickers",
            params={"category": "spot", "symbol": f"{symbol}USDT"},
            timeout=5,
        )
        data = res.json()
        return res.ok and data.get("retCode") == 0 and data.get("result", {}).get("list")
    except Exception:
        return False


def _check_okx(symbol: str) -> bool:
    try:
        res = requests.get(
            "https://www.okx.com/api/v5/market/ticker",
            params={"instId": f"{symbol}-USDT"},
            timeout=5,
        )
        data = res.json()
        return res.ok and data.get("code") == "0" and data.get("data")
    except Exception:
        return False


def _check_kucoin(symbol: str) -> bool:
    try:
        res = requests.get(
            "https://api.kucoin.com/api/v1/market/orderbook/level1",
            params={"symbol": f"{symbol}-USDT"},
            timeout=5,
        )
        data = res.json()
        return res.ok and data.get("code") == "200000"
    except Exception:
        return False


def _check_gateio(symbol: str) -> bool:
    try:
        res = requests.get(
            "https://api.gateio.ws/api/v4/spot/tickers",
            params={"currency_pair": f"{symbol}_USDT"},
            timeout=5,
        )
        return res.ok and isinstance(res.json(), list) and len(res.json()) > 0
    except Exception:
        return False


def _check_mexc(symbol: str) -> bool:
    try:
        res = requests.get(
            "https://api.mexc.com/api/v3/ticker/price",
            params={"symbol": f"{symbol}USDT"},
            timeout=5,
        )
        return res.ok and "price" in res.json()
    except Exception:
        return False


CHECKERS = {
    "binance": _check_binance,
    "bybit": _check_bybit,
    "okx": _check_okx,
    "kucoin": _check_kucoin,
    "gateio": _check_gateio,
    "mexc": _check_mexc,
}


def resolve_chart_exchange(symbol: str) -> dict:
    """Return TradingView symbol and exchange for a coin, with fallback chain."""
    sym = symbol.upper().strip()
    if not sym:
        return {"found": False, "symbol": None, "exchange": None, "tv_symbol": None}

    settings = get_settings()
    cached = cache_get(_cache_key(sym))
    if cached:
        for _, key in EXCHANGE_ORDER:
            if cached == key:
                tv_prefix = TV_PREFIX[key]
                return {
                    "found": True,
                    "symbol": sym,
                    "exchange": key,
                    "tv_symbol": f"{tv_prefix}:{sym}USDT",
                    "cached": True,
                }

    for tv_name, key in EXCHANGE_ORDER:
        checker = CHECKERS.get(key)
        if checker and checker(sym):
            cache_set(_cache_key(sym), key, settings.CHART_EXCHANGE_CACHE_TTL)
            return {
                "found": True,
                "symbol": sym,
                "exchange": key,
                "tv_symbol": f"{tv_name}:{sym}USDT",
                "cached": False,
            }

    return {"found": False, "symbol": sym, "exchange": None, "tv_symbol": None, "cached": False}

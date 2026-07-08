# Forex Expansion — Design Report

## 1. Architecture Proposal

Three-tab market structure:
```
[Crypto] [Forex] [Watchlist]
```

- **Crypto tab**: Current 200 coins from CoinCap (unchanged)
- **Forex tab**: 9 major pairs + 2 metals (hardcoded list, no pagination needed)
- **Watchlist tab**: Unified — can contain both crypto and forex symbols

Data flow:
```
Frontend → /api/market?section=forex → worker-proxy.js → external Forex API → cached response
```

## 2. API Source Recommendation

**Primary**: `https://api.exchangerate-api.com/v4/latest/USD` (free, no key, reliable)
- Returns all major currency pairs against USD
- Rate limited but sufficient for 30s-60s refresh

**Alternative**: `https://open.er-api.com/v6/latest/USD` (free, no key)

**For metals (XAU/XAG)**: Use a dedicated metals API or embed rates in the backend config as env vars.

## 3. Search Integration Plan

Unified search bar with prefix detection:
```
User types "EUR"  → searches both crypto symbols AND forex pairs
User types "Gold"  → matches XAUUSD via alias mapping
```

Alias map (hardcoded):
```js
const FOREX_ALIASES = {
  'gold': 'XAUUSD', 'طلا': 'XAUUSD',
  'silver': 'XAGUSD', 'نقره': 'XAGUSD',
  'euro': 'EURUSD', 'یورو': 'EURUSD',
  // ...
};
```

## 4. Watchlist Integration Plan

Current watchlist stores symbols in localStorage as `string[]`. Forex symbols would use the same array:
```js
watchlist = ['BTC', 'ETH', 'EURUSD', 'XAUUSD']
```

Backend `/api/watchlist` (DB-backed) would also store forex symbols. The `openCoinDetail()` function would branch:
- If symbol matches crypto → show TradingView + crypto stats
- If symbol matches forex → show a simplified forex card (no TradingView widget, no market cap)

## 5. Database Impact

**Minimal**. Forex pairs are not user-generated. The `watchlist` table already stores arbitrary strings. No schema change needed.

If price alerts are desired for forex, the existing `alerts` table works as-is since it stores `symbol` (string) + `target_price` (number).

## 6. UI Changes

### New Tab Buttons
Add "Forex" button between "Losers" and "Watchlist" in `.market-tabs`.

### Forex Card Layout
```
┌─────────────────────────────┐
│ 🇪🇺 EUR/USD    1.0847       │
│              ▲ +0.12%        │
└─────────────────────────────┘
```

- No coin icon (use flag emoji or currency symbol)
- No market cap / volume / rank (not applicable)
- Simplified detail modal: price, 24h change, alert form only

### Coin Detail Modal Branching
```
if (isForexSymbol(symbol)) {
  // Show simplified forex view
} else {
  // Show full crypto view (current behavior)
}
```

## 7. Performance Impact

**Negligible**. 
- 11 forex pairs = ~2KB JSON (vs 200 crypto coins = ~50KB)
- One additional API call per market load
- Can be cached in KV with same 2min TTL
- Total frontend bundle increase: ~3KB (alias map + render function)

## 8. Cost Impact

**Zero additional cost**.
- ExchangeRate API: Free tier, no API key needed
- No new Cloudflare Workers paid features
- KV storage: 11 additional keys (~1KB total)
- No database writes for forex data (read-only)

## Proposed Forex Assets

| Symbol | Display | Category |
|--------|---------|----------|
| EURUSD | EUR/USD | Major |
| GBPUSD | GBP/USD | Major |
| USDJPY | USD/JPY | Major |
| USDCHF | USD/CHF | Major |
| AUDUSD | AUD/USD | Major |
| NZDUSD | NZD/USD | Major |
| USDCAD | USD/CAD | Major |
| XAUUSD | Gold/USD | Metal |
| XAGUSD | Silver/USD | Metal |

## Implementation Phases

**Phase 1** (Backend): Add `/api/market?section=forex` endpoint in worker-proxy.js
**Phase 2** (Frontend): Add Forex tab + render function + search integration
**Phase 3** (Watchlist): Unified watchlist for crypto + forex
**Phase 4** (Polish): Forex detail modal, alerts, RTL labels
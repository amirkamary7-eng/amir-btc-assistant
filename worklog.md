# Worklog — Market P0/P1 Fixes

---
Task ID: init
Agent: main
Task: Initialize worklog for Market P0/P1 fixes

Work Log:
- Located project at `/home/z/amir-btc-work/`
- Read and analyzed all Market-related code

Stage Summary:
- Ready to begin P0-1 through P1-7

---
Task ID: P0-1
Agent: main
Task: Add Skeleton Loader for Market

Work Log:
- Added 6 CSS classes in style.css (`.market-skeleton`, `.-left`, `.-right`, `.-icon`, `.-text`, `.-line`, `.-block`)
- Added skeleton rendering in `loadMarketData()` before fetch, only when `!allCoins.length`
- 8 shimmer rows matching existing news skeleton pattern

Stage Summary:
- Commit: 3306eb6
- Tests: 109/109 pass

---
Task ID: P0-2
Agent: main
Task: Move Market Data fetching to Backend Worker

Work Log:
- Added `handleMarketData()` in worker-proxy.js (~75 lines)
  - CoinGecko primary, CoinCap fallback, stale-while-error
  - KV cache with 120s TTL
  - Uses `market_cap_rank` for CoinGecko, `item.rank` for CoinCap
  - CoinCap fallback includes image URLs
- Added `GET /api/market` route
- Modified `loadMarketData()` in app.js: backend-first via `apiFetch('/api/market')`, keeps direct fallback

Stage Summary:
- Commit: 60292e1
- Tests: 109/109 pass

---
Task ID: P1-1
Agent: main
Task: Fix XSS in renderMarket()

Work Log:
- `escapeHtml()` on c.symbol, c.name, icon URL
- Replaced `onclick="openCoinDetail('${c.symbol}')` with `data-symbol` + `this.dataset.symbol`
- Same for toggleWatchlist onclick
- `encodeURIComponent()` in icon URL

Stage Summary:
- Commit: 0a15792
- Tests: 109/109 pass

---
Task ID: P1-2
Agent: main
Task: Fix XSS in Modal and Watchlist

Work Log:
- `renderWatchlist()`: escape symbol, data-attribute pattern, image URL fix
- `populateCoinModal()`: escape symbol/name, data-attribute pattern
- `renderActiveAlerts()`: escape symbol/id, data-id attribute

Stage Summary:
- Commit: bb1b6cc
- Tests: 109/109 pass

---
Task ID: P1-3
Agent: main
Task: Convert Exchange Resolution from Serial to Parallel

Work Log:
- Replaced `for...of` loop with `Promise.any()` over all exchanges
- All 6 exchanges queried simultaneously, first success wins
- Null prices throw to reject the Promise.any entry

Stage Summary:
- Commit: 1e96e05
- Tests: 109/109 pass

---
Task ID: P1-4
Agent: main
Task: Fix renderSummary dead logic

Work Log:
- Confirmed `#global-mcap`, `#global-volume`, `#btc-dom` don't exist in HTML
- Replaced function body with explicit no-op stub
- Call sites preserved for future re-enablement

Stage Summary:
- Commit: c1505f7
- Tests: 109/109 pass

---
Task ID: P1-5
Agent: main
Task: Fix TradingView Widget Memory Leak

Work Log:
- Added `let currentTvWidget = null` module variable
- `openCoinDetail()`: destroys previous widget before creating new
- `closeCoinDetail()`: destroys widget on modal close
- `try/catch` around `.remove()` for safety

Stage Summary:
- Commit: 73216e3
- Tests: 109/109 pass

---
Task ID: P1-6
Agent: main
Task: Fix CoinCap Fallback Icons

Work Log:
- Frontend direct fallback: `image: ''` → coincap icon URL
- Backend already fixed in P0-2 commit

Stage Summary:
- Commit: 72efa87
- Tests: 109/109 pass

---
Task ID: P1-7
Agent: main
Task: Fix Market Rank in CoinCap Fallback

Work Log:
- Frontend `fetchCoinGecko()`: `index + 1` → `item.market_cap_rank || (index + 1)`
- Frontend CoinCap fallback: `i + 1` → `parseInt(item.rank, 10) || 0` (done in P1-6)
- Backend already correct from P0-2

Stage Summary:
- Commit: 67554f7
- Tests: 109/109 pass

---
Task ID: audit
Agent: sub-agent
Task: Final regression audit

Work Log:
- Full re-read of all modified code sections
- Cross-referenced all DOM IDs between JS and HTML (9 IDs, all valid)
- Verified no broken imports, no syntax errors
- Ran 109/109 tests: all green

Stage Summary:
- ALL 9 FIXES PASS — Zero regressions
- Pre-existing: duplicate `escapeHtml` definitions (low severity, not a regression)
- All DOM IDs verified present in HTML

---
Task ID: session3-market-overhaul
Agent: main
Task: Market Layout Overhaul + Forex Tab + Unified Search

Work Log:
- P0-1: Reordered market page layout — Summary Bar → Search → Tabs → Market List
- P0-2: Improved market list alignment (flex-basis, max-width names, 32px icons, tabular-nums)
- P0-4: Replaced Trending tab with Forex tab (Crypto, Forex, Gainers, Losers, Watchlist)
- P0-5: Backend /api/forex endpoint — 11 pairs (7 major, 2 cross, 2 metals) via frankfurter.app
- P0-6: Unified search across crypto (200 coins) + forex (11 pairs) simultaneously
- P0-7: Verified single exchange badge (previous fix confirmed, no duplicates)
- P0-8: Verified English-only timeframe labels (1m, 5m, 15m, 1H, 4H, 1D, 1W)
- P0-9: Forex detail modal with TradingView chart (FX:*/OANDA:XAUUSD/OANDA:XAGUSD)
- Summary bar hidden on Forex tab, alert section hidden for forex pairs
- Mobile 360px optimizations for coin items
- i18n: Added tab_forex key in FA and EN

Stage Summary:
- Commit: 189a9c3
- Tests: 109/109 pass
- Push: 58131ab..189a9c3 main → main
- Files modified: app.js, index.html, style.css, worker-proxy.js

### Unresolved / Future
- Forex prices from frankfurter.app may not include gold/silver (XAU/XAG not standard currencies)
- Could add NASDAQ/SPX500 as TradingView-only entries in future (user mentioned in search requirements)---
Task ID: 1
Agent: main
Task: Market UI/UX Complete Redesign - Hierarchical Tab Structure

Work Log:
- Analyzed current 5-flat-tab structure (Overview, Forex, Gainers, Losers, Watchlist)
- Redesigned to hierarchical: 3 main tabs (Crypto/Forex/Watchlist) + Crypto sub-tabs (Top Market/Gainers/Losers)
- Updated index.html: Replaced old .market-tabs with .market-main-tabs (3 equal grid cards) + .market-sub-tabs (3 flex buttons)
- Added SVG icons to main tabs (dollar, currency, star)
- Updated style.css: New .main-tab-btn (card-style, grid 3-col, gradient active state, glow border, bottom accent line)
- Added .market-sub-tabs with smooth show/hide animation (max-height + opacity transition)
- Updated app.js: Added switchMainTab() and switchSubTab() functions
- Kept switchMarketTab() as legacy backward-compat wrapper
- Added currentMainTab and currentSubTab state variables
- Fixed summary bar: visible for Crypto+Watchlist, hidden only for Forex
- Added i18n keys: tab_crypto (FA: کریپتو / EN: Crypto), tab_top_market (FA: برترین‌ها / EN: Top Market)
- Mobile optimization: 360px media query updated for new tabs
- Verified: 109/109 backend tests pass
- Browser verification at 390px and 360px: all tabs, sub-tabs, search, state persistence working

Stage Summary:
- Structure changed from 5 flat tabs → 3 main + 3 sub (hierarchical)
- Main tabs: equal-width CSS grid cards with SVG icons, gradient active state
- Sub-tabs: smooth show/hide animation, only visible under Crypto
- Summary bar logic: hidden only for Forex (not Watchlist)
- Files modified: index.html, style.css, app.js
- No breaking changes: legacy switchMarketTab still works

---
Task ID: qa-styling-features
Agent: cron-qa
Task: Styling improvements + new features (QA round)

Work Log:
- Committed uncommitted changes from previous session (e301b16): search icon, FAB logic, count badges, forex price fix
- Bottom nav: added active tab top accent line (::before pseudo), press scale animation, active icon scale-up, -webkit-backdrop-filter
- Coin list: staggered fade-in animation on tab switch (first 3 items, only during .fade-in), hover/active bg
- Info bar: added HH:MM timestamp via .coin-list-time
- Watchlist: mini toast notification on toggle (showMiniToast), star press scale(1.3x), toast CSS pill with slide-up
- Visual: summary letter-spacing, FAB gradient/hover, empty state padding, forex left-border accent
- Fixed forex price calculation bug (frankfurter rates were inverted)

Stage Summary:
- Commits: e301b16, 4022c70
- Tests: 109/109 pass
- All features verified via agent-browser programmatic QA
- No bugs, no regressions

### Current Project Status
- Market page: hierarchical tabs (3 main + 3 sub), card-style, glassmorphism
- Features: unified search, forex tab, watchlist with toast, FAB context-aware, count badges
- Styling: dark theme, mobile-first (360px/390px), RTL, animations
- Backend: 109 tests passing, /api/market + /api/forex endpoints

### Unresolved / Risks
- frankfurter.app doesn't support XAU/XAG → metals show 0 price
- No pull-to-refresh gesture (only programmatic refresh)
- CoinCap direct fallback still used when backend unavailable (rate limits possible)
- Next priority: improve coin detail modal, add market cap/volume to forex pairs

---
Task ID: cron-qa-detail-refresh-header
Agent: cron-qa
Task: Coin detail modal improvements + market page header + refresh button

Work Log:
- Coin detail modal: added icon (40px), rank badge, watchlist star button in header
- New functions: updateDetailWatchBtn(), toggleWatchlistFromDetail()
- Market page: added title header + circular refresh button with spin animation
- refreshMarketData() calls loadMarketData(true), button spins during load
- Added @keyframes spin for refresh icon rotation
- CSS: .detail-modal-header, .detail-modal-identity, .detail-watch-btn, .market-page-header, .market-refresh-btn
- 360px: reduced header padding, smaller title font

Stage Summary:
- Commit: 92dcd9d
- Tests: 109/109 pass
- Browser QA: all new elements verified (header, icon, rank, watch btn, refresh btn, functions)

### Current Project Status
- Market page: title + refresh → summary → search → 3 main tabs → sub-tabs → list
- Detail modal: icon + name + rank + watchlist star + stats grid + chart + alerts
- All features: hierarchical tabs, unified search, forex, watchlist toast, count badges, refresh
- Styling: dark glassmorphism, animations, mobile-first, RTL

### Next Priority
1. Improve home page watchlist section (card grid styling)
2. Add 24h high/low to detail stats
3. Implement pull-to-refresh gesture (touch events)
4. Fix metals (XAU/XAG) forex prices — need alternative API

---
Task ID: market-fix-phase1-9
Agent: Main Agent
Task: Execute 9-phase Market section fixes (critical, high, medium, cleanup)

Work Log:
- Phase 1 (MKT-CRITICAL-1): Added alert direction support — above/below toggle buttons in UI, pass direction to backend, map from server, checkAlerts supports both directions, renderActiveAlerts shows correct symbol (≥/≤), i18n strings, CSS styling
- Phase 2 (MKT-CRITICAL-4): Replaced broken frankfurter.app XAU/XAG calls with goldprice.org dbXRates API, metals fetched in parallel with fiat forex rates
- Phase 3 (MKT-HIGH-1): Replaced sequential exchange iteration in resolveChartExchange with Promise.any — all 7 exchanges checked concurrently
- Phase 4 (MKT-CRITICAL-3): Removed fetchCoinGecko() direct frontend call, removed CoinGecko/CoinCap fallback chain in loadMarketData, all market data flows through backend only
- Phase 5 (MKT-HIGH-2): Aligned frontend polling to 120s (matches backend MARKET_CACHE_TTL), aligned forex cache to 120s
- Phase 6 (MKT-HIGH-3): Added lastMarketFetchTime tracking, checkAlerts auto-refreshes market data if stale > 45s
- Phase 7 (MKT-HIGH-5): Added IP-based rate limiter (30 req/min) for /api/market and /api/forex using RATE_LIMITS KV
- Phase 8 (MKT-MED-1): Removed duplicate regex-based escapeHtml, kept DOM-based version
- Phase 9 (Cleanup): Deleted watchlist.js, removed POPULAR_SYMBOLS, COIN_NAMES, getCoinFullName, switchMarketTab

Verification:
- All 109 tests pass after every phase
- git status clean after every commit
- 9 clean commits pushed to origin/main

Stage Summary:
- 9 commits: acf4eaf, ed41232, f7a8b5c, 814ae14, a2b2b6e, 183f45f, afc91a3, a1b4477, ef53bb5
- Branch: main, pushed to origin
- Zero regressions, zero test failures
- All Market audit issues resolved

### Unresolved / Risks (found in post-phase audit)
- ⚠️ Phase 9 deleted watchlist.js but forgot to remove it from scripts/prepare-pages.mjs → **BUILD CRASH** (fixed below)

---
Task ID: hotfix-build-crash
Agent: Main Agent
Task: Fix Mini App not opening — build crash due to missing watchlist.js

Root Cause:
- Phase 9 (commit ef53bb5) deleted watchlist.js and its <script> tag from index.html
- BUT scripts/prepare-pages.mjs line 17 still had 'watchlist.js' in hashedFiles array
- npm run cf:pages:prepare crashed with ENOENT → no webapp/pages-dist/ → no deployment possible → Mini App broken

Fix:
- Removed 'watchlist.js' from hashedFiles array in scripts/prepare-pages.mjs
- Verified build succeeds: all 4 files hashed, index.html references correct, no watchlist artifacts
- Verified 109/109 tests pass
- Committed and pushed: e1b3cf0

Verification:
- npm run cf:pages:prepare → ✅ success (MRD87WIC-529d5a6)
- npm test → 109/109 pass
- Built index.html: only 4 JS files referenced (no watchlist.js)
- git push origin main → success

Stage Summary:
- Commit: e1b3cf0
- Mini App can now be deployed again
- Required: run `npm run cf:pages:prepare && npm run cf:pages:deploy` to deploy

---
Task ID: race-condition-fix
Agent: main
Task: Fix dashboard race condition — incomplete data on first cold open

Root Cause (confirmed via static code analysis):
- DOMContentLoaded awaits UserContext.init() (up to 8s) + bootstrapUser() (network)
- After that, 3 fire-and-forget calls start: loadMarketData, fetchAnalyses, loadImportantNews
- Dashboard sections (#slider-track, #watchlist-grid, #important-news) stay completely empty until slowest call resolves
- analyses IS loaded from localStorage at module load (line 260) but renderAnalysisSlider() was only called in .then() of fetchAnalyses()
- renderWatchlist() was only called inside loadMarketData() — needs allCoins which is [] until network completes
- On 2nd open (tab switch): switchTab() calls renderWatchlist/renderAnalysisSlider from in-memory data → appears to work
- On 2nd fresh reload: localStorage cache for analyses exists but was never used for initial render

Work Log:
- Read full app.js startup flow: DOMContentLoaded → UserContext.init → bootstrapUser → loadUser → data loading
- Added temporary __tl timeline logging to trace execution order
- Confirmed root cause: no cache-first rendering for any dashboard section
- Removed temporary logging after analysis

Phase A (commit c35d64c):
- Render analysis slider immediately from localStorage cache after bootstrapUser()
- If no cache, show skeleton placeholder instead of empty div
- Added .slider-skeleton CSS with shimmer animation

Phase B (commit 0cfd66f):
- Added skeleton placeholders for #watchlist-grid and #important-news
- Skeletons render immediately, replaced naturally when data arrives
- Added .watchlist-skeleton and .important-news-skeleton CSS

Phase C (commit 5e822e2):
- Persist allCoins to localStorage on each successful loadMarketData()
- On startup, preload allCoins from localStorage → renderWatchlist() + renderSummary() run instantly
- Phase B skeleton check skips watchlist if Phase C already rendered it

Verification:
- npm run cf:pages:prepare → ✅ (MRDA9K3M-5e822e2)
- npm test → 109/109 pass (all 3 phases)
- git push origin main → ✅ (683ef0b..5e822e2)

Stage Summary:
- 3 separate commits: c35d64c, 0cfd66f, 5e822e2
- Cold start: user sees cached slider + cached watchlist + skeletons for news (or all cached on 2nd+ visit)
- Network calls still fire and update data when they resolve
- Zero regression: no other code changed

---
Task ID: fix-api-base-deploy
Agent: main
Task: Fix Mini App not loading data — API_BASE pointing to wrong domain

Root Cause (confirmed via runtime investigation):
1. `index.html` had: `window.API_BASE = window.API_BASE || window.location.origin;`
2. In production, `window.location.origin` = `https://amir-btc-assistant-pages.pages.dev` (Pages domain)
3. ALL API calls went to Pages domain → 404 (no /api/* endpoints) → no data loaded
4. `prepare-pages.mjs` correctly replaces this with WORKER_API_URL when env is set
5. BUT: Cloudflare Pages has a separate GitHub Integration ("pages build and deployment" workflow)
   that builds and deploys on EVERY push WITHOUT the WORKER_API_URL env var
6. This integration OVERWRITES our custom Deploy workflow's correct output every time
7. Previous session's manual deploy (wrangler) also used wrong build (without WORKER_API_URL)

Evidence:
- `curl https://amir-btc-assistant-pages.pages.dev/` showed `window.location.origin` fallback
- GitHub Actions showed TWO workflows per push: "Deploy" (ours) and "pages build and deployment" (CF integration)
- Both "Deploy" and "pages build and deployment" succeeded for a44882b, but CF integration deployed last
- The CF integration deploys raw source without running prepare-pages.mjs with env vars

Fix (commit 8cd35c9):
- Changed default fallback in index.html from `window.location.origin` to the actual Worker URL:
  `"https://amir-btc-assistant-api-production.amirkamari9939.workers.dev"`
- Now BOTH workflows produce correct API_BASE (prepare-pages.mjs still overrides when WORKER_API_URL is set)

Verification:
- Deployed HTML: `<script>window.API_BASE = "https://amir-btc-assistant-api-production.amirkamari9939.workers.dev";</script>` ✅
- /api/health → 200 ✅
- /api/market → 200, 200 coins, has global data ✅
- /api/farsi-news → 200, articles loaded ✅
- /api/calendar/events → 200, 43 events ✅
- /api/analyses → 200 ✅
- CORS: Access-Control-Allow-Origin matches Pages domain ✅
- OPTIONS preflight: 204 with correct headers ✅

Stage Summary:
- Commit: 8cd35c9
- Both workflows (Deploy + pages build and deployment) succeed and produce correct output
- All API endpoints verified working with Pages Origin header
- Mini App should now load all data (market, news, calendar, watchlist) correctly

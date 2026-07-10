---
Task ID: priority-fix-batch
Agent: main
Task: Fix /start bot, UI freezing, slow loading, and visual issues

Work Log:
- Investigated /start bot command failure: found silent error swallowing in catch block (line 2720), no retry on Telegram API errors, processPendingReferralReward could corrupt membership result
- Fixed worker-proxy.js: sendTelegramMessage already had retry (from previous session), added error notification in catch, wrapped processPendingReferralReward in try/catch, removed /api/debug/trace endpoints
- Investigated UI freezing: 18 issues found (render-blocking tv.js, staggered animations, backdrop-filter overload, DOM-based escapeHtml, duplicate polling, _TRACE overhead, text-shadow animation)
- Fixed app.js: removed ALL _TRACE instrumentation (-111 lines), replaced escapeHtml with string-replace, removed duplicate 10s analysis polling, guarded checkAlerts market re-render, lazy-loaded TradingView
- Fixed style.css: removed per-coin staggered animations, replaced bottom-nav blur with opaque bg, reduced header blur, replaced brand-glow animation with static shadow, fixed market title, online indicator, coin rank layout
- Fixed index.html: removed tv.js from head, removed no-cache meta tags, restructured online indicator HTML, changed market header icon
- All 109 worker tests pass
- 3 commits pushed: 5914b54 (worker fix), 8a589a6 (app.js perf), 452169f (css+html perf+ui)

Stage Summary:
- /start fix: error notification + retry + referral isolation
- Performance: ~500KB removed from critical path, 6+ continuous paint triggers eliminated
- Visual: online indicator (green dot + person), market header (simple white + chart icon), coin rank (before icon)
- Deployed via GitHub Actions (push to main)

---
Task ID: 3
Agent: general-purpose
Task: Redesign news + economy + calendar

Work Log:
- Change 1 (News Glass/Premium Look): Updated .news-item, .important-news-item, .news-skeleton, .important-news-skeleton-item CSS with glass effect (rgba(255,255,255,0.03) bg, backdrop-filter: blur(10px), subtle borders, 14px radius, box-shadow). Added hover translateY(-1px) + brighter border. Added @keyframes newsFadeIn animation. Made titles font-weight:700, source text more subtle (var(--text-sub)). Important-news items get accent border-left (2px solid var(--accent)). Added staggered animation-delay via inline style in renderNews/loadImportantNews.
- Change 2 (Remove Economy Tab): Removed `<button class="news-tab" data-news="economy" ...>` from index.html. Backend economy filter in renderNews left intact (just not reachable from UI).
- Change 3 (Calendar Sub-Tabs): Added currentCalendarTab variable (default 'today'). Replaced old 4-section grouped calendar render with 3 sub-tabs (امروز/فردا/گذشته). Sub-tabs styled as glass pills (.cal-sub-tab). Added switchCalendarTab() function that filters calendarEvents by date without re-fetching. Calendar events now filtered by today/tomorrow/past date comparison (YYYY-MM-DD level). Past tab sorted descending. Empty state shown per tab. switchCalendarTab registered on window. switchNewsTab resets currentCalendarTab to 'today' when switching to calendar.
- All changes verified: `node -c app.js` passes.

Stage Summary:
- News: premium glass cards with fade-in animation, hover lift, accent border on important items
- Economy tab removed from UI (backend preserved)
- Calendar: 3 sub-tabs (Today/Tomorrow/Past) with glass pill styling, client-side filtering, no API re-fetch on tab switch
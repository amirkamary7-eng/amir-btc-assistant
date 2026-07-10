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
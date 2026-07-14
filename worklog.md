# Worklog — Amir BTC Assistant Pro Bug Fixes

---
Task ID: 1-7
Agent: Z.ai Code
Task: Fix 8 identified bugs in Amir BTC Assistant Pro (staged fixes per user's bug report)

Work Log:
- Cloned repo from github.com/amirkamary7-eng/amir-btc-assistant
- Analyzed worker-proxy.js (3349 lines), index.html (766 lines), scripts/prepare-pages.mjs (271 lines)
- Fix #1 (Critical): Repaired `creditReferralWithReward` INSERT query — changed hardcoded tx_type to $3 parameter, rebalanced all 5 parameters ($1-$5 + NOW())
- Fix #2 (Critical): Added `extractStartParam()` to parse `ref_USERID` from /start text, updated `extractTelegramMessageContext` to include `startParam`, modified `buildStartReplyPayload` to accept and append `startapp=ref_USERID` to WebApp URL
- Fix #3 (Critical): Rewrote cache-bust script in index.html — captured `savedHash` and `savedSearch` at top, removed double-`##` bug (window.location.hash already starts with #), preserved query string (startapp param) and Telegram initData hash during all redirects
- Fix #4 (High): Changed `validateTelegramInitData` default `maxAgeSeconds` from 3600 to 86400
- Fix #5 (High): Changed `connectionTimeoutMillis` from 5000 to 15000 in both Pool instantiations in `getDbPool`
- Fix #6 (Medium): Reviewed cache strategy — confirmed stable, no changes needed (Fix #3 already resolved the main issue)
- Fix #7 (Medium): Added MAX_NEWS_ARTICLES=30 limit to deduped news before caching, reducing payload and KV storage
- Fix #8 (Low): Reviewed app.js (3996 lines) and style.css (1967 lines) — no unused/commented-out code found, no changes needed
- Built Pages output via `node scripts/prepare-pages.mjs` (Build ID: MRKF7219-6d758f1)
- Deployed Worker API to production: `amir-btc-assistant-api-production` (Version: 0bcdcc3b)
- Deployed Pages: `amir-btc-assistant-pages` (Deployment: a860a960)

Stage Summary:
- 6 commits pushed to origin/main, all deployed
- Worker API: https://amir-btc-assistant-api-production.amirkamari9939.workers.dev
- Pages: https://amir-btc-assistant-pages.pages.dev
- All critical and high-priority bugs fixed
- Changes are minimal and surgical — no refactoring or architecture changes
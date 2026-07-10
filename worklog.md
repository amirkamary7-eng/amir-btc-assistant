---
Task ID: 1
Agent: main
Task: Add cold-open instrumentation tracing for auth chain

Work Log:
- Read full auth chain in app.js: UserContext.init → initTelegramWebApp → bootstrapUser → tryLateBootstrap → loadUser
- Identified 6 instrumentation points requested by user
- Added _TRACE() utility at top of app.js with window.__COLD_TRACE__ array storage
- Instrumented: APP_START, UserContext.init, initTelegramWebApp, bootstrapUser, tryLateBootstrap, apiFetch:/api/users/bootstrap, loadUser, retry interval
- Added /api/debug/trace POST/GET endpoints to worker-proxy.js for trace collection
- Added auto-upload mechanism: 35s after DOMContentLoaded, trace posts to /api/debug/trace
- Deployed via git push (GitHub Actions deploys both Worker + Pages)
- Verified: build MREMKN1K-2e7168d live on Pages, trace endpoint live on Worker

Stage Summary:
- Commits: 7ca13eb (instrumentation), 2e7168d (auto-upload + trace endpoint)
- 109/109 tests pass
- All 6 requested trace points instrumented with detailed data capture
- Trace auto-uploads 35s after page load to backend
- GET /api/debug/trace returns collected traces
- Awaiting user cold-open in Telegram to collect real trace data

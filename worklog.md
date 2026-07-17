# Amir BTC Assistant — Stabilization Worklog

---
Task ID: 1
Agent: Main Orchestrator
Task: فاز ۱ — بررسی و اصلاح Startup و Telegram Initialization

Work Log:
- Audit کامل app.js خطوط 1-4303 انجام شد
- Audit کامل worker-proxy.js خطوط 1-3794 انجام شد
- شناسایی مشکلات Root Cause فاز ۱:

  RC-1.1: `DOMContentLoaded` قبل از تأیید `bootstrapComplete`، `loadAlertsFromServer()` و `loadMarketData(true)` اجرا می‌کند
  RC-1.2: `bootstrapRetry` هر 500ms تا 30s تلاش می‌کند — هدررفت منابع
  RC-1.3: `_bootstrapPromise` در finally به null تنظیم می‌شود — شکست اول = تلاش بلافاصله مجدد
  RC-1.4: Cold-open reload 3 ثانیه‌ای (`location.reload()`) می‌تواند loop شود
  RC-1.5: `applyLanguage()` المان‌های جدید را ترجمه نمی‌کند (cache problem)
  RC-1.6: `loadImportantNews()` بدون در نظر گرفتن bootstrap اجرا می‌شود

Stage Summary:
- پروژه کلون شد: `/home/z/amir-btc-assistant/`
- آخرین commit: `1f021ed` (fix: comprehensive audit — 15 issues resolved)
- تمام 13 فاز شناسایی و Todo ایجاد شد
- شروع فاز ۱ — اصلاحات در حال انجام
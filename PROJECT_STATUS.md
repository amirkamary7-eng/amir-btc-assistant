# PROJECT_STATUS

## Source of Truth

| نقش | فایل |
|-----|------|
| **Task board + وضعیت زنده** | `TASK_BOARD.md` |
| **خلاصه progress** | `PROGRESS.md` |
| **وضعیت فنی snapshot** | این فایل (`PROJECT_STATUS.md`) |

> مدل قدیمی Phase 0–8 منسوخ شده → `archive/task-management-legacy/`

## وضعیت فعلی (technical snapshot)

- `worker-proxy.js` اکنون entry point فعال Cloudflare Worker است و routeهای پوشش‌داده‌شده را مستقیماً پاسخ می‌دهد.
- در runtime فعلی repo دیگر منطق فعال `BACKEND_URL` یا proxy به upstream داخل Worker وجود ندارد؛ mismatchهای باقی‌مانده بیشتر از جنس implementation ناقص یا storage ناسازگار هستند، نه proxy runtime.
- `main.py` هنوز برای بخش‌های legacy و همچنین `tickets/alerts` file-based وجود دارد.
- Cloudflare Pages برای فایل‌های استاتیک آماده است: `wrangler.pages.jsonc` + خروجی `webapp/pages-dist`.
- hardcode مربوط به `onrender.com` از runtime حذف شده است، اما حذف کامل dependencyهای legacy هنوز تمام نشده است.

## وضعیت فازها (legacy — deprecated)

> **جایگزین:** Phase 1–5 در `TASK_BOARD.md`. بخش زیر فقط snapshot تاریخی است.

- Phase 0 / شناخت و تحلیل: done
- Phase 1 / مستندسازی: done
- Phase 2–8 / مدل مهاجرت قدیمی: **deprecated** — see `TASK_BOARD.md`

## پوشش API روی Worker

### Worker-native کامل

- `GET /`
- `GET /api/health`
- `GET /api/charts/resolve`
- `GET /api/calendar/events`
- `GET /api/farsi-news`
- `GET /api/analyses`
- `POST|PUT|DELETE /api/analyses` (ادمین)
- `POST /api/sessions/heartbeat`
- `GET /api/sessions/online`
- `POST /api/sessions/end`
- `GET /api/assistant/limits`
- `POST /api/assistant/chat`
- `POST /api/users/bootstrap`
- `GET /api/users/me`
- `PUT /api/users/me/settings`
- `GET /api/watchlist`
- `PUT /api/watchlist`
- `GET /api/referrals/stats`
- `GET /api/referrals/tokens`
- `POST /api/notify`
- `POST /api/tickets`
- `GET /api/tickets`
- `GET /api/tickets/all`
- `POST /api/tickets/:id/reply`
- `DELETE /api/tickets/:id`
- `POST /api/alerts`
- `GET /api/alerts`
- `DELETE /api/alerts/:id`
- scheduled alerts runner (cron)

### FastAPI-only (not deployed on Worker)

- `GET /api/check-join`
- `GET /api/debug/check-join`
- `POST /api/check-join/invalidate`

### Worker-native اما ناقص

- `POST /telegram`
  - `/start` روی Worker هندل می‌شود، اما runtime قدیمی bot در backend هنوز وجود دارد.

### هنوز کامل نشده

- یکپارچه‌سازی کامل webhook/bot cutover

## وضعیت Storage/State

- DB (Neon PostgreSQL): source of truth برای کاربران، واچ‌لیست، referralها و token state در backend و Worker
- Cache:
  - Worker: `JOIN_CACHE`, `APP_CACHE`, `RATE_LIMITS`, `SESSION_CACHE`
  - Backend: فقط in-memory cache (بدون وابستگی production به Redis)
- stateهای حساس:
  - `tickets/alerts` اکنون بین Worker و backend هم‌راستا هستند و هر دو از persistence مشترک DB استفاده می‌کنند

## تسک‌های باز با اولویت واقعی کد

- migration cache را تکمیل کن و وابستگی backend به Redis/in-memory fallback را به حداقل برسان
- webhook/bot cutover را کامل کن تا runtime قدیمی backend از مسیر بحرانی خارج شود
- بعد از هر مرحله، تست end-to-end Mini App و Bot را اجرا کن

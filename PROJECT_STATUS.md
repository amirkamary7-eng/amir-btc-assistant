# PROJECT_STATUS

## Source of Truth

- وضعیت رسمی پروژه: این فایل (`PROJECT_STATUS.md`)
- جزئیات اجرایی و چک‌لیست: `PROGRESS.md`
- مرجع نهایی در صورت اختلاف: وضعیت واقعی کد در مخزن
- اسناد توضیحی: `docs/*` (باید با این دو فایل همگام باشند)

## وضعیت فعلی (خلاصه)

- Cloudflare Worker Shell در [worker-proxy.js](file:///workspace/worker-proxy.js) پیاده‌سازی شده است.
  - بخشی از endpointها Worker-native هستند.
  - باقی مسیرهای `/api/*` و `/telegram` در صورت عدم پوشش، به upstream از طریق `BACKEND_URL` proxy می‌شوند.
- Cloudflare Pages برای استقرار فایل‌های استاتیک آماده است: [wrangler.pages.jsonc](file:///workspace/wrangler.pages.jsonc) + خروجی `webapp/pages-dist`.
- بک‌اند FastAPI هنوز وجود دارد و برای endpointهای proxy‌شده (و همچنین tickets/alerts file-based) نقش upstream را بازی می‌کند: [main.py](file:///workspace/main.py).
- آدرس‌های `onrender.com` در repo hardcode نشده‌اند (Render removal در سطح repo انجام شده)، اما حذف کامل نیاز به upstream هنوز انجام نشده است.

## وضعیت فازها (done / partial / not started)

- Phase 0 / شناخت و تحلیل: done
- Phase 1 / مستندسازی: done
- Phase 2 / طراحی مهاجرت مرحله‌ای: partial
- Phase 3 / آماده‌سازی زیرساخت Cloudflare: partial
- Phase 4 / انتقال APIها: partial
- Phase 5 / انتقال webhook ربات: partial
- Phase 6 / انتقال cache: partial
- Phase 7 / انتقال stateهای فایل‌محور: not started
- Phase 8 / حذف کامل Render: partial

## پوشش API روی Worker

### Worker-native (done)

- `GET /`
- `GET /api/health`
- `GET /api/charts/resolve`
- `GET /api/calendar/events`
- `GET /api/farsi-news`
- `GET /api/check-join`
- `GET /api/debug/check-join`
- `POST /api/check-join/invalidate`
- `POST /api/sessions/heartbeat`
- `GET /api/sessions/online`
- `POST /api/sessions/end`
- `GET /api/assistant/limits`

### Worker-native با fallback/proxy (partial)

- `GET /api/analyses` (cache + fallback به upstream)
- `POST /api/assistant/chat` (rate limit روی Worker، اجرای اصلی روی upstream)
- `POST /api/users/bootstrap` (auth validation + proxy-safe)
- `GET /api/users/me` (auth validation + proxy)
- `PUT /api/users/me/settings` (auth validation + proxy)
- `/api/watchlist` GET/PUT (auth validation + proxy-safe)
- tickets/alerts (proxy-safe + upstream file-based)

### Proxy-only (not started برای Worker-native)

- `GET /api/referrals/*`
- `POST /api/notify`
- `POST|PUT|DELETE /api/analyses` (ادمین)
- سایر مسیرهای `/api/*` که هنوز فقط به upstream proxy می‌شوند

## وضعیت Storage/State

- DB (Supabase/Postgres): source of truth برای کاربران/واچ‌لیست/تحلیل‌ها/رفرال‌ها (طبق مدل‌ها)
- Cache:
  - Worker: KV namespaceها (`JOIN_CACHE`, `APP_CACHE`, `RATE_LIMITS`, `SESSION_CACHE`)
  - Backend: Redis/in-memory fallback هنوز وجود دارد
- File-based state:
  - tickets: `data/tickets.json` (هنوز فعال در backend)
  - alerts: `data/alerts.json` (هنوز فعال در backend)

## کارهای باقی‌مانده (اولویت‌دار)

- تکمیل انتقال endpointهای proxy-only به Worker-native و حذف وابستگی به `BACKEND_URL`
- انتقال tickets/alerts به DB-backed flow و حذف وابستگی به فایل‌سیستم
- نهایی‌سازی webhook روی Worker و انجام cutover بدون downtime
- تکمیل migration cache در کل سیستم و حذف نیاز به Redis در production
- اجرای تست end-to-end برای Mini App و Bot بعد از هر مرحله cutover

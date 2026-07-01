# ادامه کار مهاجرت (Tasks)

این فایل فهرست کارهای «ادامه مهاجرت» را نگه می‌دارد. وضعیت رسمی و یکپارچه پروژه در `PROJECT_STATUS.md` و جزئیات پیشرفت در `PROGRESS.md` ثبت می‌شود.

## وضعیت فعلی (خلاصه)

- Cloudflare Worker Shell در `worker-proxy.js` فعال است: بخشی از مسیرها Worker-native هستند و مسیرهای باقی‌مانده به upstream از طریق `BACKEND_URL` proxy می‌شوند.
- Cloudflare Pages برای فایل‌های استاتیک آماده است (`webapp/pages-dist` + `wrangler.pages.jsonc`).
- hardcode مربوط به `onrender.com` از فایل‌های runtime حذف شده است، اما حذف کامل upstream و backend هنوز انجام نشده است.

## تسک‌های باز (done / partial / not started)

### 1) تثبیت زیرساخت Cloudflare

- Worker config با `wrangler.jsonc`: done
- Pages config با `wrangler.pages.jsonc`: done
- نهایی‌سازی secret management (production/staging): partial
- مشخص کردن دامنه/route نهایی و برنامه cutover: not started

### 2) انتقال endpointها از proxy به Worker-native

Worker-native (done):

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

Worker-native با fallback/proxy (partial):

- `GET /api/analyses` (cache + fallback به upstream)
- `POST /api/assistant/chat` (rate limit روی Worker، اجرای اصلی روی upstream)
- `/api/users/*` و `/api/watchlist` (auth validation روی Worker + proxy-safe به upstream)

Proxy-only (not started برای Worker-native):

- `GET /api/referrals/*`
- `POST /api/notify`
- `POST|PUT|DELETE /api/analyses` (ادمین)
- تمام مسیرهای دیگر که هنوز فقط از مسیر `/api/*` به upstream proxy می‌شوند

### 3) انتقال stateهای file-based (tickets/alerts) به DB

- Tickets: not started
- Alerts: not started
- حذف وابستگی runtime به فایل‌سیستم محلی: not started

### 4) زمان‌بندی و هشدارها (Cron)

- cron trigger روی Worker: done
- اجرای job هشدارها: partial (در حال حاضر hook به upstream `/internal/alerts/run` دارد و `ALERTS_CRON_ENABLED` پیش‌فرض false است)
- انتقال کامل منطق alerts به Worker-native (بدون upstream): not started

### 5) webhook ربات و `/start`

- `POST /telegram` روی Worker برای `/start`: partial
- قطع وابستگی webhook به backend/upstream: not started

### 6) حذف کامل upstream (از جمله Render)

- حذف hardcode آدرس Render از repo: done
- حذف نیاز به `BACKEND_URL` (cutover کامل Worker-native): not started
- خاموش‌سازی backend قدیمی پس از cutover: not started

# ادامه کار مهاجرت

این فایل فقط تسک‌های باز را نگه می‌دارد. وضعیت رسمی پروژه در `PROJECT_STATUS.md` ثبت می‌شود و در صورت اختلاف، کد مخزن اولویت دارد.

## وضعیت فعلی

- Worker برای مسیرهای پوشش‌داده‌شده مستقیم پاسخ می‌دهد و در runtime فعلی repo دیگر منطق فعال `BACKEND_URL` داخل `worker-proxy.js` وجود ندارد.
- mismatchهای باقی‌مانده بیشتر از جنس storage و implementation ناقص هستند.
- Cloudflare Pages برای فایل‌های استاتیک آماده است.

## تسک‌های باز

### 1) زیرساخت Cloudflare

- Worker config با `wrangler.jsonc`: done
- Pages config با `wrangler.pages.jsonc`: done
- نهایی‌سازی secret management: partial
- مشخص کردن route نهایی و برنامه cutover: not started

### 2) انتقال endpointها به implementation واقعی روی Worker

Worker-native کامل:

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
- `POST /api/users/bootstrap`
- `GET /api/users/me`
- `PUT /api/users/me/settings`
- `GET /api/watchlist`
- `PUT /api/watchlist`
- `GET /api/referrals/stats`
- `GET /api/referrals/tokens`
- `POST /api/notify`
- `POST|GET /api/tickets`
- `GET /api/tickets/all`
- `POST /api/tickets/:id/reply`
- `DELETE /api/tickets/:id`
- `POST|GET /api/alerts`
- `DELETE /api/alerts/:id`

Worker-native اما ناقص:

- `GET /api/analyses` (read-only بر پایه cache)
- `POST /api/assistant/chat` (rate limit فعال، سرویس اصلی غیرفعال)
- `POST /telegram` (مسیر Worker فعال است، اما runtime قدیمی bot هنوز وجود دارد)

هنوز کامل نشده:

- `POST|PUT|DELETE /api/analyses` (ادمین)
- scheduled alerts کاملاً native

### 3) انتقال stateهای پایدار

- `tickets`: done
- `alerts`: done
- حذف وابستگی runtime به فایل‌سیستم محلی: done
- حذف mismatch بین `SESSION_CACHE` در Worker و فایل‌های JSON در backend: done

### 4) cache migration

- KV namespaceهای Worker: done
- cache backend روی Redis/in-memory fallback: done
- حذف نیاز production به Redis: done

### 5) webhook و bot cutover

- `/start` روی Worker: partial
- حذف وابستگی runtime بحرانی به backend bot: not started

### 6) حذف dependencyهای legacy

- حذف hardcode آدرس Render از repo: done
- حذف کامل dependencyهای legacy backend از مسیرهای بحرانی: partial
- خاموش‌سازی backend قدیمی پس از cutover: not started

# نقشه API پروژه

## مقدمه

این فایل تمام endpointهای فعال پروژه را بر اساس وضعیت واقعی فعلی backend مستند می‌کند.

پیشوند عمومی API:

- `GET /`
- `POST /telegram`
- `GET|POST|PUT|DELETE /api/*`

انواع احراز هویت:

- `public`: بدون احراز هویت
- `telegram_auth`: نیازمند هدر `X-Telegram-Init-Data`
- `admin_auth`: نیازمند Telegram auth + ادمین بودن

## Runtime

- **Platform:** Cloudflare Workers + Pages
- **Database:** PostgreSQL (Supabase) via `@neondatabase/serverless`
- **Cache:** Cloudflare KV (4 namespaces)
- **AI:** Gemini / OpenRouter / DeepSeek

---

## 1. Root و سلامت سیستم

### `GET /`

- Auth: `public`
- ورودی: ندارد
- خروجی:
  - `status`
  - `message`
- وابستگی:
  - Worker runtime
- کاربرد:
  - تست سریع در دسترس بودن سرویس

### `GET /api/health`

- Auth: `public`
- ورودی: ندارد
- خروجی:
  - `status`
  - `bot_configured`
  - `database_ready`
  - `redis_ready`
- وابستگی:
  - Worker env vars
  - PostgreSQL
  - Cloudflare KV

---

## 2. اخبار

### `GET /api/farsi-news`

- Auth: `public`
- ورودی: ندارد
- خروجی:
  - `status`
  - `source`
  - `data[]`
- ساختار آیتم خبر:
  - `title`
  - `description`
  - `time_ago`
  - `source`
  - `image`
  - `url`
- وابستگی:
  - RSS خارجی
  - `deep_translator`
  - cache داخلی
  - Cloudflare KV
- ریسک مهاجرت:
  - external fetch
  - caching behavior

---

## 3. عضویت اجباری در کانال

### `GET /api/check-join`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
  - `refresh` اختیاری، بولی
- خروجی معمول:
  - `status`
  - `joined`
  - `cached` یا `from_db` یا `from_db_fallback`
  - `reason` در صورت نیاز
- وابستگی:
  - Telegram initData auth
  - `backend/services/join_service.py`
  - `backend/services/user_service.py`
  - Cloudflare KV
  - Telegram Bot API `getChatMember`
  - DB
- نکته:
  - مهم‌ترین endpoint برای mandatory join

### `GET /api/debug/check-join`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `required_channel`
  - `user_id`
  - `telegram_response`
  - `joined`
- وابستگی:
  - Telegram Bot API
- کاربرد:
  - debug عضویت

### `POST /api/check-join/invalidate`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `invalidated`
  - `user_id`
- وابستگی:
  - join cache

---

## 4. کاربران

### `POST /api/users/bootstrap`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `username`
  - `first_name`
  - `last_name`
  - `lang`
  - `referrer_id`
- خروجی:
  - `status`
  - `user`
  - `watchlist`
- وابستگی:
  - DB
  - referral logic in Worker
- کاربرد:
  - ایجاد/به‌روزرسانی کاربر بعد از ورود به Mini App

### `GET /api/users/me`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `user`
  - `watchlist`
- ساختار `user`:
  - `user_id`
  - `username`
  - `first_name`
  - `last_name`
  - `lang`
  - `channel_joined`
- وابستگی:
  - DB

### `PUT /api/users/me/settings`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `lang`
- خروجی:
  - `status`
  - `user`
- وابستگی:
  - DB

---

## 5. واچ‌لیست

### `GET /api/watchlist`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `symbols[]`
- وابستگی:
  - DB

### `PUT /api/watchlist`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `symbols[]`
- خروجی:
  - `status`
  - `symbols[]`
- وابستگی:
  - DB
  - محدودیت `MAX_WATCHLIST`

---

## 6. چارت

### `GET /api/charts/resolve`

- Auth: `public`
- Query:
  - `symbol`
- خروجی:
  - `status`
  - داده resolve شده از سرویس
- وابستگی:
  - `backend/services/chart_service.py`
  - exchange APIs
  - cache

---

## 7. تحلیل‌ها

### `GET /api/analyses`

- Auth: `public`
- Query:
  - `version` اختیاری
- خروجی:
  - `status`
  - `analyses`
  - `version`
  - `unchanged` در صورت برابر بودن version
- وابستگی:
  - DB
  - Cloudflare KV cache

### `POST /api/analyses`

- Auth: `admin_auth`
- Body:
  - `coin`
  - `timeframe`
  - `image`
  - `text`
  - `author`
  - `author_id`
- خروجی:
  - `status`
  - `analysis`
  - `version`
- وابستگی:
  - DB
  - admin auth

### `PUT /api/analyses/{analysis_id}`

- Auth: `admin_auth`
- Body:
  - `coin`
  - `timeframe`
  - `image`
  - `text`
- خروجی:
  - `status`
  - `analysis`
  - `version`
- خطا:
  - `404 Not found`
- وابستگی:
  - DB

### `DELETE /api/analyses/{analysis_id}`

- Auth: `admin_auth`
- خروجی:
  - `status`
  - `version`
- خطا:
  - `404 Not found`
- وابستگی:
  - DB

---

## 8. تقویم اقتصادی

### `GET /api/calendar/events`

- Auth: `public`
- ورودی: ندارد
- خروجی:
  - `status`
  - `events[]`
- وابستگی:
  - ForexFactory
  - Cloudflare KV cache

---

## 9. رفرال و توکن

### `GET /api/referrals/stats`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `total`
  - `active`
  - `rewarded`
  - `tokens`
- وابستگی:
  - DB

### `GET /api/referrals/tokens`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `balance`
  - `history[]`
- وابستگی:
  - DB
  - token balances
  - token transactions

---

## 10. سشن و کاربران آنلاین

### `POST /api/sessions/heartbeat`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
  - `session_id` اختیاری
- خروجی:
  - `status`
  - `session_id`
  - `last_seen`
  - `online_count`
- وابستگی:
  - Cloudflare KV
  - `backend/services/session_service.py`

### `GET /api/sessions/online`

- Auth: `telegram_auth`
- ورودی: ندارد
- خروجی:
  - `status`
  - `count`
- وابستگی:
  - Cloudflare KV

### `POST /api/sessions/end`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `online_count`
- وابستگی:
  - Cloudflare KV

---

## 11. AI Assistant

### `GET /api/assistant/limits`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - داده‌های rate limit
- وابستگی:
  - AI providers (Gemini/OpenRouter/DeepSeek)
  - Cloudflare KV rate-limits

### `POST /api/assistant/chat`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `message`
  - `history[]`
  - `image`
- ساختار `history[]`:
  - `role`
  - `content`
- خروجی:
  - پاسخ AI service
- خطا:
  - `429` برای cooldown یا daily limits
  - `503` برای failure provider
- وابستگی:
  - AI providers
  - Cloudflare KV rate-limits

---

## 12. تیکت‌ها

### `POST /api/tickets`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `user_name`
  - `title`
  - `body`
- خروجی:
  - `status`
  - `ticket`
- وابستگی:
  - فایل PostgreSQL (tickets table)
  - Telegram notification to admin/user
- نکته:
  - state فعلی file-based است

### `GET /api/tickets`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `tickets[]`
- وابستگی:
  - PostgreSQL (tickets table)

### `GET /api/tickets/all`

- Auth: `admin_auth`
- Query:
  - `admin_id` اختیاری
- خروجی:
  - `status`
  - `tickets[]`
- وابستگی:
  - PostgreSQL (tickets table)

### `POST /api/tickets/{ticket_id}/reply`

- Auth: `admin_auth`
- Body:
  - `admin_id`
  - `message`
- خروجی:
  - `status`
  - `ticket`
- خطا:
  - `404 Not found`
- وابستگی:
  - PostgreSQL (tickets table)
  - Telegram message to user

### `DELETE /api/tickets/{ticket_id}`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
  - `admin_id` اختیاری
- خروجی:
  - `status`
- خطا:
  - `404 Not found`
  - `403 Forbidden`
- وابستگی:
  - PostgreSQL (tickets table)

---

## 13. اعلان تلگرام

### `POST /api/notify`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `message`
- خروجی:
  - `status`
  - `sent`
- وابستگی:
  - Telegram Bot API

---

## 14. هشدار قیمت

### `POST /api/alerts`

- Auth: `telegram_auth`
- Body:
  - `user_id`
  - `symbol`
  - `price`
  - `direction`
- خروجی:
  - `status`
  - `alert`
- وابستگی:
  - فایل PostgreSQL (price_alerts table)
  - Telegram notifications

### `GET /api/alerts`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
  - `alerts[]`
- وابستگی:
  - PostgreSQL (price_alerts table)

### `DELETE /api/alerts/{alert_id}`

- Auth: `telegram_auth`
- Query:
  - `user_id` اختیاری
- خروجی:
  - `status`
- خطا:
  - `404 Not found`
  - `403 Forbidden`
- وابستگی:
  - PostgreSQL (price_alerts table)

### وابستگی غیرمستقیم هشدارها

- `alert_polling_loop()` در startup بک‌اند اجرا می‌شود.
- قیمت‌ها از CoinGecko خوانده می‌شوند.
- در trigger شدن، پیام تلگرام برای کاربر و ادمین ارسال می‌شود.

---

## 15. Telegram Webhook

### `POST /telegram`

- Auth: `public` از دید HTTP
- ورودی:
  - payload رسمی Telegram Update
- خروجی:
  - `200 OK`
- وابستگی:
  - Cloudflare Worker
  - Worker webhook handler

---

## 16. دستور `/start` ربات

اگرچه HTTP endpoint مجزا نیست، اما به‌عنوان contract مهم سیستم باید مستند شود.

### Bot Command: `/start`

- کانال اجرا:
  - Telegram bot handler
- ورودی:
  - پیام `/start` از کاربر
- خروجی:
  - اگر `channel_joined = false`: پیام عضویت + دکمه Inline عضویت در کانال
  - اگر `channel_joined = true`: پیام welcome + دکمه `web_app`
- وابستگی:
  - DB
  - جدول `users`
  - `REQUIRED_CHANNEL`
  - `WEBAPP_URL`

---

## Summary Map

| مسیر | Method | Auth | Storage/Dependency |
|---|---|---|---|
| `/` | GET | public | app runtime |
| `/api/health` | GET | public | env vars + DB + KV |
| `/api/farsi-news` | GET | public | RSS + translator + cache |
| `/api/check-join` | GET | telegram_auth | cache + DB + Telegram API |
| `/api/debug/check-join` | GET | telegram_auth | Telegram API |
| `/api/check-join/invalidate` | POST | telegram_auth | cache |
| `/api/users/bootstrap` | POST | telegram_auth | DB |
| `/api/users/me` | GET | telegram_auth | DB |
| `/api/users/me/settings` | PUT | telegram_auth | DB |
| `/api/watchlist` | GET | telegram_auth | DB |
| `/api/watchlist` | PUT | telegram_auth | DB |
| `/api/charts/resolve` | GET | public | exchange APIs + cache |
| `/api/analyses` | GET | public | DB + cache |
| `/api/analyses` | POST | admin_auth | DB |
| `/api/analyses/{id}` | PUT | admin_auth | DB |
| `/api/analyses/{id}` | DELETE | admin_auth | DB |
| `/api/calendar/events` | GET | public | ForexFactory + cache |
| `/api/referrals/stats` | GET | telegram_auth | DB |
| `/api/referrals/tokens` | GET | telegram_auth | DB |
| `/api/sessions/heartbeat` | POST | telegram_auth | Cloudflare KV |
| `/api/sessions/online` | GET | telegram_auth | Cloudflare KV |
| `/api/sessions/end` | POST | telegram_auth | Cloudflare KV |
| `/api/assistant/limits` | GET | telegram_auth | cache |
| `/api/assistant/chat` | POST | telegram_auth | AI providers + cache |
| `/api/tickets` | POST | telegram_auth | PostgreSQL (tickets table) |
| `/api/tickets` | GET | telegram_auth | PostgreSQL (tickets table) |
| `/api/tickets/all` | GET | admin_auth | PostgreSQL (tickets table) |
| `/api/tickets/{id}/reply` | POST | admin_auth | PostgreSQL (tickets table) + Telegram |
| `/api/tickets/{id}` | DELETE | telegram_auth | PostgreSQL (tickets table) |
| `/api/notify` | POST | telegram_auth | Telegram Bot API |
| `/api/alerts` | POST | telegram_auth | PostgreSQL (price_alerts table) |
| `/api/alerts` | GET | telegram_auth | PostgreSQL (price_alerts table) |
| `/api/alerts/{id}` | DELETE | telegram_auth | PostgreSQL (price_alerts table) |
| `/telegram` | POST | public | Worker webhook handler |
